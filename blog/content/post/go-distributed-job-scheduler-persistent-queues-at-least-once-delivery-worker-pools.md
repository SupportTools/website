---
title: "Go: Building a Distributed Job Scheduler with Persistent Queues, At-Least-Once Delivery, and Worker Pools"
date: 2031-07-19T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Job Scheduling", "Queues", "Worker Pools", "Redis"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building a production-grade distributed job scheduler in Go with persistent queues, at-least-once delivery guarantees, worker pools, and observability for enterprise workloads."
more_link: "yes"
url: "/go-distributed-job-scheduler-persistent-queues-at-least-once-delivery-worker-pools/"
---

Building a distributed job scheduler that actually works in production requires solving several interrelated problems simultaneously: how do you persist jobs so they survive process restarts, how do you guarantee at-least-once execution without losing jobs, how do you manage worker concurrency without resource exhaustion, and how do you observe the system when things go wrong? This guide builds a complete, production-ready distributed job scheduler in Go addressing all of these concerns.

<!--more-->

# Go: Building a Distributed Job Scheduler with Persistent Queues, At-Least-Once Delivery, and Worker Pools

## Design Requirements

Before writing any code, establish concrete requirements:

- **Persistence**: Jobs survive scheduler restarts and worker crashes
- **At-least-once delivery**: No job is silently dropped; retries handle transient failures
- **Exactly-once execution** (best-effort): Idempotency keys prevent duplicate side effects
- **Worker pools**: Bounded concurrency with dynamic scaling
- **Priority queues**: High-priority jobs run before low-priority ones
- **Delayed execution**: Schedule jobs for future execution
- **Dead letter queue**: Failed jobs after max retries are preserved for inspection
- **Observability**: Prometheus metrics and structured logging throughout

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Job Scheduler System                      │
│                                                             │
│  ┌──────────┐    ┌─────────────┐    ┌──────────────────┐   │
│  │  Client  │───▶│  Scheduler  │───▶│  Priority Queue  │   │
│  │  (HTTP)  │    │  (Enqueue)  │    │  (Redis Sorted   │   │
│  └──────────┘    └─────────────┘    │   Set / ZSET)    │   │
│                                     └────────┬─────────┘   │
│  ┌──────────────────────────────────────────▼──────────┐   │
│  │              Worker Pool Manager                     │   │
│  │   ┌─────────┐  ┌─────────┐  ┌─────────┐            │   │
│  │   │ Worker 1│  │ Worker 2│  │ Worker N│            │   │
│  │   └─────────┘  └─────────┘  └─────────┘            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Supporting Stores                                   │   │
│  │  - Pending Queue (ZSET by priority+time)             │   │
│  │  - Processing Set (jobs currently executing)         │   │
│  │  - Dead Letter Queue (ZSET for failed jobs)          │   │
│  │  - Job Store (HASH for job metadata)                 │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
job-scheduler/
├── cmd/
│   ├── scheduler/
│   │   └── main.go
│   └── worker/
│       └── main.go
├── internal/
│   ├── job/
│   │   ├── job.go
│   │   └── store.go
│   ├── queue/
│   │   ├── queue.go
│   │   └── redis.go
│   ├── worker/
│   │   ├── pool.go
│   │   └── worker.go
│   ├── scheduler/
│   │   └── scheduler.go
│   └── metrics/
│       └── metrics.go
├── pkg/
│   └── handler/
│       └── http.go
├── go.mod
└── go.sum
```

## Core Data Types

```go
// internal/job/job.go
package job

import (
	"encoding/json"
	"time"
)

// Priority defines job execution priority.
type Priority int

const (
	PriorityLow    Priority = 0
	PriorityNormal Priority = 50
	PriorityHigh   Priority = 100
	PriorityCritical Priority = 200
)

// Status represents the current state of a job.
type Status string

const (
	StatusPending    Status = "pending"
	StatusProcessing Status = "processing"
	StatusCompleted  Status = "completed"
	StatusFailed     Status = "failed"
	StatusDeadLetter Status = "dead_letter"
)

// Job represents a unit of work to be executed.
type Job struct {
	// ID is the unique identifier for this job instance.
	ID string `json:"id"`

	// IdempotencyKey prevents duplicate side effects.
	// If set, the worker checks this key before executing.
	IdempotencyKey string `json:"idempotency_key,omitempty"`

	// Type identifies which handler processes this job.
	Type string `json:"type"`

	// Payload is the job-specific data, serialized as JSON.
	Payload json.RawMessage `json:"payload"`

	// Priority determines queue ordering. Higher = sooner.
	Priority Priority `json:"priority"`

	// Status is the current execution state.
	Status Status `json:"status"`

	// ScheduledAt is when the job should become eligible for pickup.
	ScheduledAt time.Time `json:"scheduled_at"`

	// EnqueuedAt is when the job was submitted.
	EnqueuedAt time.Time `json:"enqueued_at"`

	// StartedAt is when a worker began processing.
	StartedAt *time.Time `json:"started_at,omitempty"`

	// CompletedAt is when the job finished (success or final failure).
	CompletedAt *time.Time `json:"completed_at,omitempty"`

	// Attempts is the number of execution attempts so far.
	Attempts int `json:"attempts"`

	// MaxAttempts is the maximum retries before dead-lettering.
	MaxAttempts int `json:"max_attempts"`

	// LastError is the error message from the most recent failure.
	LastError string `json:"last_error,omitempty"`

	// Queue is the logical queue name (maps to a Redis key prefix).
	Queue string `json:"queue"`

	// WorkerID is the ID of the worker currently processing this job.
	WorkerID string `json:"worker_id,omitempty"`

	// Timeout is the maximum execution duration before the job is
	// considered failed and requeued.
	Timeout time.Duration `json:"timeout"`
}

// Score computes the Redis sorted set score for this job.
// Lower score = higher priority = processed sooner.
// We invert priority and use scheduled time as tiebreaker.
func (j *Job) Score() float64 {
	// Invert priority so higher priority = lower score
	priorityFactor := float64(PriorityCritical-j.Priority) * 1e12
	// Add scheduled time as fractional component
	timeFactor := float64(j.ScheduledAt.UnixNano()) / 1e18
	return priorityFactor + timeFactor
}

// IsEligible returns true if the job is ready to be processed.
func (j *Job) IsEligible() bool {
	return time.Now().After(j.ScheduledAt)
}

// ShouldDeadLetter returns true if the job has exhausted its retry budget.
func (j *Job) ShouldDeadLetter() bool {
	return j.Attempts >= j.MaxAttempts
}

// NextRetryDelay returns the backoff duration for the next retry.
// Uses exponential backoff with jitter.
func (j *Job) NextRetryDelay() time.Duration {
	if j.Attempts == 0 {
		return 0
	}
	// Exponential backoff: 2^attempts * base, capped at maxDelay
	base := 10 * time.Second
	maxDelay := 10 * time.Minute
	delay := base * (1 << min(j.Attempts-1, 6))
	if delay > maxDelay {
		delay = maxDelay
	}
	return delay
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

## Redis Queue Implementation

The queue uses Redis sorted sets (ZSET) for priority ordering and atomic Lua scripts for safe job claiming:

```go
// internal/queue/redis.go
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/yourorg/job-scheduler/internal/job"
	"github.com/yourorg/job-scheduler/internal/metrics"
)

const (
	// Key patterns
	pendingKeyFmt    = "scheduler:queue:%s:pending"
	processingKeyFmt = "scheduler:queue:%s:processing"
	deadLetterKey    = "scheduler:dlq"
	jobHashKeyFmt    = "scheduler:job:%s"
	idempotencyKeyFmt = "scheduler:idempotency:%s"

	// Lua script: atomically move a job from pending to processing.
	// This prevents two workers from claiming the same job.
	claimJobScript = `
local pending_key = KEYS[1]
local processing_key = KEYS[2]
local now = tonumber(ARGV[1])
local worker_id = ARGV[2]

-- Get eligible jobs: score <= now (scheduled time has passed)
local jobs = redis.call('ZRANGEBYSCORE', pending_key, '-inf', now, 'LIMIT', 0, 1)

if #jobs == 0 then
    return nil
end

local job_id = jobs[1]

-- Atomically move from pending to processing
redis.call('ZREM', pending_key, job_id)
redis.call('ZADD', processing_key, now, job_id)

return job_id
`

	// Lua script: re-enqueue a job from processing back to pending (for retries).
	requeueScript = `
local processing_key = KEYS[1]
local pending_key = KEYS[2]
local job_id = ARGV[1]
local new_score = tonumber(ARGV[2])

redis.call('ZREM', processing_key, job_id)
redis.call('ZADD', pending_key, new_score, job_id)
return 1
`

	// Lua script: recover stalled jobs whose processing timeout has expired.
	recoverStalledScript = `
local processing_key = KEYS[1]
local pending_key = KEYS[2]
local stale_before = tonumber(ARGV[1])
local requeue_score = tonumber(ARGV[2])

local stale_jobs = redis.call('ZRANGEBYSCORE', processing_key, '-inf', stale_before)
local recovered = 0

for _, job_id in ipairs(stale_jobs) do
    redis.call('ZREM', processing_key, job_id)
    redis.call('ZADD', pending_key, requeue_score, job_id)
    recovered = recovered + 1
end

return recovered
`
)

// RedisQueue implements a persistent, priority-ordered job queue using Redis.
type RedisQueue struct {
	client *redis.Client
	log    *zap.Logger
}

// NewRedisQueue creates a new Redis-backed queue.
func NewRedisQueue(client *redis.Client, log *zap.Logger) *RedisQueue {
	return &RedisQueue{
		client: client,
		log:    log,
	}
}

// Enqueue adds a job to the pending queue.
func (q *RedisQueue) Enqueue(ctx context.Context, j *job.Job) error {
	// Serialize the full job to a Redis hash
	data, err := json.Marshal(j)
	if err != nil {
		return fmt.Errorf("marshal job: %w", err)
	}

	pipe := q.client.Pipeline()

	// Store job metadata in a hash
	jobKey := fmt.Sprintf(jobHashKeyFmt, j.ID)
	pipe.HSet(ctx, jobKey, "data", data)
	pipe.HSet(ctx, jobKey, "status", string(job.StatusPending))
	pipe.Expire(ctx, jobKey, 7*24*time.Hour)

	// Add job ID to the priority sorted set
	pendingKey := fmt.Sprintf(pendingKeyFmt, j.Queue)
	pipe.ZAdd(ctx, pendingKey, redis.Z{
		Score:  j.Score(),
		Member: j.ID,
	})

	_, err = pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("redis pipeline exec: %w", err)
	}

	metrics.JobEnqueued.WithLabelValues(j.Queue, j.Type).Inc()
	q.log.Info("job enqueued",
		zap.String("job_id", j.ID),
		zap.String("type", j.Type),
		zap.String("queue", j.Queue),
		zap.Time("scheduled_at", j.ScheduledAt),
	)

	return nil
}

// Claim atomically claims the next eligible job for a worker.
// Returns nil, nil when no eligible jobs are available.
func (q *RedisQueue) Claim(ctx context.Context, queueName, workerID string) (*job.Job, error) {
	pendingKey := fmt.Sprintf(pendingKeyFmt, queueName)
	processingKey := fmt.Sprintf(processingKeyFmt, queueName)

	// The score cutoff for eligible jobs: jobs scheduled at or before now
	// We use a composite score; for eligibility, use scheduled time threshold.
	// Jobs with score <= maxEligibleScore are eligible.
	// Since score = (maxPriority - priority) * 1e12 + time_ns / 1e18
	// and max time factor < 1e6 (for reasonable timestamps),
	// we check: score <= (maxPriority - 0) * 1e12 + now_ns / 1e18
	now := float64(time.Now().UnixNano()) / 1e18
	maxScore := float64(job.PriorityCritical)*1e12 + now

	result, err := q.client.Eval(ctx, claimJobScript,
		[]string{pendingKey, processingKey},
		maxScore,
		workerID,
	).Result()

	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claim job script: %w", err)
	}

	jobID, ok := result.(string)
	if !ok {
		return nil, nil
	}

	// Load the full job data from the hash
	j, err := q.loadJob(ctx, jobID)
	if err != nil {
		return nil, fmt.Errorf("load job %s: %w", jobID, err)
	}

	// Update job status and worker assignment
	now2 := time.Now()
	j.Status = job.StatusProcessing
	j.StartedAt = &now2
	j.WorkerID = workerID
	j.Attempts++

	if err := q.updateJob(ctx, j); err != nil {
		return nil, fmt.Errorf("update claimed job: %w", err)
	}

	metrics.JobClaimed.WithLabelValues(queueName, j.Type).Inc()
	return j, nil
}

// Complete marks a job as successfully completed.
func (q *RedisQueue) Complete(ctx context.Context, j *job.Job) error {
	processingKey := fmt.Sprintf(processingKeyFmt, j.Queue)
	now := time.Now()
	j.Status = job.StatusCompleted
	j.CompletedAt = &now

	pipe := q.client.Pipeline()
	pipe.ZRem(ctx, processingKey, j.ID)

	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	jobKey := fmt.Sprintf(jobHashKeyFmt, j.ID)
	pipe.HSet(ctx, jobKey, "data", data, "status", string(job.StatusCompleted))
	// Keep completed job records for 48 hours for audit
	pipe.Expire(ctx, jobKey, 48*time.Hour)

	// Mark idempotency key as consumed
	if j.IdempotencyKey != "" {
		iKey := fmt.Sprintf(idempotencyKeyFmt, j.IdempotencyKey)
		pipe.Set(ctx, iKey, j.ID, 24*time.Hour)
	}

	_, err = pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("complete job pipeline: %w", err)
	}

	metrics.JobCompleted.WithLabelValues(j.Queue, j.Type).Inc()
	metrics.JobDuration.WithLabelValues(j.Queue, j.Type).
		Observe(time.Since(*j.StartedAt).Seconds())

	return nil
}

// Fail handles a job failure, either requeueing with backoff or dead-lettering.
func (q *RedisQueue) Fail(ctx context.Context, j *job.Job, jobErr error) error {
	processingKey := fmt.Sprintf(processingKeyFmt, j.Queue)
	j.LastError = jobErr.Error()

	if j.ShouldDeadLetter() {
		return q.deadLetter(ctx, j)
	}

	// Calculate retry time with exponential backoff
	retryAt := time.Now().Add(j.NextRetryDelay())
	j.ScheduledAt = retryAt
	j.Status = job.StatusPending

	data, err := json.Marshal(j)
	if err != nil {
		return err
	}

	pendingKey := fmt.Sprintf(pendingKeyFmt, j.Queue)
	newScore := j.Score()

	pipe := q.client.Pipeline()
	jobKey := fmt.Sprintf(jobHashKeyFmt, j.ID)
	pipe.HSet(ctx, jobKey, "data", data, "status", string(job.StatusPending))
	pipe.ZRem(ctx, processingKey, j.ID)
	pipe.ZAdd(ctx, pendingKey, redis.Z{
		Score:  newScore,
		Member: j.ID,
	})

	_, err = pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("fail+requeue pipeline: %w", err)
	}

	metrics.JobRetried.WithLabelValues(j.Queue, j.Type).Inc()
	q.log.Warn("job failed, requeued for retry",
		zap.String("job_id", j.ID),
		zap.String("type", j.Type),
		zap.Int("attempt", j.Attempts),
		zap.Int("max_attempts", j.MaxAttempts),
		zap.Time("retry_at", retryAt),
		zap.Error(jobErr),
	)
	return nil
}

func (q *RedisQueue) deadLetter(ctx context.Context, j *job.Job) error {
	processingKey := fmt.Sprintf(processingKeyFmt, j.Queue)
	j.Status = job.StatusDeadLetter
	now := time.Now()
	j.CompletedAt = &now

	data, err := json.Marshal(j)
	if err != nil {
		return err
	}

	pipe := q.client.Pipeline()
	jobKey := fmt.Sprintf(jobHashKeyFmt, j.ID)
	pipe.HSet(ctx, jobKey, "data", data, "status", string(job.StatusDeadLetter))
	pipe.Expire(ctx, jobKey, 30*24*time.Hour)
	pipe.ZRem(ctx, processingKey, j.ID)
	pipe.ZAdd(ctx, deadLetterKey, redis.Z{
		Score:  float64(time.Now().Unix()),
		Member: j.ID,
	})

	_, err = pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("dead letter pipeline: %w", err)
	}

	metrics.JobDeadLettered.WithLabelValues(j.Queue, j.Type).Inc()
	q.log.Error("job dead-lettered",
		zap.String("job_id", j.ID),
		zap.String("type", j.Type),
		zap.Int("attempts", j.Attempts),
		zap.String("last_error", j.LastError),
	)
	return nil
}

// RecoverStalled moves processing jobs that have exceeded their timeout
// back to the pending queue. Called periodically by a maintenance goroutine.
func (q *RedisQueue) RecoverStalled(ctx context.Context, queueName string, processingTimeout time.Duration) (int, error) {
	pendingKey := fmt.Sprintf(pendingKeyFmt, queueName)
	processingKey := fmt.Sprintf(processingKeyFmt, queueName)

	staleBefore := float64(time.Now().Add(-processingTimeout).UnixNano()) / 1e18
	requeueScore := float64(job.PriorityNormal)*1e12 + float64(time.Now().UnixNano())/1e18

	result, err := q.client.Eval(ctx, recoverStalledScript,
		[]string{processingKey, pendingKey},
		staleBefore,
		requeueScore,
	).Int()

	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, fmt.Errorf("recover stalled script: %w", err)
	}

	if result > 0 {
		q.log.Warn("recovered stalled jobs",
			zap.Int("count", result),
			zap.String("queue", queueName),
		)
		metrics.StalledJobsRecovered.WithLabelValues(queueName).Add(float64(result))
	}

	return result, nil
}

func (q *RedisQueue) loadJob(ctx context.Context, jobID string) (*job.Job, error) {
	jobKey := fmt.Sprintf(jobHashKeyFmt, jobID)
	data, err := q.client.HGet(ctx, jobKey, "data").Bytes()
	if err != nil {
		return nil, err
	}
	var j job.Job
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, err
	}
	return &j, nil
}

func (q *RedisQueue) updateJob(ctx context.Context, j *job.Job) error {
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	jobKey := fmt.Sprintf(jobHashKeyFmt, j.ID)
	return q.client.HSet(ctx, jobKey, "data", data, "status", string(j.Status)).Err()
}
```

## Worker Pool

The worker pool manages a bounded set of goroutines that pull jobs from the queue:

```go
// internal/worker/pool.go
package worker

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"

	"github.com/yourorg/job-scheduler/internal/job"
	"github.com/yourorg/job-scheduler/internal/metrics"
	"github.com/yourorg/job-scheduler/internal/queue"
)

// HandlerFunc is a function that processes a specific job type.
type HandlerFunc func(ctx context.Context, j *job.Job) error

// Pool manages a pool of concurrent workers processing jobs from a queue.
type Pool struct {
	config  PoolConfig
	queue   *queue.RedisQueue
	handlers map[string]HandlerFunc
	log     *zap.Logger

	active  atomic.Int64
	wg      sync.WaitGroup
	mu      sync.RWMutex
}

// PoolConfig holds worker pool configuration.
type PoolConfig struct {
	// QueueName is the Redis queue to consume from.
	QueueName string

	// WorkerID is a unique identifier for this worker process.
	WorkerID string

	// Concurrency is the number of parallel workers.
	Concurrency int

	// PollInterval is how often to poll for new jobs when the queue is empty.
	PollInterval time.Duration

	// JobTimeout is the maximum time a job may run before cancellation.
	JobTimeout time.Duration

	// StalledCheckInterval is how often to check for and recover stalled jobs.
	StalledCheckInterval time.Duration

	// ProcessingTimeout is how long a job may be in processing state
	// before it is considered stalled.
	ProcessingTimeout time.Duration
}

// DefaultPoolConfig returns a sensible default configuration.
func DefaultPoolConfig(queueName, workerID string) PoolConfig {
	return PoolConfig{
		QueueName:            queueName,
		WorkerID:             workerID,
		Concurrency:          10,
		PollInterval:         500 * time.Millisecond,
		JobTimeout:           5 * time.Minute,
		StalledCheckInterval: 30 * time.Second,
		ProcessingTimeout:    10 * time.Minute,
	}
}

// NewPool creates a new worker pool.
func NewPool(config PoolConfig, q *queue.RedisQueue, log *zap.Logger) *Pool {
	return &Pool{
		config:   config,
		queue:    q,
		handlers: make(map[string]HandlerFunc),
		log:      log,
	}
}

// Register registers a handler for a job type.
// Must be called before Start.
func (p *Pool) Register(jobType string, fn HandlerFunc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.handlers[jobType] = fn
}

// Start begins processing jobs. Blocks until ctx is cancelled.
func (p *Pool) Start(ctx context.Context) {
	p.log.Info("starting worker pool",
		zap.String("queue", p.config.QueueName),
		zap.String("worker_id", p.config.WorkerID),
		zap.Int("concurrency", p.config.Concurrency),
	)

	// Semaphore channel for bounded concurrency
	sem := make(chan struct{}, p.config.Concurrency)

	// Start stalled job recovery goroutine
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		p.runStalledRecovery(ctx)
	}()

	// Main dispatch loop
	for {
		select {
		case <-ctx.Done():
			p.log.Info("worker pool shutting down, waiting for active workers")
			// Wait for all in-flight workers to complete
			for i := 0; i < p.config.Concurrency; i++ {
				sem <- struct{}{}
			}
			p.wg.Wait()
			p.log.Info("worker pool shut down cleanly")
			return
		default:
		}

		// Try to claim a job
		j, err := p.queue.Claim(ctx, p.config.QueueName, p.config.WorkerID)
		if err != nil {
			p.log.Error("failed to claim job", zap.Error(err))
			time.Sleep(p.config.PollInterval)
			continue
		}

		if j == nil {
			// No eligible jobs; wait before polling again
			metrics.WorkerIdle.WithLabelValues(p.config.QueueName).Set(
				float64(p.config.Concurrency) - float64(p.active.Load()),
			)
			time.Sleep(p.config.PollInterval)
			continue
		}

		// Acquire semaphore slot (blocks if at max concurrency)
		sem <- struct{}{}
		p.active.Add(1)
		metrics.WorkerActive.WithLabelValues(p.config.QueueName).Inc()

		p.wg.Add(1)
		go func(j *job.Job) {
			defer func() {
				<-sem
				p.active.Add(-1)
				metrics.WorkerActive.WithLabelValues(p.config.QueueName).Dec()
				p.wg.Done()
			}()
			p.processJob(ctx, j)
		}(j)
	}
}

func (p *Pool) processJob(ctx context.Context, j *job.Job) {
	log := p.log.With(
		zap.String("job_id", j.ID),
		zap.String("job_type", j.Type),
		zap.String("queue", j.Queue),
		zap.Int("attempt", j.Attempts),
	)

	// Create a context with the job's timeout
	timeout := j.Timeout
	if timeout <= 0 {
		timeout = p.config.JobTimeout
	}
	jobCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Find the handler
	p.mu.RLock()
	handler, ok := p.handlers[j.Type]
	p.mu.RUnlock()

	if !ok {
		log.Error("no handler registered for job type")
		err := p.queue.Fail(ctx, j, fmt.Errorf("no handler for job type %q", j.Type))
		if err != nil {
			log.Error("failed to fail job", zap.Error(err))
		}
		return
	}

	// Check idempotency
	if j.IdempotencyKey != "" {
		alreadyDone, err := p.checkIdempotency(ctx, j.IdempotencyKey)
		if err != nil {
			log.Warn("idempotency check failed, proceeding with execution", zap.Error(err))
		} else if alreadyDone {
			log.Info("job already completed (idempotency key consumed), marking complete")
			if err := p.queue.Complete(ctx, j); err != nil {
				log.Error("failed to complete idempotent job", zap.Error(err))
			}
			return
		}
	}

	log.Info("executing job")
	start := time.Now()

	// Execute the handler with panic recovery
	var execErr error
	func() {
		defer func() {
			if r := recover(); r != nil {
				execErr = fmt.Errorf("panic in job handler: %v", r)
				log.Error("job handler panicked", zap.Any("panic", r))
			}
		}()
		execErr = handler(jobCtx, j)
	}()

	duration := time.Since(start)
	log = log.With(zap.Duration("duration", duration))

	if execErr != nil {
		log.Warn("job execution failed", zap.Error(execErr))
		if err := p.queue.Fail(ctx, j, execErr); err != nil {
			log.Error("failed to record job failure", zap.Error(err))
		}
		return
	}

	log.Info("job completed successfully")
	if err := p.queue.Complete(ctx, j); err != nil {
		log.Error("failed to complete job", zap.Error(err))
	}
}

func (p *Pool) checkIdempotency(ctx context.Context, key string) (bool, error) {
	// Delegated to queue implementation via separate method
	// Returns true if the key was already consumed
	return p.queue.IsIdempotencyKeyConsumed(ctx, key)
}

func (p *Pool) runStalledRecovery(ctx context.Context) {
	ticker := time.NewTicker(p.config.StalledCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			count, err := p.queue.RecoverStalled(ctx, p.config.QueueName, p.config.ProcessingTimeout)
			if err != nil {
				p.log.Error("stalled job recovery failed", zap.Error(err))
			}
			if count > 0 {
				p.log.Warn("recovered stalled jobs", zap.Int("count", count))
			}
		}
	}
}
```

## Metrics

```go
// internal/metrics/metrics.go
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	JobEnqueued = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "scheduler_jobs_enqueued_total",
		Help: "Total number of jobs enqueued.",
	}, []string{"queue", "type"})

	JobClaimed = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "scheduler_jobs_claimed_total",
		Help: "Total number of jobs claimed by workers.",
	}, []string{"queue", "type"})

	JobCompleted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "scheduler_jobs_completed_total",
		Help: "Total number of jobs completed successfully.",
	}, []string{"queue", "type"})

	JobRetried = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "scheduler_jobs_retried_total",
		Help: "Total number of job retries.",
	}, []string{"queue", "type"})

	JobDeadLettered = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "scheduler_jobs_dead_lettered_total",
		Help: "Total number of jobs moved to dead letter queue.",
	}, []string{"queue", "type"})

	JobDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "scheduler_job_duration_seconds",
		Help:    "Job execution duration in seconds.",
		Buckets: prometheus.ExponentialBuckets(0.01, 2, 15),
	}, []string{"queue", "type"})

	WorkerActive = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "scheduler_workers_active",
		Help: "Number of currently active workers.",
	}, []string{"queue"})

	WorkerIdle = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "scheduler_workers_idle",
		Help: "Number of idle workers.",
	}, []string{"queue"})

	StalledJobsRecovered = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "scheduler_stalled_jobs_recovered_total",
		Help: "Total number of stalled jobs recovered.",
	}, []string{"queue"})

	QueueDepth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "scheduler_queue_depth",
		Help: "Current number of pending jobs in queue.",
	}, []string{"queue"})
)
```

## HTTP API for Job Submission

```go
// pkg/handler/http.go
package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/yourorg/job-scheduler/internal/job"
	"github.com/yourorg/job-scheduler/internal/queue"
)

// SubmitRequest is the HTTP request body for job submission.
type SubmitRequest struct {
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	Priority       int             `json:"priority"`
	Queue          string          `json:"queue"`
	IdempotencyKey string          `json:"idempotency_key,omitempty"`
	ScheduleAt     *time.Time      `json:"schedule_at,omitempty"`
	MaxAttempts    int             `json:"max_attempts,omitempty"`
	TimeoutSeconds int             `json:"timeout_seconds,omitempty"`
}

// SubmitResponse is returned after successful job submission.
type SubmitResponse struct {
	JobID string `json:"job_id"`
}

// Handler provides HTTP handlers for job scheduler operations.
type Handler struct {
	queue *queue.RedisQueue
	log   *zap.Logger
}

// NewHandler creates a new HTTP handler.
func NewHandler(q *queue.RedisQueue, log *zap.Logger) *Handler {
	return &Handler{queue: q, log: log}
}

// SubmitJob handles POST /jobs
func (h *Handler) SubmitJob(w http.ResponseWriter, r *http.Request) {
	var req SubmitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	if req.Type == "" {
		http.Error(w, "job type is required", http.StatusBadRequest)
		return
	}
	if req.Queue == "" {
		req.Queue = "default"
	}
	if req.MaxAttempts <= 0 {
		req.MaxAttempts = 3
	}

	scheduledAt := time.Now()
	if req.ScheduleAt != nil && req.ScheduleAt.After(time.Now()) {
		scheduledAt = *req.ScheduleAt
	}

	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}

	j := &job.Job{
		ID:             uuid.New().String(),
		IdempotencyKey: req.IdempotencyKey,
		Type:           req.Type,
		Payload:        req.Payload,
		Priority:       job.Priority(req.Priority),
		Status:         job.StatusPending,
		ScheduledAt:    scheduledAt,
		EnqueuedAt:     time.Now(),
		MaxAttempts:    req.MaxAttempts,
		Queue:          req.Queue,
		Timeout:        timeout,
	}

	if err := h.queue.Enqueue(r.Context(), j); err != nil {
		h.log.Error("failed to enqueue job", zap.Error(err))
		http.Error(w, "failed to enqueue job", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(SubmitResponse{JobID: j.ID})
}
```

## Main Scheduler Entry Point

```go
// cmd/scheduler/main.go
package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/yourorg/job-scheduler/internal/queue"
	"github.com/yourorg/job-scheduler/internal/worker"
	"github.com/yourorg/job-scheduler/pkg/handler"
)

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync()

	redisClient := redis.NewClient(&redis.Options{
		Addr:         os.Getenv("REDIS_ADDR"),
		Password:     os.Getenv("REDIS_PASSWORD"),
		DB:           0,
		PoolSize:     50,
		MinIdleConns: 10,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
	})

	ctx, cancel := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Verify Redis connectivity
	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Fatal("redis ping failed", zap.Error(err))
	}

	q := queue.NewRedisQueue(redisClient, log)

	// Configure and start worker pool for default queue
	poolConfig := worker.DefaultPoolConfig("default", "worker-1")
	poolConfig.Concurrency = 20
	pool := worker.NewPool(poolConfig, q, log)

	// Register job handlers
	pool.Register("send-email", func(ctx context.Context, j *job.Job) error {
		// Email sending logic here
		return sendEmail(ctx, j)
	})
	pool.Register("process-payment", func(ctx context.Context, j *job.Job) error {
		return processPayment(ctx, j)
	})
	pool.Register("generate-report", func(ctx context.Context, j *job.Job) error {
		return generateReport(ctx, j)
	})

	// Start HTTP API server
	h := handler.NewHandler(q, log)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /jobs", h.SubmitJob)
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("HTTP API server starting", zap.String("addr", srv.Addr))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal("HTTP server failed", zap.Error(err))
		}
	}()

	// Start worker pool (blocking)
	go pool.Start(ctx)

	<-ctx.Done()
	log.Info("shutting down")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	srv.Shutdown(shutdownCtx)
}
```

## Kubernetes Deployment

```yaml
# scheduler-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: job-scheduler
  namespace: platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: job-scheduler
  template:
    metadata:
      labels:
        app: job-scheduler
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: scheduler
          image: yourregistry/job-scheduler:v1.0.0
          ports:
            - containerPort: 8080
          env:
            - name: REDIS_ADDR
              valueFrom:
                secretKeyRef:
                  name: redis-credentials
                  key: addr
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-credentials
                  key: password
            - name: WORKER_CONCURRENCY
              value: "20"
          resources:
            requests:
              cpu: 500m
              memory: 256Mi
            limits:
              cpu: "2"
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 15
            periodSeconds: 30
```

## Testing At-Least-Once Delivery

```go
// Test that demonstrates at-least-once delivery under simulated worker crash
func TestAtLeastOnceDelivery(t *testing.T) {
	ctx := context.Background()
	q := setupTestQueue(t)

	// Enqueue 10 jobs
	for i := 0; i < 10; i++ {
		j := &job.Job{
			ID:          fmt.Sprintf("test-job-%d", i),
			Type:        "test",
			Queue:       "test-queue",
			MaxAttempts: 3,
			ScheduledAt: time.Now(),
			Priority:    job.PriorityNormal,
		}
		require.NoError(t, q.Enqueue(ctx, j))
	}

	// Claim all jobs (simulating a worker that crashes after claiming)
	var claimed []*job.Job
	for {
		j, err := q.Claim(ctx, "test-queue", "crashed-worker")
		require.NoError(t, err)
		if j == nil {
			break
		}
		claimed = append(claimed, j)
	}
	require.Len(t, claimed, 10)

	// Simulate crash: don't call Complete or Fail
	// Instead, trigger stalled recovery with a very short timeout
	recovered, err := q.RecoverStalled(ctx, "test-queue", 0)
	require.NoError(t, err)
	require.Equal(t, 10, recovered)

	// All jobs should be claimable again
	var reclaimed []*job.Job
	for {
		j, err := q.Claim(ctx, "test-queue", "recovery-worker")
		require.NoError(t, err)
		if j == nil {
			break
		}
		reclaimed = append(reclaimed, j)
	}
	require.Len(t, reclaimed, 10)
}
```

## Prometheus Alerting

```yaml
# scheduler-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: job-scheduler-alerts
  namespace: monitoring
spec:
  groups:
    - name: job-scheduler
      rules:
        - alert: HighDeadLetterRate
          expr: |
            rate(scheduler_jobs_dead_lettered_total[5m]) > 0.1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "High rate of jobs being dead-lettered"
            description: "Queue {{ $labels.queue }} type {{ $labels.type }} is dead-lettering {{ $value | humanize }}/s"

        - alert: QueueDepthHigh
          expr: scheduler_queue_depth > 10000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Job queue depth is high"

        - alert: WorkerPoolSaturated
          expr: |
            scheduler_workers_idle / (scheduler_workers_active + scheduler_workers_idle) < 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Worker pool is nearly saturated, consider scaling"
```

## Summary

This distributed job scheduler implements production-grade guarantees through several key mechanisms:

- **At-least-once delivery** is ensured by the atomic Lua claim script, the processing sorted set, and the stalled job recovery loop. A job is never silently dropped.
- **Idempotency keys** provide a best-effort path to exactly-once side effects, protecting against duplicate execution after retries.
- **Exponential backoff** with dead-letter queue prevents hot-looping on persistently failing jobs while preserving them for inspection.
- **Worker pool semaphore** prevents resource exhaustion under burst load while maximizing utilization during normal operation.
- **Panic recovery** in job handlers means a single misbehaving job cannot bring down the worker process.
- **Prometheus metrics** throughout provide full visibility into queue health, worker utilization, and failure rates.
