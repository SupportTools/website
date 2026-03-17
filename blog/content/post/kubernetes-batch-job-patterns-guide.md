---
title: "Kubernetes Batch Processing: Job Patterns, CronJobs, and Work Queues"
date: 2028-02-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Batch", "Jobs", "CronJob", "KEDA", "Volcano", "Redis"]
categories:
- Kubernetes
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes batch processing covering Job completion modes, CronJob timezone support, work queue patterns with Redis, job suspend/resume, TTL controllers, and advanced scheduling with Volcano and KEDA."
more_link: "yes"
url: "/kubernetes-batch-job-patterns-guide/"
---

Kubernetes was originally designed for long-running services, but batch workloads represent a significant share of enterprise compute. Data pipelines, ML training runs, report generation, database maintenance, and ETL processes all have different requirements from web servers: they run to completion, often need parallelism across sharded input, must handle partial failures without rerunning completed work, and need scheduling that respects business calendars and time zones.

Modern Kubernetes provides sophisticated primitives for all of these patterns. The `Job` API has matured to support indexed completion, work queue consumption, and controlled parallelism. `CronJob` gained timezone support. The TTL controller automates cleanup. KEDA and Volcano extend the native API for enterprise batch scheduling requirements.

<!--more-->

# Kubernetes Batch Processing: Job Patterns, CronJobs, and Work Queues

## Job Fundamentals

A Kubernetes Job creates one or more Pods and ensures a specified number of them successfully terminate. Unlike Deployments, Jobs track completion rather than availability.

### Basic Job Structure

```yaml
# simple-job.yaml
# A single-completion Job that processes a batch task.
# The Job controller will restart the Pod if it fails,
# up to backoffLimit times.
apiVersion: batch/v1
kind: Job
metadata:
  name: database-migration
  namespace: production
  labels:
    batch.type: migration
    app.version: "v2.1.0"
spec:
  # Maximum number of retries before marking the Job failed
  backoffLimit: 3

  # Delete Pod after this many seconds after Job completion
  # Keeps cluster clean without manual cleanup
  ttlSecondsAfterFinished: 3600   # 1 hour

  # Timeout: fail the Job if it runs longer than this
  activeDeadlineSeconds: 1800     # 30 minutes

  template:
    metadata:
      labels:
        batch.type: migration
    spec:
      # Never restart: Job controller handles retries via new Pods
      restartPolicy: Never

      # Run on dedicated batch nodes to avoid disrupting services
      nodeSelector:
        workload-type: batch

      tolerations:
      - key: "batch-only"
        operator: "Exists"
        effect: "NoSchedule"

      containers:
      - name: migrator
        image: myregistry/db-migrator:v2.1.0
        command: ["./migrate", "--env", "production", "--direction", "up"]
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: url
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
```

### backoffLimit Strategy

The `backoffLimit` field controls retry behavior, but the interaction with `restartPolicy` is subtle:

```yaml
# backoff-strategies.yaml
# Different backoff configurations for different failure scenarios

# Strategy 1: Transient failures (network timeouts, temporary unavailability)
# Retry generously with exponential backoff (10s, 20s, 40s, 80s...)
spec:
  backoffLimit: 6
  backoffLimitPerIndex: 3     # Per-index retry limit (indexed jobs)
  template:
    spec:
      restartPolicy: OnFailure  # Restart same Pod (faster for transient errors)

---
# Strategy 2: Data-processing jobs (failure is likely non-transient)
# Fail fast, do not waste resources on repeated attempts
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never      # Create new Pod per attempt (clean state)

---
# Strategy 3: Jobs requiring fresh environment per attempt
# Use Never restart policy to ensure clean state
spec:
  backoffLimit: 3
  podFailurePolicy:            # Kubernetes 1.26+: fine-grained failure handling
    rules:
    # Do not count OOM kills as backoff (resource issue, not code bug)
    - action: Ignore
      onExitCodes:
        operator: In
        values: [137]          # SIGKILL (exit code 128+9)
    # Count as failure for application errors
    - action: FailJob
      onExitCodes:
        operator: In
        values: [1, 2]         # Application error exit codes
    # Retry on infrastructure errors
    - action: Count
      onPodConditions:
      - type: DisruptionTarget  # Pod preempted or evicted
  template:
    spec:
      restartPolicy: Never
```

## Completion Modes: NonIndexed and Indexed

### NonIndexed Completion (Default)

NonIndexed Jobs run N independent pods to completion. Each pod is equivalent; there is no coordination between them:

```yaml
# nonindexed-parallel-job.yaml
# Processes N independent items where pods are interchangeable.
# Use when each pod fetches its own work from a queue.
apiVersion: batch/v1
kind: Job
metadata:
  name: image-thumbnail-generator
spec:
  completions: 100       # Need 100 successful completions total
  parallelism: 10        # Run up to 10 pods simultaneously
  completionMode: NonIndexed   # Default; pods are interchangeable

  template:
    spec:
      restartPolicy: Never
      containers:
      - name: thumbnailer
        image: myregistry/thumbnailer:v1.0
        command:
        - ./thumbnailer
        - --fetch-from-queue
        - --queue-url
        - "redis://redis.default.svc:6379/thumbnail-jobs"
        env:
        - name: WORKER_CONCURRENCY
          value: "1"
```

### Indexed Completion Mode

Indexed Jobs assign each pod a unique completion index (0 to completions-1), enabling sharded processing where each pod handles a known subset of work:

```yaml
# indexed-parallel-job.yaml
# Processes a sharded dataset where each pod handles one shard.
# JOB_COMPLETION_INDEX env var is set automatically by Kubernetes.
apiVersion: batch/v1
kind: Job
metadata:
  name: data-pipeline-sharded
  namespace: data-processing
spec:
  completions: 20          # Process 20 shards total
  parallelism: 5           # Run 5 shards concurrently
  completionMode: Indexed  # Each pod gets unique index 0-19

  template:
    metadata:
      labels:
        app: data-pipeline
    spec:
      restartPolicy: Never
      containers:
      - name: processor
        image: myregistry/data-processor:v2.0
        command:
        - ./process-shard
        env:
        # Automatically set by Kubernetes for Indexed jobs
        # Value: 0, 1, 2, ... completions-1
        - name: SHARD_INDEX
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['batch.kubernetes.io/job-completion-index']
        - name: TOTAL_SHARDS
          value: "20"
        - name: S3_BUCKET
          value: "data-lake-production"
        - name: INPUT_PREFIX
          value: "raw/2024/01/"
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 4000m
            memory: 8Gi
```

```go
// process-shard.go
// Example Go code that uses JOB_COMPLETION_INDEX for sharding.
// Each pod processes exactly 1/N of the total dataset.
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "strconv"

    "cloud.google.com/go/storage"
    "google.golang.org/api/iterator"
)

func main() {
    // Read shard assignment from environment
    // Set by Kubernetes for Indexed Jobs via downward API
    shardIndexStr := os.Getenv("SHARD_INDEX")
    totalShardsStr := os.Getenv("TOTAL_SHARDS")

    shardIndex, err := strconv.Atoi(shardIndexStr)
    if err != nil {
        log.Fatalf("invalid SHARD_INDEX %q: %v", shardIndexStr, err)
    }
    totalShards, err := strconv.Atoi(totalShardsStr)
    if err != nil {
        log.Fatalf("invalid TOTAL_SHARDS %q: %v", totalShardsStr, err)
    }

    log.Printf("Processing shard %d of %d", shardIndex, totalShards)

    ctx := context.Background()
    client, err := storage.NewClient(ctx)
    if err != nil {
        log.Fatalf("failed to create GCS client: %v", err)
    }
    defer client.Close()

    bucket := client.Bucket(os.Getenv("S3_BUCKET"))
    prefix := os.Getenv("INPUT_PREFIX")

    // List objects and filter to this shard's responsibility
    // Consistent hash: object belongs to this shard if
    //   hash(objectName) % totalShards == shardIndex
    it := bucket.Objects(ctx, &storage.Query{Prefix: prefix})
    for {
        attrs, err := it.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            log.Fatalf("failed to iterate objects: %v", err)
        }

        // Assign objects to shards using modulo of a stable hash
        // This ensures each object is processed exactly once
        objectShard := stableHash(attrs.Name) % totalShards
        if objectShard != shardIndex {
            continue  // Not this shard's responsibility
        }

        if err := processObject(ctx, bucket, attrs.Name); err != nil {
            // Exit non-zero to trigger Job retry for this shard
            log.Fatalf("failed to process %s: %v", attrs.Name, err)
        }
    }

    log.Printf("Shard %d completed successfully", shardIndex)
}

// stableHash returns a consistent hash of a string.
// Uses FNV-1a for simplicity; any consistent hash function works.
func stableHash(s string) int {
    h := uint32(2166136261) // FNV offset basis
    for _, c := range []byte(s) {
        h ^= uint32(c)
        h *= 16777619 // FNV prime
    }
    return int(h)
}

func processObject(ctx context.Context, bucket *storage.BucketHandle, name string) error {
    fmt.Printf("Processing: %s\n", name)
    // ... actual processing logic ...
    return nil
}
```

## Job Suspend and Resume

The `suspend` field enables pausing and resuming Jobs without deleting them. This is useful for implementing approval workflows, resource throttling during peak hours, or coordinated batch windows.

```yaml
# suspended-job.yaml
# Job created in suspended state; pods are not created until unsuspended.
# Useful for pre-creating jobs that run during off-peak windows.
apiVersion: batch/v1
kind: Job
metadata:
  name: weekly-report-generator
  namespace: reporting
  annotations:
    batch.schedule/window: "weekdays-off-hours"
spec:
  suspend: true            # Created suspended; no pods created yet
  completions: 1
  parallelism: 1
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
      - name: reporter
        image: myregistry/reporter:v3.0
        command: ["./generate-weekly-report"]
```

```bash
# Resume a suspended job (starts pod creation)
kubectl patch job weekly-report-generator \
  -n reporting \
  --type merge \
  --patch '{"spec":{"suspend":false}}'

# Suspend a running job (gracefully terminates active pods)
kubectl patch job weekly-report-generator \
  -n reporting \
  --type merge \
  --patch '{"spec":{"suspend":true}}'

# Check job state
kubectl get job weekly-report-generator -n reporting \
  -o jsonpath='{.spec.suspend} {.status.active} {.status.succeeded}'
```

```go
// job-scheduler.go
// Controller that suspends/resumes jobs based on business hours.
// Implements a simple batch scheduler that respects time windows.
package main

import (
    "context"
    "log"
    "time"

    batchv1 "k8s.io/api/batch/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
)

const (
    batchWindowStart = 22 // 10 PM
    batchWindowEnd   = 6  // 6 AM
    namespace        = "reporting"
    scheduledLabel   = "batch.schedule/window"
    offHoursValue    = "weekdays-off-hours"
)

func main() {
    config, err := rest.InClusterConfig()
    if err != nil {
        log.Fatalf("failed to get in-cluster config: %v", err)
    }

    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        log.Fatalf("failed to create client: %v", err)
    }

    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        if err := reconcileJobSchedule(context.Background(), clientset); err != nil {
            log.Printf("reconcile error: %v", err)
        }
    }
}

func reconcileJobSchedule(ctx context.Context, cs kubernetes.Interface) error {
    now := time.Now()
    inWindow := isInBatchWindow(now)

    // List jobs with the scheduled label
    jobs, err := cs.BatchV1().Jobs(namespace).List(ctx, metav1.ListOptions{
        LabelSelector: scheduledLabel + "=" + offHoursValue,
    })
    if err != nil {
        return fmt.Errorf("list jobs: %w", err)
    }

    for i := range jobs.Items {
        job := &jobs.Items[i]
        currentlySuspended := job.Spec.Suspend != nil && *job.Spec.Suspend

        // Suspend during business hours; resume during batch window
        shouldSuspend := !inWindow

        if currentlySuspended == shouldSuspend {
            continue  // Already in correct state
        }

        patch := fmt.Sprintf(`{"spec":{"suspend":%v}}`, shouldSuspend)
        if _, err := cs.BatchV1().Jobs(namespace).Patch(
            ctx,
            job.Name,
            types.MergePatchType,
            []byte(patch),
            metav1.PatchOptions{},
        ); err != nil {
            log.Printf("failed to patch job %s: %v", job.Name, err)
            continue
        }

        action := "resumed"
        if shouldSuspend {
            action = "suspended"
        }
        log.Printf("Job %s %s (in batch window: %v)", job.Name, action, inWindow)
    }

    return nil
}

// isInBatchWindow returns true if the current time is within the batch window.
// Window: weekdays 10 PM to 6 AM, all weekend hours.
func isInBatchWindow(t time.Time) bool {
    hour := t.Hour()
    weekday := t.Weekday()

    // All weekend hours are in the batch window
    if weekday == time.Saturday || weekday == time.Sunday {
        return true
    }

    // Weekday off-hours
    return hour >= batchWindowStart || hour < batchWindowEnd
}
```

## CronJobs with Timezone Support

Kubernetes 1.27+ provides native timezone support for CronJobs, replacing the common workaround of adjusting cron expressions manually for UTC offsets.

```yaml
# cronjob-timezone.yaml
# CronJob that runs at 2 AM US/Eastern time.
# Without timezone support, this would require offset calculation:
# 2 AM EST = 7 AM UTC (winter) / 2 AM EDT = 6 AM UTC (summer)
# DST changes would require manual cron expression updates.
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-etl
  namespace: data-processing
  annotations:
    cron.purpose: "Extract and transform previous day's transactions"
spec:
  # Business-friendly cron expression in the target timezone
  schedule: "0 2 * * *"

  # Native timezone support (Kubernetes 1.27+, CronJobTimeZone feature gate)
  timeZone: "America/New_York"

  # Concurrency policy: what to do if previous run is still active
  # Allow: run concurrently (risk of resource contention)
  # Forbid: skip new run if previous is active (safest for ETL)
  # Replace: kill previous and start new (for idempotent jobs)
  concurrencyPolicy: Forbid

  # Keep history of last 3 successful and 1 failed run for debugging
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1

  # Allow up to 60 seconds of late start before marking as missed
  startingDeadlineSeconds: 60

  jobTemplate:
    spec:
      backoffLimit: 2
      ttlSecondsAfterFinished: 86400   # Keep completed job 24 hours
      activeDeadlineSeconds: 7200      # Kill job after 2 hours
      template:
        metadata:
          labels:
            cronjob: nightly-etl
        spec:
          restartPolicy: OnFailure
          serviceAccountName: etl-runner

          # Prefer batch nodes but don't require them
          affinity:
            nodeAffinity:
              preferredDuringSchedulingIgnoredDuringExecution:
              - weight: 100
                preference:
                  matchExpressions:
                  - key: workload-type
                    operator: In
                    values: [batch]

          containers:
          - name: etl
            image: myregistry/etl-runner:v2.5.0
            command:
            - ./run-etl
            - --date
            - "$(date --date='yesterday' +%Y-%m-%d)"
            env:
            - name: WAREHOUSE_URL
              valueFrom:
                secretKeyRef:
                  name: warehouse-credentials
                  key: url
            resources:
              requests:
                cpu: 2000m
                memory: 4Gi
              limits:
                cpu: 8000m
                memory: 16Gi
```

### CronJob Operational Commands

```bash
#!/bin/bash
# cronjob-operations.sh
# Common operational tasks for managing CronJobs

CRONJOB_NAME="${1:-nightly-etl}"
NAMESPACE="${2:-data-processing}"

# Manually trigger a CronJob run (creates a Job immediately)
trigger_manual_run() {
    local timestamp
    timestamp=$(date +%s)
    local job_name="${CRONJOB_NAME}-manual-${timestamp}"

    kubectl create job "${job_name}" \
      --namespace="${NAMESPACE}" \
      --from="cronjob/${CRONJOB_NAME}"

    echo "Created manual job: ${job_name}"
    kubectl wait job "${job_name}" \
      --namespace="${NAMESPACE}" \
      --for=condition=complete \
      --timeout=2h
}

# Check CronJob history and status
show_history() {
    echo "=== CronJob: ${CRONJOB_NAME} ==="
    kubectl get cronjob "${CRONJOB_NAME}" \
      -n "${NAMESPACE}" \
      -o custom-columns=\
'NAME:.metadata.name,SCHEDULE:.spec.schedule,TIMEZONE:.spec.timeZone,LAST_SCHEDULE:.status.lastScheduleTime,LAST_SUCCESSFUL:.status.lastSuccessfulTime'

    echo ""
    echo "=== Recent Jobs ==="
    kubectl get jobs \
      -n "${NAMESPACE}" \
      -l "batch.kubernetes.io/cronjob-name=${CRONJOB_NAME}" \
      --sort-by='.metadata.creationTimestamp' \
      -o custom-columns=\
'NAME:.metadata.name,STATUS:.status.conditions[-1].type,STARTED:.metadata.creationTimestamp,DURATION:.status.completionTime'
}

# Suspend a CronJob (prevents new job creation)
suspend_cronjob() {
    kubectl patch cronjob "${CRONJOB_NAME}" \
      -n "${NAMESPACE}" \
      --type merge \
      --patch '{"spec":{"suspend":true}}'
    echo "CronJob ${CRONJOB_NAME} suspended"
}

# Resume a CronJob
resume_cronjob() {
    kubectl patch cronjob "${CRONJOB_NAME}" \
      -n "${NAMESPACE}" \
      --type merge \
      --patch '{"spec":{"suspend":false}}'
    echo "CronJob ${CRONJOB_NAME} resumed"
}

case "${3:-status}" in
    trigger) trigger_manual_run ;;
    history) show_history ;;
    suspend) suspend_cronjob ;;
    resume)  resume_cronjob ;;
    *)       show_history ;;
esac
```

## Work Queue Pattern with Redis

The work queue pattern decouples job producers from consumers. A central queue holds work items; consumers pull items and process them independently. Failed items are returned to the queue or moved to a dead-letter queue.

### Redis Queue Setup

```yaml
# redis-queue-deployment.yaml
# Redis instance used as the work queue.
# In production, use Redis Sentinel or Redis Cluster for HA.
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-queue-redis
  namespace: batch-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: batch-queue-redis
  template:
    metadata:
      labels:
        app: batch-queue-redis
    spec:
      containers:
      - name: redis
        image: redis:7.2-alpine
        command:
        - redis-server
        - --save ""           # Disable persistence for ephemeral queue
        - --appendonly no
        - --maxmemory 4gb
        - --maxmemory-policy allkeys-lru
        ports:
        - containerPort: 6379
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
---
apiVersion: v1
kind: Service
metadata:
  name: batch-queue-redis
  namespace: batch-system
spec:
  selector:
    app: batch-queue-redis
  ports:
  - port: 6379
    targetPort: 6379
```

### Work Queue Producer

```go
// producer/main.go
// Enqueues work items into Redis for batch processing.
// Uses Redis LPUSH to add items to the left of the list;
// workers use BRPOPLPUSH to consume from the right.
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "os"
    "time"

    "github.com/redis/go-redis/v9"
)

// WorkItem represents a unit of work to be processed.
type WorkItem struct {
    ID          string    `json:"id"`
    Type        string    `json:"type"`
    Payload     string    `json:"payload"`
    Priority    int       `json:"priority"`
    EnqueuedAt  time.Time `json:"enqueued_at"`
    MaxAttempts int       `json:"max_attempts"`
}

const (
    queueName       = "batch:work-queue"
    processingQueue = "batch:processing"
    deadLetterQueue = "batch:dead-letter"
)

func main() {
    rdb := redis.NewClient(&redis.Options{
        Addr: os.Getenv("REDIS_ADDR"),
        DB:   0,
    })

    ctx := context.Background()

    // Verify Redis connectivity
    if err := rdb.Ping(ctx).Err(); err != nil {
        log.Fatalf("redis ping failed: %v", err)
    }

    // Enqueue 1000 work items
    for i := 0; i < 1000; i++ {
        item := WorkItem{
            ID:          fmt.Sprintf("item-%06d", i),
            Type:        "process-record",
            Payload:     fmt.Sprintf(`{"record_id": %d}`, i),
            Priority:    1,
            EnqueuedAt:  time.Now().UTC(),
            MaxAttempts: 3,
        }

        data, err := json.Marshal(item)
        if err != nil {
            log.Printf("marshal error for item %s: %v", item.ID, err)
            continue
        }

        // LPUSH: add to left side of list
        // Workers use BRPOPLPUSH from right side (FIFO order)
        if err := rdb.LPush(ctx, queueName, data).Err(); err != nil {
            log.Printf("failed to enqueue item %s: %v", item.ID, err)
            continue
        }
    }

    log.Printf("Enqueued 1000 items")

    // Report queue depth
    length, _ := rdb.LLen(ctx, queueName).Result()
    log.Printf("Queue depth: %d", length)
}
```

### Work Queue Consumer (Kubernetes Job)

```go
// consumer/main.go
// Consumes work items from Redis and processes them.
// Uses BRPOPLPUSH pattern for reliable message processing:
// items are moved to a processing queue atomically,
// preventing item loss if the worker crashes.
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/redis/go-redis/v9"
)

type WorkItem struct {
    ID          string    `json:"id"`
    Type        string    `json:"type"`
    Payload     string    `json:"payload"`
    Priority    int       `json:"priority"`
    EnqueuedAt  time.Time `json:"enqueued_at"`
    MaxAttempts int       `json:"max_attempts"`
    Attempts    int       `json:"attempts"`
}

const (
    queueName       = "batch:work-queue"
    processingQueue = "batch:processing"
    deadLetterQueue = "batch:dead-letter"
    workerTimeout   = 30 * time.Second
)

func main() {
    rdb := redis.NewClient(&redis.Options{
        Addr: os.Getenv("REDIS_ADDR"),
        DB:   0,
    })

    ctx, cancel := context.WithCancel(context.Background())

    // Handle SIGTERM gracefully (Kubernetes pod termination)
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    go func() {
        sig := <-sigCh
        log.Printf("Received signal %v, shutting down gracefully", sig)
        cancel()
    }()

    workerID := os.Getenv("HOSTNAME") // Pod name as worker ID

    log.Printf("Worker %s starting", workerID)

    processed := 0
    for {
        select {
        case <-ctx.Done():
            log.Printf("Worker %s shutting down after processing %d items",
                workerID, processed)
            // Re-queue any item in our processing queue before exiting
            requeue(context.Background(), rdb, workerID)
            return
        default:
        }

        // BRPOPLPUSH: atomically move item from work-queue to processing-<worker>
        // Blocks for 5 seconds if queue is empty (allows graceful shutdown)
        workerProcessingQueue := fmt.Sprintf("%s:%s", processingQueue, workerID)

        data, err := rdb.BRPopLPush(ctx, queueName, workerProcessingQueue, 5*time.Second).Bytes()
        if err == redis.Nil {
            // Queue is empty; check if work is complete
            depth, _ := rdb.LLen(ctx, queueName).Result()
            if depth == 0 {
                log.Printf("Queue empty, worker %s done after %d items", workerID, processed)
                return
            }
            continue
        }
        if err != nil {
            if ctx.Err() != nil {
                return  // Context cancelled during blocking
            }
            log.Printf("dequeue error: %v", err)
            time.Sleep(1 * time.Second)
            continue
        }

        var item WorkItem
        if err := json.Unmarshal(data, &item); err != nil {
            log.Printf("unmarshal error: %v, data: %s", err, string(data))
            // Move malformed item to dead-letter queue
            rdb.LRem(ctx, workerProcessingQueue, 1, data)
            rdb.LPush(ctx, deadLetterQueue, data)
            continue
        }

        item.Attempts++

        // Process the work item
        processErr := processItem(ctx, &item)

        if processErr != nil {
            log.Printf("processing failed for %s (attempt %d/%d): %v",
                item.ID, item.Attempts, item.MaxAttempts, processErr)

            if item.Attempts >= item.MaxAttempts {
                // Max retries exceeded: move to dead-letter queue
                deadItem, _ := json.Marshal(item)
                rdb.LRem(ctx, workerProcessingQueue, 1, data)
                rdb.LPush(ctx, deadLetterQueue, deadItem)
                log.Printf("Item %s moved to dead-letter queue", item.ID)
            } else {
                // Re-enqueue for retry with updated attempt count
                retryItem, _ := json.Marshal(item)
                rdb.LRem(ctx, workerProcessingQueue, 1, data)
                rdb.LPush(ctx, queueName, retryItem)
            }
            continue
        }

        // Success: remove from processing queue
        rdb.LRem(ctx, workerProcessingQueue, 1, data)
        processed++

        if processed%100 == 0 {
            depth, _ := rdb.LLen(ctx, queueName).Result()
            log.Printf("Worker %s: processed=%d, queue_depth=%d",
                workerID, processed, depth)
        }
    }
}

// processItem executes the actual work for a queue item.
// Returns nil on success, error on failure.
func processItem(ctx context.Context, item *WorkItem) error {
    // Simulate variable processing time
    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-time.After(10 * time.Millisecond):
    }

    log.Printf("Processed item %s (type: %s)", item.ID, item.Type)
    return nil
}

// requeue moves any item stuck in this worker's processing queue
// back to the main queue before the worker exits.
func requeue(ctx context.Context, rdb *redis.Client, workerID string) {
    workerProcessingQueue := fmt.Sprintf("%s:%s", processingQueue, workerID)
    for {
        data, err := rdb.RPopLPush(ctx, workerProcessingQueue, queueName).Bytes()
        if err == redis.Nil {
            return  // Queue empty
        }
        if err != nil {
            log.Printf("requeue error: %v", err)
            return
        }
        log.Printf("Requeued item: %s", string(data))
    }
}
```

```yaml
# work-queue-consumer-job.yaml
# Job that scales consumer pods to drain the work queue.
# When completions=0, the Job runs until all pods complete.
# Use with KEDA for dynamic scaling based on queue depth.
apiVersion: batch/v1
kind: Job
metadata:
  name: work-queue-consumer
  namespace: batch-system
spec:
  # parallelism controls concurrent consumer pods
  # Tune based on queue depth and resource availability
  parallelism: 10
  # completions: null means run until pods exit successfully
  # Combined with queue-emptiness check in consumer code
  completions: 10
  completionMode: NonIndexed
  backoffLimit: 5
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: OnFailure
      containers:
      - name: consumer
        image: myregistry/queue-consumer:v1.0
        env:
        - name: REDIS_ADDR
          value: "batch-queue-redis.batch-system.svc.cluster.local:6379"
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
```

## TTL Controller for Finished Jobs

The TTL controller automatically cleans up finished Jobs after a configurable duration, preventing orphaned Job objects from accumulating in the cluster.

```yaml
# jobs-with-ttl.yaml
# Various TTL configurations for different job categories

# Short TTL for frequent, low-importance jobs
apiVersion: batch/v1
kind: Job
metadata:
  name: health-check-job
spec:
  ttlSecondsAfterFinished: 300    # Clean up after 5 minutes
  ...

---
# Longer TTL for audit-sensitive jobs
apiVersion: batch/v1
kind: Job
metadata:
  name: financial-reconciliation
  annotations:
    batch.audit/retention: "90-days"
spec:
  ttlSecondsAfterFinished: 7776000   # Clean up after 90 days
  ...

---
# No TTL: keep indefinitely (manual cleanup required)
apiVersion: batch/v1
kind: Job
metadata:
  name: one-time-migration
spec:
  # No ttlSecondsAfterFinished: must be deleted manually
  ...
```

```bash
# Bulk cleanup of old completed jobs (for clusters without TTL controller)
# Clean up jobs completed more than 24 hours ago
kubectl get jobs \
  --all-namespaces \
  -o json \
  | jq -r '
    .items[] |
    select(
      .status.completionTime != null and
      (now - (.status.completionTime | fromdateiso8601)) > 86400
    ) |
    "\(.metadata.namespace)/\(.metadata.name)"
  ' \
  | while IFS='/' read -r ns name; do
      echo "Deleting completed job: ${ns}/${name}"
      kubectl delete job "${name}" -n "${ns}" --wait=false
    done
```

## KEDA for Event-Driven Job Scaling

KEDA (Kubernetes Event-Driven Autoscaling) extends Kubernetes with scalers that create Jobs based on external metrics, enabling true event-driven batch processing.

```yaml
# keda-scaled-job.yaml
# KEDA ScaledJob that creates consumer pods based on Redis queue depth.
# New consumer pods are created when queue depth exceeds the threshold,
# and no new pods are created when the queue is empty.
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: redis-queue-processor
  namespace: batch-system
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 3
    template:
      spec:
        restartPolicy: Never
        containers:
        - name: processor
          image: myregistry/queue-consumer:v1.0
          env:
          - name: REDIS_ADDR
            value: "batch-queue-redis.batch-system.svc.cluster.local:6379"
          resources:
            requests:
              cpu: 500m
              memory: 512Mi

  # Polling interval: check queue depth every 15 seconds
  pollingInterval: 15

  # Minimum successful job runs before considering cooldown
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 5

  # Scale configuration
  maxReplicaCount: 50      # Never create more than 50 concurrent jobs
  scalingStrategy:
    strategy: "accurate"   # Create exactly one job per queue item
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "0.5"

  triggers:
  - type: redis
    metadata:
      # Redis connection details
      address: "batch-queue-redis.batch-system.svc.cluster.local:6379"
      listName: "batch:work-queue"
      listLength: "1"         # One job per queue item
      activationListLength: "1"  # Activate when queue has at least 1 item
```

## Volcano for Advanced Batch Scheduling

Volcano provides gang scheduling, fair queue allocation, and preemption for batch workloads that exceed what the default Kubernetes scheduler offers.

```yaml
# volcano-job.yaml
# Volcano Job with gang scheduling: all 10 tasks must be schedulable
# simultaneously before any task starts. Prevents partial starts
# where some tasks run while others wait indefinitely.
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  name: distributed-ml-training
  namespace: ml-training
spec:
  # minAvailable: ALL tasks must schedule before any starts (gang scheduling)
  # This is the critical Volcano feature; standard Kubernetes Jobs
  # can start tasks one by one, leaving partial gang stalls.
  minAvailable: 10

  schedulerName: volcano

  # Queue for resource allocation and priority
  queue: ml-training-queue

  policies:
  # Restart all tasks if any task fails (distributed training requirement)
  - event: TaskFailed
    action: RestartJob
  # Terminate if job fails too many times
  - event: PodEvicted
    action: RestartJob

  tasks:
  - name: ps        # Parameter server(s)
    replicas: 2
    policies:
    - event: TaskFailed
      action: RestartJob
    template:
      spec:
        containers:
        - name: ps
          image: myregistry/tf-training:v2.0
          command: ["python", "train.py", "--role=ps"]
          resources:
            requests:
              cpu: 4000m
              memory: 8Gi

  - name: worker    # Training workers
    replicas: 8
    template:
      spec:
        containers:
        - name: worker
          image: myregistry/tf-training:v2.0
          command: ["python", "train.py", "--role=worker"]
          resources:
            requests:
              cpu: 8000m
              memory: 16Gi
              nvidia.com/gpu: "1"    # One GPU per worker
```

```yaml
# volcano-queue.yaml
# Volcano Queue with resource limits for the ML training team.
# Guarantees minimum resources and caps maximum usage.
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: ml-training-queue
spec:
  # Guaranteed resources for this queue (reserved)
  guarantee:
    resource:
      cpu: "40"
      memory: 160Gi
      nvidia.com/gpu: "8"

  # Maximum resources this queue can use (including bursting)
  capability:
    resource:
      cpu: "80"
      memory: 320Gi
      nvidia.com/gpu: "16"

  # Weight for fair-share scheduling across queues
  weight: 2

  # Reclaimable: yes = resources can be preempted by higher-priority queues
  reclaimable: true
```

## Monitoring Batch Workloads

```yaml
# prometheus-job-alerts.yaml
# Alerting rules for batch job health monitoring.
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: batch-job-alerts
  namespace: monitoring
spec:
  groups:
  - name: kubernetes-batch
    rules:
    # Alert when a Job has been running too long (potential hang)
    - alert: KubernetesJobRunningTooLong
      expr: >
        time() - kube_job_status_start_time{job_name!=""}
        > 14400   # 4 hours
        and
        kube_job_status_active{job_name!=""} > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Job {{ $labels.job_name }} running longer than 4 hours"
        description: >
          Job {{ $labels.namespace }}/{{ $labels.job_name }} has been
          running for {{ $value | humanizeDuration }}.

    # Alert when a Job fails
    - alert: KubernetesJobFailed
      expr: kube_job_status_failed > 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Job {{ $labels.job_name }} has failed pods"
        description: >
          Job {{ $labels.namespace }}/{{ $labels.job_name }} has
          {{ $value }} failed pods.

    # Alert when CronJob has not run recently
    - alert: KubernetesCronJobNotRun
      expr: >
        time() - kube_cronjob_status_last_successful_time{} > 86400
        and kube_cronjob_spec_suspend == 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "CronJob {{ $labels.cronjob }} has not run in 24 hours"

    # Alert on work queue depth (via custom metric from KEDA)
    - alert: BatchQueueDepthHigh
      expr: keda_scaler_metrics_value{metric="batch:work-queue"} > 10000
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Batch queue depth is {{ $value }} items"
```

## Summary

Kubernetes batch processing has matured into a robust platform for enterprise workloads. Indexed Jobs enable deterministic sharding of large datasets without coordination overhead. CronJob timezone support eliminates DST-related scheduling bugs. The work queue pattern with Redis provides reliable at-least-once processing with dead-letter handling. Job suspend/resume supports approval workflows and time-window scheduling. The TTL controller automates cleanup to prevent cluster clutter.

For scale beyond the native scheduler's capabilities, KEDA provides reactive scaling based on actual queue depth, and Volcano enables gang scheduling for distributed ML training that requires all workers to start simultaneously. Together, these tools provide the scheduling semantics required for data pipelines, ML workflows, and operational batch processes running in enterprise Kubernetes environments.
