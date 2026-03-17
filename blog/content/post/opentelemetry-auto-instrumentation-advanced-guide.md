---
title: "OpenTelemetry Auto-Instrumentation on Kubernetes: Zero-Code Observability"
date: 2027-12-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenTelemetry", "Observability", "Tracing", "Auto-Instrumentation", "Jaeger", "Tempo", "Java", "Python"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to OpenTelemetry auto-instrumentation on Kubernetes using the OTel Operator, covering Java, Python, Node.js, and Go injection, sampling strategies, Jaeger and Tempo backends, and baggage propagation."
more_link: "yes"
url: /opentelemetry-auto-instrumentation-advanced-guide/
---

OpenTelemetry auto-instrumentation eliminates the need to modify application source code to emit traces, metrics, and logs. The OpenTelemetry Operator for Kubernetes injects instrumentation agents and environment variables at pod startup, providing observability coverage across polyglot microservice environments without requiring coordination with development teams. This guide covers the full production deployment of the OTel Operator, configuration of language-specific instrumentation, sampling strategies, and integration with Jaeger and Grafana Tempo backends.

<!--more-->

# OpenTelemetry Auto-Instrumentation on Kubernetes: Zero-Code Observability

## Architecture Overview

The OpenTelemetry Kubernetes deployment model consists of four components:

1. **OpenTelemetry Operator** - Kubernetes operator that manages OTel CRDs and performs pod mutation
2. **Instrumentation CRD** - Defines which SDK versions to inject and how to configure them
3. **OpenTelemetry Collector** - Receives, processes, and exports telemetry data
4. **Backend** - Jaeger, Grafana Tempo, or any OTLP-compatible storage

```
Pod (annotated)
    └── Mutating Webhook (OTel Operator)
            └── Init Container injection (SDK agent)
            └── Environment variable injection (OTLP endpoint, service name, etc.)
                    └── Application emits OTLP spans
                            └── OTel Collector (DaemonSet or Deployment)
                                    └── Jaeger / Tempo / OTLP backend
```

The mutation happens transparently at pod creation time. The application binary is unchanged; only the runtime environment is modified.

## Installing the OpenTelemetry Operator

### Prerequisites

The OTel Operator requires cert-manager for webhook TLS certificate management.

```bash
# Install cert-manager if not already present
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --version v1.14.0

# Wait for cert-manager to be ready
kubectl wait --for=condition=Available deployment/cert-manager \
  -n cert-manager --timeout=120s
```

### Operator Installation via Helm

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --set "manager.collectorImage.repository=otel/opentelemetry-collector-k8s" \
  --set admissionWebhooks.certManager.enabled=true \
  --version 0.50.0

# Verify operator is running
kubectl get pods -n opentelemetry-operator-system
kubectl get crd | grep opentelemetry
```

Expected CRDs:

```
instrumentations.opentelemetry.io
opampbridges.opentelemetry.io
opentelemetrycollectors.opentelemetry.io
```

## Deploying the OpenTelemetry Collector

The Collector acts as the telemetry hub. Deploy it as a DaemonSet for low-latency local collection.

### Collector Configuration

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  mode: daemonset
  serviceAccount: otel-collector
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

    processors:
      batch:
        timeout: 5s
        send_batch_size: 1024
        send_batch_max_size: 2048
      memory_limiter:
        check_interval: 1s
        limit_mib: 512
        spike_limit_mib: 128
      resource:
        attributes:
          - key: k8s.cluster.name
            value: "prod-cluster"
            action: insert
      k8sattributes:
        auth_type: "serviceAccount"
        passthrough: false
        filter:
          node_from_env_var: KUBE_NODE_NAME
        extract:
          metadata:
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.deployment.name
            - k8s.namespace.name
            - k8s.node.name
            - k8s.pod.start_time
          labels:
            - tag_name: app.label.component
              key: app.kubernetes.io/component
              from: pod
        pod_association:
          - sources:
              - from: resource_attribute
                name: k8s.pod.ip
          - sources:
              - from: connection

    exporters:
      otlp/jaeger:
        endpoint: "jaeger-collector.monitoring.svc.cluster.local:4317"
        tls:
          insecure: false
          ca_file: /var/run/secrets/jaeger-ca/ca.crt
      otlp/tempo:
        endpoint: "tempo-distributor.monitoring.svc.cluster.local:4317"
        tls:
          insecure: true
      prometheusremotewrite:
        endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"
      logging:
        loglevel: warn

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp/jaeger, otlp/tempo]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [prometheusremotewrite]
        logs:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [logging]
```

### Collector RBAC

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
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["extensions"]
    resources: ["replicasets"]
    verbs: ["get", "list", "watch"]
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

## Instrumentation CRD: Configuring Auto-Instrumentation

The `Instrumentation` CRD defines which SDK to inject and how to configure it per language.

### Comprehensive Instrumentation Resource

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: default-instrumentation
  namespace: default
spec:
  # Exporter endpoint - points to local Collector DaemonSet
  exporter:
    endpoint: http://$(KUBE_NODE_NAME):4318

  # Propagation formats for distributed tracing
  propagators:
    - tracecontext
    - baggage
    - b3

  # Sampling configuration
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"   # 10% sampling rate in production

  # Environment variables injected into all instrumented pods
  env:
    - name: OTEL_SERVICE_NAMESPACE
      valueFrom:
        fieldRef:
          fieldPath: metadata.namespace
    - name: OTEL_RESOURCE_ATTRIBUTES
      value: "deployment.environment=production,k8s.cluster.name=prod"

  # Java instrumentation
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.4.0
    env:
      - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_SPRING_WEB_ENABLED
        value: "true"
      - name: OTEL_JAVAAGENT_LOGGING
        value: "none"
      - name: JAVA_TOOL_OPTIONS
        value: "-XX:+UseContainerSupport"

  # Python instrumentation
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.46b0
    env:
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: "true"
      - name: OTEL_PYTHON_DJANGO_INSTRUMENT
        value: "true"
      - name: OTEL_PYTHON_FLASK_INSTRUMENT
        value: "true"
      - name: OTEL_PYTHON_FASTAPI_INSTRUMENT
        value: "true"

  # Node.js instrumentation
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.50.0
    env:
      - name: OTEL_NODE_ENABLED_INSTRUMENTATIONS
        value: "http,express,grpc,pg,redis,mongodb"
      - name: NODE_OPTIONS
        value: "--require @opentelemetry/auto-instrumentations-node/register"

  # .NET instrumentation
  dotnet:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-dotnet:1.7.0
    env:
      - name: OTEL_DOTNET_AUTO_TRACES_CONSOLE_EXPORTER_ENABLED
        value: "false"

  # Go instrumentation (eBPF-based, requires specific setup)
  go:
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.14.0-alpha
    env:
      - name: OTEL_GO_AUTO_SHOW_VERIFIER_LOG
        value: "false"
```

## Enabling Auto-Instrumentation via Pod Annotations

Auto-instrumentation is activated by adding a single annotation to a Pod, Deployment, StatefulSet, or DaemonSet.

### Java Application

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spring-boot-api
  namespace: default
spec:
  replicas: 3
  selector:
    matchLabels:
      app: spring-boot-api
  template:
    metadata:
      labels:
        app: spring-boot-api
      annotations:
        # Enable Java auto-instrumentation
        instrumentation.opentelemetry.io/inject-java: "default/default-instrumentation"
        # Override service name
        instrumentation.opentelemetry.io/inject-sdk: "true"
    spec:
      containers:
        - name: api
          image: company/spring-boot-api:1.0.0
          ports:
            - containerPort: 8080
          env:
            - name: OTEL_SERVICE_NAME
              value: "spring-boot-api"
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1Gi
```

### Python Application

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: django-backend
  namespace: default
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-python: "true"
      labels:
        app: django-backend
    spec:
      containers:
        - name: django
          image: company/django-app:2.1.0
          env:
            - name: OTEL_SERVICE_NAME
              value: "django-backend"
            - name: DJANGO_SETTINGS_MODULE
              value: "myapp.settings"
```

### Node.js Application

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: express-api
  namespace: default
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-nodejs: "true"
      labels:
        app: express-api
    spec:
      containers:
        - name: express
          image: company/express-api:3.0.0
          env:
            - name: OTEL_SERVICE_NAME
              value: "express-api"
```

### Go Application (eBPF-based)

Go auto-instrumentation uses eBPF rather than a traditional agent, requiring elevated privileges:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-microservice
  namespace: default
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-go: "true"
        instrumentation.opentelemetry.io/otel-go-auto-target-exe: "/app/server"
      labels:
        app: go-microservice
    spec:
      shareProcessNamespace: true
      containers:
        - name: server
          image: company/go-service:1.0.0
          env:
            - name: OTEL_SERVICE_NAME
              value: "go-microservice"
          securityContext:
            runAsUser: 1000
```

## Sampling Strategies

Production environments cannot sample 100% of traces. The OTel Operator supports several sampling strategies.

### Parentbased Ratio Sampling

```yaml
sampler:
  type: parentbased_traceidratio
  argument: "0.05"   # 5% of traces
```

### Always-On for Development

```yaml
sampler:
  type: always_on
```

### Head-Based Sampling with Tail-Based Override

For more sophisticated sampling, deploy a Tail Sampling Processor in the Collector:

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    expected_new_traces_per_sec: 10000
    policies:
      - name: error-policy
        type: status_code
        status_code:
          status_codes: [ERROR]
      - name: slow-traces-policy
        type: latency
        latency:
          threshold_ms: 1000
      - name: rate-limiting-policy
        type: rate_limiting
        rate_limiting:
          spans_per_second: 1000
      - name: composite-policy
        type: composite
        composite:
          max_total_spans_per_second: 5000
          policy_order: [error-policy, slow-traces-policy, rate-limiting-policy]
          rate_allocation:
            - policy: error-policy
              percent: 40
            - policy: slow-traces-policy
              percent: 40
            - policy: rate-limiting-policy
              percent: 20
```

## Resource Detection

The K8s Attributes Processor automatically enriches spans with Kubernetes metadata. Additional resource detectors enhance this further:

```yaml
processors:
  resourcedetection:
    detectors: [env, system, gcp, aws, azure]
    timeout: 5s
    override: false
    system:
      hostname_sources: ["dns", "os"]
    gcp:
      # Auto-detected when running on GKE
    aws:
      # Auto-detected when running on EKS
```

### Custom Resource Attributes

```yaml
processors:
  resource:
    attributes:
      - key: k8s.cluster.name
        value: "prod-us-east-1"
        action: insert
      - key: deployment.environment
        value: "production"
        action: insert
      - key: service.version
        from_attribute: k8s.pod.labels.version
        action: insert
```

## Baggage Propagation

W3C Baggage allows propagating key-value pairs across service boundaries. The OTel Operator configures the baggage propagator automatically.

### Injecting Baggage at the Edge

```yaml
# HTTPRoute filter to inject baggage at the gateway level
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: baggage-injection
  namespace: gateway-system
spec:
  rules:
    - filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            add:
              - name: baggage
                value: "userId=unknown,tenantId=unknown"
```

### Using Baggage in Application Code (Java example)

```java
// The auto-instrumentation agent handles context propagation
// Application code can access baggage without manual setup
import io.opentelemetry.api.baggage.Baggage;

String userId = Baggage.current().getEntryValue("userId");
String tenantId = Baggage.current().getEntryValue("tenantId");
```

## Jaeger Backend Integration

### Deploying Jaeger via Operator

```bash
kubectl apply -f https://github.com/jaegertracing/jaeger-operator/releases/latest/download/jaeger-operator.yaml \
  -n observability
```

```yaml
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-production
  namespace: monitoring
spec:
  strategy: production
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: https://elasticsearch.monitoring.svc.cluster.local:9200
        tls:
          ca: /es/certificates/ca.crt
    secretName: jaeger-es-secret
  collector:
    maxReplicas: 10
    resources:
      limits:
        cpu: 1000m
        memory: 1Gi
  query:
    replicas: 2
    metricsStorage:
      type: prometheus
    options:
      query:
        base-path: /jaeger
  ingress:
    enabled: true
    hosts:
      - jaeger.example.com
```

## Grafana Tempo Backend Integration

Tempo provides cost-effective trace storage with Prometheus-style label-based querying.

### Tempo Deployment

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: tempo
  namespace: monitoring
spec:
  chart: tempo-distributed
  repo: https://grafana.github.io/helm-charts
  version: "1.9.0"
  valuesContent: |-
    storage:
      trace:
        backend: s3
        s3:
          bucket: company-traces
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
    distributor:
      replicas: 3
    ingester:
      replicas: 5
      config:
        replication_factor: 3
    querier:
      replicas: 2
    compactor:
      replicas: 1
    queryFrontend:
      replicas: 2
    metricsGenerator:
      enabled: true
      replicas: 2
      config:
        storage:
          remote_write:
            - url: http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write
```

### Connecting Grafana to Tempo

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  tempo.yaml: |
    apiVersion: 1
    datasources:
      - name: Tempo
        type: tempo
        url: http://tempo-query-frontend.monitoring.svc.cluster.local:3100
        jsonData:
          httpMethod: GET
          serviceMap:
            datasourceUid: prometheus
          nodeGraph:
            enabled: true
          traceQuery:
            timeShiftEnabled: true
            spanStartTimeShift: '-30m'
            spanEndTimeShift: '30m'
          spanBar:
            datasourceUid: prometheus
        isDefault: false
```

## Namespace-Wide Auto-Instrumentation

Rather than annotating individual pods, enable auto-instrumentation for an entire namespace:

```yaml
# Create namespace-scoped Instrumentation with namespace annotation
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-instrumentation
  namespace: java-apps
spec:
  exporter:
    endpoint: http://otel-collector.monitoring.svc.cluster.local:4318
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.4.0
```

Then annotate the namespace (rather than individual pods):

```bash
# Annotate namespace to enable auto-instrumentation for all new pods
kubectl annotate namespace java-apps \
  instrumentation.opentelemetry.io/inject-java=java-instrumentation

# Verify annotation
kubectl get namespace java-apps -o jsonpath='{.metadata.annotations}'
```

Note: namespace-level annotation only affects new pods created after annotation. Existing pods require a rollout restart.

```bash
# Restart all deployments in namespace to pick up instrumentation
kubectl rollout restart deployment -n java-apps
```

## Verifying Auto-Instrumentation

### Check Init Container Injection

```bash
# Verify OTel init container was injected
kubectl describe pod <pod-name> -n <namespace> | grep -A 20 "Init Containers"

# Expected output should show opentelemetry-auto-instrumentation init container
# Init Containers:
#   opentelemetry-auto-instrumentation:
#     Image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.4.0
#     State: Terminated (Completed)
```

### Verify Environment Variables

```bash
# Check injected environment variables
kubectl exec -n <namespace> <pod-name> -- env | grep -E "OTEL|JAVA_TOOL"

# Expected output:
# OTEL_TRACES_EXPORTER=otlp
# OTEL_EXPORTER_OTLP_ENDPOINT=http://10.0.1.5:4318
# OTEL_EXPORTER_OTLP_TIMEOUT=20000
# OTEL_RESOURCE_ATTRIBUTES=k8s.container.name=api,...
# OTEL_SERVICE_NAME=spring-boot-api
# JAVA_TOOL_OPTIONS=-javaagent:/otel-auto-instrumentation-java/javaagent.jar
```

### Test Trace Generation

```bash
# Generate a test request to a instrumented service
kubectl run trace-test --image=curlimages/curl --restart=Never \
  --rm -it -- curl -v http://spring-boot-api.default.svc.cluster.local:8080/health

# Query Jaeger for traces from this service
kubectl port-forward svc/jaeger-query -n monitoring 16686:16686 &
# Open http://localhost:16686 and search for service "spring-boot-api"
```

## Monitoring the OTel Collector

### Collector Metrics

The OTel Collector exposes Prometheus metrics on port 8888:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: otel-collector
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: opentelemetry-collector
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics
```

### Key Metrics to Monitor

```promql
# Span receive rate
rate(otelcol_receiver_accepted_spans{receiver="otlp"}[5m])

# Span export rate
rate(otelcol_exporter_sent_spans{exporter="otlp/jaeger"}[5m])

# Dropped spans (indicates backpressure)
rate(otelcol_processor_dropped_spans[5m])

# Queue utilization
otelcol_exporter_queue_size / otelcol_exporter_queue_capacity

# Memory usage
process_resident_memory_bytes{job="otel-collector"}
```

### Alert for Collector Issues

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: otel-collector-alerts
  namespace: monitoring
spec:
  groups:
    - name: otel-collector
      rules:
        - alert: OtelCollectorDroppingSpans
          expr: rate(otelcol_processor_dropped_spans[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "OTel Collector is dropping spans"
            description: "Collector {{ $labels.instance }} is dropping spans at {{ $value }} spans/sec"
        - alert: OtelCollectorQueueFull
          expr: |
            otelcol_exporter_queue_size / otelcol_exporter_queue_capacity > 0.9
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "OTel Collector export queue nearly full"
```

## Instrumentation Resource Scoping

Multiple Instrumentation resources can target different teams or namespaces with different configurations.

### Per-Team Instrumentation Configuration

```yaml
# High-traffic namespace - aggressive sampling
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: high-traffic-instrumentation
  namespace: payments
spec:
  exporter:
    endpoint: http://otel-collector.monitoring.svc.cluster.local:4318
  sampler:
    type: parentbased_traceidratio
    argument: "0.01"   # 1% for very high volume
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.4.0
---
# Low-traffic namespace - higher sampling
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: low-traffic-instrumentation
  namespace: admin-tools
spec:
  exporter:
    endpoint: http://otel-collector.monitoring.svc.cluster.local:4318
  sampler:
    type: parentbased_traceidratio
    argument: "0.5"   # 50% for low volume internal tools
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.4.0
```

## Troubleshooting Auto-Instrumentation

### Init Container Fails to Start

```bash
# Check init container logs
kubectl logs <pod-name> -n <namespace> -c opentelemetry-auto-instrumentation

# Common causes:
# 1. Insufficient resource limits - init container needs memory to copy agent
# 2. Volume mount conflict - check if /otel-auto-instrumentation path is taken
kubectl describe pod <pod-name> -n <namespace> | grep -A 5 "Events"
```

### No Spans Appearing in Backend

```bash
# 1. Verify collector is receiving spans
kubectl logs -n monitoring -l app.kubernetes.io/name=opentelemetry-collector \
  --tail=50 | grep -i "error\|receiver"

# 2. Check OTLP endpoint is reachable from pod
kubectl exec -n <namespace> <pod-name> -- \
  wget -qO- http://otel-collector.monitoring.svc.cluster.local:4318/v1/traces \
  --post-data '{}' 2>&1 | head -5

# 3. Check operator logs
kubectl logs -n opentelemetry-operator-system \
  -l app.kubernetes.io/name=opentelemetry-operator --tail=100 \
  | grep -i "error\|mutate\|instrument"
```

### Wrong SDK Version

```bash
# Check which Instrumentation resource is being used
kubectl get instrumentation -A

# Verify annotation points to correct resource
kubectl get pod <pod-name> -n <namespace> \
  -o jsonpath='{.metadata.annotations}' | jq
```

## Summary

OpenTelemetry auto-instrumentation on Kubernetes provides zero-code observability for Java, Python, Node.js, .NET, and Go applications. The OTel Operator's mutating webhook injects SDK agents and configuration at pod startup without requiring application code changes. This enables platform teams to roll out distributed tracing across existing deployments by adding a single annotation.

The key operational considerations are: collector sizing for the expected span throughput, appropriate sampling rates to balance visibility with storage costs, and tail-based sampling to ensure errors and slow traces are always captured. The K8s Attributes Processor automatically enriches every span with pod, namespace, and deployment metadata, making correlation between traces and Kubernetes events straightforward.

For production deployment, the recommended stack is: OTel Operator with Helm, DaemonSet Collector with tail sampling, and Grafana Tempo for cost-effective S3-backed storage with Prometheus-compatible metrics generation.
