---
title: "Go Distributed Locks: Redis SETNX vs Redlock, etcd Leader Election, Database Advisory Locks, and Fencing Tokens"
date: 2032-02-20T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Redis", "etcd", "Locking", "Concurrency"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to distributed locking in Go covering Redis SETNX single-node locks, the Redlock algorithm across multiple Redis instances, etcd-based leader election, PostgreSQL advisory locks, and fencing tokens to prevent split-brain races."
more_link: "yes"
url: "/go-distributed-locks-redis-redlock-etcd-database-fencing-enterprise-guide/"
---

Distributed locks coordinate exclusive access to shared resources across multiple processes or hosts. In Go, the most common implementations use Redis, etcd, or database advisory locks. Each has different safety guarantees, performance profiles, and failure modes. This guide covers every approach in depth, explains the fencing token pattern for preventing silent data corruption after lock expiry, and provides production-ready Go implementations.

<!--more-->

# Go Distributed Locks: From SETNX to etcd Leader Election

## Section 1: Why Distributed Locks Are Hard

A distributed lock must satisfy three properties (Lamport 1978, adapted):
1. **Mutual exclusion**: at most one holder at any time
2. **Deadlock freedom**: if all lock holders crash, the lock is eventually released
3. **Progress**: a live process can eventually acquire the lock

The difficulty: clocks skew, processes pause (GC, swap, `SIGSTOP`), and networks partition. A process holding a lock can be paused for longer than the lock's TTL — when it resumes, it believes it holds the lock, but the lock has expired and another process has taken it. Both now believe they hold the lock.

**Fencing tokens** solve this: each lock acquisition returns a monotonically increasing token. Protected resources reject operations with old tokens.

## Section 2: Redis SETNX — Single-Node Distributed Lock

### The Correct Pattern: SET NX PX

The classic `SETNX` + `EXPIRE` two-command pattern is broken (non-atomic). The correct approach uses `SET key value NX PX ttl`, which is atomic.

```go
// lock/redis.go
package lock

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// ErrNotAcquired is returned when the lock could not be acquired.
var ErrNotAcquired = errors.New("lock: not acquired")

// ErrNotOwner is returned when trying to release a lock you don't own.
var ErrNotOwner = errors.New("lock: not owner")

// RedisLock is a single-node Redis distributed lock.
type RedisLock struct {
    client *redis.Client
    key    string
    value  string   // random token to prevent accidental release
    ttl    time.Duration
}

// NewRedisLock creates a lock for the given key.
func NewRedisLock(client *redis.Client, key string, ttl time.Duration) *RedisLock {
    return &RedisLock{
        client: client,
        key:    "lock:" + key,
        ttl:    ttl,
    }
}

// TryAcquire attempts to acquire the lock without waiting.
// Returns ErrNotAcquired if the lock is held by another process.
func (l *RedisLock) TryAcquire(ctx context.Context) error {
    value, err := randomToken()
    if err != nil {
        return fmt.Errorf("generate lock token: %w", err)
    }

    ok, err := l.client.SetNX(ctx, l.key, value, l.ttl).Result()
    if err != nil {
        return fmt.Errorf("redis SETNX: %w", err)
    }
    if !ok {
        return ErrNotAcquired
    }

    l.value = value
    return nil
}

// Acquire acquires the lock, retrying until ctx is cancelled.
func (l *RedisLock) Acquire(ctx context.Context, retryInterval time.Duration) error {
    for {
        err := l.TryAcquire(ctx)
        if err == nil {
            return nil
        }
        if !errors.Is(err, ErrNotAcquired) {
            return err
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(retryInterval):
        }
    }
}

// Release releases the lock using a Lua script for atomicity.
// The Lua script ensures we only delete the key if we own it (value matches).
func (l *RedisLock) Release(ctx context.Context) error {
    if l.value == "" {
        return ErrNotOwner
    }

    // Atomic check-and-delete via Lua
    script := redis.NewScript(`
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        else
            return 0
        end
    `)

    result, err := script.Run(ctx, l.client, []string{l.key}, l.value).Int()
    if err != nil {
        return fmt.Errorf("redis release script: %w", err)
    }
    if result == 0 {
        return ErrNotOwner
    }

    l.value = ""
    return nil
}

// Extend renews the lock TTL if we still own it.
func (l *RedisLock) Extend(ctx context.Context, extension time.Duration) error {
    if l.value == "" {
        return ErrNotOwner
    }

    script := redis.NewScript(`
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("PEXPIRE", KEYS[1], ARGV[2])
        else
            return 0
        end
    `)

    ttlMs := int64(extension / time.Millisecond)
    result, err := script.Run(ctx, l.client, []string{l.key}, l.value, ttlMs).Int()
    if err != nil {
        return fmt.Errorf("redis extend script: %w", err)
    }
    if result == 0 {
        return ErrNotOwner
    }
    return nil
}

func randomToken() (string, error) {
    b := make([]byte, 24)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return base64.RawURLEncoding.EncodeToString(b), nil
}
```

### Usage Pattern with Auto-Release

```go
func processJob(ctx context.Context, client *redis.Client, jobID string) error {
    l := lock.NewRedisLock(client, "job:"+jobID, 30*time.Second)

    // Try to acquire; fail fast if another worker is processing this job
    if err := l.TryAcquire(ctx); err != nil {
        if errors.Is(err, lock.ErrNotAcquired) {
            return fmt.Errorf("job %s is already being processed", jobID)
        }
        return fmt.Errorf("acquire lock: %w", err)
    }
    defer func() {
        if err := l.Release(context.Background()); err != nil {
            slog.Error("failed to release lock", "jobID", jobID, "error", err)
        }
    }()

    // Extend the lock periodically while processing long jobs
    extendCtx, cancelExtend := context.WithCancel(ctx)
    defer cancelExtend()

    go func() {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                if err := l.Extend(extendCtx, 30*time.Second); err != nil {
                    slog.Warn("failed to extend lock", "jobID", jobID, "error", err)
                }
            case <-extendCtx.Done():
                return
            }
        }
    }()

    // Do the actual work
    return doWork(ctx, jobID)
}
```

## Section 3: Redlock — Multi-Node Redis Lock

The Redlock algorithm (Antirez 2016) acquires a lock across N independent Redis instances. A quorum (N/2 + 1) must confirm acquisition within the lock's TTL minus a drift factor. This provides safety even if a minority of Redis nodes fail.

```go
// lock/redlock.go
package lock

import (
    "context"
    "errors"
    "fmt"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedlockConfig controls Redlock behavior.
type RedlockConfig struct {
    // TTL is the lock duration.
    TTL time.Duration
    // RetryCount is the number of acquisition attempts.
    RetryCount int
    // RetryDelay between attempts.
    RetryDelay time.Duration
    // ClockDriftFactor as a fraction of TTL (e.g., 0.01 = 1%).
    ClockDriftFactor float64
}

// DefaultRedlockConfig returns safe defaults.
func DefaultRedlockConfig() RedlockConfig {
    return RedlockConfig{
        TTL:              30 * time.Second,
        RetryCount:       3,
        RetryDelay:       200 * time.Millisecond,
        ClockDriftFactor: 0.01,
    }
}

// Redlock implements the Redlock distributed locking algorithm.
type Redlock struct {
    nodes  []*redis.Client
    config RedlockConfig
    key    string
    value  string
}

// NewRedlock creates a Redlock across the given Redis nodes.
// nodes should be independent Redis instances (not a cluster).
func NewRedlock(nodes []*redis.Client, key string, cfg RedlockConfig) *Redlock {
    return &Redlock{
        nodes:  nodes,
        config: cfg,
        key:    "lock:" + key,
    }
}

// Acquire attempts to acquire the lock across a quorum of nodes.
func (r *Redlock) Acquire(ctx context.Context) error {
    for attempt := 0; attempt < r.config.RetryCount; attempt++ {
        if attempt > 0 {
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(r.config.RetryDelay):
            }
        }

        value, err := randomToken()
        if err != nil {
            return fmt.Errorf("generate token: %w", err)
        }

        start := time.Now()
        acquired := r.acquireOnNodes(ctx, value)
        elapsed := time.Since(start)

        // Clock drift allowance
        drift := time.Duration(float64(r.config.TTL) * r.config.ClockDriftFactor)
        validityTime := r.config.TTL - elapsed - drift

        quorum := len(r.nodes)/2 + 1
        if acquired >= quorum && validityTime > 0 {
            r.value = value
            return nil
        }

        // Not acquired: release on all nodes we did acquire
        r.releaseOnNodes(context.Background(), value)
    }

    return ErrNotAcquired
}

func (r *Redlock) acquireOnNodes(ctx context.Context, value string) int {
    var (
        mu       sync.Mutex
        acquired int
        wg       sync.WaitGroup
    )

    for _, node := range r.nodes {
        wg.Add(1)
        go func(n *redis.Client) {
            defer wg.Done()
            // Short timeout per node to avoid blocking the quorum check
            nodeCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
            defer cancel()

            ok, err := n.SetNX(nodeCtx, r.key, value, r.config.TTL).Result()
            if err == nil && ok {
                mu.Lock()
                acquired++
                mu.Unlock()
            }
        }(node)
    }

    wg.Wait()
    return acquired
}

// Release releases the lock on all nodes.
func (r *Redlock) Release(ctx context.Context) error {
    if r.value == "" {
        return ErrNotOwner
    }
    r.releaseOnNodes(ctx, r.value)
    r.value = ""
    return nil
}

func (r *Redlock) releaseOnNodes(ctx context.Context, value string) {
    script := redis.NewScript(`
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        else
            return 0
        end
    `)

    var wg sync.WaitGroup
    for _, node := range r.nodes {
        wg.Add(1)
        go func(n *redis.Client) {
            defer wg.Done()
            nodeCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
            defer cancel()
            script.Run(nodeCtx, n, []string{r.key}, value)
        }(node)
    }
    wg.Wait()
}
```

### Redlock Usage

```go
func main() {
    // Five independent Redis instances
    nodes := []*redis.Client{
        redis.NewClient(&redis.Options{Addr: "redis1:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis2:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis3:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis4:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis5:6379"}),
    }

    cfg := lock.DefaultRedlockConfig()
    cfg.TTL = 30 * time.Second

    rl := lock.NewRedlock(nodes, "critical-section", cfg)

    ctx := context.Background()
    if err := rl.Acquire(ctx); err != nil {
        log.Fatalf("acquire redlock: %v", err)
    }
    defer rl.Release(ctx)

    // Critical section
    fmt.Println("I have the distributed lock")
}
```

## Section 4: etcd Leader Election

etcd provides lease-based leader election with strong consistency guarantees backed by the Raft consensus algorithm. This is the correct choice for leader election in Kubernetes controllers and other critical infrastructure.

```go
// election/etcd.go
package election

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// LeaderCallbacks contains callbacks for leader state changes.
type LeaderCallbacks struct {
    // OnStartedLeading is called when this instance becomes leader.
    // It should run until ctx is cancelled.
    OnStartedLeading func(ctx context.Context)
    // OnStoppedLeading is called when this instance loses leadership.
    OnStoppedLeading func()
    // OnNewLeader is called when any leader is elected (including self).
    OnNewLeader func(identity string)
}

// Elector runs a leader election campaign using etcd.
type Elector struct {
    client      *clientv3.Client
    prefix      string   // etcd key prefix for this election
    identity    string   // unique identity for this candidate
    leaseTTL    int      // seconds
    callbacks   LeaderCallbacks
    logger      *slog.Logger
}

// NewElector creates an Elector.
func NewElector(
    client *clientv3.Client,
    prefix string,
    identity string,
    leaseTTL int,
    callbacks LeaderCallbacks,
) *Elector {
    return &Elector{
        client:    client,
        prefix:    prefix,
        identity:  identity,
        leaseTTL:  leaseTTL,
        callbacks: callbacks,
        logger:    slog.Default(),
    }
}

// Run starts the election loop. It blocks until ctx is cancelled.
func (e *Elector) Run(ctx context.Context) error {
    for {
        if err := e.runOnce(ctx); err != nil {
            if ctx.Err() != nil {
                return ctx.Err()
            }
            e.logger.Error("election error, retrying", "error", err)
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(5 * time.Second):
            }
        }
    }
}

func (e *Elector) runOnce(ctx context.Context) error {
    // Create a session (lease) with TTL
    sess, err := concurrency.NewSession(e.client,
        concurrency.WithTTL(e.leaseTTL),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return fmt.Errorf("create session: %w", err)
    }
    defer sess.Close()

    election := concurrency.NewElection(sess, e.prefix)

    // Run the campaign. This blocks until we become leader or ctx is cancelled.
    e.logger.Info("starting election campaign", "identity", e.identity)
    if err := election.Campaign(ctx, e.identity); err != nil {
        return fmt.Errorf("campaign: %w", err)
    }

    e.logger.Info("became leader", "identity", e.identity)

    // Notify callback
    if e.callbacks.OnNewLeader != nil {
        e.callbacks.OnNewLeader(e.identity)
    }

    // Run leader work in a goroutine with a cancellable context
    leaderCtx, cancelLeader := context.WithCancel(ctx)
    defer cancelLeader()

    done := make(chan struct{})
    go func() {
        defer close(done)
        if e.callbacks.OnStartedLeading != nil {
            e.callbacks.OnStartedLeading(leaderCtx)
        }
    }()

    // Watch for leadership loss
    observeCh := election.Observe(ctx)
    for resp := range observeCh {
        if string(resp.Kvs[0].Value) != e.identity {
            e.logger.Warn("lost leadership", "new_leader", string(resp.Kvs[0].Value))
            cancelLeader()
            break
        }
    }

    // Wait for leader work to finish
    <-done

    if e.callbacks.OnStoppedLeading != nil {
        e.callbacks.OnStoppedLeading()
    }

    // Resign
    resignCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := election.Resign(resignCtx); err != nil {
        e.logger.Warn("resign failed", "error", err)
    }

    return nil
}

// CurrentLeader returns the current leader's identity.
func (e *Elector) CurrentLeader(ctx context.Context) (string, error) {
    sess, err := concurrency.NewSession(e.client, concurrency.WithTTL(e.leaseTTL))
    if err != nil {
        return "", fmt.Errorf("create session: %w", err)
    }
    defer sess.Close()

    election := concurrency.NewElection(sess, e.prefix)
    resp, err := election.Leader(ctx)
    if err != nil {
        return "", fmt.Errorf("get leader: %w", err)
    }

    if len(resp.Kvs) == 0 {
        return "", nil
    }
    return string(resp.Kvs[0].Value), nil
}
```

### etcd Leader Election Usage

```go
func main() {
    cli, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"etcd1:2379", "etcd2:2379", "etcd3:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        log.Fatal(err)
    }
    defer cli.Close()

    hostname, _ := os.Hostname()

    elector := election.NewElector(
        cli,
        "/myapp/leader",
        hostname,
        15, // 15-second TTL
        election.LeaderCallbacks{
            OnStartedLeading: func(ctx context.Context) {
                slog.Info("started leading — beginning work")
                runLeaderWork(ctx)
            },
            OnStoppedLeading: func() {
                slog.Info("stopped leading")
            },
            OnNewLeader: func(identity string) {
                slog.Info("new leader elected", "leader", identity)
            },
        },
    )

    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
    defer stop()

    if err := elector.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
        log.Fatal(err)
    }
}

func runLeaderWork(ctx context.Context) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            slog.Info("leader heartbeat")
            // Do leader-only work
        }
    }
}
```

## Section 5: PostgreSQL Advisory Locks

PostgreSQL's advisory lock mechanism provides distributed locking backed by ACID-compliant PostgreSQL. Advisory locks are session-scoped or transaction-scoped and are automatically released when the session ends.

```go
// lock/pgadvisory.go
package lock

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
    "hash/fnv"

    _ "github.com/lib/pq"
)

// PGAdvisoryLock uses PostgreSQL advisory locks.
type PGAdvisoryLock struct {
    db     *sql.DB
    lockID int64   // 64-bit key derived from the lock name
    conn   *sql.Conn  // single connection for session-scoped locks
}

// NewPGAdvisoryLock creates a lock for the given key.
// The key is hashed to a 64-bit integer for the advisory lock.
func NewPGAdvisoryLock(db *sql.DB, key string) *PGAdvisoryLock {
    return &PGAdvisoryLock{
        db:     db,
        lockID: keyToLockID(key),
    }
}

// keyToLockID converts a string key to a stable int64 for pg_try_advisory_lock.
func keyToLockID(key string) int64 {
    h := fnv.New64a()
    h.Write([]byte(key))
    // Use the signed int64 representation
    return int64(h.Sum64())
}

// TryLock attempts a non-blocking advisory lock.
// Returns ErrNotAcquired if another session holds the lock.
func (l *PGAdvisoryLock) TryLock(ctx context.Context) error {
    conn, err := l.db.Conn(ctx)
    if err != nil {
        return fmt.Errorf("get db connection: %w", err)
    }

    var acquired bool
    err = conn.QueryRowContext(ctx,
        "SELECT pg_try_advisory_lock($1)", l.lockID,
    ).Scan(&acquired)
    if err != nil {
        conn.Close()
        return fmt.Errorf("pg_try_advisory_lock: %w", err)
    }

    if !acquired {
        conn.Close()
        return ErrNotAcquired
    }

    l.conn = conn
    return nil
}

// Lock acquires the advisory lock, blocking until acquired or ctx cancelled.
func (l *PGAdvisoryLock) Lock(ctx context.Context) error {
    conn, err := l.db.Conn(ctx)
    if err != nil {
        return fmt.Errorf("get db connection: %w", err)
    }

    // pg_advisory_lock blocks at the DB level until acquired
    _, err = conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", l.lockID)
    if err != nil {
        conn.Close()
        if ctx.Err() != nil {
            return ctx.Err()
        }
        return fmt.Errorf("pg_advisory_lock: %w", err)
    }

    l.conn = conn
    return nil
}

// Unlock releases the advisory lock and returns the connection to the pool.
func (l *PGAdvisoryLock) Unlock(ctx context.Context) error {
    if l.conn == nil {
        return errors.New("lock: not held")
    }

    _, err := l.conn.ExecContext(ctx,
        "SELECT pg_advisory_unlock($1)", l.lockID,
    )
    l.conn.Close()
    l.conn = nil
    if err != nil {
        return fmt.Errorf("pg_advisory_unlock: %w", err)
    }
    return nil
}

// TryTransactionLock acquires a transaction-scoped advisory lock.
// Released automatically when tx commits or rolls back.
func TryTransactionLock(ctx context.Context, tx *sql.Tx, key string) (bool, error) {
    lockID := keyToLockID(key)
    var acquired bool
    err := tx.QueryRowContext(ctx,
        "SELECT pg_try_advisory_xact_lock($1)", lockID,
    ).Scan(&acquired)
    return acquired, err
}
```

### PostgreSQL Advisory Lock Usage

```go
func processBatchWithAdvisoryLock(ctx context.Context, db *sql.DB, batchID string) error {
    l := lock.NewPGAdvisoryLock(db, "batch:"+batchID)

    if err := l.TryLock(ctx); err != nil {
        if errors.Is(err, lock.ErrNotAcquired) {
            return fmt.Errorf("batch %s already being processed", batchID)
        }
        return err
    }
    defer l.Unlock(context.Background())

    return processBatch(ctx, db, batchID)
}

// Transaction-scoped: lock is released when the transaction ends
func atomicUpdateWithLock(ctx context.Context, db *sql.DB, resourceID string) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    acquired, err := lock.TryTransactionLock(ctx, tx, "resource:"+resourceID)
    if err != nil {
        return err
    }
    if !acquired {
        return fmt.Errorf("resource %s is locked by another transaction", resourceID)
    }

    // Perform updates — lock released when tx commits or rolls back
    if _, err := tx.ExecContext(ctx,
        "UPDATE resources SET status = $1 WHERE id = $2",
        "processing", resourceID,
    ); err != nil {
        return err
    }

    return tx.Commit()
}
```

## Section 6: Fencing Tokens — Preventing Stale Lock Holders

The core problem: a process holds a lock, pauses (GC, OS scheduling), the lock expires, another process acquires it, the first process resumes and still believes it holds the lock.

```
Time 0: Process A acquires lock, gets token=1
Time 5: Process A pauses (GC, network timeout)
Time 10: Lock expires
Time 11: Process B acquires lock, gets token=2
Time 12: Process B writes to storage with token=2
Time 13: Process A resumes, writes to storage with token=1  ← REJECTED
```

### Implementing Fencing Tokens with etcd

etcd's revision counter provides a natural fencing token:

```go
// fencing/etcd.go
package fencing

import (
    "context"
    "fmt"
    "log/slog"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// FencedLock wraps etcd lock with fencing token support.
type FencedLock struct {
    sess    *concurrency.Session
    mutex   *concurrency.Mutex
    lockRev int64   // etcd revision at lock acquisition — the fencing token
}

// NewFencedLock creates a fenced lock.
func NewFencedLock(client *clientv3.Client, prefix string, ttl int) (*FencedLock, error) {
    sess, err := concurrency.NewSession(client, concurrency.WithTTL(ttl))
    if err != nil {
        return nil, fmt.Errorf("create session: %w", err)
    }
    return &FencedLock{
        sess:  sess,
        mutex: concurrency.NewMutex(sess, prefix),
    }, nil
}

// Lock acquires the lock and returns the fencing token (etcd revision).
func (f *FencedLock) Lock(ctx context.Context) (int64, error) {
    if err := f.mutex.Lock(ctx); err != nil {
        return 0, fmt.Errorf("mutex lock: %w", err)
    }

    // The fencing token is the etcd revision at the time of lock acquisition
    f.lockRev = f.mutex.Header().Revision
    slog.Debug("lock acquired", "fencing_token", f.lockRev)
    return f.lockRev, nil
}

// Unlock releases the lock.
func (f *FencedLock) Unlock(ctx context.Context) error {
    if err := f.mutex.Unlock(ctx); err != nil {
        return fmt.Errorf("mutex unlock: %w", err)
    }
    f.sess.Close()
    return nil
}
```

### Storage with Fencing Token Enforcement

```go
// storage/fenced.go
package storage

import (
    "context"
    "database/sql"
    "fmt"
)

// FencedStore is a storage layer that enforces fencing tokens.
type FencedStore struct {
    db *sql.DB
}

// Write writes data only if the provided fencing token is >= the current stored token.
func (s *FencedStore) Write(ctx context.Context, key string, value []byte, token int64) error {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("begin tx: %w", err)
    }
    defer tx.Rollback()

    // Read current fencing token for this key
    var currentToken int64
    err = tx.QueryRowContext(ctx,
        "SELECT fencing_token FROM kv_store WHERE key = $1 FOR UPDATE",
        key,
    ).Scan(&currentToken)

    if err != nil && err != sql.ErrNoRows {
        return fmt.Errorf("read current token: %w", err)
    }

    if token < currentToken {
        return fmt.Errorf("stale write rejected: token %d < current %d (another writer superseded us)", token, currentToken)
    }

    // Upsert with the new fencing token
    _, err = tx.ExecContext(ctx, `
        INSERT INTO kv_store (key, value, fencing_token, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            fencing_token = EXCLUDED.fencing_token,
            updated_at = NOW()
        WHERE kv_store.fencing_token < EXCLUDED.fencing_token
    `, key, value, token)
    if err != nil {
        return fmt.Errorf("upsert: %w", err)
    }

    return tx.Commit()
}
```

## Section 7: Choosing the Right Implementation

| Scenario | Recommended Approach |
|---|---|
| Single Redis node, best-effort lock | Redis SETNX + Lua release |
| Critical section, Redis HA cluster | Redlock (5 nodes) |
| Kubernetes controller leader election | etcd via client-go or concurrency pkg |
| Leader election co-located with DB | PostgreSQL advisory lock |
| Must guarantee no split-brain | etcd + fencing tokens |
| Max throughput, can tolerate occasional collisions | Redis SETNX |

### Decision Matrix

```
Is your data store etcd or you have etcd available?
  └─ Yes → Use etcd leader election (strongest guarantee)

Is mutual exclusion safety-critical (data integrity)?
  └─ Yes → Add fencing tokens regardless of backend

Do you have 5+ independent Redis instances?
  └─ Yes → Redlock for multi-node safety
  └─ No → Single Redis (accept minority failure risk) OR use etcd

Is PostgreSQL your primary data store?
  └─ Yes → Advisory locks eliminate a separate lock service
```

## Section 8: Testing Distributed Locks

```go
// lock_test.go
package lock_test

import (
    "context"
    "sync"
    "testing"
    "time"

    "github.com/redis/go-redis/v9"
    "example.com/myapp/lock"
)

func TestMutualExclusion(t *testing.T) {
    client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
    defer client.Close()

    key := fmt.Sprintf("test-lock-%d", time.Now().UnixNano())
    lockHeld := 0
    var mu sync.Mutex

    const goroutines = 20
    errs := make(chan error, goroutines)
    var wg sync.WaitGroup

    for i := 0; i < goroutines; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()

            l := lock.NewRedisLock(client, key, 5*time.Second)
            ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
            defer cancel()

            if err := l.Acquire(ctx, 50*time.Millisecond); err != nil {
                errs <- err
                return
            }

            // Check mutual exclusion
            mu.Lock()
            if lockHeld != 0 {
                errs <- fmt.Errorf("mutual exclusion violated: %d holders", lockHeld+1)
            }
            lockHeld++
            mu.Unlock()

            // Hold lock briefly
            time.Sleep(10 * time.Millisecond)

            mu.Lock()
            lockHeld--
            mu.Unlock()

            if err := l.Release(ctx); err != nil {
                errs <- err
            }
        }()
    }

    wg.Wait()
    close(errs)

    for err := range errs {
        t.Errorf("goroutine error: %v", err)
    }
}

func TestReleaseByNonOwner(t *testing.T) {
    client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
    defer client.Close()

    key := fmt.Sprintf("test-lock-%d", time.Now().UnixNano())

    l1 := lock.NewRedisLock(client, key, 5*time.Second)
    l2 := lock.NewRedisLock(client, key, 5*time.Second)

    ctx := context.Background()
    if err := l1.TryAcquire(ctx); err != nil {
        t.Fatalf("l1 acquire: %v", err)
    }

    // l2 should not be able to release l1's lock
    if err := l2.Release(ctx); !errors.Is(err, lock.ErrNotOwner) {
        t.Errorf("expected ErrNotOwner, got %v", err)
    }

    l1.Release(ctx)
}

func TestLockExpiry(t *testing.T) {
    client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
    defer client.Close()

    key := fmt.Sprintf("test-lock-%d", time.Now().UnixNano())
    // Short TTL for testing
    l := lock.NewRedisLock(client, key, 500*time.Millisecond)

    ctx := context.Background()
    if err := l.TryAcquire(ctx); err != nil {
        t.Fatalf("acquire: %v", err)
    }

    // Wait for TTL to expire
    time.Sleep(1 * time.Second)

    // Another lock should now be acquirable
    l2 := lock.NewRedisLock(client, key, 5*time.Second)
    if err := l2.TryAcquire(ctx); err != nil {
        t.Errorf("expected to acquire after expiry, got: %v", err)
    }
    l2.Release(ctx)
}
```

## Summary

Distributed locks in Go span a spectrum of complexity and safety guarantees:

- **Redis SETNX** with atomic Lua release is correct for single-node Redis but offers no safety if the Redis node fails mid-operation
- **Redlock** provides quorum-based safety across N Redis nodes but requires exactly N independent instances and careful clock drift handling — Martin Kleppmann's critique of Redlock remains relevant for systems that cannot tolerate any period of dual ownership
- **etcd leader election** via the `concurrency` package is the strongest option: it uses Raft for linearizable writes and session TTLs for automatic cleanup
- **PostgreSQL advisory locks** are ideal when PostgreSQL is already your persistence layer — transaction-scoped advisory locks release automatically even on unexpected disconnect
- **Fencing tokens** are essential whenever the lock TTL might expire while the holder is paused — the protected resource must reject operations with tokens older than the latest observed

For production Go services, the pattern that eliminates the most error classes is: etcd session-based lock + fencing tokens stored in the protected resource's data model.
