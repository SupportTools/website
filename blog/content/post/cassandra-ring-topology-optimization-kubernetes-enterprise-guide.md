---
title: "Cassandra Ring Topology Optimization on Kubernetes: Enterprise Production Guide"
date: 2026-05-08T00:00:00-05:00
draft: false
tags: ["Cassandra", "Kubernetes", "NoSQL", "Database", "Distributed Systems", "Performance"]
categories: ["Database", "Kubernetes", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to optimizing Apache Cassandra ring topology on Kubernetes, covering rack awareness, token allocation, replication strategies, and performance tuning for enterprise workloads."
more_link: "yes"
url: "/cassandra-ring-topology-optimization-kubernetes-enterprise-guide/"
---

Apache Cassandra's ring topology and distributed architecture require careful configuration for optimal performance on Kubernetes. This comprehensive guide covers enterprise-grade Cassandra deployments with focus on ring topology optimization, rack awareness, replication strategies, and performance tuning.

We'll explore StatefulSet configurations, K8ssandra operator deployment, multi-datacenter replication, and advanced tuning strategies for high-throughput, low-latency Cassandra clusters on Kubernetes.

<!--more-->

# Cassandra Ring Topology Optimization on Kubernetes

## Understanding Cassandra Ring Architecture

### Ring Topology Fundamentals

**1. Token Ring Configuration**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cassandra-config
  namespace: cassandra
data:
  cassandra.yaml: |
    # Cluster configuration
    cluster_name: 'Production Cluster'
    num_tokens: 256
    allocate_tokens_for_local_replication_factor: 3

    # Partitioner
    partitioner: org.apache.cassandra.dht.Murmur3Partitioner

    # Snitch for topology awareness
    endpoint_snitch: GossipingPropertyFileSnitch

    # Seed provider
    seed_provider:
      - class_name: org.apache.cassandra.locator.SimpleSeedProvider
        parameters:
          - seeds: "cassandra-0.cassandra.cassandra.svc.cluster.local,cassandra-1.cassandra.cassandra.svc.cluster.local"

    # Data directories
    data_file_directories:
      - /var/lib/cassandra/data
    commitlog_directory: /var/lib/cassandra/commitlog
    saved_caches_directory: /var/lib/cassandra/saved_caches
    hints_directory: /var/lib/cassandra/hints

    # Performance tuning
    concurrent_reads: 32
    concurrent_writes: 32
    concurrent_counter_writes: 32
    concurrent_materialized_view_writes: 32

    # Memory settings
    memtable_allocation_type: heap_buffers
    memtable_cleanup_threshold: 0.5
    memtable_flush_writers: 4

    # Compaction
    compaction_throughput_mb_per_sec: 64
    concurrent_compactors: 4

    # Read/Write paths
    trickle_fsync: true
    trickle_fsync_interval_in_kb: 10240

    # Timeouts
    read_request_timeout_in_ms: 10000
    range_request_timeout_in_ms: 20000
    write_request_timeout_in_ms: 10000
    counter_write_request_timeout_in_ms: 10000
    cas_contention_timeout_in_ms: 5000
    truncate_request_timeout_in_ms: 60000
    request_timeout_in_ms: 20000

    # Inter-node communication
    internode_compression: dc
    inter_dc_tcp_nodelay: true

    # Native transport
    start_native_transport: true
    native_transport_port: 9042
    native_transport_max_threads: 128
    native_transport_max_frame_size_in_mb: 256

    # RPC
    start_rpc: false

    # Incremental backups
    incremental_backups: true
    snapshot_before_compaction: false
    auto_snapshot: true

    # GC settings
    gc_warn_threshold_in_ms: 1000

  cassandra-rackdc.properties: |
    dc=datacenter1
    rack=rack1
    prefer_local=true

  jvm.options: |
    # Heap size (adjust based on available memory)
    -Xms8G
    -Xmx8G

    # Young generation
    -Xmn2G

    # GC settings (G1GC recommended for Cassandra 4.0+)
    -XX:+UseG1GC
    -XX:G1RSetUpdatingPauseTimePercent=5
    -XX:MaxGCPauseMillis=500
    -XX:InitiatingHeapOccupancyPercent=70

    # GC logging
    -Xlog:gc*,gc+age=trace,safepoint:file=/var/log/cassandra/gc.log:time,uptime:filecount=10,filesize=10m

    # Crash dumps
    -XX:+HeapDumpOnOutOfMemoryError
    -XX:HeapDumpPath=/var/lib/cassandra/dumps

    # Performance tuning
    -XX:+AlwaysPreTouch
    -XX:+UseTLAB
    -XX:+ResizeTLAB
    -XX:+PerfDisableSharedMem

    # JMX
    -Dcom.sun.management.jmxremote.port=7199
    -Dcom.sun.management.jmxremote.rmi.port=7199
    -Dcom.sun.management.jmxremote.ssl=false
    -Dcom.sun.management.jmxremote.authenticate=false
```

## K8ssandra Operator Deployment

### Complete K8ssandra Stack

**1. Install K8ssandra Operator**
```bash
# Add K8ssandra helm repository
helm repo add k8ssandra https://helm.k8ssandra.io/stable
helm repo update

# Install K8ssandra operator
helm install k8ssandra-operator k8ssandra/k8ssandra-operator \
  --namespace k8ssandra-operator \
  --create-namespace

# Install Cert-Manager (required)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml
```

**2. K8ssandraCluster Resource**
```yaml
apiVersion: k8ssandra.io/v1alpha1
kind: K8ssandraCluster
metadata:
  name: production-cassandra
  namespace: cassandra
spec:
  cassandra:
    clusterName: "production-cluster"
    serverVersion: "4.1.3"
    serverImage: "k8ssandra/cass-management-api"

    datacenters:
      - metadata:
          name: dc1
        size: 6
        storageConfig:
          cassandraDataVolumeClaimSpec:
            storageClassName: fast-ssd
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 500Gi

        config:
          jvmOptions:
            heapSize: 8Gi
            heapNewGenSize: 2Gi
            additionalOptions:
              - "-XX:+UseG1GC"
              - "-XX:G1RSetUpdatingPauseTimePercent=5"
              - "-XX:MaxGCPauseMillis=500"
              - "-XX:InitiatingHeapOccupancyPercent=70"
              - "-XX:+AlwaysPreTouch"

          cassandraYaml:
            num_tokens: 256
            allocate_tokens_for_local_replication_factor: 3
            concurrent_reads: 32
            concurrent_writes: 32
            memtable_allocation_type: "heap_buffers"
            memtable_cleanup_threshold: 0.5
            compaction_throughput_mb_per_sec: 64
            concurrent_compactors: 4
            stream_throughput_outbound_megabits_per_sec: 400
            inter_dc_stream_throughput_outbound_megabits_per_sec: 200

        racks:
          - name: rack1
            affinityLabels:
              topology.kubernetes.io/zone: us-east-1a
          - name: rack2
            affinityLabels:
              topology.kubernetes.io/zone: us-east-1b
          - name: rack3
            affinityLabels:
              topology.kubernetes.io/zone: us-east-1c

        resources:
          requests:
            cpu: "4"
            memory: 16Gi
          limits:
            cpu: "8"
            memory: 32Gi

        tolerations:
          - key: "cassandra-workload"
            operator: "Equal"
            value: "true"
            effect: "NoSchedule"

    mgmtAPIHeap: 256Mi

  stargate:
    size: 3
    heapSize: 1Gi
    resources:
      requests:
        cpu: "1"
        memory: 2Gi
      limits:
        cpu: "2"
        memory: 4Gi

  reaper:
    autoScheduling:
      enabled: true
    keyspace: reaper_db
    heapSize: 512Mi

  medusa:
    storageProperties:
      storageProvider: s3
      bucketName: cassandra-backups
      prefix: production-cluster
      storageSecretRef:
        name: medusa-s3-credentials

    cassandraUserSecretRef:
      name: cassandra-admin-secret

## Rack Awareness and Token Allocation

### Implementing Rack Awareness

**1. Rack-Aware StatefulSet**
```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: cassandra
  namespace: cassandra
spec:
  serviceName: cassandra
  replicas: 6
  podManagementPolicy: Parallel
  selector:
    matchLabels:
      app: cassandra
  template:
    metadata:
      labels:
        app: cassandra
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9500"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values:
                      - cassandra
              topologyKey: kubernetes.io/hostname
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: node-role.kubernetes.io/cassandra
                    operator: In
                    values:
                      - "true"

      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: cassandra

      initContainers:
        - name: configure-rack
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              set -e
              RACK=$(kubectl get node $NODE_NAME -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}' | sed 's/.*-/rack/')
              echo "dc=dc1" > /config/cassandra-rackdc.properties
              echo "rack=$RACK" >> /config/cassandra-rackdc.properties
              echo "prefer_local=true" >> /config/cassandra-rackdc.properties
              cat /config/cassandra-rackdc.properties
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: config
              mountPath: /config

      containers:
        - name: cassandra
          image: cassandra:4.1.3
          ports:
            - containerPort: 7000
              name: intra-node
            - containerPort: 7001
              name: tls-intra-node
            - containerPort: 7199
              name: jmx
            - containerPort: 9042
              name: cql
            - containerPort: 9160
              name: thrift
          env:
            - name: CASSANDRA_SEEDS
              value: "cassandra-0.cassandra.cassandra.svc.cluster.local,cassandra-1.cassandra.cassandra.svc.cluster.local"
            - name: MAX_HEAP_SIZE
              value: "8G"
            - name: HEAP_NEWSIZE
              value: "2G"
            - name: CASSANDRA_CLUSTER_NAME
              value: "Production Cluster"
            - name: CASSANDRA_DC
              value: "dc1"
            - name: CASSANDRA_ENDPOINT_SNITCH
              value: "GossipingPropertyFileSnitch"
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
          volumeMounts:
            - name: cassandra-data
              mountPath: /var/lib/cassandra
            - name: config
              mountPath: /etc/cassandra
          resources:
            requests:
              cpu: "4"
              memory: 16Gi
            limits:
              cpu: "8"
              memory: 32Gi
          livenessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - nodetool status | grep -E "^UN\\s+${POD_IP}"
            initialDelaySeconds: 90
            periodSeconds: 30
          readinessProbe:
            exec:
              command:
                - /bin/sh
                - -c
                - nodetool status | grep -E "^UN\\s+${POD_IP}"
            initialDelaySeconds: 60
            periodSeconds: 10

        - name: metrics-exporter
          image: criteord/cassandra_exporter:latest
          ports:
            - containerPort: 9500
              name: metrics
          env:
            - name: CASSANDRA_EXPORTER_CONFIG_host
              value: "localhost:7199"
          resources:
            requests:
              cpu: "100m"
              memory: 128Mi
            limits:
              cpu: "200m"
              memory: 256Mi

      volumes:
        - name: config
          emptyDir: {}

  volumeClaimTemplates:
    - metadata:
        name: cassandra-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 500Gi
```

**2. Token Allocation Script**
```bash
#!/bin/bash
# token-allocation.sh - Optimize token distribution

set -e

NAMESPACE="cassandra"
CLUSTER_NAME="cassandra"
NUM_NODES=6
TOKENS_PER_NODE=256

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Get current token distribution
get_token_distribution() {
    log "Current token distribution:"

    for i in $(seq 0 $((NUM_NODES-1))); do
        echo ""
        echo "=== Node: ${CLUSTER_NAME}-$i ==="
        kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-$i -- nodetool ring | head -20
    done
}

# Calculate optimal tokens
calculate_optimal_tokens() {
    log "Calculating optimal token distribution..."

    python3 <<EOF
import sys

num_nodes = $NUM_NODES
tokens_per_node = $TOKENS_PER_NODE
total_tokens = 2**64

token_range = total_tokens // (num_nodes * tokens_per_node)

for node in range(num_nodes):
    print(f"\nNode {node} tokens:")
    for token_idx in range(tokens_per_node):
        token = (node * tokens_per_node + token_idx) * token_range
        print(f"  {token}")
EOF
}

# Rebalance cluster
rebalance_cluster() {
    log "Rebalancing cluster..."

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- \
        nodetool rebuild

    log "Rebalance initiated"
}

# Verify token ownership
verify_ownership() {
    log "Verifying token ownership..."

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- \
        nodetool describering | grep "Token Ranges:"

    log "Verification complete"
}

# Main execution
main() {
    log "Token Allocation Manager"
    log "======================"

    get_token_distribution
    calculate_optimal_tokens
    verify_ownership

    read -p "Proceed with rebalance? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rebalance_cluster
    fi
}

main "$@"
```

## Replication Strategies

### Multi-Datacenter Replication

**1. Replication Strategy Configuration**
```cql
-- Create keyspace with NetworkTopologyStrategy
CREATE KEYSPACE production_data
WITH replication = {
    'class': 'NetworkTopologyStrategy',
    'dc1': 3,
    'dc2': 3
}
AND durable_writes = true;

-- Create table with optimal settings
CREATE TABLE production_data.user_events (
    user_id UUID,
    event_time TIMESTAMP,
    event_type TEXT,
    event_data MAP<TEXT, TEXT>,
    PRIMARY KEY ((user_id), event_time)
)
WITH CLUSTERING ORDER BY (event_time DESC)
AND compaction = {
    'class': 'LeveledCompactionStrategy',
    'sstable_size_in_mb': 160
}
AND compression = {
    'class': 'LZ4Compressor',
    'chunk_length_in_kb': 64
}
AND gc_grace_seconds = 864000
AND bloom_filter_fp_chance = 0.01
AND caching = {
    'keys': 'ALL',
    'rows_per_partition': 'ALL'
}
AND comment = 'User events table with optimal settings';

-- Create materialized view
CREATE MATERIALIZED VIEW production_data.events_by_type AS
SELECT *
FROM production_data.user_events
WHERE event_type IS NOT NULL
  AND user_id IS NOT NULL
  AND event_time IS NOT NULL
PRIMARY KEY (event_type, event_time, user_id)
WITH CLUSTERING ORDER BY (event_time DESC, user_id ASC);

-- Create secondary index
CREATE INDEX ON production_data.user_events (event_type);
```

**2. Consistency Level Management**
```go
// Go client with consistency level configuration
package main

import (
    "fmt"
    "time"

    "github.com/gocql/gocql"
)

func NewCassandraSession() (*gocql.Session, error) {
    cluster := gocql.NewCluster(
        "cassandra-0.cassandra.cassandra.svc.cluster.local",
        "cassandra-1.cassandra.cassandra.svc.cluster.local",
        "cassandra-2.cassandra.cassandra.svc.cluster.local",
    )

    // Cluster configuration
    cluster.Keyspace = "production_data"
    cluster.Consistency = gocql.Quorum
    cluster.ProtoVersion = 4
    cluster.ConnectTimeout = 10 * time.Second
    cluster.Timeout = 5 * time.Second

    // Connection pool
    cluster.NumConns = 2
    cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(
        gocql.RoundRobinHostPolicy(),
    )

    // Retry policy
    cluster.RetryPolicy = &gocql.ExponentialBackoffRetryPolicy{
        NumRetries: 3,
        Min:        100 * time.Millisecond,
        Max:        1 * time.Second,
    }

    // Reconnection policy
    cluster.ReconnectInterval = 10 * time.Second

    // Create session
    session, err := cluster.CreateSession()
    if err != nil {
        return nil, fmt.Errorf("failed to create session: %w", err)
    }

    return session, nil
}

func WriteWithConsistency(session *gocql.Session, userID gocql.UUID, eventType string, eventData map[string]string) error {
    query := session.Query(`
        INSERT INTO user_events (user_id, event_time, event_type, event_data)
        VALUES (?, ?, ?, ?)
    `, userID, time.Now(), eventType, eventData)

    // Set consistency level for this query
    query.Consistency(gocql.LocalQuorum)
    query.SerialConsistency(gocql.LocalSerial)

    if err := query.Exec(); err != nil {
        return fmt.Errorf("failed to insert: %w", err)
    }

    return nil
}

func main() {
    session, err := NewCassandraSession()
    if err != nil {
        panic(err)
    }
    defer session.Close()

    fmt.Println("Connected to Cassandra cluster")
}
```

## Performance Tuning

### Compaction Strategies

**1. Compaction Tuning Script**
```bash
#!/bin/bash
# compaction-tuner.sh - Optimize compaction strategies

set -e

NAMESPACE="cassandra"
POD_NAME="cassandra-0"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Get compaction stats
get_compaction_stats() {
    log "Current compaction statistics:"

    kubectl exec -n $NAMESPACE $POD_NAME -- nodetool compactionstats
}

# Set compaction throughput
set_compaction_throughput() {
    local throughput=${1:-64}

    log "Setting compaction throughput to ${throughput}MB/s"

    kubectl exec -n $NAMESPACE $POD_NAME -- \
        nodetool setcompactionthroughput $throughput

    log "Compaction throughput updated"
}

# Trigger major compaction
trigger_major_compaction() {
    local keyspace=${1:-"production_data"}
    local table=${2:-""}

    log "Triggering major compaction for keyspace: $keyspace"

    if [ -n "$table" ]; then
        kubectl exec -n $NAMESPACE $POD_NAME -- \
            nodetool compact $keyspace $table
    else
        kubectl exec -n $NAMESPACE $POD_NAME -- \
            nodetool compact $keyspace
    fi

    log "Major compaction initiated"
}

# Get sstable count
get_sstable_count() {
    local keyspace=${1:-"production_data"}

    log "SSTable count for keyspace: $keyspace"

    kubectl exec -n $NAMESPACE $POD_NAME -- \
        nodetool tablestats $keyspace
}

# Optimize table compaction strategy
optimize_compaction_strategy() {
    log "Optimizing compaction strategies..."

    kubectl exec -n $NAMESPACE $POD_NAME -- cqlsh -e "
        -- For time-series data: TimeWindowCompactionStrategy
        ALTER TABLE production_data.user_events
        WITH compaction = {
            'class': 'TimeWindowCompactionStrategy',
            'compaction_window_unit': 'DAYS',
            'compaction_window_size': 1
        };

        -- For frequently updated data: LeveledCompactionStrategy
        ALTER TABLE production_data.user_profiles
        WITH compaction = {
            'class': 'LeveledCompactionStrategy',
            'sstable_size_in_mb': 160
        };

        -- For write-heavy workloads: SizeTieredCompactionStrategy
        ALTER TABLE production_data.event_logs
        WITH compaction = {
            'class': 'SizeTieredCompactionStrategy',
            'min_threshold': 4,
            'max_threshold': 32
        };
    "

    log "Compaction strategies optimized"
}

# Main execution
case "${1:-stats}" in
    stats)
        get_compaction_stats
        ;;
    throughput)
        set_compaction_throughput "$2"
        ;;
    major)
        trigger_major_compaction "$2" "$3"
        ;;
    sstables)
        get_sstable_count "$2"
        ;;
    optimize)
        optimize_compaction_strategy
        ;;
    *)
        echo "Usage: $0 {stats|throughput|major|sstables|optimize}"
        exit 1
        ;;
esac
```

### Read/Write Path Optimization

**1. Performance Tuning Configuration**
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cassandra-performance-tuning
  namespace: cassandra
data:
  tune-performance.sh: |
    #!/bin/bash
    # Performance tuning script

    set -e

    # Concurrent operations
    nodetool setconcurrentcompactors 4
    nodetool setconcurrentviewbuilders 4

    # Streaming throughput
    nodetool setstreamthroughput 400
    nodetool setinterdcstreamthroughput 200

    # Cache sizes
    nodetool setcachecapacity key-cache 100 100
    nodetool setcachecapacity row-cache 0 0
    nodetool setcachecapacity counter-cache 50 50

    # Trace probability (for debugging)
    nodetool settraceprobability 0

    # Compaction throughput
    nodetool setcompactionthroughput 64

    # Batch size warning
    nodetool setbatchlogreplaythrottle 1024

    echo "Performance tuning completed"
```

## Monitoring and Alerting

**1. Prometheus Alerts**
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cassandra-alerts
  namespace: cassandra
spec:
  groups:
    - name: cassandra
      interval: 30s
      rules:
        - alert: CassandraDown
          expr: up{job="cassandra"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Cassandra node is down"
            description: "Cassandra node {{ $labels.instance }} has been down for more than 1 minute"

        - alert: CassandraHighLatency
          expr: cassandra_table_write_latency_seconds{quantile="0.99"} > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cassandra write latency is high"
            description: "P99 write latency is {{ $value }}s on {{ $labels.instance }}"

        - alert: CassandraHighDiskUsage
          expr: (cassandra_table_live_disk_space_used_bytes / (cassandra_table_live_disk_space_used_bytes + cassandra_table_disk_space_free_bytes)) > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Cassandra disk usage is high"
            description: "Disk usage is {{ $value | humanizePercentage }} on {{ $labels.instance }}"

        - alert: CassandraPendingCompactions
          expr: cassandra_table_pending_compactions > 100
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "High number of pending compactions"
            description: "{{ $value }} pending compactions on {{ $labels.instance }}"

        - alert: CassandraHintsStorageHigh
          expr: cassandra_hints_total_hints > 100000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High number of hints"
            description: "{{ $value }} hints on {{ $labels.instance }}"

        - alert: CassandraReadRepairErrors
          expr: rate(cassandra_read_repair_background_tasks_errors_total[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Read repair errors detected"
            description: "{{ $value }} read repair errors per second on {{ $labels.instance }}"
```

## Backup and Recovery

**1. Medusa Backup Configuration**
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cassandra-backup
  namespace: cassandra
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: cassandra-backup
          containers:
            - name: medusa
              image: k8ssandra/medusa:latest
              command:
                - /bin/bash
                - -c
                - |
                  set -e

                  echo "Starting Cassandra backup..."

                  # Create backup
                  medusa backup \
                    --backup-name="backup-$(date +%Y%m%d-%H%M%S)" \
                    --mode=full

                  echo "Backup completed successfully"

                  # List backups
                  medusa list-backups

                  # Cleanup old backups (keep last 30 days)
                  medusa purge \
                    --backup-date=$(date -d '30 days ago' +%Y-%m-%d)
              env:
                - name: MEDUSA_MODE
                  value: "standalone"
                - name: MEDUSA_STORAGE_PROVIDER
                  value: "s3"
                - name: MEDUSA_BUCKET_NAME
                  value: "cassandra-backups"
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: medusa-s3-credentials
                      key: access_key_id
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: medusa-s3-credentials
                      key: secret_access_key
              volumeMounts:
                - name: cassandra-data
                  mountPath: /var/lib/cassandra
              resources:
                requests:
                  cpu: "500m"
                  memory: 1Gi
                limits:
                  cpu: "1"
                  memory: 2Gi
          volumes:
            - name: cassandra-data
              persistentVolumeClaim:
                claimName: cassandra-data-cassandra-0
          restartPolicy: OnFailure
```

## Cluster Operations

**1. Cluster Management Script**
```bash
#!/bin/bash
# cassandra-cluster-manager.sh - Comprehensive cluster management

set -e

NAMESPACE="cassandra"
CLUSTER_NAME="cassandra"

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

# Cluster status
cluster_status() {
    log "Cluster Status:"

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- nodetool status
}

# Node info
node_info() {
    local node=${1:-"${CLUSTER_NAME}-0"}

    log "Node Info: $node"

    kubectl exec -n $NAMESPACE $node -- nodetool info
}

# Ring information
ring_info() {
    log "Ring Information:"

    kubectl exec -n $NAMESPACE ${CLUSTER_NAME}-0 -- nodetool ring
}

# Repair node
repair_node() {
    local node=${1:-"${CLUSTER_NAME}-0"}
    local keyspace=${2:-"production_data"}

    log "Repairing node: $node (keyspace: $keyspace)"

    kubectl exec -n $NAMESPACE $node -- \
        nodetool repair -pr $keyspace

    log "Repair completed"
}

# Decommission node
decommission_node() {
    local node=$1

    if [ -z "$node" ]; then
        echo "Node name required"
        return 1
    fi

    log "Decommissioning node: $node"

    kubectl exec -n $NAMESPACE $node -- nodetool decommission

    log "Node decommissioned"
}

# Bootstrap new node
bootstrap_node() {
    log "Bootstrapping new node..."

    # Scale up StatefulSet
    kubectl scale statefulset -n $NAMESPACE $CLUSTER_NAME \
        --replicas=$(($(kubectl get statefulset -n $NAMESPACE $CLUSTER_NAME -o jsonpath='{.spec.replicas}') + 1))

    log "New node bootstrap initiated"
}

# Cleanup node
cleanup_node() {
    local node=${1:-"${CLUSTER_NAME}-0"}

    log "Cleaning up node: $node"

    kubectl exec -n $NAMESPACE $node -- nodetool cleanup

    log "Cleanup completed"
}

# Main menu
show_menu() {
    cat <<EOF

Cassandra Cluster Manager
==========================
1. Cluster Status
2. Node Info
3. Ring Information
4. Repair Node
5. Decommission Node
6. Bootstrap New Node
7. Cleanup Node
8. Exit

EOF
}

main() {
    while true; do
        show_menu
        read -p "Select option: " choice

        case $choice in
            1)
                cluster_status
                ;;
            2)
                read -p "Enter node name (default: ${CLUSTER_NAME}-0): " node
                node_info "${node:-${CLUSTER_NAME}-0}"
                ;;
            3)
                ring_info
                ;;
            4)
                read -p "Enter node name: " node
                read -p "Enter keyspace (default: production_data): " keyspace
                repair_node "$node" "${keyspace:-production_data}"
                ;;
            5)
                read -p "Enter node name to decommission: " node
                decommission_node "$node"
                ;;
            6)
                bootstrap_node
                ;;
            7)
                read -p "Enter node name: " node
                cleanup_node "$node"
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
    status)
        cluster_status
        ;;
    info)
        node_info "$2"
        ;;
    ring)
        ring_info
        ;;
    repair)
        repair_node "$2" "$3"
        ;;
    decommission)
        decommission_node "$2"
        ;;
    bootstrap)
        bootstrap_node
        ;;
    cleanup)
        cleanup_node "$2"
        ;;
    menu)
        main
        ;;
    *)
        echo "Usage: $0 {status|info|ring|repair|decommission|bootstrap|cleanup|menu}"
        exit 1
        ;;
esac
```

## Conclusion

Optimizing Cassandra ring topology on Kubernetes requires:

1. **Proper Token Allocation**: Distribute tokens evenly across nodes
2. **Rack Awareness**: Configure racks to match availability zones
3. **Replication Strategy**: Use NetworkTopologyStrategy for multi-DC
4. **Compaction Tuning**: Choose appropriate compaction strategy
5. **Performance Optimization**: Tune JVM, concurrent operations, and caching
6. **Monitoring**: Deploy comprehensive metrics and alerting
7. **Operational Procedures**: Implement cluster management automation

These configurations provide enterprise-grade Cassandra deployments on Kubernetes with optimal ring topology, high performance, and operational excellence.