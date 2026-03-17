---
title: "Go Task Queues: Asynq, Machinery, and River for Background Job Processing"
date: 2031-02-26T00:00:00-05:00
draft: false
tags: ["Go", "Task Queues", "Asynq", "River", "Background Jobs", "Redis", "PostgreSQL"]
categories:
- Go
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive comparison of Asynq, River, and Machinery for Go background job processing covering architecture, Redis vs PostgreSQL backends, job scheduling, retry policies, dead letter queues, deduplication, and built-in monitoring UIs."
more_link: "yes"
url: "/go-task-queues-asynq-machinery-river-background-job-processing/"
---

Background job processing is a fundamental building block for production Go services: sending emails, processing uploads, generating reports, syncing external APIs, and running scheduled maintenance tasks. The choice of job queue shapes your operational model — Redis-backed queues favor speed and simplicity, while PostgreSQL-backed queues integrate with existing transactional infrastructure for exactly-once semantics.

This guide provides a production-depth comparison of the three major Go job queue libraries — Asynq, River, and Machinery — with complete examples for each.

<!--more-->

# Go Task Queues: Asynq, Machinery, and River for Background Job Processing

## Section 1: Architecture Comparison

### Asynq (Redis-backed)

Asynq uses Redis as its backing store. Jobs are stored as Redis keys with TTL. It provides:
- Multi-queue support with priorities
- Scheduled tasks (cron-style and one-time)
- Retry with configurable backoff
- Unique jobs (deduplication by ID)
- Dead letter queue
- Asynqmon web UI

**Best for**: High-throughput fire-and-forget jobs, services that already use Redis, fast job enqueue latency.

### River (PostgreSQL-backed)

River stores jobs in a PostgreSQL table. Job state transitions are transactional — you can enqueue a job and update application state atomically.

- ACID job insertion (enqueue within existing database transaction)
- Exactly-once via advisory locks
- Scheduled jobs
- Unique jobs
- Dead letter queue
- River UI or custom queries

**Best for**: Jobs that must be consistent with database state, payment processing, order workflows, any job where "exactly once" matters.

### Machinery (Redis or AMQP-backed)

Machinery supports multiple brokers (Redis, AMQP/RabbitMQ) and result backends. It emphasizes workflow orchestration — chains, groups, chords (fan-out/fan-in).

- Workflow chains (sequence of tasks)
- Task groups (parallel execution)
- Chords (group + callback)
- Multiple broker backends

**Best for**: ETL pipelines, workflow orchestration, existing RabbitMQ infrastructure.

| Feature | Asynq | River | Machinery |
|---|---|---|---|
| Backend | Redis | PostgreSQL | Redis, AMQP |
| Exactly-once | No (best effort unique) | Yes (advisory lock) | No |
| Transactional enqueue | No | Yes | No |
| Workflows | Basic | No | Yes (chains/groups) |
| Scheduled tasks | Yes | Yes | Yes |
| Dead letter queue | Yes | Yes | No (manual) |
| Web UI | Asynqmon | River UI | No (community) |
| Throughput | Very high | Moderate | High |

## Section 2: Asynq — Getting Started

### Installation

```bash
go get github.com/hibiken/asynq
```

### Defining Task Types

```go
// tasks/tasks.go
package tasks

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/hibiken/asynq"
)

// Task type constants
const (
    TypeEmailWelcome       = "email:welcome"
    TypeEmailPasswordReset = "email:password_reset"
    TypeImageResize        = "image:resize"
    TypeReportGenerate     = "report:generate"
    TypeUserSync           = "user:sync"
)

// --- Email: Welcome ---

type EmailWelcomePayload struct {
    UserID   int64  `json:"user_id"`
    Email    string `json:"email"`
    Name     string `json:"name"`
    PlanType string `json:"plan_type"`
}

func NewEmailWelcomeTask(userID int64, email, name, planType string) (*asynq.Task, error) {
    payload, err := json.Marshal(EmailWelcomePayload{
        UserID:   userID,
        Email:    email,
        Name:     name,
        PlanType: planType,
    })
    if err != nil {
        return nil, err
    }
    return asynq.NewTask(TypeEmailWelcome, payload,
        // Options
        asynq.MaxRetry(3),
        asynq.Timeout(30*time.Second),
        asynq.Queue("email"),
        // Unique for 24 hours — prevent duplicate welcome emails
        asynq.Unique(24*time.Hour),
    ), nil
}

// --- Image: Resize ---

type ImageResizePayload struct {
    ImageID   string `json:"image_id"`
    StorePath string `json:"store_path"`
    Width     int    `json:"width"`
    Height    int    `json:"height"`
    Quality   int    `json:"quality"`
}

func NewImageResizeTask(imageID, storePath string, width, height, quality int) (*asynq.Task, error) {
    payload, err := json.Marshal(ImageResizePayload{
        ImageID:   imageID,
        StorePath: storePath,
        Width:     width,
        Height:    height,
        Quality:   quality,
    })
    if err != nil {
        return nil, err
    }
    return asynq.NewTask(TypeImageResize, payload,
        asynq.MaxRetry(5),
        asynq.Timeout(2*time.Minute),
        asynq.Queue("media"),
        asynq.Retention(72*time.Hour), // Keep completed task info for 3 days
    ), nil
}

// --- Report: Generate ---

type ReportGeneratePayload struct {
    ReportID   string    `json:"report_id"`
    OrgID      int64     `json:"org_id"`
    ReportType string    `json:"report_type"`
    StartDate  time.Time `json:"start_date"`
    EndDate    time.Time `json:"end_date"`
    NotifyEmail string   `json:"notify_email"`
}

func NewReportGenerateTask(payload ReportGeneratePayload) (*asynq.Task, error) {
    data, err := json.Marshal(payload)
    if err != nil {
        return nil, err
    }
    return asynq.NewTask(TypeReportGenerate, data,
        asynq.MaxRetry(2),
        asynq.Timeout(10*time.Minute),
        asynq.Queue("reports"),
        // Task ID for deduplication (only one report per ID)
        asynq.TaskID(fmt.Sprintf("report:%s", payload.ReportID)),
    ), nil
}
```

### Task Handlers

```go
// handlers/handlers.go
package handlers

import (
    "context"
    "encoding/json"
    "fmt"
    "log/slog"

    "github.com/hibiken/asynq"
    "yourapp/tasks"
)

// EmailHandler handles all email task types
type EmailHandler struct {
    emailSvc EmailService
    logger   *slog.Logger
}

type EmailService interface {
    SendWelcome(ctx context.Context, email, name, planType string) error
    SendPasswordReset(ctx context.Context, email, token string) error
}

func (h *EmailHandler) HandleWelcomeEmail(ctx context.Context, t *asynq.Task) error {
    var payload tasks.EmailWelcomePayload
    if err := json.Unmarshal(t.Payload(), &payload); err != nil {
        // Don't retry on bad payload
        return fmt.Errorf("%w: %v", asynq.SkipRetry, err)
    }

    h.logger.InfoContext(ctx, "processing welcome email",
        "user_id", payload.UserID,
        "email", payload.Email)

    if err := h.emailSvc.SendWelcome(ctx, payload.Email, payload.Name, payload.PlanType); err != nil {
        // Retry on transient errors
        return fmt.Errorf("send welcome email: %w", err)
    }

    h.logger.InfoContext(ctx, "welcome email sent",
        "user_id", payload.UserID)
    return nil
}

// ImageHandler handles image processing tasks
type ImageHandler struct {
    storage    StorageService
    imageProc  ImageProcessor
    logger     *slog.Logger
}

func (h *ImageHandler) HandleResize(ctx context.Context, t *asynq.Task) error {
    var payload tasks.ImageResizePayload
    if err := json.Unmarshal(t.Payload(), &payload); err != nil {
        return fmt.Errorf("%w: invalid payload: %v", asynq.SkipRetry, err)
    }

    // Check idempotency — already processed?
    if exists, _ := h.storage.Exists(ctx, outputPath(payload)); exists {
        h.logger.InfoContext(ctx, "image already resized, skipping",
            "image_id", payload.ImageID)
        return nil
    }

    // Process
    resized, err := h.imageProc.Resize(ctx, payload.StorePath, payload.Width, payload.Height, payload.Quality)
    if err != nil {
        return fmt.Errorf("resize image %s: %w", payload.ImageID, err)
    }

    // Store result
    if err := h.storage.Put(ctx, outputPath(payload), resized); err != nil {
        return fmt.Errorf("store resized image %s: %w", payload.ImageID, err)
    }

    return nil
}

func outputPath(p tasks.ImageResizePayload) string {
    return fmt.Sprintf("resized/%s_%dx%d_q%d.jpg", p.ImageID, p.Width, p.Height, p.Quality)
}
```

### Asynq Server Setup

```go
// cmd/worker/main.go
package main

import (
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "github.com/hibiken/asynq"
    "yourapp/handlers"
    "yourapp/tasks"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Redis connection
    redisOpt := asynq.RedisClientOpt{
        Addr:     "redis:6379",
        Password: "",
        DB:       0,
        PoolSize: 10,
    }

    // Create server with queue configuration
    srv := asynq.NewServer(
        redisOpt,
        asynq.Config{
            // Concurrency per queue (total workers)
            Concurrency: 20,

            // Queue priorities (higher number = higher priority)
            Queues: map[string]int{
                "critical": 10,  // Payment, security tasks
                "email":    6,   // Email notifications
                "media":    4,   // Image/video processing
                "reports":  2,   // Report generation
                "default":  1,   // Everything else
            },

            // Maximum retries
            RetryDelayFunc: func(n int, err error, task *asynq.Task) time.Duration {
                // Exponential backoff: 2^n seconds, max 1 hour
                delay := time.Duration(math.Pow(2, float64(n))) * time.Second
                if delay > time.Hour {
                    delay = time.Hour
                }
                return delay
            },

            // Error handler
            ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
                logger.Error("task failed",
                    "task_type", task.Type(),
                    "error", err.Error())
            }),

            // Logger
            Logger: newAsynqLogger(logger),

            // Health check
            HealthCheckFunc: func(err error) {
                if err != nil {
                    logger.Error("unhealthy", "error", err.Error())
                }
            },

            // Shutdown timeout
            ShutdownTimeout: 30 * time.Second,
        },
    )

    // Build service dependencies
    emailSvc := handlers.NewEmailService(/* ... */)
    storageSvc := handlers.NewStorageService(/* ... */)
    imageProc := handlers.NewImageProcessor()

    emailHandler := &handlers.EmailHandler{emailSvc: emailSvc, logger: logger}
    imageHandler := &handlers.ImageHandler{storage: storageSvc, imageProc: imageProc, logger: logger}

    // Register handlers
    mux := asynq.NewServeMux()
    mux.HandleFunc(tasks.TypeEmailWelcome, emailHandler.HandleWelcomeEmail)
    mux.HandleFunc(tasks.TypeEmailPasswordReset, emailHandler.HandlePasswordReset)
    mux.HandleFunc(tasks.TypeImageResize, imageHandler.HandleResize)
    mux.HandleFunc(tasks.TypeReportGenerate, handlers.HandleReportGenerate)

    // Graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        <-sigCh
        srv.Shutdown()
    }()

    logger.Info("starting asynq worker", "concurrency", 20)
    if err := srv.Run(mux); err != nil {
        logger.Error("worker failed", "error", err.Error())
        os.Exit(1)
    }
}
```

### Enqueueing Tasks

```go
// client/enqueue.go
package client

import (
    "context"
    "fmt"
    "time"

    "github.com/hibiken/asynq"
    "yourapp/tasks"
)

type TaskClient struct {
    client *asynq.Client
}

func NewTaskClient(redisAddr string) *TaskClient {
    return &TaskClient{
        client: asynq.NewClient(asynq.RedisClientOpt{Addr: redisAddr}),
    }
}

func (tc *TaskClient) EnqueueWelcomeEmail(ctx context.Context, userID int64, email, name, plan string) error {
    task, err := tasks.NewEmailWelcomeTask(userID, email, name, plan)
    if err != nil {
        return fmt.Errorf("create welcome email task: %w", err)
    }
    info, err := tc.client.EnqueueContext(ctx, task)
    if err != nil {
        return fmt.Errorf("enqueue welcome email: %w", err)
    }
    return nil
    _ = info
}

// Schedule a task for future execution
func (tc *TaskClient) ScheduleReport(ctx context.Context, payload tasks.ReportGeneratePayload, at time.Time) error {
    task, err := tasks.NewReportGenerateTask(payload)
    if err != nil {
        return err
    }
    _, err = tc.client.EnqueueContext(ctx, task,
        asynq.ProcessAt(at),
    )
    return err
}
```

### Asynq Scheduler for Cron Jobs

```go
// cmd/scheduler/main.go
package main

import (
    "log"

    "github.com/hibiken/asynq"
)

func main() {
    redisOpt := asynq.RedisClientOpt{Addr: "redis:6379"}

    scheduler := asynq.NewScheduler(redisOpt, &asynq.SchedulerOpts{
        LogLevel: asynq.InfoLevel,
    })

    // Daily user sync at 2:00 AM UTC
    if _, err := scheduler.Register("0 2 * * *",
        asynq.NewTask("user:sync", nil,
            asynq.Queue("default"),
            asynq.Timeout(30*time.Minute))); err != nil {
        log.Fatal(err)
    }

    // Hourly report refresh
    if _, err := scheduler.Register("0 * * * *",
        asynq.NewTask("report:refresh", nil,
            asynq.Queue("reports"))); err != nil {
        log.Fatal(err)
    }

    // Every 5 minutes: health check external APIs
    if _, err := scheduler.Register("*/5 * * * *",
        asynq.NewTask("healthcheck:external", nil,
            asynq.Queue("critical"),
            asynq.Timeout(30*time.Second))); err != nil {
        log.Fatal(err)
    }

    if err := scheduler.Run(); err != nil {
        log.Fatal(err)
    }
}
```

## Section 3: River — PostgreSQL-Backed Jobs

### Installation

```bash
go get github.com/riverqueue/river
go get github.com/riverqueue/river/riverdriver/riverpgxv5
```

### Database Setup

```sql
-- River requires schema installation
-- Run the River CLI or apply the migration:
CREATE TABLE river_job (
  id          BIGSERIAL PRIMARY KEY,
  args        JSONB NOT NULL DEFAULT '{}',
  attempt     SMALLINT NOT NULL DEFAULT 0,
  attempted_at TIMESTAMPTZ,
  attempted_by TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  errors      JSONB[],
  finalized_at TIMESTAMPTZ,
  kind        TEXT NOT NULL,
  max_attempts SMALLINT NOT NULL DEFAULT 25,
  metadata    JSONB NOT NULL DEFAULT '{}',
  priority    SMALLINT NOT NULL DEFAULT 1,
  queue       TEXT NOT NULL DEFAULT 'default',
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state       river_job_state NOT NULL DEFAULT 'available',
  tags        TEXT[] NOT NULL DEFAULT '{}'
);
```

```bash
# Install River CLI for migrations
go install github.com/riverqueue/river/cmd/river@latest

# Apply migrations
river migrate-up --database-url "postgres://user:pass@localhost/mydb"
```

### Defining River Jobs

```go
// jobs/email_job.go
package jobs

import (
    "context"
    "fmt"

    "github.com/riverqueue/river"
)

// WelcomeEmailArgs are the job arguments stored in PostgreSQL
type WelcomeEmailArgs struct {
    UserID   int64  `json:"user_id"`
    Email    string `json:"email"`
    Name     string `json:"name"`
    PlanType string `json:"plan_type"`
}

// Kind returns the unique name for this job type
func (WelcomeEmailArgs) Kind() string { return "email.welcome" }

// InsertOpts provides default options for this job type
func (WelcomeEmailArgs) InsertOpts() river.InsertOpts {
    return river.InsertOpts{
        MaxAttempts: 3,
        Queue:       "email",
        Priority:    2,
    }
}

// WelcomeEmailWorker processes welcome email jobs
type WelcomeEmailWorker struct {
    river.WorkerDefaults[WelcomeEmailArgs]
    emailSvc EmailService
}

func (w *WelcomeEmailWorker) Work(ctx context.Context, job *river.Job[WelcomeEmailArgs]) error {
    args := job.Args

    if err := w.emailSvc.SendWelcome(ctx, args.Email, args.Name, args.PlanType); err != nil {
        // River automatically retries on error
        return fmt.Errorf("send welcome email to %s: %w", args.Email, err)
    }

    return nil
}

// Timeout overrides the default job timeout
func (w *WelcomeEmailWorker) Timeout(_ *river.Job[WelcomeEmailArgs]) time.Duration {
    return 30 * time.Second
}

// NextRetry computes the retry delay with exponential backoff
func (w *WelcomeEmailWorker) NextRetry(job *river.Job[WelcomeEmailArgs]) time.Time {
    delay := time.Duration(math.Pow(2, float64(job.Attempt))) * time.Second
    if delay > time.Hour {
        delay = time.Hour
    }
    return time.Now().Add(delay)
}
```

### The Killer Feature: Transactional Job Insertion

```go
// service/user_service.go
package service

import (
    "context"

    "github.com/jackc/pgx/v5"
    "github.com/riverqueue/river"
    "yourapp/jobs"
)

type UserService struct {
    db          *pgx.Conn
    riverClient *river.Client[pgx.Tx]
}

// CreateUser creates a user AND enqueues the welcome email in ONE transaction.
// If the email enqueue fails, the user creation rolls back.
// If the user creation fails after the email is enqueued (but before commit),
// both roll back. The email is ONLY sent if the user is actually created.
func (s *UserService) CreateUser(ctx context.Context, email, name, plan string) (*User, error) {
    tx, err := s.db.Begin(ctx)
    if err != nil {
        return nil, fmt.Errorf("begin transaction: %w", err)
    }
    defer tx.Rollback(ctx)

    // Insert the user
    var userID int64
    err = tx.QueryRow(ctx,
        "INSERT INTO users (email, name, plan_type) VALUES ($1, $2, $3) RETURNING id",
        email, name, plan).Scan(&userID)
    if err != nil {
        return nil, fmt.Errorf("insert user: %w", err)
    }

    // Enqueue welcome email WITHIN THE SAME TRANSACTION
    // This guarantees exactly-once delivery — the email job exists if and only if
    // the user row exists.
    _, err = s.riverClient.InsertTx(ctx, tx, jobs.WelcomeEmailArgs{
        UserID:   userID,
        Email:    email,
        Name:     name,
        PlanType: plan,
    }, nil)
    if err != nil {
        return nil, fmt.Errorf("enqueue welcome email: %w", err)
    }

    if err := tx.Commit(ctx); err != nil {
        return nil, fmt.Errorf("commit: %w", err)
    }

    return &User{ID: userID, Email: email, Name: name}, nil
}
```

### River Server Setup

```go
// cmd/river-worker/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
    "yourapp/jobs"
)

func main() {
    ctx := context.Background()
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    // PostgreSQL connection pool
    pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer pool.Close()

    // Build service dependencies
    emailSvc := jobs.NewEmailService(/* ... */)

    // Create River workers
    workers := river.NewWorkers()
    river.AddWorker(workers, &jobs.WelcomeEmailWorker{emailSvc: emailSvc})
    river.AddWorker(workers, &jobs.ImageResizeWorker{/* ... */})
    river.AddWorker(workers, &jobs.ReportGenerateWorker{/* ... */})

    // Create River client
    riverClient, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
        Workers: workers,

        Queues: map[string]river.QueueConfig{
            river.QueueDefault: {MaxWorkers: 10},
            "email":            {MaxWorkers: 5},
            "media":            {MaxWorkers: 3},
            "reports":          {MaxWorkers: 2},
        },

        Logger: logger,

        // Error handler
        ErrorHandler: &river.UnhandledJobErrorHandler{},

        // Periodic jobs (cron-like)
        PeriodicJobs: []*river.PeriodicJob{
            river.NewPeriodicJob(
                river.PeriodicInterval(1*time.Hour),
                func() (river.JobArgs, *river.InsertOpts) {
                    return jobs.HourlyReportRefreshArgs{}, nil
                },
                &river.PeriodicJobOpts{RunOnStart: false},
            ),
        },
    })
    if err != nil {
        logger.Error("failed to create river client", "error", err)
        os.Exit(1)
    }

    // Graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, os.Interrupt)

    go func() {
        <-sigCh
        softStopCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
        defer cancel()
        riverClient.Stop(softStopCtx)
    }()

    logger.Info("starting river worker")
    if err := riverClient.Start(ctx); err != nil {
        logger.Error("worker stopped with error", "error", err)
    }
}
```

### River Dead Letter Queue Management

```go
// River provides the JobListParams API to query job state
package admin

import (
    "context"
    "fmt"
    "time"

    "github.com/riverqueue/river"
    "github.com/riverqueue/river/rivertype"
)

type JobAdmin struct {
    client *river.Client[pgx.Tx]
}

// ListDeadJobs returns jobs that have failed all retries
func (a *JobAdmin) ListDeadJobs(ctx context.Context, limit int) ([]*rivertype.JobRow, error) {
    jobs, err := a.client.JobList(ctx, river.NewJobListParams().
        State(rivertype.JobStateDiscarded).
        OrderBy(river.JobListOrderByTime, river.SortOrderDesc).
        First(limit))
    return jobs, err
}

// RetryDeadJob re-queues a specific dead job
func (a *JobAdmin) RetryDeadJob(ctx context.Context, jobID int64) error {
    _, err := a.client.JobRetry(ctx, jobID)
    if err != nil {
        return fmt.Errorf("retry job %d: %w", jobID, err)
    }
    return nil
}

// RetryAllDeadJobs re-queues all dead jobs of a specific kind
func (a *JobAdmin) RetryAllDeadJobs(ctx context.Context, kind string) (int, error) {
    jobs, err := a.client.JobList(ctx, river.NewJobListParams().
        State(rivertype.JobStateDiscarded).
        Kinds(kind))
    if err != nil {
        return 0, err
    }

    var retried int
    for _, job := range jobs {
        if _, err := a.client.JobRetry(ctx, job.ID); err != nil {
            return retried, fmt.Errorf("retry job %d: %w", job.ID, err)
        }
        retried++
    }
    return retried, nil
}
```

## Section 4: Machinery — Workflow Orchestration

### Installation

```bash
go get github.com/RichardKnop/machinery/v2
```

### Task Definitions

```go
// tasks/machinery_tasks.go
package tasks

import (
    "context"
    "fmt"
)

// Machinery tasks are plain functions
func ProcessImageStep1(imageID string, sourceURL string) (string, error) {
    // Download and validate image
    // Returns the local temp path
    return fmt.Sprintf("/tmp/images/%s.raw", imageID), nil
}

func ProcessImageStep2(imageID string, localPath string) (string, error) {
    // Resize and optimize
    return fmt.Sprintf("/tmp/images/%s.optimized.jpg", imageID), nil
}

func ProcessImageStep3(imageID string, optimizedPath string) (string, error) {
    // Upload to storage
    return fmt.Sprintf("https://cdn.example.com/images/%s.jpg", imageID), nil
}

func NotifyImageComplete(imageID string, cdnURL string) error {
    // Send webhook or notification
    fmt.Printf("Image %s ready at %s\n", imageID, cdnURL)
    return nil
}
```

### Workflow Chains

```go
// workflows/image_pipeline.go
package workflows

import (
    "github.com/RichardKnop/machinery/v2"
    "github.com/RichardKnop/machinery/v2/tasks"
)

// CreateImageProcessingPipeline creates a chain: step1 -> step2 -> step3 -> notify
func CreateImageProcessingPipeline(server *machinery.Server, imageID, sourceURL string) error {
    // Each task in the chain receives the output of the previous task
    chain, err := tasks.NewChain(
        &tasks.Signature{
            Name: "ProcessImageStep1",
            Args: []tasks.Arg{
                {Type: "string", Value: imageID},
                {Type: "string", Value: sourceURL},
            },
        },
        &tasks.Signature{
            Name: "ProcessImageStep2",
            Args: []tasks.Arg{
                {Type: "string", Value: imageID},
                // localPath is injected from step1's output
            },
        },
        &tasks.Signature{
            Name: "ProcessImageStep3",
            Args: []tasks.Arg{
                {Type: "string", Value: imageID},
                // optimizedPath is injected from step2's output
            },
        },
        &tasks.Signature{
            Name: "NotifyImageComplete",
            Args: []tasks.Arg{
                {Type: "string", Value: imageID},
                // cdnURL is injected from step3's output
            },
        },
    )
    if err != nil {
        return err
    }

    _, err = server.SendChain(chain)
    return err
}

// CreateParallelProcessingGroup processes multiple images in parallel then notifies
func CreateParallelProcessingGroup(server *machinery.Server, imageIDs []string) error {
    // Create parallel signatures
    var signatures []*tasks.Signature
    for _, id := range imageIDs {
        signatures = append(signatures, &tasks.Signature{
            Name: "ProcessImageStep1",
            Args: []tasks.Arg{
                {Type: "string", Value: id},
                {Type: "string", Value: "https://uploads.example.com/" + id},
            },
        })
    }

    group, err := tasks.NewGroup(signatures...)
    if err != nil {
        return err
    }

    // Chord: run group in parallel, then callback when ALL complete
    chord, err := tasks.NewChord(group, &tasks.Signature{
        Name: "BatchProcessingComplete",
        Args: []tasks.Arg{
            {Type: "string", Value: fmt.Sprintf("batch-%d", time.Now().Unix())},
        },
    })
    if err != nil {
        return err
    }

    _, err = server.SendChord(chord, 0)
    return err
}
```

### Machinery Server Setup

```go
// cmd/machinery-worker/main.go
package main

import (
    "log"

    "github.com/RichardKnop/machinery/v2"
    "github.com/RichardKnop/machinery/v2/config"
    "github.com/RichardKnop/machinery/v2/tasks" // not used directly, for types
    "yourapp/tasks"
)

func main() {
    cfg := &config.Config{
        Broker:          "redis://localhost:6379",
        DefaultQueue:    "machinery_tasks",
        ResultBackend:   "redis://localhost:6379",
        ResultsExpireIn: 3600,  // Results expire after 1 hour

        Redis: &config.RedisConfig{
            MaxIdle:                3,
            IdleTimeout:            240,
            ReadTimeout:            15,
            WriteTimeout:           15,
            ConnectTimeout:         15,
            NormalTasksPollPeriod:  1000,
            DelayedTasksPollPeriod: 500,
        },
    }

    server, err := machinery.NewServer(cfg)
    if err != nil {
        log.Fatal(err)
    }

    // Register task functions
    err = server.RegisterTasks(map[string]interface{}{
        "ProcessImageStep1":      tasks.ProcessImageStep1,
        "ProcessImageStep2":      tasks.ProcessImageStep2,
        "ProcessImageStep3":      tasks.ProcessImageStep3,
        "NotifyImageComplete":    tasks.NotifyImageComplete,
        "BatchProcessingComplete": tasks.BatchProcessingComplete,
    })
    if err != nil {
        log.Fatal(err)
    }

    // Create and start the worker
    worker := server.NewWorker("worker-1", 10)  // 10 concurrent tasks
    if err := worker.Launch(); err != nil {
        log.Fatal(err)
    }
}
```

## Section 5: Dead Letter Queue Patterns

### Asynq Dead Letter Queue

```go
// admin/dead_letters.go — manage failed tasks in Asynq
package admin

import (
    "context"
    "fmt"
    "time"

    "github.com/hibiken/asynq"
)

type AsynqAdmin struct {
    inspector *asynq.Inspector
}

func NewAsynqAdmin(redisAddr string) *AsynqAdmin {
    return &AsynqAdmin{
        inspector: asynq.NewInspector(asynq.RedisClientOpt{Addr: redisAddr}),
    }
}

// ListArchivedTasks returns all tasks in the dead letter queue
func (a *AsynqAdmin) ListArchivedTasks(queue string) ([]*asynq.TaskInfo, error) {
    return a.inspector.ListArchivedTasks(queue)
}

// RetryArchivedTask moves a task from archived back to pending
func (a *AsynqAdmin) RetryArchivedTask(queue, taskID string) error {
    return a.inspector.RunArchivedTask(queue, taskID)
}

// RetryAllArchived retries all archived tasks in all queues
func (a *AsynqAdmin) RetryAllArchived(ctx context.Context) (int, error) {
    queues, err := a.inspector.Queues()
    if err != nil {
        return 0, err
    }

    var total int
    for _, q := range queues {
        archived, err := a.inspector.ListArchivedTasks(q.Queue)
        if err != nil {
            continue
        }
        for _, task := range archived {
            if err := a.inspector.RunArchivedTask(q.Queue, task.ID); err == nil {
                total++
            }
        }
    }
    return total, nil
}

// CleanArchivedOlderThan deletes archived tasks older than the given duration
func (a *AsynqAdmin) CleanArchivedOlderThan(olderThan time.Duration) (int, error) {
    queues, err := a.inspector.Queues()
    if err != nil {
        return 0, err
    }

    var deleted int
    for _, q := range queues {
        n, err := a.inspector.DeleteAllArchivedTasks(q.Queue)
        if err == nil {
            deleted += n
        }
    }
    return deleted, nil
}

// QueueStats returns current state of all queues
func (a *AsynqAdmin) QueueStats() {
    queues, _ := a.inspector.Queues()
    for _, q := range queues {
        fmt.Printf("Queue: %-20s Active: %4d  Pending: %6d  Scheduled: %4d  Archived: %4d\n",
            q.Queue, q.Active, q.Pending, q.Scheduled, q.Archived)
    }
}
```

## Section 6: Job Deduplication Patterns

```go
// dedup/dedup.go — deduplication strategies
package dedup

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "time"

    "github.com/hibiken/asynq"
    "github.com/redis/go-redis/v9"
)

// ContentBasedDedup generates a stable task ID from the payload content
// Ensures that identical jobs are not enqueued multiple times
func ContentBasedDedup[T any](payload T) (string, error) {
    data, err := json.Marshal(payload)
    if err != nil {
        return "", err
    }
    h := sha256.Sum256(data)
    return hex.EncodeToString(h[:16]), nil
}

// AsynqEnqueueOnce enqueues a task only if it's not already queued
func AsynqEnqueueOnce(ctx context.Context, client *asynq.Client,
    taskType string, payload interface{}, dedupWindow time.Duration,
    opts ...asynq.Option) error {

    taskID, err := ContentBasedDedup(payload)
    if err != nil {
        return err
    }

    data, err := json.Marshal(payload)
    if err != nil {
        return err
    }

    opts = append(opts,
        asynq.TaskID(taskID),
        asynq.Unique(dedupWindow),
    )

    task := asynq.NewTask(taskType, data, opts...)
    _, err = client.EnqueueContext(ctx, task)
    if err == asynq.ErrTaskIDConflict {
        // Already enqueued — this is fine
        return nil
    }
    return err
}

// RedisDedup provides a Redis-based deduplication window for any queue system
type RedisDedup struct {
    rdb redis.Cmdable
}

func NewRedisDedup(rdb redis.Cmdable) *RedisDedup {
    return &RedisDedup{rdb: rdb}
}

// ShouldProcess returns true if this job should be processed.
// Returns false if the same job was processed within the window.
func (d *RedisDedup) ShouldProcess(ctx context.Context, jobType string, jobKey string, window time.Duration) (bool, error) {
    dedupKey := fmt.Sprintf("dedup:%s:%s", jobType, jobKey)

    // SET NX with expiry — only succeeds if key doesn't exist
    set, err := d.rdb.SetNX(ctx, dedupKey, 1, window).Result()
    return set, err
}

// Mark records that a job was processed
func (d *RedisDedup) Mark(ctx context.Context, jobType, jobKey string, window time.Duration) error {
    dedupKey := fmt.Sprintf("dedup:%s:%s", jobType, jobKey)
    return d.rdb.Set(ctx, dedupKey, 1, window).Err()
}
```

## Section 7: Observability

### Asynq Prometheus Metrics

```go
// metrics/asynq_metrics.go
package metrics

import (
    "context"
    "time"

    "github.com/hibiken/asynq"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

type AsynqMetricsCollector struct {
    inspector *asynq.Inspector
    queues    []string

    queueSize     *prometheus.GaugeVec
    activeWorkers *prometheus.GaugeVec
    processedTotal *prometheus.CounterVec
    failedTotal    *prometheus.CounterVec
    processingTime *prometheus.HistogramVec
}

func NewAsynqMetricsCollector(inspector *asynq.Inspector, queues []string) *AsynqMetricsCollector {
    c := &AsynqMetricsCollector{
        inspector: inspector,
        queues:    queues,

        queueSize: promauto.NewGaugeVec(prometheus.GaugeOpts{
            Name: "asynq_queue_size",
            Help: "Current number of tasks in queue by state",
        }, []string{"queue", "state"}),

        activeWorkers: promauto.NewGaugeVec(prometheus.GaugeOpts{
            Name: "asynq_active_workers",
            Help: "Number of active workers",
        }, []string{"queue"}),
    }

    // Start background collection
    go c.collect(context.Background())
    return c
}

func (c *AsynqMetricsCollector) collect(ctx context.Context) {
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            c.update()
        }
    }
}

func (c *AsynqMetricsCollector) update() {
    queues, err := c.inspector.Queues()
    if err != nil {
        return
    }

    for _, q := range queues {
        c.queueSize.WithLabelValues(q.Queue, "active").Set(float64(q.Active))
        c.queueSize.WithLabelValues(q.Queue, "pending").Set(float64(q.Pending))
        c.queueSize.WithLabelValues(q.Queue, "scheduled").Set(float64(q.Scheduled))
        c.queueSize.WithLabelValues(q.Queue, "retry").Set(float64(q.Retry))
        c.queueSize.WithLabelValues(q.Queue, "archived").Set(float64(q.Archived))
    }
}
```

## Section 8: Choosing the Right Queue

```
Decision Tree:

Need exactly-once semantics with DB consistency?
  YES → River (PostgreSQL)
  NO  → Continue

Need workflow orchestration (chains/groups/chords)?
  YES → Machinery
  NO  → Continue

Using Redis already? High throughput priority?
  YES → Asynq
  NO  → Consider River (simpler operational model)
```

### Production Checklist

```
Regardless of library:
□ All task handlers are idempotent (safe to run multiple times)
□ Retry policy uses exponential backoff
□ Dead letter queue is monitored with alerts
□ Job payload is versioned or backward-compatible
□ Large payloads are stored externally (S3/DB), not in the queue
□ Queue depth and processing lag are monitored
□ Worker graceful shutdown is tested
□ Database/Redis connection pool is sized for worker concurrency
□ Job types have appropriate timeouts set
□ Failed job runbook is documented
```

## Summary

The choice between Asynq, River, and Machinery comes down to your consistency requirements and existing infrastructure:

- **Asynq** is the simplest path to high-throughput background processing if you have Redis. Its Asynqmon UI provides immediate operational visibility, and its unique job ID feature covers most deduplication needs.
- **River** is the right choice when job execution must be consistent with your database state — the transactional insert pattern eliminates entire classes of distributed consistency bugs. If you already run PostgreSQL, there is no additional operational complexity.
- **Machinery** shines for workflow orchestration where fan-out/fan-in patterns or multi-step pipelines are the primary use case.

For most CRUD-heavy web services, Asynq (Redis) covers 90% of use cases. For fintech, e-commerce, and any domain where job atomicity matters, River (PostgreSQL) is worth the slightly more complex setup.
