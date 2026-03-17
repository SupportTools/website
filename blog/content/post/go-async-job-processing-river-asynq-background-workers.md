---
title: "Go Async Job Processing: River Queue, Asynq, Background Workers, Priority Queues, and Dead Letter Handling"
date: 2032-01-01T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Background Jobs", "River", "Asynq", "Queue", "Async Processing"]
categories:
- Go
- Architecture
- Developer Productivity
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to asynchronous job processing in Go: comparing River and Asynq architectures, building production-grade background workers with priority queues, implementing dead letter queues, retry policies, and monitoring job pipelines with Prometheus."
more_link: "yes"
url: "/go-async-job-processing-river-asynq-background-workers/"
---

Asynchronous job processing is the backbone of reliable distributed systems. Whether you're sending emails, generating reports, processing uploads, or triggering downstream APIs, you need a job queue that handles retries, failures, priority ordering, and observability. Go has two excellent options: River (PostgreSQL-backed, strong ACID guarantees) and Asynq (Redis-backed, high throughput). This guide builds production-grade implementations of both, covering priority queue design, dead letter queue patterns, retry strategies with exponential backoff, and Prometheus metrics for queue health monitoring.

<!--more-->

# Go Async Job Processing: River and Asynq

## Section 1: Choosing the Right Queue

| Feature | River | Asynq |
|---------|-------|-------|
| Storage | PostgreSQL | Redis |
| Throughput | ~10K jobs/sec | ~100K+ jobs/sec |
| Durability | ACID transactions | Redis persistence (AOF/RDB) |
| Job visibility | Full SQL queries | Redis Sorted Sets |
| Transactional enqueue | Yes (same DB tx) | No |
| Unique jobs | Yes | Yes |
| Scheduled jobs | Yes | Yes |
| Priority queues | Yes | Yes |
| Dead letter queue | Discarded/cancelled jobs | Yes (dedicated queue) |
| Best for | Financial, audit-critical jobs | High-volume, best-effort jobs |

**Choose River when**: Jobs must be transactionally consistent with database writes (e.g., "create order AND enqueue fulfillment job atomically").

**Choose Asynq when**: Maximum throughput matters and Redis is already in your infrastructure.

## Section 2: River — PostgreSQL-Backed Job Queue

River uses PostgreSQL as its backing store, enabling transactional job insertion alongside your application data.

### Installation

```bash
go get github.com/riverqueue/river@v0.10.0
go get github.com/riverqueue/river/riverdriver/riverpgxv5@v0.10.0
```

### Database Schema

River manages its own schema via migrations:

```go
// cmd/migrate/main.go
package main

import (
    "context"
    "fmt"
    "os"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
    "github.com/riverqueue/river/rivermigrate"
)

func main() {
    ctx := context.Background()
    pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
    if err != nil {
        fmt.Fprintf(os.Stderr, "connect to database: %v\n", err)
        os.Exit(1)
    }
    defer pool.Close()

    migrator, err := rivermigrate.New(riverpgxv5.New(pool), nil)
    if err != nil {
        fmt.Fprintf(os.Stderr, "create migrator: %v\n", err)
        os.Exit(1)
    }

    result, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil)
    if err != nil {
        fmt.Fprintf(os.Stderr, "migrate: %v\n", err)
        os.Exit(1)
    }

    for _, version := range result.Versions {
        fmt.Printf("Applied River migration version %d\n", version.Version)
    }
}
```

### Defining Job Types

```go
// internal/jobs/types.go
package jobs

import (
    "time"
    "github.com/google/uuid"
)

// EmailJob sends transactional emails.
type EmailJob struct {
    To        string            `json:"to"`
    Subject   string            `json:"subject"`
    Template  string            `json:"template"`
    Variables map[string]string `json:"variables"`
}

// Kind returns the unique identifier for this job type.
func (EmailJob) Kind() string { return "email" }

// ReportJob generates a PDF report for a user.
type ReportJob struct {
    UserID     uuid.UUID `json:"user_id"`
    ReportType string    `json:"report_type"`
    StartDate  time.Time `json:"start_date"`
    EndDate    time.Time `json:"end_date"`
    Format     string    `json:"format"`  // pdf, csv, xlsx
}

func (ReportJob) Kind() string { return "report" }

// WebhookJob delivers a webhook payload to an external endpoint.
type WebhookJob struct {
    EndpointID uuid.UUID         `json:"endpoint_id"`
    EventType  string            `json:"event_type"`
    Payload    map[string]interface{} `json:"payload"`
    Attempt    int               `json:"attempt"`
}

func (WebhookJob) Kind() string { return "webhook" }
```

### Worker Implementations

```go
// internal/jobs/email_worker.go
package jobs

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/riverqueue/river"
    "github.com/yourorg/yourapp/internal/email"
)

// EmailWorker processes email delivery jobs.
type EmailWorker struct {
    river.WorkerDefaults[EmailJob]
    emailClient email.Client
    logger      *slog.Logger
}

// NewEmailWorker creates a new email worker.
func NewEmailWorker(emailClient email.Client, logger *slog.Logger) *EmailWorker {
    return &EmailWorker{
        emailClient: emailClient,
        logger:      logger,
    }
}

// Work processes a single email job.
func (w *EmailWorker) Work(ctx context.Context, job *river.Job[EmailJob]) error {
    args := job.Args

    w.logger.Info("processing email job",
        "job_id", job.ID,
        "to", args.To,
        "template", args.Template,
        "attempt", job.Attempt,
    )

    start := time.Now()
    if err := w.emailClient.SendTemplate(ctx, email.SendTemplateParams{
        To:        args.To,
        Subject:   args.Subject,
        Template:  args.Template,
        Variables: args.Variables,
    }); err != nil {
        w.logger.Error("email delivery failed",
            "job_id", job.ID,
            "to", args.To,
            "error", err,
            "elapsed", time.Since(start),
        )
        return fmt.Errorf("send email to %q: %w", args.To, err)
    }

    w.logger.Info("email delivered",
        "job_id", job.ID,
        "to", args.To,
        "elapsed", time.Since(start),
    )
    return nil
}

// Timeout returns the maximum time allowed for a single attempt.
func (w *EmailWorker) Timeout(*river.Job[EmailJob]) time.Duration {
    return 30 * time.Second
}

// NextRetry customizes the backoff strategy.
func (w *EmailWorker) NextRetry(job *river.Job[EmailJob]) time.Time {
    // Exponential backoff: 30s, 2m, 8m, 32m, 2h, ...
    backoff := time.Duration(30<<uint(job.Attempt-1)) * time.Second
    maxBackoff := 2 * time.Hour
    if backoff > maxBackoff {
        backoff = maxBackoff
    }
    return time.Now().Add(backoff)
}
```

```go
// internal/jobs/report_worker.go
package jobs

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/riverqueue/river"
    "github.com/yourorg/yourapp/internal/reports"
    "github.com/yourorg/yourapp/internal/storage"
)

// ReportWorker processes report generation jobs.
type ReportWorker struct {
    river.WorkerDefaults[ReportJob]
    reportService reports.Service
    storage       storage.Client
    logger        *slog.Logger
}

func (w *ReportWorker) Work(ctx context.Context, job *river.Job[ReportJob]) error {
    args := job.Args

    w.logger.Info("generating report",
        "job_id", job.ID,
        "user_id", args.UserID,
        "type", args.ReportType,
        "format", args.Format,
    )

    // Generate the report
    report, err := w.reportService.Generate(ctx, reports.GenerateParams{
        UserID:     args.UserID,
        ReportType: args.ReportType,
        StartDate:  args.StartDate,
        EndDate:    args.EndDate,
        Format:     args.Format,
    })
    if err != nil {
        return fmt.Errorf("generate report: %w", err)
    }

    // Upload to object storage
    key := fmt.Sprintf("reports/%s/%s-%s.%s",
        args.UserID, args.ReportType,
        args.EndDate.Format("2006-01-02"), args.Format,
    )
    if err := w.storage.Put(ctx, key, report.Data, storage.PutOptions{
        ContentType: report.ContentType,
        ExpiresAt:   time.Now().Add(30 * 24 * time.Hour),
    }); err != nil {
        return fmt.Errorf("upload report to storage: %w", err)
    }

    w.logger.Info("report generated and uploaded",
        "job_id", job.ID,
        "storage_key", key,
    )
    return nil
}

func (w *ReportWorker) Timeout(*river.Job[ReportJob]) time.Duration {
    return 10 * time.Minute  // Reports can take a while
}
```

### River Client Setup and Job Insertion

```go
// internal/queue/river_client.go
package queue

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
    "github.com/yourorg/yourapp/internal/jobs"
    "github.com/yourorg/yourapp/internal/email"
    "github.com/yourorg/yourapp/internal/reports"
    "github.com/yourorg/yourapp/internal/storage"
    "log/slog"
)

// Config holds River queue configuration.
type Config struct {
    Pool          *pgxpool.Pool
    EmailClient   email.Client
    ReportService reports.Service
    Storage       storage.Client
    Logger        *slog.Logger
}

// NewRiverClient creates and configures a River client with all workers.
func NewRiverClient(cfg Config) (*river.Client[pgx.Tx], error) {
    workers := river.NewWorkers()

    // Register all workers
    river.AddWorker(workers, jobs.NewEmailWorker(cfg.EmailClient, cfg.Logger))
    river.AddWorker(workers, &jobs.ReportWorker{
        reportService: cfg.ReportService,
        storage:       cfg.Storage,
        logger:        cfg.Logger,
    })
    river.AddWorker(workers, jobs.NewWebhookWorker(cfg.Logger))

    riverClient, err := river.NewClient(riverpgxv5.New(cfg.Pool), &river.Config{
        Queues: map[string]river.QueueConfig{
            river.QueueDefault: {MaxWorkers: 10},
            "critical":         {MaxWorkers: 50},  // High priority queue
            "reports":          {MaxWorkers: 5},   // CPU-intensive, fewer workers
            "webhooks":         {MaxWorkers: 100}, // High concurrency for webhooks
        },
        Workers: workers,
        // Fetch strategies
        FetchCooldown: 100 * time.Millisecond,
        FetchPollInterval: 500 * time.Millisecond,
        // Job completion callbacks
        JobCompleteCallback: func(ctx context.Context, job *rivertype.JobRow) {
            cfg.Logger.Info("job completed",
                "job_id", job.ID,
                "kind", job.Kind,
                "queue", job.Queue,
                "attempt", job.Attempt,
            )
        },
        ErrorHandler: &CustomErrorHandler{logger: cfg.Logger},
    })
    if err != nil {
        return nil, fmt.Errorf("create river client: %w", err)
    }

    return riverClient, nil
}

// CustomErrorHandler handles job errors and panics.
type CustomErrorHandler struct {
    logger *slog.Logger
}

func (h *CustomErrorHandler) HandleError(ctx context.Context, job *rivertype.JobRow, err error) *river.ErrorHandlerResult {
    h.logger.Error("job error",
        "job_id", job.ID,
        "kind", job.Kind,
        "attempt", job.Attempt,
        "error", err,
    )
    // Return nil to use default retry behavior
    return nil
}

func (h *CustomErrorHandler) HandlePanic(ctx context.Context, job *rivertype.JobRow, panicVal interface{}, trace string) *river.ErrorHandlerResult {
    h.logger.Error("job panic",
        "job_id", job.ID,
        "kind", job.Kind,
        "panic", fmt.Sprintf("%v", panicVal),
        "trace", trace,
    )
    return nil
}
```

### Transactional Job Insertion

```go
// internal/service/order_service.go
package service

import (
    "context"
    "fmt"

    "github.com/jackc/pgx/v5"
    "github.com/riverqueue/river"
    "github.com/yourorg/yourapp/internal/db"
    "github.com/yourorg/yourapp/internal/jobs"
)

// OrderService handles order creation with transactional job enqueue.
type OrderService struct {
    queries     *db.Queries
    riverClient *river.Client[pgx.Tx]
    pool        *pgxpool.Pool
}

// CreateOrder creates an order and enqueues fulfillment and notification jobs
// in a single database transaction.
func (s *OrderService) CreateOrder(ctx context.Context, params CreateOrderParams) (*db.Order, error) {
    var order *db.Order

    err := pgx.BeginTxFunc(ctx, s.pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
        // 1. Create the order in the database
        var err error
        order, err = s.queries.WithTx(tx).CreateOrder(ctx, db.CreateOrderParams{
            UserID: params.UserID,
            Items:  params.Items,
            Total:  params.Total,
        })
        if err != nil {
            return fmt.Errorf("create order: %w", err)
        }

        // 2. Enqueue jobs in the SAME transaction
        // If the transaction rolls back, the jobs are NOT enqueued.
        _, err = s.riverClient.InsertTx(ctx, tx, jobs.EmailJob{
            To:       params.UserEmail,
            Subject:  "Order Confirmation",
            Template: "order-confirmation",
            Variables: map[string]string{
                "order_id": order.ID.String(),
                "total":    fmt.Sprintf("%.2f", order.Total),
            },
        }, &river.InsertOpts{
            Queue:    "critical",
            Priority: 3,  // Higher number = higher priority
        })
        if err != nil {
            return fmt.Errorf("enqueue confirmation email: %w", err)
        }

        _, err = s.riverClient.InsertTx(ctx, tx, jobs.FulfillmentJob{
            OrderID: order.ID,
        }, &river.InsertOpts{
            Queue:       "fulfillment",
            MaxAttempts: 10,
        })
        if err != nil {
            return fmt.Errorf("enqueue fulfillment job: %w", err)
        }

        return nil
    })
    if err != nil {
        return nil, err
    }

    return order, nil
}
```

### Dead Letter Queue with River

River doesn't have a DLQ; instead, jobs that exceed `MaxAttempts` move to the `discarded` state. Query and requeue them:

```go
// internal/queue/dlq.go
package queue

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    rivertype "github.com/riverqueue/river/rivertype"
)

// DLQManager manages discarded (dead-lettered) jobs.
type DLQManager struct {
    client *river.Client[pgx.Tx]
    pool   *pgxpool.Pool
    logger *slog.Logger
}

// ListDiscardedJobs returns all discarded jobs with their final error.
func (m *DLQManager) ListDiscardedJobs(ctx context.Context, limit int) ([]*rivertype.JobRow, error) {
    params := river.JobListParams{}.WithState(river.JobStateDiscarded).WithLimit(limit)
    result, err := m.client.JobList(ctx, params)
    if err != nil {
        return nil, fmt.Errorf("list discarded jobs: %w", err)
    }
    return result.Jobs, nil
}

// RequeueDiscardedJob reschedules a discarded job for immediate execution.
func (m *DLQManager) RequeueDiscardedJob(ctx context.Context, jobID int64) error {
    // Get the job
    job, err := m.client.JobGet(ctx, jobID)
    if err != nil {
        return fmt.Errorf("get job %d: %w", jobID, err)
    }

    if job.State != river.JobStateDiscarded {
        return fmt.Errorf("job %d is not discarded (state: %s)", jobID, job.State)
    }

    // Retry the job by resetting its state
    result, err := m.client.JobRetry(ctx, jobID)
    if err != nil {
        return fmt.Errorf("retry job %d: %w", jobID, err)
    }

    m.logger.Info("requeued discarded job",
        "job_id", jobID,
        "kind", result.Kind,
        "new_state", result.State,
    )
    return nil
}

// RequeueAllDiscarded requeues all discarded jobs of a specific kind.
func (m *DLQManager) RequeueAllDiscarded(ctx context.Context, kind string) (int, error) {
    jobs, err := m.ListDiscardedJobs(ctx, 1000)
    if err != nil {
        return 0, err
    }

    requeued := 0
    for _, job := range jobs {
        if job.Kind != kind {
            continue
        }
        if err := m.RequeueDiscardedJob(ctx, job.ID); err != nil {
            m.logger.Error("requeue job", "job_id", job.ID, "error", err)
            continue
        }
        requeued++
    }
    return requeued, nil
}
```

## Section 3: Asynq — Redis-Backed High-Throughput Queue

Asynq provides high throughput (100K+ jobs/sec) using Redis sorted sets for scheduling and a worker pool model.

### Installation

```bash
go get github.com/hibiken/asynq@v0.24.1
```

### Task Definitions

```go
// internal/tasks/types.go
package tasks

import (
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/hibiken/asynq"
)

// Task type constants
const (
    TypeSendEmail     = "email:send"
    TypeGenerateReport = "report:generate"
    TypeWebhookDeliver = "webhook:deliver"
    TypeImageProcess   = "image:process"
    TypeIndexDocument  = "search:index"
)

// EmailPayload holds parameters for email sending tasks.
type EmailPayload struct {
    To        string            `json:"to"`
    Subject   string            `json:"subject"`
    Template  string            `json:"template"`
    Variables map[string]string `json:"variables"`
    MessageID uuid.UUID         `json:"message_id"`
}

// NewEmailTask creates an Asynq task for sending an email.
func NewEmailTask(payload EmailPayload, opts ...asynq.Option) (*asynq.Task, error) {
    data, err := json.Marshal(payload)
    if err != nil {
        return nil, fmt.Errorf("marshal email payload: %w", err)
    }

    defaultOpts := []asynq.Option{
        asynq.Queue("critical"),
        asynq.MaxRetry(5),
        asynq.Timeout(30 * time.Second),
        asynq.Deadline(time.Now().Add(24 * time.Hour)),
        asynq.UniqueFor(24 * time.Hour),  // Prevent duplicate emails
    }
    opts = append(defaultOpts, opts...)

    return asynq.NewTask(TypeSendEmail, data, opts...), nil
}

// WebhookPayload holds parameters for webhook delivery.
type WebhookPayload struct {
    EndpointURL string                 `json:"endpoint_url"`
    EventType   string                 `json:"event_type"`
    Payload     map[string]interface{} `json:"payload"`
    Headers     map[string]string      `json:"headers"`
    DeliveryID  uuid.UUID              `json:"delivery_id"`
}

func NewWebhookTask(payload WebhookPayload, opts ...asynq.Option) (*asynq.Task, error) {
    data, err := json.Marshal(payload)
    if err != nil {
        return nil, fmt.Errorf("marshal webhook payload: %w", err)
    }

    defaultOpts := []asynq.Option{
        asynq.Queue("webhooks"),
        asynq.MaxRetry(10),
        asynq.Timeout(10 * time.Second),
        // Exponential backoff via RetryDelayFunc
        asynq.RetryDelayFunc(exponentialBackoff(30*time.Second, 2.0, 2*time.Hour)),
    }
    opts = append(defaultOpts, opts...)

    return asynq.NewTask(TypeWebhookDeliver, data, opts...), nil
}

// exponentialBackoff returns an Asynq retry delay function.
func exponentialBackoff(base time.Duration, multiplier float64, maxDelay time.Duration) asynq.RetryDelayFunc {
    return func(n int, e error, t *asynq.Task) time.Duration {
        delay := time.Duration(float64(base) * math.Pow(multiplier, float64(n)))
        if delay > maxDelay {
            delay = maxDelay
        }
        // Add jitter to prevent thundering herd
        jitter := time.Duration(rand.Int63n(int64(delay / 10)))
        return delay + jitter
    }
}
```

### Worker Handlers

```go
// internal/tasks/email_handler.go
package tasks

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"
    "time"

    "github.com/hibiken/asynq"
    "github.com/yourorg/yourapp/internal/email"
)

// EmailHandler processes email sending tasks.
type EmailHandler struct {
    emailClient email.Client
    logger      *slog.Logger
}

func NewEmailHandler(emailClient email.Client, logger *slog.Logger) *EmailHandler {
    return &EmailHandler{emailClient: emailClient, logger: logger}
}

func (h *EmailHandler) ProcessTask(ctx context.Context, t *asynq.Task) error {
    var payload EmailPayload
    if err := json.Unmarshal(t.Payload(), &payload); err != nil {
        // Permanent failure: cannot parse payload
        return fmt.Errorf("%w: unmarshal email payload: %v",
            asynq.SkipRetry, err)
    }

    start := time.Now()
    h.logger.Info("processing email task",
        "message_id", payload.MessageID,
        "to", payload.To,
        "template", payload.Template,
    )

    if err := h.emailClient.SendTemplate(ctx, email.SendTemplateParams{
        To:        payload.To,
        Subject:   payload.Subject,
        Template:  payload.Template,
        Variables: payload.Variables,
    }); err != nil {
        // Check for permanent failures that should not be retried
        if email.IsInvalidAddressError(err) {
            return fmt.Errorf("%w: invalid email address %q: %v",
                asynq.SkipRetry, payload.To, err)
        }
        // Transient error — will be retried
        return fmt.Errorf("send email: %w", err)
    }

    h.logger.Info("email delivered",
        "message_id", payload.MessageID,
        "elapsed", time.Since(start),
    )
    return nil
}
```

### Asynq Server Configuration with Priority Queues

```go
// internal/queue/asynq_server.go
package queue

import (
    "log/slog"

    "github.com/hibiken/asynq"
    "github.com/yourorg/yourapp/internal/tasks"
    "github.com/yourorg/yourapp/internal/email"
    "github.com/yourorg/yourapp/internal/reports"
)

// Config holds Asynq server configuration.
type AsynqConfig struct {
    RedisAddr    string
    RedisDB      int
    EmailClient  email.Client
    ReportSvc    reports.Service
    Logger       *slog.Logger
}

// NewAsynqServer creates and configures the Asynq worker server.
func NewAsynqServer(cfg AsynqConfig) (*asynq.Server, *asynq.ServeMux) {
    redisOpt := asynq.RedisClientOpt{
        Addr: cfg.RedisAddr,
        DB:   cfg.RedisDB,
    }

    server := asynq.NewServer(redisOpt, asynq.Config{
        // Priority queues: higher weight = more workers allocated
        Queues: map[string]int{
            "critical": 10,  // 10/22 workers = ~45%
            "default":  6,   // 6/22 = ~27%
            "webhooks": 4,   // 4/22 = ~18%
            "reports":  2,   // 2/22 = ~9%
        },
        // Total worker pool size
        Concurrency: 22,

        // Retry configuration
        RetryDelayFunc: asynq.DefaultRetryDelayFunc,
        IsFailure: func(err error) bool {
            // Don't count SkipRetry as a failure metric
            return !errors.Is(err, asynq.SkipRetry)
        },

        // Error logging
        ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
            cfg.Logger.Error("task processing failed",
                "type", task.Type(),
                "error", err,
            )
        }),

        // Shutdown grace period
        ShutdownTimeout: 30 * time.Second,

        // Health check
        HealthCheckFunc: func(err error) {
            if err != nil {
                cfg.Logger.Error("asynq health check failed", "error", err)
            }
        },
        HealthCheckInterval: 15 * time.Second,
    })

    // Configure the mux with task handlers
    mux := asynq.NewServeMux()

    // Email tasks
    emailHandler := tasks.NewEmailHandler(cfg.EmailClient, cfg.Logger)
    mux.HandleFunc(tasks.TypeSendEmail, emailHandler.ProcessTask)

    // Report tasks
    reportHandler := tasks.NewReportHandler(cfg.ReportSvc, cfg.Logger)
    mux.HandleFunc(tasks.TypeGenerateReport, reportHandler.ProcessTask)

    // Webhook tasks
    webhookHandler := tasks.NewWebhookHandler(cfg.Logger)
    mux.HandleFunc(tasks.TypeWebhookDeliver, webhookHandler.ProcessTask)

    // Middleware: logging, metrics, panic recovery
    mux.Use(
        loggingMiddleware(cfg.Logger),
        metricsMiddleware(),
        panicRecoveryMiddleware(cfg.Logger),
    )

    return server, mux
}
```

### Middleware Stack

```go
// internal/queue/middleware.go
package queue

import (
    "context"
    "fmt"
    "log/slog"
    "runtime/debug"
    "time"

    "github.com/hibiken/asynq"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    taskProcessingDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "asynq_task_processing_duration_seconds",
            Help:    "Task processing duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"type", "queue", "status"},
    )
    taskProcessingTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "asynq_task_processing_total",
            Help: "Total number of tasks processed",
        },
        []string{"type", "queue", "status"},
    )
)

// loggingMiddleware logs task start and completion.
func loggingMiddleware(logger *slog.Logger) asynq.MiddlewareFunc {
    return func(h asynq.Handler) asynq.Handler {
        return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
            start := time.Now()
            logger.Info("task started",
                "type", t.Type(),
                "payload_size", len(t.Payload()),
            )

            err := h.ProcessTask(ctx, t)

            if err != nil {
                logger.Error("task failed",
                    "type", t.Type(),
                    "elapsed", time.Since(start),
                    "error", err,
                )
            } else {
                logger.Info("task completed",
                    "type", t.Type(),
                    "elapsed", time.Since(start),
                )
            }
            return err
        })
    }
}

// metricsMiddleware records Prometheus metrics for each task.
func metricsMiddleware() asynq.MiddlewareFunc {
    return func(h asynq.Handler) asynq.Handler {
        return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
            start := time.Now()

            err := h.ProcessTask(ctx, t)

            status := "success"
            if err != nil {
                status = "failure"
                if errors.Is(err, asynq.SkipRetry) {
                    status = "skipped"
                }
            }

            queue, _ := asynq.GetQueueName(ctx)
            taskProcessingDuration.WithLabelValues(t.Type(), queue, status).
                Observe(time.Since(start).Seconds())
            taskProcessingTotal.WithLabelValues(t.Type(), queue, status).Inc()

            return err
        })
    }
}

// panicRecoveryMiddleware catches panics in handlers.
func panicRecoveryMiddleware(logger *slog.Logger) asynq.MiddlewareFunc {
    return func(h asynq.Handler) asynq.Handler {
        return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) (err error) {
            defer func() {
                if r := recover(); r != nil {
                    logger.Error("task handler panicked",
                        "type", t.Type(),
                        "panic", fmt.Sprintf("%v", r),
                        "stack", string(debug.Stack()),
                    )
                    err = fmt.Errorf("task panicked: %v", r)
                }
            }()
            return h.ProcessTask(ctx, t)
        })
    }
}
```

## Section 4: Dead Letter Queue Patterns with Asynq

```go
// internal/queue/dlq_asynq.go
package queue

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/hibiken/asynq"
)

// AsynqDLQManager manages dead-lettered tasks in Asynq.
type AsynqDLQManager struct {
    inspector *asynq.Inspector
    client    *asynq.Client
    logger    *slog.Logger
}

// NewAsynqDLQManager creates a DLQ manager.
func NewAsynqDLQManager(redisOpt asynq.RedisClientOpt, logger *slog.Logger) *AsynqDLQManager {
    return &AsynqDLQManager{
        inspector: asynq.NewInspector(redisOpt),
        client:    asynq.NewClient(redisOpt),
        logger:    logger,
    }
}

// GetArchivedTasks retrieves tasks in the archived (dead-lettered) state.
func (m *AsynqDLQManager) GetArchivedTasks(ctx context.Context, queue string, page, size int) ([]*asynq.TaskInfo, error) {
    tasks, err := m.inspector.ListArchivedTasks(queue,
        asynq.PageSize(size),
        asynq.Page(page),
    )
    if err != nil {
        return nil, fmt.Errorf("list archived tasks in queue %q: %w", queue, err)
    }
    return tasks, nil
}

// RunArchivedTask moves an archived task back to the pending state.
func (m *AsynqDLQManager) RunArchivedTask(ctx context.Context, queue, taskID string) error {
    if err := m.inspector.RunArchivedTask(queue, taskID); err != nil {
        return fmt.Errorf("run archived task %q: %w", taskID, err)
    }
    m.logger.Info("archived task requeued", "queue", queue, "task_id", taskID)
    return nil
}

// DeleteArchivedTask permanently deletes an archived task.
func (m *AsynqDLQManager) DeleteArchivedTask(ctx context.Context, queue, taskID string) error {
    if err := m.inspector.DeleteArchivedTask(queue, taskID); err != nil {
        return fmt.Errorf("delete archived task %q: %w", taskID, err)
    }
    return nil
}

// RunAllArchivedByType requeues all archived tasks of a specific type.
func (m *AsynqDLQManager) RunAllArchivedByType(ctx context.Context, queue, taskType string) (int, error) {
    tasks, err := m.GetArchivedTasks(ctx, queue, 1, 1000)
    if err != nil {
        return 0, err
    }

    requeued := 0
    for _, task := range tasks {
        if task.Type != taskType {
            continue
        }
        if err := m.RunArchivedTask(ctx, queue, task.ID); err != nil {
            m.logger.Error("requeue archived task",
                "task_id", task.ID,
                "error", err,
            )
            continue
        }
        requeued++
    }

    m.logger.Info("requeued archived tasks",
        "queue", queue,
        "type", taskType,
        "count", requeued,
    )
    return requeued, nil
}

// QueueStats returns statistics for all queues.
func (m *AsynqDLQManager) QueueStats(ctx context.Context) (map[string]*asynq.QueueStats, error) {
    queues, err := m.inspector.Queues()
    if err != nil {
        return nil, fmt.Errorf("list queues: %w", err)
    }

    stats := make(map[string]*asynq.QueueStats)
    for _, q := range queues {
        s, err := m.inspector.GetQueueInfo(q)
        if err != nil {
            m.logger.Error("get queue stats", "queue", q, "error", err)
            continue
        }
        stats[q] = s
    }
    return stats, nil
}
```

## Section 5: Prometheus Metrics and Queue Health Monitoring

### Asynq Queue Metrics Exporter

```go
// internal/queue/metrics.go
package queue

import (
    "context"
    "log/slog"
    "time"

    "github.com/hibiken/asynq"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    queueSize = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "asynq_queue_size",
            Help: "Number of tasks in each queue state",
        },
        []string{"queue", "state"},
    )
    queueLatency = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "asynq_queue_latency_seconds",
            Help: "Latency of the queue (age of oldest pending task)",
        },
        []string{"queue"},
    )
    queuePaused = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "asynq_queue_paused",
            Help: "Whether the queue is paused (1=paused, 0=active)",
        },
        []string{"queue"},
    )
)

// MetricsCollector collects Asynq queue metrics for Prometheus.
type MetricsCollector struct {
    inspector *asynq.Inspector
    logger    *slog.Logger
}

// Collect updates all queue metrics.
func (c *MetricsCollector) Collect(ctx context.Context) {
    queues, err := c.inspector.Queues()
    if err != nil {
        c.logger.Error("list queues for metrics", "error", err)
        return
    }

    for _, q := range queues {
        info, err := c.inspector.GetQueueInfo(q)
        if err != nil {
            c.logger.Error("get queue info", "queue", q, "error", err)
            continue
        }

        queueSize.WithLabelValues(q, "active").Set(float64(info.Active))
        queueSize.WithLabelValues(q, "pending").Set(float64(info.Pending))
        queueSize.WithLabelValues(q, "scheduled").Set(float64(info.Scheduled))
        queueSize.WithLabelValues(q, "retry").Set(float64(info.Retry))
        queueSize.WithLabelValues(q, "archived").Set(float64(info.Archived))

        queueLatency.WithLabelValues(q).Set(info.Latency.Seconds())

        pausedVal := 0.0
        if info.Paused {
            pausedVal = 1.0
        }
        queuePaused.WithLabelValues(q).Set(pausedVal)
    }
}

// StartMetricsCollector runs the collector on an interval.
func StartMetricsCollector(ctx context.Context, inspector *asynq.Inspector, interval time.Duration, logger *slog.Logger) {
    collector := &MetricsCollector{inspector: inspector, logger: logger}

    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                collector.Collect(ctx)
            }
        }
    }()
}
```

### PrometheusRule Alerts

```yaml
# queue-alert-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: job-queue-alerts
  namespace: monitoring
spec:
  groups:
    - name: asynq.queue
      rules:
        - alert: HighArchivedTaskCount
          expr: asynq_queue_size{state="archived"} > 100
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "High archived task count in queue {{ $labels.queue }}"
            description: "{{ $value }} tasks are in the dead letter queue for {{ $labels.queue }}."

        - alert: QueueLatencyHigh
          expr: asynq_queue_latency_seconds > 300
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High queue latency in {{ $labels.queue }}"
            description: "Oldest pending task in {{ $labels.queue }} is {{ $value | humanizeDuration }} old."

        - alert: QueuePaused
          expr: asynq_queue_paused == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Queue {{ $labels.queue }} is paused"
            description: "Jobs are not being processed from {{ $labels.queue }}."

        - alert: HighRetryQueueDepth
          expr: asynq_queue_size{state="retry"} > 500
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "High retry queue depth in {{ $labels.queue }}"
            description: "{{ $value }} tasks are being retried in {{ $labels.queue }}. Check for systemic failures."
```

## Section 6: Scheduled Jobs

### River Periodic Jobs

```go
// internal/queue/periodic_jobs.go (River)
package queue

import (
    "github.com/riverqueue/river"
    "github.com/yourorg/yourapp/internal/jobs"
)

// RegisterPeriodicJobs adds scheduled jobs to the River client config.
func RegisterPeriodicJobs(cfg *river.Config) {
    cfg.PeriodicJobs = []*river.PeriodicJob{
        // Daily report generation at 2am UTC
        river.NewPeriodicJob(
            river.PeriodicInterval(24*time.Hour),
            func() (river.JobArgs, *river.InsertOpts) {
                return jobs.DailyDigestJob{
                    Date: time.Now().UTC().Truncate(24 * time.Hour),
                }, &river.InsertOpts{
                    Queue:    "reports",
                    Priority: 1,
                }
            },
            &river.PeriodicJobOpts{
                RunImmediately: false,
                ScheduleFunc: func(now time.Time) time.Time {
                    // Next 2am UTC
                    next := time.Date(now.Year(), now.Month(), now.Day(), 2, 0, 0, 0, time.UTC)
                    if now.After(next) {
                        next = next.Add(24 * time.Hour)
                    }
                    return next
                },
            },
        ),

        // Hourly webhook retry sweep
        river.NewPeriodicJob(
            river.PeriodicInterval(time.Hour),
            func() (river.JobArgs, *river.InsertOpts) {
                return jobs.WebhookRetrySweepJob{}, nil
            },
            nil,
        ),
    }
}
```

### Asynq Scheduled Tasks

```go
// internal/queue/scheduler.go (Asynq)
package queue

import (
    "fmt"
    "log/slog"

    "github.com/hibiken/asynq"
    "github.com/yourorg/yourapp/internal/tasks"
)

func NewScheduler(redisOpt asynq.RedisClientOpt, logger *slog.Logger) *asynq.Scheduler {
    scheduler := asynq.NewScheduler(redisOpt, &asynq.SchedulerOpts{
        LogLevel: asynq.WarnLevel,
        PostEnqueueFunc: func(info *asynq.TaskInfo, err error) {
            if err != nil {
                logger.Error("failed to enqueue scheduled task",
                    "type", info.Type,
                    "error", err,
                )
            }
        },
    })

    // Daily report at 2am UTC
    task, _ := tasks.NewDailyDigestTask(tasks.DailyDigestPayload{})
    if _, err := scheduler.Register("0 2 * * *", task,
        asynq.Queue("reports"),
        asynq.MaxRetry(3),
    ); err != nil {
        panic(fmt.Sprintf("register daily digest: %v", err))
    }

    // Hourly cleanup
    cleanupTask, _ := tasks.NewCleanupTask()
    if _, err := scheduler.Register("@hourly", cleanupTask,
        asynq.Queue("default"),
    ); err != nil {
        panic(fmt.Sprintf("register cleanup: %v", err))
    }

    return scheduler
}
```

## Section 7: Graceful Shutdown

```go
// cmd/worker/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "sync"
    "syscall"

    "github.com/hibiken/asynq"
    "github.com/yourorg/yourapp/internal/queue"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    redisOpt := asynq.RedisClientOpt{Addr: os.Getenv("REDIS_ADDR")}

    // Create server and mux
    server, mux := queue.NewAsynqServer(queue.AsynqConfig{
        RedisAddr: os.Getenv("REDIS_ADDR"),
        Logger:    logger,
        // ... other config
    })

    // Start the scheduler
    scheduler := queue.NewScheduler(redisOpt, logger)
    if err := scheduler.Start(); err != nil {
        logger.Error("start scheduler", "error", err)
        os.Exit(1)
    }

    // Start metrics collector
    ctx, cancel := context.WithCancel(context.Background())
    queue.StartMetricsCollector(ctx, asynq.NewInspector(redisOpt), 15*time.Second, logger)

    // Start workers
    var wg sync.WaitGroup
    wg.Add(1)
    go func() {
        defer wg.Done()
        if err := server.Run(mux); err != nil {
            logger.Error("server run", "error", err)
        }
    }()

    // Graceful shutdown on SIGINT/SIGTERM
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    logger.Info("shutting down worker...")
    cancel()
    scheduler.Shutdown()
    server.Shutdown()
    wg.Wait()

    logger.Info("worker stopped")
}
```

Async job processing with River or Asynq eliminates the synchronous bottlenecks that limit application scalability. River's transactional enqueue is the right choice whenever job creation must be atomic with database writes; Asynq is the right choice when throughput and latency matter more than strict consistency. In both cases, the patterns here — priority queues, dead letter handling, retry policies with exponential backoff, and Prometheus observability — form the production-ready foundation your team needs.
