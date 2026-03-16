---
title: "Redis Operator: Production Redis Cluster Management on Kubernetes"
date: 2027-03-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Redis", "Operator", "Database", "Cache"]
categories: ["Kubernetes", "Databases", "Caching"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying Redis with the Redis Operator (OpsTree) on Kubernetes, covering standalone, sentinel, and cluster topologies, TLS configuration, backup to S3, Prometheus monitoring with Redis Exporter, and operational runbooks for failover and scaling."
more_link: "yes"
url: "/redis-operator-kubernetes-production-guide/"
---

Running Redis on Kubernetes introduces a set of operational challenges that differ significantly from bare-metal or VM deployments: ephemeral Pod IPs break cluster gossip, volume reattachment on node failure must be handled without data loss, and the Kubernetes scheduler must be aware of data locality to avoid rebalancing storms. The OpsTree Redis Operator abstracts these concerns behind declarative custom resources, providing production-grade topologies for standalone, sentinel, and cluster modes while integrating with cert-manager for TLS, Prometheus for metrics, and S3-compatible object stores for backups.

This guide covers the full lifecycle: operator installation, standalone and cluster topology configuration, TLS setup, Redis Exporter metrics, S3 backup configuration, horizontal and vertical scaling, Prometheus alerting rules, and operational runbooks for failover testing and cluster rebalancing.

<!--more-->

## Section 1: Architecture Overview

### Topology Comparison

```
Standalone                Sentinel                  Cluster
──────────                ────────                  ───────
┌──────────┐              ┌──────────┐              ┌──────────────────────────────────┐
│  Redis   │              │  Redis   │              │  Shard 0    Shard 1    Shard 2   │
│ (single  │              │ Primary  │              │ ┌────────┐ ┌────────┐ ┌────────┐ │
│  Pod)    │              └────┬─────┘              │ │Leader  │ │Leader  │ │Leader  │ │
└──────────┘                   │ async repl         │ └───┬────┘ └───┬────┘ └───┬────┘ │
                          ┌────▼──────┐             │    │          │          │       │
                          │  Replica  │             │ ┌──▼───┐  ┌──▼───┐  ┌──▼───┐   │
                          └──────────-┘             │ │Follow│  │Follow│  │Follow│   │
                          ┌──────────┐              │ └──────┘  └──────┘  └──────┘   │
                          │Sentinel-1│              └──────────────────────────────────┘
                          │Sentinel-2│              16384 hash slots distributed
                          │Sentinel-3│              across shards
                          └──────────┘

Use Case:
Dev/small cache           HA with auto-failover      Horizontal scaling >
                          (no client sharding)       single-node memory
```

### OpsTree Operator Components

The OpsTree Redis Operator deploys a controller that watches `Redis`, `RedisCluster`, `RedisReplication`, and `RedisSentinel` custom resources. It manages:

- StatefulSets for Redis Pods with stable network identities
- Services for leader/follower endpoint exposure
- ConfigMaps for Redis configuration (`redis.conf` parameters)
- Secrets mounting for TLS certificates and ACL passwords
- Init containers for cluster initialization and slot assignment

---

## Section 2: Operator Installation

### Install via Helm

```bash
helm repo add ot-helm https://ot-container-kit.github.io/helm-charts/
helm repo update

helm upgrade --install redis-operator ot-helm/redis-operator \
  --namespace redis-operator \
  --create-namespace \
  --version 0.15.1 \
  --set redisOperator.imagePullPolicy=IfNotPresent \
  --wait
```

### Verify CRDs

```bash
kubectl get crd | grep redis
# Expected:
# redis.redis.redis.opstreelabs.in
# redisclusters.redis.redis.opstreelabs.in
# redisreplications.redis.redis.opstreelabs.in
# redissentinels.redis.redis.opstreelabs.in

# Check operator Pod
kubectl get pods -n redis-operator
```

---

## Section 3: Standalone Redis

Standalone mode deploys a single Redis Pod. Use this for development, feature flags, rate-limiting counters, or workloads where the data set is fully reproducible and HA is not required.

### Standalone Redis CRD

```yaml
# redis-standalone.yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: Redis
metadata:
  name: redis-standalone
  namespace: cache
spec:
  kubernetesConfig:
    image: "quay.io/opstree/redis:v7.2.3"
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "250m"
        memory: "256Mi"
      limits:
        cpu: "1"
        memory: "1Gi"

  redisConfig:
    additionalRedisConfig: redis-standalone-config

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: standard-rwo
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 5Gi

  # Enable Redis Exporter sidecar
  redisExporter:
    enabled: true
    image: "quay.io/opstree/redis-exporter:v1.44.0"
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "50m"
        memory: "64Mi"
      limits:
        cpu: "200m"
        memory: "128Mi"
```

### Redis Configuration ConfigMap

```yaml
# redis-standalone-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-standalone-config
  namespace: cache
data:
  redis-additional.conf: |
    # Memory management
    maxmemory 800mb
    maxmemory-policy allkeys-lru

    # Persistence: RDB snapshot
    save 900 1
    save 300 10
    save 60 10000

    # Append-only file for durability
    appendonly yes
    appendfsync everysec
    no-appendfsync-on-rewrite no
    auto-aof-rewrite-percentage 100
    auto-aof-rewrite-min-size 64mb

    # Slow log
    slowlog-log-slower-than 10000
    slowlog-max-len 256

    # Keyspace notifications (useful for expiry events)
    notify-keyspace-events "Ex"
```

---

## Section 4: Redis Sentinel (High Availability)

Redis Sentinel provides automatic failover without client-side sharding. When the primary becomes unavailable, Sentinel elects a new primary from the replicas and updates clients via service discovery.

### RedisReplication CRD

```yaml
# redis-replication.yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisReplication
metadata:
  name: redis-ha
  namespace: cache
spec:
  clusterSize: 3   # 1 primary + 2 replicas

  kubernetesConfig:
    image: "quay.io/opstree/redis:v7.2.3"
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "2"
        memory: "2Gi"

  redisConfig:
    additionalRedisConfig: redis-ha-config

  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: premium-rwo
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi

  redisExporter:
    enabled: true
    image: "quay.io/opstree/redis-exporter:v1.44.0"

  # Pod disruption budget: at most 1 Pod unavailable at a time
  podDisruptionBudget:
    maxUnavailable: 1

  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values:
                  - redis-ha
          topologyKey: kubernetes.io/hostname
```

### RedisSentinel CRD

```yaml
# redis-sentinel.yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisSentinel
metadata:
  name: redis-ha-sentinel
  namespace: cache
spec:
  clusterSize: 3   # Always use an odd number of Sentinel instances

  redisSentinelConfig:
    redisReplicationName: redis-ha    # Name of RedisReplication above
    masterGroupName: "mymaster"
    redisPort: "6379"
    sentinelPort: "26379"
    # Quorum: number of Sentinels that must agree the primary is down
    quorum: "2"
    # Seconds after which a failover is re-triggered if it doesn't complete
    failoverTimeout: "180000"
    # Milliseconds between Sentinel pings to the primary
    downAfterMilliseconds: "5000"
    parallelSyncs: "1"

  kubernetesConfig:
    image: "quay.io/opstree/redis-sentinel:v7.2.3"
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "500m"
        memory: "256Mi"
```

### Sentinel-Aware Client Configuration

```python
# Python (redis-py sentinel client)
from redis.sentinel import Sentinel

sentinel = Sentinel(
    [
        ("redis-ha-sentinel-0.redis-ha-sentinel-headless.cache.svc.cluster.local", 26379),
        ("redis-ha-sentinel-1.redis-ha-sentinel-headless.cache.svc.cluster.local", 26379),
        ("redis-ha-sentinel-2.redis-ha-sentinel-headless.cache.svc.cluster.local", 26379),
    ],
    socket_timeout=0.5,
    password="EXAMPLE_REDIS_PASSWORD_REPLACE_ME",
)

# Get primary connection (writes)
master = sentinel.master_for("mymaster", socket_timeout=0.5)

# Get replica connection (reads)
slave = sentinel.slave_for("mymaster", socket_timeout=0.5)
```

---

## Section 5: Redis Cluster (Horizontal Sharding)

Redis Cluster distributes data across multiple shards using consistent hashing with 16384 hash slots. Use this topology when data exceeds single-node memory or when write throughput requires horizontal scaling.

### RedisCluster CRD

```yaml
# redis-cluster.yaml
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisCluster
metadata:
  name: redis-cluster-prod
  namespace: cache
spec:
  # Number of leader (primary shard) Pods
  clusterSize: 3

  # Number of follower Pods per leader
  clusterVersion: "7"

  kubernetesConfig:
    image: "quay.io/opstree/redis:v7.2.3"
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: "1"
        memory: "2Gi"
      limits:
        cpu: "4"
        memory: "8Gi"

  redisLeader:
    replicas: 3
    redisConfig:
      additionalRedisConfig: redis-cluster-config

    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: premium-rwo
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 50Gi

    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
                - key: redis-role
                  operator: In
                  values:
                    - leader
            topologyKey: kubernetes.io/hostname

  redisFollower:
    replicas: 3                      # 1 follower per leader (total 6 Pods)
    redisConfig:
      additionalRedisConfig: redis-cluster-config

    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: premium-rwo
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 50Gi

    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
                - key: redis-role
                  operator: In
                  values:
                    - follower
            topologyKey: kubernetes.io/hostname

  redisExporter:
    enabled: true
    image: "quay.io/opstree/redis-exporter:v1.44.0"

  podDisruptionBudget:
    maxUnavailable: 1
```

### Redis Cluster Configuration ConfigMap

```yaml
# redis-cluster-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-cluster-config
  namespace: cache
data:
  redis-additional.conf: |
    # Cluster mode is enabled automatically by the operator
    cluster-node-timeout 15000
    cluster-require-full-coverage no     # Allow reads even with missing slots
    cluster-migration-barrier 1
    cluster-allow-reads-when-down no

    # Memory management
    maxmemory 6gb
    maxmemory-policy allkeys-lru

    # No persistence on cluster nodes (replicated data provides durability)
    save ""
    appendonly no

    # Slow log
    slowlog-log-slower-than 10000
    slowlog-max-len 256
```

### Verify Cluster Status

```bash
# Get cluster info from any leader Pod
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli cluster info

# Get cluster node topology
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli cluster nodes

# Check slot distribution
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli cluster slots
```

---

## Section 6: TLS Configuration

### Create TLS Certificates with cert-manager

```yaml
# redis-tls-cert.yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: redis-cluster-tls
  namespace: cache
spec:
  secretName: redis-cluster-tls-secret
  duration: 8760h          # 1 year
  renewBefore: 720h        # Renew 30 days before expiry
  subject:
    organizations:
      - "company.internal"
  commonName: "redis-cluster-prod"
  dnsNames:
    - "redis-cluster-prod-leader.cache.svc.cluster.local"
    - "redis-cluster-prod-follower.cache.svc.cluster.local"
    - "redis-cluster-prod-leader-0.redis-cluster-prod-leader-headless.cache.svc.cluster.local"
    - "redis-cluster-prod-leader-1.redis-cluster-prod-leader-headless.cache.svc.cluster.local"
    - "redis-cluster-prod-leader-2.redis-cluster-prod-leader-headless.cache.svc.cluster.local"
  issuerRef:
    name: company-internal-issuer
    kind: ClusterIssuer
```

### Reference TLS in RedisCluster

```yaml
# redis-cluster-tls.yaml (partial)
spec:
  tls:
    secret:
      secretName: redis-cluster-tls-secret
    tlsPort: 6380     # TLS port alongside plain 6379
```

### Test TLS Connection

```bash
# Test encrypted connection to Redis cluster
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli \
    --tls \
    --cert /tls/tls.crt \
    --key /tls/tls.key \
    --cacert /tls/ca.crt \
    -p 6380 \
    ping
# Expected: PONG
```

---

## Section 7: ACL and Password Authentication

### ACL ConfigMap

```yaml
# redis-acl.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-acl-config
  namespace: cache
data:
  users.acl: |
    # Default user: disable direct access
    user default off nopass ~* &* -@all

    # Application user: full access to all keys
    user appuser on >EXAMPLE_APP_PASSWORD_REPLACE_ME ~* &* +@all -DEBUG

    # Read-only user: GET, MGET, SCAN, KEYS only
    user readonly on >EXAMPLE_READONLY_PASSWORD_REPLACE_ME ~* &* +GET +MGET +SCAN +KEYS +TTL +TYPE +OBJECT

    # Monitoring user: INFO and CONFIG GET only
    user prometheus on >EXAMPLE_PROMETHEUS_PASSWORD_REPLACE_ME ~* &* +INFO +CONFIG|GET +LATENCY +SLOWLOG|GET +DBSIZE +CLUSTER|INFO +COMMAND|COUNT
```

### Mount ACL in Redis Deployment

```yaml
# redis-cluster-acl.yaml (partial)
spec:
  kubernetesConfig:
    redisSecret:
      name: redis-acl-secret
      key: password

  redisConfig:
    additionalRedisConfig: redis-cluster-config

  # Mount ACL file via volume
  volumeMount:
    - name: acl-config
      mountPath: /etc/redis/users.acl
      subPath: users.acl
  volumes:
    - name: acl-config
      configMap:
        name: redis-acl-config
```

---

## Section 8: S3 Backup Configuration

The OpsTree operator supports scheduled backups to S3-compatible storage. Backups use `redis-dump.go` (for RDB) or a custom script that calls `BGSAVE` and uploads the dump file.

### Backup Secret

```bash
kubectl create secret generic redis-backup-s3 \
  --namespace cache \
  --from-literal=access_key=EXAMPLE_AWS_ACCESS_KEY_REPLACE_ME \
  --from-literal=secret_key=EXAMPLE_S3_SECRET_REPLACE_ME
```

### Backup CronJob

```yaml
# redis-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: redis-cluster-backup
  namespace: cache
spec:
  schedule: "0 1 * * *"           # Daily at 01:00 UTC
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: redis-backup
              image: "quay.io/opstree/redis-tools:v0.3.0"
              env:
                - name: REDIS_HOST
                  value: "redis-cluster-prod-leader.cache.svc.cluster.local"
                - name: REDIS_PORT
                  value: "6379"
                - name: REDIS_PASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: redis-acl-secret
                      key: password
                - name: S3_BUCKET
                  value: "company-redis-backups"
                - name: S3_PREFIX
                  value: "redis-cluster-prod"
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: redis-backup-s3
                      key: access_key
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: redis-backup-s3
                      key: secret_key
                - name: AWS_DEFAULT_REGION
                  value: "us-east-1"
              command:
                - /bin/sh
                - -c
                - |
                  set -e
                  # Trigger background save on all leader nodes
                  for node in $(redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" cluster nodes \
                    | grep master | awk '{print $2}' | cut -d: -f1); do
                    redis-cli -h "$node" -p 6379 -a "$REDIS_PASSWORD" BGSAVE
                    sleep 5
                    redis-cli -h "$node" -p 6379 -a "$REDIS_PASSWORD" LASTSAVE
                  done

                  # Upload dump files to S3
                  DATE=$(date +%Y%m%d_%H%M%S)
                  for pod in redis-cluster-prod-leader-0 redis-cluster-prod-leader-1 redis-cluster-prod-leader-2; do
                    kubectl exec "$pod" -n cache -- \
                      aws s3 cp /data/dump.rdb \
                        "s3://$S3_BUCKET/$S3_PREFIX/$pod/$DATE/dump.rdb" \
                        --region "$AWS_DEFAULT_REGION"
                  done
```

---

## Section 9: Prometheus Monitoring

### ServiceMonitor for Redis Exporter

```yaml
# redis-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: redis-cluster-metrics
  namespace: cache
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      app: redis-cluster-prod
      redis-exporter: "true"
  namespaceSelector:
    matchNames:
      - cache
  endpoints:
    - port: redis-exporter
      interval: 30s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_redis_role]
          targetLabel: role
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
```

### Prometheus Alerting Rules

```yaml
# redis-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: redis-production-alerts
  namespace: cache
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: redis.cluster
      interval: 30s
      rules:
        # Memory pressure: used memory > 90% of maxmemory
        - alert: RedisMemoryPressure
          expr: |
            redis_memory_used_bytes / redis_config_maxmemory > 0.90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis memory pressure on {{ $labels.pod }}"
            description: "Redis Pod {{ $labels.pod }} is using {{ $value | humanizePercentage }} of maxmemory."

        # Connection exhaustion: connected clients > 90% of maxclients
        - alert: RedisConnectionExhaustion
          expr: |
            redis_connected_clients / redis_config_maxclients > 0.90
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Redis connection exhaustion on {{ $labels.pod }}"
            description: "{{ $value | humanizePercentage }} of max client connections in use on {{ $labels.pod }}."

        # Replication lag > 100MB
        - alert: RedisReplicationLag
          expr: |
            redis_replication_backlog_size > 104857600
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis replication backlog large on {{ $labels.pod }}"
            description: "Replication backlog is {{ $value | humanize1024 }}B on {{ $labels.pod }}."

        # Key eviction rate > 100/s (indicates memory pressure causing data loss)
        - alert: RedisKeyEviction
          expr: |
            rate(redis_evicted_keys_total[5m]) > 100
          labels:
            severity: critical
          annotations:
            summary: "Redis key eviction on {{ $labels.pod }}"
            description: "{{ $value | humanize }} keys/s are being evicted due to memory pressure."

        # Cluster node down
        - alert: RedisClusterNodeDown
          expr: |
            redis_cluster_stats_pfail_nodes > 0 or redis_cluster_stats_fail_nodes > 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Redis cluster node down (cluster {{ $labels.cluster }})"
            description: "One or more cluster nodes are in PFAIL/FAIL state."

        # RDB save failed
        - alert: RedisRDBSaveFailed
          expr: |
            redis_rdb_last_bgsave_status == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis RDB save failed on {{ $labels.pod }}"
            description: "Last BGSAVE on {{ $labels.pod }} failed."

        # Keyspace hit rate < 80%
        - alert: RedisLowHitRate
          expr: |
            redis_keyspace_hits_total / (redis_keyspace_hits_total + redis_keyspace_misses_total) < 0.80
          for: 10m
          labels:
            severity: info
          annotations:
            summary: "Redis cache hit rate low on {{ $labels.pod }}"
            description: "Cache hit rate on {{ $labels.pod }} is {{ $value | humanizePercentage }}."
```

---

## Section 10: Horizontal Scaling (Adding Shards)

Adding shards to a running Redis Cluster requires rebalancing hash slots. The operator supports online scaling.

### Add a Shard to RedisCluster

```bash
# Scale the RedisCluster from 3 leaders to 4 leaders
kubectl patch rediscluster redis-cluster-prod -n cache \
  --type merge \
  --patch '{"spec":{"clusterSize":4,"redisLeader":{"replicas":4},"redisFollower":{"replicas":4}}}'

# Watch new Pods come up
kubectl get pods -n cache -l app=redis-cluster-prod -w
```

### Rebalance Slots

After new nodes are added, hash slots must be rebalanced to include the new shard. The operator triggers this automatically, but manual rebalancing can be forced:

```bash
# Identify the new node ID
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli cluster nodes | grep -v "connected"

# Rebalance slots across all nodes
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli --cluster rebalance \
    redis-cluster-prod-leader-0.redis-cluster-prod-leader-headless.cache.svc.cluster.local:6379 \
    --cluster-use-empty-masters \
    --cluster-threshold 2

# Verify even slot distribution
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli cluster info | grep cluster_slots
```

---

## Section 11: Vertical Scaling

Vertical scaling (changing CPU/memory) requires a rolling restart. The operator supports in-place resource updates.

### Update Resources

```bash
# Update memory and CPU limits
kubectl patch rediscluster redis-cluster-prod -n cache \
  --type merge \
  --patch '{
    "spec": {
      "kubernetesConfig": {
        "resources": {
          "requests": {"cpu": "2", "memory": "4Gi"},
          "limits": {"cpu": "8", "memory": "16Gi"}
        }
      }
    }
  }'

# Update maxmemory in the ConfigMap to match new limit
kubectl patch configmap redis-cluster-config -n cache \
  --type merge \
  --patch '{"data":{"redis-additional.conf":"maxmemory 12gb\nmaxmemory-policy allkeys-lru\ncluster-node-timeout 15000\n"}}'

# Rolling restart to apply config
kubectl rollout restart statefulset redis-cluster-prod-leader -n cache
kubectl rollout restart statefulset redis-cluster-prod-follower -n cache
```

---

## Section 12: Sentinel Failover Testing

Regular failover drills verify that Sentinel correctly promotes a replica and that applications reconnect within acceptable time windows.

### Manual Failover Test

```bash
# Record current primary
kubectl exec -n cache redis-ha-0 -- \
  redis-cli -p 26379 sentinel master mymaster | grep -A1 "^ip"

# Simulate primary failure by sending DEBUG SLEEP
kubectl exec -n cache redis-ha-0 -- \
  redis-cli DEBUG SLEEP 60

# Within 5-10 seconds, Sentinel should elect a new primary
# Monitor sentinel logs
kubectl logs -n cache -l app=redis-ha-sentinel -f | grep -i "failover"

# Verify new primary
kubectl exec -n cache redis-ha-sentinel-0 -- \
  redis-cli -p 26379 sentinel master mymaster | grep -A1 "^ip"

# Confirm application can still read/write
kubectl exec -n cache redis-ha-0 -- \
  redis-cli -p 26379 sentinel get-master-addr-by-name mymaster
```

### Measuring Failover Time

```bash
# Script to measure time from primary death to new primary availability
START=$(date +%s%N)

# Kill primary Pod
kubectl delete pod redis-ha-0 -n cache

# Poll until a new primary is available
while true; do
  PRIMARY=$(kubectl exec -n cache redis-ha-sentinel-0 -- \
    redis-cli -p 26379 sentinel master mymaster 2>/dev/null | grep -A1 "^ip" | tail -1)
  if [ -n "$PRIMARY" ]; then
    END=$(date +%s%N)
    ELAPSED_MS=$(( (END - START) / 1000000 ))
    echo "New primary available after ${ELAPSED_MS}ms: $PRIMARY"
    break
  fi
  sleep 0.5
done
```

---

## Section 13: Redis Upgrade Procedure

### Rolling Minor Version Upgrade

```bash
# Update image tag in the RedisCluster spec
kubectl patch rediscluster redis-cluster-prod -n cache \
  --type merge \
  --patch '{"spec":{"kubernetesConfig":{"image":"quay.io/opstree/redis:v7.2.4"}}}'

# The operator will perform a rolling update of follower Pods first,
# then trigger a failover and update leader Pods one by one.
# Watch progress:
kubectl rollout status statefulset redis-cluster-prod-follower -n cache
kubectl rollout status statefulset redis-cluster-prod-leader -n cache
```

### Verify Version After Upgrade

```bash
# Check Redis server version
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli info server | grep redis_version
```

---

## Section 14: NetworkPolicy for Redis Isolation

```yaml
# redis-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: redis-cluster-allow
  namespace: cache
spec:
  podSelector:
    matchLabels:
      app: redis-cluster-prod
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow connections from application Pods in the app namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: application
      ports:
        - protocol: TCP
          port: 6379
        - protocol: TCP
          port: 6380   # TLS
    # Allow Redis cluster inter-node gossip (port 16379)
    - from:
        - podSelector:
            matchLabels:
              app: redis-cluster-prod
      ports:
        - protocol: TCP
          port: 16379
        - protocol: TCP
          port: 6379
    # Allow Prometheus scraping
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 9121   # redis_exporter port
  egress:
    # Inter-cluster gossip and replication
    - to:
        - podSelector:
            matchLabels:
              app: redis-cluster-prod
      ports:
        - protocol: TCP
          port: 6379
        - protocol: TCP
          port: 16379
    # S3 backup uploads
    - to: []
      ports:
        - protocol: TCP
          port: 443
    # DNS
    - to: []
      ports:
        - protocol: UDP
          port: 53
```

---

## Section 15: Operational Runbook Reference

### Check Cluster Health

```bash
# Full cluster status
kubectl exec -n cache redis-cluster-prod-leader-0 -- redis-cli cluster info

# Node roles and slot assignments
kubectl exec -n cache redis-cluster-prod-leader-0 -- redis-cli cluster nodes

# Memory usage per node
for pod in redis-cluster-prod-leader-0 redis-cluster-prod-leader-1 redis-cluster-prod-leader-2; do
  echo "=== $pod ==="
  kubectl exec -n cache "$pod" -- redis-cli info memory | grep -E "used_memory_human|maxmemory_human|mem_fragmentation_ratio"
done
```

### Flush a Database (Development Only)

```bash
# WARNING: This permanently deletes all data in the specified database
# Never run against production without explicit change control approval
kubectl exec -n cache redis-standalone-0 -- \
  redis-cli -a EXAMPLE_APP_PASSWORD_REPLACE_ME FLUSHDB ASYNC
```

### Debug Slow Commands

```bash
# View slow log entries
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli slowlog get 25

# Reset slow log
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli slowlog reset
```

### Check Key Expiry and TTL Distribution

```bash
# Count keys per database
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli info keyspace

# Count keys with no TTL (potential memory leak indicators)
kubectl exec -n cache redis-cluster-prod-leader-0 -- \
  redis-cli eval "
    local count = 0
    local cursor = '0'
    repeat
      local result = redis.call('SCAN', cursor, 'COUNT', '1000')
      cursor = result[1]
      for _, key in ipairs(result[2]) do
        if redis.call('TTL', key) == -1 then
          count = count + 1
        end
      end
    until cursor == '0'
    return count
  " 0
```

The OpsTree Redis Operator provides a mature, production-tested approach to running all Redis topologies on Kubernetes. By expressing topology intent through CRDs, teams gain declarative lifecycle management, automated cluster healing, integrated Prometheus observability, and consistent operational procedures across standalone, sentinel, and cluster deployments. The combination of anti-affinity rules, PodDisruptionBudgets, and Sentinel-based failover delivers the HA characteristics needed for production cache infrastructure without the manual coordination overhead of self-managed Redis deployments.
