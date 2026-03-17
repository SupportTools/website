---
title: "Go Service Mesh Integration: Building mTLS-Aware Microservices with Istio"
date: 2031-01-27T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Istio", "Service Mesh", "mTLS", "SPIFFE", "Security", "Microservices", "gRPC"]
categories:
- Go
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building mTLS-aware Go microservices with Istio: HTTP client configuration for mTLS passthrough, peer authentication header extraction, SPIFFE/SVID certificate handling in Go, circuit breaker integration, and local mTLS testing."
more_link: "yes"
url: "/go-service-mesh-integration-mtls-aware-microservices-istio/"
---

Service meshes like Istio provide mTLS transparently, but truly mesh-aware Go services can leverage the security context provided by the mesh for authorization, request attribution, and trust-based routing. This guide covers the Go-specific patterns for building mesh-aware services: configuring HTTP clients that work correctly with mTLS sidecars, extracting peer identity from Istio's SPIFFE certificates, implementing authorization based on workload identity, circuit breaker integration with mesh behavior, and testing mTLS locally without a full cluster.

<!--more-->

# Go Service Mesh Integration: Building mTLS-Aware Microservices with Istio

## Understanding Istio's mTLS Model

Istio intercepts all pod traffic through the Envoy sidecar proxy. When mTLS is enabled, the actual TCP connection between services carries TLS, but the application code sees plain HTTP. The certificate exchange happens in the sidecar layer:

```
Service A Pod                    Service B Pod
┌─────────────────┐              ┌─────────────────┐
│  Go Application │              │  Go Application │
│   (HTTP/gRPC)   │              │   (HTTP/gRPC)   │
│        │        │              │        │        │
│   Envoy Proxy   │──── mTLS ───►│   Envoy Proxy   │
│  (intercepts    │              │  (terminates    │
│   outbound)     │              │   mTLS, passes  │
│                 │              │   headers)      │
└─────────────────┘              └─────────────────┘
```

The application on Service B receives plain HTTP, but Envoy adds headers describing the authenticated peer:
- `x-forwarded-client-cert` (XFCC): The client certificate chain
- `x-auth-request-user`: Extracted from JWT if using RequestAuthentication

## HTTP Client Configuration

### The Problem: Connection Reuse with Sidecars

The default Go HTTP transport has settings that can interact poorly with Envoy:

```go
// Default Go HTTP client - problematic in service mesh
client := &http.Client{}

// Issues:
// 1. MaxIdleConnsPerHost defaults to 2 - causes excessive connection churn
//    vs Envoy's connection pooling
// 2. DisableKeepAlives = false (good), but defaults may cause pool exhaustion
// 3. No timeout set - requests can hang indefinitely
```

### Optimized HTTP Client for Service Mesh

```go
package httpclient

import (
    "context"
    "crypto/tls"
    "net"
    "net/http"
    "time"
)

// NewMeshAwareClient returns an HTTP client optimized for use behind an
// Istio/Envoy sidecar proxy. The client itself uses plain HTTP; TLS
// is handled by the sidecar.
func NewMeshAwareClient(opts ...Option) *http.Client {
    cfg := defaultConfig()
    for _, opt := range opts {
        opt(cfg)
    }

    transport := &http.Transport{
        // Connection pooling settings
        MaxIdleConns:        cfg.MaxIdleConns,
        MaxIdleConnsPerHost: cfg.MaxIdleConnsPerHost,
        MaxConnsPerHost:     cfg.MaxConnsPerHost,
        IdleConnTimeout:     cfg.IdleConnTimeout,

        // Timeouts
        DialContext: (&net.Dialer{
            Timeout:   cfg.ConnectTimeout,
            KeepAlive: 30 * time.Second,
        }).DialContext,
        TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
        ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
        ExpectContinueTimeout: 1 * time.Second,

        // When running behind Envoy sidecar, the proxy handles TLS.
        // The Go client sends plain HTTP to the local sidecar (127.0.0.1:15001).
        // For services that have TLS passthrough or direct TLS, configure appropriately.
        TLSClientConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },

        // Important for service mesh: disable HTTP/2 if Envoy handles it
        // Envoy proxies HTTP/2 at the transport level, so application-level
        // HTTP/2 can cause double-framing issues in some configurations.
        ForceAttemptHTTP2: false, // Let Envoy handle HTTP/2 negotiation
    }

    return &http.Client{
        Transport: transport,
        Timeout:   cfg.RequestTimeout,
        // Do not follow redirects automatically - let the mesh handle routing
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            return http.ErrUseLastResponse
        },
    }
}

type config struct {
    MaxIdleConns          int
    MaxIdleConnsPerHost   int
    MaxConnsPerHost       int
    IdleConnTimeout       time.Duration
    ConnectTimeout        time.Duration
    TLSHandshakeTimeout   time.Duration
    ResponseHeaderTimeout time.Duration
    RequestTimeout        time.Duration
}

func defaultConfig() *config {
    return &config{
        MaxIdleConns:          100,
        MaxIdleConnsPerHost:   10,  // Higher than default 2 for service mesh
        MaxConnsPerHost:       0,   // Unlimited, let Envoy manage
        IdleConnTimeout:       90 * time.Second,
        ConnectTimeout:        5 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        ResponseHeaderTimeout: 30 * time.Second,
        RequestTimeout:        60 * time.Second,
    }
}

type Option func(*config)

func WithRequestTimeout(d time.Duration) Option {
    return func(c *config) { c.RequestTimeout = d }
}

func WithMaxIdleConnsPerHost(n int) Option {
    return func(c *config) { c.MaxIdleConnsPerHost = n }
}
```

### gRPC Client Configuration

```go
package grpcclient

import (
    "context"
    "crypto/tls"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/metadata"
)

// NewMeshAwareGRPCConn creates a gRPC connection optimized for Istio service mesh.
// The connection uses plain-text; Istio's sidecar handles TLS upgrade.
func NewMeshAwareGRPCConn(ctx context.Context, target string, opts ...grpc.DialOption) (*grpc.ClientConn, error) {
    defaultOpts := []grpc.DialOption{
        // Use insecure credentials - Envoy sidecar handles mTLS
        grpc.WithTransportCredentials(insecure.NewCredentials()),

        // Keepalive settings aligned with Envoy's defaults
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second, // Send keepalive every 10s
            Timeout:             5 * time.Second,  // Consider dead after 5s no response
            PermitWithoutStream: true,             // Send keepalive even without active streams
        }),

        // Connection pool sizing
        grpc.WithInitialWindowSize(1 << 20),        // 1MB initial window
        grpc.WithInitialConnWindowSize(1 << 20),    // 1MB connection window

        // Retry policy via service config
        grpc.WithDefaultServiceConfig(`{
            "methodConfig": [{
                "name": [{"service": ""}],
                "retryPolicy": {
                    "maxAttempts": 3,
                    "initialBackoff": "0.1s",
                    "maxBackoff": "1s",
                    "backoffMultiplier": 2,
                    "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
                }
            }]
        }`),
    }

    allOpts := append(defaultOpts, opts...)
    return grpc.DialContext(ctx, target, allOpts...)
}
```

## Extracting Peer Identity from mTLS Headers

Istio propagates the authenticated peer's SPIFFE identity via the `x-forwarded-client-cert` (XFCC) header. This enables application-level authorization based on workload identity.

### XFCC Header Parsing

```go
// spiffe/identity.go
package spiffe

import (
    "fmt"
    "net/url"
    "strings"
)

// Identity represents a SPIFFE Verifiable Identity Document (SVID).
type Identity struct {
    TrustDomain string
    Namespace   string
    ServiceAccount string
}

// String returns the SPIFFE URI: spiffe://trust-domain/ns/namespace/sa/service-account
func (id Identity) String() string {
    return fmt.Sprintf("spiffe://%s/ns/%s/sa/%s",
        id.TrustDomain, id.Namespace, id.ServiceAccount)
}

// ParseSPIFFEURI parses a SPIFFE URI into an Identity.
// Expected format: spiffe://trust-domain/ns/namespace/sa/service-account
func ParseSPIFFEURI(uri string) (*Identity, error) {
    u, err := url.Parse(uri)
    if err != nil {
        return nil, fmt.Errorf("parse SPIFFE URI: %w", err)
    }

    if u.Scheme != "spiffe" {
        return nil, fmt.Errorf("expected spiffe:// scheme, got %s", u.Scheme)
    }

    // Path format: /ns/<namespace>/sa/<service-account>
    parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
    if len(parts) != 4 || parts[0] != "ns" || parts[2] != "sa" {
        return nil, fmt.Errorf("invalid SPIFFE path: %s (expected /ns/<ns>/sa/<sa>)", u.Path)
    }

    return &Identity{
        TrustDomain:    u.Host,
        Namespace:      parts[1],
        ServiceAccount: parts[3],
    }, nil
}

// XFCCEntry represents a single entry in the X-Forwarded-Client-Cert header.
type XFCCEntry struct {
    By   string   // Server's identity
    Hash string   // SHA256 of client cert
    URI  []string // SAN URIs (SPIFFE identities)
    DNS  []string // SAN DNS names
}

// ParseXFCC parses the X-Forwarded-Client-Cert header value.
// The header format is: By=<uri>;Hash=<hash>;URI=<uri>;DNS=<name>,...
// Multiple entries separated by commas.
func ParseXFCC(headerValue string) ([]XFCCEntry, error) {
    if headerValue == "" {
        return nil, nil
    }

    var entries []XFCCEntry

    for _, entry := range strings.Split(headerValue, ",") {
        entry = strings.TrimSpace(entry)
        if entry == "" {
            continue
        }

        var xfcc XFCCEntry
        for _, field := range strings.Split(entry, ";") {
            field = strings.TrimSpace(field)
            if field == "" {
                continue
            }

            idx := strings.Index(field, "=")
            if idx < 0 {
                continue
            }

            key := field[:idx]
            value := strings.Trim(field[idx+1:], `"`)

            switch strings.ToLower(key) {
            case "by":
                xfcc.By = value
            case "hash":
                xfcc.Hash = value
            case "uri":
                xfcc.URI = append(xfcc.URI, value)
            case "dns":
                xfcc.DNS = append(xfcc.DNS, value)
            }
        }

        entries = append(entries, xfcc)
    }

    return entries, nil
}

// ExtractCallerIdentity extracts the SPIFFE identity of the calling service
// from the X-Forwarded-Client-Cert header set by Envoy.
func ExtractCallerIdentity(xfccHeader string) (*Identity, error) {
    entries, err := ParseXFCC(xfccHeader)
    if err != nil {
        return nil, err
    }

    if len(entries) == 0 {
        return nil, fmt.Errorf("no XFCC entries found")
    }

    // The first entry's URI is the direct caller's SPIFFE identity
    for _, uri := range entries[0].URI {
        if strings.HasPrefix(uri, "spiffe://") {
            return ParseSPIFFEURI(uri)
        }
    }

    return nil, fmt.Errorf("no SPIFFE URI found in XFCC header")
}
```

### Authorization Middleware

```go
// auth/middleware.go
package auth

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    "github.com/example/myapp/spiffe"
)

type contextKey string

const identityKey contextKey = "peer-identity"

// AllowedPeer defines an authorized calling service.
type AllowedPeer struct {
    TrustDomain    string // e.g., "cluster.local"
    Namespace      string // e.g., "payment-system" (empty = any namespace)
    ServiceAccount string // e.g., "payment-service" (empty = any SA)
}

// matches checks if identity matches this peer spec.
func (p AllowedPeer) matches(id *spiffe.Identity) bool {
    if p.TrustDomain != "" && p.TrustDomain != id.TrustDomain {
        return false
    }
    if p.Namespace != "" && p.Namespace != id.Namespace {
        return false
    }
    if p.ServiceAccount != "" && p.ServiceAccount != id.ServiceAccount {
        return false
    }
    return true
}

// PeerAuthMiddleware validates that the calling service has an authorized
// SPIFFE identity as established by the Istio sidecar mTLS.
func PeerAuthMiddleware(allowedPeers []AllowedPeer) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            xfcc := r.Header.Get("x-forwarded-client-cert")

            if xfcc == "" {
                // No mTLS - either not in mesh or PERMISSIVE mode
                // Log for visibility; decide whether to reject based on policy
                // In STRICT mode, Envoy would have already rejected non-mTLS connections
                http.Error(w, "no peer certificate", http.StatusUnauthorized)
                return
            }

            identity, err := spiffe.ExtractCallerIdentity(xfcc)
            if err != nil {
                http.Error(w, fmt.Sprintf("invalid peer certificate: %v", err),
                    http.StatusUnauthorized)
                return
            }

            // Check if identity is in allowed list
            authorized := false
            for _, peer := range allowedPeers {
                if peer.matches(identity) {
                    authorized = true
                    break
                }
            }

            if !authorized {
                http.Error(w,
                    fmt.Sprintf("unauthorized peer: %s", identity),
                    http.StatusForbidden)
                return
            }

            // Add identity to context for downstream use
            ctx := context.WithValue(r.Context(), identityKey, identity)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// GetPeerIdentity retrieves the authenticated peer identity from the context.
func GetPeerIdentity(ctx context.Context) (*spiffe.Identity, bool) {
    id, ok := ctx.Value(identityKey).(*spiffe.Identity)
    return id, ok
}
```

### Using the Authorization Middleware

```go
// main.go
package main

import (
    "net/http"
    "github.com/example/myapp/auth"
)

func main() {
    // Define allowed callers for this service
    allowedPeers := []auth.AllowedPeer{
        // Allow the API gateway (any SA in api-gateway namespace)
        {TrustDomain: "cluster.local", Namespace: "api-gateway"},
        // Allow the payment service specifically
        {TrustDomain: "cluster.local", Namespace: "payments", ServiceAccount: "payment-processor"},
        // Allow any service in the admin namespace
        {TrustDomain: "cluster.local", Namespace: "admin"},
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/api/v1/orders", handleOrders)

    handler := auth.PeerAuthMiddleware(allowedPeers)(mux)
    http.ListenAndServe(":8080", handler)
}

func handleOrders(w http.ResponseWriter, r *http.Request) {
    // Get peer identity from context
    if identity, ok := auth.GetPeerIdentity(r.Context()); ok {
        // Log or use the caller's identity
        _ = identity
    }
    // Handle request...
}
```

## Circuit Breaker Integration with Mesh

While Istio provides circuit breaking via DestinationRule, application-level circuit breakers complement mesh-level controls:

```go
// circuitbreaker/breaker.go
package circuitbreaker

import (
    "context"
    "errors"
    "net/http"
    "time"

    "github.com/sony/gobreaker"
)

// ErrCircuitOpen is returned when the circuit is open.
var ErrCircuitOpen = errors.New("circuit breaker is open")

// MeshAwareBreaker combines a Go circuit breaker with mesh-level awareness.
type MeshAwareBreaker struct {
    cb      *gobreaker.CircuitBreaker
    client  *http.Client
    baseURL string
}

// NewMeshAwareBreaker creates a circuit breaker tuned for service mesh usage.
// Istio also applies circuit breaking, but application-level CB provides
// faster feedback and better observability.
func NewMeshAwareBreaker(name, baseURL string, client *http.Client) *MeshAwareBreaker {
    settings := gobreaker.Settings{
        Name:        name,
        MaxRequests: 1,  // Allow 1 request to test when half-open
        Interval:    60 * time.Second,
        Timeout:     30 * time.Second, // Wait 30s before half-open
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            // Open circuit if >50% failures over last 5 requests
            failureRatio := float64(counts.TotalFailures) / float64(counts.Requests)
            return counts.Requests >= 5 && failureRatio >= 0.5
        },
        OnStateChange: func(name string, from gobreaker.State, to gobreaker.State) {
            // Emit metrics on state change
            circuitBreakerStateChanges.WithLabelValues(name,
                from.String(), to.String()).Inc()
        },
        IsSuccessful: func(err error) bool {
            // Count 5xx responses as failures
            var httpErr *HTTPError
            if errors.As(err, &httpErr) {
                return httpErr.StatusCode < 500
            }
            return err == nil
        },
    }

    return &MeshAwareBreaker{
        cb:      gobreaker.NewCircuitBreaker(settings),
        client:  client,
        baseURL: baseURL,
    }
}

// Do executes an HTTP request through the circuit breaker.
func (b *MeshAwareBreaker) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    resp, err := b.cb.Execute(func() (interface{}, error) {
        resp, err := b.client.Do(req.WithContext(ctx))
        if err != nil {
            return nil, err
        }
        if resp.StatusCode >= 500 {
            return resp, &HTTPError{StatusCode: resp.StatusCode}
        }
        return resp, nil
    })

    if err != nil {
        if errors.Is(err, gobreaker.ErrOpenState) {
            return nil, ErrCircuitOpen
        }
        return nil, err
    }

    return resp.(*http.Response), nil
}

// HTTPError represents an HTTP error response.
type HTTPError struct {
    StatusCode int
}

func (e *HTTPError) Error() string {
    return fmt.Sprintf("HTTP %d", e.StatusCode)
}
```

## SPIFFE/SVID Certificate Handling in Go

For services that manage mTLS directly (without a sidecar), use the SPIFFE Workload API:

```go
// spiffetls/client.go
package spiffetls

import (
    "context"
    "crypto/tls"
    "net/http"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

// NewSPIFFEClient creates an HTTP client that uses SPIFFE/SVID certificates
// for mTLS. Used when NOT behind an Istio sidecar (direct mTLS).
func NewSPIFFEClient(ctx context.Context, serverID spiffeid.ID) (*http.Client, error) {
    // Connect to the SPIFFE Workload API (typically the Istio agent or SPIRE)
    source, err := workloadapi.NewX509Source(ctx)
    if err != nil {
        return nil, fmt.Errorf("create X.509 source: %w", err)
    }

    // Create TLS config that uses our SVID and validates peer against trust domain
    tlsConfig := tlsconfig.MTLSClientConfig(source, source,
        tlsconfig.AuthorizeID(serverID))

    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
        },
    }, nil
}

// NewSPIFFEServer creates an HTTP server that requires mTLS with SPIFFE auth.
func NewSPIFFEServer(ctx context.Context, allowedIDs ...spiffeid.ID) (*tls.Config, error) {
    source, err := workloadapi.NewX509Source(ctx)
    if err != nil {
        return nil, fmt.Errorf("create X.509 source: %w", err)
    }

    // Authorize specific SPIFFE IDs
    authorizer := tlsconfig.AuthorizeOneOf(allowedIDs...)

    return tlsconfig.MTLSServerConfig(source, source, authorizer), nil
}
```

## Local mTLS Testing Without a Full Cluster

Testing mTLS-dependent code locally requires either mocking or a lightweight SPIFFE implementation:

### Approach 1: Test Double for the XFCC Header

```go
// testutil/mesh.go
package testutil

import (
    "fmt"
    "net/http"
    "net/http/httptest"
)

// MeshMiddleware simulates Istio's sidecar header injection for testing.
// Adds the x-forwarded-client-cert header as if the request came through
// an mTLS-authenticated connection.
func MeshMiddleware(
    callerNamespace,
    callerServiceAccount,
    trustDomain string,
) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            spiffeURI := fmt.Sprintf("spiffe://%s/ns/%s/sa/%s",
                trustDomain, callerNamespace, callerServiceAccount)

            // Simulate the XFCC header that Envoy sets
            xfcc := fmt.Sprintf(`By=spiffe://%s/ns/my-service/sa/my-sa;Hash=abc123;URI=%s`,
                trustDomain, spiffeURI)

            r.Header.Set("x-forwarded-client-cert", xfcc)
            next.ServeHTTP(w, r)
        })
    }
}

// TestRequest creates a test HTTP request with mesh headers set.
func TestRequestFromService(method, url, namespace, serviceAccount string) *http.Request {
    req := httptest.NewRequest(method, url, nil)
    spiffeURI := fmt.Sprintf("spiffe://cluster.local/ns/%s/sa/%s",
        namespace, serviceAccount)
    req.Header.Set("x-forwarded-client-cert",
        fmt.Sprintf("By=spiffe://cluster.local/ns/test/sa/test;Hash=abc123;URI=%s", spiffeURI))
    return req
}
```

### Approach 2: Embedded SPIRE for Integration Tests

```go
// integrationtest/spire_test.go
package integrationtest

import (
    "context"
    "testing"

    "github.com/spiffe/spire/test/integration/setup"
)

func TestWithSPIRE(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping SPIRE integration test")
    }

    ctx := context.Background()

    // Start a minimal SPIRE server for the test
    // This requires SPIRE binaries to be installed
    server := setup.NewSPIREServer(t, setup.Config{
        TrustDomain: "test.cluster.local",
    })
    defer server.Stop()

    // Register workloads
    server.RegisterWorkload(t, "spiffe://test.cluster.local/ns/test/sa/caller")
    server.RegisterWorkload(t, "spiffe://test.cluster.local/ns/test/sa/server")

    // Create mTLS client
    client, err := spiffetls.NewSPIFFEClient(ctx,
        spiffeid.RequireIDFromString("spiffe://test.cluster.local/ns/test/sa/server"))
    if err != nil {
        t.Fatal(err)
    }

    // Test your service with real mTLS
    // ...
    _ = client
}
```

### Approach 3: cert-manager + local Kubernetes

```bash
# Use kind + cert-manager + local Istio for integration testing
kind create cluster --name mtls-test

# Install cert-manager
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true

# Install Istio with mTLS STRICT
istioctl install --set profile=minimal \
  --set meshConfig.defaultConfig.proxyMetadata.BOOTSTRAP_XDS_AGENT=true \
  -y

kubectl apply -f - <<'EOF'
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: default
spec:
  mtls:
    mode: STRICT
EOF
```

## Observability: Tracing Propagation in Mesh

Istio generates traces automatically, but Go services must propagate trace context headers:

```go
// tracing/middleware.go
package tracing

import (
    "net/http"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/propagation"
)

// The set of headers Istio uses for distributed tracing
var istioHeaders = []string{
    "x-request-id",           // Istio request ID
    "x-b3-traceid",           // Zipkin B3 trace ID
    "x-b3-spanid",            // Zipkin B3 span ID
    "x-b3-parentspanid",      // Zipkin B3 parent span ID
    "x-b3-sampled",           // Zipkin B3 sampling flag
    "x-b3-flags",             // Zipkin B3 debug flag
    "b3",                     // B3 single header format
    "traceparent",            // W3C trace context
    "tracestate",             // W3C trace context
    "x-cloud-trace-context",  // GCP trace context
}

// PropagationMiddleware extracts and propagates Istio/Envoy trace headers.
func PropagationMiddleware(next http.Handler) http.Handler {
    propagator := otel.GetTextMapPropagator()

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := propagator.Extract(r.Context(),
            propagation.HeaderCarrier(r.Header))
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// InjectHeaders injects trace context into outgoing requests.
// Call this before making downstream HTTP calls.
func InjectHeaders(ctx context.Context, headers http.Header) {
    otel.GetTextMapPropagator().Inject(ctx,
        propagation.HeaderCarrier(headers))
}

// ForwardIstioHeaders copies Istio-specific headers from incoming request
// to outgoing request. This is required for Istio's trace correlation.
func ForwardIstioHeaders(incoming, outgoing *http.Request) {
    for _, header := range istioHeaders {
        if val := incoming.Header.Get(header); val != "" {
            outgoing.Header.Set(header, val)
        }
    }
}
```

## PeerAuthentication and AuthorizationPolicy

Configure Istio to enforce the authorization rules that match your Go application's peer list:

```yaml
# Enforce mTLS for the service
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: order-service
  namespace: orders
spec:
  selector:
    matchLabels:
      app: order-service
  mtls:
    mode: STRICT
---
# Authorize only specific callers
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: order-service-authz
  namespace: orders
spec:
  selector:
    matchLabels:
      app: order-service
  action: ALLOW
  rules:
  # Allow API gateway to access all endpoints
  - from:
    - source:
        principals:
        - "cluster.local/ns/api-gateway/sa/gateway"
    to:
    - operation:
        methods: ["GET", "POST"]
  # Allow payment service to access specific endpoints
  - from:
    - source:
        principals:
        - "cluster.local/ns/payments/sa/payment-processor"
    to:
    - operation:
        methods: ["POST"]
        paths: ["/api/v1/orders/*/payment"]
  # Allow admin tools for internal management
  - from:
    - source:
        namespaces: ["admin"]
```

## Conclusion

Building mTLS-aware Go services in a service mesh involves several distinct concerns:

1. **HTTP client tuning**: Increase `MaxIdleConnsPerHost` from 2 to match expected throughput; disable application-level HTTP/2 negotiation to avoid conflicts with Envoy's transport handling
2. **XFCC header parsing**: Extract the caller's SPIFFE identity from `x-forwarded-client-cert` headers for application-level authorization beyond what mesh policies provide
3. **Authorization middleware**: Build peer identity validation at the application layer as defense-in-depth; mesh policies can be misconfigured or bypassed (e.g., direct pod-to-pod during mesh maintenance)
4. **Circuit breakers**: Application-level circuit breakers complement mesh-level circuit breaking with faster feedback loops and application-specific failure logic
5. **Testing**: Mock XFCC headers in unit tests; use kind + Istio for integration tests; prefer the go-spiffe library for direct SPIFFE usage
6. **Trace propagation**: Always forward Istio's trace headers in outgoing requests; use OpenTelemetry propagators for standard B3/W3C formats

The combination of mesh-level mTLS enforcement and application-level identity validation provides defense-in-depth security that protects against both network-level attacks and compromised workloads within the mesh.
