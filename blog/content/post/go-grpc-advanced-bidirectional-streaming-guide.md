---
title: "Go gRPC Advanced Patterns: Bidirectional Streaming, Interceptors, and Production Hardening"
date: 2029-11-29T00:00:00-05:00
draft: false
tags: ["Go", "gRPC", "Streaming", "Interceptors", "Production", "Health Checking", "gRPC-Web"]
categories:
- Go
- gRPC
- Microservices
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering Go gRPC bidirectional streaming, server and client interceptors, deadlines, health checking, reflection, and gRPC-Web for production deployments."
more_link: "yes"
url: "/go-grpc-advanced-bidirectional-streaming-guide/"
---

gRPC's four communication patterns — unary, server streaming, client streaming, and bidirectional streaming — enable fundamentally different architectural approaches to distributed systems. Most teams use only unary RPCs and never access the streaming patterns that make gRPC genuinely superior to REST for internal services. This guide covers the patterns that matter in production and the operational hardening required to run them reliably.

<!--more-->

## Section 1: The Four gRPC Communication Patterns

Before examining advanced patterns, understanding when each is appropriate is essential.

**Unary RPC**: One request, one response. Equivalent to an HTTP POST. Use for discrete operations where the entire request fits in memory.

**Server Streaming**: One request, stream of responses. Use when the server needs to push a large or unbounded dataset: log tailing, real-time event feeds, large file transfers.

**Client Streaming**: Stream of requests, one response. Use for large uploads, batch operations, or aggregation — the client sends many items and gets a single summary.

**Bidirectional Streaming**: Both sides send an independent stream. Use for chat protocols, multiplexed request/response (multiple in-flight RPCs over one connection), real-time bidirectional data exchange.

### Proto Service Definition

```protobuf
// api/trading/v1/trading.proto
syntax = "proto3";
package trading.v1;
option go_package = "github.com/company/platform/api/trading/v1;tradingv1";

import "google/protobuf/timestamp.proto";

service TradingService {
  // Unary: place a single order
  rpc PlaceOrder(PlaceOrderRequest) returns (PlaceOrderResponse);

  // Server streaming: subscribe to market data feed
  rpc SubscribeMarketData(MarketDataSubscription) returns (stream MarketDataEvent);

  // Client streaming: batch upload historical trades
  rpc UploadHistoricalTrades(stream HistoricalTrade) returns (UploadSummary);

  // Bidirectional streaming: interactive order management session
  rpc OrderManagementSession(stream OrderAction) returns (stream OrderEvent);
}

message PlaceOrderRequest {
  string symbol = 1;
  string side = 2;
  int64 quantity = 3;
  double limit_price = 4;
}

message PlaceOrderResponse {
  string order_id = 1;
  string status = 2;
  google.protobuf.Timestamp created_at = 3;
}

message MarketDataSubscription {
  repeated string symbols = 1;
  string feed_type = 2;
}

message MarketDataEvent {
  string symbol = 1;
  double bid = 2;
  double ask = 3;
  int64 volume = 4;
  google.protobuf.Timestamp timestamp = 5;
}

message HistoricalTrade {
  string symbol = 1;
  double price = 2;
  int64 quantity = 3;
  google.protobuf.Timestamp executed_at = 4;
}

message UploadSummary {
  int64 records_processed = 1;
  int64 records_rejected = 2;
  repeated string error_messages = 3;
}

message OrderAction {
  oneof action {
    PlaceOrderRequest place = 1;
    string cancel_order_id = 2;
    string modify_order_id = 3;
  }
  int64 sequence_number = 4;
}

message OrderEvent {
  string order_id = 1;
  string status = 2;
  string error_message = 3;
  int64 sequence_number = 4;
  google.protobuf.Timestamp timestamp = 5;
}
```

## Section 2: Server Implementation

### Server Streaming Handler

```go
// internal/server/market_data.go
func (s *TradingServer) SubscribeMarketData(
    req *tradingv1.MarketDataSubscription,
    stream tradingv1.TradingService_SubscribeMarketDataServer,
) error {
    ctx := stream.Context()
    log := s.log.WithContext(ctx)

    sub, err := s.marketDataBus.Subscribe(req.Symbols, req.FeedType)
    if err != nil {
        return status.Errorf(codes.InvalidArgument, "subscribe: %v", err)
    }
    defer sub.Close()

    log.Infof("client subscribed to %d symbols", len(req.Symbols))

    for {
        select {
        case <-ctx.Done():
            log.Info("client disconnected")
            return ctx.Err()

        case event, ok := <-sub.Events():
            if !ok {
                return status.Error(codes.Internal, "market data feed closed")
            }

            protoEvent := &tradingv1.MarketDataEvent{
                Symbol:    event.Symbol,
                Bid:       event.Bid,
                Ask:       event.Ask,
                Volume:    event.Volume,
                Timestamp: timestamppb.New(event.Timestamp),
            }

            if err := stream.Send(protoEvent); err != nil {
                // Client disconnected or network error
                return err
            }

            s.metrics.marketDataSent.Add(ctx, 1,
                metric.WithAttributes(attribute.String("symbol", event.Symbol)),
            )
        }
    }
}
```

### Client Streaming Handler

```go
// internal/server/historical_trades.go
func (s *TradingServer) UploadHistoricalTrades(
    stream tradingv1.TradingService_UploadHistoricalTradesServer,
) error {
    ctx := stream.Context()

    var processed, rejected int64
    var errors []string
    batch := make([]*tradingv1.HistoricalTrade, 0, 1000)

    for {
        trade, err := stream.Recv()
        if err == io.EOF {
            // Client finished sending; flush remaining batch
            if len(batch) > 0 {
                n, errs := s.tradeStore.ImportBatch(ctx, batch)
                processed += int64(n)
                errors = append(errors, errs...)
            }
            return stream.SendAndClose(&tradingv1.UploadSummary{
                RecordsProcessed: processed,
                RecordsRejected:  rejected,
                ErrorMessages:    errors,
            })
        }
        if err != nil {
            return status.Errorf(codes.Internal, "recv: %v", err)
        }

        // Validate
        if trade.Symbol == "" || trade.Quantity <= 0 {
            rejected++
            errors = append(errors, fmt.Sprintf("invalid trade at seq %d", processed+rejected))
            continue
        }

        batch = append(batch, trade)

        // Flush in batches of 1000
        if len(batch) >= 1000 {
            n, errs := s.tradeStore.ImportBatch(ctx, batch)
            processed += int64(n)
            errors = append(errors, errs...)
            batch = batch[:0]
        }
    }
}
```

### Bidirectional Streaming Handler

```go
// internal/server/order_session.go
func (s *TradingServer) OrderManagementSession(
    stream tradingv1.TradingService_OrderManagementSessionServer,
) error {
    ctx := stream.Context()
    sessionID := extractSessionID(ctx) // from metadata

    // Channel for sending events back to client
    eventCh := make(chan *tradingv1.OrderEvent, 100)

    // Register this session with the order event bus
    sub := s.orderEventBus.Subscribe(sessionID)
    defer sub.Close()

    // Goroutine: forward order events to client
    sendErrCh := make(chan error, 1)
    go func() {
        for {
            select {
            case <-ctx.Done():
                sendErrCh <- nil
                return
            case event := <-sub.Events():
                if err := stream.Send(event); err != nil {
                    sendErrCh <- err
                    return
                }
            case event := <-eventCh:
                if err := stream.Send(event); err != nil {
                    sendErrCh <- err
                    return
                }
            }
        }
    }()

    // Main loop: receive actions from client
    for {
        action, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        // Process action asynchronously; result delivered via eventCh
        go s.processOrderAction(ctx, action, eventCh)
    }
}

func (s *TradingServer) processOrderAction(
    ctx context.Context,
    action *tradingv1.OrderAction,
    eventCh chan<- *tradingv1.OrderEvent,
) {
    var event *tradingv1.OrderEvent

    switch a := action.Action.(type) {
    case *tradingv1.OrderAction_Place:
        result, err := s.orderEngine.PlaceOrder(ctx, a.Place)
        if err != nil {
            event = &tradingv1.OrderEvent{
                Status:         "ERROR",
                ErrorMessage:   err.Error(),
                SequenceNumber: action.SequenceNumber,
            }
        } else {
            event = &tradingv1.OrderEvent{
                OrderId:        result.OrderID,
                Status:         "PLACED",
                SequenceNumber: action.SequenceNumber,
                Timestamp:      timestamppb.Now(),
            }
        }
    case *tradingv1.OrderAction_CancelOrderId:
        err := s.orderEngine.CancelOrder(ctx, a.CancelOrderId)
        if err != nil {
            event = &tradingv1.OrderEvent{
                OrderId:        a.CancelOrderId,
                Status:         "CANCEL_FAILED",
                ErrorMessage:   err.Error(),
                SequenceNumber: action.SequenceNumber,
            }
        } else {
            event = &tradingv1.OrderEvent{
                OrderId:        a.CancelOrderId,
                Status:         "CANCELLED",
                SequenceNumber: action.SequenceNumber,
                Timestamp:      timestamppb.Now(),
            }
        }
    }

    select {
    case eventCh <- event:
    case <-ctx.Done():
    }
}
```

## Section 3: Interceptors

Interceptors are gRPC's middleware pattern. They execute before and after RPC handlers, enabling cross-cutting concerns without modifying handler code.

### Unary Server Interceptor Chain

```go
// internal/interceptors/interceptors.go
package interceptors

import (
    "context"
    "time"

    "go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// LoggingInterceptor logs all RPCs with duration and status code
func LoggingInterceptor(logger *slog.Logger) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        start := time.Now()
        resp, err := handler(ctx, req)
        duration := time.Since(start)

        code := codes.OK
        if err != nil {
            code = status.Code(err)
        }

        logger.InfoContext(ctx, "rpc",
            slog.String("method", info.FullMethod),
            slog.Duration("duration", duration),
            slog.String("code", code.String()),
        )
        return resp, err
    }
}

// RecoveryInterceptor converts panics to gRPC Internal errors
func RecoveryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (resp any, err error) {
        defer func() {
            if r := recover(); r != nil {
                err = status.Errorf(codes.Internal, "panic: %v", r)
            }
        }()
        return handler(ctx, req)
    }
}

// AuthInterceptor validates Bearer tokens
func AuthInterceptor(verifier TokenVerifier) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Skip auth for health checks
        if info.FullMethod == "/grpc.health.v1.Health/Check" {
            return handler(ctx, req)
        }

        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }

        authHeader := md.Get("authorization")
        if len(authHeader) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing authorization header")
        }

        token := strings.TrimPrefix(authHeader[0], "Bearer ")
        claims, err := verifier.Verify(ctx, token)
        if err != nil {
            return nil, status.Errorf(codes.Unauthenticated, "invalid token: %v", err)
        }

        ctx = context.WithValue(ctx, claimsKey{}, claims)
        return handler(ctx, req)
    }
}

// RateLimitInterceptor applies per-method rate limiting
func RateLimitInterceptor(limiter RateLimiter) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        if !limiter.Allow(info.FullMethod) {
            return nil, status.Error(codes.ResourceExhausted, "rate limit exceeded")
        }
        return handler(ctx, req)
    }
}
```

### Chaining Interceptors

```go
// cmd/server/main.go
func buildServer(cfg Config) *grpc.Server {
    return grpc.NewServer(
        grpc.ChainUnaryInterceptor(
            RecoveryInterceptor(),
            otelgrpc.UnaryServerInterceptor(),
            LoggingInterceptor(logger),
            AuthInterceptor(tokenVerifier),
            RateLimitInterceptor(rateLimiter),
        ),
        grpc.ChainStreamInterceptor(
            RecoveryStreamInterceptor(),
            otelgrpc.StreamServerInterceptor(),
            LoggingStreamInterceptor(logger),
            AuthStreamInterceptor(tokenVerifier),
        ),
        grpc.KeepaliveParams(keepalive.ServerParameters{
            MaxConnectionIdle:     15 * time.Minute,
            MaxConnectionAge:      1 * time.Hour,
            MaxConnectionAgeGrace: 5 * time.Second,
            Time:                  5 * time.Minute,
            Timeout:               1 * time.Minute,
        }),
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             5 * time.Second,
            PermitWithoutStream: true,
        }),
        grpc.MaxRecvMsgSize(16 * 1024 * 1024),  // 16MB
        grpc.MaxSendMsgSize(16 * 1024 * 1024),  // 16MB
    )
}
```

## Section 4: Deadlines and Context Propagation

gRPC propagates deadlines across service boundaries via HTTP/2 headers. If service A calls service B with a 500ms deadline, and B calls C, C automatically inherits whatever remains of the 500ms budget.

```go
// Client: always set deadlines on outbound calls
func (c *TradingClient) PlaceOrder(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResponse, error) {
    // Apply a 5-second deadline if caller didn't set one
    if _, ok := ctx.Deadline(); !ok {
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, 5*time.Second)
        defer cancel()
    }

    resp, err := c.stub.PlaceOrder(ctx, req)
    if err != nil {
        // Classify the error for caller
        switch status.Code(err) {
        case codes.DeadlineExceeded:
            return nil, fmt.Errorf("order placement timed out: %w", err)
        case codes.Unavailable:
            return nil, fmt.Errorf("trading service unavailable: %w", err)
        case codes.ResourceExhausted:
            return nil, fmt.Errorf("rate limited: %w", err)
        default:
            return nil, err
        }
    }
    return resp, nil
}
```

### Wait-For-Ready Semantics

```go
// Client connection with retry and wait-for-ready
conn, err := grpc.NewClient(
    target,
    grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
    grpc.WithDefaultServiceConfig(`{
        "methodConfig": [{
            "name": [{"service": "trading.v1.TradingService"}],
            "waitForReady": true,
            "retryPolicy": {
                "maxAttempts": 4,
                "initialBackoff": "0.1s",
                "maxBackoff": "1s",
                "backoffMultiplier": 2,
                "retryableStatusCodes": ["UNAVAILABLE", "RESOURCE_EXHAUSTED"]
            }
        }]
    }`),
)
```

## Section 5: Health Checking

gRPC defines a standard health checking protocol. Kubernetes can use it for readiness/liveness probes via `grpc-health-probe`.

```go
// Register health service
import "google.golang.org/grpc/health"
import healthpb "google.golang.org/grpc/health/grpc_health_v1"

healthServer := health.NewServer()
healthpb.RegisterHealthServer(grpcServer, healthServer)

// Mark individual services as healthy/unhealthy
healthServer.SetServingStatus(
    "trading.v1.TradingService",
    healthpb.HealthCheckResponse_SERVING,
)

// During graceful shutdown
healthServer.SetServingStatus(
    "trading.v1.TradingService",
    healthpb.HealthCheckResponse_NOT_SERVING,
)
```

```yaml
# Kubernetes pod spec with gRPC health probes
readinessProbe:
  grpc:
    port: 9090
    service: trading.v1.TradingService
  initialDelaySeconds: 5
  periodSeconds: 10
livenessProbe:
  grpc:
    port: 9090
  initialDelaySeconds: 15
  periodSeconds: 20
```

## Section 6: Server Reflection

Server reflection allows tools like `grpcurl` and Postman to discover your service's API without the proto files:

```go
import "google.golang.org/grpc/reflection"

// Register after all service implementations
reflection.Register(grpcServer)
```

```bash
# List all services (no proto file needed)
grpcurl -plaintext localhost:9090 list

# Describe a specific service
grpcurl -plaintext localhost:9090 describe trading.v1.TradingService

# Call a method
grpcurl -plaintext \
  -H "authorization: Bearer <TOKEN>" \
  -d '{"symbol": "AAPL", "side": "BUY", "quantity": 100, "limit_price": 195.50}' \
  localhost:9090 \
  trading.v1.TradingService/PlaceOrder
```

## Section 7: gRPC-Web for Browser Clients

Browsers cannot use gRPC directly (HTTP/2 trailers are not accessible from JavaScript). The Envoy proxy provides a gRPC-Web translation layer.

```yaml
# envoy-config.yaml
static_resources:
  listeners:
    - address:
        socket_address:
          address: 0.0.0.0
          port_value: 8080
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                http_filters:
                  - name: envoy.filters.http.grpc_web
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.grpc_web.v3.GrpcWeb
                  - name: envoy.filters.http.cors
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.cors.v3.Cors
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                route_config:
                  virtual_hosts:
                    - name: grpc-backend
                      domains: ["*"]
                      routes:
                        - match:
                            prefix: "/"
                          route:
                            cluster: grpc-backend
                      cors:
                        allow_origin_string_match:
                          - prefix: "*"
                        allow_methods: GET, PUT, DELETE, POST, OPTIONS
                        allow_headers: "content-type,x-grpc-web,x-user-agent,authorization"
  clusters:
    - name: grpc-backend
      type: LOGICAL_DNS
      http2_protocol_options: {}
      load_assignment:
        cluster_name: grpc-backend
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: trading-service
                      port_value: 9090
```

## Section 8: Production Hardening Checklist

```bash
# Verify TLS is enforced (no plaintext connections)
grpcurl -plaintext localhost:9090 list 2>&1 | grep -i "transport"

# Check keepalive is working
grpcurl -v -H "grpc-timeout: 5S" \
  -cert /etc/certs/client.crt \
  -key /etc/certs/client.key \
  -cacert /etc/certs/ca.crt \
  localhost:9090 list

# Load test with ghz
ghz --insecure \
  --proto api/trading/v1/trading.proto \
  --call trading.v1.TradingService.PlaceOrder \
  --data '{"symbol":"AAPL","side":"BUY","quantity":100,"limit_price":195.0}' \
  --rps 1000 \
  --duration 60s \
  localhost:9090
```

```yaml
# Recommended server-side limits to prevent resource exhaustion
grpc.MaxConcurrentStreams: 1000
grpc.MaxRecvMsgSize: 16MB
grpc.MaxSendMsgSize: 16MB
grpc.ReadBufferSize: 32KB
grpc.WriteBufferSize: 32KB
# Keepalive prevents zombie connections on load balancers
keepalive.MaxConnectionIdle: 15m
keepalive.MaxConnectionAge: 1h
keepalive.Time: 5m
keepalive.Timeout: 1m
```

gRPC's streaming primitives unlock communication patterns that REST cannot express efficiently. Bidirectional streaming, combined with a well-designed interceptor chain and proper deadline propagation, produces microservice architectures that are both more expressive and more operationally resilient than their HTTP/JSON equivalents.
