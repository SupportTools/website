---
title: "Kubernetes HPA with Custom Metrics from Prometheus: Scaling on Business Metrics with kube-metrics-adapter"
date: 2031-09-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "Prometheus", "Custom Metrics", "Autoscaling", "kube-metrics-adapter"]
categories: ["Kubernetes", "Observability"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to scaling Kubernetes workloads on real business metrics using Prometheus and kube-metrics-adapter, covering adapter configuration, HPA manifests, and production tuning."
more_link: "yes"
url: "/kubernetes-hpa-custom-metrics-prometheus-kube-metrics-adapter/"
---

Most Kubernetes deployments start by scaling on CPU and memory. Those resources matter, but they are poor proxies for actual workload demand. A queue processor sitting idle at 5% CPU can still be falling behind if 50,000 messages are waiting. A web tier hovering at 70% CPU can be perfectly healthy if p99 latency is under budget. Business metrics—queue depth, request rate, active sessions, order processing lag—tell a much richer story, and the Horizontal Pod Autoscaler can act on all of them when wired to a Prometheus data source through kube-metrics-adapter.

This guide builds a complete, production-ready pipeline: Prometheus scrapes your application, kube-metrics-adapter exposes those metrics through the Kubernetes custom metrics API, and HPA drives scaling decisions. Every component is shown with real manifests, tuning knobs, and operational notes.

<!--more-->

# Kubernetes HPA with Custom Metrics from Prometheus

## Why CPU and Memory Are Not Enough

The default HPA v2 resource metrics work because every container has resource requests, so the math is deterministic. The problem is that CPU utilisation is a lagging indicator. By the time a node is saturated, the backlog has already grown large enough to cause user-visible degradation.

Consider these common mismatches:

| Workload Type | Better Scaling Signal |
|---|---|
| Message queue consumer | Queue depth / lag |
| HTTP API | Requests per second per pod |
| Batch job runner | Pending job count |
| WebSocket server | Active connections |
| Data pipeline | Rows pending / bytes in flight |

Kubernetes exposes two extension APIs for non-resource metrics:

- `custom.metrics.k8s.io/v1beta2` — per-object metrics tied to a specific Kubernetes resource (e.g., "messages pending for this Deployment")
- `external.metrics.k8s.io/v1beta1` — cluster-external metrics with no Kubernetes object binding

kube-metrics-adapter implements both APIs and can pull from Prometheus, InfluxDB, AWS CloudWatch, or custom HTTP endpoints. This guide focuses on the Prometheus backend, which covers the majority of production use cases.

## Architecture Overview

```
Application pods
      │
      │ /metrics (Prometheus format)
      ▼
Prometheus server
      │
      │ PromQL queries
      ▼
kube-metrics-adapter (Deployment in kube-system)
      │ implements
      ├── custom.metrics.k8s.io
      └── external.metrics.k8s.io
                │
                │ metric values
                ▼
       HPA controller
                │
                │ scale decisions
                ▼
      Deployment replica count
```

The adapter registers itself as an API extension server. The HPA controller, part of kube-controller-manager, periodically calls the adapter to fetch the current metric value and then applies the standard HPA scaling formula.

## Installing kube-metrics-adapter

### Prerequisites

- Kubernetes 1.25+
- Prometheus accessible from within the cluster
- `cert-manager` or manual TLS certificates for the adapter's webhook server

### Helm Installation

```bash
helm repo add kube-metrics-adapter \
  https://charts.k8s.io/kube-metrics-adapter
helm repo update

helm install kube-metrics-adapter kube-metrics-adapter/kube-metrics-adapter \
  --namespace kube-system \
  --set prometheus.url=http://prometheus-operated.monitoring.svc.cluster.local:9090 \
  --set replicas=2 \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=256Mi
```

### Verify the API Groups Are Available

```bash
kubectl api-versions | grep metrics

# Expected output includes:
# custom.metrics.k8s.io/v1beta2
# external.metrics.k8s.io/v1beta1
# metrics.k8s.io/v1beta1
```

### Full Helm Values for Production

```yaml
# kube-metrics-adapter-values.yaml
replicas: 2

prometheus:
  url: "http://prometheus-operated.monitoring.svc.cluster.local:9090"
  # If Prometheus requires authentication:
  # tokenPath: /var/run/secrets/kubernetes.io/serviceaccount/token

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi

podDisruptionBudget:
  enabled: true
  minAvailable: 1

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: kube-metrics-adapter
          topologyKey: kubernetes.io/hostname

priorityClassName: system-cluster-critical

logLevel: 0  # increase to 5 for debug

# Metric discovery configuration
metricsRelistInterval: 1m

securityContext:
  runAsNonRoot: true
  runAsUser: 65534
  readOnlyRootFilesystem: true
```

## Defining Metrics with HPA Annotations

kube-metrics-adapter discovers which PromQL queries to execute from annotations on HPA objects. This design means you do not need a separate ConfigMap per metric; the metric definition lives next to the scaling policy.

### Annotation Keys

| Annotation | Purpose |
|---|---|
| `metric-config.pods.{metric-name}.prometheus/query` | PromQL query for pod-level metric |
| `metric-config.pods.{metric-name}.prometheus/per-replica` | Whether to divide result by replica count |
| `metric-config.object.{metric-name}.prometheus/query` | PromQL query for object-level metric |
| `metric-config.external.{metric-name}.prometheus/query` | PromQL query for external metric |

### PromQL Query Guidelines for HPA

HPA expects a scalar or per-pod value. Your queries should:

1. Return a single numeric value (use aggregation operators)
2. Account for current replica count if you want "per-pod" semantics
3. Use `rate()` with a window that balances reactivity vs. noise (typically 2–5 minutes)

## Example 1: Scaling on HTTP Request Rate

### Application Metrics

Your application exposes:

```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/api/v1/orders",status="200"} 142857
```

### HPA Manifest

```yaml
# hpa-request-rate.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: orders-api-hpa
  namespace: production
  annotations:
    # kube-metrics-adapter reads this annotation to build the PromQL query
    metric-config.pods.http-requests-per-second.prometheus/query: |
      sum(rate(http_requests_total{namespace="production",pod=~"orders-api-.*"}[2m]))
      /
      count(kube_pod_info{namespace="production",pod=~"orders-api-.*"})
    metric-config.pods.http-requests-per-second.prometheus/per-replica: "true"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: orders-api
  minReplicas: 3
  maxReplicas: 50
  metrics:
    - type: Pods
      pods:
        metric:
          name: http-requests-per-second
        target:
          type: AverageValue
          averageValue: "100"  # scale up when > 100 req/s per pod
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 25
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
        - type: Pods
          value: 5
          periodSeconds: 30
      selectPolicy: Max
```

### Deployment for Reference

```yaml
# deployment-orders-api.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orders-api
  template:
    metadata:
      labels:
        app: orders-api
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: orders-api
          image: registry.example.com/orders-api:v2.4.1
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 20
```

## Example 2: Scaling a Queue Consumer on Queue Depth

This is the most impactful use case. A Kafka consumer group's lag directly tells you how far behind processing is.

### Prometheus Metric from kafka-exporter

```
# Exposed by kafka-exporter
kafka_consumer_group_lag{consumergroup="order-processor",topic="orders",partition="0"} 12450
```

### HPA with External Metric

```yaml
# hpa-kafka-consumer.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: order-processor-hpa
  namespace: production
  annotations:
    metric-config.external.kafka-consumer-lag.prometheus/query: |
      sum(kafka_consumer_group_lag{
        consumergroup="order-processor",
        topic="orders"
      })
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor
  minReplicas: 2
  maxReplicas: 30
  metrics:
    - type: External
      external:
        metric:
          name: kafka-consumer-lag
          selector:
            matchLabels:
              # These labels filter which metric series the adapter returns.
              # For external metrics they are passed through to the PromQL selector.
              topic: orders
              consumergroup: order-processor
        target:
          type: AverageValue
          # Target: 1000 messages lag per pod before scaling up
          averageValue: "1000"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 600   # be conservative scaling down consumers
      policies:
        - type: Percent
          value: 20
          periodSeconds: 120
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
```

### Consumer Deployment

```yaml
# deployment-order-processor.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-processor
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: order-processor
  template:
    metadata:
      labels:
        app: order-processor
    spec:
      # Use terminationGracePeriodSeconds to allow in-flight messages to finish
      terminationGracePeriodSeconds: 120
      containers:
        - name: order-processor
          image: registry.example.com/order-processor:v1.8.0
          env:
            - name: KAFKA_BROKERS
              valueFrom:
                secretKeyRef:
                  name: kafka-credentials
                  key: brokers
            - name: CONSUMER_GROUP
              value: order-processor
            - name: TOPIC
              value: orders
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 10"]
```

## Example 3: Object Metric — Active WebSocket Connections

Some applications expose per-pod connection counts. Object metrics let HPA reference a specific Kubernetes object.

```yaml
# hpa-websocket.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: websocket-server-hpa
  namespace: production
  annotations:
    metric-config.object.active-websocket-connections.prometheus/query: |
      sum(websocket_active_connections{namespace="production"})
    metric-config.object.active-websocket-connections.prometheus/per-replica: "false"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: websocket-server
  minReplicas: 5
  maxReplicas: 200
  metrics:
    - type: Object
      object:
        metric:
          name: active-websocket-connections
        describedObject:
          apiVersion: apps/v1
          kind: Deployment
          name: websocket-server
        target:
          type: Value
          value: "5000"   # scale up when total connections > 5000
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 900  # connections drain slowly on websocket servers
      policies:
        - type: Pods
          value: 2
          periodSeconds: 300
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 50
          periodSeconds: 30
```

## Verifying the Custom Metrics Pipeline

### Check Metrics Are Visible Through the API

```bash
# List all available custom metrics
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta2 | jq '.resources[].name'

# Query a specific metric value for a namespace
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta2/namespaces/production/pods/*/http-requests-per-second" \
  | jq .

# List external metrics
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1 | jq '.resources[].name'

# Query an external metric
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/kafka-consumer-lag" \
  | jq .
```

### Inspect the HPA Status

```bash
kubectl describe hpa orders-api-hpa -n production
```

Expected output excerpt:

```
Name:                                                  orders-api-hpa
Namespace:                                             production
Reference:                                             Deployment/orders-api
Metrics:                                               ( current / target )
  "http-requests-per-second" on pods:                 87500m / 100
Min replicas:                                          3
Max replicas:                                          50
Deployment pods:                                       3 current / 3 desired
Conditions:
  Type            Status  Reason            Message
  ----            ------  ------            -------
  AbleToScale     True    ReadyForNewScale  recommended size matches current size
  ScalingActive   True    ValidMetricFound  the HPA was able to successfully calculate a replica count from pods metric http-requests-per-second
  ScalingLimited  False   DesiredWithinRange
```

### Watch the HPA React to Load

```bash
# Watch in a separate terminal
kubectl get hpa -n production -w

# Generate synthetic load (adjust for your application)
kubectl run load-generator \
  --image=busybox:1.36 \
  --restart=Never \
  -n production \
  -- sh -c "while true; do wget -q -O- http://orders-api/api/v1/orders; done"
```

## Production Tuning Strategies

### Stabilisation Windows and Scaling Policies

The `behavior` block is critical to prevent thrashing. Without it, HPA uses defaults that are often too aggressive for production traffic patterns.

```yaml
behavior:
  scaleDown:
    # Wait 5 minutes of sustained low utilisation before scaling down.
    # This prevents flapping when traffic is spiky but recovers quickly.
    stabilizationWindowSeconds: 300
    policies:
      # At most 20% of current pods per minute on scale-down.
      - type: Percent
        value: 20
        periodSeconds: 60
      # Or at most 2 pods per minute — whichever is smaller (Min policy).
      - type: Pods
        value: 2
        periodSeconds: 60
    selectPolicy: Min
  scaleUp:
    # Scale up quickly — only 30 seconds stabilisation.
    stabilizationWindowSeconds: 30
    policies:
      # Double pod count or add 10 pods per 30 seconds, whichever is larger.
      - type: Percent
        value: 100
        periodSeconds: 30
      - type: Pods
        value: 10
        periodSeconds: 30
    selectPolicy: Max
```

### PromQL Query Best Practices

**Avoid instant vectors with high cardinality:**

```promql
# BAD: returns one value per pod, adapter cannot aggregate
http_requests_total{namespace="production"}

# GOOD: aggregated scalar
sum(rate(http_requests_total{namespace="production",pod=~"orders-api-.*"}[2m]))
```

**Handle missing metric series gracefully:**

```promql
# If no pods exist yet, return 0 instead of "no data"
sum(rate(http_requests_total{namespace="production"}[2m])) or vector(0)
```

**Normalise by replica count for per-pod targeting:**

```promql
(
  sum(rate(http_requests_total{namespace="production",pod=~"orders-api-.*"}[2m]))
)
/
(
  count(kube_pod_info{namespace="production",pod=~"orders-api-.*"})
  or vector(1)
)
```

### Combining Custom Metrics with Resource Metrics

HPA v2 supports multiple metric sources. When you provide multiple metrics, HPA calculates the desired replica count for each and takes the maximum, ensuring the workload is never under-resourced on any dimension.

```yaml
spec:
  metrics:
    # Custom business metric: request rate
    - type: Pods
      pods:
        metric:
          name: http-requests-per-second
        target:
          type: AverageValue
          averageValue: "100"
    # Standard resource metric: CPU as a safety net
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    # Memory guard
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### KEDA as an Alternative

For more advanced scaling scenarios (scale-to-zero, event-driven scaling, built-in Prometheus support without an adapter), consider KEDA (Kubernetes Event-Driven Autoscaling). kube-metrics-adapter remains the right choice when you need tight integration with the standard HPA API and want to avoid adding another controller.

## Alerting on HPA Health

Add these Prometheus alerts to catch scaling problems early:

```yaml
# prometheus-rules-hpa.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hpa-alerts
  namespace: monitoring
spec:
  groups:
    - name: hpa
      interval: 30s
      rules:
        - alert: HPAMaxReplicasReached
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas
            ==
            kube_horizontalpodautoscaler_spec_max_replicas
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
            description: "HPA has been at maximum replicas for 10 minutes. Consider increasing maxReplicas or investigating load."

        - alert: HPAScalingLimitedByMinReplicas
          expr: |
            kube_horizontalpodautoscaler_status_desired_replicas
            <
            kube_horizontalpodautoscaler_spec_min_replicas
          for: 5m
          labels:
            severity: info
          annotations:
            summary: "HPA desired replicas below minimum"

        - alert: HPACustomMetricNotAvailable
          expr: |
            kube_horizontalpodautoscaler_status_condition{condition="ScalingActive",status="false"}
            == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} cannot fetch metrics"
            description: "Check kube-metrics-adapter logs and Prometheus connectivity."

        - alert: HPAReplicasFlapping
          expr: |
            changes(kube_horizontalpodautoscaler_status_current_replicas[30m]) > 5
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} is flapping"
            description: "Replica count changed more than 5 times in 30 minutes. Review stabilization window settings."
```

## Grafana Dashboard Queries

Track your HPA behaviour with these PromQL queries:

```promql
# Current vs desired replicas
kube_horizontalpodautoscaler_status_current_replicas{namespace="production"}
kube_horizontalpodautoscaler_status_desired_replicas{namespace="production"}

# Custom metric value over time
custom_metrics:http_requests_per_second:avg{namespace="production"}

# Scale events per hour
increase(kube_horizontalpodautoscaler_status_current_replicas[1h])
```

## Troubleshooting

### Metric Not Found

```bash
# Check adapter logs
kubectl logs -n kube-system -l app.kubernetes.io/name=kube-metrics-adapter --tail=100

# Common errors:
# "no series for metric" — PromQL query returns no data, check metric name and labels
# "error converting metric" — type mismatch between query result and expected format
```

### HPA Shows "unknown" for Custom Metric

```bash
kubectl get hpa orders-api-hpa -n production
# NAME             REFERENCE           TARGETS         MINPODS   MAXPODS   REPLICAS
# orders-api-hpa   Deployment/orders-api   <unknown>/100   3         50        3

# Diagnose:
kubectl describe hpa orders-api-hpa -n production | grep -A5 Conditions
```

Check that:
1. The annotation key exactly matches the metric name in the HPA spec
2. The Prometheus URL is reachable from the adapter pods
3. The PromQL query returns data (test it in the Prometheus UI)

### Adapter Cannot Register as API Server

```bash
# Check APIService registration
kubectl get apiservice v1beta2.custom.metrics.k8s.io

# If status shows "False", check TLS and RBAC:
kubectl describe apiservice v1beta2.custom.metrics.k8s.io
```

## Summary

Custom metric scaling via kube-metrics-adapter transforms HPA from a CPU thermometer into a genuine business-aware scaling engine. The key principles:

- Define PromQL queries as HPA annotations — keeps metric definitions co-located with scaling policy
- Use aggregated scalar queries to avoid cardinality issues in the adapter
- Configure `behavior` blocks to prevent thrashing, especially for stateful consumers
- Combine custom metrics with resource metrics to guard against both business and infrastructure limits
- Monitor HPA health with dedicated Prometheus alerts and a Grafana dashboard

The result is a system that scales precisely when work demands it and contracts when it does not, minimising both cost and latency.
