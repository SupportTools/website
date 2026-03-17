---
title: "GPU Workload Management on Kubernetes: NVIDIA GPU Operator Deep Dive"
date: 2028-01-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GPU", "NVIDIA", "Machine Learning", "DCGM", "MIG", "GPU Operator"]
categories: ["Kubernetes", "AI/ML"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to GPU workload management on Kubernetes covering NVIDIA GPU Operator components, time-slicing vs MIG partitioning, GPU resource quotas, Volta/Ampere MIG profiles, node feature discovery, DCGM monitoring, and multi-instance GPU scheduling."
more_link: "yes"
url: "/kubernetes-gpu-workload-management-guide/"
---

Running GPU workloads on Kubernetes at scale requires more than adding a resource limit. The NVIDIA GPU Operator automates the deployment and lifecycle management of the entire GPU software stack — drivers, container toolkit, device plugin, feature discovery, and monitoring — as Kubernetes-native components. Understanding each layer enables platform teams to provide reliable, observable, and efficiently shared GPU infrastructure for training and inference workloads.

This guide covers the complete GPU Operator deployment, time-slicing and MIG partitioning for multi-tenant GPU sharing, resource quota enforcement, Ampere MIG profile configuration, DCGM Exporter for Prometheus monitoring, and scheduling patterns for batch training versus latency-sensitive inference workloads.

<!--more-->

# GPU Workload Management on Kubernetes: NVIDIA GPU Operator Deep Dive

## Section 1: GPU Operator Architecture

The NVIDIA GPU Operator manages these components via Kubernetes DaemonSets and CRDs:

```
GPU Operator (ClusterPolicy CRD)
├── gpu-driver               - NVIDIA kernel driver (DaemonSet per OS/version)
├── container-toolkit        - nvidia-container-toolkit / libnvidia-container
├── device-plugin            - Advertises nvidia.com/gpu resources to kubelet
├── gpu-feature-discovery    - Labels nodes with detailed GPU capabilities
├── dcgm-exporter            - NVIDIA DCGM metrics for Prometheus
├── node-status-exporter     - Node GPU health exporter
├── mig-manager              - Configures Multi-Instance GPU partitioning
├── validator                - Validates GPU stack health
└── operator-validator       - Validates operator deployment
```

### ClusterPolicy — The Master Configuration

```yaml
# cluster-policy.yaml
apiVersion: nvidia.com/v1
kind: ClusterPolicy
metadata:
  name: gpu-cluster-policy
spec:
  operator:
    defaultRuntime: containerd
    runtimeClass: nvidia
    use_ocp_driver_toolkit: false

  driver:
    enabled: true
    image: nvcr.io/nvidia/driver
    version: "535.161.07"
    manager:
      image: nvcr.io/nvidia/cloud-native/k8s-driver-manager
      version: v0.6.4
    rdma:
      enabled: false
    upgradePolicy:
      autoUpgrade: true
      maxParallelUpgrades: 1
      waitForJobsToComplete:
        enabled: true
        timeoutSeconds: 3600

  toolkit:
    enabled: true
    image: nvcr.io/nvidia/k8s/container-toolkit
    version: v1.15.0-ubuntu20.04

  devicePlugin:
    enabled: true
    image: nvcr.io/nvidia/k8s-device-plugin
    version: v0.14.5
    config:
      name: time-slicing-config
      default: ""

  dcgmExporter:
    enabled: true
    image: nvcr.io/nvidia/k8s/dcgm-exporter
    version: 3.3.5-3.4.1-ubuntu22.04
    config:
      name: dcgm-metrics-config
    serviceMonitor:
      enabled: true
      interval: 15s

  gfd:
    enabled: true
    image: nvcr.io/nvidia/gpu-feature-discovery
    version: v0.8.2
    migStrategy: single

  migManager:
    enabled: true
    image: nvcr.io/nvidia/k8s/k8s-mig-manager
    version: v0.5.5-ubuntu20.04
    config:
      name: mig-parted-config
    gpuClientsConfig:
      name: gpu-clients

  nodeStatusExporter:
    enabled: true
    image: nvcr.io/nvidia/gpu-operator
    version: v23.9.2
```

## Section 2: Installation

### Prerequisites

```bash
# Verify GPU nodes are ready
kubectl get nodes -l nvidia.com/gpu=present -o wide

# If nodes don't have the GPU label yet, check:
kubectl get nodes --show-labels | grep -E "gpu|nvidia"

# Check containerd runtime version
kubectl get node gpu-node-01 -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}'

# Verify containerd supports nvidia runtime class
cat /etc/containerd/config.toml | grep -A 10 nvidia
```

### Install via Helm

```bash
# Add NVIDIA Helm repository
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# Install GPU Operator
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set operator.defaultRuntime=containerd \
  --set toolkit.version=v1.15.0-ubuntu20.04 \
  --set driver.enabled=true \
  --set driver.version=535.161.07 \
  --set dcgmExporter.enabled=true \
  --set gfd.enabled=true \
  --set migManager.enabled=true \
  --version 23.9.2 \
  --wait

# Verify all GPU Operator pods are running
kubectl get pods -n gpu-operator
watch kubectl get pods -n gpu-operator  # Watch until all are Running

# Check ClusterPolicy status
kubectl describe clusterpolicy gpu-cluster-policy
```

### Verify GPU Availability

```bash
# GPU nodes should now report nvidia.com/gpu resources
kubectl describe node gpu-node-01 | grep -A 5 "Allocatable:"

# Expected:
# Allocatable:
#   ...
#   nvidia.com/gpu:     4
#   ...

# Run a quick GPU test
kubectl run gpu-test --rm -it \
  --image=nvcr.io/nvidia/cuda:12.3.0-base-ubuntu22.04 \
  --restart=Never \
  --limits=nvidia.com/gpu=1 \
  -- nvidia-smi

# Expected output:
# +-----------------------------------------------------------------------------+
# | NVIDIA-SMI 535.161.07 ...                                                   |
# +-------------+----------------------+-------------------------------+         |
# | GPU  Name   | ...                  | ...                           |         |
# |   0  A100   | ...                  | ...                           |         |
```

## Section 3: Node Feature Discovery Labels

GFD (GPU Feature Discovery) automatically labels GPU nodes with detailed capability information:

```bash
# View all GPU-related labels on a GPU node
kubectl get node gpu-node-01 --show-labels | tr ',' '\n' | grep nvidia

# Common GFD labels:
# nvidia.com/cuda.driver.major=12
# nvidia.com/cuda.driver.minor=3
# nvidia.com/cuda.runtime.major=12
# nvidia.com/cuda.runtime.minor=2
# nvidia.com/gfd.timestamp=1704067200
# nvidia.com/gpu.compute.major=9  (Hopper)
# nvidia.com/gpu.compute.minor=0
# nvidia.com/gpu.count=4
# nvidia.com/gpu.family=ampere    (or hopper, volta, turing)
# nvidia.com/gpu.machine=DGX-A100
# nvidia.com/gpu.memory=81920    (81920 MiB = 80 GB)
# nvidia.com/gpu.product=A100-SXM4-80GB
# nvidia.com/mig.capable=true
# nvidia.com/mig.strategy=single (or mixed)
```

### Node Feature Discovery Rules

```yaml
# nfd-rules.yaml — Custom feature discovery rules
apiVersion: nfd.k8s-sigs.io/v1alpha1
kind: NodeFeatureRule
metadata:
  name: gpu-topology-rules
spec:
  rules:
    - name: high-memory-gpu
      labels:
        nvidia.com/gpu-tier: "high-memory"
      matchFeatures:
        - feature: attribute.nvidia.com/gpu.memory
          matchExpressions:
            nvidia.com/gpu.memory:
              op: Gt
              value: "40960"  # > 40 GB VRAM
    - name: multi-gpu-node
      labels:
        nvidia.com/multi-gpu: "true"
      matchFeatures:
        - feature: attribute.nvidia.com/gpu.count
          matchExpressions:
            nvidia.com/gpu.count:
              op: Gt
              value: "1"
```

## Section 4: Time-Slicing — Shared GPU Access

Time-slicing allows multiple pods to share a single physical GPU by time-multiplexing access. Each pod believes it has exclusive GPU access but actual compute is interleaved.

### Configure Time-Slicing

```yaml
# time-slicing-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  any: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        renameByDefault: false
        failRequestsGreaterThanOne: false
        resources:
          - name: nvidia.com/gpu
            replicas: 4  # Each physical GPU appears as 4 logical GPUs
  # Per-GPU-type configuration
  a100: |-
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 8  # A100 can handle 8 concurrent workloads
  t4: |-
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```

```bash
# Apply time-slicing config and patch ClusterPolicy
kubectl patch clusterpolicy gpu-cluster-policy \
  --type merge \
  -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'

# Label specific nodes with their GPU type for per-type config
kubectl label node gpu-node-a100-01 nvidia.com/device-plugin.config=a100
kubectl label node gpu-node-t4-01 nvidia.com/device-plugin.config=t4

# Verify time-sliced GPUs are visible
kubectl describe node gpu-node-01 | grep "nvidia.com/gpu"
# Capacity:
#   nvidia.com/gpu:    16  (4 physical GPUs * 4 replicas each)
```

### Time-Slicing Workload Pod

```yaml
# time-sliced-inference.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inference-service
  namespace: ml-inference
spec:
  replicas: 8  # Can run 8 pods per GPU with 4x time-slicing
  selector:
    matchLabels:
      app: inference-service
  template:
    metadata:
      labels:
        app: inference-service
    spec:
      nodeSelector:
        nvidia.com/gpu.product: T4
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: inference
          image: nvcr.io/nvidia/tritonserver:24.01-py3
          resources:
            limits:
              nvidia.com/gpu: "1"  # 1 time-sliced virtual GPU
            requests:
              memory: "4Gi"
              cpu: "2"
          env:
            - name: NVIDIA_DRIVER_CAPABILITIES
              value: "compute,utility"
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
```

## Section 5: Multi-Instance GPU (MIG) — Hardware-Level Partitioning

MIG (available on A100, H100, A30) divides a GPU into up to 7 isolated instances at the hardware level. Each instance has dedicated compute, memory, and cache — true isolation unlike time-slicing.

### Ampere MIG Profiles

```
A100 40GB MIG Profiles:
┌──────────────────────────────────────────────────────┐
│ Profile    │ Instances │ Memory  │ Compute (SM) │ Ce │
├──────────────────────────────────────────────────────┤
│ 1g.5gb     │     7     │  5 GB   │     14/108   │  0 │
│ 2g.10gb    │     3     │ 10 GB   │     28/108   │  0 │
│ 3g.20gb    │     2     │ 20 GB   │     42/108   │  0 │
│ 4g.20gb    │     1     │ 20 GB   │     56/108   │  0 │
│ 7g.40gb    │     1     │ 40 GB   │    108/108   │  1 │
│ 1g.5gb+me  │     1     │  5 GB   │     14/108   │  1 │  (media engines)
└──────────────────────────────────────────────────────┘

A100 80GB MIG Profiles:
┌──────────────────────────────────────────────────────┐
│ 1g.10gb    │     7     │ 10 GB   │     14/108   │  0 │
│ 2g.20gb    │     3     │ 20 GB   │     28/108   │  0 │
│ 3g.40gb    │     2     │ 40 GB   │     42/108   │  0 │
│ 4g.40gb    │     1     │ 40 GB   │     56/108   │  0 │
│ 7g.80gb    │     1     │ 80 GB   │    108/108   │  1 │
└──────────────────────────────────────────────────────┘
```

### Configure MIG Partitioning

```yaml
# mig-parted-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mig-parted-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    mig-configs:
      # All 7 A100 80GB GPUs split into 1g.10gb instances (7 each)
      all-1g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7

      # Mixed profile: 3g.40gb for large training + 1g.10gb for inference
      mixed-training-inference:
        - devices: [0,1]
          mig-enabled: true
          mig-devices:
            "3g.40gb": 2
        - devices: [2,3,4,5,6,7]
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7

      # Single full GPU (no MIG)
      all-disabled:
        - devices: all
          mig-enabled: false
```

### Apply MIG Configuration to Nodes

```bash
# Label nodes with their desired MIG configuration
kubectl label node gpu-node-a100-01 nvidia.com/mig.config=all-1g.10gb
kubectl label node gpu-node-a100-02 nvidia.com/mig.config=mixed-training-inference

# MIG Manager DaemonSet applies the configuration automatically
# Watch the migration:
kubectl get pods -n gpu-operator -l app=nvidia-mig-manager -w

# Verify MIG instances are visible
kubectl describe node gpu-node-a100-01 | grep -E "nvidia.com"

# With all-1g.10gb on an A100 80GB (4 GPUs):
# Capacity:
#   nvidia.com/mig-1g.10gb:     28  (7 instances * 4 GPUs)
```

### MIG-Aware Workload Scheduling

```yaml
# mig-training-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: llm-fine-tuning
  namespace: ml-training
spec:
  template:
    spec:
      restartPolicy: OnFailure
      nodeSelector:
        nvidia.com/gpu.product: A100-SXM4-80GB
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: training
          image: nvcr.io/nvidia/pytorch:24.01-py3
          command:
            - python3
            - /workspace/train.py
            - --model gpt2-large
            - --epochs 10
          resources:
            limits:
              nvidia.com/mig-3g.40gb: "1"  # Request a 3g.40gb MIG instance
            requests:
              memory: "32Gi"
              cpu: "8"
          env:
            - name: CUDA_VISIBLE_DEVICES
              value: "MIG-GPU-0/0/0"  # Filled by device plugin
---
# Small inference pod using 1g.10gb
apiVersion: apps/v1
kind: Deployment
metadata:
  name: small-inference
  namespace: ml-inference
spec:
  replicas: 7  # Can run 7 per A100 with 1g.10gb MIG
  template:
    spec:
      containers:
        - name: inference
          image: nvcr.io/nvidia/tritonserver:24.01-py3
          resources:
            limits:
              nvidia.com/mig-1g.10gb: "1"
```

## Section 6: GPU Resource Quotas

```yaml
# gpu-resource-quota.yaml
---
# Quota for ML training namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota-training
  namespace: ml-training
spec:
  hard:
    requests.nvidia.com/gpu: "16"
    limits.nvidia.com/gpu: "16"
    requests.nvidia.com/mig-3g.40gb: "8"
    limits.nvidia.com/mig-3g.40gb: "8"
    # CPU and memory quotas proportional to GPU allocation
    requests.cpu: "128"
    requests.memory: "512Gi"
---
# Quota for inference namespace (time-sliced GPUs)
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota-inference
  namespace: ml-inference
spec:
  hard:
    requests.nvidia.com/gpu: "32"   # 32 time-sliced virtual GPUs
    limits.nvidia.com/gpu: "32"
---
# LimitRange to enforce GPU requests equal limits
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-limit-range
  namespace: ml-training
spec:
  limits:
    - type: Container
      default:
        nvidia.com/gpu: "0"
      defaultRequest:
        nvidia.com/gpu: "0"
      # Ensure requests == limits for GPU (device plugin requirement)
      maxLimitRequestRatio:
        nvidia.com/gpu: "1"
```

## Section 7: DCGM Exporter Monitoring

### DCGM Metrics Configuration

```yaml
# dcgm-metrics-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcgm-metrics-config
  namespace: gpu-operator
data:
  metrics.csv: |
    # DCGM_FI_DEV_GPU_UTIL: GPU utilization (%)
    DCGM_FI_DEV_GPU_UTIL, gauge, GPU utilization (in %).
    # DCGM_FI_DEV_MEM_COPY_UTIL: Memory bandwidth utilization
    DCGM_FI_DEV_MEM_COPY_UTIL, gauge, Memory bandwidth utilization (in %).
    # DCGM_FI_DEV_ENC_UTIL: Encoder utilization
    DCGM_FI_DEV_ENC_UTIL, gauge, Encoder utilization (in %).
    # DCGM_FI_DEV_DEC_UTIL: Decoder utilization
    DCGM_FI_DEV_DEC_UTIL, gauge, Decoder utilization (in %).
    # DCGM_FI_DEV_FB_FREE: Free framebuffer memory (MiB)
    DCGM_FI_DEV_FB_FREE, gauge, Framebuffer memory free (in MiB).
    # DCGM_FI_DEV_FB_USED: Used framebuffer memory (MiB)
    DCGM_FI_DEV_FB_USED, gauge, Framebuffer memory used (in MiB).
    # DCGM_FI_DEV_SM_CLOCK: SM clock frequency
    DCGM_FI_DEV_SM_CLOCK, gauge, SM clock frequency (in MHz).
    # DCGM_FI_DEV_MEM_CLOCK: Memory clock frequency
    DCGM_FI_DEV_MEM_CLOCK, gauge, Memory clock frequency (in MHz).
    # DCGM_FI_DEV_GPU_TEMP: GPU temperature
    DCGM_FI_DEV_GPU_TEMP, gauge, GPU temperature (in C).
    # DCGM_FI_DEV_POWER_USAGE: Power consumption
    DCGM_FI_DEV_POWER_USAGE, gauge, Power draw (in W).
    # DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION: Total energy
    DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION, counter, Total energy consumption since boot (in mJ).
    # DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL: NVLink bandwidth
    DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL, counter, Total NVLink bandwidth (in KB).
    # Throttle reasons
    DCGM_FI_DEV_CLOCK_THROTTLE_REASONS, gauge, Current clock throttle reasons.
    # PCIe metrics
    DCGM_FI_DEV_PCIE_TX_THROUGHPUT, counter, PCIe transmit throughput (in KB/s).
    DCGM_FI_DEV_PCIE_RX_THROUGHPUT, counter, PCIe receive throughput (in KB/s).
    # XID errors (critical for hardware health)
    DCGM_FI_DEV_XID_ERRORS, gauge, Value of XID error for the GPU.
    # MIG metrics (when MIG is enabled)
    DCGM_FI_PROF_GR_ENGINE_ACTIVE, gauge, Ratio of time the graphics engine is active.
    DCGM_FI_PROF_SM_ACTIVE, gauge, Ratio of cycles an SM has at least 1 warp assigned.
    DCGM_FI_PROF_SM_OCCUPANCY, gauge, Ratio of warps resident vs max warps per SM.
    DCGM_FI_PROF_PIPE_TENSOR_ACTIVE, gauge, Ratio of cycles Tensor Core pipe is active.
    DCGM_FI_PROF_DRAM_ACTIVE, gauge, Ratio of cycles Device Memory interface is active.
    DCGM_FI_PROF_PCIE_TX_BYTES, counter, PCIe transmit bytes.
    DCGM_FI_PROF_PCIE_RX_BYTES, counter, PCIe receive bytes.
    DCGM_FI_PROF_NVLINK_TX_BYTES, counter, NVLink transmit bytes.
    DCGM_FI_PROF_NVLINK_RX_BYTES, counter, NVLink receive bytes.
```

### Prometheus Alerting Rules for GPUs

```yaml
# gpu-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gpu-alerts
  namespace: monitoring
spec:
  groups:
    - name: gpu.rules
      interval: 30s
      rules:
        - alert: GPUHighTemperature
          expr: DCGM_FI_DEV_GPU_TEMP > 85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU temperature high on {{ $labels.instance }}"
            description: "GPU {{ $labels.gpu }} on {{ $labels.instance }} temperature is {{ $value }}°C"

        - alert: GPUCriticalTemperature
          expr: DCGM_FI_DEV_GPU_TEMP > 90
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "GPU temperature critical on {{ $labels.instance }}"

        - alert: GPUXIDError
          expr: DCGM_FI_DEV_XID_ERRORS > 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "GPU XID error detected on {{ $labels.instance }}"
            description: "XID error {{ $value }} on GPU {{ $labels.gpu }} — potential hardware fault"

        - alert: GPULowUtilization
          expr: DCGM_FI_DEV_GPU_UTIL < 20 and on(instance) kube_pod_container_resource_limits{resource="nvidia_com_gpu"} > 0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "GPU underutilized — review workload scheduling"

        - alert: GPUMemoryExhausted
          expr: DCGM_FI_DEV_FB_FREE < 1024  # < 1 GiB free
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU memory nearly full on {{ $labels.instance }}"
```

## Section 8: Multi-GPU Training Jobs

### Distributed Training with PyTorch and NCCL

```yaml
# pytorch-distributed-job.yaml
apiVersion: "kubeflow.org/v1"
kind: PyTorchJob
metadata:
  name: llm-training-distributed
  namespace: ml-training
spec:
  pytorchReplicaSpecs:
    Master:
      replicas: 1
      restartPolicy: OnFailure
      template:
        spec:
          tolerations:
            - key: nvidia.com/gpu
              operator: Exists
              effect: NoSchedule
          nodeSelector:
            nvidia.com/gpu.product: A100-SXM4-80GB
          containers:
            - name: pytorch
              image: nvcr.io/nvidia/pytorch:24.01-py3
              resources:
                limits:
                  nvidia.com/gpu: "8"  # All 8 GPUs on a DGX A100
                requests:
                  memory: "512Gi"
                  cpu: "64"
              env:
                - name: NCCL_DEBUG
                  value: "WARN"
                - name: NCCL_SOCKET_IFNAME
                  value: "eth0"
                - name: NCCL_IB_DISABLE
                  value: "0"
              volumeMounts:
                - name: dshm
                  mountPath: /dev/shm
                - name: training-data
                  mountPath: /data
          volumes:
            - name: dshm
              emptyDir:
                medium: Memory
                sizeLimit: "128Gi"
            - name: training-data
              persistentVolumeClaim:
                claimName: training-dataset-pvc

    Worker:
      replicas: 7
      restartPolicy: OnFailure
      template:
        spec:
          tolerations:
            - key: nvidia.com/gpu
              operator: Exists
              effect: NoSchedule
          nodeSelector:
            nvidia.com/gpu.product: A100-SXM4-80GB
          containers:
            - name: pytorch
              image: nvcr.io/nvidia/pytorch:24.01-py3
              resources:
                limits:
                  nvidia.com/gpu: "8"
                requests:
                  memory: "512Gi"
                  cpu: "64"
              volumes:
                - name: dshm
                  emptyDir:
                    medium: Memory
```

## Section 9: GPU Scheduling Best Practices

### Priority Classes for GPU Workloads

```yaml
# gpu-priority-classes.yaml
---
# Production inference gets highest priority
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-inference-critical
value: 1000000
globalDefault: false
description: "Production inference workloads requiring guaranteed GPU access"
---
# Training jobs get medium priority (can be preempted)
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-training-batch
value: 100000
globalDefault: false
description: "Batch ML training jobs — preemptible"
---
# Experimental/development work gets lowest priority
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-dev-experimental
value: 1000
preemptionPolicy: Never
description: "Development GPU workloads — never preempts others"
```

### Pod Anti-Affinity for Training Pods

```yaml
# training-pod-anti-affinity.yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        # Don't schedule two workers on same node (GPU topology-aware)
        - labelSelector:
            matchLabels:
              job-name: llm-training-distributed
          topologyKey: kubernetes.io/hostname
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: nvidia.com/gpu.product
                operator: In
                values:
                  - A100-SXM4-80GB
                  - H100-SXM5-80GB
              - key: nvidia.com/gpu.count
                operator: Gt
                values:
                  - "4"  # Require multi-GPU nodes
```

This guide provides the operational foundation for enterprise GPU workload management on Kubernetes. The GPU Operator's automated lifecycle management, combined with MIG hardware partitioning, time-slicing for inference density, and DCGM-based observability, enables platform teams to operate GPU infrastructure with the same confidence as CPU workloads.
