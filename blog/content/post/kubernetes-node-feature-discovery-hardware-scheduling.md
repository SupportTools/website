---
title: "Kubernetes Node Feature Discovery: Hardware-Aware Workload Scheduling"
date: 2029-01-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NFD", "Node Feature Discovery", "Scheduling", "Hardware"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to deploying Node Feature Discovery (NFD) in Kubernetes, creating node labels from hardware capabilities, and using them for intelligent workload scheduling in heterogeneous clusters."
more_link: "yes"
url: "/kubernetes-node-feature-discovery-hardware-scheduling/"
---

Enterprise Kubernetes clusters rarely consist of homogeneous hardware. GPU nodes for machine learning, high-memory nodes for in-memory databases, nodes with specific CPU instruction sets for cryptographic workloads, and nodes with direct NVMe access for storage-intensive applications create a heterogeneous infrastructure where workload placement decisions have significant performance implications.

Node Feature Discovery (NFD) solves the discovery and labeling problem by automatically inspecting node hardware and advertising capabilities as Kubernetes node labels. Schedulers, operators, and platform teams can then use these labels to make intelligent placement decisions without maintaining manual node label mappings.

<!--more-->

## What NFD Discovers

NFD inspects multiple hardware and software subsystems and applies labels in the `feature.node.kubernetes.io/` namespace:

**CPU features**: Architecture, supported instruction sets (AVX2, AVX512, AES-NI), number of cores, NUMA topology, CPU flags

**Memory**: Total capacity, NUMA node count, huge pages availability

**Network**: NIC driver types, SRIOV capability, RDMA support, InfiniBand

**Storage**: NVMe drives, persistent memory (PMEM), direct I/O capability

**PCI devices**: GPU vendors, accelerator cards, FPGA presence

**Kernel**: Kernel version, enabled features, loaded modules

**OS**: Distribution, version

**Custom**: User-defined sources via configurable rules

### Sample NFD Labels on a GPU Node

```
feature.node.kubernetes.io/cpu-cpuid.AVX2=true
feature.node.kubernetes.io/cpu-cpuid.AVX512F=true
feature.node.kubernetes.io/cpu-hardware_multithreading=true
feature.node.kubernetes.io/cpu-model.id=85
feature.node.kubernetes.io/cpu-model.vendor_id=Intel
feature.node.kubernetes.io/memory-numa=true
feature.node.kubernetes.io/network-sriov.capable=true
feature.node.kubernetes.io/pci-0300_10de.present=true  # NVIDIA GPU
feature.node.kubernetes.io/pci-0300_10de.sriov.capable=false
feature.node.kubernetes.io/storage-nonrotational=true
feature.node.kubernetes.io/kernel-version.full=5.15.0-91-generic
feature.node.kubernetes.io/kernel-selinux.enabled=false
```

## Deploying NFD

### Helm Installation

```bash
# Add NFD Helm repository
helm repo add nfd https://kubernetes-sigs.github.io/node-feature-discovery/charts
helm repo update

# Install NFD
helm install nfd nfd/node-feature-discovery \
  --namespace node-feature-discovery \
  --create-namespace \
  --version 0.16.3 \
  --set worker.config.core.sleepInterval=60s \
  --set master.replicaCount=2 \
  --set master.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels."app\.kubernetes\.io/name"=nfd \
  --set master.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey=kubernetes.io/hostname
```

### Custom NFD Configuration

```yaml
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
        - all
      labelSources:
        - all
      noPublish: false

    sources:
      cpu:
        cpuid:
          # Advertise these specific CPU flags (default advertises all)
          attributeBlacklist:
            - "BMI1"
            - "BMI2"
          attributeWhitelist: []

      pci:
        deviceClassWhitelist:
          - "0200"   # Network controllers
          - "0300"   # Display controllers (GPUs)
          - "0302"   # 3D controllers
          - "0880"   # System peripherals
        deviceLabelFields:
          - "class"
          - "vendor"
          - "device"
          - "subsystem_vendor"
          - "subsystem_device"

      usb:
        deviceClassWhitelist:
          - "ff"
        deviceLabelFields:
          - "class"
          - "vendor"
          - "device"

      kernel:
        kconfigFile: "/host/boot/config-{{ .KernelVersion }}"
        configOpts:
          - "NO_HZ"
          - "NO_HZ_IDLE"
          - "NO_HZ_FULL"
          - "PREEMPT"
          - "PREEMPT_RT"
          - "HZ"

      local:
        hooksEnabled: true
```

### Operator-Based Deployment

For tighter lifecycle management, use the NFD Operator:

```yaml
apiVersion: nfd.kubernetes.io/v1
kind: NodeFeatureDiscovery
metadata:
  name: nfd-instance
  namespace: node-feature-discovery
spec:
  instance: ""
  topologyUpdater: false
  operand:
    image: registry.k8s.io/nfd/node-feature-discovery:v0.16.3
    imagePullPolicy: IfNotPresent
    servicePort: 8080
  workerConfig:
    configData: |
      core:
        sleepInterval: "60s"
      sources:
        pci:
          deviceClassWhitelist:
            - "0300"
            - "0302"
        cpu:
          cpuid:
            attributeWhitelist: []
  customConfig:
    configData: |
      - name: "intel-gpu"
        labels:
          "gpu.vendor": "intel"
        matchFeatures:
          - feature: pci.device
            matchExpressions:
              vendor:
                op: In
                value: ["8086"]
              class:
                op: In
                value: ["0300", "0302"]
```

## Custom Feature Rules

NFD supports user-defined feature detection rules through `NodeFeatureRule` CRDs:

### Detecting Specific Hardware Configurations

```yaml
apiVersion: nfd.kubernetes.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: high-memory-nodes
  namespace: node-feature-discovery
spec:
  rules:
    - name: "high-memory"
      labels:
        "node-role.example.com/high-memory": "true"
        "memory.example.com/tier": "large"
      matchFeatures:
        - feature: memory.info
          matchExpressions:
            MemTotal:
              op: Gt
              value: "524288000"  # > 512 GB in kB
---
apiVersion: nfd.kubernetes.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: nvme-nodes
  namespace: node-feature-discovery
spec:
  rules:
    - name: "nvme-local-storage"
      labels:
        "storage.example.com/nvme": "true"
        "storage.example.com/local": "true"
      matchFeatures:
        - feature: storage.block
          matchExpressions:
            rotational:
              op: In
              value: ["false"]
---
apiVersion: nfd.kubernetes.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: rdma-capable-nodes
  namespace: node-feature-discovery
spec:
  rules:
    - name: "rdma-capable"
      labels:
        "network.example.com/rdma": "true"
        "network.example.com/infiniband": "true"
      matchFeatures:
        - feature: kernel.loadedmodule
          matchExpressions:
            ib_core:
              op: Exists
        - feature: pci.device
          matchExpressions:
            vendor:
              op: In
              value: ["15b3"]   # Mellanox
---
apiVersion: nfd.kubernetes.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: amd-gpu-nodes
  namespace: node-feature-discovery
spec:
  rules:
    - name: "amd-gpu"
      labels:
        "gpu.example.com/vendor": "amd"
        "gpu.example.com/present": "true"
      matchFeatures:
        - feature: pci.device
          matchExpressions:
            vendor:
              op: In
              value: ["1002"]   # AMD
            class:
              op: In
              value: ["0300", "0302"]
```

### Environment-Specific Labeling

```yaml
apiVersion: nfd.kubernetes.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: cpu-performance-tiers
  namespace: node-feature-discovery
spec:
  rules:
    - name: "cpu-compute-optimized"
      labels:
        "cpu.example.com/tier": "compute-optimized"
      matchFeatures:
        - feature: cpu.cpuid
          matchExpressions:
            AVX512F:
              op: Exists
            AVX512DQ:
              op: Exists
            AVX512BW:
              op: Exists
        - feature: cpu.topology
          matchExpressions:
            hardware_multithreading:
              op: In
              value: ["false"]   # Hyperthreading disabled for HPC workloads

    - name: "cpu-general-purpose"
      labels:
        "cpu.example.com/tier": "general-purpose"
      matchFeatures:
        - feature: cpu.cpuid
          matchExpressions:
            AVX2:
              op: Exists
```

## Using NFD Labels for Workload Scheduling

### nodeSelector for Basic Placement

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ml-inference-server
  namespace: production
spec:
  replicas: 4
  selector:
    matchLabels:
      app: ml-inference-server
  template:
    metadata:
      labels:
        app: ml-inference-server
    spec:
      nodeSelector:
        # Require NVIDIA GPU
        feature.node.kubernetes.io/pci-0300_10de.present: "true"
        # Require AVX512 for optimized ML kernels
        feature.node.kubernetes.io/cpu-cpuid.AVX512F: "true"
      containers:
        - name: inference
          image: registry.example.com/ml-inference:3.1.0
          resources:
            requests:
              cpu: "4"
              memory: 8Gi
              nvidia.com/gpu: "1"
            limits:
              cpu: "8"
              memory: 16Gi
              nvidia.com/gpu: "1"
```

### Node Affinity for Preferred Placement

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: analytics-worker
  namespace: data-platform
spec:
  replicas: 8
  selector:
    matchLabels:
      app: analytics-worker
  template:
    metadata:
      labels:
        app: analytics-worker
    spec:
      affinity:
        nodeAffinity:
          # Strongly prefer nodes with high memory
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: node-role.example.com/high-memory
                    operator: In
                    values: ["true"]
            - weight: 50
              preference:
                matchExpressions:
                  - key: storage.example.com/nvme
                    operator: In
                    values: ["true"]
          # Require non-rotational storage
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: feature.node.kubernetes.io/storage-nonrotational
                    operator: In
                    values: ["true"]
      containers:
        - name: worker
          image: registry.example.com/analytics-worker:1.8.2
          resources:
            requests:
              cpu: "2"
              memory: 32Gi
            limits:
              cpu: "8"
              memory: 128Gi
```

### Topology Manager and NUMA-Aware Scheduling

For latency-sensitive workloads that require NUMA-local memory access:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: numa-aware-dpdk
  namespace: network-functions
spec:
  selector:
    matchLabels:
      app: dpdk-worker
  template:
    metadata:
      labels:
        app: dpdk-worker
    spec:
      nodeSelector:
        feature.node.kubernetes.io/memory-numa: "true"
        network.example.com/rdma: "true"
      containers:
        - name: dpdk
          image: registry.example.com/dpdk-app:22.11.2
          securityContext:
            capabilities:
              add:
                - NET_ADMIN
                - SYS_RAWIO
                - IPC_LOCK
          resources:
            requests:
              cpu: "8"
              memory: "4Gi"
              hugepages-1Gi: "8Gi"
            limits:
              cpu: "8"
              memory: "4Gi"
              hugepages-1Gi: "8Gi"
          volumeMounts:
            - name: hugepages
              mountPath: /dev/hugepages
      volumes:
        - name: hugepages
          emptyDir:
            medium: HugePages-1Gi
```

## Node Topology Manager Integration

NFD integrates with the Kubernetes Topology Manager for NUMA-aware allocation. Enable it in kubelet configuration:

```yaml
# /etc/kubernetes/kubelet-config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: "best-effort"
topologyManagerScope: "pod"
# Optional: restrict to NUMA-aware nodes detected by NFD
reservedSystemCPUs: "0,1"
```

## NodeResourceTopology and NUMA Scheduling

For advanced NUMA-aware scheduling, deploy the NFD Topology Updater alongside the NodeResourceTopology API:

```bash
# Enable topology updater in NFD deployment
helm upgrade nfd nfd/node-feature-discovery \
  --namespace node-feature-discovery \
  --reuse-values \
  --set topologyUpdater.enable=true \
  --set topologyUpdater.updateInterval=10s

# Verify topology resources are published
kubectl get noderesourcetopologies
kubectl get noderesourcetopology worker-node-01 -o yaml
```

## Monitoring NFD Health

### NFD Status Verification

```bash
# Check NFD master and worker health
kubectl -n node-feature-discovery get pods -l app.kubernetes.io/name=node-feature-discovery

# Verify node labels are being applied
kubectl get node worker-node-01 --show-labels | tr ',' '\n' | grep feature.node

# Count nodes with specific capabilities
kubectl get nodes -l 'feature.node.kubernetes.io/pci-0300_10de.present=true' \
  --no-headers | wc -l

# Show all GPU-capable nodes
kubectl get nodes \
  -l 'feature.node.kubernetes.io/pci-0300_10de.present=true' \
  -o custom-columns='NAME:.metadata.name,GPU-VENDOR:.metadata.labels.feature\.node\.kubernetes\.io/pci-0300_10de\.present,CPU-AVX512:.metadata.labels.feature\.node\.kubernetes\.io/cpu-cpuid\.AVX512F'
```

### Prometheus Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nfd-metrics
  namespace: node-feature-discovery
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: node-feature-discovery
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nfd-alerts
  namespace: monitoring
spec:
  groups:
    - name: nfd.health
      rules:
        - alert: NFDWorkerDown
          expr: |
            kube_daemonset_status_desired_number_scheduled{daemonset="nfd-node-feature-discovery-worker"}
            - kube_daemonset_status_current_number_scheduled{daemonset="nfd-node-feature-discovery-worker"} > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "NFD worker is not running on all nodes"
            description: "{{ $value }} nodes are missing the NFD worker. Hardware features will not be advertised for these nodes."

        - alert: NFDLabelUpdateFailed
          expr: |
            rate(nfd_master_topology_update_errors_total[5m]) > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "NFD label updates are failing"
            description: "NFD master is experiencing errors updating node labels. Hardware-aware scheduling may be stale."
```

## Custom Local Sources

NFD supports local scripts that generate custom labels, enabling integration with proprietary hardware or configuration management systems:

```bash
# Create a hook script that detects custom hardware
mkdir -p /etc/kubernetes/node-feature-discovery/source.d

cat > /etc/kubernetes/node-feature-discovery/source.d/detect-fpga.sh << 'EOF'
#!/bin/bash
# Detect Xilinx FPGAs via PCIe
if lspci -d 10ee: 2>/dev/null | grep -q .; then
  echo "fpga=xilinx"
  echo "fpga-present=true"
  # Detect specific card model
  CARD=$(lspci -d 10ee: | head -1 | awk '{print $NF}')
  echo "fpga-model=${CARD}"
fi
EOF
chmod +x /etc/kubernetes/node-feature-discovery/source.d/detect-fpga.sh
```

Mount the hook directory in the NFD worker:

```yaml
# In NFD worker DaemonSet spec
volumes:
  - name: local-hooks
    hostPath:
      path: /etc/kubernetes/node-feature-discovery/source.d
      type: DirectoryOrCreate
volumeMounts:
  - name: local-hooks
    mountPath: /etc/kubernetes/node-feature-discovery/source.d
    readOnly: true
```

## Taint and Toleration Patterns

Combine NFD labels with taints to ensure only appropriate workloads run on specialized hardware:

```bash
# Taint GPU nodes to prevent non-GPU workloads from landing there
kubectl taint nodes -l 'feature.node.kubernetes.io/pci-0300_10de.present=true' \
  nvidia.com/gpu=present:NoSchedule

# Taint high-memory nodes
kubectl taint nodes -l 'node-role.example.com/high-memory=true' \
  memory.example.com/high-memory=true:NoSchedule
```

GPU workloads then require both the toleration and nodeSelector:

```yaml
spec:
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
  nodeSelector:
    feature.node.kubernetes.io/pci-0300_10de.present: "true"
```

## Summary

Node Feature Discovery provides the labeling foundation that enables intelligent workload placement in heterogeneous Kubernetes clusters. By automatically advertising CPU capabilities, GPU presence, memory configuration, and storage types, NFD eliminates the need for manual label management and ensures that workloads always land on hardware that can actually run them effectively.

Combined with node affinity rules, taints and tolerations, and the Topology Manager, NFD enables a hardware-aware scheduling strategy that optimizes both resource utilization and workload performance across diverse infrastructure.
