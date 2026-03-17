---
title: "Kubernetes HPA with Custom Metrics: Datadog, Dynatrace, and Prometheus Adapter"
date: 2029-03-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "Autoscaling", "Prometheus", "Datadog", "Observability"]
categories:
- Kubernetes
- Observability
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes HPA scaling on custom and external metrics from Datadog, Dynatrace, and Prometheus Adapter, covering metric server registration, lag-based queue scaling, and multi-metric policies."
more_link: "yes"
url: "/kubernetes-hpa-custom-metrics-datadog-dynatrace-prometheus-adapter/"
---

CPU and memory-based autoscaling is a poor fit for most real-world services. A queue consumer should scale on queue depth, not CPU. An API gateway should scale on request latency percentiles, not memory. A batch processor should scale on pending job count, not CPU utilization. Kubernetes HPA v2 supports custom metrics from any source that implements the `custom.metrics.k8s.io` or `external.metrics.k8s.io` API. This post covers three production implementations: Prometheus Adapter (open source), Datadog Cluster Agent (SaaS), and Dynatrace (enterprise APM), with complete configurations for lag-based queue scaling.

<!--more-->

## HPA v2 API Architecture

The HPA controller queries three distinct metric APIs:

| API Group | Source | Use Case |
|-----------|--------|----------|
| `metrics.k8s.io` | metrics-server | CPU, memory (built-in) |
| `custom.metrics.k8s.io` | Custom adapter | Per-object metrics (queue depth per pod, RPS per ingress) |
| `external.metrics.k8s.io` | External adapter | Global metrics not tied to a Kubernetes object |

### Checking Available Metric APIs

```bash
# Verify metric server and custom adapters are registered
kubectl api-versions | grep metrics

# List available custom metrics
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq '.resources[].name'

# List available external metrics
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | jq '.resources[].name'

# Query a specific custom metric directly
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" | jq .
```

## Prometheus Adapter

### Installation via Helm

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --create-namespace \
  --version 4.10.0 \
  -f prometheus-adapter-values.yaml
```

### prometheus-adapter-values.yaml

```yaml
# prometheus-adapter-values.yaml
prometheus:
  url: http://prometheus-operated.monitoring.svc.cluster.local
  port: 9090
  path: ""

replicas: 2

rules:
  default: false

  custom:
    # HTTP requests per second per pod (for RPS-based scaling)
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
        sum(rate(http_requests_total{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)

    # P99 latency per pod (for latency-based scaling)
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
        histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{<<.LabelMatchers>>}[5m])) by (le, <<.GroupBy>>))

    # Active database connections per pod
    - seriesQuery: 'db_connections_active{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        matches: "^db_connections_active$"
        as: "db_connections_active"
      metricsQuery: |
        sum(db_connections_active{<<.LabelMatchers>>}) by (<<.GroupBy>>)

  external:
    # SQS queue depth (requires kube-state-metrics or cloudwatch-exporter)
    - seriesQuery: 'aws_sqs_approximate_number_of_messages_visible{queue_name!=""}'
      resources:
        namespaced: false
      name:
        matches: "^aws_sqs_approximate_number_of_messages_visible$"
        as: "sqs_queue_depth"
      metricsQuery: |
        sum(aws_sqs_approximate_number_of_messages_visible{<<.LabelMatchers>>})

    # Kafka consumer group lag
    - seriesQuery: 'kafka_consumer_group_lag{namespace!="",consumer_group!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
      name:
        matches: "^kafka_consumer_group_lag$"
        as: "kafka_consumer_lag"
      metricsQuery: |
        sum(kafka_consumer_group_lag{<<.LabelMatchers>>}) by (namespace)

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

### HPA Using Prometheus Custom Metrics

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
  maxReplicas: 50

  metrics:
    # Primary: scale on RPS
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"

    # Secondary: scale on P99 latency (avoid scaling down if latency is high)
    - type: Pods
      pods:
        metric:
          name: http_request_duration_p99
        target:
          type: AverageValue
          averageValue: "250m"  # 250ms in fractional seconds

    # Tertiary: CPU as a floor
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 100
          periodSeconds: 60
        - type: Pods
          value: 10
          periodSeconds: 60
      selectPolicy: Max

    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 25
          periodSeconds: 60
      selectPolicy: Min
```

### HPA for Kafka Consumer with Lag-Based Scaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-consumer-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-consumer
  minReplicas: 2
  maxReplicas: 20

  metrics:
    - type: External
      external:
        metric:
          name: kafka_consumer_lag
          selector:
            matchLabels:
              consumer_group: payment-processor
              topic: payments.created
        target:
          type: AverageValue
          averageValue: "1000"  # Scale to keep avg lag per replica below 1000 messages

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Pods
          value: 4
          periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 600   # 10-minute cooldown before scale-down
      policies:
        - type: Pods
          value: 2
          periodSeconds: 120
```

## Datadog Cluster Agent

The Datadog Cluster Agent implements both `custom.metrics.k8s.io` and `external.metrics.k8s.io`, exposing any Datadog metric to the HPA controller.

### Enabling External Metrics in Datadog Cluster Agent

```yaml
# datadog-values.yaml (Helm values for the Datadog Agent)
clusterAgent:
  enabled: true
  replicas: 2

  env:
    - name: DD_EXTERNAL_METRICS_PROVIDER_ENABLED
      value: "true"
    - name: DD_EXTERNAL_METRICS_PROVIDER_PORT
      value: "8443"
    - name: DD_APP_KEY
      valueFrom:
        secretKeyRef:
          name: datadog-secret
          key: app-key

  rbac:
    create: true

  metricsProvider:
    enabled: true
    # Use Datadog as the custom metrics provider
    registerAPIService: true
    wpaController: false
```

### HPA Using Datadog External Metrics

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: checkout-api-hpa
  namespace: production
  annotations:
    # Datadog-specific: specify the query language
    kubectl.kubernetes.io/last-applied-configuration: ""
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-api
  minReplicas: 4
  maxReplicas: 100

  metrics:
    # Scale on Datadog APM throughput metric
    - type: External
      external:
        metric:
          name: datadog.hpa.checkout_api.requests_per_second
          selector:
            matchLabels:
              # These selectors map to Datadog tag filters
              env: production
              service: checkout-api
        target:
          type: AverageValue
          averageValue: "200"

    # Scale on Datadog APM P95 latency
    - type: External
      external:
        metric:
          name: datadog.hpa.checkout_api.p95_latency_ms
          selector:
            matchLabels:
              env: production
              service: checkout-api
        target:
          type: Value
          value: "500"  # 500ms P95 threshold

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
          value: 20
          periodSeconds: 120
```

### DatadogMetric CRD (Watermark Pod Autoscaler Alternative)

For more complex Datadog queries, use the `DatadogMetric` CRD:

```yaml
apiVersion: datadoghq.com/v1alpha1
kind: DatadogMetric
metadata:
  name: checkout-api-rps
  namespace: production
spec:
  query: "avg:trace.checkout_api.request.hits{env:production,service:checkout-api}.rollup(avg, 60)"
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: checkout-api-hpa-ddm
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: checkout-api
  minReplicas: 4
  maxReplicas: 100
  metrics:
    - type: External
      external:
        metric:
          name: datadogmetric@production:checkout-api-rps
        target:
          type: AverageValue
          averageValue: "200"
```

## Dynatrace Metrics Ingest for HPA

Dynatrace exposes metrics via its `metrics.k8s.io` implementation through the Dynatrace Operator.

### Dynatrace Operator Configuration

```yaml
apiVersion: dynatrace.com/v1beta1
kind: DynaKube
metadata:
  name: dynakube
  namespace: dynatrace
spec:
  apiUrl: https://abc12345.live.dynatrace.com/api

  # Enable custom metrics exporter
  metricIngest:
    enabled: true

  # Enable Kubernetes custom metrics API
  extensions:
    enabled: true
```

### Dynatrace HPA Configuration

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: inventory-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: inventory-service
  minReplicas: 3
  maxReplicas: 30

  metrics:
    # Dynatrace service response time (P90)
    - type: External
      external:
        metric:
          name: ext:dynatrace.service.response.time.p90
          selector:
            matchLabels:
              dt.entity.service: SERVICE-INVENTORY_SERVICE_PROD
        target:
          type: Value
          value: "300"  # 300ms P90 threshold (in milliseconds)

    # Dynatrace service request rate
    - type: External
      external:
        metric:
          name: ext:dynatrace.service.request.count
          selector:
            matchLabels:
              dt.entity.service: SERVICE-INVENTORY_SERVICE_PROD
        target:
          type: AverageValue
          averageValue: "150"

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 120
      policies:
        - type: Percent
          value: 30
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
        - type: Percent
          value: 10
          periodSeconds: 120
```

## Multi-Metric HPA with ScaleDown Protection

Production HPAs should combine multiple metrics to prevent scale-down during high-latency conditions even when RPS is low:

```yaml
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
  minReplicas: 5
  maxReplicas: 80

  metrics:
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "75"

    - type: Pods
      pods:
        metric:
          name: http_request_duration_p99
        target:
          type: AverageValue
          averageValue: "200m"

    - type: External
      external:
        metric:
          name: kafka_consumer_lag
          selector:
            matchLabels:
              consumer_group: order-processor
        target:
          type: AverageValue
          averageValue: "500"

    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65

    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 75

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        # Fast scale-up: double replicas or add 5, whichever is larger
        - type: Percent
          value: 100
          periodSeconds: 30
        - type: Pods
          value: 5
          periodSeconds: 30
      selectPolicy: Max

    scaleDown:
      stabilizationWindowSeconds: 600
      policies:
        # Conservative scale-down: max 10% per 2 minutes
        - type: Percent
          value: 10
          periodSeconds: 120
      selectPolicy: Min
```

## Verifying HPA Metric Queries

```bash
# Check current HPA status and metric values
kubectl describe hpa order-processor-hpa -n production

# Expected output:
# Reference:                Deployment/order-processor
# Metrics:                  ( current / target )
#   "http_requests_per_second" on pods:  87500m / 75
#   "http_request_duration_p99" on pods: 152m / 200m
#   "kafka_consumer_lag" (external metric): 12450 / 500 (targetAverageValue)
# Conditions:
#   AbleToScale   True   ScaleUpReady   30s
#   ScalingActive True   ValidMetricFound
#   ScalingLimited False  DesiredWithinRange

# Check HPA events
kubectl get events -n production --field-selector reason=SuccessfulRescale

# Query the metric directly from the adapter
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" | \
  jq '.items[] | {pod: .describedObject.name, value: .value}'
```

## Summary

Custom metrics HPA requires understanding which API group to use (`custom.metrics.k8s.io` for pod/object-scoped metrics, `external.metrics.k8s.io` for global metrics), how each adapter translates metric sources, and how the HPA controller selects the highest replica count when multiple metrics are active. The `behavior` stanza is as important as the metric targets — aggressive scale-up policies prevent queue build-up during traffic spikes, while conservative scale-down policies prevent oscillation and connection pool churn.
