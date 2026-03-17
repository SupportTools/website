---
title: "Kubernetes Pod Overhead and Resource Accounting: Kata Containers, gVisor, and Accurate Capacity Planning"
date: 2028-06-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Pod Overhead", "RuntimeClass", "Kata Containers", "gVisor", "Resource Management", "Capacity Planning"]
categories: ["Kubernetes", "Resource Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes Pod Overhead for sandbox container runtimes: RuntimeClass overhead configuration for Kata Containers and gVisor, VPA integration, accurate node capacity planning, and resource accounting in multi-runtime clusters."
more_link: "yes"
url: "/kubernetes-pod-overhead-resource-accounting-guide/"
---

Running Kata Containers or gVisor on Kubernetes improves workload isolation, but each sandbox VM or kernel instance consumes memory and CPU that is invisible to naive resource accounting. A node might report 64 GB of allocatable memory, but if 200 sandboxed Pods each consume 256 MB of overhead for their lightweight VM, the effective usable capacity is 13 GB less than expected. Without Pod Overhead configuration, workloads are over-scheduled, OOM kills follow, and capacity planning becomes unreliable.

The Pod Overhead feature (stable since Kubernetes 1.24) lets cluster operators declare the fixed resource cost of a container runtime class. The scheduler and kubelet then add this overhead to Pod resource requests and limits, ensuring accurate bin-packing and preventing node over-subscription.

<!--more-->

## Understanding Pod Overhead

### The Problem Without Overhead Accounting

Without overhead accounting, container resource requests only include the application's declared needs:

```
Pod Resource Request = sum(container.resources.requests)
```

For a sandboxed runtime like Kata Containers, the actual resource consumption is:

```
Actual Consumption = sum(container.resources.requests)
                   + kata_kernel_memory (~128-256 MB)
                   + kata_agent_memory (~50 MB)
                   + kata_vm_fixed_cpu_cost
```

The difference between declared and actual creates scheduling errors. Nodes fill up before their capacity is reached, or worse, they become over-subscribed when the unreported overhead tips memory over the limit.

### How Pod Overhead Works

Pod Overhead is declared in the RuntimeClass object. When a Pod referencing that RuntimeClass is created:

1. The admission controller reads the RuntimeClass overhead
2. The overhead values are injected into `pod.spec.overhead`
3. The scheduler adds `spec.overhead` to `sum(containers.requests)` when calculating fit
4. The kubelet adds overhead when enforcing cgroups and reporting usage

The Pod `spec.overhead` field is read-only after admission — it cannot be modified by users.

```
Effective Pod Resource = spec.overhead + sum(container.requests)
```

## Configuring RuntimeClass with Overhead

### Kata Containers RuntimeClass

Kata Containers creates a lightweight QEMU/KVM virtual machine per Pod. The overhead includes the VM kernel, the kata-agent process, and the QEMU process itself:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu
handler: kata-qemu
overhead:
  podFixed:
    # Kata QEMU VM kernel + agent overhead
    # Measured on c5.4xlarge with kata-containers 3.x:
    # kernel: 128MB, agent: 48MB, qemu: 80MB = ~256MB total
    memory: "256Mi"
    # QEMU process + VM overhead CPU cost
    # Measured at ~50m steady state, 200m during sandbox startup
    cpu: "50m"
scheduling:
  nodeClassification:
    nodeSelector:
      # Kata requires hardware virtualization support
      katacontainers.io/kata-runtime: "true"
    tolerations:
    - key: "kata-containers"
      operator: "Exists"
      effect: "NoSchedule"
```

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-fc  # Firecracker-based Kata (lower overhead, faster startup)
handler: kata-fc
overhead:
  podFixed:
    # Firecracker has lower overhead than QEMU
    # kernel: 64MB, agent: 24MB, firecracker process: 32MB = ~128MB
    memory: "128Mi"
    cpu: "25m"
scheduling:
  nodeClassification:
    nodeSelector:
      katacontainers.io/kata-runtime: "true"
      kata-runtime-type: "firecracker"
```

### gVisor RuntimeClass

gVisor (runsc) creates a userspace kernel (Sentry) per Pod. The overhead is lower than Kata but still significant:

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
overhead:
  podFixed:
    # gVisor Sentry (userspace kernel) overhead
    # Measured on n2-standard-4:
    # Sentry process: 64-128MB depending on syscall activity
    # Gofer processes: 8MB per container
    memory: "80Mi"
    cpu: "10m"
scheduling:
  nodeClassification:
    nodeSelector:
      # gVisor requires kernel support on the host
      sandbox: gvisor
```

### Measuring Actual Overhead

Before configuring overhead values, measure the actual resource consumption on target hardware:

```bash
# Deploy a minimal test Pod with the target RuntimeClass
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: overhead-baseline
  namespace: default
spec:
  runtimeClassName: kata-qemu
  containers:
  - name: pause
    image: gcr.io/google-containers/pause:3.9
    resources:
      requests:
        cpu: "0"
        memory: "0"
      limits:
        cpu: "0"
        memory: "0"
EOF

# Wait for Pod to be running
kubectl wait pod/overhead-baseline --for=condition=Ready --timeout=120s

# Measure actual memory consumption of all processes associated with the Pod
# Find the container cgroup
CGROUP=$(cat /proc/$(pgrep -f "kata-shim.*overhead-baseline")/cgroup | \
  grep memory | cut -d: -f3)

# Read memory usage from cgroup
cat /sys/fs/cgroup/memory/${CGROUP}/memory.usage_in_bytes

# Alternatively, use cadvisor metrics
curl -s "http://localhost:4194/api/v1.3/containers/kubepods" | \
  jq '.subcontainers[] | select(.name | contains("overhead-baseline")) | .stats[-1].memory.usage'
```

### Verifying Overhead Injection

After deploying a Pod with a RuntimeClass that has overhead configured:

```bash
# Deploy a test Pod
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: sandboxed-app
  namespace: production
spec:
  runtimeClassName: kata-qemu
  containers:
  - name: app
    image: nginx:1.25
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "1"
        memory: "1Gi"
EOF

# Inspect the injected overhead
kubectl get pod sandboxed-app -n production \
  -o jsonpath='{.spec.overhead}' | python3 -m json.tool
# Output:
# {
#   "cpu": "50m",
#   "memory": "256Mi"
# }

# Effective resource request = container + overhead
# CPU: 500m + 50m = 550m
# Memory: 512Mi + 256Mi = 768Mi

# Confirm in scheduler events
kubectl describe pod sandboxed-app -n production | grep -A5 "Overhead"
```

## Resource Accounting in Practice

### Impact on Node Capacity

Understand how overhead affects schedulable capacity:

```bash
# Check a node's allocatable resources
kubectl get node node-kata-01 \
  -o jsonpath='{.status.allocatable}' | python3 -m json.tool
# {
#   "cpu": "15800m",
#   "memory": "61724Mi",
#   "pods": "110"
# }

# With kata-qemu overhead (256Mi + 50m per Pod):
# If all 110 pods are sandboxed with kata-qemu:
# Overhead memory: 110 * 256Mi = 28,160Mi (28 GB!)
# Overhead CPU: 110 * 50m = 5,500m

# Effective usable capacity for containers:
# CPU: 15,800m - 5,500m = 10,300m
# Memory: 61,724Mi - 28,160Mi = 33,564Mi
```

### Capacity Planning Formulas

```python
#!/usr/bin/env python3
"""
Kubernetes node capacity planning with Pod overhead
"""

def calculate_effective_capacity(
    node_allocatable_cpu_m: int,    # in millicores
    node_allocatable_memory_mi: int, # in MiB
    max_pods: int,
    overhead_cpu_m: int,            # per-pod overhead in millicores
    overhead_memory_mi: int,        # per-pod overhead in MiB
    avg_container_cpu_m: int,
    avg_container_memory_mi: int,
) -> dict:
    """Calculate effective capacity after accounting for Pod overhead."""

    # Maximum pods limited by both resource and pod count constraints
    pods_by_cpu = (node_allocatable_cpu_m) // (avg_container_cpu_m + overhead_cpu_m)
    pods_by_memory = (node_allocatable_memory_mi) // (avg_container_memory_mi + overhead_memory_mi)
    pods_by_limit = max_pods

    effective_max_pods = min(pods_by_cpu, pods_by_memory, pods_by_limit)

    # Calculate overhead consumed at effective pod count
    total_overhead_cpu_m = effective_max_pods * overhead_cpu_m
    total_overhead_memory_mi = effective_max_pods * overhead_memory_mi

    return {
        "effective_max_pods": effective_max_pods,
        "overhead_cpu_m": total_overhead_cpu_m,
        "overhead_memory_mi": total_overhead_memory_mi,
        "usable_cpu_m": node_allocatable_cpu_m - total_overhead_cpu_m,
        "usable_memory_mi": node_allocatable_memory_mi - total_overhead_memory_mi,
        "overhead_cpu_pct": (total_overhead_cpu_m / node_allocatable_cpu_m) * 100,
        "overhead_memory_pct": (total_overhead_memory_mi / node_allocatable_memory_mi) * 100,
    }


# Example: c5.4xlarge (16 vCPU, 32GB) with kata-qemu
result = calculate_effective_capacity(
    node_allocatable_cpu_m=15800,
    node_allocatable_memory_mi=30720,
    max_pods=110,
    overhead_cpu_m=50,
    overhead_memory_mi=256,
    avg_container_cpu_m=500,
    avg_container_memory_mi=512,
)

print(f"Effective max pods: {result['effective_max_pods']}")
print(f"Overhead CPU: {result['overhead_cpu_m']}m ({result['overhead_cpu_pct']:.1f}%)")
print(f"Overhead memory: {result['overhead_memory_mi']}Mi ({result['overhead_memory_pct']:.1f}%)")
print(f"Usable CPU: {result['usable_cpu_m']}m")
print(f"Usable memory: {result['usable_memory_mi']}Mi")
```

### ResourceQuota with Overhead

ResourceQuota respects Pod overhead. When calculating quota consumption, Kubernetes adds `spec.overhead` to each container's request:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: sandboxed-workloads
  namespace: secure-tenants
spec:
  hard:
    # This quota accounts for overhead
    # 20 Pods * (512Mi container + 256Mi kata overhead) = 15,360Mi
    requests.memory: "15360Mi"
    requests.cpu: "12"
    count/pods: "20"
```

```bash
# Verify quota consumption includes overhead
kubectl describe quota sandboxed-workloads -n secure-tenants
# Name:            sandboxed-workloads
# Resource         Used    Hard
# --------         ----    ----
# count/pods       5       20
# requests.cpu     2750m   12     (5 pods * 500m container + 50m overhead = 2750m)
# requests.memory  3840Mi  15360Mi (5 pods * 512Mi + 256Mi overhead = 3840Mi)
```

## VPA Integration with Pod Overhead

### VPA Recommendations Must Account for Overhead

Vertical Pod Autoscaler recommends container-level resources, not total Pod resources. When VPA adjusts container requests, the total Pod request changes, but the overhead remains fixed. This interaction needs careful configuration:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: sandboxed-api-vpa
  namespace: secure-tenants
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: sandboxed-api
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: api
      # VPA only controls container resources
      # Overhead (256Mi, 50m) is ADDED ON TOP of these bounds
      minAllowed:
        cpu: "100m"
        memory: "256Mi"
      maxAllowed:
        # With 256Mi overhead, max effective Pod = 4Gi + 256Mi = 4.25Gi
        cpu: "4"
        memory: "4Gi"
      controlledValues: RequestsAndLimits
      # Prevent VPA from setting requests so low that overhead dominates
      # E.g., 10Mi container + 256Mi overhead = 96% overhead
```

### Monitoring VPA Recommendations vs Actual

```yaml
# PrometheusRule to track overhead ratio
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: pod-overhead-analysis
  namespace: monitoring
spec:
  groups:
  - name: pod-overhead.rules
    rules:
    - record: pod:overhead_memory_ratio:gauge
      expr: |
        kube_pod_overhead_memory_bytes /
        (kube_pod_overhead_memory_bytes + kube_pod_container_resource_requests{resource="memory"})
    - alert: HighOverheadRatio
      expr: |
        pod:overhead_memory_ratio:gauge > 0.5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Pod {{ $labels.pod }} has >50% memory overhead ratio"
        description: >
          Pod {{ $labels.namespace }}/{{ $labels.pod }} has overhead
          consuming more than 50% of total memory request. Consider
          increasing container memory requests or using a lower-overhead
          runtime class for small workloads.
```

## Multi-Runtime Cluster Architecture

### Node Pool Design for Mixed Runtimes

In a cluster with both standard runc and sandboxed runtimes, isolate runtime types into node pools:

```
┌─────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                   │
│                                                       │
│  ┌─────────────────┐  ┌────────────────────────────┐ │
│  │  runc Node Pool │  │  Kata/gVisor Node Pool     │ │
│  │                 │  │                            │ │
│  │  • Trusted      │  │  • Multi-tenant workloads  │ │
│  │    workloads    │  │  • Untrusted code          │ │
│  │  • Internal     │  │  • User-submitted jobs     │ │
│  │    services     │  │  • CI/CD runners           │ │
│  │                 │  │                            │ │
│  │  No overhead    │  │  Overhead: 128-256Mi/Pod   │ │
│  └─────────────────┘  └────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

```yaml
# Taint kata nodes to prevent standard workloads from scheduling there
# kubectl taint nodes kata-node-01 runtime=kata:NoSchedule

# runc workload (default behavior)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: internal-api
  namespace: production
spec:
  template:
    spec:
      # No runtimeClassName = uses default runc
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: runtime-pool
                operator: In
                values:
                - standard
---
# Sandboxed workload for untrusted code
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-code-runner
  namespace: sandboxed-tenant
spec:
  template:
    spec:
      runtimeClassName: kata-fc
      tolerations:
      - key: "runtime"
        operator: "Equal"
        value: "kata"
        effect: "NoSchedule"
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: runtime-pool
                operator: In
                values:
                - sandboxed
      containers:
      - name: runner
        image: code-runner:v1.8.0
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
```

### RuntimeClass Selection via Admission Webhook

Automatically assign RuntimeClass based on namespace labels without requiring workload authors to specify it:

```go
package webhook

import (
    "context"
    "encoding/json"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

type RuntimeClassMutator struct {
    client kubernetes.Interface
}

func (m *RuntimeClassMutator) Handle(ctx context.Context, req admissionv1.AdmissionRequest) admissionv1.AdmissionResponse {
    pod := &corev1.Pod{}
    if err := json.Unmarshal(req.Object.Raw, pod); err != nil {
        return admissionv1.AdmissionResponse{Allowed: false}
    }

    // Skip if RuntimeClass already set
    if pod.Spec.RuntimeClassName != nil && *pod.Spec.RuntimeClassName != "" {
        return admissionv1.AdmissionResponse{Allowed: true}
    }

    // Look up namespace security level
    ns, err := m.client.CoreV1().Namespaces().Get(ctx, req.Namespace, metav1.GetOptions{})
    if err != nil {
        return admissionv1.AdmissionResponse{Allowed: true} // Fail open
    }

    runtimeClass := ""
    switch ns.Labels["security-level"] {
    case "sandboxed":
        runtimeClass = "kata-fc"
    case "high-isolation":
        runtimeClass = "kata-qemu"
    case "gvisor":
        runtimeClass = "gvisor"
    default:
        return admissionv1.AdmissionResponse{Allowed: true}
    }

    patch := []map[string]interface{}{
        {
            "op":    "add",
            "path":  "/spec/runtimeClassName",
            "value": runtimeClass,
        },
    }

    patchBytes, _ := json.Marshal(patch)
    patchType := admissionv1.PatchTypeJSONPatch

    return admissionv1.AdmissionResponse{
        Allowed:   true,
        Patch:     patchBytes,
        PatchType: &patchType,
    }
}
```

## Observability for Pod Overhead

### kube-state-metrics Overhead Metrics

```promql
# Total overhead memory consumed by namespace
sum by (namespace) (
  kube_pod_overhead_memory_bytes
)

# Overhead as percentage of total pod request
sum by (namespace) (kube_pod_overhead_memory_bytes) /
sum by (namespace) (
  kube_pod_overhead_memory_bytes +
  kube_pod_container_resource_requests{resource="memory"}
) * 100

# Node capacity consumed by overhead
sum by (node) (kube_pod_overhead_memory_bytes) /
  kube_node_status_allocatable{resource="memory"} * 100

# Per RuntimeClass overhead summary
sum by (runtime_class_name) (kube_pod_overhead_memory_bytes)
```

### Grafana Dashboard Configuration

```yaml
# grafana-dashboard-pod-overhead.yaml
# Import this as a JSON model in Grafana

panels:
  - title: "Pod Overhead by RuntimeClass"
    type: piechart
    targets:
    - expr: "sum by (runtime_class_name) (kube_pod_overhead_memory_bytes / 1024 / 1024)"
      legendFormat: "{{ runtime_class_name }}"

  - title: "Overhead Efficiency Ratio by Namespace"
    type: bargauge
    targets:
    - expr: |
        sum by (namespace) (kube_pod_overhead_memory_bytes) /
        sum by (namespace) (
          kube_pod_overhead_memory_bytes +
          kube_pod_container_resource_requests{resource="memory"}
        ) * 100
      legendFormat: "{{ namespace }}"

  - title: "Node Capacity Used by Overhead"
    type: timeseries
    targets:
    - expr: |
        sum by (node) (kube_pod_overhead_memory_bytes) /
        kube_node_status_allocatable{resource="memory"} * 100
      legendFormat: "{{ node }}"
```

### Capacity Planning Dashboard Queries

```promql
# Projected node saturation with overhead
# How many more Pods can fit considering overhead?
(
  kube_node_status_allocatable{resource="memory"}
  - sum by (node) (kube_pod_container_resource_requests{resource="memory"})
  - sum by (node) (kube_pod_overhead_memory_bytes)
) / (512 * 1024 * 1024)  # Assuming 512Mi average container request

# Current overhead waste on underutilized sandboxed Pods
# (Pods with overhead > actual memory usage)
kube_pod_overhead_memory_bytes > on(pod, namespace) (
  container_memory_working_set_bytes{container!=""} * 2
)
```

## Troubleshooting Overhead Configuration

### Pod Stuck Pending Due to Overhead

```bash
# Check if overhead is preventing scheduling
kubectl describe pod sandboxed-pod -n production | grep -A20 "Events:"
# Look for: "Insufficient memory" or "0/N nodes are available"

# Check effective resource request including overhead
kubectl get pod sandboxed-pod -n production -o json | \
  jq '{
    overhead: .spec.overhead,
    containerRequests: [.spec.containers[].resources.requests],
    effectiveCPU: (
      (.spec.overhead.cpu // "0") + " (overhead) + " +
      (.spec.containers[0].resources.requests.cpu // "0") + " (container)"
    ),
    effectiveMemory: (
      (.spec.overhead.memory // "0") + " (overhead) + " +
      (.spec.containers[0].resources.requests.memory // "0") + " (container)"
    )
  }'

# Check node capacity
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,ALLOCATABLE-CPU:.status.allocatable.cpu,ALLOCATABLE-MEM:.status.allocatable.memory'

# Compare with current usage including overhead
kubectl top nodes
```

### Verifying RuntimeClass Overhead Injection

```bash
# Verify the RuntimeClass has overhead configured
kubectl get runtimeclass kata-qemu -o yaml | grep -A5 "overhead"

# Verify Pod spec has overhead injected after creation
kubectl get pod -l runtimeClassName=kata-qemu -A \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,OVERHEAD-CPU:.spec.overhead.cpu,OVERHEAD-MEM:.spec.overhead.memory'

# Check if webhook is injecting correctly
kubectl get mutatingwebhookconfigurations | grep runtime

# Validate ResourceQuota usage includes overhead
kubectl describe quota -n secure-tenants
```

### Measuring Overhead Accuracy

Compare declared overhead with actual process consumption:

```bash
#!/bin/bash
# measure-kata-overhead.sh
# Measures actual resource consumption of kata-qemu overhead

POD_NAME=${1:-overhead-test}
NAMESPACE=${2:-default}

# Get the VM process name for this pod
VM_PID=$(pgrep -f "qemu.*${POD_NAME}" | head -1)

if [ -z "$VM_PID" ]; then
    echo "No kata QEMU process found for pod ${POD_NAME}"
    exit 1
fi

# Get RSS memory usage
RSS_KB=$(cat /proc/${VM_PID}/status | grep VmRSS | awk '{print $2}')
RSS_MB=$(echo "scale=1; ${RSS_KB} / 1024" | bc)

# Get CPU time
CPU_USER=$(cat /proc/${VM_PID}/stat | awk '{print $14}')
CPU_SYS=$(cat /proc/${VM_PID}/stat | awk '{print $15}')
CPU_TOTAL=$((CPU_USER + CPU_SYS))

echo "Pod: ${POD_NAME}"
echo "QEMU PID: ${VM_PID}"
echo "RSS Memory: ${RSS_MB} MB"
echo "CPU jiffies (user+sys): ${CPU_TOTAL}"
echo ""
echo "Recommended overhead.memory: $(echo "scale=0; (${RSS_MB} * 1.2 + 0.5) / 1" | bc)Mi"
```

## Best Practices Summary

**Measure before configuring**: Collect real measurements from target hardware rather than using published overhead values. QEMU performance varies significantly between CPU types and hypervisor configurations.

**Add 20% headroom to overhead values**: Measured overhead represents steady-state. During Pod startup, kata overhead spikes higher. The extra margin prevents transient scheduling failures.

**Size node pools for overhead**: When planning node autoscaling, include overhead in capacity calculations. A 64-node cluster with 256Mi overhead per Pod at 110 Pods/node has 1.8 TB of overhead memory consumption at full saturation.

**Monitor overhead ratio by namespace**: High overhead ratios (>40%) indicate workloads are too small for the sandbox overhead. Either increase container resource requests or use a lower-overhead runtime (gVisor vs Kata).

**Test VPA interaction**: VPA can reduce container requests below the point where overhead dominates. Configure `minAllowed` in VPA to ensure overhead never exceeds 30% of total Pod request.

**Separate node pools**: Mixing runc and kata workloads on the same nodes complicates capacity planning and may cause scheduling inefficiency. Dedicated node pools for each runtime class simplify management.
