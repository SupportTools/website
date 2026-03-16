---
title: "kube-state-metrics: Custom Resource Metrics and Advanced Configuration"
date: 2027-03-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "kube-state-metrics", "Prometheus", "Monitoring", "Custom Resources"]
categories: ["Kubernetes", "Observability", "Prometheus"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced guide to kube-state-metrics configuration for custom resource metrics, metric allowlisting, label-to-label mappings, annotation-based metrics, sharding for large clusters, and generating CRD metrics for operators like ArgoCD, Flux, and cert-manager."
more_link: "yes"
url: "/kube-state-metrics-custom-resources-guide/"
---

kube-state-metrics (KSM) fills the observability gap that the Kubernetes metrics API leaves open. While the metrics-server exposes CPU and memory consumption for scheduling decisions, KSM exposes the desired state of every Kubernetes object — whether a Deployment has reached its desired replica count, whether a PersistentVolumeClaim is bound, whether a Node is schedulable. For platform teams running operators and custom controllers, KSM's Custom Resource State feature extends this same capability to any CRD, making operator health observable through the same Prometheus scrape pipeline that monitors core Kubernetes resources.

<!--more-->

## Architecture and Scrape Flow

### How kube-state-metrics Works

KSM runs as a single-binary deployment (or sharded for large clusters) that watches the Kubernetes API server for object events. It maintains an in-memory cache of all objects and generates Prometheus exposition format text from that cache on each scrape request.

```
┌─────────────────────────────────────────────────────────┐
│  Kubernetes API Server                                   │
│  /apis/apps/v1/deployments (watch)                      │
│  /apis/argoproj.io/v1alpha1/applications (watch)        │
└───────────────────┬─────────────────────────────────────┘
                    │ list + watch (informers)
                    ▼
┌─────────────────────────────────────────────────────────┐
│  kube-state-metrics                                      │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Resource Stores (in-memory cache)               │   │
│  │  - DeploymentStore                               │   │
│  │  - NodeStore                                     │   │
│  │  - CustomResourceStore (from KSM CR config)      │   │
│  └──────────────────────────────────────────────────┘   │
│  HTTP /metrics (Prometheus exposition format)            │
└───────────────────┬─────────────────────────────────────┘
                    │ scrape :8080/metrics
                    ▼
┌─────────────────────────────────────────────────────────┐
│  Prometheus / VictoriaMetrics                            │
└─────────────────────────────────────────────────────────┘
```

### RBAC Requirements

KSM requires ClusterRole permissions to watch all resources it is configured to expose. The default Helm chart creates a permissive ClusterRole; for production, scope it to only the resources you actually expose.

```yaml
# ksm-clusterrole.yaml — scoped to needed resources only
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kube-state-metrics
rules:
  # Core Kubernetes resources
  - apiGroups: [""]
    resources:
      - nodes
      - pods
      - services
      - persistentvolumeclaims
      - persistentvolumes
      - namespaces
      - replicationcontrollers
      - resourcequotas
      - configmaps
      - endpoints
      - limitranges
    verbs: ["list", "watch"]
  - apiGroups: ["apps"]
    resources:
      - deployments
      - daemonsets
      - statefulsets
      - replicasets
    verbs: ["list", "watch"]
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["list", "watch"]
  - apiGroups: ["autoscaling"]
    resources:
      - horizontalpodautoscalers
    verbs: ["list", "watch"]
  # Custom resources
  - apiGroups: ["argoproj.io"]
    resources: ["applications", "appprojects"]
    verbs: ["list", "watch"]
  - apiGroups: ["kustomize.toolkit.fluxcd.io"]
    resources: ["kustomizations"]
    verbs: ["list", "watch"]
  - apiGroups: ["cert-manager.io"]
    resources: ["certificates", "certificaterequests", "clusterissuers", "issuers"]
    verbs: ["list", "watch"]
```

## Built-In Resource Metrics Reference

### Pod Metrics

```promql
# Pods not in a running state by namespace
count by (namespace, phase) (
  kube_pod_status_phase{phase!="Running",phase!="Succeeded"}
)

# Pods with OOMKilled containers in the last hour
increase(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[1h]) > 0

# Pods pending for more than 5 minutes
(
  kube_pod_status_phase{phase="Pending"} == 1
) and (
  (time() - kube_pod_created) > 300
)
```

### Deployment Metrics

```promql
# Deployments with fewer ready replicas than desired
kube_deployment_status_replicas_ready
  < kube_deployment_spec_replicas

# Deployment rollout stuck (updated replicas not matching desired for 10+ minutes)
(
  kube_deployment_status_replicas_updated
  < kube_deployment_spec_replicas
) and (
  (time() - kube_deployment_metadata_generation) > 600
)
```

### Node Metrics

```promql
# Nodes with any unready condition
kube_node_status_condition{condition="Ready",status="false"} == 1
or
kube_node_status_condition{condition="Ready",status="unknown"} == 1

# Node memory pressure
kube_node_status_condition{condition="MemoryPressure",status="true"} == 1

# Nodes that are unschedulable (cordoned)
kube_node_spec_unschedulable == 1

# Node allocatable CPU remaining (percentage)
(
  kube_node_status_allocatable{resource="cpu"}
  - on(node) group_left()
  sum by (node) (kube_pod_container_resource_requests{resource="cpu"})
)
/
kube_node_status_allocatable{resource="cpu"} * 100
```

### PersistentVolumeClaim Metrics

```promql
# PVCs that are not bound
kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1

# PVCs in specific namespaces by storage class
count by (namespace, storageclass) (
  kube_persistentvolumeclaim_info
)
```

## Metric Allowlist and Denylist Configuration

By default, KSM emits every metric for every resource it watches, which can create substantial cardinality in large clusters. Use allowlist and denylist flags to control what gets scraped.

### Helm Values for Metric Filtering

```yaml
# ksm-values.yaml
kube-state-metrics:
  # Only emit metrics for specific resources
  resources:
    - nodes
    - pods
    - deployments
    - daemonsets
    - statefulsets
    - replicasets
    - jobs
    - cronjobs
    - persistentvolumeclaims
    - horizontalpodautoscalers
    - namespaces

  # Allowlist: only emit metrics whose names match these regexes
  metricAllowlist:
    - kube_pod_status_phase
    - kube_pod_container_status_.*
    - kube_pod_info
    - kube_deployment_status_.*
    - kube_deployment_spec_replicas
    - kube_node_status_condition
    - kube_node_status_allocatable
    - kube_node_spec_unschedulable
    - kube_persistentvolumeclaim_status_phase
    - kube_persistentvolumeclaim_info
    - kube_horizontalpodautoscaler_status_.*
    - kube_horizontalpodautoscaler_spec_.*
    - kube_job_status_.*
    - kube_cronjob_status_.*

  # Denylist: emit everything EXCEPT metrics matching these
  # (metricAllowlist takes precedence if both are set)
  metricDenylist:
    - kube_pod_container_resource_limits   # high cardinality, use requests only
    - kube_.*_labels                       # label metrics pulled separately
```

### Label-to-Label Mappings

KSM can expose Kubernetes object labels as Prometheus metric labels. By default it exposes none to avoid cardinality explosions. Use `--metric-labels-allowlist` to selectively expose specific labels.

```yaml
# Helm values: expose specific labels as metric labels
kube-state-metrics:
  extraArgs:
    - "--metric-labels-allowlist=pods=[app,version,team],deployments=[app,version],nodes=[node-role.kubernetes.io/worker,topology.kubernetes.io/zone]"
```

This generates metrics like:

```
kube_pod_labels{namespace="production",pod="order-service-7d4f9b",app="order-service",version="3.4.1",team="platform"} 1
```

### Annotation-Based Metric Extraction

KSM can expose annotation values as metric label values, enabling teams to publish metadata without requiring label changes (which can affect scheduling).

```yaml
# Expose specific annotation keys as labels on kube_pod_annotations metric
kube-state-metrics:
  extraArgs:
    - "--metric-annotations-allowlist=pods=[kubectl.kubernetes.io/last-applied-configuration],deployments=[deployment.kubernetes.io/revision]"
```

## Custom Resource State Metrics

The `CustomResourceStateMetrics` feature (stable since KSM 2.9) allows generating arbitrary metrics from any CRD without writing custom exporters.

### Configuration via Helm ConfigMap

```yaml
# ksm-custom-resource-values.yaml
kube-state-metrics:
  customResourceState:
    enabled: true
    config:
      kind: CustomResourceStateMetrics
      spec:
        resources:
          # ArgoCD Application metrics
          - groupVersionKind:
              group: argoproj.io
              version: v1alpha1
              kind: Application
            metricNamePrefix: argocd

            labelsFromPath:
              name: [metadata, name]
              namespace: [metadata, namespace]
              project: [spec, project]
              destination_namespace: [spec, destination, namespace]
              destination_server: [spec, destination, server]

            metrics:
              # Sync status as an info metric (always 1)
              - name: "app_info"
                help: "ArgoCD Application information"
                each:
                  type: Info
                  info:
                    labelsFromPath:
                      sync_status: [status, sync, status]
                      health_status: [status, health, status]
                      operation_phase: [status, operationState, phase]
                      repo: [spec, source, repoURL]
                      target_revision: [spec, source, targetRevision]

              # Sync status as a StateSet (one metric per state, value 1 for current state)
              - name: "app_sync_status"
                help: "ArgoCD Application sync status"
                each:
                  type: StateSet
                  stateSet:
                    labelName: sync_status
                    path: [status, sync, status]
                    list: [Synced, OutOfSync, Unknown]

              # Health status as a StateSet
              - name: "app_health_status"
                help: "ArgoCD Application health status"
                each:
                  type: StateSet
                  stateSet:
                    labelName: health_status
                    path: [status, health, status]
                    list: [Healthy, Progressing, Degraded, Suspended, Missing, Unknown]

              # Last sync time as a Unix timestamp gauge
              - name: "app_last_sync_time"
                help: "ArgoCD Application last sync time as Unix timestamp"
                each:
                  type: Gauge
                  gauge:
                    path: [status, operationState, finishedAt]
                    nilIsZero: true

          # Flux Kustomization metrics
          - groupVersionKind:
              group: kustomize.toolkit.fluxcd.io
              version: v1
              kind: Kustomization
            metricNamePrefix: flux_kustomization

            labelsFromPath:
              name: [metadata, name]
              namespace: [metadata, namespace]
              source_namespace: [spec, sourceRef, namespace]
              source_name: [spec, sourceRef, name]

            metrics:
              - name: "info"
                help: "Flux Kustomization information"
                each:
                  type: Info
                  info:
                    labelsFromPath:
                      ready_status: [status, conditions, "[type=Ready]", status]
                      ready_reason: [status, conditions, "[type=Ready]", reason]
                      path: [spec, path]

              - name: "ready"
                help: "Flux Kustomization ready condition (1=True, 0=False or Unknown)"
                each:
                  type: Gauge
                  gauge:
                    path: [status, conditions, "[type=Ready]", status]
                    booleanValueMapping:
                      "True": 1
                      "False": 0
                      "Unknown": 0
                    nilIsZero: true

              - name: "last_applied_revision"
                help: "Flux Kustomization last applied revision info"
                each:
                  type: Info
                  info:
                    labelsFromPath:
                      revision: [status, lastAppliedRevision]

          # cert-manager Certificate metrics
          - groupVersionKind:
              group: cert-manager.io
              version: v1
              kind: Certificate
            metricNamePrefix: certmanager_certificate

            labelsFromPath:
              name: [metadata, name]
              namespace: [metadata, namespace]
              issuer_name: [spec, issuerRef, name]
              issuer_kind: [spec, issuerRef, kind]
              secret_name: [spec, secretName]

            metrics:
              - name: "info"
                help: "cert-manager Certificate information"
                each:
                  type: Info
                  info:
                    labelsFromPath:
                      dns_names: [spec, dnsNames]
                      ready_status: [status, conditions, "[type=Ready]", status]
                      ready_reason: [status, conditions, "[type=Ready]", reason]

              - name: "ready"
                help: "cert-manager Certificate ready condition"
                each:
                  type: Gauge
                  gauge:
                    path: [status, conditions, "[type=Ready]", status]
                    booleanValueMapping:
                      "True": 1
                      "False": 0
                    nilIsZero: true

              - name: "not_after"
                help: "cert-manager Certificate expiry time as Unix timestamp"
                each:
                  type: Gauge
                  gauge:
                    path: [status, notAfter]
                    nilIsZero: true

              - name: "renewal_time"
                help: "cert-manager Certificate scheduled renewal time as Unix timestamp"
                each:
                  type: Gauge
                  gauge:
                    path: [status, renewalTime]
                    nilIsZero: true
```

### Verifying Custom Resource Metrics

```bash
# Apply the Helm upgrade with custom resource configuration
helm upgrade kube-state-metrics prometheus-community/kube-state-metrics \
  -n monitoring \
  -f ksm-values.yaml \
  -f ksm-custom-resource-values.yaml

# Port-forward and inspect custom resource metrics
kubectl port-forward svc/kube-state-metrics 8080:8080 -n monitoring
curl -s http://localhost:8080/metrics | grep "^argocd_"
curl -s http://localhost:8080/metrics | grep "^flux_kustomization_"
curl -s http://localhost:8080/metrics | grep "^certmanager_certificate_"
```

Expected metric output for ArgoCD:

```
argocd_app_info{name="guestbook",namespace="argocd",project="default",destination_namespace="guestbook",destination_server="https://kubernetes.default.svc",sync_status="Synced",health_status="Healthy",operation_phase="Succeeded",repo="https://github.com/argoproj/argocd-example-apps",target_revision="HEAD"} 1
argocd_app_sync_status{name="guestbook",namespace="argocd",project="default",sync_status="Synced"} 1
argocd_app_sync_status{name="guestbook",namespace="argocd",project="default",sync_status="OutOfSync"} 0
argocd_app_sync_status{name="guestbook",namespace="argocd",project="default",sync_status="Unknown"} 0
argocd_app_health_status{name="guestbook",namespace="argocd",project="default",health_status="Healthy"} 1
argocd_app_health_status{name="guestbook",namespace="argocd",project="default",health_status="Degraded"} 0
argocd_app_last_sync_time{name="guestbook",namespace="argocd",project="default"} 1.7109612e+09
```

## Sharding Configuration for Large Clusters

Clusters with 500+ nodes or tens of thousands of pods strain a single KSM instance with both watch API load and scrape response times. KSM supports horizontal sharding via consistent hashing.

### Sharded Deployment

```yaml
# ksm-sharded-values.yaml
kube-state-metrics:
  # Enable sharding: each shard handles 1/N of objects
  sharding:
    enabled: true
    replicas: 4                    # 4 shards for a ~1000-node cluster

  # Each shard pod gets SHARD and TOTAL_SHARDS env vars automatically
  # KSM hashes object UIDs and routes to the appropriate shard

  # Resources per shard pod
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi

  # Disable liveness/readiness restarts during initial list
  livenessProbe:
    initialDelaySeconds: 60
    periodSeconds: 10
  readinessProbe:
    initialDelaySeconds: 30
    periodSeconds: 10
```

### Prometheus Scrape Config for Shards

```yaml
# prometheus-scrape-ksm-sharded.yaml
scrape_configs:
  - job_name: kube-state-metrics
    # Scrape all shard pod IPs directly instead of the headless service
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [monitoring]
    relabel_configs:
      # Keep only KSM shard pods
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
        regex: kube-state-metrics
        action: keep
      # Use pod IP instead of service IP
      - source_labels: [__meta_kubernetes_pod_ip]
        target_label: __address__
        replacement: "$1:8080"
      # Preserve shard index for debugging
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_instance]
        target_label: ksm_shard
    metric_relabel_configs:
      # Drop high-cardinality label metric if not needed
      - source_labels: [__name__]
        regex: kube_pod_labels
        action: drop
```

## Production Helm Deployment

### Complete Production Values

```yaml
# ksm-production-values.yaml
kube-state-metrics:
  image:
    registry: registry.k8s.io
    repository: kube-state-metrics/kube-state-metrics
    tag: v2.12.0

  replicas: 1                      # increase to 2 if using sharding

  # Resources for a 200-300 node cluster
  resources:
    requests:
      cpu: 300m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi

  # Expose metrics on a named port for ServiceMonitor
  service:
    type: ClusterIP
    port: 8080
    targetPort: 8080

  # ServiceMonitor for Prometheus Operator scraping
  prometheus:
    monitor:
      enabled: true
      interval: 30s
      scrapeTimeout: 15s
      honorLabels: true
      relabelings:
        # Add cluster label to all metrics
        - targetLabel: cluster
          replacement: prod-us-east-1
      metricRelabelings:
        # Drop label metrics (pulled via --metric-labels-allowlist instead)
        - sourceLabels: [__name__]
          regex: kube_(pod|deployment|node|service)_labels
          action: drop

  # Self-monitoring: expose KSM's own metrics
  selfMonitor:
    enabled: true

  # Vertical Pod Autoscaler compatibility
  verticalPodAutoscaler:
    enabled: false

  # Node selector: prefer running on a stable node
  nodeSelector:
    node-role.kubernetes.io/control-plane: ""
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule

  # Security context
  securityContext:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    runAsNonRoot: true
    runAsUser: 65534
    capabilities:
      drop: [ALL]

  # Resource filtering (see above for full allowlist)
  resources:
    - nodes
    - pods
    - deployments
    - daemonsets
    - statefulsets
    - replicasets
    - jobs
    - cronjobs
    - persistentvolumeclaims
    - horizontalpodautoscalers
    - namespaces

  extraArgs:
    - "--metric-labels-allowlist=pods=[app,version,team,component],deployments=[app,version],nodes=[topology.kubernetes.io/zone,node.kubernetes.io/instance-type]"

  customResourceState:
    enabled: true
    # config is loaded from ConfigMap (see above)
```

```bash
# Deploy to monitoring namespace
helm upgrade --install kube-state-metrics prometheus-community/kube-state-metrics \
  --namespace monitoring \
  --create-namespace \
  --version 5.21.0 \
  -f ksm-production-values.yaml \
  -f ksm-custom-resource-values.yaml \
  --wait
```

## Prometheus Recording Rules

Raw KSM metrics are verbose. Recording rules produce pre-aggregated views useful for dashboards and fast alerting.

```yaml
# ksm-recording-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kube-state-metrics-recording-rules
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: ksm.deployments
      interval: 30s
      rules:
        # Ratio of ready replicas to desired replicas per deployment
        - record: deployment:ready_ratio
          expr: |
            kube_deployment_status_replicas_ready
            /
            kube_deployment_spec_replicas

        # Count of unhealthy deployments per namespace
        - record: namespace:unhealthy_deployments:count
          expr: |
            count by (namespace) (
              kube_deployment_status_replicas_ready
              < kube_deployment_spec_replicas
            )

    - name: ksm.pods
      interval: 30s
      rules:
        # OOMKilled container rate over 5 minutes
        - record: namespace:oomkilled_containers:rate5m
          expr: |
            sum by (namespace) (
              rate(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[5m])
            )

        # Pod restart rate over 5 minutes
        - record: namespace:pod_restarts:rate5m
          expr: |
            sum by (namespace, pod) (
              rate(kube_pod_container_status_restarts_total[5m])
            )

    - name: ksm.argocd
      interval: 30s
      rules:
        # Count of degraded ArgoCD applications per project
        - record: argocd:degraded_apps:count
          expr: |
            count by (project) (
              argocd_app_health_status{health_status="Degraded"} == 1
            )

        # Count of out-of-sync ArgoCD applications
        - record: argocd:outofsync_apps:count
          expr: |
            count by (project) (
              argocd_app_sync_status{sync_status="OutOfSync"} == 1
            )

    - name: ksm.certificates
      interval: 60s
      rules:
        # Days until certificate expiry
        - record: certmanager:certificate_days_remaining
          expr: |
            (certmanager_certificate_not_after - time()) / 86400
```

## Alerting on Custom Resource Metrics

```yaml
# ksm-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kube-state-metrics-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: ksm.argocd.alerts
      rules:
        - alert: ArgoCDApplicationDegraded
          expr: argocd_app_health_status{health_status="Degraded"} == 1
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "ArgoCD application {{ $labels.name }} is degraded"
            description: "Application {{ $labels.name }} in project {{ $labels.project }} has been in Degraded health status for more than 5 minutes."
            runbook_url: "https://runbooks.support.tools/argocd/app-degraded"

        - alert: ArgoCDApplicationOutOfSync
          expr: argocd_app_sync_status{sync_status="OutOfSync"} == 1
          for: 30m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "ArgoCD application {{ $labels.name }} is out of sync for 30 minutes"
            description: "Application {{ $labels.name }} has been OutOfSync for over 30 minutes. Check Git repository for pending changes."

    - name: ksm.certificates.alerts
      rules:
        - alert: CertificateExpiringIn30Days
          expr: certmanager:certificate_days_remaining < 30
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Certificate {{ $labels.name }} expires in less than 30 days"
            description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value | humanizeDuration }} days. Renewal should occur automatically; verify cert-manager is healthy."

        - alert: CertificateExpiringIn7Days
          expr: certmanager:certificate_days_remaining < 7
          for: 1h
          labels:
            severity: critical
          annotations:
            summary: "Certificate {{ $labels.name }} expires in less than 7 days"
            description: "URGENT: Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} expires in {{ $value }} days. Automatic renewal may have failed."

        - alert: CertificateNotReady
          expr: certmanager_certificate_ready == 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "cert-manager Certificate {{ $labels.name }} is not ready"
            description: "Certificate {{ $labels.name }} in namespace {{ $labels.namespace }} has not reached Ready status for over 15 minutes."

    - name: ksm.flux.alerts
      rules:
        - alert: FluxKustomizationNotReady
          expr: flux_kustomization_ready == 0
          for: 15m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Flux Kustomization {{ $labels.name }} is not ready"
            description: "Kustomization {{ $labels.name }} in namespace {{ $labels.namespace }} has been failing for over 15 minutes. Check Flux logs for reconciliation errors."
```

## Cardinality Management

High label cardinality is the most common operational issue with KSM in large clusters. The following strategy keeps metric count manageable.

```bash
# Identify high-cardinality KSM metrics
kubectl port-forward svc/kube-state-metrics 8080:8080 -n monitoring
curl -s http://localhost:8080/metrics | \
  awk '/^#/ {next} {print $1}' | \
  sed 's/{.*//' | \
  sort | uniq -c | \
  sort -rn | head -20
```

Typical cardinality offenders and mitigations:

| Metric | Cardinality Driver | Mitigation |
|---|---|---|
| `kube_pod_labels` | One label per label key per pod | Use `--metric-labels-allowlist` to emit only needed labels |
| `kube_pod_container_resource_limits` | Per-container per-resource | Drop via `metricDenylist` if only requests are needed |
| `kube_pod_container_status_waiting_reason` | Pod churn in batch workloads | Drop via metric relabeling after alerting rules are in recording rules |
| `kube_node_status_capacity` | Multiplied by resource count | Keep; low cardinality per node |

## Summary

kube-state-metrics serves as the foundation for Kubernetes state observability. Key configuration practices:

- Scope the metric allowlist to only what dashboards and alerts actually consume, reducing scrape time and Prometheus ingestion load
- Use `--metric-labels-allowlist` with explicit label keys rather than emitting all labels to control cardinality
- Leverage `CustomResourceStateMetrics` to bring operator-managed resources (ArgoCD, Flux, cert-manager) into the same observability pipeline as core Kubernetes objects
- For clusters exceeding 500 nodes, enable sharding with 4+ replicas and scrape pod IPs directly
- Define recording rules to pre-aggregate state ratios before alert evaluation, reducing query complexity and improving dashboard load times
