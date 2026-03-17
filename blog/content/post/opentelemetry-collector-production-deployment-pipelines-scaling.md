---
title: "OpenTelemetry Collector: Production Deployment, Pipelines, and Scaling Strategies"
date: 2030-08-05T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Observability", "Kubernetes", "Monitoring", "Tracing", "Metrics", "OTel Collector"]
categories:
- Observability
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise OpenTelemetry Collector guide: receiver/processor/exporter pipeline design, Kubernetes deployment patterns (DaemonSet vs Deployment), tail sampling, attribute enrichment, fanout routing, and scaling collectors for high-volume telemetry."
more_link: "yes"
url: "/opentelemetry-collector-production-deployment-pipelines-scaling/"
---

The OpenTelemetry Collector occupies a critical position in modern observability architectures: it receives telemetry from instrumented applications, transforms and enriches it, and routes it to one or more backend systems. Getting the Collector right—in terms of pipeline design, resource allocation, and scaling strategy—directly determines observability reliability and cost at scale.

<!--more-->

## Overview

This guide covers the OpenTelemetry Collector from first principles through enterprise-scale production deployments: pipeline composition, processor selection, tail-based sampling, Kubernetes deployment topologies, and horizontal scaling with the Collector Operator.

## Collector Architecture Fundamentals

The Collector is organized around a pipeline model: telemetry flows through a linear sequence of receivers → processors → exporters, with each stage performing a specific function.

```
┌─────────────────────────────────────────────────────────────┐
│                    OTel Collector                           │
│                                                             │
│  Receivers           Processors           Exporters         │
│  ┌──────────┐       ┌───────────┐       ┌──────────────┐   │
│  │ OTLP     │──────▶│ memory    │──────▶│ OTLP (Tempo) │   │
│  │ gRPC     │       │ limiter   │       └──────────────┘   │
│  └──────────┘       └───────────┘                          │
│  ┌──────────┐       ┌───────────┐       ┌──────────────┐   │
│  │ Prometheus│──────▶│ batch     │──────▶│ Prometheus   │   │
│  │ scrape   │       │ processor │       │ Remote Write │   │
│  └──────────┘       └───────────┘       └──────────────┘   │
│  ┌──────────┐       ┌───────────┐       ┌──────────────┐   │
│  │ Filelog  │──────▶│ resource  │──────▶│ Loki         │   │
│  │          │       │ detection │       └──────────────┘   │
│  └──────────┘       └───────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

## Core Configuration Structure

```yaml
# otel-collector-config.yaml

# Extensions provide non-pipeline features (health check, pprof, etc.)
extensions:
  health_check:
    endpoint: "0.0.0.0:13133"
    path: "/health/status"
    check_collector_pipeline:
      enabled: true
      interval: "5m"
      exporter_failure_threshold: 5

  pprof:
    endpoint: "0.0.0.0:1777"

  zpages:
    endpoint: "0.0.0.0:55679"

  memory_ballast:
    # Set to 1/3 to 1/2 of container memory limit
    size_mib: 683

# Receivers define how telemetry enters the collector
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"
        max_recv_msg_size_mib: 4
        keepalive:
          server_parameters:
            max_connection_idle: 11s
            max_connection_age: 12s
            max_connection_age_grace: 5s
            time: 30s
            timeout: 5s
      http:
        endpoint: "0.0.0.0:4318"
        max_request_body_size: 4194304
        cors:
          allowed_origins:
          - "https://*.support.tools"

  prometheus:
    config:
      scrape_configs:
      - job_name: "kubernetes-pods"
        kubernetes_sd_configs:
        - role: pod
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: "true"
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
          action: replace
          target_label: __metrics_path__
          regex: (.+)
        - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
          action: replace
          regex: ([^:]+)(?::\d+)?;(\d+)
          replacement: $1:$2
          target_label: __address__

  filelog:
    include:
    - /var/log/pods/*/*/*.log
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
        expr: 'body matches "^[^ Z]+ "'
    - type: json_parser
      id: parser-docker
      output: extract-metadata-from-filepath
    - type: regex_parser
      id: parser-crio
      regex: '^(?P<time>[^ Z]+) (?P<stream>stdout|stderr) (?P<logtag>[^ ]*) ?(?P<log>.*)$'
      output: extract-metadata-from-filepath
      timestamp:
        parse_from: attributes.time
        layout_type: gotime
        layout: "2006-01-02T15:04:05.000000000Z07:00"
    - type: regex_parser
      id: extract-metadata-from-filepath
      regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]+)\/(?P<container_name>[^\._]+)\/(?P<restart_count>\d+)\.log$'
      parse_from: attributes["log.file.path"]
      cache:
        size: 128
    - type: move
      from: attributes.log
      to: body
    - type: move
      from: attributes.stream
      to: attributes["log.iostream"]

  # Kubernetes cluster metrics and events
  k8s_cluster:
    auth_type: serviceAccount
    node_conditions_to_report:
    - Ready
    - MemoryPressure
    - DiskPressure
    allocatable_types_to_report:
    - cpu
    - memory
    - storage

# Processors transform, filter, and enrich telemetry
processors:
  # Memory limiter MUST be the first processor in every pipeline
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 20

  # Batch for efficiency
  batch:
    send_batch_size: 1024
    send_batch_max_size: 2048
    timeout: 5s

  # Resource detection - add host/cloud metadata
  resourcedetection:
    detectors:
    - env
    - system
    - kubernetes_node
    - docker
    timeout: 10s
    override: false

  # Add Kubernetes pod/namespace attributes from downward API
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
      - k8s.namespace.name
      - k8s.node.name
      - k8s.pod.start_time
      - k8s.container.name
      labels:
      - tag_name: app.label.component
        key: app.kubernetes.io/component
        from: pod
      - tag_name: app.label.version
        key: app.kubernetes.io/version
        from: pod
      annotations:
      - tag_name: slo.tier
        key: slo.support.tools/tier
        from: pod

  # Transform/normalize spans
  transform/spans:
    trace_statements:
    - context: span
      statements:
      # Normalize HTTP method to uppercase
      - set(attributes["http.method"], ConvertCase(attributes["http.method"], "upper"))
        where attributes["http.method"] != nil
      # Drop health check spans to reduce noise
      - drop()
        where attributes["http.url"] == "/healthz" or attributes["http.url"] == "/readyz"

  # Attribute processing for metrics
  transform/metrics:
    metric_statements:
    - context: metric
      statements:
      # Convert container CPU metrics to millicores
      - set(unit, "millicores") where name == "container.cpu.usage.total"

  # Filter out unwanted signals
  filter/traces:
    traces:
      span:
      - 'status.code == STATUS_CODE_OK and attributes["http.route"] == "/health"'
      - 'name == "healthcheck"'

  filter/metrics:
    metrics:
      metric:
      - 'name == "go_gc_duration_seconds" and resource.attributes["service.name"] == "jaeger"'

  # Probabilistic sampling (head-based, applied at collector)
  probabilistic_sampler:
    sampling_percentage: 20

# Exporters send telemetry to backend systems
exporters:
  # Tempo for traces
  otlp/tempo:
    endpoint: "tempo-distributor.monitoring.svc.cluster.local:4317"
    tls:
      insecure: false
      ca_file: /etc/otel/certs/ca.crt
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s
    sending_queue:
      enabled: true
      num_consumers: 10
      queue_size: 1000

  # Prometheus remote write for metrics
  prometheusremotewrite:
    endpoint: "http://mimir-distributor.monitoring.svc.cluster.local:8080/api/v1/push"
    tls:
      insecure_skip_verify: false
    resource_to_telemetry_conversion:
      enabled: true
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
    external_labels:
      cluster: production-us-east-1
      environment: production

  # Loki for logs
  loki:
    endpoint: "http://loki-distributor.monitoring.svc.cluster.local:3100/loki/api/v1/push"
    default_labels_enabled:
      exporter: false
      job: true
      instance: false
      level: true

  # Debug exporter for troubleshooting (never use in production hot path)
  debug:
    verbosity: normal
    sampling_initial: 5
    sampling_thereafter: 200

# Service ties everything together
service:
  extensions:
  - health_check
  - pprof
  - zpages
  - memory_ballast

  pipelines:
    traces:
      receivers:
      - otlp
      processors:
      - memory_limiter
      - k8sattributes
      - resourcedetection
      - transform/spans
      - filter/traces
      - batch
      exporters:
      - otlp/tempo

    metrics:
      receivers:
      - otlp
      - prometheus
      - k8s_cluster
      processors:
      - memory_limiter
      - k8sattributes
      - resourcedetection
      - transform/metrics
      - filter/metrics
      - batch
      exporters:
      - prometheusremotewrite

    logs:
      receivers:
      - otlp
      - filelog
      processors:
      - memory_limiter
      - k8sattributes
      - resourcedetection
      - batch
      exporters:
      - loki

  telemetry:
    logs:
      level: info
      encoding: json
    metrics:
      level: detailed
      address: "0.0.0.0:8888"
```

## Kubernetes Deployment Patterns

### DaemonSet Pattern (Node Agent)

Deploy as DaemonSet when collecting node-level metrics, kubelet metrics, container logs, or host-level data. Each Collector instance is responsible for one node.

```yaml
# daemonset-collector.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-collector-agent
  namespace: monitoring
  labels:
    app.kubernetes.io/name: otel-collector
    app.kubernetes.io/component: agent
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: otel-collector
      app.kubernetes.io/component: agent
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: otel-collector
        app.kubernetes.io/component: agent
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8888"
    spec:
      serviceAccountName: otel-collector-agent
      hostNetwork: false
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      securityContext:
        runAsNonRoot: false  # Required to read /var/log/pods
      volumes:
      - name: config
        configMap:
          name: otel-collector-agent-config
      - name: varlogpods
        hostPath:
          path: /var/log/pods
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
      - name: certs
        secret:
          secretName: otel-collector-tls
      initContainers:
      - name: init-cert-permissions
        image: busybox:1.36
        command: ['sh', '-c', 'chmod 644 /etc/otel/certs/*']
        volumeMounts:
        - name: certs
          mountPath: /etc/otel/certs
      containers:
      - name: collector
        image: otel/opentelemetry-collector-contrib:0.105.0
        args:
        - --config=/conf/collector.yaml
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
        - name: GOMEMLIMIT
          value: "400MiB"
        ports:
        - name: otlp-grpc
          containerPort: 4317
          protocol: TCP
        - name: otlp-http
          containerPort: 4318
          protocol: TCP
        - name: metrics
          containerPort: 8888
          protocol: TCP
        - name: health
          containerPort: 13133
          protocol: TCP
        volumeMounts:
        - name: config
          mountPath: /conf
        - name: varlogpods
          mountPath: /var/log/pods
          readOnly: true
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: certs
          mountPath: /etc/otel/certs
          readOnly: true
        livenessProbe:
          httpGet:
            path: /health/status
            port: 13133
          initialDelaySeconds: 15
          periodSeconds: 30
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/status
            port: 13133
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: 200m
            memory: 400Mi
          limits:
            cpu: 1000m
            memory: 600Mi
        securityContext:
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
```

### Deployment Pattern (Gateway / Aggregator)

Deploy as Deployment for stateless aggregation, tail sampling, or as a gateway that receives from multiple agent Collectors and forwards to backends. Gateway Collectors handle tail sampling because they see entire traces:

```yaml
# deployment-collector.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-collector-gateway
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: otel-collector
      app.kubernetes.io/component: gateway
  template:
    metadata:
      labels:
        app.kubernetes.io/name: otel-collector
        app.kubernetes.io/component: gateway
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app.kubernetes.io/name: otel-collector
                app.kubernetes.io/component: gateway
            topologyKey: kubernetes.io/hostname
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/component: gateway
      containers:
      - name: collector
        image: otel/opentelemetry-collector-contrib:0.105.0
        args:
        - --config=/conf/collector.yaml
        env:
        - name: GOMEMLIMIT
          value: "1800MiB"
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 2.5Gi
        # ... (same ports, probes, volumeMounts as agent)
---
apiVersion: v1
kind: Service
metadata:
  name: otel-collector-gateway
  namespace: monitoring
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: otel-collector
    app.kubernetes.io/component: gateway
  ports:
  - name: otlp-grpc
    port: 4317
    targetPort: 4317
    protocol: TCP
  - name: otlp-http
    port: 4318
    targetPort: 4318
    protocol: TCP
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: otel-collector-gateway-pdb
  namespace: monitoring
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/component: gateway
```

## Tail Sampling

Tail sampling makes sampling decisions after a complete trace is received, allowing intelligent decisions based on trace outcomes (errors, latency, etc.). This requires a gateway Collector that accumulates spans for a configurable window.

```yaml
# tail-sampling processor config snippet
processors:
  tail_sampling:
    # How long to wait for a complete trace before making a sampling decision
    decision_wait: 10s
    # How many traces to keep in memory
    num_traces: 100000
    # Check for old traces every N seconds
    expected_new_traces_per_sec: 1000
    policies:
    # Always sample traces with errors
    - name: sample-errors
      type: status_code
      status_code:
        status_codes:
        - ERROR
    # Always sample slow traces (> 2 seconds)
    - name: sample-slow
      type: latency
      latency:
        threshold_ms: 2000
    # Sample 100% from critical services
    - name: sample-critical-services
      type: string_attribute
      string_attribute:
        key: service.name
        values:
        - payment-service
        - auth-service
        enabled_regex_matching: false
    # Sample 10% from database spans
    - name: sample-db-rate
      type: and
      and:
        and_sub_policy:
        - name: db-filter
          type: string_attribute
          string_attribute:
            key: db.system
            values:
            - postgresql
            - redis
            - mongodb
        - name: db-rate
          type: probabilistic
          probabilistic:
            sampling_percentage: 10
    # Default: 5% of everything else
    - name: default-rate
      type: probabilistic
      probabilistic:
        sampling_percentage: 5
```

**Note**: All spans for a given trace must flow to the same Collector instance for tail sampling to work. Use sticky load balancing:

```yaml
# Load balancing exporter routes traces to a consistent gateway instance
exporters:
  loadbalancing:
    protocol:
      otlp:
        endpoint: "otel-collector-gateway.monitoring.svc.cluster.local:4317"
        tls:
          insecure: false
    routing_key: "traceID"
    resolver:
      k8s:
        service: otel-collector-gateway.monitoring
        ports:
        - 4317
```

## Attribute Enrichment Pipeline

A common requirement is enriching telemetry with data from external sources such as a service registry or CMDB:

```yaml
processors:
  # Add static resource attributes
  resource:
    attributes:
    - key: deployment.environment
      value: production
      action: upsert
    - key: cloud.region
      value: us-east-1
      action: upsert
    - key: cluster.name
      from_attribute: k8s.cluster.name
      action: insert

  # Transform attributes dynamically
  transform/enrich:
    trace_statements:
    - context: resource
      statements:
      # Create composite service key for routing
      - set(attributes["service.key"],
          Concat([attributes["service.name"], attributes["deployment.environment"]], "/"))
      # Normalize service names (remove env suffix if present)
      - replace_pattern(attributes["service.name"], "-prod$", "")
      - replace_pattern(attributes["service.name"], "-production$", "")
    - context: span
      statements:
      # Extract route pattern from full URL
      - replace_pattern(attributes["http.url"],
          "^https?://[^/]+(/[^?#]*)[?#]?.*$", "$${1}",
          "url.path")
      where attributes["http.url"] != nil
```

## Fanout Routing to Multiple Backends

The Connector component (OTel Collector 0.87+) supports advanced routing logic:

```yaml
connectors:
  # Route to different exporters based on service name
  routing:
    default_pipelines:
    - traces/default
    table:
    - statement: route() where attributes["service.name"] == "payment-service"
      pipelines:
      - traces/payment
    - statement: route() where attributes["service.name"] == "auth-service"
      pipelines:
      - traces/auth
    - statement: route() where IsMatch(attributes["service.name"], "^legacy-.*")
      pipelines:
      - traces/legacy

service:
  pipelines:
    # Ingest pipeline
    traces/ingest:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, batch]
      exporters: [routing]

    # Per-tier export pipelines
    traces/default:
      receivers: [routing]
      processors: [tail_sampling]
      exporters: [otlp/tempo]

    traces/payment:
      receivers: [routing]
      processors: [tail_sampling]
      exporters: [otlp/tempo, otlp/payment-archive]

    traces/legacy:
      receivers: [routing]
      processors: []
      exporters: [otlp/jaeger-legacy]
```

## Scaling Strategies

### Horizontal Scaling with Collector Operator

The OpenTelemetry Operator automates Collector lifecycle management:

```bash
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/latest/download/opentelemetry-operator.yaml
```

```yaml
# opentelemetrycollector.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  mode: deployment
  replicas: 3
  autoscaler:
    minReplicas: 2
    maxReplicas: 20
    targetCPUUtilization: 70
    targetMemoryUtilization: 80
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "2Gi"
  env:
  - name: GOMEMLIMIT
    value: "1800MiB"
  config: |
    # (paste collector config here as YAML string)
```

### Capacity Planning

Gateway Collector throughput guidelines:

| Workload | CPU | Memory | Expected throughput |
|----------|-----|--------|-------------------|
| Trace-only, 100k spans/s | 2 cores | 2 GB | ~100k spans/s |
| Metrics-heavy, 500k datapoints/s | 4 cores | 4 GB | ~500k DPS |
| Mixed + tail sampling 100k traces | 4 cores | 8 GB | ~50k traces/s |
| Log aggregation, 50k lines/s | 2 cores | 1.5 GB | ~50k lines/s |

Enable the Collector's own metrics for capacity monitoring:

```yaml
service:
  telemetry:
    metrics:
      level: detailed
      address: "0.0.0.0:8888"
```

Key Collector self-metrics to alert on:

| Metric | Alert Threshold | Meaning |
|--------|----------------|---------|
| `otelcol_processor_batch_timeout_trigger_send_total` | Rate > 0 sustained | Queue is filling; batch timeout hit |
| `otelcol_exporter_queue_size` | > 80% of queue_size | Exporter backpressure |
| `otelcol_processor_refused_spans` | > 0 | Memory limiter dropping data |
| `otelcol_receiver_refused_metric_points` | > 0 | Receiver backpressure |
| `otelcol_process_memory_rss` | > container limit × 0.9 | OOM risk |

## RBAC for Kubernetes Receivers

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-collector-agent
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-collector-agent
rules:
- apiGroups: [""]
  resources:
  - nodes
  - nodes/metrics
  - services
  - endpoints
  - pods
  - namespaces
  verbs: [get, list, watch]
- apiGroups: [extensions, networking.k8s.io]
  resources:
  - ingresses
  verbs: [get, list, watch]
- nonResourceURLs:
  - /metrics
  - /metrics/cadvisor
  verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-collector-agent
subjects:
- kind: ServiceAccount
  name: otel-collector-agent
  namespace: monitoring
roleRef:
  kind: ClusterRole
  name: otel-collector-agent
  apiGroup: rbac.authorization.k8s.io
```

## Troubleshooting the Collector

### zpages Diagnostic Interface

Access the built-in zpages interface for pipeline health:

```bash
# Port-forward to zpages
kubectl -n monitoring port-forward pod/otel-collector-gateway-0 55679:55679

# View pipeline traces:
# http://localhost:55679/debug/tracez
# View service pipeline status:
# http://localhost:55679/debug/pipelinez
# View extension status:
# http://localhost:55679/debug/extensionz
```

### Enabling Verbose Debug Logging

```yaml
# Temporarily enable debug logging (caution: very verbose)
service:
  telemetry:
    logs:
      level: debug
      sampling:
        initial: 5
        thereafter: 200
```

### Common Configuration Errors

**Error**: `pipeline "traces" references receiver "otlp" not found`

Cause: Receiver is defined but not referenced in the pipeline, or misspelled.

**Error**: `memory_limiter must be defined as first processor`

Cause: `memory_limiter` must appear before any other processor in every pipeline to prevent OOM.

**Error**: Spans dropped with `otelcol_processor_refused_spans > 0`

Cause: `memory_limiter` is enforcing its limit. Increase container memory limit or reduce `limit_percentage`.

## Summary

The OpenTelemetry Collector is a flexible, high-performance telemetry pipeline engine. Production deployments benefit most from a two-tier topology: DaemonSet agents for node-local data collection and log tailing, plus gateway Deployments for tail sampling, enrichment, and multi-backend fanout. Careful pipeline ordering (memory_limiter first, then k8sattributes, then batch last) and queue configuration ensure that transient backend failures do not cause data loss. The Collector Operator simplifies lifecycle management and autoscaling in Kubernetes environments.
