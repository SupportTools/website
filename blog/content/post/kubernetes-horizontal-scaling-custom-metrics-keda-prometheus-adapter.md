---
title: "Kubernetes Horizontal Scaling with Custom Metrics: KEDA ScaledObjects and Prometheus Adapter"
date: 2030-03-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "HPA", "Custom Metrics", "Prometheus", "Auto-scaling", "Kafka", "SQS"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Scaling Kubernetes workloads on business metrics using KEDA ScaledObjects with Kafka, SQS, and Redis triggers, Prometheus Adapter for custom metrics API, and scaling test strategies for production deployments."
more_link: "yes"
url: "/kubernetes-horizontal-scaling-custom-metrics-keda-prometheus-adapter/"
---

CPU and memory utilization are lagging indicators of workload demand. By the time a payment processing service hits 80% CPU, the queue has already been backing up for seconds and user latency has degraded. Modern Kubernetes workloads require scaling based on leading indicators: queue depth, request latency, pending work items, and business-level metrics that reflect actual demand before CPU becomes the bottleneck.

Kubernetes Event-Driven Autoscaling (KEDA) and the Prometheus Adapter provide two complementary approaches to custom metric scaling. KEDA offers native connectors to over 60 event sources including Kafka, SQS, Redis, and RabbitMQ, with the ability to scale to zero. The Prometheus Adapter exposes custom Prometheus metrics through the Kubernetes metrics API, enabling the native HPA to scale on any metric that Prometheus collects.

<!--more-->

## Scaling Architecture Overview

```
Production Scaling Hierarchy:

Business Metric Scaling (KEDA)
├── Kafka consumer lag → Scale Kafka consumers
├── SQS queue depth → Scale batch processors
├── Redis list length → Scale job workers
└── HTTP request rate → Scale API servers

Prometheus-Based Scaling (HPA + Prometheus Adapter)
├── p99 latency > threshold → Scale services
├── Error rate > threshold → Scale services
└── Business KPIs → Scale specific workloads

Native Resource Scaling (HPA)
├── CPU utilization → Scale compute-bound workloads
└── Memory utilization → Scale memory-bound workloads
```

## KEDA: Kubernetes Event-Driven Autoscaling

### Installing KEDA

```bash
# Install KEDA via Helm
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.13.0 \
  --set watchNamespace="" \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=100Mi \
  --set resources.operator.limits.cpu=500m \
  --set resources.operator.limits.memory=500Mi \
  --set resources.metricServer.requests.cpu=100m \
  --set resources.metricServer.requests.memory=100Mi

# Verify installation
kubectl get pods -n keda
# NAME                                      READY   STATUS    RESTARTS   AGE
# keda-operator-5f6f8b9f7d-x8k9p           1/1     Running   0          1m
# keda-operator-metrics-apiserver-xxxx      1/1     Running   0          1m
# keda-admission-webhooks-xxxx              1/1     Running   0          1m

kubectl get crd | grep keda
# scaledjobs.keda.sh
# scaledobjects.keda.sh
# triggerauthentications.keda.sh
# clustertriggerauthentications.keda.sh
```

### KEDA ScaledObject: The Core Resource

A ScaledObject ties a deployment to one or more triggers:

```yaml
# Basic ScaledObject structure
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: my-scaler
  namespace: production
spec:
  # Target deployment to scale
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-deployment

  # Scaling boundaries
  minReplicaCount: 1    # 0 = can scale to zero (requires KEDA)
  maxReplicaCount: 50

  # Cooldown periods
  pollingInterval: 15   # seconds between metric checks
  cooldownPeriod: 300   # seconds before scaling to zero after no events

  # Advanced scaling behavior (same as HPA behavior field)
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
          - type: Percent
            value: 25
            periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
          - type: Percent
            value: 100
            periodSeconds: 15
          - type: Pods
            value: 5
            periodSeconds: 15
          selectPolicy: Max

  # One or more scaling triggers
  triggers:
  - type: <trigger-type>
    metadata:
      key: value
```

## Kafka Consumer Lag Scaling

Scaling Kafka consumers based on consumer group lag is the canonical KEDA use case:

### TriggerAuthentication for Kafka

```yaml
# Secret for Kafka SASL credentials
apiVersion: v1
kind: Secret
metadata:
  name: kafka-credentials
  namespace: production
type: Opaque
stringData:
  sasl-username: "kafka-user"
  sasl-password: "kafka-password"
---
# TriggerAuthentication references the secret
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-credentials
    key: sasl-username
  - parameter: password
    name: kafka-credentials
    key: sasl-password
```

### Kafka ScaledObject

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: production
  annotations:
    # Optional: link to Prometheus metrics for visibility
    scaledobject.keda.sh/description: "Scales payment processors based on Kafka lag"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-processor

  minReplicaCount: 2   # Never scale below 2 for HA
  maxReplicaCount: 50

  pollingInterval: 10  # Check lag every 10 seconds
  cooldownPeriod: 120  # 2 minutes cooldown before scaling down

  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0   # Scale up immediately
          policies:
          - type: Percent
            value: 100
            periodSeconds: 15
        scaleDown:
          stabilizationWindowSeconds: 300  # 5 minutes before scaling down
          policies:
          - type: Percent
            value: 10  # Scale down slowly: max 10% per minute
            periodSeconds: 60

  triggers:
  - type: kafka
    metadata:
      # Kafka connection (or use sasl/tls configuration)
      bootstrapServers: "kafka.kafka.svc.cluster.local:9092"
      consumerGroup: "payment-processors"
      topic: "payment-requests"
      # Target: 1 replica per N messages of lag
      lagThreshold: "100"
      # Activation threshold: don't scale up until lag > activationLagThreshold
      activationLagThreshold: "10"
      # Include partitions with no lag in calculation
      offsetResetPolicy: "latest"
    authenticationRef:
      name: kafka-trigger-auth
```

### Monitoring Kafka Scaling

```bash
# Watch the ScaledObject status
kubectl describe scaledobject kafka-consumer-scaler -n production
# Status:
#   Conditions:
#     - Type: Active
#       Status: "True"
#       Reason: ScalerActive
#     - Type: Ready
#       Status: "True"
#   Health:
#     payment-requests/payment-processors:
#       NumberOfFailures: 0
#       Status: Happy
#   Last Active Time: "2030-03-21T12:00:00Z"
#   Last Scale Time: "2030-03-21T12:05:00Z"
#   Original Replica Count: 2
#   Scale Target GVKR:
#     Group: apps
#     Kind: Deployment
#     Resource: deployments
#     Version: v1

# Watch replicas change in response to lag
watch kubectl get deployment payment-processor -n production

# Check current lag with kafka-consumer-groups
kubectl exec -n kafka kafka-0 -- \
  kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --group payment-processors \
    --describe
```

## AWS SQS Scaling

Scale based on SQS queue depth for serverless-style batch processing:

```yaml
# IAM credentials for SQS access (use IRSA for production)
apiVersion: v1
kind: Secret
metadata:
  name: aws-sqs-credentials
  namespace: production
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "<aws-access-key-id>"
  AWS_SECRET_ACCESS_KEY: "<aws-secret-access-key>"
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: sqs-trigger-auth
  namespace: production
spec:
  env:
  - parameter: awsAccessKeyId
    name: AWS_ACCESS_KEY_ID
    containerName: processor
  secretTargetRef:
  - parameter: awsSecretAccessKey
    name: aws-sqs-credentials
    key: AWS_SECRET_ACCESS_KEY
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-batch-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: batch-processor

  minReplicaCount: 0    # Scale to zero when queue is empty
  maxReplicaCount: 100

  pollingInterval: 30
  cooldownPeriod: 300   # 5 minutes idle before scaling to zero

  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: "https://sqs.us-east-1.amazonaws.com/123456789012/batch-jobs"
      queueLength: "10"           # Target: 1 replica per 10 messages
      activationQueueLength: "1"  # Don't start until at least 1 message
      awsRegion: "us-east-1"
      scaleOnInFlight: "true"     # Count in-flight messages too
    authenticationRef:
      name: sqs-trigger-auth
```

### IRSA (IAM Roles for Service Accounts) Configuration

For production AWS environments, use IRSA instead of credential secrets:

```yaml
# ServiceAccount with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: batch-processor
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/keda-sqs-role"
---
# ClusterTriggerAuthentication using pod identity
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: sqs-pod-identity-auth
  namespace: production
spec:
  podIdentity:
    provider: aws
---
# ScaledObject using pod identity
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-scaler-irsa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: batch-processor
  minReplicaCount: 0
  maxReplicaCount: 100
  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: "https://sqs.us-east-1.amazonaws.com/123456789012/batch-jobs"
      queueLength: "10"
      awsRegion: "us-east-1"
    authenticationRef:
      name: sqs-pod-identity-auth
```

## Redis-Based Scaling

Scale workers based on Redis list length or stream lag:

```yaml
# Redis credentials
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: password
    name: redis-credentials
    key: password
---
# Scale on Redis list length (job queue)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: redis-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: task-worker

  minReplicaCount: 0
  maxReplicaCount: 30

  pollingInterval: 5
  cooldownPeriod: 60

  triggers:
  - type: redis
    metadata:
      address: "redis-master.redis.svc.cluster.local:6379"
      listName: "task-queue"
      listLength: "5"         # Target: 1 replica per 5 items
      activationListLength: "1"
      databaseIndex: "0"
    authenticationRef:
      name: redis-auth

  # Also scale on Redis Streams lag
  - type: redis-streams
    metadata:
      address: "redis-master.redis.svc.cluster.local:6379"
      stream: "event-stream"
      consumerGroup: "processors"
      pendingEntriesCount: "10"
      databaseIndex: "0"
    authenticationRef:
      name: redis-auth
```

## Prometheus Adapter: Custom Metrics API

The Prometheus Adapter exposes Prometheus metrics through the Kubernetes custom metrics API (`custom.metrics.k8s.io`), enabling the native HPA to scale on any Prometheus metric.

### Installing Prometheus Adapter

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --create-namespace \
  --version 4.10.0 \
  -f prometheus-adapter-values.yaml
```

### Prometheus Adapter Configuration

```yaml
# prometheus-adapter-values.yaml
prometheus:
  url: http://prometheus-operated.monitoring.svc.cluster.local
  port: 9090
  path: ""

replicas: 2

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 256Mi

rules:
  default: false  # Disable default rules, define custom ones

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
      matches: "^(.*)_total$"
      as: "${1}_per_second"
    metricsQuery: |
      sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)

  # p99 request latency per deployment
  - seriesQuery: 'http_request_duration_seconds_bucket{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace:
          resource: namespace
        pod:
          resource: pod
    name:
      matches: "http_request_duration_seconds_bucket"
      as: "http_request_latency_p99"
    metricsQuery: |
      histogram_quantile(0.99,
        sum(rate(<<.Series>>{<<.LabelMatchers>>}[5m])) by (le, <<.GroupBy>>)
      )

  # Queue depth as a pod metric
  - seriesQuery: 'app_queue_depth{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace:
          resource: namespace
        pod:
          resource: pod
    name:
      matches: "app_queue_depth"
      as: "queue_depth_per_pod"
    metricsQuery: |
      sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)

  # Error rate
  - seriesQuery: 'http_requests_errors_total{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace:
          resource: namespace
        pod:
          resource: pod
    name:
      matches: "^(.*)_total$"
      as: "${1}_rate"
    metricsQuery: |
      sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)

  external:
  # External metrics: not tied to a specific pod/namespace
  # Useful for scaling on cluster-wide or cross-namespace metrics
  - seriesQuery: 'aws_sqs_approximate_number_of_messages_visible'
    resources:
      template: "<<.Resource>>"
    name:
      matches: "aws_sqs_approximate_number_of_messages_visible"
      as: "sqs_queue_depth"
    metricsQuery: 'avg(<<.Series>>{<<.LabelMatchers>>})'
```

### HPA with Custom Metrics

```yaml
# Scale on request rate using Prometheus Adapter
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

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 25
        periodSeconds: 60

  metrics:
  # CPU (native metric, always useful as a backstop)
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  # Request rate per pod (Prometheus Adapter custom metric)
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: 1000  # Target: 1000 req/s per pod

  # p99 latency (Prometheus Adapter custom metric)
  # Scale up when p99 latency exceeds 200ms
  - type: Pods
    pods:
      metric:
        name: http_request_latency_p99
      target:
        type: AverageValue
        averageValue: "200m"  # 200 milliseconds

---
# Scale on external metrics (SQS, Kafka depth visible in Prometheus)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: processor-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: message-processor

  minReplicas: 1
  maxReplicas: 50

  metrics:
  - type: External
    external:
      metric:
        name: sqs_queue_depth
        selector:
          matchLabels:
            queue_name: "processor-queue"
      target:
        type: AverageValue
        averageValue: 100  # 1 replica per 100 messages
```

### Verifying Custom Metrics

```bash
# Check available custom metrics
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq .

# Check metric value for specific pods
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second" | \
  jq '.items[] | {pod: .describedObject.name, value: .value}'

# Check external metrics
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | jq .

kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/sqs_queue_depth" | \
  jq .

# Describe HPA to see metric values and conditions
kubectl describe hpa api-server-hpa -n production
# Name:                                              api-server-hpa
# Namespace:                                         production
# ...
# Current Metrics:
#   resource cpu on pods (as a percentage of request): 45% (450m) / 70%
#   pods metric http_requests_per_second:              892 / 1k
#   pods metric http_request_latency_p99:              145m / 200m
# Conditions:
#   Type            Status  Reason            Message
#   ----            ------  ------            -------
#   AbleToScale     True    ReadyForNewScale  recommended size matches current size
#   ScalingActive   True    ValidMetricFound  the HPA was able to successfully calculate a replica count
#   ScalingLimited  False   DesiredWithinRange the desired count is within the acceptable range
```

## Scaling Test Strategies

Testing autoscaling behavior before production is critical. A scaling regression (scaling too slowly during a traffic spike) can cause an outage.

### Load Generation for Scale Testing

```yaml
# k6 load test for scaling validation
apiVersion: batch/v1
kind: Job
metadata:
  name: scaling-load-test
  namespace: production
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: k6
        image: grafana/k6:0.49.0
        command:
        - k6
        - run
        - --vus=100
        - --duration=5m
        - /scripts/scaling-test.js
        volumeMounts:
        - name: scripts
          mountPath: /scripts
      volumes:
      - name: scripts
        configMap:
          name: k6-scaling-scripts
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: k6-scaling-scripts
  namespace: production
data:
  scaling-test.js: |
    import http from 'k6/http';
    import { sleep, check } from 'k6';

    // Ramp up: simulate a traffic surge
    export const options = {
      stages: [
        { duration: '30s', target: 10 },   // Baseline
        { duration: '1m', target: 200 },   // Ramp up: should trigger scale-out
        { duration: '2m', target: 200 },   // Sustained load
        { duration: '1m', target: 10 },    // Ramp down: should trigger scale-in
        { duration: '30s', target: 0 },    // Zero
      ],
      thresholds: {
        http_req_duration: ['p99<500'],    // 99th percentile < 500ms
        http_req_failed: ['rate<0.01'],    // Error rate < 1%
      },
    };

    export default function() {
      const res = http.get('http://api-server.production.svc.cluster.local/api/v1/health');
      check(res, {
        'status 200': (r) => r.status === 200,
        'response time < 200ms': (r) => r.timings.duration < 200,
      });
      sleep(0.01);  // 10ms between requests per VU
    }
```

### Scaling Validation Script

```bash
#!/bin/bash
# scripts/validate-scaling.sh
# Validates that autoscaling responds correctly to load

set -euo pipefail

NAMESPACE="${NAMESPACE:-production}"
DEPLOYMENT="${DEPLOYMENT:-api-server}"
HPA_NAME="${HPA_NAME:-api-server-hpa}"
MIN_REPLICAS="${MIN_REPLICAS:-3}"
MAX_EXPECTED_REPLICAS="${MAX_EXPECTED_REPLICAS:-50}"
SCALE_UP_TIMEOUT="${SCALE_UP_TIMEOUT:-300}"  # 5 minutes
SCALE_DOWN_TIMEOUT="${SCALE_DOWN_TIMEOUT:-600}"  # 10 minutes

echo "=== Autoscaling Validation ==="
echo "Deployment: $NAMESPACE/$DEPLOYMENT"
echo "HPA: $HPA_NAME"

# Capture initial state
INITIAL_REPLICAS=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}')
echo "Initial replicas: $INITIAL_REPLICAS"

# Function to wait for replica count change
wait_for_replicas() {
    local expected_op="$1"  # "greater" or "less"
    local threshold="$2"
    local timeout="$3"
    local start_time=$(date +%s)

    echo "Waiting for replicas to go $expected_op than $threshold (timeout: ${timeout}s)..."

    while true; do
        current=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" \
          -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")

        elapsed=$(( $(date +%s) - start_time ))

        if [[ "$expected_op" == "greater" ]] && [[ "$current" -gt "$threshold" ]]; then
            echo "SUCCESS: Scaled up to $current replicas in ${elapsed}s"
            return 0
        elif [[ "$expected_op" == "less" ]] && [[ "$current" -lt "$threshold" ]]; then
            echo "SUCCESS: Scaled down to $current replicas in ${elapsed}s"
            return 0
        fi

        if [[ "$elapsed" -gt "$timeout" ]]; then
            echo "FAILURE: Timeout waiting for scale $expected_op $threshold. Current: $current"
            kubectl describe hpa "$HPA_NAME" -n "$NAMESPACE"
            return 1
        fi

        echo "  Current replicas: $current (elapsed: ${elapsed}s)"
        sleep 15
    done
}

# Phase 1: Verify scale-up
echo ""
echo "--- Phase 1: Load Test (Scale-Up) ---"
# Start load in background
kubectl run load-generator \
  --image=busybox:1.36 \
  -n "$NAMESPACE" \
  --restart=Never \
  -- sh -c "while true; do wget -q -O- http://api-server/api/v1/health; done" &

# Wait for scale-up
if ! wait_for_replicas "greater" "$INITIAL_REPLICAS" "$SCALE_UP_TIMEOUT"; then
    echo "FAIL: Autoscaling did not scale up"
    kubectl delete pod load-generator -n "$NAMESPACE" --ignore-not-found
    exit 1
fi

# Record max replicas
MAX_REPLICAS=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}')
echo "Peaked at $MAX_REPLICAS replicas"

if [[ "$MAX_REPLICAS" -gt "$MAX_EXPECTED_REPLICAS" ]]; then
    echo "WARNING: Scaled beyond expected maximum ($MAX_EXPECTED_REPLICAS)"
fi

# Phase 2: Verify scale-down
echo ""
echo "--- Phase 2: Stop Load (Scale-Down) ---"
kubectl delete pod load-generator -n "$NAMESPACE" --ignore-not-found

if ! wait_for_replicas "less" "$((MAX_REPLICAS - 1))" "$SCALE_DOWN_TIMEOUT"; then
    echo "FAIL: Autoscaling did not scale down"
    exit 1
fi

FINAL_REPLICAS=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}')
echo "Final replicas: $FINAL_REPLICAS (expected: ~$MIN_REPLICAS)"

echo ""
echo "=== Validation PASSED ==="
echo "Scale-up: $INITIAL_REPLICAS -> $MAX_REPLICAS"
echo "Scale-down: $MAX_REPLICAS -> $FINAL_REPLICAS"
```

## KEDA Scaling to Zero

KEDA's ability to scale to zero is a key differentiator. When there are no events, the deployment scales to zero Pods, consuming no resources:

```yaml
# Scale-to-zero configuration with KEDA
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: batch-processor-zero-scale
  namespace: batch
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: batch-processor

  minReplicaCount: 0    # KEDA supports 0, native HPA minimum is 1
  maxReplicaCount: 50

  # IMPORTANT: cooldownPeriod controls how long to wait before scaling to zero
  # after the last event. Set based on processing time expectations.
  cooldownPeriod: 300   # 5 minutes

  # paused: true would pause scaling (maintenance mode)
  # paused: false

  triggers:
  - type: kafka
    metadata:
      bootstrapServers: "kafka.kafka.svc.cluster.local:9092"
      consumerGroup: "batch-processors"
      topic: "batch-jobs"
      lagThreshold: "1"
      activationLagThreshold: "0"
```

```bash
# Monitor scale-to-zero behavior
kubectl get deployment batch-processor -n batch -w
# NAME              READY   UP-TO-DATE   AVAILABLE   AGE
# batch-processor   2/2     2            2           5m    <- Processing messages
# batch-processor   0/0     0            0           10m   <- Scaled to zero

# Check KEDA metrics for scale-to-zero
kubectl get scaledobject batch-processor-zero-scale -n batch
# NAME                           SCALETARGETKIND      SCALETARGETNAME  MIN   MAX   TRIGGERS   ACTIVE   READY   AGE
# batch-processor-zero-scale     apps/Deployments     batch-processor  0     50    kafka      false    true    1h
# ACTIVE=false means currently at zero replicas
```

## Prometheus Alerting for Scaling Issues

```yaml
# monitoring/rules/scaling-alerts.yaml
groups:
- name: autoscaling
  rules:
  # Alert when HPA cannot scale due to missing metrics
  - alert: HPAMissingMetrics
    expr: |
      kube_horizontalpodautoscaler_status_condition{
        condition="ScalingActive",
        status="false"
      } == 1
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} has missing metrics"
      description: "The HPA cannot scale because metrics are unavailable. Check Prometheus Adapter and metric sources."

  # Alert when HPA is at max replicas for extended period (capacity concern)
  - alert: HPAAtMaxReplicas
    expr: |
      kube_horizontalpodautoscaler_status_current_replicas
      ==
      kube_horizontalpodautoscaler_spec_max_replicas
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
      description: "The HPA has been at maximum replicas for 15 minutes. Consider increasing maxReplicas."

  # Alert when KEDA ScaledObject is not ready
  - alert: KEDAScaledObjectNotReady
    expr: |
      keda_scaler_active == 0
      and
      keda_scaler_errors_total > 0
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "KEDA ScaledObject {{ $labels.scaledObject }} has errors"
      description: "KEDA ScaledObject {{ $labels.namespace }}/{{ $labels.scaledObject }} is reporting errors for scaler {{ $labels.scaler }}."
```

## Key Takeaways

Event-driven and custom metric scaling transforms Kubernetes workloads from CPU-follower to demand-leader:

**KEDA is the right choice for event source scaling**: When your scale driver is an external event source (Kafka lag, SQS depth, Redis queue length), KEDA provides native connectors with proper activation thresholds, cooldown management, and scale-to-zero capability that the native HPA cannot match.

**Prometheus Adapter enables business metric scaling**: For HTTP services where request rate, latency, or error rate should drive scaling, the Prometheus Adapter surfaces these metrics through the standard HPA API. This keeps scaling logic in Prometheus rules (which teams already understand) rather than requiring KEDA trigger expertise.

**Activation thresholds prevent premature scaling**: Both KEDA's `activationLagThreshold` and the HPA's stabilization window prevent scaling up on transient spikes. Match the threshold to your workload's realistic minimum load.

**Scale-down stabilization prevents oscillation**: Aggressive scale-down (the default) causes flapping when load is variable. A 300-second stabilization window for scale-down is a good starting point for most workloads; adjust based on observed behavior.

**Test scaling behavior explicitly**: Autoscaling is a system behavior that must be validated end-to-end. The load test + timing validation script pattern catches scaling configuration issues before production traffic exposes them.
