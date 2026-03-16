---
title: "Ollama LLM on Kubernetes: Self-Hosted Language Models with GPU Scheduling"
date: 2027-07-16T00:00:00-05:00
draft: false
tags: ["Ollama", "LLM", "Kubernetes", "GPU", "AI/ML"]
categories:
- Kubernetes
- AI/ML
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to deploying Ollama on Kubernetes with GPU scheduling, NVIDIA device plugin configuration, persistent model storage, KEDA autoscaling, Open WebUI integration, and GPU utilization monitoring for self-hosted LLM inference."
more_link: "yes"
url: "/ollama-llm-kubernetes-deployment-guide/"
---

Self-hosted large language models have moved from research curiosity to production infrastructure component. Ollama provides a unified runtime for running LLMs locally, and Kubernetes enables that runtime at enterprise scale — scheduling GPU workloads, managing model storage, autoscaling based on queue depth, and integrating with internal tooling. This guide covers the complete deployment lifecycle from NVIDIA operator installation through production monitoring.

<!--more-->

# Ollama LLM on Kubernetes: Self-Hosted Language Models with GPU Scheduling

## Section 1: Ollama Architecture

Ollama is a Go-based daemon that manages model lifecycle and serves an HTTP API compatible with the OpenAI chat completions format. It handles:

- **Model registry**: Pull, list, and delete models from the Ollama library or custom registries
- **Inference engine**: Wraps llama.cpp for efficient LLM inference with support for GGUF quantized models
- **Context management**: Maintains conversation context across multi-turn sessions
- **Hardware abstraction**: Automatically selects CUDA, ROCm, Metal, or CPU inference paths

### API Surface

Ollama exposes two primary endpoints:

```
POST /api/generate      — single-turn text generation
POST /api/chat          — multi-turn conversation (OpenAI-compatible)
POST /api/pull          — pull a model from the registry
GET  /api/tags          — list available models
DELETE /api/delete      — remove a model
POST /api/embeddings    — generate embeddings
```

The `/v1/chat/completions` endpoint provides full OpenAI API compatibility, allowing drop-in replacement for OpenAI clients.

---

## Section 2: NVIDIA GPU Operator Setup

The NVIDIA GPU Operator is the recommended way to manage GPU drivers, device plugins, and monitoring components in Kubernetes.

### Prerequisites

```bash
# Verify GPU nodes are present
kubectl get nodes -l nvidia.com/gpu.present=true

# Check current driver installation
ssh gpu-node-01 'nvidia-smi'
```

### Install GPU Operator

```bash
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

helm install gpu-operator nvidia/gpu-operator \
  --namespace gpu-operator \
  --create-namespace \
  --set driver.enabled=true \
  --set driver.version="550.90.07" \
  --set toolkit.enabled=true \
  --set devicePlugin.enabled=true \
  --set dcgmExporter.enabled=true \
  --set mig.strategy=single \
  --set validator.plugin.env[0].name=WITH_WORKLOAD \
  --set validator.plugin.env[0].value="true"
```

**Verify GPU operator is healthy:**

```bash
# Check all operator components
kubectl get pods -n gpu-operator

# Verify device plugin is advertising GPUs
kubectl get nodes -o json | jq '
  .items[] |
  select(.status.capacity["nvidia.com/gpu"] != null) |
  {
    node: .metadata.name,
    gpus: .status.capacity["nvidia.com/gpu"],
    gpu_model: .metadata.labels["nvidia.com/gpu.product"]
  }'
```

**Expected output:**

```json
{
  "node": "gpu-node-01",
  "gpus": "2",
  "gpu_model": "NVIDIA-A10G"
}
```

### Node Labels and Taints for GPU Nodes

```bash
# Label GPU nodes for scheduling
kubectl label node gpu-node-01 gpu=true accelerator=nvidia

# Taint GPU nodes to prevent non-GPU workloads from scheduling
kubectl taint node gpu-node-01 nvidia.com/gpu=present:NoSchedule
```

---

## Section 3: Persistent Storage for Model Weights

LLM model weights are large — Llama 3.1 8B at 4-bit quantization is 4.7GB; 70B models exceed 40GB. Models must be stored on persistent volumes to avoid re-downloading on pod restarts.

### StorageClass for Model Weights

```yaml
# gpu-models-storageclass.yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gpu-models
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"
  throughput: "500"
  encrypted: "true"
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
```

### PersistentVolumeClaim for Ollama Models

```yaml
# ollama-models-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-models
  namespace: ollama
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gpu-models
  resources:
    requests:
      storage: 200Gi
```

For multi-replica deployments needing shared model storage, use ReadWriteMany (EFS on AWS, Filestore on GCP):

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-models-shared
  namespace: ollama
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: efs-sc
  resources:
    requests:
      storage: 500Gi
```

---

## Section 4: Kubernetes Deployment for Ollama

### Namespace and RBAC

```yaml
# ollama-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ollama
  labels:
    app.kubernetes.io/name: ollama
    environment: production
```

### Core Ollama Deployment

```yaml
# ollama-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama
  namespace: ollama
  labels:
    app: ollama
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ollama
  strategy:
    type: Recreate  # Avoid GPU contention during rolling updates
  template:
    metadata:
      labels:
        app: ollama
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
      containers:
        - name: ollama
          image: ollama/ollama:0.3.12
          ports:
            - containerPort: 11434
              name: http
          env:
            - name: OLLAMA_NUM_PARALLEL
              value: "4"
            - name: OLLAMA_MAX_LOADED_MODELS
              value: "2"
            - name: OLLAMA_FLASH_ATTENTION
              value: "1"
            - name: OLLAMA_MODELS
              value: "/models"
            - name: OLLAMA_HOST
              value: "0.0.0.0:11434"
          resources:
            requests:
              cpu: "2"
              memory: 8Gi
              nvidia.com/gpu: "1"
            limits:
              cpu: "8"
              memory: 24Gi
              nvidia.com/gpu: "1"
          volumeMounts:
            - name: models
              mountPath: /models
          livenessProbe:
            httpGet:
              path: /
              port: 11434
            initialDelaySeconds: 30
            periodSeconds: 30
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /api/tags
              port: 11434
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 5
          securityContext:
            runAsNonRoot: false  # Required for GPU access
            allowPrivilegeEscalation: false
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: ollama-models
```

### Service

```yaml
# ollama-service.yaml
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
```

---

## Section 5: Model Management

### Pre-pulling Models with Init Containers

Pulling models at pod startup prevents the first inference request from timing out. Use an init container that exits only after the model is available.

```yaml
# ollama-model-init.yaml — add to Deployment spec
initContainers:
  - name: pull-models
    image: ollama/ollama:0.3.12
    command:
      - /bin/sh
      - -c
      - |
        set -e
        echo "Starting Ollama server for model pull..."
        ollama serve &
        OLLAMA_PID=$!
        sleep 5

        for model in llama3.1:8b mistral:7b nomic-embed-text:latest; do
          echo "Pulling model: $model"
          ollama pull "$model"
        done

        kill $OLLAMA_PID
        wait $OLLAMA_PID
        echo "Model pre-pull complete"
    env:
      - name: OLLAMA_MODELS
        value: "/models"
    resources:
      requests:
        cpu: "1"
        memory: 4Gi
        nvidia.com/gpu: "1"
      limits:
        cpu: "4"
        memory: 16Gi
        nvidia.com/gpu: "1"
    volumeMounts:
      - name: models
        mountPath: /models
```

### Model Management Job

For updating models on a schedule:

```yaml
# ollama-model-update-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ollama-model-update
  namespace: ollama
spec:
  schedule: "0 3 * * 0"  # Weekly at 3 AM Sunday
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: model-updater
              image: curlimages/curl:8.6.0
              command:
                - /bin/sh
                - -c
                - |
                  OLLAMA_URL="http://ollama.ollama.svc.cluster.local:11434"
                  for model in llama3.1:8b mistral:7b; do
                    echo "Updating model: $model"
                    curl -sf -X POST "${OLLAMA_URL}/api/pull" \
                      -H "Content-Type: application/json" \
                      -d "{\"name\": \"${model}\"}" \
                      --max-time 3600
                  done
```

### Verify Model Availability

```bash
# List available models
curl -sf http://ollama.ollama.svc.cluster.local:11434/api/tags | jq '.models[] | {name: .name, size: .size}'

# Test inference
curl -sf http://ollama.ollama.svc.cluster.local:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.1:8b", "prompt": "What is Kubernetes?", "stream": false}' \
  | jq '.response'
```

---

## Section 6: Multi-Replica Deployment with Shared Storage

For high-availability deployments, multiple Ollama instances share a ReadWriteMany volume. Each pod serves requests independently.

```yaml
# ollama-ha-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama-ha
  namespace: ollama
spec:
  replicas: 3
  selector:
    matchLabels:
      app: ollama-ha
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: ollama-ha
    spec:
      runtimeClassName: nvidia
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: ollama-ha
      containers:
        - name: ollama
          image: ollama/ollama:0.3.12
          ports:
            - containerPort: 11434
          env:
            - name: OLLAMA_MODELS
              value: "/models"
            - name: OLLAMA_NUM_PARALLEL
              value: "2"
          resources:
            requests:
              nvidia.com/gpu: "1"
              memory: 16Gi
              cpu: "4"
            limits:
              nvidia.com/gpu: "1"
              memory: 32Gi
              cpu: "16"
          volumeMounts:
            - name: models
              mountPath: /models
          readinessProbe:
            httpGet:
              path: /api/tags
              port: 11434
            initialDelaySeconds: 15
            periodSeconds: 10
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: ollama-models-shared
```

---

## Section 7: KEDA Autoscaling Based on Queue Depth

KEDA (Kubernetes Event-driven Autoscaling) scales Ollama replicas based on pending request count from a Redis queue or Prometheus metrics.

### KEDA with Prometheus Scaler

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace
```

**ScaledObject for Ollama based on Prometheus metrics:**

```yaml
# ollama-keda-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ollama-scaler
  namespace: ollama
spec:
  scaleTargetRef:
    name: ollama-ha
  minReplicaCount: 1
  maxReplicaCount: 8
  cooldownPeriod: 300
  pollingInterval: 15
  triggers:
    - type: prometheus
      metadata:
        serverAddress: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
        metricName: ollama_pending_requests
        threshold: "5"
        query: |
          sum(ollama_pending_request_count{job="ollama"})
    - type: prometheus
      metadata:
        serverAddress: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
        metricName: ollama_gpu_utilization
        threshold: "80"
        query: |
          avg(DCGM_FI_DEV_GPU_UTIL{namespace="ollama"})
```

### Custom Ollama Metrics Exporter

Ollama does not expose Prometheus metrics natively. A sidecar exporter bridges the gap:

```python
#!/usr/bin/env python3
"""ollama-exporter.py — Prometheus metrics sidecar for Ollama."""
import time
import requests
from prometheus_client import start_http_server, Gauge, Counter

OLLAMA_URL = "http://localhost:11434"

# Metrics
models_loaded = Gauge("ollama_models_loaded", "Number of models currently loaded")
model_size_bytes = Gauge("ollama_model_size_bytes", "Model size in bytes", ["model"])
pending_requests = Gauge("ollama_pending_request_count", "Pending inference requests")
requests_total = Counter("ollama_requests_total", "Total inference requests", ["model"])

def collect_metrics():
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        resp.raise_for_status()
        tags = resp.json()
        models = tags.get("models", [])
        models_loaded.set(len(models))
        for m in models:
            model_size_bytes.labels(model=m["name"]).set(m.get("size", 0))
    except requests.RequestException:
        models_loaded.set(0)

if __name__ == "__main__":
    start_http_server(9114)
    while True:
        collect_metrics()
        time.sleep(15)
```

**Sidecar in Ollama Deployment:**

```yaml
# Add to containers list in ollama-ha-deployment.yaml
- name: ollama-exporter
  image: python:3.12-slim
  command:
    - /bin/sh
    - -c
    - |
      pip install prometheus-client requests -q
      python /scripts/ollama-exporter.py
  ports:
    - containerPort: 9114
      name: metrics
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 256Mi
  volumeMounts:
    - name: exporter-script
      mountPath: /scripts
```

---

## Section 8: Open WebUI Integration

Open WebUI provides a ChatGPT-style interface for Ollama, supporting model selection, conversation history, and RAG (retrieval-augmented generation).

```yaml
# open-webui-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: open-webui
  namespace: ollama
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
          image: ghcr.io/open-webui/open-webui:v0.3.32
          ports:
            - containerPort: 8080
          env:
            - name: OLLAMA_BASE_URL
              value: "http://ollama.ollama.svc.cluster.local:11434"
            - name: WEBUI_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: open-webui-secrets
                  key: secret-key
            - name: ENABLE_SIGNUP
              value: "false"
            - name: DEFAULT_USER_ROLE
              value: "user"
            - name: ENABLE_COMMUNITY_SHARING
              value: "false"
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
          volumeMounts:
            - name: webui-data
              mountPath: /app/backend/data
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
      volumes:
        - name: webui-data
          persistentVolumeClaim:
            claimName: open-webui-data
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
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: open-webui
  namespace: ollama
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "100m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "600"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - llm.internal.myorg.com
      secretName: open-webui-tls
  rules:
    - host: llm.internal.myorg.com
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

---

## Section 9: CPU-Only and ARM Deployments

For teams without GPU infrastructure, Ollama runs on CPU with reduced performance. The same Kubernetes manifests apply with GPU resource references removed.

### CPU-Only Deployment

```yaml
# ollama-cpu-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama-cpu
  namespace: ollama
spec:
  replicas: 2
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
          ports:
            - containerPort: 11434
          env:
            - name: OLLAMA_MODELS
              value: "/models"
            - name: OLLAMA_NUM_THREAD
              value: "8"
            - name: OLLAMA_NUM_PARALLEL
              value: "1"
          resources:
            requests:
              cpu: "8"
              memory: 16Gi
            limits:
              cpu: "16"
              memory: 32Gi
          volumeMounts:
            - name: models
              mountPath: /models
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: ollama-models
```

### ARM64 Deployment (Graviton, Ampere)

```yaml
# ollama-arm-deployment.yaml
spec:
  template:
    spec:
      nodeSelector:
        kubernetes.io/arch: arm64
      containers:
        - name: ollama
          image: ollama/ollama:0.3.12  # Multi-arch image supports arm64
          env:
            - name: OLLAMA_MODELS
              value: "/models"
          resources:
            requests:
              cpu: "16"
              memory: 32Gi
```

ARM nodes (AWS Graviton3) provide better cost/performance for CPU inference than x86 equivalents.

---

## Section 10: Monitoring GPU Utilization

### DCGM Exporter Metrics

The NVIDIA DCGM Exporter (installed with the GPU Operator) exposes detailed GPU metrics.

**Key metrics:**

```promql
# GPU utilization across all ollama pods
avg by (kubernetes_pod_name, gpu) (
  DCGM_FI_DEV_GPU_UTIL{namespace="ollama"}
)

# GPU memory used (bytes)
sum by (kubernetes_pod_name) (
  DCGM_FI_DEV_FB_USED{namespace="ollama"} * 1024 * 1024
)

# GPU temperature
max by (gpu) (
  DCGM_FI_DEV_GPU_TEMP{namespace="ollama"}
)

# GPU memory bandwidth utilization
avg by (kubernetes_pod_name) (
  DCGM_FI_DEV_MEM_COPY_UTIL{namespace="ollama"}
)
```

### GPU Utilization Alert Rules

```yaml
# gpu-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ollama-gpu-alerts
  namespace: monitoring
spec:
  groups:
    - name: ollama.gpu
      rules:
        - alert: GPUHighTemperature
          expr: |
            DCGM_FI_DEV_GPU_TEMP{namespace="ollama"} > 85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU temperature high on {{ $labels.kubernetes_node }}"
            description: "GPU temperature is {{ $value }}°C — check cooling."

        - alert: GPUMemoryNearCapacity
          expr: |
            (
              DCGM_FI_DEV_FB_USED{namespace="ollama"}
              /
              DCGM_FI_DEV_FB_TOTAL{namespace="ollama"}
            ) > 0.90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "GPU memory >90% used on {{ $labels.kubernetes_pod_name }}"
            description: "GPU memory at {{ $value | humanizePercentage }} — consider smaller models or more replicas."

        - alert: OllamaGPUUnderutilized
          expr: |
            avg by (kubernetes_pod_name) (
              DCGM_FI_DEV_GPU_UTIL{namespace="ollama"}
            ) < 5
          for: 30m
          labels:
            severity: info
          annotations:
            summary: "Ollama GPU underutilized"
            description: "GPU utilization below 5% for 30 minutes — consider scaling down."
```

### Grafana Dashboard for Ollama

```yaml
# ollama-grafana-dashboard-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ollama-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "true"
data:
  ollama.json: |
    {
      "title": "Ollama LLM Dashboard",
      "panels": [
        {
          "title": "Active Models",
          "type": "stat",
          "targets": [{"expr": "ollama_models_loaded", "legendFormat": "Loaded"}]
        },
        {
          "title": "GPU Utilization %",
          "type": "timeseries",
          "targets": [{
            "expr": "avg by (kubernetes_pod_name) (DCGM_FI_DEV_GPU_UTIL{namespace=\"ollama\"})",
            "legendFormat": "{{ kubernetes_pod_name }}"
          }]
        },
        {
          "title": "GPU Memory Used (GiB)",
          "type": "timeseries",
          "targets": [{
            "expr": "sum by (kubernetes_pod_name) (DCGM_FI_DEV_FB_USED{namespace=\"ollama\"}) / 1024",
            "legendFormat": "{{ kubernetes_pod_name }}"
          }]
        },
        {
          "title": "Inference Request Rate",
          "type": "timeseries",
          "targets": [{
            "expr": "rate(ollama_requests_total[5m])",
            "legendFormat": "{{ model }}"
          }]
        }
      ]
    }
```

---

## Section 11: NetworkPolicy and Security

Restrict Ollama access to authorized namespaces only:

```yaml
# ollama-networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ollama-access-control
  namespace: ollama
spec:
  podSelector:
    matchLabels:
      app: ollama
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              ollama-access: "true"
        - podSelector:
            matchLabels:
              app: open-webui
      ports:
        - port: 11434
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 169.254.0.0/16
      ports:
        - port: 443
          protocol: TCP
```

### Resource Quota for Ollama Namespace

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ollama-quota
  namespace: ollama
spec:
  hard:
    requests.nvidia.com/gpu: "8"
    limits.nvidia.com/gpu: "8"
    requests.memory: "256Gi"
    limits.memory: "512Gi"
    pods: "20"
```

---

## Section 12: Production Checklist

```
Infrastructure
  [ ] GPU operator installed and validated
  [ ] Node taints/tolerations configured for GPU isolation
  [ ] ReadWriteMany PVC provisioned for multi-replica deployments
  [ ] Resource quotas set on ollama namespace

Deployment
  [ ] Init container pre-pulls required models
  [ ] Liveness and readiness probes configured
  [ ] PodDisruptionBudget applied
  [ ] topologySpreadConstraints spread replicas across nodes

Autoscaling
  [ ] KEDA ScaledObject targeting pending request queue
  [ ] Cooldown period tuned to model load time (~60–120s)
  [ ] Min replicas = 1 (prevent cold start)

Monitoring
  [ ] DCGM Exporter scrape target registered in Prometheus
  [ ] Ollama sidecar exporter deployed
  [ ] Grafana dashboard imported
  [ ] GPU temperature and memory alerts active

Security
  [ ] NetworkPolicy restricting access to authorized namespaces
  [ ] Secret for Open WebUI stored in Kubernetes Secret, not ConfigMap
  [ ] Image pinned to specific digest, not floating tag
```

---

## Summary

Ollama on Kubernetes delivers self-hosted LLM inference with the operational properties enterprise teams expect: persistent model storage, horizontal scaling, GPU resource isolation, and continuous monitoring. The GPU Operator abstracts driver management. KEDA ensures compute scales with workload demand. Open WebUI provides a production-ready chat interface. The configurations in this guide are designed for teams running 4–8 GPU nodes with a mix of Llama, Mistral, and embedding models powering internal tooling, search augmentation, and developer productivity applications.
