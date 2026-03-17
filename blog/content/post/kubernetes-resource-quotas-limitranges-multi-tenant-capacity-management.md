---
title: "Kubernetes Resource Quotas and LimitRanges: Multi-Tenant Capacity Management"
date: 2029-04-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ResourceQuota", "LimitRange", "Multi-Tenancy", "Capacity Planning", "Admission Control"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes ResourceQuota and LimitRange for multi-tenant capacity management: namespace budgeting, priority class integration, admission control flow, and production patterns for enterprise cluster governance."
more_link: "yes"
url: "/kubernetes-resource-quotas-limitranges-multi-tenant-capacity-management/"
---

Multi-tenant Kubernetes clusters without proper resource governance become a tragedy of the commons: one team's runaway batch job starves another team's latency-sensitive API service. ResourceQuota and LimitRange are the two admission control mechanisms that prevent this. ResourceQuota caps total resource consumption at the namespace level; LimitRange enforces per-container defaults and limits. Together, they form the foundation of enterprise cluster governance. This guide covers both in depth with production-ready patterns.

<!--more-->

# Kubernetes Resource Quotas and LimitRanges: Multi-Tenant Capacity Management

## Section 1: The Multi-Tenancy Problem

Without resource constraints, Kubernetes admits any workload that fits on available nodes. In a shared cluster, this creates several failure modes:

1. **Resource hoarding**: Team A deploys Pods with no limits, consuming all CPU/memory on a node, preventing Team B's Pods from scheduling
2. **Object proliferation**: A CI pipeline creates thousands of ConfigMaps or Secrets, consuming API server storage
3. **Node pressure**: Memory-unlimited Pods trigger OOM kills on other Pods sharing the node
4. **Quota bypass**: Privileged users create workloads in unquotaed namespaces

ResourceQuota addresses points 1, 2, and 4. LimitRange addresses point 3 by ensuring all Pods have limits.

### The Admission Control Flow

```
kubectl create pod
       |
       v
Authentication (who are you?)
       |
       v
Authorization (RBAC: can you create Pods here?)
       |
       v
Admission Controllers (policy enforcement)
       |
       +---> MutatingAdmissionWebhook
       |         (LimitRange: inject default limits)
       |
       +---> ValidatingAdmissionWebhook
       |         (ResourceQuota: reject if quota exceeded)
       |
       v
etcd (object persisted)
       |
       v
Scheduler (assign Pod to node)
```

LimitRange acts as a mutating admission controller — it modifies Pods that have no limits by injecting defaults. ResourceQuota acts as a validating controller — it rejects creation if the namespace would exceed its quota.

## Section 2: ResourceQuota

A ResourceQuota object sets an aggregate limit on resource consumption within a namespace. Once the quota ceiling is reached, new objects that would exceed it are rejected.

### Comprehensive ResourceQuota Example

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-alpha-quota
  namespace: team-alpha
spec:
  hard:
    # Compute resources
    requests.cpu: "20"          # Sum of all Pod CPU requests
    requests.memory: 40Gi       # Sum of all Pod memory requests
    limits.cpu: "40"            # Sum of all Pod CPU limits
    limits.memory: 80Gi         # Sum of all Pod memory limits

    # Pods and workloads
    pods: "100"                 # Maximum number of Pods
    replicationcontrollers: "10"
    deployments.apps: "20"
    statefulsets.apps: "5"
    jobs.batch: "50"
    cronjobs.batch: "10"

    # Storage
    requests.storage: "500Gi"   # Sum of all PVC storage requests
    persistentvolumeclaims: "20"
    # Limit requests to specific StorageClass
    gold.storageclass.storage.k8s.io/requests.storage: "200Gi"
    silver.storageclass.storage.k8s.io/requests.storage: "300Gi"

    # Service types (prevent expensive service types)
    services: "20"
    services.loadbalancers: "2"
    services.nodeports: "5"

    # Config objects
    configmaps: "50"
    secrets: "50"
    serviceaccounts: "20"

    # Ephemeral storage
    requests.ephemeral-storage: 50Gi
    limits.ephemeral-storage: 100Gi
```

### Scoped ResourceQuota (Priority Classes)

ResourceQuota can be scoped to apply only to specific Pod priority classes, enabling differentiated capacity by criticality:

```yaml
# Critical workloads get dedicated quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: critical-quota
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    pods: "20"
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: ["critical", "high-priority"]
---
# Best-effort workloads get separate quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort-quota
  namespace: team-alpha
spec:
  hard:
    pods: "50"
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: ["low-priority", "batch"]
---
# Not-best-effort (any Pod with requests/limits)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: notbesteffort-quota
  namespace: team-alpha
spec:
  hard:
    requests.cpu: "5"
    requests.memory: 10Gi
  scopes:
  - NotBestEffort
```

### Priority Class Definitions

```yaml
# system-critical (reserved for system components)
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: system-cluster-critical
value: 2000000000
globalDefault: false
description: "System critical — do not use for application workloads"
---
# Application priority tiers
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: critical
value: 1000000
globalDefault: false
description: "For SLA-bound production APIs"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 100000
globalDefault: false
description: "For customer-facing services"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: standard
value: 0
globalDefault: true
description: "Default for most workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: low-priority
value: -100
globalDefault: false
description: "For batch jobs and non-critical work"
preemptionPolicy: Never  # Cannot preempt other Pods
```

### Applying Priority Classes to Pods

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: team-alpha
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      priorityClassName: critical    # Match quota scope
      containers:
      - name: api
        image: myapp:latest
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
```

### Checking Quota Status

```bash
# View current quota usage for a namespace
kubectl describe quota -n team-alpha

# Example output:
# Name:                    team-alpha-quota
# Namespace:               team-alpha
# Resource                 Used    Hard
# --------                 ----    ----
# limits.cpu               8       40
# limits.memory            16Gi    80Gi
# pods                     16      100
# requests.cpu             4       20
# requests.memory          8Gi     40Gi
# requests.storage         120Gi   500Gi
# services.loadbalancers   1       2

# Get quota across all namespaces
kubectl get resourcequota --all-namespaces

# Get quota as JSON for automation
kubectl get resourcequota team-alpha-quota -n team-alpha -o json | \
  jq '{hard: .spec.hard, used: .status.used}'
```

### Quota Exceeded Error Handling

When a quota is exceeded, the API server returns a `403 Forbidden`:

```
Error from server (Forbidden): pods "my-pod" is forbidden:
exceeded quota: team-alpha-quota, requested: requests.cpu=500m,
used: requests.cpu=19500m, limited: requests.cpu=20
```

This is the expected behavior. Operators should monitor quota utilization and raise limits proactively:

```bash
# Alert when quota is >80% utilized (check via Prometheus)
# kubectl-quota-exporter or similar tool exposes quota as metrics

# Manual check script
#!/bin/bash
NAMESPACE="${1:-default}"
kubectl get resourcequota -n "$NAMESPACE" -o json | jq -r '
.items[] | .metadata.name as $name |
.spec.hard | to_entries[] |
.key as $resource |
.value as $hard |
(.status.used[$resource] // "0") as $used |
select($used != "0") |
{name: $name, resource: $resource, used: $used, hard: $hard} |
"\(.name): \(.resource) = \(.used) / \(.hard)"
' 2>/dev/null || \
kubectl get resourcequota -n "$NAMESPACE" -o jsonpath='{.items[*].status}' | python3 -c "
import json, sys
data = json.load(sys.stdin)
# process quota status
"
```

## Section 3: LimitRange

A LimitRange object sets defaults and bounds for individual containers, Pods, and PersistentVolumeClaims within a namespace. It solves three distinct problems:

1. **Default injection**: Pods without resource requests/limits get default values
2. **Minimum enforcement**: Prevents Pods from requesting trivially small resources
3. **Maximum enforcement**: Prevents Pods from requesting unlimited resources

### LimitRange for Containers

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: team-alpha
spec:
  limits:
  - type: Container
    # Default values injected if container specifies neither requests nor limits
    default:
      cpu: "500m"
      memory: "512Mi"
      ephemeral-storage: "1Gi"
    # Default requests if container specifies requests but not limits
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
      ephemeral-storage: "256Mi"
    # Maximum any single container can request
    max:
      cpu: "4"
      memory: "8Gi"
      ephemeral-storage: "10Gi"
    # Minimum any single container must request
    min:
      cpu: "10m"
      memory: "16Mi"
    # Maximum limit/request ratio — prevents containers that request
    # very little but limit very high (causes node pressure)
    maxLimitRequestRatio:
      cpu: "10"        # limit cannot be more than 10x request
      memory: "4"      # limit cannot be more than 4x request
```

### LimitRange for Pods

Pod-level limits apply to the sum of all containers in the Pod:

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
      memory: "16Gi"
    min:
      cpu: "50m"
      memory: "64Mi"
```

### LimitRange for PersistentVolumeClaims

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
      storage: "50Gi"     # No single PVC can exceed 50Gi
    min:
      storage: "1Gi"      # PVCs must request at least 1Gi
```

### How Default Injection Works

When a Pod is created without resource requests or limits, LimitRange injects defaults before the Pod is stored:

```yaml
# Pod as submitted by developer (no resources specified)
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: team-alpha
spec:
  containers:
  - name: myapp
    image: myapp:latest
    # No resources block
```

```yaml
# Pod as stored after LimitRange admission control
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: team-alpha
spec:
  containers:
  - name: myapp
    image: myapp:latest
    resources:
      requests:
        cpu: "100m"       # From defaultRequest
        memory: "128Mi"   # From defaultRequest
      limits:
        cpu: "500m"       # From default
        memory: "512Mi"   # From default
```

### Validating LimitRange Behavior

```bash
# Describe LimitRange to see current configuration
kubectl describe limitrange container-limits -n team-alpha

# Create a Pod without resources and verify injection
kubectl run test-pod --image=nginx:latest --namespace=team-alpha
kubectl get pod test-pod -n team-alpha -o json | \
  jq '.spec.containers[].resources'

# Expected output:
# {
#   "limits": {"cpu": "500m", "memory": "512Mi"},
#   "requests": {"cpu": "100m", "memory": "128Mi"}
# }

# Test max enforcement
kubectl run big-pod --image=nginx:latest --namespace=team-alpha \
  --limits='cpu=16,memory=32Gi'
# Error from server (Forbidden): pods "big-pod" is forbidden:
# maximum cpu usage per Container is 4, but limit is 16.
```

## Section 4: Namespace Hierarchy and Hierarchical Quotas

### Namespace Structure for Multi-Tenancy

```yaml
# Namespace per team with consistent labels
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    team: alpha
    tier: production
    cost-center: "1234"
  annotations:
    contact: "alpha-team@example.com"
    budget: "medium"
---
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha-dev
  labels:
    team: alpha
    tier: development
    cost-center: "1234"
```

### Namespace Provisioning with ResourceQuota (GitOps Pattern)

```yaml
# Kustomize overlay for team-alpha namespace
# kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
- namespace.yaml
- resourcequota.yaml
- limitrange.yaml
- rbac.yaml
- networkpolicy.yaml
```

```yaml
# Production namespace template (base)
# base/resourcequota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
spec:
  hard:
    requests.cpu: "$(REQUESTS_CPU)"
    requests.memory: "$(REQUESTS_MEMORY)"
    limits.cpu: "$(LIMITS_CPU)"
    limits.memory: "$(LIMITS_MEMORY)"
    pods: "$(MAX_PODS)"
    services.loadbalancers: "$(MAX_LBS)"
```

### Hierarchical Namespace Controller (HNC)

For large organizations, Hierarchical Namespace Controller propagates policies from parent to child namespaces:

```bash
# Install HNC
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/latest/download/default.yaml

# Create parent namespace
kubectl create namespace platform
kubectl hns create team-alpha --parent platform
kubectl hns create team-beta --parent platform

# Apply quota to parent — propagates to children
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: platform-quota
  namespace: platform
  annotations:
    hnc.x-k8s.io/propagate: "all"  # Propagate to all children
spec:
  hard:
    requests.cpu: "100"
    requests.memory: 200Gi
EOF
```

## Section 5: Resource Quota for Extended Resources

### GPU Quotas

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: ml-team
spec:
  hard:
    # NVIDIA GPU quota (from device plugin)
    requests.nvidia.com/gpu: "8"
    limits.nvidia.com/gpu: "8"
    # AMD GPU quota
    requests.amd.com/gpu: "0"
    # Intel GPU
    requests.gpu.intel.com/i915: "0"
```

### Custom Resource Quotas

```yaml
# For operator-managed resources
apiVersion: v1
kind: ResourceQuota
metadata:
  name: custom-resources-quota
  namespace: team-alpha
spec:
  hard:
    # Custom resources from operators
    count/databases.postgres.example.com: "3"
    count/topics.kafka.example.com: "20"
    count/certificates.cert-manager.io: "10"
    count/ingresses.networking.k8s.io: "10"
```

## Section 6: Admission Control Flow Deep Dive

### Understanding the Order of Operations

```
1. ResourceQuota dry-run check
   ├─ Is namespace over quota?
   │   ├─ YES → 403 Forbidden
   │   └─ NO → continue
   └─ Quota usage incremented atomically on success

2. LimitRange admission (mutating)
   ├─ Container has no requests?
   │   └─ Inject defaultRequest
   ├─ Container has requests but no limits?
   │   └─ Inject default limits
   └─ Validate against min/max/ratio
       ├─ Violates min/max → 403 Forbidden
       └─ Passes → Pod admitted

3. Scheduler
   └─ Uses injected requests for scheduling decisions
```

### ResourceQuota Optimistic Locking

Kubernetes uses optimistic locking when updating quota usage. If two Pods are admitted simultaneously and both would fit under quota individually but not together, one will succeed and one will be rejected:

```bash
# This can cause intermittent failures in high-concurrency deployments
# Solution: use batch admission or implement retry logic in controllers

# View quota status version (for conflict detection)
kubectl get resourcequota team-alpha-quota -n team-alpha \
  -o jsonpath='{.metadata.resourceVersion}'
```

### Custom Admission Webhook with Quota Awareness

```go
// quota-webhook.go — Admission webhook that checks custom quota rules
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type QuotaWebhook struct {
    // Custom quota rules beyond what ResourceQuota supports
    MaxGPUPerTeam map[string]int
}

func (w *QuotaWebhook) HandleValidate(writer http.ResponseWriter, req *http.Request) {
    var admissionReview admissionv1.AdmissionReview
    if err := json.NewDecoder(req.Body).Decode(&admissionReview); err != nil {
        http.Error(writer, err.Error(), http.StatusBadRequest)
        return
    }

    pod := &corev1.Pod{}
    if err := json.Unmarshal(admissionReview.Request.Object.Raw, pod); err != nil {
        http.Error(writer, err.Error(), http.StatusBadRequest)
        return
    }

    // Validate custom GPU quota
    namespace := admissionReview.Request.Namespace
    gpuRequest := getTotalGPURequest(pod)

    response := &admissionv1.AdmissionResponse{
        UID: admissionReview.Request.UID,
    }

    maxGPU, ok := w.MaxGPUPerTeam[namespace]
    if ok && gpuRequest > 0 {
        // Check current GPU usage (simplified — real impl would query API)
        currentUsage := getCurrentGPUUsage(namespace)
        if currentUsage+gpuRequest > maxGPU {
            response.Allowed = false
            response.Result = &metav1.Status{
                Code:    403,
                Message: fmt.Sprintf("GPU quota exceeded: requested %d, current usage %d, max %d", gpuRequest, currentUsage, maxGPU),
            }
        } else {
            response.Allowed = true
        }
    } else {
        response.Allowed = true
    }

    admissionReview.Response = response
    json.NewEncoder(writer).Encode(admissionReview)
}

func getTotalGPURequest(pod *corev1.Pod) int {
    total := 0
    for _, c := range pod.Spec.Containers {
        if gpu, ok := c.Resources.Requests["nvidia.com/gpu"]; ok {
            total += int(gpu.Value())
        }
    }
    return total
}

func getCurrentGPUUsage(namespace string) int {
    // Query API server for current Pod GPU usage in namespace
    // (simplified for example)
    return 0
}

func main() {
    webhook := &QuotaWebhook{
        MaxGPUPerTeam: map[string]int{
            "ml-team":    8,
            "research":   4,
            "experiments": 2,
        },
    }

    http.HandleFunc("/validate", webhook.HandleValidate)
    log.Fatal(http.ListenAndServeTLS(":8443", "/certs/tls.crt", "/certs/tls.key", nil))
}
```

## Section 7: Monitoring and Alerting

### Prometheus Metrics for Quotas

The `kube-state-metrics` service exposes ResourceQuota metrics:

```promql
# Namespace quota utilization (percentage)
kube_resourcequota{resource="requests.cpu", type="used"}
/
kube_resourcequota{resource="requests.cpu", type="hard"}

# Alert when any namespace is >80% of CPU quota
(
  kube_resourcequota{resource="requests.cpu", type="used"}
  /
  kube_resourcequota{resource="requests.cpu", type="hard"}
) > 0.8

# Alert when pod count quota is >90% utilized
(
  kube_resourcequota{resource="pods", type="used"}
  /
  kube_resourcequota{resource="pods", type="hard"}
) > 0.9
```

### PrometheusRule for Quota Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: quota-alerts
  namespace: monitoring
spec:
  groups:
  - name: quota.rules
    interval: 1m
    rules:
    - alert: NamespaceCPUQuotaHighUtilization
      expr: |
        (
          kube_resourcequota{resource="requests.cpu", type="used"}
          /
          kube_resourcequota{resource="requests.cpu", type="hard"}
        ) > 0.8
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Namespace {{ $labels.namespace }} is at {{ $value | humanizePercentage }} CPU quota"
        description: "Consider raising the quota or reducing deployments in {{ $labels.namespace }}"

    - alert: NamespaceMemoryQuotaHighUtilization
      expr: |
        (
          kube_resourcequota{resource="requests.memory", type="used"}
          /
          kube_resourcequota{resource="requests.memory", type="hard"}
        ) > 0.85
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Namespace {{ $labels.namespace }} is at {{ $value | humanizePercentage }} memory quota"

    - alert: NamespaceStorageQuotaNearLimit
      expr: |
        (
          kube_resourcequota{resource="requests.storage", type="used"}
          /
          kube_resourcequota{resource="requests.storage", type="hard"}
        ) > 0.9
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Storage quota in {{ $labels.namespace }} is almost exhausted"
```

### Grafana Dashboard Queries

```promql
# Quota utilization heatmap across all namespaces
topk(20,
  kube_resourcequota{resource="requests.cpu", type="used"}
  /
  kube_resourcequota{resource="requests.cpu", type="hard"}
)

# Namespace resource breakdown
kube_pod_container_resource_requests{
  namespace="team-alpha",
  resource="cpu"
}
```

## Section 8: Production Patterns and Pitfalls

### Pattern: Quota Bootstrap Script

```bash
#!/bin/bash
# provision-namespace.sh — Provision a new team namespace with standard quota

set -euo pipefail

NAMESPACE="$1"
TEAM="$2"
TIER="${3:-standard}"  # standard, premium, basic

case "$TIER" in
  premium)
    CPU_REQUESTS=40; CPU_LIMITS=80
    MEM_REQUESTS=80Gi; MEM_LIMITS=160Gi
    MAX_PODS=200; MAX_LBS=4
    ;;
  standard)
    CPU_REQUESTS=20; CPU_LIMITS=40
    MEM_REQUESTS=40Gi; MEM_LIMITS=80Gi
    MAX_PODS=100; MAX_LBS=2
    ;;
  basic)
    CPU_REQUESTS=5; CPU_LIMITS=10
    MEM_REQUESTS=10Gi; MEM_LIMITS=20Gi
    MAX_PODS=30; MAX_LBS=1
    ;;
  *)
    echo "Unknown tier: $TIER"; exit 1
    ;;
esac

# Create namespace
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | \
  kubectl apply -f -

# Label namespace
kubectl label namespace "$NAMESPACE" \
  team="$TEAM" tier="$TIER" \
  managed-by=quota-provisioner \
  --overwrite

# Apply ResourceQuota
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
  namespace: $NAMESPACE
spec:
  hard:
    requests.cpu: "$CPU_REQUESTS"
    requests.memory: $MEM_REQUESTS
    limits.cpu: "$CPU_LIMITS"
    limits.memory: $MEM_LIMITS
    pods: "$MAX_PODS"
    services.loadbalancers: "$MAX_LBS"
    services.nodeports: "10"
    persistentvolumeclaims: "30"
    requests.storage: "1Ti"
    configmaps: "100"
    secrets: "100"
EOF

# Apply LimitRange
kubectl apply -f - <<EOF
apiVersion: v1
kind: LimitRange
metadata:
  name: container-limits
  namespace: $NAMESPACE
spec:
  limits:
  - type: Container
    default:
      cpu: "500m"
      memory: "512Mi"
    defaultRequest:
      cpu: "100m"
      memory: "128Mi"
    max:
      cpu: "4"
      memory: "8Gi"
    min:
      cpu: "10m"
      memory: "16Mi"
    maxLimitRequestRatio:
      cpu: "10"
      memory: "4"
  - type: PersistentVolumeClaim
    max:
      storage: "100Gi"
    min:
      storage: "1Gi"
EOF

echo "Namespace $NAMESPACE provisioned with $TIER tier quota"
```

### Pitfall 1: Quota on Limits But Not Requests

If you only quota `limits.cpu` without `requests.cpu`, workloads can set arbitrarily low requests and high limits, causing the scheduler to overcommit nodes:

```yaml
# Anti-pattern: only limiting hard limits
spec:
  hard:
    limits.cpu: "40"      # ← Only this
    limits.memory: 80Gi   # ← Only this
    # Missing: requests.cpu and requests.memory

# Correct: limit both
spec:
  hard:
    requests.cpu: "20"
    limits.cpu: "40"
    requests.memory: 40Gi
    limits.memory: 80Gi
```

### Pitfall 2: LimitRange Without ResourceQuota

LimitRange injects defaults per-container but does not cap total consumption. A team can deploy 1000 Pods each with the default 100m CPU request and consume 100 cores. Always pair LimitRange with ResourceQuota.

### Pitfall 3: Forgetting to Account for System Resources

System DaemonSets (node-exporter, CNI plugins, log agents) also consume CPU/memory. If you allocate 100% of node capacity to tenant quotas, system DaemonSets cannot schedule:

```bash
# Calculate allocatable resources per node (subtract DaemonSet overhead)
kubectl describe node worker-01 | grep -A 8 "Allocatable:"
# Allocatable:
#   cpu:                3920m
#   memory:             14Gi
#   pods:               110

# DaemonSet overhead per node (estimate)
# node-exporter: 50m CPU, 50Mi memory
# cilium: 100m CPU, 200Mi memory
# fluentd: 100m CPU, 200Mi memory
# Total: ~250m CPU, 450Mi memory per node

# Available for tenant workloads per node:
# CPU: 3920m - 250m = 3670m
# Memory: 14Gi - 450Mi = 13.5Gi
```

### Pitfall 4: Quota and Horizontal Pod Autoscaler Interaction

If ResourceQuota prevents new Pods from being created, HPA scale-outs will silently fail. The HPA will report a condition but the Deployment won't receive the new Pods:

```bash
# Monitor HPA events for quota-related failures
kubectl describe hpa myapp-hpa -n team-alpha | grep -i "quota\|forbidden\|failed"

# Set up HPA quota buffer: ensure quota headroom >= max replicas * per-pod resources
# If HPA max replicas = 20, pod requests 500m CPU:
# Required quota headroom = 20 * 0.5 = 10 CPU
```

### Pattern: Quota Review Workflow

```yaml
# Quota increase request (via GitOps PR)
# teams/team-alpha/quota-override.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
  namespace: team-alpha
  annotations:
    # Approval tracking
    quota.example.com/approved-by: "platform-team"
    quota.example.com/approved-date: "2029-04-22"
    quota.example.com/ticket: "INFRA-1234"
    quota.example.com/reason: "ML training job requires 8 GPUs for 2 weeks"
    quota.example.com/expires: "2029-05-06"
spec:
  hard:
    requests.cpu: "30"         # Increased from 20
    requests.memory: 60Gi      # Increased from 40Gi
    requests.nvidia.com/gpu: "8"  # Temporary GPU allocation
```

## Section 9: ResourceQuota for Non-Compute Resources

### Counting API Objects

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: object-count-quota
  namespace: ci-team
spec:
  hard:
    # Prevent CI jobs from creating runaway objects
    count/configmaps: "500"
    count/secrets: "200"
    count/pods: "500"
    count/services: "50"
    count/ingresses.networking.k8s.io: "20"
    count/jobs.batch: "200"
    count/cronjobs.batch: "20"
    count/deployments.apps: "50"
    count/replicasets.apps: "100"
    count/statefulsets.apps: "10"
    count/horizontalpodautoscalers.autoscaling: "20"
    count/persistentvolumeclaims: "50"
    count/serviceaccounts: "30"
    # Limit CRD instances
    count/postgresqls.acid.zalan.do: "5"
    count/kafkatopics.kafka.strimzi.io: "50"
```

## Conclusion

ResourceQuota and LimitRange together provide complete resource governance for multi-tenant Kubernetes clusters. ResourceQuota sets the aggregate budget for a namespace — preventing any single team from consuming more than their fair share. LimitRange establishes per-container defaults and bounds — ensuring every Pod has resource requests that enable meaningful scheduling decisions and limits that prevent runaway memory consumption.

The key principle is defense in depth: always deploy both together, always quota both requests and limits, and always monitor utilization with Prometheus alerts at the 80% threshold. This prevents the quota ceiling from becoming a surprise operational event and gives platform teams time to negotiate increases before workloads are rejected.

For large organizations, pair this with Hierarchical Namespace Controller and a GitOps-based quota provisioning workflow to maintain consistency as the number of teams and namespaces grows.
