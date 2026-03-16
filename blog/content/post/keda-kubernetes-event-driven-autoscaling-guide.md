---
title: "KEDA: Kubernetes Event-Driven Autoscaling for Production Workloads"
date: 2027-04-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "Event-Driven", "Kafka", "Redis"]
categories: ["Kubernetes", "Autoscaling"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying KEDA for event-driven autoscaling in Kubernetes, covering ScaledObjects, triggers for Kafka, Redis, Prometheus, SQS, and custom scaling patterns for zero-to-N workloads."
more_link: "yes"
url: "/keda-kubernetes-event-driven-autoscaling-guide/"
---

KEDA (Kubernetes Event-Driven Autoscaling) extends the native Kubernetes Horizontal Pod Autoscaler to support scaling based on event sources far beyond CPU and memory — including Kafka consumer lag, Redis Stream length, SQS queue depth, Prometheus query results, and dozens of other triggers. The ability to scale to zero and back makes KEDA especially powerful for batch processing, event-driven microservices, and cost-sensitive workloads. This guide covers KEDA architecture, ScaledObject and ScaledJob configuration, trigger authentication, production scaling patterns, and observability.

<!--more-->

## KEDA Architecture and Core Components

KEDA acts as a bridge between external event sources and the Kubernetes HPA. It deploys two primary components: a metrics adapter that exposes external metrics to the Kubernetes metrics API, and an operator that manages ScaledObject and ScaledJob lifecycle.

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        KEDA Architecture                            │
│                                                                     │
│  External Event Sources                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │  Kafka   │ │  Redis   │ │   SQS    │ │Prometheus│ │  HTTP    │ │
│  │  Topics  │ │ Streams  │ │  Queues  │ │  Queries │ │  Requests│ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       │             │             │             │             │      │
│       ▼             ▼             ▼             ▼             ▼      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                   KEDA Metrics Adapter                        │ │
│  │         (exposes /apis/external.metrics.k8s.io)               │ │
│  └────────────────────────────┬───────────────────────────────────┘ │
│                               │                                     │
│  ┌────────────────────────────▼───────────────────────────────────┐ │
│  │                   KEDA Operator                               │ │
│  │  ScaledObject → HPA → Deployment/StatefulSet/Job              │ │
│  │  ScaledJob   → Job creation for zero-to-N processing          │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Installing KEDA

```bash
# Add the KEDA Helm repository
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

# Install KEDA with production settings
helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set replicaCount=2 \
  --set operator.replicaCount=2 \
  --set metricsServer.replicaCount=2 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=128Mi \
  --set resources.operator.limits.cpu=500m \
  --set resources.operator.limits.memory=512Mi \
  --set resources.metricServer.requests.cpu=100m \
  --set resources.metricServer.requests.memory=128Mi \
  --set resources.metricServer.limits.cpu=500m \
  --set resources.metricServer.limits.memory=512Mi \
  --set podDisruptionBudget.operator.minAvailable=1 \
  --set podDisruptionBudget.metricServer.minAvailable=1 \
  --set prometheus.operator.enabled=true \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.webhooks.enabled=true \
  --wait

# Verify installation
kubectl -n keda get pods
kubectl get crd | grep keda.sh
```

```yaml
# keda-values-production.yaml
replicaCount: 2

operator:
  replicaCount: 2
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values:
                  - keda-operator
          topologyKey: kubernetes.io/hostname
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: keda-operator

metricsServer:
  replicaCount: 2
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values:
                  - keda-metrics-apiserver
          topologyKey: kubernetes.io/hostname

resources:
  operator:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  metricServer:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

prometheus:
  operator:
    enabled: true
    podMonitor:
      enabled: true
      namespace: monitoring
      interval: 30s
  metricServer:
    enabled: true
    podMonitor:
      enabled: true
      namespace: monitoring
      interval: 30s

logging:
  operator:
    level: info
    format: json
  metricServer:
    level: 0
    stacktraceLevel: 4
```

## TriggerAuthentication: Secure Credential Management

TriggerAuthentication decouples connection credentials from ScaledObject definitions, allowing secrets to be managed independently.

### Secret-Based Authentication

```yaml
# trigger-auth-kafka.yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: kafka-auth
  namespace: data-processing
type: Opaque
stringData:
  sasl-username: kafka-consumer
  sasl-password: EXAMPLE_TOKEN_REPLACE_ME
  tls-ca: |
    -----BEGIN CERTIFICATE-----
    <base64-encoded-CA-certificate>
    -----END CERTIFICATE-----
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-auth
  namespace: data-processing
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-auth
      key: sasl-username
    - parameter: password
      name: kafka-auth
      key: sasl-password
    - parameter: ca
      name: kafka-auth
      key: tls-ca
```

### Pod Identity with AWS IRSA

```yaml
# trigger-auth-aws-irsa.yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-sqs-auth
  namespace: queue-workers
spec:
  podIdentity:
    provider: aws
    identityId: "arn:aws:iam::123456789012:role/keda-sqs-scaler-role"
```

```bash
# Create IAM policy for SQS access
cat > keda-sqs-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ReceiveMessage"
      ],
      "Resource": "arn:aws:sqs:us-east-1:123456789012:my-queue"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name keda-sqs-scaler-policy \
  --policy-document file://keda-sqs-policy.json

# Associate the role with the KEDA service account (using eksctl)
eksctl create iamserviceaccount \
  --name keda-operator \
  --namespace keda \
  --cluster my-cluster \
  --attach-policy-arn arn:aws:iam::123456789012:policy/keda-sqs-scaler-policy \
  --approve
```

### ClusterTriggerAuthentication for Cross-Namespace Use

```yaml
# cluster-trigger-auth.yaml
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: prometheus-auth
spec:
  secretTargetRef:
    - parameter: bearerToken
      name: prometheus-keda-token
      key: token
      namespace: monitoring
```

## Kafka Consumer Lag Scaling

The Kafka scaler monitors consumer group lag and scales consumers to drain the lag efficiently.

```yaml
# kafka-consumer-scaledobject.yaml
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-order-processor
  namespace: data-processing
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor
  pollingInterval: 15
  cooldownPeriod: 60
  minReplicaCount: 0
  maxReplicaCount: 50
  fallback:
    failureThreshold: 3
    replicas: 5
  advanced:
    restoreToOriginalReplicaCount: false
    scalingModifiers:
      target: "30"
      activationTarget: "5"
      formula: "max(0, externalMetricValue1)"
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: order-processor-cg
        topic: orders
        lagThreshold: "30"
        activationLagThreshold: "5"
        offsetResetPolicy: latest
        allowIdleConsumers: "false"
        scaleToZeroOnInvalidOffset: "false"
        partitionLimitation: ""
        tls: enable
        sasl: scram_sha256
      authenticationRef:
        name: kafka-auth
```

### Multi-Topic Kafka Scaling

```yaml
# kafka-multi-topic-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-multi-topic-processor
  namespace: data-processing
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: multi-topic-processor
  pollingInterval: 10
  cooldownPeriod: 120
  minReplicaCount: 1
  maxReplicaCount: 100
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: multi-processor-cg
        topic: orders
        lagThreshold: "50"
        activationLagThreshold: "10"
      authenticationRef:
        name: kafka-auth
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: multi-processor-cg
        topic: payments
        lagThreshold: "25"
        activationLagThreshold: "5"
      authenticationRef:
        name: kafka-auth
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: multi-processor-cg
        topic: notifications
        lagThreshold: "100"
        activationLagThreshold: "20"
      authenticationRef:
        name: kafka-auth
```

## Redis Streams Scaling

```yaml
# redis-streams-scaledobject.yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: redis-secret
  namespace: stream-workers
type: Opaque
stringData:
  password: EXAMPLE_TOKEN_REPLACE_ME
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: stream-workers
spec:
  secretTargetRef:
    - parameter: password
      name: redis-secret
      key: password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: redis-stream-worker
  namespace: stream-workers
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: stream-worker
  pollingInterval: 5
  cooldownPeriod: 30
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
    - type: redis-streams
      metadata:
        address: redis-master.redis.svc.cluster.local:6379
        stream: events:inbound
        consumerGroup: stream-workers
        pendingEntriesCount: "10"
        activationLagCount: "1"
        enableTLS: "false"
        databaseIndex: "0"
      authenticationRef:
        name: redis-auth
```

## AWS SQS Queue Scaling

```yaml
# sqs-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-worker
  namespace: queue-workers
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-message-worker
  pollingInterval: 20
  cooldownPeriod: 300
  minReplicaCount: 0
  maxReplicaCount: 25
  fallback:
    failureThreshold: 5
    replicas: 3
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/my-work-queue
        queueLength: "5"
        awsRegion: us-east-1
        identityOwner: pod
        activationQueueLength: "1"
      authenticationRef:
        name: aws-sqs-auth
```

### SQS Dead Letter Queue Monitoring

```yaml
# sqs-dlq-alert-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: dlq-reprocessor
  namespace: queue-workers
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: dlq-reprocessor
  pollingInterval: 60
  cooldownPeriod: 600
  minReplicaCount: 0
  maxReplicaCount: 5
  triggers:
    - type: aws-sqs-queue
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/my-work-queue-dlq
        queueLength: "1"
        awsRegion: us-east-1
        identityOwner: pod
        activationQueueLength: "1"
      authenticationRef:
        name: aws-sqs-auth
```

## Prometheus Metric Scaling

The Prometheus scaler evaluates a PromQL query and scales based on the result, enabling scaling on virtually any application or infrastructure metric.

```yaml
# prometheus-scaledobject.yaml
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: prometheus-bearer
  namespace: api-services
spec:
  secretTargetRef:
    - parameter: bearerToken
      name: prometheus-keda-token
      key: token
    - parameter: ca
      name: prometheus-keda-token
      key: ca.crt
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-request-rate-scaler
  namespace: api-services
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  pollingInterval: 15
  cooldownPeriod: 60
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
    - type: prometheus
      metadata:
        serverAddress: https://prometheus.monitoring.svc.cluster.local:9090
        metricName: http_requests_per_second
        query: |
          sum(rate(http_requests_total{namespace="api-services",deployment="api-service"}[2m]))
        threshold: "100"
        activationThreshold: "10"
        namespace: api-services
      authenticationRef:
        name: prometheus-bearer
```

### CPU and Memory Combined Scaling via Prometheus

```yaml
# combined-metrics-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: combined-resource-scaler
  namespace: workloads
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: resource-intensive-app
  pollingInterval: 30
  cooldownPeriod: 120
  minReplicaCount: 2
  maxReplicaCount: 30
  advanced:
    horizontalPodAutoscalerConfig:
      name: combined-resource-scaler-hpa
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
            - type: Pods
              value: 4
              periodSeconds: 60
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Percent
              value: 25
              periodSeconds: 120
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          avg(rate(container_cpu_usage_seconds_total{
            namespace="workloads",
            pod=~"resource-intensive-app-.*",
            container="app"
          }[2m])) * 100
        threshold: "70"
        activationThreshold: "50"
        metricName: cpu_utilization_percent
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          avg(
            container_memory_working_set_bytes{
              namespace="workloads",
              pod=~"resource-intensive-app-.*",
              container="app"
            } /
            container_spec_memory_limit_bytes{
              namespace="workloads",
              pod=~"resource-intensive-app-.*",
              container="app"
            }
          ) * 100
        threshold: "80"
        activationThreshold: "60"
        metricName: memory_utilization_percent
```

## ScaledJob: Zero-to-N Batch Processing

ScaledJob creates Kubernetes Jobs rather than scaling an existing Deployment, making it ideal for batch workloads that must process discrete messages or tasks.

```yaml
# scaled-job-kafka.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: batch-processor
  namespace: batch-jobs
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 3600
    backoffLimit: 3
    template:
      metadata:
        labels:
          app: batch-processor
          job-type: kafka-consumer
      spec:
        restartPolicy: OnFailure
        serviceAccountName: batch-processor
        containers:
          - name: processor
            image: company.registry/batch-processor:v1.5.2
            command:
              - /bin/processor
              - --consume-single-batch
              - --max-messages=100
            env:
              - name: KAFKA_BROKERS
                value: kafka.kafka-system.svc.cluster.local:9092
              - name: KAFKA_TOPIC
                value: heavy-processing-jobs
              - name: KAFKA_GROUP
                value: batch-processor-job-cg
              - name: KAFKA_PASSWORD
                valueFrom:
                  secretKeyRef:
                    name: kafka-auth
                    key: sasl-password
            resources:
              requests:
                cpu: 500m
                memory: 512Mi
              limits:
                cpu: 2000m
                memory: 2Gi
        nodeSelector:
          workload-type: batch
        tolerations:
          - key: batch-workload
            operator: Equal
            value: "true"
            effect: NoSchedule
  pollingInterval: 10
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  maxReplicaCount: 30
  scalingStrategy:
    strategy: accurate        # accurate | default | eager
    pendingPodConditions:
      - "Ready"
      - "PodScheduled"
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "1.0"
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: batch-processor-job-cg
        topic: heavy-processing-jobs
        lagThreshold: "1"
        activationLagThreshold: "1"
        tls: enable
        sasl: scram_sha256
      authenticationRef:
        name: kafka-auth
```

## HTTP Request Scaling with KEDA HTTP Add-on

The KEDA HTTP add-on enables scaling HTTP-based workloads to zero.

```bash
# Install KEDA HTTP add-on
helm upgrade --install keda-add-ons-http kedacore/keda-add-ons-http \
  --namespace keda \
  --set interceptor.replicas.min=2 \
  --set interceptor.replicas.max=10 \
  --set scaler.replicas.min=2
```

```yaml
# http-scaledobject.yaml
---
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: api-gateway
  namespace: api-services
spec:
  hosts:
    - api.company.com
    - api-internal.company.com
  pathPrefixes:
    - /api/v1
    - /api/v2
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
    service: api-service
    port: 8080
  replicas:
    min: 0
    max: 30
  scaledownPeriod: 300
  scalingMetric:
    requestRate:
      granularity: 1s
      targetValue: 100
      window: 1m
  targetPendingRequests: 100
```

## Advanced Scaling Patterns

### Cron-Based Scaling with Scheduled Minimum Replicas

```yaml
# cron-scaling-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: business-hours-scaler
  namespace: services
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: customer-portal
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 8 * * 1-5"    # 08:00 EST Mon-Fri
        end: "0 20 * * 1-5"     # 20:00 EST Mon-Fri
        desiredReplicas: "10"
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 0 * * 6-7"    # 00:00 EST Sat-Sun
        end: "59 23 * * 6-7"    # 23:59 EST Sat-Sun
        desiredReplicas: "3"
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{service="customer-portal"}[2m]))
        threshold: "50"
        metricName: request_rate
```

### Scaling with External Metric Provider

```yaml
# external-metrics-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: custom-metric-scaler
  namespace: services
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: custom-processor
  pollingInterval: 15
  cooldownPeriod: 60
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
    - type: external
      metadata:
        scalerAddress: custom-scaler.keda.svc.cluster.local:8080
        queueName: custom-work-queue
        queueNamespace: services
        desiredQueueLength: "5"
        activationDesiredQueueLength: "1"
```

### Fallback Configuration

```yaml
# fallback-scaledobject.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: resilient-scaler
  namespace: services
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: resilient-service
  pollingInterval: 15
  cooldownPeriod: 60
  minReplicaCount: 2
  maxReplicaCount: 40
  fallback:
    failureThreshold: 3     # Number of consecutive failures before fallback
    replicas: 5             # Replica count to fall back to
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: resilient-service-cg
        topic: events
        lagThreshold: "20"
      authenticationRef:
        name: kafka-auth
```

## Pausing and Managing ScaledObjects

```bash
# Pause autoscaling temporarily (e.g., during maintenance)
kubectl annotate scaledobject kafka-order-processor \
  -n data-processing \
  autoscaling.keda.sh/paused="true"

# Resume autoscaling
kubectl annotate scaledobject kafka-order-processor \
  -n data-processing \
  autoscaling.keda.sh/paused-

# Pause at a specific replica count
kubectl annotate scaledobject kafka-order-processor \
  -n data-processing \
  autoscaling.keda.sh/paused-replicas="5"

# View ScaledObject status
kubectl -n data-processing describe scaledobject kafka-order-processor

# Check which HPA KEDA manages
kubectl -n data-processing get hpa
kubectl -n data-processing describe hpa keda-hpa-kafka-order-processor
```

## Monitoring KEDA with Prometheus

```yaml
# keda-prometheus-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keda-alerts
  namespace: keda
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: keda.rules
      interval: 30s
      rules:
        - alert: KEDAScaledObjectErrors
          expr: |
            keda_scaler_errors_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA scaler errors detected"
            description: "ScaledObject {{ $labels.scaledObject }} in namespace {{ $labels.namespace }} has {{ $value }} scaler errors."
        - alert: KEDAScalerMetricFetchError
          expr: |
            keda_metrics_adapter_scaler_errors_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA metrics adapter cannot fetch scaler metrics"
            description: "Scaler {{ $labels.scaler }} for ScaledObject {{ $labels.scaledObject }} is reporting fetch errors."
        - alert: KEDAScaledObjectPaused
          expr: |
            keda_scaledobject_paused == 1
          for: 30m
          labels:
            severity: info
          annotations:
            summary: "KEDA ScaledObject has been paused for extended period"
            description: "ScaledObject {{ $labels.scaledObject }} in {{ $labels.namespace }} has been paused for more than 30 minutes."
        - alert: KEDAScalingAtMaxReplicas
          expr: |
            keda_scaler_active == 1 and
            kube_horizontalpodautoscaler_status_current_replicas
              == kube_horizontalpodautoscaler_spec_max_replicas
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Deployment has reached KEDA maximum replica count"
            description: "Deployment {{ $labels.deployment }} has been at max replicas for 15 minutes. Consider increasing maxReplicaCount."
```

```yaml
# keda-grafana-dashboard-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: keda-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  keda-overview.json: |
    {
      "title": "KEDA Overview",
      "uid": "keda-overview",
      "panels": [
        {
          "title": "Active ScaledObjects",
          "type": "stat",
          "targets": [
            {
              "expr": "count(keda_scaledobject_paused == 0)",
              "legendFormat": "Active"
            }
          ]
        },
        {
          "title": "Scaler Metric Values",
          "type": "timeseries",
          "targets": [
            {
              "expr": "keda_scaler_metrics_value",
              "legendFormat": "{{scaledObject}}/{{trigger}}"
            }
          ]
        },
        {
          "title": "Scaler Errors",
          "type": "timeseries",
          "targets": [
            {
              "expr": "rate(keda_scaler_errors_total[5m])",
              "legendFormat": "{{scaledObject}}"
            }
          ]
        },
        {
          "title": "Scaling Events",
          "type": "timeseries",
          "targets": [
            {
              "expr": "rate(keda_internal_scale_loop_latency_bucket[5m])",
              "legendFormat": "{{namespace}}/{{scaledObject}}"
            }
          ]
        }
      ]
    }
```

## Troubleshooting KEDA

### Diagnosing ScaledObject Issues

```bash
# Check ScaledObject status and conditions
kubectl -n data-processing get scaledobject kafka-order-processor -o yaml | \
  yq '.status'

# Check KEDA operator logs for reconciliation errors
kubectl -n keda logs -l app=keda-operator --tail=200 | \
  grep -E "ERROR|WARN|scaledobject"

# Check metrics adapter logs for metric fetch failures
kubectl -n keda logs -l app=keda-metrics-apiserver --tail=200 | \
  grep -E "ERROR|WARN|metric"

# Manually test what metrics KEDA is seeing
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/data-processing/s0-kafka-orders" | \
  jq .

# Verify the underlying HPA state
kubectl -n data-processing get hpa keda-hpa-kafka-order-processor -o yaml | \
  yq '.status.conditions'
```

### Common Issues and Solutions

```bash
# Issue: ScaledObject stuck in "Errored" state due to missing TriggerAuthentication
# Solution: Check secret exists and TriggerAuthentication references correct key
kubectl -n data-processing get triggerauthentication kafka-auth
kubectl -n data-processing get secret kafka-auth
kubectl -n data-processing describe triggerauthentication kafka-auth

# Issue: Workload not scaling to zero (cooldown not expiring)
# Solution: Check for continuous metric activity and verify cooldownPeriod
kubectl -n keda logs -l app=keda-operator --tail=50 | \
  grep "kafka-order-processor"

# Issue: HPA "missing required field" error after KEDA upgrade
# Check KEDA and Kubernetes version compatibility
kubectl -n keda get deploy keda-operator -o jsonpath='{.spec.template.spec.containers[0].image}'
kubectl version --short

# Issue: External scaler connectivity
# Test connectivity from KEDA metrics adapter pod
kubectl -n keda exec -it deploy/keda-metrics-apiserver -- \
  curl -v kafka.kafka-system.svc.cluster.local:9092
```

## Production Best Practices

```yaml
# production-scaledobject-template.yaml
# Template with all recommended production settings
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: production-workload-scaler
  namespace: production
  annotations:
    scaledobject.keda.sh/transfer-hpa-ownership: "true"   # Take over existing HPA
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: production-workload
  pollingInterval: 15            # Poll interval in seconds - keep >= 10
  cooldownPeriod: 300            # Wait N seconds after last trigger fire before scaling down
  idleReplicaCount: 0            # Scale to 0 when no triggers fire (if set)
  minReplicaCount: 2             # Production: never scale to 0 for critical services
  maxReplicaCount: 100           # Protect against runaway scaling
  fallback:
    failureThreshold: 3          # Tolerate 3 consecutive metric fetch failures
    replicas: 10                 # Safe fallback replica count
  advanced:
    restoreToOriginalReplicaCount: false  # Keep scaled state after ScaledObject deletion
    scalingModifiers:
      target: "20"
    horizontalPodAutoscalerConfig:
      name: production-workload-hpa
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 30
          selectPolicy: Max
          policies:
            - type: Pods
              value: 10
              periodSeconds: 60
            - type: Percent
              value: 50
              periodSeconds: 60
        scaleDown:
          stabilizationWindowSeconds: 300   # Slow scale-down to prevent flapping
          selectPolicy: Min
          policies:
            - type: Percent
              value: 20
              periodSeconds: 120
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka-system.svc.cluster.local:9092
        consumerGroup: production-workload-cg
        topic: production-events
        lagThreshold: "20"
        activationLagThreshold: "5"
      authenticationRef:
        name: kafka-auth
```

## Summary

KEDA brings sophisticated, event-driven autoscaling to Kubernetes with minimal operational overhead. Key production considerations include: always configuring fallback replicas to prevent outages during metric source unavailability; using TriggerAuthentication or ClusterTriggerAuthentication to decouple secrets from ScaledObjects; tuning cooldownPeriod and HPA scaleDown behavior to prevent flapping; setting sensible maxReplicaCount to protect downstream systems from sudden traffic bursts; and enabling Prometheus metrics and alerting to detect scaler errors before they impact workloads. ScaledJob provides a clean zero-to-N model for batch processing that eliminates the need for long-running consumer Deployments.
