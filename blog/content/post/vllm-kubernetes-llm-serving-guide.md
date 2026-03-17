---
title: "vLLM on Kubernetes: Production LLM Inference at Scale"
date: 2027-12-16T00:00:00-05:00
draft: false
tags: ["vLLM", "Kubernetes", "LLM", "GPU", "Inference", "KEDA", "Quantization", "AI"]
categories:
- Kubernetes
- AI/ML
- GPU
author: "Matthew Mattox - mmattox@support.tools"
description: "A production engineering guide to deploying vLLM on Kubernetes with GPU operator integration, PagedAttention, continuous batching, tensor parallelism, multi-model serving, quantization, and KEDA-based autoscaling."
more_link: "yes"
url: "/vllm-kubernetes-llm-serving-guide/"
---

Running large language model inference at production scale demands more than simply containerizing a model and scheduling it on a GPU node. vLLM provides PagedAttention memory management, continuous batching, and an OpenAI-compatible API that reduces the operational gap between research prototypes and production deployments. This guide covers every production concern: GPU operator prerequisites, StatefulSet vs Deployment tradeoffs, tensor parallelism across multiple GPUs, quantization strategies for memory-constrained hardware, Prometheus metrics, and KEDA-based autoscaling triggered by queue depth.

<!--more-->

# vLLM on Kubernetes: Production LLM Inference at Scale

## Why vLLM Over Naive Model Serving

Most teams begin LLM serving by packaging a model with a Flask or FastAPI wrapper and a CUDA-capable base image. That approach exposes several immediate problems in production:

- **Memory fragmentation**: Transformer KV-cache grows non-linearly with batch size and sequence length. Without active memory management, OOM kills arrive without warning.
- **Throughput collapse under load**: Sequential request processing wastes GPU compute during memory-bound phases.
- **Lack of continuous batching**: Static batching forces the server to wait until a batch is full before processing begins, introducing unnecessary latency.

vLLM solves all three with PagedAttention (non-contiguous KV-cache pages), continuous batching (new requests join in-flight batches), and a C++/CUDA kernel layer that maximizes GPU utilization. The OpenAI-compatible `/v1/completions` and `/v1/chat/completions` endpoints mean existing tooling integrates without modification.

## Prerequisites: NVIDIA GPU Operator

All GPU workloads on Kubernetes depend on device plugin exposure. The NVIDIA GPU Operator manages the full software stack: drivers, container toolkit, device plugin, MIG configuration, and DCGM exporter.

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

helm upgrade --install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set driver.enabled=true \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true \
  --set migManager.enabled=false \
  --version 24.3.0 \
  --wait
```

Verify the operator deployed all components:

```bash
kubectl get pods -n gpu-operator
# NAME                                                   READY   STATUS
# gpu-operator-...                                       1/1     Running
# nvidia-container-toolkit-daemonset-...                 1/1     Running
# nvidia-dcgm-exporter-...                               1/1     Running
# nvidia-device-plugin-daemonset-...                     1/1     Running
# nvidia-driver-daemonset-...                            1/1     Running

kubectl describe node gpu-node-01 | grep -A 10 "Capacity:"
# Capacity:
#   nvidia.com/gpu: 8
```

Label GPU nodes for targeted scheduling:

```bash
kubectl label node gpu-node-01 nvidia.com/gpu.product=A100-SXM4-80GB
kubectl label node gpu-node-01 workload-type=llm-inference
```

## Persistent Volume for Model Storage

Downloading a 70B model on every pod restart is unacceptable. Mount a ReadWriteMany PVC backed by a shared filesystem (NFS, Longhorn, or a cloud-managed NFS) or use a ReadWriteOnce PVC per node with a pre-populated model init container.

```yaml
# model-storage-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: llm-model-store
  namespace: llm-serving
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-csi
  resources:
    requests:
      storage: 500Gi
```

A Job populates the model cache once:

```yaml
# model-download-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: model-downloader
  namespace: llm-serving
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: downloader
          image: python:3.11-slim
          command:
            - /bin/bash
            - -c
            - |
              pip install huggingface_hub
              python -c "
              from huggingface_hub import snapshot_download
              snapshot_download(
                repo_id='meta-llama/Llama-3.1-8B-Instruct',
                local_dir='/models/llama-3.1-8b-instruct',
                token='${HF_TOKEN}'
              )
              "
          env:
            - name: HF_TOKEN
              valueFrom:
                secretKeyRef:
                  name: hf-credentials
                  key: token
          volumeMounts:
            - name: model-store
              mountPath: /models
          resources:
            requests:
              memory: "4Gi"
              cpu: "2"
      volumes:
        - name: model-store
          persistentVolumeClaim:
            claimName: llm-model-store
```

## Core vLLM Deployment

### Single-GPU Deployment (8B–13B Models)

```yaml
# vllm-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama3-8b
  namespace: llm-serving
  labels:
    app: vllm
    model: llama3-8b
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vllm
      model: llama3-8b
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
      nodeSelector:
        workload-type: llm-inference
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.4
          command:
            - python
            - -m
            - vllm.entrypoints.openai.api_server
          args:
            - --model=/models/llama-3.1-8b-instruct
            - --served-model-name=llama-3.1-8b-instruct
            - --dtype=bfloat16
            - --max-model-len=8192
            - --max-num-seqs=256
            - --gpu-memory-utilization=0.90
            - --tensor-parallel-size=1
            - --enable-chunked-prefill
            - --disable-log-requests
            - --port=8000
            - --host=0.0.0.0
          ports:
            - containerPort: 8000
              name: http
          env:
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
            - name: NCCL_DEBUG
              value: "WARN"
            - name: VLLM_LOGGING_LEVEL
              value: "INFO"
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
            - name: model-store
              mountPath: /models
              readOnly: true
            - name: shm
              mountPath: /dev/shm
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 120
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 90
            periodSeconds: 10
            failureThreshold: 6
          startupProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 60
            periodSeconds: 15
            failureThreshold: 20
      volumes:
        - name: model-store
          persistentVolumeClaim:
            claimName: llm-model-store
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 16Gi
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: vllm
                topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: vllm-llama3-8b
  namespace: llm-serving
spec:
  selector:
    app: vllm
    model: llama3-8b
  ports:
    - port: 80
      targetPort: 8000
      name: http
  type: ClusterIP
```

### Tensor Parallelism for Large Models (70B+)

Models exceeding a single GPU's VRAM require tensor parallelism. vLLM splits weight tensors across N GPUs and uses NCCL for all-reduce operations between forward passes.

```yaml
# vllm-70b-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama3-70b
  namespace: llm-serving
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm
      model: llama3-70b
  template:
    metadata:
      labels:
        app: vllm
        model: llama3-70b
    spec:
      nodeSelector:
        workload-type: llm-inference
        nvidia.com/gpu.product: A100-SXM4-80GB
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.4
          command:
            - python
            - -m
            - vllm.entrypoints.openai.api_server
          args:
            - --model=/models/llama-3.1-70b-instruct
            - --served-model-name=llama-3.1-70b-instruct
            - --dtype=bfloat16
            - --max-model-len=16384
            - --max-num-seqs=128
            - --gpu-memory-utilization=0.92
            - --tensor-parallel-size=4
            - --pipeline-parallel-size=1
            - --enable-chunked-prefill
            - --disable-log-requests
            - --port=8000
          resources:
            requests:
              nvidia.com/gpu: "4"
              memory: "128Gi"
              cpu: "32"
            limits:
              nvidia.com/gpu: "4"
              memory: "256Gi"
              cpu: "64"
          env:
            - name: NCCL_DEBUG
              value: "WARN"
            - name: NCCL_SOCKET_IFNAME
              value: "eth0"
            - name: NCCL_IB_DISABLE
              value: "0"
          volumeMounts:
            - name: model-store
              mountPath: /models
              readOnly: true
            - name: shm
              mountPath: /dev/shm
          resources:
            requests:
              nvidia.com/gpu: "4"
              memory: "128Gi"
              cpu: "32"
            limits:
              nvidia.com/gpu: "4"
              memory: "256Gi"
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 300
            periodSeconds: 30
      volumes:
        - name: model-store
          persistentVolumeClaim:
            claimName: llm-model-store
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 32Gi
```

## Quantization Strategies

Quantization reduces memory footprint at the cost of some accuracy. vLLM supports AWQ (Activation-aware Weight Quantization) and GPTQ natively.

### AWQ (4-bit, Recommended for Production)

AWQ searches for optimal per-channel scaling factors, preserving salient weights. At 4-bit it reduces a 70B model from ~140GB to ~40GB VRAM.

```yaml
args:
  - --model=/models/llama-3.1-70b-instruct-awq
  - --quantization=awq
  - --dtype=float16
  - --max-model-len=16384
  - --gpu-memory-utilization=0.92
  - --tensor-parallel-size=2
```

Pre-quantize with the `autoawq` library before deploying:

```bash
pip install autoawq

python -c "
from awq import AutoAWQForCausalLM
from transformers import AutoTokenizer

model_path = '/models/llama-3.1-70b-instruct'
quant_path = '/models/llama-3.1-70b-instruct-awq'

model = AutoAWQForCausalLM.from_pretrained(
    model_path, low_cpu_mem_usage=True, use_cache=False
)
tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)

quant_config = {
    'zero_point': True,
    'q_group_size': 128,
    'w_bit': 4,
    'version': 'GEMM'
}

model.quantize(tokenizer, quant_config=quant_config)
model.save_quantized(quant_path)
tokenizer.save_pretrained(quant_path)
"
```

### GPTQ (Alternative)

```yaml
args:
  - --model=/models/llama-3.1-70b-instruct-gptq
  - --quantization=gptq
  - --dtype=float16
  - --max-model-len=8192
  - --gpu-memory-utilization=0.90
```

## Prometheus Metrics and Monitoring

vLLM exposes a rich Prometheus endpoint at `/metrics`. Key metrics to alert on:

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `vllm:num_requests_waiting` | Requests queued for GPU scheduling | > 50 for 2 min |
| `vllm:gpu_cache_usage_perc` | KV-cache utilization (0-1) | > 0.95 |
| `vllm:num_requests_running` | Requests actively batched | Informational |
| `vllm:e2e_request_latency_seconds` | End-to-end latency | p99 > 30s |
| `vllm:time_to_first_token_seconds` | TTFT latency | p99 > 5s |
| `vllm:time_per_output_token_seconds` | Tokens per second (inverted) | Informational |

```yaml
# vllm-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vllm-alerts
  namespace: llm-serving
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: vllm.rules
      interval: 30s
      rules:
        - alert: VLLMHighQueueDepth
          expr: |
            vllm:num_requests_waiting{namespace="llm-serving"} > 50
          for: 2m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "vLLM queue depth exceeded threshold"
            description: "{{ $labels.model_name }} has {{ $value }} requests waiting"

        - alert: VLLMKVCacheExhausted
          expr: |
            vllm:gpu_cache_usage_perc{namespace="llm-serving"} > 0.95
          for: 1m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "vLLM KV-cache near exhaustion"
            description: "Cache at {{ $value | humanizePercentage }} on {{ $labels.instance }}"

        - alert: VLLMHighP99Latency
          expr: |
            histogram_quantile(0.99,
              rate(vllm:e2e_request_latency_seconds_bucket{namespace="llm-serving"}[5m])
            ) > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vLLM p99 latency above 30 seconds"
```

ServiceMonitor for Prometheus Operator:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vllm
  namespace: llm-serving
spec:
  selector:
    matchLabels:
      app: vllm
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
```

## KEDA Autoscaling on Queue Depth

KEDA scales vLLM deployments based on the `vllm:num_requests_waiting` metric sourced from Prometheus.

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.15.0
```

```yaml
# vllm-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: vllm-llama3-8b-scaler
  namespace: llm-serving
spec:
  scaleTargetRef:
    name: vllm-llama3-8b
  minReplicaCount: 1
  maxReplicaCount: 8
  cooldownPeriod: 300
  pollingInterval: 15
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 60
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
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: vllm_requests_waiting
        query: |
          sum(vllm:num_requests_waiting{namespace="llm-serving",model_name="llama-3.1-8b-instruct"})
        threshold: "20"
        activationThreshold: "5"
```

## Multi-Model Serving with a Router

For serving multiple models from a single ingress, deploy a lightweight router that proxies requests to the correct vLLM backend based on the `model` field in the request body.

```yaml
# model-router-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: model-router-config
  namespace: llm-serving
data:
  config.yaml: |
    listen: "0.0.0.0:8080"
    routes:
      - model: "llama-3.1-8b-instruct"
        upstream: "http://vllm-llama3-8b.llm-serving.svc.cluster.local"
      - model: "llama-3.1-70b-instruct"
        upstream: "http://vllm-llama3-70b.llm-serving.svc.cluster.local"
      - model: "mistral-7b-instruct"
        upstream: "http://vllm-mistral-7b.llm-serving.svc.cluster.local"
    default_model: "llama-3.1-8b-instruct"
    timeout_seconds: 120
    retry_attempts: 2
```

Alternatively, use LiteLLM Proxy which understands vLLM backends natively:

```yaml
# litellm-proxy-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: litellm-proxy
  namespace: llm-serving
spec:
  replicas: 2
  selector:
    matchLabels:
      app: litellm-proxy
  template:
    metadata:
      labels:
        app: litellm-proxy
    spec:
      containers:
        - name: litellm
          image: ghcr.io/berriai/litellm:main-v1.50.0
          args:
            - --config=/config/litellm_config.yaml
            - --port=8080
            - --num_workers=4
          volumeMounts:
            - name: config
              mountPath: /config
          resources:
            requests:
              memory: "1Gi"
              cpu: "1"
            limits:
              memory: "2Gi"
              cpu: "2"
      volumes:
        - name: config
          configMap:
            name: litellm-config
```

```yaml
# litellm-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: litellm-config
  namespace: llm-serving
data:
  litellm_config.yaml: |
    model_list:
      - model_name: llama-3.1-8b-instruct
        litellm_params:
          model: openai/llama-3.1-8b-instruct
          api_base: http://vllm-llama3-8b.llm-serving.svc.cluster.local
          api_key: "no-key-required"
      - model_name: llama-3.1-70b-instruct
        litellm_params:
          model: openai/llama-3.1-70b-instruct
          api_base: http://vllm-llama3-70b.llm-serving.svc.cluster.local
          api_key: "no-key-required"
    router_settings:
      routing_strategy: least-busy
      num_retries: 2
      timeout: 120
    general_settings:
      master_key: "sk-litellm-master-key"
```

## Ingress with Rate Limiting

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: llm-serving
  namespace: llm-serving
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/limit-rpm: "600"
    nginx.ingress.kubernetes.io/limit-connections: "50"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - llm.internal.example.com
      secretName: llm-tls
  rules:
    - host: llm.internal.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: litellm-proxy
                port:
                  name: http
```

## Pod Disruption Budget

GPU nodes often require draining for maintenance. PodDisruptionBudgets prevent all inference pods from terminating simultaneously.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: vllm-pdb
  namespace: llm-serving
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: vllm
```

## Continuous Batching Tuning Reference

PagedAttention performance is heavily dependent on the following vLLM arguments. Production-tuned defaults for an A100-80GB with Llama-3.1-8B:

| Flag | Value | Rationale |
|------|-------|-----------|
| `--max-num-seqs` | 256 | Maximum concurrent sequences in flight |
| `--max-num-batched-tokens` | 8192 | Tokens processed per scheduler step |
| `--max-paddings` | 256 | Max padding tokens per batch |
| `--gpu-memory-utilization` | 0.90 | Reserve 10% for CUDA operations and spikes |
| `--block-size` | 16 | KV-cache page size (tokens per block) |
| `--swap-space` | 4 | GB of CPU swap for preempted sequences |
| `--scheduling-policy` | fcfs | First-come-first-served (default) |
| `--enable-chunked-prefill` | (flag) | Break large prefills across steps |

## Troubleshooting

### OOM Kill on Startup

Symptom: Pod killed before serving any request.

```bash
kubectl describe pod vllm-pod-name -n llm-serving | grep -A 5 "OOMKilled"
```

Resolution: Reduce `--gpu-memory-utilization` to 0.85 or reduce `--max-model-len`.

### NCCL Timeout on Multi-GPU

Symptom: Tensor parallel ranks fail to rendezvous.

```bash
kubectl logs vllm-pod -n llm-serving | grep "NCCL"
# ncclSystemError: System call (e.g. socket, malloc) failed.
```

Resolution: Ensure pods have sufficient `/dev/shm` (EmptyDir with `medium: Memory`) and that the `NCCL_SOCKET_IFNAME` variable matches the actual network interface name.

### High Time-To-First-Token Under Load

Symptom: p99 TTFT exceeds SLA during peak traffic.

```promql
histogram_quantile(0.99,
  rate(vllm:time_to_first_token_seconds_bucket[5m])
)
```

Resolution: Enable `--enable-chunked-prefill` to prevent long prefill sequences from monopolizing the GPU during decode steps. Reduce KEDA trigger threshold to scale out sooner.

### Cache Eviction Thrashing

Symptom: `vllm:num_preemptions_total` counter increases rapidly.

Resolution: Increase `--swap-space` (CPU swap for preempted sequences) or reduce `--max-num-seqs` to prevent over-subscription.

## Security Hardening

```yaml
# SecurityContext for vLLM containers
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false  # vLLM writes temp files
  capabilities:
    drop:
      - ALL
```

API key authentication via LiteLLM proxy:

```yaml
# litellm_config.yaml (addition)
general_settings:
  master_key: "sk-litellm-master-key"
  database_url: "postgresql://litellm:password@postgres:5432/litellm"

# Team-level keys via API:
# POST /key/generate
# {"team_id": "ml-platform", "max_budget": 100, "budget_duration": "30d"}
```

## Grafana Dashboard Queries

Key dashboard panels for vLLM observability:

```promql
# Throughput: tokens generated per second
rate(vllm:generation_tokens_total{namespace="llm-serving"}[1m])

# Time to First Token P50/P90/P99
histogram_quantile(0.50, rate(vllm:time_to_first_token_seconds_bucket[5m]))
histogram_quantile(0.90, rate(vllm:time_to_first_token_seconds_bucket[5m]))
histogram_quantile(0.99, rate(vllm:time_to_first_token_seconds_bucket[5m]))

# Request success rate
rate(vllm:request_success_total[5m])
  / rate(vllm:num_requests_total[5m])

# GPU KV-cache utilization
vllm:gpu_cache_usage_perc{namespace="llm-serving"}

# Queue depth by model
vllm:num_requests_waiting{namespace="llm-serving"}
```

## Summary

A production vLLM deployment on Kubernetes requires treating the inference server as a stateful, resource-intensive application that needs the same operational rigor applied to databases. The critical elements are:

1. NVIDIA GPU Operator for driver and device plugin lifecycle management
2. Shared model storage via ReadWriteMany PVC to eliminate per-pod download overhead
3. PagedAttention and continuous batching flags tuned to the hardware profile
4. Quantization (AWQ preferred) for models that would otherwise require more GPU nodes than available
5. Prometheus alerting on queue depth, KV-cache saturation, and latency percentiles
6. KEDA autoscaling driven by `vllm:num_requests_waiting` with conservative scale-down windows
7. LiteLLM proxy for multi-model routing and API key management at the gateway layer
