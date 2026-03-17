---
title: "Ollama on Kubernetes: Self-Hosted LLM Deployment Guide"
date: 2027-09-30T00:00:00-05:00
draft: false
tags: ["Ollama", "LLM", "Kubernetes", "GPU", "AI/ML", "Self-Hosted"]
categories:
- AI/ML
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to running Ollama on Kubernetes — StatefulSet with GPU node selectors, persistent model storage, init containers for model pulls, Open WebUI integration, Prometheus monitoring, and cost comparison vs managed LLM APIs."
more_link: "yes"
url: "/ollama-kubernetes-local-llm-guide/"
---

Ollama has become the preferred way to run open-weight language models locally — its one-command model management, OpenAI-compatible REST API, and support for GPU acceleration make it equally effective as a developer tool and as an enterprise self-hosted inference platform. Deploying Ollama on Kubernetes combines the simplicity of Ollama's model management with the reliability, scaling, and observability of Kubernetes orchestration. This guide covers StatefulSet deployment with GPU scheduling, model pre-loading via init containers, Open WebUI integration, Prometheus metrics collection, and a realistic cost comparison with managed LLM API services.

<!--more-->

# Ollama on Kubernetes: Self-Hosted LLM Deployment Guide

## Section 1: Architecture Overview

Ollama on Kubernetes differs from vLLM in important ways. Ollama manages its own model library in a local filesystem, making it better suited for single-server or StatefulSet deployments where state persistence maps to model storage.

### Deployment Pattern Comparison

```
Single-Model High-Performance (vLLM):
  Stateless Deployment → Shared PVC for models → Horizontal scaling

Multi-Model Self-Service (Ollama):
  StatefulSet → Per-pod model storage → Fewer, larger pods
  OR
  Deployment → Shared NFS/EFS PVC → Multiple models per pod
```

### Reference Architecture

```
Users / Applications
        │
        ▼
  Open WebUI (NodePort / Ingress)
        │
        ▼
  Ollama Service (ClusterIP)
        │
   ┌────┴────────────────────────┐
   ▼                             ▼
Ollama Pod 0                 Ollama Pod 1
(GPU Node A)                 (GPU Node B)
├── GPU: 1x A10G             ├── GPU: 1x A10G
├── Models: llama3, mistral  ├── Models: llama3, mistral
└── PVC: ollama-storage-0    └── PVC: ollama-storage-1
```

## Section 2: Namespace and RBAC Setup

```yaml
# ollama-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ollama
  labels:
    name: ollama
    environment: production
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ollama
  namespace: ollama
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ollama-role
  namespace: ollama
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ollama-rolebinding
  namespace: ollama
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ollama-role
subjects:
  - kind: ServiceAccount
    name: ollama
    namespace: ollama
```

## Section 3: Persistent Volume Configuration

Ollama stores models in `~/.ollama/models`. Each model ranges from 4GB (small quantized models) to 140GB+ (full-precision 70B models), so storage sizing is critical.

### Storage Class for GPU Nodes (EBS)

```yaml
# ollama-storage-class.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ollama-storage
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  throughput: "500"
  iops: "6000"
  encrypted: "true"
  tagSpecification_1: "Environment=production"
  tagSpecification_2: "ManagedBy=kubernetes"
allowVolumeExpansion: true
reclaimPolicy: Retain  # Retain models across pod restarts
volumeBindingMode: WaitForFirstConsumer
```

### For Multi-Tenancy — Shared EFS/NFS Volume

```yaml
# ollama-shared-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-model-cache
  namespace: ollama
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: efs-sc
  resources:
    requests:
      storage: 2Ti
```

## Section 4: StatefulSet Deployment with GPU

### Main StatefulSet

```yaml
# ollama-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ollama
  namespace: ollama
  labels:
    app: ollama
    version: "0.3.12"
spec:
  serviceName: ollama-headless
  replicas: 2
  selector:
    matchLabels:
      app: ollama
  template:
    metadata:
      labels:
        app: ollama
        version: "0.3.12"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "11434"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: ollama
      nodeSelector:
        nvidia.com/gpu.present: "true"
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: ollama
              topologyKey: kubernetes.io/hostname
      initContainers:
        # Pull models before starting the main Ollama process
        - name: pull-models
          image: ollama/ollama:0.3.12
          command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              # Start Ollama in background for model pulling
              ollama serve &
              OLLAMA_PID=$!

              # Wait for Ollama to be ready
              for i in $(seq 1 30); do
                if curl -sf http://localhost:11434/api/version > /dev/null 2>&1; then
                  echo "Ollama ready"
                  break
                fi
                echo "Waiting for Ollama to start... (${i}/30)"
                sleep 2
              done

              # Pull configured models
              MODELS="${OLLAMA_PRELOAD_MODELS:-llama3.1:8b,mistral:7b-instruct}"
              IFS=',' read -ra MODEL_LIST <<< "${MODELS}"
              for model in "${MODEL_LIST[@]}"; do
                echo "Pulling model: ${model}"
                ollama pull "${model}" || echo "WARNING: Failed to pull ${model}"
              done

              echo "Model pre-loading complete"
              kill "${OLLAMA_PID}"
              wait "${OLLAMA_PID}" 2>/dev/null || true
          env:
            - name: OLLAMA_PRELOAD_MODELS
              valueFrom:
                configMapKeyRef:
                  name: ollama-config
                  key: preload-models
            - name: OLLAMA_HOME
              value: /root/.ollama
          resources:
            requests:
              nvidia.com/gpu: "1"
              cpu: "4"
              memory: "16Gi"
            limits:
              nvidia.com/gpu: "1"
              cpu: "8"
              memory: "32Gi"
          volumeMounts:
            - name: ollama-data
              mountPath: /root/.ollama
      containers:
        - name: ollama
          image: ollama/ollama:0.3.12
          command: ["ollama", "serve"]
          ports:
            - name: http
              containerPort: 11434
              protocol: TCP
          env:
            - name: OLLAMA_HOST
              value: "0.0.0.0"
            - name: OLLAMA_ORIGINS
              value: "*"
            - name: OLLAMA_HOME
              value: /root/.ollama
            - name: OLLAMA_MODELS
              value: /root/.ollama/models
            - name: OLLAMA_KEEP_ALIVE
              value: "5m"
            - name: OLLAMA_NUM_PARALLEL
              value: "4"
            - name: OLLAMA_MAX_LOADED_MODELS
              value: "2"
            - name: OLLAMA_FLASH_ATTENTION
              value: "1"
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
          resources:
            requests:
              nvidia.com/gpu: "1"
              cpu: "4"
              memory: "16Gi"
            limits:
              nvidia.com/gpu: "1"
              cpu: "16"
              memory: "64Gi"
          volumeMounts:
            - name: ollama-data
              mountPath: /root/.ollama
          readinessProbe:
            httpGet:
              path: /api/version
              port: 11434
            initialDelaySeconds: 30
            periodSeconds: 10
            failureThreshold: 6
          livenessProbe:
            httpGet:
              path: /api/version
              port: 11434
            initialDelaySeconds: 60
            periodSeconds: 30
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
      terminationGracePeriodSeconds: 60
  volumeClaimTemplates:
    - metadata:
        name: ollama-data
        labels:
          app: ollama
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: ollama-storage
        resources:
          requests:
            storage: 500Gi
```

### ConfigMap for Model Configuration

```yaml
# ollama-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ollama-config
  namespace: ollama
data:
  preload-models: "llama3.1:8b,mistral:7b-instruct,codellama:13b,nomic-embed-text:latest"
  api-config.json: |
    {
      "max_queue_size": 100,
      "request_timeout": 300,
      "stream_buffer_size": 4096
    }
```

### Services

```yaml
# ollama-services.yaml
# Headless service for StatefulSet DNS
apiVersion: v1
kind: Service
metadata:
  name: ollama-headless
  namespace: ollama
spec:
  clusterIP: None
  selector:
    app: ollama
  ports:
    - name: http
      port: 11434
      targetPort: 11434
---
# Regular service for load-balanced access
apiVersion: v1
kind: Service
metadata:
  name: ollama
  namespace: ollama
  labels:
    app: ollama
spec:
  selector:
    app: ollama
  ports:
    - name: http
      port: 11434
      targetPort: 11434
  type: ClusterIP
---
# NodePort for development access
apiVersion: v1
kind: Service
metadata:
  name: ollama-nodeport
  namespace: ollama
spec:
  selector:
    app: ollama
  ports:
    - name: http
      port: 11434
      targetPort: 11434
      nodePort: 31434
  type: NodePort
```

## Section 5: CPU-Only Deployment (No GPU)

For teams without GPU nodes, Ollama supports CPU inference with quantized models.

```yaml
# ollama-cpu-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama-cpu
  namespace: ollama
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ollama-cpu
  template:
    metadata:
      labels:
        app: ollama-cpu
    spec:
      containers:
        - name: ollama
          image: ollama/ollama:0.3.12
          command: ["ollama", "serve"]
          ports:
            - containerPort: 11434
          env:
            - name: OLLAMA_HOST
              value: "0.0.0.0"
            - name: OLLAMA_NUM_PARALLEL
              value: "1"
            - name: OLLAMA_MAX_LOADED_MODELS
              value: "1"
            # CPU-optimized: use Q4_K_M quantization
          resources:
            requests:
              cpu: "8"
              memory: "32Gi"
            limits:
              cpu: "16"
              memory: "64Gi"
          volumeMounts:
            - name: ollama-data
              mountPath: /root/.ollama
      volumes:
        - name: ollama-data
          persistentVolumeClaim:
            claimName: ollama-model-cache
```

## Section 6: Open WebUI Integration

Open WebUI provides a ChatGPT-like interface for Ollama, supporting conversation history, system prompts, model switching, and RAG.

### Open WebUI Deployment

```yaml
# open-webui-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: open-webui
  namespace: ollama
  labels:
    app: open-webui
spec:
  replicas: 2
  selector:
    matchLabels:
      app: open-webui
  template:
    metadata:
      labels:
        app: open-webui
    spec:
      containers:
        - name: open-webui
          image: ghcr.io/open-webui/open-webui:v0.3.21
          ports:
            - containerPort: 8080
              name: http
          env:
            - name: OLLAMA_BASE_URL
              value: "http://ollama.ollama.svc.cluster.local:11434"
            - name: WEBUI_AUTH
              value: "true"
            - name: WEBUI_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: open-webui-secrets
                  key: secret-key
            - name: DEFAULT_USER_ROLE
              value: "user"
            - name: ENABLE_SIGNUP
              value: "false"
            - name: ENABLE_OAUTH_SIGNUP
              value: "true"
            - name: OAUTH_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: open-webui-secrets
                  key: oauth-client-id
            - name: OAUTH_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: open-webui-secrets
                  key: oauth-client-secret
            - name: OPENID_PROVIDER_URL
              value: "https://accounts.google.com/.well-known/openid-configuration"
            - name: DATA_DIR
              value: "/app/backend/data"
            - name: ENABLE_RAG_WEB_SEARCH
              value: "true"
            - name: RAG_WEB_SEARCH_ENGINE
              value: "searxng"
            - name: SEARXNG_QUERY_URL
              value: "http://searxng.ollama.svc.cluster.local:8080/search?q=<query>"
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2000m"
              memory: "4Gi"
          volumeMounts:
            - name: webui-data
              mountPath: /app/backend/data
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 20
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: webui-data
          persistentVolumeClaim:
            claimName: open-webui-data
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: open-webui-data
  namespace: ollama
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: standard-ssd
  resources:
    requests:
      storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: open-webui
  namespace: ollama
spec:
  selector:
    app: open-webui
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: open-webui
  namespace: ollama
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - chat.acme.internal
      secretName: open-webui-tls
  rules:
    - host: chat.acme.internal
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: open-webui
                port:
                  number: 80
```

## Section 7: Monitoring with Prometheus Custom Metrics

Ollama does not expose Prometheus metrics natively. A sidecar exporter reads from Ollama's API and exposes metrics.

### Ollama Prometheus Exporter

```python
#!/usr/bin/env python3
# ollama-exporter.py — Custom Prometheus exporter for Ollama
from prometheus_client import start_http_server, Gauge, Counter, Histogram
import requests
import time
import os
import threading

OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://localhost:11434')
SCRAPE_INTERVAL = int(os.environ.get('SCRAPE_INTERVAL', '15'))

# Define metrics
models_loaded = Gauge('ollama_models_loaded', 'Number of models currently loaded in memory')
model_size_bytes = Gauge('ollama_model_size_bytes', 'Model size in bytes', ['model', 'quantization'])
request_duration = Histogram(
    'ollama_request_duration_seconds',
    'Duration of Ollama API requests',
    ['model', 'operation'],
    buckets=[0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0]
)
tokens_generated_total = Counter(
    'ollama_tokens_generated_total',
    'Total tokens generated',
    ['model']
)
requests_total = Counter(
    'ollama_requests_total',
    'Total API requests',
    ['model', 'status']
)
gpu_memory_used_bytes = Gauge(
    'ollama_gpu_memory_used_bytes',
    'GPU memory used by loaded models',
    ['model']
)

def collect_metrics():
    while True:
        try:
            # Get running models
            response = requests.get(f'{OLLAMA_URL}/api/ps', timeout=5)
            if response.status_code == 200:
                data = response.json()
                running = data.get('models', [])
                models_loaded.set(len(running))
                for m in running:
                    name = m.get('name', 'unknown')
                    size = m.get('size', 0)
                    quant = m.get('details', {}).get('quantization_level', 'unknown')
                    model_size_bytes.labels(model=name, quantization=quant).set(size)
                    gpu_mem = m.get('size_vram', 0)
                    gpu_memory_used_bytes.labels(model=name).set(gpu_mem)
            else:
                models_loaded.set(0)

            # Get all available models
            response = requests.get(f'{OLLAMA_URL}/api/tags', timeout=5)
            if response.status_code == 200:
                data = response.json()
                for m in data.get('models', []):
                    name = m.get('name', 'unknown')
                    size = m.get('size', 0)
                    quant = m.get('details', {}).get('quantization_level', 'unknown')
                    model_size_bytes.labels(model=name, quantization=quant).set(size)

        except requests.exceptions.RequestException as e:
            print(f"Error collecting metrics: {e}")

        time.sleep(SCRAPE_INTERVAL)

if __name__ == '__main__':
    start_http_server(9090)
    print(f"Ollama exporter started on :9090, scraping {OLLAMA_URL}")
    collect_thread = threading.Thread(target=collect_metrics, daemon=True)
    collect_thread.start()
    while True:
        time.sleep(60)
```

### Exporter Sidecar in StatefulSet

```yaml
# Add to ollama-statefulset.yaml containers section
- name: metrics-exporter
  image: python:3.11-slim
  command:
    - /bin/bash
    - -c
    - |
      pip install --quiet prometheus_client requests
      python3 /scripts/ollama-exporter.py
  ports:
    - name: metrics
      containerPort: 9090
      protocol: TCP
  env:
    - name: OLLAMA_URL
      value: "http://localhost:11434"
    - name: SCRAPE_INTERVAL
      value: "15"
  resources:
    requests:
      cpu: "50m"
      memory: "64Mi"
    limits:
      cpu: "200m"
      memory: "256Mi"
  volumeMounts:
    - name: exporter-scripts
      mountPath: /scripts
```

### ServiceMonitor

```yaml
# ollama-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ollama-metrics
  namespace: ollama
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: ollama
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
      honorLabels: true
```

### Prometheus Alert Rules

```yaml
# ollama-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ollama-alerts
  namespace: ollama
spec:
  groups:
    - name: ollama
      rules:
        - alert: OllamaNoModelsLoaded
          expr: ollama_models_loaded == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ollama has no models loaded"
            description: "Ollama pod {{ $labels.pod }} has no models loaded for 5 minutes"
        - alert: OllamaHighGPUMemory
          expr: |
            sum by (pod) (ollama_gpu_memory_used_bytes)
            / 80e9  # 80GB A100
            > 0.95
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Ollama GPU memory above 95%"
        - alert: OllamaPodNotReady
          expr: |
            kube_statefulset_status_ready_replicas{statefulset="ollama",namespace="ollama"}
            / kube_statefulset_replicas{statefulset="ollama",namespace="ollama"}
            < 0.5
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Less than 50% of Ollama pods are ready"
```

## Section 8: Multi-Model Serving and Model Management

### Model Management Script

```bash
#!/bin/bash
# ollama-model-manager.sh
set -euo pipefail

NAMESPACE="ollama"
OLLAMA_POD=$(kubectl get pods -n "${NAMESPACE}" -l app=ollama -o jsonpath='{.items[0].metadata.name}')

usage() {
  echo "Usage: $0 [list|pull|delete|info] [model-name]"
  exit 1
}

list_models() {
  echo "=== Models available on ${OLLAMA_POD} ==="
  kubectl exec -n "${NAMESPACE}" "${OLLAMA_POD}" -- \
    ollama list
}

pull_model() {
  local model="${1}"
  echo "Pulling ${model} on all Ollama pods..."
  for pod in $(kubectl get pods -n "${NAMESPACE}" -l app=ollama -o jsonpath='{.items[*].metadata.name}'); do
    echo "  Pulling on ${pod}..."
    kubectl exec -n "${NAMESPACE}" "${pod}" -- \
      ollama pull "${model}"
  done
}

delete_model() {
  local model="${1}"
  echo "Deleting ${model} from all Ollama pods..."
  for pod in $(kubectl get pods -n "${NAMESPACE}" -l app=ollama -o jsonpath='{.items[*].metadata.name}'); do
    echo "  Deleting from ${pod}..."
    kubectl exec -n "${NAMESPACE}" "${pod}" -- \
      ollama rm "${model}"
  done
}

model_info() {
  local model="${1}"
  kubectl exec -n "${NAMESPACE}" "${OLLAMA_POD}" -- \
    ollama show "${model}"
}

case "${1:-list}" in
  list)   list_models ;;
  pull)   pull_model "${2:-}" ;;
  delete) delete_model "${2:-}" ;;
  info)   model_info "${2:-}" ;;
  *)      usage ;;
esac
```

### Ollama API Usage Examples

```bash
# List running models
curl -s http://ollama.ollama.svc.cluster.local:11434/api/ps | \
  python3 -c "import json, sys; data=json.load(sys.stdin); [print(m['name']) for m in data.get('models',[])]"

# Generate completion
curl -s http://ollama.ollama.svc.cluster.local:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1:8b",
    "prompt": "Write a Kubernetes readiness probe for an HTTP service",
    "stream": false,
    "options": {
      "temperature": 0.7,
      "top_p": 0.9,
      "num_predict": 512
    }
  }' | python3 -c "import json, sys; r=json.load(sys.stdin); print(r['response'])"

# Chat with history
curl -s http://ollama.ollama.svc.cluster.local:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1:8b",
    "messages": [
      {"role": "system", "content": "You are an expert Kubernetes administrator."},
      {"role": "user", "content": "How do I debug a CrashLoopBackOff?"}
    ],
    "stream": false
  }' | python3 -c "import json, sys; r=json.load(sys.stdin); print(r['message']['content'])"

# Embeddings (for RAG)
curl -s http://ollama.ollama.svc.cluster.local:11434/api/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"nomic-embed-text","prompt":"Kubernetes networking concepts"}' | \
  python3 -c "import json, sys; r=json.load(sys.stdin); print(f'Embedding dim: {len(r[\"embedding\"])}')"
```

## Section 9: Horizontal Pod Autoscaler

```yaml
# ollama-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ollama-hpa
  namespace: ollama
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: ollama
  minReplicas: 1
  maxReplicas: 4
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: ollama_models_loaded
        target:
          type: AverageValue
          averageValue: "2"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
        - type: Pods
          value: 1
          periodSeconds: 300
    scaleUp:
      stabilizationWindowSeconds: 120
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

## Section 10: Cost Comparison — Self-Hosted vs Managed APIs

Understanding the economics of self-hosting LLMs helps justify infrastructure investment.

### Cost Calculation Script

```python
#!/usr/bin/env python3
# cost-comparison.py
# Compare self-hosted Ollama vs OpenAI/Anthropic API costs

# Infrastructure costs (monthly)
GPU_NODE_COST_MONTHLY = 2000  # 1x g4dn.xlarge ~$0.526/hr * 720 * 1.3 (overhead)
GPU_NODES = 2
STORAGE_COST = 100  # 500GB EBS per node * 2
NETWORKING_COST = 50  # Minimal for internal use
ENGINEERING_HOURS = 4  # Monthly maintenance hours
ENGINEERING_HOURLY_RATE = 150

monthly_infra = (GPU_NODE_COST_MONTHLY * GPU_NODES) + STORAGE_COST + NETWORKING_COST
monthly_engineering = ENGINEERING_HOURS * ENGINEERING_HOURLY_RATE
total_self_hosted = monthly_infra + monthly_engineering

# Capacity: Llama 3.1 8B at ~50 tokens/sec per GPU
# With 2 GPUs: ~100 tokens/sec sustained
TOKENS_PER_SECOND = 100
SECONDS_PER_MONTH = 30 * 24 * 3600
UTILIZATION = 0.30  # 30% average utilization
MONTHLY_TOKENS = TOKENS_PER_SECOND * SECONDS_PER_MONTH * UTILIZATION

# OpenAI GPT-4o pricing comparison
GPT4O_INPUT_PER_1M = 5.00
GPT4O_OUTPUT_PER_1M = 15.00
# Assume 30% input, 70% output ratio
MONTHLY_TOKENS_INPUT = MONTHLY_TOKENS * 0.3
MONTHLY_TOKENS_OUTPUT = MONTHLY_TOKENS * 0.7
monthly_openai = (MONTHLY_TOKENS_INPUT / 1e6 * GPT4O_INPUT_PER_1M) + \
                 (MONTHLY_TOKENS_OUTPUT / 1e6 * GPT4O_OUTPUT_PER_1M)

# Llama 3.1 via Groq (comparable quality, lower cost)
GROQ_LLAMA31_8B_PER_1M = 0.05  # Input
GROQ_LLAMA31_8B_OUTPUT_PER_1M = 0.08  # Output
monthly_groq = (MONTHLY_TOKENS_INPUT / 1e6 * GROQ_LLAMA31_8B_PER_1M) + \
               (MONTHLY_TOKENS_OUTPUT / 1e6 * GROQ_LLAMA31_8B_OUTPUT_PER_1M)

print("=" * 60)
print("Monthly LLM Cost Comparison")
print("=" * 60)
print(f"Monthly tokens generated: {MONTHLY_TOKENS/1e9:.2f}B")
print()
print(f"Self-Hosted (Ollama/K8s):")
print(f"  Infrastructure: ${monthly_infra:,.2f}")
print(f"  Engineering:    ${monthly_engineering:,.2f}")
print(f"  TOTAL:          ${total_self_hosted:,.2f}")
print(f"  Cost per 1M tokens: ${total_self_hosted / (MONTHLY_TOKENS/1e6):.4f}")
print()
print(f"OpenAI GPT-4o API:")
print(f"  TOTAL: ${monthly_openai:,.2f}")
print(f"  Cost per 1M tokens: ${monthly_openai / (MONTHLY_TOKENS/1e6):.4f}")
print()
print(f"Groq Llama-3.1-8B API:")
print(f"  TOTAL: ${monthly_groq:,.2f}")
print(f"  Cost per 1M tokens: ${monthly_groq / (MONTHLY_TOKENS/1e6):.4f}")
print()
savings_vs_gpt4o = monthly_openai - total_self_hosted
savings_vs_groq = monthly_groq - total_self_hosted
print(f"Self-hosted savings vs GPT-4o: ${savings_vs_gpt4o:,.2f}/month")
print(f"Self-hosted vs Groq (similar quality, cheap model): ${savings_vs_groq:,.2f}/month")
if savings_vs_gpt4o > 0:
    print(f"\nBreak-even point vs GPT-4o: ~{total_self_hosted/monthly_openai*30:.0f} days")
```

### When Self-Hosting Makes Sense

```
Self-hosting wins when:
├── Monthly token volume > 500M tokens
├── Data privacy requirements prevent cloud API usage
├── Response latency < 500ms is required
├── Custom model fine-tuning is needed
└── Air-gapped environments

Managed API wins when:
├── Monthly token volume < 100M tokens
├── GPT-4o/Claude quality is required
├── Team lacks MLOps expertise
├── Rapid prototyping phase
└── Bursty, unpredictable workloads
```

## Summary

Ollama on Kubernetes provides a practical self-hosting path for teams that need LLM inference at moderate scale with model flexibility. The StatefulSet pattern with per-pod storage ensures model persistence and fast pod restarts. The init container approach to model pre-loading eliminates the cold-start problem. Combined with Open WebUI for user-facing access and custom Prometheus metrics for operational visibility, this stack delivers production-grade self-hosted LLM infrastructure at a fraction of managed API costs for sustained high-volume use cases.
