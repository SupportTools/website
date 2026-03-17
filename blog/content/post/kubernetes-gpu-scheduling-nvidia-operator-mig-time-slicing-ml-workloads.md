---
title: "Kubernetes GPU Scheduling: NVIDIA GPU Operator and Time-Slicing for ML Workloads"
date: 2030-10-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GPU", "NVIDIA", "Machine Learning", "DCGM", "MIG", "CUDA"]
categories:
- Kubernetes
- Machine Learning
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise GPU scheduling guide covering NVIDIA GPU Operator components, GPU device plugin, MIG configuration, time-slicing for multiple pods, GPU resource limits, CUDA version management, and monitoring with DCGM Exporter."
more_link: "yes"
url: "/kubernetes-gpu-scheduling-nvidia-operator-mig-time-slicing-ml-workloads/"
---

Running GPU workloads in Kubernetes without the NVIDIA GPU Operator means managing driver installations, device plugins, container runtime configuration, and monitoring tooling independently across every node — and re-doing all of it after every OS upgrade. The GPU Operator bundles all of these components into a single Helm-managed operator that handles the full GPU software stack lifecycle declaratively.

<!--more-->

## GPU Operator Architecture

The NVIDIA GPU Operator manages several components through a cluster-wide `ClusterPolicy` custom resource:

| Component | Function |
|---|---|
| GPU Driver | Kernel module for NVIDIA GPUs |
| Container Toolkit | nvidia-container-runtime hook |
| Device Plugin | Exposes `nvidia.com/gpu` resources to kubelet |
| DCGM Exporter | GPU metrics for Prometheus |
| GPU Feature Discovery | Node labels for GPU capabilities |
| MIG Manager | Partitions A100/H100 GPUs into instances |
| CUDA Validator | Validates CUDA functionality on each node |
| Operator Validator | Runs end-to-end validation after deployment |

### Prerequisites

```bash
# Verify GPU hardware is detected
lspci | grep -i nvidia

# Confirm kernel headers are present (required for driver compilation)
ls /usr/src/linux-headers-$(uname -r)

# Ubuntu
sudo apt-get install -y linux-headers-$(uname -r)

# RHEL/AlmaLinux
sudo dnf install -y kernel-devel-$(uname -r) kernel-headers-$(uname -r)
```

---

## Installing the GPU Operator

### Adding the NVIDIA Helm Repository

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# List available versions
helm search repo nvidia/gpu-operator --versions | head -20
```

### Operator Installation

```bash
# Create the namespace
kubectl create namespace gpu-operator

# Install with default configuration
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --set driver.enabled=true \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true \
  --set gfd.enabled=true \
  --wait
```

For clusters where drivers are pre-installed on nodes (common in air-gapped environments):

```bash
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --set driver.enabled=false \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true
```

### ClusterPolicy: The Central Configuration Object

The GPU Operator creates and manages a `ClusterPolicy` that controls every component:

```yaml
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
    version: "535.104.12"
    repoConfig:
      configMapName: ""
    licensingConfig:
      nlsEnabled: false
    virtualTopology:
      config: ""
    kernelModuleConfig:
      configMapName: ""
  toolkit:
    enabled: true
    version: "v1.14.3-ubuntu20.04"
    installDir: "/usr/local/nvidia"
  devicePlugin:
    enabled: true
    version: "v0.14.1"
    config:
      name: ""
      default: ""
  dcgm:
    enabled: true
  dcgmExporter:
    enabled: true
    config:
      name: ""
    serviceMonitor:
      enabled: true
      interval: 15s
      honorLabels: false
      additionalLabels:
        app.kubernetes.io/component: gpu-monitoring
  gfd:
    enabled: true
    version: "v0.8.2"
  migManager:
    enabled: true
  validator:
    plugin:
      env:
        - name: WITH_WORKLOAD
          value: "true"
  vgpuDeviceManager:
    enabled: false
  vfioManager:
    enabled: false
```

Apply changes to an existing policy:

```bash
kubectl patch clusterpolicy gpu-cluster-policy \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/dcgmExporter/serviceMonitor/enabled", "value": true}]'
```

---

## Verifying GPU Discovery

After the operator deploys all components, verify GPU resources are available:

```bash
# Check GPU Operator pods
kubectl get pods -n gpu-operator

# Verify node labels applied by GPU Feature Discovery
kubectl get node gpu-node-01 -o json | jq '.metadata.labels | with_entries(select(.key | startswith("nvidia")))'

# Expected labels:
# "nvidia.com/cuda.driver.major": "535",
# "nvidia.com/cuda.driver.minor": "104",
# "nvidia.com/cuda.driver.rev": "12",
# "nvidia.com/cuda.runtime.major": "12",
# "nvidia.com/cuda.runtime.minor": "2",
# "nvidia.com/gfd.timestamp": "1693000000",
# "nvidia.com/gpu.compute.major": "8",
# "nvidia.com/gpu.compute.minor": "0",
# "nvidia.com/gpu.count": "8",
# "nvidia.com/gpu.family": "ampere",
# "nvidia.com/gpu.memory": "81920",   # MB for A100 80GB
# "nvidia.com/gpu.product": "A100-SXM4-80GB",
# "nvidia.com/mig.capable": "true",
# "nvidia.com/mig.strategy": "none"

# Check allocatable GPU resources
kubectl describe node gpu-node-01 | grep -A5 "Allocatable:"
# nvidia.com/gpu: 8

# Run validation job
kubectl logs -n gpu-operator -l app=nvidia-operator-validator
```

---

## Basic GPU Pod Scheduling

### Requesting GPU Resources

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: cuda-sample
  namespace: ml-workloads
spec:
  restartPolicy: OnFailure
  runtimeClassName: nvidia
  containers:
    - name: cuda-sample
      image: nvcr.io/nvidia/cuda:12.2.0-runtime-ubuntu20.04
      command:
        - nvidia-smi
      resources:
        limits:
          nvidia.com/gpu: 1
        requests:
          nvidia.com/gpu: 1
```

```bash
# Watch the pod schedule and run
kubectl logs cuda-sample -n ml-workloads

# Expected: nvidia-smi output showing assigned GPU
# +-----------------------------------------------------------------------------+
# | NVIDIA-SMI 535.104.12   Driver Version: 535.104.12   CUDA Version: 12.2     |
# |-------------------------------+----------------------+----------------------+
# | GPU  Name        Persistence-M| Bus-Id        Disp.A | Volatile Uncorr. ECC |
# | Fan  Temp  Perf  Pwr:Usage/Cap|         Memory-Usage | GPU-Util  Compute M. |
# |===============================+======================+======================|
# |   0  A100-SXM4-80GB      On   | 00000000:00:1E.0 Off |                    0 |
# | N/A   34C    P0    61W / 400W |      0MiB / 81920MiB |      0%      Default |
# +-----------------------------------------------------------------------------+
```

### Multi-GPU Workloads

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: distributed-training
  namespace: ml-workloads
spec:
  completions: 4
  parallelism: 4
  template:
    spec:
      restartPolicy: OnFailure
      runtimeClassName: nvidia
      containers:
        - name: training
          image: nvcr.io/nvidia/pytorch:23.10-py3
          command:
            - python
            - /workspace/train.py
            - --distributed
          env:
            - name: NCCL_DEBUG
              value: "INFO"
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
          resources:
            limits:
              nvidia.com/gpu: 2
              memory: 64Gi
              cpu: "16"
            requests:
              nvidia.com/gpu: 2
              memory: 32Gi
              cpu: "8"
          volumeMounts:
            - name: training-data
              mountPath: /data
            - name: shared-memory
              mountPath: /dev/shm
      volumes:
        - name: training-data
          persistentVolumeClaim:
            claimName: training-dataset-pvc
        - name: shared-memory
          emptyDir:
            medium: Memory
            sizeLimit: 16Gi
```

---

## MIG: Multi-Instance GPU

A100 and H100 GPUs support MIG (Multi-Instance GPU), which partitions a single physical GPU into multiple isolated GPU instances. Each instance has dedicated compute engines, memory, and cache — providing true hardware isolation unlike time-slicing.

### MIG Profiles for the A100 80GB

| Profile | Compute | Memory | Instances per GPU |
|---|---|---|---|
| 1g.10gb | 1/7 GPC | 10 GB | 7 |
| 2g.20gb | 2/7 GPC | 20 GB | 3 |
| 3g.40gb | 3/7 GPC | 40 GB | 2 |
| 4g.40gb | 4/7 GPC | 40 GB | 1 |
| 7g.80gb | 7/7 GPC | 80 GB | 1 (full GPU) |

### Enabling MIG on Nodes

```bash
# Label nodes for MIG strategy
kubectl label node gpu-node-01 nvidia.com/mig.config=all-1g.10gb

# For mixed profiles:
kubectl label node gpu-node-02 nvidia.com/mig.config=mixed
```

### MIG Configuration via ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: default-mig-parted-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    mig-configs:
      all-1g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7
      all-2g.20gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "2g.20gb": 3
      all-3g.40gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "3g.40gb": 2
      mixed:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.10gb": 2
            "2g.20gb": 1
            "3g.40gb": 1
      all-disabled:
        - devices: all
          mig-enabled: false
```

### Requesting MIG Resources

When MIG is enabled, the device plugin exposes per-profile resources:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: inference-pod
  namespace: ml-workloads
spec:
  runtimeClassName: nvidia
  containers:
    - name: inference
      image: nvcr.io/nvidia/tritonserver:23.10-py3
      resources:
        limits:
          nvidia.com/mig-1g.10gb: 1  # Request one 1g.10gb MIG instance
```

```bash
# Verify MIG instances on a node
kubectl exec -n gpu-operator daemonset/nvidia-mig-manager -- nvidia-smi mig -lgip

# Check MIG resource availability
kubectl describe node gpu-node-01 | grep "nvidia.com/mig"
# nvidia.com/mig-1g.10gb:  7
# nvidia.com/mig-2g.20gb:  0
# nvidia.com/mig-3g.40gb:  0
```

---

## GPU Time-Slicing

Time-slicing allows multiple pods to share a single GPU through time multiplexing. Unlike MIG, there is no memory isolation — each container can access all GPU memory, and the GPU switches between them. This is suitable for inference workloads with low memory requirements.

### Configuring Time-Slicing

```yaml
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
            replicas: 4
```

Apply the time-slicing configuration:

```bash
# Update the ClusterPolicy to reference the config
kubectl patch clusterpolicy gpu-cluster-policy \
  --type='merge' \
  -p '{
    "spec": {
      "devicePlugin": {
        "config": {
          "name": "time-slicing-config",
          "default": "any"
        }
      }
    }
  }'

# Verify: each physical GPU now appears as 4 allocatable units
kubectl describe node gpu-node-01 | grep "nvidia.com/gpu"
# nvidia.com/gpu: 32    (8 physical GPUs × 4 slices)
```

### Node Labeling for Time-Slicing

```bash
# Label specific nodes for time-slicing
kubectl label node gpu-node-03 nvidia.com/device-plugin.config=time-slicing

# Different configurations for different node types
kubectl label node gpu-node-01 nvidia.com/device-plugin.config=mig-config
kubectl label node gpu-node-03 nvidia.com/device-plugin.config=time-slicing-4x
kubectl label node gpu-node-04 nvidia.com/device-plugin.config=time-slicing-8x
```

---

## CUDA Version Management

Different ML frameworks require specific CUDA versions. The GPU Operator manages the driver version, and container images carry their own CUDA toolkit.

### Checking CUDA Compatibility

```bash
# Check driver CUDA support
nvidia-smi | grep "CUDA Version"
# Driver: 535.104.12 supports CUDA 12.2

# Verify container CUDA toolkit version
kubectl exec -it ml-pod -- nvcc --version
# Cuda compilation tools, release 11.8, V11.8.89
```

### Pinning CUDA Versions per Workload

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tensorflow-serving
  namespace: ml-workloads
spec:
  replicas: 2
  selector:
    matchLabels:
      app: tensorflow-serving
  template:
    metadata:
      labels:
        app: tensorflow-serving
    spec:
      runtimeClassName: nvidia
      nodeSelector:
        # GFD labels allow targeting by CUDA capability
        nvidia.com/cuda.driver.major: "12"
        nvidia.com/gpu.family: ampere
      containers:
        - name: serving
          image: tensorflow/serving:2.13.0-gpu
          env:
            - name: NVIDIA_VISIBLE_DEVICES
              value: "all"
            - name: NVIDIA_DRIVER_CAPABILITIES
              value: "compute,utility"
            - name: TF_GPU_MEMORY_FRACTION
              value: "0.8"
          resources:
            limits:
              nvidia.com/gpu: 1
              memory: 16Gi
              cpu: "8"
```

---

## Monitoring GPU Utilization with DCGM Exporter

The DCGM (Data Center GPU Manager) Exporter provides GPU metrics in Prometheus format.

### Default Metrics

```bash
# Access DCGM metrics directly
kubectl port-forward -n gpu-operator svc/nvidia-dcgm-exporter 9400:9400 &
curl http://localhost:9400/metrics | grep -E "^DCGM_"
```

Key metrics:

```promql
# GPU utilization percentage
DCGM_FI_DEV_GPU_UTIL{gpu="0",modelName="A100-SXM4-80GB"}

# GPU memory usage
DCGM_FI_DEV_FB_USED{gpu="0"}
DCGM_FI_DEV_FB_FREE{gpu="0"}

# GPU temperature
DCGM_FI_DEV_GPU_TEMP{gpu="0"}

# Power draw in watts
DCGM_FI_DEV_POWER_USAGE{gpu="0"}

# PCIe throughput
DCGM_FI_DEV_PCIE_TX_THROUGHPUT{gpu="0"}
DCGM_FI_DEV_PCIE_RX_THROUGHPUT{gpu="0"}

# SM clock speed
DCGM_FI_DEV_SM_CLOCK{gpu="0"}

# NVLink bandwidth (for multi-GPU topologies)
DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL{gpu="0"}

# Correctable and uncorrectable ECC errors
DCGM_FI_DEV_ECC_DBE_VOL_TOTAL{gpu="0"}
DCGM_FI_DEV_ECC_SBE_VOL_TOTAL{gpu="0"}
```

### Custom DCGM Metrics Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: custom-dcgm-metrics
  namespace: gpu-operator
data:
  dcgm-metrics.csv: |
    # Format: Field ID, Prometheus metric name, help string
    # GPU Core Metrics
    DCGM_FI_DEV_GPU_UTIL,   DCGM_FI_DEV_GPU_UTIL,   GPU utilization (in %).
    DCGM_FI_DEV_MEM_COPY_UTIL, DCGM_FI_DEV_MEM_COPY_UTIL, Memory utilization (in %).
    DCGM_FI_DEV_SM_CLOCK,   DCGM_FI_DEV_SM_CLOCK,   SM clock frequency (in MHz).
    DCGM_FI_DEV_MEM_CLOCK,  DCGM_FI_DEV_MEM_CLOCK,  Memory clock frequency (in MHz).
    # Memory
    DCGM_FI_DEV_FB_FREE,    DCGM_FI_DEV_FB_FREE,    Framebuffer memory free (in MiB).
    DCGM_FI_DEV_FB_USED,    DCGM_FI_DEV_FB_USED,    Framebuffer memory used (in MiB).
    # Temperature and Power
    DCGM_FI_DEV_GPU_TEMP,   DCGM_FI_DEV_GPU_TEMP,   GPU temperature (in C).
    DCGM_FI_DEV_POWER_USAGE,DCGM_FI_DEV_POWER_USAGE,Power draw (in W).
    # NVLink
    DCGM_FI_DEV_NVLINK_BANDWIDTH_L0, DCGM_FI_DEV_NVLINK_BANDWIDTH_L0, Total bandwidth on NVLink 0.
    # XID Errors
    DCGM_FI_DEV_XID_ERRORS, DCGM_FI_DEV_XID_ERRORS, Value of the last XID error encountered.
    # Per-process GPU usage (requires DCGM Pro)
    DCGM_FI_DEV_PROCESS_NAME, DCGM_FI_DEV_PROCESS_NAME, Process name.
```

Update the operator to use the custom metrics:

```bash
kubectl patch clusterpolicy gpu-cluster-policy \
  --type='merge' \
  -p '{
    "spec": {
      "dcgmExporter": {
        "config": {
          "name": "custom-dcgm-metrics"
        }
      }
    }
  }'
```

### Grafana Dashboard Alerts

```yaml
groups:
  - name: gpu-alerts
    rules:
      - alert: GPUHighTemperature
        expr: DCGM_FI_DEV_GPU_TEMP > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU {{ $labels.gpu }} on {{ $labels.instance }} temperature high"
          description: "GPU temperature is {{ $value }}°C, threshold is 85°C"

      - alert: GPUHighMemoryUsage
        expr: |
          DCGM_FI_DEV_FB_USED /
          (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100 > 90
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "GPU {{ $labels.gpu }} memory utilization above 90%"

      - alert: GPUXIDError
        expr: increase(DCGM_FI_DEV_XID_ERRORS[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "GPU XID error detected on {{ $labels.instance }}"
          description: "XID error {{ $value }} detected, indicating potential hardware failure"

      - alert: GPUUncorrectableECCError
        expr: increase(DCGM_FI_DEV_ECC_DBE_VOL_TOTAL[1h]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Uncorrectable ECC error on GPU {{ $labels.gpu }}"
          description: "Double-bit ECC errors indicate GPU memory corruption"
```

---

## GPU Node Maintenance

### Draining GPU Nodes

```bash
# Cordon the node to prevent new scheduling
kubectl cordon gpu-node-01

# Check running GPU workloads
kubectl get pods --all-namespaces \
  --field-selector spec.nodeName=gpu-node-01 \
  -o wide | grep -v "Completed"

# Drain the node (terminates GPU pods gracefully)
kubectl drain gpu-node-01 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60

# Update driver or perform maintenance...

# Return to service
kubectl uncordon gpu-node-01
```

### Validating Driver Upgrades

The GPU Operator includes a validation container that runs post-deployment:

```bash
# Check validation status after operator upgrade
kubectl get pods -n gpu-operator -l app=nvidia-operator-validator

kubectl logs -n gpu-operator \
  -l app=nvidia-operator-validator \
  --tail=100

# Manual CUDA validation
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: cuda-validate
  namespace: gpu-operator
spec:
  restartPolicy: Never
  runtimeClassName: nvidia
  containers:
    - name: validate
      image: nvcr.io/nvidia/cuda:12.2.0-base-ubuntu20.04
      command:
        - sh
        - -c
        - |
          nvidia-smi -q | head -30
          python3 -c "import ctypes; ctypes.CDLL('libcuda.so.1'); print('CUDA library loaded successfully')"
      resources:
        limits:
          nvidia.com/gpu: 1
EOF

kubectl logs cuda-validate -n gpu-operator
kubectl delete pod cuda-validate -n gpu-operator
```

---

## Scheduling Strategies for ML Workloads

### Node Affinity for GPU Selection

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: nvidia.com/gpu.family
                operator: In
                values:
                  - ampere
                  - hopper
              - key: nvidia.com/gpu.memory
                operator: Gt
                values:
                  - "40960"  # > 40 GB
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: nvidia.com/gpu.product
                operator: In
                values:
                  - H100-SXM5-80GB
                  - A100-SXM4-80GB
```

### Resource Quotas for GPU Namespaces

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: ml-workloads
spec:
  hard:
    requests.nvidia.com/gpu: "16"
    limits.nvidia.com/gpu: "16"
    requests.memory: 256Gi
    limits.memory: 512Gi
    requests.cpu: "64"
    limits.cpu: "128"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-limit-range
  namespace: ml-workloads
spec:
  limits:
    - type: Container
      default:
        nvidia.com/gpu: "1"
      defaultRequest:
        nvidia.com/gpu: "1"
      max:
        nvidia.com/gpu: "8"
```

The NVIDIA GPU Operator transforms complex per-node GPU software management into a declarative Kubernetes-native workflow. Combining MIG for strict isolation, time-slicing for density, DCGM for observability, and proper scheduling policies creates a production-ready platform capable of supporting both training and inference workloads efficiently.
