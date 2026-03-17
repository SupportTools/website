---
title: "Go gRPC Health Checking: Standard Protocol and Kubernetes Probes"
date: 2029-10-03T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Kubernetes", "Health Checks", "Observability", "Production"]
categories: ["Go", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to implementing the gRPC Health Checking Protocol in Go services, including the grpc.health.v1 service, Kubernetes gRPC probe support (1.24+), health check aggregation, and dependency health monitoring patterns."
more_link: "yes"
url: "/go-grpc-health-checking-kubernetes-probes/"
---

The gRPC Health Checking Protocol is a standardized interface for service health that integrates naturally with Kubernetes liveness and readiness probes. Introduced by Google and implemented across all major gRPC ecosystems, the protocol defines a simple but powerful health checking service that supports per-service granularity — allowing a server hosting multiple gRPC services to report their health independently.

Kubernetes 1.24 added native gRPC probe support, eliminating the need for wrapper sidecar containers or HTTP health endpoints alongside gRPC services. This guide covers the complete implementation: the health server, per-dependency tracking, Kubernetes probe integration, and aggregation patterns for complex service graphs.

<!--more-->

# Go gRPC Health Checking: Standard Protocol and Kubernetes Probes

## Section 1: The gRPC Health Checking Protocol

The [gRPC Health Checking Protocol](https://github.com/grpc/grpc/blob/master/doc/health-checking.md) defines a standard gRPC service:

```protobuf
syntax = "proto3";

package grpc.health.v1;

message HealthCheckRequest {
  string service = 1;
}

message HealthCheckResponse {
  enum ServingStatus {
    UNKNOWN = 0;
    SERVING = 1;
    NOT_SERVING = 2;
    SERVICE_UNKNOWN = 3;  // Used only by Watch()
  }
  ServingStatus status = 1;
}

service Health {
  // Unary health check
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);

  // Server-streaming health watch
  rpc Watch(HealthCheckRequest) returns (stream HealthCheckResponse);
}
```

The `service` field in the request can be:
- Empty string `""` — checks overall server health
- A fully qualified service name like `"mypackage.MyService"` — checks a specific service

## Section 2: Basic Health Server Implementation

Go's `google.golang.org/grpc/health` package provides a reference implementation:

```go
package main

import (
    "context"
    "fmt"
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"

    "google.golang.org/grpc"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/reflection"

    pb "github.com/example/myservice/proto"
)

func main() {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatalf("Failed to listen: %v", err)
    }

    // Create the gRPC server
    server := grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            loggingInterceptor,
            recoverInterceptor,
        ),
    )

    // Register your service
    myService := NewMyService()
    pb.RegisterMyServiceServer(server, myService)

    // Register the health service
    healthServer := health.NewServer()
    grpc_health_v1.RegisterHealthServer(server, healthServer)

    // Enable reflection (optional but useful for grpc_health_probe)
    reflection.Register(server)

    // Set initial health status
    // Empty string "" represents the overall server health
    healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
    healthServer.SetServingStatus(
        "mypackage.MyService",
        grpc_health_v1.HealthCheckResponse_SERVING,
    )

    // Graceful shutdown
    ctx, stop := signal.NotifyContext(context.Background(),
        syscall.SIGTERM, syscall.SIGINT)
    defer stop()

    go func() {
        <-ctx.Done()
        log.Println("Shutting down gRPC server...")

        // Mark service as not serving before shutdown
        healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)
        healthServer.SetServingStatus(
            "mypackage.MyService",
            grpc_health_v1.HealthCheckResponse_NOT_SERVING,
        )

        server.GracefulStop()
    }()

    log.Printf("gRPC server listening on :50051")
    if err := server.Serve(lis); err != nil {
        log.Fatalf("Failed to serve: %v", err)
    }
}
```

## Section 3: Health Server with Dependency Tracking

Production services depend on databases, caches, and upstream APIs. A health server that tracks these dependencies provides meaningful health status:

```go
package health

import (
    "context"
    "fmt"
    "sync"
    "time"

    "google.golang.org/grpc/health/grpc_health_v1"
)

// Checker is a function that checks a dependency's health.
type Checker func(ctx context.Context) error

// DependencyHealthServer extends the basic health server with
// dependency tracking and automatic status updates.
type DependencyHealthServer struct {
    grpc_health_v1.UnimplementedHealthServer

    mu           sync.RWMutex
    statuses     map[string]grpc_health_v1.HealthCheckResponse_ServingStatus
    dependencies map[string]Checker
    interval     time.Duration
}

func NewDependencyHealthServer(checkInterval time.Duration) *DependencyHealthServer {
    s := &DependencyHealthServer{
        statuses:     make(map[string]grpc_health_v1.HealthCheckResponse_ServingStatus),
        dependencies: make(map[string]Checker),
        interval:     checkInterval,
    }

    // Set default status
    s.statuses[""] = grpc_health_v1.HealthCheckResponse_SERVING
    return s
}

// RegisterDependency adds a health checker for a named dependency.
func (s *DependencyHealthServer) RegisterDependency(name string, checker Checker) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.dependencies[name] = checker
}

// RegisterService marks a gRPC service as tracked.
func (s *DependencyHealthServer) RegisterService(serviceName string) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.statuses[serviceName] = grpc_health_v1.HealthCheckResponse_SERVING
}

// Check implements grpc_health_v1.HealthServer.
func (s *DependencyHealthServer) Check(
    ctx context.Context,
    req *grpc_health_v1.HealthCheckRequest,
) (*grpc_health_v1.HealthCheckResponse, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    status, ok := s.statuses[req.Service]
    if !ok {
        return &grpc_health_v1.HealthCheckResponse{
            Status: grpc_health_v1.HealthCheckResponse_SERVICE_UNKNOWN,
        }, nil
    }

    return &grpc_health_v1.HealthCheckResponse{Status: status}, nil
}

// Watch implements grpc_health_v1.HealthServer for streaming health updates.
func (s *DependencyHealthServer) Watch(
    req *grpc_health_v1.HealthCheckRequest,
    stream grpc_health_v1.Health_WatchServer,
) error {
    // Send initial status
    status, err := s.Check(stream.Context(), &grpc_health_v1.HealthCheckRequest{
        Service: req.Service,
    })
    if err != nil {
        return err
    }

    if err := stream.Send(status); err != nil {
        return err
    }

    // Poll for status changes
    ticker := time.NewTicker(s.interval)
    defer ticker.Stop()

    lastStatus := status.Status
    for {
        select {
        case <-stream.Context().Done():
            return nil
        case <-ticker.C:
            current, err := s.Check(stream.Context(), &grpc_health_v1.HealthCheckRequest{
                Service: req.Service,
            })
            if err != nil {
                return err
            }

            // Only send if status changed
            if current.Status != lastStatus {
                if err := stream.Send(current); err != nil {
                    return err
                }
                lastStatus = current.Status
            }
        }
    }
}

// StartChecking begins background health checks for all registered dependencies.
func (s *DependencyHealthServer) StartChecking(ctx context.Context) {
    go func() {
        ticker := time.NewTicker(s.interval)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                s.runChecks(ctx)
            }
        }
    }()

    // Run immediately on startup
    s.runChecks(ctx)
}

func (s *DependencyHealthServer) runChecks(ctx context.Context) {
    s.mu.RLock()
    deps := make(map[string]Checker, len(s.dependencies))
    for k, v := range s.dependencies {
        deps[k] = v
    }
    s.mu.RUnlock()

    results := make(map[string]error)
    var mu sync.Mutex
    var wg sync.WaitGroup

    for name, checker := range deps {
        wg.Add(1)
        go func(n string, c Checker) {
            defer wg.Done()
            checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
            defer cancel()

            err := c(checkCtx)
            mu.Lock()
            results[n] = err
            mu.Unlock()
        }(name, checker)
    }

    wg.Wait()

    // Update statuses based on results
    s.mu.Lock()
    defer s.mu.Unlock()

    allHealthy := true
    for name, err := range results {
        if err != nil {
            log.Printf("Dependency %s unhealthy: %v", name, err)
            s.statuses["dep:"+name] = grpc_health_v1.HealthCheckResponse_NOT_SERVING
            allHealthy = false
        } else {
            s.statuses["dep:"+name] = grpc_health_v1.HealthCheckResponse_SERVING
        }
    }

    // Overall server health depends on all dependencies
    if allHealthy {
        s.statuses[""] = grpc_health_v1.HealthCheckResponse_SERVING
    } else {
        s.statuses[""] = grpc_health_v1.HealthCheckResponse_NOT_SERVING
    }
}
```

## Section 4: Dependency Checkers

```go
package checkers

import (
    "context"
    "database/sql"
    "fmt"
    "net/http"
    "time"

    "github.com/redis/go-redis/v9"
    "google.golang.org/grpc"
    "google.golang.org/grpc/health/grpc_health_v1"
)

// PostgresChecker checks PostgreSQL connectivity.
func PostgresChecker(db *sql.DB) func(ctx context.Context) error {
    return func(ctx context.Context) error {
        if err := db.PingContext(ctx); err != nil {
            return fmt.Errorf("postgres ping failed: %w", err)
        }

        // Also check that a simple query works
        var result int
        row := db.QueryRowContext(ctx, "SELECT 1")
        if err := row.Scan(&result); err != nil {
            return fmt.Errorf("postgres query failed: %w", err)
        }

        return nil
    }
}

// RedisChecker checks Redis connectivity.
func RedisChecker(client *redis.Client) func(ctx context.Context) error {
    return func(ctx context.Context) error {
        if err := client.Ping(ctx).Err(); err != nil {
            return fmt.Errorf("redis ping failed: %w", err)
        }
        return nil
    }
}

// HTTPChecker checks an HTTP endpoint.
func HTTPChecker(url string) func(ctx context.Context) error {
    httpClient := &http.Client{
        Timeout: 5 * time.Second,
    }

    return func(ctx context.Context) error {
        req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        if err != nil {
            return fmt.Errorf("failed to create request: %w", err)
        }

        resp, err := httpClient.Do(req)
        if err != nil {
            return fmt.Errorf("HTTP request failed: %w", err)
        }
        resp.Body.Close()

        if resp.StatusCode >= 500 {
            return fmt.Errorf("upstream returned %d", resp.StatusCode)
        }
        return nil
    }
}

// GRPCChecker checks a downstream gRPC service using the health protocol.
func GRPCChecker(conn *grpc.ClientConn, serviceName string) func(ctx context.Context) error {
    healthClient := grpc_health_v1.NewHealthClient(conn)

    return func(ctx context.Context) error {
        resp, err := healthClient.Check(ctx, &grpc_health_v1.HealthCheckRequest{
            Service: serviceName,
        })
        if err != nil {
            return fmt.Errorf("health check RPC failed: %w", err)
        }

        if resp.Status != grpc_health_v1.HealthCheckResponse_SERVING {
            return fmt.Errorf("service %q is %s", serviceName, resp.Status)
        }

        return nil
    }
}

// ThresholdChecker wraps a checker and only reports unhealthy after
// N consecutive failures. This prevents flapping.
func ThresholdChecker(checker func(ctx context.Context) error, threshold int) func(ctx context.Context) error {
    var failures int
    var mu sync.Mutex

    return func(ctx context.Context) error {
        err := checker(ctx)

        mu.Lock()
        defer mu.Unlock()

        if err != nil {
            failures++
            if failures >= threshold {
                return err
            }
            log.Printf("Health check failed (%d/%d): %v", failures, threshold, err)
            return nil // Not yet at threshold
        }

        failures = 0
        return nil
    }
}
```

## Section 5: Kubernetes gRPC Probe Configuration

Kubernetes 1.24+ supports native gRPC probes without needing grpc_health_probe sidecar:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grpc-service
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: grpc-service
          image: myservice:v2.0.0
          ports:
            - name: grpc
              containerPort: 50051
              protocol: TCP

          # Startup probe: allow up to 60s for the service to start
          startupProbe:
            grpc:
              port: 50051
              service: ""  # Check overall server health
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 12  # 60 seconds total (12 * 5s)
            successThreshold: 1

          # Readiness probe: service is ready to receive traffic
          readinessProbe:
            grpc:
              port: 50051
              service: "mypackage.MyService"  # Check specific service
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
            successThreshold: 1
            timeoutSeconds: 5

          # Liveness probe: restart if the service is stuck
          livenessProbe:
            grpc:
              port: 50051
              service: ""
            initialDelaySeconds: 30
            periodSeconds: 30
            failureThreshold: 3
            successThreshold: 1
            timeoutSeconds: 10

          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
```

### Separate Health Port

For services that should remain reachable for health checks during graceful shutdown, use a dedicated health port:

```yaml
containers:
  - name: grpc-service
    ports:
      - name: grpc
        containerPort: 50051
      - name: health
        containerPort: 50052  # Dedicated health port

    livenessProbe:
      grpc:
        port: 50052  # Health port stays open longer during shutdown
      periodSeconds: 10

    readinessProbe:
      grpc:
        port: 50052
      periodSeconds: 5
```

```go
// Two-server pattern: main gRPC + dedicated health server
func main() {
    // Main service server
    mainServer := grpc.NewServer(
        grpc.ChainUnaryInterceptor(authInterceptor, loggingInterceptor),
    )
    pb.RegisterMyServiceServer(mainServer, &myServiceImpl{})

    // Dedicated health server (no auth interceptors — health checks are unauthenticated)
    healthGRPCServer := grpc.NewServer()
    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(healthGRPCServer, healthSrv)

    var wg sync.WaitGroup

    // Start main server
    wg.Add(1)
    go func() {
        defer wg.Done()
        mainLis, err := net.Listen("tcp", ":50051")
        if err != nil {
            log.Fatalf("main listen: %v", err)
        }
        if err := mainServer.Serve(mainLis); err != nil {
            log.Printf("main server stopped: %v", err)
        }
    }()

    // Start health server
    wg.Add(1)
    go func() {
        defer wg.Done()
        healthLis, err := net.Listen("tcp", ":50052")
        if err != nil {
            log.Fatalf("health listen: %v", err)
        }
        if err := healthGRPCServer.Serve(healthLis); err != nil {
            log.Printf("health server stopped: %v", err)
        }
    }()

    // Graceful shutdown sequence
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
    defer stop()

    <-ctx.Done()

    // 1. Mark as not serving (stop receiving new traffic)
    healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

    // 2. Allow in-flight requests to complete (grace period)
    time.Sleep(5 * time.Second)

    // 3. Stop accepting new connections
    mainServer.GracefulStop()

    // 4. Shut down health server last
    healthGRPCServer.GracefulStop()

    wg.Wait()
}
```

## Section 6: Pre-Kubernetes 1.24 Health Checking

For clusters running Kubernetes < 1.24, use `grpc_health_probe` as an exec probe:

```yaml
# For older Kubernetes versions that don't support gRPC probes natively
containers:
  - name: grpc-service
    image: myservice:v2.0.0
    livenessProbe:
      exec:
        command:
          - /bin/grpc_health_probe
          - -addr=:50051
          - -service=mypackage.MyService
          - -connect-timeout=5s
          - -rpc-timeout=10s
      initialDelaySeconds: 30
      periodSeconds: 30
    readinessProbe:
      exec:
        command:
          - /bin/grpc_health_probe
          - -addr=:50051
          - -service=mypackage.MyService
      initialDelaySeconds: 5
      periodSeconds: 10
```

Including grpc_health_probe in your Docker image:

```dockerfile
FROM golang:1.22 AS health-probe
RUN GRPC_HEALTH_PROBE_VERSION=v0.4.24 && \
    wget -qO/bin/grpc_health_probe https://github.com/grpc-ecosystem/grpc-health-probe/releases/download/${GRPC_HEALTH_PROBE_VERSION}/grpc_health_probe-linux-amd64 && \
    chmod +x /bin/grpc_health_probe

FROM gcr.io/distroless/static-debian12
COPY --from=health-probe /bin/grpc_health_probe /bin/grpc_health_probe
COPY --from=builder /app/myservice /app/myservice
ENTRYPOINT ["/app/myservice"]
```

## Section 7: Health Check Aggregation

For microservices architectures, a health aggregator service can provide a holistic view:

```go
package aggregator

import (
    "context"
    "fmt"
    "sync"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/health/grpc_health_v1"
)

// ServiceEndpoint describes a service to check.
type ServiceEndpoint struct {
    Name        string
    Address     string
    ServiceName string
    Critical    bool // If true, failure marks overall health as unhealthy
}

// AggregatedStatus represents the health of all monitored services.
type AggregatedStatus struct {
    Overall   grpc_health_v1.HealthCheckResponse_ServingStatus
    Services  map[string]ServiceStatus
    CheckedAt time.Time
}

type ServiceStatus struct {
    Status  grpc_health_v1.HealthCheckResponse_ServingStatus
    Error   string
    Latency time.Duration
}

// HealthAggregator checks multiple gRPC services and aggregates results.
type HealthAggregator struct {
    endpoints []ServiceEndpoint
    conns     map[string]*grpc.ClientConn
    mu        sync.RWMutex
}

func NewHealthAggregator(endpoints []ServiceEndpoint) (*HealthAggregator, error) {
    a := &HealthAggregator{
        endpoints: endpoints,
        conns:     make(map[string]*grpc.ClientConn),
    }

    for _, ep := range endpoints {
        conn, err := grpc.Dial(ep.Address,
            grpc.WithTransportCredentials(insecure.NewCredentials()),
            grpc.WithBlock(),
            grpc.WithTimeout(5*time.Second),
        )
        if err != nil {
            return nil, fmt.Errorf("failed to connect to %s: %w", ep.Name, err)
        }
        a.conns[ep.Name] = conn
    }

    return a, nil
}

func (a *HealthAggregator) CheckAll(ctx context.Context) *AggregatedStatus {
    status := &AggregatedStatus{
        Overall:   grpc_health_v1.HealthCheckResponse_SERVING,
        Services:  make(map[string]ServiceStatus),
        CheckedAt: time.Now(),
    }

    var mu sync.Mutex
    var wg sync.WaitGroup

    for _, ep := range a.endpoints {
        wg.Add(1)
        go func(endpoint ServiceEndpoint) {
            defer wg.Done()

            checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
            defer cancel()

            start := time.Now()
            conn := a.conns[endpoint.Name]
            client := grpc_health_v1.NewHealthClient(conn)

            resp, err := client.Check(checkCtx, &grpc_health_v1.HealthCheckRequest{
                Service: endpoint.ServiceName,
            })

            latency := time.Since(start)

            svcStatus := ServiceStatus{
                Latency: latency,
                Status:  grpc_health_v1.HealthCheckResponse_UNKNOWN,
            }

            if err != nil {
                svcStatus.Error = err.Error()
                svcStatus.Status = grpc_health_v1.HealthCheckResponse_NOT_SERVING
            } else {
                svcStatus.Status = resp.Status
            }

            mu.Lock()
            status.Services[endpoint.Name] = svcStatus

            if endpoint.Critical &&
                svcStatus.Status != grpc_health_v1.HealthCheckResponse_SERVING {
                status.Overall = grpc_health_v1.HealthCheckResponse_NOT_SERVING
            }
            mu.Unlock()
        }(ep)
    }

    wg.Wait()
    return status
}

func (a *HealthAggregator) Close() {
    for _, conn := range a.conns {
        conn.Close()
    }
}
```

### HTTP Health Endpoint Exposing gRPC Status

Many organizations need an HTTP health endpoint alongside gRPC for compatibility with older infrastructure:

```go
package main

import (
    "encoding/json"
    "net/http"

    "google.golang.org/grpc/health/grpc_health_v1"
)

func healthHTTPHandler(aggregator *HealthAggregator) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        status := aggregator.CheckAll(r.Context())

        response := map[string]interface{}{
            "status":     statusString(status.Overall),
            "checked_at": status.CheckedAt.Format(time.RFC3339),
            "services":   make(map[string]interface{}),
        }

        for name, svc := range status.Services {
            svcMap := map[string]interface{}{
                "status":      statusString(svc.Status),
                "latency_ms":  svc.Latency.Milliseconds(),
            }
            if svc.Error != "" {
                svcMap["error"] = svc.Error
            }
            response["services"].(map[string]interface{})[name] = svcMap
        }

        w.Header().Set("Content-Type", "application/json")

        if status.Overall != grpc_health_v1.HealthCheckResponse_SERVING {
            w.WriteHeader(http.StatusServiceUnavailable)
        }

        json.NewEncoder(w).Encode(response)
    }
}

func statusString(s grpc_health_v1.HealthCheckResponse_ServingStatus) string {
    switch s {
    case grpc_health_v1.HealthCheckResponse_SERVING:
        return "serving"
    case grpc_health_v1.HealthCheckResponse_NOT_SERVING:
        return "not_serving"
    case grpc_health_v1.HealthCheckResponse_SERVICE_UNKNOWN:
        return "unknown"
    default:
        return "unknown"
    }
}
```

## Section 8: Testing Health Checks

```go
package health_test

import (
    "context"
    "net"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/grpc/health"
    "google.golang.org/grpc/health/grpc_health_v1"
)

func TestHealthServer_ReturnsServingByDefault(t *testing.T) {
    // Start a test server
    lis, err := net.Listen("tcp", "127.0.0.1:0")
    require.NoError(t, err)

    server := grpc.NewServer()
    healthSrv := health.NewServer()
    grpc_health_v1.RegisterHealthServer(server, healthSrv)

    healthSrv.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
    healthSrv.SetServingStatus("test.Service", grpc_health_v1.HealthCheckResponse_SERVING)

    go server.Serve(lis)
    defer server.Stop()

    // Connect to the test server
    conn, err := grpc.Dial(lis.Addr().String(),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    require.NoError(t, err)
    defer conn.Close()

    client := grpc_health_v1.NewHealthClient(conn)

    // Check overall health
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resp, err := client.Check(ctx, &grpc_health_v1.HealthCheckRequest{Service: ""})
    require.NoError(t, err)
    assert.Equal(t, grpc_health_v1.HealthCheckResponse_SERVING, resp.Status)

    // Check specific service
    resp, err = client.Check(ctx, &grpc_health_v1.HealthCheckRequest{
        Service: "test.Service",
    })
    require.NoError(t, err)
    assert.Equal(t, grpc_health_v1.HealthCheckResponse_SERVING, resp.Status)
}

func TestHealthServer_DependencyFailureMakesUnhealthy(t *testing.T) {
    lis, err := net.Listen("tcp", "127.0.0.1:0")
    require.NoError(t, err)

    server := grpc.NewServer()

    failCount := 0
    healthSrv := NewDependencyHealthServer(100 * time.Millisecond)
    healthSrv.RegisterDependency("database", func(ctx context.Context) error {
        failCount++
        if failCount >= 2 {
            return fmt.Errorf("database connection refused")
        }
        return nil
    })

    grpc_health_v1.RegisterHealthServer(server, healthSrv)
    go server.Serve(lis)
    defer server.Stop()

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    healthSrv.StartChecking(ctx)

    conn, err := grpc.Dial(lis.Addr().String(),
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    require.NoError(t, err)
    defer conn.Close()

    client := grpc_health_v1.NewHealthClient(conn)

    // Initially healthy
    resp, err := client.Check(ctx, &grpc_health_v1.HealthCheckRequest{Service: ""})
    require.NoError(t, err)
    assert.Equal(t, grpc_health_v1.HealthCheckResponse_SERVING, resp.Status)

    // Wait for health check to fail (failCount reaches 2)
    time.Sleep(300 * time.Millisecond)

    resp, err = client.Check(ctx, &grpc_health_v1.HealthCheckRequest{Service: ""})
    require.NoError(t, err)
    assert.Equal(t, grpc_health_v1.HealthCheckResponse_NOT_SERVING, resp.Status)
}
```

## Section 9: gRPC Health Check Best Practices

### Readiness vs. Liveness Distinction

```go
// Best practice: different service names for readiness and liveness
const (
    // Liveness: "Am I alive?" — fail only if the process needs to be restarted
    LivenessService = "liveness"

    // Readiness: "Am I ready for traffic?" — fail if I can't serve requests
    ReadinessService = "readiness"
)

func (s *MyService) updateHealthStatus(ctx context.Context) {
    // Liveness: only fail if we're completely stuck
    if s.isCompletelyBroken() {
        s.healthSrv.SetServingStatus(LivenessService,
            grpc_health_v1.HealthCheckResponse_NOT_SERVING)
    } else {
        s.healthSrv.SetServingStatus(LivenessService,
            grpc_health_v1.HealthCheckResponse_SERVING)
    }

    // Readiness: fail if dependencies are down
    if !s.isDatabaseHealthy() || !s.isCacheHealthy() {
        s.healthSrv.SetServingStatus(ReadinessService,
            grpc_health_v1.HealthCheckResponse_NOT_SERVING)
    } else {
        s.healthSrv.SetServingStatus(ReadinessService,
            grpc_health_v1.HealthCheckResponse_SERVING)
    }
}
```

```yaml
# Kubernetes probes using separate service names
livenessProbe:
  grpc:
    port: 50051
    service: "liveness"  # Only restart if truly broken
  periodSeconds: 30
  failureThreshold: 3

readinessProbe:
  grpc:
    port: 50051
    service: "readiness"  # Remove from load balancer if deps are down
  periodSeconds: 10
  failureThreshold: 1  # Faster removal from rotation
```

## Section 10: Monitoring Health Check Performance

```go
package health

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "google.golang.org/grpc"
    "google.golang.org/grpc/health/grpc_health_v1"
    "google.golang.org/grpc/status"
)

var (
    healthCheckTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "grpc_health_checks_total",
            Help: "Total number of health checks performed",
        },
        []string{"service", "status"},
    )

    healthCheckDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "grpc_health_check_duration_seconds",
            Help:    "Duration of health checks",
            Buckets: prometheus.DefBuckets,
        },
        []string{"service"},
    )

    dependencyHealth = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "grpc_dependency_health",
            Help: "Health status of dependencies (1=healthy, 0=unhealthy)",
        },
        []string{"dependency"},
    )
)

// InstrumentedHealthServer wraps the health server with Prometheus metrics.
type InstrumentedHealthServer struct {
    grpc_health_v1.HealthServer
}

func (s *InstrumentedHealthServer) Check(
    ctx context.Context,
    req *grpc_health_v1.HealthCheckRequest,
) (*grpc_health_v1.HealthCheckResponse, error) {
    start := time.Now()

    resp, err := s.HealthServer.Check(ctx, req)

    duration := time.Since(start).Seconds()
    healthCheckDuration.WithLabelValues(req.Service).Observe(duration)

    if err != nil {
        healthCheckTotal.WithLabelValues(req.Service, "error").Inc()
    } else {
        healthCheckTotal.WithLabelValues(req.Service, resp.Status.String()).Inc()
    }

    return resp, err
}
```

## Summary

The gRPC Health Checking Protocol provides a standardized, language-agnostic mechanism for service health that integrates directly with Kubernetes probes. Key implementation decisions:

- Use `google.golang.org/grpc/health` for the standard implementation — it handles Watch correctly with proper fan-out notifications
- Separate liveness and readiness using different service names in the health server — liveness failures cause pod restarts, readiness failures remove pods from load balancer rotation
- Kubernetes 1.24+ native gRPC probes (`grpc.port` in probe spec) are preferred over `grpc_health_probe` exec probes — they're faster, have lower overhead, and support TLS natively
- Track dependencies explicitly in the health server — don't just return SERVING if the database is down
- Use a dedicated health port separate from the main gRPC port for graceful shutdown — the health port should report NOT_SERVING before the main port stops accepting connections
- Instrument health checks with Prometheus metrics to catch flapping health status before it causes production incidents
