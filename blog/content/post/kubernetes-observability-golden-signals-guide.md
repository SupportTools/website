---
title: "Kubernetes Observability: Golden Signals, RED Method, and Production Monitoring Patterns"
date: 2027-05-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Observability", "Prometheus", "Grafana", "Monitoring", "SRE"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes observability covering the Golden Signals and RED/USE methods, kube-state-metrics, Prometheus scrape configurations, ServiceMonitor and PodMonitor patterns, recording and alerting rules, Grafana dashboards, distributed tracing with OpenTelemetry, and log correlation strategies for production Kubernetes environments."
more_link: "yes"
url: "/kubernetes-observability-golden-signals-guide/"
---

Kubernetes observability is not a single tool—it is a discipline that spans metrics, logs, traces, and events, unified by a shared understanding of what healthy looks like. The Google SRE book's Golden Signals framework and Tom Wilkie's RED method provide structured vocabulary for measuring service health regardless of the underlying technology. Applied to Kubernetes, these frameworks translate into specific Prometheus queries, Grafana dashboards, and alerting rules that distinguish signal from noise and surface actionable information when systems behave unexpectedly. This guide builds a complete observability stack from first principles, covering infrastructure instrumentation, application metrics patterns, distributed tracing, and log correlation.

<!--more-->

## The Four Golden Signals

Google's Site Reliability Engineering book identifies four signals sufficient to measure the health of any user-facing service:

1. **Latency**: The time it takes to service a request. Distinguish successful request latency from error latency—a slow error is different from a fast error.
2. **Traffic**: A measure of how much demand is being placed on the system (requests per second, transactions per second, etc.)
3. **Errors**: The rate of requests that fail, either explicitly (HTTP 5xx) or implicitly (wrong content with HTTP 200).
4. **Saturation**: How "full" the service is—the fraction of capacity in use. Saturation often precedes other signal degradation.

## The RED Method

Tom Wilkie's RED method (Rate, Errors, Duration) is the Golden Signals framework applied specifically to microservices, focusing on the request path:

- **Rate**: Requests per second your service handles
- **Errors**: Number of failing requests per second
- **Duration**: Distribution of request latency (p50, p95, p99, p999)

The RED method is implemented at the service level and depends on instrumented application metrics.

## The USE Method

Brendan Gregg's USE method (Utilization, Saturation, Errors) applies to resources (nodes, disks, network interfaces):

- **Utilization**: Average time the resource was busy (percentage)
- **Saturation**: Degree to which the resource has extra work it cannot service (queue length, waiting)
- **Errors**: Count of error events

For Kubernetes nodes, USE applies to CPU, memory, disk, and network.

## Observability Stack Components

A complete Kubernetes observability stack consists of:

```
Metrics Layer:
  kube-state-metrics     → Kubernetes object state metrics
  metrics-server         → Resource usage for HPA and kubectl top
  node-exporter          → Node-level OS metrics (USE method)
  Application exporters  → Service-specific business metrics
  Prometheus             → Metrics collection and storage
  Thanos/Cortex          → Long-term storage and federation

Logging Layer:
  Fluent Bit/Fluentd     → Log collection and forwarding
  Loki/Elasticsearch     → Log storage and indexing
  Grafana                → Log visualization and correlation

Tracing Layer:
  OpenTelemetry Operator → Instrumentation injection
  Jaeger/Tempo           → Trace storage and visualization

Events Layer:
  kube-state-metrics     → Kubernetes event metrics
  Event Exporter         → Event forwarding to logging backend
```

## Installing the Prometheus Stack

The kube-prometheus-stack Helm chart installs Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics, and a set of pre-built dashboards and rules:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --version 58.0.0 \
  --values prometheus-values.yaml
```

```yaml
# prometheus-values.yaml
prometheus:
  prometheusSpec:
    replicas: 2
    retention: 15d
    retentionSize: 50GB
    resources:
      requests:
        cpu: 500m
        memory: 2Gi
      limits:
        cpu: 2000m
        memory: 8Gi
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: fast-ssd
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 100Gi
    # Scrape all ServiceMonitors and PodMonitors across namespaces
    serviceMonitorSelectorNilUsesHelmValues: false
    podMonitorSelectorNilUsesHelmValues: false
    ruleSelectorNilUsesHelmValues: false
    # External labels for Thanos or federation
    externalLabels:
      cluster: production-us-east-1
      region: us-east-1

alertmanager:
  alertmanagerSpec:
    replicas: 2
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: standard
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 10Gi

grafana:
  enabled: true
  replicas: 2
  persistence:
    enabled: true
    size: 10Gi
  sidecar:
    dashboards:
      enabled: true
      searchNamespace: ALL
    datasources:
      enabled: true

kubeStateMetrics:
  enabled: true

nodeExporter:
  enabled: true

prometheusOperator:
  enabled: true
  admissionWebhooks:
    enabled: true
```

## kube-state-metrics

kube-state-metrics listens to the Kubernetes API and generates metrics about the state of Kubernetes objects (not resource usage—that is metrics-server's job). Key metric families:

```promql
# Pod phase counts
kube_pod_status_phase{phase="Running"}
kube_pod_status_phase{phase="Pending"}
kube_pod_status_phase{phase="Failed"}

# Deployment availability
kube_deployment_status_replicas_available
kube_deployment_status_replicas_unavailable
kube_deployment_spec_replicas

# Node conditions
kube_node_status_condition{condition="Ready",status="true"}
kube_node_status_condition{condition="MemoryPressure",status="true"}
kube_node_status_condition{condition="DiskPressure",status="true"}

# Resource requests vs limits
kube_pod_container_resource_requests{resource="cpu"}
kube_pod_container_resource_limits{resource="memory"}

# PersistentVolumeClaim status
kube_persistentvolumeclaim_status_phase{phase="Bound"}
kube_persistentvolumeclaim_status_phase{phase="Pending"}

# Job completion
kube_job_status_succeeded
kube_job_status_failed
kube_job_complete
```

## Prometheus Scrape Configurations

### Direct Scrape Configuration

For components not managed by the Prometheus Operator:

```yaml
# prometheus-additional-scrape-configs.yaml
additionalScrapeConfigs:
- job_name: kubernetes-pods-direct
  kubernetes_sd_configs:
  - role: pod
  relabel_configs:
  # Only scrape pods with the annotation prometheus.io/scrape: "true"
  - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
    action: keep
    regex: "true"
  # Use custom port annotation
  - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
    action: replace
    regex: (\d+)
    replacement: $1
    target_label: __address__
    separator: ":"
  - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
    action: replace
    target_label: __metrics_path__
    regex: (.+)
  # Add namespace and pod labels
  - source_labels: [__meta_kubernetes_namespace]
    action: replace
    target_label: kubernetes_namespace
  - source_labels: [__meta_kubernetes_pod_name]
    action: replace
    target_label: kubernetes_pod_name
  - source_labels: [__meta_kubernetes_pod_label_app]
    action: replace
    target_label: app
```

### ServiceMonitor

ServiceMonitor is the Prometheus Operator CRD for scraping services. It selects services by label and configures scrape parameters:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: myapp-metrics
  namespace: production
  labels:
    app: myapp
    prometheus: kube-prometheus  # Must match prometheusSpec.serviceMonitorSelector
spec:
  selector:
    matchLabels:
      app: myapp
  namespaceSelector:
    matchNames:
    - production
    - staging
  endpoints:
  - port: metrics         # Service port name
    path: /metrics
    interval: 15s
    scrapeTimeout: 10s
    honorLabels: false    # Prometheus labels override target labels
    metricRelabelings:
    # Drop high-cardinality metrics
    - sourceLabels: [__name__]
      regex: "go_.*"
      action: drop
    # Rename a metric
    - sourceLabels: [__name__]
      regex: "myapp_http_requests_old"
      action: replace
      replacement: myapp_http_requests
      targetLabel: __name__
```

```yaml
# Service that ServiceMonitor targets
apiVersion: v1
kind: Service
metadata:
  name: myapp
  namespace: production
  labels:
    app: myapp
spec:
  selector:
    app: myapp
  ports:
  - name: http
    port: 8080
    targetPort: 8080
  - name: metrics        # Named port referenced by ServiceMonitor
    port: 9090
    targetPort: 9090
```

### PodMonitor

PodMonitor scrapes pods directly without requiring a Service:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: batch-workers
  namespace: production
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: batch-worker
  namespaceSelector:
    any: true  # Scrape matching pods in all namespaces
  podMetricsEndpoints:
  - port: metrics
    path: /metrics
    interval: 30s
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_node_name]
      targetLabel: node
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: namespace
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
```

### Scraping etcd, kube-scheduler, and kube-controller-manager

Control plane components require special scrape configuration on kubeadm clusters:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: etcd
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  jobLabel: k8s-app
  selector:
    matchLabels:
      k8s-app: etcd
  namespaceSelector:
    matchNames:
    - kube-system
  endpoints:
  - port: https-metrics
    scheme: https
    interval: 15s
    tlsConfig:
      caFile: /etc/prometheus/secrets/etcd-client-cert/ca.crt
      certFile: /etc/prometheus/secrets/etcd-client-cert/client.crt
      keyFile: /etc/prometheus/secrets/etcd-client-cert/client.key
      insecureSkipVerify: false
```

## Recording Rules

Recording rules pre-compute expensive queries and store the results as new time series. They are essential for dashboard performance and alerting rules that reference complex aggregations:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-recording-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: kubernetes.node.recording
    interval: 60s
    rules:
    # Node CPU utilization
    - record: node:node_cpu_utilisation:avg1m
      expr: |
        1 - avg(rate(node_cpu_seconds_total{mode="idle"}[1m])) by (node)

    # Node memory utilization
    - record: node:node_memory_utilisation:ratio
      expr: |
        1 - (
          node_memory_MemFree_bytes + node_memory_Cached_bytes + node_memory_Buffers_bytes
        ) / node_memory_MemTotal_bytes

    # Node filesystem usage
    - record: node:node_filesystem_usage:ratio
      expr: |
        1 - (
          node_filesystem_avail_bytes{fstype!~"tmpfs|rootfs|squashfs"}
          / node_filesystem_size_bytes{fstype!~"tmpfs|rootfs|squashfs"}
        )

    # Node network receive rate
    - record: node:node_net_receive_bytes:rate5m
      expr: |
        sum(rate(node_network_receive_bytes_total{device!~"lo|veth.*|br.*|docker.*"}[5m])) by (node)

  - name: kubernetes.workload.recording
    interval: 60s
    rules:
    # Deployment availability ratio
    - record: namespace_deployment:kube_deployment_status_replicas_available:ratio
      expr: |
        kube_deployment_status_replicas_available
          / kube_deployment_spec_replicas

    # Container CPU usage ratio vs requests
    - record: namespace_pod_container:container_cpu_usage_ratio
      expr: |
        rate(container_cpu_usage_seconds_total{container!=""}[5m])
          / on(namespace, pod, container)
        kube_pod_container_resource_requests{resource="cpu"}

    # Container memory usage ratio vs limits
    - record: namespace_pod_container:container_memory_usage_ratio
      expr: |
        container_memory_working_set_bytes{container!=""}
          / on(namespace, pod, container)
        kube_pod_container_resource_limits{resource="memory"}

  - name: http.request.recording
    interval: 30s
    rules:
    # Request rate per service
    - record: job:http_requests_total:rate5m
      expr: |
        sum(rate(http_requests_total[5m])) by (job, namespace, status_code)

    # Error rate ratio
    - record: job:http_error_ratio:rate5m
      expr: |
        sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (job, namespace)
          / sum(rate(http_requests_total[5m])) by (job, namespace)

    # Request duration p99
    - record: job:http_request_duration_seconds:p99
      expr: |
        histogram_quantile(
          0.99,
          sum(rate(http_request_duration_seconds_bucket[5m])) by (job, namespace, le)
        )

    # Request duration p95
    - record: job:http_request_duration_seconds:p95
      expr: |
        histogram_quantile(
          0.95,
          sum(rate(http_request_duration_seconds_bucket[5m])) by (job, namespace, le)
        )
```

## Alerting Rules

### Golden Signals Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: golden-signals-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: golden-signals
    rules:
    # Latency: p99 request duration exceeds SLO
    - alert: HighRequestLatency
      expr: |
        histogram_quantile(
          0.99,
          sum(rate(http_request_duration_seconds_bucket{job="myapp"}[5m])) by (le)
        ) > 1.0
      for: 5m
      labels:
        severity: warning
        slo: latency
      annotations:
        summary: "High p99 request latency for {{ $labels.job }}"
        description: "p99 latency is {{ $value | humanizeDuration }}, exceeding the 1s SLO threshold."
        runbook: "https://runbooks.example.com/high-latency"

    # Traffic: sudden drop in request rate (potential outage)
    - alert: RequestRateDrop
      expr: |
        (
          sum(rate(http_requests_total{job="myapp"}[5m]))
          / sum(rate(http_requests_total{job="myapp"}[30m] offset 5m))
        ) < 0.5
      for: 5m
      labels:
        severity: critical
        slo: availability
      annotations:
        summary: "Request rate dropped significantly for {{ $labels.job }}"
        description: "Request rate has dropped to less than 50% of its 30-minute baseline."

    # Errors: error rate exceeds SLO error budget
    - alert: HighErrorRate
      expr: |
        sum(rate(http_requests_total{status_code=~"5..",job="myapp"}[5m]))
          / sum(rate(http_requests_total{job="myapp"}[5m])) > 0.01
      for: 2m
      labels:
        severity: warning
        slo: error-rate
      annotations:
        summary: "High error rate for {{ $labels.job }}"
        description: "Error rate is {{ $value | humanizePercentage }}, exceeding 1% SLO threshold."

    - alert: CriticalErrorRate
      expr: |
        sum(rate(http_requests_total{status_code=~"5..",job="myapp"}[5m]))
          / sum(rate(http_requests_total{job="myapp"}[5m])) > 0.05
      for: 2m
      labels:
        severity: critical
        slo: error-rate
      annotations:
        summary: "Critical error rate for {{ $labels.job }}"
        description: "Error rate is {{ $value | humanizePercentage }}, exceeding 5% critical threshold."

    # Saturation: CPU saturation approaching limits
    - alert: HighCPUSaturation
      expr: |
        sum(rate(container_cpu_usage_seconds_total{container!="",namespace="production"}[5m]))
          by (namespace, pod)
          /
        sum(kube_pod_container_resource_limits{resource="cpu",namespace="production"})
          by (namespace, pod) > 0.9
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Container CPU saturation: {{ $labels.namespace }}/{{ $labels.pod }}"
        description: "CPU usage is at {{ $value | humanizePercentage }} of limit."

  - name: kubernetes-workloads
    rules:
    # Deployment has unavailable replicas
    - alert: DeploymentReplicasUnavailable
      expr: |
        kube_deployment_status_replicas_unavailable > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Deployment has unavailable replicas: {{ $labels.namespace }}/{{ $labels.deployment }}"
        description: "{{ $value }} replica(s) have been unavailable for 5 minutes."

    # Pod CrashLoopBackOff
    - alert: PodCrashLooping
      expr: |
        increase(kube_pod_container_status_restarts_total[1h]) > 5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Pod crash looping: {{ $labels.namespace }}/{{ $labels.pod }}"
        description: "Container {{ $labels.container }} has restarted {{ $value }} times in the last hour."

    # Pod OOMKilled
    - alert: PodOOMKilled
      expr: |
        kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "Pod OOMKilled: {{ $labels.namespace }}/{{ $labels.pod }}"
        description: "Container {{ $labels.container }} was OOMKilled. Consider increasing memory limits."

    # Persistent volume claim pending
    - alert: PersistentVolumeClaimPending
      expr: |
        kube_persistentvolumeclaim_status_phase{phase="Pending"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "PVC pending: {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }}"
        description: "PVC has been in Pending state for 10 minutes. Check storage provisioner."

  - name: kubernetes-nodes
    rules:
    # Node not ready
    - alert: KubernetesNodeNotReady
      expr: |
        kube_node_status_condition{condition="Ready",status="true"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Kubernetes node not ready: {{ $labels.node }}"
        description: "Node {{ $labels.node }} has been not-ready for 5 minutes."

    # Node memory pressure
    - alert: KubernetesNodeMemoryPressure
      expr: |
        kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Kubernetes node memory pressure: {{ $labels.node }}"
        description: "Node {{ $labels.node }} is under memory pressure."

    # Node high CPU utilization
    - alert: NodeHighCPU
      expr: |
        100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100) > 90
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Node high CPU: {{ $labels.instance }}"
        description: "CPU utilization is {{ $value | humanize }}% for 15 minutes."

    # Node disk pressure
    - alert: NodeDiskPressure
      expr: |
        (
          node_filesystem_avail_bytes{fstype!~"tmpfs|rootfs|squashfs"}
          / node_filesystem_size_bytes{fstype!~"tmpfs|rootfs|squashfs"}
        ) < 0.10
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node disk almost full: {{ $labels.instance }}"
        description: "Filesystem {{ $labels.mountpoint }} has less than 10% free space."
```

## Grafana Dashboards

### Kubernetes Cluster Overview Dashboard

Key panels for a cluster-level overview dashboard:

```json
{
  "panels": [
    {
      "title": "Cluster Node Status",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(kube_node_status_condition{condition='Ready',status='true'})",
          "legendFormat": "Ready Nodes"
        },
        {
          "expr": "count(kube_node_info) - sum(kube_node_status_condition{condition='Ready',status='true'})",
          "legendFormat": "Not Ready"
        }
      ]
    },
    {
      "title": "Cluster CPU Utilization",
      "type": "gauge",
      "targets": [
        {
          "expr": "sum(rate(node_cpu_seconds_total{mode!='idle'}[5m])) / sum(machine_cpu_cores) * 100",
          "legendFormat": "CPU %"
        }
      ]
    },
    {
      "title": "Cluster Memory Utilization",
      "type": "gauge",
      "targets": [
        {
          "expr": "1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)",
          "legendFormat": "Memory %"
        }
      ]
    },
    {
      "title": "Pod Phase Distribution",
      "type": "piechart",
      "targets": [
        {
          "expr": "sum(kube_pod_status_phase) by (phase)",
          "legendFormat": "{{phase}}"
        }
      ]
    },
    {
      "title": "Namespace Resource Requests vs Allocatable",
      "type": "bargauge",
      "targets": [
        {
          "expr": "sum(kube_pod_container_resource_requests{resource='cpu'}) by (namespace) / sum(kube_node_status_allocatable{resource='cpu'}) * 100",
          "legendFormat": "CPU Request % - {{namespace}}"
        }
      ]
    }
  ]
}
```

### Workload RED Dashboard Queries

Essential PromQL queries for a per-namespace or per-deployment RED dashboard:

```promql
# Request Rate (requests per second)
sum(rate(http_requests_total{namespace="$namespace", deployment="$deployment"}[5m]))

# Error Rate (percentage)
sum(rate(http_requests_total{namespace="$namespace", deployment="$deployment", status_code=~"5.."}[5m]))
/ sum(rate(http_requests_total{namespace="$namespace", deployment="$deployment"}[5m])) * 100

# Request Duration p50
histogram_quantile(
  0.50,
  sum(rate(http_request_duration_seconds_bucket{namespace="$namespace", deployment="$deployment"}[5m]))
  by (le)
)

# Request Duration p95
histogram_quantile(
  0.95,
  sum(rate(http_request_duration_seconds_bucket{namespace="$namespace", deployment="$deployment"}[5m]))
  by (le)
)

# Request Duration p99
histogram_quantile(
  0.99,
  sum(rate(http_request_duration_seconds_bucket{namespace="$namespace", deployment="$deployment"}[5m]))
  by (le)
)

# Request Duration p999
histogram_quantile(
  0.999,
  sum(rate(http_request_duration_seconds_bucket{namespace="$namespace", deployment="$deployment"}[5m]))
  by (le)
)
```

### Node USE Dashboard Queries

```promql
# CPU Utilization
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle",instance="$node"}[5m])) * 100)

# CPU Saturation (run queue length per CPU)
avg by (instance) (node_load1{instance="$node"}) / count by (instance) (node_cpu_seconds_total{mode="idle",instance="$node"})

# Memory Utilization
(1 - node_memory_MemAvailable_bytes{instance="$node"} / node_memory_MemTotal_bytes{instance="$node"}) * 100

# Memory Saturation (page faults and swapping)
rate(node_vmstat_pgmajfault{instance="$node"}[5m])

# Disk Utilization (per device)
rate(node_disk_io_time_seconds_total{instance="$node",device="$device"}[5m]) * 100

# Disk Saturation (average queue depth)
rate(node_disk_io_time_weighted_seconds_total{instance="$node",device="$device"}[5m])

# Network Utilization (receive Mbps)
rate(node_network_receive_bytes_total{instance="$node",device="$interface"}[5m]) * 8 / 1024 / 1024

# Network Saturation (receive packet drops)
rate(node_network_receive_drop_total{instance="$node",device="$interface"}[5m])
```

### Grafana Dashboard as ConfigMap

Deploy Grafana dashboards via ConfigMap for GitOps:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-kubernetes-overview
  namespace: monitoring
  labels:
    grafana_dashboard: "1"  # Grafana sidecar picks up this label
data:
  kubernetes-overview.json: |
    {
      "title": "Kubernetes Overview",
      "uid": "kubernetes-overview",
      "schemaVersion": 37,
      "version": 1,
      "refresh": "30s",
      "time": {"from": "now-3h", "to": "now"},
      "panels": []
    }
```

## Distributed Tracing with OpenTelemetry

### OpenTelemetry Operator Installation

```bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

helm install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace observability \
  --create-namespace \
  --set manager.collectorImage.repository=otel/opentelemetry-collector-contrib \
  --version 0.55.0
```

### OpenTelemetry Collector Configuration

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: OpenTelemetryCollector
metadata:
  name: otel-collector
  namespace: observability
spec:
  mode: Deployment
  replicas: 2
  config: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
      # Collect Prometheus metrics from the collector itself
      prometheus:
        config:
          scrape_configs:
          - job_name: otel-collector
            scrape_interval: 10s
            static_configs:
            - targets: ["0.0.0.0:8888"]

    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 1500
        spike_limit_mib: 512
      batch:
        send_batch_size: 10000
        timeout: 10s
      # Add Kubernetes metadata to traces
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
        pod_association:
        - sources:
          - from: resource_attribute
            name: k8s.pod.ip
        - sources:
          - from: connection
      # Add resource attributes
      resource:
        attributes:
        - key: cluster
          value: production-us-east-1
          action: upsert

    exporters:
      # Export traces to Jaeger
      jaeger:
        endpoint: jaeger-collector.observability.svc.cluster.local:14250
        tls:
          insecure: false
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      # Export traces to Tempo
      otlp/tempo:
        endpoint: tempo.observability.svc.cluster.local:4317
        tls:
          insecure: true
      # Export metrics to Prometheus
      prometheus:
        endpoint: "0.0.0.0:8889"
      # Export logs to Loki
      loki:
        endpoint: http://loki.observability.svc.cluster.local:3100/loki/api/v1/push

    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [jaeger, otlp/tempo]
        metrics:
          receivers: [otlp, prometheus]
          processors: [memory_limiter, batch]
          exporters: [prometheus]
        logs:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, resource, batch]
          exporters: [loki]
```

### Auto-Instrumentation with OpenTelemetry Operator

The OpenTelemetry Operator can inject instrumentation automatically via pod annotations:

```yaml
# Define auto-instrumentation for Java applications
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: java-instrumentation
  namespace: production
spec:
  exporter:
    endpoint: http://otel-collector.observability.svc.cluster.local:4318
  propagators:
  - tracecontext
  - baggage
  - b3
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"  # Sample 10% of traces
  java:
    image: ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-java:1.32.0
    env:
    - name: OTEL_LOGS_EXPORTER
      value: otlp
```

```yaml
# Annotate pods for auto-instrumentation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-java: "java-instrumentation"
    spec:
      containers:
      - name: java-service
        image: myapp/java-service:latest
```

### OpenTelemetry SDK Configuration for Go

```go
// otel.go - OpenTelemetry initialization for Go services
package telemetry

import (
    "context"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "os"
)

func InitTracer(serviceName string) (*sdktrace.TracerProvider, error) {
    ctx := context.Background()

    endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint == "" {
        endpoint = "localhost:4317"
    }

    conn, err := grpc.DialContext(ctx, endpoint,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        return nil, err
    }

    exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
    if err != nil {
        return nil, err
    }

    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion(os.Getenv("SERVICE_VERSION")),
            semconv.DeploymentEnvironment(os.Getenv("ENVIRONMENT")),
        ),
        resource.WithFromEnv(),
        resource.WithProcess(),
        resource.WithOS(),
        resource.WithContainer(),
        resource.WithHost(),
    )
    if err != nil {
        return nil, err
    }

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.ParentBased(
            sdktrace.TraceIDRatioBased(0.1), // 10% sampling
        )),
    )

    otel.SetTracerProvider(tp)
    return tp, nil
}
```

## Log Correlation with Traces

Correlating logs with traces requires injecting trace context (trace ID and span ID) into log entries. When both the logging backend and tracing backend are integrated in Grafana, users can jump from a log line to the corresponding trace.

### Structured Logging with Trace Context

```go
// logger.go - Structured logging with OpenTelemetry trace context
package logging

import (
    "context"
    "go.opentelemetry.io/otel/trace"
    "go.uber.org/zap"
)

func FromContext(ctx context.Context, logger *zap.Logger) *zap.Logger {
    span := trace.SpanFromContext(ctx)
    if !span.IsRecording() {
        return logger
    }

    spanCtx := span.SpanContext()
    return logger.With(
        zap.String("trace_id", spanCtx.TraceID().String()),
        zap.String("span_id", spanCtx.SpanID().String()),
        zap.Bool("trace_sampled", spanCtx.IsSampled()),
    )
}
```

### Loki LogQL Queries for Correlation

```logql
# Find logs for a specific trace
{namespace="production", app="myapp"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"

# Find errors in the last hour with trace IDs
{namespace="production"} |= "error" | json | line_format "{{.trace_id}} {{.msg}}"

# Count error logs by deployment
sum by (app) (
  count_over_time({namespace="production"} |= "error" [5m])
)

# Extract request duration from logs
{namespace="production", app="api"}
  | json
  | duration > 1s
  | line_format "{{.trace_id}} {{.path}} {{.duration}}"
```

### Grafana Explore for Log-Trace Correlation

Configure Grafana data source links to enable clicking from a log entry to its trace:

```yaml
# Grafana data source configuration for Loki with Tempo derived fields
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: monitoring
data:
  datasources.yaml: |
    apiVersion: 1
    datasources:
    - name: Loki
      type: loki
      url: http://loki.observability.svc.cluster.local:3100
      jsonData:
        derivedFields:
        - datasourceName: Tempo
          matcherRegex: '"trace_id":"(\w+)"'
          name: TraceID
          url: '$${__value.raw}'
          datasourceUid: tempo
    - name: Tempo
      type: tempo
      uid: tempo
      url: http://tempo.observability.svc.cluster.local:3100
      jsonData:
        tracesToLogsV2:
          datasourceUid: loki
          spanStartTimeShift: '-1m'
          spanEndTimeShift: '1m'
          filterByTraceID: true
          filterBySpanID: false
          tags:
          - key: namespace
            value: namespace
          - key: pod
            value: kubernetes_pod_name
```

## SLO Monitoring with Sloth

Sloth generates Prometheus recording rules and alerts from SLO specifications:

```yaml
apiVersion: sloth.slok.dev/v1
kind: PrometheusServiceLevel
metadata:
  name: myapp-slos
  namespace: monitoring
spec:
  service: myapp
  labels:
    team: platform
    env: production
  slos:
  - name: requests-availability
    objective: 99.9
    description: "99.9% of requests must succeed (non-5xx)"
    sli:
      events:
        errorQuery: |
          sum(rate(http_requests_total{namespace="production",job="myapp",status_code=~"5.."}[{{.window}}]))
        totalQuery: |
          sum(rate(http_requests_total{namespace="production",job="myapp"}[{{.window}}]))
    alerting:
      name: MyAppHighErrorRate
      labels:
        severity: critical
      annotations:
        summary: "MyApp error rate SLO violation"
      pageAlert:
        labels:
          severity: critical
      ticketAlert:
        labels:
          severity: warning

  - name: requests-latency
    objective: 99.0
    description: "99% of requests must complete within 500ms"
    sli:
      events:
        errorQuery: |
          sum(rate(http_request_duration_seconds_bucket{namespace="production",job="myapp",le="0.5"}[{{.window}}]))
        totalQuery: |
          sum(rate(http_request_duration_seconds_count{namespace="production",job="myapp"}[{{.window}}]))
    alerting:
      name: MyAppHighLatency
      labels:
        severity: warning
```

## Kubernetes Events as Metrics

Kubernetes events provide additional context for debugging—pod scheduling failures, resource quota exceeded, image pull errors:

```bash
# Deploy event exporter
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install kubernetes-event-exporter bitnami/kubernetes-event-exporter \
  --namespace monitoring \
  --set config.logLevel=debug \
  --set config.logFormat=json
```

```yaml
# Event exporter configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: event-exporter-cfg
  namespace: monitoring
data:
  config.yaml: |
    logLevel: error
    logFormat: json
    route:
      routes:
      - match:
        - receiver: dump
    receivers:
    - name: dump
      stdout:
        deDot: true
```

```promql
# Kubernetes events as metrics (from kube-state-metrics)
# Warning events in the last 10 minutes
increase(kube_event_count{type="Warning"}[10m])

# OOMKill events
kube_event_count{reason="OOMKilling"}

# Failed image pulls
kube_event_count{reason="Failed",type="Warning"} > 0
```

## Production Observability Checklist

```
Metrics Infrastructure
[ ] kube-prometheus-stack deployed with HA configuration
[ ] kube-state-metrics scraping all namespaces
[ ] node-exporter deployed as DaemonSet on all nodes
[ ] metrics-server deployed for HPA and kubectl top
[ ] Prometheus retention configured (minimum 15 days)
[ ] Long-term storage configured (Thanos or Cortex)

Application Instrumentation
[ ] All HTTP services expose /metrics endpoint
[ ] RED metrics instrumented (requests, errors, duration)
[ ] ServiceMonitor or PodMonitor created for each service
[ ] Recording rules pre-computing expensive aggregations
[ ] Resource request/limit instrumented for cost analysis

Alerting
[ ] Golden signal alerts defined for all user-facing services
[ ] Node USE alerts defined for all node pools
[ ] Kubernetes workload alerts (CrashLoopBackOff, OOMKilled, PVC pending)
[ ] Alert routing configured (PagerDuty, Slack, OpsGenie)
[ ] Alert runbooks linked in annotations
[ ] SLO burn rate alerts configured

Distributed Tracing
[ ] OpenTelemetry Collector deployed
[ ] Sampling strategy defined (head or tail-based)
[ ] Trace-to-log correlation configured in Grafana
[ ] Key business transactions instrumented end-to-end

Logging
[ ] Structured JSON logging from all services
[ ] Trace ID injected into log entries
[ ] Log aggregation pipeline deployed (Loki or EFK)
[ ] Log-based alerts defined for critical error patterns

Dashboards
[ ] Cluster overview dashboard
[ ] Namespace/workload RED dashboard
[ ] Node USE dashboard
[ ] SLO burn rate dashboard
[ ] Cost attribution dashboard
```
