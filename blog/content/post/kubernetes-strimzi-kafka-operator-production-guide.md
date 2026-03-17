---
title: "Kubernetes Strimzi Kafka Operator: Topic Management, Authentication, Mirror Maker 2, Kafka Connect, and Schema Registry"
date: 2031-12-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kafka", "Strimzi", "Kafka Connect", "Mirror Maker", "Schema Registry", "Streaming"]
categories:
- Kubernetes
- Messaging
- Data Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to running Apache Kafka on Kubernetes with Strimzi: cluster configuration, topic and user CRD management, mTLS authentication, Mirror Maker 2 for multi-cluster replication, Kafka Connect deployments, and Apicurio Schema Registry integration."
more_link: "yes"
url: "/kubernetes-strimzi-kafka-operator-production-guide/"
---

Running Apache Kafka on Kubernetes presents unique challenges: stateful broker coordination, persistent volume management, inter-broker TLS, ZooKeeper (or KRaft) quorum, and the operational complexity of multi-cluster replication. Strimzi transforms these challenges into declarative Kubernetes resources managed by operator controllers. This guide covers a production Strimzi deployment from cluster bootstrap through multi-datacenter replication with Mirror Maker 2, Kafka Connect for data pipeline integration, and schema governance with Apicurio Schema Registry.

<!--more-->

# Kubernetes Strimzi Kafka Operator: Production Guide

## Section 1: Strimzi Architecture Overview

Strimzi uses a set of operators and CRDs to manage Kafka components:

| CRD | Purpose |
|-----|---------|
| `Kafka` | Defines the Kafka cluster (brokers, ZooKeeper/KRaft, entity operator) |
| `KafkaTopic` | Manages Kafka topics declaratively |
| `KafkaUser` | Manages Kafka users with authentication and ACLs |
| `KafkaConnect` | Deploys Kafka Connect clusters |
| `KafkaMirrorMaker2` | Configures cross-cluster replication |
| `KafkaBridge` | HTTP bridge for REST-based producers/consumers |
| `KafkaNodePool` | Defines node pools for KRaft mode |
| `KafkaRebalance` | Triggers Cruise Control partition rebalancing |

The Cluster Operator watches all Kafka-related CRDs and reconciles the actual state of StatefulSets, Services, ConfigMaps, and Secrets against the desired state expressed in those CRDs.

## Section 2: Installing the Strimzi Operator

### Helm Installation

```bash
helm repo add strimzi https://strimzi.io/charts/
helm repo update

# Install the operator in a dedicated namespace
helm install strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace strimzi-system \
  --create-namespace \
  --version 0.42.0 \
  --set watchNamespaces="{kafka-prod,kafka-dev}" \
  --set logLevel=INFO \
  --set fullReconciliationIntervalMs=120000 \
  --set operationTimeoutMs=300000 \
  --set resources.requests.cpu=200m \
  --set resources.requests.memory=384Mi \
  --set resources.limits.cpu=1000m \
  --set resources.limits.memory=512Mi \
  --wait
```

Verify:

```bash
kubectl -n strimzi-system get pods
kubectl -n strimzi-system logs deploy/strimzi-cluster-operator --tail=20
kubectl get crds | grep strimzi
```

## Section 3: Production Kafka Cluster Configuration

### KRaft Mode Cluster (No ZooKeeper)

Strimzi supports KRaft mode (Kafka without ZooKeeper) since 0.36. This is the recommended approach for new deployments:

```yaml
# kafka-cluster-kraft.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: controller
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  replicas: 3
  roles:
    - controller
  storage:
    type: persistent-claim
    size: 50Gi
    class: gp3
    deleteClaim: false
  resources:
    requests:
      cpu: "500m"
      memory: "2Gi"
    limits:
      cpu: "2000m"
      memory: "4Gi"
  template:
    pod:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  strimzi.io/pool-name: controller
              topologyKey: kubernetes.io/hostname
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: broker
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  replicas: 6
  roles:
    - broker
  storage:
    type: persistent-claim
    size: 500Gi
    class: gp3-throughput
    deleteClaim: false
  resources:
    requests:
      cpu: "2000m"
      memory: "8Gi"
    limits:
      cpu: "4000m"
      memory: "16Gi"
  jvmOptions:
    -Xms: "4096m"
    -Xmx: "8192m"
    gcLoggingEnabled: false
    javaSystemProperties:
      - name: com.sun.jndi.rmi.object.trustURLCodebase
        value: "false"
  template:
    pod:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  strimzi.io/pool-name: broker
              topologyKey: kubernetes.io/hostname
      tolerations:
        - key: kafka-broker
          operator: Equal
          value: "true"
          effect: NoSchedule
---
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: prod-kafka
  namespace: kafka-prod
  annotations:
    strimzi.io/node-pools: enabled
    strimzi.io/kraft: enabled
spec:
  kafka:
    version: 3.8.0
    metadataVersion: "3.8-IV0"
    replicas: 6
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
        authentication:
          type: scram-sha-512
      - name: tls
        port: 9093
        type: internal
        tls: true
        authentication:
          type: tls
      - name: external
        port: 9094
        type: loadbalancer
        tls: true
        authentication:
          type: tls
        configuration:
          brokerCertChainAndKey:
            secretName: prod-kafka-external-tls
            certificate: tls.crt
            key: tls.key
          bootstrap:
            loadBalancerIP: ""
          brokers:
            - broker: 0
              loadBalancerIP: ""
            - broker: 1
              loadBalancerIP: ""
    config:
      # Broker performance tuning
      num.network.threads: 8
      num.io.threads: 16
      num.replica.fetchers: 4
      num.partitions: 6
      default.replication.factor: 3
      min.insync.replicas: 2
      log.retention.hours: 168
      log.retention.bytes: -1
      log.segment.bytes: 1073741824
      log.cleanup.policy: delete
      # Compression
      compression.type: lz4
      # Socket settings
      socket.send.buffer.bytes: 102400
      socket.receive.buffer.bytes: 102400
      socket.request.max.bytes: 104857600
      # Replication
      replica.socket.timeout.ms: 30000
      replica.fetch.max.bytes: 1048576
      replica.fetch.wait.max.ms: 500
      # Network settings
      connections.max.idle.ms: 600000
      request.timeout.ms: 30000
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: kafka-metrics-config
          key: kafka-metrics-config.yml
    rack:
      topologyKey: topology.kubernetes.io/zone
    logging:
      type: inline
      loggers:
        kafka.root.logger.level: INFO
        log4j.logger.kafka: INFO
        log4j.logger.kafka.controller: INFO
        log4j.logger.kafka.log.LogCleaner: INFO
        log4j.logger.state.change.logger: INFO
  entityOperator:
    topicOperator:
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          cpu: 500m
          memory: 512Mi
      reconciliationIntervalSeconds: 30
      topicMetadataMaxAttempts: 6
    userOperator:
      resources:
        requests:
          cpu: 100m
          memory: 256Mi
        limits:
          cpu: 500m
          memory: 512Mi
      reconciliationIntervalSeconds: 30
  cruiseControl:
    config:
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
    resources:
      requests:
        cpu: 200m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 1Gi
```

Apply the cluster:

```bash
kubectl -n kafka-prod apply -f kafka-cluster-kraft.yaml

# Monitor cluster readiness
kubectl -n kafka-prod wait kafka/prod-kafka \
  --for=condition=Ready \
  --timeout=300s

# Check the cluster status
kubectl -n kafka-prod get kafka prod-kafka -o jsonpath='{.status.conditions}' | python3 -m json.tool
```

## Section 4: Topic Management with KafkaTopic CRDs

### Production Topic Configuration

```yaml
# kafka-topics.yaml
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders-events
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  partitions: 24
  replicas: 3
  config:
    min.insync.replicas: "2"
    retention.ms: "604800000"       # 7 days
    retention.bytes: "-1"
    segment.bytes: "1073741824"     # 1GB segments
    cleanup.policy: delete
    compression.type: lz4
    message.timestamp.type: CreateTime
    # Mirroring compatibility
    message.format.version: "3.8-IV0"
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders-dlq
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  partitions: 6
  replicas: 3
  config:
    min.insync.replicas: "2"
    retention.ms: "2592000000"      # 30 days for DLQ
    retention.bytes: "107374182400" # 100GB cap
    cleanup.policy: delete
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: user-profiles
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  partitions: 12
  replicas: 3
  config:
    min.insync.replicas: "2"
    cleanup.policy: compact
    min.cleanable.dirty.ratio: "0.5"
    segment.ms: "86400000"          # Compact at least daily
    delete.retention.ms: "86400000"
    retention.ms: "-1"              # Infinite retention for compacted topics
```

### Topic Admission Validation

Use OPA/Gatekeeper to enforce topic naming and configuration standards:

```yaml
# opa-kafka-topic-policy.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: KafkaTopicNamingConstraint
metadata:
  name: kafka-topic-naming-convention
spec:
  match:
    kinds:
      - apiGroups: ["kafka.strimzi.io"]
        kinds: ["KafkaTopic"]
  parameters:
    allowedPrefixes:
      - "orders-"
      - "users-"
      - "payments-"
      - "notifications-"
      - "audit-"
    requiredMinInsyncReplicas: "2"
    maxRetentionDays: 30
```

## Section 5: User Authentication and ACLs

### mTLS Certificate-Based Authentication

```yaml
# kafka-tls-user.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: orders-producer
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  authentication:
    type: tls
  authorization:
    type: simple
    acls:
      # Allow producing to orders-events
      - resource:
          type: topic
          name: orders-events
          patternType: literal
        operations:
          - Write
          - Describe
        host: "*"
      # Allow transactional writes
      - resource:
          type: transactionalId
          name: orders-producer-txn
          patternType: prefix
        operations:
          - Write
          - Describe
        host: "*"
      # Allow cluster-level operations for idempotent producer
      - resource:
          type: cluster
          name: kafka-cluster
        operations:
          - IdempotentWrite
        host: "*"
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: orders-consumer-group
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  authentication:
    type: tls
  authorization:
    type: simple
    acls:
      # Allow consuming from orders-events
      - resource:
          type: topic
          name: orders-events
          patternType: literal
        operations:
          - Read
          - Describe
        host: "*"
      # Allow consumer group operations
      - resource:
          type: group
          name: orders-processor
          patternType: literal
        operations:
          - Read
          - Describe
          - Delete
        host: "*"
      # Allow access to consumer offsets
      - resource:
          type: topic
          name: __consumer_offsets
          patternType: literal
        operations:
          - Read
          - Describe
        host: "*"
```

### SCRAM-SHA-512 Password Authentication

```yaml
# kafka-scram-user.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: analytics-reader
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
spec:
  authentication:
    type: scram-sha-512
    # Password is auto-generated in a Secret named analytics-reader
    # Or specify an existing secret:
    # password:
    #   valueFrom:
    #     secretKeyRef:
    #       name: analytics-reader-password
    #       key: password
  authorization:
    type: simple
    acls:
      - resource:
          type: topic
          name: ""
          patternType: prefix   # All topics
        operations:
          - Read
          - Describe
        host: "*"
      - resource:
          type: group
          name: analytics-
          patternType: prefix   # All consumer groups with analytics- prefix
        operations:
          - Read
          - Describe
        host: "*"
```

Retrieve generated credentials:

```bash
# Get TLS certificate for mTLS user
kubectl -n kafka-prod get secret orders-producer \
  -o jsonpath='{.data.user\.crt}' | base64 -d > orders-producer.crt
kubectl -n kafka-prod get secret orders-producer \
  -o jsonpath='{.data.user\.key}' | base64 -d > orders-producer.key
kubectl -n kafka-prod get secret orders-producer \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > kafka-cluster-ca.crt

# Create a JKS keystore for Java clients
openssl pkcs12 -export \
  -in orders-producer.crt \
  -inkey orders-producer.key \
  -chain -CAfile kafka-cluster-ca.crt \
  -name orders-producer \
  -out orders-producer.p12 \
  -passout pass:<keystore-password>

keytool -importkeystore \
  -srckeystore orders-producer.p12 \
  -srcstoretype PKCS12 \
  -srcstorepass <keystore-password> \
  -deststorekey orders-producer.p12 \
  -destkeystore orders-producer.jks \
  -deststoretype JKS \
  -deststorepass <keystore-password>

# Get SCRAM password
kubectl -n kafka-prod get secret analytics-reader \
  -o jsonpath='{.data.password}' | base64 -d
```

## Section 6: Mirror Maker 2 — Multi-Cluster Replication

Mirror Maker 2 (MM2) provides active-active and active-passive Kafka cluster replication using Kafka Connect internally.

### Active-Passive Replication (DR)

```yaml
# mirror-maker-2-dr.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: prod-to-dr
  namespace: kafka-prod
spec:
  version: 3.8.0
  replicas: 3
  connectCluster: "prod-dr"
  clusters:
    - alias: "prod"
      bootstrapServers: prod-kafka-kafka-bootstrap.kafka-prod.svc.cluster.local:9093
      tls:
        trustedCertificates:
          - secretName: prod-kafka-cluster-ca-cert
            certificate: ca.crt
      authentication:
        type: tls
        certificateAndKey:
          secretName: mm2-prod-source-user
          certificate: user.crt
          key: user.key
    - alias: "prod-dr"
      bootstrapServers: dr-kafka-kafka-bootstrap.kafka-dr.svc.cluster.local:9093
      tls:
        trustedCertificates:
          - secretName: dr-kafka-cluster-ca-cert
            certificate: ca.crt
      authentication:
        type: tls
        certificateAndKey:
          secretName: mm2-dr-target-user
          certificate: user.crt
          key: user.key
  mirrors:
    - sourceCluster: "prod"
      targetCluster: "prod-dr"
      sourceConnector:
        config:
          # Topics to replicate (regex)
          topics: "orders-.*,payments-.*,users-.*"
          # Exclude internal/system topics
          topics.exclude: "__.*,.*\\.internal,.*-changelog,.*-repartition"
          # Replication factor for mirrored topics
          replication.factor: "3"
          offset-syncs.topic.replication.factor: "3"
          # Sync consumer group offsets
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: "30"
          # Preserve original timestamps
          use.incremental.alter.configs: "dynamic"
          # Producer settings for high throughput
          producer.override.batch.size: "32768"
          producer.override.linger.ms: "5"
          producer.override.compression.type: "lz4"
          # Consumer settings
          consumer.auto.offset.reset: earliest
      checkpointConnector:
        config:
          checkpoints.topic.replication.factor: "3"
          sync.group.offsets.enabled: "true"
          sync.group.offsets.interval.seconds: "30"
          groups: "orders-processor,payments-processor,users-sync"
          groups.exclude: "__.*"
          # Emit checkpoints to the target
          emit.checkpoints.enabled: "true"
          emit.checkpoints.interval.seconds: "60"
      topicsPattern: "orders-.*|payments-.*|users-.*"
      groupsPattern: "orders-.*|payments-.*|users-.*"
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2000m"
      memory: "2Gi"
  logging:
    type: inline
    loggers:
      connect.root.logger.level: INFO
  jvmOptions:
    -Xms: "512m"
    -Xmx: "1024m"
  metricsConfig:
    type: jmxPrometheusExporter
    valueFrom:
      configMapKeyRef:
        name: kafka-connect-metrics-config
        key: metrics-config.yml
```

Monitor replication lag:

```bash
# Check MM2 status
kubectl -n kafka-prod get kafkamirrormaker2 prod-to-dr -o yaml | \
  python3 -c "
import sys, yaml
data = yaml.safe_load(sys.stdin)
conditions = data.get('status', {}).get('conditions', [])
for c in conditions:
    print(f'{c[\"type\"]}: {c[\"status\"]} - {c.get(\"message\",\"\")}')
"

# Check connector status via Kafka Connect REST API
kubectl -n kafka-prod port-forward svc/prod-to-dr-mirrormaker2-api 8083:8083 &
curl -s http://localhost:8083/connectors | python3 -m json.tool
curl -s http://localhost:8083/connectors/prod->prod-dr.MirrorSourceConnector/status | python3 -m json.tool
```

## Section 7: Kafka Connect — Data Pipeline Integration

### Deploying a Kafka Connect Cluster

```yaml
# kafka-connect.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnect
metadata:
  name: prod-connect
  namespace: kafka-prod
  annotations:
    strimzi.io/use-connector-resources: "true"
spec:
  version: 3.8.0
  replicas: 3
  bootstrapServers: prod-kafka-kafka-bootstrap.kafka-prod.svc.cluster.local:9093
  tls:
    trustedCertificates:
      - secretName: prod-kafka-cluster-ca-cert
        certificate: ca.crt
  authentication:
    type: tls
    certificateAndKey:
      secretName: connect-user
      certificate: user.crt
      key: user.key
  config:
    group.id: connect-prod-cluster
    offset.storage.topic: connect-prod-offsets
    config.storage.topic: connect-prod-configs
    status.storage.topic: connect-prod-status
    offset.storage.replication.factor: 3
    config.storage.replication.factor: 3
    status.storage.replication.factor: 3
    key.converter: io.confluent.connect.avro.AvroConverter
    value.converter: io.confluent.connect.avro.AvroConverter
    key.converter.schema.registry.url: http://apicurio-registry.schema-registry.svc.cluster.local:8080/apis/ccompat/v6
    value.converter.schema.registry.url: http://apicurio-registry.schema-registry.svc.cluster.local:8080/apis/ccompat/v6
    # Dead letter queue configuration
    errors.tolerance: all
    errors.deadletterqueue.topic.name: connect-dead-letter
    errors.deadletterqueue.topic.replication.factor: 3
    errors.deadletterqueue.context.headers.enable: true
    # Producer performance
    producer.override.batch.size: "32768"
    producer.override.linger.ms: "10"
    producer.override.compression.type: "lz4"
  build:
    output:
      type: docker
      image: your-registry.example.com/kafka-connect:3.8.0-custom
      pushSecret: registry-credentials
    plugins:
      - name: debezium-postgres-connector
        artifacts:
          - type: maven
            group: io.debezium
            artifact: debezium-connector-postgres
            version: 2.7.3.Final
      - name: kafka-connect-jdbc
        artifacts:
          - type: zip
            url: https://packages.confluent.io/maven/io/confluent/kafka-connect-jdbc/10.7.6/kafka-connect-jdbc-10.7.6.zip
            sha512sum: "<sha512-of-the-zip>"
      - name: kafka-connect-s3
        artifacts:
          - type: tgz
            url: https://packages.confluent.io/maven/io/confluent/kafka-connect-s3/10.5.15/kafka-connect-s3-10.5.15.tar.gz
            sha512sum: "<sha512-of-the-tgz>"
  resources:
    requests:
      cpu: "1000m"
      memory: "2Gi"
    limits:
      cpu: "4000m"
      memory: "4Gi"
  jvmOptions:
    -Xms: "1g"
    -Xmx: "2g"
  metricsConfig:
    type: jmxPrometheusExporter
    valueFrom:
      configMapKeyRef:
        name: kafka-connect-metrics-config
        key: metrics-config.yml
```

### Debezium PostgreSQL Source Connector

```yaml
# debezium-postgres-connector.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: orders-postgres-cdc
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-connect
spec:
  class: io.debezium.connector.postgresql.PostgresConnector
  tasksMax: 4
  config:
    # Database connection
    database.hostname: postgres-primary.database.svc.cluster.local
    database.port: "5432"
    database.user: debezium
    database.password: "${file:/opt/kafka/external-configuration/postgres-credentials/password}"
    database.dbname: orders
    database.server.name: prod-orders
    # Schema filtering
    schema.include.list: public
    table.include.list: "public.orders,public.order_items,public.order_events"
    # Output topic naming
    topic.prefix: prod-orders
    # Slot configuration
    slot.name: debezium_prod_orders
    plugin.name: pgoutput
    publication.name: dbz_publication
    # Snapshot mode
    snapshot.mode: initial
    snapshot.isolation.mode: repeatable_read
    # Converters
    key.converter: io.confluent.connect.avro.AvroConverter
    key.converter.schema.registry.url: http://apicurio-registry.schema-registry.svc.cluster.local:8080/apis/ccompat/v6
    value.converter: io.confluent.connect.avro.AvroConverter
    value.converter.schema.registry.url: http://apicurio-registry.schema-registry.svc.cluster.local:8080/apis/ccompat/v6
    # Transformation chain
    transforms: "flatten,addMetadata"
    transforms.flatten.type: io.debezium.transforms.ExtractNewRecordState
    transforms.flatten.drop.tombstones: "false"
    transforms.flatten.handle.deletes: rewrite
    transforms.addMetadata.type: org.apache.kafka.connect.transforms.InsertField$Value
    transforms.addMetadata.static.field: _source_system
    transforms.addMetadata.static.value: prod-orders-db
    # Heartbeat for progress tracking
    heartbeat.interval.ms: "10000"
    heartbeat.topics.prefix: __debezium-heartbeat
    # Error handling
    errors.tolerance: all
    errors.deadletterqueue.topic.name: orders-postgres-cdc-dlq
    errors.deadletterqueue.context.headers.enable: true
    errors.log.enable: "true"
    errors.log.include.messages: "true"
```

### S3 Sink Connector for Data Lake

```yaml
# s3-sink-connector.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: orders-s3-sink
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-connect
spec:
  class: io.confluent.connect.s3.S3SinkConnector
  tasksMax: 8
  config:
    topics: "prod-orders.public.orders,prod-orders.public.order_items"
    s3.region: us-east-1
    s3.bucket.name: your-data-lake-bucket
    s3.part.size: "67108864"          # 64MB parts
    s3.compression.type: gzip
    # Path structure: year/month/day/hour
    s3.object.tagging.enabled: "true"
    storage.class: io.confluent.connect.s3.storage.S3Storage
    format.class: io.confluent.connect.s3.format.parquet.ParquetFormat
    parquet.codec: snappy
    # Partitioning
    partitioner.class: io.confluent.connect.storage.partitioner.TimeBasedPartitioner
    path.format: "'year'=YYYY/'month'=MM/'day'=dd/'hour'=HH"
    locale: en_US
    timezone: UTC
    timestamp.extractor: RecordField
    timestamp.field: updated_at
    # Flushing
    flush.size: "100000"
    rotate.interval.ms: "3600000"     # Rotate hourly
    rotate.schedule.interval.ms: "3600000"
    # Error handling
    errors.tolerance: all
    errors.deadletterqueue.topic.name: orders-s3-sink-dlq
```

## Section 8: Apicurio Schema Registry Integration

### Deploying Apicurio Registry

```yaml
# apicurio-registry.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: schema-registry
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: apicurio-registry
  namespace: schema-registry
spec:
  replicas: 3
  selector:
    matchLabels:
      app: apicurio-registry
  template:
    metadata:
      labels:
        app: apicurio-registry
    spec:
      containers:
        - name: apicurio-registry
          image: apicurio/apicurio-registry-sql:2.6.3.Final
          ports:
            - containerPort: 8080
          env:
            - name: REGISTRY_DATASOURCE_URL
              value: "jdbc:postgresql://postgres.database.svc.cluster.local:5432/registry"
            - name: REGISTRY_DATASOURCE_USERNAME
              valueFrom:
                secretKeyRef:
                  name: registry-db-credentials
                  key: username
            - name: REGISTRY_DATASOURCE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: registry-db-credentials
                  key: password
            - name: REGISTRY_ENABLE_METRICS
              value: "true"
            - name: QUARKUS_HTTP_CORS
              value: "true"
            - name: QUARKUS_HTTP_CORS_ORIGINS
              value: "https://your-schema-registry-ui.example.com"
            # Confluent-compatible API mode
            - name: REGISTRY_CCOMPAT_API_ENABLED
              value: "true"
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health/live
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 30
          resources:
            requests:
              cpu: 200m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: apicurio-registry
  namespace: schema-registry
spec:
  selector:
    app: apicurio-registry
  ports:
    - port: 8080
      targetPort: 8080
```

### Registering an Avro Schema

```bash
# Register schema via REST API
curl -X POST \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  http://apicurio-registry.schema-registry.svc.cluster.local:8080/apis/ccompat/v6/subjects/prod-orders.public.orders-value/versions \
  -d '{
    "schema": "{\"type\":\"record\",\"name\":\"Order\",\"namespace\":\"com.example.orders\",\"fields\":[{\"name\":\"id\",\"type\":\"string\"},{\"name\":\"user_id\",\"type\":\"string\"},{\"name\":\"total\",\"type\":{\"type\":\"bytes\",\"logicalType\":\"decimal\",\"precision\":12,\"scale\":2}},{\"name\":\"status\",\"type\":\"int\"},{\"name\":\"created_at\",\"type\":{\"type\":\"long\",\"logicalType\":\"timestamp-micros\"}},{\"name\":\"updated_at\",\"type\":{\"type\":\"long\",\"logicalType\":\"timestamp-micros\"}}]}"
  }'

# Get schema versions
curl -s http://apicurio-registry.schema-registry.svc.cluster.local:8080/apis/ccompat/v6/subjects/prod-orders.public.orders-value/versions

# Check compatibility before registering
curl -X POST \
  -H "Content-Type: application/json" \
  http://apicurio-registry.schema-registry.svc.cluster.local:8080/apis/ccompat/v6/compatibility/subjects/prod-orders.public.orders-value/versions/latest \
  -d '{"schema": "...new schema..."}'
```

## Section 9: Monitoring and Alerting

### Kafka Metrics ConfigMap

```yaml
# kafka-metrics-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-metrics-config
  namespace: kafka-prod
data:
  kafka-metrics-config.yml: |
    lowercaseOutputName: true
    rules:
      # JVM metrics
      - pattern: "java.lang<type=(.+), name=(.+)><(.+)>(.+)"
        name: java_lang_$1_$4
        labels:
          name: "$2"
          attribute: "$3"
      # Kafka broker metrics
      - pattern: "kafka.server<type=(.+), name=(.+), topic=(.+)><>Count"
        name: kafka_server_$1_$2_total
        labels:
          topic: "$3"
      - pattern: "kafka.server<type=(.+), name=(.+)><>Value"
        name: kafka_server_$1_$2
      # Controller metrics
      - pattern: "kafka.controller<type=(.+), name=(.+)><>Value"
        name: kafka_controller_$1_$2
      # Log metrics
      - pattern: "kafka.log<type=Log, name=(.+), topic=(.+), partition=(.+)><>Value"
        name: kafka_log_$1
        labels:
          topic: "$2"
          partition: "$3"
      # Network metrics
      - pattern: "kafka.network<type=RequestMetrics, name=(.+), request=(.+)><>Count"
        name: kafka_network_request_$1_total
        labels:
          request: "$2"
      - pattern: "kafka.network<type=RequestMetrics, name=(.+), request=(.+)><>99thPercentile"
        name: kafka_network_request_$1_p99
        labels:
          request: "$2"
```

### PrometheusRule Alerts

```yaml
# kafka-alert-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kafka-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: kafka.broker
      rules:
        - alert: KafkaOfflinePartitions
          expr: kafka_controller_kafkacontroller_offlinepartitionscount > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kafka has offline partitions"
            description: "{{ $value }} partition(s) are offline. Immediate attention required."

        - alert: KafkaUnderReplicatedPartitions
          expr: kafka_server_replicamanager_underreplicatedpartitions > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Kafka has under-replicated partitions"
            description: "{{ $value }} partition(s) are under-replicated."

        - alert: KafkaActiveControllerCount
          expr: kafka_controller_kafkacontroller_activecontrollercount != 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kafka has no active controller"
            description: "Expected exactly 1 active controller, got {{ $value }}."

        - alert: KafkaConsumerGroupLag
          expr: |
            sum by (group, topic) (
              kafka_consumer_group_current_offset_sum - kafka_topic_partition_current_offset_sum
            ) > 10000
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "High consumer lag for group {{ $labels.group }}"
            description: "Consumer group {{ $labels.group }} on topic {{ $labels.topic }} has lag of {{ $value }}."
```

## Section 10: Operational Procedures

### Rolling Kafka Broker Upgrade

```bash
# Strimzi performs rolling upgrades automatically when you update the version field.
# First update the operator, then the cluster version:

# 1. Update the Strimzi operator
helm upgrade strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace strimzi-system \
  --version 0.43.0

# 2. Update the Kafka cluster version (triggers rolling restart)
kubectl -n kafka-prod patch kafka prod-kafka \
  --type merge \
  -p '{"spec":{"kafka":{"version":"3.9.0","metadataVersion":"3.9-IV0"}}}'

# 3. Monitor the rolling upgrade
kubectl -n kafka-prod get pods -w -l strimzi.io/cluster=prod-kafka

# 4. Verify all pods are ready
kubectl -n kafka-prod wait pods \
  -l strimzi.io/cluster=prod-kafka \
  --for=condition=Ready \
  --timeout=600s
```

### Partition Rebalancing with Cruise Control

```yaml
# kafka-rebalance-add-brokers.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: add-broker-rebalance
  namespace: kafka-prod
  labels:
    strimzi.io/cluster: prod-kafka
  annotations:
    strimzi.io/rebalance: approve
spec:
  mode: add-brokers
  brokers: [6, 7]
  goals:
    - ReplicaCapacityGoal
    - DiskCapacityGoal
    - NetworkInboundCapacityGoal
    - NetworkOutboundCapacityGoal
    - CpuCapacityGoal
    - ReplicaDistributionGoal
  skipHardGoalCheck: false
  rebalanceDisk: false
  concurrentPartitionMovementsPerBroker: 5
  concurrentIntraBrokerPartitionMovements: 2
  concurrentLeaderMovements: 1000
  replicationThrottle: 104857600   # 100MB/s replication throttle
```

```bash
# Trigger the rebalance
kubectl -n kafka-prod apply -f kafka-rebalance-add-brokers.yaml

# Watch rebalance progress
kubectl -n kafka-prod get kafkarebalance add-broker-rebalance -w

# Get the proposal details
kubectl -n kafka-prod describe kafkarebalance add-broker-rebalance

# Approve the proposal (change annotation to approve)
kubectl -n kafka-prod annotate kafkarebalance add-broker-rebalance \
  strimzi.io/rebalance=approve --overwrite
```

### Disaster Recovery Failover

```bash
#!/usr/bin/env bash
# dr-failover.sh — Switch consumers to DR cluster
set -euo pipefail

SOURCE_CLUSTER="prod-kafka-kafka-bootstrap.kafka-prod.svc.cluster.local:9093"
DR_CLUSTER="dr-kafka-kafka-bootstrap.kafka-dr.svc.cluster.local:9093"
CONSUMER_GROUPS=("orders-processor" "payments-processor")
CA_CERT="/tmp/dr-ca.crt"

# Extract DR cluster CA cert
kubectl -n kafka-dr get secret dr-kafka-cluster-ca-cert \
  -o jsonpath='{.data.ca\.crt}' | base64 -d > "${CA_CERT}"

echo "Stopping consumers from source cluster..."
for group in "${CONSUMER_GROUPS[@]}"; do
    # Scale down deployments using this consumer group
    kubectl scale deployment "${group}" --replicas=0
done

echo "Waiting for consumers to drain..."
sleep 30

echo "Syncing offsets to DR cluster via MM2 checkpoints..."
# MM2 has been syncing offsets — verify checkpoint is recent
kubectl -n kafka-prod exec deploy/prod-to-dr-mirrormaker2 -- \
  /opt/kafka/bin/kafka-consumer-groups.sh \
    --bootstrap-server "${DR_CLUSTER}" \
    --command-config /tmp/dr-config.properties \
    --list | grep "prod\." | head -20

echo "Redirecting consumers to DR cluster..."
for group in "${CONSUMER_GROUPS[@]}"; do
    kubectl set env deployment/"${group}" \
      KAFKA_BOOTSTRAP_SERVERS="${DR_CLUSTER}" \
      KAFKA_CA_CERT="/dr-certs/ca.crt"
    kubectl scale deployment "${group}" --replicas=3
done

echo "Failover complete. Monitor consumer lag at DR cluster."
```

This production Strimzi deployment provides a complete Kafka platform on Kubernetes, from zero-trust mTLS authentication through automated CDC pipelines and multi-datacenter replication, with schema governance ensuring consumers never receive incompatible message formats.
