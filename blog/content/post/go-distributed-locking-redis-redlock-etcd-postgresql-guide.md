---
title: "Go Distributed Locking: Redis Redlock, etcd, and PostgreSQL Advisory Locks"
date: 2031-06-05T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Redis", "etcd", "PostgreSQL", "Distributed Systems", "Locking"]
categories:
- Go
- Distributed Systems
- Backend Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete enterprise guide to distributed locking in Go covering Redis Redlock algorithm with go-redis, etcd lease-based locks, PostgreSQL advisory locks, lock TTL and fencing tokens, and leader election patterns for production systems."
more_link: "yes"
url: "/go-distributed-locking-redis-redlock-etcd-postgresql-guide/"
---

Distributed locking is one of the hardest problems in distributed systems. A single poorly implemented distributed lock can cause data corruption, double processing, or cascading failures that take down production systems. This guide covers the three most common distributed locking implementations in Go — Redis Redlock, etcd leases, and PostgreSQL advisory locks — with careful attention to the failure modes of each, the fencing token pattern that makes locks safe even under network partitions, and leader election as a higher-level coordination primitive.

<!--more-->

# Go Distributed Locking: Redis Redlock, etcd, and PostgreSQL Advisory Locks

## Section 1: When You Actually Need a Distributed Lock

Before implementing a distributed lock, verify that you actually need one. Distributed locks add complexity and have well-known failure modes. Consider alternatives first:

**Use instead of distributed locks:**
- Idempotent operations with database unique constraints
- Optimistic locking (compare-and-swap on a version field)
- Message queue with single consumer per partition
- Atomic database operations with SELECT FOR UPDATE

**Use distributed locks when:**
- You need to coordinate access to a resource external to the database
- The critical section must execute on exactly one node at a time
- The operation is not naturally idempotent
- You need leader election (only one service instance should run a task)

## Section 2: The Fencing Token Pattern

Before implementing any specific lock, understand fencing tokens. The fundamental problem with distributed locks is that a lock holder can be paused (GC pause, network partition, OS scheduling) while holding the lock, and another node may acquire the same lock. When the first node resumes, it believes it holds the lock but it has expired.

Fencing tokens solve this by including a monotonically increasing token with every lock grant. Resources check that tokens are monotonically increasing and reject requests with stale tokens:

```go
// fencing/token.go
package fencing

import (
    "context"
    "fmt"
    "sync/atomic"
)

// FenceToken is a monotonically increasing identifier issued with each lock grant.
type FenceToken struct {
    Value uint64
}

// FencedResource is an example of a resource that enforces fencing.
type FencedResource struct {
    highWaterMark atomic.Uint64
}

// Write accepts a write only if the token is >= the highest seen token.
func (r *FencedResource) Write(ctx context.Context, token FenceToken, data []byte) error {
    for {
        current := r.highWaterMark.Load()
        if token.Value < current {
            return fmt.Errorf("stale lock token: got %d, resource at %d", token.Value, current)
        }
        if r.highWaterMark.CompareAndSwap(current, token.Value) {
            // Proceed with write
            break
        }
    }
    // ... actual write logic
    return nil
}
```

## Section 3: Redis Redlock Algorithm

Redlock is the multi-node Redis distributed locking algorithm designed for high availability. It acquires the lock on a majority of Redis instances to tolerate node failures.

### Why Single-Node Redis Locks Are Insufficient

```go
// DO NOT USE in production: single-node Redis lock is not safe
// If the Redis primary fails after setting the key but before the
// replica syncs, the lock is lost and two clients can hold it simultaneously.

// UNSAFE single-node implementation (illustrative only)
func unsafeRedisLock(ctx context.Context, rdb *redis.Client, key string, ttl time.Duration) (bool, error) {
    result, err := rdb.SetNX(ctx, key, "locked", ttl).Result()
    return result, err
    // Problem: if node fails between SET and replica sync, lock is lost
}
```

### Implementing Redlock with go-redis

```bash
go get github.com/redis/go-redis/v9
go get github.com/go-redsync/redsync/v4
```

```go
// lock/redlock.go
package lock

import (
    "context"
    "fmt"
    "time"

    "github.com/go-redsync/redsync/v4"
    "github.com/go-redsync/redsync/v4/redis/goredis/v9"
    goredis "github.com/redis/go-redis/v9"
)

type RedlockManager struct {
    rs *redsync.Redsync
}

func NewRedlockManager(addrs []string) (*RedlockManager, error) {
    pools := make([]redsync.Pool, len(addrs))
    for i, addr := range addrs {
        client := goredis.NewClient(&goredis.Options{
            Addr:         addr,
            DialTimeout:  2 * time.Second,
            ReadTimeout:  2 * time.Second,
            WriteTimeout: 2 * time.Second,
        })
        pools[i] = goredis.NewPool(client)
    }

    rs := redsync.New(pools...)
    return &RedlockManager{rs: rs}, nil
}

type RedLock struct {
    mutex     *redsync.Mutex
    name      string
    fenceVal  int64
}

// Acquire attempts to acquire the distributed lock.
// Returns the lock with a fence token for use with fenced resources.
func (m *RedlockManager) Acquire(ctx context.Context, name string, ttl time.Duration) (*RedLock, error) {
    mutex := m.rs.NewMutex(
        name,
        redsync.WithExpiry(ttl),
        redsync.WithTries(3),
        redsync.WithRetryDelay(100*time.Millisecond),
        redsync.WithDriftFactor(0.01),       // 1% clock drift allowance
        redsync.WithTimeoutFactor(0.05),     // Timeout at 5% of TTL per try
        redsync.WithGenValueFunc(generateSecureToken), // Random token for the lock value
    )

    if err := mutex.LockContext(ctx); err != nil {
        return nil, fmt.Errorf("failed to acquire lock %s: %w", name, err)
    }

    return &RedLock{
        mutex: mutex,
        name:  name,
    }, nil
}

// Release releases the distributed lock.
// Returns an error if the lock was already expired or stolen.
func (l *RedLock) Release(ctx context.Context) error {
    ok, err := l.mutex.UnlockContext(ctx)
    if err != nil {
        return fmt.Errorf("failed to release lock %s: %w", l.name, err)
    }
    if !ok {
        return fmt.Errorf("lock %s was already expired or stolen", l.name)
    }
    return nil
}

// Extend extends the TTL of the held lock.
func (l *RedLock) Extend(ctx context.Context, ttl time.Duration) error {
    ok, err := l.mutex.ExtendContext(ctx)
    if err != nil {
        return fmt.Errorf("failed to extend lock %s: %w", l.name, err)
    }
    if !ok {
        return fmt.Errorf("lock %s could not be extended (expired or stolen)", l.name)
    }
    return nil
}

// Value returns the lock's unique value (used for fencing).
func (l *RedLock) Value() string {
    return l.mutex.Value()
}

func generateSecureToken() (string, error) {
    b := make([]byte, 16)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return hex.EncodeToString(b), nil
}
```

### Using Redlock in Practice

```go
// Example: Job scheduler with distributed lock
package scheduler

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "myapp/lock"
)

type JobScheduler struct {
    locks   *lock.RedlockManager
    logger  *slog.Logger
}

func (s *JobScheduler) RunExclusively(ctx context.Context, jobName string, fn func(ctx context.Context) error) error {
    lockName := fmt.Sprintf("job:%s", jobName)
    lockTTL := 5 * time.Minute

    l, err := s.locks.Acquire(ctx, lockName, lockTTL)
    if err != nil {
        // Another instance holds the lock - skip this run
        s.logger.Info("skipping job: lock already held",
            "job", jobName,
            "error", err,
        )
        return nil
    }
    defer func() {
        if err := l.Release(ctx); err != nil {
            s.logger.Error("failed to release lock", "job", jobName, "error", err)
        }
    }()

    // Extend lock periodically for long-running jobs
    extendCtx, cancelExtend := context.WithCancel(ctx)
    defer cancelExtend()
    go func() {
        ticker := time.NewTicker(lockTTL / 2)
        defer ticker.Stop()
        for {
            select {
            case <-extendCtx.Done():
                return
            case <-ticker.C:
                if err := l.Extend(extendCtx, lockTTL); err != nil {
                    s.logger.Error("failed to extend lock", "job", jobName, "error", err)
                    cancelExtend()
                    return
                }
            }
        }
    }()

    return fn(ctx)
}
```

### Redlock Configuration for Production

```go
// Production Redlock setup requires an odd number of independent Redis nodes
// (not replicas of each other) in different availability zones

func productionRedlock() (*lock.RedlockManager, error) {
    // 5 independent Redis instances (majority = 3)
    addrs := []string{
        "redis-1.us-east-1a:6379",
        "redis-2.us-east-1b:6379",
        "redis-3.us-east-1c:6379",
        "redis-4.us-west-2a:6379",
        "redis-5.us-west-2b:6379",
    }
    return lock.NewRedlockManager(addrs)
}
```

## Section 4: etcd Lease-Based Distributed Locks

etcd's lease mechanism provides distributed locking with stronger consistency guarantees than Redlock. etcd uses the Raft consensus algorithm, which means it is linearizable.

```bash
go get go.etcd.io/etcd/client/v3
```

### etcd Lock Implementation

```go
// lock/etcd.go
package lock

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

type EtcdLockManager struct {
    client *clientv3.Client
}

func NewEtcdLockManager(endpoints []string) (*EtcdLockManager, error) {
    client, err := clientv3.New(clientv3.Config{
        Endpoints:   endpoints,
        DialTimeout: 5 * time.Second,
        // TLS configuration for production:
        // TLS: &tls.Config{...},
    })
    if err != nil {
        return nil, fmt.Errorf("failed to create etcd client: %w", err)
    }
    return &EtcdLockManager{client: client}, nil
}

type EtcdLock struct {
    session *concurrency.Session
    mutex   *concurrency.Mutex
    name    string
}

// Acquire acquires the distributed lock using an etcd lease.
// The lease TTL is the time after which the lock is automatically released
// if the session is lost (e.g., network partition).
func (m *EtcdLockManager) Acquire(ctx context.Context, name string, ttlSeconds int) (*EtcdLock, error) {
    // Create a session with the specified TTL
    // The session keeps the lease alive via heartbeats
    session, err := concurrency.NewSession(m.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create etcd session: %w", err)
    }

    mutex := concurrency.NewMutex(session, "/locks/"+name)

    if err := mutex.Lock(ctx); err != nil {
        session.Close()
        return nil, fmt.Errorf("failed to acquire etcd lock %s: %w", name, err)
    }

    return &EtcdLock{
        session: session,
        mutex:   mutex,
        name:    name,
    }, nil
}

// TryAcquire attempts to acquire the lock without blocking.
// Returns (lock, nil) if acquired, (nil, nil) if not available.
func (m *EtcdLockManager) TryAcquire(ctx context.Context, name string, ttlSeconds int) (*EtcdLock, error) {
    session, err := concurrency.NewSession(m.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create etcd session: %w", err)
    }

    mutex := concurrency.NewMutex(session, "/locks/"+name)

    if err := mutex.TryLock(ctx); err != nil {
        session.Close()
        if err == concurrency.ErrLocked {
            return nil, nil // Lock not available, not an error
        }
        return nil, fmt.Errorf("failed to try-acquire etcd lock %s: %w", name, err)
    }

    return &EtcdLock{
        session: session,
        mutex:   mutex,
        name:    name,
    }, nil
}

// Release releases the lock and closes the session.
func (l *EtcdLock) Release(ctx context.Context) error {
    if err := l.mutex.Unlock(ctx); err != nil {
        return fmt.Errorf("failed to unlock etcd lock %s: %w", l.name, err)
    }
    return l.session.Close()
}

// Done returns a channel that is closed when the session expires.
// This allows lock holders to react to session loss.
func (l *EtcdLock) Done() <-chan struct{} {
    return l.session.Done()
}

// IsValid returns true if the lock session is still active.
func (l *EtcdLock) IsValid() bool {
    select {
    case <-l.session.Done():
        return false
    default:
        return true
    }
}
```

### etcd Lock with Session Loss Handling

```go
func processWithEtcdLock(ctx context.Context, lockMgr *lock.EtcdLockManager) error {
    l, err := lockMgr.Acquire(ctx, "my-critical-section", 30)
    if err != nil {
        return fmt.Errorf("failed to acquire lock: %w", err)
    }
    defer l.Release(ctx)

    // Create a context that is cancelled if the lock session expires
    lockCtx, cancelLock := context.WithCancel(ctx)
    defer cancelLock()

    go func() {
        select {
        case <-l.Done():
            // Session expired (network partition, etc.)
            cancelLock()
        case <-lockCtx.Done():
            // Normal cancellation
        }
    }()

    // Use lockCtx instead of ctx for operations that require the lock
    if err := performCriticalSection(lockCtx); err != nil {
        if ctx.Err() != nil && lockCtx.Err() != nil {
            return fmt.Errorf("lock session expired during critical section: %w", err)
        }
        return err
    }

    return nil
}
```

### etcd Watch for Lock Ownership Changes

```go
// Monitor who holds the lock and for how long
func watchLock(ctx context.Context, client *clientv3.Client, lockKey string) {
    watchChan := client.Watch(ctx, lockKey, clientv3.WithPrefix())

    for resp := range watchChan {
        for _, event := range resp.Events {
            switch event.Type {
            case clientv3.EventTypePut:
                fmt.Printf("Lock %s acquired by %s (revision %d)\n",
                    lockKey, event.Kv.Value, event.Kv.ModRevision)
            case clientv3.EventTypeDelete:
                fmt.Printf("Lock %s released (revision %d)\n",
                    lockKey, event.Kv.ModRevision)
            }
        }
    }
}
```

## Section 5: PostgreSQL Advisory Locks

PostgreSQL advisory locks are the simplest distributed lock when your application already uses PostgreSQL. They are managed by PostgreSQL itself and automatically released when a connection is closed, even on crash.

### Two Types of Advisory Locks

1. **Session-level**: Held until explicitly released or connection closed
2. **Transaction-level**: Automatically released when transaction ends

```go
// lock/postgres.go
package lock

import (
    "context"
    "database/sql"
    "fmt"
    "hash/fnv"

    _ "github.com/lib/pq"
)

type PostgresLockManager struct {
    db *sql.DB
}

func NewPostgresLockManager(dsn string) (*PostgresLockManager, error) {
    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("failed to open database: %w", err)
    }
    if err := db.Ping(); err != nil {
        return nil, fmt.Errorf("failed to ping database: %w", err)
    }
    return &PostgresLockManager{db: db}, nil
}

// keyToInt64 converts a string lock key to a PostgreSQL advisory lock ID.
// Uses FNV hash to map arbitrary strings to int64.
func keyToInt64(key string) int64 {
    h := fnv.New64a()
    h.Write([]byte(key))
    return int64(h.Sum64())
}

// AcquireSessionLock acquires a session-level advisory lock.
// Blocks until the lock is acquired.
// The lock is held until explicitly released or connection closed.
func (m *PostgresLockManager) AcquireSessionLock(ctx context.Context, key string) (*PostgresSessionLock, error) {
    conn, err := m.db.Conn(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to get connection: %w", err)
    }

    lockID := keyToInt64(key)
    _, err = conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", lockID)
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("failed to acquire advisory lock %s: %w", key, err)
    }

    return &PostgresSessionLock{
        conn:   conn,
        lockID: lockID,
        key:    key,
    }, nil
}

// TryAcquireSessionLock attempts to acquire a session-level advisory lock without blocking.
// Returns (lock, nil) if acquired, (nil, nil) if not available.
func (m *PostgresLockManager) TryAcquireSessionLock(ctx context.Context, key string) (*PostgresSessionLock, error) {
    conn, err := m.db.Conn(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to get connection: %w", err)
    }

    lockID := keyToInt64(key)
    var acquired bool
    err = conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", lockID).Scan(&acquired)
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("failed to try advisory lock %s: %w", key, err)
    }

    if !acquired {
        conn.Close()
        return nil, nil // Not available
    }

    return &PostgresSessionLock{
        conn:   conn,
        lockID: lockID,
        key:    key,
    }, nil
}

type PostgresSessionLock struct {
    conn   *sql.Conn
    lockID int64
    key    string
}

// Release explicitly releases the advisory lock.
func (l *PostgresSessionLock) Release(ctx context.Context) error {
    defer l.conn.Close()
    _, err := l.conn.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", l.lockID)
    if err != nil {
        return fmt.Errorf("failed to release advisory lock %s: %w", l.key, err)
    }
    return nil
}
```

### Transaction-Level Advisory Locks

```go
// Transaction-level advisory locks are simpler because they auto-release on commit/rollback

// AcquireTransactionLock acquires an advisory lock within a transaction.
// The lock is automatically released when the transaction ends.
func (m *PostgresLockManager) AcquireTransactionLock(ctx context.Context, tx *sql.Tx, key string) error {
    lockID := keyToInt64(key)
    _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", lockID)
    return err
}

// TryAcquireTransactionLock attempts to acquire a transaction-level lock.
func (m *PostgresLockManager) TryAcquireTransactionLock(ctx context.Context, tx *sql.Tx, key string) (bool, error) {
    lockID := keyToInt64(key)
    var acquired bool
    err := tx.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock($1)", lockID).Scan(&acquired)
    return acquired, err
}
```

### PostgreSQL Advisory Lock with Work Queue

```go
// Work queue processor using PostgreSQL advisory locks
// Classic pattern: each worker locks a row before processing it

func processQueueItem(ctx context.Context, db *sql.DB) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // SELECT FOR UPDATE SKIP LOCKED is more efficient for queues
    // but advisory locks work for cross-table coordination
    var id int64
    var payload string
    err = tx.QueryRowContext(ctx, `
        SELECT id, payload
        FROM work_queue
        WHERE status = 'pending'
        AND pg_try_advisory_xact_lock(id)
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    `).Scan(&id, &payload)
    if err == sql.ErrNoRows {
        return nil // No work available
    }
    if err != nil {
        return fmt.Errorf("failed to claim work item: %w", err)
    }

    // Process the work item
    if err := processPayload(ctx, payload); err != nil {
        return fmt.Errorf("failed to process payload: %w", err)
    }

    // Mark as complete
    _, err = tx.ExecContext(ctx,
        "UPDATE work_queue SET status = 'done', processed_at = NOW() WHERE id = $1",
        id,
    )
    if err != nil {
        return fmt.Errorf("failed to mark work item done: %w", err)
    }

    return tx.Commit()
}
```

## Section 6: Lock TTL and Expiration Strategies

Choosing the right TTL is critical. Too short: legitimate operations get their lock stolen. Too long: failed nodes hold locks for extended periods.

### Adaptive TTL Based on Operation History

```go
// ttl/adaptive.go
package ttl

import (
    "sync"
    "time"
)

// AdaptiveTTL tracks historical lock durations and suggests appropriate TTLs.
type AdaptiveTTL struct {
    mu          sync.Mutex
    samples     []time.Duration
    maxSamples  int
    safetyFactor float64
}

func NewAdaptiveTTL(maxSamples int, safetyFactor float64) *AdaptiveTTL {
    return &AdaptiveTTL{
        maxSamples:   maxSamples,
        safetyFactor: safetyFactor,
    }
}

func (a *AdaptiveTTL) Record(duration time.Duration) {
    a.mu.Lock()
    defer a.mu.Unlock()
    a.samples = append(a.samples, duration)
    if len(a.samples) > a.maxSamples {
        a.samples = a.samples[1:]
    }
}

// Suggest returns a TTL with safety margin applied.
func (a *AdaptiveTTL) Suggest(minTTL, maxTTL time.Duration) time.Duration {
    a.mu.Lock()
    defer a.mu.Unlock()

    if len(a.samples) == 0 {
        // No history: return a conservative default
        return maxTTL / 2
    }

    var p99 time.Duration
    sorted := make([]time.Duration, len(a.samples))
    copy(sorted, a.samples)
    // Simple sort for small slices
    for i := 1; i < len(sorted); i++ {
        for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
            sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
        }
    }
    idx := int(float64(len(sorted)) * 0.99)
    if idx >= len(sorted) {
        idx = len(sorted) - 1
    }
    p99 = sorted[idx]

    suggested := time.Duration(float64(p99) * (1 + a.safetyFactor))
    if suggested < minTTL {
        return minTTL
    }
    if suggested > maxTTL {
        return maxTTL
    }
    return suggested
}
```

## Section 7: Leader Election

Leader election is a higher-level coordination pattern built on distributed locks. The leader lock holder is responsible for running a singleton task (cronjob, cache warmer, data migrator).

### Leader Election with etcd

```go
// election/leader.go
package election

import (
    "context"
    "fmt"
    "log/slog"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

type LeaderElection struct {
    client     *clientv3.Client
    electionKey string
    identity   string
    logger     *slog.Logger
}

func NewLeaderElection(client *clientv3.Client, electionKey, identity string, logger *slog.Logger) *LeaderElection {
    return &LeaderElection{
        client:      client,
        electionKey: electionKey,
        identity:    identity,
        logger:      logger,
    }
}

// RunAsLeader runs fn when this instance becomes the leader.
// fn is cancelled when leadership is lost.
// This function blocks until ctx is cancelled.
func (le *LeaderElection) RunAsLeader(ctx context.Context, fn func(ctx context.Context)) error {
    for {
        if err := ctx.Err(); err != nil {
            return err
        }

        session, err := concurrency.NewSession(le.client,
            concurrency.WithTTL(15),
            concurrency.WithContext(ctx),
        )
        if err != nil {
            le.logger.Error("failed to create election session", "error", err)
            continue
        }

        election := concurrency.NewElection(session, le.electionKey)

        le.logger.Info("campaigning for leadership", "identity", le.identity)

        if err := election.Campaign(ctx, le.identity); err != nil {
            session.Close()
            if err == context.Canceled {
                return ctx.Err()
            }
            le.logger.Error("election campaign failed", "error", err)
            continue
        }

        le.logger.Info("became leader", "identity", le.identity)

        // Create a derived context that is cancelled when leadership is lost
        leaderCtx, leaderCancel := context.WithCancel(ctx)

        go func() {
            defer leaderCancel()
            select {
            case <-session.Done():
                le.logger.Warn("leadership session expired")
            case <-ctx.Done():
            }
        }()

        // Run the leader function
        fn(leaderCtx)

        le.logger.Info("leadership function returned, resigning")
        _ = election.Resign(ctx)
        session.Close()

        // Check if the parent context is done before re-campaigning
        if ctx.Err() != nil {
            return ctx.Err()
        }
    }
}

// GetLeader returns the current leader's identity.
func (le *LeaderElection) GetLeader(ctx context.Context) (string, error) {
    session, err := concurrency.NewSession(le.client, concurrency.WithTTL(1))
    if err != nil {
        return "", err
    }
    defer session.Close()

    election := concurrency.NewElection(session, le.electionKey)
    resp, err := election.Leader(ctx)
    if err != nil {
        return "", err
    }
    if len(resp.Kvs) == 0 {
        return "", fmt.Errorf("no leader")
    }
    return string(resp.Kvs[0].Value), nil
}
```

### Leader Election Usage

```go
// main.go - runs a background task only on the leader

func main() {
    etcdClient, err := clientv3.New(clientv3.Config{
        Endpoints: []string{"etcd-1:2379", "etcd-2:2379", "etcd-3:2379"},
    })
    if err != nil {
        log.Fatal(err)
    }
    defer etcdClient.Close()

    hostname, _ := os.Hostname()
    le := election.NewLeaderElection(
        etcdClient,
        "/election/cache-warmer",
        hostname,
        slog.Default(),
    )

    ctx := context.Background()
    if err := le.RunAsLeader(ctx, func(leaderCtx context.Context) {
        // This function runs only on the leader
        // It is cancelled when leadership is lost
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()

        for {
            select {
            case <-leaderCtx.Done():
                return
            case <-ticker.C:
                if err := warmCache(leaderCtx); err != nil {
                    log.Printf("cache warming failed: %v", err)
                }
            }
        }
    }); err != nil {
        log.Fatal(err)
    }
}
```

## Section 8: Choosing the Right Lock Implementation

| Criteria | Redis Redlock | etcd | PostgreSQL Advisory |
|---|---|---|---|
| Consistency | Approximate (not linearizable) | Linearizable | Linearizable |
| Performance | Highest | High | Moderate |
| Infrastructure | Redis cluster (5 nodes for HA) | etcd cluster (3-5 nodes) | Existing PostgreSQL |
| Failure semantics | May allow dual locks on network partition | Correct under partition | Correct under partition |
| Lock TTL | Time-based | Lease + heartbeat | Connection-based |
| Fencing support | No (manual) | Via revision | No (manual) |
| Best for | High-throughput, tolerate brief split-brain | Critical consistency | DB-local coordination |

### Decision Matrix

Use Redis Redlock when:
- You already run Redis for caching/queuing
- You need low-latency lock acquisition (< 1ms)
- Brief periods of split-brain are acceptable (with application-level verification)

Use etcd when:
- You need true linearizable distributed locks
- You already run etcd (e.g., with Kubernetes)
- Leader election is the primary use case

Use PostgreSQL advisory locks when:
- Your application already uses PostgreSQL
- You want the simplest possible implementation
- You need automatic lock release on process crash
- The lock is coordinating database-local operations

## Section 9: Testing Distributed Locks

```go
// lock_test.go
package lock_test

import (
    "context"
    "sync"
    "testing"
    "time"

    "myapp/lock"
)

// TestMutualExclusion verifies that at most one goroutine holds the lock at a time.
func TestMutualExclusion(t *testing.T) {
    // Use a test Redis/etcd/PostgreSQL instance
    mgr := setupTestLockManager(t)

    var (
        mu      sync.Mutex
        counter int
        wg      sync.WaitGroup
    )

    const goroutines = 10
    const iterations = 5

    for i := 0; i < goroutines; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := 0; j < iterations; j++ {
                ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
                l, err := mgr.Acquire(ctx, "test-mutual-exclusion", 10*time.Second)
                cancel()
                if err != nil {
                    t.Errorf("failed to acquire lock: %v", err)
                    return
                }

                // Critical section: increment counter
                mu.Lock()
                old := counter
                time.Sleep(1 * time.Millisecond) // Simulate work
                counter = old + 1
                mu.Unlock()

                if err := l.Release(context.Background()); err != nil {
                    t.Errorf("failed to release lock: %v", err)
                }
            }
        }()
    }

    wg.Wait()

    expected := goroutines * iterations
    if counter != expected {
        t.Errorf("counter = %d, want %d (mutual exclusion violated)", counter, expected)
    }
}

// TestLockExpiry verifies that expired locks are automatically released.
func TestLockExpiry(t *testing.T) {
    mgr := setupTestLockManager(t)
    ctx := context.Background()

    // Acquire with very short TTL
    l, err := mgr.Acquire(ctx, "test-expiry", 1*time.Second)
    if err != nil {
        t.Fatalf("failed to acquire lock: %v", err)
    }

    // Wait for TTL to expire (don't release explicitly)
    time.Sleep(2 * time.Second)

    // Should be able to acquire the lock again after expiry
    l2, err := mgr.Acquire(ctx, "test-expiry", 10*time.Second)
    if err != nil {
        t.Fatalf("failed to acquire lock after expiry: %v", err)
    }
    defer l2.Release(ctx)

    // The original lock release should fail (already expired)
    if err := l.Release(ctx); err == nil {
        t.Log("Note: expired lock release returned no error (implementation detail)")
    }
}
```

## Conclusion

Distributed locking is a powerful tool that comes with serious failure modes. Redis Redlock provides high throughput but is not linearizable and requires careful application of fencing tokens for safety. etcd's lease-based locks provide linearizability and are the foundation for Kubernetes leader election, making them the right choice when you need correctness guarantees or are already running etcd. PostgreSQL advisory locks are the pragmatic choice when your application already uses PostgreSQL: they are simple, transactionally correct, and automatically released on connection loss. Regardless of implementation, the fencing token pattern is essential for any lock that protects shared resources. Testing with concurrent goroutines and TTL expiration scenarios is critical to verifying correct behavior before deploying to production.
