---
title: "OpenTelemetry Collector: Building Enterprise Observability Pipelines"
date: 2028-09-17T00:00:00-05:00
draft: false
tags: ["OpenTelemetry", "Observability", "Kubernetes", "Tracing", "Metrics"]
categories:
- OpenTelemetry
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "OTel Collector as DaemonSet and Gateway deployment patterns, receivers/processors/exporters configuration, tail-based sampling, Prometheus scraping, Jaeger/Tempo backends, attribute enrichment, and Kubernetes operator deployment."
more_link: "yes"
url: "/opentelemetry-collector-enterprise-pipeline-guide/"
---

The OpenTelemetry Collector occupies a critical position in the observability stack: it receives signals (traces, metrics, logs) from instrumented applications, enriches and transforms them, applies sampling decisions, and routes them to one or more backends. This vendor-neutral pipeline layer means you can swap Jaeger for Grafana Tempo, or add a secondary metrics backend, without touching application code. This guide builds a production-grade OTel pipeline from two deployment patterns — DaemonSet for node-level collection and a Gateway Deployment for centralized processing — covering tail-based sampling, Prometheus scraping, Kubernetes attribute enrichment, and the OTel Kubernetes Operator.

<!--more-->

# OpenTelemetry Collector: Building Enterprise Observability Pipelines

## Deployment Patterns

Two primary patterns exist, and most production deployments use both:

1. **Agent DaemonSet**: One Collector pod per node. Receives traces/logs from local applications via localhost, enriches with node-level metadata, and forwards to the Gateway. Low latency, no cross-node network hops.

2. **Gateway Deployment**: Centralized Collector with multiple replicas. Applies tail-based sampling (requires seeing all spans for a trace), routes to backends, handles load balancing, and provides a single configuration point for exporter credentials.

The combined pattern: applications send to the local Agent → Agent forwards to Gateway → Gateway samples and exports.

## Section 1: Installing the OTel Operator

The OpenTelemetry Operator manages Collector deployments and auto-instrumentation injection via CRDs.

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

# Install cert-manager first (required by the operator webhook)
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set installCRDs=true --wait

# Install the OTel Operator
helm upgrade --install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --set "manager.collectorImage.repository=otel/opentelemetry-collector-contrib" \
  --set "manager.collectorImage.tag=0.107.0" \
  --wait
```

## Section 2: Agent DaemonSet Configuration

```yaml
# otel-agent-daemonset.yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel-agent
  namespace: monitoring
spec:
  mode: daemonset
  image: otel/opentelemetry-collector-contrib:0.107.0

  # Run with host network access for node metrics
  hostNetwork: false

  serviceAccount: otel-collector-agent

  # Resource limits for the agent
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

  # Mount the hostpath for log collection
  volumeMounts:
    - name: varlog
      mountPath: /var/log
      readOnly: true
    - name: dockersock
      mountPath: /var/run/docker.sock
      readOnly: true

  volumes:
    - name: varlog
      hostPath:
        path: /var/log
    - name: dockersock
      hostPath:
        path: /var/run/docker.sock

  tolerations:
    - key: node-role.kubernetes.io/control-plane
      effect: NoSchedule

  config:
    receivers:
      # Receive OTLP from local applications
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
          http:
            endpoint: "0.0.0.0:4318"

      # Collect node metrics
      hostmetrics:
        collection_interval: 30s
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
          network:
            include:
              interfaces: ["eth0", "ens3"]
          filesystem:
            exclude_mount_points:
              mount_points: ["/dev", "/proc", "/sys", "/run"]
              match_type: strict
          load:
          processes:

      # Collect container logs via filelog
      filelog:
        include:
          - /var/log/pods/*/*/*.log
        exclude:
          - /var/log/pods/monitoring_otel-*/*.log
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
          - type: regex_parser
            id: extract-metadata-from-filepath
            regex: '^.*\/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[a-f0-9\-]{36})\/(?P<container_name>[^\._]+)\/(?P<run_id>\d+)\.log$'
            parse_from: attributes["log.file.path"]
          - type: move
            from: attributes.log
            to: body
          - type: remove
            field: attributes.time

    processors:
      # Batch for efficiency
      batch:
        send_batch_size: 1000
        timeout: 5s
        send_batch_max_size: 2000

      # Memory limiter to prevent OOM
      memory_limiter:
        check_interval: 1s
        limit_percentage: 75
        spike_limit_percentage: 15

      # Enrich with Kubernetes metadata (pod, namespace, node labels)
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        filter:
          node_from_env_var: KUBE_NODE_NAME
        extract:
          metadata:
            - k8s.pod.name
            - k8s.pod.uid
            - k8s.namespace.name
            - k8s.node.name
            - k8s.deployment.name
            - k8s.statefulset.name
            - k8s.daemonset.name
            - k8s.cronjob.name
            - k8s.job.name
          labels:
            - tag_name: team
              key: team
              from: pod
            - tag_name: environment
              key: environment
              from: namespace
            - tag_name: cost-center
              key: cost-center
              from: namespace
          annotations:
            - tag_name: git.commit
              key: deployment.kubernetes.io/revision
              from: pod

      # Resource detection — add cloud metadata
      resourcedetection:
        detectors: [env, ec2, eks]
        timeout: 10s
        override: false

      # Add service.environment attribute from namespace label
      attributes:
        actions:
          - key: deployment.environment
            from_attribute: k8s.namespace.name
            action: insert
          - key: telemetry.sdk.name
            value: opentelemetry
            action: insert

    exporters:
      # Forward to Gateway for tail-based sampling
      otlp/gateway:
        endpoint: "otel-gateway.monitoring.svc.cluster.local:4317"
        tls:
          insecure: false
          ca_file: /etc/otel/tls/ca.crt
        headers:
          "x-cluster-name": "production-us-east-1"
        retry_on_failure:
          enabled: true
          initial_interval: 5s
          max_interval: 30s
          max_elapsed_time: 120s

      # Debug logging for troubleshooting (disable in production)
      debug:
        verbosity: normal
        sampling_initial: 2
        sampling_thereafter: 100

    service:
      telemetry:
        logs:
          level: warn
        metrics:
          address: "0.0.0.0:8888"
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resourcedetection, attributes, batch]
          exporters: [otlp/gateway]
        metrics:
          receivers: [otlp, hostmetrics]
          processors: [memory_limiter, k8sattributes, resourcedetection, batch]
          exporters: [otlp/gateway]
        logs:
          receivers: [otlp, filelog]
          processors: [memory_limiter, k8sattributes, attributes, batch]
          exporters: [otlp/gateway]
```

## Section 3: Gateway Deployment with Tail-Based Sampling

The Gateway receives traces from all Agents and applies tail-based sampling — it waits until all spans for a trace arrive before deciding whether to keep it. This requires the gateway to route traces from the same trace ID to the same gateway replica.

```yaml
# otel-gateway.yaml
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel-gateway
  namespace: monitoring
spec:
  mode: deployment
  replicas: 3
  image: otel/opentelemetry-collector-contrib:0.107.0

  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 8Gi

  # Headless service for consistent trace routing
  # Agents route traces to a specific gateway pod based on trace ID hash
  podDisruptionBudget:
    maxUnavailable: 1

  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: opentelemetry-collector
              app.kubernetes.io/instance: monitoring-otel-gateway
          topologyKey: kubernetes.io/hostname

  config:
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
            max_recv_msg_size_mib: 20
          http:
            endpoint: "0.0.0.0:4318"

      # Scrape Prometheus metrics from Kubernetes services
      prometheus:
        config:
          scrape_configs:
            - job_name: kubernetes-pods
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
                  replacement: "$$1:$$2"
                  target_label: __address__
                - action: labelmap
                  regex: __meta_kubernetes_pod_label_(.+)
                - source_labels: [__meta_kubernetes_namespace]
                  action: replace
                  target_label: kubernetes_namespace
                - source_labels: [__meta_kubernetes_pod_name]
                  action: replace
                  target_label: kubernetes_pod_name

    processors:
      memory_limiter:
        check_interval: 1s
        limit_percentage: 70
        spike_limit_percentage: 20

      batch:
        send_batch_size: 5000
        timeout: 10s
        send_batch_max_size: 10000

      # Tail-based sampling
      tail_sampling:
        # Time to wait for all spans of a trace
        decision_wait: 30s
        num_traces: 100000
        expected_new_traces_per_sec: 1000
        policies:
          # Always sample errors
          - name: errors-policy
            type: status_code
            status_code:
              status_codes: [ERROR]

          # Always sample slow traces (>1s)
          - name: latency-policy
            type: latency
            latency:
              threshold_ms: 1000

          # Sample traces with specific attributes
          - name: important-traces-policy
            type: string_attribute
            string_attribute:
              key: sampling.priority
              values: [high, critical]

          # Sample 5% of remaining traces
          - name: probabilistic-policy
            type: probabilistic
            probabilistic:
              sampling_percentage: 5

          # Rate-limited sampling for high-volume services
          - name: rate-limiting-policy
            type: rate_limiting
            rate_limiting:
              spans_per_second: 10000

      # Filter out internal/health check traces
      filter/traces:
        traces:
          span:
            - 'attributes["http.target"] == "/health"'
            - 'attributes["http.target"] == "/metrics"'
            - 'attributes["http.target"] == "/readyz"'

      # Enrich with resource attributes
      transform:
        trace_statements:
          - context: span
            statements:
              # Normalize HTTP status codes to integers
              - set(attributes["http.status_code"], Int(attributes["http.status_code"])) where attributes["http.status_code"] != nil
              # Mask PII in span attributes
              - replace_pattern(attributes["user.email"], "(.*)@(.*)", "***@$2")

    exporters:
      # Grafana Tempo for traces
      otlp/tempo:
        endpoint: "tempo-distributor.monitoring.svc.cluster.local:4317"
        tls:
          insecure: true
        sending_queue:
          enabled: true
          num_consumers: 10
          queue_size: 5000

      # Prometheus remote write for metrics
      prometheusremotewrite:
        endpoint: "http://prometheus.monitoring.svc.cluster.local:9090/api/v1/write"
        tls:
          insecure: true
        resource_to_telemetry_conversion:
          enabled: true

      # Grafana Loki for logs
      loki:
        endpoint: "http://loki-gateway.monitoring.svc.cluster.local/loki/api/v1/push"
        tls:
          insecure: true
        labels:
          resource_attributes:
            k8s.namespace.name: ""
            k8s.pod.name: ""
            k8s.container.name: ""
            team: ""
            environment: ""
        default_labels_enabled:
          exporter: false
          job: true
          instance: true
          level: true

      # Secondary: send to S3 for long-term trace storage
      awss3:
        s3uploader:
          region: us-east-1
          s3_bucket: acme-otel-traces
          s3_prefix: traces
          file_prefix: ""
        marshaler: otlp_proto

    service:
      telemetry:
        metrics:
          address: "0.0.0.0:8888"
        logs:
          level: warn
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, filter/traces, tail_sampling, transform, batch]
          exporters: [otlp/tempo, awss3]
        metrics:
          receivers: [otlp, prometheus]
          processors: [memory_limiter, batch]
          exporters: [prometheusremotewrite]
        logs:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [loki]
```

## Section 4: Trace-ID Consistent Routing

For tail-based sampling to work, all spans of a trace must arrive at the same gateway replica. Use the `loadbalancingexporter` in the Agent:

```yaml
# In the Agent config, replace the simple otlp/gateway exporter:
exporters:
  loadbalancing:
    routing_key: "traceID"    # Hash by trace ID to ensure consistency
    protocol:
      otlp:
        timeout: 10s
        tls:
          insecure: false
    resolver:
      k8s:
        service: otel-gateway-headless.monitoring
        ports: [4317]
```

Create a headless service for the gateway:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: otel-gateway-headless
  namespace: monitoring
spec:
  clusterIP: None
  selector:
    app.kubernetes.io/instance: monitoring-otel-gateway
  ports:
    - name: grpc
      port: 4317
      targetPort: 4317
```

## Section 5: Auto-Instrumentation Injection

The OTel Operator can inject auto-instrumentation sidecars into pods without any code changes, for Java, Node.js, Python, Go, and .NET applications.

```yaml
# auto-instrumentation.yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: acme-instrumentation
  namespace: monitoring
spec:
  # OTLP endpoint — the local agent
  exporter:
    endpoint: "http://otel-agent-collector.monitoring.svc.cluster.local:4318"

  propagators:
    - tracecontext
    - baggage
    - b3

  sampler:
    type: parentbased_traceidratio
    argument: "0.10"   # Sample 10% at source; gateway handles tail sampling

  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:2.6.0
    env:
      - name: OTEL_INSTRUMENTATION_KAFKA_ENABLED
        value: "true"

  nodejs:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.53.0

  python:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-python:0.47b0
    env:
      - name: OTEL_PYTHON_EXCLUDED_URLS
        value: "health,metrics"

  go:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-go:v0.15.0-alpha
    env:
      - name: OTEL_GO_AUTO_TARGET_EXE
        value: "/app/server"
```

Enable auto-instrumentation for a namespace or individual pod:

```bash
# Enable for all pods in the payments namespace (Java apps)
kubectl annotate namespace payments \
  instrumentation.opentelemetry.io/inject-java=monitoring/acme-instrumentation

# Enable for Go apps specifically
kubectl annotate pod payments-api-7d6b9f-xk2pq \
  instrumentation.opentelemetry.io/inject-go=monitoring/acme-instrumentation
```

## Section 6: RBAC for K8s Attribute Processor

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
      - nodes/proxy
      - nodes/metrics
      - services
      - endpoints
      - pods
      - namespaces
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
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

## Section 7: Alerting on OTel Collector Health

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: otel-collector-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: otelcollector.health
      rules:
        - alert: OTelCollectorExporterQueueFull
          expr: |
            otelcol_exporter_queue_size / otelcol_exporter_queue_capacity > 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "OTel Collector exporter queue is {{ $value | humanizePercentage }} full"
            description: "Exporter {{ $labels.exporter }} on {{ $labels.pod }} may start dropping data."

        - alert: OTelCollectorDroppedSpans
          expr: |
            increase(otelcol_processor_dropped_spans_total[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "OTel Collector is dropping spans"
            description: "Processor {{ $labels.processor }} on {{ $labels.pod }} dropped {{ $value }} spans in the last 5 minutes."

        - alert: OTelCollectorHighMemory
          expr: |
            container_memory_usage_bytes{container="otc-container"} /
            container_spec_memory_limit_bytes{container="otc-container"} > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "OTel Collector memory usage above 85%"
```

## Section 8: Testing the Pipeline

```bash
#!/bin/bash
# test-otel-pipeline.sh — send test traces and verify they appear in Tempo

# Send a test trace using the otel-cli tool
docker run --rm \
  -e OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-agent.monitoring.svc.cluster.local:4317" \
  -e OTEL_SERVICE_NAME="test-service" \
  ghcr.io/equinix-labs/otel-cli:latest \
  exec \
  --service "test-service" \
  --name "test-operation" \
  --attrs "test.attribute=value,environment=production" \
  -- echo "Test trace sent"

# Verify in Tempo via API
TRACE_ID=$(kubectl exec -n monitoring deploy/tempo-query -- \
  wget -qO- "http://tempo.monitoring.svc.cluster.local:3200/api/search?tags=service.name%3Dtest-service&limit=1" \
  | jq -r '.traces[0].traceID')

if [[ -n "${TRACE_ID}" ]]; then
  echo "SUCCESS: Found trace ${TRACE_ID} in Tempo"
else
  echo "FAILURE: No traces found in Tempo"
  echo "Check collector logs:"
  kubectl logs -n monitoring -l app.kubernetes.io/instance=monitoring-otel-agent --tail=50
fi
```

## Conclusion

The OTel Collector's receiver/processor/exporter pipeline model gives you the flexibility to adapt your observability backend without touching application code. The DaemonSet plus Gateway pattern handles the tension between low-latency collection at the node level and the completeness requirements of tail-based sampling. With the OTel Operator managing deployments as CRDs, adding new collector configurations follows the same GitOps workflow as any other Kubernetes resource. The investment in a well-designed OTel pipeline pays dividends in vendor portability, data quality through attribute enrichment, and cost control through intelligent sampling.
