---
title: "Kubernetes HPA with Custom Metrics and KEDA: Advanced Autoscaling Patterns"
date: 2027-08-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "KEDA", "Autoscaling"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Kubernetes autoscaling patterns covering HPA v2 with custom and external metrics, KEDA ScaledObject configuration, Kafka consumer lag scaling, Prometheus-driven scaling, SQS queue depth triggers, and safe HPA/VPA coexistence."
more_link: "yes"
url: "/kubernetes-hpa-custom-metrics-keda-guide/"
---

Horizontal Pod Autoscaler in its v2 form goes well beyond CPU and memory thresholds. Combined with KEDA, teams can scale workloads on virtually any signal — Kafka consumer lag, SQS queue depth, Prometheus query results, or custom application metrics — turning autoscaling from a blunt instrument into a precision operations tool that matches capacity to demand without manual intervention.

<!--more-->

## HPA v2 Architecture and Custom Metrics Pipeline

### Metrics API Hierarchy

HPA v2 sources metrics through three distinct APIs:

| API Group | Purpose | Adapter Required |
|-----------|---------|-----------------|
| `metrics.k8s.io` | CPU and memory | metrics-server |
| `custom.metrics.k8s.io` | Pod or object metrics | Prometheus Adapter / KEDA |
| `external.metrics.k8s.io` | External system metrics | KEDA / Custom Adapter |

The HPA controller queries these APIs every `--horizontal-pod-autoscaler-sync-period` (default 15 seconds) and computes desired replicas as:

```
desiredReplicas = ceil(currentReplicas * (currentMetricValue / desiredMetricValue))
```

### Installing Prometheus Adapter for Custom Metrics

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --set prometheus.url=http://prometheus-operated.monitoring.svc.cluster.local \
  --set prometheus.port=9090
```

Custom rules in `values.yaml` expose application metrics to the HPA:

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

    - seriesQuery: 'queue_depth{namespace!="",deployment!=""}'
      resources:
        overrides:
          namespace:
            resource: namespace
          deployment:
            resource: deployment
      name:
        matches: "queue_depth"
        as: "queue_depth"
      metricsQuery: 'avg(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

Apply the updated adapter configuration:

```bash
helm upgrade prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  -f prometheus-adapter-values.yaml
```

Verify metric availability:

```bash
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq '.resources[].name'
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" | jq .
```

### HPA v2 with Multiple Metric Sources

```yaml
# hpa-multi-metric.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 3
  maxReplicas: 50
  metrics:
    # Resource metric: CPU
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60

    # Resource metric: Memory
    - type: Resource
      resource:
        name: memory
        target:
          type: AverageValue
          averageValue: 512Mi

    # Custom metric: requests per second per pod
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"

    # External metric: SQS queue depth (via KEDA or custom adapter)
    - type: External
      external:
        metric:
          name: sqs_queue_depth
          selector:
            matchLabels:
              queue: "order-processing"
        target:
          type: AverageValue
          averageValue: "30"

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
          value: 20
          periodSeconds: 120
      selectPolicy: Min
```

The `behavior` block is critical for production stability. The scale-down stabilization window of 300 seconds prevents thrashing during traffic fluctuations, while the scale-up policy allows doubling replicas or adding 10 pods per minute — whichever is larger.

## KEDA: Event-Driven Autoscaling

### Architecture and Installation

KEDA runs as a set of controllers alongside the metrics server. It implements the `external.metrics.k8s.io` API, bridging event sources to the HPA.

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set watchNamespace="" \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=128Mi \
  --set resources.operator.limits.cpu=500m \
  --set resources.operator.limits.memory=512Mi \
  --set resources.metricServer.requests.cpu=100m \
  --set resources.metricServer.requests.memory=128Mi
```

Verify installation:

```bash
kubectl get pods -n keda
kubectl get crd | grep keda
```

Expected CRDs:
- `scaledobjects.keda.sh`
- `scaledjobs.keda.sh`
- `triggerauthentications.keda.sh`
- `clustertriggerauthentications.keda.sh`

### Kafka Consumer Lag Scaling

Scaling on Kafka consumer group lag is one of the most impactful autoscaling patterns for event-driven architectures. When lag grows, KEDA adds consumers; as lag drains, it scales back.

First, create a `TriggerAuthentication` for Kafka credentials:

```yaml
# kafka-trigger-auth.yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-credentials
  namespace: production
type: Opaque
stringData:
  sasl-username: "KAFKA_USERNAME_REPLACE_ME"
  sasl-password: "KAFKA_PASSWORD_REPLACE_ME"
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-credentials
      key: sasl-username
    - parameter: password
      name: kafka-credentials
      key: sasl-password
```

Create the ScaledObject:

```yaml
# kafka-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: order-processor
    apiVersion: apps/v1
    kind: Deployment
  pollingInterval: 15       # Check every 15 seconds
  cooldownPeriod: 300       # Wait 300s before scaling to zero
  minReplicaCount: 2        # Never go below 2 (keep warm)
  maxReplicaCount: 100      # Hard ceiling
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 180
          policies:
            - type: Percent
              value: 25
              periodSeconds: 60
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: "kafka-0.kafka-headless.kafka.svc.cluster.local:9092,kafka-1.kafka-headless.kafka.svc.cluster.local:9092"
        consumerGroup: "order-processor-group"
        topic: "orders"
        lagThreshold: "50"        # Target: 50 messages lag per replica
        offsetResetPolicy: "latest"
        sasl: "plaintext"
        tls: "disable"
      authenticationRef:
        name: kafka-trigger-auth
```

The `lagThreshold` of 50 means KEDA targets 50 messages of lag per replica. With 500 messages of lag, the workload scales to 10 replicas.

### Prometheus Metrics Scaling with KEDA

KEDA's Prometheus scaler eliminates the need for a custom adapter when scaling on Prometheus data:

```yaml
# prometheus-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: payment-service-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: payment-service
  minReplicaCount: 2
  maxReplicaCount: 30
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: payment_queue_active_jobs
        threshold: "10"
        query: sum(payment_queue_active_jobs{namespace="production",service="payment-service"})
        namespace: production

    - type: prometheus
      metadata:
        serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
        metricName: p99_latency_ms
        threshold: "500"
        query: histogram_quantile(0.99, sum(rate(http_request_duration_ms_bucket{service="payment-service"}[5m])) by (le))
        namespace: production
```

Multiple triggers use `OR` logic by default — scaling occurs when any trigger fires. For `AND` logic (all conditions must be met), use composite scalers or custom Prometheus queries.

### SQS Queue Depth Scaling

For SQS scaling, provide AWS credentials via `TriggerAuthentication`:

```yaml
# sqs-trigger-auth.yaml
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
  namespace: production
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME"
  AWS_SECRET_ACCESS_KEY: "EXAMPLE_AWS_SECRET_KEY_REPLACE_ME"
  AWS_DEFAULT_REGION: "us-east-1"
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: awsAccessKeyID
      name: aws-credentials
      key: AWS_ACCESS_KEY_ID
    - parameter: awsSecretAccessKey
      name: aws-credentials
      key: AWS_SECRET_ACCESS_KEY
    - parameter: awsRegion
      name: aws-credentials
      key: AWS_DEFAULT_REGION
```

Production environments should prefer IRSA (IAM Roles for Service Accounts) over static credentials. With IRSA, the `TriggerAuthentication` uses pod identity:

```yaml
# sqs-trigger-auth-irsa.yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-trigger-auth-irsa
  namespace: production
spec:
  podIdentity:
    provider: aws-eks
```

The ScaledObject for SQS:

```yaml
# sqs-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: email-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: email-worker
  minReplicaCount: 0       # Scale to zero when queue is empty
  maxReplicaCount: 50
  cooldownPeriod: 600      # Wait 10 minutes before scaling to zero
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/email-processing-queue
        queueLength: "20"           # Target: 20 messages per replica
        awsRegion: "us-east-1"
        scaleOnInFlight: "true"     # Include in-flight messages in calculation
        scaleOnDelayed: "false"
      authenticationRef:
        name: aws-trigger-auth-irsa
```

Setting `minReplicaCount: 0` enables scale-to-zero, eliminating costs during idle periods. The `cooldownPeriod` prevents premature scale-down after the queue drains.

### ScaledJob for Batch Workloads

For one-off batch jobs rather than long-running deployments, use `ScaledJob`:

```yaml
# scaled-job-sqs.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: report-generator
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 3
    template:
      spec:
        containers:
          - name: report-generator
            image: report-generator:1.0.0
            env:
              - name: QUEUE_URL
                value: "https://sqs.us-east-1.amazonaws.com/123456789012/report-queue"
        restartPolicy: Never
  pollingInterval: 10
  maxReplicaCount: 20
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 3
  scalingStrategy:
    strategy: "accurate"       # Creates one job per queue message
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "0.5"
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/report-queue
        queueLength: "1"
        awsRegion: "us-east-1"
      authenticationRef:
        name: aws-trigger-auth-irsa
```

## HPA and VPA Coexistence

### The Conflict Problem

HPA and VPA both modify pod resource requests when operating on the same metric. Simultaneous CPU-based scaling creates a race condition: VPA increases CPU requests (triggering node pressure and pod evictions), while HPA decreases replicas because per-pod CPU utilization appears lower.

### Safe Coexistence Patterns

**Pattern 1: Separate Metric Domains**

Configure VPA to manage memory only, and HPA to manage CPU:

```yaml
# vpa-memory-only.yaml
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
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: api-server
        controlledResources:
          - memory          # VPA controls memory ONLY
        minAllowed:
          memory: 256Mi
        maxAllowed:
          memory: 4Gi
```

```yaml
# hpa-cpu-only.yaml
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
  maxReplicas: 30
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    # Custom metrics only — no memory metric
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"
```

**Pattern 2: VPA in Recommendation Mode**

Use VPA only to generate recommendations without auto-applying them. Engineers review recommendations and update Deployment resource requests during maintenance windows.

```yaml
# vpa-recommend-only.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa-recommend
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Off"    # Recommendation only — never mutates pods
```

Check recommendations:

```bash
kubectl get vpa api-server-vpa-recommend -n production -o jsonpath='{.status.recommendation}' | jq .
```

**Pattern 3: KEDA with VPA Auto Mode**

When using KEDA (event-driven triggers rather than resource metrics), VPA Auto mode is safe because KEDA does not base its scaling on the same CPU/memory values VPA is tuning:

```yaml
# vpa-with-keda.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: kafka-consumer-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor
  updatePolicy:
    updateMode: "Auto"    # Safe when KEDA drives horizontal scaling
```

## Monitoring Autoscaling Behavior

### Key Metrics to Track

```yaml
# autoscaling-alerts.yaml
groups:
  - name: autoscaling
    rules:
      - alert: HPAMaxReplicasReached
        expr: |
          kube_horizontalpodautoscaler_status_current_replicas
          == kube_horizontalpodautoscaler_spec_max_replicas
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
          description: "HPA has been at maximum replicas for 10 minutes — review maxReplicas ceiling."

      - alert: HPAScaleEventsHigh
        expr: |
          rate(keda_scaler_active[5m]) > 0.1
        for: 5m
        labels:
          severity: info
        annotations:
          summary: "High KEDA scaling activity detected"

      - alert: KEDAScalerError
        expr: keda_scaler_errors_total > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "KEDA scaler {{ $labels.scaler }} reporting errors"
```

### Inspecting HPA and KEDA State

```bash
# View HPA status including metric values
kubectl get hpa -n production
kubectl describe hpa api-server -n production

# View KEDA ScaledObject status
kubectl get scaledobject -n production
kubectl describe scaledobject order-processor-scaler -n production

# View active scalers and their metric values
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | jq '.resources[].name'

# Check KEDA operator logs for scaling decisions
kubectl logs -n keda -l app=keda-operator --tail=100 -f

# View HPA events
kubectl get events -n production --field-selector reason=SuccessfulRescale
```

### Grafana Dashboard Queries

```promql
# Current replica counts vs min/max
kube_horizontalpodautoscaler_status_current_replicas{namespace="production"}
kube_horizontalpodautoscaler_spec_min_replicas{namespace="production"}
kube_horizontalpodautoscaler_spec_max_replicas{namespace="production"}

# Scaling events rate
rate(kube_horizontalpodautoscaler_status_current_replicas[10m])

# KEDA scaler metric values
keda_scaler_metrics_value{namespace="production"}

# Kafka consumer lag (if using Kafka exporter)
sum(kafka_consumergroup_lag{consumergroup="order-processor-group"}) by (topic)
```

## Production Tuning Reference

| Parameter | Default | Recommendation | Rationale |
|-----------|---------|----------------|-----------|
| `--horizontal-pod-autoscaler-sync-period` | 15s | 15s | Acceptable for most workloads |
| `--horizontal-pod-autoscaler-downscale-stabilization` | 5m | 3–10m | Prevents thrashing |
| `--horizontal-pod-autoscaler-tolerance` | 0.1 (10%) | 0.1–0.2 | Deadband to avoid micro-scaling |
| `cooldownPeriod` (KEDA) | 300s | 120–600s | Workload-dependent |
| `pollingInterval` (KEDA) | 30s | 10–30s | Lower for latency-sensitive workloads |
| `stabilizationWindowSeconds` (scale-down) | 300s | 120–600s | Stability vs. cost trade-off |

The combination of HPA v2 custom metrics, KEDA event-driven scaling, and VPA right-sizing provides a complete autoscaling solution. Kafka lag-based scaling alone can eliminate manual capacity planning for message-driven workloads, while Prometheus-triggered scaling ensures application-level SLOs drive capacity rather than infrastructure proxies.
