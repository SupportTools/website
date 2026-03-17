---
title: "Redis Operator on Kubernetes: Production Cache and Message Broker"
date: 2027-10-07T00:00:00-05:00
draft: false
tags: ["Redis", "Kubernetes", "Operator", "Caching", "HA"]
categories:
- Databases
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy production-grade Redis on Kubernetes using the Opstree Redis Operator. Covers Cluster vs Sentinel mode, persistent storage, ACL management, TLS, Prometheus monitoring, backup strategies, and failure testing."
more_link: "yes"
url: /redis-operator-opstree-advanced-guide/
---

Running Redis on Kubernetes requires more than a Helm chart with a single replica. Production workloads demand high availability, automated failover, persistent storage, encryption, and deep observability. The Opstree Redis Operator provides Kubernetes-native lifecycle management for Redis clusters and sentinels, eliminating the operational burden of managing these concerns manually. This guide covers every production concern from initial deployment through failure scenario validation.

<!--more-->

# Redis Operator on Kubernetes: Production Cache and Message Broker

## Section 1: Operator Selection — Opstree vs Helm Chart

Two common approaches exist for running Redis on Kubernetes: a Helm chart (such as Bitnami's redis chart) and the Opstree Redis Operator. Each has distinct tradeoffs.

The Helm chart approach deploys a StatefulSet directly. Day-two operations like scaling, reconfiguring persistence, or rotating TLS certificates require manual Helm upgrades and careful coordination with running workloads. There is no operator reconciliation loop watching for drift.

The Opstree Redis Operator provides CRDs (`RedisCluster`, `Redis`, `RedisReplication`, `RedisSentinel`) that declare the desired state. The operator continuously reconciles actual state toward desired state, handles rolling restarts for configuration changes, manages cluster slot rebalancing automatically, and exposes status conditions that integrate with alerting pipelines.

Install the operator using the official Helm chart:

```bash
helm repo add ot-helm https://ot-container-kit.github.io/helm-charts/
helm repo update

helm install redis-operator ot-helm/redis-operator \
  --namespace redis-operator \
  --create-namespace \
  --version 0.15.1 \
  --set redisOperator.imagePullPolicy=IfNotPresent \
  --set redisOperator.resources.requests.cpu=100m \
  --set redisOperator.resources.requests.memory=128Mi \
  --set redisOperator.resources.limits.cpu=500m \
  --set redisOperator.resources.limits.memory=256Mi
```

Verify the operator is running:

```bash
kubectl -n redis-operator get pods
kubectl -n redis-operator get crds | grep redis
```

Expected CRDs after installation:

```
redis.redis.redis.opstreelabs.in
redisclusters.redis.redis.opstreelabs.in
redisreplications.redis.redis.opstreelabs.in
redissentinels.redis.redis.opstreelabs.in
```

## Section 2: Redis Cluster Mode — Sharded High Availability

Redis Cluster mode distributes data across multiple shards, each with a primary and one or more replicas. This mode suits workloads with large datasets that exceed the memory of a single node, or workloads requiring horizontal write scaling.

### Cluster Topology

A production cluster requires a minimum of three primary shards for quorum-based slot assignment. Each primary should have at least one replica for automated failover.

```yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisCluster
metadata:
  name: redis-cluster
  namespace: redis
spec:
  clusterSize: 3
  clusterVersion: v7
  redisLeader:
    replicas: 3
    redisConfig:
      additionalRedisConfig: leader-config
    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                role: leader
            topologyKey: kubernetes.io/hostname
  redisFollower:
    replicas: 3
    redisConfig:
      additionalRedisConfig: follower-config
    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                role: follower
            topologyKey: kubernetes.io/hostname
  kubernetesConfig:
    image: redis:7.2.4-alpine
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: 200m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 2Gi
  storage:
    volumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi
        storageClassName: fast-ssd
  redisExporter:
    enabled: true
    image: oliver006/redis_exporter:v1.58.0
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 200m
        memory: 128Mi
  serviceMonitor:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: prometheus
  securityContext:
    runAsUser: 1000
    runAsNonRoot: true
    fsGroup: 1000
```

Apply the configuration:

```bash
kubectl create namespace redis
kubectl -n redis apply -f redis-cluster.yaml
kubectl -n redis get rediscluster redis-cluster -w
```

The operator creates StatefulSets for leaders and followers, initializes the cluster, and assigns hash slots. Monitor progress:

```bash
kubectl -n redis get pods -l redis.opstreelabs.in/cluster-name=redis-cluster
kubectl -n redis get rediscluster redis-cluster -o jsonpath='{.status}'
```

### Cluster Configuration ConfigMaps

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: leader-config
  namespace: redis
data:
  redis-additional.conf: |
    maxmemory 1500mb
    maxmemory-policy allkeys-lru
    activerehashing yes
    lazyfree-lazy-eviction yes
    lazyfree-lazy-expire yes
    lazyfree-lazy-server-del yes
    replica-lazy-flush yes
    tcp-backlog 511
    tcp-keepalive 300
    hz 15
    aof-rewrite-incremental-fsync yes
    rdb-save-incremental-fsync yes
    loglevel notice
    slowlog-log-slower-than 10000
    slowlog-max-len 256
    latency-tracking yes
    latency-tracking-info-percentiles 50 99 99.9
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: follower-config
  namespace: redis
data:
  redis-additional.conf: |
    maxmemory 1500mb
    maxmemory-policy allkeys-lru
    replica-read-only yes
    replica-priority 100
    lazyfree-lazy-flush yes
    replica-lazy-flush yes
    tcp-keepalive 300
    hz 15
```

## Section 3: Redis Sentinel Mode — Leader-Elected Single Shard

Sentinel mode provides high availability for a single Redis primary/replica pair. Sentinel processes monitor Redis nodes, perform automatic failover, and update client connection strings. This mode suits workloads that require HA but do not need horizontal data distribution.

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
    quorum: "2"
    parallelSyncs: "1"
    failoverTimeout: "180000"
    downAfterMilliseconds: "30000"
  kubernetesConfig:
    image: redis:7.2.4-alpine
    resources:
      requests:
        cpu: 100m
        memory: 64Mi
      limits:
        cpu: 500m
        memory: 128Mi
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: redis-sentinel
          topologyKey: kubernetes.io/hostname
---
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisReplication
metadata:
  name: redis-replication
  namespace: redis
spec:
  clusterSize: 3
  kubernetesConfig:
    image: redis:7.2.4-alpine
    resources:
      requests:
        cpu: 200m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 2Gi
  storage:
    volumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi
        storageClassName: fast-ssd
  redisConfig:
    additionalRedisConfig: redis-replication-config
  redisExporter:
    enabled: true
    image: oliver006/redis_exporter:v1.58.0
  serviceMonitor:
    enabled: true
    interval: 30s
    labels:
      release: prometheus
```

### Choosing Between Cluster and Sentinel

| Concern | Cluster Mode | Sentinel Mode |
|---------|-------------|---------------|
| Dataset size | Multiple nodes combined | Single node limit |
| Write scaling | Horizontal | Single primary only |
| Client complexity | Cluster-aware client required | Sentinel-aware client |
| Failover time | ~10 seconds | ~30 seconds |
| Slot management | Automatic rebalancing | Not applicable |
| Multi-key operations | Restricted to same slot | Unrestricted |

Use Cluster mode when dataset size exceeds a single node or write throughput demands horizontal scaling. Use Sentinel mode when application code uses multi-key commands like `MGET` with arbitrary keys, transactions spanning multiple keys, or Lua scripts accessing multiple keys.

## Section 4: Persistent Storage Configuration

Redis persistence must be configured deliberately. Incorrect persistence settings lead to data loss on restart or to slow write performance from excessive disk I/O.

### Combined RDB and AOF Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-persistence-config
  namespace: redis
data:
  redis-additional.conf: |
    # RDB snapshot configuration
    save 3600 1
    save 300 100
    save 60 10000
    stop-writes-on-bgsave-error yes
    rdbcompression yes
    rdbchecksum yes
    dbfilename dump.rdb
    dir /data

    # AOF configuration
    appendonly yes
    appendfilename "appendonly.aof"
    appendfsync everysec
    no-appendfsync-on-rewrite no
    auto-aof-rewrite-percentage 100
    auto-aof-rewrite-min-size 64mb
    aof-load-truncated yes
    aof-use-rdb-preamble yes
```

### StorageClass for Production Redis

Production Redis requires an SSD-backed StorageClass with `WaitForFirstConsumer` binding mode to co-locate storage with compute:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: true
```

The `Retain` reclaim policy prevents accidental data loss when a PVC is deleted. Explicitly delete PVs after confirming data is backed up.

### Verifying Persistence

After deploying, verify AOF is active:

```bash
kubectl -n redis exec redis-replication-0 -- \
  redis-cli INFO persistence | grep -E "aof_enabled|rdb_last_save|aof_last_write_status"
```

Expected output:

```
aof_enabled:1
rdb_last_save_time:1728000000
rdb_last_bgsave_status:ok
aof_last_write_status:ok
```

## Section 5: ACL Management

Redis 6+ Access Control Lists replace the single-password model with per-user command and key permissions. Defining ACLs via Kubernetes Secrets allows GitOps-managed rotation.

### Defining ACLs via Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: redis-acl-config
  namespace: redis
type: Opaque
stringData:
  users.acl: |
    user default off nopass nocommands nokeys
    user admin on >Admin$ecurePass99 ~* &* +@all
    user appuser on >App$ecurePass99 ~app:* &* +@read +@write +@string +@hash +@list +@set +@sortedset -@dangerous
    user monitoring on >Monitor$ecurePass99 ~* &* +info +ping +client|list +config|get +slowlog|get +latency|history
    user replica on >Replica$ecurePass99 ~* &* +psync +replconf +ping
```

The `default` user is disabled by setting it `off`, which forces all clients to authenticate with a named user. The `monitoring` user has read-only access to INFO and metric commands needed by the prometheus exporter.

Validate ACLs after deployment:

```bash
kubectl -n redis exec redis-replication-0 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' ACL LIST

kubectl -n redis exec redis-replication-0 -- \
  redis-cli --user appuser --pass 'App$ecurePass99' SET app:test "hello"

kubectl -n redis exec redis-replication-0 -- \
  redis-cli --user appuser --pass 'App$ecurePass99' GET app:test
```

### Application Connection Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: redis-app-credentials
  namespace: app
type: Opaque
stringData:
  REDIS_URL: "redis://appuser:App%24ecurePass99@redis-replication.redis.svc.cluster.local:6379/0"
  REDIS_PASSWORD: "App$ecurePass99"
  REDIS_USERNAME: "appuser"
```

## Section 6: TLS Encryption

TLS encrypts traffic between clients and Redis nodes. The Opstree operator integrates with cert-manager for automated certificate lifecycle management.

### Certificate Setup with cert-manager

```yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: redis-ca-issuer
  namespace: redis
spec:
  ca:
    secretName: redis-ca-secret
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: redis-tls
  namespace: redis
spec:
  secretName: redis-tls-secret
  duration: 8760h
  renewBefore: 720h
  subject:
    organizations:
      - support.tools
  commonName: redis-replication.redis.svc.cluster.local
  dnsNames:
    - redis-replication.redis.svc.cluster.local
    - redis-replication-0.redis-replication-headless.redis.svc.cluster.local
    - redis-replication-1.redis-replication-headless.redis.svc.cluster.local
    - redis-replication-2.redis-replication-headless.redis.svc.cluster.local
    - "*.redis-replication-headless.redis.svc.cluster.local"
  issuerRef:
    name: redis-ca-issuer
    kind: Issuer
```

### Enable TLS in RedisReplication

```yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisReplication
metadata:
  name: redis-replication
  namespace: redis
spec:
  clusterSize: 3
  kubernetesConfig:
    image: redis:7.2.4-alpine
  tls:
    secret:
      secretName: redis-tls-secret
    tlsConfig:
      certFile: /tls/tls.crt
      keyFile: /tls/tls.key
      caFile: /tls/ca.crt
  storage:
    volumeClaimTemplate:
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi
        storageClassName: fast-ssd
```

Test TLS connectivity:

```bash
kubectl -n redis exec -it redis-replication-0 -- redis-cli \
  --tls \
  --cert /tls/tls.crt \
  --key /tls/tls.key \
  --cacert /tls/ca.crt \
  -h redis-replication.redis.svc.cluster.local \
  --user monitoring \
  --pass 'Monitor$ecurePass99' \
  PING
```

Certificate rotation is handled automatically by cert-manager when the certificate approaches its `renewBefore` threshold. The operator detects the updated Secret and performs a rolling restart.

## Section 7: Prometheus ServiceMonitor and Alerting

The redis_exporter sidecar exposes metrics at `/metrics` on port 9121. The operator creates a ServiceMonitor automatically when `serviceMonitor.enabled: true`.

### ServiceMonitor Verification

```bash
kubectl -n redis get servicemonitor
kubectl -n redis describe servicemonitor redis-replication
```

### Essential Prometheus Alert Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: redis-alerts
  namespace: redis
  labels:
    release: prometheus
spec:
  groups:
    - name: redis.rules
      interval: 30s
      rules:
        - alert: RedisDown
          expr: redis_up == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Redis instance {{ $labels.instance }} is down"
            description: "Redis has been unavailable for more than 1 minute."

        - alert: RedisHighMemoryUsage
          expr: >
            redis_memory_used_bytes / redis_memory_max_bytes > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis memory usage above 85% on {{ $labels.instance }}"
            description: "Redis memory usage is {{ humanizePercentage $value }}."

        - alert: RedisTooManyConnections
          expr: >
            redis_connected_clients > redis_config_maxclients * 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis connection count approaching limit on {{ $labels.instance }}"

        - alert: RedisReplicationLag
          expr: redis_replication_lag > 30
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis replication lag on {{ $labels.instance }}"
            description: "Replication lag is {{ $value }} seconds."

        - alert: RedisRejectedConnections
          expr: increase(redis_rejected_connections_total[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Redis is rejecting connections on {{ $labels.instance }}"

        - alert: RedisSlowlogGrowing
          expr: increase(redis_slowlog_length[5m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis slowlog is growing on {{ $labels.instance }}"

        - alert: RedisClusterStateNotOk
          expr: redis_cluster_state != 1
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Redis cluster state is not OK on {{ $labels.instance }}"

        - alert: RedisKeyEvictions
          expr: increase(redis_evicted_keys_total[5m]) > 100
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Redis is evicting keys on {{ $labels.instance }}"
            description: "{{ $value }} keys evicted in the last 5 minutes."
```

### Key Metrics to Monitor

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `redis_up` | Instance availability | == 0 |
| `redis_memory_used_bytes` | Memory consumption | > 85% of max |
| `redis_connected_clients` | Active connections | > 80% of maxclients |
| `redis_replication_lag` | Replica sync delay | > 30 seconds |
| `redis_keyspace_hits_total` | Cache hit rate | < 95% ratio |
| `redis_slowlog_length` | Slow commands | Rapid increase |
| `redis_cluster_state` | Cluster health | != 1 |

## Section 8: Backup Strategies

### RDB Backup via CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: redis-rdb-backup
  namespace: redis
spec:
  schedule: "0 2 * * *"
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          serviceAccountName: redis-backup
          containers:
            - name: backup
              image: redis:7.2.4-alpine
              command:
                - /bin/sh
                - -c
                - |
                  set -e
                  TIMESTAMP=$(date +%Y%m%d_%H%M%S)

                  echo "Triggering BGSAVE on primary..."
                  redis-cli \
                    -h redis-replication.redis.svc.cluster.local \
                    -p 6379 \
                    --user admin \
                    --pass "${REDIS_ADMIN_PASSWORD}" \
                    BGSAVE

                  echo "Waiting for BGSAVE completion..."
                  TIMEOUT=120
                  ELAPSED=0
                  while true; do
                    STATUS=$(redis-cli \
                      -h redis-replication.redis.svc.cluster.local \
                      -p 6379 \
                      --user admin \
                      --pass "${REDIS_ADMIN_PASSWORD}" \
                      INFO persistence | grep rdb_bgsave_in_progress | cut -d: -f2 | tr -d '\r')
                    if [ "${STATUS}" = "0" ]; then
                      echo "BGSAVE completed."
                      break
                    fi
                    ELAPSED=$((ELAPSED + 5))
                    if [ $ELAPSED -ge $TIMEOUT ]; then
                      echo "BGSAVE timed out after ${TIMEOUT} seconds"
                      exit 1
                    fi
                    sleep 5
                  done

                  echo "Backup complete at ${TIMESTAMP}"
              env:
                - name: REDIS_ADMIN_PASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: redis-acl-config
                      key: admin-password
              resources:
                requests:
                  cpu: 50m
                  memory: 64Mi
                limits:
                  cpu: 200m
                  memory: 128Mi
```

### AOF Management

For AOF backups, trigger a rewrite to compact the log before copying:

```bash
# Trigger AOF rewrite on primary
kubectl -n redis exec redis-replication-0 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' BGREWRITEAOF

# Monitor rewrite progress
kubectl -n redis exec redis-replication-0 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' INFO persistence \
  | grep aof_rewrite_in_progress

# Copy AOF file when rewrite is complete (aof_rewrite_in_progress:0)
BACKUP_DATE=$(date +%Y%m%d)
kubectl -n redis cp \
  redis-replication-0:/data/appendonly.aof \
  ./redis-aof-backup-${BACKUP_DATE}.aof
```

### Restore Procedure

```bash
# Scale down the Redis deployment before restore
kubectl -n redis scale statefulset redis-replication --replicas=0

# Copy the RDB file into the primary pod's data volume
kubectl -n redis cp ./redis-dump-20271007.rdb redis-replication-0:/data/dump.rdb

# Ensure correct ownership
kubectl -n redis exec redis-replication-0 -- chown redis:redis /data/dump.rdb

# Scale back up — Redis will load the RDB on startup
kubectl -n redis scale statefulset redis-replication --replicas=3

# Verify data was restored
kubectl -n redis exec redis-replication-0 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' DBSIZE
```

## Section 9: Connection Pooling Patterns

Applications should not create a new Redis connection per request. Connection pooling reduces latency and prevents connection exhaustion at the Redis server.

### Go Connection Pool Configuration

```go
package cache

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisConfig holds all configuration for a Redis client.
type RedisConfig struct {
	// For Cluster mode, provide all shard addresses.
	// For Sentinel/single mode, provide the primary address.
	Addrs        []string
	Username     string
	Password     string
	DB           int
	PoolSize     int
	MinIdleConns int
	MaxRetries   int
	TLSEnabled   bool
	TLSCACertPath string
	Mode         string // "cluster", "sentinel", or "single"
	SentinelMaster string
}

// NewRedisClusterClient creates a cluster-aware Redis client.
func NewRedisClusterClient(cfg RedisConfig) (*redis.ClusterClient, error) {
	opts := &redis.ClusterOptions{
		Addrs:    cfg.Addrs,
		Username: cfg.Username,
		Password: cfg.Password,

		PoolSize:        cfg.PoolSize,
		MinIdleConns:    cfg.MinIdleConns,
		MaxIdleConns:    cfg.PoolSize / 2,
		ConnMaxIdleTime: 5 * time.Minute,
		ConnMaxLifetime: 30 * time.Minute,
		PoolTimeout:     4 * time.Second,

		MaxRetries:      cfg.MaxRetries,
		MinRetryBackoff: 8 * time.Millisecond,
		MaxRetryBackoff: 512 * time.Millisecond,

		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,

		ReadOnly:       true,
		RouteByLatency: true,
	}

	if cfg.TLSEnabled {
		tlsCfg, err := buildTLSConfig(cfg.TLSCACertPath)
		if err != nil {
			return nil, fmt.Errorf("building TLS config: %w", err)
		}
		opts.TLSConfig = tlsCfg
	}

	client := redis.NewClusterClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis cluster ping failed: %w", err)
	}
	return client, nil
}

// NewRedisSentinelClient creates a sentinel-aware Redis client.
func NewRedisSentinelClient(cfg RedisConfig) (*redis.Client, error) {
	opts := &redis.FailoverOptions{
		MasterName:       cfg.SentinelMaster,
		SentinelAddrs:    cfg.Addrs,
		Username:         cfg.Username,
		Password:         cfg.Password,
		DB:               cfg.DB,
		PoolSize:         cfg.PoolSize,
		MinIdleConns:     cfg.MinIdleConns,
		ConnMaxIdleTime:  5 * time.Minute,
		ConnMaxLifetime:  30 * time.Minute,
		MaxRetries:       cfg.MaxRetries,
		DialTimeout:      5 * time.Second,
		ReadTimeout:      3 * time.Second,
		WriteTimeout:     3 * time.Second,
	}

	if cfg.TLSEnabled {
		tlsCfg, err := buildTLSConfig(cfg.TLSCACertPath)
		if err != nil {
			return nil, fmt.Errorf("building TLS config: %w", err)
		}
		opts.TLSConfig = tlsCfg
	}

	client := redis.NewFailoverClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis sentinel ping failed: %w", err)
	}
	return client, nil
}

func buildTLSConfig(caCertPath string) (*tls.Config, error) {
	caCert, err := os.ReadFile(caCertPath)
	if err != nil {
		return nil, fmt.Errorf("reading CA cert: %w", err)
	}
	caCertPool := x509.NewCertPool()
	if !caCertPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("failed to parse CA certificate")
	}
	return &tls.Config{
		RootCAs:    caCertPool,
		MinVersion: tls.VersionTLS12,
	}, nil
}
```

### Pool Size Guidelines

Pool size should match application concurrency characteristics:

```
# Formula
pool_size = ceil(max_concurrent_redis_operations * avg_command_latency_sec * headroom_factor)

# Example: 500 goroutines, 2ms average latency, 4x headroom
pool_size = ceil(500 * 0.002 * 4) = ceil(4) = 4 per instance

# Practical minimums
# Small service (< 100 req/s):    PoolSize: 10
# Medium service (100-1000 req/s): PoolSize: 25
# High-traffic service (> 1000 req/s): PoolSize: 50-100
# Cluster mode: pool_size applies per shard node
```

## Section 10: Horizontal Scaling

Scale the Redis Cluster by increasing `clusterSize`. The operator handles slot rebalancing automatically when shards are added.

### Scaling Out from 3 to 4 Shards

```bash
# Patch the RedisCluster to add a shard
kubectl -n redis patch rediscluster redis-cluster \
  --type merge \
  --patch '{"spec":{"clusterSize":4}}'

# Watch the operator add nodes and rebalance slots
kubectl -n redis get pods -l redis.opstreelabs.in/cluster-name=redis-cluster -w

# Verify slot distribution after scaling
kubectl -n redis exec redis-cluster-leader-0 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' CLUSTER INFO \
  | grep -E "cluster_slots_assigned|cluster_known_nodes"

# Confirm all 16384 slots are assigned and no slot migration is in progress
kubectl -n redis exec redis-cluster-leader-0 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' CLUSTER NODES \
  | awk '{print $1, $3, $9}'
```

### Scaling In from 4 to 3 Shards

```bash
# Scale in — operator migrates slots before removing the node
kubectl -n redis patch rediscluster redis-cluster \
  --type merge \
  --patch '{"spec":{"clusterSize":3}}'

# The operator performs these steps automatically:
# 1. Identifies the shard to remove (typically the last one)
# 2. Migrates all its hash slots to remaining shards
# 3. Issues CLUSTER FORGET on all remaining nodes
# 4. Deletes the StatefulSet replica

# Monitor the migration
kubectl -n redis logs -l app.kubernetes.io/name=redis-operator -n redis-operator -f
```

### Vertical Scaling with Zero Downtime

For memory or CPU increases, patch the resource requests and limits. The operator performs a rolling restart:

```bash
kubectl -n redis patch redisreplication redis-replication \
  --type merge \
  --patch '{
    "spec": {
      "kubernetesConfig": {
        "resources": {
          "requests": {"cpu": "500m", "memory": "1Gi"},
          "limits": {"cpu": "2000m", "memory": "4Gi"}
        }
      }
    }
  }'
```

## Section 11: Failure Scenario Testing

Validate cluster behavior under failure conditions before promoting to production.

### Test Primary Node Failure

```bash
# Identify the primary pod
kubectl -n redis exec redis-replication-0 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' INFO replication \
  | grep -E "role:|master_host:|connected_slaves:"

# Delete the primary pod to simulate a failure
kubectl -n redis delete pod redis-replication-0

# Watch failover in real time
kubectl -n redis get pods -w &

# After ~30 seconds, check which replica was promoted
sleep 35
kubectl -n redis exec redis-replication-1 -- \
  redis-cli --user admin --pass 'Admin$ecurePass99' INFO replication \
  | grep "role:"
```

### Test Sentinel Failover

```bash
# Check current master via sentinel
kubectl -n redis exec redis-sentinel-0 -- \
  redis-cli -p 26379 SENTINEL masters

# Trigger a manual failover
kubectl -n redis exec redis-sentinel-0 -- \
  redis-cli -p 26379 SENTINEL failover mymaster

# Confirm the new master address
kubectl -n redis exec redis-sentinel-0 -- \
  redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
```

### Continuous Availability Test

Run this during failover to measure the actual downtime experienced by clients:

```bash
kubectl -n redis run failover-probe \
  --image=redis:7.2.4-alpine \
  --restart=Never \
  --rm \
  -it \
  -- sh -c '
    SUCCESS=0
    FAILURE=0
    while true; do
      RESULT=$(redis-cli \
        -h redis-replication.redis.svc.cluster.local \
        -p 6379 \
        --user monitoring \
        --pass "Monitor\$ecurePass99" \
        PING 2>&1)
      TIMESTAMP=$(date +%H:%M:%S.%3N)
      if [ "$RESULT" = "PONG" ]; then
        SUCCESS=$((SUCCESS + 1))
      else
        FAILURE=$((FAILURE + 1))
        echo "${TIMESTAMP} FAIL: ${RESULT}"
      fi
      sleep 0.5
    done
  '
```

### PodDisruptionBudget for Production Safety

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-replication-pdb
  namespace: redis
spec:
  minAvailable: 2
  selector:
    matchLabels:
      redis.opstreelabs.in/replication-name: redis-replication
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: redis-sentinel-pdb
  namespace: redis
spec:
  minAvailable: 2
  selector:
    matchLabels:
      redis.opstreelabs.in/sentinel-name: redis-sentinel
```

## Section 12: Production Readiness Checklist

```bash
#!/bin/bash
# redis-production-readiness-check.sh

NAMESPACE="redis"
REPLICATION_NAME="redis-replication"
SENTINEL_NAME="redis-sentinel"

echo "=== Redis Production Readiness Check ==="

echo ""
echo "1. Operator health"
kubectl -n redis-operator get pods --no-headers \
  | awk '{print $1, $3}' | grep -v "Running" && echo "WARN: non-Running pods found"

echo ""
echo "2. Redis pods status"
kubectl -n "${NAMESPACE}" get pods --no-headers \
  | awk '{print $1, $3}' | grep -v "Running"

echo ""
echo "3. PVC binding status"
kubectl -n "${NAMESPACE}" get pvc --no-headers \
  | awk '{print $1, $2}' | grep -v "Bound" && echo "WARN: unbound PVCs"

echo ""
echo "4. ServiceMonitor presence"
kubectl -n "${NAMESPACE}" get servicemonitor --no-headers | wc -l

echo ""
echo "5. PrometheusRule presence"
kubectl -n "${NAMESPACE}" get prometheusrule --no-headers | wc -l

echo ""
echo "6. TLS certificate Ready status"
kubectl -n "${NAMESPACE}" get certificate redis-tls \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null \
  || echo "No TLS certificate found"

echo ""
echo "7. Replication health"
kubectl -n "${NAMESPACE}" exec "${REPLICATION_NAME}-0" -- \
  redis-cli --user monitoring --pass 'Monitor$ecurePass99' \
  INFO replication 2>/dev/null \
  | grep -E "role:|connected_slaves:|master_link_status:"

echo ""
echo "8. Persistence enabled"
kubectl -n "${NAMESPACE}" exec "${REPLICATION_NAME}-0" -- \
  redis-cli --user monitoring --pass 'Monitor$ecurePass99' \
  INFO persistence 2>/dev/null \
  | grep -E "aof_enabled:|rdb_last_bgsave_status:"

echo ""
echo "9. PodDisruptionBudgets"
kubectl -n "${NAMESPACE}" get pdb --no-headers

echo ""
echo "10. Backup CronJob schedule"
kubectl -n "${NAMESPACE}" get cronjob redis-rdb-backup \
  -o jsonpath='{.spec.schedule}' 2>/dev/null || echo "No backup CronJob found"

echo ""
echo "=== Readiness check complete ==="
```

This guide provides a complete foundation for running Redis on Kubernetes in production using the Opstree operator. The combination of the operator's lifecycle management with proper persistence, ACLs, TLS, monitoring, and backup strategies delivers the reliability and security required for enterprise workloads. Teams moving from standalone Redis instances will find the operator dramatically reduces operational overhead while providing the same production-grade capabilities.
