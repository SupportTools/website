---
title: "Vector: High-Performance Log Aggregation for Kubernetes"
date: 2027-01-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Vector", "Logging", "Observability", "Fluent Bit"]
categories:
- Observability
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for deploying Vector on Kubernetes as a high-performance log aggregation pipeline with VRL transformations, multi-sink routing, and the aggregator pattern."
more_link: "yes"
url: "/vector-log-aggregation-kubernetes-production-guide/"
---

**Vector** is a high-performance observability data pipeline written in Rust. In Kubernetes log collection benchmarks, Vector consistently processes 10–50x more events per second than Fluentd and 2–5x more than Fluent Bit at equivalent CPU budgets, while also supporting metrics and traces in the same pipeline. The **Vector Remap Language (VRL)** provides a Rust-backed expression language for transformations that is fast enough to run inline without performance degradation. This guide covers a complete production deployment covering DaemonSet collection, VRL-based parsing and enrichment, multi-sink routing, and the aggregator pattern for high-volume clusters.

<!--more-->

## Vector vs Fluent Bit vs Fluentd

| Dimension | Vector | Fluent Bit | Fluentd |
|-----------|--------|------------|---------|
| Language | Rust | C | Ruby |
| CPU efficiency | Excellent | Very good | Moderate |
| Memory footprint | ~20 MB base | ~5 MB base | ~200 MB base |
| Throughput (events/sec per core) | 500k–2M | 200k–500k | 50k–100k |
| Transformation language | VRL | Lua / built-in filters | Ruby plugins |
| Kubernetes metadata enrichment | Native | Native | Plugin |
| Metrics support | Yes | Limited | Plugin |
| Traces support | Yes (OTLP) | No | Plugin |
| Backpressure | Native | Limited | Plugin |
| Disk buffering | Native | Limited | Plugin |
| Multi-sink routing | Native | Plugin | Plugin |
| CRD-based config | Vector Operator | FluentBit Operator | Fluentd Operator |

Fluent Bit remains a valid choice for extremely resource-constrained edge nodes where Vector's slightly larger binary matters. Fluentd makes sense only when an existing Ruby plugin ecosystem is required. For new Kubernetes deployments targeting centralized logging at scale, Vector is the default recommendation.

## Vector Architecture: Sources, Transforms, and Sinks

```
┌──────────────────────────────────────────────────────┐
│                  Vector Pipeline                     │
│                                                      │
│  Sources         Transforms            Sinks         │
│  ─────────       ──────────            ─────         │
│  kubernetes_logs → parse_container  → loki           │
│                  → enrich_k8s       → s3             │
│  journald        → parse_json       → elasticsearch  │
│                  → route_by_ns      → kafka          │
│  host_metrics    → deduplicate      → prometheus     │
│  (optional)      → sample           │                │
│                  → throttle         │                │
└──────────────────────────────────────────────────────┘
```

Each component in the pipeline is statically typed and connected by named identifiers. Vector validates the configuration at startup and reports type mismatches as errors rather than silently dropping events.

## DaemonSet Deployment

### Helm Installation

```bash
helm repo add vector https://helm.vector.dev
helm repo update

helm install vector vector/vector \
  --namespace vector \
  --create-namespace \
  -f vector-values.yaml
```

```yaml
# vector-values.yaml
role: Agent  # DaemonSet mode

image:
  repository: timberio/vector
  tag: 0.39.0-distroless-libc
  pullPolicy: IfNotPresent

resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    cpu: "1"
    memory: 512Mi

tolerations:
  - operator: Exists  # Collect from all nodes including control plane

# Mount host paths for pod log access
extraVolumeMounts:
  - name: var-log
    mountPath: /var/log
    readOnly: true
  - name: var-lib-docker-containers
    mountPath: /var/lib/docker/containers
    readOnly: true

extraVolumes:
  - name: var-log
    hostPath:
      path: /var/log
  - name: var-lib-docker-containers
    hostPath:
      path: /var/lib/docker/containers

# RBAC to read pod metadata from Kubernetes API
rbac:
  create: true

serviceAccount:
  create: true

podMonitor:
  enabled: true
  interval: 60s

# Vector configuration via customConfig (replaces default)
customConfig:
  data_dir: /vector-data-dir

  api:
    enabled: true
    address: 127.0.0.1:8686
    playground: false

  sources:
    kubernetes_logs:
      type: kubernetes_logs
      auto_partial_merge: true
      namespace_annotation_fields:
        namespace_labels: ".kubernetes.namespace_labels"
      pod_annotation_fields:
        pod_labels: ".kubernetes.pod_labels"
        pod_annotations: ".kubernetes.pod_annotations"
      node_annotation_fields:
        node_labels: ".kubernetes.node_labels"

    host_metrics:
      type: host_metrics
      collectors:
        - cpu
        - disk
        - filesystem
        - load
        - memory
        - network

  transforms:
    parse_and_enrich:
      type: remap
      inputs: ["kubernetes_logs"]
      source: |
        # Attempt to parse the message as JSON
        parsed, err = parse_json(.message)
        if err == null {
          .structured = parsed
          .log_type = "json"
        } else {
          .log_type = "text"
        }

        # Normalize log level
        if exists(.structured.level) {
          .level = downcase(string!(.structured.level))
        } else if exists(.structured.severity) {
          .level = downcase(string!(.structured.severity))
        } else if exists(.structured.lvl) {
          .level = downcase(string!(.structured.lvl))
        } else {
          .level = "info"
        }

        # Add cluster identifier
        .cluster = "prod-us-east-1"

        # Remove high-cardinality fields that bloat index
        del(.kubernetes.pod_annotations."kubectl.kubernetes.io/last-applied-configuration")

    route_by_namespace:
      type: route
      inputs: ["parse_and_enrich"]
      route:
        system: |
          .kubernetes.pod_namespace == "kube-system" ||
          .kubernetes.pod_namespace == "cert-manager" ||
          .kubernetes.pod_namespace == "ingress-nginx"
        application: |
          .kubernetes.pod_namespace != "kube-system" &&
          .kubernetes.pod_namespace != "cert-manager" &&
          .kubernetes.pod_namespace != "ingress-nginx"

  sinks:
    loki_application:
      type: loki
      inputs: ["route_by_namespace.application"]
      endpoint: "http://loki-gateway.logging.svc.cluster.local"
      encoding:
        codec: json
      labels:
        namespace: "{{ kubernetes.pod_namespace }}"
        pod: "{{ kubernetes.pod_name }}"
        container: "{{ kubernetes.container_name }}"
        cluster: "{{ cluster }}"
        level: "{{ level }}"
      batch:
        max_bytes: 1048576
        timeout_secs: 5
      buffer:
        type: disk
        max_size: 268435456  # 256 MiB
        when_full: block

    loki_system:
      type: loki
      inputs: ["route_by_namespace.system"]
      endpoint: "http://loki-gateway.logging.svc.cluster.local"
      encoding:
        codec: json
      labels:
        namespace: "{{ kubernetes.pod_namespace }}"
        pod: "{{ kubernetes.pod_name }}"
        container: "{{ kubernetes.container_name }}"
        cluster: "{{ cluster }}"
        component: system
      batch:
        max_bytes: 1048576
        timeout_secs: 5
      buffer:
        type: disk
        max_size: 134217728  # 128 MiB
        when_full: block

    s3_archive:
      type: aws_s3
      inputs: ["parse_and_enrich"]
      region: us-east-1
      bucket: log-archive-prod
      key_prefix: "kubernetes/year=%Y/month=%m/day=%d/hour=%H/"
      encoding:
        codec: ndjson
      compression: gzip
      batch:
        max_bytes: 104857600  # 100 MiB
        timeout_secs: 300
      auth:
        access_key_id: "${AWS_ACCESS_KEY_ID}"
        secret_access_key: "${AWS_SECRET_ACCESS_KEY}"
      buffer:
        type: disk
        max_size: 1073741824  # 1 GiB
        when_full: block
```

## VRL: Vector Remap Language Deep Dive

VRL is a domain-specific language for log transformation that compiles to efficient bytecode and runs without heap allocation for simple transforms.

### Parsing Multiline Logs (Java Stack Traces)

```yaml
transforms:
  parse_multiline_java:
    type: remap
    inputs: ["java_app_logs"]
    source: |
      # Java stack traces start a new logical event at lines beginning
      # with a timestamp — everything else is continuation
      # Vector's kubernetes_logs source handles auto_partial_merge
      # for the common "\n\t" continuation pattern, but this handles
      # custom multiline patterns after merge:

      if starts_with(string!(.message), "Exception") ||
         starts_with(string!(.message), "\tat ") {
        .log_type = "exception"
        .exception_class = parse_regex(.message, r'^(?P<class>[A-Za-z\.]+Exception)') ??
          {"class": "UnknownException"}
        .exception_class = .exception_class.class
      }

      # Parse structured log from Logback JSON layout
      parsed, err = parse_json(.message)
      if err == null {
        .timestamp = parse_timestamp(string!(parsed.timestamp), "%Y-%m-%dT%H:%M:%S%.fZ") ??
          now()
        .level = downcase(string!(parsed.level))
        .logger = parsed.logger
        .thread = parsed.thread
        .message = parsed.message
        if exists(parsed.stack_trace) {
          .stack_trace = parsed.stack_trace
        }
      }
```

### Parsing Nginx Access Logs

```yaml
transforms:
  parse_nginx_access:
    type: remap
    inputs: ["nginx_logs"]
    source: |
      parsed, err = parse_nginx_log(.message, "combined")
      if err != null {
        # Try extended Nginx format
        parsed, err = parse_regex(.message, r'^(?P<remote_addr>\S+) - (?P<remote_user>\S+) \[(?P<time_local>[^\]]+)\] "(?P<request>[^"]*)" (?P<status>\d+) (?P<body_bytes_sent>\d+) "(?P<http_referer>[^"]*)" "(?P<http_user_agent>[^"]*)" (?P<request_time>[\d\.]+)')
        if err != null {
          log("Failed to parse nginx log: " + .message, level: "warn")
        }
      }

      if err == null {
        .http_method = split(string!(parsed.request), " ")[0] ?? "UNKNOWN"
        .http_path = split(string!(parsed.request), " ")[1] ?? "/"
        .http_status = to_int!(parsed.status)
        .bytes_sent = to_int!(parsed.body_bytes_sent)
        .request_time_ms = to_float!(parsed.request_time) * 1000.0
        .remote_addr = parsed.remote_addr
        .user_agent = parsed.http_user_agent

        # Classify response codes
        if .http_status >= 500 {
          .level = "error"
        } else if .http_status >= 400 {
          .level = "warn"
        } else {
          .level = "info"
        }
      }
```

### Log Enrichment with Kubernetes Metadata

```yaml
transforms:
  enrich_with_labels:
    type: remap
    inputs: ["kubernetes_logs"]
    source: |
      # Promote commonly queried pod labels to top-level fields
      labels = .kubernetes.pod_labels ?? {}

      .app = get(labels, ["app.kubernetes.io/name"]) ??
             get(labels, ["app"]) ?? "unknown"
      .version = get(labels, ["app.kubernetes.io/version"]) ?? "unknown"
      .component = get(labels, ["app.kubernetes.io/component"]) ?? "unknown"
      .env = get(labels, ["environment"]) ??
             .kubernetes.pod_namespace

      # Extract request ID from structured JSON if present
      if is_object(.structured) {
        .request_id = string(.structured.request_id) ?? string(.structured.trace_id) ?? null
      }

      # Sanitize PII: mask email addresses in log messages
      .message = replace(string!(.message),
        r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}',
        "[EMAIL_REDACTED]")
```

### Throttling and Sampling Noisy Sources

```yaml
transforms:
  sample_debug_logs:
    type: sample
    inputs: ["parse_and_enrich"]
    rate: 10  # Keep 1 in 10 debug-level events
    key_field: "kubernetes.pod_namespace"
    exclude:
      type: vrl
      source: .level != "debug"  # Only sample debug logs

  throttle_noisy_pods:
    type: throttle
    inputs: ["parse_and_enrich"]
    threshold: 1000
    window_secs: 1
    key_field: "kubernetes.pod_name"
    exclude:
      type: vrl
      source: .level == "error" || .level == "warn"  # Never throttle errors
```

## Aggregator Pattern for High-Volume Clusters

In large clusters (500+ nodes), running a full Loki/Elasticsearch sink in every DaemonSet pod creates excessive connection overhead and makes backpressure management difficult. The **aggregator pattern** uses two tiers:

```
┌─────────────────────────────────────────────────┐
│                 Node Layer                      │
│  Vector Agent DaemonSet (one pod per node)      │
│  - Collects kubernetes_logs                     │
│  - Parses and enriches                          │
│  - Sends to Vector Aggregator via NATS/Kafka    │
│    or Vector-native protocol                    │
└─────────────────────────────────────────────────┘
                         │
                  vector_sink
                         │
                         ▼
┌─────────────────────────────────────────────────┐
│              Aggregator Layer                   │
│  Vector Aggregator Deployment (3+ pods)         │
│  - Receives from all agents                     │
│  - Deduplicates                                 │
│  - Routes to Loki, S3, Kafka, Elasticsearch     │
│  - Manages disk buffer for sink failures        │
└─────────────────────────────────────────────────┘
```

### Agent Configuration (sends to aggregator)

```yaml
# Agent sink: Vector-native protocol to aggregator
sinks:
  aggregator:
    type: vector
    inputs: ["parse_and_enrich"]
    address: "vector-aggregator.vector.svc.cluster.local:9000"
    compression: gzip
    buffer:
      type: disk
      max_size: 268435456  # 256 MiB local buffer if aggregator is unavailable
      when_full: block
    healthcheck:
      enabled: true
      uri: "http://vector-aggregator.vector.svc.cluster.local:8686/health"
```

### Aggregator Deployment

```yaml
# vector-aggregator-values.yaml
role: Aggregator

replicaCount: 3

podDisruptionBudget:
  enabled: true
  minAvailable: 2

resources:
  requests:
    cpu: "1"
    memory: 1Gi
  limits:
    cpu: "4"
    memory: 4Gi

customConfig:
  data_dir: /vector-data-dir

  sources:
    vector_agents:
      type: vector
      address: 0.0.0.0:9000
      version: "2"

  transforms:
    deduplicate:
      type: dedupe
      inputs: ["vector_agents"]
      fields:
        match:
          - kubernetes.pod_name
          - kubernetes.container_name
          - message
      cache:
        num_events: 5000

    route_to_sinks:
      type: route
      inputs: ["deduplicate"]
      route:
        loki_route: "true"
        s3_route: "true"
        kafka_route: |
          exists(.kubernetes.pod_labels."kafka-audit") &&
          .kubernetes.pod_labels."kafka-audit" == "true"

  sinks:
    loki:
      type: loki
      inputs: ["route_to_sinks.loki_route"]
      endpoint: "http://loki-gateway.logging.svc.cluster.local"
      encoding:
        codec: json
      labels:
        namespace: "{{ kubernetes.pod_namespace }}"
        pod: "{{ kubernetes.pod_name }}"
        container: "{{ kubernetes.container_name }}"
        app: "{{ app }}"
        level: "{{ level }}"
        cluster: "{{ cluster }}"
      out_of_order_action: accept
      batch:
        max_bytes: 5242880
        timeout_secs: 5
      buffer:
        type: disk
        max_size: 2147483648  # 2 GiB
        when_full: block

    s3_archive:
      type: aws_s3
      inputs: ["route_to_sinks.s3_route"]
      region: us-east-1
      bucket: log-archive-prod
      key_prefix: "k8s/cluster=prod-us-east-1/year=%Y/month=%m/day=%d/"
      encoding:
        codec: ndjson
      compression: gzip
      batch:
        max_bytes: 104857600
        timeout_secs: 300
      auth:
        access_key_id: "${AWS_ACCESS_KEY_ID}"
        secret_access_key: "${AWS_SECRET_ACCESS_KEY}"
      buffer:
        type: disk
        max_size: 10737418240  # 10 GiB
        when_full: block

    kafka_audit:
      type: kafka
      inputs: ["route_to_sinks.kafka_route"]
      bootstrap_servers: "kafka.kafka.svc.cluster.local:9092"
      topic: "k8s-audit-logs"
      encoding:
        codec: json
      buffer:
        type: disk
        max_size: 1073741824
        when_full: block
      librdkafka_options:
        security.protocol: sasl_ssl
        sasl.mechanisms: SCRAM-SHA-512
        sasl.username: vector-producer
        sasl.password: "${KAFKA_SASL_PASSWORD}"
```

## Backpressure and Disk Buffering

Vector's backpressure model is deterministic: when a sink is slow or unavailable, the pipeline applies backpressure upstream. Components are configured with a `buffer` that determines behavior when the downstream is saturated.

```yaml
# Buffer behavior options:
# when_full: block   → Pause ingestion (prevents log loss, applies backpressure)
# when_full: drop_newest → Drop new events (for metrics/debug where loss is acceptable)

# Disk buffer for Loki (survives pod restart if /vector-data-dir is persistent)
buffer:
  type: disk
  max_size: 2147483648  # 2 GiB
  when_full: block

# Memory buffer for low-latency paths (faster but lost on pod restart)
buffer:
  type: memory
  max_events: 500000
  when_full: block
```

For the aggregator, mount a PersistentVolumeClaim for `/vector-data-dir` to ensure disk buffers survive pod evictions:

```yaml
persistence:
  enabled: true
  storageClassName: fast-ssd
  size: 50Gi
  accessModes:
    - ReadWriteOnce
```

## Monitoring Vector with Prometheus

Vector exposes an internal metrics endpoint:

```yaml
# In Vector config
sinks:
  prometheus_internal_metrics:
    type: prometheus_exporter
    inputs: ["internal_metrics"]
    address: 0.0.0.0:9598
    default_namespace: vector
```

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: vector-agent
  namespace: vector
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: vector
      app.kubernetes.io/component: Agent
  podMetricsEndpoints:
    - port: prom-exporter
      interval: 30s
      path: /metrics
```

### Key Vector Metrics and Alerts

```yaml
groups:
  - name: vector-pipeline
    rules:
      - alert: VectorComponentDroppedEvents
        expr: rate(vector_component_discarded_events_total[5m]) > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Vector component {{ $labels.component_id }} is dropping events"
          description: "{{ $value | humanize }} events/sec dropped. Check buffer configuration."

      - alert: VectorSinkErrors
        expr: rate(vector_component_errors_total{component_kind="sink"}[5m]) > 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Vector sink {{ $labels.component_id }} has errors"

      - alert: VectorBufferFull
        expr: |
          vector_buffer_byte_size / vector_buffer_max_byte_size > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Vector buffer for {{ $labels.component_id }} is {{ $value | humanizePercentage }} full"

      - alert: VectorHighEventIngestionLag
        expr: |
          vector_component_received_events_total{component_kind="source"} -
          vector_component_sent_events_total{component_kind="source"} > 100000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Vector source {{ $labels.component_id }} has high event lag"
```

Key metrics to track:

```
# Events processed per second
rate(vector_component_received_events_total[1m])

# Events sent per second (should track received)
rate(vector_component_sent_events_total[1m])

# Bytes processed
rate(vector_component_received_bytes_total[1m])

# Component errors
rate(vector_component_errors_total[5m])

# Dropped events (non-zero indicates data loss)
rate(vector_component_discarded_events_total[5m])

# Buffer usage ratio
vector_buffer_byte_size / vector_buffer_max_byte_size

# End-to-end event processing latency
vector_component_processing_duration_seconds_bucket
```

## Routing Logs to Multiple Sinks

The `route` transform enables content-based routing:

```yaml
transforms:
  route_by_app:
    type: route
    inputs: ["enrich_with_labels"]
    route:
      # Security-sensitive apps route to both Loki and Kafka for SIEM
      security_apps: |
        includes(["auth", "api-gateway", "payment-service"], .app)

      # High-volume apps only go to S3 (skip Loki to save cost)
      high_volume: |
        includes(["batch-processor", "event-indexer"], .app) &&
        .level != "error" && .level != "warn"

      # Default: everything else goes to Loki
      default: |
        !includes(["auth", "api-gateway", "payment-service",
                   "batch-processor", "event-indexer"], .app)
```

## Performance Benchmarks and Sizing

Based on production deployments:

| Cluster Size | Agent CPU | Agent Memory | Aggregator Replicas | Aggregator CPU/pod |
|-------------|-----------|--------------|--------------------|--------------------|
| 50 nodes | 100m avg | 128 Mi | 2 | 500m avg |
| 200 nodes | 150m avg | 192 Mi | 3 | 1 core avg |
| 500 nodes | 200m avg | 256 Mi | 5 | 2 cores avg |
| 1000 nodes | 250m avg | 384 Mi | 8 | 3 cores avg |

These figures assume an average of 5,000 log events/second per node and VRL transforms including JSON parsing and metadata enrichment. Enabling disk buffering adds roughly 5% CPU overhead due to serialization.

## VRL Testing

Test VRL scripts before deploying with `vector vrl`:

```bash
# Install Vector locally
curl --proto '=https' --tlsv1.2 -sSf https://sh.vector.dev | bash

# Test VRL against sample events
cat <<'EOF' > parse_nginx.vrl
parsed, err = parse_nginx_log(.message, "combined")
if err != null {
  abort
}
.status = to_int!(parsed.status)
.path = parsed.path
.method = parsed.method
EOF

echo '{"message": "10.0.0.1 - user [01/Jan/2026:12:00:00 +0000] \"GET /api/health HTTP/1.1\" 200 45 \"-\" \"curl/7.68.0\""}' | \
  vector vrl --program parse_nginx.vrl
```

## Sidecar Deployment for Per-Pod Log Control

While DaemonSet deployment is standard for cluster-wide collection, the **sidecar pattern** provides per-pod log routing control when a DaemonSet cannot be used (shared cluster, policy restriction) or when a specific pod emits logs to a non-standard path:

```yaml
# Sidecar Vector container added to an application Pod
- name: log-shipper
  image: timberio/vector:0.39.0-distroless-libc
  args: ["--config", "/etc/vector/vector.yaml"]
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 128Mi
  volumeMounts:
    - name: app-logs
      mountPath: /var/log/app
      readOnly: true
    - name: vector-sidecar-config
      mountPath: /etc/vector
      readOnly: true
    - name: vector-sidecar-data
      mountPath: /vector-data-dir
```

```yaml
# vector-sidecar.yaml ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: vector-sidecar-config
  namespace: platform
data:
  vector.yaml: |
    data_dir: /vector-data-dir

    sources:
      app_file_logs:
        type: file
        include:
          - /var/log/app/*.log
        multiline:
          start_pattern: '^\d{4}-\d{2}-\d{2}'
          mode: halt_before
          condition_pattern: '^\d{4}-\d{2}-\d{2}'
          timeout_ms: 1000

    transforms:
      parse_app_log:
        type: remap
        inputs: ["app_file_logs"]
        source: |
          parsed, err = parse_json(.message)
          if err == null {
            . = merge(., parsed)
          }
          .pod_name = "${POD_NAME}"
          .namespace = "${POD_NAMESPACE}"
          .app = "${APP_NAME}"

    sinks:
      loki:
        type: loki
        inputs: ["parse_app_log"]
        endpoint: "http://loki-gateway.logging.svc.cluster.local"
        encoding:
          codec: json
        labels:
          pod: "{{ pod_name }}"
          namespace: "{{ namespace }}"
          app: "{{ app }}"
        buffer:
          type: disk
          max_size: 67108864  # 64 MiB
          when_full: block
```

## Kubernetes Operator for CRD-Based Configuration

The **Vector Operator** (community project) enables declaring Vector pipelines as Kubernetes CRDs, eliminating the need to manage ConfigMaps directly:

```bash
helm repo add vector-operator https://kaasops.github.io/vector-operator/helm
helm install vector-operator vector-operator/vector-operator \
  --namespace vector \
  --create-namespace
```

```yaml
# VectorPipeline CRD — per-namespace log routing
apiVersion: vectorcharts.kaasops.io/v1alpha1
kind: VectorPipeline
metadata:
  name: app-logs
  namespace: platform
spec:
  sources:
    kubernetes_logs:
      type: kubernetes_logs
      extra_label_selector: "environment=production"

  transforms:
    parse:
      type: remap
      inputs: ["kubernetes_logs"]
      source: |
        parsed, err = parse_json(.message)
        if err == null { . = merge(., parsed) }
        .cluster = "prod"

  sinks:
    loki:
      type: loki
      inputs: ["parse"]
      endpoint: "http://loki-gateway.logging.svc.cluster.local"
      encoding:
        codec: json
      labels:
        namespace: "{{ kubernetes.pod_namespace }}"
        app: "{{ app }}"
```

## Operational Runbook

### Diagnosing Event Loss

```bash
# Check if any component is dropping events
kubectl exec -n vector ds/vector -- \
  vector top --url http://localhost:8686

# Query internal metrics for discarded events
kubectl exec -n vector ds/vector -- \
  curl -s http://localhost:8686/metrics | \
  grep vector_component_discarded_events_total | \
  grep -v '^#'

# Check disk buffer usage
kubectl exec -n vector ds/vector -- \
  df -h /vector-data-dir
```

### Reloading Configuration Without Restart

```bash
# Vector supports SIGHUP-based config reload
kubectl rollout restart daemonset/vector -n vector

# Or send SIGHUP directly to a specific pod for zero-downtime reload
kubectl exec -n vector vector-abc12 -- \
  kill -HUP $(pgrep vector)
```

### Testing a VRL Program Against Live Data

```bash
# Tap a live Vector component to inspect events
kubectl exec -n vector ds/vector -- \
  vector tap kubernetes_logs --url http://localhost:8686 --limit 5
```

Vector's combination of Rust-level performance, a type-safe transformation language, and native Kubernetes integration makes it the most capable log collection agent available for production Kubernetes environments. The aggregator pattern scales linearly with cluster size without requiring changes to individual agent configuration, and disk buffering ensures zero log loss even during temporary downstream failures.
