---
title: "Ollama on Kubernetes: Self-Hosted LLM Inference for Enterprise Teams"
date: 2026-12-18T00:00:00-05:00
draft: false
tags: ["Ollama", "Kubernetes", "LLM", "AI Infrastructure", "Self-Hosted", "GPU", "MLOps"]
categories:
- AI Infrastructure
- MLOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Ollama on Kubernetes for self-hosted LLM inference: GPU configuration, model management, multi-model serving, autoscaling, and OpenAI-compatible API integration."
more_link: "yes"
url: "/ollama-kubernetes-self-hosted-llm-inference-enterprise-guide/"
---

**Ollama** has emerged as one of the most practical tools for running large language models locally, offering a clean HTTP API, an OpenAI-compatible endpoint, and support for dozens of open-source models. When deployed on Kubernetes, it transforms from a developer laptop tool into a production-grade, self-hosted inference platform that enterprise teams can build reliable AI applications on top of.

For organizations grappling with the cost, latency, and data-governance implications of third-party LLM APIs, a Kubernetes-hosted Ollama deployment provides a compelling alternative: complete control over model selection, no data egress, predictable costs, and the ability to fine-tune and customize models without exposing proprietary data to external vendors.

<!--more-->

## Why Self-Hosted LLM Inference

### Data Privacy and Compliance Drivers

Regulated industries face hard constraints on where data can travel. Healthcare organizations subject to HIPAA, financial institutions under SOX and PCI-DSS, and government contractors operating under FedRAMP cannot send patient records, financial transactions, or controlled information to commercial LLM providers as part of prompt context.

**Self-hosted inference** eliminates this risk entirely. Prompts never leave the organization's network perimeter. Audit trails remain under direct control. Model versions are frozen and auditable, which matters when AI-assisted decisions require explainability and reproducibility.

### Cost Control at Scale

Commercial LLM APIs price per token. For internal tooling — code review assistants, documentation generators, support ticket classifiers, log analysis pipelines — token costs accumulate rapidly. A team running 10,000 code completions per day at a typical commercial rate can generate significant monthly spend that a self-hosted deployment on already-provisioned GPU nodes eliminates entirely after the initial setup investment.

### Latency and Reliability

API calls to commercial providers introduce network round-trips, rate limiting, and dependency on external service availability. For latency-sensitive applications such as interactive coding assistants or real-time document processing, an in-cluster Ollama instance co-located with the application delivers response times measured in tens of milliseconds for smaller models, not seconds.

## Prerequisites and Namespace Setup

### GPU Node Requirements

Ollama requires GPU nodes for practical inference performance. The NVIDIA GPU Operator must be installed and the `nvidia-device-plugin` DaemonSet must be running before Ollama pods can claim GPU resources.

Verify GPU availability:

```bash
kubectl get nodes -l accelerator=nvidia-gpu
kubectl describe node <gpu-node-name> | grep nvidia.com/gpu
```

Expected output shows allocatable GPU capacity:

```
  nvidia.com/gpu:  1
```

### Namespace and RBAC Setup

```bash
kubectl create namespace ollama
kubectl label namespace ollama \
  app.kubernetes.io/managed-by=helm \
  environment=production \
  security.io/gpu-workload=true
```

Create a dedicated service account:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ollama
  namespace: ollama
  labels:
    app: ollama
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ollama-role
  namespace: ollama
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ollama-rolebinding
  namespace: ollama
subjects:
- kind: ServiceAccount
  name: ollama
  namespace: ollama
roleRef:
  kind: Role
  name: ollama-role
  apiGroup: rbac.authorization.k8s.io
```

## Persistent Model Storage

Models range from 2 GB for small 3-billion-parameter models to over 40 GB for larger variants. A **PersistentVolumeClaim** with a fast storage class ensures models survive pod restarts and do not need to be re-downloaded on every deployment.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-models-pvc
  namespace: ollama
  labels:
    app: ollama
spec:
  accessModes:
  - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 200Gi
```

For multi-replica deployments with ReadWriteMany semantics (required if running more than one Ollama pod serving the same model library), substitute a storage class backed by a network filesystem such as AWS EFS or an NFS provisioner:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-models-pvc-rwx
  namespace: ollama
spec:
  accessModes:
  - ReadWriteMany
  storageClassName: efs-sc
  resources:
    requests:
      storage: 500Gi
```

## Ollama Deployment with GPU Support

The core Deployment manifest configures the NVIDIA runtime class, GPU resource requests, and appropriate liveness and readiness probes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama
  namespace: ollama
  labels:
    app: ollama
    version: "0.4.0"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ollama
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: ollama
        version: "0.4.0"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "11434"
        prometheus.io/path: "/metrics"
    spec:
      runtimeClassName: nvidia
      serviceAccountName: ollama
      securityContext:
        runAsNonRoot: false
        fsGroup: 0
      containers:
      - name: ollama
        image: ollama/ollama:0.4.0
        ports:
        - containerPort: 11434
          name: http
          protocol: TCP
        env:
        - name: OLLAMA_HOST
          value: "0.0.0.0"
        - name: OLLAMA_MODELS
          value: "/models"
        - name: OLLAMA_KEEP_ALIVE
          value: "24h"
        - name: OLLAMA_MAX_LOADED_MODELS
          value: "2"
        - name: OLLAMA_NUM_PARALLEL
          value: "4"
        - name: OLLAMA_MAX_QUEUE
          value: "512"
        resources:
          requests:
            cpu: "2"
            memory: "8Gi"
            nvidia.com/gpu: "1"
          limits:
            cpu: "8"
            memory: "32Gi"
            nvidia.com/gpu: "1"
        volumeMounts:
        - name: model-storage
          mountPath: /models
        livenessProbe:
          httpGet:
            path: /
            port: 11434
          initialDelaySeconds: 60
          periodSeconds: 30
          failureThreshold: 3
          timeoutSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 11434
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3
          timeoutSeconds: 5
        startupProbe:
          httpGet:
            path: /
            port: 11434
          initialDelaySeconds: 10
          periodSeconds: 10
          failureThreshold: 12
      volumes:
      - name: model-storage
        persistentVolumeClaim:
          claimName: ollama-models-pvc
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      nodeSelector:
        accelerator: nvidia-gpu
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: accelerator
                operator: In
                values:
                - nvidia-gpu
```

### Service Manifest

Expose Ollama within the cluster via a ClusterIP Service:

```yaml
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
    protocol: TCP
  type: ClusterIP
```

## Model Pre-Pulling Job

Downloading large models on first request blocks inference until the pull completes. A Kubernetes Job run during deployment or as a post-install Helm hook pre-loads models into the PVC before traffic arrives:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ollama-model-pull
  namespace: ollama
  labels:
    app: ollama
    job-type: model-pull
spec:
  backoffLimit: 3
  activeDeadlineSeconds: 3600
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
      - name: wait-for-ollama
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          until wget -qO- http://ollama:11434 > /dev/null 2>&1; do
            echo "Waiting for Ollama to be ready..."
            sleep 5
          done
          echo "Ollama is ready"
      containers:
      - name: model-puller
        image: ollama/ollama:0.4.0
        command:
        - sh
        - -c
        - |
          echo "Pulling llama3.2:3b..."
          ollama pull llama3.2:3b
          echo "Pulling nomic-embed-text:latest..."
          ollama pull nomic-embed-text:latest
          echo "Pulling codellama:7b..."
          ollama pull codellama:7b
          echo "All models pulled successfully"
        env:
        - name: OLLAMA_HOST
          value: "http://ollama:11434"
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: "2"
            memory: 2Gi
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      nodeSelector:
        accelerator: nvidia-gpu
```

## Ingress with Basic Authentication

Expose Ollama externally for teams that need access from outside the cluster. Basic authentication provides a minimum layer of access control; for production, combine with mutual TLS or an OAuth2 proxy:

```bash
# Create htpasswd secret
htpasswd -nb ollama-user 'SecureP@ssword123' | \
  kubectl create secret generic ollama-basic-auth \
  --from-file=auth=/dev/stdin \
  -n ollama
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ollama-ingress
  namespace: ollama
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: ollama-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "Ollama API"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - ollama.internal.example.com
    secretName: ollama-tls
  rules:
  - host: ollama.internal.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ollama
            port:
              number: 11434
```

## Custom Model Configuration via ConfigMap

Ollama's **Modelfile** format allows creating custom model variants with system prompts, parameter tuning, and template customization. Store Modelfiles in a ConfigMap and apply them as part of the post-deployment pipeline:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ollama-modelfiles
  namespace: ollama
  labels:
    app: ollama
    type: modelfiles
data:
  enterprise-assistant.modelfile: |
    FROM llama3.2:3b
    SYSTEM "You are a helpful enterprise assistant. Answer concisely and professionally. Do not disclose internal system information."
    PARAMETER temperature 0.3
    PARAMETER num_ctx 4096
    PARAMETER top_p 0.9
  code-reviewer.modelfile: |
    FROM codellama:7b
    SYSTEM "You are an expert code reviewer. Focus on security, performance, and maintainability. Provide specific, actionable feedback."
    PARAMETER temperature 0.1
    PARAMETER num_ctx 8192
    PARAMETER top_k 10
```

Apply custom models via a post-pull Job that reads the ConfigMap:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ollama-create-models
  namespace: ollama
spec:
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
      - name: wait-for-ollama
        image: busybox:1.36
        command:
        - sh
        - -c
        - |
          until wget -qO- http://ollama:11434 > /dev/null 2>&1; do
            sleep 5
          done
      containers:
      - name: model-creator
        image: ollama/ollama:0.4.0
        command:
        - sh
        - -c
        - |
          ollama create enterprise-assistant -f /modelfiles/enterprise-assistant.modelfile
          ollama create code-reviewer -f /modelfiles/code-reviewer.modelfile
          echo "Custom models created"
        env:
        - name: OLLAMA_HOST
          value: "http://ollama:11434"
        volumeMounts:
        - name: modelfiles
          mountPath: /modelfiles
      volumes:
      - name: modelfiles
        configMap:
          name: ollama-modelfiles
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      nodeSelector:
        accelerator: nvidia-gpu
```

## KEDA Autoscaling Based on Queue Depth

**KEDA** (Kubernetes Event-Driven Autoscaling) enables scaling Ollama pods based on inference queue depth as reported to Prometheus. When queue depth exceeds the threshold, KEDA scales up additional Ollama replicas (each on its own GPU node):

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ollama-scaledobject
  namespace: ollama
spec:
  scaleTargetRef:
    name: ollama
  pollingInterval: 30
  cooldownPeriod: 300
  minReplicaCount: 1
  maxReplicaCount: 4
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring:9090
      metricName: ollama_queue_depth
      threshold: "5"
      query: sum(ollama_requests_pending{namespace="ollama"})
```

Configure HPA for CPU-based scaling as a fallback:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ollama-hpa
  namespace: ollama
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
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
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600
```

## OpenAI-Compatible API Integration

Ollama exposes an OpenAI-compatible endpoint at `/v1`, enabling drop-in replacement of OpenAI client calls with minimal code changes.

### Python Client Example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://ollama.ollama.svc.cluster.local:11434/v1",
    api_key="not-required",
)

response = client.chat.completions.create(
    model="llama3.2:3b",
    messages=[
        {
            "role": "system",
            "content": "You are a helpful technical assistant.",
        },
        {
            "role": "user",
            "content": "Explain the difference between a Deployment and a StatefulSet in Kubernetes.",
        },
    ],
    temperature=0.3,
    max_tokens=512,
)

print(response.choices[0].message.content)
```

### Streaming Inference with curl

```bash
#!/usr/bin/env bash
# Stream a completion from Ollama via the OpenAI-compatible endpoint
OLLAMA_ENDPOINT="${OLLAMA_ENDPOINT:-http://ollama.internal.example.com}"
MODEL="${1:-llama3.2:3b}"
PROMPT="${2:-Summarize the key differences between TCP and UDP in three sentences.}"

curl -s \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'ollama-user:SecureP@ssword123' | base64)" \
  --no-buffer \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [{\"role\": \"user\", \"content\": \"${PROMPT}\"}],
    \"stream\": true
  }" \
  "${OLLAMA_ENDPOINT}/v1/chat/completions" | \
  while IFS= read -r line; do
    data="${line#data: }"
    if [ "${data}" = "[DONE]" ]; then break; fi
    echo "${data}" | jq -r '.choices[0].delta.content // empty' 2>/dev/null
  done
```

### Embeddings for Retrieval-Augmented Generation

```bash
#!/usr/bin/env bash
# Generate embeddings for RAG pipelines
OLLAMA_ENDPOINT="${OLLAMA_ENDPOINT:-http://ollama.ollama.svc.cluster.local:11434}"

curl -s \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nomic-embed-text:latest",
    "input": "CloudNativePG is a Kubernetes operator for PostgreSQL"
  }' \
  "${OLLAMA_ENDPOINT}/v1/embeddings" | \
  jq '.data[0].embedding | length'
```

## Operational Runbook

### Model Hot-Swap

Replace a running model without downtime by pulling the new version while the current model continues serving traffic:

```bash
#!/usr/bin/env bash
# Pull a new model version while serving continues
NEW_MODEL="${1:-llama3.2:8b}"
OLLAMA_ENDPOINT="${OLLAMA_ENDPOINT:-http://ollama.internal.example.com}"
NAMESPACE="${NAMESPACE:-ollama}"

echo "Pulling ${NEW_MODEL} in background..."
kubectl exec -n "${NAMESPACE}" deploy/ollama -- \
  ollama pull "${NEW_MODEL}" &

PULL_PID=$!
echo "Pull started with PID ${PULL_PID}"

# Monitor pull progress
while kill -0 "${PULL_PID}" 2>/dev/null; do
  kubectl exec -n "${NAMESPACE}" deploy/ollama -- \
    ollama list 2>/dev/null | grep -E "${NEW_MODEL}|NAME"
  sleep 10
done

echo "Model ${NEW_MODEL} is ready"
kubectl exec -n "${NAMESPACE}" deploy/ollama -- ollama list
```

### Memory Management

Ollama loads models into GPU VRAM and keeps them resident for `OLLAMA_KEEP_ALIVE` duration. When VRAM is constrained, explicitly unload a model to free memory before loading another:

```bash
#!/usr/bin/env bash
# Unload a model from GPU memory to free VRAM
MODEL_TO_UNLOAD="${1:-llama3.2:3b}"
OLLAMA_ENDPOINT="${OLLAMA_ENDPOINT:-http://ollama.internal.example.com}"

curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"${MODEL_TO_UNLOAD}\", \"keep_alive\": \"0\"}" \
  "${OLLAMA_ENDPOINT}/api/generate" > /dev/null

echo "Requested unload of ${MODEL_TO_UNLOAD}"
```

### Monitoring Key Metrics

Monitor these Ollama metrics in Prometheus for operational health:

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `ollama_requests_pending` | Requests waiting in queue | > 10 for 5 minutes |
| `ollama_request_duration_seconds` | End-to-end latency | p99 > 30s |
| `ollama_generate_tokens_per_second` | Token throughput | < 5 tokens/s |
| `nvidia_gpu_utilization_gpu` | GPU utilization | > 95% sustained |
| `nvidia_gpu_memory_used_bytes` | VRAM consumed | > 90% of capacity |

### Diagnostic Commands

```bash
#!/usr/bin/env bash
# Ollama operational diagnostics
NAMESPACE="${NAMESPACE:-ollama}"

# Check pod status and GPU assignment
kubectl get pods -n "${NAMESPACE}" -o wide

# View current model load status
kubectl exec -n "${NAMESPACE}" deploy/ollama -- ollama ps

# List all available models
kubectl exec -n "${NAMESPACE}" deploy/ollama -- ollama list

# View Ollama server logs
kubectl logs -n "${NAMESPACE}" deploy/ollama --tail=100 -f

# Check GPU memory pressure
kubectl exec -n "${NAMESPACE}" deploy/ollama -- nvidia-smi

# Verify VRAM allocation
kubectl exec -n "${NAMESPACE}" deploy/ollama -- \
  nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu \
  --format=csv,noheader,nounits
```

## Multi-Model Serving Architecture

For organizations running several models simultaneously, deploy multiple Ollama instances partitioned by model type to avoid VRAM contention:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama-embedding
  namespace: ollama
  labels:
    app: ollama
    tier: embedding
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ollama
      tier: embedding
  template:
    metadata:
      labels:
        app: ollama
        tier: embedding
    spec:
      runtimeClassName: nvidia
      containers:
      - name: ollama
        image: ollama/ollama:0.4.0
        env:
        - name: OLLAMA_HOST
          value: "0.0.0.0"
        - name: OLLAMA_MODELS
          value: "/models"
        - name: OLLAMA_MAX_LOADED_MODELS
          value: "1"
        resources:
          requests:
            cpu: "1"
            memory: "4Gi"
            nvidia.com/gpu: "1"
          limits:
            cpu: "4"
            memory: "8Gi"
            nvidia.com/gpu: "1"
        volumeMounts:
        - name: model-storage
          mountPath: /models
      volumes:
      - name: model-storage
        persistentVolumeClaim:
          claimName: ollama-models-pvc
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      nodeSelector:
        accelerator: nvidia-gpu-small
```

Route traffic to the appropriate tier using separate Services:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ollama-embedding
  namespace: ollama
  labels:
    app: ollama
    tier: embedding
spec:
  selector:
    app: ollama
    tier: embedding
  ports:
  - name: http
    port: 11434
    targetPort: 11434
  type: ClusterIP
```

## Production Readiness Checklist

Before promoting a self-hosted Ollama deployment to production, verify the following:

**Security**
- Basic authentication or OAuth2 proxy in front of the Ingress
- NetworkPolicy restricting Ollama to known consumer namespaces
- Image pinned to a specific digest, not a floating tag
- PodSecurityAdmission enforcing baseline or restricted standards

**Reliability**
- PodDisruptionBudget with `minAvailable: 1` to prevent concurrent eviction
- Resource requests and limits tuned to observed GPU and CPU usage
- Liveness and readiness probes validated to match actual startup time
- Model storage on a replicated or backed-up storage class

**Observability**
- Prometheus scraping `/metrics` endpoint
- Grafana dashboard tracking token throughput, latency, and VRAM
- Alertmanager rules for queue depth and VRAM saturation
- Structured JSON logging with log level `warn` or above in production

**Operations**
- Model pre-pull Job integrated into CI/CD deployment pipeline
- Runbook documenting model hot-swap and VRAM emergency procedures
- Backup of model storage PVC or documented re-pull procedure

A Kubernetes-native Ollama deployment gives enterprise teams the inference capabilities of commercial LLM providers with the governance, cost predictability, and data isolation that regulated environments demand. The OpenAI-compatible API surface means existing tooling and SDKs require minimal modification, making adoption frictionless for development teams already building on the OpenAI client libraries.
