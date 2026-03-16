---
title: "Kubernetes Job and Queue Processing: Batch Workloads, CronJobs, and Work Queues"
date: 2027-05-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Jobs", "CronJob", "Batch", "Queue", "KEDA"]
categories: ["Kubernetes", "Automation"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes Jobs and CronJobs covering completions, parallelism, backoffLimit, TTL cleanup, indexed jobs, work queue patterns with Redis and RabbitMQ, KEDA ScaledJob autoscaling, and failure handling strategies."
more_link: "yes"
url: "/kubernetes-job-queue-processing-guide/"
---

Batch workloads and queue-based processing are critical components of modern data pipelines, report generation systems, and event-driven architectures. Kubernetes Jobs and CronJobs provide the primitives for running batch tasks to completion, while KEDA (Kubernetes Event-Driven Autoscaling) enables dynamic scaling based on queue depth. Understanding these primitives deeply—including their failure modes and cleanup requirements—is essential for building reliable batch processing systems on Kubernetes.

<!--more-->

## Kubernetes Job Fundamentals

A Job creates one or more pods and ensures that a specified number of them successfully terminate. Unlike Deployments, Jobs are designed to run to completion, not to maintain a steady running state.

### Basic Job Structure

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-migration-v2
  namespace: production
  labels:
    app: data-migration
    version: "v2"
    type: batch
spec:
  # Number of successful pod completions required
  completions: 1
  # Number of pods that can run in parallel
  parallelism: 1
  # Number of retries before job is marked as failed
  backoffLimit: 3
  # Automatically clean up completed/failed pods after N seconds
  ttlSecondsAfterFinished: 3600
  # Active deadline - job is terminated if it exceeds this duration
  activeDeadlineSeconds: 7200
  # Retry policy for pod failures
  podFailurePolicy:
    rules:
    - action: FailJob
      onExitCodes:
        containerName: migrator
        operator: In
        values: [1, 2]  # Non-retryable errors
    - action: Ignore
      onExitCodes:
        containerName: migrator
        operator: In
        values: [0]
    - action: Count
      onPodConditions:
      - type: DisruptionTarget  # OOM, node failure = retryable
  template:
    metadata:
      labels:
        app: data-migration
        job-name: data-migration-v2
    spec:
      restartPolicy: OnFailure
      serviceAccountName: migration-sa
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: migrator
        image: myapp/migrator:v2.1.0
        command:
        - /bin/sh
        - -c
        - |
          set -e
          echo "Starting migration at $(date)"
          /app/migrate --version=v2 --batch-size=1000
          echo "Migration completed at $(date)"
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: url
        - name: MIGRATION_VERSION
          value: "v2"
        resources:
          requests:
            cpu: "500m"
            memory: "1Gi"
          limits:
            cpu: "2"
            memory: "4Gi"
        volumeMounts:
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: tmp
        emptyDir:
          sizeLimit: 1Gi
```

## Completions and Parallelism Patterns

### Pattern 1: Single Job (1 completion, 1 parallelism)

```yaml
# Simple one-shot task
spec:
  completions: 1
  parallelism: 1
```

Use for: database migrations, one-time data exports, initialization tasks.

### Pattern 2: Multiple Sequential Completions

```yaml
# Run the task 10 times, one at a time
spec:
  completions: 10
  parallelism: 1
```

Use for: processing a fixed number of items where order matters or shared state prevents concurrency.

### Pattern 3: Parallel Batch Processing

```yaml
# Process 100 items, 10 at a time
spec:
  completions: 100
  parallelism: 10
```

Use for: processing a known number of files, report generation, batch API calls with rate limits.

### Pattern 4: Worker Pool (completion count not fixed)

```yaml
# Unlimited completions, 5 workers pulling from queue
spec:
  completions: null  # No fixed completion count
  parallelism: 5
```

Use for: queue-based processing where the number of items is not known in advance.

## Indexed Jobs

Indexed Jobs (introduced in Kubernetes 1.24, GA in 1.24) give each pod a unique completion index, enabling work sharding without an external queue.

### Basic Indexed Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: image-processor
  namespace: production
spec:
  completions: 100
  parallelism: 10
  completionMode: Indexed
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: processor
        image: myapp/image-processor:1.0
        command:
        - /bin/bash
        - -c
        - |
          # JOB_COMPLETION_INDEX is set automatically (0-99)
          echo "Processing shard $JOB_COMPLETION_INDEX of $JOB_TOTAL_COMPLETIONS"

          # Calculate item range for this shard
          ITEMS_PER_SHARD=100
          START=$(( JOB_COMPLETION_INDEX * ITEMS_PER_SHARD ))
          END=$(( START + ITEMS_PER_SHARD ))

          /app/process-images \
            --start-offset=$START \
            --end-offset=$END \
            --shard-id=$JOB_COMPLETION_INDEX
        env:
        - name: JOB_COMPLETION_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
        - name: JOB_TOTAL_COMPLETIONS
          value: "100"
        resources:
          requests:
            cpu: "1"
            memory: "2Gi"
          limits:
            cpu: "4"
            memory: "8Gi"
```

### Indexed Job with Static Work Assignment

```yaml
# ConfigMap with work assignments indexed by shard
apiVersion: v1
kind: ConfigMap
metadata:
  name: work-shards
  namespace: production
data:
  shards.json: |
    {
      "0": {"region": "us-east-1", "bucket": "data-east"},
      "1": {"region": "us-west-2", "bucket": "data-west"},
      "2": {"region": "eu-west-1", "bucket": "data-eu"},
      "3": {"region": "ap-southeast-1", "bucket": "data-apac"}
    }
---
apiVersion: batch/v1
kind: Job
metadata:
  name: regional-export
spec:
  completions: 4
  parallelism: 4
  completionMode: Indexed
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: exporter
        image: myapp/exporter:1.0
        command:
        - /bin/bash
        - -c
        - |
          IDX=$JOB_COMPLETION_INDEX
          CONFIG=$(cat /work-config/shards.json | jq -r ".\"$IDX\"")
          REGION=$(echo $CONFIG | jq -r '.region')
          BUCKET=$(echo $CONFIG | jq -r '.bucket')

          echo "Processing shard $IDX: region=$REGION, bucket=$BUCKET"
          /app/export --region=$REGION --bucket=$BUCKET
        env:
        - name: JOB_COMPLETION_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
        volumeMounts:
        - name: work-config
          mountPath: /work-config
      volumes:
      - name: work-config
        configMap:
          name: work-shards
```

## CronJob Configuration

CronJobs create Jobs on a schedule using standard cron syntax.

### Production CronJob Template

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
  namespace: production
  labels:
    app: reporting
    type: scheduled
spec:
  # Standard cron: minute hour day-of-month month day-of-week
  schedule: "0 2 * * *"
  # Timezone support (Kubernetes 1.27+)
  timeZone: "America/New_York"
  # What to do if a job is still running when next schedule fires
  concurrencyPolicy: Forbid  # Skip, Allow, or Forbid
  # Keep N most recent successful job records
  successfulJobsHistoryLimit: 7
  # Keep N most recent failed job records
  failedJobsHistoryLimit: 3
  # Suspend the CronJob without deleting it
  suspend: false
  # How far in the past (seconds) to look for missed schedules
  startingDeadlineSeconds: 3600
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 14400
      ttlSecondsAfterFinished: 86400
      template:
        metadata:
          labels:
            app: reporting
            job-type: nightly-report
        spec:
          restartPolicy: OnFailure
          serviceAccountName: reporting-sa
          priorityClassName: batch-low-priority
          containers:
          - name: reporter
            image: myapp/reporter:v3.2.0
            command:
            - /app/generate-report
            - --date=$(date +%Y-%m-%d)
            - --output=s3://my-reports/$(date +%Y/%m/%d)/
            - --format=pdf,csv
            env:
            - name: REPORT_DATE
              value: ""  # Computed at runtime
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: reporting-db
                  key: url
            - name: S3_BUCKET
              value: my-reports
            resources:
              requests:
                cpu: "2"
                memory: "4Gi"
              limits:
                cpu: "8"
                memory: "16Gi"
```

### ConcurrencyPolicy Options

```yaml
# Forbid: skip new job if previous is still running
concurrencyPolicy: Forbid

# Allow: run multiple jobs simultaneously
concurrencyPolicy: Allow

# Replace: cancel running job and start new one
concurrencyPolicy: Replace
```

### Timezone-Aware CronJobs

```yaml
# Run at 9 AM London time
spec:
  schedule: "0 9 * * 1-5"
  timeZone: "Europe/London"

# Run at midnight Tokyo time
spec:
  schedule: "0 0 * * *"
  timeZone: "Asia/Tokyo"

# List available timezones
# kubectl exec -it <pod> -- timedatectl list-timezones
```

### CronJob Schedule Reference

```bash
# Common patterns
"0 * * * *"         # Every hour at minute 0
"*/15 * * * *"      # Every 15 minutes
"0 2 * * *"         # Daily at 2:00 AM
"0 2 * * 0"         # Weekly on Sunday at 2:00 AM
"0 2 1 * *"         # Monthly on the 1st at 2:00 AM
"0 2 1 1 *"         # Annually on Jan 1 at 2:00 AM
"0 */6 * * *"       # Every 6 hours
"30 9 * * 1-5"      # Weekdays at 9:30 AM
"@hourly"           # Equivalent to: 0 * * * *
"@daily"            # Equivalent to: 0 0 * * *
"@weekly"           # Equivalent to: 0 0 * * 0
"@monthly"          # Equivalent to: 0 0 1 * *
```

## backoffLimit and Failure Handling

### Pod Failure Policy

```yaml
spec:
  backoffLimit: 6  # Default is 6
  podFailurePolicy:
    rules:
    # Immediately fail the job on non-retryable exit codes
    - action: FailJob
      onExitCodes:
        containerName: worker
        operator: In
        values:
          - 42   # "Configuration error - no point retrying"
          - 43   # "Data format error - no point retrying"

    # Ignore pod disruptions (node eviction, preemption)
    - action: Ignore
      onPodConditions:
      - type: DisruptionTarget

    # Count OOM failures towards backoffLimit
    - action: Count
      onPodConditions:
      - type: DisruptionTarget
        status: "True"
```

### Handling Different Failure Scenarios

```yaml
# Worker with explicit exit codes for failure categorization
containers:
- name: worker
  image: myapp/worker:1.0
  command:
  - /bin/bash
  - -c
  - |
    set -e

    # Validate configuration
    if [ -z "$DATABASE_URL" ]; then
      echo "ERROR: DATABASE_URL not configured"
      exit 42  # Non-retryable: configuration error
    fi

    # Check input data format
    /app/validate-input "$INPUT_FILE" || {
      echo "ERROR: Invalid input format"
      exit 43  # Non-retryable: bad data
    }

    # Process with retryable failures returning exit 1
    /app/process "$INPUT_FILE" || exit 1
```

### activeDeadlineSeconds vs backoffLimit

```yaml
spec:
  # Hard deadline: job is terminated after this many seconds
  # regardless of completion status
  activeDeadlineSeconds: 3600

  # Retry limit: job fails after this many pod failures
  # Each failed pod counts as one retry
  backoffLimit: 3

  # Both can be used together:
  # Job fails when EITHER limit is reached first
```

## TTL After Finished

Automatic cleanup of completed Jobs prevents resource accumulation.

```yaml
spec:
  # Delete job and its pods after 1 hour
  ttlSecondsAfterFinished: 3600

# Disable TTL (never auto-delete)
spec:
  ttlSecondsAfterFinished: null
```

### Cluster-Wide TTL Policy via Kyverno

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-job-ttl
spec:
  rules:
  - name: add-ttl-seconds-after-finished
    match:
      any:
      - resources:
          kinds:
          - Job
    mutate:
      patchStrategicMerge:
        spec:
          +(ttlSecondsAfterFinished): 86400  # 24 hours default
```

## Work Queue Patterns

### Redis-Based Work Queue Pattern

```yaml
# Redis for work queue
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-queue
  namespace: batch
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis-queue
  template:
    metadata:
      labels:
        app: redis-queue
    spec:
      containers:
      - name: redis
        image: redis:7.2
        command:
        - redis-server
        - --maxmemory
        - 2gb
        - --maxmemory-policy
        - noeviction
        ports:
        - containerPort: 6379
        resources:
          requests:
            cpu: "500m"
            memory: "2.5Gi"
          limits:
            cpu: "2"
            memory: "3Gi"
---
# Job that processes Redis queue
apiVersion: batch/v1
kind: Job
metadata:
  name: redis-queue-processor
  namespace: batch
spec:
  parallelism: 5
  completions: null  # Workers run until queue is empty
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: worker
        image: myapp/queue-worker:1.0
        command:
        - /app/worker
        env:
        - name: REDIS_URL
          value: redis://redis-queue.batch.svc.cluster.local:6379
        - name: QUEUE_NAME
          value: processing-queue
        - name: WORKER_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
```

### Worker Implementation Pattern

```python
#!/usr/bin/env python3
# worker.py - Redis queue worker
import redis
import os
import json
import time
import signal
import sys

REDIS_URL = os.environ['REDIS_URL']
QUEUE_NAME = os.environ.get('QUEUE_NAME', 'work-queue')
PROCESSING_TIMEOUT = int(os.environ.get('PROCESSING_TIMEOUT', '300'))
WORKER_ID = os.environ.get('WORKER_ID', 'worker-unknown')

# Track items being processed for graceful shutdown
current_item = None
shutdown_requested = False


def handle_shutdown(signum, frame):
    global shutdown_requested
    print(f"Shutdown requested (signal {signum})")
    shutdown_requested = True
    if current_item:
        # Re-queue the item being processed
        r.lpush(QUEUE_NAME, json.dumps(current_item))
        print(f"Re-queued item: {current_item.get('id')}")


signal.signal(signal.SIGTERM, handle_shutdown)
signal.signal(signal.SIGINT, handle_shutdown)

r = redis.from_url(REDIS_URL)


def process_item(item):
    """Process a single work item."""
    print(f"[{WORKER_ID}] Processing item: {item.get('id')}")
    # Application-specific processing logic
    time.sleep(1)  # Simulated work
    return True


def run():
    global current_item
    print(f"Worker {WORKER_ID} starting, queue: {QUEUE_NAME}")

    consecutive_empty = 0
    max_empty = 10  # Exit after 10 consecutive empty dequeues

    while not shutdown_requested:
        # Blocking pop with timeout (atomically dequeue)
        result = r.brpop(QUEUE_NAME, timeout=5)

        if result is None:
            consecutive_empty += 1
            if consecutive_empty >= max_empty:
                print(f"Queue empty for {max_empty} consecutive polls, exiting")
                sys.exit(0)
            continue

        consecutive_empty = 0
        _, item_bytes = result
        current_item = json.loads(item_bytes)

        try:
            success = process_item(current_item)
            if success:
                # Mark item as complete
                r.lrem('processing', 0, json.dumps(current_item))
                r.lpush('completed', json.dumps({
                    'item': current_item,
                    'worker': WORKER_ID,
                    'completed_at': time.time()
                }))
            else:
                # Re-queue failed items
                r.lpush(QUEUE_NAME, json.dumps(current_item))
        except Exception as e:
            print(f"Error processing {current_item.get('id')}: {e}")
            # Move to dead letter queue after max retries
            retries = current_item.get('retries', 0) + 1
            if retries >= 3:
                r.lpush('dead-letter', json.dumps(current_item))
            else:
                current_item['retries'] = retries
                r.lpush(QUEUE_NAME, json.dumps(current_item))
        finally:
            current_item = None


if __name__ == '__main__':
    run()
```

### RabbitMQ-Based Work Queue

```yaml
# Job consuming from RabbitMQ
apiVersion: batch/v1
kind: Job
metadata:
  name: rabbitmq-consumer
  namespace: batch
spec:
  parallelism: 10
  completions: null
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure
      initContainers:
      - name: wait-for-rabbitmq
        image: busybox:1.36
        command:
        - /bin/sh
        - -c
        - |
          until nc -z rabbitmq.messaging.svc.cluster.local 5672; do
            echo "Waiting for RabbitMQ..."
            sleep 2
          done
          echo "RabbitMQ is available"
      containers:
      - name: consumer
        image: myapp/rabbitmq-consumer:1.0
        env:
        - name: RABBITMQ_URL
          valueFrom:
            secretKeyRef:
              name: rabbitmq-credentials
              key: url
        - name: QUEUE_NAME
          value: "work.items"
        - name: PREFETCH_COUNT
          value: "10"
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "2"
            memory: "2Gi"
```

## KEDA ScaledJob for Event-Driven Autoscaling

KEDA (Kubernetes Event-Driven Autoscaler) extends Kubernetes to autoscale Jobs based on external metrics like queue depth.

### KEDA Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.13.0 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=128Mi
```

### ScaledJob for Redis Queue

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: redis-queue-scaledjob
  namespace: batch
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 600
    backoffLimit: 2
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: worker
          image: myapp/queue-worker:1.0
          env:
          - name: REDIS_URL
            value: redis://redis-queue.batch.svc.cluster.local:6379
          - name: QUEUE_NAME
            value: processing-queue
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
  # Polling interval for checking queue depth
  pollingInterval: 10
  # Time to wait before scaling to zero
  cooldownPeriod: 30
  # Minimum number of job replicas
  minReplicaCount: 0
  # Maximum concurrent jobs
  maxReplicaCount: 50
  # Remove completed/failed jobs after N seconds
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 5
  # Scaling strategy
  scalingStrategy:
    strategy: "accurate"  # "default", "accurate", "eager"
    # Each trigger metric exceeding threshold creates N jobs
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "0.5"
  # Triggers define when to scale
  triggers:
  - type: redis
    metadata:
      address: redis-queue.batch.svc.cluster.local:6379
      listName: processing-queue
      listLength: "1"       # One job per item in queue
      enableTLS: "false"
    authenticationRef:
      name: redis-auth
```

### KEDA ScaledJob for RabbitMQ

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-auth
  namespace: batch
spec:
  secretTargetRef:
  - parameter: host
    name: rabbitmq-credentials
    key: url
---
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: rabbitmq-processor
  namespace: batch
spec:
  jobTargetRef:
    parallelism: 5
    completions: 5
    backoffLimit: 3
    template:
      spec:
        restartPolicy: OnFailure
        containers:
        - name: consumer
          image: myapp/consumer:1.0
          env:
          - name: RABBITMQ_URL
            valueFrom:
              secretKeyRef:
                name: rabbitmq-credentials
                key: url
          - name: PREFETCH_COUNT
            value: "5"
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "1"
              memory: "1Gi"
  pollingInterval: 5
  cooldownPeriod: 60
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
  - type: rabbitmq
    metadata:
      queueName: work.items
      mode: QueueLength
      value: "5"  # Create job group per 5 messages
    authenticationRef:
      name: rabbitmq-auth
```

### KEDA ScaledJob for AWS SQS

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: aws-sqs-auth
  namespace: batch
spec:
  podIdentity:
    provider: aws
    identityId: arn:aws:iam::123456789012:role/keda-sqs-reader
---
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: sqs-processor
  namespace: batch
spec:
  jobTargetRef:
    completions: 1
    parallelism: 1
    backoffLimit: 2
    template:
      spec:
        serviceAccountName: sqs-processor-sa
        restartPolicy: OnFailure
        containers:
        - name: processor
          image: myapp/sqs-processor:1.0
          env:
          - name: SQS_QUEUE_URL
            value: https://sqs.us-east-1.amazonaws.com/123456789012/my-queue
          - name: AWS_DEFAULT_REGION
            value: us-east-1
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
  pollingInterval: 30
  cooldownPeriod: 120
  minReplicaCount: 0
  maxReplicaCount: 100
  scalingStrategy:
    strategy: "accurate"
  triggers:
  - type: aws-sqs-queue
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/my-queue
      queueLength: "1"
      awsRegion: us-east-1
    authenticationRef:
      name: aws-sqs-auth
```

## Job Cleanup Strategies

### Automatic TTL Cleanup

```yaml
# All jobs get TTL via admission webhook
apiVersion: v1
kind: ConfigMap
metadata:
  name: job-defaults
  namespace: kube-system
# Set globally in admission webhook or use Kyverno policy
```

### Kyverno Policy for Automatic TTL

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-job-ttl-policy
spec:
  rules:
  - name: add-ttl
    match:
      any:
      - resources:
          kinds: [Job]
          namespaces: [production, staging, batch]
    exclude:
      resources:
        annotations:
          batch.kubernetes.io/no-ttl: "true"
    mutate:
      patchStrategicMerge:
        spec:
          +(ttlSecondsAfterFinished): 86400  # 24 hours
```

### Manual Cleanup Script

```bash
#!/bin/bash
# cleanup-completed-jobs.sh

NAMESPACE=${1:-"production"}
MAX_AGE_HOURS=${2:-24}

echo "Cleaning up completed jobs in namespace: $NAMESPACE"
echo "Maximum age: $MAX_AGE_HOURS hours"

# Delete completed jobs older than MAX_AGE_HOURS
kubectl get jobs -n "$NAMESPACE" \
  --field-selector=status.completionTime!='' \
  -o json | \
  jq -r --argjson age_limit "$(($(date +%s) - MAX_AGE_HOURS * 3600))" \
  '.items[] |
    select(
      (.status.completionTime | fromdateiso8601) < $age_limit
    ) |
    .metadata.name' | \
  while read -r job; do
    echo "Deleting completed job: $job"
    kubectl delete job "$job" -n "$NAMESPACE" --cascade=foreground
  done

# Delete failed jobs older than 7 days
kubectl get jobs -n "$NAMESPACE" -o json | \
  jq -r --argjson age_limit "$(($(date +%s) - 7 * 86400))" \
  '.items[] |
    select(
      .status.failed != null and
      .status.failed > 0 and
      (.metadata.creationTimestamp | fromdateiso8601) < $age_limit
    ) |
    .metadata.name' | \
  while read -r job; do
    echo "Deleting old failed job: $job"
    kubectl delete job "$job" -n "$NAMESPACE"
  done

echo "Cleanup complete"
```

## Priority and Preemption for Batch Jobs

### PriorityClass Configuration

```yaml
# High priority for time-sensitive batch
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-high-priority
value: 1000
globalDefault: false
description: "High priority batch jobs (SLA-bound)"
---
# Low priority for background processing
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch-low-priority
value: 100
globalDefault: false
description: "Low priority batch jobs (best-effort, preemptible)"
preemptionPolicy: Never  # Never preempt other pods
---
# Apply to CronJob
apiVersion: batch/v1
kind: CronJob
metadata:
  name: background-analytics
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          priorityClassName: batch-low-priority
          containers:
          - name: analytics
            image: myapp/analytics:1.0
```

## Job Monitoring and Alerting

### PrometheusRule for Job Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: job-alerts
  namespace: monitoring
spec:
  groups:
  - name: kubernetes.jobs
    interval: 30s
    rules:
    - alert: KubernetesJobFailed
      expr: |
        kube_job_status_failed > 0
      for: 1m
      labels:
        severity: warning
      annotations:
        summary: "Job {{ $labels.job_name }} has {{ $value }} failed completions"
        description: "Job {{ $labels.namespace }}/{{ $labels.job_name }} is failing"

    - alert: KubernetesJobNotCompleted
      expr: |
        (time() - kube_job_status_start_time) > 7200
        and kube_job_status_active > 0
        and kube_job_status_succeeded == 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Job {{ $labels.job_name }} running for 2+ hours without completion"

    - alert: CronJobMissedSchedule
      expr: |
        kube_cronjob_status_last_schedule_time - kube_cronjob_spec_starting_deadline_seconds < time() - 600
      labels:
        severity: critical
      annotations:
        summary: "CronJob {{ $labels.cronjob }} missed its schedule"

    - alert: CronJobTooLong
      expr: |
        time() - kube_cronjob_status_last_schedule_time > 3600
        and kube_cronjob_status_active == 0
      labels:
        severity: warning
      annotations:
        summary: "CronJob {{ $labels.cronjob }} has not run in 1+ hour"
```

### Job Status Dashboard Query

```bash
# Prometheus queries for Grafana dashboard

# Job success rate (last 24h)
sum(kube_job_status_succeeded) /
(sum(kube_job_status_succeeded) + sum(kube_job_status_failed))

# Average job duration by job name
avg by (job_name, namespace) (
  kube_job_status_completion_time - kube_job_status_start_time
)

# Currently running jobs
sum by (namespace, job_name) (kube_job_status_active > 0)

# Failed jobs in last hour
sum by (namespace, job_name) (
  increase(kube_job_status_failed[1h]) > 0
)
```

## Job Debugging and Troubleshooting

### Common Failure Patterns

```bash
# 1. Job pod stuck in Pending
kubectl describe pod -l job-name=my-job -n production

# Common causes:
# - Insufficient resources: check resource requests vs node capacity
# - Node taints: check pod tolerations
# - PVC pending: check storage provisioning
# - Image pull failures: check imagePullSecrets

# 2. Job stuck at backoffLimit
kubectl get jobs my-job -n production
kubectl describe job my-job -n production

# View logs from failed pods
kubectl logs -l job-name=my-job -n production --previous

# 3. Job not cleaning up
kubectl get job my-job -n production -o jsonpath='{.spec.ttlSecondsAfterFinished}'

# 4. CronJob not firing
kubectl describe cronjob my-cronjob -n production
# Check: "Missed Schedules", "Last Schedule Time", "Active Jobs"

# Force trigger a CronJob manually
kubectl create job --from=cronjob/my-cronjob manual-run-$(date +%s) -n production
```

### Job Debugging Pod

```yaml
# Launch a debugging pod with same environment as Job
apiVersion: v1
kind: Pod
metadata:
  name: job-debug
  namespace: production
spec:
  restartPolicy: Never
  serviceAccountName: migration-sa
  containers:
  - name: debug
    image: myapp/worker:1.0
    command: ["/bin/bash"]
    args: ["-c", "sleep 3600"]
    env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: db-credentials
          key: url
    resources:
      requests:
        cpu: "500m"
        memory: "1Gi"
```

## Job Resource Management

### Namespace-Level Resource Quota for Batch

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: batch-quota
  namespace: batch
spec:
  hard:
    # Limit total job count
    count/jobs.batch: "100"
    count/cronjobs.batch: "50"
    # Compute resources for all running job pods
    requests.cpu: "50"
    requests.memory: "100Gi"
    limits.cpu: "200"
    limits.memory: "400Gi"
    # Scope to non-terminating pods
  scopeSelector:
    matchExpressions:
    - operator: In
      scopeName: PriorityClass
      values: ["batch-high-priority", "batch-low-priority"]
---
apiVersion: v1
kind: LimitRange
metadata:
  name: batch-limits
  namespace: batch
spec:
  limits:
  - type: Container
    default:
      cpu: "1"
      memory: "1Gi"
    defaultRequest:
      cpu: "250m"
      memory: "256Mi"
    max:
      cpu: "16"
      memory: "64Gi"
  - type: Pod
    max:
      cpu: "64"
      memory: "256Gi"
```

Kubernetes Jobs and CronJobs, combined with KEDA ScaledJob for event-driven scaling, provide a complete platform for batch and queue-based workloads. The key production patterns are: using indexed jobs for deterministic sharding, implementing proper exit code handling in podFailurePolicy, setting appropriate TTL values to prevent resource accumulation, and using KEDA to dynamically right-size worker pools based on actual queue depth. These patterns together eliminate the overprovisioning and under-utilization that plague static batch processing deployments.
