---
title: "OpenTelemetry on Kubernetes: Collector Deployment, Auto-Instrumentation, and Trace Analysis"
date: 2027-06-07T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Observability", "Tracing", "Kubernetes", "OTLP", "Jaeger", "Tempo"]
categories: ["Observability", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to deploying OpenTelemetry on Kubernetes covering the OTel Operator, Collector DaemonSet and Gateway modes, auto-instrumentation for Java/Python/Node.js/.NET, sampling strategies, and Jaeger vs Grafana Tempo backend selection."
more_link: "yes"
url: "/opentelemetry-kubernetes-observability-guide/"
---

OpenTelemetry has become the standard for vendor-neutral observability instrumentation. As the merger of OpenCensus and OpenTracing, it provides a unified API and SDK for traces, metrics, and logs across all major languages and platforms. For Kubernetes-based microservices architectures, OpenTelemetry offers a complete solution: auto-instrumentation that requires no code changes, a collector pipeline that processes and routes telemetry data, and exporters for every major backend.

This guide covers the full production deployment of OpenTelemetry on Kubernetes, from the OTel Operator installation through multi-pipeline collector configuration, sampling strategy design, and backend selection for trace storage and analysis.

<!--more-->

## OpenTelemetry Architecture

Before deploying, understanding the three-layer architecture prevents common configuration mistakes.

### Three Layers of OpenTelemetry

**1. SDK/Instrumentation Layer**

The SDK runs inside the application process and generates telemetry data. It captures:
- Trace spans (start/end time, operation name, attributes, status)
- Metrics (counters, histograms, gauges)
- Logs (structured log records with trace context)

The SDK sends data to a local collector via OTLP (OpenTelemetry Protocol).

**2. Collector Layer**

The Collector is a standalone process that receives, processes, and exports telemetry. It is language-agnostic and sits between applications and backends. The Collector pipeline consists of:
- **Receivers** - accept data (OTLP, Jaeger, Zipkin, Prometheus, etc.)
- **Processors** - transform, filter, batch, and sample data
- **Exporters** - send data to backends (Jaeger, Tempo, Prometheus, OTLP, etc.)

**3. Backend Layer**

The backend stores and queries telemetry:
- Traces: Jaeger, Grafana Tempo, Zipkin, AWS X-Ray
- Metrics: Prometheus, Victoria Metrics, Thanos
- Logs: Loki, Elasticsearch, Splunk

### Data Flow

```
Application (SDK)
    │
    │ OTLP gRPC (localhost:4317)
    ▼
OTel Collector (DaemonSet)
    │
    │ OTLP gRPC (after processing/sampling)
    ▼
OTel Collector (Gateway Deployment)
    │
    ├──► Grafana Tempo (traces)
    ├──► Prometheus (metrics)
    └──► Loki (logs)
```

## Installing the OpenTelemetry Operator

The OTel Operator manages Collector deployments and auto-instrumentation CRDs.

### Prerequisites

```bash
# Install cert-manager (required by OTel Operator for webhook TLS)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.0/cert-manager.yaml

# Wait for cert-manager to be ready
kubectl rollout status deployment cert-manager -n cert-manager
kubectl rollout status deployment cert-manager-webhook -n cert-manager
```

### Operator Installation via Helm

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace monitoring \
  --create-namespace \
  --set "manager.collectorImage.repository=otel/opentelemetry-collector-contrib" \
  --set "manager.collectorImage.tag=0.102.0" \
  --set admissionWebhooks.certManager.enabled=true \
  --version 0.59.0
```

### Verify Operator Installation

```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=opentelemetry-operator
kubectl get crd | grep opentelemetry
# Expected:
# instrumentations.opentelemetry.io
# opampbridges.opentelemetry.io
# opentelemetrycollectors.opentelemetry.io
```

## Collector Deployment Modes

The OTel Operator supports four deployment modes. Production deployments typically combine DaemonSet (agent) and Deployment (gateway) modes.

### Agent Mode: DaemonSet

Agent collectors run on every node. They collect telemetry from pods on their node and forward to the gateway. DaemonSet placement means:
- Low network latency (same node communication)
- No single point of failure
- Resource usage scales with node count, not pod count

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel-agent
  namespace: monitoring
spec:
  mode: DaemonSet
  image: otel/opentelemetry-collector-contrib:0.102.0
  serviceAccount: otel-collector
  resources:
    requests:
      cpu: 200m
      memory: 400Mi
    limits:
      cpu: 500m
      memory: 800Mi
  tolerations:
    - operator: Exists
      effect: NoSchedule
  config:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

      # Collect host metrics from the node
      hostmetrics:
        root_path: /hostfs
        collection_interval: 30s
        scrapers:
          cpu:
          disk:
          filesystem:
          load:
          memory:
          network:
          paging:
          processes:

      # Collect Kubernetes events
      k8s_events:
        auth_type: serviceAccount
        namespaces: []  # Empty = all namespaces

    processors:
      # Batch traces and metrics for efficiency
      batch:
        timeout: 5s
        send_batch_size: 1000
        send_batch_max_size: 2000

      # Enrich spans with Kubernetes metadata
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        extract:
          metadata:
            - k8s.namespace.name
            - k8s.deployment.name
            - k8s.statefulset.name
            - k8s.daemonset.name
            - k8s.cronjob.name
            - k8s.job.name
            - k8s.node.name
            - k8s.pod.name
            - k8s.pod.uid
          labels:
            - tag_name: app.version
              key: app.kubernetes.io/version
              from: pod
          annotations:
            - tag_name: team
              key: team
              from: pod
        pod_association:
          - sources:
              - from: resource_attribute
                name: k8s.pod.ip

      # Add resource attributes
      resourcedetection:
        detectors: [env, k8s_node, system]
        timeout: 5s
        k8s_node:
          auth_type: serviceAccount
          resource_attributes:
            k8s.node.name:
              enabled: true

      # Memory limiter prevents OOM kills
      memory_limiter:
        check_interval: 1s
        limit_mib: 700
        spike_limit_mib: 200

    exporters:
      # Forward to gateway collector
      otlp/gateway:
        endpoint: otel-gateway-collector.monitoring.svc.cluster.local:4317
        tls:
          insecure: false
          ca_file: /etc/otel/tls/ca.crt

      # Local Prometheus metrics endpoint (for node metrics)
      prometheus:
        endpoint: 0.0.0.0:8888
        namespace: otel
        resource_to_telemetry_conversion:
          enabled: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [otlp/gateway]

        metrics:
          receivers: [otlp, hostmetrics]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [otlp/gateway, prometheus]

        logs:
          receivers: [otlp, k8s_events]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [otlp/gateway]

      telemetry:
        logs:
          level: info
        metrics:
          level: detailed
          address: 0.0.0.0:8889
```

### Gateway Mode: Deployment

The gateway is the central processing point. It receives from all agents, performs tail-based sampling, and routes to backends.

```yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  mode: Deployment
  replicas: 3
  image: otel/opentelemetry-collector-contrib:0.102.0
  serviceAccount: otel-collector
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 4Gi
  autoscaler:
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilization: 70
  config:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 20
          http:
            endpoint: 0.0.0.0:4318

    processors:
      batch:
        timeout: 10s
        send_batch_size: 5000
        send_batch_max_size: 10000

      memory_limiter:
        check_interval: 1s
        limit_mib: 3500
        spike_limit_mib: 700

      # Tail-based sampling (make sampling decisions based on complete traces)
      tail_sampling:
        decision_wait: 30s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          # Always sample errors
          - name: errors-policy
            type: status_code
            status_code:
              status_codes: [ERROR]

          # Always sample slow traces (P99 > 500ms)
          - name: slow-traces-policy
            type: latency
            latency:
              threshold_ms: 500

          # Sample a fraction of normal traces
          - name: probabilistic-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 5

          # Always sample traces matching specific attributes
          - name: important-service-policy
            type: string_attribute
            string_attribute:
              key: service.name
              values: [payment-service, auth-service]
              enabled_regex_matching: false

    exporters:
      # Grafana Tempo backend
      otlp/tempo:
        endpoint: tempo.monitoring.svc.cluster.local:4317
        tls:
          insecure: true

      # Prometheus for metrics
      prometheusremotewrite:
        endpoint: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
        tls:
          insecure: true
        resource_to_telemetry_conversion:
          enabled: true
        target_info:
          enabled: true

      # Loki for logs
      loki:
        endpoint: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push
        default_labels_enabled:
          exporter: true
          job: true
          instance: true
          level: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, tail_sampling, batch]
          exporters: [otlp/tempo]

        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [prometheusremotewrite]

        logs:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [loki]
```

### RBAC for Collector

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-collector
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-collector
rules:
  # k8sattributes processor needs to read pod/node/namespace info
  - apiGroups: [""]
    resources: ["pods", "nodes", "namespaces", "endpoints", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "deployments", "daemonsets", "statefulsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
  # Node metrics access
  - apiGroups: [""]
    resources: ["nodes/metrics"]
    verbs: ["get"]
  - nonResourceURLs: ["/metrics"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-collector
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: otel-collector
subjects:
  - kind: ServiceAccount
    name: otel-collector
    namespace: monitoring
```

## Auto-Instrumentation

The OTel Operator's auto-instrumentation feature injects instrumentation libraries into pods without code changes, using an init container and volume mounts.

### Instrumentation CRD

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: default-instrumentation
  namespace: monitoring
spec:
  exporter:
    endpoint: http://otel-agent-collector.monitoring.svc.cluster.local:4318

  propagators:
    - tracecontext
    - baggage
    - b3

  sampler:
    type: parentbased_traceidratio
    argument: "0.1"  # 10% head-based sampling at SDK level

  # Java auto-instrumentation
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.3.0
    env:
      - name: OTEL_INSTRUMENTATION_KAFKA_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_SPRING_WEB_ENABLED
        value: "true"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"

  # Node.js auto-instrumentation
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.51.0
    env:
      - name: OTEL_NODE_ENABLED_INSTRUMENTATIONS
        value: "express,http,grpc,mongodb,pg,redis,kafka"

  # Python auto-instrumentation
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.46b0
    env:
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: "true"
      - name: OTEL_PYTHON_FASTAPI_EXCLUDED_URLS
        value: "health,metrics,ready"

  # .NET auto-instrumentation
  dotnet:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-dotnet:1.7.0
    env:
      - name: OTEL_DOTNET_AUTO_TRACES_ADDITIONAL_SOURCES
        value: "MyCompany.*"
```

### Enabling Auto-Instrumentation with Annotations

Add annotations to workloads to trigger injection:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Inject instrumentation for this language
        instrumentation.opentelemetry.io/inject-java: "monitoring/default-instrumentation"
        # Set the service name
        instrumentation.opentelemetry.io/container-names: "payment-service"
      labels:
        app: payment-service
        team: payments
    spec:
      containers:
        - name: payment-service
          image: company/payment-service:1.2.3
          env:
            # Override service name for this specific deployment
            - name: OTEL_SERVICE_NAME
              value: "payment-service"
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "deployment.environment=production,service.version=1.2.3"
```

### Namespace-Level Auto-Instrumentation

Apply instrumentation to all pods in a namespace:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: namespace-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-agent-collector.monitoring.svc.cluster.local:4318
  # ... configuration
---
# In the namespace itself, add annotation to enable default instrumentation
apiVersion: v1
kind: Namespace
metadata:
  name: production
  annotations:
    instrumentation.opentelemetry.io/inject-java: "true"
```

### Verifying Auto-Instrumentation

```bash
# Check that the init container was injected
kubectl describe pod payment-service-xxx -n production | grep -A5 "Init Containers:"

# Verify the OTEL environment variables were injected
kubectl exec payment-service-xxx -n production -- env | grep OTEL

# Check agent collector is receiving spans
kubectl logs -n monitoring -l app.kubernetes.io/name=otel-agent -c collector | grep "spans"
```

## OTLP Pipeline Configuration

The OTLP receiver/processor/exporter pipeline is the backbone of OTel data routing.

### Receiver Configuration

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
        # TLS configuration for secure communication
        tls:
          cert_file: /etc/otel/tls/tls.crt
          key_file: /etc/otel/tls/tls.key
          client_ca_file: /etc/otel/tls/ca.crt
        # Keep-alive settings
        keepalive:
          server_parameters:
            max_connection_idle: 11s
            max_connection_age: 12s
            time: 30s
            timeout: 20s
        # Limits
        max_recv_msg_size_mib: 20
        max_concurrent_streams: 1000
        read_buffer_size: 524288
        write_buffer_size: 524288

      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins: ["https://*.company.com"]
          allowed_headers: ["*"]
          max_age: 7200
```

### Processor Configuration

```yaml
processors:
  # Attribute transformation
  attributes:
    actions:
      # Rename attribute
      - key: http.url
        from_attribute: http.target
        action: insert
      # Delete sensitive attributes
      - key: db.statement
        action: delete
      # Hash PII
      - key: user.email
        action: hash
      # Add static attribute
      - key: deployment.cluster
        value: production-east
        action: insert

  # Filter out health check spans (reduce noise)
  filter:
    traces:
      span:
        - 'attributes["http.route"] == "/health"'
        - 'attributes["http.route"] == "/ready"'
        - 'attributes["http.route"] == "/metrics"'

  # Transform processor for advanced manipulation
  transform:
    trace_statements:
      - context: span
        statements:
          # Normalize service names
          - set(attributes["service.name"], Concat([resource.attributes["k8s.namespace.name"], resource.attributes["k8s.deployment.name"]], "/"))
          # Add duration in milliseconds
          - set(attributes["duration_ms"], (end_time_unix_nano - start_time_unix_nano) / 1000000)

  # Span metrics - generate RED metrics from traces
  spanmetrics:
    metrics_exporter: prometheusremotewrite
    latency_histogram_buckets: [2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms, 400ms, 800ms, 1s, 1400ms, 2s, 5s, 10s, 15s]
    dimensions:
      - name: http.method
        default: GET
      - name: http.status_code
    exemplars:
      enabled: true
```

### Exporter Configuration

```yaml
exporters:
  # OTLP to Tempo
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 10
      queue_size: 5000
    timeout: 30s

  # Debug exporter (for troubleshooting)
  debug:
    verbosity: detailed
    sampling_initial: 5
    sampling_thereafter: 200

  # OTLP/HTTP to Jaeger
  otlphttp/jaeger:
    endpoint: http://jaeger-collector:4318
    tls:
      insecure: true
```

## Trace Sampling Strategies

Sampling is the most critical configuration decision for production OTel deployments. The right sampling strategy balances observability coverage with storage costs.

### Head-Based Sampling

Head-based sampling makes the decision at the beginning of a trace (before spans are collected). It is efficient but cannot consider trace characteristics (errors, latency) when making the decision.

```yaml
# In the Instrumentation CRD
sampler:
  # Always sample
  type: always_on

  # Never sample (useful for disabling temporarily)
  type: always_off

  # Sample X% of traces
  type: traceidratio
  argument: "0.1"  # 10%

  # Respect parent's sampling decision; sample X% if no parent
  type: parentbased_traceidratio
  argument: "0.1"
```

`parentbased_traceidratio` is the recommended default. It ensures that if a parent span is sampled, all child spans are also sampled (maintaining complete traces), while sampling only 10% of root spans.

### Tail-Based Sampling

Tail-based sampling waits for all spans of a trace to arrive before making the sampling decision. This enables sampling based on trace characteristics:

```yaml
processors:
  tail_sampling:
    decision_wait: 30s
    num_traces: 500000  # Buffer size
    expected_new_traces_per_sec: 5000
    policies:
      # Always keep errors - most important policy
      - name: always-sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Always keep slow traces
      - name: always-sample-slow
        type: latency
        latency:
          threshold_ms: 1000

      # Keep traces with specific baggage
      - name: debug-sampling
        type: string_attribute
        string_attribute:
          key: debug.sampling
          values: ["true"]

      # Keep traces touching critical services
      - name: payment-service
        type: string_attribute
        string_attribute:
          key: service.name
          values: ["payment-service", "fraud-detection"]

      # Rate-limit normal traces to 100 per second
      - name: rate-limit-normal
        type: rate_limiting
        rate_limiting:
          spans_per_second: 1000

      # Sample 1% of everything else
      - name: default-1pct
        type: probabilistic
        probabilistic:
          sampling_percentage: 1

      # Composite policy: combine multiple policies with AND/OR logic
      - name: composite-policy
        type: composite
        composite:
          max_total_spans_per_second: 10000
          policy_order: [always-sample-errors, always-sample-slow, default-1pct]
          rate_allocation:
            - policy: always-sample-errors
              percent: 40
            - policy: always-sample-slow
              percent: 30
            - policy: default-1pct
              percent: 30
```

### Load-Balanced Tail Sampling in Multi-Replica Gateway

Tail sampling requires all spans from a trace to arrive at the same Collector instance (since the complete trace must be evaluated). When running multiple gateway replicas, use the load balancing exporter:

```yaml
# Agent sends to load balancer exporter
exporters:
  loadbalancing:
    protocol:
      otlp:
        tls:
          insecure: true
    resolver:
      dns:
        hostname: otel-gateway-collector-headless.monitoring.svc.cluster.local
        port: 4317
    # Route by trace ID (all spans from a trace go to the same gateway)
    routing_key: traceID
```

```yaml
# Gateway uses tail_sampling after receiving complete traces
processors:
  tail_sampling:
    decision_wait: 30s
    # ... policies
```

## W3C TraceContext Propagation

TraceContext is the W3C standard for propagating trace context across service boundaries via HTTP headers. The two key headers are:

- `traceparent`: Contains version, trace ID, parent span ID, and trace flags
- `tracestate`: Vendor-specific additional state

Format: `traceparent: 00-{trace-id}-{span-id}-{flags}`

```
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
```

### Configuring Propagators

```yaml
# In Instrumentation CRD
propagators:
  - tracecontext  # W3C TraceContext
  - baggage       # W3C Baggage for application-level context propagation
  - b3            # Legacy Zipkin B3 (for compatibility with older services)
  - jaeger        # Jaeger native format (for services not yet migrated)
```

### Baggage for Correlation IDs

W3C Baggage allows propagating arbitrary key-value pairs across service boundaries. Use this for business-level correlation:

```go
// Producer service - set baggage
ctx = baggage.ContextWithBaggage(ctx, baggage.FromMap(map[string]baggage.Member{
    "customer_id": {Value: customerID},
    "request_id":  {Value: requestID},
    "feature_flags": {Value: "experiment_v2"},
}))

// Consumer service - read baggage
bag := baggage.FromContext(ctx)
customerID := bag.Member("customer_id").Value()
```

Configure the OTel Collector to extract baggage as span attributes:

```yaml
processors:
  baggage:
    # Extract all baggage members as span attributes
    action: INSERT
    keys: [customer_id, request_id, feature_flags]
```

## Prometheus Metrics via OpenTelemetry

OpenTelemetry can generate Prometheus-compatible metrics from traces using the `spanmetrics` processor, and can also scrape Prometheus endpoints.

### Span Metrics (RED Metrics from Traces)

```yaml
processors:
  spanmetrics:
    metrics_exporter: prometheusremotewrite
    latency_histogram_buckets: [1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s, 5s]
    dimensions_cache_size: 10000
    aggregation_temporality: AGGREGATION_TEMPORALITY_CUMULATIVE
    dimensions:
      - name: service.name
        default: unknown
      - name: span.name
      - name: span.kind
      - name: status.code
      - name: http.method
      - name: http.status_code
    exemplars:
      enabled: true
      max_per_data_point: 5
```

This generates the following Prometheus metrics:

```
calls_total{service_name="...", span_name="...", status_code="..."}
latency_bucket{service_name="...", le="..."}
latency_count{service_name="..."}
latency_sum{service_name="..."}
```

These metrics enable RED (Rate, Errors, Duration) dashboards without any additional instrumentation.

### Prometheus Receiver

The OTel Collector can scrape Prometheus endpoints and forward metrics via OTLP:

```yaml
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: kube-state-metrics
          static_configs:
            - targets: [kube-state-metrics.monitoring:8080]
          scrape_interval: 30s
        - job_name: node-exporter
          kubernetes_sd_configs:
            - role: pod
          relabel_configs:
            - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
              action: keep
              regex: node-exporter
```

## Jaeger vs Grafana Tempo

The two leading open-source trace backends have different strengths.

### Jaeger

**Architecture:** Collector → Kafka → Ingester → Cassandra/Elasticsearch/BadgerDB

**Strengths:**
- Mature and battle-tested
- Rich query UI with service graph and dependency analysis
- Good Elasticsearch integration for long-term retention
- Supports adaptive sampling strategies
- Strong community and ecosystem

**Deployment:**

```yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger
  namespace: monitoring
spec:
  strategy: production
  collector:
    replicas: 3
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
  storage:
    type: elasticsearch
    elasticsearch:
      nodeCount: 3
      resources:
        requests:
          cpu: 1
          memory: 4Gi
  query:
    replicas: 2
    metricsPort: 16687
```

### Grafana Tempo

**Architecture:** Distributor → Ingester → Compactor → S3/GCS/Azure Blob

**Strengths:**
- Object storage backend (extremely cost-effective at scale)
- No index means no cardinality limits on trace attributes
- Native Grafana integration with Loki log correlation
- TraceQL query language for powerful trace analysis
- Simpler operations (no Kafka, no Elasticsearch)

**Deployment (Helm):**

```bash
helm repo add grafana https://grafana.github.io/helm-charts
helm install tempo grafana/tempo-distributed \
  --namespace monitoring \
  --values tempo-values.yaml
```

```yaml
# tempo-values.yaml
storage:
  trace:
    backend: s3
    s3:
      bucket: company-tempo-traces
      endpoint: s3.amazonaws.com
      region: us-east-1
      access_key: ${AWS_ACCESS_KEY_ID}
      secret_key: ${AWS_SECRET_ACCESS_KEY}

compactor:
  config:
    compaction:
      block_retention: 720h  # 30 days
      compacted_block_retention: 1h

distributor:
  replicas: 3
  resources:
    requests:
      cpu: 500m
      memory: 512Mi

ingester:
  replicas: 3
  persistence:
    enabled: true
    size: 50Gi
  config:
    lifecycler:
      ring:
        replication_factor: 2

querier:
  replicas: 2
  resources:
    requests:
      cpu: 500m
      memory: 1Gi

query_frontend:
  replicas: 2

# Enable TraceQL search
search:
  enabled: true
  external_hedge_requests_at: 8s
  external_hedge_requests_up_to: 2
```

### Comparison Summary

| Feature | Jaeger | Grafana Tempo |
|---------|--------|---------------|
| Storage Backend | Elasticsearch, Cassandra, BadgerDB | S3, GCS, Azure, local |
| Cost at Scale | High (ES cluster) | Low (object storage) |
| Index | Yes (enables fast metadata search) | No index (TraceQL scans) |
| Cardinality Limits | ES mapping limits | None |
| Grafana Integration | Plugin (good) | Native (excellent) |
| TraceQL | No | Yes |
| Service Graph | Yes (native UI) | Yes (via Grafana) |
| Log Correlation | Requires configuration | Native Loki integration |

For greenfield deployments with Grafana already in the stack, Grafana Tempo is the recommended choice due to object storage cost efficiency and native Grafana correlation.

## Collector Resource Limits and Scaling

Sizing the OTel Collector correctly is critical. Under-provisioned collectors drop spans; over-provisioned collectors waste resources.

### Resource Sizing Guidelines

```
Agent (DaemonSet) per node:
  - 100 spans/sec per pod: 100m CPU, 200Mi memory
  - 1000 spans/sec per pod: 500m CPU, 600Mi memory
  - 5000 spans/sec per pod: 2000m CPU, 2Gi memory

Gateway (Deployment) per replica:
  - Start with 2 replicas + HPA
  - Base: 500m CPU, 1Gi memory
  - Scale at 70% CPU
  - tail_sampling increases memory by 10x (buffer size * avg trace size)
```

### Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otel-gateway-hpa
  namespace: monitoring
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: otel-gateway-collector
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### Monitoring the Collector

```yaml
# Key OTel Collector metrics
# otelcol_receiver_accepted_spans - spans successfully received
# otelcol_receiver_refused_spans - spans rejected (queue full, error)
# otelcol_exporter_sent_spans - spans successfully exported
# otelcol_exporter_send_failed_spans - export failures
# otelcol_processor_tail_sampling_sampling_decision_timer_latency - sampling decision time
# otelcol_process_memory_rss - process memory

# Alert on span drops
- alert: OTelCollectorSpanDrops
  expr: |
    rate(otelcol_receiver_refused_spans_total[5m]) > 0
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "OTel Collector is dropping spans"

# Alert on export failures
- alert: OTelCollectorExportFailures
  expr: |
    rate(otelcol_exporter_send_failed_spans_total[5m])
    / rate(otelcol_exporter_sent_spans_total[5m]) > 0.01
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "OTel Collector export failure rate exceeds 1%"
```

## Verifying the Full Observability Pipeline

```bash
# Generate a test trace manually
cat <<EOF | curl -sf -XPOST \
  -H "Content-Type: application/json" \
  http://otel-agent-collector.monitoring:4318/v1/traces -d @-
{
  "resourceSpans": [{
    "resource": {
      "attributes": [{
        "key": "service.name",
        "value": {"stringValue": "test-service"}
      }]
    },
    "scopeSpans": [{
      "spans": [{
        "traceId": "5b8aa5a2d2c872e8321cf37308d69df2",
        "spanId": "051581bf3cb55c13",
        "name": "test-span",
        "startTimeUnixNano": "$(date +%s%N)",
        "endTimeUnixNano": "$(date +%s%N)",
        "kind": 2,
        "status": {"code": 1}
      }]
    }]
  }]
}
EOF

# Check Tempo received the trace
curl -sf "http://tempo:3100/api/traces/5b8aa5a2d2c872e8321cf37308d69df2" | jq .

# Verify metrics pipeline
curl -sf "http://prometheus:9090/api/v1/query?query=calls_total" | jq '.data.result[:3]'
```

## Summary

A production OpenTelemetry deployment on Kubernetes combines several components into a coherent observability pipeline:

- The OTel Operator manages Collector lifecycle and enables auto-instrumentation via annotations
- DaemonSet agents collect spans from pods on each node, enrich with K8s metadata, and forward to gateway
- Gateway replicas perform tail-based sampling and route to trace, metrics, and log backends
- Auto-instrumentation via the Instrumentation CRD eliminates manual SDK integration for common frameworks
- Tail-based sampling at the gateway ensures errors and slow traces are always captured
- W3C TraceContext and Baggage propagation maintain trace context and correlation IDs across service calls
- Grafana Tempo provides cost-effective trace storage on object storage with native Grafana integration
- spanmetrics processor generates RED metrics from traces, enabling trace-informed alerting without additional instrumentation

The key operational insight: configure the memory_limiter processor on every pipeline, size tail_sampling buffers for peak trace volume, and run multiple gateway replicas with load balancing by trace ID to ensure complete traces for sampling decisions.
