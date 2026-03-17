---
title: "Go gRPC Health Checking: Health Protocol, Reflection, and gRPC Server Management"
date: 2030-04-07T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Health Checking", "Kubernetes", "Observability", "Load Balancing", "Protobuf"]
categories: ["Go", "gRPC", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Go gRPC server management: implementing the gRPC health checking protocol, server reflection for tooling, interceptor chains for observability, graceful shutdown, and load balancer integration in production Kubernetes environments."
more_link: "yes"
url: "/go-grpc-health-checking-reflection-server-management/"
---

gRPC is the default choice for high-performance, strongly-typed internal service communication. Most guides cover the basics of defining protobufs, generating code, and implementing handlers. What they skip is the operational layer that separates a gRPC service that runs in a demo from one that runs reliably in production: health checking protocols that load balancers understand, server reflection that enables CLI tooling, interceptor chains that capture metrics, and graceful shutdown that prevents request drops during deployments.

This guide covers the complete operational implementation of a production gRPC server in Go, from the gRPC Health Checking Protocol through to zero-downtime rolling deployments on Kubernetes.

<!--more-->

## The gRPC Operational Stack

A production gRPC service requires several components working in concert:

```
┌────────────────────────────────────────────────────┐
│                    gRPC Server                     │
│                                                    │
│  ┌──────────────┐  ┌──────────────────────────┐   │
│  │  Your Service │  │    Health Check Service  │   │
│  │  Handler     │  │  (grpc_health_v1)        │   │
│  └──────────────┘  └──────────────────────────┘   │
│                                                    │
│  ┌────────────────────────────────────────────┐   │
│  │         Interceptor Chain                  │   │
│  │  Recovery → Auth → Logging → Metrics →     │   │
│  │  Tracing → Timeout → RateLimit             │   │
│  └────────────────────────────────────────────┘   │
│                                                    │
│  ┌──────────────┐  ┌──────────────────────────┐   │
│  │  Reflection  │  │    Admin/Debug Server    │   │
│  │  Service     │  │    (separate port)       │   │
│  └──────────────┘  └──────────────────────────┘   │
└────────────────────────────────────────────────────┘
```

## Project Setup and Dependencies

```bash
go mod init github.com/yourorg/payment-service

# Core gRPC dependencies
go get google.golang.org/grpc
go get google.golang.org/grpc/health
go get google.golang.org/grpc/health/grpc_health_v1
go get google.golang.org/grpc/reflection
go get google.golang.org/grpc/status
go get google.golang.org/grpc/codes
go get google.golang.org/protobuf
go get google.golang.org/grpc/credentials/insecure

# Interceptors
go get github.com/grpc-ecosystem/go-grpc-middleware/v2
go get github.com/grpc-ecosystem/go-grpc-prometheus
go get go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc

# Observability
go get github.com/prometheus/client_golang/prometheus
go get go.uber.org/zap
```

## Protocol Buffer Definition

```protobuf
// proto/payment/v1/payment.proto
syntax = "proto3";

package payment.v1;

option go_package = "github.com/yourorg/payment-service/gen/payment/v1;paymentv1";

import "google/protobuf/timestamp.proto";

service PaymentService {
  // Process a payment
  rpc ProcessPayment(ProcessPaymentRequest) returns (ProcessPaymentResponse);

  // Stream payment status updates
  rpc WatchPaymentStatus(WatchPaymentStatusRequest)
      returns (stream PaymentStatusUpdate);

  // Batch process multiple payments
  rpc BatchProcessPayments(stream ProcessPaymentRequest)
      returns (BatchProcessPaymentsResponse);
}

message ProcessPaymentRequest {
  string idempotency_key = 1;
  string customer_id = 2;
  int64 amount_cents = 3;
  string currency = 4;
  string description = 5;
}

message ProcessPaymentResponse {
  string payment_id = 1;
  string status = 2;
  google.protobuf.Timestamp processed_at = 3;
}

message WatchPaymentStatusRequest {
  string payment_id = 1;
}

message PaymentStatusUpdate {
  string payment_id = 1;
  string status = 2;
  google.protobuf.Timestamp updated_at = 3;
}

message BatchProcessPaymentsResponse {
  int32 total = 1;
  int32 succeeded = 2;
  int32 failed = 3;
  repeated string failed_idempotency_keys = 4;
}
```

```bash
# Generate Go code from proto
buf generate
# or
protoc --go_out=gen --go-grpc_out=gen \
  --go_opt=paths=source_relative \
  --go-grpc_opt=paths=source_relative \
  proto/payment/v1/payment.proto
```

## Implementing the gRPC Health Checking Protocol

The gRPC Health Checking Protocol (defined in `grpc.health.v1`) is the standard mechanism for load balancers and orchestrators to probe service health. It supports per-service health status, not just overall server health.

### Health Check Implementation

```go
// internal/health/checker.go
package health

import (
    "context"
    "database/sql"
    "sync"
    "time"

    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "go.uber.org/zap"
)

// HealthManager manages health status for all registered services
type HealthManager struct {
    server  *health.Server
    logger  *zap.Logger
    checks  map[string]CheckFunc
    mu      sync.RWMutex
    stopCh  chan struct{}
}

// CheckFunc is a function that checks the health of a dependency
type CheckFunc func(ctx context.Context) error

// NewHealthManager creates a new health manager
func NewHealthManager(logger *zap.Logger) *HealthManager {
    server := health.NewServer()
    return &HealthManager{
        server: server,
        logger: logger,
        checks: make(map[string]CheckFunc),
        stopCh: make(chan struct{}),
    }
}

// Server returns the underlying gRPC health server
func (h *HealthManager) Server() *health.Server {
    return h.server
}

// SetServingStatus sets the health status for a named service
func (h *HealthManager) SetServingStatus(service string, serving bool) {
    if serving {
        h.server.SetServingStatus(service, grpc_health_v1.HealthCheckResponse_SERVING)
    } else {
        h.server.SetServingStatus(service, grpc_health_v1.HealthCheckResponse_NOT_SERVING)
    }
}

// RegisterCheck registers a health check function for a service
func (h *HealthManager) RegisterCheck(service string, check CheckFunc) {
    h.mu.Lock()
    defer h.mu.Unlock()
    h.checks[service] = check
    // Start as NOT_SERVING until first successful check
    h.server.SetServingStatus(service, grpc_health_v1.HealthCheckResponse_NOT_SERVING)
}

// StartBackgroundChecks runs registered health checks periodically
func (h *HealthManager) StartBackgroundChecks(interval time.Duration) {
    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        // Run checks immediately on start
        h.runAllChecks()

        for {
            select {
            case <-ticker.C:
                h.runAllChecks()
            case <-h.stopCh:
                return
            }
        }
    }()
}

func (h *HealthManager) runAllChecks() {
    h.mu.RLock()
    checks := make(map[string]CheckFunc, len(h.checks))
    for k, v := range h.checks {
        checks[k] = v
    }
    h.mu.RUnlock()

    for service, check := range checks {
        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        err := check(ctx)
        cancel()

        if err != nil {
            h.logger.Warn("health check failed",
                zap.String("service", service),
                zap.Error(err))
            h.server.SetServingStatus(service,
                grpc_health_v1.HealthCheckResponse_NOT_SERVING)
        } else {
            h.server.SetServingStatus(service,
                grpc_health_v1.HealthCheckResponse_SERVING)
        }
    }
}

// Shutdown marks all services as not serving and stops background checks
func (h *HealthManager) Shutdown() {
    close(h.stopCh)
    h.server.Shutdown()
}

// DatabaseCheck returns a health check function for a SQL database
func DatabaseCheck(db *sql.DB) CheckFunc {
    return func(ctx context.Context) error {
        return db.PingContext(ctx)
    }
}

// RedisCheck returns a health check function for Redis
func RedisCheck(redisClient interface{ Ping(context.Context) error }) CheckFunc {
    return func(ctx context.Context) error {
        return redisClient.Ping(ctx)
    }
}
```

## Interceptor Chain for Observability

### Building the Interceptor Stack

```go
// internal/interceptors/interceptors.go
package interceptors

import (
    "context"
    "time"

    grpcprom "github.com/grpc-ecosystem/go-grpc-prometheus"
    "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/logging"
    "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/recovery"
    "github.com/grpc-ecosystem/go-grpc-middleware/v2/interceptors/timeout"
    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// ServerInterceptors returns the ordered chain of unary server interceptors
func ServerInterceptors(logger *zap.Logger) []grpc.UnaryServerInterceptor {
    return []grpc.UnaryServerInterceptor{
        // 1. Recovery: catch panics and convert to gRPC INTERNAL errors
        recovery.UnaryServerInterceptor(
            recovery.WithRecoveryHandler(recoveryHandler(logger)),
        ),

        // 2. Metrics: capture request counts, latencies, error rates
        grpcprom.UnaryServerInterceptor,

        // 3. Logging: structured request/response logging
        logging.UnaryServerInterceptor(zapLogger(logger),
            logging.WithLogOnEvents(
                logging.FinishCall,  // Log after each call (not on start)
            ),
            logging.WithDurationField(logging.DefaultDurationToFields),
            logging.WithDecider(func(fullMethodName string, err error) logging.Decision {
                // Skip logging for health check calls to reduce noise
                if fullMethodName == "/grpc.health.v1.Health/Check" {
                    return logging.NoLogCall
                }
                return logging.LogFinishCall
            }),
        ),

        // 4. Timeout: enforce per-request deadline
        timeout.UnaryServerInterceptor(30 * time.Second),

        // 5. Authentication
        AuthInterceptor(),
    }
}

// StreamInterceptors returns the ordered chain of streaming server interceptors
func StreamInterceptors(logger *zap.Logger) []grpc.StreamServerInterceptor {
    return []grpc.StreamServerInterceptor{
        recovery.StreamServerInterceptor(
            recovery.WithRecoveryHandler(recoveryHandler(logger)),
        ),
        grpcprom.StreamServerInterceptor,
        logging.StreamServerInterceptor(zapLogger(logger),
            logging.WithLogOnEvents(logging.FinishCall),
        ),
        AuthStreamInterceptor(),
    }
}

// recoveryHandler converts panics to gRPC Internal errors with logging
func recoveryHandler(logger *zap.Logger) recovery.RecoveryHandlerFuncContext {
    return func(ctx context.Context, p interface{}) error {
        logger.Error("gRPC handler panic recovered",
            zap.Any("panic", p),
            zap.Stack("stack"),
        )
        return status.Errorf(codes.Internal, "internal server error")
    }
}

// zapLogger adapts zap.Logger to the grpc-middleware logging interface
func zapLogger(l *zap.Logger) logging.Logger {
    return logging.LoggerFunc(func(ctx context.Context, lvl logging.Level, msg string, fields ...any) {
        f := make([]zap.Field, 0, len(fields)/2)
        for i := 0; i < len(fields)-1; i += 2 {
            key, ok := fields[i].(string)
            if !ok {
                continue
            }
            f = append(f, zap.Any(key, fields[i+1]))
        }
        switch lvl {
        case logging.LevelDebug:
            l.Debug(msg, f...)
        case logging.LevelInfo:
            l.Info(msg, f...)
        case logging.LevelWarn:
            l.Warn(msg, f...)
        case logging.LevelError:
            l.Error(msg, f...)
        }
    })
}
```

### Authentication Interceptor

```go
// internal/interceptors/auth.go
package interceptors

import (
    "context"
    "strings"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

type contextKey string

const (
    callerIDKey   contextKey = "caller_id"
    callerNameKey contextKey = "caller_name"
)

// AuthInterceptor validates bearer tokens on incoming requests
func AuthInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        // Skip auth for health checks and reflection
        if isPublicEndpoint(info.FullMethod) {
            return handler(ctx, req)
        }

        claims, err := extractAndValidateToken(ctx)
        if err != nil {
            return nil, err
        }

        // Inject caller info into context
        ctx = context.WithValue(ctx, callerIDKey, claims.Subject)
        ctx = context.WithValue(ctx, callerNameKey, claims.Name)

        return handler(ctx, req)
    }
}

func AuthStreamInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        if isPublicEndpoint(info.FullMethod) {
            return handler(srv, ss)
        }

        claims, err := extractAndValidateToken(ss.Context())
        if err != nil {
            return err
        }

        ctx := context.WithValue(ss.Context(), callerIDKey, claims.Subject)
        return handler(srv, &wrappedServerStream{ss, ctx})
    }
}

func isPublicEndpoint(method string) bool {
    publicEndpoints := map[string]bool{
        "/grpc.health.v1.Health/Check": true,
        "/grpc.health.v1.Health/Watch": true,
        "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo": true,
        "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo": true,
    }
    return publicEndpoints[method]
}

type tokenClaims struct {
    Subject string
    Name    string
}

func extractAndValidateToken(ctx context.Context) (*tokenClaims, error) {
    md, ok := metadata.FromIncomingContext(ctx)
    if !ok {
        return nil, status.Error(codes.Unauthenticated, "missing metadata")
    }

    authHeader := md.Get("authorization")
    if len(authHeader) == 0 {
        return nil, status.Error(codes.Unauthenticated, "missing authorization header")
    }

    token := strings.TrimPrefix(authHeader[0], "Bearer ")
    if token == authHeader[0] {
        return nil, status.Error(codes.Unauthenticated, "invalid authorization format")
    }

    // Validate JWT token (implementation depends on your auth provider)
    claims, err := validateJWT(token)
    if err != nil {
        return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
    }

    return claims, nil
}

// wrappedServerStream wraps grpc.ServerStream to inject context
type wrappedServerStream struct {
    grpc.ServerStream
    ctx context.Context
}

func (w *wrappedServerStream) Context() context.Context {
    return w.ctx
}

// validateJWT validates a JWT token and returns claims (stub implementation)
func validateJWT(token string) (*tokenClaims, error) {
    // Replace with your actual JWT validation logic (e.g., using golang-jwt/jwt)
    return &tokenClaims{Subject: "service-account", Name: "Service Account"}, nil
}
```

## Server Reflection

Server reflection allows tools like `grpcurl` and `evans` to discover your service's API without having the proto files locally. This is essential for debugging in production environments.

```go
// internal/server/server.go
package server

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "time"

    "github.com/grpc-ecosystem/go-grpc-prometheus"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.uber.org/zap"
    "google.golang.org/grpc"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/keepalive"
    "google.golang.org/grpc/reflection"

    paymentv1 "github.com/yourorg/payment-service/gen/payment/v1"
    "github.com/yourorg/payment-service/internal/health"
    "github.com/yourorg/payment-service/internal/interceptors"
)

// Config holds server configuration
type Config struct {
    GRPCPort    int
    MetricsPort int
    MaxRecvSize int
    MaxSendSize int
    EnableTLS   bool
}

// Server wraps the gRPC server with all production requirements
type Server struct {
    config      Config
    grpcServer  *grpc.Server
    httpServer  *http.Server
    healthMgr   *health.HealthManager
    logger      *zap.Logger
    registry    *prometheus.Registry
}

func New(
    config Config,
    logger *zap.Logger,
    healthMgr *health.HealthManager,
    paymentHandler paymentv1.PaymentServiceServer,
) *Server {
    // Create a custom Prometheus registry (avoids conflicts with global registry)
    registry := prometheus.NewRegistry()
    registry.MustRegister(
        prometheus.NewGoCollector(),
        prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}),
    )

    // Configure gRPC Prometheus metrics with custom registry
    grpcMetrics := grpcprom.NewServerMetrics(
        grpcprom.WithServerHandlingTimeHistogram(
            grpcprom.WithHistogramBuckets([]float64{
                0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
            }),
        ),
    )
    registry.MustRegister(grpcMetrics)

    // Build gRPC server options
    opts := []grpc.ServerOption{
        grpc.ChainUnaryInterceptor(interceptors.ServerInterceptors(logger)...),
        grpc.ChainStreamInterceptor(interceptors.StreamInterceptors(logger)...),

        // Message size limits
        grpc.MaxRecvMsgSize(config.MaxRecvSize),
        grpc.MaxSendMsgSize(config.MaxSendSize),

        // Keep-alive settings for long-lived connections through load balancers
        grpc.KeepaliveParams(keepalive.ServerParameters{
            // Send pings every 30 seconds if no activity
            Time: 30 * time.Second,
            // Wait 10 seconds for the ping ack
            Timeout: 10 * time.Second,
            // Maximum age of any connection (recycle connections)
            MaxConnectionAge: 30 * time.Minute,
            // Grace period for connection draining
            MaxConnectionAgeGrace: 30 * time.Second,
        }),

        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            // Minimum ping interval allowed by clients
            MinTime: 5 * time.Second,
            // Allow pings even when no active streams
            PermitWithoutStream: true,
        }),
    }

    grpcServer := grpc.NewServer(opts...)

    // Register the actual service
    paymentv1.RegisterPaymentServiceServer(grpcServer, paymentHandler)

    // Register health checking service
    grpc_health_v1.RegisterHealthServer(grpcServer, healthMgr.Server())

    // Register server reflection (for grpcurl, evans, etc.)
    // Only enable in non-production or with authentication in production
    reflection.Register(grpcServer)

    // Initialize Prometheus metrics after all services are registered
    grpcMetrics.InitializeMetrics(grpcServer)

    // HTTP server for Prometheus metrics endpoint
    httpMux := http.NewServeMux()
    httpMux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
    httpMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("ok"))
    })

    httpServer := &http.Server{
        Addr:         fmt.Sprintf(":%d", config.MetricsPort),
        Handler:      httpMux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
    }

    return &Server{
        config:     config,
        grpcServer: grpcServer,
        httpServer: httpServer,
        healthMgr:  healthMgr,
        logger:     logger,
        registry:   registry,
    }
}
```

## Graceful Shutdown

Graceful shutdown is critical for zero-downtime deployments. The sequence must be:

1. Mark the service as NOT_SERVING in the health check (stops new requests from being routed)
2. Wait for load balancers to detect the health change and stop routing new traffic
3. Wait for in-flight requests to complete
4. Close the server

```go
// internal/server/server.go (continued)

// Start begins serving gRPC and HTTP requests
func (s *Server) Start() error {
    grpcLis, err := net.Listen("tcp", fmt.Sprintf(":%d", s.config.GRPCPort))
    if err != nil {
        return fmt.Errorf("failed to listen on gRPC port: %w", err)
    }

    s.logger.Info("starting gRPC server",
        zap.Int("grpc_port", s.config.GRPCPort),
        zap.Int("metrics_port", s.config.MetricsPort))

    // Start metrics HTTP server
    go func() {
        if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            s.logger.Error("metrics server failed", zap.Error(err))
        }
    }()

    // Start gRPC server
    if err := s.grpcServer.Serve(grpcLis); err != nil {
        return fmt.Errorf("gRPC server failed: %w", err)
    }
    return nil
}

// Shutdown performs graceful server shutdown
func (s *Server) Shutdown(ctx context.Context) error {
    s.logger.Info("initiating graceful shutdown")

    // Step 1: Mark ALL services as NOT_SERVING
    // This tells load balancers and Kubernetes to stop routing new requests
    s.healthMgr.Shutdown()
    s.logger.Info("health check marked as not serving")

    // Step 2: Wait for load balancers to detect the health change
    // This gives time for:
    // - Health check probes to fail (typically 3 x probe_period)
    // - Connection draining to begin
    // The exact duration depends on your load balancer configuration
    drainDelay := 15 * time.Second
    s.logger.Info("waiting for load balancer drain",
        zap.Duration("delay", drainDelay))

    select {
    case <-time.After(drainDelay):
    case <-ctx.Done():
        s.logger.Warn("drain wait cancelled by context deadline")
    }

    // Step 3: Begin graceful stop - stops accepting new connections,
    // waits for in-flight RPCs to complete
    shutdownComplete := make(chan struct{})
    go func() {
        s.logger.Info("waiting for in-flight RPCs to complete")
        s.grpcServer.GracefulStop()
        close(shutdownComplete)
    }()

    select {
    case <-shutdownComplete:
        s.logger.Info("gRPC server shutdown complete")
    case <-ctx.Done():
        s.logger.Warn("graceful stop timed out, forcing shutdown")
        s.grpcServer.Stop()
    }

    // Step 4: Shutdown metrics HTTP server
    httpCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    return s.httpServer.Shutdown(httpCtx)
}
```

## Main Function with Signal Handling

```go
// cmd/server/main.go
package main

import (
    "context"
    "database/sql"
    "fmt"
    "os"
    "os/signal"
    "syscall"
    "time"

    _ "github.com/jackc/pgx/v5/stdlib"
    "go.uber.org/zap"

    "github.com/yourorg/payment-service/internal/health"
    "github.com/yourorg/payment-service/internal/handler"
    "github.com/yourorg/payment-service/internal/repository"
    "github.com/yourorg/payment-service/internal/server"
)

func main() {
    logger, err := zap.NewProduction()
    if err != nil {
        fmt.Fprintf(os.Stderr, "failed to create logger: %v\n", err)
        os.Exit(1)
    }
    defer logger.Sync()

    // Connect to database
    db, err := sql.Open("pgx", os.Getenv("DATABASE_URL"))
    if err != nil {
        logger.Fatal("failed to open database", zap.Error(err))
    }
    defer db.Close()

    db.SetMaxOpenConns(20)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)

    // Set up health manager
    healthMgr := health.NewHealthManager(logger)
    healthMgr.RegisterCheck("payment.v1.PaymentService", health.DatabaseCheck(db))

    // Start background health checks every 10 seconds
    healthMgr.StartBackgroundChecks(10 * time.Second)

    // Initialize repository and handlers
    repo := repository.NewPaymentRepository(db)
    paymentHandler := handler.NewPaymentHandler(repo, logger)

    // Create and configure server
    srv := server.New(
        server.Config{
            GRPCPort:    8080,
            MetricsPort: 9090,
            MaxRecvSize: 4 * 1024 * 1024,  // 4 MB
            MaxSendSize: 4 * 1024 * 1024,  // 4 MB
        },
        logger,
        healthMgr,
        paymentHandler,
    )

    // Start server in background
    startErr := make(chan error, 1)
    go func() {
        if err := srv.Start(); err != nil {
            startErr <- err
        }
    }()

    // Wait for shutdown signal or error
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

    select {
    case sig := <-sigCh:
        logger.Info("received shutdown signal", zap.String("signal", sig.String()))
    case err := <-startErr:
        logger.Error("server startup failed", zap.Error(err))
        os.Exit(1)
    }

    // Graceful shutdown with 60 second timeout
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
    defer cancel()

    if err := srv.Shutdown(shutdownCtx); err != nil {
        logger.Error("graceful shutdown failed", zap.Error(err))
        os.Exit(1)
    }

    logger.Info("server shutdown complete")
}
```

## Kubernetes Integration

### Service and Deployment Configuration

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payment-service
  template:
    metadata:
      labels:
        app: payment-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      terminationGracePeriodSeconds: 90

      containers:
        - name: payment-service
          image: your-registry/payment-service:latest

          ports:
            - name: grpc
              containerPort: 8080
              protocol: TCP
            - name: metrics
              containerPort: 9090
              protocol: TCP

          # gRPC health probe using the standard protocol
          livenessProbe:
            grpc:
              port: 8080
              service: "payment.v1.PaymentService"
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
            timeoutSeconds: 5

          readinessProbe:
            grpc:
              port: 8080
              service: "payment.v1.PaymentService"
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 2
            timeoutSeconds: 3

          # Ensure SIGTERM is received first
          lifecycle:
            preStop:
              exec:
                # Give the health check time to propagate NOT_SERVING
                # before Kubernetes removes this pod from service endpoints
                command: ["/bin/sleep", "10"]

          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"

          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: payment-service-secrets
                  key: database_url

      # Spread pods across nodes for availability
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: payment-service
---
apiVersion: v1
kind: Service
metadata:
  name: payment-service
  namespace: payments
  annotations:
    # For AWS NLB with health checking support
    service.beta.kubernetes.io/aws-load-balancer-type: "nlb"
    service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol: "TCP"
spec:
  selector:
    app: payment-service
  ports:
    - name: grpc
      protocol: TCP
      port: 443
      targetPort: 8080
  type: ClusterIP
```

### PodDisruptionBudget for Zero-Downtime Deployments

```yaml
# k8s/pdb.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: payments
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: payment-service
```

## Testing gRPC Services

### Integration Test with Test Server

```go
// internal/handler/payment_handler_test.go
package handler_test

import (
    "context"
    "net"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/status"
    "google.golang.org/grpc/test/bufconn"

    paymentv1 "github.com/yourorg/payment-service/gen/payment/v1"
)

const bufSize = 1024 * 1024

func startTestServer(t *testing.T, handler paymentv1.PaymentServiceServer) paymentv1.PaymentServiceClient {
    t.Helper()

    lis := bufconn.Listen(bufSize)
    t.Cleanup(func() { lis.Close() })

    srv := grpc.NewServer()
    paymentv1.RegisterPaymentServiceServer(srv, handler)

    go func() {
        if err := srv.Serve(lis); err != nil {
            t.Logf("test server stopped: %v", err)
        }
    }()
    t.Cleanup(srv.Stop)

    conn, err := grpc.NewClient(
        "passthrough://bufnet",
        grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
            return lis.DialContext(ctx)
        }),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    require.NoError(t, err)
    t.Cleanup(func() { conn.Close() })

    return paymentv1.NewPaymentServiceClient(conn)
}

func TestPaymentHandler_ProcessPayment(t *testing.T) {
    t.Run("valid payment returns payment ID", func(t *testing.T) {
        handler := &mockPaymentHandler{
            processFunc: func(ctx context.Context, req *paymentv1.ProcessPaymentRequest) (*paymentv1.ProcessPaymentResponse, error) {
                return &paymentv1.ProcessPaymentResponse{
                    PaymentId: "pay_12345",
                    Status:    "succeeded",
                }, nil
            },
        }

        client := startTestServer(t, handler)

        resp, err := client.ProcessPayment(context.Background(), &paymentv1.ProcessPaymentRequest{
            IdempotencyKey: "idem_001",
            CustomerId:     "cust_123",
            AmountCents:    1000,
            Currency:       "USD",
        })

        require.NoError(t, err)
        assert.Equal(t, "pay_12345", resp.PaymentId)
        assert.Equal(t, "succeeded", resp.Status)
    })

    t.Run("invalid amount returns InvalidArgument", func(t *testing.T) {
        handler := &mockPaymentHandler{
            processFunc: func(ctx context.Context, req *paymentv1.ProcessPaymentRequest) (*paymentv1.ProcessPaymentResponse, error) {
                return nil, status.Error(codes.InvalidArgument, "amount must be positive")
            },
        }

        client := startTestServer(t, handler)

        _, err := client.ProcessPayment(context.Background(), &paymentv1.ProcessPaymentRequest{
            AmountCents: -100,
        })

        require.Error(t, err)
        st, ok := status.FromError(err)
        require.True(t, ok)
        assert.Equal(t, codes.InvalidArgument, st.Code())
    })
}
```

## Using grpcurl for Debugging

```bash
# List all services (requires reflection)
grpcurl -plaintext localhost:8080 list

# Describe a service
grpcurl -plaintext localhost:8080 describe payment.v1.PaymentService

# Call a method
grpcurl -plaintext \
    -H 'authorization: Bearer <token>' \
    -d '{"idempotency_key": "test-001", "customer_id": "cust-123", "amount_cents": 1000, "currency": "USD"}' \
    localhost:8080 \
    payment.v1.PaymentService/ProcessPayment

# Health check via gRPC protocol
grpcurl -plaintext \
    -d '{"service": "payment.v1.PaymentService"}' \
    localhost:8080 \
    grpc.health.v1.Health/Check
```

## Key Takeaways

Production gRPC servers require substantially more than a handler implementation:

1. **The gRPC Health Checking Protocol** is the correct mechanism for Kubernetes probes and load balancer health checks — not HTTP endpoints. The per-service granularity (`grpc.health.v1.Health/Check` with `service` field set) enables fine-grained health reporting when a service has multiple dependencies that could fail independently.

2. **Graceful shutdown sequencing matters precisely**. Mark health checks as NOT_SERVING first, wait for load balancers to drain (typically 10-15 seconds), then call `GracefulStop()`. Skipping the drain wait causes connection resets on in-flight requests during deployments.

3. **The interceptor chain should be ordered by failure surface**. Recovery comes first (catches panics in subsequent interceptors), then metrics (needs to record all requests), then logging, then auth (most expensive and most common early failure), then timeout (protects downstream).

4. **Server reflection** should be enabled with authentication in production. It is invaluable for debugging live services with `grpcurl` and `evans` but should not be freely accessible without authentication in security-sensitive environments.

5. **Keep-alive parameters** are non-negotiable when gRPC services sit behind load balancers. TCP connections that appear idle to a load balancer will be terminated unless keep-alive pings maintain them. The `MaxConnectionAge` parameter forces periodic connection recycling which distributes load properly across replicas.
