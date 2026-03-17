---
title: "Kubernetes HPA and KEDA: Advanced Autoscaling Patterns for Production"
date: 2028-02-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "KEDA", "Autoscaling", "Prometheus", "Kafka", "VPA"]
categories: ["Kubernetes", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes autoscaling using HPA v2 behavior policies, custom metrics with Prometheus Adapter, KEDA ScaledObject and ScaledJob triggers, and VPA trade-offs for production workloads."
more_link: "yes"
url: "/kubernetes-hpa-keda-autoscaling-guide/"
---

Production Kubernetes workloads face dynamic traffic patterns that static replica counts cannot handle efficiently. The Horizontal Pod Autoscaler (HPA) v2 API and the Kubernetes Event-driven Autoscaling (KEDA) project together provide a layered approach to autoscaling that covers CPU/memory-based scaling, custom application metrics, and event-driven triggers from message queues, streams, and scheduled cron expressions. This guide presents the complete picture: HPA v2 behavior policies, Prometheus Adapter integration, every major KEDA trigger type, batch workload scaling with ScaledJob, the interaction between HPA and KEDA, and when to choose VPA or cluster-proportional autoscaler instead.

<!--more-->

## HPA v2 Architecture and Behavior Policies

The HPA v2 API (`autoscaling/v2`) replaced the deprecated `autoscaling/v1` in Kubernetes 1.23+. The critical addition is the `behavior` stanza, which controls scale-up and scale-down velocity independently.

### Basic HPA v2 Structure

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
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 5
        periodSeconds: 15
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 20
        periodSeconds: 60
      - type: Pods
        value: 2
        periodSeconds: 60
      selectPolicy: Min
```

### Understanding Behavior Policies

The `stabilizationWindowSeconds` prevents thrashing. For scale-up, a short window (30-60s) allows rapid response to traffic spikes. For scale-down, a longer window (300-600s) prevents premature removal of pods during intermittent load drops.

The `selectPolicy` field determines which policy wins when multiple policies are evaluated:
- `Max`: The policy that allows the largest change wins (aggressive scaling)
- `Min`: The policy that allows the smallest change wins (conservative scaling)
- `Disabled`: Scaling in that direction is blocked entirely

Scale-down with `selectPolicy: Min` and multiple policies provides a safety net: the cluster scales down only as fast as the most conservative policy allows.

### Stabilization Window Interaction

```
Time 0:   replicas=10, CPU=90% → scale up signal
Time 15s: replicas=15, CPU=75% → within scaleUp.stabilizationWindowSeconds=30
Time 30s: replicas=15, CPU=65% → stabilization window cleared, no scale
Time 330s: replicas=15, CPU=40% → scale-down signal (within 300s window, looking at max)
Time 630s: replicas=12, CPU=38% → scale-down executes after stabilization
```

## Custom Metrics with Prometheus Adapter

The Prometheus Adapter exposes Prometheus metrics through the Kubernetes Custom Metrics API (`custom.metrics.k8s.io`) and External Metrics API (`external.metrics.k8s.io`). HPA can then target these metrics.

### Prometheus Adapter Installation

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus-operated.monitoring.svc.cluster.local \
  --set prometheus.port=9090 \
  -f prometheus-adapter-values.yaml
```

### Adapter Configuration for Request Rate Metrics

```yaml
# prometheus-adapter-values.yaml
rules:
  custom:
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
    metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'

  - seriesQuery: 'http_request_duration_seconds_bucket{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace:
          resource: namespace
        pod:
          resource: pod
    name:
      matches: ".*"
      as: "http_p99_latency_seconds"
    metricsQuery: >-
      histogram_quantile(0.99,
        sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m]))
        by (<<.GroupBy>>, le)
      )

  external:
  - seriesQuery: 'kafka_consumer_group_lag{namespace!=""}'
    resources:
      overrides:
        namespace:
          resource: namespace
    name:
      matches: "^kafka_consumer_group_lag$"
      as: "kafka_consumer_group_lag"
    metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

### HPA Targeting Custom Metrics

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-custom-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 30
  metrics:
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "500"
  - type: Object
    object:
      metric:
        name: http_p99_latency_seconds
      describedObject:
        apiVersion: apps/v1
        kind: Deployment
        name: api-server
      target:
        type: Value
        value: "0.5"
```

### Verifying Custom Metrics

```bash
# Check custom metrics API is responding
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq '.resources[] | .name'

# Query a specific metric
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" \
  | jq .

# Check external metrics
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | jq .

# Describe HPA to see current metric values
kubectl describe hpa api-server-custom-hpa -n production
```

## KEDA: Event-Driven Autoscaling

KEDA extends Kubernetes autoscaling with event-source awareness. It introduces two CRDs: `ScaledObject` (for Deployments/StatefulSets) and `ScaledJob` (for batch Jobs). KEDA operates as a Kubernetes operator and installs its own HPA resources, acting as a metric server for those HPAs.

### KEDA Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true
```

### ScaledObject: Kafka Trigger

Kafka-based scaling is the most common KEDA use case. The scaler reads consumer group lag and scales workers proportionally.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: kafka-consumer
  pollingInterval: 15
  cooldownPeriod: 60
  minReplicaCount: 1
  maxReplicaCount: 50
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 120
          policies:
          - type: Percent
            value: 25
            periodSeconds: 60
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-broker-0.kafka.svc.cluster.local:9092,kafka-broker-1.kafka.svc.cluster.local:9092
      consumerGroup: order-processor-group
      topic: orders
      lagThreshold: "100"
      offsetResetPolicy: latest
    authenticationRef:
      name: kafka-trigger-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-credentials
    key: sasl-mechanism
  - parameter: username
    name: kafka-credentials
    key: username
  - parameter: password
    name: kafka-credentials
    key: password
  - parameter: tls
    name: kafka-credentials
    key: tls-enabled
  - parameter: ca
    name: kafka-credentials
    key: ca-cert
```

### ScaledObject: Redis List Trigger

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: redis-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: task-worker
  minReplicaCount: 0
  maxReplicaCount: 20
  pollingInterval: 10
  cooldownPeriod: 30
  triggers:
  - type: redis
    metadata:
      address: redis-master.cache.svc.cluster.local:6379
      listName: task-queue
      listLength: "10"
      enableTLS: "false"
    authenticationRef:
      name: redis-trigger-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: password
    name: redis-secret
    key: redis-password
```

### ScaledObject: Prometheus Trigger

The Prometheus trigger evaluates a PromQL expression and scales based on the result. This is the most flexible trigger type.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: prometheus-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: metric-processor
  minReplicaCount: 2
  maxReplicaCount: 40
  pollingInterval: 30
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: active_jobs_count
      query: >-
        sum(active_jobs{namespace="production",service="metric-processor"})
      threshold: "10"
      activationThreshold: "1"
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: queue_processing_rate
      query: >-
        sum(rate(jobs_processed_total{namespace="production"}[5m]))
      threshold: "50"
```

### ScaledObject: Cron Trigger

Cron triggers allow predictive scaling based on known traffic patterns, reducing cold-start latency.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: business-hours-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: web-application
  minReplicaCount: 2
  maxReplicaCount: 30
  triggers:
  - type: cron
    metadata:
      timezone: America/Chicago
      start: "0 7 * * 1-5"
      end: "0 19 * * 1-5"
      desiredReplicas: "10"
  - type: cron
    metadata:
      timezone: America/Chicago
      start: "0 18 * * 5"
      end: "0 23 * * 0"
      desiredReplicas: "5"
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: web_rps
      query: sum(rate(nginx_http_requests_total{namespace="production"}[2m]))
      threshold: "200"
```

Multiple triggers on a single ScaledObject use OR semantics: the maximum replica count across all triggers determines the actual replica count.

## ScaledJob for Batch Workloads

`ScaledJob` creates individual Kubernetes Jobs for each unit of work, rather than scaling a long-running deployment. This is ideal for batch processing, image transcoding, report generation, and ML inference.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processor-job
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 2
    template:
      spec:
        restartPolicy: Never
        containers:
        - name: image-processor
          image: registry.example.com/image-processor:v2.1.0
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
          env:
          - name: QUEUE_NAME
            value: "image-processing"
          - name: REDIS_ADDR
            valueFrom:
              secretKeyRef:
                name: redis-secret
                key: addr
  pollingInterval: 10
  maxReplicaCount: 20
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10
  scalingStrategy:
    strategy: "accurate"
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "1.0"
  triggers:
  - type: redis
    metadata:
      address: redis-master.cache.svc.cluster.local:6379
      listName: image-processing
      listLength: "1"
    authenticationRef:
      name: redis-trigger-auth
```

### ScaledJob Scaling Strategies

KEDA supports three scaling strategies for ScaledJob:

- `default`: Creates jobs up to maxReplicaCount, subtracting running jobs
- `accurate`: Factors in pending jobs and partially completed work for precise scaling
- `eager`: Scales to meet demand aggressively, suitable for latency-sensitive batch work

```yaml
scalingStrategy:
  strategy: "accurate"
  # Deduct this many items per running job (for multi-item processors)
  customScalingQueueLengthDeduction: 5
  # Treat this fraction of running jobs as completing (0.0-1.0)
  customScalingRunningJobPercentage: "0.5"
```

## Combining HPA and KEDA

KEDA creates and manages HPA resources on behalf of ScaledObjects. When KEDA is installed, it acts as an external metrics server. The HPA it creates targets `external.metrics.k8s.io` endpoints served by the KEDA metrics adapter.

This means: **do not create a separate HPA for the same Deployment that has a ScaledObject**. KEDA manages the HPA internally.

```bash
# Verify KEDA-managed HPAs
kubectl get hpa -n production
# NAME                              REFERENCE            TARGETS         MINPODS   MAXPODS   REPLICAS
# keda-hpa-kafka-consumer-scaler    Deployment/kafka     8/100 (lag)     1         50        3

# Check ScaledObject status
kubectl describe scaledobject kafka-consumer-scaler -n production
```

### Layered Autoscaling: KEDA + Cluster Autoscaler

KEDA and HPA operate at the pod level. The Cluster Autoscaler operates at the node level. The combination provides full-stack autoscaling:

```
Application load increases
  → KEDA/HPA increases pod count
    → Pods become Pending (insufficient node capacity)
      → Cluster Autoscaler provisions new nodes
        → Pods become Running
```

For this to work reliably, pods must have accurate resource requests. Cluster Autoscaler uses requests (not limits) to determine whether a new node is needed.

```yaml
# Ensure accurate resource requests for CA to function correctly
resources:
  requests:
    cpu: "250m"      # Actual measured baseline, not 1m
    memory: "256Mi"  # Actual measured baseline, not 128Mi
  limits:
    cpu: "2"
    memory: "1Gi"
```

## VPA vs HPA Trade-offs

The Vertical Pod Autoscaler adjusts CPU and memory requests/limits for individual pods based on historical usage. It complements HPA for different workload types.

### When to Use VPA

- Single-threaded or memory-bound workloads that cannot parallelize
- Batch jobs with variable resource requirements
- Workloads where horizontal scaling has high cost (databases with sharding complexity)
- Initial right-sizing of resource requests during development

### When to Use HPA

- Stateless services with linear scalability
- Web applications, API servers, message consumers
- Any workload where additional replicas directly increase throughput

### VPA in Recommendation Mode (Safe for Production)

VPA in `updateMode: "Off"` provides recommendations without restarting pods, making it safe to run alongside HPA:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
    - containerName: api-server
      minAllowed:
        cpu: "100m"
        memory: "128Mi"
      maxAllowed:
        cpu: "4"
        memory: "8Gi"
      controlledResources: ["cpu", "memory"]
```

```bash
# Read VPA recommendations
kubectl describe vpa api-server-vpa -n production | grep -A 20 "Recommendation"
```

### VPA + HPA Conflict Avoidance

Running VPA in `Auto` or `Recreate` mode alongside HPA targeting CPU utilization creates a feedback loop:

1. HPA scales up due to high CPU utilization
2. VPA increases CPU requests on pods, lowering utilization percentage
3. HPA scales down because utilization appears lower
4. VPA reduces CPU requests, utilization rises
5. Cycle repeats

To avoid this, constrain HPA and VPA to different metrics:

```yaml
# HPA targets custom application metric (requests/second)
# VPA manages CPU/memory requests independently
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
spec:
  resourcePolicy:
    containerPolicies:
    - containerName: api-server
      controlledResources: ["memory"]  # VPA only manages memory
      # HPA manages CPU-based scaling separately
```

## Cluster Proportional Autoscaler

The Cluster Proportional Autoscaler (CPA) scales a target deployment proportionally to the number of nodes or cores in the cluster. It is purpose-built for cluster add-ons that need to scale with cluster size: CoreDNS, kube-proxy, metrics-server.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-proportional-autoscaler
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-proportional-autoscaler
  template:
    metadata:
      labels:
        app: cluster-proportional-autoscaler
    spec:
      containers:
      - name: autoscaler
        image: registry.k8s.io/cpa/cluster-proportional-autoscaler:1.8.6
        command:
        - /cluster-proportional-autoscaler
        - --namespace=kube-system
        - --configmap=coredns-autoscaler
        - --target=Deployment/coredns
        - --logtostderr=true
        - --v=2
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-autoscaler
  namespace: kube-system
data:
  linear: |-
    {
      "coresPerReplica": 256,
      "nodesPerReplica": 16,
      "min": 2,
      "max": 20,
      "preventSinglePointOfFailure": true
    }
```

The `coresPerReplica` and `nodesPerReplica` parameters define scaling ratios. With `preventSinglePointOfFailure: true`, the minimum is 2 regardless of cluster size.

## Production Checklist and Monitoring

### HPA Metrics to Monitor

```yaml
# PrometheusRule for HPA monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hpa-alerts
  namespace: monitoring
spec:
  groups:
  - name: hpa.rules
    interval: 30s
    rules:
    - alert: HPAAtMaxReplicas
      expr: >-
        kube_horizontalpodautoscaler_status_current_replicas
        == kube_horizontalpodautoscaler_spec_max_replicas
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
        description: "HPA has been at max replicas for 5 minutes. Consider increasing maxReplicas."

    - alert: HPAScaleDownBlocked
      expr: >-
        kube_horizontalpodautoscaler_status_current_replicas
        > kube_horizontalpodautoscaler_spec_min_replicas
        and
        kube_horizontalpodautoscaler_status_desired_replicas
        < kube_horizontalpodautoscaler_status_current_replicas
      for: 15m
      labels:
        severity: info
      annotations:
        summary: "HPA scale-down blocked for {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }}"

    - alert: KEDAScalerError
      expr: keda_scaler_errors_total > 0
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "KEDA scaler errors detected for {{ $labels.scaledobject }}"
```

### Debugging Autoscaling Issues

```bash
# Check HPA events
kubectl describe hpa <name> -n <namespace>
# Look for: "failed to get cpu utilization" → metrics-server issue
# Look for: "unable to fetch metrics" → Prometheus Adapter issue

# Check KEDA operator logs
kubectl logs -n keda -l app=keda-operator --tail=100 | grep -i error

# Check KEDA metrics adapter
kubectl logs -n keda -l app=keda-metrics-apiserver --tail=100

# Manually query KEDA external metrics
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/s0-kafka-orders" \
  | jq .

# Verify ScaledObject is ready
kubectl get scaledobject -n production -o wide
```

### Resource Request Accuracy

Autoscaling decisions are only as good as the resource metrics they rely on. Verify that pods have accurate resource requests:

```bash
# Find pods with suspiciously low CPU requests
kubectl get pods -n production -o json | \
  jq -r '.items[] | .metadata.name + " " +
  (.spec.containers[0].resources.requests.cpu // "MISSING")'

# Compare requests vs actual usage with VPA recommendations
kubectl describe vpa -n production | grep -A 5 "Target:"
```

## Summary

HPA v2 behavior policies give precise control over scaling velocity, preventing thrashing and enabling safe scale-down. Prometheus Adapter bridges the gap between application metrics and the Kubernetes metrics API. KEDA extends this further with native event-source triggers—Kafka lag, Redis queue depth, Prometheus queries, and cron schedules—with ScaledJob providing purpose-built batch autoscaling. The correct architecture layers these tools: KEDA/HPA for pod-level scaling, Cluster Autoscaler for node-level scaling, VPA in recommendation mode for right-sizing, and CPA for cluster proportional add-ons. Together, they provide a complete, production-grade autoscaling stack.
