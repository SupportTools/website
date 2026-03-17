---
title: "Kubernetes Autoscaling Deep Dive: HPA v2, KEDA, and Predictive Scaling with Predictive HPA"
date: 2030-02-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Autoscaling", "HPA", "KEDA", "Scaling", "Prometheus", "Performance"]
categories: ["Kubernetes", "Performance", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production autoscaling combining native HPA v2 with KEDA for event-driven scaling, custom Prometheus metrics, KEDA ScaledObject patterns, predictive scaling approaches, and operational best practices."
more_link: "yes"
url: "/kubernetes-autoscaling-hpa-v2-keda-predictive-scaling/"
---

Kubernetes autoscaling has evolved far beyond simple CPU-based scaling. The HPA v2 API supports arbitrary custom and external metrics, KEDA enables event-driven scaling from dozens of sources (Kafka lag, SQS queue depth, Cron schedules), and the emerging Predictive HPA approach uses ML-based forecasting to scale ahead of demand. Combining these tools correctly requires understanding their interaction, their failure modes, and how to tune scaling behavior for production workloads.

This guide covers HPA v2 advanced configuration, KEDA ScaledObject patterns with Prometheus metrics, combining HPA and KEDA safely, predictive scaling approaches, and operational runbooks for scaling incidents.

<!--more-->

## HPA v2 Architecture

The HPA v2 (autoscaling/v2) controller:
1. Fetches current metric values from metrics-server (resource metrics) or custom-metrics API
2. Calculates desired replicas using the formula: `desiredReplicas = ceil(currentReplicas * (currentMetricValue / desiredMetricValue))`
3. Applies stabilization windows to prevent flapping
4. Respects `minReplicas`/`maxReplicas` bounds

### HPA Scaling Algorithm

```
desiredReplicas = ceil[currentReplicas × (currentMetricValue / desiredMetricValue)]

For multiple metrics: take the MAX desired replicas across all metrics
(scale up to the most demanding metric's requirement)
```

## HPA v2: CPU and Memory Scaling

### Basic CPU/Memory HPA

```yaml
# hpa-basic.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service
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
          averageUtilization: 60   # Scale at 60% CPU utilization
    - type: Resource
      resource:
        name: memory
        target:
          type: AverageValue
          averageValue: 400Mi      # Scale when average pod memory > 400Mi
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60    # Wait 60s before scaling up again
      policies:
        - type: Pods
          value: 4
          periodSeconds: 60             # Add at most 4 pods per minute
        - type: Percent
          value: 100
          periodSeconds: 60             # OR double replicas per minute
      selectPolicy: Max                 # Use the MORE aggressive policy
    scaleDown:
      stabilizationWindowSeconds: 300   # Wait 5 minutes before scaling down
      policies:
        - type: Pods
          value: 2
          periodSeconds: 120            # Remove at most 2 pods per 2 minutes
        - type: Percent
          value: 10
          periodSeconds: 120            # OR remove 10% per 2 minutes
      selectPolicy: Min                 # Use the LESS aggressive policy (safer)
```

### Advanced: Multiple Resource + Custom Metrics

```yaml
# hpa-advanced.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: payment-service
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  minReplicas: 5
  maxReplicas: 100
  metrics:
    # CPU utilization
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65

    # Custom metric: request rate per pod (from Prometheus via custom-metrics API)
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "200"    # Scale when any pod handles > 200 RPS on average

    # External metric: downstream queue depth
    - type: External
      external:
        metric:
          name: payment_queue_depth
          selector:
            matchLabels:
              service: payment-service
              region: us-east-1
        target:
          type: AverageValue
          averageValue: "100"   # Scale to keep queue depth < 100 per pod

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Percent
          value: 200             # Can triple in a single scale-up
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 600    # 10 minutes for scale-down
      policies:
        - type: Percent
          value: 20
          periodSeconds: 120
```

## Custom Metrics API with Prometheus Adapter

For HPA to consume Prometheus metrics, you need the Prometheus Adapter:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  -f adapter-values.yaml
```

```yaml
# adapter-values.yaml
prometheus:
  url: http://prometheus-operated.monitoring.svc.cluster.local
  port: 9090

rules:
  default: false  # Disable default CPU/memory rules (managed by metrics-server)
  custom:
    # RPS per pod for HPA
    - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        matches: "^http_requests_total$"
        as: "http_requests_per_second"
      metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'

    # P99 latency per pod
    - seriesQuery: 'http_request_duration_seconds_bucket{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        matches: "^http_request_duration_seconds_bucket$"
        as: "http_p99_latency_milliseconds"
      metricsQuery: >
        histogram_quantile(0.99,
          sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (le, <<.GroupBy>>)
        ) * 1000

  external:
    # SQS queue depth for external scaling
    - seriesQuery: 'aws_sqs_approximate_number_of_messages_visible_average{queue_name!=""}'
      resources:
        namespaced: false
      name:
        matches: "^aws_sqs_(.*)$"
        as: "sqs_${1}"
      metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (queue_name)'

    # Kafka consumer lag
    - seriesQuery: 'kafka_consumergroup_lag{namespace!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
      name:
        matches: "^kafka_consumergroup_lag$"
        as: "kafka_consumer_lag"
      metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (consumergroup, topic, <<.GroupBy>>)'
```

### Testing Custom Metrics

```bash
# Verify custom metrics are available
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq '.resources[].name'

# Check specific metric value
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" | \
  jq '.items[] | {pod: .describedObject.name, value: .value}'

# Check external metrics
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/kafka_consumer_lag" | \
  jq '.items[] | {metric: .metricName, value: .value}'
```

## KEDA: Event-Driven Autoscaling

KEDA extends Kubernetes with event-driven autoscaling and adds the ability to scale to/from zero — critical for batch workloads and scheduled jobs.

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.13.1 \
  --set watchNamespace="" \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true
```

### KEDA ScaledObject: Kafka Consumer Lag

```yaml
# scaledobject-kafka.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor
  pollingInterval: 15       # Check lag every 15 seconds
  cooldownPeriod: 300       # Wait 5 minutes before scaling to 0
  idleReplicaCount: 0       # Scale to 0 when no lag (saves cost)
  minReplicaCount: 1        # Minimum 1 when active
  maxReplicaCount: 50
  fallback:
    failureThreshold: 5     # After 5 consecutive failures, use fallback
    replicas: 3             # Fallback to 3 replicas if Kafka is unreachable
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      name: kafka-consumer-hpa
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
            - type: Percent
              value: 200
              periodSeconds: 60
        scaleDown:
          stabilizationWindowSeconds: 180
          policies:
            - type: Percent
              value: 25
              periodSeconds: 60
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka-brokers.kafka.svc.cluster.local:9092
        consumerGroup: order-processor-group
        topic: orders
        lagThreshold: "100"       # 1 replica per 100 messages of lag
        offsetResetPolicy: latest
        # Authentication (SASL/SCRAM)
        sasl: scram_sha256
        tls: enable
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
      name: kafka-secret
      key: sasl
    - parameter: username
      name: kafka-secret
      key: username
    - parameter: password
      name: kafka-secret
      key: password
    - parameter: tls
      name: kafka-secret
      key: tls
    - parameter: ca
      name: kafka-secret
      key: ca
```

### KEDA ScaledObject: Prometheus Metrics

```yaml
# scaledobject-prometheus.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-scaledobject-prometheus
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicaCount: 3
  maxReplicaCount: 100
  pollingInterval: 10
  cooldownPeriod: 120
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: api_active_connections
        query: |
          sum(api_active_connections{namespace="production", deployment="api-service"})
        threshold: "500"       # 1 replica per 500 active connections
        activationThreshold: "10"   # Don't scale until > 10 connections
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: api_p99_latency
        query: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              namespace="production",
              deployment="api-service"
            }[2m])) by (le)
          ) * 1000
        threshold: "500"       # Scale if P99 latency > 500ms
        activationThreshold: "100"
```

### KEDA ScaledObject: SQS Queue Depth

```yaml
# scaledobject-sqs.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-sqs-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: background-worker
  minReplicaCount: 0    # Scale to zero when queue is empty
  maxReplicaCount: 25
  pollingInterval: 30
  cooldownPeriod: 300
  triggers:
    - type: aws-sqs-queue
      authenticationRef:
        name: aws-sqs-trigger-auth
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/my-queue
        queueLength: "10"     # 1 replica per 10 messages
        awsRegion: us-east-1
        activationQueueLength: "1"
        identityOwner: operator  # Use pod's IRSA role
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-sqs-trigger-auth
  namespace: production
spec:
  podIdentity:
    provider: aws
    # Uses pod's IRSA annotation for authentication
```

### KEDA ScaledObject: Cron-Based Scaling

```yaml
# scaledobject-cron.yaml
# Pre-scale before known traffic spikes
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-cron-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicaCount: 3
  maxReplicaCount: 50
  triggers:
    # Business hours: scale up 30 minutes before opening
    - type: cron
      metadata:
        timezone: America/New_York
        start: "30 8 * * 1-5"   # 8:30 AM weekdays
        end: "0 20 * * 1-5"     # 8:00 PM weekdays
        desiredReplicas: "15"    # Pre-warm 15 replicas
    # End-of-month batch processing
    - type: cron
      metadata:
        timezone: UTC
        start: "0 0 28-31 * *"  # Last days of month
        end: "0 6 1 * *"        # 6am first day of next month
        desiredReplicas: "30"
```

## Combining HPA and KEDA

KEDA creates and manages an HPA under the hood when you use a ScaledObject. If you need both native CPU scaling AND event-driven scaling, you must be careful:

### Safe Combination Strategy

```yaml
# Strategy: Use KEDA for event-driven triggers + CPU via KEDA's externalMetrics
# DO NOT create a separate HPA for the same deployment as KEDA's ScaledObject
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: combined-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicaCount: 3
  maxReplicaCount: 100
  advanced:
    horizontalPodAutoscalerConfig:
      name: api-service-hpa    # KEDA creates this HPA
  triggers:
    # CPU trigger through KEDA (uses same HPA)
    - type: cpu
      metricType: Utilization
      metadata:
        value: "65"
    # Memory trigger
    - type: memory
      metricType: AverageValue
      metadata:
        value: "400Mi"
    # Event-driven: Kafka lag
    - type: kafka
      metadata:
        bootstrapServers: kafka:9092
        consumerGroup: api-group
        topic: api-events
        lagThreshold: "100"
    # Event-driven: Prometheus
    - type: prometheus
      metadata:
        serverAddress: http://prometheus:9090
        metricName: request_rate
        query: sum(rate(http_requests_total{deployment="api-service"}[2m]))
        threshold: "500"
```

## Predictive Scaling

True predictive scaling uses time-series forecasting to scale before demand arrives. Several approaches exist:

### Approach 1: Keda Cron + Historical Analysis

```bash
# Analyze historical HPA scaling events to identify patterns
kubectl get events --all-namespaces \
  --field-selector reason=SuccessfulRescale \
  -o json | jq -r \
  '.items[] | [.firstTimestamp, .message, .involvedObject.name] | @tsv' | \
  sort > scaling-history.tsv

# Use Python to find weekly patterns
python3 << 'EOF'
import csv
import sys
from collections import defaultdict
from datetime import datetime

hourly_scale_events = defaultdict(list)
with open('scaling-history.tsv') as f:
    for row in csv.reader(f, delimiter='\t'):
        try:
            ts = datetime.fromisoformat(row[0].replace('Z', '+00:00'))
            # Bucket by weekday+hour
            key = f"{ts.weekday()}_{ts.hour:02d}"
            hourly_scale_events[key].append(row[1])
        except:
            pass

print("High-scaling periods (weekday_hour: event_count):")
for k, v in sorted(hourly_scale_events.items(), key=lambda x: -len(x[1]))[:20]:
    day = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][int(k.split('_')[0])]
    hour = k.split('_')[1]
    print(f"  {day} {hour}:00 — {len(v)} scale events")
EOF
```

### Approach 2: Predictive HPA with Crane

```bash
# Install Crane (Tencent's predictive autoscaler)
helm repo add crane https://gocrane.io/helm-charts
helm install crane crane/crane \
  --namespace crane-system \
  --create-namespace

# Create predictive scaling policy
```

```yaml
# effective-hpa-crane.yaml
apiVersion: autoscaling.crane.io/v1alpha1
kind: EffectiveHorizontalPodAutoscaler
metadata:
  name: api-service-ehpa
  namespace: production
spec:
  # Standard HPA target
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  minReplicas: 3
  maxReplicas: 100

  # Standard HPA metrics
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60

  # Predictive scaling: forecast-based pre-scaling
  prediction:
    predictionWindowSeconds: 3600    # Look 1 hour ahead
    predictionAlgorithm:
      algorithmType: DSP             # DSP (Digital Signal Processing) for periodic patterns
      dsp:
        sampleInterval: "60s"
        historyLength: "7d"          # Use 7 days of history
        estimators:
          fft:
            maxNumOfSpectrumItems: 20
            minNumOfSpectrumItems: 3

  # Scale-down protection via cron (minimum replicas during business hours)
  scaleStrategy: Auto
```

### Approach 3: VPA + HPA Hybrid

```yaml
# vpa-for-right-sizing.yaml
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
    updateMode: "Off"    # Recommendation only, no auto-update (avoid HPA conflict)
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 4
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
```

```bash
# View VPA recommendations (use to right-size HPA targets)
kubectl describe vpa api-service-vpa -n production
# Recommendation:
#   Container Recommendations:
#     Container Name:  api
#     Lower Bound:
#       Cpu:     200m
#       Memory:  256Mi
#     Target:
#       Cpu:     500m        ← Use this for requests
#       Memory:  512Mi
#     Upper Bound:
#       Cpu:     1200m
#       Memory:  1Gi
```

## KEDA ScaledJob for Batch Workloads

For batch processing jobs that should not run as persistent Deployments:

```yaml
# scaledjob-batch.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: report-generator
  namespace: production
spec:
  jobTargetRef:
    template:
      spec:
        containers:
          - name: report-generator
            image: yourorg/report-gen:latest
            resources:
              requests:
                cpu: "2"
                memory: "4Gi"
              limits:
                cpu: "4"
                memory: "8Gi"
        restartPolicy: Never
  pollingInterval: 30
  maxReplicaCount: 10
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 5
  triggers:
    - type: aws-sqs-queue
      authenticationRef:
        name: aws-sqs-trigger-auth
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/report-jobs
        queueLength: "1"      # One job per message
        awsRegion: us-east-1
  scalingStrategy:
    strategy: "default"
    customScalingQueueLengthDeduction: 1
    customScalingRunningJobPercentage: "0.5"
```

## Operational Runbooks

### Diagnosing Scaling Failures

```bash
# HPA not scaling up
kubectl describe hpa api-service -n production
# Look for: "unable to get metrics for resource" or "unknown metric"

# Check Prometheus adapter logs
kubectl logs -n monitoring deployment/prometheus-adapter --tail=50 | \
  grep -i "error\|failed\|unable"

# Check metrics server
kubectl top pods -n production
# If this fails: metrics-server is down

# KEDA not scaling
kubectl describe scaledobject kafka-consumer-scaledobject -n production
# Look for: "ErrorConfig" or "Error" in conditions

kubectl logs -n keda deployment/keda-operator --tail=100 | \
  grep -i "error\|failed"

# Check KEDA metrics
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1 | jq .
```

### Scaling Incident Response

```bash
#!/bin/bash
# scaling-incident.sh - Emergency manual scaling during incident

DEPLOYMENT=$1
NAMESPACE=${2:-production}
REPLICAS=$3

if [[ -z "$DEPLOYMENT" || -z "$REPLICAS" ]]; then
    echo "Usage: $0 <deployment> [namespace] <replicas>"
    exit 1
fi

echo "=== Scaling Incident Response ==="
echo "Deployment: $DEPLOYMENT ($NAMESPACE)"
echo "Target replicas: $REPLICAS"

# 1. Temporarily disable HPA to prevent interference
echo "Suspending HPA autoscaling..."
kubectl patch hpa $DEPLOYMENT -n $NAMESPACE \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/minReplicas", "value": '$REPLICAS'},
       {"op": "replace", "path": "/spec/maxReplicas", "value": '$REPLICAS'}]'

# 2. Scale immediately
kubectl scale deployment $DEPLOYMENT -n $NAMESPACE --replicas=$REPLICAS

# 3. Wait for rollout
kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE --timeout=120s

# 4. Verify
echo "Current state:"
kubectl get pods -n $NAMESPACE -l app=$DEPLOYMENT --field-selector=status.phase=Running | \
  wc -l | xargs echo "Running pods:"

echo ""
echo "IMPORTANT: HPA min/max have been set to $REPLICAS."
echo "Run this after incident is resolved:"
echo "  kubectl patch hpa $DEPLOYMENT -n $NAMESPACE --type='json' \\"
echo "    -p='[{\"op\": \"replace\", \"path\": \"/spec/minReplicas\", \"value\": 3},"
echo "         {\"op\": \"replace\", \"path\": \"/spec/maxReplicas\", \"value\": 100}]'"
```

## Prometheus Alerts for Scaling Issues

```yaml
# prometheus-rules-autoscaling.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: autoscaling-alerts
  namespace: monitoring
spec:
  groups:
    - name: autoscaling
      rules:
        - alert: HPAAtMaxReplicas
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas
            == on(namespace, horizontalpodautoscaler)
            kube_horizontalpodautoscaler_spec_max_replicas
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} is at max replicas"
            description: "Consider increasing maxReplicas or addressing the root cause of scaling pressure."

        - alert: HPAScalingThrottled
          expr: |
            (kube_horizontalpodautoscaler_status_desired_replicas
             > kube_horizontalpodautoscaler_status_current_replicas)
            and
            (kube_horizontalpodautoscaler_status_current_replicas
             == kube_horizontalpodautoscaler_spec_max_replicas)
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} wants more replicas but is capped"

        - alert: HPAMetricsUnavailable
          expr: |
            kube_horizontalpodautoscaler_status_condition{condition="ScalingActive",status="false"} == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} cannot scale (metrics unavailable)"

        - alert: KEDAScaledObjectError
          expr: |
            keda_scaledobject_errors_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA ScaledObject {{ $labels.namespace }}/{{ $labels.scaledObject }} has errors"
```

## Key Takeaways

Production Kubernetes autoscaling requires layering multiple mechanisms correctly:

1. **HPA behavior tuning prevents flapping**: The stabilization window for scale-down (300-600s) prevents thrashing during brief traffic drops. The scale-up window should be short (30-60s) to respond quickly to traffic spikes.

2. **Prometheus adapter unlocks application-level scaling**: CPU and memory are proxies for load. RPS, queue depth, and P99 latency are direct measures. Scale on what matters to your SLOs, not just CPU.

3. **KEDA enables scale-to-zero for cost optimization**: Event-driven and batch workloads that run only when triggered can scale to 0, saving substantial cost on idle capacity. Use `idleReplicaCount: 0` and `minReplicaCount: 0` together.

4. **Never create both an HPA and a KEDA ScaledObject for the same deployment**: KEDA creates its own HPA. Having both causes conflicts. Use KEDA's cpu/memory triggers if you need both CPU and event-driven scaling.

5. **activationThreshold prevents noise**: KEDA's `activationThreshold` prevents scaling up from 0 on a single message. Set it to a meaningful minimum (e.g., 5-10) to avoid spurious scale-up events.

6. **Fallback replicas protect against metrics failures**: Configure `fallback.replicas` in ScaledObject to a safe minimum. This prevents scale-to-zero if KEDA's metric source becomes unavailable.

7. **Predictive scaling reduces cold-start latency**: For workloads with known patterns (business hours, end-of-month), pre-scaling via Cron triggers or Crane EHPA eliminates the lag between traffic arrival and scaling completion.
