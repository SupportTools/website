---
title: "Kubernetes KEDA: Event-Driven Autoscaling on Metrics from Kafka, Redis, and Custom Sources"
date: 2031-06-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "Kafka", "Redis", "Event-Driven", "HPA"]
categories:
- Kubernetes
- Autoscaling
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to KEDA (Kubernetes Event-Driven Autoscaling): ScaledObject and ScaledJob configuration for Kafka consumer groups, Redis lists and streams, Prometheus metrics, cron schedules, and multi-trigger scaling strategies."
more_link: "yes"
url: "/kubernetes-keda-event-driven-autoscaling-kafka-redis-custom-metrics/"
---

The Kubernetes Horizontal Pod Autoscaler is limited to CPU and memory metrics by default. Real-world scaling decisions are driven by business metrics: Kafka consumer lag, Redis queue depth, database connection pool utilization, or request queue length. KEDA (Kubernetes Event-Driven Autoscaling) extends the HPA with an ecosystem of 70+ scalers that connect any metric source to pod scaling decisions — including the ability to scale to zero when queues are empty and back up within seconds when messages arrive.

This guide covers KEDA installation, ScaledObject and ScaledJob design patterns, Kafka consumer group lag scaling, Redis list and stream depth scaling, Prometheus-based custom metrics, cron-based predictive scaling, and the observability infrastructure needed to validate that scaling decisions are correct.

<!--more-->

# Kubernetes KEDA: Event-Driven Autoscaling on Metrics from Kafka, Redis, and Custom Sources

## Architecture

KEDA extends Kubernetes with three components:

```
┌─────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                      │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │                    KEDA Components                    │  │
│   │                                                       │  │
│   │   keda-operator         - Manages ScaledObjects      │  │
│   │   keda-metrics-server   - Exposes metrics to HPA     │  │
│   │   keda-admission-webhooks - Validates CRDs           │  │
│   └──────────────────────────────────────────────────────┘  │
│                            │                                 │
│           ┌────────────────▼───────────────┐                 │
│           │    Kubernetes HPA              │                 │
│           │  (driven by KEDA metrics)      │                 │
│           └────────────────┬───────────────┘                 │
│                            │                                 │
│                   ┌────────▼────────┐                        │
│                   │   Deployment /  │                        │
│                   │   StatefulSet   │                        │
│                   └─────────────────┘                        │
└──────────────────────────────┬──────────────────────────────┘
                               │ metrics queries
          ┌────────────────────┼────────────────────┐
          │                    │                    │
   ┌──────▼──────┐    ┌────────▼───────┐   ┌───────▼───────┐
   │    Kafka    │    │     Redis      │   │  Prometheus   │
   │  (consumer  │    │ (list depth)   │   │  (custom      │
   │    lag)     │    │                │   │   metrics)    │
   └─────────────┘    └────────────────┘   └───────────────┘
```

## Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.16.0 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=100Mi \
  --set resources.operator.limits.cpu=2 \
  --set resources.operator.limits.memory=1000Mi \
  --set resources.metricServer.requests.cpu=100m \
  --set resources.metricServer.requests.memory=100Mi \
  --set prometheus.operator.enabled=true \
  --set prometheus.metricServer.enabled=true \
  --wait

# Verify
kubectl get pods -n keda
kubectl get crds | grep keda
```

## Kafka Consumer Group Lag Scaling

The most common KEDA use case is scaling consumers based on Kafka consumer group lag.

### Kafka Authentication Setup

```yaml
# Store Kafka credentials in a secret
apiVersion: v1
kind: Secret
metadata:
  name: kafka-auth
  namespace: production
type: Opaque
stringData:
  sasl.username: <kafka-username>
  sasl.password: <kafka-password>
---
# TriggerAuthentication references the secret
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-auth
      key: sasl.username
    - parameter: password
      name: kafka-auth
      key: sasl.password
```

### ScaledObject for Kafka Consumer

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor

  # Scaling boundaries
  minReplicaCount: 2    # Never scale below 2 in production
  maxReplicaCount: 50   # Hard ceiling on pods

  # How often KEDA checks metrics
  pollingInterval: 15   # seconds

  # How long before scaling down (prevents flapping)
  cooldownPeriod: 60    # seconds

  # Fallback: if metrics unavailable, maintain this replica count
  fallback:
    failureThreshold: 3
    replicas: 5

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-0.kafka:9092,kafka-1.kafka:9092,kafka-2.kafka:9092
        consumerGroup: order-processor-group
        topic: orders.created
        lagThreshold: "100"        # Scale up when lag exceeds 100 messages per partition
        offsetResetPolicy: latest  # latest or earliest
        allowIdleConsumers: "false"
        scaleToZeroOnInvalidOffset: "false"

        # SASL authentication
        sasl: plaintext
        tls: enable
        authMode: saslPlain

      authenticationRef:
        name: kafka-auth
```

### Kafka Multi-Topic Scaling

For consumers processing multiple topics:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: event-aggregator
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: event-aggregator
  minReplicaCount: 1
  maxReplicaCount: 100
  pollingInterval: 10
  cooldownPeriod: 120

  # KEDA uses the maximum lag across all triggers for scaling decisions
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-bootstrap:9092
        consumerGroup: event-aggregator-group
        topic: events.clicks
        lagThreshold: "500"

    - type: kafka
      metadata:
        bootstrapServers: kafka-bootstrap:9092
        consumerGroup: event-aggregator-group
        topic: events.pageviews
        lagThreshold: "1000"

    - type: kafka
      metadata:
        bootstrapServers: kafka-bootstrap:9092
        consumerGroup: event-aggregator-group
        topic: events.purchases
        lagThreshold: "50"   # More sensitive for revenue-impacting events
```

### ScaledJob for Kafka Batch Processing

ScaledJob creates Kubernetes Jobs (not pods in a Deployment) — ideal for batch processing:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: invoice-generator
  namespace: production
spec:
  jobTargetRef:
    template:
      spec:
        restartPolicy: Never
        containers:
          - name: invoice-generator
            image: your-registry/invoice-generator:latest
            env:
              - name: KAFKA_BOOTSTRAP_SERVERS
                value: kafka-bootstrap:9092
              - name: CONSUMER_GROUP
                value: invoice-generator-group
              - name: TOPIC
                value: orders.confirmed
              - name: BATCH_SIZE
                value: "10"    # Process 10 messages per job
            resources:
              requests:
                cpu: "500m"
                memory: "256Mi"
              limits:
                cpu: "2"
                memory: "1Gi"

  # Scaling limits
  minReplicaCount: 0     # Scale to zero when queue is empty
  maxReplicaCount: 50
  pollingInterval: 10
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10

  # Job concurrency strategy
  scalingStrategy:
    strategy: "accurate"   # "default", "accurate", or "eager"
    # accurate: one job per lagThreshold messages (precise)
    # eager: immediately scale to max when lag detected (fastest)

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-bootstrap:9092
        consumerGroup: invoice-generator-group
        topic: orders.confirmed
        lagThreshold: "10"   # One job per 10 pending messages
```

## Redis Scaling

### Redis List (Queue Depth)

```yaml
# Store Redis credentials
apiVersion: v1
kind: Secret
metadata:
  name: redis-auth
  namespace: production
type: Opaque
stringData:
  password: <redis-password>
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: password
      name: redis-auth
      key: password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: email-sender
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: email-sender
  minReplicaCount: 0    # Scale to zero when no emails queued
  maxReplicaCount: 20
  pollingInterval: 5
  cooldownPeriod: 300   # 5 minutes before scaling down

  triggers:
    - type: redis
      metadata:
        address: redis-master.redis:6379
        listName: email:queue
        listLength: "50"    # One pod per 50 items in the list
        enableTLS: "true"
        databaseIndex: "0"
      authenticationRef:
        name: redis-auth
```

### Redis Streams (Consumer Group Lag)

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: notification-processor
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: notification-processor
  minReplicaCount: 1
  maxReplicaCount: 30
  pollingInterval: 10

  triggers:
    - type: redis-streams
      metadata:
        address: redis-master.redis:6379
        stream: notifications
        consumerGroup: notification-processor-group
        pendingEntriesCount: "100"   # Scale when >100 unacknowledged messages
        enableTLS: "true"
      authenticationRef:
        name: redis-auth
```

### Redis Cluster

```yaml
triggers:
  - type: redis-cluster
    metadata:
      addresses: >-
        redis-cluster-0.redis-cluster:6379,
        redis-cluster-1.redis-cluster:6379,
        redis-cluster-2.redis-cluster:6379
      listName: task:queue
      listLength: "100"
      enableTLS: "false"
    authenticationRef:
      name: redis-auth
```

## Prometheus Metrics Scaling

Scale on any metric exposed to Prometheus — application throughput, error rates, database pool utilization:

### Prometheus ScaledObject

```yaml
# Example: scale workers based on job queue depth exposed via Prometheus
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-fleet
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: worker
  minReplicaCount: 2
  maxReplicaCount: 100
  pollingInterval: 30
  cooldownPeriod: 180

  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: worker_queue_depth
        threshold: "50"     # One worker per 50 queued items
        query: |
          sum(worker_job_queue_depth{namespace="production"})
        queryParameters:
          time: ""  # Use current time

    # Also scale on high response latency (defensive scaling)
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: api_p99_latency
        threshold: "1"      # Scale when p99 > 1 (threshold in metric units)
        query: |
          histogram_quantile(0.99,
            rate(http_request_duration_seconds_bucket{
              namespace="production",
              job="api-service"
            }[2m])
          )
```

### Scaling on Database Connection Pool Utilization

```yaml
triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      metricName: db_pool_utilization
      threshold: "0.8"   # Scale when pool is >80% utilized
      query: |
        avg(
          pg_stat_activity_count{namespace="production"}
          /
          pgbouncer_max_client_conn{namespace="production"}
        )
```

### Authenticated Prometheus

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: prometheus-auth
  namespace: keda
type: Opaque
stringData:
  bearerToken: <prometheus-bearer-token>
---
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: prometheus-auth
spec:
  secretTargetRef:
    - parameter: bearerToken
      name: prometheus-auth
      key: bearerToken
---
triggers:
  - type: prometheus
    metadata:
      serverAddress: https://prometheus.example.com
      metricName: app_queue_depth
      threshold: "100"
      query: sum(app_job_queue_depth)
      authModes: "bearer"
    authenticationRef:
      name: prometheus-auth
      kind: ClusterTriggerAuthentication
```

## Cron-Based Predictive Scaling

Combine event-driven scaling with cron-based pre-warming for predictable traffic spikes:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-gateway
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  minReplicaCount: 5
  maxReplicaCount: 200
  pollingInterval: 15
  cooldownPeriod: 120

  triggers:
    # Event-driven: scale based on queue depth
    - type: prometheus
      metadata:
        serverAddress: http://prometheus:9090
        metricName: request_queue_depth
        threshold: "100"
        query: sum(http_requests_pending{job="api-gateway"})

    # Predictive: pre-warm for morning traffic (US Eastern)
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 7 * * 1-5"    # Mon-Fri 7AM EST
        end: "0 9 * * 1-5"      # Mon-Fri 9AM EST — return to event-driven
        desiredReplicas: "50"    # Pre-warm to 50 replicas

    # Predictive: scale for lunch peak
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 11 * * 1-5"   # Mon-Fri 11AM EST
        end: "0 14 * * 1-5"     # Mon-Fri 2PM EST
        desiredReplicas: "80"

    # Reduce to minimum at night
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 23 * * *"     # 11PM daily
        end: "0 6 * * 1-5"      # 6AM weekdays
        desiredReplicas: "5"
```

## Advanced Scaling Configuration

### ScalingModifiers (KEDA 2.10+)

ScalingModifiers allow mathematical transformations on metrics before scaling decisions:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ml-inference
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ml-inference-server

  advanced:
    scalingModifiers:
      formula: "kafka_lag / gpu_utilization * 1.2"
      target: "50"
      activationTarget: "10"
      metricType: AverageValue

  triggers:
    - type: kafka
      name: kafka_lag
      metadata:
        bootstrapServers: kafka:9092
        consumerGroup: ml-inference-group
        topic: inference.requests
        lagThreshold: "50"

    - type: prometheus
      name: gpu_utilization
      metadata:
        serverAddress: http://prometheus:9090
        metricName: gpu_utilization
        threshold: "50"
        query: |
          avg(DCGM_FI_DEV_GPU_UTIL{namespace="production"}) / 100
```

### Horizontal Pod Autoscaler Behavior Tuning

Control scaling rate and stability:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-workers
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-workers

  advanced:
    horizontalPodAutoscalerConfig:
      name: api-workers-hpa  # Optional: name the HPA explicitly
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0  # React immediately to increases
          policies:
            - type: Pods
              value: 10            # Add at most 10 pods per period
              periodSeconds: 60
            - type: Percent
              value: 50            # Or 50% of current, whichever is larger
              periodSeconds: 60
          selectPolicy: Max

        scaleDown:
          stabilizationWindowSeconds: 300   # Wait 5 minutes before scaling down
          policies:
            - type: Pods
              value: 2             # Remove at most 2 pods per period
              periodSeconds: 60
          selectPolicy: Min        # Choose the most conservative policy

  minReplicaCount: 3
  maxReplicaCount: 50
  pollingInterval: 15
```

## ClusterTriggerAuthentication for Multi-Namespace

When the same credentials are used across namespaces:

```yaml
# Create ClusterTriggerAuthentication in keda namespace
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: kafka-cluster-auth
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-credentials    # Secret in keda namespace
      key: username
    - parameter: password
      name: kafka-credentials
      key: password
---
# Reference in any namespace
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: consumer-team-alpha
  namespace: team-alpha        # Different namespace
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: consumer
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka:9092
        consumerGroup: team-alpha-group
        topic: team-alpha.events
        lagThreshold: "100"
      authenticationRef:
        name: kafka-cluster-auth
        kind: ClusterTriggerAuthentication  # Key: specify Kind
```

## Observability and Monitoring

### KEDA Prometheus Metrics

```yaml
# KEDA exposes metrics at keda-metrics-apiserver:9022
# Key metrics:
keda_scaler_active                    # 1 if scaler is active (scaling)
keda_scaler_metrics_value             # Current metric value from scaler
keda_scaler_metrics_latency_seconds   # Latency to fetch metrics
keda_scaled_object_errors_total       # Error count per ScaledObject
keda_scaled_job_errors_total          # Error count per ScaledJob
keda_resource_totals                  # Total resources managed by KEDA
```

### PrometheusRule for KEDA Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keda-alerts
  namespace: keda
  labels:
    release: prometheus-operator
spec:
  groups:
    - name: keda-scaling
      interval: 1m
      rules:
        # ScaledObject reporting errors
        - alert: KEDAScaledObjectError
          expr: keda_scaled_object_errors_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA ScaledObject {{ $labels.scaledObject }} has errors"

        # Consumer lag not reducing (scaling not keeping up)
        - alert: KafkaConsumerLagGrowing
          expr: |
            delta(keda_scaler_metrics_value{
              scalerType="kafka",
              metric="lagsum"
            }[10m]) > 1000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kafka consumer lag is growing for {{ $labels.scaledObject }}"

        # ScaledObject at maximum replicas
        - alert: KEDAAtMaxReplicas
          expr: |
            kube_deployment_spec_replicas ==
            kube_horizontalpodautoscaler_spec_max_replicas
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Deployment {{ $labels.deployment }} is at maxReplicaCount — consider increasing"

        # ScaledObject metric latency high
        - alert: KEDAMetricLatencyHigh
          expr: |
            histogram_quantile(0.99,
              rate(keda_scaler_metrics_latency_seconds_bucket[5m])
            ) > 5
          labels:
            severity: warning
          annotations:
            summary: "KEDA metric fetch latency is high for {{ $labels.scalerType }}"
```

### Grafana Dashboard Queries

```
# Current scaling activity
keda_scaler_active{namespace="production"}

# Kafka lag trend
keda_scaler_metrics_value{scalerType="kafka", namespace="production"}

# Scale target vs actual replicas
kube_deployment_spec_replicas{namespace="production"}
kube_deployment_status_replicas_available{namespace="production"}

# KEDA error rate
rate(keda_scaled_object_errors_total[5m])
```

## Scaling to Zero

KEDA's scale-to-zero is one of its most powerful features for cost optimization.

### Configuration for Scale-to-Zero

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: batch-processor
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: batch-processor

  minReplicaCount: 0    # Allow scale to zero
  maxReplicaCount: 20
  pollingInterval: 10

  # Cold start penalty
  # If activation takes > 30 seconds, increase pollingInterval
  # and ensure Kafka producer handles rebalance gracefully

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka:9092
        consumerGroup: batch-processor-group
        topic: batch.jobs
        lagThreshold: "1"             # Scale up for any single message
        activationLagThreshold: "0"   # Activate when lag >= 0 (any message)
```

### Handling Cold Start Latency

When scaling from zero, there is a window between message arrival and pod readiness:

```yaml
# In the consumer Deployment
spec:
  template:
    spec:
      containers:
        - name: processor
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 2
            failureThreshold: 3

      # Fast pod startup
      terminationGracePeriodSeconds: 60

# Kafka producer should handle consumer group rebalance:
# producer.config(max.block.ms=30000)  # Wait up to 30s for consumer to appear
```

## Troubleshooting Common Issues

```bash
# Check ScaledObject status
kubectl describe scaledobject order-processor -n production

# Check if HPA was created by KEDA
kubectl get hpa -n production
kubectl describe hpa keda-hpa-order-processor -n production

# Check KEDA operator logs
kubectl logs -n keda -l app=keda-operator --tail=100

# Check metrics server logs
kubectl logs -n keda -l app=keda-metrics-apiserver --tail=100

# Verify metrics are being fetched
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | python3 -m json.tool

# Check specific metric value
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/s0-kafka-orders-created" | \
  python3 -m json.tool

# Manually inspect Kafka consumer lag
kubectl exec -it kafka-0 -- \
  kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --describe \
    --group order-processor-group

# Check KEDA metrics directly
kubectl port-forward -n keda svc/keda-metrics-apiserver 9022 &
curl http://localhost:9022/metrics | grep keda_scaler_metrics_value
```

## Production Deployment Checklist

Before deploying KEDA in production:

1. **Test scale-to-zero behavior**: Verify cold start time and consumer group rebalance handling
2. **Set appropriate cooldownPeriod**: Too short causes flapping; too long wastes compute
3. **Configure fallback replicas**: Protect against metric source outages
4. **Set maxReplicaCount carefully**: Prevent runaway scaling from metric spikes
5. **Define PodDisruptionBudgets**: Prevent KEDA from scaling down too aggressively
6. **Monitor for scaling lag**: Alert when consumer lag grows despite maximum replicas
7. **Test failure scenarios**: What happens when Kafka/Redis is unreachable?
8. **Document scaling rationale**: Record why `lagThreshold=100` was chosen

KEDA transforms Kubernetes from a resource-based autoscaler into a business-logic-aware scaling system. The combination of Kafka lag scaling for real-time consumers, Redis queue depth for async workers, Prometheus for custom business metrics, and cron for predictive pre-warming covers the vast majority of production autoscaling requirements without writing custom controllers. The key operational discipline is monitoring not just whether pods are scaling, but whether the scaling is actually keeping pace with the metric that drives it.
