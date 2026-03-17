---
title: "Go Cloud-Native Patterns: Sidecar, Ambassador, and Adapter with Kubernetes"
date: 2029-08-18T00:00:00-05:00
draft: false
tags: ["Go", "Kubernetes", "Cloud-Native", "Sidecar", "Envoy", "Microservices", "Design Patterns"]
categories: ["Go", "Kubernetes", "Architecture"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production implementation of Go cloud-native container patterns: sidecar proxy with Envoy gRPC filter, ambassador pattern for legacy service integration, and adapter pattern for metrics normalization in Kubernetes."
more_link: "yes"
url: "/go-cloud-native-patterns-sidecar-ambassador-adapter-kubernetes/"
---

The sidecar, ambassador, and adapter patterns are architectural primitives for building cloud-native systems that solve cross-cutting concerns without coupling them to business logic. In Go, these patterns map naturally to the language's strengths: lightweight goroutines for concurrent proxy logic, interfaces for clean separation, and the standard library's HTTP/gRPC support. This post builds production-grade implementations of each pattern with Kubernetes deployment configurations.

<!--more-->

# Go Cloud-Native Patterns: Sidecar, Ambassador, and Adapter with Kubernetes

## The Container Pattern Vocabulary

Before diving into code, it helps to be precise about what each pattern does:

- **Sidecar**: A helper container in the same Pod that augments or enhances the primary container. It shares network, filesystem, and process namespace. Examples: log shippers, proxy agents, secret injectors.
- **Ambassador**: A proxy container that simplifies a primary container's access to external services. The primary container talks to `localhost`, and the ambassador translates or routes those calls. Examples: connection pooling proxy, service discovery proxy.
- **Adapter**: A container that normalizes the output of the primary container for consumption by external systems. The primary outputs data in its own format, the adapter transforms it. Examples: metrics format translators, log format normalizers.

## Sidecar Pattern: Envoy gRPC Filter Integration

Envoy supports external processing via the `ext_proc` filter, which calls an external gRPC server to process HTTP requests and responses. Implementing this server in Go lets you add custom logic — authentication, request mutation, header injection — to all traffic flowing through Envoy without modifying the applications.

### The gRPC External Processing Server

```go
// cmd/ext-proc/main.go
package main

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "os"
    "os/signal"
    "syscall"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"

    corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
    extprocv3 "github.com/envoyproxy/go-control-plane/envoy/service/ext_proc/v3"
    typev3 "github.com/envoyproxy/go-control-plane/envoy/type/v3"

    httppb "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
)

type ExtProcServer struct {
    extprocv3.UnimplementedExternalProcessorServer
    logger *slog.Logger
}

func (s *ExtProcServer) Process(
    stream extprocv3.ExternalProcessor_ProcessServer,
) error {
    ctx := stream.Context()
    s.logger.Info("new ext_proc stream opened")

    for {
        req, err := stream.Recv()
        if err != nil {
            return err
        }

        var resp *extprocv3.ProcessingResponse

        switch v := req.Request.(type) {
        case *extprocv3.ProcessingRequest_RequestHeaders:
            resp = s.handleRequestHeaders(ctx, v.RequestHeaders)

        case *extprocv3.ProcessingRequest_ResponseHeaders:
            resp = s.handleResponseHeaders(ctx, v.ResponseHeaders)

        case *extprocv3.ProcessingRequest_RequestBody:
            resp = s.handleRequestBody(ctx, v.RequestBody)

        case *extprocv3.ProcessingRequest_ResponseBody:
            resp = s.handleResponseBody(ctx, v.ResponseBody)

        default:
            resp = &extprocv3.ProcessingResponse{}
        }

        if err := stream.Send(resp); err != nil {
            return fmt.Errorf("sending response: %w", err)
        }
    }
}

func (s *ExtProcServer) handleRequestHeaders(
    ctx context.Context,
    headers *extprocv3.HttpHeaders,
) *extprocv3.ProcessingResponse {
    // Extract request ID or generate one
    requestID := ""
    for _, h := range headers.Headers.Headers {
        if h.Key == "x-request-id" {
            requestID = h.RawValue
            break
        }
    }
    if requestID == "" {
        requestID = generateRequestID()
    }

    // Inject tracing headers and custom metadata
    return &extprocv3.ProcessingResponse{
        Response: &extprocv3.ProcessingResponse_RequestHeaders{
            RequestHeaders: &extprocv3.HeadersResponse{
                Response: &extprocv3.CommonResponse{
                    HeaderMutation: &extprocv3.HeaderMutation{
                        SetHeaders: []*corev3.HeaderValueOption{
                            {
                                Header: &corev3.HeaderValue{
                                    Key:   "x-request-id",
                                    Value: requestID,
                                },
                                KeepEmptyValue: false,
                            },
                            {
                                Header: &corev3.HeaderValue{
                                    Key:   "x-processed-by",
                                    Value: "go-ext-proc",
                                },
                            },
                            {
                                Header: &corev3.HeaderValue{
                                    Key:   "x-timestamp",
                                    Value: time.Now().UTC().Format(time.RFC3339Nano),
                                },
                            },
                        },
                    },
                    ClearRouteCache: false,
                },
            },
        },
        ModeOverride: &extprocv3.ProcessingMode{
            RequestBodyMode:  extprocv3.ProcessingMode_NONE,
            ResponseBodyMode: extprocv3.ProcessingMode_NONE,
        },
    }
}

func (s *ExtProcServer) handleResponseHeaders(
    ctx context.Context,
    headers *extprocv3.HttpHeaders,
) *extprocv3.ProcessingResponse {
    // Add security headers to all responses
    return &extprocv3.ProcessingResponse{
        Response: &extprocv3.ProcessingResponse_ResponseHeaders{
            ResponseHeaders: &extprocv3.HeadersResponse{
                Response: &extprocv3.CommonResponse{
                    HeaderMutation: &extprocv3.HeaderMutation{
                        SetHeaders: []*corev3.HeaderValueOption{
                            {
                                Header: &corev3.HeaderValue{
                                    Key:   "x-content-type-options",
                                    Value: "nosniff",
                                },
                            },
                            {
                                Header: &corev3.HeaderValue{
                                    Key:   "x-frame-options",
                                    Value: "DENY",
                                },
                            },
                            {
                                Header: &corev3.HeaderValue{
                                    Key:   "strict-transport-security",
                                    Value: "max-age=31536000; includeSubDomains",
                                },
                            },
                        },
                    },
                },
            },
        },
    }
}

func (s *ExtProcServer) handleRequestBody(
    ctx context.Context,
    body *extprocv3.HttpBody,
) *extprocv3.ProcessingResponse {
    // For body processing, you could validate JSON, redact PII, etc.
    return &extprocv3.ProcessingResponse{
        Response: &extprocv3.ProcessingResponse_RequestBody{
            RequestBody: &extprocv3.BodyResponse{
                Response: &extprocv3.CommonResponse{},
            },
        },
    }
}

func (s *ExtProcServer) handleResponseBody(
    ctx context.Context,
    body *extprocv3.HttpBody,
) *extprocv3.ProcessingResponse {
    return &extprocv3.ProcessingResponse{
        Response: &extprocv3.ProcessingResponse_ResponseBody{
            ResponseBody: &extprocv3.BodyResponse{
                Response: &extprocv3.CommonResponse{},
            },
        },
    }
}

func generateRequestID() string {
    return fmt.Sprintf("%d", time.Now().UnixNano())
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    lis, err := net.Listen("tcp", ":9001")
    if err != nil {
        logger.Error("failed to listen", "error", err)
        os.Exit(1)
    }

    server := grpc.NewServer(
        grpc.MaxRecvMsgSize(1024*1024*10),
        grpc.MaxSendMsgSize(1024*1024*10),
    )

    extProcSrv := &ExtProcServer{logger: logger}
    extprocv3.RegisterExternalProcessorServer(server, extProcSrv)

    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(server, healthSrv)
    healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)

    reflection.Register(server)

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        logger.Info("ext_proc server starting", "addr", lis.Addr())
        if err := server.Serve(lis); err != nil {
            logger.Error("server error", "error", err)
        }
    }()

    <-quit
    logger.Info("shutting down gracefully")
    server.GracefulStop()
}
```

### Envoy Configuration for ext_proc Sidecar

```yaml
# envoy-config.yaml
static_resources:
  listeners:
    - name: listener_0
      address:
        socket_address:
          address: 0.0.0.0
          port_value: 8080
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: ingress_http
                access_log:
                  - name: envoy.access_loggers.stdout
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog
                http_filters:
                  - name: envoy.filters.http.ext_proc
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.ext_proc.v3.ExternalProcessor
                      grpc_service:
                        envoy_grpc:
                          cluster_name: ext_proc_cluster
                      processing_mode:
                        request_header_mode: SEND
                        response_header_mode: SEND
                        request_body_mode: NONE
                        response_body_mode: NONE
                      failure_mode_allow: true
                      message_timeout: 0.1s
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                route_config:
                  name: local_route
                  virtual_hosts:
                    - name: local_service
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: app_cluster

  clusters:
    - name: app_cluster
      type: STATIC
      connect_timeout: 1s
      load_assignment:
        cluster_name: app_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: 127.0.0.1
                      port_value: 8081

    - name: ext_proc_cluster
      type: STATIC
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          explicit_http_config:
            http2_protocol_options: {}
      connect_timeout: 1s
      load_assignment:
        cluster_name: ext_proc_cluster
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: 127.0.0.1
                      port_value: 9001
```

### Kubernetes Pod Spec with Sidecar

```yaml
# deployment-with-sidecar.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-envoy-sidecar
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      initContainers:
        # Init container to wait for ext_proc to be ready
        - name: wait-for-extproc
          image: busybox:1.35
          command: ["sh", "-c", "until nc -z localhost 9001; do sleep 1; done"]

      containers:
        # Primary application
        - name: app
          image: myapp:latest
          ports:
            - containerPort: 8081
          env:
            - name: PORT
              value: "8081"

        # Envoy sidecar proxy
        - name: envoy
          image: envoyproxy/envoy:v1.28.0
          args:
            - -c
            - /etc/envoy/envoy.yaml
            - --log-level
            - info
          ports:
            - containerPort: 8080
              name: http
          volumeMounts:
            - name: envoy-config
              mountPath: /etc/envoy
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi

        # Go ext_proc sidecar
        - name: ext-proc
          image: myregistry/ext-proc:latest
          ports:
            - containerPort: 9001
              name: grpc
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              cpu: 200m
              memory: 128Mi
          readinessProbe:
            grpc:
              port: 9001
            initialDelaySeconds: 3
            periodSeconds: 10

      volumes:
        - name: envoy-config
          configMap:
            name: envoy-config
```

## Ambassador Pattern: Legacy Service Proxy

The ambassador pattern is ideal when you have a legacy service that uses an outdated protocol, doesn't support TLS, or uses a proprietary discovery mechanism. The ambassador container runs as a proxy that provides modern capabilities to the legacy service.

### Ambassador Implementation

```go
// cmd/ambassador/main.go — proxy for a legacy TCP service
package main

import (
    "context"
    "crypto/tls"
    "fmt"
    "io"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "sync/atomic"
    "syscall"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "ambassador_active_connections",
        Help: "Number of active proxied connections",
    })
    totalConnections = promauto.NewCounter(prometheus.CounterOpts{
        Name: "ambassador_total_connections",
        Help: "Total number of proxied connections",
    })
    connectionErrors = promauto.NewCounter(prometheus.CounterOpts{
        Name: "ambassador_connection_errors_total",
        Help: "Total number of connection errors",
    })
    bytesProxied = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "ambassador_bytes_proxied_total",
        Help: "Total bytes proxied",
    }, []string{"direction"})
)

type AmbassadorConfig struct {
    ListenAddr    string
    BackendAddr   string
    TLSCertFile   string
    TLSKeyFile    string
    MaxConns      int
    DialTimeout   time.Duration
    MetricsAddr   string
}

type Ambassador struct {
    cfg     AmbassadorConfig
    logger  *slog.Logger
    sem     chan struct{}
    closed  atomic.Bool
}

func NewAmbassador(cfg AmbassadorConfig, logger *slog.Logger) *Ambassador {
    return &Ambassador{
        cfg:    cfg,
        logger: logger,
        sem:    make(chan struct{}, cfg.MaxConns),
    }
}

func (a *Ambassador) Run(ctx context.Context) error {
    // Start metrics server
    go a.runMetrics()

    var listener net.Listener
    var err error

    if a.cfg.TLSCertFile != "" {
        cert, err := tls.LoadX509KeyPair(a.cfg.TLSCertFile, a.cfg.TLSKeyFile)
        if err != nil {
            return fmt.Errorf("loading TLS cert: %w", err)
        }
        tlsConfig := &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   tls.VersionTLS12,
        }
        listener, err = tls.Listen("tcp", a.cfg.ListenAddr, tlsConfig)
    } else {
        listener, err = net.Listen("tcp", a.cfg.ListenAddr)
    }
    if err != nil {
        return fmt.Errorf("listening: %w", err)
    }
    defer listener.Close()

    a.logger.Info("ambassador listening",
        "addr", a.cfg.ListenAddr,
        "backend", a.cfg.BackendAddr,
        "tls", a.cfg.TLSCertFile != "",
    )

    // Close listener when context is done
    go func() {
        <-ctx.Done()
        a.closed.Store(true)
        listener.Close()
    }()

    for {
        conn, err := listener.Accept()
        if err != nil {
            if a.closed.Load() {
                return nil
            }
            connectionErrors.Inc()
            a.logger.Error("accept error", "error", err)
            continue
        }

        // Apply connection limit
        select {
        case a.sem <- struct{}{}:
        default:
            a.logger.Warn("connection limit reached, rejecting")
            conn.Close()
            connectionErrors.Inc()
            continue
        }

        go a.handleConnection(ctx, conn)
    }
}

func (a *Ambassador) handleConnection(ctx context.Context, clientConn net.Conn) {
    defer func() {
        clientConn.Close()
        <-a.sem
    }()

    activeConnections.Inc()
    totalConnections.Inc()
    defer activeConnections.Dec()

    // Connect to backend
    dialCtx, cancel := context.WithTimeout(ctx, a.cfg.DialTimeout)
    defer cancel()

    var dialer net.Dialer
    backendConn, err := dialer.DialContext(dialCtx, "tcp", a.cfg.BackendAddr)
    if err != nil {
        a.logger.Error("backend dial failed",
            "backend", a.cfg.BackendAddr,
            "error", err,
        )
        connectionErrors.Inc()
        return
    }
    defer backendConn.Close()

    // Bidirectional copy
    var wg sync.WaitGroup
    wg.Add(2)

    go func() {
        defer wg.Done()
        n, _ := io.Copy(backendConn, clientConn)
        bytesProxied.WithLabelValues("upstream").Add(float64(n))
        // Half-close: signal backend we're done writing
        if tc, ok := backendConn.(*net.TCPConn); ok {
            tc.CloseWrite()
        }
    }()

    go func() {
        defer wg.Done()
        n, _ := io.Copy(clientConn, backendConn)
        bytesProxied.WithLabelValues("downstream").Add(float64(n))
        if tc, ok := clientConn.(*net.TCPConn); ok {
            tc.CloseWrite()
        }
    }()

    wg.Wait()
}

func (a *Ambassador) runMetrics() {
    mux := http.NewServeMux()
    mux.Handle("/metrics", promhttp.Handler())
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })

    srv := &http.Server{
        Addr:    a.cfg.MetricsAddr,
        Handler: mux,
    }

    a.logger.Info("metrics server starting", "addr", a.cfg.MetricsAddr)
    if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
        a.logger.Error("metrics server error", "error", err)
    }
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    cfg := AmbassadorConfig{
        ListenAddr:  getEnv("LISTEN_ADDR", "0.0.0.0:8080"),
        BackendAddr: getEnv("BACKEND_ADDR", "localhost:9000"),
        TLSCertFile: getEnv("TLS_CERT", ""),
        TLSKeyFile:  getEnv("TLS_KEY", ""),
        MaxConns:    1000,
        DialTimeout: 5 * time.Second,
        MetricsAddr: getEnv("METRICS_ADDR", "0.0.0.0:9090"),
    }

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGTERM, syscall.SIGINT)
    defer cancel()

    ambassador := NewAmbassador(cfg, logger)
    if err := ambassador.Run(ctx); err != nil {
        logger.Error("ambassador error", "error", err)
        os.Exit(1)
    }
}

func getEnv(key, fallback string) string {
    if v, ok := os.LookupEnv(key); ok {
        return v
    }
    return fallback
}
```

### Ambassador Pod Spec

```yaml
# legacy-service-with-ambassador.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: legacy-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: legacy-service
  template:
    metadata:
      labels:
        app: legacy-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        # Legacy service running on loopback only
        - name: legacy-app
          image: legacy-app:1.0.0
          ports:
            - containerPort: 9000
              name: tcp-legacy
          # Legacy app only listens on loopback for security
          env:
            - name: BIND_ADDR
              value: "127.0.0.1:9000"

        # Ambassador container provides TLS termination,
        # connection pooling, and metrics
        - name: ambassador
          image: myregistry/ambassador:latest
          env:
            - name: LISTEN_ADDR
              value: "0.0.0.0:8080"
            - name: BACKEND_ADDR
              value: "127.0.0.1:9000"
            - name: TLS_CERT
              value: "/certs/tls.crt"
            - name: TLS_KEY
              value: "/certs/tls.key"
            - name: METRICS_ADDR
              value: "0.0.0.0:9090"
          ports:
            - containerPort: 8080
              name: https
            - containerPort: 9090
              name: metrics
          volumeMounts:
            - name: tls-certs
              mountPath: /certs
              readOnly: true
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 100m
              memory: 64Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 9090
            initialDelaySeconds: 5
            periodSeconds: 10

      volumes:
        - name: tls-certs
          secret:
            secretName: legacy-service-tls
```

## Adapter Pattern: Metrics Normalization

Different applications expose metrics in different formats: StatsD, Graphite, custom JSON, proprietary protocols. The adapter pattern normalizes these formats for a unified observability platform.

### StatsD to Prometheus Adapter

```go
// cmd/metrics-adapter/main.go
package main

import (
    "bytes"
    "context"
    "fmt"
    "log/slog"
    "net"
    "net/http"
    "os"
    "os/signal"
    "strconv"
    "strings"
    "sync"
    "syscall"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

// MetricType represents a StatsD metric type
type MetricType int

const (
    Counter MetricType = iota
    Gauge
    Timer
    Histogram
    Set
)

// MetricSample holds a parsed StatsD sample
type MetricSample struct {
    Name      string
    Value     float64
    Type      MetricType
    SampleRate float64
    Tags      map[string]string
}

// DynamicCollector implements prometheus.Collector for dynamic metrics
type DynamicCollector struct {
    mu       sync.RWMutex
    gauges   map[string]*prometheus.GaugeVec
    counters map[string]*prometheus.CounterVec
    histos   map[string]*prometheus.HistogramVec
    registry *prometheus.Registry
}

func NewDynamicCollector(registry *prometheus.Registry) *DynamicCollector {
    return &DynamicCollector{
        gauges:   make(map[string]*prometheus.GaugeVec),
        counters: make(map[string]*prometheus.CounterVec),
        histos:   make(map[string]*prometheus.HistogramVec),
        registry: registry,
    }
}

func (d *DynamicCollector) Describe(ch chan<- *prometheus.Desc) {
    d.mu.RLock()
    defer d.mu.RUnlock()
    for _, g := range d.gauges {
        g.Describe(ch)
    }
    for _, c := range d.counters {
        c.Describe(ch)
    }
    for _, h := range d.histos {
        h.Describe(ch)
    }
}

func (d *DynamicCollector) Collect(ch chan<- prometheus.Metric) {
    d.mu.RLock()
    defer d.mu.RUnlock()
    for _, g := range d.gauges {
        g.Collect(ch)
    }
    for _, c := range d.counters {
        c.Collect(ch)
    }
    for _, h := range d.histos {
        h.Collect(ch)
    }
}

func (d *DynamicCollector) Record(sample MetricSample) {
    // Normalize metric name: replace . and - with _
    name := normalizeMetricName(sample.Name)
    labelNames, labelValues := tagsToLabels(sample.Tags)

    d.mu.Lock()
    defer d.mu.Unlock()

    switch sample.Type {
    case Counter:
        key := "counter_" + name
        if _, exists := d.counters[key]; !exists {
            cv := prometheus.NewCounterVec(prometheus.CounterOpts{
                Name: name + "_total",
                Help: fmt.Sprintf("Counter metric %s from StatsD", sample.Name),
            }, labelNames)
            d.counters[key] = cv
            d.registry.MustRegister(cv)
        }
        // Apply sample rate
        val := sample.Value / sample.SampleRate
        d.counters[key].WithLabelValues(labelValues...).Add(val)

    case Gauge:
        key := "gauge_" + name
        if _, exists := d.gauges[key]; !exists {
            gv := prometheus.NewGaugeVec(prometheus.GaugeOpts{
                Name: name,
                Help: fmt.Sprintf("Gauge metric %s from StatsD", sample.Name),
            }, labelNames)
            d.gauges[key] = gv
            d.registry.MustRegister(gv)
        }
        d.gauges[key].WithLabelValues(labelValues...).Set(sample.Value)

    case Timer, Histogram:
        key := "histo_" + name
        if _, exists := d.histos[key]; !exists {
            hv := prometheus.NewHistogramVec(prometheus.HistogramOpts{
                Name:    name + "_seconds",
                Help:    fmt.Sprintf("Timer metric %s from StatsD", sample.Name),
                Buckets: prometheus.DefBuckets,
            }, labelNames)
            d.histos[key] = hv
            d.registry.MustRegister(hv)
        }
        // StatsD timers are in milliseconds
        d.histos[key].WithLabelValues(labelValues...).Observe(sample.Value / 1000.0)
    }
}

// StatsDAdapter listens for StatsD UDP packets and converts to Prometheus
type StatsDAdapter struct {
    listenAddr string
    collector  *DynamicCollector
    logger     *slog.Logger
}

func (a *StatsDAdapter) Listen(ctx context.Context) error {
    conn, err := net.ListenPacket("udp", a.listenAddr)
    if err != nil {
        return fmt.Errorf("listening UDP: %w", err)
    }
    defer conn.Close()

    a.logger.Info("StatsD adapter listening", "addr", a.listenAddr)

    buf := make([]byte, 65535)

    go func() {
        <-ctx.Done()
        conn.Close()
    }()

    for {
        n, _, err := conn.ReadFrom(buf)
        if err != nil {
            if ctx.Err() != nil {
                return nil
            }
            a.logger.Error("UDP read error", "error", err)
            continue
        }

        // StatsD can batch multiple metrics in one packet separated by \n
        for _, line := range bytes.Split(buf[:n], []byte("\n")) {
            if len(line) == 0 {
                continue
            }
            sample, err := parseStatsDLine(string(line))
            if err != nil {
                a.logger.Debug("parse error", "line", string(line), "error", err)
                continue
            }
            a.collector.Record(sample)
        }
    }
}

func parseStatsDLine(line string) (MetricSample, error) {
    // Format: metric.name:value|type|@sample_rate|#tag1:val1,tag2:val2
    // DogStatsD extended format with tags
    parts := strings.Split(line, "|")
    if len(parts) < 2 {
        return MetricSample{}, fmt.Errorf("invalid line: %s", line)
    }

    nameValue := strings.SplitN(parts[0], ":", 2)
    if len(nameValue) != 2 {
        return MetricSample{}, fmt.Errorf("invalid name:value: %s", parts[0])
    }

    value, err := strconv.ParseFloat(nameValue[1], 64)
    if err != nil {
        return MetricSample{}, fmt.Errorf("invalid value: %s", nameValue[1])
    }

    sample := MetricSample{
        Name:       nameValue[0],
        Value:      value,
        SampleRate: 1.0,
        Tags:       make(map[string]string),
    }

    switch parts[1] {
    case "c":
        sample.Type = Counter
    case "g":
        sample.Type = Gauge
    case "ms":
        sample.Type = Timer
    case "h":
        sample.Type = Histogram
    case "s":
        sample.Type = Set
    default:
        return MetricSample{}, fmt.Errorf("unknown type: %s", parts[1])
    }

    for _, part := range parts[2:] {
        switch {
        case strings.HasPrefix(part, "@"):
            rate, err := strconv.ParseFloat(part[1:], 64)
            if err == nil && rate > 0 {
                sample.SampleRate = rate
            }
        case strings.HasPrefix(part, "#"):
            // DogStatsD tags: #env:production,service:myapp
            for _, tag := range strings.Split(part[1:], ",") {
                kv := strings.SplitN(tag, ":", 2)
                if len(kv) == 2 {
                    sample.Tags[kv[0]] = kv[1]
                }
            }
        }
    }

    return sample, nil
}

func normalizeMetricName(name string) string {
    replacer := strings.NewReplacer(".", "_", "-", "_", " ", "_")
    return replacer.Replace(name)
}

func tagsToLabels(tags map[string]string) ([]string, []string) {
    names := make([]string, 0, len(tags))
    values := make([]string, 0, len(tags))
    for k, v := range tags {
        names = append(names, normalizeMetricName(k))
        values = append(values, v)
    }
    return names, values
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    registry := prometheus.NewRegistry()
    collector := NewDynamicCollector(registry)

    adapter := &StatsDAdapter{
        listenAddr: getEnv("STATSD_ADDR", "0.0.0.0:8125"),
        collector:  collector,
        logger:     logger,
    }

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGTERM, syscall.SIGINT)
    defer cancel()

    // Start Prometheus metrics server
    go func() {
        mux := http.NewServeMux()
        mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
        mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
            w.WriteHeader(http.StatusOK)
        })
        srv := &http.Server{
            Addr:         getEnv("METRICS_ADDR", "0.0.0.0:9090"),
            Handler:      mux,
            ReadTimeout:  5 * time.Second,
            WriteTimeout: 10 * time.Second,
        }
        logger.Info("metrics server starting", "addr", srv.Addr)
        if err := srv.ListenAndServe(); err != nil {
            logger.Error("metrics server error", "error", err)
        }
    }()

    if err := adapter.Listen(ctx); err != nil {
        logger.Error("adapter error", "error", err)
        os.Exit(1)
    }
}
```

### Adapter Deployment

```yaml
# adapter-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-metrics-adapter
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: statsd-app
  template:
    metadata:
      labels:
        app: statsd-app
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        # Application that emits StatsD metrics
        - name: app
          image: myapp:latest
          env:
            - name: STATSD_HOST
              value: "127.0.0.1"
            - name: STATSD_PORT
              value: "8125"

        # Adapter: converts StatsD UDP to Prometheus HTTP
        - name: metrics-adapter
          image: myregistry/metrics-adapter:latest
          env:
            - name: STATSD_ADDR
              value: "127.0.0.1:8125"
            - name: METRICS_ADDR
              value: "0.0.0.0:9090"
          ports:
            - containerPort: 9090
              name: metrics
          resources:
            requests:
              cpu: 5m
              memory: 16Mi
            limits:
              cpu: 50m
              memory: 64Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 9090
```

## Testing These Patterns

### Unit Testing the ext_proc Server

```go
// ext_proc_test.go
package main

import (
    "context"
    "testing"

    extprocv3 "github.com/envoyproxy/go-control-plane/envoy/service/ext_proc/v3"
    corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "log/slog"
    "os"
)

func TestHandleRequestHeaders_InjectsRequestID(t *testing.T) {
    srv := &ExtProcServer{
        logger: slog.New(slog.NewTextHandler(os.Stderr, nil)),
    }

    headers := &extprocv3.HttpHeaders{
        Headers: &corev3.HeaderMap{
            Headers: []*corev3.HeaderValue{},
        },
    }

    resp := srv.handleRequestHeaders(context.Background(), headers)

    require.NotNil(t, resp)
    reqHeaders := resp.Response.(*extprocv3.ProcessingResponse_RequestHeaders)
    require.NotNil(t, reqHeaders)

    var foundRequestID, foundProcessedBy bool
    for _, h := range reqHeaders.RequestHeaders.Response.HeaderMutation.SetHeaders {
        switch h.Header.Key {
        case "x-request-id":
            foundRequestID = true
            assert.NotEmpty(t, h.Header.Value)
        case "x-processed-by":
            foundProcessedBy = true
            assert.Equal(t, "go-ext-proc", h.Header.Value)
        }
    }

    assert.True(t, foundRequestID, "should inject x-request-id")
    assert.True(t, foundProcessedBy, "should inject x-processed-by")
}

func TestParseStatsDLine(t *testing.T) {
    tests := []struct {
        name     string
        input    string
        expected MetricSample
        wantErr  bool
    }{
        {
            name:  "simple counter",
            input: "api.requests:1|c",
            expected: MetricSample{
                Name: "api.requests", Value: 1, Type: Counter, SampleRate: 1.0,
            },
        },
        {
            name:  "gauge with sample rate",
            input: "memory.usage:512|g|@0.5",
            expected: MetricSample{
                Name: "memory.usage", Value: 512, Type: Gauge, SampleRate: 0.5,
            },
        },
        {
            name:  "timer with tags",
            input: "api.latency:250|ms|#env:production,service:auth",
            expected: MetricSample{
                Name:       "api.latency",
                Value:      250,
                Type:       Timer,
                SampleRate: 1.0,
                Tags:       map[string]string{"env": "production", "service": "auth"},
            },
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got, err := parseStatsDLine(tt.input)
            if tt.wantErr {
                require.Error(t, err)
                return
            }
            require.NoError(t, err)
            assert.Equal(t, tt.expected.Name, got.Name)
            assert.Equal(t, tt.expected.Value, got.Value)
            assert.Equal(t, tt.expected.Type, got.Type)
            assert.Equal(t, tt.expected.SampleRate, got.SampleRate)
            if tt.expected.Tags != nil {
                assert.Equal(t, tt.expected.Tags, got.Tags)
            }
        })
    }
}
```

## Production Considerations

### Resource Sizing

Pattern containers should be sized conservatively since they are helpers, not the primary workload:

```yaml
# Sidecar (ext_proc) — compute light but latency sensitive
resources:
  requests:
    cpu: 10m
    memory: 32Mi
  limits:
    cpu: 200m
    memory: 128Mi

# Ambassador (TCP proxy) — nearly zero CPU, scales with connection count
resources:
  requests:
    cpu: 5m
    memory: 16Mi
  limits:
    cpu: 100m
    memory: 64Mi

# Adapter (metrics format translation) — negligible unless high metric volume
resources:
  requests:
    cpu: 5m
    memory: 16Mi
  limits:
    cpu: 50m
    memory: 64Mi
```

### Health Check Coordination

```yaml
# Use readiness probes to ensure ordering
# The primary container's readiness should NOT depend on sidecar readiness
# The sidecar's readiness should gate traffic via the Service

initContainers:
  - name: wait-for-ambassador
    image: busybox:1.35
    command:
      - sh
      - -c
      - |
        until wget -qO- http://localhost:9090/healthz 2>/dev/null; do
          echo "waiting for ambassador..."
          sleep 2
        done
```

These patterns provide a structured approach to cross-cutting concerns in microservices, enabling teams to evolve infrastructure capabilities without modifying application code.
