---
title: "Kubernetes Monitoring Deep Dive: kube-state-metrics, node-exporter, API Server Metrics, and Custom Controllers"
date: 2028-08-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Monitoring", "Prometheus", "kube-state-metrics", "Metrics"]
categories:
- Kubernetes
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes monitoring with Prometheus. Covers kube-state-metrics, node-exporter, API server metrics, etcd monitoring, custom controller metrics, and production alerting strategies."
more_link: "yes"
url: "/kubernetes-monitoring-kube-state-metrics-guide/"
---

Kubernetes exposes an enormous amount of telemetry data. The challenge is not collecting it — every modern cluster ships with Prometheus-compatible endpoints — but knowing which metrics matter, how they relate to each other, and what alerts are worth waking someone up at 3am for. This guide is a production-focused deep dive into the full Kubernetes monitoring stack: `kube-state-metrics`, `node-exporter`, API server internals, etcd health, and exposing metrics from your own controllers.

<!--more-->

# [Kubernetes Monitoring Deep Dive](#kubernetes-monitoring-deep-dive)

## Section 1: The Kubernetes Metrics Ecosystem

Kubernetes metrics come from four distinct sources:

1. **cadvisor** (embedded in kubelet): Container resource usage — CPU, memory, network, disk I/O at the container level.
2. **kube-state-metrics**: Kubernetes object state — pod phase, deployment replicas, node conditions, PVC binding status.
3. **node-exporter**: Host-level metrics — kernel, hardware, filesystem, network interface statistics.
4. **Component metrics**: API server, scheduler, controller-manager, etcd — internal performance of the control plane.

These sources complement each other. cadvisor tells you a pod is using 95% of its CPU limit. kube-state-metrics tells you that pod has been in `Pending` state for 10 minutes. node-exporter tells you the underlying node has no remaining memory. Together they tell the full story.

## Section 2: kube-state-metrics

kube-state-metrics watches the Kubernetes API and converts object state into Prometheus metrics. It does not collect resource usage — that is cadvisor's job. Its metrics answer questions like "how many deployments are in a degraded state?" and "which PVCs have been unbound for more than 5 minutes?"

### Deployment

```yaml
# kube-state-metrics/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    app.kubernetes.io/name: monitoring
```

```yaml
# kube-state-metrics/serviceaccount.yaml
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
  - apiGroups: ["policy"]
    resources:
      - poddisruptionbudgets
    verbs: ["list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources:
      - storageclasses
      - volumeattachments
    verbs: ["list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
      - networkpolicies
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
```

```yaml
# kube-state-metrics/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: monitoring
  labels:
    app.kubernetes.io/name: kube-state-metrics
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kube-state-metrics
    spec:
      serviceAccountName: kube-state-metrics
      automountServiceAccountToken: true
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      containers:
        - name: kube-state-metrics
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0
          args:
            - --port=8080
            - --telemetry-port=8081
            - --metric-labels-allowlist=pods=[app,version,tier],deployments=[app,version]
            - --metric-annotations-allowlist=pods=[kubectl.kubernetes.io/last-applied-configuration]
            - --resources=certificatesigningrequests,configmaps,cronjobs,daemonsets,deployments,endpoints,horizontalpodautoscalers,ingresses,jobs,leases,limitranges,mutatingwebhookconfigurations,namespaces,networkpolicies,nodes,persistentvolumeclaims,persistentvolumes,poddisruptionbudgets,pods,replicasets,replicationcontrollers,resourcequotas,secrets,services,statefulsets,storageclasses,validatingwebhookconfigurations,volumeattachments
          ports:
            - name: http-metrics
              containerPort: 8080
            - name: telemetry
              containerPort: 8081
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
              memory: 512Mi
      nodeSelector:
        kubernetes.io/os: linux
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
```

### Critical kube-state-metrics Alerts

```yaml
# alerts/kube-state-metrics.yaml
groups:
  - name: kubernetes.workload
    interval: 30s
    rules:
      # Deployment not at desired replicas
      - alert: KubeDeploymentReplicasMismatch
        expr: |
          (
            kube_deployment_spec_replicas
              != kube_deployment_status_replicas_available
          ) and (
            changes(kube_deployment_status_replicas_updated[10m]) == 0
          )
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Deployment {{ $labels.namespace }}/{{ $labels.deployment }} replica mismatch"
          description: "Desired {{ $value }} replicas but only {{ $value }} available for 15m."

      # StatefulSet not fully rolled out
      - alert: KubeStatefulSetReplicasMismatch
        expr: |
          kube_statefulset_status_replicas_ready
            != kube_statefulset_status_replicas
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "StatefulSet {{ $labels.namespace }}/{{ $labels.statefulset }} has pods not ready"

      # DaemonSet pods not scheduled
      - alert: KubeDaemonSetNotScheduled
        expr: |
          kube_daemonset_status_desired_number_scheduled
            - kube_daemonset_status_current_number_scheduled > 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "DaemonSet {{ $labels.namespace }}/{{ $labels.daemonset }} has unscheduled pods"

      # Pods not running
      - alert: KubePodNotRunning
        expr: |
          sum by (namespace, pod, phase) (
            kube_pod_status_phase{phase=~"Pending|Unknown|Failed"}
          ) > 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Pod {{ $labels.namespace }}/{{ $labels.pod }} in {{ $labels.phase }} state"

      # Container waiting with bad reason
      - alert: KubeContainerWaiting
        expr: |
          sum by (namespace, pod, container, reason) (
            kube_pod_container_status_waiting_reason{
              reason=~"CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError"
            }
          ) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Container {{ $labels.namespace }}/{{ $labels.pod }}/{{ $labels.container }} waiting: {{ $labels.reason }}"

      # PVC not bound
      - alert: KubePVCNotBound
        expr: |
          kube_persistentvolumeclaim_status_phase{phase!="Bound"} == 1
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "PVC {{ $labels.namespace }}/{{ $labels.persistentvolumeclaim }} not bound ({{ $labels.phase }})"

      # Node not ready
      - alert: KubeNodeNotReady
        expr: |
          kube_node_status_condition{condition="Ready", status="true"} == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.node }} is not Ready"

      # HPA at max replicas
      - alert: KubeHpaAtMaxReplicas
        expr: |
          kube_horizontalpodautoscaler_status_current_replicas
            == kube_horizontalpodautoscaler_spec_max_replicas
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} is at maximum replicas"

      # PodDisruptionBudget blocking evictions
      - alert: KubePodDisruptionBudgetAtLimit
        expr: |
          kube_poddisruptionbudget_status_expected_pods
            - kube_poddisruptionbudget_status_disruptions_allowed == 0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "PodDisruptionBudget {{ $labels.namespace }}/{{ $labels.poddisruptionbudget }} at disruption limit"
```

### Key kube-state-metrics Queries

```promql
# Deployment rollout progress
kube_deployment_status_replicas_updated /
kube_deployment_spec_replicas * 100

# Pods by phase across all namespaces
sum by (phase) (kube_pod_status_phase)

# Namespace resource quotas — CPU usage percentage
sum by (namespace, resource) (kube_resourcequota{type="used"})
  / sum by (namespace, resource) (kube_resourcequota{type="hard"}) * 100

# Jobs that failed in the last hour
increase(kube_job_status_failed[1h]) > 0

# Container restarts in the last 30 minutes
increase(kube_pod_container_status_restarts_total[30m]) > 3

# Nodes with disk pressure
kube_node_status_condition{condition="DiskPressure", status="true"} == 1

# Pending pods older than 10 minutes
(
  kube_pod_status_phase{phase="Pending"} == 1
) * on(pod, namespace) (
  time() - kube_pod_created > 600
)
```

## Section 3: node-exporter Deep Dive

node-exporter runs as a DaemonSet and exposes host-level metrics from /proc and /sys. Its most valuable metrics for Kubernetes operators go beyond basic CPU/memory.

### DaemonSet Deployment

```yaml
# node-exporter/daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    app.kubernetes.io/name: node-exporter
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: node-exporter
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: node-exporter
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9100"
    spec:
      hostPID: true
      hostIPC: true
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      priorityClassName: system-node-critical
      serviceAccountName: node-exporter
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
      containers:
        - name: node-exporter
          image: quay.io/prometheus/node-exporter:v1.8.2
          args:
            - --path.procfs=/host/proc
            - --path.sysfs=/host/sys
            - --path.rootfs=/host/root
            - --path.udev.data=/host/root/run/udev/data
            - --collector.filesystem.mount-points-exclude=^/(dev|proc|sys|var/lib/docker/.+|var/lib/kubelet/pods/.+)($|/)
            - --collector.netclass.ignored-devices=^(veth.+|[a-f0-9]{15})$
            - --collector.netdev.device-exclude=^(veth.+|[a-f0-9]{15})$
            - --collector.systemd
            - --collector.processes
            - --no-collector.ipvs
          ports:
            - name: metrics
              containerPort: 9100
              hostPort: 9100
          resources:
            requests:
              cpu: 100m
              memory: 180Mi
            limits:
              cpu: 250m
              memory: 180Mi
          volumeMounts:
            - name: proc
              mountPath: /host/proc
              readOnly: true
            - name: sys
              mountPath: /host/sys
              readOnly: true
            - name: root
              mountPath: /host/root
              readOnly: true
              mountPropagation: HostToContainer
          livenessProbe:
            httpGet:
              path: /
              port: 9100
            initialDelaySeconds: 5
      volumes:
        - name: proc
          hostPath:
            path: /proc
        - name: sys
          hostPath:
            path: /sys
        - name: root
          hostPath:
            path: /
```

### Critical node-exporter Alerts

```yaml
groups:
  - name: node.hardware
    rules:
      # Node memory pressure
      - alert: NodeMemoryHighUtilization
        expr: |
          (
            node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes
          ) / node_memory_MemTotal_bytes > 0.90
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} memory at {{ $value | humanizePercentage }}"

      # Disk filling up
      - alert: NodeDiskSpaceLow
        expr: |
          (
            node_filesystem_avail_bytes{fstype!~"tmpfs|fuse.lxcfs|squashfs|vfat"}
            / node_filesystem_size_bytes{fstype!~"tmpfs|fuse.lxcfs|squashfs|vfat"}
          ) < 0.10
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.instance }} disk {{ $labels.mountpoint }} below 10%"

      # Disk I/O saturation
      - alert: NodeDiskIOSaturation
        expr: |
          rate(node_disk_io_time_seconds_total[5m]) > 0.9
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} disk {{ $labels.device }} I/O saturated"

      # Network errors
      - alert: NodeNetworkErrorRate
        expr: |
          rate(node_network_receive_errs_total[5m]) /
          rate(node_network_receive_packets_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} interface {{ $labels.device }} >1% receive errors"

      # File descriptor exhaustion
      - alert: NodeFileDescriptorsHigh
        expr: |
          node_filefd_allocated / node_filefd_maximum > 0.80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} file descriptors at {{ $value | humanizePercentage }}"

      # Conntrack table nearly full
      - alert: NodeConntrackTableAlmostFull
        expr: |
          node_nf_conntrack_entries / node_nf_conntrack_entries_limit > 0.80
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Node {{ $labels.instance }} conntrack table at {{ $value | humanizePercentage }}"

      # Load average high
      - alert: NodeHighLoadAverage
        expr: |
          node_load15 / count without(cpu, mode)(
            node_cpu_seconds_total{mode="idle"}
          ) > 2.0
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} load average >2x CPU count"
```

## Section 4: API Server Metrics

The API server is the control plane's single point of contact. Monitoring its latency and error rates is critical for understanding why your `kubectl` commands are slow and why your controllers are not reconciling.

### Key API Server Metrics

```promql
# API server request rate by verb and resource
sum by (verb, resource) (
  rate(apiserver_request_total[5m])
)

# API server latency P99 by verb
histogram_quantile(0.99,
  sum by (le, verb) (
    rate(apiserver_request_duration_seconds_bucket{
      subresource!~"log|proxy|portforward|exec|rsh",
      verb!~"WATCH|WATCHLIST"
    }[5m])
  )
)

# API server error rate (5xx)
sum by (resource, verb) (
  rate(apiserver_request_total{code=~"5.."}[5m])
) / sum by (resource, verb) (
  rate(apiserver_request_total[5m])
)

# etcd request duration
histogram_quantile(0.99,
  sum by (le, operation) (
    rate(etcd_request_duration_seconds_bucket[5m])
  )
)

# Watch cache fullness
apiserver_watch_cache_capacity / apiserver_watch_cache_events_dispatched_total

# Admission webhook duration
histogram_quantile(0.99,
  sum by (le, name) (
    rate(apiserver_admission_webhook_admission_duration_seconds_bucket[5m])
  )
)

# Request inflight
apiserver_current_inflight_requests

# Request rejection rate from throttling
rate(apiserver_flowcontrol_rejected_requests_total[5m])
```

### API Server Alerts

```yaml
groups:
  - name: apiserver
    rules:
      - alert: KubeAPIServerErrorBudgetBurning
        expr: |
          sum(rate(apiserver_request_total{job="apiserver",verb=~"LIST|GET|POST|PUT|PATCH|DELETE",code=~"5.."}[5m]))
            / sum(rate(apiserver_request_total{job="apiserver",verb=~"LIST|GET|POST|PUT|PATCH|DELETE"}[5m])) > 0.01
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "API server error rate >1% for 2 minutes"

      - alert: KubeAPIServerLatencyHigh
        expr: |
          histogram_quantile(0.99,
            sum by (le, verb, resource) (
              rate(apiserver_request_duration_seconds_bucket{
                verb!~"WATCH|WATCHLIST|CONNECT",
                subresource!="log"
              }[5m])
            )
          ) > 3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "API server P99 latency >3s for {{ $labels.verb }} {{ $labels.resource }}"

      - alert: KubeAPIServerThrottling
        expr: |
          rate(apiserver_flowcontrol_rejected_requests_total[5m]) > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "API server is throttling requests via APF"

      - alert: KubeAdmissionWebhookSlowResponse
        expr: |
          histogram_quantile(0.99,
            sum by (le, name, type) (
              rate(apiserver_admission_webhook_admission_duration_seconds_bucket[5m])
            )
          ) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Admission webhook {{ $labels.name }} P99 >1s"
```

## Section 5: etcd Monitoring

etcd is the most critical component in your cluster. A degraded etcd causes everything else to fail. Monitor it aggressively.

```yaml
groups:
  - name: etcd
    rules:
      # etcd cluster health
      - alert: EtcdMembersDown
        expr: |
          max without (endpoint) (
            sum without (instance, pod) (
              clamp_max(etcd_server_currently_leader, 1)
            ) or count without (To) (
              sum without (instance, pod) (
                clamp_max(etcd_network_peer_sent_failures_total, 0)
              )
            )
          ) < count(etcd_server_currently_leader)
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "etcd cluster member is down"

      # etcd leader changes (indicates instability)
      - alert: EtcdHighNumberOfLeaderChanges
        expr: |
          increase(etcd_server_leader_changes_seen_total[15m]) > 4
        labels:
          severity: warning
        annotations:
          summary: "etcd has had {{ $value }} leader changes in 15 minutes"

      # etcd slow disk
      - alert: EtcdSlowFsync
        expr: |
          histogram_quantile(0.99,
            rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])
          ) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "etcd WAL fsync P99 >10ms — check disk performance"

      # etcd backend database size
      - alert: EtcdDatabaseHighFragmentation
        expr: |
          (etcd_mvcc_db_total_size_in_bytes - etcd_mvcc_db_total_size_in_use_in_bytes)
            / etcd_mvcc_db_total_size_in_bytes > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "etcd database fragmentation >50% — run defrag"

      # etcd approaching quota
      - alert: EtcdDatabaseSizeApproachingQuota
        expr: |
          etcd_mvcc_db_total_size_in_bytes / etcd_server_quota_backend_bytes > 0.85
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "etcd database at {{ $value | humanizePercentage }} of quota"
```

## Section 6: Custom Controller Metrics

When you write a Kubernetes controller with controller-runtime, you get basic metrics automatically. But exposing domain-specific metrics requires explicit instrumentation.

### Controller Metrics with controller-runtime

```go
// internal/metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    ReconcileTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "mycontroller_reconcile_total",
            Help: "Total number of reconciliations by outcome.",
        },
        []string{"controller", "result"},
    )

    ReconcileDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "mycontroller_reconcile_duration_seconds",
            Help:    "Duration of reconciliation loops in seconds.",
            Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
        },
        []string{"controller"},
    )

    ManagedObjects = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "mycontroller_managed_objects",
            Help: "Number of objects being managed by the controller.",
        },
        []string{"controller", "namespace"},
    )

    QueueDepth = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "mycontroller_queue_depth",
            Help: "Current work queue depth.",
        },
        []string{"controller"},
    )

    APICallDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "mycontroller_api_call_duration_seconds",
            Help:    "Duration of external API calls made by the controller.",
            Buckets: prometheus.DefBuckets,
        },
        []string{"controller", "operation", "status"},
    )

    LastSuccessfulReconcile = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "mycontroller_last_successful_reconcile_timestamp_seconds",
            Help: "Unix timestamp of last successful reconcile.",
        },
        []string{"controller", "name", "namespace"},
    )
)

func init() {
    metrics.Registry.MustRegister(
        ReconcileTotal,
        ReconcileDuration,
        ManagedObjects,
        QueueDepth,
        APICallDuration,
        LastSuccessfulReconcile,
    )
}
```

### Instrumented Reconciler

```go
// internal/controller/myresource_controller.go
package controller

import (
    "context"
    "fmt"
    "time"

    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/log"

    myv1 "github.com/myorg/mycontroller/api/v1"
    "github.com/myorg/mycontroller/internal/metrics"
)

const controllerName = "myresource"

type MyResourceReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

func (r *MyResourceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    start := time.Now()

    defer func() {
        metrics.ReconcileDuration.
            WithLabelValues(controllerName).
            Observe(time.Since(start).Seconds())
    }()

    var resource myv1.MyResource
    if err := r.Get(ctx, req.NamespacedName, &resource); err != nil {
        if client.IgnoreNotFound(err) == nil {
            metrics.ReconcileTotal.WithLabelValues(controllerName, "not_found").Inc()
            return ctrl.Result{}, nil
        }
        metrics.ReconcileTotal.WithLabelValues(controllerName, "get_error").Inc()
        return ctrl.Result{}, fmt.Errorf("getting resource: %w", err)
    }

    if !resource.DeletionTimestamp.IsZero() {
        if err := r.handleDeletion(ctx, &resource); err != nil {
            metrics.ReconcileTotal.WithLabelValues(controllerName, "delete_error").Inc()
            return ctrl.Result{}, err
        }
        metrics.ReconcileTotal.WithLabelValues(controllerName, "deleted").Inc()
        return ctrl.Result{}, nil
    }

    if err := r.reconcile(ctx, &resource); err != nil {
        metrics.ReconcileTotal.WithLabelValues(controllerName, "error").Inc()
        logger.Error(err, "reconciliation failed", "resource", req.NamespacedName)
        return ctrl.Result{RequeueAfter: 30 * time.Second}, err
    }

    metrics.ReconcileTotal.WithLabelValues(controllerName, "success").Inc()
    metrics.LastSuccessfulReconcile.
        WithLabelValues(controllerName, req.Name, req.Namespace).
        SetToCurrentTime()

    return ctrl.Result{RequeueAfter: 5 * time.Minute}, nil
}

func (r *MyResourceReconciler) reconcile(ctx context.Context, resource *myv1.MyResource) error {
    // Update managed objects gauge
    var list myv1.MyResourceList
    if err := r.List(ctx, &list, client.InNamespace(resource.Namespace)); err != nil {
        return err
    }
    metrics.ManagedObjects.
        WithLabelValues(controllerName, resource.Namespace).
        Set(float64(len(list.Items)))

    // Instrument external API calls
    apiStart := time.Now()
    err := r.callExternalAPI(ctx, resource)
    status := "success"
    if err != nil {
        status = "error"
    }
    metrics.APICallDuration.
        WithLabelValues(controllerName, "provision", status).
        Observe(time.Since(apiStart).Seconds())

    return err
}

func (r *MyResourceReconciler) callExternalAPI(ctx context.Context, resource *myv1.MyResource) error {
    // Implementation here
    return nil
}

func (r *MyResourceReconciler) handleDeletion(ctx context.Context, resource *myv1.MyResource) error {
    return nil
}

func (r *MyResourceReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&myv1.MyResource{}).
        Complete(r)
}
```

### Controller Alerts

```yaml
groups:
  - name: controller
    rules:
      - alert: ControllerReconcileErrorRateHigh
        expr: |
          rate(mycontroller_reconcile_total{result="error"}[5m])
            / rate(mycontroller_reconcile_total[5m]) > 0.10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Controller {{ $labels.controller }} reconcile error rate >10%"

      - alert: ControllerNoSuccessfulReconcile
        expr: |
          time() - mycontroller_last_successful_reconcile_timestamp_seconds > 300
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Controller has not successfully reconciled {{ $labels.name }} in 5+ minutes"

      - alert: ControllerQueueDepthHigh
        expr: |
          mycontroller_queue_depth > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Controller {{ $labels.controller }} queue depth {{ $value }}"
```

## Section 7: Prometheus Scrape Configuration

```yaml
# prometheus/scrape_configs.yaml
scrape_configs:
  # kube-state-metrics
  - job_name: kube-state-metrics
    static_configs:
      - targets: ['kube-state-metrics.monitoring:8080']
    metric_relabel_configs:
      # Drop high-cardinality metrics
      - source_labels: [__name__]
        regex: kube_pod_container_resource_(requests|limits)
        action: drop

  # node-exporter via service discovery
  - job_name: node-exporter
    kubernetes_sd_configs:
      - role: endpoints
        namespaces:
          names: [monitoring]
    relabel_configs:
      - source_labels: [__meta_kubernetes_endpoints_name]
        regex: node-exporter
        action: keep
      - source_labels: [__meta_kubernetes_endpoint_node_name]
        target_label: node
      - source_labels: [__meta_kubernetes_pod_node_name]
        target_label: instance

  # API server
  - job_name: apiserver
    kubernetes_sd_configs:
      - role: endpoints
        namespaces:
          names: [default]
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - source_labels:
          - __meta_kubernetes_namespace
          - __meta_kubernetes_service_name
          - __meta_kubernetes_endpoint_port_name
        regex: default;kubernetes;https
        action: keep

  # kubelet/cadvisor
  - job_name: kubelet
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
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/$1/proxy/metrics/cadvisor

  # Custom controllers
  - job_name: mycontroller
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names: [myapp-system]
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        regex: "true"
        action: keep
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        target_label: __metrics_port__
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        regex: ([^:]+)(?::\d+)?;(\d+)
        target_label: __address__
        replacement: $1:$2
```

## Section 8: Grafana Dashboard Essentials

### Dashboard Variable Queries

```
# Namespace selector
label_values(kube_pod_info, namespace)

# Node selector
label_values(kube_node_info, node)

# Deployment selector
label_values(kube_deployment_spec_replicas{namespace="$namespace"}, deployment)

# Container selector
label_values(container_cpu_usage_seconds_total{namespace="$namespace",pod=~"$deployment.*"}, container)
```

### Essential Panel Queries

```promql
# Cluster-wide pod status summary
sum by (phase) (kube_pod_status_phase{namespace=~"$namespace"})

# Deployment replica health
kube_deployment_status_replicas_available{namespace="$namespace"}
  / kube_deployment_spec_replicas{namespace="$namespace"} * 100

# CPU usage vs limit
sum by (pod, container) (
  rate(container_cpu_usage_seconds_total{
    namespace="$namespace",
    container!=""
  }[5m])
) /
sum by (pod, container) (
  kube_pod_container_resource_limits{
    namespace="$namespace",
    resource="cpu"
  }
) * 100

# Memory usage vs limit
sum by (pod, container) (
  container_memory_working_set_bytes{
    namespace="$namespace",
    container!=""
  }
) /
sum by (pod, container) (
  kube_pod_container_resource_limits{
    namespace="$namespace",
    resource="memory"
  }
) * 100
```

## Conclusion

Effective Kubernetes monitoring requires layering metrics from multiple sources. kube-state-metrics gives you the state of Kubernetes objects. node-exporter gives you host health. API server metrics tell you about control plane performance. Custom controller metrics give you domain-level visibility.

The most important operational investment is in your alerts. Start with a small set of high-signal alerts: pods not running, PVCs not bound, nodes not ready, API server error rate high, etcd approaching quota. Expand only when you have seen incidents that the initial set missed. Alert fatigue from too many low-quality alerts is worse than having no alerts at all.
