---
title: "OpenTelemetry Auto-Instrumentation: Zero-Code Observability on Kubernetes"
date: 2027-03-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenTelemetry", "Auto-Instrumentation", "Observability", "Java", "Python", "Node.js"]
categories: ["Kubernetes", "Observability", "OpenTelemetry"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to OpenTelemetry Operator auto-instrumentation on Kubernetes, covering Instrumentation CRD configuration for Java, Python, Node.js and Go, annotation-based injection, context propagation, sampling strategies, and Grafana LGTM stack integration."
more_link: "yes"
url: "/opentelemetry-auto-instrumentation-kubernetes-guide/"
---

The OpenTelemetry Operator transforms Kubernetes workloads into fully observable services without requiring a single line of application code change. By combining an admission webhook with language-specific instrumentation agents, the operator injects distributed tracing, metrics, and log correlation into Java, Python, Node.js, and Go applications at pod creation time. This guide walks through a production deployment of the OpenTelemetry Operator, Instrumentation CRD configuration for each language runtime, sampling strategy design, and integration with the Grafana LGTM stack for end-to-end observability.

<!--more-->

## OpenTelemetry Operator Architecture

### Admission Webhook Flow

The OpenTelemetry Operator deploys two admission webhooks that intercept pod creation requests before they reach the Kubernetes scheduler.

The **Instrumentation Webhook** (`mutatingwebhookconfiguration/opentelemetry-operator-mutating-webhook-configuration`) examines every pod for the annotation `instrumentation.opentelemetry.io/inject-<language>`. When the annotation is present and resolves to a valid `Instrumentation` CR, the webhook mutates the pod spec to:

1. Add an init container that copies the language agent binary into an `emptyDir` volume
2. Inject environment variables pointing to the agent and OTLP endpoint
3. Set resource limits on the init container based on the Instrumentation CR spec

The **Collector Webhook** manages `OpenTelemetryCollector` CR instances, converting them into Deployments, DaemonSets, StatefulSets, or Sidecars depending on the chosen mode.

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Application Pod                                                 │
│  ┌──────────────────────┐  ┌──────────────────────────────────┐ │
│  │  Init Container      │  │  App Container                   │ │
│  │  otel-agent-copy     │  │  java -javaagent:/otel/agent.jar │ │
│  │  copies agent to     │  │  OTEL_EXPORTER_OTLP_ENDPOINT=... │ │
│  │  /otel-auto-instr/   │  │  OTEL_SERVICE_NAME=...           │ │
│  └──────────────────────┘  └──────────────────────────────────┘ │
│                    shared emptyDir volume                        │
└─────────────────────────────────────────────────────────────────┘
           │ OTLP/gRPC 4317
           ▼
┌─────────────────────────────┐
│  OTEL Collector (Sidecar    │
│  or Gateway DaemonSet)      │
│  - batch processor          │
│  - memory_limiter           │
│  - tail sampling            │
└─────────────────────────────┘
           │ OTLP/gRPC
           ▼
┌─────────────────────────────┐
│  Grafana Tempo              │
│  (trace backend)            │
└─────────────────────────────┘
```

## Installing the OpenTelemetry Operator

### Cert-Manager Prerequisite

The operator relies on cert-manager for webhook TLS certificate provisioning.

```bash
# Install cert-manager if not already present
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml

# Wait for cert-manager to be ready
kubectl rollout status deployment/cert-manager -n cert-manager
kubectl rollout status deployment/cert-manager-webhook -n cert-manager
```

### Operator Installation via Helm

```bash
# Add the opentelemetry-helm repository
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

# Install the operator into the opentelemetry-operator-system namespace
helm upgrade --install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --version 0.57.0 \
  --set "manager.collectorImage.repository=otel/opentelemetry-collector-contrib" \
  --set "manager.collectorImage.tag=0.98.0" \
  --wait
```

### Verify Installation

```bash
# Confirm the operator pod and webhook are healthy
kubectl get pods -n opentelemetry-operator-system
kubectl get mutatingwebhookconfigurations | grep opentelemetry

# Inspect available CRDs
kubectl get crd | grep opentelemetry
# Expected output includes:
#   instrumentations.opentelemetry.io
#   opentelemetrycollectors.opentelemetry.io
```

## Deploying an OTEL Collector Gateway

A gateway-mode collector receives telemetry from all applications in the cluster and fans out to multiple backends. This is the recommended topology for clusters running more than a handful of services.

```yaml
# otel-collector-gateway.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: observability
spec:
  mode: deployment                    # runs as a Deployment
  replicas: 2
  image: otel/opentelemetry-collector-contrib:0.98.0
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317   # gRPC OTLP receiver
          http:
            endpoint: 0.0.0.0:4318   # HTTP OTLP receiver

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 800               # refuse new data above 800 MiB RSS
        spike_limit_mib: 150

      batch:
        send_batch_size: 512         # flush after 512 spans
        timeout: 2s                  # or after 2 seconds

      resource:
        attributes:
          - key: deployment.environment
            value: production
            action: insert
          - key: k8s.cluster.name
            value: prod-us-east-1
            action: insert

      # Tail sampling: keep 100% of errored traces, 10% of healthy traces
      tail_sampling:
        decision_wait: 10s
        num_traces: 50000
        expected_new_traces_per_sec: 500
        policies:
          - name: keep-errors
            type: status_code
            status_code: { status_codes: [ERROR] }
          - name: probabilistic-healthy
            type: probabilistic
            probabilistic: { sampling_percentage: 10 }

    exporters:
      otlp/tempo:
        endpoint: tempo-distributor.observability.svc.cluster.local:4317
        tls:
          insecure: true             # mTLS handled by service mesh

      prometheus:
        endpoint: 0.0.0.0:8889      # expose scraped metrics for Prometheus

      loki:
        endpoint: http://loki-gateway.observability.svc.cluster.local/loki/api/v1/push
        default_labels_enabled:
          exporter: false
          job: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, resource, tail_sampling, batch]
          exporters: [otlp/tempo]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, resource, batch]
          exporters: [prometheus]
        logs:
          receivers: [otlp]
          processors: [memory_limiter, resource, batch]
          exporters: [loki]

      telemetry:
        logs:
          level: warn                # collector self-telemetry
        metrics:
          level: detailed
          address: 0.0.0.0:8888     # collector internal metrics
```

```bash
kubectl apply -f otel-collector-gateway.yaml

# Verify the collector service endpoints
kubectl get svc -n observability | grep otel-gateway
# otel-gateway-collector  ClusterIP  10.96.45.12  4317/TCP,4318/TCP,8888/TCP,8889/TCP
```

## Instrumentation CRD Configuration

The `Instrumentation` CR defines the auto-instrumentation configuration for each language. A single CR can cover multiple languages, or you can create per-language CRs for different configuration profiles.

### Universal Instrumentation CR

```yaml
# instrumentation-production.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: production-instrumentation
  namespace: production
spec:
  # OTLP exporter endpoint — points to the gateway collector
  exporter:
    endpoint: http://otel-gateway-collector.observability.svc.cluster.local:4317

  # Propagators configure trace context header formats
  propagators:
    - tracecontext                   # W3C TraceContext (recommended default)
    - baggage                        # W3C Baggage for cross-cutting metadata
    - b3multi                        # B3 multi-header for legacy services

  # Sampler: parent-based wrapping TraceIDRatioBased
  # Respects the sampling decision from upstream callers,
  # and for new root spans samples at 10%
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"                  # 10% sampling for root spans

  # Resource attributes applied to all telemetry from injected pods
  resource:
    resourceAttributes:
      deployment.environment: production
      service.version: "2.0"

  # ---- Java agent configuration ----
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 256Mi
    env:
      # Disable specific instrumentations that conflict with internal libraries
      - name: OTEL_INSTRUMENTATION_SPRING_WEBMVC_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
        value: "true"
      # Maximum export batch size
      - name: OTEL_BSP_MAX_EXPORT_BATCH_SIZE
        value: "512"
      # Export timeout
      - name: OTEL_BSP_EXPORT_TIMEOUT
        value: "10000"
      # Log level for the agent itself
      - name: OTEL_JAVAAGENT_LOGGING
        value: "application"

  # ---- Python auto-instrumentation ----
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.45b0
    resources:
      requests:
        cpu: 50m
        memory: 32Mi
      limits:
        cpu: 200m
        memory: 128Mi
    env:
      - name: OTEL_PYTHON_LOG_CORRELATION
        value: "true"               # inject trace/span IDs into log records
      - name: OTEL_PYTHON_LOG_FORMAT
        value: "%(asctime)s %(levelname)s [%(name)s] [%(filename)s:%(lineno)d] [trace_id=%(otelTraceID)s span_id=%(otelSpanID)s resource.service.name=%(otelServiceName)s] - %(message)s"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"

  # ---- Node.js auto-instrumentation ----
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.46.0
    resources:
      requests:
        cpu: 50m
        memory: 32Mi
      limits:
        cpu: 200m
        memory: 128Mi
    env:
      - name: OTEL_NODE_ENABLED_INSTRUMENTATIONS
        value: "http,express,grpc,pg,redis,mongodb"
      - name: OTEL_NODE_DISABLED_INSTRUMENTATIONS
        value: ""
      - name: NODE_OPTIONS
        value: ""                   # operator appends --require /otel-auto-instr/autoinstrumentation.js

  # ---- Go eBPF-based instrumentation ----
  go:
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.13.0-alpha
    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 256Mi
    env:
      - name: OTEL_GO_AUTO_SHOW_VERIFIER_LOG
        value: "false"
      - name: OTEL_GO_AUTO_TARGET_EXE
        value: "/app/server"        # path to the Go binary inside the container
```

```bash
kubectl apply -f instrumentation-production.yaml

# Verify the CR was accepted
kubectl describe instrumentation production-instrumentation -n production
```

## Annotation-Based Injection

With the Instrumentation CR in place, enabling auto-instrumentation requires a single annotation on a Pod, Deployment, StatefulSet, or DaemonSet.

### Java Application

```yaml
# java-app-deployment.yaml
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
      annotations:
        # Reference the Instrumentation CR; "true" uses the CR in the same namespace
        instrumentation.opentelemetry.io/inject-java: "true"
        # Override the service name (defaults to pod name)
        instrumentation.opentelemetry.io/inject-java: production-instrumentation
    spec:
      containers:
        - name: order-service
          image: registry.support.tools/order-service:3.4.1
          ports:
            - containerPort: 8080
          env:
            # These are merged with operator-injected env vars
            - name: OTEL_SERVICE_NAME
              value: "order-service"
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "team=platform,component=backend,version=3.4.1"
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1Gi
```

After pod creation, inspect the mutated pod to confirm injection:

```bash
kubectl get pod -n production -l app=order-service -o jsonpath='{.items[0].spec.initContainers[*].name}'
# opentelemetry-auto-instrumentation-java

kubectl get pod -n production -l app=order-service -o jsonpath='{.items[0].spec.containers[0].env}' | jq '.[] | select(.name | startswith("JAVA_TOOL_OPTIONS"))'
# {"name":"JAVA_TOOL_OPTIONS","value":"-javaagent:/otel-auto-instr/javaagent.jar"}
```

### Python Application

```yaml
# python-app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: inventory-service
  template:
    metadata:
      labels:
        app: inventory-service
      annotations:
        instrumentation.opentelemetry.io/inject-python: "true"
    spec:
      containers:
        - name: inventory-service
          image: registry.support.tools/inventory-service:1.9.2
          command: ["gunicorn", "--workers=4", "--bind=0.0.0.0:8080", "app:application"]
          env:
            - name: OTEL_SERVICE_NAME
              value: "inventory-service"
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "team=catalog,component=api"
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 800m
              memory: 512Mi
```

The operator injects `PYTHONPATH` pointing to the auto-instrumentation package, which then registers all detected framework hooks via `opentelemetry-instrumentation-auto-all`.

```bash
# Confirm PYTHONPATH injection
kubectl get pod -n production -l app=inventory-service -o jsonpath='{.items[0].spec.containers[0].env}' | \
  jq '.[] | select(.name == "PYTHONPATH")'
# {"name":"PYTHONPATH","value":"/otel-auto-instr/opentelemetry/instrumentation/auto_instrumentation:/otel-auto-instr"}
```

### Node.js Application

```yaml
# nodejs-app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-service
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: notification-service
  template:
    metadata:
      labels:
        app: notification-service
      annotations:
        instrumentation.opentelemetry.io/inject-nodejs: "true"
    spec:
      containers:
        - name: notification-service
          image: registry.support.tools/notification-service:2.1.0
          command: ["node", "dist/server.js"]
          env:
            - name: OTEL_SERVICE_NAME
              value: "notification-service"
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

The operator prepends `--require /otel-auto-instr/autoinstrumentation.js` to the `NODE_OPTIONS` environment variable, which loads the OTEL SDK and all registered instrumentations before application code runs.

### Go Application (eBPF-Based)

Go auto-instrumentation uses eBPF uprobes rather than code injection, requiring elevated privileges.

```yaml
# go-app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pricing-service
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pricing-service
  template:
    metadata:
      labels:
        app: pricing-service
      annotations:
        instrumentation.opentelemetry.io/inject-go: "true"
        instrumentation.opentelemetry.io/otel-go-auto-target-exe: "/app/pricing-service"
    spec:
      containers:
        - name: pricing-service
          image: registry.support.tools/pricing-service:1.2.3
          securityContext:
            runAsNonRoot: false      # eBPF instrumentation sidecar needs root
          env:
            - name: OTEL_SERVICE_NAME
              value: "pricing-service"
          resources:
            requests:
              cpu: 150m
              memory: 128Mi
            limits:
              cpu: 600m
              memory: 512Mi
      shareProcessNamespace: true   # required for eBPF probe attachment
```

The operator injects a sidecar container running the Go instrumentation agent, which attaches uprobes to the target binary using eBPF. No recompilation of the Go binary is required.

## Context Propagation Deep Dive

### W3C TraceContext Headers

When propagators include `tracecontext`, every outgoing HTTP request carries:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                │
             │  └─ trace-id (16 bytes hex)        │                └─ flags
             └─ version                           └─ parent-id (8 bytes hex)

tracestate: vendor1=opaqueValue1,vendor2=opaqueValue2
```

### B3 Multi-Header Format

For services using Zipkin-compatible tracing:

```
X-B3-TraceId: 80f198ee56343ba864fe8b2a57d3eff7
X-B3-ParentSpanId: 05e3ac9a4f6e3b90
X-B3-SpanId: e457b5a2e4d86bd1
X-B3-Sampled: 1
```

### Baggage Propagation

Baggage allows passing arbitrary key-value pairs across service boundaries for correlation:

```yaml
# In the Instrumentation CR, enable baggage propagator
propagators:
  - tracecontext
  - baggage
```

Applications can then read baggage entries:

```python
# Python: reading baggage injected by a gateway
from opentelemetry.baggage import get_all

baggage_entries = get_all()
user_id = baggage_entries.get("user.id")         # injected at API gateway
tenant_id = baggage_entries.get("tenant.id")     # multi-tenant correlation
```

## Sampling Strategies

### Parent-Based TraceIDRatio Sampler

The recommended production sampler for most workloads. Root spans are sampled at the configured ratio; child spans respect the parent's sampling decision.

```yaml
sampler:
  type: parentbased_traceidratio
  argument: "0.05"   # 5% of new root spans; all children of sampled parents are kept
```

This ensures that a trace is either fully sampled or entirely dropped, preventing orphaned spans.

### Tail Sampling in the Collector

Head-based sampling (at the SDK) cannot use trace-level information because only one span exists at decision time. Tail sampling in the collector defers the decision until all spans in a trace have arrived.

```yaml
# Inside the OpenTelemetryCollector config
processors:
  tail_sampling:
    decision_wait: 15s              # wait 15s for all spans to arrive
    num_traces: 100000              # max traces held in memory simultaneously
    expected_new_traces_per_sec: 1000
    policies:
      # Always keep traces with errors
      - name: keep-errors
        type: status_code
        status_code: { status_codes: [ERROR] }

      # Always keep slow traces (> 2 seconds)
      - name: keep-slow
        type: latency
        latency: { threshold_ms: 2000 }

      # Keep traces with a specific attribute (e.g., debug flag set by QA)
      - name: keep-debug-flagged
        type: string_attribute
        string_attribute:
          key: debug.force_sample
          values: ["true"]

      # Probabilistic fallback for healthy fast traces
      - name: probabilistic-10pct
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }
```

### Composite Sampler for High-Volume Services

For services generating millions of spans per minute, combine rate-limiting with parent-based sampling:

```yaml
# Instrumentation CR for a high-volume gateway service
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: gateway-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-gateway-collector.observability.svc.cluster.local:4317
  sampler:
    type: parentbased_traceidratio
    argument: "0.01"               # 1% for high-volume root spans
  propagators:
    - tracecontext
    - baggage
```

## OTEL Collector Sidecar Mode

For environments where a central gateway is not desired, or where network latency is a concern, the sidecar mode deploys a collector container alongside each application pod.

```yaml
# otel-sidecar-collector.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: sidecar
  namespace: production
spec:
  mode: sidecar                    # injected as a container sidecar
  image: otel/opentelemetry-collector-contrib:0.98.0
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 200
        spike_limit_mib: 50
      batch:
        send_batch_size: 256
        timeout: 1s

    exporters:
      otlp:
        endpoint: otel-gateway-collector.observability.svc.cluster.local:4317
        tls:
          insecure: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [otlp]
```

To trigger sidecar injection for a specific pod, add the annotation:

```yaml
metadata:
  annotations:
    sidecar.opentelemetry.io/inject: "true"
```

## Grafana LGTM Stack Integration

### Grafana Tempo Configuration

Tempo receives traces from the OTEL Collector and provides a trace storage backend with search and span metrics generation.

```yaml
# tempo-values.yaml (Helm values for grafana/tempo-distributed)
tempo:
  storage:
    trace:
      backend: s3
      s3:
        bucket: prod-tempo-traces
        endpoint: s3.us-east-1.amazonaws.com
        region: us-east-1

  ingester:
    replicas: 3
    resources:
      requests:
        cpu: 1000m
        memory: 4Gi

  distributor:
    replicas: 2
    resources:
      requests:
        cpu: 500m
        memory: 1Gi

  querier:
    replicas: 2

  compactor:
    replicas: 1

  # Generate span metrics from traces (RED metrics per service+operation)
  metricsGenerator:
    enabled: true
    replicas: 1
    config:
      processors:
        - service-graphs
        - span-metrics
      storage:
        path: /var/tempo/generator/wal
        remote_write:
          - url: http://prometheus-operated.monitoring.svc.cluster.local:9090/api/v1/write
```

### Trace-to-Metric Correlation in Grafana

Configure Grafana data source links between Tempo and Prometheus for one-click navigation from a slow trace to the corresponding metric spike.

```json
{
  "datasource": {
    "uid": "tempo-prod",
    "type": "tempo"
  },
  "tracesToMetrics": {
    "datasourceUid": "prometheus-prod",
    "tags": [
      { "key": "service.name", "value": "service" },
      { "key": "span.name", "value": "operation" }
    ],
    "queries": [
      {
        "name": "Request rate",
        "query": "sum(rate(traces_spanmetrics_calls_total{$__tags}[5m]))"
      },
      {
        "name": "P99 latency",
        "query": "histogram_quantile(0.99, sum(rate(traces_spanmetrics_duration_milliseconds_bucket{$__tags}[5m])) by (le))"
      }
    ]
  },
  "tracesToLogs": {
    "datasourceUid": "loki-prod",
    "tags": ["service.name", "k8s.pod.name"],
    "spanStartTimeShift": "-1m",
    "spanEndTimeShift": "1m",
    "filterByTraceID": true,
    "filterBySpanID": false
  }
}
```

### Grafana Dashboard: Service Map and RED Metrics

The following PromQL queries power a service observability dashboard populated by span metrics generated from Tempo.

```promql
# Request rate per service (requests per second)
sum by (service) (
  rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m])
)

# Error rate per service (percentage)
sum by (service) (
  rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER", status_code="STATUS_CODE_ERROR"}[5m])
)
/
sum by (service) (
  rate(traces_spanmetrics_calls_total{span_kind="SPAN_KIND_SERVER"}[5m])
) * 100

# P99 latency per service (milliseconds)
histogram_quantile(0.99,
  sum by (service, le) (
    rate(traces_spanmetrics_duration_milliseconds_bucket{span_kind="SPAN_KIND_SERVER"}[5m])
  )
)
```

## Namespace-Level Instrumentation with Default CR

To automatically instrument all pods in a namespace without per-pod annotations, set a namespace-level default:

```yaml
# namespace-default-instrumentation.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: default
  namespace: staging                # applied to all pods in this namespace
spec:
  exporter:
    endpoint: http://otel-gateway-collector.observability.svc.cluster.local:4317
  propagators:
    - tracecontext
    - baggage
  sampler:
    type: parentbased_traceidratio
    argument: "1.0"                 # 100% sampling in staging
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.45b0
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.46.0
```

With this CR named `default` in the namespace, the annotation `instrumentation.opentelemetry.io/inject-java: "true"` without a CR name reference resolves to the `default` CR automatically.

## Production Considerations

### Resource Budgeting for Injected Init Containers

Each injected init container pulls the agent image (100–300 MB depending on language) on first use. Use an image pull policy of `IfNotPresent` and pre-cache agent images on nodes via a DaemonSet in large clusters.

```yaml
# agent-image-precache-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-agent-precache
  namespace: observability
spec:
  selector:
    matchLabels:
      app: otel-agent-precache
  template:
    metadata:
      labels:
        app: otel-agent-precache
    spec:
      initContainers:
        - name: precache-java
          image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
          command: ["/bin/true"]    # just pull the image, do nothing
        - name: precache-python
          image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.45b0
          command: ["/bin/true"]
        - name: precache-nodejs
          image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.46.0
          command: ["/bin/true"]
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 4Mi
```

### Avoiding Double-Instrumentation

If an application already uses manual OTEL SDK instrumentation, injecting the Java agent on top results in duplicate spans. Use the following annotation to skip injection for manually instrumented services:

```yaml
annotations:
  instrumentation.opentelemetry.io/inject-java: "false"
```

### Security Context for Go eBPF Instrumentation

Go eBPF instrumentation requires `SYS_PTRACE` and access to `/proc`. In clusters with restrictive Pod Security Standards, create a dedicated namespace or PSA exemption:

```bash
# Label the namespace to permit privileged eBPF sidecars
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/warn=privileged
```

For more restricted environments, use a dedicated namespace for Go services with elevated privileges rather than relaxing standards cluster-wide.

## Troubleshooting Auto-Instrumentation

### Injection Not Occurring

```bash
# Check the annotation is present and correctly spelled
kubectl get pod <pod-name> -n production -o jsonpath='{.metadata.annotations}' | jq .

# Check operator logs for webhook decisions
kubectl logs -n opentelemetry-operator-system \
  deployment/opentelemetry-operator-controller-manager \
  -c manager | grep -i "inject\|webhook\|error"

# Verify the Instrumentation CR exists in the target namespace
kubectl get instrumentation -n production
```

### Agent Initialization Failures

```bash
# Check init container logs for agent extraction errors
kubectl logs <pod-name> -n production -c opentelemetry-auto-instrumentation-java

# Common Java agent startup issues:
# - JAVA_TOOL_OPTIONS not being picked up (check JVM startup flags)
# - ClassLoader conflicts with frameworks like OSGi

# Increase agent log level for debugging
kubectl set env deployment/order-service \
  OTEL_JAVAAGENT_LOGGING=debug -n production
```

### Spans Not Appearing in Tempo

```bash
# Confirm the collector is receiving spans
kubectl port-forward svc/otel-gateway-collector 8888:8888 -n observability
curl -s http://localhost:8888/metrics | grep otelcol_receiver_accepted_spans

# Check for exporter errors
kubectl logs deployment/otel-gateway-collector -n observability | grep -i "error\|refused\|retry"

# Verify Tempo is receiving data
kubectl port-forward svc/tempo-query-frontend 3200:3200 -n observability
curl "http://localhost:3200/api/traces?service=order-service&limit=5" | jq '.traces | length'
```

## Summary

The OpenTelemetry Operator delivers zero-code observability for Kubernetes workloads through admission webhook mutation. Key deployment decisions:

- Deploy a gateway-mode `OpenTelemetryCollector` for centralized processing, tail sampling, and fan-out to multiple backends
- Create per-namespace `Instrumentation` CRs scoped to the appropriate environment profile
- Use `parentbased_traceidratio` for SDK-level head sampling combined with tail sampling in the collector for error and latency-based full retention
- Enable all three propagators (`tracecontext`, `baggage`, `b3multi`) to handle both modern and legacy services during migration windows
- Pre-cache agent images on nodes to avoid cold-start pod initialization delays
- Integrate Tempo span metrics generation to populate RED metric dashboards without separate instrumentation work

The combination of auto-instrumentation, tail sampling, and Grafana LGTM stack provides complete trace-to-metric-to-log correlation with minimal operational overhead.
