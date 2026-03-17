---
title: "Kubernetes Cluster Observability: kube-state-metrics Deep Dive"
date: 2029-10-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Observability", "kube-state-metrics", "Prometheus", "Monitoring", "Metrics"]
categories: ["Kubernetes", "Observability", "Monitoring"]
author: "Matthew Mattox - mmattox@support.tools"
description: "An in-depth guide to kube-state-metrics architecture, metric naming conventions, custom resource metrics, cardinality management strategies, and shard mode configuration for large Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-cluster-observability-kube-state-metrics-deep-dive/"
---

Kubernetes exposes rich operational data through its API — pod states, deployment rollout progress, resource requests, node conditions, PVC binding status, and dozens of other dimensions. kube-state-metrics (KSM) translates this API data into Prometheus metrics, making the entire cluster state queryable as time series. Understanding KSM's architecture, metric naming conventions, and scaling strategies is foundational to building reliable cluster observability.

<!--more-->

# Kubernetes Cluster Observability: kube-state-metrics Deep Dive

## Section 1: What kube-state-metrics Provides

kube-state-metrics watches the Kubernetes API and converts object state into Prometheus-compatible metrics. It is distinct from metrics-server (which provides CPU/memory for `kubectl top`) and from node-exporter (which exposes host-level metrics). KSM answers questions like:

- How many deployments are in a degraded state?
- Which pods are not scheduled due to resource pressure?
- Which PVCs have been in `Pending` state for more than 5 minutes?
- How many of my namespace's CPU requests exceed the namespace quota?
- Which nodes are under memory pressure?

These questions are about Kubernetes object state, not about resource consumption metrics. They complement CPU/memory metrics from Prometheus Node Exporter or the kubelet metrics endpoint.

## Section 2: Architecture

### How KSM Works Internally

```
Kubernetes API Server
       │
       │ (List + Watch)
       ▼
kube-state-metrics
├── Reflector (per resource type)
│   ├── Stores objects in local cache (client-go informer)
│   └── Receives watch events for updates
├── Metric Store
│   └── Generates Prometheus metrics from cached objects on scrape
└── HTTP Server
    ├── /metrics (main metrics endpoint)
    └── /telemetry (KSM's own self-metrics)

Prometheus
    └── Scrapes /metrics every 30-60 seconds
```

KSM does not push metrics — it exposes them on a pull endpoint. Each time Prometheus scrapes `/metrics`, KSM iterates over its in-memory cache of Kubernetes objects and generates the current metric values. This means metric values are always current as of the last cache update, not as of the last scrape.

### KSM vs. kubelet /metrics/resource

| Source | Data Type | Refresh Rate |
|---|---|---|
| kube-state-metrics | Object state (spec, status) | Event-driven (watch) |
| kubelet /metrics/resource | CPU/memory usage | Reported every 30s |
| metrics-server | Aggregated CPU/memory | ~60s |
| node-exporter | Host-level system metrics | Configurable (15s-60s) |

### Deployment Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: monitoring
spec:
  replicas: 1
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
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0
          args:
            # Limit to specific resource types to reduce cardinality
            - --resources=pods,deployments,replicasets,services,nodes,
                          persistentvolumeclaims,persistentvolumes,
                          namespaces,resourcequotas,configmaps,secrets,
                          jobs,cronjobs,statefulsets,daemonsets,
                          horizontalpodautoscalers,ingresses
            # Control which labels to expose as metric labels
            - --metric-labels-allowlist=pods=[app,component,tier,version],
                                        deployments=[app,component],
                                        nodes=[kubernetes.io/os,node.kubernetes.io/instance-type]
            # Telemetry port (KSM's own metrics)
            - --telemetry-port=8081
          ports:
            - containerPort: 8080
              name: http-metrics
            - containerPort: 8081
              name: telemetry
          resources:
            requests:
              cpu: 10m
              memory: 190Mi
            limits:
              cpu: 200m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 65534
            seccompProfile:
              type: RuntimeDefault
            capabilities:
              drop:
                - ALL
```

## Section 3: Metric Naming Conventions

KSM follows a consistent naming scheme:

```
kube_<resource_type>_<attribute>
```

Examples:
- `kube_pod_status_phase` — current phase of a pod
- `kube_deployment_status_replicas_available` — available replicas in a deployment
- `kube_node_status_condition` — condition values for a node
- `kube_persistentvolumeclaim_status_phase` — PVC binding phase

### Common Label Dimensions

Every KSM metric includes labels that identify the Kubernetes object:

```
kube_pod_status_phase{
  namespace="production",
  pod="frontend-7d8f9b-xvzpq",
  uid="abc-123",
  phase="Running"
} 1
```

The `uid` label ensures uniqueness when a pod is deleted and recreated with the same name (different UID).

### Info Metrics

KSM exposes "info" metrics that carry metadata as labels (value is always 1):

```
kube_pod_info{
  namespace="production",
  pod="frontend-7d8f9b-xvzpq",
  node="worker-01",
  created_by_kind="ReplicaSet",
  created_by_name="frontend-7d8f9b",
  uid="abc-123",
  host_ip="10.0.0.5",
  pod_ip="10.244.1.5"
} 1
```

Info metrics are useful for joining with other metrics via Prometheus `*` multiplication or `group_left`:

```promql
# Get the node for each pod that is OOM-killed
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}
* on(namespace, pod) group_left(node)
kube_pod_info
```

## Section 4: Essential Metrics Catalog

### Pod Metrics

```promql
# Pods not in Running phase (identify stuck pods)
kube_pod_status_phase{phase!="Running",phase!="Succeeded"} == 1

# Pods with high restart counts (potential crash loops)
kube_pod_container_status_restarts_total > 5

# Pods in CrashLoopBackOff (OOMKilled or application error)
kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"} == 1

# Pods pending scheduling (resource pressure)
kube_pod_status_scheduled{condition="false"} == 1
```

### Deployment Metrics

```promql
# Deployments with unavailable replicas
kube_deployment_status_replicas_unavailable > 0

# Deployments not at desired replica count
kube_deployment_spec_replicas != kube_deployment_status_replicas_available

# Deployments currently rolling out
kube_deployment_status_observed_generation != kube_deployment_metadata_generation

# Paused deployments (may be intentional, track for audit)
kube_deployment_spec_paused == 1
```

### Node Metrics

```promql
# Nodes with memory pressure
kube_node_status_condition{condition="MemoryPressure",status="true"} == 1

# Nodes with disk pressure
kube_node_status_condition{condition="DiskPressure",status="true"} == 1

# Nodes not Ready
kube_node_status_condition{condition="Ready",status="true"} == 0

# Node capacity vs allocatable (scheduler overhead)
kube_node_status_capacity{resource="cpu"} - kube_node_status_allocatable{resource="cpu"}
```

### PVC Metrics

```promql
# PVCs not bound (storage provisioning failures)
kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1

# PVCs nearing capacity (requires storage provider metrics joined)
kube_persistentvolumeclaim_resource_requests_storage_bytes

# PVs without a bound PVC (orphaned volumes)
kube_persistentvolume_status_phase{phase="Available"} == 1
```

### Resource Quota Metrics

```promql
# Namespaces near CPU quota limit
kube_resourcequota{resource="requests.cpu",type="used"}
/ kube_resourcequota{resource="requests.cpu",type="hard"} > 0.8

# Namespaces near pod count quota
kube_resourcequota{resource="pods",type="used"}
/ kube_resourcequota{resource="pods",type="hard"} > 0.9
```

## Section 5: Custom Resource Metrics

KSM supports custom resource definitions (CRDs) through its `--custom-resource-state-config` flag. This allows you to expose metrics from any CRD without writing a custom exporter.

### Configuration Format

```yaml
# custom-resource-state.yaml
kind: CustomResourceStateMetrics
spec:
  resources:
    - groupVersionKind:
        group: batch.example.com
        version: v1
        kind: PipelineRun
      labelsFromPath:
        pipeline: [metadata, labels, "pipeline.example.com/name"]
        namespace: [metadata, namespace]
        run_id: [metadata, name]
      metrics:
        - name: "pipeline_run_status"
          help: "Status of a PipelineRun"
          each:
            type: StateSet
            path: [status, phase]
            stateSet:
              labelName: phase
              list:
                - "Pending"
                - "Running"
                - "Succeeded"
                - "Failed"
                - "Cancelled"
        - name: "pipeline_run_duration_seconds"
          help: "Duration of completed PipelineRun in seconds"
          each:
            type: Gauge
            path: [status, completionTimestamp]
            nilIsZero: true
        - name: "pipeline_run_tasks_total"
          help: "Total number of tasks in a PipelineRun"
          each:
            type: Gauge
            path: [status, taskRuns]
            type: Gauge
            nilIsZero: true
```

```bash
# Mount the config and pass it to KSM
kubectl create configmap ksm-custom-config \
    --from-file=config.yaml=custom-resource-state.yaml \
    -n monitoring

# Add to KSM deployment args
- --custom-resource-state-config-file=/config/config.yaml
# And volume mount the configmap
```

### Using nilIsZero and ErrorLogV

```yaml
metrics:
  - name: "database_cluster_replicas"
    help: "Number of replicas in a database cluster"
    each:
      type: Gauge
      path: [status, readyReplicas]
      nilIsZero: true     # Return 0 if field doesn't exist (not an error)
      errorLogV: 5        # Log errors at verbosity 5 (hide noisy errors in debug)
```

## Section 6: Cardinality Management

Cardinality is the primary scaling challenge with KSM. Each unique combination of label values creates a distinct time series. A cluster with 10,000 pods, each with 10 unique label combinations, can produce 100,000+ time series just for pod metrics.

### The allow-list Approach

```bash
# Only expose specific labels as Prometheus labels
# This dramatically reduces cardinality
--metric-labels-allowlist=pods=[app,version,component],deployments=[app,team]

# All other pod labels are EXCLUDED from metrics (still accessible via annotations)
```

### The deny-list Approach

```bash
# Exclude specific metrics entirely
--metric-denylist=kube_pod_annotations,kube_secret_info
```

### Recommended Cardinality Limits

```
Small cluster   (<100 nodes, <1,000 pods):   < 100,000 time series
Medium cluster  (<500 nodes, <10,000 pods):  < 1,000,000 time series
Large cluster   (500+ nodes, 10,000+ pods):  Use KSM sharding
```

### Measuring KSM Cardinality

```promql
# Total number of time series KSM is producing
count({__name__=~"kube_.*"})

# Time series per metric name (find high-cardinality metrics)
sort_desc(
  count by(__name__) ({__name__=~"kube_.*"})
)

# KSM's own cardinality metrics
kube_state_metrics_total_metric_families
kube_state_metrics_total_time_series
```

## Section 7: Shard Mode for Large Clusters

When a single KSM instance cannot keep up with the volume of Kubernetes API events or the number of time series exceeds scrape timeout limits, use shard mode.

### How Sharding Works

KSM uses a modular hashing scheme to distribute work across N replicas. Each replica is responsible for 1/N of the objects in each resource type.

```
Object UID hash mod N → shard index
Replica i handles objects where: hash(UID) mod N == i
```

### Deploying KSM with Sharding

```yaml
# Deploy N replicas, each with --shard and --total-shards
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kube-state-metrics
  namespace: monitoring
spec:
  replicas: 4    # 4 shards
  selector:
    matchLabels:
      app: kube-state-metrics
  serviceName: kube-state-metrics
  template:
    metadata:
      labels:
        app: kube-state-metrics
    spec:
      serviceAccountName: kube-state-metrics
      containers:
        - name: kube-state-metrics
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0
          args:
            - --shard=$(POD_INDEX)
            - --total-shards=4
            - --resources=pods,deployments,replicasets,services,nodes,
                          persistentvolumeclaims,statefulsets,daemonsets
            - --metric-labels-allowlist=pods=[app,tier],deployments=[app]
          env:
            - name: POD_INDEX
              valueFrom:
                fieldRef:
                  fieldPath: metadata.labels['apps.kubernetes.io/pod-index']
          ports:
            - containerPort: 8080
              name: http-metrics
          resources:
            requests:
              cpu: 100m
              memory: 500Mi
            limits:
              cpu: 500m
              memory: 2Gi
```

### Prometheus ServiceMonitor for Sharded KSM

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kube-state-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: kube-state-metrics
  namespaceSelector:
    matchNames:
      - monitoring
  endpoints:
    - port: http-metrics
      interval: 30s
      scrapeTimeout: 25s
      # Scrape all pods in the StatefulSet
      honorLabels: true
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: instance
```

### Validating Shard Coverage

```promql
# Each KSM shard exposes which shard it is via a label
kube_state_metrics_shard_ordinal

# Verify all shards are present and scraping
count(kube_state_metrics_shard_ordinal) == 4  # should equal total-shards

# Check for shard gaps (missing coverage)
max(kube_state_metrics_shard_ordinal) + 1 == count(kube_state_metrics_shard_ordinal)
```

## Section 8: Alerting Rules

```yaml
# PrometheusRule for Kubernetes cluster health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-cluster-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubernetes.pods
      interval: 30s
      rules:
        - alert: PodCrashLooping
          expr: |
            rate(kube_pod_container_status_restarts_total[15m]) * 60 * 5 > 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
            description: "Container {{ $labels.container }} has restarted {{ $value | humanize }} times in the last 15 minutes"

        - alert: PodPendingTooLong
          expr: |
            kube_pod_status_phase{phase="Pending"} == 1
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} has been Pending for 15 minutes"

        - alert: PodOOMKilled
          expr: |
            kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} in pod {{ $labels.namespace }}/{{ $labels.pod }} was OOMKilled"

    - name: kubernetes.deployments
      rules:
        - alert: DeploymentReplicasMismatch
          expr: |
            kube_deployment_spec_replicas{job="kube-state-metrics"}
            !=
            kube_deployment_status_replicas_available{job="kube-state-metrics"}
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} has {{ $value }} unavailable replicas"

        - alert: DeploymentRolloutStuck
          expr: |
            kube_deployment_status_observed_generation{job="kube-state-metrics"}
            !=
            kube_deployment_metadata_generation{job="kube-state-metrics"}
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} rollout is stuck"

    - name: kubernetes.nodes
      rules:
        - alert: NodeNotReady
          expr: kube_node_status_condition{condition="Ready",status="true"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.node }} is not Ready"

        - alert: NodeMemoryPressure
          expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.node }} is under memory pressure"

    - name: kubernetes.pvcs
      rules:
        - alert: PVCNotBound
          expr: kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is not bound"
```

## Section 9: Advanced Queries for Capacity Planning

### CPU Over-commitment Analysis

```promql
# Ratio of CPU requests to allocatable CPU per node
sum(kube_pod_container_resource_requests{resource="cpu"}) by (node)
/
kube_node_status_allocatable{resource="cpu"}

# Namespace-level CPU request density
topk(10,
  sum(kube_pod_container_resource_requests{resource="cpu"}) by (namespace)
)
```

### Scheduling Headroom

```promql
# Available scheduling headroom per node (allocatable - requested)
kube_node_status_allocatable{resource="cpu"}
-
sum(kube_pod_container_resource_requests{resource="cpu"}) by (node)

# Nodes with less than 500m CPU headroom (potential scheduling pressure)
(kube_node_status_allocatable{resource="cpu"}
 - sum(kube_pod_container_resource_requests{resource="cpu"}) by (node)
) < 0.5
```

### Finding Resource Waste

```promql
# Pods with limits set but no requests (noisy neighbor risk)
kube_pod_container_resource_limits{resource="memory"}
unless on(namespace, pod, container)
kube_pod_container_resource_requests{resource="memory"}

# Pods with identical request and limit (no bursting allowed)
kube_pod_container_resource_requests{resource="cpu"}
== on(namespace, pod, container)
kube_pod_container_resource_limits{resource="cpu"}
```

## Section 10: KSM Self-Monitoring

```promql
# KSM's own health metrics (from /telemetry endpoint)
# Watch list items per resource type
kube_state_metrics_list_total

# Watch events per resource type
kube_state_metrics_watch_total

# API errors (should be near zero)
kube_state_metrics_list_total{result="error"}
rate(kube_state_metrics_watch_total{result="error"}[5m])

# Total time series KSM is generating
kube_state_metrics_total_time_series

# Scrape duration (should be well under your Prometheus scrape_timeout)
kube_state_metrics_collector_success

# Memory usage of the KSM process (for capacity planning)
process_resident_memory_bytes{job="kube-state-metrics"}
```

kube-state-metrics is the indispensable bridge between the Kubernetes API and the Prometheus metrics ecosystem. Investing in its configuration — particularly label cardinality control, custom resource state metrics, and shard mode for large clusters — pays dividends across every downstream use case: dashboards, alerting, capacity planning, and compliance reporting.
