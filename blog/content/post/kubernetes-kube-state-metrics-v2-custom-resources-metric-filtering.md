---
title: "Kubernetes Kube-state-metrics v2.x: Resource Metrics, Label Joins, Custom Resources, and Metric Filtering"
date: 2032-01-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Prometheus", "kube-state-metrics", "Monitoring", "Observability", "Metrics"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to kube-state-metrics v2.x covering resource-specific metrics, label join configuration, custom resource metrics via Custom Resource State, metric allow/deny filtering, and production deployment patterns for large-scale Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-kube-state-metrics-v2-custom-resources-metric-filtering/"
---

Kube-state-metrics (KSM) listens to the Kubernetes API server and generates metrics about the state of Kubernetes objects. Unlike metrics-server (which provides CPU/memory usage), KSM exposes declarative state: replica counts, pod phases, condition booleans, label values. Version 2.x adds Custom Resource State, metric allow/deny filtering, and shard support for large clusters. This guide covers everything from basic deployment to advanced custom resource instrumentation.

<!--more-->

# Kube-state-metrics v2.x: Complete Production Guide

## Architecture and Data Flow

KSM runs as a deployment with informer-based cache syncing from the Kubernetes API server. It does not scrape Kubernetes — it watches objects and maintains in-memory state, exposing a `/metrics` endpoint Prometheus scrapes.

```
Kubernetes API Server
        |
        | Watch (informers)
        v
  kube-state-metrics
  (in-memory object cache)
        |
        | HTTP /metrics
        v
    Prometheus
        |
        | PromQL
        v
    Grafana / AlertManager
```

KSM v2.x ships as a single binary with these capabilities:
- Per-resource metric families (Pod, Deployment, StatefulSet, etc.)
- Custom Resource State (CRS) for arbitrary CRDs
- Metric allow/deny lists via `--metric-allowlist` / `--metric-denylist`
- Label allow/deny lists via `--metric-labels-allowlist`
- Sharding for large clusters (horizontal scale by object hash)
- Self-metrics via `--enable-kube-collectors`

## Deployment

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-state-metrics
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kube-state-metrics
rules:
- apiGroups: [""]
  resources:
  - configmaps
  - secrets
  - nodes
  - pods
  - services
  - serviceaccounts
  - resourcequotas
  - replicationcontrollers
  - limitranges
  - persistentvolumeclaims
  - persistentvolumes
  - namespaces
  - endpoints
  verbs: ["list", "watch"]
- apiGroups: ["apps"]
  resources:
  - statefulsets
  - daemonsets
  - deployments
  - replicasets
  verbs: ["list", "watch"]
- apiGroups: ["batch"]
  resources:
  - cronjobs
  - jobs
  verbs: ["list", "watch"]
- apiGroups: ["autoscaling"]
  resources:
  - horizontalpodautoscalers
  verbs: ["list", "watch"]
- apiGroups: ["networking.k8s.io"]
  resources:
  - ingresses
  - networkpolicies
  verbs: ["list", "watch"]
- apiGroups: ["policy"]
  resources:
  - poddisruptionbudgets
  verbs: ["list", "watch"]
- apiGroups: ["storage.k8s.io"]
  resources:
  - storageclasses
  - volumeattachments
  verbs: ["list", "watch"]
- apiGroups: ["certificates.k8s.io"]
  resources:
  - certificatesigningrequests
  verbs: ["list", "watch"]
# CRD access for Custom Resource State
- apiGroups: ["argoproj.io"]
  resources:
  - applications
  - appprojects
  verbs: ["list", "watch"]
- apiGroups: ["cert-manager.io"]
  resources:
  - certificates
  - certificaterequests
  verbs: ["list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kube-state-metrics
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kube-state-metrics
subjects:
- kind: ServiceAccount
  name: kube-state-metrics
  namespace: monitoring
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: monitoring
  labels:
    app.kubernetes.io/name: kube-state-metrics
    app.kubernetes.io/version: v2.12.0
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kube-state-metrics
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
    spec:
      serviceAccountName: kube-state-metrics
      automountServiceAccountToken: true
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: kube-state-metrics
        image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0
        args:
        # Enable specific resource collectors (default: all)
        - --resources=pods,deployments,replicasets,statefulsets,daemonsets,
            services,endpoints,nodes,namespaces,persistentvolumeclaims,
            persistentvolumes,resourcequotas,horizontalpodautoscalers,
            jobs,cronjobs,poddisruptionbudgets,networkpolicies,
            ingresses,storageclasses,certificatesigningrequests
        # Allow specific labels on pods (reduces cardinality)
        - --metric-labels-allowlist=pods=[app,component,tier,version],
            deployments=[app,component],
            nodes=[kubernetes.io/instance-type,topology.kubernetes.io/zone]
        # Custom resource state configuration
        - --custom-resource-state-config-file=/etc/ksm/custom-resource-state.yaml
        # Metric allow/deny
        - --metric-denylist=kube_pod_container_status_last_terminated_reason
        # Self metrics
        - --telemetry-port=8081
        ports:
        - containerPort: 8080
          name: http-metrics
          protocol: TCP
        - containerPort: 8081
          name: telemetry
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          timeoutSeconds: 5
        readinessProbe:
          httpGet:
            path: /
            port: 8081
          initialDelaySeconds: 5
          timeoutSeconds: 5
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 1Gi
        volumeMounts:
        - name: custom-resource-state
          mountPath: /etc/ksm
          readOnly: true
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
      volumes:
      - name: custom-resource-state
        configMap:
          name: ksm-custom-resource-state
---
apiVersion: v1
kind: Service
metadata:
  name: kube-state-metrics
  namespace: monitoring
  labels:
    app.kubernetes.io/name: kube-state-metrics
spec:
  ports:
  - name: http-metrics
    port: 8080
    targetPort: http-metrics
  - name: telemetry
    port: 8081
    targetPort: telemetry
  selector:
    app.kubernetes.io/name: kube-state-metrics
```

## Core Resource Metrics Reference

### Pod Metrics

The most-used KSM metric families for pods:

```promql
# Pod phase distribution
kube_pod_status_phase{phase="Running"}
kube_pod_status_phase{phase="Pending"}
kube_pod_status_phase{phase="Failed"}

# Container readiness
kube_pod_container_status_ready{container="api", pod=~"api-.*"}

# Container restarts (alert if high)
kube_pod_container_status_restarts_total{namespace="production"}

# Container resource requests/limits
kube_pod_container_resource_requests{resource="cpu", unit="core"}
kube_pod_container_resource_limits{resource="memory", unit="byte"}

# Pod scheduling
kube_pod_status_scheduled{condition="true"}
kube_pod_status_scheduled{condition="false"}  # Unschedulable

# Pending pods with reason
kube_pod_status_unschedulable{pod=~".*"}

# Pod owner (who manages it)
kube_pod_owner{owner_kind="ReplicaSet", owner_name=~"api-.*"}

# Node assignment
kube_pod_info{node="worker-01", namespace="production"}
```

### Deployment Metrics

```promql
# Replicas that are available vs desired
kube_deployment_status_replicas_available{deployment="api"}
kube_deployment_spec_replicas{deployment="api"}

# Deployment health: available < desired
kube_deployment_status_replicas_available < kube_deployment_spec_replicas

# Rollout in progress
kube_deployment_status_replicas_updated < kube_deployment_spec_replicas

# Generation vs observed generation (detects stuck rollouts)
kube_deployment_metadata_generation != kube_deployment_status_observed_generation

# Paused deployments
kube_deployment_spec_paused{deployment=~".*"} == 1
```

### Node Metrics

```promql
# Node conditions
kube_node_status_condition{condition="Ready", status="true"}
kube_node_status_condition{condition="MemoryPressure", status="true"}
kube_node_status_condition{condition="DiskPressure", status="true"}
kube_node_status_condition{condition="PIDPressure", status="true"}

# Node capacity and allocatable
kube_node_status_capacity{resource="cpu", unit="core"}
kube_node_status_allocatable{resource="memory", unit="byte"}

# Node taints
kube_node_spec_taint{effect="NoSchedule", key="node.kubernetes.io/unschedulable"}
```

### PVC Metrics

```promql
# PVC phase
kube_persistentvolumeclaim_status_phase{phase="Bound"}
kube_persistentvolumeclaim_status_phase{phase="Pending"}

# PVC capacity
kube_persistentvolumeclaim_resource_requests_storage_bytes{namespace="production"}

# PV capacity
kube_persistentvolume_capacity_bytes{storageclass="premium-rwo"}

# Volume attachment
kube_persistentvolume_status_phase{phase="Released"}  # Should be reclaimed
```

## Label Joins: Enriching Metrics

Label joins add labels from one metric to another using the `group_left`/`group_right` modifier. This is essential for correlating pod metrics with deployment metadata.

### Adding Deployment Labels to Pod Metrics

```promql
# Add deployment-level app/version labels to pod restart counts
kube_pod_container_status_restarts_total
* on(pod, namespace) group_left(owner_name)
kube_pod_owner{owner_kind="ReplicaSet"}
* on(owner_name, namespace) group_left(label_app, label_version)
label_replace(
  kube_replicaset_owner{owner_kind="Deployment"},
  "owner_name", "$1", "replicaset", "(.*)"
)
```

This is complex. The KSM `--metric-labels-allowlist` flag is the cleaner approach — expose relevant labels on the resource directly.

### Simpler Join: Pod to Node Zone

```promql
# Which zone are my production pods running in?
kube_pod_info{namespace="production"}
* on(node) group_left(label_topology_kubernetes_io_zone)
kube_node_labels

# Memory requests by zone
sum by (label_topology_kubernetes_io_zone) (
  kube_pod_container_resource_requests{resource="memory", namespace="production"}
  * on(pod, namespace) group_left(node) kube_pod_info{namespace="production"}
  * on(node) group_left(label_topology_kubernetes_io_zone) kube_node_labels
)
```

### Adding Labels via Prometheus relabeling

For production, configure KSM to expose specific labels, then use Prometheus relabeling to normalize:

```yaml
# prometheus.yml scrape config
scrape_configs:
- job_name: kube-state-metrics
  static_configs:
  - targets: ['kube-state-metrics.monitoring:8080']
  metric_relabel_configs:
  # Rename kubernetes label to plain label
  - source_labels: [label_app_kubernetes_io_name]
    target_label: app
    action: replace
  - source_labels: [label_app_kubernetes_io_version]
    target_label: version
    action: replace
  # Drop high-cardinality labels from pod metrics
  - regex: 'label_pod_template_hash'
    action: labeldrop
  # Keep only specific namespaces
  - source_labels: [namespace]
    regex: 'production|staging'
    action: keep
```

## Custom Resource State (CRS)

CRS allows KSM to generate metrics from any CRD without writing a custom exporter.

### ArgoCD Application Metrics

```yaml
# ConfigMap: ksm-custom-resource-state
apiVersion: v1
kind: ConfigMap
metadata:
  name: ksm-custom-resource-state
  namespace: monitoring
data:
  custom-resource-state.yaml: |
    spec:
      resources:
      # ArgoCD Application
      - groupVersionKind:
          group: argoproj.io
          version: v1alpha1
          kind: Application
        metricNamePrefix: argocd_app
        labelsFromPath:
          name: [metadata, name]
          namespace: [metadata, namespace]
          project: [spec, project]
          destination_server: [spec, destination, server]
          destination_namespace: [spec, destination, namespace]
        metrics:
        - name: info
          help: ArgoCD Application information
          each:
            type: Info
            info:
              labelsFromPath:
                sync_status: [status, sync, status]
                health_status: [status, health, status]
                operation_phase: [status, operationState, phase]
                revision: [status, sync, revision]
        - name: health_status
          help: ArgoCD Application health status (1=Healthy, 0=Unhealthy)
          each:
            type: StateSet
            stateSet:
              labelName: status
              labelsFromPath:
                status: [status, health, status]
              list:
              - Healthy
              - Progressing
              - Degraded
              - Suspended
              - Missing
              - Unknown
        - name: sync_status
          help: ArgoCD Application sync status
          each:
            type: StateSet
            stateSet:
              labelName: status
              labelsFromPath:
                status: [status, sync, status]
              list:
              - Synced
              - OutOfSync
              - Unknown
        - name: conditions
          help: ArgoCD Application conditions
          each:
            type: Info
            info:
              path: [status, conditions]
              labelsFromPath:
                condition: [type]
                message: [message]

      # cert-manager Certificate
      - groupVersionKind:
          group: cert-manager.io
          version: v1
          kind: Certificate
        metricNamePrefix: certmanager_cert
        labelsFromPath:
          name: [metadata, name]
          namespace: [metadata, namespace]
          issuer: [spec, issuerRef, name]
          issuer_kind: [spec, issuerRef, kind]
          dns_names: [spec, dnsNames, "0"]
        metrics:
        - name: expiry_seconds
          help: Seconds until certificate expires
          each:
            type: Gauge
            gauge:
              nilIsZero: false
              path: [status, notAfter]
              # Convert RFC3339 timestamp to Unix seconds
        - name: ready_status
          help: Certificate ready condition
          each:
            type: Gauge
            gauge:
              path: [status, conditions, "[type=Ready]", status]
              valueFrom:
                - path: [status, conditions, "[type=Ready]", status]
                  values:
                    "True": 1
                    "False": 0
                    "Unknown": -1
        - name: renewal_time
          help: Scheduled renewal time in Unix seconds
          each:
            type: Gauge
            gauge:
              path: [status, renewalTime]

      # Longhorn Volume
      - groupVersionKind:
          group: longhorn.io
          version: v1beta2
          kind: Volume
        metricNamePrefix: longhorn_volume
        labelsFromPath:
          name: [metadata, name]
          namespace: [metadata, namespace]
          frontend: [spec, frontend]
          access_mode: [spec, accessMode]
        metrics:
        - name: state
          help: Longhorn Volume state
          each:
            type: StateSet
            stateSet:
              labelName: state
              labelsFromPath:
                state: [status, state]
              list:
              - creating
              - attached
              - detaching
              - detached
              - deleting
              - attaching
              - degraded
        - name_sanitize_separator: _
          name: actual_size_bytes
          help: Longhorn Volume actual size in bytes
          each:
            type: Gauge
            gauge:
              path: [status, actualSize]
              nilIsZero: true
        - name: robustness
          help: Longhorn Volume robustness (1=healthy, 0=degraded)
          each:
            type: StateSet
            stateSet:
              labelName: robustness
              labelsFromPath:
                robustness: [status, robustness]
              list:
              - healthy
              - degraded
              - faulted
              - unknown

      # VPA (Vertical Pod Autoscaler)
      - groupVersionKind:
          group: autoscaling.k8s.io
          version: v1
          kind: VerticalPodAutoscaler
        metricNamePrefix: vpa
        labelsFromPath:
          name: [metadata, name]
          namespace: [metadata, namespace]
        metrics:
        - name: container_resource_recommendation
          help: VPA container resource recommendations
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
                resource: [target, "*"]
              # This requires special handling - use nilIsZero
              nilIsZero: true
```

## Metric Filtering and Cardinality Control

### Allow/Deny Lists

```bash
# Deny specific metrics that generate high cardinality
--metric-denylist=^kube_pod_completion_time$,
  ^kube_pod_start_time$,
  ^kube_job_status_start_time$

# Allow only specific metrics (exclusive mode)
--metric-allowlist=^kube_pod_status_phase$,
  ^kube_deployment_status_replicas_available$,
  ^kube_deployment_spec_replicas$,
  ^kube_node_status_condition$,
  ^kube_pod_container_status_restarts_total$,
  ^kube_persistentvolumeclaim_status_phase$

# Label allow list (per resource, comma-separated)
--metric-labels-allowlist=pods=[app,component,tier],
  deployments=[app],
  nodes=[kubernetes.io/instance-type,topology.kubernetes.io/zone,
         kubernetes.io/hostname]
```

### Namespace Allow/Deny

```bash
# Only collect metrics from specific namespaces
--namespaces=production,staging,kube-system

# Exclude specific namespaces
--namespaces-denylist=kube-system,cert-manager,monitoring
```

### Custom Label Matching

```bash
# Only collect pods with specific label selectors
--pod-labels-allowlist=app,component,version

# Annotate pods to opt into detailed metrics
# (requires --use-apiserver-cache-v2 feature)
kubectl annotate pod my-pod ksm.io/detailed=true
```

## Sharding for Large Clusters

For clusters with 1000+ nodes or 10,000+ pods, KSM memory usage can exceed 4GB. Horizontal sharding distributes load:

```yaml
# Shard configuration: 3 shards
# Each shard watches a subset of objects via consistent hashing

# Shard 0 of 3
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics-0
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
      shard: "0"
  template:
    spec:
      containers:
      - name: kube-state-metrics
        image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0
        args:
        - --shard=0
        - --total-shards=3
        - --resources=pods,deployments,replicasets,statefulsets
---
# Shard 1 of 3
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics-1
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
      shard: "1"
  template:
    spec:
      containers:
      - name: kube-state-metrics
        args:
        - --shard=1
        - --total-shards=3
        - --resources=pods,deployments,replicasets,statefulsets
```

Prometheus scrapes all shards:

```yaml
scrape_configs:
- job_name: kube-state-metrics
  kubernetes_sd_configs:
  - role: pod
    namespaces:
      names: [monitoring]
  relabel_configs:
  - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
    action: keep
    regex: kube-state-metrics
  - source_labels: [__meta_kubernetes_pod_container_port_name]
    action: keep
    regex: http-metrics
```

## Production Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kube-state-metrics-alerts
  namespace: monitoring
spec:
  groups:
  - name: kube-state-metrics.rules
    rules:
    # KSM health
    - alert: KubeStateMetricsListErrors
      expr: |
        (sum(rate(kube_state_metrics_list_total{job="kube-state-metrics",result="error"}[5m]))
          /
        sum(rate(kube_state_metrics_list_total{job="kube-state-metrics"}[5m])))
        > 0.01
      for: 15m
      labels:
        severity: critical
      annotations:
        summary: "kube-state-metrics is experiencing errors in list operations"

    # Deployment alerts
    - alert: KubeDeploymentRolloutStuck
      expr: |
        kube_deployment_status_observed_generation{job="kube-state-metrics"}
          !=
        kube_deployment_metadata_generation{job="kube-state-metrics"}
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Deployment rollout is stuck: {{ $labels.namespace }}/{{ $labels.deployment }}"

    - alert: KubeDeploymentReplicasMismatch
      expr: |
        (
          kube_deployment_spec_replicas{job="kube-state-metrics"}
            !=
          kube_deployment_status_replicas_available{job="kube-state-metrics"}
        ) and (
          changes(kube_deployment_status_replicas_updated{job="kube-state-metrics"}[5m])
            ==
          0
        )
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Deployment has unavailable replicas: {{ $labels.namespace }}/{{ $labels.deployment }}"

    # StatefulSet alerts
    - alert: KubeStatefulSetReplicasMismatch
      expr: |
        kube_statefulset_status_replicas_ready{job="kube-state-metrics"}
          !=
        kube_statefulset_status_replicas{job="kube-state-metrics"}
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "StatefulSet has unready replicas: {{ $labels.namespace }}/{{ $labels.statefulset }}"

    # DaemonSet alerts
    - alert: KubeDaemonSetNotScheduled
      expr: |
        kube_daemonset_status_desired_number_scheduled{job="kube-state-metrics"}
          -
        kube_daemonset_status_current_number_scheduled{job="kube-state-metrics"}
        > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "DaemonSet pods not scheduled: {{ $labels.namespace }}/{{ $labels.daemonset }}"

    # Pod crash loops
    - alert: KubePodCrashLooping
      expr: |
        increase(kube_pod_container_status_restarts_total{job="kube-state-metrics"}[15m])
        * on(namespace, pod) group_left(owner_kind)
          kube_pod_owner{owner_kind!="Job"}
        > 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Pod is crash looping: {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }}"

    # PVC pending
    - alert: KubePVCPending
      expr: |
        kube_persistentvolumeclaim_status_phase{phase="Pending", job="kube-state-metrics"}
        == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "PVC stuck in Pending: {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }}"

    # Resource quota near limit
    - alert: KubeQuotaAlmostFull
      expr: |
        kube_resourcequota{type="used", job="kube-state-metrics"}
          /
        kube_resourcequota{type="hard", job="kube-state-metrics"}
        > 0.9
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Namespace quota almost full: {{ $labels.namespace }}/{{ $labels.resource }}"

    # HPA saturation
    - alert: KubeHpaReplicasMismatch
      expr: |
        (kube_horizontalpodautoscaler_status_desired_replicas{job="kube-state-metrics"}
          !=
        kube_horizontalpodautoscaler_status_current_replicas{job="kube-state-metrics"})
        and
        (kube_horizontalpodautoscaler_status_current_replicas{job="kube-state-metrics"}
          >
        kube_horizontalpodautoscaler_spec_min_replicas{job="kube-state-metrics"})
        and
        (kube_horizontalpodautoscaler_status_current_replicas{job="kube-state-metrics"}
          <
        kube_horizontalpodautoscaler_spec_max_replicas{job="kube-state-metrics"})
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "HPA not at target replicas: {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }}"

    # Node conditions
    - alert: KubeNodeNotReady
      expr: |
        kube_node_status_condition{condition="Ready", status="true", job="kube-state-metrics"}
        == 0
      for: 15m
      labels:
        severity: critical
      annotations:
        summary: "Node is not ready: {{ $labels.node }}"

    - alert: KubeNodeMemoryPressure
      expr: |
        kube_node_status_condition{condition="MemoryPressure", status="true", job="kube-state-metrics"}
        == 1
      for: 0m
      labels:
        severity: warning
      annotations:
        summary: "Node under memory pressure: {{ $labels.node }}"
```

## Useful PromQL Queries

```promql
# Pods not running in production
count by (namespace, pod, phase) (
  kube_pod_status_phase{namespace=~"prod.*"}
) != 1

# Container CPU throttling (requires cAdvisor metrics too)
sum by (namespace, pod, container) (
  rate(container_cpu_cfs_throttled_seconds_total[5m])
) / sum by (namespace, pod, container) (
  rate(container_cpu_cfs_periods_total[5m])
) > 0.25

# Nodes with taint NoSchedule
kube_node_spec_taint{effect="NoSchedule"} == 1

# Deployments not using RollingUpdate
kube_deployment_spec_strategy_rollingupdate_max_surge == 0

# Resource efficiency (requests vs actual usage)
sum by (namespace) (
  kube_pod_container_resource_requests{resource="memory", unit="byte"}
) /
sum by (namespace) (
  container_memory_working_set_bytes{container!=""}
)

# Pods without resource limits (potential noisy neighbors)
count by (namespace, pod, container) (
  kube_pod_container_info{namespace!="kube-system"}
) unless count by (namespace, pod, container) (
  kube_pod_container_resource_limits{resource="memory"}
)

# PDB violations
kube_poddisruptionbudget_status_current_healthy
  <
kube_poddisruptionbudget_status_desired_healthy

# Expired or soon-expiring certificates (from CRS config)
(certmanager_cert_expiry_seconds - time()) < 7 * 24 * 3600
```

## Performance Tuning

```bash
# Memory profiling
kubectl port-forward -n monitoring svc/kube-state-metrics 8081:8081 &
curl http://localhost:8081/debug/pprof/heap > ksm.heap
go tool pprof ksm.heap

# Check metric count
curl -s http://localhost:8080/metrics | wc -l

# Check cardinality
curl -s http://localhost:8080/metrics | \
  grep -v "^#" | \
  awk '{print $1}' | \
  sed 's/{.*//' | \
  sort | uniq -c | sort -rn | head -20

# Disable costly collectors if not needed
--resources=pods,deployments,nodes  # Only what you actually alert on
```

KSM v2.x provides the foundation for Kubernetes cluster health monitoring. The Custom Resource State feature eliminates the need for separate per-CRD exporters, while metric filtering keeps cardinality manageable in large clusters. Use label allow lists aggressively — every unique label value multiplies the number of time series stored by Prometheus.
