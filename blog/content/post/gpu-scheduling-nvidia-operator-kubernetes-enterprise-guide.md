---
title: "GPU Scheduling with NVIDIA Operator: Enterprise Kubernetes Implementation Guide"
date: 2026-07-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GPU", "NVIDIA", "Machine Learning", "Performance", "Scheduling", "Resource Management"]
categories: ["Kubernetes", "Performance", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing GPU scheduling in Kubernetes using NVIDIA GPU Operator, including resource allocation, multi-instance GPU, time-slicing, and production optimization strategies."
more_link: "yes"
url: "/gpu-scheduling-nvidia-operator-kubernetes-enterprise-guide/"
---

Master GPU scheduling in Kubernetes with NVIDIA GPU Operator for high-performance AI/ML workloads. This comprehensive guide covers GPU resource management, Multi-Instance GPU (MIG), time-slicing, scheduling strategies, and production optimization for enterprise environments.

<!--more-->

# GPU Scheduling with NVIDIA Operator: Enterprise Kubernetes Implementation Guide

## Executive Summary

GPU scheduling in Kubernetes has become critical for organizations running AI/ML workloads at scale. The NVIDIA GPU Operator simplifies GPU management by automating driver installation, device plugin deployment, and monitoring configuration. This guide provides production-ready implementations for enterprise GPU scheduling, including advanced features like Multi-Instance GPU (MIG), time-slicing, and sophisticated resource allocation strategies.

## Understanding GPU Architecture in Kubernetes

### GPU Resource Types

Modern GPU scheduling supports multiple resource types:

```yaml
# GPU resource definitions
resources:
  limits:
    # Whole GPU allocation
    nvidia.com/gpu: 1

    # MIG profiles (Ampere and newer)
    nvidia.com/mig-1g.5gb: 1
    nvidia.com/mig-2g.10gb: 1
    nvidia.com/mig-3g.20gb: 1
    nvidia.com/mig-4g.20gb: 1
    nvidia.com/mig-7g.40gb: 1

    # Time-sliced GPUs
    nvidia.com/gpu.shared: 1
```

### GPU Topology Understanding

```bash
#!/bin/bash
# GPU topology analysis script

cat << 'EOF' > /usr/local/bin/gpu-topology.sh
#!/bin/bash

echo "=== GPU Topology Analysis ==="
echo

# List all GPUs
nvidia-smi -L

echo
echo "=== GPU Topology Matrix ==="
nvidia-smi topo -m

echo
echo "=== NVLink Status ==="
nvidia-smi nvlink --status

echo
echo "=== GPU Memory Info ==="
nvidia-smi --query-gpu=index,name,memory.total,memory.free,memory.used --format=csv

echo
echo "=== GPU Utilization ==="
nvidia-smi --query-gpu=index,utilization.gpu,utilization.memory --format=csv

echo
echo "=== NUMA Affinity ==="
for gpu in $(nvidia-smi -L | awk '{print $2}' | tr -d ':'); do
    echo "GPU $gpu: NUMA node $(cat /sys/class/drm/card${gpu}/device/numa_node)"
done

echo
echo "=== PCIe Link Info ==="
nvidia-smi --query-gpu=index,pci.bus_id,pcie.link.gen.current,pcie.link.width.current --format=csv
EOF

chmod +x /usr/local/bin/gpu-topology.sh
/usr/local/bin/gpu-topology.sh
```

## NVIDIA GPU Operator Installation

### Prerequisites and Validation

```bash
#!/bin/bash
# Validate GPU nodes before operator installation

cat << 'EOF' > validate-gpu-nodes.sh
#!/bin/bash

set -e

echo "=== GPU Node Validation ==="

# Check kernel version
KERNEL_VERSION=$(uname -r)
echo "Kernel Version: $KERNEL_VERSION"

# Check for nouveau driver (should not be loaded)
if lsmod | grep -q nouveau; then
    echo "ERROR: Nouveau driver is loaded. Blacklist it before proceeding."
    exit 1
else
    echo "✓ Nouveau driver not loaded"
fi

# Check for required kernel headers
if [ -d "/usr/src/linux-headers-$KERNEL_VERSION" ]; then
    echo "✓ Kernel headers installed"
else
    echo "ERROR: Kernel headers not found"
    exit 1
fi

# Check for GPUs
GPU_COUNT=$(lspci | grep -i nvidia | wc -l)
echo "✓ Found $GPU_COUNT NVIDIA GPU(s)"

# Check for IOMMU
if [ -d "/sys/kernel/iommu_groups" ]; then
    echo "✓ IOMMU available"
else
    echo "WARNING: IOMMU not available"
fi

# Check hugepages configuration
HUGEPAGES=$(cat /proc/meminfo | grep HugePages_Total | awk '{print $2}')
echo "Hugepages configured: $HUGEPAGES"

# Check for required modules
REQUIRED_MODULES="ipmi_msghandler ipmi_devintf"
for module in $REQUIRED_MODULES; do
    if lsmod | grep -q "^$module"; then
        echo "✓ Module $module loaded"
    else
        echo "WARNING: Module $module not loaded"
    fi
done

echo
echo "=== Validation Complete ==="
EOF

chmod +x validate-gpu-nodes.sh
./validate-gpu-nodes.sh
```

### Operator Deployment

```yaml
# gpu-operator-values.yaml
# Production configuration for NVIDIA GPU Operator

operator:
  defaultRuntime: containerd
  runtimeClass: nvidia

  # Resource requests for operator components
  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi

# Driver configuration
driver:
  enabled: true
  version: "535.129.03"

  # Use precompiled drivers for faster deployment
  usePrecompiled: true

  # Driver resources
  resources:
    limits:
      cpu: "2"
      memory: 4Gi
    requests:
      cpu: 500m
      memory: 512Mi

  # Node selector for GPU nodes
  nodeSelector:
    node-role.kubernetes.io/gpu-worker: ""

  tolerations:
    - key: nvidia.com/gpu
      operator: Exists
      effect: NoSchedule

# Toolkit for container runtime
toolkit:
  enabled: true
  version: "1.14.3-centos7"

  resources:
    limits:
      cpu: "1"
      memory: 1Gi
    requests:
      cpu: 100m
      memory: 128Mi

# Device plugin for GPU discovery
devicePlugin:
  enabled: true
  version: "0.14.3"

  # GPU sharing configuration
  config:
    name: time-slicing-config
    default: "any"

  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi

# DCGM exporter for monitoring
dcgmExporter:
  enabled: true
  version: "3.2.5-3.2.0"

  serviceMonitor:
    enabled: true
    interval: 15s

  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi

# GFD for GPU feature discovery
gfd:
  enabled: true
  version: "0.8.2"

  resources:
    limits:
      cpu: 500m
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi

# Node Feature Discovery
nfd:
  enabled: true

nodeStatusExporter:
  enabled: true

migManager:
  enabled: true

  # MIG configuration
  config:
    name: default-mig-parted-config
    default: "all-disabled"

# Validator for deployment verification
validator:
  enabled: true

  # Validation job resources
  resources:
    limits:
      cpu: "1"
      memory: 512Mi
    requests:
      cpu: 100m
      memory: 128Mi
---
# Deploy GPU Operator
apiVersion: v1
kind: Namespace
metadata:
  name: gpu-operator-resources
---
# Install using Helm
# helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
# helm repo update
# helm install gpu-operator nvidia/gpu-operator \
#   -n gpu-operator-resources \
#   -f gpu-operator-values.yaml
```

### Time-Slicing Configuration

```yaml
# time-slicing-config.yaml
# Configure GPU time-slicing for workload oversubscription

apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator-resources
data:
  any: |-
    version: v1
    sharing:
      timeSlicing:
        # Number of replicas for time-sliced GPU
        replicas: 8
        # Rename resource to avoid conflicts
        renameByDefault: true
        # Fail requests that exceed memory
        failRequestsGreaterThanOne: true

  # Different configurations for different scenarios
  high-throughput: |-
    version: v1
    sharing:
      timeSlicing:
        replicas: 4
        renameByDefault: true
        failRequestsGreaterThanOne: true

  development: |-
    version: v1
    sharing:
      timeSlicing:
        replicas: 16
        renameByDefault: true
        failRequestsGreaterThanOne: false
---
# Apply time-slicing to device plugin
apiVersion: v1
kind: ConfigMap
metadata:
  name: device-plugin-config
  namespace: gpu-operator-resources
data:
  config.yaml: |-
    version: v1
    flags:
      migStrategy: none
      failOnInitError: true
      nvidiaDriverRoot: /run/nvidia/driver
      plugin:
        passDeviceSpecs: true
        deviceListStrategy: envvar
    sharing:
      timeSlicing:
        renameByDefault: false
        failRequestsGreaterThanOne: false
        resources:
        - name: nvidia.com/gpu
          replicas: 8
```

## Multi-Instance GPU (MIG) Configuration

### MIG Strategy Implementation

```yaml
# mig-configuration.yaml
# Configure MIG profiles for different workload types

apiVersion: v1
kind: ConfigMap
metadata:
  name: mig-parted-config
  namespace: gpu-operator-resources
data:
  config.yaml: |-
    version: v1
    mig-configs:
      # All 1g.5gb instances (7 instances)
      all-1g.5gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.5gb": 7

      # All 2g.10gb instances (3 instances)
      all-2g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "2g.10gb": 3

      # All 3g.20gb instances (2 instances)
      all-3g.20gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "3g.20gb": 2

      # Mixed profile for diverse workloads
      mixed:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.5gb": 2
            "2g.10gb": 1
            "3g.20gb": 1

      # Balanced profile
      balanced:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.5gb": 3
            "3g.20gb": 1

      # Disable MIG
      all-disabled:
        - devices: all
          mig-enabled: false
---
# Node label for MIG profile selection
apiVersion: v1
kind: Node
metadata:
  name: gpu-node-1
  labels:
    nvidia.com/mig.config: all-1g.5gb
---
# Example workload using MIG
apiVersion: v1
kind: Pod
metadata:
  name: mig-workload
spec:
  restartPolicy: OnFailure
  containers:
  - name: cuda-vectoradd
    image: nvcr.io/nvidia/k8s/cuda-sample:vectoradd-cuda11.7.1
    resources:
      limits:
        nvidia.com/mig-1g.5gb: 1
  nodeSelector:
    nvidia.com/gpu.product: A100-SXM4-40GB
```

### MIG Management Scripts

```bash
#!/bin/bash
# MIG management automation

cat << 'EOF' > /usr/local/bin/mig-manager.sh
#!/bin/bash

set -e

# Function to enable MIG mode
enable_mig() {
    local gpu_id=$1
    echo "Enabling MIG mode on GPU $gpu_id"
    nvidia-smi -i $gpu_id -mig 1
}

# Function to disable MIG mode
disable_mig() {
    local gpu_id=$1
    echo "Disabling MIG mode on GPU $gpu_id"
    # First destroy all MIG devices
    nvidia-smi mig -dci -i $gpu_id
    nvidia-smi mig -dgi -i $gpu_id
    # Then disable MIG mode
    nvidia-smi -i $gpu_id -mig 0
}

# Function to create MIG profile
create_mig_profile() {
    local gpu_id=$1
    local profile=$2
    local count=$3

    echo "Creating $count instances of profile $profile on GPU $gpu_id"

    for i in $(seq 1 $count); do
        # Create GPU instance
        gi_id=$(nvidia-smi mig -cgi $profile -i $gpu_id | grep "Successfully" | awk '{print $NF}')
        # Create compute instance
        nvidia-smi mig -cci -gi $gi_id -i $gpu_id
    done
}

# Function to list MIG devices
list_mig_devices() {
    echo "=== MIG Device Listing ==="
    nvidia-smi -L
    echo
    echo "=== MIG Instance Details ==="
    nvidia-smi mig -lgi
    echo
    nvidia-smi mig -lci
}

# Function to apply preset configuration
apply_mig_preset() {
    local gpu_id=$1
    local preset=$2

    echo "Applying MIG preset: $preset to GPU $gpu_id"

    # First, clean up existing MIG devices
    nvidia-smi mig -dci -i $gpu_id 2>/dev/null || true
    nvidia-smi mig -dgi -i $gpu_id 2>/dev/null || true

    case $preset in
        "all-1g.5gb")
            create_mig_profile $gpu_id "1g.5gb" 7
            ;;
        "all-2g.10gb")
            create_mig_profile $gpu_id "2g.10gb" 3
            ;;
        "all-3g.20gb")
            create_mig_profile $gpu_id "3g.20gb" 2
            ;;
        "mixed")
            create_mig_profile $gpu_id "1g.5gb" 2
            create_mig_profile $gpu_id "2g.10gb" 1
            create_mig_profile $gpu_id "3g.20gb" 1
            ;;
        "balanced")
            create_mig_profile $gpu_id "1g.5gb" 3
            create_mig_profile $gpu_id "3g.20gb" 1
            ;;
        *)
            echo "Unknown preset: $preset"
            exit 1
            ;;
    esac
}

# Main command processing
case "$1" in
    enable)
        enable_mig $2
        ;;
    disable)
        disable_mig $2
        ;;
    create)
        create_mig_profile $2 $3 $4
        ;;
    list)
        list_mig_devices
        ;;
    preset)
        apply_mig_preset $2 $3
        ;;
    *)
        echo "Usage: $0 {enable|disable|create|list|preset} [args]"
        echo "  enable <gpu_id>                    - Enable MIG mode"
        echo "  disable <gpu_id>                   - Disable MIG mode"
        echo "  create <gpu_id> <profile> <count>  - Create MIG instances"
        echo "  list                               - List MIG devices"
        echo "  preset <gpu_id> <preset_name>      - Apply preset configuration"
        exit 1
        ;;
esac
EOF

chmod +x /usr/local/bin/mig-manager.sh
```

## Advanced GPU Scheduling Strategies

### Priority-Based Scheduling

```yaml
# gpu-priority-scheduling.yaml
# Implement priority-based GPU scheduling

---
# High priority workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-high-priority
value: 1000000
globalDefault: false
description: "High priority for critical GPU workloads"
---
# Medium priority workloads
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-medium-priority
value: 100000
globalDefault: false
description: "Medium priority for standard GPU workloads"
---
# Low priority workloads (preemptible)
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-low-priority
value: 1000
globalDefault: false
preemptionPolicy: PreemptLowerPriority
description: "Low priority for batch GPU workloads"
---
# Example high-priority workload
apiVersion: batch/v1
kind: Job
metadata:
  name: critical-training-job
spec:
  template:
    spec:
      priorityClassName: gpu-high-priority
      containers:
      - name: trainer
        image: nvcr.io/nvidia/pytorch:23.12-py3
        resources:
          limits:
            nvidia.com/gpu: 8
            memory: 500Gi
          requests:
            cpu: "32"
            memory: 400Gi
        volumeMounts:
        - name: dataset
          mountPath: /data
        - name: checkpoints
          mountPath: /checkpoints
      nodeSelector:
        nvidia.com/gpu.product: A100-SXM4-80GB
        node.kubernetes.io/instance-type: p4d.24xlarge
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      volumes:
      - name: dataset
        persistentVolumeClaim:
          claimName: training-dataset
      - name: checkpoints
        persistentVolumeClaim:
          claimName: model-checkpoints
      restartPolicy: OnFailure
  backoffLimit: 3
```

### Topology-Aware Scheduling

```yaml
# gpu-topology-scheduling.yaml
# Configure topology-aware GPU scheduling

---
# Node with GPU topology labels
apiVersion: v1
kind: Node
metadata:
  name: gpu-node-1
  labels:
    nvidia.com/gpu.count: "8"
    nvidia.com/gpu.product: "A100-SXM4-80GB"
    nvidia.com/gpu.memory: "81920"
    topology.kubernetes.io/region: us-west-2
    topology.kubernetes.io/zone: us-west-2a
    nvidia.com/nvlink: "true"
    nvidia.com/gpu-topology: "nvswitch"
---
# Pod requiring NVLink connectivity
apiVersion: v1
kind: Pod
metadata:
  name: multi-gpu-training
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          # Require NVLink support
          - key: nvidia.com/nvlink
            operator: In
            values: ["true"]
          # Require minimum 8 GPUs
          - key: nvidia.com/gpu.count
            operator: In
            values: ["8"]
          # Prefer NVSwitch topology
          - key: nvidia.com/gpu-topology
            operator: In
            values: ["nvswitch"]
    podAntiAffinity:
      # Avoid co-locating with other GPU-intensive workloads
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: workload-type
              operator: In
              values: ["gpu-intensive"]
          topologyKey: kubernetes.io/hostname
  containers:
  - name: trainer
    image: nvcr.io/nvidia/pytorch:23.12-py3
    resources:
      limits:
        nvidia.com/gpu: 8
    env:
    - name: NCCL_DEBUG
      value: "INFO"
    - name: NCCL_IB_DISABLE
      value: "0"
    - name: NCCL_SOCKET_IFNAME
      value: "^lo,docker"
```

### Resource Quota Management

```yaml
# gpu-resource-quotas.yaml
# Implement GPU resource quotas per namespace

---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ml-team-gpu-quota
  namespace: ml-team
spec:
  hard:
    # Maximum GPU allocation
    requests.nvidia.com/gpu: "32"
    limits.nvidia.com/gpu: "32"

    # MIG resource limits
    requests.nvidia.com/mig-1g.5gb: "20"
    requests.nvidia.com/mig-2g.10gb: "10"
    requests.nvidia.com/mig-3g.20gb: "8"

    # Time-sliced GPU limits
    requests.nvidia.com/gpu.shared: "50"

    # Pod limits
    pods: "100"

    # Memory and CPU limits
    requests.memory: "2Ti"
    limits.memory: "4Ti"
    requests.cpu: "500"
    limits.cpu: "1000"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: ml-team-limits
  namespace: ml-team
spec:
  limits:
  # Container limits
  - max:
      nvidia.com/gpu: "8"
      memory: "500Gi"
      cpu: "64"
    min:
      memory: "1Gi"
      cpu: "1"
    default:
      memory: "16Gi"
      cpu: "4"
    defaultRequest:
      memory: "8Gi"
      cpu: "2"
    type: Container

  # Pod limits
  - max:
      nvidia.com/gpu: "8"
      memory: "1Ti"
      cpu: "128"
    type: Pod
```

## Monitoring and Observability

### DCGM Metrics Collection

```yaml
# dcgm-servicemonitor.yaml
# Configure DCGM metrics collection

apiVersion: v1
kind: ConfigMap
metadata:
  name: dcgm-exporter-config
  namespace: gpu-operator-resources
data:
  default-metrics.csv: |
    # Format: DCGM_FI_<metric_name>, <Prometheus metric name>, <metric type>, <help text>

    # GPU Utilization
    DCGM_FI_DEV_GPU_UTIL, dcgm_gpu_utilization, gauge, GPU utilization (%)
    DCGM_FI_DEV_MEM_COPY_UTIL, dcgm_mem_copy_utilization, gauge, Memory bandwidth utilization (%)
    DCGM_FI_DEV_ENC_UTIL, dcgm_encoder_utilization, gauge, Encoder utilization (%)
    DCGM_FI_DEV_DEC_UTIL, dcgm_decoder_utilization, gauge, Decoder utilization (%)

    # Memory
    DCGM_FI_DEV_FB_FREE, dcgm_fb_free, gauge, Framebuffer free memory (MB)
    DCGM_FI_DEV_FB_USED, dcgm_fb_used, gauge, Framebuffer used memory (MB)

    # Temperature
    DCGM_FI_DEV_GPU_TEMP, dcgm_gpu_temp, gauge, GPU temperature (C)
    DCGM_FI_DEV_MEM_MAX_OP_TEMP, dcgm_mem_max_op_temp, gauge, Memory maximum operating temperature (C)

    # Power
    DCGM_FI_DEV_POWER_USAGE, dcgm_power_usage, gauge, Power usage (W)
    DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION, dcgm_total_energy_consumption, counter, Total energy consumption (mJ)

    # Clock speeds
    DCGM_FI_DEV_SM_CLOCK, dcgm_sm_clock, gauge, SM clock frequency (MHz)
    DCGM_FI_DEV_MEM_CLOCK, dcgm_mem_clock, gauge, Memory clock frequency (MHz)

    # PCIe
    DCGM_FI_DEV_PCIE_TX_THROUGHPUT, dcgm_pcie_tx_throughput, gauge, PCIe TX throughput (KB/s)
    DCGM_FI_DEV_PCIE_RX_THROUGHPUT, dcgm_pcie_rx_throughput, gauge, PCIe RX throughput (KB/s)
    DCGM_FI_DEV_PCIE_REPLAY_COUNTER, dcgm_pcie_replay_counter, counter, PCIe replay counter

    # NVLink
    DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL, dcgm_nvlink_bandwidth_total, gauge, Total NVLink bandwidth (KB/s)

    # XID Errors
    DCGM_FI_DEV_XID_ERRORS, dcgm_xid_errors, gauge, XID error count

    # ECC Errors
    DCGM_FI_DEV_ECC_SBE_VOL_TOTAL, dcgm_ecc_sbe_volatile_total, counter, Total single bit ECC errors
    DCGM_FI_DEV_ECC_DBE_VOL_TOTAL, dcgm_ecc_dbe_volatile_total, counter, Total double bit ECC errors

    # Retired pages
    DCGM_FI_DEV_RETIRED_SBE, dcgm_retired_pages_sbe, counter, Retired pages due to SBE
    DCGM_FI_DEV_RETIRED_DBE, dcgm_retired_pages_dbe, counter, Retired pages due to DBE

    # Compute processes
    DCGM_FI_DEV_COMPUTE_PIDS, dcgm_compute_pids, gauge, Number of compute processes
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: dcgm-exporter
  namespace: gpu-operator-resources
spec:
  selector:
    matchLabels:
      app: nvidia-dcgm-exporter
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
---
# Grafana dashboard ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  gpu-monitoring.json: |
    {
      "dashboard": {
        "title": "GPU Monitoring",
        "panels": [
          {
            "title": "GPU Utilization",
            "targets": [
              {
                "expr": "dcgm_gpu_utilization"
              }
            ]
          },
          {
            "title": "GPU Memory Usage",
            "targets": [
              {
                "expr": "dcgm_fb_used / (dcgm_fb_used + dcgm_fb_free) * 100"
              }
            ]
          },
          {
            "title": "GPU Temperature",
            "targets": [
              {
                "expr": "dcgm_gpu_temp"
              }
            ]
          },
          {
            "title": "GPU Power Usage",
            "targets": [
              {
                "expr": "dcgm_power_usage"
              }
            ]
          }
        ]
      }
    }
```

### Custom Monitoring Stack

```yaml
# gpu-monitoring-stack.yaml
# Deploy custom GPU monitoring

---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: gpu-metrics-collector
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: gpu-metrics-collector
  template:
    metadata:
      labels:
        app: gpu-metrics-collector
    spec:
      hostPID: true
      hostIPC: true
      containers:
      - name: collector
        image: nvcr.io/nvidia/cuda:12.3.1-base-ubuntu22.04
        securityContext:
          privileged: true
        command:
        - /bin/bash
        - -c
        - |
          apt-get update && apt-get install -y python3 python3-pip
          pip3 install prometheus-client pynvml

          cat << 'PYEOF' > /collect-metrics.py
          #!/usr/bin/env python3
          import time
          import pynvml
          from prometheus_client import start_http_server, Gauge, Counter

          # Initialize NVML
          pynvml.nvmlInit()

          # Define metrics
          gpu_utilization = Gauge('custom_gpu_utilization', 'GPU utilization', ['gpu', 'uuid'])
          gpu_memory_used = Gauge('custom_gpu_memory_used_bytes', 'GPU memory used', ['gpu', 'uuid'])
          gpu_memory_total = Gauge('custom_gpu_memory_total_bytes', 'GPU memory total', ['gpu', 'uuid'])
          gpu_temperature = Gauge('custom_gpu_temperature_celsius', 'GPU temperature', ['gpu', 'uuid'])
          gpu_power = Gauge('custom_gpu_power_watts', 'GPU power usage', ['gpu', 'uuid'])
          gpu_clock_sm = Gauge('custom_gpu_sm_clock_mhz', 'GPU SM clock', ['gpu', 'uuid'])
          gpu_clock_memory = Gauge('custom_gpu_memory_clock_mhz', 'GPU memory clock', ['gpu', 'uuid'])
          gpu_pcie_tx = Gauge('custom_gpu_pcie_tx_bytes', 'PCIe TX throughput', ['gpu', 'uuid'])
          gpu_pcie_rx = Gauge('custom_gpu_pcie_rx_bytes', 'PCIe RX throughput', ['gpu', 'uuid'])

          def collect_metrics():
              device_count = pynvml.nvmlDeviceGetCount()

              for i in range(device_count):
                  handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                  uuid = pynvml.nvmlDeviceGetUUID(handle)

                  # Utilization
                  util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                  gpu_utilization.labels(gpu=str(i), uuid=uuid).set(util.gpu)

                  # Memory
                  mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                  gpu_memory_used.labels(gpu=str(i), uuid=uuid).set(mem.used)
                  gpu_memory_total.labels(gpu=str(i), uuid=uuid).set(mem.total)

                  # Temperature
                  temp = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
                  gpu_temperature.labels(gpu=str(i), uuid=uuid).set(temp)

                  # Power
                  power = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0  # Convert to watts
                  gpu_power.labels(gpu=str(i), uuid=uuid).set(power)

                  # Clocks
                  sm_clock = pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_SM)
                  mem_clock = pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_MEM)
                  gpu_clock_sm.labels(gpu=str(i), uuid=uuid).set(sm_clock)
                  gpu_clock_memory.labels(gpu=str(i), uuid=uuid).set(mem_clock)

                  # PCIe throughput
                  pcie_tx = pynvml.nvmlDeviceGetPcieThroughput(handle, pynvml.NVML_PCIE_UTIL_TX_BYTES)
                  pcie_rx = pynvml.nvmlDeviceGetPcieThroughput(handle, pynvml.NVML_PCIE_UTIL_RX_BYTES)
                  gpu_pcie_tx.labels(gpu=str(i), uuid=uuid).set(pcie_tx * 1024)  # Convert to bytes
                  gpu_pcie_rx.labels(gpu=str(i), uuid=uuid).set(pcie_rx * 1024)

          if __name__ == '__main__':
              start_http_server(9400)
              print("Metrics server started on port 9400")

              while True:
                  try:
                      collect_metrics()
                  except Exception as e:
                      print(f"Error collecting metrics: {e}")
                  time.sleep(10)
          PYEOF

          chmod +x /collect-metrics.py
          python3 /collect-metrics.py
        ports:
        - containerPort: 9400
          name: metrics
        volumeMounts:
        - name: nvidia
          mountPath: /usr/local/nvidia
      nodeSelector:
        nvidia.com/gpu: "true"
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      volumes:
      - name: nvidia
        hostPath:
          path: /usr/local/nvidia
```

## Performance Optimization

### GPU Memory Management

```yaml
# gpu-memory-optimization.yaml
# Optimize GPU memory allocation

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-memory-config
  namespace: ml-workloads
data:
  optimize-memory.sh: |
    #!/bin/bash

    # Configure CUDA memory allocation
    export CUDA_DEVICE_ORDER=PCI_BUS_ID
    export CUDA_VISIBLE_DEVICES=0,1,2,3,4,5,6,7

    # Enable unified memory
    export CUDA_MANAGED_FORCE_DEVICE_ALLOC=1

    # Memory pool configuration
    export PYTORCH_CUDA_ALLOC_CONF="max_split_size_mb:512,garbage_collection_threshold:0.6"

    # TensorFlow memory growth
    export TF_FORCE_GPU_ALLOW_GROWTH=true
    export TF_GPU_ALLOCATOR=cuda_malloc_async

    # Optimize for A100
    export NCCL_ALGO=Ring
    export NCCL_PROTO=Simple
    export NCCL_MIN_NCHANNELS=16
    export NCCL_MAX_NCHANNELS=16
---
apiVersion: v1
kind: Pod
metadata:
  name: optimized-training
spec:
  containers:
  - name: trainer
    image: nvcr.io/nvidia/pytorch:23.12-py3
    command:
    - bash
    - -c
    - |
      source /config/optimize-memory.sh

      python3 << 'EOF'
      import torch
      import torch.cuda

      # Enable TF32 for A100
      torch.backends.cuda.matmul.allow_tf32 = True
      torch.backends.cudnn.allow_tf32 = True

      # Enable cuDNN benchmarking
      torch.backends.cudnn.benchmark = True

      # Memory optimization
      torch.cuda.empty_cache()
      torch.cuda.memory.set_per_process_memory_fraction(0.95, 0)

      # Your training code here
      print("GPU memory optimization configured")
      print(f"Total GPU memory: {torch.cuda.get_device_properties(0).total_memory / 1e9:.2f} GB")
      print(f"Allocated: {torch.cuda.memory_allocated(0) / 1e9:.2f} GB")
      print(f"Cached: {torch.cuda.memory_reserved(0) / 1e9:.2f} GB")
      EOF
    resources:
      limits:
        nvidia.com/gpu: 8
        memory: 400Gi
    volumeMounts:
    - name: config
      mountPath: /config
  volumes:
  - name: config
    configMap:
      name: gpu-memory-config
```

### NCCL Optimization

```bash
#!/bin/bash
# NCCL tuning for multi-GPU training

cat << 'EOF' > /usr/local/bin/tune-nccl.sh
#!/bin/bash

# Detect GPU topology
NVLINK_ENABLED=$(nvidia-smi nvlink --status 2>/dev/null | grep -c "Active")
GPU_COUNT=$(nvidia-smi -L | wc -l)

echo "=== NCCL Optimization Configuration ==="
echo "GPU Count: $GPU_COUNT"
echo "NVLink Enabled: $NVLINK_ENABLED"

# Base NCCL configuration
export NCCL_DEBUG=INFO
export NCCL_DEBUG_SUBSYS=INIT,GRAPH,ENV

# Network interface configuration
export NCCL_SOCKET_IFNAME=^lo,docker0
export NCCL_IB_DISABLE=0

if [ "$NVLINK_ENABLED" -gt 0 ]; then
    echo "Optimizing for NVLink topology"

    # NVLink optimizations
    export NCCL_P2P_LEVEL=NVL
    export NCCL_ALGO=Ring
    export NCCL_PROTO=Simple

    # For NVSwitch systems
    if nvidia-smi topo -m | grep -q "NV"; then
        echo "NVSwitch detected"
        export NCCL_CROSS_NIC=1
        export NCCL_ALGO=Tree
        export NCCL_MIN_NCHANNELS=16
    fi
else
    echo "Optimizing for PCIe topology"
    export NCCL_P2P_LEVEL=PIX
    export NCCL_ALGO=Tree
    export NCCL_PROTO=LL
fi

# InfiniBand configuration if available
if [ -d "/sys/class/infiniband" ]; then
    IB_DEVICES=$(ls /sys/class/infiniband | wc -l)
    echo "InfiniBand devices detected: $IB_DEVICES"

    export NCCL_IB_DISABLE=0
    export NCCL_IB_HCA=mlx5
    export NCCL_IB_GID_INDEX=3
    export NCCL_IB_TC=106
    export NCCL_IB_TIMEOUT=22
    export NCCL_IB_RETRY_CNT=7

    # Enable GPU Direct RDMA if available
    if [ -d "/sys/kernel/mm/memory_peer_target" ]; then
        echo "GPU Direct RDMA available"
        export NCCL_NET_GDR_LEVEL=5
        export NCCL_NET_GDR_READ=1
    fi
fi

# Optimize for specific GPU counts
case $GPU_COUNT in
    8)
        export NCCL_MAX_NCHANNELS=8
        export NCCL_MIN_NCHANNELS=8
        ;;
    16)
        export NCCL_MAX_NCHANNELS=16
        export NCCL_MIN_NCHANNELS=16
        ;;
    *)
        export NCCL_MAX_NCHANNELS=4
        export NCCL_MIN_NCHANNELS=4
        ;;
esac

# Print configuration
echo
echo "=== Applied NCCL Configuration ==="
env | grep NCCL_ | sort

# Run NCCL test if available
if command -v nccl-test &> /dev/null; then
    echo
    echo "=== Running NCCL Test ==="
    nccl-test -b 8M -e 1G -f 2 -g $GPU_COUNT
fi
EOF

chmod +x /usr/local/bin/tune-nccl.sh
```

## Production Best Practices

### Health Monitoring

```yaml
# gpu-health-monitoring.yaml
# Implement GPU health checks

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-health-checks
  namespace: gpu-operator-resources
data:
  health-check.sh: |
    #!/bin/bash

    # GPU health check script
    EXIT_CODE=0

    # Check NVIDIA driver
    if ! nvidia-smi &>/dev/null; then
        echo "ERROR: nvidia-smi failed"
        EXIT_CODE=1
    fi

    # Check for Xid errors
    XID_ERRORS=$(nvidia-smi --query-gpu=gpu_uuid --format=csv,noheader | \
        xargs -I {} nvidia-smi -q -i {} | grep -i "Xid" | wc -l)
    if [ "$XID_ERRORS" -gt 0 ]; then
        echo "WARNING: Xid errors detected: $XID_ERRORS"
        EXIT_CODE=1
    fi

    # Check ECC errors
    ECC_ERRORS=$(nvidia-smi --query-gpu=ecc.errors.uncorrected.aggregate.total \
        --format=csv,noheader | awk '{sum+=$1} END {print sum}')
    if [ "$ECC_ERRORS" -gt 0 ]; then
        echo "ERROR: ECC errors detected: $ECC_ERRORS"
        EXIT_CODE=1
    fi

    # Check GPU temperature
    MAX_TEMP=$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader | \
        sort -n | tail -1)
    if [ "$MAX_TEMP" -gt 85 ]; then
        echo "WARNING: High GPU temperature: ${MAX_TEMP}C"
        EXIT_CODE=1
    fi

    # Check power throttling
    THROTTLE=$(nvidia-smi --query-gpu=clocks_throttle_reasons.active \
        --format=csv,noheader | grep -v "0x0000000000000000" | wc -l)
    if [ "$THROTTLE" -gt 0 ]; then
        echo "WARNING: GPU throttling detected"
    fi

    exit $EXIT_CODE
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: gpu-health-monitor
  namespace: gpu-operator-resources
spec:
  selector:
    matchLabels:
      app: gpu-health-monitor
  template:
    metadata:
      labels:
        app: gpu-health-monitor
    spec:
      hostPID: true
      containers:
      - name: monitor
        image: nvidia/cuda:12.3.1-base-ubuntu22.04
        command:
        - /bin/bash
        - -c
        - |
          while true; do
            /scripts/health-check.sh
            if [ $? -ne 0 ]; then
              echo "GPU health check failed, marking node as unhealthy"
              # Could trigger node drain or alert here
            fi
            sleep 60
          done
        volumeMounts:
        - name: health-scripts
          mountPath: /scripts
        securityContext:
          privileged: true
      nodeSelector:
        nvidia.com/gpu: "true"
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      volumes:
      - name: health-scripts
        configMap:
          name: gpu-health-checks
          defaultMode: 0755
```

### Automated Recovery

```yaml
# gpu-auto-recovery.yaml
# Implement automatic GPU recovery

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-recovery-scripts
  namespace: gpu-operator-resources
data:
  recover-gpu.sh: |
    #!/bin/bash

    # GPU recovery script
    LOG_FILE="/var/log/gpu-recovery.log"

    log() {
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
    }

    recover_gpu() {
        local gpu_id=$1
        log "Starting recovery for GPU $gpu_id"

        # Reset GPU
        log "Resetting GPU $gpu_id"
        nvidia-smi -i $gpu_id -r || {
            log "ERROR: Failed to reset GPU $gpu_id"
            return 1
        }

        # Wait for GPU to come back online
        sleep 10

        # Verify GPU is healthy
        if nvidia-smi -i $gpu_id &>/dev/null; then
            log "GPU $gpu_id recovered successfully"
            return 0
        else
            log "ERROR: GPU $gpu_id recovery failed"
            return 1
        fi
    }

    # Monitor for GPU failures
    while true; do
        for gpu_id in $(nvidia-smi -L | awk '{print $2}' | tr -d ':'); do
            # Check for Xid errors
            if nvidia-smi -q -i $gpu_id | grep -q "Xid"; then
                log "Xid error detected on GPU $gpu_id"
                recover_gpu $gpu_id
            fi

            # Check for fallen off bus
            if ! nvidia-smi -i $gpu_id &>/dev/null; then
                log "GPU $gpu_id fallen off bus"
                recover_gpu $gpu_id

                # If recovery fails, cordon the node
                if [ $? -ne 0 ]; then
                    log "Cordoning node due to unrecoverable GPU failure"
                    kubectl cordon $(hostname)
                fi
            fi
        done
        sleep 30
    done
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: gpu-auto-recovery
  namespace: gpu-operator-resources
spec:
  selector:
    matchLabels:
      app: gpu-auto-recovery
  template:
    metadata:
      labels:
        app: gpu-auto-recovery
    spec:
      hostPID: true
      hostNetwork: true
      serviceAccountName: gpu-recovery-sa
      containers:
      - name: recovery
        image: nvidia/cuda:12.3.1-base-ubuntu22.04
        command: ["/scripts/recover-gpu.sh"]
        volumeMounts:
        - name: recovery-scripts
          mountPath: /scripts
        - name: log
          mountPath: /var/log
        securityContext:
          privileged: true
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
      nodeSelector:
        nvidia.com/gpu: "true"
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      volumes:
      - name: recovery-scripts
        configMap:
          name: gpu-recovery-scripts
          defaultMode: 0755
      - name: log
        hostPath:
          path: /var/log
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: gpu-recovery-sa
  namespace: gpu-operator-resources
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gpu-recovery-role
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "patch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: gpu-recovery-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: gpu-recovery-role
subjects:
- kind: ServiceAccount
  name: gpu-recovery-sa
  namespace: gpu-operator-resources
```

## Conclusion

Effective GPU scheduling with NVIDIA GPU Operator requires understanding GPU topology, implementing appropriate sharing strategies (MIG, time-slicing), and maintaining comprehensive monitoring. The configurations and scripts provided enable enterprise-grade GPU resource management with automated recovery, detailed observability, and optimized performance for AI/ML workloads at scale.

Key takeaways for production GPU scheduling:
- Use MIG for workload isolation and guaranteed resources
- Implement time-slicing for development and testing environments
- Configure topology-aware scheduling for multi-GPU workloads
- Maintain comprehensive monitoring with DCGM
- Implement automated health checks and recovery
- Optimize NCCL settings based on GPU topology
- Use resource quotas to prevent resource exhaustion
- Plan capacity based on actual GPU utilization patterns