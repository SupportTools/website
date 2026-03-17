---
title: "OpenTelemetry Collector: Production-Grade Telemetry Pipeline Configuration"
date: 2027-11-07T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Observability", "Metrics", "Tracing", "Logs"]
categories:
- Monitoring
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and configuring the OpenTelemetry Collector in production, covering deployment modes, pipeline configuration, Kubernetes attributes, tail sampling, and multi-backend routing."
more_link: "yes"
url: "/opentelemetry-collector-enterprise-guide/"
---

The OpenTelemetry Collector has become the standard telemetry pipeline for cloud-native infrastructure, providing vendor-neutral collection, processing, and export of traces, metrics, and logs. For enterprise deployments, configuring the Collector correctly is the difference between reliable observability and a fragile pipeline that drops data under load or fails during incidents.

This guide covers production-grade Collector configurations across all deployment modes, with emphasis on Kubernetes environments where dynamic workload attributes, cardinality management, and multi-backend routing are critical concerns.

<!--more-->

# OpenTelemetry Collector: Production-Grade Telemetry Pipeline Configuration

## Collector Architecture Fundamentals

The OpenTelemetry Collector processes telemetry through a configurable pipeline of receivers, processors, and exporters. Each signal type (traces, metrics, logs) has its own independent pipeline.

### Core Component Types

**Receivers**: Accept telemetry from instrumented applications or other collectors
- OTLP (gRPC and HTTP)
- Prometheus (scraping)
- Jaeger, Zipkin (for legacy migration)
- Kubernetes events, container logs

**Processors**: Transform, filter, and enrich telemetry in flight
- Batch processor (buffering for efficiency)
- Memory limiter (backpressure)
- Resource/attribute processors (enrichment)
- Tail sampling (intelligent trace sampling)
- Spanmetrics (derive metrics from traces)

**Exporters**: Send telemetry to backends
- OTLP (Tempo, Jaeger, OpenTelemetry backends)
- Prometheus remote write
- Loki (log forwarding)
- Elasticsearch, Kafka, S3

## Deployment Mode Selection

### Agent Mode: Per-Node DaemonSet

Agent mode deploys one Collector per node, collecting local telemetry and forwarding to a gateway.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-agent
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: otel-agent
  template:
    metadata:
      labels:
        app: otel-agent
    spec:
      serviceAccountName: otel-agent
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      - key: node-role.kubernetes.io/master
        effect: NoSchedule
      containers:
      - name: otel-agent
        image: otel/opentelemetry-collector-contrib:0.110.0
        args:
        - "--config=/etc/otel/config.yaml"
        ports:
        - containerPort: 4317
          name: otlp-grpc
          protocol: TCP
        - containerPort: 4318
          name: otlp-http
          protocol: TCP
        - containerPort: 8888
          name: metrics
          protocol: TCP
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        env:
        - name: K8S_NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: K8S_POD_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        volumeMounts:
        - name: config
          mountPath: /etc/otel
        - name: varlogpods
          mountPath: /var/log/pods
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: otel-agent-config
      - name: varlogpods
        hostPath:
          path: /var/log/pods
```

### Agent Configuration

```yaml
# otel-agent-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-agent-config
  namespace: monitoring
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 16
          http:
            endpoint: 0.0.0.0:4318
      kubeletstats:
        collection_interval: 30s
        auth_type: serviceAccount
        endpoint: https://${env:K8S_NODE_NAME}:10250
        insecure_skip_verify: true
        metric_groups:
        - node
        - pod
        - container
      filelog:
        include:
        - /var/log/pods/*/*/*.log
        start_at: end
        include_file_path: true
        include_file_name: false
        operators:
        - type: container
          id: container-parser
          add_metadata_from_file_path: true

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 400
        spike_limit_mib: 100
      batch:
        send_batch_size: 1024
        timeout: 5s
        send_batch_max_size: 2048
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
          - tag_name: app
            key: app
            from: pod
          - tag_name: version
            key: version
            from: pod
          - tag_name: team
            key: team.name
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
      resource:
        attributes:
        - action: insert
          key: k8s.cluster.name
          value: prod-us-east-1
        - action: insert
          key: k8s.node.name
          value: ${env:K8S_NODE_NAME}

    exporters:
      otlp:
        endpoint: otel-gateway.monitoring.svc.cluster.local:4317
        tls:
          insecure: false
          ca_file: /etc/otel/tls/ca.crt
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 300s
        sending_queue:
          enabled: true
          num_consumers: 10
          queue_size: 5000

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp]
        metrics:
          receivers: [otlp, kubeletstats]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp]
        logs:
          receivers: [otlp, filelog]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp]
      telemetry:
        logs:
          level: info
        metrics:
          address: 0.0.0.0:8888
```

### Gateway Mode: Centralized Processing

The gateway handles expensive operations that should not run on every node:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: otel-gateway
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: otel-gateway
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: otel-gateway
            topologyKey: kubernetes.io/hostname
      containers:
      - name: otel-gateway
        image: otel/opentelemetry-collector-contrib:0.110.0
        args:
        - "--config=/etc/otel/config.yaml"
        ports:
        - containerPort: 4317
          name: otlp-grpc
        - containerPort: 4318
          name: otlp-http
        - containerPort: 8888
          name: metrics
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 4000m
            memory: 4Gi
        readinessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 10
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /
            port: 13133
          initialDelaySeconds: 30
          periodSeconds: 30
        volumeMounts:
        - name: config
          mountPath: /etc/otel
      volumes:
      - name: config
        configMap:
          name: otel-gateway-config
```

### Gateway Configuration with Tail Sampling

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-gateway-config
  namespace: monitoring
data:
  config.yaml: |
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      pprof:
        endpoint: 0.0.0.0:1888
      zpages:
        endpoint: 0.0.0.0:55679

    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 32
            keepalive:
              server_parameters:
                max_connection_idle: 1h
                max_connection_age: 2h
                max_connection_age_grace: 1m
                time: 1m
                timeout: 20s
          http:
            endpoint: 0.0.0.0:4318
            cors:
              allowed_origins:
              - "https://*.company.com"

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 3000
        spike_limit_mib: 800

      batch:
        send_batch_size: 2048
        timeout: 10s
        send_batch_max_size: 8192

      tail_sampling:
        decision_wait: 10s
        num_traces: 100000
        expected_new_traces_per_sec: 5000
        policies:
        - name: errors-policy
          type: status_code
          status_code:
            status_codes: [ERROR]
        - name: slow-traces-policy
          type: latency
          latency:
            threshold_ms: 2000
        - name: high-priority-services
          type: string_attribute
          string_attribute:
            key: service.tier
            values: [critical, tier-1]
        - name: probabilistic-other
          type: probabilistic
          probabilistic:
            sampling_percentage: 5
        - name: composite-policy
          type: composite
          composite:
            max_total_spans_per_second: 50000
            policy_order:
            - errors-policy
            - slow-traces-policy
            - high-priority-services
            - probabilistic-other
            rate_allocation:
            - policy: errors-policy
              percent: 30
            - policy: slow-traces-policy
              percent: 25
            - policy: high-priority-services
              percent: 30
            - policy: probabilistic-other
              percent: 15

      spanmetrics:
        metrics_exporter: prometheus
        latency_histogram_buckets:
        - 5ms
        - 10ms
        - 25ms
        - 50ms
        - 100ms
        - 250ms
        - 500ms
        - 1s
        - 2s
        - 5s
        dimensions:
        - name: http.method
          default: GET
        - name: http.status_code
        - name: service.name
        - name: k8s.namespace.name
        - name: k8s.deployment.name
        dimensions_cache_size: 10000
        aggregation_temporality: AGGREGATION_TEMPORALITY_CUMULATIVE

      attributes/traces:
        actions:
        - action: delete
          key: http.user_agent
        - action: delete
          key: enduser.email
        - action: hash
          key: enduser.id

      filter/traces:
        traces:
          span:
          - 'attributes["http.url"] == "/health"'
          - 'attributes["http.url"] == "/ready"'
          - 'attributes["http.url"] == "/metrics"'

    exporters:
      otlp/tempo:
        endpoint: tempo-distributor.monitoring.svc.cluster.local:4317
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 60s
          max_elapsed_time: 300s
        sending_queue:
          enabled: true
          num_consumers: 20
          queue_size: 10000

      prometheus:
        endpoint: 0.0.0.0:8889
        namespace: otel
        const_labels:
          cluster: prod-us-east-1
        resource_to_telemetry_conversion:
          enabled: true

      prometheusremotewrite:
        endpoint: http://mimir.monitoring.svc.cluster.local:9009/api/v1/push
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
        sending_queue:
          enabled: true
          queue_size: 2000
        resource_to_telemetry_conversion:
          enabled: true

      loki:
        endpoint: http://loki-distributor.monitoring.svc.cluster.local:3100/loki/api/v1/push
        tls:
          insecure: true
        labels:
          attributes:
            k8s.namespace.name: namespace
            k8s.pod.name: pod
            k8s.container.name: container
            k8s.deployment.name: deployment
          resource:
            service.name: service_name
        retry_on_failure:
          enabled: true

      kafka:
        brokers:
        - kafka.messaging.svc.cluster.local:9092
        topic: otel-traces-raw
        encoding: otlp_proto
        auth:
          sasl:
            username: otel-collector
            password: ${env:KAFKA_PASSWORD}
            mechanism: PLAIN
          tls:
            insecure: false

    service:
      extensions: [health_check, pprof, zpages]
      pipelines:
        traces:
          receivers: [otlp]
          processors:
          - memory_limiter
          - attributes/traces
          - filter/traces
          - tail_sampling
          - spanmetrics
          - batch
          exporters: [otlp/tempo, kafka]

        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [prometheusremotewrite]

        metrics/spanmetrics:
          receivers: [prometheus]
          processors: [memory_limiter, batch]
          exporters: [prometheusremotewrite]

        logs:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [loki]
      telemetry:
        logs:
          level: warn
        metrics:
          address: 0.0.0.0:8888
```

## Kubernetes Attributes Processor Deep Dive

The k8sattributes processor is the most critical processor for Kubernetes environments. Proper configuration determines the quality of all downstream correlation.

### RBAC Configuration

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
  name: otel-agent-role
rules:
- apiGroups: [""]
  resources:
  - nodes
  - nodes/proxy
  - nodes/metrics
  - services
  - endpoints
  - pods
  - namespaces
  verbs:
  - get
  - list
  - watch
- apiGroups: ["apps"]
  resources:
  - replicasets
  - deployments
  - statefulsets
  - daemonsets
  verbs:
  - get
  - list
  - watch
- apiGroups: ["batch"]
  resources:
  - jobs
  - cronjobs
  verbs:
  - get
  - list
  - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: otel-agent-role-binding
subjects:
- kind: ServiceAccount
  name: otel-agent
  namespace: monitoring
roleRef:
  kind: ClusterRole
  name: otel-agent-role
  apiGroup: rbac.authorization.k8s.io
```

### Advanced Namespace Label Extraction

```yaml
processors:
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
      - k8s.container.name
      - container.image.name
      - container.image.tag
      labels:
      - tag_name: app.version
        key: app.kubernetes.io/version
        from: pod
      - tag_name: app.component
        key: app.kubernetes.io/component
        from: pod
      - tag_name: cost.center
        key: cost-center
        from: namespace
      - tag_name: team.name
        key: team
        from: namespace
      - tag_name: environment
        key: environment
        from: namespace
      annotations:
      - tag_name: oncall.team
        key: pagerduty.com/team
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
    filter:
      namespace_labels:
        match_type: regexp
        namespace_names:
        - ^production.*
        - ^staging.*
```

## Batch Processor Tuning

The batch processor is critical for throughput and backend efficiency. Incorrect settings cause either excessive memory usage or poor backend performance.

### Calculating Optimal Batch Settings

```bash
# Calculate expected batch settings based on throughput
# Formula: send_batch_size = (spans_per_second * timeout_seconds)

# For 50,000 spans/second with 5s timeout:
# Target batch: 50000 * 5 = 250,000 spans per batch
# But this exceeds reasonable memory, so:
# - Use send_batch_size = 2048 (triggers immediate send)
# - Use timeout = 5s (fallback for low traffic)
# - Use send_batch_max_size = 4096 (cap at 4k per HTTP request)

# Monitor batch effectiveness
kubectl exec -n monitoring deploy/otel-gateway -- \
  curl -s localhost:8888/metrics | grep -E "otelcol_processor_batch"
```

```yaml
processors:
  batch:
    # Triggers export when this many items are queued
    send_batch_size: 2048
    # Triggers export after this duration regardless of size
    timeout: 5s
    # Maximum batch size (for OTLP backends with size limits)
    send_batch_max_size: 8192
```

### Monitoring Batch Processor Health

```promql
# Batch timeout rate (high = traffic too low for batch_size)
rate(otelcol_processor_batch_timeout_trigger_send_total[5m])

# Batch size trigger rate (high = batch_size is hit before timeout, good)
rate(otelcol_processor_batch_batch_size_trigger_send_total[5m])

# Batch send failures
rate(otelcol_processor_batch_send_size_ratio_bucket[5m])
```

## Memory Limiter Configuration

The memory limiter prevents OOM kills by applying backpressure to upstream senders.

```yaml
processors:
  memory_limiter:
    # How often to check memory usage
    check_interval: 1s
    # Hard limit: triggers GC and forces backpressure
    limit_mib: 3000
    # Spike protection: triggers backpressure if memory increases this much
    # in one check_interval
    spike_limit_mib: 800
    # Alternative: use percentage of available memory
    # limit_percentage: 75
    # spike_limit_percentage: 25
```

### Sizing the Memory Limiter

```bash
# Calculate proper memory limiter values
# Rule: limit_mib = (container_limit * 0.75)
# Rule: spike_limit_mib = (limit_mib * 0.25)

CONTAINER_LIMIT_MIB=4096
LIMIT_MIB=$((CONTAINER_LIMIT_MIB * 75 / 100))
SPIKE_LIMIT_MIB=$((LIMIT_MIB * 25 / 100))

echo "Recommended memory_limiter settings:"
echo "  limit_mib: $LIMIT_MIB"
echo "  spike_limit_mib: $SPIKE_LIMIT_MIB"

# Monitor memory pressure
kubectl exec -n monitoring deploy/otel-gateway -- \
  curl -s localhost:8888/metrics | grep "otelcol_processor_refused"
```

## Tail Sampling Configuration

Tail sampling makes sampling decisions on complete traces, enabling intelligent retention of only errors, slow traces, and sampled normal traffic.

### Load Balancing for Tail Sampling

Tail sampling requires all spans from a trace to arrive at the same Collector instance. Use a load balancer exporter in agents:

```yaml
# In agent config
exporters:
  loadbalancing:
    protocol:
      otlp:
        tls:
          insecure: true
        timeout: 5s
        retry_on_failure:
          enabled: true
    resolver:
      k8s:
        service: otel-gateway.monitoring
        ports:
        - 4317

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, k8sattributes, resource, batch]
      exporters: [loadbalancing]
```

For the load balancing exporter, the gateway needs a headless service:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  clusterIP: None
  selector:
    app: otel-gateway
  ports:
  - name: otlp-grpc
    port: 4317
    targetPort: 4317
```

### Tail Sampling Policy Design

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 200000
    expected_new_traces_per_sec: 10000
    policies:

    # Always sample errors
    - name: sample-on-error
      type: status_code
      status_code:
        status_codes: [ERROR, UNSET]

    # Sample slow requests over 1 second
    - name: sample-slow-traces
      type: latency
      latency:
        threshold_ms: 1000

    # Always sample critical services
    - name: sample-critical-services
      type: string_attribute
      string_attribute:
        key: service.name
        values:
        - payments-service
        - auth-service
        - order-service
        invert_match: false

    # Sample requests with specific HTTP status codes
    - name: sample-5xx-errors
      type: numeric_attribute
      numeric_attribute:
        key: http.status_code
        min_value: 500
        max_value: 599

    # Sample 10% of everything else (for baseline visibility)
    - name: sample-baseline
      type: probabilistic
      probabilistic:
        sampling_percentage: 10

    # Composite policy applying rate limits
    - name: composite-rate-limited
      type: composite
      composite:
        max_total_spans_per_second: 100000
        policy_order:
        - sample-on-error
        - sample-slow-traces
        - sample-critical-services
        - sample-5xx-errors
        - sample-baseline
        rate_allocation:
        - policy: sample-on-error
          percent: 30
        - policy: sample-slow-traces
          percent: 20
        - policy: sample-critical-services
          percent: 30
        - policy: sample-5xx-errors
          percent: 10
        - policy: sample-baseline
          percent: 10
```

## Multi-Backend Routing

Routing telemetry to multiple backends based on signal type, team ownership, or data classification.

### Connector-Based Routing

```yaml
connectors:
  routing:
    default_pipelines: [traces/default]
    error_mode: ignore
    table:
    - statement: route() where attributes["service.namespace"] == "payments"
      pipelines: [traces/payments, traces/default]
    - statement: route() where attributes["service.tier"] == "critical"
      pipelines: [traces/critical]

exporters:
  otlp/default:
    endpoint: tempo.monitoring.svc:4317
    tls:
      insecure: true

  otlp/payments:
    endpoint: tempo-payments.payments-monitoring.svc:4317
    tls:
      insecure: true

  otlp/critical:
    endpoint: jaeger.critical-monitoring.svc:4317
    tls:
      insecure: true

service:
  pipelines:
    traces/input:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [routing]
    traces/default:
      receivers: [routing]
      exporters: [otlp/default]
    traces/payments:
      receivers: [routing]
      exporters: [otlp/payments]
    traces/critical:
      receivers: [routing]
      exporters: [otlp/critical]
```

### Environment-Based Backend Selection

```yaml
exporters:
  otlp/production:
    endpoint: tempo-prod.monitoring.svc.cluster.local:4317
    tls:
      insecure: false
      ca_file: /etc/otel/tls/ca.crt
    headers:
      x-environment: production

  otlp/staging:
    endpoint: tempo-staging.monitoring.svc.cluster.local:4317
    tls:
      insecure: true
    headers:
      x-environment: staging

processors:
  filter/production:
    traces:
      span:
      - 'resource.attributes["k8s.namespace.name"] matches "^staging-.*"'
      invert: true

  filter/staging:
    traces:
      span:
      - 'resource.attributes["k8s.namespace.name"] matches "^staging-.*"'

service:
  pipelines:
    traces/production:
      receivers: [otlp]
      processors: [memory_limiter, filter/production, batch]
      exporters: [otlp/production]
    traces/staging:
      receivers: [otlp]
      processors: [memory_limiter, filter/staging, batch]
      exporters: [otlp/staging]
```

## Sidecar Mode for High-Security Environments

For services that cannot use the DaemonSet agent due to network isolation requirements:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-sidecar-config
  namespace: production
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 127.0.0.1:4317
          http:
            endpoint: 127.0.0.1:4318

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 100
        spike_limit_mib: 25
      batch:
        send_batch_size: 256
        timeout: 3s

    exporters:
      otlp:
        endpoint: otel-agent.monitoring.svc.cluster.local:4317
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

Inject the sidecar via a MutatingWebhook or manually:

```yaml
spec:
  template:
    spec:
      containers:
      - name: app
        image: registry.company.com/payments-service:3.2.1
        env:
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: http://localhost:4318
        - name: OTEL_SERVICE_NAME
          value: payments-service
      - name: otel-sidecar
        image: otel/opentelemetry-collector-contrib:0.110.0
        args:
        - "--config=/etc/otel/config.yaml"
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
        volumeMounts:
        - name: otel-config
          mountPath: /etc/otel
      volumes:
      - name: otel-config
        configMap:
          name: otel-sidecar-config
```

## Production Operations

### Horizontal Pod Autoscaling for Gateway

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: otel-gateway-hpa
  namespace: monitoring
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: otel-gateway
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 75
  - type: Pods
    pods:
      metric:
        name: otelcol_receiver_refused_spans_total
      target:
        type: AverageValue
        averageValue: "100"
```

### PodDisruptionBudget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: otel-gateway-pdb
  namespace: monitoring
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: otel-gateway
```

### Alerting Rules

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
    - alert: OtelCollectorHighDropRate
      expr: |
        rate(otelcol_processor_dropped_spans_total[5m]) > 100
      for: 2m
      labels:
        severity: warning
        team: observability
      annotations:
        summary: "OpenTelemetry Collector dropping spans"
        description: "Collector {{ $labels.job }} is dropping spans at {{ $value | humanize }} spans/s"

    - alert: OtelCollectorMemoryPressure
      expr: |
        otelcol_processor_refused_spans_total > 0
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "OTel Collector refusing spans due to memory pressure"
        description: "Memory limiter is active on {{ $labels.job }}"

    - alert: OtelCollectorExporterFailures
      expr: |
        rate(otelcol_exporter_send_failed_spans_total[5m]) > 10
      for: 3m
      labels:
        severity: critical
      annotations:
        summary: "OTel Collector exporter failing"
        description: "Exporter {{ $labels.exporter }} on {{ $labels.job }} is failing"

    - alert: OtelCollectorDown
      expr: |
        up{job=~"otel-.*"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "OpenTelemetry Collector is down"
```

### Monitoring the Collector Itself

```promql
# Spans received per second
rate(otelcol_receiver_accepted_spans_total[5m])

# Spans exported per second
rate(otelcol_exporter_sent_spans_total[5m])

# Export queue depth (should stay low)
otelcol_exporter_queue_size

# Queue capacity utilization
otelcol_exporter_queue_size / otelcol_exporter_queue_capacity

# Processing latency
histogram_quantile(0.99, rate(otelcol_processor_batch_batch_send_size_bucket[5m]))

# Memory utilization
process_runtime_total_alloc_bytes{job="otel-gateway"}
```

## OpenTelemetry Operator

For Kubernetes-native management of Collector deployments:

```bash
# Install the operator
kubectl apply -f https://github.com/open-telemetry/opentelemetry-operator/releases/latest/download/opentelemetry-operator.yaml
```

```yaml
# OpenTelemetryCollector resource
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: production-collector
  namespace: monitoring
spec:
  mode: daemonset
  serviceAccount: otel-agent
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  tolerations:
  - operator: Exists
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
    processors:
      batch: {}
      memory_limiter:
        check_interval: 1s
        limit_mib: 400
        spike_limit_mib: 100
    exporters:
      otlp:
        endpoint: otel-gateway.monitoring.svc.cluster.local:4317
        tls:
          insecure: true
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [otlp]
```

### Auto-Instrumentation

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: auto-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-agent.monitoring.svc.cluster.local:4318
  propagators:
  - tracecontext
  - baggage
  - b3
  sampler:
    type: parentbased_traceidratio
    argument: "0.10"
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:latest
    env:
    - name: OTEL_INSTRUMENTATION_JDBC_ENABLED
      value: "true"
  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:latest
  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:latest
  go:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-go:latest
```

Enable auto-instrumentation via annotation:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-java: "true"
      labels:
        app: payments-service
    spec:
      containers:
      - name: payments-service
        image: registry.company.com/payments-service:3.2.1
        env:
        - name: OTEL_SERVICE_NAME
          value: payments-service
        - name: OTEL_RESOURCE_ATTRIBUTES
          value: "service.version=3.2.1,service.tier=critical"
```

## Troubleshooting

### Debug Pipeline

```yaml
exporters:
  debug:
    verbosity: detailed
    sampling_initial: 5
    sampling_thereafter: 200

service:
  pipelines:
    traces/debug:
      receivers: [otlp]
      processors: []
      exporters: [debug]
```

### Common Issues

```bash
# Check Collector health
kubectl exec -n monitoring deploy/otel-gateway -- \
  curl -s localhost:13133/

# View pipeline metrics
kubectl exec -n monitoring deploy/otel-gateway -- \
  curl -s localhost:8888/metrics | grep -E "(dropped|refused|failed)"

# Check queue saturation
kubectl exec -n monitoring deploy/otel-gateway -- \
  curl -s localhost:8888/metrics | grep "queue_size"

# Verify exporter connectivity
kubectl exec -n monitoring deploy/otel-gateway -- \
  curl -sv grpc://tempo-distributor.monitoring.svc:4317 2>&1 | head -20

# Check memory limiter is not constantly active
kubectl exec -n monitoring deploy/otel-gateway -- \
  curl -s localhost:8888/metrics | grep "processor_refused"

# Test OTLP endpoint
kubectl run otel-test --rm -it --image=otel/opentelemetry-collector:latest -- \
  /otelcol --config=/dev/null &
```

### Generating Test Traces

```bash
# Use telemetrygen to send test traces
kubectl run telemetrygen --rm -it \
  --image=ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:latest \
  -- traces \
  --otlp-endpoint otel-gateway.monitoring.svc.cluster.local:4317 \
  --otlp-insecure \
  --workers 2 \
  --duration 30s \
  --rate 100 \
  --service payments-service-test
```

## Summary

A production OpenTelemetry Collector deployment requires careful attention to:

**Deployment topology**: Agent DaemonSets collect local telemetry with minimal resources; gateway deployments handle expensive processing like tail sampling and multi-backend routing.

**Batch and memory tuning**: Batch processor settings must match your throughput profile. Memory limiter must be set below container limits with appropriate spike headroom.

**Tail sampling architecture**: Requires trace-aware load balancing so all spans from a trace reach the same Collector instance. The headless Service combined with the loadbalancing exporter achieves this in Kubernetes.

**Kubernetes attribute enrichment**: The k8sattributes processor requires ClusterRole permissions and correct pod association configuration. Namespace label extraction for team and cost-center attribution requires explicit label configuration.

**Multi-backend routing**: Use the routing connector for attribute-based routing without duplicating the full pipeline configuration.

The Collector's self-telemetry (metrics on port 8888) is your primary operational tool. Monitor refused spans, queue depth, and exporter failure rates as the key health indicators for the pipeline.
