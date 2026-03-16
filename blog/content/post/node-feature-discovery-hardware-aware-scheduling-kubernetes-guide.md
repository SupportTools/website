---
title: "Node Feature Discovery: Hardware-Aware Scheduling in Kubernetes"
date: 2027-01-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Feature Discovery", "Scheduling", "Hardware", "GPU"]
categories: ["Kubernetes", "Infrastructure", "Hardware"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Node Feature Discovery (NFD) in Kubernetes covering architecture, auto-discovered hardware features, NodeFeatureRule CRDs, GPU scheduling, NUMA topology awareness, device plugin integration, and production deployment patterns."
more_link: "yes"
url: "/node-feature-discovery-hardware-aware-scheduling-kubernetes-guide/"
---

Kubernetes clusters in enterprise environments are increasingly heterogeneous: some nodes carry GPUs, others have AVX-512 CPU extensions for machine learning inference, others are connected to specialised InfiniBand fabric, and some run on ARM rather than x86. Without a systematic mechanism for advertising hardware capabilities, workloads either land on incompatible nodes and fail at runtime, or operators resort to maintaining large lists of manual node labels that fall out of sync as hardware changes. **Node Feature Discovery (NFD)** solves this by automatically detecting and advertising hardware and software features as node labels, enabling workloads to express precise hardware requirements without any manual labelling.

<!--more-->

## NFD Architecture

NFD consists of three components that work together to keep node labels accurate as hardware inventory changes.

### NFD Master

The **NFD Master** is a Deployment (or single Pod) that runs on the control plane. It receives feature information from worker nodes over gRPC, applies `NodeFeatureRule` processing, and writes the resulting labels to the `kubernetes.io/` and `feature.node.kubernetes.io/` namespace on each `Node` object. The Master also manages the `NodeFeature` and `NodeFeatureRule` CRDs.

### NFD Worker

The **NFD Worker** is a DaemonSet that runs on every node. At startup and on a configurable interval, each worker:

1. Probes the local hardware using feature sources (CPU, kernel, PCI, USB, network, storage, system).
2. Collects dynamic information from the container runtime's host namespace.
3. Sends the feature list to the NFD Master via gRPC.

The Worker runs with `hostPID` and `hostNetwork` access to probe `/proc`, `/sys`, and device files, but does not modify any node state itself.

### NFD Topology Updater

The **NFD Topology Updater** is an optional DaemonSet that collects NUMA topology information (CPU allocations per NUMA zone, per-NUMA resource availability) and updates `NodeResourceTopology` CRD objects. These objects are consumed by the **Topology-Aware Scheduler Plugin** to place pods on NUMA-aligned nodes.

```
                   ┌─────────────────────────────┐
                   │       NFD Master             │
                   │  Receives features via gRPC  │
                   │  Applies NodeFeatureRules     │
                   │  Writes node labels          │
                   └─────────────┬───────────────┘
                                 │ gRPC
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   ┌──────▼──────┐        ┌──────▼──────┐       ┌──────▼──────┐
   │ NFD Worker  │        │ NFD Worker  │       │ NFD Worker  │
   │ (node-gpu1) │        │ (node-cpu1) │       │ (node-arm1) │
   │             │        │             │       │             │
   │ CPU flags   │        │ CPU flags   │       │ CPU flags   │
   │ PCI devices │        │ PCI devices │       │ Kernel mods │
   │ GPU present │        │ No GPU      │       │ ARM SVE     │
   └─────────────┘        └─────────────┘       └─────────────┘
```

## Installing NFD

### Helm Installation

```bash
#!/bin/bash
# Install Node Feature Discovery using Helm
set -euo pipefail

NFD_VERSION="0.16.3"

helm repo add nfd https://kubernetes-sigs.github.io/node-feature-discovery/charts
helm repo update

# Install with recommended production settings
helm upgrade --install node-feature-discovery nfd/node-feature-discovery \
  --version "${NFD_VERSION}" \
  --namespace node-feature-discovery \
  --create-namespace \
  --values - <<'EOF'
master:
  replicaCount: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: master
          topologyKey: kubernetes.io/hostname
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      effect: NoSchedule

worker:
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      effect: NoSchedule
    # Tolerate GPU taint so features are discovered on GPU nodes
    - key: nvidia.com/gpu
      effect: NoSchedule
    - key: amd.com/gpu
      effect: NoSchedule
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 500m
      memory: 512Mi
  config:
    core:
      sleepInterval: 60s
      featureSources:
        - cpu
        - kernel
        - memory
        - network
        - pci
        - storage
        - system
        - usb
        - custom

topologyUpdater:
  enable: true
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi

gc:
  enable: true
  interval: 1h
EOF

kubectl -n node-feature-discovery rollout status deployment/node-feature-discovery-master
kubectl -n node-feature-discovery rollout status daemonset/node-feature-discovery-worker

echo "NFD installed. Checking labels on a node..."
kubectl get node "$(kubectl get nodes -o name | head -1 | cut -d/ -f2)" \
  -o jsonpath='{.metadata.labels}' | jq 'to_entries | map(select(.key | startswith("feature.node.kubernetes.io"))) | from_entries'
```

## Auto-Discovered Features

### CPU Features

NFD probes `/proc/cpuinfo` and the kernel's CPUID interface to detect instruction set extensions. Labels are placed under the `feature.node.kubernetes.io/cpu-*` prefix.

Common CPU labels:

| Label | Meaning |
|---|---|
| `feature.node.kubernetes.io/cpu-cpuid.AVX512F` | AVX-512 Foundation instructions |
| `feature.node.kubernetes.io/cpu-cpuid.AVX2` | AVX2 256-bit SIMD |
| `feature.node.kubernetes.io/cpu-cpuid.AESNI` | Hardware AES acceleration |
| `feature.node.kubernetes.io/cpu-hardware_multithreading` | SMT/HyperThreading enabled |
| `feature.node.kubernetes.io/cpu-model.vendor_id` | CPU vendor (e.g., `GenuineIntel`, `AuthenticAMD`) |
| `feature.node.kubernetes.io/cpu-model.family` | CPU family ID |
| `feature.node.kubernetes.io/cpu-model.id` | CPU model ID |

### Kernel Features

NFD inspects `/proc/modules`, `/proc/config.gz` (when available), and `/sys/kernel/` to discover loaded modules and kernel build configuration.

| Label | Meaning |
|---|---|
| `feature.node.kubernetes.io/kernel-version.major` | Kernel major version |
| `feature.node.kubernetes.io/kernel-version.minor` | Kernel minor version |
| `feature.node.kubernetes.io/kernel-config.NO_HZ` | Tickless kernel enabled |
| `feature.node.kubernetes.io/kernel-config.PREEMPT` | Preemptible kernel |
| `feature.node.kubernetes.io/kernel-loadedmodule.nf_conntrack` | nf_conntrack module loaded |
| `feature.node.kubernetes.io/kernel-loadedmodule.wireguard` | WireGuard module loaded |

### PCI Device Features

NFD reads `/sys/bus/pci/devices/*/class` and `vendor` to detect PCI devices. Labels follow the pattern `feature.node.kubernetes.io/pci-<class>_<vendor>.present`.

```bash
# Example PCI labels on a GPU node
feature.node.kubernetes.io/pci-0302_10de.present=true  # NVIDIA GPU (class 0302, vendor 10de)
feature.node.kubernetes.io/pci-0200_8086.present=true  # Intel Ethernet (class 0200, vendor 8086)
feature.node.kubernetes.io/pci-0604_1000.present=true  # PCIe bridge
```

### Network Interface Features

NFD discovers SRIOV, RDMA, and InfiniBand capabilities:

| Label | Meaning |
|---|---|
| `feature.node.kubernetes.io/network-sriov.capable` | Node has SR-IOV capable NICs |
| `feature.node.kubernetes.io/network-sriov.configured` | SR-IOV is configured and active |
| `feature.node.kubernetes.io/network-rdma.available` | RDMA-capable network interface present |

### USB Device Features

For nodes with connected USB devices (USB-to-serial adapters, crypto keys, sensors):

```bash
feature.node.kubernetes.io/usb-ff_0a12_0001.present=true  # USB device class ff, vendor 0a12
```

## Custom NodeFeatureRule CRD

The `NodeFeatureRule` CRD allows cluster administrators to define custom labelling logic based on raw discovered features. This is the preferred extension point—rules are declarative, version-controlled, and applied by the NFD Master without modifying worker configuration.

### Basic NodeFeatureRule

```yaml
# Label nodes where both AVX-512 and NVIDIA GPU are present
apiVersion: nfd.k8s-sigs.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: gpu-avx512-nodes
spec:
  rules:
    - name: "gpu-with-avx512"
      labels:
        "example.com/accelerated-inference": "true"
      matchFeatures:
        - feature: cpu.cpuid
          matchExpressions:
            AVX512F: {op: Exists}
            AVX512BW: {op: Exists}
        - feature: pci.device
          matchExpressions:
            vendor: {op: In, value: ["10de"]}   # NVIDIA
            class: {op: In, value: ["0302"]}    # 3D controller
```

### NodeFeatureRule with Extended Resources

```yaml
# Apply custom extended resource labels based on discovered features
apiVersion: nfd.k8s-sigs.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: custom-hardware-labels
spec:
  rules:
    # Label nodes with Intel QAT accelerator
    - name: "intel-qat"
      labels:
        "intel.com/qat": "true"
      annotations:
        "intel.com/qat-generation": "c6xx"
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor: {op: In, value: ["8086"]}
            device: {op: In, value: ["37c8", "4940", "4944"]}

    # Label InfiniBand nodes
    - name: "infiniband-rdma"
      labels:
        "networking.example.com/infiniband": "true"
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor: {op: In, value: ["15b3"]}   # Mellanox/NVIDIA
            class: {op: In, value: ["0207"]}    # InfiniBand

    # Label high-memory nodes
    - name: "high-memory-node"
      labels:
        "memory.example.com/tier": "high"
      matchFeatures:
        - feature: memory.numa
          matchExpressions:
            node_count: {op: Gt, value: ["1"]}

    # Label ARM Neoverse nodes for optimised workloads
    - name: "arm-neoverse"
      labels:
        "cpu.example.com/architecture": "arm-neoverse"
      matchFeatures:
        - feature: cpu.cpuid
          matchExpressions:
            SVE: {op: Exists}
        - feature: system.osrelease
          matchExpressions:
            ID: {op: In, value: ["ubuntu", "debian"]}
```

### NodeFeatureRule with taints

NFD can also manage node taints through `NodeFeatureRule`, reserving hardware for specific workloads:

```yaml
apiVersion: nfd.k8s-sigs.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: gpu-taint
spec:
  rules:
    - name: "taint-gpu-nodes"
      taints:
        - key: "nvidia.com/gpu"
          value: "present"
          effect: NoSchedule
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor: {op: In, value: ["10de"]}
            class: {op: In, value: ["0302"]}
```

## GPU Scheduling with NFD Labels

### NVIDIA GPU Operator Integration

The NVIDIA GPU Operator uses NFD labels to detect GPU nodes and deploy the GPU device plugin, drivers, and container toolkit. With NFD installed, the Operator's NodeSelector automatically targets correctly labelled nodes.

```bash
#!/bin/bash
# Install NVIDIA GPU Operator (NFD already installed)
set -euo pipefail

helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

helm upgrade --install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set nfd.enabled=false \
  --set driver.enabled=true \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true \
  --set migManager.enabled=true \
  --wait

# Verify GPU resources are available on GPU nodes
kubectl get nodes -l "feature.node.kubernetes.io/pci-0302_10de.present=true" \
  -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
```

### GPU Pod Scheduling with NFD Labels

```yaml
# Schedule ML training on nodes with NVIDIA A100 (device ID 20b0)
apiVersion: batch/v1
kind: Job
metadata:
  name: model-training-job
  namespace: ml-workloads
spec:
  template:
    spec:
      nodeSelector:
        # NFD label: NVIDIA vendor, 3D controller class
        feature.node.kubernetes.io/pci-0302_10de.present: "true"
        # Custom label from NodeFeatureRule: confirmed A100
        gpu.example.com/model: "A100-80GB"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: trainer
          image: nvcr.io/nvidia/pytorch:24.01-py3
          resources:
            limits:
              nvidia.com/gpu: "4"
          command: ["python", "train.py", "--gpus=4"]
      restartPolicy: OnFailure
```

### Multi-Instance GPU (MIG) Scheduling

For A100 and H100 GPUs configured for MIG, NFD labels expose the MIG strategy in use:

```yaml
# Schedule on a node with MIG 3g.40gb profiles available
apiVersion: v1
kind: Pod
metadata:
  name: inference-pod
  namespace: ml-inference
spec:
  nodeSelector:
    nvidia.com/mig.strategy: "mixed"
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  containers:
    - name: inference
      image: nvcr.io/nvidia/tritonserver:24.01-py3
      resources:
        limits:
          nvidia.com/mig-3g.40gb: "1"
```

## NUMA Topology Awareness

### Enabling the Topology Updater

The NFD Topology Updater collects per-node NUMA topology and writes `NodeResourceTopology` objects:

```yaml
# NodeResourceTopology written by NFD Topology Updater
apiVersion: topology.node.k8s.io/v1alpha2
kind: NodeResourceTopology
metadata:
  name: gpu-node-01
topologyPolicies: ["SingleNUMANodeContainerLevel"]
zones:
  - name: node-0
    type: Node
    resources:
      - name: cpu
        available: "24"
        capacity: "24"
      - name: memory
        available: "96Gi"
        capacity: "96Gi"
      - name: nvidia.com/gpu
        available: "2"
        capacity: "2"
  - name: node-1
    type: Node
    resources:
      - name: cpu
        available: "24"
        capacity: "24"
      - name: memory
        available: "96Gi"
        capacity: "96Gi"
      - name: nvidia.com/gpu
        available: "2"
        capacity: "2"
```

### Topology-Aware Scheduling

The **Topology Manager** in the kubelet enforces NUMA alignment for guaranteed-QoS pods. Configure the kubelet policy:

```yaml
# kubelet configuration for NUMA awareness
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: "single-numa-node"
topologyManagerScope: "container"
cpuManagerPolicy: "static"
memoryManagerPolicy: "Static"
```

For cluster-level topology awareness before scheduling (rather than kubelet-level rejection after scheduling), deploy the **Topology-Aware Scheduler Plugin** (TASK) with the `NodeResourceTopology` source.

```yaml
# KubeSchedulerConfiguration with topology plugin
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: topology-aware-scheduler
    plugins:
      filter:
        enabled:
          - name: NodeResourceTopologyMatch
      score:
        enabled:
          - name: NodeResourceTopologyMatch
    pluginConfig:
      - name: NodeResourceTopologyMatch
        args:
          scoringStrategy:
            type: BalancedAllocation
            resources:
              - name: cpu
                weight: 1
              - name: memory
                weight: 1
              - name: nvidia.com/gpu
                weight: 10
```

## Device Plugin Integration

NFD labels complement device plugins by providing rich metadata that device plugins cannot express. The pattern is:

1. NFD discovers the hardware and applies labels (e.g., `feature.node.kubernetes.io/pci-0302_10de.present=true`).
2. The device plugin allocates the actual devices and advertises extended resources (e.g., `nvidia.com/gpu: 4`).
3. Pods use both: `nodeSelector` or `nodeAffinity` on NFD labels to select nodes with the right hardware generation, and `resources.limits` for device plugin allocation.

### Intel Resource Manager (CNCF Incubating)

Intel Resource Manager uses both NFD labels and `NodeResourceTopology` objects to make placement decisions for workloads requiring specific Intel hardware features:

```yaml
# ResourceClaim using Intel RDT (Resource Director Technology)
# Requires NFD label: feature.node.kubernetes.io/cpu-cpuid.RDTMON
apiVersion: resource.k8s.io/v1alpha2
kind: ResourceClaim
metadata:
  name: rdt-claim
spec:
  resourceClassName: intel-rdt-l3-cache
  allocationMode: WaitForFirstConsumer
---
apiVersion: v1
kind: Pod
metadata:
  name: rdt-workload
spec:
  nodeSelector:
    feature.node.kubernetes.io/cpu-rdt.RDTMON: "true"
    feature.node.kubernetes.io/cpu-rdt.RDTL3CA: "true"
  resourceClaims:
    - name: rdt
      source:
        resourceClaimName: rdt-claim
  containers:
    - name: workload
      image: registry.example.com/cache-sensitive-app:1.0.0
      resources:
        claims:
          - name: rdt
```

## nodeSelector and Affinity Patterns with NFD Labels

### Simple nodeSelector

```yaml
# Schedule only on nodes with AVX2 for vectorised numerical computing
spec:
  nodeSelector:
    feature.node.kubernetes.io/cpu-cpuid.AVX2: "true"
```

### Node Affinity with Preference and Fallback

```yaml
# Prefer nodes with AVX-512; fall back to AVX2
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: feature.node.kubernetes.io/cpu-cpuid.AVX512F
                operator: In
                values: ["true"]
        - weight: 50
          preference:
            matchExpressions:
              - key: feature.node.kubernetes.io/cpu-cpuid.AVX2
                operator: In
                values: ["true"]
```

### Required Affinity for Critical Hardware

```yaml
# Require SR-IOV for low-latency network workloads
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: feature.node.kubernetes.io/network-sriov.configured
                operator: In
                values: ["true"]
              - key: feature.node.kubernetes.io/kernel-version.major
                operator: Gt
                values: ["5"]
```

### Pod Anti-Affinity with NFD Labels for Spread

```yaml
# Spread GPU workloads across NUMA zones
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: "topology.kubernetes.io/zone"
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          workload-type: gpu-inference
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: feature.node.kubernetes.io/pci-0302_10de.present
                operator: In
                values: ["true"]
```

## NFD Webhook

NFD provides an optional admission webhook that validates `NodeFeatureRule` objects on submission, catching syntax errors before they reach the NFD Master.

```bash
#!/bin/bash
# Enable NFD webhook (assumes cert-manager is installed)
set -euo pipefail

# The NFD Helm chart enables the webhook with the webhook.enable flag
helm upgrade node-feature-discovery nfd/node-feature-discovery \
  --namespace node-feature-discovery \
  --reuse-values \
  --set master.nfdApiController.enable=true

# Verify webhook is registered
kubectl get validatingwebhookconfigurations | grep nfd
kubectl get mutatingwebhookconfigurations | grep nfd
```

## Production Deployment and Monitoring

### Worker ConfigMap Tuning

```yaml
# NFD Worker ConfigMap for production
apiVersion: v1
kind: ConfigMap
metadata:
  name: nfd-worker-conf
  namespace: node-feature-discovery
data:
  nfd-worker.conf: |
    core:
      sleepInterval: 60s
      featureSources:
        - cpu
        - kernel
        - memory
        - network
        - pci
        - storage
        - system
        - usb
        - custom
      labelSources:
        - cpu
        - kernel
        - memory
        - network
        - pci
        - storage
        - system
        - usb
        - custom
      noPublish: false
    sources:
      pci:
        deviceClassWhitelist:
          - "0200"   # Ethernet
          - "0207"   # InfiniBand
          - "0302"   # 3D controller (GPU)
          - "0300"   # VGA (GPU)
          - "0c03"   # USB controller
          - "0106"   # SATA/NVMe
        deviceLabelFields:
          - vendor
          - device
          - class
          - subsystem_vendor
          - subsystem_device
      cpu:
        cpuid:
          attributeBlacklist:
            - "SGXLC"
            - "SGX"
      kernel:
        kconfigFile: ""
        configOpts:
          - "NO_HZ"
          - "NO_HZ_IDLE"
          - "PREEMPT"
          - "HZ"
      custom:
        - name: "rdma-capable"
          matchOn:
            - pciId:
                class: ["0207"]
                vendor: ["15b3"]
```

### Prometheus Monitoring for NFD

```yaml
# ServiceMonitor for NFD Master metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nfd-master
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - node-feature-discovery
  selector:
    matchLabels:
      app.kubernetes.io/component: master
  endpoints:
    - port: metrics
      interval: 60s
      path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nfd-alerts
  namespace: monitoring
spec:
  groups:
    - name: nfd.availability
      rules:
        - alert: NFDWorkerNotRunning
          expr: |
            kube_daemonset_status_number_unavailable{
              namespace="node-feature-discovery",
              daemonset="node-feature-discovery-worker"
            } > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "NFD worker pods unavailable on {{ $value }} node(s)"
            description: "Node feature labels may be stale on affected nodes."

        - alert: NFDMasterNotReady
          expr: |
            kube_deployment_status_replicas_available{
              namespace="node-feature-discovery",
              deployment="node-feature-discovery-master"
            } == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "NFD Master has no available replicas"
            description: "Node feature labels will not be updated."
```

### Verifying Label Accuracy

```bash
#!/bin/bash
# Operational verification script for NFD deployments
set -euo pipefail

echo "=== NFD Pod Status ==="
kubectl -n node-feature-discovery get pods -o wide

echo ""
echo "=== Feature labels on all nodes ==="
kubectl get nodes -o json | \
  jq -r '.items[] | .metadata.name as $name |
    .metadata.labels |
    to_entries |
    map(select(.key | startswith("feature.node.kubernetes.io"))) |
    map("\($name)  \(.key)=\(.value)")[]'

echo ""
echo "=== GPU-capable nodes ==="
kubectl get nodes -l "feature.node.kubernetes.io/pci-0302_10de.present=true" \
  -o custom-columns='NODE:.metadata.name,GPU-LABEL:.metadata.labels.feature\.node\.kubernetes\.io/pci-0302_10de\.present'

echo ""
echo "=== AVX-512 capable nodes ==="
kubectl get nodes -l "feature.node.kubernetes.io/cpu-cpuid.AVX512F=true" \
  -o custom-columns='NODE:.metadata.name,CPU-VENDOR:.metadata.labels.feature\.node\.kubernetes\.io/cpu-model\.vendor_id'

echo ""
echo "=== SR-IOV configured nodes ==="
kubectl get nodes -l "feature.node.kubernetes.io/network-sriov.configured=true" \
  -o name

echo ""
echo "=== NodeFeatureRules ==="
kubectl get nodefeaturerules -o wide
```

### Garbage Collection

When nodes are removed from the cluster, NFD labels on the deleted node objects are cleaned up automatically by the NFD GC controller. The GC also cleans up stale `NodeFeature` objects when the corresponding node no longer exists.

```bash
# Check for stale NodeFeature objects
kubectl -n node-feature-discovery get nodefeatures

# Manually trigger GC (if needed after node deletion)
kubectl -n node-feature-discovery rollout restart deployment/node-feature-discovery-gc
```

## Summary

Node Feature Discovery transforms heterogeneous Kubernetes infrastructure from an obstacle into an asset. Automatic CPU flag, PCI device, kernel module, and network capability detection eliminates the manual labelling burden that grows unsustainable at scale. The `NodeFeatureRule` CRD provides a declarative, version-controlled extension point for applying custom business logic on top of raw discovered features—without modifying the NFD Worker. When combined with the NVIDIA GPU Operator, SR-IOV device plugins, Intel Resource Manager, and the Topology-Aware Scheduler, NFD forms the hardware awareness layer that makes workload placement decisions accurate, reproducible, and auditable. Production deployments benefit from multi-replica NFD Master, monitored via Prometheus, with NodeFeatureRule objects reviewed in the same GitOps workflow as application manifests.
