---
title: "Kubernetes Strimzi Kafka Operator: Event Streaming Infrastructure on Kubernetes"
date: 2031-05-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kafka", "Strimzi", "Event Streaming", "Operators", "Prometheus", "Grafana"]
categories:
- Kubernetes
- Messaging
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Strimzi Kafka Operator covering Kafka/KafkaTopic/KafkaUser CRDs, TLS and SCRAM authentication, MirrorMaker2 cross-cluster replication, Kafka Connect, cruise-control rebalancing, and Prometheus/Grafana monitoring."
more_link: "yes"
url: "/kubernetes-strimzi-kafka-operator-event-streaming/"
---

Running Apache Kafka on Kubernetes without an operator is a mistake most infrastructure teams make once. Manual StatefulSet management, rolling upgrades across brokers, partition reassignment during topology changes, TLS certificate rotation — each of these is a weekend project. Strimzi makes all of it declarative. You describe the desired Kafka cluster state, and the operator handles the operational complexity.

This guide covers a complete production Kafka deployment with Strimzi, from initial cluster creation through MirrorMaker2 cross-region replication, Kafka Connect, cruise-control-based rebalancing, and a monitoring stack that provides genuine operational visibility.

<!--more-->

# Kubernetes Strimzi Kafka Operator: Event Streaming Infrastructure on Kubernetes

## Section 1: Strimzi Architecture and Installation

### 1.1 Core Components

Strimzi introduces these CRDs for managing Kafka infrastructure:

- **Kafka**: The Kafka cluster (brokers + ZooKeeper or KRaft)
- **KafkaTopic**: Individual Kafka topics
- **KafkaUser**: Kafka users with ACL permissions
- **KafkaConnect**: Kafka Connect clusters for source/sink connectors
- **KafkaMirrorMaker2**: Cross-cluster replication
- **KafkaBridge**: HTTP bridge for Kafka
- **KafkaRebalance**: Cruise Control rebalancing requests
- **KafkaNodePool**: Node pools for heterogeneous broker configurations (Strimzi 0.36+)

### 1.2 Installing Strimzi

```bash
# Option 1: Install via OperatorHub (OLM)
kubectl create -f https://operatorhub.io/install/strimzi-kafka-operator.yaml

# Option 2: Install via Helm (recommended for production)
helm repo add strimzi https://strimzi.io/charts/
helm repo update

# Create namespace
kubectl create namespace kafka

# Install with custom values
helm install strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace kafka \
  --version 0.41.0 \
  --set watchNamespaces="{kafka,kafka-staging}" \
  --set logLevel=INFO \
  --set fullReconciliationIntervalMs=120000 \
  --set operationTimeoutMs=300000 \
  --set featureGates="+KafkaNodePools,+UseKRaft" \
  --wait

# Verify operator is running
kubectl get deployment strimzi-cluster-operator -n kafka
kubectl get crd | grep strimzi
```

## Section 2: Production Kafka Cluster Deployment

### 2.1 KRaft Mode (Kafka without ZooKeeper)

KRaft is stable in Strimzi 0.36+ and recommended for new deployments:

```yaml
# kafka-cluster-kraft.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: controller
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  replicas: 3
  roles:
    - controller
  storage:
    type: persistent-claim
    size: 20Gi
    class: fast-ssd
    deleteClaim: false
  resources:
    requests:
      memory: 4Gi
      cpu: "1"
    limits:
      memory: 4Gi
      cpu: "2"
  template:
    pod:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: strimzi.io/pool-name
                    operator: In
                    values: ["controller"]
              topologyKey: kubernetes.io/hostname
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: broker
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  replicas: 6
  roles:
    - broker
  storage:
    type: persistent-claim
    size: 500Gi
    class: fast-ssd
    deleteClaim: false
  resources:
    requests:
      memory: 16Gi
      cpu: "4"
    limits:
      memory: 16Gi
      cpu: "8"
  jvmOptions:
    -Xms: 8192m
    -Xmx: 8192m
    gcLoggingEnabled: false
    javaSystemProperties:
      - name: com.sun.jndi.rmiURLParsingDisabled
        value: "true"
  template:
    pod:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: strimzi.io/pool-name
                    operator: In
                    values: ["broker"]
              topologyKey: kubernetes.io/hostname
      tolerations:
        - key: "dedicated"
          operator: "Equal"
          value: "kafka"
          effect: "NoSchedule"
---
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: production-kafka
  namespace: kafka
  annotations:
    strimzi.io/node-pools: enabled
    strimzi.io/kraft: enabled
spec:
  kafka:
    version: 3.7.0
    metadataVersion: "3.7"

    # Listeners configuration
    listeners:
      # Internal TLS listener for pod-to-pod
      - name: tls
        port: 9093
        type: internal
        tls: true
        authentication:
          type: tls
      # SASL/SCRAM for application clients
      - name: scram
        port: 9094
        type: internal
        tls: true
        authentication:
          type: scram-sha-512
      # External LoadBalancer for external clients
      - name: external
        port: 9095
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
            secretName: kafka-external-tls
            certificate: tls.crt
            key: tls.key

    # Kafka broker configuration
    config:
      # Replication defaults
      default.replication.factor: 3
      min.insync.replicas: 2
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      transaction.state.log.min.isr: 2

      # Performance tuning
      num.network.threads: 8
      num.io.threads: 16
      socket.send.buffer.bytes: 1048576
      socket.receive.buffer.bytes: 1048576
      socket.request.max.bytes: 104857600
      num.partitions: 12
      num.recovery.threads.per.data.dir: 4

      # Log compaction
      log.retention.hours: 168        # 7 days default
      log.segment.bytes: 1073741824   # 1GB segments
      log.cleanup.policy: delete
      log.cleaner.enable: true
      log.cleaner.threads: 2

      # Compression
      compression.type: lz4

      # Topic auto-creation (disable in production)
      auto.create.topics.enable: false

      # Transaction settings
      transaction.max.timeout.ms: 900000   # 15 minutes
      transactional.id.expiration.ms: 604800000  # 7 days

      # Quotas for consumer groups
      quota.window.size.seconds: 1
      quota.window.num: 11

    # Broker TLS
    authorization:
      type: simple
      superUsers:
        - User:kafka-admin

    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: kafka-metrics-config
          key: kafka-metrics-config.yml

  # Cruise Control for automated rebalancing
  cruiseControl:
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: cruise-control-metrics-config
          key: cruise-control-metrics-config.yml
    config:
      hard.goals: >
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.DiskCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkInboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkOutboundCapacityGoal
      default.goals: >
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.DiskCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkInboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkOutboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.CpuCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.PotentialNwOutGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.DiskUsageDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkInboundUsageDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkOutboundUsageDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.CpuUsageDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.TopicReplicaDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.LeaderReplicaDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.LeaderBytesInDistributionGoal

  entityOperator:
    topicOperator:
      resources:
        requests:
          cpu: 100m
          memory: 512Mi
        limits:
          cpu: 500m
          memory: 1Gi
    userOperator:
      resources:
        requests:
          cpu: 100m
          memory: 512Mi
        limits:
          cpu: 500m
          memory: 1Gi
```

## Section 3: TLS and SCRAM Authentication

### 3.1 TLS Client Authentication

```yaml
# kafka-user-tls.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: payment-service
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  authentication:
    type: tls
  authorization:
    type: simple
    acls:
      # Producer ACLs
      - resource:
          type: topic
          name: payments
          patternType: literal
        operations:
          - Create
          - Write
          - Describe
        host: "*"
      # Consumer group ACL
      - resource:
          type: group
          name: payment-consumers
          patternType: literal
        operations:
          - Read
        host: "*"
      # Transactional ID for exactly-once semantics
      - resource:
          type: transactionalId
          name: payment-service-txn
          patternType: literal
        operations:
          - Describe
          - Write
        host: "*"
```

The Strimzi User Operator creates a Secret with the TLS certificate and key:

```bash
# Get the TLS secret
kubectl get secret payment-service -n kafka -o yaml

# Extract the CA certificate and user certificate for your application
kubectl get secret payment-service -n kafka \
  -o jsonpath='{.data.user\.crt}' | base64 -d > user.crt
kubectl get secret payment-service -n kafka \
  -o jsonpath='{.data.user\.key}' | base64 -d > user.key
kubectl get secret production-kafka-cluster-ca-cert -n kafka \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > ca.crt

# Create a Java keystore (for JVM-based clients)
openssl pkcs12 -export \
  -in user.crt \
  -inkey user.key \
  -out user.p12 \
  -passout pass:keystorepassword

keytool -importkeystore \
  -deststorepass keystorepassword \
  -destkeypass keystorepassword \
  -destkeystore user.jks \
  -srckeystore user.p12 \
  -srcstoretype PKCS12 \
  -srcstorepass keystorepassword

# Import CA cert to truststore
keytool -import \
  -trustcacerts \
  -file ca.crt \
  -alias ca \
  -storepass truststorepassword \
  -noprompt \
  -keystore truststore.jks
```

### 3.2 SCRAM-SHA-512 Authentication

```yaml
# kafka-user-scram.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: order-service
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  authentication:
    type: scram-sha-512
    # Optional: manage password externally
    # password:
    #   valueFrom:
    #     secretKeyRef:
    #       name: order-service-kafka-password
    #       key: password
  authorization:
    type: simple
    acls:
      - resource:
          type: topic
          name: orders
          patternType: literal
        operations:
          - Write
          - Describe
      - resource:
          type: topic
          name: orders-dlq
          patternType: literal
        operations:
          - Write
          - Describe
      - resource:
          type: group
          name: order-consumers-
          patternType: prefix
        operations:
          - Read
          - Describe
```

```bash
# Get SCRAM credentials
kubectl get secret order-service -n kafka \
  -o jsonpath='{.data.password}' | base64 -d
# Output: randomly generated password
```

Using SCRAM credentials in a producer:

```go
// go-kafka-producer/main.go
package main

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "os"

    "github.com/twmb/franz-go/pkg/kgo"
    "github.com/twmb/franz-go/pkg/sasl/scram"
)

func newKafkaClient() (*kgo.Client, error) {
    // Load CA certificate
    caCert, err := os.ReadFile("/etc/kafka-certs/ca.crt")
    if err != nil {
        return nil, fmt.Errorf("reading CA cert: %w", err)
    }

    caCertPool := x509.NewCertPool()
    caCertPool.AppendCertsFromPEM(caCert)

    tlsConfig := &tls.Config{
        RootCAs:    caCertPool,
        MinVersion: tls.VersionTLS12,
    }

    // SCRAM-SHA-512 authentication
    password := os.Getenv("KAFKA_PASSWORD")
    mechanism := scram.Auth{
        User: "order-service",
        Pass: password,
    }.AsSha512Mechanism()

    client, err := kgo.NewClient(
        kgo.SeedBrokers("production-kafka-kafka-bootstrap.kafka.svc.cluster.local:9094"),
        kgo.SASL(mechanism),
        kgo.DialTLSConfig(tlsConfig),
        kgo.DefaultProduceTopic("orders"),
        kgo.ProduceRequestTimeout(30 * time.Second),
        kgo.RecordRetries(5),
        kgo.RequiredAcks(kgo.AllISRAcks()),
        kgo.DisableIdempotentWrite(),
    )
    if err != nil {
        return nil, fmt.Errorf("creating kafka client: %w", err)
    }

    return client, nil
}
```

## Section 4: KafkaTopic Management

```yaml
# kafka-topics.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  partitions: 24
  replicas: 3
  config:
    # Retention
    retention.ms: "604800000"     # 7 days
    retention.bytes: "10737418240" # 10GB per partition
    # Segment settings
    segment.ms: "86400000"        # 24-hour segments
    segment.bytes: "1073741824"   # 1GB max segment
    # Cleanup
    cleanup.policy: delete
    # Compression
    compression.type: lz4
    # Min ISR
    min.insync.replicas: "2"
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders-dlq
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  partitions: 6
  replicas: 3
  config:
    # Longer retention for DLQ for investigation
    retention.ms: "2592000000"    # 30 days
    cleanup.policy: delete
    min.insync.replicas: "2"
---
# Compacted topic for user state
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: user-state
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  partitions: 12
  replicas: 3
  config:
    cleanup.policy: compact
    # For compact + delete (compact then delete old segments)
    # cleanup.policy: "compact,delete"
    min.cleanable.dirty.ratio: "0.1"
    segment.ms: "86400000"
    delete.retention.ms: "86400000"
    min.insync.replicas: "2"
```

## Section 5: MirrorMaker2 for Cross-Cluster Replication

MirrorMaker2 provides active-active and active-passive Kafka replication:

```yaml
# kafka-mirrormaker2.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: mm2-us-east-to-eu-west
  namespace: kafka
spec:
  version: 3.7.0
  replicas: 3

  # Source cluster (US East)
  clusters:
    - alias: us-east
      bootstrapServers: production-kafka-kafka-bootstrap.kafka-us-east.svc.cluster.local:9093
      tls:
        trustedCertificates:
          - secretName: kafka-us-east-cluster-ca-cert
            certificate: ca.crt
      authentication:
        type: scram-sha-512
        username: mirrormaker
        passwordSecret:
          secretName: mirrormaker-us-east-credentials
          password: password

    # Target cluster (EU West)
    - alias: eu-west
      bootstrapServers: production-kafka-kafka-bootstrap.kafka-eu-west.svc.cluster.local:9093
      tls:
        trustedCertificates:
          - secretName: kafka-eu-west-cluster-ca-cert
            certificate: ca.crt
      authentication:
        type: scram-sha-512
        username: mirrormaker
        passwordSecret:
          secretName: mirrormaker-eu-west-credentials
          password: password

  mirrors:
    - sourceCluster: us-east
      targetCluster: eu-west
      # Topics to replicate (regex)
      topicsPattern: "orders.*|payments.*|user-state"
      # Groups to sync offsets for
      groupsPattern: "order-consumers.*|payment-consumers.*"
      sourceConnector:
        config:
          replication.factor: 3
          offset-syncs.topic.replication.factor: 3
          # Preserve consumer group offsets
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: "60"
          # Don't replicate MM2's internal topics back
          emit.heartbeats.enabled: "true"
          emit.checkpoints.enabled: "true"
          # Exactly-once semantics
          exactly.once.support: enabled
          tasks.max: "8"
      checkpointConnector:
        config:
          checkpoints.topic.replication.factor: 3
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: "60"
          emit.checkpoints.interval.seconds: "10"
          tasks.max: "3"
      heartbeatConnector:
        config:
          heartbeats.topic.replication.factor: 3

  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      cpu: "2"
      memory: 4Gi
```

### 5.1 Monitoring MirrorMaker2 Replication Lag

```bash
# Check MirrorMaker2 status
kubectl get kafkamirrormaker2 -n kafka

# Check connector status
kubectl exec -n kafka deploy/mm2-us-east-to-eu-west -- \
  curl -s http://localhost:8083/connectors | jq .

kubectl exec -n kafka deploy/mm2-us-east-to-eu-west -- \
  curl -s http://localhost:8083/connectors/us-east->eu-west.MirrorSourceConnector/status | jq .

# Check replication lag
# In the target cluster, use the mirrored __consumer_offsets topic
kubectl exec -n kafka production-kafka-broker-0 -- \
  kafka-consumer-groups.sh \
  --bootstrap-server localhost:9093 \
  --describe \
  --group us-east.order-consumers.main
```

## Section 6: Kafka Connect Cluster Deployment

```yaml
# kafka-connect.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnect
metadata:
  name: production-connect
  namespace: kafka
  annotations:
    strimzi.io/use-connector-resources: "true"
spec:
  version: 3.7.0
  replicas: 3

  # Bootstrap using TLS + SCRAM
  bootstrapServers: production-kafka-kafka-bootstrap.kafka.svc.cluster.local:9094
  tls:
    trustedCertificates:
      - secretName: production-kafka-cluster-ca-cert
        certificate: ca.crt
  authentication:
    type: scram-sha-512
    username: kafka-connect
    passwordSecret:
      secretName: kafka-connect-credentials
      password: password

  # Custom image with additional connectors
  image: registry.corp.example.com/kafka-connect-custom:3.7.0-v1

  config:
    group.id: production-connect-cluster
    offset.storage.topic: connect-offsets
    config.storage.topic: connect-configs
    status.storage.topic: connect-status
    offset.storage.replication.factor: 3
    config.storage.replication.factor: 3
    status.storage.replication.factor: 3
    # Schema registry
    key.converter: io.confluent.kafka.serializers.KafkaAvroSerializer
    value.converter: io.confluent.kafka.serializers.KafkaAvroSerializer
    key.converter.schema.registry.url: http://schema-registry.kafka.svc.cluster.local:8081
    value.converter.schema.registry.url: http://schema-registry.kafka.svc.cluster.local:8081

  resources:
    requests:
      cpu: "1"
      memory: 2Gi
    limits:
      cpu: "4"
      memory: 8Gi

  jvmOptions:
    -Xms: 2048m
    -Xmx: 2048m

  metricsConfig:
    type: jmxPrometheusExporter
    valueFrom:
      configMapKeyRef:
        name: connect-metrics-config
        key: metrics-config.yml

  build:
    output:
      type: docker
      image: registry.corp.example.com/kafka-connect-custom:latest
      pushSecret: registry-pull-secret
    plugins:
      - name: debezium-postgres
        artifacts:
          - type: maven
            artifact: io.debezium:debezium-connector-postgresql:2.6.0.Final
      - name: s3-sink
        artifacts:
          - type: maven
            artifact: io.confluent:kafka-connect-s3:10.5.7
      - name: jdbc-sink
        artifacts:
          - type: maven
            artifact: io.confluent:kafka-connect-jdbc:10.7.4
---
# KafkaConnector: PostgreSQL CDC with Debezium
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: postgres-cdc-orders
  namespace: kafka
  labels:
    strimzi.io/cluster: production-connect
spec:
  class: io.debezium.connector.postgresql.PostgresConnector
  tasksMax: 1
  config:
    database.hostname: postgres.production.svc.cluster.local
    database.port: "5432"
    database.user: debezium
    database.password: "${file:/opt/kafka/external-configuration/postgres-credentials/password}"
    database.dbname: "orders"
    database.server.name: orders-db
    schema.include.list: public
    table.include.list: "public.orders,public.order_items"
    plugin.name: pgoutput
    publication.name: dbz_publication
    slot.name: debezium_slot
    topic.prefix: cdc
    # Outbox pattern support
    transforms: outbox
    transforms.outbox.type: io.debezium.transforms.outbox.EventRouter
    transforms.outbox.table.fields.additional.placement: aggregate_type:header:aggregate_type
    key.converter: org.apache.kafka.connect.json.JsonConverter
    value.converter: org.apache.kafka.connect.json.JsonConverter
```

## Section 7: Cruise Control Rebalancing

Cruise Control analyzes broker load and optimizes partition distribution:

```yaml
# kafka-rebalance.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: full-rebalance-2031-q2
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
  annotations:
    # Approve the rebalance after reviewing the proposal
    strimzi.io/rebalance: approve  # or "refresh" to generate new proposal
spec:
  mode: full
  goals:
    - ReplicaCapacityGoal
    - DiskCapacityGoal
    - NetworkInboundCapacityGoal
    - NetworkOutboundCapacityGoal
    - CpuCapacityGoal
    - ReplicaDistributionGoal
    - PotentialNwOutGoal
    - DiskUsageDistributionGoal
    - NetworkInboundUsageDistributionGoal
    - NetworkOutboundUsageDistributionGoal
    - TopicReplicaDistributionGoal
    - LeaderReplicaDistributionGoal
    - LeaderBytesInDistributionGoal
  skipHardGoalCheck: false
  # Limit concurrent partition movements
  concurrentPartitionMovementsPerBroker: 5
  concurrentIntraBrokerPartitionMovements: 2
  concurrentLeaderMovements: 1000
  replicationThrottle: 524288000  # 500MB/s max replication bandwidth
```

```bash
# Monitor rebalance progress
kubectl get kafkarebalance full-rebalance-2031-q2 -n kafka -o yaml

# Check rebalance status
kubectl get kafkarebalance -n kafka
# NAME                    CLUSTER             PENDINGPROPOSAL   PROPOSALREADY   REBALANCING   READY
# full-rebalance-2031-q2  production-kafka                      true

# Approve the rebalance (after reviewing)
kubectl annotate kafkarebalance full-rebalance-2031-q2 \
  -n kafka \
  strimzi.io/rebalance=approve

# Stop a running rebalance
kubectl annotate kafkarebalance full-rebalance-2031-q2 \
  -n kafka \
  strimzi.io/rebalance=stop
```

## Section 8: Prometheus and Grafana Monitoring

### 8.1 JMX Exporter Configuration

```yaml
# kafka-metrics-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-metrics-config
  namespace: kafka
data:
  kafka-metrics-config.yml: |
    lowercaseOutputName: true
    lowercaseOutputLabelNames: true
    rules:
      # Broker metrics
      - pattern: 'kafka.server<type=(.+), name=(.+), clientId=(.+), topic=(.+), partition=(.*)><>Value'
        name: kafka_server_$1_$2
        type: GAUGE
        labels:
          clientId: "$3"
          topic: "$4"
          partition: "$5"
      - pattern: 'kafka.server<type=(.+), name=(.+), clientId=(.+), brokerHost=(.+), brokerPort=(.+)><>Value'
        name: kafka_server_$1_$2
        type: GAUGE
        labels:
          clientId: "$3"
          broker: "$4:$5"
      # Request metrics
      - pattern: 'kafka.network<type=RequestMetrics, name=RequestsPerSec, request=(.+)><>OneMinuteRate'
        name: kafka_network_requestmetrics_requestspersec
        type: GAUGE
        labels:
          request: "$1"
      # ReplicaManager
      - pattern: 'kafka.server<type=ReplicaManager, name=(.+)><>(Value|Count)'
        name: kafka_server_replicamanager_$1
        type: GAUGE
      # LogManager
      - pattern: 'kafka.log<type=LogManager, name=(.+)><>(Value|Count)'
        name: kafka_log_logmanager_$1
        type: GAUGE
      # Consumer lag
      - pattern: 'kafka.consumer<type=(.+), client-id=(.+)><>(.+):'
        name: kafka_consumer_$1_$3
        type: GAUGE
        labels:
          client_id: "$2"
      # Producer metrics
      - pattern: 'kafka.producer<type=ProducerMetrics, client-id=(.+)><>(.+):'
        name: kafka_producer_$2
        type: GAUGE
        labels:
          client_id: "$1"
```

### 8.2 PodMonitor for Scraping

```yaml
# pod-monitor-kafka.yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: kafka-cluster-monitor
  namespace: kafka
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      strimzi.io/cluster: production-kafka
  podMetricsEndpoints:
    - path: /metrics
      port: tcp-prometheus
      interval: 30s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_label_strimzi_io_pool_name]
          targetLabel: pool
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
```

### 8.3 Critical Prometheus Alerts

```yaml
# prometheus-rules-kafka.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kafka-alerts
  namespace: kafka
spec:
  groups:
    - name: kafka.critical
      rules:
        - alert: KafkaBrokerDown
          expr: count(up{job="kafka-cluster-monitor"}) by (cluster) < 3
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Kafka broker count below minimum in cluster {{ $labels.cluster }}"

        - alert: KafkaUnderReplicatedPartitions
          expr: kafka_server_replicamanager_underreplicatedpartitions > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "{{ $value }} under-replicated partitions on {{ $labels.pod }}"
            description: "Under-replicated partitions indicate broker health issues or lag"

        - alert: KafkaISRShrink
          expr: rate(kafka_server_replicamanager_isrshrinks_total[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Kafka ISR shrinking on {{ $labels.pod }}"

        - alert: KafkaConsumerGroupLag
          expr: |
            kafka_consumer_group_lag_sum > 100000
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Consumer group {{ $labels.group }} lag > 100k on topic {{ $labels.topic }}"

        - alert: KafkaOfflinePartitions
          expr: kafka_controller_kafkacontroller_offlinepartitionscount > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "{{ $value }} offline partitions in Kafka cluster"

        - alert: KafkaBrokerDiskUsageHigh
          expr: |
            (
              kubelet_volume_stats_used_bytes{namespace="kafka"}
              /
              kubelet_volume_stats_capacity_bytes{namespace="kafka"}
            ) > 0.80
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kafka broker disk usage above 80% on {{ $labels.pod }}"

    - name: kafka.mirrormaker2
      rules:
        - alert: MirrorMaker2ReplicationLag
          expr: |
            kafka_mirrormaker2_connector_replication_latency_ms > 30000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "MirrorMaker2 replication lag > 30s"
```

### 8.4 Grafana Dashboard Provisioning

```yaml
# grafana-dashboards-kafka.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-grafana-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  kafka-overview.json: |
    {
      "title": "Kafka Overview",
      "uid": "kafka-overview",
      "panels": [
        {
          "title": "Broker Count",
          "type": "stat",
          "targets": [{
            "expr": "count(up{job=~\".*kafka.*\"} == 1)"
          }]
        },
        {
          "title": "Under-Replicated Partitions",
          "type": "stat",
          "targets": [{
            "expr": "sum(kafka_server_replicamanager_underreplicatedpartitions)"
          }],
          "thresholds": {
            "steps": [
              {"color": "green", "value": 0},
              {"color": "red", "value": 1}
            ]
          }
        },
        {
          "title": "Consumer Group Lag by Group",
          "type": "timeseries",
          "targets": [{
            "expr": "sum by(group) (kafka_consumer_group_lag_sum)",
            "legendFormat": "{{group}}"
          }]
        },
        {
          "title": "Messages Per Second by Topic",
          "type": "timeseries",
          "targets": [{
            "expr": "sum by(topic) (rate(kafka_server_brokertopicmetrics_messagesin_total[5m]))",
            "legendFormat": "{{topic}}"
          }]
        }
      ]
    }
```

## Section 9: Cluster Upgrades

Strimzi manages rolling upgrades of Kafka brokers automatically:

```bash
# Check current Kafka version
kubectl get kafka production-kafka -n kafka -o jsonpath='{.spec.kafka.version}'

# Update to new version (edit the Kafka resource)
kubectl patch kafka production-kafka -n kafka --type merge -p '
{
  "spec": {
    "kafka": {
      "version": "3.8.0",
      "metadataVersion": "3.8"
    }
  }
}'

# Watch the rolling upgrade
kubectl get pods -n kafka -l strimzi.io/cluster=production-kafka -w

# Strimzi will:
# 1. Roll each broker pod one at a time
# 2. Wait for each broker to rejoin the ISR before continuing
# 3. This is the reason min.insync.replicas = 2 with 3 replicas is critical

# Check upgrade status
kubectl describe kafka production-kafka -n kafka | grep -A 20 "Conditions"
```

Strimzi transforms Kafka from a complex manual operation into a declarative Kubernetes resource. The combination of topic-as-code via KafkaTopic CRDs, user management via KafkaUser CRDs, and automated rebalancing via Cruise Control eliminates the most time-consuming operational work while maintaining the flexibility needed for production tuning.
