---
title: "Apache Kafka on Kubernetes with Strimzi: Topics, Connectors, and Mirror Maker 2"
date: 2027-06-26T00:00:00-05:00
draft: false
tags: ["Kafka", "Strimzi", "Kubernetes", "Streaming", "Event-Driven"]
categories:
- Kafka
- Kubernetes
- Streaming
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to running Apache Kafka on Kubernetes with Strimzi, covering Kafka CR configuration, KafkaTopic management, Kafka Connect and connector lifecycle, Mirror Maker 2 cross-cluster replication, Cruise Control rebalancing, JVM tuning, and monitoring with JMX exporter."
more_link: "yes"
url: "/kafka-kubernetes-strimzi-production-guide/"
---

Strimzi transforms Apache Kafka on Kubernetes from a fragile manually managed StatefulSet into a fully declarative, operator-managed streaming platform. Through a rich set of CRDs — `Kafka`, `KafkaTopic`, `KafkaUser`, `KafkaConnect`, `KafkaMirrorMaker2`, and `KafkaRebalance` — Strimzi covers the complete Kafka operational lifecycle: broker configuration, topic governance, connector management, cross-cluster replication, and automated partition rebalancing via Cruise Control. This guide walks through a production Strimzi deployment with best-practice configurations for enterprise streaming workloads.

<!--more-->

# Apache Kafka on Kubernetes with Strimzi: Topics, Connectors, and Mirror Maker 2

## Section 1: Strimzi Architecture Overview

Strimzi runs a Cluster Operator that watches Kafka-related CRDs and reconciles them into Kubernetes resources. Key operator components:

- **Cluster Operator** — manages Kafka, KafkaConnect, KafkaMirrorMaker2, and KafkaBridge resources
- **Entity Operator** — manages KafkaTopic and KafkaUser resources (runs as a deployment within each Kafka cluster namespace)
- **Kafka Brokers** — deployed as a StatefulSet with persistent PVCs per broker
- **Kafka Controller Quorum** — KRaft mode eliminates ZooKeeper dependency (Strimzi 0.36+)

The operator manages TLS certificate rotation, rolling updates that preserve data durability, broker scaling, and replication factor adjustments.

### Installation

```bash
# Install Strimzi via Helm
helm repo add strimzi https://strimzi.io/charts/
helm repo update

helm upgrade --install strimzi-operator strimzi/strimzi-kafka-operator \
  --namespace strimzi-operator \
  --create-namespace \
  --set watchNamespaces="{kafka}" \
  --set resources.requests.cpu=200m \
  --set resources.requests.memory=384Mi \
  --set resources.limits.cpu=1000m \
  --set resources.limits.memory=384Mi \
  --version 0.41.0

# Verify CRDs
kubectl get crd | grep kafka.strimzi.io
```

---

## Section 2: Kafka CR — Cluster Configuration

The `Kafka` CRD is the central resource. A production three-broker KRaft cluster:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: kafka-prod
  namespace: kafka
spec:
  kafka:
    version: 3.7.0
    replicas: 3
    listeners:
    - name: plain
      port: 9092
      type: internal
      tls: false
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
    config:
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      transaction.state.log.min.isr: 2
      default.replication.factor: 3
      min.insync.replicas: 2
      inter.broker.protocol.version: "3.7"
      log.message.format.version: "3.7"
      num.partitions: 12
      num.network.threads: 8
      num.io.threads: 16
      socket.send.buffer.bytes: 102400
      socket.receive.buffer.bytes: 102400
      socket.request.max.bytes: 104857600
      log.retention.hours: 168
      log.segment.bytes: 1073741824
      log.retention.check.interval.ms: 300000
      log.cleaner.enable: true
      log.cleanup.policy: delete
      compression.type: lz4
      auto.create.topics.enable: false
      delete.topic.enable: true
      group.initial.rebalance.delay.ms: 3000
      replica.lag.time.max.ms: 30000
      unclean.leader.election.enable: false
    storage:
      type: persistent-claim
      size: 500Gi
      class: gp3-encrypted
      deleteClaim: false
    resources:
      requests:
        memory: 8Gi
        cpu: "2"
      limits:
        memory: 8Gi
        cpu: "4"
    jvmOptions:
      -Xms: 4096m
      -Xmx: 4096m
      gcLoggingEnabled: true
      javaSystemProperties:
      - name: com.sun.jndi.rmiURLParsing
        value: legacy
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: kafka-metrics-config
          key: kafka-metrics-config.yml
    rack:
      topologyKey: topology.kubernetes.io/zone
    template:
      pod:
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  strimzi.io/name: kafka-prod-kafka
              topologyKey: kubernetes.io/hostname
        tolerations:
        - key: dedicated
          operator: Equal
          value: kafka
          effect: NoSchedule
      persistentVolumeClaim:
        metadata:
          annotations:
            volume.beta.kubernetes.io/storage-provisioner: ebs.csi.aws.com

  zookeeper:
    replicas: 3
    storage:
      type: persistent-claim
      size: 50Gi
      class: gp3-encrypted
      deleteClaim: false
    resources:
      requests:
        memory: 2Gi
        cpu: "500m"
      limits:
        memory: 2Gi
        cpu: "1"

  entityOperator:
    topicOperator:
      resources:
        requests:
          memory: 256Mi
          cpu: "100m"
        limits:
          memory: 512Mi
          cpu: "500m"
    userOperator:
      resources:
        requests:
          memory: 256Mi
          cpu: "100m"
        limits:
          memory: 512Mi
          cpu: "500m"

  cruiseControl:
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: cruise-control-metrics-config
          key: metrics-config.yml
```

---

## Section 3: KafkaTopic Management

The `KafkaTopic` CRD manages topic creation, configuration, and partition counts declaratively. The Entity Operator's topic controller reconciles CRD state against the Kafka cluster.

### Basic Topic

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-prod
spec:
  partitions: 12
  replicas: 3
  config:
    retention.ms: 604800000        # 7 days
    retention.bytes: 10737418240   # 10 GiB per partition
    cleanup.policy: delete
    compression.type: lz4
    min.insync.replicas: "2"
    message.timestamp.type: CreateTime
    max.message.bytes: "1048588"
```

### Compacted Topic (for CDC/event sourcing)

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: users-changelog
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-prod
spec:
  partitions: 6
  replicas: 3
  config:
    cleanup.policy: compact
    min.cleanable.dirty.ratio: "0.1"
    segment.ms: "3600000"          # 1 hour segments
    delete.retention.ms: "86400000"
    compression.type: snappy
    min.insync.replicas: "2"
```

### Topic Scaling — Increasing Partitions

Partition count can only be increased, never decreased:

```bash
# Increase partitions via kubectl patch
kubectl -n kafka patch kafkatopic orders \
  --type=merge \
  -p '{"spec":{"partitions":24}}'

# Watch the Entity Operator apply the change
kubectl -n kafka get kafkatopic orders -w
```

### KafkaUser with ACLs

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: order-producer
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-prod
spec:
  authentication:
    type: tls
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
      - Create
      host: "*"
    - resource:
        type: transactionalId
        name: order-producer-txn
        patternType: prefix
      operations:
      - Write
      - Describe
      host: "*"
```

The User Operator creates a Kubernetes Secret with the client TLS certificate and key that applications mount to authenticate.

---

## Section 4: JVM Tuning for Kafka Brokers

Kafka brokers are JVM applications and require careful heap tuning. The default G1GC settings work for most workloads, but high-throughput environments benefit from tuning.

### JVM Options in Kafka CR

```yaml
spec:
  kafka:
    jvmOptions:
      -Xms: 6144m
      -Xmx: 6144m
      -XX:
        MaxGCPauseMillis: 20
        InitiatingHeapOccupancyPercent: 35
        G1HeapRegionSize: 16m
        MinMetaspaceFreeRatio: 50
        MaxMetaspaceFreeRatio: 80
        ExplicitGCInvokesConcurrent: "true"
        ParallelGCThreads: 8
        ConcGCThreads: 4
      gcLoggingEnabled: true
```

### OS-Level Tuning via Init Container

Kafka benefits from several OS-level settings that require a privileged init container:

```yaml
spec:
  kafka:
    template:
      pod:
        initContainers:
        - name: kafka-init
          image: busybox:1.36
          command:
          - sh
          - -c
          - |
            sysctl -w vm.swappiness=1
            sysctl -w vm.dirty_background_ratio=5
            sysctl -w vm.dirty_ratio=80
            sysctl -w net.core.rmem_max=134217728
            sysctl -w net.core.wmem_max=134217728
          securityContext:
            privileged: true
            runAsUser: 0
```

### Broker Log Directory Configuration

Spreading data across multiple volumes improves I/O throughput:

```yaml
spec:
  kafka:
    storage:
      type: jbod
      volumes:
      - id: 0
        type: persistent-claim
        size: 500Gi
        class: gp3-encrypted
        deleteClaim: false
      - id: 1
        type: persistent-claim
        size: 500Gi
        class: gp3-encrypted
        deleteClaim: false
```

---

## Section 5: Kafka Connect and Connector Lifecycle

Kafka Connect provides a scalable framework for streaming data between Kafka and external systems. Strimzi manages Connect clusters and individual connectors via the `KafkaConnect` and `KafkaConnector` CRDs.

### KafkaConnect CR

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnect
metadata:
  name: kafka-connect-prod
  namespace: kafka
  annotations:
    strimzi.io/use-connector-resources: "true"
spec:
  version: 3.7.0
  replicas: 3
  bootstrapServers: kafka-prod-kafka-bootstrap:9093
  tls:
    trustedCertificates:
    - secretName: kafka-prod-cluster-ca-cert
      certificate: ca.crt
  authentication:
    type: tls
    certificateAndKey:
      secretName: kafka-connect-user
      certificate: user.crt
      key: user.key
  config:
    group.id: kafka-connect-prod
    offset.storage.topic: connect-offsets
    config.storage.topic: connect-configs
    status.storage.topic: connect-status
    offset.storage.replication.factor: 3
    config.storage.replication.factor: 3
    status.storage.replication.factor: 3
    key.converter: org.apache.kafka.connect.json.JsonConverter
    value.converter: org.apache.kafka.connect.json.JsonConverter
    key.converter.schemas.enable: "false"
    value.converter.schemas.enable: "false"
  resources:
    requests:
      cpu: "1"
      memory: 2Gi
    limits:
      cpu: "4"
      memory: 4Gi
  build:
    output:
      type: docker
      image: my-registry.example.com/kafka-connect:latest
      pushSecret: registry-credentials
    plugins:
    - name: debezium-postgres
      artifacts:
      - type: tgz
        url: https://repo1.maven.org/maven2/io/debezium/debezium-connector-postgres/2.6.2.Final/debezium-connector-postgres-2.6.2.Final-plugin.tar.gz
    - name: kafka-connect-s3
      artifacts:
      - type: jar
        url: https://packages.confluent.io/maven/io/confluent/kafka-connect-s3/10.5.8/kafka-connect-s3-10.5.8.jar
```

### KafkaConnector — Debezium PostgreSQL CDC

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: postgres-cdc-orders
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-connect-prod
spec:
  class: io.debezium.connector.postgresql.PostgresConnector
  tasksMax: 1
  config:
    database.hostname: pg-prod-rw.database.svc.cluster.local
    database.port: "5432"
    database.user: debezium
    database.password: "${file:/opt/kafka/external-configuration/pg-creds/password}"
    database.dbname: appdb
    database.server.name: pg-prod
    plugin.name: pgoutput
    slot.name: debezium_orders
    publication.name: dbz_publication
    table.include.list: "public.orders,public.order_items"
    topic.prefix: pg-prod
    topic.creation.default.partitions: "12"
    topic.creation.default.replication.factor: "3"
    topic.creation.default.cleanup.policy: compact
    snapshot.mode: initial
    snapshot.isolation.mode: repeatable_read
    decimal.handling.mode: double
    time.precision.mode: connect
    heartbeat.interval.ms: "10000"
    heartbeat.topics.prefix: __debezium-heartbeat
    transforms: route
    transforms.route.type: org.apache.kafka.connect.transforms.ReplaceField$Value
    transforms.route.renames: "before:before,after:after,source:source"
    errors.tolerance: all
    errors.deadletterqueue.topic.name: dlq.postgres-cdc-orders
    errors.deadletterqueue.topic.replication.factor: "3"
    errors.log.enable: "true"
    errors.log.include.messages: "true"
```

### Managing Connector State

```bash
# List all connectors
kubectl -n kafka get kafkaconnector

# Pause a connector
kubectl -n kafka patch kafkaconnector postgres-cdc-orders \
  --type=merge -p '{"spec":{"state":"paused"}}'

# Resume a connector
kubectl -n kafka patch kafkaconnector postgres-cdc-orders \
  --type=merge -p '{"spec":{"state":"running"}}'

# Check connector status
kubectl -n kafka get kafkaconnector postgres-cdc-orders -o yaml \
  | yq '.status'

# Check task status via Connect REST API
kubectl -n kafka port-forward svc/kafka-connect-prod-connect-api 8083:8083 &
curl http://localhost:8083/connectors/postgres-cdc-orders/status | jq .
```

---

## Section 6: Mirror Maker 2 — Cross-Cluster Replication

Kafka MirrorMaker 2 (MM2) replicates topics across Kafka clusters. Strimzi manages MM2 through the `KafkaMirrorMaker2` CRD. Common use cases include disaster recovery, geo-distribution, and data aggregation.

### KafkaMirrorMaker2 CR

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: mm2-dr
  namespace: kafka
spec:
  version: 3.7.0
  replicas: 3
  connectCluster: "target"
  clusters:
  - alias: source
    bootstrapServers: kafka-prod-kafka-bootstrap.kafka.svc.cluster.local:9093
    tls:
      trustedCertificates:
      - secretName: source-cluster-ca-cert
        certificate: ca.crt
    authentication:
      type: tls
      certificateAndKey:
        secretName: mm2-source-user
        certificate: user.crt
        key: user.key
    config:
      ssl.endpoint.identification.algorithm: https
  - alias: target
    bootstrapServers: kafka-dr-kafka-bootstrap.kafka-dr.svc.cluster.local:9093
    tls:
      trustedCertificates:
      - secretName: target-cluster-ca-cert
        certificate: ca.crt
    authentication:
      type: tls
      certificateAndKey:
        secretName: mm2-target-user
        certificate: user.crt
        key: user.key
    config:
      ssl.endpoint.identification.algorithm: https

  mirrors:
  - sourceCluster: source
    targetCluster: target
    sourceConnector:
      tasksMax: 6
      config:
        replication.factor: 3
        offset-syncs.topic.replication.factor: 3
        sync.topic.acls.enabled: "false"
        sync.topic.configs.enabled: "true"
        refresh.topics.interval.seconds: "30"
        replication.policy.separator: "."
        topics: "orders,users-changelog,inventory.*"
        topics.exclude: ".*\\.internal,.*\\.replica,__consumer_offsets"
        heartbeats.topic.replication.factor: "3"
        checkpoints.topic.replication.factor: "3"
    checkpointConnector:
      tasksMax: 3
      config:
        checkpoints.topic.replication.factor: 3
        refresh.groups.interval.seconds: "60"
        sync.group.offsets.enabled: "true"
        sync.group.offsets.interval.seconds: "60"
    heartbeatConnector:
      config:
        heartbeats.topic.replication.factor: 3

  resources:
    requests:
      cpu: "500m"
      memory: 1Gi
    limits:
      cpu: "2"
      memory: 2Gi
```

### Monitoring Replication Lag

```bash
# Check MM2 connector status
kubectl -n kafka get kafkamirrormaker2 mm2-dr -o yaml | yq '.status'

# Verify topic mirroring (note the source.topic naming convention)
KAFKA_PASS=$(kubectl -n kafka get secret mm2-source-user \
  -o jsonpath='{.data.user\.password}' | base64 -d)

kubectl -n kafka exec -it kafka-dr-kafka-0 -- \
  bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 \
    --list | grep "^source\."

# Check consumer group offset translation
kubectl -n kafka exec -it kafka-dr-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --describe \
    --group "source.order-processor"
```

### Promoting the DR Cluster (Failover)

When the source cluster is unavailable:

```bash
# Update consumer groups to use translated offsets on target
kubectl -n kafka exec -it kafka-dr-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --group order-processor \
    --reset-offsets \
    --to-offset-file /tmp/translated-offsets.txt \
    --execute

# Rename mirrored topics to remove source prefix (if needed)
# target cluster: rename source.orders -> orders
kubectl -n kafka exec -it kafka-dr-kafka-0 -- \
  bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 \
    --alter --topic source.orders \
    --config cleanup.policy=delete
```

---

## Section 7: Schema Registry Integration

For Avro or Protobuf serialization, deploy the Confluent Schema Registry alongside Strimzi:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: schema-registry
  namespace: kafka
spec:
  replicas: 2
  selector:
    matchLabels:
      app: schema-registry
  template:
    metadata:
      labels:
        app: schema-registry
    spec:
      containers:
      - name: schema-registry
        image: confluentinc/cp-schema-registry:7.6.1
        ports:
        - containerPort: 8081
        env:
        - name: SCHEMA_REGISTRY_HOST_NAME
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS
          value: "SASL_SSL://kafka-prod-kafka-bootstrap:9093"
        - name: SCHEMA_REGISTRY_KAFKASTORE_SECURITY_PROTOCOL
          value: SSL
        - name: SCHEMA_REGISTRY_KAFKASTORE_SSL_TRUSTSTORE_LOCATION
          value: /etc/kafka/secrets/kafka.schema-registry.truststore.jks
        - name: SCHEMA_REGISTRY_KAFKASTORE_SSL_TRUSTSTORE_PASSWORD
          valueFrom:
            secretKeyRef:
              name: schema-registry-tls
              key: truststore-password
        - name: SCHEMA_REGISTRY_LISTENERS
          value: "http://0.0.0.0:8081"
        - name: SCHEMA_REGISTRY_SCHEMA_REGISTRY_INTER_INSTANCE_PROTOCOL
          value: http
        resources:
          requests:
            cpu: "200m"
            memory: 512Mi
          limits:
            cpu: "1"
            memory: 1Gi
```

---

## Section 8: Consumer Group Management

### Describing Consumer Groups

```bash
# List all consumer groups
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --list

# Describe a specific group (shows lag per partition)
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --describe \
    --group order-processor
```

### Resetting Offsets

```bash
# Reset to latest (discard unprocessed messages)
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --group order-processor \
    --topic orders \
    --reset-offsets \
    --to-latest \
    --execute

# Reset to a specific timestamp (ISO 8601)
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --group order-processor \
    --topic orders \
    --reset-offsets \
    --to-datetime 2027-06-24T00:00:00.000 \
    --execute

# Reset to earliest (reprocess all messages)
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
    --bootstrap-server localhost:9092 \
    --group order-processor \
    --topic orders \
    --reset-offsets \
    --to-earliest \
    --dry-run    # Remove --dry-run to execute
```

### Rack-Aware Replica Placement

The `rack` field in the Kafka CR configures rack awareness using the node label `topology.kubernetes.io/zone`. Strimzi propagates this to brokers via the `broker.rack` configuration, ensuring replicas span availability zones.

```yaml
spec:
  kafka:
    rack:
      topologyKey: topology.kubernetes.io/zone
```

Verify rack assignment:

```bash
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  cat /tmp/strimzi.properties | grep broker.rack
```

---

## Section 9: Cruise Control Rebalancing

Cruise Control continuously monitors Kafka cluster utilization and generates partition movement plans to balance load across brokers. Strimzi integrates Cruise Control via the `KafkaRebalance` CRD.

### Enabling Cruise Control

Cruise Control is already included in the `Kafka` CR above. Ensure the `cruiseControl` section is populated.

### Requesting a Rebalance

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: rebalance-full
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-prod
spec:
  mode: full
  goals:
  - NetworkInboundCapacityGoal
  - DiskCapacityGoal
  - RackAwareDistributionGoal
  - NetworkOutboundCapacityGoal
  - CpuCapacityGoal
  - ReplicaCapacityGoal
  - ReplicaDistributionGoal
  - TopicReplicaDistributionGoal
  - LeaderReplicaDistributionGoal
  - LeaderBytesInDistributionGoal
  skipHardGoalCheck: false
```

### Rebalance Workflow

```bash
# Apply the rebalance proposal request
kubectl apply -f rebalance-full.yaml

# Wait for proposal to be computed (status: ProposalReady)
kubectl -n kafka get kafkarebalance rebalance-full -w

# Review the proposal
kubectl -n kafka describe kafkarebalance rebalance-full

# Approve and execute the rebalance
kubectl -n kafka annotate kafkarebalance rebalance-full \
  strimzi.io/rebalance=approve

# Monitor rebalancing progress
kubectl -n kafka get kafkarebalance rebalance-full -w

# Stop a rebalance in progress
kubectl -n kafka annotate kafkarebalance rebalance-full \
  strimzi.io/rebalance=stop
```

### Add-Broker Rebalance After Scaling

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: rebalance-add-brokers
  namespace: kafka
  labels:
    strimzi.io/cluster: kafka-prod
spec:
  mode: add-brokers
  brokers: [3]
```

---

## Section 10: Monitoring with JMX Exporter

Strimzi bundles the Prometheus JMX Exporter as an agent that scrapes Kafka's JMX metrics and exposes them in Prometheus format.

### JMX Exporter ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-metrics-config
  namespace: kafka
data:
  kafka-metrics-config.yml: |
    lowercaseOutputName: true
    rules:
    - pattern: "kafka.server<type=(.+), name=(.+), clientId=(.+), topic=(.+), partition=(.*)><>Value"
      name: "kafka_server_$1_$2"
      type: GAUGE
      labels:
        clientId: "$3"
        topic: "$4"
        partition: "$5"
    - pattern: "kafka.server<type=(.+), name=(.+), clientId=(.+), brokerHost=(.+), brokerPort=(.+)><>Value"
      name: "kafka_server_$1_$2"
      type: GAUGE
      labels:
        clientId: "$3"
        broker: "$4:$5"
    - pattern: "kafka.server<type=(.+), name=(.+)><>OneMinuteRate"
      name: "kafka_server_$1_$2_rate"
      type: GAUGE
    - pattern: "kafka.server<type=(.+), name=(.+)><>Value"
      name: "kafka_server_$1_$2"
      type: GAUGE
    - pattern: "kafka.network<type=(.+), name=(.+)><>Value"
      name: "kafka_network_$1_$2"
      type: GAUGE
    - pattern: "kafka.log<type=(.+), name=(.+), topic=(.+), partition=(.+)><>Value"
      name: "kafka_log_$1_$2"
      type: GAUGE
      labels:
        topic: "$3"
        partition: "$4"
    - pattern: "kafka.controller<type=(.+), name=(.+)><>Value"
      name: "kafka_controller_$1_$2"
      type: GAUGE
```

### PodMonitor for Kafka Brokers

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: kafka-prod-kafka
  namespace: kafka
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      strimzi.io/cluster: kafka-prod
      strimzi.io/kind: Kafka
  podMetricsEndpoints:
  - port: tcp-prometheus
    interval: 30s
    scrapeTimeout: 25s
    relabelings:
    - sourceLabels: [__meta_kubernetes_pod_label_strimzi_io_name]
      targetLabel: kafka_cluster
    - sourceLabels: [__meta_kubernetes_pod_name]
      targetLabel: pod
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kafka-alerts
  namespace: kafka
spec:
  groups:
  - name: kafka
    rules:
    - alert: KafkaUnderReplicatedPartitions
      expr: kafka_server_replicamanager_underreplicatedpartitions > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Kafka under-replicated partitions on {{ $labels.pod }}"
        description: "{{ $value }} partitions are under-replicated."

    - alert: KafkaOfflinePartitions
      expr: kafka_controller_kafkacontroller_offlinepartitionscount > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Kafka offline partitions"
        description: "{{ $value }} partitions are offline."

    - alert: KafkaActiveControllerCount
      expr: kafka_controller_kafkacontroller_activecontrollercount != 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Kafka active controller count is not 1"
        description: "Active controller count is {{ $value }}."

    - alert: KafkaConsumerGroupLagHigh
      expr: kafka_consumergroup_lag > 100000
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "High consumer lag for {{ $labels.consumergroup }}"
        description: "Lag is {{ $value }} messages on topic {{ $labels.topic }}."

    - alert: KafkaBrokerRequestQueueTime
      expr: |
        kafka_network_requestmetrics_requestqueuetimems > 200
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High request queue time on {{ $labels.pod }}"
        description: "Request queue time is {{ $value }}ms."
```

---

## Section 11: KafkaBridge — HTTP Access to Kafka

The `KafkaBridge` provides an HTTP/1.1 interface to Kafka, enabling non-JVM clients to produce and consume messages.

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaBridge
metadata:
  name: kafka-bridge
  namespace: kafka
spec:
  replicas: 2
  bootstrapServers: kafka-prod-kafka-bootstrap:9093
  tls:
    trustedCertificates:
    - secretName: kafka-prod-cluster-ca-cert
      certificate: ca.crt
  authentication:
    type: tls
    certificateAndKey:
      secretName: kafka-bridge-user
      certificate: user.crt
      key: user.key
  http:
    port: 8080
    cors:
      allowedOrigins:
      - "https://app.example.com"
      allowedMethods:
      - GET
      - POST
      - PUT
      - DELETE
      - OPTIONS
      - PATCH
  resources:
    requests:
      cpu: "200m"
      memory: 512Mi
    limits:
      cpu: "1"
      memory: 1Gi
```

### Bridge Usage Examples

```bash
# Produce a message via HTTP
curl -X POST http://kafka-bridge.kafka.svc.cluster.local:8080/topics/orders \
  -H "Content-Type: application/vnd.kafka.json.v2+json" \
  -d '{
    "records": [
      {
        "key": "order-001",
        "value": {"orderId": "001", "amount": 99.99, "status": "pending"}
      }
    ]
  }'

# Create a consumer group via HTTP
curl -X POST \
  http://kafka-bridge.kafka.svc.cluster.local:8080/consumers/bridge-consumer-group \
  -H "Content-Type: application/vnd.kafka.v2+json" \
  -d '{
    "name": "consumer-1",
    "format": "json",
    "auto.offset.reset": "latest",
    "enable.auto.commit": false
  }'

# Subscribe to topics
curl -X POST \
  http://kafka-bridge.kafka.svc.cluster.local:8080/consumers/bridge-consumer-group/instances/consumer-1/subscription \
  -H "Content-Type: application/vnd.kafka.v2+json" \
  -d '{"topics": ["orders"]}'

# Consume records
curl -X GET \
  http://kafka-bridge.kafka.svc.cluster.local:8080/consumers/bridge-consumer-group/instances/consumer-1/records \
  -H "Accept: application/vnd.kafka.json.v2+json"
```

---

## Section 12: Operational Runbooks

### Rolling Restart

```bash
# Trigger a rolling restart of all Kafka brokers
kubectl -n kafka annotate kafka kafka-prod \
  strimzi.io/manual-rolling-update=true

# Watch the rolling restart progress
kubectl -n kafka get pods -l strimzi.io/cluster=kafka-prod -w
```

### Broker Disk Full — Emergency Topic Cleanup

```bash
# List topics sorted by log size
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  du -sh /var/lib/kafka/data/kafka-log*/* | sort -rh | head -20

# Reduce retention on a topic immediately
kubectl -n kafka patch kafkatopic orders \
  --type=merge \
  -p '{"spec":{"config":{"retention.ms":"3600000"}}}'
```

### Certificate Rotation

Strimzi handles certificate rotation automatically (every 30 days by default). To force immediate rotation:

```bash
# Rotate the cluster CA certificate
kubectl -n kafka annotate secret kafka-prod-cluster-ca \
  strimzi.io/force-renew=true

# Rotate the clients CA certificate
kubectl -n kafka annotate secret kafka-prod-clients-ca \
  strimzi.io/force-renew=true
```

### Verify Cluster Health

```bash
# Check all Kafka resources
kubectl -n kafka get kafka,kafkatopic,kafkauser,kafkaconnect,kafkamirrormaker2

# Check broker log end offsets for a topic
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  bin/kafka-log-dirs.sh \
    --bootstrap-server localhost:9092 \
    --topic-list orders \
    --describe | jq '.brokers[].logDirs[].partitions[] | {partition: .partition, size: .size}'

# Verify ISR (In-Sync Replica) count
kubectl -n kafka exec -it kafka-prod-kafka-0 -- \
  bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 \
    --describe --topic orders | grep -E "Isr|Leader"
```

Strimzi provides the declarative control plane Kafka has always needed on Kubernetes. By encoding cluster topology, topic governance, connector lifecycle, and rebalancing intent as Kubernetes resources, operations teams gain consistent GitOps workflows, automated certificate management, and the ability to treat Kafka clusters with the same rigor as any other Kubernetes workload.
