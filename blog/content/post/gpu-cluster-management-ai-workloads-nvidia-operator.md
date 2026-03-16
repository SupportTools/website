---
title: "GPU Cluster Management for AI Workloads with NVIDIA Operator: Complete Production Guide"
date: 2026-07-23T00:00:00-05:00
draft: false
tags: ["GPU", "NVIDIA", "Kubernetes", "AI Infrastructure", "Machine Learning", "CUDA", "Deep Learning", "DevOps"]
categories:
- GPU Computing
- Kubernetes
- AI Infrastructure
- NVIDIA
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to setting up and managing GPU clusters for AI workloads using NVIDIA GPU Operator with multi-tenancy, monitoring, and optimization strategies for production environments."
more_link: "yes"
url: "/gpu-cluster-management-ai-workloads-nvidia-operator/"
---

Managing GPU clusters for AI workloads requires sophisticated orchestration, resource sharing, and monitoring capabilities. The NVIDIA GPU Operator provides a comprehensive solution for deploying and managing GPU-enabled Kubernetes clusters with enterprise-grade features. This comprehensive guide covers setting up production-ready GPU infrastructure with advanced multi-tenancy, monitoring, and optimization strategies.

<!--more-->

# [GPU Cluster Management for AI Workloads with NVIDIA Operator](#gpu-cluster-management-ai-workloads-nvidia-operator)

## Section 1: NVIDIA GPU Operator Setup and Architecture

### Understanding NVIDIA GPU Operator Components

The NVIDIA GPU Operator automates the management of all NVIDIA software components needed to provision GPU nodes in Kubernetes. It includes the GPU device plugin, container runtime, drivers, and monitoring tools.

```yaml
# gpu-operator-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: gpu-operator
  labels:
    name: gpu-operator
    nvidia.com/gpu-operator-watched: "true"
---
apiVersion: v1
kind: Namespace
metadata:
  name: gpu-feature-discovery-system
  labels:
    name: gpu-feature-discovery-system
```

### Production GPU Operator Installation

```bash
#!/bin/bash
# install-gpu-operator.sh

set -euo pipefail

OPERATOR_VERSION="v23.9.1"
HELM_CHART_VERSION="v23.9.1"
NAMESPACE="gpu-operator"

# Add NVIDIA Helm repository
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# Create namespace
kubectl create namespace ${NAMESPACE} --dry-run=client -o yaml | kubectl apply -f -

# Install Node Feature Discovery (NFD) first
helm upgrade --install node-feature-discovery nfd/node-feature-discovery \
    --namespace node-feature-discovery \
    --create-namespace \
    --set master.extraLabelNs='{nvidia.com/gpu}' \
    --set worker.config.core.labelWhiteList='nvidia.com/gpu.*' \
    --wait

# Wait for NFD to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=node-feature-discovery -n node-feature-discovery --timeout=300s

# Install GPU Operator with production configuration
helm upgrade --install gpu-operator nvidia/gpu-operator \
    --namespace ${NAMESPACE} \
    --version ${HELM_CHART_VERSION} \
    --set operator.defaultRuntime=containerd \
    --set driver.enabled=true \
    --set driver.version="535.129.03" \
    --set toolkit.enabled=true \
    --set devicePlugin.enabled=true \
    --set dcgmExporter.enabled=true \
    --set dcgm.enabled=true \
    --set gfd.enabled=true \
    --set migManager.enabled=true \
    --set nodeStatusExporter.enabled=true \
    --set validator.plugin.env[0].name=WITH_WORKLOAD \
    --set validator.plugin.env[0].value=true \
    --set driver.manager.env[0].name=ENABLE_GPU_POD_EVICTION \
    --set driver.manager.env[0].value=true \
    --set driver.manager.env[1].name=ENABLE_AUTO_DRAIN \
    --set driver.manager.env[1].value=true \
    --set driver.manager.env[2].name=DRAIN_USE_FORCE \
    --set driver.manager.env[2].value=false \
    --set driver.manager.env[3].name=DRAIN_POD_SELECTOR_LABEL \
    --set driver.manager.env[3].value="" \
    --set driver.manager.env[4].name=DRAIN_TIMEOUT_SECONDS \
    --set driver.manager.env[4].value=0 \
    --set driver.manager.env[5].name=DRAIN_DELETE_EMPTYDIR_DATA \
    --set driver.manager.env[5].value=false \
    --wait \
    --timeout=600s

echo "GPU Operator installation completed. Checking status..."

# Wait for all GPU Operator components to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=gpu-operator -n ${NAMESPACE} --timeout=600s

# Verify GPU nodes are labeled
echo "Checking GPU node labels..."
kubectl get nodes -l nvidia.com/gpu.count -o custom-columns=NAME:.metadata.name,GPU-COUNT:.metadata.labels.'nvidia\.com/gpu\.count',GPU-MEMORY:.metadata.labels.'nvidia\.com/gpu\.memory'

# Verify device plugin is working
echo "Checking GPU device plugin..."
kubectl get nodes -o json | jq '.items[] | select(.status.allocatable."nvidia.com/gpu" != null) | {name: .metadata.name, gpus: .status.allocatable."nvidia.com/gpu"}'

echo "GPU Operator setup completed successfully!"
```

### Advanced GPU Operator Configuration

```yaml
# gpu-operator-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-operator-advanced-config
  namespace: gpu-operator
data:
  values.yaml: |
    operator:
      repository: nvcr.io/nvidia
      image: gpu-operator
      version: v23.9.1
      imagePullPolicy: IfNotPresent
      defaultRuntime: containerd
      runtimeClass: nvidia
      initContainer:
        image: cuda
        repository: nvcr.io/nvidia
        version: 12.3.1-base-ubi8
        imagePullPolicy: IfNotPresent
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      logging:
        timeEncoding: epoch
        verbosity: 2
    
    driver:
      enabled: true
      repository: nvcr.io/nvidia
      image: driver
      version: "535.129.03"
      imagePullPolicy: IfNotPresent
      manager:
        image: k8s-driver-manager
        repository: nvcr.io/nvidia
        version: v0.6.2
        imagePullPolicy: IfNotPresent
        env:
          - name: ENABLE_GPU_POD_EVICTION
            value: "true"
          - name: ENABLE_AUTO_DRAIN
            value: "true"
          - name: DRAIN_USE_FORCE
            value: "false"
          - name: DRAIN_TIMEOUT_SECONDS
            value: "0"
          - name: DRAIN_DELETE_EMPTYDIR_DATA
            value: "false"
      env:
        - name: NVIDIA_DISABLE_REQUIRE
          value: "true"
        - name: NVIDIA_VISIBLE_DEVICES
          value: "all"
        - name: NVIDIA_DRIVER_CAPABILITIES
          value: "compute,utility"
    
    toolkit:
      enabled: true
      repository: nvcr.io/nvidia/k8s
      image: container-toolkit
      version: v1.14.3-ubuntu20.04
      imagePullPolicy: IfNotPresent
      env:
        - name: CONTAINERD_CONFIG
          value: /etc/containerd/config.toml
        - name: CONTAINERD_SOCKET
          value: /run/containerd/containerd.sock
        - name: CONTAINERD_RUNTIME_CLASS
          value: nvidia
        - name: CONTAINERD_SET_AS_DEFAULT
          value: "true"
    
    devicePlugin:
      enabled: true
      repository: nvcr.io/nvidia
      image: k8s-device-plugin
      version: v0.14.3
      imagePullPolicy: IfNotPresent
      args:
        - "--mig-strategy=single"
        - "--pass-device-specs=true"
        - "--fail-on-init-error=true"
        - "--device-list-strategy=envvar"
        - "--device-id-strategy=uuid"
        - "--nvidia-driver-root=/run/nvidia/driver"
      env:
        - name: NVIDIA_MIG_MONITOR_DEVICES
          value: "all"
    
    dcgm:
      enabled: true
      repository: nvcr.io/nvidia/cloud-native
      image: dcgm
      version: 3.2.6-1-ubuntu20.04
      imagePullPolicy: IfNotPresent
      hostPort: 5555
      args:
        - "--host-engine-start"
        - "--kubernetes"
        - "--kubernetes-gpu-id-type=device-name"
    
    dcgmExporter:
      enabled: true
      repository: nvcr.io/nvidia/k8s
      image: dcgm-exporter
      version: 3.2.6-3.2.0-ubuntu20.04
      imagePullPolicy: IfNotPresent
      env:
        - name: DCGM_EXPORTER_LISTEN
          value: ":9400"
        - name: DCGM_EXPORTER_KUBERNETES
          value: "true"
        - name: DCGM_EXPORTER_COLLECTORS
          value: "/etc/dcgm-exporter/dcp-metrics-included.csv"
    
    gfd:
      enabled: true
      repository: nvcr.io/nvidia
      image: gpu-feature-discovery
      version: v0.8.2
      imagePullPolicy: IfNotPresent
      env:
        - name: GFD_SLEEP_INTERVAL
          value: "60s"
        - name: GFD_FAIL_ON_INIT_ERROR
          value: "true"
        - name: MIG_STRATEGY
          value: "single"
        - name: NVIDIA_MIG_MONITOR_DEVICES
          value: "all"
    
    migManager:
      enabled: true
      repository: nvcr.io/nvidia/cloud-native
      image: k8s-mig-manager
      version: v0.6.0-ubuntu20.04
      imagePullPolicy: IfNotPresent
      env:
        - name: WITH_REBOOT
          value: "false"
      config:
        name: mig-parted-config
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mig-parted-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    mig-configs:
      all-1g.10gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            1g.10gb: 7
      all-2g.20gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            2g.20gb: 3
      all-3g.40gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            3g.40gb: 2
      all-7g.80gb:
        - devices: all
          mig-enabled: true
          mig-devices:
            7g.80gb: 1
      mixed:
        - devices: all
          mig-enabled: true
          mig-devices:
            1g.10gb: 2
            2g.20gb: 1
            3g.40gb: 1
      all-disabled:
        - devices: all
          mig-enabled: false
```

## Section 2: Multi-Tenancy and Resource Isolation

### Namespace-Based GPU Multi-Tenancy

```yaml
# gpu-multi-tenancy.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ai-team-alpha
  labels:
    name: ai-team-alpha
    gpu-quota: "enabled"
    team: "alpha"
---
apiVersion: v1
kind: Namespace
metadata:
  name: ai-team-beta
  labels:
    name: ai-team-beta
    gpu-quota: "enabled"
    team: "beta"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota-alpha
  namespace: ai-team-alpha
spec:
  hard:
    requests.nvidia.com/gpu: "4"
    limits.nvidia.com/gpu: "4"
    requests.cpu: "32"
    requests.memory: "128Gi"
    limits.cpu: "64"
    limits.memory: "256Gi"
    persistentvolumeclaims: "10"
    requests.storage: "1Ti"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota-beta
  namespace: ai-team-beta
spec:
  hard:
    requests.nvidia.com/gpu: "6"
    limits.nvidia.com/gpu: "6"
    requests.cpu: "48"
    requests.memory: "192Gi"
    limits.cpu: "96"
    limits.memory: "384Gi"
    persistentvolumeclaims: "15"
    requests.storage: "2Ti"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-limits-alpha
  namespace: ai-team-alpha
spec:
  limits:
    - default:
        nvidia.com/gpu: "1"
        cpu: "4"
        memory: "16Gi"
      defaultRequest:
        nvidia.com/gpu: "1"
        cpu: "2"
        memory: "8Gi"
      max:
        nvidia.com/gpu: "2"
        cpu: "16"
        memory: "64Gi"
      min:
        nvidia.com/gpu: "0"
        cpu: "100m"
        memory: "128Mi"
      type: Container
    - max:
        nvidia.com/gpu: "4"
        cpu: "32"
        memory: "128Gi"
      type: Pod
---
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-limits-beta
  namespace: ai-team-beta
spec:
  limits:
    - default:
        nvidia.com/gpu: "1"
        cpu: "6"
        memory: "24Gi"
      defaultRequest:
        nvidia.com/gpu: "1"
        cpu: "3"
        memory: "12Gi"
      max:
        nvidia.com/gpu: "3"
        cpu: "24"
        memory: "96Gi"
      min:
        nvidia.com/gpu: "0"
        cpu: "100m"
        memory: "128Mi"
      type: Container
    - max:
        nvidia.com/gpu: "6"
        cpu: "48"
        memory: "192Gi"
      type: Pod
```

### Advanced GPU Sharing with MIG (Multi-Instance GPU)

```yaml
# mig-configuration.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mig-strategy-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    mig-configs:
      # Development environment - smaller instances
      dev-profile:
        - devices: [0, 1]
          mig-enabled: true
          mig-devices:
            1g.10gb: 7  # 7 small instances per GPU
      
      # Training environment - mixed instances
      training-profile:
        - devices: [0, 1, 2, 3]
          mig-enabled: true
          mig-devices:
            3g.40gb: 1  # Large instance for main training
            2g.20gb: 1  # Medium instance for validation
            1g.10gb: 2  # Small instances for monitoring
      
      # Inference environment - optimized for throughput
      inference-profile:
        - devices: [0, 1, 2, 3, 4, 5]
          mig-enabled: true
          mig-devices:
            1g.10gb: 7  # Maximum number of inference instances
      
      # Research environment - full GPU access
      research-profile:
        - devices: all
          mig-enabled: false
---
apiVersion: batch/v1
kind: Job
metadata:
  name: mig-config-dev
  namespace: gpu-operator
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: mig-config
          image: nvcr.io/nvidia/cloud-native/k8s-mig-manager:v0.6.0-ubuntu20.04
          command:
            - nvidia-mig-parted
            - apply
            - --mode-only
            - --config-file
            - /etc/mig/config.yaml
            - --selected-config
            - dev-profile
          volumeMounts:
            - name: mig-config
              mountPath: /etc/mig
          securityContext:
            privileged: true
          env:
            - name: NVIDIA_VISIBLE_DEVICES
              value: "all"
            - name: NVIDIA_DRIVER_CAPABILITIES
              value: "all"
      volumes:
        - name: mig-config
          configMap:
            name: mig-strategy-config
      nodeSelector:
        nvidia.com/gpu.product: "A100-SXM4-80GB"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
```

### GPU Time-Slicing Configuration

```yaml
# gpu-time-slicing.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gpu-sharing-config
  namespace: gpu-operator
data:
  config.yaml: |
    version: v1
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4  # Allow 4 workloads to share each GPU
          - name: nvidia.com/gpu-memory
            replicas: 1  # Memory is not shared
        failRequestsGreaterThanOne: false
        renameByDefault: false
    flags:
      migStrategy: "none"
      failOnInitError: true
      nvidiaDriverRoot: "/run/nvidia/driver"
      pluginType: "legacy"
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: nvidia-device-plugin-daemonset-shared
  namespace: gpu-operator
spec:
  selector:
    matchLabels:
      name: nvidia-device-plugin-ds-shared
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        name: nvidia-device-plugin-ds-shared
    spec:
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      priorityClassName: "system-node-critical"
      containers:
        - image: nvcr.io/nvidia/k8s-device-plugin:v0.14.3
          name: nvidia-device-plugin-ctr
          env:
            - name: FAIL_ON_INIT_ERROR
              value: "false"
            - name: MIG_STRATEGY
              value: "none"
            - name: NVIDIA_MIG_MONITOR_DEVICES
              value: "all"
            - name: GFD_SLEEP_INTERVAL
              value: "60s"
          args:
            - "--config-file=/etc/nvidia/sharing-config.yaml"
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: device-plugin
              mountPath: /var/lib/kubelet/device-plugins
            - name: sharing-config
              mountPath: /etc/nvidia
              readOnly: true
            - name: proc
              mountPath: /host/proc
              readOnly: true
      volumes:
        - name: device-plugin
          hostPath:
            path: /var/lib/kubelet/device-plugins
        - name: sharing-config
          configMap:
            name: gpu-sharing-config
        - name: proc
          hostPath:
            path: /proc
      nodeSelector:
        nvidia.com/gpu.present: "true"
```

## Section 3: Workload Scheduling and Optimization

### Advanced GPU Scheduling Policies

```yaml
# gpu-scheduling-policies.yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-high-priority
value: 1000
globalDefault: false
description: "High priority class for critical GPU workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-medium-priority
value: 500
globalDefault: false
description: "Medium priority class for standard GPU workloads"
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: gpu-low-priority
value: 100
globalDefault: false
description: "Low priority class for batch GPU workloads"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: scheduler-config
  namespace: kube-system
data:
  config.yaml: |
    apiVersion: kubescheduler.config.k8s.io/v1beta3
    kind: KubeSchedulerConfiguration
    profiles:
    - schedulerName: gpu-scheduler
      plugins:
        preFilter:
          enabled:
          - name: NodeResourcesFit
          - name: NodeAffinity
          - name: PodTopologySpread
        filter:
          enabled:
          - name: NodeResourcesFit
          - name: NodeAffinity
          - name: PodTopologySpread
          - name: TaintToleration
        score:
          enabled:
          - name: NodeResourcesFit
          - name: NodeAffinity
          - name: PodTopologySpread
          - name: TaintToleration
        bind:
          enabled:
          - name: DefaultBinder
      pluginConfig:
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: LeastAllocated
            resources:
            - name: nvidia.com/gpu
              weight: 100
            - name: cpu
              weight: 1
            - name: memory
              weight: 1
      - name: PodTopologySpread
        args:
          defaultConstraints:
          - maxSkew: 1
            topologyKey: kubernetes.io/hostname
            whenUnsatisfiable: DoNotSchedule
          - maxSkew: 1
            topologyKey: topology.kubernetes.io/zone
            whenUnsatisfiable: ScheduleAnyway
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gpu-scheduler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gpu-scheduler
  template:
    metadata:
      labels:
        app: gpu-scheduler
    spec:
      serviceAccountName: gpu-scheduler
      containers:
      - name: kube-scheduler
        image: k8s.gcr.io/kube-scheduler:v1.28.0
        command:
        - kube-scheduler
        - --config=/etc/kubernetes/scheduler-config.yaml
        - --v=2
        volumeMounts:
        - name: config
          mountPath: /etc/kubernetes
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: config
        configMap:
          name: scheduler-config
```

### GPU Workload Examples with Optimization

```yaml
# gpu-workload-examples.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: distributed-training-job
  namespace: ai-team-alpha
spec:
  parallelism: 4
  completions: 4
  backoffLimit: 3
  template:
    metadata:
      labels:
        app: distributed-training
        workload-type: training
    spec:
      priorityClassName: gpu-high-priority
      schedulerName: gpu-scheduler
      restartPolicy: Never
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - distributed-training
              topologyKey: kubernetes.io/hostname
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: nvidia.com/gpu.product
                operator: In
                values:
                - "A100-SXM4-80GB"
                - "V100-SXM2-32GB"
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      - key: ai-workload
        operator: Equal
        value: "true"
        effect: NoSchedule
      containers:
      - name: training-container
        image: nvcr.io/nvidia/pytorch:23.10-py3
        command:
        - python
        - -m
        - torch.distributed.launch
        - --nproc_per_node=1
        - --nnodes=4
        - --node_rank=$(POD_INDEX)
        - --master_addr=$(MASTER_ADDR)
        - --master_port=29500
        - /workspace/train_distributed.py
        env:
        - name: POD_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
        - name: MASTER_ADDR
          value: "distributed-training-master"
        - name: NCCL_DEBUG
          value: "INFO"
        - name: NCCL_SOCKET_IFNAME
          value: "eth0"
        resources:
          requests:
            nvidia.com/gpu: "1"
            cpu: "8"
            memory: "32Gi"
          limits:
            nvidia.com/gpu: "1"
            cpu: "16"
            memory: "64Gi"
        volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: datasets
          mountPath: /data
        - name: model-output
          mountPath: /output
        - name: shm
          mountPath: /dev/shm
      volumes:
      - name: workspace
        configMap:
          name: training-scripts
      - name: datasets
        persistentVolumeClaim:
          claimName: shared-datasets-pvc
      - name: model-output
        persistentVolumeClaim:
          claimName: model-output-pvc
      - name: shm
        emptyDir:
          medium: Memory
          sizeLimit: 8Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inference-service
  namespace: ai-team-beta
spec:
  replicas: 3
  selector:
    matchLabels:
      app: inference-service
  template:
    metadata:
      labels:
        app: inference-service
        workload-type: inference
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      priorityClassName: gpu-medium-priority
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - inference-service
              topologyKey: kubernetes.io/hostname
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: node-type
                operator: In
                values:
                - gpu-inference
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      containers:
      - name: inference-server
        image: nvcr.io/nvidia/tritonserver:23.10-py3
        command:
        - tritonserver
        - --model-repository=/models
        - --allow-http=true
        - --allow-grpc=true
        - --http-port=8000
        - --grpc-port=8001
        - --metrics-port=8002
        - --allow-metrics=true
        - --log-verbose=1
        env:
        - name: CUDA_VISIBLE_DEVICES
          value: "0"
        - name: NVIDIA_VISIBLE_DEVICES
          value: "0"
        ports:
        - containerPort: 8000
          name: http
        - containerPort: 8001
          name: grpc
        - containerPort: 8002
          name: metrics
        resources:
          requests:
            nvidia.com/gpu: "1"
            cpu: "4"
            memory: "16Gi"
          limits:
            nvidia.com/gpu: "1"
            cpu: "8"
            memory: "32Gi"
        livenessProbe:
          httpGet:
            path: /v2/health/live
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /v2/health/ready
            port: 8000
          initialDelaySeconds: 15
          periodSeconds: 5
        volumeMounts:
        - name: model-repository
          mountPath: /models
          readOnly: true
        - name: cache
          mountPath: /tmp/triton-cache
      volumes:
      - name: model-repository
        persistentVolumeClaim:
          claimName: model-repository-pvc
      - name: cache
        emptyDir:
          sizeLimit: 10Gi
```

## Section 4: Comprehensive GPU Monitoring and Alerting

### DCGM Exporter Configuration for Detailed Metrics

```yaml
# dcgm-monitoring-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcgm-exporter-config
  namespace: gpu-operator
data:
  dcp-metrics-included.csv: |
    # Format: metric name, unit, description
    DCGM_FI_DEV_SM_CLOCK,Hz,SM clock frequency (in Hz).
    DCGM_FI_DEV_MEM_CLOCK,Hz,Memory clock frequency (in Hz).
    DCGM_FI_DEV_MEMORY_TEMP,C,Memory temperature (in C).
    DCGM_FI_DEV_GPU_TEMP,C,GPU temperature (in C).
    DCGM_FI_DEV_POWER_USAGE,W,Power draw (in W).
    DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION,mJ,Total energy consumption since boot (in mJ).
    DCGM_FI_DEV_GPU_UTIL,percent,GPU utilization (in %).
    DCGM_FI_DEV_MEM_COPY_UTIL,percent,Memory utilization (in %).
    DCGM_FI_DEV_ENC_UTIL,percent,Encoder utilization (in %).
    DCGM_FI_DEV_DEC_UTIL,percent,Decoder utilization (in %).
    DCGM_FI_DEV_FB_FREE,bytes,Framebuffer memory free (in bytes).
    DCGM_FI_DEV_FB_USED,bytes,Framebuffer memory used (in bytes).
    DCGM_FI_DEV_FB_TOTAL,bytes,Total framebuffer memory (in bytes).
    DCGM_FI_DEV_PCIE_TX_THROUGHPUT,bytes/sec,PCIe TX throughput.
    DCGM_FI_DEV_PCIE_RX_THROUGHPUT,bytes/sec,PCIe RX throughput.
    DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL,bytes/sec,Total NVLink bandwidth.
    DCGM_FI_DEV_XID_ERRORS,count,Value of the last XID error encountered.
    DCGM_FI_DEV_POWER_VIOLATION,us,Throttling duration due to power constraints (in us).
    DCGM_FI_DEV_THERMAL_VIOLATION,us,Throttling duration due to thermal constraints (in us).
    DCGM_FI_DEV_SYNC_BOOST_VIOLATION,us,Throttling duration due to sync boost constraints (in us).
    DCGM_FI_DEV_BOARD_LIMIT_VIOLATION,us,Throttling duration due to board limit constraints (in us).
    DCGM_FI_DEV_LOW_UTIL_VIOLATION,us,Throttling duration due to low utilization (in us).
    DCGM_FI_DEV_RELIABILITY_VIOLATION,us,Throttling duration due to reliability constraints (in us).
    DCGM_FI_DEV_APP_SM_CLOCK,Hz,Application SM clock frequency.
    DCGM_FI_DEV_APP_MEM_CLOCK,Hz,Application memory clock frequency.
    DCGM_FI_DEV_RETIRED_SBE,count,Total retired single-bit ECC errors.
    DCGM_FI_DEV_RETIRED_DBE,count,Total retired double-bit ECC errors.
    DCGM_FI_DEV_PENDING_RETIRED_PAGES,count,Total pending retired pages.
    DCGM_FI_DEV_NVML_LIBRARY_VERSION,string,NVML library version.
    DCGM_FI_DEV_DRIVER_VERSION,string,Driver version.
    DCGM_FI_DEV_BRAND,string,Device brand.
    DCGM_FI_DEV_SERIAL,string,Device serial number.
    DCGM_FI_DEV_NAME,string,Device name.
    DCGM_FI_DEV_UUID,string,Device UUID.
    DCGM_FI_DEV_MINOR_NUMBER,int,Device minor number.
    DCGM_FI_DEV_OEM_INFOROM_VER,string,OEM inforom version.
    DCGM_FI_DEV_ECC_INFOROM_VER,string,ECC inforom version.
    DCGM_FI_DEV_POWER_INFOROM_VER,string,Power management object inforom version.
    DCGM_FI_DEV_VBIOS_VERSION,string,VBIOS version.
    DCGM_FI_DEV_BAR1_TOTAL,bytes,Total BAR1 memory.
    DCGM_FI_DEV_BAR1_USED,bytes,Used BAR1 memory.
    DCGM_FI_DEV_BAR1_FREE,bytes,Free BAR1 memory.
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: dcgm-exporter-enhanced
  namespace: gpu-operator
spec:
  selector:
    matchLabels:
      name: dcgm-exporter-enhanced
  template:
    metadata:
      labels:
        name: dcgm-exporter-enhanced
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9400"
        prometheus.io/path: "/metrics"
    spec:
      priorityClassName: system-node-critical
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      - key: CriticalAddonsOnly
        operator: Exists
      - key: node-role.kubernetes.io/master
        effect: NoSchedule
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      containers:
      - name: dcgm-exporter
        image: nvcr.io/nvidia/k8s/dcgm-exporter:3.2.6-3.2.0-ubuntu20.04
        ports:
        - containerPort: 9400
          name: metrics
        env:
        - name: DCGM_EXPORTER_LISTEN
          value: ":9400"
        - name: DCGM_EXPORTER_KUBERNETES
          value: "true"
        - name: DCGM_EXPORTER_COLLECTORS
          value: "/etc/dcgm-exporter/dcp-metrics-included.csv"
        - name: DCGM_EXPORTER_KUBERNETES_GPU_ID_TYPE
          value: "device-name"
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        volumeMounts:
        - name: dcgm-exporter-config
          mountPath: /etc/dcgm-exporter
          readOnly: true
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: sys
          mountPath: /host/sys
          readOnly: true
        securityContext:
          privileged: true
          runAsNonRoot: false
          runAsUser: 0
      volumes:
      - name: dcgm-exporter-config
        configMap:
          name: dcgm-exporter-config
      - name: proc
        hostPath:
          path: /proc
      - name: sys
        hostPath:
          path: /sys
      nodeSelector:
        nvidia.com/gpu.present: "true"
```

### Prometheus Rules for GPU Monitoring

```yaml
# gpu-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gpu-monitoring-rules
  namespace: gpu-operator
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
  - name: gpu.alerts
    interval: 30s
    rules:
    - alert: GPUHighTemperature
      expr: DCGM_FI_DEV_GPU_TEMP > 85
      for: 5m
      labels:
        severity: warning
        component: gpu
      annotations:
        summary: "GPU temperature is critically high"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} has temperature {{ $value }}°C"
    
    - alert: GPUMemoryHighUsage
      expr: (DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL) * 100 > 90
      for: 5m
      labels:
        severity: warning
        component: gpu
      annotations:
        summary: "GPU memory usage is high"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} has memory usage {{ $value }}%"
    
    - alert: GPULowUtilization
      expr: DCGM_FI_DEV_GPU_UTIL < 10
      for: 30m
      labels:
        severity: info
        component: gpu
      annotations:
        summary: "GPU utilization is consistently low"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} has utilization {{ $value }}% for 30+ minutes"
    
    - alert: GPUPowerThrottling
      expr: rate(DCGM_FI_DEV_POWER_VIOLATION[5m]) > 0
      for: 2m
      labels:
        severity: warning
        component: gpu
      annotations:
        summary: "GPU is being power throttled"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} is experiencing power throttling"
    
    - alert: GPUThermalThrottling
      expr: rate(DCGM_FI_DEV_THERMAL_VIOLATION[5m]) > 0
      for: 2m
      labels:
        severity: critical
        component: gpu
      annotations:
        summary: "GPU is being thermally throttled"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} is experiencing thermal throttling"
    
    - alert: GPUXIDErrors
      expr: increase(DCGM_FI_DEV_XID_ERRORS[5m]) > 0
      for: 1m
      labels:
        severity: critical
        component: gpu
      annotations:
        summary: "GPU XID errors detected"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} has XID errors: {{ $value }}"
    
    - alert: GPUECCErrors
      expr: increase(DCGM_FI_DEV_RETIRED_SBE[1h]) > 10 or increase(DCGM_FI_DEV_RETIRED_DBE[1h]) > 0
      for: 1m
      labels:
        severity: critical
        component: gpu
      annotations:
        summary: "GPU ECC errors detected"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} has ECC errors"
    
    - alert: GPUDriverNotResponding
      expr: up{job="dcgm-exporter"} == 0
      for: 2m
      labels:
        severity: critical
        component: gpu
      annotations:
        summary: "GPU driver not responding"
        description: "DCGM exporter on node {{ $labels.kubernetes_node }} is not responding"
    
    - alert: GPUWorkloadStuck
      expr: |
        (
          DCGM_FI_DEV_GPU_UTIL > 95
          and
          rate(DCGM_FI_DEV_FB_USED[5m]) == 0
        )
      for: 10m
      labels:
        severity: warning
        component: gpu
      annotations:
        summary: "GPU workload appears stuck"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} shows high utilization but no memory changes"
    
    - alert: GPUClockSpeedLow
      expr: DCGM_FI_DEV_SM_CLOCK < 1000000000  # Less than 1GHz
      for: 5m
      labels:
        severity: info
        component: gpu
      annotations:
        summary: "GPU clock speed is unusually low"
        description: "GPU {{ $labels.gpu }} on node {{ $labels.kubernetes_node }} has SM clock {{ $value }}Hz"

  - name: gpu.workloads
    interval: 30s
    rules:
    - alert: GPUJobPendingTooLong
      expr: |
        kube_job_status_active{job_name=~".*gpu.*"} == 0
        and
        kube_job_status_succeeded{job_name=~".*gpu.*"} == 0
        and
        kube_job_status_failed{job_name=~".*gpu.*"} == 0
        and
        time() - kube_job_created{job_name=~".*gpu.*"} > 3600
      for: 5m
      labels:
        severity: warning
        component: scheduling
      annotations:
        summary: "GPU job pending for too long"
        description: "GPU job {{ $labels.job_name }} in namespace {{ $labels.namespace }} has been pending for over 1 hour"
    
    - alert: GPUPodSchedulingFailed
      expr: |
        kube_pod_status_phase{phase="Pending"}
        and on(pod, namespace) 
        kube_pod_container_resource_requests{resource="nvidia_com_gpu"} > 0
      for: 15m
      labels:
        severity: warning
        component: scheduling
      annotations:
        summary: "GPU pod scheduling failed"
        description: "Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} requiring GPU has been pending for 15+ minutes"

  - name: gpu.capacity
    interval: 60s
    rules:
    - alert: GPUClusterCapacityLow
      expr: |
        (
          sum(kube_node_status_allocatable{resource="nvidia_com_gpu"})
          -
          sum(kube_pod_container_resource_requests{resource="nvidia_com_gpu"})
        ) / sum(kube_node_status_allocatable{resource="nvidia_com_gpu"}) * 100 < 20
      for: 5m
      labels:
        severity: warning
        component: capacity
      annotations:
        summary: "GPU cluster capacity is low"
        description: "Only {{ $value }}% of GPU capacity is available"
    
    - alert: GPUNodeNotReady
      expr: kube_node_status_condition{condition="Ready",status="false"} and on(node) kube_node_status_allocatable{resource="nvidia_com_gpu"} > 0
      for: 2m
      labels:
        severity: critical
        component: node
      annotations:
        summary: "GPU node is not ready"
        description: "GPU node {{ $labels.node }} is not ready"
```

## Section 5: Performance Optimization and Troubleshooting

### GPU Performance Optimization Scripts

```python
# gpu_performance_optimizer.py
import subprocess
import json
import logging
import time
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from kubernetes import client, config
import numpy as np
import pandas as pd

@dataclass
class GPUMetrics:
    """GPU metrics data structure."""
    gpu_id: str
    utilization: float
    memory_used: int
    memory_total: int
    temperature: float
    power_usage: float
    sm_clock: int
    memory_clock: int
    node_name: str
    pod_name: Optional[str] = None

class GPUPerformanceOptimizer:
    """Advanced GPU performance optimization and troubleshooting."""
    
    def __init__(self):
        try:
            config.load_incluster_config()
        except:
            config.load_kube_config()
        
        self.v1 = client.CoreV1Api()
        self.custom_api = client.CustomObjectsApi()
        self.logger = logging.getLogger(__name__)
        logging.basicConfig(level=logging.INFO)
        
    def get_gpu_metrics(self) -> List[GPUMetrics]:
        """Collect comprehensive GPU metrics from all nodes."""
        metrics = []
        
        try:
            # Get GPU metrics from DCGM
            dcgm_metrics = self._query_dcgm_metrics()
            
            # Get pod information
            pods = self.v1.list_pod_for_all_namespaces()
            gpu_pods = {}
            
            for pod in pods.items:
                if pod.spec.containers:
                    for container in pod.spec.containers:
                        if container.resources and container.resources.requests:
                            if 'nvidia.com/gpu' in container.resources.requests:
                                node_name = pod.spec.node_name
                                if node_name not in gpu_pods:
                                    gpu_pods[node_name] = []
                                gpu_pods[node_name].append(pod.metadata.name)
            
            # Combine metrics with pod information
            for metric in dcgm_metrics:
                if metric['node_name'] in gpu_pods:
                    metric['pod_names'] = gpu_pods[metric['node_name']]
                
                metrics.append(GPUMetrics(
                    gpu_id=metric['gpu_id'],
                    utilization=metric['utilization'],
                    memory_used=metric['memory_used'],
                    memory_total=metric['memory_total'],
                    temperature=metric['temperature'],
                    power_usage=metric['power_usage'],
                    sm_clock=metric['sm_clock'],
                    memory_clock=metric['memory_clock'],
                    node_name=metric['node_name'],
                    pod_name=metric.get('pod_names', [None])[0]
                ))
                
        except Exception as e:
            self.logger.error(f"Error collecting GPU metrics: {e}")
            
        return metrics
    
    def _query_dcgm_metrics(self) -> List[Dict]:
        """Query DCGM metrics via Prometheus."""
        import requests
        
        prometheus_url = "http://prometheus.gpu-operator.svc.cluster.local:9090"
        metrics_queries = {
            'utilization': 'DCGM_FI_DEV_GPU_UTIL',
            'memory_used': 'DCGM_FI_DEV_FB_USED',
            'memory_total': 'DCGM_FI_DEV_FB_TOTAL',
            'temperature': 'DCGM_FI_DEV_GPU_TEMP',
            'power_usage': 'DCGM_FI_DEV_POWER_USAGE',
            'sm_clock': 'DCGM_FI_DEV_SM_CLOCK',
            'memory_clock': 'DCGM_FI_DEV_MEM_CLOCK'
        }
        
        combined_metrics = {}
        
        for metric_name, query in metrics_queries.items():
            try:
                response = requests.get(f"{prometheus_url}/api/v1/query", 
                                      params={'query': query})
                data = response.json()
                
                if data['status'] == 'success':
                    for result in data['data']['result']:
                        gpu_info = result['metric']
                        gpu_key = f"{gpu_info['kubernetes_node']}_{gpu_info['gpu']}"
                        
                        if gpu_key not in combined_metrics:
                            combined_metrics[gpu_key] = {
                                'gpu_id': gpu_info['gpu'],
                                'node_name': gpu_info['kubernetes_node']
                            }
                        
                        combined_metrics[gpu_key][metric_name] = float(result['value'][1])
                        
            except Exception as e:
                self.logger.warning(f"Error querying {metric_name}: {e}")
        
        return list(combined_metrics.values())
    
    def analyze_performance_issues(self, metrics: List[GPUMetrics]) -> Dict[str, List[str]]:
        """Analyze GPU metrics to identify performance issues."""
        issues = {
            'thermal_throttling': [],
            'low_utilization': [],
            'memory_pressure': [],
            'clock_throttling': [],
            'power_throttling': [],
            'optimization_opportunities': []
        }
        
        for metric in metrics:
            gpu_id = f"{metric.node_name}:{metric.gpu_id}"
            
            # Thermal issues
            if metric.temperature > 83:
                issues['thermal_throttling'].append(
                    f"GPU {gpu_id} temperature: {metric.temperature}°C (>83°C threshold)"
                )
            
            # Low utilization
            if metric.utilization < 20:
                issues['low_utilization'].append(
                    f"GPU {gpu_id} utilization: {metric.utilization}% (<20% threshold)"
                )
            
            # Memory pressure
            memory_usage_pct = (metric.memory_used / metric.memory_total) * 100
            if memory_usage_pct > 95:
                issues['memory_pressure'].append(
                    f"GPU {gpu_id} memory usage: {memory_usage_pct:.1f}% (>95% threshold)"
                )
            
            # Clock speed analysis
            if metric.sm_clock < 1000:  # Less than 1GHz
                issues['clock_throttling'].append(
                    f"GPU {gpu_id} SM clock: {metric.sm_clock}MHz (potentially throttled)"
                )
            
            # Power analysis
            if metric.power_usage > 400:  # High power usage
                issues['power_throttling'].append(
                    f"GPU {gpu_id} power usage: {metric.power_usage}W (high power draw)"
                )
            
            # Optimization opportunities
            if 20 <= metric.utilization <= 70 and memory_usage_pct < 50:
                issues['optimization_opportunities'].append(
                    f"GPU {gpu_id} could benefit from workload consolidation "
                    f"(util: {metric.utilization}%, mem: {memory_usage_pct:.1f}%)"
                )
        
        return issues
    
    def generate_optimization_recommendations(self, metrics: List[GPUMetrics]) -> List[Dict]:
        """Generate specific optimization recommendations."""
        recommendations = []
        
        # Group metrics by node
        nodes_metrics = {}
        for metric in metrics:
            if metric.node_name not in nodes_metrics:
                nodes_metrics[metric.node_name] = []
            nodes_metrics[metric.node_name].append(metric)
        
        for node_name, node_metrics in nodes_metrics.items():
            avg_utilization = np.mean([m.utilization for m in node_metrics])
            avg_memory_usage = np.mean([(m.memory_used / m.memory_total) * 100 
                                      for m in node_metrics])
            
            # Node-level recommendations
            if avg_utilization < 30:
                recommendations.append({
                    'type': 'workload_consolidation',
                    'priority': 'medium',
                    'target': node_name,
                    'description': f'Node has low GPU utilization ({avg_utilization:.1f}%)',
                    'action': 'Consider consolidating workloads or using time-slicing',
                    'commands': [
                        f'kubectl label nodes {node_name} gpu-sharing=enabled',
                        'kubectl apply -f gpu-time-slicing-config.yaml'
                    ]
                })
            
            if avg_memory_usage < 40 and avg_utilization > 70:
                recommendations.append({
                    'type': 'memory_optimization',
                    'priority': 'low',
                    'target': node_name,
                    'description': f'High utilization but low memory usage ({avg_memory_usage:.1f}%)',
                    'action': 'Consider enabling MIG for better resource utilization',
                    'commands': [
                        f'kubectl label nodes {node_name} nvidia.com/mig.config=all-1g.10gb',
                        'kubectl rollout restart daemonset/nvidia-device-plugin-daemonset -n gpu-operator'
                    ]
                })
            
            # Per-GPU recommendations
            for metric in node_metrics:
                if metric.temperature > 80:
                    recommendations.append({
                        'type': 'thermal_management',
                        'priority': 'high',
                        'target': f'{node_name}:GPU{metric.gpu_id}',
                        'description': f'GPU temperature is high ({metric.temperature}°C)',
                        'action': 'Check cooling system and reduce workload',
                        'commands': [
                            f'nvidia-smi -i {metric.gpu_id} -pl 300',  # Reduce power limit
                            f'kubectl cordon {node_name}',  # Prevent new pods
                        ]
                    })
                
                memory_usage_pct = (metric.memory_used / metric.memory_total) * 100
                if memory_usage_pct > 90:
                    recommendations.append({
                        'type': 'memory_management',
                        'priority': 'medium',
                        'target': f'{node_name}:GPU{metric.gpu_id}',
                        'description': f'GPU memory usage is very high ({memory_usage_pct:.1f}%)',
                        'action': 'Review pod memory requests and consider batch size tuning',
                        'commands': [
                            f'kubectl top pods --containers -A | grep {node_name}',
                            'kubectl describe pod <pod-name> -n <namespace>'
                        ]
                    })
        
        return recommendations
    
    def auto_remediate_issues(self, issues: Dict[str, List[str]], 
                            dry_run: bool = True) -> List[str]:
        """Automatically remediate common GPU issues."""
        actions_taken = []
        
        if not dry_run:
            self.logger.warning("Auto-remediation is enabled! This will modify cluster state.")
        
        # Handle thermal throttling
        for issue in issues.get('thermal_throttling', []):
            node_name = issue.split()[1].split(':')[0]
            gpu_id = issue.split()[1].split(':')[1]
            
            action = f"Reduce power limit for {node_name}:GPU{gpu_id}"
            if not dry_run:
                try:
                    # Execute nvidia-smi command on the node
                    self._execute_on_node(node_name, 
                                        f"nvidia-smi -i {gpu_id} -pl 300")
                    actions_taken.append(f"✓ {action}")
                except Exception as e:
                    actions_taken.append(f"✗ {action}: {e}")
            else:
                actions_taken.append(f"[DRY RUN] {action}")
        
        # Handle low utilization by enabling time-slicing
        low_util_nodes = set()
        for issue in issues.get('low_utilization', []):
            node_name = issue.split()[1].split(':')[0]
            low_util_nodes.add(node_name)
        
        for node_name in low_util_nodes:
            action = f"Enable GPU time-slicing on {node_name}"
            if not dry_run:
                try:
                    # Label node for time-slicing
                    body = {"metadata": {"labels": {"gpu-sharing": "enabled"}}}
                    self.v1.patch_node(node_name, body)
                    actions_taken.append(f"✓ {action}")
                except Exception as e:
                    actions_taken.append(f"✗ {action}: {e}")
            else:
                actions_taken.append(f"[DRY RUN] {action}")
        
        return actions_taken
    
    def _execute_on_node(self, node_name: str, command: str):
        """Execute command on a specific node using a privileged pod."""
        pod_manifest = {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": f"gpu-debug-{int(time.time())}",
                "namespace": "gpu-operator"
            },
            "spec": {
                "nodeName": node_name,
                "hostPID": True,
                "hostNetwork": True,
                "containers": [{
                    "name": "debug",
                    "image": "nvidia/cuda:12.3.1-base-ubuntu20.04",
                    "command": ["nsenter", "--target", "1", "--mount", "--uts", 
                              "--ipc", "--net", "--pid", "--", "sh", "-c", command],
                    "securityContext": {
                        "privileged": True
                    },
                    "volumeMounts": [{
                        "name": "host",
                        "mountPath": "/host"
                    }]
                }],
                "volumes": [{
                    "name": "host",
                    "hostPath": {"path": "/"}
                }],
                "restartPolicy": "Never",
                "tolerations": [{
                    "operator": "Exists"
                }]
            }
        }
        
        # Create pod
        pod = self.v1.create_namespaced_pod(
            namespace="gpu-operator",
            body=pod_manifest
        )
        
        # Wait for completion
        pod_name = pod.metadata.name
        timeout = 60
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            pod_status = self.v1.read_namespaced_pod_status(
                name=pod_name,
                namespace="gpu-operator"
            )
            
            if pod_status.status.phase in ["Succeeded", "Failed"]:
                break
            
            time.sleep(2)
        
        # Clean up
        try:
            self.v1.delete_namespaced_pod(
                name=pod_name,
                namespace="gpu-operator"
            )
        except:
            pass
    
    def generate_performance_report(self) -> Dict:
        """Generate comprehensive GPU performance report."""
        metrics = self.get_gpu_metrics()
        issues = self.analyze_performance_issues(metrics)
        recommendations = self.generate_optimization_recommendations(metrics)
        
        # Calculate cluster-wide statistics
        total_gpus = len(metrics)
        avg_utilization = np.mean([m.utilization for m in metrics]) if metrics else 0
        avg_temperature = np.mean([m.temperature for m in metrics]) if metrics else 0
        total_memory_used = sum(m.memory_used for m in metrics)
        total_memory_available = sum(m.memory_total for m in metrics)
        
        report = {
            'timestamp': time.time(),
            'cluster_summary': {
                'total_gpus': total_gpus,
                'average_utilization': avg_utilization,
                'average_temperature': avg_temperature,
                'memory_usage_gb': total_memory_used / (1024**3),
                'memory_total_gb': total_memory_available / (1024**3),
                'memory_utilization_pct': (total_memory_used / total_memory_available * 100) if total_memory_available > 0 else 0
            },
            'issues_detected': issues,
            'recommendations': recommendations,
            'gpu_details': [
                {
                    'gpu_id': m.gpu_id,
                    'node': m.node_name,
                    'utilization': m.utilization,
                    'memory_usage_pct': (m.memory_used / m.memory_total * 100),
                    'temperature': m.temperature,
                    'power_usage': m.power_usage,
                    'pod_name': m.pod_name
                }
                for m in metrics
            ]
        }
        
        return report

# CLI interface
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='GPU Performance Optimizer')
    parser.add_argument('--action', choices=['report', 'analyze', 'remediate'],
                       default='report', help='Action to perform')
    parser.add_argument('--dry-run', action='store_true',
                       help='Perform dry run for remediation')
    parser.add_argument('--output', choices=['json', 'yaml', 'text'],
                       default='text', help='Output format')
    
    args = parser.parse_args()
    
    optimizer = GPUPerformanceOptimizer()
    
    if args.action == 'report':
        report = optimizer.generate_performance_report()
        
        if args.output == 'json':
            print(json.dumps(report, indent=2))
        elif args.output == 'yaml':
            import yaml
            print(yaml.dump(report, default_flow_style=False))
        else:
            # Text output
            print("=== GPU Cluster Performance Report ===")
            print(f"Total GPUs: {report['cluster_summary']['total_gpus']}")
            print(f"Average Utilization: {report['cluster_summary']['average_utilization']:.1f}%")
            print(f"Average Temperature: {report['cluster_summary']['average_temperature']:.1f}°C")
            print(f"Memory Usage: {report['cluster_summary']['memory_utilization_pct']:.1f}%")
            
            print("\n=== Issues Detected ===")
            for issue_type, issues in report['issues_detected'].items():
                if issues:
                    print(f"\n{issue_type.replace('_', ' ').title()}:")
                    for issue in issues:
                        print(f"  - {issue}")
            
            print("\n=== Recommendations ===")
            for rec in report['recommendations']:
                print(f"\n{rec['type']} ({rec['priority']} priority):")
                print(f"  Target: {rec['target']}")
                print(f"  Description: {rec['description']}")
                print(f"  Action: {rec['action']}")
    
    elif args.action == 'analyze':
        metrics = optimizer.get_gpu_metrics()
        issues = optimizer.analyze_performance_issues(metrics)
        
        print("=== Performance Analysis ===")
        for issue_type, issues_list in issues.items():
            if issues_list:
                print(f"\n{issue_type.replace('_', ' ').title()}:")
                for issue in issues_list:
                    print(f"  - {issue}")
    
    elif args.action == 'remediate':
        metrics = optimizer.get_gpu_metrics()
        issues = optimizer.analyze_performance_issues(metrics)
        actions = optimizer.auto_remediate_issues(issues, dry_run=args.dry_run)
        
        print("=== Auto-Remediation Results ===")
        for action in actions:
            print(action)
```

## Section 6: Advanced Troubleshooting and Maintenance

### GPU Health Monitoring and Diagnostics

```bash
#!/bin/bash
# gpu-health-check.sh

set -euo pipefail

NAMESPACE="gpu-operator"
LOG_LEVEL="INFO"
OUTPUT_DIR="/tmp/gpu-diagnostics"

# Create output directory
mkdir -p ${OUTPUT_DIR}

echo "Starting comprehensive GPU health check..."

# Function to log with timestamp
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Check GPU Operator components
check_gpu_operator() {
    log "Checking GPU Operator components..."
    
    kubectl get pods -n ${NAMESPACE} -o wide > ${OUTPUT_DIR}/gpu-operator-pods.txt
    kubectl describe pods -n ${NAMESPACE} > ${OUTPUT_DIR}/gpu-operator-pods-detailed.txt
    
    # Check specific components
    for component in "nvidia-operator-validator" "nvidia-device-plugin-daemonset" "nvidia-dcgm-exporter" "gpu-feature-discovery"; do
        log "Checking ${component}..."
        kubectl logs -n ${NAMESPACE} -l app=${component} --tail=100 > ${OUTPUT_DIR}/${component}-logs.txt 2>/dev/null || true
    done
}

# Check GPU nodes and resources
check_gpu_nodes() {
    log "Checking GPU nodes and resources..."
    
    # Get all GPU nodes
    kubectl get nodes -l nvidia.com/gpu.present=true -o wide > ${OUTPUT_DIR}/gpu-nodes.txt
    
    # Check node capacity and allocatable resources
    kubectl get nodes -o json | jq -r '
        .items[] | 
        select(.status.capacity."nvidia.com/gpu" != null) | 
        {
            name: .metadata.name,
            capacity: .status.capacity."nvidia.com/gpu",
            allocatable: .status.allocatable."nvidia.com/gpu",
            conditions: [.status.conditions[] | select(.type == "Ready" or .type == "MemoryPressure" or .type == "DiskPressure")]
        }
    ' > ${OUTPUT_DIR}/gpu-node-resources.json
    
    # Check node labels
    kubectl get nodes -l nvidia.com/gpu.present=true -o json | jq -r '
        .items[] | 
        {
            name: .metadata.name,
            labels: .metadata.labels
        }
    ' > ${OUTPUT_DIR}/gpu-node-labels.json
}

# Check GPU workloads
check_gpu_workloads() {
    log "Checking GPU workloads..."
    
    # Get all pods requesting GPUs
    kubectl get pods --all-namespaces -o json | jq -r '
        .items[] | 
        select(.spec.containers[]?.resources.requests."nvidia.com/gpu" != null) |
        {
            namespace: .metadata.namespace,
            name: .metadata.name,
            node: .spec.nodeName,
            phase: .status.phase,
            gpu_requests: [.spec.containers[].resources.requests."nvidia.com/gpu" // "0"] | add
        }
    ' > ${OUTPUT_DIR}/gpu-workloads.json
    
    # Check pending GPU pods
    kubectl get pods --all-namespaces --field-selector=status.phase=Pending -o json | jq -r '
        .items[] | 
        select(.spec.containers[]?.resources.requests."nvidia.com/gpu" != null) |
        {
            namespace: .metadata.namespace,
            name: .metadata.name,
            reason: .status.conditions[]?.reason,
            message: .status.conditions[]?.message
        }
    ' > ${OUTPUT_DIR}/pending-gpu-workloads.json
}

# Run GPU diagnostics on nodes
run_gpu_diagnostics() {
    log "Running GPU diagnostics on nodes..."
    
    # Get GPU nodes
    gpu_nodes=$(kubectl get nodes -l nvidia.com/gpu.present=true -o jsonpath='{.items[*].metadata.name}')
    
    for node in ${gpu_nodes}; do
        log "Running diagnostics on node: ${node}"
        
        # Create diagnostic pod
        cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu-diagnostic-${node}
  namespace: ${NAMESPACE}
spec:
  nodeName: ${node}
  hostPID: true
  hostNetwork: true
  restartPolicy: Never
  tolerations:
  - operator: Exists
  containers:
  - name: diagnostics
    image: nvidia/cuda:12.3.1-base-ubuntu20.04
    command:
    - /bin/bash
    - -c
    - |
      echo "=== GPU Diagnostic Report for ${node} ===" > /tmp/diagnostic-${node}.txt
      echo "Date: \$(date)" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== NVIDIA Driver Version ===" >> /tmp/diagnostic-${node}.txt
      nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to query driver" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== GPU Information ===" >> /tmp/diagnostic-${node}.txt
      nvidia-smi -L >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to list GPUs" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== GPU Status ===" >> /tmp/diagnostic-${node}.txt
      nvidia-smi >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to get GPU status" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== GPU Processes ===" >> /tmp/diagnostic-${node}.txt
      nvidia-smi pmon -c 1 >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to get GPU processes" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== GPU Memory Info ===" >> /tmp/diagnostic-${node}.txt
      nvidia-smi --query-gpu=memory.total,memory.used,memory.free --format=csv >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to get memory info" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== GPU Temperature and Power ===" >> /tmp/diagnostic-${node}.txt
      nvidia-smi --query-gpu=temperature.gpu,power.draw,power.limit --format=csv >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to get temperature/power info" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== CUDA Runtime Info ===" >> /tmp/diagnostic-${node}.txt
      nvcc --version >> /tmp/diagnostic-${node}.txt 2>&1 || echo "NVCC not available" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== Container Runtime Info ===" >> /tmp/diagnostic-${node}.txt
      nsenter --target 1 --mount --uts --ipc --net --pid -- crictl info >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to get container runtime info" >> /tmp/diagnostic-${node}.txt
      echo "" >> /tmp/diagnostic-${node}.txt
      
      echo "=== NVIDIA Container Runtime Config ===" >> /tmp/diagnostic-${node}.txt
      nsenter --target 1 --mount --uts --ipc --net --pid -- cat /etc/containerd/config.toml | grep -A 10 -B 5 nvidia >> /tmp/diagnostic-${node}.txt 2>&1 || echo "Failed to get containerd config" >> /tmp/diagnostic-${node}.txt
      
      # Keep container running for log collection
      sleep 60
    securityContext:
      privileged: true
    volumeMounts:
    - name: host
      mountPath: /host
  volumes:
  - name: host
    hostPath:
      path: /
EOF
        
        # Wait for pod to complete diagnostics
        sleep 70
        
        # Collect logs
        kubectl logs gpu-diagnostic-${node} -n ${NAMESPACE} > ${OUTPUT_DIR}/gpu-diagnostic-${node}.txt 2>/dev/null || true
        
        # Clean up diagnostic pod
        kubectl delete pod gpu-diagnostic-${node} -n ${NAMESPACE} --ignore-not-found=true
    done
}

# Check GPU metrics
check_gpu_metrics() {
    log "Checking GPU metrics..."
    
    # Check if DCGM exporter is available
    if kubectl get pods -n ${NAMESPACE} -l app=nvidia-dcgm-exporter | grep -q Running; then
        log "DCGM exporter is running, collecting metrics..."
        
        # Try to get metrics from Prometheus if available
        if kubectl get svc -n monitoring prometheus 2>/dev/null; then
            log "Querying GPU metrics from Prometheus..."
            
            # Port forward to Prometheus (in background)
            kubectl port-forward -n monitoring svc/prometheus 9090:9090 &
            PF_PID=$!
            sleep 5
            
            # Query key GPU metrics
            metrics=(
                "DCGM_FI_DEV_GPU_UTIL"
                "DCGM_FI_DEV_GPU_TEMP"
                "DCGM_FI_DEV_POWER_USAGE"
                "DCGM_FI_DEV_FB_USED"
                "DCGM_FI_DEV_FB_TOTAL"
            )
            
            for metric in "${metrics[@]}"; do
                curl -s "http://localhost:9090/api/v1/query?query=${metric}" | jq '.' > ${OUTPUT_DIR}/${metric,,}.json 2>/dev/null || true
            done
            
            # Kill port forward
            kill $PF_PID 2>/dev/null || true
        fi
    else
        log "DCGM exporter not found or not running"
    fi
}

# Generate summary report
generate_summary() {
    log "Generating summary report..."
    
    cat <<EOF > ${OUTPUT_DIR}/summary.txt
GPU Cluster Health Check Summary
================================
Date: $(date)
Cluster: $(kubectl config current-context)

GPU Operator Status:
$(kubectl get pods -n ${NAMESPACE} --no-headers | awk '{print $1 ": " $3}')

GPU Nodes:
$(kubectl get nodes -l nvidia.com/gpu.present=true --no-headers | awk '{print $1 ": " $2}')

GPU Workloads:
Total GPU Pods: $(kubectl get pods --all-namespaces -o json | jq '[.items[] | select(.spec.containers[]?.resources.requests."nvidia.com/gpu" != null)] | length')
Pending GPU Pods: $(kubectl get pods --all-namespaces --field-selector=status.phase=Pending -o json | jq '[.items[] | select(.spec.containers[]?.resources.requests."nvidia.com/gpu" != null)] | length')

Issues Found:
$(if [ -s ${OUTPUT_DIR}/pending-gpu-workloads.json ] && [ "$(cat ${OUTPUT_DIR}/pending-gpu-workloads.json)" != "null" ]; then echo "- Pending GPU workloads detected"; fi)
$(if ! kubectl get pods -n ${NAMESPACE} | grep -q "Running"; then echo "- GPU Operator components not all running"; fi)

Diagnostics completed. Check ${OUTPUT_DIR}/ for detailed reports.
EOF

    cat ${OUTPUT_DIR}/summary.txt
}

# Main execution
main() {
    log "Starting GPU health check..."
    
    check_gpu_operator
    check_gpu_nodes
    check_gpu_workloads
    run_gpu_diagnostics
    check_gpu_metrics
    generate_summary
    
    log "GPU health check completed. Results saved to: ${OUTPUT_DIR}"
}

# Run with error handling
if ! main; then
    log "ERROR: GPU health check failed"
    exit 1
fi
```

This comprehensive guide provides a production-ready approach to managing GPU clusters for AI workloads using the NVIDIA GPU Operator. The implementation covers advanced multi-tenancy, sophisticated monitoring and alerting, performance optimization, and automated troubleshooting capabilities essential for running GPU workloads at scale in enterprise environments.

The examples include practical configurations for different GPU sharing strategies (MIG, time-slicing), comprehensive monitoring with DCGM, and automated performance optimization tools that help maximize GPU utilization while maintaining stability and reliability.