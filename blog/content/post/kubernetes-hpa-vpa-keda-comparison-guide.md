---
title: "HPA vs VPA vs KEDA: Choosing the Right Kubernetes Autoscaling Strategy"
date: 2027-12-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "VPA", "KEDA", "Autoscaling", "Prometheus", "Performance", "Resource Management"]
categories:
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of Kubernetes autoscaling strategies: HPA v2 with custom metrics, VPA admission controller modes, KEDA ScaledObject patterns, and hybrid approaches combining multiple autoscalers."
more_link: "yes"
url: "/kubernetes-hpa-vpa-keda-comparison-guide/"
---

Kubernetes provides three distinct autoscaling mechanisms that address different dimensions of resource management. The Horizontal Pod Autoscaler scales replica count based on metrics; the Vertical Pod Autoscaler adjusts CPU and memory requests for right-sizing; KEDA extends horizontal scaling to any event source. Choosing the right combination requires understanding the limitations and conflicts between each approach. This guide covers production configuration patterns for all three, including hybrid deployments.

<!--more-->

# HPA vs VPA vs KEDA: Choosing the Right Kubernetes Autoscaling Strategy

## The Three Dimensions of Autoscaling

Before comparing implementations, understand the fundamental problem each solves:

**Horizontal scaling (HPA/KEDA)** adds or removes pod replicas. Effective when the application is stateless and additional instances directly increase capacity. Latency during scale-out is the primary concern.

**Vertical scaling (VPA)** adjusts CPU and memory requests on existing pods. Effective for right-sizing workloads and eliminating over-provisioning. Requires pod restart for most changes, making it unsuitable for latency-sensitive paths.

**Event-driven scaling (KEDA)** scales based on external event queue depth, Prometheus queries, or cloud service metrics. Handles burst patterns that CPU/memory metrics cannot predict.

The critical constraint: **HPA and VPA should not both manage the same resource dimension on the same deployment**. Running both on CPU will cause a feedback loop. The recommended hybrid is VPA for memory, KEDA or HPA for replicas.

## Horizontal Pod Autoscaler (HPA v2)

HPA v2 (autoscaling/v2) is the current API version and supports arbitrary metrics via the `metrics` array.

### CPU and Memory HPA

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 50
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Pods
          value: 5
          periodSeconds: 60
        - type: Percent
          value: 100
          periodSeconds: 60
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 2
          periodSeconds: 120
      selectPolicy: Min
```

The `behavior` field is essential for production. Without stabilization windows, HPA will thrash during metric spikes. The recommended configuration:
- Scale-up: Aggressive (select Max policy between absolute and percentage)
- Scale-down: Conservative (longer window, lower rate)

### Custom Metrics via Prometheus Adapter

The Prometheus Adapter translates Prometheus queries into the custom metrics API that HPA can consume.

#### Installing Prometheus Adapter

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --version 4.10.0 \
  --set prometheus.url=http://prometheus.monitoring.svc.cluster.local \
  --set prometheus.port=9090
```

#### Configuring Custom Metrics

```yaml
# prometheus-adapter ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: adapter-config
  namespace: monitoring
data:
  config.yaml: |
    rules:
      # HTTP requests per second per pod
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

      # Queue depth metric (for message processing pods)
      - seriesQuery: 'rabbitmq_queue_messages{namespace!="",queue!=""}'
        resources:
          overrides:
            namespace:
              resource: namespace
        name:
          as: "rabbitmq_queue_depth"
        metricsQuery: 'max(<<.Series>>{<<.LabelMatchers>>})'

      # P99 latency metric
      - seriesQuery: 'http_request_duration_seconds_bucket{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace:
              resource: namespace
            pod:
              resource: pod
        name:
          as: "http_p99_latency_seconds"
        metricsQuery: |
          histogram_quantile(0.99,
            sum(rate(<<.Series>>{<<.LabelMatchers>>}[5m]))
            by (<<.GroupBy>>, le)
          )
```

#### HPA Using Custom Metrics

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-custom-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 2
  maxReplicas: 30
  metrics:
    # Scale on request rate
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"
    # Also scale on P99 latency (external metric)
    - type: External
      external:
        metric:
          name: http_p99_latency_seconds
          selector:
            matchLabels:
              service: api-service
        target:
          type: Value
          value: "0.5"
```

### Datadog Metrics Server

For organizations using Datadog, the Datadog Metrics Server exposes Datadog queries to HPA:

```yaml
# values for datadog-metrics-server Helm chart
apiVersion: v1
kind: ConfigMap
metadata:
  name: datadog-metrics-config
  namespace: datadog
data:
  config.yaml: |
    externalMetrics:
      - name: nginx_request_rate
        query: "avg:nginx.requests{kube_namespace:production}.as_rate()"
      - name: db_connection_pool_wait
        query: "p99:postgresql.connection_pool.wait_time{kube_namespace:production}"
```

```yaml
# HPA with Datadog external metrics
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: nginx-datadog-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nginx
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          name: nginx_request_rate
          selector:
            matchLabels:
              kube_namespace: production
        target:
          type: AverageValue
          averageValue: "500"
```

## Vertical Pod Autoscaler (VPA)

VPA analyzes historical CPU and memory usage and recommends (or automatically applies) appropriate requests and limits.

### Installing VPA

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# Install VPA CRDs and components
./hack/vpa-install.sh

# Or via Helm
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install vpa fairwinds-stable/vpa \
  --namespace vpa \
  --create-namespace \
  --version 4.4.6
```

### VPA Operation Modes

VPA supports four operation modes:

| Mode | Behavior | Use Case |
|---|---|---|
| `Off` | Only generates recommendations, applies nothing | Analysis phase |
| `Initial` | Sets requests on pod creation only | Avoids disrupting running pods |
| `Recreate` | Evicts pods when recommendation deviates significantly | Acceptable if pods restart gracefully |
| `Auto` | Currently same as Recreate | Future in-place resize support |

### VPA Configuration

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    updateMode: "Initial"  # Safe for stateless services
    minReplicas: 2  # Never evict if replicas <= this count
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4000m
          memory: 8Gi
        controlledResources:
          - cpu
          - memory
        # Only manage requests, not limits
        controlledValues: RequestsOnly
```

### Reading VPA Recommendations

```bash
# View current recommendations
kubectl describe vpa api-vpa -n production

# Output includes:
#   Recommendation:
#     Container Recommendations:
#       Container Name:  api
#       Lower Bound:
#         Cpu:     25m
#         Memory:  262144k
#       Target:
#         Cpu:     587m
#         Memory:  786432k
#       Uncapped Target:
#         Cpu:     587m
#         Memory:  786432k
#       Upper Bound:
#         Cpu:     4
#         Memory:  8Gi
```

Use `Off` mode initially to collect recommendations without disrupting production:

```bash
# Query VPA recommendations programmatically
kubectl get vpa -n production -o json | jq '
  .items[] |
  {
    name: .metadata.name,
    containers: [
      .status.recommendation.containerRecommendations[]? |
      {
        container: .containerName,
        target_cpu: .target.cpu,
        target_memory: .target.memory
      }
    ]
  }
'
```

### VPA Admission Controller

The VPA admission controller mutates pod specs at creation time. Verify it is running:

```bash
kubectl get pods -n kube-system -l app=vpa-admission-controller
kubectl describe mutatingwebhookconfiguration vpa-webhook-config
```

If the webhook is down, pods are created with their original requests (fail-open behavior).

## KEDA: Kubernetes Event-Driven Autoscaling

KEDA extends HPA to support arbitrary event sources: Kafka consumer lag, Redis list length, Azure Service Bus queue depth, AWS SQS queue size, and Prometheus queries.

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true
```

KEDA installs its own metrics server, replacing the need for Prometheus Adapter for event-driven use cases.

### ScaledObject: Core KEDA Resource

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: kafka-consumer
  pollingInterval: 15
  cooldownPeriod: 300
  minReplicaCount: 0    # Scale to zero when idle
  maxReplicaCount: 50
  fallback:
    failureThreshold: 3
    replicas: 5         # Fallback replica count on scaler failure
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
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka.svc.cluster.local:9092
        consumerGroup: payment-processor
        topic: payment-events
        lagThreshold: "100"        # Scale when lag exceeds 100 messages per replica
        activationLagThreshold: "5" # Minimum lag to activate (from zero)
```

### KEDA Prometheus Scaler

The Prometheus scaler is the most versatile KEDA trigger, allowing any Prometheus query to drive scaling:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: queue-depth-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: worker
  minReplicaCount: 1
  maxReplicaCount: 100
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        metricName: rabbitmq_queue_messages
        threshold: "50"
        activationThreshold: "10"
        query: |
          max(rabbitmq_queue_messages{
            namespace="production",
            queue=~"work-.*"
          })
        # Only scale during business hours
      authenticationRef:
        name: prometheus-trigger-auth
---
# TriggerAuthentication for Prometheus with mTLS
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: prometheus-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: cert
      name: prometheus-client-cert
      key: tls.crt
    - parameter: key
      name: prometheus-client-cert
      key: tls.key
    - parameter: ca
      name: prometheus-ca
      key: ca.crt
```

### Cron-Based Scaling

Pre-scale before predictable load events:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: batch-job-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: batch-processor
  minReplicaCount: 1
  maxReplicaCount: 20
  triggers:
    # Pre-scale before end-of-day batch jobs
    - type: cron
      metadata:
        timezone: "America/New_York"
        start: "55 17 * * 1-5"  # 5:55 PM weekdays
        end: "30 20 * * 1-5"    # 8:30 PM weekdays
        desiredReplicas: "15"
    # Also scale on actual queue depth
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        metricName: batch_queue_depth
        threshold: "200"
        query: 'sum(batch_jobs_pending{namespace="production"})'
```

### AWS SQS Scaler

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-worker
  minReplicaCount: 0
  maxReplicaCount: 30
  triggers:
    - type: aws-sqs-queue
      authenticationRef:
        name: aws-sqs-auth
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/work-queue
        queueLength: "10"
        awsRegion: us-east-1
        activationTargetValue: "1"
        scaleOnFlight: "true"  # Include in-flight messages in calculation
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-sqs-auth
  namespace: production
spec:
  podIdentity:
    provider: aws
    # Uses IRSA - no credentials in the manifest
```

### ScaledJob: One-to-One Message Processing

For scenarios where each message should be processed by a dedicated Job:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processor
  namespace: production
spec:
  jobTargetRef:
    template:
      spec:
        containers:
          - name: processor
            image: company/image-processor:1.0.0
            resources:
              requests:
                cpu: 500m
                memory: 1Gi
              limits:
                cpu: 2000m
                memory: 4Gi
        restartPolicy: Never
  pollingInterval: 10
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10
  maxReplicaCount: 100
  triggers:
    - type: aws-sqs-queue
      authenticationRef:
        name: aws-sqs-auth
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/image-queue
        queueLength: "1"
        awsRegion: us-east-1
```

## Hybrid Scaling: VPA + KEDA

The recommended production hybrid combines:
- **VPA in Recommendation mode** for right-sizing CPU and memory requests
- **KEDA** for replica scaling based on queue depth or custom metrics

This avoids the VPA/HPA conflict while benefiting from both:

```yaml
# VPA in Off mode - recommendations only, no auto-application
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: worker-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-worker
  updatePolicy:
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: worker
        controlledResources:
          - cpu
          - memory
        controlledValues: RequestsAndLimits
---
# KEDA handles replica scaling
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-worker
  minReplicaCount: 0
  maxReplicaCount: 50
  triggers:
    - type: aws-sqs-queue
      authenticationRef:
        name: aws-sqs-auth
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/work-queue
        queueLength: "10"
        awsRegion: us-east-1
```

Apply VPA recommendations periodically via a script that reads recommendations and applies them to the Deployment:

```bash
#!/bin/bash
# apply-vpa-recommendations.sh
# Apply VPA recommendations to Deployment manifests during maintenance windows

NAMESPACE="production"
DEPLOYMENT="sqs-worker"
VPA_NAME="worker-vpa"

# Get current recommendations
CPU_TARGET=$(kubectl get vpa "$VPA_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.recommendation.containerRecommendations[0].target.cpu}')
MEMORY_TARGET=$(kubectl get vpa "$VPA_NAME" -n "$NAMESPACE" \
  -o jsonpath='{.status.recommendation.containerRecommendations[0].target.memory}')

echo "VPA recommends: CPU=$CPU_TARGET Memory=$MEMORY_TARGET"

# Apply as patch (triggers rolling update during low-traffic window)
kubectl patch deployment "$DEPLOYMENT" -n "$NAMESPACE" \
  --type=json \
  -p="[
    {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/resources/requests/cpu\",\"value\":\"$CPU_TARGET\"},
    {\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/resources/requests/memory\",\"value\":\"$MEMORY_TARGET\"}
  ]"

echo "Applied recommendations to deployment $DEPLOYMENT"
```

## Comparing Scaling Approaches

| Feature | HPA v2 | VPA | KEDA |
|---|---|---|---|
| Scales replicas | Yes | No | Yes |
| Adjusts resources | No | Yes | No |
| Scale to zero | No | No | Yes |
| CPU-based scaling | Yes | Recommends | Via Prometheus |
| Custom metrics | Yes (adapter needed) | No | Yes (native) |
| Event-driven | No | No | Yes |
| Disruption on scale | Minimal (new pods) | Pod restart required | Minimal (new pods) |
| Suitable for stateful | Limited | Yes | Limited |
| Conflict risk | With VPA (CPU) | With HPA (CPU) | Low (replaces HPA) |

## Monitoring All Three

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: autoscaling-alerts
  namespace: monitoring
spec:
  groups:
    - name: autoscaling
      rules:
        # HPA at maximum replicas
        - alert: HPAAtMaxReplicas
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas /
            kube_horizontalpodautoscaler_spec_max_replicas >= 0.95
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at 95% of max replicas"

        # HPA cannot scale (no metrics available)
        - alert: HPAScalingDisabled
          expr: |
            kube_horizontalpodautoscaler_status_condition{
              condition="ScalingActive",
              status="False"
            } == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} has scaling disabled"

        # KEDA scaler error
        - alert: KEDAScalerError
          expr: keda_scaler_errors_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA scaler {{ $labels.scaler }} is reporting errors"
```

## Summary

The right autoscaling strategy depends on workload characteristics. For HTTP APIs with CPU-proportional load: HPA v2 with CPU target utilization is the baseline. For message-processing workers with variable queue depth: KEDA with queue-length triggers and scale-to-zero capability. For right-sizing overprovisioned deployments: VPA in Off or Initial mode without conflicting HPA on CPU.

The production-optimal hybrid for most workloads is VPA in Off mode (for recommendation data) combined with KEDA for replica management. This provides the right-sizing intelligence of VPA without the pod restart disruptions, combined with the event-driven scaling precision of KEDA.

Never run HPA and VPA both managing CPU on the same deployment. If VPA is in Recreate or Auto mode, it will fight the HPA. The safest combination when both must run is VPA managing only memory (`controlledResources: [memory]`) while HPA manages CPU-based scaling.
