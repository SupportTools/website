---
title: "Kubernetes ResourceQuota and LimitRange: Namespace-Level Resource Governance"
date: 2030-05-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ResourceQuota", "LimitRange", "Resource Management", "Multi-Tenancy", "Namespace"]
categories:
- Kubernetes
- Resource Management
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise resource governance: ResourceQuota configuration, LimitRange defaults, admission control flow, namespace-scoped quotas for CPU/memory/storage, PVC quotas, and multi-tenant resource management."
more_link: "yes"
url: "/kubernetes-resourcequota-limitrange-namespace-resource-governance/"
---

Resource governance in multi-tenant Kubernetes clusters requires more than setting container `requests` and `limits` on individual pods. Without namespace-level controls, a single team's deployment can consume all cluster capacity, starving other tenants. Kubernetes ResourceQuota and LimitRange objects form the policy layer that enforces capacity boundaries at the namespace level, ensuring fair allocation across teams while preventing accidental runaway deployments.

This guide covers complete ResourceQuota and LimitRange configuration for enterprise multi-tenant environments: quota scopes, storage class quotas, default container limits, priority class quotas, and operational patterns for quota management at scale.

<!--more-->

## Admission Control Flow

Understanding how ResourceQuota and LimitRange interact with pod admission is critical before configuring them.

```
Pod Creation Request
        │
        ▼
LimitRange Admission Plugin
   ├── Apply default requests (if not specified)
   ├── Apply default limits (if not specified)
   └── Validate min/max constraints
        │
        ▼
ResourceQuota Admission Plugin
   ├── Calculate resource usage after pod creation
   ├── Compare against all applicable ResourceQuotas
   └── Reject if any quota would be exceeded
        │
        ▼
Scheduler (only reached if admission succeeds)
```

Two key implications:
1. LimitRange defaults are applied BEFORE quota checking — a missing `requests` field defaults to the LimitRange value, which then counts against quota
2. If multiple ResourceQuotas apply to a namespace, ALL must have capacity for the request to be admitted

## LimitRange Configuration

### Container-Level Defaults

LimitRange serves as a safety net for teams that forget to specify resource requests and limits:

```yaml
# limitrange-container-defaults.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: team-backend
spec:
  limits:
    - type: Container
      # Default limits applied when not specified
      default:
        cpu: "500m"
        memory: "512Mi"
      # Default requests applied when not specified
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      # Minimum values — containers cannot request less
      min:
        cpu: "50m"
        memory: "64Mi"
      # Maximum values — containers cannot request more
      max:
        cpu: "4000m"
        memory: "8Gi"
      # max/min ratio: limits cannot exceed requests by more than this factor
      # Prevents over-generous limits relative to requests
      maxLimitRequestRatio:
        cpu: "10"
        memory: "4"
```

### Pod-Level Limits

Pod-level limits aggregate across all containers in a pod:

```yaml
# limitrange-pod.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pod-limits
  namespace: team-backend
spec:
  limits:
    - type: Pod
      max:
        cpu: "8000m"       # No single pod can request more than 8 CPUs
        memory: "16Gi"     # No single pod can use more than 16Gi
      min:
        cpu: "100m"
        memory: "128Mi"
```

### PersistentVolumeClaim Limits

```yaml
# limitrange-pvc.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pvc-limits
  namespace: team-backend
spec:
  limits:
    - type: PersistentVolumeClaim
      max:
        storage: "100Gi"   # No single PVC can be larger than 100Gi
      min:
        storage: "1Gi"     # No PVC smaller than 1Gi
```

### Verifying LimitRange Application

```bash
# Create a pod without explicit resource requests
kubectl run test-pod -n team-backend --image=nginx --restart=Never

# Verify LimitRange defaults were applied
kubectl get pod test-pod -n team-backend -o jsonpath='{.spec.containers[0].resources}'
# {"limits":{"cpu":"500m","memory":"512Mi"},"requests":{"cpu":"100m","memory":"128Mi"}}

# View describe output showing LimitRange constraints
kubectl describe limitrange container-defaults -n team-backend
# Name:       container-defaults
# Namespace:  team-backend
# Type        Resource  Min    Max     Default Request  Default Limit  Max Limit/Request Ratio
# ----        --------  ---    ---     ---------------  -------------  -----------------------
# Container   cpu       50m    4       100m             500m           10
# Container   memory    64Mi   8Gi     128Mi            512Mi          4
```

## ResourceQuota Configuration

### Basic CPU and Memory Quota

```yaml
# resourcequota-basic.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-backend-quota
  namespace: team-backend
spec:
  hard:
    # Compute resources
    requests.cpu: "8"           # Total CPU requests across all pods
    requests.memory: "16Gi"     # Total memory requests across all pods
    limits.cpu: "32"            # Total CPU limits across all pods
    limits.memory: "64Gi"       # Total memory limits across all pods

    # Object count quotas
    pods: "100"                 # Maximum number of pods
    services: "20"              # Maximum number of services
    secrets: "100"              # Maximum number of secrets
    configmaps: "50"            # Maximum number of configmaps
    persistentvolumeclaims: "30" # Maximum number of PVCs

    # ReplicaSet, Deployment, etc.
    count/deployments.apps: "20"
    count/replicasets.apps: "50"
    count/statefulsets.apps: "10"
    count/jobs.batch: "20"
    count/cronjobs.batch: "10"
```

### Storage Class-Scoped Quotas

Different storage classes have different costs. Quota them independently:

```yaml
# resourcequota-storage.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-backend-storage
  namespace: team-backend
spec:
  hard:
    # Limit total storage requests per storage class
    fast-ssd.storageclass.storage.k8s.io/requests.storage: "500Gi"
    standard.storageclass.storage.k8s.io/requests.storage: "2Ti"
    # Limit PVC count per storage class
    fast-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "10"
    standard.storageclass.storage.k8s.io/persistentvolumeclaims: "50"
    # Limit total storage across all storage classes
    requests.storage: "2Ti"
```

### Quota Scopes

Scopes restrict which objects a quota applies to:

```yaml
# resourcequota-scoped.yaml
# Quota applied only to non-terminating pods (running/pending)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: running-pods-quota
  namespace: team-backend
spec:
  hard:
    pods: "80"
    requests.cpu: "8"
    requests.memory: "16Gi"
  scopeSelector:
    matchExpressions:
      - scopeName: NotTerminating
---
# Separate quota for best-effort pods (no requests/limits)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort-quota
  namespace: team-backend
spec:
  hard:
    pods: "10"
  scopes:
    - BestEffort
---
# Quota for high-priority workloads (PriorityClass)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: high-priority-quota
  namespace: team-backend
spec:
  hard:
    pods: "5"
    requests.cpu: "4"
    requests.memory: "8Gi"
  scopeSelector:
    matchExpressions:
      - scopeName: PriorityClass
        operator: In
        values:
          - high-priority
          - critical
```

### Priority Class Integration

Priority classes combined with quotas provide fine-grained control over high-priority workload capacity:

```yaml
# priority-class-team.yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: team-backend-high
value: 100
globalDefault: false
description: "High priority class for team-backend critical workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: team-backend-default
value: 50
globalDefault: false
description: "Default priority for team-backend workloads"
---
# ResourceQuota limiting high-priority usage
apiVersion: v1
kind: ResourceQuota
metadata:
  name: high-priority-compute
  namespace: team-backend
spec:
  hard:
    requests.cpu: "2"
    requests.memory: "4Gi"
    pods: "3"
  scopeSelector:
    matchExpressions:
      - scopeName: PriorityClass
        operator: In
        values: ["team-backend-high"]
```

## Multi-Tenant Resource Management

### Namespace Hierarchy with Hierarchical Namespace Controller

For large teams, sub-namespaces allow hierarchical quota inheritance. The HNC (Hierarchical Namespace Controller) extends standard namespaces:

```yaml
# hnc-subnamespace.yaml
# Create sub-namespaces under team-backend
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-backend-staging
  namespace: team-backend
---
# ResourceQuota applied in parent propagates to children
apiVersion: v1
kind: ResourceQuota
metadata:
  name: parent-quota
  namespace: team-backend
  annotations:
    hnc.x-k8s.io/propagate: "true"  # Propagate to child namespaces
spec:
  hard:
    requests.cpu: "16"
    requests.memory: "32Gi"
```

### Per-Team Namespace Template with Kustomize

```yaml
# base/namespace-template/kustomization.yaml
resources:
  - namespace.yaml
  - limitrange.yaml
  - resourcequota.yaml
  - rbac.yaml
  - networkpolicy.yaml

# overlays/team-backend/kustomization.yaml
namePrefix: ""
namespace: team-backend

resources:
  - ../../base/namespace-template

patches:
  - target:
      kind: ResourceQuota
      name: team-quota
    patch: |
      - op: replace
        path: /spec/hard/requests.cpu
        value: "8"
      - op: replace
        path: /spec/hard/requests.memory
        value: "16Gi"
      - op: replace
        path: /spec/hard/limits.cpu
        value: "32"
      - op: replace
        path: /spec/hard/limits.memory
        value: "64Gi"
```

### Quota Template with Helm

```yaml
# templates/namespace-resources.yaml
{{- range .Values.teams }}
---
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .name }}
  labels:
    team: {{ .name }}
    environment: {{ $.Values.environment }}
---
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: {{ .name }}
spec:
  limits:
    - type: Container
      default:
        cpu: {{ .defaultLimitCPU | default "500m" }}
        memory: {{ .defaultLimitMem | default "512Mi" }}
      defaultRequest:
        cpu: {{ .defaultRequestCPU | default "100m" }}
        memory: {{ .defaultRequestMem | default "128Mi" }}
      max:
        cpu: {{ .maxCPU | default "4" }}
        memory: {{ .maxMem | default "8Gi" }}
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute
  namespace: {{ .name }}
spec:
  hard:
    requests.cpu: {{ .quotaCPURequests }}
    requests.memory: {{ .quotaMemRequests }}
    limits.cpu: {{ .quotaCPULimits }}
    limits.memory: {{ .quotaMemLimits }}
    pods: {{ .maxPods | default "50" }}
    persistentvolumeclaims: {{ .maxPVCs | default "20" }}
    requests.storage: {{ .quotaStorage | default "500Gi" }}
{{- end }}
```

```yaml
# values.yaml
environment: production

teams:
  - name: team-backend
    quotaCPURequests: "8"
    quotaMemRequests: "16Gi"
    quotaCPULimits: "32"
    quotaMemLimits: "64Gi"
    maxPods: "100"
    maxPVCs: "30"
    quotaStorage: "2Ti"

  - name: team-frontend
    quotaCPURequests: "4"
    quotaMemRequests: "8Gi"
    quotaCPULimits: "16"
    quotaMemLimits: "32Gi"
    maxPods: "50"
    maxPVCs: "10"
    quotaStorage: "500Gi"

  - name: team-data
    quotaCPURequests: "16"
    quotaMemRequests: "64Gi"
    quotaCPULimits: "64"
    quotaMemLimits: "256Gi"
    maxPods: "30"
    maxPVCs: "50"
    quotaStorage: "10Ti"
    defaultLimitCPU: "4"
    defaultLimitMem: "8Gi"
    maxCPU: "32"
    maxMem: "128Gi"
```

## Quota Monitoring and Alerting

### Checking Quota Usage

```bash
# View quota usage for all namespaces
kubectl get resourcequota --all-namespaces

# Detailed view with usage percentages
kubectl describe resourcequota team-backend-quota -n team-backend
# Name:                   team-backend-quota
# Namespace:              team-backend
# Resource                Used   Hard
# --------                ----   ----
# count/deployments.apps  8      20
# limits.cpu              18     32
# limits.memory           36Gi   64Gi
# pods                    43     100
# requests.cpu            4200m  8
# requests.memory         8704Mi 16Gi

# Get quota usage as JSON for automation
kubectl get resourcequota team-backend-quota -n team-backend -o json | \
    jq '.status | {used: .used, hard: .hard}'
```

### Prometheus Metrics for Quota Monitoring

```yaml
# prometheus-quota-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubernetes-quota-alerts
  namespace: monitoring
spec:
  groups:
    - name: kubernetes.quota
      interval: 30s
      rules:
        # CPU requests usage > 80%
        - alert: NamespaceCPURequestsHigh
          expr: |
            kube_resourcequota{resource="requests.cpu", type="used"}
            /
            kube_resourcequota{resource="requests.cpu", type="hard"}
            > 0.80
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} CPU requests at {{ printf \"%.0f\" (mul $value 100) }}% of quota"
            runbook: "https://runbooks.internal.example.com/k8s-quota-exhaustion"

        # Memory requests usage > 85%
        - alert: NamespaceMemoryRequestsHigh
          expr: |
            kube_resourcequota{resource="requests.memory", type="used"}
            /
            kube_resourcequota{resource="requests.memory", type="hard"}
            > 0.85
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} memory requests at {{ printf \"%.0f\" (mul $value 100) }}% of quota"

        # Pod count usage > 90%
        - alert: NamespacePodCountHigh
          expr: |
            kube_resourcequota{resource="pods", type="used"}
            /
            kube_resourcequota{resource="pods", type="hard"}
            > 0.90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} pod count at {{ printf \"%.0f\" (mul $value 100) }}% of quota"

        # Storage requests > 80%
        - alert: NamespaceStorageHigh
          expr: |
            kube_resourcequota{resource="requests.storage", type="used"}
            /
            kube_resourcequota{resource="requests.storage", type="hard"}
            > 0.80
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} storage at {{ printf \"%.0f\" (mul $value 100) }}% of quota"

        # Quota exhausted — new pods will fail to schedule
        - alert: NamespaceQuotaExhausted
          expr: |
            kube_resourcequota{resource="pods", type="used"}
            ==
            kube_resourcequota{resource="pods", type="hard"}
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Namespace {{ $labels.namespace }} pod quota EXHAUSTED — new pods cannot be created"
```

### Grafana Dashboard Query Examples

```promql
# CPU requests utilization by namespace
topk(10,
  kube_resourcequota{resource="requests.cpu", type="used"}
  /
  kube_resourcequota{resource="requests.cpu", type="hard"}
)

# Namespaces approaching memory quota (>75%)
kube_resourcequota{resource="requests.memory", type="used"}
/ on(namespace)
kube_resourcequota{resource="requests.memory", type="hard"}
> 0.75

# Storage consumption by namespace and storageclass
kube_resourcequota{resource=~".*storageclass.*requests.storage", type="used"}
```

## Troubleshooting Common Issues

### Admission Failures Due to Quota

```bash
# When a pod fails to be created due to quota:
kubectl describe pod failing-pod -n team-backend
# Events:
#   Warning  FailedCreate  2m   replicaset-controller
#     Error creating: pods "app-6d9f7b4-" is forbidden:
#     exceeded quota: team-backend-quota,
#     requested: limits.memory=1Gi,used: limits.memory=63Gi,limited: limits.memory=64Gi

# Check current quota usage
kubectl describe resourcequota -n team-backend

# Identify which deployments are consuming the most resources
kubectl get pods -n team-backend \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].resources.limits.memory}{"\n"}{end}' \
    | sort -k2 -h | tail -10
```

### LimitRange Validation Failures

```bash
# Pod rejected because it exceeds LimitRange max
kubectl describe pod -n team-backend
# Error: Invalid value: "10": must be less than or equal to memory limit

# Check LimitRange constraints
kubectl describe limitrange -n team-backend

# Common issue: requests exceed limits (maxLimitRequestRatio violation)
# requests.memory=4Gi, limits.memory=8Gi, ratio=2  -- OK if maxLimitRequestRatio=4
# requests.memory=1Gi, limits.memory=8Gi, ratio=8  -- FAILS if maxLimitRequestRatio=4
```

### Missing Requests Blocking Quota

```bash
# If a namespace has ResourceQuota for requests.cpu but no LimitRange default,
# pods without explicit requests.cpu are REJECTED

# This will fail if quota exists for requests.cpu
kubectl run no-requests --image=nginx -n team-backend
# Error: pods "no-requests" is forbidden: failed quota: team-backend-quota:
# must specify limits.cpu,limits.memory,requests.cpu,requests.memory

# Solution: Add a LimitRange with defaultRequest values
# OR: Always specify requests in pod specs
```

### Quota Status Desync

```bash
# Occasionally quota used count diverges from actual usage
# Force recalculation by restarting kube-controller-manager (not recommended in prod)
# Or wait — reconciliation happens every 5 minutes by default

# Verify actual usage vs quota
NAMESPACE="team-backend"
ACTUAL_PODS=$(kubectl get pods -n $NAMESPACE --field-selector=status.phase=Running --no-headers | wc -l)
QUOTA_USED=$(kubectl get resourcequota -n $NAMESPACE -o jsonpath='{.items[0].status.used.pods}')
echo "Actual running pods: $ACTUAL_PODS"
echo "Quota used pods: $QUOTA_USED"
```

## Automated Quota Review with OPA

For teams using Open Policy Agent, quota configuration can be validated at admission time:

```rego
# policy/quota-compliance.rego
package kubernetes.admission

# Require that all namespaces with team labels have ResourceQuota
deny[msg] {
    input.request.kind.kind == "Namespace"
    input.request.operation == "CREATE"
    input.request.object.metadata.labels.team
    not namespace_has_quota(input.request.object.metadata.name)

    msg := sprintf(
        "Namespace %v for team %v must have a ResourceQuota",
        [input.request.object.metadata.name, input.request.object.metadata.labels.team]
    )
}

namespace_has_quota(ns) {
    data.kubernetes.resourcequotas[ns][_]
}
```

## Summary

ResourceQuota and LimitRange provide complementary layers of resource governance. LimitRange establishes per-object boundaries and default values, ensuring every container has defined resource characteristics without requiring teams to specify them explicitly. ResourceQuota enforces aggregate namespace-level limits that prevent any single team from monopolizing cluster capacity.

Effective multi-tenant governance requires both components working together: LimitRange defaults ensure quota accounting works for all pods (including those without explicit requests), while ResourceQuota ensures capacity allocation remains within agreed-upon boundaries. Prometheus alerting at 80-90% utilization thresholds gives platform teams advance warning before quotas cause service disruptions.
