---
title: "Event Streaming with Apache Pulsar: Enterprise Multi-Tenant Messaging Platform"
date: 2026-07-07T00:00:00-05:00
draft: false
tags: ["Apache Pulsar", "Event Streaming", "Messaging", "Kubernetes", "Real-Time", "Pub-Sub", "Event-Driven"]
categories: ["Data Engineering", "Event Streaming", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Apache Pulsar for enterprise event streaming, including multi-tenancy configuration, geo-replication, Functions deployment, and production-ready architecture patterns on Kubernetes."
more_link: "yes"
url: "/event-streaming-apache-pulsar-enterprise-guide/"
---

Apache Pulsar provides a unified messaging and streaming platform with native multi-tenancy, geo-replication, and serverless functions. This comprehensive guide covers implementing production-grade Pulsar clusters on Kubernetes, including architecture design, multi-tenant configuration, stream processing, and operational excellence.

<!--more-->

# Event Streaming with Apache Pulsar: Enterprise Multi-Tenant Messaging Platform

## Executive Summary

Apache Pulsar is a cloud-native distributed messaging and streaming platform offering unified pub-sub and queue semantics, multi-tenancy, geo-replication, and serverless stream processing. This guide provides practical implementation strategies for deploying enterprise Pulsar clusters on Kubernetes with production-grade reliability and performance.

## Understanding Apache Pulsar Architecture

### Pulsar Component Architecture

**Pulsar System Architecture:**
```yaml
# pulsar-architecture.yaml
apiVersion: architecture.pulsar.apache.org/v1
kind: PulsarArchitecture
metadata:
  name: enterprise-pulsar-cluster
spec:
  components:
    brokers:
      role: "Stateless serving layer"
      responsibilities:
        - "Handle producer and consumer connections"
        - "Route messages to appropriate storage layer"
        - "Manage subscriptions and acknowledgments"
        - "Load balancing and topic ownership"
      scaling: "Horizontal"
      statefulness: "Stateless"

    bookKeeper:
      role: "Distributed log storage"
      responsibilities:
        - "Persist message data durably"
        - "Ensure message ordering"
        - "Provide low-latency writes"
        - "Handle data replication"
      scaling: "Horizontal"
      statefulness: "Stateful"

    zooKeeper:
      role: "Metadata and coordination"
      responsibilities:
        - "Store cluster metadata"
        - "Coordinate broker leadership"
        - "Manage topic ownership"
        - "Store configuration"
      scaling: "Fixed (3-5 nodes)"
      statefulness: "Stateful"

    proxy:
      role: "Service discovery and routing"
      responsibilities:
        - "Client connection endpoint"
        - "Service discovery"
        - "Protocol translation"
        - "Load balancing"
      scaling: "Horizontal"
      statefulness: "Stateless"

    functions:
      role: "Serverless stream processing"
      responsibilities:
        - "Event transformation"
        - "Filtering and routing"
        - "Stateful processing"
        - "Connector integration"
      scaling: "Auto-scaling"
      statefulness: "Optional"

  dataFlow:
    publication:
      - "Producer connects to broker"
      - "Broker determines topic ownership"
      - "Message written to BookKeeper"
      - "Acknowledgment returned to producer"

    consumption:
      - "Consumer subscribes to topic"
      - "Broker reads from BookKeeper"
      - "Messages delivered to consumer"
      - "Consumer acknowledges messages"

  storageModel:
    segments:
      description: "Topics divided into ledgers"
      distribution: "Distributed across BookKeeper nodes"
      replication: "Configurable (typically 2-3 replicas)"

    retention:
      timeBasedRetention: "Keep messages for X hours/days"
      sizeBasedRetention: "Keep up to X GB/TB"
      acknowledgmentBased: "Delete after all subscriptions acknowledge"

  multiTenancy:
    hierarchy: "tenant -> namespace -> topic"
    isolation:
      - "Resource quotas per tenant"
      - "Access control per namespace"
      - "Storage isolation"
      - "Network isolation"

  geoReplication:
    modes:
      - "Active-Active (multi-master)"
      - "Active-Standby (disaster recovery)"
    conflict: "Last-write-wins or custom resolution"
```

### Pulsar vs Kafka Comparison

**Technology Comparison:**
```go
// pulsar_comparison.go
package comparison

import (
    "fmt"
)

type MessagingPlatform struct {
    Name                string
    Architecture        string
    StorageModel        string
    MultiTenancy        string
    GeoReplication      string
    Ordering            string
    Subscriptions       []string
    StreamProcessing    string
    CloudNative         string
    OperationalModel    string
}

func GetPulsarProfile() MessagingPlatform {
    return MessagingPlatform{
        Name:             "Apache Pulsar",
        Architecture:     "Separated compute and storage (brokers + BookKeeper)",
        StorageModel:     "Segment-based storage, tiered storage support",
        MultiTenancy:     "Native multi-tenancy with quotas and isolation",
        GeoReplication:   "Native geo-replication with conflict resolution",
        Ordering:         "Per-partition ordering, with key-based ordering",
        Subscriptions:    []string{"Exclusive", "Shared", "Failover", "Key_Shared"},
        StreamProcessing: "Pulsar Functions (lightweight, serverless)",
        CloudNative:      "Designed for Kubernetes from the ground up",
        OperationalModel: "Easier scaling due to stateless brokers",
    }
}

func GetKafkaProfile() MessagingPlatform {
    return MessagingPlatform{
        Name:             "Apache Kafka",
        Architecture:     "Brokers with local storage",
        StorageModel:     "Log-based storage, tiered storage via plugins",
        MultiTenancy:     "Manual implementation via ACLs and quotas",
        GeoReplication:   "MirrorMaker or third-party tools",
        Ordering:         "Strict per-partition ordering",
        Subscriptions:    []string{"Consumer Groups"},
        StreamProcessing: "Kafka Streams (library-based)",
        CloudNative:      "Requires careful StatefulSet configuration",
        OperationalModel: "Complex rebalancing when scaling brokers",
    }
}

func PrintComparison() {
    pulsar := GetPulsarProfile()
    kafka := GetKafkaProfile()

    fmt.Println("===== Apache Pulsar vs Apache Kafka =====\n")

    fmt.Println("Architecture:")
    fmt.Printf("  Pulsar: %s\n", pulsar.Architecture)
    fmt.Printf("  Kafka:  %s\n\n", kafka.Architecture)

    fmt.Println("Multi-Tenancy:")
    fmt.Printf("  Pulsar: %s\n", pulsar.MultiTenancy)
    fmt.Printf("  Kafka:  %s\n\n", kafka.MultiTenancy)

    fmt.Println("Geo-Replication:")
    fmt.Printf("  Pulsar: %s\n", pulsar.GeoReplication)
    fmt.Printf("  Kafka:  %s\n\n", kafka.GeoReplication)

    fmt.Println("Subscription Models:")
    fmt.Printf("  Pulsar: %v\n", pulsar.Subscriptions)
    fmt.Printf("  Kafka:  %v\n\n", kafka.Subscriptions)

    fmt.Println("Stream Processing:")
    fmt.Printf("  Pulsar: %s\n", pulsar.StreamProcessing)
    fmt.Printf("  Kafka:  %s\n\n", kafka.StreamProcessing)

    fmt.Println("Cloud Native:")
    fmt.Printf("  Pulsar: %s\n", pulsar.CloudNative)
    fmt.Printf("  Kafka:  %s\n\n", kafka.CloudNative)
}

// Use case recommendations
func RecommendPlatform(requirements Requirements) string {
    score := 0

    if requirements.MultiTenant {
        score += 3 // Pulsar has better multi-tenancy
    }

    if requirements.GeoReplication {
        score += 2 // Pulsar has native geo-replication
    }

    if requirements.FlexibleSubscriptions {
        score += 2 // Pulsar has more subscription models
    }

    if requirements.CloudNative {
        score += 2 // Pulsar is more cloud-native
    }

    if requirements.SimpleOperations {
        score += 1 // Pulsar is easier to operate
    }

    if requirements.StrictOrdering {
        score -= 2 // Kafka has stricter ordering guarantees
    }

    if requirements.MatureEcosystem {
        score -= 3 // Kafka has more mature ecosystem
    }

    if score > 2 {
        return "Apache Pulsar recommended"
    } else if score < -2 {
        return "Apache Kafka recommended"
    } else {
        return "Both platforms suitable - choose based on team expertise"
    }
}

type Requirements struct {
    MultiTenant           bool
    GeoReplication        bool
    FlexibleSubscriptions bool
    CloudNative           bool
    SimpleOperations      bool
    StrictOrdering        bool
    MatureEcosystem       bool
}
```

## Pulsar Deployment on Kubernetes

### Production Pulsar Cluster

**Complete Pulsar Helm Installation:**
```bash
#!/bin/bash
# deploy-pulsar.sh
# Deploy production-grade Apache Pulsar on Kubernetes

set -euo pipefail

NAMESPACE="pulsar"
RELEASE_NAME="pulsar"
CHART_VERSION="3.0.0"

echo "Deploying Apache Pulsar to Kubernetes..."

# Create namespace
kubectl create namespace ${NAMESPACE} || true

# Add Pulsar Helm repository
helm repo add apache https://pulsar.apache.org/charts
helm repo update

# Install Pulsar with production values
helm install ${RELEASE_NAME} apache/pulsar \
    --namespace ${NAMESPACE} \
    --version ${CHART_VERSION} \
    --values - <<EOF
# Production configuration for Apache Pulsar

# ZooKeeper configuration
zookeeper:
  replicaCount: 3
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
  configData:
    PULSAR_MEM: "-Xms2g -Xmx2g -XX:MaxDirectMemorySize=2g"
    PULSAR_GC: "-XX:+UseG1GC -XX:MaxGCPauseMillis=10"
  persistence:
    data:
      storageClassName: "fast-ssd"
      size: 20Gi
    dataLog:
      storageClassName: "fast-ssd"
      size: 20Gi

# BookKeeper configuration
bookkeeper:
  replicaCount: 4
  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
  configData:
    PULSAR_MEM: "-Xms4g -Xmx4g -XX:MaxDirectMemorySize=8g"
    PULSAR_GC: "-XX:+UseG1GC -XX:MaxGCPauseMillis=10"
    # Write cache
    dbStorage_writeCacheMaxSizeMb: "2048"
    dbStorage_readAheadCacheMaxSizeMb: "2048"
    # Journal
    journalMaxSizeMB: "2048"
    journalMaxBackups: "5"
    # Ledger storage
    ledgerStorageClass: "org.apache.bookkeeper.bookie.storage.ldb.DbLedgerStorage"
  persistence:
    journal:
      storageClassName: "fast-ssd"
      size: 50Gi
    ledgers:
      storageClassName: "standard-ssd"
      size: 200Gi

# Broker configuration
broker:
  replicaCount: 3
  resources:
    requests:
      cpu: 1000m
      memory: 4Gi
  configData:
    PULSAR_MEM: "-Xms4g -Xmx4g -XX:MaxDirectMemorySize=4g"
    PULSAR_GC: "-XX:+UseG1GC -XX:MaxGCPauseMillis=10"
    # Broker settings
    managedLedgerDefaultEnsembleSize: "3"
    managedLedgerDefaultWriteQuorum: "3"
    managedLedgerDefaultAckQuorum: "2"
    # Load balancing
    loadBalancerEnabled: "true"
    loadBalancerSheddingEnabled: "true"
    # Message deduplication
    brokerDeduplicationEnabled: "true"
    # Retention
    backlogQuotaDefaultLimitGB: "100"
    backlogQuotaDefaultRetentionPolicy: "producer_exception"

# Proxy configuration
proxy:
  replicaCount: 3
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
  service:
    type: LoadBalancer
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: "nlb"

# Monitoring
prometheus:
  enabled: true
  resources:
    requests:
      cpu: 200m
      memory: 1Gi
  persistence:
    storageClassName: "standard-ssd"
    size: 50Gi

grafana:
  enabled: true
  resources:
    requests:
      cpu: 100m
      memory: 512Mi
  adminPassword: "admin123"  # Change in production

# Pulsar Manager (Admin UI)
manager:
  enabled: true
  resources:
    requests:
      cpu: 200m
      memory: 512Mi

# Functions Worker
functions:
  enabled: true
  replicaCount: 3
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
EOF

echo "Waiting for Pulsar to be ready..."
kubectl wait --for=condition=Ready pods --all -n ${NAMESPACE} --timeout=600s

echo "Pulsar deployment complete!"
echo ""
echo "Access Pulsar Manager:"
echo "kubectl port-forward -n ${NAMESPACE} svc/${RELEASE_NAME}-pulsar-manager 9527:9527"
echo ""
echo "Access Grafana:"
echo "kubectl port-forward -n ${NAMESPACE} svc/${RELEASE_NAME}-grafana 3000:3000"
```

**Pulsar Configuration Manifests:**
```yaml
# pulsar-configuration.yaml
---
# Tenant configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: pulsar-tenants
  namespace: pulsar
data:
  tenants.conf: |
    # Enterprise tenant
    tenant: enterprise
    allowedClusters:
      - us-west
      - us-east
      - eu-west
    adminRoles:
      - admin
      - platform-team

    # Team-specific tenants
    tenant: team-analytics
    allowedClusters:
      - us-west
    adminRoles:
      - analytics-admin
    resourceQuotas:
      msgRateIn: 10000
      msgRateOut: 20000
      bandwidthIn: 100MB
      bandwidthOut: 200MB
      memory: 10GB
      storage: 1TB

---
# Namespace policies
apiVersion: v1
kind: ConfigMap
metadata:
  name: pulsar-namespace-policies
  namespace: pulsar
data:
  policies.conf: |
    # Production namespace
    namespace: enterprise/production
    retention:
      retentionTimeInMinutes: 10080  # 7 days
      retentionSizeInMB: 102400      # 100 GB
    ttl: 604800  # 7 days in seconds
    deduplication: true
    encryption: true
    replication:
      - us-west
      - us-east
    backlogQuota:
      limit: 107374182400  # 100 GB
      policy: producer_exception

    # Development namespace
    namespace: enterprise/development
    retention:
      retentionTimeInMinutes: 1440  # 1 day
      retentionSizeInMB: 10240      # 10 GB
    ttl: 86400  # 1 day
    replication:
      - us-west

---
# Topic configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: pulsar-topic-config
  namespace: pulsar
data:
  topics.conf: |
    # User events topic
    topic: persistent://enterprise/production/user-events
    partitions: 16
    retentionPolicy:
      retentionTimeInMinutes: 10080
    messageDeduplication: true
    maxProducersPerTopic: 100
    maxConsumersPerTopic: 100
    maxUnackedMessagesPerConsumer: 10000
    maxUnackedMessagesPerSubscription: 200000

    # Order events topic
    topic: persistent://enterprise/production/order-events
    partitions: 32
    retentionPolicy:
      retentionTimeInMinutes: 43200  # 30 days
    messageDeduplication: true
    compactionThreshold: 10485760  # 10 MB

---
# Pulsar admin operations
apiVersion: batch/v1
kind: Job
metadata:
  name: pulsar-setup
  namespace: pulsar
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: setup
          image: apachepulsar/pulsar:3.0.0
          command:
            - /bin/bash
            - -c
            - |
              # Wait for Pulsar to be ready
              until pulsar-admin brokers healthcheck; do
                echo "Waiting for Pulsar..."
                sleep 5
              done

              # Create tenants
              pulsar-admin tenants create enterprise \
                --allowed-clusters us-west,us-east,eu-west \
                --admin-roles admin,platform-team

              pulsar-admin tenants create team-analytics \
                --allowed-clusters us-west \
                --admin-roles analytics-admin

              # Create namespaces
              pulsar-admin namespaces create enterprise/production
              pulsar-admin namespaces create enterprise/development
              pulsar-admin namespaces create team-analytics/data

              # Set namespace policies
              pulsar-admin namespaces set-retention enterprise/production \
                --size 100G --time 7d

              pulsar-admin namespaces set-deduplication enterprise/production \
                --enable

              pulsar-admin namespaces set-encryption-required enterprise/production \
                --enable

              # Set replication
              pulsar-admin namespaces set-clusters enterprise/production \
                --clusters us-west,us-east

              # Create topics
              pulsar-admin topics create-partitioned-topic \
                persistent://enterprise/production/user-events \
                --partitions 16

              pulsar-admin topics create-partitioned-topic \
                persistent://enterprise/production/order-events \
                --partitions 32

              echo "Pulsar setup complete!"

          env:
            - name: PULSAR_CLIENT_CONF
              value: /pulsar/conf/client.conf
          volumeMounts:
            - name: pulsar-client-config
              mountPath: /pulsar/conf

      volumes:
        - name: pulsar-client-config
          configMap:
            name: pulsar-client-config
```

## Pulsar Client Applications

### Producer and Consumer Implementations

**Java Producer/Consumer:**
```java
// PulsarProducerExample.java
package com.company.pulsar;

import org.apache.pulsar.client.api.*;
import org.apache.pulsar.client.api.schema.GenericRecord;
import org.apache.pulsar.client.impl.schema.AvroSchema;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public class PulsarProducerExample {

    // Event schema
    public static class UserEvent {
        public String userId;
        public String eventType;
        public long timestamp;
        public Map<String, String> properties;
    }

    public static void main(String[] args) throws Exception {
        // Create Pulsar client
        PulsarClient client = PulsarClient.builder()
            .serviceUrl("pulsar://pulsar-proxy:6650")
            .connectionTimeout(10, TimeUnit.SECONDS)
            .operationTimeout(15, TimeUnit.SECONDS)
            .enableTls(true)
            .tlsTrustCertsFilePath("/path/to/ca-cert.pem")
            .authentication(
                AuthenticationFactory.token("your-jwt-token")
            )
            .build();

        // Create producer with schema
        Producer<UserEvent> producer = client.newProducer(AvroSchema.of(UserEvent.class))
            .topic("persistent://enterprise/production/user-events")
            .producerName("user-event-producer")
            // Enable batching
            .batchingMaxPublishDelay(10, TimeUnit.MILLISECONDS)
            .batchingMaxMessages(1000)
            // Enable compression
            .compressionType(CompressionType.LZ4)
            // Message routing
            .messageRoutingMode(MessageRoutingMode.RoundRobinPartition)
            // Delivery semantics
            .blockIfQueueFull(true)
            .maxPendingMessages(1000)
            // Error handling
            .sendTimeout(30, TimeUnit.SECONDS)
            .create();

        // Send messages
        for (int i = 0; i < 100; i++) {
            UserEvent event = new UserEvent();
            event.userId = "user-" + i;
            event.eventType = "page_view";
            event.timestamp = System.currentTimeMillis();

            // Async send with callback
            CompletableFuture<MessageId> future = producer.newMessage()
                .key(event.userId)  // Key for ordering
                .property("priority", "high")
                .eventTime(event.timestamp)
                .value(event)
                .sendAsync();

            future.thenAccept(msgId -> {
                System.out.println("Message published: " + msgId);
            }).exceptionally(ex -> {
                System.err.println("Failed to publish: " + ex.getMessage());
                return null;
            });
        }

        // Flush pending messages
        producer.flush();

        // Close resources
        producer.close();
        client.close();
    }
}

// PulsarConsumerExample.java
package com.company.pulsar;

import org.apache.pulsar.client.api.*;

import java.util.concurrent.TimeUnit;

public class PulsarConsumerExample {

    public static void main(String[] args) throws Exception {
        PulsarClient client = PulsarClient.builder()
            .serviceUrl("pulsar://pulsar-proxy:6650")
            .build();

        // Exclusive subscription (only one consumer)
        Consumer<UserEvent> exclusiveConsumer = client.newConsumer(AvroSchema.of(UserEvent.class))
            .topic("persistent://enterprise/production/user-events")
            .subscriptionName("exclusive-subscription")
            .subscriptionType(SubscriptionType.Exclusive)
            .subscribe();

        // Shared subscription (multiple consumers, no ordering)
        Consumer<UserEvent> sharedConsumer = client.newConsumer(AvroSchema.of(UserEvent.class))
            .topic("persistent://enterprise/production/user-events")
            .subscriptionName("shared-subscription")
            .subscriptionType(SubscriptionType.Shared)
            .receiverQueueSize(1000)
            .subscribe();

        // Key_Shared subscription (multiple consumers, per-key ordering)
        Consumer<UserEvent> keySharedConsumer = client.newConsumer(AvroSchema.of(UserEvent.class))
            .topic("persistent://enterprise/production/user-events")
            .subscriptionName("key-shared-subscription")
            .subscriptionType(SubscriptionType.Key_Shared)
            .subscribe();

        // Failover subscription (active-standby pattern)
        Consumer<UserEvent> failoverConsumer = client.newConsumer(AvroSchema.of(UserEvent.class))
            .topic("persistent://enterprise/production/user-events")
            .subscriptionName("failover-subscription")
            .subscriptionType(SubscriptionType.Failover)
            .subscribe();

        // Consume messages
        while (true) {
            Message<UserEvent> msg = keySharedConsumer.receive(100, TimeUnit.MILLISECONDS);
            if (msg != null) {
                try {
                    // Process message
                    UserEvent event = msg.getValue();
                    System.out.println("Received: " + event.userId + " - " + event.eventType);

                    // Process event
                    processEvent(event);

                    // Acknowledge message
                    keySharedConsumer.acknowledge(msg);

                } catch (Exception e) {
                    // Negative acknowledge (will be redelivered)
                    keySharedConsumer.negativeAcknowledge(msg);
                    System.err.println("Failed to process message: " + e.getMessage());
                }
            }
        }
    }

    private static void processEvent(UserEvent event) {
        // Business logic here
    }
}
```

## Pulsar Functions for Stream Processing

**Function Deployment:**
```yaml
# pulsar-functions.yaml
---
# Word count function
apiVersion: v1
kind: ConfigMap
metadata:
  name: word-count-function
  namespace: pulsar
data:
  function-config.yaml: |
    tenant: enterprise
    namespace: production
    name: word-count-function
    className: com.company.functions.WordCountFunction
    inputs:
      - persistent://enterprise/production/text-input
    output: persistent://enterprise/production/word-counts
    logTopic: persistent://enterprise/production/function-logs
    runtime: JAVA
    parallelism: 4
    resources:
      cpu: 0.5
      ram: 1073741824  # 1 GB
    processingGuarantees: EFFECTIVELY_ONCE
    autoAck: true
    maxMessageRetries: 3
    deadLetterTopic: persistent://enterprise/production/word-count-dlq

---
# Function deployment
apiVersion: batch/v1
kind: Job
metadata:
  name: deploy-word-count-function
  namespace: pulsar
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: deploy
          image: apachepulsar/pulsar:3.0.0
          command:
            - /bin/bash
            - -c
            - |
              # Deploy function
              pulsar-admin functions create \
                --tenant enterprise \
                --namespace production \
                --name word-count \
                --jar /functions/word-count-function.jar \
                --classname com.company.functions.WordCountFunction \
                --inputs persistent://enterprise/production/text-input \
                --output persistent://enterprise/production/word-counts \
                --log-topic persistent://enterprise/production/function-logs \
                --parallelism 4 \
                --cpu 0.5 \
                --ram 1073741824 \
                --processing-guarantees EFFECTIVELY_ONCE

              echo "Function deployed successfully!"
          volumeMounts:
            - name: function-jar
              mountPath: /functions

      volumes:
        - name: function-jar
          configMap:
            name: function-jars
```

## Monitoring and Operations

**Pulsar Metrics Dashboard:**
```yaml
# pulsar-monitoring.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: pulsar-grafana-dashboard
  namespace: monitoring
data:
  pulsar-dashboard.json: |
    {
      "dashboard": {
        "title": "Apache Pulsar Metrics",
        "panels": [
          {
            "title": "Message Rate In",
            "targets": [{
              "expr": "sum(rate(pulsar_broker_message_in_total[5m]))"
            }]
          },
          {
            "title": "Message Rate Out",
            "targets": [{
              "expr": "sum(rate(pulsar_broker_message_out_total[5m]))"
            }]
          },
          {
            "title": "Throughput In",
            "targets": [{
              "expr": "sum(rate(pulsar_broker_bytes_in_total[5m]))"
            }]
          },
          {
            "title": "Throughput Out",
            "targets": [{
              "expr": "sum(rate(pulsar_broker_bytes_out_total[5m]))"
            }]
          },
          {
            "title": "Storage Size",
            "targets": [{
              "expr": "sum(pulsar_broker_storage_size)"
            }]
          },
          {
            "title": "Backlog Size",
            "targets": [{
              "expr": "sum(pulsar_broker_backlog_size)"
            }]
          },
          {
            "title": "Consumer Count",
            "targets": [{
              "expr": "sum(pulsar_broker_consumers_count)"
            }]
          },
          {
            "title": "Producer Count",
            "targets": [{
              "expr": "sum(pulsar_broker_producers_count)"
            }]
          }
        ]
      }
    }
```

## Conclusion

Apache Pulsar provides enterprises with:

1. **Native Multi-Tenancy**: Built-in tenant isolation and resource quotas
2. **Geo-Replication**: Active-active replication across data centers
3. **Unified Messaging**: Pub-sub and queue semantics in single platform
4. **Cloud-Native**: Separated compute and storage for elastic scaling
5. **Serverless Processing**: Pulsar Functions for lightweight stream processing
6. **Tiered Storage**: Automatic offloading to object storage for cost efficiency

By implementing Pulsar with the patterns in this guide, organizations can build scalable, reliable event streaming platforms that meet enterprise requirements.

For more information on Apache Pulsar and event streaming, visit [support.tools](https://support.tools).