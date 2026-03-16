---
title: "NATS JetStream: Persistent Messaging and Event Streaming on Kubernetes"
date: 2027-01-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "NATS", "JetStream", "Messaging", "Event Streaming"]
categories:
- Messaging
- Kubernetes
- Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide covering NATS JetStream deployment on Kubernetes with HA clustering, TLS/NKey authentication, streams, consumers, KV store, and Go client patterns."
more_link: "yes"
url: "/nats-jetstream-kubernetes-messaging-production-guide/"
---

NATS JetStream transforms the lightweight NATS messaging system into a durable, persistent event streaming platform capable of replacing Kafka for many production workloads at a fraction of the operational complexity. Unlike Kafka, which demands ZooKeeper or KRaft ensembles, dedicated topic partition management, and significant tuning expertise, JetStream ships as a single binary that integrates directly into existing NATS clusters. This guide walks through every layer of a production JetStream deployment on Kubernetes — from operator-managed clusters and multi-tenancy through stream design, consumer patterns, and Go client integration.

<!--more-->

## NATS Core vs JetStream: Understanding the Difference

**NATS Core** is a pure publish-subscribe system with no persistence. Messages are delivered only to subscribers that are connected at the time of publish. If no subscriber is listening, the message is dropped. This model is excellent for real-time control signals and service-to-service RPC, but it cannot support durable event processing.

**JetStream** adds a persistence layer to NATS Core. Messages are written to disk before acknowledgment, enabling replay, redelivery on failure, and consumer position tracking. JetStream coexists with NATS Core — the same server handles both ephemeral pub/sub and persistent streams simultaneously.

Key capabilities JetStream adds:

- **Durable streams** with configurable retention (limits-based, interest-based, work-queue)
- **Push and pull consumers** with acknowledgment and redelivery
- **Exactly-once delivery** via double-acknowledgment protocol
- **Key-Value store** backed by a JetStream stream
- **Object store** for arbitrary binary data
- **Stream mirroring and sourcing** for multi-cluster replication

## Deploying NATS with the NATS Operator on Kubernetes

The **NATS Operator** manages NATS cluster lifecycle including rolling upgrades, certificate rotation, and configuration changes without downtime.

### Installing the NATS Operator

```bash
# Install cert-manager (required for TLS management)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.5/cert-manager.yaml

# Add the NATS Helm repository
helm repo add nats https://nats-io.github.io/k8s/helm/charts/
helm repo update

# Install the NATS operator
helm install nats-operator nats/nats-operator \
  --namespace nats-system \
  --create-namespace \
  --set image.tag=0.8.3
```

### NatsCluster Custom Resource

```yaml
# nats-cluster.yaml
apiVersion: nats.io/v1alpha2
kind: NatsCluster
metadata:
  name: nats-production
  namespace: nats-system
spec:
  size: 3
  version: "2.10.14"

  natsConfig:
    debug: false
    trace: false
    logtime: true
    maxPayload: 8388608  # 8 MiB
    maxPending: 67108864 # 64 MiB
    maxConnections: 65536
    writeDeadline: "10s"
    noAuthUser: ""

  jetstream:
    enabled: true
    memStorage:
      enabled: true
      size: "2Gi"
    fileStorage:
      enabled: true
      storageDirectory: /data/jetstream
      size: "50Gi"
      storageClassName: fast-ssd

  tls:
    serverSecret: nats-server-tls
    clientsTLSTimeout: 3
    routesTLSTimeout: 3

  auth:
    enableServiceAccounts: true
    operatorConfig:
      secret: nats-operator-jwt
      systemAccount: SYS

  pod:
    resources:
      requests:
        cpu: "500m"
        memory: "1Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    antiAffinity: true
    enableConfigReload: true

  extraRoutes:
    - cluster: nats-dr
      route: nats-route://nats-dr.nats-system.svc.cluster.local:6222
```

### Helm-Based Deployment (Alternative)

For teams preferring Helm without the operator:

```yaml
# nats-values.yaml
config:
  cluster:
    enabled: true
    replicas: 3
    name: nats-production

  jetstream:
    enabled: true
    fileStore:
      enabled: true
      dir: /data
      pvc:
        enabled: true
        size: 50Gi
        storageClassName: fast-ssd
    memStore:
      enabled: true
      maxSize: 2Gi

  tls:
    enabled: true
    secretName: nats-server-tls
    ca: ca.crt
    cert: tls.crt
    key: tls.key

natsBox:
  enabled: true

podTemplate:
  topologySpreadConstraints:
    kubernetes.io/hostname:
      maxSkew: 1
      whenUnsatisfiable: DoNotSchedule

resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: "2"
    memory: 4Gi

podDisruptionBudget:
  enabled: true
  minAvailable: 2
```

```bash
helm install nats nats/nats \
  --namespace nats-system \
  --create-namespace \
  -f nats-values.yaml
```

## TLS and NKey Authentication

### Generating Server TLS Certificates

```bash
# Create a cert-manager Certificate for NATS server TLS
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: nats-server-tls
  namespace: nats-system
spec:
  secretName: nats-server-tls
  duration: 8760h   # 1 year
  renewBefore: 720h # 30 days
  subject:
    organizations:
      - support.tools
  dnsNames:
    - nats-production
    - nats-production.nats-system
    - nats-production.nats-system.svc
    - nats-production.nats-system.svc.cluster.local
    - "*.nats-production.nats-system.svc.cluster.local"
  issuerRef:
    name: internal-ca
    kind: ClusterIssuer
EOF
```

### NKey Authentication Setup

**NKeys** use Ed25519 key pairs for authentication. The server never stores private keys — only the public key (encoded as an NKey) is configured on the server side.

```bash
# Install nsc (NATS Security Credentials tool)
curl -sf https://install.nats.io/nsc | sh

# Create an operator
nsc add operator production-operator

# Create a system account
nsc add account --name SYS
nsc edit operator --system-account SYS

# Create application accounts
nsc add account --name APP_ORDERS
nsc add account --name APP_INVENTORY
nsc add account --name APP_NOTIFICATIONS

# Create users within the orders account
nsc add user --account APP_ORDERS --name orders-producer
nsc add user --account APP_ORDERS --name orders-consumer

# Export credentials
nsc generate creds --name orders-producer --account APP_ORDERS > orders-producer.creds
nsc generate creds --name orders-consumer --account APP_ORDERS > orders-consumer.creds

# Push account JWTs to the server
nsc push --system-account SYS --account APP_ORDERS
nsc push --system-account SYS --account APP_INVENTORY
```

Store credentials as Kubernetes Secrets:

```bash
kubectl create secret generic nats-orders-producer-creds \
  --from-file=orders-producer.creds \
  --namespace nats-system

kubectl create secret generic nats-orders-consumer-creds \
  --from-file=orders-consumer.creds \
  --namespace nats-system
```

## Account System and Multi-Tenancy

JetStream supports **account isolation** — streams, consumers, and KV buckets created in one account are completely invisible to other accounts. This enables multi-tenancy without deploying separate NATS clusters.

```
# NATS account topology for a multi-tenant deployment
#
# SYS (system account) — server management, monitoring
# APP_ORDERS           — order processing streams
# APP_INVENTORY        — inventory event streams
# APP_NOTIFICATIONS    — notification aggregation
#
# Cross-account data sharing is opt-in via account exports/imports
```

### Cross-Account Subject Import/Export

```bash
# In APP_ORDERS account: export the orders.completed subject
nsc add export \
  --account APP_ORDERS \
  --subject "orders.completed" \
  --name orders-completed-export \
  --service

# In APP_NOTIFICATIONS account: import it
nsc add import \
  --account APP_NOTIFICATIONS \
  --from-account APP_ORDERS \
  --remote-subject "orders.completed" \
  --local-subject "orders.completed" \
  --name orders-completed-import
```

## Stream Design and Retention Policies

### Stream Retention Models

JetStream provides three retention policies:

| Policy | Behavior | Use Case |
|--------|----------|----------|
| `LimitsPolicy` | Keep messages until size/age/count limits | General event log |
| `InterestPolicy` | Keep messages until all consumers have acked | Fan-out delivery |
| `WorkQueuePolicy` | Delete after any consumer acks | Task distribution |

### Creating Streams with the NATS CLI

```bash
# Install the NATS CLI
curl -sf https://binaries.nats.dev/nats-io/natscli/releases/download/v0.1.4/nats-0.1.4-linux-amd64.zip -o nats.zip
unzip nats.zip && sudo mv nats /usr/local/bin/nats

# Create a persistent orders stream
nats stream add ORDERS \
  --subjects "orders.>" \
  --storage file \
  --retention limits \
  --max-msgs=10000000 \
  --max-age=720h \
  --max-bytes=50GiB \
  --max-msg-size=1MiB \
  --discard=old \
  --replicas=3 \
  --dupe-window=2m \
  --server nats://nats-production.nats-system.svc:4222 \
  --creds /etc/nats/orders-producer.creds

# Verify
nats stream info ORDERS
```

### Stream Configuration via Go (programmatic)

```go
package streams

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func ProvisionOrdersStream(ctx context.Context, nc *nats.Conn) (jetstream.Stream, error) {
    js, err := jetstream.New(nc)
    if err != nil {
        return nil, fmt.Errorf("creating jetstream context: %w", err)
    }

    cfg := jetstream.StreamConfig{
        Name:        "ORDERS",
        Description: "Order lifecycle events",
        Subjects:    []string{"orders.>"},
        Storage:     jetstream.FileStorage,
        Retention:   jetstream.LimitsPolicy,
        Replicas:    3,
        MaxMsgs:     10_000_000,
        MaxBytes:    50 * 1024 * 1024 * 1024, // 50 GiB
        MaxAge:      720 * time.Hour,           // 30 days
        MaxMsgSize:  1 * 1024 * 1024,           // 1 MiB
        Discard:     jetstream.DiscardOld,
        Duplicates:  2 * time.Minute,
        Compression: jetstream.S2Compression,
    }

    stream, err := js.CreateOrUpdateStream(ctx, cfg)
    if err != nil {
        return nil, fmt.Errorf("creating ORDERS stream: %w", err)
    }

    return stream, nil
}
```

## Push vs Pull Consumers

### Push Consumer

A **push consumer** has the server deliver messages to a subject that the client subscribes to. This suits low-latency, high-throughput scenarios where the consumer can keep up with the ingest rate.

```go
package consumers

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type OrderEvent struct {
    OrderID    string    `json:"order_id"`
    CustomerID string    `json:"customer_id"`
    Total      float64   `json:"total"`
    CreatedAt  time.Time `json:"created_at"`
}

func StartPushConsumer(ctx context.Context, nc *nats.Conn) error {
    js, err := jetstream.New(nc)
    if err != nil {
        return fmt.Errorf("jetstream context: %w", err)
    }

    stream, err := js.Stream(ctx, "ORDERS")
    if err != nil {
        return fmt.Errorf("getting stream: %w", err)
    }

    consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
        Name:          "notifications-push",
        Durable:       "notifications-push",
        FilterSubject: "orders.completed",
        DeliverPolicy: jetstream.DeliverNewPolicy,
        AckPolicy:     jetstream.AckExplicitPolicy,
        AckWait:       30 * time.Second,
        MaxDeliver:    5,
        BackOff:       []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute},
    })
    if err != nil {
        return fmt.Errorf("creating consumer: %w", err)
    }

    cc, err := consumer.Consume(func(msg jetstream.Msg) {
        var event OrderEvent
        if err := json.Unmarshal(msg.Data(), &event); err != nil {
            slog.Error("failed to decode order event", "error", err)
            msg.Nak()
            return
        }

        if err := processNotification(event); err != nil {
            slog.Error("notification failed", "order_id", event.OrderID, "error", err)
            msg.NakWithDelay(30 * time.Second)
            return
        }

        msg.Ack()
    })
    if err != nil {
        return fmt.Errorf("starting consume: %w", err)
    }
    defer cc.Stop()

    <-ctx.Done()
    return nil
}
```

### Pull Consumer

A **pull consumer** has the client request batches of messages on demand. This gives precise control over processing rate and is the preferred pattern for worker pools and batch processors.

```go
func StartPullWorker(ctx context.Context, nc *nats.Conn, workerID int) error {
    js, err := jetstream.New(nc)
    if err != nil {
        return fmt.Errorf("jetstream context: %w", err)
    }

    stream, err := js.Stream(ctx, "ORDERS")
    if err != nil {
        return fmt.Errorf("getting stream: %w", err)
    }

    consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
        Name:      "order-processor",
        Durable:   "order-processor",
        AckPolicy: jetstream.AckExplicitPolicy,
        AckWait:   60 * time.Second,
        MaxDeliver: 3,
        // WorkQueuePolicy stream — no filter needed
    })
    if err != nil {
        return fmt.Errorf("creating pull consumer: %w", err)
    }

    for {
        select {
        case <-ctx.Done():
            return nil
        default:
        }

        // Fetch up to 10 messages, wait up to 5 seconds
        msgs, err := consumer.Fetch(10, jetstream.FetchMaxWait(5*time.Second))
        if err != nil {
            if errors.Is(err, nats.ErrTimeout) {
                continue
            }
            return fmt.Errorf("worker %d fetch error: %w", workerID, err)
        }

        for msg := range msgs.Messages() {
            if err := processOrder(msg.Data()); err != nil {
                msg.Nak()
                continue
            }
            msg.Ack()
        }

        if msgs.Error() != nil {
            slog.Warn("fetch batch error", "worker", workerID, "error", msgs.Error())
        }
    }
}
```

## Exactly-Once Delivery

JetStream achieves **exactly-once delivery** through two mechanisms working together:

1. **Publisher deduplication** — the `Nats-Msg-Id` header with a configurable deduplication window prevents duplicate publishes from being stored.
2. **Double-acknowledgment** — the consumer sends an ack-ack back to the server after successfully processing; the server holds the message until this ack-ack is received.

```go
package publish

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func PublishExactlyOnce(ctx context.Context, js jetstream.JetStream, subject string, data []byte) error {
    msgID := uuid.New().String()

    // The server deduplicates on Nats-Msg-Id within the stream's DuplicateWindow
    ack, err := js.PublishMsg(ctx, &nats.Msg{
        Subject: subject,
        Data:    data,
        Header: nats.Header{
            "Nats-Msg-Id": []string{msgID},
        },
    })
    if err != nil {
        return fmt.Errorf("publishing message %s: %w", msgID, err)
    }

    if ack.Duplicate {
        // Message already stored — safe to treat as success
        return nil
    }

    return nil
}
```

## Subject Wildcards and Filtering

JetStream supports NATS subject wildcards in stream subjects and consumer filters:

```
# Subject hierarchy example:
# orders.{region}.{status}
#
# orders.us-east.created
# orders.us-west.completed
# orders.eu.cancelled

# Stream captures all orders across all regions and statuses
Subjects: ["orders.>"]

# Consumer filters to US orders only
FilterSubject: "orders.us-east.>"

# Consumer filters to completed orders across all regions
FilterSubject: "orders.*.completed"
```

Multi-filter consumers (JetStream 2.10+):

```go
consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
    Name:          "us-completed-consumer",
    Durable:       "us-completed-consumer",
    FilterSubjects: []string{
        "orders.us-east.completed",
        "orders.us-west.completed",
    },
    AckPolicy: jetstream.AckExplicitPolicy,
})
```

## Stream Mirroring and Sourcing

**Mirroring** creates a read-only replica of another stream — useful for disaster recovery or separating read workloads.

**Sourcing** aggregates multiple streams into one — useful for cross-region consolidation.

```go
// Mirror: replicate ORDERS from another cluster
mirrorCfg := jetstream.StreamConfig{
    Name:        "ORDERS-MIRROR",
    Description: "DR mirror of ORDERS stream",
    Storage:     jetstream.FileStorage,
    Replicas:    3,
    Mirror: &jetstream.StreamSource{
        Name: "ORDERS",
        External: &jetstream.ExternalStream{
            APIPrefix:     "$JS.hub.API",
            DeliverPrefix: "deliver.hub",
        },
    },
}

// Source: aggregate orders from multiple regions
sourcedCfg := jetstream.StreamConfig{
    Name:     "ORDERS-GLOBAL",
    Storage:  jetstream.FileStorage,
    Replicas: 3,
    Sources: []*jetstream.StreamSource{
        {
            Name: "ORDERS-US-EAST",
            External: &jetstream.ExternalStream{
                APIPrefix: "$JS.us-east.API",
            },
        },
        {
            Name: "ORDERS-EU",
            External: &jetstream.ExternalStream{
                APIPrefix: "$JS.eu.API",
            },
        },
    },
}
```

## Key-Value Store

JetStream's **Key-Value (KV) store** is backed by a JetStream stream but exposes a map-like API with watch semantics. It supports optimistic concurrency, TTL per key, and atomic compare-and-swap operations.

```go
package kvstore

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type ConfigStore struct {
    kv jetstream.KeyValue
}

func NewConfigStore(ctx context.Context, js jetstream.JetStream) (*ConfigStore, error) {
    kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
        Bucket:      "app-config",
        Description: "Application configuration store",
        TTL:         0, // No expiry for config keys
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        History:     10, // Keep last 10 revisions per key
        MaxValueSize: 64 * 1024, // 64 KiB per value
    })
    if err != nil {
        return nil, fmt.Errorf("creating KV bucket: %w", err)
    }

    return &ConfigStore{kv: kv}, nil
}

func (s *ConfigStore) SetWithCAS(ctx context.Context, key string, value []byte, revision uint64) error {
    // Atomic compare-and-swap: only update if current revision matches
    _, err := s.kv.Update(ctx, key, value, revision)
    if err != nil {
        return fmt.Errorf("CAS update failed for key %s: %w", key, err)
    }
    return nil
}

func (s *ConfigStore) Watch(ctx context.Context, keyPrefix string) error {
    watcher, err := s.kv.Watch(ctx, keyPrefix+".*")
    if err != nil {
        return fmt.Errorf("creating watcher: %w", err)
    }
    defer watcher.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil
        case entry, ok := <-watcher.Updates():
            if !ok {
                return fmt.Errorf("watcher channel closed")
            }
            if entry == nil {
                // Initial values delivered, now receiving updates
                continue
            }

            switch entry.Operation() {
            case jetstream.KeyValuePut:
                fmt.Printf("key=%s value=%s rev=%d\n", entry.Key(), entry.Value(), entry.Revision())
            case jetstream.KeyValueDelete:
                fmt.Printf("deleted key=%s\n", entry.Key())
            case jetstream.KeyValuePurge:
                fmt.Printf("purged key=%s\n", entry.Key())
            }
        }
    }
}
```

## Object Store

JetStream's **Object Store** handles arbitrary binary objects (files, images, configs) chunked into multiple messages under the hood:

```go
func UploadArtifact(ctx context.Context, js jetstream.JetStream, name string, data []byte) error {
    obs, err := js.CreateOrUpdateObjectStore(ctx, jetstream.ObjectStoreConfig{
        Bucket:      "build-artifacts",
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        TTL:         168 * time.Hour, // 7 days
        MaxChunkSize: 128 * 1024,     // 128 KiB chunks
    })
    if err != nil {
        return fmt.Errorf("getting object store: %w", err)
    }

    _, err = obs.PutBytes(ctx, name, data)
    return err
}

func DownloadArtifact(ctx context.Context, js jetstream.JetStream, name string) ([]byte, error) {
    obs, err := js.ObjectStore(ctx, "build-artifacts")
    if err != nil {
        return nil, fmt.Errorf("getting object store: %w", err)
    }

    return obs.GetBytes(ctx, name)
}
```

## Dead-Letter Handling and Message Replay

### Dead-Letter Pattern

JetStream does not have a native dead-letter queue (DLQ), but the pattern is implemented via a dedicated stream and `MaxDeliver` threshold:

```go
// Create a DLQ stream for orders that fail processing
dlqCfg := jetstream.StreamConfig{
    Name:     "ORDERS-DLQ",
    Subjects: []string{"orders.dlq.>"},
    Storage:  jetstream.FileStorage,
    Replicas: 3,
    MaxAge:   720 * time.Hour, // Retain failures for 30 days
}

// In the consumer: after MaxDeliver attempts, publish to DLQ
func handleOrderWithDLQ(ctx context.Context, js jetstream.JetStream, msg jetstream.Msg) {
    meta, _ := msg.Metadata()

    if meta.NumDelivered >= 5 {
        // Route to DLQ preserving original headers
        dlqSubject := "orders.dlq." + msg.Subject()
        dlqMsg := &nats.Msg{
            Subject: dlqSubject,
            Data:    msg.Data(),
            Header:  msg.Headers(),
        }
        dlqMsg.Header.Set("X-Original-Subject", msg.Subject())
        dlqMsg.Header.Set("X-Failure-Count", fmt.Sprintf("%d", meta.NumDelivered))
        dlqMsg.Header.Set("X-Last-Error", "max-delivery-exceeded")

        js.PublishMsg(ctx, dlqMsg)
        msg.Ack() // Ack to remove from original consumer
        return
    }

    // Normal processing...
    msg.NakWithDelay(backoffDuration(meta.NumDelivered))
}

func backoffDuration(attempt uint64) time.Duration {
    delays := []time.Duration{5 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute}
    if attempt >= uint64(len(delays)) {
        return delays[len(delays)-1]
    }
    return delays[attempt]
}
```

### Message Replay

Pull a historical replay from a specific sequence number or timestamp:

```go
func ReplayFromTimestamp(ctx context.Context, js jetstream.JetStream, since time.Time) error {
    stream, err := js.Stream(ctx, "ORDERS")
    if err != nil {
        return err
    }

    // Ephemeral consumer starting from a specific time
    consumer, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
        Name:          "", // Ephemeral — no durable name
        FilterSubject: "orders.>",
        DeliverPolicy: jetstream.DeliverByStartTimePolicy,
        OptStartTime:  &since,
        AckPolicy:     jetstream.AckNonePolicy, // Read-only replay
    })
    if err != nil {
        return fmt.Errorf("creating replay consumer: %w", err)
    }

    info, _ := stream.Info(ctx)
    total := info.State.Msgs

    msgs, _ := consumer.Fetch(int(total), jetstream.FetchMaxWait(30*time.Second))
    for msg := range msgs.Messages() {
        meta, _ := msg.Metadata()
        fmt.Printf("seq=%d subject=%s ts=%s\n",
            meta.Sequence.Stream, msg.Subject(), meta.Timestamp)
    }

    return msgs.Error()
}
```

## Monitoring with Prometheus

The NATS server exposes a `/metrics` endpoint compatible with Prometheus when `prometheus_export_port` is configured:

```yaml
# nats-server.conf snippet
server_name: nats-production-0
prometheus_export_port: 7777
http_port: 8222  # NATS monitoring HTTP port
```

### NATS Prometheus Exporter (Sidecar)

```yaml
# Add to the NATS StatefulSet or as a standalone Deployment
- name: nats-prometheus-exporter
  image: natsio/prometheus-nats-exporter:0.14.0
  args:
    - "-connz"
    - "-routez"
    - "-subz"
    - "-varz"
    - "-jsz=all"
    - "http://localhost:8222"
  ports:
    - name: metrics
      containerPort: 7777
```

### ServiceMonitor for Prometheus Operator

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nats-jetstream
  namespace: nats-system
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: nats
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_namespace]
          targetLabel: namespace
```

### Key JetStream Metrics

```
# Stream message count
nats_jetstream_stream_total_messages

# Consumer pending messages (lag indicator)
nats_jetstream_consumer_num_pending

# Consumer redelivered message count (processing failures)
nats_jetstream_consumer_num_redelivered

# Server memory usage
nats_server_mem

# JetStream storage used
nats_jetstream_store_used_bytes

# JetStream API errors
nats_jetstream_api_errors_total
```

### Grafana Alert Rules

```yaml
groups:
  - name: nats-jetstream
    rules:
      - alert: NATSConsumerHighLag
        expr: nats_jetstream_consumer_num_pending > 50000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "NATS consumer {{ $labels.consumer }} has high message lag"
          description: "Consumer {{ $labels.consumer }} on stream {{ $labels.stream }} has {{ $value }} pending messages."

      - alert: NATSConsumerRedeliveryHigh
        expr: rate(nats_jetstream_consumer_num_redelivered[5m]) > 10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "NATS consumer {{ $labels.consumer }} has elevated redelivery rate"

      - alert: NATSStreamStorageFull
        expr: nats_jetstream_store_used_bytes / nats_jetstream_store_reserved_bytes > 0.85
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "NATS JetStream storage is {{ $value | humanizePercentage }} full"
```

## PodDisruptionBudget and High Availability

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: nats-pdb
  namespace: nats-system
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: nats
---
# Anti-affinity to spread pods across nodes
affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: nats
        topologyKey: kubernetes.io/hostname
```

## Operational Runbook

### Checking Cluster Health

```bash
# Via NATS CLI
nats server check \
  --server nats://nats-production.nats-system.svc:4222 \
  --creds /etc/nats/admin.creds

# Check JetStream status
nats server report jetstream \
  --server nats://nats-production.nats-system.svc:4222 \
  --creds /etc/nats/admin.creds

# List all streams
nats stream ls --server nats://nats-production.nats-system.svc:4222

# Get stream stats
nats stream info ORDERS

# List consumers
nats consumer ls ORDERS

# View consumer lag
nats consumer info ORDERS order-processor
```

### Purging and Deleting Streams

```bash
# Purge all messages from a stream (retains stream definition)
nats stream purge ORDERS --filter "orders.test.>" --force

# Delete a stream entirely
nats stream rm ORDERS-STAGING --force

# Delete a consumer
nats consumer rm ORDERS notifications-push --force
```

### Backup and Restore

```bash
# Backup: use nats-server's built-in snapshot capability
# The server must have the HTTP management port enabled

# Create a stream snapshot to a local directory
nats stream backup ORDERS /backups/orders-$(date +%Y%m%d) \
  --server nats://nats-production.nats-system.svc:4222

# Restore from snapshot
nats stream restore ORDERS /backups/orders-20261201 \
  --server nats://nats-production.nats-system.svc:4222
```

## Performance Tuning Recommendations

| Parameter | Development | Production |
|-----------|-------------|------------|
| `maxPayload` | 1 MiB | 8 MiB |
| `maxPending` | 32 MiB | 64–256 MiB |
| `writeDeadline` | 5s | 10s |
| Stream replicas | 1 | 3 |
| Storage type | `memory` | `file` |
| Compression | none | `s2` |
| `DuplicateWindow` | 1m | 2m |
| Consumer `AckWait` | 30s | 60s |
| Consumer `MaxDeliver` | 3 | 5 |

Key storage performance considerations:

- Use NVMe SSDs with `fast-ssd` StorageClass for file-based streams.
- Set `Compression: jetstream.S2Compression` on streams that store compressible data (JSON events) to reduce storage costs by 50–70%.
- Prefer pull consumers for high-throughput batch processors; prefer push consumers for low-latency notification pipelines.
- A three-node JetStream cluster handles ~500,000 messages/second for small messages (under 1 KiB) on commodity hardware.

NATS JetStream provides a compelling alternative to Kafka and RabbitMQ for teams operating on Kubernetes who need durable messaging without the operational overhead of managing a separate distributed log infrastructure. The unified server model — NATS Core pub/sub, JetStream persistence, KV, and object store all in one binary — dramatically reduces the number of moving parts in a production messaging stack.
