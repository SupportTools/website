---
title: "OpenTelemetry Collector Pipeline Configuration: Production Observability at Scale"
date: 2026-12-22T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Observability", "Distributed Tracing", "Metrics", "Logs", "Kubernetes", "Production"]
categories:
- Observability
- Kubernetes
- Production Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into OpenTelemetry Collector pipeline configuration for production: receivers, processors, exporters, tail sampling, metrics transformation, log parsing, and scaling strategies."
more_link: "yes"
url: "/opentelemetry-collector-pipeline-configuration-production-guide/"
---

The **OpenTelemetry Collector** is the most versatile telemetry processing component in the modern observability stack. Unlike vendor-specific agents, the Collector provides a vendor-neutral pipeline for receiving, processing, and exporting traces, metrics, and logs — a single binary that can simultaneously ingest from dozens of sources and fan out to multiple backends while performing in-flight transformation, filtering, and sampling.

At small scale, the Collector is straightforward. At production scale — tens of thousands of spans per second, hundreds of millions of metric samples per hour, gigabytes of logs per minute — the pipeline configuration becomes a discipline in its own right. Misconfigured batch processors, absent memory limiters, naive trace sampling strategies, and undersized gateway deployments have each caused production observability outages. This guide addresses all of these failure modes with configurations validated in production environments.

<!--more-->

## Collector Architecture: Agent vs Gateway

### Deployment Modes

The Collector operates in two complementary deployment modes:

**Agent mode** runs as a **DaemonSet**, with one Collector instance per node. Agents collect node-level telemetry (host metrics, kubelet stats, container logs) and receive telemetry from applications running on the same node via localhost connections. Agents pre-process and forward to the gateway.

**Gateway mode** runs as a **Deployment** behind a Service, receiving telemetry from all agents and performing expensive operations at scale: tail-based sampling (which requires seeing all spans for a trace), cross-service metric aggregation, and fan-out to multiple backends. The gateway is horizontally scalable.

```
Application Pods
      |
      | (OTLP gRPC/HTTP)
      v
  Agent DaemonSet (per-node)
  - k8sattributes enrichment
  - host metrics
  - memory limiter
  - batch processor
      |
      | (OTLP gRPC)
      v
  Gateway Deployment (replicated)
  - tail sampling
  - metrics transformation
  - log parsing
  - fan-out exporters
      |
      +--------+--------+
      |        |        |
   Jaeger   Grafana   S3 / GCS
   /Tempo    Mimir   (log archive)
```

## Helm Installation with otel-collector Chart

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

kubectl create namespace observability
```

### Agent DaemonSet Values

```yaml
mode: daemonset

image:
  repository: otel/opentelemetry-collector-contrib
  tag: 0.114.0

clusterRole:
  create: true
  rules:
  - apiGroups: [""]
    resources:
    - nodes
    - nodes/proxy
    - nodes/metrics
    - services
    - endpoints
    - pods
    verbs: ["get", "list", "watch"]
  - apiGroups: ["extensions", "networking.k8s.io"]
    resources:
    - ingresses
    verbs: ["get", "list", "watch"]
  - nonResourceURLs:
    - /metrics
    - /metrics/cadvisor
    verbs: ["get"]

tolerations:
- operator: Exists

resources:
  requests:
    cpu: 200m
    memory: 400Mi
  limits:
    cpu: "1"
    memory: 1Gi

config:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
    hostmetrics:
      collection_interval: 30s
      scrapers:
        cpu: {}
        disk: {}
        filesystem: {}
        load: {}
        memory: {}
        network: {}
        paging: {}
    kubeletstats:
      collection_interval: 30s
      auth_type: serviceAccount
      endpoint: "${env:K8S_NODE_NAME}:10250"
      insecure_skip_verify: true
      metric_groups:
      - node
      - pod
      - container
  processors:
    batch:
      timeout: 10s
      send_batch_size: 1000
      send_batch_max_size: 2000
    memory_limiter:
      check_interval: 1s
      limit_percentage: 75
      spike_limit_percentage: 20
    k8sattributes:
      auth_type: serviceAccount
      passthrough: false
      extract:
        metadata:
        - k8s.pod.name
        - k8s.pod.uid
        - k8s.deployment.name
        - k8s.namespace.name
        - k8s.node.name
        - k8s.pod.start_time
        labels:
        - tag_name: app
          key: app
          from: pod
        - tag_name: version
          key: version
          from: pod
        annotations:
        - tag_name: team
          key: team
          from: namespace
        - tag_name: cost-center
          key: cost-center
          from: namespace
      pod_association:
      - sources:
        - from: resource_attribute
          name: k8s.pod.ip
      - sources:
        - from: resource_attribute
          name: k8s.pod.uid
      - sources:
        - from: connection
          name: ip
  exporters:
    otlp:
      endpoint: otel-gateway.observability.svc.cluster.local:4317
      tls:
        insecure: true
  service:
    telemetry:
      logs:
        level: warn
      metrics:
        address: 0.0.0.0:8888
    extensions:
    - health_check
    - zpages
    - pprof
    pipelines:
      traces:
        receivers:
        - otlp
        processors:
        - memory_limiter
        - k8sattributes
        - batch
        exporters:
        - otlp
      metrics:
        receivers:
        - otlp
        - hostmetrics
        - kubeletstats
        processors:
        - memory_limiter
        - k8sattributes
        - batch
        exporters:
        - otlp
      logs:
        receivers:
        - otlp
        processors:
        - memory_limiter
        - k8sattributes
        - batch
        exporters:
        - otlp
```

Deploy the agent:

```bash
helm upgrade --install otel-agent open-telemetry/opentelemetry-collector \
  --namespace observability \
  --values otel-agent-values.yaml \
  --version 0.108.0
```

## Traces Pipeline: Full Gateway Configuration

The gateway collector performs more expensive operations than the agent. It is stateful for tail sampling and must see all spans for a given trace:

```yaml
mode: deployment

replicaCount: 3

image:
  repository: otel/opentelemetry-collector-contrib
  tag: 0.114.0

config:
  extensions:
    health_check:
      endpoint: 0.0.0.0:13133
    zpages:
      endpoint: 0.0.0.0:55679
    pprof:
      endpoint: 0.0.0.0:1777

  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
          max_recv_msg_size_mib: 32
        http:
          endpoint: 0.0.0.0:4318

  processors:
    memory_limiter:
      check_interval: 1s
      limit_percentage: 80
      spike_limit_percentage: 25

    batch/traces:
      timeout: 5s
      send_batch_size: 512
      send_batch_max_size: 1024

    tail_sampling:
      decision_wait: 10s
      num_traces: 50000
      expected_new_traces_per_sec: 1000
      policies:
      - name: errors-policy
        type: status_code
        status_code:
          status_codes:
          - ERROR
          - UNSET
      - name: slow-traces-policy
        type: latency
        latency:
          threshold_ms: 1000
      - name: http-5xx-policy
        type: string_attribute
        string_attribute:
          key: http.status_code
          values:
          - "500"
          - "502"
          - "503"
          - "504"
      - name: grpc-error-policy
        type: string_attribute
        string_attribute:
          key: rpc.grpc.status_code
          values:
          - "2"
          - "13"
          - "14"
      - name: probabilistic-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 5
      - name: rate-limiting-policy
        type: rate_limiting
        rate_limiting:
          spans_per_second: 10000

    attributes/traces:
      actions:
      - key: environment
        value: production
        action: upsert
      - key: db.password
        action: delete
      - key: http.request.header.authorization
        action: delete

  exporters:
    otlp/tempo:
      endpoint: tempo-distributor.monitoring.svc.cluster.local:4317
      tls:
        insecure: true
    debug:
      verbosity: basic
      sampling_initial: 5
      sampling_thereafter: 200

  service:
    telemetry:
      logs:
        level: warn
      metrics:
        address: 0.0.0.0:8888
    extensions:
    - health_check
    - zpages
    - pprof
    pipelines:
      traces:
        receivers:
        - otlp
        processors:
        - memory_limiter
        - tail_sampling
        - attributes/traces
        - batch/traces
        exporters:
        - otlp/tempo
```

## Metrics Pipeline with Prometheus Remote Write

```yaml
processors:
  filter/metrics:
    metrics:
      exclude:
        match_type: regexp
        metric_names:
        - .*\.temp$
        - go_memstats_.*_inuse_bytes
        - process_cpu_seconds_(?:user|system)_total

  transform/metrics:
    metric_statements:
    - context: metric
      statements:
      - set(description, "Request duration histogram") where name == "http.server.duration"
    - context: datapoint
      statements:
      - set(attributes["service_name"], resource.attributes["service.name"])
      - set(attributes["k8s_namespace"], resource.attributes["k8s.namespace.name"])
      - set(attributes["k8s_pod"], resource.attributes["k8s.pod.name"])

  metricstransform/aggregations:
    transforms:
    - include: system.cpu.utilization
      action: update
      new_name: node_cpu_utilization
    - include: system.memory.utilization
      action: update
      new_name: node_memory_utilization

exporters:
  prometheusremotewrite:
    endpoint: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
    tls:
      insecure: true
    external_labels:
      cluster: production-cluster
      region: us-east-1
    resource_to_telemetry_conversion:
      enabled: true
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 10
      queue_size: 1000

service:
  pipelines:
    metrics:
      receivers:
      - otlp
      processors:
      - memory_limiter
      - filter/metrics
      - transform/metrics
      - metricstransform/aggregations
      - batch
      exporters:
      - prometheusremotewrite
```

## Logs Pipeline with Loki Exporter

```yaml
receivers:
  filelog:
    include:
    - /var/log/pods/*/*/*.log
    exclude:
    - /var/log/pods/*/otel-agent/*.log
    start_at: beginning
    include_file_path: true
    include_file_name: false
    operators:
    - type: router
      id: get-format
      routes:
      - output: parser-docker
        expr: 'body matches "^\\{"'
      - output: parser-crio
        expr: 'body matches "^[^ Z]+Z"'
    - type: json_parser
      id: parser-docker
      output: extract-metadata-from-filepath
    - type: regex_parser
      id: parser-crio
      regex: '^(?P<time>[^ Z]+Z) (?P<stream>stdout|stderr) (?P<logtag>[^ ]*) ?(?P<log>.*)$'
      output: extract-metadata-from-filepath
      timestamp:
        parse_from: attributes.time
        layout: '%Y-%m-%dT%H:%M:%S.%LZ'
    - type: regex_parser
      id: extract-metadata-from-filepath
      regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]{36})\/(?P<container_name>[^\._]+)\/(?P<restart_count>\d+)\.log$'
      parse_from: attributes["log.file.path"]
    - type: move
      from: attributes.log
      to: body
    - type: remove
      field: attributes.time

processors:
  filter/logs:
    logs:
      exclude:
        match_type: strict
        bodies:
        - ""
        - " "

  transform/logs:
    log_statements:
    - context: log
      statements:
      - set(attributes["k8s.namespace.name"], attributes["namespace"])
      - set(attributes["k8s.pod.name"], attributes["pod_name"])
      - set(attributes["k8s.container.name"], attributes["container_name"])
      - delete_key(attributes, "namespace")
      - delete_key(attributes, "pod_name")
      - delete_key(attributes, "uid")

exporters:
  loki:
    endpoint: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push
    default_labels_enabled:
      exporter: false
      job: true
      instance: true
      level: true
    headers:
      "X-Scope-OrgID": "production"

service:
  pipelines:
    logs:
      receivers:
      - otlp
      - filelog
      processors:
      - memory_limiter
      - k8sattributes
      - filter/logs
      - transform/logs
      - batch
      exporters:
      - loki
```

## Tail-Based Sampling for High-Volume Traces

**Tail-based sampling** makes sampling decisions after the complete trace has been collected, enabling intelligent decisions based on error status, latency, and span attributes. This requires the gateway to buffer traces until all spans arrive.

Key tuning parameters:

| Parameter | Purpose | Recommended Value |
|-----------|---------|-------------------|
| `decision_wait` | How long to wait for all spans | 10-30s depending on P99 trace duration |
| `num_traces` | In-memory trace buffer size | 5x expected TPS x decision_wait |
| `expected_new_traces_per_sec` | For memory pre-allocation | Actual measured TPS |

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    expected_new_traces_per_sec: 1000
    policies:
    - name: errors-policy
      type: status_code
      status_code:
        status_codes:
        - ERROR
        - UNSET
    - name: slow-traces-policy
      type: latency
      latency:
        threshold_ms: 1000
    - name: http-5xx-policy
      type: string_attribute
      string_attribute:
        key: http.status_code
        values:
        - "500"
        - "502"
        - "503"
        - "504"
    - name: grpc-error-policy
      type: string_attribute
      string_attribute:
        key: rpc.grpc.status_code
        values:
        - "2"
        - "13"
        - "14"
    - name: probabilistic-policy
      type: probabilistic
      probabilistic:
        sampling_percentage: 5
    - name: rate-limiting-policy
      type: rate_limiting
      rate_limiting:
        spans_per_second: 10000
```

Policy evaluation order matters. Policies are evaluated in order and the first policy to match determines the decision. Place the `errors-policy` first to ensure all error traces are kept regardless of subsequent policies.

## Batch Processor and Memory Limiter Tuning

The **memory limiter** processor is the most important safety valve in the Collector pipeline. Without it, a traffic spike can cause the Collector process to consume all available memory, triggering an OOM kill and creating an observability gap.

```yaml
processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 20

  batch:
    timeout: 10s
    send_batch_size: 1000
    send_batch_max_size: 2000
```

Tuning guidance:
- `limit_percentage: 75` leaves 25% headroom. The Collector will start dropping telemetry before the OS OOM killer acts.
- `spike_limit_percentage: 20` triggers soft drop behavior when memory increases 20% within `check_interval`.
- `batch.timeout` determines maximum latency before a partial batch is flushed. For traces: 5-10s. For metrics: 30-60s.
- `batch.send_batch_size` controls throughput. Larger batches reduce exporter overhead but increase per-batch memory.

Set Kubernetes resource limits consistent with `memory_limiter` settings:

```yaml
resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: "2"
    memory: 2Gi
```

With `limit_percentage: 75` and a 2 Gi memory limit, the Collector begins shedding load at 1.5 Gi — well before the 2 Gi limit triggers a pod restart.

## Kubernetes Attributes Processor

The **k8sattributes** processor enriches every telemetry signal with the Kubernetes metadata of the producing pod. This is essential for correlating traces with deployment names, namespaces, and team labels.

```yaml
processors:
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    filter:
      node_from_env_var: K8S_NODE_NAME
    extract:
      metadata:
      - k8s.pod.name
      - k8s.pod.uid
      - k8s.deployment.name
      - k8s.statefulset.name
      - k8s.daemonset.name
      - k8s.job.name
      - k8s.cronjob.name
      - k8s.namespace.name
      - k8s.node.name
      - k8s.pod.start_time
      - k8s.cluster.uid
      labels:
      - tag_name: app
        key: app
        from: pod
      - tag_name: version
        key: version
        from: pod
      - tag_name: component
        key: component
        from: pod
      annotations:
      - tag_name: team
        key: team
        from: namespace
      - tag_name: cost-center
        key: cost-center
        from: namespace
      - tag_name: environment
        key: environment
        from: namespace
    pod_association:
    - sources:
      - from: resource_attribute
        name: k8s.pod.ip
    - sources:
      - from: resource_attribute
        name: k8s.pod.uid
    - sources:
      - from: connection
        name: ip
```

The k8sattributes processor requires RBAC permissions to watch pods and namespaces. The Helm chart creates these automatically when `clusterRole.create: true` is set.

## Scaling the Gateway Collector with HPA

The gateway collector scales horizontally for metrics and logs pipelines. Tail sampling is the exception: consistent hash routing must be used to ensure all spans from the same trace arrive at the same Collector replica.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otel-gateway-hpa
  namespace: observability
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: otel-gateway
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 60
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: otelcol_receiver_accepted_spans
      target:
        type: AverageValue
        averageValue: 5000
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 4
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Pods
        value: 2
        periodSeconds: 120
```

For tail sampling with multiple gateway replicas, deploy a load balancer with consistent hash routing (using Trace ID as the hash key) in front of the gateway:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: observability
spec:
  mode: statefulset
  targetAllocator:
    enabled: true
    allocationStrategy: consistent-hashing
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
    processors:
      tail_sampling:
        decision_wait: 10s
        num_traces: 50000
        expected_new_traces_per_sec: 1000
        policies:
        - name: errors-policy
          type: status_code
          status_code:
            status_codes: [ERROR]
        - name: probabilistic-policy
          type: probabilistic
          probabilistic:
            sampling_percentage: 10
    exporters:
      otlp/tempo:
        endpoint: tempo-distributor.monitoring:4317
        tls:
          insecure: true
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [tail_sampling]
          exporters: [otlp/tempo]
```

## Debugging Collector Pipelines

### zpages Endpoint

The zpages extension exposes internal pipeline state as HTML pages. Access via port-forward:

```bash
#!/usr/bin/env bash
# Access zpages for pipeline debugging
COLLECTOR_POD="${1}"
NAMESPACE="${2:-observability}"
ZPAGES_PORT="${3:-55679}"

kubectl port-forward \
  "pod/${COLLECTOR_POD}" \
  "${ZPAGES_PORT}:${ZPAGES_PORT}" \
  -n "${NAMESPACE}" &
PF_PID=$!

sleep 2

echo "=== Trace pipeline overview ==="
curl -s "http://localhost:${ZPAGES_PORT}/debug/tracez" | \
  grep -E "Sampled|Error|Running|Completed" | head -20

echo ""
echo "=== Pipeline stats ==="
curl -s "http://localhost:${ZPAGES_PORT}/debug/pipelinez"

echo ""
echo "=== Extension status ==="
curl -s "http://localhost:${ZPAGES_PORT}/debug/extensionz"

kill "${PF_PID}" 2>/dev/null
```

### Prometheus Metrics for Pipeline Health

The Collector self-reports pipeline metrics at `:8888/metrics`. Key metrics:

```bash
#!/usr/bin/env bash
# Query Collector internal metrics via Prometheus
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"

echo "=== Accepted spans/s ==="
curl -s "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=rate(otelcol_receiver_accepted_spans_total[5m])' | \
  jq -r '.data.result[] | "\(.metric.receiver): \(.value[1] | tonumber | . * 100 | round / 100) spans/s"'

echo ""
echo "=== Refused spans/s (memory pressure) ==="
curl -s "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=rate(otelcol_receiver_refused_spans_total[5m])' | \
  jq -r '.data.result[] | "\(.metric.receiver): \(.value[1] | tonumber | . * 100 | round / 100) refused/s"'

echo ""
echo "=== Dropped spans/s ==="
curl -s "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=rate(otelcol_processor_dropped_spans_total[5m])' | \
  jq -r '.data.result[] | "\(.metric.processor): \(.value[1] | tonumber | . * 100 | round / 100) dropped/s"'

echo ""
echo "=== Exporter queue size ==="
curl -s "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=otelcol_exporter_queue_size' | \
  jq -r '.data.result[] | "\(.metric.exporter): \(.value[1]) items queued"'

echo ""
echo "=== Collector memory usage (MB) ==="
curl -s "${PROMETHEUS_URL}/api/v1/query" \
  --data-urlencode 'query=otelcol_process_memory_rss / 1024 / 1024' | \
  jq -r '.data.result[] | "\(.metric.pod // "gateway"): \(.value[1] | tonumber | . * 10 | round / 10)MB"'
```

### pprof for CPU Profiling

When the Collector consumes unexpectedly high CPU, use the pprof extension to capture a CPU profile:

```bash
#!/usr/bin/env bash
# Capture 30-second CPU profile from Collector
COLLECTOR_POD="${1}"
NAMESPACE="${2:-observability}"
PPROF_PORT="${3:-1777}"

kubectl port-forward \
  "pod/${COLLECTOR_POD}" \
  "${PPROF_PORT}:${PPROF_PORT}" \
  -n "${NAMESPACE}" &
PF_PID=$!
sleep 2

echo "Capturing 30-second CPU profile..."
curl -s "http://localhost:${PPROF_PORT}/debug/pprof/profile?seconds=30" \
  -o /tmp/collector-cpu.pprof

kill "${PF_PID}" 2>/dev/null

echo "Profile captured: /tmp/collector-cpu.pprof"
echo "Analyze with: go tool pprof /tmp/collector-cpu.pprof"
```

### Common Pipeline Failures and Resolutions

**Symptom: `otelcol_receiver_refused_spans` rising**
Cause: Memory limiter is rejecting incoming spans. Increase pod memory limit or reduce batch size. Confirm upstream agents are handling back-pressure with exponential retry.

**Symptom: `otelcol_exporter_queue_size` saturated**
Cause: Backend exporter is slower than ingestion rate. Scale the backend (Tempo, Loki, Prometheus), increase `sending_queue.queue_size`, or add gateway replicas.

**Symptom: Tail sampling decision latency > `decision_wait`**
Cause: Spans arriving after the decision window are lost. Increase `decision_wait`, verify network latency between agents and gateway, or increase `num_traces` if trace volume increased.

**Symptom: High memory on gateway despite memory limiter**
Cause: Tail sampling buffer (`num_traces`) is too large relative to pod memory. Reduce `num_traces` or increase pod memory to accommodate the intended buffer size.

**Symptom: k8sattributes processor showing `kube_apis.watch.request.count` errors**
Cause: Collector service account lacks RBAC permissions to watch pods and namespaces. Verify ClusterRole binding and API server connectivity.

A well-configured OpenTelemetry Collector pipeline is the operational foundation for mature observability. Getting the memory limiter, batch processor, and tail sampling configuration right pays dividends across the entire observability stack: backends receive steady, well-formed telemetry at manageable rates, dashboards reflect accurate sampling fractions, and on-call engineers can trust that the traces they see in Jaeger or Tempo are representative of the errors and slow operations that matter most in production.
