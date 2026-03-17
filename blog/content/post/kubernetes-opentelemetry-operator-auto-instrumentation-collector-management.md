---
title: "Kubernetes OpenTelemetry Operator: Auto-Instrumentation and Collector Management"
date: 2031-04-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenTelemetry", "Observability", "Tracing", "Operator", "Jaeger", "Tempo", "Prometheus"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying the OpenTelemetry Operator on Kubernetes, configuring auto-instrumentation for Java, Python, Node.js, and Go applications, and managing OpenTelemetryCollector CRs in daemonset, deployment, and sidecar modes."
more_link: "yes"
url: "/kubernetes-opentelemetry-operator-auto-instrumentation-collector-management/"
---

The OpenTelemetry Operator for Kubernetes automates the deployment and configuration of OpenTelemetry Collectors and injects auto-instrumentation libraries into application pods without requiring code changes. This guide covers the complete lifecycle: operator installation, Instrumentation CR configuration, OpenTelemetryCollector modes, pipeline design, and exporting telemetry to Jaeger, Tempo, and Prometheus in production environments.

<!--more-->

# Kubernetes OpenTelemetry Operator: Auto-Instrumentation and Collector Management

## Section 1: Architecture Overview

The OpenTelemetry Operator extends Kubernetes with three primary capabilities:

1. **OpenTelemetryCollector CR** — manages collector deployments as Deployments, DaemonSets, StatefulSets, or Sidecars
2. **Instrumentation CR** — defines auto-instrumentation configuration injected via mutating admission webhooks
3. **OpAMP Bridge** — manages remote collector configuration via the OpAMP protocol

The operator runs as a standard Kubernetes controller and uses admission webhooks to mutate pods at creation time. When a pod is annotated with `instrumentation.opentelemetry.io/inject-java: "true"`, the webhook inspects the Instrumentation CR and injects an init container that copies the appropriate SDK into an emptyDir volume, then sets required environment variables on the application container.

### Component Interaction

```
                    ┌─────────────────────────────────┐
                    │   OpenTelemetry Operator Pod     │
                    │  ┌──────────────────────────┐   │
                    │  │  Controller Manager       │   │
                    │  │  - Reconciles OTelCol CR  │   │
                    │  │  - Reconciles Instr CR    │   │
                    │  └──────────────────────────┘   │
                    │  ┌──────────────────────────┐   │
                    │  │  Admission Webhook        │   │
                    │  │  - Pod mutation           │   │
                    │  │  - SDK injection          │   │
                    │  └──────────────────────────┘   │
                    └─────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ Java App Pod │  │Python App Pod│  │ Node.js Pod  │
    │ + javaagent  │  │ + sitecust.  │  │ + @otel/auto │
    └──────────────┘  └──────────────┘  └──────────────┘
              │                │                │
              └────────────────┴────────────────┘
                               │ OTLP gRPC/HTTP
                    ┌──────────┴───────────┐
                    │  OTelCollector       │
                    │  (DaemonSet or       │
                    │   Deployment)        │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
         ┌─────────┐    ┌──────────┐    ┌──────────┐
         │  Jaeger │    │  Tempo   │    │Prometheus│
         └─────────┘    └──────────┘    └──────────┘
```

## Section 2: Installing the OpenTelemetry Operator

### Prerequisites

The operator requires cert-manager for webhook certificate management. Install it first:

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.3/cert-manager.yaml
kubectl wait --for=condition=Available deployment --all -n cert-manager --timeout=120s
```

### Operator Installation via Helm

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --set "manager.collectorImage.repository=otel/opentelemetry-collector-contrib" \
  --set "manager.collectorImage.tag=0.96.0" \
  --set admissionWebhooks.certManager.enabled=true \
  --set manager.resources.requests.cpu=100m \
  --set manager.resources.requests.memory=128Mi \
  --set manager.resources.limits.cpu=500m \
  --set manager.resources.limits.memory=512Mi \
  --version 0.55.0
```

### Verify Installation

```bash
kubectl get pods -n opentelemetry-operator-system
# NAME                                                        READY   STATUS    RESTARTS   AGE
# opentelemetry-operator-controller-manager-xxxxxxxxx-xxxxx  2/2     Running   0          2m

kubectl get crd | grep opentelemetry
# instrumentations.opentelemetry.io
# opampbridges.opentelemetry.io
# opentelemetrycollectors.opentelemetry.io
```

### Production Helm Values

Save as `otel-operator-values.yaml`:

```yaml
manager:
  collectorImage:
    repository: otel/opentelemetry-collector-contrib
    tag: "0.96.0"

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

  env:
    - name: ENABLE_MULTI_INSTRUMENTATION
      value: "true"

  # Enable leader election for HA
  leaderElection:
    enabled: true

admissionWebhooks:
  certManager:
    enabled: true
    issuerRef:
      name: selfsigned-issuer
      kind: ClusterIssuer

  # Failure policy - Ignore allows pods to start even if webhook fails
  failurePolicy: Ignore

  timeoutSeconds: 10

# Enable RBAC for multi-namespace support
clusterRole:
  rules:
    - apiGroups: [""]
      resources: ["namespaces"]
      verbs: ["list", "watch"]

replicaCount: 2

podDisruptionBudget:
  enabled: true
  minAvailable: 1
```

## Section 3: OpenTelemetryCollector CR Modes

The OpenTelemetryCollector CR supports four deployment modes, each suited to different collection architectures.

### Mode 1: Deployment (Gateway Mode)

Best for centralized collection, processing, and fan-out to multiple backends:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: observability
spec:
  mode: deployment
  replicas: 2

  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 2Gi

  podDisruptionBudget:
    minAvailable: 1

  autoscaler:
    minReplicas: 2
    maxReplicas: 10
    targetCPUUtilization: 70
    targetMemoryUtilization: 80

  serviceAccount: otel-collector-sa

  tolerations:
    - key: "observability"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"

  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app.kubernetes.io/name: otel-gateway-collector
            topologyKey: kubernetes.io/hostname

  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 32
          http:
            endpoint: 0.0.0.0:4318
            cors:
              allowed_origins:
                - "https://*.example.com"

      # Collect collector's own metrics
      prometheus:
        config:
          scrape_configs:
            - job_name: 'otel-collector'
              scrape_interval: 30s
              static_configs:
                - targets: ['0.0.0.0:8888']

    processors:
      # Add cluster/environment metadata
      resource:
        attributes:
          - key: cluster.name
            value: production-us-east-1
            action: upsert
          - key: deployment.environment
            value: production
            action: upsert

      # Batch for performance
      batch:
        send_batch_size: 1000
        send_batch_max_size: 1500
        timeout: 5s

      # Memory limiter to prevent OOM
      memory_limiter:
        check_interval: 1s
        limit_mib: 1500
        spike_limit_mib: 512

      # Tail-based sampling for traces
      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
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
          - name: probabilistic-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 10

      # Filter out noisy spans
      filter:
        error_mode: ignore
        traces:
          span:
            - 'attributes["http.route"] == "/healthz"'
            - 'attributes["http.route"] == "/readyz"'
            - 'attributes["http.route"] == "/metrics"'

    exporters:
      otlp/tempo:
        endpoint: tempo-distributor.observability.svc.cluster.local:4317
        tls:
          insecure: false
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
        headers:
          X-Scope-OrgID: production

      otlp/jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:4317
        tls:
          insecure: true

      prometheusremotewrite:
        endpoint: http://prometheus-remote-write.observability.svc.cluster.local:9090/api/v1/write
        tls:
          insecure: true
        resource_to_telemetry_conversion:
          enabled: true

      debug:
        verbosity: normal
        sampling_initial: 5
        sampling_thereafter: 200

    service:
      telemetry:
        logs:
          level: info
        metrics:
          level: detailed
          address: 0.0.0.0:8888

      extensions: [health_check, pprof, zpages]

      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, resource, filter, tail_sampling, batch]
          exporters: [otlp/tempo, otlp/jaeger]

        metrics:
          receivers: [otlp, prometheus]
          processors: [memory_limiter, resource, batch]
          exporters: [prometheusremotewrite]

        logs:
          receivers: [otlp]
          processors: [memory_limiter, resource, batch]
          exporters: [debug]

    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      pprof:
        endpoint: 0.0.0.0:1777
      zpages:
        endpoint: 0.0.0.0:55679
```

### Mode 2: DaemonSet (Agent Mode)

Runs one collector per node for local collection before forwarding to the gateway:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-agent
  namespace: observability
spec:
  mode: daemonset

  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi

  # Mount host filesystem for hostmetrics
  volumeMounts:
    - name: hostfs
      mountPath: /hostfs
      readOnly: true
    - name: varlog
      mountPath: /var/log
      readOnly: true

  volumes:
    - name: hostfs
      hostPath:
        path: /
    - name: varlog
      hostPath:
        path: /var/log

  # Needs host PID namespace for process metrics
  hostNetwork: false

  securityContext:
    runAsUser: 0
    runAsGroup: 0

  tolerations:
    - operator: Exists
      effect: NoSchedule
    - operator: Exists
      effect: NoExecute

  env:
    - name: NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: NODE_IP
      valueFrom:
        fieldRef:
          fieldPath: status.hostIP

  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318

      hostmetrics:
        collection_interval: 30s
        root_path: /hostfs
        scrapers:
          cpu:
            metrics:
              system.cpu.utilization:
                enabled: true
          disk: {}
          filesystem:
            exclude_mount_points:
              mount_points: [/dev, /proc, /sys]
              match_type: strict
          load: {}
          memory:
            metrics:
              system.memory.utilization:
                enabled: true
          network: {}
          paging: {}
          processes: {}

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
              - output: parser-crio
                expr: 'body matches "^[^ Z]+ "'
            default: parser-docker
          - type: json_parser
            id: parser-docker
            output: extract-metadata-from-filepath
          - type: regex_parser
            id: parser-crio
            regex: '^(?P<time>[^ Z]+) (?P<stream>stdout|stderr) (?P<logtag>[^ ]*) ?(?P<log>.*)$'
            output: extract-metadata-from-filepath
          - type: regex_parser
            id: extract-metadata-from-filepath
            regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]+)\/(?P<container_name>[^\._]+)\/(?P<restart_count>\d+)\.log$'
            parse_from: attributes["log.file.path"]
            output: move-attributes

    processors:
      resource:
        attributes:
          - key: k8s.node.name
            value: "${NODE_NAME}"
            action: upsert
          - key: k8s.cluster.name
            value: production-us-east-1
            action: upsert

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
            - k8s.replicaset.name
            - k8s.replicaset.uid
            - k8s.daemonset.name
            - k8s.daemonset.uid
            - k8s.statefulset.name
            - k8s.statefulset.uid
            - k8s.job.name
            - k8s.job.uid
            - k8s.cronjob.name
            - k8s.container.name
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
        pod_association:
          - sources:
              - from: resource_attribute
                name: k8s.pod.ip
          - sources:
              - from: resource_attribute
                name: k8s.pod.uid
          - sources:
              - from: connection

      batch:
        send_batch_size: 500
        timeout: 5s

      memory_limiter:
        check_interval: 1s
        limit_mib: 400
        spike_limit_mib: 100

    exporters:
      otlp:
        endpoint: otel-gateway-collector.observability.svc.cluster.local:4317
        tls:
          insecure: true
        sending_queue:
          enabled: true
          num_consumers: 10
          queue_size: 5000
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 120s

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp]

        metrics:
          receivers: [otlp, hostmetrics]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp]

        logs:
          receivers: [otlp, filelog]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp]

      extensions: [health_check]

    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
```

### Mode 3: Sidecar Mode

Injects a collector sidecar into each pod. Useful when pods need dedicated collectors:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-sidecar
  namespace: default
spec:
  mode: sidecar

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
            endpoint: localhost:4317

    processors:
      batch:
        timeout: 2s

      memory_limiter:
        check_interval: 1s
        limit_mib: 200

    exporters:
      otlp:
        endpoint: otel-agent-collector.observability.svc.cluster.local:4317
        tls:
          insecure: true

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [otlp]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [otlp]
```

Enable sidecar injection by annotating the pod or namespace:

```yaml
# Annotate a specific pod
metadata:
  annotations:
    sidecar.opentelemetry.io/inject: "otel-sidecar"

# Or annotate a namespace to inject into all pods
apiVersion: v1
kind: Namespace
metadata:
  name: my-app
  annotations:
    sidecar.opentelemetry.io/inject: "otel-sidecar"
```

## Section 4: Instrumentation CR Configuration

The Instrumentation CR defines which SDK versions to use and how to configure auto-instrumentation per language.

### Comprehensive Instrumentation CR

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: platform-instrumentation
  namespace: observability
spec:
  # Global exporter endpoint (can be overridden per-language)
  exporter:
    endpoint: http://otel-agent-collector.observability.svc.cluster.local:4318

  propagators:
    - tracecontext
    - baggage
    - b3
    - b3multi

  sampler:
    type: parentbased_traceidratio
    argument: "0.1"  # 10% sampling rate

  # Global resource attributes
  resource:
    resourceAttributes:
      service.namespace: production
      deployment.environment: production
      cluster.name: us-east-1-prod

  # Java auto-instrumentation
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0

    env:
      - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_KAFKA_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_REDIS_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_SPRING_CORE_ENABLED
        value: "true"
      - name: OTEL_INSTRUMENTATION_HIKARICP_ENABLED
        value: "true"
      # Suppress noisy spans
      - name: OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED
        value: "true"
      - name: OTEL_JAVA_GLOBAL_AUTOCONFIGURE_ENABLED
        value: "true"
      # JVM metrics
      - name: OTEL_METRICS_EXPORTER
        value: otlp
      - name: OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE
        value: DELTA

    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 64Mi

  # Python auto-instrumentation
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.44b0

    env:
      - name: OTEL_PYTHON_LOGGING_AUTO_INSTRUMENTATION_ENABLED
        value: "true"
      - name: OTEL_PYTHON_LOG_CORRELATION
        value: "true"
      - name: OTEL_PYTHON_LOG_LEVEL
        value: info
      - name: OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
        value: http/protobuf
      - name: DJANGO_SETTINGS_MODULE
        value: ""  # Override per-pod if needed

    resources:
      requests:
        cpu: 50m
        memory: 32Mi
      limits:
        cpu: 200m
        memory: 64Mi

  # Node.js auto-instrumentation
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.46.0

    env:
      - name: OTEL_NODE_ENABLED_INSTRUMENTATIONS
        value: "http,grpc,express,koa,fastify,pg,mysql,redis,mongoose,kafkajs,aws-sdk"
      - name: OTEL_NODE_RESOURCE_DETECTORS
        value: "env,host,os,process,serviceinstance,k8s"
      - name: OTEL_EXPORTER_OTLP_TRACES_PROTOCOL
        value: http/protobuf

    resources:
      requests:
        cpu: 50m
        memory: 32Mi
      limits:
        cpu: 200m
        memory: 64Mi

  # Go auto-instrumentation (requires eBPF - kernel 4.14+)
  go:
    image: ghcr.io/open-telemetry/opentelemetry-go-instrumentation/autoinstrumentation-go:v0.10.1-alpha

    env:
      - name: OTEL_GO_AUTO_TARGET_EXE
        value: /app/server  # Path to the binary in the container
      - name: OTEL_EXPORTER_OTLP_ENDPOINT
        value: http://localhost:4318
      - name: OTEL_GO_AUTO_SHOW_VERIFIER_LOG
        value: "false"

    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 128Mi

    # Go instrumentation requires privileged access for eBPF
    securityContext:
      privileged: true
      runAsUser: 0

  # .NET auto-instrumentation
  dotnet:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-dotnet:1.2.0

    env:
      - name: OTEL_DOTNET_AUTO_TRACES_ADDITIONAL_SOURCES
        value: "MyCompany.*"
      - name: OTEL_DOTNET_AUTO_METRICS_ADDITIONAL_SOURCES
        value: "MyCompany.*"
```

### Per-Namespace Instrumentation Override

You can deploy multiple Instrumentation CRs and select them per-pod or per-namespace:

```yaml
# Development instrumentation with 100% sampling
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: dev-instrumentation
  namespace: development
spec:
  exporter:
    endpoint: http://otel-agent-collector.observability.svc.cluster.local:4318

  sampler:
    type: always_on

  propagators:
    - tracecontext
    - baggage

  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
    env:
      - name: OTEL_METRICS_EXPORTER
        value: otlp
```

## Section 5: Annotating Applications for Auto-Instrumentation

### Java Application

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spring-boot-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: spring-boot-api
  template:
    metadata:
      labels:
        app: spring-boot-api
        app.kubernetes.io/version: "2.1.0"
      annotations:
        # Select instrumentation CR
        instrumentation.opentelemetry.io/inject-java: "observability/platform-instrumentation"
        # Override service name
        instrumentation.opentelemetry.io/service-name: "spring-boot-api"
    spec:
      containers:
        - name: app
          image: myregistry/spring-boot-api:2.1.0
          ports:
            - containerPort: 8080
          env:
            # These will be merged with injected OTEL env vars
            - name: SPRING_PROFILES_ACTIVE
              value: production
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
```

### Python Application with Custom Attributes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: python-api
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: python-api
  template:
    metadata:
      labels:
        app: python-api
      annotations:
        instrumentation.opentelemetry.io/inject-python: "observability/platform-instrumentation"
        # Custom resource attributes
        instrumentation.opentelemetry.io/resource-attributes: "team=platform,cost-center=engineering"
    spec:
      containers:
        - name: app
          image: myregistry/python-api:1.5.0
          ports:
            - containerPort: 8000
          env:
            - name: DJANGO_SETTINGS_MODULE
              value: myapp.settings.production
```

### Multi-Language Pod (inject multiple agents)

```yaml
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-java: "true"
    instrumentation.opentelemetry.io/container-names: "java-app"
    instrumentation.opentelemetry.io/inject-nodejs: "true"
    instrumentation.opentelemetry.io/nodejs-container-names: "node-sidecar"
```

## Section 6: Exporting to Jaeger, Tempo, and Prometheus

### Jaeger Backend Configuration

Deploy Jaeger using the Jaeger Operator or all-in-one for development:

```yaml
# Jaeger all-in-one for development
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger
  namespace: observability
spec:
  strategy: allInOne
  allInOne:
    image: jaegertracing/all-in-one:1.55
    options:
      log-level: info
      query:
        base-path: /jaeger
  storage:
    type: memory
    options:
      memory:
        max-traces: 100000
  ingress:
    enabled: true
    hosts:
      - jaeger.internal.example.com
---
# Production Jaeger with Elasticsearch
apiVersion: jaegertracing.io/v1
kind: Jaeger
metadata:
  name: jaeger-prod
  namespace: observability
spec:
  strategy: production
  collector:
    replicas: 3
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    autoscale: true
    minReplicas: 3
    maxReplicas: 10
  query:
    replicas: 2
  storage:
    type: elasticsearch
    options:
      es:
        server-urls: https://elasticsearch.observability.svc.cluster.local:9200
        index-prefix: jaeger-prod
        tls:
          enabled: true
          ca: /es/certificates/ca.crt
    secretName: jaeger-es-secret
```

### Grafana Tempo Backend

```yaml
# Tempo configuration for distributed tracing
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-config
  namespace: observability
data:
  tempo.yaml: |
    multitenancy_enabled: false

    server:
      http_listen_port: 3200
      grpc_listen_port: 9095

    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
            http:
              endpoint: 0.0.0.0:4318
        jaeger:
          protocols:
            thrift_http:
              endpoint: 0.0.0.0:14268
            grpc:
              endpoint: 0.0.0.0:14250

    ingester:
      max_block_duration: 5m
      trace_idle_period: 10s
      flush_check_period: 10s

    compactor:
      compaction:
        block_retention: 720h  # 30 days

    storage:
      trace:
        backend: s3
        s3:
          bucket: tempo-traces-prod
          endpoint: s3.us-east-1.amazonaws.com
          region: us-east-1
          forcepathstyle: false
        wal:
          path: /var/tempo/wal
        local:
          path: /var/tempo/blocks

    querier:
      frontend_worker:
        frontend_address: tempo-query-frontend:9095

    query_frontend:
      search:
        duration_slo: 5s
        throughput_bytes_slo: 1.073741824e+09
      trace_by_id:
        duration_slo: 5s

    metrics_generator:
      registry:
        external_labels:
          source: tempo
          cluster: production
      storage:
        path: /var/tempo/generator/wal
        remote_write:
          - url: http://prometheus.observability.svc.cluster.local:9090/api/v1/write
            send_exemplars: true
```

### Prometheus Metrics from OTel

```yaml
# PrometheusRule for OTel Collector health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: otel-collector-alerts
  namespace: observability
spec:
  groups:
    - name: otel-collector
      rules:
        - alert: OtelCollectorHighMemory
          expr: |
            container_memory_working_set_bytes{pod=~"otel-.*-collector-.*"}
            / on(pod) kube_pod_container_resource_limits{container="otc-container", resource="memory"}
            > 0.9
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "OTel Collector memory usage high"
            description: "Collector {{ $labels.pod }} is using {{ $value | humanizePercentage }} of memory limit"

        - alert: OtelCollectorDroppedSpans
          expr: |
            rate(otelcol_processor_dropped_spans_total[5m]) > 100
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "OTel Collector dropping spans"
            description: "Collector is dropping {{ $value }} spans/sec"

        - alert: OtelCollectorExportFailures
          expr: |
            rate(otelcol_exporter_send_failed_spans_total[5m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "OTel Collector export failures"
            description: "Collector is failing to export {{ $value }} spans/sec to {{ $labels.exporter }}"

        - alert: OtelCollectorQueueFull
          expr: |
            otelcol_exporter_queue_size / otelcol_exporter_queue_capacity > 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "OTel Collector queue near capacity"
            description: "Queue for {{ $labels.exporter }} is {{ $value | humanizePercentage }} full"
```

## Section 7: Advanced Configuration Patterns

### Head-Based Sampling at Collector Level

```yaml
# Sampling configuration in collector
processors:
  probabilistic_sampler:
    hash_seed: 22
    sampling_percentage: 10

  # Or use tail-based for smarter decisions
  tail_sampling:
    decision_wait: 30s
    num_traces: 50000
    expected_new_traces_per_sec: 500
    policies:
      # Always sample errors
      - name: sample-errors
        type: composite
        composite:
          max_total_spans_per_second: 1000
          policy_order: [errors, slow, default-policy]
          composite_sub_policy:
            - name: errors
              type: status_code
              status_code:
                status_codes: [ERROR]
            - name: slow
              type: latency
              latency:
                threshold_ms: 2000
            - name: default-policy
              type: probabilistic
              probabilistic:
                sampling_percentage: 5
```

### Connector for Span Metrics Generation

```yaml
# Generate RED metrics from trace spans using connectors
connectors:
  spanmetrics:
    namespace: span.metrics
    histogram:
      explicit:
        buckets: [2ms, 4ms, 6ms, 8ms, 10ms, 50ms, 100ms, 200ms, 400ms, 800ms, 1s, 1400ms, 2s, 5s, 10s, 15s]
    dimensions:
      - name: http.method
        default: GET
      - name: http.status_code
      - name: k8s.deployment.name
      - name: service.version
    exemplars:
      enabled: true
    dimensions_cache_size: 1000
    aggregation_temporality: AGGREGATION_TEMPORALITY_CUMULATIVE

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/tempo, spanmetrics]

    # spanmetrics connector outputs to metrics pipeline
    metrics/spanmetrics:
      receivers: [spanmetrics]
      processors: [batch]
      exporters: [prometheusremotewrite]
```

### RBAC for Collector Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: otel-collector-sa
  namespace: observability
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: otel-collector-role
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/proxy
      - nodes/metrics
      - services
      - endpoints
      - pods
      - events
      - namespaces
    verbs: ["get", "list", "watch"]
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
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-collector-role-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: otel-collector-role
subjects:
  - kind: ServiceAccount
    name: otel-collector-sa
    namespace: observability
```

## Section 8: Troubleshooting

### Debugging Auto-Instrumentation Injection

```bash
# Check if webhook is configured
kubectl get mutatingwebhookconfigurations | grep opentelemetry

# Check webhook logs
kubectl logs -n opentelemetry-operator-system \
  -l app.kubernetes.io/name=opentelemetry-operator \
  --since=10m | grep -i "inject\|webhook\|error"

# Verify instrumentation CR
kubectl describe instrumentation platform-instrumentation -n observability

# Check if init containers were injected
kubectl get pod <pod-name> -n production -o jsonpath='{.spec.initContainers[*].name}'

# View injected environment variables
kubectl get pod <pod-name> -n production \
  -o jsonpath='{.spec.containers[0].env[*]}' | jq .

# Check for instrumentation in pod annotations
kubectl get pod <pod-name> -n production \
  -o jsonpath='{.metadata.annotations}' | jq .
```

### Collector Pipeline Health

```bash
# Access zpages for pipeline health
kubectl port-forward svc/otel-gateway-collector 55679:55679 -n observability
# Then browse http://localhost:55679/debug/tracez

# Check collector metrics
kubectl port-forward svc/otel-gateway-collector 8888:8888 -n observability
curl http://localhost:8888/metrics | grep otelcol_

# View collector logs
kubectl logs -n observability -l app.kubernetes.io/name=otel-gateway-collector \
  --since=5m | grep -E "error|warn|dropped"

# Check health endpoint
kubectl port-forward svc/otel-gateway-collector 13133:13133 -n observability
curl http://localhost:13133/
```

### Common Issues and Solutions

**Issue: Pods failing to start after webhook injection**

```bash
# Check webhook failure policy (should be Ignore for non-blocking)
kubectl get mutatingwebhookconfigurations opentelemetry-operator-mutation \
  -o jsonpath='{.webhooks[*].failurePolicy}'

# If set to Fail, update to Ignore
kubectl patch mutatingwebhookconfigurations opentelemetry-operator-mutation \
  --type='json' \
  -p='[{"op": "replace", "path": "/webhooks/0/failurePolicy", "value":"Ignore"}]'
```

**Issue: Java agent causing OutOfMemoryError**

```yaml
# In Instrumentation CR, increase JVM memory for agent
java:
  env:
    - name: OTEL_JAVAAGENT_DEBUG
      value: "false"
  # Add JVM args to application container
  # Configure via JAVA_TOOL_OPTIONS
  resources:
    limits:
      memory: 128Mi  # Increase agent memory limit
```

**Issue: Go eBPF instrumentation not working**

```bash
# Check kernel version (requires 4.14+)
uname -r

# Check if the binary path matches
kubectl describe instrumentation platform-instrumentation -n observability | grep -A5 "Go:"

# Check eBPF probe loading
kubectl logs -n production <pod-name> -c otel-auto-instrumentation-go
```

## Section 9: Production Checklist

```yaml
# Production deployment checklist as ConfigMap for documentation
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-production-checklist
  namespace: observability
data:
  checklist.md: |
    # OTel Operator Production Checklist

    ## Operator
    - [ ] cert-manager installed and healthy
    - [ ] Operator deployed with 2+ replicas
    - [ ] PodDisruptionBudget configured
    - [ ] Resource limits set appropriately
    - [ ] Webhook failurePolicy set to Ignore

    ## Collector
    - [ ] Memory limiter processor configured
    - [ ] Batch processor tuned for throughput
    - [ ] Retry and queue settings configured for exporters
    - [ ] Health check extension enabled
    - [ ] Prometheus metrics exposed for alerting
    - [ ] PrometheusRule alerts created

    ## Instrumentation
    - [ ] Sampling rate appropriate for load
    - [ ] Service names set correctly
    - [ ] Resource attributes include environment/cluster
    - [ ] Noisy health check spans filtered

    ## Backends
    - [ ] Jaeger/Tempo retention configured
    - [ ] Storage backend sized appropriately
    - [ ] Authentication configured for remote endpoints
```

The OpenTelemetry Operator significantly reduces the operational burden of observability infrastructure. By managing collector lifecycles via CRDs and injecting instrumentation transparently, teams can achieve comprehensive observability across polyglot microservices without requiring application code changes. The key to production success is carefully tuning sampling rates, memory limits, and batch processors to handle your specific traffic patterns while keeping costs under control.
