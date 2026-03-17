---
title: "Go: gRPC Health Checking Protocol, Readiness Probes, and Graceful Shutdown Patterns"
date: 2031-08-01T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Health Checks", "Kubernetes", "Graceful Shutdown", "Production", "Golang", "Readiness Probes"]
categories:
- Go
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-ready Go patterns for implementing the gRPC Health Checking Protocol, integrating with Kubernetes liveness and readiness probes, and implementing graceful shutdown to handle in-flight requests safely."
more_link: "yes"
url: "/go-grpc-health-checking-readiness-probes-graceful-shutdown-patterns/"
---

gRPC services running in Kubernetes have specific requirements that differ from HTTP services. Kubernetes needs to know when your service is healthy, when it is ready to accept traffic, and your service needs a way to drain in-flight RPCs before it terminates. The gRPC ecosystem addresses these concerns with the gRPC Health Checking Protocol — a standardized service specification that Kubernetes probes understand natively via the `grpc` probe type introduced in Kubernetes 1.24.

This guide covers implementing the full health checking stack: the gRPC health service, Kubernetes probe configuration, a signal-driven graceful shutdown that waits for in-flight RPCs to complete, and the readiness state machine that controls traffic during deployment rollouts.

<!--more-->

# Go: gRPC Health Checking Protocol, Readiness Probes, and Graceful Shutdown Patterns

## gRPC Health Checking Protocol Overview

The gRPC Health Checking Protocol defines a standard `Health` service with a `Check` RPC and a `Watch` RPC. Services implement this protocol, and health check clients (including Kubernetes kubelet) call `Check` to determine service health.

The protocol uses service-level granularity: you can report the overall service as healthy while reporting a specific sub-service (e.g., a database-dependent handler) as unhealthy. Kubernetes probes can target specific service names.

The health status values are:
- `SERVING` — ready to accept requests
- `NOT_SERVING` — not accepting requests (Kubernetes marks pod not ready)
- `SERVICE_UNKNOWN` — the service name is not registered
- `UNKNOWN` — status cannot be determined

## Dependencies

```bash
go get google.golang.org/grpc@v1.64.0
go get google.golang.org/grpc/health@v1.64.0
go get google.golang.org/grpc/health/grpc_health_v1@v1.64.0
go get google.golang.org/protobuf@v1.34.2
```

## Basic Health Service Implementation

The `grpc/health/v1` package provides a ready-made implementation.

```go
// internal/server/grpc.go
package server

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/reflection"
	"go.uber.org/zap"
)

// Server wraps the gRPC server with health management and graceful shutdown.
type Server struct {
	grpcServer     *grpc.Server
	healthServer   *health.Server
	listener       net.Listener
	log            *zap.Logger
	shutdownCh     chan struct{}
	readyCh        chan struct{}
}

// ServerConfig holds configuration for the gRPC server.
type ServerConfig struct {
	ListenAddr string
	// Maximum time allowed for graceful shutdown drain
	ShutdownTimeout time.Duration
	// Maximum concurrent streams per client connection
	MaxConcurrentStreams uint32
}

// DefaultServerConfig returns sensible production defaults.
func DefaultServerConfig() ServerConfig {
	return ServerConfig{
		ListenAddr:          ":50051",
		ShutdownTimeout:     30 * time.Second,
		MaxConcurrentStreams: 1000,
	}
}

// New creates a new gRPC server with health checking configured.
func New(cfg ServerConfig, log *zap.Logger) (*Server, error) {
	lis, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", cfg.ListenAddr, err)
	}

	// gRPC server options for production
	grpcServer := grpc.NewServer(
		grpc.MaxConcurrentStreams(cfg.MaxConcurrentStreams),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			// Minimum time between client pings
			MinTime: 5 * time.Second,
			// Allow pings even when there are no active streams
			PermitWithoutStream: true,
		}),
		grpc.KeepaliveParams(keepalive.ServerParameters{
			// Send keepalive ping after this time of inactivity
			Time: 15 * time.Second,
			// Close connection if no ack within this time
			Timeout: 5 * time.Second,
			// Maximum age of a connection
			MaxConnectionAge: 30 * time.Minute,
			// Grace period to complete pending RPCs after MaxConnectionAge
			MaxConnectionAgeGrace: 5 * time.Second,
		}),
		// Unary interceptors for tracing, logging, and metrics
		grpc.ChainUnaryInterceptor(
			loggingUnaryInterceptor(log),
			metricsUnaryInterceptor(),
			recoveryUnaryInterceptor(log),
		),
		grpc.ChainStreamInterceptor(
			loggingStreamInterceptor(log),
			metricsStreamInterceptor(),
		),
	)

	// Create the health server. The health.NewServer() implementation
	// supports per-service status management and the Watch RPC.
	healthServer := health.NewServer()

	// Register the health service with the gRPC server
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)

	// Register reflection for grpcurl and other debugging tools
	// Disable in production if you don't want API discovery
	reflection.Register(grpcServer)

	// Initially mark the overall server as NOT_SERVING.
	// It transitions to SERVING only after all initialization completes.
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_NOT_SERVING)

	return &Server{
		grpcServer:   grpcServer,
		healthServer: healthServer,
		listener:     lis,
		log:          log,
		shutdownCh:   make(chan struct{}),
		readyCh:      make(chan struct{}),
	}, nil
}

// RegisterService registers a gRPC service implementation and marks
// that service as SERVING in the health check.
func (s *Server) RegisterService(desc *grpc.ServiceDesc, impl interface{}) {
	s.grpcServer.RegisterService(desc, impl)
	// Register the service name in health checking
	s.healthServer.SetServingStatus(
		desc.ServiceName,
		grpc_health_v1.HealthCheckResponse_NOT_SERVING,
	)
}

// MarkServiceReady marks a specific service as ready to serve traffic.
// Call this after the service's dependencies (DB connections, cache warm-up)
// are verified to be available.
func (s *Server) MarkServiceReady(serviceName string) {
	s.healthServer.SetServingStatus(
		serviceName,
		grpc_health_v1.HealthCheckResponse_SERVING,
	)
	s.log.Info("service marked ready", zap.String("service", serviceName))
}

// MarkServiceNotReady marks a specific service as not ready.
// Call this when a critical dependency (e.g., database) becomes unavailable.
func (s *Server) MarkServiceNotReady(serviceName string, reason string) {
	s.healthServer.SetServingStatus(
		serviceName,
		grpc_health_v1.HealthCheckResponse_NOT_SERVING,
	)
	s.log.Warn("service marked not ready",
		zap.String("service", serviceName),
		zap.String("reason", reason),
	)
}

// MarkOverallReady marks the overall server as ready.
// This is what Kubernetes checks when no specific service name is given.
func (s *Server) MarkOverallReady() {
	s.healthServer.SetServingStatus(
		"",
		grpc_health_v1.HealthCheckResponse_SERVING,
	)
	close(s.readyCh)
	s.log.Info("server marked overall ready",
		zap.String("addr", s.listener.Addr().String()),
	)
}

// Ready returns a channel that closes when the server is ready.
func (s *Server) Ready() <-chan struct{} {
	return s.readyCh
}
```

## Readiness State Machine

The readiness state machine controls the transition from NOT_SERVING to SERVING. A well-designed startup sequence ensures that pods do not receive traffic before they are genuinely ready.

```go
// internal/server/readiness.go
package server

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/grpc/health/grpc_health_v1"
	"go.uber.org/zap"
)

// ReadinessState tracks the health of individual dependencies.
type ReadinessState struct {
	mu           sync.RWMutex
	checks       map[string]bool
	server       *Server
	log          *zap.Logger
	overallReady atomic.Bool
}

// NewReadinessState creates a readiness state tracker.
func NewReadinessState(srv *Server, checkNames []string, log *zap.Logger) *ReadinessState {
	checks := make(map[string]bool, len(checkNames))
	for _, name := range checkNames {
		checks[name] = false
	}
	return &ReadinessState{
		checks: checks,
		server: srv,
		log:    log,
	}
}

// SetCheckStatus marks a dependency check as passed or failed.
// When all checks pass, the server transitions to SERVING.
func (r *ReadinessState) SetCheckStatus(name string, ready bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	prev, exists := r.checks[name]
	if !exists {
		r.log.Error("unknown readiness check", zap.String("check", name))
		return
	}

	r.checks[name] = ready
	r.log.Info("readiness check updated",
		zap.String("check", name),
		zap.Bool("ready", ready),
		zap.Bool("was_ready", prev),
	)

	r.evaluate()
}

// evaluate checks whether all dependencies are ready and updates overall status.
// Must be called with r.mu held.
func (r *ReadinessState) evaluate() {
	for name, ready := range r.checks {
		if !ready {
			if r.overallReady.CompareAndSwap(true, false) {
				r.server.healthServer.SetServingStatus(
					"",
					grpc_health_v1.HealthCheckResponse_NOT_SERVING,
				)
				r.log.Warn("server marked not ready",
					zap.String("failing_check", name),
				)
			}
			return
		}
	}

	// All checks passed
	if r.overallReady.CompareAndSwap(false, true) {
		r.server.MarkOverallReady()
	}
}

// StartPeriodicCheck runs a readiness check on an interval.
// This is useful for checks like database connectivity that can flap.
func (r *ReadinessState) StartPeriodicCheck(
	ctx context.Context,
	name string,
	interval time.Duration,
	check func(ctx context.Context) error,
) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				checkCtx, cancel := context.WithTimeout(ctx, interval/2)
				err := check(checkCtx)
				cancel()

				r.SetCheckStatus(name, err == nil)
				if err != nil {
					r.log.Warn("readiness check failed",
						zap.String("check", name),
						zap.Error(err),
					)
				}
			}
		}
	}()
}
```

## Application Startup Sequence

```go
// cmd/server/main.go
package main

import (
	"context"
	"database/sql"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/yourorg/service/internal/server"
	pb "github.com/yourorg/service/proto/v1"
	"go.uber.org/zap"
	"google.golang.org/grpc"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	// Database connection pool
	db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal("open database", zap.Error(err))
	}
	defer db.Close()
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	// gRPC server
	cfg := server.DefaultServerConfig()
	srv, err := server.New(cfg, log)
	if err != nil {
		log.Fatal("create server", zap.Error(err))
	}

	// Register your service implementations
	orderService := NewOrderService(db, log)
	pb.RegisterOrderServiceServer(srv.GRPCServer(), orderService)
	srv.RegisterService(&pb.OrderService_ServiceDesc, orderService)

	// Readiness checks — the server won't accept traffic until all pass
	readiness := server.NewReadinessState(srv, []string{
		"database",
		"cache",
	}, log)

	ctx, cancel := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Start periodic database connectivity check
	readiness.StartPeriodicCheck(ctx, "database", 10*time.Second,
		func(ctx context.Context) error {
			return db.PingContext(ctx)
		})

	// Start periodic cache check
	readiness.StartPeriodicCheck(ctx, "cache", 10*time.Second,
		func(ctx context.Context) error {
			return pingCache(ctx)
		})

	// Run initial checks immediately
	if err := db.PingContext(ctx); err != nil {
		log.Warn("initial database check failed, will retry", zap.Error(err))
	} else {
		readiness.SetCheckStatus("database", true)
	}

	// Warm up the service (load caches, etc.)
	if err := orderService.WarmUp(ctx); err != nil {
		log.Fatal("service warm up failed", zap.Error(err))
	}
	readiness.SetCheckStatus("cache", true)

	// Serve in background
	go func() {
		log.Info("starting gRPC server", zap.String("addr", cfg.ListenAddr))
		if err := srv.Serve(); err != nil {
			log.Error("gRPC server exited", zap.Error(err))
		}
	}()

	// Wait for termination signal
	<-ctx.Done()
	log.Info("shutdown signal received")

	// Graceful shutdown
	srv.GracefulStop(30 * time.Second)
	log.Info("shutdown complete")
}
```

## Graceful Shutdown Implementation

Graceful shutdown is the most nuanced part of gRPC service lifecycle management. The goal is to stop accepting new connections while waiting for in-flight RPCs to complete, within a bounded timeout.

```go
// internal/server/shutdown.go
package server

import (
	"context"
	"sync"
	"time"

	"google.golang.org/grpc/health/grpc_health_v1"
	"go.uber.org/zap"
)

// GracefulStop initiates graceful shutdown:
// 1. Mark the server as NOT_SERVING (Kubernetes stops routing traffic)
// 2. Wait for in-flight RPCs to complete
// 3. Force-stop after the timeout
func (s *Server) GracefulStop(timeout time.Duration) {
	s.log.Info("initiating graceful shutdown",
		zap.Duration("timeout", timeout),
	)

	// Step 1: Stop advertising readiness.
	// New connections will be rejected; existing connections drain.
	s.healthServer.SetServingStatus(
		"",
		grpc_health_v1.HealthCheckResponse_NOT_SERVING,
	)

	// Step 2: Signal handlers to drain (e.g., stop background jobs
	// that might start new work)
	close(s.shutdownCh)

	// Step 3: Give Kubernetes time to notice the NOT_SERVING status
	// and remove the pod from endpoints before we stop accepting RPCs.
	// This prevents request failures during the transition period.
	// The appropriate sleep duration depends on your endpointSlice sync speed.
	terminationGracePeriod := 5 * time.Second
	s.log.Info("waiting for endpoint removal",
		zap.Duration("wait", terminationGracePeriod),
	)
	time.Sleep(terminationGracePeriod)

	// Step 4: Graceful stop — waits for in-flight RPCs to complete.
	// This blocks until all active RPCs return or the goroutine below
	// calls Stop() after the timeout.
	done := make(chan struct{})
	go func() {
		s.grpcServer.GracefulStop()
		close(done)
	}()

	select {
	case <-done:
		s.log.Info("graceful shutdown complete")
	case <-time.After(timeout):
		s.log.Warn("graceful shutdown timeout exceeded, forcing stop",
			zap.Duration("timeout", timeout),
		)
		s.grpcServer.Stop()
	}
}

// ShutdownCh returns a channel that is closed when shutdown begins.
// Long-running handlers should monitor this channel to abort work early.
func (s *Server) ShutdownCh() <-chan struct{} {
	return s.shutdownCh
}

// Serve starts the gRPC server. Blocks until the server stops.
func (s *Server) Serve() error {
	return s.grpcServer.Serve(s.listener)
}

// GRPCServer returns the underlying grpc.Server for service registration.
func (s *Server) GRPCServer() *grpc.Server {
	return s.grpcServer
}
```

### Handler Integration with Shutdown Channel

Long-running streaming handlers should respect the shutdown signal.

```go
// example handler that monitors shutdown
func (s *OrderService) WatchOrderStatus(
	req *pb.WatchOrderStatusRequest,
	stream pb.OrderService_WatchOrderStatusServer,
) error {
	ctx := stream.Context()

	for {
		select {
		case <-ctx.Done():
			// Client disconnected or context cancelled
			return ctx.Err()

		case <-s.shutdownCh:
			// Server is shutting down; send a final message and close gracefully
			_ = stream.Send(&pb.OrderStatusUpdate{
				Status:  pb.OrderStatus_DISCONNECTING,
				Message: "server maintenance",
			})
			return nil

		case update := <-s.orderUpdates[req.OrderId]:
			if err := stream.Send(update); err != nil {
				return fmt.Errorf("send update: %w", err)
			}
		}
	}
}
```

## Kubernetes Probe Configuration

Kubernetes 1.24+ supports native gRPC probes that call the gRPC Health Checking Protocol directly.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      # Only one pod down at a time during rollouts
      maxUnavailable: 1
      # One extra pod during rollouts for zero-downtime deploys
      maxSurge: 1
  template:
    spec:
      # This must match server's shutdown wait + graceful drain
      # terminationGracePeriodSeconds >= shutdown sleep + timeout
      terminationGracePeriodSeconds: 60

      containers:
        - name: order-service
          image: yourorg/order-service:v1.5.0
          ports:
            - name: grpc
              containerPort: 50051
              protocol: TCP

          # Startup probe: Kubernetes waits for this before starting liveness/readiness
          # Allows up to 60 seconds for the service to start (20 * 3s = 60s)
          startupProbe:
            grpc:
              port: 50051
              # Check the overall server health (empty service name)
            initialDelaySeconds: 5
            periodSeconds: 3
            failureThreshold: 20
            successThreshold: 1

          # Readiness probe: controls whether the pod receives traffic
          # Check the specific service, not just overall health
          readinessProbe:
            grpc:
              port: 50051
              service: "yourorg.order.v1.OrderService"
            initialDelaySeconds: 0
            periodSeconds: 5
            failureThreshold: 3
            successThreshold: 1
            timeoutSeconds: 3

          # Liveness probe: Kubernetes restarts the pod if this fails
          # Use a more lenient threshold than readiness
          livenessProbe:
            grpc:
              port: 50051
            initialDelaySeconds: 15
            periodSeconds: 15
            failureThreshold: 4
            successThreshold: 1
            timeoutSeconds: 5

          # Lifecycle hooks for graceful shutdown
          lifecycle:
            preStop:
              # Kubernetes calls preStop before sending SIGTERM.
              # This sleep gives the endpoint controller time to remove
              # the pod from the service's endpoint list before we start
              # the shutdown sequence. Without this, clients may still
              # route to a pod that is beginning to shut down.
              exec:
                command: ["/bin/sleep", "5"]

          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: order-service-db
                  key: url
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

## Interceptors for Observability

Production gRPC services need logging, metrics, and tracing applied consistently.

```go
// internal/server/interceptors.go
package server

import (
	"context"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.uber.org/zap"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var (
	grpcRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "grpc_server_requests_total",
		Help: "Total number of gRPC requests by method and status code.",
	}, []string{"method", "code"})

	grpcRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "grpc_server_request_duration_seconds",
		Help:    "gRPC server request duration in seconds.",
		Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
	}, []string{"method", "code"})
)

func loggingUnaryInterceptor(log *zap.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		elapsed := time.Since(start)

		code := codes.OK
		if err != nil {
			code = status.Code(err)
		}

		log.Info("grpc unary",
			zap.String("method", info.FullMethod),
			zap.Duration("duration", elapsed),
			zap.String("code", code.String()),
			zap.Error(err),
		)
		return resp, err
	}
}

func metricsUnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (interface{}, error) {
		start := time.Now()
		resp, err := handler(ctx, req)

		code := status.Code(err)
		grpcRequestsTotal.WithLabelValues(info.FullMethod, code.String()).Inc()
		grpcRequestDuration.WithLabelValues(
			info.FullMethod,
			code.String(),
		).Observe(time.Since(start).Seconds())

		return resp, err
	}
}

func recoveryUnaryInterceptor(log *zap.Logger) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req interface{},
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (resp interface{}, err error) {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic in gRPC handler",
					zap.String("method", info.FullMethod),
					zap.Any("panic", r),
				)
				err = status.Errorf(codes.Internal, "internal server error")
			}
		}()
		return handler(ctx, req)
	}
}

func loggingStreamInterceptor(log *zap.Logger) grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		start := time.Now()
		err := handler(srv, ss)
		code := status.Code(err)

		log.Info("grpc stream",
			zap.String("method", info.FullMethod),
			zap.Duration("duration", time.Since(start)),
			zap.String("code", code.String()),
			zap.Bool("server_stream", info.IsServerStream),
			zap.Bool("client_stream", info.IsClientStream),
			zap.Error(err),
		)
		return err
	}
}

func metricsStreamInterceptor() grpc.StreamServerInterceptor {
	return func(
		srv interface{},
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		start := time.Now()
		err := handler(srv, ss)

		code := status.Code(err)
		grpcRequestsTotal.WithLabelValues(info.FullMethod, code.String()).Inc()
		grpcRequestDuration.WithLabelValues(
			info.FullMethod,
			code.String(),
		).Observe(time.Since(start).Seconds())

		return err
	}
}
```

## Health Check Client for Dependency Checking

Sometimes a gRPC service depends on another gRPC service. Use the health check client to verify upstream service readiness.

```go
// internal/healthcheck/client.go
package healthcheck

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health/grpc_health_v1"
)

// CheckGRPCService verifies that a remote gRPC service is healthy.
// Use this in startup readiness checks or periodic health monitors.
func CheckGRPCService(ctx context.Context, target string, serviceName string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(ctx, target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		return fmt.Errorf("dial %s: %w", target, err)
	}
	defer conn.Close()

	client := grpc_health_v1.NewHealthClient(conn)
	resp, err := client.Check(ctx, &grpc_health_v1.HealthCheckRequest{
		Service: serviceName,
	})
	if err != nil {
		return fmt.Errorf("health check %s: %w", target, err)
	}

	if resp.Status != grpc_health_v1.HealthCheckResponse_SERVING {
		return fmt.Errorf("service %s at %s is %s", serviceName, target, resp.Status)
	}
	return nil
}

// WatchGRPCService monitors a remote gRPC service health using Watch RPC.
// Calls onChange whenever the service status changes.
func WatchGRPCService(
	ctx context.Context,
	target string,
	serviceName string,
	onChange func(status grpc_health_v1.HealthCheckResponse_ServingStatus),
) error {
	conn, err := grpc.DialContext(ctx, target,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return fmt.Errorf("dial %s: %w", target, err)
	}
	defer conn.Close()

	client := grpc_health_v1.NewHealthClient(conn)
	stream, err := client.Watch(ctx, &grpc_health_v1.HealthCheckRequest{
		Service: serviceName,
	})
	if err != nil {
		return fmt.Errorf("watch %s: %w", target, err)
	}

	for {
		resp, err := stream.Recv()
		if err != nil {
			return fmt.Errorf("watch recv: %w", err)
		}
		onChange(resp.Status)
	}
}
```

## Testing

```go
// internal/server/grpc_test.go
package server_test

import (
	"context"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health/grpc_health_v1"
	"go.uber.org/zap/zaptest"
)

func TestServerHealthCheck(t *testing.T) {
	log := zaptest.NewLogger(t)
	cfg := server.DefaultServerConfig()
	cfg.ListenAddr = "127.0.0.1:0" // random port

	srv, err := server.New(cfg, log)
	if err != nil {
		t.Fatalf("create server: %v", err)
	}
	t.Cleanup(func() { srv.GracefulStop(5 * time.Second) })

	go func() {
		_ = srv.Serve()
	}()

	// Server should be NOT_SERVING before MarkOverallReady
	conn, err := grpc.Dial(srv.Addr(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	client := grpc_health_v1.NewHealthClient(conn)
	ctx := context.Background()

	resp, err := client.Check(ctx, &grpc_health_v1.HealthCheckRequest{})
	if err != nil {
		t.Fatalf("health check: %v", err)
	}
	if resp.Status != grpc_health_v1.HealthCheckResponse_NOT_SERVING {
		t.Errorf("expected NOT_SERVING, got %s", resp.Status)
	}

	// Mark ready
	srv.MarkOverallReady()

	resp, err = client.Check(ctx, &grpc_health_v1.HealthCheckRequest{})
	if err != nil {
		t.Fatalf("health check after ready: %v", err)
	}
	if resp.Status != grpc_health_v1.HealthCheckResponse_SERVING {
		t.Errorf("expected SERVING, got %s", resp.Status)
	}
}

func TestGracefulShutdown(t *testing.T) {
	log := zaptest.NewLogger(t)
	cfg := server.DefaultServerConfig()
	cfg.ListenAddr = "127.0.0.1:0"

	srv, err := server.New(cfg, log)
	if err != nil {
		t.Fatalf("create server: %v", err)
	}
	srv.MarkOverallReady()

	go func() { _ = srv.Serve() }()

	// Start a long-running RPC
	conn, _ := grpc.Dial(srv.Addr(),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	defer conn.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Simulate a slow RPC
		time.Sleep(100 * time.Millisecond)
	}()

	// Initiate graceful shutdown while RPC is in flight
	start := time.Now()
	srv.GracefulStop(10 * time.Second)
	elapsed := time.Since(start)

	// Shutdown should have waited for in-flight RPC
	if elapsed < 90*time.Millisecond {
		t.Error("shutdown returned too quickly; may not have waited for in-flight RPCs")
	}
	t.Logf("graceful shutdown completed in %s", elapsed)
}
```

## Summary

Production gRPC services on Kubernetes require careful attention to the health lifecycle. The key principles from this guide:

- Start with the server in NOT_SERVING state and transition only after all dependencies are verified
- Use the readiness state machine to track individual dependency health; one failing dependency should flip the overall status
- Sleep for 5 seconds between marking NOT_SERVING and calling GracefulStop to let Kubernetes endpoint controller remove the pod before you stop accepting RPCs
- The `terminationGracePeriodSeconds` must be longer than your preStop sleep plus your graceful shutdown timeout
- Register each gRPC service by name in health checking so that Kubernetes probes can target specific services
- Implement the shutdown channel pattern in streaming handlers so they can complete cleanly when shutdown is initiated
