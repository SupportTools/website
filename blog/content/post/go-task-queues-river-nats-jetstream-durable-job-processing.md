---
title: "Go Task Queues with River and NATS JetStream: Durable Job Processing"
date: 2030-09-26T00:00:00-05:00
draft: false
tags: ["Go", "NATS", "JetStream", "River", "PostgreSQL", "Task Queue", "Background Jobs"]
categories:
- Go
- Messaging
- Background Processing
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise job queue patterns in Go covering River queue with PostgreSQL backend, NATS JetStream push/pull consumers, job deduplication with unique keys, priority queues, delayed jobs, and building fault-tolerant background processing pipelines."
more_link: "yes"
url: "/go-task-queues-river-nats-jetstream-durable-job-processing/"
---

Background job processing is one of those problems that looks simple and reveals complexity at scale. A job queue must handle at-least-once delivery without creating duplicate side effects, survive worker crashes mid-execution, respect priority orderings under load, and scale horizontally without creating thundering herds. Two libraries have emerged as strong choices for Go: River, built on PostgreSQL for teams already invested in relational databases, and NATS JetStream, for teams operating event-driven architectures. Both are production-grade; the right choice depends on your operational context.

<!--more-->

## River: PostgreSQL-Backed Job Queue

River uses PostgreSQL as its durable backing store, which means job state lives in the same database as your application data. This eliminates a separate infrastructure component and provides transactional consistency between application writes and job scheduling.

### Why PostgreSQL as a Job Queue

The key insight behind River is that many job queue problems map directly to database features:

- **Durability**: PostgreSQL WAL ensures jobs survive crashes
- **Transactions**: Enqueue a job atomically with the database write that triggered it
- **Advisory locks**: River uses PostgreSQL advisory locks for worker coordination without polling
- **LISTEN/NOTIFY**: Instant job pickup without polling delay
- **Partial indexes**: Efficient queries over pending jobs by queue and priority

### Installation

```bash
go get github.com/riverqueue/river
go get github.com/riverqueue/river/riverdriver/riverpgxv5
go get github.com/jackc/pgx/v5

# Install River migration CLI
go install github.com/riverqueue/river/cmd/river@latest

# Run migrations
river migrate-up --database-url "postgres://user:pass@localhost:5432/mydb"
```

### Schema Overview

River creates these tables in your database:

```sql
-- Core job table
CREATE TABLE river_job (
    id          BIGSERIAL PRIMARY KEY,
    state       river_job_state NOT NULL DEFAULT 'available',
    attempt     SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 25,
    priority    SMALLINT NOT NULL DEFAULT 1,
    queue       TEXT NOT NULL DEFAULT 'default',
    kind        TEXT NOT NULL,
    args        JSONB NOT NULL DEFAULT '{}',
    errors      JSONB[],
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finalized_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata    JSONB NOT NULL DEFAULT '{}',
    tags        TEXT[] NOT NULL DEFAULT '{}'
);

-- state: available, running, retryable, scheduled, cancelled, discarded, completed
-- priority: 1=highest, 4=lowest
```

### Defining and Running Workers

```go
// internal/jobs/email_worker.go
package jobs

import (
    "context"
    "fmt"

    "github.com/riverqueue/river"
)

// EmailJobArgs defines the job payload - must be JSON-serializable
type EmailJobArgs struct {
    To      string `json:"to"`
    Subject string `json:"subject"`
    Body    string `json:"body"`
    // Optional: Unique key for deduplication
    UniqueKey string `json:"unique_key,omitempty"`
}

// Kind returns the string identifier for this job type
func (EmailJobArgs) Kind() string { return "email" }

// InsertOpts returns default options for this job type
func (EmailJobArgs) InsertOpts() river.InsertOpts {
    return river.InsertOpts{
        MaxAttempts: 5,
        Queue:       "email",
        Priority:    2,
    }
}

// EmailWorker implements the job processor
type EmailWorker struct {
    river.WorkerDefaults[EmailJobArgs]
    mailer Mailer
    logger *zap.Logger
}

func (w *EmailWorker) Work(ctx context.Context, job *river.Job[EmailJobArgs]) error {
    w.logger.Info("sending email",
        zap.Int64("job_id", job.ID),
        zap.String("to", job.Args.To),
        zap.Int("attempt", job.Attempt),
    )

    if err := w.mailer.Send(ctx, job.Args.To, job.Args.Subject, job.Args.Body); err != nil {
        // Returning an error causes River to retry the job
        // River uses exponential backoff with jitter by default
        return fmt.Errorf("sending email to %s: %w", job.Args.To, err)
    }

    return nil
}

// Customize retry behavior
func (w *EmailWorker) NextRetry(job *river.Job[EmailJobArgs]) time.Time {
    // Custom backoff: 30s, 2m, 10m, 30m, 2h
    delays := []time.Duration{
        30 * time.Second,
        2 * time.Minute,
        10 * time.Minute,
        30 * time.Minute,
        2 * time.Hour,
    }

    if job.Attempt-1 < len(delays) {
        return time.Now().Add(delays[job.Attempt-1])
    }
    return time.Now().Add(delays[len(delays)-1])
}
```

### River Client Setup

```go
// internal/queue/river.go
package queue

import (
    "context"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/riverqueue/river"
    "github.com/riverqueue/river/riverdriver/riverpgxv5"
    "github.com/myorg/myapp/internal/jobs"
)

type RiverQueue struct {
    client *river.Client[pgx.Tx]
    pool   *pgxpool.Pool
}

func NewRiverQueue(ctx context.Context, databaseURL string) (*RiverQueue, error) {
    pool, err := pgxpool.New(ctx, databaseURL)
    if err != nil {
        return nil, fmt.Errorf("creating pool: %w", err)
    }

    workers := river.NewWorkers()
    river.AddWorker(workers, &jobs.EmailWorker{
        mailer: mailer.New(),
        logger: zap.L().Named("email-worker"),
    })
    river.AddWorker(workers, &jobs.ReportWorker{
        db:     pool,
        logger: zap.L().Named("report-worker"),
    })
    river.AddWorker(workers, &jobs.WebhookWorker{
        httpClient: &http.Client{Timeout: 30 * time.Second},
        logger:     zap.L().Named("webhook-worker"),
    })

    client, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
        Queues: map[string]river.QueueConfig{
            river.QueueDefault: {MaxWorkers: 20},
            "email":            {MaxWorkers: 10},
            "reports":          {MaxWorkers: 3},  // CPU-intensive, fewer workers
            "webhooks":         {MaxWorkers: 50}, // I/O-bound, many workers
        },
        Workers:          workers,
        Logger:           riverlog.NewLogger(zap.L()),
        // Periodic jobs
        PeriodicJobs: []*river.PeriodicJob{
            river.NewPeriodicJob(
                river.PeriodicInterval(15*time.Minute),
                func() (river.JobArgs, *river.InsertOpts) {
                    return jobs.CleanupJobArgs{}, &river.InsertOpts{Priority: 4}
                },
                &river.PeriodicJobOpts{RunOnStart: false},
            ),
        },
        // Error handler for observability
        ErrorHandler: &riverErrorHandler{logger: zap.L()},
    })
    if err != nil {
        return nil, fmt.Errorf("creating river client: %w", err)
    }

    return &RiverQueue{client: client, pool: pool}, nil
}

func (q *RiverQueue) Start(ctx context.Context) error {
    return q.client.Start(ctx)
}

func (q *RiverQueue) Stop(ctx context.Context) error {
    return q.client.Stop(ctx)
}
```

### Transactional Job Enqueueing

The most powerful River feature is transactional enqueueing — enqueue the job in the same transaction as the database write that triggered it:

```go
// handler.go - HTTP handler creating an order and queuing a confirmation email
func (h *Handler) CreateOrder(w http.ResponseWriter, r *http.Request) {
    var req CreateOrderRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "invalid request", http.StatusBadRequest)
        return
    }

    // Begin transaction
    tx, err := h.pool.Begin(r.Context())
    if err != nil {
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }
    defer tx.Rollback(r.Context())

    // Insert order into database
    var orderID int64
    err = tx.QueryRow(r.Context(),
        "INSERT INTO orders (user_id, total) VALUES ($1, $2) RETURNING id",
        req.UserID, req.Total,
    ).Scan(&orderID)
    if err != nil {
        http.Error(w, "failed to create order", http.StatusInternalServerError)
        return
    }

    // Enqueue confirmation email in the same transaction
    // If the transaction rolls back, the job is not enqueued
    // If the job enqueue fails, the order is not created
    _, err = h.riverClient.InsertTx(r.Context(), tx, jobs.EmailJobArgs{
        To:      req.UserEmail,
        Subject: fmt.Sprintf("Order #%d Confirmed", orderID),
        Body:    fmt.Sprintf("Your order of $%.2f has been confirmed.", req.Total),
    }, &river.InsertOpts{
        // Unique key prevents duplicate emails if this handler is retried
        UniqueOpts: river.UniqueOpts{
            ByArgs: true,  // Deduplicate based on job args
        },
    })
    if err != nil {
        http.Error(w, "failed to queue email", http.StatusInternalServerError)
        return
    }

    if err := tx.Commit(r.Context()); err != nil {
        http.Error(w, "failed to commit", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]int64{"order_id": orderID})
}
```

### Job Deduplication with Unique Keys

River's unique job system prevents duplicate job processing:

```go
// Deduplicate based on specific args fields and time window
_, err = riverClient.Insert(ctx, jobs.ReportJobArgs{
    ReportType: "monthly-revenue",
    Month:      "2030-09",
    UserID:     userID,
}, &river.InsertOpts{
    UniqueOpts: river.UniqueOpts{
        // Only consider the job duplicate if it has the same args
        ByArgs: true,
        // Consider duplicate only within the same queue
        ByQueue: true,
        // Only deduplicate while job is in these states
        ByState: []river.JobState{
            river.JobStateAvailable,
            river.JobStateRunning,
            river.JobStateRetryable,
            river.JobStateScheduled,
        },
        // Within a 1-hour window (jobs older than 1 hour are not considered duplicates)
        ByPeriod: time.Hour,
    },
})
```

### Delayed and Scheduled Jobs

```go
// Schedule a job to run in the future
scheduledAt := time.Now().Add(24 * time.Hour)
_, err = riverClient.Insert(ctx, jobs.ReminderJobArgs{
    UserID:  userID,
    Message: "Your subscription expires tomorrow",
}, &river.InsertOpts{
    ScheduledAt: scheduledAt,
    Queue:       "notifications",
    Priority:    3,
})

// Batch insert multiple jobs
batchArgs := make([]river.InsertManyParams, 0, len(users))
for _, user := range users {
    batchArgs = append(batchArgs, river.InsertManyParams{
        Args: jobs.WelcomeEmailArgs{UserID: user.ID, Email: user.Email},
        InsertOpts: &river.InsertOpts{
            ScheduledAt: time.Now().Add(time.Duration(user.ID%100) * time.Millisecond), // Jitter
            Queue:       "email",
        },
    })
}

_, err = riverClient.InsertMany(ctx, batchArgs)
```

### Priority Queue Configuration

River supports 1-4 priority levels (1=highest):

```go
// Critical notifications - priority 1
_, _ = riverClient.Insert(ctx, jobs.AlertJobArgs{
    Type: "security-breach",
    Data: alertData,
}, &river.InsertOpts{
    Priority: 1,
    Queue:    river.QueueDefault,
})

// Regular email - priority 2
_, _ = riverClient.Insert(ctx, jobs.EmailJobArgs{
    To: "user@example.com",
}, &river.InsertOpts{
    Priority: 2,
    Queue:    "email",
})

// Background cleanup - priority 4 (lowest)
_, _ = riverClient.Insert(ctx, jobs.CleanupJobArgs{}, &river.InsertOpts{
    Priority: 4,
})
```

## NATS JetStream for Job Processing

NATS JetStream provides durable, persistent messaging with consumer groups, making it suitable for distributed job processing, especially when jobs need to fan out to multiple consumers or when you're already operating NATS infrastructure.

### JetStream vs Core NATS

Core NATS is fire-and-forget with no persistence. JetStream adds:
- **Streams**: Persistent message storage with configurable retention
- **Consumers**: Durable subscription groups with acknowledgment tracking
- **Replay**: Ability to replay messages from any point
- **Work Queue pattern**: Exactly one consumer processes each message

### NATS JetStream Setup

```bash
# Start NATS with JetStream enabled
docker run -p 4222:4222 -p 8222:8222 nats:2.10-alpine \
  --jetstream \
  --store_dir=/data \
  -m 8222

# Or via Kubernetes (using official NATS operator or Helm)
helm repo add nats https://nats-io.github.io/k8s/helm/charts/
helm install nats nats/nats \
  --set config.jetstream.enabled=true \
  --set config.jetstream.fileStore.pvc.enabled=true \
  --set config.jetstream.fileStore.pvc.size=10Gi
```

### Stream and Consumer Creation

```go
// internal/queue/nats_setup.go
package queue

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type NATSJobQueue struct {
    nc     *nats.Conn
    js     jetstream.JetStream
    stream jetstream.Stream
}

func NewNATSJobQueue(ctx context.Context, natsURL string) (*NATSJobQueue, error) {
    nc, err := nats.Connect(natsURL,
        nats.RetryOnFailedConnect(true),
        nats.MaxReconnects(-1),
        nats.ReconnectWait(2*time.Second),
        nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
            zap.L().Error("NATS disconnected", zap.Error(err))
        }),
        nats.ReconnectHandler(func(nc *nats.Conn) {
            zap.L().Info("NATS reconnected", zap.String("url", nc.ConnectedUrl()))
        }),
    )
    if err != nil {
        return nil, fmt.Errorf("connecting to NATS: %w", err)
    }

    js, err := jetstream.New(nc)
    if err != nil {
        return nil, fmt.Errorf("creating JetStream context: %w", err)
    }

    // Create or update the job stream
    stream, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name: "JOBS",
        // Subject hierarchy: jobs.<queue>.<kind>
        Subjects: []string{"jobs.>"},
        // Retention: WorkQueuePolicy ensures each message is delivered to exactly one consumer
        Retention: jetstream.WorkQueuePolicy,
        // Storage: FileStorage for durability (MemoryStorage for speed at cost of durability)
        Storage: jetstream.FileStorage,
        // Number of NATS server replicas for stream replication (use 3 in production)
        Replicas: 3,
        // Maximum age before messages are discarded (even if unprocessed)
        MaxAge: 24 * time.Hour,
        // Maximum number of messages in the stream
        MaxMsgs: 1_000_000,
        // Maximum total size of stream
        MaxBytes: 1 << 30, // 1GB
        // Discard policy when stream is full
        Discard: jetstream.DiscardOld,
        // Duplicate detection window
        Duplicates: 5 * time.Minute,
    })
    if err != nil {
        return nil, fmt.Errorf("creating JOBS stream: %w", err)
    }

    return &NATSJobQueue{nc: nc, js: js, stream: stream}, nil
}
```

### Pull Consumer (Recommended for Job Queues)

Pull consumers explicitly fetch messages, giving workers control over throughput:

```go
// internal/queue/pull_consumer.go
package queue

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
    "go.uber.org/zap"
)

type JobMessage struct {
    Kind      string          `json:"kind"`
    Args      json.RawMessage `json:"args"`
    ID        string          `json:"id"`
    EnqueuedAt time.Time      `json:"enqueued_at"`
}

type PullWorkerPool struct {
    consumer  jetstream.Consumer
    handlers  map[string]JobHandler
    workers   int
    batchSize int
    logger    *zap.Logger
}

type JobHandler func(ctx context.Context, args json.RawMessage) error

func NewPullWorkerPool(ctx context.Context, js jetstream.JetStream, workers, batchSize int, logger *zap.Logger) (*PullWorkerPool, error) {
    // Create or bind durable pull consumer
    consumer, err := js.CreateOrUpdateConsumer(ctx, "JOBS", jetstream.ConsumerConfig{
        Name:          "job-worker",
        Durable:       "job-worker",
        FilterSubject: "jobs.>",
        // AckExplicit: each message must be explicitly acknowledged
        AckPolicy: jetstream.AckExplicitPolicy,
        // Time before unacked message is redelivered
        AckWait: 30 * time.Second,
        // Maximum delivery attempts before moving to advisory subject
        MaxDeliver: 5,
        // Backoff delays for retries
        BackOff: []time.Duration{
            30 * time.Second,
            2 * time.Minute,
            10 * time.Minute,
            30 * time.Minute,
        },
        // Maximum number of unacked messages in flight per consumer
        MaxAckPending: workers * batchSize * 2,
        // Deliver only new messages (not historical)
        DeliverPolicy: jetstream.DeliverNewPolicy,
    })
    if err != nil {
        return nil, fmt.Errorf("creating consumer: %w", err)
    }

    return &PullWorkerPool{
        consumer:  consumer,
        handlers:  make(map[string]JobHandler),
        workers:   workers,
        batchSize: batchSize,
        logger:    logger,
    }, nil
}

func (p *PullWorkerPool) RegisterHandler(kind string, handler JobHandler) {
    p.handlers[kind] = handler
}

func (p *PullWorkerPool) Start(ctx context.Context) error {
    sem := make(chan struct{}, p.workers)

    for {
        select {
        case <-ctx.Done():
            return nil
        default:
        }

        // Fetch a batch of messages with timeout
        msgBatch, err := p.consumer.FetchNoWait(p.batchSize)
        if err != nil {
            p.logger.Error("failed to fetch messages", zap.Error(err))
            time.Sleep(1 * time.Second)
            continue
        }

        messagesProcessed := 0
        for msg := range msgBatch.Messages() {
            messagesProcessed++
            msg := msg // Capture for goroutine

            sem <- struct{}{} // Acquire worker slot
            go func() {
                defer func() { <-sem }() // Release worker slot

                if err := p.processMessage(ctx, msg); err != nil {
                    p.logger.Error("message processing failed",
                        zap.String("subject", msg.Subject()),
                        zap.Error(err),
                    )
                    // Negative acknowledgment causes immediate redelivery
                    msg.Nak()
                    return
                }
                msg.Ack()
            }()
        }

        // If we got fewer messages than batch size, wait before next fetch
        if messagesProcessed < p.batchSize {
            time.Sleep(100 * time.Millisecond)
        }
    }
}

func (p *PullWorkerPool) processMessage(ctx context.Context, msg jetstream.Msg) error {
    var job JobMessage
    if err := json.Unmarshal(msg.Data(), &job); err != nil {
        // Malformed message - terminate without retry
        p.logger.Error("malformed job message",
            zap.String("subject", msg.Subject()),
            zap.ByteString("data_preview", msg.Data()[:min(100, len(msg.Data()))]),
        )
        msg.Term() // Mark as terminated (won't be redelivered)
        return nil
    }

    handler, ok := p.handlers[job.Kind]
    if !ok {
        p.logger.Warn("no handler for job kind",
            zap.String("kind", job.Kind),
        )
        msg.Term() // Unknown job type - terminate
        return nil
    }

    // Extend ack deadline for long-running jobs
    go func() {
        ticker := time.NewTicker(20 * time.Second) // < AckWait of 30s
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                msg.InProgress() // Reset ack timer
            }
        }
    }()

    start := time.Now()
    err := handler(ctx, job.Args)

    p.logger.Info("job processed",
        zap.String("kind", job.Kind),
        zap.String("id", job.ID),
        zap.Duration("duration", time.Since(start)),
        zap.Bool("success", err == nil),
    )

    return err
}
```

### Publishing Jobs with Deduplication

```go
// internal/queue/publisher.go
package queue

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/nats-io/nats.go/jetstream"
)

type Publisher struct {
    js     jetstream.JetStream
    logger *zap.Logger
}

func (p *Publisher) Publish(ctx context.Context, queue, kind string, args interface{}, opts ...PublishOption) error {
    jobID := uuid.NewString()

    argsJSON, err := json.Marshal(args)
    if err != nil {
        return fmt.Errorf("marshaling args: %w", err)
    }

    job := JobMessage{
        Kind:       kind,
        Args:       argsJSON,
        ID:         jobID,
        EnqueuedAt: time.Now(),
    }

    data, err := json.Marshal(job)
    if err != nil {
        return fmt.Errorf("marshaling job: %w", err)
    }

    cfg := &publishConfig{}
    for _, opt := range opts {
        opt(cfg)
    }

    pubOpts := []jetstream.PublishOpt{}

    // Deduplication: NATS deduplicates based on Nats-Msg-Id header within Duplicates window
    if cfg.deduplicationKey != "" {
        pubOpts = append(pubOpts, jetstream.WithMsgID(cfg.deduplicationKey))
    } else {
        pubOpts = append(pubOpts, jetstream.WithMsgID(jobID))
    }

    // Delayed delivery via scheduled message (requires NATS 2.9+)
    headers := make(nats.Header)
    if cfg.delay > 0 {
        headers.Set("Nats-Expected-Stream", "JOBS")
        // Use a scheduler subject for delayed delivery
    }

    subject := fmt.Sprintf("jobs.%s.%s", queue, kind)
    ack, err := p.js.Publish(ctx, subject, data, pubOpts...)
    if err != nil {
        return fmt.Errorf("publishing job: %w", err)
    }

    p.logger.Info("job published",
        zap.String("kind", kind),
        zap.String("queue", queue),
        zap.String("job_id", jobID),
        zap.Uint64("stream_seq", ack.Sequence),
        zap.Bool("duplicate", ack.Duplicate),
    )

    return nil
}

type publishConfig struct {
    deduplicationKey string
    delay            time.Duration
    priority         int
}

type PublishOption func(*publishConfig)

func WithDeduplicationKey(key string) PublishOption {
    return func(c *publishConfig) { c.deduplicationKey = key }
}

func WithDelay(delay time.Duration) PublishOption {
    return func(c *publishConfig) { c.delay = delay }
}
```

### Priority Queue Implementation with JetStream

NATS JetStream doesn't have native priority queues. Implement priority via separate subjects and consumers:

```go
// Priority subjects: jobs.priority.critical, jobs.priority.high, jobs.priority.normal, jobs.priority.low
// Create a consumer that filters by priority subject

type PriorityConsumer struct {
    consumers map[int]jetstream.Consumer // priority -> consumer
    handlers  map[string]JobHandler
    logger    *zap.Logger
}

func (p *PriorityConsumer) Start(ctx context.Context) error {
    // Poll in priority order: critical -> high -> normal -> low
    priorities := []int{1, 2, 3, 4}

    for {
        select {
        case <-ctx.Done():
            return nil
        default:
        }

        processed := false
        for _, priority := range priorities {
            consumer := p.consumers[priority]
            msgs, err := consumer.FetchNoWait(1)
            if err != nil {
                continue
            }

            for msg := range msgs.Messages() {
                processed = true
                if err := p.processMessage(ctx, msg); err != nil {
                    msg.Nak()
                } else {
                    msg.Ack()
                }
            }

            if processed {
                break // Process higher priority messages first
            }
        }

        if !processed {
            time.Sleep(50 * time.Millisecond)
        }
    }
}
```

## Fault-Tolerant Pipeline Patterns

### Outbox Pattern with River

Transactional outbox prevents message loss between database writes and job publication:

```go
// The outbox pattern is built into River via InsertTx
// This ensures atomicity: either BOTH the database write and job are committed, or neither is

func ProcessPayment(ctx context.Context, pool *pgxpool.Pool, riverClient *river.Client[pgx.Tx], payment Payment) error {
    return pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{}, func(tx pgx.Tx) error {
        // Step 1: Write to database
        if _, err := tx.Exec(ctx,
            "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
            payment.Amount, payment.FromAccount,
        ); err != nil {
            return err
        }

        if _, err := tx.Exec(ctx,
            "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
            payment.Amount, payment.ToAccount,
        ); err != nil {
            return err
        }

        // Step 2: Enqueue downstream jobs atomically
        if _, err := riverClient.InsertTx(ctx, tx, jobs.PaymentNotificationArgs{
            PaymentID:   payment.ID,
            FromAccount: payment.FromAccount,
            ToAccount:   payment.ToAccount,
            Amount:      payment.Amount,
        }, nil); err != nil {
            return err
        }

        // Webhook notification job
        if _, err := riverClient.InsertTx(ctx, tx, jobs.WebhookArgs{
            Event:   "payment.completed",
            Payload: payment,
        }, &river.InsertOpts{
            UniqueOpts: river.UniqueOpts{
                ByArgs: true,
                ByPeriod: 10 * time.Minute,
            },
        }); err != nil {
            return err
        }

        return nil
    })
}
```

### Dead Letter Queue Handling

```go
// River: jobs that exhaust retries move to 'discarded' state
// Query discarded jobs for monitoring and reprocessing

func QueryDiscardedJobs(ctx context.Context, pool *pgxpool.Pool) ([]river.Job, error) {
    rows, err := pool.Query(ctx, `
        SELECT id, kind, args, errors, attempt, finalized_at
        FROM river_job
        WHERE state = 'discarded'
          AND finalized_at > NOW() - INTERVAL '24 hours'
        ORDER BY finalized_at DESC
        LIMIT 100
    `)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var jobs []river.Job
    for rows.Next() {
        // Parse rows...
    }
    return jobs, nil
}

// Retry discarded jobs by resetting their state
func RetryDiscardedJob(ctx context.Context, riverClient *river.Client[pgx.Tx], jobID int64) error {
    _, err := riverClient.JobRetry(ctx, jobID)
    return err
}
```

### NATS JetStream Dead Letter via Advisory

```go
// Subscribe to delivery advisory to detect max-delivery exceeded
func (p *Publisher) MonitorDeadLetters(ctx context.Context) error {
    // NATS publishes advisories to $JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>
    sub, err := p.js.Subscribe(
        "$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.JOBS.job-worker",
        func(msg *nats.Msg) {
            var advisory struct {
                Stream     string    `json:"stream"`
                Consumer   string    `json:"consumer"`
                StreamSeq  uint64    `json:"stream_seq"`
                Deliveries int       `json:"deliveries"`
                Subject    string    `json:"subject"`
            }
            if err := json.Unmarshal(msg.Data, &advisory); err != nil {
                return
            }
            zap.L().Error("job exceeded max deliveries",
                zap.String("stream", advisory.Stream),
                zap.String("consumer", advisory.Consumer),
                zap.Uint64("seq", advisory.StreamSeq),
                zap.Int("deliveries", advisory.Deliveries),
                zap.String("subject", advisory.Subject),
            )
            // Alert or move to DLQ stream
        },
    )
    if err != nil {
        return err
    }

    <-ctx.Done()
    return sub.Unsubscribe()
}
```

## Kubernetes Deployment

### River Worker Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: job-worker
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: job-worker
  template:
    metadata:
      labels:
        app: job-worker
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
    spec:
      serviceAccountName: job-worker
      containers:
        - name: worker
          image: myregistry.example.com/job-worker:v2.1.0
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: database-url
            - name: WORKER_CONCURRENCY
              value: "20"
            - name: QUEUE_EMAIL_WORKERS
              value: "10"
            - name: QUEUE_REPORTS_WORKERS
              value: "3"
          ports:
            - name: metrics
              containerPort: 9090
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            periodSeconds: 30
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                # Allow in-flight jobs to complete before shutdown
                command: ["/bin/sh", "-c", "sleep 5"]
      # Allow more time for graceful shutdown of long-running jobs
      terminationGracePeriodSeconds: 120
---
# Scale based on queue depth
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: job-worker-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: job-worker
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: External
      external:
        metric:
          name: river_job_queue_depth
          selector:
            matchLabels:
              queue: default
        target:
          type: AverageValue
          averageValue: "100"  # Scale when avg depth > 100 per replica
```

## Choosing Between River and NATS JetStream

The decision comes down to your existing infrastructure and operational requirements:

**Choose River when:**
- PostgreSQL is already your primary data store
- You need transactional job enqueueing (job enqueued atomically with application writes)
- Job state visibility and manual retry via SQL queries is valuable
- You prefer a single infrastructure dependency

**Choose NATS JetStream when:**
- NATS is already in your infrastructure for other messaging needs
- Jobs need to fan out to multiple consumers (JetStream push consumers)
- Cross-service job routing via subject hierarchy is valuable
- You need streaming replay for audit or recovery scenarios
- Sub-millisecond job pickup latency is required

Both libraries are production-ready and actively maintained. The worst outcome is choosing neither and building a custom job queue on top of raw SQL or Redis — that path reliably produces bugs around edge cases in exactly the scenarios (crashes mid-execution, concurrent workers, delayed retries) that a purpose-built library handles correctly.
