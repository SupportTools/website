---
title: "Kubernetes OpenTelemetry Operator: Auto-Instrumentation for Go, Java, and Python"
date: 2029-02-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenTelemetry", "Observability", "Go", "Java", "Python"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete enterprise guide to deploying the OpenTelemetry Operator on Kubernetes for zero-code auto-instrumentation of Go, Java, and Python microservices, including collector configuration, sampling strategies, and Jaeger integration."
more_link: "yes"
url: "/kubernetes-opentelemetry-operator-auto-instrumentation/"
---

Manual OpenTelemetry instrumentation requires developers to add SDK initialization code, create spans, propagate context across service boundaries, and maintain the instrumentation as code evolves. The OpenTelemetry Operator for Kubernetes eliminates this burden by injecting auto-instrumentation libraries at pod startup using init containers and environment variable injection — zero application code changes required for basic trace and metric collection.

This guide covers operator installation, language-specific auto-instrumentation configuration for Go, Java, and Python, collector pipeline setup with sampling, and the production considerations that separate a proof-of-concept from an enterprise observability system.

<!--more-->

## OpenTelemetry Operator Architecture

The OpenTelemetry Operator extends Kubernetes with three custom resource definitions:

- **OpenTelemetryCollector**: Deploys an OTel collector as Deployment, DaemonSet, StatefulSet, or Sidecar
- **Instrumentation**: Defines auto-instrumentation settings per language
- **OpAMPBridge**: Connects collectors to the OpAMP management protocol (advanced configuration management)

Auto-instrumentation works through a mutating admission webhook. When a pod with the `instrumentation.opentelemetry.io/inject-*` annotation is created, the webhook injects:
1. An init container that copies the instrumentation library into a shared volume
2. Environment variables pointing the application to the library and to the collector endpoint
3. LD_PRELOAD or classpath modifications specific to each language runtime

```
Pod creation → Admission webhook → Init container injected
  → Application container starts with modified environment
  → Auto-instrumentation library loaded → Traces/metrics sent to collector
```

## Operator Installation

```bash
# Install cert-manager (required by the operator's webhook)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml

# Wait for cert-manager to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=controller \
  -n cert-manager --timeout=120s

# Install the OpenTelemetry Operator
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/download/v0.96.0/opentelemetry-operator.yaml

# Verify operator is running
kubectl get pods -n opentelemetry-operator-system
kubectl get crd | grep opentelemetry

# Check operator version and supported components
kubectl describe deployment -n opentelemetry-operator-system opentelemetry-operator-controller-manager | \
  grep -A5 "Image:"
```

## Collector Deployment

The collector is the central telemetry processing pipeline. Deploy it as a DaemonSet so every node has a local collector endpoint, minimizing cross-node telemetry traffic.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-collector
  namespace: observability
spec:
  mode: daemonset
  serviceAccount: otel-collector
  image: otel/opentelemetry-collector-contrib:0.96.0
  tolerations:
    - operator: Exists
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  volumeMounts:
    - name: varlogpods
      mountPath: /var/log/pods
      readOnly: true
  volumes:
    - name: varlogpods
      hostPath:
        path: /var/log/pods
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

      # Kubernetes infrastructure metrics
      k8s_cluster:
        auth_type: serviceAccount
        collection_interval: 30s
        node_conditions_to_report:
          - Ready
          - MemoryPressure
          - DiskPressure

      kubeletstats:
        auth_type: serviceAccount
        collection_interval: 20s
        endpoint: https://${env:K8S_NODE_NAME}:10250
        insecure_skip_verify: true
        metric_groups:
          - node
          - pod
          - container

    processors:
      # Batch processor: reduces export calls
      batch:
        send_batch_size: 512
        send_batch_max_size: 1024
        timeout: 5s

      # Memory limiter: prevents OOM
      memory_limiter:
        check_interval: 1s
        limit_percentage: 80
        spike_limit_percentage: 25

      # Add Kubernetes metadata to all telemetry
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        extract:
          metadata:
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.pod.start_time
            - k8s.namespace.name
            - k8s.deployment.name
            - k8s.statefulset.name
            - k8s.daemonset.name
            - k8s.cronjob.name
            - k8s.job.name
            - k8s.node.name
          labels:
            - tag_name: app.label.version
              key: app.kubernetes.io/version
              from: pod
            - tag_name: app.label.component
              key: app.kubernetes.io/component
              from: pod
        pod_association:
          - sources:
              - from: resource_attribute
                name: k8s.pod.ip
          - sources:
              - from: connection

      # Tail sampling: keep errors and slow traces, sample the rest
      tail_sampling:
        decision_wait: 10s
        num_traces: 50000
        expected_new_traces_per_sec: 200
        policies:
          - name: errors-policy
            type: status_code
            status_code:
              status_codes: [ERROR]
          - name: slow-traces-policy
            type: latency
            latency:
              threshold_ms: 500
          - name: probabilistic-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 10
          - name: always-sample-critical
            type: string_attribute
            string_attribute:
              key: sampling.priority
              values: ["critical"]

      # Resource detection: add cloud/host info
      resourcedetection:
        detectors: [env, ec2, eks, gcp, azure, k8snode]
        timeout: 5s
        override: false

    exporters:
      # Jaeger for trace storage
      jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:14250
        tls:
          insecure: false
          ca_file: /etc/otel/certs/ca.crt

      # Prometheus for metrics
      prometheusremotewrite:
        endpoint: https://prometheus.observability.svc.cluster.local:9090/api/v1/write
        tls:
          insecure_skip_verify: false

      # Debug exporter for troubleshooting (disable in production)
      debug:
        verbosity: normal
        sampling_initial: 5
        sampling_thereafter: 200

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
          processors: [memory_limiter, k8sattributes, resourcedetection, tail_sampling, batch]
          exporters: [jaeger]
        metrics:
          receivers: [otlp, k8s_cluster, kubeletstats]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [prometheusremotewrite]
        logs:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [debug]
      telemetry:
        logs:
          level: info
        metrics:
          level: detailed
          address: 0.0.0.0:8888
```

## Java Auto-Instrumentation

Java instrumentation uses the OpenTelemetry Java Agent, which instruments over 100 frameworks automatically including Spring Boot, Quarkus, Micronaut, gRPC, JDBC, and Kafka clients.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-instrumentation
  namespace: payments
spec:
  exporter:
    endpoint: http://otel-collector-collector.observability.svc.cluster.local:4317
  propagators:
    - tracecontext
    - baggage
    - b3multi
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"  # 10% sample rate; override per-service with annotation
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
    env:
      - name: OTEL_INSTRUMENTATION_SPRING_WEBMVC_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_KAFKA_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_REDIS_ENABLED
        value: "true"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_EXPORTER_OTLP_PROTOCOL
        value: "grpc"
      # JVM metrics
      - name: OTEL_INSTRUMENTATION_RUNTIME_METRICS_ENABLED
        value: "true"
      # Capture HTTP request/response headers for debugging
      - name: OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST
        value: "X-Request-ID,X-Correlation-ID,X-User-ID"
```

Enable instrumentation on a Java deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments
spec:
  template:
    metadata:
      annotations:
        # Inject Java auto-instrumentation
        instrumentation.opentelemetry.io/inject-java: "java-instrumentation"
        # Override sample rate for this critical service
        instrumentation.opentelemetry.io/otel-go-auto-target-exe: ""
      labels:
        app: payments-api
    spec:
      containers:
        - name: payments-api
          image: registry.company.com/payments/api:3.2.1
          env:
            # Service name and version for telemetry
            - name: OTEL_SERVICE_NAME
              value: "payments-api"
            - name: OTEL_SERVICE_VERSION
              valueFrom:
                fieldRef:
                  fieldPath: metadata.labels['app.kubernetes.io/version']
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "service.namespace=payments,deployment.environment=production"
```

## Python Auto-Instrumentation

Python auto-instrumentation uses `opentelemetry-instrument` as the entrypoint wrapper.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: python-instrumentation
  namespace: analytics
spec:
  exporter:
    endpoint: http://otel-collector-collector.observability.svc.cluster.local:4318
  propagators:
    - tracecontext
    - baggage
  sampler:
    type: parentbased_traceidratio
    argument: "0.05"  # 5% for high-volume analytics service
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.44b0
    env:
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: "true"
      - name: OTEL_EXPORTER_OTLP_PROTOCOL
        value: "http/protobuf"
      - name: OTEL_PYTHON_DISABLED_INSTRUMENTATIONS
        value: ""  # comma-separated list to disable specific instrumentations
      - name: OTEL_INSTRUMENTATION_HTTP_CAPTURE_HEADERS_SERVER_REQUEST
        value: "X-Request-ID,X-Correlation-ID"
      - name: OTEL_METRICS_EXPORTER
        value: "otlp"
      - name: OTEL_LOGS_EXPORTER
        value: "otlp"
```

Enable on Python deployment:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: analytics-processor
  namespace: analytics
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-python: "python-instrumentation"
      labels:
        app: analytics-processor
    spec:
      containers:
        - name: processor
          image: registry.company.com/analytics/processor:1.5.0
          env:
            - name: OTEL_SERVICE_NAME
              value: "analytics-processor"
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "service.namespace=analytics,deployment.environment=production"
```

## Go Auto-Instrumentation

Go auto-instrumentation is the most complex of the three because Go compiles to native binaries without a runtime VM. The OpenTelemetry eBPF-based Go instrumentation (opentelemetry-go-instrumentation) instruments Go processes at the kernel level using eBPF, attaching to uprobe hooks on function entry/exit.

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: go-instrumentation
  namespace: platform
spec:
  exporter:
    endpoint: http://otel-collector-collector.observability.svc.cluster.local:4317
  propagators:
    - tracecontext
    - baggage
  go:
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.14.0-alpha
    env:
      - name: OTEL_GO_AUTO_SHOW_VERIFIER_LOG
        value: "false"
      - name: OTEL_GO_AUTO_TARGET_EXE
        value: "/app/service"  # Path to the Go binary inside the container
```

Go instrumentation requires elevated privileges for the init container (eBPF):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-processor
  namespace: platform
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-go: "go-instrumentation"
        instrumentation.opentelemetry.io/otel-go-auto-target-exe: "/app/order-processor"
      labels:
        app: order-processor
    spec:
      # Go eBPF instrumentation requires host PID namespace to attach probes
      shareProcessNamespace: true
      containers:
        - name: order-processor
          image: registry.company.com/platform/order-processor:2.0.5
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
          env:
            - name: OTEL_SERVICE_NAME
              value: "order-processor"
            - name: OTEL_RESOURCE_ATTRIBUTES
              value: "service.namespace=platform,deployment.environment=production"
```

## RBAC for Collector

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-collector
  namespace: observability
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-collector
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/proxy
      - nodes/stats
      - pods
      - endpoints
      - namespaces
      - services
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources:
      - replicasets
      - deployments
      - daemonsets
      - statefulsets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["get", "list", "watch"]
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
    namespace: observability
```

## Verifying Auto-Instrumentation

```bash
# Check that the instrumentation CR is valid
kubectl get instrumentation -A
kubectl describe instrumentation java-instrumentation -n payments

# Check collector is running and receiving data
kubectl get pods -n observability -l app.kubernetes.io/name=otel-collector
kubectl logs -n observability -l app.kubernetes.io/name=otel-collector --tail=50

# After deploying an instrumented pod, verify the init container ran
kubectl describe pod -n payments $(kubectl get pods -n payments -l app=payments-api -o name | head -1)
# Look for: "opentelemetry-auto-instrumentation" init container with status Completed

# Check that JAVA_TOOL_OPTIONS was injected
kubectl exec -n payments payments-api-xxxxx -- printenv | grep -E "JAVA_TOOL|OTEL"

# Port-forward to collector's zpages for live pipeline stats
kubectl port-forward -n observability \
  $(kubectl get pods -n observability -l app.kubernetes.io/name=otel-collector -o name | head -1) \
  55679:55679

# Then visit: http://localhost:55679/debug/tracez
# Shows: spans received per service, pipeline stats

# Check collector metrics
kubectl port-forward -n observability \
  $(kubectl get pods -n observability -l app.kubernetes.io/name=otel-collector -o name | head -1) \
  8888:8888
curl -s http://localhost:8888/metrics | grep otelcol_receiver_accepted_spans
```

## Production Considerations

**Memory and CPU sizing**: Each collector pod on a busy node (50+ instrumented pods) typically uses 200-400MB RAM. The tail sampling processor holds spans in memory until a decision is made — size `num_traces` based on your `decision_wait` × spans per second.

**Sampling strategy**: Head sampling (at point of request entry) is simple but cannot make decisions based on outcome (e.g., keep all errors). Tail sampling in the collector sees the full trace before deciding, but requires collector-side state and careful sharding when using multiple collector replicas.

**Trace context propagation**: The `propagators` list must match across all services. B3 and W3C TraceContext headers are incompatible — using both simultaneously causes broken traces. Standardize on W3C TraceContext for new deployments; add B3 support only for legacy service interop.

**Go instrumentation limitations**: eBPF-based Go instrumentation currently supports net/http, gRPC (google.golang.org/grpc), and database/sql. Custom application spans still require manual SDK instrumentation. The eBPF approach also requires kernel 4.18+ and the `SYS_PTRACE` capability.

**Secret handling**: The collector configuration should reference Vault or Kubernetes secrets for exporter credentials, not hardcoded values. Use the `env:` substitution syntax in collector config YAML, backed by Kubernetes secret environment variables.
