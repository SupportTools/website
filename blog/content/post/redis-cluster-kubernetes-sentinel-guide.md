---
title: "Redis Cluster and Sentinel on Kubernetes: High Availability Caching at Scale"
date: 2028-09-19T00:00:00-05:00
draft: false
tags: ["Redis", "Kubernetes", "Caching", "High Availability", "Database"]
categories:
- Redis
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Redis Cluster vs Sentinel architecture decisions, Redis Operator deployment, cluster topology, persistence configuration, memory management, keyspace notifications, monitoring with redis_exporter, and Go client patterns for cluster mode."
more_link: "yes"
url: "/redis-cluster-kubernetes-sentinel-guide/"
---

Redis is present in nearly every production Kubernetes deployment — as a session store, cache, rate limiter, pub/sub broker, or Lua-scripted atomic counter. The question of whether to run Redis Cluster or Redis with Sentinel determines your operational complexity, your application's connection management requirements, and your scaling ceiling. This guide makes that decision concrete, deploys both configurations using the Bitnami Redis Helm chart and the Redis Operator, configures production-grade persistence and memory management, sets up keyspace notifications, and provides Go client patterns that handle the behavioral differences between standalone, Sentinel, and Cluster modes.

<!--more-->

# Redis Cluster and Sentinel on Kubernetes: High Availability Caching at Scale

## Architecture Decision: Cluster vs Sentinel

**Redis Sentinel** watches a primary/replica topology. When the primary fails, Sentinel quorum elects a new primary among the replicas and notifies clients. Key characteristics:
- Single keyspace (no hash slot complexity)
- All reads/writes go to a single primary (unless you explicitly route reads to replicas)
- Scales vertically — add more memory to the primary
- Client libraries must support Sentinel protocol for automatic failover
- Simpler operational model

**Redis Cluster** distributes the keyspace across 16,384 hash slots, spread across multiple primary shards, each with replica(s). Key characteristics:
- Horizontal scaling by adding shards
- No support for multi-key commands across different hash slots (unless using hash tags)
- All clients must understand cluster topology and handle MOVED/ASK redirects
- Built-in high availability — no separate Sentinel processes
- More complex client requirements

**Decision rule**: Use Sentinel when your working set fits in the memory of one node and your application does not need horizontal write scaling. Use Cluster when you need to distribute data across multiple primaries, either for capacity or to distribute write load.

## Section 1: Redis Sentinel with Bitnami Helm Chart

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

kubectl create namespace redis-sentinel
```

```yaml
# redis-sentinel-values.yaml
global:
  redis:
    password: ""  # Set via existingSecret

auth:
  enabled: true
  existingSecret: redis-sentinel-auth
  existingSecretPasswordKey: redis-password

architecture: replication

replica:
  replicaCount: 2
  persistence:
    enabled: true
    storageClass: gp3-high-iops
    size: 10Gi
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 2000m
      memory: 4Gi

master:
  persistence:
    enabled: true
    storageClass: gp3-high-iops
    size: 10Gi
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  # Production Redis configuration
  configuration: |
    maxmemory 7gb
    maxmemory-policy allkeys-lru
    save 900 1
    save 300 10
    save 60 10000
    appendonly yes
    appendfsync everysec
    no-appendfsync-on-rewrite yes
    auto-aof-rewrite-percentage 100
    auto-aof-rewrite-min-size 64mb
    slowlog-log-slower-than 10000
    slowlog-max-len 256
    latency-monitor-threshold 100
    notify-keyspace-events "KEA"
    hz 15
    tcp-backlog 511
    timeout 300
    tcp-keepalive 60
    activerehashing yes
    activedefrag yes
    active-defrag-ignore-bytes 100mb
    active-defrag-threshold-lower 10
    active-defrag-threshold-upper 100
    lazyfree-lazy-eviction yes
    lazyfree-lazy-expire yes
    lazyfree-lazy-server-del yes
    replica-lazy-flush yes

sentinel:
  enabled: true
  masterSet: mymaster
  quorum: 2
  downAfterMilliseconds: 5000
  failoverTimeout: 60000
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

# Enable Prometheus metrics via redis_exporter sidecar
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    additionalLabels:
      release: prometheus
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 100m
      memory: 128Mi

podAntiAffinity: hard
```

```bash
# Create the auth secret
kubectl create secret generic redis-sentinel-auth \
  --namespace redis-sentinel \
  --from-literal=redis-password=$(openssl rand -base64 32)

helm upgrade --install redis-sentinel bitnami/redis \
  --namespace redis-sentinel \
  --values redis-sentinel-values.yaml \
  --wait \
  --timeout 10m
```

## Section 2: Redis Cluster Deployment

```yaml
# redis-cluster-values.yaml
global:
  redis:
    password: ""

auth:
  enabled: true
  existingSecret: redis-cluster-auth
  existingSecretPasswordKey: redis-password

cluster:
  enabled: true
  slaveCount: 1   # 1 replica per shard = 6 total pods for 3 shards

# 3 master shards + 3 replicas
usePassword: true

redis:
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: 4000m
      memory: 8Gi
  configuration: |
    maxmemory 7gb
    maxmemory-policy allkeys-lru
    appendonly yes
    appendfsync everysec
    cluster-node-timeout 15000
    cluster-announce-hostname ""
    slowlog-log-slower-than 10000
    notify-keyspace-events "KEx"

persistence:
  enabled: true
  storageClass: gp3-high-iops
  size: 10Gi

metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    additionalLabels:
      release: prometheus

podAntiAffinity: hard

topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        app.kubernetes.io/name: redis-cluster
```

```bash
kubectl create namespace redis-cluster

kubectl create secret generic redis-cluster-auth \
  --namespace redis-cluster \
  --from-literal=redis-password=$(openssl rand -base64 32)

helm upgrade --install redis-cluster bitnami/redis-cluster \
  --namespace redis-cluster \
  --values redis-cluster-values.yaml \
  --wait \
  --timeout 15m
```

## Section 3: Redis Operator for Production

The Redis Operator by OT-Container-Kit provides a more Kubernetes-native CRD API.

```bash
helm repo add ot-helm https://ot-container-kit.github.io/helm-charts
helm upgrade --install redis-operator ot-helm/redis-operator \
  --namespace redis-operator \
  --create-namespace \
  --wait
```

```yaml
# redis-cluster-crd.yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisCluster
metadata:
  name: sessions-redis
  namespace: sessions
spec:
  clusterSize: 3     # 3 master shards
  clusterVersion: v7
  persistenceEnabled: true
  redisLeader:
    replicas: 1
    redisConfig:
      additionalRedisConfig: |
        maxmemory 14gb
        maxmemory-policy allkeys-lru
        save ""
        appendonly yes
        appendfsync everysec
    livenessProbe:
      initialDelaySeconds: 15
      periodSeconds: 15
      timeoutSeconds: 5
      failureThreshold: 5
    readinessProbe:
      initialDelaySeconds: 15
      periodSeconds: 15
      timeoutSeconds: 5
      failureThreshold: 3
    resources:
      requests:
        cpu: 500m
        memory: 16Gi
      limits:
        cpu: 8000m
        memory: 16Gi
  redisFollower:
    replicas: 1   # 1 replica per master
    resources:
      requests:
        cpu: 200m
        memory: 16Gi
      limits:
        cpu: 4000m
        memory: 16Gi
  storage:
    volumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 50Gi
        storageClassName: gp3-high-iops
  redisSecret:
    name: sessions-redis-secret
    key: password
  kubernetesConfig:
    image: redis:7.2.5-alpine
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
```

## Section 4: Memory Management Deep Dive

Redis memory configuration is the most common source of production issues.

```bash
# Check current memory usage on all cluster nodes
for pod in $(kubectl get pods -n redis-cluster -l app.kubernetes.io/name=redis-cluster -o name); do
  echo "=== ${pod} ==="
  kubectl exec -n redis-cluster "${pod}" -- redis-cli -a "${REDIS_PASSWORD}" info memory \
    | grep -E "used_memory_human|maxmemory_human|mem_fragmentation_ratio|used_memory_rss_human"
done
```

### Eviction Policy Selection Guide

| Policy | Use Case |
|---|---|
| `noeviction` | Session stores, queues (never evict — return error when full) |
| `allkeys-lru` | General-purpose cache (evict least recently used from all keys) |
| `volatile-lru` | Cache with TTLs (only evict keys with an expiry set) |
| `allkeys-lfu` | Access-frequency-based cache (LFU for hot-cold skewed access patterns) |
| `volatile-ttl` | Evict keys about to expire first |

```bash
# Set memory policy on a running cluster (also update in config)
kubectl exec -n redis-cluster redis-cluster-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" config set maxmemory-policy allkeys-lfu

# Monitor eviction rate
kubectl exec -n redis-cluster redis-cluster-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" info stats | grep evicted_keys
```

## Section 5: Persistence Configuration

```bash
# Check AOF and RDB status
kubectl exec -n redis-sentinel redis-sentinel-master-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" info persistence

# Force an AOF rewrite to compact the log
kubectl exec -n redis-sentinel redis-sentinel-master-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" bgrewriteaof

# Force an RDB snapshot
kubectl exec -n redis-sentinel redis-sentinel-master-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" bgsave

# Check last save time
kubectl exec -n redis-sentinel redis-sentinel-master-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" lastsave
```

## Section 6: Keyspace Notifications

Keyspace notifications allow subscribing to events like key expiration, set, or delete — useful for cache invalidation patterns.

```bash
# Enable keyspace notifications (configuration: K=keyspace events, E=keyevent events, x=expired, e=evicted, A=all commands alias)
kubectl exec -n redis-sentinel redis-sentinel-master-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" config set notify-keyspace-events "KEx"

# Subscribe to all key expiration events on db 0
kubectl exec -n redis-sentinel redis-sentinel-master-0 -- \
  redis-cli -a "${REDIS_PASSWORD}" psubscribe "__keyevent@0__:expired"
```

Go implementation for keyspace notification consumer:

```go
// redis_notifications.go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/redis/go-redis/v9"
)

func subscribeToKeyExpiry(ctx context.Context, client *redis.Client) {
    // Enable keyspace notifications for expired events
    _, err := client.ConfigSet(ctx, "notify-keyspace-events", "KEx").Result()
    if err != nil {
        log.Printf("Warning: could not configure keyspace notifications: %v", err)
    }

    pubsub := client.PSubscribe(ctx, "__keyevent@0__:expired")
    defer pubsub.Close()

    for {
        select {
        case <-ctx.Done():
            return
        case msg, ok := <-pubsub.Channel():
            if !ok {
                return
            }
            expiredKey := msg.Payload
            log.Printf("Key expired: %s", expiredKey)
            // Handle cache invalidation, webhook triggers, etc.
            handleKeyExpiry(ctx, expiredKey)
        }
    }
}

func handleKeyExpiry(ctx context.Context, key string) {
    // Example: invalidate a downstream cache
    fmt.Printf("Handling expiry for key: %s\n", key)
}
```

## Section 7: Go Client Patterns for Cluster and Sentinel

```go
// redis_clients.go
package cache

import (
    "context"
    "crypto/tls"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// NewSentinelClient creates a client that connects via Sentinel.
// The client automatically follows failover and reconnects to the new primary.
func NewSentinelClient(sentinelAddrs []string, masterName, password string) *redis.Client {
    return redis.NewFailoverClient(&redis.FailoverOptions{
        MasterName:       masterName,
        SentinelAddrs:    sentinelAddrs,
        SentinelPassword: password,
        Password:         password,
        DB:               0,
        DialTimeout:      5 * time.Second,
        ReadTimeout:      3 * time.Second,
        WriteTimeout:     3 * time.Second,
        PoolSize:         50,
        MinIdleConns:     10,
        ConnMaxIdleTime:  5 * time.Minute,
        TLSConfig: &tls.Config{
            InsecureSkipVerify: false,
        },
    })
}

// NewClusterClient creates a client for Redis Cluster.
// go-redis handles MOVED/ASK redirects and cluster topology refreshes automatically.
func NewClusterClient(addrs []string, password string) *redis.ClusterClient {
    return redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:        addrs,
        Password:     password,
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
        PoolSize:     20,   // Per shard
        MinIdleConns: 5,
        // Route reads to replicas for read scaling
        RouteByLatency: false,
        RouteRandomly:  false,
        ReadOnly:       false,  // Set true to allow replica reads
        TLSConfig: &tls.Config{
            InsecureSkipVerify: false,
        },
    })
}

// CacheService wraps Redis operations with patterns suitable for both
// Sentinel and Cluster deployments.
type CacheService struct {
    client redis.Cmdable  // Works with both *redis.Client and *redis.ClusterClient
    prefix string
}

func NewCacheService(client redis.Cmdable, prefix string) *CacheService {
    return &CacheService{client: client, prefix: prefix}
}

func (c *CacheService) key(k string) string {
    return fmt.Sprintf("%s:%s", c.prefix, k)
}

// GetOrSet implements a cache-aside pattern with distributed locking
// to prevent cache stampede.
func (c *CacheService) GetOrSet(
    ctx context.Context,
    key string,
    ttl time.Duration,
    fetch func(ctx context.Context) (string, error),
) (string, error) {
    fullKey := c.key(key)
    lockKey := c.key("lock:" + key)

    // Try cache first
    val, err := c.client.Get(ctx, fullKey).Result()
    if err == nil {
        return val, nil
    }
    if err != redis.Nil {
        return "", fmt.Errorf("redis get: %w", err)
    }

    // Acquire a distributed lock to prevent stampede
    acquired, err := c.client.SetNX(ctx, lockKey, "1", 10*time.Second).Result()
    if err != nil {
        return "", fmt.Errorf("redis lock: %w", err)
    }

    if !acquired {
        // Another goroutine is fetching — wait and retry
        time.Sleep(50 * time.Millisecond)
        return c.GetOrSet(ctx, key, ttl, fetch)
    }

    defer c.client.Del(ctx, lockKey)

    // Fetch the value
    freshVal, err := fetch(ctx)
    if err != nil {
        return "", err
    }

    // Store in cache
    if err := c.client.Set(ctx, fullKey, freshVal, ttl).Err(); err != nil {
        // Non-fatal: log but return the value
        fmt.Printf("Warning: failed to cache %s: %v\n", fullKey, err)
    }

    return freshVal, nil
}

// MGetWithClusterHashTags fetches multiple keys from Redis Cluster.
// Uses hash tags to ensure all keys land on the same slot for atomic MGET.
// All keys must use the same hash tag: {tag}:field1, {tag}:field2
func (c *CacheService) MGetWithHashTag(
    ctx context.Context,
    tag string,
    fields []string,
) (map[string]string, error) {
    keys := make([]string, len(fields))
    for i, f := range fields {
        // {tag} ensures all keys hash to the same cluster slot
        keys[i] = fmt.Sprintf("{%s}:%s:%s", c.prefix, tag, f)
    }

    vals, err := c.client.MGet(ctx, keys...).Result()
    if err != nil {
        return nil, err
    }

    result := make(map[string]string, len(fields))
    for i, v := range vals {
        if v != nil {
            result[fields[i]] = v.(string)
        }
    }
    return result, nil
}

// Pipeline executes multiple commands atomically within a single shard.
// In cluster mode, all keys MUST be on the same slot (use hash tags).
func (c *CacheService) PipelinedIncrement(
    ctx context.Context,
    counters map[string]int64,
    ttl time.Duration,
) error {
    pipe := c.client.Pipeline()
    for key, delta := range counters {
        fullKey := c.key(key)
        pipe.IncrBy(ctx, fullKey, delta)
        pipe.Expire(ctx, fullKey, ttl)
    }
    _, err := pipe.Exec(ctx)
    return err
}
```

## Section 8: Monitoring with redis_exporter

```yaml
# ServiceMonitor for redis_exporter (Bitnami deploys this as a sidecar)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: redis-sentinel-metrics
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: redis
      app.kubernetes.io/component: metrics
  namespaceSelector:
    matchNames:
      - redis-sentinel
  endpoints:
    - port: metrics
      interval: 15s
```

```yaml
# PrometheusRule for Redis alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: redis-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: redis.availability
      rules:
        - alert: RedisDown
          expr: redis_up == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Redis instance {{ $labels.instance }} is down"

        - alert: RedisMasterMissing
          expr: redis_sentinel_masters == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Redis Sentinel has no master"

        - alert: RedisHighMemoryUsage
          expr: |
            redis_memory_used_bytes / redis_memory_max_bytes * 100 > 85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis memory usage is {{ $value }}% on {{ $labels.instance }}"

        - alert: RedisHighEvictionRate
          expr: |
            rate(redis_evicted_keys_total[5m]) > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis evicting {{ $value | humanize }} keys/s — cache may be undersized"

        - alert: RedisReplicationLag
          expr: |
            redis_connected_slaves{role="master"} < 1
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Redis master has no connected replicas — failover capability degraded"

        - alert: RedisSlowLogGrowing
          expr: |
            rate(redis_slowlog_length[5m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis slow log growing on {{ $labels.instance }}"
            description: "More than 10 slow queries per second. Review slow log with SLOWLOG GET."
```

## Section 9: Backup and Restore

```bash
#!/bin/bash
# redis-backup.sh — backup Redis RDB to S3

set -euo pipefail

NAMESPACE="${1:-redis-sentinel}"
POD="${2:-redis-sentinel-master-0}"
S3_BUCKET="${3:-acme-redis-backups}"
S3_PREFIX="${4:-redis-sentinel}"

echo "Triggering RDB snapshot on ${POD}..."
kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  redis-cli -a "${REDIS_PASSWORD}" bgsave

# Wait for snapshot to complete
echo "Waiting for snapshot..."
while true; do
  STATUS=$(kubectl exec -n "${NAMESPACE}" "${POD}" -- \
    redis-cli -a "${REDIS_PASSWORD}" lastsave)
  if [[ "${STATUS}" -gt "${BEFORE_SAVE}" ]]; then
    break
  fi
  sleep 1
done

# Copy the RDB file from the pod
BACKUP_FILE="redis-backup-$(date +%Y%m%d-%H%M%S).rdb"
kubectl exec -n "${NAMESPACE}" "${POD}" -- \
  cat /data/dump.rdb > "/tmp/${BACKUP_FILE}"

# Upload to S3
aws s3 cp "/tmp/${BACKUP_FILE}" \
  "s3://${S3_BUCKET}/${S3_PREFIX}/${BACKUP_FILE}" \
  --storage-class STANDARD_IA

# Remove local copy
rm -f "/tmp/${BACKUP_FILE}"

echo "Backup complete: s3://${S3_BUCKET}/${S3_PREFIX}/${BACKUP_FILE}"

# Clean up backups older than 30 days
aws s3 ls "s3://${S3_BUCKET}/${S3_PREFIX}/" \
  | awk '{print $4}' \
  | while read f; do
    DATE=$(echo "${f}" | grep -oP '\d{8}')
    if [[ -n "${DATE}" ]] && [[ $(date -d "${DATE}" +%s) -lt $(date -d "30 days ago" +%s) ]]; then
      aws s3 rm "s3://${S3_BUCKET}/${S3_PREFIX}/${f}"
    fi
  done
```

## Conclusion

The Redis on Kubernetes story has matured significantly. Helm charts handle the operational complexity of Sentinel quorum configuration and Cluster topology initialization, the Redis Operator provides a CRD-based abstraction for teams that prefer a Kubernetes-native approach, and go-redis handles MOVED/ASK redirects and Sentinel-based reconnection transparently for application code. The critical decisions remain the same as they have always been: choose Sentinel when your data fits in a single node and you want operational simplicity, choose Cluster when you need horizontal write scaling or data distribution. Configure memory limits aggressively, choose an eviction policy that matches your access patterns, and monitor eviction rate and memory fragmentation ratio as your primary operational signals.
