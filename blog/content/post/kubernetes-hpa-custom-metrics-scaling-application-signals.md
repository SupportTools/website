---
title: "Kubernetes Horizontal Pod Autoscaler Custom Metrics: Scaling on Application Signals"
date: 2031-01-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "Autoscaling", "Prometheus", "Custom Metrics", "KEDA", "Performance"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes HPA custom metrics using Prometheus Adapter and KEDA, covering queue depth, RPS, and latency-based scaling with stabilization windows to prevent oscillation."
more_link: "yes"
url: "/kubernetes-hpa-custom-metrics-scaling-application-signals/"
---

CPU and memory utilization are lagging indicators. By the time CPU spikes, requests are already queueing. By the time memory climbs, your application may have been degraded for seconds. Custom metrics — queue depth, requests per second, P99 latency, active WebSocket connections — are leading indicators that scale your workload before users notice degradation. This guide covers the complete stack for custom metric autoscaling: Prometheus Adapter for the Kubernetes custom metrics API, KEDA for event-driven autoscaling, stabilization windows to prevent oscillation, and the metric selection principles that determine whether your autoscaler stabilizes or thrashes.

<!--more-->

# Kubernetes Horizontal Pod Autoscaler Custom Metrics: Scaling on Application Signals

## Section 1: The HPA Architecture

The Kubernetes HPA controller reconciles a target replica count by querying the metrics API. The metrics pipeline has three tiers:

1. **Core metrics** (metrics.k8s.io): CPU and memory from kubelet via metrics-server.
2. **Custom metrics** (custom.metrics.k8s.io): Application metrics from Prometheus Adapter.
3. **External metrics** (external.metrics.k8s.io): Queue depths, cloud service metrics from KEDA or similar adapters.

```
HPA Controller
    │
    ├── GET /apis/metrics.k8s.io        → metrics-server
    ├── GET /apis/custom.metrics.k8s.io → Prometheus Adapter
    └── GET /apis/external.metrics.k8s.io → KEDA / custom adapter
```

The HPA formula for scaling:

```
desiredReplicas = ceil(currentReplicas × (currentMetricValue / desiredMetricValue))
```

With tolerance: the HPA only scales if the ratio is outside the range `[1-tolerance, 1+tolerance]` (default tolerance is 0.1 = 10%).

## Section 2: Prometheus Adapter — Exposing Custom Metrics to HPA

### 2.1 Installation

```bash
# Add the prometheus-community Helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install Prometheus Adapter
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus.monitoring.svc \
  --set prometheus.port=9090 \
  --set replicaCount=2 \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=256Mi
```

### 2.2 Prometheus Adapter Configuration

The adapter configuration maps Prometheus queries to Kubernetes custom metrics. This is the most important configuration to get right.

```yaml
# prometheus-adapter-rules.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-adapter
  namespace: monitoring
data:
  config.yaml: |
    rules:
    # Rule 1: HTTP Requests per Second (per pod)
    # Exposes: pods/http_requests_per_second
    - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        matches: "^http_requests_total$"
        as: "http_requests_per_second"
      metricsQuery: |
        sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)

    # Rule 2: P99 Request Latency
    # Exposes: pods/http_request_duration_p99
    - seriesQuery: 'http_request_duration_seconds_bucket{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        matches: "^http_request_duration_seconds_bucket$"
        as: "http_request_duration_p99"
      metricsQuery: |
        histogram_quantile(0.99, sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (le, <<.GroupBy>>))

    # Rule 3: Active Connections (gauge)
    # Exposes: pods/active_connections
    - seriesQuery: 'active_connections{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        as: "active_connections"
      metricsQuery: '<<.Series>>{<<.LabelMatchers>>}'

    # Rule 4: Queue Processing Lag (seconds behind)
    # Exposes: pods/kafka_consumer_lag_seconds
    - seriesQuery: 'kafka_consumer_group_lag{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        as: "kafka_consumer_lag"
      metricsQuery: |
        sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)
```

### 2.3 Verifying Custom Metrics Are Available

```bash
# Check that the custom metrics API is responding
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1

# List available custom metrics for pods in a namespace
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" \
  | jq '.items[] | {pod: .describedObject.name, value: .value}'

# If the adapter is correctly configured but returning no data:
# Check that Prometheus has the time series
curl -G http://prometheus:9090/api/v1/query \
  --data-urlencode 'query=http_requests_total{namespace="production"}' \
  | jq '.data.result[:3]'
```

## Section 3: HPA for HTTP Request Rate

### 3.1 Scaling on Requests per Second

```yaml
# hpa-rps.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 30
  metrics:
  # Custom metric: target 100 RPS per pod
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        # Scale when average RPS per pod exceeds 100
        averageValue: "100"
  # Also keep CPU below 70% (belt and suspenders)
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleUp:
      # React quickly to spikes: scale up within 30 seconds
      stabilizationWindowSeconds: 30
      policies:
      # Allow scaling up by 4 pods or 100% of current replicas per minute
      - type: Pods
        value: 4
        periodSeconds: 60
      - type: Percent
        value: 100
        periodSeconds: 60
      # Use the more aggressive policy (Max)
      selectPolicy: Max
    scaleDown:
      # Scale down conservatively: wait 5 minutes to avoid oscillation
      stabilizationWindowSeconds: 300
      policies:
      # Scale down by at most 1 pod per minute
      - type: Pods
        value: 1
        periodSeconds: 60
      selectPolicy: Min
```

### 3.2 Scaling on P99 Latency

Latency-based scaling is the most user-centric approach: scale when users are experiencing slowness, not when CPUs are busy.

```yaml
# hpa-latency.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: checkout-service-hpa
  namespace: ecommerce
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-service
  minReplicas: 5
  maxReplicas: 50
  metrics:
  # Scale when P99 latency exceeds 200ms per pod
  # The adapter returns latency in seconds; 0.2 = 200ms
  - type: Pods
    pods:
      metric:
        name: http_request_duration_p99
      target:
        type: AverageValue
        averageValue: "200m"  # 200 milliunits = 0.2 seconds = 200ms
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600  # 10 minutes for latency signals
      policies:
      - type: Pods
        value: 2
        periodSeconds: 120
```

**Important caveat**: Latency is a per-request metric, not a per-pod metric. When you scale out, latency improves because requests are spread across more pods. But if the bottleneck is a downstream service (database, external API), adding pods won't help latency — it just overloads the downstream service. Always investigate before choosing latency as your scaling signal.

## Section 4: KEDA for Event-Driven Scaling

KEDA (Kubernetes Event-driven Autoscaling) extends the HPA with rich event source support — Kafka topics, Redis queues, AWS SQS, RabbitMQ, and more. It deploys a custom ScaledObject CRD alongside the HPA.

### 4.1 KEDA Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=100Mi \
  --set resources.operator.limits.cpu=1000m \
  --set resources.operator.limits.memory=1000Mi
```

### 4.2 Kafka Queue Depth Scaling

```yaml
# scaledobject-kafka.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: data-pipeline
spec:
  scaleTargetRef:
    name: kafka-consumer
    kind: Deployment
  # Start from 0 replicas (KEDA's killer feature vs native HPA)
  minReplicaCount: 0
  maxReplicaCount: 50
  # Wait 30s before scaling up (avoids scaling on transient spikes)
  cooldownPeriod: 30
  # How often to poll the metric
  pollingInterval: 15
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-bootstrap.kafka-system.svc.cluster.local:9092
      consumerGroup: data-pipeline-consumer
      topic: raw-events
      # Scale when lag exceeds 1000 messages per consumer instance
      lagThreshold: "1000"
      # When to start activation (scale from 0 to 1)
      activationLagThreshold: "1"
      offsetResetPolicy: latest
      sasl: none
      tls: enable
    authenticationRef:
      name: kafka-credentials
---
# TriggerAuthentication for Kafka credentials
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-credentials
  namespace: data-pipeline
spec:
  secretTargetRef:
  - parameter: username
    name: kafka-auth
    key: username
  - parameter: password
    name: kafka-auth
    key: password
```

### 4.3 Redis Queue (List) Scaling

```yaml
# scaledobject-redis.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: redis-worker-scaler
  namespace: async-workers
spec:
  scaleTargetRef:
    name: email-sender-worker
  minReplicaCount: 1
  maxReplicaCount: 20
  cooldownPeriod: 60
  pollingInterval: 10
  triggers:
  - type: redis
    metadata:
      # Redis connection
      address: redis-master.redis.svc.cluster.local:6379
      # Queue key name
      listName: email:queue:pending
      # Target: 100 items per replica
      listLength: "100"
      activationListLength: "1"
      db: "0"
    authenticationRef:
      name: redis-auth
```

### 4.4 Prometheus Scaler in KEDA

KEDA also supports Prometheus as a metric source — a more flexible alternative to Prometheus Adapter:

```yaml
# scaledobject-prometheus.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: websocket-scaler
  namespace: realtime
spec:
  scaleTargetRef:
    name: websocket-server
  minReplicaCount: 2
  maxReplicaCount: 100
  cooldownPeriod: 120
  pollingInterval: 30
  triggers:
  # Scale based on active WebSocket connections
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      # Target: 500 active connections per replica
      threshold: "500"
      activationThreshold: "100"
      query: |
        sum(websocket_active_connections{namespace="realtime",
            deployment="websocket-server"})
  # Second trigger: also scale on message rate
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      threshold: "1000"
      activationThreshold: "10"
      query: |
        sum(rate(websocket_messages_total{namespace="realtime",
            deployment="websocket-server"}[1m]))
```

## Section 5: Stabilization Windows — Preventing Oscillation

Autoscaler oscillation (scale-up, scale-down, scale-up, scale-down) is one of the most common production problems. It causes constant pod churn, application restarts, and wasted capacity.

### 5.1 Understanding the Stabilization Window

The stabilization window tells the HPA to look back at historical metric values and only scale if the decision would have been the same throughout the entire window.

```
Scale-down stabilization = 300s (5 minutes):
  The HPA will only scale down if it would have decided to scale down
  in every check during the last 5 minutes. One spike keeps replicas high.

Scale-up stabilization = 30s:
  The HPA will scale up if ANY check in the last 30s indicated more replicas.
  Responds quickly to bursts.
```

### 5.2 Oscillation Diagnosis

```bash
# View HPA scaling events
kubectl describe hpa api-service-hpa -n production | grep -A 50 "Events:"

# Example oscillation pattern:
# 14:00:00  ScalingReplicaSet  Scaled up   deployment/api-service to 10 replicas
# 14:02:00  ScalingReplicaSet  Scaled down deployment/api-service to 7 replicas
# 14:04:00  ScalingReplicaSet  Scaled up   deployment/api-service to 10 replicas

# Check metric history using Prometheus
# Are metrics oscillating at the boundary?
curl -G http://prometheus:9090/api/v1/query_range \
  --data-urlencode 'query=avg(http_requests_per_second{namespace="production"})' \
  --data-urlencode 'start=2024-03-15T14:00:00Z' \
  --data-urlencode 'end=2024-03-15T14:30:00Z' \
  --data-urlencode 'step=30s' \
  | jq '.data.result[0].values[] | {time: .[0], value: .[1]}'
```

### 5.3 Tuning Stabilization for Different Workloads

```yaml
# hpa-tuned-behavior.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-processor-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-processor
  minReplicas: 5
  maxReplicas: 40
  metrics:
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        # Set target slightly BELOW maximum comfortable load per pod
        # This gives headroom before degradation starts
        # If each pod can handle 200 RPS comfortably: target at 150
        averageValue: "150"
  behavior:
    scaleUp:
      # Scale up aggressively for payment processor
      stabilizationWindowSeconds: 0  # react immediately
      policies:
      # Allow doubling the replica count in 60 seconds
      - type: Percent
        value: 100
        periodSeconds: 60
      # Or add 5 pods at a time, whichever is larger
      - type: Pods
        value: 5
        periodSeconds: 60
      selectPolicy: Max
    scaleDown:
      # Scale down very conservatively: payment traffic has high-value SLAs
      stabilizationWindowSeconds: 600  # 10 minutes
      policies:
      # Remove at most 1 pod per 2 minutes
      - type: Pods
        value: 1
        periodSeconds: 120
      selectPolicy: Min
```

### 5.4 Anti-Oscillation: The "Dead Band" Pattern

Setting the target value with a dead band prevents flapping at the boundary. Instead of scaling when value crosses 100 RPS, scale up at 120 and down at 80:

```yaml
# Unfortunately, HPA does not natively support dead bands.
# Workaround: use separate HPAs for scale-up and scale-down
# (This requires KEDA ScaledObject's more flexible threshold configuration)

# KEDA approach with activation threshold:
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-service-keda
  namespace: production
spec:
  scaleTargetRef:
    name: api-service
  minReplicaCount: 5
  maxReplicaCount: 40
  # Only activate (scale from min) when metric exceeds this
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      # Scale UP when average RPS per current pods > 120 (20% above target)
      threshold: "120"
      # Activate (0 → min) when total RPS > 600 (5 pods × 120)
      activationThreshold: "600"
      query: |
        avg(rate(http_requests_total{namespace="production",
            deployment="api-service"}[2m]))
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
          - type: Pods
            value: 2
            periodSeconds: 120
        scaleUp:
          stabilizationWindowSeconds: 30
```

## Section 6: Metric Selection Principles

### 6.1 Leading vs Lagging Metrics

| Metric Type | Examples | Lag | Best For |
|---|---|---|---|
| **Leading** | Queue depth, connection count, active sessions | Low | Preventing degradation |
| **Concurrent** | Requests per second, message rate | Medium | Matching capacity to load |
| **Lagging** | CPU utilization, memory, P99 latency | High | Confirming capacity issues |

### 6.2 Per-Pod vs Aggregate Metrics

The HPA `Pods` metric type computes the average value per pod and compares to your target. The `Object` and `External` types compare a single aggregate value.

**When to use `Pods` (AverageValue):**
- Each pod independently contributes to the metric (HTTP RPS, connections)
- The workload is stateless and pods are interchangeable
- Formula: `desiredReplicas = ceil(totalMetricValue / targetPerPod)`

**When to use `External`:**
- One shared resource (Kafka topic, Redis queue) is consumed by all pods
- The metric represents total capacity needed, not per-pod capacity
- Example: Kafka lag of 50,000 messages with 1,000 messages/pod/sec target = 50 pods

```yaml
# External metric example for SQS queue depth
- type: External
  external:
    metric:
      name: sqs_queue_depth
      selector:
        matchLabels:
          queue_name: order-processing
    target:
      type: AverageValue
      # Each pod can process 100 messages; scale to keep queue < 100 * replicas
      averageValue: "100"
```

### 6.3 Metrics to Avoid

**High-cardinality metrics**: Metrics with per-request labels (user ID, path, status code) will produce millions of time series. Use pre-aggregated metrics in Prometheus rules instead.

**Noisy metrics**: Metrics with high variance at steady state will cause constant small adjustments. Use longer rate windows (5m instead of 1m) or a higher tolerance.

**Correlated metrics**: Using both CPU and RPS when they are correlated means the HPA sees two signals for the same load. This can cause unexpected scaling interactions. Choose one primary signal.

**Slowly-converging metrics**: After scaling, some metrics (P99 latency, error rate) take 1-2 minutes to reflect the new state. Use longer stabilization windows to avoid premature scale-in.

## Section 7: Application-Side Metric Instrumentation

The autoscaler is only as good as the metrics your application exposes. Here is a Go implementation of the key metrics for HPA:

```go
// metrics/hpa_metrics.go
package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// httpRequestsTotal — the core RPS metric for HPA
	httpRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests processed",
		},
		[]string{"method", "status_class"},
		// NOTE: avoid high-cardinality labels like path/user_id
		// Use status_class ("2xx", "4xx", "5xx") instead of exact status code
	)

	// httpRequestDuration — for P99 latency-based HPA
	httpRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "http_request_duration_seconds",
			Help: "HTTP request duration in seconds",
			// Use explicit buckets aligned with your SLO
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1.0, 2.5, 5.0},
		},
		[]string{"method"},
	)

	// activeConnections — for connection-based HPA
	activeConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "active_connections",
		Help: "Current number of active HTTP connections",
	})

	// queueDepth — for queue-based HPA
	queueDepth = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "worker_queue_depth",
			Help: "Number of items currently in the processing queue",
		},
		[]string{"queue_name"},
	)

	// processingLag — for lag-based HPA
	processingLag = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "processing_lag_seconds",
			Help: "How far behind the processor is from real-time",
		},
		[]string{"topic"},
	)
)

// InstrumentedHandler wraps an HTTP handler with HPA-relevant metrics.
func InstrumentedHandler(handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		activeConnections.Inc()
		defer activeConnections.Dec()

		// Wrap response writer to capture status code
		wrapped := &statusResponseWriter{ResponseWriter: w, status: http.StatusOK}
		handler.ServeHTTP(wrapped, r)

		duration := time.Since(start)
		statusClass := statusClass(wrapped.status)

		httpRequestsTotal.WithLabelValues(r.Method, statusClass).Inc()
		httpRequestDuration.WithLabelValues(r.Method).Observe(duration.Seconds())
	})
}

func statusClass(code int) string {
	switch {
	case code < 300:
		return "2xx"
	case code < 400:
		return "3xx"
	case code < 500:
		return "4xx"
	default:
		return "5xx"
	}
}

type statusResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusResponseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

// MetricsHandler returns the Prometheus metrics HTTP handler.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

// UpdateQueueDepth updates the queue depth metric for HPA.
// Call this from your queue consumer goroutine.
func UpdateQueueDepth(queueName string, depth float64) {
	queueDepth.WithLabelValues(queueName).Set(depth)
}

// UpdateProcessingLag updates the processing lag metric.
func UpdateProcessingLag(topic string, lagSeconds float64) {
	processingLag.WithLabelValues(topic).Set(lagSeconds)
}
```

## Section 8: Multi-Metric HPA — Priority and Conflict Resolution

When an HPA has multiple metrics, it uses the metric that requires the most replicas at any given time.

```yaml
# hpa-multi-metric.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: multi-signal-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  minReplicas: 3
  maxReplicas: 50
  metrics:
  # Signal 1: CPU — baseline capacity signal
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 65
  # Signal 2: RPS — traffic volume signal
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
  # Signal 3: Queue depth — batch processing signal
  - type: External
    external:
      metric:
        name: kafka_consumer_group_lag
        selector:
          matchLabels:
            consumer_group: order-processor
      target:
        type: AverageValue
        averageValue: "5000"
  # HPA will always use the signal requiring the MOST replicas
  # This ensures no single bottleneck goes unaddressed
```

### Debugging Multi-Metric Decisions

```bash
# See exactly what each metric is reporting
kubectl describe hpa multi-signal-hpa -n production

# Output example:
# Metrics: ( current / target )
#   resource cpu on pods  (as a percentage of request):  45% (450m) / 65%
#   "http_requests_per_second" on pods:                  145m / 100m
#   "kafka_consumer_group_lag" (target average value):   8000 / 5000
#
# Min replicas: 3, Max replicas: 50
# Current replicas: 12
#
# Desired replicas based on each metric:
#   cpu:              8 (ceil(12 × 45/65))
#   http_rps:         18 (ceil(12 × 145/100))  ← WINNER (requires most replicas)
#   kafka_lag:        20 (ceil(12 × 8000/5000)) ← Also requires more
#
# Current replicas: 12 → Desired: 20 (scaling up)
```

## Section 9: Vertical Pod Autoscaler Interaction

VPA and HPA should not scale the same resource (CPU or memory). Use CPU-based HPA with VPA targeting memory, or use custom metric HPA with VPA targeting both CPU and memory.

```yaml
# vpa-for-memory-hpa-for-traffic.yaml
# VPA manages memory allocation
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: api
      # VPA controls memory only; HPA controls CPU via custom metrics
      controlledResources: ["memory"]
      minAllowed:
        memory: 256Mi
      maxAllowed:
        memory: 4Gi
---
# HPA controls replica count based on RPS (not CPU, which VPA manages)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 30
  metrics:
  # RPS-based scaling — no CPU metric since VPA manages CPU requests
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
```

## Section 10: Operational Runbook

### HPA Debugging Checklist

```bash
#!/bin/bash
# hpa-debug.sh — Diagnose HPA issues
# Usage: ./hpa-debug.sh <hpa-name> <namespace>

HPA_NAME=$1
NAMESPACE=$2

echo "=== HPA Status ==="
kubectl describe hpa "$HPA_NAME" -n "$NAMESPACE"

echo ""
echo "=== Metrics API Response ==="
# Check if custom metrics API is responding
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1 \
  | jq '.resources[] | .name' 2>/dev/null || echo "Custom metrics API not responding"

echo ""
echo "=== Recent Scaling Events ==="
kubectl get events -n "$NAMESPACE" \
  --field-selector reason=SuccessfulRescale \
  --sort-by='.lastTimestamp' | tail -10

echo ""
echo "=== Prometheus Adapter Logs ==="
kubectl logs -n monitoring \
  -l app=prometheus-adapter \
  --tail=50 \
  | grep -E "ERROR|WARN|metric|query"

echo ""
echo "=== Current Pod Resource Usage ==="
kubectl top pods -n "$NAMESPACE" -l "$(kubectl get hpa $HPA_NAME -n $NAMESPACE -o jsonpath='{.spec.scaleTargetRef.name}')"
```

### Alert: HPA Stuck at Max Replicas

```yaml
# prometheus-rules-hpa.yaml
groups:
- name: hpa-alerts
  rules:
  - alert: HPAAtMaxReplicas
    expr: |
      kube_horizontalpodautoscaler_status_current_replicas
        ==
      kube_horizontalpodautoscaler_spec_max_replicas
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} is at max replicas"
      description: "HPA has been at max replicas for 10 minutes. Consider raising maxReplicas or investigating the bottleneck."

  - alert: HPAMetricNotAvailable
    expr: |
      kube_horizontalpodautoscaler_status_condition{condition="ScalingActive", status="false"} == 1
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} cannot get metrics"
      description: "Check Prometheus Adapter logs and metric availability."
```

## Summary

Custom metric autoscaling requires three things to work well in production:

1. **The right metric**: Leading indicators (queue depth, connection count) react before users are impacted. Lagging indicators (CPU, latency) confirm a problem but react too slowly for proactive scaling.
2. **Correct stabilization windows**: Scale up aggressively (0-60s stabilization), scale down conservatively (5-10 minute stabilization). Asymmetric windows prevent oscillation while maintaining responsiveness.
3. **Properly instrumented applications**: The HPA is only as smart as the metrics it receives. Instrument your application with counters (requests, queue items), gauges (active connections, queue depth), and histograms (latency) at application start.

For most production services, the effective strategy combines CPU-based scaling as a baseline, custom metrics (RPS or queue depth) as the primary driver, and a generous scale-down stabilization window to absorb normal traffic variance without continuous pod churn.
