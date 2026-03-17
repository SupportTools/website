---
title: "NVIDIA GPU Operator on Kubernetes: MIG Partitioning and Multi-Tenant GPU Sharing"
date: 2028-10-05T00:00:00-05:00
draft: false
tags: ["NVIDIA", "GPU", "Kubernetes", "AI/ML", "MIG"]
categories:
- NVIDIA
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to NVIDIA GPU Operator installation, MIG partitioning strategies for multi-tenant GPU sharing, time-slicing configuration, DCGM Exporter metrics, and scheduling AI workloads."
more_link: "yes"
url: "/kubernetes-gpu-operator-nvidia-mig-guide/"
---

Sharing expensive GPU hardware across multiple teams and workloads is a critical cost optimization challenge in enterprise AI/ML platforms. The NVIDIA GPU Operator automates the full GPU software stack lifecycle on Kubernetes, while MIG (Multi-Instance GPU) partitioning and time-slicing provide two complementary strategies for multi-tenant GPU sharing. This guide covers both approaches with production-ready configurations.

<!--more-->

# NVIDIA GPU Operator on Kubernetes: MIG Partitioning and Multi-Tenant GPU Sharing

## GPU Operator Architecture

The NVIDIA GPU Operator is a Kubernetes operator that manages all components required to use GPUs on a cluster:

- **NVIDIA Driver**: Kernel module for GPU access
- **NVIDIA Container Toolkit**: OCI hook that exposes GPU devices to containers (previously nvidia-docker2)
- **Device Plugin**: Kubernetes device plugin that advertises GPU resources (`nvidia.com/gpu`)
- **DCGM Exporter**: Prometheus exporter for GPU telemetry from the Data Center GPU Manager
- **GPU Feature Discovery**: Labels nodes with detailed GPU characteristics
- **MIG Manager**: Manages MIG partitions dynamically
- **Node Feature Discovery** (optional): Broader hardware feature labeling

## Prerequisites

Verify GPU nodes before installation:

```bash
# Check NVIDIA GPUs present on nodes
kubectl get nodes -o wide
ssh gpu-node-001 nvidia-smi

# Verify kernel version is compatible (5.4+ recommended)
ssh gpu-node-001 uname -r

# Check that nodes are NOT already running the driver as a DaemonSet
kubectl get daemonsets -n gpu-operator 2>/dev/null || echo "GPU Operator not installed yet"
```

## Installing the GPU Operator with Helm

```bash
# Add the NVIDIA Helm repository
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# Check available versions
helm search repo nvidia/gpu-operator

# Install with custom values
helm upgrade --install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --version 23.9.1 \
  --values - << 'EOF'
# gpu-operator-values.yaml

# NVIDIA Driver configuration
driver:
  enabled: true
  version: "535.104.12"
  usePrecompiled: false
  # Use a different repository if air-gapped
  repository: nvcr.io/nvidia
  image: driver
  manager:
    image:
      repository: nvcr.io/nvidia/cloud-native
      name: gpu-operator-validator

# Container Toolkit
toolkit:
  enabled: true
  version: v1.14.5-ubuntu20.04

# Device Plugin
devicePlugin:
  enabled: true
  version: v0.14.5
  config:
    name: time-slicing-config  # Reference to ConfigMap for time-slicing
    default: ""

# DCGM Exporter for Prometheus metrics
dcgmExporter:
  enabled: true
  version: 3.3.0-3.2.0-ubuntu22.04
  serviceMonitor:
    enabled: true
    interval: 15s
    honorLabels: false

# GPU Feature Discovery
gfd:
  enabled: true
  version: v0.8.2

# MIG Manager
migManager:
  enabled: true
  version: v0.6.0

# Node Feature Discovery
nfd:
  enabled: true

# Validator
validator:
  plugin:
    env:
      - name: WITH_WORKLOAD
        value: "true"

# Operator settings
operator:
  defaultRuntime: containerd
  runtimeClass: nvidia
  use_ocp_driver_toolkit: false
  initContainer:
    image: cuda
    repository: nvcr.io/nvidia
    version: 12.2.0-base-ubi8
EOF
```

Verify the installation:

```bash
# Watch all GPU Operator pods come up
kubectl -n gpu-operator get pods -w

# Check operator status
kubectl -n gpu-operator describe clusterpolicy cluster-policy

# Confirm GPU resources are advertised
kubectl get nodes -o json | jq '.items[] | {
  name: .metadata.name,
  gpu: .status.allocatable["nvidia.com/gpu"],
  labels: .metadata.labels | to_entries | map(select(.key | startswith("nvidia")))
}'
```

## GPU Feature Discovery Labels

After GFD runs, nodes receive detailed GPU labels:

```bash
kubectl get node gpu-node-001 -o json | jq '.metadata.labels | to_entries | map(select(.key | startswith("nvidia"))) | from_entries'
```

Example output:

```json
{
  "nvidia.com/cuda.driver.major": "535",
  "nvidia.com/cuda.driver.minor": "104",
  "nvidia.com/cuda.driver.rev": "12",
  "nvidia.com/cuda.runtime.major": "12",
  "nvidia.com/cuda.runtime.minor": "2",
  "nvidia.com/gfd.timestamp": "1696128000",
  "nvidia.com/gpu.compute.major": "8",
  "nvidia.com/gpu.compute.minor": "6",
  "nvidia.com/gpu.count": "8",
  "nvidia.com/gpu.machine": "DGX-A100",
  "nvidia.com/gpu.memory": "40536",
  "nvidia.com/gpu.product": "A100-SXM4-40GB-MIG-1g.5gb",
  "nvidia.com/mig.capable": "true",
  "nvidia.com/mig.strategy": "mixed"
}
```

## MIG (Multi-Instance GPU) Partitioning

MIG is available on NVIDIA A100, A30, H100, and H200 GPUs. It creates hardware-isolated GPU partitions, each with dedicated compute engines, memory, and cache. Unlike time-slicing, MIG partitions cannot interfere with each other at the hardware level.

### MIG Partition Profiles for A100 40GB

```
Profile       | Compute Engines | Memory (GB) | Count per A100
1g.5gb        | 1/7             | 5           | 7
2g.10gb       | 2/7             | 10          | 3
3g.20gb       | 3/7             | 20          | 2
4g.20gb       | 4/7             | 20          | 1
7g.40gb       | 7/7             | 40          | 1 (full GPU)
1g.5gb+me     | 1/7 + media     | 5           | 1 (only one +me per GPU)
```

### Configuring MIG via GPU Operator

The GPU Operator MIG Manager reads a ConfigMap and applies the MIG partition configuration:

```yaml
# mig-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: default-mig-parted-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    mig-configs:
      all-1g.5gb:
        # 7 equal partitions per A100 40GB
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.5gb": 7

      all-2g.10gb:
        # 3 medium partitions per A100 40GB
        - devices: all
          mig-enabled: true
          mig-devices:
            "2g.10gb": 3

      all-balanced:
        # Mixed: 1 large + 2 medium partitions
        - devices: all
          mig-enabled: true
          mig-devices:
            "3g.20gb": 2
            "1g.5gb": 1

      custom-mix:
        # Per-GPU customization for heterogeneous workloads
        - devices: [0]
          mig-enabled: true
          mig-devices:
            "3g.20gb": 1
            "2g.10gb": 1
        - devices: [1, 2, 3]
          mig-enabled: true
          mig-devices:
            "1g.5gb": 7

      all-disabled:
        - devices: all
          mig-enabled: false
```

Apply the MIG config to a node using labels:

```bash
# Apply the balanced MIG profile to a specific node
kubectl label node gpu-node-001 nvidia.com/mig.config=all-balanced

# Apply 7-way partitioning to all nodes with A100 GPUs
kubectl label nodes -l nvidia.com/gpu.product=A100-SXM4-40GB nvidia.com/mig.config=all-1g.5gb

# Check MIG configuration status
kubectl get node gpu-node-001 -o json | jq '.metadata.labels | to_entries | map(select(.key | startswith("nvidia.com/mig")))'

# Verify MIG instances on the node
kubectl -n gpu-operator exec -it $(kubectl -n gpu-operator get pod -l app=gpu-operator -o name | head -1) -- nvidia-smi mig -lgip
```

Example `nvidia-smi` output after 7-way A100 partitioning:

```
+-------------------------------------------------------+
| GPU instances:                                         |
| GPU   Name             Profile  Instance   Placement  |
|                          ID       ID       Start:Size |
|=======================================================|
|   0  MIG 1g.5gb          19       1          0:1      |
|   0  MIG 1g.5gb          19       2          1:1      |
|   0  MIG 1g.5gb          19       3          2:1      |
|   0  MIG 1g.5gb          19       4          3:1      |
|   0  MIG 1g.5gb          19       5          4:1      |
|   0  MIG 1g.5gb          19       6          5:1      |
|   0  MIG 1g.5gb          19       7          6:1      |
+-------------------------------------------------------+
```

### Requesting MIG Partitions in Workloads

After MIG is configured, the device plugin advertises the partitions as typed resources:

```bash
kubectl get node gpu-node-001 -o json | jq '.status.allocatable | to_entries | map(select(.key | startswith("nvidia.com")))'
```

Output:

```json
[
  {"key": "nvidia.com/mig-1g.5gb", "value": "7"},
  {"key": "nvidia.com/mig-2g.10gb", "value": "0"},
  {"key": "nvidia.com/mig-3g.20gb", "value": "0"}
]
```

Workload requesting a MIG partition:

```yaml
# llm-inference-mig.yaml
apiVersion: v1
kind: Pod
metadata:
  name: llm-inference-small
  namespace: ml-team
spec:
  runtimeClassName: nvidia
  nodeSelector:
    nvidia.com/mig.capable: "true"
  containers:
    - name: inference
      image: nvcr.io/nvidia/pytorch:23.10-py3
      command: ["python3", "/app/inference.py"]
      resources:
        limits:
          nvidia.com/mig-1g.5gb: "1"  # Request one 5GB MIG slice
        requests:
          nvidia.com/mig-1g.5gb: "1"
      env:
        - name: CUDA_VISIBLE_DEVICES
          value: "MIG-GPU-0/7/0"  # Set by device plugin automatically
```

## Time-Slicing for Shared GPU Access

Time-slicing is a simpler sharing mechanism available on all NVIDIA GPUs (not just A100). Multiple processes share the GPU by context-switching on the GPU engine. There is no memory isolation—all processes share the full GPU memory pool.

### Time-Slicing ConfigMap

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
            replicas: 4  # Each physical GPU appears as 4 virtual GPUs
```

Update the GPU Operator ClusterPolicy to use this config:

```bash
kubectl patch clusterpolicy cluster-policy \
  --type=merge \
  --patch '{
    "spec": {
      "devicePlugin": {
        "config": {
          "name": "time-slicing-config",
          "default": "any"
        }
      }
    }
  }'
```

Label nodes to use time-slicing:

```bash
kubectl label node gpu-node-001 nvidia.com/device-plugin.config=any
```

After applying, the node advertises multiplied resources:

```bash
kubectl get node gpu-node-001 -o jsonpath='{.status.allocatable.nvidia\.com/gpu}'
# Output: 4 (for a 1-GPU node with 4x replication)
```

### Workload with Time-Slicing

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: training-job
  namespace: ml-team
spec:
  parallelism: 4  # 4 concurrent training tasks sharing 1 physical GPU
  completions: 4
  template:
    spec:
      runtimeClassName: nvidia
      restartPolicy: OnFailure
      containers:
        - name: trainer
          image: nvcr.io/nvidia/pytorch:23.10-py3
          command: ["python3", "/app/train.py", "--epochs", "10"]
          resources:
            limits:
              nvidia.com/gpu: "1"  # Each task gets a virtual GPU slice
            requests:
              nvidia.com/gpu: "1"
          env:
            - name: NCCL_P2P_DISABLE
              value: "1"  # Required when sharing GPU with time-slicing
```

## GPU Metrics with DCGM Exporter

The DCGM Exporter provides deep GPU telemetry. Key metrics:

```bash
# Port-forward to DCGM exporter
kubectl -n gpu-operator port-forward svc/dcgm-exporter 9400:9400 &

# List all available metrics
curl -s http://localhost:9400/metrics | grep "^# HELP" | sort

# Key metrics to monitor
curl -s http://localhost:9400/metrics | grep -E "^DCGM_FI_DEV_GPU_UTIL|DCGM_FI_DEV_FB_USED|DCGM_FI_DEV_POWER_USAGE|DCGM_FI_DEV_SM_CLOCK"
```

Sample metrics output:

```
DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-abc123",...} 78
DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-abc123",...} 32768  # MB
DCGM_FI_DEV_FB_FREE{gpu="0",UUID="GPU-abc123",...} 7768
DCGM_FI_DEV_POWER_USAGE{gpu="0",UUID="GPU-abc123",...} 312.5  # Watts
DCGM_FI_DEV_SM_CLOCK{gpu="0",UUID="GPU-abc123",...} 1410  # MHz
DCGM_FI_DEV_MEMORY_CLOCK{gpu="0",UUID="GPU-abc123",...} 1593
DCGM_FI_DEV_PCIE_TX_THROUGHPUT{gpu="0",UUID="GPU-abc123",...} 1024  # KB/s
DCGM_FI_DEV_XID_ERRORS{gpu="0",UUID="GPU-abc123",...} 0  # Hardware errors
```

### ServiceMonitor for Prometheus Operator

```yaml
# dcgm-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: dcgm-exporter
  namespace: gpu-operator
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: dcgm-exporter
  namespaceSelector:
    matchNames:
      - gpu-operator
  endpoints:
    - port: metrics
      interval: 15s
      scrapeTimeout: 10s
      honorLabels: true
      metricRelabelings:
        # Add cluster label to all GPU metrics
        - targetLabel: cluster
          replacement: production
```

### Grafana Dashboard Queries

```promql
# GPU utilization per pod/namespace
avg by (namespace, pod) (
  DCGM_FI_DEV_GPU_UTIL * on (UUID) group_left(pod, namespace)
  kube_pod_labels{label_app!=""}
)

# GPU memory utilization percentage
DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100

# GPU power draw total (cluster-wide)
sum(DCGM_FI_DEV_POWER_USAGE)

# Hardware errors (should be 0)
sum(rate(DCGM_FI_DEV_XID_ERRORS[5m])) by (gpu, UUID)

# SM clock frequency (indicator of thermal throttling)
DCGM_FI_DEV_SM_CLOCK

# Tensor core utilization (for AI workloads)
DCGM_FI_PROF_TENSOR_ACTIVE
```

### PrometheusRule for GPU Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gpu-alerts
  namespace: gpu-operator
  labels:
    release: prometheus
spec:
  groups:
    - name: gpu.alerts
      rules:
        - alert: GPUHighUtilization
          expr: avg(DCGM_FI_DEV_GPU_UTIL) by (GPU_I_PROFILE) > 90
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "GPU utilization > 90% for 15 minutes"
            description: "GPU {{ $labels.UUID }} utilization is {{ $value }}%"

        - alert: GPUHighMemoryUsage
          expr: |
            DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100 > 95
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "GPU memory usage > 95%"
            description: "GPU {{ $labels.UUID }} memory: {{ $value | humanizePercentage }}"

        - alert: GPUXIDError
          expr: increase(DCGM_FI_DEV_XID_ERRORS[5m]) > 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "GPU hardware error detected"
            description: "GPU {{ $labels.UUID }} reported an XID error. Check dmesg."

        - alert: GPUThermalThrottle
          expr: DCGM_FI_DEV_SM_CLOCK < 900
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU may be thermal throttling"
            description: "GPU {{ $labels.UUID }} SM clock is {{ $value }}MHz (expected >900MHz)"
```

## Resource Quotas for GPU Namespaces

Prevent any single team from monopolizing GPU resources:

```yaml
# gpu-resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ml-team-gpu-quota
  namespace: ml-team
spec:
  hard:
    # Physical GPU count
    requests.nvidia.com/gpu: "4"
    limits.nvidia.com/gpu: "4"
    # MIG partition quotas
    requests.nvidia.com/mig-1g.5gb: "14"
    limits.nvidia.com/mig-1g.5gb: "14"
    requests.nvidia.com/mig-3g.20gb: "2"
    limits.nvidia.com/mig-3g.20gb: "2"
    # Memory limits for CPU-side ML data processing
    requests.memory: "256Gi"
    limits.memory: "512Gi"
    # Limit concurrent pods
    pods: "50"
```

```yaml
# gpu-limit-range.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-default-limits
  namespace: ml-team
spec:
  limits:
    - type: Container
      defaultRequest:
        nvidia.com/gpu: "0"
      max:
        nvidia.com/gpu: "4"
        nvidia.com/mig-1g.5gb: "7"
```

## Scheduling AI Workloads with Node Affinity

Use GFD labels for precise workload scheduling:

```yaml
# training-job-scheduler.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: llm-finetuning
  namespace: ml-team
spec:
  template:
    spec:
      runtimeClassName: nvidia
      # Hard requirement: must run on A100 nodes
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: nvidia.com/gpu.product
                    operator: In
                    values:
                      - "A100-SXM4-40GB"
                      - "A100-SXM4-80GB"
                  - key: nvidia.com/gpu.memory
                    operator: Gt
                    values: ["39000"]  # At least 39GB VRAM
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: nvidia.com/gpu.product
                    operator: In
                    values: ["A100-SXM4-80GB"]  # Prefer 80GB if available
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      containers:
        - name: trainer
          image: nvcr.io/nvidia/pytorch:23.10-py3
          command: ["torchrun", "--nproc_per_node=4", "/app/train.py"]
          resources:
            limits:
              nvidia.com/gpu: "4"
              memory: "256Gi"
              cpu: "32"
            requests:
              nvidia.com/gpu: "4"
              memory: "128Gi"
              cpu: "16"
          env:
            - name: NCCL_DEBUG
              value: "INFO"
            - name: PYTORCH_CUDA_ALLOC_CONF
              value: "max_split_size_mb:512"
      restartPolicy: OnFailure
```

## Dynamic MIG Reconfiguration

Teams can request different MIG profiles as their workloads change:

```bash
# Bash script to reconfigure MIG profiles on demand
#!/bin/bash
# reconfigure-mig.sh

PROFILE="${1:-all-1g.5gb}"
NODES="${2:-all}"

if [ "$NODES" = "all" ]; then
  NODE_SELECTOR="-l nvidia.com/mig.capable=true"
else
  NODE_SELECTOR="$NODES"
fi

echo "Applying MIG profile: $PROFILE"

# Label nodes to trigger MIG manager reconfiguration
kubectl label nodes $NODE_SELECTOR nvidia.com/mig.config="$PROFILE" --overwrite

# Wait for MIG manager to complete reconfiguration
echo "Waiting for MIG reconfiguration..."
kubectl -n gpu-operator rollout status daemonset/gpu-operator-node-feature-discovery-worker --timeout=120s

# Verify new resource advertisements
echo "Current allocatable GPU resources:"
kubectl get nodes $NODE_SELECTOR -o json | jq '.items[] | {
  name: .metadata.name,
  mig_resources: [.status.allocatable | to_entries[] | select(.key | startswith("nvidia.com/mig"))]
}'
```

## Troubleshooting Common Issues

### Driver Pod Not Starting

```bash
# Check driver pod logs
kubectl -n gpu-operator logs -l app=nvidia-driver-daemonset --tail=50

# Verify secure boot is not blocking driver loading
mokutil --sb-state
# If secure boot is enabled, the kernel module must be signed

# Check dmesg for driver errors
kubectl -n gpu-operator exec -it $(kubectl -n gpu-operator get pod -l app=nvidia-driver-daemonset -o name | head -1) -- dmesg | grep -i nvidia
```

### Device Plugin Not Advertising GPUs

```bash
# Check device plugin logs
kubectl -n gpu-operator logs -l app=nvidia-device-plugin-daemonset --tail=50

# Verify GPU device files exist
kubectl -n gpu-operator exec -it $(kubectl -n gpu-operator get pod -l app=nvidia-device-plugin-daemonset -o name | head -1) -- ls -la /dev/nvidia*

# Test GPU access from inside the plugin pod
kubectl -n gpu-operator exec -it $(kubectl -n gpu-operator get pod -l app=nvidia-device-plugin-daemonset -o name | head -1) -- nvidia-smi
```

### MIG Manager Stuck

```bash
# Check MIG manager status
kubectl -n gpu-operator logs -l app=nvidia-mig-manager --tail=50

# Manually verify MIG state on the node
kubectl debug node/gpu-node-001 -it --image=nvcr.io/nvidia/cuda:12.2.0-base-ubuntu22.04 -- nvidia-smi mig -lgip

# Reset MIG configuration if stuck
kubectl label node gpu-node-001 nvidia.com/mig.config-
# Wait 30s
kubectl label node gpu-node-001 nvidia.com/mig.config=all-1g.5gb
```

## Summary

The NVIDIA GPU Operator simplifies GPU cluster management by automating the full software stack lifecycle. MIG partitioning on A100/H100 hardware provides hardware-isolated GPU slices ideal for multi-tenant platforms where strict resource isolation is required. Time-slicing is a simpler option for all NVIDIA GPUs when memory isolation is not needed and workloads are latency-tolerant.

DCGM Exporter gives you the visibility needed to track utilization, detect hardware errors, and right-size workloads. Combined with resource quotas and namespace-scoped scheduling policies, you can build a shared GPU platform that serves multiple ML teams from the same hardware pool while maintaining isolation and predictable performance.
