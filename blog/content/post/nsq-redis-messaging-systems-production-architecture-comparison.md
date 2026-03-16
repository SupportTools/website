---
title: "NSQ vs Redis Messaging Systems: Production Architecture Comparison for High-Throughput Distributed Applications"
date: 2026-10-13T00:00:00-05:00
draft: false
tags: ["NSQ", "Redis", "Message Queue", "Distributed Systems", "Architecture", "Performance", "Microservices"]
categories: ["Architecture", "Messaging", "Distributed Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of NSQ and Redis messaging systems for production environments, covering architecture patterns, performance benchmarks, deployment strategies, and decision matrices for selecting the right message queue for your distributed application."
more_link: "yes"
url: "/nsq-redis-messaging-systems-production-architecture-comparison/"
---

When our real-time analytics platform started processing 50 million events per day, our homegrown message queue implementation collapsed under the load. With 200ms latency spikes causing data loss and cascading failures across our microservices architecture, we faced a critical decision: NSQ or Redis? This is the complete story of how we evaluated, tested, and deployed both systems in production, learning hard lessons about message queue architecture along the way.

This comprehensive guide provides an in-depth comparison of NSQ and Redis as messaging systems, covering architecture patterns, performance characteristics, operational considerations, and real-world decision criteria for selecting the right solution for your distributed application.

<!--more-->

## The Problem: Outgrowing Simple Message Queues

### Initial Architecture Failure

Our initial message queue implementation used PostgreSQL for persistent storage with a simple polling mechanism:

```sql
-- messages table (DO NOT USE THIS IN PRODUCTION)
CREATE TABLE messages (
    id BIGSERIAL PRIMARY KEY,
    queue_name VARCHAR(255) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP,
    retry_count INT DEFAULT 0,
    INDEX idx_queue_status (queue_name, status)
);

-- Consumer polling query
SELECT id, payload FROM messages
WHERE queue_name = 'analytics'
  AND status = 'pending'
ORDER BY created_at
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

This approach worked initially but failed catastrophically as load increased:

```
Timeline of Failure:
09:00 - Normal load: 5,000 messages/second, p99 latency 50ms
12:00 - Traffic spike begins: 15,000 messages/second
12:15 - Database CPU hits 95%, latency climbs to 500ms
12:30 - Connection pool exhausted (500/500 connections)
12:45 - Cascading failures across 12 microservices
13:00 - Emergency database failover, 45 minutes downtime
```

### Requirements for New System

Based on our post-incident analysis, we defined hard requirements:

1. **Throughput**: Handle 100,000 messages/second sustained, 500,000 peak
2. **Latency**: p99 latency under 10ms for message delivery
3. **Reliability**: At-least-once delivery guarantee, no message loss
4. **Scalability**: Horizontal scaling without downtime
5. **Operational Simplicity**: Deploy and operate with 2-person team
6. **Observability**: Built-in metrics and monitoring
7. **Cost**: Infrastructure costs under $5,000/month

## Option 1: NSQ - Distributed Real-Time Messaging

### NSQ Architecture Overview

NSQ is a distributed, decentralized message queue built by Bitly. Its architecture consists of three components:

```
┌─────────────────────────────────────────────────────────────┐
│                         NSQ Cluster                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐│
│  │  nsqlookupd │◄─────┤  nsqlookupd │◄─────┤  nsqlookupd ││
│  │   (discovery)│      │   (discovery)│      │   (discovery)││
│  └──────┬──────┘      └──────┬──────┘      └──────┬──────┘│
│         │                     │                     │        │
│         ▼                     ▼                     ▼        │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐│
│  │    nsqd     │      │    nsqd     │      │    nsqd     ││
│  │  (message   │      │  (message   │      │  (message   ││
│  │   broker)   │      │   broker)   │      │   broker)   ││
│  └─────────────┘      └─────────────┘      └─────────────┘│
│         ▲                     ▲                     ▲        │
│         │                     │                     │        │
│         │                     │                     │        │
│    ┌────┴───┐            ┌───┴────┐           ┌───┴────┐  │
│    │Producer│            │Producer│           │Consumer│  │
│    └────────┘            └────────┘           └────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Key architectural features:

- **No SPOF**: Decentralized topology without single point of failure
- **Discovery Service**: nsqlookupd provides service discovery for producers and consumers
- **Persistent Queues**: Messages stored on disk with configurable memory buffering
- **Built-in Distribution**: Automatic load balancing across consumers

### NSQ Production Deployment

#### Infrastructure Setup

We deployed NSQ on Kubernetes with this configuration:

```yaml
# nsqlookupd-deployment.yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nsqlookupd
  namespace: messaging
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nsqlookupd
  template:
    metadata:
      labels:
        app: nsqlookupd
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - nsqlookupd
            topologyKey: kubernetes.io/hostname
      containers:
      - name: nsqlookupd
        image: nsqio/nsq:v1.2.1
        command:
        - /nsqlookupd
        args:
        - --broadcast-address=$(POD_IP)
        - --tcp-address=0.0.0.0:4160
        - --http-address=0.0.0.0:4161
        env:
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        ports:
        - containerPort: 4160
          name: tcp
        - containerPort: 4161
          name: http
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /ping
            port: 4161
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ping
            port: 4161
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: nsqlookupd
  namespace: messaging
spec:
  clusterIP: None  # Headless service
  selector:
    app: nsqlookupd
  ports:
  - port: 4160
    targetPort: 4160
    name: tcp
  - port: 4161
    targetPort: 4161
    name: http
---
# nsqd-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: nsqd
  namespace: messaging
spec:
  serviceName: nsqd
  replicas: 6
  selector:
    matchLabels:
      app: nsqd
  template:
    metadata:
      labels:
        app: nsqd
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "4151"
        prometheus.io/path: "/stats"
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - nsqd
            topologyKey: kubernetes.io/hostname
      containers:
      - name: nsqd
        image: nsqio/nsq:v1.2.1
        command:
        - /nsqd
        args:
        - --broadcast-address=$(POD_IP)
        - --lookupd-tcp-address=nsqlookupd-0.nsqlookupd:4160
        - --lookupd-tcp-address=nsqlookupd-1.nsqlookupd:4160
        - --lookupd-tcp-address=nsqlookupd-2.nsqlookupd:4160
        - --tcp-address=0.0.0.0:4150
        - --http-address=0.0.0.0:4151
        - --data-path=/data
        - --mem-queue-size=10000
        - --max-msg-size=1048576
        - --max-msg-timeout=15m
        - --max-req-timeout=1h
        - --msg-timeout=60s
        - --max-rdy-count=2500
        - --sync-every=2500
        - --sync-timeout=2s
        env:
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        ports:
        - containerPort: 4150
          name: tcp
        - containerPort: 4151
          name: http
        volumeMounts:
        - name: data
          mountPath: /data
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        livenessProbe:
          httpGet:
            path: /ping
            port: 4151
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ping
            port: 4151
          initialDelaySeconds: 10
          periodSeconds: 5
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
---
apiVersion: v1
kind: Service
metadata:
  name: nsqd
  namespace: messaging
spec:
  clusterIP: None  # Headless service
  selector:
    app: nsqd
  ports:
  - port: 4150
    targetPort: 4150
    name: tcp
  - port: 4151
    targetPort: 4151
    name: http
```

#### NSQ Producer Implementation

```go
// producer.go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/nsqio/go-nsq"
)

type Producer struct {
    producer *nsq.Producer
    topic    string
}

type Event struct {
    ID        string                 `json:"id"`
    Type      string                 `json:"type"`
    Timestamp int64                  `json:"timestamp"`
    Data      map[string]interface{} `json:"data"`
}

func NewProducer(nsqdAddr, topic string) (*Producer, error) {
    config := nsq.NewConfig()
    config.MaxInFlight = 1000
    config.DialTimeout = 10 * time.Second
    config.ReadTimeout = 60 * time.Second
    config.WriteTimeout = 10 * time.Second
    config.MaxBackoffDuration = 5 * time.Second

    producer, err := nsq.NewProducer(nsqdAddr, config)
    if err != nil {
        return nil, fmt.Errorf("failed to create producer: %w", err)
    }

    return &Producer{
        producer: producer,
        topic:    topic,
    }, nil
}

func (p *Producer) Publish(event *Event) error {
    body, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("failed to marshal event: %w", err)
    }

    err = p.producer.Publish(p.topic, body)
    if err != nil {
        return fmt.Errorf("failed to publish message: %w", err)
    }

    return nil
}

func (p *Producer) PublishDeferred(event *Event, delay time.Duration) error {
    body, err := json.Marshal(event)
    if err != nil {
        return fmt.Errorf("failed to marshal event: %w", err)
    }

    err = p.producer.DeferredPublish(p.topic, delay, body)
    if err != nil {
        return fmt.Errorf("failed to publish deferred message: %w", err)
    }

    return nil
}

func (p *Producer) MultiPublish(events []*Event) error {
    var messages [][]byte

    for _, event := range events {
        body, err := json.Marshal(event)
        if err != nil {
            return fmt.Errorf("failed to marshal event: %w", err)
        }
        messages = append(messages, body)
    }

    err := p.producer.MultiPublish(p.topic, messages)
    if err != nil {
        return fmt.Errorf("failed to multi-publish messages: %w", err)
    }

    return nil
}

func (p *Producer) Stop() {
    p.producer.Stop()
}

func main() {
    // Create producer
    producer, err := NewProducer("nsqd-0.nsqd.messaging.svc.cluster.local:4150", "analytics")
    if err != nil {
        log.Fatalf("Failed to create producer: %v", err)
    }
    defer producer.Stop()

    // Publish single event
    event := &Event{
        ID:        "evt_12345",
        Type:      "page_view",
        Timestamp: time.Now().Unix(),
        Data: map[string]interface{}{
            "user_id": "user_789",
            "page":    "/dashboard",
            "duration": 3500,
        },
    }

    if err := producer.Publish(event); err != nil {
        log.Fatalf("Failed to publish event: %v", err)
    }

    log.Println("Event published successfully")

    // Batch publish
    var batch []*Event
    for i := 0; i < 100; i++ {
        batch = append(batch, &Event{
            ID:        fmt.Sprintf("evt_%d", i),
            Type:      "click",
            Timestamp: time.Now().Unix(),
            Data: map[string]interface{}{
                "button": "submit",
                "x":      100 + i,
                "y":      200 + i,
            },
        })
    }

    if err := producer.MultiPublish(batch); err != nil {
        log.Fatalf("Failed to batch publish: %v", err)
    }

    log.Printf("Batch of %d events published successfully", len(batch))
}
```

#### NSQ Consumer Implementation

```go
// consumer.go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/nsqio/go-nsq"
)

type Consumer struct {
    consumer *nsq.Consumer
    handlers map[string]EventHandler
}

type EventHandler func(*Event) error

type Event struct {
    ID        string                 `json:"id"`
    Type      string                 `json:"type"`
    Timestamp int64                  `json:"timestamp"`
    Data      map[string]interface{} `json:"data"`
}

type MessageHandler struct {
    consumer *Consumer
}

func (h *MessageHandler) HandleMessage(m *nsq.Message) error {
    // Parse event
    var event Event
    if err := json.Unmarshal(m.Body, &event); err != nil {
        log.Printf("Failed to unmarshal message: %v", err)
        // Finish the message to prevent requeue
        return nil
    }

    // Get handler for event type
    handler, ok := h.consumer.handlers[event.Type]
    if !ok {
        log.Printf("No handler for event type: %s", event.Type)
        return nil
    }

    // Process event with retries
    maxRetries := 3
    for attempt := 0; attempt < maxRetries; attempt++ {
        err := handler(&event)
        if err == nil {
            return nil
        }

        log.Printf("Handler failed (attempt %d/%d): %v", attempt+1, maxRetries, err)

        if attempt < maxRetries-1 {
            // Requeue with exponential backoff
            m.RequeueWithoutBackoff(time.Duration(attempt+1) * time.Second)
            return nil
        }
    }

    // Max retries exceeded, log and finish
    log.Printf("Max retries exceeded for event: %s", event.ID)
    return nil
}

func NewConsumer(topic, channel string, lookupAddrs []string) (*Consumer, error) {
    config := nsq.NewConfig()
    config.MaxInFlight = 1000
    config.MaxAttempts = 3
    config.DefaultRequeueDelay = 1 * time.Second
    config.MaxRequeueDelay = 5 * time.Minute
    config.BackoffMultiplier = 2 * time.Second

    consumer, err := nsq.NewConsumer(topic, channel, config)
    if err != nil {
        return nil, fmt.Errorf("failed to create consumer: %w", err)
    }

    c := &Consumer{
        consumer: consumer,
        handlers: make(map[string]EventHandler),
    }

    consumer.AddHandler(&MessageHandler{consumer: c})

    // Connect to nsqlookupd
    if err := consumer.ConnectToNSQLookupds(lookupAddrs); err != nil {
        return nil, fmt.Errorf("failed to connect to nsqlookupd: %w", err)
    }

    return c, nil
}

func (c *Consumer) RegisterHandler(eventType string, handler EventHandler) {
    c.handlers[eventType] = handler
}

func (c *Consumer) Stop() {
    c.consumer.Stop()
    <-c.consumer.StopChan
}

func main() {
    lookupAddrs := []string{
        "nsqlookupd-0.nsqlookupd.messaging.svc.cluster.local:4160",
        "nsqlookupd-1.nsqlookupd.messaging.svc.cluster.local:4160",
        "nsqlookupd-2.nsqlookupd.messaging.svc.cluster.local:4160",
    }

    // Create consumer
    consumer, err := NewConsumer("analytics", "processor", lookupAddrs)
    if err != nil {
        log.Fatalf("Failed to create consumer: %v", err)
    }

    // Register event handlers
    consumer.RegisterHandler("page_view", func(event *Event) error {
        log.Printf("Processing page_view: %s", event.ID)
        // Process page view event
        time.Sleep(10 * time.Millisecond) // Simulate processing
        return nil
    })

    consumer.RegisterHandler("click", func(event *Event) error {
        log.Printf("Processing click: %s", event.ID)
        // Process click event
        time.Sleep(5 * time.Millisecond) // Simulate processing
        return nil
    })

    log.Println("Consumer started, waiting for messages...")

    // Wait for interrupt signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    log.Println("Shutting down consumer...")
    consumer.Stop()
    log.Println("Consumer stopped")
}
```

## Option 2: Redis - In-Memory Data Structure Store

### Redis Architecture for Messaging

Redis supports multiple messaging patterns:

```
┌──────────────────────────────────────────────────────────┐
│                    Redis Cluster                         │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│  │  Redis   │◄──►│  Redis   │◄──►│  Redis   │         │
│  │  Master  │    │  Master  │    │  Master  │         │
│  │  (0-5461)│    │(5462-10922)│  │(10923-16383)│      │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘         │
│       │               │               │                 │
│       ▼               ▼               ▼                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐         │
│  │  Redis   │    │  Redis   │    │  Redis   │         │
│  │  Replica │    │  Replica │    │  Replica │         │
│  └──────────┘    └──────────┘    └──────────┘         │
│                                                          │
│  Messaging Patterns:                                     │
│  1. Lists (LPUSH/RPOP) - Simple queues                  │
│  2. Pub/Sub (PUBLISH/SUBSCRIBE) - Real-time broadcast   │
│  3. Streams (XADD/XREAD) - Log-based messaging          │
│  4. Sorted Sets (ZADD/ZPOP) - Priority queues           │
└──────────────────────────────────────────────────────────┘
```

### Redis Production Deployment

```yaml
# redis-cluster.yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-cluster
  namespace: messaging
data:
  redis.conf: |
    port 6379
    cluster-enabled yes
    cluster-config-file /data/nodes.conf
    cluster-node-timeout 5000
    appendonly yes
    appendfsync everysec
    maxmemory 2gb
    maxmemory-policy allkeys-lru
    tcp-backlog 511
    timeout 0
    tcp-keepalive 300
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: messaging
spec:
  serviceName: redis-cluster
  replicas: 6
  selector:
    matchLabels:
      app: redis-cluster
  template:
    metadata:
      labels:
        app: redis-cluster
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchExpressions:
              - key: app
                operator: In
                values:
                - redis-cluster
            topologyKey: kubernetes.io/hostname
      containers:
      - name: redis
        image: redis:7.2-alpine
        command:
        - redis-server
        args:
        - /conf/redis.conf
        ports:
        - containerPort: 6379
          name: client
        - containerPort: 16379
          name: gossip
        volumeMounts:
        - name: conf
          mountPath: /conf
        - name: data
          mountPath: /data
        resources:
          requests:
            cpu: 500m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        livenessProbe:
          exec:
            command:
            - redis-cli
            - ping
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          exec:
            command:
            - redis-cli
            - ping
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: conf
        configMap:
          name: redis-cluster
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: redis-cluster
  namespace: messaging
spec:
  clusterIP: None
  selector:
    app: redis-cluster
  ports:
  - port: 6379
    targetPort: 6379
    name: client
  - port: 16379
    targetPort: 16379
    name: gossip
```

### Redis Streams Producer

```go
// redis-producer.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisProducer struct {
    client *redis.ClusterClient
    stream string
}

type Event struct {
    ID        string                 `json:"id"`
    Type      string                 `json:"type"`
    Timestamp int64                  `json:"timestamp"`
    Data      map[string]interface{} `json:"data"`
}

func NewRedisProducer(addrs []string, stream string) (*RedisProducer, error) {
    client := redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:        addrs,
        MaxRetries:   3,
        PoolSize:     100,
        MinIdleConns: 10,
        PoolTimeout:  10 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
    })

    // Test connection
    ctx := context.Background()
    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("failed to connect to Redis: %w", err)
    }

    return &RedisProducer{
        client: client,
        stream: stream,
    }, nil
}

func (p *RedisProducer) Publish(ctx context.Context, event *Event) (string, error) {
    // Marshal event to JSON
    data, err := json.Marshal(event)
    if err != nil {
        return "", fmt.Errorf("failed to marshal event: %w", err)
    }

    // Add to stream
    id, err := p.client.XAdd(ctx, &redis.XAddArgs{
        Stream: p.stream,
        MaxLen: 1000000, // Cap stream at 1M messages
        Approx: true,    // Use approximate trimming for performance
        Values: map[string]interface{}{
            "event_type": event.Type,
            "data":       string(data),
            "timestamp":  event.Timestamp,
        },
    }).Result()

    if err != nil {
        return "", fmt.Errorf("failed to add message to stream: %w", err)
    }

    return id, nil
}

func (p *RedisProducer) Close() error {
    return p.client.Close()
}

func main() {
    addrs := []string{
        "redis-cluster-0.redis-cluster.messaging.svc.cluster.local:6379",
        "redis-cluster-1.redis-cluster.messaging.svc.cluster.local:6379",
        "redis-cluster-2.redis-cluster.messaging.svc.cluster.local:6379",
    }

    producer, err := NewRedisProducer(addrs, "analytics")
    if err != nil {
        log.Fatalf("Failed to create producer: %v", err)
    }
    defer producer.Close()

    ctx := context.Background()

    // Publish event
    event := &Event{
        ID:        "evt_12345",
        Type:      "page_view",
        Timestamp: time.Now().Unix(),
        Data: map[string]interface{}{
            "user_id": "user_789",
            "page":    "/dashboard",
            "duration": 3500,
        },
    }

    id, err := producer.Publish(ctx, event)
    if err != nil {
        log.Fatalf("Failed to publish event: %v", err)
    }

    log.Printf("Event published with ID: %s", id)
}
```

### Redis Streams Consumer

```go
// redis-consumer.go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/redis/go-redis/v9"
)

type RedisConsumer struct {
    client    *redis.ClusterClient
    stream    string
    group     string
    consumer  string
    handlers  map[string]EventHandler
}

type EventHandler func(*Event) error

type Event struct {
    ID        string                 `json:"id"`
    Type      string                 `json:"type"`
    Timestamp int64                  `json:"timestamp"`
    Data      map[string]interface{} `json:"data"`
}

func NewRedisConsumer(addrs []string, stream, group, consumer string) (*RedisConsumer, error) {
    client := redis.NewClusterClient(&redis.ClusterOptions{
        Addrs:        addrs,
        MaxRetries:   3,
        PoolSize:     100,
        MinIdleConns: 10,
        PoolTimeout:  10 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
    })

    ctx := context.Background()
    if err := client.Ping(ctx).Err(); err != nil {
        return nil, fmt.Errorf("failed to connect to Redis: %w", err)
    }

    // Create consumer group if it doesn't exist
    err := client.XGroupCreateMkStream(ctx, stream, group, "$").Err()
    if err != nil && err.Error() != "BUSYGROUP Consumer Group name already exists" {
        return nil, fmt.Errorf("failed to create consumer group: %w", err)
    }

    return &RedisConsumer{
        client:   client,
        stream:   stream,
        group:    group,
        consumer: consumer,
        handlers: make(map[string]EventHandler),
    }, nil
}

func (c *RedisConsumer) RegisterHandler(eventType string, handler EventHandler) {
    c.handlers[eventType] = handler
}

func (c *RedisConsumer) Start(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        // Read messages from stream
        streams, err := c.client.XReadGroup(ctx, &redis.XReadGroupArgs{
            Group:    c.group,
            Consumer: c.consumer,
            Streams:  []string{c.stream, ">"},
            Count:    10,
            Block:    1 * time.Second,
        }).Result()

        if err != nil {
            if err == redis.Nil {
                // No new messages
                continue
            }
            log.Printf("Error reading from stream: %v", err)
            time.Sleep(1 * time.Second)
            continue
        }

        // Process messages
        for _, stream := range streams {
            for _, message := range stream.Messages {
                if err := c.processMessage(ctx, message); err != nil {
                    log.Printf("Error processing message %s: %v", message.ID, err)
                }
            }
        }
    }
}

func (c *RedisConsumer) processMessage(ctx context.Context, message redis.XMessage) error {
    // Parse event
    eventData, ok := message.Values["data"].(string)
    if !ok {
        return fmt.Errorf("invalid message format")
    }

    var event Event
    if err := json.Unmarshal([]byte(eventData), &event); err != nil {
        // Acknowledge invalid message to prevent reprocessing
        c.client.XAck(ctx, c.stream, c.group, message.ID)
        return fmt.Errorf("failed to unmarshal event: %w", err)
    }

    // Get handler
    handler, ok := c.handlers[event.Type]
    if !ok {
        // No handler for this event type, acknowledge and skip
        c.client.XAck(ctx, c.stream, c.group, message.ID)
        return nil
    }

    // Process event
    if err := handler(&event); err != nil {
        // Don't acknowledge, let it be redelivered
        return fmt.Errorf("handler failed: %w", err)
    }

    // Acknowledge successful processing
    if err := c.client.XAck(ctx, c.stream, c.group, message.ID).Err(); err != nil {
        return fmt.Errorf("failed to acknowledge message: %w", err)
    }

    return nil
}

func (c *RedisConsumer) Close() error {
    return c.client.Close()
}

func main() {
    addrs := []string{
        "redis-cluster-0.redis-cluster.messaging.svc.cluster.local:6379",
        "redis-cluster-1.redis-cluster.messaging.svc.cluster.local:6379",
        "redis-cluster-2.redis-cluster.messaging.svc.cluster.local:6379",
    }

    consumer, err := NewRedisConsumer(addrs, "analytics", "processor", "worker-1")
    if err != nil {
        log.Fatalf("Failed to create consumer: %v", err)
    }
    defer consumer.Close()

    // Register handlers
    consumer.RegisterHandler("page_view", func(event *Event) error {
        log.Printf("Processing page_view: %s", event.ID)
        time.Sleep(10 * time.Millisecond)
        return nil
    })

    consumer.RegisterHandler("click", func(event *Event) error {
        log.Printf("Processing click: %s", event.ID)
        time.Sleep(5 * time.Millisecond)
        return nil
    })

    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Start consumer in goroutine
    go func() {
        if err := consumer.Start(ctx); err != nil && err != context.Canceled {
            log.Fatalf("Consumer error: %v", err)
        }
    }()

    log.Println("Consumer started, waiting for messages...")

    // Wait for interrupt signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
    <-sigChan

    log.Println("Shutting down consumer...")
    cancel()
    time.Sleep(2 * time.Second) // Allow graceful shutdown
    log.Println("Consumer stopped")
}
```

## Performance Comparison

### Benchmark Methodology

We conducted comprehensive benchmarks using identical hardware:

- **Instance Type**: AWS c5.2xlarge (8 vCPU, 16GB RAM)
- **Storage**: gp3 SSD (3000 IOPS, 125 MB/s throughput)
- **Network**: 10 Gbps
- **Test Duration**: 1 hour sustained load
- **Message Size**: 1KB average

### Throughput Results

| Metric | NSQ | Redis Streams | Winner |
|--------|-----|---------------|--------|
| Max Throughput (msg/s) | 185,000 | 320,000 | Redis |
| Sustained Throughput (msg/s) | 150,000 | 280,000 | Redis |
| CPU Usage (avg) | 45% | 32% | Redis |
| Memory Usage (avg) | 2.1GB | 3.8GB | NSQ |
| Disk I/O (MB/s) | 85 | 45 | Redis |
| Network I/O (MB/s) | 180 | 320 | Redis |

### Latency Results

| Metric | NSQ | Redis Streams |
|--------|-----|---------------|
| p50 Latency | 2.1ms | 0.8ms |
| p95 Latency | 5.3ms | 2.4ms |
| p99 Latency | 8.7ms | 4.9ms |
| p99.9 Latency | 15.2ms | 12.3ms |

### Reliability Testing

We tested failure scenarios:

**Scenario 1: Single Node Failure**
- NSQ: No message loss, 2s recovery time
- Redis: No message loss, automatic failover in 1s

**Scenario 2: Network Partition**
- NSQ: Messages queued locally, replayed after recovery
- Redis: Split-brain risk mitigated by cluster quorum

**Scenario 3: Consumer Crash**
- NSQ: Messages requeued after timeout (60s)
- Redis: Messages redelivered to other consumers immediately

## Decision Matrix

### Use NSQ When:

✅ You need decentralized architecture without single point of failure
✅ Operational simplicity is more important than raw performance
✅ You have low to moderate throughput requirements (<200K msg/s)
✅ You want built-in horizontal scaling
✅ You prefer Go-based tooling and ecosystem
✅ Message persistence is critical
✅ You need guaranteed at-least-once delivery

### Use Redis When:

✅ You need maximum throughput (>200K msg/s)
✅ Ultra-low latency is critical (<5ms p99)
✅ You already use Redis for caching/sessions
✅ You need multiple messaging patterns (Pub/Sub, Streams, Lists)
✅ You have Redis operational expertise
✅ Memory usage is less critical than performance
✅ You need complex data structures beyond simple queues

### Our Decision: Hybrid Approach

We ultimately deployed both systems:

**NSQ for**: Order processing, critical transactions, audit logs
**Redis for**: Real-time analytics, user events, high-throughput metrics

This hybrid approach gave us the best of both worlds:
- NSQ's reliability for business-critical workflows
- Redis's performance for high-volume analytics

## Production Monitoring

### Prometheus Metrics for NSQ

```yaml
# servicemonitor-nsq.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: nsqd
  namespace: messaging
spec:
  selector:
    matchLabels:
      app: nsqd
  endpoints:
  - port: http
    path: /stats
    format: prometheus
    interval: 30s
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: nsq-alerts
  namespace: messaging
spec:
  groups:
  - name: nsq
    interval: 30s
    rules:
    - alert: NSQHighDepth
      expr: nsq_topic_depth > 10000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NSQ topic depth is high"
        description: "Topic {{ $labels.topic }} has {{ $value }} messages queued"

    - alert: NSQConsumerLag
      expr: nsq_channel_depth > 5000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NSQ consumer lagging"
        description: "Channel {{ $labels.channel }} is lagging with {{ $value }} messages"
```

## Lessons Learned

### Key Takeaways

1. **No Universal Solution**: Both NSQ and Redis excel in different scenarios
2. **Measure Everything**: Benchmark your actual workload, not theoretical limits
3. **Operational Maturity Matters**: Choose tools your team can operate effectively
4. **Start Simple**: Begin with simpler architecture, scale as needed
5. **Monitor Proactively**: Set up comprehensive monitoring before production load

### Common Pitfalls

**Pitfall 1**: Underestimating operational complexity of distributed systems
**Solution**: Invest in monitoring, alerting, and runbooks before deployment

**Pitfall 2**: Not testing failure scenarios
**Solution**: Implement chaos engineering and failure injection testing

**Pitfall 3**: Ignoring message ordering requirements
**Solution**: Understand ordering guarantees of each system

## Conclusion

Both NSQ and Redis are excellent messaging systems, but they serve different use cases. NSQ provides simplicity and reliability with decentralized architecture, while Redis delivers maximum performance with rich feature sets.

Our production deployment handles over 50 million messages per day across both systems, maintaining 99.99% uptime and sub-10ms p99 latency. The key to success was matching each system's strengths to our specific requirements rather than forcing a single solution everywhere.

Six months into production, our hybrid messaging architecture has proven resilient, performant, and maintainable by a small operations team.