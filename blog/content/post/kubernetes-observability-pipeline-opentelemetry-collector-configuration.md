---
title: "Kubernetes Observability Pipeline: OpenTelemetry Collector Configuration"
date: 2029-07-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenTelemetry", "Observability", "Prometheus", "Tracing", "Metrics", "Logging"]
categories: ["Kubernetes", "Observability", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to OpenTelemetry Collector in Kubernetes: collector architecture, receivers/processors/exporters, batch and memory limiter processors, tail sampling for traces, and multi-backend fan-out for enterprise observability pipelines."
more_link: "yes"
url: "/kubernetes-observability-pipeline-opentelemetry-collector-configuration/"
---

The OpenTelemetry Collector is the backbone of modern observability pipelines: it receives telemetry from applications, processes it (sampling, filtering, enrichment), and exports it to multiple backends. Running it in Kubernetes requires careful configuration to handle production data volumes, memory pressure, and backend failures without data loss. This guide covers production-ready Collector configurations for traces, metrics, and logs.

<!--more-->

# Kubernetes Observability Pipeline: OpenTelemetry Collector Configuration

## Collector Architecture Overview

The OpenTelemetry Collector uses a pipeline model with three component types:

```
Applications / Infrastructure
         |
    [Receivers]
    - OTLP (gRPC/HTTP)
    - Prometheus
    - Jaeger
    - Kubernetes events
    - Filelog
         |
    [Processors]
    - Batch
    - Memory Limiter
    - K8s Attributes
    - Tail Sampling
    - Filter
    - Transform
         |
    [Exporters]
    - OTLP (Tempo, Collector)
    - Prometheus Remote Write
    - Elasticsearch
    - Loki
    - Multiple backends (fan-out)
```

### Deployment Patterns

Three deployment patterns for Kubernetes:

**1. DaemonSet (Agent Mode)** — one Collector pod per node, minimal network hops:
```yaml
# Collects: node metrics, container logs, host-level traces
# Exports to: central Collector or directly to backends
```

**2. Deployment (Gateway Mode)** — centralized processing, larger scale:
```yaml
# Collects from: agent Collectors and direct OTLP pushes
# Processes: tail sampling, deduplication
# Exports to: multiple backends
```

**3. Sidecar** — per-pod, tightest isolation:
```yaml
# Collects from: application containers on localhost
# Useful for: apps that only export to localhost
```

## Complete Production Configuration

### DaemonSet Agent Configuration

```yaml
# otel-agent-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-agent-config
  namespace: observability
data:
  config.yaml: |
    # Extensions: health check and pprof
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      pprof:
        endpoint: 0.0.0.0:1777
      zpages:
        endpoint: 0.0.0.0:55679

    receivers:
      # OTLP: applications push telemetry here
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 4
            keepalive:
              server_parameters:
                max_connection_idle: 11s
                max_connection_age: 12s
                max_connection_age_grace: 5s
                time: 30s
                timeout: 20s
          http:
            endpoint: 0.0.0.0:4318

      # Kubernetes container log collection
      filelog:
        include:
          - /var/log/pods/*/*/*.log
        exclude:
          - /var/log/pods/*/otel-collector/*.log  # Don't collect self
        start_at: beginning
        include_file_path: true
        include_file_name: false
        operators:
          # Parse container log format
          - type: container
            id: container-parser
          # Parse JSON log bodies
          - type: json_parser
            id: json-parser
            if: 'body matches "^\\s*\\{"'
            parse_from: body
            parse_to: body
            on_error: send
          # Extract Kubernetes metadata from filename
          - type: regex_parser
            id: kubernetes-metadata
            regex: '^/var/log/pods/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<pod_uid>[^/]+)/(?P<container_name>[^/]+)/\d+\.log$'
            parse_from: attributes["log.file.path"]
            parse_to: resource
            on_error: send

      # Node-level metrics
      hostmetrics:
        collection_interval: 30s
        root_path: /hostfs
        scrapers:
          cpu:
            metrics:
              system.cpu.utilization:
                enabled: true
          memory:
            metrics:
              system.memory.utilization:
                enabled: true
          disk:
            include:
              devices:
                - sda
                - sdb
          filesystem:
            include_mount_points:
              - /
              - /var
          network:
            include:
              interfaces:
                - eth0
          load:
          processes:

      # Kubernetes events as log records
      k8s_events:
        namespaces: [production, staging, observability]
        auth_type: serviceAccount

      # Prometheus metrics from Kubernetes components
      prometheus:
        config:
          scrape_configs:
            - job_name: 'kubelet'
              honor_labels: true
              kubernetes_sd_configs:
                - role: node
              scheme: https
              tls_config:
                ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
                insecure_skip_verify: true
              bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
              relabel_configs:
                - action: labelmap
                  regex: __meta_kubernetes_node_label_(.+)
              metric_relabel_configs:
                - source_labels: [__name__]
                  regex: 'kubelet_(node_name|running_pods|running_containers|volume_stats.*|runtime.*)'
                  action: keep

    processors:
      # Memory limiter: MUST be first processor to prevent OOM
      memory_limiter:
        check_interval: 1s
        limit_percentage: 80
        spike_limit_percentage: 25

      # Batch: group data before sending (critical for efficiency)
      batch:
        send_batch_size: 8192
        send_batch_max_size: 16384
        timeout: 200ms

      # Enrich all telemetry with Kubernetes metadata
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        filter:
          node_from_env_var: KUBE_NODE_NAME
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
            - k8s.cluster.uid
          labels:
            - tag_name: app.name
              key: app
              from: pod
            - tag_name: app.version
              key: version
              from: pod
            - tag_name: team
              key: team
              from: namespace
          annotations:
            - tag_name: deployment.environment
              key: deployment.environment
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

      # Add resource attributes from environment
      resource:
        attributes:
          - action: insert
            key: cluster.name
            value: "${CLUSTER_NAME}"
          - action: insert
            key: cloud.region
            value: "${CLOUD_REGION}"
          - action: insert
            key: cloud.provider
            value: "${CLOUD_PROVIDER}"

      # Filter out noisy/unwanted telemetry
      filter:
        error_mode: ignore
        metrics:
          metric:
            - 'name == "up"'  # Drop Prometheus "up" metric (we have health checks)
        logs:
          log_record:
            # Drop DEBUG logs from specific components
            - 'severity_number < SEVERITY_NUMBER_INFO and resource.attributes["k8s.namespace.name"] == "istio-system"'

      # Transform: standardize field names
      transform:
        error_mode: ignore
        log_statements:
          - context: log
            statements:
              # Normalize severity levels
              - set(severity_text, "ERROR") where IsMatch(body["level"], "(?i)^(err|error|fatal|crit)")
              - set(severity_text, "WARN") where IsMatch(body["level"], "(?i)^(warn|warning)")
              - set(severity_text, "INFO") where IsMatch(body["level"], "(?i)^(info|inf)")
              # Extract trace context from log body if present
              - set(span_id, body["span_id"]) where body["span_id"] != nil
              - set(trace_id, body["trace_id"]) where body["trace_id"] != nil

    exporters:
      # Forward to central gateway Collector
      otlp:
        endpoint: otel-gateway.observability.svc.cluster.local:4317
        tls:
          insecure: false
          cert_file: /etc/otel/tls/tls.crt
          key_file: /etc/otel/tls/tls.key
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
          storage: file_storage/queue

      # Debug exporter for development (disabled in production)
      debug:
        verbosity: basic
        sampling_initial: 5
        sampling_thereafter: 200

    connectors:
      # Forward connector: pass between pipelines
      forward/traces:
      forward/metrics:

    service:
      extensions: [health_check, pprof, zpages]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [otlp]

        metrics:
          receivers: [otlp, prometheus, hostmetrics]
          processors: [memory_limiter, k8sattributes, resource, filter, batch]
          exporters: [otlp]

        logs:
          receivers: [otlp, filelog, k8s_events]
          processors: [memory_limiter, k8sattributes, resource, transform, filter, batch]
          exporters: [otlp]

      telemetry:
        logs:
          level: warn
          development: false
          encoding: json
        metrics:
          level: detailed
          address: 0.0.0.0:8888
```

### Gateway Collector Configuration with Tail Sampling

The gateway handles data from all agents and applies expensive operations like tail sampling:

```yaml
# otel-gateway-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-gateway-config
  namespace: observability
data:
  config.yaml: |
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
      file_storage/queue:
        directory: /var/lib/otelcol/queue
        timeout: 10s
        compaction:
          on_start: true
          on_rebound: true
          rebound_needed_threshold_mib: 100
          rebound_trigger_threshold_mib: 10
          max_transaction_size: 65536

    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
            max_recv_msg_size_mib: 16
          http:
            endpoint: 0.0.0.0:4318

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 6144       # 6GB hard limit
        spike_limit_mib: 1024 # 1GB spike allowance

      # Tail-based sampling: make sampling decisions after the full trace arrives
      # Unlike head-based sampling, tail sampling can make decisions based on span attributes
      tail_sampling:
        # How long to wait for a full trace before making sampling decision
        decision_wait: 30s
        # Number of traces held in memory
        num_traces: 50000
        # Expected new traces per second (for optimization)
        expected_new_traces_per_sec: 5000
        policies:
          # Always sample traces with errors
          - name: errors-policy
            type: status_code
            status_code:
              status_codes: [ERROR]

          # Always sample slow traces (>2 seconds)
          - name: slow-traces-policy
            type: latency
            latency:
              threshold_ms: 2000

          # Sample traces from specific high-value services
          - name: critical-services-policy
            type: string_attribute
            string_attribute:
              key: service.name
              values: [payment-service, auth-service, order-service]
              enabled_regex_matching: false

          # Sample traces with specific HTTP status codes
          - name: http-errors-policy
            type: and
            and:
              and_sub_policy:
                - name: http-status-filter
                  type: numeric_attribute
                  numeric_attribute:
                    key: http.status_code
                    min_value: 400
                    max_value: 599
                - name: not-health-check
                  type: not
                  not:
                    and_sub_policy:
                      - name: health-url
                        type: string_attribute
                        string_attribute:
                          key: http.url
                          values: [/health, /healthz, /ready, /ping]

          # Probabilistic sampling for all remaining traces (1%)
          - name: base-rate-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 1

      # Batch processor for efficient exports
      batch/traces:
        send_batch_size: 1024
        send_batch_max_size: 4096
        timeout: 5s

      batch/metrics:
        send_batch_size: 8192
        send_batch_max_size: 16384
        timeout: 10s

      batch/logs:
        send_batch_size: 4096
        send_batch_max_size: 8192
        timeout: 5s

      # Span metrics: generate RED metrics from traces
      spanmetrics:
        metrics_exporter: prometheus_remote_write/metrics
        latency_histogram_buckets: [1ms, 5ms, 10ms, 25ms, 50ms, 75ms, 100ms, 250ms, 500ms, 750ms, 1s, 2.5s, 5s, 10s]
        dimensions:
          - name: http.method
          - name: http.status_code
          - name: rpc.grpc.status_code
          - name: db.system

    exporters:
      # Distributed tracing backend (Tempo)
      otlp/tempo:
        endpoint: tempo.observability.svc.cluster.local:4317
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
        sending_queue:
          enabled: true
          queue_size: 10000
          storage: file_storage/queue
          num_consumers: 20

      # Metrics backend: Prometheus Remote Write (Mimir/Thanos/VictoriaMetrics)
      prometheusremotewrite/metrics:
        endpoint: "http://mimir.observability.svc.cluster.local/api/v1/push"
        namespace: "otel"
        external_labels:
          cluster: "${CLUSTER_NAME}"
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
        sending_queue:
          enabled: true
          queue_size: 5000
          storage: file_storage/queue

      # Long-term metrics (Thanos for 1-year retention)
      prometheusremotewrite/longterm:
        endpoint: "http://thanos-receive.observability.svc.cluster.local/api/v1/receive"
        namespace: "otel"
        external_labels:
          cluster: "${CLUSTER_NAME}"
          retention: "long-term"
        headers:
          X-Scope-OrgID: "${CLUSTER_NAME}"
        resource_to_telemetry_conversion:
          enabled: true

      # Logs backend (Loki)
      loki:
        endpoint: "http://loki.observability.svc.cluster.local:3100/loki/api/v1/push"
        default_labels_enabled:
          exporter: false
          job: true
          instance: false
          level: true
        tls:
          insecure: true
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
        sending_queue:
          enabled: true
          queue_size: 10000
          storage: file_storage/queue

      # Elasticsearch (for log search/archival)
      elasticsearch:
        endpoints: ["https://elasticsearch.observability.svc.cluster.local:9200"]
        index: "otel-logs-%{+yyyy.MM.dd}"
        pipeline: otel-enrichment
        auth:
          authenticator: basicauth/elasticsearch
        tls:
          ca_file: /etc/otel/tls/elastic-ca.crt
        retry_on_failure:
          enabled: true
        sending_queue:
          enabled: true
          queue_size: 5000

      # Secondary trace backend (Jaeger) for teams that prefer it
      jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:14250
        tls:
          insecure: true

    service:
      extensions: [health_check, file_storage/queue]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, tail_sampling, spanmetrics, batch/traces]
          exporters: [otlp/tempo, jaeger]

        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch/metrics]
          exporters: [prometheusremotewrite/metrics, prometheusremotewrite/longterm]

        logs:
          receivers: [otlp]
          processors: [memory_limiter, batch/logs]
          exporters: [loki, elasticsearch]

      telemetry:
        logs:
          level: warn
        metrics:
          level: detailed
          address: 0.0.0.0:8888
```

## Kubernetes Deployment

### DaemonSet for Agent

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: otel-agent
  namespace: observability
spec:
  selector:
    matchLabels:
      app: otel-agent
  template:
    metadata:
      labels:
        app: otel-agent
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8888"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: otel-agent
      hostNetwork: false
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      initContainers:
      # Ensure queue directory exists
      - name: init-queue
        image: busybox:1.36
        command: ["mkdir", "-p", "/var/lib/otelcol/queue"]
        volumeMounts:
        - name: varlibotelcol
          mountPath: /var/lib/otelcol
      containers:
      - name: otel-agent
        image: otel/opentelemetry-collector-contrib:0.95.0
        args:
        - "--config=/etc/otelcol-contrib/config.yaml"
        - "--feature-gates=+exporter.prometheusremotewritereceiver.enabled"
        env:
        - name: CLUSTER_NAME
          value: "prod-cluster"
        - name: CLOUD_REGION
          value: "us-east-1"
        - name: CLOUD_PROVIDER
          value: "aws"
        - name: KUBE_NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: GOGC
          value: "80"  # More aggressive GC to keep memory usage low
        ports:
        - containerPort: 4317   # OTLP gRPC
          name: otlp-grpc
        - containerPort: 4318   # OTLP HTTP
          name: otlp-http
        - containerPort: 8888   # Metrics
          name: metrics
        - containerPort: 13133  # Health check
          name: health
        readinessProbe:
          httpGet:
            path: /
            port: health
          initialDelaySeconds: 5
          periodSeconds: 10
        livenessProbe:
          httpGet:
            path: /
            port: health
          initialDelaySeconds: 15
          periodSeconds: 20
        resources:
          requests:
            cpu: "200m"
            memory: "512Mi"
          limits:
            cpu: "1"
            memory: "1Gi"
        securityContext:
          runAsNonRoot: true
          runAsUser: 10001
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: false  # Queue directory needs writes
          capabilities:
            drop: ["ALL"]
        volumeMounts:
        - name: config
          mountPath: /etc/otelcol-contrib
          readOnly: true
        - name: varlogpods
          mountPath: /var/log/pods
          readOnly: true
        - name: varlibdockercontainers
          mountPath: /var/lib/docker/containers
          readOnly: true
        - name: hostfs
          mountPath: /hostfs
          readOnly: true
          mountPropagation: HostToContainer
        - name: varlibotelcol
          mountPath: /var/lib/otelcol
        - name: tls-certs
          mountPath: /etc/otel/tls
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: otel-agent-config
      - name: varlogpods
        hostPath:
          path: /var/log/pods
      - name: varlibdockercontainers
        hostPath:
          path: /var/lib/docker/containers
      - name: hostfs
        hostPath:
          path: /
      - name: varlibotelcol
        emptyDir: {}
      - name: tls-certs
        secret:
          secretName: otel-agent-tls
```

### Gateway Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: otel-gateway
  namespace: observability
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
      serviceAccountName: otel-gateway
      # Spread across availability zones
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: otel-gateway
      containers:
      - name: otel-gateway
        image: otel/opentelemetry-collector-contrib:0.95.0
        args:
        - "--config=/etc/otelcol-contrib/config.yaml"
        env:
        - name: CLUSTER_NAME
          value: "prod-cluster"
        - name: GOMAXPROCS
          value: "4"
        - name: GOGC
          value: "80"
        ports:
        - containerPort: 4317
          name: otlp-grpc
        - containerPort: 4318
          name: otlp-http
        - containerPort: 8888
          name: metrics
        - containerPort: 13133
          name: health
        readinessProbe:
          httpGet:
            path: /
            port: health
          initialDelaySeconds: 10
          periodSeconds: 10
          failureThreshold: 3
        livenessProbe:
          httpGet:
            path: /
            port: health
          initialDelaySeconds: 30
          periodSeconds: 20
        resources:
          requests:
            cpu: "1"
            memory: "4Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
        volumeMounts:
        - name: config
          mountPath: /etc/otelcol-contrib
          readOnly: true
        - name: varlibotelcol
          mountPath: /var/lib/otelcol
        - name: tls-certs
          mountPath: /etc/otel/tls
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: otel-gateway-config
      - name: varlibotelcol
        persistentVolumeClaim:
          claimName: otel-gateway-queue
      - name: tls-certs
        secret:
          secretName: otel-gateway-tls

---
# PersistentVolumeClaim for durable queue (survives pod restarts)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: otel-gateway-queue
  namespace: observability
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 50Gi

---
# HorizontalPodAutoscaler
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
  minReplicas: 3
  maxReplicas: 10
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
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # Slow scale-down to avoid data loss
```

## Memory Limiter Tuning

The memory limiter is the most critical processor for production stability:

```yaml
# Memory limiter configuration explained:
processors:
  memory_limiter:
    # How often to check memory usage
    check_interval: 1s

    # Hard limit: when memory exceeds this, ALL new data is dropped
    # Set to 80% of container memory limit
    # For 8GB limit: 6553 MiB
    limit_mib: 6553

    # Alternative: percentage-based
    limit_percentage: 80

    # Spike limit: when memory exceeds (limit - spike_limit), Collector
    # starts refusing new data to prevent hitting hard limit
    # This gives time for GC to reclaim memory
    # Set to 25% of limit
    spike_limit_mib: 1638

    # Alternative: percentage-based
    spike_limit_percentage: 25

    # Ballast size: allocates a fixed memory block to tune GC behavior
    # Reduces GC frequency; set to 1/3 of memory limit
    # ballast_size_mib: 2048  # (optional, deprecated in newer versions)
```

```bash
# Monitor memory limiter effectiveness
# Check otelcol metrics
curl -s http://otel-gateway.observability.svc.cluster.local:8888/metrics | \
  grep -E "otelcol_processor_refused|otelcol_exporter_queue"

# Key metrics to watch:
# otelcol_processor_refused_metric_points_total  - data dropped by memory limiter
# otelcol_exporter_queue_size                    - queue depth
# otelcol_exporter_send_failed_*                 - export failures
# otelcol_receiver_accepted_spans_total          - spans received
# otelcol_exporter_sent_spans_total              - spans exported
```

## Tail Sampling Configuration

Tail sampling holds traces in memory until all spans arrive, then makes a sampling decision based on the complete trace:

```yaml
processors:
  tail_sampling:
    # Critical: decision_wait must be > longest expected trace duration
    # For async operations, set this high (60s or more)
    decision_wait: 30s

    # Maximum traces in memory before evicting oldest
    # Memory usage ≈ num_traces * avg_trace_size
    # For 50k traces at 10KB avg: 500MB
    num_traces: 50000

    # Optimization hint for internal queuing
    expected_new_traces_per_sec: 5000

    policies:
      # Policy evaluation is OR-based by default (any matching policy = keep)

      # 1. Always keep error traces
      - name: keep-errors
        type: status_code
        status_code:
          status_codes: [ERROR, UNSET]  # UNSET can contain errors in some systems

      # 2. Keep slow operations
      - name: keep-slow
        type: latency
        latency:
          threshold_ms: 1000

      # 3. Rate-limit sampling per service (composite policy)
      - name: rate-limited-sample
        type: rate_limiting
        rate_limiting:
          spans_per_second: 1000

      # 4. Probabilistic for remaining (with composite)
      - name: probabilistic-sample
        type: probabilistic
        probabilistic:
          sampling_percentage: 5  # Keep 5% of non-error, fast traces

      # 5. String attribute matching
      - name: keep-feature-flags
        type: string_attribute
        string_attribute:
          key: feature.flag
          values: ["new-checkout", "recommendation-v2"]
          enabled_regex_matching: false

      # 6. Composite: complex multi-condition policy
      - name: high-value-users
        type: composite
        composite:
          max_total_spans_per_second: 2000
          policy_order: [errors, premium-users, random]
          composite_sub_policy:
            - name: errors
              type: status_code
              status_code:
                status_codes: [ERROR]
            - name: premium-users
              type: string_attribute
              string_attribute:
                key: user.tier
                values: ["premium", "enterprise"]
            - name: random
              type: probabilistic
              probabilistic:
                sampling_percentage: 2
          rate_allocation:
            - policy: errors
              percent: 40
            - policy: premium-users
              percent: 40
            - policy: random
              percent: 20
```

## Multi-Backend Fan-Out

```yaml
# Fan-out pattern: send the same data to multiple backends
# Use separate exporters, each with independent queues and retry logic

exporters:
  # Primary backend
  otlp/primary:
    endpoint: tempo.observability.svc.cluster.local:4317
    tls:
      insecure: true
    sending_queue:
      enabled: true
      queue_size: 10000
      num_consumers: 10
    retry_on_failure:
      enabled: true
      max_elapsed_time: 5m

  # DR backend (different datacenter)
  otlp/dr:
    endpoint: tempo.dr.example.com:4317
    tls:
      ca_file: /etc/otel/tls/dr-ca.crt
    sending_queue:
      enabled: true
      queue_size: 5000
      num_consumers: 5
    retry_on_failure:
      enabled: true
      max_elapsed_time: 10m  # Longer retry for DR

  # Archive (S3 via OTLP/HTTP)
  otlphttp/archive:
    endpoint: "https://s3-receiver.observability.example.com"
    headers:
      Authorization: "Bearer ${ARCHIVE_TOKEN}"
    compression: zstd
    sending_queue:
      enabled: true
      queue_size: 50000  # Large queue for high-latency S3
      num_consumers: 3
    retry_on_failure:
      enabled: true
      max_elapsed_time: 30m

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, batch/traces]
      # All three exporters receive the same data
      exporters: [otlp/primary, otlp/dr, otlphttp/archive]
```

## Monitoring the Collector Itself

```yaml
# Prometheus rules for Collector health
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
    - alert: OtelCollectorHighMemory
      expr: |
        (
          process_resident_memory_bytes{job="otel-gateway"}
          / on(pod) kube_pod_container_resource_limits{resource="memory", container="otel-gateway"}
        ) > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "OTel Collector memory usage high"
        description: "Collector {{ $labels.pod }} using {{ $value | humanizePercentage }} of memory limit"

    - alert: OtelCollectorDroppedData
      expr: |
        rate(otelcol_processor_refused_metric_points_total[5m]) > 0
        or rate(otelcol_processor_refused_spans_total[5m]) > 0
        or rate(otelcol_processor_refused_log_records_total[5m]) > 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "OTel Collector dropping telemetry data"
        description: "Collector {{ $labels.job }} is dropping {{ $value | humanize }} items/s"

    - alert: OtelCollectorExporterQueueFull
      expr: |
        otelcol_exporter_queue_size / otelcol_exporter_queue_capacity > 0.9
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "OTel Collector exporter queue nearly full"
        description: "Queue for {{ $labels.exporter }} is {{ $value | humanizePercentage }} full"

    - alert: OtelCollectorExportFailures
      expr: |
        rate(otelcol_exporter_send_failed_spans_total[5m]) > 0
        or rate(otelcol_exporter_send_failed_metric_points_total[5m]) > 0
        or rate(otelcol_exporter_send_failed_log_records_total[5m]) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "OTel Collector export failures"
```

## Summary

A production-ready OpenTelemetry Collector deployment requires careful layering:

1. **Memory limiter first** — always the first processor; prevents OOM by dropping data when memory is under pressure
2. **Batch processor** — crucial for efficiency; tune `send_batch_size` and `timeout` based on downstream backend throughput
3. **k8sattributes** — enriches all telemetry with Kubernetes metadata; requires proper RBAC
4. **Tail sampling** — holds traces until complete before making sampling decisions; size `num_traces` based on expected trace volume and acceptable memory usage
5. **File-backed queues** — survive Collector restarts; critical for exporters to backends that have occasional outages
6. **Fan-out pattern** — multiple exporters in a single pipeline for primary/DR/archive backends with independent retry queues
7. **HPA with stable scale-down** — scale up fast, scale down slow (300s stabilization) to prevent data loss during scaling events

The agent/gateway topology isolates compute-intensive processing (tail sampling) from the data plane (agent collection), allowing independent scaling of each tier.
