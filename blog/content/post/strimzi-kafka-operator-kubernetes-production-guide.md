---
title: "Strimzi: Running Apache Kafka on Kubernetes at Production Scale"
date: 2026-12-31T00:00:00-05:00
draft: false
tags: ["Strimzi", "Kafka", "Kubernetes", "Messaging", "Operator"]
categories:
- Kubernetes
- Data Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to deploying and operating Apache Kafka on Kubernetes using Strimzi, covering KafkaNodePool, rebalancing, TLS authentication, MirrorMaker 2, and Kafka Connect."
more_link: "yes"
url: "/strimzi-kafka-operator-kubernetes-production-guide/"
---

Running Apache Kafka on Kubernetes has historically required significant operational investment: managing ZooKeeper quorums, orchestrating rolling upgrades without consumer disruption, rotating certificates across a distributed cluster, and tuning JVM garbage collection across dozens of broker pods. These operations require Kafka-specific knowledge that does not map cleanly onto standard Kubernetes primitives.

**Strimzi** resolves this operational gap through a Kubernetes operator that encodes Kafka operational knowledge into custom controllers. The operator manages the full lifecycle of Kafka brokers, ZooKeeper nodes (and KRaft controllers for ZooKeeper-less deployments), topics, users, Kafka Connect clusters, MirrorMaker 2 replication, and Cruise Control rebalancing — all through Kubernetes custom resources that integrate naturally with GitOps workflows.

This guide covers the complete production deployment of Strimzi-managed Kafka: cluster configuration with `KafkaNodePool`, mutual TLS authentication and ACL-based authorization, topic and user management via CRDs, Kafka Connect with connector lifecycle management, MirrorMaker 2 for cross-region replication, Cruise Control for partition rebalancing, Prometheus monitoring integration, and zero-downtime rolling upgrades.

<!--more-->

## Strimzi Operator Architecture

The Strimzi operator consists of several controllers, each responsible for a specific domain:

- **Cluster Operator**: Manages `Kafka`, `KafkaConnect`, `KafkaMirrorMaker2`, and `KafkaBridge` resources. Orchestrates rolling updates, certificate rotation, and scaling operations.
- **Topic Operator**: Watches `KafkaTopic` resources and reconciles them with the Kafka cluster's topic configuration via the AdminClient API.
- **User Operator**: Watches `KafkaUser` resources and manages TLS certificates and SCRAM-SHA-512 credentials, storing them as Kubernetes `Secret` objects.
- **Entity Operator**: Bundles the Topic and User Operators into a single deployment associated with a specific Kafka cluster.

The operator translates declarative intent expressed in CRDs into the operational procedures documented in the Apache Kafka operations guide, eliminating manual intervention for routine maintenance tasks.

### KRaft vs ZooKeeper Mode

Strimzi supports both ZooKeeper-based clusters (legacy) and KRaft-based clusters (no ZooKeeper dependency). KRaft is the future of Kafka metadata management and is the recommended mode for new deployments. This guide covers ZooKeeper mode for compatibility with existing Kafka 3.x deployments but notes KRaft alternatives where they differ.

## Operator Installation via Helm

```bash
helm repo add strimzi https://strimzi.io/charts/
helm repo update

helm upgrade --install strimzi-kafka-operator strimzi/strimzi-kafka-operator \
  --namespace kafka \
  --create-namespace \
  --set watchNamespaces="{kafka}" \
  --set resources.requests.memory=384Mi \
  --set resources.requests.cpu=200m \
  --set resources.limits.memory=384Mi \
  --set resources.limits.cpu=500m \
  --version 0.43.0

kubectl -n kafka wait --for=condition=available \
  deployment/strimzi-cluster-operator --timeout=120s
```

## Kafka Cluster Deployment

### Production-Grade Cluster Configuration

The `Kafka` resource encapsulates the full cluster specification. The configuration below represents a production cluster with mutual TLS authentication, simple authorization, JBOD storage, and topology spread constraints for zone awareness:

```yaml
# kafka-cluster.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: production-kafka
  namespace: kafka
spec:
  kafka:
    version: 3.7.0
    metadataVersion: "3.7"
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
    authorization:
      type: simple
    config:
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      transaction.state.log.min.isr: 2
      default.replication.factor: 3
      min.insync.replicas: 2
      inter.broker.protocol.version: "3.7"
      log.retention.hours: 168
      log.segment.bytes: 1073741824
      log.retention.check.interval.ms: 300000
      num.partitions: 6
      socket.send.buffer.bytes: 102400
      socket.receive.buffer.bytes: 102400
      socket.request.max.bytes: 104857600
    storage:
      type: jbod
      volumes:
      - id: 0
        type: persistent-claim
        size: 100Gi
        class: fast-ssd
        deleteClaim: false
    resources:
      requests:
        memory: 4Gi
        cpu: 1000m
      limits:
        memory: 8Gi
        cpu: 2000m
    jvmOptions:
      -Xms: 2g
      -Xmx: 2g
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
                  - production-kafka-kafka
              topologyKey: kubernetes.io/hostname
        topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              strimzi.io/name: production-kafka-kafka
  zookeeper:
    replicas: 3
    storage:
      type: persistent-claim
      size: 10Gi
      class: fast-ssd
      deleteClaim: false
    resources:
      requests:
        memory: 512Mi
        cpu: 250m
      limits:
        memory: 1Gi
        cpu: 500m
  entityOperator:
    topicOperator: {}
    userOperator: {}
```

### KafkaNodePool for Heterogeneous Broker Pools

`KafkaNodePool` (introduced in Strimzi 0.37) allows defining separate pools of Kafka nodes with different storage, resources, or roles. This enables dedicated broker and controller roles in KRaft mode, and heterogeneous hardware configurations in ZooKeeper mode:

```yaml
# kafka-nodepool.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: broker-ssd
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  replicas: 3
  roles:
  - broker
  storage:
    type: jbod
    volumes:
    - id: 0
      type: persistent-claim
      size: 500Gi
      class: nvme-ssd
      deleteClaim: false
  resources:
    requests:
      memory: 8Gi
      cpu: 2000m
    limits:
      memory: 16Gi
      cpu: 4000m
  jvmOptions:
    -Xms: 4g
    -Xmx: 4g
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: broker-hdd
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  replicas: 3
  roles:
  - broker
  storage:
    type: jbod
    volumes:
    - id: 0
      type: persistent-claim
      size: 2000Gi
      class: standard-hdd
      deleteClaim: false
  resources:
    requests:
      memory: 4Gi
      cpu: 1000m
    limits:
      memory: 8Gi
      cpu: 2000m
  jvmOptions:
    -Xms: 2g
    -Xmx: 2g
```

To enable `KafkaNodePool` support, annotate the `Kafka` resource:

```bash
kubectl annotate kafka production-kafka \
  strimzi.io/node-pools=enabled \
  -n kafka
```

### Verifying Cluster Health

```bash
kubectl -n kafka get kafka production-kafka

kubectl -n kafka get pods -l strimzi.io/cluster=production-kafka

kubectl -n kafka exec -it production-kafka-kafka-0 -- \
  bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --list
```

## TLS Mutual Authentication and ACL Authorization

### How Strimzi Manages Certificates

The Cluster Operator creates a cluster CA and a client CA as Kubernetes `Secret` objects. When a `KafkaUser` with TLS authentication is created, the User Operator generates a signed certificate using the client CA and stores it as a secret with keys `user.crt`, `user.key`, and `user.p12`.

Brokers present certificates signed by the cluster CA. Clients must trust the cluster CA to verify broker identity. Brokers verify client certificates against the client CA for mutual TLS.

### Creating a TLS-Authenticated User with ACLs

```yaml
# kafka-user-order-processor.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: order-processor
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  authentication:
    type: tls
  authorization:
    type: simple
    acls:
    - resource:
        type: topic
        name: order-events
        patternType: literal
      operations:
      - Read
      - Describe
    - resource:
        type: group
        name: order-processor-group
        patternType: literal
      operations:
      - Read
    - resource:
        type: topic
        name: order-processed
        patternType: literal
      operations:
      - Write
      - Create
      - Describe
```

### Using Wildcard ACLs for Service-Level Isolation

For services that own a namespace of topics (identified by a prefix), use the `prefix` pattern type:

```yaml
# kafka-user-payment-service.yaml
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
    - resource:
        type: topic
        name: payment-
        patternType: prefix
      operations:
      - Read
      - Write
      - Create
      - Describe
      - DescribeConfigs
    - resource:
        type: group
        name: payment-service-
        patternType: prefix
      operations:
      - Read
      - Describe
    - resource:
        type: transactionalId
        name: payment-service-
        patternType: prefix
      operations:
      - Write
      - Describe
```

### Mounting Certificates in Application Pods

```yaml
# deployment-order-processor.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-processor
  namespace: kafka
spec:
  replicas: 3
  selector:
    matchLabels:
      app: order-processor
  template:
    metadata:
      labels:
        app: order-processor
    spec:
      containers:
      - name: order-processor
        image: registry.example.com/order-processor:v1.4.0
        env:
        - name: KAFKA_BOOTSTRAP_SERVERS
          value: production-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093
        - name: KAFKA_SECURITY_PROTOCOL
          value: SSL
        - name: KAFKA_SSL_TRUSTSTORE_LOCATION
          value: /opt/kafka/certs/ca.crt
        - name: KAFKA_SSL_KEYSTORE_LOCATION
          value: /opt/kafka/certs/user.p12
        - name: KAFKA_SSL_KEYSTORE_PASSWORD_FILE
          value: /opt/kafka/certs/user.password
        volumeMounts:
        - name: kafka-certs
          mountPath: /opt/kafka/certs
          readOnly: true
      volumes:
      - name: kafka-certs
        projected:
          sources:
          - secret:
              name: production-kafka-cluster-ca-cert
              items:
              - key: ca.crt
                path: ca.crt
          - secret:
              name: order-processor
              items:
              - key: user.crt
                path: user.crt
              - key: user.key
                path: user.key
              - key: user.p12
                path: user.p12
              - key: user.password
                path: user.password
```

## Topic Management via CRDs

### Topic Creation

The `KafkaTopic` resource creates and manages topic configuration. The Topic Operator reconciles the resource against the actual Kafka cluster state:

```yaml
# kafka-topics.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: order-events
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  partitions: 12
  replicas: 3
  config:
    retention.ms: "604800000"
    segment.bytes: "1073741824"
    cleanup.policy: delete
    min.insync.replicas: "2"
    compression.type: lz4
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: payment-events-compacted
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  partitions: 6
  replicas: 3
  config:
    cleanup.policy: compact
    min.insync.replicas: "2"
    min.cleanable.dirty.ratio: "0.1"
    segment.ms: "21600000"
    delete.retention.ms: "86400000"
```

### Topic Configuration Changes

Modifying `KafkaTopic` spec triggers the Topic Operator to apply changes. Partition count can only be increased, not decreased. Configuration changes (like `retention.ms`) are applied without data loss.

```bash
kubectl patch kafkatopic order-events -n kafka \
  --type merge \
  -p '{"spec":{"config":{"retention.ms":"1209600000"}}}'

kubectl -n kafka get kafkatopic order-events -o jsonpath='{.status.conditions}'
```

## Kafka Connect with Connector Management

### KafkaConnect Cluster with Custom Plugins

The Strimzi build feature compiles a custom Kafka Connect image containing required connector plugins:

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
  bootstrapServers: production-kafka-kafka-bootstrap:9093
  tls:
    trustedCertificates:
    - secretName: production-kafka-cluster-ca-cert
      certificate: ca.crt
  authentication:
    type: tls
    certificateAndKey:
      secretName: kafka-connect-user
      certificate: user.crt
      key: user.key
  config:
    group.id: production-connect-cluster
    offset.storage.topic: connect-cluster-offsets
    config.storage.topic: connect-cluster-configs
    status.storage.topic: connect-cluster-status
    offset.storage.replication.factor: 3
    config.storage.replication.factor: 3
    status.storage.replication.factor: 3
    key.converter: org.apache.kafka.connect.storage.StringConverter
    value.converter: io.confluent.connect.avro.AvroConverter
    value.converter.schema.registry.url: http://schema-registry.kafka.svc.cluster.local:8081
  resources:
    requests:
      memory: 1Gi
      cpu: 500m
    limits:
      memory: 2Gi
      cpu: 1000m
  build:
    output:
      type: docker
      image: registry.example.com/kafka-connect:latest
      pushSecret: registry-credentials
    plugins:
    - name: debezium-postgres
      artifacts:
      - type: tgz
        url: https://repo1.maven.org/maven2/io/debezium/debezium-connector-postgres/2.7.0.Final/debezium-connector-postgres-2.7.0.Final-plugin.tar.gz
    - name: kafka-connect-jdbc
      artifacts:
      - type: jar
        url: https://repo1.maven.org/maven2/io/confluent/kafka-connect-jdbc/10.7.6/kafka-connect-jdbc-10.7.6.jar
```

### KafkaConnector Resource

With `strimzi.io/use-connector-resources: "true"` annotated on the `KafkaConnect`, connector lifecycle is managed through `KafkaConnector` resources:

```yaml
# kafka-connector-debezium.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaConnector
metadata:
  name: postgres-cdc-orders
  namespace: kafka
  labels:
    strimzi.io/cluster: production-connect
spec:
  class: io.debezium.connector.postgresql.PostgresConnector
  tasksMax: 4
  autoRestart:
    enabled: true
    maxRestarts: 10
  config:
    database.hostname: postgres-primary.database.svc.cluster.local
    database.port: "5432"
    database.user: debezium
    database.password: "${file:/opt/kafka/external-configuration/postgres-secret/password}"
    database.dbname: orders
    database.server.name: orders-db
    plugin.name: pgoutput
    publication.name: dbz_publication
    slot.name: debezium_orders
    table.include.list: "public.orders,public.order_items"
    topic.prefix: cdc
    topic.creation.enable: "true"
    topic.creation.default.replication.factor: "3"
    topic.creation.default.partitions: "6"
    schema.history.internal.kafka.bootstrap.servers: production-kafka-kafka-bootstrap:9092
    schema.history.internal.kafka.topic: cdc.schema-history.orders-db
    heartbeat.interval.ms: "30000"
    include.schema.changes: "true"
```

## MirrorMaker 2 for Cluster Replication

MirrorMaker 2 provides active-active and active-passive replication between Kafka clusters. It is built on Kafka Connect and manages three types of connectors: the source connector (replicating data), the heartbeat connector (monitoring replication health), and the checkpoint connector (synchronizing consumer group offsets).

### Cross-Region Replication Configuration

```yaml
# mirrormaker2-us-to-eu.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaMirrorMaker2
metadata:
  name: mm2-us-to-eu
  namespace: kafka
spec:
  version: 3.7.0
  replicas: 2
  connectCluster: eu-west-1
  clusters:
  - alias: us-east-1
    bootstrapServers: production-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093
    tls:
      trustedCertificates:
      - secretName: production-kafka-cluster-ca-cert
        certificate: ca.crt
    authentication:
      type: tls
      certificateAndKey:
        secretName: mm2-us-east-1-user
        certificate: user.crt
        key: user.key
  - alias: eu-west-1
    bootstrapServers: production-kafka-eu.kafka.svc.cluster.local:9093
    tls:
      trustedCertificates:
      - secretName: production-kafka-eu-cluster-ca-cert
        certificate: ca.crt
    authentication:
      type: tls
      certificateAndKey:
        secretName: mm2-eu-west-1-user
        certificate: user.crt
        key: user.key
  mirrors:
  - sourceCluster: us-east-1
    targetCluster: eu-west-1
    sourceConnector:
      config:
        replication.factor: 3
        offset-syncs.topic.replication.factor: 3
        sync.topic.acls.enabled: "false"
        replication.policy.separator: "."
        replication.policy.class: org.apache.kafka.connect.mirror.IdentityReplicationPolicy
    heartbeatConnector:
      config:
        heartbeats.topic.replication.factor: 3
    checkpointConnector:
      config:
        checkpoints.topic.replication.factor: 3
        sync.group.offsets.enabled: "true"
        sync.group.offsets.interval.seconds: "60"
    topicsPattern: "order-.*|payment-.*|inventory-.*"
    groupsPattern: ".*"
```

The `IdentityReplicationPolicy` preserves topic names in the target cluster. The default `DefaultReplicationPolicy` prefixes topic names with `<source-cluster>.`, which is safer for active-active setups but requires consumer configuration changes.

### Monitoring Replication Lag

```bash
kubectl -n kafka exec -it production-kafka-kafka-0 -- \
  bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group mm2-us-to-eu \
  --describe | grep -E "TOPIC|LAG"
```

## Cruise Control for Partition Rebalancing

**Cruise Control** analyzes Kafka cluster load and generates rebalancing proposals to distribute partitions evenly across brokers. Strimzi integrates Cruise Control through the `KafkaRebalance` resource.

### Enabling Cruise Control in the Kafka Cluster

```yaml
spec:
  kafka:
    ...
  cruiseControl:
    config:
      replication.throttle: 10000000
      num.concurrent.partition.movements.per.broker: 5
      default.goals: >
        com.linkedin.kafka.cruisecontrol.analyzer.goals.RackAwareGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.DiskCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkInboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.NetworkOutboundCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.CpuCapacityGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.ReplicaDistributionGoal,
        com.linkedin.kafka.cruisecontrol.analyzer.goals.DiskUsageDistributionGoal
    resources:
      requests:
        memory: 512Mi
        cpu: 200m
      limits:
        memory: 1Gi
        cpu: 500m
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: cruise-control-metrics-config
          key: metrics-config.yml
```

### Requesting a Rebalance

Create a `KafkaRebalance` resource to trigger a proposal. The operator generates and evaluates the proposal before requiring explicit approval:

```yaml
# kafka-rebalance.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaRebalance
metadata:
  name: full-rebalance
  namespace: kafka
  labels:
    strimzi.io/cluster: production-kafka
spec:
  goals:
  - NetworkInboundCapacityGoal
  - DiskCapacityGoal
  - RackAwareGoal
  - NetworkOutboundCapacityGoal
  - CpuCapacityGoal
  - ReplicaCapacityGoal
  - ReplicaDistributionGoal
  - DiskUsageDistributionGoal
  - TopicReplicaDistributionGoal
  - LeaderReplicaDistributionGoal
  skipHardGoalCheck: false
```

Review the proposal, then approve it:

```bash
kubectl -n kafka get kafkarebalance full-rebalance -o yaml | \
  grep -A 20 "optimizationResult"

kubectl -n kafka annotate kafkarebalance full-rebalance \
  strimzi.io/rebalance=approve

kubectl -n kafka get kafkarebalance full-rebalance --watch
```

## Monitoring with JMX Exporter and Prometheus

### Enabling JMX Metrics

```yaml
spec:
  kafka:
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: kafka-metrics-config
          key: kafka-metrics-config.yml
```

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
    - pattern: kafka.server<type=(.+), name=(.+), clientId=(.+), topic=(.+), partition=(.*)><>Value
      name: kafka_server_$1_$2
      type: GAUGE
      labels:
        clientId: "$3"
        topic: "$4"
        partition: "$5"
    - pattern: kafka.server<type=(.+), name=(.+), clientId=(.+), brokerHost=(.+), brokerPort=(.+)><>Value
      name: kafka_server_$1_$2
      type: GAUGE
      labels:
        clientId: "$3"
        broker: "$4:$5"
    - pattern: kafka.server<type=(.+), name=(.+)><>OneMinuteRate
      name: kafka_server_$1_$2_rate1m
      type: GAUGE
    - pattern: kafka.controller<type=(.+), name=(.+)><>Value
      name: kafka_controller_$1_$2
      type: GAUGE
    - pattern: kafka.network<type=(.+), name=(.+)><>Value
      name: kafka_network_$1_$2
      type: GAUGE
    - pattern: kafka.log<type=(.+), name=(.+), topic=(.+), partition=(.+)><>Value
      name: kafka_log_$1_$2
      type: GAUGE
      labels:
        topic: "$3"
        partition: "$4"
```

### ServiceMonitor for Prometheus Operator

```yaml
# kafka-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kafka-metrics
  namespace: kafka
  labels:
    app: strimzi
spec:
  selector:
    matchLabels:
      strimzi.io/cluster: production-kafka
  endpoints:
  - port: tcp-prometheus
    path: /metrics
    interval: 30s
  namespaceSelector:
    matchNames:
    - kafka
```

### Key Kafka Metrics to Alert On

```bash
kafka_server_replicamanager_underreplicatedpartitions
kafka_controller_kafkacontroller_activecontrollercount
kafka_server_brokertopicmetrics_messagesin_rate1m
kafka_network_requestmetrics_requestspersec
kafka_server_replicafetchermanager_maxlag
```

## Rolling Upgrades with Zero Downtime

Strimzi performs rolling upgrades by restarting brokers one at a time. The operator respects `min.insync.replicas` and waits for each broker to rejoin the ISR before proceeding to the next.

### Kafka Version Upgrade

Update the `kafka.version` field in the `Kafka` resource:

```bash
kubectl patch kafka production-kafka -n kafka \
  --type merge \
  -p '{"spec":{"kafka":{"version":"3.8.0","metadataVersion":"3.8"}}}'

kubectl -n kafka get kafka production-kafka --watch
```

The operator performs the following sequence:
1. Updates broker configurations with the new version
2. Performs a rolling restart, one broker at a time
3. Waits for each broker to report healthy before proceeding
4. Updates the `inter.broker.protocol.version` after all brokers are on the new version

### Monitoring Upgrade Progress

```bash
kubectl -n kafka get pods -l strimzi.io/cluster=production-kafka --watch

kubectl -n kafka events --field-selector involvedObject.name=production-kafka

kubectl -n kafka logs deployment/strimzi-cluster-operator \
  --tail=100 | grep -i "rolling\|restart\|upgrade"
```

### Pausing and Resuming Rolling Updates

For emergency situations, the rolling update can be paused by annotating the Kafka resource:

```bash
kubectl -n kafka annotate kafka production-kafka \
  strimzi.io/pause-reconciliation=true

kubectl -n kafka annotate kafka production-kafka \
  strimzi.io/pause-reconciliation-
```

## Conclusion

Strimzi transforms Apache Kafka from a manually-operated distributed system into a declaratively managed Kubernetes workload. The key operational takeaways:

- **KafkaNodePool enables tiered storage architectures**: Separate pools of brokers with NVMe SSDs and large HDDs allow hot/warm tiering without managing separate clusters, reducing storage costs for high-retention topics.
- **Certificate rotation is fully automated**: The Cluster Operator rotates cluster CA and client CA certificates on a configurable schedule. `KafkaUser` certificates are renewed automatically before expiry, eliminating manual certificate management across large fleets.
- **Cruise Control is essential for cluster hygiene**: Without automated rebalancing, partition leaders concentrate on a subset of brokers over time as topics are created and deleted. A monthly `KafkaRebalance` proposal should be part of every production Kafka cluster's operational calendar.
- **MirrorMaker 2 offset synchronization enables transparent failover**: With `sync.group.offsets.enabled: true`, consumer groups in the target cluster reflect the latest committed offsets from the source, enabling consumer failover without reprocessing from the beginning.
- **`strimzi.io/pause-reconciliation` is the emergency brake**: When an operator-managed rolling restart is causing production issues, pausing reconciliation immediately stops the operator from taking further action while preserving cluster state.
