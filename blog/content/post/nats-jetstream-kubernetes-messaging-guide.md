---
title: "NATS JetStream: Cloud-Native Messaging and Event Streaming on Kubernetes"
date: 2027-03-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NATS", "JetStream", "Messaging", "Event Streaming"]
categories: ["Kubernetes", "Messaging", "Event Streaming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to NATS JetStream on Kubernetes covering cluster deployment with NATS Operator, stream and consumer configuration, exactly-once delivery, Key-Value and Object Store APIs, Prometheus monitoring, and leaf node hub-and-spoke topology."
more_link: "yes"
url: "/nats-jetstream-kubernetes-messaging-guide/"
---

NATS JetStream transforms NATS from a simple publish-subscribe system into a durable, at-least-once and exactly-once message streaming platform that rivals Apache Kafka in throughput while dramatically simplifying operational overhead. Running NATS on Kubernetes with the NATS Operator gives platform teams a messaging backbone that scales from a three-node development cluster to a globally distributed hub-and-spoke topology with leaf nodes — all without ZooKeeper, broker coordinators, or external dependency clusters.

This guide covers everything needed to run NATS JetStream in production: cluster deployment with the NATS Operator, stream and consumer configuration, exactly-once semantics via deduplication windows, the Key-Value and Object Store APIs, Prometheus observability, and a multi-region leaf node architecture for minimizing cross-region latency.

<!--more-->

## NATS vs Kafka vs RabbitMQ: Positioning for Cloud-Native Workloads

Before deploying NATS JetStream, understanding where it fits relative to established messaging systems clarifies the architectural tradeoffs involved.

### Throughput and Latency Characteristics

Apache Kafka optimizes for high-throughput batch consumption of ordered logs stored durably on disk. It excels when consumers are always-on, the message format is well-defined, and operational teams can manage broker racks, Zookeeper quorums (or KRaft controllers), and partition rebalancing events. Kafka's median publish latency sits in the single-digit milliseconds range under moderate load but increases significantly under high producer concurrency.

RabbitMQ excels at AMQP-based routing, complex queue topologies with bindings and exchanges, and push-based delivery to consumer pools with per-message acknowledgment. Its throughput ceiling is lower than Kafka for pure streaming scenarios, but its routing flexibility and mature plugin ecosystem make it appropriate for traditional enterprise integration patterns.

NATS JetStream occupies the space between the two: sub-millisecond publish latency at high concurrency, at-least-once and exactly-once delivery guarantees, a lightweight storage model backed by a built-in distributed key-value store (NutsDB or built-in NATS file storage), and a cluster that self-elects leaders via Raft without any external coordination dependency. A three-node NATS cluster with JetStream enabled is operationally comparable in complexity to a single Kafka broker without replicas.

### Feature Comparison

| Feature | NATS JetStream | Apache Kafka | RabbitMQ |
|---|---|---|---|
| At-least-once delivery | Yes | Yes | Yes |
| Exactly-once semantics | Yes (dedup window) | Yes (idempotent producers) | Limited |
| Pull consumers | Yes | Yes | Yes |
| Push consumers | Yes | No | Yes |
| Key-Value store | Yes (built-in) | No | No |
| Object store | Yes (built-in) | No | No |
| Multi-region native | Yes (leaf nodes) | Yes (MirrorMaker 2) | Yes (federation) |
| Operational complexity | Low | High | Medium |
| Storage overhead | Low | High | Medium |

## Installing the NATS Operator on Kubernetes

The NATS Operator manages `NatsCluster` custom resources and handles rolling upgrades, TLS certificate rotation, and cluster membership changes without manual intervention.

### Adding the Helm Repository

```bash
# Add the NATS Helm repository
helm repo add nats https://nats-io.github.io/k8s/helm/charts/

# Update the local cache
helm repo update

# Verify available charts
helm search repo nats/
```

### Deploying the NATS Operator

The NATS Operator runs as a Deployment and watches `NatsCluster` resources across all namespaces by default.

```yaml
# nats-operator-values.yaml
# Production values for the NATS Operator Helm chart
operator:
  image:
    repository: natsio/nats-operator
    tag: "0.8.3"
    pullPolicy: IfNotPresent

  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 256Mi

  # Allow watching all namespaces
  clusterScoped: true

  # Enable leader election for HA operator deployment
  leaderElection:
    enabled: true

rbac:
  create: true

serviceAccount:
  create: true
  name: nats-operator
```

```bash
# Deploy the NATS Operator into its own namespace
helm upgrade --install nats-operator nats/nats-operator \
  --namespace nats-system \
  --create-namespace \
  --values nats-operator-values.yaml \
  --wait
```

### Deploying a JetStream-Enabled NATS Cluster

The `NatsCluster` CRD is the primary resource for declaring a NATS cluster with JetStream enabled.

```yaml
# nats-cluster.yaml
# Three-node NATS cluster with JetStream and TLS
apiVersion: nats.io/v1alpha2
kind: NatsCluster
metadata:
  name: nats-main
  namespace: messaging
spec:
  # Number of NATS server pods
  size: 3

  # NATS server version
  version: "2.10.14"

  # JetStream configuration
  natsConfig:
    jetstream: true
    maxPayload: 8MB
    debug: false
    trace: false

  # Resource allocation per pod
  pod:
    resources:
      requests:
        cpu: 500m
        memory: 512Mi
      limits:
        cpu: 2000m
        memory: 2Gi
    # Anti-affinity to spread pods across nodes
    antiAffinity: true

  # Persistent storage for JetStream
  jetstream:
    fileStorage:
      enabled: true
      size: 50Gi
      storageClassName: fast-ssd
      accessModes:
        - ReadWriteOnce

  # TLS configuration using cert-manager certificates
  tls:
    serverSecret: nats-server-tls
    routesSecret: nats-routes-tls
    clientsSecret: nats-clients-tls
    # Enable mTLS for client connections
    verify: true
    # CA used to verify client certificates
    caFile: /etc/nats/certs/ca.crt

  # Authorization configuration
  auth:
    enableServiceAccounts: true
    # Operator JWT for decentralized auth
    operatorSecret: nats-operator-jwt

  # Extra command-line arguments passed to the server
  extraCmdArgs:
    - --max_outstanding_pings=5
    - --ping_interval=10s
```

### Generating TLS Certificates with cert-manager

```yaml
# nats-tls-certs.yaml
# Certificate for NATS server TLS
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: nats-server-tls
  namespace: messaging
spec:
  secretName: nats-server-tls
  duration: 8760h    # 1 year
  renewBefore: 720h  # Renew 30 days before expiry
  subject:
    organizations:
      - support.tools
  dnsNames:
    - nats-main
    - nats-main.messaging
    - nats-main.messaging.svc
    - nats-main.messaging.svc.cluster.local
    - "*.nats-main.messaging.svc.cluster.local"
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
---
# Certificate for cluster routes (server-to-server)
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: nats-routes-tls
  namespace: messaging
spec:
  secretName: nats-routes-tls
  duration: 8760h
  renewBefore: 720h
  dnsNames:
    - nats-main
    - "*.nats-main.messaging.svc.cluster.local"
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
```

## JetStream Stream Configuration

A JetStream stream is a persistent log of messages on one or more subjects. Streams define how messages are stored, how long they are retained, and how many replicas are maintained across the cluster.

### Creating Streams via NATS CLI

```bash
# Install the NATS CLI
brew install nats-io/nats-tools/nats

# Connect to the cluster (with TLS and credentials)
export NATS_URL="nats://nats-main.messaging.svc.cluster.local:4222"

# Create an orders stream that captures all order events
nats stream add ORDERS \
  --subjects "orders.>" \
  --storage file \
  --replicas 3 \
  --retention limits \
  --max-age 30d \
  --max-bytes 100GB \
  --max-msg-size 1MB \
  --discard old \
  --dupe-window 2m \
  --description "Order processing event stream" \
  --server "$NATS_URL" \
  --tlscert /etc/nats/certs/tls.crt \
  --tlskey /etc/nats/certs/tls.key \
  --tlsca /etc/nats/certs/ca.crt
```

### Stream Configuration via Kubernetes Job

For GitOps workflows, stream configuration can be applied via a Kubernetes Job that runs during deployment.

```yaml
# stream-setup-job.yaml
# Job to create or update JetStream streams
apiVersion: batch/v1
kind: Job
metadata:
  name: nats-stream-setup
  namespace: messaging
  annotations:
    # Ensures Helm runs this during each upgrade
    helm.sh/hook: post-install,post-upgrade
    helm.sh/hook-weight: "1"
    helm.sh/hook-delete-policy: hook-succeeded
spec:
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: nats-cli
          image: natsio/nats-box:0.14.3
          command:
            - /bin/sh
            - -c
            - |
              # Wait for NATS to be ready
              until nats server check --server "$NATS_URL"; do
                echo "Waiting for NATS cluster..."
                sleep 5
              done

              # Create or update the ORDERS stream
              nats stream add ORDERS \
                --subjects "orders.>" \
                --storage file \
                --replicas 3 \
                --retention limits \
                --max-age 720h \
                --dupe-window 2m \
                --update 2>/dev/null || true

              # Create the NOTIFICATIONS stream with work-queue retention
              nats stream add NOTIFICATIONS \
                --subjects "notifications.>" \
                --storage file \
                --replicas 3 \
                --retention workqueue \
                --max-age 24h \
                --dupe-window 5m \
                --update 2>/dev/null || true

              echo "Stream setup complete"
          env:
            - name: NATS_URL
              value: "nats://nats-main.messaging.svc.cluster.local:4222"
          volumeMounts:
            - name: nats-tls
              mountPath: /etc/nats/certs
              readOnly: true
      volumes:
        - name: nats-tls
          secret:
            secretName: nats-clients-tls
```

### Stream Retention Policies

NATS JetStream supports three retention policies that govern when messages are removed from a stream.

**Limits retention** (default): Messages are retained until age, byte, or message count limits are reached. Oldest messages are discarded first when limits are hit. This policy is appropriate for event logs where historical replay is required.

**WorkQueue retention**: Messages are removed from the stream once they have been acknowledged by any consumer. This policy is appropriate for task queues where each message should be processed exactly once by one consumer.

**Interest retention**: Messages are retained until all registered consumers have acknowledged them. This policy ensures all interested parties receive every message before it is discarded.

```bash
# Inspect the current stream configuration
nats stream info ORDERS

# View stream statistics
nats stream report

# Edit stream configuration (replicas, limits)
nats stream edit ORDERS --max-age 60d
```

## Consumer Configuration

Consumers are views into a stream that track progress for a particular consumer group. JetStream supports both push (server delivers to a subscription) and pull (consumer explicitly requests batches) delivery modes.

### Pull Consumer for Microservices

Pull consumers give the application control over when and how many messages are fetched, making them ideal for workloads that need backpressure support and controlled concurrency.

```bash
# Create a durable pull consumer for order processing
nats consumer add ORDERS order-processor \
  --pull \
  --deliver all \
  --filter "orders.created" \
  --ack explicit \
  --max-deliver 5 \
  --ack-wait 30s \
  --max-pending 100 \
  --description "Order creation processor"
```

### Push Consumer for Real-Time Dashboards

Push consumers are appropriate for low-latency monitoring and dashboard scenarios where the application wants continuous message delivery without polling.

```bash
# Create a push consumer delivering to a subject
nats consumer add ORDERS dashboard-monitor \
  --push \
  --deliver last \
  --filter "orders.>" \
  --ack none \
  --target "dashboard.orders" \
  --description "Real-time dashboard feed"
```

### Consumer Delivery Policies

| Policy | Description | Use Case |
|---|---|---|
| `all` | Deliver all messages from stream beginning | Full replay, data migration |
| `last` | Deliver only the most recent message | Dashboard initialization |
| `new` | Deliver only messages published after consumer creation | Real-time monitoring |
| `by_start_time` | Deliver from a specific timestamp | Resuming after an outage |
| `by_start_sequence` | Deliver from a specific sequence number | Checkpoint-based recovery |

## Exactly-Once Semantics with Deduplication

NATS JetStream provides exactly-once delivery through a combination of publisher-assigned message IDs and a deduplication window on the stream.

### Publisher-Side Deduplication

Publishers include a unique `Nats-Msg-Id` header with each message. JetStream tracks seen IDs within the stream's `dupe-window` and silently discards duplicate messages.

```go
// publish_dedup.go
// Example Go client with exactly-once publish semantics
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/google/uuid"
    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func publishOrderCreated(ctx context.Context, js jetstream.JetStream, orderID string, payload []byte) error {
    // Generate a deterministic message ID tied to the business event
    // This allows idempotent retries: the same orderID always produces the same msgID
    msgID := fmt.Sprintf("order-created-%s", orderID)

    msg := &nats.Msg{
        Subject: fmt.Sprintf("orders.created"),
        Data:    payload,
        Header:  nats.Header{},
    }
    // Set the deduplication header
    msg.Header.Set(nats.MsgIdHdr, msgID)

    // Publish with acknowledgment and context timeout
    ack, err := js.PublishMsg(ctx, msg)
    if err != nil {
        return fmt.Errorf("publish failed: %w", err)
    }

    // Check if this was a duplicate (server already has a message with this ID)
    if ack.Duplicate {
        log.Printf("Duplicate message detected for order %s — skipping", orderID)
        return nil
    }

    log.Printf("Order %s published: stream=%s seq=%d", orderID, ack.Stream, ack.Sequence)
    return nil
}

func main() {
    // Connect to NATS with TLS and NKey authentication
    nc, err := nats.Connect(
        "nats://nats-main.messaging.svc.cluster.local:4222",
        nats.RootCAs("/etc/nats/certs/ca.crt"),
        nats.ClientCert("/etc/nats/certs/tls.crt", "/etc/nats/certs/tls.key"),
        nats.MaxReconnects(10),
        nats.ReconnectWait(2*time.Second),
        nats.DisconnectErrHandler(func(c *nats.Conn, err error) {
            log.Printf("NATS disconnected: %v", err)
        }),
        nats.ReconnectHandler(func(c *nats.Conn) {
            log.Printf("NATS reconnected to %s", c.ConnectedUrl())
        }),
    )
    if err != nil {
        log.Fatalf("Failed to connect to NATS: %v", err)
    }
    defer nc.Close()

    // Create JetStream context
    js, err := jetstream.New(nc)
    if err != nil {
        log.Fatalf("Failed to create JetStream context: %v", err)
    }

    ctx := context.Background()

    // Publish a test order event
    orderID := uuid.New().String()
    payload := []byte(fmt.Sprintf(`{"order_id":"%s","amount":99.99,"currency":"USD"}`, orderID))

    if err := publishOrderCreated(ctx, js, orderID, payload); err != nil {
        log.Fatalf("Failed to publish order: %v", err)
    }
}
```

### Consumer-Side Acknowledgment for Exactly-Once

On the consumer side, exactly-once processing requires explicit acknowledgment only after successful processing, combined with idempotent business logic.

```go
// consumer_pull.go
// Pull consumer with explicit acknowledgment
package main

import (
    "context"
    "log"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func startOrderProcessor(ctx context.Context, js jetstream.JetStream) error {
    // Bind to the existing durable consumer
    consumer, err := js.Consumer(ctx, "ORDERS", "order-processor")
    if err != nil {
        return fmt.Errorf("failed to bind consumer: %w", err)
    }

    // Fetch messages in batches of 10 with a 5-second wait
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        msgBatch, err := consumer.FetchNoWait(10)
        if err != nil {
            log.Printf("Fetch error: %v", err)
            time.Sleep(1 * time.Second)
            continue
        }

        for msg := range msgBatch.Messages() {
            if err := processOrder(msg); err != nil {
                // Negative acknowledge — message will be redelivered after ack-wait
                log.Printf("Processing failed for seq %d: %v", msg.Metadata().Sequence.Stream, err)
                if nakErr := msg.Nak(); nakErr != nil {
                    log.Printf("NAK failed: %v", nakErr)
                }
                continue
            }

            // Positive acknowledge — removes from pending delivery
            if err := msg.Ack(); err != nil {
                log.Printf("ACK failed for seq %d: %v", msg.Metadata().Sequence.Stream, err)
            }
        }

        if msgBatch.Error() != nil {
            log.Printf("Batch error: %v", msgBatch.Error())
        }
    }
}

func processOrder(msg jetstream.Msg) error {
    meta, _ := msg.Metadata()
    log.Printf("Processing order: subject=%s seq=%d redelivered=%d",
        msg.Subject(), meta.Sequence.Stream, meta.NumDelivered)

    // Business logic here — must be idempotent for exactly-once semantics
    return nil
}
```

## Key-Value Store API

JetStream's Key-Value store provides a distributed, persistent, watched key-value API backed by a JetStream stream. It supports TTL, per-key history, and cross-cluster mirroring.

### Creating a Key-Value Bucket

```bash
# Create a KV bucket for service configuration
nats kv add service-config \
  --replicas 3 \
  --ttl 24h \
  --history 10 \
  --storage file \
  --description "Service runtime configuration"
```

### Key-Value Operations in Go

```go
// kv_operations.go
// Key-Value store operations with JetStream
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func runKVOperations(nc *nats.Conn) error {
    js, err := jetstream.New(nc)
    if err != nil {
        return fmt.Errorf("jetstream context: %w", err)
    }

    ctx := context.Background()

    // Open an existing KV bucket
    kv, err := js.KeyValue(ctx, "service-config")
    if err != nil {
        return fmt.Errorf("open bucket: %w", err)
    }

    // Put a value — returns the revision number
    rev, err := kv.Put(ctx, "feature.dark-mode.enabled", []byte("true"))
    if err != nil {
        return fmt.Errorf("put: %w", err)
    }
    log.Printf("Put succeeded at revision %d", rev)

    // Get a value
    entry, err := kv.Get(ctx, "feature.dark-mode.enabled")
    if err != nil {
        return fmt.Errorf("get: %w", err)
    }
    log.Printf("Key=%s Value=%s Revision=%d Created=%v",
        entry.Key(), string(entry.Value()), entry.Revision(), entry.Created())

    // Update with optimistic locking — fails if revision does not match
    newRev, err := kv.Update(ctx, "feature.dark-mode.enabled", []byte("false"), rev)
    if err != nil {
        return fmt.Errorf("update (revision conflict or key missing): %w", err)
    }
    log.Printf("Updated to revision %d", newRev)

    // Watch a key for changes (reactive configuration)
    watcher, err := kv.Watch(ctx, "feature.>")
    if err != nil {
        return fmt.Errorf("watch: %w", err)
    }
    defer watcher.Stop()

    log.Println("Watching for configuration changes...")
    for entry := range watcher.Updates() {
        if entry == nil {
            // nil signals end of initial values
            log.Println("Initial state delivered — watching for updates")
            continue
        }
        log.Printf("Config change: key=%s value=%s op=%v",
            entry.Key(), string(entry.Value()), entry.Operation())
    }

    return nil
}
```

## Object Store API

The Object Store API extends JetStream to support large binary objects (up to 512 MiB per object by default) with chunked storage and SHA-256 integrity verification.

### Creating an Object Store Bucket

```bash
# Create an object store for ML model artifacts
nats object add ml-models \
  --replicas 3 \
  --storage file \
  --chunk-size 128KB \
  --description "Machine learning model artifacts"
```

### Object Store Operations

```go
// object_store.go
// Object store operations for large binary objects
package main

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "log"
    "os"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func uploadModel(nc *nats.Conn, modelPath string, modelName string) error {
    js, err := jetstream.New(nc)
    if err != nil {
        return fmt.Errorf("jetstream context: %w", err)
    }

    ctx := context.Background()

    // Open the object store bucket
    os_, err := js.ObjectStore(ctx, "ml-models")
    if err != nil {
        return fmt.Errorf("open object store: %w", err)
    }

    // Open the model file
    f, err := os.Open(modelPath)
    if err != nil {
        return fmt.Errorf("open file: %w", err)
    }
    defer f.Close()

    // Put the object — chunked automatically by the client
    info, err := os_.Put(ctx, &jetstream.ObjectMeta{
        Name:        modelName,
        Description: "TensorFlow SavedModel format",
        Headers: nats.Header{
            "model-version": []string{"2.1.0"},
            "framework":     []string{"tensorflow"},
        },
    }, f)
    if err != nil {
        return fmt.Errorf("put object: %w", err)
    }

    log.Printf("Uploaded model: name=%s size=%d chunks=%d digest=%s",
        info.Name, info.Size, info.Chunks, info.Digest)
    return nil
}

func downloadModel(nc *nats.Conn, modelName string) ([]byte, error) {
    js, err := jetstream.New(nc)
    if err != nil {
        return nil, fmt.Errorf("jetstream context: %w", err)
    }

    ctx := context.Background()

    os_, err := js.ObjectStore(ctx, "ml-models")
    if err != nil {
        return nil, fmt.Errorf("open object store: %w", err)
    }

    // Get returns an io.ReadCloser — read in chunks for large objects
    reader, err := os_.Get(ctx, modelName)
    if err != nil {
        return nil, fmt.Errorf("get object: %w", err)
    }
    defer reader.Close()

    var buf bytes.Buffer
    if _, err := io.Copy(&buf, reader); err != nil {
        return nil, fmt.Errorf("read object: %w", err)
    }

    return buf.Bytes(), nil
}
```

## Prometheus Monitoring with NATS Surveyor

NATS Surveyor is a standalone monitoring tool that scrapes NATS server statistics and exposes them as Prometheus metrics.

### Deploying NATS Surveyor

```yaml
# nats-surveyor-deployment.yaml
# NATS Surveyor deployment for Prometheus metrics
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nats-surveyor
  namespace: monitoring
  labels:
    app: nats-surveyor
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nats-surveyor
  template:
    metadata:
      labels:
        app: nats-surveyor
      annotations:
        # Prometheus scrape annotations
        prometheus.io/scrape: "true"
        prometheus.io/port: "7777"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: surveyor
          image: natsio/nats-surveyor:0.5.4
          args:
            - --servers
            - "nats://nats-main.messaging.svc.cluster.local:4222"
            - --count
            - "3"          # Number of NATS servers to expect
            - --port
            - "7777"
            - --tlscert
            - /etc/nats/certs/tls.crt
            - --tlskey
            - /etc/nats/certs/tls.key
            - --tlsca
            - /etc/nats/certs/ca.crt
            - --js
          ports:
            - name: metrics
              containerPort: 7777
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          volumeMounts:
            - name: nats-tls
              mountPath: /etc/nats/certs
              readOnly: true
      volumes:
        - name: nats-tls
          secret:
            secretName: nats-clients-tls
---
# ServiceMonitor for Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nats-surveyor
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app: nats-surveyor
  namespaceSelector:
    matchNames:
      - monitoring
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Prometheus Metrics

| Metric | Type | Description |
|---|---|---|
| `nats_core_mem_bytes` | Gauge | Memory used by each NATS server |
| `nats_core_routes_total` | Gauge | Number of active cluster routes |
| `nats_core_subscriptions_total` | Gauge | Total active subscriptions |
| `nats_core_slow_consumer_seconds` | Counter | Slow consumer incidents |
| `nats_jetstream_api_errors_total` | Counter | JetStream API errors |
| `nats_jetstream_streams_total` | Gauge | Number of streams per server |
| `nats_jetstream_consumers_total` | Gauge | Number of consumers per server |
| `nats_jetstream_messages_total` | Gauge | Messages stored across all streams |

### Grafana Alerting Rules

```yaml
# nats-alerts.yaml
# PrometheusRule for NATS JetStream alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nats-jetstream-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: nats.jetstream
      interval: 1m
      rules:
        - alert: NATSServerDown
          expr: up{job="nats-surveyor"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "NATS Surveyor is down"
            description: "NATS metrics collection has been unavailable for 2 minutes."

        - alert: NATSJetStreamConsumerPendingHigh
          expr: nats_jetstream_consumer_num_pending > 10000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "JetStream consumer pending count is high"
            description: "Consumer {{ $labels.consumer_name }} on stream {{ $labels.stream_name }} has {{ $value }} pending messages."

        - alert: NATSJetStreamStorageLow
          expr: (nats_jetstream_storage_used_bytes / nats_jetstream_storage_reserved_bytes) > 0.85
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "JetStream storage above 85%"
            description: "NATS server {{ $labels.server_name }} JetStream storage is {{ $value | humanizePercentage }} full."

        - alert: NATSSlowConsumers
          expr: rate(nats_core_slow_consumer_seconds[5m]) > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "NATS slow consumers detected"
            description: "Slow consumer events detected on server {{ $labels.server_name }}."
```

## Leaf Node Topology for Multi-Region Deployments

NATS leaf nodes extend a central hub cluster into remote sites with a single outbound connection. Messages published in a leaf node are bridged to the hub, and hub subjects can be mirrored into the leaf. This hub-and-spoke model reduces cross-region latency by keeping most traffic local.

### Hub Cluster Configuration

```conf
# hub-nats.conf
# Hub cluster server configuration
server_name: hub-server-1
port: 4222
cluster_name: hub-cluster

# Cluster routes to other hub members
cluster {
  port: 6222
  routes = [
    "nats-route://hub-server-1.messaging-hub.svc.cluster.local:6222"
    "nats-route://hub-server-2.messaging-hub.svc.cluster.local:6222"
    "nats-route://hub-server-3.messaging-hub.svc.cluster.local:6222"
  ]
  tls {
    cert_file: "/etc/nats/certs/tls.crt"
    key_file:  "/etc/nats/certs/tls.key"
    ca_file:   "/etc/nats/certs/ca.crt"
    verify:    true
  }
}

# Allow leaf node connections
leafnodes {
  port: 7422
  tls {
    cert_file: "/etc/nats/certs/tls.crt"
    key_file:  "/etc/nats/certs/tls.key"
    ca_file:   "/etc/nats/certs/ca.crt"
    verify:    true
  }
}

# JetStream domain for the hub
jetstream {
  domain:     hub
  store_dir:  /data/jetstream
  max_mem:    4GB
  max_file:   100GB
}
```

### Leaf Node Server Configuration

```conf
# leaf-nats.conf
# Leaf node server in a remote region
server_name: leaf-us-west-1
port: 4222

# Single outbound connection to the hub
leafnodes {
  remotes = [
    {
      urls: [
        "nats://hub-server-1.messaging-hub.example.com:7422"
        "nats://hub-server-2.messaging-hub.example.com:7422"
      ]
      tls {
        cert_file: "/etc/nats/certs/tls.crt"
        key_file:  "/etc/nats/certs/tls.key"
        ca_file:   "/etc/nats/certs/ca.crt"
      }
    }
  ]
}

# Local JetStream domain for the leaf region
jetstream {
  domain:     leaf-us-west
  store_dir:  /data/jetstream
  max_mem:    1GB
  max_file:   20GB
}
```

### Cross-Domain Stream Mirroring

```bash
# Mirror the hub ORDERS stream into the leaf domain for local consumption
nats stream add ORDERS-MIRROR \
  --mirror ORDERS \
  --mirror-domain hub \
  --storage file \
  --replicas 1 \
  --description "Mirror of hub ORDERS stream for local consumption" \
  --server "nats://leaf-nats.messaging-leaf.svc.cluster.local:4222"
```

## Operational Runbooks

### Checking Cluster Health

```bash
# Server list with connection counts and JetStream status
nats server list

# Detailed server info for a specific server
nats server info hub-server-1

# JetStream account information (storage, streams, consumers)
nats account info

# List all streams with message counts and byte usage
nats stream report

# List all consumers on a stream
nats consumer report ORDERS
```

### Stream Backup and Restore

```bash
# Snapshot a stream to a local directory (requires direct server access)
nats stream backup ORDERS /backup/orders-$(date +%Y%m%d)

# Restore a stream from a snapshot
nats stream restore ORDERS /backup/orders-20270315
```

### Purging and Deleting Stream Data

```bash
# Purge all messages from a stream (keeps the stream definition)
nats stream purge ORDERS --force

# Purge messages for a specific subject filter
nats stream purge ORDERS --subject "orders.cancelled" --force

# Delete the stream entirely (irreversible)
nats stream rm ORDERS --force
```

### Monitoring Consumer Lag

Consumer lag — the number of pending messages a consumer has not yet acknowledged — is the primary SLI for stream-based workloads.

```bash
# Check consumer lag for the order processor
nats consumer info ORDERS order-processor

# Watch consumer lag in real time (refresh every 2 seconds)
watch -n 2 "nats consumer report ORDERS --json | jq '.[] | select(.name == \"order-processor\") | {pending: .num_pending, redelivered: .num_redelivered}'"
```

## NATS CLI Common Operations Reference

```bash
# Publish a test message with a deduplication header
nats pub orders.created \
  --header "Nats-Msg-Id: test-order-$(uuidgen)" \
  '{"order_id": "ord-001", "amount": 49.99}'

# Subscribe to a subject and print incoming messages
nats sub "orders.>"

# Subscribe as a queue group (load-balanced delivery)
nats sub "orders.created" --queue order-workers

# Replay all messages from a stream since a timestamp
nats sub --stream ORDERS \
  --consumer replay-$(date +%s) \
  --deliver 2027-03-01T00:00:00Z \
  "orders.>"

# Benchmark publish throughput (100k messages, 1KB payload)
nats bench orders.bench \
  --msgs 100000 \
  --size 1024 \
  --pub 4

# Benchmark JetStream publish throughput with acknowledgment
nats bench orders.bench \
  --msgs 100000 \
  --size 1024 \
  --pub 4 \
  --js
```

## Summary

NATS JetStream on Kubernetes provides a production-grade messaging backbone with operational simplicity that traditional Kafka deployments cannot match. The NATS Operator handles cluster lifecycle, TLS rotation, and rolling upgrades through the `NatsCluster` CRD. JetStream streams offer configurable retention policies and exactly-once semantics via publisher deduplication windows. The Key-Value and Object Store APIs extend the platform beyond pure messaging into distributed configuration and artifact storage use cases. Leaf node topology enables multi-region deployments that minimize cross-region latency by keeping local traffic within the leaf cluster. Prometheus monitoring via NATS Surveyor, combined with the alert rules defined in this guide, provides the observability needed to operate NATS JetStream confidently in production.
