---
title: "Go Task Queue Implementation: Asynq, River, and Production Job Processing"
date: 2029-12-19T00:00:00-05:00
draft: false
tags: ["Go", "Asynq", "River", "Task Queue", "Background Jobs", "Redis", "PostgreSQL", "Worker", "Concurrency"]
categories:
- Go
- Backend
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Asynq with Redis and River with PostgreSQL for production background job processing in Go: job priorities, retry policies, unique jobs, periodic tasks, cron scheduling, and observability."
more_link: "yes"
url: "/go-task-queue-asynq-river-production-job-processing/"
---

Background job processing is a requirement in almost every production Go service: sending emails, processing uploads, generating reports, syncing data to external systems. Two libraries dominate the Go ecosystem for this problem — Asynq (Redis-backed, battle-tested, mature UI) and River (PostgreSQL-backed, ACID guarantees, tight database integration). Choosing between them depends on your infrastructure and reliability requirements. This guide covers both in depth, with production patterns for priorities, retries, unique constraints, periodic tasks, and observability.

<!--more-->

## Asynq: Redis-Backed Task Queue

Asynq stores jobs as Redis sorted sets, where each queue is a ZSET keyed by score (scheduled execution time). It supports multiple queues with distinct worker concurrency and priority, making it ideal for workloads with mixed latency requirements.

### Installation and Basic Setup

```bash
go get github.com/hibiken/asynq
```

### Defining Task Types

```go
// internal/tasks/types.go
package tasks

import (
	"encoding/json"
	"fmt"

	"github.com/hibiken/asynq"
)

const (
	TypeEmailWelcome    = "email:welcome"
	TypeEmailInvoice    = "email:invoice"
	TypeImageResize     = "image:resize"
	TypeReportGenerate  = "report:generate"
	TypeWebhookDeliver  = "webhook:deliver"
)

// --- Email welcome task ---

type EmailWelcomePayload struct {
	UserID   int64  `json:"user_id"`
	Email    string `json:"email"`
	Username string `json:"username"`
}

func NewEmailWelcomeTask(userID int64, email, username string) (*asynq.Task, error) {
	payload, err := json.Marshal(EmailWelcomePayload{
		UserID:   userID,
		Email:    email,
		Username: username,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal email welcome payload: %w", err)
	}
	return asynq.NewTask(TypeEmailWelcome, payload,
		asynq.MaxRetry(3),
		asynq.Timeout(30*time.Second),
		asynq.Queue("email"),
	), nil
}

// --- Image resize task ---

type ImageResizePayload struct {
	ObjectKey string `json:"object_key"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Format    string `json:"format"`
}

func NewImageResizeTask(objectKey string, width, height int, format string) (*asynq.Task, error) {
	payload, err := json.Marshal(ImageResizePayload{
		ObjectKey: objectKey,
		Width:     width,
		Height:    height,
		Format:    format,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal image resize payload: %w", err)
	}
	return asynq.NewTask(TypeImageResize, payload,
		asynq.MaxRetry(2),
		asynq.Timeout(5*time.Minute),
		asynq.Queue("media"),
		// Unique constraint: prevent duplicate resize jobs for same object+dimensions
		asynq.Unique(time.Hour),
	), nil
}

// --- Webhook delivery task ---

type WebhookPayload struct {
	EndpointURL string            `json:"endpoint_url"`
	EventType   string            `json:"event_type"`
	Payload     json.RawMessage   `json:"payload"`
	Headers     map[string]string `json:"headers"`
	AttemptNum  int               `json:"attempt_num"`
}

func NewWebhookDeliverTask(endpointURL, eventType string, payload json.RawMessage, headers map[string]string) (*asynq.Task, error) {
	p, err := json.Marshal(WebhookPayload{
		EndpointURL: endpointURL,
		EventType:   eventType,
		Payload:     payload,
		Headers:     headers,
	})
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TypeWebhookDeliver, p,
		asynq.MaxRetry(10),
		asynq.Timeout(15*time.Second),
		asynq.Queue("webhooks"),
		// Exponential backoff: 2^n seconds between retries
		asynq.Retention(24*time.Hour),
	), nil
}
```

### Worker Server Configuration

```go
// internal/worker/server.go
package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"
)

func NewAsynqServer(redisAddr string) *asynq.Server {
	return asynq.NewServer(
		asynq.RedisClientOpt{Addr: redisAddr},
		asynq.Config{
			// Concurrency per queue
			Queues: map[string]int{
				"critical": 20,  // highest priority
				"email":    10,
				"media":    5,
				"webhooks": 15,
				"default":  5,
			},
			// Strict priority: drain higher-priority queues first
			StrictPriority: true,
			// Retry logic with exponential backoff
			RetryDelayFunc: func(n int, err error, task *asynq.Task) time.Duration {
				// Base: 2^n seconds, capped at 1 hour
				delay := time.Duration(1<<uint(n)) * time.Second
				if delay > time.Hour {
					delay = time.Hour
				}
				return delay
			},
			// Log task errors
			ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
				slog.Error("task failed",
					"type", task.Type(),
					"err", err,
				)
			}),
			// Concurrency for the health-check goroutine
			HealthCheckFunc: func(err error) {
				if err != nil {
					slog.Error("asynq health check failed", "err", err)
				}
			},
			// Graceful shutdown timeout
			ShutdownTimeout: 30 * time.Second,
		},
	)
}

func RegisterHandlers(mux *asynq.ServeMux) {
	mux.HandleFunc(tasks.TypeEmailWelcome, HandleEmailWelcome)
	mux.HandleFunc(tasks.TypeEmailInvoice, HandleEmailInvoice)
	mux.HandleFunc(tasks.TypeImageResize, HandleImageResize)
	mux.HandleFunc(tasks.TypeReportGenerate, HandleReportGenerate)
	mux.HandleFunc(tasks.TypeWebhookDeliver, HandleWebhookDeliver)
}
```

### Task Handlers

```go
// internal/worker/handlers.go
package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/my-org/myapp/internal/tasks"
)

func HandleEmailWelcome(ctx context.Context, t *asynq.Task) error {
	var p tasks.EmailWelcomePayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		// Non-retryable error — wrap with asynq.SkipRetry
		return fmt.Errorf("%w: unmarshal payload: %v", asynq.SkipRetry, err)
	}

	slog.Info("sending welcome email", "user_id", p.UserID, "email", p.Email)

	// Call your email service
	if err := sendEmail(ctx, p.Email, "Welcome to the platform!", renderWelcomeTemplate(p)); err != nil {
		// Retryable — return plain error
		return fmt.Errorf("send welcome email to %s: %w", p.Email, err)
	}

	return nil
}

func HandleWebhookDeliver(ctx context.Context, t *asynq.Task) error {
	var p tasks.WebhookPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		return fmt.Errorf("%w: %v", asynq.SkipRetry, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.EndpointURL,
		strings.NewReader(string(p.Payload)))
	if err != nil {
		return fmt.Errorf("%w: build request: %v", asynq.SkipRetry, err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Event-Type", p.EventType)
	for k, v := range p.Headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("deliver webhook to %s: %w", p.EndpointURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 500 {
		// 5xx is retryable
		return fmt.Errorf("webhook endpoint returned %d", resp.StatusCode)
	}
	if resp.StatusCode >= 400 {
		// 4xx is not retryable (bad endpoint config)
		return fmt.Errorf("%w: endpoint returned %d (client error, not retrying)",
			asynq.SkipRetry, resp.StatusCode)
	}

	return nil
}
```

### Periodic Tasks (Cron)

```go
// internal/worker/scheduler.go
package worker

import (
	"log/slog"

	"github.com/hibiken/asynq"
)

func NewScheduler(redisAddr string) *asynq.Scheduler {
	scheduler := asynq.NewScheduler(
		asynq.RedisClientOpt{Addr: redisAddr},
		&asynq.SchedulerOpts{
			LogLevel: asynq.InfoLevel,
			PostEnqueueFunc: func(info *asynq.TaskInfo, err error) {
				if err != nil {
					slog.Error("scheduled task enqueue failed",
						"task", info.Type,
						"err", err,
					)
				}
			},
		},
	)

	// Daily digest email at 8:00 AM UTC
	scheduler.Register("0 8 * * *",
		asynq.NewTask("email:daily_digest", nil,
			asynq.Queue("email"),
			asynq.MaxRetry(1),
		),
	)

	// Hourly cleanup of expired sessions
	scheduler.Register("@hourly",
		asynq.NewTask("cleanup:expired_sessions", nil,
			asynq.Queue("default"),
		),
	)

	// Every 5 minutes: sync subscription statuses from Stripe
	scheduler.Register("*/5 * * * *",
		asynq.NewTask("billing:sync_subscriptions", nil,
			asynq.Queue("critical"),
			asynq.Timeout(4 * time.Minute),
		),
	)

	return scheduler
}
```

### Enqueuing Tasks from Application Code

```go
// pkg/jobclient/client.go
package jobclient

import (
	"context"
	"fmt"

	"github.com/hibiken/asynq"
	"github.com/my-org/myapp/internal/tasks"
)

type Client struct {
	asynq *asynq.Client
}

func New(redisAddr string) *Client {
	return &Client{
		asynq: asynq.NewClient(asynq.RedisClientOpt{Addr: redisAddr}),
	}
}

func (c *Client) EnqueueWelcomeEmail(ctx context.Context, userID int64, email, username string) error {
	task, err := tasks.NewEmailWelcomeTask(userID, email, username)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}

	info, err := c.asynq.EnqueueContext(ctx, task)
	if err != nil {
		return fmt.Errorf("enqueue welcome email: %w", err)
	}

	slog.Info("enqueued welcome email task",
		"task_id", info.ID,
		"queue", info.Queue,
		"user_id", userID,
	)
	return nil
}

func (c *Client) ScheduleImageResize(ctx context.Context, objectKey string, width, height int, delay time.Duration) error {
	task, err := tasks.NewImageResizeTask(objectKey, width, height, "webp")
	if err != nil {
		return err
	}

	_, err = c.asynq.EnqueueContext(ctx, task,
		asynq.ProcessIn(delay),
	)
	return err
}
```

## River: PostgreSQL-Backed Job Queue

River embeds the job queue inside your PostgreSQL database, using LISTEN/NOTIFY for near-instant job pickup and advisory locks for concurrency control. Because jobs live in the same database as your application data, you can enqueue jobs inside the same transaction that creates related records — eliminating the dual-write problem.

### Installation

```bash
go get github.com/riverqueue/river
go get github.com/riverqueue/river/riverdriver/riverpgxv5

# Install River CLI for migrations
go install github.com/riverqueue/river/cmd/river@latest

# Run migrations
river migrate-up --database-url "postgres://user:password@localhost:5432/myapp?sslmode=disable"
```

### Defining River Jobs

```go
// internal/jobs/email.go
package jobs

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/riverqueue/river"
)

// Job args must implement river.JobArgs
type WelcomeEmailArgs struct {
	UserID   int64  `json:"user_id"`
	Email    string `json:"email"`
	Username string `json:"username"`
}

func (WelcomeEmailArgs) Kind() string { return "welcome_email" }

// Optional: configure default job behaviour
func (WelcomeEmailArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{
		MaxAttempts: 5,
		Queue:       "email",
		Priority:    2, // 1=highest, 4=lowest
	}
}

// Worker implements river.Worker[T]
type WelcomeEmailWorker struct {
	river.WorkerDefaults[WelcomeEmailArgs]
	emailSvc EmailService
}

func (w *WelcomeEmailWorker) Work(ctx context.Context, job *river.Job[WelcomeEmailArgs]) error {
	slog.Info("processing welcome email", "user_id", job.Args.UserID)

	if err := w.emailSvc.Send(ctx, job.Args.Email, "Welcome!", renderWelcome(job.Args)); err != nil {
		return fmt.Errorf("send welcome email: %w", err)
	}
	return nil
}

// Override retry schedule
func (w *WelcomeEmailWorker) NextRetry(job *river.Job[WelcomeEmailArgs]) time.Time {
	return time.Now().Add(time.Duration(1<<uint(job.Attempt)) * time.Minute)
}
```

### River Client and Worker Setup

```go
// internal/jobs/river.go
package jobs

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
)

func NewRiverClient(pool *pgxpool.Pool) (*river.Client[pgx.Tx], error) {
	workers := river.NewWorkers()
	river.AddWorker(workers, &WelcomeEmailWorker{emailSvc: realEmailSvc})
	river.AddWorker(workers, &InvoiceEmailWorker{})
	river.AddWorker(workers, &ReportGenerateWorker{})

	riverClient, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Queues: map[string]river.QueueConfig{
			river.QueueDefault: {MaxWorkers: 10},
			"email":            {MaxWorkers: 20},
			"reports":          {MaxWorkers: 3},
		},
		Workers: workers,
		ErrorHandler: &riverErrorHandler{},
		Logger: slog.Default(),
	})
	if err != nil {
		return nil, err
	}
	return riverClient, nil
}

type riverErrorHandler struct{}

func (h *riverErrorHandler) HandleError(ctx context.Context, job *river.JobRow, err error) *river.ErrorHandlerResult {
	slog.Error("river job error",
		"job_id", job.ID,
		"kind", job.Kind,
		"attempt", job.Attempt,
		"err", err,
	)
	return nil // nil = use default retry behaviour
}

func (h *riverErrorHandler) HandlePanic(ctx context.Context, job *river.JobRow, panicVal any, trace string) *river.ErrorHandlerResult {
	slog.Error("river job panicked",
		"job_id", job.ID,
		"kind", job.Kind,
		"panic", panicVal,
	)
	return &river.ErrorHandlerResult{SetCancelled: true} // don't retry panics
}
```

### Transactional Enqueueing (The Key River Advantage)

```go
// api/handlers/user.go
package handlers

import (
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
)

func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Enqueue welcome email in the same transaction as user creation
	// If either fails, both roll back atomically
	err := pgx.BeginTxFunc(r.Context(), h.pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
		// Insert user
		var userID int64
		err := tx.QueryRow(r.Context(),
			`INSERT INTO users (email, username, created_at) VALUES ($1, $2, now()) RETURNING id`,
			req.Email, req.Username,
		).Scan(&userID)
		if err != nil {
			return err
		}

		// Enqueue welcome email inside the same transaction
		_, err = h.riverClient.InsertTx(r.Context(), tx,
			jobs.WelcomeEmailArgs{
				UserID:   userID,
				Email:    req.Email,
				Username: req.Username,
			},
			&river.InsertOpts{
				Queue:    "email",
				Priority: 1,
			},
		)
		return err
	})
	if err != nil {
		http.Error(w, "failed to create user", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}
```

### River Periodic Jobs

```go
// internal/jobs/periodic.go
package jobs

import (
	"time"

	"github.com/riverqueue/river"
)

func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(
			river.PeriodicInterval(time.Hour),
			func() (river.JobArgs, *river.InsertOpts) {
				return CleanupExpiredSessionsArgs{}, &river.InsertOpts{
					Queue: river.QueueDefault,
				}
			},
			&river.PeriodicJobOpts{RunOnStart: false},
		),
		river.NewPeriodicJob(
			// Custom schedule: every day at 06:00 UTC
			&periodicScheduleDaily{hour: 6},
			func() (river.JobArgs, *river.InsertOpts) {
				return DailyDigestArgs{}, &river.InsertOpts{
					Queue:    "email",
					Priority: 3,
				}
			},
			&river.PeriodicJobOpts{RunOnStart: false},
		),
	}
}

// periodicScheduleDaily implements river.PeriodicSchedule
type periodicScheduleDaily struct{ hour int }

func (s *periodicScheduleDaily) Next(t time.Time) time.Time {
	next := time.Date(t.Year(), t.Month(), t.Day(), s.hour, 0, 0, 0, time.UTC)
	if !next.After(t) {
		next = next.Add(24 * time.Hour)
	}
	return next
}
```

## Asynq vs. River: Decision Matrix

| Concern | Asynq (Redis) | River (PostgreSQL) |
|---|---|---|
| Infrastructure requirement | Redis | PostgreSQL |
| Transactional enqueue | No (dual-write risk) | Yes (same TX) |
| Throughput | Very high (millions/min) | High (hundreds of thousands/min) |
| Job storage duration | Limited by Redis memory | Unlimited (PostgreSQL) |
| Complex queries on jobs | Limited | Full SQL |
| Unique job deduplication | Built-in (Redis TTL) | Via unique keys + SQL |
| Built-in Web UI | Yes (asynqmon) | Third-party/custom |
| Dead letter queue | Yes | Yes |

## Observability: Prometheus Metrics

### Asynq Metrics Exporter

```go
// internal/metrics/asynq.go
package metrics

import (
	"context"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"
	"github.com/prometheus/client_golang/prometheus"
)

type AsynqExporter struct {
	inspector *asynq.Inspector
	queued    *prometheus.GaugeVec
	active    *prometheus.GaugeVec
	failed    *prometheus.GaugeVec
}

func NewAsynqExporter(redisAddr string) *AsynqExporter {
	e := &AsynqExporter{
		inspector: asynq.NewInspector(asynq.RedisClientOpt{Addr: redisAddr}),
		queued: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: "asynq",
			Name:      "queue_size",
			Help:      "Number of tasks in each queue.",
		}, []string{"queue", "state"}),
		active: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: "asynq",
			Name:      "active_tasks",
			Help:      "Number of actively processing tasks.",
		}, []string{"queue"}),
		failed: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: "asynq",
			Name:      "failed_tasks_total",
			Help:      "Total number of failed tasks.",
		}, []string{"queue"}),
	}
	prometheus.MustRegister(e.queued, e.active, e.failed)
	return e
}

func (e *AsynqExporter) Collect(ctx context.Context) {
	queues, err := e.inspector.Queues()
	if err != nil {
		slog.Error("asynq metrics: list queues failed", "err", err)
		return
	}
	for _, q := range queues {
		info, err := e.inspector.GetQueueInfo(q)
		if err != nil {
			continue
		}
		e.queued.WithLabelValues(q, "pending").Set(float64(info.Pending))
		e.queued.WithLabelValues(q, "scheduled").Set(float64(info.Scheduled))
		e.queued.WithLabelValues(q, "retry").Set(float64(info.Retry))
		e.queued.WithLabelValues(q, "archived").Set(float64(info.Archived))
		e.active.WithLabelValues(q).Set(float64(info.Active))
		e.failed.WithLabelValues(q).Set(float64(info.Failed))
	}
}

func (e *AsynqExporter) RunLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.Collect(ctx)
		}
	}
}
```

## Summary

Asynq and River solve the same problem with different trade-offs. Asynq excels when your infrastructure already includes Redis and you need very high job throughput with simple retries and built-in UI monitoring. River wins when you need transactional enqueue guarantees, want to query job history with SQL, or prefer to avoid adding Redis to your stack. Both support job priorities, exponential backoff retries, unique job constraints, and periodic/cron scheduling. In production, instrument both with Prometheus metrics and set up alerts on queue depth and failed job rates.
