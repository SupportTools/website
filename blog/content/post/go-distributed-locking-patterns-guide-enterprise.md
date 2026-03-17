---
title: "Go Distributed Locking: Redis Redlock, etcd Leases, and Database Advisory Locks"
date: 2028-07-07T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Redis", "etcd", "Locking", "Concurrency"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to implementing distributed locking in Go using Redis Redlock, etcd distributed leases, and PostgreSQL advisory locks, with fencing tokens and failure mode analysis."
more_link: "yes"
url: "/go-distributed-locking-patterns-guide-enterprise/"
---

Distributed locking is one of those problems that looks simple until it fails at 3am. The naive approach — acquire a lock in Redis, do work, release the lock — breaks in ways that are hard to reproduce: network partitions cause lock holders to believe they still hold a lock while others have taken over, clock skew causes TTL expiration at unexpected times, and process pauses (GC, VM migration) allow locks to expire while the holder is still in the critical section.

This guide covers three production-grade approaches to distributed locking in Go: Redis Redlock for low-latency general-purpose locks, etcd leases for leader election and coordination, and PostgreSQL advisory locks for transaction-scoped locking. Each approach has different guarantees, failure modes, and use cases. Understanding the tradeoffs is as important as the implementation.

<!--more-->

# Go Distributed Locking: Redis Redlock, etcd, and PostgreSQL

## Section 1: Why Distributed Locking Is Hard

Before implementing anything, it is worth internalizing the failure modes that make distributed locking genuinely difficult.

### The Problem with Single-Node Redis Locks

The most common implementation:

```go
// WRONG: This has race conditions
func naiveLock(client *redis.Client, key string, ttl time.Duration) (bool, error) {
    result, err := client.SetNX(context.Background(), key, "locked", ttl).Result()
    return result, err
}

func naiveUnlock(client *redis.Client, key string) error {
    return client.Del(context.Background(), key).Err()
}
```

This breaks when:
1. Process A acquires lock with 10s TTL
2. Process A pauses (GC, IO wait) for 11 seconds
3. Lock expires, Process B acquires it
4. Process A resumes and calls `Del`, unlocking B's lock
5. Process C acquires the lock — now B and C both hold it

The fix for problem 4 is a Lua script that atomically checks ownership before deleting. But problem 3 (process pause exceeding TTL) is unsolvable at the lock level — it requires fencing tokens.

### The Fencing Token Pattern

A fencing token is a monotonically increasing number returned with each lock acquisition. The protected resource validates that incoming requests carry a token equal to or greater than the last seen token:

```
Client A acquires lock, receives token 34
Client A pauses (GC pause)
Lock expires, Client B acquires lock, receives token 35
Client A resumes, sends request with token 34 to storage
Storage rejects: token 34 < last seen token 35
Client B sends request with token 35
Storage accepts
```

etcd provides this natively through revision numbers. Redis and databases require implementing it in the resource layer.

## Section 2: Redis Redlock

Redlock uses a majority quorum across N independent Redis instances to provide stronger guarantees than single-node locking.

### The Redlock Algorithm

To acquire a lock with TTL `T`:
1. Get current timestamp `T1`
2. Attempt to acquire the lock on each of N Redis nodes with TTL `T`
3. Count successful acquisitions. If >= N/2+1 AND `now - T1 < T`, the lock is acquired
4. The effective lock time is `T - (now - T1)` — less than the configured TTL

To release:
1. Execute Lua script on all N nodes (delete only if value matches)

```go
// pkg/lock/redlock.go
package lock

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "errors"
    "fmt"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

var (
    ErrLockNotAcquired = errors.New("lock not acquired: could not reach quorum")
    ErrLockExpired     = errors.New("lock expired before critical section completed")
)

// unlockScript atomically deletes a key only if its value matches
var unlockScript = redis.NewScript(`
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    else
        return 0
    end
`)

// extendScript atomically extends TTL only if value matches
var extendScript = redis.NewScript(`
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
        return 0
    end
`)

type RedLock struct {
    clients     []*redis.Client
    quorum      int
    retryDelay  time.Duration
    retryCount  int
    driftFactor float64
}

type Lock struct {
    resource  string
    value     string
    ttl       time.Duration
    acquired  time.Time
    lock      *RedLock
    mu        sync.Mutex
    released  bool
    cancelExt context.CancelFunc
}

func NewRedLock(clients []*redis.Client) *RedLock {
    return &RedLock{
        clients:     clients,
        quorum:      len(clients)/2 + 1,
        retryDelay:  200 * time.Millisecond,
        retryCount:  3,
        driftFactor: 0.01,  // 1% clock drift
    }
}

// Acquire attempts to acquire the distributed lock
func (rl *RedLock) Acquire(ctx context.Context, resource string, ttl time.Duration) (*Lock, error) {
    value, err := randomValue()
    if err != nil {
        return nil, fmt.Errorf("generating lock value: %w", err)
    }

    for attempt := 0; attempt < rl.retryCount; attempt++ {
        start := time.Now()

        acquired := 0
        var wg sync.WaitGroup
        var mu sync.Mutex
        errors := make([]error, len(rl.clients))

        for i, client := range rl.clients {
            wg.Add(1)
            go func(i int, c *redis.Client) {
                defer wg.Done()
                ok, err := acquireOnInstance(ctx, c, resource, value, ttl)
                if err != nil {
                    errors[i] = err
                    return
                }
                if ok {
                    mu.Lock()
                    acquired++
                    mu.Unlock()
                }
            }(i, client)
        }
        wg.Wait()

        elapsed := time.Since(start)
        drift := time.Duration(float64(ttl)*rl.driftFactor) + 2*time.Millisecond
        validityTime := ttl - elapsed - drift

        if acquired >= rl.quorum && validityTime > 0 {
            lock := &Lock{
                resource: resource,
                value:    value,
                ttl:      ttl,
                acquired: start,
                lock:     rl,
            }
            return lock, nil
        }

        // Release on all nodes before retrying
        rl.releaseAll(ctx, resource, value)

        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(rl.retryDelay + jitter(50*time.Millisecond)):
        }
    }

    return nil, ErrLockNotAcquired
}

func (rl *RedLock) releaseAll(ctx context.Context, resource, value string) {
    var wg sync.WaitGroup
    for _, client := range rl.clients {
        wg.Add(1)
        go func(c *redis.Client) {
            defer wg.Done()
            unlockScript.Run(ctx, c, []string{resource}, value)
        }(client)
    }
    wg.Wait()
}

// Release releases the distributed lock
func (l *Lock) Release(ctx context.Context) error {
    l.mu.Lock()
    defer l.mu.Unlock()

    if l.released {
        return nil
    }
    l.released = true

    if l.cancelExt != nil {
        l.cancelExt()
    }

    l.lock.releaseAll(ctx, l.resource, l.value)
    return nil
}

// ValidityRemaining returns how much validity time the lock has left
func (l *Lock) ValidityRemaining() time.Duration {
    elapsed := time.Since(l.acquired)
    drift := time.Duration(float64(l.ttl)*l.lock.driftFactor) + 2*time.Millisecond
    remaining := l.ttl - elapsed - drift
    if remaining < 0 {
        return 0
    }
    return remaining
}

// StartAutoExtend starts a background goroutine that extends the lock
// before it expires. The goroutine stops when ctx is cancelled or Release is called.
func (l *Lock) StartAutoExtend(ctx context.Context, extendBy time.Duration) {
    extCtx, cancel := context.WithCancel(ctx)
    l.mu.Lock()
    l.cancelExt = cancel
    l.mu.Unlock()

    go func() {
        // Extend at 2/3 of the TTL
        extendAt := time.Duration(float64(l.ttl) * 0.66)
        ticker := time.NewTicker(extendAt)
        defer ticker.Stop()

        for {
            select {
            case <-extCtx.Done():
                return
            case <-ticker.C:
                l.mu.Lock()
                if l.released {
                    l.mu.Unlock()
                    return
                }
                l.mu.Unlock()

                err := l.extend(ctx, extendBy)
                if err != nil {
                    // Log and let the lock expire naturally
                    fmt.Printf("WARNING: failed to extend lock %s: %v\n", l.resource, err)
                    return
                }
            }
        }
    }()
}

func (l *Lock) extend(ctx context.Context, by time.Duration) error {
    var wg sync.WaitGroup
    extended := 0
    var mu sync.Mutex

    for _, client := range l.lock.clients {
        wg.Add(1)
        go func(c *redis.Client) {
            defer wg.Done()
            result, err := extendScript.Run(ctx, c,
                []string{l.resource},
                l.value,
                by.Milliseconds(),
            ).Int()
            if err == nil && result == 1 {
                mu.Lock()
                extended++
                mu.Unlock()
            }
        }(client)
    }
    wg.Wait()

    if extended < l.lock.quorum {
        return fmt.Errorf("could not extend lock: only %d/%d nodes extended",
            extended, l.lock.quorum)
    }

    l.mu.Lock()
    l.ttl = by
    l.acquired = time.Now()
    l.mu.Unlock()

    return nil
}

func acquireOnInstance(ctx context.Context, c *redis.Client, resource, value string, ttl time.Duration) (bool, error) {
    result, err := c.SetNX(ctx, resource, value, ttl).Result()
    if err != nil {
        // Connection errors should not prevent quorum calculation
        return false, nil
    }
    return result, nil
}

func randomValue() (string, error) {
    b := make([]byte, 16)
    _, err := rand.Read(b)
    if err != nil {
        return "", err
    }
    return hex.EncodeToString(b), nil
}

func jitter(max time.Duration) time.Duration {
    b := make([]byte, 8)
    rand.Read(b)
    n := int64(b[0]) + int64(b[1])<<8
    return time.Duration(n%int64(max))
}
```

### Using the RedLock Implementation

```go
// Example usage with proper error handling
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/redis/go-redis/v9"
    "myapp/pkg/lock"
)

func main() {
    // Create 5 Redis clients pointing to independent Redis instances
    clients := []*redis.Client{
        redis.NewClient(&redis.Options{Addr: "redis1:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis2:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis3:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis4:6379"}),
        redis.NewClient(&redis.Options{Addr: "redis5:6379"}),
    }

    rl := lock.NewRedLock(clients)

    ctx := context.Background()

    // Acquire with 30 second TTL
    l, err := rl.Acquire(ctx, "critical-section:resource-id", 30*time.Second)
    if err != nil {
        log.Fatalf("failed to acquire lock: %v", err)
    }
    defer l.Release(ctx)

    // Start auto-extend for long-running operations
    l.StartAutoExtend(ctx, 30*time.Second)

    // Check remaining validity before critical section
    if l.ValidityRemaining() < 5*time.Second {
        log.Fatal("lock validity too short to safely proceed")
    }

    // Do the protected work
    if err := performCriticalWork(ctx); err != nil {
        log.Printf("critical work failed: %v", err)
        return
    }

    fmt.Println("Critical section completed successfully")
}

func performCriticalWork(ctx context.Context) error {
    // Simulate work
    time.Sleep(2 * time.Second)
    return nil
}
```

## Section 3: etcd Distributed Leases and Leader Election

etcd provides stronger consistency guarantees than Redis for coordination primitives because it uses the Raft consensus algorithm. The tradeoff is higher latency (10-50ms vs 1-5ms for Redis).

### etcd Lease-Based Locking

```go
// pkg/lock/etcd_lock.go
package lock

import (
    "context"
    "fmt"
    "sync"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

type EtcdLock struct {
    client  *clientv3.Client
    session *concurrency.Session
    mutex   *concurrency.Mutex
    mu      sync.Mutex
    held    bool
}

type EtcdLockManager struct {
    client *clientv3.Client
}

func NewEtcdLockManager(endpoints []string) (*EtcdLockManager, error) {
    client, err := clientv3.New(clientv3.Config{
        Endpoints:   endpoints,
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        return nil, fmt.Errorf("creating etcd client: %w", err)
    }
    return &EtcdLockManager{client: client}, nil
}

// Acquire acquires a distributed lock using etcd sessions
func (m *EtcdLockManager) Acquire(ctx context.Context, key string, ttl time.Duration) (*EtcdLock, error) {
    ttlSeconds := int(ttl.Seconds())
    if ttlSeconds < 1 {
        ttlSeconds = 1
    }

    // Session is a lease with automatic keep-alive
    session, err := concurrency.NewSession(m.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("creating session: %w", err)
    }

    mutex := concurrency.NewMutex(session, "/locks/"+key)

    // TryLock returns immediately if lock not available
    if err := mutex.TryLock(ctx); err != nil {
        session.Close()
        if err == concurrency.ErrLocked {
            return nil, ErrLockNotAcquired
        }
        return nil, fmt.Errorf("acquiring lock: %w", err)
    }

    return &EtcdLock{
        client:  m.client,
        session: session,
        mutex:   mutex,
        held:    true,
    }, nil
}

// AcquireWait waits until the lock is available
func (m *EtcdLockManager) AcquireWait(ctx context.Context, key string, ttl time.Duration) (*EtcdLock, error) {
    ttlSeconds := int(ttl.Seconds())
    if ttlSeconds < 1 {
        ttlSeconds = 1
    }

    session, err := concurrency.NewSession(m.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("creating session: %w", err)
    }

    mutex := concurrency.NewMutex(session, "/locks/"+key)

    // Lock blocks until acquired or context cancelled
    if err := mutex.Lock(ctx); err != nil {
        session.Close()
        return nil, fmt.Errorf("waiting for lock: %w", err)
    }

    return &EtcdLock{
        client:  m.client,
        session: session,
        mutex:   mutex,
        held:    true,
    }, nil
}

// Release releases the lock and closes the session
func (l *EtcdLock) Release(ctx context.Context) error {
    l.mu.Lock()
    defer l.mu.Unlock()

    if !l.held {
        return nil
    }
    l.held = false

    if err := l.mutex.Unlock(ctx); err != nil {
        return fmt.Errorf("unlocking mutex: %w", err)
    }

    return l.session.Close()
}

// Revision returns the etcd revision when the lock was acquired
// This is the fencing token for use with protected resources
func (l *EtcdLock) Revision() int64 {
    return l.mutex.Header().Revision
}

// Key returns the etcd key for this lock instance
func (l *EtcdLock) Key() string {
    return l.mutex.Key()
}
```

### Leader Election with etcd

Leader election is a specialized form of distributed locking where one instance continuously holds a lock until it fails:

```go
// pkg/leader/election.go
package leader

import (
    "context"
    "fmt"
    "log/slog"
    "sync"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

type LeaderElection struct {
    client      *clientv3.Client
    prefix      string
    identity    string
    sessionTTL  int
    onLeader    func(ctx context.Context)
    onFollower  func()
    mu          sync.Mutex
    isLeader    bool
    cancel      context.CancelFunc
}

func New(client *clientv3.Client, prefix, identity string, ttl time.Duration) *LeaderElection {
    return &LeaderElection{
        client:     client,
        prefix:     prefix,
        identity:   identity,
        sessionTTL: int(ttl.Seconds()),
    }
}

// OnLeader sets the callback invoked when this instance becomes leader
func (le *LeaderElection) OnLeader(fn func(ctx context.Context)) *LeaderElection {
    le.onLeader = fn
    return le
}

// OnFollower sets the callback invoked when this instance loses leadership
func (le *LeaderElection) OnFollower(fn func()) *LeaderElection {
    le.onFollower = fn
    return le
}

// Run starts the election loop and blocks until ctx is cancelled
func (le *LeaderElection) Run(ctx context.Context) error {
    for {
        if err := le.runElection(ctx); err != nil {
            if ctx.Err() != nil {
                return ctx.Err()
            }
            slog.Error("election error, retrying", "error", err)
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(5 * time.Second):
            }
        }
    }
}

func (le *LeaderElection) runElection(ctx context.Context) error {
    session, err := concurrency.NewSession(le.client,
        concurrency.WithTTL(le.sessionTTL),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return fmt.Errorf("creating session: %w", err)
    }
    defer session.Close()

    election := concurrency.NewElection(session, le.prefix)

    slog.Info("campaigning for leadership",
        "identity", le.identity,
        "prefix", le.prefix,
    )

    // Campaign blocks until we become leader
    if err := election.Campaign(ctx, le.identity); err != nil {
        return fmt.Errorf("campaigning: %w", err)
    }

    slog.Info("became leader",
        "identity", le.identity,
        "revision", session.Lease(),
    )

    le.mu.Lock()
    le.isLeader = true
    le.mu.Unlock()

    // Run leader work in a cancellable context
    leaderCtx, leaderCancel := context.WithCancel(ctx)
    le.mu.Lock()
    le.cancel = leaderCancel
    le.mu.Unlock()

    // Watch for session expiry
    done := make(chan struct{})
    go func() {
        select {
        case <-session.Done():
            slog.Warn("session expired, resigning")
            leaderCancel()
        case <-leaderCtx.Done():
        }
        close(done)
    }()

    if le.onLeader != nil {
        le.onLeader(leaderCtx)
    }

    <-done

    // Resign
    if err := election.Resign(ctx); err != nil {
        slog.Error("error resigning", "error", err)
    }

    le.mu.Lock()
    le.isLeader = false
    le.mu.Unlock()

    if le.onFollower != nil {
        le.onFollower()
    }

    return nil
}

// IsLeader reports whether this instance currently holds the election
func (le *LeaderElection) IsLeader() bool {
    le.mu.Lock()
    defer le.mu.Unlock()
    return le.isLeader
}

// Resign gives up leadership
func (le *LeaderElection) Resign() {
    le.mu.Lock()
    cancel := le.cancel
    le.mu.Unlock()

    if cancel != nil {
        cancel()
    }
}
```

Using the leader election:

```go
package main

import (
    "context"
    "log/slog"
    "os"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "myapp/pkg/leader"
)

func main() {
    client, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"etcd1:2379", "etcd2:2379", "etcd3:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        slog.Error("connecting to etcd", "error", err)
        os.Exit(1)
    }
    defer client.Close()

    hostname, _ := os.Hostname()

    le := leader.New(client, "/election/my-worker", hostname, 15*time.Second).
        OnLeader(func(ctx context.Context) {
            slog.Info("running as leader")
            runLeaderWork(ctx)
        }).
        OnFollower(func() {
            slog.Info("running as follower")
        })

    if err := le.Run(context.Background()); err != nil {
        slog.Error("election stopped", "error", err)
    }
}

func runLeaderWork(ctx context.Context) {
    // This runs until ctx is cancelled (when leadership is lost)
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            slog.Info("leader work stopping")
            return
        case <-ticker.C:
            // Do leader-only work
            slog.Info("executing scheduled job as leader")
        }
    }
}
```

## Section 4: PostgreSQL Advisory Locks

PostgreSQL advisory locks are lightweight locks managed by the database that tie directly to transactions. They are ideal when your critical section also involves database operations.

### Session-Level Advisory Locks

```go
// pkg/lock/pg_lock.go
package lock

import (
    "context"
    "database/sql"
    "fmt"
    "hash/fnv"
)

type PgLockManager struct {
    db *sql.DB
}

func NewPgLockManager(db *sql.DB) *PgLockManager {
    return &PgLockManager{db: db}
}

// keyToInt converts a string key to an int64 for use with advisory locks
func keyToInt(key string) int64 {
    h := fnv.New64a()
    h.Write([]byte(key))
    // Convert to int64 (advisory locks use int64)
    return int64(h.Sum64() >> 1)  // Shift to avoid negative numbers
}

// TryLock attempts to acquire a session-level advisory lock without blocking
// Returns true if acquired, false if already locked by another session
func (m *PgLockManager) TryLock(ctx context.Context, key string) (bool, error) {
    lockID := keyToInt(key)
    var acquired bool
    err := m.db.QueryRowContext(ctx,
        "SELECT pg_try_advisory_lock($1)", lockID,
    ).Scan(&acquired)
    if err != nil {
        return false, fmt.Errorf("pg_try_advisory_lock: %w", err)
    }
    return acquired, nil
}

// Lock acquires a session-level advisory lock, blocking until available
func (m *PgLockManager) Lock(ctx context.Context, key string) error {
    lockID := keyToInt(key)
    _, err := m.db.ExecContext(ctx,
        "SELECT pg_advisory_lock($1)", lockID,
    )
    return err
}

// Unlock releases a session-level advisory lock
func (m *PgLockManager) Unlock(ctx context.Context, key string) error {
    lockID := keyToInt(key)
    var released bool
    err := m.db.QueryRowContext(ctx,
        "SELECT pg_advisory_unlock($1)", lockID,
    ).Scan(&released)
    if err != nil {
        return fmt.Errorf("pg_advisory_unlock: %w", err)
    }
    if !released {
        return fmt.Errorf("lock %q was not held by this session", key)
    }
    return nil
}

// WithLock runs fn while holding the advisory lock
// The lock is automatically released when fn returns
func (m *PgLockManager) WithLock(ctx context.Context, key string, fn func(ctx context.Context) error) error {
    if err := m.Lock(ctx, key); err != nil {
        return fmt.Errorf("acquiring lock %q: %w", key, err)
    }
    defer m.Unlock(ctx, key)
    return fn(ctx)
}
```

### Transaction-Level Advisory Locks

Transaction-level locks are automatically released when the transaction commits or rolls back:

```go
// pkg/lock/pg_tx_lock.go
package lock

import (
    "context"
    "database/sql"
    "fmt"
)

type TxLockManager struct {
    db *sql.DB
}

func NewTxLockManager(db *sql.DB) *TxLockManager {
    return &TxLockManager{db: db}
}

// WithTxLock runs fn inside a transaction while holding an advisory lock
// The lock is automatically released when the transaction ends
func (m *TxLockManager) WithTxLock(
    ctx context.Context,
    key string,
    fn func(ctx context.Context, tx *sql.Tx) error,
) error {
    tx, err := m.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("beginning transaction: %w", err)
    }
    defer tx.Rollback()

    lockID := keyToInt(key)
    var acquired bool
    if err := tx.QueryRowContext(ctx,
        "SELECT pg_try_advisory_xact_lock($1)", lockID,
    ).Scan(&acquired); err != nil {
        return fmt.Errorf("advisory lock: %w", err)
    }

    if !acquired {
        return fmt.Errorf("could not acquire transaction lock for %q", key)
    }

    if err := fn(ctx, tx); err != nil {
        return err
    }

    return tx.Commit()
}

// Example: Prevent duplicate order processing
func ProcessOrder(ctx context.Context, db *sql.DB, orderID string) error {
    lm := NewTxLockManager(db)

    return lm.WithTxLock(ctx, "order:"+orderID, func(ctx context.Context, tx *sql.Tx) error {
        // Check if already processed (inside the lock)
        var processed bool
        if err := tx.QueryRowContext(ctx,
            "SELECT processed FROM orders WHERE id = $1", orderID,
        ).Scan(&processed); err != nil {
            return fmt.Errorf("checking order: %w", err)
        }

        if processed {
            return nil  // Already processed, idempotent
        }

        // Process the order
        if _, err := tx.ExecContext(ctx,
            "UPDATE orders SET processed = true, processed_at = NOW() WHERE id = $1",
            orderID,
        ); err != nil {
            return fmt.Errorf("marking order processed: %w", err)
        }

        // Emit events, debit inventory, etc. (all within the transaction)
        return nil
    })
}
```

## Section 5: Choosing the Right Locking Primitive

### Decision Matrix

```
Use Redis Redlock when:
- Low latency is critical (< 5ms)
- Lock duration is short (< 30 seconds)
- Occasional false negatives are acceptable
- You already have Redis in your stack

Use etcd when:
- Strong consistency is required (Raft-backed)
- Building leader election or distributed coordination
- You need fencing tokens (revision numbers)
- Lock duration may be long (minutes)

Use PostgreSQL Advisory Locks when:
- Critical section involves database operations
- Transaction-scoped locking fits your model
- You want lock release tied to transaction outcome
- You need lock introspection (pg_locks view)
```

### Unified Locking Interface

```go
// pkg/lock/interface.go
package lock

import "context"

// DistributedLock represents a held distributed lock
type DistributedLock interface {
    // Release releases the lock
    Release(ctx context.Context) error
    // FencingToken returns a monotonically increasing token
    // Returns 0 if the implementation does not support fencing
    FencingToken() int64
}

// LockManager acquires distributed locks
type LockManager interface {
    // TryAcquire attempts to acquire without blocking
    TryAcquire(ctx context.Context, key string) (DistributedLock, error)
    // Acquire acquires the lock, blocking until available
    Acquire(ctx context.Context, key string) (DistributedLock, error)
}

// Do runs fn while holding a distributed lock
// It validates the fencing token if the resource supports it
func Do(
    ctx context.Context,
    lm LockManager,
    key string,
    fn func(ctx context.Context, token int64) error,
) error {
    lock, err := lm.Acquire(ctx, key)
    if err != nil {
        return fmt.Errorf("acquiring lock %q: %w", key, err)
    }
    defer lock.Release(ctx)

    return fn(ctx, lock.FencingToken())
}
```

## Section 6: Testing Distributed Locks

Testing distributed locking requires simulating network partitions, process pauses, and clock skew. Use testcontainers:

```go
// pkg/lock/redlock_test.go
package lock_test

import (
    "context"
    "sync"
    "sync/atomic"
    "testing"
    "time"

    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
    "myapp/pkg/lock"
)

func TestRedLockMutualExclusion(t *testing.T) {
    ctx := context.Background()

    // Start 5 Redis containers
    clients := startRedisContainers(t, ctx, 5)
    rl := lock.NewRedLock(clients)

    // Concurrency test: N goroutines compete for lock
    const goroutines = 100
    var (
        counter int64
        wg      sync.WaitGroup
        errors  []error
        mu      sync.Mutex
    )

    for i := 0; i < goroutines; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()

            l, err := rl.Acquire(ctx, "test-resource", 5*time.Second)
            if err != nil {
                mu.Lock()
                errors = append(errors, err)
                mu.Unlock()
                return
            }
            defer l.Release(ctx)

            // Read-modify-write: if mutual exclusion holds, counter is always 0 here
            current := atomic.LoadInt64(&counter)
            if current != 0 {
                t.Errorf("mutual exclusion violated: counter = %d", current)
            }

            atomic.AddInt64(&counter, 1)
            time.Sleep(time.Millisecond)
            atomic.AddInt64(&counter, -1)
        }()
    }

    wg.Wait()

    if len(errors) > 0 {
        t.Logf("Lock acquisition errors: %d/%d", len(errors), goroutines)
    }
}

func TestEtcdLeaderElection(t *testing.T) {
    // Uses testcontainers for etcd
    ctx := context.Background()
    client := startEtcdContainer(t, ctx)

    lm := lock.NewEtcdLockManager([]string{client})

    // Simulate 3 competing workers
    const workers = 3
    leaderCount := make([]int64, workers)
    var wg sync.WaitGroup

    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            for ctx.Err() == nil {
                l, err := lm.Acquire(ctx, "leader-election")
                if err != nil {
                    continue
                }
                atomic.AddInt64(&leaderCount[id], 1)
                time.Sleep(100 * time.Millisecond)
                l.Release(ctx)
            }
        }(i)
    }

    wg.Wait()

    // All workers should have held the lock at some point
    for i, count := range leaderCount {
        if count == 0 {
            t.Errorf("worker %d never acquired lock", i)
        }
        t.Logf("worker %d acquired lock %d times", i, count)
    }
}
```

## Section 7: Observability for Distributed Locks

```go
// pkg/lock/metrics.go
package lock

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    lockAcquisitions = promauto.NewCounterVec(prometheus.CounterOpts{
        Name: "distributed_lock_acquisitions_total",
        Help: "Total number of lock acquisition attempts",
    }, []string{"key", "result", "backend"})

    lockHoldDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "distributed_lock_hold_duration_seconds",
        Help:    "Duration that locks are held",
        Buckets: []float64{.01, .05, .1, .5, 1, 5, 10, 30, 60},
    }, []string{"key", "backend"})

    lockWaitDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "distributed_lock_wait_duration_seconds",
        Help:    "Duration spent waiting to acquire locks",
        Buckets: []float64{.001, .005, .01, .05, .1, .5, 1, 5},
    }, []string{"key", "backend"})
)

// InstrumentedLockManager wraps a LockManager with Prometheus metrics
type InstrumentedLockManager struct {
    inner   LockManager
    backend string
}

func NewInstrumentedLockManager(inner LockManager, backend string) *InstrumentedLockManager {
    return &InstrumentedLockManager{inner: inner, backend: backend}
}

func (m *InstrumentedLockManager) Acquire(ctx context.Context, key string) (DistributedLock, error) {
    start := time.Now()
    lock, err := m.inner.Acquire(ctx, key)
    waitDuration := time.Since(start)

    lockWaitDuration.WithLabelValues(key, m.backend).Observe(waitDuration.Seconds())

    if err != nil {
        lockAcquisitions.WithLabelValues(key, "failure", m.backend).Inc()
        return nil, err
    }

    lockAcquisitions.WithLabelValues(key, "success", m.backend).Inc()

    return &instrumentedLock{
        inner:    lock,
        key:      key,
        backend:  m.backend,
        acquired: time.Now(),
    }, nil
}

type instrumentedLock struct {
    inner    DistributedLock
    key      string
    backend  string
    acquired time.Time
}

func (l *instrumentedLock) Release(ctx context.Context) error {
    holdDuration := time.Since(l.acquired)
    lockHoldDuration.WithLabelValues(l.key, l.backend).Observe(holdDuration.Seconds())
    return l.inner.Release(ctx)
}

func (l *instrumentedLock) FencingToken() int64 {
    return l.inner.FencingToken()
}
```

## Conclusion

Distributed locking is a building block, not a solution. Every distributed lock eventually faces the fundamental problem that Martin Kleppmann describes: you cannot guarantee that a process holding a lock is actually making progress. The fencing token pattern, available natively through etcd and implementable over Redis and PostgreSQL, is the correct answer to this problem.

For most production Go services, the recommendation is etcd for leader election (where consistency matters most), Redis Redlock for rate limiting and cache warming (where occasional duplicates are acceptable), and PostgreSQL advisory locks when the critical section is a database transaction. All three benefit from the same operational discipline: bounded lock durations, auto-extend with exponential backoff, and Prometheus metrics on acquisition wait time and hold duration.
