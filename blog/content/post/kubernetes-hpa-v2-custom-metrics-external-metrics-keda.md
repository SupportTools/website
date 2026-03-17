---
title: "Kubernetes Horizontal Pod Autoscaler v2: Custom Metrics and External Metrics Scaling"
date: 2030-09-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "Autoscaling", "Prometheus", "KEDA", "Custom Metrics", "DevOps"]
categories:
- Kubernetes
- Autoscaling
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise HPA guide covering metrics-server requirements, custom metrics API with Prometheus Adapter, external metrics from cloud providers, scaling behavior and stabilization windows, KEDA for event-driven scaling, and autoscaler testing."
more_link: "yes"
url: "/kubernetes-hpa-v2-custom-metrics-external-metrics-keda/"
---

The Kubernetes Horizontal Pod Autoscaler v2 API (stable since 1.23) enables scaling on CPU, memory, custom application metrics, and external metrics simultaneously. Teams that rely solely on CPU-based scaling often find their applications either under-provisioned during bursty traffic or over-provisioned during low-traffic periods when the metric that actually correlates with load is request rate, queue depth, or custom business logic. This post builds a complete autoscaling architecture from basic CPU scaling through Prometheus Adapter custom metrics, cloud provider external metrics, KEDA event-driven scaling, and the testing procedures needed to validate autoscaler behavior before it fires in production.

<!--more-->

## HPA Architecture and the Metrics Pipeline

Before configuring HPA, understanding the metrics flow prevents configuration mistakes:

```
Pod Metrics (CPU/Memory)
    │
    ▼
[Kubelet] ──→ [metrics-server] ──→ [metrics.k8s.io API] ──→ [HPA Controller]

Custom Metrics (application metrics)
    │
    ▼
[Prometheus] ──→ [Prometheus Adapter] ──→ [custom.metrics.k8s.io API] ──→ [HPA]

External Metrics (cloud services, queues)
    │
    ▼
[Cloud Provider / KEDA] ──→ [external.metrics.k8s.io API] ──→ [HPA]
```

The HPA controller polls these APIs at `--horizontal-pod-autoscaler-sync-period` (default 15s) and computes the desired replica count:

```
desiredReplicas = ceil[currentReplicas × (currentMetricValue / desiredMetricValue)]
```

## metrics-server: Prerequisite for CPU and Memory Scaling

### Installing metrics-server

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# For clusters without valid TLS certificates on kubelet:
kubectl patch deployment metrics-server -n kube-system \
  --type='json' \
  -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-insecure-tls"}]'

# Verify
kubectl top nodes
kubectl top pods -n default
```

### Verifying metrics-server Health

```bash
# Check metrics-server is responding
kubectl get apiservice v1beta1.metrics.k8s.io -o yaml

# Test the metrics API directly
kubectl get --raw /apis/metrics.k8s.io/v1beta1/nodes | jq '.items[].usage'
kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/production/pods | jq '.items[0].containers[0].usage'
```

## Basic HPA v2: CPU and Memory

```yaml
# basic-hpa.yaml
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
  maxReplicas: 50

  metrics:
    # CPU utilization target: scale when any pod exceeds 70% CPU request
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

    # Memory utilization target: scale when average exceeds 80%
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80

  # Scaling behavior controls
  behavior:
    scaleUp:
      # Allow fast scale-up: 100% more pods or 4 pods, whichever is larger
      stabilizationWindowSeconds: 0  # No cooldown for scale-up
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
        - type: Pods
          value: 4
          periodSeconds: 30
      selectPolicy: Max  # Use the policy that results in more pods

    scaleDown:
      # Conservative scale-down: hold 5 minutes before reducing replicas
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 25
          periodSeconds: 60
        - type: Pods
          value: 2
          periodSeconds: 60
      selectPolicy: Min  # Use the policy that results in fewer pods removed
```

### Understanding AverageUtilization vs AverageValue

- `AverageUtilization` is a percentage of the resource **request**. A pod with `requests.cpu: 500m` at `averageUtilization: 70` scales when CPU usage averages 350m (70% × 500m) across pods.
- `AverageValue` is an absolute metric value per pod. Use this when you cannot express the target as a percentage of request.

## Prometheus Adapter: Custom Metrics API

The Prometheus Adapter bridges Prometheus metrics into the Kubernetes `custom.metrics.k8s.io` API, allowing HPA to scale on any metric collected by Prometheus.

### Installing Prometheus Adapter

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  -n monitoring \
  --create-namespace \
  -f prometheus-adapter-values.yaml
```

### Prometheus Adapter Values

```yaml
# prometheus-adapter-values.yaml
prometheus:
  url: http://prometheus-operated.monitoring.svc.cluster.local
  port: 9090

# Custom metric rules
rules:
  default: false  # Disable auto-generated rules

  custom:
    # HTTP request rate per pod
    - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        matches: "^(.*)_total"
        as: "${1}_rate"
      metricsQuery: |
        sum by (<<.GroupBy>>) (
          rate(http_requests_total{<<.LabelMatchers>>}[2m])
        )

    # Active connections per pod
    - seriesQuery: 'active_connections{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        matches: "active_connections"
        as: "active_connections_per_pod"
      metricsQuery: |
        avg by (<<.GroupBy>>) (active_connections{<<.LabelMatchers>>})

    # Queue depth per deployment
    - seriesQuery: 'worker_queue_depth{namespace!="",deployment!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          deployment:
            resource: deployment
            group: apps
      name:
        matches: "worker_queue_depth"
        as: "queue_depth_per_worker"
      metricsQuery: |
        sum by (<<.GroupBy>>) (worker_queue_depth{<<.LabelMatchers>>})
          /
        count by (<<.GroupBy>>) (worker_queue_depth{<<.LabelMatchers>>})

  external:
    # SQS queue depth (via CloudWatch exporter)
    - seriesQuery: 'aws_sqs_approximate_number_of_messages_visible_average{namespace!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
      name:
        as: "sqs_messages_visible"
      metricsQuery: |
        avg(aws_sqs_approximate_number_of_messages_visible_average{<<.LabelMatchers>>})

replicas: 2

resources:
  requests:
    cpu: "50m"
    memory: "128Mi"
  limits:
    cpu: "200m"
    memory: "256Mi"
```

### Verifying Custom Metrics

```bash
# Verify the Prometheus Adapter API server is available
kubectl get apiservice v1beta1.custom.metrics.k8s.io -o yaml

# List available custom metrics for the production namespace
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq .

# Get the current value of a custom metric for pods in production
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_rate" \
  | jq '.items[] | {pod: .describedObject.name, value: .value}'

# Test a deployment-scoped metric
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/deployments.apps/api-server/queue_depth_per_worker" \
  | jq .
```

## HPA with Custom Metrics

### Scaling on Request Rate

```yaml
# request-rate-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-request-rate-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 2
  maxReplicas: 100

  metrics:
    # Scale based on requests per second per pod (target: 100 rps/pod)
    - type: Pods
      pods:
        metric:
          name: http_requests_rate
        target:
          type: AverageValue
          averageValue: "100"

    # Also keep CPU below 80%
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 50
          periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 20
          periodSeconds: 60
```

### Scaling on Queue Depth

For worker processes consuming from a message queue, scale based on items per worker:

```yaml
# queue-worker-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: queue-worker-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: queue-worker
  minReplicas: 1
  maxReplicas: 50

  metrics:
    # Target: 10 messages per worker pod
    - type: Object
      object:
        metric:
          name: queue_depth_per_worker
        describedObject:
          apiVersion: apps/v1
          kind: Deployment
          name: queue-worker
        target:
          type: Value
          value: "10"

  behavior:
    scaleUp:
      # Scale up aggressively when queue is growing
      stabilizationWindowSeconds: 0
      policies:
        - type: Pods
          value: 5
          periodSeconds: 15
    scaleDown:
      # Scale down conservatively to avoid thrashing
      stabilizationWindowSeconds: 600  # 10 minutes
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

## External Metrics: Cloud Provider Integration

External metrics allow scaling based on resources outside the cluster, such as AWS SQS queue depth, GCP Pub/Sub subscription backlog, or Azure Service Bus message count.

### External Metrics via Prometheus Adapter (AWS CloudWatch Exporter)

```yaml
# aws-sqs-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: sqs-worker-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-processor
  minReplicas: 1
  maxReplicas: 100

  metrics:
    - type: External
      external:
        metric:
          name: sqs_messages_visible
          selector:
            matchLabels:
              queue_name: "production-orders"
        target:
          type: AverageValue
          averageValue: "50"  # Scale to process 50 messages per pod
```

## KEDA: Kubernetes Event-Driven Autoscaling

KEDA extends HPA with support for 60+ event sources including Apache Kafka, RabbitMQ, AWS SQS, Azure Service Bus, Cron schedules, and HTTP traffic. KEDA adds a new resource `ScaledObject` that wraps HPA functionality with richer trigger definitions.

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  -n keda \
  --create-namespace \
  --set operator.replicaCount=2 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=128Mi
```

### KEDA ScaledObject: AWS SQS

```yaml
# keda-sqs-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: sqs-processor
  pollingInterval: 15   # Check every 15 seconds
  cooldownPeriod: 300   # Wait 5 minutes before scaling down to 0
  minReplicaCount: 0    # Scale to zero when queue is empty
  maxReplicaCount: 100
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Percent
              value: 25
              periodSeconds: 60
  triggers:
    - type: aws-sqs-queue
      authenticationRef:
        name: aws-sqs-auth
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/production-orders
        queueLength: "50"  # Target messages per pod
        awsRegion: us-east-1
        identityOwner: operator  # Use IRSA/pod identity
```

```yaml
# TriggerAuthentication for IRSA (IAM Roles for Service Accounts)
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-sqs-auth
  namespace: production
spec:
  podIdentity:
    provider: aws
    # Uses the pod's service account with IRSA annotation
```

### KEDA ScaledObject: Apache Kafka

```yaml
# keda-kafka-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: order-processor
  minReplicaCount: 1
  maxReplicaCount: 50
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: order-processors
        topic: orders
        lagThreshold: "100"  # Scale up when lag per partition exceeds 100
        offsetResetPolicy: earliest
      authenticationRef:
        name: kafka-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: sasl
      name: kafka-credentials
      key: sasl_mechanism
    - parameter: username
      name: kafka-credentials
      key: username
    - parameter: password
      name: kafka-credentials
      key: password
```

### KEDA ScaledObject: Prometheus-Based Scaling

KEDA's Prometheus trigger allows expressing complex scaling conditions as PromQL:

```yaml
# keda-prometheus-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-keda-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 200
  pollingInterval: 10
  triggers:
    # Scale on P99 latency exceeding 200ms
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: http_request_p99_latency
        threshold: "0.200"  # 200ms in seconds
        query: |
          histogram_quantile(0.99,
            sum by (le) (
              rate(http_request_duration_seconds_bucket{
                deployment="api-server",
                namespace="production"
              }[2m])
            )
          )

    # Scale on active connections
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: active_connections_total
        threshold: "1000"
        query: |
          sum(active_connections{
            namespace="production",
            deployment="api-server"
          })
```

### KEDA Cron-Based Scaling

Pre-scale before known traffic peaks:

```yaml
# keda-cron-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: business-hours-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
    # Business hours: scale to at least 10 replicas
    - type: cron
      metadata:
        timezone: America/New_York
        start: 0 8 * * 1-5    # 8 AM Mon-Fri
        end: 0 18 * * 1-5     # 6 PM Mon-Fri
        desiredReplicas: "10"

    # Scheduled maintenance window: scale to 2
    - type: cron
      metadata:
        timezone: UTC
        start: 0 2 * * 0      # 2 AM Sunday
        end: 0 4 * * 0        # 4 AM Sunday
        desiredReplicas: "2"
```

## Multi-Metric HPA with Priority

When multiple metrics are configured in HPA v2, the controller uses the metric that results in the **most** replicas (most conservative/protective scaling):

```yaml
# multi-metric-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-complete-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 150

  metrics:
    # CPU: scale up when average CPU > 70%
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

    # Memory: scale up when average memory > 80%
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80

    # Request rate: target 100 rps per pod
    - type: Pods
      pods:
        metric:
          name: http_requests_rate
        target:
          type: AverageValue
          averageValue: "100"

    # Active connections: scale to keep below 500 per pod
    - type: Pods
      pods:
        metric:
          name: active_connections_per_pod
        target:
          type: AverageValue
          averageValue: "500"
```

## Scaling Behavior Deep Dive

### Stabilization Windows

The stabilization window prevents thrashing by ignoring scale recommendations that would reduce replicas within the window duration:

```yaml
behavior:
  scaleDown:
    # Hold the MAXIMUM of the last 300 seconds of recommended replicas
    # before actually scaling down
    stabilizationWindowSeconds: 300
```

Example: If the desired replicas were 20 at T=0, then dropped to 5 at T=120, T=130, T=140...T=300, the HPA will not scale down until T=300 (5 minutes after it first recommended scaling down). This prevents scaling down during momentary traffic drops.

### Scaling Policies Interaction

```yaml
behavior:
  scaleUp:
    policies:
      # Policy 1: Allow 100% increase in pods per 30 seconds
      - type: Percent
        value: 100
        periodSeconds: 30
      # Policy 2: Allow adding up to 4 pods per 30 seconds
      - type: Pods
        value: 4
        periodSeconds: 30
    selectPolicy: Max  # Use whichever policy allows MORE pods

  scaleDown:
    policies:
      - type: Percent
        value: 25
        periodSeconds: 60
      - type: Pods
        value: 5
        periodSeconds: 60
    selectPolicy: Min  # Use whichever policy removes FEWER pods
```

With `selectPolicy: Max` for scale-up:
- Current pods: 4
- Policy 1 allows: 4 × 100% = 4 more = 8 total
- Policy 2 allows: 4 + 4 = 8 total
- Both agree: scale to 8

With `selectPolicy: Max` on an asymmetric scenario:
- Current pods: 3
- Policy 1 allows: 3 + 3 = 6 total
- Policy 2 allows: 3 + 4 = 7 total
- Max selected: scale to 7

## Testing HPA Behavior

### Load Testing with k6

```javascript
// load-test.js - k6 script for HPA validation
import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },    // Ramp up to 50 users
    { duration: '5m', target: 200 },   // Ramp up to 200 users (trigger scaling)
    { duration: '5m', target: 200 },   // Hold at 200 users
    { duration: '2m', target: 0 },     // Ramp down (trigger scale-down)
  ],
  thresholds: {
    http_req_duration: ['p(99)<500'],   // 99th percentile < 500ms
    http_req_failed: ['rate<0.01'],     // Error rate < 1%
  },
};

export default function () {
  const res = http.get('https://api.example.com/api/v1/health');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 200ms': (r) => r.timings.duration < 200,
  });
  sleep(0.1);
}
```

### HPA Validation Script

```bash
#!/bin/bash
# validate-hpa.sh

NAMESPACE="production"
DEPLOYMENT="api-server"
HPA_NAME="api-server-hpa"

echo "=== Initial HPA Status ==="
kubectl get hpa "$HPA_NAME" -n "$NAMESPACE" -o wide

echo ""
echo "=== Current Replica Count ==="
INITIAL_REPLICAS=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" \
  -o jsonpath='{.spec.replicas}')
echo "Initial replicas: $INITIAL_REPLICAS"

echo ""
echo "=== Watching HPA for 10 minutes ==="
kubectl get hpa "$HPA_NAME" -n "$NAMESPACE" --watch &
WATCH_PID=$!

sleep 600
kill $WATCH_PID 2>/dev/null

echo ""
echo "=== HPA Events ==="
kubectl describe hpa "$HPA_NAME" -n "$NAMESPACE" | \
  awk '/Events/,0' | head -30

echo ""
echo "=== Scaling History ==="
kubectl get events -n "$NAMESPACE" \
  --field-selector involvedObject.kind=HorizontalPodAutoscaler,involvedObject.name="$HPA_NAME" \
  --sort-by='.lastTimestamp'
```

### Simulating Load for HPA Testing

```bash
# Quick load test using kubectl run
kubectl run -n production load-test \
  --image=busybox:1.36 \
  --restart=Never \
  -- sh -c "
    while true; do
      wget -q -O /dev/null http://api-server.production.svc.cluster.local:8080/api/v1/load
      sleep 0.01
    done
  " &

# Monitor HPA in real time
watch -n 5 kubectl get hpa api-server-hpa -n production

# Monitor pod count
watch -n 5 "kubectl get pods -n production -l app=api-server | wc -l"

# Verify custom metrics are being populated
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_rate" \
  | jq '.items | map({pod: .describedObject.name, rps: .value})'
```

## Debugging HPA Issues

### HPA Not Scaling

```bash
# Check HPA conditions
kubectl describe hpa api-server-hpa -n production | grep -A20 "Conditions:"

# Common conditions:
# - AbleToScale: False → scale target issue
# - ScalingActive: False → metrics not available or all at 0
# - ScalingLimited: True → hit minReplicas or maxReplicas

# Check metrics availability
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq .

# Check Prometheus Adapter logs
kubectl logs -n monitoring -l app=prometheus-adapter --tail=50

# Verify the metric is in Prometheus
kubectl exec -n monitoring -c prometheus \
  $(kubectl get pod -n monitoring -l app=prometheus -o name | head -1) \
  -- wget -q -O - "http://localhost:9090/api/v1/query?query=http_requests_total" \
  | jq '.data.result | length'
```

### HPA Thrashing (Rapid Scale Up/Down)

```bash
# Check current scaling behavior
kubectl describe hpa api-server-hpa -n production | \
  grep -E "Scale.*recommendation|Stabilization"

# Check if stabilization window is too short
kubectl get hpa api-server-hpa -n production -o yaml | \
  yq '.spec.behavior.scaleDown.stabilizationWindowSeconds'

# Fix: Increase stabilization window
kubectl patch hpa api-server-hpa -n production \
  --type='merge' \
  -p '{"spec":{"behavior":{"scaleDown":{"stabilizationWindowSeconds":300}}}}'
```

### Prometheus Adapter Not Returning Metrics

```bash
# Check Adapter configuration for syntax errors
kubectl get configmap prometheus-adapter -n monitoring -o yaml

# Test the Prometheus query directly
PROM_URL="http://prometheus-operated.monitoring.svc.cluster.local:9090"
kubectl run query-test -n monitoring --rm -it \
  --image=curlimages/curl:8.7.1 \
  --restart=Never \
  -- curl -s "$PROM_URL/api/v1/query?query=sum+by+(pod,namespace)(rate(http_requests_total%5B2m%5D))" \
  | jq '.data.result | length'

# Verify label matching in adapter config
# The 'resources.overrides' must match actual Prometheus label names
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_rate" 2>&1
```

## Production HPA Checklist

```yaml
# Recommended production HPA template
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: production-service-hpa
  namespace: production
  annotations:
    description: "HPA for production API service"
    scaling-runbook: "https://wiki.example.com/runbooks/hpa-scaling"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-service

  # Always set explicit min/max — never rely on defaults
  minReplicas: 3     # High enough for HA during scale-down
  maxReplicas: 100   # Bounded to control cost

  metrics:
    # At minimum: CPU utilization to catch compute-bound spikes
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

  behavior:
    scaleUp:
      # Fast response to traffic spikes
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
        - type: Pods
          value: 4
          periodSeconds: 30
      selectPolicy: Max

    scaleDown:
      # Conservative scale-down to prevent premature pod termination
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 25
          periodSeconds: 60
        - type: Pods
          value: 2
          periodSeconds: 60
      selectPolicy: Min
```

## Summary

HPA v2 scaling strategy should be built in layers. Start with CPU utilization as the baseline signal — it works without additional infrastructure. Add custom metrics via Prometheus Adapter when CPU does not correlate with actual load (e.g., I/O-bound or async services). Use external metrics for scaling based on upstream queue depth so workers scale ahead of backlog growth rather than after memory pressure. KEDA provides the richest ecosystem of triggers and adds scale-to-zero capability missing from native HPA. In all cases, tune the stabilization windows to match the application's actual warmup time: too short causes thrashing, too long delays capacity reduction during off-peak periods. Validate autoscaler behavior under realistic load before relying on it in production — the load test should explicitly verify both the scale-up path (metrics above threshold → pods increase → metrics return to target) and the scale-down path (metrics below threshold for longer than stabilization window → pods decrease).
