---
title: "Go Distributed Locks: Redis SETNX, etcd Leases, and ZooKeeper for Leader Election"
date: 2030-04-10T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Redis", "etcd", "Leader Election", "Distributed Locks", "Concurrency"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production-grade distributed locking patterns in Go: Redis Redlock analysis, etcd lease-based locks with leadership fencing, distributed semaphores, lock failure handling, and deadlock prevention in microservice architectures."
more_link: "yes"
url: "/go-distributed-locks-redis-etcd-zookeeper-leader-election/"
---

Distributed locks are one of the most dangerous primitives in distributed systems. A local mutex fails fast and visibly. A distributed lock can fail in ways that appear correct locally but allow multiple processes to believe they hold the lock simultaneously — the exact scenario the lock was meant to prevent. This guide covers production-safe implementations using Redis, etcd, and ZooKeeper, with particular attention to the failure modes that cause real-world incidents.

<!--more-->

## Why Distributed Locks Are Hard

The fundamental challenge is that network partitions and process pauses can cause a lock holder to become unaware that their lock has expired:

```
Process A holds lock (acquired at T=0, TTL=30s)
T=25s: Process A is paused (GC, CPU starvation, swap)
T=30s: Lock expires
T=31s: Process B acquires lock
T=45s: Process A resumes, believes it still holds the lock
T=45s-T=60s: BOTH A and B believe they hold the lock
```

This is not a hypothetical scenario. Go's garbage collector can pause processes for hundreds of milliseconds. Cloud VMs get live-migrated. Network timeouts can cause apparent "success" responses to be delayed.

The only way to truly prevent dual ownership is **fencing**: every lock acquisition generates a monotonically increasing token. Any protected operation includes this token, and the resource rejects operations with older tokens.

## Redis-Based Distributed Locks

### Single-Instance Redis Lock

The basic Redis lock using SET with NX (not exists) and EX (expiry):

```go
// internal/lock/redis_lock.go
package lock

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

var (
    ErrLockNotHeld     = errors.New("lock not held")
    ErrLockUnavailable = errors.New("lock unavailable")
    ErrLockExpired     = errors.New("lock expired")
)

// RedisLock implements a single-instance Redis distributed lock
type RedisLock struct {
    client  redis.UniversalClient
    key     string
    token   string
    ttl     time.Duration
    acquired bool
}

// releaseLua is a Lua script that releases a lock atomically.
// Only the owner (matching token) can release the lock.
// This prevents one process from releasing another process's lock.
var releaseLua = redis.NewScript(`
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    else
        return 0
    end
`)

// renewLua extends the TTL only if the caller still holds the lock
var renewLua = redis.NewScript(`
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
        return 0
    end
`)

// generateToken creates a random token for lock ownership identification
func generateToken() (string, error) {
    b := make([]byte, 16)
    if _, err := rand.Read(b); err != nil {
        return "", fmt.Errorf("generate token: %w", err)
    }
    return hex.EncodeToString(b), nil
}

// NewRedisLock creates a new Redis lock
func NewRedisLock(client redis.UniversalClient, key string, ttl time.Duration) *RedisLock {
    return &RedisLock{
        client: client,
        key:    key,
        ttl:    ttl,
    }
}

// Acquire attempts to acquire the lock. Returns ErrLockUnavailable if busy.
func (l *RedisLock) Acquire(ctx context.Context) error {
    token, err := generateToken()
    if err != nil {
        return err
    }

    // SET key token NX PX milliseconds
    ok, err := l.client.SetNX(ctx, l.key, token, l.ttl).Result()
    if err != nil {
        return fmt.Errorf("redis setnx: %w", err)
    }
    if !ok {
        return ErrLockUnavailable
    }

    l.token = token
    l.acquired = true
    return nil
}

// AcquireWithRetry retries acquisition with exponential backoff
func (l *RedisLock) AcquireWithRetry(ctx context.Context, maxWait time.Duration) error {
    deadline := time.Now().Add(maxWait)
    backoff := 50 * time.Millisecond
    const maxBackoff = 2 * time.Second

    for {
        err := l.Acquire(ctx)
        if err == nil {
            return nil
        }
        if !errors.Is(err, ErrLockUnavailable) {
            return err
        }

        if time.Now().After(deadline) {
            return fmt.Errorf("%w: timed out after %v", ErrLockUnavailable, maxWait)
        }

        // Jitter to prevent thundering herd
        jitter := time.Duration(float64(backoff) * (0.5 + rand.Float64()*0.5))

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(jitter):
        }

        backoff = min(backoff*2, maxBackoff)
    }
}

// Release releases the lock. Only the owner can release.
func (l *RedisLock) Release(ctx context.Context) error {
    if !l.acquired {
        return ErrLockNotHeld
    }

    n, err := releaseLua.Run(ctx, l.client, []string{l.key}, l.token).Int64()
    if err != nil {
        return fmt.Errorf("redis release lua: %w", err)
    }

    if n == 0 {
        // Lock was taken by someone else (expired and re-acquired)
        l.acquired = false
        return ErrLockExpired
    }

    l.acquired = false
    return nil
}

// Renew extends the lock TTL. Returns error if lock is no longer held.
func (l *RedisLock) Renew(ctx context.Context) error {
    if !l.acquired {
        return ErrLockNotHeld
    }

    ttlMs := l.ttl.Milliseconds()
    n, err := renewLua.Run(ctx, l.client, []string{l.key}, l.token, ttlMs).Int64()
    if err != nil {
        return fmt.Errorf("redis renew lua: %w", err)
    }

    if n == 0 {
        l.acquired = false
        return ErrLockExpired
    }

    return nil
}

// WithAutoRenew runs fn while automatically renewing the lock.
// Returns an error if the lock expires before fn completes.
func (l *RedisLock) WithAutoRenew(ctx context.Context, fn func(ctx context.Context) error) error {
    if err := l.Acquire(ctx); err != nil {
        return err
    }
    defer l.Release(context.Background()) // nolint: errcheck

    // Create a context that's cancelled if the lock expires
    lockCtx, cancel := context.WithCancel(ctx)
    defer cancel()

    renewInterval := l.ttl / 3  // Renew at 1/3 of TTL
    renewErrs := make(chan error, 1)

    go func() {
        ticker := time.NewTicker(renewInterval)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                if err := l.Renew(lockCtx); err != nil {
                    renewErrs <- err
                    cancel()
                    return
                }
            case <-lockCtx.Done():
                return
            }
        }
    }()

    fnErr := fn(lockCtx)

    // Check if renewal failed
    select {
    case renewErr := <-renewErrs:
        if fnErr == nil {
            return fmt.Errorf("lock expired during operation: %w", renewErr)
        }
    default:
    }

    return fnErr
}
```

### Redlock: Multi-Instance Redis Lock

The Redlock algorithm acquires locks from N independent Redis instances. A lock is considered acquired when N/2+1 instances respond positively within the total TTL:

```go
// internal/lock/redlock.go
package lock

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

// Redlock implements the Redlock algorithm for distributed locks
// across multiple independent Redis instances.
//
// WARNING: Redlock has known safety issues under certain failure scenarios
// (see Martin Kleppmann's analysis). For safety-critical locks, use
// etcd with fencing tokens instead.
type Redlock struct {
    nodes  []redis.UniversalClient
    key    string
    ttl    time.Duration
    quorum int
    token  string
}

// NewRedlock creates a Redlock across multiple Redis nodes
func NewRedlock(nodes []redis.UniversalClient, key string, ttl time.Duration) *Redlock {
    return &Redlock{
        nodes:  nodes,
        key:    key,
        ttl:    ttl,
        quorum: len(nodes)/2 + 1,
    }
}

// Acquire attempts to acquire the Redlock
func (r *Redlock) Acquire(ctx context.Context) error {
    token, err := generateToken()
    if err != nil {
        return err
    }

    startTime := time.Now()
    acquired := make([]bool, len(r.nodes))
    var wg sync.WaitGroup
    var mu sync.Mutex

    // Try to acquire lock on all nodes simultaneously
    for i, node := range r.nodes {
        wg.Add(1)
        go func(idx int, n redis.UniversalClient) {
            defer wg.Done()
            // Each individual acquisition gets a small timeout
            nodeCtx, cancel := context.WithTimeout(ctx, r.ttl/10)
            defer cancel()

            ok, err := n.SetNX(nodeCtx, r.key, token, r.ttl).Result()
            if err == nil && ok {
                mu.Lock()
                acquired[idx] = true
                mu.Unlock()
            }
        }(i, node)
    }

    wg.Wait()

    // Count successful acquisitions
    count := 0
    for _, ok := range acquired {
        if ok {
            count++
        }
    }

    // Validity time = TTL - elapsed - clock drift allowance
    elapsed := time.Since(startTime)
    clockDrift := r.ttl / 100  // 1% clock drift allowance
    validFor := r.ttl - elapsed - clockDrift

    if count >= r.quorum && validFor > 0 {
        r.token = token
        return nil
    }

    // Did not achieve quorum — release all acquired nodes
    r.releaseAll(context.Background(), token)
    return fmt.Errorf("%w: acquired %d/%d (need %d), validity %v",
        ErrLockUnavailable, count, len(r.nodes), r.quorum, validFor)
}

func (r *Redlock) releaseAll(ctx context.Context, token string) {
    for _, node := range r.nodes {
        releaseLua.Run(ctx, node, []string{r.key}, token) // nolint: errcheck
    }
}

// Release releases the Redlock from all nodes
func (r *Redlock) Release(ctx context.Context) error {
    if r.token == "" {
        return ErrLockNotHeld
    }
    r.releaseAll(ctx, r.token)
    r.token = ""
    return nil
}
```

**Important caveat**: Redlock is controversial. Martin Kleppmann's analysis identified scenarios where Redlock is unsafe under process pauses and clock drift. For operations where dual ownership would cause data corruption or financial loss, use etcd with fencing tokens instead.

## etcd-Based Locks with Fencing

etcd provides stronger guarantees than Redis for distributed coordination:

- **Linearizable reads**: Every read reflects the most recent write
- **Lease-based TTL**: Leases expire precisely, no clock drift concerns
- **Revision numbers**: Every modification increments a global revision, providing a natural fencing token
- **Watch API**: Get notified when a key changes, enabling efficient lock waiting

```go
// internal/lock/etcd_lock.go
package lock

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// EtcdLock implements a distributed lock using etcd
type EtcdLock struct {
    client  *clientv3.Client
    session *concurrency.Session
    mutex   *concurrency.Mutex
    prefix  string
}

// NewEtcdLock creates a new etcd-based distributed lock.
// ttl is the session TTL in seconds — the lock is held as long as the session is alive.
func NewEtcdLock(client *clientv3.Client, prefix string, ttl int) (*EtcdLock, error) {
    // A Session creates a lease that auto-renews while the holder is alive
    session, err := concurrency.NewSession(client, concurrency.WithTTL(ttl))
    if err != nil {
        return nil, fmt.Errorf("create etcd session: %w", err)
    }

    mutex := concurrency.NewMutex(session, prefix)

    return &EtcdLock{
        client:  client,
        session: session,
        mutex:   mutex,
        prefix:  prefix,
    }, nil
}

// Acquire blocks until the lock is acquired or ctx is cancelled
func (l *EtcdLock) Acquire(ctx context.Context) error {
    return l.mutex.Lock(ctx)
}

// TryAcquire attempts to acquire without blocking
func (l *EtcdLock) TryAcquire(ctx context.Context) error {
    return l.mutex.TryLock(ctx)
}

// Release releases the lock
func (l *EtcdLock) Release(ctx context.Context) error {
    return l.mutex.Unlock(ctx)
}

// Close releases the lock and closes the session
func (l *EtcdLock) Close() error {
    return l.session.Close()
}

// FencingToken returns the current revision as a fencing token.
// Use this token in all protected operations so that the resource can
// reject stale operations from old lock holders.
func (l *EtcdLock) FencingToken() int64 {
    return l.mutex.Header().Revision
}

// LeaderElection implements leader election using etcd
type LeaderElection struct {
    client   *clientv3.Client
    session  *concurrency.Session
    election *concurrency.Election
    prefix   string
    identity string
}

// NewLeaderElection creates a new leader election
func NewLeaderElection(client *clientv3.Client, prefix, identity string, ttl int) (*LeaderElection, error) {
    session, err := concurrency.NewSession(client, concurrency.WithTTL(ttl))
    if err != nil {
        return nil, fmt.Errorf("create etcd session: %w", err)
    }

    election := concurrency.NewElection(session, prefix)

    return &LeaderElection{
        client:   client,
        session:  session,
        election: election,
        prefix:   prefix,
        identity: identity,
    }, nil
}

// Campaign blocks until this instance becomes leader
func (e *LeaderElection) Campaign(ctx context.Context) error {
    return e.election.Campaign(ctx, e.identity)
}

// Resign gives up leadership
func (e *LeaderElection) Resign(ctx context.Context) error {
    return e.election.Resign(ctx)
}

// IsLeader returns true if this instance is currently the leader
func (e *LeaderElection) IsLeader(ctx context.Context) (bool, error) {
    resp, err := e.election.Leader(ctx)
    if err != nil {
        if err == concurrency.ErrElectionNoLeader {
            return false, nil
        }
        return false, err
    }

    for _, kv := range resp.Kvs {
        if string(kv.Value) == e.identity {
            return true, nil
        }
    }
    return false, nil
}

// WatchLeader returns a channel that receives leader identity changes
func (e *LeaderElection) WatchLeader(ctx context.Context) <-chan string {
    ch := make(chan string, 1)
    go func() {
        defer close(ch)
        for resp := range e.election.Observe(ctx) {
            for _, kv := range resp.Kvs {
                select {
                case ch <- string(kv.Value):
                case <-ctx.Done():
                    return
                }
            }
        }
    }()
    return ch
}

// Close cleans up election resources
func (e *LeaderElection) Close() error {
    return e.session.Close()
}
```

### Leader Election Pattern for Services

```go
// internal/leader/runner.go
package leader

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"

    "github.com/yourorg/service/internal/lock"
)

// Runner runs a function only on the leader instance
type Runner struct {
    election *lock.LeaderElection
    logger   *zap.Logger
}

func NewRunner(client *clientv3.Client, prefix, identity string, logger *zap.Logger) (*Runner, error) {
    election, err := lock.NewLeaderElection(client, prefix, identity, 15)
    if err != nil {
        return nil, err
    }
    return &Runner{election: election, logger: logger}, nil
}

// RunAsLeader blocks until this instance is elected leader, then runs fn.
// When the context is cancelled or fn returns, leadership is relinquished.
// The loop continues until ctx is cancelled.
func (r *Runner) RunAsLeader(ctx context.Context, fn func(ctx context.Context) error) error {
    defer r.election.Close()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        r.logger.Info("campaigning for leadership")

        // Campaign blocks until we become leader
        if err := r.election.Campaign(ctx); err != nil {
            if ctx.Err() != nil {
                return ctx.Err()
            }
            r.logger.Error("campaign failed, retrying", zap.Error(err))
            time.Sleep(5 * time.Second)
            continue
        }

        r.logger.Info("acquired leadership, running task")

        // Run the work function with a leader context
        leaderCtx, cancel := context.WithCancel(ctx)
        err := fn(leaderCtx)
        cancel()

        // Resign leadership after fn returns or errors
        resignCtx, resignCancel := context.WithTimeout(context.Background(), 5*time.Second)
        if resignErr := r.election.Resign(resignCtx); resignErr != nil {
            r.logger.Error("failed to resign leadership", zap.Error(resignErr))
        }
        resignCancel()

        if err != nil {
            r.logger.Error("leader task failed, re-campaigning", zap.Error(err))
            // Brief pause before re-campaigning to avoid tight loops
            time.Sleep(1 * time.Second)
        } else {
            r.logger.Info("leader task completed, re-campaigning")
        }
    }
}
```

## Implementing Fenced Operations

The fencing token is only useful if the protected resource checks it:

```go
// internal/database/fenced_writer.go
package database

import (
    "context"
    "database/sql"
    "errors"
    "fmt"
)

var ErrFencingTokenRejected = errors.New("fencing token rejected: stale lock holder")

// FencedDatabase wraps a database with fencing token support
// The database schema must include a fencing_token column on critical tables
type FencedDatabase struct {
    db *sql.DB
}

// UpdateWithFence performs an update only if the fencing token is >= the stored token.
// This prevents a stale lock holder from overwriting data written by the current holder.
func (f *FencedDatabase) UpdateWithFence(ctx context.Context, id int64, data string, fencingToken int64) error {
    result, err := f.db.ExecContext(ctx, `
        UPDATE critical_resources
        SET data = $1,
            fencing_token = $2,
            updated_at = NOW()
        WHERE id = $3
          AND fencing_token <= $2
    `, data, fencingToken, id)

    if err != nil {
        return fmt.Errorf("update with fence: %w", err)
    }

    rows, err := result.RowsAffected()
    if err != nil {
        return fmt.Errorf("get rows affected: %w", err)
    }

    if rows == 0 {
        return fmt.Errorf("%w: token %d rejected", ErrFencingTokenRejected, fencingToken)
    }

    return nil
}
```

## Distributed Semaphore

A semaphore allows N concurrent holders rather than just one:

```go
// internal/lock/semaphore.go
package lock

import (
    "context"
    "fmt"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// DistributedSemaphore limits concurrent access to a resource
type DistributedSemaphore struct {
    client  *clientv3.Client
    prefix  string
    limit   int
    session *concurrency.Session
}

func NewDistributedSemaphore(client *clientv3.Client, prefix string, limit, ttl int) (*DistributedSemaphore, error) {
    session, err := concurrency.NewSession(client, concurrency.WithTTL(ttl))
    if err != nil {
        return nil, fmt.Errorf("create session: %w", err)
    }
    return &DistributedSemaphore{
        client:  client,
        prefix:  prefix,
        limit:   limit,
        session: session,
    }, nil
}

// Acquire acquires one semaphore slot, blocking until available
func (s *DistributedSemaphore) Acquire(ctx context.Context) (func(), error) {
    key := fmt.Sprintf("%s/%x", s.prefix, s.session.Lease())

    for {
        // Count current holders
        resp, err := s.client.Get(ctx, s.prefix, clientv3.WithPrefix(), clientv3.WithCountOnly())
        if err != nil {
            return nil, fmt.Errorf("count semaphore holders: %w", err)
        }

        if resp.Count < int64(s.limit) {
            // Try to acquire a slot using the lease
            txn := s.client.Txn(ctx)
            txnResp, err := txn.
                If(clientv3.Compare(clientv3.Version(key), "=", 0)).
                Then(clientv3.OpPut(key, "1", clientv3.WithLease(s.session.Lease()))).
                Commit()

            if err != nil {
                return nil, fmt.Errorf("acquire semaphore slot: %w", err)
            }

            if txnResp.Succeeded {
                release := func() {
                    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                    defer cancel()
                    s.client.Delete(ctx, key) // nolint: errcheck
                }
                return release, nil
            }
        }

        // Wait for a slot to become available
        watchCh := s.client.Watch(ctx, s.prefix, clientv3.WithPrefix())
        select {
        case <-watchCh:
            // Retry
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }
}

// Close releases the semaphore session
func (s *DistributedSemaphore) Close() error {
    return s.session.Close()
}
```

## Lock Usage Patterns and Anti-Patterns

### Correct Pattern: Timeout and Context

```go
func processOrderExclusively(ctx context.Context, redisClient redis.UniversalClient, orderID string) error {
    l := lock.NewRedisLock(
        redisClient,
        fmt.Sprintf("order:lock:%s", orderID),
        30*time.Second,
    )

    // Acquire with retry — wait up to 10 seconds for lock
    if err := l.AcquireWithRetry(ctx, 10*time.Second); err != nil {
        if errors.Is(err, lock.ErrLockUnavailable) {
            return fmt.Errorf("order %s is being processed by another instance", orderID)
        }
        return fmt.Errorf("acquire lock: %w", err)
    }

    defer func() {
        releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := l.Release(releaseCtx); err != nil && !errors.Is(err, lock.ErrLockExpired) {
            slog.Error("failed to release lock", "order_id", orderID, "error", err)
        }
    }()

    // Do work within lock
    return processOrder(ctx, orderID)
}
```

### Anti-Pattern: Lock for Cache Stampede Prevention

Distributed locks for cache stampede prevention ("thundering herd") are overkill and introduce lock dependency for a caching problem. Use Redis's SETNX for the cache value itself with a short TTL:

```go
// WRONG: Using a lock to prevent cache stampede
func GetUserProfileWrong(ctx context.Context, userID int64) (*UserProfile, error) {
    l := lock.NewRedisLock(redisClient, fmt.Sprintf("fetch:user:%d", userID), 5*time.Second)
    l.Acquire(ctx)
    defer l.Release(ctx)
    // Now fetch from DB and set cache
    // This creates lock contention for every cache miss
}

// RIGHT: Use Redis probabilistic early expiration or request coalescing
func GetUserProfileRight(ctx context.Context, userID int64) (*UserProfile, error) {
    key := fmt.Sprintf("user:profile:%d", userID)

    // Try cache first
    data, err := redisClient.Get(ctx, key).Bytes()
    if err == nil {
        var profile UserProfile
        if err := json.Unmarshal(data, &profile); err == nil {
            return &profile, nil
        }
    }

    // Cache miss: use SETNX with a short "fetching" marker to prevent stampede
    lockKey := fmt.Sprintf("user:fetching:%d", userID)
    if set, _ := redisClient.SetNX(ctx, lockKey, "1", 5*time.Second).Result(); !set {
        // Another goroutine is fetching. Wait briefly and retry from cache.
        time.Sleep(100 * time.Millisecond)
        return GetUserProfileRight(ctx, userID)
    }
    defer redisClient.Del(ctx, lockKey)

    // Fetch from DB
    profile, err := db.GetUserProfile(ctx, userID)
    if err != nil {
        return nil, err
    }

    // Cache the result
    if data, err := json.Marshal(profile); err == nil {
        redisClient.Set(ctx, key, data, 5*time.Minute)
    }

    return profile, nil
}
```

### Testing Distributed Locks

```go
// internal/lock/redis_lock_test.go
package lock_test

import (
    "context"
    "errors"
    "sync"
    "sync/atomic"
    "testing"
    "time"

    "github.com/alicebob/miniredis/v2"
    "github.com/redis/go-redis/v9"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "github.com/yourorg/service/internal/lock"
)

func testRedisClient(t *testing.T) redis.UniversalClient {
    t.Helper()
    mr := miniredis.RunT(t)
    return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

func TestRedisLock_AcquireAndRelease(t *testing.T) {
    client := testRedisClient(t)
    l := lock.NewRedisLock(client, "test:lock", 30*time.Second)
    ctx := context.Background()

    require.NoError(t, l.Acquire(ctx))
    require.NoError(t, l.Release(ctx))
}

func TestRedisLock_MutualExclusion(t *testing.T) {
    client := testRedisClient(t)
    ctx := context.Background()

    var criticalSection int64
    var wg sync.WaitGroup
    const goroutines = 10

    for i := 0; i < goroutines; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            l := lock.NewRedisLock(client, "test:exclusion", 10*time.Second)

            if err := l.AcquireWithRetry(ctx, 30*time.Second); err != nil {
                t.Errorf("acquire failed: %v", err)
                return
            }
            defer l.Release(ctx)

            // Verify exclusive access
            val := atomic.LoadInt64(&criticalSection)
            time.Sleep(1 * time.Millisecond)
            atomic.StoreInt64(&criticalSection, val+1)
        }()
    }

    wg.Wait()
    assert.Equal(t, int64(goroutines), atomic.LoadInt64(&criticalSection))
}

func TestRedisLock_ExpiredLockIsDetected(t *testing.T) {
    mr := miniredis.RunT(t)
    client := redis.NewClient(&redis.Options{Addr: mr.Addr()})

    l := lock.NewRedisLock(client, "test:expire", 100*time.Millisecond)
    ctx := context.Background()

    require.NoError(t, l.Acquire(ctx))

    // Fast-forward time in miniredis to expire the lock
    mr.FastForward(200 * time.Millisecond)

    // Release should return ErrLockExpired
    err := l.Release(ctx)
    assert.True(t, errors.Is(err, lock.ErrLockExpired))
}
```

## Key Takeaways

Distributed locking is a nuanced topic where implementation details determine whether the lock actually provides the safety guarantees you expect:

1. **Use fencing tokens for any safety-critical operation**. A distributed lock without fencing tokens only provides best-effort exclusion. Process pauses (GC, CPU starvation) can cause a lock holder to execute after the lock has expired and been re-acquired by another process. Fencing tokens (via etcd revision numbers) allow the protected resource to reject stale operations.

2. **Redis single-instance locks are appropriate for low-stakes coordination**: preventing duplicate email sends, rate limiting, cache stampede prevention. For operations where simultaneous execution causes data corruption or financial loss, use etcd.

3. **Redlock is controversial and should not be used for safety-critical operations**. Martin Kleppmann's "How to do distributed locking" provides a comprehensive analysis of its weaknesses. The concurrency library in etcd's client package provides stronger guarantees.

4. **Always set a lock TTL**. A lock held indefinitely due to a crashed process will block all other instances. The TTL should be longer than your expected critical section duration but short enough that a crash doesn't block others for more than a few seconds.

5. **Auto-renewal must be treated as a lease, not a guarantee**. If the renewal goroutine fails to extend the TTL (due to network partition, Redis restart), the lock expires. The critical section must check context cancellation and handle the case where the lock was lost mid-operation.

6. **Distributed semaphores** (N concurrent holders) are the right abstraction when you need to limit concurrency without requiring exclusivity. Rate limiting API calls to an external service, limiting parallel database migrations, and capping concurrent batch jobs are all appropriate use cases.
