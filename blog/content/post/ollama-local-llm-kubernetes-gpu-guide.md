---
title: "Ollama on Kubernetes: Self-Hosted Local LLM Inference with GPU Support"
date: 2028-10-01T00:00:00-05:00
draft: false
tags: ["Ollama", "LLM", "Kubernetes", "GPU", "AI/ML"]
categories:
- Ollama
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Ollama on Kubernetes with GPU node selectors, persistent model storage, OpenAI-compatible API integration, Go and Python clients, and monitoring inference latency."
more_link: "yes"
url: "/ollama-local-llm-kubernetes-gpu-guide/"
---

Running large language models on your own infrastructure gives you data privacy, cost control, and latency predictability that cloud APIs cannot match. Ollama provides a straightforward runtime for serving models like Llama 3, Mistral, Gemma, and Phi locally, and its OpenAI-compatible API makes migrating existing code trivial. This guide walks through a production-grade Kubernetes deployment covering GPU scheduling, persistent model storage, model lifecycle management, client integration, and observability.

<!--more-->

# Ollama on Kubernetes: Self-Hosted Local LLM Inference with GPU Support

## Why Self-Host LLM Inference

Cloud LLM APIs introduce several constraints that become painful at scale: per-token pricing that compounds for internal tooling, data residency requirements for regulated industries, network round-trip latency, and rate limits that break batch workloads. A properly resourced Kubernetes cluster with GPU nodes can serve most internal use cases at a fraction of the API cost, with sub-100ms time-to-first-token for quantized 7B models on modern A10G hardware.

Ollama handles the complexity of model format conversion, memory management, and API surface. You focus on the Kubernetes plumbing.

## Prerequisites and Cluster Requirements

This guide assumes:

- Kubernetes 1.28 or later
- NVIDIA GPU nodes with drivers installed (version 525 or later)
- NVIDIA Device Plugin or GPU Operator deployed
- `kubectl` with cluster-admin access
- A StorageClass that supports ReadWriteOnce volumes with at least 200 Gi capacity
- cert-manager (optional, for webhook TLS)

Verify the GPU node is visible to the scheduler:

```bash
kubectl get nodes -l accelerator=nvidia-gpu -o custom-columns='NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu'
```

Expected output for an A10G node:

```
NAME                           GPU
gpu-node-a10g-001              1
gpu-node-a10g-002              1
```

## Namespace and RBAC Setup

```yaml
# ollama-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: ollama
  labels:
    app.kubernetes.io/name: ollama
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ollama
  namespace: ollama
  labels:
    app.kubernetes.io/name: ollama
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ollama
  namespace: ollama
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ollama
  namespace: ollama
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ollama
subjects:
  - kind: ServiceAccount
    name: ollama
    namespace: ollama
```

```bash
kubectl apply -f ollama-namespace.yaml
```

## Persistent Volume for Model Storage

Models are large—Llama 3 8B is approximately 4.7 Gi in Q4_K_M quantization, while Llama 3 70B exceeds 40 Gi. Use a dedicated PersistentVolumeClaim that survives pod restarts:

```yaml
# ollama-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ollama-models
  namespace: ollama
  labels:
    app.kubernetes.io/name: ollama
  annotations:
    # Retain the volume when the PVC is deleted to prevent accidental model loss
    helm.sh/resource-policy: keep
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: gp3-encrypted  # Replace with your StorageClass
  resources:
    requests:
      storage: 200Gi
```

```bash
kubectl apply -f ollama-pvc.yaml
kubectl -n ollama get pvc ollama-models
```

## Deployment with GPU Node Selector

The core deployment uses a StatefulSet rather than a Deployment to guarantee stable network identity and ordered rolling updates, both important when managing downloaded model state:

```yaml
# ollama-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ollama
  namespace: ollama
  labels:
    app.kubernetes.io/name: ollama
    app.kubernetes.io/version: "0.3.14"
spec:
  serviceName: ollama-headless
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ollama
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ollama
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "11434"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: ollama
      # Tolerate the GPU taint applied to GPU nodes
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      # Schedule on GPU nodes only
      nodeSelector:
        accelerator: nvidia-gpu
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: nvidia.com/gpu.product
                    operator: In
                    values:
                      - "NVIDIA-A10G"
                      - "NVIDIA-A100-SXM4-40GB"
                      - "NVIDIA-RTX-4090"
      securityContext:
        runAsNonRoot: false  # Ollama requires root for GPU device access
        fsGroup: 0
      initContainers:
        - name: model-dir-setup
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /root/.ollama/models && chmod 755 /root/.ollama"]
          volumeMounts:
            - name: models
              mountPath: /root/.ollama
          securityContext:
            runAsUser: 0
      containers:
        - name: ollama
          image: ollama/ollama:0.3.14
          ports:
            - containerPort: 11434
              name: http
              protocol: TCP
          env:
            - name: OLLAMA_HOST
              value: "0.0.0.0:11434"
            - name: OLLAMA_MODELS
              value: "/root/.ollama/models"
            - name: OLLAMA_NUM_PARALLEL
              value: "2"
            - name: OLLAMA_MAX_LOADED_MODELS
              value: "2"
            - name: OLLAMA_FLASH_ATTENTION
              value: "1"
            # Expose NVIDIA GPU metrics via NVML
            - name: NVIDIA_VISIBLE_DEVICES
              value: "all"
            - name: NVIDIA_DRIVER_CAPABILITIES
              value: "compute,utility"
          resources:
            requests:
              cpu: "2"
              memory: "8Gi"
              nvidia.com/gpu: "1"
            limits:
              cpu: "8"
              memory: "24Gi"
              nvidia.com/gpu: "1"
          volumeMounts:
            - name: models
              mountPath: /root/.ollama
          livenessProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /api/tags
              port: http
            initialDelaySeconds: 15
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 5
          startupProbe:
            httpGet:
              path: /
              port: http
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 30  # Allow 150s for GPU driver initialization
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: ollama-models
---
apiVersion: v1
kind: Service
metadata:
  name: ollama
  namespace: ollama
  labels:
    app.kubernetes.io/name: ollama
spec:
  selector:
    app.kubernetes.io/name: ollama
  ports:
    - name: http
      port: 11434
      targetPort: http
      protocol: TCP
  type: ClusterIP
---
apiVersion: v1
kind: Service
metadata:
  name: ollama-headless
  namespace: ollama
  labels:
    app.kubernetes.io/name: ollama
spec:
  selector:
    app.kubernetes.io/name: ollama
  clusterIP: None
  ports:
    - name: http
      port: 11434
      targetPort: http
```

```bash
kubectl apply -f ollama-statefulset.yaml
kubectl -n ollama rollout status statefulset/ollama
```

## Model Management via API

Ollama exposes a REST API for all model lifecycle operations. Use these from init containers, CI pipelines, or Kubernetes Jobs to pre-pull required models before applications start.

### Pull a Model

```bash
# Port-forward for local testing
kubectl -n ollama port-forward svc/ollama 11434:11434 &

# Pull llama3.2:3b (smallest Llama 3.2 variant, suitable for testing)
curl -X POST http://localhost:11434/api/pull \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.2:3b", "stream": false}'

# Pull a larger model for production
curl -X POST http://localhost:11434/api/pull \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.1:8b-instruct-q4_K_M", "stream": false}'
```

### List Available Models

```bash
curl -s http://localhost:11434/api/tags | jq '.models[] | {name, size, modified_at}'
```

Example output:

```json
{
  "name": "llama3.2:3b",
  "size": 2019393191,
  "modified_at": "2024-09-25T18:30:00.000Z"
}
{
  "name": "llama3.1:8b-instruct-q4_K_M",
  "size": 4920739328,
  "modified_at": "2024-09-25T19:15:00.000Z"
}
```

### Delete a Model

```bash
curl -X DELETE http://localhost:11434/api/delete \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.2:3b"}'
```

### Kubernetes Job for Model Pre-Pull

Use this Job as an init step in your deployment pipeline to ensure models are available before traffic arrives:

```yaml
# ollama-model-pull-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: ollama-pull-llama31-8b
  namespace: ollama
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-weight": "5"
    "helm.sh/hook-delete-policy": hook-succeeded
spec:
  ttlSecondsAfterFinished: 300
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: model-puller
          image: curlimages/curl:8.5.0
          command:
            - sh
            - -c
            - |
              echo "Waiting for Ollama to be ready..."
              until curl -sf http://ollama:11434/api/tags > /dev/null; do
                sleep 5
              done
              echo "Pulling llama3.1:8b-instruct-q4_K_M..."
              curl -X POST http://ollama:11434/api/pull \
                -H "Content-Type: application/json" \
                -d '{"name": "llama3.1:8b-instruct-q4_K_M", "stream": false}' \
                --max-time 1800
              echo "Model pull complete."
          resources:
            requests:
              cpu: "100m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "128Mi"
```

## OpenAI-Compatible API Integration

Ollama implements the OpenAI chat completions API at `/v1/chat/completions`, making it a drop-in replacement for applications already using the OpenAI SDK.

### Basic Chat Completion

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "llama3.1:8b-instruct-q4_K_M",
    "messages": [
      {"role": "system", "content": "You are a helpful DevOps assistant."},
      {"role": "user", "content": "Explain the difference between a Deployment and a StatefulSet in Kubernetes."}
    ],
    "temperature": 0.7,
    "max_tokens": 512
  }'
```

### Streaming Response

```bash
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{
    "model": "llama3.1:8b-instruct-q4_K_M",
    "messages": [{"role": "user", "content": "Write a Go function that retries an HTTP request with exponential backoff."}],
    "stream": true
  }' | while IFS= read -r line; do
    data="${line#data: }"
    if [ "$data" != "[DONE]" ] && [ -n "$data" ]; then
      content=$(echo "$data" | jq -r '.choices[0].delta.content // empty' 2>/dev/null)
      printf "%s" "$content"
    fi
  done
echo
```

## Go Client Implementation

A production Go client should handle connection pooling, retries, timeouts, and context cancellation:

```go
// internal/llm/client.go
package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client wraps the Ollama OpenAI-compatible API.
type Client struct {
	baseURL    string
	httpClient *http.Client
	model      string
}

// ClientOption configures the Client.
type ClientOption func(*Client)

// WithModel sets the default model.
func WithModel(model string) ClientOption {
	return func(c *Client) { c.model = model }
}

// WithTimeout sets the HTTP client timeout.
func WithTimeout(d time.Duration) ClientOption {
	return func(c *Client) { c.httpClient.Timeout = d }
}

// NewClient creates a new Ollama client.
func NewClient(baseURL string, opts ...ClientOption) *Client {
	c := &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 120 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		model: "llama3.1:8b-instruct-q4_K_M",
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// ChatMessage represents a single message in a conversation.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatRequest is the request body for chat completions.
type ChatRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature,omitempty"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
	Stream      bool          `json:"stream"`
}

// ChatResponse is the non-streaming response.
type ChatResponse struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index   int         `json:"index"`
		Message ChatMessage `json:"message"`
		Reason  string      `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

// StreamChunk is a single chunk from a streaming response.
type StreamChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role    string `json:"role,omitempty"`
			Content string `json:"content,omitempty"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
}

// Complete sends a chat completion request and returns the full response.
func (c *Client) Complete(ctx context.Context, messages []ChatMessage, opts ...RequestOption) (*ChatResponse, error) {
	req := ChatRequest{
		Model:    c.model,
		Messages: messages,
		Stream:   false,
	}
	for _, opt := range opts {
		opt(&req)
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshaling request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer ollama")

	start := time.Now()
	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	inferenceLatency.Observe(time.Since(start).Seconds())

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("unexpected status %d: %s", resp.StatusCode, body)
	}

	var chatResp ChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return nil, fmt.Errorf("decoding response: %w", err)
	}

	requestsTotal.WithLabelValues("complete", "success").Inc()
	return &chatResp, nil
}

// StreamOption is a callback for streaming tokens.
type StreamOption func(content string)

// Stream sends a chat completion request and calls handler for each token chunk.
func (c *Client) Stream(ctx context.Context, messages []ChatMessage, handler StreamOption, opts ...RequestOption) error {
	req := ChatRequest{
		Model:    c.model,
		Messages: messages,
		Stream:   true,
	}
	for _, opt := range opts {
		opt(&req)
	}

	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshaling request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer ollama")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || line == "data: [DONE]" {
			continue
		}
		data := line
		if len(line) > 6 && line[:6] == "data: " {
			data = line[6:]
		}
		var chunk StreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) > 0 {
			handler(chunk.Choices[0].Delta.Content)
		}
	}

	return scanner.Err()
}

// RequestOption modifies a ChatRequest.
type RequestOption func(*ChatRequest)

// WithTemperature sets the sampling temperature.
func WithTemperature(t float64) RequestOption {
	return func(r *ChatRequest) { r.Temperature = t }
}

// WithMaxTokens sets the maximum token count.
func WithMaxTokens(n int) RequestOption {
	return func(r *ChatRequest) { r.MaxTokens = n }
}
```

```go
// internal/llm/metrics.go
package llm

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	inferenceLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Namespace: "ollama",
		Name:      "inference_latency_seconds",
		Help:      "End-to-end inference latency in seconds.",
		Buckets:   []float64{0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0},
	})

	requestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "ollama",
		Name:      "requests_total",
		Help:      "Total number of inference requests.",
	}, []string{"type", "status"})
)
```

```go
// cmd/llm-demo/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/yourdomain/app/internal/llm"
)

func main() {
	baseURL := os.Getenv("OLLAMA_URL")
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}

	client := llm.NewClient(baseURL,
		llm.WithModel("llama3.1:8b-instruct-q4_K_M"),
		llm.WithTimeout(60*time.Second),
	)

	ctx := context.Background()

	messages := []llm.ChatMessage{
		{Role: "system", Content: "You are a helpful Kubernetes expert."},
		{Role: "user", Content: "What is the difference between a ConfigMap and a Secret?"},
	}

	// Non-streaming completion
	resp, err := client.Complete(ctx, messages,
		llm.WithTemperature(0.3),
		llm.WithMaxTokens(256),
	)
	if err != nil {
		log.Fatalf("completion failed: %v", err)
	}
	fmt.Println("Response:", resp.Choices[0].Message.Content)
	fmt.Printf("Tokens used: %d prompt + %d completion = %d total\n",
		resp.Usage.PromptTokens,
		resp.Usage.CompletionTokens,
		resp.Usage.TotalTokens,
	)

	// Streaming completion
	fmt.Print("\nStreaming: ")
	err = client.Stream(ctx, []llm.ChatMessage{
		{Role: "user", Content: "Give me a one-sentence summary of Kubernetes."},
	}, func(content string) {
		fmt.Print(content)
	})
	if err != nil {
		log.Fatalf("stream failed: %v", err)
	}
	fmt.Println()
}
```

## Python Client with AsyncIO

For Python-based ML pipelines, use the official `ollama` Python package or the OpenAI SDK:

```python
# inference_client.py
import asyncio
import time
from typing import AsyncIterator
from openai import AsyncOpenAI
import httpx

OLLAMA_BASE_URL = "http://ollama.ollama.svc.cluster.local:11434"

# Initialize the OpenAI-compatible client
client = AsyncOpenAI(
    base_url=f"{OLLAMA_BASE_URL}/v1",
    api_key="ollama",  # Ollama does not verify the key
    http_client=httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=5.0),
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=5),
    ),
)


async def complete(prompt: str, model: str = "llama3.1:8b-instruct-q4_K_M") -> str:
    """Single-turn completion with latency measurement."""
    start = time.perf_counter()
    response = await client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=512,
    )
    latency = time.perf_counter() - start
    tokens = response.usage.total_tokens
    print(f"Latency: {latency:.2f}s | Tokens: {tokens} | TPS: {tokens/latency:.1f}")
    return response.choices[0].message.content


async def stream_complete(prompt: str) -> AsyncIterator[str]:
    """Streaming completion yielding token chunks."""
    async with await client.chat.completions.create(
        model="llama3.1:8b-instruct-q4_K_M",
        messages=[{"role": "user", "content": prompt}],
        stream=True,
    ) as stream:
        async for chunk in stream:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content


async def batch_complete(prompts: list[str], concurrency: int = 4) -> list[str]:
    """Process multiple prompts with limited concurrency."""
    semaphore = asyncio.Semaphore(concurrency)

    async def _complete_with_sem(prompt: str) -> str:
        async with semaphore:
            return await complete(prompt)

    return await asyncio.gather(*[_complete_with_sem(p) for p in prompts])


async def main():
    # Single completion
    result = await complete("Explain Kubernetes namespaces in one paragraph.")
    print("Result:", result)

    # Streaming
    print("\nStreaming output: ", end="", flush=True)
    async for token in stream_complete("What is a Kubernetes operator?"):
        print(token, end="", flush=True)
    print()

    # Batch processing
    prompts = [
        "What is a Pod?",
        "What is a Service?",
        "What is an Ingress?",
        "What is a PersistentVolume?",
    ]
    results = await batch_complete(prompts, concurrency=2)
    for prompt, result in zip(prompts, results):
        print(f"\nQ: {prompt}\nA: {result[:100]}...")


if __name__ == "__main__":
    asyncio.run(main())
```

## Ingress for External Access

Expose Ollama through an Ingress with authentication to prevent unauthorized access:

```yaml
# ollama-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ollama
  namespace: ollama
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "0"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"
    # Basic auth - replace with OAuth2 proxy for production
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: ollama-basic-auth
    nginx.ingress.kubernetes.io/auth-realm: "Ollama LLM API"
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
                  name: http
```

Create the basic auth secret:

```bash
# Install htpasswd if needed: apt-get install apache2-utils
htpasswd -c /tmp/auth ollama-user
kubectl -n ollama create secret generic ollama-basic-auth \
  --from-file=auth=/tmp/auth
rm /tmp/auth
```

## Horizontal Scaling Patterns

Single-GPU Ollama instances are limited by VRAM. For higher throughput, run multiple instances across multiple GPU nodes and load-balance:

```yaml
# ollama-hpa.yaml - Scale based on GPU utilization via DCGM metrics
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ollama
  namespace: ollama
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: StatefulSet
    name: ollama
  minReplicas: 1
  maxReplicas: 4
  metrics:
    - type: External
      external:
        metric:
          name: dcgm_gpu_utilization
          selector:
            matchLabels:
              app.kubernetes.io/name: ollama
        target:
          type: AverageValue
          averageValue: "70"  # Scale when GPU utilization exceeds 70%
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # Wait 5 minutes before scaling down
      policies:
        - type: Pods
          value: 1
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120  # Add at most 1 pod per 2 minutes
```

For multi-instance load balancing, use a dedicated model routing layer:

```yaml
# ollama-load-balancer-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: ollama-lb
  namespace: ollama
  labels:
    app.kubernetes.io/name: ollama
spec:
  selector:
    app.kubernetes.io/name: ollama
  ports:
    - name: http
      port: 11434
      targetPort: http
  sessionAffinity: ClientIP  # Route same client to same instance for context coherence
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 1800  # 30-minute affinity window
  type: ClusterIP
```

## Resource Limits for GPU Workloads

GPU memory is the primary constraint. Use resource quotas to prevent one namespace from monopolizing GPU resources:

```yaml
# gpu-resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: gpu-quota
  namespace: ollama
spec:
  hard:
    requests.nvidia.com/gpu: "4"
    limits.nvidia.com/gpu: "4"
    requests.memory: "96Gi"
    limits.memory: "96Gi"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: gpu-limit-range
  namespace: ollama
spec:
  limits:
    - type: Container
      default:
        nvidia.com/gpu: "1"
      defaultRequest:
        nvidia.com/gpu: "1"
      max:
        nvidia.com/gpu: "2"
```

## Monitoring Inference Latency with Prometheus

Ollama exposes Prometheus metrics at `/metrics`. Configure scraping and create alerting rules:

```yaml
# ollama-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: ollama
  namespace: ollama
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ollama
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
```

```yaml
# ollama-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ollama
  namespace: ollama
  labels:
    release: prometheus
spec:
  groups:
    - name: ollama.rules
      interval: 30s
      rules:
        - alert: OllamaHighInferenceLatency
          expr: |
            histogram_quantile(0.95,
              rate(ollama_inference_latency_seconds_bucket[5m])
            ) > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Ollama P95 inference latency > 30s"
            description: "P95 inference latency is {{ $value | humanizeDuration }}"

        - alert: OllamaHighErrorRate
          expr: |
            rate(ollama_requests_total{status="error"}[5m])
            /
            rate(ollama_requests_total[5m]) > 0.05
          for: 3m
          labels:
            severity: critical
          annotations:
            summary: "Ollama error rate exceeds 5%"
            description: "Error rate is {{ $value | humanizePercentage }}"

        - alert: OllamaGPUUtilizationHigh
          expr: |
            avg(DCGM_FI_DEV_GPU_UTIL{app="ollama"}) > 90
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Ollama GPU utilization consistently above 90%"
            description: "Consider adding GPU nodes or scaling replicas"
```

### Grafana Dashboard Queries

Key PromQL expressions for an Ollama inference dashboard:

```promql
# P50/P95/P99 inference latency
histogram_quantile(0.50, rate(ollama_inference_latency_seconds_bucket[5m]))
histogram_quantile(0.95, rate(ollama_inference_latency_seconds_bucket[5m]))
histogram_quantile(0.99, rate(ollama_inference_latency_seconds_bucket[5m]))

# Request rate (requests per second)
sum(rate(ollama_requests_total{status="success"}[2m]))

# Error rate percentage
sum(rate(ollama_requests_total{status="error"}[2m]))
/ sum(rate(ollama_requests_total[2m])) * 100

# GPU memory utilization (requires DCGM exporter)
DCGM_FI_DEV_FB_USED{namespace="ollama"} / DCGM_FI_DEV_FB_TOTAL{namespace="ollama"} * 100

# Tokens per second (from Ollama native metrics)
rate(ollama_tokens_total[2m])
```

## Troubleshooting Common Issues

### Pod Stuck in Pending State

```bash
# Check if GPU resources are available
kubectl describe pod -n ollama -l app.kubernetes.io/name=ollama | grep -A 10 Events

# Check node capacity
kubectl get nodes -o json | jq '.items[] | {name: .metadata.name, gpu: .status.allocatable["nvidia.com/gpu"]}'

# Verify device plugin is running
kubectl get pods -n kube-system -l name=nvidia-device-plugin-ds
```

### Out-of-Memory Errors

If the model exceeds available VRAM, Ollama will fail to load it. Check:

```bash
# Check current GPU memory usage
kubectl -n ollama exec -it ollama-0 -- nvidia-smi --query-gpu=memory.used,memory.free,memory.total --format=csv

# List loaded models and their memory requirements
curl http://localhost:11434/api/ps | jq '.models[] | {name, size, size_vram}'
```

Reduce the loaded model footprint by using more aggressive quantization (`q4_0` instead of `q4_K_M`) or by setting `OLLAMA_MAX_LOADED_MODELS=1`.

### Slow First-Token Latency

Ollama loads models on first request. Pre-warm by sending a dummy request in the readiness probe or via a startup script:

```bash
# Add to init container or startup script
curl -s -X POST http://localhost:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3.1:8b-instruct-q4_K_M", "prompt": "hello", "stream": false}' \
  > /dev/null
```

## Summary

Deploying Ollama on Kubernetes turns GPU hardware into a shared inference platform that any team can use without cloud API dependencies. The key production considerations are persistent model storage so models survive pod restarts, GPU node affinity and tolerations to ensure pods land on accelerated nodes, resource quotas to prevent noisy neighbors, and proper observability through ServiceMonitors and PrometheusRules.

The OpenAI-compatible API means the migration path from cloud providers to self-hosted inference is a single base URL change, and the Go and Python client patterns shown here integrate naturally with existing service meshes and observability stacks.
