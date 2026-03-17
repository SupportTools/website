---
title: "Knative Serving v1.x: Autoscaling from Zero, Traffic Splitting, Revision Management, and Custom Domains"
date: 2031-12-05T00:00:00-05:00
draft: false
tags: ["Knative", "Kubernetes", "Serverless", "Autoscaling", "Traffic Management", "Service Mesh"]
categories: ["Kubernetes", "Serverless"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade deep dive into Knative Serving v1.x covering scale-to-zero autoscaling, KPA vs HPA, traffic splitting strategies, revision management, and custom domain configuration for enterprise workloads."
more_link: "yes"
url: "/knative-serving-v1x-autoscaling-traffic-splitting-enterprise-guide/"
---

Knative Serving transforms standard Kubernetes deployments into serverless workloads that scale to zero, split traffic across revisions, and bind to custom domains — all without rewriting application code. This guide covers every production-relevant aspect of Knative Serving v1.x, from the autoscaler internals that govern cold-start latency to the admission webhook chain that validates Service objects.

<!--more-->

# Knative Serving v1.x: Enterprise Production Guide

## Prerequisites and Installation

Before installing Knative Serving, ensure your cluster meets the following requirements:

- Kubernetes 1.28 or later
- At least 2 worker nodes with 4 vCPU / 8 GB RAM each
- A functioning network layer (Istio, Kourier, or Contour)
- cert-manager if you want automatic TLS provisioning

### Installing the Serving CRDs and Core

```bash
# Install the CRDs
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.13.0/serving-crds.yaml

# Install the core components
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.13.0/serving-core.yaml

# Verify the installation
kubectl get pods -n knative-serving
```

Expected output showing healthy pods:

```
NAME                                      READY   STATUS    RESTARTS   AGE
activator-7d4dd6f7c4-9kp8x               1/1     Running   0          2m
autoscaler-5c5d5f9f9d-6qwlz              1/1     Running   0          2m
controller-6f5c5d8d8b-vkp7t              1/1     Running   0          2m
net-kourier-controller-8d9f6b7c5-njl2p   1/1     Running   0          2m
webhook-7c8b9d6c5f-hmt4r                 1/1     Running   0          2m
```

### Installing Kourier as the Network Layer

Kourier is the lightweight ingress recommended for production Knative installations when you do not already have Istio:

```bash
kubectl apply -f https://github.com/knative/net-kourier/releases/download/knative-v1.13.0/kourier.yaml

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'
```

### Installing with Istio as the Network Layer

If your cluster already runs Istio, use the net-istio integration instead:

```bash
kubectl apply -f https://github.com/knative/net-istio/releases/download/knative-v1.13.0/net-istio.yaml

kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"istio.ingress.networking.knative.dev"}}'
```

## Understanding the Knative Serving Object Model

Knative Serving introduces four CRDs that work together:

| CRD | Purpose |
|-----|---------|
| `Service` | Top-level abstraction; manages Routes and Configurations |
| `Configuration` | Desired state for pods; creates Revisions on change |
| `Revision` | Immutable snapshot of Configuration; the actual pod template |
| `Route` | Traffic distribution across Revisions |

The reconciliation flow is:

```
Service --> Configuration --> Revision (immutable)
        --> Route          --> Ingress --> Pods
```

When you update a `Service`, the controller creates a new `Revision`. Traffic continues flowing to the old `Revision` until you explicitly shift it.

## Deploying Your First Knative Service

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-api
  namespace: production
  annotations:
    serving.knative.dev/creator: "platform-team"
spec:
  template:
    metadata:
      annotations:
        # Autoscaling configuration
        autoscaling.knative.dev/class: "kpa.autoscaling.knative.dev"
        autoscaling.knative.dev/metric: "concurrency"
        autoscaling.knative.dev/target: "100"
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/maxScale: "20"
        autoscaling.knative.dev/scaleDownDelay: "60s"
        # Revision naming
        serving.knative.dev/rolloutDuration: "120s"
    spec:
      containerConcurrency: 200
      timeoutSeconds: 300
      containers:
        - image: registry.example.com/payment-api:v2.4.1
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "512Mi"
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: payment-db-secret
                  key: url
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 3
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
  traffic:
    - latestRevision: true
      percent: 100
```

Apply this manifest and observe the revision created:

```bash
kubectl apply -f payment-api-service.yaml

# Watch the service reach Ready state
kubectl get ksvc payment-api -n production -w

# List revisions
kubectl get revisions -n production -l serving.knative.dev/service=payment-api
```

## Autoscaling Deep Dive: KPA vs HPA

### Knative Pod Autoscaler (KPA)

The KPA is Knative's native autoscaler and is the only one that supports scale-to-zero. It operates on a **concurrent requests** or **requests-per-second** metric collected by the Activator and Autoscaler components.

**KPA architecture:**

```
Client Request
     |
     v
[Kourier/Istio Ingress]
     |
     v
[Activator]  <---  buffers requests when pods=0
     |              signals Autoscaler to scale up
     v
[Application Pods]
     ^
     |
[Autoscaler] --- reads metrics from Activator/pods
     |
     v
[Scale Decision] --> updates Deployment replicas
```

**Configuring KPA at the cluster level:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Stable window: how long to average metrics before scaling
  stable-window: "60s"
  # Panic window: shorter window for rapid scale-up
  panic-window: "6s"
  # Panic threshold: scale-up trigger (2x = panic if 2x target utilization)
  panic-threshold-percentage: "200.0"
  # Scale-down delay: how long to wait before scaling down
  scale-down-delay: "0s"
  # Max scale-up rate per polling interval
  max-scale-up-rate: "1000.0"
  # Max scale-down rate per polling interval
  max-scale-down-rate: "2.0"
  # Activator capacity: requests the activator handles per pod
  activator-capacity: "100.0"
  # Initial scale: pods to create before first traffic
  initial-scale: "1"
  # Allow scale to zero
  allow-zero-initial-scale: "false"
```

**Per-service KPA tuning annotations:**

```yaml
metadata:
  annotations:
    # Use KPA (default) or HPA
    autoscaling.knative.dev/class: "kpa.autoscaling.knative.dev"
    # Metric: concurrency (default) or rps
    autoscaling.knative.dev/metric: "concurrency"
    # Target concurrent requests per pod
    autoscaling.knative.dev/target: "100"
    # Target utilization percentage (scale before hitting target)
    autoscaling.knative.dev/target-utilization-percentage: "70"
    # Min/max bounds
    autoscaling.knative.dev/minScale: "0"
    autoscaling.knative.dev/maxScale: "50"
    # How long to wait before scaling down
    autoscaling.knative.dev/scaleDownDelay: "120s"
    # Initial scale when first pod starts
    autoscaling.knative.dev/initial-scale: "1"
    # Scale to zero grace period
    autoscaling.knative.dev/scale-to-zero-grace-period: "30s"
    # Scale to zero pod retention period (keep pod around a bit longer)
    autoscaling.knative.dev/scale-to-zero-pod-retention-period: "0s"
```

### RPS-Based Autoscaling

For services where latency is more important than concurrency:

```yaml
metadata:
  annotations:
    autoscaling.knative.dev/class: "kpa.autoscaling.knative.dev"
    autoscaling.knative.dev/metric: "rps"
    autoscaling.knative.dev/target: "500"
    autoscaling.knative.dev/minScale: "2"
    autoscaling.knative.dev/maxScale: "100"
```

### Horizontal Pod Autoscaler (HPA) with Knative

When you need CPU or memory-based scaling (which KPA does not support), configure the HPA class:

```yaml
metadata:
  annotations:
    autoscaling.knative.dev/class: "hpa.autoscaling.knative.dev"
    autoscaling.knative.dev/metric: "cpu"
    autoscaling.knative.dev/target: "70"
    autoscaling.knative.dev/minScale: "2"
    autoscaling.knative.dev/maxScale: "30"
```

Note: HPA-based Knative Services cannot scale to zero.

### Custom Metrics with HPA

Using Prometheus Adapter for custom application metrics:

```yaml
# prometheus-adapter ConfigMap entry
rules:
  - seriesQuery: 'knative_serving_revision_request_count{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace: {resource: "namespace"}
        pod: {resource: "pod"}
    name:
      matches: "^knative_serving_revision_request_count$"
      as: "requests_per_second"
    metricsQuery: 'rate(knative_serving_revision_request_count{<<.LabelMatchers>>}[2m])'
```

```yaml
# Service annotation for custom metric
metadata:
  annotations:
    autoscaling.knative.dev/class: "hpa.autoscaling.knative.dev"
    autoscaling.knative.dev/metric: "requests_per_second"
    autoscaling.knative.dev/target: "200"
```

## Traffic Splitting and Canary Deployments

### Basic Traffic Split

Traffic splitting is defined in the `Service.spec.traffic` section. Each entry references either a named revision or the `latestRevision` flag:

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-api
  namespace: production
spec:
  template:
    metadata:
      name: payment-api-v3  # explicit revision name
    spec:
      containers:
        - image: registry.example.com/payment-api:v3.0.0
  traffic:
    - revisionName: payment-api-v2  # previous stable revision
      percent: 90
      tag: stable
    - revisionName: payment-api-v3  # new revision being canary'd
      percent: 10
      tag: canary
```

After applying, Knative creates tagged routes:

```
https://stable-payment-api.production.example.com  -> payment-api-v2 (100%)
https://canary-payment-api.production.example.com  -> payment-api-v3 (100%)
https://payment-api.production.example.com          -> 90/10 split
```

### Progressive Traffic Migration Script

```bash
#!/usr/bin/env bash
# progressive-rollout.sh - Shift traffic 10% at a time with health checks

set -euo pipefail

SERVICE_NAME="${1:?usage: $0 <service-name> <namespace> <new-revision>}"
NAMESPACE="${2:?}"
NEW_REVISION="${3:?}"
STEP=10
CURRENT_NEW=0

# Get current stable revision
STABLE_REVISION=$(kubectl get ksvc "${SERVICE_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.traffic[?(@.tag=="stable")].revisionName}')

echo "Migrating traffic from ${STABLE_REVISION} to ${NEW_REVISION}"

while [ "${CURRENT_NEW}" -lt 100 ]; do
  CURRENT_NEW=$((CURRENT_NEW + STEP))
  CURRENT_STABLE=$((100 - CURRENT_NEW))

  echo "Setting traffic: stable=${CURRENT_STABLE}% new=${CURRENT_NEW}%"

  kubectl patch ksvc "${SERVICE_NAME}" -n "${NAMESPACE}" \
    --type merge \
    --patch "{
      \"spec\": {
        \"traffic\": [
          {\"revisionName\": \"${STABLE_REVISION}\", \"percent\": ${CURRENT_STABLE}, \"tag\": \"stable\"},
          {\"revisionName\": \"${NEW_REVISION}\", \"percent\": ${CURRENT_NEW}, \"tag\": \"canary\"}
        ]
      }
    }"

  # Wait and check error rate
  sleep 30

  ERROR_RATE=$(kubectl exec -n monitoring deploy/prometheus -- \
    promtool query instant \
    'rate(knative_serving_revision_request_count{response_code_class="5xx",revision_name="'"${NEW_REVISION}"'"}[1m]) / rate(knative_serving_revision_request_count{revision_name="'"${NEW_REVISION}"'"}[1m])' \
    2>/dev/null | grep -oP '[\d.]+' | tail -1 || echo "0")

  if (( $(echo "${ERROR_RATE} > 0.05" | bc -l) )); then
    echo "ERROR: Error rate ${ERROR_RATE} exceeds 5%. Rolling back."
    kubectl patch ksvc "${SERVICE_NAME}" -n "${NAMESPACE}" \
      --type merge \
      --patch "{
        \"spec\": {
          \"traffic\": [
            {\"revisionName\": \"${STABLE_REVISION}\", \"percent\": 100, \"tag\": \"stable\"}
          ]
        }
      }"
    exit 1
  fi

  echo "Health check passed. Error rate: ${ERROR_RATE}"
done

echo "Migration complete. ${NEW_REVISION} is now serving 100% of traffic."

# Update the stable tag
kubectl patch ksvc "${SERVICE_NAME}" -n "${NAMESPACE}" \
  --type merge \
  --patch "{
    \"spec\": {
      \"traffic\": [
        {\"revisionName\": \"${NEW_REVISION}\", \"percent\": 100, \"tag\": \"stable\", \"latestRevision\": false}
      ]
    }
  }"
```

### Blue-Green Deployment Pattern

```yaml
# Blue-green: zero-downtime switch with instant rollback capability
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: checkout-service
  namespace: production
spec:
  template:
    metadata:
      name: checkout-service-green-20311205
    spec:
      containers:
        - image: registry.example.com/checkout:v4.2.0
  traffic:
    - revisionName: checkout-service-blue-20311120  # current production
      percent: 100
      tag: blue
    - revisionName: checkout-service-green-20311205  # new deployment
      percent: 0
      tag: green
```

Switch instantly when ready:

```bash
kubectl patch ksvc checkout-service -n production \
  --type merge \
  --patch '{
    "spec": {
      "traffic": [
        {"revisionName": "checkout-service-blue-20311120", "percent": 0, "tag": "blue"},
        {"revisionName": "checkout-service-green-20311205", "percent": 100, "tag": "green"}
      ]
    }
  }'
```

## Revision Management

### Naming Revisions

Explicit revision names enable predictable canary targeting:

```yaml
spec:
  template:
    metadata:
      name: payment-api-v3-2031120501  # service-name-version-timestamp
```

Naming convention enforced by admission webhook (OPA/Gatekeeper policy):

```rego
package knative.revision.naming

import future.keywords.if

deny[msg] if {
  input.request.kind.kind == "Service"
  input.request.kind.group == "serving.knative.dev"
  name := input.request.object.spec.template.metadata.name
  not regex.match(`^[a-z][a-z0-9-]+-v[0-9]+-[0-9]{12}$`, name)
  msg := sprintf("Revision name '%v' must match pattern: <service>-v<version>-<YYYYMMDDHHmm>", [name])
}
```

### Revision Garbage Collection

Old revisions accumulate and consume etcd storage. Configure retention:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-gc
  namespace: knative-serving
data:
  # Retain this many recent revisions regardless of traffic
  retain-since-create-time: "48h"
  # Retain this many recent revisions receiving traffic
  retain-since-last-active-time: "15h"
  # Minimum revisions to retain (must keep at least 1)
  min-non-active-revisions: "1"
  # Maximum revisions to retain (0 = unlimited)
  max-non-active-revisions: "5"
```

### Listing and Deleting Stale Revisions

```bash
#!/usr/bin/env bash
# cleanup-revisions.sh - Remove non-traffic revisions older than N days

set -euo pipefail

NAMESPACE="${1:?usage: $0 <namespace> <service-name> [days]}"
SERVICE="${2:?}"
MAX_AGE_DAYS="${3:-7}"
CUTOFF=$(date -d "${MAX_AGE_DAYS} days ago" --iso-8601=seconds)

echo "Cleaning revisions for ${SERVICE} older than ${MAX_AGE_DAYS} days"

# Get revisions receiving traffic
ACTIVE_REVISIONS=$(kubectl get ksvc "${SERVICE}" -n "${NAMESPACE}" \
  -o jsonpath='{.status.traffic[*].revisionName}')

# List all revisions sorted by creation time
kubectl get revisions -n "${NAMESPACE}" \
  -l "serving.knative.dev/service=${SERVICE}" \
  --sort-by='.metadata.creationTimestamp' \
  -o json | \
jq -r --arg cutoff "${CUTOFF}" --argjson active "$(echo "${ACTIVE_REVISIONS}" | jq -R 'split(" ")')" \
  '.items[] | select(.metadata.creationTimestamp < $cutoff) |
   select(.metadata.name as $n | $active | index($n) | not) |
   .metadata.name' | \
while read -r revision; do
  echo "Deleting stale revision: ${revision}"
  kubectl delete revision "${revision}" -n "${NAMESPACE}"
done
```

## Custom Domain Configuration

### Global Domain Mapping

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-domain
  namespace: knative-serving
data:
  # Default domain for all services
  example.com: ""
  # Domain for services in the "production" namespace
  # services get: <service>.<namespace>.example.com
  prod.example.com: |
    selector:
      matchLabels:
        kubernetes.io/metadata.name: production
  # Domain for canary tagged routes
  canary.example.com: |
    selector:
      matchLabels:
        serving.knative.dev/route: canary
```

### Per-Service Domain Mapping with DomainMapping CRD

Knative v1.x introduces the `DomainMapping` CRD for mapping arbitrary hostnames:

```yaml
apiVersion: serving.knative.dev/v1beta1
kind: DomainMapping
metadata:
  name: api.payment.example.com
  namespace: production
  annotations:
    # Request TLS certificate via cert-manager
    networking.knative.dev/certificate-class: "cert-manager.certificate.networking.knative.dev"
spec:
  ref:
    name: payment-api
    kind: Service
    apiVersion: serving.knative.dev/v1
```

### Configuring TLS with cert-manager

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-certmanager
  namespace: knative-serving
data:
  issuerRef: |
    kind: ClusterIssuer
    name: letsencrypt-production
```

```yaml
# ClusterIssuer for Let's Encrypt
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: platform-team@example.com
    privateKeySecretRef:
      name: letsencrypt-production-key
    solvers:
      - http01:
          ingress:
            class: kourier
```

Enable automatic TLS:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-network
  namespace: knative-serving
data:
  # Enable automatic TLS
  auto-tls: "Enabled"
  # HTTP redirect to HTTPS
  http-protocol: "Redirected"
  # Certificate class to use
  certificate-class: "cert-manager.certificate.networking.knative.dev"
```

## Cold Start Optimization Strategies

Cold starts are the primary latency concern with scale-to-zero deployments. The following strategies minimize cold-start impact:

### Pre-warming with minScale

```yaml
metadata:
  annotations:
    # Keep at least 1 pod warm at all times
    autoscaling.knative.dev/minScale: "1"
    # But still scale up dynamically under load
    autoscaling.knative.dev/maxScale: "50"
```

### Startup Probe Optimization

```yaml
spec:
  containers:
    - image: registry.example.com/payment-api:v3.0.0
      startupProbe:
        httpGet:
          path: /health/startup
          port: 8080
        # Allow up to 60 seconds for startup
        failureThreshold: 20
        periodSeconds: 3
        initialDelaySeconds: 2
      readinessProbe:
        httpGet:
          path: /health/ready
          port: 8080
        periodSeconds: 2
        failureThreshold: 3
```

### Container Image Optimization

```dockerfile
# Multi-stage build to minimize image size and pull time
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o payment-api ./cmd/payment-api

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /app/payment-api /
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/payment-api"]
```

Pre-pull images to all nodes with a DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: image-prepuller
  namespace: production
spec:
  selector:
    matchLabels:
      app: image-prepuller
  template:
    metadata:
      labels:
        app: image-prepuller
    spec:
      initContainers:
        - name: prepull-payment-api
          image: registry.example.com/payment-api:v3.0.0
          command: ["sh", "-c", "echo Image pulled successfully"]
          resources:
            requests:
              cpu: "1m"
              memory: "1Mi"
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: "1m"
              memory: "1Mi"
```

## Monitoring and Observability

### Prometheus Metrics

Knative exposes metrics at `http://autoscaler.knative-serving:9090/metrics` and per-pod at the standard Prometheus port.

Key metrics to monitor:

```promql
# Current pod count per revision
knative_serving_revision_requested_replicas{
  namespace="production",
  service_name="payment-api"
}

# Request latency p99 per revision
histogram_quantile(0.99,
  rate(knative_serving_revision_request_latencies_bucket{
    namespace="production",
    service_name="payment-api"
  }[5m])
)

# Concurrency vs target (autoscaling health)
knative_serving_autoscaler_actual_pods{namespace="production"}
/ knative_serving_autoscaler_target_value{namespace="production"}

# Cold start frequency (activator requests that hit zero pods)
rate(knative_serving_activator_request_count{
  response_code_class="2xx",
  namespace="production"
}[5m])

# Scale-from-zero latency
histogram_quantile(0.95,
  rate(knative_serving_activator_request_latencies_bucket{
    namespace="production"
  }[5m])
)
```

### Grafana Dashboard for Knative

```json
{
  "panels": [
    {
      "title": "Active Pods by Revision",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(knative_serving_revision_requested_replicas{namespace=\"production\"}) by (revision_name)"
        }
      ]
    },
    {
      "title": "Request Rate by Service",
      "type": "graph",
      "targets": [
        {
          "expr": "sum(rate(knative_serving_revision_request_count{namespace=\"production\"}[2m])) by (service_name)"
        }
      ]
    },
    {
      "title": "P99 Latency",
      "type": "graph",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum(rate(knative_serving_revision_request_latencies_bucket{namespace=\"production\"}[5m])) by (le, service_name))"
        }
      ]
    }
  ]
}
```

## Production Hardening

### Pod Disruption Budgets

Knative creates PodDisruptionBudgets automatically when `minScale > 0`, but you can add explicit ones for critical services:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-api-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      serving.knative.dev/service: payment-api
```

### Resource Quotas for Knative Namespaces

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: knative-production-quota
  namespace: production
spec:
  hard:
    # Cap the maximum number of Revisions
    count/revisions.serving.knative.dev: "50"
    # Cap the maximum number of Services
    count/services.serving.knative.dev: "20"
    # Standard resource limits
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "40"
    limits.memory: "80Gi"
```

### Network Policies for Knative

```yaml
# Allow only ingress from the Knative system components
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: knative-service-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      serving.knative.dev/service: payment-api
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: knative-serving
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kourier-system
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
            cidr: 10.0.0.0/8
```

## Troubleshooting Common Issues

### Service Stuck in "Not Ready"

```bash
# Check the service conditions
kubectl describe ksvc payment-api -n production

# Common conditions to check:
# ConfigurationsReady: False -> check Configuration object
# RoutesReady: False -> check Route and Ingress objects

# Check the controller logs
kubectl logs -n knative-serving deploy/controller --since=5m | grep -E "ERROR|payment-api"

# Check webhook logs for admission failures
kubectl logs -n knative-serving deploy/webhook --since=5m | grep -E "ERROR|payment-api"
```

### Activator Not Forwarding Requests

```bash
# Check activator health
kubectl logs -n knative-serving deploy/activator --since=5m | grep -E "ERROR|WARN"

# Check if activator has endpoints for the revision
kubectl get endpoints -n production payment-api

# Verify the revision is addressable
kubectl get revision payment-api-v3-2031120501 -n production \
  -o jsonpath='{.status.conditions}'
```

### Scale-from-Zero Takes Too Long

```bash
# Check autoscaler decision logs
kubectl logs -n knative-serving deploy/autoscaler --since=5m | \
  grep -E "payment-api|scaling"

# Check pod startup times
kubectl get events -n production --sort-by='.lastTimestamp' | \
  grep -E "payment-api|Pulling|Pulled|Started"

# Measure actual cold start
time curl -s https://payment-api.production.example.com/health/ready
```

## Summary

Knative Serving v1.x provides production-grade serverless primitives on top of Kubernetes. The KPA autoscaler's panic/stable window algorithm handles burst traffic without over-provisioning, while explicit revision naming and traffic percentage controls enable safe progressive delivery. Custom domain mapping with automatic TLS, combined with fine-grained resource quota enforcement, makes Knative suitable for multi-tenant production environments. The key operational practices are: name revisions explicitly, set `scaleDownDelay` appropriate to your workload's session length, pre-warm critical services with `minScale: 1`, and monitor cold-start latency through the activator request latency histogram.
