---
title: "Gateway API Inference Extension: LLM Traffic Management on Kubernetes"
date: 2027-02-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Gateway API", "LLM", "AI/ML", "Inference"]
categories: ["Kubernetes", "AI/ML", "Networking"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to the Gateway API Inference Extension for Kubernetes, covering InferenceModel and InferencePool CRDs, model-aware routing, prefix cache affinity, LoRA adapter routing, queue-depth-aware load balancing, vLLM integration, and production observability for LLM inference workloads."
more_link: "yes"
url: "/gateway-api-inference-extension-llm-routing-kubernetes-guide/"
---

**Gateway API Inference Extension (GIE)** is a Kubernetes SIG-Network project that extends the Gateway API with inference-specific routing primitives for large language model (LLM) workloads. Standard HTTP load balancing is poorly suited to LLM serving: requests vary dramatically in token length, backends maintain KV-caches that benefit from request affinity, and LoRA adapters are loaded per model variant. GIE introduces `InferenceModel` and `InferencePool` CRDs that give the data plane — backed by EnvoyProxy — the model-layer information needed to make intelligent routing decisions: prefix cache affinity, LoRA adapter colocation, queue depth, and per-model traffic policies. This guide covers the full GIE stack from installation through production A/B testing and observability.

<!--more-->

## Why Standard Load Balancing Falls Short for LLM Inference

Standard HTTP round-robin routing causes several problems for LLM backends:

- **KV-cache cold misses**: Each request to a new backend must recompute the KV-cache for the prompt prefix, adding hundreds of milliseconds of latency
- **LoRA adapter thrashing**: A backend serving one LoRA adapter cannot switch instantly to another; routing requests to a backend that already has the correct adapter loaded eliminates swap overhead
- **Queue depth imbalance**: LLM requests are long-lived (seconds to minutes); a backend with a full request queue should receive no new traffic until it drains
- **Time-to-first-token (TTFT) variance**: Without queue depth awareness, TTFT can vary by orders of magnitude on a loaded backend
- **A/B testing complexity**: Model version comparisons need model-name-based routing, not just URL path routing

GIE solves all of these at the gateway layer by exposing model metadata to the routing algorithm.

## Architecture

```
External Request
  │  (POST /v1/chat/completions  body: {"model": "llama-3-8b-instruct", ...})
  ▼
Gateway (EnvoyProxy / GIE-enabled Envoy)
  │
  ├── InferenceModel: "llama-3-8b-instruct"  ─► InferencePool: "llama-3-8b-pool"
  │     routing policy: prefix-cache-affinity
  │     critical-threshold-per-model: 0.8
  │
  ▼
Endpoint Selection (GIE Scheduling Extension)
  ├── Filter: pods in InferencePool with model loaded
  ├── Score:  prefix cache hit probability (shared prefix hash)
  ├── Score:  queue depth (lower = better)
  ├── Score:  LoRA adapter already loaded
  └── Select: best scoring pod
  │
  ▼
vLLM / llama.cpp Pod
  • daprd sidecar (optional, for Dapr-based pub/sub)
  • Prometheus metrics: gpu_cache_usage, num_requests_waiting, lora_requests_info
```

The **GIE Scheduling Extension** is an Envoy External Processing (ExtProc) service that intercepts each request, reads the `model` field from the JSON request body, queries the InferencePool's endpoint health data, and returns a routing decision to Envoy before the request is forwarded to a backend.

## Installation

### Prerequisites

```bash
# Install cert-manager (required for GIE webhook TLS)
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true \
  --wait

# Install Gateway API CRDs (v1.1+)
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/experimental-install.yaml
```

### Installing the Gateway API Inference Extension

```bash
#!/bin/bash
set -euo pipefail

GIE_VERSION="v0.3.0"

# Install GIE CRDs and controller
kubectl apply -f "https://github.com/kubernetes-sigs/gateway-api-inference-extension/releases/download/${GIE_VERSION}/manifests.yaml"

# Verify CRDs are installed
kubectl get crd inferencemodels.inference.networking.x-k8s.io
kubectl get crd inferencepools.inference.networking.x-k8s.io

# Check the GIE controller is running
kubectl get pods -n gateway-api-inference-extension-system

echo "GIE installed"
```

### Installing EnvoyProxy as the Gateway

```bash
# Install Envoy Gateway (the GIE-compatible data plane)
helm upgrade --install envoy-gateway oci://docker.io/envoyproxy/gateway-helm \
  --version v1.1.0 \
  --namespace envoy-gateway-system \
  --create-namespace \
  --wait

# Create a GatewayClass backed by Envoy Gateway
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: inference-gateway-class
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
  parametersRef:
    group: gateway.envoyproxy.io
    kind: EnvoyProxy
    name: inference-proxy-config
    namespace: inference-system
EOF
```

## Deploying vLLM Backends

```yaml
# Deployment — vLLM serving llama-3-8b with multiple LoRA adapters
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama-3-8b
  namespace: inference-system
  labels:
    app: vllm-llama-3-8b
    model: llama-3-8b-instruct
spec:
  replicas: 4
  selector:
    matchLabels:
      app: vllm-llama-3-8b
  template:
    metadata:
      labels:
        app: vllm-llama-3-8b
        model: llama-3-8b-instruct
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8000"
        prometheus.io/path: "/metrics"
    spec:
      nodeSelector:
        nvidia.com/gpu.present: "true"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.6.0
          args:
            - --model
            - /models/llama-3-8b-instruct
            - --served-model-name
            - llama-3-8b-instruct
            - --max-model-len
            - "8192"
            - --tensor-parallel-size
            - "1"
            - --gpu-memory-utilization
            - "0.85"
            - --enable-lora
            - --max-loras
            - "4"
            - --max-cpu-loras
            - "8"
            - --lora-modules
            - "sql-adapter=/models/loras/sql-adapter"
            - "code-adapter=/models/loras/code-adapter"
            - --port
            - "8000"
            - --disable-log-requests
            - --enable-prefix-caching
            - --block-size
            - "32"
          ports:
            - name: http
              containerPort: 8000
            - name: metrics
              containerPort: 8000
          env:
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
            - name: HF_HUB_OFFLINE
              value: "1"
          resources:
            limits:
              nvidia.com/gpu: "1"
              memory: 48Gi
              cpu: "8"
            requests:
              nvidia.com/gpu: "1"
              memory: 32Gi
              cpu: "4"
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 120
            periodSeconds: 10
            failureThreshold: 30
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 180
            periodSeconds: 20
          volumeMounts:
            - name: model-storage
              mountPath: /models
              readOnly: true
            - name: shm
              mountPath: /dev/shm
      volumes:
        - name: model-storage
          persistentVolumeClaim:
            claimName: model-storage-pvc
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: 16Gi
---
# Service for the vLLM pool
apiVersion: v1
kind: Service
metadata:
  name: vllm-llama-3-8b
  namespace: inference-system
  labels:
    app: vllm-llama-3-8b
spec:
  selector:
    app: vllm-llama-3-8b
  ports:
    - name: http
      port: 8000
      targetPort: 8000
  type: ClusterIP
```

## InferencePool and InferenceModel CRDs

### InferencePool

An **InferencePool** represents a group of backend pods serving one or more models. It defines how the GIE scheduling extension discovers endpoints and which health metrics it reads.

```yaml
# InferencePool — group of vLLM pods serving llama-3-8b variants
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferencePool
metadata:
  name: llama-3-8b-pool
  namespace: inference-system
spec:
  targetPortNumber: 8000
  selector:
    matchLabels:
      app: vllm-llama-3-8b

  # Endpoint picker extension — the ExtProc service doing intelligent routing
  extensionRef:
    name: gie-scheduler
    namespace: inference-system
    kind: Service
    portNumber: 9002

  # Health check configuration — GIE reads these Prometheus metrics from each pod
  healthCheck:
    healthCheckPolicy:
      # Mark a pod as saturated when queue depth exceeds this threshold
      maxPendingRequests: 32
```

### InferenceModel

An **InferenceModel** maps a model name (as sent in the OpenAI-compatible `"model"` field) to a pool and defines traffic policy for that model.

```yaml
# InferenceModel — production llama-3-8b-instruct model
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: llama-3-8b-instruct
  namespace: inference-system
spec:
  modelName: llama-3-8b-instruct
  criticality: Critical
  poolRef:
    name: llama-3-8b-pool

  # Target model name on the backend (can differ from the external name)
  targetModels:
    - name: llama-3-8b-instruct
      weight: 100
---
# InferenceModel — canary model version for A/B testing
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: llama-3-8b-instruct-canary
  namespace: inference-system
spec:
  modelName: llama-3-8b-instruct-canary
  criticality: Standard
  poolRef:
    name: llama-3-8b-canary-pool

  # Route 90% to the fine-tuned v2 and 10% to the baseline for comparison
  targetModels:
    - name: llama-3-8b-instruct-v2
      weight: 90
    - name: llama-3-8b-instruct
      weight: 10
---
# InferenceModel — sql-adapter LoRA variant
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: llama-3-8b-sql
  namespace: inference-system
spec:
  modelName: llama-3-8b-sql
  criticality: Standard
  poolRef:
    name: llama-3-8b-pool
  # GIE will prefer pods that already have sql-adapter loaded in GPU memory
  targetModels:
    - name: sql-adapter
      weight: 100
```

### Gateway and HTTPRoute

```yaml
# Gateway — the EnvoyProxy Gateway handling inference traffic
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: inference-gateway
  namespace: inference-system
spec:
  gatewayClassName: inference-gateway-class
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Same
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: inference-tls
      allowedRoutes:
        namespaces:
          from: Same
---
# HTTPRoute — route all /v1/* requests to the inference extension
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: inference-route
  namespace: inference-system
spec:
  parentRefs:
    - name: inference-gateway
      sectionName: https
  hostnames:
    - "inference.example.com"
  rules:
    # Chat completions
    - matches:
        - path:
            type: PathPrefix
            value: /v1/chat/completions
      backendRefs:
        - group: inference.networking.x-k8s.io
          kind: InferencePool
          name: llama-3-8b-pool
          port: 8000
    # Completions
    - matches:
        - path:
            type: PathPrefix
            value: /v1/completions
      backendRefs:
        - group: inference.networking.x-k8s.io
          kind: InferencePool
          name: llama-3-8b-pool
          port: 8000
    # Embeddings routed to a separate embeddings pool
    - matches:
        - path:
            type: PathPrefix
            value: /v1/embeddings
      backendRefs:
        - group: inference.networking.x-k8s.io
          kind: InferencePool
          name: embedding-pool
          port: 8000
    # Model listing
    - matches:
        - path:
            type: PathPrefix
            value: /v1/models
      backendRefs:
        - name: vllm-llama-3-8b
          port: 8000
```

## GIE Scheduling Extension Configuration

The scheduling extension is a gRPC ExtProc service deployed alongside the gateway. It reads per-pod metrics and implements the routing algorithm.

```yaml
# Deployment — GIE scheduling extension
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gie-scheduler
  namespace: inference-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: gie-scheduler
  template:
    metadata:
      labels:
        app: gie-scheduler
    spec:
      serviceAccountName: gie-scheduler
      containers:
        - name: scheduler
          image: registry.k8s.io/gateway-api-inference-extension/epp:v0.3.0
          args:
            - --zap-log-level=info
            - --port=9002
            - --grpc-port=9003
            - --pool-name=llama-3-8b-pool
            - --pool-namespace=inference-system
            - --target-port=8000
            # Prefix cache affinity weight
            - --prefix-cache-weight=3
            # Queue depth weight
            - --queue-depth-weight=2
            # LoRA adapter affinity weight
            - --lora-affinity-weight=4
            # Maximum queue depth before a pod is considered saturated
            - --max-queue-depth=32
            # Metrics scrape interval
            - --metrics-collection-interval=5s
          ports:
            - name: grpc
              containerPort: 9002
            - name: http
              containerPort: 9003
            - name: metrics
              containerPort: 9090
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 9003
            initialDelaySeconds: 5
            periodSeconds: 5
---
# Service for the scheduler ExtProc endpoint
apiVersion: v1
kind: Service
metadata:
  name: gie-scheduler
  namespace: inference-system
spec:
  selector:
    app: gie-scheduler
  ports:
    - name: grpc
      port: 9002
      targetPort: 9002
    - name: http
      port: 9003
      targetPort: 9003
    - name: metrics
      port: 9090
      targetPort: 9090
---
# RBAC for the scheduler to read pod metrics and endpoints
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: gie-scheduler
rules:
  - apiGroups: [""]
    resources: ["pods", "endpoints", "services"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["inference.networking.x-k8s.io"]
    resources: ["inferencepools", "inferencemodels"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: gie-scheduler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: gie-scheduler
subjects:
  - kind: ServiceAccount
    name: gie-scheduler
    namespace: inference-system
```

## Prefix Cache Affinity in Practice

vLLM's automatic prefix caching (APC) stores computed KV-cache blocks indexed by a rolling hash of the token sequence. GIE exploits this by computing the same rolling hash from the request body and preferring backends where that prefix hash already exists in the GPU cache.

```bash
# Test prefix cache hit rate
# Send the same system prompt repeatedly to verify affinity

GATEWAY="https://inference.example.com"

# Request 1 — cold start, no cache
time curl -s "${GATEWAY}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3-8b-instruct",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant specialized in Kubernetes troubleshooting."},
      {"role": "user", "content": "What causes OOMKilled pods?"}
    ],
    "max_tokens": 256
  }' | python3 -m json.tool | grep -E "id|usage|total_tokens"

# Request 2 — same system prompt, should hit cache on same pod
time curl -s "${GATEWAY}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3-8b-instruct",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant specialized in Kubernetes troubleshooting."},
      {"role": "user", "content": "How do I debug CrashLoopBackOff?"}
    ],
    "max_tokens": 256
  }' | python3 -m json.tool | grep -E "id|usage|total_tokens"
```

## LoRA Adapter Routing

When a request specifies the `llama-3-8b-sql` model name, GIE scores backends by whether the `sql-adapter` LoRA is already active in GPU memory. vLLM exposes this via its `/metrics` endpoint.

```bash
# Check which LoRA adapters are loaded on each pod
for pod in $(kubectl get pods -n inference-system -l app=vllm-llama-3-8b -o name); do
  echo "=== ${pod} ==="
  kubectl exec -n inference-system "${pod}" -- \
    curl -s localhost:8000/metrics | grep -i "lora\|adapter"
done

# Send a LoRA-specific request
curl -s "https://inference.example.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3-8b-sql",
    "messages": [
      {"role": "user", "content": "Write a SQL query to find the top 10 customers by revenue in the last 30 days."}
    ],
    "max_tokens": 512
  }' | python3 -m json.tool
```

## Queue Depth Awareness

GIE reads `vllm:num_requests_waiting` from each pod's Prometheus metrics. When a pod's waiting queue exceeds the configured `maxPendingRequests` threshold, GIE marks it as saturated and will not route new requests to it unless all pods in the pool are saturated (in which case the least-saturated pod is chosen).

```bash
# Monitor queue depth across all inference pods
watch -n 2 'kubectl exec -n inference-system ds/ztunnel -- \
  curl -s "http://vllm-llama-3-8b.inference-system.svc.cluster.local:8000/metrics" | \
  grep "num_requests_waiting\|gpu_cache_usage_perc\|num_requests_running"'
```

## Observability: Token Throughput and TTFT Metrics

```yaml
# ServiceMonitor for vLLM pods
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vllm-metrics
  namespace: monitoring
  labels:
    release: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - inference-system
  selector:
    matchLabels:
      app: vllm-llama-3-8b
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_pod_label_model]
          targetLabel: model
---
# ServiceMonitor for GIE scheduler
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: gie-scheduler-metrics
  namespace: monitoring
  labels:
    release: kube-prometheus
spec:
  namespaceSelector:
    matchNames:
      - inference-system
  selector:
    matchLabels:
      app: gie-scheduler
  endpoints:
    - port: metrics
      path: /metrics
      interval: 15s
```

Key PromQL queries for LLM inference observability:

```promql
# Time to first token (TTFT) p50 / p99
histogram_quantile(0.50,
  sum(rate(vllm:time_to_first_token_seconds_bucket{namespace="inference-system"}[5m]))
  by (model_name, le)
)

histogram_quantile(0.99,
  sum(rate(vllm:time_to_first_token_seconds_bucket{namespace="inference-system"}[5m]))
  by (model_name, le)
)

# Token throughput (tokens per second)
sum(rate(vllm:generation_tokens_total{namespace="inference-system"}[1m]))
by (model_name, pod)

# GPU KV-cache utilization per pod
avg(vllm:gpu_cache_usage_perc{namespace="inference-system"})
by (pod, model_name)

# Queue depth across all inference pods
sum(vllm:num_requests_waiting{namespace="inference-system"})
by (pod, model_name)

# Prefix cache hit rate (from GIE scheduler metrics)
sum(rate(gie_prefix_cache_hits_total{namespace="inference-system"}[5m])) /
sum(rate(gie_routing_decisions_total{namespace="inference-system"}[5m]))

# LoRA adapter routing affinity hit rate
sum(rate(gie_lora_affinity_hits_total{namespace="inference-system"}[5m])) /
sum(rate(gie_routing_decisions_total{namespace="inference-system"}[5m]))

# Request rate per model
sum(rate(vllm:request_success_total{namespace="inference-system"}[1m]))
by (model_name)
```

## A/B Testing Between Model Versions

```yaml
# InferenceModel — split traffic between two fine-tuned versions
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: llama-3-8b-instruct-ab
  namespace: inference-system
spec:
  modelName: llama-3-8b-instruct
  criticality: Standard
  poolRef:
    name: llama-3-8b-pool
  targetModels:
    # 80% to the stable fine-tune
    - name: llama-3-8b-instruct-v2-stable
      weight: 80
    # 20% to the experimental fine-tune
    - name: llama-3-8b-instruct-v2-exp
      weight: 20
```

```bash
# Measure TTFT difference between model versions during A/B test
# Using the GIE metrics to separate by targetModel

# Version A TTFT p99
kubectl exec -n monitoring deploy/prometheus -- \
  promtool query instant http://localhost:9090 \
  'histogram_quantile(0.99, sum(rate(vllm:time_to_first_token_seconds_bucket{model_name="llama-3-8b-instruct-v2-stable"}[15m])) by (le))'

# Version B TTFT p99
kubectl exec -n monitoring deploy/prometheus -- \
  promtool query instant http://localhost:9090 \
  'histogram_quantile(0.99, sum(rate(vllm:time_to_first_token_seconds_bucket{model_name="llama-3-8b-instruct-v2-exp"}[15m])) by (le))'
```

## Production Deployment Patterns

### Model Storage with PVC and Node-Local Caching

```yaml
# PersistentVolumeClaim for model weights
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: model-storage-pvc
  namespace: inference-system
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: efs-sc
  resources:
    requests:
      storage: 500Gi
---
# DaemonSet to pre-warm local model cache on GPU nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: model-cache-warmer
  namespace: inference-system
spec:
  selector:
    matchLabels:
      app: model-cache-warmer
  template:
    metadata:
      labels:
        app: model-cache-warmer
    spec:
      nodeSelector:
        nvidia.com/gpu.present: "true"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      initContainers:
        - name: cache-warmer
          image: registry.example.com/model-cache-warmer:1.0.0
          command:
            - /bin/sh
            - -c
            - |
              rsync -av --inplace /models-nfs/llama-3-8b-instruct/ /models-local/llama-3-8b-instruct/
          volumeMounts:
            - name: models-nfs
              mountPath: /models-nfs
              readOnly: true
            - name: models-local
              mountPath: /models-local
      containers:
        - name: keep-alive
          image: registry.example.com/model-cache-warmer:1.0.0
          command: ["sleep", "infinity"]
      volumes:
        - name: models-nfs
          persistentVolumeClaim:
            claimName: model-storage-pvc
        - name: models-local
          hostPath:
            path: /mnt/local-nvme/models
            type: DirectoryOrCreate
```

### HPA for Inference Pods Based on Queue Depth

```yaml
# HPA — scale vLLM pods based on GPU queue depth
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: vllm-llama-3-8b
  namespace: inference-system
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: vllm-llama-3-8b
  minReplicas: 2
  maxReplicas: 8
  metrics:
    - type: Pods
      pods:
        metric:
          name: vllm_num_requests_waiting
        target:
          type: AverageValue
          averageValue: "8"
  behavior:
    scaleUp:
      # Scale up quickly to handle bursts
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
    scaleDown:
      # Scale down slowly to avoid disrupting in-flight requests
      stabilizationWindowSeconds: 600
      policies:
        - type: Pods
          value: 1
          periodSeconds: 300
```

## Multi-Model Gateway: Routing Multiple Model Families

A single Gateway can front multiple InferencePools serving different model families, enabling a unified API endpoint for heterogeneous inference infrastructure.

```yaml
# InferencePool — embedding model pool
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferencePool
metadata:
  name: embedding-pool
  namespace: inference-system
spec:
  targetPortNumber: 8000
  selector:
    matchLabels:
      app: vllm-embeddings
  extensionRef:
    name: gie-scheduler-embeddings
    namespace: inference-system
    kind: Service
    portNumber: 9002
  healthCheck:
    healthCheckPolicy:
      maxPendingRequests: 64
---
# InferenceModel — text-embedding-3-large (compatible API name)
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: text-embedding-3-large
  namespace: inference-system
spec:
  modelName: text-embedding-3-large
  criticality: Standard
  poolRef:
    name: embedding-pool
  targetModels:
    - name: nomic-embed-text-v1.5
      weight: 100
---
# InferencePool — code generation pool (separate GPU class)
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferencePool
metadata:
  name: codegen-pool
  namespace: inference-system
spec:
  targetPortNumber: 8000
  selector:
    matchLabels:
      app: vllm-codegen
  extensionRef:
    name: gie-scheduler-codegen
    namespace: inference-system
    kind: Service
    portNumber: 9002
  healthCheck:
    healthCheckPolicy:
      maxPendingRequests: 16
---
# InferenceModel — code generation model
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: codestral-22b
  namespace: inference-system
spec:
  modelName: codestral-22b
  criticality: Critical
  poolRef:
    name: codegen-pool
  targetModels:
    - name: codestral-22b-v0.1
      weight: 100
---
# HTTPRoute — unified model gateway routing to different pools by model context
# (routing is done at the ExtProc level based on request body "model" field,
#  not at the HTTPRoute level — all routes point to the ExtProc-enabled pools)
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: multi-model-route
  namespace: inference-system
spec:
  parentRefs:
    - name: inference-gateway
      sectionName: https
  hostnames:
    - "inference.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1/
      backendRefs:
        # All /v1/ traffic goes through the GIE dispatcher which
        # maps the "model" field in the request body to the correct pool
        - group: inference.networking.x-k8s.io
          kind: InferencePool
          name: llama-3-8b-pool
          port: 8000
```

## Rate Limiting and Request Prioritization

GIE's `criticality` field on `InferenceModel` enables differentiated handling when the pool is under pressure.

```yaml
# High-criticality model — interactive user-facing requests
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: llama-3-8b-interactive
  namespace: inference-system
spec:
  modelName: llama-3-8b-instruct
  criticality: Critical    # Never shed; queue if needed
  poolRef:
    name: llama-3-8b-pool
  targetModels:
    - name: llama-3-8b-instruct
      weight: 100
---
# Low-criticality model — batch/background processing
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferenceModel
metadata:
  name: llama-3-8b-batch
  namespace: inference-system
spec:
  modelName: llama-3-8b-instruct-batch
  criticality: Sheddable   # Drop requests when pool is saturated
  poolRef:
    name: llama-3-8b-pool
  targetModels:
    - name: llama-3-8b-instruct
      weight: 100
```

When the pool's queue depth exceeds `maxPendingRequests`, GIE will:
1. Reject `Sheddable` requests with HTTP 429 immediately
2. Queue `Standard` requests until a pod becomes available
3. Always accept `Critical` requests (routing to the least-loaded pod)

This tiered approach ensures interactive latency SLOs are met even when background batch jobs saturate the GPU fleet.

## Security: Authentication at the Gateway

```yaml
# SecurityPolicy — require API key for all inference requests
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: SecurityPolicy
metadata:
  name: inference-api-auth
  namespace: inference-system
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: inference-route
  apiKeyAuth:
    extractFrom:
      - headers:
          - name: Authorization
            valuePrefix: "Bearer "
      - headers:
          - name: X-API-Key
    credentialRefs:
      - kind: Secret
        name: inference-api-keys
        namespace: inference-system
---
# Secret — API key registry
# Keys are stored as key=value where key is the principal identifier
apiVersion: v1
kind: Secret
metadata:
  name: inference-api-keys
  namespace: inference-system
type: Opaque
stringData:
  # Format: "principal: apikey"
  # Replace these values with your actual keys managed by an external secrets operator
  team-platform: "EXAMPLE_API_KEY_PLATFORM_REPLACE_ME"
  team-data-science: "EXAMPLE_API_KEY_DS_REPLACE_ME"
  ci-pipeline: "EXAMPLE_API_KEY_CI_REPLACE_ME"
```

## Troubleshooting

```bash
#!/bin/bash
# GIE diagnostics

# Check InferenceModel and InferencePool status
kubectl get inferencemodels -n inference-system
kubectl get inferencepools -n inference-system
kubectl describe inferencepool llama-3-8b-pool -n inference-system

# Check GIE scheduler logs
kubectl logs -n inference-system deploy/gie-scheduler --tail 200 | \
  grep -i "error\|selected\|saturated\|cache_hit"

# Check which pod was selected for a recent request (scheduler logs)
kubectl logs -n inference-system deploy/gie-scheduler --tail 50 | \
  grep "routing_decision\|selected_pod"

# Verify vLLM pods are healthy and reporting metrics
for pod in $(kubectl get pods -n inference-system -l app=vllm-llama-3-8b -o name); do
  echo "=== ${pod} ==="
  kubectl exec -n inference-system "${pod}" -- curl -s localhost:8000/health
  kubectl exec -n inference-system "${pod}" -- curl -s localhost:8000/metrics | \
    grep -E "num_requests_(waiting|running)|gpu_cache|lora"
done

# Check Envoy ExtProc configuration
kubectl exec -n envoy-gateway-system deploy/envoy-gateway -- \
  curl -s localhost:19000/config_dump | python3 -m json.tool | \
  grep -A 10 "ext_proc"

# Test inference endpoint directly
curl -v "https://inference.example.com/v1/models" | python3 -m json.tool

# Check HTTPRoute status
kubectl get httproute inference-route -n inference-system -o yaml | grep -A 20 "status:"
```

## Summary

The Gateway API Inference Extension brings model-layer intelligence to Kubernetes networking. By introducing `InferenceModel` and `InferencePool` as first-class Kubernetes resources, GIE enables the data plane to route LLM traffic based on prefix cache affinity, LoRA adapter colocation, and real-time queue depth — decisions that standard HTTP load balancers cannot make. The result is measurably lower TTFT, higher GPU cache hit rates, and stable throughput under load. The integration with EnvoyProxy, standard Prometheus metrics, and the Gateway API HTTPRoute model means GIE fits naturally into existing Kubernetes observability and networking stacks. For teams running multiple model variants, the `targetModels` weight field enables A/B testing at the model level without requiring separate deployments or URL-path gymnastics.
