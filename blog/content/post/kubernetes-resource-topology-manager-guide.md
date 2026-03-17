---
title: "Kubernetes Topology Manager: NUMA-Aware Scheduling for Latency-Sensitive Workloads"
date: 2028-12-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NUMA", "Topology Manager", "Performance", "CPU"]
categories:
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Configure the Kubernetes Topology Manager, CPU Manager, and Memory Manager to achieve NUMA-affine pod placement for latency-sensitive and real-time workloads on multi-socket servers."
more_link: "yes"
url: "/kubernetes-resource-topology-manager-guide/"
---

Modern multi-socket servers contain multiple NUMA (Non-Uniform Memory Access) nodes. Memory accesses that cross a NUMA boundary incur a 30–100% latency penalty compared to local accesses. For workloads like telecom user-plane functions, high-frequency trading engines, or real-time signal processing, this penalty is unacceptable. The Kubernetes Topology Manager coordinates the CPU Manager, Device Plugin manager, and Memory Manager to ensure that all resources assigned to a pod come from the same NUMA node.

This guide covers NUMA fundamentals, every Topology Manager policy, configuration of the static CPU Manager, HugePage-aligned memory allocation, Device Plugin NUMA hints, and validation procedures for production latency-sensitive workloads.

<!--more-->

# Kubernetes Topology Manager: NUMA-Aware Scheduling

## Section 1: NUMA Topology Fundamentals

A dual-socket server with 2 NUMA nodes looks like this from the OS perspective:

```
NUMA node 0: CPUs 0-23, 48-71  — 64 GB DDR5
NUMA node 1: CPUs 24-47, 72-95 — 64 GB DDR5
```

Inspect NUMA topology on a node:

```bash
# Install numactl
apt-get install -y numactl

# Show NUMA hardware layout
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71
# node 0 size: 64282 MB
# node 0 free: 58421 MB
# node 1 cpus: 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95
# node 1 size: 64512 MB
# node 1 free: 61024 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# CPU-to-NUMA mapping
lscpu | grep -E "NUMA|node"
# NUMA node(s): 2
# NUMA node0 CPU(s): 0-23,48-71
# NUMA node1 CPU(s): 24-47,72-95

# Cross-NUMA memory latency test
numactl --cpunodebind=0 --membind=1 -- sysbench memory --memory-block-size=1M --memory-total-size=10G run
numactl --cpunodebind=0 --membind=0 -- sysbench memory --memory-block-size=1M --memory-total-size=10G run
```

The NUMA distance matrix shows that node 0 to node 1 access costs 21 units vs. 10 for local — a 2.1x penalty.

## Section 2: Kubelet Feature Gates and Component Enablement

Three kubelet features work together. All are GA as of Kubernetes 1.27.

```
CPU Manager:      controls CPU pinning
Memory Manager:   controls HugePage and regular memory NUMA alignment
Topology Manager: coordinates alignment across all resource managers
```

Kubelet configuration (systemd unit or `/var/lib/kubelet/config.yaml`):

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# CPU Manager
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 10s

# Memory Manager
memoryManagerPolicy: Static
reservedMemory:
  - numaNode: 0
    limits:
      memory: "1Gi"
      hugepages-1Gi: "2Gi"
  - numaNode: 1
    limits:
      memory: "1Gi"
      hugepages-1Gi: "2Gi"

# Topology Manager
topologyManagerPolicy: single-numa-node
topologyManagerScope: pod

# System reservations (required for CPU Manager static policy)
systemReserved:
  cpu: "2"
  memory: "4Gi"
kubeReserved:
  cpu: "1"
  memory: "2Gi"

# Eviction thresholds
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"
```

Verify the kubelet picks up the configuration:

```bash
systemctl daemon-reload
systemctl restart kubelet
journalctl -u kubelet -f | grep -E "topology|cpu.manager|memory.manager"
```

Expected log lines:

```
topology_manager.go: "Making topology affinity decisions"
cpu_manager.go: "Starting static CPU policy"
memory_manager.go: "Starting static memory manager policy"
```

## Section 3: Topology Manager Policies

### 3.1 none (default)

No alignment is enforced. The scheduler and kubelet make no NUMA guarantees.

```yaml
topologyManagerPolicy: none
```

Use this only when workloads are not latency-sensitive.

### 3.2 best-effort

The Topology Manager requests NUMA hints from each resource manager. If all hints agree on a NUMA node, resources are allocated from that node. If hints conflict, the pod is still admitted, with sub-optimal placement.

```yaml
topologyManagerPolicy: best-effort
```

Appropriate for mixed workloads where NUMA alignment is desired but pod admission must never fail due to NUMA constraints.

### 3.3 restricted

Same as `best-effort` but the pod is rejected with `TopologyAffinityError` if aligned allocation is not possible. Resources are released and the pod remains in `Pending` until a NUMA-aligned slot opens.

```yaml
topologyManagerPolicy: restricted
```

### 3.4 single-numa-node

The strictest policy. ALL requested resources — CPUs, memory, devices — must come from the same single NUMA node. If that is not possible, the pod is rejected.

```yaml
topologyManagerPolicy: single-numa-node
```

Recommended for real-time user-plane functions (5G UPF, DPDK applications) and latency-critical HPC workloads.

### 3.5 Topology Manager Scope

```yaml
# pod scope: all containers in the pod must collectively fit on one NUMA node
topologyManagerScope: pod

# container scope: each container independently requests NUMA alignment
topologyManagerScope: container
```

Use `pod` scope for applications where all containers share a logical processing unit (e.g., sidecar + main container in a 5G pod).

## Section 4: CPU Manager Static Policy

The CPU Manager static policy assigns dedicated (exclusive) CPUs to Guaranteed-QoS pods that request integer CPU quantities.

**Requirements for CPU pinning:**
1. Pod QoS must be Guaranteed (`requests == limits`).
2. CPU request must be an integer (not `500m`).
3. `cpuManagerPolicy: static` in kubelet config.

```yaml
# A pod that will receive dedicated CPUs on NUMA node 0
apiVersion: v1
kind: Pod
metadata:
  name: latency-critical-app
  namespace: production
spec:
  runtimeClassName: runc  # must not be virtual/emulated
  containers:
    - name: app
      image: ghcr.io/example/upf:v2.1.0
      resources:
        requests:
          cpu: "8"
          memory: "16Gi"
          hugepages-1Gi: "8Gi"
        limits:
          cpu: "8"
          memory: "16Gi"
          hugepages-1Gi: "8Gi"
```

Verify CPU pinning after scheduling:

```bash
POD_ID=$(crictl pods --name latency-critical-app -q)
CONTAINER_ID=$(crictl ps --pod $POD_ID -q)

# Retrieve cpuset from cgroup
CGPATH=$(crictl inspect $CONTAINER_ID | jq -r '.info.runtimeSpec.linux.cgroupsPath')
cat /sys/fs/cgroup/cpuset/${CGPATH}/cpuset.cpus
# Expected output: 0-7  (8 dedicated CPUs from NUMA node 0)

# Verify NUMA node
numactl --show --cpunodebind=$(cat /sys/fs/cgroup/cpuset/${CGPATH}/cpuset.cpus | cut -d- -f1)
```

Check the CPU Manager state file to see current allocations:

```bash
cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool
```

Output:

```json
{
  "policyName": "static",
  "defaultCpuSet": "8-23,48-71",
  "entries": {
    "latency-critical-app_production_abc123": {
      "app": "0-7"
    }
  },
  "checksum": 3948201234
}
```

## Section 5: Memory Manager for HugePage NUMA Alignment

HugePages (1 GB or 2 MB) are pre-allocated per NUMA node. The Memory Manager static policy ensures a pod's HugePage allocation comes from one NUMA node.

Pre-allocate HugePages at boot:

```bash
# /etc/default/grub - add to GRUB_CMDLINE_LINUX
# default_hugepagesz=1G hugepagesz=1G hugepages=16

update-grub
reboot

# Verify after reboot
cat /proc/meminfo | grep Huge
# HugePages_Total:      16
# HugePages_Free:       16
# Hugepagesize:         1048576 kB

# Per-NUMA HugePage allocation
cat /sys/devices/system/node/node0/hugepages/hugepages-1048576kB/nr_hugepages
cat /sys/devices/system/node/node1/hugepages/hugepages-1048576kB/nr_hugepages
```

Reserved memory must account for NUMA-local HugePages in kubelet config:

```yaml
reservedMemory:
  - numaNode: 0
    limits:
      memory: "1Gi"
      hugepages-1Gi: "8Gi"   # 8 x 1GiB pages reserved on NUMA 0
  - numaNode: 1
    limits:
      memory: "1Gi"
      hugepages-1Gi: "8Gi"   # 8 x 1GiB pages reserved on NUMA 1
```

Pod requesting NUMA-aligned HugePages:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: dpdk-app
  namespace: telecom
spec:
  containers:
    - name: dpdk
      image: ghcr.io/example/dpdk-app:v22.11
      resources:
        requests:
          cpu: "4"
          memory: "4Gi"
          hugepages-1Gi: "4Gi"
        limits:
          cpu: "4"
          memory: "4Gi"
          hugepages-1Gi: "4Gi"
      volumeMounts:
        - mountPath: /dev/hugepages
          name: hugepage
  volumes:
    - name: hugepage
      emptyDir:
        medium: HugePages-1Gi
```

## Section 6: Device Plugin NUMA Affinity Hints

Device Plugins that support NUMA awareness return `TopologyInfo` in `AllocateResponse`. For example, the NVIDIA GPU Device Plugin returns the NUMA node associated with each GPU.

Inspect GPU NUMA affinity:

```bash
# Which NUMA node is GPU 0 on?
cat /sys/bus/pci/devices/$(nvidia-smi --query-gpu=pci.bus_id --format=csv,noheader | head -1 | tr '[:upper:]' '[:lower:]' | sed 's/0000://')/numa_node
# 0  <- GPU 0 is on NUMA node 0
```

When a pod requests both CPUs and a GPU, the Topology Manager checks that the GPU's NUMA affinity hint (node 0) and the available CPU NUMA affinity (node 0) match before admitting the pod.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-training
  namespace: ml
spec:
  containers:
    - name: trainer
      image: nvcr.io/nvidia/pytorch:24.01-py3
      resources:
        requests:
          cpu: "8"
          memory: "32Gi"
          nvidia.com/gpu: "1"
        limits:
          cpu: "8"
          memory: "32Gi"
          nvidia.com/gpu: "1"
```

With `topologyManagerPolicy: single-numa-node`, this pod will only be scheduled if 8 CPUs AND 1 GPU from the same NUMA node are available simultaneously.

## Section 7: SR-IOV Network Device Plugin

The SR-IOV Network Device Plugin also provides NUMA hints. This is critical for DPDK network functions where the NIC must be on the same NUMA node as the CPU cores processing packets.

```bash
# Find which NUMA node an SR-IOV VF is on
cat /sys/class/net/ens3f0v0/device/numa_node
# 0

# Verify PF/VF NUMA mapping
for dev in /sys/class/net/*/device/numa_node; do
  echo "$dev: $(cat $dev)"
done
```

SR-IOV Device Plugin config (`sriovdp-config.yaml`):

```yaml
resourceList:
  - resourceName: intel_sriov_netdevice
    selectors:
      vendors: ["8086"]
      devices: ["154c"]
      drivers: ["iavf"]
      pfNames: ["ens3f0"]
    isRdma: false
```

The device plugin reads the NUMA node from sysfs and returns it as a `TopologyInfo` hint. With Topology Manager `single-numa-node`, a pod requesting an SR-IOV VF, CPUs, and HugePages will only be admitted if all three come from the same NUMA node.

## Section 8: Validating NUMA Affinity

After scheduling a latency-sensitive pod, validate affinity:

```bash
#!/bin/bash
# validate-numa.sh
POD_NAME=$1
NAMESPACE=${2:-default}

# Get container ID
POD_UID=$(kubectl get pod $POD_NAME -n $NAMESPACE -o jsonpath='{.metadata.uid}')
CONTAINER_ID=$(crictl ps | awk -v uid="$POD_UID" '$0 ~ uid {print $1}' | head -1)

echo "=== CPU Affinity ==="
CGROUP=$(crictl inspect $CONTAINER_ID | jq -r '.info.runtimeSpec.linux.cgroupsPath')
CPUSET=$(cat /sys/fs/cgroup/cpuset/${CGROUP}/cpuset.cpus 2>/dev/null || \
         cat /sys/fs/cgroup/${CGROUP}/cpuset.cpus.effective 2>/dev/null)
echo "CPUs: $CPUSET"

# Determine NUMA node from first CPU
FIRST_CPU=$(echo $CPUSET | cut -d, -f1 | cut -d- -f1)
NUMA_NODE=$(cat /sys/devices/system/cpu/cpu${FIRST_CPU}/topology/physical_package_id 2>/dev/null || \
            numactl --hardware | awk "/node .* cpus:.*\b${FIRST_CPU}\b/{print NR; exit}")
echo "NUMA node from CPUs: $NUMA_NODE"

echo ""
echo "=== Memory/HugePage NUMA node ==="
cat /sys/fs/cgroup/memory/${CGROUP}/memory.numa_stat 2>/dev/null | head -5

echo ""
echo "=== Process NUMA binding (from inside pod) ==="
PID=$(crictl inspect $CONTAINER_ID | jq -r '.info.pid')
cat /proc/${PID}/numa_maps | head -10

echo ""
echo "=== numastat for process ==="
numastat -p $(ls /proc/${PID}/task/)
```

```bash
chmod +x validate-numa.sh
./validate-numa.sh dpdk-app telecom
```

Expected output for a correctly aligned pod:

```
=== CPU Affinity ===
CPUs: 0-7
NUMA node from CPUs: 0

=== Memory/HugePage NUMA node ===
total=2097152 N0=2097152 N1=0

=== numastat for process ===
                          dpdk-app
                 Node 0   Node 1
                -------- --------
Numa_Hit         2097152        0
Numa_Miss              0        0
Local_Node       2097152        0
Other_Node             0        0
```

All memory hits are on Node 0, confirming full NUMA alignment.

## Section 9: Troubleshooting NUMA Allocation Failures

### TopologyAffinityError

The pod remains in Pending with event:

```
Warning  TopologyAffinityError  kubelet  Resources cannot be allocated with Topology locality
```

**Diagnoses:**

```bash
# Check available CPU allocations per NUMA node
cat /var/lib/kubelet/cpu_manager_state | python3 -m json.tool

# Check Memory Manager state
cat /var/lib/kubelet/memory_manager_state | python3 -m json.tool

# List allocatable resources
kubectl describe node <nodename> | grep -A5 "Allocatable:"

# Check topology hints from device plugin logs
kubectl logs -n kube-system -l app=sriov-device-plugin | grep -i "topology\|hint\|numa"
```

**Common root causes:**

1. CPUs are fragmented across NUMA nodes (previous Guaranteed pods used half the CPUs from each node).
2. HugePages on NUMA node 0 exhausted while CPUs are only free on node 1.
3. GPU on NUMA node 1, but remaining CPUs only on NUMA node 0.
4. `topologyManagerPolicy: single-numa-node` but the pod requests more CPUs than exist on any single NUMA node.

### Checking kubelet Topology Manager Decisions

```bash
# Enable debug logging temporarily
systemctl edit kubelet
# Add: Environment="KUBELET_EXTRA_ARGS=--v=4"
systemctl restart kubelet

journalctl -u kubelet | grep -E "topology_manager|TopologyHint|bestHint" | tail -50
```

## Section 10: Real-Time Kernel Configuration

NUMA alignment is only half the picture for real-time workloads. The kernel must also be tuned:

```bash
# Install RT kernel
apt-get install -y linux-image-rt-amd64 linux-headers-rt-amd64

# /etc/default/grub additions
GRUB_CMDLINE_LINUX="isolcpus=0-7 nohz_full=0-7 rcu_nocbs=0-7 \
  default_hugepagesz=1G hugepagesz=1G hugepages=16 \
  intel_iommu=on iommu=pt \
  processor.max_cstate=1 intel_idle.max_cstate=0 \
  mce=off nosoftlockup"

update-grub
reboot

# Verify isolated CPUs
cat /sys/devices/system/cpu/isolated
# 0-7

# Set IRQ affinity away from isolated CPUs
echo "ff0" > /proc/irq/default_smp_affinity  # CPUs 4-11 only for IRQs
```

The Topology Manager, isolated CPUs, and real-time kernel together achieve deterministic sub-microsecond packet processing latencies required by 5G radio access network user-plane functions.

## Section 11: NodeFeatureDiscovery Integration

Use Node Feature Discovery (NFD) to label nodes with NUMA topology information automatically:

```yaml
# nfd-worker-conf.yaml
core:
  labelSources:
    - local
    - pci
    - cpu
    - system

sources:
  cpu:
    attributeBlacklist:
      - "cpuid.AESNI"  # example: suppress specific attributes
  system:
    osReleaseFields:
      - "VERSION_ID"
```

NFD creates labels like:

```
feature.node.kubernetes.io/numa-node-count=2
feature.node.kubernetes.io/cpu-hardware_multithreading=true
feature.node.kubernetes.io/cpu-model.id=85  # Skylake
```

Pod node selector using NFD labels:

```yaml
nodeSelector:
  feature.node.kubernetes.io/numa-node-count: "2"
  feature.node.kubernetes.io/cpu-hardware_multithreading: "true"
  kubernetes.io/arch: amd64
```

The Topology Manager transforms Kubernetes from a capacity-aware scheduler to a true resource-topology-aware scheduler. For telecom, HPC, and financial workloads where NUMA-crossing latency is unacceptable, this feature moves from optional to mandatory infrastructure configuration.
