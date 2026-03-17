---
title: "Go TLS 1.3: Certificate Pinning, OCSP Stapling, and mTLS"
date: 2029-10-09T00:00:00-05:00
draft: false
tags: ["Go", "TLS", "Security", "mTLS", "Certificates", "PKI", "OCSP"]
categories:
- Go
- Security
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-focused guide to advanced Go TLS configuration including tls.Config options, certificate pinning with VerifyPeerCertificate, OCSP stapling, mutual TLS client authentication, and TLS session resumption."
more_link: "yes"
url: "/go-tls-13-certificate-pinning-ocsp-stapling-mtls-guide/"
---

The Go standard library's `crypto/tls` package is one of the most capable TLS implementations available. Most teams use it with default settings and miss the production-hardening options that separate a functional TLS implementation from a secure one. This guide covers the advanced `tls.Config` options that matter for production Go services: certificate pinning, OCSP stapling, mutual TLS, and session resumption.

<!--more-->

# Go TLS 1.3: Certificate Pinning, OCSP Stapling, and mTLS

## Section 1: tls.Config Deep Dive

The `tls.Config` struct is the central configuration point for all TLS behavior in Go. Understanding its fields is the foundation for every subsequent section.

```go
package main

import (
    "crypto/tls"
    "crypto/x509"
    "os"
)

func productionTLSConfig() *tls.Config {
    return &tls.Config{
        // TLS 1.3 minimum — TLS 1.2 is acceptable but TLS 1.0/1.1 must be rejected
        MinVersion: tls.VersionTLS12,
        MaxVersion: tls.VersionTLS13,

        // Restrict to strong cipher suites for TLS 1.2
        // (TLS 1.3 cipher suites are fixed and not configurable)
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        },

        // Prefer server cipher order (defense against downgrade)
        PreferServerCipherSuites: true,

        // Supported curves — only P-256 and X25519 for strong ECDHE
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
        },

        // Session cache for TLS resumption (server side)
        SessionTicketsDisabled: false,
        ClientSessionCache:     tls.NewLRUClientSessionCache(256),
    }
}
```

### Loading Certificates

```go
// LoadCertificate loads a certificate and key from PEM files.
func LoadCertificate(certFile, keyFile string) (tls.Certificate, error) {
    certPEM, err := os.ReadFile(certFile)
    if err != nil {
        return tls.Certificate{}, fmt.Errorf("reading cert file: %w", err)
    }
    keyPEM, err := os.ReadFile(keyFile)
    if err != nil {
        return tls.Certificate{}, fmt.Errorf("reading key file: %w", err)
    }
    return tls.X509KeyPair(certPEM, keyPEM)
}

// LoadCertPool builds a CA pool from a PEM bundle file.
func LoadCertPool(caFile string) (*x509.CertPool, error) {
    caPEM, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("reading CA file: %w", err)
    }
    pool := x509.NewCertPool()
    if !pool.AppendCertsFromPEM(caPEM) {
        return nil, fmt.Errorf("no valid certificates found in %s", caFile)
    }
    return pool, nil
}
```

### Building a Production HTTPS Server

```go
package server

import (
    "context"
    "crypto/tls"
    "net/http"
    "time"
)

func NewHTTPSServer(addr string, handler http.Handler, cfg *tls.Config) *http.Server {
    return &http.Server{
        Addr:      addr,
        Handler:   handler,
        TLSConfig: cfg,

        // Timeouts prevent Slowloris attacks
        ReadTimeout:       15 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,
        WriteTimeout:      30 * time.Second,
        IdleTimeout:       120 * time.Second,
    }
}
```

## Section 2: Certificate Pinning

Certificate pinning ensures that a client only trusts specific certificates or public keys, even if a rogue CA issues a valid certificate for your hostname. This is critical for internal service-to-service communication where you control both ends.

### SPKI Pin (Public Key Hash)

The Subject Public Key Info (SPKI) hash approach pins the public key rather than the full certificate. This allows certificate renewal without updating pins (as long as the key pair is reused).

```go
package tlspin

import (
    "crypto/sha256"
    "crypto/tls"
    "crypto/x509"
    "encoding/base64"
    "encoding/pem"
    "fmt"
    "os"
)

// SPKIPin represents a pinned SPKI hash.
type SPKIPin string

// ComputeSPKIPin computes the base64-encoded SHA-256 hash of a certificate's
// Subject Public Key Info — the same format as HTTP Public-Key-Pins header.
func ComputeSPKIPin(cert *x509.Certificate) SPKIPin {
    h := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
    return SPKIPin(base64.StdEncoding.EncodeToString(h[:]))
}

// ComputeSPKIPinFromFile computes the SPKI pin for a PEM-encoded certificate file.
func ComputeSPKIPinFromFile(path string) (SPKIPin, error) {
    pemData, err := os.ReadFile(path)
    if err != nil {
        return "", err
    }
    block, _ := pem.Decode(pemData)
    if block == nil {
        return "", fmt.Errorf("no PEM block found in %s", path)
    }
    cert, err := x509.ParseCertificate(block.Bytes)
    if err != nil {
        return "", err
    }
    return ComputeSPKIPin(cert), nil
}

// PinVerifier returns a tls.Config.VerifyPeerCertificate function that checks
// that at least one certificate in the chain matches one of the provided pins.
func PinVerifier(pins []SPKIPin) func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
    pinSet := make(map[SPKIPin]struct{}, len(pins))
    for _, p := range pins {
        pinSet[p] = struct{}{}
    }

    return func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
        // Prefer verified chains (post-verification); fall back to raw certs
        chains := verifiedChains
        if len(chains) == 0 {
            // Parse raw certs manually when InsecureSkipVerify is set
            for _, rawCert := range rawCerts {
                cert, err := x509.ParseCertificate(rawCert)
                if err != nil {
                    return fmt.Errorf("parsing certificate: %w", err)
                }
                chains = append(chains, []*x509.Certificate{cert})
            }
        }

        for _, chain := range chains {
            for _, cert := range chain {
                pin := ComputeSPKIPin(cert)
                if _, ok := pinSet[pin]; ok {
                    return nil // Found a matching pin
                }
            }
        }

        return fmt.Errorf("certificate pinning failed: no certificate in chain matched known pins")
    }
}
```

### Using the Pin Verifier

```go
func NewPinnedTLSConfig(caPool *x509.CertPool, pins []SPKIPin) *tls.Config {
    return &tls.Config{
        RootCAs:    caPool,
        MinVersion: tls.VersionTLS13,

        // Standard verification still runs; VerifyPeerCertificate is called after
        VerifyPeerCertificate: PinVerifier(pins),
    }
}

// Example: initialize pinned client
func NewPinnedClient() (*http.Client, error) {
    caPool, err := LoadCertPool("/etc/ssl/certs/internal-ca.pem")
    if err != nil {
        return nil, err
    }

    // Pre-compute pins from known good certificates
    // Run ComputeSPKIPinFromFile("/path/to/server.crt") offline
    pins := []SPKIPin{
        "sha256//YLh1dUR9y6Kja30RrAn7JKnbQG/uEtLMkBgFF2Fuihg=",
        "sha256//b62tyFmQFCxzL46l2rMSfS4LkMi1EjJC5waTqMfj9/o=", // backup key
    }

    cfg := NewPinnedTLSConfig(caPool, pins)

    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: cfg,
        },
        Timeout: 30 * time.Second,
    }, nil
}
```

### Certificate Hash Pinning (Full Certificate)

For highest security (at the cost of requiring pin updates on every renewal):

```go
func CertHashVerifier(pins []string) func([][]byte, [][]*x509.Certificate) error {
    pinSet := make(map[string]struct{})
    for _, p := range pins {
        pinSet[p] = struct{}{}
    }

    return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
        for _, rawCert := range rawCerts {
            h := sha256.Sum256(rawCert)
            pin := base64.StdEncoding.EncodeToString(h[:])
            if _, ok := pinSet[pin]; ok {
                return nil
            }
        }
        return fmt.Errorf("no certificate matched pinned hashes")
    }
}
```

## Section 3: OCSP Stapling

OCSP (Online Certificate Status Protocol) allows clients to verify certificate revocation status. Standard OCSP requires the client to make an HTTP request to the CA's OCSP responder for every TLS handshake, adding latency and creating a privacy concern. OCSP stapling moves this to the server: the server fetches the OCSP response periodically and "staples" it to the TLS handshake.

### Server-Side OCSP Stapling

Go's TLS server does not automatically staple OCSP responses. You must manage this manually via `tls.Certificate.OCSPStaple`.

```go
package ocsp

import (
    "crypto/tls"
    "crypto/x509"
    "encoding/pem"
    "fmt"
    "io"
    "net/http"
    "os"
    "sync"
    "time"

    "golang.org/x/crypto/ocsp"
)

// OCSPManager fetches and caches OCSP responses for a certificate.
type OCSPManager struct {
    mu           sync.RWMutex
    cert         *tls.Certificate
    parsedCert   *x509.Certificate
    issuerCert   *x509.Certificate
    staple       []byte
    stapleExpiry time.Time

    httpClient *http.Client
}

// NewOCSPManager creates an OCSP manager for the given certificate and issuer.
func NewOCSPManager(certFile, keyFile, issuerFile string) (*OCSPManager, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading certificate: %w", err)
    }

    // Parse the leaf certificate
    leaf, err := x509.ParseCertificate(cert.Certificate[0])
    if err != nil {
        return nil, fmt.Errorf("parsing leaf certificate: %w", err)
    }
    cert.Leaf = leaf

    // Load issuer certificate
    issuerPEM, err := os.ReadFile(issuerFile)
    if err != nil {
        return nil, fmt.Errorf("reading issuer cert: %w", err)
    }
    block, _ := pem.Decode(issuerPEM)
    issuer, err := x509.ParseCertificate(block.Bytes)
    if err != nil {
        return nil, fmt.Errorf("parsing issuer cert: %w", err)
    }

    m := &OCSPManager{
        cert:       &cert,
        parsedCert: leaf,
        issuerCert: issuer,
        httpClient: &http.Client{Timeout: 10 * time.Second},
    }

    // Fetch initial OCSP response
    if err := m.refresh(); err != nil {
        return nil, fmt.Errorf("initial OCSP fetch: %w", err)
    }

    return m, nil
}

// refresh fetches a fresh OCSP response from the CA's responder.
func (m *OCSPManager) refresh() error {
    if len(m.parsedCert.OCSPServer) == 0 {
        return fmt.Errorf("certificate has no OCSP server URL")
    }

    ocspURL := m.parsedCert.OCSPServer[0]

    // Build OCSP request
    reqBytes, err := ocsp.CreateRequest(m.parsedCert, m.issuerCert, &ocsp.RequestOptions{
        Hash: crypto.SHA1,
    })
    if err != nil {
        return fmt.Errorf("creating OCSP request: %w", err)
    }

    // Send to OCSP responder
    resp, err := m.httpClient.Post(
        ocspURL,
        "application/ocsp-request",
        bytes.NewReader(reqBytes),
    )
    if err != nil {
        return fmt.Errorf("fetching OCSP response: %w", err)
    }
    defer resp.Body.Close()

    respBytes, err := io.ReadAll(resp.Body)
    if err != nil {
        return fmt.Errorf("reading OCSP response: %w", err)
    }

    // Parse and verify the OCSP response
    ocspResp, err := ocsp.ParseResponse(respBytes, m.issuerCert)
    if err != nil {
        return fmt.Errorf("parsing OCSP response: %w", err)
    }

    if ocspResp.Status == ocsp.Revoked {
        return fmt.Errorf("certificate is REVOKED: reason=%d, at=%v",
            ocspResp.RevocationReason, ocspResp.RevokedAt)
    }

    m.mu.Lock()
    m.staple = respBytes
    m.stapleExpiry = ocspResp.NextUpdate
    m.cert.OCSPStaple = respBytes
    m.mu.Unlock()

    return nil
}

// GetCertificate returns a GetCertificate function for tls.Config.
func (m *OCSPManager) GetCertificate(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()
    return m.cert, nil
}

// StartRefreshLoop starts a goroutine that refreshes the OCSP staple before expiry.
func (m *OCSPManager) StartRefreshLoop(ctx context.Context) {
    go func() {
        for {
            m.mu.RLock()
            expiry := m.stapleExpiry
            m.mu.RUnlock()

            // Refresh at 50% of the validity window
            nextRefresh := time.Until(expiry) / 2
            if nextRefresh < 1*time.Minute {
                nextRefresh = 1 * time.Minute
            }

            select {
            case <-ctx.Done():
                return
            case <-time.After(nextRefresh):
                if err := m.refresh(); err != nil {
                    // Log but don't stop — the existing staple may still be valid
                    log.Printf("OCSP staple refresh failed: %v", err)
                }
            }
        }
    }()
}
```

### Using OCSP Stapling in a Server

```go
func NewOCSPStapledServer(ctx context.Context, addr string, handler http.Handler) (*http.Server, error) {
    manager, err := NewOCSPManager(
        "/etc/ssl/certs/server.crt",
        "/etc/ssl/private/server.key",
        "/etc/ssl/certs/issuer.crt",
    )
    if err != nil {
        return nil, err
    }

    manager.StartRefreshLoop(ctx)

    cfg := &tls.Config{
        MinVersion:     tls.VersionTLS12,
        GetCertificate: manager.GetCertificate,
    }

    return &http.Server{
        Addr:      addr,
        Handler:   handler,
        TLSConfig: cfg,
    }, nil
}
```

## Section 4: Mutual TLS (mTLS)

mTLS requires both server and client to present valid certificates. This is the gold standard for service-to-service authentication in internal microservice architectures.

### Server Configuration

```go
package mtls

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "net/http"
)

// NewMTLSServer creates an HTTPS server that requires client certificate auth.
func NewMTLSServer(addr string, handler http.Handler, cfg ServerConfig) (*http.Server, error) {
    // Load server certificate
    cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
    if err != nil {
        return nil, fmt.Errorf("loading server certificate: %w", err)
    }

    // Load CA pool for client verification
    clientCAPool, err := LoadCertPool(cfg.ClientCAFile)
    if err != nil {
        return nil, fmt.Errorf("loading client CA: %w", err)
    }

    tlsCfg := &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    clientCAPool,

        // RequireAndVerifyClientCert enforces mTLS — rejects handshake if
        // client does not present a valid certificate signed by ClientCAs.
        ClientAuth: tls.RequireAndVerifyClientCert,

        MinVersion: tls.VersionTLS13,
    }

    return &http.Server{
        Addr:      addr,
        Handler:   mtlsMiddleware(handler),
        TLSConfig: tlsCfg,
    }, nil
}

// mtlsMiddleware extracts the verified client certificate and stores it in context.
func mtlsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
            http.Error(w, "client certificate required", http.StatusUnauthorized)
            return
        }

        // The first certificate is the leaf (client's own cert)
        clientCert := r.TLS.PeerCertificates[0]

        // Extract subject information for authorization
        subject := clientCert.Subject
        ctx := context.WithValue(r.Context(), clientCertKey{}, ClientIdentity{
            CommonName:   subject.CommonName,
            Organization: subject.Organization,
            SerialNumber: clientCert.SerialNumber.String(),
        })

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

type clientCertKey struct{}

// ClientIdentity holds the extracted mTLS client identity.
type ClientIdentity struct {
    CommonName   string
    Organization []string
    SerialNumber string
}

// ClientIdentityFromContext retrieves the mTLS client identity from context.
func ClientIdentityFromContext(ctx context.Context) (ClientIdentity, bool) {
    id, ok := ctx.Value(clientCertKey{}).(ClientIdentity)
    return id, ok
}
```

### Client Configuration

```go
// NewMTLSClient creates an HTTP client that presents a client certificate.
func NewMTLSClient(cfg ClientConfig) (*http.Client, error) {
    // Load client certificate
    clientCert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
    if err != nil {
        return nil, fmt.Errorf("loading client certificate: %w", err)
    }

    // Load server CA pool
    serverCAPool, err := LoadCertPool(cfg.ServerCAFile)
    if err != nil {
        return nil, fmt.Errorf("loading server CA: %w", err)
    }

    tlsCfg := &tls.Config{
        Certificates: []tls.Certificate{clientCert},
        RootCAs:      serverCAPool,
        MinVersion:   tls.VersionTLS13,

        // Optional: add certificate pinning on top of mTLS
        VerifyPeerCertificate: PinVerifier(cfg.ServerPins),
    }

    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig:     tlsCfg,
            MaxIdleConns:        100,
            MaxIdleConnsPerHost: 10,
            IdleConnTimeout:     90 * time.Second,
        },
        Timeout: 30 * time.Second,
    }, nil
}
```

### Certificate-Based Authorization

Once you have the client's identity from mTLS, implement authorization:

```go
// AuthorizeServiceAccess verifies that the client CN is authorized for the requested resource.
func AuthorizeServiceAccess(clientID ClientIdentity, resource, method string) error {
    // Example: only "payment-service" CN can access /api/payments
    type rule struct {
        allowedCN string
        path      string
        method    string
    }

    rules := []rule{
        {"payment-service", "/api/payments", "POST"},
        {"reporting-service", "/api/payments", "GET"},
        {"admin-service", "/api/payments", ""},    // any method
    }

    for _, r := range rules {
        if r.allowedCN == clientID.CommonName &&
            strings.HasPrefix(resource, r.path) &&
            (r.method == "" || r.method == method) {
            return nil
        }
    }

    return fmt.Errorf("service %q is not authorized for %s %s",
        clientID.CommonName, method, resource)
}
```

## Section 5: TLS Session Resumption

Session resumption avoids the full TLS handshake for reconnecting clients, reducing latency by eliminating one round trip.

### TLS Session Tickets (Server Side)

```go
import (
    "crypto/rand"
    "sync"
)

// SessionTicketManager rotates session ticket keys periodically.
type SessionTicketManager struct {
    mu   sync.RWMutex
    keys [3][32]byte // 3 keys: current, previous, older
}

func NewSessionTicketManager() (*SessionTicketManager, error) {
    m := &SessionTicketManager{}
    if err := m.rotateKeys(); err != nil {
        return nil, err
    }
    return m, nil
}

func (m *SessionTicketManager) rotateKeys() error {
    m.mu.Lock()
    defer m.mu.Unlock()
    // Shift keys: older = previous, previous = current, generate new current
    m.keys[2] = m.keys[1]
    m.keys[1] = m.keys[0]
    if _, err := rand.Read(m.keys[0][:]); err != nil {
        return fmt.Errorf("generating session ticket key: %w", err)
    }
    return nil
}

func (m *SessionTicketManager) GetKeys() [][32]byte {
    m.mu.RLock()
    defer m.mu.RUnlock()
    return []([32]byte){m.keys[0], m.keys[1], m.keys[2]}
}

func (m *SessionTicketManager) StartRotation(ctx context.Context, interval time.Duration) {
    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                if err := m.rotateKeys(); err != nil {
                    log.Printf("session ticket key rotation failed: %v", err)
                }
            }
        }
    }()
}

// ApplyToConfig sets the current session ticket keys on a TLS config.
func (m *SessionTicketManager) ApplyToConfig(cfg *tls.Config) {
    keys := m.GetKeys()
    cfg.SetSessionTicketKeys(keys)
}
```

### TLS 1.3 Session Resumption

TLS 1.3 uses PSK (Pre-Shared Keys) for resumption instead of session tickets. Go handles this automatically when `SessionTicketsDisabled` is false. For clients:

```go
// Client-side session cache for TLS 1.3 resumption
tlsCfg := &tls.Config{
    MinVersion: tls.VersionTLS13,

    // LRU cache holding session states for resumption
    // Size should match typical concurrent destination count
    ClientSessionCache: tls.NewLRUClientSessionCache(256),
}
```

### Measuring Session Resumption Rate

```go
// TLSMetrics tracks TLS handshake statistics.
type TLSMetrics struct {
    newSessions      prometheus.Counter
    resumedSessions  prometheus.Counter
    handshakeErrors  prometheus.Counter
}

func (m *TLSMetrics) WrapConn(conn net.Conn) net.Conn {
    return &tlsTrackingConn{
        Conn:    conn,
        metrics: m,
    }
}

type tlsTrackingConn struct {
    net.Conn
    metrics  *TLSMetrics
    tracked  bool
}

func (c *tlsTrackingConn) HandshakeComplete(state tls.ConnectionState) {
    if c.tracked {
        return
    }
    c.tracked = true
    if state.DidResume {
        c.metrics.resumedSessions.Inc()
    } else {
        c.metrics.newSessions.Inc()
    }
}
```

## Section 6: VerifyConnection Hook

Go 1.15 added `tls.Config.VerifyConnection`, which is called after the handshake completes with full connection state. This is more powerful than `VerifyPeerCertificate` because it has access to the negotiated protocol version, cipher suite, and OCSP response:

```go
func strictVerifyConnection(cs tls.ConnectionState) error {
    // Reject TLS 1.2 if TLS 1.3 is expected
    if cs.Version < tls.VersionTLS13 {
        return fmt.Errorf("TLS 1.3 required, got version 0x%04x", cs.Version)
    }

    // Verify OCSP staple if present
    if len(cs.OCSPResponse) > 0 {
        leaf := cs.PeerCertificates[0]
        issuer := cs.PeerCertificates[1]
        resp, err := ocsp.ParseResponse(cs.OCSPResponse, issuer)
        if err != nil {
            return fmt.Errorf("parsing OCSP staple: %w", err)
        }
        if resp.Status == ocsp.Revoked {
            return fmt.Errorf("peer certificate is revoked")
        }
        if time.Now().After(resp.NextUpdate) {
            return fmt.Errorf("OCSP staple is stale (expired %v)", resp.NextUpdate)
        }
    }

    // Verify expected ALPN protocol
    if cs.NegotiatedProtocol != "h2" && cs.NegotiatedProtocol != "http/1.1" {
        return fmt.Errorf("unexpected ALPN protocol: %q", cs.NegotiatedProtocol)
    }

    return nil
}

// Usage:
cfg := &tls.Config{
    MinVersion:        tls.VersionTLS13,
    VerifyConnection:  strictVerifyConnection,
}
```

## Section 7: Production Checklist

### Server Hardening

```go
func HardenedServerTLSConfig(cert tls.Certificate, clientCAs *x509.CertPool) *tls.Config {
    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    clientCAs,
        ClientAuth:   tls.RequireAndVerifyClientCert,

        // TLS 1.3 only for maximum security
        MinVersion: tls.VersionTLS13,

        // Disable renegotiation (TLS 1.3 removes it; explicit for 1.2)
        Renegotiation: tls.RenegotiateNever,

        // Require SNI for virtual hosting
        VerifyConnection: func(cs tls.ConnectionState) error {
            if cs.ServerName == "" {
                return fmt.Errorf("SNI extension required")
            }
            return nil
        },
    }
}
```

### Security Headers Complement

TLS configuration should be paired with appropriate HTTP security headers:

```go
func securityHeadersMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // HSTS: tell browsers to only use HTTPS for 1 year
        w.Header().Set("Strict-Transport-Security",
            "max-age=31536000; includeSubDomains; preload")
        // Prevent content type sniffing
        w.Header().Set("X-Content-Type-Options", "nosniff")
        // Frame protection
        w.Header().Set("X-Frame-Options", "DENY")
        next.ServeHTTP(w, r)
    })
}
```

### Testing TLS Configuration

```bash
# Test with openssl
openssl s_client -connect myservice:443 -tls1_3 -showcerts

# Test mTLS
openssl s_client -connect myservice:443 \
  -cert client.crt \
  -key client.key \
  -CAfile ca.crt \
  -tls1_3

# Test with testssl.sh for comprehensive audit
testssl.sh --full myservice:443

# Go test for TLS configuration
```

```go
func TestMTLSHandshake(t *testing.T) {
    // Start test server with mTLS
    serverCert, _ := tls.LoadX509KeyPair("testdata/server.crt", "testdata/server.key")
    clientCA, _ := LoadCertPool("testdata/ca.crt")

    serverCfg := &tls.Config{
        Certificates: []tls.Certificate{serverCert},
        ClientCAs:    clientCA,
        ClientAuth:   tls.RequireAndVerifyClientCert,
        MinVersion:   tls.VersionTLS13,
    }

    listener, err := tls.Listen("tcp", "127.0.0.1:0", serverCfg)
    require.NoError(t, err)
    defer listener.Close()

    // Start server goroutine
    go func() {
        conn, err := listener.Accept()
        if err != nil {
            return
        }
        defer conn.Close()
        tlsConn := conn.(*tls.Conn)
        require.NoError(t, tlsConn.Handshake())
        tlsConn.Write([]byte("OK"))
    }()

    // Connect as mTLS client
    clientCert, _ := tls.LoadX509KeyPair("testdata/client.crt", "testdata/client.key")
    serverCA, _ := LoadCertPool("testdata/ca.crt")

    clientCfg := &tls.Config{
        Certificates: []tls.Certificate{clientCert},
        RootCAs:      serverCA,
        ServerName:   "test-server",
        MinVersion:   tls.VersionTLS13,
    }

    conn, err := tls.Dial("tcp", listener.Addr().String(), clientCfg)
    require.NoError(t, err)
    defer conn.Close()

    // Verify TLS 1.3 was negotiated
    assert.Equal(t, uint16(tls.VersionTLS13), conn.ConnectionState().Version)
    assert.True(t, conn.ConnectionState().HandshakeComplete)
}
```

## Conclusion

Go's `crypto/tls` package provides all the primitives needed for production-hardened TLS: certificate pinning via `VerifyPeerCertificate`, OCSP stapling via `OCSPStaple` management, mutual TLS through `ClientAuth` and `Certificates`, and session resumption via session ticket keys and client caches. Combining these with strict cipher suites, TLS 1.3 minimum, and the `VerifyConnection` hook gives you a TLS implementation that meets the requirements of the most security-conscious enterprise environments.
