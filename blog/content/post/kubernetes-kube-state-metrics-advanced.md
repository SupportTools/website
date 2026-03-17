---
title: "Kubernetes Kube-state-metrics: Advanced Metrics and Custom Resources"
date: 2029-01-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "kube-state-metrics", "Prometheus", "Monitoring", "Custom Resources", "Observability"]
categories:
- Kubernetes
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into kube-state-metrics configuration for enterprise environments, covering metric customization, Custom Resource metric generation, label allowlisting, sharding for large clusters, and production Prometheus alerting rules."
more_link: "yes"
url: "/kubernetes-kube-state-metrics-advanced/"
---

Kube-state-metrics (KSM) exposes Kubernetes object state as Prometheus metrics, bridging the gap between Kubernetes API objects and time-series monitoring. While the default KSM deployment covers core workload metrics, enterprise environments require customization: exporting specific labels as metric labels, generating metrics from Custom Resources, sharding KSM across large clusters, and writing precise alerting rules that distinguish between transient and persistent failure states. This guide covers advanced KSM configuration patterns for production environments.

<!--more-->

## KSM Architecture and Metric Types

KSM runs as a deployment that maintains a watch on all Kubernetes object types via the informer framework. It does not scrape any metrics itself — it translates object state into gauge and counter metrics.

### Core Metric Families

KSM exposes metrics for every major Kubernetes resource type:

```
kube_deployment_status_replicas_available
kube_deployment_status_replicas_ready
kube_deployment_spec_replicas
kube_pod_status_phase
kube_pod_container_status_running
kube_pod_container_status_restarts_total
kube_node_status_condition
kube_node_spec_taint
kube_persistentvolumeclaim_status_phase
kube_job_status_succeeded
kube_job_status_failed
kube_cronjob_status_last_schedule_time
kube_horizontalpodautoscaler_status_current_replicas
```

### Metric Resolution Labels

By default, KSM includes `namespace`, `pod`, `container`, `deployment` etc. as labels but does NOT include arbitrary object labels (to prevent cardinality explosion). The label allowlist controls which object labels become metric labels.

## Production Deployment Configuration

```yaml
# kube-state-metrics/values.yaml (Helm chart)
replicaCount: 1  # Use sharding for >500 nodes

image:
  registry: registry.k8s.io
  repository: kube-state-metrics/kube-state-metrics
  tag: v2.13.0

extraArgs:
  # Expose only the resources relevant to your environment
  - --resources=certificatesigningrequests,configmaps,cronjobs,daemonsets,deployments,endpoints,horizontalpodautoscalers,ingresses,jobs,leases,limitranges,mutatingwebhookconfigurations,namespaces,networkpolicies,nodes,persistentvolumeclaims,persistentvolumes,poddisruptionbudgets,pods,replicasets,replicationcontrollers,resourcequotas,secrets,serviceaccounts,services,statefulsets,storageclasses,validatingwebhookconfigurations,volumeattachments

  # Allowlist specific pod labels to expose as metric labels
  - --metric-labels-allowlist=pods=[app.kubernetes.io/name,app.kubernetes.io/version,app.kubernetes.io/component,team],deployments=[app.kubernetes.io/name,environment],nodes=[node.kubernetes.io/instance-type,topology.kubernetes.io/zone,topology.kubernetes.io/region]

  # Allowlist specific annotations
  - --metric-annotations-allowlist=pods=[deploy-hash,release-version],namespaces=[team,cost-center]

  # Disable metrics you don't need (reduces cardinality)
  - --metric-denylist=kube_secret_labels,kube_configmap_info

  # Telemetry (self-metrics)
  - --telemetry-port=8081

# Resource sizing for a 200-node cluster
resources:
  requests:
    cpu: 200m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 2Gi

# Pod disruption budget
podDisruptionBudget:
  enabled: true
  minAvailable: 1

# RBAC (KSM needs read access to all namespaces)
rbac:
  create: true
  useClusterRole: true

serviceMonitor:
  enabled: true
  interval: 30s
  scrapeTimeout: 25s
  additionalLabels:
    prometheus: kube-prometheus
```

## Label Allowlisting in Depth

Label allowlisting is the most important KSM tuning consideration. Every unique combination of label values creates a new time series, so exporting too many labels causes cardinality explosion.

```bash
# Current cardinality from KSM
curl -s http://kube-state-metrics:8080/metrics | \
  grep "^kube_" | \
  awk -F'{' '{print $1}' | \
  sort | uniq -c | sort -rn | head -20

# Total series count
curl -s http://kube-state-metrics:8080/metrics | \
  grep "^kube_" | wc -l
# 84291

# Identify high-cardinality metric families
curl -s http://kube-state-metrics:8080/metrics | \
  grep "^kube_pod_labels{" | wc -l
# 12403  ← each pod × each allowed label combo
```

### Calculating Label Allowlist Impact

```bash
# Estimate cardinality impact of adding a new label
# If you have 500 pods and add a label with 20 unique values:
# Additional series = 500 * (metrics_per_pod) * (new_label_unique_values / existing_cardinality)
# This is why high-cardinality labels (like git SHAs or UUIDs) should NEVER be exposed

# Check unique values for a candidate label
kubectl get pods -A \
  -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io/version}{"\n"}{end}' | \
  sort | uniq | wc -l
# 42 unique versions — acceptable for a version label

kubectl get pods -A \
  -o jsonpath='{range .items[*]}{.metadata.labels.build-sha}{"\n"}{end}' | \
  sort | uniq | wc -l
# 8234 unique values — NEVER expose as a metric label
```

## Custom Resource Metrics with CustomResourceStateMetrics

KSM v2.7+ supports generating metrics from Custom Resources via the `CustomResourceStateMetrics` API. This is critical for observing Cluster API clusters, Argo Rollouts, or any operator-managed resources.

### Example: Monitoring Cluster API Clusters

```yaml
# kube-state-metrics/custom-resource-state.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-state-metrics-customresources
  namespace: monitoring
data:
  custom-resource-state.yaml: |
    spec:
      resources:
        # Cluster API Cluster resource
        - groupVersionKind:
            group: cluster.x-k8s.io
            version: v1beta1
            kind: Cluster
          metricNamePrefix: capi_cluster
          labelsFromPath:
            cluster_name: [metadata, name]
            namespace: [metadata, namespace]
            environment: [metadata, labels, environment]
            region: [metadata, labels, region]
          metrics:
            # Is the cluster ready?
            - name: ready
              help: "Whether the CAPI cluster is ready (1=ready, 0=not ready)"
              each:
                type: StateSet
                stateSet:
                  labelName: ready
                  path: [status, conditions]
                  list: [True, False, Unknown]
                  valueFrom: [status]
                  labelsFromPath:
                    condition: [type]
            # Control plane replica count
            - name: control_plane_replicas
              help: "Number of control plane replicas for this cluster"
              each:
                type: Gauge
                gauge:
                  path: [status, controlPlane, replicas]
                  nilIsZero: true
            # Infrastructure ready
            - name: infrastructure_ready
              help: "Whether the cluster infrastructure is ready"
              each:
                type: Gauge
                gauge:
                  path: [status, infrastructureReady]
                  booleanValueMapping:
                    trueValue: 1
                    falseValue: 0
            # Kubernetes version
            - name: kubernetes_version
              help: "Kubernetes version for this cluster"
              each:
                type: Info
                info:
                  path: [spec, topology, version]
                  labelsFromPath:
                    version: []

        # Argo Rollout resource
        - groupVersionKind:
            group: argoproj.io
            version: v1alpha1
            kind: Rollout
          metricNamePrefix: argo_rollout
          labelsFromPath:
            rollout_name: [metadata, name]
            namespace: [metadata, namespace]
            app: [metadata, labels, "app.kubernetes.io/name"]
          metrics:
            - name: status_phase
              help: "Current phase of the Argo Rollout"
              each:
                type: StateSet
                stateSet:
                  labelName: phase
                  path: [status, phase]
                  list: [Progressing, Degraded, Paused, Healthy, Unknown]
            - name: replicas_available
              help: "Number of available replicas in the Rollout"
              each:
                type: Gauge
                gauge:
                  path: [status, availableReplicas]
                  nilIsZero: true
            - name: replicas_desired
              help: "Desired number of replicas in the Rollout"
              each:
                type: Gauge
                gauge:
                  path: [spec, replicas]
                  nilIsZero: true
            - name: ready_replicas
              help: "Number of ready replicas in the Rollout"
              each:
                type: Gauge
                gauge:
                  path: [status, readyReplicas]
                  nilIsZero: true

        # PodMonitor CRD (monitoring stack health)
        - groupVersionKind:
            group: monitoring.coreos.com
            version: v1
            kind: PodMonitor
          metricNamePrefix: prometheus_podmonitor
          labelsFromPath:
            name: [metadata, name]
            namespace: [metadata, namespace]
          metrics:
            - name: info
              help: "Information about PodMonitor configuration"
              each:
                type: Info
                info:
                  labelsFromPath:
                    job_label: [spec, jobLabel]
```

```yaml
# Update KSM deployment to use the custom resource state config
extraArgs:
  - --custom-resource-state-config-file=/etc/customresourcestate/custom-resource-state.yaml

extraVolumeMounts:
  - name: customresourcestate
    mountPath: /etc/customresourcestate

extraVolumes:
  - name: customresourcestate
    configMap:
      name: kube-state-metrics-customresources
```

## KSM Sharding for Large Clusters

For clusters with 500+ nodes or 5,000+ pods, a single KSM instance cannot keep up with watch events. Use sharding to distribute the load.

```yaml
# kube-state-metrics/sharded-deployment.yaml
# Deploy 4 KSM shards, each handling 25% of objects
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics-shard-0
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
      shard: "0"
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kube-state-metrics
        shard: "0"
    spec:
      containers:
        - name: kube-state-metrics
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0
          args:
            - --shard=0
            - --total-shards=4
            - --port=8080
            - --telemetry-port=8081
            - --resources=pods,deployments,replicasets
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
# Repeat for shards 1, 2, 3 with --shard=1, --shard=2, --shard=3
---
# Service for shard 0
apiVersion: v1
kind: Service
metadata:
  name: kube-state-metrics-shard-0
  namespace: monitoring
  labels:
    shard: "0"
spec:
  selector:
    app.kubernetes.io/name: kube-state-metrics
    shard: "0"
  ports:
    - name: http-metrics
      port: 8080
    - name: telemetry
      port: 8081
---
# ServiceMonitor that scrapes all shards
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kube-state-metrics-sharded
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  endpoints:
    - port: http-metrics
      interval: 30s
      scrapeTimeout: 25s
      honorLabels: true
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_shard]
          targetLabel: ksm_shard
```

## Production Prometheus Alerting Rules

```yaml
# prometheus/rules/kubernetes-state.yaml
groups:
  - name: kubernetes_workload_health
    interval: 60s
    rules:
      # Deployment with unavailable replicas for more than 15 minutes
      - alert: KubernetesDeploymentReplicasMismatch
        expr: |
          (
            kube_deployment_spec_replicas{job="kube-state-metrics"}
            !=
            kube_deployment_status_replicas_available{job="kube-state-metrics"}
          ) and (
            changes(kube_deployment_status_replicas_updated{job="kube-state-metrics"}[15m]) == 0
          )
        for: 15m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} has unavailable replicas"
          description: >
            {{ $labels.namespace }}/{{ $labels.deployment }} has
            {{ $value }} missing replicas for more than 15 minutes.
            This is not part of a rolling update.
          runbook: https://runbooks.corp.example.com/kubernetes/deployment-unavailable

      # StatefulSet not fully ready
      - alert: KubernetesStatefulSetReplicasMismatch
        expr: |
          kube_statefulset_status_replicas_ready{job="kube-state-metrics"}
          !=
          kube_statefulset_status_replicas{job="kube-state-metrics"}
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has unavailable replicas"
          description: >
            {{ $labels.namespace }}/{{ $labels.statefulset }} has
            {{ $value }} unready replicas.

      # DaemonSet not fully deployed
      - alert: KubernetesDaemonSetNotFullyRolledOut
        expr: |
          kube_daemonset_status_number_ready{job="kube-state-metrics"}
          /
          kube_daemonset_status_desired_number_scheduled{job="kube-state-metrics"}
          < 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} not fully deployed"

      # CrashLooping containers
      - alert: KubernetesCrashLoopBackOff
        expr: |
          increase(kube_pod_container_status_restarts_total{job="kube-state-metrics"}[1h]) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }} is crash looping"
          description: >
            Container {{ $labels.container }} has restarted {{ $value }} times in the past hour.

      # OOMKilled containers
      - alert: KubernetesContainerOOMKilled
        expr: |
          kube_pod_container_status_last_terminated_reason{reason="OOMKilled",job="kube-state-metrics"} == 1
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "Container {{ $labels.container }} OOMKilled in {{ $labels.namespace }}/{{ $labels.pod }}"
          description: >
            Container {{ $labels.container }} was OOMKilled.
            Consider increasing memory limits or investigating a memory leak.

      # Pods stuck in non-Running phase
      - alert: KubernetesPodNotRunning
        expr: |
          kube_pod_status_phase{phase=~"Pending|Unknown|Failed",job="kube-state-metrics"} == 1
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} is not running"
          description: >
            Pod {{ $labels.namespace }}/{{ $labels.pod }} has been in {{ $labels.phase }} for 15 minutes.

  - name: kubernetes_node_health
    rules:
      # Node not ready
      - alert: KubernetesNodeNotReady
        expr: |
          kube_node_status_condition{condition="Ready",status="true",job="kube-state-metrics"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} is not Ready"
          description: >
            Kubernetes node {{ $labels.node }} has been NotReady for 5 minutes.
            Check: kubectl describe node {{ $labels.node }}

      # Node memory pressure
      - alert: KubernetesNodeMemoryPressure
        expr: |
          kube_node_status_condition{condition="MemoryPressure",status="true",job="kube-state-metrics"} == 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.node }} has memory pressure"

      # Node disk pressure
      - alert: KubernetesNodeDiskPressure
        expr: |
          kube_node_status_condition{condition="DiskPressure",status="true",job="kube-state-metrics"} == 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.node }} has disk pressure"

  - name: kubernetes_resource_quotas
    rules:
      - alert: KubernetesResourceQuotaNearExhaustion
        expr: |
          (
            kube_resourcequota{type="used",job="kube-state-metrics"}
            /
            kube_resourcequota{type="hard",job="kube-state-metrics"}
          ) > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "ResourceQuota {{ $labels.namespace }}/{{ $labels.resourcequota }} near limit"
          description: >
            {{ $labels.resource }} usage is {{ $value | humanizePercentage }} of the quota limit
            in namespace {{ $labels.namespace }}.

  - name: kubernetes_jobs
    rules:
      - alert: KubernetesJobFailed
        expr: |
          kube_job_status_failed{job="kube-state-metrics"} > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Job {{ $labels.namespace }}/{{ $labels.job_name }} has failed"
          description: >
            Job {{ $labels.namespace }}/{{ $labels.job_name }} has {{ $value }} failed pods.

      - alert: KubernetesCronJobRunningTooLong
        expr: |
          time() - kube_cronjob_status_last_schedule_time{job="kube-state-metrics"}
          > 2 * kube_cronjob_spec_suspend == 0
        for: 60m
        labels:
          severity: warning
        annotations:
          summary: "CronJob {{ $labels.namespace }}/{{ $labels.cronjob }} is running too long"

  - name: kubernetes_pvc_health
    rules:
      - alert: KubernetesPVCPending
        expr: |
          kube_persistentvolumeclaim_status_phase{phase="Pending",job="kube-state-metrics"} == 1
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is Pending"
          description: >
            PersistentVolumeClaim has been Pending for 15 minutes.
            Check storage class provisioner and events.

      - alert: KubernetesPVCStorageFull
        expr: |
          (
            kubelet_volume_stats_available_bytes{job="kubelet"}
            /
            kubelet_volume_stats_capacity_bytes{job="kubelet"}
          ) < 0.10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is almost full"
          description: >
            PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} is {{ $value | humanizePercentage }} full.
```

## Grafana Dashboard Queries

```bash
# Useful PromQL queries for KSM-based Grafana dashboards

# Deployment health overview: percent of deployments fully available
sum(kube_deployment_status_replicas_available) /
sum(kube_deployment_spec_replicas)

# Pods in non-Running state by namespace
sort_desc(
  sum by (namespace, phase) (
    kube_pod_status_phase{phase!="Running",phase!="Succeeded"}
  )
)

# Top containers by restart count in the last hour
topk(10,
  sum by (namespace, pod, container) (
    increase(kube_pod_container_status_restarts_total[1h])
  )
)

# Node resource utilization from KSM (allocatable vs requests)
sum by (node) (
  kube_pod_container_resource_requests{resource="memory"}
) /
sum by (node) (
  kube_node_status_allocatable{resource="memory"}
)

# ResourceQuota usage heat map
sum by (namespace, resource) (
  kube_resourcequota{type="used"} /
  kube_resourcequota{type="hard"}
)

# HPA scaling events (replicas above minimum)
kube_horizontalpodautoscaler_status_current_replicas >
kube_horizontalpodautoscaler_spec_min_replicas
```

## KSM Self-Monitoring

```yaml
# Monitor KSM itself to detect scrape failures or lag
groups:
  - name: kube_state_metrics_health
    rules:
      - alert: KubeStateMetricsListErrors
        expr: |
          (sum(rate(kube_state_metrics_list_total{job="kube-state-metrics",result="error"}[5m])) /
           sum(rate(kube_state_metrics_list_total{job="kube-state-metrics"}[5m]))) > 0.01
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "kube-state-metrics is experiencing list errors"

      - alert: KubeStateMetricsWatchErrors
        expr: |
          (sum(rate(kube_state_metrics_watch_total{job="kube-state-metrics",result="error"}[5m])) /
           sum(rate(kube_state_metrics_watch_total{job="kube-state-metrics"}[5m]))) > 0.01
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "kube-state-metrics is experiencing watch errors"

      - alert: KubeStateMetricsShardMissing
        expr: |
          absent(kube_state_metrics_shard_ordinal{job="kube-state-metrics"})
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "kube-state-metrics shard is missing"
```

## Summary

Kube-state-metrics is a foundational component for Kubernetes observability, but its production effectiveness depends heavily on configuration:

- Limit the `--resources` flag to object types your environment actually uses to reduce API server watch connections and memory usage
- Use `--metric-labels-allowlist` carefully — each allowed label multiplies the metric cardinality by the number of unique label values
- Deploy the `CustomResourceStateMetrics` ConfigMap for any CRDs your teams depend on (CAPI, Argo Rollouts, Velero, etc.)
- Implement KSM sharding at 500+ nodes; a single instance cannot keep up with the rate of pod creation and deletion in large clusters
- Layer alerting rules with `for:` durations that match your tolerance for false positives — 5 minutes for node readiness, 15+ minutes for deployment availability discrepancies
- Monitor KSM itself for list/watch errors, which indicate API server connectivity problems that would cause all your Kubernetes state metrics to go stale

## KSM Metric Denylist Patterns

Some KSM metric families expose secrets or generate excessive cardinality in specific environments. Use the denylist to suppress them:

```bash
# Common metrics to consider for denylist:

# kube_secret_labels: Exposes secret labels as metric labels
# Risk: secret names can leak sensitive naming conventions
# --metric-denylist=kube_secret_labels

# kube_pod_labels and kube_deployment_labels: Can have high cardinality
# if pods/deployments have many unique label values
# Instead: use --metric-labels-allowlist to explicitly control which labels

# kube_*_created: creation timestamp metrics are rarely needed in alerting
# --metric-denylist=kube_pod_created,kube_deployment_created,kube_service_created

# Check current metric families exposed by KSM
curl -s http://kube-state-metrics:8080/metrics | \
  awk '/^# HELP/ {print $3}' | sort | head -50
```

## Exposing Admission Webhook Metrics

`ValidatingWebhookConfiguration` and `MutatingWebhookConfiguration` health is not monitored by default. Add custom resource state metrics:

```yaml
# Additional custom-resource-state.yaml entries for webhook monitoring
- groupVersionKind:
    group: admissionregistration.k8s.io
    version: v1
    kind: ValidatingWebhookConfiguration
  metricNamePrefix: kube_validatingwebhookconfiguration
  labelsFromPath:
    name: [metadata, name]
  metrics:
    - name: webhook_count
      help: "Number of webhooks in this ValidatingWebhookConfiguration"
      each:
        type: Gauge
        gauge:
          path: [webhooks]
          type: array
          nilIsZero: true
    - name: info
      help: "Information about ValidatingWebhookConfiguration"
      each:
        type: Info
        info:
          labelsFromPath:
            webhook_0_name: [webhooks, "0", name]
```

## KSM Memory Profiling

KSM memory usage grows with cluster size. Profile memory consumption to right-size the deployment:

```bash
# Enable pprof on KSM (add to extraArgs)
# --enable-gzip
# The metrics endpoint doubles as the pprof endpoint

# Capture heap profile
kubectl port-forward -n monitoring svc/kube-state-metrics 8080:8080
go tool pprof -http :6060 http://localhost:8080/debug/pprof/heap

# Key memory drivers:
# - Object informer cache: ~1KB per object (pod, node, deployment, etc.)
# - Label allowlist expansion: proportional to number of allowed labels * unique values
# - Custom resource state: proportional to CR count

# Estimate memory requirements
# Objects in cluster × ~2KB average + 256MB base = recommended memory limit
# Example: 10,000 pods + 500 nodes + 2,000 deployments = 12,500 objects
# 12,500 × 2KB = 25MB + 256MB base = ~300MB limit

# Monitor actual KSM memory over time
kubectl top pod -n monitoring -l app.kubernetes.io/name=kube-state-metrics
```

## Advanced PromQL: Cluster Capacity Planning

KSM metrics enable cluster capacity planning queries that go beyond simple alerting:

```bash
# Scheduled resources vs. allocatable resources per node
# Shows the resource request "commitment" on each node

# CPU request ratio per node
sum by (node) (
  kube_pod_container_resource_requests{resource="cpu",job="kube-state-metrics"}
) /
sum by (node) (
  kube_node_status_allocatable{resource="cpu",job="kube-state-metrics"}
)

# Memory limit ratio per node (scheduled limits vs. allocatable)
sum by (node) (
  kube_pod_container_resource_limits{resource="memory",job="kube-state-metrics"}
) /
sum by (node) (
  kube_node_status_allocatable{resource="memory",job="kube-state-metrics"}
)

# Namespace resource consumption ranking
topk(10,
  sum by (namespace) (
    kube_pod_container_resource_requests{resource="cpu",job="kube-state-metrics"}
  )
)

# Pods without resource requests (scheduling risk)
count by (namespace) (
  kube_pod_container_resource_requests{resource="cpu",job="kube-state-metrics"} == 0
)

# Pending pods age distribution (identify stuck pods)
histogram_quantile(0.99,
  sum by (le) (
    rate(kube_pod_status_ready_time{job="kube-state-metrics"}[1h])
  )
)

# Deployments with replicas below minimum (PodDisruptionBudget violations)
kube_deployment_status_replicas_available
< on(namespace, deployment) group_left()
  kube_poddisruptionbudget_status_desired_healthy
```

## KSM with Thanos and Long-Term Storage

When using Thanos for long-term metric storage, KSM metrics require special handling due to their high cardinality:

```yaml
# thanos/store-gateway-config.yaml
# Configure Thanos to downsample high-cardinality KSM metrics
# to prevent explosion of long-term storage costs

# Compact and downsample KSM metrics after 24h
type: FILESYSTEM
config:
  directory: /var/thanos/store
downsample:
  disable: false
retention:
  resolutionRaw: 30d   # Keep raw resolution for 30 days
  resolution5m: 90d    # Downsampled to 5m for 90 days
  resolution1h: 1y     # Downsampled to 1h for 1 year
```

```yaml
# prometheus/relabeling-for-thanos.yaml
# Drop high-cardinality ephemeral metrics before remote-writing to Thanos
# This prevents storage and cardinality issues in long-term storage

remoteWrite:
  - url: https://thanos-receive.corp.example.com/api/v1/receive
    writeRelabelConfigs:
      # Drop pod-level restart count metrics older than 7 days context
      # (Thanos handles retention; just reduce cardinality at write time)
      - sourceLabels: [__name__]
        regex: "kube_pod_container_status_restarts_total"
        action: keep
      # Drop kube_secret metrics entirely from remote write
      - sourceLabels: [__name__]
        regex: "kube_secret_.*"
        action: drop
      # Drop per-pod label metrics; keep deployment-level
      - sourceLabels: [__name__]
        regex: "kube_pod_labels"
        action: drop
```
