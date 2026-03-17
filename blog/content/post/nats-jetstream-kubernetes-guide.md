---
title: "NATS JetStream on Kubernetes: High-Performance Messaging for Cloud-Native Applications"
date: 2027-11-04T00:00:00-05:00
draft: false
tags: ["NATS", "JetStream", "Messaging", "Kubernetes", "Streaming"]
categories:
- Kubernetes
- Messaging
author: "Matthew Mattox - mmattox@support.tools"
description: "NATS JetStream deployment with nats-operator, stream and consumer configuration, persistence, clustering, subject-based routing, Kubernetes service mesh integration, and producer/consumer patterns in Go."
more_link: "yes"
url: "/nats-jetstream-kubernetes-guide/"
---

NATS JetStream brings persistent, at-least-once delivery semantics to the NATS messaging system. While core NATS provides fire-and-forget publish-subscribe with microsecond latencies, JetStream adds durability, replay, and consumer groups on top of the same wire protocol. For Kubernetes workloads that need high-throughput messaging without the operational complexity of Kafka, NATS JetStream is a compelling alternative.

<!--more-->

# NATS JetStream on Kubernetes: High-Performance Messaging for Cloud-Native Applications

## NATS vs JetStream

Understanding when to use core NATS versus JetStream is the foundation of a good NATS deployment:

**Core NATS** is appropriate for:
- Request-reply patterns where you need sub-millisecond latency
- Fire-and-forget notifications where message loss is acceptable
- Service discovery and control plane messaging
- Fan-out patterns where all subscribers process every message

**JetStream** is appropriate for:
- Work queues where each message should be processed exactly once
- Event sourcing where you need to replay event history
- Durable subscriptions that survive consumer restarts
- Ordered message delivery requirements
- At-least-once delivery guarantees

Both are served by the same NATS server -- JetStream is simply a feature that is enabled in the server configuration.

## Deploying NATS with the NATS Operator

### Installing the NATS Operator

```bash
# Install the NATS Operator
kubectl apply -f https://raw.githubusercontent.com/nats-io/nats-operator/latest/deploy/default-rbac.yaml
kubectl apply -f https://raw.githubusercontent.com/nats-io/nats-operator/latest/deploy/deployment.yaml
```

### NatsCluster Resource

```yaml
apiVersion: nats.io/v1alpha2
kind: NatsCluster
metadata:
  name: nats-cluster
  namespace: messaging
spec:
  size: 3
  version: "2.10.14"

  serverConfig:
    jetstream: true
    debug: false
    trace: false
    logtime: true
    maxPayload: 8388608
    writeDeadline: "10s"
    maxConnections: 10000
    pingInterval: "2m"
    maxPingsOut: 2

  jetstream:
    memStorage:
      enabled: true
      size: 1Gi
    fileStorage:
      enabled: true
      size: 50Gi
      storageDirectory: /data/jetstream
      storageClass: fast-ssd

  pod:
    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              nats_cluster: nats-cluster
          topologyKey: kubernetes.io/hostname
    resources:
      requests:
        cpu: 250m
        memory: 512Mi
      limits:
        cpu: 1000m
        memory: 2Gi
    labels:
      prometheus.io/scrape: "true"
      prometheus.io/port: "7777"

  auth:
    enableServiceLinks: false
    credentials:
      secret:
        name: nats-auth-credentials

  tls:
    serverSecret: nats-server-tls
    clientsTLSTimeout: 5
    routesTLSTimeout: 5
    enableHttps: true
```

### Alternative: Helm-Based Deployment

For more control over configuration, use the official NATS Helm chart:

```bash
helm repo add nats https://nats-io.github.io/k8s/helm/charts/
helm repo update

helm install nats nats/nats \
  --namespace messaging \
  --create-namespace \
  --version 1.1.12 \
  --values nats-values.yaml
```

```yaml
# nats-values.yaml
config:
  cluster:
    enabled: true
    replicas: 3
    name: production-cluster

  jetstream:
    enabled: true
    fileStore:
      enabled: true
      pvc:
        enabled: true
        size: 50Gi
        storageClassName: fast-ssd
    memoryStore:
      enabled: true
      maxSize: 1Gi

  merge:
    max_payload: 8MB
    max_connections: 10000
    lame_duck_duration: 30s
    lame_duck_grace_period: 5s
    no_auth_user: ""
    write_deadline: 10s

  authorization:
    timeout: 5

container:
  image:
    tag: 2.10.14-alpine

reloader:
  enabled: true

natsBox:
  enabled: true

exporter:
  enabled: true
  image:
    tag: 0.14.0
  resources:
    requests:
      cpu: 50m
      memory: 64Mi

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app.kubernetes.io/name: nats
      topologyKey: kubernetes.io/hostname

topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app.kubernetes.io/name: nats
```

## Authentication and Authorization

### NKey-Based Authentication

```bash
# Generate NKeys for accounts and users
nsc add operator production-operator
nsc add account production-account
nsc add user api-service-user
nsc add user worker-service-user

# Export credentials
nsc export credentials --account production-account --name api-service-user -o /tmp/api-service.creds
nsc export credentials --account production-account --name worker-service-user -o /tmp/worker-service.creds

# Store as Kubernetes secrets
kubectl create secret generic nats-api-service-creds \
  --from-file=credentials=/tmp/api-service.creds \
  --namespace=production

kubectl create secret generic nats-worker-service-creds \
  --from-file=credentials=/tmp/worker-service.creds \
  --namespace=production
```

## JetStream Streams and Consumers

### Creating Streams via nats CLI

```bash
# Install the nats CLI in a pod
kubectl run nats-box --image=natsio/nats-box:latest --restart=Never -n messaging -- sleep infinity

# Connect to NATS
kubectl exec -n messaging nats-box -- \
  nats stream add orders \
  --server nats://nats.messaging.svc.cluster.local:4222 \
  --subjects "orders.>" \
  --storage file \
  --retention limits \
  --max-msgs 1000000 \
  --max-bytes 1073741824 \
  --max-age 7d \
  --max-msg-size 1048576 \
  --discard old \
  --replicas 3 \
  --dupe-window 2m

# Create a durable consumer for order processing
kubectl exec -n messaging nats-box -- \
  nats consumer add orders order-processor \
  --server nats://nats.messaging.svc.cluster.local:4222 \
  --filter "orders.created" \
  --ack explicit \
  --pull \
  --deliver all \
  --max-deliver 5 \
  --max-ack-pending 1000 \
  --ack-wait 30s \
  --backoff linear

# Verify stream configuration
kubectl exec -n messaging nats-box -- \
  nats stream info orders \
  --server nats://nats.messaging.svc.cluster.local:4222
```

### Stream Configuration via Go

```go
package streams

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func SetupStreams(ctx context.Context, nc *nats.Conn) error {
    js, err := jetstream.New(nc)
    if err != nil {
        return fmt.Errorf("creating jetstream context: %w", err)
    }

    // Orders stream
    _, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:        "ORDERS",
        Description: "Order lifecycle events",
        Subjects:    []string{"orders.>"},
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        Retention:   jetstream.LimitsPolicy,
        MaxMsgs:     1_000_000,
        MaxBytes:    1 * 1024 * 1024 * 1024, // 1GB
        MaxAge:      7 * 24 * time.Hour,
        MaxMsgSize:  1 * 1024 * 1024, // 1MB
        Discard:     jetstream.DiscardOld,
        Duplicates:  2 * time.Minute,
    })
    if err != nil {
        return fmt.Errorf("creating orders stream: %w", err)
    }
    log.Println("Orders stream created/updated")

    // Notifications stream with work queue retention
    _, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:      "NOTIFICATIONS",
        Subjects:  []string{"notifications.>"},
        Storage:   jetstream.FileStorage,
        Replicas:  3,
        Retention: jetstream.WorkQueuePolicy,
        MaxAge:    24 * time.Hour,
    })
    if err != nil {
        return fmt.Errorf("creating notifications stream: %w", err)
    }

    // Audit log stream - never delete, long retention
    _, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
        Name:      "AUDIT",
        Subjects:  []string{"audit.>"},
        Storage:   jetstream.FileStorage,
        Replicas:  3,
        Retention: jetstream.LimitsPolicy,
        MaxAge:    365 * 24 * time.Hour,
        // Seal prevents deletion
        Sealed: false,
    })
    if err != nil {
        return fmt.Errorf("creating audit stream: %w", err)
    }

    log.Println("All streams created/updated successfully")
    return nil
}
```

## Production Go Publisher

```go
package publisher

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type OrderEvent struct {
    OrderID   string    `json:"order_id"`
    Status    string    `json:"status"`
    Amount    float64   `json:"amount"`
    CustomerID string   `json:"customer_id"`
    Timestamp time.Time `json:"timestamp"`
}

type Publisher struct {
    js jetstream.JetStream
}

func NewPublisher(nc *nats.Conn) (*Publisher, error) {
    js, err := jetstream.New(nc)
    if err != nil {
        return nil, fmt.Errorf("creating jetstream context: %w", err)
    }
    return &Publisher{js: js}, nil
}

func (p *Publisher) PublishOrderCreated(ctx context.Context, event OrderEvent) error {
    event.Timestamp = time.Now()

    data, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshaling event: %w", err)
    }

    // Publish with message ID for deduplication
    ack, err := p.js.Publish(ctx, "orders.created",
        data,
        // Deduplication ID - prevents duplicate processing within the dupe window
        jetstream.WithMsgID(event.OrderID),
        // Publish timeout
        jetstream.WithExpectLastMsgID(""),
    )
    if err != nil {
        return fmt.Errorf("publishing order created event: %w", err)
    }

    _ = ack
    return nil
}

func (p *Publisher) PublishOrderShipped(ctx context.Context, event OrderEvent) error {
    event.Status = "shipped"
    event.Timestamp = time.Now()

    data, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("marshaling event: %w", err)
    }

    _, err = p.js.Publish(ctx, "orders.shipped", data,
        jetstream.WithMsgID(fmt.Sprintf("shipped-%s", event.OrderID)),
    )
    return err
}
```

## Production Go Consumer

```go
package consumer

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

type OrderProcessor struct {
    js       jetstream.JetStream
    consumer jetstream.Consumer
}

func NewOrderProcessor(ctx context.Context, nc *nats.Conn) (*OrderProcessor, error) {
    js, err := jetstream.New(nc)
    if err != nil {
        return nil, fmt.Errorf("creating jetstream context: %w", err)
    }

    // Create or attach to an existing durable consumer
    consumer, err := js.CreateOrUpdateConsumer(ctx, "ORDERS", jetstream.ConsumerConfig{
        Durable:       "order-processor",
        Name:          "order-processor",
        Description:   "Processes created orders",
        FilterSubject: "orders.created",
        AckPolicy:     jetstream.AckExplicitPolicy,
        AckWait:       30 * time.Second,
        MaxDeliver:    5,
        // Backoff on redelivery
        BackOff: []time.Duration{
            1 * time.Second,
            5 * time.Second,
            30 * time.Second,
            2 * time.Minute,
        },
        MaxAckPending: 1000,
        DeliverPolicy: jetstream.DeliverAllPolicy,
    })
    if err != nil {
        return nil, fmt.Errorf("creating consumer: %w", err)
    }

    return &OrderProcessor{js: js, consumer: consumer}, nil
}

func (p *OrderProcessor) Start(ctx context.Context) error {
    // Pull-based consumer with batch processing
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Fetch a batch of messages
        msgs, err := p.consumer.Fetch(50,
            jetstream.FetchMaxWait(2*time.Second),
        )
        if err != nil {
            if err == jetstream.ErrNoMessages {
                continue
            }
            log.Printf("Error fetching messages: %v", err)
            time.Sleep(1 * time.Second)
            continue
        }

        for msg := range msgs.Messages() {
            if err := p.processMessage(ctx, msg); err != nil {
                log.Printf("Error processing message %s: %v", msg.Subject(), err)
                // Nak with delay for retry
                msg.NakWithDelay(5 * time.Second)
                continue
            }
            msg.Ack()
        }

        if msgs.Error() != nil {
            log.Printf("Fetch error: %v", msgs.Error())
        }
    }
}

type OrderEvent struct {
    OrderID    string    `json:"order_id"`
    Status     string    `json:"status"`
    Amount     float64   `json:"amount"`
    CustomerID string    `json:"customer_id"`
    Timestamp  time.Time `json:"timestamp"`
}

func (p *OrderProcessor) processMessage(ctx context.Context, msg jetstream.Msg) error {
    var event OrderEvent
    if err := json.Unmarshal(msg.Data(), &event); err != nil {
        // Bad message format - ack to prevent infinite retry
        log.Printf("Failed to unmarshal message: %v", err)
        return nil
    }

    meta, _ := msg.Metadata()
    log.Printf("Processing order %s (delivery %d/%d)",
        event.OrderID, meta.NumDelivered, meta.NumPending)

    // Process the order...
    if err := processOrder(ctx, event); err != nil {
        return fmt.Errorf("processing order %s: %w", event.OrderID, err)
    }

    return nil
}

func processOrder(ctx context.Context, event OrderEvent) error {
    // Your business logic here
    log.Printf("Order %s processed: amount=%.2f customer=%s",
        event.OrderID, event.Amount, event.CustomerID)
    return nil
}
```

## Subject-Based Routing Patterns

NATS uses subject-based routing where `>` matches multiple tokens and `*` matches a single token:

```
Subject patterns:
  orders.>          # matches orders.created, orders.shipped, orders.us.created
  orders.*          # matches orders.created, orders.shipped (not orders.us.created)
  orders.*.created  # matches orders.us.created, orders.eu.created

Example message flow:
  Publisher:  orders.us-east.created
  Stream:     ORDERS (subject: orders.>)
  Consumer A: filter=orders.us-east.> (processes US East orders)
  Consumer B: filter=orders.>          (processes all orders)
```

Implement regional routing with stream mirrors:

```go
// Create a regional mirror stream
_, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
    Name:    "ORDERS-US-EAST",
    Mirror: &jetstream.StreamSource{
        Name:          "ORDERS",
        FilterSubject: "orders.us-east.>",
    },
    Storage:  jetstream.FileStorage,
    Replicas: 3,
})
```

## NATS Service Mesh Integration

NATS works well alongside Kubernetes service meshes. Configure NATS client connections to use mTLS with SPIRE:

```go
package main

import (
    "context"
    "crypto/tls"
    "log"

    "github.com/nats-io/nats.go"
    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

func connectWithSPIFFE(ctx context.Context, natsURL string) (*nats.Conn, error) {
    x509Source, err := workloadapi.NewX509Source(
        ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        return nil, err
    }

    natsServerID := spiffeid.RequireIDFromString(
        "spiffe://company.com/ns/messaging/sa/nats-server",
    )

    tlsConfig := tlsconfig.MTLSClientConfig(
        x509Source,
        x509Source,
        tlsconfig.AuthorizeID(natsServerID),
    )

    nc, err := nats.Connect(natsURL,
        nats.Secure(tlsConfig),
        nats.Name("order-service"),
        nats.ReconnectWait(1*time.Second),
        nats.MaxReconnects(-1),
    )
    if err != nil {
        return nil, err
    }

    return nc, nil
}
```

## Monitoring NATS JetStream

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nats
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: nats
  namespaceSelector:
    matchNames:
    - messaging
  endpoints:
  - port: metrics
    interval: 15s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nats-jetstream-alerts
  namespace: monitoring
spec:
  groups:
  - name: nats-jetstream
    rules:
    - alert: NATSJetStreamConsumerLagHigh
      expr: nats_consumer_num_pending > 10000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NATS JetStream consumer {{ $labels.consumer }} has high message lag"
        description: "Consumer {{ $labels.consumer }} on stream {{ $labels.stream }} has {{ $value }} pending messages."

    - alert: NATSJetStreamStorageUsageHigh
      expr: |
        nats_server_jetstream_file_storage_used_bytes / nats_server_jetstream_file_storage_capacity_bytes > 0.80
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "NATS JetStream file storage over 80% capacity"

    - alert: NATSServerDown
      expr: absent(up{job="nats"}) or up{job="nats"} == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "NATS server is down"
        description: "NATS messaging server is not running. All NATS-dependent services are affected."

    - alert: NATSJetStreamConsumerDeliveryErrors
      expr: rate(nats_consumer_num_redelivered[5m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NATS consumer {{ $labels.consumer }} experiencing redeliveries"
        description: "Consumer {{ $labels.consumer }} is redelivering messages, indicating processing failures."
```

## Production Checklist

Before deploying NATS JetStream in production, verify:

1. **Stream replication factor**: All streams should have `Replicas: 3` for production durability
2. **PVC storage class**: Use a storage class that supports `ReadWriteOnce` with fast I/O (NVMe or SSD)
3. **Pod anti-affinity**: Ensure NATS pods are spread across different nodes and availability zones
4. **Consumer acknowledgment**: Never use `AckNone` policy for workloads that require at-least-once delivery
5. **Message deduplication**: Set `Duplicates` window on streams to prevent duplicate processing during retries
6. **Dead-letter handling**: Configure `MaxDeliver` with a finite value to prevent infinite retry loops
7. **Monitoring**: Deploy the NATS Prometheus exporter and configure alerts for consumer lag and storage usage

## Conclusion

NATS JetStream provides a compelling messaging platform for Kubernetes workloads that need persistence and delivery guarantees without the operational complexity of Kafka. The combination of simple deployment, built-in clustering with Raft consensus, and the expressive subject-based routing system makes NATS JetStream suitable for a wide range of messaging patterns from simple work queues to complex event sourcing architectures.

The Go client library is particularly well-designed, making it straightforward to implement production-quality consumers with proper acknowledgment, retry backoff, and error handling. For teams already using Go for their services, NATS JetStream provides a natural, idiomatic messaging solution that integrates well with the Go ecosystem.

## Key-Value Store and Object Store

JetStream also provides Key-Value and Object store APIs built on top of streams. These are useful for configuration management, distributed locking, and storing large blobs.

### Key-Value Store

```go
package kv

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func SetupKeyValueStore(ctx context.Context, nc *nats.Conn) (jetstream.KeyValue, error) {
    js, err := jetstream.New(nc)
    if err != nil {
        return nil, err
    }

    // Create a KV bucket for feature flags
    kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
        Bucket:      "feature-flags",
        Description: "Feature flags for production services",
        TTL:         0, // No TTL - values persist until explicitly deleted
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        History:     5, // Keep last 5 versions of each key
        MaxBytes:    10 * 1024 * 1024, // 10MB max for this bucket
    })
    if err != nil {
        return nil, fmt.Errorf("creating feature-flags KV store: %w", err)
    }

    // Set a feature flag
    _, err = kv.Put(ctx, "payments.new-payment-flow", []byte("true"))
    if err != nil {
        return nil, err
    }

    // Get a feature flag
    entry, err := kv.Get(ctx, "payments.new-payment-flow")
    if err != nil {
        return nil, err
    }
    fmt.Printf("Feature flag: %s = %s\n", entry.Key(), entry.Value())

    return kv, nil
}

// Watch for feature flag changes in real-time
func WatchFeatureFlags(ctx context.Context, kv jetstream.KeyValue) error {
    watcher, err := kv.WatchAll(ctx)
    if err != nil {
        return fmt.Errorf("creating watcher: %w", err)
    }
    defer watcher.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case entry := <-watcher.Updates():
            if entry == nil {
                // Initial values have been delivered
                continue
            }
            if entry.Operation() == jetstream.KeyValueDelete {
                fmt.Printf("Feature flag deleted: %s\n", entry.Key())
            } else {
                fmt.Printf("Feature flag updated: %s = %s\n", entry.Key(), entry.Value())
                // Apply new configuration without restart
            }
        }
    }
}
```

### Distributed Locking with KV

```go
package lock

import (
    "context"
    "fmt"
    "time"

    "github.com/nats-io/nats.go/jetstream"
)

type DistributedLock struct {
    kv      jetstream.KeyValue
    key     string
    ownerID string
}

func AcquireLock(ctx context.Context, kv jetstream.KeyValue, lockKey, ownerID string, ttl time.Duration) (*DistributedLock, error) {
    // Try to create the key with a revision check (optimistic locking)
    // PutIfAbsent will fail if the key already exists
    revision, err := kv.Create(ctx, lockKey, []byte(ownerID))
    if err != nil {
        return nil, fmt.Errorf("lock %s is held by another owner: %w", lockKey, err)
    }

    _ = revision
    return &DistributedLock{
        kv:      kv,
        key:     lockKey,
        ownerID: ownerID,
    }, nil
}

func (l *DistributedLock) Release(ctx context.Context) error {
    entry, err := l.kv.Get(ctx, l.key)
    if err != nil {
        return fmt.Errorf("getting lock entry: %w", err)
    }

    if string(entry.Value()) != l.ownerID {
        return fmt.Errorf("lock %s is held by %s, not %s", l.key, entry.Value(), l.ownerID)
    }

    return l.kv.Delete(ctx, l.key)
}
```

## Object Store for Large Payloads

```go
package objstore

import (
    "bytes"
    "context"
    "fmt"
    "io"
    "strings"

    "github.com/nats-io/nats.go"
    "github.com/nats-io/nats.go/jetstream"
)

func SetupObjectStore(ctx context.Context, nc *nats.Conn) error {
    js, err := jetstream.New(nc)
    if err != nil {
        return err
    }

    // Create an object store for ML model artifacts
    store, err := js.CreateOrUpdateObjectStore(ctx, jetstream.ObjectStoreConfig{
        Bucket:      "ml-models",
        Description: "Machine learning model artifacts",
        Storage:     jetstream.FileStorage,
        Replicas:    3,
        MaxChunkSize: 128 * 1024, // 128KB chunks
    })
    if err != nil {
        return fmt.Errorf("creating object store: %w", err)
    }

    // Store a large model file
    modelData := strings.NewReader("binary model data here...")
    info, err := store.Put(ctx, &jetstream.ObjectMeta{
        Name:        "classification-model-v2.pkl",
        Description: "Production classification model v2",
        Headers: nats.Header{
            "X-Model-Version":  []string{"v2.1.0"},
            "X-Model-Accuracy": []string{"0.97"},
        },
    }, modelData)
    if err != nil {
        return fmt.Errorf("storing model: %w", err)
    }
    fmt.Printf("Stored model: %s (%d bytes)\n", info.Name, info.Size)

    // Retrieve the model
    result, err := store.Get(ctx, "classification-model-v2.pkl")
    if err != nil {
        return fmt.Errorf("retrieving model: %w", err)
    }
    defer result.Close()

    var buf bytes.Buffer
    _, err = io.Copy(&buf, result)
    if err != nil {
        return fmt.Errorf("reading model data: %w", err)
    }

    fmt.Printf("Retrieved model: %d bytes\n", buf.Len())
    return nil
}
```

## NATS CLI Operations Reference

```bash
# Connect with credentials
export NATS_URL="nats://nats.messaging.svc.cluster.local:4222"

# Stream management
nats stream ls                                    # List all streams
nats stream info ORDERS                           # Stream details
nats stream edit ORDERS                           # Edit stream config
nats stream purge ORDERS --subject "orders.test" # Purge specific subject
nats stream rm ORDERS                             # Delete stream

# Consumer management
nats consumer ls ORDERS                           # List consumers
nats consumer info ORDERS order-processor        # Consumer details
nats consumer rm ORDERS order-processor          # Delete consumer

# Message operations
nats pub orders.created '{"order_id":"test-001","amount":99.99}'  # Publish
nats sub "orders.>"                              # Subscribe (core NATS, no history)
nats stream get ORDERS --seq 1                   # Get specific message by sequence

# Consumer testing
nats consumer next ORDERS order-processor        # Get one message
nats consumer next ORDERS order-processor --count 10  # Get batch

# JetStream account info
nats account info
nats account jetstream report

# Server info
nats server info
nats server list
nats server report connections
nats server report jetstream

# Key-Value operations
nats kv add feature-flags --replicas 3 --history 5
nats kv put feature-flags payments.new-flow true
nats kv get feature-flags payments.new-flow
nats kv watch feature-flags
nats kv ls feature-flags

# Object store operations
nats object add ml-models --replicas 3
nats object put ml-models ./model.pkl --name "model-v1.pkl"
nats object get ml-models model-v1.pkl -o /tmp/retrieved-model.pkl
nats object ls ml-models
```

## Kubernetes Network Policy for NATS

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: nats-server-network-policy
  namespace: messaging
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: nats
  policyTypes:
  - Ingress
  - Egress
  ingress:
  # Allow client connections
  - from:
    - namespaceSelector: {}
    ports:
    - port: 4222
      protocol: TCP
  # Allow TLS client connections
  - from:
    - namespaceSelector: {}
    ports:
    - port: 4223
      protocol: TCP
  # Allow cluster routing between NATS servers
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: nats
    ports:
    - port: 6222
      protocol: TCP
  # Allow metrics scraping from monitoring namespace
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    ports:
    - port: 7777
      protocol: TCP
  # Allow HTTP monitoring
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
    ports:
    - port: 8222
      protocol: TCP
  egress:
  # Allow cluster routing between NATS servers
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: nats
    ports:
    - port: 6222
      protocol: TCP
  # DNS
  - to:
    - namespaceSelector: {}
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

## Conclusion (Extended)

NATS JetStream provides a complete cloud-native messaging platform that covers event streaming, work queues, key-value storage, and object storage under a single unified API. The operational simplicity compared to Kafka -- no ZooKeeper, no separate schema registry, no broker configuration complexity -- makes it an excellent choice for teams that need persistence and delivery guarantees without dedicated Kafka expertise.

The Go-native API design makes NATS JetStream especially productive for Go-based microservices, enabling clean consumer implementations with proper backpressure, retry policies, and observability. Combined with NATS's sub-millisecond latency for core messaging and the durability guarantees of JetStream, teams get the best of both synchronous and asynchronous communication patterns from a single messaging platform.
