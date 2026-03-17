---
title: "Kubernetes Jaeger Distributed Tracing: Sampling Strategies and Storage Backends"
date: 2031-03-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Jaeger", "Distributed Tracing", "OpenTelemetry", "Observability", "Elasticsearch"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Jaeger distributed tracing on Kubernetes: operator deployment, sampling strategies, Elasticsearch vs Cassandra vs Badger storage backends, trace retention, Query API, and OpenTelemetry migration."
more_link: "yes"
url: "/kubernetes-jaeger-distributed-tracing-sampling-storage/"
---

Distributed tracing transforms debugging microservice architectures from archaeology into investigation. When a request touches 15 services before returning an error, logs from each service tell 15 isolated stories. A distributed trace tells one coherent story: the complete causal chain of operations, their latencies, and where failures occurred. Jaeger is the CNCF-graduated tracing platform most widely deployed on Kubernetes, and configuring it correctly for production requires careful attention to sampling strategy, storage backend selection, and query performance. This guide covers the full production deployment lifecycle.

<!--more-->

# Kubernetes Jaeger Distributed Tracing: Sampling Strategies and Storage Backends

## Section 1: Jaeger Architecture Overview

Jaeger's architecture has evolved through several generations. The current production-recommended deployment uses the Jaeger Operator on Kubernetes with separate components that can be scaled independently.

### Core Components

**Jaeger Agent** (deprecated in favor of OpenTelemetry Collector): A sidecar or daemonset that receives spans from instrumented applications via UDP, performs validation and batching, and forwards to the Collector.

**Jaeger Collector**: Receives spans from Agents or directly from applications, validates them, applies transformations, and writes to the storage backend. Supports gRPC (recommended), HTTP, and TChannel protocols.

**Jaeger Query**: Serves the Jaeger UI and provides the REST API for trace retrieval. Reads from the storage backend.

**Storage Backend**: Cassandra, Elasticsearch/OpenSearch, or Badger (embedded key-value store for development/testing).

**Jaeger Operator**: Kubernetes operator that manages the full Jaeger deployment lifecycle, including schema initialization for Cassandra/Elasticsearch and upgrade coordination.

```
Instrumented Service → [OTLP/Jaeger protocol] → Collector → Storage Backend
                                                                    ↑
                                                        Query ←────┘
                                                          ↑
                                                       Jaeger UI
```

### Span Data Model

```
Trace
├── Trace ID: 64-bit or 128-bit unique identifier
├── Spans: List of operations
│   ├── Span ID: 64-bit unique within trace
│   ├── Parent Span ID: (none for root span)
│   ├── Operation Name: "GET /api/users"
│   ├── Start Time: microsecond precision
│   ├── Duration: microseconds
│   ├── Tags: key-value metadata (http.status_code, db.type, etc.)
│   ├── Logs: timestamped events within the span
│   └── SpanContext: trace propagation data
└── Process: service name, tags (hostname, version, etc.)
```

## Section 2: Jaeger Operator Deployment

### Installing the Jaeger Operator

```bash
# Create namespace for Jaeger operator
kubectl create namespace observability

# Install cert-manager (required by Jaeger operator for webhook certs)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
kubectl wait --for=condition=Available deployment/cert-manager -n cert-manager --timeout=120s

# Install Jaeger operator
kubectl apply -f https://github.com/jaegertracing/jaeger-operator/releases/latest/download/jaeger-operator.yaml \
  -n observability

# Verify operator is running
kubectl -n observability get deployment jaeger-operator
kubectl -n observability logs deployment/jaeger-operator
```

### Production Jaeger Instance with Elasticsearch

For production deployments, Elasticsearch provides the best balance of query performance and operational simplicity:

```yaml
# jaeger-production.yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
  namespace: observability
spec:
  strategy: production

  # Collector configuration
  collector:
    replicas: 3
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    autoscale: true
    minReplicas: 3
    maxReplicas: 10
    options:
      collector:
        num-workers: 50
        queue-size: 100000
      kafka:
        # Optional: use Kafka as buffer between collector and storage
        producer:
          brokers: kafka-headless.kafka.svc.cluster.local:9092
          topic: jaeger-spans

  # Query service configuration
  query:
    replicas: 2
    resources:
      requests:
        cpu: 250m
        memory: 256Mi
      limits:
        cpu: 1000m
        memory: 1Gi
    options:
      query:
        max-clock-skew-adjustment: 30s
        additional-headers:
          - "Access-Control-Allow-Origin: *"

  # Jaeger UI configuration
  ui:
    options:
      dependencies:
        menuEnabled: true
      archiveEnabled: true
      tracking:
        gaID: ""

  # Elasticsearch storage
  storage:
    type: elasticsearch
    esIndexCleaner:
      enabled: true
      numberOfDays: 7
      schedule: "55 23 * * *"
    elasticsearch:
      nodeCount: 3
      resources:
        requests:
          cpu: 1
          memory: 2Gi
        limits:
          cpu: 4
          memory: 4Gi
      storage:
        storageClassName: fast-ssd
        size: 200Gi
      redundancyPolicy: SingleRedundancy

  # Ingress for Jaeger UI
  ingress:
    enabled: true
    annotations:
      nginx.ingress.kubernetes.io/auth-type: basic
      nginx.ingress.kubernetes.io/auth-secret: jaeger-basic-auth
    hosts:
    - jaeger.observability.company.com

  # Agent configuration (if using agent sidecar injection)
  agent:
    strategy: DaemonSet
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 256Mi
```

```bash
kubectl apply -f jaeger-production.yaml

# Wait for all components
kubectl -n observability wait --for=condition=Available jaeger/jaeger-production --timeout=300s

# Verify components
kubectl -n observability get pods -l app.kubernetes.io/instance=jaeger-production
```

### Development/Testing with Badger (All-in-One)

For development environments, the all-in-one mode is simpler:

```yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-dev
  namespace: observability
spec:
  strategy: allInOne
  allInOne:
    image: jaegertracing/all-in-one:latest
    options:
      log-level: debug
  storage:
    type: badger
    badger:
      ephemeral: false
      maintenance-interval: 5m
      span-store-ttl: 72h
      values-path: /badger/data/values
      key-directory: /badger/data/keys
  volumeMounts:
  - name: data
    mountPath: /badger
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: jaeger-badger-pvc
```

## Section 3: Sampling Strategies

Sampling is the most critical configuration decision for production tracing. Collecting 100% of traces is economically prohibitive at scale and generates more noise than signal. The right sampling strategy depends on your traffic volume, latency sensitivity requirements, and storage budget.

### Probabilistic Sampling

The simplest strategy: sample a fixed percentage of all traces.

```yaml
# In Jaeger Agent configuration or application configuration
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
spec:
  sampling:
    options:
      default_strategy:
        type: probabilistic
        param: 0.01  # Sample 1% of traces
      service_strategies:
      # Override for specific services
      - service: payment-service
        type: probabilistic
        param: 0.1  # Sample 10% of payment traces (higher value)
      - service: health-check-service
        type: probabilistic
        param: 0.001  # Sample 0.1% of health checks (very noisy)
```

**Limitation:** Probabilistic sampling may miss rare errors if the error rate is lower than the sampling rate. A 1% sampler on a service with 0.1% error rate will miss 90% of errors.

### Rate-Limiting Sampling

Sample a fixed number of traces per second per service, regardless of traffic volume:

```yaml
spec:
  sampling:
    options:
      default_strategy:
        type: ratelimiting
        param: 100  # 100 traces per second per service
      service_strategies:
      - service: api-gateway
        type: ratelimiting
        param: 1000  # API gateway handles more traffic, allow more traces
      - service: background-worker
        type: ratelimiting
        param: 10   # Background worker runs slowly, fewer traces needed
```

Rate-limiting is particularly useful during traffic spikes: it provides consistent data volume to the storage backend regardless of request rate.

### Adaptive Sampling

Jaeger's most sophisticated sampling strategy adjusts rates dynamically based on:
- Actual traffic volume per service/operation
- Target spans per second for the entire system
- Per-operation configurable minimums

```yaml
spec:
  sampling:
    options:
      default_strategy:
        type: probabilistic
        param: 0.001
      max_traces_per_second: 1000  # Total system budget
      adaptive_sampling:
        enabled: true
        target_samples_per_second: 1000
        default_min_samples_per_second: 1.0  # Never sample less than 1/sec per operation
      strategies_store_update_interval: 1m
```

Adaptive sampling requires the Sampling Manager component which reads from the storage backend to understand current span rates:

```yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
spec:
  sampling:
    options:
      strategies_store_update_interval: 1m
  collector:
    options:
      sampling:
        initial.sampling.probability: 0.01
        target.samples.per.second: 1.0
```

### Tail-Based Sampling with OpenTelemetry Collector

Head-based sampling (deciding at trace start whether to sample) cannot make decisions based on trace outcome. Tail-based sampling buffers the complete trace and samples based on actual behavior:

```yaml
# OpenTelemetry Collector configuration for tail-based sampling
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  tail_sampling:
    decision_wait: 10s  # Wait 10s for all spans before deciding
    num_traces: 100000  # Buffer up to 100k traces in memory
    expected_new_traces_per_sec: 10000
    policies:
      # Always sample traces with errors
      - name: errors-policy
        type: status_code
        status_code:
          status_codes: [ERROR]
      # Always sample slow traces (>500ms)
      - name: slow-traces-policy
        type: latency
        latency:
          threshold_ms: 500
      # Sample 1% of everything else
      - name: probabilistic-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 1
      # Always sample traces with specific attributes
      - name: important-customers-policy
        type: string_attribute
        string_attribute:
          key: customer.tier
          values: [platinum, gold]
          enabled_regex_matching: false

exporters:
  jaeger:
    endpoint: jaeger-collector.observability.svc.cluster.local:14250
    tls:
      insecure: false
      ca_file: /etc/ssl/certs/ca-certificates.crt

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling]
      exporters: [jaeger]
```

Deploy the tail-sampling collector:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector-tail-sampler
  namespace: observability
spec:
  replicas: 3  # Must sticky-route by trace ID for consistent decisions
  selector:
    matchLabels:
      app: otel-tail-sampler
  template:
    metadata:
      labels:
        app: otel-tail-sampler
    spec:
      containers:
      - name: collector
        image: otel/opentelemetry-collector-contrib:latest
        args: ["--config=/etc/otel/config.yaml"]
        ports:
        - containerPort: 4317  # OTLP gRPC
        - containerPort: 4318  # OTLP HTTP
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi  # Buffering traces requires significant memory
        volumeMounts:
        - name: config
          mountPath: /etc/otel
      volumes:
      - name: config
        configMap:
          name: otel-collector-config
---
# IMPORTANT: Tail-based sampling requires all spans from the same trace
# to go to the same collector instance. Use consistent hashing load balancing.
apiVersion: v1
kind: Service
metadata:
  name: otel-tail-sampler
  namespace: observability
spec:
  # Use headless service + consistent hashing in the sending collector
  clusterIP: None
  selector:
    app: otel-tail-sampler
  ports:
  - port: 4317
    name: otlp-grpc
```

## Section 4: Storage Backends

### Elasticsearch Backend

Elasticsearch is the most popular Jaeger storage backend for production deployments, offering excellent query performance and familiar operational tooling.

#### Index Structure

Jaeger creates separate indices per day:

```
jaeger-span-YYYY-MM-DD     <- span data
jaeger-service-YYYY-MM-DD  <- service registry
jaeger-dependencies-YYYY-MM-DD  <- service dependency graph
```

#### Elasticsearch Configuration Tuning

```yaml
# Jaeger collector ES settings
spec:
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: https://elasticsearch.elastic.svc.cluster.local:9200
        index-prefix: jaeger
        num-shards: 5        # Shards per index, set to number of ES data nodes
        num-replicas: 1      # Replicas for HA
        create-index-templates: true
        max-span-age: 168h   # 7 days retention

        # Bulk indexing optimization
        bulk:
          workers: 10
          actions: 1000
          size: 5000000  # 5MB bulk request size
          flush-interval: 200ms

        # TLS configuration
        tls:
          enabled: true
          ca: /es-tls/ca.crt
          cert: /es-tls/tls.crt
          key: /es-tls/tls.key

        # Authentication
        username: jaeger
        password-path: /es-credentials/password

        # Query settings
        max-num-spans: 10000  # Max spans returned per query

        # Rollover support for large deployments
        use-aliases: true
```

#### Index Lifecycle Management

For large deployments, configure ILM to automatically manage index rollover:

```json
PUT _ilm/policy/jaeger-policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_age": "1d",
            "max_size": "50gb"
          },
          "set_priority": {
            "priority": 100
          }
        }
      },
      "warm": {
        "min_age": "2d",
        "actions": {
          "forcemerge": {
            "max_num_segments": 1
          },
          "shrink": {
            "number_of_shards": 1
          },
          "set_priority": {
            "priority": 50
          }
        }
      },
      "delete": {
        "min_age": "7d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

#### Elasticsearch Query Performance

```bash
# Check index sizes
curl -s https://elasticsearch:9200/_cat/indices/jaeger-span-* \
  -u jaeger:<password> \
  --cacert /path/to/ca.crt | \
  sort -k9 -h | tail -20

# Check query latency from Jaeger UI perspective
kubectl -n observability logs deployment/jaeger-query | \
  grep "query=" | \
  awk -F'duration=' '{print $2}' | \
  sort -n | tail -20

# Optimize: add index for trace ID queries
curl -XPUT "https://elasticsearch:9200/jaeger-span-*/_settings" \
  -H "Content-Type: application/json" \
  -u jaeger:<password> \
  --cacert /path/to/ca.crt \
  -d '{
    "index": {
      "refresh_interval": "30s"
    }
  }'
```

### Cassandra Backend

Cassandra excels for write-heavy tracing workloads with predictable query patterns. It provides linear scalability and configurable consistency levels.

#### Cassandra Schema for Jaeger

```yaml
spec:
  storage:
    type: cassandra
    cassandra:
      servers: cassandra-headless.cassandra.svc.cluster.local
      keyspace: jaeger_v1_production
      create-schema: true
      schema:
        datacenter: dc1
        replication-factor: 3
        mode: prod  # Creates optimized production schema
        trace-ttl: 172800  # 2 days TTL in seconds
        dependencies-ttl: 0  # No TTL for dependency graph
    options:
      cassandra:
        connections-per-host: 2
        max-retry-attempts: 3
        timeout: 500ms
        connect-timeout: 5s
        reconnect-interval: 1m
        consistency: LOCAL_QUORUM
        disable-compression: false
        port: 9042
        keyspace: jaeger_v1_production
        tls:
          enabled: true
          ca: /cassandra-tls/ca.crt
          cert: /cassandra-tls/tls.crt
          key: /cassandra-tls/tls.key
```

#### Cassandra Table Structure

The Jaeger schema for Cassandra uses several tables optimized for trace access patterns:

```sql
-- Traces table: store span data, partitioned by trace ID
CREATE TABLE IF NOT EXISTS traces (
    trace_id    blob,
    span_id     bigint,
    span        blob,
    PRIMARY KEY (trace_id, span_id)
) WITH compaction = {'class': 'LeveledCompactionStrategy'}
  AND default_time_to_live = 172800;  -- 2 days

-- Service names table: support service enumeration
CREATE TABLE IF NOT EXISTS service_names (
    service_name text,
    PRIMARY KEY (service_name)
) WITH compaction = {'class': 'LeveledCompactionStrategy'}
  AND default_time_to_live = 172800;

-- Operation names: support operation enumeration
CREATE TABLE IF NOT EXISTS operation_names (
    service_name    text,
    operation_name  text,
    PRIMARY KEY ((service_name), operation_name)
) WITH compaction = {'class': 'LeveledCompactionStrategy'};

-- Duration index: support duration-based trace queries
CREATE TABLE IF NOT EXISTS duration_index (
    service_name    text,
    operation_name  text,
    bucket          int,
    duration        bigint,
    start_time      bigint,
    trace_id        blob,
    PRIMARY KEY ((service_name, operation_name, bucket), duration, start_time, trace_id)
) WITH CLUSTERING ORDER BY (duration DESC, start_time DESC)
  AND default_time_to_live = 172800;
```

### Badger Backend (Development)

Badger is an embedded key-value store (written in Go) that ships with Jaeger for development and testing:

```yaml
spec:
  strategy: allInOne
  storage:
    type: badger
    badger:
      ephemeral: false
      directory-key: /badger/key
      directory-value: /badger/value
      span-store-ttl: 72h
      maintenance-interval: 5m
      read-only: false
```

Badger cannot be shared between multiple Jaeger replicas, making it unsuitable for production HA deployments.

## Section 5: Trace Data Retention

### Elasticsearch Retention

```yaml
# Configure the es-index-cleaner cronjob
spec:
  storage:
    esIndexCleaner:
      enabled: true
      numberOfDays: 7
      schedule: "55 23 * * *"  # Run at 11:55 PM daily
      image: jaegertracing/jaeger-es-index-cleaner:latest
```

For more granular control:

```bash
# Manual cleanup by date range
kubectl -n observability run jaeger-cleanup \
  --image=jaegertracing/jaeger-es-index-cleaner:latest \
  --restart=Never \
  -- 5 https://elasticsearch:9200  # Keep last 5 days

# Monitor storage usage
kubectl exec -n observability deployment/jaeger-query -- \
  wget -qO- "http://elasticsearch:9200/_cat/indices/jaeger-span-*?v&s=index"
```

### Archiving High-Value Traces

For compliance or debugging purposes, archive specific traces before they expire:

```python
#!/usr/bin/env python3
"""Archive traces matching criteria before expiry."""

import requests
import json
from datetime import datetime, timedelta

JAEGER_QUERY_URL = "http://jaeger-query.observability.svc.cluster.local:16686"
ARCHIVE_BUCKET = "s3://trace-archive"

def get_traces_with_errors(service: str, lookback_hours: int = 1):
    """Retrieve all error traces for a service."""
    end_time = datetime.now()
    start_time = end_time - timedelta(hours=lookback_hours)

    params = {
        "service": service,
        "tags": '{"error": "true"}',
        "start": int(start_time.timestamp() * 1e6),  # microseconds
        "end": int(end_time.timestamp() * 1e6),
        "limit": 1000,
        "lookback": f"{lookback_hours}h"
    }

    response = requests.get(f"{JAEGER_QUERY_URL}/api/traces", params=params)
    response.raise_for_status()
    return response.json()["data"]

def archive_trace(trace_id: str):
    """Archive a specific trace to S3."""
    response = requests.get(f"{JAEGER_QUERY_URL}/api/traces/{trace_id}")
    response.raise_for_status()
    trace_data = response.json()

    # Write to S3 (implementation depends on your S3 client)
    filename = f"trace-{trace_id}-{datetime.now().isoformat()}.json"
    with open(f"/tmp/{filename}", "w") as f:
        json.dump(trace_data, f)
    # aws s3 cp /tmp/{filename} {ARCHIVE_BUCKET}/{filename}

if __name__ == "__main__":
    for service in ["payment-service", "order-service"]:
        traces = get_traces_with_errors(service, lookback_hours=24)
        print(f"Archiving {len(traces)} error traces for {service}")
        for trace in traces:
            archive_trace(trace["traceID"])
```

## Section 6: Jaeger Query API

The Jaeger Query service exposes a REST API that can be used for custom tooling, dashboards, and automated analysis.

### API Reference

```bash
# List all services with active traces
curl "http://jaeger-query:16686/api/services"
# {"data":["api-gateway","payment-service","user-service"],"total":3,"limit":0,"offset":0}

# List operations for a service
curl "http://jaeger-query:16686/api/operations?service=payment-service"

# Search for traces
curl "http://jaeger-query:16686/api/traces?service=payment-service&operation=POST%20%2Fpayments&limit=20&lookback=1h"

# Get a specific trace
curl "http://jaeger-query:16686/api/traces/abcd1234567890ab"

# Get service dependencies
curl "http://jaeger-query:16686/api/dependencies?endTs=$(date +%s)000&lookback=86400000"
```

### Automated Trace Analysis

```go
package traceanalysis

import (
    "encoding/json"
    "fmt"
    "net/http"
    "net/url"
    "sort"
    "time"
)

type JaegerClient struct {
    baseURL    string
    httpClient *http.Client
}

type TraceSearchResult struct {
    Data []Trace `json:"data"`
}

type Trace struct {
    TraceID string  `json:"traceID"`
    Spans   []Span  `json:"spans"`
}

type Span struct {
    SpanID        string     `json:"spanID"`
    OperationName string     `json:"operationName"`
    StartTime     int64      `json:"startTime"` // microseconds
    Duration      int64      `json:"duration"`  // microseconds
    Tags          []KeyValue `json:"tags"`
    Logs          []Log      `json:"logs"`
}

type KeyValue struct {
    Key   string      `json:"key"`
    Type  string      `json:"type"`
    Value interface{} `json:"value"`
}

type Log struct {
    Timestamp int64      `json:"timestamp"`
    Fields    []KeyValue `json:"fields"`
}

func NewJaegerClient(baseURL string) *JaegerClient {
    return &JaegerClient{
        baseURL:    baseURL,
        httpClient: &http.Client{Timeout: 30 * time.Second},
    }
}

// SearchTraces finds traces matching the criteria.
func (c *JaegerClient) SearchTraces(service, operation string, since time.Duration, limit int) ([]Trace, error) {
    endTime := time.Now()
    startTime := endTime.Add(-since)

    params := url.Values{
        "service":   {service},
        "start":     {fmt.Sprintf("%d", startTime.UnixMicro())},
        "end":       {fmt.Sprintf("%d", endTime.UnixMicro())},
        "limit":     {fmt.Sprintf("%d", limit)},
    }
    if operation != "" {
        params.Set("operation", operation)
    }

    resp, err := c.httpClient.Get(c.baseURL + "/api/traces?" + params.Encode())
    if err != nil {
        return nil, fmt.Errorf("search traces: %w", err)
    }
    defer resp.Body.Close()

    var result TraceSearchResult
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        return nil, fmt.Errorf("decode response: %w", err)
    }
    return result.Data, nil
}

// P99Latency calculates the 99th percentile span duration for an operation.
func P99Latency(traces []Trace, operation string) time.Duration {
    var durations []int64
    for _, trace := range traces {
        for _, span := range trace.Spans {
            if span.OperationName == operation {
                durations = append(durations, span.Duration)
            }
        }
    }

    if len(durations) == 0 {
        return 0
    }

    sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
    idx := int(float64(len(durations)) * 0.99)
    if idx >= len(durations) {
        idx = len(durations) - 1
    }
    return time.Duration(durations[idx]) * time.Microsecond
}

// ErrorTraces returns traces containing spans with error=true.
func ErrorTraces(traces []Trace) []Trace {
    var result []Trace
    for _, trace := range traces {
        for _, span := range trace.Spans {
            for _, tag := range span.Tags {
                if tag.Key == "error" && tag.Value == true {
                    result = append(result, trace)
                    goto nextTrace
                }
            }
        }
    nextTrace:
    }
    return result
}
```

### Service Dependency Visualization

```bash
# Generate service dependency graph as DOT format
curl -s "http://jaeger-query:16686/api/dependencies?endTs=$(date +%s)000&lookback=3600000" | \
  python3 -c "
import json, sys
deps = json.load(sys.stdin)['data']
print('digraph services {')
for dep in deps:
    print(f'  \"{dep[\"parent\"]}\" -> \"{dep[\"child\"]}\" [label=\"{dep[\"callCount\"]}\"]')
print('}')
" > dependencies.dot

dot -Tsvg dependencies.dot -o dependencies.svg
```

## Section 7: Instrumenting Applications

### Go Application Instrumentation with OpenTelemetry

```go
package main

import (
    "context"
    "log"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

func initTracer(ctx context.Context, serviceName string) (*sdktrace.TracerProvider, error) {
    conn, err := grpc.DialContext(ctx,
        "otel-collector.observability.svc.cluster.local:4317",
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, err
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, err
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion("1.0.0"),
            attribute.String("deployment.environment", "production"),
        ),
    )
    if err != nil {
        return nil, err
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.01), // 1% sampling
        )),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}

func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    tracer := otel.Tracer("payment-service")

    ctx, span := tracer.Start(ctx, "ProcessPayment",
        trace.WithAttributes(
            attribute.String("payment.method", r.Header.Get("X-Payment-Method")),
            attribute.String("customer.id", r.URL.Query().Get("customer_id")),
        ),
    )
    defer span.End()

    // Call downstream service with trace propagation
    req, _ := http.NewRequestWithContext(ctx, "GET", "http://user-service/validate", nil)
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))
    // ... make the request

    span.SetAttributes(attribute.Bool("payment.success", true))
}

func main() {
    ctx := context.Background()
    tp, err := initTracer(ctx, "payment-service")
    if err != nil {
        log.Fatalf("Failed to initialize tracer: %v", err)
    }
    defer func() {
        if err := tp.Shutdown(ctx); err != nil {
            log.Printf("Error shutting down tracer provider: %v", err)
        }
    }()

    http.HandleFunc("/payments", handler)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### Sidecar Injection for Auto-Instrumentation

```yaml
# Annotate pods for automatic Jaeger agent injection
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
spec:
  template:
    metadata:
      annotations:
        # Inject Jaeger agent as sidecar
        sidecar.jaegertracing.io/inject: "true"
    spec:
      containers:
      - name: payment-service
        image: myregistry/payment-service:latest
        env:
        - name: JAEGER_SERVICE_NAME
          value: payment-service
        - name: JAEGER_AGENT_HOST
          valueFrom:
            fieldRef:
              fieldPath: status.hostIP  # Use DaemonSet agent
        - name: JAEGER_SAMPLER_TYPE
          value: remote
        - name: JAEGER_SAMPLER_MANAGER_HOST_PORT
          value: jaeger-production-query.observability.svc.cluster.local:5778
```

## Section 8: OpenTelemetry Migration Path

Jaeger's client libraries (jaeger-client-go, etc.) are deprecated in favor of OpenTelemetry. Migrating to OpenTelemetry provides vendor-neutral instrumentation while maintaining Jaeger as the backend.

### Migration Strategy

**Phase 1: Install OpenTelemetry Collector alongside Jaeger**

```yaml
# otel-collector-jaeger-exporter.yaml
exporters:
  jaeger:
    endpoint: jaeger-collector.observability.svc.cluster.local:14250
    tls:
      insecure: true

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  # Also accept legacy Jaeger format
  jaeger:
    protocols:
      thrift_compact:
        endpoint: 0.0.0.0:6831
      thrift_binary:
        endpoint: 0.0.0.0:6832
      grpc:
        endpoint: 0.0.0.0:14250

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024

service:
  pipelines:
    traces:
      receivers: [otlp, jaeger]
      processors: [batch]
      exporters: [jaeger]
```

**Phase 2: Migrate services one at a time**

Services can be migrated individually from jaeger-client to otel-sdk. Both protocols are accepted by the collector during the transition period.

**Phase 3: Evaluate Jaeger as backend vs. migration to Tempo or other OTLP-native backends**

Once fully migrated to OpenTelemetry instrumentation, the choice of tracing backend is decoupled from the instrumentation library. Jaeger remains a strong choice, but Grafana Tempo, Honeycomb, and other OTLP-native backends become viable options.

```yaml
# Switch Jaeger backend: just change the exporter in the collector
exporters:
  # Option A: Keep Jaeger
  jaeger:
    endpoint: jaeger-collector:14250

  # Option B: Switch to Tempo
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317
    tls:
      insecure: true

  # Option C: Export to both during migration
  jaeger:
    endpoint: jaeger-collector:14250
  otlp/tempo:
    endpoint: tempo.monitoring.svc.cluster.local:4317

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [jaeger, otlp/tempo]  # Dual-write during migration
```

## Summary

Jaeger distributed tracing on Kubernetes requires careful design across three dimensions: sampling strategy, storage backend, and instrumentation approach.

Sampling strategy has the largest operational impact: probabilistic sampling is simple but misses rare errors, rate-limiting provides predictable storage consumption, adaptive sampling automatically balances cost and coverage, and tail-based sampling (via OpenTelemetry Collector) is the gold standard for ensuring all error traces are captured regardless of overall sampling rate.

Storage backend selection depends on your operational maturity with each technology: Elasticsearch provides the best developer experience with its query API and Kibana integration, Cassandra provides better write scalability for very high trace volumes, and Badger is only appropriate for development environments.

The OpenTelemetry migration path should be planned proactively: migrating from jaeger-client libraries to the OpenTelemetry SDK now provides instrumentation independence and positions your organization to evaluate backend alternatives without re-instrumenting every service.
