---
title: "Go Distributed Configuration: etcd Watch API and Dynamic Reconfiguration"
date: 2029-11-06T00:00:00-05:00
draft: false
tags: ["Go", "etcd", "Distributed Systems", "Configuration Management", "Kubernetes", "Leader Election"]
categories:
- Go
- Distributed Systems
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to building dynamic distributed configuration with etcd v3 client, Watch streams, lease TTL heartbeats, distributed locks, and zero-restart config reload in Go services."
more_link: "yes"
url: "/go-distributed-configuration-etcd-watch-api/"
---

Static configuration files work fine for simple deployments, but distributed systems require configuration that can change without restarting services. etcd, the distributed key-value store at the heart of Kubernetes, provides exactly the primitives needed: a consistent key-value store with watch notifications, lease-based TTLs, and transactional operations for distributed coordination.

<!--more-->

# Go Distributed Configuration: etcd Watch API and Dynamic Reconfiguration

## Why etcd for Distributed Configuration

etcd provides three guarantees that make it ideal for distributed configuration:

1. **Consistency**: All reads reflect the latest committed write (linearizability)
2. **Watch semantics**: Clients receive notifications for key changes without polling
3. **Leases**: Keys with TTLs enable heartbeat-based liveness and automatic cleanup

The etcd v3 API communicates over gRPC, and the official Go client (`go.etcd.io/etcd/client/v3`) provides a clean, context-aware interface.

## Setting Up the etcd v3 Client

```go
package config

import (
    "context"
    "crypto/tls"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"
)

// ClientConfig holds etcd connection parameters
type ClientConfig struct {
    Endpoints   []string
    DialTimeout time.Duration
    TLSConfig   *tls.Config
    Username    string
    Password    string
    Logger      *zap.Logger
}

// NewClient creates a configured etcd v3 client
func NewClient(cfg ClientConfig) (*clientv3.Client, error) {
    etcdCfg := clientv3.Config{
        Endpoints:   cfg.Endpoints,
        DialTimeout: cfg.DialTimeout,
        TLS:         cfg.TLSConfig,
        Username:    cfg.Username,
        Password:    cfg.Password,
        Logger:      cfg.Logger,

        // Disable the default log output that goes to stderr
        LogConfig: &zap.Config{
            Level:       zap.NewAtomicLevelAt(zap.WarnLevel),
            Development: false,
            Encoding:    "json",
            OutputPaths: []string{"stderr"},
        },
    }

    client, err := clientv3.New(etcdCfg)
    if err != nil {
        return nil, fmt.Errorf("creating etcd client: %w", err)
    }

    // Verify connectivity
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    _, err = client.Status(ctx, cfg.Endpoints[0])
    if err != nil {
        client.Close()
        return nil, fmt.Errorf("etcd connectivity check failed: %w", err)
    }

    return client, nil
}
```

```go
// main.go - connecting to etcd
package main

import (
    "crypto/tls"
    "log"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
)

func main() {
    // Production TLS connection
    tlsCfg, err := newTLSConfig("/etc/etcd/ca.crt", "/etc/etcd/client.crt", "/etc/etcd/client.key")
    if err != nil {
        log.Fatalf("loading TLS config: %v", err)
    }

    client, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"etcd-0.etcd:2379", "etcd-1.etcd:2379", "etcd-2.etcd:2379"},
        DialTimeout: 5 * time.Second,
        TLS:         tlsCfg,
    })
    if err != nil {
        log.Fatalf("connecting to etcd: %v", err)
    }
    defer client.Close()
}

func newTLSConfig(caFile, certFile, keyFile string) (*tls.Config, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading client cert/key: %w", err)
    }

    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("reading CA cert: %w", err)
    }

    caPool := x509.NewCertPool()
    caPool.AppendCertsFromPEM(caCert)

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        RootCAs:      caPool,
        MinVersion:   tls.VersionTLS13,
    }, nil
}
```

## Basic KV Operations

```go
package config

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
)

// KVStore wraps etcd client with typed operations
type KVStore struct {
    client *clientv3.Client
    prefix string
}

func NewKVStore(client *clientv3.Client, prefix string) *KVStore {
    return &KVStore{client: client, prefix: prefix}
}

func (s *KVStore) key(name string) string {
    return s.prefix + "/" + name
}

// Put stores a value with an optional lease
func (s *KVStore) Put(ctx context.Context, name string, value interface{}, opts ...clientv3.OpOption) error {
    data, err := json.Marshal(value)
    if err != nil {
        return fmt.Errorf("marshaling value: %w", err)
    }

    _, err = s.client.Put(ctx, s.key(name), string(data), opts...)
    if err != nil {
        return fmt.Errorf("putting key %s: %w", name, err)
    }
    return nil
}

// Get retrieves and unmarshals a value
func (s *KVStore) Get(ctx context.Context, name string, dest interface{}) (int64, error) {
    resp, err := s.client.Get(ctx, s.key(name))
    if err != nil {
        return 0, fmt.Errorf("getting key %s: %w", name, err)
    }

    if len(resp.Kvs) == 0 {
        return 0, fmt.Errorf("key %s not found", name)
    }

    kv := resp.Kvs[0]
    if err := json.Unmarshal(kv.Value, dest); err != nil {
        return 0, fmt.Errorf("unmarshaling value: %w", err)
    }

    return kv.ModRevision, nil
}

// GetAll retrieves all keys with a given prefix
func (s *KVStore) GetAll(ctx context.Context, prefix string) (map[string][]byte, error) {
    fullPrefix := s.key(prefix)
    resp, err := s.client.Get(ctx, fullPrefix, clientv3.WithPrefix())
    if err != nil {
        return nil, fmt.Errorf("getting prefix %s: %w", prefix, err)
    }

    result := make(map[string][]byte, len(resp.Kvs))
    trimLen := len(fullPrefix)
    for _, kv := range resp.Kvs {
        k := string(kv.Key)
        if len(k) > trimLen {
            k = k[trimLen:]
        }
        result[k] = kv.Value
    }
    return result, nil
}

// Delete removes a key
func (s *KVStore) Delete(ctx context.Context, name string) error {
    _, err := s.client.Delete(ctx, s.key(name))
    return err
}

// CompareAndSwap performs an atomic update
func (s *KVStore) CompareAndSwap(ctx context.Context, name string, oldRev int64, newValue interface{}) error {
    data, err := json.Marshal(newValue)
    if err != nil {
        return fmt.Errorf("marshaling value: %w", err)
    }

    txn := s.client.Txn(ctx)
    resp, err := txn.
        If(clientv3.Compare(clientv3.ModRevision(s.key(name)), "=", oldRev)).
        Then(clientv3.OpPut(s.key(name), string(data))).
        Else(clientv3.OpGet(s.key(name))).
        Commit()

    if err != nil {
        return fmt.Errorf("CAS transaction: %w", err)
    }

    if !resp.Succeeded {
        return fmt.Errorf("CAS failed: key modified by another writer (revision %d)", oldRev)
    }
    return nil
}
```

## Watch Streams

The Watch API is the most powerful feature of etcd for dynamic configuration. Instead of polling, watchers receive events as they happen.

```go
package config

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"
)

// WatchEvent represents a configuration change
type WatchEvent struct {
    Type      EventType
    Key       string
    Value     []byte
    OldValue  []byte
    Revision  int64
}

type EventType int

const (
    EventPut    EventType = iota
    EventDelete
)

// Watcher manages a watch stream and dispatches events
type Watcher struct {
    client   *clientv3.Client
    prefix   string
    handlers []func(WatchEvent)
    mu       sync.RWMutex
    log      *zap.Logger
}

func NewWatcher(client *clientv3.Client, prefix string, log *zap.Logger) *Watcher {
    return &Watcher{
        client: client,
        prefix: prefix,
        log:    log,
    }
}

// AddHandler registers a callback for watch events
func (w *Watcher) AddHandler(fn func(WatchEvent)) {
    w.mu.Lock()
    defer w.mu.Unlock()
    w.handlers = append(w.handlers, fn)
}

// Watch starts watching and blocks until ctx is cancelled
func (w *Watcher) Watch(ctx context.Context) error {
    // Start from the current revision to avoid replaying history
    // Use clientv3.WithCreatedNotify to know the watch is established
    watchChan := w.client.Watch(
        ctx,
        w.prefix,
        clientv3.WithPrefix(),
        clientv3.WithPrevKV(),   // Include previous value in events
        clientv3.WithCreatedNotify(),
    )

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case resp, ok := <-watchChan:
            if !ok {
                // Channel closed - client was closed
                return fmt.Errorf("watch channel closed")
            }

            if resp.Err() != nil {
                w.log.Error("watch error", zap.Error(resp.Err()))
                // etcd client will retry automatically; wait briefly
                select {
                case <-ctx.Done():
                    return ctx.Err()
                case <-time.After(time.Second):
                }
                continue
            }

            if resp.Created {
                w.log.Info("watch established",
                    zap.String("prefix", w.prefix),
                    zap.Int64("revision", resp.Header.Revision))
                continue
            }

            for _, event := range resp.Events {
                w.dispatch(event)
            }
        }
    }
}

func (w *Watcher) dispatch(event *clientv3.Event) {
    we := WatchEvent{
        Key:      string(event.Kv.Key),
        Value:    event.Kv.Value,
        Revision: event.Kv.ModRevision,
    }

    if event.Type == clientv3.EventTypeDelete {
        we.Type = EventDelete
    } else {
        we.Type = EventPut
    }

    if event.PrevKv != nil {
        we.OldValue = event.PrevKv.Value
    }

    w.mu.RLock()
    handlers := w.handlers
    w.mu.RUnlock()

    for _, h := range handlers {
        h(we)
    }
}
```

### Watch with Reconnection and Compaction Handling

```go
// ResilientWatcher handles compaction errors and reconnects
type ResilientWatcher struct {
    client    *clientv3.Client
    prefix    string
    onEvent   func(WatchEvent)
    onSync    func(map[string][]byte)  // Called after re-sync
    log       *zap.Logger
}

func (w *ResilientWatcher) Run(ctx context.Context) error {
    var revision int64

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Initial sync - get current state
        resp, err := w.client.Get(ctx, w.prefix, clientv3.WithPrefix())
        if err != nil {
            w.log.Error("initial sync failed", zap.Error(err))
            select {
            case <-ctx.Done():
                return ctx.Err()
            case <-time.After(5 * time.Second):
            }
            continue
        }

        // Build current state map
        state := make(map[string][]byte, len(resp.Kvs))
        for _, kv := range resp.Kvs {
            state[string(kv.Key)] = kv.Value
        }
        revision = resp.Header.Revision

        if w.onSync != nil {
            w.onSync(state)
        }

        // Start watching from the current revision
        err = w.watchFrom(ctx, revision+1)
        if err != nil {
            if ctx.Err() != nil {
                return ctx.Err()
            }
            w.log.Warn("watch interrupted, re-syncing", zap.Error(err))
        }
    }
}

func (w *ResilientWatcher) watchFrom(ctx context.Context, fromRevision int64) error {
    opts := []clientv3.OpOption{
        clientv3.WithPrefix(),
        clientv3.WithRev(fromRevision),
        clientv3.WithPrevKV(),
        clientv3.WithCreatedNotify(),
    }

    watchChan := w.client.Watch(ctx, w.prefix, opts...)

    for resp := range watchChan {
        if resp.Err() != nil {
            // mvcc: required revision has been compacted
            if resp.IsProgressNotify() {
                continue
            }
            return resp.Err()
        }

        for _, event := range resp.Events {
            we := WatchEvent{
                Key:      string(event.Kv.Key),
                Value:    event.Kv.Value,
                Revision: event.Kv.ModRevision,
            }
            if event.Type == clientv3.EventTypeDelete {
                we.Type = EventDelete
            } else {
                we.Type = EventPut
            }
            if event.PrevKv != nil {
                we.OldValue = event.PrevKv.Value
            }
            w.onEvent(we)
        }
    }

    return nil
}
```

## Lease TTL and Heartbeats

Leases provide time-based expiration. They are fundamental for service registration, distributed locks, and ephemeral configuration.

```go
package config

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"
)

// LeaseManager manages a lease with automatic keepalive
type LeaseManager struct {
    client  *clientv3.Client
    ttl     int64
    leaseID clientv3.LeaseID
    log     *zap.Logger
}

func NewLeaseManager(client *clientv3.Client, ttlSeconds int64, log *zap.Logger) *LeaseManager {
    return &LeaseManager{
        client: client,
        ttl:    ttlSeconds,
        log:    log,
    }
}

// Acquire creates a new lease and starts keepalive
func (lm *LeaseManager) Acquire(ctx context.Context) (clientv3.LeaseID, error) {
    resp, err := lm.client.Grant(ctx, lm.ttl)
    if err != nil {
        return 0, fmt.Errorf("granting lease: %w", err)
    }

    lm.leaseID = resp.ID
    lm.log.Info("lease acquired",
        zap.String("id", fmt.Sprintf("%x", resp.ID)),
        zap.Int64("ttl", lm.ttl))

    return resp.ID, nil
}

// KeepAlive starts the keepalive loop and blocks until ctx is cancelled
func (lm *LeaseManager) KeepAlive(ctx context.Context) error {
    // KeepAlive returns a channel that receives keepalive responses
    keepAliveChan, err := lm.client.KeepAlive(ctx, lm.leaseID)
    if err != nil {
        return fmt.Errorf("starting keepalive: %w", err)
    }

    for {
        select {
        case <-ctx.Done():
            // Revoke the lease on clean shutdown
            revokeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            defer cancel()
            _, err := lm.client.Revoke(revokeCtx, lm.leaseID)
            if err != nil {
                lm.log.Warn("failed to revoke lease", zap.Error(err))
            }
            return ctx.Err()

        case ka, ok := <-keepAliveChan:
            if !ok {
                // Keepalive channel closed - lease expired
                return fmt.Errorf("lease %x expired", lm.leaseID)
            }
            lm.log.Debug("lease keepalive",
                zap.Int64("ttl", ka.TTL),
                zap.String("id", fmt.Sprintf("%x", ka.ID)))
        }
    }
}

// ServiceRegistration registers a service with a lease-backed key
type ServiceRegistration struct {
    client   *clientv3.Client
    lease    *LeaseManager
    prefix   string
    instance string
    info     ServiceInfo
    log      *zap.Logger
}

type ServiceInfo struct {
    Address string `json:"address"`
    Port    int    `json:"port"`
    Version string `json:"version"`
    Tags    []string `json:"tags,omitempty"`
}

func (sr *ServiceRegistration) Register(ctx context.Context) error {
    // Acquire lease first
    leaseID, err := sr.lease.Acquire(ctx)
    if err != nil {
        return fmt.Errorf("acquiring lease: %w", err)
    }

    // Serialize service info
    data, err := json.Marshal(sr.info)
    if err != nil {
        return err
    }

    key := fmt.Sprintf("%s/%s", sr.prefix, sr.instance)

    // Put the key with the lease - it will be automatically deleted when lease expires
    _, err = sr.client.Put(ctx, key, string(data), clientv3.WithLease(leaseID))
    if err != nil {
        return fmt.Errorf("registering service: %w", err)
    }

    sr.log.Info("service registered",
        zap.String("key", key),
        zap.String("addr", sr.info.Address))

    return nil
}

func (sr *ServiceRegistration) Run(ctx context.Context) error {
    if err := sr.Register(ctx); err != nil {
        return err
    }
    // KeepAlive blocks until ctx is done or lease expires
    return sr.lease.KeepAlive(ctx)
}
```

## Dynamic Config Reload Without Restart

This is the core pattern: loading configuration from etcd and updating it in real-time as keys change.

```go
package config

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "sync/atomic"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"
)

// AppConfig represents application configuration
type AppConfig struct {
    LogLevel        string            `json:"log_level"`
    RateLimit       int               `json:"rate_limit"`
    MaxConnections  int               `json:"max_connections"`
    FeatureFlags    map[string]bool   `json:"feature_flags"`
    Backends        []BackendConfig   `json:"backends"`
    Timeout         time.Duration     `json:"timeout"`
}

type BackendConfig struct {
    Name    string `json:"name"`
    Address string `json:"address"`
    Weight  int    `json:"weight"`
}

// DynamicConfig manages live-reloading configuration
type DynamicConfig struct {
    client  *clientv3.Client
    prefix  string
    log     *zap.Logger

    // current holds the current config pointer; accessed atomically
    current atomic.Pointer[AppConfig]

    // subscribers are notified on every config change
    mu          sync.RWMutex
    subscribers []func(*AppConfig)
}

func NewDynamicConfig(client *clientv3.Client, prefix string, log *zap.Logger) *DynamicConfig {
    dc := &DynamicConfig{
        client: client,
        prefix: prefix,
        log:    log,
    }

    // Initialize with defaults
    defaults := &AppConfig{
        LogLevel:       "info",
        RateLimit:      1000,
        MaxConnections: 100,
        FeatureFlags:   map[string]bool{},
        Timeout:        30 * time.Second,
    }
    dc.current.Store(defaults)

    return dc
}

// Get returns the current configuration (safe for concurrent access)
func (dc *DynamicConfig) Get() *AppConfig {
    return dc.current.Load()
}

// Subscribe registers a callback invoked on every config change
func (dc *DynamicConfig) Subscribe(fn func(*AppConfig)) {
    dc.mu.Lock()
    defer dc.mu.Unlock()
    dc.subscribers = append(dc.subscribers, fn)
}

// Load performs the initial load from etcd
func (dc *DynamicConfig) Load(ctx context.Context) error {
    resp, err := dc.client.Get(ctx, dc.prefix+"/config")
    if err != nil {
        return fmt.Errorf("loading config: %w", err)
    }

    if len(resp.Kvs) == 0 {
        dc.log.Warn("no config found in etcd, using defaults")
        return nil
    }

    cfg := &AppConfig{}
    if err := json.Unmarshal(resp.Kvs[0].Value, cfg); err != nil {
        return fmt.Errorf("parsing config: %w", err)
    }

    dc.current.Store(cfg)
    dc.log.Info("config loaded from etcd",
        zap.String("log_level", cfg.LogLevel),
        zap.Int("rate_limit", cfg.RateLimit))

    return nil
}

// Watch starts the watch loop and applies updates dynamically
func (dc *DynamicConfig) Watch(ctx context.Context) error {
    // Load current value first
    if err := dc.Load(ctx); err != nil {
        return err
    }

    watchChan := dc.client.Watch(ctx, dc.prefix, clientv3.WithPrefix())

    dc.log.Info("watching for config changes", zap.String("prefix", dc.prefix))

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()

        case resp, ok := <-watchChan:
            if !ok {
                return fmt.Errorf("watch channel closed")
            }
            if err := resp.Err(); err != nil {
                dc.log.Error("watch error", zap.Error(err))
                continue
            }

            for _, event := range resp.Events {
                if err := dc.applyEvent(event); err != nil {
                    dc.log.Error("failed to apply config event",
                        zap.String("key", string(event.Kv.Key)),
                        zap.Error(err))
                }
            }
        }
    }
}

func (dc *DynamicConfig) applyEvent(event *clientv3.Event) error {
    key := string(event.Kv.Key)
    dc.log.Info("config event", zap.String("key", key), zap.Stringer("type", event.Type))

    switch {
    case event.Type == clientv3.EventTypeDelete:
        // Reset to defaults on delete
        dc.log.Warn("config key deleted, resetting to defaults", zap.String("key", key))
        return nil

    case key == dc.prefix+"/config":
        cfg := &AppConfig{}
        if err := json.Unmarshal(event.Kv.Value, cfg); err != nil {
            return fmt.Errorf("parsing full config: %w", err)
        }
        dc.update(cfg)

    case key == dc.prefix+"/rate_limit":
        var rate int
        if err := json.Unmarshal(event.Kv.Value, &rate); err != nil {
            return fmt.Errorf("parsing rate_limit: %w", err)
        }
        // Clone and update specific field
        old := dc.current.Load()
        cfg := *old  // shallow copy
        cfg.RateLimit = rate
        dc.update(&cfg)

    case key == dc.prefix+"/feature_flags":
        var flags map[string]bool
        if err := json.Unmarshal(event.Kv.Value, &flags); err != nil {
            return fmt.Errorf("parsing feature_flags: %w", err)
        }
        old := dc.current.Load()
        cfg := *old
        cfg.FeatureFlags = flags
        dc.update(&cfg)
    }

    return nil
}

func (dc *DynamicConfig) update(cfg *AppConfig) {
    old := dc.current.Swap(cfg)
    dc.log.Info("config updated",
        zap.String("log_level", cfg.LogLevel),
        zap.Int("rate_limit", cfg.RateLimit))

    // Notify subscribers
    dc.mu.RLock()
    subs := dc.subscribers
    dc.mu.RUnlock()

    for _, sub := range subs {
        sub(cfg)
    }

    _ = old // could log diff here
}
```

### Usage in Application

```go
func main() {
    log, _ := zap.NewProduction()
    defer log.Sync()

    client, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"localhost:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil {
        log.Fatal("connecting to etcd", zap.Error(err))
    }
    defer client.Close()

    dynCfg := config.NewDynamicConfig(client, "/myapp", log)

    // Subscribe to configuration changes
    dynCfg.Subscribe(func(cfg *config.AppConfig) {
        log.Info("config changed - updating rate limiter",
            zap.Int("new_rate", cfg.RateLimit))
        // Update rate limiter, reconnect backends, etc.
        updateRateLimiter(cfg.RateLimit)
    })

    dynCfg.Subscribe(func(cfg *config.AppConfig) {
        if cfg.FeatureFlags["debug_mode"] {
            log.SetLevel(zap.NewAtomicLevelAt(zap.DebugLevel))
        }
    })

    ctx, cancel := signal.NotifyContext(context.Background(),
        syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    g, gctx := errgroup.WithContext(ctx)

    // Start config watcher
    g.Go(func() error {
        return dynCfg.Watch(gctx)
    })

    // Start HTTP server
    g.Go(func() error {
        srv := &http.Server{
            Addr: ":8080",
            Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                cfg := dynCfg.Get()  // Always gets the latest config
                w.Write([]byte(fmt.Sprintf("rate_limit=%d\n", cfg.RateLimit)))
            }),
        }
        // ... serve
        return srv.ListenAndServe()
    })

    if err := g.Wait(); err != nil && !errors.Is(err, context.Canceled) {
        log.Fatal("service exited", zap.Error(err))
    }
}
```

## Distributed Locks with etcd

etcd's STM (Software Transactional Memory) and the concurrency package provide distributed locking primitives.

```go
package lock

import (
    "context"
    "fmt"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
    "go.uber.org/zap"
)

// DistributedLock wraps etcd's mutex for distributed critical sections
type DistributedLock struct {
    client   *clientv3.Client
    session  *concurrency.Session
    mutex    *concurrency.Mutex
    lockName string
    log      *zap.Logger
}

func NewDistributedLock(client *clientv3.Client, lockName string, ttlSeconds int, log *zap.Logger) (*DistributedLock, error) {
    session, err := concurrency.NewSession(client,
        concurrency.WithTTL(ttlSeconds),
        concurrency.WithContext(context.Background()),
    )
    if err != nil {
        return nil, fmt.Errorf("creating session: %w", err)
    }

    return &DistributedLock{
        client:   client,
        session:  session,
        mutex:    concurrency.NewMutex(session, "/locks/"+lockName),
        lockName: lockName,
        log:      log,
    }, nil
}

// Lock acquires the distributed lock, blocking until acquired or ctx cancelled
func (dl *DistributedLock) Lock(ctx context.Context) error {
    dl.log.Info("acquiring distributed lock", zap.String("name", dl.lockName))
    start := time.Now()

    if err := dl.mutex.Lock(ctx); err != nil {
        return fmt.Errorf("acquiring lock %s: %w", dl.lockName, err)
    }

    dl.log.Info("lock acquired",
        zap.String("name", dl.lockName),
        zap.Duration("wait", time.Since(start)))
    return nil
}

// TryLock attempts to acquire without blocking
func (dl *DistributedLock) TryLock(ctx context.Context) error {
    if err := dl.mutex.TryLock(ctx); err != nil {
        return fmt.Errorf("lock %s already held: %w", dl.lockName, err)
    }
    dl.log.Info("lock acquired (TryLock)", zap.String("name", dl.lockName))
    return nil
}

// Unlock releases the lock
func (dl *DistributedLock) Unlock(ctx context.Context) error {
    if err := dl.mutex.Unlock(ctx); err != nil {
        return fmt.Errorf("releasing lock %s: %w", dl.lockName, err)
    }
    dl.log.Info("lock released", zap.String("name", dl.lockName))
    return nil
}

// WithLock executes fn while holding the distributed lock
func (dl *DistributedLock) WithLock(ctx context.Context, fn func() error) error {
    if err := dl.Lock(ctx); err != nil {
        return err
    }
    defer dl.Unlock(context.Background())

    return fn()
}

// Close releases the session (and any held locks)
func (dl *DistributedLock) Close() error {
    return dl.session.Close()
}
```

### Leader Election Pattern

```go
package election

import (
    "context"
    "fmt"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
    "go.uber.org/zap"
)

// LeaderElector manages leader election for a group of instances
type LeaderElector struct {
    client    *clientv3.Client
    session   *concurrency.Session
    election  *concurrency.Election
    candidate string
    onLead    func(ctx context.Context)
    onResign  func()
    log       *zap.Logger
}

func NewLeaderElector(
    client *clientv3.Client,
    electionName, candidate string,
    ttlSeconds int,
    onLead func(ctx context.Context),
    onResign func(),
    log *zap.Logger,
) (*LeaderElector, error) {
    session, err := concurrency.NewSession(client,
        concurrency.WithTTL(ttlSeconds),
    )
    if err != nil {
        return nil, fmt.Errorf("creating session: %w", err)
    }

    return &LeaderElector{
        client:    client,
        session:   session,
        election:  concurrency.NewElection(session, "/elections/"+electionName),
        candidate: candidate,
        onLead:    onLead,
        onResign:  onResign,
        log:       log,
    }, nil
}

// Run campaigns for leadership and runs the leader function when elected
func (le *LeaderElector) Run(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            le.Resign(context.Background())
            return ctx.Err()
        default:
        }

        le.log.Info("campaigning for leadership",
            zap.String("candidate", le.candidate))

        // Campaign blocks until this instance is elected
        if err := le.election.Campaign(ctx, le.candidate); err != nil {
            if ctx.Err() != nil {
                return ctx.Err()
            }
            le.log.Error("campaign failed", zap.Error(err))
            continue
        }

        le.log.Info("elected as leader", zap.String("candidate", le.candidate))

        // Create a cancellable context for the leader function
        leaderCtx, leaderCancel := context.WithCancel(ctx)

        // Run leader logic in a goroutine
        done := make(chan struct{})
        go func() {
            defer close(done)
            le.onLead(leaderCtx)
        }()

        // Watch for leadership loss
        observeChan := le.election.Observe(ctx)
        for resp := range observeChan {
            if string(resp.Kvs[0].Value) != le.candidate {
                le.log.Warn("lost leadership",
                    zap.String("new_leader", string(resp.Kvs[0].Value)))
                leaderCancel()
                break
            }
        }

        leaderCancel()
        <-done  // Wait for leader function to complete

        if le.onResign != nil {
            le.onResign()
        }
    }
}

// Resign voluntarily gives up leadership
func (le *LeaderElector) Resign(ctx context.Context) error {
    return le.election.Resign(ctx)
}

// GetLeader returns the current leader's identity
func (le *LeaderElector) GetLeader(ctx context.Context) (string, error) {
    resp, err := le.election.Leader(ctx)
    if err != nil {
        return "", err
    }
    if len(resp.Kvs) == 0 {
        return "", fmt.Errorf("no leader elected")
    }
    return string(resp.Kvs[0].Value), nil
}
```

## Transactions and Compare-and-Set

etcd transactions provide multi-key atomic operations:

```go
// AtomicConfigUpdate updates multiple config keys atomically
func AtomicConfigUpdate(ctx context.Context, client *clientv3.Client,
    updates map[string]string, expectedRevision int64) error {

    // Build comparison conditions
    cmps := make([]clientv3.Cmp, 0, len(updates))
    for key := range updates {
        cmps = append(cmps, clientv3.Compare(
            clientv3.ModRevision(key), "=", expectedRevision,
        ))
    }

    // Build put operations
    ops := make([]clientv3.Op, 0, len(updates))
    for key, value := range updates {
        ops = append(ops, clientv3.OpPut(key, value))
    }

    txnResp, err := client.Txn(ctx).
        If(cmps...).
        Then(ops...).
        Else(clientv3.OpGet("/config", clientv3.WithPrefix())).
        Commit()

    if err != nil {
        return fmt.Errorf("transaction failed: %w", err)
    }

    if !txnResp.Succeeded {
        // Transaction failed - another writer modified the keys
        return fmt.Errorf("optimistic lock failed: keys were modified concurrently")
    }

    return nil
}

// ConditionalSet sets a key only if it doesn't already exist
func ConditionalSet(ctx context.Context, client *clientv3.Client, key, value string) (bool, error) {
    txnResp, err := client.Txn(ctx).
        If(clientv3.Compare(clientv3.Version(key), "=", 0)). // version=0 means key doesn't exist
        Then(clientv3.OpPut(key, value)).
        Else(clientv3.OpGet(key)).
        Commit()

    if err != nil {
        return false, err
    }
    return txnResp.Succeeded, nil
}
```

## End-to-End Example: Feature Flag Service

```go
// featureflags/service.go
package featureflags

import (
    "context"
    "encoding/json"
    "fmt"
    "sync/atomic"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.uber.org/zap"
)

type FlagValue struct {
    Enabled    bool    `json:"enabled"`
    Rollout    float64 `json:"rollout"`     // 0.0 - 1.0
    MaxVersion string  `json:"max_version"` // only enable for versions <= this
}

// FlagService manages feature flags stored in etcd
type FlagService struct {
    client *clientv3.Client
    prefix string
    flags  atomic.Pointer[map[string]FlagValue]
    log    *zap.Logger
}

func NewFlagService(client *clientv3.Client, prefix string, log *zap.Logger) *FlagService {
    fs := &FlagService{client: client, prefix: prefix, log: log}
    empty := make(map[string]FlagValue)
    fs.flags.Store(&empty)
    return fs
}

func (fs *FlagService) IsEnabled(flag string) bool {
    flags := fs.flags.Load()
    f, ok := (*flags)[flag]
    if !ok {
        return false  // Unknown flags default to disabled
    }
    return f.Enabled
}

func (fs *FlagService) RolloutPercentage(flag string) float64 {
    flags := fs.flags.Load()
    f, ok := (*flags)[flag]
    if !ok {
        return 0
    }
    return f.Rollout
}

func (fs *FlagService) Watch(ctx context.Context) error {
    // Initial load
    resp, err := fs.client.Get(ctx, fs.prefix, clientv3.WithPrefix())
    if err != nil {
        return err
    }

    flags := make(map[string]FlagValue)
    for _, kv := range resp.Kvs {
        name := string(kv.Key)[len(fs.prefix)+1:]
        var fv FlagValue
        if err := json.Unmarshal(kv.Value, &fv); err == nil {
            flags[name] = fv
        }
    }
    fs.flags.Store(&flags)

    fs.log.Info("feature flags loaded", zap.Int("count", len(flags)))

    // Watch for changes
    watchChan := fs.client.Watch(ctx, fs.prefix, clientv3.WithPrefix())
    for resp := range watchChan {
        for _, event := range resp.Events {
            fs.applyEvent(event)
        }
    }
    return nil
}

func (fs *FlagService) applyEvent(event *clientv3.Event) {
    flagName := string(event.Kv.Key)[len(fs.prefix)+1:]

    // Clone current flags
    current := fs.flags.Load()
    newFlags := make(map[string]FlagValue, len(*current))
    for k, v := range *current {
        newFlags[k] = v
    }

    if event.Type == clientv3.EventTypeDelete {
        delete(newFlags, flagName)
        fs.log.Info("feature flag removed", zap.String("flag", flagName))
    } else {
        var fv FlagValue
        if err := json.Unmarshal(event.Kv.Value, &fv); err != nil {
            fs.log.Error("invalid flag value",
                zap.String("flag", flagName), zap.Error(err))
            return
        }
        newFlags[flagName] = fv
        fs.log.Info("feature flag updated",
            zap.String("flag", flagName),
            zap.Bool("enabled", fv.Enabled),
            zap.Float64("rollout", fv.Rollout))
    }

    fs.flags.Store(&newFlags)
}

// SetFlag stores a feature flag in etcd
func (fs *FlagService) SetFlag(ctx context.Context, name string, fv FlagValue) error {
    data, err := json.Marshal(fv)
    if err != nil {
        return err
    }
    _, err = fs.client.Put(ctx, fmt.Sprintf("%s/%s", fs.prefix, name), string(data))
    return err
}

// DeleteFlag removes a feature flag
func (fs *FlagService) DeleteFlag(ctx context.Context, name string) error {
    _, err := fs.client.Delete(ctx, fmt.Sprintf("%s/%s", fs.prefix, name))
    return err
}
```

## Health Checks and Operational Concerns

```go
// EtcdHealthChecker monitors etcd cluster health
type EtcdHealthChecker struct {
    client    *clientv3.Client
    endpoints []string
    log       *zap.Logger
}

func (hc *EtcdHealthChecker) Check(ctx context.Context) map[string]error {
    results := make(map[string]error, len(hc.endpoints))
    for _, ep := range hc.endpoints {
        checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
        _, err := hc.client.Status(checkCtx, ep)
        cancel()
        results[ep] = err
    }
    return results
}

func (hc *EtcdHealthChecker) Healthy(ctx context.Context) bool {
    results := hc.Check(ctx)
    healthy := 0
    for _, err := range results {
        if err == nil {
            healthy++
        }
    }
    // Quorum requires majority
    return healthy > len(hc.endpoints)/2
}
```

## Summary

etcd's Watch API enables truly dynamic distributed configuration without service restarts. The key patterns covered in this post are:

- **v3 client setup** with TLS and timeout configuration for production use
- **KV operations** with type-safe marshaling and optimistic concurrency via `ModRevision`
- **Watch streams** with proper reconnection handling for etcd compaction events
- **Lease TTLs** with KeepAlive for service registration and heartbeat-based liveness
- **Distributed locks** via `concurrency.Mutex` backed by lease-bound sessions
- **Leader election** using `concurrency.Election` for active-passive failover
- **Atomic transactions** for multi-key updates with compare-and-set semantics
- **Feature flag service** combining Watch, atomic pointers, and copy-on-write for lock-free reads

The `atomic.Pointer[T]` pattern for storing configuration allows readers to access the current config without any locking, while the Watch goroutine atomically swaps in new values as they arrive from etcd.
