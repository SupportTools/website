---
title: "K8sGPT: AI-Powered Kubernetes Diagnostics and Cluster Analysis"
date: 2027-03-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "K8sGPT", "AI", "Diagnostics", "Observability"]
categories: ["Kubernetes", "AI/ML", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying K8sGPT for AI-assisted Kubernetes troubleshooting, covering analyzers, backends (OpenAI, Ollama, local models), Operator mode, custom analyzers, and integration with Slack and PagerDuty."
more_link: "yes"
url: "/k8sgpt-ai-kubernetes-diagnostics-guide/"
---

Kubernetes clusters produce a constant stream of events, conditions, and resource states that engineers must interpret quickly under pressure. K8sGPT bridges the gap between raw Kubernetes API output and actionable remediation advice by sending cluster diagnostics to an AI backend and returning natural-language explanations. This guide covers the full production deployment path: CLI usage, Operator mode, AI backend configuration, custom analyzers, anonymization, and alert integration with Slack and PagerDuty.

<!--more-->

## Section 1: K8sGPT Architecture Overview

K8sGPT operates in two primary modes: a standalone CLI for interactive investigation and an in-cluster Operator that continuously monitors and surfaces issues.

### CLI Mode

The CLI connects directly to the Kubernetes API server using the current kubeconfig context, runs a configurable set of analyzers against cluster resources, and submits findings to the configured AI backend. Results are printed to stdout or exported as JSON/YAML.

```
┌─────────────────────────────────────────────────────────────────┐
│                         kubectl / CI                             │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  k8sgpt CLI     │
                    │  (local binary) │
                    └───────┬────────┘
                            │  kubeconfig
              ┌─────────────▼──────────────┐
              │     Kubernetes API Server   │
              │  (pods, events, conditions) │
              └─────────────┬──────────────┘
                            │  findings
              ┌─────────────▼──────────────┐
              │      AI Backend             │
              │  OpenAI / Claude / Ollama   │
              └─────────────┬──────────────┘
                            │  explanation
              ┌─────────────▼──────────────┐
              │       stdout / JSON         │
              └────────────────────────────┘
```

### Operator Mode

The K8sGPT Operator runs as a Deployment inside the cluster and exposes two CRDs:

- `K8sGPT` — cluster-scoped configuration object defining backend, analyzers, and notification sinks
- `Result` — namespace-scoped resource created for each identified issue

The Operator reconciles `Result` objects continuously and forwards them to configured integrations.

```
┌──────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                         │
│                                                              │
│  ┌─────────────┐     ┌──────────────────┐                   │
│  │ K8sGPT CRD  │────▶│  k8sgpt-operator │                   │
│  └─────────────┘     │  (Deployment)    │                   │
│                       └────────┬─────────┘                   │
│                                │                             │
│          ┌─────────────────────▼────────────────────┐       │
│          │           Kubernetes API                  │       │
│          └─────────────────────┬────────────────────┘       │
│                                │                             │
│                    ┌───────────▼──────────┐                 │
│                    │    Result CRDs        │                 │
│                    │  (per namespace)      │                 │
│                    └───────────┬──────────┘                 │
│                                │                             │
│              ┌─────────────────▼──────────────┐             │
│              │  Notification Sinks             │             │
│              │  Slack / PagerDuty / Webhook    │             │
│              └────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────┘
```

## Section 2: Installation

### CLI Installation

```bash
# Install via Homebrew on macOS/Linux
brew tap k8sgpt-ai/k8sgpt
brew install k8sgpt

# Install via direct binary download
curl -Lo k8sgpt https://github.com/k8sgpt-ai/k8sgpt/releases/download/v0.3.42/k8sgpt_linux_amd64
chmod +x k8sgpt
sudo mv k8sgpt /usr/local/bin/

# Verify installation
k8sgpt version
```

### Operator Installation via Helm

```bash
# Add the K8sGPT Helm repository
helm repo add k8sgpt https://charts.k8sgpt.ai/
helm repo update

# Create the namespace
kubectl create namespace k8sgpt-operator-system

# Install the operator with production values
helm install k8sgpt-operator k8sgpt/k8sgpt-operator \
  --namespace k8sgpt-operator-system \
  --version 0.1.15 \
  --values k8sgpt-operator-values.yaml
```

Production Helm values for the Operator:

```yaml
# k8sgpt-operator-values.yaml
replicaCount: 2

image:
  repository: ghcr.io/k8sgpt-ai/k8sgpt-operator
  tag: v0.1.15
  pullPolicy: IfNotPresent

resources:
  limits:
    cpu: 500m
    memory: 256Mi
  requests:
    cpu: 100m
    memory: 128Mi

serviceAccount:
  create: true
  annotations: {}

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65534
  fsGroup: 65534

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL

# Leader election for HA
leaderElection:
  enabled: true

# Prometheus metrics
metrics:
  enabled: true
  port: 8080
  serviceMonitor:
    enabled: true
    namespace: monitoring
    interval: 30s

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "8080"
```

## Section 3: AI Backend Configuration

K8sGPT supports multiple AI backends. The backend choice affects analysis quality, latency, cost, and data residency requirements.

### OpenAI GPT-4 Backend

```bash
# Configure the OpenAI backend via CLI
k8sgpt auth add \
  --backend openai \
  --model gpt-4o \
  --password EXAMPLE_TOKEN_REPLACE_ME

# List configured backends
k8sgpt auth list
```

For the Operator, store the token as a Kubernetes Secret:

```yaml
# openai-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: k8sgpt-openai-secret
  namespace: k8sgpt-operator-system
type: Opaque
stringData:
  openai-api-key: EXAMPLE_TOKEN_REPLACE_ME  # Replace with actual key at deploy time
```

### Anthropic Claude Backend

```bash
# Configure Anthropic Claude as the backend
k8sgpt auth add \
  --backend anthropicai \
  --model claude-3-5-sonnet-20241022 \
  --password EXAMPLE_TOKEN_REPLACE_ME

# Test the backend with a quick analysis
k8sgpt analyze --explain --backend anthropicai --namespace production
```

### Ollama Local Backend (Air-Gapped Environments)

For environments where data cannot leave the cluster, Ollama provides local model inference with no external dependencies.

```bash
# Deploy Ollama in-cluster
helm repo add ollama-helm https://otwld.github.io/ollama-helm/
helm install ollama ollama-helm/ollama \
  --namespace ollama \
  --create-namespace \
  --set ollama.models={"llama3.2","mistral"} \
  --set resources.limits.cpu=4 \
  --set resources.limits.memory=8Gi

# Configure k8sgpt to use in-cluster Ollama
k8sgpt auth add \
  --backend localai \
  --model llama3.2 \
  --baseurl http://ollama.ollama.svc.cluster.local:11434/v1
```

The Operator K8sGPT CRD with Ollama backend:

```yaml
# k8sgpt-ollama.yaml
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata:
  name: k8sgpt-cluster
  namespace: k8sgpt-operator-system
spec:
  ai:
    enabled: true
    model: llama3.2
    backend: localai
    baseUrl: http://ollama.ollama.svc.cluster.local:11434/v1
    # No token required for local Ollama
    secret:
      name: ""
      key: ""
  noCache: false
  version: v0.3.42
  repository: ghcr.io/k8sgpt-ai/k8sgpt
  imagePullPolicy: IfNotPresent
  # Run analysis every 5 minutes
  interval: "5m"
  # Target specific namespaces
  namespaces:
    - production
    - staging
  analyzers:
    - Pod
    - Service
    - ReplicaSet
    - PersistentVolumeClaim
    - HorizontalPodAutoscaler
    - Deployment
    - StatefulSet
    - Node
    - Ingress
    - NetworkPolicy
  anonymize: true
  sink:
    type: slack
    endpoint: https://hooks.slack.com/services/EXAMPLE_SLACK_WEBHOOK_REPLACE_ME
```

## Section 4: Analyzer Types and Usage

K8sGPT ships with analyzers covering the core Kubernetes resource types. Each analyzer inspects a specific resource kind and extracts relevant failure signals before sending them to the AI backend.

### Running Specific Analyzers

```bash
# Analyze all resource types with AI explanation
k8sgpt analyze --explain

# Analyze only pods and services
k8sgpt analyze --explain --filter=Pod,Service

# Analyze a specific namespace
k8sgpt analyze --explain --namespace production

# Output results as JSON for downstream processing
k8sgpt analyze --explain --output=json | jq '.results[]'

# Use a specific backend for this run
k8sgpt analyze --explain --backend openai

# Increase verbosity to see what each analyzer is checking
k8sgpt analyze --explain --verbose
```

### Pod Analyzer

The Pod analyzer detects:
- `CrashLoopBackOff` — extracts recent log lines and last exit code
- `Pending` state — checks scheduler events, resource requests vs node capacity
- `OOMKilled` — reports memory limits vs requests
- `ImagePullBackOff` — surfaces image name, pull secrets, and registry errors
- Container restarts exceeding a threshold

Example output for a `CrashLoopBackOff` pod:

```json
{
  "name": "production/api-server-7d9f8b-xkp2q",
  "kind": "Pod",
  "error": [
    {
      "text": "Container api exited with code 1. Last 20 log lines: FATAL: database connection refused: dial tcp 10.96.45.12:5432: connect: connection refused",
      "kubernetes": {
        "name": "production/api-server-7d9f8b-xkp2q",
        "eventMessages": [
          "Back-off restarting failed container api in pod api-server-7d9f8b-xkp2q_production"
        ]
      }
    }
  ],
  "details": "The container is crashing because it cannot connect to its PostgreSQL database at 10.96.45.12:5432. This typically indicates the database service is down or the ClusterIP has changed. Check if the 'postgres' Service exists in the 'production' namespace, verify the Service endpoints are populated, and confirm the database pod is running. If using an external database, verify network policies allow egress on port 5432.",
  "parentObject": "Deployment/api-server"
}
```

### PVC Analyzer

```bash
# Analyze PVCs across all namespaces
k8sgpt analyze --explain --filter=PersistentVolumeClaim --namespace=""

# Common issues detected:
# - PVC stuck in Pending (no matching StorageClass, capacity)
# - PVC in Lost state (backing PV deleted)
# - StorageClass does not allow volume expansion
```

### HPA Analyzer

```bash
# Analyze HPA objects
k8sgpt analyze --explain --filter=HorizontalPodAutoscaler

# Detects:
# - ScalingLimited condition (max replicas reached)
# - Unable to fetch metrics (metrics-server unavailable)
# - DesiredReplicas differs from CurrentReplicas for extended periods
```

### Node Analyzer

```bash
# Analyze node conditions
k8sgpt analyze --explain --filter=Node

# Detects:
# - NotReady conditions with reason
# - DiskPressure, MemoryPressure, PIDPressure
# - Cordoned nodes with reason
# - Nodes running outdated kubelet versions
```

## Section 5: Anonymization of Sensitive Data

Before sending cluster data to external AI backends, K8sGPT anonymizes potentially sensitive values using a masking substitution table. This prevents namespace names, pod names, IP addresses, and container image paths from being sent in clear text to third-party APIs.

```bash
# Enable anonymization during analysis
k8sgpt analyze --explain --anonymize

# Anonymization replaces:
# - Namespace names → ns-001, ns-002
# - Pod names → pod-abc1, pod-abc2
# - IP addresses → 10.x.x.x
# - Image paths → registry/image:tag → image-001:tag-001
# - Secret names → secret-001
```

The anonymization mapping is stored locally for the session and used to de-anonymize results before display:

```bash
# View the anonymization mapping for the last run
k8sgpt cache list

# Clear cached analysis results
k8sgpt cache purge
```

For the Operator, enable anonymization in the K8sGPT CRD:

```yaml
# k8sgpt-production.yaml
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata:
  name: k8sgpt-production
  namespace: k8sgpt-operator-system
spec:
  ai:
    enabled: true
    model: gpt-4o
    backend: openai
    secret:
      name: k8sgpt-openai-secret
      key: openai-api-key
  anonymize: true   # Always enable for external backends
  noCache: false
  version: v0.3.42
  repository: ghcr.io/k8sgpt-ai/k8sgpt
  imagePullPolicy: IfNotPresent
  interval: "10m"
  namespaces:
    - production
    - staging
    - monitoring
```

## Section 6: K8sGPT Operator CRD and Result CRD

### K8sGPT CRD Full Example

```yaml
# k8sgpt-full-config.yaml
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata:
  name: k8sgpt-enterprise
  namespace: k8sgpt-operator-system
spec:
  ai:
    enabled: true
    model: gpt-4o
    backend: openai
    secret:
      name: k8sgpt-openai-secret
      key: openai-api-key
    # Temperature: 0.0 for deterministic output, 0.7 for creative suggestions
    temperature: 0.0
    # Maximum tokens in AI response
    maxTokens: 2048
    # Custom prompt prefix for organizational context
    customPrompt: "You are a senior Kubernetes SRE at a financial services company. All responses must include remediation steps with kubectl commands."
  anonymize: true
  noCache: false
  version: v0.3.42
  repository: ghcr.io/k8sgpt-ai/k8sgpt
  imagePullPolicy: IfNotPresent
  # Reconciliation interval
  interval: "10m"
  # Target namespaces (empty list = all namespaces)
  namespaces:
    - production
    - staging
  # Enabled analyzers
  analyzers:
    - Pod
    - Service
    - ReplicaSet
    - PersistentVolumeClaim
    - HorizontalPodAutoscaler
    - Deployment
    - StatefulSet
    - Node
    - Ingress
    - NetworkPolicy
    - CronJob
    - MutatingWebhookConfiguration
    - ValidatingWebhookConfiguration
  # Notification sink
  sink:
    type: slack
    endpoint: https://hooks.slack.com/services/EXAMPLE_SLACK_WEBHOOK_REPLACE_ME
  # Extra configuration for specific analyzers
  extraOptions:
    backstageLabel: "backstage.io/kubernetes-id"
    serviceAccountIssuer: "https://kubernetes.default.svc.cluster.local"
```

### Result CRD Output

Each analysis cycle creates or updates `Result` objects in the target namespace:

```yaml
# Example Result CRD created by the Operator
apiVersion: core.k8sgpt.ai/v1alpha1
kind: Result
metadata:
  name: production-api-server-crashloopbackoff
  namespace: production
  labels:
    k8sgpt.ai/analyzer: Pod
    k8sgpt.ai/backend: openai
    k8sgpt.ai/severity: critical
status:
  kind: Pod
  name: production/api-server-7d9f8b-xkp2q
  error:
    - text: "Container api exited with code 1. Back-off restarting failed container."
      kubernetes:
        name: production/api-server-7d9f8b-xkp2q
  details: |
    The API server pod is in CrashLoopBackOff due to a database connection failure.
    Immediate steps:
    1. Check database pod status: kubectl get pods -n production -l app=postgres
    2. Check database service: kubectl describe svc postgres -n production
    3. Check network policies: kubectl get networkpolicies -n production
    4. Review pod logs: kubectl logs api-server-7d9f8b-xkp2q -n production --previous
  parentObject: "Deployment/api-server"
```

Query Result objects programmatically:

```bash
# List all Result objects across all namespaces
kubectl get results.core.k8sgpt.ai -A

# Get details for a specific result
kubectl describe result.core.k8sgpt.ai \
  production-api-server-crashloopbackoff \
  -n production

# Watch for new Results in real time
kubectl get results.core.k8sgpt.ai -A -w

# Count results by severity
kubectl get results.core.k8sgpt.ai -A \
  -l k8sgpt.ai/severity=critical \
  --no-headers | wc -l
```

## Section 7: Custom Analyzer Development

K8sGPT supports custom analyzers written as Go plugins. Custom analyzers follow the same interface as built-in analyzers.

### Custom Analyzer Interface

```go
// custom_analyzer.go
package customanalyzer

import (
    "context"
    "fmt"

    "github.com/k8sgpt-ai/k8sgpt/pkg/common"
    "github.com/k8sgpt-ai/k8sgpt/pkg/kubernetes"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// CustomCertificateAnalyzer checks for expiring TLS certificates in Secrets
type CustomCertificateAnalyzer struct{}

// Analyze runs the certificate expiry check against all TLS secrets
func (a *CustomCertificateAnalyzer) Analyze(
    ctx context.Context,
    config common.Analyzer,
) ([]common.Result, error) {
    client := config.Client.GetClient()
    var results []common.Result

    // List all secrets across configured namespaces
    namespaces := config.Namespace
    if namespaces == "" {
        namespaces = metav1.NamespaceAll
    }

    secretList, err := client.CoreV1().Secrets(namespaces).List(ctx, metav1.ListOptions{
        // Filter for TLS secrets only
        FieldSelector: "type=kubernetes.io/tls",
    })
    if err != nil {
        return nil, fmt.Errorf("listing TLS secrets: %w", err)
    }

    for _, secret := range secretList.Items {
        certBytes, ok := secret.Data["tls.crt"]
        if !ok {
            continue
        }

        // Parse and check certificate expiry
        daysUntilExpiry, err := getCertExpiryDays(certBytes)
        if err != nil {
            continue
        }

        // Flag certificates expiring within 30 days
        if daysUntilExpiry < 30 {
            results = append(results, common.Result{
                Kind:    "Secret",
                Name:    fmt.Sprintf("%s/%s", secret.Namespace, secret.Name),
                Error: []common.Failure{
                    {
                        Text: fmt.Sprintf(
                            "TLS certificate in secret %s/%s expires in %d days",
                            secret.Namespace, secret.Name, daysUntilExpiry,
                        ),
                        Sensitive: []common.Sensitive{
                            {
                                Unmasked: secret.Name,
                                Masked:   kubernetes.MaskValue(secret.Name),
                            },
                        },
                    },
                },
                ParentObject: fmt.Sprintf("Secret/%s", secret.Name),
            })
        }
    }

    return results, nil
}

// getCertExpiryDays parses a PEM certificate and returns days until expiry
func getCertExpiryDays(certPEM []byte) (int, error) {
    // Implementation: parse PEM, decode DER, check NotAfter
    // Returns number of days until certificate expires
    // Negative value indicates already expired
    return 45, nil // Placeholder return for compilation
}
```

### Registering the Custom Analyzer

```go
// main.go (plugin registration)
package main

import (
    "github.com/k8sgpt-ai/k8sgpt/pkg/analyzer"
    customanalyzer "github.com/example/k8sgpt-custom-analyzers"
)

func init() {
    // Register the custom analyzer with the k8sgpt analyzer registry
    analyzer.Register("CustomCertificate", &customanalyzer.CustomCertificateAnalyzer{})
}
```

Build and use the custom analyzer:

```bash
# Build the custom analyzer plugin
go build -buildmode=plugin -o custom-cert-analyzer.so ./cmd/plugin/

# Run k8sgpt with the custom analyzer loaded
k8sgpt analyze \
  --explain \
  --filter=CustomCertificate \
  --custom-analyzers-plugins=./custom-cert-analyzer.so
```

## Section 8: Triaging CrashLoopBackOff and Pending Pods

### CrashLoopBackOff Triage Workflow

```bash
# Step 1: Identify crashing pods
kubectl get pods -A --field-selector=status.phase=Running \
  | grep CrashLoop

# Step 2: Run k8sgpt on the affected namespace
k8sgpt analyze \
  --explain \
  --filter=Pod \
  --namespace production \
  --backend openai

# Step 3: Review the AI explanation
# Example output:
# Pod: production/payment-service-6bc7d-k9p3x
# Error: Container payment-service has been restarting 47 times
#        Exit code: 137 (OOMKilled)
#        Last log line: "FATAL: heap allocation failed, RSS exceeded limit"
#
# AI Analysis:
# The payment-service container is being OOMKilled (exit code 137), indicating
# the container's memory usage exceeds its configured limit of 256Mi. The log
# line confirms heap exhaustion. Recommended actions:
# 1. Increase memory limit: kubectl set resources deployment payment-service
#    -n production --limits=memory=512Mi
# 2. Profile heap usage: kubectl exec -it payment-service-6bc7d-k9p3x
#    -n production -- /usr/bin/heap-profile
# 3. Review recent code changes that may have introduced memory leaks
# 4. Enable VPA to automatically right-size the container

# Step 4: Apply the suggested fix
kubectl set resources deployment payment-service \
  --namespace production \
  --limits=memory=512Mi \
  --requests=memory=256Mi
```

### Pending Pod Triage Workflow

```bash
# Identify pending pods
kubectl get pods -A --field-selector=status.phase=Pending

# Run k8sgpt on pending pods
k8sgpt analyze \
  --explain \
  --filter=Pod \
  --namespace ml-workloads

# Example AI output for a pending GPU pod:
# Pod: ml-workloads/training-job-v2-0
# Error: Pod has been in Pending state for 23 minutes
#        FailedScheduling: 0/12 nodes are available:
#        4 Insufficient nvidia.com/gpu, 8 node(s) didn't match node selector
#
# AI Analysis:
# The training pod cannot be scheduled because:
# 1. Only 4 nodes have GPU capacity (nvidia.com/gpu resource)
# 2. Of those 4 GPU nodes, all GPUs are currently allocated
# 3. The pod's nodeSelector requires label 'accelerator: nvidia-a100'
#    but only 2 nodes carry this label
#
# Remediation options:
# 1. Scale the GPU node group to add capacity
# 2. Reduce the GPU request from 2 to 1: kubectl edit pod training-job-v2-0
# 3. Check if running training jobs can be preempted using PriorityClass
# 4. Review node labels: kubectl get nodes -l accelerator=nvidia-a100
```

## Section 9: Slack and PagerDuty Integration

### Slack Integration

Configure the K8sGPT Operator to send findings to Slack:

```yaml
# k8sgpt-slack.yaml
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata:
  name: k8sgpt-with-slack
  namespace: k8sgpt-operator-system
spec:
  ai:
    enabled: true
    model: gpt-4o
    backend: openai
    secret:
      name: k8sgpt-openai-secret
      key: openai-api-key
  anonymize: true
  noCache: false
  version: v0.3.42
  repository: ghcr.io/k8sgpt-ai/k8sgpt
  imagePullPolicy: IfNotPresent
  interval: "10m"
  sink:
    type: slack
    endpoint: https://hooks.slack.com/services/EXAMPLE_SLACK_WEBHOOK_REPLACE_ME
    # Channel is set in the webhook URL configuration at Slack
```

Slack message format produced by K8sGPT:

```json
{
  "attachments": [
    {
      "color": "#FF0000",
      "title": "K8sGPT: CrashLoopBackOff Detected",
      "fields": [
        {
          "title": "Resource",
          "value": "Pod: production/api-server-7d9f8b-xkp2q",
          "short": true
        },
        {
          "title": "Analyzer",
          "value": "Pod",
          "short": true
        },
        {
          "title": "Analysis",
          "value": "The container is failing due to a database connection error. Check the postgres Service endpoints and verify the database pod is running.",
          "short": false
        }
      ],
      "footer": "K8sGPT | production cluster",
      "ts": 1709856000
    }
  ]
}
```

### PagerDuty Integration

For critical issues that require on-call escalation, configure a webhook sink that forwards to PagerDuty:

```yaml
# k8sgpt-pagerduty-webhook.yaml
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata:
  name: k8sgpt-critical-alerts
  namespace: k8sgpt-operator-system
spec:
  ai:
    enabled: true
    model: gpt-4o
    backend: openai
    secret:
      name: k8sgpt-openai-secret
      key: openai-api-key
  anonymize: true
  noCache: false
  version: v0.3.42
  repository: ghcr.io/k8sgpt-ai/k8sgpt
  imagePullPolicy: IfNotPresent
  interval: "5m"
  # Only analyze production - critical-path namespaces
  namespaces:
    - production
  analyzers:
    - Pod
    - Node
    - PersistentVolumeClaim
  sink:
    type: webhook
    endpoint: https://events.pagerduty.com/v2/enqueue
```

PagerDuty forwarding service (deployed alongside K8sGPT):

```go
// pagerduty-forwarder/main.go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
)

// K8sGPTWebhookPayload represents the webhook payload from K8sGPT
type K8sGPTWebhookPayload struct {
    Results []struct {
        Kind    string `json:"kind"`
        Name    string `json:"name"`
        Details string `json:"details"`
        Error   []struct {
            Text string `json:"text"`
        } `json:"error"`
    } `json:"results"`
}

// PagerDutyEvent represents an event to send to PagerDuty Events API v2
type PagerDutyEvent struct {
    RoutingKey  string            `json:"routing_key"`
    EventAction string            `json:"event_action"`
    DedupKey    string            `json:"dedup_key"`
    Payload     PagerDutyPayload  `json:"payload"`
}

// PagerDutyPayload is the payload section of a PagerDuty event
type PagerDutyPayload struct {
    Summary  string `json:"summary"`
    Source   string `json:"source"`
    Severity string `json:"severity"`
    Details  string `json:"custom_details"`
}

func handler(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "error reading body", http.StatusBadRequest)
        return
    }

    var payload K8sGPTWebhookPayload
    if err := json.Unmarshal(body, &payload); err != nil {
        http.Error(w, "error parsing JSON", http.StatusBadRequest)
        return
    }

    for _, result := range payload.Results {
        event := PagerDutyEvent{
            RoutingKey:  os.Getenv("PAGERDUTY_ROUTING_KEY"), // Set from Secret
            EventAction: "trigger",
            DedupKey:    fmt.Sprintf("k8sgpt-%s-%s", result.Kind, result.Name),
            Payload: PagerDutyPayload{
                Summary:  fmt.Sprintf("K8sGPT: %s issue in %s", result.Kind, result.Name),
                Source:   "k8sgpt-operator",
                Severity: "critical",
                Details:  result.Details,
            },
        }

        eventJSON, _ := json.Marshal(event)
        resp, err := http.Post(
            "https://events.pagerduty.com/v2/enqueue",
            "application/json",
            bytes.NewReader(eventJSON),
        )
        if err != nil {
            log.Printf("error sending PagerDuty event: %v", err)
            continue
        }
        resp.Body.Close()
        log.Printf("PagerDuty event sent for %s/%s: HTTP %d", result.Kind, result.Name, resp.StatusCode)
    }

    w.WriteHeader(http.StatusOK)
}

func main() {
    http.HandleFunc("/webhook", handler)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

## Section 10: Prometheus Metrics

The K8sGPT Operator exposes Prometheus metrics on port 8080 at `/metrics`.

### Available Metrics

```
# HELP k8sgpt_number_of_results Total number of results found by k8sgpt
# TYPE k8sgpt_number_of_results gauge
k8sgpt_number_of_results{namespace="production"} 3

# HELP k8sgpt_number_of_results_by_type Results count broken down by analyzer type
# TYPE k8sgpt_number_of_results_by_type gauge
k8sgpt_number_of_results_by_type{type="Pod",namespace="production"} 2
k8sgpt_number_of_results_by_type{type="PersistentVolumeClaim",namespace="production"} 1

# HELP k8sgpt_analysis_duration_seconds Time taken to complete an analysis cycle
# TYPE k8sgpt_analysis_duration_seconds histogram
k8sgpt_analysis_duration_seconds_bucket{le="5"} 8
k8sgpt_analysis_duration_seconds_bucket{le="10"} 14
k8sgpt_analysis_duration_seconds_bucket{le="30"} 20
k8sgpt_analysis_duration_seconds_sum 312.5
k8sgpt_analysis_duration_seconds_count 20
```

### ServiceMonitor for Prometheus Operator

```yaml
# k8sgpt-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: k8sgpt-operator
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - k8sgpt-operator-system
  selector:
    matchLabels:
      app.kubernetes.io/name: k8sgpt-operator
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      scheme: http
```

### Grafana Dashboard Queries

```promql
# Number of active issues by namespace
sum by (namespace) (k8sgpt_number_of_results)

# Issue count trend over 1 hour
increase(k8sgpt_number_of_results[1h])

# Analysis cycle duration (95th percentile)
histogram_quantile(0.95, rate(k8sgpt_analysis_duration_seconds_bucket[5m]))

# Issues by type
topk(10, sum by (type) (k8sgpt_number_of_results_by_type))
```

## Section 11: Namespace Filtering and RBAC

### RBAC Configuration

The K8sGPT Operator requires read access to cluster resources. Create a minimal ClusterRole:

```yaml
# k8sgpt-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: k8sgpt-operator-role
rules:
  # Core resource access
  - apiGroups: [""]
    resources:
      - pods
      - pods/log
      - services
      - endpoints
      - persistentvolumeclaims
      - persistentvolumes
      - nodes
      - events
      - namespaces
      - replicationcontrollers
      - serviceaccounts
      - configmaps
    verbs: ["get", "list", "watch"]
  # Apps resources
  - apiGroups: ["apps"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
    verbs: ["get", "list", "watch"]
  # Autoscaling
  - apiGroups: ["autoscaling"]
    resources:
      - horizontalpodautoscalers
    verbs: ["get", "list", "watch"]
  # Networking
  - apiGroups: ["networking.k8s.io"]
    resources:
      - ingresses
      - networkpolicies
    verbs: ["get", "list", "watch"]
  # Batch
  - apiGroups: ["batch"]
    resources:
      - jobs
      - cronjobs
    verbs: ["get", "list", "watch"]
  # K8sGPT CRDs
  - apiGroups: ["core.k8sgpt.ai"]
    resources:
      - k8sgpts
      - results
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: k8sgpt-operator-rolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: k8sgpt-operator-role
subjects:
  - kind: ServiceAccount
    name: k8sgpt-operator
    namespace: k8sgpt-operator-system
```

### Namespace Filtering

```bash
# Analyze only specific namespaces via CLI
k8sgpt analyze \
  --explain \
  --namespace production,staging

# Exclude system namespaces
k8sgpt analyze \
  --explain \
  --namespace production,staging,monitoring \
  --filter=Pod,Deployment,Service

# In the K8sGPT CRD, specify namespaces as a list
# Empty list means all non-system namespaces
```

## Section 12: CI/CD Integration

### GitHub Actions Integration

```yaml
# .github/workflows/k8sgpt-check.yaml
name: K8sGPT Cluster Health Check

on:
  schedule:
    - cron: "0 */6 * * *"  # Every 6 hours
  workflow_dispatch:

jobs:
  k8sgpt-analyze:
    runs-on: ubuntu-latest
    steps:
      - name: Install k8sgpt
        run: |
          curl -Lo k8sgpt https://github.com/k8sgpt-ai/k8sgpt/releases/download/v0.3.42/k8sgpt_linux_amd64
          chmod +x k8sgpt
          sudo mv k8sgpt /usr/local/bin/

      - name: Configure kubeconfig
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.KUBECONFIG_PRODUCTION }}" > ~/.kube/config
          chmod 600 ~/.kube/config

      - name: Configure AI backend
        run: |
          k8sgpt auth add \
            --backend openai \
            --model gpt-4o \
            --password "${{ secrets.OPENAI_API_KEY }}"

      - name: Run analysis
        id: analysis
        run: |
          k8sgpt analyze \
            --explain \
            --namespace production \
            --output=json \
            --anonymize > analysis-results.json

          ISSUE_COUNT=$(jq '.results | length' analysis-results.json)
          echo "issue_count=${ISSUE_COUNT}" >> $GITHUB_OUTPUT

      - name: Post results to Slack
        if: steps.analysis.outputs.issue_count != '0'
        run: |
          cat analysis-results.json | \
            jq -r '.results[] | "• \(.kind)/\(.name): \(.details)"' | \
            head -20 > summary.txt

          curl -X POST \
            -H 'Content-type: application/json' \
            --data "{\"text\": \"K8sGPT found $(cat analysis-results.json | jq '.results | length') issues:\n$(cat summary.txt)\"}" \
            "${{ secrets.SLACK_WEBHOOK_URL }}"

      - name: Upload analysis artifact
        uses: actions/upload-artifact@v4
        with:
          name: k8sgpt-analysis
          path: analysis-results.json
          retention-days: 30
```

## Section 13: Troubleshooting K8sGPT

### Common Issues and Resolutions

```bash
# Issue: k8sgpt times out when connecting to AI backend
# Check: Verify API key and network connectivity
k8sgpt auth list
k8sgpt auth verify

# Issue: Operator not creating Result CRDs
kubectl logs -n k8sgpt-operator-system \
  -l app.kubernetes.io/name=k8sgpt-operator \
  --tail=100

# Issue: Too many results (low signal-to-noise)
# Solution: Increase the minimum severity threshold
k8sgpt analyze \
  --explain \
  --filter=Pod,Node \
  --namespace production \
  --max-concurrency=3

# Issue: Results not appearing for a namespace
# Check namespace label selector if using Operator
kubectl describe k8sgpt k8sgpt-enterprise \
  -n k8sgpt-operator-system

# Issue: AI backend returning irrelevant explanations
# Solution: Adjust the custom prompt in the K8sGPT CRD spec.ai.customPrompt
```

### Checking Operator Health

```bash
# Check Operator pod status
kubectl get pods -n k8sgpt-operator-system

# Check CRD installation
kubectl get crds | grep k8sgpt

# Verify K8sGPT configuration
kubectl get k8sgpt -A -o yaml

# Check Result objects for recent analysis
kubectl get results.core.k8sgpt.ai -A \
  --sort-by=.metadata.creationTimestamp \
  | tail -20

# View Operator metrics
kubectl port-forward svc/k8sgpt-operator-metrics \
  -n k8sgpt-operator-system 8080:8080 &
curl -s http://localhost:8080/metrics | grep k8sgpt
```

## Section 14: Production Recommendations

Running K8sGPT effectively in production requires attention to cost management, data governance, and alert tuning.

**AI Backend Cost Management:** GPT-4o charges per token. A typical K8sGPT analysis cycle across 200 pods costs approximately 50,000 tokens ($0.15 USD at standard pricing). With a 10-minute interval, monthly costs reach approximately $650. Use GPT-4o-mini for initial triage and escalate to GPT-4o only for complex issues.

**Data Residency:** Enable anonymization for all external AI backends. For strict data residency requirements, deploy Ollama with a quantized model such as `mistral:7b-instruct-q4_K_M` to keep all data within the cluster boundary. Analysis quality is lower than GPT-4o but sufficient for common failure patterns.

**Alert Fatigue:** Set the Operator interval to at least 10 minutes for production clusters. Implement deduplication by checking the `Result` CRD `status.details` hash before sending notifications. Mute results for known acceptable conditions using `spec.filters.excludeNamespaces`.

**Multi-Cluster Deployment:** Deploy separate K8sGPT Operator instances per cluster. Aggregate `Result` CRDs using a central monitoring cluster with Prometheus federation. Add the cluster name as a label to differentiate results in Grafana dashboards.

**Version Pinning:** Pin both the Operator Helm chart version and the `spec.version` field in the K8sGPT CRD to the same release to prevent analyzer drift between the Operator and the analysis container it spawns.
