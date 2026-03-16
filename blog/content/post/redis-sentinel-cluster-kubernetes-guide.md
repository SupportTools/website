---
title: "Redis Operator on Kubernetes: Sentinel, Cluster Mode, and Persistence Patterns"
date: 2027-06-25T00:00:00-05:00
draft: false
tags: ["Redis", "Kubernetes", "Database", "High Availability", "Caching"]
categories:
- Redis
- Kubernetes
- Database
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to deploying Redis on Kubernetes using the OpsTree Redis Operator, covering Sentinel high availability, Redis Cluster sharding, AOF and RDB persistence, memory policy configuration, slow log analysis, keyspace notifications, and monitoring with redis-exporter."
more_link: "yes"
url: "/redis-operator-kubernetes-production-guide/"
---

Redis running on Kubernetes without an operator is an operational liability. StatefulSet definitions, Sentinel coordination, shard management, and persistence configuration must be maintained manually — and failover behavior is unpredictable without the proper interlocks. The OpsTree Redis Operator (`ot-container-kit/redis-operator`) provides production-grade Redis deployments through declarative CRDs, automating Sentinel configuration, Redis Cluster topology, password rotation, and TLS. This guide covers the full deployment lifecycle from installation through production hardening.

<!--more-->

# Redis Operator on Kubernetes: Sentinel, Cluster Mode, and Persistence Patterns

## Section 1: Redis Operator Architecture

The OpsTree Redis Operator manages four resource types:

- `Redis` — a standalone Redis instance for development and non-HA use cases
- `RedisCluster` — a sharded Redis Cluster with configurable primary/replica counts
- `RedisSentinel` — a Sentinel quorum managing a replication group for HA without sharding
- `RedisReplication` — a replication group (primary + replicas) that serves as the backend for Sentinel

The operator reconciles these CRDs into StatefulSets, Services, ConfigMaps, and Secrets. It handles the initial cluster meet/join process for Redis Cluster, registers replicas with the Sentinel quorum, and executes rolling restarts for configuration changes.

### Installation

```bash
helm repo add ot-helm https://ot-container-kit.github.io/helm-charts/
helm repo update

helm upgrade --install redis-operator ot-helm/redis-operator \
  --namespace redis-operator \
  --create-namespace \
  --set redisOperator.imageName=quay.io/opstree/redis-operator \
  --set redisOperator.imageTag=v0.15.1 \
  --version 0.15.1

kubectl -n redis-operator get pods
kubectl get crd | grep redis
```

### Namespace Setup

```bash
kubectl create namespace redis
```

---

## Section 2: Redis Sentinel — High Availability Without Sharding

Redis Sentinel provides automatic failover for a single primary/replica group. Sentinel monitors the primary, elects a new primary when the existing one fails, and updates replica configurations automatically. Use Sentinel when the dataset fits on a single node and HA is needed without the complexity of sharding.

### RedisReplication CRD

```yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisReplication
metadata:
  name: redis-replication
  namespace: redis
spec:
  clusterSize: 3
  redisExporter:
    enabled: true
    image: quay.io/opstree/redis-exporter:v1.44.0
  kubernetesConfig:
    image: quay.io/opstree/redis:v7.0.12
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "2000m"
        memory: "2Gi"
    redisSecret:
      name: redis-secret
      key: password
  storage:
    volumeClaimTemplate:
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 5Gi
        storageClassName: gp3-encrypted
  redisConfig:
    additionalRedisConfig: redis-replication-config
  podSecurityContext:
    runAsUser: 1000
    fsGroup: 1000
```

### RedisSentinel CRD

```yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisSentinel
metadata:
  name: redis-sentinel
  namespace: redis
spec:
  clusterSize: 3
  redisSentinelConfig:
    redisReplicationName: redis-replication
    masterGroupName: mymaster
    redisPort: "6379"
    quorum: "2"
    downAfterMilliseconds: "5000"
    failoverTimeout: "180000"
    parallelSyncs: "1"
  kubernetesConfig:
    image: quay.io/opstree/redis:v7.0.12
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "50m"
        memory: "64Mi"
      limits:
        cpu: "500m"
        memory: "128Mi"
    redisSecret:
      name: redis-secret
      key: password
```

### Password Secret

```bash
kubectl -n redis create secret generic redis-secret \
  --from-literal=password="$(openssl rand -base64 32)"
```

### Sentinel Configuration Parameters

| Parameter | Value | Description |
|---|---|---|
| `quorum` | `2` | Minimum Sentinels that must agree for failover |
| `downAfterMilliseconds` | `5000` | Milliseconds before primary is marked down |
| `failoverTimeout` | `180000` | Milliseconds for the whole failover process |
| `parallelSyncs` | `1` | Replicas that sync from new primary simultaneously |

### Connecting Through Sentinel

Applications must be Sentinel-aware. Use `SENTINEL get-master-addr-by-name mymaster` to discover the current primary:

```bash
# Get current primary address
kubectl -n redis exec -it redis-sentinel-0 -- \
  redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster

# List all Sentinels
kubectl -n redis exec -it redis-sentinel-0 -- \
  redis-cli -p 26379 SENTINEL sentinels mymaster

# Check master info
kubectl -n redis exec -it redis-sentinel-0 -- \
  redis-cli -p 26379 SENTINEL master mymaster
```

---

## Section 3: Redis Cluster Mode — Sharding

Redis Cluster distributes data across multiple shards using hash slots (0–16383). Each shard is an independent primary/replica pair. Use Redis Cluster when the dataset exceeds the memory of a single node or when write throughput requires horizontal scaling.

### RedisCluster CRD

```yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisCluster
metadata:
  name: redis-cluster
  namespace: redis
spec:
  clusterSize: 3
  clusterVersion: v7
  persistenceEnabled: true
  redisLeader:
    replicas: 3
    redisConfig:
      additionalRedisConfig: redis-cluster-config
    kubernetesConfig:
      image: quay.io/opstree/redis:v7.0.12
      imagePullPolicy: IfNotPresent
      resources:
        requests:
          cpu: "200m"
          memory: "256Mi"
        limits:
          cpu: "2000m"
          memory: "4Gi"
      redisSecret:
        name: redis-secret
        key: password
    storage:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 20Gi
          storageClassName: gp3-encrypted
  redisFollower:
    replicas: 3
    redisConfig:
      additionalRedisConfig: redis-cluster-config
    kubernetesConfig:
      image: quay.io/opstree/redis:v7.0.12
      imagePullPolicy: IfNotPresent
      resources:
        requests:
          cpu: "200m"
          memory: "256Mi"
        limits:
          cpu: "2000m"
          memory: "4Gi"
      redisSecret:
        name: redis-secret
        key: password
    storage:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 20Gi
          storageClassName: gp3-encrypted
  redisExporter:
    enabled: true
    image: quay.io/opstree/redis-exporter:v1.44.0
  podDisruptionBudget:
    enabled: true
    minAvailable: 2
```

### Verifying Cluster State

```bash
# Check cluster info
REDIS_PASS=$(kubectl -n redis get secret redis-secret \
  -o jsonpath='{.data.password}' | base64 -d)

kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" -c CLUSTER INFO

# List cluster nodes with slot ranges
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" CLUSTER NODES

# Check cluster slots
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" CLUSTER SLOTS
```

### Hash Tag Usage for Multi-Key Operations

Redis Cluster restricts multi-key operations to keys in the same hash slot. Use hash tags (curly braces) to force co-location:

```bash
# These keys may land in different slots
SET user:1:name "Alice"
SET user:1:email "alice@example.com"

# Use hash tags to force the same slot
SET {user:1}:name "Alice"
SET {user:1}:email "alice@example.com"
MGET {user:1}:name {user:1}:email
```

---

## Section 4: AOF vs RDB Persistence

### RDB (Redis Database) Snapshotting

RDB creates point-in-time snapshots of the dataset at configurable intervals. RDB files are compact and ideal for backups, but data written between the last snapshot and a crash is lost.

```
# RDB configuration in additionalRedisConfig ConfigMap
save 3600 1
save 300 100
save 60 10000
rdbcompression yes
rdbchecksum yes
dbfilename dump.rdb
```

`save 300 100` triggers a snapshot if at least 100 keys changed in the last 300 seconds.

### AOF (Append-Only File) Persistence

AOF logs every write operation. On restart, Redis replays the AOF to reconstruct state. AOF provides much better durability but produces larger files and higher I/O.

```
# AOF configuration
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
aof-rewrite-incremental-fsync yes
aof-use-rdb-preamble yes
```

### `appendfsync` Options

| Option | Durability | Performance |
|---|---|---|
| `always` | Maximum (every write fsynced) | Lowest (significant I/O overhead) |
| `everysec` | One second of data at risk | Balanced (recommended for production) |
| `no` | OS-controlled (may lose seconds of data) | Highest throughput |

### Enabling Both AOF and RDB (Recommended)

```
# Enable AOF with RDB preamble for faster restarts
appendonly yes
aof-use-rdb-preamble yes
# Keep RDB for backup purposes
save 3600 1
save 300 100
```

The `aof-use-rdb-preamble yes` option writes an RDB snapshot at the start of the AOF on rewrite, dramatically reducing AOF load time while preserving full durability.

### ConfigMap for Redis Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-cluster-config
  namespace: redis
data:
  redis-cluster-config: |
    appendonly yes
    aof-use-rdb-preamble yes
    appendfsync everysec
    no-appendfsync-on-rewrite no
    auto-aof-rewrite-percentage 100
    auto-aof-rewrite-min-size 128mb
    save 3600 1
    save 300 100
    save 60 10000
    hz 15
    dynamic-hz yes
    aof-rewrite-incremental-fsync yes
    rdb-save-incremental-fsync yes
    loglevel notice
    slowlog-log-slower-than 10000
    slowlog-max-len 256
    latency-monitoring-threshold 100
    notify-keyspace-events ""
    tcp-keepalive 300
    tcp-backlog 511
    timeout 0
    databases 16
```

---

## Section 5: Memory Policy Configuration

When Redis reaches its `maxmemory` limit, the eviction policy determines which keys are removed.

### Setting maxmemory

```
# Set to 75% of container memory limit
maxmemory 3gb
maxmemory-policy allkeys-lru
maxmemory-samples 10
```

### Eviction Policy Reference

| Policy | Description | Best For |
|---|---|---|
| `noeviction` | Return error when memory limit is reached | Durable data stores |
| `allkeys-lru` | Evict least recently used keys from all keys | General caching |
| `volatile-lru` | Evict LRU keys that have an expiry set | Mixed cache/store |
| `allkeys-lfu` | Evict least frequently used keys | Skewed access patterns |
| `volatile-lfu` | Evict LFU keys with expiry | Mixed with skewed access |
| `allkeys-random` | Evict random keys | Random access patterns |
| `volatile-random` | Evict random keys with expiry | TTL-managed cache |
| `volatile-ttl` | Evict keys with shortest TTL | TTL-based expiry |

### Memory Optimization Settings

```
# Compact encoding for small data structures
hash-max-listpack-entries 128
hash-max-listpack-value 64
list-max-listpack-size -2
set-max-intset-entries 512
set-max-listpack-entries 128
set-max-listpack-value 64
zset-max-listpack-entries 128
zset-max-listpack-value 64

# Active defragmentation (Redis 4+)
activedefrag yes
active-defrag-ignore-bytes 100mb
active-defrag-threshold-lower 10
active-defrag-threshold-upper 100
active-defrag-cycle-min 1
active-defrag-cycle-max 25
```

### Memory Usage Analysis

```bash
REDIS_PASS=$(kubectl -n redis get secret redis-secret \
  -o jsonpath='{.data.password}' | base64 -d)

# Get memory usage stats
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" INFO memory

# Estimate memory usage for a specific key
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" MEMORY USAGE "mykey"

# Scan for big keys
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" --bigkeys
```

---

## Section 6: Slow Log Analysis

The Redis slow log captures commands exceeding the `slowlog-log-slower-than` threshold (in microseconds). Analyzing slow commands is the first step in diagnosing latency issues.

### Slow Log Configuration

```
slowlog-log-slower-than 10000
slowlog-max-len 256
```

`slowlog-log-slower-than 10000` logs commands taking more than 10ms.

### Querying the Slow Log

```bash
REDIS_PASS=$(kubectl -n redis get secret redis-secret \
  -o jsonpath='{.data.password}' | base64 -d)

# Get the last 25 slow log entries
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" SLOWLOG GET 25

# Get slow log length
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" SLOWLOG LEN

# Reset the slow log
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" SLOWLOG RESET
```

### Common Causes of Slow Commands

- `KEYS *` — O(N) scan across all keys; replace with `SCAN` cursor-based iteration
- `SMEMBERS` on large sets — use `SSCAN` instead
- `LRANGE` with large ranges — paginate or use streams
- `SORT` without `ALPHA` or `LIMIT` — expensive on large lists
- Large Lua scripts holding the server event loop

### Latency Monitoring

```bash
REDIS_PASS=$(kubectl -n redis get secret redis-secret \
  -o jsonpath='{.data.password}' | base64 -d)

# Enable latency monitoring
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" \
  CONFIG SET latency-monitoring-threshold 100

# View latency history
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" LATENCY HISTORY event

# View latest latency values
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" LATENCY LATEST
```

---

## Section 7: Keyspace Notifications

Keyspace notifications allow clients to subscribe to events in the Redis keyspace via Pub/Sub. Use them for cache invalidation, event-driven pipelines, and TTL expiration callbacks.

### Configuration

Notifications are disabled by default to avoid overhead. Enable them selectively:

```
# Enable expired key events and keyevent events for strings
notify-keyspace-events "Ex"

# Enable all events (high overhead — avoid in production unless needed)
# notify-keyspace-events "KEA"
```

### Event Flag Reference

| Flag | Description |
|---|---|
| `K` | Keyspace events (published on `__keyspace@<db>__:<key>`) |
| `E` | Keyevent events (published on `__keyevent@<db>__:<event>`) |
| `g` | Generic commands (DEL, EXPIRE, RENAME) |
| `$` | String commands |
| `l` | List commands |
| `s` | Set commands |
| `h` | Hash commands |
| `z` | Sorted set commands |
| `x` | Expired events |
| `e` | Evicted events |
| `t` | Stream commands |
| `A` | Alias for `g$lshzxet` |

### Subscribing to Expiry Events

```bash
REDIS_PASS=$(kubectl -n redis get secret redis-secret \
  -o jsonpath='{.data.password}' | base64 -d)

# Subscribe to all key expiry events on database 0
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" PSUBSCRIBE "__keyevent@0__:expired"
```

---

## Section 8: Redis Metrics with redis-exporter

The `redis-exporter` sidecar exposes Redis metrics in Prometheus format on port 9121.

### ServiceMonitor Configuration

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: redis-cluster
  namespace: redis
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: redis-cluster
      redis.redis.opstreelabs.in/cluster-role: leader
  endpoints:
  - port: redis-exporter
    interval: 30s
    scrapeTimeout: 25s
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
    - sourceLabels: [__meta_kubernetes_namespace]
      targetLabel: namespace
```

### Key Metrics

```
# Uptime and version
redis_uptime_in_seconds
redis_version

# Memory
redis_memory_used_bytes
redis_memory_max_bytes
redis_mem_fragmentation_ratio

# Connections
redis_connected_clients
redis_blocked_clients
redis_rejected_connections_total

# Operations
redis_commands_processed_total
redis_keyspace_hits_total
redis_keyspace_misses_total

# Persistence
redis_aof_enabled
redis_rdb_last_save_timestamp_seconds
redis_rdb_changes_since_last_save

# Replication
redis_replication_offset
redis_replication_backlog_size_bytes
redis_connected_slaves

# Cluster
redis_cluster_enabled
redis_cluster_slots_assigned
redis_cluster_slots_ok
redis_cluster_known_nodes
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: redis-alerts
  namespace: redis
spec:
  groups:
  - name: redis
    rules:
    - alert: RedisDown
      expr: redis_up == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Redis instance {{ $labels.pod }} is down"

    - alert: RedisMemoryHighUsage
      expr: |
        redis_memory_used_bytes / redis_memory_max_bytes > 0.85
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Redis memory usage high on {{ $labels.pod }}"
        description: "Memory usage is {{ $value | humanizePercentage }}"

    - alert: RedisHighMissRate
      expr: |
        rate(redis_keyspace_misses_total[5m]) /
        (rate(redis_keyspace_hits_total[5m]) +
         rate(redis_keyspace_misses_total[5m])) > 0.20
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High cache miss rate on {{ $labels.pod }}"
        description: "Miss rate is {{ $value | humanizePercentage }}"

    - alert: RedisTooManyConnections
      expr: redis_connected_clients > 200
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Too many connections on {{ $labels.pod }}"
        description: "{{ $value }} clients connected"

    - alert: RedisRejectedConnections
      expr: increase(redis_rejected_connections_total[5m]) > 0
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Redis rejecting connections on {{ $labels.pod }}"

    - alert: RedisKeyEvictionHigh
      expr: rate(redis_evicted_keys_total[5m]) > 100
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High key eviction rate on {{ $labels.pod }}"
        description: "{{ $value | humanize }} keys/s being evicted"
```

---

## Section 9: Backup Strategies

### Manual RDB Dump

Trigger a synchronous BGSAVE and copy the dump file:

```bash
REDIS_PASS=$(kubectl -n redis get secret redis-secret \
  -o jsonpath='{.data.password}' | base64 -d)

# Trigger background save
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" BGSAVE

# Wait for completion (check timestamp changes)
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" LASTSAVE

# Copy dump.rdb to local filesystem
kubectl -n redis cp \
  redis-cluster-leader-0:/data/dump.rdb \
  ./redis-dump-$(date +%Y%m%d).rdb
```

### S3 Upload via CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: redis-rdb-backup
  namespace: redis
spec:
  schedule: "0 2 * * *"
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
          - name: backup
            image: amazon/aws-cli:2.15.0
            command:
            - /bin/sh
            - -c
            - |
              set -e
              DATE=$(date +%Y/%m/%d)
              aws s3 cp /data/dump.rdb \
                "s3://${S3_BUCKET}/${DATE}/dump.rdb" \
                --sse aws:kms
              echo "Backup completed: s3://${S3_BUCKET}/${DATE}/dump.rdb"
            env:
            - name: AWS_DEFAULT_REGION
              value: us-east-1
            - name: S3_BUCKET
              value: my-redis-backups
            volumeMounts:
            - name: redis-data
              mountPath: /data
              readOnly: true
          volumes:
          - name: redis-data
            persistentVolumeClaim:
              claimName: redis-data-redis-cluster-leader-0
```

### Velero with PVC Snapshots

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: redis-backup
  namespace: velero
spec:
  schedule: "0 3 * * *"
  template:
    includedNamespaces:
    - redis
    labelSelector:
      matchLabels:
        app: redis-cluster
    snapshotVolumes: true
    storageLocation: default
    volumeSnapshotLocations:
    - default
    ttl: 720h
```

---

## Section 10: Production Sizing and Topology Guidance

### Sizing Guidelines

| Use Case | maxmemory | Policy | Persistence | Topology |
|---|---|---|---|---|
| Session cache | 2Gi | `allkeys-lru` | None or RDB hourly | 3-node Sentinel |
| Rate limiting | 512Mi | `volatile-ttl` | None | 3-node Sentinel |
| Message queue | 8Gi | `noeviction` | AOF everysec | 3-node Sentinel |
| Full-page cache | 16Gi | `allkeys-lfu` | RDB daily | 6-node Cluster |
| Leaderboard | 4Gi | `volatile-lru` | AOF everysec | 3-node Sentinel |

### CPU and Memory Requests

Redis is single-threaded for command processing (multi-threaded I/O in Redis 6+). CPU requests should rarely exceed 2 cores per instance. Memory limits should be set to `maxmemory + 25%` overhead:

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "2560Mi"    # maxmemory 2Gi + 25% overhead
  limits:
    cpu: "2000m"
    memory: "2560Mi"    # Hard limit equals request to prevent OOM surprises
```

### PodDisruptionBudget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-cluster-leader-pdb
  namespace: redis
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: redis-cluster
      redis.redis.opstreelabs.in/cluster-role: leader
```

### Topology Spread Constraints for Multi-AZ

```yaml
topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app: redis-cluster
      redis.redis.opstreelabs.in/cluster-role: leader
```

### Cluster Health Troubleshooting

```bash
REDIS_PASS=$(kubectl -n redis get secret redis-secret \
  -o jsonpath='{.data.password}' | base64 -d)

# Check cluster state
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" CLUSTER INFO | grep cluster_state

# Check for failed nodes
kubectl -n redis exec -it redis-cluster-leader-0 -- \
  redis-cli -a "$REDIS_PASS" CLUSTER NODES | grep fail

# Trigger manual failover on a replica shard
kubectl -n redis exec -it redis-cluster-follower-0 -- \
  redis-cli -a "$REDIS_PASS" CLUSTER FAILOVER

# Check replication offset across all nodes
for pod in $(kubectl -n redis get pods \
  -l app=redis-cluster -o name | sed 's|pod/||'); do
  echo "--- $pod ---"
  kubectl -n redis exec "$pod" -- \
    redis-cli -a "$REDIS_PASS" INFO replication \
    | grep -E "role|master_repl_offset|slave_repl_offset"
done
```

Running Redis on Kubernetes with a proper operator eliminates the manual coordination overhead of Sentinel configuration, cluster slot assignment, and rolling upgrades. The OpsTree Redis Operator combined with proper persistence configuration, memory policies, and Prometheus monitoring provides a production-ready Redis deployment that leverages Kubernetes-native controls for resilience and observability.
