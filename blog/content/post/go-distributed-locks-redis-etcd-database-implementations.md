---
title: "Go Distributed Locks: Redis, etcd, and Database-Based Implementations"
date: 2029-07-14T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Distributed Systems", "Redis", "etcd", "PostgreSQL", "Distributed Locks", "Concurrency"]
categories: ["Go", "Distributed Systems", "Databases"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Implementing distributed locks in Go: Redis SETNX and Redlock algorithm, etcd distributed locks with lease-based TTL, PostgreSQL advisory locks, lock expiry and renewal patterns, and fencing tokens for split-brain prevention."
more_link: "yes"
url: "/go-distributed-locks-redis-etcd-database-implementations/"
---

Distributed locks solve a fundamental problem in distributed systems: ensuring that only one process across multiple machines executes a critical section at a time. Unlike single-process mutexes, distributed locks must handle network partitions, process crashes, and clock skew. This guide implements production-grade distributed locks using three backends—Redis, etcd, and PostgreSQL—with proper expiry, renewal, and fencing token support.

<!--more-->

# Go Distributed Locks: Redis, etcd, and Database-Based Implementations

## Why Distributed Locks Are Hard

Before implementing, understand the failure modes that make distributed locks difficult:

```
Problem 1: Lock holder crashes
  Process A acquires lock (TTL: 30s)
  Process A crashes at t=5s
  Lock expires at t=35s
  Process B can acquire at t=35s
  → 30 second delay is acceptable, but state may be inconsistent

Problem 2: GC pause / long operation
  Process A acquires lock (TTL: 30s)
  Process A pauses for GC at t=25s
  Lock expires at t=30s
  Process B acquires lock at t=31s
  Both A and B now believe they hold the lock → SPLIT BRAIN

Problem 3: Network partition
  Process A acquires lock on Redis primary
  Network partition isolates Redis primary
  Redis sentinel promotes replica
  Process B acquires lock on new primary
  Both A and B believe they hold the lock → SPLIT BRAIN

Solution: Fencing tokens
  Every lock grant includes a monotonically increasing token
  All protected operations include the token
  The storage system rejects operations with older tokens
```

## The DistributedLock Interface

Define a common interface before implementing backends:

```go
package distlock

import (
    "context"
    "errors"
    "time"
)

var (
    ErrLockNotAcquired = errors.New("lock not acquired: already held")
    ErrLockExpired     = errors.New("lock expired during operation")
    ErrLockNotHeld     = errors.New("cannot release: lock not held by this token")
)

// Lock represents a held distributed lock
type Lock interface {
    // Token returns the fencing token for this lock grant
    // Monotonically increasing, used to detect stale lock holders
    Token() int64

    // Refresh extends the lock TTL, preventing expiry during long operations
    Refresh(ctx context.Context) error

    // Release releases the lock
    // Returns ErrLockNotHeld if the lock has expired or been stolen
    Release(ctx context.Context) error
}

// Locker acquires distributed locks
type Locker interface {
    // TryLock attempts to acquire the lock, returning immediately if unavailable
    TryLock(ctx context.Context, key string, ttl time.Duration) (Lock, error)

    // Lock blocks until the lock is acquired or the context is cancelled
    Lock(ctx context.Context, key string, ttl time.Duration) (Lock, error)
}

// WithLock is a helper that acquires a lock, runs fn, and releases the lock
func WithLock(ctx context.Context, locker Locker, key string, ttl time.Duration, fn func(ctx context.Context, token int64) error) error {
    lock, err := locker.Lock(ctx, key, ttl)
    if err != nil {
        return fmt.Errorf("acquiring lock %q: %w", key, err)
    }
    defer func() {
        releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := lock.Release(releaseCtx); err != nil {
            // Log but don't return: the function already completed
        }
    }()

    // Pass the fencing token to the protected function
    return fn(ctx, lock.Token())
}
```

## Redis-Based Lock: SETNX Implementation

The simplest Redis lock uses `SET key value NX PX ttl`:

```go
package redislock

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// Single-node Redis lock (not fault tolerant, but sufficient for many use cases)
type RedisLock struct {
    client    *redis.Client
    key       string
    value     string  // Unique per-lock-acquisition, prevents accidental release
    ttl       time.Duration
    token     int64
    acquired  time.Time
}

func (l *RedisLock) Token() int64 { return l.token }

// Release uses a Lua script for atomic check-and-delete
// Prevents releasing a lock held by another process
var releaseScript = redis.NewScript(`
    if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
    else
        return 0
    end
`)

func (l *RedisLock) Release(ctx context.Context) error {
    result, err := releaseScript.Run(ctx, l.client, []string{l.key}, l.value).Int()
    if err != nil {
        return fmt.Errorf("release script error: %w", err)
    }
    if result == 0 {
        return ErrLockNotHeld
    }
    return nil
}

// Refresh uses atomic check-and-extend
var refreshScript = redis.NewScript(`
    if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
    else
        return 0
    end
`)

func (l *RedisLock) Refresh(ctx context.Context) error {
    ttlMs := l.ttl.Milliseconds()
    result, err := refreshScript.Run(ctx, l.client,
        []string{l.key}, l.value, ttlMs).Int()
    if err != nil {
        return fmt.Errorf("refresh script error: %w", err)
    }
    if result == 0 {
        return ErrLockExpired
    }
    l.acquired = time.Now()
    return nil
}

type RedisLocker struct {
    client *redis.Client
    // fencing token counter stored in Redis
    tokenKey string
}

func NewRedisLocker(client *redis.Client, namespace string) *RedisLocker {
    return &RedisLocker{
        client:   client,
        tokenKey: fmt.Sprintf("lock:token:%s", namespace),
    }
}

func (r *RedisLocker) TryLock(ctx context.Context, key string, ttl time.Duration) (*RedisLock, error) {
    // Generate unique lock value
    b := make([]byte, 16)
    rand.Read(b)
    value := hex.EncodeToString(b)

    // Get fencing token (atomic increment)
    token, err := r.client.Incr(ctx, r.tokenKey).Result()
    if err != nil {
        return nil, fmt.Errorf("getting fencing token: %w", err)
    }

    // Try to set the lock key (NX = only if not exists)
    fullKey := "lock:" + key
    ok, err := r.client.SetNX(ctx, fullKey, value, ttl).Result()
    if err != nil {
        return nil, fmt.Errorf("redis SETNX: %w", err)
    }
    if !ok {
        return nil, ErrLockNotAcquired
    }

    return &RedisLock{
        client:   r.client,
        key:      fullKey,
        value:    value,
        ttl:      ttl,
        token:    token,
        acquired: time.Now(),
    }, nil
}

func (r *RedisLocker) Lock(ctx context.Context, key string, ttl time.Duration) (*RedisLock, error) {
    // Retry with exponential backoff
    backoff := 10 * time.Millisecond
    maxBackoff := 500 * time.Millisecond

    for {
        lock, err := r.TryLock(ctx, key, ttl)
        if err == nil {
            return lock, nil
        }
        if !errors.Is(err, ErrLockNotAcquired) {
            return nil, err
        }

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(backoff):
            backoff *= 2
            if backoff > maxBackoff {
                backoff = maxBackoff
            }
        }
    }
}
```

### Background Lock Renewal

For long-running operations, renew the lock in the background:

```go
// AutoRefresher automatically renews a lock before it expires
type AutoRefresher struct {
    lock     Lock
    interval time.Duration
    cancel   context.CancelFunc
    errCh    chan error
}

func StartAutoRefresh(ctx context.Context, lock Lock, ttl time.Duration) *AutoRefresher {
    // Refresh at 50% of TTL to give ample time before expiry
    interval := ttl / 2
    if interval < time.Second {
        interval = time.Second
    }

    refreshCtx, cancel := context.WithCancel(ctx)
    r := &AutoRefresher{
        lock:     lock,
        interval: interval,
        cancel:   cancel,
        errCh:    make(chan error, 1),
    }

    go r.run(refreshCtx)
    return r
}

func (r *AutoRefresher) run(ctx context.Context) {
    ticker := time.NewTicker(r.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := r.lock.Refresh(ctx); err != nil {
                r.errCh <- err
                return
            }
        }
    }
}

func (r *AutoRefresher) Err() <-chan error {
    return r.errCh
}

func (r *AutoRefresher) Stop() {
    r.cancel()
}

// Usage example
func processWithAutoRenewal(ctx context.Context, locker *RedisLocker) error {
    lock, err := locker.Lock(ctx, "critical-job", 30*time.Second)
    if err != nil {
        return fmt.Errorf("acquiring lock: %w", err)
    }

    refresher := StartAutoRefresh(ctx, lock, 30*time.Second)
    defer refresher.Stop()

    // Process in a goroutine, watch for lock loss
    errCh := make(chan error, 1)
    go func() {
        errCh <- longRunningOperation(ctx, lock.Token())
    }()

    select {
    case err := <-errCh:
        if err != nil {
            lock.Release(ctx)
            return err
        }
    case err := <-refresher.Err():
        // Lock lost during operation
        return fmt.Errorf("lock expired during operation: %w", err)
    }

    return lock.Release(ctx)
}
```

## Redlock Algorithm: Multi-Node Redis

For fault tolerance, Redlock acquires locks on N independent Redis instances:

```go
package redlock

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

const (
    // clockDriftFactor allows for clock drift between nodes (0.01 = 1%)
    clockDriftFactor = 0.01
    // minQuorum is the minimum number of nodes required to acquire the lock
    // N/2 + 1 where N is the number of Redis instances
)

type RedlockLocker struct {
    clients  []*redis.Client
    quorum   int  // N/2 + 1
}

func NewRedlockLocker(clients ...*redis.Client) *RedlockLocker {
    return &RedlockLocker{
        clients: clients,
        quorum:  len(clients)/2 + 1,
    }
}

type RedlockLock struct {
    locker    *RedlockLocker
    key       string
    value     string
    ttl       time.Duration
    token     int64
}

func (l *RedlockLock) Token() int64 { return l.token }

func (r *RedlockLocker) TryLock(ctx context.Context, key string, ttl time.Duration) (*RedlockLock, error) {
    b := make([]byte, 16)
    rand.Read(b)
    value := hex.EncodeToString(b)

    start := time.Now()

    // Try to acquire lock on all N Redis instances concurrently
    type result struct {
        nodeIdx int
        ok      bool
        err     error
    }
    results := make(chan result, len(r.clients))

    for i, client := range r.clients {
        go func(idx int, c *redis.Client) {
            ok, err := c.SetNX(ctx, "lock:"+key, value, ttl).Result()
            results <- result{nodeIdx: idx, ok: ok, err: err}
        }(i, client)
    }

    // Collect results
    acquired := 0
    var acquiredIdx []int
    for range r.clients {
        res := <-results
        if res.err == nil && res.ok {
            acquired++
            acquiredIdx = append(acquiredIdx, res.nodeIdx)
        }
    }

    elapsed := time.Since(start)

    // Calculate drift: clock drift + 2ms for network latency
    drift := time.Duration(float64(ttl)*clockDriftFactor) + 2*time.Millisecond

    // Valid lock time = TTL - elapsed - drift
    validityTime := ttl - elapsed - drift

    if acquired >= r.quorum && validityTime > 0 {
        // Lock acquired on quorum of nodes with enough validity time
        token := time.Now().UnixNano() // Simple token based on time
        return &RedlockLock{
            locker: r,
            key:    key,
            value:  value,
            ttl:    ttl,
            token:  token,
        }, nil
    }

    // Failed to acquire quorum: release any partial acquisitions
    r.releaseOnNodes(ctx, key, value, acquiredIdx)
    return nil, ErrLockNotAcquired
}

var redlockReleaseScript = redis.NewScript(`
    if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
    else
        return 0
    end
`)

func (r *RedlockLocker) releaseOnNodes(ctx context.Context, key, value string, nodeIdx []int) {
    var wg sync.WaitGroup
    for _, idx := range nodeIdx {
        wg.Add(1)
        go func(c *redis.Client) {
            defer wg.Done()
            releaseCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
            defer cancel()
            redlockReleaseScript.Run(releaseCtx, c, []string{"lock:" + key}, value)
        }(r.clients[idx])
    }
    wg.Wait()
}

func (l *RedlockLock) Release(ctx context.Context) error {
    l.locker.releaseOnNodes(ctx, l.key, l.value,
        func() []int {
            idx := make([]int, len(l.locker.clients))
            for i := range idx { idx[i] = i }
            return idx
        }(),
    )
    return nil
}

func (l *RedlockLock) Refresh(ctx context.Context) error {
    // Re-acquire with same value on all nodes
    // Note: Redlock doesn't support refresh natively; this is a simplified approach
    return fmt.Errorf("Redlock refresh not implemented: use short TTLs instead")
}
```

## etcd-Based Distributed Lock

etcd's lease mechanism provides more robust distributed locking with automatic cleanup on client disconnection:

```go
package etcdlock

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// EtcdLocker uses etcd's built-in concurrency package
type EtcdLocker struct {
    client  *clientv3.Client
    prefix  string
}

func NewEtcdLocker(client *clientv3.Client, prefix string) *EtcdLocker {
    return &EtcdLocker{client: client, prefix: prefix}
}

type EtcdLock struct {
    mutex   *concurrency.Mutex
    session *concurrency.Session
    token   int64
}

func (l *EtcdLock) Token() int64 { return l.token }

func (l *EtcdLock) Refresh(ctx context.Context) error {
    // etcd sessions auto-renew their lease while the client is alive
    // Manual refresh is only needed if you want to extend explicitly
    return l.session.Close() // This will NOT release the mutex, just the session renewal
    // In practice: just keep the session alive (it auto-renews)
}

func (l *EtcdLock) Release(ctx context.Context) error {
    if err := l.mutex.Unlock(ctx); err != nil {
        return fmt.Errorf("etcd mutex unlock: %w", err)
    }
    // Close session releases the lease
    return l.session.Close()
}

func (e *EtcdLocker) TryLock(ctx context.Context, key string, ttl time.Duration) (*EtcdLock, error) {
    ttlSeconds := int(ttl.Seconds())
    if ttlSeconds < 1 {
        ttlSeconds = 1
    }

    // Create a session with a TTL-based lease
    // If the process dies, the lease expires and the lock is released
    session, err := concurrency.NewSession(e.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("creating etcd session: %w", err)
    }

    mutex := concurrency.NewMutex(session, e.prefix+"/"+key)

    // TryLock returns immediately if lock is unavailable
    if err := mutex.TryLock(ctx); err != nil {
        session.Close()
        if err == concurrency.ErrLocked {
            return nil, ErrLockNotAcquired
        }
        return nil, fmt.Errorf("etcd TryLock: %w", err)
    }

    // Get the revision number as fencing token
    // etcd revisions are globally monotonically increasing
    resp, err := e.client.Get(ctx, mutex.Key())
    if err != nil {
        mutex.Unlock(ctx)
        session.Close()
        return nil, fmt.Errorf("getting lock token: %w", err)
    }

    var token int64
    if len(resp.Kvs) > 0 {
        token = resp.Kvs[0].CreateRevision
    }

    return &EtcdLock{
        mutex:   mutex,
        session: session,
        token:   token,
    }, nil
}

func (e *EtcdLocker) Lock(ctx context.Context, key string, ttl time.Duration) (*EtcdLock, error) {
    ttlSeconds := int(ttl.Seconds())
    if ttlSeconds < 1 {
        ttlSeconds = 1
    }

    session, err := concurrency.NewSession(e.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("creating etcd session: %w", err)
    }

    mutex := concurrency.NewMutex(session, e.prefix+"/"+key)

    // Lock blocks until acquired or context is cancelled
    if err := mutex.Lock(ctx); err != nil {
        session.Close()
        return nil, fmt.Errorf("etcd Lock: %w", err)
    }

    resp, err := e.client.Get(ctx, mutex.Key())
    if err != nil {
        mutex.Unlock(ctx)
        session.Close()
        return nil, err
    }

    var token int64
    if len(resp.Kvs) > 0 {
        token = resp.Kvs[0].CreateRevision
    }

    return &EtcdLock{
        mutex:   mutex,
        session: session,
        token:   token,
    }, nil
}

// Watch for lock availability (efficient waiting)
func (e *EtcdLocker) WatchLock(ctx context.Context, key string) <-chan struct{} {
    ch := make(chan struct{}, 1)
    go func() {
        watchCh := e.client.Watch(ctx, e.prefix+"/"+key, clientv3.WithPrefix())
        for {
            select {
            case <-ctx.Done():
                return
            case event := <-watchCh:
                for _, ev := range event.Events {
                    if ev.Type == clientv3.EventTypeDelete {
                        ch <- struct{}{}
                        return
                    }
                }
            }
        }
    }()
    return ch
}
```

## PostgreSQL Advisory Locks

PostgreSQL advisory locks are application-level locks stored in shared memory, not tied to any table. They're excellent for distributed locks when you're already using PostgreSQL:

```go
package pglock

import (
    "context"
    "database/sql"
    "fmt"
    "hash/fnv"
    "time"
)

// PostgreSQL advisory lock IDs are 64-bit integers
// We hash the lock key to get a stable integer ID

type PostgresLocker struct {
    db *sql.DB
}

func NewPostgresLocker(db *sql.DB) *PostgresLocker {
    return &PostgresLocker{db: db}
}

type PostgresLock struct {
    locker *PostgresLocker
    lockID int64
    conn   *sql.Conn  // Advisory locks are per-connection
    token  int64
}

func (l *PostgresLock) Token() int64 { return l.token }

func (l *PostgresLock) Release(ctx context.Context) error {
    defer l.conn.Close()

    _, err := l.conn.ExecContext(ctx,
        "SELECT pg_advisory_unlock($1)", l.lockID)
    if err != nil {
        return fmt.Errorf("pg_advisory_unlock: %w", err)
    }
    return nil
}

func (l *PostgresLock) Refresh(ctx context.Context) error {
    // Advisory locks don't expire (connection = lock lifetime)
    // "Refresh" here means verifying the connection is still alive
    return l.conn.PingContext(ctx)
}

// hashKey converts a string key to a PostgreSQL bigint lock ID
func hashKey(key string) int64 {
    h := fnv.New64a()
    h.Write([]byte(key))
    // Convert to signed int64 (PostgreSQL uses bigint)
    return int64(h.Sum64())
}

func (p *PostgresLocker) TryLock(ctx context.Context, key string, ttl time.Duration) (*PostgresLock, error) {
    lockID := hashKey(key)

    // Acquire a dedicated connection (advisory locks are connection-scoped)
    conn, err := p.db.Conn(ctx)
    if err != nil {
        return nil, fmt.Errorf("acquiring connection: %w", err)
    }

    // pg_try_advisory_lock: returns immediately
    var acquired bool
    err = conn.QueryRowContext(ctx,
        "SELECT pg_try_advisory_lock($1)", lockID).Scan(&acquired)
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("pg_try_advisory_lock: %w", err)
    }

    if !acquired {
        conn.Close()
        return nil, ErrLockNotAcquired
    }

    // Get a fencing token from a sequence
    var token int64
    err = conn.QueryRowContext(ctx,
        "SELECT nextval('distributed_lock_tokens')").Scan(&token)
    if err != nil {
        // Release the lock and connection if we can't get a token
        conn.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", lockID)
        conn.Close()
        return nil, fmt.Errorf("getting fencing token: %w", err)
    }

    return &PostgresLock{
        locker: p,
        lockID: lockID,
        conn:   conn,
        token:  token,
    }, nil
}

func (p *PostgresLocker) Lock(ctx context.Context, key string, ttl time.Duration) (*PostgresLock, error) {
    lockID := hashKey(key)

    conn, err := p.db.Conn(ctx)
    if err != nil {
        return nil, fmt.Errorf("acquiring connection: %w", err)
    }

    // pg_advisory_lock: blocks until lock is available
    _, err = conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", lockID)
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("pg_advisory_lock: %w", err)
    }

    var token int64
    err = conn.QueryRowContext(ctx,
        "SELECT nextval('distributed_lock_tokens')").Scan(&token)
    if err != nil {
        conn.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", lockID)
        conn.Close()
        return nil, err
    }

    return &PostgresLock{
        locker: p,
        lockID: lockID,
        conn:   conn,
        token:  token,
    }, nil
}

// Session-Level vs Transaction-Level Advisory Locks
func (p *PostgresLocker) WithTransactionLock(
    ctx context.Context,
    key string,
    fn func(ctx context.Context, tx *sql.Tx) error,
) error {
    tx, err := p.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    lockID := hashKey(key)

    // Transaction-level advisory lock: automatically released on COMMIT/ROLLBACK
    // No explicit unlock needed
    _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", lockID)
    if err != nil {
        return fmt.Errorf("pg_advisory_xact_lock: %w", err)
    }

    if err := fn(ctx, tx); err != nil {
        return err
    }

    return tx.Commit()
}

// Schema for fencing tokens
const setupSQL = `
CREATE SEQUENCE IF NOT EXISTS distributed_lock_tokens
    START WITH 1
    INCREMENT BY 1
    NO MAXVALUE
    CACHE 1;
`
```

## Fencing Tokens in Practice

Fencing tokens prevent stale lock holders from making destructive writes:

```go
package fencing

import (
    "context"
    "fmt"
    "sync/atomic"
)

// FencedStorage rejects writes from stale lock holders
type FencedStorage struct {
    currentToken atomic.Int64
    data         map[string]valueWithToken
    mu           sync.RWMutex
}

type valueWithToken struct {
    value string
    token int64
}

// Write only succeeds if the token is >= the last seen token
func (s *FencedStorage) Write(ctx context.Context, key, value string, token int64) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    current := s.currentToken.Load()
    if token < current {
        return fmt.Errorf("fencing rejected: stale token %d, current is %d", token, current)
    }

    s.currentToken.Store(token)
    s.data[key] = valueWithToken{value: value, token: token}
    return nil
}

// Example: using fencing tokens to prevent split-brain writes
func processWithFencing(
    ctx context.Context,
    locker Locker,
    storage *FencedStorage,
    key string,
    value string,
) error {
    lock, err := locker.Lock(ctx, "resource:"+key, 30*time.Second)
    if err != nil {
        return fmt.Errorf("lock acquisition failed: %w", err)
    }

    token := lock.Token()
    defer lock.Release(ctx)

    // Simulate long operation where the lock might expire
    if err := longOperation(ctx); err != nil {
        return err
    }

    // Write with fencing token - storage will reject if token is stale
    // (e.g., if lock expired and was re-acquired by another process)
    if err := storage.Write(ctx, key, value, token); err != nil {
        return fmt.Errorf("fenced write failed (possible split-brain): %w", err)
    }

    return nil
}
```

## Choosing the Right Backend

```go
// Decision framework
func selectLockBackend(requirements LockRequirements) string {
    switch {
    case requirements.MaxLatency < time.Millisecond:
        // Ultra-low latency: Redis single node (< 0.5ms typical)
        return "redis-single"

    case requirements.FaultTolerance == "high" && requirements.Redis:
        // Fault tolerant, already using Redis: Redlock (3-5 nodes)
        // Note: Redlock is controversial; see Martin Kleppmann's critique
        return "redlock"

    case requirements.AlreadyUsingPostgres && requirements.MaxConcurrency < 1000:
        // Already on Postgres, moderate concurrency: advisory locks
        // Excellent for job queues, singleton jobs
        return "postgres-advisory"

    case requirements.NeedStrongConsistency:
        // Strong consistency required: etcd (Raft consensus)
        // etcd's lease-based approach handles network partitions correctly
        return "etcd"

    default:
        // General purpose: etcd for correctness, Redis for performance
        return "etcd"
    }
}
```

### Comparison Table

| Property | Redis (single) | Redlock | etcd | PostgreSQL advisory |
|----------|---------------|---------|------|---------------------|
| Latency | < 1ms | 2-5ms | 2-10ms | 1-5ms |
| Fault tolerance | None | Partial | Strong (Raft) | DB cluster |
| Fencing tokens | Manual | Manual | Yes (revision) | Yes (sequence) |
| Auto-release on crash | TTL expiry | TTL expiry | Lease expiry | Connection close |
| Complexity | Low | Medium | Medium | Low (if on PG) |
| Network partition safety | No | Partial | Yes | Depends on DB HA |

## Production Monitoring

```go
package monitoring

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    lockAcquireAttempts = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "distributed_lock_acquire_attempts_total",
        Help: "Total lock acquisition attempts",
    }, []string{"backend", "key", "result"})

    lockAcquireDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "distributed_lock_acquire_duration_seconds",
        Help:    "Time to acquire a distributed lock",
        Buckets: prometheus.ExponentialBuckets(0.001, 2, 15),
    }, []string{"backend", "key"})

    lockHeldDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "distributed_lock_held_duration_seconds",
        Help:    "How long locks are held",
        Buckets: prometheus.ExponentialBuckets(0.1, 2, 12),
    }, []string{"backend", "key"})

    lockRefreshFailures = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "distributed_lock_refresh_failures_total",
        Help: "Lock refresh failures (potential split-brain events)",
    }, []string{"backend", "key"})
)

// InstrumentedLocker wraps any Locker with metrics
type InstrumentedLocker struct {
    inner   Locker
    backend string
}

func NewInstrumentedLocker(inner Locker, backend string) *InstrumentedLocker {
    return &InstrumentedLocker{inner: inner, backend: backend}
}

func (l *InstrumentedLocker) Lock(ctx context.Context, key string, ttl time.Duration) (Lock, error) {
    start := time.Now()
    lock, err := l.inner.Lock(ctx, key, ttl)

    result := "success"
    if err != nil {
        result = "failure"
    }

    lockAcquireAttempts.WithLabelValues(l.backend, key, result).Inc()
    lockAcquireDuration.WithLabelValues(l.backend, key).Observe(time.Since(start).Seconds())

    if err != nil {
        return nil, err
    }

    return &instrumentedLock{
        inner:    lock,
        backend:  l.backend,
        key:      key,
        acquired: time.Now(),
    }, nil
}
```

## Summary

Distributed locks are essential infrastructure for coordinating work across multiple processes:

1. **Redis SETNX** provides simple, low-latency locks suitable for non-critical coordination; always use Lua scripts for atomic release
2. **Redlock** adds fault tolerance but has well-documented limitations around network partitions and clock skew
3. **etcd leases** provide the strongest guarantees via Raft consensus, with automatic cleanup when processes die
4. **PostgreSQL advisory locks** are ideal if you're already on PostgreSQL; transaction-level variants auto-release on commit/rollback
5. **Fencing tokens** are the only way to handle split-brain: include the token in all protected operations and reject writes with stale tokens
6. **Auto-refresh goroutines** prevent lock expiry during long operations; always handle the case where refresh fails (lock stolen)

Choose based on your existing infrastructure: PostgreSQL advisory locks if you're already on PostgreSQL, etcd if you need strong consistency, Redis if you need sub-millisecond latency with acceptable failure modes.
