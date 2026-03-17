---
title: "Kubernetes GPU Scheduling: NVIDIA MIG, Time-Slicing, and GPU Sharing"
date: 2029-08-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GPU", "NVIDIA", "MIG", "DCGM", "AI", "Machine Learning"]
categories: ["Kubernetes", "GPU Computing"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to GPU scheduling on Kubernetes: NVIDIA MIG instance configuration on A100/H100, time-slicing ConfigMap, GPU sharing strategies, DCGM monitoring, and resource quota management for GPU workloads."
more_link: "yes"
url: "/kubernetes-gpu-scheduling-nvidia-mig-time-slicing/"
---

Running AI and ML workloads on Kubernetes requires understanding not just pod scheduling but GPU resource partitioning. A single A100 or H100 GPU costs thousands of dollars — running one workload per physical GPU is wasteful. NVIDIA provides two mechanisms for sharing: MIG (Multi-Instance GPU) for hardware-level partitioning and time-slicing for software-level multiplexing. This post covers both, along with DCGM monitoring and resource quota policies.

<!--more-->

# Kubernetes GPU Scheduling: NVIDIA MIG, Time-Slicing, and GPU Sharing

## Section 1: NVIDIA GPU Architecture Primer

### GPU Memory and Compute Hierarchy

```
Physical GPU (A100 80GB SXM)
├── Memory: 80 GB HBM2e
├── Compute: 6912 CUDA cores, 432 Tensor Cores
├── SM count: 108 Streaming Multiprocessors
└── NVLink bandwidth: 600 GB/s

MIG Partitions (hardware isolation)
├── 1g.10gb  — 1/7 GPU, 10 GB memory   (7 instances max)
├── 2g.20gb  — 2/7 GPU, 20 GB memory   (3 instances max)
├── 3g.40gb  — 3/7 GPU, 40 GB memory   (2 instances max)
├── 4g.40gb  — 4/7 GPU, 40 GB memory   (1 instance max)
└── 7g.80gb  — 7/7 GPU, 80 GB memory   (1 instance, full GPU)

Time-Slicing (software multiplexing — no memory isolation)
└── Multiple processes share all GPU resources, scheduler time-slices
```

### Choosing Between MIG and Time-Slicing

| Feature | MIG | Time-Slicing |
|---|---|---|
| Memory isolation | Yes — hard partitions | No — shared memory space |
| Fault isolation | Yes — one MIG instance cannot crash another | No |
| Support | A100, A30, H100 only | All NVIDIA GPUs |
| Performance predictability | High — guaranteed resources | Low — contention possible |
| Use case | Production inference, regulated workloads | Dev/test, batch inference |
| Max sharing factor | 7 (A100) | Unlimited (practical limit: ~8) |
| Configuration overhead | High — requires node drain and reconfigure | Low — ConfigMap change |

## Section 2: Prerequisites and NVIDIA Operator

The NVIDIA GPU Operator installs all required components: device plugin, drivers, container toolkit, DCGM, and MIG manager.

### Installing the NVIDIA GPU Operator

```bash
# Add the NVIDIA Helm repo
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# Install the GPU Operator
helm upgrade --install gpu-operator nvidia/gpu-operator \
    --namespace gpu-operator \
    --create-namespace \
    --version v23.9.2 \
    --set operator.defaultRuntime=containerd \
    --values - << 'EOF'
driver:
  enabled: true
  version: "545.23.08"

toolkit:
  enabled: true

devicePlugin:
  enabled: true
  config:
    name: time-slicing-config   # ConfigMap name (created separately)
    default: "any"               # profile to apply when no node label matches

dcgm:
  enabled: true

dcgmExporter:
  enabled: true

migManager:
  enabled: true

validator:
  plugin:
    env:
      - name: WITH_WORKLOAD
        value: "true"
EOF

# Verify installation
kubectl get pods -n gpu-operator
kubectl get nodes -l nvidia.com/gpu.present=true
```

### Labeling GPU Nodes

```bash
# The GPU Operator auto-labels nodes with GPU information
kubectl get node gpu-node-1 --show-labels | grep nvidia
# nvidia.com/gpu=true
# nvidia.com/gpu.count=4
# nvidia.com/gpu.product=A100-SXM4-80GB
# nvidia.com/gpu.memory=81920
# nvidia.com/gpu.family=ampere
# nvidia.com/mig.capable=true

# Manual labels for scheduling control
kubectl label node gpu-node-1 nvidia.com/gpu.workload.config=ai-inference
kubectl label node gpu-node-2 nvidia.com/gpu.workload.config=ai-training
```

## Section 3: NVIDIA MIG — Multi-Instance GPU

MIG provides hardware-level isolation between GPU workloads. Each MIG instance has dedicated memory, compute engines, and L2 cache.

### Enabling MIG Mode on a Node

```bash
# Connect to the GPU node
ssh gpu-node-1

# Check GPU capability
nvidia-smi --query-gpu=gpu_name,mig.mode.current --format=csv
# GPU 00000000:00:04.0, Disabled

# Enable MIG mode (requires application drain first)
sudo nvidia-smi -i 0 -mig 1
# Enabled MIG Mode for GPU 00000000:00:04.0

# Reboot to apply
sudo reboot
```

### MIG Profiles on A100

```bash
# After enabling MIG, configure instance profiles
# First, remove existing instances
sudo nvidia-smi mig -dci  # delete compute instances
sudo nvidia-smi mig -dgi  # delete GPU instances

# View available profiles for A100 80GB
sudo nvidia-smi mig -lgip
# +-------------------------------------------------------+
# | GPU instance profiles:                                 |
# +------+------ ... ------+------------------+----------+
# |  GI  | profile | units |    memory (GiB)  |    P2P   |
# |  ID  |  name   | SM    | Total | Reserved |  Support |
# +------+---------+-------+-------+----------+----------+
# |    5 |    1g.10gb  |  14 |  10  |    0     |    No    |
# |   14 |    2g.20gb  |  28 |  20  |    0     |    No    |
# |   19 |    3g.40gb  |  42 |  40  |    0     |    No    |
# |   20 |    4g.40gb  |  56 |  40  |    0     |    No    |
# |    0 |    7g.80gb  |  98 |  80  |    0     |    No    |

# Create GPU instances (example: 7 instances of 1g.10gb on GPU 0)
for i in $(seq 1 7); do
    sudo nvidia-smi mig -cgi 5 -i 0
done

# Create compute instances in each GPU instance
sudo nvidia-smi mig -cci

# Verify
sudo nvidia-smi mig -lci
```

### MIG Manager ConfigMap

The NVIDIA GPU Operator's MIG Manager uses a ConfigMap to define the desired MIG configuration:

```yaml
# mig-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mig-config
  namespace: gpu-operator
data:
  # Configuration for different node types
  all-1g.10gb: |-
    version: v1
    mig-configs:
      all-1g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7

  all-2g.20gb: |-
    version: v1
    mig-configs:
      all-2g.20gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            "2g.20gb": 3
            "1g.10gb": 1

  mixed-for-training-and-inference: |-
    version: v1
    mig-configs:
      mixed:
        - devices: [0, 1]
          mig-enabled: true
          mig-devices:
            "3g.40gb": 2    # training workloads
        - devices: [2, 3]
          mig-enabled: true
          mig-devices:
            "1g.10gb": 7    # inference workloads

  all-disabled: |-
    version: v1
    mig-configs:
      all-disabled:
        - devices: all
          mig-enabled: false
```

### Applying MIG Configuration to Nodes

```bash
# Label the node with the desired MIG profile
kubectl label node gpu-node-1 nvidia.com/mig.config=all-1g.10gb

# The MIG Manager detects the label and applies the configuration
# Monitor progress:
kubectl logs -n gpu-operator -l app=nvidia-mig-manager -f

# After configuration, verify MIG instances appear as resources
kubectl describe node gpu-node-1 | grep nvidia.com/mig
# nvidia.com/mig-1g.10gb: 7
# nvidia.com/mig-1g.10gb (allocatable): 7
```

### Scheduling Pods to MIG Instances

```yaml
# pod-mig-1g.yaml — uses a 1g.10gb MIG instance
apiVersion: v1
kind: Pod
metadata:
  name: inference-job-1
  namespace: ai-workloads
spec:
  nodeSelector:
    nvidia.com/gpu.product: A100-SXM4-80GB
  containers:
    - name: inference
      image: nvcr.io/nvidia/pytorch:23.12-py3
      resources:
        limits:
          nvidia.com/mig-1g.10gb: 1    # request 1 MIG instance
      command: ["python3", "inference.py"]
      env:
        - name: MODEL_PATH
          value: /models/llm-7b
      volumeMounts:
        - name: model-cache
          mountPath: /models
  volumes:
    - name: model-cache
      persistentVolumeClaim:
        claimName: model-cache-pvc

---
# Training job using a larger MIG instance
apiVersion: v1
kind: Pod
metadata:
  name: training-job-1
spec:
  containers:
    - name: trainer
      image: nvcr.io/nvidia/pytorch:23.12-py3
      resources:
        limits:
          nvidia.com/mig-3g.40gb: 1   # request a 3g.40gb instance
```

## Section 4: Time-Slicing — Software GPU Sharing

Time-slicing allows multiple containers to share a single GPU by context-switching between them. It provides no memory isolation — all containers see and share the full GPU memory.

### Time-Slicing ConfigMap

```yaml
# time-slicing-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  # Default profile — 4-way sharing
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
            replicas: 4    # 4 pods share 1 physical GPU

  # For nodes with Tesla T4 (inference workers) — 8-way sharing
  t4-for-inference: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 8

  # For nodes with A100 (training) — no sharing
  a100-training: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 1    # 1:1, no sharing
```

```bash
# Apply the ConfigMap
kubectl apply -f time-slicing-config.yaml

# Label nodes to apply specific profiles
kubectl label node t4-node-1 nvidia.com/device-plugin.config=t4-for-inference
kubectl label node a100-node-1 nvidia.com/device-plugin.config=a100-training

# Verify the device plugin picked up the config
kubectl describe node t4-node-1 | grep nvidia.com/gpu
# nvidia.com/gpu:  8    ← 8 virtual GPUs from 1 physical GPU
```

### Scheduling to Time-Sliced GPUs

```yaml
# inference-deployment.yaml — runs 8 inference replicas on 1 T4
apiVersion: apps/v1
kind: Deployment
metadata:
  name: text-inference
  namespace: ai-workloads
spec:
  replicas: 8   # Each pod gets 1/8 of the GPU via time-slicing
  selector:
    matchLabels:
      app: text-inference
  template:
    metadata:
      labels:
        app: text-inference
    spec:
      nodeSelector:
        nvidia.com/device-plugin.config: t4-for-inference
      containers:
        - name: inference
          image: registry.internal/text-inference:v1.0
          resources:
            limits:
              nvidia.com/gpu: 1    # 1 "virtual" GPU = 1/8 physical T4
            requests:
              nvidia.com/gpu: 1
          env:
            - name: MODEL_SIZE
              value: "small"       # Use small model for shared GPU
```

### Time-Slicing Limitations

```bash
# Check GPU memory usage — ALL pods see the full GPU memory
# There is NO memory isolation with time-slicing

# Pod A requests 1 time-sliced GPU
# Pod B requests 1 time-sliced GPU
# Both pods can allocate up to the FULL physical GPU memory
# If Pod A allocates 15GB on a 16GB GPU, Pod B will get OOM errors

# This means you MUST enforce memory limits at the application level
# For PyTorch:
import torch
torch.cuda.set_per_process_memory_fraction(0.12)  # limit to 12% of GPU memory
```

## Section 5: DCGM Monitoring

NVIDIA DCGM (Data Center GPU Manager) provides detailed GPU telemetry. The DCGM Exporter exposes these metrics to Prometheus.

### DCGM Metrics Available

```bash
# View all available DCGM metrics
kubectl exec -n gpu-operator -it $(kubectl get pod -n gpu-operator -l app=nvidia-dcgm-exporter -o name | head -1) \
    -- cat /etc/dcgm-exporter/dcp-metrics-included.csv

# Key metrics for monitoring:
# DCGM_FI_DEV_GPU_UTIL          — GPU utilization (%)
# DCGM_FI_DEV_MEM_COPY_UTIL     — Memory bandwidth utilization (%)
# DCGM_FI_DEV_FB_USED           — Framebuffer (GPU memory) used (MiB)
# DCGM_FI_DEV_FB_FREE           — Framebuffer free (MiB)
# DCGM_FI_DEV_GPU_TEMP          — GPU temperature (°C)
# DCGM_FI_DEV_POWER_USAGE       — Power draw (W)
# DCGM_FI_DEV_SM_CLOCK          — SM clock speed (MHz)
# DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL — NVLink bandwidth (MB/s)
# DCGM_FI_PROF_PIPE_TENSOR_ACTIVE  — Tensor core utilization (ratio)
# DCGM_FI_PROF_DRAM_ACTIVE      — HBM active cycles (ratio)
```

### DCGM Exporter Configuration

```yaml
# Custom metrics config for detailed monitoring
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcgm-metrics-config
  namespace: gpu-operator
data:
  dcp-metrics.csv: |
    # Format: field_id, type, name, help
    DCGM_FI_DEV_GPU_UTIL,       gauge, DCGM_FI_DEV_GPU_UTIL,       GPU utilization (%)
    DCGM_FI_DEV_MEM_COPY_UTIL,  gauge, DCGM_FI_DEV_MEM_COPY_UTIL,  Memory copy engine utilization (%)
    DCGM_FI_DEV_FB_USED,        gauge, DCGM_FI_DEV_FB_USED,        GPU framebuffer memory used (MiB)
    DCGM_FI_DEV_FB_FREE,        gauge, DCGM_FI_DEV_FB_FREE,        GPU framebuffer memory free (MiB)
    DCGM_FI_DEV_GPU_TEMP,       gauge, DCGM_FI_DEV_GPU_TEMP,       GPU temperature (C)
    DCGM_FI_DEV_POWER_USAGE,    gauge, DCGM_FI_DEV_POWER_USAGE,    GPU power draw (W)
    DCGM_FI_DEV_SM_CLOCK,       gauge, DCGM_FI_DEV_SM_CLOCK,       SM clock speed (MHz)
    DCGM_FI_DEV_MEM_CLOCK,      gauge, DCGM_FI_DEV_MEM_CLOCK,      Memory clock speed (MHz)
    DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL, gauge, DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL, NVLink bandwidth (MB/s)
    DCGM_FI_PROF_PIPE_TENSOR_ACTIVE,    gauge, DCGM_FI_PROF_PIPE_TENSOR_ACTIVE,    Tensor core active (ratio)
    DCGM_FI_PROF_DRAM_ACTIVE,           gauge, DCGM_FI_PROF_DRAM_ACTIVE,           DRAM bandwidth utilization
    DCGM_FI_PROF_GR_ENGINE_ACTIVE,      gauge, DCGM_FI_PROF_GR_ENGINE_ACTIVE,      Graphics engine active
```

### Prometheus Alerting Rules for GPUs

```yaml
# prometheus-gpu-alerts.yaml
groups:
  - name: gpu_health
    rules:
      - alert: GPUHighTemperature
        expr: DCGM_FI_DEV_GPU_TEMP > 85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU temperature critical on {{ $labels.instance }}"
          description: "GPU {{ $labels.gpu }} temperature is {{ $value }}°C (threshold: 85°C)"

      - alert: GPUMemoryFull
        expr: |
          DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) > 0.95
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "GPU memory > 95% on {{ $labels.instance }}"

      - alert: GPULowUtilization
        expr: |
          avg_over_time(DCGM_FI_DEV_GPU_UTIL[30m]) < 10
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "GPU underutilized on {{ $labels.instance }}"
          description: "GPU {{ $labels.gpu }} has been < 10% utilized for 30 minutes. Consider scaling down."

      - alert: GPUPowerThrottling
        expr: |
          DCGM_FI_DEV_SM_CLOCK < 700 and DCGM_FI_DEV_GPU_UTIL > 50
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU may be power-throttling on {{ $labels.instance }}"

      - alert: GPUXidError
        expr: increase(DCGM_FI_DEV_XID_ERRORS_TOTAL[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "GPU Xid error detected on {{ $labels.instance }}"
          description: "GPU hardware error detected. Check nvidia-smi and dmesg."
```

### Grafana Dashboard Queries

```promql
# GPU utilization per node
avg by (instance, gpu) (DCGM_FI_DEV_GPU_UTIL)

# Memory usage per GPU
DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100

# Tensor core utilization (key for AI training efficiency)
DCGM_FI_PROF_PIPE_TENSOR_ACTIVE * 100

# GPU-hours consumed by namespace (for chargeback)
sum by (namespace) (
    increase(container_gpu_allocation_time_seconds_total[24h])
)
```

## Section 6: Resource Quota for GPU Workloads

### Namespace-Level GPU Quotas

```yaml
# gpu-resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: ai-workloads
spec:
  hard:
    # Limit total GPU allocation for this namespace
    requests.nvidia.com/gpu: "4"
    limits.nvidia.com/gpu: "4"

    # MIG instance quotas
    requests.nvidia.com/mig-1g.10gb: "14"   # 2 A100s fully partitioned into 1g.10gb
    limits.nvidia.com/mig-1g.10gb: "14"

    requests.nvidia.com/mig-3g.40gb: "4"
    limits.nvidia.com/mig-3g.40gb: "4"

    # Standard compute quotas alongside GPU quotas
    requests.cpu: "64"
    requests.memory: "256Gi"

---
# Priority-based GPU access
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-critical
value: 1000000
globalDefault: false
description: "Priority class for critical GPU workloads"

---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-batch
value: 100000
globalDefault: false
description: "Priority class for batch GPU training jobs"
```

### LimitRange for GPU Containers

```yaml
# gpu-limitrange.yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-limits
  namespace: ai-workloads
spec:
  limits:
    - type: Container
      max:
        nvidia.com/gpu: "4"         # No container can request more than 4 GPUs
        nvidia.com/mig-3g.40gb: "2"
      min:
        cpu: "500m"                  # GPU workloads need real CPU too
        memory: "4Gi"
      default:
        cpu: "2"
        memory: "8Gi"
      defaultRequest:
        cpu: "1"
        memory: "4Gi"
```

### GPU Quota Monitoring

```bash
# Check namespace GPU consumption
kubectl describe resourcequota gpu-quota -n ai-workloads
# Name:                     gpu-quota
# Resource                  Used  Hard
# --------                  ---   ---
# limits.nvidia.com/gpu     2     4
# requests.nvidia.com/gpu   2     4

# List GPU usage by pod
kubectl get pods -n ai-workloads -o json | \
    jq '.items[] | {name: .metadata.name, gpu: .spec.containers[].resources.limits["nvidia.com/gpu"]}' | \
    jq -s 'group_by(.name)[] | {pod: .[0].name, total_gpu: map(.gpu | tonumber) | add}'

# Custom metrics for GPU quota tracking
kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/ai-workloads/pods | \
    jq '.items[].containers[].usage["nvidia.com/gpu"]'
```

## Section 7: Complete GPU Workload Examples

### Training Job with Full GPU

```yaml
# training-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: llm-fine-tuning
  namespace: ai-workloads
spec:
  backoffLimit: 3
  template:
    spec:
      priorityClassName: gpu-critical
      nodeSelector:
        nvidia.com/gpu.product: A100-SXM4-80GB
        nvidia.com/device-plugin.config: a100-training
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: trainer
          image: nvcr.io/nvidia/pytorch:23.12-py3
          resources:
            limits:
              nvidia.com/gpu: "4"    # Use 4 A100s for training
              cpu: "48"
              memory: "256Gi"
            requests:
              nvidia.com/gpu: "4"
              cpu: "32"
              memory: "192Gi"
          env:
            - name: NCCL_DEBUG
              value: INFO
            - name: MASTER_PORT
              value: "23456"
          command:
            - torchrun
            - --nproc_per_node=4
            - train.py
            - --model=llama-13b
            - --epochs=3
            - --batch-size=32
          volumeMounts:
            - name: dataset
              mountPath: /data
            - name: checkpoints
              mountPath: /checkpoints
            - name: shm
              mountPath: /dev/shm
      volumes:
        - name: dataset
          persistentVolumeClaim:
            claimName: training-dataset
        - name: checkpoints
          persistentVolumeClaim:
            claimName: model-checkpoints
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 16Gi    # Shared memory for multi-GPU communication
      restartPolicy: OnFailure
```

### Inference Deployment with MIG

```yaml
# inference-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: llm-inference
  namespace: ai-workloads
spec:
  replicas: 7   # One per MIG instance
  selector:
    matchLabels:
      app: llm-inference
  template:
    metadata:
      labels:
        app: llm-inference
    spec:
      nodeSelector:
        nvidia.com/mig.config: all-1g.10gb
      containers:
        - name: inference
          image: registry.internal/llm-inference:v2.0
          resources:
            limits:
              nvidia.com/mig-1g.10gb: 1
              cpu: "4"
              memory: "16Gi"
          ports:
            - containerPort: 8000
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 30
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 60
            periodSeconds: 15
```

## Section 8: GPU Node Maintenance

```bash
# Drain GPU workloads before node maintenance
kubectl drain gpu-node-1 \
    --grace-period=300 \
    --ignore-daemonsets \
    --delete-emptydir-data

# After maintenance, uncordon
kubectl uncordon gpu-node-1

# Check GPU health after driver update
nvidia-smi -q | grep -E "Product Name|Driver Version|CUDA Version|GPU UUID|ECC Mode"

# Run DCGM health check
dcgmi diag --run 1  # quick check
dcgmi diag --run 3  # full check (takes ~10 minutes)

# Reset GPU if needed (use carefully — terminates all processes)
nvidia-smi --gpu-reset -i 0
```

## Section 9: Cost Allocation and Chargeback

```bash
# KEDA-based autoscaling to reduce idle GPU costs
cat > keda-gpu-scaler.yaml << 'EOF'
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: gpu-inference-scaler
  namespace: ai-workloads
spec:
  scaleTargetRef:
    name: llm-inference
  minReplicaCount: 1
  maxReplicaCount: 7
  cooldownPeriod: 300  # 5 minutes — GPU workloads need time to stabilize
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc:9090
        metricName: inference_queue_depth
        query: inference_request_queue_depth{service="llm-inference"}
        threshold: "50"
EOF

# GPU utilization-based alerts to identify idle GPUs
# Alert if GPU < 20% for 30 minutes — indicates waste
```

```yaml
# Prometheus recording rules for GPU chargeback
groups:
  - name: gpu_chargeback
    interval: 1m
    rules:
      - record: namespace:gpu_hours_used:rate1h
        expr: |
          sum by (namespace) (
            kube_pod_container_resource_limits{resource="nvidia.com/gpu"}
            * on(pod, namespace) group_left()
            kube_pod_status_phase{phase="Running"}
          ) * (1/3600)

      - record: node:gpu_cost_per_hour:usd
        expr: |
          sum by (node) (
            kube_node_labels{label_cloud_node_type=~"p4d.24xlarge|p3.16xlarge"}
          ) * 32.77  # p4d.24xlarge hourly on-demand price
```

## Section 10: Production Checklist

- [ ] NVIDIA GPU Operator installed and all pods running in `gpu-operator` namespace
- [ ] Nodes auto-labeled with GPU product, count, and MIG capability
- [ ] MIG mode enabled on A100/H100 nodes that need it
- [ ] MIG ConfigMap created with profiles matching workload requirements
- [ ] Time-slicing ConfigMap created for T4/V100 shared inference nodes
- [ ] RuntimeClass or node selectors enforcing GPU node selection
- [ ] DCGM Exporter running and scraping by Prometheus
- [ ] Alerts configured for: high temperature, high memory usage, Xid errors, low utilization
- [ ] ResourceQuota per namespace limiting GPU consumption
- [ ] LimitRange preventing single containers from consuming all GPUs
- [ ] PriorityClass defined for training vs inference workloads
- [ ] KEDA ScaledObject configured for queue-depth based autoscaling
- [ ] Node drain/uncordon procedure documented and tested
- [ ] GPU chargeback recording rules in Prometheus for cost attribution

## Conclusion

GPU resource management on Kubernetes requires a layered approach. MIG provides hardware-level isolation and predictable performance for production inference workloads where one tenant's job should not affect another. Time-slicing provides cost-efficient sharing for development, testing, and batch inference where strict isolation is not required.

The NVIDIA GPU Operator handles the operational complexity of driver management, device plugin deployment, and MIG reconfiguration. DCGM gives you the observability to catch hardware failures early, track utilization efficiency, and implement chargeback. Combined with ResourceQuota and LimitRange, you get the governance model needed to run a multi-tenant GPU cluster without overspending or letting one team monopolize resources.

Start with the GPU Operator, configure DCGM monitoring, then progressively enable MIG on A100/H100 nodes as workloads mature and isolation requirements become clear.
