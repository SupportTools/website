---
title: "Go TLS Certificate Management: Auto-Renewal, mTLS, and Certificate Pinning"
date: 2028-10-21T00:00:00-05:00
draft: false
tags: ["Go", "TLS", "Security", "Certificates", "HTTPS"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Go TLS configuration covering tls.Config options, hot certificate rotation, Let's Encrypt autocert, mutual TLS, certificate pinning, OCSP stapling, and diagnosing TLS errors in production."
more_link: "yes"
url: "/go-tls-certificate-management-production-guide/"
---

Managing TLS in production Go services is more than calling `http.ListenAndServeTLS`. Certificate expiry, key rotation without downtime, mutual authentication between microservices, and defending against certificate substitution attacks each require deliberate design. This guide covers every layer of TLS management in Go, from the raw `tls.Config` fields most developers never touch to full Let's Encrypt automation and Redis-backed certificate caching.

<!--more-->

# Go TLS Certificate Management in Production

## Understanding tls.Config

The `tls.Config` struct is the control plane for every TLS connection in Go. Most of the defaults are sensible, but production deployments need explicit values for cipher suites, minimum versions, and session handling.

```go
package main

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"os"
)

func productionTLSConfig() *tls.Config {
	return &tls.Config{
		// Minimum TLS 1.2; prefer 1.3
		MinVersion: tls.VersionTLS12,

		// Explicit cipher suites for TLS 1.2 (1.3 suites are not configurable)
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
		},

		// Prefer server cipher order to control negotiated suite
		PreferServerCipherSuites: true,

		// Disable session tickets to improve forward secrecy (costs CPU)
		SessionTicketsDisabled: false,

		// Curve preferences for ECDHE
		CurvePreferences: []tls.CurveID{
			tls.X25519,
			tls.CurveP256,
		},
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("TLS OK"))
	})

	srv := &http.Server{
		Addr:      ":8443",
		Handler:   mux,
		TLSConfig: productionTLSConfig(),
	}

	// Load from PEM files
	cert, err := tls.LoadX509KeyPair("server.crt", "server.key")
	if err != nil {
		panic(err)
	}
	srv.TLSConfig.Certificates = []tls.Certificate{cert}

	if err := srv.ListenAndServeTLS("", ""); err != nil {
		panic(err)
	}
}
```

## Certificate Loading and Hot Rotation

The most common operational problem with TLS in Go is certificate expiry causing downtime because the process must restart to pick up renewed certificates. `tls.Config.GetCertificate` lets you supply certificates dynamically on every handshake.

```go
package tlsrotation

import (
	"crypto/tls"
	"log"
	"os"
	"sync"
	"time"
)

// RotatingCertificate holds a certificate and reloads it from disk when it
// detects the file has been modified.
type RotatingCertificate struct {
	mu       sync.RWMutex
	certFile string
	keyFile  string
	cert     *tls.Certificate
	modTime  time.Time
}

func NewRotatingCertificate(certFile, keyFile string) (*RotatingCertificate, error) {
	rc := &RotatingCertificate{
		certFile: certFile,
		keyFile:  keyFile,
	}
	if err := rc.reload(); err != nil {
		return nil, err
	}
	go rc.watchLoop()
	return rc, nil
}

func (rc *RotatingCertificate) reload() error {
	cert, err := tls.LoadX509KeyPair(rc.certFile, rc.keyFile)
	if err != nil {
		return err
	}
	info, err := os.Stat(rc.certFile)
	if err != nil {
		return err
	}
	rc.mu.Lock()
	rc.cert = &cert
	rc.modTime = info.ModTime()
	rc.mu.Unlock()
	log.Printf("tlsrotation: loaded certificate from %s (mod: %s)", rc.certFile, info.ModTime())
	return nil
}

func (rc *RotatingCertificate) watchLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		info, err := os.Stat(rc.certFile)
		if err != nil {
			log.Printf("tlsrotation: stat error: %v", err)
			continue
		}
		rc.mu.RLock()
		changed := info.ModTime().After(rc.modTime)
		rc.mu.RUnlock()
		if changed {
			if err := rc.reload(); err != nil {
				log.Printf("tlsrotation: reload error: %v", err)
			}
		}
	}
}

// GetCertificate satisfies tls.Config.GetCertificate.
func (rc *RotatingCertificate) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.cert, nil
}

// TLSConfig returns a *tls.Config wired to this rotating certificate.
func (rc *RotatingCertificate) TLSConfig() *tls.Config {
	return &tls.Config{
		GetCertificate: rc.GetCertificate,
		MinVersion:     tls.VersionTLS12,
	}
}
```

Usage in a server:

```go
package main

import (
	"net/http"
	"tlsrotation" // local package above
)

func main() {
	rc, err := tlsrotation.NewRotatingCertificate("/etc/tls/tls.crt", "/etc/tls/tls.key")
	if err != nil {
		panic(err)
	}

	srv := &http.Server{
		Addr:      ":8443",
		TLSConfig: rc.TLSConfig(),
		Handler:   http.DefaultServeMux,
	}

	// ListenAndServeTLS with empty strings uses TLSConfig.GetCertificate
	if err := srv.ListenAndServeTLS("", ""); err != nil {
		panic(err)
	}
}
```

Kubernetes cert-manager renews certificates and writes them to a Secret. A projected volume or a CSI driver mounts the Secret to a path. The watcher above detects the file change and rotates with zero dropped connections.

## Let's Encrypt with autocert

`golang.org/x/crypto/acme/autocert` handles ACME certificate provisioning and renewal automatically, storing certificates in a local directory or a custom `autocert.Cache`.

```go
package main

import (
	"crypto/tls"
	"net/http"

	"golang.org/x/crypto/acme/autocert"
)

func main() {
	m := &autocert.Manager{
		Cache:      autocert.DirCache("/var/cache/autocert"),
		Prompt:     autocert.AcceptTOS,
		HostPolicy: autocert.HostWhitelist("api.example.com", "www.example.com"),
		Email:      "ops@example.com",
	}

	// Redirect HTTP to HTTPS and handle ACME HTTP-01 challenges
	go func() {
		srv := &http.Server{
			Addr:    ":80",
			Handler: m.HTTPHandler(nil),
		}
		if err := srv.ListenAndServe(); err != nil {
			panic(err)
		}
	}()

	srv := &http.Server{
		Addr: ":443",
		TLSConfig: &tls.Config{
			GetCertificate: m.GetCertificate,
			MinVersion:     tls.VersionTLS12,
		},
		Handler: http.DefaultServeMux,
	}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("Secured by Let's Encrypt"))
	})

	if err := srv.ListenAndServeTLS("", ""); err != nil {
		panic(err)
	}
}
```

### Redis-backed autocert Cache

In a multi-replica deployment every instance needs the same certificate. A Redis cache implementation satisfies `autocert.Cache`:

```go
package rediscache

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/acme/autocert"
)

type RedisCache struct {
	client *redis.Client
	prefix string
}

func New(client *redis.Client, prefix string) *RedisCache {
	return &RedisCache{client: client, prefix: prefix}
}

func (r *RedisCache) key(name string) string {
	return r.prefix + ":" + name
}

func (r *RedisCache) Get(ctx context.Context, name string) ([]byte, error) {
	val, err := r.client.Get(ctx, r.key(name)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, autocert.ErrCacheMiss
	}
	return val, err
}

func (r *RedisCache) Put(ctx context.Context, name string, data []byte) error {
	return r.client.Set(ctx, r.key(name), data, 0).Err()
}

func (r *RedisCache) Delete(ctx context.Context, name string) error {
	return r.client.Del(ctx, r.key(name)).Err()
}
```

## Mutual TLS (mTLS)

Mutual TLS requires clients to present a certificate signed by a trusted CA. This is the foundation of service-to-service authentication in a microservice mesh without a sidecar proxy.

### Server-side mTLS configuration

```go
package mtls

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"os"
)

// ServerTLSConfig returns a *tls.Config that requires client certificates
// signed by the CA in caCertFile.
func ServerTLSConfig(caCertFile string) (*tls.Config, error) {
	caCert, err := os.ReadFile(caCertFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		return nil, errors.New("failed to parse CA certificate")
	}
	return &tls.Config{
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  pool,
		MinVersion: tls.VersionTLS12,
	}, nil
}

// ClientTLSConfig returns a *tls.Config with a client certificate and the
// server CA for verification.
func ClientTLSConfig(certFile, keyFile, caCertFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	caCert, err := os.ReadFile(caCertFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caCert) {
		return nil, errors.New("failed to parse CA certificate")
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      pool,
		MinVersion:   tls.VersionTLS12,
	}, nil
}
```

### Extracting client identity from the request

```go
func clientIdentityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, "client certificate required", http.StatusUnauthorized)
			return
		}
		cert := r.TLS.PeerCertificates[0]
		// Common name or SAN can carry service identity
		ctx := context.WithValue(r.Context(), clientCNKey, cert.Subject.CommonName)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

### Generating a test CA and client/server certificates

```bash
# Create CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/CN=Test CA/O=support.tools"

# Server certificate
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr \
  -subj "/CN=server.internal/O=support.tools"
openssl x509 -req -days 365 -in server.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt \
  -extfile <(echo "subjectAltName=DNS:server.internal,DNS:localhost")

# Client certificate
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr \
  -subj "/CN=payment-service/O=support.tools"
openssl x509 -req -days 365 -in client.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial -out client.crt
```

## Certificate Pinning

Certificate pinning rejects connections to servers whose certificate public key does not match a pinned value. This defends against CA compromise or BGP hijacking attacks.

```go
package pinning

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"net/http"
)

// Pin represents a SHA-256 hash of a certificate's SubjectPublicKeyInfo (SPKI).
type Pin string

// PinnedTransport wraps http.Transport and verifies certificate pins.
type PinnedTransport struct {
	base http.RoundTripper
	pins map[string][]Pin // hostname -> accepted pins
}

func NewPinnedTransport(pins map[string][]Pin) *PinnedTransport {
	return &PinnedTransport{
		base: &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
		pins: pins,
	}
}

func (pt *PinnedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := pt.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if resp.TLS == nil {
		return nil, errors.New("pinning: connection is not TLS")
	}

	accepted := pt.pins[req.URL.Hostname()]
	if len(accepted) == 0 {
		// No pins configured for this host; allow
		return resp, nil
	}

	for _, cert := range resp.TLS.PeerCertificates {
		pin := spkiPin(cert.RawSubjectPublicKeyInfo)
		for _, p := range accepted {
			if pin == string(p) {
				return resp, nil
			}
		}
	}
	resp.Body.Close()
	return nil, errors.New("pinning: no certificate matched the pinset for " + req.URL.Hostname())
}

func spkiPin(spki []byte) string {
	digest := sha256.Sum256(spki)
	return base64.StdEncoding.EncodeToString(digest[:])
}
```

Usage:

```go
func main() {
	// Obtain the pin by running:
	// openssl s_client -connect api.example.com:443 2>/dev/null \
	//   | openssl x509 -pubkey -noout \
	//   | openssl pkey -pubin -outform DER \
	//   | openssl dgst -sha256 -binary | base64
	pins := map[string][]pinning.Pin{
		"api.example.com": {"AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCDEFG="},
	}

	client := &http.Client{
		Transport: pinning.NewPinnedTransport(pins),
	}

	resp, err := client.Get("https://api.example.com/health")
	if err != nil {
		log.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
}
```

## OCSP Stapling

OCSP stapling attaches the revocation status response to the TLS handshake, eliminating the latency of the client making a separate OCSP request.

```go
package ocsp

import (
	"crypto/tls"
	"crypto/x509"
	"log"
	"net/http"
	"sync"
	"time"

	gocsp "golang.org/x/crypto/ocsp"
)

// StapledCertificate extends RotatingCertificate with periodic OCSP staple
// renewal.
type StapledCertificate struct {
	mu         sync.RWMutex
	cert       tls.Certificate
	staple     []byte
	issuerCert *x509.Certificate
}

func (sc *StapledCertificate) refreshStaple() {
	leaf := sc.cert.Leaf
	if leaf == nil {
		return
	}
	if sc.issuerCert == nil {
		return
	}

	// Build OCSP request
	req, err := gocsp.CreateRequest(leaf, sc.issuerCert, nil)
	if err != nil {
		log.Printf("ocsp: create request: %v", err)
		return
	}

	// Use the OCSP URL from the cert's AIA extension
	if len(leaf.OCSPServer) == 0 {
		return
	}
	resp, err := http.Post(leaf.OCSPServer[0], "application/ocsp-request", bytes.NewReader(req))
	if err != nil {
		log.Printf("ocsp: POST: %v", err)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	ocspResp, err := gocsp.ParseResponse(body, sc.issuerCert)
	if err != nil {
		log.Printf("ocsp: parse response: %v", err)
		return
	}
	if ocspResp.Status != gocsp.Good {
		log.Printf("ocsp: certificate status is not Good: %d", ocspResp.Status)
		return
	}

	sc.mu.Lock()
	sc.cert.OCSPStaple = body
	sc.mu.Unlock()
	log.Printf("ocsp: staple refreshed, next update: %s", ocspResp.NextUpdate)
}

func (sc *StapledCertificate) RunRefreshLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	sc.refreshStaple()
	for range ticker.C {
		sc.refreshStaple()
	}
}

func (sc *StapledCertificate) GetCertificate(_ *tls.ClientHelloInfo) (*tls.Certificate, error) {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	c := sc.cert
	return &c, nil
}
```

## Custom CA Chains

Internal PKI chains require loading the CA bundle into `x509.CertPool` before making requests.

```go
package cachain

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
)

// HTTPClientWithCA returns an *http.Client that trusts the system CA pool plus
// any additional PEM-encoded CA certificates provided.
func HTTPClientWithCA(caPEMFiles ...string) (*http.Client, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		// SystemCertPool may fail on some platforms; start empty
		pool = x509.NewCertPool()
	}

	for _, f := range caPEMFiles {
		pem, err := os.ReadFile(f)
		if err != nil {
			return nil, fmt.Errorf("reading CA file %s: %w", f, err)
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("failed to parse CA from %s", f)
		}
	}

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:    pool,
			MinVersion: tls.VersionTLS12,
		},
	}
	return &http.Client{Transport: transport}, nil
}
```

## Testing TLS with httptest

`net/http/httptest` provides `httptest.NewTLSServer` which uses a built-in self-signed certificate. For tests requiring custom CAs or mTLS, configure `httptest.Server.TLS` before calling `StartTLS`.

```go
package tlstest_test

import (
	"crypto/tls"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTLSServer(t *testing.T) {
	// Default TLS test server with built-in certificate
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello tls"))
	}))
	defer srv.Close()

	// Use the server's own client, which trusts the test CA
	resp, err := srv.Client().Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "hello tls" {
		t.Errorf("unexpected body: %s", body)
	}
}

func TestMTLSServer(t *testing.T) {
	// Configure mTLS on the test server before Start
	srv := &httptest.Server{
		Listener: mustLocalListener(),
		Config: &http.Server{
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if len(r.TLS.PeerCertificates) == 0 {
					t.Error("expected client certificate")
					http.Error(w, "missing cert", http.StatusUnauthorized)
					return
				}
				w.Write([]byte("authenticated: " + r.TLS.PeerCertificates[0].Subject.CommonName))
			}),
		},
	}

	srv.TLS = &tls.Config{
		ClientAuth: tls.RequireAnyClientCert,
	}
	srv.StartTLS()
	defer srv.Close()

	// Use srv.Client() for a pre-configured client with the test CA
	client := srv.Client()
	// Add client cert to transport
	clientCert, _ := tls.LoadX509KeyPair("testdata/client.crt", "testdata/client.key")
	client.Transport.(*http.Transport).TLSClientConfig.Certificates = []tls.Certificate{clientCert}

	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	t.Logf("response: %s", body)
}
```

## Diagnosing TLS Errors

### Common error patterns

```bash
# TLS handshake timeout — usually a firewall or NAT issue
dial tcp 10.0.0.5:443: i/o timeout

# Certificate signed by unknown authority — missing CA in trust store
x509: certificate signed by unknown authority

# Certificate name mismatch — SAN does not include the target hostname
x509: certificate is valid for api-internal.example.com, not api.example.com

# TLS version mismatch — server requires 1.3, client maximum is 1.2
tls: no supported versions satisfy MinVersion and MaxVersion

# Client cert required but none provided
tls: failed to verify client certificate: tls: certificate required
```

### Go TLS debugging via environment variable

```bash
# Print every TLS handshake to stderr (Go 1.21+)
GODEBUG=tls13=1 ./myserver

# Full TLS debug via custom VerifyPeerCertificate
```

```go
package tlsdebug

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log"
)

// DebugTLSConfig wraps a *tls.Config to log handshake details.
func DebugTLSConfig(base *tls.Config) *tls.Config {
	cfg := base.Clone()
	cfg.VerifyPeerCertificate = func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
		for i, raw := range rawCerts {
			cert, err := x509.ParseCertificate(raw)
			if err != nil {
				return fmt.Errorf("parse cert[%d]: %w", i, err)
			}
			log.Printf("tls: peer cert[%d]: CN=%s, SANs=%v, expiry=%s",
				i, cert.Subject.CommonName, cert.DNSNames, cert.NotAfter)
		}
		return nil
	}
	return cfg
}
```

### Using openssl to diagnose from the command line

```bash
# Full TLS handshake details including cipher and certificate chain
openssl s_client -connect api.example.com:443 -showcerts -servername api.example.com

# Test with specific TLS version
openssl s_client -connect api.example.com:443 -tls1_3

# Test mTLS — present client certificate
openssl s_client -connect api.example.com:443 \
  -cert client.crt -key client.key \
  -CAfile ca.crt -verify_return_error

# Check OCSP staple
openssl s_client -connect api.example.com:443 -status

# Verify certificate expiry
openssl x509 -in server.crt -noout -dates
```

### Prometheus metrics for TLS events

```go
package tlsmetrics

import (
	"crypto/tls"
	"crypto/x509"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	certExpiry = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "tls_certificate_expiry_seconds",
		Help: "Unix timestamp when the TLS certificate expires.",
	}, []string{"host", "cn"})

	handshakeErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "tls_handshake_errors_total",
		Help: "Total number of TLS handshake errors.",
	}, []string{"host", "error"})
)

// TrackCertExpiry registers certificate expiry as a Prometheus gauge.
func TrackCertExpiry(host string, certs []*x509.Certificate) {
	for _, cert := range certs {
		certExpiry.WithLabelValues(host, cert.Subject.CommonName).
			Set(float64(cert.NotAfter.Unix()))
	}
}

// InstrumentedGetCertificate wraps GetCertificate to record expiry metrics.
func InstrumentedGetCertificate(inner func(*tls.ClientHelloInfo) (*tls.Certificate, error)) func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	return func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
		cert, err := inner(hello)
		if err != nil {
			return nil, err
		}
		if cert.Leaf != nil {
			certExpiry.WithLabelValues(hello.ServerName, cert.Leaf.Subject.CommonName).
				Set(float64(cert.Leaf.NotAfter.Unix()))
		}
		return cert, nil
	}
}
```

## Alerting on Certificate Expiry

### Kubernetes CronJob using certcheck

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cert-expiry-check
  namespace: monitoring
spec:
  schedule: "0 6 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: certcheck
            image: alpine/openssl:latest
            command:
            - sh
            - -c
            - |
              EXPIRY=$(echo | openssl s_client -connect api.example.com:443 \
                -servername api.example.com 2>/dev/null \
                | openssl x509 -noout -enddate \
                | cut -d= -f2)
              EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s)
              NOW=$(date +%s)
              DAYS=$(( (EXPIRY_EPOCH - NOW) / 86400 ))
              echo "Certificate expires in $DAYS days ($EXPIRY)"
              if [ "$DAYS" -lt 14 ]; then
                echo "CRITICAL: certificate expires in less than 14 days"
                exit 1
              fi
```

## Kubernetes Secret with cert-manager

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
  namespace: production
spec:
  secretName: api-tls-secret
  duration: 2160h   # 90 days
  renewBefore: 360h # Renew 15 days before expiry
  subject:
    organizations:
    - support.tools
  dnsNames:
  - api.example.com
  - api-internal.example.com
  issuerRef:
    name: letsencrypt-production
    kind: ClusterIssuer
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      volumes:
      - name: tls
        secret:
          secretName: api-tls-secret
      containers:
      - name: api
        image: registry.example.com/api-server:latest
        ports:
        - containerPort: 8443
        volumeMounts:
        - name: tls
          mountPath: /etc/tls
          readOnly: true
        env:
        - name: TLS_CERT_FILE
          value: /etc/tls/tls.crt
        - name: TLS_KEY_FILE
          value: /etc/tls/tls.key
```

## Summary

Effective TLS management in Go requires layering several techniques:

- Use `tls.Config.GetCertificate` for zero-downtime certificate rotation by polling the filesystem for changes.
- Automate Let's Encrypt with `autocert` and back the cache with Redis when running multiple replicas.
- Enforce mutual TLS by setting `ClientAuth: tls.RequireAndVerifyClientCert` and providing a `ClientCAs` pool.
- Implement certificate pinning through a custom `RoundTripper` that checks SPKI SHA-256 hashes.
- Use `VerifyPeerCertificate` hooks for debugging and custom validation logic.
- Export expiry timestamps as Prometheus gauges and alert before the 14-day renewal window.

The combination of hot rotation, OCSP stapling, and Prometheus alerting means certificate expiry should never cause a production outage.
