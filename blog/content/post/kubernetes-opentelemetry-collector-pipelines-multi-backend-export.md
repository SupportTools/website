---
title: "Kubernetes OpenTelemetry Collector: Data Collection, Processing Pipelines, and Multi-Backend Export"
date: 2031-08-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenTelemetry", "Observability", "Tracing", "Metrics", "Collector"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying and configuring the OpenTelemetry Collector on Kubernetes, including receivers, processors, exporters, multi-backend routing, and production-grade pipeline design."
more_link: "yes"
url: "/kubernetes-opentelemetry-collector-pipelines-multi-backend-export/"
---

The OpenTelemetry Collector is the observability data plane for modern cloud-native environments. It receives telemetry data in multiple formats, processes and enriches it, and exports to one or more backends simultaneously. This post covers a production-grade Collector deployment on Kubernetes with trace, metric, and log pipelines, multi-backend routing, and operational best practices.

<!--more-->

# Kubernetes OpenTelemetry Collector: Data Collection, Processing Pipelines, and Multi-Backend Export

## Overview

The OpenTelemetry Collector sits between your instrumented applications and your observability backends:

```
Applications         Collector                    Backends
───────────         ──────────                   ────────
App (OTLP)  ──────▶  Receivers   ──┐
App (Jaeger) ─────▶  (ingress)     │
Node metrics  ─────▶  Processors ──┼──▶ Exporters ──▶ Tempo
  (hostmetrics)       (transform)  │                 ──▶ Prometheus
Kubernetes logs ───▶  (filter)     │                 ──▶ Loki
  (filelog)           (batch)      │                 ──▶ Elastic
                      (memory)   ──┘                 ──▶ Datadog
```

The Collector supports three deployment patterns:

| Pattern | Use Case | Kubernetes Implementation |
|---------|----------|--------------------------|
| Agent | Per-node collection | DaemonSet |
| Gateway | Central aggregation/routing | Deployment |
| Sidecar | Per-pod collection | Sidecar injection |

This guide implements a **tiered architecture**: DaemonSet agents collect local telemetry and forward to a Gateway deployment that handles enrichment, routing, and export to multiple backends.

---

## Section 1: OpenTelemetry Operator Installation

The OpenTelemetry Operator manages Collector deployments and auto-instrumentation injection:

```bash
# Install cert-manager (required by operator)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=120s

# Install OpenTelemetry Operator
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/latest/download/opentelemetry-operator.yaml

# Verify installation
kubectl wait --for=condition=Available deployment/opentelemetry-operator-controller-manager \
  -n opentelemetry-operator-system --timeout=120s

kubectl get crd | grep opentelemetry
# opentelemetrycollectors.opentelemetry.io
# instrumentations.opentelemetry.io
```

### 1.1 Helm Installation (Preferred for Production)

```yaml
# otel-operator-values.yaml
manager:
  collectorImage:
    repository: otel/opentelemetry-collector-contrib
    tag: "0.100.0"

admissionWebhooks:
  enabled: true
  certManager:
    enabled: true

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 200m
    memory: 256Mi
```

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

helm upgrade --install opentelemetry-operator \
  open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --values otel-operator-values.yaml
```

---

## Section 2: DaemonSet Agent Configuration

The agent DaemonSet runs on every node and collects:
- Host metrics (CPU, memory, disk, network)
- Kubernetes node/pod/container metrics
- Node-level log files
- OTLP telemetry from local pods

### 2.1 Agent ConfigMap

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-agent
  namespace: monitoring
spec:
  mode: daemonset

  image: otel/opentelemetry-collector-contrib:0.100.0

  serviceAccount: otel-agent

  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

  tolerations:
    - operator: Exists  # Run on all nodes including masters

  volumes:
    - name: varlog
      hostPath:
        path: /var/log
    - name: varlibdockercontainers
      hostPath:
        path: /var/lib/docker/containers

  volumeMounts:
    - mountPath: /var/log
      name: varlog
      readOnly: true
    - mountPath: /var/lib/docker/containers
      name: varlibdockercontainers
      readOnly: true

  env:
    - name: K8S_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: K8S_POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: K8S_NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace

  config: |
    receivers:
      # Receive OTLP from applications on this node
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

      # Host metrics from the node
      hostmetrics:
        collection_interval: 30s
        scrapers:
          cpu:
            metrics:
              system.cpu.utilization:
                enabled: true
          disk: {}
          filesystem: {}
          load: {}
          memory:
            metrics:
              system.memory.utilization:
                enabled: true
          network: {}
          paging: {}
          processes: {}

      # Kubernetes node metrics
      kubeletstats:
        collection_interval: 30s
        auth_type: serviceAccount
        endpoint: https://${K8S_NODE_NAME}:10250
        insecure_skip_verify: true
        extra_metadata_labels:
          - container.id
        metric_groups:
          - node
          - pod
          - container
          - volume

      # Container log collection
      filelog:
        include:
          - /var/log/pods/*/*/*.log
        start_at: end
        include_file_path: true
        include_file_name: false
        operators:
          - type: router
            id: get-format
            routes:
              - output: parser-docker
                expr: 'body matches "^\\{"'
              - output: parser-cri
                expr: 'true'
          - type: json_parser
            id: parser-docker
            output: extract-metadata-from-filepath
          - type: regex_parser
            id: parser-cri
            regex: '^(?P<time>[^ ^Z]+Z) (?P<stream>stdout|stderr) (?P<logtag>[^ ]*) ?(?P<log>.*)$'
            output: extract-metadata-from-filepath
            timestamp:
              parse_from: attributes.time
              layout: '%Y-%m-%dT%H:%M:%S.%LZ'
          - type: regex_parser
            id: extract-metadata-from-filepath
            regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]{36})\/(?P<container_name>[^\._]+)\/(?P<restart_count>\d+)\.log$'
            parse_from: attributes["log.file.path"]
            cache:
              size: 128
          - type: move
            from: attributes.log
            to: body
          - type: remove
            field: attributes.time
          - type: remove
            field: attributes.stream
          - type: remove
            field: attributes.logtag

    processors:
      # Add Kubernetes metadata to all telemetry
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
            - k8s.container.name
            - container.image.name
            - container.image.tag
          labels:
            - tag_name: app
              key: app.kubernetes.io/name
              from: pod
            - tag_name: version
              key: app.kubernetes.io/version
              from: pod
          annotations:
            - tag_name: team
              key: team
              from: namespace

      # Add resource attributes
      resource:
        attributes:
          - action: insert
            key: k8s.node.name
            value: ${K8S_NODE_NAME}
          - action: insert
            key: deployment.environment
            from_attribute: k8s.namespace.name

      # Memory limiter to prevent OOM
      memory_limiter:
        check_interval: 5s
        limit_percentage: 80
        spike_limit_percentage: 20

      # Batch for efficiency
      batch:
        send_batch_size: 1000
        timeout: 5s
        send_batch_max_size: 2000

      # Filter out noisy health check logs
      filter/healthchecks:
        logs:
          exclude:
            match_type: regexp
            bodies:
              - "GET /health"
              - "GET /readyz"
              - "GET /livez"
              - "GET /metrics"

    exporters:
      # Forward to gateway collector
      otlp/gateway:
        endpoint: otel-gateway-collector.monitoring.svc.cluster.local:4317
        tls:
          insecure: false
          ca_file: /etc/ssl/certs/ca-certificates.crt
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 300s
        sending_queue:
          enabled: true
          num_consumers: 4
          queue_size: 1000

      # Debug output (disable in production)
      debug:
        verbosity: basic

    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      pprof:
        endpoint: 0.0.0.0:1777
      zpages:
        endpoint: 0.0.0.0:55679

    service:
      extensions: [health_check, pprof, zpages]

      pipelines:
        traces:
          receivers: [otlp]
          processors: [k8sattributes, resource, memory_limiter, batch]
          exporters: [otlp/gateway]

        metrics:
          receivers: [otlp, hostmetrics, kubeletstats]
          processors: [k8sattributes, resource, memory_limiter, batch]
          exporters: [otlp/gateway]

        logs:
          receivers: [otlp, filelog]
          processors: [k8sattributes, resource, filter/healthchecks, memory_limiter, batch]
          exporters: [otlp/gateway]
```

---

## Section 3: Gateway Collector Configuration

The gateway handles enrichment, routing, and multi-backend export:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  mode: deployment
  replicas: 3

  image: otel/opentelemetry-collector-contrib:0.100.0

  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi

  autoscaler:
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilization: 60

  env:
    - name: PROMETHEUS_ENDPOINT
      value: http://prometheus.monitoring.svc.cluster.local:9090
    - name: TEMPO_ENDPOINT
      value: tempo-distributor.monitoring.svc.cluster.local:4317
    - name: LOKI_ENDPOINT
      value: http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push

  config: |
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
        check_interval: 5s
        limit_percentage: 75
        spike_limit_percentage: 15

      batch:
        send_batch_size: 2000
        timeout: 5s
        send_batch_max_size: 4000

      # Enrich traces with additional attributes
      attributes/traces:
        actions:
          - action: insert
            key: telemetry.sdk.name
            value: opentelemetry
          - action: insert
            key: collector.version
            value: "0.100.0"

      # Transform: normalize service names
      transform/normalize:
        error_mode: ignore
        trace_statements:
          - context: resource
            statements:
              - set(attributes["service.name"], Concat([attributes["k8s.deployment.name"]], "")) where attributes["service.name"] == nil
        metric_statements:
          - context: resource
            statements:
              - set(attributes["service.name"], attributes["k8s.deployment.name"]) where attributes["service.name"] == nil
        log_statements:
          - context: resource
            statements:
              - set(attributes["service.name"], attributes["k8s.deployment.name"]) where attributes["service.name"] == nil

      # Filter: drop debug-level spans in production
      filter/production:
        error_mode: ignore
        traces:
          span:
            - 'attributes["http.url"] == "/health"'
            - 'attributes["http.route"] == "/readyz"'

      # Probabilistic sampling for high-volume services
      probabilistic_sampler:
        hash_seed: 22
        sampling_percentage: 10

      # Tail-based sampling: always sample errors and slow requests
      tail_sampling:
        decision_wait: 30s
        num_traces: 50000
        expected_new_traces_per_sec: 1000
        policies:
          - name: errors-policy
            type: status_code
            status_code:
              status_codes: [ERROR]
          - name: slow-traces-policy
            type: latency
            latency:
              threshold_ms: 1000
          - name: sample-10-percent
            type: probabilistic
            probabilistic:
              sampling_percentage: 10

      # Metric aggregation: convert histograms to summaries
      metricstransform:
        transforms:
          - include: http.server.request.duration
            action: insert
            new_name: http.server.request.duration.p99
            operations:
              - action: aggregate_labels
                label_set: [service.name, http.method, http.status_code]
                aggregation_type: max

      # Routing based on attributes
      routing:
        default_exporters: [otlp/tempo, prometheusremotewrite]
        error_mode: ignore
        table:
          - statement: route() where attributes["deployment.environment"] == "production"
            exporters: [otlp/tempo, prometheusremotewrite, otlp/elastic]
          - statement: route() where attributes["k8s.namespace.name"] == "security"
            exporters: [otlp/splunk]

    exporters:
      # Grafana Tempo for traces
      otlp/tempo:
        endpoint: ${TEMPO_ENDPOINT}
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
        sending_queue:
          enabled: true
          num_consumers: 4
          queue_size: 5000

      # Prometheus remote write for metrics
      prometheusremotewrite:
        endpoint: http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
        add_metric_suffixes: false
        resource_to_telemetry_conversion:
          enabled: true

      # Prometheus exporter (scrape-based)
      prometheus:
        endpoint: 0.0.0.0:8889
        namespace: otelcol
        send_timestamps: true
        metric_expiration: 180m

      # Loki for logs
      loki:
        endpoint: ${LOKI_ENDPOINT}
        tls:
          insecure: true
        default_labels_enabled:
          exporter: false
          job: true
          instance: true
          level: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
        sending_queue:
          enabled: true
          queue_size: 2000

      # Elastic APM (optional secondary backend)
      otlp/elastic:
        endpoint: apm-server.elastic.svc.cluster.local:8200
        headers:
          Authorization: "Bearer <elastic-apm-secret-token>"
        tls:
          insecure: true

      # Splunk for security-sensitive namespaces
      splunk_hec/security:
        endpoint: https://splunk.internal.yourcompany.com:8088/services/collector
        token: <splunk-hec-token>
        source: kubernetes
        sourcetype: otel
        index: k8s_security

      # Debug (disable in production)
      debug:
        verbosity: basic

    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      pprof:
        endpoint: 0.0.0.0:1777

    service:
      extensions: [health_check, pprof]

      telemetry:
        logs:
          level: info
        metrics:
          level: detailed
          address: 0.0.0.0:8888

      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, attributes/traces, transform/normalize,
                       filter/production, tail_sampling, batch]
          exporters: [otlp/tempo, debug]

        metrics:
          receivers: [otlp]
          processors: [memory_limiter, transform/normalize,
                       metricstransform, batch]
          exporters: [prometheusremotewrite, prometheus]

        logs:
          receivers: [otlp]
          processors: [memory_limiter, transform/normalize, batch]
          exporters: [loki]
```

---

## Section 4: RBAC and Service Accounts

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-agent
  namespace: monitoring

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-agent
rules:
  # kubeletstats receiver needs access to pod metadata
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/proxy
      - nodes/stats
      - services
      - endpoints
      - pods
      - replicationcontrollers
      - resourcequotas
    verbs: ["get", "list", "watch"]
  # k8sattributes processor needs access to pod/namespace metadata
  - apiGroups: ["apps"]
    resources:
      - daemonsets
      - deployments
      - replicasets
      - statefulsets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["get", "list", "watch"]
  - nonResourceURLs:
      - "/metrics"
    verbs: ["get"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-agent
subjects:
  - kind: ServiceAccount
    name: otel-agent
    namespace: monitoring
roleRef:
  kind: ClusterRole
  name: otel-agent
  apiGroup: rbac.authorization.k8s.io
```

---

## Section 5: Auto-Instrumentation

The OpenTelemetry Operator can automatically inject instrumentation into pods:

### 5.1 Instrumentation Resource

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: auto-instrumentation
  namespace: monitoring
spec:
  # Propagator configuration
  propagators:
    - tracecontext
    - baggage
    - b3

  sampler:
    type: parentbased_traceidratio
    argument: "0.10"  # 10% sampling rate

  # Java auto-instrumentation
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:latest
    env:
      - name: OTEL_EXPORTER_OTLP_ENDPOINT
        value: http://otel-agent-collector.monitoring.svc.cluster.local:4317
      - name: OTEL_RESOURCE_ATTRIBUTES
        value: "deployment.environment=$(NAMESPACE)"
    volumeLimitSize: 200Mi

  # Python auto-instrumentation
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:latest
    env:
      - name: OTEL_EXPORTER_OTLP_ENDPOINT
        value: http://otel-agent-collector.monitoring.svc.cluster.local:4318
      - name: OTEL_EXPORTER_OTLP_PROTOCOL
        value: http/protobuf

  # Node.js auto-instrumentation
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:latest
    env:
      - name: OTEL_EXPORTER_OTLP_ENDPOINT
        value: http://otel-agent-collector.monitoring.svc.cluster.local:4317

  # Go auto-instrumentation (eBPF-based, no code changes needed)
  go:
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:latest
    env:
      - name: OTEL_EXPORTER_OTLP_ENDPOINT
        value: http://otel-agent-collector.monitoring.svc.cluster.local:4317
```

### 5.2 Enabling Auto-Instrumentation on Pods

```yaml
# Apply annotation to namespace for all pods
apiVersion: v1
kind: Namespace
metadata:
  name: production
  annotations:
    instrumentation.opentelemetry.io/inject-java: "monitoring/auto-instrumentation"

---
# Or apply to individual deployments
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-java: "monitoring/auto-instrumentation"
    spec:
      containers:
        - name: payment-service
          image: yourorg/payment-service:v1.0.0
```

---

## Section 6: Advanced Processor Patterns

### 6.1 Span Enrichment with Span Processor

```yaml
processors:
  # Add SLO tier based on service name
  transform/slo-tier:
    error_mode: ignore
    trace_statements:
      - context: resource
        statements:
          - set(attributes["slo.tier"], "critical") where attributes["service.name"] == "payment-service"
          - set(attributes["slo.tier"], "critical") where attributes["service.name"] == "auth-service"
          - set(attributes["slo.tier"], "standard") where attributes["slo.tier"] == nil

  # Extract custom span attributes for indexing
  transform/extract-user:
    error_mode: ignore
    trace_statements:
      - context: span
        statements:
          - set(attributes["user.tier"], attributes["http.request.header.x-user-tier"])
          - delete_key(attributes, "http.request.header.x-user-tier")

  # Redact PII from spans
  redaction:
    allow_all_keys: false
    allowed_keys:
      - description
      - group_id
      - message
      - status
    blocked_values:
      - "[0-9]{16}"  # credit card numbers
      - "\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b"  # email addresses
    summary: debug
```

### 6.2 Metric Transformation

```yaml
processors:
  # Rename metrics from Prometheus scrape to OTLP convention
  metricstransform/rename:
    transforms:
      - include: "^(go_|process_)"
        match_type: regexp
        action: update
        operations:
          - action: add_label
            new_label: instrumentation
            new_value: prometheus

      # Aggregate high-cardinality histograms
      - include: http_request_duration_seconds
        match_type: strict
        action: update
        operations:
          - action: aggregate_labels
            label_set: [handler, method, status_code]
            aggregation_type: sum

  # Convert delta metrics to cumulative
  cumulativetodelta:
    include:
      metrics:
        - system.cpu.time
      match_type: strict

  # Add computed metrics
  metricsgeneration:
    rules:
      - name: http.server.request.rate
        unit: 1/s
        type: rate
        metric1: http.server.request.count
      - name: http.server.error.rate
        unit: 1/s
        type: rate
        metric1: http.server.error.count
```

---

## Section 7: Sampling Strategies

### 7.1 Tail-Based Sampling for Production

Tail-based sampling examines complete traces before deciding to sample or drop:

```yaml
processors:
  tail_sampling:
    decision_wait: 30s       # Wait for all spans in a trace
    num_traces: 100000       # In-memory trace buffer size
    expected_new_traces_per_sec: 5000

    policies:
      # Always sample errors
      - name: always-sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Always sample slow requests
      - name: slow-requests
        type: latency
        latency:
          threshold_ms: 2000

      # Always sample specific services
      - name: payment-traces
        type: string_attribute
        string_attribute:
          key: service.name
          values:
            - payment-service
            - fraud-detection

      # Sample 1% of healthy fast traces
      - name: standard-sample
        type: probabilistic
        probabilistic:
          sampling_percentage: 1

      # Composite: always sample if any critical policy matches
      - name: critical-composite
        type: composite
        composite:
          max_total_spans_per_second: 10000
          policy_order: [always-sample-errors, payment-traces, standard-sample]
          rate_allocation:
            - policy: always-sample-errors
              percent: 50
            - policy: payment-traces
              percent: 30
            - policy: standard-sample
              percent: 20
```

### 7.2 Load Balancing Across Gateway Instances

When running multiple gateway instances with tail sampling, all spans of the same trace must reach the same instance:

```yaml
exporters:
  # Load-balance to specific gateway instance based on trace ID
  loadbalancing:
    protocol:
      otlp:
        tls:
          insecure: true
    resolver:
      k8s:
        service: otel-gateway-collector-headless.monitoring
        ports:
          - 4317
    routing_key: traceID  # Ensures same trace goes to same instance
```

---

## Section 8: Monitoring the Collector

### 8.1 Collector Self-Metrics

```yaml
# The Collector exposes its own Prometheus metrics on :8888
# Add a ServiceMonitor to scrape them
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: otel-collector-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: otel-gateway-collector
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
```

Key Collector metrics to monitor:

```promql
# Exporter queue utilization
otelcol_exporter_queue_size / otelcol_exporter_queue_capacity

# Drop rate (data being dropped due to full queue)
rate(otelcol_exporter_enqueue_failed_spans_total[5m])
rate(otelcol_exporter_enqueue_failed_metric_points_total[5m])
rate(otelcol_exporter_enqueue_failed_log_records_total[5m])

# Export failure rate
rate(otelcol_exporter_send_failed_spans_total[5m])

# Receiver acceptance rate
rate(otelcol_receiver_accepted_spans_total[5m])

# Processor dropped data
rate(otelcol_processor_dropped_spans_total[5m])

# Memory usage
container_memory_working_set_bytes{pod=~"otel-.*"}
```

### 8.2 Alerting Rules

```yaml
groups:
  - name: otel-collector
    rules:
      - alert: OTelCollectorExporterQueueHigh
        expr: |
          otelcol_exporter_queue_size / otelcol_exporter_queue_capacity > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "OTel Collector exporter queue nearly full"
          description: "{{ $labels.exporter }} queue is {{ $value | humanizePercentage }} full"

      - alert: OTelCollectorDropping
        expr: |
          rate(otelcol_processor_dropped_spans_total[5m]) > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "OTel Collector is dropping spans"
          description: "{{ $labels.processor }} is dropping {{ $value }} spans/s"

      - alert: OTelCollectorExportFailed
        expr: |
          rate(otelcol_exporter_send_failed_spans_total[5m]) > 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "OTel Collector export failing"
          description: "{{ $labels.exporter }} is failing {{ $value }} spans/s"
```

---

## Section 9: Troubleshooting Common Issues

### 9.1 zpages Debug Interface

The zpages extension provides an HTTP debug interface:

```bash
# Port forward to the agent
kubectl port-forward -n monitoring ds/otel-agent-collector 55679

# Access debug pages
curl http://localhost:55679/debug/tracez      # Active traces
curl http://localhost:55679/debug/pipelinez   # Pipeline stats
curl http://localhost:55679/debug/extensionz  # Extension status
curl http://localhost:55679/debug/servicez    # Service info
```

### 9.2 Common Configuration Errors

```bash
# Validate Collector configuration without running
docker run --rm \
  -v $(pwd)/collector-config.yaml:/etc/otelcol/config.yaml \
  otel/opentelemetry-collector-contrib:0.100.0 \
  validate --config /etc/otelcol/config.yaml

# Check Collector logs for configuration errors
kubectl logs -n monitoring -l app.kubernetes.io/name=otel-gateway-collector \
  --tail=100 | grep -E "error|warn"

# Check if data is flowing through pipelines
kubectl exec -n monitoring \
  $(kubectl get pod -n monitoring -l app.kubernetes.io/name=otel-gateway-collector -o jsonpath='{.items[0].metadata.name}') \
  -- curl -s http://localhost:8888/metrics | grep otelcol_receiver_accepted
```

### 9.3 Performance Tuning

```yaml
# For high-throughput environments
processors:
  batch:
    send_batch_size: 5000
    timeout: 2s
    send_batch_max_size: 10000

  memory_limiter:
    check_interval: 1s
    limit_mib: 1500
    spike_limit_mib: 400

exporters:
  otlp/tempo:
    sending_queue:
      enabled: true
      num_consumers: 10  # Increase parallelism
      queue_size: 10000
    retry_on_failure:
      enabled: true
      max_elapsed_time: 120s
```

---

## Summary

The OpenTelemetry Collector is the backbone of a cloud-native observability strategy. Key design principles for production deployments:

1. **Tiered architecture** — DaemonSet agents collect locally, Gateway handles enrichment and routing
2. **Tail-based sampling** — makes smarter sampling decisions than head-based, always captures errors and slow traces
3. **Multi-backend export** — route different data to different backends without application changes
4. **Memory limiter first** — always place memory_limiter early in the pipeline to prevent OOM
5. **Batch processor last** — batch just before export for maximum efficiency
6. **Queue all exports** — all exporters should have sending_queue enabled for resilience
7. **Monitor the monitor** — use ServiceMonitor to scrape Collector self-metrics and alert on drops
8. **Auto-instrumentation** — use the Operator's Instrumentation resource to add OTLP to existing services without code changes

The combination of these patterns creates an observability pipeline that can handle enterprise-scale telemetry while providing the flexibility to route data to multiple specialized backends.
