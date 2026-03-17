---
title: "NUMA Topology in Kubernetes: CPU Manager, Memory Manager, and Topology Manager for Latency-Sensitive Workloads"
date: 2028-06-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NUMA", "CPU Manager", "Performance", "Linux", "GPU", "HPC"]
categories: ["Kubernetes", "Performance Engineering", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive guide to NUMA topology management in Kubernetes: CPU Manager static policy for exclusive CPU allocation, NUMA-aware scheduling, Memory Manager for NUMA-local memory, Topology Manager policies, and GPU NUMA alignment for AI/ML workloads."
more_link: "yes"
url: "/linux-numa-topology-kubernetes/"
---

Non-Uniform Memory Access (NUMA) topology is the performance reality of modern multi-socket and many-core servers. When a CPU accesses memory local to its NUMA node, latency is 60-80ns; when it accesses memory on a remote NUMA node, latency jumps to 120-160ns — a 2-3x penalty that accumulates when thousands of memory accesses occur per microsecond. For high-performance applications (real-time databases, low-latency trading systems, AI inference, scientific computing), NUMA-aware scheduling is the difference between meeting SLAs and missing them. This guide covers the complete Kubernetes NUMA management stack: CPU Manager static policy, Memory Manager, Topology Manager, and GPU NUMA alignment.

<!--more-->

## Understanding NUMA Architecture

A NUMA system organizes CPUs and memory into nodes. Each CPU has direct (fast) access to memory attached to its node, and indirect (slow) access to memory on other nodes via interconnect (QPI, UPI, Infinity Fabric).

```bash
# Inspect NUMA topology on a Linux host
numactl --hardware

# Example output for a 2-socket server:
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 24 25 26 27 28 29 30 31 32 33 34 35
# node 0 size: 96656 MB
# node 0 free: 78234 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 36 37 38 39 40 41 42 43 44 45 46 47
# node 1 size: 98304 MB
# node 1 free: 76891 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10
```

The distance matrix shows relative access costs: 10 = local access, 21 = remote access (2.1x slower).

```bash
# Check NUMA topology in detail
lscpu | grep -E 'Socket|NUMA|Core'

# View NUMA-aware memory allocation
numastat

# View per-process NUMA statistics
numastat -p $(pgrep postgres)
```

## NUMA Impact on Application Performance

For a database processing 1 million queries/second with 1000 memory accesses per query:

```
1,000,000 queries/sec * 1,000 accesses * 80ns (local)  = 80 seconds of memory latency/second
1,000,000 queries/sec * 1,000 accesses * 160ns (remote) = 160 seconds of memory latency/second

Cross-NUMA memory penalty: 80 additional seconds of latency per second of wall time
= 80 additional CPU cores needed to compensate
```

This is why NUMA misalignment causes throughput degradation disproportionate to its apparent cost.

## Kubernetes CPU Manager

The CPU Manager allows Kubernetes to exclusively allocate specific CPU cores to containers, preventing CPU sharing and NUMA crossings.

### CPU Manager Policies

**None policy (default)**: Containers share all CPUs on the node. The CFS scheduler handles CPU time allocation. No NUMA awareness.

**Static policy**: Containers with integer CPU requests get exclusive, dedicated CPUs. The kubelet assigns CPUs from the same NUMA node when possible.

### Configuring CPU Manager Static Policy

CPU Manager is configured on the kubelet, not via API objects. Modify the kubelet configuration:

```yaml
# /etc/kubernetes/kubelet-config.yaml (or via kubeadm configuration)
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 10s

# Reserve CPUs for system and kubelet use (not available for containers)
reservedSystemCPUs: "0,1,24,25"  # Reserve specific CPUs
# Or use resource reservation:
# systemReserved:
#   cpu: "2"
# kubeReservedCPUs: "2"
```

For kubeadm-managed clusters:

```yaml
# In kubeadm ClusterConfiguration or as a patch
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
nodeRegistration:
  kubeletExtraArgs:
    cpu-manager-policy: "static"
    reserved-cpus: "0,1"
```

### State File Location

The CPU Manager persists its state to disk:

```bash
# CPU Manager state file
cat /var/lib/kubelet/cpu_manager_state

# Example output:
{
  "policyName": "static",
  "defaultCpuSet": "2-23,26-47",
  "entries": {
    "pod-uid-abc123": {
      "container-name": "9-15,33-39"
    }
  },
  "checksum": 12345678
}
```

### Pod Requirements for Exclusive CPU Allocation

A pod must meet three conditions to receive exclusive CPU allocation:

1. **QoS class must be Guaranteed**: requests == limits for all resources
2. **CPU request must be an integer**: `cpu: "4"` not `cpu: "4.5"` or `cpu: "4000m"`
3. **CPU Manager static policy must be enabled on the node**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: latency-critical-db
  namespace: production
spec:
  containers:
    - name: database
      image: postgres:16.2
      resources:
        requests:
          cpu: "8"        # Integer: will get 8 exclusive CPUs
          memory: "16Gi"  # Requests = limits = Guaranteed QoS
        limits:
          cpu: "8"
          memory: "16Gi"
```

Non-integer CPU requests still work but use the shared pool:

```yaml
resources:
  requests:
    cpu: "500m"   # Fractional: uses shared pool, no exclusive allocation
  limits:
    cpu: "500m"
```

### Verifying CPU Allocation

```bash
# Check which CPUs a pod has been assigned
kubectl exec -it latency-critical-db -- \
  taskset -cp $(cat /proc/1/status | grep Pid | head -1 | awk '{print $2}')

# Expected output (exclusive allocation):
# pid 1's current affinity list: 2-9

# Without exclusive allocation (uses all CPUs):
# pid 1's current affinity list: 0-47
```

```bash
# Node-level verification
# Check the CPU Manager state file
ssh worker-node-1 cat /var/lib/kubelet/cpu_manager_state | jq .
```

## Memory Manager

The Memory Manager (stable in Kubernetes 1.22+) provides NUMA-aware memory allocation for containers. It works alongside the CPU Manager to ensure both CPU and memory are allocated from the same NUMA node.

### Configuring Memory Manager

```yaml
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
memoryManagerPolicy: Static

# Reserve memory for system use
reservedMemory:
  - numaNode: 0
    limits:
      memory: "2Gi"
  - numaNode: 1
    limits:
      memory: "2Gi"
```

### Pod Configuration for NUMA-Local Memory

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: numa-optimized-workload
  namespace: production
spec:
  containers:
    - name: app
      image: your-latency-sensitive-app:v1.0
      resources:
        requests:
          cpu: "8"
          memory: "16Gi"
          hugepages-1Gi: "8Gi"   # Hugepages are always NUMA-local
        limits:
          cpu: "8"
          memory: "16Gi"
          hugepages-1Gi: "8Gi"
```

### Hugepages Configuration

Hugepages eliminate TLB pressure and are inherently NUMA-aware:

```bash
# Check available hugepages per NUMA node
cat /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
cat /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages

# Allocate hugepages at boot (add to /etc/default/grub or grub2-mkconfig)
GRUB_CMDLINE_LINUX="... hugepages=16 hugepagesz=1G"

# Or allocate at runtime (before memory is fragmented)
echo 16 > /sys/kernel/mm/hugepages/hugepages-1048576kB/nr_hugepages

# Node-level NUMA allocation
echo 8 > /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
echo 8 > /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages
```

Node configuration for hugepages:

```yaml
# Node capacity is auto-detected from the kernel
# Verify:
kubectl describe node worker-node-1 | grep -i hugepage

# Capacity:
#   hugepages-1Gi:  16Gi
#   hugepages-2Mi:  0
```

## Topology Manager

The Topology Manager is the orchestrator that coordinates CPU Manager, Memory Manager, and device plugins (GPUs, NICs, FPGAs) to ensure all resources for a container come from the same NUMA node.

### Topology Manager Policies

**None (default)**: No NUMA alignment. Resources are allocated independently.

**Best-effort**: Attempt to align resources to a single NUMA node. If impossible, schedule anyway without alignment.

**Restricted**: Align resources to a single NUMA node. If impossible, reject the pod.

**Single-NUMA-node**: All resources must come from a single NUMA node. Strictest policy.

```yaml
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: single-numa-node   # or: best-effort, restricted, none
topologyManagerScope: container           # or: pod (align all containers to same NUMA)

cpuManagerPolicy: static
memoryManagerPolicy: Static
```

### Policy Comparison

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `none` | No alignment; default behavior | General workloads |
| `best-effort` | Align if possible; schedule regardless | Non-critical latency workloads |
| `restricted` | Align if possible; reject if impossible but can be satisfied on another node | Important latency workloads |
| `single-numa-node` | All resources from one NUMA node; reject otherwise | Latency-critical, HPC, AI/ML inference |

### Topology Manager Scope

```yaml
# Container scope (default): align per-container independently
topologyManagerScope: container

# Pod scope: all containers in a pod must be on the same NUMA node
topologyManagerScope: pod
```

Pod scope is more conservative and may prevent scheduling on nodes with adequate capacity across NUMA nodes, so use it only when inter-container communication requires NUMA locality.

## GPU NUMA Alignment

GPU workloads are particularly sensitive to NUMA alignment because PCIe topology determines GPU-to-CPU memory transfer speed.

### GPU NUMA Topology

```bash
# Check GPU NUMA affinity
nvidia-smi topo -m

# Example output:
#         GPU0    GPU1    GPU2    GPU3    CPU Affinity
# GPU0     X      NV2     SYS     SYS     0-23
# GPU1    NV2      X      SYS     SYS     0-23
# GPU2    SYS     SYS      X      NV2     24-47
# GPU3    SYS     SYS     NV2      X      24-47

# Legend:
# X    = Self
# NV#  = NVLink connection (fastest GPU-GPU)
# SYS  = PCIe cross-NUMA (slowest)
# CPU Affinity: which CPU cores share NUMA node with this GPU
```

In this topology, GPUs 0-1 are on NUMA node 0 (CPUs 0-23), and GPUs 2-3 are on NUMA node 1 (CPUs 24-47). For optimal GPU workloads, the CPU threads processing GPU data should be on the same NUMA node as the GPU.

### NVIDIA Device Plugin Configuration

```yaml
# nvidia-device-plugin DaemonSet configuration
# Enable NUMA-aware GPU allocation
apiVersion: v1
kind: ConfigMap
metadata:
  name: nvidia-device-plugin-config
  namespace: kube-system
data:
  config.yaml: |
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        renameByDefault: false
    resources:
      - pattern: "*"
        replicas: 1
```

### Pod with GPU NUMA Alignment

For NUMA-aligned GPU workloads, all resources must be from the same NUMA node:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-numa-aligned
  namespace: ai-production
spec:
  containers:
    - name: training-job
      image: nvcr.io/nvidia/pytorch:24.01-py3
      command: ["python", "train.py"]
      resources:
        requests:
          cpu: "16"          # Integer; will allocate 16 CPUs from NUMA node 0
          memory: "64Gi"     # Will allocate from NUMA node 0
          nvidia.com/gpu: "2"  # Will allocate GPUs 0 and 1 (both on NUMA node 0)
        limits:
          cpu: "16"
          memory: "64Gi"
          nvidia.com/gpu: "2"
      env:
        - name: CUDA_VISIBLE_DEVICES
          value: "0,1"  # Will be rewritten by device plugin
        - name: OMP_NUM_THREADS
          value: "16"
        - name: GOMP_CPU_AFFINITY
          value: "0-15"  # Bind to CPUs 0-15 (NUMA node 0)
```

With `topologyManagerPolicy: single-numa-node`, Kubernetes ensures:
- The 16 CPUs come from NUMA node 0
- The 64GB memory comes from NUMA node 0
- The 2 GPUs are GPU 0 and GPU 1 (NUMA node 0-attached)

### Verifying GPU NUMA Alignment

```bash
# Inside the pod
nvidia-smi
# Verify GPU IDs match expected NUMA node

# Check CPU affinity
taskset -cp 1
# Should show CPU range for NUMA node 0

# Check memory NUMA binding
cat /proc/self/numa_maps | head -20
# Each memory region shows which NUMA node it's on
```

## DaemonSet for NUMA Configuration

Apply NUMA-related kernel parameters and hugepages via DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: numa-configuration
  namespace: kube-system
spec:
  selector:
    matchLabels:
      name: numa-configuration
  template:
    metadata:
      labels:
        name: numa-configuration
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists  # Run on all nodes including control plane
      initContainers:
        - name: configure-numa
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              # Disable NUMA balancing (auto-NUMA can cause latency jitter)
              echo 0 > /proc/sys/kernel/numa_balancing

              # Set CPU scheduler to performance mode
              for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
                echo performance > $cpu 2>/dev/null || true
              done

              # Disable THP (huge pages) transparent allocation jitter
              echo never > /sys/kernel/mm/transparent_hugepage/enabled
              echo never > /sys/kernel/mm/transparent_hugepage/defrag

              # Set CPU C-state to C1 max (reduce wake-up latency)
              for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
                state=$(echo $cpu | grep -oP 'state\K[0-9]+')
                if [ "$state" -gt "1" ]; then
                  echo 1 > $cpu 2>/dev/null || true
                fi
              done

              # IRQ affinity: pin IRQs to CPU 0 and 1 (not used by workloads)
              for irq in /proc/irq/*/smp_affinity; do
                echo "3" > $irq 2>/dev/null || true  # CPUs 0-1
              done

              echo "NUMA configuration complete"
          volumeMounts:
            - name: proc
              mountPath: /proc
            - name: sys
              mountPath: /sys
      containers:
        - name: pause
          image: gcr.io/google-containers/pause:3.9
      volumes:
        - name: proc
          hostPath:
            path: /proc
        - name: sys
          hostPath:
            path: /sys
```

## Node Feature Discovery for NUMA-Aware Scheduling

Node Feature Discovery (NFD) detects NUMA topology and other hardware features, making them available as node labels for advanced scheduling:

```bash
# Install NFD
kubectl apply -k https://github.com/kubernetes-sigs/node-feature-discovery/deployment/overlays/default?ref=v0.16.0

# NFD labels added to nodes after discovery
kubectl get node worker-node-1 -o json | jq '.metadata.labels | to_entries[] | select(.key | startswith("feature.node.kubernetes.io/cpu"))'

# Relevant labels:
# feature.node.kubernetes.io/cpu-cpuid.AVX512F=true
# feature.node.kubernetes.io/cpu-hardware_multithreading=true
# feature.node.kubernetes.io/cpu-numa_node_count=2
# feature.node.kubernetes.io/pci-0300_10de.present=true  (NVIDIA GPU)
```

### Scheduling Based on NUMA Topology

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: numa-required-workload
spec:
  nodeSelector:
    # Only schedule on nodes with exactly 2 NUMA nodes
    feature.node.kubernetes.io/cpu-numa_node_count: "2"

  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              # Require AVX-512 for vectorized math operations
              - key: feature.node.kubernetes.io/cpu-cpuid.AVX512F
                operator: Exists
              # Require NUMA node count = 2 (dual socket)
              - key: feature.node.kubernetes.io/cpu-numa_node_count
                operator: In
                values: ["2"]
```

## Monitoring NUMA Performance

### Key Metrics

```bash
# Per-NUMA-node memory usage
cat /sys/devices/system/node/node*/meminfo

# NUMA hit/miss statistics
cat /sys/devices/system/node/node*/numastat
# numa_hit: Memory allocated on this node for processes on this node
# numa_miss: Memory allocated here but for processes on another node
# numa_foreign: Memory intended here but allocated elsewhere
# interleave_hit: Interleaved memory allocated on this node

# Overall NUMA statistics
numastat
```

### Alerting on NUMA Misses

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: numa-performance-alerts
  namespace: monitoring
spec:
  groups:
    - name: numa
      rules:
        - record: node:numa_miss_ratio:rate5m
          expr: |
            rate(node_memory_numa_miss_total[5m])
            /
            (rate(node_memory_numa_hit_total[5m]) + rate(node_memory_numa_miss_total[5m]))

        - alert: HighNUMAMissRatio
          expr: node:numa_miss_ratio:rate5m > 0.20
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High NUMA miss ratio on {{ $labels.instance }}"
            description: "NUMA miss ratio is {{ $value | humanizePercentage }}. Workloads may not be NUMA-aligned."
```

## Production Recommendations

For latency-sensitive workloads requiring NUMA alignment:

1. Configure nodes with `topologyManagerPolicy: single-numa-node` and `topologyManagerScope: container`
2. Enable CPU Manager static policy and Memory Manager static policy
3. Set `topologyManagerScope: pod` only when all containers in a pod must share the same NUMA node
4. Size hugepages per NUMA node equally to allow the scheduler flexibility
5. Reserve 2 CPUs per NUMA node for OS and kubelet use (do not expose to workloads)
6. Use NFD labels to restrict NUMA-sensitive pods to appropriately configured nodes
7. Monitor NUMA miss rates; ratios above 10% indicate alignment issues
8. Test performance improvement with `numactl --cpunodebind=0 --membind=0 <command>` before investing in Kubernetes NUMA configuration

NUMA topology management in Kubernetes is not a default concern — it is specifically for workloads where microsecond latency margins matter. Database query engines, real-time analytics, high-frequency trading systems, and AI inference serving are the primary targets. For these workloads, the configuration overhead pays back in reduced tail latency and higher throughput per CPU core.
