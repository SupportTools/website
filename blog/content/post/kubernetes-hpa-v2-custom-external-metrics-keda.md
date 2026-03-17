---
title: "Kubernetes Horizontal Pod Autoscaler v2: Custom and External Metrics"
date: 2029-07-06T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "Autoscaling", "KEDA", "Custom Metrics", "Prometheus", "Scale-to-Zero"]
categories: ["Kubernetes", "Operations", "Autoscaling"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes HPA v2: the multiple metrics API, custom metrics from Prometheus, external metrics from AWS SQS and Kafka, KEDA as a metrics provider, scale-to-zero patterns, and tuning HPA behavior for production workloads."
more_link: "yes"
url: "/kubernetes-hpa-v2-custom-external-metrics-keda/"
---

The Kubernetes Horizontal Pod Autoscaler (HPA) v1 supported only CPU and memory. HPA v2, introduced in Kubernetes 1.23 and stable in 1.25, adds support for multiple simultaneous metrics, custom application-level metrics, and external metrics from sources outside the cluster. KEDA extends this further to enable scale-to-zero. This post covers the complete HPA v2 API with production-ready examples.

<!--more-->

# Kubernetes Horizontal Pod Autoscaler v2: Custom and External Metrics

## Why HPA v1 Was Insufficient

HPA v1 scaled based on CPU utilization alone. This was insufficient for:

- **Queue-based workers**: The relevant metric is queue depth, not CPU usage
- **Request-driven APIs**: Scaling should happen before CPU saturates, based on RPS or latency
- **Batch processors**: Should scale with the number of pending items
- **Memory-bound services**: CPU is stable while the service is about to OOM

HPA v2 addresses these by allowing any metric from any source to drive scaling decisions.

## Section 1: HPA v2 API Structure

### The autoscaling/v2 Schema

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server

  minReplicas: 2
  maxReplicas: 50

  # Multiple metrics evaluated simultaneously
  # HPA scales up to satisfy ALL metrics, scales down when ALL metrics allow
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
        type: AverageValue
        averageValue: "512Mi"

  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "1000"

  # Fine-tuned scaling behavior
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0  # no delay on scale up
      policies:
      - type: Pods
        value: 4          # add at most 4 pods per period
        periodSeconds: 60
      - type: Percent
        value: 100        # or double the current count
        periodSeconds: 60
      selectPolicy: Max   # use whichever allows faster scale-up

    scaleDown:
      stabilizationWindowSeconds: 300  # 5 min stabilization before scale down
      policies:
      - type: Pods
        value: 2          # remove at most 2 pods per period
        periodSeconds: 60
      selectPolicy: Min   # conservative scale-down
```

### Metric Types

| Type | Source | Description |
|------|--------|-------------|
| `Resource` | kubelet metrics | CPU and memory from resource requests/limits |
| `ContainerResource` | kubelet metrics | Per-container CPU/memory (not per-pod average) |
| `Pods` | custom.metrics.k8s.io | Metric averaged across all pods in the target |
| `Object` | custom.metrics.k8s.io | Metric from a single Kubernetes object |
| `External` | external.metrics.k8s.io | Metric from outside the cluster |

## Section 2: Custom Metrics API

The Custom Metrics API (`custom.metrics.k8s.io`) is an extension API server that translates Kubernetes metric queries into calls to a monitoring backend (typically Prometheus).

### Architecture

```
kubectl top / HPA controller
    |
    | GET custom.metrics.k8s.io/v1beta2
    v
Metrics API server (e.g., prometheus-adapter)
    |
    | PromQL query
    v
Prometheus
    |
    | scrapes metrics from
    v
Your application pods
```

### Deploying prometheus-adapter

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus-operated.monitoring.svc.cluster.local \
  --set prometheus.port=9090 \
  -f prometheus-adapter-values.yaml
```

### Configuring Custom Metrics Rules

```yaml
# prometheus-adapter-values.yaml
rules:
  custom:
  # HTTP requests per second per pod
  - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace: {resource: "namespace"}
        pod: {resource: "pod"}
    name:
      matches: "^(.*)_total$"
      as: "${1}_per_second"
    metricsQuery: |
      sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)

  # Active WebSocket connections per pod
  - seriesQuery: 'websocket_connections_active{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace: {resource: "namespace"}
        pod: {resource: "pod"}
    name:
      matches: "websocket_connections_active"
      as: "websocket_connections"
    metricsQuery: |
      sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)

  # Queue processing lag per pod
  - seriesQuery: 'job_queue_lag_seconds{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace: {resource: "namespace"}
        pod: {resource: "pod"}
    name:
      matches: "job_queue_lag_seconds"
      as: "queue_lag_seconds"
    metricsQuery: |
      avg(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)
```

### Application Exposing Custom Metrics

Your application must expose Prometheus metrics for the adapter to scrape:

```go
package metrics

import (
    "net/http"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    RequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total HTTP requests by method, path, and status code",
        },
        []string{"method", "path", "status_code"},
    )

    ActiveConnections = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "websocket_connections_active",
            Help: "Current number of active WebSocket connections",
        },
    )

    QueueLag = promauto.NewGauge(
        prometheus.GaugeOpts{
            Name: "job_queue_lag_seconds",
            Help: "Age in seconds of the oldest unprocessed job",
        },
    )
)

func ServeMetrics(addr string) {
    http.Handle("/metrics", promhttp.Handler())
    http.ListenAndServe(addr, nil)
}
```

```yaml
# PodMonitor to configure Prometheus scraping
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: api-server
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  podMetricsEndpoints:
  - port: metrics
    interval: 15s
    path: /metrics
```

### HPA Using Custom Metrics

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 100

  metrics:
  # Scale based on RPS: target 500 requests/sec per pod
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "500"

  # Also scale if websocket connections are high
  - type: Pods
    pods:
      metric:
        name: websocket_connections
      target:
        type: AverageValue
        averageValue: "200"
```

### Verifying Custom Metrics are Available

```bash
# Check that the custom metrics API is registered
kubectl api-versions | grep metrics

# List available custom metrics
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta2" | jq .

# Get the current value of a specific metric
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta2/namespaces/production/pods/*/http_requests_per_second" \
  | jq '.items[] | {name: .describedObject.name, value: .value}'

# Check HPA status including metric values
kubectl describe hpa api-server-hpa -n production
```

## Section 3: External Metrics API

External metrics represent values from outside the Kubernetes cluster: AWS SQS queue depth, Kafka consumer group lag, Redis queue length, etc.

### External Metrics Architecture

```
HPA controller
    |
    | GET external.metrics.k8s.io/v1beta1
    v
External Metrics Server (e.g., KEDA metrics adapter or custom adapter)
    |
    | API call
    v
External system (SQS, Kafka, Redis, Datadog, New Relic, etc.)
```

### Using prometheus-adapter for External Metrics

prometheus-adapter can also serve external metrics from any Prometheus query:

```yaml
# prometheus-adapter: external metrics rules
rules:
  external:
  # Kafka consumer group lag
  - seriesQuery: 'kafka_consumer_group_lag{topic!="",consumer_group!=""}'
    resources:
      namespaced: false
    name:
      matches: "kafka_consumer_group_lag"
      as: "kafka_consumer_lag"
    metricsQuery: |
      max(<<.Series>>{<<.LabelMatchers>>})

  # SQS queue depth (scraped by cloudwatch-exporter)
  - seriesQuery: 'aws_sqs_approximate_number_of_messages_visible_maximum{queue_name!=""}'
    resources:
      namespaced: false
    name:
      matches: "aws_sqs_approximate_number_of_messages_visible_maximum"
      as: "sqs_messages_visible"
    metricsQuery: |
      max(<<.Series>>{<<.LabelMatchers>>})
```

```yaml
# HPA using external metrics (SQS queue depth)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: sqs-worker-hpa
  namespace: workers
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-worker

  minReplicas: 1
  maxReplicas: 20

  metrics:
  - type: External
    external:
      metric:
        name: sqs_messages_visible
        selector:
          matchLabels:
            queue_name: "order-processing-queue"
      target:
        type: AverageValue
        averageValue: "10"  # target 10 messages per worker replica
```

## Section 4: KEDA — Kubernetes Event-Driven Autoscaling

KEDA is a CNCF graduated project that extends Kubernetes autoscaling with 60+ built-in scalers. It provides two components:

1. **KEDA Operator**: Watches `ScaledObject` and `ScaledJob` CRDs and manages HPA resources
2. **KEDA Metrics Adapter**: Serves `external.metrics.k8s.io` backed by the scalers

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set metricsServer.replicaCount=2  # HA for production
```

### KEDA ScaledObject Examples

#### Kafka Consumer Group Lag

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: workers
spec:
  scaleTargetRef:
    name: kafka-order-processor

  minReplicaCount: 1
  maxReplicaCount: 30
  pollingInterval: 15    # check metrics every 15 seconds
  cooldownPeriod: 300    # wait 5 min after last scale event before scaling down

  triggers:
  - type: kafka
    metadata:
      bootstrapServers: "kafka.kafka.svc.cluster.local:9092"
      consumerGroup: "order-processors"
      topic: "orders"
      lagThreshold: "100"   # scale when lag > 100 per replica
      activationLagThreshold: "10"  # activate (from 0) when lag > 10
      saslType: scram_sha512
    authenticationRef:
      name: kafka-auth

---
# Credentials stored in TriggerAuthentication
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-auth
  namespace: workers
spec:
  secretTargetRef:
  - parameter: username
    name: kafka-credentials
    key: username
  - parameter: password
    name: kafka-credentials
    key: password
```

#### AWS SQS Queue

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-worker-scaler
  namespace: workers
spec:
  scaleTargetRef:
    name: sqs-processor

  minReplicaCount: 0      # scale to zero when queue is empty
  maxReplicaCount: 50

  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: aws-keda-auth
    metadata:
      queueURL: "https://sqs.us-east-1.amazonaws.com/123456789012/order-processing"
      queueLength: "10"       # target 10 messages per replica
      awsRegion: "us-east-1"
      identityOwner: operator  # use KEDA operator's IAM role via IRSA

---
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: aws-keda-auth
spec:
  podIdentity:
    provider: aws
    # Uses IRSA (IAM Roles for Service Accounts) automatically
```

#### Redis List Length

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: redis-worker-scaler
  namespace: workers
spec:
  scaleTargetRef:
    name: redis-job-processor

  minReplicaCount: 0
  maxReplicaCount: 20

  triggers:
  - type: redis
    authenticationRef:
      name: redis-auth
    metadata:
      address: redis.redis.svc.cluster.local:6379
      listName: "job-queue"
      listLength: "50"        # 50 items per worker
      activationListLength: "1"
      databaseIndex: "0"
```

#### Prometheus Metric Trigger

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-keda-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server

  minReplicaCount: 2
  maxReplicaCount: 100

  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: http_requests_per_second
      query: |
        sum(rate(http_requests_total{namespace="production", deployment="api-server"}[2m]))
      threshold: "1000"     # scale when total RPS > 1000
      activationThreshold: "100"  # activate when > 100 RPS
```

#### HTTP Request Trigger (KEDA HTTP Add-on)

```bash
# Install KEDA HTTP Add-on
helm install http-add-on kedacore/keda-add-ons-http \
  --namespace keda
```

```yaml
# Scale based on incoming HTTP request count
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: api-server-http-scaler
  namespace: production
spec:
  host: api.myapp.com
  targetPendingRequests: 100   # scale when > 100 pending requests per replica

  scaledownPeriod: 300

  scaleTargetRef:
    name: api-server
    service: api-server-svc
    port: 8080

  replicas:
    min: 0
    max: 50
```

## Section 5: Scale-to-Zero Patterns

Scale-to-zero eliminates cost for workloads that have periodic or bursty traffic. The challenge is that the first request after scale-to-zero must wait for a pod to start (cold start latency).

### Minimizing Cold Start Latency

```yaml
# Pre-warm containers using KEDA's scaledObject initialDelay
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-worker
spec:
  scaleTargetRef:
    name: api-worker
  minReplicaCount: 0
  maxReplicaCount: 10

  # Aggressive scale-up when trigger fires
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
          - type: Percent
            value: 200   # double immediately on scale-up signal
            periodSeconds: 10
```

```yaml
# Minimize pod startup time
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-worker
spec:
  template:
    spec:
      # Pre-warm: keep one pod ready but at zero resource cost
      # This requires KEDA's pausedReplicas feature
      containers:
      - name: worker
        image: api-worker:latest
        startupProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 0  # check immediately
          periodSeconds: 1
          failureThreshold: 30    # allow 30 seconds for startup
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 5
        # Fast startup resources
        resources:
          requests:
            cpu: 100m      # enough for startup, HPA manages scale
            memory: 128Mi
          limits:
            cpu: 2
            memory: 1Gi
```

### Buffering Requests During Scale-Up (KEDA HTTP Add-on)

The KEDA HTTP Add-on includes a buffer that holds incoming requests while the target is scaling from zero:

```yaml
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: bursty-api
spec:
  host: api.myapp.com
  targetPendingRequests: 200

  # Requests are queued in the KEDA interceptor proxy during scale-up
  # Maximum queue time before returning 503
  scalingMetric:
    pendingRequestCount: 200

  replicas:
    min: 0
    max: 20
```

## Section 6: HPA Behavior Tuning

### Preventing Flapping

```yaml
# Conservative HPA that avoids rapid oscillation
spec:
  behavior:
    scaleUp:
      # Only scale up if metrics have been above threshold for 60 seconds
      stabilizationWindowSeconds: 60
      policies:
      - type: Pods
        value: 2
        periodSeconds: 60

    scaleDown:
      # Wait 10 minutes before scaling down (avoid rapid up/down cycling)
      stabilizationWindowSeconds: 600
      policies:
      - type: Pods
        value: 1           # remove only 1 pod per minute
        periodSeconds: 60
      selectPolicy: Min    # use the most conservative policy
```

### Preventing Scale-Down During Business Hours

Use KEDA's `ScaledObject` with time-based triggers:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: business-hours-scaler
spec:
  scaleTargetRef:
    name: customer-portal

  minReplicaCount: 0
  maxReplicaCount: 20

  triggers:
  # Standard metric trigger
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      metricName: rps
      query: sum(rate(http_requests_total[2m]))
      threshold: "100"

  # Cron trigger: maintain minimum during business hours
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 8 * * 1-5"   # 8 AM weekdays
      end:   "0 18 * * 1-5"  # 6 PM weekdays
      desiredReplicas: "5"    # minimum 5 replicas during business hours
```

## Section 7: Observability for HPA

### Checking HPA Status

```bash
# Detailed HPA status with metric values
kubectl describe hpa api-server-hpa -n production

# Example output:
# Name:                                                  api-server-hpa
# Namespace:                                             production
# Reference:                                             Deployment/api-server
# Metrics:                                               ( current / target )
#   "http_requests_per_second" on pods:                  423 / 500
#   resource cpu on pods  (as a percentage of request):  45% (90m) / 70%
# Min replicas:                                          3
# Max replicas:                                          100
# Deployment pods:                                       6 current / 6 desired
# Conditions:
#   Type            Status  Reason              Message
#   ----            ------  ------              -------
#   AbleToScale     True    ReadyForNewScale    recommended size matches current size
#   ScalingActive   True    ValidMetricFound    the HPA was able to successfully calculate a replica count
#   ScalingLimited  False   DesiredWithinRange  the desired count is within the acceptable range

# Watch HPA scaling events
kubectl get events --field-selector reason=SuccessfulRescale -n production -w
```

### Prometheus Metrics for HPA

```promql
# Current replica count vs desired
kube_horizontalpodautoscaler_status_current_replicas{namespace="production"}
kube_horizontalpodautoscaler_status_desired_replicas{namespace="production"}

# Is HPA at max replicas (potential bottleneck)?
kube_horizontalpodautoscaler_status_current_replicas{namespace="production"}
  == kube_horizontalpodautoscaler_spec_max_replicas{namespace="production"}

# Scale events rate
rate(kube_horizontalpodautoscaler_status_current_replicas[5m]) != 0
```

```yaml
# Alert: HPA at max replicas
- alert: HPAAtMaxReplicas
  expr: |
    kube_horizontalpodautoscaler_status_current_replicas
    == kube_horizontalpodautoscaler_spec_max_replicas
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} is at max replicas"
    description: "Consider increasing maxReplicas or the per-pod load target"

# Alert: HPA cannot scale due to metric unavailability
- alert: HPAMetricUnavailable
  expr: |
    kube_horizontalpodautoscaler_status_condition{
      condition="ScalingActive",
      status="false"
    } == 1
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} cannot scale"
```

## Section 8: Choosing Between HPA, VPA, and KEDA

| Concern | HPA v2 | VPA | KEDA |
|---------|--------|-----|------|
| Horizontal scaling | Yes | No | Yes (via HPA) |
| Vertical scaling | No | Yes | No |
| Custom metrics | Yes | No | Yes (richer) |
| External metrics | Yes | No | Yes (60+ scalers) |
| Scale to zero | No | No | Yes |
| Event-driven triggers | No | No | Yes |
| Kubernetes-native | Yes | Yes | Yes (CRD-based) |
| Maturity | GA | Beta | GA |

Use HPA v2 natively for resource-based and Prometheus-based scaling where you want to minimize dependencies. Use KEDA when you need scale-to-zero, event-driven triggers, or integration with message queues and cloud services. Combine VPA (in recommendation mode) with HPA for right-sizing CPU/memory requests.

## Conclusion

HPA v2 with custom and external metrics provides powerful autoscaling for production Kubernetes workloads. The key patterns:

1. **Custom metrics from Prometheus**: Use prometheus-adapter to expose application-level metrics (RPS, queue lag, active connections) to the HPA controller
2. **External metrics**: Use KEDA or a custom metrics adapter for AWS SQS, Kafka, and other external event sources
3. **Scale-to-zero**: KEDA's ScaledObject with `minReplicaCount: 0` eliminates idle costs for bursty workloads
4. **Behavior tuning**: Use `stabilizationWindowSeconds` and per-period limits to prevent flapping
5. **Cron triggers**: Maintain minimum replicas during business hours regardless of metric values

The most common mistake is setting `minReplicas` too low or `maxReplicas` too high without validating whether the application actually scales horizontally. Always load test your application before relying on HPA for traffic management.
