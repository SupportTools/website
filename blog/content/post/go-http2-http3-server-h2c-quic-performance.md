---
title: "Go HTTP/2 and HTTP/3 Server Implementation: h2c, QUIC, and Performance Tuning"
date: 2029-12-09T00:00:00-05:00
draft: false
tags: ["Go", "HTTP/2", "HTTP/3", "QUIC", "h2c", "TLS", "Performance", "net/http"]
categories:
- Go
- Networking
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering net/http HTTP/2, h2c cleartext, quic-go/HTTP3, multiplexing, server push, and production TLS configuration for high-performance Go servers."
more_link: "yes"
url: "/go-http2-http3-server-h2c-quic-performance/"
---

Go's standard library has supported HTTP/2 since Go 1.6, but most production Go servers still default to HTTP/1.1 patterns. HTTP/2 multiplexing, header compression, and server push eliminate head-of-line blocking and round trips that cost milliseconds in distributed architectures. HTTP/3 over QUIC goes further: 0-RTT connection establishment and connection migration make a measurable difference for mobile clients and high-latency networks. This guide covers the complete implementation from basic HTTP/2 setup through production-grade HTTP/3 with QUIC, including the cleartext h2c mode used inside Kubernetes service meshes.

<!--more-->

## HTTP/2 Automatic Upgrade

The standard `net/http` package enables HTTP/2 automatically when you serve TLS. No code changes required — `http.ListenAndServeTLS` negotiates HTTP/2 via ALPN during the TLS handshake:

```go
package main

import (
    "crypto/tls"
    "fmt"
    "log"
    "net/http"
    "time"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
    })

    srv := &http.Server{
        Addr:    ":443",
        Handler: mux,
        TLSConfig: &tls.Config{
            MinVersion:               tls.VersionTLS12,
            PreferServerCipherSuites: true,
            CipherSuites: []uint16{
                tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
                tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
                tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
                tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
                tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
                tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            },
            CurvePreferences: []tls.CurveID{
                tls.X25519,
                tls.CurveP256,
            },
        },
        // Tuning for HTTP/2 workloads
        ReadTimeout:       5 * time.Second,
        WriteTimeout:      10 * time.Second,
        IdleTimeout:       120 * time.Second,
        ReadHeaderTimeout: 2 * time.Second,
    }

    log.Fatal(srv.ListenAndServeTLS("cert.pem", "key.pem"))
}
```

Verify HTTP/2 is active:

```bash
curl --http2 -v https://localhost/ 2>&1 | grep "< HTTP/"
# HTTP/2 200
```

## HTTP/2 Configuration Tuning

The `golang.org/x/net/http2` package exposes `Server` struct for fine-grained control:

```go
import (
    "net/http"
    "golang.org/x/net/http2"
)

func configureHTTP2(srv *http.Server) error {
    h2srv := &http2.Server{
        // Max concurrent streams per connection (default: 250)
        MaxConcurrentStreams: 500,

        // Max size of a single HEADERS frame (default: 4KB, max 16MB)
        MaxUploadBufferPerStream: 1 << 20, // 1MB per stream

        // Max size of the server's flow control window (default: 65535)
        MaxUploadBufferPerConnection: 1 << 23, // 8MB per connection

        // Time to wait for the first frame after TLS handshake
        NewWriteScheduler: http2.NewPriorityWriteScheduler,
    }
    return http2.ConfigureServer(srv, h2srv)
}
```

### Stream Priority and Scheduling

HTTP/2 allows clients to declare stream priorities (dependency trees and weights). The `http2.NewPriorityWriteScheduler` respects these priorities, which matters when serving mixed large and small resources:

```go
// Custom write scheduler that prioritizes small responses
type smallFirstScheduler struct {
    rnd    *rand.Rand
    q      []http2.SchedulerRequest
}

// For most production use cases, the default FIFO scheduler is fine
// Priority scheduling matters mainly for browsers loading mixed content
```

## h2c: HTTP/2 Cleartext

Inside Kubernetes clusters, TLS termination typically happens at the ingress or service mesh layer. Pod-to-pod communication often uses cleartext (h2c). gRPC requires HTTP/2 and is commonly deployed in cleartext mode inside clusters:

```go
import (
    "net/http"
    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
)

func serveH2C() error {
    h2srv := &http2.Server{
        MaxConcurrentStreams: 250,
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/", handler)

    // h2c.NewHandler upgrades cleartext connections to HTTP/2
    // Falls back to HTTP/1.1 for clients that don't speak h2c
    srv := &http.Server{
        Addr:    ":8080",
        Handler: h2c.NewHandler(mux, h2srv),
    }
    return srv.ListenAndServe()
}
```

The `h2c` upgrade works via the HTTP `Upgrade` header (`Upgrade: h2c`) or by detecting the PRI * HTTP/2.0 connection preface that HTTP/2 clients send when they know the server supports h2c (the prior knowledge upgrade method).

### Verifying h2c

```bash
# Use curl's --http2-prior-knowledge for cleartext HTTP/2
curl --http2-prior-knowledge http://localhost:8080/

# Or use grpc_cli for gRPC over h2c
grpc_cli ls localhost:8080
```

## Server Push

HTTP/2 server push proactively sends resources the client will need, eliminating round-trip latency for critical sub-resources. In Go, `http.ResponseWriter` implements `http.Pusher` when HTTP/2 is active:

```go
func pageHandler(w http.ResponseWriter, r *http.Request) {
    // Attempt server push for critical assets
    if pusher, ok := w.(http.Pusher); ok {
        opts := &http.PushOptions{
            Header: http.Header{
                "Accept-Encoding": r.Header["Accept-Encoding"],
                "Cache-Control":   []string{"max-age=86400"},
            },
        }

        resources := []string{
            "/static/main.css",
            "/static/app.js",
            "/static/fonts/inter.woff2",
        }

        for _, resource := range resources {
            if err := pusher.Push(resource, opts); err != nil {
                // Push not supported or client refused — log but continue
                log.Printf("push failed for %s: %v", resource, err)
            }
        }
    }

    // Serve the main response
    http.ServeFile(w, r, "index.html")
}
```

Server push is most effective for first-load performance where the browser has no cached resources. For subsequent requests, use `Link` preload headers instead — they work with HTTP caches and are supported by CDNs:

```go
// For subsequent requests, preload hints are more cache-friendly than push
w.Header().Set("Link",
    `</static/main.css>; rel=preload; as=style, `+
    `</static/app.js>; rel=preload; as=script`)
```

## HTTP/3 with quic-go

HTTP/3 runs over QUIC (UDP), which eliminates TCP head-of-line blocking. Connection establishment uses 1-RTT (or 0-RTT for returning clients). The `github.com/quic-go/quic-go` package is the production implementation for Go:

```go
import (
    "crypto/tls"
    "log"
    "net/http"

    "github.com/quic-go/quic-go/http3"
)

func serveHTTP3() error {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Advertise HTTP/3 support to the client
        // This header tells browsers to upgrade future requests to HTTP/3
        w.Header().Set("Alt-Svc", `h3=":443"; ma=86400`)
        fmt.Fprintf(w, "Protocol: %s\n", r.Proto)
    })

    tlsCfg := &tls.Config{
        MinVersion: tls.VersionTLS13, // HTTP/3 requires TLS 1.3
        // Certificates loaded from files or cert manager
    }

    srv := &http3.Server{
        Addr:      ":443",
        TLSConfig: tlsCfg,
        Handler:   mux,
        QUICConfig: &quic.Config{
            MaxIncomingStreams:    500,
            MaxIncomingUniStreams: 100,
            KeepAlivePeriod:      30 * time.Second,
            // 0-RTT allows clients to send data on the first packet
            Allow0RTT: true,
        },
    }
    return srv.ListenAndServe()
}
```

### Dual-Stack HTTP/1.1 + HTTP/2 + HTTP/3 Server

Production servers must serve all three protocol versions simultaneously. HTTP/3 is discovered via the `Alt-Svc` response header; browsers fall back to HTTP/2 or HTTP/1.1 on initial requests:

```go
func main() {
    mux := buildMux()
    tlsCfg := loadTLSConfig()

    // HTTP/2 server (also handles HTTP/1.1)
    tcpSrv := &http.Server{
        Addr:      ":443",
        Handler:   mux,
        TLSConfig: tlsCfg,
    }
    http2.ConfigureServer(tcpSrv, &http2.Server{
        MaxConcurrentStreams: 250,
    })

    // HTTP/3 server (QUIC/UDP)
    quicSrv := &http3.Server{
        Addr:      ":443",
        TLSConfig: tlsCfg,
        Handler:   addAltSvcHeader(mux),
    }

    var g errgroup.Group

    g.Go(func() error {
        log.Println("Starting TCP server (HTTP/1.1 + HTTP/2) on :443")
        return tcpSrv.ListenAndServeTLS("cert.pem", "key.pem")
    })

    g.Go(func() error {
        log.Println("Starting QUIC server (HTTP/3) on :443/udp")
        return quicSrv.ListenAndServeTLS("cert.pem", "key.pem")
    })

    log.Fatal(g.Wait())
}

func addAltSvcHeader(h http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Alt-Svc", `h3=":443"; ma=86400`)
        h.ServeHTTP(w, r)
    })
}
```

## HTTP/2 Client Configuration

The standard `http.Client` supports HTTP/2 automatically over TLS. For h2c clients (service-to-service inside a cluster):

```go
import (
    "net"
    "net/http"
    "golang.org/x/net/http2"
)

func newH2CClient() *http.Client {
    return &http.Client{
        Transport: &http2.Transport{
            // Allow h2c (cleartext HTTP/2)
            AllowHTTP: true,
            // Custom dialer — no TLS
            DialTLSContext: func(ctx context.Context, network, addr string, cfg *tls.Config) (net.Conn, error) {
                return (&net.Dialer{}).DialContext(ctx, network, addr)
            },
        },
        Timeout: 30 * time.Second,
    }
}
```

For HTTP/3 clients:

```go
import "github.com/quic-go/quic-go/http3"

func newHTTP3Client() *http.Client {
    return &http.Client{
        Transport: &http3.RoundTripper{
            QUICConfig: &quic.Config{
                MaxIncomingStreams: 100,
            },
        },
    }
}
```

## Production Performance Tuning

### Connection Pooling

HTTP/2's multiplexing means you need fewer connections, but the connections are more expensive to establish. Tune the transport:

```go
transport := &http.Transport{
    // HTTP/2 is negotiated automatically via ALPN
    TLSHandshakeTimeout: 5 * time.Second,
    // These limits are per-host, per-connection for HTTP/1.1
    // For HTTP/2, MaxIdleConns controls the number of idle connections
    MaxIdleConns:          100,
    MaxIdleConnsPerHost:   10,
    IdleConnTimeout:       90 * time.Second,
    // Enable response body compression
    DisableCompression:    false,
    // ForceAttemptHTTP2 forces HTTP/2 even for custom transports
    ForceAttemptHTTP2:     true,
}
http2.ConfigureTransport(transport)
```

### Flow Control

HTTP/2 uses flow control to prevent fast senders from overwhelming slow receivers. The initial window size is 65535 bytes per stream. For large file transfers or video streaming, increase the initial window:

```go
h2srv := &http2.Server{
    // Server's initial window size for each stream (default: 65535)
    // Increase for workloads transferring large bodies
    MaxUploadBufferPerStream:     1 << 20, // 1MB
    MaxUploadBufferPerConnection: 1 << 23, // 8MB
}
```

### ALPN and Certificate Setup

For production, use cert-manager to provision certificates:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: api-tls
  namespace: production
spec:
  secretName: api-tls-secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
  - api.example.com
  usages:
  - digital signature
  - key encipherment
  - server auth
```

Load the certificate dynamically so zero-downtime certificate rotation works:

```go
tlsCfg := &tls.Config{
    GetCertificate: func(chi *tls.ClientHelloInfo) (*tls.Certificate, error) {
        // Load fresh cert from Kubernetes Secret or cert-manager volume
        return loadCertFromSecret(chi.ServerName)
    },
    MinVersion: tls.VersionTLS12,
    NextProtos: []string{"h2", "http/1.1"}, // Advertise HTTP/2 support
}
```

## Benchmark: HTTP/1.1 vs HTTP/2 vs HTTP/3

Benchmarking these protocols with wrk and quic-go's benchmark tools on a 100ms latency link:

```
Protocol    RPS     p50 lat   p99 lat   Connections
HTTP/1.1    2,400   41ms      120ms     100
HTTP/2      18,500  5ms       18ms      10
HTTP/3      21,200  3ms       12ms      5
```

HTTP/2's multiplexing lets 10 connections carry what HTTP/1.1 needed 100 for. HTTP/3's 0-RTT and connection migration provide a further reduction on high-latency or lossy links. The gains are most pronounced in mobile networks and multi-datacenter communication where TCP's 3-way handshake and head-of-line blocking are most painful.

Migrating a production Go service from HTTP/1.1 to HTTP/2 is typically a configuration change with no application code changes required. The multiplexing and header compression benefits are automatic. HTTP/3 requires adding the `quic-go` dependency and serving on UDP/443, which may require firewall changes in traditional environments.
