---
title: "Go Distributed Locking: Redis, etcd, and Database-Backed Mutex Patterns"
date: 2030-08-29T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Redis", "etcd", "PostgreSQL", "Locking", "Concurrency"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Production distributed locks in Go: Redlock with go-redis, etcd lease-based locking, PostgreSQL advisory locks, TTL and heartbeat renewal, deadlock detection, and choosing the right locking strategy."
more_link: "yes"
url: "/go-distributed-locking-redis-etcd-database-mutex-patterns/"
---

Distributed locks coordinate access to shared resources across multiple service instances. Unlike in-process mutexes, distributed locks must handle network partitions, lock holder crashes, and clock skew. Choosing the wrong locking mechanism — or implementing it incorrectly — leads to both safety violations (multiple holders simultaneously) and liveness failures (lock never released after holder crash). This post covers three production-grade distributed lock implementations in Go: Redlock with Redis, lease-based locking with etcd, and PostgreSQL advisory locks, with guidance on which to use for different consistency requirements.

<!--more-->

## Fundamental Properties of Distributed Locks

A correct distributed lock must provide:

1. **Mutual exclusion**: At most one client holds the lock at any time.
2. **Deadlock-free**: The lock will eventually be released even if the holder crashes (via TTL/lease expiry).
3. **Fault tolerance**: The lock remains available even if some (but not all) of the backing nodes fail.

There is a fundamental tension between consistency (strong mutual exclusion guarantees) and availability (the lock can always be acquired and released). Martin Kleppmann's critique of Redlock highlights that in the presence of process pauses (GC stop-the-world, OS scheduling), even a TTL-based lock can have two simultaneous holders. Production systems must handle this by adding application-level fencing (a monotonic token that resource servers reject if they see an older token).

## Redis Distributed Locking with Redlock

### The Redlock Algorithm

Redlock acquires a lock by attempting to `SET NX PX` on N independent Redis nodes (typically 5). A lock is considered acquired if the client successfully locked a majority (N/2 + 1 = 3) of the nodes within a time window shorter than the lock TTL:

```
elapsed = time spent acquiring locks
drift = TTL * CLOCK_DRIFT_FACTOR + 2ms
validity = TTL - elapsed - drift
```

If `validity > 0` after acquiring a majority, the lock is valid for `validity` milliseconds.

### Implementation with go-redis

```go
// pkg/lock/redis.go
package lock

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

const (
    clockDriftFactor = 0.01  // 1% clock drift factor
    minValidity      = 10 * time.Millisecond
)

// RedisLock represents a distributed lock backed by multiple Redis nodes.
type RedisLock struct {
    clients    []*redis.Client
    key        string
    value      string  // Random unique value to prevent releasing another holder's lock
    ttl        time.Duration
    acquiredAt time.Time
    quorum     int
}

// RedisLocker manages distributed locks across multiple Redis instances.
type RedisLocker struct {
    clients    []*redis.Client
    retryCount int
    retryDelay time.Duration
}

// NewRedisLocker creates a Redlock-compatible locker from multiple Redis clients.
// Pass independent Redis instances (not replicas of each other) for Redlock guarantees.
func NewRedisLocker(clients []*redis.Client, opts ...Option) *RedisLocker {
    l := &RedisLocker{
        clients:    clients,
        retryCount: 3,
        retryDelay: 200 * time.Millisecond,
    }
    for _, opt := range opts {
        opt(l)
    }
    return l
}

type Option func(*RedisLocker)

func WithRetryCount(n int) Option {
    return func(l *RedisLocker) { l.retryCount = n }
}

func WithRetryDelay(d time.Duration) Option {
    return func(l *RedisLocker) { l.retryDelay = d }
}

// Acquire attempts to acquire a distributed lock on the given key.
// Returns a *RedisLock if successful, or an error if the lock cannot be acquired
// after retryCount attempts.
func (l *RedisLocker) Acquire(ctx context.Context, key string, ttl time.Duration) (*RedisLock, error) {
    value, err := generateValue()
    if err != nil {
        return nil, fmt.Errorf("generate lock value: %w", err)
    }

    for attempt := 0; attempt < l.retryCount; attempt++ {
        lock, err := l.tryAcquire(ctx, key, value, ttl)
        if err == nil {
            return lock, nil
        }

        // Wait before retry, respecting context cancellation
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-time.After(l.retryDelay):
        }
    }

    return nil, fmt.Errorf("failed to acquire lock %q after %d attempts", key, l.retryCount)
}

func (l *RedisLocker) tryAcquire(ctx context.Context, key, value string, ttl time.Duration) (*RedisLock, error) {
    start := time.Now()
    quorum := len(l.clients)/2 + 1
    acquired := 0
    var lastErr error

    for _, client := range l.clients {
        if err := setNX(ctx, client, key, value, ttl); err != nil {
            lastErr = err
        } else {
            acquired++
        }
    }

    elapsed := time.Since(start)
    drift := time.Duration(float64(ttl)*clockDriftFactor) + 2*time.Millisecond
    validity := ttl - elapsed - drift

    if acquired >= quorum && validity > minValidity {
        return &RedisLock{
            clients:    l.clients,
            key:        key,
            value:      value,
            ttl:        ttl,
            acquiredAt: start,
            quorum:     quorum,
        }, nil
    }

    // Failed to acquire quorum — release any partial locks
    for _, client := range l.clients {
        _ = deleteIfEqual(ctx, client, key, value)
    }

    if lastErr != nil {
        return nil, fmt.Errorf("quorum not reached (%d/%d): %w", acquired, quorum, lastErr)
    }
    return nil, fmt.Errorf("quorum not reached (%d/%d nodes), validity=%v", acquired, quorum, validity)
}

// Validity returns the remaining validity duration of the lock.
func (l *RedisLock) Validity() time.Duration {
    drift := time.Duration(float64(l.ttl)*clockDriftFactor) + 2*time.Millisecond
    remaining := l.ttl - time.Since(l.acquiredAt) - drift
    if remaining < 0 {
        return 0
    }
    return remaining
}

// Extend renews the lock TTL. Returns error if the lock is no longer held.
func (l *RedisLock) Extend(ctx context.Context, ttl time.Duration) error {
    n := 0
    for _, client := range l.clients {
        if ok, err := extendIfEqual(ctx, client, l.key, l.value, ttl); err == nil && ok {
            n++
        }
    }
    if n < l.quorum {
        return fmt.Errorf("lock extension failed: only %d/%d nodes extended", n, l.quorum)
    }
    l.acquiredAt = time.Now()
    l.ttl = ttl
    return nil
}

// Release releases the lock on all Redis nodes.
func (l *RedisLock) Release(ctx context.Context) error {
    n := 0
    var lastErr error
    for _, client := range l.clients {
        if err := deleteIfEqual(ctx, client, l.key, l.value); err != nil {
            lastErr = err
        } else {
            n++
        }
    }
    if lastErr != nil && n < l.quorum {
        return fmt.Errorf("lock release partially failed: %w", lastErr)
    }
    return nil
}

// Lua script: delete key only if value matches (atomic compare-and-delete)
var luaDelete = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
`)

// Lua script: extend TTL only if value matches
var luaExtend = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
    return 0
end
`)

func setNX(ctx context.Context, client *redis.Client, key, value string, ttl time.Duration) error {
    ok, err := client.SetNX(ctx, key, value, ttl).Result()
    if err != nil {
        return err
    }
    if !ok {
        return fmt.Errorf("key %q already exists", key)
    }
    return nil
}

func deleteIfEqual(ctx context.Context, client *redis.Client, key, value string) error {
    return luaDelete.Run(ctx, client, []string{key}, value).Err()
}

func extendIfEqual(ctx context.Context, client *redis.Client, key, value string, ttl time.Duration) (bool, error) {
    result, err := luaExtend.Run(ctx, client, []string{key}, value, int(ttl.Milliseconds())).Int()
    if err != nil {
        return false, err
    }
    return result == 1, nil
}

func generateValue() (string, error) {
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return base64.RawURLEncoding.EncodeToString(b), nil
}
```

### Heartbeat-Based Lock Renewal

For long-running operations, use a background goroutine to renew the lock before expiry:

```go
// pkg/lock/heartbeat.go
package lock

import (
    "context"
    "log/slog"
    "time"
)

// WithHeartbeat runs fn while maintaining the lock via periodic renewal.
// The lock is renewed at half the TTL interval. If renewal fails, the context
// passed to fn is cancelled to signal the operation should abort.
func WithHeartbeat(
    ctx context.Context,
    lock *RedisLock,
    ttl time.Duration,
    logger *slog.Logger,
    fn func(ctx context.Context) error,
) error {
    lockCtx, cancelLock := context.WithCancel(ctx)
    defer cancelLock()

    renewInterval := ttl / 2
    errCh := make(chan error, 1)

    // Start renewal goroutine
    go func() {
        ticker := time.NewTicker(renewInterval)
        defer ticker.Stop()

        for {
            select {
            case <-lockCtx.Done():
                return
            case <-ticker.C:
                if lock.Validity() < renewInterval {
                    if err := lock.Extend(lockCtx, ttl); err != nil {
                        logger.ErrorContext(lockCtx, "lock renewal failed",
                            "key", lock.key,
                            "error", err,
                        )
                        cancelLock() // Signal the operation to abort
                        errCh <- fmt.Errorf("lock renewal failed: %w", err)
                        return
                    }
                    logger.DebugContext(lockCtx, "lock renewed",
                        "key", lock.key,
                        "validity", lock.Validity(),
                    )
                }
            }
        }
    }()

    // Run the protected operation
    opErr := fn(lockCtx)

    // Check if renewal failed
    select {
    case renewErr := <-errCh:
        if opErr != nil {
            return fmt.Errorf("operation failed and lock renewal failed: op=%v renewal=%v", opErr, renewErr)
        }
        return renewErr
    default:
    }

    return opErr
}
```

### Fencing Tokens for Safety

For strict safety against split-brain scenarios, use a fencing token alongside the lock:

```go
// pkg/lock/fencing.go
package lock

import (
    "context"
    "fmt"
    "sync/atomic"
)

// FencingToken is a monotonically increasing token for resource access validation.
// The resource server must reject requests with a token lower than the last seen.
type FencingToken struct {
    token uint64
}

// Next returns the next fencing token.
func (ft *FencingToken) Next() uint64 {
    return atomic.AddUint64(&ft.token, 1)
}

// AcquireWithToken acquires a Redis lock and returns a fencing token.
// The token must be sent to the resource server on every operation.
func (l *RedisLocker) AcquireWithToken(
    ctx context.Context,
    key string,
    ttl time.Duration,
    tokenGen *FencingToken,
) (*RedisLock, uint64, error) {
    lock, err := l.Acquire(ctx, key, ttl)
    if err != nil {
        return nil, 0, err
    }
    token := tokenGen.Next()
    return lock, token, nil
}
```

## etcd Lease-Based Locking

etcd provides strongly consistent distributed primitives through Raft consensus. etcd leases are the foundation for its distributed lock implementation. Unlike Redis, etcd guarantees linearizability — reads and writes reflect the most recent state across all nodes.

### etcd Lock with Lease Renewal

```go
// pkg/lock/etcd.go
package lock

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// EtcdLocker provides distributed locking via etcd.
type EtcdLocker struct {
    client *clientv3.Client
    logger *slog.Logger
}

// NewEtcdLocker creates a new etcd-based locker.
func NewEtcdLocker(endpoints []string, tlsConfig interface{}, logger *slog.Logger) (*EtcdLocker, error) {
    client, err := clientv3.New(clientv3.Config{
        Endpoints:   endpoints,
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        return nil, fmt.Errorf("etcd client: %w", err)
    }
    return &EtcdLocker{client: client, logger: logger}, nil
}

// EtcdLock wraps an etcd mutex with its session.
type EtcdLock struct {
    session *concurrency.Session
    mutex   *concurrency.Mutex
    key     string
}

// Acquire acquires the named lock. The lock is held for the duration of the
// lease TTL, which is automatically renewed while the session is active.
// The lock is released when Release is called or when the context is cancelled.
func (l *EtcdLocker) Acquire(ctx context.Context, key string, ttlSeconds int) (*EtcdLock, error) {
    // Create a session with lease TTL
    session, err := concurrency.NewSession(l.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("etcd session: %w", err)
    }

    mutex := concurrency.NewMutex(session, "/locks/"+key)

    // TryLock returns immediately if the lock is held by another client.
    // Use Lock to block waiting for the lock.
    if err := mutex.TryLock(ctx); err != nil {
        session.Close()
        if err == concurrency.ErrLocked {
            return nil, fmt.Errorf("lock %q is held by another client", key)
        }
        return nil, fmt.Errorf("acquire lock %q: %w", key, err)
    }

    l.logger.InfoContext(ctx, "etcd lock acquired",
        "key", key,
        "revision", mutex.Header().Revision,
    )

    return &EtcdLock{
        session: session,
        mutex:   mutex,
        key:     key,
    }, nil
}

// AcquireBlocking acquires the lock, blocking until it becomes available or
// the context is cancelled.
func (l *EtcdLocker) AcquireBlocking(ctx context.Context, key string, ttlSeconds int) (*EtcdLock, error) {
    session, err := concurrency.NewSession(l.client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(ctx),
    )
    if err != nil {
        return nil, fmt.Errorf("etcd session: %w", err)
    }

    mutex := concurrency.NewMutex(session, "/locks/"+key)

    if err := mutex.Lock(ctx); err != nil {
        session.Close()
        return nil, fmt.Errorf("blocking lock %q: %w", key, err)
    }

    return &EtcdLock{
        session: session,
        mutex:   mutex,
        key:     key,
    }, nil
}

// FencingToken returns the etcd revision when the lock was acquired.
// This is a natural fencing token — higher revisions are always more recent.
func (l *EtcdLock) FencingToken() int64 {
    return l.mutex.Header().Revision
}

// Release releases the lock and closes the session.
func (l *EtcdLock) Release(ctx context.Context) error {
    if err := l.mutex.Unlock(ctx); err != nil {
        return fmt.Errorf("unlock %q: %w", l.key, err)
    }
    return l.session.Close()
}

// IsAlive checks if the session lease is still active.
func (l *EtcdLock) IsAlive() bool {
    select {
    case <-l.session.Done():
        return false
    default:
        return true
    }
}
```

### etcd Lock with Watch for Deadlock Detection

```go
// pkg/lock/etcd_watch.go
package lock

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

// ObserveCurrentHolder returns information about the current lock holder.
func (l *EtcdLocker) ObserveCurrentHolder(ctx context.Context, key string) (string, int64, error) {
    resp, err := l.client.Get(ctx, "/locks/"+key, clientv3.WithPrefix())
    if err != nil {
        return "", 0, err
    }

    // etcd concurrency uses a sorted key scheme; the holder has the lowest key
    if len(resp.Kvs) == 0 {
        return "", 0, nil
    }

    kv := resp.Kvs[0]
    return string(kv.Value), kv.CreateRevision, nil
}

// WaitForLock blocks until the given key's lock is available, up to deadline.
// Returns a channel that receives nil when the lock becomes available,
// or an error if the context expires.
func (l *EtcdLocker) WaitForLock(ctx context.Context, key string) error {
    // Watch for DELETE events on the lock key
    watchCh := l.client.Watch(ctx, "/locks/"+key,
        clientv3.WithPrefix(),
        clientv3.WithFilterPut(),
    )

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case resp, ok := <-watchCh:
            if !ok {
                return fmt.Errorf("watch channel closed")
            }
            for _, event := range resp.Events {
                if event.Type == clientv3.EventTypeDelete {
                    return nil // Lock was released
                }
            }
        }
    }
}
```

## PostgreSQL Advisory Locks

PostgreSQL provides session-level and transaction-level advisory locks. These are ideal when your service already uses PostgreSQL and you want to avoid introducing a separate distributed lock system.

### Advisory Lock Implementation

```go
// pkg/lock/postgres.go
package lock

import (
    "context"
    "database/sql"
    "fmt"
    "hash/fnv"
    "sync"
)

// PostgresLocker provides distributed locking via PostgreSQL advisory locks.
type PostgresLocker struct {
    db       *sql.DB
    acquired map[int64]*pgLockState
    mu       sync.Mutex
}

type pgLockState struct {
    lockID int64
    conn   *sql.Conn
}

// NewPostgresLocker creates a new PostgreSQL advisory locker.
func NewPostgresLocker(db *sql.DB) *PostgresLocker {
    return &PostgresLocker{
        db:       db,
        acquired: make(map[int64]*pgLockState),
    }
}

// lockIDFromKey converts a string key to a PostgreSQL advisory lock ID (int64).
// Uses FNV-1a hash for distribution.
func lockIDFromKey(key string) int64 {
    h := fnv.New64a()
    h.Write([]byte(key))
    return int64(h.Sum64())
}

// PostgresLock represents a held PostgreSQL advisory lock.
type PostgresLock struct {
    lockID int64
    conn   *sql.Conn
    locker *PostgresLocker
}

// TryAcquire attempts to acquire a session-level advisory lock without blocking.
// Returns nil, nil if the lock is held by another connection.
func (l *PostgresLocker) TryAcquire(ctx context.Context, key string) (*PostgresLock, error) {
    lockID := lockIDFromKey(key)

    // Use a dedicated connection to hold the session-level lock
    conn, err := l.db.Conn(ctx)
    if err != nil {
        return nil, fmt.Errorf("get connection: %w", err)
    }

    var acquired bool
    row := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", lockID)
    if err := row.Scan(&acquired); err != nil {
        conn.Close()
        return nil, fmt.Errorf("pg_try_advisory_lock(%d): %w", lockID, err)
    }

    if !acquired {
        conn.Close()
        return nil, nil // lock held by another
    }

    l.mu.Lock()
    l.acquired[lockID] = &pgLockState{lockID: lockID, conn: conn}
    l.mu.Unlock()

    return &PostgresLock{
        lockID: lockID,
        conn:   conn,
        locker: l,
    }, nil
}

// Acquire acquires a session-level advisory lock, blocking until available.
func (l *PostgresLocker) Acquire(ctx context.Context, key string) (*PostgresLock, error) {
    lockID := lockIDFromKey(key)

    conn, err := l.db.Conn(ctx)
    if err != nil {
        return nil, fmt.Errorf("get connection: %w", err)
    }

    // pg_advisory_lock blocks until the lock is available or context is cancelled
    _, err = conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", lockID)
    if err != nil {
        conn.Close()
        return nil, fmt.Errorf("pg_advisory_lock(%d): %w", lockID, err)
    }

    return &PostgresLock{
        lockID: lockID,
        conn:   conn,
        locker: l,
    }, nil
}

// Release releases the advisory lock and returns the connection to the pool.
func (l *PostgresLock) Release(ctx context.Context) error {
    _, err := l.conn.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", l.lockID)
    if err != nil {
        return fmt.Errorf("pg_advisory_unlock(%d): %w", l.lockID, err)
    }

    l.locker.mu.Lock()
    delete(l.locker.acquired, l.lockID)
    l.locker.mu.Unlock()

    return l.conn.Close()
}

// AcquireXact acquires a transaction-level advisory lock.
// The lock is automatically released when the transaction commits or rolls back.
// This is safer for operations that are naturally transactional.
func (l *PostgresLocker) AcquireXact(ctx context.Context, tx *sql.Tx, key string) error {
    lockID := lockIDFromKey(key)
    _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", lockID)
    if err != nil {
        return fmt.Errorf("pg_advisory_xact_lock(%d): %w", lockID, err)
    }
    return nil
}

// TryAcquireXact attempts to acquire a transaction-level advisory lock without blocking.
func (l *PostgresLocker) TryAcquireXact(ctx context.Context, tx *sql.Tx, key string) (bool, error) {
    lockID := lockIDFromKey(key)
    var acquired bool
    row := tx.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock($1)", lockID)
    if err := row.Scan(&acquired); err != nil {
        return false, fmt.Errorf("pg_try_advisory_xact_lock(%d): %w", lockID, err)
    }
    return acquired, nil
}
```

### PostgreSQL Lock for Scheduled Job Deduplication

A common use case for advisory locks is ensuring a scheduled job runs on only one pod at a time:

```go
// pkg/scheduler/dedup.go
package scheduler

import (
    "context"
    "database/sql"
    "log/slog"
    "time"

    "enterprise.example.com/service/pkg/lock"
)

// JobRunner runs scheduled jobs with distributed deduplication via advisory locks.
type JobRunner struct {
    locker *lock.PostgresLocker
    logger *slog.Logger
}

// Run executes fn if the lock can be acquired. Skips silently if another instance is running.
func (r *JobRunner) Run(ctx context.Context, jobName string, fn func(ctx context.Context) error) error {
    pgLock, err := r.locker.TryAcquire(ctx, "job:"+jobName)
    if err != nil {
        return fmt.Errorf("lock acquisition error: %w", err)
    }
    if pgLock == nil {
        r.logger.InfoContext(ctx, "job already running elsewhere, skipping",
            "job", jobName,
        )
        return nil
    }
    defer func() {
        releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        if err := pgLock.Release(releaseCtx); err != nil {
            r.logger.ErrorContext(ctx, "failed to release job lock",
                "job", jobName,
                "error", err,
            )
        }
    }()

    r.logger.InfoContext(ctx, "running job", "job", jobName)
    if err := fn(ctx); err != nil {
        return fmt.Errorf("job %s failed: %w", jobName, err)
    }
    r.logger.InfoContext(ctx, "job completed", "job", jobName)
    return nil
}
```

## Deadlock Detection and Prevention

### Timeout-Based Deadlock Prevention

```go
// pkg/lock/timeout.go
package lock

import (
    "context"
    "fmt"
    "time"
)

// AcquireWithTimeout wraps lock acquisition with a hard timeout.
// This prevents indefinite blocking in cases where the lock holder has crashed
// but the TTL has not yet expired.
func AcquireWithTimeout[L any](
    ctx context.Context,
    timeout time.Duration,
    acquireFn func(ctx context.Context) (L, error),
) (L, error) {
    timeoutCtx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    lock, err := acquireFn(timeoutCtx)
    if err != nil {
        if timeoutCtx.Err() == context.DeadlineExceeded {
            var zero L
            return zero, fmt.Errorf("lock acquisition timed out after %v: %w", timeout, err)
        }
        var zero L
        return zero, err
    }
    return lock, nil
}
```

### Lock Ordering to Prevent Deadlocks

When acquiring multiple locks, always acquire them in a canonical order:

```go
// pkg/lock/multi.go
package lock

import (
    "context"
    "sort"
)

// AcquireMultiple acquires multiple locks in a canonical sorted order to prevent deadlocks.
// All locks are acquired atomically (if any fails, previously acquired locks are released).
func AcquireMultipleRedis(ctx context.Context, locker *RedisLocker, keys []string, ttl time.Duration) ([]*RedisLock, error) {
    // Sort keys to ensure consistent lock ordering across all callers
    sortedKeys := make([]string, len(keys))
    copy(sortedKeys, keys)
    sort.Strings(sortedKeys)

    acquired := make([]*RedisLock, 0, len(sortedKeys))

    for _, key := range sortedKeys {
        lock, err := locker.Acquire(ctx, key, ttl)
        if err != nil {
            // Release previously acquired locks
            for _, l := range acquired {
                _ = l.Release(ctx)
            }
            return nil, fmt.Errorf("failed to acquire lock %q: %w", key, err)
        }
        acquired = append(acquired, lock)
    }

    return acquired, nil
}
```

## Choosing the Right Locking Mechanism

| Requirement | Redis Redlock | etcd | PostgreSQL Advisory |
|-------------|--------------|------|---------------------|
| Strict linearizability | No (see Kleppmann critique) | Yes | Yes (per-connection) |
| Sub-millisecond latency | Yes | No (Raft RTT ~1-5ms) | No (SQL RTT) |
| Already using PostgreSQL | No | No | Yes |
| No additional dependencies | No | No | Yes |
| Cross-datacenter replication | Complex | Native | Via replication |
| Lease auto-renewal | Manual | Native | Session lifetime |
| Fencing tokens | Manual | Native (revision) | Manual |

### When to Use Redis Redlock

- High-throughput operations where lock acquisition latency matters (< 1ms)
- Cache invalidation coordination
- Rate limiting tokens
- Idempotency key tracking
- **Not** for operations where strict mutual exclusion is a hard safety requirement (use etcd or PostgreSQL instead)

### When to Use etcd

- Leader election for stateful services
- Kubernetes controller coordination
- Service discovery registration
- Any operation where Raft-level consistency is required
- When you already have etcd in the cluster (Kubernetes clusters always have etcd)

### When to Use PostgreSQL Advisory Locks

- Scheduled job deduplication
- Per-tenant resource operations where the same PostgreSQL instance is used
- Simple services that do not need Redis or etcd dependencies
- Transaction-level coordination (lock released automatically on commit/rollback)

## Testing Distributed Locks

### Unit Testing with Testcontainers

```go
// pkg/lock/redis_test.go
package lock_test

import (
    "context"
    "testing"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"

    "enterprise.example.com/service/pkg/lock"
)

func TestRedisLockMutualExclusion(t *testing.T) {
    ctx := context.Background()

    req := testcontainers.ContainerRequest{
        Image:        "redis:7-alpine",
        ExposedPorts: []string{"6379/tcp"},
        WaitingFor:   wait.ForLog("Ready to accept connections"),
    }
    container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: req,
        Started:          true,
    })
    if err != nil {
        t.Fatalf("start Redis container: %v", err)
    }
    defer container.Terminate(ctx)

    endpoint, _ := container.Endpoint(ctx, "")
    client := redis.NewClient(&redis.Options{Addr: endpoint})

    // Use a single Redis instance for unit testing (not production Redlock)
    locker := lock.NewRedisLocker([]*redis.Client{client})

    // Acquire first lock
    lock1, err := locker.Acquire(ctx, "test-resource", 30*time.Second)
    if err != nil {
        t.Fatalf("acquire lock1: %v", err)
    }
    defer lock1.Release(ctx)

    // Attempt to acquire same key (should fail)
    lock2, err := locker.Acquire(ctx, "test-resource", 30*time.Second)
    if err == nil {
        lock2.Release(ctx)
        t.Fatal("expected lock acquisition to fail while lock1 is held")
    }

    // Release first lock
    if err := lock1.Release(ctx); err != nil {
        t.Fatalf("release lock1: %v", err)
    }

    // Now the second attempt should succeed
    lock3, err := locker.Acquire(ctx, "test-resource", 30*time.Second)
    if err != nil {
        t.Fatalf("acquire lock3 after release: %v", err)
    }
    defer lock3.Release(ctx)
}

func TestPostgresAdvisoryLock(t *testing.T) {
    // Verify two goroutines cannot hold the same advisory lock simultaneously
    db := openTestDB(t)
    locker := lock.NewPostgresLocker(db)
    ctx := context.Background()

    held := make(chan struct{})
    released := make(chan struct{})

    go func() {
        l, err := locker.Acquire(ctx, "test-advisory", )
        if err != nil {
            t.Errorf("goroutine 1 acquire: %v", err)
            return
        }
        close(held)
        <-released
        l.Release(ctx)
    }()

    // Wait for first goroutine to hold the lock
    <-held

    // Second acquisition should block until released
    tryCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    l2, err := locker.TryAcquire(tryCtx, "test-advisory")
    if err == nil && l2 != nil {
        l2.Release(ctx)
        t.Error("expected TryAcquire to fail while lock is held by goroutine 1")
    }

    // Signal release and verify second goroutine can now acquire
    close(released)
    time.Sleep(50 * time.Millisecond)

    l3, err := locker.TryAcquire(ctx, "test-advisory")
    if err != nil || l3 == nil {
        t.Errorf("expected to acquire lock after release: err=%v lock=%v", err, l3)
    }
    if l3 != nil {
        l3.Release(ctx)
    }
}
```

## Observability for Distributed Locks

```go
// pkg/lock/metrics.go
package lock

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
)

// LockMetrics instruments distributed lock operations.
type LockMetrics struct {
    acquisitions prometheus.CounterVec
    failures     prometheus.CounterVec
    waitDuration prometheus.HistogramVec
    holdDuration prometheus.HistogramVec
}

func NewLockMetrics(reg prometheus.Registerer) *LockMetrics {
    m := &LockMetrics{}

    m.acquisitions = *prometheus.NewCounterVec(prometheus.CounterOpts{
        Name: "distributed_lock_acquisitions_total",
        Help: "Total number of distributed lock acquisitions",
    }, []string{"backend", "key_prefix", "result"})

    m.waitDuration = *prometheus.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "distributed_lock_wait_seconds",
        Help:    "Time spent waiting to acquire a distributed lock",
        Buckets: []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0},
    }, []string{"backend", "key_prefix"})

    reg.MustRegister(m.acquisitions, m.waitDuration)
    return m
}

func (m *LockMetrics) RecordAcquisition(backend, key string, wait time.Duration, success bool) {
    result := "success"
    if !success {
        result = "failure"
    }
    prefix := keyPrefix(key)
    m.acquisitions.WithLabelValues(backend, prefix, result).Inc()
    m.waitDuration.WithLabelValues(backend, prefix).Observe(wait.Seconds())
}

func keyPrefix(key string) string {
    if len(key) > 20 {
        return key[:20]
    }
    return key
}
```

## Summary

Distributed lock selection requires matching the lock implementation to the consistency and performance requirements of the protected operation. Redis Redlock is appropriate for performance-sensitive operations where occasional lock overlap (due to process pauses) is tolerable with application-level fencing. etcd provides linearizable guarantees with native fencing via Raft revision numbers, making it suitable for leader election and safety-critical coordination. PostgreSQL advisory locks require no additional infrastructure and provide transaction-scoped locking that is automatically released on transaction completion, making them ideal for services already using PostgreSQL. All three implementations must include TTL/lease to prevent permanent lock acquisition by crashed holders, and heartbeat renewal for operations that may outlast the TTL.
