---
title: "Go TLS Configuration: Certificate Pinning, ALPN, and Mutual TLS in Production"
date: 2031-02-16T00:00:00-05:00
draft: false
tags: ["Go", "TLS", "Security", "mTLS", "ALPN", "Certificates", "Production"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Go TLS configuration covering tls.Config hardening options, certificate pinning implementation, ALPN protocol negotiation, mutual TLS client certificate verification, dynamic certificate loading, and TLS session ticket rotation."
more_link: "yes"
url: "/go-tls-configuration-certificate-pinning-alpn-mutual-tls-production/"
---

TLS configuration is one of the most security-critical aspects of any production Go service. Default TLS settings are designed for broad compatibility, not maximum security. This guide covers every production-relevant aspect of Go's TLS stack: from cipher suite selection and certificate pinning through mutual TLS client authentication and dynamic certificate rotation.

<!--more-->

# Go TLS Configuration: Certificate Pinning, ALPN, and Mutual TLS in Production

## The Default TLS Configuration Problem

Go's default `tls.Config` is designed for compatibility with a wide range of clients. For production internal services, many of these defaults are too permissive. Here is what the defaults allow that you probably do not want:

- TLS 1.0 and 1.1 (deprecated, known vulnerabilities)
- Weak cipher suites (RC4, 3DES in older Go versions)
- No client certificate verification (anyone can connect)
- No certificate pinning (MITM possible with a compromised CA)
- No ALPN enforcement (any protocol can be negotiated)

This guide replaces those defaults with production-hardened configurations.

## Section 1: Hardening tls.Config for Production

### Server TLS Configuration

```go
package tlsconfig

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "os"
    "time"
)

// ServerConfig builds a production-hardened TLS configuration for servers.
func ServerConfig(certFile, keyFile string) (*tls.Config, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading key pair: %w", err)
    }

    cfg := &tls.Config{
        // Certificates: the server's identity
        Certificates: []tls.Certificate{cert},

        // Minimum TLS version: TLS 1.2 is the minimum acceptable.
        // Set to tls.VersionTLS13 if all clients support it (preferred).
        MinVersion: tls.VersionTLS12,
        MaxVersion: 0, // 0 = no maximum (allow TLS 1.3)

        // Cipher suites for TLS 1.2 only (TLS 1.3 suites are not configurable).
        // These are ECDHE-only suites providing perfect forward secrecy.
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
        },

        // Curve preferences: only modern curves
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
            tls.CurveP384,
        },

        // Prefer server cipher suite order for consistency
        PreferServerCipherSuites: true,

        // Session tickets: enabled by default in Go.
        // Session tickets allow session resumption (0-RTT in TLS 1.3).
        // For forward secrecy, rotate session ticket keys periodically.
        SessionTicketsDisabled: false,

        // ALPN protocol negotiation — list supported protocols in preference order
        NextProtos: []string{"h2", "http/1.1"},

        // Renegotiation: disable completely
        // TLS renegotiation has a history of vulnerabilities (e.g., CRIME)
        Renegotiation: tls.RenegotiateNever,
    }

    return cfg, nil
}

// ClientConfig builds a production-hardened TLS configuration for clients.
func ClientConfig(serverName string, caCertFile string) (*tls.Config, error) {
    caCert, err := os.ReadFile(caCertFile)
    if err != nil {
        return nil, fmt.Errorf("reading CA cert: %w", err)
    }

    caPool := x509.NewCertPool()
    if !caPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("parsing CA certificate")
    }

    return &tls.Config{
        ServerName:   serverName,
        RootCAs:      caPool,
        MinVersion:   tls.VersionTLS12,
        CipherSuites: productionCipherSuites(),
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
        },
        // Never skip verification
        InsecureSkipVerify: false,
    }, nil
}

func productionCipherSuites() []uint16 {
    return []uint16{
        tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
        tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
        tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
        tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
        tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
    }
}
```

### Verifying TLS Configuration

```bash
# Test your server's TLS configuration
# Using testssl.sh for comprehensive analysis
docker run --rm -ti drwetter/testssl.sh https://your-server.example.com:8443

# Using openssl for quick checks
openssl s_client -connect your-server.example.com:8443 \
    -tls1_2 \
    -cipher "ECDHE-RSA-AES256-GCM-SHA384" \
    </dev/null 2>&1 | grep "Cipher is"

# Test TLS 1.1 is rejected (should fail)
openssl s_client -connect your-server.example.com:8443 -tls1_1 </dev/null 2>&1
# Should output: no protocols available

# Check certificate details
openssl s_client -connect your-server.example.com:8443 </dev/null 2>&1 | \
    openssl x509 -noout -text | grep -E "Subject:|Issuer:|Not After"
```

## Section 2: Certificate Pinning

### Why Certificate Pinning?

Certificate pinning ensures that a client only accepts a specific certificate or public key, regardless of what CAs have issued. It prevents man-in-the-middle attacks even if a CA is compromised or if a rogue CA issues a certificate for your domain.

Certificate pinning is most appropriate for:
- Internal service-to-service communication with known certificates
- Mobile applications communicating with their backend
- Security-critical APIs where MITM risk is high

It is less appropriate for:
- Public-facing websites where certificate rotation must be transparent to users
- Services using certificates from many different CAs

### Public Key Pinning

Pinning to the public key (rather than the full certificate) survives certificate renewals, as long as the same key pair is used:

```go
package pinning

import (
    "crypto/sha256"
    "crypto/tls"
    "crypto/x509"
    "encoding/base64"
    "fmt"
    "net/http"
)

// PinnedCertConfig creates a TLS config that pins to specific certificate public keys.
// pins should be the base64-encoded SHA256 hash of the SubjectPublicKeyInfo (SPKI).
func PinnedCertConfig(serverName string, pins []string) *tls.Config {
    // Convert string pins to byte slice set for fast lookup
    pinSet := make(map[string]struct{}, len(pins))
    for _, p := range pins {
        pinSet[p] = struct{}{}
    }

    return &tls.Config{
        ServerName: serverName,
        MinVersion: tls.VersionTLS12,

        // VerifyPeerCertificate is called after standard certificate verification.
        // We use it to add our pin check on top of normal validation.
        VerifyPeerCertificate: func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
            if len(verifiedChains) == 0 {
                return fmt.Errorf("no verified chains — TLS verification must succeed before pinning")
            }

            // Check pins against all certificates in the verified chain
            for _, chain := range verifiedChains {
                for _, cert := range chain {
                    pin := computeSPKIPin(cert)
                    if _, ok := pinSet[pin]; ok {
                        return nil // Pin matched
                    }
                }
            }

            return fmt.Errorf("certificate pin mismatch: none of the certificates match expected pins")
        },
    }
}

// computeSPKIPin computes the SHA256 hash of the certificate's SubjectPublicKeyInfo
// and returns it as a base64-encoded string.
// This is the same format used by HTTP Public Key Pinning (HPKP).
func computeSPKIPin(cert *x509.Certificate) string {
    spkiHash := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
    return base64.StdEncoding.EncodeToString(spkiHash[:])
}

// GetPinForCertFile computes the pin for a certificate file.
// Use this to compute pins for configuration.
func GetPinForCertFile(certFile string) (string, error) {
    certPEM, err := os.ReadFile(certFile)
    if err != nil {
        return "", err
    }

    block, _ := pem.Decode(certPEM)
    if block == nil {
        return "", fmt.Errorf("failed to decode PEM block")
    }

    cert, err := x509.ParseCertificate(block.Bytes)
    if err != nil {
        return "", fmt.Errorf("parsing certificate: %w", err)
    }

    return computeSPKIPin(cert), nil
}
```

### Using Certificate Pinning in HTTP Clients

```go
package main

import (
    "fmt"
    "io"
    "net/http"
)

func main() {
    // The pin for the server's certificate
    // Obtain this by running: GetPinForCertFile("server.crt")
    // Or: openssl x509 -in server.crt -pubkey -noout |
    //     openssl pkey -pubin -outform der |
    //     openssl dgst -sha256 -binary | base64
    serverPin := "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="  // Base64 SHA256 SPKI

    tlsConfig := PinnedCertConfig("api.internal.example.com", []string{serverPin})

    transport := &http.Transport{
        TLSClientConfig: tlsConfig,
    }

    client := &http.Client{
        Transport: transport,
    }

    resp, err := client.Get("https://api.internal.example.com/health")
    if err != nil {
        // This will fail if the pin doesn't match, even with a valid cert
        fmt.Printf("Request failed: %v\n", err)
        return
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Printf("Status: %s, Body: %s\n", resp.Status, body)
}
```

### Certificate Pinning with Backup Pins

To enable certificate rotation without downtime, always pin both the current and the next certificate:

```go
// PinnedClientWithRotation demonstrates pinning with rotation support.
// Include both the current certificate pin and the backup certificate pin.
func PinnedClientWithRotation(serverName string) *http.Client {
    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: PinnedCertConfig(serverName, []string{
                // Current certificate pin
                "currentPinBase64AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII0000=",
                // Backup certificate pin (for the next certificate to be deployed)
                "backupPinBase64AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII0000=",
            }),
        },
    }
}

// Certificate rotation procedure:
// 1. Generate a new key pair
// 2. Add the new certificate's pin to the backup pin list
// 3. Deploy the backup pin to all clients (no restart needed if using dynamic config)
// 4. Issue the new certificate using the new key pair
// 5. Deploy the new certificate to the server
// 6. Remove the old pin from the client configuration
```

## Section 3: ALPN Protocol Negotiation

### Understanding ALPN

ALPN (Application-Layer Protocol Negotiation) is a TLS extension that allows the client and server to agree on which application protocol to use during the TLS handshake, before any application data is sent. This enables a single port to serve multiple protocols.

```go
package alpn

import (
    "crypto/tls"
    "fmt"
    "net"
    "net/http"
    "time"

    "golang.org/x/net/http2"
)

const (
    ProtoHTTP2   = "h2"
    ProtoHTTP11  = "http/1.1"
    ProtoGRPC    = "grpc-exp"
    ProtoH2Prior = "h2c"  // HTTP/2 cleartext (not actually an ALPN proto)
)

// MultiProtocolServer serves different handlers based on the negotiated ALPN protocol.
type MultiProtocolServer struct {
    httpHandler  http.Handler
    grpcHandler  http.Handler
    tlsConfig    *tls.Config
}

func NewMultiProtocolServer(httpH, grpcH http.Handler, certFile, keyFile string) (*MultiProtocolServer, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, err
    }

    srv := &MultiProtocolServer{
        httpHandler: httpH,
        grpcHandler: grpcH,
    }

    srv.tlsConfig = &tls.Config{
        Certificates: []tls.Certificate{cert},
        MinVersion:   tls.VersionTLS12,
        // Advertise both h2 and grpc-exp
        NextProtos: []string{ProtoHTTP2, ProtoGRPC, ProtoHTTP11},
    }

    return srv, nil
}

func (s *MultiProtocolServer) ListenAndServe(addr string) error {
    listener, err := tls.Listen("tcp", addr, s.tlsConfig)
    if err != nil {
        return err
    }
    defer listener.Close()

    for {
        conn, err := listener.Accept()
        if err != nil {
            return err
        }
        go s.handleConn(conn)
    }
}

func (s *MultiProtocolServer) handleConn(conn net.Conn) {
    defer conn.Close()

    tlsConn, ok := conn.(*tls.Conn)
    if !ok {
        return
    }

    // Complete the TLS handshake to know which protocol was negotiated
    if err := tlsConn.Handshake(); err != nil {
        return
    }

    // Route to the appropriate handler based on negotiated protocol
    negotiated := tlsConn.ConnectionState().NegotiatedProtocol
    switch negotiated {
    case ProtoGRPC:
        // Use gRPC handler
        s.serveGRPC(tlsConn)
    case ProtoHTTP2, ProtoHTTP11, "":
        // Use HTTP handler (empty string means no ALPN negotiated — default to HTTP)
        s.serveHTTP(tlsConn)
    default:
        fmt.Printf("unknown protocol negotiated: %s\n", negotiated)
    }
}
```

### Inspecting ALPN Negotiation

```go
// ALPNInspector wraps a TLS listener and logs negotiated protocols
type ALPNInspector struct {
    net.Listener
}

func (a *ALPNInspector) Accept() (net.Conn, error) {
    conn, err := a.Listener.Accept()
    if err != nil {
        return nil, err
    }

    return &ALPNLoggingConn{Conn: conn}, nil
}

type ALPNLoggingConn struct {
    net.Conn
    logged bool
}

func (c *ALPNLoggingConn) Read(b []byte) (int, error) {
    if !c.logged {
        if tlsConn, ok := c.Conn.(*tls.Conn); ok {
            state := tlsConn.ConnectionState()
            if state.HandshakeComplete {
                fmt.Printf("TLS connection: version=%s proto=%s cipher=%s\n",
                    tls.VersionName(state.Version),
                    state.NegotiatedProtocol,
                    tls.CipherSuiteName(state.CipherSuite),
                )
                c.logged = true
            }
        }
    }
    return c.Conn.Read(b)
}
```

## Section 4: Mutual TLS (mTLS)

### mTLS Architecture

Mutual TLS extends standard TLS by requiring the client to also present a certificate. The server verifies the client's certificate against a trusted CA. This enables cryptographically verified service-to-service authentication.

```go
package mtls

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "net/http"
    "os"
)

// MTLSServerConfig creates a TLS configuration requiring client certificates.
func MTLSServerConfig(certFile, keyFile, clientCACertFile string) (*tls.Config, error) {
    serverCert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading server cert: %w", err)
    }

    clientCACert, err := os.ReadFile(clientCACertFile)
    if err != nil {
        return nil, fmt.Errorf("reading client CA cert: %w", err)
    }

    clientCAPool := x509.NewCertPool()
    if !clientCAPool.AppendCertsFromPEM(clientCACert) {
        return nil, fmt.Errorf("parsing client CA cert")
    }

    return &tls.Config{
        Certificates: []tls.Certificate{serverCert},
        ClientAuth:   tls.RequireAndVerifyClientCert,
        ClientCAs:    clientCAPool,
        MinVersion:   tls.VersionTLS12,
        CipherSuites: productionCipherSuites(),
        NextProtos:   []string{"h2", "http/1.1"},
    }, nil
}

// MTLSClientConfig creates a TLS configuration presenting a client certificate.
func MTLSClientConfig(clientCertFile, clientKeyFile, serverCACertFile, serverName string) (*tls.Config, error) {
    clientCert, err := tls.LoadX509KeyPair(clientCertFile, clientKeyFile)
    if err != nil {
        return nil, fmt.Errorf("loading client cert: %w", err)
    }

    serverCACert, err := os.ReadFile(serverCACertFile)
    if err != nil {
        return nil, fmt.Errorf("reading server CA cert: %w", err)
    }

    serverCAPool := x509.NewCertPool()
    if !serverCAPool.AppendCertsFromPEM(serverCACert) {
        return nil, fmt.Errorf("parsing server CA cert")
    }

    return &tls.Config{
        Certificates:       []tls.Certificate{clientCert},
        RootCAs:            serverCAPool,
        ServerName:         serverName,
        MinVersion:         tls.VersionTLS12,
        CipherSuites:       productionCipherSuites(),
        InsecureSkipVerify: false,
    }, nil
}
```

### Extracting Client Identity from mTLS

```go
// ClientIdentityMiddleware extracts the client's identity from the mTLS certificate
// and injects it into the request context.
func ClientIdentityMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Verify TLS is being used
        if r.TLS == nil {
            http.Error(w, "TLS required", http.StatusUnauthorized)
            return
        }

        // Verify client presented a certificate
        if len(r.TLS.PeerCertificates) == 0 {
            http.Error(w, "client certificate required", http.StatusUnauthorized)
            return
        }

        clientCert := r.TLS.PeerCertificates[0]

        // Extract identity from the certificate's Subject
        identity := &ClientIdentity{
            CommonName:   clientCert.Subject.CommonName,
            Organization: clientCert.Subject.Organization,
            SerialNumber: clientCert.SerialNumber.String(),
            NotBefore:    clientCert.NotBefore,
            NotAfter:     clientCert.NotAfter,
        }

        // Validate certificate is not expired
        now := time.Now()
        if now.Before(clientCert.NotBefore) || now.After(clientCert.NotAfter) {
            http.Error(w, "client certificate is expired or not yet valid", http.StatusUnauthorized)
            return
        }

        // Extract SANs for service identity (used by SPIFFE/SPIRE)
        for _, san := range clientCert.URIs {
            if strings.HasPrefix(san.String(), "spiffe://") {
                identity.SPIFFEID = san.String()
            }
        }

        // Inject identity into context
        ctx := context.WithValue(r.Context(), clientIdentityKey{}, identity)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

type ClientIdentity struct {
    CommonName   string
    Organization []string
    SerialNumber string
    SPIFFEID     string
    NotBefore    time.Time
    NotAfter     time.Time
}

type clientIdentityKey struct{}

func ClientIdentityFromContext(ctx context.Context) (*ClientIdentity, bool) {
    identity, ok := ctx.Value(clientIdentityKey{}).(*ClientIdentity)
    return identity, ok
}
```

### mTLS with SPIFFE/SPIRE

For Kubernetes environments, SPIFFE/SPIRE provides automatically rotated workload identities:

```go
// SpiffeIdentityVerifier creates a TLS config that verifies SPIFFE identities
func SpiffeIdentityVerifier(serverName string, allowedSPIFFEIDs []string) *tls.Config {
    allowedSet := make(map[string]struct{})
    for _, id := range allowedSPIFFEIDs {
        allowedSet[id] = struct{}{}
    }

    return &tls.Config{
        ServerName: serverName,
        MinVersion: tls.VersionTLS12,

        VerifyPeerCertificate: func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
            for _, chain := range verifiedChains {
                for _, cert := range chain {
                    for _, uri := range cert.URIs {
                        spiffeID := uri.String()
                        if _, ok := allowedSet[spiffeID]; ok {
                            return nil
                        }
                    }
                }
            }
            return fmt.Errorf("no accepted SPIFFE ID found in client certificate")
        },
    }
}

// Usage: only allow services with specific SPIFFE IDs
tlsConfig := SpiffeIdentityVerifier(
    "api.internal.example.com",
    []string{
        "spiffe://example.com/ns/production/sa/frontend",
        "spiffe://example.com/ns/production/sa/api-gateway",
    },
)
```

## Section 5: Dynamic Certificate Loading

### Zero-Downtime Certificate Rotation

```go
package certs

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "os"
    "sync"
    "sync/atomic"
    "time"
    "unsafe"
)

// AtomicCertStore provides zero-copy certificate rotation using atomic operations.
type AtomicCertStore struct {
    certPtr unsafe.Pointer // *atomicCert, accessed via atomic operations
}

type atomicCert struct {
    certificate *tls.Certificate
    expiry      time.Time
}

// NewAtomicCertStore creates a certificate store and loads the initial certificate.
func NewAtomicCertStore(certFile, keyFile string) (*AtomicCertStore, error) {
    store := &AtomicCertStore{}
    if err := store.Reload(certFile, keyFile); err != nil {
        return nil, err
    }
    return store, nil
}

// Reload atomically replaces the stored certificate.
// Safe to call concurrently with GetCertificate.
func (s *AtomicCertStore) Reload(certFile, keyFile string) error {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return fmt.Errorf("loading key pair: %w", err)
    }

    // Parse the certificate to get its expiry time
    leaf, err := x509.ParseCertificate(cert.Certificate[0])
    if err != nil {
        return fmt.Errorf("parsing leaf certificate: %w", err)
    }

    entry := &atomicCert{
        certificate: &cert,
        expiry:      leaf.NotAfter,
    }

    atomic.StorePointer(&s.certPtr, unsafe.Pointer(entry))
    return nil
}

// GetCertificate returns the current certificate.
// This function signature matches the tls.Config.GetCertificate field.
func (s *AtomicCertStore) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
    entry := (*atomicCert)(atomic.LoadPointer(&s.certPtr))
    if entry == nil {
        return nil, fmt.Errorf("no certificate loaded")
    }

    // Warn if certificate expires soon
    if time.Until(entry.expiry) < 7*24*time.Hour {
        // Log warning — in production this would trigger an alert
        fmt.Printf("WARNING: Certificate expires in %v\n", time.Until(entry.expiry))
    }

    return entry.certificate, nil
}

// GetClientCertificate returns the current certificate for use as a client cert.
// This function signature matches the tls.Config.GetClientCertificate field.
func (s *AtomicCertStore) GetClientCertificate(reqInfo *tls.CertificateRequestInfo) (*tls.Certificate, error) {
    entry := (*atomicCert)(atomic.LoadPointer(&s.certPtr))
    if entry == nil {
        return nil, fmt.Errorf("no certificate loaded")
    }
    return entry.certificate, nil
}

// CertWatcher watches for certificate file changes and reloads automatically.
type CertWatcher struct {
    store    *AtomicCertStore
    certFile string
    keyFile  string
    interval time.Duration
    stop     chan struct{}
    mu       sync.Mutex
    lastMod  time.Time
}

func NewCertWatcher(store *AtomicCertStore, certFile, keyFile string, interval time.Duration) *CertWatcher {
    return &CertWatcher{
        store:    store,
        certFile: certFile,
        keyFile:  keyFile,
        interval: interval,
        stop:     make(chan struct{}),
    }
}

func (cw *CertWatcher) Start() {
    go cw.watchLoop()
}

func (cw *CertWatcher) Stop() {
    close(cw.stop)
}

func (cw *CertWatcher) watchLoop() {
    ticker := time.NewTicker(cw.interval)
    defer ticker.Stop()

    for {
        select {
        case <-cw.stop:
            return
        case <-ticker.C:
            cw.checkAndReload()
        }
    }
}

func (cw *CertWatcher) checkAndReload() {
    info, err := os.Stat(cw.certFile)
    if err != nil {
        fmt.Printf("cert watcher: stat failed: %v\n", err)
        return
    }

    cw.mu.Lock()
    defer cw.mu.Unlock()

    if !info.ModTime().After(cw.lastMod) {
        return // Certificate file hasn't changed
    }

    if err := cw.store.Reload(cw.certFile, cw.keyFile); err != nil {
        fmt.Printf("cert watcher: reload failed: %v\n", err)
        return
    }

    cw.lastMod = info.ModTime()
    fmt.Printf("cert watcher: certificate reloaded at %v\n", time.Now())
}
```

## Section 6: Session Ticket Rotation

### Implementing Session Ticket Key Rotation

Session tickets allow TLS session resumption. If a session ticket key is compromised, all sessions using it can be decrypted (breaking forward secrecy for resumed sessions). Periodic key rotation limits this risk.

```go
package sessiontickets

import (
    "crypto/rand"
    "crypto/tls"
    "fmt"
    "sync"
    "time"
)

// SessionTicketRotator manages TLS session ticket key rotation.
// Keys are rotated on a schedule; the previous key is kept for a grace period
// to allow in-flight sessions to complete.
type SessionTicketRotator struct {
    mu       sync.RWMutex
    keys     [][32]byte  // [0] = current key, [1] = previous key
    rotateAt time.Time
    period   time.Duration
}

// NewSessionTicketRotator creates a rotator with the specified rotation period.
// typical production value: 24 hours (balance between security and resumption benefit)
func NewSessionTicketRotator(period time.Duration) (*SessionTicketRotator, error) {
    r := &SessionTicketRotator{
        period: period,
        keys:   make([][32]byte, 2),
    }

    // Generate initial keys
    if err := r.generateKey(&r.keys[0]); err != nil {
        return nil, err
    }
    if err := r.generateKey(&r.keys[1]); err != nil {
        return nil, err
    }

    r.rotateAt = time.Now().Add(period)

    go r.rotationLoop()

    return r, nil
}

func (r *SessionTicketRotator) generateKey(key *[32]byte) error {
    _, err := rand.Read(key[:])
    return err
}

func (r *SessionTicketRotator) rotationLoop() {
    for {
        // Sleep until the next rotation
        sleepDuration := time.Until(r.rotateAt)
        if sleepDuration <= 0 {
            sleepDuration = r.period
        }
        time.Sleep(sleepDuration)

        r.rotate()
    }
}

func (r *SessionTicketRotator) rotate() {
    r.mu.Lock()
    defer r.mu.Unlock()

    // Shift current to previous, generate new current
    r.keys[1] = r.keys[0]
    if err := r.generateKey(&r.keys[0]); err != nil {
        fmt.Printf("session ticket rotation failed: %v\n", err)
        return
    }

    r.rotateAt = time.Now().Add(r.period)
    fmt.Printf("Session ticket keys rotated at %v\n", time.Now())
}

// SetSessionTicketKeys configures session ticket keys on the TLS server.
// The first key is used to create new tickets; subsequent keys decrypt old tickets.
func (r *SessionTicketRotator) SetSessionTicketKeys(server *tls.Config) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    server.SetSessionTicketKeys(r.keys)
}

// KeyRefresher returns a function that can be called periodically to update
// the session ticket keys on a running TLS server.
func (r *SessionTicketRotator) KeyRefresher(cfg *tls.Config) func() {
    return func() {
        r.SetSessionTicketKeys(cfg)
    }
}
```

## Section 7: TLS in Kubernetes

### Kubernetes Secrets for TLS Certificates

```yaml
# Create a TLS secret for use by Go services in Kubernetes

# Option 1: Create from existing files
kubectl create secret tls my-service-tls \
  --cert=server.crt \
  --key=server.key \
  -n production

# Option 2: YAML manifest (with base64-encoded certificate)
# NOTE: Replace placeholder values with actual base64-encoded certificate content
apiVersion: v1
kind: Secret
metadata:
  name: my-service-tls
  namespace: production
type: kubernetes.io/tls
data:
  tls.crt: <base64-encoded-tls-certificate>
  tls.key: <base64-encoded-tls-private-key>
```

### Mounting TLS Certificates in Go Pods

```yaml
# Kubernetes deployment with TLS certificate injection
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-service
  template:
    metadata:
      labels:
        app: my-service
    spec:
      containers:
        - name: my-service
          image: registry.example.com/my-service:latest
          env:
            - name: TLS_CERT_FILE
              value: /tls/tls.crt
            - name: TLS_KEY_FILE
              value: /tls/tls.key
          volumeMounts:
            - name: tls-certs
              mountPath: /tls
              readOnly: true
          ports:
            - containerPort: 8443
              protocol: TCP
      volumes:
        - name: tls-certs
          secret:
            secretName: my-service-tls
            # Auto-update: Kubernetes updates projected volumes when secrets change
            # The Go application must watch for file changes (use CertWatcher above)
            optional: false
```

### Using cert-manager for Automatic Certificate Rotation

```yaml
# cert-manager Certificate resource with automatic renewal
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: my-service-cert
  namespace: production
spec:
  secretName: my-service-tls  # The secret that will be created/updated
  duration: 90d                # Certificate validity period
  renewBefore: 14d             # Renew 14 days before expiry
  dnsNames:
    - my-service.production.svc.cluster.local
    - my-service.example.com
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
    group: cert-manager.io
  # Add SPIFFE URI SAN for mTLS with SPIFFE-aware services
  uris:
    - "spiffe://cluster.local/ns/production/sa/my-service"
```

## Section 8: TLS Debugging and Troubleshooting

```go
// TLSDebugServer starts a TLS server that logs detailed connection information
func TLSDebugServer(addr string, tlsCfg *tls.Config) error {
    tlsCfg.VerifyConnection = func(cs tls.ConnectionState) error {
        fmt.Printf("TLS Connection:\n")
        fmt.Printf("  Version: %s\n", tls.VersionName(cs.Version))
        fmt.Printf("  Cipher: %s\n", tls.CipherSuiteName(cs.CipherSuite))
        fmt.Printf("  ALPN Protocol: %s\n", cs.NegotiatedProtocol)
        fmt.Printf("  Server Name: %s\n", cs.ServerName)
        fmt.Printf("  Resumed: %v\n", cs.DidResume)
        if len(cs.PeerCertificates) > 0 {
            fmt.Printf("  Client CN: %s\n", cs.PeerCertificates[0].Subject.CommonName)
            fmt.Printf("  Client Org: %v\n", cs.PeerCertificates[0].Subject.Organization)
        }
        return nil // Return nil to allow the connection (or return error to reject)
    }

    listener, err := tls.Listen("tcp", addr, tlsCfg)
    if err != nil {
        return err
    }
    defer listener.Close()

    return http.Serve(listener, http.DefaultServeMux)
}
```

```bash
# Debug TLS from the command line

# Check the cipher suite and protocol version
openssl s_client -connect service.example.com:8443 -brief 2>&1 | head -5
# CONNECTION ESTABLISHED
# Protocol version: TLSv1.3
# Ciphersuite: TLS_AES_256_GCM_SHA384
# Peer certificate: ...

# Verify mTLS: present a client certificate
openssl s_client \
    -connect service.example.com:8443 \
    -cert client.crt \
    -key client.key \
    -CAfile ca.crt \
    -brief 2>&1 | head -10

# Check ALPN negotiation
openssl s_client \
    -connect service.example.com:8443 \
    -alpn "h2,http/1.1" \
    2>&1 | grep "ALPN"
# ALPN protocol: h2
```

## Conclusion

Production Go TLS configuration requires deliberate choices at every layer: cipher suites to enforce perfect forward secrecy, minimum versions to reject deprecated protocols, certificate pinning to prevent MITM attacks even with compromised CAs, ALPN to serve multiple protocols on a single port, and mTLS for verified service-to-service authentication. The dynamic certificate loading patterns enable zero-downtime certificate rotation, which is essential for services with short-lived certificates from cert-manager or SPIRE. With these configurations in place, your Go services establish TLS connections that are both secure and maintainable in production.
