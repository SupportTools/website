---
title: "Kubernetes Horizontal Pod Autoscaler v2: Custom Metrics, External Metrics, and KEDA Integration"
date: 2028-07-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "KEDA", "Autoscaling", "Custom Metrics", "Prometheus"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes HPA v2 covering custom and external metrics with the Prometheus adapter, scaling behavior configuration, KEDA integration for event-driven autoscaling, and scale-to-zero patterns."
more_link: "yes"
url: "/kubernetes-hpa-v2-custom-metrics-keda-guide/"
---

The built-in CPU and memory metrics provided by the Kubernetes Horizontal Pod Autoscaler are rarely the right signals for production workloads. A queue worker should scale on queue depth, not CPU. An HTTP API should scale on request rate or latency, not memory usage. A batch processor should scale on the number of pending items, not on resource consumption. The HPA v2 API — combined with the Prometheus adapter or KEDA — makes all of these patterns possible.

This guide covers the complete HPA v2 story: the metrics API architecture, configuring the Prometheus adapter, defining custom and external metrics, scaling behavior configuration to prevent flapping, and KEDA for event-driven scale-to-zero patterns.

<!--more-->

# Kubernetes HPA v2: Custom Metrics and KEDA Integration

## The Metrics API Architecture

Kubernetes exposes three metrics APIs:

1. **metrics.k8s.io**: Core resource metrics (CPU, memory). Provided by metrics-server.
2. **custom.metrics.k8s.io**: Per-object metrics (pod, service, etc.). Provided by an adapter like the Prometheus adapter.
3. **external.metrics.k8s.io**: External system metrics (queue depth, RPS from a load balancer). Also provided by adapters.

The HPA controller queries these APIs every 15 seconds (default) and adjusts replica counts based on the desired metric values.

## Section 1: HPA v2 Fundamentals

### CPU and Memory Scaling (Baseline)

```yaml
# apps/api-service/hpa.yaml
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
  maxReplicas: 50

  metrics:
  # CPU target: scale to keep average CPU utilization at 70%.
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  # Memory target: scale to keep average memory usage at 80%.
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80

  # Scaling behavior configuration.
  behavior:
    scaleUp:
      # Allow rapid scale-up (one decision per 30 seconds).
      stabilizationWindowSeconds: 30
      policies:
      # Allow doubling the replicas per minute.
      - type: Percent
        value: 100
        periodSeconds: 60
      # Or adding up to 5 replicas per 30 seconds.
      - type: Pods
        value: 5
        periodSeconds: 30
      # Use the most aggressive policy (maximum scaling).
      selectPolicy: Max

    scaleDown:
      # Wait 5 minutes before scaling down (prevents flapping).
      stabilizationWindowSeconds: 300
      policies:
      # Remove at most 10% of replicas per minute.
      - type: Percent
        value: 10
        periodSeconds: 60
      # Or remove at most 2 pods per 5 minutes.
      - type: Pods
        value: 2
        periodSeconds: 300
      # Use the most conservative policy (minimum scaling).
      selectPolicy: Min
```

## Section 2: Prometheus Adapter for Custom Metrics

The Prometheus adapter bridges the gap between Prometheus metrics and the Kubernetes custom metrics API.

### Installing the Prometheus Adapter

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://kube-prometheus-stack-prometheus.monitoring.svc \
  --set prometheus.port=9090 \
  -f prometheus-adapter-values.yaml
```

### Prometheus Adapter Configuration

```yaml
# prometheus-adapter-values.yaml
rules:
  default: false
  custom:
  # Rule 1: HTTP requests per second per pod.
  # Metric name in Prometheus: http_requests_total
  # Exposed as: pods/http_requests_per_second
  - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace:
          resource: namespace
        pod:
          resource: pod
    name:
      matches: "^(.*)_total$"
      as: "${1}_per_second"
    metricsQuery: |
      sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)

  # Rule 2: HTTP P99 latency per pod.
  - seriesQuery: 'http_request_duration_seconds_bucket{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace: {resource: namespace}
        pod: {resource: pod}
    name:
      matches: "http_request_duration_seconds_bucket"
      as: "http_p99_latency_seconds"
    metricsQuery: |
      histogram_quantile(0.99, sum(rate(
        http_request_duration_seconds_bucket{<<.LabelMatchers>>}[2m]
      )) by (le, <<.GroupBy>>))

  external:
  # External metric: SQS queue depth.
  # This is used for scaling queue workers.
  - seriesQuery: 'aws_sqs_approximate_number_of_messages_visible_sum{queue_name!=""}'
    resources:
      namespaced: false
    name:
      matches: "aws_sqs_approximate_number_of_messages_visible_sum"
      as: "sqs_queue_depth"
    metricsQuery: |
      sum(aws_sqs_approximate_number_of_messages_visible_sum{<<.LabelMatchers>>})
```

### Verifying the Adapter

```bash
# Check that the adapter is serving metrics.
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1 | jq .

# Check available metrics for a specific namespace.
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" \
  | jq .

# Check external metrics.
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1 | jq .
```

## Section 3: HPA with Custom Metrics

### Scaling on Request Rate

```yaml
# apps/api-service/hpa-custom.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service-rps-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 100

  metrics:
  # Scale based on HTTP requests per second per pod.
  # Target: each pod handles no more than 500 RPS.
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "500"

  # Also keep CPU below 80% as a safety fallback.
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 80

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 50
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 120
```

### Scaling on Latency

```yaml
# Scale up when P99 latency exceeds 500ms.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service-latency-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 50

  metrics:
  - type: Pods
    pods:
      metric:
        name: http_p99_latency_seconds
      target:
        type: AverageValue
        # Target: P99 latency < 500ms.
        averageValue: "0.5"

  behavior:
    scaleUp:
      # React quickly to latency spikes.
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
    scaleDown:
      stabilizationWindowSeconds: 600
```

## Section 4: External Metrics for Queue-Based Scaling

### SQS Queue Worker HPA

```yaml
# apps/order-processor/hpa-sqs.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-processor-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor
  minReplicas: 1
  maxReplicas: 50

  metrics:
  # Scale based on SQS queue depth.
  # Target: each worker processes a queue of no more than 10 messages.
  - type: External
    external:
      metric:
        name: sqs_queue_depth
        selector:
          matchLabels:
            queue_name: orders-queue
      target:
        type: AverageValue
        averageValue: "10"

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Pods
        value: 5
        periodSeconds: 30
    scaleDown:
      # Wait 5 minutes before scaling down queue workers.
      stabilizationWindowSeconds: 300
```

## Section 5: KEDA — Kubernetes Event-Driven Autoscaling

KEDA (Kubernetes Event-Driven Autoscaling) extends HPA with event-driven scaling triggers and scale-to-zero support. It is the right tool when you need:

- Scale to zero replicas when there are no events
- Native integrations with dozens of event sources (Kafka, RabbitMQ, Redis, Azure Service Bus, etc.)
- Complex scaling logic without writing a custom adapter

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.13.0
```

### ScaledObject for SQS

```yaml
# apps/order-processor/scaledobject-sqs.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: order-processor
    kind: Deployment

  # Scale to zero when there are no messages.
  minReplicaCount: 0
  maxReplicaCount: 50

  # How often KEDA polls the trigger.
  pollingInterval: 15

  # Wait 60 seconds after the last message before scaling to zero.
  cooldownPeriod: 60

  # Preserve the idle replica count for initial scale-up.
  idleReplicaCount: 0

  # Advanced scaling behavior (same format as HPA v2).
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
      name: aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/orders-queue
      queueLength: "10"
      awsRegion: us-east-1
      identityOwner: operator  # Use pod IRSA credentials.
```

### TriggerAuthentication for AWS

```yaml
# apps/order-processor/trigger-auth.yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-credentials
  namespace: production
spec:
  podIdentity:
    # Use AWS IAM Roles for Service Accounts (IRSA).
    provider: aws
```

### ScaledObject for Prometheus

```yaml
# apps/api-service/scaledobject-prometheus.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-service-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-service

  minReplicaCount: 2
  maxReplicaCount: 100
  pollingInterval: 15
  cooldownPeriod: 120

  triggers:
  # Scale on Prometheus query result.
  - type: prometheus
    metadata:
      serverAddress: http://kube-prometheus-stack-prometheus.monitoring.svc:9090
      metricName: api_rps
      # Target: scale when avg RPS per replica exceeds 500.
      query: |
        sum(rate(http_requests_total{namespace="production",deployment="api-service"}[2m]))
          / on() kube_deployment_status_replicas_ready{namespace="production",deployment="api-service"}
      threshold: "500"
      activationThreshold: "10"  # Minimum RPS before KEDA activates scaling.
```

### ScaledObject for Kafka

```yaml
# apps/event-processor/scaledobject-kafka.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: event-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: event-processor

  # Scale to zero when no messages are pending.
  minReplicaCount: 0
  maxReplicaCount: 30
  pollingInterval: 10
  cooldownPeriod: 300

  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-broker.kafka.svc:9092
      consumerGroup: event-processor-group
      topic: events
      # Scale based on consumer group lag.
      lagThreshold: "100"
      # Offset reset policy for initial activation.
      offsetResetPolicy: latest
      # Use SASL authentication.
      sasl: plaintext
      tls: enable
    authenticationRef:
      name: kafka-credentials
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-credentials
  namespace: production
spec:
  secretTargetRef:
  - parameter: username
    name: kafka-credentials
    key: username
  - parameter: password
    name: kafka-credentials
    key: password
```

### ScaledObject for Redis Lists

```yaml
# apps/worker/scaledobject-redis.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: redis-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: redis-worker

  minReplicaCount: 0
  maxReplicaCount: 20
  pollingInterval: 5
  cooldownPeriod: 60

  triggers:
  - type: redis
    metadata:
      address: redis-master.production.svc:6379
      listName: work-queue
      # Scale up when list length exceeds 5 items per worker.
      listLength: "5"
      enableTLS: "true"
    authenticationRef:
      name: redis-credentials
```

## Section 6: ScaledJob for Batch Workloads

For batch workloads, KEDA's ScaledJob is more appropriate than ScaledObject. It creates a new Job per trigger event rather than scaling a Deployment:

```yaml
# apps/batch-processor/scaledjob.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: batch-processor
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    template:
      spec:
        containers:
        - name: processor
          image: batch-processor:v1.0
          env:
          - name: SQS_QUEUE_URL
            value: https://sqs.us-east-1.amazonaws.com/123456789012/batch-queue
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
        restartPolicy: Never

  # Maximum number of concurrent jobs.
  maxReplicaCount: 20

  # Scaling strategy for jobs.
  scalingStrategy:
    strategy: default  # or "accurate", "eager"
    pendingJobsQueue: "exact"  # or "accurate"

  pollingInterval: 10
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 5

  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/batch-queue
      queueLength: "1"  # One job per message.
      awsRegion: us-east-1
      identityOwner: operator
```

## Section 7: Multi-Dimensional Scaling

Combining multiple metrics provides more robust autoscaling:

```yaml
# A comprehensive HPA that scales on multiple signals simultaneously.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service-multidim-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 100

  metrics:
  # Primary: RPS per pod.
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "500"

  # Secondary: CPU (prevents over-provisioning).
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  # Tertiary: Memory (for memory-intensive workloads).
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 75

  # The HPA uses the MAXIMUM desired replica count across all metrics.
  # This is the correct behavior: scale up if ANY metric says to scale up.
```

## Section 8: Observability for HPA

### Prometheus Metrics

```promql
# Current replica count vs desired.
kube_horizontalpodautoscaler_status_current_replicas
kube_horizontalpodautoscaler_status_desired_replicas

# HPA min/max bounds.
kube_horizontalpodautoscaler_spec_min_replicas
kube_horizontalpodautoscaler_spec_max_replicas

# Detect when HPA is at maximum (can't scale further).
(
  kube_horizontalpodautoscaler_status_current_replicas
    == on(namespace, horizontalpodautoscaler)
  kube_horizontalpodautoscaler_spec_max_replicas
) > 0

# HPA scaling activity.
increase(kube_horizontalpodautoscaler_status_current_replicas[1h])
```

### Alerting Rules

```yaml
# monitoring/hpa-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hpa-scaling-alerts
  namespace: monitoring
spec:
  groups:
  - name: hpa
    rules:
    - alert: HPAAtMaxReplicas
      expr: |
        kube_horizontalpodautoscaler_status_current_replicas
          == on(namespace, horizontalpodautoscaler)
        kube_horizontalpodautoscaler_spec_max_replicas
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "HPA has reached maximum replicas"
        description: >
          HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }}
          has been at maximum replicas for 5 minutes.
          Consider increasing maxReplicas.

    - alert: HPAUnableToScale
      expr: |
        kube_horizontalpodautoscaler_status_condition{
          condition="AbleToScale",
          status="false"
        } == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "HPA unable to scale"
        description: >
          HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }}
          is unable to scale.

    - alert: HPAMetricUnavailable
      expr: |
        kube_horizontalpodautoscaler_status_condition{
          condition="ScalingActive",
          status="false"
        } == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "HPA metrics unavailable"
        description: >
          HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }}
          cannot retrieve metrics. Check the custom metrics adapter.
```

## Section 9: Debugging Scaling Issues

```bash
# Check HPA status and events.
kubectl describe hpa api-service-rps-hpa -n production

# Example output showing metrics:
# Metrics:                                               ( current / target )
#   "http_requests_per_second" on pods/api-service:     450m / 500
#   resource cpu on pods (as a percentage of request):  62% (620m) / 80%
# Min replicas:   3
# Max replicas:   100
# Deployment pods: 5 current / 5 desired

# Check the custom metrics API directly.
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" \
  | jq '.items[] | {name: .describedObject.name, value: .value}'

# Check if metrics-server is healthy.
kubectl top pods -n production
kubectl top nodes

# Check KEDA scaler status.
kubectl describe scaledobject order-processor-scaler -n production
kubectl get scaledobject -n production

# Check KEDA operator logs.
kubectl -n keda logs deploy/keda-operator -f | grep -i error
kubectl -n keda logs deploy/keda-metrics-apiserver -f | grep -i error

# Check the KEDA-generated HPA.
# KEDA creates an HPA; you can inspect it directly.
kubectl get hpa -n production
kubectl describe hpa keda-hpa-order-processor-scaler -n production
```

### Common Issues and Fixes

**Metrics not appearing:**
```bash
# Check the Prometheus adapter is fetching the right series.
kubectl -n monitoring exec -ti deploy/prometheus-adapter -- \
  wget -q -O- \
  'http://prometheus:9090/api/v1/query?query=http_requests_total{namespace="production"}' \
  | jq '.data.result | length'

# If empty, the metric doesn't exist in Prometheus.
# Check that the app is exposing it.
kubectl -n production exec deploy/api-service -- \
  curl -s localhost:9090/metrics | grep http_requests_total
```

**Scale-down not happening:**
```bash
# Check the stabilization window.
kubectl describe hpa api-service-rps-hpa -n production | grep -A 5 "stabilization"

# Scale-down won't happen if the metric is still above target.
# Force check by looking at current metric values.
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second"
```

## Section 10: Best Practices

**Metric Selection**
- Choose metrics that are direct indicators of capacity: queue depth, active requests, latency percentiles
- Avoid metrics that lag behind load, like CPU after a batch job has already finished
- For HTTP services, P99 latency is often a better scale signal than request rate
- Always include CPU as a fallback metric even when scaling on custom metrics

**Scaling Behavior**
- Scale up aggressively (stabilizationWindowSeconds: 0-60) to handle traffic spikes
- Scale down conservatively (stabilizationWindowSeconds: 300-600) to avoid removing capacity that will be needed again
- Use `selectPolicy: Max` for scale-up to react to the most urgent signal
- Use `selectPolicy: Min` for scale-down to be conservative

**KEDA**
- Use KEDA for event-driven workloads that need scale-to-zero
- Use KEDA's ScaledJob for batch workloads rather than scaling a Deployment
- Monitor KEDA operator and metrics-apiserver logs for authentication issues
- Test scale-to-zero in non-production environments before enabling in production

**Cluster Autoscaler Integration**
- The HPA and cluster autoscaler work together: HPA adds pods, cluster autoscaler adds nodes
- Set node group minimum sizes to prevent scale-to-zero when you need warm capacity
- Use PodDisruptionBudgets to prevent the cluster autoscaler from removing nodes with critical pods
- Configure scale-up priority to ensure spot/preemptible nodes are used first

## Conclusion

The HPA v2 API, combined with the Prometheus adapter and KEDA, provides a complete autoscaling solution for modern Kubernetes workloads. CPU-based scaling is the right default for compute-bound services. Custom metrics (RPS, latency) are the right choice for stateless HTTP services. External metrics and KEDA triggers are the right choice for queue-based and event-driven workloads that need scale-to-zero.

The most important principle is matching the scale signal to the actual resource constraint: scale queue workers on queue depth, scale API servers on request rate, scale batch processors on pending work items. When the scale signal is aligned with the actual bottleneck, autoscaling becomes a reliable, self-managing system rather than a source of operational surprises.
