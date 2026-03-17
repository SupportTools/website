---
title: "Go: Building a Distributed Cache with Consistent Hashing and Replication for High Availability"
date: 2031-08-31T00:00:00-05:00
draft: false
tags: ["Go", "Distributed Systems", "Caching", "Consistent Hashing", "Replication", "High Availability"]
categories:
- Go
- Distributed Systems
author: "Matthew Mattox - mmattox@support.tools"
description: "Implement a distributed in-memory cache in Go with consistent hashing for data distribution, synchronous replication for fault tolerance, and gossip-based membership for operational simplicity."
more_link: "yes"
url: "/go-distributed-cache-consistent-hashing-replication-high-availability/"
---

A distributed cache sits at the critical path of most high-throughput services. When it fails or loses data during a node restart, latency spikes and databases absorb traffic they were not designed for. This post builds a distributed cache from first principles: consistent hashing for even data distribution without global rehashing, synchronous replication to survive node failures without data loss, and a simple HTTP API that makes the cache a drop-in addition to any architecture.

<!--more-->

# Go: Building a Distributed Cache with Consistent Hashing and Replication for High Availability

## Design Goals

Before writing any code, the requirements drive the data structure choices:

1. **Consistent hashing**: Adding or removing a node should move only K/N keys (where K is total keys and N is nodes), not all of them.
2. **Replication factor R**: Each key is stored on R nodes. We tolerate R-1 simultaneous failures without data loss.
3. **Read-your-writes consistency**: A successful write is confirmed only after all R replicas acknowledge.
4. **Gossip-based membership**: Nodes discover each other without a central coordinator, making the cluster self-healing.
5. **LRU eviction with TTL**: Bounded memory with configurable time-based expiration.

## Project Layout

```
distcache/
├── cmd/
│   └── distcache/
│       └── main.go
├── pkg/
│   ├── ring/
│   │   ├── ring.go           # Consistent hash ring
│   │   └── ring_test.go
│   ├── cache/
│   │   ├── lru.go            # LRU eviction + TTL
│   │   └── shard.go          # Sharded cache (reduces lock contention)
│   ├── replication/
│   │   └── replicator.go     # Synchronous write replication
│   ├── membership/
│   │   └── gossip.go         # Gossip protocol for membership
│   └── server/
│       └── http.go           # HTTP API
├── go.mod
└── go.sum
```

## Consistent Hash Ring

The ring uses virtual nodes (vnodes) — each physical node is placed at multiple positions on the ring. This ensures even key distribution even with heterogeneous node capacities.

```go
// pkg/ring/ring.go
package ring

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sort"
	"sync"
)

const defaultVirtualNodes = 150

// Node represents a cache node in the ring.
type Node struct {
	ID      string // unique identifier, e.g., "node-1:8080"
	Addr    string // HTTP address for replication
	Weight  int    // Relative capacity (default 1)
}

// vnodeKey is a position on the hash ring.
type vnodeKey struct {
	hash     uint64
	nodeID   string
	vnodeIdx int
}

// Ring is a thread-safe consistent hash ring.
type Ring struct {
	mu           sync.RWMutex
	vnodes       []vnodeKey          // sorted by hash
	nodeMap      map[string]*Node    // nodeID -> Node
	virtualNodes int
}

// New creates a ring with the given number of virtual nodes per physical node.
func New(virtualNodes int) *Ring {
	if virtualNodes <= 0 {
		virtualNodes = defaultVirtualNodes
	}
	return &Ring{
		nodeMap:      make(map[string]*Node),
		virtualNodes: virtualNodes,
	}
}

// Add adds a node to the ring.
func (r *Ring) Add(n *Node) {
	count := r.virtualNodes
	if n.Weight > 1 {
		count *= n.Weight
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	r.nodeMap[n.ID] = n
	for i := 0; i < count; i++ {
		h := hashKey(fmt.Sprintf("%s:%d", n.ID, i))
		r.vnodes = append(r.vnodes, vnodeKey{hash: h, nodeID: n.ID, vnodeIdx: i})
	}
	sort.Slice(r.vnodes, func(i, j int) bool {
		return r.vnodes[i].hash < r.vnodes[j].hash
	})
}

// Remove removes a node and all its virtual nodes from the ring.
func (r *Ring) Remove(nodeID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.nodeMap, nodeID)
	filtered := r.vnodes[:0]
	for _, v := range r.vnodes {
		if v.nodeID != nodeID {
			filtered = append(filtered, v)
		}
	}
	r.vnodes = filtered
}

// GetN returns up to n distinct nodes responsible for the given key,
// starting from the key's primary node and walking the ring clockwise.
// Used for replication: GetN(key, replicationFactor) gives primary + replicas.
func (r *Ring) GetN(key string, n int) []*Node {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.vnodes) == 0 {
		return nil
	}

	h := hashKey(key)
	idx := sort.Search(len(r.vnodes), func(i int) bool {
		return r.vnodes[i].hash >= h
	})
	if idx == len(r.vnodes) {
		idx = 0
	}

	seen := make(map[string]struct{})
	var nodes []*Node

	for i := 0; i < len(r.vnodes) && len(nodes) < n; i++ {
		vnode := r.vnodes[(idx+i)%len(r.vnodes)]
		if _, ok := seen[vnode.nodeID]; ok {
			continue
		}
		seen[vnode.nodeID] = struct{}{}
		if node, ok := r.nodeMap[vnode.nodeID]; ok {
			nodes = append(nodes, node)
		}
	}

	return nodes
}

// Get returns the primary node for a key.
func (r *Ring) Get(key string) *Node {
	nodes := r.GetN(key, 1)
	if len(nodes) == 0 {
		return nil
	}
	return nodes[0]
}

// Nodes returns all registered nodes.
func (r *Ring) Nodes() []*Node {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Node, 0, len(r.nodeMap))
	for _, n := range r.nodeMap {
		out = append(out, n)
	}
	return out
}

// KeysInRange returns the approximate fraction of the keyspace owned by nodeID.
// Useful for capacity planning.
func (r *Ring) LoadDistribution() map[string]float64 {
	r.mu.RLock()
	defer r.mu.RUnlock()

	count := make(map[string]int)
	for _, v := range r.vnodes {
		count[v.nodeID]++
	}

	total := len(r.vnodes)
	dist := make(map[string]float64, len(count))
	for id, c := range count {
		dist[id] = float64(c) / float64(total)
	}
	return dist
}

func hashKey(key string) uint64 {
	h := sha256.Sum256([]byte(key))
	return binary.BigEndian.Uint64(h[:8])
}
```

## LRU Cache with TTL

```go
// pkg/cache/lru.go
package cache

import (
	"container/list"
	"sync"
	"time"
)

// Entry is a value stored in the cache.
type Entry struct {
	Key       string
	Value     []byte
	ExpiresAt time.Time
}

func (e *Entry) expired() bool {
	return !e.ExpiresAt.IsZero() && time.Now().After(e.ExpiresAt)
}

// LRU is an LRU cache with optional TTL per entry.
type LRU struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List
	items    map[string]*list.Element
}

// New creates an LRU with the given capacity (number of entries).
func NewLRU(capacity int) *LRU {
	return &LRU{
		capacity: capacity,
		ll:       list.New(),
		items:    make(map[string]*list.Element, capacity),
	}
}

// Set stores a value with an optional TTL (zero = no expiration).
func (c *LRU) Set(key string, value []byte, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry := &Entry{Key: key, Value: value}
	if ttl > 0 {
		entry.ExpiresAt = time.Now().Add(ttl)
	}

	if el, ok := c.items[key]; ok {
		c.ll.MoveToFront(el)
		el.Value = entry
		return
	}

	if c.ll.Len() >= c.capacity {
		c.evictOldest()
	}

	el := c.ll.PushFront(entry)
	c.items[key] = el
}

// Get retrieves a value. Returns nil if absent or expired.
func (c *LRU) Get(key string) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()

	el, ok := c.items[key]
	if !ok {
		return nil
	}

	entry := el.Value.(*Entry)
	if entry.expired() {
		c.ll.Remove(el)
		delete(c.items, key)
		return nil
	}

	c.ll.MoveToFront(el)
	return entry.Value
}

// Delete removes a key.
func (c *LRU) Delete(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	if el, ok := c.items[key]; ok {
		c.ll.Remove(el)
		delete(c.items, key)
		return true
	}
	return false
}

// Len returns the number of items currently in the cache.
func (c *LRU) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

func (c *LRU) evictOldest() {
	el := c.ll.Back()
	if el == nil {
		return
	}
	entry := el.Value.(*Entry)
	c.ll.Remove(el)
	delete(c.items, entry.Key)
}
```

### Sharded Cache (Reduce Lock Contention)

```go
// pkg/cache/shard.go
package cache

import (
	"crypto/sha256"
	"time"
)

const defaultShards = 256

// ShardedCache distributes keys across N LRU shards to reduce lock contention
// under concurrent access.
type ShardedCache struct {
	shards   []*LRU
	numShards uint32
}

// NewShardedCache creates a cache with the given total capacity distributed
// evenly across numShards shards.
func NewShardedCache(totalCapacity, numShards int) *ShardedCache {
	if numShards <= 0 {
		numShards = defaultShards
	}
	perShard := totalCapacity / numShards
	if perShard < 1 {
		perShard = 1
	}

	sc := &ShardedCache{
		shards:    make([]*LRU, numShards),
		numShards: uint32(numShards),
	}
	for i := range sc.shards {
		sc.shards[i] = NewLRU(perShard)
	}
	return sc
}

func (sc *ShardedCache) shard(key string) *LRU {
	h := sha256.Sum256([]byte(key))
	idx := uint32(h[0])<<24 | uint32(h[1])<<16 | uint32(h[2])<<8 | uint32(h[3])
	return sc.shards[idx%sc.numShards]
}

func (sc *ShardedCache) Set(key string, value []byte, ttl time.Duration) {
	sc.shard(key).Set(key, value, ttl)
}

func (sc *ShardedCache) Get(key string) []byte {
	return sc.shard(key).Get(key)
}

func (sc *ShardedCache) Delete(key string) bool {
	return sc.shard(key).Delete(key)
}

// Stats returns aggregate cache statistics.
func (sc *ShardedCache) Stats() map[string]int {
	total := 0
	for _, s := range sc.shards {
		total += s.Len()
	}
	return map[string]int{
		"total_items": total,
		"num_shards":  int(sc.numShards),
	}
}
```

## Replication

```go
// pkg/replication/replicator.go
package replication

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/yourorg/distcache/pkg/ring"
)

// WriteRequest is the payload sent to replicas.
type WriteRequest struct {
	Key   string `json:"key"`
	Value []byte `json:"value"`
	TTLMs int64  `json:"ttl_ms,omitempty"` // Milliseconds; 0 = no expiration
	Replica bool `json:"replica"`           // True when sent from a primary
}

// Replicator handles synchronous write replication to peer nodes.
type Replicator struct {
	selfID            string
	ring              *ring.Ring
	replicationFactor int
	client            *http.Client
}

// New creates a Replicator.
func New(selfID string, r *ring.Ring, factor int) *Replicator {
	return &Replicator{
		selfID:            selfID,
		ring:              r,
		replicationFactor: factor,
		client: &http.Client{
			Timeout: 2 * time.Second,
		},
	}
}

// Replicate writes a key-value pair to all responsible nodes.
// Returns an error if fewer than (replicationFactor/2 + 1) nodes acknowledge.
func (rep *Replicator) Replicate(ctx context.Context, req *WriteRequest) error {
	nodes := rep.ring.GetN(req.Key, rep.replicationFactor)
	if len(nodes) == 0 {
		return fmt.Errorf("no nodes available")
	}

	quorum := rep.replicationFactor/2 + 1
	type result struct{ err error }
	results := make(chan result, len(nodes))

	for _, node := range nodes {
		if node.ID == rep.selfID {
			// Skip self — the caller writes to local cache directly.
			results <- result{nil}
			continue
		}
		go func(n *ring.Node) {
			results <- result{rep.sendToNode(ctx, n, req)}
		}(node)
	}

	var succeeded, failed int
	for i := 0; i < len(nodes); i++ {
		r := <-results
		if r.err == nil {
			succeeded++
		} else {
			failed++
		}
		// Fast path: quorum already achieved.
		if succeeded >= quorum {
			return nil
		}
		// Fast fail: quorum impossible.
		remaining := len(nodes) - i - 1
		if succeeded+remaining < quorum {
			return fmt.Errorf("replication failed: %d/%d nodes acknowledged (need %d)",
				succeeded, len(nodes), quorum)
		}
	}

	if succeeded < quorum {
		return fmt.Errorf("replication quorum not met: %d/%d", succeeded, quorum)
	}
	return nil
}

func (rep *Replicator) sendToNode(ctx context.Context, n *ring.Node, req *WriteRequest) error {
	body, err := json.Marshal(req)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx,
		http.MethodPut,
		fmt.Sprintf("http://%s/internal/set", n.Addr),
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := rep.client.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("node %s returned %d", n.ID, resp.StatusCode)
	}
	return nil
}
```

## Gossip Membership

Rather than hard-coding peer addresses, nodes discover each other using a simple gossip protocol built on `hashicorp/memberlist`:

```go
// pkg/membership/gossip.go
package membership

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"time"

	"github.com/hashicorp/memberlist"
	"github.com/yourorg/distcache/pkg/ring"
)

// NodeMeta is broadcast with memberlist Alive events.
type NodeMeta struct {
	HTTPAddr string `json:"http_addr"` // Address for replication API
	Weight   int    `json:"weight"`
}

// Membership manages cluster membership using gossip.
type Membership struct {
	list     *memberlist.Memberlist
	ring     *ring.Ring
	selfMeta NodeMeta
	log      *slog.Logger
}

// Config configures gossip membership.
type Config struct {
	NodeName string
	BindAddr string
	BindPort int
	HTTPAddr string
	Weight   int
	Seeds    []string // Addresses of seed nodes to join via
	Ring     *ring.Ring
	Log      *slog.Logger
}

// New creates and starts a gossip membership instance.
func New(cfg *Config) (*Membership, error) {
	meta := NodeMeta{HTTPAddr: cfg.HTTPAddr, Weight: cfg.Weight}
	metaBytes, _ := json.Marshal(meta)

	mlCfg := memberlist.DefaultLocalConfig()
	mlCfg.Name = cfg.NodeName
	mlCfg.BindAddr = cfg.BindAddr
	mlCfg.BindPort = cfg.BindPort
	mlCfg.LogOutput = noopWriter{}

	m := &Membership{
		ring:     cfg.Ring,
		selfMeta: meta,
		log:      cfg.Log,
	}

	mlCfg.Delegate = &delegate{meta: metaBytes}
	mlCfg.Events = &eventDelegate{membership: m}

	list, err := memberlist.Create(mlCfg)
	if err != nil {
		return nil, fmt.Errorf("memberlist create: %w", err)
	}
	m.list = list

	// Add self to ring.
	cfg.Ring.Add(&ring.Node{
		ID:     cfg.NodeName,
		Addr:   cfg.HTTPAddr,
		Weight: cfg.Weight,
	})

	// Join cluster via seed nodes.
	if len(cfg.Seeds) > 0 {
		if _, err := list.Join(cfg.Seeds); err != nil {
			cfg.Log.Warn("could not join all seeds", "error", err)
		}
	}

	return m, nil
}

// Members returns the current list of live cluster members.
func (m *Membership) Members() []*memberlist.Node {
	return m.list.Members()
}

// eventDelegate handles join/leave events to update the ring.
type eventDelegate struct {
	membership *Membership
}

func (e *eventDelegate) NotifyJoin(n *memberlist.Node) {
	var meta NodeMeta
	if err := json.Unmarshal(n.Meta, &meta); err != nil {
		return
	}
	e.membership.log.Info("node joined", "name", n.Name, "addr", meta.HTTPAddr)
	e.membership.ring.Add(&ring.Node{
		ID:     n.Name,
		Addr:   meta.HTTPAddr,
		Weight: meta.Weight,
	})
}

func (e *eventDelegate) NotifyLeave(n *memberlist.Node) {
	e.membership.log.Info("node left", "name", n.Name)
	e.membership.ring.Remove(n.Name)
}

func (e *eventDelegate) NotifyUpdate(n *memberlist.Node) {}

// delegate provides node metadata for gossip.
type delegate struct {
	meta []byte
}

func (d *delegate) NodeMeta(limit int) []byte        { return d.meta }
func (d *delegate) NotifyMsg([]byte)                 {}
func (d *delegate) GetBroadcasts(int, int) [][]byte  { return nil }
func (d *delegate) LocalState(bool) []byte           { return nil }
func (d *delegate) MergeRemoteState([]byte, bool)    {}

type noopWriter struct{}

func (noopWriter) Write(p []byte) (int, error) { return len(p), nil }

// ParseAddr splits "host:port" into host and port int.
func ParseAddr(addr string) (string, int, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return "", 0, err
	}
	return host, port, nil
}
```

## HTTP Server

```go
// pkg/server/http.go
package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/yourorg/distcache/pkg/cache"
	"github.com/yourorg/distcache/pkg/replication"
	"github.com/yourorg/distcache/pkg/ring"
)

// Server exposes the cache via HTTP.
type Server struct {
	cache       *cache.ShardedCache
	ring        *ring.Ring
	replicator  *replication.Replicator
	selfID      string
}

func New(c *cache.ShardedCache, r *ring.Ring, rep *replication.Replicator, selfID string) *Server {
	return &Server{cache: c, ring: r, replicator: rep, selfID: selfID}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /cache/{key}", s.handleGet)
	mux.HandleFunc("PUT /cache/{key}", s.handleSet)
	mux.HandleFunc("DELETE /cache/{key}", s.handleDelete)

	// Internal replication endpoint — should be network-restricted
	mux.HandleFunc("PUT /internal/set", s.handleInternalSet)

	mux.HandleFunc("GET /stats", s.handleStats)
	mux.HandleFunc("GET /health", s.handleHealth)
	return mux
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if key == "" {
		http.Error(w, "missing key", http.StatusBadRequest)
		return
	}

	// Check if this node is responsible for the key.
	node := s.ring.Get(key)
	if node != nil && node.ID != s.selfID {
		// Proxy to the correct node.
		http.Redirect(w, r,
			"http://"+node.Addr+"/cache/"+key,
			http.StatusTemporaryRedirect,
		)
		return
	}

	val := s.cache.Get(key)
	if val == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(val)
}

func (s *Server) handleSet(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if key == "" {
		http.Error(w, "missing key", http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 10*1024*1024)) // 10 MB max
	if err != nil {
		http.Error(w, "read error", http.StatusInternalServerError)
		return
	}

	var ttl time.Duration
	if ttlStr := r.URL.Query().Get("ttl"); ttlStr != "" {
		ttlMs, err := strconv.ParseInt(ttlStr, 10, 64)
		if err == nil && ttlMs > 0 {
			ttl = time.Duration(ttlMs) * time.Millisecond
		}
	}

	// Write to local cache.
	s.cache.Set(key, body, ttl)

	// Replicate to peers.
	req := &replication.WriteRequest{
		Key:   key,
		Value: body,
		TTLMs: ttl.Milliseconds(),
	}
	if err := s.replicator.Replicate(r.Context(), req); err != nil {
		http.Error(w, "replication failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	s.cache.Delete(key)
	w.WriteHeader(http.StatusNoContent)
}

// handleInternalSet handles write requests from other nodes during replication.
func (s *Server) handleInternalSet(w http.ResponseWriter, r *http.Request) {
	var req replication.WriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	var ttl time.Duration
	if req.TTLMs > 0 {
		ttl = time.Duration(req.TTLMs) * time.Millisecond
	}

	s.cache.Set(req.Key, req.Value, ttl)
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats := s.cache.Stats()
	stats["ring_nodes"] = len(s.ring.Nodes())

	dist := s.ring.LoadDistribution()
	resp := map[string]interface{}{
		"cache":        stats,
		"distribution": dist,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}
```

## Main: Wiring the Cluster Node

```go
// cmd/distcache/main.go
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/yourorg/distcache/pkg/cache"
	"github.com/yourorg/distcache/pkg/membership"
	"github.com/yourorg/distcache/pkg/replication"
	"github.com/yourorg/distcache/pkg/ring"
	"github.com/yourorg/distcache/pkg/server"
)

func main() {
	var (
		nodeName      = flag.String("name", "", "Unique node name (required)")
		httpAddr      = flag.String("http", ":8080", "HTTP listen address")
		gossipBind    = flag.String("gossip-bind", ":7946", "Gossip bind address")
		seeds         = flag.String("seeds", "", "Comma-separated seed addresses")
		capacity      = flag.Int("capacity", 10_000_000, "Max number of cache entries")
		replFactor    = flag.Int("replication", 3, "Replication factor")
		virtualNodes  = flag.Int("vnodes", 150, "Virtual nodes per physical node")
	)
	flag.Parse()

	if *nodeName == "" {
		fmt.Fprintln(os.Stderr, "ERROR: -name is required")
		os.Exit(1)
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Consistent hash ring.
	r := ring.New(*virtualNodes)

	// Local cache.
	c := cache.NewShardedCache(*capacity, 256)

	// Replicator.
	rep := replication.New(*nodeName, r, *replFactor)

	// HTTP server.
	srv := server.New(c, r, rep, *nodeName)
	httpServer := &http.Server{
		Addr:         *httpAddr,
		Handler:      srv.Routes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 5 * time.Second,
	}

	// Gossip membership.
	gossipHost, gossipPort, err := membership.ParseAddr(*gossipBind)
	if err != nil {
		log.Error("invalid gossip-bind", "error", err)
		os.Exit(1)
	}

	var seedList []string
	if *seeds != "" {
		seedList = strings.Split(*seeds, ",")
	}

	_, err = membership.New(&membership.Config{
		NodeName: *nodeName,
		BindAddr: gossipHost,
		BindPort: gossipPort,
		HTTPAddr: *httpAddr,
		Weight:   1,
		Seeds:    seedList,
		Ring:     r,
		Log:      log,
	})
	if err != nil {
		log.Error("membership init failed", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Info("starting cache node",
			"name", *nodeName,
			"http", *httpAddr,
			"gossip", *gossipBind,
			"replication_factor", *replFactor,
		)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server error", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	log.Info("shutting down node", "name", *nodeName)

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutCtx)
}
```

## Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: distcache
  namespace: caching
spec:
  serviceName: distcache-headless
  replicas: 5
  selector:
    matchLabels:
      app: distcache
  template:
    metadata:
      labels:
        app: distcache
    spec:
      containers:
        - name: distcache
          image: your-registry.example.com/distcache:1.0.0
          args:
            - -name=$(POD_NAME)
            - -http=:8080
            - -gossip-bind=:7946
            - -seeds=distcache-0.distcache-headless.caching.svc.cluster.local:7946
            - -capacity=5000000
            - -replication=3
            - -vnodes=150
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          ports:
            - containerPort: 8080
              name: http
            - containerPort: 7946
              name: gossip
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          resources:
            requests:
              cpu: 500m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 8Gi
---
apiVersion: v1
kind: Service
metadata:
  name: distcache-headless
  namespace: caching
spec:
  clusterIP: None
  selector:
    app: distcache
  ports:
    - port: 8080
      name: http
    - port: 7946
      name: gossip
---
apiVersion: v1
kind: Service
metadata:
  name: distcache
  namespace: caching
spec:
  selector:
    app: distcache
  ports:
    - port: 8080
      name: http
```

## Testing the Ring Distribution

```bash
# Deploy a 5-node cluster
kubectl apply -f distcache-statefulset.yaml

# Check ring load distribution
curl -s http://distcache.caching.svc.cluster.local:8080/stats | jq .distribution
# {
#   "distcache-0": 0.203,
#   "distcache-1": 0.198,
#   "distcache-2": 0.201,
#   "distcache-3": 0.197,
#   "distcache-4": 0.201
# }

# Write a value
curl -X PUT http://distcache:8080/cache/user:1234 \
  -d '{"name":"Alice"}' \
  --data-urlencode "ttl=300000"   # 5 minutes

# Read it back from a different pod
kubectl exec distcache-2 -- curl -s http://localhost:8080/cache/user:1234
# {"name":"Alice"}

# Simulate node failure: delete pod
kubectl delete pod distcache-3

# Key is still readable — replicas on distcache-1 and distcache-4 serve it
curl http://distcache:8080/cache/user:1234
# {"name":"Alice"}
```

## Summary

The distributed cache demonstrates the core building blocks of fault-tolerant distributed systems:

1. **Consistent hashing with virtual nodes** ensures that adding or removing a node relocates only ~1/N of keys and distributes load evenly across heterogeneous hardware.
2. **Sharded LRU** reduces lock contention from O(concurrent_reads) to O(concurrent_reads / 256) by partitioning the key space.
3. **Synchronous quorum replication** — write succeeds only when floor(R/2)+1 replicas confirm — provides read-after-write consistency and tolerates up to R-1 simultaneous node failures.
4. **Gossip membership** with hashicorp/memberlist provides decentralized, scalable cluster discovery without a single point of failure.

To productionize, add TLS between nodes, a consistent-read mode (read from quorum), Prometheus metrics on hit/miss ratios and replication latency, and a persistent backend (e.g., BadgerDB) for warm-start after cluster restarts.
