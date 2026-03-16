---
title: "Redis Cluster Management Patterns on Kubernetes: Enterprise Production Guide"
date: 2026-11-06T00:00:00-05:00
draft: false
tags: ["Redis", "Kubernetes", "Clustering", "In-Memory", "Caching", "High Availability"]
categories: ["Database", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and managing Redis clusters on Kubernetes with high availability, automatic failover, data persistence, and performance optimization strategies."
more_link: "yes"
url: "/redis-cluster-management-patterns-kubernetes-enterprise-guide/"
---

Managing Redis clusters on Kubernetes requires understanding of clustering modes, replication strategies, persistence options, and failover mechanisms. This comprehensive guide covers enterprise-grade Redis cluster deployments with production-ready configurations for high availability and performance.

We'll explore Redis Cluster mode, Sentinel-based HA, Redis Operator implementations, and advanced patterns for caching, session management, and real-time data processing at scale.

<!--more-->

# Redis Cluster Management Patterns on Kubernetes

## Understanding Redis Cluster Architecture

### Redis Cluster vs Sentinel Architecture

**1. Redis Cluster Mode Configuration**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-cluster-config
  namespace: redis
data:
  redis.conf: |
    # Cluster mode configuration
    cluster-enabled yes
    cluster-config-file nodes.conf
    cluster-node-timeout 5000
    cluster-require-full-coverage no
    cluster-migration-barrier 1
    cluster-allow-reads-when-down no

    # Network configuration
    bind 0.0.0.0
    port 6379
    tcp-backlog 511
    timeout 0
    tcp-keepalive 300

    # Memory management
    maxmemory 4gb
    maxmemory-policy allkeys-lru
    maxmemory-samples 5

    # Persistence
    appendonly yes
    appendfilename "appendonly.aof"
    appendfsync everysec
    no-appendfsync-on-rewrite no
    auto-aof-rewrite-percentage 100
    auto-aof-rewrite-min-size 64mb

    # RDB snapshots
    save 900 1
    save 300 10
    save 60 10000
    stop-writes-on-bgsave-error yes
    rdbcompression yes
    rdbchecksum yes
    dbfilename dump.rdb

    # Replication
    repl-diskless-sync no
    repl-diskless-sync-delay 5
    repl-disable-tcp-nodelay no
    slave-priority 100

    # Security
    requirepass ""
    rename-command FLUSHDB ""
    rename-command FLUSHALL ""
    rename-command CONFIG "CONFIG_d8b3d85a6f"

    # Slow log
    slowlog-log-slower-than 10000
    slowlog-max-len 128

    # Latency monitoring
    latency-monitor-threshold 100

    # Performance tuning
    hz 10
    dynamic-hz yes
    aof-rewrite-incremental-fsync yes
    rdb-save-incremental-fsync yes
```

**2. Redis Sentinel Configuration**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-sentinel-config
  namespace: redis
data:
  sentinel.conf: |
    port 26379
    dir /data

    # Monitor master
    sentinel monitor mymaster redis-master-0.redis-master.redis.svc.cluster.local 6379 2
    sentinel down-after-milliseconds mymaster 5000
    sentinel parallel-syncs mymaster 1
    sentinel failover-timeout mymaster 10000

    # Notification scripts
    sentinel notification-script mymaster /scripts/notify.sh
    sentinel client-reconfig-script mymaster /scripts/reconfig.sh

    # Authentication
    sentinel auth-pass mymaster ${REDIS_PASSWORD}

    # Deny dangerous commands
    sentinel deny-scripts-reconfig yes

  notify.sh: |
    #!/bin/bash
    # Notification script for sentinel events
    EVENT_TYPE=$1
    EVENT_NAME=$2

    curl -X POST http://alertmanager:9093/api/v1/alerts -d "[{
      \"labels\": {
        \"alertname\": \"RedisSentinelEvent\",
        \"event_type\": \"$EVENT_TYPE\",
        \"event_name\": \"$EVENT_NAME\",
        \"severity\": \"warning\"
      },
      \"annotations\": {
        \"summary\": \"Redis Sentinel event: $EVENT_TYPE\"
      }
    }]"

  reconfig.sh: |
    #!/bin/bash
    # Reconfiguration script after failover
    MASTER_NAME=$1
    ROLE=$2
    STATE=$3
    FROM_IP=$4
    FROM_PORT=$5
    TO_IP=$6
    TO_PORT=$7

    echo "Failover detected: $FROM_IP:$FROM_PORT -> $TO_IP:$TO_PORT"

    # Update application configuration
    kubectl patch configmap app-config -n application \
      --type merge \
      -p "{\"data\":{\"redis_host\":\"$TO_IP\",\"redis_port\":\"$TO_PORT\"}}"

    # Trigger rolling restart of application pods
    kubectl rollout restart deployment/app -n application
```

## Redis Operator Deployment

### Using Redis Enterprise Operator

**1. Install Redis Enterprise Operator**
```bash
# Add Redis Enterprise Operator repository
kubectl apply -f https://raw.githubusercontent.com/RedisLabs/redis-enterprise-k8s-docs/master/bundle.yaml

# Or via Helm
helm repo add redis https://raw.githubusercontent.com/RedisLabs/redis-enterprise-k8s-docs/master/helm-charts
helm install redis-enterprise redis/redis-enterprise \
  --namespace redis-enterprise \
  --create-namespace
```

**2. Redis Enterprise Cluster**
```yaml
apiVersion: app.redislabs.com/v1
kind: RedisEnterpriseCluster
metadata:
  name: production-rec
  namespace: redis-enterprise
spec:
  nodes: 3

  persistentSpec:
    enabled: true
    storageClassName: "fast-ssd"
    volumeSize: 100Gi

  redisEnterpriseNodeResources:
    limits:
      cpu: "4"
      memory: 16Gi
    requests:
      cpu: "2"
      memory: 8Gi

  redisEnterpriseImageSpec:
    imagePullPolicy: IfNotPresent
    repository: redislabs/redis
    versionTag: 7.2.0-92

  bootstrapperImageSpec:
    imagePullPolicy: IfNotPresent
    repository: redislabs/operator
    versionTag: 7.2.0-2

  redisEnterpriseServicesRiggerImageSpec:
    imagePullPolicy: IfNotPresent
    repository: redislabs/services-manager
    versionTag: 7.2.0-2

  serviceBrokerSpec:
    enabled: false

  createServiceAccount: true

  podAnnotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "8070"

  clusterCredentialSecretName: production-rec-credentials
  clusterCredentialSecretType: kubernetes
  clusterCredentialSecretRole: ""

  sideContainersSpec:
    - name: metrics-exporter
      image: oliver006/redis_exporter:latest
      resources:
        limits:
          cpu: 100m
          memory: 256Mi
        requests:
          cpu: 50m
          memory: 128Mi
      env:
        - name: REDIS_ADDR
          value: "localhost:6379"
---
apiVersion: app.redislabs.com/v1alpha1
kind: RedisEnterpriseDatabase
metadata:
  name: production-db
  namespace: redis-enterprise
spec:
  redisEnterpriseCluster:
    name: production-rec

  memorySize: 10GB
  replication: true
  shardCount: 3

  persistence: aofEverySecond

  modulesList:
    - name: search
      version: "2.6.6"
    - name: timeseries
      version: "1.8.10"
    - name: ReJSON
      version: "2.4.7"

  redisEnterpriseCluster:
    name: production-rec

  tlsMode:
    enabled: true

  proxyPolicy: all-master-shards

  rolesPermissions:
    - type: redis-enterprise-admin
      acl: "+@all ~*"

  alertSettings:
    emailAlerts: true

  backup:
    interval: 12
    timeout: 600

  type: redis

  defaultUser: true

  clientAuthenticationCertificates: []

  evictionPolicy: "allkeys-lru"

  rofRules:
    - rule: "local-shard-on-master"

  resp3: true
```

### StatefulSet-based Redis Cluster

**1. Redis Cluster StatefulSet**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis-cluster
  namespace: redis
  labels:
    app: redis-cluster
spec:
  clusterIP: None
  ports:
    - port: 6379
      targetPort: 6379
      name: client
    - port: 16379
      targetPort: 16379
      name: gossip
  selector:
    app: redis-cluster
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: redis
spec:
  serviceName: redis-cluster
  replicas: 6
  selector:
    matchLabels:
      app: redis-cluster
  template:
    metadata:
      labels:
        app: redis-cluster
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9121"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - redis-cluster
              topologyKey: kubernetes.io/hostname

      containers:
        - name: redis
          image: redis:7.2-alpine
          command:
            - redis-server
          args:
            - /conf/redis.conf
            - --cluster-enabled yes
            - --cluster-config-file /data/nodes.conf
          ports:
            - containerPort: 6379
              name: client
            - containerPort: 16379
              name: gossip
          volumeMounts:
            - name: conf
              mountPath: /conf
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "2"
              memory: 4Gi
          livenessProbe:
            tcpSocket:
              port: 6379
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            exec:
              command:
                - redis-cli
                - ping
            initialDelaySeconds: 5
            periodSeconds: 5

        - name: metrics
          image: oliver006/redis_exporter:latest
          ports:
            - containerPort: 9121
              name: metrics
          env:
            - name: REDIS_ADDR
              value: "localhost:6379"
          resources:
            requests:
              cpu: "100m"
              memory: 128Mi
            limits:
              cpu: "200m"
              memory: 256Mi

      volumes:
        - name: conf
          configMap:
            name: redis-cluster-config

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
---
apiVersion: batch/v1
kind: Job
metadata:
  name: redis-cluster-init
  namespace: redis
spec:
  template:
    spec:
      containers:
        - name: redis-cli
          image: redis:7.2-alpine
          command:
            - /bin/sh
            - -c
            - |
              set -e

              # Wait for all pods to be ready
              for i in {0..5}; do
                until redis-cli -h redis-cluster-$i.redis-cluster.redis.svc.cluster.local ping; do
                  echo "Waiting for redis-cluster-$i..."
                  sleep 5
                done
              done

              # Create cluster
              redis-cli --cluster create \
                redis-cluster-0.redis-cluster.redis.svc.cluster.local:6379 \
                redis-cluster-1.redis-cluster.redis.svc.cluster.local:6379 \
                redis-cluster-2.redis-cluster.redis.svc.cluster.local:6379 \
                redis-cluster-3.redis-cluster.redis.svc.cluster.local:6379 \
                redis-cluster-4.redis-cluster.redis.svc.cluster.local:6379 \
                redis-cluster-5.redis-cluster.redis.svc.cluster.local:6379 \
                --cluster-replicas 1 \
                --cluster-yes

              echo "Redis cluster initialized successfully"
      restartPolicy: OnFailure
```

## Redis Sentinel High Availability

**1. Sentinel Deployment**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: redis-sentinel
  namespace: redis
spec:
  clusterIP: None
  ports:
    - port: 26379
      targetPort: 26379
      name: sentinel
  selector:
    app: redis-sentinel
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-sentinel
  namespace: redis
spec:
  serviceName: redis-sentinel
  replicas: 3
  selector:
    matchLabels:
      app: redis-sentinel
  template:
    metadata:
      labels:
        app: redis-sentinel
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - redis-sentinel
              topologyKey: kubernetes.io/hostname

      initContainers:
        - name: config-init
          image: redis:7.2-alpine
          command:
            - sh
            - -c
            - |
              set -e

              # Generate sentinel config
              cp /tmp/sentinel/sentinel.conf /data/sentinel.conf

              # Replace environment variables
              sed -i "s/\${REDIS_PASSWORD}/$REDIS_PASSWORD/g" /data/sentinel.conf

              chmod 644 /data/sentinel.conf
          env:
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: password
          volumeMounts:
            - name: sentinel-config
              mountPath: /tmp/sentinel
            - name: data
              mountPath: /data

      containers:
        - name: sentinel
          image: redis:7.2-alpine
          command:
            - redis-sentinel
          args:
            - /data/sentinel.conf
          ports:
            - containerPort: 26379
              name: sentinel
          volumeMounts:
            - name: data
              mountPath: /data
            - name: scripts
              mountPath: /scripts
          resources:
            requests:
              cpu: "200m"
              memory: 256Mi
            limits:
              cpu: "500m"
              memory: 512Mi
          livenessProbe:
            tcpSocket:
              port: 26379
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            exec:
              command:
                - redis-cli
                - -p
                - "26379"
                - sentinel
                - ping
            initialDelaySeconds: 5
            periodSeconds: 5

      volumes:
        - name: sentinel-config
          configMap:
            name: redis-sentinel-config
            items:
              - key: sentinel.conf
                path: sentinel.conf
        - name: scripts
          configMap:
            name: redis-sentinel-config
            defaultMode: 0755
            items:
              - key: notify.sh
                path: notify.sh
              - key: reconfig.sh
                path: reconfig.sh

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis-master
  namespace: redis
spec:
  clusterIP: None
  ports:
    - port: 6379
      targetPort: 6379
      name: redis
  selector:
    app: redis-master
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-master
  namespace: redis
spec:
  serviceName: redis-master
  replicas: 3
  selector:
    matchLabels:
      app: redis-master
  template:
    metadata:
      labels:
        app: redis-master
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - redis-master
              topologyKey: kubernetes.io/hostname

      containers:
        - name: redis
          image: redis:7.2-alpine
          command:
            - redis-server
          args:
            - /conf/redis.conf
          ports:
            - containerPort: 6379
              name: redis
          volumeMounts:
            - name: conf
              mountPath: /conf
            - name: data
              mountPath: /data
          env:
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: redis-secret
                  key: password
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "2"
              memory: 4Gi

      volumes:
        - name: conf
          configMap:
            name: redis-cluster-config

  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

## Performance Optimization

### Memory Management and Eviction Policies

**1. Advanced Memory Configuration**
```redis
# Memory optimization script
redis-cli CONFIG SET maxmemory 8gb
redis-cli CONFIG SET maxmemory-policy allkeys-lru
redis-cli CONFIG SET maxmemory-samples 10

# Monitor memory usage
redis-cli INFO memory

# Analyze keyspace
redis-cli --bigkeys
redis-cli --memkeys
redis-cli --hotkeys

# Memory fragmentation
redis-cli MEMORY STATS
redis-cli MEMORY DOCTOR
```

**2. Memory Management Script**
```bash
#!/bin/bash
# redis-memory-manager.sh - Monitor and optimize Redis memory

set -e

REDIS_HOST=${1:-"redis-cluster-0"}
REDIS_PORT=${2:-6379}
MEMORY_THRESHOLD=80

get_memory_usage() {
    redis-cli -h $REDIS_HOST -p $REDIS_PORT INFO memory | \
        grep "used_memory_human" | \
        awk -F: '{print $2}' | \
        tr -d '\r'
}

get_memory_percent() {
    redis-cli -h $REDIS_HOST -p $REDIS_PORT INFO memory | \
        grep "used_memory_rss" | \
        head -1 | \
        awk -F: '{print $2}' | \
        tr -d '\r'
}

get_fragmentation_ratio() {
    redis-cli -h $REDIS_HOST -p $REDIS_PORT INFO memory | \
        grep "mem_fragmentation_ratio" | \
        awk -F: '{print $2}' | \
        tr -d '\r'
}

check_evictions() {
    redis-cli -h $REDIS_HOST -p $REDIS_PORT INFO stats | \
        grep "evicted_keys" | \
        awk -F: '{print $2}' | \
        tr -d '\r'
}

analyze_keyspace() {
    echo "Analyzing keyspace distribution..."
    redis-cli -h $REDIS_HOST -p $REDIS_PORT --bigkeys --no-auth-warning
}

optimize_memory() {
    local frag_ratio=$(get_fragmentation_ratio)

    if (( $(echo "$frag_ratio > 1.5" | bc -l) )); then
        echo "High fragmentation detected: $frag_ratio"
        echo "Triggering active defragmentation..."

        redis-cli -h $REDIS_HOST -p $REDIS_PORT CONFIG SET activedefrag yes
        redis-cli -h $REDIS_HOST -p $REDIS_PORT CONFIG SET active-defrag-threshold-lower 10
        redis-cli -h $REDIS_HOST -p $REDIS_PORT CONFIG SET active-defrag-threshold-upper 50
    fi
}

# Main execution
echo "Redis Memory Analysis"
echo "===================="
echo "Host: $REDIS_HOST:$REDIS_PORT"
echo ""
echo "Memory Usage: $(get_memory_usage)"
echo "Fragmentation Ratio: $(get_fragmentation_ratio)"
echo "Evicted Keys: $(check_evictions)"
echo ""

analyze_keyspace
optimize_memory
```

### Connection Pooling and Client Configuration

**1. Connection Pool Best Practices**
```go
// Go Redis client with connection pooling
package main

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

func NewRedisClusterClient() *redis.ClusterClient {
    return redis.NewClusterClient(&redis.ClusterOptions{
        Addrs: []string{
            "redis-cluster-0.redis-cluster.redis.svc.cluster.local:6379",
            "redis-cluster-1.redis-cluster.redis.svc.cluster.local:6379",
            "redis-cluster-2.redis-cluster.redis.svc.cluster.local:6379",
            "redis-cluster-3.redis-cluster.redis.svc.cluster.local:6379",
            "redis-cluster-4.redis-cluster.redis.svc.cluster.local:6379",
            "redis-cluster-5.redis-cluster.redis.svc.cluster.local:6379",
        },

        // Connection pool settings
        PoolSize:     100,              // Maximum connections
        MinIdleConns: 10,                // Minimum idle connections
        MaxIdleConns: 50,                // Maximum idle connections
        PoolTimeout:  10 * time.Second,  // Pool wait timeout
        ConnMaxLifetime: 30 * time.Minute, // Connection max lifetime
        ConnMaxIdleTime: 5 * time.Minute,  // Idle connection timeout

        // Timeouts
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,

        // Retry settings
        MaxRetries:      3,
        MinRetryBackoff: 8 * time.Millisecond,
        MaxRetryBackoff: 512 * time.Millisecond,

        // Route options
        RouteByLatency: true,
        RouteRandomly:  true,

        // Cluster-specific
        ReadOnly:       false,
        MaxRedirects:   3,
    })
}

func main() {
    ctx := context.Background()
    client := NewRedisClusterClient()
    defer client.Close()

    // Test connection
    if err := client.Ping(ctx).Err(); err != nil {
        panic(err)
    }

    // Pipeline example
    pipe := client.Pipeline()
    for i := 0; i < 1000; i++ {
        pipe.Set(ctx, fmt.Sprintf("key:%d", i), i, 0)
    }
    _, err := pipe.Exec(ctx)
    if err != nil {
        panic(err)
    }

    fmt.Println("Successfully connected to Redis cluster")
}
```

## Data Persistence Strategies

### AOF and RDB Configuration

**1. Persistence Management Script**
```bash
#!/bin/bash
# redis-persistence.sh - Manage Redis persistence

set -e

REDIS_HOST=${1:-"redis-cluster-0"}
REDIS_PORT=${2:-6379}

# Backup RDB
backup_rdb() {
    echo "Triggering RDB save..."
    redis-cli -h $REDIS_HOST -p $REDIS_PORT BGSAVE

    # Wait for save to complete
    while true; do
        status=$(redis-cli -h $REDIS_HOST -p $REDIS_PORT LASTSAVE)
        sleep 1
        new_status=$(redis-cli -h $REDIS_HOST -p $REDIS_PORT LASTSAVE)

        if [ "$status" != "$new_status" ]; then
            break
        fi
    done

    # Copy RDB file
    kubectl exec -n redis ${REDIS_HOST} -- \
        sh -c 'cat /data/dump.rdb' > "dump-$(date +%Y%m%d-%H%M%S).rdb"

    echo "RDB backup completed"
}

# Backup AOF
backup_aof() {
    echo "Backing up AOF..."

    kubectl exec -n redis ${REDIS_HOST} -- \
        sh -c 'cat /data/appendonly.aof' > "appendonly-$(date +%Y%m%d-%H%M%S).aof"

    echo "AOF backup completed"
}

# Rewrite AOF
rewrite_aof() {
    echo "Triggering AOF rewrite..."
    redis-cli -h $REDIS_HOST -p $REDIS_PORT BGREWRITEAOF

    echo "AOF rewrite initiated"
}

# Check persistence status
check_status() {
    echo "Persistence Status:"
    echo "==================="

    echo ""
    echo "RDB Info:"
    redis-cli -h $REDIS_HOST -p $REDIS_PORT INFO persistence | \
        grep "rdb_"

    echo ""
    echo "AOF Info:"
    redis-cli -h $REDIS_HOST -p $REDIS_PORT INFO persistence | \
        grep "aof_"
}

# Main menu
case "${1:-status}" in
    backup-rdb)
        backup_rdb
        ;;
    backup-aof)
        backup_aof
        ;;
    rewrite-aof)
        rewrite_aof
        ;;
    status)
        check_status
        ;;
    *)
        echo "Usage: $0 {backup-rdb|backup-aof|rewrite-aof|status} [host] [port]"
        exit 1
        ;;
esac
```

## Monitoring and Alerting

**1. Prometheus ServiceMonitor**
```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: redis-cluster
  namespace: redis
spec:
  selector:
    matchLabels:
      app: redis-cluster
  endpoints:
    - port: metrics
      interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: redis-alerts
  namespace: redis
spec:
  groups:
    - name: redis
      interval: 30s
      rules:
        - alert: RedisDown
          expr: redis_up == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Redis instance is down"
            description: "Redis instance {{ $labels.instance }} is down"

        - alert: RedisHighMemoryUsage
          expr: (redis_memory_used_bytes / redis_memory_max_bytes) > 0.9
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis memory usage is high"
            description: "Redis {{ $labels.instance }} is using {{ $value | humanizePercentage }} of max memory"

        - alert: RedisHighFragmentation
          expr: redis_mem_fragmentation_ratio > 1.5
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Redis memory fragmentation is high"
            description: "Redis {{ $labels.instance }} has fragmentation ratio of {{ $value }}"

        - alert: RedisSlowCommands
          expr: rate(redis_slowlog_length[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Redis slow commands detected"
            description: "Redis {{ $labels.instance }} has {{ $value }} slow commands per second"

        - alert: RedisKeyEvictions
          expr: rate(redis_evicted_keys_total[5m]) > 100
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis is evicting keys"
            description: "Redis {{ $labels.instance }} is evicting {{ $value }} keys per second"

        - alert: RedisReplicationBroken
          expr: redis_connected_slaves == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Redis replication is broken"
            description: "Redis master {{ $labels.instance }} has no connected slaves"

        - alert: RedisReplicationLag
          expr: redis_repl_offset - redis_slave_repl_offset > 10485760
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Redis replication lag is high"
            description: "Redis slave {{ $labels.instance }} is lagging by {{ $value | humanize }}B"
```

## Cluster Management Operations

**1. Cluster Management Script**
```bash
#!/bin/bash
# redis-cluster-manager.sh - Comprehensive cluster management

set -e

NAMESPACE="redis"
CLUSTER_NAME="redis-cluster"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Get cluster info
cluster_info() {
    log "Retrieving cluster information..."

    for i in {0..5}; do
        echo ""
        echo "=== Node: ${CLUSTER_NAME}-$i ==="
        kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-$i -- \
            redis-cli CLUSTER NODES
    done
}

# Add node to cluster
add_node() {
    local new_node=$1
    local existing_node=${2:-"${CLUSTER_NAME}-0"}

    log "Adding node $new_node to cluster..."

    kubectl exec -n $NAMESPACE $existing_node -- \
        redis-cli --cluster add-node \
        ${new_node}.${CLUSTER_NAME}.${NAMESPACE}.svc.cluster.local:6379 \
        ${existing_node}.${CLUSTER_NAME}.${NAMESPACE}.svc.cluster.local:6379

    log "Node added successfully"
}

# Remove node from cluster
remove_node() {
    local node_id=$1

    log "Removing node $node_id from cluster..."

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- \
        redis-cli --cluster del-node \
        ${CLUSTER_NAME}-0.${CLUSTER_NAME}.${NAMESPACE}.svc.cluster.local:6379 \
        $node_id

    log "Node removed successfully"
}

# Rebalance cluster
rebalance() {
    log "Rebalancing cluster..."

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- \
        redis-cli --cluster rebalance \
        ${CLUSTER_NAME}-0.${CLUSTER_NAME}.${NAMESPACE}.svc.cluster.local:6379 \
        --cluster-use-empty-masters

    log "Cluster rebalanced"
}

# Check cluster health
health_check() {
    log "Performing health check..."

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- \
        redis-cli --cluster check \
        ${CLUSTER_NAME}-0.${CLUSTER_NAME}.${NAMESPACE}.svc.cluster.local:6379

    log "Health check completed"
}

# Reshard cluster
reshard() {
    local slots=$1
    local source_node=$2
    local target_node=$3

    log "Resharding $slots slots from $source_node to $target_node..."

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- \
        redis-cli --cluster reshard \
        ${CLUSTER_NAME}-0.${CLUSTER_NAME}.${NAMESPACE}.svc.cluster.local:6379 \
        --cluster-from $source_node \
        --cluster-to $target_node \
        --cluster-slots $slots \
        --cluster-yes

    log "Resharding completed"
}

# Failover test
test_failover() {
    local node=${1:-"${CLUSTER_NAME}-0"}

    log "Testing failover for node: $node..."

    # Trigger manual failover
    kubectl exec -n $NAMESPACE $node -- \
        redis-cli CLUSTER FAILOVER

    sleep 5

    # Check cluster status
    health_check

    log "Failover test completed"
}

# Main menu
show_menu() {
    cat <<EOF

Redis Cluster Manager
=====================
1. Cluster Info
2. Add Node
3. Remove Node
4. Rebalance Cluster
5. Health Check
6. Reshard
7. Test Failover
8. Exit

EOF
}

main() {
    while true; do
        show_menu
        read -p "Select option: " choice

        case $choice in
            1)
                cluster_info
                ;;
            2)
                read -p "Enter new node name: " node
                add_node "$node"
                ;;
            3)
                read -p "Enter node ID to remove: " node_id
                remove_node "$node_id"
                ;;
            4)
                rebalance
                ;;
            5)
                health_check
                ;;
            6)
                read -p "Enter slots to move: " slots
                read -p "Enter source node ID: " source
                read -p "Enter target node ID: " target
                reshard "$slots" "$source" "$target"
                ;;
            7)
                read -p "Enter node name (default: ${CLUSTER_NAME}-0): " node
                test_failover "${node:-${CLUSTER_NAME}-0}"
                ;;
            8)
                log "Exiting..."
                exit 0
                ;;
            *)
                echo "Invalid option"
                ;;
        esac

        read -p "Press Enter to continue..."
    done
}

# Handle command line arguments
case "${1:-menu}" in
    info)
        cluster_info
        ;;
    add)
        add_node "$2" "$3"
        ;;
    remove)
        remove_node "$2"
        ;;
    rebalance)
        rebalance
        ;;
    health)
        health_check
        ;;
    reshard)
        reshard "$2" "$3" "$4"
        ;;
    failover)
        test_failover "$2"
        ;;
    menu)
        main
        ;;
    *)
        echo "Usage: $0 {info|add|remove|rebalance|health|reshard|failover|menu}"
        exit 1
        ;;
esac
```

## Conclusion

Effective Redis cluster management on Kubernetes requires:

1. **Architecture Selection**: Choose between Cluster mode and Sentinel based on requirements
2. **High Availability**: Implement proper replication and failover mechanisms
3. **Performance Tuning**: Optimize memory management and connection pooling
4. **Persistence Strategy**: Configure appropriate AOF and RDB settings
5. **Monitoring**: Deploy comprehensive metrics and alerting
6. **Automation**: Use operators for simplified management
7. **Operational Readiness**: Implement cluster management scripts and procedures

These patterns provide production-ready Redis deployment strategies on Kubernetes with comprehensive HA, monitoring, and management capabilities.