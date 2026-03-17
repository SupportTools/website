---
title: "Apache Kafka on Kubernetes: Strimzi Operator Production Operations"
date: 2028-01-28T00:00:00-05:00
draft: false
tags: ["Kafka", "Strimzi", "Kubernetes", "Messaging", "Streaming", "Operators", "Production"]
categories: ["Kubernetes", "Data Engineering", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production operations guide for Apache Kafka on Kubernetes using the Strimzi operator, covering KafkaCluster CRD, topic and user operators, MirrorMaker2 replication, Cruise Control partition rebalancing, JVM tuning, and rolling upgrades."
more_link: "yes"
url: "/kafka-kubernetes-operations-guide/"
---

Running Apache Kafka on Kubernetes introduces operational challenges that go beyond simply containerizing the broker: storage class selection for consistent I/O performance, anti-affinity rules to prevent co-located replicas, rack awareness for zone-balanced partition placement, JVM tuning for GC pause minimization, and the continuous rebalancing required as the cluster scales. The Strimzi operator encodes this operational knowledge into Kubernetes-native custom resources, providing declarative management of the full Kafka ecosystem including brokers, topics, users, MirrorMaker2, and Cruise Control.

<!--more-->

# Apache Kafka on Kubernetes: Strimzi Operator Production Operations

## Strimzi Architecture Overview

Strimzi consists of several controllers that manage different aspects of the Kafka ecosystem:

- **Cluster Operator** — manages Kafka clusters, ZooKeeper (or KRaft), Kafka Connect, Kafka MirrorMaker2, and Kafka Bridge
- **Topic Operator** — syncs KafkaTopic resources with actual Kafka topics
- **User Operator** — manages KafkaUser resources and creates ACLs and credentials
- **Entity Operator** — runs Topic and User operators within the same pod

The Cluster Operator reconciles the `Kafka` custom resource and manages the StatefulSets, Services, ConfigMaps, and Secrets that make up the cluster.

## Installing the Strimzi Operator

```bash
# Install Strimzi operator using the official Helm chart
helm repo add strimzi https://strimzi.io/charts/
helm repo update

# Install with cluster-wide operator scope (can manage Kafka in any namespace)
helm install strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace kafka-system \
  --create-namespace \
  --set watchAnyNamespace=true \
  --set logLevel=INFO \
  --set defaultImageRegistryOverride="" \
  --version 0.40.0

# Verify the operator is running
kubectl get pods -n kafka-system
kubectl get crds | grep strimzi
```

## KafkaCluster CRD: Production Configuration

```yaml
# kafka/kafka-cluster-production.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: kafka-production
  namespace: kafka
spec:
  kafka:
    version: 3.7.0
    replicas: 3
    # Storage: use persistent storage with a fast SSD storage class
    storage:
      type: jbod  # Just a Bunch of Disks — attach multiple volumes per broker
      volumes:
        - id: 0
          type: persistent-claim
          size: 500Gi
          # Use a storage class backed by NVMe SSDs for Kafka workloads
          class: premium-ssd
          # Delete PVCs when the Kafka cluster is deleted
          deleteClaim: false
    # Listeners define how clients connect to Kafka
    listeners:
      # Plain listener inside the cluster (no TLS, for internal clients)
      - name: plain
        port: 9092
        type: internal
        tls: false
      # TLS listener inside the cluster
      - name: tls
        port: 9093
        type: internal
        tls: true
        authentication:
          type: tls  # mTLS client certificates
      # External listener via LoadBalancer (for cross-cluster replication)
      - name: external
        port: 9094
        type: loadbalancer
        tls: true
        authentication:
          type: scram-sha-512
        configuration:
          # Assign a dedicated LoadBalancer per broker for consistent routing
          brokerCertChainAndKey:
            secretName: kafka-external-cert
            certificate: tls.crt
            key: tls.key
    # Broker configuration
    config:
      # Replication defaults
      default.replication.factor: 3
      min.insync.replicas: 2
      # Log configuration
      log.retention.hours: 168          # 7 days
      log.retention.bytes: 107374182400 # 100GB per partition
      log.segment.bytes: 1073741824     # 1GB segments
      log.cleanup.policy: delete
      # Compression
      compression.type: producer        # Honor producer-specified compression
      # Network tuning
      num.network.threads: 8
      num.io.threads: 16
      socket.send.buffer.bytes: 102400
      socket.receive.buffer.bytes: 102400
      socket.request.max.bytes: 104857600
      # Quotas (prevent runaway producers from starving others)
      quota.consumer.default: 104857600  # 100MB/s per consumer
      quota.producer.default: 104857600  # 100MB/s per producer
      # Auto topic creation (disable in production — use Topic Operator)
      auto.create.topics.enable: "false"
      # Leader election
      auto.leader.rebalance.enable: "true"
      leader.imbalance.check.interval.seconds: 300
      leader.imbalance.per.broker.percentage: 10
    # JVM settings for the Kafka broker
    jvmOptions:
      # Heap sizing: a common guideline is 6GB for brokers handling normal loads
      # Avoid setting heap above 6-8GB due to GC pause time increases
      -Xms: 6144m
      -Xmx: 6144m
      # GC settings: G1GC is recommended for Kafka 3.x
      javaSystemProperties:
        - name: jdk.tls.ephemeralDHKeySize
          value: "2048"
      # Additional GC tuning via gcLoggingEnabled
      gcLoggingEnabled: true
    resources:
      requests:
        cpu: 2000m
        memory: 8Gi
      limits:
        cpu: 4000m
        memory: 10Gi
    # Rack awareness maps Kubernetes node zones to Kafka racks
    # Ensures partition replicas are distributed across availability zones
    rack:
      topologyKey: topology.kubernetes.io/zone
    # Pod template customization
    template:
      pod:
        # Anti-affinity: prevent multiple brokers on the same node
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchExpressions:
                    - key: strimzi.io/name
                      operator: In
                      values:
                        - kafka-production-kafka
                topologyKey: kubernetes.io/hostname
        # Tolerate dedicated Kafka nodes
        tolerations:
          - key: dedicated
            operator: Equal
            value: kafka
            effect: NoSchedule
        # Node selector for dedicated Kafka nodes
        nodeSelector:
          workload: kafka
        # Termination grace period must be longer than the longest batch interval
        terminationGracePeriodSeconds: 60
      # Kafka pod disruption budget
      podDisruptionBudget:
        maxUnavailable: 1
    # Metrics via Prometheus JMX exporter
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: kafka-metrics-config
          key: kafka-metrics-config.yml
  # ZooKeeper configuration (used if not on KRaft mode)
  zookeeper:
    replicas: 3
    storage:
      type: persistent-claim
      size: 50Gi
      class: premium-ssd
      deleteClaim: false
    resources:
      requests:
        cpu: 500m
        memory: 1Gi
      limits:
        memory: 2Gi
    template:
      pod:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchExpressions:
                    - key: strimzi.io/name
                      operator: In
                      values:
                        - kafka-production-zookeeper
                topologyKey: kubernetes.io/hostname
  # Entity operator manages topics and users
  entityOperator:
    topicOperator:
      resources:
        requests:
          cpu: 200m
          memory: 256Mi
        limits:
          memory: 512Mi
      # How often the topic operator reconciles
      reconciliationIntervalMs: 90000
      # ZooKeeper session timeout
      zookeeperSessionTimeoutMs: 18000
    userOperator:
      resources:
        requests:
          cpu: 200m
          memory: 256Mi
        limits:
          memory: 512Mi
      reconciliationIntervalMs: 60000
  # Kafka Exporter for additional consumer lag metrics
  kafkaExporter:
    topicRegex: ".*"
    groupRegex: ".*"
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
    readinessProbe:
      initialDelaySeconds: 15
      timeoutSeconds: 5
```

### JMX Metrics Configuration

```yaml
# kafka/kafka-metrics-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-metrics-config
  namespace: kafka
data:
  kafka-metrics-config.yml: |
    # Kafka broker metrics via JMX
    lowercaseOutputName: true
    rules:
      # Request metrics — rate and latency per request type
      - pattern: kafka.server<type=(.+), name=(.+)PerSec\w*, topic=(.+)><>Count
        name: kafka_server_$1_$2_total
        type: COUNTER
        labels:
          topic: "$3"
      # Broker metrics — under-replicated partitions (critical for health)
      - pattern: kafka.server<type=ReplicaManager, name=UnderReplicatedPartitions><>Value
        name: kafka_server_replicamanager_underreplicatedpartitions
        type: GAUGE
      # Request queue size (indicates broker overload)
      - pattern: kafka.network<type=RequestChannel, name=RequestQueueSize><>Value
        name: kafka_network_requestchannel_requestqueuesize
        type: GAUGE
      # Log size per topic-partition
      - pattern: kafka.log<type=Log, name=Size, topic=(.+), partition=(.+)><>Value
        name: kafka_log_size_bytes
        type: GAUGE
        labels:
          topic: "$1"
          partition: "$2"
      # ISR (In-Sync Replica) shrinks and expansions
      - pattern: kafka.server<type=ReplicaManager, name=IsrShrinksPerSec><>Count
        name: kafka_server_replicamanager_isr_shrinks_total
        type: COUNTER
      - pattern: kafka.server<type=ReplicaManager, name=IsrExpandsPerSec><>Count
        name: kafka_server_replicamanager_isr_expands_total
        type: COUNTER
      # Leader elections
      - pattern: kafka.controller<type=ControllerStats, name=LeaderElectionRateAndTimeMs><>Count
        name: kafka_controller_leadere_lection_total
        type: COUNTER
      # Consumer group lag (via Kafka Exporter)
      - pattern: kafka.consumer<type=.+, clientId=(.+), topic=(.+), partition=(.+)><>(.+)
        name: kafka_consumer_$4
        labels:
          client_id: "$1"
          topic: "$2"
          partition: "$3"
```

## Topic Operator: KafkaTopic Resource

```yaml
# kafka/topics/events-topic.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: user-events
  namespace: kafka
  labels:
    # REQUIRED: topic operator uses this label to find the cluster
    strimzi.io/cluster: kafka-production
spec:
  # Number of partitions — scale for parallelism
  # Rule of thumb: partitions >= consumer group size
  partitions: 24
  # Replication factor — 3 for production HA
  replicas: 3
  config:
    # Message retention
    retention.ms: "604800000"         # 7 days
    retention.bytes: "10737418240"    # 10GB per partition
    # Segment configuration
    segment.bytes: "1073741824"       # 1GB segments
    segment.ms: "86400000"            # Roll segments daily regardless of size
    # Cleanup policy
    cleanup.policy: delete
    # Compression at the broker level (supplementing producer compression)
    compression.type: producer
    # Maximum message size (must align with producer settings)
    max.message.bytes: "1048576"      # 1MB
    # ISR: minimum replicas that must acknowledge writes
    min.insync.replicas: "2"
```

### Compacted Topic for Change Data Capture

```yaml
# kafka/topics/user-profiles-compacted.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: user-profiles
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-production
spec:
  partitions: 12
  replicas: 3
  config:
    cleanup.policy: compact
    # Compaction aggressiveness
    min.cleanable.dirty.ratio: "0.5"
    # Keep deleted keys for 24 hours (tombstone retention)
    delete.retention.ms: "86400000"
    # Compaction lag: only compact segments older than 1 hour
    min.compaction.lag.ms: "3600000"
    # Maximum time before compaction starts
    max.compaction.lag.ms: "604800000"
    # Segment size for compacted topics (smaller for faster compaction)
    segment.bytes: "268435456"        # 256MB
```

## User Operator: KafkaUser Resource

```yaml
# kafka/users/producer-user.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: events-producer
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-production
spec:
  # SCRAM-SHA-512 authentication
  authentication:
    type: scram-sha-512
  # ACL authorization — least privilege
  authorization:
    type: simple
    acls:
      # Allow writing to user-events topic
      - resource:
          type: topic
          name: user-events
          patternType: literal
        operations:
          - Describe
          - Write
        host: "*"
      # Allow transactional writes (if using exactly-once semantics)
      - resource:
          type: transactionalId
          name: events-producer-txn
          patternType: prefix
        operations:
          - Describe
          - Write
        host: "*"
      # Cluster-level permission required for producer metadata requests
      - resource:
          type: cluster
          name: kafka-cluster
        operations:
          - IdempotentWrite
        host: "*"
```

```yaml
# kafka/users/consumer-user.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: events-consumer
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-production
spec:
  authentication:
    type: scram-sha-512
  authorization:
    type: simple
    acls:
      # Read from user-events topic
      - resource:
          type: topic
          name: user-events
          patternType: literal
        operations:
          - Describe
          - Read
        host: "*"
      # Consumer group operations
      - resource:
          type: group
          name: events-consumer-group
          patternType: prefix
        operations:
          - Describe
          - Read
        host: "*"
      # Allow listing offsets for lag monitoring
      - resource:
          type: topic
          name: __consumer_offsets
          patternType: literal
        operations:
          - Describe
          - Read
        host: "*"
```

## KafkaMirrorMaker2: Cross-Cluster Replication

KafkaMirrorMaker2 replicates topics between Kafka clusters. This is used for disaster recovery, geo-replication, and data aggregation.

```yaml
# kafka/mirrormaker2/mirrormaker2.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: cross-region-replication
  namespace: kafka
spec:
  version: 3.7.0
  replicas: 2
  # Define both clusters involved in replication
  clusters:
    - alias: us-east-1
      bootstrapServers: kafka-production-kafka-bootstrap.kafka.svc.cluster.local:9093
      tls:
        trustedCertificates:
          - secretName: kafka-cluster-ca-cert
            certificate: ca.crt
      authentication:
        type: scram-sha-512
        username: mirrormaker-user
        passwordSecret:
          secretName: mirrormaker-user
          password: password
    - alias: eu-west-1
      bootstrapServers: kafka-eu-west-kafka-bootstrap.kafka-eu.svc.cluster.local:9093
      tls:
        trustedCertificates:
          - secretName: kafka-eu-cluster-ca-cert
            certificate: ca.crt
      authentication:
        type: scram-sha-512
        username: mirrormaker-eu-user
        passwordSecret:
          secretName: mirrormaker-eu-user
          password: password
  # Mirror configuration — what to replicate and how
  mirrors:
    - sourceCluster: us-east-1
      targetCluster: eu-west-1
      sourceConnector:
        # Which topics to replicate
        config:
          # Mirror all topics matching this pattern
          topics: "user-events,user-profiles,order-events"
          # Replication factor on the target cluster
          replication.factor: 3
          # Offset synchronization: sync consumer group offsets to target
          sync.consumer.group.offsets.enabled: "true"
          sync.consumer.group.offsets.interval.seconds: "60"
          # Emit heartbeats to measure replication lag
          emit.heartbeats.enabled: "true"
          emit.heartbeats.interval.seconds: "5"
          # Rename topics on target (prefix with source cluster name)
          # Replicated topics will be named: us-east-1.user-events
          replication.policy.class: "org.apache.kafka.connect.mirror.IdentityReplicationPolicy"
      # Checkpoint connector: maps consumer group offsets across clusters
      checkpointConnector:
        config:
          checkpoints.topic.replication.factor: 3
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: "60"
      # Which consumer groups to track for failover
      groupsPattern: "events-consumer-group.*"
      topicsPattern: "user-events|user-profiles|order-events"
  # Resource configuration
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: 2000m
      memory: 2Gi
```

## Cruise Control: Automated Partition Rebalancing

Cruise Control analyzes the cluster load and generates partition reassignment proposals to balance disk usage, network throughput, and CPU load across brokers.

```yaml
# Add to the Kafka cluster spec
spec:
  kafka:
    # ... existing config ...
  cruiseControl:
    replicas: 1
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        memory: 1Gi
    # Capacity configuration — tell Cruise Control the broker capabilities
    brokerCapacity:
      disk: 500000           # MB of disk per broker
      cpuUtilization: 100    # percentage
      inboundNetwork: 10000  # KB/s
      outboundNetwork: 10000 # KB/s
    config:
      # Goals used for partition assignment optimization
      # Ordered from most to least important
      goals: >
        com.linkedin.kafka.cruisecontrol.analyzer.goals.RackAwareGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.MinTopicLeadersPerBrokerGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.DiskCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkInboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkOutboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.CpuCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.LeaderReplicaDistributionGoal
      # How often to generate a new rebalance proposal (if auto-approval is enabled)
      cruise.control.goals: >
        com.linkedin.kafka.cruisecontrol.analyzer.goals.RackAwareGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaCapacityGoal
      # Minimum number of replicas considered valid for a broker
      min.valid.partition.ratio: 0.95
```

### Triggering a Rebalance via KafkaRebalance

```yaml
# kafka/rebalance/rebalance-add-broker.yaml
# Trigger after adding a new broker to the cluster
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: rebalance-after-scale-out
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-production
spec:
  # Mode: add-brokers, remove-brokers, or full (default)
  mode: add-brokers
  # New broker IDs to include in the rebalance
  brokers:
    - 3  # The new broker
  # Goals for this specific rebalance (override cluster defaults)
  goals:
    - RackAwareGoal
    - ReplicaCapacityGoal
    - DiskCapacityGoal
    - ReplicaDistributionGoal
  # Skip hard goals if they cannot be fully satisfied
  skipHardGoalCheck: false
  # Maximum number of concurrent partition movements
  # Lower this to reduce impact on production traffic
  concurrentPartitionMovementsPerBroker: 5
  concurrentLeaderMovements: 1000
```

```bash
# Approve the rebalance after reviewing the proposal
kubectl annotate kafkarebalance rebalance-after-scale-out \
  --namespace kafka \
  strimzi.io/rebalance=approve

# Monitor the rebalance progress
kubectl get kafkarebalance rebalance-after-scale-out -n kafka -w

# Check the status (ProposalReady -> Rebalancing -> Ready)
kubectl describe kafkarebalance rebalance-after-scale-out -n kafka
```

## Broker Rolling Upgrade Strategy

Strimzi handles rolling upgrades automatically when the Kafka CR is updated. Understanding the sequence prevents data loss.

```bash
# Step 1: Update the Strimzi operator (does NOT immediately update the cluster)
helm upgrade strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace kafka-system \
  --version 0.41.0

# Step 2: Update the Kafka version in the CR
# The operator enforces the correct upgrade path
kubectl patch kafka kafka-production -n kafka --type=merge \
  --patch='{"spec":{"kafka":{"version":"3.7.1"}}}'

# Step 3: Monitor the rolling update
# Strimzi rolls brokers one at a time, waiting for ISR recovery between each
kubectl get pods -n kafka -w | grep kafka-production-kafka

# Check that all partitions are in-sync before each broker restart
# (Strimzi does this automatically, but manual verification is good practice)
kubectl exec -it kafka-production-kafka-0 -n kafka -c kafka -- \
  bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --under-replicated-partitions

# Step 4: After all brokers are updated, update the inter-broker protocol
# (only needed for major version upgrades)
kubectl patch kafka kafka-production -n kafka --type=merge \
  --patch='{"spec":{"kafka":{"config":{"inter.broker.protocol.version":"3.7"}}}}'

# Step 5: Update the log message format version
kubectl patch kafka kafka-production -n kafka --type=merge \
  --patch='{"spec":{"kafka":{"config":{"log.message.format.version":"3.7"}}}}'
```

## Kafka Operational Commands

```bash
# Get the Kafka bootstrap address
BOOTSTRAP=$(kubectl get kafka kafka-production -n kafka \
  -o jsonpath='{.status.listeners[?(@.name=="plain")].bootstrapServers}')

# List all topics
kubectl exec -it kafka-production-kafka-0 -n kafka -c kafka -- \
  bin/kafka-topics.sh \
  --bootstrap-server ${BOOTSTRAP} \
  --list

# Describe a topic (partition distribution, ISR, etc.)
kubectl exec -it kafka-production-kafka-0 -n kafka -c kafka -- \
  bin/kafka-topics.sh \
  --bootstrap-server ${BOOTSTRAP} \
  --describe \
  --topic user-events

# Check consumer group lag
kubectl exec -it kafka-production-kafka-0 -n kafka -c kafka -- \
  bin/kafka-consumer-groups.sh \
  --bootstrap-server ${BOOTSTRAP} \
  --describe \
  --group events-consumer-group

# Reset consumer group offsets to beginning (for reprocessing)
kubectl exec -it kafka-production-kafka-0 -n kafka -c kafka -- \
  bin/kafka-consumer-groups.sh \
  --bootstrap-server ${BOOTSTRAP} \
  --group events-consumer-group \
  --topic user-events \
  --reset-offsets \
  --to-earliest \
  --dry-run  # Remove --dry-run to execute

# Check under-replicated partitions (health indicator)
kubectl exec -it kafka-production-kafka-0 -n kafka -c kafka -- \
  bin/kafka-topics.sh \
  --bootstrap-server ${BOOTSTRAP} \
  --describe \
  --under-replicated-partitions

# Check log directory sizes across brokers
for i in 0 1 2; do
  echo "=== Broker ${i} ==="
  kubectl exec -it kafka-production-kafka-${i} -n kafka -c kafka -- \
    du -sh /var/lib/kafka/data-0/kafka-log*/
done
```

## Prometheus Alerts for Kafka

```yaml
# alerting/rules/kafka-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kafka-strimzi-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: kafka.rules
      rules:
        # Alert when there are under-replicated partitions
        # This means some replicas are not keeping up with the leader
        - alert: KafkaUnderReplicatedPartitions
          expr: kafka_server_replicamanager_underreplicatedpartitions > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kafka has {{ $value }} under-replicated partitions"
            description: "Under-replicated partitions indicate a broker health issue or slow follower."

        # Alert on high consumer group lag
        - alert: KafkaConsumerLagHigh
          expr: |
            kafka_consumergroup_lag_sum{consumergroup!="",topic!=""} > 100000
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Consumer group {{ $labels.consumergroup }} lag is {{ $value }}"
            description: "Consumer group {{ $labels.consumergroup }} on topic {{ $labels.topic }} has accumulated {{ $value }} unprocessed messages."

        # Alert when a broker is offline
        - alert: KafkaBrokerCountLow
          expr: |
            count(kafka_server_kafkaserver_brokerstate == 3) < 3
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Kafka cluster has fewer than 3 active brokers"

        # Alert on high request queue depth (broker overload)
        - alert: KafkaRequestQueueFull
          expr: kafka_network_requestchannel_requestqueuesize > 500
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kafka request queue depth is {{ $value }} on broker {{ $labels.instance }}"

        # Alert when ISR shrinks frequently (network or disk issues)
        - alert: KafkaISRShrinkRate
          expr: rate(kafka_server_replicamanager_isr_shrinks_total[5m]) > 0.1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kafka ISR is shrinking at {{ $value }} shrinks/second"
```

## Summary

Strimzi provides a comprehensive Kubernetes-native management layer for Apache Kafka that handles the full operational lifecycle from initial deployment through version upgrades. The `Kafka` CRD encodes production best practices including rack-aware partition placement, per-broker persistent storage volumes, PodAntiAffinity rules, and JVM tuning. The Topic and User operators bring declarative management of Kafka internals, enabling GitOps workflows for topic configuration and ACL management. KafkaMirrorMaker2 handles cross-cluster replication with consumer offset synchronization for disaster recovery scenarios. Cruise Control automates the partition rebalancing that would otherwise require significant manual intervention when scaling or during broker failures. The combination of these components, backed by comprehensive Prometheus alerting on under-replicated partitions, consumer lag, and broker health metrics, provides the foundation for operating Kafka reliably at scale on Kubernetes.
