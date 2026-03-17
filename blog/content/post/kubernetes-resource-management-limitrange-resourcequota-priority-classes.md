---
title: "Kubernetes Resource Management: LimitRange, ResourceQuota, and Priority Classes"
date: 2030-03-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Resource Management", "LimitRange", "ResourceQuota", "PriorityClass", "FinOps"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes namespace-level resource governance using LimitRange defaults, ResourceQuota for compute and object limits, PriorityClass design for workload tiers, and preemption behavior in production clusters."
more_link: "yes"
url: "/kubernetes-resource-management-limitrange-resourcequota-priority-classes/"
---

Kubernetes resource management is the foundation of multi-tenant cluster operations. Without properly configured LimitRanges, ResourceQuotas, and PriorityClasses, a single misconfigured deployment can consume all available cluster resources, degrade the experience for other teams, and make accurate capacity planning impossible. Resource management is also the enabling mechanism for FinOps cost allocation: without namespace-level quotas tied to team ownership, chargeback and showback reporting is guesswork.

This guide covers the complete Kubernetes resource governance stack: LimitRange for setting defaults and bounds at the namespace level, ResourceQuota for hard limits on compute and object counts, and PriorityClass for workload tiering and preemption control.

<!--more-->

## Why Resource Governance Matters

In a shared Kubernetes cluster without resource governance:

- **Noisy neighbor problem**: A team deploys a Pod with unlimited CPU requests. The scheduler places it on a node alongside other critical workloads. Under load, the unlimited Pod consumes all CPU, causing throttling for critical services.
- **OOM Kills cascade**: A Pod without memory limits leaks memory until the node OOM killer fires, potentially killing other Pods on the same node.
- **Scheduling failures**: A team deploying an application with incorrect `resources.requests` (too low) causes the scheduler to overcommit nodes. Under load, actual resource consumption exceeds node capacity.
- **Quota accountability**: Without quotas, there is no mechanism to prevent one team from consuming 90% of cluster compute, and no data for chargeback.

Resource governance solves these problems by:
1. **LimitRange**: Setting sane defaults and bounds for containers that do not specify resources
2. **ResourceQuota**: Enforcing hard limits on total resource consumption per namespace
3. **PriorityClass**: Tiering workloads so critical systems are protected during resource pressure

## LimitRange: Namespace-Level Container Defaults and Bounds

LimitRange applies to Pod/Container/PersistentVolumeClaim objects within a namespace. It:
- Sets default `requests` and `limits` for containers that do not specify them
- Enforces minimum and maximum values for requests and limits
- Enforces a maximum ratio between limits and requests

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
    # Default values applied when container does not specify resources
    default:
      cpu: 500m
      memory: 256Mi
    # Default request values
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    # Maximum allowed per container
    max:
      cpu: "4"
      memory: 8Gi
    # Minimum allowed per container
    min:
      cpu: 50m
      memory: 64Mi
    # Maximum ratio: limit must not exceed request * maxLimitRequestRatio
    maxLimitRequestRatio:
      cpu: "10"      # CPU limit can be at most 10x the request
      memory: "4"    # Memory limit can be at most 4x the request
```

### Pod LimitRange

Pod-level limits apply to the sum of all containers in a Pod:

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
      cpu: "8"      # No single Pod can request more than 8 CPU
      memory: 16Gi  # No single Pod can request more than 16Gi memory
    min:
      cpu: 100m
      memory: 128Mi
```

### PersistentVolumeClaim LimitRange

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: storage-limits
  namespace: team-alpha
spec:
  limits:
  - type: PersistentVolumeClaim
    max:
      storage: 100Gi  # No single PVC can request more than 100Gi
    min:
      storage: 1Gi    # Minimum PVC size enforced
```

### Production LimitRange Configuration

For a production team namespace, combine all limit types:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: production-limits
  namespace: team-payments
  labels:
    managed-by: platform-team
    tier: production
spec:
  limits:
  # Container-level defaults and bounds
  - type: Container
    default:
      cpu: "1"
      memory: 512Mi
    defaultRequest:
      cpu: 200m
      memory: 256Mi
    max:
      cpu: "8"
      memory: 32Gi
    min:
      cpu: 50m
      memory: 64Mi
    maxLimitRequestRatio:
      cpu: "8"
      memory: "4"

  # Pod-level sum limits
  - type: Pod
    max:
      cpu: "16"
      memory: 64Gi
    min:
      cpu: 100m
      memory: 128Mi

  # Storage limits
  - type: PersistentVolumeClaim
    max:
      storage: 500Gi
    min:
      storage: 1Gi
```

### How LimitRange Defaults Work in Practice

```bash
# Create a namespace with a LimitRange
kubectl create namespace test-limitrange
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: test-limitrange
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 256Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
EOF

# Deploy a Pod WITHOUT resource specifications
kubectl run test-pod --image=nginx:1.25 -n test-limitrange

# Observe that defaults were injected
kubectl get pod test-pod -n test-limitrange -o json | \
  jq '.spec.containers[].resources'
# {
#   "limits": {
#     "cpu": "500m",
#     "memory": "256Mi"
#   },
#   "requests": {
#     "cpu": "100m",
#     "memory": "128Mi"
#   }
# }

# Deploy a Pod that exceeds the max - should be rejected
kubectl apply -n test-limitrange -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: too-big
spec:
  containers:
  - name: app
    image: nginx:1.25
    resources:
      limits:
        cpu: "100"  # Exceeds max of 8
        memory: 512Mi
EOF
# Error from server (Forbidden): pods "too-big" is forbidden:
# [maximum cpu usage per Container is 8, but limit is 100]
```

## ResourceQuota: Hard Limits on Namespace Consumption

ResourceQuota enforces hard limits on the total resource consumption within a namespace. When a quota is exceeded, new object creation is rejected. Quotas cover:
- Compute resources (CPU, memory)
- Storage resources (PVC count, storage class usage)
- Object counts (Pods, Services, ConfigMaps, etc.)
- Scoped quotas (QoS class, priority class)

### Compute Resource Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: team-alpha
spec:
  hard:
    # CPU quotas
    requests.cpu: "20"      # Total CPU requests in namespace <= 20 cores
    limits.cpu: "40"        # Total CPU limits in namespace <= 40 cores

    # Memory quotas
    requests.memory: 40Gi   # Total memory requests <= 40Gi
    limits.memory: 80Gi     # Total memory limits <= 80Gi

    # GPU quota
    requests.nvidia.com/gpu: "4"
```

### Storage Resource Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-quota
  namespace: team-alpha
spec:
  hard:
    # Total number of PersistentVolumeClaims
    persistentvolumeclaims: "20"

    # Total storage across all PVCs
    requests.storage: 1Ti

    # Per-StorageClass limits
    fast-ssd.storageclass.storage.k8s.io/requests.storage: 500Gi
    fast-ssd.storageclass.storage.k8s.io/persistentvolumeclaims: "10"
    standard.storageclass.storage.k8s.io/requests.storage: 500Gi
```

### Object Count Quota

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: object-count-quota
  namespace: team-alpha
spec:
  hard:
    # Workload objects
    pods: "100"
    replicationcontrollers: "10"
    count/deployments.apps: "30"
    count/statefulsets.apps: "10"
    count/daemonsets.apps: "5"
    count/jobs.batch: "20"
    count/cronjobs.batch: "10"

    # Service and networking
    services: "20"
    services.loadbalancers: "5"      # LoadBalancer services
    services.nodeports: "0"          # Disable NodePort services

    # Configuration
    configmaps: "50"
    secrets: "50"

    # Ingress
    count/ingresses.networking.k8s.io: "15"
```

### Scoped ResourceQuota

Scoped quotas apply only to objects that match specific criteria (QoS class, priority class, cross-namespace scope):

```yaml
# Quota that only counts Burstable pods toward the limit
apiVersion: v1
kind: ResourceQuota
metadata:
  name: burstable-quota
  namespace: team-alpha
spec:
  hard:
    pods: "50"
    requests.cpu: "10"
    requests.memory: 20Gi
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values:
      - low-priority
      - batch
---
# Separate quota for high-priority pods (critical workloads)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: high-priority-quota
  namespace: team-alpha
spec:
  hard:
    pods: "20"
    requests.cpu: "40"
    requests.memory: 80Gi
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values:
      - high-priority
      - critical
---
# BestEffort quota (pods with no resource requests/limits)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort-quota
  namespace: team-alpha
spec:
  hard:
    pods: "5"
  scopes:
  - BestEffort
```

### Checking Quota Usage

```bash
# View quota status with current usage
kubectl get resourcequota -n team-alpha
# NAME            AGE   REQUEST                        LIMIT
# compute-quota   1d    requests.cpu: 8/20, ...        limits.cpu: 16/40

# Detailed view
kubectl describe resourcequota compute-quota -n team-alpha
# Name:            compute-quota
# Namespace:       team-alpha
# Resource         Used    Hard
# --------         ----    ----
# limits.cpu       16      40
# limits.memory    32Gi    80Gi
# requests.cpu     8       20
# requests.memory  16Gi    40Gi

# Watch quota usage in real time
watch kubectl get resourcequota -n team-alpha

# Check what is consuming quota (sorted by CPU request)
kubectl get pods -n team-alpha -o json | \
  jq '[.items[] | {name: .metadata.name, cpu_req: .spec.containers[].resources.requests.cpu}] | sort_by(.cpu_req) | reverse'
```

### Quota Enforcement Behavior

When a namespace exceeds a quota, new object creation fails with a descriptive error:

```bash
# Attempt to create a Pod that would exceed quota
kubectl apply -n team-alpha -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: quota-test
spec:
  containers:
  - name: app
    image: nginx:1.25
    resources:
      requests:
        cpu: "15"  # Would push total over the 20 CPU request limit
        memory: 10Gi
      limits:
        cpu: "20"
        memory: 20Gi
EOF

# Error from server (Forbidden): pods "quota-test" is forbidden:
# exceeded quota: compute-quota, requested: requests.cpu=15,
# used: requests.cpu=8, limited: requests.cpu=20
```

## PriorityClass: Workload Tiering and Preemption

PriorityClass assigns an integer priority value to Pods. Higher-priority Pods are scheduled before lower-priority Pods. When cluster resources are insufficient, the scheduler can preempt (evict) lower-priority Pods to make room for higher-priority ones.

### Kubernetes Built-in Priority Classes

Kubernetes includes two system-level priority classes:

```bash
kubectl get priorityclass
# NAME                      VALUE        GLOBAL-DEFAULT   AGE
# system-cluster-critical   2000000000   false            30d
# system-node-critical      2000001000   false            30d
```

These are reserved for system components like `coredns`, `kube-proxy`, and metrics-server. Never assign these to application workloads.

### Designing Application Priority Tiers

A well-designed priority tier system typically has 4-5 levels:

```yaml
# Tier 1: Critical production workloads (revenue-generating)
# These can preempt everything except system-critical
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-critical
value: 1000000
globalDefault: false
preemptionPolicy: PreemptLowerPriority  # Default: can preempt
description: "Critical production services. Payments, auth, core APIs."
---
# Tier 2: Standard production workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: production-standard
value: 100000
globalDefault: true  # Applied to Pods without an explicit PriorityClass
preemptionPolicy: PreemptLowerPriority
description: "Standard production services. Can be preempted by production-critical."
---
# Tier 3: Non-critical workloads (monitoring, logging, tooling)
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: non-critical
value: 10000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Non-critical services: monitoring dashboards, dev tooling."
---
# Tier 4: Batch workloads - can be preempted freely
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch
value: 1000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Batch jobs, background data processing, reports."
---
# Tier 5: Development/testing - lowest priority
# Never preempts; can be preempted by everything above
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: development
value: 100
globalDefault: false
preemptionPolicy: Never  # Will not preempt anything
description: "Development and testing workloads. Use Never preemption."
```

### Using PriorityClass in Deployments

```yaml
# Critical API gateway
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      priorityClassName: production-critical
      containers:
      - name: gateway
        image: api-gateway:2.0.0
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 2Gi
---
# Batch processing job
apiVersion: batch/v1
kind: Job
metadata:
  name: nightly-report
  namespace: batch
spec:
  template:
    spec:
      priorityClassName: batch
      restartPolicy: OnFailure
      containers:
      - name: reporter
        image: report-generator:1.0.0
        resources:
          requests:
            cpu: "2"
            memory: 4Gi
          limits:
            cpu: "4"
            memory: 8Gi
```

### Preemption Behavior Deep Dive

Understanding preemption is critical for designing priority classes correctly:

```bash
# Simulate preemption scenario
# 1. Node has 8 CPU, fully utilized by batch jobs
# 2. A production-critical Pod cannot be scheduled

# Check current node capacity
kubectl describe node worker-node-01 | grep -A 10 "Allocated resources"
# Allocated resources:
#   CPU Requests    7800m (97%)
#   Memory Requests 28Gi (87%)

# Deploy a high-priority Pod that needs 4 CPU
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: urgent-workload
  namespace: production
spec:
  priorityClassName: production-critical
  containers:
  - name: app
    image: critical-app:1.0.0
    resources:
      requests:
        cpu: "4"
        memory: 4Gi
      limits:
        cpu: "4"
        memory: 8Gi
EOF

# Watch the scheduler preempt lower-priority Pods
kubectl get events --field-selector reason=Preempted -w
# LAST SEEN   TYPE     REASON     OBJECT           MESSAGE
# 0s          Normal   Preempted  pod/batch-job-1  Preempted by production/urgent-workload
# 0s          Normal   Preempted  pod/batch-job-2  Preempted by production/urgent-workload

# The high-priority Pod should now be scheduled
kubectl get pod urgent-workload -n production
# NAME             READY   STATUS    RESTARTS   AGE
# urgent-workload  1/1     Running   0          30s
```

### PodDisruptionBudgets and Priority Interaction

PodDisruptionBudgets (PDBs) protect workloads during voluntary disruptions (drain, rolling update) but do NOT prevent preemption:

```yaml
# PDB does not prevent preemption by higher-priority Pods
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-gateway-pdb
  namespace: production
spec:
  minAvailable: 3
  selector:
    matchLabels:
      app: api-gateway
```

```bash
# Important: PDB prevents kubectl drain from evicting pods below minAvailable
# But preemption by higher-priority pods bypasses PDB
# Design priority classes with this in mind

# To protect against preemption, use:
# 1. High enough priority class
# 2. Requests matching available capacity
# 3. PodAntiAffinity to spread across nodes

# Check which Pods have PDBs and their current availability
kubectl get pdb -A
kubectl describe pdb api-gateway-pdb -n production
# Allowed disruptions: 2
# Current: 5 healthy, 3 required, 2 disruptions allowed
```

## Complete Namespace Governance Example

Here is a complete namespace governance configuration for a production team:

```yaml
# namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments
  labels:
    team: payments
    tier: production
    cost-center: "CC-1042"
---
# limitrange.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: team-payments
spec:
  limits:
  - type: Container
    default:
      cpu: "1"
      memory: 512Mi
    defaultRequest:
      cpu: 250m
      memory: 256Mi
    max:
      cpu: "8"
      memory: 32Gi
    min:
      cpu: 50m
      memory: 64Mi
    maxLimitRequestRatio:
      cpu: "8"
      memory: "4"
  - type: Pod
    max:
      cpu: "16"
      memory: 64Gi
  - type: PersistentVolumeClaim
    max:
      storage: 200Gi
    min:
      storage: 1Gi
---
# resourcequota-compute.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute
  namespace: team-payments
spec:
  hard:
    requests.cpu: "40"
    limits.cpu: "80"
    requests.memory: 80Gi
    limits.memory: 160Gi
    requests.nvidia.com/gpu: "0"
---
# resourcequota-objects.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: objects
  namespace: team-payments
spec:
  hard:
    pods: "150"
    count/deployments.apps: "50"
    count/statefulsets.apps: "15"
    count/jobs.batch: "50"
    count/cronjobs.batch: "20"
    services: "30"
    services.loadbalancers: "3"
    services.nodeports: "0"
    configmaps: "100"
    secrets: "100"
    persistentvolumeclaims: "50"
    requests.storage: 2Ti
    count/ingresses.networking.k8s.io: "20"
---
# resourcequota-storage.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-by-class
  namespace: team-payments
spec:
  hard:
    fast-nvme.storageclass.storage.k8s.io/requests.storage: 1Ti
    fast-nvme.storageclass.storage.k8s.io/persistentvolumeclaims: "20"
    standard.storageclass.storage.k8s.io/requests.storage: 1Ti
    standard.storageclass.storage.k8s.io/persistentvolumeclaims: "30"
```

### Applying and Validating Governance

```bash
# Apply all governance resources
kubectl apply -f namespace.yaml
kubectl apply -f limitrange.yaml
kubectl apply -f resourcequota-compute.yaml
kubectl apply -f resourcequota-objects.yaml
kubectl apply -f resourcequota-storage.yaml

# Validate limits are applied
kubectl describe limitrange container-defaults -n team-payments

# Check current quota usage
kubectl describe resourcequota -n team-payments

# Test that defaults are applied to a bare Pod
kubectl run test --image=nginx:1.25 -n team-payments
kubectl get pod test -n team-payments -o json | jq '.spec.containers[].resources'
# Should show injected defaults

# Cleanup
kubectl delete pod test -n team-payments
```

## Admission Webhooks for Advanced Governance

For governance beyond what LimitRange and ResourceQuota support, use admission webhooks. Example: enforcing a label taxonomy:

```go
// webhook/resource_validator.go
package webhook

import (
    "encoding/json"
    "fmt"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/serializer"
)

var (
    scheme = runtime.NewScheme()
    codecs = serializer.NewCodecFactory(scheme)
)

// RequiredLabels enforces required labels on Pods
var RequiredLabels = []string{"app", "team", "version"}

// RequiredAnnotations enforces required annotations
var RequiredAnnotations = []string{"owner-email"}

func ValidatePodHandler(w http.ResponseWriter, r *http.Request) {
    body := make([]byte, r.ContentLength)
    r.Body.Read(body)

    review := &admissionv1.AdmissionReview{}
    if err := json.Unmarshal(body, review); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    pod := &corev1.Pod{}
    if err := json.Unmarshal(review.Request.Object.Raw, pod); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    var violations []string

    // Check required labels
    for _, label := range RequiredLabels {
        if _, ok := pod.Labels[label]; !ok {
            violations = append(violations, fmt.Sprintf("missing required label: %s", label))
        }
    }

    // Check required annotations
    for _, annotation := range RequiredAnnotations {
        if _, ok := pod.Annotations[annotation]; !ok {
            violations = append(violations, fmt.Sprintf("missing required annotation: %s", annotation))
        }
    }

    // Check that resources are specified (don't rely on LimitRange defaults for production)
    for _, container := range pod.Spec.Containers {
        if container.Resources.Requests == nil {
            violations = append(violations,
                fmt.Sprintf("container %s: resource requests must be specified explicitly", container.Name))
        }
    }

    response := &admissionv1.AdmissionReview{
        TypeMeta: review.TypeMeta,
        Response: &admissionv1.AdmissionResponse{
            UID: review.Request.UID,
        },
    }

    if len(violations) > 0 {
        response.Response.Allowed = false
        response.Response.Result = &metav1.Status{
            Code:    http.StatusBadRequest,
            Message: fmt.Sprintf("pod validation failed:\n%s", strings.Join(violations, "\n")),
        }
    } else {
        response.Response.Allowed = true
    }

    json.NewEncoder(w).Encode(response)
}
```

## Monitoring Resource Governance

### Prometheus Alerts for Quota Violations

```yaml
# prometheus/rules/resource-quota.yaml
groups:
- name: resource-quota
  interval: 30s
  rules:
  # Alert when namespace is using > 85% of CPU quota
  - alert: NamespaceCPUQuotaNearLimit
    expr: |
      (
        kube_resourcequota{resource="requests.cpu", type="used"}
        /
        kube_resourcequota{resource="requests.cpu", type="hard"}
      ) > 0.85
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Namespace {{ $labels.namespace }} CPU quota near limit"
      description: "{{ $labels.namespace }} is using {{ $value | humanizePercentage }} of CPU quota"

  # Alert when namespace is using > 90% of memory quota
  - alert: NamespaceMemoryQuotaNearLimit
    expr: |
      (
        kube_resourcequota{resource="requests.memory", type="used"}
        /
        kube_resourcequota{resource="requests.memory", type="hard"}
      ) > 0.90
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Namespace {{ $labels.namespace }} memory quota near limit"
      description: "{{ $labels.namespace }} is at {{ $value | humanizePercentage }} of memory quota"

  # Alert when pod count exceeds 90% of quota
  - alert: NamespacePodCountNearLimit
    expr: |
      (
        kube_resourcequota{resource="pods", type="used"}
        /
        kube_resourcequota{resource="pods", type="hard"}
      ) > 0.90
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Namespace {{ $labels.namespace }} pod count near limit"

  # Alert on any preemption events
  - alert: PodPreemptionOccurred
    expr: |
      increase(kube_pod_status_scheduled_time{scheduled="false"}[5m]) > 0
    labels:
      severity: info
    annotations:
      summary: "Pod preemption occurred in cluster"
```

### Grafana Dashboard Queries

```promql
# Quota utilization per namespace (CPU)
sum by (namespace) (kube_resourcequota{resource="requests.cpu", type="used"})
/
sum by (namespace) (kube_resourcequota{resource="requests.cpu", type="hard"})

# Namespaces sorted by memory quota utilization
topk(10,
  sum by (namespace) (kube_resourcequota{resource="requests.memory", type="used"})
  /
  sum by (namespace) (kube_resourcequota{resource="requests.memory", type="hard"})
)

# Pods without resource requests (relying on defaults)
count by (namespace) (
  kube_pod_container_resource_requests{resource="cpu"} == 0
)
```

## Key Takeaways

A comprehensive resource governance strategy in Kubernetes combines three layers:

**LimitRange** handles the "no spec" problem — containers deployed without explicit resource requests and limits get sane defaults injected automatically. Use `maxLimitRequestRatio` to prevent teams from setting unrealistically low requests with high limits, which causes scheduling overcommit.

**ResourceQuota** enforces team-level budgets. Scoped quotas with priority class selectors allow you to give critical workloads reserved capacity within a namespace while capping total consumption. Always set both `requests` and `limits` quotas; requests drive scheduling, limits cap runtime consumption.

**PriorityClass** provides cluster-level workload tiering. The four-tier design (critical, standard, batch, development) gives the scheduler the information it needs to make intelligent preemption decisions. Use `preemptionPolicy: Never` for development namespaces to prevent dev workloads from displacing production.

The combination of these three mechanisms, backed by monitoring and alerting on quota utilization, provides the foundation for confident multi-tenant Kubernetes cluster operations.
