---
title: "KubeAI: Open-Source LLM Inference Platform on Kubernetes"
date: 2027-03-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KubeAI", "LLM", "AI/ML", "GPU", "Inference"]
categories: ["Kubernetes", "AI/ML", "GPU"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying KubeAI for LLM inference on Kubernetes, covering Model CRD configuration, GPU scheduling, vLLM and Ollama engine backends, autoscaling from zero, OpenAI-compatible API gateway, and multi-model serving with resource isolation."
more_link: "yes"
url: "/kubeai-llm-inference-kubernetes-guide/"
---

Running large language model inference in production on Kubernetes presents a distinct set of challenges: GPU resource scheduling, cold-start latency from zero-replica deployments, model artifact caching, heterogeneous hardware support, and OpenAI API compatibility for existing tooling. KubeAI is an open-source Kubernetes-native LLM inference platform that addresses all of these concerns through a Model CRD abstraction, an inference gateway, and pluggable engine backends (vLLM, Ollama, FasterWhisper). This guide covers the full production deployment path: Helm installation, Model CRD configuration, vLLM and Ollama backends, GPU scheduling with the NVIDIA GPU Operator, autoscaling from zero via KEDA, OpenAI-compatible API usage, model caching, and a comparison with KServe and Seldon Core.

<!--more-->

## Section 1: KubeAI Architecture Overview

KubeAI consists of three primary components:

- **KubeAI Operator** — reconciles `Model` CRDs and manages the lifecycle of engine Deployments
- **Inference Gateway** — a reverse proxy that exposes an OpenAI-compatible API endpoint and routes requests to the appropriate engine pod
- **Engine Pods** — Deployment-backed pods running vLLM, Ollama, or FasterWhisper for actual inference

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Kubernetes Cluster                           │
│                                                                     │
│  Client                                                             │
│  ┌──────┐   POST /v1/chat/completions                               │
│  │ App  ├──────────────────────────────────────────────────────────▶│
│  └──────┘   (OpenAI-compatible)                                     │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Inference Gateway (Service: kubeai)             │   │
│  │              Load balances across engine replicas            │   │
│  └──────────────────────┬───────────────────────────────────────┘   │
│                         │  routes by model name                    │
│          ┌──────────────▼──────────────────────────────┐           │
│          │          Engine Pods (Deployment)            │           │
│          │                                              │           │
│          │  ┌────────────────┐  ┌────────────────────┐ │           │
│          │  │  vLLM Pod      │  │  Ollama Pod         │ │           │
│          │  │  (GPU: A100)   │  │  (GPU: L4)          │ │           │
│          │  │  llama-3-8b    │  │  mistral-7b         │ │           │
│          │  └────────────────┘  └────────────────────┘ │           │
│          └──────────────────────────────────────────────┘           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              KubeAI Operator (Deployment)                    │   │
│  │              Reconciles Model CRDs                           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              KEDA ScaledObject                               │   │
│  │              Scales engine pods based on request queue depth │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Section 2: Prerequisites and NVIDIA GPU Operator

### NVIDIA GPU Operator Installation

```bash
# Add NVIDIA Helm repository
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

# Install the GPU Operator
helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --version v24.6.2 \
  --set operator.defaultRuntime=containerd \
  --set toolkit.enabled=true \
  --set driver.enabled=true \
  --set driver.version=550.90.07

# Verify GPU nodes are available
kubectl get nodes -l nvidia.com/gpu.present=true

# Check GPU capacity on each node (iterate over GPU nodes)
for node in $(kubectl get nodes -l nvidia.com/gpu.present=true -o name); do
  echo "=== ${node} ===" && kubectl describe "${node}" | grep -A5 "Capacity:"
done
# Expected:
#   nvidia.com/gpu: 4
```

### GPU Node Labeling

```bash
# Label GPU nodes by GPU type for targeted scheduling
kubectl label node gpu-node-1 nvidia.com/gpu.product=A100-SXM4-80GB
kubectl label node gpu-node-2 nvidia.com/gpu.product=L4

# Add custom labels for KubeAI resource profiles
kubectl label node gpu-node-1 kubeai.org/resource-profile=a100-80gb
kubectl label node gpu-node-2 kubeai.org/resource-profile=l4-24gb

# Add spot instance label for cost-optimized nodes
kubectl label node gpu-node-3 node.kubernetes.io/instance-type=g5.12xlarge
kubectl label node gpu-node-3 cloud.google.com/gke-spot=true
```

## Section 3: KubeAI Helm Installation

```bash
# Add the KubeAI Helm repository
helm repo add kubeai https://www.kubeai.org
helm repo update

# Create namespace
kubectl create namespace kubeai

# Install KubeAI with production values
helm install kubeai kubeai/kubeai \
  --namespace kubeai \
  --version 0.14.0 \
  --values kubeai-values.yaml
```

### Production Helm Values

```yaml
# kubeai-values.yaml
replicaCount: 2

image:
  repository: ghcr.io/substratusai/kubeai
  tag: v0.14.0
  pullPolicy: IfNotPresent

resources:
  operator:
    limits:
      cpu: 1000m
      memory: 512Mi
    requests:
      cpu: 200m
      memory: 256Mi
  gateway:
    limits:
      cpu: 2000m
      memory: 1Gi
    requests:
      cpu: 500m
      memory: 512Mi

# Resource profiles map to node types
resourceProfiles:
  # Profile for NVIDIA A100 80GB nodes
  a100-80gb:
    nodeSelector:
      kubeai.org/resource-profile: a100-80gb
    tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
    limits:
      nvidia.com/gpu: "1"
    requests:
      nvidia.com/gpu: "1"
    cpu: "8"
    memory: "64Gi"

  # Profile for NVIDIA L4 24GB nodes
  l4-24gb:
    nodeSelector:
      kubeai.org/resource-profile: l4-24gb
    tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
    limits:
      nvidia.com/gpu: "1"
    requests:
      nvidia.com/gpu: "1"
    cpu: "4"
    memory: "32Gi"

  # Profile for multi-GPU nodes (4x A100)
  a100-80gb-4x:
    nodeSelector:
      kubeai.org/resource-profile: a100-80gb
    tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
    limits:
      nvidia.com/gpu: "4"
    requests:
      nvidia.com/gpu: "4"
    cpu: "32"
    memory: "256Gi"

  # CPU-only profile for quantized small models
  cpu-8core:
    limits:
      cpu: "8"
      memory: "32Gi"
    requests:
      cpu: "4"
      memory: "16Gi"

# Model cache storage configuration
modelCache:
  enabled: true
  storageClassName: fast-ssd
  # Shared ReadWriteMany PVC for model weights
  accessMode: ReadWriteMany
  size: 500Gi

# KEDA autoscaling configuration
autoscaling:
  enabled: true
  kedaNamespace: keda

# Prometheus metrics
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
    interval: 15s

# Gateway service configuration
gateway:
  service:
    type: ClusterIP
    port: 80
  ingress:
    enabled: true
    className: nginx
    annotations:
      nginx.ingress.kubernetes.io/ssl-redirect: "true"
      nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
      nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
      cert-manager.io/cluster-issuer: letsencrypt-prod
    hosts:
      - host: ai.platform.example.com
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: kubeai-gateway-tls
        hosts:
          - ai.platform.example.com

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```

## Section 4: Model CRD Configuration

The `Model` CRD is the primary abstraction in KubeAI. It specifies the model source, engine backend, resource profile, scaling behavior, and caching.

### vLLM Backend Model (Llama 3.1 8B)

```yaml
# model-llama3-vllm.yaml
apiVersion: kubeai.org/v1
kind: Model
metadata:
  name: llama-3.1-8b-instruct
  namespace: kubeai
  labels:
    kubeai.org/engine: vllm
    kubeai.org/team: platform
spec:
  # Model source: HuggingFace Hub path or OCI reference
  url: hf://meta-llama/Meta-Llama-3.1-8B-Instruct
  # HuggingFace token for gated model access
  huggingFaceSecretRef:
    name: huggingface-credentials
    key: token
  # Engine backend for inference
  engine: VLLM
  # Resource profile matches node label
  resourceProfile: a100-80gb
  # Min/max replicas (0 = scale to zero when idle)
  minReplicas: 0
  maxReplicas: 4
  # Target: number of pending requests per replica before scaling up
  targetRequests: 100
  # Wait up to 5 minutes for a cold-start replica to become ready
  loadBalancing:
    strategy: LeastLoad
  # vLLM-specific engine arguments
  args:
    - --max-model-len=8192
    - --max-num-seqs=64
    - --tensor-parallel-size=1
    - --gpu-memory-utilization=0.90
    - --enable-prefix-caching
    - --disable-log-requests
  # Model weight caching — reuses weights across replica restarts
  cacheProfile: fast-ssd
  # Environment variables for the engine pod
  env:
    - name: HUGGING_FACE_HUB_TOKEN
      valueFrom:
        secretKeyRef:
          name: huggingface-credentials
          key: token
    # Disable tokenizers parallelism warning
    - name: TOKENIZERS_PARALLELISM
      value: "false"
  # Liveness and readiness configuration
  livenessProbe:
    httpGet:
      path: /health
      port: 8000
    initialDelaySeconds: 120
    periodSeconds: 30
    failureThreshold: 5
  readinessProbe:
    httpGet:
      path: /health
      port: 8000
    initialDelaySeconds: 60
    periodSeconds: 15
    failureThreshold: 10
```

### vLLM Backend Model (Llama 3.1 70B — Multi-GPU Tensor Parallel)

```yaml
# model-llama3-70b-vllm.yaml
apiVersion: kubeai.org/v1
kind: Model
metadata:
  name: llama-3.1-70b-instruct
  namespace: kubeai
  labels:
    kubeai.org/engine: vllm
    kubeai.org/tier: premium
spec:
  url: hf://meta-llama/Meta-Llama-3.1-70B-Instruct
  huggingFaceSecretRef:
    name: huggingface-credentials
    key: token
  engine: VLLM
  # Multi-GPU profile: 4x A100 80GB required for 70B in BF16
  resourceProfile: a100-80gb-4x
  minReplicas: 1    # Keep at least 1 warm — 70B cold start is ~15 minutes
  maxReplicas: 2
  targetRequests: 50
  args:
    - --max-model-len=32768
    - --max-num-seqs=32
    - --tensor-parallel-size=4   # Shard across 4 GPUs
    - --gpu-memory-utilization=0.95
    - --enable-prefix-caching
    - --disable-log-requests
    - --quantization=bitsandbytes  # 4-bit quantization to fit 70B in 4x80GB
  cacheProfile: fast-ssd
  env:
    - name: HUGGING_FACE_HUB_TOKEN
      valueFrom:
        secretKeyRef:
          name: huggingface-credentials
          key: token
```

### Ollama Backend Model (Mistral 7B)

```yaml
# model-mistral-ollama.yaml
apiVersion: kubeai.org/v1
kind: Model
metadata:
  name: mistral-7b-instruct
  namespace: kubeai
  labels:
    kubeai.org/engine: ollama
    kubeai.org/team: platform
spec:
  # Ollama model tag format
  url: ollama://mistral:7b-instruct-q4_K_M
  engine: OLlama
  resourceProfile: l4-24gb
  minReplicas: 0
  maxReplicas: 6
  targetRequests: 50
  loadBalancing:
    strategy: LeastLoad
  # Ollama-specific configuration
  args:
    - --num-ctx=4096
    - --num-gpu=1
  cacheProfile: fast-ssd
```

### Embedding Model

```yaml
# model-bge-embeddings.yaml
apiVersion: kubeai.org/v1
kind: Model
metadata:
  name: bge-m3-embeddings
  namespace: kubeai
  labels:
    kubeai.org/engine: vllm
    kubeai.org/type: embedding
spec:
  url: hf://BAAI/bge-m3
  engine: VLLM
  # CPU-only for embeddings (no generation, much lighter)
  resourceProfile: cpu-8core
  minReplicas: 1    # Keep warm — embeddings are latency-sensitive
  maxReplicas: 10
  targetRequests: 500
  args:
    - --task=embed
    - --max-model-len=8192
    - --dtype=float32
```

## Section 5: GPU Scheduling with Node Selectors and Tolerations

KubeAI resource profiles automatically apply node selectors and tolerations to engine pods. The GPU Operator applies taints to GPU nodes to prevent non-GPU workloads from being scheduled on expensive GPU instances.

### GPU Node Taint Configuration

```bash
# Taint GPU nodes to reserve them for GPU workloads
kubectl taint nodes gpu-node-1 nvidia.com/gpu=present:NoSchedule
kubectl taint nodes gpu-node-2 nvidia.com/gpu=present:NoSchedule
kubectl taint nodes gpu-node-3 nvidia.com/gpu=present:NoSchedule

# Verify taints
kubectl describe node gpu-node-1 | grep -A5 "Taints:"
```

### Priority Classes for GPU Workloads

```yaml
# gpu-priority-classes.yaml
# High priority for production LLM inference — prevents eviction by batch jobs
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: llm-inference-critical
value: 1000000
globalDefault: false
description: "Priority class for production LLM inference pods"
preemptionPolicy: PreemptLowerPriority
---
# Lower priority for development/testing models
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: llm-inference-dev
value: 100000
globalDefault: false
description: "Priority class for development LLM inference pods"
preemptionPolicy: PreemptLowerPriority
```

Apply priority class to a Model:

```yaml
# model-with-priority.yaml (partial)
apiVersion: kubeai.org/v1
kind: Model
metadata:
  name: llama-3.1-8b-instruct-prod
  namespace: kubeai
spec:
  # ... (other spec fields)
  priorityClassName: llm-inference-critical
```

## Section 6: Autoscaling from Zero with KEDA

KubeAI integrates with KEDA (Kubernetes Event-Driven Autoscaler) to scale inference replicas based on pending request queue depth, including scaling to zero when idle.

### KEDA Installation

```bash
# Install KEDA
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.15.1 \
  --set resources.operator.limits.cpu=1000m \
  --set resources.operator.limits.memory=1000Mi \
  --set resources.metricServer.limits.cpu=1000m \
  --set resources.metricServer.limits.memory=1000Mi
```

### KEDA ScaledObject for KubeAI Models

KubeAI creates ScaledObjects automatically when `minReplicas: 0` is set in a Model. The ScaledObject uses a custom metrics scaler that reads from the KubeAI request queue:

```yaml
# Manual KEDA ScaledObject for fine-grained control
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: llama-3.1-8b-instruct
  namespace: kubeai
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: llama-3.1-8b-instruct
  pollingInterval: 10        # Check every 10 seconds
  cooldownPeriod: 300        # Wait 5 minutes before scaling to zero
  idleReplicaCount: 0        # Scale to zero when no requests
  minReplicaCount: 0
  maxReplicaCount: 4
  # Scale up immediately when requests arrive
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0    # Scale up immediately
          policies:
            - type: Pods
              value: 2
              periodSeconds: 60
        scaleDown:
          stabilizationWindowSeconds: 180  # Wait 3 minutes before scaling down
          policies:
            - type: Pods
              value: 1
              periodSeconds: 60
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        # Scale based on pending requests in the KubeAI gateway queue
        query: |
          sum(kubeai_model_request_active_total{model="llama-3.1-8b-instruct"})
        threshold: "100"
        # Prevent flapping: require sustained load before scaling up
        activationThreshold: "1"
```

### Cold Start Latency Management

Scale-to-zero introduces cold start latency. For Llama 3.1 8B on an A100, the model load time from a warm NVMe cache is approximately 45 seconds. Strategies to manage this:

```yaml
# kubeai-values.yaml additions for cold start management
gateway:
  # Buffer incoming requests while a cold replica starts
  requestBuffering:
    enabled: true
    maxBufferDuration: 120s    # Wait up to 2 minutes for replica to start
    maxBufferedRequests: 500

  # Return a 503 with Retry-After header if buffer is full
  fallback:
    mode: retry-after
    retryAfterSeconds: 30
```

## Section 7: OpenAI-Compatible API Usage

KubeAI exposes a fully OpenAI-compatible API. Existing applications using the OpenAI SDK require only a base URL change.

### Python OpenAI SDK

```python
# requirements.txt: openai>=1.40.0

from openai import OpenAI

# Point the OpenAI client at the KubeAI gateway
client = OpenAI(
    base_url="http://kubeai.kubeai.svc.cluster.local/openai/v1",
    # API key is not required for internal cluster access
    # but the client requires a non-empty string
    api_key="not-required-for-internal",
)

# Chat completion — same API as OpenAI
response = client.chat.completions.create(
    model="llama-3.1-8b-instruct",   # Model name matches the Model CRD name
    messages=[
        {
            "role": "system",
            "content": "You are a helpful Kubernetes operations assistant.",
        },
        {
            "role": "user",
            "content": "Explain the difference between a Deployment and a StatefulSet.",
        },
    ],
    max_tokens=512,
    temperature=0.1,
    stream=False,
)

print(response.choices[0].message.content)
print(f"Total tokens: {response.usage.total_tokens}")

# Streaming chat completion
stream = client.chat.completions.create(
    model="llama-3.1-8b-instruct",
    messages=[
        {
            "role": "user",
            "content": "Write a Kubernetes Deployment manifest for a Redis cluster.",
        }
    ],
    stream=True,
    max_tokens=1024,
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)

# Embedding generation
embedding_response = client.embeddings.create(
    model="bge-m3-embeddings",
    input=["Kubernetes operator pattern", "Custom Resource Definition lifecycle"],
)

for i, embedding in enumerate(embedding_response.data):
    print(f"Embedding {i}: dimension={len(embedding.embedding)}")
```

### Go Client

```go
// go.mod: require github.com/sashabaranov/go-openai v1.28.0

package main

import (
    "context"
    "fmt"
    "log"

    openai "github.com/sashabaranov/go-openai"
)

func main() {
    // Configure client for KubeAI gateway
    config := openai.DefaultConfig("not-required-for-internal")
    config.BaseURL = "http://kubeai.kubeai.svc.cluster.local/openai/v1"

    client := openai.NewClientWithConfig(config)

    ctx := context.Background()

    // Non-streaming completion
    resp, err := client.CreateChatCompletion(ctx,
        openai.ChatCompletionRequest{
            Model: "llama-3.1-8b-instruct",
            Messages: []openai.ChatCompletionMessage{
                {
                    Role: openai.ChatMessageRoleSystem,
                    Content: "You are a senior site reliability engineer.",
                },
                {
                    Role: openai.ChatMessageRoleUser,
                    Content: "What are the most common causes of Kubernetes pod eviction?",
                },
            },
            MaxTokens:   512,
            Temperature: 0.1,
        },
    )
    if err != nil {
        log.Fatalf("chat completion error: %v", err)
    }

    fmt.Println(resp.Choices[0].Message.Content)

    // Streaming completion
    stream, err := client.CreateChatCompletionStream(ctx,
        openai.ChatCompletionRequest{
            Model: "llama-3.1-70b-instruct",
            Messages: []openai.ChatCompletionMessage{
                {
                    Role:    openai.ChatMessageRoleUser,
                    Content: "Explain Kubernetes RBAC in detail.",
                },
            },
            MaxTokens: 2048,
            Stream:    true,
        },
    )
    if err != nil {
        log.Fatalf("streaming error: %v", err)
    }
    defer stream.Close()

    for {
        response, err := stream.Recv()
        if err != nil {
            break
        }
        fmt.Print(response.Choices[0].Delta.Content)
    }
}
```

## Section 8: Model Caching with PVC

Model weights are large (8B parameter model ≈ 16GB in BF16, 8GB in 4-bit). Loading from HuggingFace Hub on each cold start takes 5-10 minutes over a 1Gbps network. PVC-backed model caching pre-downloads weights to fast local storage.

### Cache PVC Configuration

```yaml
# model-cache-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: kubeai-model-cache
  namespace: kubeai
spec:
  accessModes:
    - ReadWriteMany   # Multiple engine pods share the cache
  storageClassName: fast-ssd-rwx   # ReadWriteMany StorageClass (e.g., NFS or Rook-Ceph RBD)
  resources:
    requests:
      storage: 500Gi
  volumeMode: Filesystem
```

### Pre-warming the Model Cache

```bash
# Pre-download model weights to the cache PVC before deployment
# Run as a Kubernetes Job:
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: prewarm-llama3-8b
  namespace: kubeai
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: downloader
          image: huggingface/transformers:latest
          command:
            - python3
            - -c
            - |
              from huggingface_hub import snapshot_download
              import os

              # Download to the shared cache PVC
              snapshot_download(
                  repo_id="meta-llama/Meta-Llama-3.1-8B-Instruct",
                  local_dir="/cache/models/meta-llama/Meta-Llama-3.1-8B-Instruct",
                  token=os.environ["HF_TOKEN"],
                  ignore_patterns=["*.bin"],   # Skip .bin, use .safetensors only
              )
              print("Model downloaded successfully")
          env:
            - name: HF_TOKEN
              valueFrom:
                secretKeyRef:
                  name: huggingface-credentials
                  key: token
          volumeMounts:
            - name: model-cache
              mountPath: /cache
          resources:
            limits:
              cpu: "4"
              memory: "8Gi"
            requests:
              cpu: "2"
              memory: "4Gi"
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: kubeai-model-cache
EOF
```

### Model Cache Profile in Helm Values

```yaml
# kubeai-values.yaml — cache profile configuration
modelCacheProfiles:
  fast-ssd:
    # Mount the shared model cache PVC into engine pods
    volumes:
      - name: model-cache
        persistentVolumeClaim:
          claimName: kubeai-model-cache
    volumeMounts:
      - name: model-cache
        mountPath: /root/.cache/huggingface
    # Point HuggingFace Hub to the cached location
    env:
      - name: HF_HOME
        value: /root/.cache/huggingface
      - name: TRANSFORMERS_CACHE
        value: /root/.cache/huggingface/transformers
```

## Section 9: Request Batching Configuration

vLLM handles request batching internally through continuous batching. The key parameters controlling throughput vs. latency tradeoffs are:

```yaml
# Model CRD vLLM batching configuration
apiVersion: kubeai.org/v1
kind: Model
metadata:
  name: llama-3.1-8b-instruct-high-throughput
  namespace: kubeai
spec:
  url: hf://meta-llama/Meta-Llama-3.1-8B-Instruct
  engine: VLLM
  resourceProfile: a100-80gb
  minReplicas: 1
  maxReplicas: 4
  targetRequests: 200
  args:
    # Maximum context length — larger allows longer prompts but uses more memory
    - --max-model-len=8192
    # Maximum concurrent sequences being processed
    # Higher = more throughput, higher latency per request
    - --max-num-seqs=128
    # Maximum tokens that can be processed in a single forward pass
    - --max-num-batched-tokens=32768
    # GPU utilization target — 0.95 is aggressive but effective for throughput
    - --gpu-memory-utilization=0.95
    # Enable chunked prefill for large prompts
    - --enable-chunked-prefill
    # Prefix caching for repeated system prompts
    - --enable-prefix-caching
    # Speculative decoding for latency reduction (requires a draft model)
    # - --speculative-model=meta-llama/Meta-Llama-3.2-1B
    # - --num-speculative-tokens=5
    - --disable-log-requests
    - --served-model-name
    - llama-3.1-8b-instruct
  huggingFaceSecretRef:
    name: huggingface-credentials
    key: token
  cacheProfile: fast-ssd
```

## Section 10: Multi-Model Serving with Resource Isolation

Running multiple models on the same cluster requires careful resource isolation to prevent one model's load from starving others.

### Namespace Isolation per Team

```yaml
# namespace-isolation.yaml
# Each team gets a dedicated namespace with resource quotas
apiVersion: v1
kind: Namespace
metadata:
  name: kubeai-team-backend
  labels:
    kubeai.org/tenant: backend-team
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: kubeai-team-backend
spec:
  hard:
    requests.nvidia.com/gpu: "4"    # Max 4 GPUs for this team
    limits.nvidia.com/gpu: "4"
    requests.cpu: "32"
    requests.memory: "256Gi"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: container-defaults
  namespace: kubeai-team-backend
spec:
  limits:
    - type: Container
      default:
        cpu: "4"
        memory: "32Gi"
      defaultRequest:
        cpu: "1"
        memory: "8Gi"
      max:
        cpu: "16"
        memory: "128Gi"
```

### Network Policy for Model Isolation

```yaml
# model-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: llm-model-isolation
  namespace: kubeai
spec:
  # Apply to all engine pods
  podSelector:
    matchLabels:
      kubeai.org/engine: vllm
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Only allow traffic from the KubeAI gateway
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: kubeai-gateway
      ports:
        - port: 8000   # vLLM default port
  egress:
    # Allow access to the HuggingFace CDN for model downloads
    - ports:
        - port: 443
    # Allow access to the model cache PVC (via NFS if applicable)
    - ports:
        - port: 2049   # NFS
    # Allow DNS
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
```

## Section 11: Prometheus Metrics for Inference Observability

### Available Metrics

KubeAI exports Prometheus metrics from both the operator and engine pods.

```
# HELP kubeai_model_request_active_total Active requests per model
# TYPE kubeai_model_request_active_total gauge
kubeai_model_request_active_total{model="llama-3.1-8b-instruct"} 12
kubeai_model_request_active_total{model="mistral-7b-instruct"} 3

# HELP kubeai_model_request_total Total requests processed
# TYPE kubeai_model_request_total counter
kubeai_model_request_total{model="llama-3.1-8b-instruct",status="success"} 45821
kubeai_model_request_total{model="llama-3.1-8b-instruct",status="error"} 23

# HELP vllm_request_success_total Total successfully processed vLLM requests
# TYPE vllm_request_success_total counter
vllm_request_success_total{model="llama-3.1-8b-instruct"} 45821

# HELP vllm_request_generation_tokens_total Total tokens generated
# TYPE vllm_request_generation_tokens_total counter
vllm_request_generation_tokens_total{model="llama-3.1-8b-instruct"} 23451890

# HELP vllm_e2e_request_latency_seconds End-to-end request latency
# TYPE vllm_e2e_request_latency_seconds histogram
vllm_e2e_request_latency_seconds_bucket{model="llama-3.1-8b-instruct",le="1.0"} 12301
vllm_e2e_request_latency_seconds_bucket{model="llama-3.1-8b-instruct",le="5.0"} 44892

# HELP vllm_gpu_cache_usage_perc GPU KV cache utilization
# TYPE vllm_gpu_cache_usage_perc gauge
vllm_gpu_cache_usage_perc{model="llama-3.1-8b-instruct"} 72.4

# HELP vllm_num_requests_running Currently running requests in vLLM
# TYPE vllm_num_requests_running gauge
vllm_num_requests_running{model="llama-3.1-8b-instruct"} 24

# HELP vllm_num_requests_waiting Requests waiting in vLLM queue
# TYPE vllm_num_requests_waiting gauge
vllm_num_requests_waiting{model="llama-3.1-8b-instruct"} 8
```

### Grafana Dashboard Queries

```promql
# Tokens generated per second (throughput)
rate(vllm_request_generation_tokens_total[1m])

# Time-to-first-token (TTFT) approximation
histogram_quantile(0.99,
  rate(vllm_time_to_first_token_seconds_bucket[5m])
)

# Inter-token latency (generation speed)
histogram_quantile(0.95,
  rate(vllm_time_per_output_token_seconds_bucket[5m])
)

# End-to-end latency (p50, p95, p99)
histogram_quantile(0.95,
  rate(vllm_e2e_request_latency_seconds_bucket[5m])
)

# GPU KV cache utilization (alert if > 85%)
vllm_gpu_cache_usage_perc

# Request queue depth (used by KEDA for scaling)
sum by (model) (vllm_num_requests_waiting)

# Error rate by model
rate(kubeai_model_request_total{status="error"}[5m])
/
rate(kubeai_model_request_total[5m])

# Active replicas per model
count by (model) (kube_pod_status_ready{namespace="kubeai", condition="true"})
```

### PrometheusRule for LLM Alerting

```yaml
# kubeai-alerting-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubeai-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: kubeai.rules
      interval: 30s
      rules:
        - alert: LLMHighRequestQueueDepth
          expr: sum by (model) (vllm_num_requests_waiting) > 50
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High request queue depth for model {{ $labels.model }}"
            description: "{{ $value }} requests waiting in queue. Consider scaling replicas or increasing maxReplicas."

        - alert: LLMHighGPUCacheUtilization
          expr: vllm_gpu_cache_usage_perc > 90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU KV cache nearly full for {{ $labels.model }}"
            description: "KV cache at {{ $value }}%. Reduce max-model-len or max-num-seqs to free capacity."

        - alert: LLMHighEndToEndLatency
          expr: |
            histogram_quantile(0.95,
              rate(vllm_e2e_request_latency_seconds_bucket[5m])
            ) > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High p95 inference latency for {{ $labels.model }}"
            description: "p95 latency is {{ $value | humanizeDuration }}. SLA breach likely."

        - alert: LLMModelNoPods
          expr: |
            kubeai_model_info{min_replicas!="0"}
            unless
            count by (model) (kube_pod_status_ready{namespace="kubeai", condition="true"}) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "No ready pods for model {{ $labels.model }}"
            description: "Model {{ $labels.model }} has min_replicas > 0 but no pods are ready."
```

## Section 12: KubeAI vs KServe vs Seldon Core Comparison

| Feature | KubeAI | KServe | Seldon Core v2 |
|---|---|---|---|
| LLM-first design | Yes | Partial | No |
| OpenAI API compatibility | Native | Via Triton adapter | Via custom serving runtime |
| Scale to zero | Yes (KEDA) | Yes | Yes |
| vLLM support | Native | Via custom ServingRuntime | Via custom ServingRuntime |
| Ollama support | Native | No | No |
| GPU multi-tenancy | Via resource profiles | Via InferenceService | Via SeldonDeployment |
| Model caching | Built-in PVC | Via StorageInitializer | Via Model Mesh |
| Multi-framework | LLM-focused | Full (TF, PyTorch, XGBoost) | Full |
| CNCF project | No | Yes (Incubating) | No |
| Primary use case | LLM serving | General ML serving | General ML serving |
| Complexity | Low | Medium | High |
| Production maturity | Early (v0.x) | High | High |

**Choose KubeAI when:** the primary workload is LLM chat/completion/embedding inference, OpenAI API compatibility is required, and operational simplicity is a priority. The Model CRD abstraction hides vLLM complexity effectively.

**Choose KServe when:** the workload includes traditional ML models (classification, regression, recommendation) alongside LLMs, or when CNCF project status is a governance requirement.

**Choose Seldon Core when:** sophisticated A/B testing, shadow deployments, and model explanation pipelines are needed in a mature enterprise ML platform.

## Section 13: Production Recommendations

**GPU Utilization Monitoring:** Monitor `vllm_gpu_cache_usage_perc` continuously. A KV cache above 90% causes request rejections or severe latency spikes. Tune `--gpu-memory-utilization` and `--max-num-seqs` based on observed usage patterns for each model.

**Model Version Management:** Pin model versions using commit SHAs rather than branch names in HuggingFace Hub URLs (e.g., `hf://meta-llama/Meta-Llama-3.1-8B-Instruct@abc1234` rather than `hf://meta-llama/Meta-Llama-3.1-8B-Instruct`). Model updates from HuggingFace can change behavior in ways that are difficult to diagnose after the fact.

**Cold Start SLA:** Document the cold start time for each model in the service catalog and set `cooldownPeriod` on KEDA ScaledObjects accordingly. A 70B parameter model may take 15 minutes to become ready from zero — this is unacceptable for latency-sensitive applications. Keep at least `minReplicas: 1` for any model with a p95 SLA below 30 seconds.

**Resource Overcommit:** GPU memory cannot be overcommitted. Ensure the sum of all `--gpu-memory-utilization` values for models scheduled to the same GPU never exceeds 1.0. Use dedicated GPU node pools with anti-affinity rules to prevent multiple high-memory models from being co-located.

**API Key Management:** Even for internal cluster traffic, implement API key authentication at the gateway layer to enable per-team usage tracking and rate limiting. Store keys in Kubernetes Secrets and rotate them quarterly.
