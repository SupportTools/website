---
title: "Strimzi Kafka Operator: Production Event Streaming on Kubernetes"
date: 2027-03-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kafka", "Strimzi", "Event Streaming", "Operator"]
categories: ["Kubernetes", "Messaging", "Operators"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Strimzi Kafka operator on Kubernetes covering Kafka cluster configuration with KRaft mode, topic and user management CRDs, TLS/SASL authentication, Kafka Bridge for HTTP access, Mirror Maker 2 for cluster replication, Cruise Control for rebalancing, and Prometheus monitoring."
more_link: "yes"
url: "/kafka-strimzi-operator-kubernetes-production-guide/"
---

Strimzi provides a Kubernetes-native way to run Apache Kafka, transforming the complex, ZooKeeper-dependent distributed system into a set of declarative custom resources. With KRaft mode (Kafka Raft Metadata), ZooKeeper is completely eliminated: Kafka brokers themselves store cluster metadata using the Raft consensus algorithm, reducing operational complexity and improving startup time. Strimzi's operator suite covers the full lifecycle — cluster provisioning, topic and user management, TLS certificate rotation, partition rebalancing with Cruise Control, cross-cluster replication with Mirror Maker 2, and HTTP access with Kafka Bridge.

This guide covers the complete production deployment: operator installation, Kafka CRD with KRaft mode, KafkaTopic and KafkaUser CRDs, listener configuration, Cruise Control, KafkaBridge, Mirror Maker 2, Prometheus monitoring, and upgrade procedures.

<!--more-->

## Section 1: Architecture Overview

### Strimzi Operator Suite

```
┌────────────────────────────────────────────────────────────────────┐
│  Strimzi Cluster Operator (Deployment)                             │
│  Watches: Kafka, KafkaConnect, KafkaMirrorMaker2, KafkaBridge,    │
│           KafkaRebalance, StrimziPodSet                            │
└───────────────────────────────────┬────────────────────────────────┘
                                    │ delegates sub-operators
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
   ┌──────▼──────┐           ┌──────▼──────┐          ┌──────▼──────┐
   │  Entity     │           │  Topic      │          │  User       │
   │  Operator   │           │  Operator   │          │  Operator   │
   │  (per-kafka)│           │  (per-kafka)│          │  (per-kafka)│
   └──────┬──────┘           └──────┬──────┘          └──────┬──────┘
          │ manages                 │ manages                 │ manages
          │                 ┌──────▼──────┐          ┌──────▼──────┐
          │                 │ KafkaTopic  │          │ KafkaUser   │
          │                 │ CRDs        │          │ CRDs        │
          │                 └─────────────┘          └─────────────┘
          │
┌─────────▼───────────────────────────────────────────────────────┐
│  Kafka Cluster (StrimziPodSet — replaces StatefulSet)            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  KRaft Mode: Kafka brokers serve dual role                 │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                   │  │
│  │  │ broker-0│  │ broker-1│  │ broker-2│  (broker+         │  │
│  │  │ +ctrl   │  │ +ctrl   │  │ +ctrl   │   controller       │  │
│  │  └─────────┘  └─────────┘  └─────────┘   combined role)  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Listeners                                                       │
│  plain (9092) → internal plaintext                               │
│  tls (9093)   → internal TLS                                     │
│  external (9094) → LoadBalancer/Ingress                          │
└──────────────────────────────────────────────────────────────────┘
```

### KRaft vs ZooKeeper Mode

KRaft mode removes the ZooKeeper dependency introduced in Apache Kafka 0.8. In KRaft, each Kafka broker can be a combined broker+controller or a dedicated controller. The controller quorum uses the `__cluster_metadata` internal topic and Raft log for consensus. As of Kafka 3.7+, KRaft mode is the default and ZooKeeper mode is deprecated.

---

## Section 2: Strimzi Operator Installation

### Install via Helm

```bash
helm repo add strimzi https://strimzi.io/charts/
helm repo update

helm upgrade --install strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace kafka-operator \
  --create-namespace \
  --version 0.41.0 \
  --set watchNamespaces="{messaging,analytics}" \
  --set logLevel=INFO \
  --wait
```

### Verify CRDs

```bash
kubectl get crd | grep kafka
# Expected:
# kafkabridges.kafka.strimzi.io
# kafkaconnectors.kafka.strimzi.io
# kafkaconnects.kafka.strimzi.io
# kafkamirrormaker2s.kafka.strimzi.io
# kafkanodepools.kafka.strimzi.io
# kafkarebalances.kafka.strimzi.io
# kafkas.kafka.strimzi.io
# kafkatopics.kafka.strimzi.io
# kafkausers.kafka.strimzi.io

kubectl get pods -n kafka-operator
```

---

## Section 3: Kafka CRD — KRaft Mode Production Cluster

### Full Production Kafka Cluster

```yaml
# kafka-production.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: kafka-production
  namespace: messaging
  annotations:
    strimzi.io/kraft: enabled          # Enable KRaft mode
    strimzi.io/node-pools: enabled     # Enable KafkaNodePool (separate broker/controller pools)
spec:
  kafka:
    version: 3.7.0

    # KRaft metadata version (must match Kafka version)
    metadataVersion: 3.7-IV4

    replicas: 3

    listeners:
      # Internal plaintext listener (within cluster)
      - name: plain
        port: 9092
        type: internal
        tls: false

      # Internal TLS listener
      - name: tls
        port: 9093
        type: internal
        tls: true
        authentication:
          type: tls                    # Mutual TLS authentication

      # External TLS listener via LoadBalancer
      - name: external
        port: 9094
        type: loadbalancer
        tls: true
        authentication:
          type: scram-sha-512
        configuration:
          bootstrap:
            annotations:
              service.beta.kubernetes.io/aws-load-balancer-type: nlb
              service.beta.kubernetes.io/aws-load-balancer-cross-zone-load-balancing-enabled: "true"
          brokerCertChainAndKey:
            secretName: kafka-external-tls-secret
            certificate: tls.crt
            key: tls.key

    authorization:
      type: simple                     # ACL-based authorization via KafkaUser CRD

    config:
      # Replication settings
      default.replication.factor: 3
      min.insync.replicas: 2
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      transaction.state.log.min.isr: 2

      # Log retention
      log.retention.hours: 168         # 7 days default retention
      log.retention.bytes: -1          # No size-based retention by default
      log.segment.bytes: 1073741824    # 1GB segments

      # Performance
      num.network.threads: 8
      num.io.threads: 16
      socket.send.buffer.bytes: 102400
      socket.receive.buffer.bytes: 102400
      socket.request.max.bytes: 104857600

      # Compression
      compression.type: producer       # Respect producer-specified compression

      # Group coordinator
      group.initial.rebalance.delay.ms: 3000

      # Auto-create topics (disable in production for governance)
      auto.create.topics.enable: "false"

      # Message size limits
      message.max.bytes: 1048576       # 1MB max message size
      replica.fetch.max.bytes: 1048576

      # JMX metrics exposure
      kafka.metrics.reporters: ""

    resources:
      requests:
        cpu: "2"
        memory: "8Gi"
      limits:
        cpu: "8"
        memory: "16Gi"

    jvmOptions:
      -Xms: 4096m
      -Xmx: 4096m
      gcLoggingEnabled: true
      javaSystemProperties:
        - name: com.sun.jndi.rmiregistry.object.trustURLCodebase
          value: "false"

    storage:
      type: persistent-claim
      size: 500Gi
      class: premium-rwo
      deleteClaim: false              # Retain PVCs on cluster deletion

    template:
      pod:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchExpressions:
                    - key: strimzi.io/cluster
                      operator: In
                      values:
                        - kafka-production
                    - key: strimzi.io/kind
                      operator: In
                      values:
                        - Kafka
                topologyKey: kubernetes.io/hostname
        terminationGracePeriodSeconds: 120

  # Entity Operator: deploys Topic Operator and User Operator
  entityOperator:
    topicOperator:
      resources:
        requests:
          cpu: "200m"
          memory: "256Mi"
        limits:
          cpu: "500m"
          memory: "512Mi"
    userOperator:
      resources:
        requests:
          cpu: "200m"
          memory: "256Mi"
        limits:
          cpu: "500m"
          memory: "512Mi"

  # Kafka Exporter for Prometheus metrics (consumer group lag etc.)
  kafkaExporter:
    topicRegex: ".*"
    groupRegex: ".*"
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "500m"
        memory: "256Mi"

  # Cruise Control for partition rebalancing
  cruiseControl:
    config:
      replication.throttle: -1
      num.concurrent.partition.movements.per.broker: 5
      num.concurrent.leader.movements: 1000
      default.goals: >
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.DiskCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkInboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkOutboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.CpuCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.TopicReplicaDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.LeaderBytesInDistributionGoal
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "2"
        memory: "2Gi"
    template:
      pod:
        metadata:
          labels:
            app: cruise-control
```

### Verify Kafka Cluster

```bash
# Watch cluster come up
kubectl get kafka kafka-production -n messaging -w

# Check broker Pods
kubectl get pods -n messaging -l strimzi.io/cluster=kafka-production

# Check service endpoints
kubectl get svc -n messaging -l strimzi.io/cluster=kafka-production
```

---

## Section 4: KafkaTopic CRD

### Create a Production Topic

```yaml
# topic-orders.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production    # Required label — binds to a Kafka cluster
spec:
  # Number of partitions (scale based on throughput: target 1MB/s per partition)
  partitions: 12

  # Replication factor (must be <= cluster size)
  replicas: 3

  config:
    # Retention: 7 days
    retention.ms: "604800000"

    # Minimum replicas that must acknowledge a write
    min.insync.replicas: "2"

    # Segment size for faster log compaction
    segment.bytes: "1073741824"       # 1GB

    # Compression: snappy provides good compression with low CPU overhead
    compression.type: snappy

    # Cleanup policy: delete (standard) or compact (for changelog-style topics)
    cleanup.policy: delete

    # Maximum message size for this topic (overrides broker default if smaller)
    max.message.bytes: "1048576"
---
# topic-user-events-compacted.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: user-events
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  partitions: 6
  replicas: 3
  config:
    # Log compaction: retain only the latest record per key
    cleanup.policy: compact
    min.cleanable.dirty.ratio: "0.1"
    segment.ms: "3600000"             # 1 hour segment rotation for faster compaction
    delete.retention.ms: "86400000"   # 1 day tombstone retention
    compression.type: lz4
```

### Topic Management Commands

```bash
# List topics managed by the Topic Operator
kubectl get kafkatopics -n messaging

# Increase partitions (cannot be decreased without data loss)
kubectl patch kafkatopic orders -n messaging \
  --type merge \
  --patch '{"spec":{"partitions":24}}'

# View topic configuration
kubectl describe kafkatopic orders -n messaging
```

---

## Section 5: KafkaUser CRD — Authentication and ACLs

### SCRAM-SHA-512 User

```yaml
# user-producer.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: orders-producer
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  authentication:
    type: scram-sha-512                # Password-based authentication

  authorization:
    type: simple                       # ACL-based authorization
    acls:
      # Allow writes to the orders topic
      - resource:
          type: topic
          name: orders
          patternType: literal
        operations: [Write, Describe]
        host: "*"

      # Allow transactional writes (required for exactly-once semantics)
      - resource:
          type: transactionalId
          name: orders-producer-txn-*
          patternType: prefix
        operations: [Write, Describe]
        host: "*"
---
# user-consumer.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: orders-consumer
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  authentication:
    type: scram-sha-512

  authorization:
    type: simple
    acls:
      # Allow reads from the orders topic
      - resource:
          type: topic
          name: orders
          patternType: literal
        operations: [Read, Describe]
        host: "*"

      # Allow consumer group coordination
      - resource:
          type: group
          name: orders-processing-group
          patternType: literal
        operations: [Read, Describe]
        host: "*"

      # Allow describe on cluster (needed for metadata requests)
      - resource:
          type: cluster
          name: kafka-cluster
        operations: [Describe]
        host: "*"
```

### TLS Client Certificate User

```yaml
# user-admin-tls.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: kafka-admin-client
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  authentication:
    type: tls                          # Mutual TLS authentication (certificate-based)

  authorization:
    type: simple
    acls:
      # Full access to all topics and groups
      - resource:
          type: topic
          name: "*"
          patternType: literal
        operations: [All]
        host: "*"
      - resource:
          type: group
          name: "*"
          patternType: literal
        operations: [All]
        host: "*"
      - resource:
          type: cluster
          name: kafka-cluster
        operations: [All]
        host: "*"
```

### Retrieve User Credentials

```bash
# Get SCRAM password for orders-producer
kubectl get secret orders-producer \
  --namespace messaging \
  -o jsonpath='{.data.password}' | base64 -d && echo

# Get TLS client certificate for kafka-admin-client
kubectl get secret kafka-admin-client \
  --namespace messaging \
  -o jsonpath='{.data.user\.crt}' | base64 -d > /tmp/admin.crt
kubectl get secret kafka-admin-client \
  --namespace messaging \
  -o jsonpath='{.data.user\.key}' | base64 -d > /tmp/admin.key
kubectl get secret kafka-production-cluster-ca-cert \
  --namespace messaging \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/kafka-ca.crt
```

---

## Section 6: Producer and Consumer Configuration

### Java Producer Configuration

```java
// OrdersProducerConfig.java
Properties props = new Properties();

// Bootstrap server (internal TLS listener)
props.put("bootstrap.servers",
    "kafka-production-kafka-bootstrap.messaging.svc.cluster.local:9093");

// SCRAM-SHA-512 authentication
props.put("security.protocol", "SASL_SSL");
props.put("sasl.mechanism", "SCRAM-SHA-512");
props.put("sasl.jaas.config",
    "org.apache.kafka.common.security.scram.ScramLoginModule required " +
    "username=\"orders-producer\" " +
    "password=\"" + System.getenv("KAFKA_PASSWORD") + "\";");

// TLS configuration
props.put("ssl.truststore.location", "/etc/kafka/tls/kafka-ca.jks");
props.put("ssl.truststore.password", System.getenv("KAFKA_TRUSTSTORE_PASSWORD"));

// Producer settings for high durability
props.put("acks", "all");             // All ISR replicas must acknowledge
props.put("retries", "2147483647");   // Retry indefinitely (delivery.timeout.ms caps this)
props.put("delivery.timeout.ms", "120000");
props.put("max.in.flight.requests.per.connection", "5");
props.put("enable.idempotence", "true");    // Exactly-once at producer level

// Batching for throughput
props.put("batch.size", "65536");     // 64KB batches
props.put("linger.ms", "5");         // Wait up to 5ms to build batches
props.put("compression.type", "snappy");
props.put("buffer.memory", "67108864"); // 64MB in-flight buffer
```

### Python Consumer Configuration

```python
# orders_consumer.py
from confluent_kafka import Consumer, KafkaError

config = {
    # Bootstrap server (external SCRAM listener)
    "bootstrap.servers": "kafka-external.company.internal:9094",

    # SCRAM-SHA-512 authentication
    "security.protocol": "SASL_SSL",
    "sasl.mechanism": "SCRAM-SHA-512",
    "sasl.username": "orders-consumer",
    "sasl.password": "EXAMPLE_CONSUMER_PASSWORD_REPLACE_ME",

    # TLS verification
    "ssl.ca.location": "/etc/kafka/tls/kafka-ca.crt",

    # Consumer group settings
    "group.id": "orders-processing-group",
    "auto.offset.reset": "earliest",     # Start from beginning for new groups
    "enable.auto.commit": False,         # Manual commit for at-least-once semantics
    "max.poll.interval.ms": 300000,      # 5 min max between polls (for slow processing)
    "session.timeout.ms": 30000,
    "heartbeat.interval.ms": 10000,

    # Fetch settings
    "fetch.min.bytes": 1,
    "fetch.max.wait.ms": 500,
    "max.partition.fetch.bytes": 1048576,
}

consumer = Consumer(config)
consumer.subscribe(["orders"])
```

---

## Section 7: Cruise Control for Partition Rebalancing

Cruise Control monitors broker load and calculates optimal partition reassignments to balance CPU, disk, and network utilisation across brokers.

### Trigger a Rebalance

```yaml
# kafka-rebalance.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: kafka-rebalance-full
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  mode: full                           # Full rebalance (leaders + replicas)
  goals:
    - ReplicaCapacityGoal
    - DiskCapacityGoal
    - NetworkInboundCapacityGoal
    - NetworkOutboundCapacityGoal
    - ReplicaDistributionGoal
    - TopicReplicaDistributionGoal
    - LeaderBytesInDistributionGoal
  skipHardGoalCheck: false
```

### Monitor and Approve the Rebalance

```bash
# Apply the KafkaRebalance CRD
kubectl apply -f kafka-rebalance.yaml

# Check rebalance proposal status
kubectl get kafkarebalance kafka-rebalance-full -n messaging

# When status is ProposalReady, review the proposal
kubectl describe kafkarebalance kafka-rebalance-full -n messaging | grep -A50 "Optimization Result"

# Approve the rebalance (add annotation to trigger execution)
kubectl annotate kafkarebalance kafka-rebalance-full \
  --namespace messaging \
  strimzi.io/rebalance=approve

# Monitor rebalance progress
kubectl get kafkarebalance kafka-rebalance-full -n messaging -w

# Stop a running rebalance
kubectl annotate kafkarebalance kafka-rebalance-full \
  --namespace messaging \
  strimzi.io/rebalance=stop
```

### Add Broker Rebalance (After Scaling)

```yaml
# kafka-rebalance-add-brokers.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: kafka-rebalance-add-brokers
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  mode: add-brokers                    # Move partitions to newly added brokers
  brokers: [3, 4]                      # IDs of the newly added brokers
```

---

## Section 8: KafkaBridge — HTTP REST Access

KafkaBridge exposes Kafka topics via an HTTP/1.1 REST API. This allows services that cannot use the native Kafka protocol to produce and consume messages.

```yaml
# kafka-bridge.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaBridge
metadata:
  name: kafka-bridge-production
  namespace: messaging
spec:
  replicas: 2
  bootstrapServers: kafka-production-kafka-bootstrap.messaging.svc.cluster.local:9093

  authentication:
    type: tls
    certificateAndKey:
      secretName: kafka-admin-client
      certificate: user.crt
      key: user.key

  tls:
    trustedCertificates:
      - secretName: kafka-production-cluster-ca-cert
        certificate: ca.crt

  http:
    port: 8080
    cors:
      allowedOrigins:
        - "https://app.company.internal"
        - "https://portal.company.internal"
      allowedMethods:
        - GET
        - POST
        - PUT
        - DELETE
        - OPTIONS
        - PATCH

  consumer:
    config:
      auto.offset.reset: earliest
      enable.auto.commit: false
      max.poll.records: "500"

  producer:
    config:
      acks: all
      compression.type: snappy

  resources:
    requests:
      cpu: "200m"
      memory: "256Mi"
    limits:
      cpu: "1"
      memory: "512Mi"
```

### Kafka Bridge API Usage

```bash
# Bridge service endpoint
BRIDGE_URL="http://kafka-bridge-production-bridge-service.messaging.svc.cluster.local:8080"

# Produce a message to the orders topic
curl -X POST "$BRIDGE_URL/topics/orders" \
  -H "Content-Type: application/vnd.kafka.json.v2+json" \
  -d '{
    "records": [
      {
        "key": "order-12345",
        "value": {
          "order_id": "12345",
          "customer_id": "cust-42",
          "amount": 149.99,
          "status": "pending"
        }
      }
    ]
  }'

# Create a consumer instance
curl -X POST "$BRIDGE_URL/consumers/bridge-consumer-group" \
  -H "Content-Type: application/vnd.kafka.v2+json" \
  -d '{
    "name": "bridge-consumer-1",
    "format": "json",
    "auto.offset.reset": "earliest",
    "enable.auto.commit": false
  }'

# Subscribe to a topic
curl -X POST "$BRIDGE_URL/consumers/bridge-consumer-group/instances/bridge-consumer-1/subscription" \
  -H "Content-Type: application/vnd.kafka.v2+json" \
  -d '{"topics": ["orders"]}'

# Consume messages (long poll)
curl -X GET "$BRIDGE_URL/consumers/bridge-consumer-group/instances/bridge-consumer-1/records?timeout=3000&max_bytes=1048576" \
  -H "Accept: application/vnd.kafka.json.v2+json"

# Commit offsets
curl -X POST "$BRIDGE_URL/consumers/bridge-consumer-group/instances/bridge-consumer-1/offsets" \
  -H "Content-Type: application/vnd.kafka.v2+json" \
  -d '{"offsets": [{"topic": "orders", "partition": 0, "offset": 100}]}'
```

---

## Section 9: Mirror Maker 2 — Cross-Cluster Replication

Mirror Maker 2 (MM2) provides active-passive or active-active replication between Kafka clusters. It is built on Kafka Connect and supports offset translation for consumer group migration.

### Mirror Maker 2 CRD

```yaml
# mirror-maker2.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: kafka-mm2-dr
  namespace: messaging
spec:
  version: 3.7.0
  replicas: 2

  # Source cluster: primary production
  # Target cluster: disaster recovery site
  clusters:
    - alias: source
      bootstrapServers: kafka-production-kafka-bootstrap.messaging.svc.cluster.local:9093
      authentication:
        type: tls
        certificateAndKey:
          secretName: kafka-admin-client
          certificate: user.crt
          key: user.key
      tls:
        trustedCertificates:
          - secretName: kafka-production-cluster-ca-cert
            certificate: ca.crt

    - alias: target
      bootstrapServers: kafka-dr.dr-site.svc.cluster.local:9093
      authentication:
        type: scram-sha-512
        username: mm2-replication-user
        passwordSecret:
          secretName: mm2-dr-credentials
          password: password
      tls:
        trustedCertificates:
          - secretName: kafka-dr-cluster-ca-cert
            certificate: ca.crt

  mirrors:
    - sourceCluster: source
      targetCluster: target

      sourceConnector:
        config:
          replication.factor: 3
          offset-syncs.topic.replication.factor: 3
          sync.topic.acls.enabled: "false"     # Do not mirror ACLs
          refresh.topics.interval.seconds: "30"
          refresh.groups.interval.seconds: "30"

          # Topics to mirror (regex)
          topics: "orders|user-events|notifications"

          # Consumer groups to replicate offset data for
          groups: "orders-processing-group|notification-consumer-group"

      checkpointConnector:
        config:
          checkpoints.topic.replication.factor: 3
          sync.group.offsets.enabled: "true"   # Enable offset sync for failover
          sync.group.offsets.interval.seconds: "30"
          emit.checkpoints.interval.seconds: "30"

      heartbeatConnector:
        config:
          heartbeats.topic.replication.factor: 3

  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "2Gi"

  template:
    pod:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: strimzi.io/cluster
                      operator: In
                      values:
                        - kafka-mm2-dr
                topologyKey: kubernetes.io/hostname
```

### Monitor Mirror Maker 2 Lag

```bash
# Check MM2 connector status via Kafka Connect REST API
kubectl port-forward svc/kafka-mm2-dr-mirrormaker2-api 8083:8083 -n messaging &

# List connectors
curl http://localhost:8083/connectors

# Check source connector status
curl "http://localhost:8083/connectors/source->target.MirrorSourceConnector/status" | python3 -m json.tool

# Check replication lag per topic-partition
curl "http://localhost:8083/connectors/source->target.MirrorSourceConnector/tasks/0/status"
```

---

## Section 10: Prometheus Monitoring

### ServiceMonitor for Kafka Metrics (JMX Exporter)

Strimzi automatically deploys a Prometheus JMX exporter sidecar on each Kafka Pod.

```yaml
# kafka-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kafka-production-metrics
  namespace: messaging
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      strimzi.io/cluster: kafka-production
      strimzi.io/kind: Kafka
  namespaceSelector:
    matchNames:
      - messaging
  endpoints:
    - port: tcp-prometheus
      interval: 30s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_pod_label_strimzi_io_broker_id]
          targetLabel: broker_id
---
# kafka-exporter-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kafka-exporter-metrics
  namespace: messaging
  labels:
    release: kube-prometheus-stack
spec:
  selector:
    matchLabels:
      strimzi.io/cluster: kafka-production
      strimzi.io/component-type: kafka-exporter
  namespaceSelector:
    matchNames:
      - messaging
  endpoints:
    - port: tcp-prometheus
      interval: 30s
      path: /metrics
```

### Prometheus Alerting Rules

```yaml
# kafka-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kafka-production-alerts
  namespace: messaging
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: kafka.broker
      interval: 30s
      rules:
        # Broker is down
        - alert: KafkaBrokerDown
          expr: |
            up{job="kafka-production-kafka-brokers"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Kafka broker {{ $labels.pod }} is down"
            description: "Kafka broker Pod {{ $labels.pod }} has been unreachable for 2 minutes."

        # Under-replicated partitions (ISR < RF)
        - alert: KafkaUnderReplicatedPartitions
          expr: |
            kafka_server_replicamanager_underreplicatedpartitions > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kafka under-replicated partitions on {{ $labels.pod }}"
            description: "{{ $value }} partitions are under-replicated on broker {{ $labels.pod }}."

        # Offline partitions (no leader — data unavailable)
        - alert: KafkaOfflinePartitions
          expr: |
            kafka_controller_kafkacontroller_offlinepartitionscount > 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Kafka offline partitions detected"
            description: "{{ $value }} partitions have no leader and are unavailable."

        # High network throughput approaching capacity
        - alert: KafkaBrokerNetworkThroughputHigh
          expr: |
            rate(kafka_network_requestmetrics_totaltimems_sum{request="Produce"}[5m]) > 900000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Kafka broker network throughput high on {{ $labels.pod }}"

        # JVM heap usage > 85%
        - alert: KafkaBrokerJVMHeapHigh
          expr: |
            kafka_jvm_memory_bytes_used{area="heap"} /
            kafka_jvm_memory_bytes_max{area="heap"} > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kafka broker JVM heap high on {{ $labels.pod }}"
            description: "Heap is {{ $value | humanizePercentage }} full on {{ $labels.pod }}."

    - name: kafka.consumer
      interval: 60s
      rules:
        # Consumer group lag > 100K messages
        - alert: KafkaConsumerGroupLagHigh
          expr: |
            sum by (consumergroup, topic) (kafka_consumergroup_lag) > 100000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Kafka consumer group lag high"
            description: "Consumer group {{ $labels.consumergroup }} on topic {{ $labels.topic }} has {{ $value }} lagging messages."

        # Consumer group is not making progress (lag stays constant)
        - alert: KafkaConsumerGroupStalled
          expr: |
            delta(kafka_consumergroup_lag[10m]) == 0
            and kafka_consumergroup_lag > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Kafka consumer group {{ $labels.consumergroup }} stalled"
            description: "Consumer group lag has not decreased in 10 minutes."
```

### Grafana Dashboard Import

```bash
# Strimzi provides official Grafana dashboards
# Import from the Strimzi examples repository

# Download Kafka dashboard JSON
curl -Lo /tmp/strimzi-kafka-dashboard.json \
  "https://raw.githubusercontent.com/strimzi/strimzi-kafka-operator/main/examples/metrics/grafana-dashboards/strimzi-kafka.json"

# Import via Grafana API
curl -X POST \
  -H "Content-Type: application/json" \
  -d "{\"dashboard\": $(cat /tmp/strimzi-kafka-dashboard.json), \"overwrite\": true, \"folderId\": 0}" \
  "http://admin:EXAMPLE_GRAFANA_PASSWORD_REPLACE_ME@grafana.monitoring.svc.cluster.local:3000/api/dashboards/db"
```

---

## Section 11: Kafka Upgrade Procedure

Strimzi supports rolling Kafka upgrades by managing the `inter.broker.protocol.version` and `log.message.format.version` settings.

### Upgrade from Kafka 3.6 to 3.7

```bash
# Step 1: Update Strimzi operator to version that supports Kafka 3.7
helm upgrade strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace kafka-operator \
  --version 0.41.0 \
  --reuse-values \
  --wait

# Step 2: Update the Kafka version in the CRD
kubectl patch kafka kafka-production \
  --namespace messaging \
  --type merge \
  --patch '{"spec":{"kafka":{"version":"3.7.0"}}}'

# The operator will perform a rolling update of all brokers
# Monitor progress
kubectl get kafka kafka-production -n messaging -w

# Step 3: After all brokers are on 3.7, update the metadata version
kubectl patch kafka kafka-production \
  --namespace messaging \
  --type merge \
  --patch '{"spec":{"kafka":{"metadataVersion":"3.7-IV4"}}}'

# Step 4: Verify all brokers report the new version
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-broker-api-versions.sh \
    --bootstrap-server localhost:9092 \
  | grep "3.7"
```

---

## Section 12: Scaling the Kafka Cluster

### Add Brokers (Scale Out)

```bash
# Scale from 3 to 5 brokers
kubectl patch kafka kafka-production \
  --namespace messaging \
  --type merge \
  --patch '{"spec":{"kafka":{"replicas":5}}}'

# After new brokers are ready, trigger a rebalance to use them
cat <<EOF | kubectl apply -f -
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: kafka-rebalance-scale-out
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  mode: add-brokers
  brokers: [3, 4]
EOF

# Approve after reviewing the proposal
kubectl annotate kafkarebalance kafka-rebalance-scale-out \
  --namespace messaging \
  strimzi.io/rebalance=approve
```

### Remove Brokers (Scale In)

```bash
# Step 1: Remove partitions from brokers to be removed
cat <<EOF | kubectl apply -f -
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: kafka-rebalance-scale-in
  namespace: messaging
  labels:
    strimzi.io/cluster: kafka-production
spec:
  mode: remove-brokers
  brokers: [3, 4]
EOF

kubectl annotate kafkarebalance kafka-rebalance-scale-in \
  --namespace messaging \
  strimzi.io/rebalance=approve

# Wait for rebalance to complete before scaling down
kubectl get kafkarebalance kafka-rebalance-scale-in -n messaging -w

# Step 2: Scale down after rebalance is Ready
kubectl patch kafka kafka-production \
  --namespace messaging \
  --type merge \
  --patch '{"spec":{"kafka":{"replicas":3}}}'
```

---

## Section 13: NetworkPolicy for Kafka Isolation

```yaml
# kafka-network-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kafka-production-allow
  namespace: messaging
spec:
  podSelector:
    matchLabels:
      strimzi.io/cluster: kafka-production
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow producer/consumer connections from application namespace (internal TLS)
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: application
      ports:
        - protocol: TCP
          port: 9092   # plain
        - protocol: TCP
          port: 9093   # tls
    # Allow inter-broker replication
    - from:
        - podSelector:
            matchLabels:
              strimzi.io/cluster: kafka-production
      ports:
        - protocol: TCP
          port: 9090   # KRaft controller
        - protocol: TCP
          port: 9091   # Replication
        - protocol: TCP
          port: 9092
        - protocol: TCP
          port: 9093
    # Allow Prometheus scraping
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - protocol: TCP
          port: 9404   # JMX exporter
    # Allow Strimzi operator
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kafka-operator
      ports:
        - protocol: TCP
          port: 9090
        - protocol: TCP
          port: 9091
        - protocol: TCP
          port: 9092
        - protocol: TCP
          port: 9093
  egress:
    # Inter-broker communication
    - to:
        - podSelector:
            matchLabels:
              strimzi.io/cluster: kafka-production
      ports:
        - protocol: TCP
          port: 9090
        - protocol: TCP
          port: 9091
        - protocol: TCP
          port: 9092
        - protocol: TCP
          port: 9093
    # DNS
    - to: []
      ports:
        - protocol: UDP
          port: 53
```

---

## Section 14: Operational Runbook Reference

### Check Consumer Group Offsets and Lag

```bash
# List all consumer groups
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --list

# Describe a specific consumer group
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --describe \
    --group orders-processing-group
```

### Reassign Partitions Manually

```bash
# Generate a reassignment plan for specific topics
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-reassign-partitions.sh \
    --bootstrap-server localhost:9092 \
    --topics-to-move-json-file /tmp/topics.json \
    --broker-list "0,1,2" \
    --generate

# Execute the reassignment
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-reassign-partitions.sh \
    --bootstrap-server localhost:9092 \
    --reassignment-json-file /tmp/reassignment.json \
    --execute

# Verify reassignment completed
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-reassign-partitions.sh \
    --bootstrap-server localhost:9092 \
    --reassignment-json-file /tmp/reassignment.json \
    --verify
```

### Delete a Consumer Group

```bash
# Safe to do only when all consumers in the group are stopped
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --delete \
    --group stale-consumer-group
```

### Produce and Consume Test Messages

```bash
# Produce test messages
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-console-producer.sh \
    --bootstrap-server localhost:9092 \
    --topic orders \
    --property "parse.key=true" \
    --property "key.separator=:" <<EOF
order-1:{"order_id":"1","amount":99.99}
order-2:{"order_id":"2","amount":149.99}
EOF

# Consume messages from beginning
kubectl exec -n messaging kafka-production-kafka-0 -- \
  bin/kafka-console-consumer.sh \
    --bootstrap-server localhost:9092 \
    --topic orders \
    --from-beginning \
    --max-messages 10 \
    --property print.key=true \
    --property key.separator=":"
```

Strimzi transforms the operational complexity of Apache Kafka into a set of composable, Kubernetes-native custom resources. KRaft mode eliminates ZooKeeper from the dependency chain, Cruise Control automates partition balancing, Mirror Maker 2 provides cross-cluster DR replication, and the Entity Operator manages topics and users as code. Integrated Prometheus JMX metrics with consumer group lag exported by kafka-exporter provide the observability required to operate production event streaming at scale.
