---
title: "Go: Implementing Distributed Consensus with Raft Algorithm Using hashicorp/raft"
date: 2031-09-13T00:00:00-05:00
draft: false
tags: ["Go", "Golang", "Raft", "Distributed Systems", "Consensus", "hashicorp/raft", "Production"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "A practical guide to implementing distributed consensus in Go using the hashicorp/raft library, covering FSM design, log compaction, cluster membership changes, and production deployment patterns."
more_link: "yes"
url: "/go-distributed-consensus-raft-hashicorp-raft-library/"
---

Raft is the consensus algorithm behind etcd, CockroachDB, Consul, and dozens of other distributed systems that require strong consistency. The `hashicorp/raft` library brings the same battle-tested implementation that powers Consul and Nomad to any Go application. Building a correctly functioning Raft cluster requires understanding not just the API but the operational characteristics: log compaction, membership changes, quorum requirements, and what happens when nodes fail.

This guide builds a complete replicated key-value store using `hashicorp/raft`, covering all the components needed for production: FSM design, transport configuration, log persistence, snapshots, dynamic cluster membership, and monitoring.

<!--more-->

# Distributed Consensus with Raft in Go

## Raft Fundamentals

Raft provides consensus: a way for a cluster of nodes to agree on a sequence of commands even when some nodes fail. Key properties:

- **Leader election**: one node is elected leader; all writes go through the leader
- **Log replication**: the leader replicates log entries to followers; entries are committed when a quorum (majority) acknowledges them
- **Safety**: committed entries are never lost, even if the current leader fails
- **Liveness**: the cluster makes progress as long as a majority of nodes are available

### Quorum Requirements

For a cluster of N nodes to tolerate F failures, you need N ≥ 2F + 1:

| Cluster Size | Fault Tolerance |
|-------------|-----------------|
| 1 | 0 failures |
| 3 | 1 failure |
| 5 | 2 failures |
| 7 | 3 failures |

Always deploy Raft clusters with odd node counts.

## Architecture of Our Key-Value Store

```
Client HTTP Request
        │
        ▼
  [ KV Store API ]
        │
        │  apply command
        ▼
  [ Raft Node ]  ──── Log Replication ────▶  [ Follower 1 ]
        │                                          │
        │  commit                           [ Follower 2 ]
        ▼
  [ FSM.Apply() ]
        │
        ▼
  [ In-Memory Map ]
```

## Project Structure

```
kvstore/
├── main.go
├── store/
│   ├── store.go        # KV store with Raft integration
│   ├── fsm.go          # Finite State Machine
│   └── fsm_snapshot.go # Snapshot support
├── api/
│   └── handler.go      # HTTP API
└── transport/
    └── transport.go    # TCP transport
```

## Dependencies

```bash
go mod init github.com/example/kvstore
go get github.com/hashicorp/raft@v1.6.0
go get github.com/hashicorp/raft-boltdb/v2@v2.3.0
```

## Finite State Machine (FSM)

The FSM is the application state that Raft replicates. Every log entry that Raft commits gets applied to the FSM in order.

```go
// store/fsm.go
package store

import (
    "encoding/json"
    "fmt"
    "io"
    "sync"

    "github.com/hashicorp/raft"
)

// Command types that can be applied to the FSM.
type CommandType uint8

const (
    CommandSet CommandType = iota
    CommandDelete
)

// Command is a log entry payload.
type Command struct {
    Type  CommandType `json:"type"`
    Key   string      `json:"key"`
    Value string      `json:"value,omitempty"`
}

// FSM implements the raft.FSM interface.
// It is the core of our replicated state machine.
type FSM struct {
    mu   sync.RWMutex
    data map[string]string
}

func NewFSM() *FSM {
    return &FSM{
        data: make(map[string]string),
    }
}

// Apply is called when Raft commits a log entry.
// The return value is passed back to the caller of raft.Apply().
// This method must be deterministic: given the same log entry,
// it must produce the same result on every node.
func (f *FSM) Apply(log *raft.Log) interface{} {
    var cmd Command
    if err := json.Unmarshal(log.Data, &cmd); err != nil {
        return fmt.Errorf("unmarshal command: %w", err)
    }

    f.mu.Lock()
    defer f.mu.Unlock()

    switch cmd.Type {
    case CommandSet:
        f.data[cmd.Key] = cmd.Value
        return nil

    case CommandDelete:
        _, existed := f.data[cmd.Key]
        delete(f.data, cmd.Key)
        if !existed {
            return fmt.Errorf("key not found: %s", cmd.Key)
        }
        return nil

    default:
        return fmt.Errorf("unknown command type: %d", cmd.Type)
    }
}

// Snapshot returns a snapshot of the FSM state for log compaction.
// This is called on the leader; the returned FSMSnapshot is serialized
// and sent to followers as part of snapshot installation.
func (f *FSM) Snapshot() (raft.FSMSnapshot, error) {
    f.mu.RLock()
    defer f.mu.RUnlock()

    // Deep copy the data map
    snapshot := make(map[string]string, len(f.data))
    for k, v := range f.data {
        snapshot[k] = v
    }

    return &FSMSnapshot{data: snapshot}, nil
}

// Restore replaces the FSM state with the contents of an io.ReadCloser.
// Called when installing a snapshot from the leader.
func (f *FSM) Restore(rc io.ReadCloser) error {
    defer rc.Close()

    var data map[string]string
    if err := json.NewDecoder(rc).Decode(&data); err != nil {
        return fmt.Errorf("decode snapshot: %w", err)
    }

    f.mu.Lock()
    defer f.mu.Unlock()
    f.data = data

    return nil
}

// Get reads a value from the FSM (not through Raft - stale reads allowed).
func (f *FSM) Get(key string) (string, bool) {
    f.mu.RLock()
    defer f.mu.RUnlock()
    v, ok := f.data[key]
    return v, ok
}
```

## FSM Snapshot

```go
// store/fsm_snapshot.go
package store

import (
    "encoding/json"

    "github.com/hashicorp/raft"
)

// FSMSnapshot implements raft.FSMSnapshot.
type FSMSnapshot struct {
    data map[string]string
}

// Persist writes the snapshot to the SnapshotSink.
// The SnapshotSink is backed by a file or object storage.
func (s *FSMSnapshot) Persist(sink raft.SnapshotSink) error {
    encoder := json.NewEncoder(sink)
    if err := encoder.Encode(s.data); err != nil {
        sink.Cancel()
        return err
    }
    return sink.Close()
}

// Release is called when we are done with the snapshot.
func (s *FSMSnapshot) Release() {}
```

## The KV Store

```go
// store/store.go
package store

import (
    "encoding/json"
    "fmt"
    "net"
    "os"
    "path/filepath"
    "time"

    "github.com/hashicorp/raft"
    raftboltdb "github.com/hashicorp/raft-boltdb/v2"
)

const (
    retainSnapshotCount = 2
    raftTimeout         = 10 * time.Second
)

// Config holds configuration for a Store node.
type Config struct {
    NodeID      string
    BindAddr    string
    DataDir     string
    Bootstrap   bool
    JoinAddr    string
}

// Store is a distributed key-value store backed by Raft.
type Store struct {
    config Config
    raft   *raft.Raft
    fsm    *FSM
}

// Open creates or restores a Store.
func Open(config Config) (*Store, error) {
    // Ensure data directory exists
    if err := os.MkdirAll(config.DataDir, 0750); err != nil {
        return nil, fmt.Errorf("create data dir: %w", err)
    }

    // Create FSM
    fsm := NewFSM()

    // Create Raft configuration
    raftConfig := raft.DefaultConfig()
    raftConfig.LocalID = raft.ServerID(config.NodeID)
    raftConfig.SnapshotInterval = 20 * time.Second
    raftConfig.SnapshotThreshold = 2    // Snapshot after 2 uncommitted entries (low for demo)

    // For production, tune these:
    // raftConfig.HeartbeatTimeout = 1000 * time.Millisecond
    // raftConfig.ElectionTimeout = 1000 * time.Millisecond
    // raftConfig.CommitTimeout = 50 * time.Millisecond
    // raftConfig.SnapshotThreshold = 8192

    // Create TCP transport
    addr, err := net.ResolveTCPAddr("tcp", config.BindAddr)
    if err != nil {
        return nil, fmt.Errorf("resolve bind addr: %w", err)
    }
    transport, err := raft.NewTCPTransport(config.BindAddr, addr, 3, raftTimeout, os.Stderr)
    if err != nil {
        return nil, fmt.Errorf("create transport: %w", err)
    }

    // Create snapshot store
    snapshots, err := raft.NewFileSnapshotStore(config.DataDir, retainSnapshotCount, os.Stderr)
    if err != nil {
        return nil, fmt.Errorf("create snapshot store: %w", err)
    }

    // Create BoltDB log store (WAL)
    logStore, err := raftboltdb.NewBoltStore(filepath.Join(config.DataDir, "raft-log.db"))
    if err != nil {
        return nil, fmt.Errorf("create log store: %w", err)
    }

    // Create BoltDB stable store (Raft metadata: current term, vote)
    stableStore, err := raftboltdb.NewBoltStore(filepath.Join(config.DataDir, "raft-stable.db"))
    if err != nil {
        return nil, fmt.Errorf("create stable store: %w", err)
    }

    // Instantiate Raft
    r, err := raft.NewRaft(raftConfig, fsm, logStore, stableStore, snapshots, transport)
    if err != nil {
        return nil, fmt.Errorf("create raft: %w", err)
    }

    store := &Store{
        config: config,
        raft:   r,
        fsm:    fsm,
    }

    // Bootstrap or join cluster
    if config.Bootstrap {
        configuration := raft.Configuration{
            Servers: []raft.Server{
                {
                    ID:      raft.ServerID(config.NodeID),
                    Address: transport.LocalAddr(),
                },
            },
        }
        r.BootstrapCluster(configuration)
    } else if config.JoinAddr != "" {
        // Join an existing cluster via its API
        if err := joinCluster(config.JoinAddr, config.NodeID, config.BindAddr); err != nil {
            return nil, fmt.Errorf("join cluster: %w", err)
        }
    }

    return store, nil
}

// Set applies a set command to the distributed log.
func (s *Store) Set(key, value string) error {
    if s.raft.State() != raft.Leader {
        return fmt.Errorf("not leader: writes must go to %s", s.raft.Leader())
    }

    cmd := Command{
        Type:  CommandSet,
        Key:   key,
        Value: value,
    }

    data, err := json.Marshal(cmd)
    if err != nil {
        return fmt.Errorf("marshal command: %w", err)
    }

    future := s.raft.Apply(data, raftTimeout)
    if future.Error() != nil {
        return fmt.Errorf("raft apply: %w", future.Error())
    }

    // Check the response from FSM.Apply()
    if err, ok := future.Response().(error); ok && err != nil {
        return err
    }

    return nil
}

// Delete applies a delete command to the distributed log.
func (s *Store) Delete(key string) error {
    if s.raft.State() != raft.Leader {
        return fmt.Errorf("not leader: writes must go to %s", s.raft.Leader())
    }

    cmd := Command{
        Type: CommandDelete,
        Key:  key,
    }

    data, err := json.Marshal(cmd)
    if err != nil {
        return fmt.Errorf("marshal command: %w", err)
    }

    future := s.raft.Apply(data, raftTimeout)
    return future.Error()
}

// Get reads a value from the local FSM.
// Note: This is a stale read - followers may not have the latest value.
// For linearizable reads, use GetLinearizable().
func (s *Store) Get(key string) (string, bool) {
    return s.fsm.Get(key)
}

// GetLinearizable performs a linearizable read by going through Raft.
// More expensive than Get() but guaranteed to return the latest committed value.
func (s *Store) GetLinearizable(key string) (string, bool, error) {
    // Raft barrier ensures we've applied all committed log entries
    barrier := s.raft.Barrier(raftTimeout)
    if barrier.Error() != nil {
        return "", false, fmt.Errorf("raft barrier: %w", barrier.Error())
    }
    v, ok := s.fsm.Get(key)
    return v, ok, nil
}

// Join adds a new node to the cluster.
// Must be called on the leader.
func (s *Store) Join(nodeID, addr string) error {
    if s.raft.State() != raft.Leader {
        return fmt.Errorf("not leader")
    }

    configFuture := s.raft.GetConfiguration()
    if configFuture.Error() != nil {
        return configFuture.Error()
    }

    // Check if node already in cluster
    for _, srv := range configFuture.Configuration().Servers {
        if srv.ID == raft.ServerID(nodeID) {
            if srv.Address == raft.ServerAddress(addr) {
                return nil // Already joined with same address
            }
            // Remove old entry with same ID but different address
            removeFuture := s.raft.RemoveServer(srv.ID, 0, 0)
            if removeFuture.Error() != nil {
                return removeFuture.Error()
            }
        }
    }

    addFuture := s.raft.AddVoter(
        raft.ServerID(nodeID),
        raft.ServerAddress(addr),
        0,    // prevIndex: 0 means don't check
        0,    // timeout: 0 means use default
    )
    return addFuture.Error()
}

// Remove removes a node from the cluster.
func (s *Store) Remove(nodeID string) error {
    if s.raft.State() != raft.Leader {
        return fmt.Errorf("not leader")
    }

    future := s.raft.RemoveServer(raft.ServerID(nodeID), 0, 0)
    return future.Error()
}

// Stats returns Raft statistics.
func (s *Store) Stats() map[string]string {
    return s.raft.Stats()
}

// Leader returns the current leader address.
func (s *Store) Leader() string {
    return string(s.raft.Leader())
}

// IsLeader returns true if this node is the current leader.
func (s *Store) IsLeader() bool {
    return s.raft.State() == raft.Leader
}
```

## HTTP API Handler

```go
// api/handler.go
package api

import (
    "encoding/json"
    "net/http"
    "strings"

    "github.com/example/kvstore/store"
)

// Handler serves the KV store HTTP API.
type Handler struct {
    store *store.Store
}

func New(s *store.Store) *Handler {
    return &Handler{store: s}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    mux := http.NewServeMux()
    mux.HandleFunc("/kv/", h.handleKV)
    mux.HandleFunc("/cluster/join", h.handleJoin)
    mux.HandleFunc("/cluster/remove", h.handleRemove)
    mux.HandleFunc("/stats", h.handleStats)
    mux.ServeHTTP(w, r)
}

func (h *Handler) handleKV(w http.ResponseWriter, r *http.Request) {
    key := strings.TrimPrefix(r.URL.Path, "/kv/")
    if key == "" {
        http.Error(w, "key required", http.StatusBadRequest)
        return
    }

    switch r.Method {
    case http.MethodGet:
        value, ok, err := h.store.GetLinearizable(key)
        if err != nil {
            // On follower, redirect to leader
            if leader := h.store.Leader(); leader != "" {
                http.Error(w, "not leader: "+leader, http.StatusServiceUnavailable)
                return
            }
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }
        if !ok {
            http.NotFound(w, r)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]string{"key": key, "value": value})

    case http.MethodPut, http.MethodPost:
        var body struct {
            Value string `json:"value"`
        }
        if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
            http.Error(w, "invalid request body", http.StatusBadRequest)
            return
        }

        if err := h.store.Set(key, body.Value); err != nil {
            if strings.Contains(err.Error(), "not leader") {
                http.Error(w, err.Error(), http.StatusServiceUnavailable)
                return
            }
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }
        w.WriteHeader(http.StatusNoContent)

    case http.MethodDelete:
        if err := h.store.Delete(key); err != nil {
            http.Error(w, err.Error(), http.StatusInternalServerError)
            return
        }
        w.WriteHeader(http.StatusNoContent)

    default:
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
    }
}

func (h *Handler) handleJoin(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var body struct {
        NodeID string `json:"node_id"`
        Addr   string `json:"addr"`
    }
    if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    if err := h.store.Join(body.NodeID, body.Addr); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    w.WriteHeader(http.StatusOK)
}

func (h *Handler) handleRemove(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var body struct {
        NodeID string `json:"node_id"`
    }
    if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
        http.Error(w, "invalid request body", http.StatusBadRequest)
        return
    }

    if err := h.store.Remove(body.NodeID); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    w.WriteHeader(http.StatusOK)
}

func (h *Handler) handleStats(w http.ResponseWriter, r *http.Request) {
    stats := h.store.Stats()
    stats["leader"] = h.store.Leader()
    if h.store.IsLeader() {
        stats["is_leader"] = "true"
    } else {
        stats["is_leader"] = "false"
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(stats)
}
```

## Main Entry Point

```go
// main.go
package main

import (
    "flag"
    "log"
    "net/http"

    "github.com/example/kvstore/api"
    "github.com/example/kvstore/store"
)

func main() {
    var (
        httpAddr  = flag.String("http-addr", ":8080", "HTTP API bind address")
        raftAddr  = flag.String("raft-addr", ":9090", "Raft protocol bind address")
        dataDir   = flag.String("data-dir", "/tmp/kvstore", "Data directory")
        nodeID    = flag.String("node-id", "node1", "Unique node ID")
        bootstrap = flag.Bool("bootstrap", false, "Bootstrap a new cluster")
        joinAddr  = flag.String("join", "", "Address of cluster to join")
    )
    flag.Parse()

    config := store.Config{
        NodeID:    *nodeID,
        BindAddr:  *raftAddr,
        DataDir:   *dataDir,
        Bootstrap: *bootstrap,
        JoinAddr:  *joinAddr,
    }

    s, err := store.Open(config)
    if err != nil {
        log.Fatalf("failed to open store: %v", err)
    }

    handler := api.New(s)

    log.Printf("starting HTTP API on %s", *httpAddr)
    log.Printf("raft listening on %s", *raftAddr)
    log.Fatal(http.ListenAndServe(*httpAddr, handler))
}
```

## Deploying a 3-Node Cluster

```bash
# Node 1 (bootstrap)
go run . \
    --node-id=node1 \
    --raft-addr=127.0.0.1:9091 \
    --http-addr=127.0.0.1:8081 \
    --data-dir=/tmp/kvstore1 \
    --bootstrap

# Node 2 (join)
go run . \
    --node-id=node2 \
    --raft-addr=127.0.0.1:9092 \
    --http-addr=127.0.0.1:8082 \
    --data-dir=/tmp/kvstore2 \
    --join=127.0.0.1:8081

# Node 3 (join)
go run . \
    --node-id=node3 \
    --raft-addr=127.0.0.1:9093 \
    --http-addr=127.0.0.1:8083 \
    --data-dir=/tmp/kvstore3 \
    --join=127.0.0.1:8081

# Helper function to join nodes 2 and 3 to the leader:
# (The --join flag should call this on startup)
curl -X POST http://127.0.0.1:8081/cluster/join \
    -H 'Content-Type: application/json' \
    -d '{"node_id":"node2","addr":"127.0.0.1:9092"}'

curl -X POST http://127.0.0.1:8081/cluster/join \
    -H 'Content-Type: application/json' \
    -d '{"node_id":"node3","addr":"127.0.0.1:9093"}'
```

## Testing Consensus and Fault Tolerance

```bash
# Write to leader
curl -X PUT http://127.0.0.1:8081/kv/mykey \
    -H 'Content-Type: application/json' \
    -d '{"value":"hello-world"}'

# Read from any node (linearizable)
curl http://127.0.0.1:8081/kv/mykey
curl http://127.0.0.1:8082/kv/mykey  # Same value
curl http://127.0.0.1:8083/kv/mykey  # Same value

# Check cluster stats
curl http://127.0.0.1:8081/stats | jq '.'

# Kill the leader
kill $(lsof -ti:8081)

# After election timeout (default ~1s), check who is the new leader
curl http://127.0.0.1:8082/stats | jq '.state, .leader'

# Writes should still work via the new leader
curl -X PUT http://127.0.0.1:8082/kv/newkey \
    -H 'Content-Type: application/json' \
    -d '{"value":"written-to-new-leader"}'
```

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kvstore
  namespace: kvstore
spec:
  serviceName: kvstore-headless
  replicas: 3
  selector:
    matchLabels:
      app: kvstore
  template:
    metadata:
      labels:
        app: kvstore
    spec:
      containers:
        - name: kvstore
          image: registry.example.com/kvstore:v1.0.0
          args:
            - "--node-id=$(POD_NAME)"
            - "--raft-addr=$(POD_IP):9090"
            - "--http-addr=0.0.0.0:8080"
            - "--data-dir=/data"
            - "--bootstrap-expect=3"
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          ports:
            - name: http
              containerPort: 8080
            - name: raft
              containerPort: 9090
          volumeMounts:
            - name: data
              mountPath: /data
          readinessProbe:
            httpGet:
              path: /stats
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3
        resources:
          requests:
            storage: 10Gi
---
# Headless service for peer discovery
apiVersion: v1
kind: Service
metadata:
  name: kvstore-headless
  namespace: kvstore
spec:
  clusterIP: None
  selector:
    app: kvstore
  ports:
    - name: raft
      port: 9090
---
# ClusterIP service for clients
apiVersion: v1
kind: Service
metadata:
  name: kvstore
  namespace: kvstore
spec:
  selector:
    app: kvstore
  ports:
    - name: http
      port: 80
      targetPort: 8080
```

## Production Tuning

### Election and Heartbeat Timeouts

```go
raftConfig := raft.DefaultConfig()

// These values depend on network latency between nodes
// For nodes in the same AZ: 150ms heartbeat, 500ms election
// For multi-AZ: 250ms heartbeat, 1000ms election
// For cross-region: 500ms heartbeat, 2000ms election
raftConfig.HeartbeatTimeout = 150 * time.Millisecond
raftConfig.ElectionTimeout = 500 * time.Millisecond
raftConfig.CommitTimeout = 50 * time.Millisecond

// Snapshot configuration
raftConfig.SnapshotThreshold = 8192  // Snapshot after 8192 uncommitted log entries
raftConfig.SnapshotInterval = 120 * time.Second
raftConfig.TrailingLogs = 10240  // Keep 10240 logs after snapshot for log compaction
```

### Monitoring Raft Metrics

hashicorp/raft integrates with go-metrics:

```go
import (
    "github.com/armon/go-metrics"
    "github.com/armon/go-metrics/prometheus"
)

func initMetrics() {
    sink, err := prometheus.NewPrometheusSink()
    if err != nil {
        log.Fatalf("prometheus sink: %v", err)
    }
    metrics.NewGlobal(metrics.DefaultConfig("kvstore"), sink)
}
```

Key Raft metrics to monitor:

```promql
# Commit latency (p99 should be < 50ms in same-AZ)
histogram_quantile(0.99, rate(kvstore_raft_commitTime_bucket[5m]))

# Apply latency (end-to-end write latency)
histogram_quantile(0.99, rate(kvstore_raft_fsm_applyBatch_bucket[5m]))

# Number of peers (should match expected cluster size)
kvstore_raft_peers

# Leader stability (how often leadership changes)
increase(kvstore_raft_state_leader[1h])

# Log entries per second
rate(kvstore_raft_apply_total[1m])
```

Alert when:
- `raft_peers < expectedClusterSize - 1` (loss of quorum approaching)
- `raft_commitTime p99 > 500ms` (high commit latency)
- `raft_state_leader increase > 5` per hour (frequent leader elections indicate instability)

## Common Issues and Solutions

### Issue: Leadership Churn

Symptom: frequent leader elections, high commit latency.

Causes and fixes:
- GC pauses: tune GOGC, use `debug.SetMemoryLimit`, or switch to a GC-friendly data structure
- CPU starvation: increase CPU limits, use process priority
- Disk I/O latency: use NVMe SSDs for the BoltDB log, separate log and snapshot disks
- Network jitter: check MTU, ring buffer sizes, TCP backlog

### Issue: Log Growth Without Snapshots

Symptom: BoltDB file grows indefinitely.

```go
// Ensure snapshot threshold is reasonable
raftConfig.SnapshotThreshold = 8192

// Force a snapshot manually (useful in operations)
future := r.Snapshot()
if future.Error() != nil {
    log.Printf("snapshot failed: %v", future.Error())
}
```

### Issue: Split Brain After Network Partition

Raft prevents split brain by requiring quorum for commits. If your cluster partitions into two halves of equal size (e.g., 2/2 in a 4-node cluster), neither half can commit new entries. This is by design.

For a 5-node cluster that loses 2 nodes: the remaining 3 form a quorum and continue serving traffic. The 2 isolated nodes step down from leadership if they were leaders.

## Summary

The `hashicorp/raft` library provides a mature, well-tested Raft implementation that powers Consul and Nomad. Key implementation decisions:

1. **FSM design**: keep Apply() deterministic and fast; do expensive work outside of it
2. **Snapshot implementation**: always implement Snapshot/Restore; without it, log replay from scratch is required after restarts
3. **Linearizable reads**: use `Barrier()` before reading from the FSM on the leader if consistency is required
4. **Transport**: use TLS in production; hashicorp/raft supports pluggable transport
5. **Cluster size**: always odd numbers (3, 5, 7); 3 is usually sufficient unless you need to tolerate 2 simultaneous failures
6. **Tuning**: set election/heartbeat timeouts based on actual network latency measurements in your environment

Raft clusters are inherently sensitive to tail latency (GC pauses, disk I/O, network jitter), so invest in observability early.
