---
title: "Ollama on Kubernetes: Self-Hosted LLM Deployment for Enterprise"
date: 2027-12-17T00:00:00-05:00
draft: false
tags: ["Ollama", "Kubernetes", "LLM", "GPU", "StatefulSet", "Open-WebUI", "AI", "Self-Hosted"]
categories:
- Kubernetes
- AI/ML
- GPU
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to deploying Ollama on Kubernetes with GPU node selection, model persistence via PVCs, Open WebUI integration, REST API serving patterns, and multi-node inference for enterprise self-hosted LLM workloads."
more_link: "yes"
url: "/ollama-kubernetes-local-llm-deployment-guide/"
---

Ollama abstracts the complexity of running local LLMs behind a clean HTTP API and a library of pre-quantized model manifests. Deploying it on Kubernetes provides GPU-backed inference for internal tooling without sending prompts to external providers. This guide covers StatefulSet design rationale, GPU node affinity, PVC-backed model persistence, REST API patterns, Open WebUI for browser access, resource limit design for GPU workloads, and patterns for multi-model registries.

<!--more-->

# Ollama on Kubernetes: Self-Hosted LLM Deployment for Enterprise

## Why Ollama in a Kubernetes Context

Ollama's value proposition in an enterprise is data residency: prompts and context windows never leave the cluster perimeter. For use cases involving code review, internal documentation search, PII-heavy data pipelines, or regulated industries where external API calls are prohibited, self-hosted inference is not optional.

Kubernetes adds:
- **Reproducible deployments** with version-pinned container images
- **GPU resource quotas** enforced at the namespace level
- **Health probe integration** with readiness gates
- **Storage lifecycle management** for model persistence
- **RBAC** for controlling which teams can schedule GPU pods

Ollama's REST API (`/api/generate`, `/api/chat`, `/api/embeddings`) is compatible with a growing ecosystem of clients, and its OpenAI-compatible endpoint (`/v1/chat/completions`) eliminates the need for adapter layers when migrating workloads.

## Namespace and RBAC Setup

```yaml
# ollama-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ollama
  labels:
    team: ai-platform
    cost-center: engineering
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ollama-gpu-quota
  namespace: ollama
spec:
  hard:
    requests.nvidia.com/gpu: "4"
    limits.nvidia.com/gpu: "4"
    requests.memory: "256Gi"
    limits.memory: "512Gi"
    requests.cpu: "64"
    limits.cpu: "128"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ollama-operator
  namespace: ollama
rules:
  - apiGroups: ["apps"]
    resources: ["statefulsets", "deployments"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
```

## GPU Node Preparation

Taint GPU nodes to prevent non-GPU workloads from consuming the scarce resource:

```bash
kubectl taint node gpu-node-01 nvidia.com/gpu=present:NoSchedule
kubectl taint node gpu-node-02 nvidia.com/gpu=present:NoSchedule

kubectl label node gpu-node-01 nvidia.com/gpu.product=RTX-4090
kubectl label node gpu-node-01 workload-type=llm-inference
kubectl label node gpu-node-02 nvidia.com/gpu.product=A10G
kubectl label node gpu-node-02 workload-type=llm-inference
```

Verify GPU operator device plugin is running:

```bash
kubectl get pods -n gpu-operator -l app=nvidia-device-plugin-daemonset
kubectl describe node gpu-node-01 | grep -E "nvidia.com/gpu"
# Capacity:
#   nvidia.com/gpu: 1
# Allocatable:
#   nvidia.com/gpu: 1
```

## Persistent Storage for Models

Ollama stores models in `~/.ollama/models` inside the container. A dedicated PVC with sufficient capacity prevents re-pulling models across pod restarts.

For single-node deployments (ReadWriteOnce is sufficient):

```yaml
# ollama-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-models
  namespace: ollama
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path
  resources:
    requests:
      storage: 200Gi
```

For multi-replica deployments across different nodes, use ReadWriteMany:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-models-shared
  namespace: ollama
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-csi
  resources:
    requests:
      storage: 500Gi
```

## StatefulSet Deployment

StatefulSet is preferred over Deployment when models are large and re-pull time is significant. StatefulSets maintain stable pod identity and volume bindings through rolling updates, ensuring each replica retains its own model cache.

```yaml
# ollama-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ollama
  namespace: ollama
  labels:
    app: ollama
    version: "0.5.0"
spec:
  serviceName: ollama-headless
  replicas: 2
  selector:
    matchLabels:
      app: ollama
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0
  template:
    metadata:
      labels:
        app: ollama
        version: "0.5.0"
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "11434"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: ollama
      nodeSelector:
        workload-type: llm-inference
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      securityContext:
        fsGroup: 1000
        runAsUser: 1000
        runAsGroup: 1000
      initContainers:
        - name: init-model-dir
          image: busybox:1.36
          command:
            - /bin/sh
            - -c
            - |
              mkdir -p /root/.ollama/models
              chown -R 1000:1000 /root/.ollama
          volumeMounts:
            - name: ollama-data
              mountPath: /root/.ollama
          securityContext:
            runAsUser: 0
      containers:
        - name: ollama
          image: ollama/ollama:0.5.0
          ports:
            - containerPort: 11434
              name: http
          env:
            - name: OLLAMA_HOST
              value: "0.0.0.0:11434"
            - name: OLLAMA_MODELS
              value: "/data/models"
            - name: OLLAMA_NUM_PARALLEL
              value: "4"
            - name: OLLAMA_MAX_LOADED_MODELS
              value: "2"
            - name: OLLAMA_FLASH_ATTENTION
              value: "true"
            - name: OLLAMA_KV_CACHE_TYPE
              value: "q8_0"
            - name: CUDA_VISIBLE_DEVICES
              value: "0"
          resources:
            requests:
              nvidia.com/gpu: "1"
              memory: "16Gi"
              cpu: "4"
            limits:
              nvidia.com/gpu: "1"
              memory: "48Gi"
              cpu: "8"
          volumeMounts:
            - name: ollama-data
              mountPath: /data
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
            initialDelaySeconds: 15
            periodSeconds: 10
            failureThreshold: 6
          startupProbe:
            httpGet:
              path: /api/tags
              port: 11434
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 30
  volumeClaimTemplates:
    - metadata:
        name: ollama-data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: local-path
        resources:
          requests:
            storage: 200Gi
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ollama
  namespace: ollama
---
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
    - port: 11434
      targetPort: 11434
      name: http
  type: ClusterIP
---
apiVersion: v1
kind: Service
metadata:
  name: ollama-headless
  namespace: ollama
spec:
  selector:
    app: ollama
  clusterIP: None
  ports:
    - port: 11434
      targetPort: 11434
      name: http
```

## Model Initialization with a Job

A one-time Job pulls the required models into the shared storage before any inference pods serve traffic:

```yaml
# ollama-model-init-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ollama-model-init
  namespace: ollama
  annotations:
    "helm.sh/hook": post-install
    "helm.sh/hook-weight": "5"
spec:
  template:
    spec:
      restartPolicy: OnFailure
      nodeSelector:
        workload-type: llm-inference
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      initContainers:
        - name: wait-for-ollama
          image: curlimages/curl:8.7.1
          command:
            - /bin/sh
            - -c
            - |
              until curl -sf http://ollama.ollama.svc.cluster.local:11434/api/tags; do
                echo "Waiting for Ollama to be ready..."
                sleep 5
              done
      containers:
        - name: pull-models
          image: curlimages/curl:8.7.1
          command:
            - /bin/sh
            - -c
            - |
              OLLAMA_URL="http://ollama.ollama.svc.cluster.local:11434"

              pull_model() {
                MODEL=$1
                echo "Pulling model: ${MODEL}"
                curl -sf -X POST "${OLLAMA_URL}/api/pull" \
                  -H "Content-Type: application/json" \
                  -d "{\"name\": \"${MODEL}\", \"stream\": false}" \
                  --max-time 3600
                echo "Model ${MODEL} pulled successfully"
              }

              pull_model "llama3.2:3b"
              pull_model "llama3.1:8b"
              pull_model "nomic-embed-text:latest"
              pull_model "codellama:7b-code"
              echo "All models pulled successfully"
```

## REST API Patterns

Ollama's API surface covers the core inference workflows. Examples using standard curl against the in-cluster service:

### Generate Completion

```bash
curl -X POST http://ollama.ollama.svc.cluster.local:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1:8b",
    "prompt": "Explain Kubernetes StatefulSets in three sentences.",
    "stream": false,
    "options": {
      "temperature": 0.7,
      "num_ctx": 4096,
      "num_predict": 512,
      "top_p": 0.9
    }
  }'
```

### Chat Completion (OpenAI-Compatible)

```bash
curl -X POST http://ollama.ollama.svc.cluster.local:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1:8b",
    "messages": [
      {"role": "system", "content": "You are a Kubernetes expert."},
      {"role": "user", "content": "What is a PodDisruptionBudget?"}
    ],
    "temperature": 0.7,
    "max_tokens": 1024
  }'
```

### Embeddings

```bash
curl -X POST http://ollama.ollama.svc.cluster.local:11434/api/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nomic-embed-text",
    "prompt": "Kubernetes cluster autoscaler scales node pools based on pending pods."
  }'
```

### List Available Models

```bash
curl http://ollama.ollama.svc.cluster.local:11434/api/tags | jq '.models[].name'
```

## Open WebUI Integration

Open WebUI provides a browser-based chat interface compatible with Ollama's API.

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
  replicas: 1
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
          image: ghcr.io/open-webui/open-webui:v0.4.8
          ports:
            - containerPort: 8080
              name: http
          env:
            - name: OLLAMA_BASE_URL
              value: "http://ollama.ollama.svc.cluster.local:11434"
            - name: WEBUI_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: open-webui-secret
                  key: secret-key
            - name: WEBUI_AUTH
              value: "true"
            - name: ENABLE_SIGNUP
              value: "false"
            - name: DEFAULT_USER_ROLE
              value: "user"
            - name: ENABLE_ADMIN_EXPORT
              value: "false"
            - name: ENABLE_COMMUNITY_SHARING
              value: "false"
          resources:
            requests:
              memory: "512Mi"
              cpu: "500m"
            limits:
              memory: "2Gi"
              cpu: "2"
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
kind: PersistentVolumeClaim
metadata:
  name: open-webui-data
  namespace: ollama
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path
  resources:
    requests:
      storage: 10Gi
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
      name: http
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: open-webui
  namespace: ollama
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - chat.internal.example.com
      secretName: open-webui-tls
  rules:
    - host: chat.internal.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: open-webui
                port:
                  name: http
```

## Model Registry Pattern

For managing a catalog of approved models, a ConfigMap registry allows teams to declare which models should be available without direct API access to Ollama:

```yaml
# model-registry-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ollama-model-registry
  namespace: ollama
data:
  models.yaml: |
    models:
      - name: llama3.1:8b
        description: "General purpose chat and reasoning"
        teams: ["engineering", "product", "support"]
        max_context: 8192
        approved: true

      - name: llama3.2:3b
        description: "Fast lightweight model for simple tasks"
        teams: ["all"]
        max_context: 4096
        approved: true

      - name: codellama:7b-code
        description: "Code generation and review"
        teams: ["engineering"]
        max_context: 4096
        approved: true

      - name: nomic-embed-text:latest
        description: "Text embeddings for RAG pipelines"
        teams: ["engineering", "data"]
        max_context: 2048
        approved: true

      - name: llama3.1:70b
        description: "High-capability model for complex reasoning"
        teams: ["ml-platform"]
        max_context: 8192
        approved: true
        gpu_required: 4
```

A CronJob synchronizes the registry with the running Ollama instance:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ollama-model-sync
  namespace: ollama
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: sync
              image: python:3.11-slim
              command:
                - /bin/sh
                - -c
                - |
                  pip install -q pyyaml requests
                  python3 /scripts/sync_models.py
              volumeMounts:
                - name: registry
                  mountPath: /config
                - name: scripts
                  mountPath: /scripts
          volumes:
            - name: registry
              configMap:
                name: ollama-model-registry
            - name: scripts
              configMap:
                name: ollama-sync-scripts
```

## Horizontal Pod Autoscaling

Ollama does not expose a standard `vllm:num_requests_waiting` metric. However, the active request count can be surfaced via a custom exporter or by scraping the `/api/ps` endpoint:

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
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 120
      policies:
        - type: Pods
          value: 1
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
        - type: Pods
          value: 1
          periodSeconds: 300
```

For GPU-aware autoscaling with KEDA, expose active inference count:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ollama-scaler
  namespace: ollama
spec:
  scaleTargetRef:
    name: ollama
    kind: StatefulSet
  minReplicaCount: 1
  maxReplicaCount: 4
  cooldownPeriod: 600
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: ollama_active_requests
        query: |
          sum(ollama_active_requests{namespace="ollama"})
        threshold: "3"
```

## Prometheus Monitoring

Deploy a sidecar or separate exporter to surface Ollama metrics. Ollama includes a native `/metrics` endpoint in recent versions:

```yaml
# ollama-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ollama
  namespace: ollama
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app: ollama
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
```

Alert rules for Ollama:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ollama-alerts
  namespace: ollama
spec:
  groups:
    - name: ollama.rules
      rules:
        - alert: OllamaDown
          expr: up{job="ollama", namespace="ollama"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Ollama instance is down"
            description: "{{ $labels.pod }} has been unreachable for 2 minutes"

        - alert: OllamaHighMemoryUsage
          expr: |
            container_memory_working_set_bytes{
              namespace="ollama",
              container="ollama"
            } / container_spec_memory_limit_bytes{
              namespace="ollama",
              container="ollama"
            } > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ollama memory usage above 85%"

        - alert: OllamaGPUMemoryFull
          expr: |
            DCGM_FI_DEV_FB_USED{namespace="ollama"}
              / DCGM_FI_DEV_FB_TOTAL{namespace="ollama"} > 0.95
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Ollama GPU VRAM above 95%"
```

## Multi-Node Inference with Distributed Serving

For models exceeding a single node's GPU capacity, Ollama can distribute inference across a cluster using its experimental distributed mode. This requires setting coordinator and worker nodes:

```yaml
# ollama-coordinator.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ollama-coordinator
  namespace: ollama
spec:
  serviceName: ollama-coordinator-headless
  replicas: 1
  selector:
    matchLabels:
      app: ollama
      role: coordinator
  template:
    metadata:
      labels:
        app: ollama
        role: coordinator
    spec:
      nodeSelector:
        workload-type: llm-inference
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      containers:
        - name: ollama
          image: ollama/ollama:0.5.0
          env:
            - name: OLLAMA_HOST
              value: "0.0.0.0:11434"
            - name: OLLAMA_SCHED_SPREAD
              value: "true"
          resources:
            requests:
              nvidia.com/gpu: "1"
              memory: "32Gi"
              cpu: "8"
            limits:
              nvidia.com/gpu: "1"
              memory: "64Gi"
              cpu: "16"
          volumeMounts:
            - name: ollama-data
              mountPath: /root/.ollama
  volumeClaimTemplates:
    - metadata:
        name: ollama-data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: local-path
        resources:
          requests:
            storage: 200Gi
```

## Security Hardening

Ollama does not provide built-in authentication. Protect the API with network policies and an authenticating proxy.

```yaml
# ollama-networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ollama-ingress-policy
  namespace: ollama
spec:
  podSelector:
    matchLabels:
      app: ollama
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ollama
        - namespaceSelector:
            matchLabels:
              network-policy: allow-ollama-access
      ports:
        - protocol: TCP
          port: 11434
```

For external access, deploy oauth2-proxy in front of Open WebUI:

```yaml
# oauth2-proxy-deployment.yaml (abbreviated)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oauth2-proxy
  namespace: ollama
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oauth2-proxy
  template:
    metadata:
      labels:
        app: oauth2-proxy
    spec:
      containers:
        - name: oauth2-proxy
          image: quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
          args:
            - --provider=oidc
            - --oidc-issuer-url=https://auth.example.com/realms/internal
            - --upstream=http://open-webui.ollama.svc.cluster.local
            - --http-address=0.0.0.0:4180
            - --email-domain=example.com
            - --cookie-secure=true
            - --cookie-httponly=true
            - --skip-provider-button=true
          env:
            - name: OAUTH2_PROXY_CLIENT_ID
              valueFrom:
                secretKeyRef:
                  name: oauth2-proxy-secret
                  key: client-id
            - name: OAUTH2_PROXY_CLIENT_SECRET
              valueFrom:
                secretKeyRef:
                  name: oauth2-proxy-secret
                  key: client-secret
            - name: OAUTH2_PROXY_COOKIE_SECRET
              valueFrom:
                secretKeyRef:
                  name: oauth2-proxy-secret
                  key: cookie-secret
          resources:
            requests:
              memory: "128Mi"
              cpu: "100m"
            limits:
              memory: "256Mi"
              cpu: "200m"
```

## Troubleshooting

### Model Fails to Load

```bash
kubectl exec -it ollama-0 -n ollama -- ollama list
kubectl exec -it ollama-0 -n ollama -- ollama show llama3.1:8b
kubectl logs ollama-0 -n ollama --previous
```

Common cause: insufficient GPU VRAM for the requested model. Verify with DCGM exporter:

```bash
kubectl exec -it nvidia-dcgm-exporter-xxxx -n gpu-operator -- \
  nvidia-smi --query-gpu=memory.used,memory.free,memory.total --format=csv
```

### Slow First-Token Latency

Cause: Model not loaded in GPU memory (cold start). Ollama lazy-loads models on first request.

Solution: Pre-warm the model after startup:

```bash
kubectl exec -it ollama-0 -n ollama -- \
  curl -X POST http://localhost:11434/api/generate \
  -d '{"model": "llama3.1:8b", "prompt": "warmup", "stream": false}' \
  --max-time 300
```

Or use a readiness probe that validates model availability:

```yaml
readinessProbe:
  exec:
    command:
      - /bin/sh
      - -c
      - |
        curl -sf -X POST http://localhost:11434/api/generate \
          -d '{"model": "llama3.1:8b", "prompt": "ping", "stream": false, "options": {"num_predict": 1}}' \
          --max-time 30
  initialDelaySeconds: 60
  periodSeconds: 30
  failureThreshold: 10
```

### PVC Mount Fails on Node Reuse

Cause: `local-path` StorageClass binds PVCs to a specific node. When the StatefulSet pod reschedules to a different node, the volume cannot attach.

Resolution: Use a distributed storage class (Longhorn, Rook-Ceph) or configure node affinity for the StatefulSet pods to pin to the same nodes where PVs reside.

## Resource Sizing Reference

| Model | VRAM Required | RAM Required | CPU (minimum) | Quantization |
|-------|--------------|--------------|----------------|--------------|
| llama3.2:3b | 3GB | 8GB | 4 | Q4_K_M |
| llama3.1:8b | 8GB | 16GB | 4 | Q4_K_M |
| llama3.1:8b-fp16 | 16GB | 24GB | 8 | FP16 |
| codellama:7b | 7GB | 16GB | 4 | Q4_K_M |
| llama3.1:70b | 43GB | 64GB | 16 | Q4_K_M |
| llama3.1:70b-fp16 | 140GB | 160GB | 32 | FP16 |

## Summary

Deploying Ollama on Kubernetes provides a production-ready, data-residency-compliant LLM inference platform. The critical elements are:

1. StatefulSet with volumeClaimTemplates for stable model storage across rolling updates
2. GPU node taints and tolerations ensuring only LLM pods consume GPU capacity
3. ReadWriteMany PVCs for shared model storage in multi-replica setups
4. Open WebUI deployed behind oauth2-proxy for browser access with enterprise SSO
5. NetworkPolicy restricting Ollama API access to authorized namespaces only
6. KEDA-based autoscaling on active inference metrics
7. Model registry ConfigMap as a declarative catalog of approved models
