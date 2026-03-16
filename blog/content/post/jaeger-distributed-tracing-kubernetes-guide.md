---
title: "Jaeger Distributed Tracing on Kubernetes: Sampling, Storage, and Query Optimization"
date: 2027-07-08T00:00:00-05:00
draft: false
tags: ["Jaeger", "Distributed Tracing", "Kubernetes", "Observability"]
categories:
- Jaeger
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production deployment guide for Jaeger on Kubernetes covering Elasticsearch and Cassandra storage backends, probabilistic and adaptive sampling strategies, Jaeger Operator, OpenTelemetry Collector integration, trace context propagation, and query optimization."
more_link: "yes"
url: "/jaeger-distributed-tracing-kubernetes-guide/"
---

Distributed tracing is the observability capability that makes it possible to follow a request as it crosses service boundaries, identifying latency contributors and failure points that would be invisible in per-service metrics and logs. Jaeger, originally developed at Uber and now a CNCF graduated project, provides a complete distributed tracing system including collection, storage, querying, and visualization. Deploying Jaeger in production on Kubernetes requires decisions about storage backends, sampling strategy, ingestion pipeline architecture, and query performance optimization. This guide addresses all of these concerns with production-validated configurations.

<!--more-->

## Jaeger Architecture

### Component Overview

Jaeger's architecture separates concerns across distinct components:

| Component | Role | Stateful |
|-----------|------|---------|
| Agent | UDP endpoint per node; batches spans to Collector | No (DaemonSet) |
| Collector | Validates, transforms, and writes spans to storage | No (Deployment) |
| Query | Reads spans from storage; serves Jaeger UI and gRPC API | No (Deployment) |
| Ingester | Consumes spans from Kafka; writes to storage | No (Deployment) |
| Jaeger UI | Web interface for trace visualization | Served by Query |

In modern deployments, the Agent is typically replaced by an OpenTelemetry Collector DaemonSet, and spans are forwarded to the Collector via OTLP or Thrift-Compact protocol.

### Data Flow Options

**Option A: Application → Jaeger Agent → Jaeger Collector → Storage**

```
App (Jaeger SDK) ──UDP:6831──► Jaeger Agent ──Thrift:14268──► Jaeger Collector ──► Elasticsearch/Cassandra
```

**Option B: Application → OTel Collector → Jaeger Collector → Storage** (Recommended)

```
App (OTel SDK) ──OTLP──► OTel Agent ──OTLP──► OTel Gateway ──OTLP:4317──► Jaeger Collector ──► Elasticsearch
```

**Option C: Application → OTel Collector → Jaeger via Kafka** (High volume)

```
App ──OTLP──► OTel Collector ──► Kafka ──► Jaeger Ingester ──► Elasticsearch
```

---

## Jaeger Operator Installation

### Installing the Operator

```bash
kubectl create namespace observability
kubectl apply -f https://github.com/jaegertracing/jaeger-operator/releases/download/v1.57.0/jaeger-operator.yaml \
  -n observability
```

Grant the operator cluster-wide permissions for multi-namespace Jaeger management:

```bash
kubectl apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: jaeger-operator-cluster-role
rules:
  - apiGroups: [""]
    resources: [pods, services, endpoints, persistentvolumeclaims, events, configmaps, secrets, serviceaccounts]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [apps]
    resources: [deployments, daemonsets, replicasets, statefulsets]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [monitoring.coreos.com]
    resources: [servicemonitors]
    verbs: [get, create]
  - apiGroups: [extensions, networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: [jaegertracing.io]
    resources: ["*"]
    verbs: ["*"]
EOF
```

---

## Storage Backends

### Elasticsearch Storage

Elasticsearch is the most common production storage backend for Jaeger. It provides full-text search, flexible querying by tags, and horizontal scalability.

#### Jaeger with ECK-Managed Elasticsearch

```yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: production
  namespace: observability
spec:
  strategy: production

  collector:
    maxReplicas: 10
    resources:
      requests:
        memory: 512Mi
        cpu: 500m
      limits:
        memory: 1Gi
        cpu: "2"
    options:
      collector:
        queue-size: 100000
        num-workers: 50

  query:
    replicas: 2
    resources:
      requests:
        memory: 256Mi
        cpu: 200m
      limits:
        memory: 512Mi
        cpu: "1"
    options:
      query:
        max-clock-skew-adjustment: 0s
    metricsStorage:
      type: prometheus
      serverURL: http://thanos-querier.monitoring.svc:9090
      tls:
        enabled: false

  storage:
    type: elasticsearch
    options:
      es:
        server-urls: https://production-es-http.elastic.svc:9200
        username: elastic
        password: ""   # Provided via secret
        tls:
          ca: /es/certificates/ca.crt
        index-prefix: jaeger
        num-shards: 5
        num-replicas: 1
        create-index-templates: true
        use-ilm: true
        ilm-policy-name: jaeger-ilm-policy
        # Maximum span age to query
        max-span-age: 168h   # 7 days
    secretName: jaeger-es-credentials
    esRollover:
      schedule: "0 0 * * *"
      image: jaegertracing/jaeger-es-rollover:1.57.0

  ingress:
    enabled: true
    ingressClassName: nginx
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
    hosts:
      - jaeger.example.com
    tls:
      - hosts:
          - jaeger.example.com
        secretName: jaeger-ui-tls
```

#### Elasticsearch Credentials Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: jaeger-es-credentials
  namespace: observability
stringData:
  ES_PASSWORD: "REPLACE_WITH_ES_PASSWORD"
```

#### ILM Policy for Jaeger Indices

```json
PUT _ilm/policy/jaeger-ilm-policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": {
          "rollover": {
            "max_age": "1d",
            "max_primary_shard_size": "30gb"
          },
          "set_priority": {
            "priority": 100
          }
        }
      },
      "warm": {
        "min_age": "3d",
        "actions": {
          "migrate": {},
          "forcemerge": {
            "max_num_segments": 1
          },
          "shrink": {
            "number_of_shards": 1
          }
        }
      },
      "delete": {
        "min_age": "14d",
        "actions": {
          "delete": {}
        }
      }
    }
  }
}
```

### Cassandra Storage

Cassandra is appropriate when extremely high write throughput is required (millions of spans per second) or when Elasticsearch licensing is a concern.

```yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: production-cassandra
  namespace: observability
spec:
  strategy: production
  storage:
    type: cassandra
    options:
      cassandra:
        servers: cassandra.cassandra.svc
        keyspace: jaeger_v1_production
        local-dc: datacenter1
        consistency: LOCAL_QUORUM
        proto-version: 4
        max-retry-attempts: 3
        connection-per-host: 4
    cassandraCreateSchema:
      enabled: true
      datacenter: datacenter1
      mode: test   # Use "prod" for replication factor 3
      replicationFactor: 3
      trace-ttl: 172800    # 48 hours in seconds
      dependencies-ttl: 0
```

---

## Sampling Strategies

### Head-Based Sampling

Head-based sampling makes the sampling decision at the trace root span before the trace is complete. It is computationally cheap but cannot be conditioned on error status or latency.

#### Probabilistic Sampling

```yaml
spec:
  collector:
    options:
      collector:
        # Default sampling configuration
        sampling:
          strategies-file: /etc/jaeger/sampling-strategies.json
```

```json
{
  "default_strategy": {
    "type": "probabilistic",
    "param": 0.01
  },
  "per_service_strategies": [
    {
      "service": "payment-service",
      "type": "probabilistic",
      "param": 1.0
    },
    {
      "service": "health-check",
      "type": "probabilistic",
      "param": 0.0
    },
    {
      "service": "api-gateway",
      "type": "rate_limiting",
      "param": 100
    }
  ]
}
```

Serve this strategy file via a ConfigMap and mount it into the Collector pods:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: jaeger-sampling-strategies
  namespace: observability
data:
  strategies.json: |
    {
      "default_strategy": {
        "type": "probabilistic",
        "param": 0.01
      },
      "per_service_strategies": [
        {
          "service": "checkout-service",
          "type": "probabilistic",
          "param": 0.1
        }
      ]
    }
```

#### Rate-Limiting Sampling

Rate-limiting sampling caps the number of traces per second per service instance:

```json
{
  "default_strategy": {
    "type": "ratelimiting",
    "param": 10
  }
}
```

This guarantees that a single high-traffic service cannot overwhelm storage, but the absolute cap may cause trace gaps during traffic spikes.

### Adaptive Sampling

Adaptive sampling adjusts sampling rates dynamically based on observed traffic, targeting a configurable operations-per-second threshold per service:

```yaml
spec:
  collector:
    options:
      collector:
        sampling:
          # Remote sampling endpoint for SDKs to query
          http: 0.0.0.0:5778
  storage:
    type: elasticsearch
    # Adaptive sampling requires reading throughput data from storage
```

```json
{
  "default_strategy": {
    "type": "adaptive"
  },
  "per_service_strategies": [
    {
      "service": "payment-service",
      "type": "probabilistic",
      "param": 1.0
    }
  ],
  "target_samples_per_second": 1.0,
  "delta_tolerance": 0.3,
  "initial_sampling_probability": 0.001,
  "min_sampling_probability": 0.0001,
  "max_sampling_probability": 1.0,
  "min_root_spans_per_second": 0.1
}
```

### Tail-Based Sampling via OTel Collector

Tail-based sampling makes the keep/drop decision after all spans for a trace have arrived. This enables sampling based on trace outcomes (errors, latency) rather than random chance. The OTel Collector tail_sampling processor (documented in the OTel Collector guide) should sit upstream of the Jaeger Collector when tail sampling is required.

```
App ──OTLP──► OTel Agent ──OTLP──► OTel Gateway (tail_sampling) ──OTLP──► Jaeger Collector
```

---

## Ingestion from OpenTelemetry Collector

### Jaeger Collector OTLP Endpoint

Jaeger Collector natively accepts OTLP gRPC on port 4317 from Jaeger v1.35+:

```yaml
spec:
  collector:
    options:
      collector:
        # OTLP gRPC receiver
        otlp:
          enabled: true
          grpc:
            host-port: "0.0.0.0:4317"
          http:
            host-port: "0.0.0.0:4318"
```

Configure the OTel Collector gateway to export to Jaeger via OTLP:

```yaml
# OTel Collector config excerpt
exporters:
  otlp/jaeger:
    endpoint: jaeger-collector.observability.svc:4317
    tls:
      insecure: true
    compression: gzip
    headers:
      # If Jaeger is configured with multi-tenancy
      X-Tenant: default
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 10
      queue_size: 10000
```

### Thrift HTTP Receiver (Legacy SDK Compatibility)

For services still using the Jaeger Thrift SDK (pre-OTel migration):

```yaml
# OTel Collector config
receivers:
  jaeger:
    protocols:
      grpc:
        endpoint: 0.0.0.0:14250
      thrift_binary:
        endpoint: 0.0.0.0:6832
      thrift_compact:
        endpoint: 0.0.0.0:6831
      thrift_http:
        endpoint: 0.0.0.0:14268
```

---

## Trace Context Propagation

### W3C TraceContext (Recommended)

W3C TraceContext (`traceparent` and `tracestate` HTTP headers) is the IETF standard and the default for OTel SDKs:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^ ^^
             version  trace-id (128-bit)          parent-id (64-bit) flags
```

Configure OTel SDK to use W3C propagation:

```yaml
# Instrumentation resource
spec:
  propagators:
    - tracecontext   # W3C TraceContext
    - baggage        # W3C Baggage (carry context across services)
```

### B3 Propagation (Zipkin Compatibility)

For systems that were previously instrumented with Zipkin or Brave:

```yaml
spec:
  propagators:
    - b3multi    # Multi-header B3 (X-B3-TraceId, X-B3-SpanId, X-B3-Sampled)
    - b3         # Single-header B3 (b3: {traceId}-{spanId}-{sampling}-{parentSpanId})
```

### Mixed Propagation (Migration Period)

During a migration from B3 to W3C, configure both propagators. OTel will prefer extracting from `traceparent` but fall back to B3 headers if `traceparent` is absent:

```yaml
spec:
  propagators:
    - tracecontext
    - b3multi
    - b3
    - baggage
```

---

## Jaeger UI Query Patterns

### Finding Traces Efficiently

The Jaeger UI search page provides several filter dimensions:

```
Service: payment-service
Operation: POST /v1/orders
Tags: http.status_code=500 error=true
Lookback: Last 1 hour
Min Duration: 500ms
Max Duration: (unlimited)
Limit Results: 20
```

### Deep Dive: Span Tag Filtering

The Elasticsearch backend supports tag-based searching. Tags with high cardinality (e.g., `user.id`, `request.id`) may not be indexed by default. Jaeger supports configuring which tag keys are indexed:

```bash
# Configure indexed tags via ES index templates
curl -s -u elastic:${ES_PASSWORD} \
  -X GET https://production-es-http.elastic.svc:9200/_template/jaeger-span | jq .

# Jaeger ES rollover script respects the --es.tags-as-fields.all flag
# Set in Collector config:
# collector options: es.tags-as-fields.all=true
# WARNING: setting all=true dramatically increases index size and write cost
```

### Programmatic Trace Queries via gRPC API

```python
import grpc
from jaeger_api_v3 import query_service_pb2_grpc, query_service_pb2

channel = grpc.insecure_channel("jaeger-query.observability.svc:16685")
stub = query_service_pb2_grpc.QueryServiceStub(channel)

# Find traces
request = query_service_pb2.FindTracesRequest(
    query=query_service_pb2.TraceQueryParameters(
        service_name="payment-service",
        operation_name="POST /v1/orders",
        tags={"error": "true"},
        start_time_min=start_time,
        start_time_max=end_time,
        duration_min=500_000_000,    # 500ms in nanoseconds
        search_depth=20
    )
)

for chunk in stub.FindTraces(request):
    for span in chunk.spans:
        print(f"TraceID: {span.trace_id.hex()}, Duration: {span.duration}ns")
```

### Service Dependency Graph

The Jaeger dependency processor aggregates span parent-child relationships into a service dependency graph, visible in the Jaeger UI under the "Dependencies" tab:

```yaml
spec:
  # Spark dependencies job runs periodically to compute the graph
  dependencies:
    enabled: true
    schedule: "55 23 * * *"   # Runs at 11:55 PM daily
    sparkMaster: ""           # Empty = local Spark mode
    javaOpts: "-Xmx1g"
    resources:
      requests:
        memory: 2Gi
        cpu: 500m
      limits:
        memory: 4Gi
        cpu: "2"
```

---

## Performance Tuning

### Collector Tuning

The Jaeger Collector is the main write bottleneck. Key tuning parameters:

```yaml
spec:
  collector:
    options:
      collector:
        # Number of goroutines processing spans
        num-workers: 100
        # Internal queue size — increase for burst absorption
        queue-size: 100000
        # Drop spans when queue is full (vs. backpressure)
        queue-size-memory: 0    # 0 = unlimited memory queue
```

Monitor queue depth to determine if workers or queue size need adjustment:

```bash
curl -s http://jaeger-collector.observability.svc:14269/metrics | \
  grep jaeger_collector_queue_length
```

When queue length is consistently high, increase `num-workers`. When burst spikes cause drops, increase `queue-size`.

### Elasticsearch Write Optimization

```yaml
spec:
  storage:
    options:
      es:
        # Batch spans into bulk requests
        bulk:
          size: 5000000        # 5 MB bulk request
          workers: 3           # Concurrent bulk goroutines
          flush-interval: 200ms
          max-bytes-per-doc: 2000000
        # Index rollover
        num-shards: 5          # Shards per index (hot nodes)
        num-replicas: 1        # Replicas (reduce for writes, increase for reads)
```

### Query Performance

```yaml
spec:
  query:
    options:
      query:
        # Maximum number of spans to return from storage
        max-clock-skew-adjustment: 0s
    metricsStorage:
      type: prometheus
      serverURL: http://thanos-querier.monitoring.svc:9090
```

For Elasticsearch queries spanning multiple days, ensure the index lifecycle and ILM rollover policy keeps individual indices small (< 30 GB primary). Jaeger queries are single-index operations, so large indices increase query latency.

---

## Multi-Tenancy

Jaeger supports multi-tenancy through the `--multi-tenancy.enabled=true` flag and a tenant HTTP header:

```yaml
spec:
  collector:
    options:
      multi-tenancy:
        enabled: true
        header: X-Tenant
        tenants:
          - team-alpha
          - team-beta
          - platform
  query:
    options:
      multi-tenancy:
        enabled: true
        header: X-Tenant
```

Each tenant receives isolated Elasticsearch indices (`jaeger-team-alpha-span-*`). Applications set the `X-Tenant` header on OTLP export requests.

---

## Security Hardening

### mTLS for Collector

```yaml
spec:
  collector:
    options:
      collector:
        # TLS for OTLP gRPC
        otlp:
          grpc:
            tls:
              enabled: true
              cert: /etc/certs/tls.crt
              key: /etc/certs/tls.key
              client-ca: /etc/certs/ca.crt
```

### Jaeger UI Authentication via OAuth2 Proxy

Jaeger UI has no built-in authentication. Deploy OAuth2 Proxy in front of the Query service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger-oauth2-proxy
  namespace: observability
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger-oauth2-proxy
  template:
    metadata:
      labels:
        app: jaeger-oauth2-proxy
    spec:
      containers:
        - name: oauth2-proxy
          image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
          args:
            - --provider=oidc
            - --email-domain=example.com
            - --upstream=http://production-query.observability.svc:16686
            - --http-address=0.0.0.0:4180
            - --oidc-issuer-url=https://auth.example.com/realms/main
            - --redirect-url=https://jaeger.example.com/oauth2/callback
            - --cookie-secure=true
            - --cookie-domain=example.com
          env:
            - name: OAUTH2_PROXY_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: jaeger-oauth2-proxy-secrets
                  key: client-id
            - name: OAUTH2_PROXY_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: jaeger-oauth2-proxy-secrets
                  key: client-secret
            - name: OAUTH2_PROXY_COOKIE_SECRET
              valueFrom:
                secretKeyRef:
                  name: jaeger-oauth2-proxy-secrets
                  key: cookie-secret
          ports:
            - containerPort: 4180
              name: http
```

---

## Monitoring Jaeger

### Key Metrics

```yaml
groups:
  - name: jaeger
    rules:
      - alert: JaegerCollectorQueueFull
        expr: jaeger_collector_queue_length > 90000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Jaeger collector queue near capacity"

      - alert: JaegerCollectorDroppedSpans
        expr: rate(jaeger_collector_spans_dropped_total[5m]) > 100
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Jaeger collector dropping spans"

      - alert: JaegerStorageWriteFailures
        expr: rate(jaeger_collector_save_latency_bucket{result="err"}[5m]) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Jaeger collector storage write failures"

      - alert: JaegerQueryHighLatency
        expr: |
          histogram_quantile(0.99,
            rate(jaeger_query_requests_total[5m])
          ) > 5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Jaeger query p99 latency above 5 seconds"
```

---

## Operational Runbook

### Index Rollover (Daily)

Jaeger uses time-based index rollover via the `jaeger-es-rollover` init container job. Monitor rollover health:

```bash
# Check existing Jaeger indices
curl -s -u elastic:${ES_PASSWORD} \
  https://production-es-http.elastic.svc:9200/_cat/indices/jaeger-*?v&h=index,docs.count,store.size,health | \
  sort -k4 -rh | head -20

# Manually trigger rollover
kubectl -n observability create job jaeger-rollover-manual \
  --from=cronjob/production-es-rollover
```

### Trace Lookup by ID

```bash
# Query Jaeger gRPC API directly
grpcurl -plaintext \
  -d '{"trace_id": "TRACE_ID_HEX"}' \
  jaeger-query.observability.svc:16685 \
  jaeger.api_v3.QueryService/GetTrace

# Via HTTP API
curl -s "http://jaeger-query.observability.svc:16686/api/traces/TRACE_ID_HEX" | \
  jq '.data[0].spans | length'
```

### Recover from Storage Connection Failure

When Elasticsearch is unavailable, the Collector drops spans to protect queue memory. After recovery:

```bash
# Restart collectors to clear error state
kubectl -n observability rollout restart deployment/production-collector

# Verify writes resuming
kubectl -n observability logs -l app.kubernetes.io/component=collector \
  --tail=50 | grep "Sending batch"
```

---

## Summary

Jaeger provides a production-ready distributed tracing solution that integrates naturally with the OpenTelemetry ecosystem through its OTLP receiver. The Jaeger Operator simplifies Kubernetes lifecycle management, while the choice between probabilistic, rate-limiting, and adaptive sampling strategies allows teams to balance observability coverage against storage and processing cost. When deployed with Elasticsearch storage, Jaeger benefits from the same ILM and tiering capabilities that optimize log storage, making it a natural companion to an Elasticsearch-based observability stack. Combined with OpenTelemetry Collector for upstream tail sampling and attribute enrichment, Jaeger delivers the complete trace context needed to diagnose latency and failure in complex microservice architectures.
