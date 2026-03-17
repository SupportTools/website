---
title: "Kubernetes KEDA ScaledJobs: Batch Workload Autoscaling Patterns"
date: 2028-12-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "ScaledJobs", "Autoscaling", "Batch Processing", "Event-Driven"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "An enterprise guide to KEDA ScaledJobs for batch workload autoscaling in Kubernetes, covering queue-driven scaling, parallelism strategies, job lifecycle management, and production patterns for RabbitMQ, Kafka, and Redis-backed workloads."
more_link: "yes"
url: "/kubernetes-keda-scaledjobs-batch-workload-autoscaling-guide/"
---

Kubernetes Horizontal Pod Autoscaler (HPA) scales long-running Deployment replicas based on metrics. Batch workloads have fundamentally different semantics: a queue of work items arrives, each item requires a bounded amount of processing, and the goal is to process all items as quickly as cost constraints allow — then scale to zero when the queue is empty. Kubernetes Jobs model this well, but native Kubernetes lacks a mechanism to scale Job parallelism in response to queue depth.

KEDA (Kubernetes Event-Driven Autoscaling) fills this gap with the `ScaledJob` resource, which creates and manages Kubernetes Jobs in response to external event sources. This guide covers the `ScaledJob` architecture, queue-driven scaling patterns for RabbitMQ, Kafka, and Redis, parallelism and completion modes, cost optimization strategies, and production operational patterns.

<!--more-->

## KEDA Architecture Overview

KEDA extends Kubernetes with two Custom Resources:

- **`ScaledObject`**: Scales `Deployment`, `StatefulSet`, or other workload resources based on external metrics (this guide focuses on `ScaledJob`)
- **`ScaledJob`**: Creates Kubernetes `Job` resources in response to event source triggers, scales to zero when no events are pending

The KEDA operator consists of two components:

- **KEDA Operator**: Watches `ScaledObject` and `ScaledJob` resources, queries scalers, creates/deletes Jobs
- **KEDA Metrics Adapter**: Exposes external metrics to the Kubernetes custom metrics API (used by HPA for `ScaledObject`)

For `ScaledJob`, the KEDA Operator directly manages Job creation — it does not use the Kubernetes HPA.

### Installing KEDA

```bash
# Install KEDA using Helm
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true \
  --set prometheus.operator.prometheusRuleName=keda-prometheus-rules

# Verify installation
kubectl get pods -n keda
kubectl get crd | grep keda.sh
```

## The ScaledJob Resource

A `ScaledJob` creates one Kubernetes `Job` (optionally with multiple parallel pods) per polling interval when the configured trigger metric exceeds a threshold:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processing-job
  namespace: media-processing
spec:
  # The Job template that KEDA instantiates per trigger event
  jobTargetRef:
    parallelism: 4          # Pods per Job instance
    completions: 4          # Required successful completions per Job
    activeDeadlineSeconds: 3600  # Kill Job after 1 hour (prevents runaway jobs)
    backoffLimit: 3
    template:
      metadata:
        annotations:
          cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
      spec:
        restartPolicy: OnFailure
        containers:
        - name: image-processor
          image: registry.example.com/image-processor:v1.8.2
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
            limits:
              cpu: "4"
              memory: "8Gi"
          env:
          - name: QUEUE_URL
            valueFrom:
              secretKeyRef:
                name: rabbitmq-credentials
                key: queue-url
          - name: WORKER_CONCURRENCY
            value: "2"
        tolerations:
        - key: "spot-instance"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"

  # Polling interval for checking the trigger source
  pollingInterval: 15  # seconds

  # Cooldown period after last successful job before scaling to zero
  # (only relevant when successfulJobsHistoryLimit > 0)
  cooldownPeriod: 30  # seconds

  # Job lifecycle settings
  minReplicaCount: 0    # Scale to zero when queue is empty
  maxReplicaCount: 50   # Maximum concurrent Job instances

  # How to handle multiple triggers: OR (any trigger fires) or AND (all must fire)
  scalingStrategy:
    strategy: "default"  # default | custom | accurate

  # Job cleanup policy
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5

  # Triggers define what causes Job creation
  triggers:
  - type: rabbitmq
    metadata:
      host: amqp://rabbitmq.media-processing.svc.cluster.local:5672/
      queueName: image-processing-queue
      mode: QueueLength
      value: "10"  # Create a new Job instance for every 10 messages
    authenticationRef:
      name: rabbitmq-trigger-auth
```

## Trigger Types for Common Queue Systems

### RabbitMQ Trigger

```yaml
# TriggerAuthentication for RabbitMQ
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-trigger-auth
  namespace: media-processing
spec:
  secretTargetRef:
  - parameter: host
    name: rabbitmq-credentials
    key: connection-string
---
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: rabbitmq-consumer-job
  namespace: media-processing
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 2
    template:
      spec:
        restartPolicy: Never
        containers:
        - name: rabbitmq-consumer
          image: registry.example.com/rabbitmq-consumer:v2.3.0
          env:
          - name: PREFETCH_COUNT
            value: "10"
          - name: MESSAGE_BATCH_SIZE
            value: "10"
  pollingInterval: 10
  minReplicaCount: 0
  maxReplicaCount: 100
  triggers:
  - type: rabbitmq
    metadata:
      protocol: amqp
      queueName: document-conversion
      mode: QueueLength
      # One Job per 10 messages in the queue
      value: "10"
      # vHost for multi-tenant RabbitMQ
      vhostName: "/"
    authenticationRef:
      name: rabbitmq-trigger-auth
```

The `mode: QueueLength` with `value: "10"` creates `ceil(queue_depth / 10)` Job instances, up to `maxReplicaCount`.

With `mode: MessageRate` and `value: "50"`, KEDA creates Jobs based on the rate of incoming messages per second rather than queue depth — useful when processing latency matters more than queue length.

### Apache Kafka Trigger

```yaml
# TriggerAuthentication for Kafka with SASL/TLS
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: data-pipeline
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-credentials
    key: sasl-mechanism   # PLAIN, SCRAM-SHA-256, SCRAM-SHA-512
  - parameter: username
    name: kafka-credentials
    key: username
  - parameter: password
    name: kafka-credentials
    key: password
  - parameter: tls
    name: kafka-credentials
    key: tls-enabled      # "enable" or "disable"
  - parameter: ca
    name: kafka-credentials
    key: ca.crt
---
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: kafka-event-processor
  namespace: data-pipeline
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 3
    activeDeadlineSeconds: 7200
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: kafka-processor
          image: registry.example.com/kafka-processor:v4.1.0
          env:
          - name: KAFKA_BROKERS
            value: "kafka-0.kafka.kafka.svc.cluster.local:9092,kafka-1.kafka.kafka.svc.cluster.local:9092,kafka-2.kafka.kafka.svc.cluster.local:9092"
          - name: KAFKA_TOPIC
            value: "user-events"
          - name: KAFKA_CONSUMER_GROUP
            value: "event-processor-batch"
          - name: MAX_MESSAGES_PER_RUN
            value: "1000"
          resources:
            requests:
              cpu: "500m"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
  pollingInterval: 30
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-0.kafka.kafka.svc.cluster.local:9092
      consumerGroup: event-processor-batch
      topic: user-events
      # lagThreshold: minimum consumer lag to trigger a job
      lagThreshold: "100"
      # offsetResetPolicy: earliest or latest (for new consumer groups)
      offsetResetPolicy: earliest
      # activationLagThreshold: minimum lag before KEDA starts creating jobs
      activationLagThreshold: "10"
    authenticationRef:
      name: kafka-trigger-auth
```

The `lagThreshold: "100"` means KEDA creates one Job instance for every 100 messages of consumer lag across all partitions. With 1000 messages of lag, 10 Job instances run concurrently.

### Redis List Trigger

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: redis-queue-worker
  namespace: workers
spec:
  jobTargetRef:
    parallelism: 2
    completions: 2
    backoffLimit: 5
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: redis-worker
          image: registry.example.com/redis-worker:v1.4.0
          env:
          - name: REDIS_HOST
            value: "redis-master.redis.svc.cluster.local"
          - name: REDIS_PORT
            value: "6379"
          - name: QUEUE_KEY
            value: "job:email:queue"
          - name: BATCH_SIZE
            value: "50"
  pollingInterval: 5
  minReplicaCount: 0
  maxReplicaCount: 30
  triggers:
  - type: redis
    metadata:
      address: redis-master.redis.svc.cluster.local:6379
      listName: "job:email:queue"
      listLength: "50"  # Jobs per 50 items in the Redis list
      activationListLength: "5"  # Minimum items before KEDA creates any jobs
      databaseIndex: "0"
    authenticationRef:
      name: redis-trigger-auth
```

### AWS SQS Trigger

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-sqs-auth
  namespace: workers
spec:
  podIdentity:
    provider: aws  # Uses IAM Roles for Service Accounts (IRSA)
---
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: sqs-processor
  namespace: workers
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 2
    template:
      metadata:
        annotations:
          # Required for IRSA
          eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/sqs-processor-role
      spec:
        serviceAccountName: sqs-processor
        restartPolicy: Never
        containers:
        - name: sqs-worker
          image: registry.example.com/sqs-worker:v2.0.0
          env:
          - name: SQS_QUEUE_URL
            value: "https://sqs.us-east-1.amazonaws.com/123456789012/document-processing"
          - name: AWS_REGION
            value: "us-east-1"
  pollingInterval: 20
  minReplicaCount: 0
  maxReplicaCount: 100
  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/document-processing
      queueLength: "5"      # Jobs per 5 messages
      awsRegion: us-east-1
      scaleOnInFlight: "true"  # Include in-flight messages in queue depth calculation
    authenticationRef:
      name: aws-sqs-auth
```

## Scaling Strategy Configuration

### The `accurate` Strategy

The default strategy creates one Job per polling interval if the trigger metric indicates pending work. The `accurate` strategy attempts to match the exact number of Jobs to the queue depth:

```yaml
spec:
  scalingStrategy:
    strategy: accurate
    # With accurate strategy, maxReplicaCount limits the instantaneous cap
    # but KEDA will create jobs up to ceiling(queue_depth / trigger.value)
```

### Custom Scaling with Multiple Triggers

```yaml
spec:
  scalingStrategy:
    strategy: custom
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "0.5"
    # Running job percentage prevents over-provisioning when jobs are slow
    # to start. With 0.5, KEDA assumes 50% of running jobs are consuming
    # messages, reducing the calculated queue depth for new job decisions.
```

### Pending Jobs Buffer

For workloads with variable processing times, maintain a buffer of pending Jobs:

```yaml
spec:
  scalingStrategy:
    strategy: default
    pendingJobCount: 2  # Always keep 2 pending Jobs in addition to running ones
                        # Reduces latency for new items
```

## Job Completion Modes

### Short-Running Jobs: One Job per Message Batch

Best for tasks with well-defined completion criteria:

```yaml
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 3
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: worker
          # Worker fetches one batch from the queue, processes it, exits 0
          # If exits non-zero, Kubernetes retries up to backoffLimit times
```

### Long-Running Jobs: Multiple Parallel Workers

For high-throughput scenarios where starting/stopping Jobs has high overhead:

```yaml
spec:
  jobTargetRef:
    parallelism: 10     # 10 parallel worker pods per Job
    completions: 10     # All 10 must succeed for the Job to complete
    backoffLimit: 30
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: worker
          # Each worker pod consumes messages independently from the queue
          # and runs until the queue is empty, then exits 0
          env:
          - name: DRAIN_QUEUE_ON_START
            value: "true"
          - name: IDLE_TIMEOUT_SECONDS
            value: "60"  # Exit after 60 seconds with no messages
```

### Indexed Jobs for Partition-Aware Processing

For Kafka workloads with fixed partition counts, use indexed completion mode:

```yaml
spec:
  jobTargetRef:
    completionMode: Indexed
    parallelism: 6      # One pod per Kafka partition
    completions: 6
    backoffLimit: 18
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: kafka-partition-consumer
          image: registry.example.com/kafka-consumer:v3.0.0
          env:
          - name: JOB_COMPLETION_INDEX
            valueFrom:
              fieldRef:
                fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
          # The worker uses JOB_COMPLETION_INDEX as the Kafka partition number
```

## Cost Optimization with Spot Instances

Batch workloads are ideal candidates for spot/preemptible instances. Configure ScaledJob workers to run exclusively on spot nodes:

```yaml
spec:
  jobTargetRef:
    template:
      spec:
        nodeSelector:
          node.kubernetes.io/instance-type-category: spot
        tolerations:
        - key: "node.kubernetes.io/spot"
          operator: "Exists"
          effect: "NoSchedule"
        # Allow cluster autoscaler to provision spot nodes when needed
        priorityClassName: "batch-workload"
        containers:
        - name: worker
          image: registry.example.com/worker:v1.0.0
          # Handle spot interruption gracefully
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 10 && /app/checkpoint-and-exit.sh"]
```

```yaml
# PriorityClass for batch workloads — lower than system-critical
# but allows scheduling on spot nodes
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-workload
value: 100
preemptionPolicy: Never
globalDefault: false
description: "Batch processing workloads suitable for spot instances"
```

## Job History and Cleanup

Without cleanup policies, completed Jobs accumulate and consume etcd storage:

```yaml
spec:
  # Keep last 5 successful Jobs for debugging
  successfulJobsHistoryLimit: 5

  # Keep last 10 failed Jobs for investigation
  failedJobsHistoryLimit: 10

  # KEDA automatically deletes Jobs older than this history limit
  # Jobs currently running are never deleted by KEDA

  jobTargetRef:
    # Kubernetes-native TTL (independent of KEDA history limit)
    # Deletes completed Jobs after 3600 seconds
    ttlSecondsAfterFinished: 3600
```

## Observability

### Prometheus Metrics for KEDA

```yaml
# ServiceMonitor for KEDA operator metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keda-metrics
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
    interval: 30s
    path: /metrics
```

Key KEDA metrics:

| Metric | Description |
|--------|-------------|
| `keda_scaler_active` | Whether the scaler is currently active (1=active, 0=inactive) |
| `keda_scaler_metrics_value` | Current metric value from the trigger (queue depth) |
| `keda_scaled_job_active` | Number of active ScaledJob instances |
| `keda_internal_scale_loop_latency` | Time KEDA takes to evaluate scalers and act |

### Alerting Rules

```yaml
groups:
- name: keda-scaledjobs
  rules:
  - alert: KEDAScaledJobQueueDepthHigh
    expr: |
      keda_scaler_metrics_value{scaledobject=~".*", type="ScaledJob"} > 10000
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "KEDA ScaledJob {{ $labels.scaledobject }} has high queue depth"
      description: "Queue depth: {{ $value }} messages. Maximum jobs may be insufficient."

  - alert: KEDAScaledJobMaxReplicasReached
    expr: |
      keda_scaled_job_active == keda_scaled_job_max
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "KEDA ScaledJob {{ $labels.scaledJob }} has reached maxReplicaCount"
      description: "All {{ $value }} job slots are in use. Queue may be growing."

  - alert: KEDAScalerError
    expr: |
      rate(keda_scaler_errors_total[5m]) > 0
    labels:
      severity: critical
    annotations:
      summary: "KEDA scaler is erroring for {{ $labels.scaledobject }}"
```

## Production Operational Patterns

### Dead Letter Queue Handling

When ScaledJob workers fail to process messages after retries, route failed messages to a DLQ and create a separate ScaledJob for alerting and reprocessing:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: dlq-alert-processor
  namespace: workers
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 1
    template:
      spec:
        restartPolicy: Never
        containers:
        - name: dlq-processor
          image: registry.example.com/dlq-alerter:v1.0.0
          # This job logs DLQ message metadata and fires PagerDuty alerts
  pollingInterval: 60
  minReplicaCount: 0
  maxReplicaCount: 5
  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/document-processing-dlq
      queueLength: "1"  # Alert as soon as any message hits the DLQ
      awsRegion: us-east-1
    authenticationRef:
      name: aws-sqs-auth
```

### Pausing ScaledJobs During Maintenance

```bash
# Pause a ScaledJob to prevent new Jobs from being created
kubectl annotate scaledjob image-processing-job \
  autoscaling.keda.sh/paused=true \
  -n media-processing

# Resume
kubectl annotate scaledjob image-processing-job \
  autoscaling.keda.sh/paused- \
  -n media-processing

# Check paused state
kubectl get scaledjob image-processing-job -n media-processing \
  -o jsonpath='{.metadata.annotations.autoscaling\.keda\.sh/paused}'
```

### Multi-Queue Priority Processing

Use multiple ScaledJobs with different `maxReplicaCount` values for priority queues:

```yaml
# High-priority queue — up to 50 concurrent Jobs
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: high-priority-processor
  namespace: workers
spec:
  maxReplicaCount: 50
  triggers:
  - type: rabbitmq
    metadata:
      queueName: processing-high-priority
      value: "5"
---
# Low-priority queue — up to 10 concurrent Jobs (constrained capacity)
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: low-priority-processor
  namespace: workers
spec:
  maxReplicaCount: 10
  triggers:
  - type: rabbitmq
    metadata:
      queueName: processing-low-priority
      value: "20"
```

## Conclusion

KEDA ScaledJobs provide a production-ready pattern for event-driven batch workload autoscaling in Kubernetes. The key design principles:

1. **Match Job parallelism to processing unit size**: Set `jobTargetRef.parallelism` based on how many parallel workers efficiently consume a message batch, not on cluster capacity
2. **Use `activationThreshold`** to prevent Jobs from being created for very small queue depths — reduces Job startup overhead for trickle traffic
3. **Set `activeDeadlineSeconds`** on all Jobs to prevent runaway processing from consuming resources indefinitely
4. **Configure `ttlSecondsAfterFinished`** alongside `successfulJobsHistoryLimit` for proper cleanup
5. **Run on spot instances** with graceful checkpoint-and-exit handling to dramatically reduce batch processing costs
6. **Monitor `keda_scaler_metrics_value`** over time to right-size `maxReplicaCount` and trigger `value` ratios
