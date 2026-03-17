---
title: "KEDA: Event-Driven Autoscaling for Kubernetes in Production"
date: 2028-05-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "Kafka", "Redis", "Prometheus", "HPA", "Batch"]
categories: ["Kubernetes", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide for KEDA event-driven autoscaling in Kubernetes: Kafka, Redis, and Prometheus triggers, ScaledJob for batch workloads, and performance tuning for enterprise environments."
more_link: "yes"
url: "/kubernetes-keda-event-driven-autoscaling-guide/"
---

Kubernetes Horizontal Pod Autoscaler (HPA) scales on CPU and memory metrics. This works for compute-bound services but fails entirely for event-driven workloads. A consumer that idles at 5% CPU while 50,000 messages queue in Kafka won't trigger HPA scaling. KEDA (Kubernetes Event-Driven Autoscaling) solves this by scaling workloads directly on external event sources: message queue depths, stream lag, cache lengths, and any Prometheus metric. This guide covers KEDA architecture, production-grade scaler configurations for Kafka, Redis, and Prometheus, batch workload patterns with ScaledJob, and operational tuning.

<!--more-->

## KEDA Architecture

KEDA extends Kubernetes with three components:

**keda-operator**: The core controller. Watches ScaledObject and ScaledJob resources, queries external scalers, and manages the HPA lifecycle. KEDA creates and owns an HPA for each ScaledObject - you never interact with the HPA directly.

**keda-metrics-apiserver**: Exposes external metrics to the Kubernetes metrics API. The HPA queries this server for scale decisions.

**keda-admission-webhooks**: Validates ScaledObject and ScaledJob configuration before admission.

KEDA v2 supports scaling to zero replicas - a capability the standard HPA cannot provide. When the event source has no messages, KEDA can scale the deployment to zero completely, and then scale back up when events arrive.

## Installation

```bash
# Add KEDA Helm repository
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

# Install KEDA with production settings
helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.15.1 \
  --set operator.replicaCount=2 \
  --set metricServer.replicaCount=2 \
  --set operator.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels."app\.kubernetes\.io/name"=keda-operator \
  --set operator.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0].topologyKey=kubernetes.io/hostname \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=100Mi \
  --set resources.operator.limits.cpu=1000m \
  --set resources.operator.limits.memory=1000Mi \
  --set resources.metricServer.requests.cpu=100m \
  --set resources.metricServer.requests.memory=100Mi \
  --set prometheus.operator.enabled=true \
  --set prometheus.metricServer.enabled=true
```

Verify the installation:

```bash
kubectl get pods -n keda
# NAME                                               READY   STATUS    RESTARTS   AGE
# keda-admission-webhooks-6d4f9d7c4b-8xzqp          1/1     Running   0          2m
# keda-operator-7b8c9f6d5-j2kpq                     1/1     Running   0          2m
# keda-operator-7b8c9f6d5-m9nqr                     1/1     Running   0          2m
# keda-operator-metrics-apiserver-5d8f7b6c9-q4wxz   1/1     Running   0          2m
# keda-operator-metrics-apiserver-5d8f7b6c9-r7ypx   1/1     Running   0          2m

kubectl get crd | grep keda
# clustertriggerauthentications.keda.sh
# scaledjobs.keda.sh
# scaledobjects.keda.sh
# triggerauthentications.keda.sh
```

## TriggerAuthentication: Credentials Management

Most scalers require credentials to query external systems. KEDA provides TriggerAuthentication and ClusterTriggerAuthentication for credential management:

```yaml
# Using Kubernetes secret
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-auth
  namespace: event-processing
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
    key: tls-mode
  - parameter: ca
    name: kafka-credentials
    key: ca.crt
```

```yaml
# Using AWS IAM roles (EKS with IRSA)
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-auth
  namespace: event-processing
spec:
  podIdentity:
    provider: aws
    identityOwner: workload
```

```yaml
# Using HashiCorp Vault
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: vault-auth
  namespace: event-processing
spec:
  hashiCorpVault:
    address: https://vault.internal.example.com:8200
    authentication: kubernetes
    role: keda-scaler
    mount: kubernetes
    credential:
      serviceAccount: keda-vault-reader
    secrets:
    - parameter: redisPassword
      key: data.password
      path: secret/data/redis/prod
```

## Kafka Trigger: Consumer Lag Scaling

The Kafka trigger scales based on consumer group lag - the difference between the latest offset and the consumer's committed offset.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaler
  namespace: commerce
spec:
  scaleTargetRef:
    name: order-processor
    kind: Deployment
  pollingInterval: 15        # Check every 15 seconds
  cooldownPeriod: 60         # Wait 60s before scaling down
  minReplicaCount: 1         # Always keep 1 replica for low latency
  maxReplicaCount: 50        # Maximum scale-out
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
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
          - type: Percent
            value: 100
            periodSeconds: 15
          - type: Pods
            value: 10
            periodSeconds: 15
          selectPolicy: Max
  triggers:
  - type: kafka
    authenticationRef:
      name: kafka-auth
    metadata:
      bootstrapServers: kafka-1.kafka.svc:9092,kafka-2.kafka.svc:9092,kafka-3.kafka.svc:9092
      consumerGroup: order-processor-prod
      topic: orders.created
      lagThreshold: "100"          # Target: 100 messages per replica
      offsetResetPolicy: latest
      allowIdleConsumers: "false"
      scaleToZeroOnInvalidOffset: "false"
      excludePersistentLag: "false"
      version: "2.8.0"
```

### Multi-Topic Kafka Scaling

Scale based on the maximum lag across multiple topics:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: event-aggregator-scaler
  namespace: analytics
spec:
  scaleTargetRef:
    name: event-aggregator
  minReplicaCount: 2
  maxReplicaCount: 100
  triggers:
  - type: kafka
    authenticationRef:
      name: kafka-auth
    metadata:
      bootstrapServers: kafka-1.kafka.svc:9092,kafka-2.kafka.svc:9092
      consumerGroup: event-aggregator
      topic: events.clicks
      lagThreshold: "500"
  - type: kafka
    authenticationRef:
      name: kafka-auth
    metadata:
      bootstrapServers: kafka-1.kafka.svc:9092,kafka-2.kafka.svc:9092
      consumerGroup: event-aggregator
      topic: events.pageviews
      lagThreshold: "500"
  - type: kafka
    authenticationRef:
      name: kafka-auth
    metadata:
      bootstrapServers: kafka-1.kafka.svc:9092,kafka-2.kafka.svc:9092
      consumerGroup: event-aggregator
      topic: events.conversions
      lagThreshold: "100"
```

When multiple triggers are defined, KEDA scales to satisfy all triggers simultaneously - the target replica count is the maximum computed across all triggers.

### MSK (AWS Managed Kafka) with IAM Authentication

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: msk-auth
  namespace: event-processing
spec:
  podIdentity:
    provider: aws
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: msk-consumer-scaler
  namespace: event-processing
spec:
  scaleTargetRef:
    name: payment-event-consumer
  minReplicaCount: 2
  maxReplicaCount: 30
  triggers:
  - type: aws-msk
    authenticationRef:
      name: msk-auth
    metadata:
      bootstrapServers: "b-1.mycluster.kafka.us-east-1.amazonaws.com:9098,b-2.mycluster.kafka.us-east-1.amazonaws.com:9098"
      consumerGroup: payment-processor-prod
      topic: payments.initiated
      lagThreshold: "50"
      awsRegion: us-east-1
```

## Redis Trigger: Queue Length and Stream Lag

### Redis List Queue

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: task-processing
spec:
  secretTargetRef:
  - parameter: password
    name: redis-secret
    key: redis-password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: task-worker-scaler
  namespace: task-processing
spec:
  scaleTargetRef:
    name: task-worker
  minReplicaCount: 0           # Scale to zero when idle
  maxReplicaCount: 20
  pollingInterval: 10
  cooldownPeriod: 300          # 5 minutes before scaling to zero
  triggers:
  - type: redis
    authenticationRef:
      name: redis-auth
    metadata:
      address: redis-master.redis.svc:6379
      listName: task:queue:default
      listLength: "10"           # 10 items per replica
      databaseIndex: "0"
      enableTLS: "true"
```

### Redis Streams with Consumer Groups

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: stream-processor-scaler
  namespace: streaming
spec:
  scaleTargetRef:
    name: stream-processor
  minReplicaCount: 1
  maxReplicaCount: 15
  triggers:
  - type: redis-streams
    authenticationRef:
      name: redis-auth
    metadata:
      address: redis-cluster.redis.svc:6379
      stream: notification:stream
      consumerGroup: notification-processors
      pendingEntriesCount: "20"   # Target 20 pending per replica
      enableTLS: "false"
```

### Redis Sentinel

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-sentinel-auth
  namespace: processing
spec:
  secretTargetRef:
  - parameter: password
    name: redis-sentinel-secret
    key: password
  - parameter: sentinelPassword
    name: redis-sentinel-secret
    key: sentinel-password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sentinel-worker-scaler
  namespace: processing
spec:
  scaleTargetRef:
    name: sentinel-worker
  triggers:
  - type: redis
    authenticationRef:
      name: redis-sentinel-auth
    metadata:
      sentinelMaster: mymaster
      addresses: "sentinel-0.sentinel:26379,sentinel-1.sentinel:26379,sentinel-2.sentinel:26379"
      listName: work:queue
      listLength: "5"
```

## Prometheus Trigger: Custom Metric Scaling

The Prometheus trigger scales based on any PromQL query result:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-scaler
  namespace: api
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 3
  maxReplicaCount: 50
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc:9090
      # Scale based on request rate per replica
      query: |
        sum(rate(http_requests_total{namespace="api",service="api-server"}[2m]))
      threshold: "200"           # 200 req/s per replica
      activationThreshold: "10"  # Scale from 0 when >10 req/s
      queryParameters: "timeout=30"
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc:9090
      # Also scale on P99 latency
      query: |
        histogram_quantile(0.99,
          sum(rate(http_request_duration_seconds_bucket{namespace="api"}[2m]))
          by (le)
        ) * 1000
      threshold: "500"           # Scale up if P99 > 500ms per replica
```

### Scaling on Queue Depth via Prometheus

When Kafka metrics are exposed to Prometheus (via JMX exporter or Kafka exporter):

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-via-prometheus-scaler
  namespace: processing
spec:
  scaleTargetRef:
    name: kafka-consumer
  minReplicaCount: 1
  maxReplicaCount: 30
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc:9090
      query: |
        max(
          kafka_consumergroup_lag{
            topic="orders.created",
            consumergroup="order-processor-prod"
          }
        )
      threshold: "100"
      activationThreshold: "1"
```

### Scaling Celery Workers on RabbitMQ Queue Depth

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: celery-worker-scaler
  namespace: celery
spec:
  scaleTargetRef:
    name: celery-worker
  minReplicaCount: 0
  maxReplicaCount: 25
  cooldownPeriod: 600
  triggers:
  - type: rabbitmq
    authenticationRef:
      name: rabbitmq-auth
    metadata:
      protocol: amqp
      queueName: celery
      mode: QueueLength
      value: "20"
      host: "amqp://rabbitmq.messaging.svc:5672/"
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc:9090
      # Also watch error rate
      query: |
        sum(rate(celery_task_failed_total{namespace="celery"}[5m]))
      threshold: "0.1"
      activationThreshold: "0"
```

## ScaledJob: Batch Workload Autoscaling

ScaledJob creates Kubernetes Jobs (not Deployment replicas) in response to events. Each job processes one item:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: report-generator
  namespace: reporting
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 3600    # 1 hour max per job
    backoffLimit: 2
    template:
      metadata:
        labels:
          app: report-generator
      spec:
        restartPolicy: Never
        serviceAccountName: report-generator
        containers:
        - name: generator
          image: registry.example.com/report-generator:v2.3.1
          resources:
            requests:
              cpu: 2000m
              memory: 4Gi
            limits:
              cpu: 4000m
              memory: 8Gi
          env:
          - name: REPORT_QUEUE
            value: "reports:pending"
          - name: OUTPUT_BUCKET
            value: "s3://reports.example.com/generated"
          envFrom:
          - secretRef:
              name: report-generator-secrets
  pollingInterval: 30
  maxReplicaCount: 20             # Max 20 concurrent jobs
  scalingStrategy:
    strategy: accurate             # or "eager" or "default"
    customScalingQueueLengthDeduction: 1
    customScalingRunningJobPercentage: "1.0"
  triggers:
  - type: redis
    authenticationRef:
      name: redis-auth
    metadata:
      address: redis-master.redis.svc:6379
      listName: reports:pending
      listLength: "1"             # 1 job per pending report
```

### ScaledJob Scaling Strategies

KEDA offers three scaling strategies for ScaledJob:

```yaml
scalingStrategy:
  # default: ceil(pending / targetLength) - 1 (running jobs already consuming items)
  strategy: default

  # accurate: accounts for running jobs and deducts based on processing progress
  # Best for: high-value, deterministic processing time
  strategy: accurate

  # eager: creates jobs aggressively, ignores running
  # Best for: burst processing, time-sensitive workloads
  strategy: eager
```

### ML Training Job Scaler

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: ml-training-job
  namespace: ml-platform
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 86400   # 24 hours
    backoffLimit: 1
    template:
      spec:
        restartPolicy: Never
        tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
        nodeSelector:
          cloud.google.com/gke-accelerator: nvidia-tesla-v100
        containers:
        - name: trainer
          image: registry.example.com/ml-trainer:v1.8.0
          resources:
            limits:
              nvidia.com/gpu: "2"
              memory: 64Gi
              cpu: "16"
            requests:
              nvidia.com/gpu: "2"
              memory: 48Gi
              cpu: "8"
  maxReplicaCount: 5
  scalingStrategy:
    strategy: default
  triggers:
  - type: redis
    authenticationRef:
      name: redis-auth
    metadata:
      address: redis-master.redis.svc:6379
      listName: ml:training:queue
      listLength: "1"
```

## Production Tuning

### Polling Interval and Cooldown

```yaml
spec:
  pollingInterval: 15       # Check external source every 15s
                            # Lower = faster reaction, more API calls
                            # Higher = less API pressure, slower scale-up

  cooldownPeriod: 300       # Wait 300s before scaling down
                            # Prevents thrashing on bursty workloads
                            # For scale-to-zero, increase to avoid cold starts
```

### Scale-to-Zero Considerations

Scale-to-zero eliminates idle costs but introduces cold start latency:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: async-worker-scaler
  namespace: async
spec:
  scaleTargetRef:
    name: async-worker
  minReplicaCount: 0
  idleReplicaCount: 0        # Explicit zero scaling
  cooldownPeriod: 600        # 10 minutes idle before scaling to zero
  pollingInterval: 30        # Check every 30s
  triggers:
  - type: kafka
    authenticationRef:
      name: kafka-auth
    metadata:
      bootstrapServers: kafka.kafka.svc:9092
      consumerGroup: async-worker
      topic: async.tasks
      lagThreshold: "50"
      activationThreshold: "1"   # Scale from 0 when any message arrives
```

Pre-warm pods to reduce cold start impact:

```yaml
# Keep 1 pod warm during business hours via external mechanism
apiVersion: batch/v1
kind: CronJob
metadata:
  name: keda-warmup-schedule
  namespace: async
spec:
  schedule: "0 7 * * 1-5"    # 7 AM weekdays
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: patcher
            image: bitnami/kubectl:1.29
            command:
            - kubectl
            - patch
            - scaledobject
            - async-worker-scaler
            - -n
            - async
            - --type=merge
            - -p
            - '{"spec":{"minReplicaCount":1}}'
          restartPolicy: Never
```

### HPA Behavior Tuning

```yaml
spec:
  advanced:
    horizontalPodAutoscalerConfig:
      name: custom-hpa-name        # Optional: control the HPA name
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0      # Scale up immediately
          policies:
          - type: Percent
            value: 200                       # Double replicas per period
            periodSeconds: 15
          - type: Pods
            value: 20                        # Or add 20 pods per period
            periodSeconds: 15
          selectPolicy: Max                  # Use whichever is larger
        scaleDown:
          stabilizationWindowSeconds: 300    # Wait 5m before scaling down
          policies:
          - type: Percent
            value: 10                        # Remove max 10% per minute
            periodSeconds: 60
          selectPolicy: Min                  # Use the most conservative policy
```

### Fallback Configuration

```yaml
spec:
  fallback:
    failureThreshold: 3          # Fail 3 consecutive polls
    replicas: 5                  # Then fall back to 5 replicas
```

This prevents services scaling to zero due to transient scaler failures (e.g., Kafka broker unreachable during maintenance).

## Multi-Scaler Behavior

When multiple triggers are defined, KEDA uses the maximum computed replicas:

```yaml
spec:
  triggers:
  - type: kafka
    metadata:
      topic: orders.created
      lagThreshold: "100"      # Computes 10 replicas (1000 lag / 100 threshold)
  - type: prometheus
    metadata:
      query: "sum(http_rps)"
      threshold: "50"          # Computes 15 replicas (750 rps / 50 threshold)
  # Result: 15 replicas (max of 10, 15)
```

## Observability

### KEDA Metrics in Prometheus

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keda-operator-metrics
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: keda-operator
  namespaceSelector:
    matchNames:
    - keda
  endpoints:
  - port: metrics
    interval: 15s
```

Key KEDA metrics:

```promql
# Current replicas for a scaler
keda_scaler_metrics_value{namespace="commerce",scaledObject="order-processor-scaler"}

# Scaler errors
increase(keda_scaler_errors_total[5m]) > 0

# Active scalers
keda_scaler_active

# HPA current/desired replicas
kube_horizontalpodautoscaler_status_current_replicas{
  namespace="commerce",
  horizontalpodautoscaler=~"keda-hpa.*"
}
```

### Grafana Dashboard

```yaml
# Dashboard panels for KEDA monitoring
# Panel 1: Scale activity heatmap per ScaledObject
sum by (namespace, scaledObject) (
  changes(keda_scaler_metrics_value[5m])
)

# Panel 2: Scaler metric values over time
keda_scaler_metrics_value

# Panel 3: Error rate per scaler
rate(keda_scaler_errors_total[5m])

# Panel 4: Replica count vs. metric value correlation
# Overlay HPA replicas with scaler metric values
```

### Alert Rules

```yaml
groups:
- name: keda-alerts
  rules:
  - alert: KEDAScalerError
    expr: |
      increase(keda_scaler_errors_total[5m]) > 3
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "KEDA scaler {{ $labels.scaler }} has errors"
      description: "{{ $labels.namespace }}/{{ $labels.scaledObject }} scaler failed"

  - alert: KEDAScalerAtMaxReplicas
    expr: |
      kube_horizontalpodautoscaler_status_current_replicas
        == kube_horizontalpodautoscaler_spec_max_replicas
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "ScaledObject at maximum replicas for 10+ minutes"

  - alert: KEDAFallbackActive
    expr: |
      keda_scaler_active == 0
      and
      kube_horizontalpodautoscaler_status_current_replicas > 0
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "KEDA scaler inactive but replicas running - fallback may be active"
```

## RBAC and Security

KEDA's service account needs access to query external systems. For ScaledObjects in multiple namespaces, configure appropriate RBAC:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: keda-external-metrics-reader
rules:
- apiGroups: ["external.metrics.k8s.io"]
  resources: ["*"]
  verbs: ["list", "get", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: keda-hpa-external-metrics
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: keda-external-metrics-reader
subjects:
- kind: ServiceAccount
  name: horizontal-pod-autoscaler
  namespace: kube-system
```

## Troubleshooting

### ScaledObject Not Scaling

```bash
# Check ScaledObject status
kubectl describe scaledobject order-processor-scaler -n commerce

# Look for conditions
kubectl get scaledobject order-processor-scaler -n commerce -o yaml | \
  yq '.status.conditions'

# Check KEDA operator logs
kubectl logs -n keda deployment/keda-operator --tail=100 | \
  grep -i "order-processor-scaler"

# Check the HPA KEDA manages
kubectl get hpa -n commerce
kubectl describe hpa keda-hpa-order-processor-scaler -n commerce
```

### Scaler Authentication Failures

```bash
# Verify TriggerAuthentication
kubectl get triggerauthentication kafka-auth -n commerce -o yaml

# Check secrets referenced exist
kubectl get secret kafka-credentials -n commerce

# Test connectivity from KEDA operator
kubectl exec -n keda deployment/keda-operator -- \
  nc -zv kafka-1.kafka.svc 9092
```

### Scale-to-Zero Not Working

```bash
# Verify minReplicaCount is 0
kubectl get scaledobject -n async -o jsonpath='{.items[*].spec.minReplicaCount}'

# Check cooldown period hasn't expired yet
kubectl describe scaledobject async-worker-scaler -n async | grep -i "last active"

# Confirm no other HPAs targeting the same deployment
kubectl get hpa -n async
```

## Cost Optimization with KEDA

KEDA's scale-to-zero capability directly impacts cloud costs. Example cost calculation:

```
Scenario: 10 async workers, active 40% of the time
- Without KEDA (always-on): 10 workers × 2 vCPU × $0.048/vCPU-hr × 730 hr/month = $701/month
- With KEDA (40% active): 10 workers × 2 vCPU × $0.048/vCPU-hr × 292 hr/month = $281/month
- Savings: $420/month per service tier
```

For batch workloads with ScaledJob, savings are even greater because jobs only run when work is queued.

## Summary

KEDA transforms Kubernetes autoscaling from a compute-centric model to an event-driven model. Kafka consumer lag, Redis queue depths, Prometheus metrics, and dozens of other sources all become first-class scaling signals. The ScaledJob pattern handles batch workloads elegantly - creating exactly as many jobs as there are items to process. Production deployments benefit from careful tuning of polling intervals, cooldown periods, and HPA behavior policies to balance responsiveness against resource efficiency. With proper fallback configuration and observability, KEDA delivers reliable event-driven scaling for the most demanding production workloads.
