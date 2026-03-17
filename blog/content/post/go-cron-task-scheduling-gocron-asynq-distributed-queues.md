---
title: "Go Cron and Task Scheduling: gocron, asynq, and Distributed Job Queues"
date: 2030-09-09T00:00:00-05:00
draft: false
tags: ["Go", "Scheduling", "gocron", "asynq", "Redis", "Distributed Systems", "Job Queues", "Observability"]
categories:
- Go
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Production job scheduling in Go covering gocron for in-process scheduling, asynq Redis-backed distributed queues, job deduplication, retry strategies, dead letter queues, distributed cron with leader election, and observability for scheduled tasks."
more_link: "yes"
url: "/go-cron-task-scheduling-gocron-asynq-distributed-queues/"
---

Background task scheduling is a universal requirement in production Go services. Scheduled jobs handle report generation, data synchronization, cache warming, cleanup operations, and event-driven workflows. Choosing the right scheduling approach depends on the scale and reliability requirements: in-process scheduling with gocron suits single-instance services with simple intervals, while Redis-backed distributed queues with asynq are necessary when tasks must survive process restarts, run across multiple replicas, or require complex routing, retry, and observability. This guide covers both approaches in production depth, including the patterns that prevent common scheduling failures: missed executions, duplicate runs, silent failures, and dead-letter queue accumulation.

<!--more-->

## In-Process Scheduling with gocron

gocron provides a cron-like scheduler that runs jobs within a Go process. It is appropriate for tasks that:
- Are idempotent and can safely be lost if the process crashes.
- Do not require exactly-once execution guarantees.
- Do not need to be distributed across multiple replicas.
- Are lightweight enough that a single process can handle the scheduling load.

### Installation

```bash
go get github.com/go-co-op/gocron/v2@latest
```

### Basic Scheduler Setup

```go
package scheduler

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/go-co-op/gocron/v2"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/trace"
)

type Scheduler struct {
    s      gocron.Scheduler
    logger *slog.Logger
    tracer trace.Tracer
}

func New(logger *slog.Logger) (*Scheduler, error) {
    s, err := gocron.NewScheduler(
        gocron.WithLocation(time.UTC),
        gocron.WithLimitConcurrentJobs(10, gocron.LimitModeWait),
        gocron.WithLogger(gocron.NewLogger(gocron.LogLevelInfo)),
    )
    if err != nil {
        return nil, fmt.Errorf("creating scheduler: %w", err)
    }

    return &Scheduler{
        s:      s,
        logger: logger,
        tracer: otel.Tracer("scheduler"),
    }, nil
}

// RegisterJobs adds all scheduled jobs to the scheduler.
func (s *Scheduler) RegisterJobs(jobs []JobDefinition) error {
    for _, job := range jobs {
        if err := s.registerJob(job); err != nil {
            return fmt.Errorf("registering job %q: %w", job.Name, err)
        }
    }
    return nil
}

func (s *Scheduler) registerJob(def JobDefinition) error {
    jobDef, err := gocron.NewJob(
        gocron.CronJob(def.CronExpr, false),
        gocron.NewTask(s.wrapTask(def)),
        gocron.WithName(def.Name),
        gocron.WithSingletonMode(gocron.LimitModeWait),   // Skip if previous run still running
        gocron.WithTags(def.Tags...),
    )
    if err != nil {
        return err
    }
    _, err = s.s.NewJob(gocron.CronJob(def.CronExpr, false),
        gocron.NewTask(s.wrapTask(def)),
        gocron.WithName(def.Name),
        gocron.WithSingletonMode(gocron.LimitModeWait),
    )
    _ = jobDef
    return err
}

// wrapTask instruments a task with logging, tracing, and panic recovery.
func (s *Scheduler) wrapTask(def JobDefinition) func() {
    return func() {
        ctx, span := s.tracer.Start(context.Background(), def.Name,
            trace.WithAttributes(
                attribute.String("job.name", def.Name),
                attribute.String("job.schedule", def.CronExpr),
            ),
        )
        defer span.End()

        start := time.Now()
        s.logger.InfoContext(ctx, "job started", "job", def.Name)

        defer func() {
            if r := recover(); r != nil {
                s.logger.ErrorContext(ctx, "job panicked", "job", def.Name, "panic", r)
                span.RecordError(fmt.Errorf("panic: %v", r))
                jobsPanicsTotal.WithLabelValues(def.Name).Inc()
            }
        }()

        if err := def.Task(ctx); err != nil {
            s.logger.ErrorContext(ctx, "job failed", "job", def.Name, "error", err,
                "duration", time.Since(start))
            span.RecordError(err)
            jobsFailuresTotal.WithLabelValues(def.Name).Inc()
            return
        }

        duration := time.Since(start)
        s.logger.InfoContext(ctx, "job completed", "job", def.Name, "duration", duration)
        jobsSuccessTotal.WithLabelValues(def.Name).Inc()
        jobDurationHistogram.WithLabelValues(def.Name).Observe(duration.Seconds())
        jobLastSuccessTimestamp.WithLabelValues(def.Name).SetToCurrentTime()
    }
}

func (s *Scheduler) Start() {
    s.s.Start()
}

func (s *Scheduler) Stop() error {
    return s.s.Shutdown()
}

type JobDefinition struct {
    Name     string
    CronExpr string
    Tags     []string
    Task     func(ctx context.Context) error
}
```

### Prometheus Metrics for Scheduled Jobs

```go
package scheduler

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    jobsSuccessTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "scheduler_job_success_total",
        Help: "Total number of successful job executions",
    }, []string{"job"})

    jobsFailuresTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "scheduler_job_failure_total",
        Help: "Total number of failed job executions",
    }, []string{"job"})

    jobsPanicsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "scheduler_job_panic_total",
        Help: "Total number of job panics",
    }, []string{"job"})

    jobDurationHistogram = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "scheduler_job_duration_seconds",
        Help:    "Duration of job executions",
        Buckets: prometheus.DefBuckets,
    }, []string{"job"})

    jobLastSuccessTimestamp = promauto.NewGaugeVec(prometheus.GaugeOpts{
        Name: "scheduler_job_last_success_timestamp_seconds",
        Help: "Unix timestamp of the last successful job execution",
    }, []string{"job"})
)
```

### Alert: Job Not Running

```yaml
- alert: ScheduledJobNotRunning
  expr: |
    (time() - scheduler_job_last_success_timestamp_seconds{job_name="daily-report-generator"}) > 90000
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Scheduled job {{ $labels.job_name }} has not succeeded in 25+ hours"
```

### Registering Jobs

```go
// main.go
func main() {
    logger := slog.Default()

    sched, err := scheduler.New(logger)
    if err != nil {
        logger.Error("creating scheduler", "error", err)
        os.Exit(1)
    }

    err = sched.RegisterJobs([]scheduler.JobDefinition{
        {
            Name:     "daily-report-generator",
            CronExpr: "0 6 * * *",    // 06:00 UTC daily
            Task:     reports.GenerateDaily,
        },
        {
            Name:     "cache-warmer",
            CronExpr: "*/15 * * * *", // Every 15 minutes
            Task:     cache.WarmCriticalKeys,
        },
        {
            Name:     "expired-token-cleanup",
            CronExpr: "0 * * * *",    // Hourly
            Task:     tokens.DeleteExpired,
        },
    })
    if err != nil {
        logger.Error("registering jobs", "error", err)
        os.Exit(1)
    }

    sched.Start()

    // Graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
    <-sigCh

    if err := sched.Stop(); err != nil {
        logger.Error("stopping scheduler", "error", err)
    }
}
```

## Distributed Task Queues with asynq

asynq is a Redis-backed distributed task queue for Go. It provides:
- At-least-once delivery with configurable retry.
- Task deduplication via unique task IDs.
- Scheduling (cron expressions).
- Priority queues (critical, high, default, low).
- Dead letter queues for failed tasks.
- Web UI for monitoring (asynqmon).

### Installation

```bash
go get github.com/hibiken/asynq@latest
```

### Task Definition Pattern

```go
// tasks/tasks.go — centralized task type definitions
package tasks

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/hibiken/asynq"
)

// Task type constants — used for routing and observability
const (
    TypeEmailWelcome         = "email:welcome"
    TypeEmailInvoice         = "email:invoice"
    TypeOrderProcessPayment  = "order:process_payment"
    TypeOrderFulfill         = "order:fulfill"
    TypeReportGenerate       = "report:generate"
    TypeCacheWarm            = "cache:warm"
)

// NewEmailWelcomeTask creates a welcome email task.
func NewEmailWelcomeTask(userID string) (*asynq.Task, error) {
    payload, err := json.Marshal(EmailWelcomePayload{UserID: userID})
    if err != nil {
        return nil, fmt.Errorf("marshalling payload: %w", err)
    }
    return asynq.NewTask(TypeEmailWelcome, payload,
        asynq.MaxRetry(3),
        asynq.Timeout(30*time.Second),
        asynq.Queue("email"),
        // Unique within 24 hours — prevents duplicate welcome emails
        asynq.Unique(24*time.Hour),
    ), nil
}

// NewOrderProcessPaymentTask creates a payment processing task.
func NewOrderProcessPaymentTask(orderID string, amountCents int64) (*asynq.Task, error) {
    payload, err := json.Marshal(OrderProcessPaymentPayload{
        OrderID:     orderID,
        AmountCents: amountCents,
    })
    if err != nil {
        return nil, err
    }
    return asynq.NewTask(TypeOrderProcessPayment, payload,
        asynq.MaxRetry(5),
        asynq.Timeout(60*time.Second),
        asynq.Queue("critical"),
        asynq.TaskID(fmt.Sprintf("payment:%s", orderID)), // Idempotent task ID
        asynq.Unique(1*time.Hour),
    ), nil
}

// Payload types
type EmailWelcomePayload struct {
    UserID string `json:"user_id"`
}

type OrderProcessPaymentPayload struct {
    OrderID     string `json:"order_id"`
    AmountCents int64  `json:"amount_cents"`
}
```

### Client: Enqueuing Tasks

```go
// internal/queue/client.go
package queue

import (
    "context"
    "fmt"
    "time"

    "github.com/hibiken/asynq"
    "github.com/example/app/tasks"
)

type Client struct {
    c *asynq.Client
}

func NewClient(redisAddr string) *Client {
    return &Client{
        c: asynq.NewClient(asynq.RedisClientOpt{Addr: redisAddr}),
    }
}

func (c *Client) Close() error {
    return c.c.Close()
}

// EnqueueWelcomeEmail enqueues a welcome email task.
func (c *Client) EnqueueWelcomeEmail(ctx context.Context, userID string) error {
    task, err := tasks.NewEmailWelcomeTask(userID)
    if err != nil {
        return fmt.Errorf("creating task: %w", err)
    }
    info, err := c.c.EnqueueContext(ctx, task)
    if err != nil {
        // ErrTaskIDConflict means the task is already enqueued (deduplication working)
        if asynq.IsTaskIDConflictError(err) {
            return nil
        }
        return fmt.Errorf("enqueuing task: %w", err)
    }
    _ = info // info.ID, info.Queue, info.State
    return nil
}

// EnqueueWithDelay enqueues a task to run after a delay.
func (c *Client) EnqueueWithDelay(ctx context.Context, task *asynq.Task, delay time.Duration) error {
    _, err := c.c.EnqueueContext(ctx, task,
        asynq.ProcessIn(delay),
    )
    return err
}

// EnqueueAt enqueues a task to run at a specific time.
func (c *Client) EnqueueAt(ctx context.Context, task *asynq.Task, at time.Time) error {
    _, err := c.c.EnqueueContext(ctx, task,
        asynq.ProcessAt(at),
    )
    return err
}
```

### Server: Processing Tasks

```go
// internal/queue/server.go
package queue

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/hibiken/asynq"
    "github.com/example/app/tasks"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
)

type Server struct {
    srv    *asynq.Server
    mux    *asynq.ServeMux
    logger *slog.Logger
}

func NewServer(redisAddr string, logger *slog.Logger) *Server {
    srv := asynq.NewServer(
        asynq.RedisClientOpt{Addr: redisAddr},
        asynq.Config{
            Concurrency: 20,
            Queues: map[string]int{
                "critical": 6,    // 30% of workers
                "email":    4,    // 20% of workers
                "default":  8,    // 40% of workers
                "low":      2,    // 10% of workers
            },
            StrictPriority:   false,  // Proportional (not strict FIFO by priority)
            ShutdownTimeout:  30 * time.Second,
            HealthCheckInterval: 15 * time.Second,
            RetryDelayFunc:   exponentialBackoffWithJitter,
            IsFailure: func(err error) bool {
                // Non-retryable errors should not count as failures
                return !isNonRetryable(err)
            },
        },
    )

    mux := asynq.NewServeMux()
    s := &Server{srv: srv, mux: mux, logger: logger}

    // Register handlers
    mux.HandleFunc(tasks.TypeEmailWelcome, s.handleEmailWelcome)
    mux.HandleFunc(tasks.TypeOrderProcessPayment, s.handleOrderProcessPayment)
    mux.HandleFunc(tasks.TypeReportGenerate, s.handleReportGenerate)

    // Middleware: logging, tracing, panic recovery
    mux.Use(s.loggingMiddleware)
    mux.Use(s.tracingMiddleware)
    mux.Use(s.panicRecoveryMiddleware)

    return s
}

func (s *Server) Start() error {
    return s.srv.Start(s.mux)
}

func (s *Server) Stop() {
    s.srv.Stop()
    s.srv.Shutdown()
}

func (s *Server) handleEmailWelcome(ctx context.Context, t *asynq.Task) error {
    var p tasks.EmailWelcomePayload
    if err := json.Unmarshal(t.Payload(), &p); err != nil {
        // Non-retryable: bad payload
        return fmt.Errorf("%w: %v", asynq.SkipRetry, err)
    }

    if err := sendWelcomeEmail(ctx, p.UserID); err != nil {
        // Retryable error — asynq will retry
        return fmt.Errorf("sending welcome email to %s: %w", p.UserID, err)
    }
    return nil
}

func (s *Server) handleOrderProcessPayment(ctx context.Context, t *asynq.Task) error {
    var p tasks.OrderProcessPaymentPayload
    if err := json.Unmarshal(t.Payload(), &p); err != nil {
        return fmt.Errorf("%w: bad payload: %v", asynq.SkipRetry, err)
    }
    return processPayment(ctx, p.OrderID, p.AmountCents)
}

// Middleware implementations

func (s *Server) loggingMiddleware(next asynq.Handler) asynq.Handler {
    return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
        start := time.Now()
        taskID, _ := asynq.GetTaskID(ctx)
        s.logger.InfoContext(ctx, "processing task",
            "type", t.Type(),
            "id", taskID,
        )
        err := next.ProcessTask(ctx, t)
        duration := time.Since(start)
        if err != nil {
            s.logger.ErrorContext(ctx, "task failed",
                "type", t.Type(), "id", taskID, "error", err, "duration", duration)
        } else {
            s.logger.InfoContext(ctx, "task completed",
                "type", t.Type(), "id", taskID, "duration", duration)
        }
        return err
    })
}

func (s *Server) tracingMiddleware(next asynq.Handler) asynq.Handler {
    tracer := otel.Tracer("asynq")
    return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
        ctx, span := tracer.Start(ctx, t.Type(),
            trace.WithAttributes(attribute.String("task.type", t.Type())),
        )
        defer span.End()
        err := next.ProcessTask(ctx, t)
        if err != nil {
            span.RecordError(err)
        }
        return err
    })
}

func (s *Server) panicRecoveryMiddleware(next asynq.Handler) asynq.Handler {
    return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) (err error) {
        defer func() {
            if r := recover(); r != nil {
                err = fmt.Errorf("%w: panic in task %s: %v", asynq.SkipRetry, t.Type(), r)
                s.logger.ErrorContext(ctx, "task panicked", "type", t.Type(), "panic", r)
            }
        }()
        return next.ProcessTask(ctx, t)
    })
}

func exponentialBackoffWithJitter(n int, err error, t *asynq.Task) time.Duration {
    base := time.Duration(n*n) * 10 * time.Second
    jitter := time.Duration(rand.Int63n(int64(base / 4)))
    return base + jitter
}
```

## Retry Strategies and Dead Letter Queues

### Task Retry Configuration

```go
// Fine-grained retry configuration per task type
task := asynq.NewTask(TypeEmailInvoice, payload,
    asynq.MaxRetry(10),
    asynq.Timeout(45*time.Second),
    asynq.Deadline(time.Now().Add(24*time.Hour)), // Give up after 24h regardless of retry count
)
```

### Dead Letter Queue (Archive) Management

asynq automatically moves tasks to the "archive" (dead letter queue) when `MaxRetry` is exhausted or when `asynq.SkipRetry` is returned.

```go
// Inspect archived (dead letter) tasks
inspector := asynq.NewInspector(asynq.RedisClientOpt{Addr: "localhost:6379"})

archived, err := inspector.ListArchivedTasks("critical",
    asynq.Page(1), asynq.PageSize(100))
for _, task := range archived {
    fmt.Printf("ID: %s Type: %s LastErr: %s Score: %d\n",
        task.ID, task.Type, task.LastErr, task.Score)
}

// Re-enqueue a specific archived task
if err := inspector.RunArchivedTask("critical", taskID); err != nil {
    log.Fatal(err)
}

// Re-enqueue ALL archived tasks of a specific type
count, err := inspector.RunAllArchivedTasks("critical")
fmt.Printf("Re-enqueued %d archived tasks\n", count)

// Delete archived tasks older than 7 days
count, err = inspector.DeleteAllArchivedTasks("default")
```

### Monitoring Dead Letter Queue Depth

```bash
# asynqmon provides a web UI and API for DLQ inspection
docker run --rm -p 8080:8080 \
  -e REDIS_ADDR=redis:6379 \
  hibiken/asynqmon
```

```go
// Expose DLQ depth as Prometheus metric
func recordDLQDepth(inspector *asynq.Inspector, queues []string) {
    for _, q := range queues {
        info, err := inspector.GetQueueInfo(q)
        if err != nil {
            continue
        }
        asynqArchivedTasksGauge.WithLabelValues(q).Set(float64(info.Archived))
        asynqPendingTasksGauge.WithLabelValues(q).Set(float64(info.Pending))
        asynqRetryTasksGauge.WithLabelValues(q).Set(float64(info.Retry))
    }
}
```

## Distributed Cron with Leader Election

For distributed cron scheduling (where only one instance in a multi-replica deployment should run a scheduled task), use Redis-backed leader election.

### Using asynq Scheduler with Single-Instance Guarantee

asynq's `Scheduler` uses Redis SETNX for leader election, ensuring only one process schedules a given cron job even when multiple replicas run:

```go
// internal/cron/scheduler.go
package cron

import (
    "context"
    "log/slog"

    "github.com/hibiken/asynq"
    "github.com/example/app/tasks"
)

type CronScheduler struct {
    s      *asynq.Scheduler
    logger *slog.Logger
}

func NewCronScheduler(redisAddr string, logger *slog.Logger) *CronScheduler {
    scheduler := asynq.NewScheduler(
        asynq.RedisClientOpt{Addr: redisAddr},
        &asynq.SchedulerOpts{
            Location: time.UTC,
            PostEnqueueFunc: func(info *asynq.TaskInfo, err error) {
                if err != nil {
                    logger.Error("failed to enqueue scheduled task",
                        "task", info.Type, "queue", info.Queue, "error", err)
                } else {
                    logger.Info("enqueued scheduled task",
                        "task", info.Type, "id", info.ID)
                }
            },
            EnqueueErrorHandler: func(task *asynq.Task, opts []asynq.Option, err error) {
                if asynq.IsTaskIDConflictError(err) {
                    // Duplicate — previous run still pending, fine to skip
                    return
                }
                logger.Error("cron enqueue error", "task", task.Type(), "error", err)
            },
        },
    )

    return &CronScheduler{s: scheduler, logger: logger}
}

func (c *CronScheduler) Register() error {
    entries := []struct {
        cronExpr string
        task     *asynq.Task
    }{
        {
            cronExpr: "0 6 * * *",   // 06:00 UTC daily
            task: asynq.NewTask(tasks.TypeReportGenerate,
                mustMarshal(tasks.ReportGeneratePayload{ReportType: "daily-summary"}),
                asynq.TaskID("report:daily-summary"),   // Dedup
                asynq.Queue("default"),
                asynq.MaxRetry(3),
            ),
        },
        {
            cronExpr: "*/10 * * * *",  // Every 10 minutes
            task: asynq.NewTask(tasks.TypeCacheWarm, nil,
                asynq.TaskID("cache:warm"),
                asynq.Queue("low"),
                asynq.MaxRetry(1),
            ),
        },
    }

    for _, entry := range entries {
        if _, err := c.s.Register(entry.cronExpr, entry.task); err != nil {
            return fmt.Errorf("registering cron %q: %w", entry.cronExpr, err)
        }
    }
    return nil
}

func (c *CronScheduler) Start() error {
    return c.s.Start()
}

func (c *CronScheduler) Stop() {
    c.s.Shutdown()
}
```

### Kubernetes Deployment with Cron Scheduler

When running asynq in Kubernetes, dedicate separate Deployments for the scheduler (1 replica) and the workers (N replicas):

```yaml
# asynq-scheduler: single replica — leader election via Redis
apiVersion: apps/v1
kind: Deployment
metadata:
  name: asynq-scheduler
  namespace: production
spec:
  replicas: 1
  selector:
    matchLabels:
      app: asynq-scheduler
  template:
    metadata:
      labels:
        app: asynq-scheduler
    spec:
      containers:
      - name: scheduler
        image: example/app:v2.1.0
        command: ["app", "--mode=scheduler"]
        env:
        - name: REDIS_ADDR
          valueFrom:
            secretKeyRef:
              name: redis-credentials
              key: addr

---
# asynq-workers: multiple replicas — process tasks from queue
apiVersion: apps/v1
kind: Deployment
metadata:
  name: asynq-workers
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: asynq-workers
  template:
    spec:
      containers:
      - name: worker
        image: example/app:v2.1.0
        command: ["app", "--mode=worker"]
        env:
        - name: REDIS_ADDR
          valueFrom:
            secretKeyRef:
              name: redis-credentials
              key: addr
        resources:
          requests:
            cpu: 500m
            memory: 256Mi
          limits:
            memory: 512Mi
```

## Job Deduplication Patterns

### Task ID-Based Deduplication

```go
// Pattern 1: Stable task ID prevents duplicate enqueuing
// Useful when the same logical job should only have one instance pending
task := asynq.NewTask(TypeOrderFulfill, payload,
    asynq.TaskID(fmt.Sprintf("fulfill:%s", orderID)),
)
```

### Unique Option-Based Deduplication

```go
// Pattern 2: Unique within a time window
// Prevents enqueueing the same task multiple times within the TTL
task := asynq.NewTask(TypeEmailWelcome, payload,
    asynq.Unique(1*time.Hour),   // Unique for 1 hour based on task type + payload hash
)
```

### Idempotency in Task Handlers

```go
func (s *Server) handleOrderFulfill(ctx context.Context, t *asynq.Task) error {
    var p tasks.OrderFulfillPayload
    if err := json.Unmarshal(t.Payload(), &p); err != nil {
        return fmt.Errorf("%w: %v", asynq.SkipRetry, err)
    }

    // Check if already fulfilled (idempotency check)
    order, err := s.orderRepo.GetByID(ctx, p.OrderID)
    if err != nil {
        return fmt.Errorf("getting order: %w", err)
    }
    if order.Status == "FULFILLED" {
        // Already done — acknowledge without error
        return nil
    }

    return s.fulfillOrder(ctx, p.OrderID)
}
```

## Observability for Scheduled Tasks

### Structured Logging

```go
// Correlation between enqueue and execution using task ID
func (c *Client) EnqueueAndLog(ctx context.Context, task *asynq.Task) error {
    info, err := c.c.EnqueueContext(ctx, task)
    if err != nil {
        slog.ErrorContext(ctx, "enqueue failed",
            "task_type", task.Type(),
            "error", err,
        )
        return err
    }
    slog.InfoContext(ctx, "task enqueued",
        "task_type", task.Type(),
        "task_id", info.ID,
        "queue", info.Queue,
        "scheduled_for", info.NextProcessAt,
    )
    return nil
}
```

### Prometheus Metrics Collection

```go
// Periodic metrics collection from asynq inspector
func StartMetricsCollector(inspector *asynq.Inspector, queues []string) {
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()
        for range ticker.C {
            for _, q := range queues {
                info, err := inspector.GetQueueInfo(q)
                if err != nil {
                    continue
                }
                asynqQueueSizeGauge.WithLabelValues(q, "pending").Set(float64(info.Pending))
                asynqQueueSizeGauge.WithLabelValues(q, "active").Set(float64(info.Active))
                asynqQueueSizeGauge.WithLabelValues(q, "retry").Set(float64(info.Retry))
                asynqQueueSizeGauge.WithLabelValues(q, "archived").Set(float64(info.Archived))
                asynqQueueSizeGauge.WithLabelValues(q, "scheduled").Set(float64(info.Scheduled))
            }
        }
    }()
}
```

## Summary

Production Go task scheduling requires matching the tool to the reliability requirements. gocron suits in-process scheduling for tasks that tolerate loss on process restart. asynq provides Redis-backed distributed scheduling with exactly-once semantics per the task ID deduplication window, configurable retry with exponential backoff, priority queue routing, and dead letter queue management. The pattern of separating the scheduler process (1 replica) from worker processes (N replicas) enables independent scaling and prevents duplicate scheduling in multi-replica deployments. Instrumenting tasks with structured logging, distributed tracing, and Prometheus metrics completes the observability foundation needed to detect missed executions, growing DLQ depth, and worker saturation in production.
