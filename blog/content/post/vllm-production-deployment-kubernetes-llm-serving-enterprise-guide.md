---
title: "vLLM Production Deployment on Kubernetes: Serving Large Language Models at Scale"
date: 2026-12-17T00:00:00-05:00
draft: false
tags: ["vLLM", "Kubernetes", "LLM", "GPU", "NVIDIA", "Machine Learning", "MLOps", "AI Infrastructure", "Inference", "Production"]
categories:
- AI Infrastructure
- MLOps
- Kubernetes
- GPU Computing
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to deploying vLLM on Kubernetes for production LLM inference: GPU operator configuration, tensor parallelism, multi-model serving, autoscaling with KEDA, and SLO-aligned observability."
more_link: "yes"
url: "/vllm-production-deployment-kubernetes-llm-serving-enterprise-guide/"
---

Running large language models in production requires more than a working model checkpoint. Latency SLOs, GPU memory constraints, multi-tenant isolation, autoscaling, and operational observability all demand careful infrastructure design. **vLLM** has emerged as the de-facto high-throughput inference engine for transformer models, pairing PagedAttention for efficient KV-cache management with an OpenAI-compatible API that slots neatly into existing tooling. This guide covers the full lifecycle of deploying vLLM on Kubernetes — from GPU operator installation through tensor-parallel multi-GPU serving, KEDA-driven autoscaling, and production-grade monitoring.

<!--more-->

## Prerequisites and Architecture Overview

### Cluster Requirements

A production vLLM cluster requires GPU-accelerated nodes, a container runtime configured for CUDA, and a storage layer capable of hosting multi-gigabyte model weight files accessible by multiple pods simultaneously.

The baseline hardware assumptions for this guide:

| Component | Minimum | Recommended |
|---|---|---|
| GPU nodes | 2× A10G (24 GB each) | 4× A100-80GB SXM4 |
| CPU per node | 16 vCPU | 48 vCPU |
| RAM per node | 64 GB | 256 GB |
| Shared storage | 500 GB NFS / EFS | 2 TB NFS with 10 Gbps |
| Kubernetes version | 1.28 | 1.30+ |
| Container runtime | containerd 1.7+ | containerd 1.7+ |

### Architecture Diagram

The deployment architecture separates concerns into three layers:

1. **Gateway layer** — NGINX Ingress routes requests to model-specific backends, enforces TLS termination, and provides sticky sessions for streaming responses.
2. **Serving layer** — vLLM pods, each running an OpenAI-compatible HTTP server backed by one or more GPUs. Horizontal scaling is managed by KEDA reacting to Prometheus metrics.
3. **Storage layer** — A ReadWriteMany PVC holds pre-downloaded model weights shared across all replicas, eliminating per-pod download latency on scale-out.

### Namespace and Quota Setup

Isolate LLM serving workloads in a dedicated namespace with explicit GPU quotas. This prevents runaway allocations from starving other workloads and gives operators a clear audit surface.

```yaml
# vllm-namespace.yaml — Dedicated namespace with resource quotas for LLM serving
apiVersion: v1
kind: Namespace
metadata:
  name: llm-serving
  labels:
    app.kubernetes.io/managed-by: helm
    environment: production
---
# ResourceQuota to prevent runaway GPU allocation
apiVersion: v1
kind: ResourceQuota
metadata:
  name: llm-serving-quota
  namespace: llm-serving
spec:
  hard:
    requests.nvidia.com/gpu: "16"
    limits.nvidia.com/gpu: "16"
    requests.memory: "512Gi"
    limits.memory: "512Gi"
    pods: "50"
---
# LimitRange establishes per-container defaults so pods without explicit
# resource requests still get sensible defaults
apiVersion: v1
kind: LimitRange
metadata:
  name: llm-serving-limits
  namespace: llm-serving
spec:
  limits:
  - type: Container
    default:
      memory: "8Gi"
      cpu: "4"
    defaultRequest:
      memory: "4Gi"
      cpu: "2"
    max:
      nvidia.com/gpu: "8"
```

## GPU Operator Installation and Configuration

### Installing the NVIDIA GPU Operator

The NVIDIA GPU Operator automates driver installation, device plugin deployment, and monitoring setup across all GPU nodes. Without it, operators must manually configure each node — an error-prone process that breaks during node replacements and OS upgrades.

```yaml
# gpu-operator-values.yaml — Helm values for NVIDIA GPU Operator
# Install: helm install gpu-operator nvidia/gpu-operator -n gpu-operator --create-namespace -f gpu-operator-values.yaml
operator:
  defaultRuntime: containerd

driver:
  enabled: true
  version: "550.90.07"  # Pin driver version for reproducibility
  upgradePolicy:
    autoUpgrade: true
    maxParallelUpgrades: 1   # Upgrade nodes one at a time to preserve capacity
    waitForCompletion:
      timeoutSeconds: 300

toolkit:
  enabled: true
  version: "1.15.0"

devicePlugin:
  enabled: true
  version: "0.14.5"
  config:
    # Enable MIG strategy for A100/H100 clusters
    name: time-slicing-config
    default: "any"

migManager:
  enabled: true

gfd:
  enabled: true  # GPU Feature Discovery — labels nodes with GPU capabilities

dcgmExporter:
  enabled: true  # Prometheus metrics for GPU utilization, memory, temperature
  serviceMonitor:
    enabled: true
    interval: "15s"

nodeStatusExporter:
  enabled: true

validator:
  plugin:
    env:
    - name: WITH_WORKLOAD
      value: "true"

# Node feature discovery integration
nfd:
  enabled: true
```

### GPU Time-Slicing for Development Environments

In development clusters or when running smaller models, **time-slicing** lets multiple containers share a single physical GPU. This is not appropriate for latency-sensitive production workloads — time-slicing causes GPU context switching overhead — but dramatically reduces hardware costs during model development and testing.

```yaml
# time-slicing-config.yaml — Allow multiple vLLM replicas to share a single GPU
# during development or for smaller models
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
          replicas: 4    # Each physical GPU appears as 4 logical GPUs
```

Apply the ConfigMap and patch the `ClusterPolicy` to activate time-slicing:

```bash
kubectl apply -f time-slicing-config.yaml

# Reference the ConfigMap from the GPU Operator's ClusterPolicy
kubectl patch clusterpolicy gpu-cluster-policy \
  --type merge \
  -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'

# Verify nodes now advertise multiplied GPU count
kubectl get nodes -o json | jq '.items[].status.capacity | {"node": .["kubernetes.io/hostname"], "gpus": .["nvidia.com/gpu"]}'
```

For production A100 deployments, prefer **MIG (Multi-Instance GPU)** profiles instead, which provide hard memory and compute isolation between workloads.

## Deploying vLLM for Single-Model Serving

### Model Weight Storage

vLLM loads the entire model into GPU memory at startup. For a multi-replica deployment, model weights must be on a shared PVC so each replica can memory-map the same files without duplicating download I/O.

```yaml
# model-weights-pvc.yaml — ReadWriteMany PVC backed by NFS or a CSI driver
# that supports RWX (e.g., Longhorn with RWX enabled, EFS CSI, or NFS CSI)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: model-weights-pvc
  namespace: llm-serving
  annotations:
    # Retain volume if PVC is deleted to avoid re-downloading large models
    helm.sh/resource-policy: keep
spec:
  accessModes:
  - ReadWriteMany   # Multiple pods read the same weights concurrently
  storageClassName: nfs-csi
  resources:
    requests:
      storage: 200Gi  # Mistral-7B AWQ ≈ 4GB; Llama-3-70B FP16 ≈ 140GB
```

### vLLM Deployment Manifest

The following manifest deploys a two-replica vLLM server for `Mistral-7B-Instruct-v0.2` with AWQ quantization. An init container handles model weight download before the vLLM process starts, ensuring the weights exist in the shared PVC before any inference traffic arrives.

```yaml
# vllm-deployment.yaml — Single-model vLLM server for Mistral-7B-Instruct
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-mistral-7b
  namespace: llm-serving
  labels:
    app: vllm
    model: mistral-7b-instruct
    version: v0.4.3
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vllm
      model: mistral-7b-instruct
  template:
    metadata:
      labels:
        app: vllm
        model: mistral-7b-instruct
        version: v0.4.3
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      # Prefer nodes with A10G or A100 GPUs via node selector
      nodeSelector:
        accelerator: nvidia-a10g

      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule

      # Anti-affinity spreads replicas across nodes for HA
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchLabels:
                  app: vllm
                  model: mistral-7b-instruct
              topologyKey: kubernetes.io/hostname

      initContainers:
      # Download model weights from HuggingFace Hub before starting vLLM
      - name: model-downloader
        image: huggingface/transformers-pytorch-gpu:4.40.0
        command:
        - python3
        - -c
        - |
          from huggingface_hub import snapshot_download
          import os
          snapshot_download(
              repo_id="mistralai/Mistral-7B-Instruct-v0.2",
              local_dir="/models/mistral-7b-instruct",
              token=os.environ["HF_TOKEN"],
              ignore_patterns=["*.msgpack", "*.h5", "flax_model*"],
          )
        env:
        - name: HF_TOKEN
          valueFrom:
            secretKeyRef:
              name: huggingface-credentials
              key: token
        - name: HF_HUB_CACHE
          value: /models
        volumeMounts:
        - name: model-storage
          mountPath: /models
        resources:
          requests:
            memory: "4Gi"
            cpu: "2"
          limits:
            memory: "8Gi"
            cpu: "4"

      containers:
      - name: vllm
        image: vllm/vllm-openai:v0.4.3
        command:
        - python3
        - -m
        - vllm.entrypoints.openai.api_server
        args:
        - --model=/models/mistral-7b-instruct
        - --host=0.0.0.0
        - --port=8080
        - --tensor-parallel-size=1     # Number of GPUs to shard the model across
        - --max-model-len=32768          # Maximum sequence length (tokens)
        - --max-num-seqs=256             # Maximum concurrent sequences in flight
        - --max-num-batched-tokens=32768 # Total tokens per forward pass
        - --gpu-memory-utilization=0.90  # Reserve 10% GPU memory headroom
        - --dtype=bfloat16               # BF16 reduces memory vs FP32 with minimal accuracy loss
        - --quantization=awq            # AWQ quantization halves memory footprint
        - --enable-chunked-prefill      # Chunked prefill improves scheduling fairness
        - --disable-log-requests        # Reduces log volume in high-traffic environments
        - --uvicorn-log-level=warning
        ports:
        - containerPort: 8080
          name: http
          protocol: TCP
        env:
        - name: CUDA_VISIBLE_DEVICES
          value: "0"
        - name: NCCL_DEBUG
          value: "WARN"
        - name: VLLM_WORKER_MULTIPROC_METHOD
          value: "spawn"
        resources:
          requests:
            nvidia.com/gpu: "1"
            memory: "24Gi"
            cpu: "8"
          limits:
            nvidia.com/gpu: "1"
            memory: "48Gi"
            cpu: "16"
        volumeMounts:
        - name: model-storage
          mountPath: /models
        - name: shm
          mountPath: /dev/shm  # Shared memory required for CUDA IPC
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 120   # Model loading takes time
          periodSeconds: 10
          failureThreshold: 30
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 300
          periodSeconds: 30
          failureThreshold: 3

      volumes:
      - name: model-storage
        persistentVolumeClaim:
          claimName: model-weights-pvc
      - name: shm
        emptyDir:
          medium: Memory
          sizeLimit: "16Gi"  # Large shared memory for multi-process CUDA

      # Generous termination grace to let in-flight requests complete
      terminationGracePeriodSeconds: 120
```

### Service and ServiceMonitor

```yaml
# vllm-service.yaml — ClusterIP service + headless service for direct pod access
apiVersion: v1
kind: Service
metadata:
  name: vllm-mistral-7b
  namespace: llm-serving
  labels:
    app: vllm
    model: mistral-7b-instruct
spec:
  selector:
    app: vllm
    model: mistral-7b-instruct
  ports:
  - name: http
    port: 80
    targetPort: 8080
    protocol: TCP
  type: ClusterIP
---
# ServiceMonitor so Prometheus scrapes /metrics on each vLLM pod
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vllm-mistral-7b
  namespace: llm-serving
  labels:
    app: vllm
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: vllm
      model: mistral-7b-instruct
  endpoints:
  - port: http
    path: /metrics
    interval: 15s
    scrapeTimeout: 10s
```

## Tensor Parallelism for Large Models

### Multi-GPU Deployment with Tensor Parallelism

Models like Llama-3-70B do not fit in a single GPU's memory at FP16 precision (approximately 140 GB). **Tensor parallelism** splits each transformer layer's weight matrices across multiple GPUs, with each GPU computing a partial result that is then all-reduced across the group. This requires high-bandwidth interconnects — NVLink within a node is ideal; InfiniBand HDR for cross-node scenarios.

vLLM's `--tensor-parallel-size` flag controls the number of GPUs to shard across. The value must evenly divide the model's attention heads. For a node with 4 A100-80GB GPUs connected via NVLink, a tensor parallel size of 4 yields roughly linear throughput scaling.

```yaml
# vllm-llama3-70b.yaml — Tensor-parallel deployment of Llama-3-70B across 4 A100s
# Tensor parallelism splits each attention and FFN layer across multiple GPUs.
# NVLink bandwidth between GPUs in the same node is critical for performance.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama3-70b
  namespace: llm-serving
  labels:
    app: vllm
    model: llama3-70b-instruct
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm
      model: llama3-70b-instruct
  template:
    metadata:
      labels:
        app: vllm
        model: llama3-70b-instruct
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      nodeSelector:
        # Node must have 4 A100-80GB GPUs connected via NVLink
        nvidia.com/gpu.product: NVIDIA-A100-SXM4-80GB
        nvidia.com/gpu.count: "4"

      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule

      containers:
      - name: vllm
        image: vllm/vllm-openai:v0.4.3
        command:
        - python3
        - -m
        - vllm.entrypoints.openai.api_server
        args:
        - --model=/models/llama3-70b-instruct
        - --host=0.0.0.0
        - --port=8080
        - --tensor-parallel-size=4          # Split across all 4 GPUs on the node
        - --pipeline-parallel-size=1        # No pipeline parallelism (single node)
        - --max-model-len=8192
        - --max-num-seqs=64
        - --max-num-batched-tokens=16384
        - --gpu-memory-utilization=0.92
        - --dtype=bfloat16
        - --enable-chunked-prefill
        - --kv-cache-dtype=fp8              # FP8 KV cache reduces memory by ~50%
        ports:
        - containerPort: 8080
          name: http
        env:
        - name: CUDA_VISIBLE_DEVICES
          value: "0,1,2,3"
        - name: NCCL_IB_DISABLE
          value: "0"       # Enable InfiniBand for NCCL if available
        - name: NCCL_DEBUG
          value: "WARN"
        resources:
          requests:
            nvidia.com/gpu: "4"
            memory: "256Gi"
            cpu: "32"
          limits:
            nvidia.com/gpu: "4"
            memory: "320Gi"
            cpu: "48"
        volumeMounts:
        - name: model-storage
          mountPath: /models
        - name: shm
          mountPath: /dev/shm
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 300   # 70B model loading takes ~5 minutes
          periodSeconds: 15
          failureThreshold: 40

      volumes:
      - name: model-storage
        persistentVolumeClaim:
          claimName: model-weights-large-pvc
      - name: shm
        emptyDir:
          medium: Memory
          sizeLimit: "64Gi"

      terminationGracePeriodSeconds: 300
```

### Choosing Parallelism Strategy

| Strategy | When to Use | Tradeoffs |
|---|---|---|
| No parallelism (TP=1) | Models ≤ 13B at FP16 or any model with AWQ | Simplest; no inter-GPU communication overhead |
| Tensor parallel (TP=N, single node) | 30B–70B models; GPUs share NVLink | All-reduce adds ~5% latency per layer; requires NVLink |
| Pipeline parallel (PP=N, multi-node) | Models too large for a single node | Higher latency due to bubble overhead; complex scheduling |
| TP+PP combined | 180B+ models across multiple nodes | Maximum scale; requires both NVLink and InfiniBand |

For most enterprise deployments, staying within a single node with tensor parallelism delivers the best latency profile. Cross-node parallelism introduces network round-trips that degrade time-to-first-token significantly.

## Autoscaling with KEDA

### Why Standard HPA Falls Short

The Kubernetes HPA can scale on CPU and memory, and with the custom metrics API it can target arbitrary Prometheus metrics — but the configuration requires deploying `prometheus-adapter` and managing `APIService` registrations. **KEDA** (Kubernetes Event-Driven Autoscaling) provides a simpler path: a `ScaledObject` resource that directly queries Prometheus without the adapter complexity.

vLLM exposes the `vllm:num_requests_waiting` metric — the number of requests queued but not yet dispatched to the model. This is the ideal autoscaling signal because it directly measures backpressure: a non-zero waiting queue means current capacity is insufficient.

### KEDA ScaledObject

```yaml
# keda-scaledobject.yaml — KEDA-based autoscaling from Prometheus metrics
# KEDA is preferred over HPA for Prometheus-native metrics since it avoids
# the custom-metrics-apiserver complexity.
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: vllm-mistral-7b-keda
  namespace: llm-serving
spec:
  scaleTargetRef:
    name: vllm-mistral-7b
  minReplicaCount: 1
  maxReplicaCount: 8
  cooldownPeriod: 300       # Seconds to wait before scaling down
  pollingInterval: 15       # Check metrics every 15 seconds

  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://kube-prometheus-stack-prometheus.monitoring.svc:9090
      metricName: vllm_num_requests_waiting
      # Scale up when any replica has more than 3 waiting requests
      query: max(vllm_num_requests_waiting{namespace="llm-serving",app="vllm"})
      threshold: "3"
      activationThreshold: "1"  # Wake from 0 replicas when 1+ request waiting

  # Scale to zero when no requests in flight (cost optimization for dev)
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
```

### Scale-to-Zero Considerations

Scale-to-zero is attractive for cost but introduces a **cold-start latency** problem: a new vLLM pod must allocate GPU memory and load model weights before serving its first request. For a 7B model this takes 60–120 seconds; for 70B it exceeds 5 minutes. Mitigations include:

- **Keep minReplicaCount: 1** for latency-sensitive production deployments.
- Use scale-to-zero only for development or batch-processing workloads where cold-start is acceptable.
- Pre-warm pods by routing a synthetic keepalive request every 4 minutes to prevent scale-down when the deployment is standby but must respond quickly.

## Multi-Model Serving and Request Routing

### Ingress-Based Model Routing

Deploying each model as a separate Kubernetes Deployment and routing by URL prefix is the simplest multi-model architecture. It isolates model failures, allows per-model autoscaling, and maps cleanly to OpenAI client library conventions where the model name appears in the request body.

```yaml
# vllm-ingress.yaml — Route /v1/chat/completions to the correct model backend
# based on the model name in the request body, handled by NGINX annotations
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-gateway
  namespace: llm-serving
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    # Sticky sessions ensure a client's streaming response goes to the same pod
    nginx.ingress.kubernetes.io/affinity: "cookie"
    nginx.ingress.kubernetes.io/affinity-mode: "persistent"
    nginx.ingress.kubernetes.io/session-cookie-name: "vllm-pod"
    nginx.ingress.kubernetes.io/session-cookie-max-age: "300"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - llm.internal.example.com
    secretName: llm-tls-cert
  rules:
  - host: llm.internal.example.com
    http:
      paths:
      # Route by URL prefix — each model gets its own path prefix
      - path: /mistral
        pathType: Prefix
        backend:
          service:
            name: vllm-mistral-7b
            port:
              number: 80
      - path: /llama3-70b
        pathType: Prefix
        backend:
          service:
            name: vllm-llama3-70b
            port:
              number: 80
      - path: /codellama
        pathType: Prefix
        backend:
          service:
            name: vllm-codellama-34b
            port:
              number: 80
```

### Model Pre-Caching Job

Rather than relying on init containers to download weights at pod startup, a pre-caching Kubernetes Job populates the shared PVC ahead of time. Using a Helm pre-install hook ensures the job completes before any vLLM pods are created during `helm install`.

```yaml
# model-cache-job.yaml — Run model downloader as a one-off Job before
# deploying vLLM. Use a Job hook in Helm (helm.sh/hook: pre-install) to
# ensure weights are ready before pods start.
apiVersion: batch/v1
kind: Job
metadata:
  name: model-cache-mistral-7b
  namespace: llm-serving
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "-5"
    helm.sh/hook-delete-policy: hook-succeeded
spec:
  backoffLimit: 3
  activeDeadlineSeconds: 3600  # Fail if download takes > 1 hour
  template:
    spec:
      restartPolicy: OnFailure

      nodeSelector:
        # Run on a CPU-only node to avoid wasting GPU nodes on download I/O
        kubernetes.io/arch: amd64

      containers:
      - name: model-downloader
        image: huggingface/transformers-pytorch-cpu:4.40.0
        command:
        - python3
        - -c
        - |
          from huggingface_hub import snapshot_download
          import os
          result = snapshot_download(
              repo_id="mistralai/Mistral-7B-Instruct-v0.2",
              local_dir="/models/mistral-7b-instruct",
              token=os.environ["HF_TOKEN"],
              ignore_patterns=["*.msgpack", "*.h5", "flax_model*"],
          )
          print(f"Cached to: {result}")
        env:
        - name: HF_TOKEN
          valueFrom:
            secretKeyRef:
              name: huggingface-credentials
              key: token
        resources:
          requests:
            memory: "8Gi"
            cpu: "4"
          limits:
            memory: "16Gi"
            cpu: "8"
        volumeMounts:
        - name: model-storage
          mountPath: /models

      volumes:
      - name: model-storage
        persistentVolumeClaim:
          claimName: model-weights-pvc
```

## Performance Benchmarking

### Running the vLLM Benchmark Suite

vLLM ships with `vllm.benchmarks.benchmark_serving`, a load generator that replays ShareGPT conversations against the OpenAI-compatible API. Running this from a pod inside the cluster isolates network latency from true serving latency.

```bash
#!/bin/bash
# vllm-benchmark.sh — Measure throughput (tok/s) and TTFT using vLLM's built-in
# benchmarking tool. Run from a pod inside the cluster for accurate latency.

set -euo pipefail

ENDPOINT="${1:-http://vllm-mistral-7b.llm-serving.svc/v1}"
MODEL="${2:-mistralai/Mistral-7B-Instruct-v0.2}"
CONCURRENCY="${3:-32}"
NUM_PROMPTS="${4:-200}"

echo "=== vLLM Benchmark ==="
echo "Endpoint:    $ENDPOINT"
echo "Model:       $MODEL"
echo "Concurrency: $CONCURRENCY"
echo "Prompts:     $NUM_PROMPTS"
echo

# Run the official vLLM benchmark against the OpenAI-compatible endpoint
python3 -m vllm.benchmarks.benchmark_serving \
  --backend openai-chat \
  --base-url "$ENDPOINT" \
  --model "$MODEL" \
  --dataset-name sharegpt \
  --dataset-path /data/ShareGPT_V3_unfiltered_cleaned_split.json \
  --num-prompts "$NUM_PROMPTS" \
  --max-concurrency "$CONCURRENCY" \
  --save-result \
  --result-dir /tmp/benchmark_results \
  --percentile-metrics ttft,tpot,itl,e2el

# Print summary of key metrics from the result JSON
RESULT_FILE=$(ls -t /tmp/benchmark_results/*.json | head -1)
python3 - << 'PYEOF'
import json, sys, glob
results = sorted(glob.glob("/tmp/benchmark_results/*.json"))
if not results:
    print("No result files found")
    sys.exit(1)
data = json.load(open(results[-1]))
print(f"\n=== Results ===")
print(f"Request throughput:  {data.get('request_throughput', 'N/A'):.2f} req/s")
print(f"Output token tput:   {data.get('output_throughput', 'N/A'):.2f} tok/s")
print(f"TTFT mean:           {data.get('mean_ttft_ms', 'N/A'):.1f} ms")
print(f"TTFT p99:            {data.get('p99_ttft_ms', 'N/A'):.1f} ms")
print(f"Inter-token latency: {data.get('mean_itl_ms', 'N/A'):.2f} ms/tok")
print(f"E2E latency p99:     {data.get('p99_e2el_ms', 'N/A'):.0f} ms")
PYEOF
```

### Key Performance Parameters

The following parameters have the most significant impact on throughput and latency:

| Parameter | Impact | Guidance |
|---|---|---|
| `--max-num-seqs` | Higher = more parallelism; uses more GPU memory | Start at 256; reduce if OOM |
| `--max-num-batched-tokens` | Controls max tokens per forward pass | Set to 2× `max-model-len` for high throughput |
| `--gpu-memory-utilization` | Higher = larger KV cache; more concurrent requests | 0.90 is safe; 0.95 risks OOM on long contexts |
| `--quantization awq` | ~2× throughput improvement at minor quality cost | Preferred for production 7B–13B models |
| `--kv-cache-dtype fp8` | Halves KV cache memory; enables longer contexts | Requires Hopper (H100) or Ada Lovelace GPUs |
| `--enable-chunked-prefill` | Reduces head-of-line blocking for long prompts | Always enable in mixed workload environments |

## Observability and Alerting

### Prometheus Alerting Rules

vLLM exposes a rich set of Prometheus metrics: `vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:time_to_first_token_seconds`, `vllm:time_per_output_token_seconds`, and `vllm:gpu_cache_usage_perc`. These align with the four golden signals (latency, traffic, errors, saturation) and enable SLO-based alerting.

```yaml
# vllm-alerts.yaml — PrometheusRule for SLO-aligned vLLM alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vllm-slo-alerts
  namespace: llm-serving
  labels:
    release: kube-prometheus-stack
spec:
  groups:
  - name: vllm.slo
    interval: 30s
    rules:

    # Alert when p95 TTFT exceeds 2 seconds (typical interactive SLO)
    - alert: VLLMHighTimeToFirstToken
      expr: |
        histogram_quantile(0.95,
          rate(vllm_time_to_first_token_seconds_bucket{namespace="llm-serving"}[5m])
        ) > 2.0
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "vLLM p95 TTFT exceeds 2s on {{ $labels.model_name }}"
        description: |
          The 95th percentile time-to-first-token for model {{ $labels.model_name }}
          is {{ $value | humanizeDuration }}, exceeding the 2-second SLO threshold.
          This typically indicates GPU saturation or batch scheduling delays.
        runbook_url: "https://wiki.internal/runbooks/vllm-high-ttft"

    # Alert when request queue depth grows uncontrollably
    - alert: VLLMRequestQueueSaturated
      expr: |
        max by (namespace, model_name) (
          vllm_num_requests_waiting{namespace="llm-serving"}
        ) > 20
      for: 2m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "vLLM request queue depth > 20 on {{ $labels.model_name }}"
        description: |
          Model {{ $labels.model_name }} has {{ $value }} requests waiting.
          Autoscaling may not be keeping up; check KEDA ScaledObject events
          and GPU node availability.

    # Alert when GPU memory utilization is consistently near the limit
    - alert: VLLMGPUMemoryPressure
      expr: |
        (
          nvidia_smi_memory_used_bytes{namespace="llm-serving"}
          /
          nvidia_smi_memory_total_bytes{namespace="llm-serving"}
        ) > 0.95
      for: 10m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "GPU memory utilization > 95% on vLLM pod {{ $labels.pod }}"
        description: |
          Pod {{ $labels.pod }} is using {{ $value | humanizePercentage }} of GPU
          memory. Risk of OOM. Consider reducing --gpu-memory-utilization flag
          or switching to a smaller quantized model.

    # Alert when a vLLM pod crashes (OOM or model loading failure)
    - alert: VLLMPodCrashLooping
      expr: |
        rate(kube_pod_container_status_restarts_total{
          namespace="llm-serving",
          container="vllm"
        }[15m]) > 0
      for: 5m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "vLLM container restarting in pod {{ $labels.pod }}"
        description: |
          The vLLM container in {{ $labels.pod }} has restarted. Common causes:
          GPU OOM (reduce --gpu-memory-utilization), insufficient shared memory
          (increase /dev/shm), or model download failure.
```

## Reliability and Security

### Network Policy

Restrict vLLM pod ingress to authorized clients only. The LLM serving layer represents a high-value compute resource; unrestricted cluster access opens the door to GPU exhaustion attacks from misconfigured internal services.

```yaml
# vllm-network-policy.yaml — Restrict vLLM pod ingress to only authorized clients
# The LLM serving layer should not be exposed to arbitrary cluster traffic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vllm-ingress-policy
  namespace: llm-serving
spec:
  podSelector:
    matchLabels:
      app: vllm
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow traffic from the NGINX ingress controller
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
    ports:
    - port: 8080
      protocol: TCP
  # Allow traffic from application namespaces with explicit label
  - from:
    - namespaceSelector:
        matchLabels:
          llm-access: "true"
    ports:
    - port: 8080
      protocol: TCP
  # Allow Prometheus scraping from monitoring namespace
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    ports:
    - port: 8080
      protocol: TCP
  egress:
  # Allow DNS resolution
  - to:
    - namespaceSelector: {}
    ports:
    - port: 53
      protocol: UDP
  # Allow access to NFS/storage for model weights
  - to:
    - ipBlock:
        cidr: 10.0.0.0/8  # Internal network — adjust to match storage CIDR
    ports:
    - port: 2049  # NFS
      protocol: TCP
```

### PodDisruptionBudget

GPU nodes require periodic maintenance — kernel upgrades, NVIDIA driver updates, hardware replacements. A `PodDisruptionBudget` prevents `kubectl drain` from evicting all replicas simultaneously, ensuring at least one inference pod remains available during rolling node maintenance.

```yaml
# vllm-pdb.yaml — Ensure at least one replica stays up during node drains
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: vllm-mistral-7b-pdb
  namespace: llm-serving
spec:
  minAvailable: 1   # At least 1 replica must remain available at all times
  selector:
    matchLabels:
      app: vllm
      model: mistral-7b-instruct
---
# For the 70B model (single replica), use maxUnavailable:0 to prevent eviction
# unless explicitly overridden — coordinate upgrades with the on-call team
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: vllm-llama3-70b-pdb
  namespace: llm-serving
spec:
  maxUnavailable: 0
  selector:
    matchLabels:
      app: vllm
      model: llama3-70b-instruct
```

### Securing the HuggingFace Token

Store HuggingFace access tokens as Kubernetes Secrets and never bake them into container images. Use an external secrets manager (Vault, AWS Secrets Manager, or Sealed Secrets) for production deployments:

```bash
# Create the HuggingFace credentials secret
kubectl create secret generic huggingface-credentials \
  --namespace llm-serving \
  --from-literal=token="${HF_TOKEN}" \
  --dry-run=client -o yaml | \
  kubeseal --controller-namespace kube-system \
           --controller-name sealed-secrets \
           --format yaml > sealed-hf-credentials.yaml

kubectl apply -f sealed-hf-credentials.yaml
```

## Common Operational Issues

### GPU OOM During Model Loading

When vLLM crashes with `torch.cuda.OutOfMemoryError` during startup:

```bash
# Check current GPU memory consumption across all nodes
kubectl get pods -n llm-serving -o wide | grep vllm | awk '{print $7}' | sort -u | \
  xargs -I{} sh -c 'echo "Node: {}"; kubectl debug node/{} -it --image=nvidia/cuda:12.4.0-base-ubuntu22.04 -- nvidia-smi --query-gpu=memory.used,memory.free,memory.total --format=csv'

# Identify the container's actual GPU memory limit
kubectl describe pod -n llm-serving <pod-name> | grep -A5 "Limits:"
```

Fixes in order of preference:
1. Reduce `--gpu-memory-utilization` from 0.90 to 0.85.
2. Enable AWQ or GPTQ quantization to halve the weight memory.
3. Reduce `--max-model-len` to shrink the KV cache pre-allocation.
4. Use a smaller model variant (7B instead of 13B, or a quantized 70B).

### Slow Model Loading

A 70B FP16 model over NFS can take 10–15 minutes to load on first boot if the NFS server's read throughput is a bottleneck. Mitigation strategies:

```bash
# Check NFS mount performance on the GPU node
kubectl debug node/<gpu-node> -it --image=alpine -- sh -c \
  "apk add -q fio && fio --name=read-test --ioengine=libaio --rw=read \
   --bs=1m --direct=1 --size=4g --numjobs=4 \
   --filename=/models/test_file --runtime=30 --time_based"

# Alternatively, use a local NVMe-backed PVC for model weights
# and only use NFS for the initial cold download
```

Consider using a CSI driver with local NVMe storage (`local-path-provisioner` or `TopoLVM`) for model weights on GPU nodes, with NFS serving as the durable backup tier.

### Requests Stuck in Waiting Queue

When `vllm_num_requests_waiting` grows but `vllm_num_requests_running` stays flat:

```bash
# Check if vLLM is reporting healthy
kubectl exec -n llm-serving <pod-name> -- curl -s http://localhost:8080/health

# Check for memory pressure that would prevent new requests from starting
kubectl exec -n llm-serving <pod-name> -- curl -s http://localhost:8080/metrics | \
  grep -E "vllm_gpu_cache_usage|vllm_num_requests"

# Check current KV cache utilization — if near 100%, requests wait for cache space
kubectl exec -n llm-serving <pod-name> -- curl -s http://localhost:8080/metrics | \
  grep vllm_gpu_cache_usage_perc
```

If KV cache utilization is consistently at 100%, reduce `--max-model-len`, increase GPU memory via a larger GPU SKU, or enable `--kv-cache-dtype fp8` to double the effective cache capacity.

## Conclusion

Deploying vLLM on Kubernetes requires deliberate decisions across GPU configuration, model distribution, autoscaling strategy, and operational observability. The NVIDIA GPU Operator automates node-level GPU management, allowing Kubernetes workload manifests to focus purely on model configuration. Tensor parallelism enables single-pod serving of 70B+ models without pipeline parallelism latency penalties, provided NVLink interconnects are available. KEDA provides the most operationally straightforward autoscaling path, reacting to the `vllm_num_requests_waiting` backpressure signal with sub-minute response times.

Key takeaways for production deployments:

- Use a ReadWriteMany PVC backed by high-throughput NFS or a local-NVMe CSI driver for model weights; init-container downloads add unacceptable startup latency at scale.
- Set `--gpu-memory-utilization=0.90` as the default and tune downward if OOM crashes occur — the 10% headroom prevents KV cache from crowding out CUDA allocations.
- Enable KEDA with the `vllm_num_requests_waiting` trigger for autoscaling; the standard HPA cannot react to this signal without complex custom-metrics-apiserver configuration.
- Deploy `PodDisruptionBudgets` for every vLLM Deployment before performing node maintenance; GPU pod startup times make unexpected evictions far more disruptive than in CPU workloads.
- Pin NVIDIA driver versions in the GPU Operator and test driver upgrades in a staging cluster before rolling to production — driver/CUDA mismatches are a common source of silent performance regressions.
