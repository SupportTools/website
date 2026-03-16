---
title: "Kubernetes Resource Quotas and LimitRanges: Namespace Governance and Capacity Management"
date: 2027-05-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ResourceQuota", "LimitRange", "Namespace", "Multi-Tenancy", "Capacity Planning"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes ResourceQuota and LimitRange configuration, covering compute and object quotas, quota scopes, admission flow, priority class quotas, Prometheus monitoring, and hierarchical namespace quota management."
more_link: "yes"
url: "/kubernetes-namespace-resource-quota-guide/"
---

Kubernetes clusters shared across multiple teams or environments require governance mechanisms that prevent any single namespace from consuming disproportionate resources. Without quotas and limits, a single misconfigured deployment can starve other workloads of CPU and memory, exhaust API server object counts, or saturate storage provisioners.

ResourceQuota and LimitRange are the two primary Kubernetes primitives for namespace-level governance. ResourceQuota enforces aggregate consumption limits, while LimitRange sets per-pod and per-container defaults and bounds. This guide covers both in depth, from the admission control flow through Prometheus-based monitoring and hierarchical namespace quota management for platform engineering teams.

<!--more-->

## Kubernetes Admission Flow for Resource Enforcement

Before diving into configuration, understanding where quotas and limits are enforced in the request lifecycle prevents confusion when objects fail to create.

### The Admission Control Chain

```
API Request
     │
     ▼
Authentication (who are you?)
     │
     ▼
Authorization (are you allowed to do this?)
     │
     ▼
Mutating Admission Webhooks (modify the object)
     │
     ▼
Schema Validation (is the object valid YAML/JSON?)
     │
     ▼
Validating Admission Webhooks (accept or reject)
     │
     ▼
ResourceQuota Admission Controller (do we have capacity?)
     │
     ▼
LimitRanger Admission Controller (apply defaults, validate bounds)
     │
     ▼
etcd (persist the object)
```

ResourceQuota is evaluated after mutation, which means the admission controller sees the final form of the object including any defaults injected by webhooks. LimitRanger runs immediately after ResourceQuota, applying default requests and limits when containers do not specify them.

### Order Dependency

If ResourceQuota defines a `requests.cpu` quota but a pod is submitted without a `resources.requests.cpu` field, the request will fail with:

```
Error from server (Forbidden): pods "my-pod" is forbidden: failed quota: default: must specify resources.requests.cpu for: my-container
```

LimitRanger can solve this by injecting default resource requests before the quota check. This is why the two controllers are almost always used together.

## ResourceQuota Configuration

### Compute Resource Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: team-alpha
spec:
  hard:
    # CPU quotas
    requests.cpu: "20"          # Total CPU requests across all pods
    limits.cpu: "40"            # Total CPU limits across all pods

    # Memory quotas
    requests.memory: 40Gi       # Total memory requests across all pods
    limits.memory: 80Gi         # Total memory limits across all pods

    # Storage quotas
    requests.storage: 500Gi     # Total PVC storage requests
    persistentvolumeclaims: "20" # Maximum number of PVCs

    # Per-storage-class quotas
    gold.storageclass.storage.k8s.io/requests.storage: 100Gi
    gold.storageclass.storage.k8s.io/persistentvolumeclaims: "5"
    standard.storageclass.storage.k8s.io/requests.storage: 400Gi
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
    # Workload objects
    pods: "50"
    replicationcontrollers: "10"
    deployments.apps: "20"
    replicasets.apps: "40"
    statefulsets.apps: "10"
    daemonsets.apps: "5"
    jobs.batch: "30"
    cronjobs.batch: "20"

    # Service objects
    services: "20"
    services.loadbalancers: "3"
    services.nodeports: "0"  # Prevent NodePort service creation

    # Configuration objects
    configmaps: "50"
    secrets: "100"

    # Networking objects
    ingresses.networking.k8s.io: "20"
```

### Resource Quota Scopes

Scopes restrict which pods are counted toward a quota. This allows creating separate quotas for different categories of workloads within the same namespace.

```yaml
# Quota for non-terminating, non-BestEffort pods
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-not-terminating-burstable
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "16"
    requests.memory: 32Gi
    pods: "30"
  scopes:
    - NotTerminating
    - NotBestEffort
---
# Separate quota for terminating pods (batch jobs)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-terminating
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    pods: "20"
  scopes:
    - Terminating
---
# Quota for BestEffort pods (development/testing)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-besteffort
  namespace: team-alpha
spec:
  hard:
    pods: "10"
  scopes:
    - BestEffort
```

Available scope values:

| Scope | Description |
|-------|-------------|
| `Terminating` | Pods with `activeDeadlineSeconds >= 0` |
| `NotTerminating` | Pods without `activeDeadlineSeconds` |
| `BestEffort` | All containers have no resource requests or limits |
| `NotBestEffort` | At least one container has resource requests or limits |
| `PriorityClass` | Pods referencing a specific PriorityClass (requires scopeSelector) |
| `CrossNamespacePodAffinity` | Pods using cross-namespace pod affinity/anti-affinity |

### ScopeSelector for PriorityClass Quotas

```yaml
# Quota scoped to a specific PriorityClass
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-high-priority
  namespace: team-alpha
spec:
  hard:
    pods: "5"
    requests.cpu: "8"
    requests.memory: 16Gi
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - high-priority
---
# Quota for medium priority
apiVersion: v1
kind: ResourceQuota
metadata:
  name: quota-medium-priority
  namespace: team-alpha
spec:
  hard:
    pods: "20"
    requests.cpu: "12"
    requests.memory: 24Gi
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - medium-priority
          - ""  # empty string matches pods with no PriorityClass
---
# Define the PriorityClasses
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000000
globalDefault: false
description: "High priority workloads. Must fit within quota-high-priority ResourceQuota."
preemptionPolicy: PreemptLowerPriority
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: medium-priority
value: 500000
globalDefault: true
description: "Default priority for most workloads."
preemptionPolicy: PreemptLowerPriority
```

### Extended Resource Quotas

```yaml
# Quota for GPU resources
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: ml-team
spec:
  hard:
    requests.nvidia.com/gpu: "8"  # Total GPU requests
    limits.nvidia.com/gpu: "8"    # Total GPU limits (usually equal to requests for GPUs)
    requests.cpu: "64"
    requests.memory: 512Gi
```

## LimitRange Configuration

### Container-Level Limits

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: team-alpha
spec:
  limits:
    - type: Container
      # Default values injected when container omits them
      default:
        cpu: "500m"
        memory: "256Mi"
      # Default request injected when container omits requests
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      # Maximum values — container cannot exceed these
      max:
        cpu: "4"
        memory: "4Gi"
      # Minimum values — container must request at least this much
      min:
        cpu: "10m"
        memory: "32Mi"
      # Request/limit ratio constraint
      # limit must be <= maxLimitRequestRatio * request
      maxLimitRequestRatio:
        cpu: "10"    # limit can be at most 10x the request
        memory: "4"  # limit can be at most 4x the request
```

### Pod-Level Limits

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: pod-limits
  namespace: team-alpha
spec:
  limits:
    - type: Pod
      # Aggregate limits for all containers in a pod
      max:
        cpu: "8"
        memory: "16Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
```

### PersistentVolumeClaim Limits

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
        storage: "50Gi"
      min:
        storage: "1Gi"
```

### Combined LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: namespace-limits
  namespace: team-alpha
spec:
  limits:
    - type: Container
      default:
        cpu: "500m"
        memory: "256Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      max:
        cpu: "4"
        memory: "4Gi"
      min:
        cpu: "10m"
        memory: "32Mi"
      maxLimitRequestRatio:
        cpu: "10"
        memory: "4"
    - type: Pod
      max:
        cpu: "8"
        memory: "16Gi"
    - type: PersistentVolumeClaim
      max:
        storage: "100Gi"
      min:
        storage: "1Gi"
```

## Compute Quota vs. Object Count Quota Strategy

### When to Use Each Type

Compute quotas (CPU, memory) govern resource consumption and prevent runaway workloads from impacting cluster stability. Object count quotas govern API server load, etcd storage, and operational complexity.

For most teams, the recommended starting point is:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
  namespace: team-alpha
spec:
  hard:
    # Compute: sized based on team's workload profile
    requests.cpu: "20"
    limits.cpu: "40"
    requests.memory: 40Gi
    limits.memory: 80Gi

    # Storage: based on data retention requirements
    requests.storage: 500Gi
    persistentvolumeclaims: "20"

    # Objects: generous limits to prevent accidental over-creation
    pods: "100"
    services: "30"
    configmaps: "100"
    secrets: "200"

    # Prevent LoadBalancer services without explicit approval
    services.loadbalancers: "2"
    services.nodeports: "0"
```

### Sizing Methodology

Cluster capacity planning follows a layered model:

```
Cluster Total Allocatable
    │
    ├── System Reserved (kube-system, monitoring, logging)
    │       ~15% of total
    │
    ├── Overhead Reserve (DaemonSets, node overhead)
    │       ~10% of total
    │
    └── Team Allocations (sum of all namespace quotas)
            Quotas can be overcommitted by 20-30%
            since not all teams use 100% simultaneously
```

Overcommit calculation:

```python
#!/usr/bin/env python3
"""
quota-sizing.py: Calculate namespace quota recommendations
based on team workload profiles.
"""

import subprocess
import json
from dataclasses import dataclass
from typing import List

@dataclass
class WorkloadProfile:
    team: str
    peak_pods: int
    avg_cpu_per_pod_cores: float
    avg_memory_per_pod_gib: float
    burst_multiplier: float = 1.5

def recommend_quota(profiles: List[WorkloadProfile]) -> dict:
    recommendations = {}

    for profile in profiles:
        peak_cpu = profile.peak_pods * profile.avg_cpu_per_pod_cores
        peak_mem = profile.peak_pods * profile.avg_memory_per_pod_gib

        recommendations[profile.team] = {
            "requests.cpu": f"{peak_cpu * profile.burst_multiplier:.0f}",
            "limits.cpu": f"{peak_cpu * profile.burst_multiplier * 2:.0f}",
            "requests.memory": f"{peak_mem * profile.burst_multiplier:.0f}Gi",
            "limits.memory": f"{peak_mem * profile.burst_multiplier * 2:.0f}Gi",
            "pods": str(int(profile.peak_pods * profile.burst_multiplier)),
        }

    return recommendations

profiles = [
    WorkloadProfile("team-alpha", peak_pods=50, avg_cpu_per_pod_cores=0.4, avg_memory_per_pod_gib=0.8),
    WorkloadProfile("team-beta",  peak_pods=30, avg_cpu_per_pod_cores=1.0, avg_memory_per_pod_gib=2.0),
    WorkloadProfile("team-gamma", peak_pods=20, avg_cpu_per_pod_cores=2.0, avg_memory_per_pod_gib=4.0),
]

recommendations = recommend_quota(profiles)
for team, quota in recommendations.items():
    print(f"\nRecommended quota for {team}:")
    for key, value in quota.items():
        print(f"  {key}: {value}")
```

## Quota Monitoring with Prometheus

### Prometheus Metrics for ResourceQuota

The kube-state-metrics exporter provides detailed quota metrics:

```promql
# Current quota utilization percentage for CPU requests
(
  kube_resourcequota{type="used", resource="requests.cpu"}
  /
  kube_resourcequota{type="hard", resource="requests.cpu"}
) * 100

# Namespaces approaching quota limits (>80% utilized)
(
  kube_resourcequota{type="used"} /
  kube_resourcequota{type="hard"}
) > 0.8

# Pod count utilization per namespace
(
  kube_resourcequota{type="used", resource="pods"}
  /
  kube_resourcequota{type="hard", resource="pods"}
) * 100
```

### Prometheus Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: resource-quota-alerts
  namespace: monitoring
spec:
  groups:
    - name: resource-quota
      interval: 30s
      rules:
        - alert: NamespaceQuotaCritical
          expr: |
            (
              kube_resourcequota{type="used"}
              /
              kube_resourcequota{type="hard"}
            ) > 0.90
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Namespace {{ $labels.namespace }} quota {{ $labels.resource }} is above 90%"
            description: "{{ $labels.namespace }}/{{ $labels.resource }} is at {{ $value | humanizePercentage }} of quota."
            runbook_url: "https://runbooks.example.com/quota-exceeded"

        - alert: NamespaceQuotaWarning
          expr: |
            (
              kube_resourcequota{type="used"}
              /
              kube_resourcequota{type="hard"}
            ) > 0.75
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} quota {{ $labels.resource }} is above 75%"

        - alert: NamespaceQuotaMemoryHigh
          expr: |
            (
              kube_resourcequota{type="used", resource="requests.memory"}
              /
              kube_resourcequota{type="hard", resource="requests.memory"}
            ) > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Memory quota in {{ $labels.namespace }} is above 85%"

        - alert: NamespacePodQuotaFull
          expr: |
            kube_resourcequota{type="used", resource="pods"}
            ==
            kube_resourcequota{type="hard", resource="pods"}
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Pod quota exhausted in {{ $labels.namespace }}"
            description: "Namespace {{ $labels.namespace }} has reached its pod quota. New pods cannot be scheduled."

        - alert: NamespaceNoQuotaDefined
          expr: |
            count by (namespace) (kube_namespace_labels) unless
            count by (namespace) (kube_resourcequota)
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} has no ResourceQuota defined"
            description: "All namespaces should have a ResourceQuota to prevent resource exhaustion."
```

### Grafana Dashboard Queries

```promql
# Panel: Quota utilization by namespace (table)
sort_desc(
  (
    kube_resourcequota{type="used", resource="requests.cpu"}
    /
    kube_resourcequota{type="hard", resource="requests.cpu"}
  ) * 100
)

# Panel: Memory quota utilization (heatmap)
(
  sum by (namespace) (kube_resourcequota{type="used", resource="requests.memory"})
  /
  sum by (namespace) (kube_resourcequota{type="hard", resource="requests.memory"})
) * 100

# Panel: Object count quota remaining
kube_resourcequota{type="hard", resource="pods"}
- kube_resourcequota{type="used", resource="pods"}

# Panel: Top namespaces by CPU consumption
topk(10,
  kube_resourcequota{type="used", resource="requests.cpu"}
)
```

### Quota Utilization Script

```bash
#!/bin/bash
# quota-report.sh: Generate a quota utilization report across all namespaces

echo "=== Kubernetes Quota Utilization Report ==="
echo "Generated: $(date)"
echo ""

kubectl get resourcequota --all-namespaces -o json | \
  jq -r '
    .items[] |
    . as $quota |
    .metadata.namespace as $ns |
    .metadata.name as $name |
    .status.hard as $hard |
    .status.used as $used |
    ($hard | keys[]) |
    . as $resource |
    select($hard[.] != null and $used[.] != null) |
    {
      namespace: $ns,
      quota: $name,
      resource: $resource,
      hard: $hard[$resource],
      used: $used[$resource]
    }
  ' | \
  jq -s 'sort_by(.namespace, .resource)' | \
  jq -r '
    ["NAMESPACE", "QUOTA", "RESOURCE", "USED", "HARD"] |
    @tsv,
    (
      .[] |
      [.namespace, .quota, .resource, .used, .hard] |
      @tsv
    )
  ' | \
  column -t
```

## Namespace Capacity Planning

### Namespace Tier Model

A tiered approach to namespace quota management simplifies governance:

```yaml
# Tier definitions stored as annotations on quota objects
# Tier 1: Production
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tier1-quota
  namespace: production-payments
  annotations:
    quota.support.tools/tier: "production"
    quota.support.tools/review-date: "2027-11-01"
    quota.support.tools/owner: "payments-team@example.com"
spec:
  hard:
    requests.cpu: "40"
    limits.cpu: "80"
    requests.memory: 80Gi
    limits.memory: 160Gi
    pods: "200"
    services: "50"
    persistentvolumeclaims: "50"
    requests.storage: 2Ti
---
# Tier 2: Staging
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tier2-quota
  namespace: staging-payments
  annotations:
    quota.support.tools/tier: "staging"
    quota.support.tools/review-date: "2027-11-01"
    quota.support.tools/owner: "payments-team@example.com"
spec:
  hard:
    requests.cpu: "20"
    limits.cpu: "40"
    requests.memory: 40Gi
    limits.memory: 80Gi
    pods: "100"
    services: "30"
    persistentvolumeclaims: "20"
    requests.storage: 500Gi
---
# Tier 3: Development
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tier3-quota
  namespace: dev-payments
  annotations:
    quota.support.tools/tier: "development"
spec:
  hard:
    requests.cpu: "8"
    limits.cpu: "16"
    requests.memory: 16Gi
    limits.memory: 32Gi
    pods: "50"
    services: "20"
    persistentvolumeclaims: "10"
    requests.storage: 100Gi
    services.loadbalancers: "0"
    services.nodeports: "0"
```

### Quota Request Workflow

Teams requesting quota adjustments should follow a structured process:

```yaml
# teams/payments/quota-request.yaml — stored in GitOps repository
apiVersion: v1
kind: ConfigMap
metadata:
  name: quota-request-payments-2027q3
  namespace: platform-requests
  annotations:
    quota.support.tools/status: "approved"
    quota.support.tools/approved-by: "platform-team"
    quota.support.tools/approved-date: "2027-04-01"
    quota.support.tools/justification: "Black Friday traffic increase requires 50% more capacity"
data:
  namespace: "production-payments"
  requested_changes: |
    requests.cpu: 40 -> 60
    limits.cpu: 80 -> 120
    requests.memory: 80Gi -> 120Gi
    limits.memory: 160Gi -> 240Gi
    pods: 200 -> 300
  current_utilization: |
    requests.cpu: 85%
    requests.memory: 78%
    pods: 62%
```

## Hierarchical Namespace Quotas (HNC)

### Overview

Hierarchical Namespace Controller (HNC) extends Kubernetes namespaces with parent-child relationships, enabling quota hierarchies that reflect organizational structures.

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Install the HNC kubectl plugin
curl -L https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/kubectl-hns_linux_amd64 \
  -o /usr/local/bin/kubectl-hns
chmod +x /usr/local/bin/kubectl-hns
```

### Creating Namespace Hierarchies

```bash
# Create parent namespace for the payments organization
kubectl create namespace org-payments

# Create child namespaces
kubectl hns create production-payments --namespace org-payments
kubectl hns create staging-payments --namespace org-payments
kubectl hns create dev-payments --namespace org-payments

# Verify the hierarchy
kubectl hns describe org-payments
```

### HNC SubnamespaceAnchor

```yaml
# Create subnamespaces via HNC CRDs
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: production-payments
  namespace: org-payments
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: staging-payments
  namespace: org-payments
```

### Propagating Policies via HNC

```yaml
# Define HierarchyConfiguration to propagate ResourceQuota
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: org-payments
spec:
  resources:
    - resource: resourcequotas
      mode: Propagate  # Propagate to all children
    - resource: limitranges
      mode: Propagate
    - resource: networkpolicies
      mode: Propagate
    - resource: roles
      mode: Propagate
    - resource: rolebindings
      mode: Propagate
```

### Parent-Level Quota Enforcement

```yaml
# Parent namespace quota — limits aggregate consumption across all children
apiVersion: v1
kind: ResourceQuota
metadata:
  name: org-quota
  namespace: org-payments
spec:
  hard:
    # These limits apply to the org-payments namespace AND all its children
    requests.cpu: "100"
    limits.cpu: "200"
    requests.memory: 200Gi
    limits.memory: 400Gi
    pods: "500"
```

HNC does not natively enforce hierarchical quota aggregation — this requires a custom controller. The following example demonstrates a simple quota aggregator:

```go
package main

import (
    "context"
    "fmt"
    "log"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"
)

// AggregateQuotaUsage sums ResourceQuota usage across a parent namespace
// and all its HNC children, returning whether any limit is exceeded.
func AggregateQuotaUsage(ctx context.Context, client kubernetes.Interface, parentNamespace string) (map[string]*resource.Quantity, error) {
    // Get all namespaces with this parent annotation
    nsList, err := client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{
        LabelSelector: fmt.Sprintf("hnc.x-k8s.io/%s=allowed", parentNamespace),
    })
    if err != nil {
        return nil, fmt.Errorf("listing child namespaces: %w", err)
    }

    namespaces := []string{parentNamespace}
    for _, ns := range nsList.Items {
        namespaces = append(namespaces, ns.Name)
    }

    aggregated := map[string]*resource.Quantity{}

    for _, ns := range namespaces {
        quotas, err := client.CoreV1().ResourceQuotas(ns).List(ctx, metav1.ListOptions{})
        if err != nil {
            log.Printf("Error listing quotas in %s: %v", ns, err)
            continue
        }

        for _, quota := range quotas.Items {
            for resource, used := range quota.Status.Used {
                key := string(resource)
                if existing, ok := aggregated[key]; ok {
                    existing.Add(used)
                } else {
                    q := used.DeepCopy()
                    aggregated[key] = &q
                }
            }
        }
    }

    return aggregated, nil
}
```

## Practical Implementation Patterns

### Bootstrapping New Namespaces

A Helm chart for namespace bootstrapping ensures every new namespace gets proper governance:

```yaml
# helm/namespace-bootstrap/templates/resourcequota.yaml
{{- if .Values.quota.enabled }}
apiVersion: v1
kind: ResourceQuota
metadata:
  name: {{ .Values.namespace }}-compute-quota
  namespace: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/managed-by: namespace-bootstrap
    quota.support.tools/tier: {{ .Values.quota.tier | quote }}
spec:
  hard:
    requests.cpu: {{ .Values.quota.compute.requestsCPU | quote }}
    limits.cpu: {{ .Values.quota.compute.limitsCPU | quote }}
    requests.memory: {{ .Values.quota.compute.requestsMemory }}
    limits.memory: {{ .Values.quota.compute.limitsMemory }}
    pods: {{ .Values.quota.objects.pods | quote }}
    services: {{ .Values.quota.objects.services | quote }}
    configmaps: {{ .Values.quota.objects.configmaps | quote }}
    secrets: {{ .Values.quota.objects.secrets | quote }}
    persistentvolumeclaims: {{ .Values.quota.objects.pvcs | quote }}
    requests.storage: {{ .Values.quota.storage.total }}
    services.loadbalancers: {{ .Values.quota.objects.loadbalancers | quote }}
    services.nodeports: "0"
{{- end }}
```

```yaml
# helm/namespace-bootstrap/templates/limitrange.yaml
{{- if .Values.limits.enabled }}
apiVersion: v1
kind: LimitRange
metadata:
  name: {{ .Values.namespace }}-limits
  namespace: {{ .Values.namespace }}
  labels:
    app.kubernetes.io/managed-by: namespace-bootstrap
spec:
  limits:
    - type: Container
      default:
        cpu: {{ .Values.limits.container.defaultCPU }}
        memory: {{ .Values.limits.container.defaultMemory }}
      defaultRequest:
        cpu: {{ .Values.limits.container.defaultRequestCPU }}
        memory: {{ .Values.limits.container.defaultRequestMemory }}
      max:
        cpu: {{ .Values.limits.container.maxCPU }}
        memory: {{ .Values.limits.container.maxMemory }}
      min:
        cpu: {{ .Values.limits.container.minCPU }}
        memory: {{ .Values.limits.container.minMemory }}
      maxLimitRequestRatio:
        cpu: {{ .Values.limits.container.cpuLimitRatio | quote }}
        memory: {{ .Values.limits.container.memoryLimitRatio | quote }}
    - type: PersistentVolumeClaim
      max:
        storage: {{ .Values.limits.pvc.maxStorage }}
      min:
        storage: {{ .Values.limits.pvc.minStorage }}
{{- end }}
```

```yaml
# helm/namespace-bootstrap/values/production.yaml
namespace: team-payments
quota:
  enabled: true
  tier: production
  compute:
    requestsCPU: "20"
    limitsCPU: "40"
    requestsMemory: 40Gi
    limitsMemory: 80Gi
  objects:
    pods: "100"
    services: "30"
    configmaps: "100"
    secrets: "200"
    pvcs: "20"
    loadbalancers: "2"
  storage:
    total: 500Gi

limits:
  enabled: true
  container:
    defaultCPU: "500m"
    defaultMemory: "256Mi"
    defaultRequestCPU: "100m"
    defaultRequestMemory: "128Mi"
    maxCPU: "4"
    maxMemory: "4Gi"
    minCPU: "10m"
    minMemory: "32Mi"
    cpuLimitRatio: "10"
    memoryLimitRatio: "4"
  pvc:
    maxStorage: 100Gi
    minStorage: 1Gi
```

### Quota Violation Investigation

```bash
#!/bin/bash
# investigate-quota-failure.sh

NAMESPACE="${1:?Namespace required}"
RESOURCE="${2:-}"

echo "=== Quota Status for namespace: ${NAMESPACE} ==="
kubectl describe resourcequota -n "${NAMESPACE}"

echo ""
echo "=== LimitRange Configuration ==="
kubectl describe limitrange -n "${NAMESPACE}"

echo ""
echo "=== Current Resource Consumers ==="
kubectl top pods -n "${NAMESPACE}" 2>/dev/null || \
  echo "metrics-server not available, using requests/limits instead"

kubectl get pods -n "${NAMESPACE}" -o json | \
  jq -r '
    .items[] |
    . as $pod |
    .spec.containers[] |
    {
      pod: $pod.metadata.name,
      container: .name,
      cpu_request: (.resources.requests.cpu // "none"),
      cpu_limit: (.resources.limits.cpu // "none"),
      mem_request: (.resources.requests.memory // "none"),
      mem_limit: (.resources.limits.memory // "none")
    }
  ' | jq -s '.' | \
  jq -r '["POD", "CONTAINER", "CPU_REQ", "CPU_LIM", "MEM_REQ", "MEM_LIM"] | @tsv,
         (.[] | [.pod, .container, .cpu_request, .cpu_limit, .mem_request, .mem_limit] | @tsv)' | \
  column -t

echo ""
echo "=== Recent Quota-Related Events ==="
kubectl get events -n "${NAMESPACE}" \
  --field-selector reason=FailedCreate \
  --sort-by='.lastTimestamp' | \
  grep -i quota | tail -20
```

## Common Quota Anti-Patterns

### Anti-Pattern 1: No LimitRange with Compute Quotas

Without a LimitRange, containers without resource specifications will fail admission when a ResourceQuota with compute limits exists.

```bash
# Check for namespaces with compute quotas but no LimitRange
kubectl get namespaces -o json | \
  jq -r '.items[].metadata.name' | \
  while read -r ns; do
    has_quota=$(kubectl get resourcequota -n "${ns}" -o json 2>/dev/null | \
      jq -r '.items[] | select(.spec.hard["requests.cpu"] != null) | .metadata.name' | wc -l)
    has_limitrange=$(kubectl get limitrange -n "${ns}" --no-headers 2>/dev/null | wc -l)

    if [ "${has_quota}" -gt 0 ] && [ "${has_limitrange}" -eq 0 ]; then
      echo "WARNING: ${ns} has compute quota but no LimitRange"
    fi
  done
```

### Anti-Pattern 2: Setting Limits Without Requests

When `limits.cpu` quota exists without `requests.cpu` quota, containers with no CPU request consume from the limits quota but not the requests quota. This creates invisible resource pressure.

Always pair limit quotas with request quotas.

### Anti-Pattern 3: Over-Restrictive maxLimitRequestRatio

Setting `maxLimitRequestRatio.cpu` too low prevents workloads from handling traffic bursts:

```yaml
# Too restrictive — prevents normal burst behavior
maxLimitRequestRatio:
  cpu: "2"   # limit can only be 2x the request

# More appropriate for most workloads
maxLimitRequestRatio:
  cpu: "10"  # allows CPU bursting up to 10x during load spikes
  memory: "2" # memory overcommit is riskier, keep ratio lower
```

### Anti-Pattern 4: No Quota Review Process

Quotas set once and never reviewed become obsolete. Implement a periodic review:

```yaml
# CronJob to alert on quotas not reviewed in 6 months
apiVersion: batch/v1
kind: CronJob
metadata:
  name: quota-review-checker
  namespace: platform-ops
spec:
  schedule: "0 9 * * 1"  # Every Monday at 9 AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: quota-reviewer
          containers:
            - name: checker
              image: bitnami/kubectl:latest
              command:
                - /bin/sh
                - -c
                - |
                  CUTOFF_DATE=$(date -d "6 months ago" +%Y-%m-%d)
                  kubectl get resourcequota --all-namespaces -o json | \
                    jq -r --arg cutoff "${CUTOFF_DATE}" '
                      .items[] |
                      select(
                        (.metadata.annotations["quota.support.tools/review-date"] // "1970-01-01") < $cutoff
                      ) |
                      "\(.metadata.namespace): last reviewed \(.metadata.annotations["quota.support.tools/review-date"] // "never")"
                    '
          restartPolicy: OnFailure
```

## Summary

ResourceQuota and LimitRange form the foundation of namespace governance in multi-tenant Kubernetes clusters. Key operational takeaways:

- Always deploy LimitRange alongside compute ResourceQuotas to ensure containers without explicit resource specifications pass admission
- Use quota scopes (Terminating, NotBestEffort, PriorityClass) to segment workload types with independent capacity pools
- Monitor quota utilization with kube-state-metrics and alert at 75% and 90% thresholds before exhaustion causes admission failures
- Implement a tiered namespace model (production, staging, development) with corresponding quota tiers
- Consider HNC for organizations with complex namespace hierarchies requiring inherited policies
- Review quotas quarterly against actual utilization and business growth projections

The combination of properly sized quotas with meaningful LimitRange defaults prevents both resource exhaustion and the operational friction of admission failures from missing resource specifications.
