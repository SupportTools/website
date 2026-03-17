---
title: "vLLM on Kubernetes: Production LLM Inference at Scale"
date: 2027-09-29T00:00:00-05:00
draft: false
tags: ["vLLM", "LLM", "Kubernetes", "GPU", "AI/ML", "Inference"]
categories:
- AI/ML
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying vLLM on Kubernetes for production LLM inference — NVIDIA GPU Operator, multi-GPU tensor parallelism, HuggingFace model serving, KEDA autoscaling, rolling updates, and inference monitoring."
more_link: "yes"
url: "/vllm-kubernetes-production-deployment-guide/"
---

Large language model inference at production scale demands careful orchestration of GPU resources, model loading strategies, and request routing. vLLM has emerged as the leading open-source LLM inference engine, delivering high throughput through PagedAttention memory management and continuous batching. Running vLLM on Kubernetes unlocks elastic scaling, multi-model serving, and GitOps-managed deployments. This guide covers the complete production stack — from NVIDIA GPU Operator installation and multi-GPU tensor parallelism to KEDA-based autoscaling on custom metrics and zero-downtime model swaps.

<!--more-->

# vLLM on Kubernetes: Production LLM Inference at Scale

## Section 1: Architecture Overview

vLLM on Kubernetes requires careful resource planning. Each model has fixed GPU memory requirements, and the serving architecture must balance throughput, latency, and cost.

### Production Reference Architecture

```
                        ┌─────────────────────────────┐
                        │         API Gateway          │
                        │    (Kong / Nginx Ingress)    │
                        └──────────────┬──────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │           vLLM Service               │
                    │       (OpenAI-Compatible API)        │
                    └──────────────────┬──────────────────┘
                                       │
              ┌────────────────────────┴────────────────────────┐
              ▼                        ▼                        ▼
   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
   │  vLLM Pod (2xA100)│  │  vLLM Pod (2xA100)│  │  vLLM Pod (2xA100)│
   │  Llama-3-70B    │  │  Llama-3-70B    │  │  Llama-3-70B    │
   │  TP=2           │  │  TP=2           │  │  TP=2           │
   └─────────────────┘    └─────────────────┘    └─────────────────┘
              │                        │                        │
   ┌──────────▼──────────┐  ┌──────────▼──────────┐  ┌──────────▼──────────┐
   │   GPU Node (A100x2) │  │   GPU Node (A100x2) │  │   GPU Node (A100x2) │
   └─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

### GPU Memory Requirements by Model

```
Model                    GPU Memory (FP16)   Minimum GPUs    Recommended TP
─────────────────────────────────────────────────────────────────────────────
Llama-3-8B               16GB               1x A10G         TP=1
Llama-3-70B              140GB              2x A100-80GB    TP=2
Llama-3.1-405B           810GB              8x A100-80GB    TP=8
Mixtral-8x7B             90GB              2x A100-80GB    TP=2
Qwen2-72B                145GB              2x A100-80GB    TP=2
Mistral-7B               15GB               1x A10G         TP=1
```

## Section 2: NVIDIA GPU Operator Setup

The GPU Operator automates all GPU-related software installation on Kubernetes nodes — driver, container toolkit, device plugin, DCGM exporter, and MIG configuration.

### Install GPU Operator

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

helm upgrade --install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set operator.defaultRuntime=containerd \
  --set driver.enabled=true \
  --set driver.version="550.54.15" \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true \
  --set dcgmExporter.serviceMonitor.enabled=true \
  --set mig.strategy=mixed \
  --set validator.plugin.env[0].name=WITH_WORKLOAD \
  --set validator.plugin.env[0].value="true" \
  --version 24.3.0 \
  --wait \
  --timeout 15m
```

### Verify GPU Availability

```bash
# Check GPU nodes are properly labeled
kubectl get nodes -l nvidia.com/gpu.present=true \
  -o custom-columns='NAME:.metadata.name,GPU:.metadata.labels.nvidia\.com/gpu\.product,COUNT:.metadata.labels.nvidia\.com/gpu\.count'

# Verify GPU device plugin is working
kubectl get pods -n gpu-operator | grep device-plugin

# Test GPU allocation with a sample pod
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test
  namespace: default
spec:
  restartPolicy: Never
  containers:
    - name: gpu-test
      image: nvcr.io/nvidia/cuda:12.3.0-base-ubuntu22.04
      command: ["nvidia-smi"]
      resources:
        limits:
          nvidia.com/gpu: 1
EOF

kubectl wait --for=condition=completed pod/gpu-test --timeout=60s
kubectl logs gpu-test
kubectl delete pod gpu-test
```

### DCGM Exporter Configuration

```yaml
# dcgm-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: dcgm-exporter
  namespace: gpu-operator
  labels:
    app: dcgm-exporter
spec:
  selector:
    matchLabels:
      app: dcgm-exporter
  endpoints:
    - port: gpu-metrics
      interval: 15s
      path: /metrics
```

## Section 3: HuggingFace Hub Integration and Model Storage

Models should be pre-downloaded to a shared PersistentVolume rather than pulled at container startup. A model cache volume significantly reduces pod startup time.

### HuggingFace Model Cache PVC

```yaml
# model-cache-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: huggingface-model-cache
  namespace: llm-serving
spec:
  accessModes:
    - ReadWriteMany  # Shared across pods
  storageClassName: efs-sc  # AWS EFS for RWX, or NFS
  resources:
    requests:
      storage: 2Ti  # Large models require significant storage
```

### Model Pre-download Job

```yaml
# model-download-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: download-llama3-70b
  namespace: llm-serving
spec:
  ttlSecondsAfterFinished: 3600
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
              pip install --quiet huggingface_hub
              python3 -c "
              from huggingface_hub import snapshot_download
              import os
              snapshot_download(
                  repo_id='meta-llama/Meta-Llama-3-70B-Instruct',
                  local_dir='/models/meta-llama/Meta-Llama-3-70B-Instruct',
                  token=os.environ['HF_TOKEN'],
                  ignore_patterns=['*.bin'],  # Use safetensors only
                  max_workers=8
              )
              print('Download complete')
              "
          env:
            - name: HF_TOKEN
              valueFrom:
                secretKeyRef:
                  name: huggingface-credentials
                  key: token
            - name: HF_HUB_CACHE
              value: /models
          resources:
            requests:
              cpu: "2"
              memory: "8Gi"
            limits:
              cpu: "4"
              memory: "16Gi"
          volumeMounts:
            - name: model-cache
              mountPath: /models
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: huggingface-model-cache
```

## Section 4: vLLM Deployment Manifests

### Single-GPU Deployment (7B Model)

```yaml
# vllm-mistral-7b.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-mistral-7b
  namespace: llm-serving
  labels:
    app: vllm-mistral-7b
    model: mistral-7b-instruct
spec:
  replicas: 2
  selector:
    matchLabels:
      app: vllm-mistral-7b
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0  # Zero-downtime updates
  template:
    metadata:
      labels:
        app: vllm-mistral-7b
        model: mistral-7b-instruct
    spec:
      nodeSelector:
        nvidia.com/gpu.product: "NVIDIA-A10G"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: vllm-mistral-7b
                topologyKey: kubernetes.io/hostname
      initContainers:
        - name: verify-model
          image: busybox:1.36
          command:
            - /bin/sh
            - -c
            - |
              if [ ! -d "/models/mistralai/Mistral-7B-Instruct-v0.3" ]; then
                echo "ERROR: Model directory not found"
                exit 1
              fi
              echo "Model verified"
          volumeMounts:
            - name: model-cache
              mountPath: /models
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.5.5
          command:
            - python3
            - -m
            - vllm.entrypoints.openai.api_server
          args:
            - --model
            - /models/mistralai/Mistral-7B-Instruct-v0.3
            - --host
            - "0.0.0.0"
            - --port
            - "8000"
            - --tensor-parallel-size
            - "1"
            - --max-model-len
            - "32768"
            - --max-num-batched-tokens
            - "32768"
            - --max-num-seqs
            - "256"
            - --gpu-memory-utilization
            - "0.90"
            - --enable-chunked-prefill
            - --disable-log-requests
            - --served-model-name
            - mistral-7b-instruct
          ports:
            - containerPort: 8000
              name: http
              protocol: TCP
          env:
            - name: HUGGING_FACE_HUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: huggingface-credentials
                  key: token
            - name: VLLM_WORKER_MULTIPROC_METHOD
              value: spawn
            - name: NCCL_P2P_DISABLE
              value: "0"
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
            - name: model-cache
              mountPath: /models
              readOnly: true
            - name: shm
              mountPath: /dev/shm
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 120
            periodSeconds: 10
            failureThreshold: 12
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 180
            periodSeconds: 30
            failureThreshold: 3
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: huggingface-model-cache
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: "16Gi"
      terminationGracePeriodSeconds: 120
```

### Multi-GPU Deployment (70B Model with Tensor Parallelism)

```yaml
# vllm-llama3-70b.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vllm-llama3-70b
  namespace: llm-serving
  labels:
    app: vllm-llama3-70b
    model: llama3-70b-instruct
spec:
  replicas: 1
  selector:
    matchLabels:
      app: vllm-llama3-70b
  strategy:
    type: Recreate  # Multi-GPU pods need full node replacement
  template:
    metadata:
      labels:
        app: vllm-llama3-70b
        model: llama3-70b-instruct
    spec:
      nodeSelector:
        nvidia.com/gpu.product: "NVIDIA-A100-SXM4-80GB"
        cloud.google.com/gke-accelerator: nvidia-a100-80gb
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      containers:
        - name: vllm
          image: vllm/vllm-openai:v0.5.5
          command:
            - python3
            - -m
            - vllm.entrypoints.openai.api_server
          args:
            - --model
            - /models/meta-llama/Meta-Llama-3-70B-Instruct
            - --host
            - "0.0.0.0"
            - --port
            - "8000"
            - --tensor-parallel-size
            - "2"
            - --max-model-len
            - "131072"
            - --max-num-batched-tokens
            - "65536"
            - --max-num-seqs
            - "128"
            - --gpu-memory-utilization
            - "0.92"
            - --enable-chunked-prefill
            - --disable-log-requests
            - --served-model-name
            - llama3-70b-instruct
            - --rope-scaling
            - '{"type":"dynamic","factor":2.0}'
          ports:
            - containerPort: 8000
              name: http
          env:
            - name: HUGGING_FACE_HUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: huggingface-credentials
                  key: token
            - name: VLLM_WORKER_MULTIPROC_METHOD
              value: spawn
            - name: NCCL_DEBUG
              value: "WARN"
            - name: CUDA_VISIBLE_DEVICES
              value: "0,1"
          resources:
            requests:
              nvidia.com/gpu: "2"
              cpu: "32"
              memory: "256Gi"
            limits:
              nvidia.com/gpu: "2"
              cpu: "64"
              memory: "512Gi"
          volumeMounts:
            - name: model-cache
              mountPath: /models
              readOnly: true
            - name: shm
              mountPath: /dev/shm
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 300
            periodSeconds: 15
            failureThreshold: 20
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 360
            periodSeconds: 60
            failureThreshold: 3
      volumes:
        - name: model-cache
          persistentVolumeClaim:
            claimName: huggingface-model-cache
        - name: shm
          emptyDir:
            medium: Memory
            sizeLimit: "64Gi"
      terminationGracePeriodSeconds: 300
```

### Service and Ingress

```yaml
# vllm-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: vllm-mistral-7b
  namespace: llm-serving
  labels:
    app: vllm-mistral-7b
spec:
  selector:
    app: vllm-mistral-7b
  ports:
    - name: http
      port: 80
      targetPort: 8000
      protocol: TCP
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-ingress
  namespace: llm-serving
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
    nginx.ingress.kubernetes.io/use-regex: "true"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - llm-api.acme.internal
      secretName: vllm-tls
  rules:
    - host: llm-api.acme.internal
      http:
        paths:
          - path: /v1/mistral
            pathType: Prefix
            backend:
              service:
                name: vllm-mistral-7b
                port:
                  name: http
          - path: /v1/llama
            pathType: Prefix
            backend:
              service:
                name: vllm-llama3-70b
                port:
                  name: http
```

## Section 5: KEDA Autoscaling on GPU Metrics

KEDA scales vLLM replicas based on queue depth and GPU utilization metrics from DCGM Exporter.

### KEDA Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set prometheus.metricServer.enabled=true \
  --wait
```

### ScaledObject for vLLM

```yaml
# vllm-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: vllm-mistral-7b-scaler
  namespace: llm-serving
spec:
  scaleTargetRef:
    name: vllm-mistral-7b
  minReplicaCount: 1
  maxReplicaCount: 8
  pollingInterval: 30
  cooldownPeriod: 300
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Pods
              value: 1
              periodSeconds: 120
        scaleUp:
          stabilizationWindowSeconds: 60
          policies:
            - type: Pods
              value: 2
              periodSeconds: 60
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: vllm_request_queue_depth
        query: |
          avg(vllm:num_requests_waiting{namespace="llm-serving", service="vllm-mistral-7b"})
        threshold: "10"
        activationThreshold: "1"
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: gpu_utilization
        query: |
          avg(DCGM_FI_DEV_GPU_UTIL{namespace="llm-serving",pod=~"vllm-mistral-7b-.*"})
        threshold: "75"
        activationThreshold: "50"
```

## Section 6: OpenAI-Compatible API Usage

vLLM implements the OpenAI API specification, enabling drop-in replacement for applications using the OpenAI client SDK.

### Python Client Example

```python
#!/usr/bin/env python3
# vllm-client-example.py
from openai import OpenAI
import time

client = OpenAI(
    base_url="https://llm-api.acme.internal/v1/mistral",
    api_key="not-needed-for-internal",  # vLLM doesn't require auth by default
)

# Chat completion
response = client.chat.completions.create(
    model="mistral-7b-instruct",
    messages=[
        {
            "role": "system",
            "content": "You are a helpful assistant for DevOps engineers."
        },
        {
            "role": "user",
            "content": "Explain the difference between a Deployment and a StatefulSet in Kubernetes."
        }
    ],
    max_tokens=512,
    temperature=0.7,
    stream=False,
)

print(f"Response: {response.choices[0].message.content}")
print(f"Tokens used: {response.usage.total_tokens}")
print(f"Completion tokens: {response.usage.completion_tokens}")

# Streaming example
print("\n--- Streaming Example ---")
start_time = time.time()
token_count = 0

stream = client.chat.completions.create(
    model="mistral-7b-instruct",
    messages=[{"role": "user", "content": "Write a Kubernetes HPA configuration example."}],
    max_tokens=1024,
    stream=True,
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
        token_count += 1

elapsed = time.time() - start_time
print(f"\n\nStreaming rate: {token_count / elapsed:.1f} tokens/sec")
```

### Batch Inference Script

```bash
#!/bin/bash
# batch-inference.sh — test vLLM throughput
ENDPOINT="${VLLM_ENDPOINT:-https://llm-api.acme.internal/v1/mistral}"
CONCURRENCY="${1:-10}"
REQUESTS="${2:-100}"

echo "Testing vLLM throughput: ${CONCURRENCY} concurrent, ${REQUESTS} total requests"

# Use wrk2 or vegeta for load testing
echo '{"model":"mistral-7b-instruct","messages":[{"role":"user","content":"What is Kubernetes?"}],"max_tokens":100}' > /tmp/request.json

vegeta attack \
  -targets=<(echo "POST ${ENDPOINT}/chat/completions") \
  -body=/tmp/request.json \
  -header="Content-Type: application/json" \
  -rate="${CONCURRENCY}" \
  -duration=30s | \
  vegeta report
```

## Section 7: Rolling Updates for Zero-Downtime Model Swaps

Updating the model version requires careful orchestration to avoid serving gaps.

### Blue-Green Model Deployment

```bash
#!/bin/bash
# model-blue-green-update.sh
set -euo pipefail

NAMESPACE="llm-serving"
APP_NAME="vllm-mistral-7b"
NEW_MODEL_PATH="/models/mistralai/Mistral-7B-Instruct-v0.3"
NEW_IMAGE="vllm/vllm-openai:v0.5.5"

echo "Starting blue-green model update for ${APP_NAME}"

# 1. Scale up new version alongside old
kubectl set image deployment/"${APP_NAME}" \
  vllm="${NEW_IMAGE}" \
  -n "${NAMESPACE}"

kubectl set env deployment/"${APP_NAME}" \
  -n "${NAMESPACE}" \
  NEW_MODEL="${NEW_MODEL_PATH}"

# 2. Wait for new pods to be ready
echo "Waiting for rollout to complete..."
kubectl rollout status deployment/"${APP_NAME}" \
  -n "${NAMESPACE}" \
  --timeout=600s

# 3. Verify new pods are serving correctly
POD=$(kubectl get pods -n "${NAMESPACE}" \
  -l "app=${APP_NAME}" \
  -o jsonpath='{.items[0].metadata.name}')

echo "Testing new pod: ${POD}"
kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  curl -sf http://localhost:8000/health && echo "Health check passed"

# 4. Verify model is loaded
kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  curl -sf http://localhost:8000/v1/models | \
  python3 -c "import json, sys; models = json.load(sys.stdin); print('Models:', [m['id'] for m in models['data']])"

echo "Model update complete"
```

### Canary Deployment with Traffic Splitting

```yaml
# vllm-canary-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-canary
  namespace: llm-serving
  annotations:
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    nginx.ingress.kubernetes.io/canary-by-header: "X-Canary"
spec:
  ingressClassName: nginx
  rules:
    - host: llm-api.acme.internal
      http:
        paths:
          - path: /v1/mistral
            pathType: Prefix
            backend:
              service:
                name: vllm-mistral-7b-canary
                port:
                  name: http
```

## Section 8: Monitoring Inference Latency and Throughput

### Prometheus Rules for vLLM

```yaml
# vllm-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vllm-alerts
  namespace: llm-serving
  labels:
    prometheus: kube-prometheus
spec:
  groups:
    - name: vllm.inference
      interval: 30s
      rules:
        - record: vllm:request_latency_p99
          expr: |
            histogram_quantile(0.99,
              sum by (model_name, le) (
                rate(vllm:e2e_request_latency_seconds_bucket[5m])
              )
            )
        - record: vllm:throughput_tokens_per_second
          expr: |
            sum by (model_name) (
              rate(vllm:generation_tokens_total[5m])
            )
        - record: vllm:queue_depth
          expr: |
            sum by (model_name) (vllm:num_requests_waiting)
        - alert: VLLMHighLatency
          expr: vllm:request_latency_p99 > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "vLLM P99 latency above 30s"
            description: "Model {{ $labels.model_name }} P99 latency is {{ $value }}s"
        - alert: VLLMHighQueueDepth
          expr: vllm:queue_depth > 50
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "vLLM request queue depth critical"
            description: "Model {{ $labels.model_name }} has {{ $value }} requests queued"
        - alert: VLLMPodNotReady
          expr: |
            kube_deployment_status_replicas_available{namespace="llm-serving",deployment=~"vllm-.*"}
            / kube_deployment_spec_replicas{namespace="llm-serving",deployment=~"vllm-.*"}
            < 0.5
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Less than 50% of vLLM pods are ready"
```

### Grafana Dashboard Queries

```bash
# Key Grafana panel queries for vLLM monitoring

# Panel 1: Request throughput
# rate(vllm:request_success_total[5m])

# Panel 2: P50/P95/P99 latency
# histogram_quantile(0.5, sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket[5m])))
# histogram_quantile(0.95, sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket[5m])))
# histogram_quantile(0.99, sum by (le) (rate(vllm:e2e_request_latency_seconds_bucket[5m])))

# Panel 3: Token throughput (generation tokens/sec)
# sum(rate(vllm:generation_tokens_total[5m]))

# Panel 4: GPU utilization
# avg(DCGM_FI_DEV_GPU_UTIL{pod=~"vllm-.*"})

# Panel 5: GPU memory utilization
# avg(DCGM_FI_DEV_FB_USED{pod=~"vllm-.*"}) / avg(DCGM_FI_DEV_FB_TOTAL{pod=~"vllm-.*"}) * 100

# Panel 6: Queued requests
# sum(vllm:num_requests_waiting)

# Panel 7: Running requests
# sum(vllm:num_requests_running)
```

### ServiceMonitor for vLLM Pods

```yaml
# vllm-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: vllm-metrics
  namespace: llm-serving
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: vllm-mistral-7b
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      honorLabels: true
```

## Section 9: Security and Authentication

### API Key Authentication with Kong

```yaml
# kong-vllm-plugin.yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: vllm-key-auth
  namespace: llm-serving
plugin: key-auth
config:
  key_names:
    - X-API-Key
    - Authorization
  hide_credentials: true
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: vllm-kong-ingress
  namespace: llm-serving
  annotations:
    konghq.com/plugins: vllm-key-auth
    konghq.com/strip-path: "true"
spec:
  ingressClassName: kong
  rules:
    - host: llm-api.acme.internal
      http:
        paths:
          - path: /v1
            pathType: Prefix
            backend:
              service:
                name: vllm-mistral-7b
                port:
                  name: http
```

### Rate Limiting per Consumer

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: vllm-rate-limit
  namespace: llm-serving
plugin: rate-limiting
config:
  minute: 60
  hour: 1000
  policy: redis
  redis_host: redis.infrastructure.svc.cluster.local
  redis_port: 6379
```

## Section 10: Cost Optimization for GPU Inference

### Spot Instance Strategy for Inference

```yaml
# Tolerate spot interruption for stateless inference
spec:
  template:
    spec:
      tolerations:
        - key: "node.kubernetes.io/spot"
          operator: "Exists"
          effect: "NoSchedule"
      # Use checkpoint/restore for spot interruption handling
      terminationGracePeriodSeconds: 60
```

### Schedule-Based Scaling

```yaml
# Scale down at night using KEDA CronTrigger
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: vllm-scheduled-scaler
  namespace: llm-serving
spec:
  scaleTargetRef:
    name: vllm-mistral-7b
  minReplicaCount: 0
  maxReplicaCount: 8
  triggers:
    - type: cron
      metadata:
        timezone: America/New_York
        start: 0 8 * * MON-FRI    # Scale up at 8 AM weekdays
        end: 0 22 * * MON-FRI     # Scale down at 10 PM weekdays
        desiredReplicas: "3"
    - type: cron
      metadata:
        timezone: America/New_York
        start: 0 22 * * MON-FRI   # Overnight minimum
        end: 0 8 * * MON-FRI
        desiredReplicas: "1"
```

## Summary

Production vLLM on Kubernetes requires coordination across GPU hardware management (NVIDIA GPU Operator), model storage (shared PVC with pre-downloaded weights), inference configuration (tensor parallelism, memory utilization, chunked prefill), and observability (DCGM metrics, vLLM Prometheus metrics, custom alert rules). The configurations in this guide support production workloads serving hundreds of concurrent requests with P99 latencies under 10 seconds for 7B models on A10G GPUs.

Key operational considerations: always use `maxUnavailable: 0` in rolling update strategy to prevent request drops during updates, monitor GPU memory fragmentation (PagedAttention mitigates but doesn't eliminate this), and maintain warm spare capacity through HPA min replica settings to absorb traffic spikes without cold-start latency.
