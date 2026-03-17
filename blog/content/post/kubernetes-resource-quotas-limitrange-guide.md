---
title: "Kubernetes Resource Quotas and LimitRange: Multi-Tenant Resource Governance"
date: 2027-08-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Management", "Multi-tenancy"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing ResourceQuota and LimitRange for multi-tenant Kubernetes clusters including namespace-level resource governance, quota scopes, Prometheus monitoring, and admission control for resource compliance."
more_link: "yes"
url: "/kubernetes-resource-quotas-limitrange-guide/"
---

Multi-tenant Kubernetes clusters require robust resource governance to prevent noisy-neighbor problems, enforce cost allocation, and maintain cluster stability. ResourceQuota and LimitRange are the two built-in primitives that constrain resource consumption at the namespace level. When combined with proper monitoring and admission control, they provide a complete governance framework that scales from small team clusters to large enterprise platforms serving hundreds of tenants.

<!--more-->

## ResourceQuota Fundamentals

A ResourceQuota sets aggregate limits on the total resource consumption within a namespace. Once a quota is defined, new objects that would cause the total to exceed the quota are rejected by the API server.

### Compute Resource Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: team-alpha
spec:
  hard:
    # CPU limits and requests
    requests.cpu: "16"
    limits.cpu: "32"
    # Memory limits and requests
    requests.memory: 32Gi
    limits.memory: 64Gi
    # Pods
    pods: "50"
```

### Storage Resource Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-quota
  namespace: team-alpha
spec:
  hard:
    # Total storage requests across all PVCs
    requests.storage: 500Gi
    # PVC count
    persistentvolumeclaims: "20"
    # Per-StorageClass quotas
    standard.storageclass.storage.k8s.io/requests.storage: 200Gi
    fast-nvme.storageclass.storage.k8s.io/requests.storage: 50Gi
    # Ephemeral storage
    requests.ephemeral-storage: 20Gi
    limits.ephemeral-storage: 40Gi
```

### Object Count Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: object-count-quota
  namespace: team-alpha
spec:
  hard:
    count/deployments.apps: "20"
    count/statefulsets.apps: "10"
    count/jobs.batch: "50"
    count/cronjobs.batch: "10"
    count/services: "30"
    count/secrets: "100"
    count/configmaps: "100"
    count/ingresses.networking.k8s.io: "20"
    count/serviceaccounts: "20"
```

### Checking Quota Usage

```bash
# View quota status for a namespace
kubectl describe resourcequota compute-quota -n team-alpha

# Output:
# Name:            compute-quota
# Namespace:       team-alpha
# Resource         Used    Hard
# --------         ----    ----
# limits.cpu       6500m   32
# limits.memory    13Gi    64Gi
# pods             14      50
# requests.cpu     3       16
# requests.memory  6Gi     32Gi
```

## Quota Scopes

Quota scopes allow different quotas to apply to different categories of pods, enabling tiered resource allocation.

### Available Scopes

| Scope | Description |
|-------|-------------|
| `Terminating` | Pods with `activeDeadlineSeconds` set |
| `NotTerminating` | Pods without `activeDeadlineSeconds` |
| `BestEffort` | Pods with no resource requests or limits |
| `NotBestEffort` | Pods with at least one request or limit set |
| `PriorityClass` | Pods matching a specific PriorityClass |

### Scope-Based Quota Example

```yaml
# Quota for long-running workloads (no deadline)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: long-running-quota
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "12"
    requests.memory: 24Gi
    pods: "40"
  scopeSelector:
    matchExpressions:
      - operator: NotIn
        scopeName: Terminating

---
# Separate quota for batch jobs (with deadline)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: batch-quota
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    pods: "20"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: Terminating
```

### Priority Class Scoped Quotas

This pattern reserves high-priority quota for critical workloads:

```yaml
# High-priority workloads get dedicated quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: critical-quota
  namespace: production
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    pods: "10"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - system-cluster-critical
          - high-priority

---
# Default quota for standard workloads
apiVersion: v1
kind: ResourceQuota
metadata:
  name: standard-quota
  namespace: production
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    pods: "100"
  scopeSelector:
    matchExpressions:
      - operator: NotIn
        scopeName: PriorityClass
        values:
          - system-cluster-critical
          - high-priority
```

## LimitRange

LimitRange sets default and maximum resource constraints at the container, pod, and PersistentVolumeClaim level. It operates within a namespace and applies automatically to objects that lack explicit resource specifications.

### Container LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: team-alpha
spec:
  limits:
    - type: Container
      # Default values injected if container has no spec
      default:
        cpu: 250m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      # Hard limits on any single container
      max:
        cpu: "4"
        memory: 8Gi
      # Minimum values that must be specified
      min:
        cpu: 50m
        memory: 64Mi
      # Request-to-limit ratio enforcement
      maxLimitRequestRatio:
        cpu: "4"
        memory: "4"
```

### Pod LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pod-limits
  namespace: team-alpha
spec:
  limits:
    - type: Pod
      max:
        cpu: "8"
        memory: 16Gi
      min:
        cpu: 100m
        memory: 128Mi
```

### PVC LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pvc-limits
  namespace: team-alpha
spec:
  limits:
    - type: PersistentVolumeClaim
      max:
        storage: 100Gi
      min:
        storage: 1Gi
```

### Interaction Between LimitRange and ResourceQuota

When both are present:

1. LimitRange injects defaults into objects that lack explicit values
2. ResourceQuota then evaluates the effective resource values (including injected defaults)
3. If the namespace quota would be exceeded after injection, the admission is rejected

This means a namespace with only a ResourceQuota defined will reject pods that do not specify resource requests, because the quota controller cannot determine their resource usage. Always pair ResourceQuota with a LimitRange that provides defaults.

## Multi-Tenant Namespace Provisioning Pattern

### Namespace Provisioning Script

```bash
#!/usr/bin/env bash
set -euo pipefail

TENANT="${1:?Usage: $0 <tenant-name> <cpu-cores> <memory-gi>}"
CPU_CORES="${2:?Usage: $0 <tenant-name> <cpu-cores> <memory-gi>}"
MEMORY_GI="${3:?Usage: $0 <tenant-name> <cpu-cores> <memory-gi>}"

echo "Provisioning namespace for tenant: ${TENANT}"

# Create namespace
kubectl create namespace "${TENANT}" --dry-run=client -o yaml | kubectl apply -f -

# Apply standard labels
kubectl label namespace "${TENANT}" \
    "tenant=${TENANT}" \
    "managed-by=platform-team" \
    --overwrite

# Apply ResourceQuota
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: ${TENANT}
spec:
  hard:
    requests.cpu: "${CPU_CORES}"
    limits.cpu: "$((CPU_CORES * 2))"
    requests.memory: "${MEMORY_GI}Gi"
    limits.memory: "$((MEMORY_GI * 2))Gi"
    pods: "$((CPU_CORES * 10))"
    persistentvolumeclaims: "20"
    requests.storage: "200Gi"
    count/deployments.apps: "20"
    count/services: "30"
    count/secrets: "100"
    count/configmaps: "100"
EOF

# Apply LimitRange with sensible defaults
kubectl apply -f - <<EOF
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: ${TENANT}
spec:
  limits:
    - type: Container
      default:
        cpu: 250m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      max:
        cpu: "4"
        memory: 8Gi
      min:
        cpu: 50m
        memory: 64Mi
      maxLimitRequestRatio:
        cpu: "4"
        memory: "4"
EOF

# Apply default NetworkPolicy (deny all ingress except intra-namespace)
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: ${TENANT}
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector: {}
EOF

echo "Namespace ${TENANT} provisioned successfully"
```

## Prometheus Monitoring for Quota Usage

### Quota Utilization Queries

```promql
# CPU request utilization as percentage of quota
(
  kube_resourcequota{resource="requests.cpu", type="used"}
  /
  kube_resourcequota{resource="requests.cpu", type="hard"}
) * 100

# Memory limit utilization as percentage of quota
(
  kube_resourcequota{resource="limits.memory", type="used"}
  /
  kube_resourcequota{resource="limits.memory", type="hard"}
) * 100

# Pod count utilization
(
  kube_resourcequota{resource="pods", type="used"}
  /
  kube_resourcequota{resource="pods", type="hard"}
) * 100

# Namespaces approaching quota limit (over 80%)
(
  kube_resourcequota{resource="requests.cpu", type="used"}
  /
  kube_resourcequota{resource="requests.cpu", type="hard"}
) > 0.80
```

### PrometheusRule Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-quota-alerts
  namespace: monitoring
spec:
  groups:
    - name: resource-quota
      rules:
        - alert: NamespaceQuotaCPUHigh
          expr: |
            (
              kube_resourcequota{resource="requests.cpu", type="used"}
              /
              kube_resourcequota{resource="requests.cpu", type="hard"}
            ) > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} CPU quota above 85%"
            description: "CPU request utilization is {{ $value | humanizePercentage }} of quota."

        - alert: NamespaceQuotaMemoryHigh
          expr: |
            (
              kube_resourcequota{resource="requests.memory", type="used"}
              /
              kube_resourcequota{resource="requests.memory", type="hard"}
            ) > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} memory quota above 85%"

        - alert: NamespaceQuotaPodsHigh
          expr: |
            (
              kube_resourcequota{resource="pods", type="used"}
              /
              kube_resourcequota{resource="pods", type="hard"}
            ) > 0.90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} pod quota above 90%"

        - alert: NamespaceStorageQuotaHigh
          expr: |
            (
              kube_resourcequota{resource="requests.storage", type="used"}
              /
              kube_resourcequota{resource="requests.storage", type="hard"}
            ) > 0.80
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} storage quota above 80%"
```

### Grafana Dashboard Queries

```promql
# Table: All namespaces with quota utilization
label_replace(
  (
    kube_resourcequota{resource="requests.cpu", type="used"}
    /
    kube_resourcequota{resource="requests.cpu", type="hard"}
  ) * 100,
  "metric", "cpu_utilization_pct", "", ""
)

# Time series: Top 10 namespaces by CPU utilization
topk(10,
  kube_resourcequota{resource="requests.cpu", type="used"}
  /
  kube_resourcequota{resource="requests.cpu", type="hard"}
)
```

## Quota Enforcement with Kyverno

Kyverno can enforce that every namespace has required quotas defined, preventing teams from creating namespaces without governance policies.

### Require Quota on Namespace Creation

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-namespace-quota
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: require-resourcequota
      match:
        any:
          - resources:
              kinds:
                - Namespace
      validate:
        message: "Namespace must have a compute ResourceQuota. Apply the platform ResourceQuota before creating the namespace."
        deny:
          conditions:
            any:
              - key: "{{ request.object.metadata.labels.\"quota-tier\" || '' }}"
                operator: Equals
                value: ""
```

### Generate Default Quota on Namespace Creation

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-default-quota
spec:
  rules:
    - name: generate-compute-quota
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  quota-tier: standard
      generate:
        apiVersion: v1
        kind: ResourceQuota
        name: compute-quota
        namespace: "{{request.object.metadata.name}}"
        data:
          spec:
            hard:
              requests.cpu: "4"
              limits.cpu: "8"
              requests.memory: 8Gi
              limits.memory: 16Gi
              pods: "40"
              persistentvolumeclaims: "10"
              requests.storage: 100Gi
```

## Handling Quota Exceeded Errors

When a pod or other resource is rejected due to quota, the error message is:

```
Error from server (Forbidden): pods "myapp-xxx" is forbidden:
exceeded quota: compute-quota, requested: requests.cpu=500m,
used: requests.cpu=15500m, limited: requests.cpu=16
```

### Common Resolution Steps

```bash
# 1. Check current quota usage
kubectl describe resourcequota -n team-alpha

# 2. Identify which workloads are consuming the most resources
kubectl top pods -n team-alpha --sort-by=cpu | head -20

# 3. Check for idle or over-provisioned Deployments
kubectl get deployments -n team-alpha -o custom-columns=\
NAME:.metadata.name,REPLICAS:.spec.replicas,CPU_REQUEST:.spec.template.spec.containers[0].resources.requests.cpu

# 4. Request quota increase via the provisioning process
# or reduce requests on existing workloads

# 5. Temporarily increase quota during migration (with approval)
kubectl patch resourcequota compute-quota -n team-alpha \
    --type=merge \
    -p '{"spec":{"hard":{"requests.cpu":"20"}}}'
```

## Summary

ResourceQuota and LimitRange are complementary controls. LimitRange ensures every container has sensible defaults and prevents individual containers from consuming excessive resources. ResourceQuota ensures the aggregate namespace consumption stays within allocated bounds. Together they enable reliable multi-tenancy by eliminating the noisy-neighbor problem. Prometheus monitoring for quota utilization, combined with alerting at 80-85% thresholds, provides sufficient lead time for capacity planning before hard limits are hit. Automating namespace provisioning via scripts or Kyverno generate policies ensures consistent governance is applied to all tenants without manual intervention.
