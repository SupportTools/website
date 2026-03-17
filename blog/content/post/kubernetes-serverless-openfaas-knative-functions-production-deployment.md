---
title: "Kubernetes Serverless with OpenFaaS and Knative Functions: FaaS Production Deployment"
date: 2030-10-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OpenFaaS", "Knative", "Serverless", "FaaS", "Autoscaling", "Event-Driven"]
categories:
- Kubernetes
- Serverless
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise FaaS guide covering OpenFaaS operator deployment, Knative Functions vs OpenFaaS architecture, function packaging, auto-scaling to zero, event triggers (Kafka, cron, HTTP), function monitoring, and production operational patterns for serverless Kubernetes."
more_link: "yes"
url: "/kubernetes-serverless-openfaas-knative-functions-production-deployment/"
---

Running serverless functions on Kubernetes gives organizations the cost efficiency of scale-to-zero infrastructure alongside the control of self-hosted compute. OpenFaaS and Knative Functions represent two mature approaches with distinct architectural philosophies: OpenFaaS prioritizes operational simplicity and a broad function template ecosystem; Knative provides a more deeply integrated cloud-native abstraction built on Kubernetes-native APIs.

<!--more-->

## Section 1: Architecture Comparison

### OpenFaaS Architecture

OpenFaaS consists of three components:
- **Gateway**: HTTP API for function invocation and management, proxies requests to function replicas
- **Queue-Worker**: Processes asynchronous invocations from a queue (NATS JetStream or Postgres)
- **faas-netes**: Kubernetes operator that translates Function CRDs into Deployments and Services

Functions run as standard Kubernetes Deployments, making them fully observable with existing tooling. The watchdog process inside each function container manages the function lifecycle and health checks.

### Knative Functions Architecture

Knative Functions is built on the Knative Serving and Eventing APIs:
- **Knative Serving**: Manages the revision lifecycle, traffic splitting, and scale-to-zero via the KPA (Knative Pod Autoscaler)
- **Knative Eventing**: Provides CloudEvents-based event delivery from brokers, channels, and sources
- **func CLI**: Builds and deploys functions as OCI images

Knative uses a activator/queue-proxy sidecar model where the activator intercepts traffic during cold starts and buffers requests until the pod is ready.

### When to Choose Each

| Criterion | OpenFaaS | Knative |
|-----------|----------|---------|
| Operational simplicity | High | Moderate |
| Scale-to-zero speed | 2-30s cold start | 1-10s cold start |
| Kubernetes integration depth | Good | Deep (native CRDs) |
| Event source ecosystem | Good (KEDA integration) | Excellent (CloudEvents native) |
| Function template library | Large (50+ templates) | Smaller |
| Multi-tenant isolation | Via namespaces | Via namespace + network policies |
| Traffic splitting / canary | Via annotations | Native (revision-based) |

## Section 2: OpenFaaS Installation

### Installing the OpenFaaS Operator

```bash
helm repo add openfaas https://openfaas.github.io/faas-netes/

# Create namespaces
kubectl apply -f https://raw.githubusercontent.com/openfaas/faas-netes/master/namespaces.yml

# Deploy OpenFaaS
helm upgrade --install openfaas openfaas/openfaas \
  --namespace openfaas \
  --set functionNamespace=openfaas-fn \
  --set operator.create=true \
  --set gateway.replicas=2 \
  --set queueWorker.replicas=2 \
  --set nats.channel=faas-request \
  --set faasnetes.httpProbe=true \
  --set gateway.upstreamTimeout=60s \
  --set gateway.writeTimeout=65s \
  --set gateway.readTimeout=65s \
  --set gateway.resources.requests.cpu=100m \
  --set gateway.resources.requests.memory=128Mi \
  --set serviceType=ClusterIP \
  --set ingressOperator.create=true
```

### Authentication Configuration

```bash
# Get the auto-generated admin password
PASSWORD=$(kubectl get secret -n openfaas basic-auth \
  -o jsonpath="{.data.basic-auth-password}" | base64 --decode)

echo "OpenFaaS Gateway Password: $PASSWORD"

# Log in with faas-cli
faas-cli login \
  --gateway http://gateway.openfaas.svc.cluster.local:8080 \
  --username admin \
  --password "$PASSWORD"
```

### Ingress for External Access

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: openfaas-gateway
  namespace: openfaas
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "120"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - functions.example.com
      secretName: functions-tls
  rules:
    - host: functions.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: gateway
                port:
                  number: 8080
```

## Section 3: OpenFaaS Function Development

### Function Structure

```go
// handler.go — Go function for OpenFaaS
package function

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
)

type Request struct {
    UserID  string `json:"user_id"`
    Action  string `json:"action"`
    Payload []byte `json:"payload"`
}

type Response struct {
    Status  string `json:"status"`
    Message string `json:"message"`
    JobID   string `json:"job_id,omitempty"`
}

// Handle is the function entry point for OpenFaaS Go templates
func Handle(w http.ResponseWriter, r *http.Request) {
    var input Request

    if r.Method == http.MethodPost {
        body, err := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024)) // 1 MB limit
        if err != nil {
            http.Error(w, "failed to read body", http.StatusBadRequest)
            return
        }
        defer r.Body.Close()

        if err := json.Unmarshal(body, &input); err != nil {
            http.Error(w, "invalid JSON", http.StatusBadRequest)
            return
        }
    }

    // Function business logic
    jobID, err := processRequest(r.Context(), input)
    if err != nil {
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusInternalServerError)
        json.NewEncoder(w).Encode(Response{
            Status:  "error",
            Message: err.Error(),
        })
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusAccepted)
    json.NewEncoder(w).Encode(Response{
        Status:  "accepted",
        Message: "job queued",
        JobID:   jobID,
    })
}

func processRequest(ctx context.Context, req Request) (string, error) {
    // Access environment variables for configuration
    dbURL := os.Getenv("DB_URL")
    if dbURL == "" {
        return "", fmt.Errorf("DB_URL not configured")
    }
    // ... function logic
    return "job-abc123", nil
}
```

### Function Stack (stack.yml)

```yaml
# stack.yml — OpenFaaS function deployment descriptor
version: 1.0
provider:
  name: openfaas
  gateway: https://functions.example.com

functions:
  user-processor:
    lang: golang-middleware
    handler: ./user-processor
    image: registry.example.com/functions/user-processor:v1.2.0
    labels:
      com.openfaas.scale.min: "1"
      com.openfaas.scale.max: "20"
      com.openfaas.scale.factor: "20"
      com.openfaas.scale.type: "capacity"
      com.openfaas.scale.target: "50"  # Target concurrent requests per replica
      com.openfaas.scale.zero: "true"
      com.openfaas.scale.zero-duration: "15m"
    annotations:
      topic: "user-events"  # Kafka trigger annotation
    environment:
      DB_URL: "postgresql://user-db.production.svc:5432/users"
      LOG_LEVEL: "info"
    secrets:
      - db-credentials
      - api-keys
    limits:
      cpu: "500m"
      memory: "256Mi"
    requests:
      cpu: "100m"
      memory: "64Mi"
    readOnlyRootFilesystem: true
    constraints:
      - "kubernetes.io/arch=amd64"

  image-resizer:
    lang: python3-http
    handler: ./image-resizer
    image: registry.example.com/functions/image-resizer:v2.0.0
    labels:
      com.openfaas.scale.min: "0"
      com.openfaas.scale.max: "50"
      com.openfaas.scale.zero: "true"
      com.openfaas.scale.zero-duration: "5m"
    environment:
      MAX_SIZE_MB: "10"
    secrets:
      - s3-credentials
    limits:
      cpu: "2"
      memory: "512Mi"
    requests:
      cpu: "200m"
      memory: "128Mi"
```

Deploy:

```bash
faas-cli build -f stack.yml
faas-cli push -f stack.yml
faas-cli deploy -f stack.yml
```

### Function CRD (Operator Mode)

```yaml
apiVersion: openfaas.com/v1
kind: Function
metadata:
  name: user-processor
  namespace: openfaas-fn
spec:
  name: user-processor
  image: registry.example.com/functions/user-processor:v1.2.0
  labels:
    com.openfaas.scale.min: "1"
    com.openfaas.scale.max: "20"
    com.openfaas.scale.zero: "true"
    com.openfaas.scale.zero-duration: "15m"
  environment:
    DB_URL: "postgresql://user-db.production.svc:5432/users"
    LOG_LEVEL: "info"
  readOnlyRootFilesystem: true
  requests:
    cpu: "100m"
    memory: "64Mi"
  limits:
    cpu: "500m"
    memory: "256Mi"
  secrets:
    - db-credentials
```

## Section 4: Knative Functions Installation

### Installing Knative Serving

```bash
# Install Knative Serving CRDs
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.16.0/serving-crds.yaml

# Install Knative Serving core
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.16.0/serving-core.yaml

# Install Kourier as the networking layer
kubectl apply -f https://github.com/knative/net-kourier/releases/download/knative-v1.16.0/kourier.yaml

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Configure domain
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"functions.example.com":""}}'

# Install Knative Eventing
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.16.0/eventing-crds.yaml
kubectl apply -f https://github.com/knative/eventing/releases/download/knative-v1.16.0/eventing-core.yaml
```

### Knative Autoscaler Configuration

```yaml
# ConfigMap for KPA (Knative Pod Autoscaler)
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Scale to zero after 60 seconds of inactivity
  scale-to-zero-grace-period: "60s"
  # Minimum time between scale decisions
  stable-window: "60s"
  # Shorter window for burst traffic detection
  panic-window-percentage: "10.0"
  # Scale up when utilization exceeds 70% during panic window
  panic-threshold-percentage: "200.0"
  # Maximum scale up rate (doubles per 1 second)
  max-scale-up-rate: "1000.0"
  # Maximum scale down rate
  max-scale-down-rate: "2.0"
  # Enable scale-to-zero globally
  enable-scale-to-zero: "true"
  # Initial scale (replicas when first request arrives)
  initial-scale: "1"
  # Allow scale to zero
  allow-zero-initial-scale: "true"
```

## Section 5: Knative Function Development

### Install kn func CLI

```bash
# Download and install kn func
wget https://github.com/knative/func/releases/latest/download/func_linux_amd64
chmod +x func_linux_amd64
mv func_linux_amd64 /usr/local/bin/func

# Verify
func version
```

### Creating a Knative Function

```bash
# Create a new Go function
func create --language go order-processor
cd order-processor
```

```go
// handle.go — Knative Function handler
package function

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "os"

    cloudevents "github.com/cloudevents/sdk-go/v2"
)

// Handle handles CloudEvents
func Handle(ctx context.Context, event cloudevents.Event) (*cloudevents.Event, error) {
    var orderData OrderEvent
    if err := event.DataAs(&orderData); err != nil {
        return nil, fmt.Errorf("parse event data: %w", err)
    }

    // Process the order
    result, err := processOrder(ctx, orderData)
    if err != nil {
        return nil, err
    }

    // Create response CloudEvent
    responseEvent := cloudevents.NewEvent()
    responseEvent.SetType("com.example.order.processed")
    responseEvent.SetSource("order-processor")
    responseEvent.SetID(event.ID() + "-processed")
    if err := responseEvent.SetData(cloudevents.ApplicationJSON, result); err != nil {
        return nil, err
    }

    return &responseEvent, nil
}

// HandleHTTP handles plain HTTP requests (alternative entry point)
func HandleHTTP(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]string{
        "status": "healthy",
        "version": os.Getenv("K_REVISION"),
    })
}

type OrderEvent struct {
    OrderID    string  `json:"order_id"`
    CustomerID string  `json:"customer_id"`
    Amount     float64 `json:"amount"`
    Items      []Item  `json:"items"`
}

type Item struct {
    SKU      string `json:"sku"`
    Quantity int    `json:"quantity"`
    Price    float64 `json:"price"`
}

type OrderResult struct {
    OrderID    string `json:"order_id"`
    Status     string `json:"status"`
    PaymentRef string `json:"payment_ref"`
}

func processOrder(ctx context.Context, order OrderEvent) (*OrderResult, error) {
    // Business logic
    return &OrderResult{
        OrderID:    order.OrderID,
        Status:     "processed",
        PaymentRef: "pay-" + order.OrderID,
    }, nil
}
```

### func.yaml Configuration

```yaml
# func.yaml
specVersion: 0.36.0
name: order-processor
runtime: go
registry: registry.example.com/functions
image: registry.example.com/functions/order-processor:v1.0.0
namespace: production
created: 2030-10-31T00:00:00-05:00

run:
  volumes:
    - path: /etc/secrets
      secret: order-processor-secrets
  envs:
    - name: DB_URL
      value: "postgresql://orders.production.svc:5432/orders"
    - name: LOG_FORMAT
      value: json

build:
  buildpacks:
    - paketo-buildpacks/go

deploy:
  namespace: production
  serviceAccountName: order-processor
  annotations:
    autoscaling.knative.dev/minScale: "1"
    autoscaling.knative.dev/maxScale: "30"
    autoscaling.knative.dev/target: "100"
    autoscaling.knative.dev/metric: "concurrency"
  resources:
    requests:
      cpu: "100m"
      memory: "128Mi"
    limits:
      cpu: "1"
      memory: "512Mi"
```

```bash
# Build and deploy
func build
func deploy --registry registry.example.com/functions
```

## Section 6: Event Triggers

### OpenFaaS with KEDA Kafka Trigger

KEDA integrates with OpenFaaS to trigger function scale-up based on Kafka consumer lag:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: user-processor-kafka-scaler
  namespace: openfaas-fn
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: user-processor
  minReplicaCount: 0
  maxReplicaCount: 30
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka.svc.cluster.local:9092
        consumerGroup: user-processor
        topic: user-events
        lagThreshold: "10"
      authenticationRef:
        name: kafka-trigger-auth
```

### Knative Eventing with Kafka Source

```yaml
# KafkaSource delivers messages as CloudEvents to a Knative Service
apiVersion: sources.knative.dev/v1beta1
kind: KafkaSource
metadata:
  name: user-events-source
  namespace: production
spec:
  consumerGroup: knative-order-processor
  bootstrapServers:
    - kafka.kafka.svc.cluster.local:9092
  topics:
    - user-events
  sink:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: order-processor
  consumers: 3
```

### Knative CronJobSource for Scheduled Functions

```yaml
apiVersion: sources.knative.dev/v1
kind: ApiServerSource
metadata:
  name: daily-report-trigger
  namespace: production
spec:
  schedule: "0 6 * * *"  # 6 AM UTC daily
  timezone: "UTC"
  data: '{"type":"daily-report","date":"trigger"}'
  sink:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: report-generator
```

For cron-based triggering, use the Knative cron job source:

```yaml
apiVersion: sources.knative.dev/v1
kind: PingSource
metadata:
  name: daily-report-ping
  namespace: production
spec:
  schedule: "0 6 * * *"
  timezone: "UTC"
  contentType: application/json
  data: '{"trigger":"daily-report","reportType":"summary"}'
  sink:
    ref:
      apiVersion: serving.knative.dev/v1
      kind: Service
      name: report-generator
```

## Section 7: Traffic Splitting and Canary Deployments

### Knative Traffic Splitting

Knative Serving provides native traffic splitting across revisions:

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: order-processor
  namespace: production
spec:
  template:
    metadata:
      name: order-processor-v2-1-0
      annotations:
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/maxScale: "30"
    spec:
      containers:
        - image: registry.example.com/functions/order-processor:v2.1.0
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
  traffic:
    - revisionName: order-processor-v2-0-0
      percent: 90
      tag: stable
    - revisionName: order-processor-v2-1-0
      percent: 10
      tag: canary
```

Gradually shift traffic after validating the canary:

```bash
# Shift to 50/50
kubectl patch ksvc order-processor -n production --type='json' \
  -p='[{"op":"replace","path":"/spec/traffic/0/percent","value":50},
       {"op":"replace","path":"/spec/traffic/1/percent","value":50}]'

# Full promotion
kubectl patch ksvc order-processor -n production --type='json' \
  -p='[{"op":"replace","path":"/spec/traffic","value":[
    {"revisionName":"order-processor-v2-1-0","percent":100,"tag":"stable"}
  ]}]'
```

## Section 8: Function Monitoring

### Prometheus Metrics for OpenFaaS

OpenFaaS Gateway exposes Prometheus metrics at `/metrics`:

```yaml
# Prometheus ServiceMonitor for OpenFaaS
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: openfaas-gateway
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: gateway
  namespaceSelector:
    matchNames:
      - openfaas
  endpoints:
    - port: metrics
      interval: 15s
      path: /metrics
```

Key OpenFaaS metrics:

```promql
# Function invocation rate
rate(gateway_function_invocation_total{function_name="user-processor"}[5m])

# Function duration P99
histogram_quantile(0.99,
  rate(gateway_functions_seconds_bucket{function_name="user-processor"}[5m])
)

# Replica count
gateway_service_target_load{function_name="user-processor"}

# Scale-to-zero events
increase(gateway_function_scale_to_zero_total[1h])
```

### Alerting Rules

```yaml
groups:
  - name: openfaas
    rules:
      - alert: FunctionHighErrorRate
        expr: |
          (
            rate(gateway_function_invocation_total{
              function_name=~".+",
              code=~"5.."
            }[5m])
            /
            rate(gateway_function_invocation_total{
              function_name=~".+"
            }[5m])
          ) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Function {{ $labels.function_name }} error rate is {{ $value | humanizePercentage }}"

      - alert: FunctionHighLatency
        expr: |
          histogram_quantile(0.99,
            rate(gateway_functions_seconds_bucket[5m])
          ) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Function {{ $labels.function_name }} P99 latency > 10s"

      - alert: FunctionScaleToZeroError
        expr: |
          increase(gateway_function_invocation_total{
            code="504"
          }[5m]) > 5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Function timeout errors — possible cold start issue"
```

### Knative Service Monitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: knative-serving
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: autoscaler
  namespaceSelector:
    matchNames:
      - knative-serving
  endpoints:
    - port: metrics
      interval: 15s
```

```promql
# Knative activator request queue depth
activator_request_count_v2{namespace_name="production",service_name="order-processor"}

# KPA concurrency
kpa_scale_target{namespace_name="production",service_name="order-processor"}

# Revision active status
revision_app_request_count{namespace_name="production",service_name="order-processor"}
```

## Section 9: Production Operational Patterns

### Function Versioning and Rollback

```bash
# List all function revisions
kubectl get revisions -n production -l serving.knative.dev/service=order-processor

# Rollback to previous revision
kubectl patch ksvc order-processor -n production \
  --type=json \
  -p='[{"op":"replace","path":"/spec/traffic/0/revisionName","value":"order-processor-v1-5-0"}]'

# For OpenFaaS: rollback by redeploying previous image
faas-cli deploy --image registry.example.com/functions/user-processor:v1.1.0 \
  --name user-processor
```

### Secret Management for Functions

```yaml
# Create secrets for function use
kubectl create secret generic db-credentials \
  --from-literal=DB_PASSWORD=<db-password> \
  --from-literal=DB_URL=postgresql://user:${DB_PASSWORD}@db.production.svc:5432/app \
  --namespace openfaas-fn

# For Knative Functions, use standard Kubernetes secrets
kubectl create secret generic order-processor-secrets \
  --from-literal=DB_PASSWORD=<db-password> \
  --from-literal=PAYMENT_API_KEY=<payment-api-key> \
  --namespace production
```

### Resource Quotas for Function Namespaces

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: function-quota
  namespace: openfaas-fn
spec:
  hard:
    requests.cpu: "20"
    requests.memory: "40Gi"
    limits.cpu: "100"
    limits.memory: "200Gi"
    pods: "200"
    count/deployments.apps: "50"
```

### Function Health Check and Self-Healing

```yaml
# Add custom readiness probe to OpenFaaS function via annotation
apiVersion: openfaas.com/v1
kind: Function
metadata:
  name: user-processor
  namespace: openfaas-fn
  annotations:
    com.openfaas.health.http.path: "/_/health"
    com.openfaas.health.http.initialDelay: "5s"
    com.openfaas.health.http.periodSeconds: "10"
spec:
  name: user-processor
  image: registry.example.com/functions/user-processor:v1.2.0
  # Standard Kubernetes probes via handler annotations
```

### Cold Start Mitigation

Cold start latency is the primary operational challenge with scale-to-zero functions:

```bash
# OpenFaaS: Set minimum replicas to 1 for latency-sensitive functions
kubectl label deployment user-processor -n openfaas-fn \
  com.openfaas.scale.min=1

# Knative: Set minScale annotation
kubectl patch ksvc order-processor -n production --type=json \
  -p='[{"op":"replace","path":"/spec/template/metadata/annotations/autoscaling.knative.dev~1minScale","value":"1"}]'

# OpenFaaS: Pre-warm functions on startup using a health check caller
# Deploy a CronJob that calls the function every minute to keep it warm
# when scale-to-zero is required but cold starts are acceptable
```

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: function-warmer
  namespace: openfaas-fn
spec:
  schedule: "*/5 8-18 * * 1-5"  # Every 5 minutes during business hours
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: warmer
              image: curlimages/curl:8.5.0
              command:
                - sh
                - -c
                - |
                  curl -s -o /dev/null -w "%{http_code}" \
                    --max-time 30 \
                    http://gateway.openfaas.svc.cluster.local:8080/function/user-processor/health
```

## Section 10: Choosing Between OpenFaaS and Knative in Production

The decision ultimately comes down to organizational priorities:

**Choose OpenFaaS when:**
- Team is new to serverless on Kubernetes
- Broad template ecosystem is needed (Python, Node, Go, Java, Rust)
- Operational simplicity is the top priority
- NATS or Postgres queue integration is already in use
- Functions are primarily HTTP-triggered

**Choose Knative when:**
- CloudEvents-based event-driven architecture is the standard
- Deep Kubernetes integration and CRD-native configuration are priorities
- Traffic splitting and revision-based canary deployments are required
- Team already uses the Knative serving model for non-function workloads
- CNCF standards compliance is required (Knative is a CNCF incubating project)

Both platforms handle the core FaaS requirements—scale-to-zero, event triggers, function packaging, and observability. Investing in a solid function packaging standard (OCI images with health check endpoints) and consistent observability from day one makes it possible to migrate between platforms if organizational needs evolve.
