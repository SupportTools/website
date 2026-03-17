---
title: "Kubernetes OpenTelemetry Operator: Auto-Instrumentation, Collector Deployment, and OTLP Pipeline Configuration"
date: 2031-12-18T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Kubernetes", "Observability", "Tracing", "Metrics", "OTLP", "Operator", "Auto-Instrumentation"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to deploying and configuring the OpenTelemetry Operator for Kubernetes, covering auto-instrumentation injection, collector topology, OTLP pipeline design, and multi-backend routing."
more_link: "yes"
url: "/kubernetes-opentelemetry-operator-auto-instrumentation-collector-otlp-pipeline/"
---

The OpenTelemetry Operator transforms how enterprise teams instrument Kubernetes workloads by removing the need for per-service SDK changes when auto-instrumentation suffices, centralizing collector configuration through a Kubernetes-native API, and providing a unified OTLP pipeline that fans out to multiple observability backends. For teams managing dozens of services, the operational efficiency gain is substantial.

This guide covers the complete OpenTelemetry Operator stack from installation through advanced pipeline design, including auto-instrumentation for Java, Python, and Go, multi-collector topologies, OTLP pipeline configuration, and integration with Jaeger, Prometheus, and Loki.

<!--more-->

# Kubernetes OpenTelemetry Operator: Auto-Instrumentation, Collector Deployment, and OTLP Pipeline

## Section 1: OpenTelemetry Operator Architecture

### 1.1 CRD Overview

The OpenTelemetry Operator introduces three primary Custom Resource Definitions:

| CRD | Purpose |
|-----|---------|
| `OpenTelemetryCollector` | Deploys and configures an OTel Collector instance |
| `Instrumentation` | Defines auto-instrumentation configuration injected into pods |
| `OpAMPBridge` | Connects collectors to an OpAMP server for remote management |

### 1.2 Admission Webhook

The operator deploys a mutating admission webhook that intercepts pod creation requests. When a pod has the annotation `instrumentation.opentelemetry.io/inject-<language>: "true"`, the webhook:

1. Looks up the `Instrumentation` resource in the pod's namespace (or cluster default)
2. Injects an init container that copies the language SDK agent
3. Sets environment variables to configure the agent (endpoint, sampling, service name)
4. Mounts volumes for the agent JAR/binary

### 1.3 Collector Deployment Modes

The `OpenTelemetryCollector` resource supports four deployment modes:

- **Deployment**: Centralized collectors, suitable for aggregation
- **DaemonSet**: Node-local collectors for log collection and host metrics
- **StatefulSet**: When collectors need persistent storage (e.g., file exporters)
- **Sidecar**: Per-pod collector injected automatically via the operator

## Section 2: Installing the OpenTelemetry Operator

### 2.1 Cert-Manager Prerequisite

The operator requires cert-manager for webhook TLS:

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.0/cert-manager.yaml
kubectl wait --for=condition=Available --timeout=120s deployment/cert-manager -n cert-manager
kubectl wait --for=condition=Available --timeout=120s deployment/cert-manager-webhook -n cert-manager
```

### 2.2 Operator Installation via Helm

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

kubectl create namespace opentelemetry-operator-system

helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --set manager.collectorImage.repository=otel/opentelemetry-collector-contrib \
  --set manager.collectorImage.tag=0.96.0 \
  --set admissionWebhooks.certManager.enabled=true \
  --version 0.50.0 \
  --wait
```

### 2.3 Verify Installation

```bash
# Check operator pod
kubectl get pods -n opentelemetry-operator-system

# Check CRDs
kubectl get crds | grep opentelemetry

# Check webhook configurations
kubectl get mutatingwebhookconfigurations | grep opentelemetry
kubectl get validatingwebhookconfigurations | grep opentelemetry
```

## Section 3: Deploying OpenTelemetry Collectors

### 3.1 Gateway Collector (Centralized Aggregation)

```yaml
# gateway-collector.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: observability
spec:
  mode: deployment
  replicas: 2

  image: otel/opentelemetry-collector-contrib:0.96.0

  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 2Gi

  podDisruptionBudget:
    minAvailable: 1

  autoscaler:
    minReplicas: 2
    maxReplicas: 8
    targetCPUUtilization: 70
    targetMemoryUtilization: 80

  serviceAccount: otel-gateway-collector

  ports:
    - name: otlp-grpc
      port: 4317
      protocol: TCP
    - name: otlp-http
      port: 4318
      protocol: TCP
    - name: metrics
      port: 8888
      protocol: TCP
    - name: health
      port: 13133
      protocol: TCP

  config: |
    extensions:
      health_check:
        endpoint: "0.0.0.0:13133"
      pprof:
        endpoint: "0.0.0.0:1777"
      zpages:
        endpoint: "0.0.0.0:55679"

    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
            max_recv_msg_size_mib: 32
            keepalive:
              server_parameters:
                time: 30s
                timeout: 5s
          http:
            endpoint: "0.0.0.0:4318"
            cors:
              allowed_origins:
                - "https://*.example.com"
              allowed_headers:
                - "X-Trace-ID"
                - "X-Span-ID"

    processors:
      memory_limiter:
        check_interval: 1s
        limit_percentage: 75
        spike_limit_percentage: 15

      batch:
        send_batch_size: 10000
        send_batch_max_size: 11000
        timeout: 10s

      resource:
        attributes:
          - key: cluster
            value: "production-us-east-1"
            action: insert
          - key: environment
            value: "production"
            action: insert

      transform/traces:
        trace_statements:
          - context: span
            statements:
              - delete_key(attributes, "http.user_agent") where attributes["http.url"] startswith "https://internal"
              - set(status.code, STATUS_CODE_ERROR) where status.code == STATUS_CODE_UNSET and attributes["http.status_code"] >= 500

      filter/traces:
        traces:
          span:
            - 'attributes["http.route"] == "/healthz"'
            - 'attributes["http.route"] == "/readyz"'
            - 'attributes["http.route"] == "/metrics"'

      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 10000
        policies:
          - name: errors-policy
            type: status_code
            status_code: {status_codes: [ERROR]}
          - name: slow-traces-policy
            type: latency
            latency: {threshold_ms: 1000}
          - name: probabilistic-policy
            type: probabilistic
            probabilistic: {sampling_percentage: 10}

    exporters:
      otlp/jaeger:
        endpoint: "jaeger-collector.observability.svc.cluster.local:4317"
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 300s

      prometheusremotewrite:
        endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"
        tls:
          insecure: true
        add_metric_suffixes: false
        resource_to_telemetry_conversion:
          enabled: true

      loki:
        endpoint: "http://loki.monitoring.svc.cluster.local:3100/loki/api/v1/push"
        default_labels_enabled:
          exporter: false
          job: true
          instance: true
          level: true
        labels:
          resource:
            service.name: "service_name"
            service.namespace: "service_namespace"
            k8s.pod.name: "pod"
            k8s.namespace.name: "namespace"
          attributes:
            log.level: "level"

      debug:
        verbosity: basic
        sampling_initial: 5
        sampling_thereafter: 200

    service:
      extensions: [health_check, pprof, zpages]
      pipelines:
        traces:
          receivers: [otlp]
          processors:
            - memory_limiter
            - resource
            - transform/traces
            - filter/traces
            - tail_sampling
            - batch
          exporters: [otlp/jaeger]
        metrics:
          receivers: [otlp]
          processors:
            - memory_limiter
            - resource
            - batch
          exporters: [prometheusremotewrite]
        logs:
          receivers: [otlp]
          processors:
            - memory_limiter
            - resource
            - batch
          exporters: [loki]

      telemetry:
        logs:
          level: "warn"
          encoding: json
        metrics:
          address: "0.0.0.0:8888"
          level: detailed
```

### 3.2 Node-Agent Collector (DaemonSet)

```yaml
# node-agent-collector.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-node-agent
  namespace: observability
spec:
  mode: daemonset

  tolerations:
    - operator: Exists
      effect: NoSchedule
    - operator: Exists
      effect: NoExecute

  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

  volumeMounts:
    - name: varlog
      mountPath: /var/log
      readOnly: true
    - name: varlibdockercontainers
      mountPath: /var/lib/docker/containers
      readOnly: true
    - name: hostroot
      mountPath: /hostroot
      readOnly: true

  volumes:
    - name: varlog
      hostPath:
        path: /var/log
    - name: varlibdockercontainers
      hostPath:
        path: /var/lib/docker/containers
    - name: hostroot
      hostPath:
        path: /

  env:
    - name: K8S_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: K8S_POD_IP
      valueFrom:
        fieldRef:
          fieldPath: status.podIP

  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
          http:
            endpoint: "0.0.0.0:4318"

      filelog:
        include:
          - /var/log/pods/*/*/*.log
        exclude:
          - /var/log/pods/kube-system_*/*/*.log
          - /var/log/pods/observability_*/*/*.log
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
                expr: 'body matches "^[^ Z]+ "'
          - type: json_parser
            id: parser-docker
            output: extract-metadata-from-filepath
          - type: regex_parser
            id: parser-crio
            regex: '^(?P<time>[^ Z]+) (?P<stream>stdout|stderr) (?P<logtag>[^ ]*) ?(?P<log>.*)$'
            output: extract-metadata-from-filepath
          - type: regex_parser
            id: extract-metadata-from-filepath
            regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]{36})\/(?P<container_name>[^\._]+)\/(?P<restart_count>\d+)\.log$'
            parse_from: attributes["log.file.path"]
            output: move-attrs
          - type: move
            id: move-attrs
            from: attributes.log
            to: body

      hostmetrics:
        root_path: /hostroot
        collection_interval: 15s
        scrapers:
          cpu:
            metrics:
              system.cpu.utilization:
                enabled: true
          disk: {}
          filesystem:
            exclude_mount_points:
              mount_points: [/dev, /proc, /sys, /run/k3s/containerd]
              match_type: strict
          memory: {}
          network: {}
          load: {}
          process:
            mute_process_name_error: true
            mute_process_exe_error: true
            mute_process_io_error: true

    processors:
      memory_limiter:
        check_interval: 1s
        limit_percentage: 70
        spike_limit_percentage: 15

      batch:
        send_batch_size: 5000
        timeout: 5s

      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        extract:
          metadata:
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.deployment.name
            - k8s.statefulset.name
            - k8s.daemonset.name
            - k8s.cronjob.name
            - k8s.job.name
            - k8s.namespace.name
            - k8s.node.name
            - k8s.container.name
            - container.image.name
            - container.image.tag
          labels:
            - tag_name: service.name
              key: app.kubernetes.io/name
              from: pod
            - tag_name: service.version
              key: app.kubernetes.io/version
              from: pod
        pod_association:
          - sources:
              - from: resource_attribute
                name: k8s.pod.ip
          - sources:
              - from: resource_attribute
                name: k8s.pod.uid
          - sources:
              - from: connection

      resource/node:
        attributes:
          - key: k8s.node.name
            from_attribute: k8s.node.name
            action: insert
          - key: host.name
            value: "${K8S_NODE_NAME}"
            action: upsert

    exporters:
      otlp/gateway:
        endpoint: "otel-gateway-collector.observability.svc.cluster.local:4317"
        tls:
          insecure: true
        sending_queue:
          enabled: true
          num_consumers: 10
          queue_size: 10000
        retry_on_failure:
          enabled: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource/node, batch]
          exporters: [otlp/gateway]
        metrics:
          receivers: [otlp, hostmetrics]
          processors: [memory_limiter, k8sattributes, resource/node, batch]
          exporters: [otlp/gateway]
        logs:
          receivers: [otlp, filelog]
          processors: [memory_limiter, k8sattributes, resource/node, batch]
          exporters: [otlp/gateway]
```

## Section 4: Auto-Instrumentation

### 4.1 Java Auto-Instrumentation

```yaml
# instrumentation-java.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-node-agent-collector.observability.svc.cluster.local:4318

  propagators:
    - tracecontext
    - baggage
    - b3

  sampler:
    type: parentbased_traceidratio
    argument: "0.1"   # 10% sampling rate

  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
    env:
      - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_SPRING_WEB_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_KAFKA_ENABLED
        value: "true"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_JAVAAGENT_DEBUG
        value: "false"
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 128Mi

  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.44b0
    env:
      - name: OTEL_PYTHON_LOG_CORRELATION
        value: "true"
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: "true"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"

  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.46.0
    env:
      - name: OTEL_NODE_ENABLED_INSTRUMENTATIONS
        value: "http,grpc,pg,redis,aws-lambda"

  dotnet:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-dotnet:1.3.0
    env:
      - name: OTEL_DOTNET_AUTO_LOG_DIRECTORY
        value: "/tmp/otel-dotnet-auto"
```

### 4.2 Annotating Workloads for Auto-Instrumentation

```yaml
# java-service-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-service
  template:
    metadata:
      labels:
        app: order-service
        app.kubernetes.io/name: order-service
        app.kubernetes.io/version: "2.4.1"
      annotations:
        # Inject Java auto-instrumentation
        instrumentation.opentelemetry.io/inject-java: "true"

        # Optional: specify a named instrumentation resource
        # instrumentation.opentelemetry.io/inject-java: "production/java-instrumentation"

        # Override service name (defaults to k8s deployment name)
        instrumentation.opentelemetry.io/java: "true"
    spec:
      containers:
        - name: order-service
          image: registry.example.com/order-service:2.4.1
          env:
            # These can also be set here; auto-instrumentation adds OTEL_ vars
            - name: OTEL_SERVICE_NAME
              value: "order-service"
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "deployment.environment=production,service.version=2.4.1"
          ports:
            - containerPort: 8080
```

### 4.3 Go Auto-Instrumentation (eBPF-based)

Go auto-instrumentation uses eBPF to instrument goroutines without modifying source code:

```yaml
# instrumentation-go.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: go-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-node-agent-collector.observability.svc.cluster.local:4318

  propagators:
    - tracecontext
    - baggage

  go:
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.14.0-alpha
    env:
      - name: OTEL_GO_AUTO_TARGET_EXE
        value: "/app/server"  # Path to the Go binary to instrument
      - name: OTEL_EXPORTER_OTLP_INSECURE
        value: "true"
```

```yaml
# Go deployment with eBPF instrumentation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-go: "true"
        instrumentation.opentelemetry.io/otel-go-auto-target-exe: "/app/payment-service"
    spec:
      # eBPF instrumentation requires privileged access to the kernel
      shareProcessNamespace: true
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:1.0.0
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
```

## Section 5: RBAC for the Collector

### 5.1 ServiceAccount and ClusterRole

```yaml
# collector-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-gateway-collector
  namespace: observability

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-gateway-collector
rules:
  # Required for k8sattributes processor
  - apiGroups: [""]
    resources: ["pods", "namespaces", "nodes"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["apps"]
    resources: ["replicasets", "deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "watch", "list"]
  - apiGroups: ["extensions"]
    resources: ["replicasets"]
    verbs: ["get", "watch", "list"]
  # Required for Kubernetes events receiver
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "watch", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-gateway-collector
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: otel-gateway-collector
subjects:
  - kind: ServiceAccount
    name: otel-gateway-collector
    namespace: observability
```

## Section 6: Advanced Pipeline Patterns

### 6.1 Multi-Tenant Routing by Namespace

```yaml
# Multi-tenant routing using the routing processor
config: |
  processors:
    routing:
      default_exporters:
        - otlp/default-backend
      table:
        - statement: route() where resource.attributes["k8s.namespace.name"] == "team-alpha"
          exporters:
            - otlp/team-alpha-backend
        - statement: route() where resource.attributes["k8s.namespace.name"] == "team-beta"
          exporters:
            - otlp/team-beta-backend
        - statement: route() where resource.attributes["deployment.environment"] == "staging"
          exporters:
            - otlp/staging-backend

  exporters:
    otlp/team-alpha-backend:
      endpoint: "jaeger-alpha.observability.svc.cluster.local:4317"
      tls:
        insecure: true
    otlp/team-beta-backend:
      endpoint: "jaeger-beta.observability.svc.cluster.local:4317"
      tls:
        insecure: true
    otlp/staging-backend:
      endpoint: "jaeger-staging.observability.svc.cluster.local:4317"
      tls:
        insecure: true
    otlp/default-backend:
      endpoint: "jaeger-default.observability.svc.cluster.local:4317"
      tls:
        insecure: true
```

### 6.2 Span Metrics Connector

Generate RED metrics (Rate, Error, Duration) from trace data:

```yaml
config: |
  connectors:
    spanmetrics:
      namespace: traces.spanmetrics
      histogram:
        explicit:
          buckets: [2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms, 400ms, 800ms, 1s, 1400ms, 2s, 5s, 10s, 15s]
      dimensions:
        - name: http.method
          default: GET
        - name: http.status_code
        - name: http.route
        - name: rpc.grpc.status_code
        - name: db.system
      exemplars:
        enabled: true
      exclude_dimensions: []
      dimensions_cache_size: 1000
      aggregation_temporality: AGGREGATION_TEMPORALITY_CUMULATIVE
      metrics_flush_interval: 15s

  service:
    pipelines:
      traces:
        receivers: [otlp]
        processors: [memory_limiter, batch]
        exporters: [otlp/jaeger, spanmetrics]
      metrics:
        receivers: [otlp, spanmetrics]
        processors: [memory_limiter, batch]
        exporters: [prometheusremotewrite]
```

### 6.3 Exemplars for Correlating Metrics and Traces

```yaml
config: |
  exporters:
    prometheusremotewrite:
      endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"
      send_metadata: true
      add_metric_suffixes: false
      resource_to_telemetry_conversion:
        enabled: true
      # Exemplars bridge traces and metrics
      # Enable in Prometheus: --enable-feature=exemplar-storage
```

### 6.4 Sampling Strategies

```yaml
# Probabilistic head sampling (fast, at source)
sampler:
  type: parentbased_traceidratio
  argument: "0.05"  # 5%

# Tail-based sampling at the gateway (intelligent, post-collection)
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 500000
    expected_new_traces_per_sec: 50000
    policies:
      - name: always-sample-errors
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: always-sample-slow
        type: latency
        latency:
          threshold_ms: 500
      - name: sample-high-value-routes
        type: string_attribute
        string_attribute:
          key: http.route
          values:
            - /api/payment
            - /api/checkout
            - /api/order
          enabled_regex_matching: false
      - name: low-rate-default
        type: probabilistic
        probabilistic:
          sampling_percentage: 1
```

## Section 7: Monitoring the OpenTelemetry Stack

### 7.1 Collector Self-Monitoring

```yaml
# ServiceMonitor for collector metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: otel-gateway-collector
  namespace: observability
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: otel-gateway-collector
  endpoints:
    - port: monitoring
      path: /metrics
      interval: 30s
```

### 7.2 Key Metrics to Alert On

```promql
# Collector queue utilization (>0.8 means backpressure)
otelcol_exporter_queue_capacity / otelcol_exporter_queue_size > 0.8

# Drop rate (data loss)
rate(otelcol_processor_dropped_spans_total[5m]) > 0
rate(otelcol_processor_dropped_metric_points_total[5m]) > 0

# Exporter failure rate
rate(otelcol_exporter_send_failed_spans_total[5m]) > 10

# Memory limiter dropping data
rate(otelcol_processor_refused_spans_total{processor="memory_limiter"}[5m]) > 0

# Receiver errors
rate(otelcol_receiver_refused_spans_total[5m]) > 0
```

### 7.3 Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: otel-collector-alerts
  namespace: observability
spec:
  groups:
    - name: otel-collector
      interval: 30s
      rules:
        - alert: OTelCollectorHighDropRate
          expr: |
            rate(otelcol_processor_dropped_spans_total[5m]) > 100
          for: 2m
          labels:
            severity: warning
            team: observability
          annotations:
            summary: "OTel Collector dropping spans"
            description: "Collector {{ $labels.service_instance_id }} is dropping {{ $value | humanize }} spans/sec"

        - alert: OTelCollectorExporterFailures
          expr: |
            rate(otelcol_exporter_send_failed_spans_total[5m]) > 10
          for: 3m
          labels:
            severity: critical
            team: observability
          annotations:
            summary: "OTel Collector exporter failures"
            description: "Collector exporter {{ $labels.exporter }} failing at {{ $value | humanize }} spans/sec"

        - alert: OTelCollectorQueueHigh
          expr: |
            (otelcol_exporter_queue_size / otelcol_exporter_queue_capacity) > 0.8
          for: 5m
          labels:
            severity: warning
            team: observability
          annotations:
            summary: "OTel Collector queue near capacity"
            description: "Queue utilization {{ $value | humanizePercentage }} for exporter {{ $labels.exporter }}"
```

## Section 8: Troubleshooting

### 8.1 Auto-Instrumentation Not Injecting

```bash
# Check webhook is healthy
kubectl get mutatingwebhookconfigurations opentelemetry-operator-mutating-webhook-configuration -o yaml

# Describe pod to see if init container was injected
kubectl describe pod <pod-name> -n <namespace> | grep -A5 "Init Containers"

# Check if Instrumentation resource exists in the namespace
kubectl get instrumentation -n <namespace>

# Verify annotation is on the pod template (not just the Deployment)
kubectl get pod <pod-name> -o jsonpath='{.metadata.annotations}'

# Check operator logs for webhook decisions
kubectl logs -n opentelemetry-operator-system deployment/opentelemetry-operator -c manager | grep -i "inject\|webhook\|error"
```

### 8.2 Collector Not Receiving Data

```bash
# Check collector logs
kubectl logs -n observability deployment/otel-gateway-collector | tail -100

# Test OTLP endpoint
kubectl run test-otlp --image=otel/opentelemetry-collector:0.96.0 --restart=Never --rm -it -- \
  /otelcol --config='receivers: {otlp: {protocols: {grpc: {}}}} exporters: {debug: {}} service: {pipelines: {traces: {receivers: [otlp] exporters: [debug]}}}'

# Check service endpoints
kubectl get endpoints -n observability otel-gateway-collector

# Verify pod network connectivity
kubectl exec -n production <app-pod> -- \
  curl -v http://otel-gateway-collector.observability.svc.cluster.local:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans": []}'
```

### 8.3 Memory and Performance Tuning

```bash
# Check collector memory usage
kubectl top pods -n observability -l app.kubernetes.io/name=otel-gateway-collector

# Inspect current pipeline statistics via zpages
kubectl port-forward -n observability svc/otel-gateway-collector 55679:55679
# Navigate to http://localhost:55679/debug/tracez in browser

# Check queue depths
kubectl port-forward -n observability svc/otel-gateway-collector 8888:8888
curl -s http://localhost:8888/metrics | grep otelcol_exporter_queue
```

## Summary

The OpenTelemetry Operator provides a Kubernetes-native management plane for the full observability data pipeline. The key capabilities deployed in this guide:

- A gateway collector deployment with tail-based sampling, multi-backend export, and span metrics generation
- A DaemonSet node agent for log collection, host metrics, and kubernetes attribute enrichment
- Auto-instrumentation for Java, Python, Node.js, and Go workloads via pod annotations
- Multi-tenant routing by namespace or environment attribute
- Exemplar-linked metrics for correlation between traces and RED metrics
- Prometheus alerting on collector health metrics

The architecture scales horizontally at both the node-agent and gateway layers, provides defense-in-depth with memory limiters, and centralizes pipeline configuration through Kubernetes CRDs that integrate naturally with GitOps workflows.
