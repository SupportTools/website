---
title: "Zero Trust Networking in Go: mTLS, SPIFFE, and SPIRE for Service Identity"
date: 2028-10-17T00:00:00-05:00
draft: false
tags: ["Go", "Zero Trust", "mTLS", "SPIFFE", "Security"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement zero trust service identity in Go using SPIFFE SVIDs, SPIRE for certificate management on Kubernetes, automatic mTLS between services, and workload attestation without long-lived credentials."
more_link: "yes"
url: "/go-zero-trust-mtls-spiffe-spire-guide/"
---

Zero trust networking eliminates the assumption that services inside your cluster can be trusted simply because they share a network. Every service call must be authenticated and authorized regardless of source IP or namespace. SPIFFE (Secure Production Identity Framework For Everyone) provides the identity specification, and SPIRE (the SPIFFE Runtime Environment) issues short-lived X.509 certificates to workloads without requiring them to manage long-lived credentials. Go services can use these certificates to establish mTLS connections where both sides prove their identity before any data flows.

This guide builds a complete zero trust setup: SPIRE server and agent on Kubernetes, Go services that fetch and rotate SVIDs automatically, mTLS between Go services using those SVIDs, and Kubernetes workload attestation so SPIRE can verify which pod is requesting an identity.

<!--more-->

# Zero Trust Networking in Go: mTLS, SPIFFE, and SPIRE for Service Identity

## SPIFFE Concepts

**SPIFFE ID**: A URI of the form `spiffe://trust-domain/path` that uniquely identifies a workload. Example: `spiffe://prod.yourorg.com/ns/payments/sa/payment-processor`. This is analogous to a username but for services.

**SVID (SPIFFE Verifiable Identity Document)**: The credential that proves a workload's SPIFFE ID. Two forms:
- **X.509-SVID**: An X.509 certificate with the SPIFFE ID in the Subject Alternative Name URI field. Used for mTLS.
- **JWT-SVID**: A signed JWT containing the SPIFFE ID. Used for HTTP Authorization headers.

**Trust Bundle**: The set of CA certificates trusted for verifying SVIDs. SPIRE distributes trust bundles to all workloads.

**Workload API**: The Unix socket API that workloads use to fetch their SVIDs. The Go SDK wraps this.

## SPIRE Architecture on Kubernetes

```
┌─────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                      │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  spire-server (StatefulSet in spire namespace)  │    │
│  │  - Issues SVIDs to registered workloads         │    │
│  │  - Stores registration entries in SQLite/DB     │    │
│  │  - Exposes server API to agents                 │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ mTLS                             │
│  ┌────────────────────▼────────────────────────────┐    │
│  │  spire-agent (DaemonSet on every node)          │    │
│  │  - Attests to server using Kubernetes API       │    │
│  │  - Fetches SVIDs for pods on its node           │    │
│  │  - Exposes Workload API socket to pods          │    │
│  └────────────────────────────────────────────────-┘    │
│         │ /run/spire/sockets/agent.sock (hostPath)       │
│  ┌──────▼──────────┐    ┌────────────────────────┐      │
│  │  payment-svc    │    │  inventory-svc          │      │
│  │  (pod)          │◀───│  (pod)                  │      │
│  │  SVID: .../pay  │mTLS│  SVID: .../inventory    │      │
│  └─────────────────┘    └────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

## Installing SPIRE

```bash
# Clone the SPIRE quickstart manifests
git clone https://github.com/spiffe/spire-tutorials.git
cd spire-tutorials/k8s/quickstart

# Or use Helm (recommended for production)
helm repo add spiffe https://spiffe.github.io/helm-charts-hardened/
helm repo update

helm install spire spiffe/spire \
  --namespace spire \
  --create-namespace \
  --set global.spiffe.trustDomain=prod.yourorg.com \
  --set spire-server.replicaCount=1 \
  --set spire-agent.logLevel=INFO \
  --version 0.21.0 \
  --wait
```

Or apply the core manifests manually:

```yaml
# spire-server.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-server
  namespace: spire
data:
  server.conf: |
    server {
      bind_address = "0.0.0.0"
      bind_port = "8081"
      trust_domain = "prod.yourorg.com"
      data_dir = "/run/spire/data"
      log_level = "INFO"
      # Short-lived SVIDs for zero trust
      default_x509_svid_ttl = "1h"
      default_jwt_svid_ttl = "5m"
      ca_ttl = "24h"
    }

    plugins {
      DataStore "sql" {
        plugin_data {
          database_type = "sqlite3"
          connection_string = "/run/spire/data/datastore.sqlite3"
        }
      }

      KeyManager "disk" {
        plugin_data {
          keys_path = "/run/spire/data/keys.json"
        }
      }

      NodeAttestor "k8s_psat" {
        plugin_data {
          clusters = {
            "production" = {
              service_account_allow_list = ["spire:spire-agent"]
            }
          }
        }
      }

      UpstreamAuthority "disk" {
        plugin_data {
          cert_file_path = "/run/spire/secrets/bootstrap.crt"
          key_file_path  = "/run/spire/secrets/bootstrap.key"
        }
      }
    }
```

```yaml
# spire-agent.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-agent
  namespace: spire
data:
  agent.conf: |
    agent {
      data_dir = "/run/spire/data"
      log_level = "INFO"
      server_address = "spire-server.spire.svc"
      server_port = "8081"
      socket_path = "/run/spire/sockets/agent.sock"
      trust_bundle_path = "/run/spire/bundle/bundle.crt"
      trust_domain = "prod.yourorg.com"
    }

    plugins {
      NodeAttestor "k8s_psat" {
        plugin_data {
          cluster = "production"
        }
      }

      KeyManager "memory" {
        plugin_data {}
      }

      WorkloadAttestor "k8s" {
        plugin_data {
          skip_kubelet_verification = false
        }
      }
    }
```

```yaml
# spire-agent-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: spire-agent
  namespace: spire
spec:
  selector:
    matchLabels:
      app: spire-agent
  template:
    metadata:
      labels:
        app: spire-agent
    spec:
      hostPID: true
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      serviceAccountName: spire-agent
      initContainers:
        - name: init-server
          image: cgr.dev/chainguard/wait-for-it:latest
          args:
            - spire-server.spire.svc:8081
            - -t
            - "30"
      containers:
        - name: spire-agent
          image: ghcr.io/spiffe/spire-agent:1.10.0
          args: ["-config", "/run/spire/config/agent.conf"]
          volumeMounts:
            - name: spire-config
              mountPath: /run/spire/config
              readOnly: true
            - name: spire-bundle
              mountPath: /run/spire/bundle
              readOnly: true
            - name: spire-agent-socket-dir
              mountPath: /run/spire/sockets
            - name: spire-data
              mountPath: /run/spire/data
            # Kubernetes token for node attestation
            - name: spire-agent-token
              mountPath: /var/run/secrets/tokens
          livenessProbe:
            exec:
              command: ["/opt/spire/bin/spire-agent", "healthcheck", "-socketPath", "/run/spire/sockets/agent.sock"]
            initialDelaySeconds: 15
            periodSeconds: 60
      volumes:
        - name: spire-config
          configMap:
            name: spire-agent
        - name: spire-bundle
          configMap:
            name: spire-bundle
        - name: spire-agent-socket-dir
          hostPath:
            path: /run/spire/sockets
            type: DirectoryOrCreate
        - name: spire-data
          emptyDir: {}
        - name: spire-agent-token
          projected:
            sources:
              - serviceAccountToken:
                  audience: spire-server
                  expirationSeconds: 7200
                  path: spire-agent
```

## Registering Workloads

SPIRE needs a registration entry telling it which pods should receive which SPIFFE IDs:

```bash
# Register the payment-processor service
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://prod.yourorg.com/ns/payments/sa/payment-processor \
  -parentID spiffe://prod.yourorg.com/k8s-psat/production/node \
  -selector k8s:ns:payments \
  -selector k8s:sa:payment-processor \
  -selector k8s:pod-label:app:payment-processor \
  -ttl 3600

# Register the inventory service
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://prod.yourorg.com/ns/inventory/sa/inventory-service \
  -parentID spiffe://prod.yourorg.com/k8s-psat/production/node \
  -selector k8s:ns:inventory \
  -selector k8s:sa:inventory-service \
  -selector k8s:pod-label:app:inventory-service \
  -ttl 3600

# List registered entries
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry show
```

Or manage entries declaratively with the SPIRE Controller Manager:

```yaml
# clusterspiffeid.yaml
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: payment-processor
spec:
  spiffeIDTemplate: "spiffe://prod.yourorg.com/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      spiffe.io/spiffe-id: "true"
  ttl: 1h
```

## Go Service: Fetching SVIDs with the Workload API

```go
// internal/identity/workload.go
package identity

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"sync"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
)

const workloadAPIAddr = "unix:///run/spire/sockets/agent.sock"

// SVIDSource provides continuously-refreshed X.509 SVIDs.
type SVIDSource struct {
	mu     sync.RWMutex
	source *workloadapi.X509Source
}

// NewSVIDSource creates an X.509 source that fetches SVIDs from the SPIRE agent.
// It automatically rotates the SVID before it expires.
func NewSVIDSource(ctx context.Context) (*SVIDSource, error) {
	source, err := workloadapi.NewX509Source(
		ctx,
		workloadapi.WithClientOptions(workloadapi.WithAddr(workloadAPIAddr)),
	)
	if err != nil {
		return nil, fmt.Errorf("create X509 source: %w", err)
	}

	// Verify we got an SVID immediately
	svid, err := source.GetX509SVID()
	if err != nil {
		return nil, fmt.Errorf("fetch initial SVID: %w", err)
	}

	expiry := svid.Certificates[0].NotAfter
	fmt.Printf("SVID obtained: %s (expires: %s)\n",
		svid.ID.String(),
		expiry.Format(time.RFC3339),
	)

	return &SVIDSource{source: source}, nil
}

// TLSServerConfig returns a tls.Config for mTLS servers.
// It uses the SVID as the server certificate and requires client SVIDs.
func (s *SVIDSource) TLSServerConfig(authorizedClients ...spiffeid.ID) *tls.Config {
	return tlsconfig.MTLSServerConfig(
		s.source,
		s.source,
		tlsconfig.AuthorizeAnyOf(authorizedClients...),
	)
}

// TLSClientConfig returns a tls.Config for mTLS clients connecting to a specific server SPIFFE ID.
func (s *SVIDSource) TLSClientConfig(serverID spiffeid.ID) *tls.Config {
	return tlsconfig.MTLSClientConfig(
		s.source,
		s.source,
		tlsconfig.AuthorizeID(serverID),
	)
}

// TrustPool returns the current trust bundle as a *x509.CertPool.
func (s *SVIDSource) TrustPool() (*x509.CertPool, error) {
	bundles, err := s.source.GetX509BundleForTrustDomain(
		spiffeid.RequireTrustDomainFromString("prod.yourorg.com"),
	)
	if err != nil {
		return nil, err
	}
	return bundles.X509Bundle().X509Authorities(), nil
}

// Close releases the SVID source.
func (s *SVIDSource) Close() error {
	return s.source.Close()
}
```

## mTLS HTTP Server

```go
// internal/server/mtls_server.go
package server

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"

	"github.com/yourorg/payment-processor/internal/identity"
)

// StartMTLSServer starts an HTTP server with SPIFFE-based mTLS.
func StartMTLSServer(ctx context.Context, addr string, svids *identity.SVIDSource, handler http.Handler) error {
	// Only allow requests from the inventory service
	inventoryID := spiffeid.RequireIDFromString(
		"spiffe://prod.yourorg.com/ns/inventory/sa/inventory-service",
	)

	tlsCfg := svids.TLSServerConfig(inventoryID)

	server := &http.Server{
		Addr:      addr,
		Handler:   handler,
		TLSConfig: tlsCfg,
		// Enforce timeouts — connections from untrusted sources are dropped after TLS handshake failure
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// TLS cert and key are managed by the SVID source — pass empty strings
	return server.ListenAndServeTLS("", "")
}

// AuthMiddleware extracts the peer SPIFFE ID from the TLS connection
// and injects it into the request context for authorization decisions.
func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, "client certificate required", http.StatusUnauthorized)
			return
		}

		// The SPIFFE ID is in the first URI SAN of the peer certificate
		cert := r.TLS.PeerCertificates[0]
		if len(cert.URIs) == 0 {
			http.Error(w, "no SPIFFE ID in client certificate", http.StatusUnauthorized)
			return
		}

		spiffeID := cert.URIs[0].String()
		ctx := context.WithValue(r.Context(), spiffeIDKey{}, spiffeID)
		r = r.WithContext(ctx)

		next.ServeHTTP(w, r)
	})
}

type spiffeIDKey struct{}

func PeerSPIFFEID(ctx context.Context) string {
	id, _ := ctx.Value(spiffeIDKey{}).(string)
	return id
}
```

## mTLS HTTP Client

```go
// internal/client/mtls_client.go
package client

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/spiffe/go-spiffe/v2/spiffeid"

	"github.com/yourorg/inventory-service/internal/identity"
)

// PaymentClient calls the payment-processor service over mTLS.
type PaymentClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewPaymentClient creates a client that uses SVID-based mTLS.
func NewPaymentClient(svids *identity.SVIDSource, baseURL string) *PaymentClient {
	paymentID := spiffeid.RequireIDFromString(
		"spiffe://prod.yourorg.com/ns/payments/sa/payment-processor",
	)

	transport := &http.Transport{
		TLSClientConfig: svids.TLSClientConfig(paymentID),
		// Standard production transport settings
		MaxIdleConnsPerHost:   100,
		MaxConnsPerHost:       100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	return &PaymentClient{
		httpClient: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
		},
		baseURL: baseURL,
	}
}

// ProcessPayment calls the payment-processor with mTLS authentication.
func (c *PaymentClient) ProcessPayment(ctx context.Context, req PaymentRequest) (*PaymentResponse, error) {
	// The TLS handshake verifies:
	// 1. Server has SVID for spiffe://prod.yourorg.com/ns/payments/sa/payment-processor
	// 2. Server trusts our SVID (spiffe://prod.yourorg.com/ns/inventory/sa/inventory-service)
	// No API keys, no bearer tokens needed

	url := c.baseURL + "/v1/payments"
	body, _ := json.Marshal(req)

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("payment request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("payment processor returned %d", resp.StatusCode)
	}

	var result PaymentResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode payment response: %w", err)
	}
	return &result, nil
}
```

## JWT SVIDs for Cross-Service Authorization

For services that communicate over HTTP without a persistent TLS connection (e.g., through a load balancer that terminates TLS), use JWT SVIDs:

```go
// internal/identity/jwt.go
package identity

import (
	"context"
	"fmt"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/svid/jwtsvid"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
)

// JWTSVIDFetcher fetches JWT SVIDs from the SPIRE agent.
type JWTSVIDFetcher struct {
	client *workloadapi.Client
}

func NewJWTSVIDFetcher(ctx context.Context) (*JWTSVIDFetcher, error) {
	client, err := workloadapi.New(ctx, workloadapi.WithAddr(workloadAPIAddr))
	if err != nil {
		return nil, fmt.Errorf("create workload API client: %w", err)
	}
	return &JWTSVIDFetcher{client: client}, nil
}

// FetchJWTSVID fetches a JWT SVID for calling a specific service (the audience).
func (f *JWTSVIDFetcher) FetchJWTSVID(ctx context.Context, audience spiffeid.ID) (string, error) {
	svids, err := f.client.FetchJWTSVIDs(ctx, jwtsvid.Params{
		Audience: audience.String(),
	})
	if err != nil {
		return "", fmt.Errorf("fetch JWT SVID: %w", err)
	}
	if len(svids) == 0 {
		return "", fmt.Errorf("no JWT SVIDs returned")
	}
	return svids[0].Marshal(), nil
}

// ValidateJWTSVID validates a JWT SVID received in an HTTP request.
func (f *JWTSVIDFetcher) ValidateJWTSVID(ctx context.Context, token string, audience spiffeid.ID) (*jwtsvid.SVID, error) {
	bundleSource, err := workloadapi.NewBundleSource(ctx, workloadapi.WithAddr(workloadAPIAddr))
	if err != nil {
		return nil, err
	}
	defer bundleSource.Close()

	svid, err := jwtsvid.ParseAndValidate(token, bundleSource, []string{audience.String()})
	if err != nil {
		return nil, fmt.Errorf("invalid JWT SVID: %w", err)
	}
	return svid, nil
}
```

HTTP middleware for JWT SVID validation:

```go
func JWTAuthMiddleware(fetcher *identity.JWTSVIDFetcher) func(http.Handler) http.Handler {
	audience := spiffeid.RequireIDFromString(
		"spiffe://prod.yourorg.com/ns/payments/sa/payment-processor",
	)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			token, found := strings.CutPrefix(authHeader, "Bearer ")
			if !found {
				http.Error(w, "missing Bearer token", http.StatusUnauthorized)
				return
			}

			svid, err := fetcher.ValidateJWTSVID(r.Context(), token, audience)
			if err != nil {
				http.Error(w, "invalid SVID", http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), spiffeIDKey{}, svid.ID.String())
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
```

## Mounting the Workload API Socket in Pods

Pods need access to the SPIRE agent's workload API socket. The agent exposes it on every node as a hostPath:

```yaml
# deployment-payment-processor.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-processor
  namespace: payments
spec:
  template:
    spec:
      serviceAccountName: payment-processor
      containers:
        - name: payment-processor
          image: registry.yourorg.com/payment-processor:v1.2.3
          ports:
            - containerPort: 8443
              name: https
          env:
            - name: SPIFFE_ENDPOINT_SOCKET
              value: "unix:///run/spire/sockets/agent.sock"
          volumeMounts:
            - name: spire-agent-socket
              mountPath: /run/spire/sockets
              readOnly: true
          securityContext:
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
      volumes:
        - name: spire-agent-socket
          hostPath:
            path: /run/spire/sockets
            type: Directory
```

## Integrating with Envoy for SPIFFE-Based mTLS

For polyglot environments where not all services are Go, Envoy can handle the SPIFFE mTLS while the application speaks plaintext:

```yaml
# envoy-sidecar-config.yaml (abbreviated)
static_resources:
  listeners:
    - name: inbound
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 10000
      filter_chains:
        - transport_socket:
            name: envoy.transport_sockets.tls
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
              common_tls_context:
                tls_certificate_sds_secret_configs:
                  - name: "spiffe://prod.yourorg.com/ns/payments/sa/payment-processor"
                    sds_config:
                      api_config_source:
                        api_type: GRPC
                        grpc_services:
                          - envoy_grpc:
                              cluster_name: spire_agent
                combined_validation_context:
                  default_validation_context:
                    match_typed_subject_alt_names:
                      - san_type: URI
                        matcher:
                          prefix: "spiffe://prod.yourorg.com/"
                  validation_context_sds_secret_config:
                    name: "spiffe://prod.yourorg.com"
                    sds_config:
                      api_config_source:
                        api_type: GRPC
                        grpc_services:
                          - envoy_grpc:
                              cluster_name: spire_agent
              require_client_certificate: true
```

## Verifying SVID Rotation

SVIDs expire (default 1 hour). The go-spiffe SDK handles rotation automatically, but verify it is working:

```bash
# Watch SVID expiry times from within a pod
kubectl exec -n payments deployment/payment-processor -- \
  /opt/spire/bin/spire-agent api fetch x509 \
  -socketPath /run/spire/sockets/agent.sock

# Output shows current SVID and its expiry
# SPIFFE ID:    spiffe://prod.yourorg.com/ns/payments/sa/payment-processor
# SVID Valid After:  2024-01-01 10:00:00 +0000 UTC
# SVID Valid Until:  2024-01-01 11:00:00 +0000 UTC  ← 1-hour TTL
# CA Valid After:    2024-01-01 00:00:00 +0000 UTC
# CA Valid Until:    2024-01-02 00:00:00 +0000 UTC
```

The go-spiffe SDK begins rotating 30 minutes before expiry by default, ensuring continuous availability.

## go.mod Dependencies

```go
module github.com/yourorg/payment-processor

go 1.22

require (
    github.com/spiffe/go-spiffe/v2 v2.4.0
    // go-spiffe pulls in:
    // google.golang.org/grpc
    // github.com/spiffe/spiffe-helper (for sidecars)
)
```

SPIFFE and SPIRE provide cryptographically verified service identity without static credentials or long-lived secrets. Every service knows exactly who it is talking to, certificates rotate automatically with no human intervention, and the attack surface is dramatically reduced — a compromised pod cannot impersonate a different service because it cannot obtain an SVID for it from SPIRE.
