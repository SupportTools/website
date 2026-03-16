---
title: "Polyglot Architecture: Managing Multi-Language Microservices"
date: 2026-10-22T00:00:00-05:00
draft: false
tags: ["polyglot", "microservices", "architecture", "golang", "python", "java", "rust", "kubernetes", "enterprise"]
categories: ["Architecture", "Microservices", "Enterprise"]
author: "Matthew Mattox"
description: "Comprehensive guide to building and managing polyglot microservices architectures, covering language selection, inter-service communication, shared tooling, and operational excellence"
toc: true
keywords: ["polyglot microservices", "multi-language architecture", "microservices patterns", "service mesh", "distributed systems", "language selection", "enterprise architecture", "cross-language communication"]
url: "/polyglot-architecture-managing-multi-language-microservices/"
---

## Introduction

Modern enterprises increasingly adopt polyglot architectures, leveraging different programming languages for different services based on their strengths. While this approach maximizes technology fit, it introduces complexity in tooling, operations, and team coordination. This guide provides a comprehensive framework for successfully implementing and managing polyglot microservices architectures.

## Language Selection Framework

### Decision Matrix for Service Implementation

```yaml
# language-selection-criteria.yaml
criteria:
  performance:
    - throughput_requirements
    - latency_constraints
    - resource_efficiency
    - startup_time
  
  domain_fit:
    - problem_domain_alignment
    - ecosystem_maturity
    - library_availability
    - framework_support
  
  team_expertise:
    - current_skills
    - learning_curve
    - community_support
    - hiring_market
  
  operational:
    - deployment_complexity
    - monitoring_tools
    - debugging_capabilities
    - security_tooling

language_profiles:
  golang:
    strengths:
      - High performance
      - Excellent concurrency
      - Small binaries
      - Fast compile times
    best_for:
      - API gateways
      - Network services
      - CLI tools
      - Kubernetes operators
    
  python:
    strengths:
      - Rapid development
      - Data science libraries
      - ML/AI ecosystem
      - Scripting capabilities
    best_for:
      - Data processing
      - ML services
      - Automation scripts
      - Prototyping
  
  java:
    strengths:
      - Enterprise ecosystem
      - Mature frameworks
      - JVM performance
      - Tool support
    best_for:
      - Business logic services
      - Legacy integration
      - Enterprise applications
      - Stream processing
  
  rust:
    strengths:
      - Memory safety
      - Zero-cost abstractions
      - System programming
      - Performance critical
    best_for:
      - System services
      - Security components
      - Performance hotspots
      - Embedded systems
  
  nodejs:
    strengths:
      - Frontend alignment
      - Async I/O
      - NPM ecosystem
      - Real-time features
    best_for:
      - BFF services
      - Real-time APIs
      - GraphQL servers
      - SSR applications
```

### Service Boundary Definition

```go
// service-registry/models/service.go
package models

type Service struct {
    ID              string            `json:"id"`
    Name            string            `json:"name"`
    Language        string            `json:"language"`
    Version         string            `json:"version"`
    Team            string            `json:"team"`
    Capabilities    []Capability      `json:"capabilities"`
    Dependencies    []Dependency      `json:"dependencies"`
    APIDefinitions  []APIDefinition   `json:"api_definitions"`
    HealthEndpoint  string            `json:"health_endpoint"`
    MetricsEndpoint string            `json:"metrics_endpoint"`
    Documentation   string            `json:"documentation"`
}

type Capability struct {
    Name        string   `json:"name"`
    Type        string   `json:"type"` // sync, async, stream
    Description string   `json:"description"`
    SLA         SLA      `json:"sla"`
}

type SLA struct {
    Availability   float64 `json:"availability"`   // 99.9
    Latency       string  `json:"latency"`        // p99 < 100ms
    Throughput    string  `json:"throughput"`     // 1000 req/s
    ErrorBudget   float64 `json:"error_budget"`   // 0.1%
}
```

## Inter-Service Communication

### Protocol Buffer Definitions

```protobuf
// proto/common/service.proto
syntax = "proto3";

package common;

import "google/protobuf/timestamp.proto";
import "google/protobuf/any.proto";

// Common message types for all services
message RequestMetadata {
    string request_id = 1;
    string correlation_id = 2;
    string user_id = 3;
    map<string, string> headers = 4;
    google.protobuf.Timestamp timestamp = 5;
}

message ResponseMetadata {
    string request_id = 1;
    int32 status_code = 2;
    google.protobuf.Timestamp timestamp = 3;
    int64 duration_ms = 4;
}

message Error {
    string code = 1;
    string message = 2;
    map<string, string> details = 3;
    string trace_id = 4;
}

// Service discovery
message ServiceEndpoint {
    string service_name = 1;
    string version = 2;
    string protocol = 3; // grpc, http, graphql
    string address = 4;
    int32 port = 5;
    map<string, string> metadata = 6;
}
```

### Multi-Language gRPC Implementation

```go
// Go gRPC Server
package main

import (
    "context"
    "log"
    "net"
    
    "google.golang.org/grpc"
    "github.com/example/proto/user"
    "github.com/example/common/tracing"
)

type userService struct {
    user.UnimplementedUserServiceServer
    repo UserRepository
}

func (s *userService) GetUser(ctx context.Context, req *user.GetUserRequest) (*user.GetUserResponse, error) {
    span := tracing.StartSpan(ctx, "GetUser")
    defer span.End()
    
    u, err := s.repo.FindByID(ctx, req.UserId)
    if err != nil {
        return nil, handleError(err)
    }
    
    return &user.GetUserResponse{
        User: transformUser(u),
        Metadata: createResponseMetadata(req.Metadata),
    }, nil
}

func main() {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatalf("failed to listen: %v", err)
    }
    
    s := grpc.NewServer(
        grpc.UnaryInterceptor(unaryInterceptor),
        grpc.StreamInterceptor(streamInterceptor),
    )
    
    user.RegisterUserServiceServer(s, &userService{
        repo: NewUserRepository(),
    })
    
    log.Println("gRPC server starting on :50051")
    if err := s.Serve(lis); err != nil {
        log.Fatalf("failed to serve: %v", err)
    }
}
```

```python
# Python gRPC Client
import grpc
import asyncio
from typing import Optional
from proto.user import user_pb2, user_pb2_grpc
from proto.common import service_pb2
from opentelemetry import trace
from circuitbreaker import circuit

tracer = trace.get_tracer(__name__)

class UserServiceClient:
    def __init__(self, address: str):
        self.channel = grpc.insecure_channel(
            address,
            options=[
                ('grpc.keepalive_time_ms', 30000),
                ('grpc.keepalive_timeout_ms', 10000),
            ]
        )
        self.stub = user_pb2_grpc.UserServiceStub(self.channel)
    
    @circuit(failure_threshold=5, recovery_timeout=30)
    async def get_user(self, user_id: str, metadata: dict) -> Optional[user_pb2.User]:
        with tracer.start_as_current_span("get_user") as span:
            span.set_attribute("user.id", user_id)
            
            request = user_pb2.GetUserRequest(
                user_id=user_id,
                metadata=self._create_metadata(metadata)
            )
            
            try:
                response = await self.stub.GetUser(
                    request,
                    timeout=5.0,
                    metadata=self._extract_headers(metadata)
                )
                return response.user
            except grpc.RpcError as e:
                span.record_exception(e)
                if e.code() == grpc.StatusCode.NOT_FOUND:
                    return None
                raise
    
    def _create_metadata(self, metadata: dict) -> service_pb2.RequestMetadata:
        return service_pb2.RequestMetadata(
            request_id=metadata.get('request_id'),
            correlation_id=metadata.get('correlation_id'),
            user_id=metadata.get('user_id'),
            headers=metadata.get('headers', {})
        )
```

```java
// Java gRPC Service
package com.example.order;

import io.grpc.stub.StreamObserver;
import io.opentracing.Span;
import io.opentracing.Tracer;
import org.springframework.stereotype.Service;

@Service
public class OrderServiceImpl extends OrderServiceGrpc.OrderServiceImplBase {
    
    private final OrderRepository orderRepository;
    private final Tracer tracer;
    
    @Override
    public void createOrder(CreateOrderRequest request, 
                          StreamObserver<CreateOrderResponse> responseObserver) {
        Span span = tracer.buildSpan("createOrder")
            .asChildOf(extractSpanContext(request))
            .start();
        
        try {
            Order order = Order.builder()
                .userId(request.getUserId())
                .items(transformItems(request.getItemsList()))
                .shippingAddress(request.getShippingAddress())
                .build();
            
            Order savedOrder = orderRepository.save(order);
            
            CreateOrderResponse response = CreateOrderResponse.newBuilder()
                .setOrder(transformOrder(savedOrder))
                .setMetadata(createResponseMetadata(request.getMetadata()))
                .build();
            
            responseObserver.onNext(response);
            responseObserver.onCompleted();
            
        } catch (Exception e) {
            span.setTag("error", true);
            span.log(ImmutableMap.of("error.message", e.getMessage()));
            responseObserver.onError(
                Status.INTERNAL
                    .withDescription(e.getMessage())
                    .asRuntimeException()
            );
        } finally {
            span.finish();
        }
    }
}
```

### Event-Driven Communication

```rust
// Rust Event Producer
use rdkafka::producer::{FutureProducer, FutureRecord};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::Utc;

#[derive(Debug, Serialize, Deserialize)]
struct DomainEvent {
    event_id: String,
    event_type: String,
    aggregate_id: String,
    aggregate_type: String,
    timestamp: i64,
    version: i32,
    payload: serde_json::Value,
    metadata: EventMetadata,
}

#[derive(Debug, Serialize, Deserialize)]
struct EventMetadata {
    correlation_id: String,
    causation_id: String,
    user_id: Option<String>,
    source_service: String,
}

pub struct EventPublisher {
    producer: FutureProducer,
    topic_prefix: String,
}

impl EventPublisher {
    pub async fn publish_event<T: Serialize>(
        &self,
        aggregate_type: &str,
        aggregate_id: &str,
        event_type: &str,
        payload: &T,
        metadata: EventMetadata,
    ) -> Result<(), PublishError> {
        let event = DomainEvent {
            event_id: Uuid::new_v4().to_string(),
            event_type: event_type.to_string(),
            aggregate_id: aggregate_id.to_string(),
            aggregate_type: aggregate_type.to_string(),
            timestamp: Utc::now().timestamp_millis(),
            version: 1,
            payload: serde_json::to_value(payload)?,
            metadata,
        };
        
        let topic = format!("{}.{}", self.topic_prefix, aggregate_type);
        let key = aggregate_id.as_bytes();
        let payload = serde_json::to_vec(&event)?;
        
        let record = FutureRecord::to(&topic)
            .key(key)
            .payload(&payload)
            .headers(create_headers(&event));
        
        let delivery_result = self.producer.send(record, Duration::from_secs(5)).await;
        
        match delivery_result {
            Ok((partition, offset)) => {
                info!("Event published to partition {} at offset {}", partition, offset);
                Ok(())
            }
            Err((e, _)) => {
                error!("Failed to publish event: {}", e);
                Err(PublishError::KafkaError(e))
            }
        }
    }
}
```

## Shared Infrastructure Components

### Service Mesh Configuration

```yaml
# istio-service-mesh.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: polyglot-mesh-config
  namespace: istio-system
data:
  mesh: |
    defaultConfig:
      proxyStatsMatcher:
        inclusionRegexps:
        - ".*outlier_detection.*"
        - ".*circuit_breakers.*"
        - ".*upstream_rq_retry.*"
        - ".*upstream_rq_pending.*"
      holdApplicationUntilProxyStarts: true
    defaultProviders:
      tracing:
      - jaeger
      metrics:
      - prometheus
      - otel
    extensionProviders:
    - name: jaeger
      envoyExtAuthzGrpc:
        service: jaeger-collector.istio-system.svc.cluster.local
        port: 14250
    - name: otel
      envoyOtelAls:
        service: opentelemetry-collector.istio-system.svc.cluster.local
        port: 4317
---
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: user-service
spec:
  hosts:
  - user-service
  http:
  - match:
    - headers:
        x-version:
          exact: v2
    route:
    - destination:
        host: user-service
        subset: v2
      weight: 100
  - route:
    - destination:
        host: user-service
        subset: v1
      weight: 90
    - destination:
        host: user-service
        subset: v2
      weight: 10
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: user-service
spec:
  host: user-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
    outlierDetection:
      consecutiveErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
```

### Centralized Logging

```yaml
# fluent-bit-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
data:
  fluent-bit.conf: |
    [SERVICE]
        Daemon Off
        Flush 1
        Log_Level info
        Parsers_File parsers.conf
        Parsers_File custom_parsers.conf
        HTTP_Server On
        HTTP_Listen 0.0.0.0
        HTTP_Port 2020
        Health_Check On
    
    [INPUT]
        Name tail
        Path /var/log/containers/*.log
        Parser docker
        Tag kube.*
        Refresh_Interval 5
        Mem_Buf_Limit 50MB
        Skip_Long_Lines On
    
    [FILTER]
        Name kubernetes
        Match kube.*
        Kube_URL https://kubernetes.default.svc:443
        Kube_CA_File /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        Kube_Token_File /var/run/secrets/kubernetes.io/serviceaccount/token
        Kube_Tag_Prefix kube.var.log.containers.
        Merge_Log On
        K8S-Logging.Parser On
        K8S-Logging.Exclude On
    
    [FILTER]
        Name parser
        Match kube.*
        Key_Name log
        Parser json
        Parser go_log
        Parser python_log
        Parser java_log
        Reserve_Data On
    
    [OUTPUT]
        Name es
        Match *
        Host elasticsearch
        Port 9200
        Logstash_Format On
        Retry_Limit 5
        Type flb_type
  
  custom_parsers.conf: |
    [PARSER]
        Name go_log
        Format regex
        Regex ^(?<timestamp>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \[(?<level>\w+)\] (?<message>.*)$
        Time_Key timestamp
        Time_Format %Y/%m/%d %H:%M:%S
    
    [PARSER]
        Name python_log
        Format regex
        Regex ^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) - (?<logger>\S+) - (?<level>\w+) - (?<message>.*)$
        Time_Key timestamp
        Time_Format %Y-%m-%d %H:%M:%S,%L
    
    [PARSER]
        Name java_log
        Format regex
        Regex ^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(?<thread>.*?)\] (?<level>\w+)\s+(?<logger>\S+) - (?<message>.*)$
        Time_Key timestamp
        Time_Format %Y-%m-%d %H:%M:%S.%L
```

### Distributed Tracing

```go
// tracing/tracer.go
package tracing

import (
    "context"
    "fmt"
    
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/jaeger"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.4.0"
    "go.opentelemetry.io/otel/trace"
)

type TracerConfig struct {
    ServiceName string
    ServiceVersion string
    Environment string
    JaegerEndpoint string
    SampleRate float64
}

func InitTracer(config TracerConfig) (func(), error) {
    exp, err := jaeger.New(
        jaeger.WithCollectorEndpoint(
            jaeger.WithEndpoint(config.JaegerEndpoint),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("creating Jaeger exporter: %w", err)
    }
    
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exp),
        sdktrace.WithSampler(
            sdktrace.ParentBased(
                sdktrace.TraceIDRatioBased(config.SampleRate),
            ),
        ),
        sdktrace.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceNameKey.String(config.ServiceName),
            semconv.ServiceVersionKey.String(config.ServiceVersion),
            attribute.String("environment", config.Environment),
        )),
    )
    
    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(
        propagation.NewCompositeTextMapPropagator(
            propagation.TraceContext{},
            propagation.Baggage{},
        ),
    )
    
    return func() {
        _ = tp.Shutdown(context.Background())
    }, nil
}

// HTTP middleware for tracing
func HTTPTraceMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        tracer := otel.Tracer("http-server")
        
        ctx := otel.GetTextMapPropagator().Extract(
            r.Context(),
            propagation.HeaderCarrier(r.Header),
        )
        
        spanName := fmt.Sprintf("%s %s", r.Method, r.URL.Path)
        ctx, span := tracer.Start(ctx, spanName,
            trace.WithAttributes(
                semconv.HTTPMethodKey.String(r.Method),
                semconv.HTTPTargetKey.String(r.URL.Path),
                semconv.HTTPSchemeKey.String(r.URL.Scheme),
            ),
        )
        defer span.End()
        
        // Wrap response writer to capture status code
        wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
        
        next.ServeHTTP(wrapped, r.WithContext(ctx))
        
        span.SetAttributes(
            semconv.HTTPStatusCodeKey.Int(wrapped.statusCode),
        )
    })
}
```

## Development Workflow

### Monorepo Structure

```
polyglot-services/
├── services/
│   ├── user-service/          # Go
│   │   ├── cmd/
│   │   ├── internal/
│   │   ├── pkg/
│   │   ├── Dockerfile
│   │   └── go.mod
│   ├── order-service/         # Java
│   │   ├── src/
│   │   ├── pom.xml
│   │   └── Dockerfile
│   ├── analytics-service/     # Python
│   │   ├── src/
│   │   ├── requirements.txt
│   │   ├── setup.py
│   │   └── Dockerfile
│   └── payment-service/       # Rust
│       ├── src/
│       ├── Cargo.toml
│       └── Dockerfile
├── libraries/
│   ├── proto/                 # Shared protobuf definitions
│   ├── common-go/            # Go shared libraries
│   ├── common-java/          # Java shared libraries
│   └── common-python/        # Python shared libraries
├── tools/
│   ├── build/                # Build scripts
│   ├── deploy/               # Deployment configurations
│   └── test/                 # Integration test suites
└── Makefile                  # Root build orchestration
```

### Unified CI/CD Pipeline

```yaml
# .github/workflows/polyglot-ci.yml
name: Polyglot CI/CD

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      services: ${{ steps.filter.outputs.changes }}
    steps:
    - uses: actions/checkout@v3
    - uses: dorny/paths-filter@v2
      id: filter
      with:
        filters: |
          user-service:
            - 'services/user-service/**'
            - 'libraries/proto/**'
            - 'libraries/common-go/**'
          order-service:
            - 'services/order-service/**'
            - 'libraries/proto/**'
            - 'libraries/common-java/**'
          analytics-service:
            - 'services/analytics-service/**'
            - 'libraries/proto/**'
            - 'libraries/common-python/**'
          payment-service:
            - 'services/payment-service/**'
            - 'libraries/proto/**'

  build-go-service:
    needs: detect-changes
    if: contains(needs.detect-changes.outputs.services, 'user-service')
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - uses: actions/setup-go@v4
      with:
        go-version: '1.21'
    - name: Test
      run: |
        cd services/user-service
        go test -v ./... -coverprofile=coverage.out
        go tool cover -html=coverage.out -o coverage.html
    - name: Build
      run: |
        cd services/user-service
        CGO_ENABLED=0 go build -o bin/service cmd/main.go
    - name: Build Docker
      run: |
        docker build -t user-service:${{ github.sha }} services/user-service

  build-java-service:
    needs: detect-changes
    if: contains(needs.detect-changes.outputs.services, 'order-service')
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - uses: actions/setup-java@v3
      with:
        java-version: '17'
        distribution: 'temurin'
    - name: Test
      run: |
        cd services/order-service
        mvn clean test
    - name: Build
      run: |
        cd services/order-service
        mvn clean package
    - name: Build Docker
      run: |
        docker build -t order-service:${{ github.sha }} services/order-service

  integration-tests:
    needs: [build-go-service, build-java-service]
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Start services
      run: |
        docker-compose -f docker-compose.test.yml up -d
    - name: Run integration tests
      run: |
        cd tools/test
        ./run-integration-tests.sh
    - name: Cleanup
      run: |
        docker-compose -f docker-compose.test.yml down
```

## Operational Excellence

### Unified Monitoring Dashboard

```go
// monitoring/aggregator.go
package monitoring

import (
    "context"
    "fmt"
    "sync"
    "time"
    
    "github.com/prometheus/client_golang/prometheus"
)

type ServiceMetrics struct {
    ServiceName string
    Language    string
    Metrics     map[string]float64
    LastUpdated time.Time
}

type MetricsAggregator struct {
    mu       sync.RWMutex
    services map[string]*ServiceMetrics
    
    // Prometheus metrics
    requestRate     *prometheus.GaugeVec
    errorRate       *prometheus.GaugeVec
    latency         *prometheus.HistogramVec
    saturationGauge *prometheus.GaugeVec
}

func NewMetricsAggregator() *MetricsAggregator {
    ma := &MetricsAggregator{
        services: make(map[string]*ServiceMetrics),
        
        requestRate: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "polyglot_request_rate",
                Help: "Request rate per service",
            },
            []string{"service", "language"},
        ),
        
        errorRate: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "polyglot_error_rate",
                Help: "Error rate per service",
            },
            []string{"service", "language"},
        ),
        
        latency: prometheus.NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "polyglot_latency_seconds",
                Help:    "Request latency distribution",
                Buckets: prometheus.DefBuckets,
            },
            []string{"service", "language", "operation"},
        ),
        
        saturationGauge: prometheus.NewGaugeVec(
            prometheus.GaugeOpts{
                Name: "polyglot_saturation",
                Help: "Resource saturation per service",
            },
            []string{"service", "language", "resource"},
        ),
    }
    
    // Register metrics
    prometheus.MustRegister(
        ma.requestRate,
        ma.errorRate,
        ma.latency,
        ma.saturationGauge,
    )
    
    return ma
}

func (ma *MetricsAggregator) CollectMetrics(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()
    
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            ma.collectFromAllServices()
        }
    }
}

func (ma *MetricsAggregator) collectFromAllServices() {
    ma.mu.RLock()
    services := make([]*ServiceMetrics, 0, len(ma.services))
    for _, svc := range ma.services {
        services = append(services, svc)
    }
    ma.mu.RUnlock()
    
    var wg sync.WaitGroup
    for _, svc := range services {
        wg.Add(1)
        go func(s *ServiceMetrics) {
            defer wg.Done()
            ma.collectServiceMetrics(s)
        }(svc)
    }
    wg.Wait()
}
```

### Cost Optimization

```python
# cost_analyzer.py
import pandas as pd
from datetime import datetime, timedelta
from typing import Dict, List, Tuple
import boto3

class PolyglotCostAnalyzer:
    def __init__(self, services: List[Dict[str, str]]):
        self.services = services
        self.ce_client = boto3.client('ce')
        self.cw_client = boto3.client('cloudwatch')
    
    def analyze_language_costs(self, days: int = 30) -> pd.DataFrame:
        """Analyze costs broken down by programming language"""
        end_date = datetime.now().date()
        start_date = end_date - timedelta(days=days)
        
        costs_by_language = {}
        
        for service in self.services:
            cost = self._get_service_cost(
                service['name'],
                start_date,
                end_date
            )
            
            language = service['language']
            if language not in costs_by_language:
                costs_by_language[language] = {
                    'total_cost': 0,
                    'compute_cost': 0,
                    'storage_cost': 0,
                    'network_cost': 0,
                    'service_count': 0
                }
            
            costs_by_language[language]['total_cost'] += cost['total']
            costs_by_language[language]['compute_cost'] += cost['compute']
            costs_by_language[language]['storage_cost'] += cost['storage']
            costs_by_language[language]['network_cost'] += cost['network']
            costs_by_language[language]['service_count'] += 1
        
        df = pd.DataFrame.from_dict(costs_by_language, orient='index')
        df['avg_cost_per_service'] = df['total_cost'] / df['service_count']
        
        return df.sort_values('total_cost', ascending=False)
    
    def optimize_resource_allocation(self) -> List[Dict[str, any]]:
        """Generate recommendations for resource optimization"""
        recommendations = []
        
        for service in self.services:
            metrics = self._get_service_metrics(service['name'])
            
            # Check CPU utilization
            if metrics['cpu_avg'] < 20:
                recommendations.append({
                    'service': service['name'],
                    'language': service['language'],
                    'type': 'downsize',
                    'reason': f"Low CPU utilization: {metrics['cpu_avg']:.1f}%",
                    'estimated_savings': self._estimate_savings(
                        service['name'], 
                        'downsize'
                    )
                })
            
            # Check memory utilization for JVM services
            if service['language'] == 'java' and metrics['memory_avg'] < 50:
                recommendations.append({
                    'service': service['name'],
                    'language': service['language'],
                    'type': 'jvm_tuning',
                    'reason': f"Low memory utilization: {metrics['memory_avg']:.1f}%",
                    'suggestion': "Reduce JVM heap size or container memory"
                })
            
            # Check for over-provisioned services
            if metrics['p99_latency'] < 50 and metrics['error_rate'] < 0.1:
                recommendations.append({
                    'service': service['name'],
                    'language': service['language'],
                    'type': 'reduce_replicas',
                    'reason': "Service performing well with current load",
                    'current_replicas': metrics['replica_count'],
                    'suggested_replicas': max(2, metrics['replica_count'] - 1)
                })
        
        return recommendations
```

## Best Practices

### 1. **Standardize Common Concerns**
- Use shared libraries for cross-cutting concerns
- Implement consistent logging formats
- Standardize error handling and propagation
- Use common authentication/authorization mechanisms

### 2. **Language-Specific Guidelines**
- Document language selection criteria
- Maintain language-specific style guides
- Provide templates and bootstrapping tools
- Create language-specific CI/CD templates

### 3. **Team Organization**
- Form cross-functional teams with diverse language expertise
- Establish language guilds for knowledge sharing
- Rotate engineers across different services
- Maintain comprehensive documentation

### 4. **Operational Standards**
- Implement consistent health checks
- Standardize metrics and dashboards
- Use unified alerting rules
- Maintain service catalogs and dependencies

### 5. **Testing Strategy**
- Implement contract testing between services
- Use language-agnostic integration tests
- Standardize performance testing approaches
- Maintain shared test data and environments

## Conclusion

Polyglot architectures offer significant benefits in terms of using the right tool for the job, but require careful planning and standardization to manage effectively. By implementing consistent communication patterns, shared infrastructure, and operational practices, organizations can harness the power of multiple languages while maintaining system coherence and operational efficiency. The key is finding the right balance between flexibility and standardization.