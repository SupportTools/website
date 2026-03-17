---
title: "Kubernetes Cluster Observability: kube-state-metrics and Events at Scale"
date: 2031-03-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Observability", "Prometheus", "kube-state-metrics", "Monitoring", "Grafana", "Events"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to kube-state-metrics metric families, custom resource state metrics, Kubernetes event exporter, cardinality management with metric relabeling, and production alert rules for resource pressure."
more_link: "yes"
url: "/kubernetes-cluster-observability-kube-state-metrics-events-scale/"
---

Kubernetes cluster observability requires two complementary data streams that are often conflated: **state metrics** (what is the current desired and actual state of every Kubernetes object?) and **events** (what has happened to those objects?). kube-state-metrics provides the former, while a dedicated event exporter handles the latter. Together they expose the full picture of cluster health without relying on application-level instrumentation.

<!--more-->

# Kubernetes Cluster Observability: kube-state-metrics and Events at Scale

## Section 1: kube-state-metrics Architecture

### How kube-state-metrics Works

kube-state-metrics (KSM) is a Kubernetes add-on that watches every object in the cluster via the API server's list-watch mechanism, then exposes the current state of those objects as Prometheus-compatible gauge and counter metrics. Unlike the metrics-server (which serves resource consumption metrics for HPA and kubectl top), KSM focuses entirely on object state: Is a Deployment at its desired replica count? Is a PersistentVolumeClaim bound? Is a Pod in CrashLoopBackOff?

KSM operates as a passive observer — it never modifies cluster state. The architecture:

```
Kubernetes API Server
    │
    │  list-watch (informers)
    ▼
kube-state-metrics
    │  generates metrics from informer cache
    ▼
Prometheus scrape endpoint (:8080/metrics)
    │
    ▼
Prometheus → Grafana, Alertmanager
```

### Sharding for Large Clusters

In clusters with hundreds of thousands of objects, a single KSM instance can become a bottleneck. KSM supports horizontal sharding since v2.0:

```yaml
# kube-state-metrics deployment with 4 shards
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kube-state-metrics
  namespace: monitoring
spec:
  replicas: 4
  selector:
    matchLabels:
      app: kube-state-metrics
  template:
    metadata:
      labels:
        app: kube-state-metrics
    spec:
      serviceAccountName: kube-state-metrics
      containers:
      - name: kube-state-metrics
        image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0
        args:
        - --shard=$(POD_INDEX)
        - --total-shards=4
        - --port=8080
        - --telemetry-port=8081
        # Limit resource types to reduce cardinality
        - --resources=pods,deployments,daemonsets,statefulsets,services,
          persistentvolumeclaims,nodes,replicasets,cronjobs,jobs,namespaces,
          horizontalpodautoscalers,configmaps,secrets,
          verticalpodautoscalers
        env:
        - name: POD_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['apps.kubernetes.io/pod-index']
        ports:
        - containerPort: 8080
          name: http-metrics
        - containerPort: 8081
          name: telemetry
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 2Gi
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
```

Each shard handles a subset of objects, determined by consistent hashing. Prometheus scrapes all shards and the metrics deduplicate correctly.

## Section 2: Core Metric Families

### Pod Metrics

The most valuable KSM metrics for operations teams:

```promql
# Pods not running
kube_pod_status_phase{phase!="Running",phase!="Succeeded"} == 1

# Pods in CrashLoopBackOff
kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"} == 1

# OOMKilled containers
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1

# Pods that have been restarted many times
kube_pod_container_status_restarts_total > 5

# Container resource requests vs limits
kube_pod_container_resource_requests{resource="cpu"}
kube_pod_container_resource_limits{resource="memory"}

# Pods not assigned to a node (stuck in Pending)
kube_pod_status_scheduled{condition="false"} == 1

# Pods ready condition
kube_pod_status_ready{condition="true"} == 0
```

### Deployment Metrics

```promql
# Deployments not at desired replica count
kube_deployment_spec_replicas - kube_deployment_status_replicas_available > 0

# Deployments with paused rollout
kube_deployment_spec_paused == 1

# Deployment generation mismatch (stuck rollout)
kube_deployment_metadata_generation - kube_deployment_status_observed_generation > 0

# Available replicas fraction
kube_deployment_status_replicas_available / kube_deployment_spec_replicas
```

### Node Metrics

```promql
# Nodes not Ready
kube_node_status_condition{condition="Ready",status="true"} == 0

# Node under memory pressure
kube_node_status_condition{condition="MemoryPressure",status="true"} == 1

# Node under disk pressure
kube_node_status_condition{condition="DiskPressure",status="true"} == 1

# Node CPU allocatable vs requested
kube_node_status_allocatable{resource="cpu"} -
  sum(kube_pod_container_resource_requests{resource="cpu"}) by (node)

# Node memory allocatable vs requested
kube_node_status_allocatable{resource="memory"} -
  sum(kube_pod_container_resource_requests{resource="memory"}) by (node)

# Nodes marked unschedulable
kube_node_spec_unschedulable == 1
```

### PersistentVolume Metrics

```promql
# PVCs not bound
kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1

# PV capacity vs used
kube_persistentvolume_capacity_bytes
kube_persistentvolumeclaim_resource_requests_storage_bytes

# PVs in Failed state
kube_persistentvolume_status_phase{phase="Failed"} == 1
```

## Section 3: Custom Resource State Metrics

KSM v2.0+ supports custom resource metrics via a ConfigMap-driven configuration. This allows you to expose metrics for any CRD without modifying KSM itself.

### Custom Resource State Config

Create a ConfigMap defining how to extract metrics from a custom resource:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-state-metrics-custom-resource-state
  namespace: monitoring
data:
  config.yaml: |
    spec:
      resources:
      # Example: Monitor Argo Rollouts
      - groupVersionKind:
          group: "argoproj.io"
          version: "v1alpha1"
          kind: "Rollout"
        metricNamePrefix: kube_rollout
        labelsFromPath:
          name: [metadata, name]
          namespace: [metadata, namespace]
          strategy: [spec, strategy, type]
        metrics:
        - name: "status_phase"
          help: "The current phase of the rollout"
          each:
            type: StateSet
            stateSet:
              labelName: phase
              path: [status, phase]
              list:
              - Progressing
              - Paused
              - Healthy
              - Degraded
              - Error
        - name: "desired_replicas"
          help: "Desired replicas for the rollout"
          each:
            type: Gauge
            gauge:
              path: [spec, replicas]
        - name: "ready_replicas"
          help: "Ready replicas for the rollout"
          each:
            type: Gauge
            gauge:
              path: [status, readyReplicas]
              nilIsZero: true

      # Example: Monitor VitessCluster tablets
      - groupVersionKind:
          group: "planetscale.dev"
          version: "v2"
          kind: "VitessCluster"
        metricNamePrefix: kube_vitesscluster
        labelsFromPath:
          name: [metadata, name]
          namespace: [metadata, namespace]
        metrics:
        - name: "ready"
          help: "Whether the VitessCluster is ready"
          each:
            type: Gauge
            gauge:
              path: [status, conditions]
              nilIsZero: true

      # Example: Monitor CertificateSigningRequests
      - groupVersionKind:
          group: "cert-manager.io"
          version: "v1"
          kind: "Certificate"
        metricNamePrefix: kube_certificate
        labelsFromPath:
          name: [metadata, name]
          namespace: [metadata, namespace]
          issuer: [spec, issuerRef, name]
        metrics:
        - name: "ready"
          help: "Certificate readiness"
          each:
            type: Gauge
            gauge:
              path: [status, conditions, "[type=Ready]", status]
              booleanValueMap:
                "True": 1
                "False": 0
        - name: "expiry_time_seconds"
          help: "Certificate expiry time as Unix timestamp"
          each:
            type: Gauge
            gauge:
              path: [status, notAfter]
              type: "DateTimeAsUnix"
```

Mount this ConfigMap in KSM:

```yaml
# In kube-state-metrics container spec
args:
- --custom-resource-state-config-file=/etc/config/config.yaml

volumeMounts:
- name: custom-resource-state
  mountPath: /etc/config

volumes:
- name: custom-resource-state
  configMap:
    name: kube-state-metrics-custom-resource-state
```

### Querying Custom Resource Metrics

```promql
# Rollouts that are not Healthy
kube_rollout_status_phase{phase="Degraded"} == 1

# Certificate expiring in next 14 days
kube_certificate_expiry_time_seconds - time() < (14 * 24 * 3600)

# Rollout replica availability
kube_rollout_ready_replicas / kube_rollout_desired_replicas < 0.9
```

## Section 4: Kubernetes Event Exporter

Kubernetes events are ephemeral (TTL of 1 hour by default) and stored in etcd, which creates scaling challenges at high event rates. A dedicated event exporter captures and forwards events to a durable backend.

### kubernetes-event-exporter Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: event-exporter
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: event-exporter
  template:
    metadata:
      labels:
        app: event-exporter
    spec:
      serviceAccountName: event-exporter
      containers:
      - name: event-exporter
        image: ghcr.io/resmoio/kubernetes-event-exporter:v1.7
        args:
        - --config=/data/config.yaml
        volumeMounts:
        - name: config
          mountPath: /data
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 256Mi
      volumes:
      - name: config
        configMap:
          name: event-exporter-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: event-exporter-config
  namespace: monitoring
data:
  config.yaml: |
    logLevel: warn
    logFormat: json
    route:
      routes:
      # Critical events → Elasticsearch
      - match:
        - receiver: elasticsearch
      # Warning events from specific namespaces → Slack
      - match:
        - type: Warning
          namespace: "production"
        receiver: slack-warnings
      # All events to metrics
      - match:
        - receiver: prometheus
    receivers:
    - name: elasticsearch
      elasticsearch:
        hosts:
        - http://elasticsearch-master.monitoring.svc.cluster.local:9200
        index: "kubernetes-events"
        indexFormat: "kubernetes-events-{2006-01-02}"
        username: "elastic"
        password: "${ELASTIC_PASSWORD}"
        tls:
          insecureSkipVerify: false
        layout:
          message: "{{ .Message }}"
          reason: "{{ .Reason }}"
          type: "{{ .Type }}"
          count: "{{ .Count }}"
          namespace: "{{ .InvolvedObject.Namespace }}"
          name: "{{ .InvolvedObject.Name }}"
          kind: "{{ .InvolvedObject.Kind }}"
          host: "{{ .Source.Host }}"
          component: "{{ .Source.Component }}"
          firstTime: "{{ .FirstTimestamp }}"
          lastTime: "{{ .LastTimestamp }}"

    - name: slack-warnings
      slack:
        webhook: "${SLACK_WEBHOOK_URL}"
        channel: "#k8s-events"
        color: "danger"
        message: |
          *{{ .Type }} Event: {{ .Reason }}*
          Namespace: {{ .InvolvedObject.Namespace }}
          Object: {{ .InvolvedObject.Kind }}/{{ .InvolvedObject.Name }}
          Message: {{ .Message }}

    - name: prometheus
      prometheus:
        listenAddress: "0.0.0.0:2112"
        metricsNamePrefix: "event_exporter_"
        layouts:
          count:
            type: "{{ .Type }}"
            reason: "{{ .Reason }}"
            namespace: "{{ .InvolvedObject.Namespace }}"
            kind: "{{ .InvolvedObject.Kind }}"
```

### RBAC for Event Exporter

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: event-exporter
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: event-exporter
rules:
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: event-exporter
subjects:
- kind: ServiceAccount
  name: event-exporter
  namespace: monitoring
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: event-exporter
```

### Prometheus Metrics from Events

The event exporter exposes counts of events by type, reason, namespace, and kind:

```promql
# Warning events in the last 5 minutes
increase(event_exporter_count{type="Warning"}[5m]) > 0

# OOMKilled events (pod was killed due to memory)
increase(event_exporter_count{reason="OOMKilling"}[5m]) > 0

# Failed pod scheduling
increase(event_exporter_count{reason="FailedScheduling"}[5m]) > 3

# Node NotReady events
increase(event_exporter_count{reason="NodeNotReady",kind="Node"}[10m]) > 0

# Kubernetes controller errors
increase(event_exporter_count{
  type="Warning",
  reason=~"Failed.*|BackOff|Unhealthy"
}[5m]) by (namespace, kind, reason) > 5
```

## Section 5: Comprehensive Alert Rules

### Resource Pressure Alerts

```yaml
groups:
- name: kubernetes.cluster.rules
  interval: 30s
  rules:

  # Pod health
  - alert: KubePodCrashLooping
    expr: |
      increase(kube_pod_container_status_restarts_total[15m]) > 3
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
      description: "Container {{ $labels.container }} has restarted {{ $value | printf \"%.0f\" }} times in 15 minutes."

  - alert: KubePodNotRunning
    expr: |
      kube_pod_status_phase{phase!~"Running|Succeeded"} == 1
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is not running"

  - alert: KubePodOOMKilled
    expr: |
      kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
    for: 0m
    labels:
      severity: critical
    annotations:
      summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} was OOM killed"

  # Deployment health
  - alert: KubeDeploymentReplicasMismatch
    expr: |
      (kube_deployment_spec_replicas > 0)
      and
      (kube_deployment_status_replicas_available / kube_deployment_spec_replicas < 0.5)
    for: 15m
    labels:
      severity: critical
    annotations:
      summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} has fewer than 50% replicas available"

  - alert: KubeDeploymentGenerationMismatch
    expr: |
      kube_deployment_metadata_generation - kube_deployment_status_observed_generation > 0
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} rollout is stuck"

  # StatefulSet health
  - alert: KubeStatefulSetReplicasMismatch
    expr: |
      kube_statefulset_status_replicas_ready != kube_statefulset_status_replicas
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has {{ $value }} unready replicas"

  # DaemonSet health
  - alert: KubeDaemonSetNotScheduled
    expr: |
      kube_daemonset_status_desired_number_scheduled
      - kube_daemonset_status_current_number_scheduled > 0
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} has pods not scheduled on some nodes"

  # Node health
  - alert: KubeNodeNotReady
    expr: kube_node_status_condition{condition="Ready",status="true"} == 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Node {{ $labels.node }} is not Ready"

  - alert: KubeNodeMemoryPressure
    expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Node {{ $labels.node }} is under memory pressure"

  - alert: KubeNodeDiskPressure
    expr: kube_node_status_condition{condition="DiskPressure",status="true"} == 1
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Node {{ $labels.node }} is under disk pressure"

  # PVC health
  - alert: KubePVCNotBound
    expr: kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is not bound"

  # Resource saturation
  - alert: KubeNodeCPUSaturation
    expr: |
      (
        sum(kube_pod_container_resource_requests{resource="cpu"}) by (node)
        /
        kube_node_status_allocatable{resource="cpu"}
      ) > 0.95
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Node {{ $labels.node }} CPU requests at {{ $value | printf \"%.0f%%\" }} of allocatable"

  - alert: KubeNodeMemorySaturation
    expr: |
      (
        sum(kube_pod_container_resource_requests{resource="memory"}) by (node)
        /
        kube_node_status_allocatable{resource="memory"}
      ) > 0.95
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Node {{ $labels.node }} memory requests at {{ $value | printf \"%.0f%%\" }} of allocatable"

  # Job/CronJob health
  - alert: KubeJobFailed
    expr: kube_job_status_failed > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Job {{ $labels.namespace }}/{{ $labels.job_name }} has failed pods"

  - alert: KubeCronJobSuspended
    expr: kube_cronjob_spec_suspend == 1
    for: 0m
    labels:
      severity: info
    annotations:
      summary: "CronJob {{ $labels.namespace }}/{{ $labels.cronjob }} is suspended"

  # HPA health
  - alert: KubeHPAMaxedOut
    expr: |
      kube_horizontalpodautoscaler_status_current_replicas
      >= kube_horizontalpodautoscaler_spec_max_replicas
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} has reached maximum replicas — scaling is constrained"

  - alert: KubeHPAMinAvailable
    expr: |
      kube_horizontalpodautoscaler_status_current_replicas
      == kube_horizontalpodautoscaler_spec_min_replicas
    for: 30m
    labels:
      severity: info
    annotations:
      summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} is at minimum replicas"
```

## Section 6: Cardinality Management

### The Cardinality Problem

High cardinality in Prometheus metrics causes memory exhaustion and slow queries. Common KSM cardinality explosions:

1. **Labels from ConfigMaps/Secrets**: KSM exposes all labels and annotations as metric labels by default.
2. **pod UID in labels**: Each pod restart creates a new UID, causing infinite time series growth.
3. **Custom labels with user-generated values**: Tenant IDs, request IDs, etc. embedded in object labels.

### Metric Relabeling to Reduce Cardinality

Configure metric relabeling in Prometheus scrape config to drop high-cardinality labels:

```yaml
# prometheus.yaml scrape configuration
scrape_configs:
- job_name: kube-state-metrics
  static_configs:
  - targets: ['kube-state-metrics.monitoring.svc.cluster.local:8080']

  metric_relabel_configs:
  # Drop labels with unbounded cardinality
  - source_labels: [__name__]
    regex: "kube_pod_labels|kube_pod_annotations"
    action: drop

  # Keep only specific pod labels that are operationally useful
  - source_labels: [__name__]
    regex: "kube_pod_labels"
    action: keep
  - regex: "label_app|label_version|label_environment|label_team"
    action: labelkeep

  # Drop all configmap and secret content metrics (very high cardinality)
  - source_labels: [__name__]
    regex: "kube_configmap_.*|kube_secret_.*"
    action: drop

  # Normalize environment label values
  - source_labels: [label_env]
    target_label: label_env
    regex: "prod|production"
    replacement: "production"

  # Drop metrics for completed/succeeded jobs (no longer actionable)
  - source_labels: [__name__, job_status]
    regex: "kube_job.*;complete"
    action: drop
```

### KSM Built-In Cardinality Controls

KSM itself supports label allowlists and denylists:

```bash
# Allow only specific labels to be exposed as metric labels
--metric-labels-allowlist=pods=[app,version,team],
  deployments=[app,version],
  nodes=[kubernetes.io/hostname]

# Deny specific annotations (avoid high-cardinality annotation metrics)
--metric-annotations-allowlist=pods=[],deployments=[]

# Explicitly disable expensive resource types
--resources=pods,deployments,daemonsets,statefulsets,services,
  persistentvolumeclaims,nodes,horizontalpodautoscalers
# Omit: configmaps, secrets (very high cardinality in large clusters)
```

### Cardinality Audit

Periodically audit metric cardinality in Prometheus:

```promql
# Top 20 metrics by time series count
topk(20, count by (__name__)({job="kube-state-metrics"}))

# Detect metrics with unbounded label growth
count by (__name__, namespace)(
  {job="kube-state-metrics", __name__=~"kube_pod.*"}
) > 10000

# Label cardinality per metric
count(group by (pod)({job="kube-state-metrics", __name__="kube_pod_status_phase"}))
```

## Section 7: Dashboard Design

### The Four Golden Signals for Kubernetes

Adapt Google's SRE golden signals to Kubernetes cluster observability:

**Saturation**: How full is the cluster?

```promql
# Node CPU saturation
1 - (
  sum(kube_node_status_allocatable{resource="cpu"})
  - sum(kube_pod_container_resource_requests{resource="cpu"})
) / sum(kube_node_status_allocatable{resource="cpu"})

# Node memory saturation
1 - (
  sum(kube_node_status_allocatable{resource="memory"})
  - sum(kube_pod_container_resource_requests{resource="memory"})
) / sum(kube_node_status_allocatable{resource="memory"})

# Cluster pod capacity used
sum(kube_node_status_capacity{resource="pods"}) -
  count(kube_pod_status_phase{phase="Running"})
```

**Traffic**: How much work is the cluster doing?

```promql
# Pod count by namespace over time
count by (namespace)(kube_pod_status_phase{phase="Running"})

# Deployment rollout activity
changes(kube_deployment_metadata_generation[1h])
```

**Errors**: What fraction of things are broken?

```promql
# Fraction of pods not ready
(
  count(kube_pod_status_ready{condition="false"} == 1)
  /
  count(kube_pod_status_phase{phase="Running"} == 1)
) * 100

# Failed jobs in last hour
count(kube_job_status_failed > 0)
```

**Latency**: How long does cluster state change take?

```promql
# HPA reaction time (implicit from replica count changes)
# DaemonSet rollout duration
# Deployment rollout duration
increase(kube_deployment_metadata_generation[1h]) > 0
```

### Grafana Dashboard JSON Structure

A minimal but comprehensive cluster overview dashboard:

```json
{
  "title": "Kubernetes Cluster Overview",
  "panels": [
    {
      "type": "stat",
      "title": "Cluster Node Count",
      "targets": [{"expr": "count(kube_node_info)"}]
    },
    {
      "type": "stat",
      "title": "Running Pods",
      "targets": [{"expr": "count(kube_pod_status_phase{phase=\"Running\"} == 1)"}]
    },
    {
      "type": "stat",
      "title": "Pods Not Ready",
      "targets": [{"expr": "count(kube_pod_status_ready{condition=\"false\"} == 1) or vector(0)"}],
      "fieldConfig": {"thresholds": {"steps": [{"color": "green", "value": 0}, {"color": "red", "value": 1}]}}
    },
    {
      "type": "table",
      "title": "Problem Pods",
      "targets": [{
        "expr": "kube_pod_status_phase{phase!~\"Running|Succeeded\"} == 1",
        "format": "table"
      }]
    },
    {
      "type": "timeseries",
      "title": "Node CPU Allocation %",
      "targets": [{
        "expr": "sum(kube_pod_container_resource_requests{resource=\"cpu\"}) by (node) / kube_node_status_allocatable{resource=\"cpu\"} * 100",
        "legendFormat": "{{ node }}"
      }]
    }
  ]
}
```

## Section 8: Scaling Prometheus for KSM

### Remote Write for Long-Term Storage

At scale, Prometheus scraping KSM produces millions of time series. Use remote write to offload to Thanos or VictoriaMetrics:

```yaml
# prometheus configuration
remote_write:
- url: "http://thanos-receive.monitoring.svc.cluster.local:19291/api/v1/receive"
  remote_timeout: 30s
  queue_config:
    capacity: 100000
    max_shards: 30
    min_shards: 5
    max_samples_per_send: 5000
    batch_send_deadline: 5s
  write_relabel_configs:
  # Only send KSM metrics to long-term storage
  - source_labels: [job]
    regex: "kube-state-metrics"
    action: keep
```

### Prometheus Federation for Multi-Cluster

For multi-cluster environments, federate KSM metrics to a global Prometheus:

```yaml
# Global Prometheus federation config
scrape_configs:
- job_name: 'federated-kube-state-metrics'
  scrape_interval: 60s
  honor_labels: true
  metrics_path: '/federate'
  params:
    match[]:
    - '{job="kube-state-metrics"}'
    - '{__name__=~"kube_.*"}'
  static_configs:
  - targets:
    - 'prometheus.cluster-a.example.com:9090'
    - 'prometheus.cluster-b.example.com:9090'
    - 'prometheus.cluster-c.example.com:9090'
  relabel_configs:
  - source_labels: [__address__]
    target_label: cluster
    regex: 'prometheus\.([^.]+)\..*'
    replacement: '$1'
```

## Summary

A production-grade Kubernetes observability stack requires:

1. **kube-state-metrics** with sharding enabled for large clusters, custom resource state configs for CRDs, and carefully managed label allowlists to control cardinality.

2. **Kubernetes event exporter** forwarding Warning events to both durable storage (Elasticsearch) and actionable channels (Slack/PagerDuty), plus Prometheus metrics for event rate tracking.

3. **Alert rules** covering the full object lifecycle: pods in non-running phases, deployment replica mismatches, node conditions, PVC binding failures, and HPA saturation.

4. **Cardinality management** via metric relabeling and KSM label allowlists, preventing the cardinality explosion that causes Prometheus OOM events in large clusters.

5. **Dashboard design** based on four golden signals adapted for cluster-level observability rather than application-level metrics.
