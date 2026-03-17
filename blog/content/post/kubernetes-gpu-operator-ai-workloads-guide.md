---
title: "Kubernetes GPU Operator for AI/ML: NVIDIA Driver Management and Workload Scheduling"
date: 2028-03-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GPU", "NVIDIA", "AI/ML", "GPU Operator", "MLOps", "DCGM"]
categories: ["Kubernetes", "AI/ML"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to NVIDIA GPU Operator on Kubernetes, covering component stack installation, NodeFeatureDiscovery, resource limits, time-slicing, MIG configuration, DCGM monitoring, and scheduling AI/ML workloads including Jupyter notebooks."
more_link: "yes"
url: "/kubernetes-gpu-operator-ai-workloads-guide/"
---

Running AI and ML workloads on Kubernetes requires more than a GPU node—it requires lifecycle management of NVIDIA drivers, container runtime configuration, device plugin registration, and observability into GPU health and utilization. The NVIDIA GPU Operator automates all of these components as Kubernetes-native resources, replacing a fragile collection of DaemonSets and manual node configuration steps with a single operator-managed stack.

This guide covers the GPU Operator component architecture, installation, time-slicing and MIG configuration, DCGM-based monitoring, workload scheduling patterns, and production Jupyter notebook deployment.

<!--more-->

## GPU Operator Component Stack

```
GPU Operator (cluster-wide operator)
  ├── NVIDIA Driver DaemonSet        — installs/updates NVIDIA kernel module
  ├── Container Toolkit DaemonSet    — configures containerd/CRI runtime
  ├── Device Plugin DaemonSet        — advertises nvidia.com/gpu resources
  ├── DCGM Exporter DaemonSet        — exposes GPU metrics for Prometheus
  ├── GPU Feature Discovery          — labels nodes with GPU capabilities
  ├── CUDA Validator                 — validates toolkit installation
  └── Node Feature Discovery         — detects PCI/CPU/OS features
```

### Prerequisites

```bash
# Verify GPU node hardware and kernel
lspci | grep -i nvidia
# Output: 00:06.0 3D controller: NVIDIA Corporation GA100 [A100 SXM4 80GB] (rev a1)

# Check kernel version (>= 4.15 required)
uname -r

# Verify no conflicting NVIDIA packages on host (GPU Operator manages these)
dpkg -l | grep -i nvidia  # Should be empty for GPU Operator managed nodes

# Required kernel modules (loaded by GPU Operator driver)
# nouveau driver must be blacklisted
cat /etc/modprobe.d/blacklist-nouveau.conf
# blacklist nouveau
# options nouveau modeset=0
```

## Installation with Helm

```bash
# Add NVIDIA Helm repository
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# Install Node Feature Discovery (prerequisite)
helm repo add nfd https://kubernetes-sigs.github.io/node-feature-discovery/charts
helm install nfd nfd/node-feature-discovery \
  --namespace node-feature-discovery \
  --create-namespace \
  --set worker.config.sources.pci.deviceClassWhitelist=["0200","0207","0300","0302"] \
  --wait

# Install GPU Operator
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set driver.enabled=true \
  --set driver.version="535.154.05" \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true \
  --set gfd.enabled=true \
  --set migManager.enabled=true \
  --wait

# Verify installation
kubectl get pods -n gpu-operator
kubectl get node -o json | jq '.items[].metadata.labels | keys[] | select(startswith("nvidia"))'
```

### Custom Driver Version Pin

```yaml
# gpu-operator-values.yaml — production recommended settings
driver:
  enabled: true
  version: "535.154.05"
  image: nvcr.io/nvidia/driver
  repository: nvcr.io/nvidia
  # Use pre-compiled drivers when available (faster startup)
  rdma:
    enabled: false  # Enable for RDMA-capable (InfiniBand) nodes
  # Driver upgrade strategy
  upgradePolicy:
    autoUpgrade: false  # Manage upgrades manually in production
    podDeletion:
      force: false
      deleteEmptyDir: false
    drain:
      enable: true
      deleteEmptyDir: false
      force: false
      timeoutSeconds: 300

toolkit:
  enabled: true
  version: "1.14.5-centos7"

devicePlugin:
  enabled: true
  config:
    name: gpu-device-plugin-config
    default: "default"

dcgmExporter:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 15s
  config:
    name: dcgm-metrics-config

migManager:
  enabled: true
  config:
    name: mig-parted-config
```

## NodeFeatureDiscovery Labels

After installation, GPU nodes receive rich labels:

```bash
kubectl get node gpu-worker-01 --show-labels | tr ',' '\n' | grep nvidia
# nvidia.com/cuda.driver.major=535
# nvidia.com/cuda.driver.minor=154
# nvidia.com/cuda.driver.rev=05
# nvidia.com/cuda.runtime.major=12
# nvidia.com/cuda.runtime.minor=2
# nvidia.com/gfd.timestamp=1735000000
# nvidia.com/gpu.compute.major=8
# nvidia.com/gpu.compute.minor=0
# nvidia.com/gpu.count=8
# nvidia.com/gpu.family=ampere
# nvidia.com/gpu.machine=DGX-A100
# nvidia.com/gpu.memory=81920
# nvidia.com/gpu.present=true
# nvidia.com/gpu.product=A100-SXM4-80GB
# nvidia.com/gpu.replicas=1
# nvidia.com/mig.capable=true
# nvidia.com/mig.strategy=none
```

## Resource Limits and Requests

```yaml
# Request exactly one GPU per pod
apiVersion: v1
kind: Pod
metadata:
  name: gpu-workload
  namespace: ml-jobs
spec:
  containers:
    - name: training
      image: nvcr.io/nvidia/pytorch:23.10-py3
      resources:
        requests:
          nvidia.com/gpu: 1
        limits:
          nvidia.com/gpu: 1  # Requests must equal limits for GPU resources
      command: ["python", "train.py", "--epochs", "100"]
  nodeSelector:
    nvidia.com/gpu.present: "true"
  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule
```

### Multi-GPU Training Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: distributed-training
  namespace: ml-jobs
spec:
  parallelism: 4
  completions: 4
  completionMode: Indexed
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: trainer
          image: registry.support.tools/pytorch-trainer:v3.2.0
          resources:
            requests:
              nvidia.com/gpu: "2"
              cpu: "16"
              memory: 64Gi
            limits:
              nvidia.com/gpu: "2"
              cpu: "16"
              memory: 64Gi
          env:
            - name: WORLD_SIZE
              value: "8"  # 4 pods * 2 GPUs each
            - name: POD_INDEX
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
            - name: MASTER_ADDR
              value: "distributed-training-0.distributed-training.ml-jobs.svc.cluster.local"
            - name: MASTER_PORT
              value: "29500"
          volumeMounts:
            - name: shared-data
              mountPath: /data
            - name: checkpoints
              mountPath: /checkpoints
      volumes:
        - name: shared-data
          persistentVolumeClaim:
            claimName: training-dataset-pvc
        - name: checkpoints
          persistentVolumeClaim:
            claimName: checkpoint-storage-pvc
      nodeSelector:
        nvidia.com/gpu.product: "A100-SXM4-80GB"
        nvidia.com/gpu.count: "8"
```

## Time-Slicing Configuration

GPU time-slicing allows multiple pods to share a single GPU through time-multiplexed scheduling. This is suitable for inference workloads with intermittent GPU usage, not for training:

```yaml
# ConfigMap for device plugin time-slicing config
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-device-plugin-config
  namespace: gpu-operator
data:
  default: |
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        renameByDefault: false
        failRequestsGreaterThanOne: false
        resources:
          - name: nvidia.com/gpu
            replicas: 4  # 4 virtual GPUs per physical GPU
  # Per-node override using GPU product label
  A100-SXM4-80GB: |
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 8
  RTX-3090: |
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 2
```

```bash
# Apply the config via ClusterPolicy
kubectl patch clusterpolicy gpu-cluster-policy \
  --type=merge \
  -p '{"spec": {"devicePlugin": {"config": {"name": "gpu-device-plugin-config", "default": "default"}}}}'

# After applying, each physical GPU shows as 4 (or configured replicas) resources
kubectl get node gpu-worker-01 -o json | \
  jq '.status.allocatable | {cpu, "nvidia.com/gpu"}'
# { "cpu": "96", "nvidia.com/gpu": "32" }  <- 8 GPUs * 4 replicas
```

## MIG (Multi-Instance GPU) Configuration

MIG partitions A100/H100 GPUs into isolated compute and memory slices for workloads with strict isolation requirements:

```yaml
# ConfigMap for MIG partition configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: mig-parted-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    mig-configs:
      # 7 equal slices — good for inference serving
      all-1g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7

      # Mixed profile — large for training, small for inference
      mixed-training-inference:
        - devices: [0, 1, 2, 3]
          mig-enabled: true
          mig-devices:
            "3g.40gb": 2  # 2 large slices for training
        - devices: [4, 5, 6, 7]
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7  # 7 small slices for inference

      # Disable MIG (full GPU mode)
      all-disabled:
        - devices: all
          mig-enabled: false
```

```bash
# Apply MIG config to specific nodes via label
kubectl label node gpu-worker-02 nvidia.com/mig.config=all-1g.10gb

# MIG manager DaemonSet detects label change and reconfigures GPU
kubectl get pods -n gpu-operator | grep mig-manager
kubectl logs -n gpu-operator daemonset/nvidia-mig-manager

# Verify MIG resources
kubectl get node gpu-worker-02 -o json | \
  jq '.status.allocatable | with_entries(select(.key | startswith("nvidia.com")))'
# {
#   "nvidia.com/mig-1g.10gb": "56",  <- 8 GPUs * 7 slices
#   "nvidia.com/gpu": "0"
# }
```

### Requesting MIG Resources

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: inference-pod
spec:
  containers:
    - name: inference
      image: registry.support.tools/inference-server:v1.5.0
      resources:
        limits:
          nvidia.com/mig-1g.10gb: 1  # Request one 10GB MIG slice
  nodeSelector:
    nvidia.com/mig.config: "all-1g.10gb"
```

## GPU Monitoring with DCGM

The DCGM (Data Center GPU Manager) Exporter exposes comprehensive GPU metrics:

```yaml
# Custom DCGM metrics selection
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcgm-metrics-config
  namespace: gpu-operator
data:
  default-counters.csv: |
    # Format: DCGM_FI_FIELD_ID, Metric Type (Counter/Gauge), Metric Help Text

    # GPU Utilization
    DCGM_FI_DEV_GPU_UTIL,                gauge, GPU utilization (percent)
    DCGM_FI_DEV_MEM_COPY_UTIL,           gauge, Memory bus utilization (percent)
    DCGM_FI_DEV_ENC_UTIL,                gauge, Encoder utilization (percent)
    DCGM_FI_DEV_DEC_UTIL,                gauge, Decoder utilization (percent)

    # Memory
    DCGM_FI_DEV_FB_FREE,                 gauge, Frame buffer memory free (MiB)
    DCGM_FI_DEV_FB_USED,                 gauge, Frame buffer memory used (MiB)
    DCGM_FI_DEV_FB_TOTAL,                gauge, Frame buffer memory total (MiB)

    # Temperature and Power
    DCGM_FI_DEV_GPU_TEMP,                gauge, GPU temperature (C)
    DCGM_FI_DEV_MEMORY_TEMP,             gauge, Memory temperature (C)
    DCGM_FI_DEV_POWER_USAGE,             gauge, Power draw (W)
    DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION,counter, Total energy consumption (mJ)

    # PCIe Bandwidth
    DCGM_FI_DEV_PCIE_TX_THROUGHPUT,      counter, PCIe TX throughput (KB/s)
    DCGM_FI_DEV_PCIE_RX_THROUGHPUT,      counter, PCIe RX throughput (KB/s)

    # NVLink
    DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL,  counter, NVLink total bandwidth (KB/s)

    # XID Errors (GPU hardware errors)
    DCGM_FI_DEV_XID_ERRORS,              counter, XID error count

    # SM Utilization
    DCGM_FI_PROF_SM_ACTIVE,              gauge, Fraction of time SMs are active
    DCGM_FI_PROF_SM_OCCUPANCY,           gauge, Fraction of warps resident on SM
    DCGM_FI_PROF_PIPE_TENSOR_ACTIVE,     gauge, Fraction of cycles tensor cores active
    DCGM_FI_PROF_DRAM_ACTIVE,            gauge, Fraction of cycles HBM memory active
```

### Prometheus Alerting Rules

```yaml
groups:
  - name: gpu.alerts
    rules:
      - alert: GPUHighTemperature
        expr: DCGM_FI_DEV_GPU_TEMP > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU {{ $labels.gpu }} on node {{ $labels.node }} temperature high"
          description: "GPU temperature is {{ $value }}C (threshold: 85C)"

      - alert: GPUXIDError
        expr: increase(DCGM_FI_DEV_XID_ERRORS[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "GPU XID error detected"
          description: "GPU hardware error on node {{ $labels.node }}, GPU {{ $labels.gpu }}"
          runbook: "https://wiki.support.tools/runbooks/gpu-xid-errors"

      - alert: GPUMemoryHigh
        expr: |
          DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL > 0.95
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "GPU memory utilization critical"
          description: "GPU {{ $labels.gpu }} on node {{ $labels.node }} memory at {{ $value | humanizePercentage }}"

      - alert: GPUUtilizationLow
        expr: |
          sum by (node) (DCGM_FI_DEV_GPU_UTIL) /
          count by (node) (DCGM_FI_DEV_GPU_UTIL) < 10
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "GPU cluster underutilized"
          description: "Average GPU utilization on {{ $labels.node }} is {{ $value }}% — workloads may not be GPU-bound"
```

## Jupyter Notebook on GPU Nodes

```yaml
# JupyterHub with GPU support
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jupyter-gpu
  namespace: ml-platform
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jupyter-gpu
  template:
    metadata:
      labels:
        app: jupyter-gpu
    spec:
      serviceAccountName: jupyter-gpu
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: jupyter
          image: nvcr.io/nvidia/pytorch:23.10-py3
          command:
            - jupyter
            - lab
            - --ip=0.0.0.0
            - --port=8888
            - --no-browser
            - --NotebookApp.token=""
            - --NotebookApp.password=""
            - --ServerApp.allow_origin="*"
          ports:
            - containerPort: 8888
              name: jupyter
          resources:
            requests:
              nvidia.com/gpu: "1"
              cpu: "8"
              memory: 32Gi
            limits:
              nvidia.com/gpu: "1"
              cpu: "8"
              memory: 32Gi
          env:
            - name: NVIDIA_VISIBLE_DEVICES
              value: all
            - name: NVIDIA_DRIVER_CAPABILITIES
              value: compute,utility
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: datasets
              mountPath: /datasets
              readOnly: true
          livenessProbe:
            httpGet:
              path: /api
              port: 8888
            initialDelaySeconds: 30
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /api
              port: 8888
            initialDelaySeconds: 10
            periodSeconds: 10
      nodeSelector:
        nvidia.com/gpu.present: "true"
        nvidia.com/gpu.product: "A100-SXM4-80GB"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
        - key: dedicated
          value: gpu
          effect: NoSchedule
      volumes:
        - name: workspace
          persistentVolumeClaim:
            claimName: jupyter-workspace-pvc
        - name: datasets
          persistentVolumeClaim:
            claimName: datasets-pvc
```

## GPU Node Taints and Priority

```yaml
# Taint GPU nodes to prevent non-GPU workloads from landing there
# Applied during node registration or via automation
kubectl taint node gpu-worker-01 \
  nvidia.com/gpu=present:NoSchedule \
  dedicated=gpu:NoSchedule

# PriorityClass for GPU workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-high-priority
value: 1000
globalDefault: false
description: "High priority for production GPU inference workloads"
preemptionPolicy: PreemptLowerPriority

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-batch-priority
value: 100
globalDefault: false
description: "Batch training jobs — may be preempted by high-priority inference"
preemptionPolicy: PreemptLowerPriority
```

## GPU Node Pool Design

```
Node Pool         | GPU Type       | Count | Purpose
------------------|----------------|-------|--------------------------------
gpu-a100-training | A100 80GB SXM4 | 8+    | Multi-node distributed training
gpu-a100-inference| A100 80GB SXM4 | 4+    | MIG-partitioned inference serving
gpu-t4-dev        | T4 16GB        | 2+    | Development and experimentation
gpu-h100-research | H100 80GB SXM5 | 4+    | LLM fine-tuning and research
```

## Production Checklist

```
Infrastructure
[ ] GPU nodes tainted with nvidia.com/gpu=present:NoSchedule
[ ] NodeFeatureDiscovery running and labeling nodes correctly
[ ] GPU Operator version pinned (not "latest")
[ ] Driver version tested against CUDA requirements of target workloads

Resource Management
[ ] Time-slicing configured for inference node pools
[ ] MIG profiles defined for isolation-required workloads
[ ] PriorityClasses separating training (batch) from inference (high-priority)
[ ] Resource quotas per namespace for GPU resources

Monitoring
[ ] DCGM Exporter ServiceMonitor created for Prometheus scraping
[ ] XID error alert firing within 5 minutes of occurrence
[ ] GPU temperature alert at 85C warning, 90C critical
[ ] GPU utilization dashboard in Grafana with capacity trending

Operations
[ ] Node drain procedure tested for driver upgrades
[ ] GPU health check included in node readiness probe
[ ] NVML/nvidia-smi available on nodes for manual diagnostics
[ ] Runbook for GPU hardware failure and replacement procedure
```

The GPU Operator transforms GPU cluster management from a fragile manual process into a declarative, operator-managed system. Combined with proper scheduling configuration, monitoring, and isolation strategies, it provides the foundation for running production AI/ML workloads with the same reliability expectations as CPU-based services.
