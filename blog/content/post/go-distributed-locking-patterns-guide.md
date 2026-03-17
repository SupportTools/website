---
title: "Go Distributed Locking Patterns: Redis Redlock, etcd Leases, and Postgres Advisory Locks"
date: 2028-05-05T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Redis", "etcd", "Locking", "Concurrency"]
categories: ["Go", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into distributed locking in Go covering Redis Redlock algorithm, etcd lease-based locks, PostgreSQL advisory locks, and how to choose the right approach for your use case."
more_link: "yes"
url: "/go-distributed-locking-patterns-guide/"
---

Distributed locking is one of the most deceptively difficult problems in systems programming. It sounds simple — prevent two processes from doing the same thing simultaneously — but the failure modes are subtle and the consequences of getting it wrong range from duplicate work to data corruption. This guide covers three production-proven distributed locking approaches in Go: Redis Redlock for high-throughput scenarios, etcd leases for strongly consistent locking in Kubernetes environments, and PostgreSQL advisory locks when your database is already your source of truth.

<!--more-->

# Go Distributed Locking Patterns: Redis Redlock, etcd Leases, and Postgres Advisory Locks

## The Distributed Locking Problem

Distributed locks differ fundamentally from in-process mutexes because the lock holder can fail without releasing the lock, the network can partition and cause split-brain, and clock skew makes TTL-based expiry unreliable.

Consider a cron job that runs on multiple replicas for high availability. Without distributed locking, every replica fires the job simultaneously. With a naive lock using a single Redis instance, a network partition between your application and Redis could leave the lock held indefinitely or cause two processes to believe they hold the lock.

A correct distributed lock must satisfy:
1. **Mutual exclusion**: At most one holder at any time
2. **Deadlock-free**: Lock eventually releases even if holder crashes
3. **Fault-tolerant**: Works even if some nodes fail

## Approach 1: Redis Redlock

Redlock is the algorithm proposed by Redis's creator for distributed locking across multiple independent Redis instances. It provides stronger guarantees than single-node locking by requiring a majority quorum.

### The Redlock Algorithm

Redlock works across N Redis instances (typically 5):

1. Record current time T1
2. Attempt to acquire lock on all N instances with a timeout much smaller than the lock TTL
3. Count successful acquisitions
4. If acquired on majority (N/2+1), compute elapsed time T2-T1
5. If elapsed time < lock TTL, lock is acquired
6. Otherwise, release lock on all instances and retry

### Implementation

```go
package redlock

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
	ErrLockNotAcquired = errors.New("lock not acquired")
	ErrLockNotOwned    = errors.New("lock not owned by this token")
)

// Lua script for atomic unlock — only release if we own the lock
const unlockScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end`

// Lua script for lock extension
const extendScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
else
    return 0
end`

type RedisClient interface {
	SetNX(ctx context.Context, key string, value interface{}, expiration time.Duration) *redis.BoolCmd
	Eval(ctx context.Context, script string, keys []string, args ...interface{}) *redis.Cmd
}

// RedlockClient implements the Redlock algorithm
type RedlockClient struct {
	clients       []RedisClient
	quorum        int
	retryCount    int
	retryDelay    time.Duration
	retryJitter   time.Duration
	clockDrift    float64  // fraction to subtract for clock drift compensation
}

// Lock represents a held distributed lock
type Lock struct {
	key       string
	token     string
	validity  time.Duration
	acquiredAt time.Time
	clients   []RedisClient
	quorum    int
}

// RemainingValidity returns how much lock time remains
func (l *Lock) RemainingValidity() time.Duration {
	elapsed := time.Since(l.acquiredAt)
	remaining := l.validity - elapsed
	if remaining < 0 {
		return 0
	}
	return remaining
}

// IsValid returns true if the lock has not expired
func (l *Lock) IsValid() bool {
	return l.RemainingValidity() > 0
}

func NewRedlockClient(clients []RedisClient, opts ...Option) *RedlockClient {
	rl := &RedlockClient{
		clients:     clients,
		quorum:      len(clients)/2 + 1,
		retryCount:  3,
		retryDelay:  200 * time.Millisecond,
		retryJitter: 100 * time.Millisecond,
		clockDrift:  0.01, // 1% clock drift compensation
	}
	for _, opt := range opts {
		opt(rl)
	}
	return rl
}

type Option func(*RedlockClient)

func WithRetryCount(n int) Option {
	return func(rl *RedlockClient) { rl.retryCount = n }
}

func WithRetryDelay(d time.Duration) Option {
	return func(rl *RedlockClient) { rl.retryDelay = d }
}

// generateToken creates a cryptographically random token
func generateToken() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generating token: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// Acquire attempts to acquire the lock with the given TTL
func (rl *RedlockClient) Acquire(ctx context.Context, key string, ttl time.Duration) (*Lock, error) {
	token, err := generateToken()
	if err != nil {
		return nil, err
	}

	for attempt := 0; attempt < rl.retryCount; attempt++ {
		if attempt > 0 {
			// Add jitter to avoid thundering herd
			delay := rl.retryDelay + time.Duration(float64(rl.retryJitter)*
				(float64(time.Now().UnixNano()%1000)/1000.0))
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}

		lock, err := rl.tryAcquire(ctx, key, token, ttl)
		if err == nil {
			return lock, nil
		}
		if !errors.Is(err, ErrLockNotAcquired) {
			return nil, err
		}
	}

	return nil, ErrLockNotAcquired
}

func (rl *RedlockClient) tryAcquire(ctx context.Context, key, token string, ttl time.Duration) (*Lock, error) {
	start := time.Now()

	// Try to acquire on all nodes concurrently
	type result struct {
		acquired bool
		err      error
	}

	results := make([]result, len(rl.clients))
	var wg sync.WaitGroup

	for i, client := range rl.clients {
		wg.Add(1)
		go func(idx int, c RedisClient) {
			defer wg.Done()

			// Use a per-node timeout shorter than the TTL
			nodeCtx, cancel := context.WithTimeout(ctx, ttl/10)
			defer cancel()

			ok, err := c.SetNX(nodeCtx, key, token, ttl).Result()
			results[idx] = result{acquired: ok && err == nil, err: err}
		}(i, client)
	}

	wg.Wait()

	// Count successful acquisitions
	acquired := 0
	for _, r := range results {
		if r.acquired {
			acquired++
		}
	}

	elapsed := time.Since(start)

	// Compute validity time accounting for clock drift
	drift := time.Duration(float64(ttl) * rl.clockDrift)
	validity := ttl - elapsed - drift

	if acquired >= rl.quorum && validity > 0 {
		return &Lock{
			key:        key,
			token:      token,
			validity:   validity,
			acquiredAt: time.Now(),
			clients:    rl.clients,
			quorum:     rl.quorum,
		}, nil
	}

	// Failed to get quorum — release any acquired locks
	rl.releaseAll(context.Background(), key, token)
	return nil, ErrLockNotAcquired
}

// Release releases the lock on all Redis instances
func (rl *RedlockClient) Release(ctx context.Context, lock *Lock) error {
	return rl.releaseAll(ctx, lock.key, lock.token)
}

func (rl *RedlockClient) releaseAll(ctx context.Context, key, token string) error {
	var wg sync.WaitGroup
	errs := make([]error, len(rl.clients))

	for i, client := range rl.clients {
		wg.Add(1)
		go func(idx int, c RedisClient) {
			defer wg.Done()
			result, err := c.Eval(ctx, unlockScript, []string{key}, token).Int()
			if err != nil {
				errs[idx] = err
			} else if result == 0 {
				errs[idx] = ErrLockNotOwned
			}
		}(i, client)
	}

	wg.Wait()

	// Return first non-nil error (release failures are non-fatal but logged)
	for _, err := range errs {
		if err != nil && !errors.Is(err, ErrLockNotOwned) {
			return err
		}
	}
	return nil
}

// Extend attempts to extend the lock's TTL
func (rl *RedlockClient) Extend(ctx context.Context, lock *Lock, ttl time.Duration) error {
	var wg sync.WaitGroup
	results := make([]bool, len(rl.clients))

	for i, client := range rl.clients {
		wg.Add(1)
		go func(idx int, c RedisClient) {
			defer wg.Done()
			result, err := c.Eval(ctx, extendScript,
				[]string{lock.key},
				lock.token,
				ttl.Milliseconds(),
			).Int()
			results[idx] = err == nil && result == 1
		}(i, client)
	}

	wg.Wait()

	extended := 0
	for _, ok := range results {
		if ok {
			extended++
		}
	}

	if extended >= rl.quorum {
		lock.validity = ttl
		lock.acquiredAt = time.Now()
		return nil
	}

	return ErrLockNotAcquired
}
```

### Usage with Automatic Renewal

A common pattern is to automatically renew the lock in the background:

```go
package main

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/acme/myapp/redlock"
)

func NewRedlockFromAddrs(addrs []string) *redlock.RedlockClient {
	clients := make([]redlock.RedisClient, len(addrs))
	for i, addr := range addrs {
		clients[i] = redis.NewClient(&redis.Options{
			Addr:         addr,
			DialTimeout:  1 * time.Second,
			ReadTimeout:  1 * time.Second,
			WriteTimeout: 1 * time.Second,
		})
	}
	return redlock.NewRedlockClient(clients,
		redlock.WithRetryCount(5),
		redlock.WithRetryDelay(100*time.Millisecond),
	)
}

// RunWithLock executes fn while holding a distributed lock.
// It automatically renews the lock at half the TTL interval.
func RunWithLock(ctx context.Context, rl *redlock.RedlockClient, key string, ttl time.Duration, fn func(ctx context.Context) error) error {
	lock, err := rl.Acquire(ctx, key, ttl)
	if err != nil {
		return fmt.Errorf("acquiring lock %q: %w", key, err)
	}

	// Context that cancels when lock is about to expire
	lockCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Background renewal goroutine
	renewDone := make(chan struct{})
	go func() {
		defer close(renewDone)
		renewInterval := ttl / 3 // Renew at 1/3 of TTL

		ticker := time.NewTicker(renewInterval)
		defer ticker.Stop()

		for {
			select {
			case <-lockCtx.Done():
				return
			case <-ticker.C:
				if !lock.IsValid() {
					slog.Error("lock expired before renewal", "key", key)
					cancel()
					return
				}

				if err := rl.Extend(ctx, lock, ttl); err != nil {
					slog.Error("failed to extend lock",
						"key", key,
						"error", err,
					)
					cancel()
					return
				}

				slog.Debug("lock renewed", "key", key, "remaining", lock.RemainingValidity())
			}
		}
	}()

	// Execute the protected function
	err = fn(lockCtx)

	// Stop renewal before releasing
	cancel()
	<-renewDone

	// Always release, even if fn errored
	if releaseErr := rl.Release(context.Background(), lock); releaseErr != nil {
		slog.Warn("failed to release lock", "key", key, "error", releaseErr)
	}

	return err
}

// Example: cron job that should only run on one replica
func main() {
	rl := NewRedlockFromAddrs([]string{
		"redis-0.redis:6379",
		"redis-1.redis:6379",
		"redis-2.redis:6379",
		"redis-3.redis:6379",
		"redis-4.redis:6379",
	})

	ctx := context.Background()

	err := RunWithLock(ctx, rl, "cron:daily-report", 5*time.Minute, func(ctx context.Context) error {
		slog.Info("generating daily report")
		return generateDailyReport(ctx)
	})

	if err != nil {
		slog.Error("daily report failed", "error", err)
	}
}

func generateDailyReport(ctx context.Context) error {
	// Long-running work here
	return nil
}
```

## Approach 2: etcd Lease-Based Locks

etcd provides strongly consistent distributed locking through its concurrency package. This is the right choice when you need linearizable lock semantics and are already running etcd (which you are if you run Kubernetes).

### etcd Concurrency Model

etcd leases are TTL-based keys that expire automatically. The `clientv3/concurrency` package builds distributed mutexes on top of leases using a leader-election pattern.

```go
package etcdlock

import (
	"context"
	"fmt"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

// EtcdLocker provides distributed locking via etcd
type EtcdLocker struct {
	client *clientv3.Client
	prefix string
}

func New(endpoints []string, prefix string) (*EtcdLocker, error) {
	client, err := clientv3.New(clientv3.Config{
		Endpoints:   endpoints,
		DialTimeout: 5 * time.Second,
		TLS:         nil, // Configure TLS for production
	})
	if err != nil {
		return nil, fmt.Errorf("creating etcd client: %w", err)
	}

	return &EtcdLocker{
		client: client,
		prefix: prefix,
	}, nil
}

// AcquiredLock holds an active etcd lock
type AcquiredLock struct {
	mutex   *concurrency.Mutex
	session *concurrency.Session
	key     string
}

// Acquire obtains a distributed lock, blocking until available or context cancels
func (l *EtcdLocker) Acquire(ctx context.Context, key string, ttl int) (*AcquiredLock, error) {
	// Create a session (lease) with the given TTL in seconds
	session, err := concurrency.NewSession(l.client,
		concurrency.WithTTL(ttl),
		concurrency.WithContext(ctx),
	)
	if err != nil {
		return nil, fmt.Errorf("creating etcd session: %w", err)
	}

	fullKey := fmt.Sprintf("%s/%s", l.prefix, key)
	mutex := concurrency.NewMutex(session, fullKey)

	if err := mutex.Lock(ctx); err != nil {
		session.Close()
		return nil, fmt.Errorf("acquiring etcd lock %q: %w", fullKey, err)
	}

	return &AcquiredLock{
		mutex:   mutex,
		session: session,
		key:     fullKey,
	}, nil
}

// TryAcquire attempts to acquire the lock without waiting
func (l *EtcdLocker) TryAcquire(ctx context.Context, key string, ttl int) (*AcquiredLock, error) {
	session, err := concurrency.NewSession(l.client,
		concurrency.WithTTL(ttl),
		concurrency.WithContext(ctx),
	)
	if err != nil {
		return nil, fmt.Errorf("creating etcd session: %w", err)
	}

	fullKey := fmt.Sprintf("%s/%s", l.prefix, key)
	mutex := concurrency.NewMutex(session, fullKey)

	if err := mutex.TryLock(ctx); err != nil {
		session.Close()
		return nil, fmt.Errorf("try-acquiring etcd lock %q: %w", fullKey, err)
	}

	return &AcquiredLock{
		mutex:   mutex,
		session: session,
		key:     fullKey,
	}, nil
}

// Release unlocks and closes the session
func (l *EtcdLocker) Release(ctx context.Context, lock *AcquiredLock) error {
	defer lock.session.Close()

	if err := lock.mutex.Unlock(ctx); err != nil {
		return fmt.Errorf("releasing etcd lock %q: %w", lock.key, err)
	}
	return nil
}

// SessionExpired returns a channel that closes when the session expires
// This allows the lock holder to detect premature expiry
func (lock *AcquiredLock) SessionExpired() <-chan struct{} {
	return lock.session.Done()
}
```

### Leader Election Pattern with etcd

etcd locks naturally support leader election for stateful services:

```go
package leader

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

type LeaderElector struct {
	client   *clientv3.Client
	election *concurrency.Election
	session  *concurrency.Session
	prefix   string
}

func NewLeaderElector(client *clientv3.Client, prefix string, ttl int) (*LeaderElector, error) {
	session, err := concurrency.NewSession(client,
		concurrency.WithTTL(ttl),
	)
	if err != nil {
		return nil, fmt.Errorf("creating session: %w", err)
	}

	election := concurrency.NewElection(session, prefix)

	return &LeaderElector{
		client:   client,
		election: election,
		session:  session,
		prefix:   prefix,
	}, nil
}

// RunAsLeader campaigns for leadership and runs fn when elected.
// fn receives a context that is cancelled when leadership is lost.
func (le *LeaderElector) RunAsLeader(ctx context.Context, fn func(ctx context.Context) error) error {
	hostname, _ := os.Hostname()
	value := fmt.Sprintf("%s-%d", hostname, os.Getpid())

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		slog.Info("campaigning for leadership", "candidate", value)

		// Campaign blocks until we become leader or ctx is cancelled
		if err := le.election.Campaign(ctx, value); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Error("campaign failed", "error", err)
			time.Sleep(5 * time.Second)
			continue
		}

		slog.Info("became leader", "candidate", value)

		// Create a context that cancels if we lose leadership
		leaderCtx, cancel := context.WithCancel(ctx)

		// Watch for session expiry
		go func() {
			defer cancel()
			select {
			case <-le.session.Done():
				slog.Warn("etcd session expired, stepping down")
			case <-ctx.Done():
			}
		}()

		// Run the leader function
		if err := fn(leaderCtx); err != nil {
			slog.Error("leader function failed", "error", err)
		}

		cancel()

		// Resign leadership
		if err := le.election.Resign(context.Background()); err != nil {
			slog.Warn("failed to resign leadership", "error", err)
		}

		slog.Info("resigned leadership, will re-campaign")

		// Brief pause before re-campaigning
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1 * time.Second):
		}
	}
}

// Observe watches for leader changes
func (le *LeaderElector) Observe(ctx context.Context) <-chan string {
	leaders := make(chan string, 1)

	go func() {
		defer close(leaders)
		ch := le.election.Observe(ctx)
		for resp := range ch {
			if len(resp.Kvs) > 0 {
				leaders <- string(resp.Kvs[0].Value)
			}
		}
	}()

	return leaders
}
```

### Kubernetes-Aware etcd Locking

When running in Kubernetes, use the in-cluster etcd or leverage the Kubernetes lease API:

```go
package k8slease

import (
	"context"
	"fmt"
	"os"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

// RunWithLeaderElection uses Kubernetes Lease objects for leader election
func RunWithLeaderElection(
	ctx context.Context,
	client kubernetes.Interface,
	namespace string,
	leaseName string,
	onStartedLeading func(ctx context.Context),
	onStoppedLeading func(),
	onNewLeader func(identity string),
) {
	id := fmt.Sprintf("%s_%s", os.Getenv("POD_NAME"), string([]byte{0}))

	lock := &resourcelock.LeaseLock{
		LeaseMeta: metav1.ObjectMeta{
			Name:      leaseName,
			Namespace: namespace,
		},
		Client: client.CoordinationV1(),
		LockConfig: resourcelock.ResourceLockConfig{
			Identity: id,
		},
	}

	leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
		Lock:                lock,
		ReleaseOnCancel:     true,
		LeaseDuration:       15 * time.Second,
		RenewDeadline:       10 * time.Second,
		RetryPeriod:         2 * time.Second,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: onStartedLeading,
			OnStoppedLeading: onStoppedLeading,
			OnNewLeader:      onNewLeader,
		},
	})
}
```

## Approach 3: PostgreSQL Advisory Locks

PostgreSQL advisory locks are the right tool when your service already uses PostgreSQL and you want transactional locking semantics without adding Redis or etcd to your stack.

### PostgreSQL Advisory Lock Types

PostgreSQL offers two advisory lock types:
- **Session-level**: Held until explicitly released or session ends
- **Transaction-level**: Automatically released when the transaction ends

And two acquisition modes:
- **Exclusive**: Only one holder
- **Shared**: Multiple readers, exclusive writers

```go
package pglock

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var ErrLockNotAcquired = errors.New("lock not acquired: already held by another session")

// AdvisoryLocker provides PostgreSQL advisory lock operations
type AdvisoryLocker struct {
	db *sql.DB
}

func New(db *sql.DB) *AdvisoryLocker {
	return &AdvisoryLocker{db: db}
}

// KeyToInt64 converts a string key to a stable int64 for use as a lock id.
// Uses SHA-256 to distribute keys uniformly across the int64 space.
func KeyToInt64(key string) int64 {
	hash := sha256.Sum256([]byte(key))
	return int64(binary.BigEndian.Uint64(hash[:8]))
}

// AcquireSessionLock acquires a session-level advisory lock.
// Blocks until the lock is available or ctx is cancelled.
func (l *AdvisoryLocker) AcquireSessionLock(ctx context.Context, db *sql.Conn, key string) error {
	id := KeyToInt64(key)
	_, err := db.ExecContext(ctx, "SELECT pg_advisory_lock($1)", id)
	if err != nil {
		return fmt.Errorf("acquiring advisory lock %q (id=%d): %w", key, id, err)
	}
	return nil
}

// TryAcquireSessionLock attempts a non-blocking lock acquisition.
// Returns ErrLockNotAcquired if the lock is currently held.
func (l *AdvisoryLocker) TryAcquireSessionLock(ctx context.Context, db *sql.Conn, key string) error {
	id := KeyToInt64(key)

	var acquired bool
	err := db.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", id).Scan(&acquired)
	if err != nil {
		return fmt.Errorf("try-acquiring advisory lock %q: %w", key, err)
	}
	if !acquired {
		return ErrLockNotAcquired
	}
	return nil
}

// ReleaseSessionLock releases a session-level advisory lock
func (l *AdvisoryLocker) ReleaseSessionLock(ctx context.Context, db *sql.Conn, key string) error {
	id := KeyToInt64(key)
	_, err := db.ExecContext(ctx, "SELECT pg_advisory_unlock($1)", id)
	if err != nil {
		return fmt.Errorf("releasing advisory lock %q: %w", key, err)
	}
	return nil
}

// WithTransactionLock executes fn within a transaction that holds an advisory lock.
// The lock is automatically released when the transaction commits or rolls back.
func (l *AdvisoryLocker) WithTransactionLock(ctx context.Context, key string, fn func(tx *sql.Tx) error) error {
	id := KeyToInt64(key)

	tx, err := l.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}

	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()

	// pg_advisory_xact_lock is automatically released at transaction end
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", id); err != nil {
		return fmt.Errorf("acquiring transaction advisory lock %q: %w", key, err)
	}

	if err = fn(tx); err != nil {
		return err
	}

	return tx.Commit()
}

// WithTryTransactionLock is like WithTransactionLock but non-blocking
func (l *AdvisoryLocker) WithTryTransactionLock(ctx context.Context, key string, fn func(tx *sql.Tx) error) error {
	id := KeyToInt64(key)

	tx, err := l.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}

	defer func() {
		if err != nil {
			tx.Rollback()
		}
	}()

	var acquired bool
	if err = tx.QueryRowContext(ctx, "SELECT pg_try_advisory_xact_lock($1)", id).Scan(&acquired); err != nil {
		return fmt.Errorf("try-acquiring transaction lock %q: %w", key, err)
	}
	if !acquired {
		return ErrLockNotAcquired
	}

	if err = fn(tx); err != nil {
		return err
	}

	return tx.Commit()
}

// SessionLockManager manages a pool of dedicated connections for session locks.
// Session-level advisory locks are tied to a specific connection, so we need
// to ensure the same connection is used for acquire and release.
type SessionLockManager struct {
	locker *AdvisoryLocker
	conn   *sql.Conn
	locks  map[string]bool
}

func (l *AdvisoryLocker) NewSessionLockManager(ctx context.Context) (*SessionLockManager, error) {
	conn, err := l.db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquiring dedicated connection: %w", err)
	}

	return &SessionLockManager{
		locker: l,
		conn:   conn,
		locks:  make(map[string]bool),
	}, nil
}

func (m *SessionLockManager) Acquire(ctx context.Context, key string) error {
	if err := m.locker.AcquireSessionLock(ctx, m.conn, key); err != nil {
		return err
	}
	m.locks[key] = true
	return nil
}

func (m *SessionLockManager) TryAcquire(ctx context.Context, key string) error {
	if err := m.locker.TryAcquireSessionLock(ctx, m.conn, key); err != nil {
		return err
	}
	m.locks[key] = true
	return nil
}

func (m *SessionLockManager) Release(ctx context.Context, key string) error {
	if !m.locks[key] {
		return nil
	}
	if err := m.locker.ReleaseSessionLock(ctx, m.conn, key); err != nil {
		return err
	}
	delete(m.locks, key)
	return nil
}

func (m *SessionLockManager) Close() error {
	return m.conn.Close()
}
```

### Practical PostgreSQL Advisory Lock Usage

```go
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/acme/myapp/pglock"
)

// JobRunner ensures distributed job execution using pg advisory locks
type JobRunner struct {
	locker *pglock.AdvisoryLocker
	db     *sql.DB
}

func (r *JobRunner) RunJob(ctx context.Context, jobName string, fn func(ctx context.Context, tx *sql.Tx) error) error {
	lockKey := fmt.Sprintf("job:%s", jobName)

	err := r.locker.WithTryTransactionLock(ctx, lockKey, func(tx *sql.Tx) error {
		// Mark job as running in DB within the same transaction
		_, err := tx.ExecContext(ctx,
			"INSERT INTO job_runs (job_name, started_at, node_id) VALUES ($1, $2, $3) ON CONFLICT (job_name) DO UPDATE SET started_at = $2, node_id = $3",
			jobName, time.Now(), nodeID(),
		)
		if err != nil {
			return fmt.Errorf("recording job start: %w", err)
		}

		return fn(ctx, tx)
	})

	if err != nil {
		if err == pglock.ErrLockNotAcquired {
			slog.Info("job already running on another node, skipping", "job", jobName)
			return nil
		}
		return fmt.Errorf("running job %q: %w", jobName, err)
	}

	return nil
}

// Example: deduplicated payment processing
func (r *JobRunner) ProcessPayment(ctx context.Context, paymentID string) error {
	lockKey := fmt.Sprintf("payment:%s", paymentID)

	return r.locker.WithTransactionLock(ctx, lockKey, func(tx *sql.Tx) error {
		// Check if already processed within the same transaction
		var status string
		err := tx.QueryRowContext(ctx,
			"SELECT status FROM payments WHERE id = $1 FOR UPDATE",
			paymentID,
		).Scan(&status)
		if err != nil {
			return fmt.Errorf("querying payment: %w", err)
		}

		if status != "pending" {
			slog.Info("payment already processed", "id", paymentID, "status", status)
			return nil
		}

		// Process and update within the transaction
		_, err = tx.ExecContext(ctx,
			"UPDATE payments SET status = 'processing', updated_at = NOW() WHERE id = $1",
			paymentID,
		)
		if err != nil {
			return fmt.Errorf("updating payment status: %w", err)
		}

		// Perform payment processing...
		slog.Info("processing payment", "id", paymentID)

		_, err = tx.ExecContext(ctx,
			"UPDATE payments SET status = 'completed', completed_at = NOW() WHERE id = $1",
			paymentID,
		)
		return err
	})
}

func nodeID() string {
	// Return hostname or pod name
	return "node-1"
}
```

## Choosing the Right Approach

| Criterion | Redis Redlock | etcd Lease | PG Advisory Lock |
|-----------|--------------|------------|------------------|
| Consistency | Probabilistic | Linearizable | Serializable |
| Throughput | Very high | High | Medium |
| TTL granularity | Milliseconds | Seconds | N/A (transaction) |
| Failure semantics | Best-effort | Strong | Transactional |
| Infrastructure | Redis cluster | etcd cluster | PostgreSQL |
| Use case | Rate limiting, idempotency keys | Leader election, coordination | Job deduplication, entity locking |

**Use Redis Redlock when:**
- You need sub-second TTLs
- You're already operating Redis
- Occasional duplicate execution is acceptable (idempotent operations)
- High throughput is required (thousands of lock operations per second)

**Use etcd leases when:**
- You need linearizable consistency guarantees
- You're running Kubernetes and want to reuse existing etcd
- Implementing leader election for stateful services
- The system must be partition-tolerant and consistent

**Use PostgreSQL advisory locks when:**
- The work is inherently transactional (update records while holding lock)
- You want lock and work in the same transaction boundary
- You're already using PostgreSQL and don't want to add dependencies
- Lower throughput requirements (database I/O bottleneck)

## Lock Safety and Anti-Patterns

### Never Use Locks as Correctness Guarantees for Slow Operations

```go
// WRONG: If the lock expires during the slow operation, another process
// will acquire it and both will proceed simultaneously
func badPattern(ctx context.Context) error {
	lock, _ := rl.Acquire(ctx, "my-lock", 5*time.Second)
	defer rl.Release(ctx, lock)

	time.Sleep(10 * time.Second) // Longer than lock TTL!
	return doWork(ctx)
}

// CORRECT: Use fencing tokens to detect lock expiry
func goodPattern(ctx context.Context) error {
	lock, err := rl.Acquire(ctx, "my-lock", 5*time.Second)
	if err != nil {
		return err
	}

	// Use lock context to detect expiry
	workCtx, cancel := context.WithDeadline(ctx, time.Now().Add(lock.RemainingValidity()-100*time.Millisecond))
	defer cancel()
	defer rl.Release(context.Background(), lock)

	return doWork(workCtx) // Work is bounded by lock validity
}
```

### Fencing Tokens with Storage Systems

For storage operations, use fencing tokens to prevent stale writes from expired lock holders:

```go
// Storage systems that support conditional writes can check fencing tokens
func writeWithFencing(ctx context.Context, lock *Lock, data []byte) error {
	// Include the lock's unique token as a fencing token
	// The storage system rejects writes with stale tokens
	return storage.ConditionalWrite(ctx, "my-key", data, storage.WithFencingToken(lock.token))
}
```

## Testing Distributed Locks

```go
package redlock_test

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestMutualExclusion(t *testing.T) {
	rl := setupTestRedlock(t)
	ctx := context.Background()

	const goroutines = 10
	var mu sync.Mutex
	counter := 0
	inCritical := false

	var wg sync.WaitGroup
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()

			err := RunWithLock(ctx, rl, "test:counter", 5*time.Second, func(ctx context.Context) error {
				mu.Lock()
				if inCritical {
					t.Error("mutual exclusion violated: two goroutines in critical section")
				}
				inCritical = true
				mu.Unlock()

				time.Sleep(50 * time.Millisecond) // Simulate work

				mu.Lock()
				counter++
				inCritical = false
				mu.Unlock()
				return nil
			})

			if err != nil {
				t.Errorf("lock failed: %v", err)
			}
		}()
	}

	wg.Wait()

	if counter != goroutines {
		t.Errorf("expected counter=%d, got %d", goroutines, counter)
	}
}
```

## Conclusion

Distributed locking is not a one-size-fits-all problem. Redis Redlock excels at high-throughput scenarios with probabilistic consistency, etcd provides the strongest guarantees for leader election and Kubernetes-native workloads, and PostgreSQL advisory locks offer transactional semantics that eliminate entire classes of race conditions when your work is already database-bound.

The most important rule is to always pair your lock with an appropriate timeout mechanism and never assume a held lock guarantees safety for operations that exceed the TTL. Build fencing into your design from the start, and test your locking code under simulated failures — network partitions, process crashes, and clock skew — before going to production.
