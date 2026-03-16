---
title: "vLLM Inference on Kubernetes: High-Throughput LLM Serving with PagedAttention"
date: 2027-07-17T00:00:00-05:00
draft: false
tags: ["vLLM", "LLM", "Kubernetes", "GPU", "AI/ML", "Inference"]
categories:
- Kubernetes
- AI/ML
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to deploying vLLM on Kubernetes covering PagedAttention architecture, OpenAI-compatible API serving, tensor parallelism across multiple GPUs, quantization strategies (AWQ, GPTQ, FP8), KEDA autoscaling, and Prometheus monitoring for high-throughput LLM inference."
more_link: "yes"
url: "/vllm-inference-kubernetes-deployment-guide/"
---

vLLM has become the standard for high-throughput LLM inference in production environments. Its PagedAttention memory management eliminates the waste that plagues naive KV cache implementations, enabling 2–24x higher throughput than alternatives at the same hardware budget. This guide covers the full deployment lifecycle on Kubernetes: from understanding the architecture to configuring tensor parallelism, quantization, autoscaling, and production monitoring.

<!--more-->

# vLLM Inference on Kubernetes: High-Throughput LLM Serving with PagedAttention

## Section 1: vLLM Architecture and PagedAttention

### Why vLLM Outperforms Naive Inference

Standard LLM inference allocates KV cache memory contiguously at the maximum context length per request. A model supporting 8K context tokens reserves 8K worth of KV cache per request slot — even when the actual request is 200 tokens. This wastes 97% of cache memory.

**PagedAttention** treats KV cache like virtual memory in an OS:
- Cache is divided into fixed-size **pages** (typically 16 tokens each)
- Pages are allocated on demand as the sequence grows
- Non-contiguous pages are mapped through a logical-to-physical page table
- Pages from completed sequences are immediately returned to the free pool

This enables:
- **Higher concurrency**: 10–30x more requests in flight simultaneously
- **Continuous batching**: Requests join and leave the batch mid-generation without waiting for a batch boundary
- **Prefix caching**: Shared prompt prefixes reuse cached KV pages across requests

### vLLM Request Processing Pipeline

```
Client Request
      │
      ▼
Tokenization → Scheduler → GPU Engine → Detokenization → Response
                   │
                   ├── Continuous batching (running batch)
                   ├── Waiting queue (queued requests)
                   └── Swapped queue (CPU-offloaded KV cache)
```

---

## Section 2: Kubernetes Deployment Prerequisites

### GPU Node Requirements

vLLM requires CUDA 11.8+ and NVIDIA GPUs with compute capability 7.0+ (Volta, Turing, Ampere, Hopper). For production serving:

| Model Size | Recommended GPU | VRAM Required |
|---|---|---|
| 7B (BF16) | A10G (24GB) x1 | 16GB |
| 7B (AWQ 4-bit) | A10G (24GB) x1 | 6GB |
| 70B (BF16) | A100 (80GB) x2 | 140GB |
| 70B (AWQ 4-bit) | A100 (80GB) x1 | 40GB |
| 405B (FP8) | H100 (80GB) x4 | 240GB |

### NVIDIA GPU Operator (if not already installed)

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set driver.enabled=true \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true
```

### Namespace Setup

```yaml
# vllm-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: vllm
  labels:
    app.kubernetes.io/name: vllm
    environment: production
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: vllm-gpu-quota
  namespace: vllm
spec:
  hard:
    requests.nvidia.com/gpu: "16"
    limits.nvidia.com/gpu: "16"
    requests.memory: "1Ti"
    pods: "30"
```

---

## Section 3: Model Loading Strategies

### Loading from HuggingFace Hub

vLLM downloads models from HuggingFace Hub by model ID. Store the HuggingFace token in a Kubernetes Secret:

```yaml
# hf-token-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: huggingface-token
  namespace: vllm
type: Opaque
stringData:
  token: "HF_TOKEN_REPLACE_ME"
```

### Loading from PersistentVolume (Air-Gapped)

For air-gapped environments, pre-download the model to a PVC:

```yaml
# model-download-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: download-llama-3-8b
  namespace: vllm
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: downloader
          image: python:3.12-slim
          command:
            - /bin/sh
            - -c
            - |
              pip install huggingface_hub -q
              python3 -c "
              from huggingface_hub import snapshot_download
              snapshot_download(
                  repo_id='meta-llama/Meta-Llama-3.1-8B-Instruct',
                  local_dir='/models/meta-llama/Meta-Llama-3.1-8B-Instruct',
                  token='$(HF_TOKEN)',
                  ignore_patterns=['*.bin']  # Prefer safetensors
              )
              print('Download complete')
              "
          env:
            - name: HF_TOKEN
              valueFrom:
                secretKeyRef:
                  name: huggingface-token
                  key: token
          resources:
            requests:
              cpu: "4"
              memory: 16Gi
            limits:
              cpu: "8"
              memory: 32Gi
          volumeMounts:
            - name: models
              mountPath: /models
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: vllm-models
```

**PVC for model storage:**

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vllm-models
  namespace: vllm
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3-fast
  resources:
    requests:
      storage: 500Gi
```

---

## Section 4: Single-GPU Deployment

### Core vLLM Deployment

```yaml
# vllm-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama3-8b
  namespace: vllm
  labels:
    app: vllm
    model: llama3-8b
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm
      model: llama3-8b
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: vllm
        model: llama3-8b
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8000"
        prometheus.io/path: "/metrics"
    spec:
      runtimeClassName: nvidia
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: nvidia.com/gpu.present
                    operator: In
                    values: ["true"]
                  - key: nvidia.com/gpu.memory
                    operator: Gt
                    values: ["20000"]  # >20GB VRAM
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.4
          command:
            - python3
            - -m
            - vllm.entrypoints.openai.api_server
          args:
            - --model
            - /models/meta-llama/Meta-Llama-3.1-8B-Instruct
            - --served-model-name
            - llama3-8b-instruct
            - --host
            - "0.0.0.0"
            - --port
            - "8000"
            - --max-model-len
            - "8192"
            - --max-num-seqs
            - "256"
            - --gpu-memory-utilization
            - "0.90"
            - --enforce-eager
            - "false"
            - --enable-chunked-prefill
            - --disable-log-requests
          ports:
            - containerPort: 8000
              name: http
          env:
            - name: VLLM_WORKER_MULTIPROC_METHOD
              value: spawn
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
          resources:
            requests:
              cpu: "8"
              memory: 32Gi
              nvidia.com/gpu: "1"
            limits:
              cpu: "16"
              memory: 64Gi
              nvidia.com/gpu: "1"
          volumeMounts:
            - name: models
              mountPath: /models
            - name: shm
              mountPath: /dev/shm
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 120
            periodSeconds: 30
            failureThreshold: 3
            timeoutSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 60
            periodSeconds: 10
            failureThreshold: 5
            timeoutSeconds: 10
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: vllm-models
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 16Gi
---
apiVersion: v1
kind: Service
metadata:
  name: vllm-llama3-8b
  namespace: vllm
spec:
  selector:
    app: vllm
    model: llama3-8b
  ports:
    - name: http
      port: 8000
      targetPort: 8000
```

### Test the OpenAI-Compatible API

```bash
# List available models
curl -sf http://vllm-llama3-8b.vllm.svc.cluster.local:8000/v1/models \
  | jq '.data[].id'

# Chat completion request
curl http://vllm-llama3-8b.vllm.svc.cluster.local:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3-8b-instruct",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain Kubernetes in 3 sentences."}
    ],
    "max_tokens": 300,
    "temperature": 0.1
  }' | jq '.choices[0].message.content'
```

---

## Section 5: Tensor Parallelism for Large Models

Models exceeding single-GPU VRAM require tensor parallelism. vLLM uses NCCL for cross-GPU communication via shared memory or InfiniBand.

### Multi-GPU Pod Configuration

```yaml
# vllm-70b-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama3-70b
  namespace: vllm
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm
      model: llama3-70b
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: vllm
        model: llama3-70b
    spec:
      runtimeClassName: nvidia
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      hostIPC: true  # Required for NCCL shared memory
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.4
          command:
            - python3
            - -m
            - vllm.entrypoints.openai.api_server
          args:
            - --model
            - /models/meta-llama/Meta-Llama-3.1-70B-Instruct
            - --served-model-name
            - llama3-70b-instruct
            - --tensor-parallel-size
            - "4"
            - --max-model-len
            - "16384"
            - --max-num-seqs
            - "128"
            - --gpu-memory-utilization
            - "0.92"
            - --enable-chunked-prefill
            - --port
            - "8000"
          env:
            - name: NCCL_SHM_DISABLE
              value: "0"
            - name: NCCL_P2P_DISABLE
              value: "0"
          resources:
            requests:
              cpu: "32"
              memory: 256Gi
              nvidia.com/gpu: "4"
            limits:
              cpu: "64"
              memory: 512Gi
              nvidia.com/gpu: "4"
          volumeMounts:
            - name: models
              mountPath: /models
            - name: shm
              mountPath: /dev/shm
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: vllm-models-large
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 32Gi
```

### Pipeline Parallelism Across Nodes (Experimental)

For models exceeding the capacity of a single 8-GPU node, pipeline parallelism distributes layers across multiple nodes using vLLM's distributed serving mode:

```bash
# Node 0 (rank 0) — leader
python3 -m vllm.entrypoints.openai.api_server \
  --model /models/llama-405b \
  --tensor-parallel-size 8 \
  --pipeline-parallel-size 2 \
  --distributed-executor-backend ray \
  --host 0.0.0.0 \
  --port 8000

# Node 1 (rank 1) — worker, configured via Ray cluster
```

**Kubernetes StatefulSet for Ray cluster:**

```yaml
# ray-cluster-vllm.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ray-worker-vllm
  namespace: vllm
spec:
  serviceName: ray-workers
  replicas: 2
  selector:
    matchLabels:
      app: ray-worker
  template:
    metadata:
      labels:
        app: ray-worker
    spec:
      runtimeClassName: nvidia
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: ray-worker
          image: vllm/vllm-openai:v0.6.4
          command:
            - ray
            - start
            - --address
            - ray-head.vllm.svc.cluster.local:6379
            - --num-gpus
            - "8"
          resources:
            requests:
              nvidia.com/gpu: "8"
              memory: 512Gi
              cpu: "64"
            limits:
              nvidia.com/gpu: "8"
              memory: 1Ti
              cpu: "128"
```

---

## Section 6: Quantization Strategies

Quantization reduces model VRAM requirements and increases inference throughput, with modest quality trade-offs.

### AWQ (Activation-aware Weight Quantization)

AWQ 4-bit quantization reduces memory to ~25% of BF16 with minimal quality loss:

```yaml
# vllm-awq-deployment.yaml — key args section
args:
  - --model
  - /models/meta-llama/Meta-Llama-3.1-8B-Instruct-AWQ
  - --quantization
  - awq
  - --dtype
  - auto
  - --max-model-len
  - "8192"
  - --gpu-memory-utilization
  - "0.85"
```

### GPTQ Quantization

```yaml
args:
  - --model
  - /models/TheBloke/Llama-2-70B-Chat-GPTQ
  - --quantization
  - gptq
  - --dtype
  - float16
  - --max-model-len
  - "4096"
```

### FP8 Quantization (H100 Recommended)

FP8 provides near-BF16 quality at half the memory on H100 GPUs:

```yaml
args:
  - --model
  - /models/meta-llama/Meta-Llama-3.1-405B-Instruct
  - --quantization
  - fp8
  - --kv-cache-dtype
  - fp8
  - --calculate-kv-scales
  - --tensor-parallel-size
  - "8"
  - --max-model-len
  - "32768"
```

### Quantization Performance Comparison

```bash
#!/bin/bash
# Benchmark script for quantization comparison
MODEL_URL="http://vllm-service.vllm.svc.cluster.local:8000"

run_benchmark() {
  local model_name=$1
  local concurrency=$2
  local num_requests=100

  echo "=== Benchmarking $model_name at concurrency $concurrency ==="
  python3 -c "
import asyncio
import aiohttp
import time
import statistics

async def single_request(session, url, model):
    payload = {
        'model': model,
        'messages': [{'role': 'user', 'content': 'Write a haiku about Kubernetes.'}],
        'max_tokens': 100
    }
    start = time.perf_counter()
    async with session.post(url + '/v1/chat/completions', json=payload) as resp:
        data = await resp.json()
        elapsed = time.perf_counter() - start
        tokens = data['usage']['completion_tokens']
        return elapsed, tokens

async def main():
    url = '${MODEL_URL}'
    model = '${model_name}'
    concurrency = ${concurrency}
    total = ${num_requests}
    connector = aiohttp.TCPConnector(limit=concurrency)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [single_request(session, url, model) for _ in range(total)]
        results = await asyncio.gather(*tasks)
    latencies = [r[0] for r in results]
    throughputs = [r[1] / r[0] for r in results]
    print(f'P50 latency: {statistics.median(latencies):.2f}s')
    print(f'P99 latency: {sorted(latencies)[int(0.99*len(latencies))]:.2f}s')
    print(f'Avg tokens/sec: {statistics.mean(throughputs):.1f}')

asyncio.run(main())
"
}

run_benchmark "llama3-8b-instruct" 10
run_benchmark "llama3-8b-instruct-awq" 10
```

---

## Section 7: Continuous Batching Tuning

vLLM's scheduler parameters significantly impact throughput and latency.

**Key scheduler configuration flags:**

```yaml
args:
  # Maximum concurrent sequences in the running batch
  - --max-num-seqs
  - "512"
  # Maximum tokens to process in a single forward pass
  - --max-num-batched-tokens
  - "16384"
  # Enable chunked prefill (better GPU utilization for mixed workloads)
  - --enable-chunked-prefill
  # Maximum chunk size for prefill phase
  - --max-chunked-prefill-tokens
  - "4096"
  # Preemption mode: recompute (saves memory) vs swap (saves compute)
  - --preemption-mode
  - "recompute"
  # Target P99 TTFT (time to first token) in ms for scheduling
  # (available in newer vLLM versions)
  - --scheduling-policy
  - "fcfs"
```

**Tuning guidance by workload:**

| Workload | max-num-seqs | max-num-batched-tokens | chunked-prefill |
|---|---|---|---|
| Interactive chat | 64–128 | 4096–8192 | Enabled |
| Batch API | 256–512 | 16384–32768 | Enabled |
| Long context (>32K) | 8–32 | 8192 | Enabled |
| Embedding only | 512+ | 32768+ | Optional |

---

## Section 8: KEDA Autoscaling for vLLM

### Prometheus Metrics from vLLM

vLLM exposes native Prometheus metrics at `/metrics`:

```
vllm:num_requests_running      — requests currently being processed
vllm:num_requests_waiting      — requests in the waiting queue
vllm:gpu_cache_usage_perc      — KV cache utilization (0–1)
vllm:generation_tokens_total   — total tokens generated
vllm:prompt_tokens_total       — total prompt tokens processed
vllm:request_success_total     — completed requests
vllm:time_to_first_token_seconds — TTFT histogram
vllm:time_per_output_token_seconds — inter-token latency histogram
```

### ScaledObject Based on Queue Depth

```yaml
# vllm-keda-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: vllm-scaler
  namespace: vllm
spec:
  scaleTargetRef:
    name: vllm-llama3-8b
  minReplicaCount: 1
  maxReplicaCount: 10
  cooldownPeriod: 120
  pollingInterval: 10
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
            - type: Pods
              value: 2
              periodSeconds: 60
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Pods
              value: 1
              periodSeconds: 120
  triggers:
    - type: prometheus
      metadata:
        serverAddress: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
        metricName: vllm_queue_depth
        threshold: "10"
        query: |
          sum(vllm:num_requests_waiting{namespace="vllm", model_name="llama3-8b-instruct"})
    - type: prometheus
      metadata:
        serverAddress: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
        metricName: vllm_cache_pressure
        threshold: "85"
        query: |
          avg(vllm:gpu_cache_usage_perc{namespace="vllm"}) * 100
```

### PodDisruptionBudget for Zero-Downtime Scaling

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: vllm-pdb
  namespace: vllm
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: vllm
```

---

## Section 9: Multi-Model Serving Patterns

### Pattern 1: Separate Deployments per Model

The simplest pattern: one Deployment per model, each with its own Service.

```yaml
# Deploy multiple models with different resource profiles
---
# Small model (coding, chat)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-deepseek-7b
  namespace: vllm
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vllm
      model: deepseek-7b
  template:
    metadata:
      labels:
        app: vllm
        model: deepseek-7b
    spec:
      runtimeClassName: nvidia
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.4
          args:
            - --model
            - /models/deepseek-ai/deepseek-coder-7b-instruct-v1.5
            - --served-model-name
            - deepseek-coder-7b
            - --port
            - "8000"
            - --max-model-len
            - "16384"
          resources:
            requests:
              nvidia.com/gpu: "1"
              memory: 24Gi
              cpu: "4"
            limits:
              nvidia.com/gpu: "1"
              memory: 48Gi
              cpu: "16"
          volumeMounts:
            - name: models
              mountPath: /models
            - name: shm
              mountPath: /dev/shm
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: vllm-models
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 8Gi
```

### Pattern 2: Load Balancer with Model Router

Use an nginx ingress with routing rules to direct traffic by model name:

```yaml
# vllm-ingress-routing.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-model-router
  namespace: vllm
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/use-regex: "true"
spec:
  ingressClassName: nginx
  rules:
    - host: llm-api.internal.myorg.com
      http:
        paths:
          - path: /v1/(.*llama3-70b.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: vllm-llama3-70b
                port:
                  number: 8000
          - path: /v1/(.*deepseek.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: vllm-deepseek-7b
                port:
                  number: 8000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: vllm-llama3-8b
                port:
                  number: 8000
```

---

## Section 10: Monitoring with Prometheus

### ServiceMonitor for vLLM

```yaml
# vllm-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vllm-metrics
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - vllm
  selector:
    matchLabels:
      app: vllm
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
```

### vLLM Prometheus Alert Rules

```yaml
# vllm-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vllm-alerts
  namespace: monitoring
spec:
  groups:
    - name: vllm.performance
      rules:
        - alert: VLLMHighQueueDepth
          expr: |
            sum by (model_name, namespace) (
              vllm:num_requests_waiting
            ) > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vLLM queue depth high for {{ $labels.model_name }}"
            description: >
              {{ $value }} requests waiting.
              Consider scaling up replicas or reducing request rate.

        - alert: VLLMHighCacheUtilization
          expr: |
            avg by (model_name) (
              vllm:gpu_cache_usage_perc
            ) > 0.95
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vLLM KV cache near capacity for {{ $labels.model_name }}"
            description: >
              KV cache at {{ $value | humanizePercentage }}.
              High cache pressure causes request preemption and latency spikes.

        - alert: VLLMHighTTFT
          expr: |
            histogram_quantile(0.99,
              rate(vllm:time_to_first_token_seconds_bucket[5m])
            ) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vLLM P99 TTFT > 10s for {{ $labels.model_name }}"
            description: >
              Time to first token P99 = {{ $value | humanizeDuration }}.
              Check for queue backup or GPU contention.

        - alert: VLLMInstanceDown
          expr: |
            up{job="vllm"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "vLLM instance {{ $labels.instance }} is down"
```

### Grafana Dashboard Panels (Key Queries)

```promql
# Throughput: tokens per second
rate(vllm:generation_tokens_total{model_name="llama3-8b-instruct"}[1m])

# P50 and P99 Time to First Token
histogram_quantile(0.50, rate(vllm:time_to_first_token_seconds_bucket[5m]))
histogram_quantile(0.99, rate(vllm:time_to_first_token_seconds_bucket[5m]))

# P99 inter-token latency (streaming quality)
histogram_quantile(0.99, rate(vllm:time_per_output_token_seconds_bucket[5m]))

# KV cache utilization
avg by (model_name) (vllm:gpu_cache_usage_perc) * 100

# Running vs waiting requests
sum by (model_name) (vllm:num_requests_running)
sum by (model_name) (vllm:num_requests_waiting)

# GPU utilization (from DCGM)
avg by (kubernetes_pod_name) (DCGM_FI_DEV_GPU_UTIL{namespace="vllm"})
```

---

## Section 11: Liveness and Readiness Probe Configuration

vLLM startup can take 60–300 seconds depending on model size and quantization loading. Probes must account for this.

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8000
  initialDelaySeconds: 240     # Allow model loading time
  periodSeconds: 30
  failureThreshold: 3
  timeoutSeconds: 10
  successThreshold: 1

readinessProbe:
  httpGet:
    path: /health
    port: 8000
  initialDelaySeconds: 120
  periodSeconds: 10
  failureThreshold: 10         # Allow extended startup
  timeoutSeconds: 10
  successThreshold: 1

startupProbe:
  httpGet:
    path: /health
    port: 8000
  initialDelaySeconds: 30
  periodSeconds: 15
  failureThreshold: 20         # 30 + (15 * 20) = 330s total window
  timeoutSeconds: 10
```

---

## Section 12: Production Deployment Checklist

```
Model Preparation
  [ ] Model weights downloaded to PVC (do not rely on runtime download)
  [ ] Quantization format chosen based on GPU VRAM and quality requirements
  [ ] Model validated with smoke test before enabling traffic

Kubernetes Configuration
  [ ] runtimeClassName: nvidia set on all vLLM pods
  [ ] hostIPC: true for multi-GPU tensor parallel pods
  [ ] /dev/shm mounted as Memory-backed emptyDir (min 8GiB)
  [ ] GPU resource requests and limits set (requests == limits)
  [ ] Startup probe with sufficient initialDelaySeconds
  [ ] PodDisruptionBudget applied with minAvailable: 1

Autoscaling
  [ ] KEDA ScaledObject watching vllm:num_requests_waiting
  [ ] ScaleDown cooldownPeriod >= model warmup time
  [ ] minReplicaCount: 1 to prevent cold starts

Monitoring
  [ ] ServiceMonitor created for /metrics endpoint
  [ ] TTFT, throughput, and cache utilization dashboards in Grafana
  [ ] Alerts for queue depth, cache pressure, and high latency

Security
  [ ] HuggingFace token stored in Kubernetes Secret
  [ ] NetworkPolicy restricting access to authorized clients
  [ ] Image pinned to specific tag and digest
  [ ] No privileged mode required — CUDA works without it
```

---

## Summary

vLLM delivers state-of-the-art inference throughput through PagedAttention, continuous batching, and deep CUDA optimization. On Kubernetes, the operational complexity of GPU scheduling, model storage, and horizontal scaling is manageable with the patterns covered in this guide. Single-GPU deployments of 7B–13B models serve hundreds of concurrent users on a single A10G. Multi-GPU tensor parallel deployments handle 70B+ models. KEDA ensures the serving fleet scales with actual demand rather than worst-case provisioning. The Prometheus metrics vLLM exposes provide the observability needed to tune scheduler parameters and catch performance regressions before they affect users.
