---
title: "Kubernetes Job Patterns: Work Queues, Indexed Jobs, and Completion Policies"
date: 2029-10-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Jobs", "Batch", "Work Queues", "CronJob", "Parallelism"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Job patterns including indexed completion mode, work queue jobs, completion policies, pod failure policies, backoffLimit configuration, and parallelism tuning for production batch workloads."
more_link: "yes"
url: "/kubernetes-job-patterns-work-queues-indexed-completion/"
---

Kubernetes Jobs are the primary mechanism for batch workload execution, but the default configuration — a single pod that must complete successfully — covers only the simplest use case. Production batch systems have complex requirements: parallel processing across thousands of tasks, graceful handling of partial failures, work queues backed by external message brokers, and completion policies that determine when the overall Job is considered done.

Kubernetes 1.21 introduced Indexed Jobs, 1.25 introduced Pod Failure Policy, and subsequent releases have refined the completion policy model significantly. This guide covers the full spectrum of production Job patterns.

<!--more-->

# Kubernetes Job Patterns: Work Queues, Indexed Jobs, and Completion Policies

## Section 1: Job Fundamentals

### Basic Job Anatomy

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: basic-job
spec:
  # Total number of successful completions required
  completions: 1

  # Maximum parallel pod executions
  parallelism: 1

  # Maximum number of retries before marking Job as failed
  backoffLimit: 3

  # Time limit for the entire Job (seconds)
  activeDeadlineSeconds: 600

  # When pods should be cleaned up after completion
  ttlSecondsAfterFinished: 86400  # 24 hours

  template:
    spec:
      restartPolicy: Never  # or OnFailure
      containers:
        - name: worker
          image: batch-worker:v1.0.0
          command: ["./process", "--input", "data.json"]
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
```

### restartPolicy Semantics

The `restartPolicy` on a Job's pod template has different semantics than on Deployments:

```yaml
# restartPolicy: Never
# - Pod failure increments backoffLimit counter
# - New pod is created for each retry
# - Failed pods are preserved (for log analysis) until Job TTL expires
# - Use when: you need to examine failed pods, or failures should count against backoffLimit

# restartPolicy: OnFailure
# - Container is restarted within the same pod on failure
# - Restarts within a pod don't count against backoffLimit (only pod-level failures do)
# - Pod IP/hostname are preserved across restarts
# - Use when: container exits are expected (e.g., OOM, transient errors) and restart is cheap
```

## Section 2: Indexed Jobs

Indexed Jobs (completionMode: Indexed) assign each pod a unique index from 0 to completions-1. This enables embarrassingly parallel workloads where each worker knows exactly which partition of work to process.

### Basic Indexed Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: indexed-data-processor
spec:
  completions: 100          # 100 total tasks
  parallelism: 10           # 10 workers at a time
  completionMode: Indexed   # Each pod gets a unique index

  template:
    spec:
      restartPolicy: Never
      containers:
        - name: processor
          image: data-processor:v2.0.0
          command:
            - /bin/sh
            - -c
            - |
              # JOB_COMPLETION_INDEX is set by Kubernetes (0-99)
              echo "Processing shard $JOB_COMPLETION_INDEX of 99"
              ./process \
                --shard-index "$JOB_COMPLETION_INDEX" \
                --shard-count "100" \
                --input-bucket "s3://my-data-bucket" \
                --output-bucket "s3://my-results-bucket"
          env:
            # JOB_COMPLETION_INDEX is automatically injected
            - name: JOB_COMPLETION_INDEX
              valueFrom:
                fieldRef:
                  fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
```

### Indexed Job with ConfigMap Data Distribution

```yaml
# data-config.yaml — provides shard definitions to each worker
apiVersion: v1
kind: ConfigMap
metadata:
  name: shard-config
data:
  shards.json: |
    [
      {"index": 0, "start": "2024-01-01", "end": "2024-01-07"},
      {"index": 1, "start": "2024-01-08", "end": "2024-01-14"},
      {"index": 2, "start": "2024-01-15", "end": "2024-01-21"}
    ]
---
apiVersion: batch/v1
kind: Job
metadata:
  name: date-range-processor
spec:
  completions: 3
  parallelism: 3
  completionMode: Indexed
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: processor
          image: data-processor:v2.0.0
          command:
            - python3
            - -c
            - |
              import json
              import os

              index = int(os.environ['JOB_COMPLETION_INDEX'])
              with open('/config/shards.json') as f:
                  shards = json.load(f)

              shard = shards[index]
              print(f"Processing shard {index}: {shard['start']} to {shard['end']}")
              # Process the date range...
          volumeMounts:
            - name: config
              mountPath: /config
      volumes:
        - name: config
          configMap:
            name: shard-config
```

### Indexed Job with Hostname-Based Routing

Indexed Jobs also set the pod's hostname to `<job-name>-<index>`, enabling Raft-style election or partitioned databases to use stable identities:

```go
package main

import (
    "fmt"
    "os"
    "strconv"
)

func main() {
    // JOB_COMPLETION_INDEX available via env
    indexStr := os.Getenv("JOB_COMPLETION_INDEX")
    index, err := strconv.Atoi(indexStr)
    if err != nil {
        // Fall back to hostname parsing
        hostname, _ := os.Hostname()
        fmt.Sscanf(hostname, "indexed-processor-%d", &index)
    }

    totalWorkers := 100 // Should match spec.completions

    // Calculate this worker's range
    totalItems := 1_000_000
    itemsPerWorker := totalItems / totalWorkers
    start := index * itemsPerWorker
    end := start + itemsPerWorker
    if index == totalWorkers-1 {
        end = totalItems // Last worker gets remainder
    }

    fmt.Printf("Worker %d processing items %d-%d\n", index, start, end)
    processRange(start, end)
}
```

## Section 3: Work Queue Jobs

Work queue jobs don't have a fixed number of tasks — they pull work from an external queue (RabbitMQ, SQS, Redis, etc.) until the queue is empty.

### Work Queue Pattern with Redis

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: queue-processor
spec:
  # Don't set completions — let workers drain the queue
  parallelism: 20
  backoffLimit: 10

  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: worker
          image: queue-worker:v1.0.0
          command:
            - /bin/sh
            - -c
            - |
              #!/bin/bash
              # Worker exits with 0 when queue is empty
              # Worker exits with non-zero on processing errors

              while true; do
                # Try to dequeue a task (blocking with timeout)
                TASK=$(redis-cli -h redis-service BLPOP work-queue 30)

                if [ -z "$TASK" ]; then
                    echo "Queue empty or timeout — worker exiting"
                    exit 0
                fi

                # Process the task
                echo "Processing: $TASK"
                ./process-task "$TASK"

                if [ $? -ne 0 ]; then
                    echo "Task failed: $TASK"
                    # Push to dead-letter queue
                    redis-cli -h redis-service LPUSH dead-letter-queue "$TASK"
                    # Continue processing — don't exit on single task failure
                fi
              done
          env:
            - name: REDIS_HOST
              value: "redis-service"
```

### Work Queue with SQS

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/sqs"
    "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

type SQSWorker struct {
    client   *sqs.Client
    queueURL string
}

func NewSQSWorker(ctx context.Context, queueURL string) (*SQSWorker, error) {
    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return nil, fmt.Errorf("load config: %w", err)
    }

    return &SQSWorker{
        client:   sqs.NewFromConfig(cfg),
        queueURL: queueURL,
    }, nil
}

func (w *SQSWorker) Run(ctx context.Context) error {
    emptyPolls := 0
    const maxEmptyPolls = 3 // Exit after 3 empty polls (queue is drained)

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Long-poll for messages
        result, err := w.client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
            QueueUrl:            &w.queueURL,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds:     20, // Long polling
            VisibilityTimeout:   300, // 5 minutes to process
            MessageAttributeNames: []string{"All"},
        })
        if err != nil {
            return fmt.Errorf("receive message: %w", err)
        }

        if len(result.Messages) == 0 {
            emptyPolls++
            log.Printf("Empty poll %d/%d", emptyPolls, maxEmptyPolls)
            if emptyPolls >= maxEmptyPolls {
                log.Println("Queue appears empty, exiting")
                return nil
            }
            continue
        }

        emptyPolls = 0

        for _, msg := range result.Messages {
            if err := w.processMessage(ctx, msg); err != nil {
                log.Printf("Failed to process message %s: %v", *msg.MessageId, err)
                // Message will become visible again after VisibilityTimeout
                continue
            }

            // Delete successfully processed message
            _, err := w.client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
                QueueUrl:      &w.queueURL,
                ReceiptHandle: msg.ReceiptHandle,
            })
            if err != nil {
                log.Printf("Failed to delete message %s: %v", *msg.MessageId, err)
            }
        }
    }
}

func (w *SQSWorker) processMessage(ctx context.Context, msg types.Message) error {
    log.Printf("Processing message: %s", *msg.Body)
    // Simulate processing
    time.Sleep(100 * time.Millisecond)
    return nil
}

func main() {
    queueURL := os.Getenv("SQS_QUEUE_URL")
    if queueURL == "" {
        log.Fatal("SQS_QUEUE_URL required")
    }

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGTERM, syscall.SIGINT)
    defer cancel()

    worker, err := NewSQSWorker(ctx, queueURL)
    if err != nil {
        log.Fatalf("Failed to create worker: %v", err)
    }

    if err := worker.Run(ctx); err != nil && err != context.Canceled {
        log.Fatalf("Worker error: %v", err)
    }

    log.Println("Worker completed successfully")
}
```

## Section 4: Pod Failure Policy

Kubernetes 1.25+ allows fine-grained control over how different pod failure types are handled via `podFailurePolicy`.

### Pod Failure Policy Configuration

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: smart-failure-handling
spec:
  completions: 100
  parallelism: 10
  completionMode: Indexed
  backoffLimit: 6

  # Pod Failure Policy — available since 1.25
  podFailurePolicy:
    rules:
      # Rule 1: Ignore node preemption — don't count as failure
      - action: Ignore
        onPodConditions:
          - type: DisruptionTarget

      # Rule 2: Fail immediately on OOMKilled — don't retry
      - action: FailJob
        onContainerStatuses:
          - name: processor
            state:
              terminated:
                reason: OOMKilled

      # Rule 3: Fail immediately on non-retriable exit codes
      - action: FailJob
        onContainerStatuses:
          - name: processor
            state:
              terminated:
                exitCodes:
                  operator: In
                  values:
                    - 1   # Generic unrecoverable error
                    - 42  # Invalid input — no point retrying

      # Rule 4: Count as failure (and retry) on retriable exit codes
      - action: Count
        onContainerStatuses:
          - name: processor
            state:
              terminated:
                exitCodes:
                  operator: In
                  values:
                    - 2   # Temporary resource unavailable
                    - 3   # Downstream service timeout

  template:
    spec:
      restartPolicy: Never
      containers:
        - name: processor
          image: data-processor:v2.0.0
          command:
            - /bin/bash
            - -c
            - |
              # Exit code convention:
              # 0   = Success
              # 1   = Unrecoverable error (bad input data)
              # 2   = Retriable error (network timeout)
              # 3   = Downstream unavailable
              # 42  = Invalid index — should never happen

              INDEX=$JOB_COMPLETION_INDEX
              echo "Processing shard $INDEX"

              if ! ./validate-shard "$INDEX"; then
                  echo "Invalid shard data for index $INDEX"
                  exit 1  # FailJob immediately
              fi

              if ! ./process-shard "$INDEX"; then
                  EXIT_CODE=$?
                  echo "Processing failed with exit code $EXIT_CODE"
                  exit $EXIT_CODE
              fi

              echo "Shard $INDEX complete"
              exit 0
```

### Implementing Exit Code Standards in Workers

```go
package exitcodes

// Standard exit codes for Kubernetes Job workers
const (
    Success            = 0
    Unrecoverable      = 1  // Don't retry; FailJob
    TransientError     = 2  // Retry allowed
    ServiceUnavailable = 3  // Retry allowed
    InvalidConfig      = 42 // Don't retry; FailJob
)

// WorkerError carries context about a worker failure.
type WorkerError struct {
    Code    int
    Message string
    Cause   error
}

func (e *WorkerError) Error() string {
    if e.Cause != nil {
        return fmt.Sprintf("[exit %d] %s: %v", e.Code, e.Message, e.Cause)
    }
    return fmt.Sprintf("[exit %d] %s", e.Code, e.Message)
}

// ExitWithCode terminates the process with the appropriate exit code
// after logging context.
func ExitWithCode(err *WorkerError) {
    if err == nil {
        os.Exit(Success)
    }
    log.Printf("Fatal: %v", err)
    os.Exit(err.Code)
}

// Example usage in a worker
func main() {
    index := mustGetIndex()

    if err := validateInput(index); err != nil {
        ExitWithCode(&WorkerError{
            Code:    Unrecoverable,
            Message: "input validation failed",
            Cause:   err,
        })
    }

    if err := callDownstreamService(index); err != nil {
        ExitWithCode(&WorkerError{
            Code:    ServiceUnavailable,
            Message: "downstream service error",
            Cause:   err,
        })
    }

    ExitWithCode(nil)
}
```

## Section 5: Job Parallelism Tuning

### Amdahl's Law Applied to Jobs

The speedup from parallelism is limited by the sequential fraction of the work:

```bash
# Calculate optimal parallelism
# Rule of thumb: parallelism = sqrt(completions) for most batch workloads
# For IO-bound: parallelism = completions / avg_io_wait_fraction

COMPLETIONS=1000
OPTIMAL_PARALLELISM=$(echo "sqrt($COMPLETIONS)" | bc)
echo "Suggested parallelism for $COMPLETIONS tasks: $OPTIMAL_PARALLELISM"

# Also consider cluster capacity:
# parallelism = min(sqrt(completions), available_cores)
```

### Dynamic Parallelism via HPA

Kubernetes 1.23+ supports scaling Job parallelism via the HPA when backed by custom metrics:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: job-parallelism-scaler
spec:
  scaleTargetRef:
    apiVersion: batch/v1
    kind: Job
    name: queue-processor
  minReplicas: 1
  maxReplicas: 50
  metrics:
    - type: External
      external:
        metric:
          name: sqs_queue_messages_visible
          selector:
            matchLabels:
              queue: "work-queue"
        target:
          type: AverageValue
          averageValue: "100"  # Scale up when >100 messages per pod
```

### Manual Parallelism Scaling

```bash
# Increase parallelism for a running job
kubectl patch job my-job --type=merge \
  -p '{"spec":{"parallelism":50}}'

# Pause a job by setting parallelism to 0
kubectl patch job my-job --type=merge \
  -p '{"spec":{"parallelism":0}}'

# Resume
kubectl patch job my-job --type=merge \
  -p '{"spec":{"parallelism":10}}'
```

## Section 6: Completion Policies

### completions vs. parallelism Interaction

```yaml
# Pattern 1: Strict sequential execution (completions=5, parallelism=1)
# Runs one pod at a time, 5 total
spec:
  completions: 5
  parallelism: 1

# Pattern 2: Full parallel (completions=5, parallelism=5)
# Runs all 5 simultaneously; fastest
spec:
  completions: 5
  parallelism: 5

# Pattern 3: Batched (completions=100, parallelism=10)
# 10 pods run at a time; 10 batches of 10
spec:
  completions: 100
  parallelism: 10

# Pattern 4: Work queue (no completions, parallelism=N)
# Workers self-terminate when queue is empty
spec:
  parallelism: 20
  # No completions field — Job completes when all pods succeed
```

### Completion Modes

```yaml
# NonIndexed (default): Job is done when `completions` pods succeed
# Each successful pod is equivalent
completionMode: NonIndexed

# Indexed: Each pod from index 0 to completions-1 must succeed once
# Provides JOB_COMPLETION_INDEX env to each pod
completionMode: Indexed
```

## Section 7: backoffLimit and Failure Management

### Understanding backoffLimit

`backoffLimit` controls the maximum number of pod failures before the Job is marked failed:

```yaml
# With backoffLimit: 6 (default), the Job tries up to 7 times
# (6 failures + 1 that must succeed)
backoffLimit: 6

# The backoff delay increases exponentially:
# Attempt 1: immediate
# Attempt 2: 10 seconds delay
# Attempt 3: 20 seconds delay
# Attempt 4: 40 seconds delay
# Attempt 5: 80 seconds delay
# Attempt 6: 160 seconds delay
```

### Failure Analysis After a Failed Job

```bash
#!/bin/bash
# analyze-job-failures.sh — Post-mortem analysis for failed Jobs

JOB_NAME=$1
NAMESPACE=${2:-default}

echo "=== Job Status ==="
kubectl get job $JOB_NAME -n $NAMESPACE -o yaml | \
  grep -A20 "^status:"

echo ""
echo "=== Failed Pods ==="
kubectl get pods -n $NAMESPACE \
  --selector=job-name=$JOB_NAME \
  --field-selector=status.phase=Failed \
  -o wide

echo ""
echo "=== Exit Codes Summary ==="
kubectl get pods -n $NAMESPACE \
  --selector=job-name=$JOB_NAME \
  -o json | jq -r '
  .items[] |
  select(.status.phase == "Failed") |
  {
    pod: .metadata.name,
    index: .metadata.annotations["batch.kubernetes.io/job-completion-index"],
    exitCode: .status.containerStatuses[0].state.terminated.exitCode,
    reason: .status.containerStatuses[0].state.terminated.reason,
    message: .status.containerStatuses[0].state.terminated.message
  }' | jq -s 'group_by(.exitCode) | map({exitCode: .[0].exitCode, count: length, reason: .[0].reason})'

echo ""
echo "=== Last Pod Logs ==="
LAST_FAILED_POD=$(kubectl get pods -n $NAMESPACE \
  --selector=job-name=$JOB_NAME \
  --field-selector=status.phase=Failed \
  -o jsonpath='{.items[-1].metadata.name}')

if [ -n "$LAST_FAILED_POD" ]; then
    echo "Logs from $LAST_FAILED_POD:"
    kubectl logs -n $NAMESPACE $LAST_FAILED_POD --previous 2>/dev/null || \
    kubectl logs -n $NAMESPACE $LAST_FAILED_POD
fi
```

## Section 8: CronJob Patterns

```yaml
# Production CronJob with all safety features
apiVersion: batch/v1
kind: CronJob
metadata:
  name: daily-report
spec:
  schedule: "0 2 * * *"  # 2 AM daily

  # Prevent overlapping runs
  concurrencyPolicy: Forbid  # or Allow or Replace

  # Keep history
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5

  # Start deadline (skip if can't start within X seconds)
  startingDeadlineSeconds: 300

  # Suspend the CronJob without deleting it
  suspend: false

  jobTemplate:
    spec:
      completions: 1
      parallelism: 1
      backoffLimit: 2
      activeDeadlineSeconds: 3600  # 1 hour max
      ttlSecondsAfterFinished: 86400

      template:
        spec:
          restartPolicy: Never
          serviceAccountName: report-generator
          containers:
            - name: reporter
              image: report-generator:v2.1.0
              command: ["./generate-report", "--date", "$(date -d yesterday +%Y-%m-%d)"]
              resources:
                requests:
                  cpu: "500m"
                  memory: "1Gi"
                limits:
                  cpu: "2"
                  memory: "4Gi"
```

### CronJob Monitoring and Alerting

```yaml
# PrometheusRule for CronJob health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cronjob-alerts
  namespace: monitoring
spec:
  groups:
    - name: cronjob.rules
      rules:
        # Alert if CronJob hasn't run in the expected interval
        - alert: CronJobNotRunning
          expr: |
            (time() - kube_cronjob_status_last_schedule_time{job="kube-state-metrics"})
            > 86400 + 3600
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CronJob {{ $labels.cronjob }} has not run in 25+ hours"

        # Alert if CronJob has too many recent failures
        - alert: CronJobHighFailureRate
          expr: |
            increase(kube_job_failed{job="kube-state-metrics"}[24h])
            > 3
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "CronJob has {{ $value }} failures in the last 24h"

        # Alert if Job is running too long
        - alert: JobRunningTooLong
          expr: |
            (time() - kube_job_status_start_time{job="kube-state-metrics"})
            * kube_job_status_active{job="kube-state-metrics"} > 7200
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "Job {{ $labels.job_name }} has been running for > 2 hours"
```

## Section 9: Advanced Patterns — Job Fan-Out

The Job fan-out pattern creates many Jobs dynamically based on input data:

```go
package fanout

import (
    "context"
    "fmt"

    batchv1 "k8s.io/api/batch/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

type JobFanOut struct {
    client    client.Client
    namespace string
}

// CreateShardJobs creates one Job per data shard.
func (f *JobFanOut) CreateShardJobs(
    ctx context.Context,
    parentName string,
    shards []ShardConfig,
) error {
    for i, shard := range shards {
        job := f.buildShardJob(parentName, i, shard)

        if err := f.client.Create(ctx, job); err != nil {
            return fmt.Errorf("failed to create shard %d job: %w", i, err)
        }

        fmt.Printf("Created shard job %s\n", job.Name)
    }
    return nil
}

func (f *JobFanOut) buildShardJob(
    parentName string,
    index int,
    shard ShardConfig,
) *batchv1.Job {
    completions := int32(1)
    backoffLimit := int32(3)

    return &batchv1.Job{
        ObjectMeta: metav1.ObjectMeta{
            Name:      fmt.Sprintf("%s-shard-%04d", parentName, index),
            Namespace: f.namespace,
            Labels: map[string]string{
                "app.kubernetes.io/part-of":  parentName,
                "app.kubernetes.io/instance": fmt.Sprintf("shard-%d", index),
                "batch.example.com/shard":    fmt.Sprintf("%d", index),
            },
        },
        Spec: batchv1.JobSpec{
            Completions:  &completions,
            BackoffLimit: &backoffLimit,
            Template: corev1.PodTemplateSpec{
                Spec: corev1.PodSpec{
                    RestartPolicy: corev1.RestartPolicyNever,
                    Containers: []corev1.Container{
                        {
                            Name:  "worker",
                            Image: "data-processor:v2.0.0",
                            Env: []corev1.EnvVar{
                                {Name: "SHARD_INDEX", Value: fmt.Sprintf("%d", index)},
                                {Name: "SHARD_START", Value: shard.Start},
                                {Name: "SHARD_END", Value: shard.End},
                            },
                        },
                    },
                },
            },
        },
    }
}

// WaitForAllJobs polls until all shard Jobs complete or one fails.
func (f *JobFanOut) WaitForAllJobs(
    ctx context.Context,
    parentName string,
    shardCount int,
) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        jobList := &batchv1.JobList{}
        if err := f.client.List(ctx, jobList,
            client.InNamespace(f.namespace),
            client.MatchingLabels{
                "app.kubernetes.io/part-of": parentName,
            },
        ); err != nil {
            return fmt.Errorf("failed to list jobs: %w", err)
        }

        var completed, failed int
        for _, job := range jobList.Items {
            if job.Status.Succeeded > 0 {
                completed++
            }
            if job.Status.Failed > 0 && job.Status.Active == 0 {
                failed++
            }
        }

        fmt.Printf("Progress: %d/%d completed, %d failed\n",
            completed, shardCount, failed)

        if failed > 0 {
            return fmt.Errorf("%d shard jobs failed", failed)
        }

        if completed >= shardCount {
            return nil
        }

        time.Sleep(10 * time.Second)
    }
}
```

## Section 10: Job Observability

### Comprehensive Job Metrics

```promql
# Jobs currently running
sum(kube_job_status_active) by (job_name, namespace)

# Job success rate over 24h
sum(increase(kube_job_status_succeeded[24h])) by (job_name)
/
(sum(increase(kube_job_status_succeeded[24h])) by (job_name)
+ sum(increase(kube_job_status_failed[24h])) by (job_name))

# Average job duration
avg(
  kube_job_status_completion_time - kube_job_status_start_time
) by (job_name)

# Pods currently backoff-waiting (indicates retries in progress)
sum(kube_pod_status_phase{phase="Pending"}) by (job_name)
```

### Job Dashboard ConfigMap for Grafana

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: job-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  jobs.json: |
    {
      "title": "Kubernetes Jobs",
      "panels": [
        {
          "title": "Active Jobs",
          "type": "stat",
          "targets": [{
            "expr": "sum(kube_job_status_active)"
          }]
        },
        {
          "title": "Job Success Rate (24h)",
          "type": "gauge",
          "targets": [{
            "expr": "sum(increase(kube_job_status_succeeded[24h])) / (sum(increase(kube_job_status_succeeded[24h])) + sum(increase(kube_job_status_failed[24h]))) * 100"
          }]
        }
      ]
    }
```

## Summary

Kubernetes Jobs have evolved from simple single-pod batch executions to a comprehensive batch processing framework. Key production patterns:

- **Indexed Jobs** (`completionMode: Indexed`) are the correct choice for embarrassingly parallel workloads where each task is uniquely identified — use `JOB_COMPLETION_INDEX` for partition-based processing
- **Work Queue Jobs** (no `completions`, workers self-terminate) are appropriate for queue-drain patterns with RabbitMQ, SQS, or Redis backends
- **Pod Failure Policy** (1.25+) enables nuanced failure handling: ignore preemptions, fail immediately on OOM, retry on transient errors — this dramatically reduces operational toil from spurious retries
- **backoffLimit** tuning should match the failure characteristics of the workload: 0 for idempotent one-shot jobs, 6+ for jobs with transient infrastructure failures
- **CronJob concurrencyPolicy: Forbid** prevents cascading failures when jobs run longer than their schedule period
- **parallelism = sqrt(completions)** is a reasonable starting heuristic; tune based on available cluster capacity and workload characteristics

The combination of Indexed Jobs with Pod Failure Policy represents the current state of the art for production batch workloads on Kubernetes, providing both task uniqueness guarantees and intelligent failure classification.
