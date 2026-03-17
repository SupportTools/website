---
title: "Knative Serving: Autoscaling to Zero and Back for Serverless Kubernetes Workloads"
date: 2030-06-06T00:00:00-05:00
draft: false
tags: ["Knative", "Kubernetes", "Serverless", "Autoscaling", "OpenTelemetry", "Cloud Native", "Scale-to-Zero"]
categories:
- Kubernetes
- Serverless
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Knative Serving guide: KPA and HPA autoscalers, scale-to-zero configuration, cold start mitigation, traffic splitting, custom domain mapping, and observability with OpenTelemetry."
more_link: "yes"
url: "/knative-serving-autoscaling-zero-serverless-kubernetes/"
---

Knative Serving brings serverless workload management to Kubernetes without requiring a managed cloud function platform. Its autoscaling model — scaling to zero replicas when idle and back to serving replicas within seconds of new traffic — enables significant infrastructure cost savings for workloads with variable demand. This guide covers the production patterns that make Knative Serving reliable in enterprise environments: autoscaler configuration, cold start mitigation, traffic splitting for blue/green and canary deployments, and the observability integration needed to operate it confidently.

<!--more-->

## Knative Serving Architecture

### Core Components

Knative Serving builds on three primary CRDs:

- **Service (ksvc)**: The top-level abstraction. Manages the full lifecycle of a revision-based deployment and automatically creates Routes and Configurations.
- **Configuration**: Represents the desired state of a workload at a point in time. Each update to a Service creates a new Configuration, which creates a new Revision.
- **Revision**: An immutable snapshot of a Configuration. Multiple revisions exist simultaneously, enabling traffic splitting.
- **Route**: Defines how traffic is distributed across revisions. Routes map to Kubernetes Services with stable DNS names.

### Networking Ingress

Knative Serving requires a networking layer to route external traffic to revisions. Options include:

- **Kourier** — Lightweight Envoy-based ingress maintained by Knative (recommended for most installations)
- **Istio** — Full service mesh; adds observability and mTLS but significant resource overhead
- **Contour** — Envoy-based; good performance and native TLS management

## Installing Knative Serving

### Core Installation

```bash
# Install Knative Serving core CRDs
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.14.0/serving-crds.yaml

# Install core serving components
kubectl apply -f https://github.com/knative/serving/releases/download/knative-v1.14.0/serving-core.yaml

# Install Kourier networking layer
kubectl apply -f https://github.com/knative/net-kourier/releases/download/knative-v1.14.0/kourier.yaml

# Configure Knative to use Kourier
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# Verify installation
kubectl -n knative-serving get pods
```

Expected output:

```
NAME                                      READY   STATUS    RESTARTS   AGE
activator-7d8d4f5b9-xk9vp                1/1     Running   0          2m
autoscaler-6b44d7d7f5-nt8lq              1/1     Running   0          2m
controller-7fd9fdc5c5-zrp4x              1/1     Running   0          2m
net-kourier-controller-b6fcdc8b9-m9vqj   1/1     Running   0          2m
webhook-6f7d699548-fj8qx                 1/1     Running   0          2m
```

### DNS Configuration

```bash
# For local development, use sslip.io for automatic DNS
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"sslip.io":""}}'

# For production, configure your actual domain
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"apps.example.com":""}}'
```

## Deploying a Knative Service

### Minimal Service Deployment

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: hello-world
  namespace: production
spec:
  template:
    spec:
      containers:
        - image: gcr.io/knative-samples/helloworld-go:v1.0.0
          env:
            - name: TARGET
              value: "Knative"
          ports:
            - containerPort: 8080
```

```bash
kubectl apply -f hello-world.yaml

# Check the service status
kubectl get ksvc hello-world -n production

# Get the URL
kubectl get ksvc hello-world -n production -o jsonpath='{.status.url}'
```

### Production Service Configuration

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: payment-processor
  namespace: production
  labels:
    app: payment-processor
    team: platform
  annotations:
    serving.knative.dev/creator: platform-team
spec:
  template:
    metadata:
      annotations:
        # Autoscaling configuration
        autoscaling.knative.dev/class: kpa.autoscaling.knative.dev
        autoscaling.knative.dev/metric: rps
        autoscaling.knative.dev/target: "100"
        autoscaling.knative.dev/minScale: "2"
        autoscaling.knative.dev/maxScale: "50"
        autoscaling.knative.dev/scale-down-delay: "300s"
        autoscaling.knative.dev/window: "60s"

        # Queue proxy settings
        queue.sidecar.serving.knative.dev/resourcePercentage: "25"
    spec:
      containerConcurrency: 10
      timeoutSeconds: 300
      serviceAccountName: payment-processor-sa
      containers:
        - name: payment-processor
          image: registry.example.com/payment-processor:v2.3.1
          ports:
            - containerPort: 8080
              protocol: TCP
          env:
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: payment-db-secret
                  key: host
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: payment-db-secret
                  key: password
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 15
```

## Autoscaling Deep Dive

### Knative Pod Autoscaler (KPA)

KPA is Knative's default autoscaler. It scales based on observed concurrent requests or requests-per-second, with a unique behavior: it can scale to zero.

#### KPA Scaling Algorithm

KPA maintains a sliding window of metrics and computes the desired replica count:

```
desired_replicas = ceil(observed_metric / target_per_replica)
```

With smoothing: KPA uses a stable window (default 60s) and a panic window (default 6s) for fast scale-up.

#### Panic Mode

When traffic spikes rapidly, KPA switches to panic mode using a shorter window:

```
if (observed_metric / current_replicas) > (2 * target_per_replica):
    enter_panic_mode()
    use_panic_window = 6s
    # Scale up aggressively
```

Panic mode prevents traffic saturation during sudden spikes.

### KPA Configuration via ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Stable window for scale decisions (averaging period)
  stable-window: "60s"

  # Panic window for rapid scale-up
  panic-window: "6s"
  panic-window-percentage: "10.0"

  # Scale-to-zero grace period after last request
  scale-to-zero-grace-period: "30s"

  # Minimum time between scale-down steps
  scale-down-delay: "0s"

  # Pod retention after scale-to-zero for faster cold starts
  scale-to-zero-pod-retention-period: "0s"

  # Default target concurrency per pod
  container-concurrency-target-default: "100"

  # Utilization threshold (scale when at this % of target)
  container-concurrency-target-percentage: "0.7"

  # Default requests-per-second target
  requests-per-second-target-default: "200"

  # Activator capacity (how many requests activator buffers before scaling)
  activator-capacity: "100.0"
```

### HPA Configuration

For workloads that should NOT scale to zero (always-on services), use HPA:

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: always-on-api
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Use HPA instead of KPA
        autoscaling.knative.dev/class: hpa.autoscaling.knative.dev
        autoscaling.knative.dev/metric: cpu
        autoscaling.knative.dev/target: "80"
        autoscaling.knative.dev/minScale: "3"
        autoscaling.knative.dev/maxScale: "100"
    spec:
      containerConcurrency: 0  # Unlimited concurrent requests per pod
      containers:
        - image: registry.example.com/always-on-api:v1.5.0
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
```

### Per-Metric Autoscaling

```yaml
# Concurrency-based (good for CPU-bound workloads)
annotations:
  autoscaling.knative.dev/metric: concurrency
  autoscaling.knative.dev/target: "10"  # 10 concurrent requests per pod

# RPS-based (good for I/O-bound workloads)
annotations:
  autoscaling.knative.dev/metric: rps
  autoscaling.knative.dev/target: "100"  # 100 RPS per pod

# CPU-based (only available with HPA class)
annotations:
  autoscaling.knative.dev/class: hpa.autoscaling.knative.dev
  autoscaling.knative.dev/metric: cpu
  autoscaling.knative.dev/target: "70"  # 70% CPU utilization
```

## Scale-to-Zero and Cold Start Mitigation

### Understanding the Cold Start Path

When a service is scaled to zero:

1. A new request arrives at the Kourier ingress.
2. Knative routes the request to the **Activator** (a buffer service in the knative-serving namespace).
3. The Activator holds the request in a queue and sends a scale-from-zero event to the Autoscaler.
4. The Autoscaler increases the desired replica count to 1+.
5. Kubernetes schedules a new pod; the pod starts and passes readiness checks.
6. The Activator forwards buffered requests to the new pod.

Total cold start time = pod scheduling + container pull + application init + readiness check.

### Measuring Cold Start Latency

```bash
# Measure cold start time with ab (Apache Benchmark)
# First, scale to zero
kubectl scale deployment -n knative-serving activator --replicas=2

# Wait for scale-to-zero
sleep 60

# Measure time to first byte
curl -w "@curl-format.txt" -o /dev/null -s \
  "https://payment-processor.production.apps.example.com/health"
```

```
# curl-format.txt
     time_namelookup:  %{time_namelookup}s\n
        time_connect:  %{time_connect}s\n
     time_appconnect:  %{time_appconnect}s\n
    time_pretransfer:  %{time_pretransfer}s\n
       time_redirect:  %{time_redirect}s\n
  time_starttransfer:  %{time_starttransfer}s\n
                     ----------\n
          time_total:  %{time_total}s\n
```

### Cold Start Mitigation Strategies

#### Strategy 1: Minimum Replicas (minScale > 0)

The most direct approach — never scale below a minimum:

```yaml
annotations:
  autoscaling.knative.dev/minScale: "1"  # Always keep 1 pod running
  autoscaling.knative.dev/maxScale: "50"
```

Trade-off: Eliminates cold starts at the cost of baseline pod costs.

#### Strategy 2: Container Image Optimization

Reduce cold start time by minimizing image size and initialization overhead:

```dockerfile
# Optimized production image
FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /app/server \
    ./cmd/server

# Final stage: minimal base image
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /app/server /server
USER nonroot
ENTRYPOINT ["/server"]
```

Target: < 5MB image, < 100ms application startup time.

#### Strategy 3: Pre-warming with Pod Retention

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Keep pods warm for 2 minutes after scale-down
  scale-to-zero-pod-retention-period: "2m"
  # Grace period before scale-to-zero
  scale-to-zero-grace-period: "60s"
```

#### Strategy 4: Activator Buffer Tuning

The Activator can buffer requests while pods start:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-autoscaler
  namespace: knative-serving
data:
  # Number of requests the activator buffers per in-progress pod scale-up
  activator-capacity: "200.0"
```

```yaml
# Activator resource sizing for high-traffic scenarios
apiVersion: apps/v1
kind: Deployment
metadata:
  name: activator
  namespace: knative-serving
spec:
  replicas: 3  # HA activator deployment
  template:
    spec:
      containers:
        - name: activator
          resources:
            requests:
              cpu: 300m
              memory: 60Mi
            limits:
              cpu: 1000m
              memory: 600Mi
```

## Traffic Splitting

### Blue/Green Deployments

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: api-service
  namespace: production
spec:
  template:
    metadata:
      name: api-service-v3  # Named revision for traffic control
    spec:
      containers:
        - image: registry.example.com/api-service:v3.0.0
  traffic:
    - revisionName: api-service-v2  # Stable/blue
      percent: 100
    - revisionName: api-service-v3  # New/green
      percent: 0
      tag: green  # Accessible at green-api-service.production.apps.example.com
```

Shift traffic after validation:

```bash
# Shift 10% to v3
kubectl patch ksvc api-service -n production \
  --type='json' \
  -p='[
    {"op":"replace","path":"/spec/traffic/0/percent","value":90},
    {"op":"replace","path":"/spec/traffic/1/percent","value":10}
  ]'

# Shift 50% to v3
kubectl patch ksvc api-service -n production \
  --type='json' \
  -p='[
    {"op":"replace","path":"/spec/traffic/0/percent","value":50},
    {"op":"replace","path":"/spec/traffic/1/percent","value":50}
  ]'

# Complete cutover to v3
kubectl patch ksvc api-service -n production \
  --type='json' \
  -p='[
    {"op":"replace","path":"/spec/traffic/0/percent","value":0},
    {"op":"replace","path":"/spec/traffic/1/percent","value":100}
  ]'
```

### Canary with Tagged Revisions

Tags create stable URLs for specific revisions, enabling canary testing without changing traffic weights:

```yaml
spec:
  traffic:
    - latestRevision: false
      revisionName: api-service-v2
      percent: 95
      tag: stable
    - latestRevision: true
      percent: 5
      tag: canary
```

This creates two URLs:
- `https://api-service.production.apps.example.com` — 95% stable, 5% canary
- `https://canary-api-service.production.apps.example.com` — always canary
- `https://stable-api-service.production.apps.example.com` — always stable

### kn CLI for Traffic Management

```bash
# Install kn CLI
curl -LO https://github.com/knative/client/releases/download/knative-v1.14.0/kn-linux-amd64
chmod +x kn-linux-amd64
sudo mv kn-linux-amd64 /usr/local/bin/kn

# Deploy a new revision
kn service update api-service \
  --namespace production \
  --image registry.example.com/api-service:v3.0.0 \
  --traffic api-service-v2=90,@latest=10

# Set traffic split
kn service update api-service \
  --namespace production \
  --traffic api-service-v2=0,api-service-v3=100

# List revisions
kn revision list -n production

# Describe a service
kn service describe api-service -n production
```

## Custom Domain Mapping

### DomainMapping for Custom URLs

```yaml
apiVersion: serving.knative.dev/v1alpha1
kind: DomainMapping
metadata:
  name: api.example.com
  namespace: production
spec:
  ref:
    name: api-service
    kind: Service
    apiVersion: serving.knative.dev/v1
```

### TLS with cert-manager

```yaml
# Configure automatic TLS
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-certmanager
  namespace: knative-serving
data:
  issuerRef: |
    kind: ClusterIssuer
    name: letsencrypt-production

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-network
  namespace: knative-serving
data:
  auto-tls: "Enabled"
  http-protocol: "Redirected"
  domain-template: "{{.Name}}.{{.Namespace}}.{{.Domain}}"
```

## Observability with OpenTelemetry

### Enabling OpenTelemetry in Knative

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: config-tracing
  namespace: knative-serving
data:
  backend: "opentelemetry"
  sample-rate: "0.1"  # 10% sampling in production
  zipkin-endpoint: "http://otel-collector.monitoring:9411/api/v2/spans"
```

### OpenTelemetry Collector Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-collector-config
  namespace: monitoring
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: "0.0.0.0:4317"
          http:
            endpoint: "0.0.0.0:4318"
      zipkin:
        endpoint: "0.0.0.0:9411"

    processors:
      batch:
        timeout: 5s
        send_batch_size: 1000
      memory_limiter:
        limit_mib: 512
        check_interval: 5s
      resource:
        attributes:
          - action: insert
            key: k8s.cluster.name
            value: "production"

    exporters:
      otlp:
        endpoint: "tempo.monitoring:4317"
        tls:
          insecure: true
      prometheus:
        endpoint: "0.0.0.0:8889"
        namespace: knative

    service:
      pipelines:
        traces:
          receivers: [otlp, zipkin]
          processors: [memory_limiter, batch, resource]
          exporters: [otlp]
        metrics:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [prometheus]
```

### Prometheus Metrics for Knative

Key metrics to monitor:

```promql
# Request rate by service and revision
sum by (revision_name, namespace_name) (
  rate(revision_request_count[5m])
)

# Request latency P99
histogram_quantile(0.99,
  sum by (revision_name, le) (
    rate(revision_request_latencies_bucket[5m])
  )
)

# Active pods per service (autoscaling metric)
sum by (revision_name, namespace_name) (
  autoscaler_actual_pods
)

# Desired vs actual replicas (indicates scaling pressure)
sum by (revision_name) (autoscaler_desired_pods)
- sum by (revision_name) (autoscaler_actual_pods)

# Cold start frequency (pod starts from zero)
increase(autoscaler_actual_pods{
  previous_state="terminating"
}[1h])

# Activator queue depth (cold start backlog)
sum by (revision_name) (activator_request_count)
```

### Alerting Rules for Knative

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: knative-serving-alerts
  namespace: monitoring
spec:
  groups:
    - name: knative.serving
      rules:
        - alert: KnativeRevisionNotReady
          expr: |
            kube_customresource_status_condition{
              customresource_kind="Revision",
              condition="Ready",
              status!="True"
            } == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Knative revision {{ $labels.name }} is not ready"

        - alert: KnativeHighLatency
          expr: |
            histogram_quantile(0.99,
              sum by (revision_name, le) (
                rate(revision_request_latencies_bucket[5m])
              )
            ) > 2000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Knative revision {{ $labels.revision_name }} P99 latency > 2s"

        - alert: KnativeScalingToZeroConstantly
          expr: |
            increase(autoscaler_actual_pods{current_replicas="0"}[30m]) > 5
          for: 1m
          labels:
            severity: info
          annotations:
            summary: "Service {{ $labels.revision_name }} scaling to zero frequently"
```

## Production Operational Patterns

### Multi-Container (Sidecar) Services

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: app-with-sidecar
  namespace: production
spec:
  template:
    spec:
      containers:
        # Primary container (must expose the port Knative routes to)
        - name: app
          image: registry.example.com/app:v1.0.0
          ports:
            - containerPort: 8080
        # Sidecar container
        - name: otel-collector
          image: otel/opentelemetry-collector-contrib:0.95.0
          args: ["--config=/etc/otel/config.yaml"]
          volumeMounts:
            - name: otel-config
              mountPath: /etc/otel
      volumes:
        - name: otel-config
          configMap:
            name: otel-sidecar-config
```

### Handling Database Connections with Connection Pooling

Scale-to-zero workloads create connection churn. Use PgBouncer or a connection pooler:

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: api-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Keep at least 1 pod to maintain connection pool warmth
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/scale-down-delay: "600s"
    spec:
      containers:
        - name: api
          image: registry.example.com/api:v2.0.0
          env:
            # Connect to PgBouncer (not directly to Postgres)
            - name: DB_HOST
              value: "pgbouncer.production.svc.cluster.local"
            - name: DB_MAX_CONNECTIONS
              value: "5"  # Conservative limit per pod
```

### Graceful Shutdown Handling

```go
// Implement graceful shutdown to handle scale-down correctly
package main

import (
    "context"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    server := &http.Server{
        Addr:    ":8080",
        Handler: buildRouter(),
    }

    // Channel to listen for termination signals
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            panic("server failed: " + err.Error())
        }
    }()

    // Wait for termination signal
    <-quit

    // Knative sends SIGTERM; allow 30s for in-flight requests
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        panic("graceful shutdown failed: " + err.Error())
    }
}
```

Configure the shutdown timeout in the Service spec:

```yaml
spec:
  template:
    spec:
      # Must be > application shutdown timeout
      timeoutSeconds: 300
      containers:
        - name: app
          lifecycle:
            preStop:
              # Delay termination to allow load balancer to drain
              exec:
                command: ["/bin/sleep", "5"]
```

### Rolling Revisions Without Downtime

```bash
# Deploy new revision with traffic split
kn service update payment-processor \
  --namespace production \
  --image registry.example.com/payment-processor:v3.1.0 \
  --traffic @latest=10,payment-processor-v310=0 \
  --tag @latest=canary

# Monitor error rate on canary
watch -n 5 "kubectl top pods -n production -l serving.knative.dev/revision=payment-processor-00003"

# Gradually increase canary traffic
kn service update payment-processor \
  --namespace production \
  --traffic @latest=50,payment-processor-00002=50

# Full cutover
kn service update payment-processor \
  --namespace production \
  --traffic @latest=100

# Roll back if needed
kn revision list -n production
kn service update payment-processor \
  --namespace production \
  --traffic payment-processor-00002=100
```

## Summary

Knative Serving delivers genuine serverless semantics on Kubernetes: workloads that scale from zero to handling hundreds of concurrent requests within seconds, with traffic splitting primitives that make zero-downtime deployments operationally straightforward. The combination of KPA's panic mode for rapid scale-up, configurable scale-to-zero grace periods, and the Activator's request buffering addresses the cold start problem without requiring always-on replicas for every service.

Production deployments require careful attention to autoscaler tuning, particularly the relationship between `containerConcurrency`, target utilization, and replica limits. Database connection pooling and graceful shutdown handling become critical when pods start and stop frequently. OpenTelemetry integration through the collector provides the latency histograms and autoscaling metrics needed to validate scaling behavior and catch regressions before they impact users.
