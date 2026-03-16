---
title: "OpenTelemetry Collector on Kubernetes: Traces, Metrics, and Logs Pipeline"
date: 2027-07-07T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Kubernetes", "Observability", "Tracing", "Metrics"]
categories:
- OpenTelemetry
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide for deploying OpenTelemetry Collector on Kubernetes, covering DaemonSet and Deployment modes, Kubernetes attribute enrichment, tail sampling, OTLP exporters to Jaeger, Tempo, Prometheus, and Loki, and auto-instrumentation with the OTel Operator."
more_link: "yes"
url: "/opentelemetry-collector-kubernetes-guide/"
---

OpenTelemetry Collector is the vendor-neutral telemetry processing pipeline at the heart of modern observability architectures. It receives traces, metrics, and logs from instrumented applications, enriches and transforms the data, and forwards it to one or more observability backends. On Kubernetes, the Collector takes on additional responsibilities: it reads Kubernetes metadata to enrich spans with pod labels and namespace context, scrapes Prometheus endpoints, processes node-level metrics via DaemonSet, and fans out data to multiple backends simultaneously. This guide covers every production concern from deployment topology through tail sampling configuration.

<!--more-->

## OpenTelemetry Collector Architecture

### Pipeline Model

Every Collector pipeline is composed of three ordered stages:

```
Receiver → Processor(s) → Exporter
```

Multiple pipelines can run in a single Collector instance, each independently configured. Shared components are referenced by name rather than duplicated:

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp, jaeger]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [otlp/tempo, jaeger]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp, filelog]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [loki]
```

### Deployment Modes

| Mode | Kubernetes Object | Purpose |
|------|------------------|---------|
| DaemonSet Agent | DaemonSet | Node-level metric collection; local OTLP endpoint for pods |
| Deployment Gateway | Deployment | Central fan-out; tail sampling; backend routing |
| Sidecar | Pod sidecar | Per-application trace collection (high isolation) |

The most common production topology uses a DaemonSet agent on every node that forwards to a central Deployment gateway. The gateway applies tail sampling and routes to backends.

---

## OTel Operator Installation

### Installing the Operator

```bash
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/download/v0.101.0/opentelemetry-operator.yaml
```

Verify operator health:

```bash
kubectl -n opentelemetry-operator-system get pods
# NAME                                     READY   STATUS    RESTARTS
# opentelemetry-operator-controller-...   2/2     Running   0
```

The operator manages two custom resources:
- `OpenTelemetryCollector` — declares a Collector deployment
- `Instrumentation` — declares auto-instrumentation configuration for workloads

---

## DaemonSet Agent Collector

### OpenTelemetryCollector Resource (DaemonSet)

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-agent
  namespace: monitoring
spec:
  mode: daemonset
  serviceAccount: otel-collector
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
  resources:
    requests:
      memory: 256Mi
      cpu: 100m
    limits:
      memory: 512Mi
      cpu: 500m
  env:
    - name: K8S_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: K8S_POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: K8S_POD_NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace
    - name: K8S_POD_IP
      valueFrom:
        fieldRef:
          fieldPath: status.podIP
  volumeMounts:
    - name: varlogpods
      mountPath: /var/log/pods
      readOnly: true
    - name: varlogcontainers
      mountPath: /var/log/containers
      readOnly: true
  volumes:
    - name: varlogpods
      hostPath:
        path: /var/log/pods
    - name: varlogcontainers
      hostPath:
        path: /var/log/containers
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

      prometheus:
        config:
          scrape_configs:
            - job_name: 'kubernetes-pods'
              kubernetes_sd_configs:
                - role: pod
                  selectors:
                    - role: pod
                      field: "spec.nodeName=${K8S_NODE_NAME}"
              relabel_configs:
                - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
                  action: keep
                  regex: true
                - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
                  action: replace
                  target_label: __metrics_path__
                  regex: (.+)
                - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
                  action: replace
                  regex: ([^:]+)(?::\d+)?;(\d+)
                  replacement: $$1:$$2
                  target_label: __address__
                - action: labelmap
                  regex: __meta_kubernetes_pod_label_(.+)
                - source_labels: [__meta_kubernetes_namespace]
                  action: replace
                  target_label: kubernetes_namespace
                - source_labels: [__meta_kubernetes_pod_name]
                  action: replace
                  target_label: kubernetes_pod_name

      filelog:
        include:
          - /var/log/pods/*/*/*.log
        exclude:
          - /var/log/pods/monitoring_*/*/*.log
        start_at: end
        include_file_path: true
        include_file_name: false
        operators:
          - type: router
            id: get-format
            routes:
              - output: parser-docker
                expr: 'body matches "^\\{"'
              - output: parser-crio
                expr: 'body matches "^[^ ]+ "'
          - type: json_parser
            id: parser-docker
            output: extract-metadata-from-filepath
            timestamp:
              parse_from: attributes.time
              layout: '%Y-%m-%dT%H:%M:%S.%LZ'
          - type: regex_parser
            id: parser-crio
            regex: '^(?P<time>[^ ]+) (?P<stream>stdout|stderr) (?P<logtag>[^ ]*) ?(?P<log>.*)$'
            output: extract-metadata-from-filepath
            timestamp:
              parse_from: attributes.time
              layout_type: gotime
              layout: '2006-01-02T15:04:05.999999999Z07:00'
          - type: move
            id: extract-metadata-from-filepath
            from: attributes["log.file.path"]
            to: resource["log.file.path"]
          - type: regex_parser
            id: parse-file-path
            parse_from: resource["log.file.path"]
            regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]+)\/(?P<container_name>[^\._]+)\/(?P<restart_count>\d+)\.log$'
            cache:
              size: 128
          - type: move
            from: attributes.log
            to: body
          - type: move
            from: attributes.stream
            to: attributes["log.iostream"]
          - type: move
            from: attributes.container_name
            to: resource["k8s.container.name"]
          - type: move
            from: attributes.namespace
            to: resource["k8s.namespace.name"]
          - type: move
            from: attributes.pod_name
            to: resource["k8s.pod.name"]
          - type: move
            from: attributes.restart_count
            to: resource["k8s.container.restart_count"]
          - type: move
            from: attributes.uid
            to: resource["k8s.pod.uid"]

    processors:
      memory_limiter:
        check_interval: 5s
        limit_percentage: 80
        spike_limit_percentage: 25

      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        filter:
          node_from_env_var: K8S_NODE_NAME
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
            - k8s.pod.start_time
            - container.image.name
            - container.image.tag
          labels:
            - tag_name: app
              key: app
              from: pod
            - tag_name: app.kubernetes.io/name
              key: app.kubernetes.io/name
              from: pod
            - tag_name: app.kubernetes.io/version
              key: app.kubernetes.io/version
              from: pod

      resource:
        attributes:
          - key: k8s.cluster.name
            value: production
            action: insert

      batch:
        send_batch_size: 8192
        send_batch_max_size: 16384
        timeout: 5s

    exporters:
      otlp/gateway:
        endpoint: otel-gateway-collector.monitoring.svc:4317
        tls:
          insecure: false
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        compression: gzip
        headers:
          X-Scope-OrgID: default

    service:
      telemetry:
        logs:
          level: info
        metrics:
          address: 0.0.0.0:8888
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp/gateway]
        metrics:
          receivers: [otlp, prometheus]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp/gateway]
        logs:
          receivers: [otlp, filelog]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp/gateway]
```

---

## Gateway Collector with Tail Sampling

### OpenTelemetryCollector Resource (Deployment Gateway)

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  mode: deployment
  replicas: 3
  serviceAccount: otel-collector
  resources:
    requests:
      memory: 1Gi
      cpu: 500m
    limits:
      memory: 4Gi
      cpu: "2"
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      memory_limiter:
        check_interval: 5s
        limit_percentage: 75
        spike_limit_percentage: 20

      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          # Always sample errors
          - name: errors-policy
            type: status_code
            status_code:
              status_codes: [ERROR]
          # Always sample slow requests
          - name: slow-requests-policy
            type: latency
            latency:
              threshold_ms: 1000
          # Sample 10% of all traffic
          - name: probabilistic-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 10
          # Always sample traces tagged as important
          - name: important-spans-policy
            type: string_attribute
            string_attribute:
              key: sampling.priority
              values:
                - "1"
                - "high"
          # Rate limiting by service — 100 traces/sec per service
          - name: rate-limiting-policy
            type: rate_limiting
            rate_limiting:
              spans_per_second: 1000
          # Composite policy: sample 100% for small services, 1% for high-volume
          - name: composite-policy
            type: composite
            composite:
              max_total_spans_per_second: 5000
              policy_order: [errors-policy, slow-requests-policy, important-spans-policy, probabilistic-policy]
              composite_sub_policy:
                - name: errors-policy
                  type: status_code
                  status_code:
                    status_codes: [ERROR]
                - name: slow-requests-policy
                  type: latency
                  latency:
                    threshold_ms: 1000
                - name: important-spans-policy
                  type: string_attribute
                  string_attribute:
                    key: sampling.priority
                    values:
                      - "1"
                - name: probabilistic-policy
                  type: probabilistic
                  probabilistic:
                    sampling_percentage: 1
              rate_allocation:
                - policy: errors-policy
                  percent: 50
                - policy: slow-requests-policy
                  percent: 30
                - policy: important-spans-policy
                  percent: 15
                - policy: probabilistic-policy
                  percent: 5

      batch:
        send_batch_size: 4096
        send_batch_max_size: 8192
        timeout: 5s

      transform/traces:
        trace_statements:
          - context: span
            statements:
              # Redact sensitive attributes before export
              - delete_key(attributes, "http.request.header.authorization")
              - delete_key(attributes, "db.statement") where attributes["db.sensitive"] == true
              # Normalize service names
              - set(resource.attributes["service.name"], "unknown") where resource.attributes["service.name"] == nil

    exporters:
      otlp/jaeger:
        endpoint: jaeger-collector.tracing.svc:4317
        tls:
          insecure: true
        compression: gzip

      otlp/tempo:
        endpoint: tempo-distributor.monitoring.svc:4317
        tls:
          insecure: true
        compression: gzip

      prometheusremotewrite:
        endpoint: http://thanos-receive.monitoring.svc:19291/api/v1/receive
        tls:
          insecure: true
        resource_to_telemetry_conversion:
          enabled: true
        add_metric_suffixes: false

      loki:
        endpoint: http://loki-distributor.logging.svc:3100/loki/api/v1/push
        default_labels_enabled:
          exporter: false
          job: true
          instance: true
          level: true
        labels:
          attributes:
            level: ""
            severity: ""
          resource:
            k8s.namespace.name: "namespace"
            k8s.pod.name: "pod"
            k8s.container.name: "container"
            service.name: "app"

      debug:
        verbosity: basic
        sampling_initial: 5
        sampling_thereafter: 200

    connectors:
      spanmetrics:
        namespace: traces
        histogram:
          explicit:
            buckets: [100us, 1ms, 2ms, 6ms, 10ms, 100ms, 250ms, 500ms, 1000ms, 1400ms, 2000ms, 5s, 10s, 15s]
        dimensions:
          - name: http.method
            default: GET
          - name: http.status_code
          - name: http.route
          - name: service.name
          - name: db.system
        exemplars:
          enabled: true
        metrics_expiration: 5m

    service:
      telemetry:
        logs:
          level: info
        metrics:
          address: 0.0.0.0:8888
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, tail_sampling, transform/traces, batch]
          exporters: [otlp/jaeger, spanmetrics]
        traces/metrics:
          receivers: [spanmetrics]
          processors: [batch]
          exporters: [prometheusremotewrite]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [prometheusremotewrite]
        logs:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [loki]
```

---

## RBAC for Kubernetes Attributes Processor

The k8sattributes processor calls the Kubernetes API to enrich spans with pod metadata. The service account needs read permissions on pods, namespaces, replicasets, deployments, statefulsets, daemonsets, jobs, and cronjobs:

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
  - apiGroups: [""]
    resources: ["pods", "namespaces", "nodes"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["extensions"]
    resources: ["replicasets"]
    verbs: ["get", "watch", "list"]
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

---

## Auto-Instrumentation with OTel Operator

### Instrumentation Resource

The `Instrumentation` CRD configures auto-instrumentation for workloads via pod annotation injection. The operator injects an init container that installs the language-specific OTel SDK:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: production-instrumentation
  namespace: monitoring
spec:
  exporter:
    endpoint: http://otel-agent-collector.monitoring.svc:4318

  propagators:
    - tracecontext
    - baggage
    - b3

  sampler:
    type: parentbased_traceidratio
    argument: "0.1"   # 10% head-based sampling before tail sampling

  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.33.3
    env:
      - name: OTEL_EXPORTER_OTLP_TIMEOUT
        value: "20"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 128Mi

  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.45b0
    env:
      - name: OTEL_EXPORTER_OTLP_TIMEOUT
        value: "20"

  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.50.0
    env:
      - name: OTEL_EXPORTER_OTLP_TIMEOUT
        value: "20"

  dotnet:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-dotnet:1.7.0

  go:
    # Go auto-instrumentation uses eBPF — requires privileged container
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.14.0-alpha
```

### Enabling Auto-Instrumentation via Annotations

Add annotations to workloads to trigger injection:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-java-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-java: "monitoring/production-instrumentation"
        # For Python:
        # instrumentation.opentelemetry.io/inject-python: "monitoring/production-instrumentation"
        # For Node.js:
        # instrumentation.opentelemetry.io/inject-nodejs: "monitoring/production-instrumentation"
```

The operator mutates the pod spec at admission time, adding:
- An init container that copies the agent to a shared volume
- `JAVA_TOOL_OPTIONS` environment variable pointing to the agent JAR
- OTLP endpoint environment variables
- Resource attribute environment variables (service name, namespace, pod name)

---

## Processors Reference

### Memory Limiter (Required)

The memory_limiter processor is mandatory in production deployments. Without it, a traffic spike can cause the Collector to OOM:

```yaml
processors:
  memory_limiter:
    check_interval: 5s          # How often to check memory usage
    limit_percentage: 80        # Soft limit — begin refusing data
    spike_limit_percentage: 25  # Additional headroom for spikes
```

When the soft limit is reached, the processor returns a `ResourceExhausted` gRPC error to receivers, triggering backpressure in the SDK.

### Batch Processor

```yaml
processors:
  batch:
    send_batch_size: 8192       # Trigger export when this many spans accumulate
    send_batch_max_size: 16384  # Hard cap on batch size
    timeout: 5s                 # Export even if batch_size not reached
```

Larger batches improve compression efficiency and reduce per-request overhead, but increase latency. For latency-sensitive trace pipelines, reduce `timeout` to 1-2s.

### Resource Detection Processor

```yaml
processors:
  resourcedetection:
    detectors:
      - env           # Read OTEL_RESOURCE_ATTRIBUTES from environment
      - system        # Hostname, OS
      - docker        # Container ID
      - k8snode       # Kubernetes node attributes
      - eks           # AWS EKS cluster name
      - gke           # GKE cluster name
    timeout: 5s
    override: false
```

### Attributes Processor

```yaml
processors:
  attributes/sanitize:
    actions:
      - key: http.url
        action: update
        # Remove query parameters from URLs to reduce cardinality
        pattern: '^(https?://[^?]+).*$'
        from_attribute: http.url
      - key: sensitive.header
        action: delete
      - key: environment
        value: production
        action: insert
```

---

## Span Metrics Connector

The `spanmetrics` connector converts trace data into Prometheus-compatible metrics, enabling RED (Rate, Errors, Duration) metrics without any application-side changes:

```yaml
connectors:
  spanmetrics:
    namespace: traces
    histogram:
      explicit:
        buckets: [1ms, 5ms, 10ms, 50ms, 100ms, 500ms, 1s, 5s]
    dimensions:
      - name: service.name
      - name: span.name
      - name: http.method
      - name: http.status_code
      - name: db.system
    exemplars:
      enabled: true
    events:
      enabled: true
      dimensions:
        - name: exception.type
        - name: exception.message
```

The connector emits three metric families:
- `traces_span_metrics_calls_total` — request rate counter
- `traces_span_metrics_duration_milliseconds` — latency histogram
- `traces_span_metrics_size_bytes` — payload size histogram

---

## Prometheus Scraping via OTel Collector

The Collector can replace Prometheus scraping entirely or complement it. This is useful when you want all telemetry routed through a single pipeline:

```yaml
receivers:
  prometheus:
    config:
      global:
        scrape_interval: 15s
        scrape_timeout: 10s
      scrape_configs:
        - job_name: 'kube-state-metrics'
          static_configs:
            - targets: ['kube-state-metrics.kube-system.svc:8080']
        - job_name: 'node-exporter'
          kubernetes_sd_configs:
            - role: node
          relabel_configs:
            - action: labelmap
              regex: __meta_kubernetes_node_label_(.+)
            - target_label: __address__
              replacement: kubernetes.default.svc:443
            - source_labels: [__meta_kubernetes_node_name]
              regex: (.+)
              target_label: __metrics_path__
              replacement: /api/v1/nodes/$${1}/proxy/metrics
          scheme: https
          tls_config:
            ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
          authorization:
            credentials_file: /var/run/secrets/kubernetes.io/serviceaccount/token
```

---

## Production Network Policy

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: otel-collector-agent
  namespace: monitoring
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: otel-agent-collector
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - ports:
        - protocol: TCP
          port: 4317   # OTLP gRPC
        - protocol: TCP
          port: 4318   # OTLP HTTP
        - protocol: TCP
          port: 8888   # Collector internal metrics
  egress:
    # Forward to gateway
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: otel-gateway-collector
      ports:
        - protocol: TCP
          port: 4317
    # Kubernetes API for k8sattributes
    - to: []
      ports:
        - protocol: TCP
          port: 443
    # DNS
    - to: []
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
```

---

## Monitoring the Collector

### Collector Self-Metrics

The Collector exposes Prometheus metrics on port 8888 by default:

```bash
# Key metrics to monitor
otelcol_receiver_accepted_spans        # Spans successfully received
otelcol_receiver_refused_spans         # Spans refused (backpressure)
otelcol_exporter_sent_spans            # Spans sent to exporters
otelcol_exporter_failed_spans          # Spans failed to export
otelcol_processor_batch_batch_size_trigger_send  # Batch exports
otelcol_process_memory_rss             # Collector RSS memory
otelcol_process_cpu_seconds            # Collector CPU usage
```

### Alerting Rules

```yaml
groups:
  - name: otel-collector
    rules:
      - alert: OTelCollectorHighDropRate
        expr: |
          rate(otelcol_receiver_refused_spans[5m]) /
          rate(otelcol_receiver_accepted_spans[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "OTel Collector refusing more than 5% of spans"

      - alert: OTelCollectorExporterFailures
        expr: rate(otelcol_exporter_failed_spans[5m]) > 100
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "OTel Collector exporter failures above 100/sec"

      - alert: OTelCollectorHighMemory
        expr: |
          otelcol_process_memory_rss /
          (otelcol_process_memory_rss + 1) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "OTel Collector memory usage above 85%"
```

---

## Operational Runbook

### Debugging Pipeline Issues

```bash
# Enable debug exporter temporarily
kubectl -n monitoring patch opentelemetrycollector otel-gateway \
  --type='json' \
  -p='[{"op": "add", "path": "/spec/config", "value": "...add debug exporter..."}]'

# Check Collector logs for pipeline errors
kubectl -n monitoring logs -l app.kubernetes.io/name=otel-gateway-collector \
  --tail=100 | grep -i "error\|refused\|failed"

# Check Collector internal metrics
kubectl -n monitoring port-forward svc/otel-gateway-collector-monitoring 8888:8888
curl -s http://localhost:8888/metrics | grep otelcol_exporter_failed
```

### Scaling the Gateway

The tail_sampling processor requires all spans from a single trace to reach the same Collector instance. When scaling beyond a single gateway replica, a load balancing exporter must be used in the agent to hash traces to gateway instances:

```yaml
exporters:
  loadbalancing:
    routing_key: traceID
    protocol:
      otlp:
        tls:
          insecure: true
        timeout: 5s
    resolver:
      k8s:
        service: otel-gateway-collector.monitoring.svc
        ports:
          - 4317
```

With load balancing, all spans from a given trace ID will route to the same gateway replica, enabling correct tail sampling decisions.

---

## Summary

The OpenTelemetry Collector provides a vendor-neutral, production-hardened telemetry pipeline that handles traces, metrics, and logs through a unified configuration model. On Kubernetes, the DaemonSet plus gateway topology provides node-local OTLP collection, Kubernetes metadata enrichment, and centralized tail sampling with fan-out to multiple observability backends. The OTel Operator simplifies both Collector lifecycle management and application auto-instrumentation through Kubernetes-native custom resources, reducing the instrumentation barrier for development teams working across multiple languages.
