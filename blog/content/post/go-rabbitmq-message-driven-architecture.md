---
title: "Building Message-Driven Microservices in Go with RabbitMQ"
date: 2026-07-16T09:00:00-05:00
draft: false
tags: ["golang", "rabbitmq", "microservices", "message-queue", "event-driven", "amqp", "mqtt"]
categories: ["Development", "Go", "Microservices", "Message Queues"]
---

## Introduction

Message-driven architecture has become a cornerstone of modern microservices design, enabling loosely coupled, scalable, and resilient systems. Go's concurrency model makes it particularly well-suited for building high-performance message-processing applications, while RabbitMQ provides a robust and feature-rich message broker to handle communication between services.

In this comprehensive guide, we'll explore how to build message-driven microservices in Go using RabbitMQ. We'll cover everything from setting up the infrastructure with Docker to implementing various messaging patterns and best practices for production deployments.

## Setting Up RabbitMQ with Docker

Before diving into Go code, let's set up a local RabbitMQ environment using Docker. This setup includes the Management UI and MQTT support for IoT applications.

### Create a Docker Compose File

Create a file named `docker-compose.yml`:

```yaml
version: '3.8'

services:
  rabbitmq:
    image: rabbitmq:3.11-management
    container_name: rabbitmq
    restart: unless-stopped
    ports:
      - "5672:5672"   # AMQP port
      - "15672:15672" # Management UI
      - "1883:1883"   # MQTT port
      - "15675:15675" # MQTT over WebSocket
    environment:
      RABBITMQ_DEFAULT_USER: admin
      RABBITMQ_DEFAULT_PASS: admin123
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq
      - ./rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf
      - ./enabled_plugins:/etc/rabbitmq/enabled_plugins
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "ping"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  rabbitmq_data:
```

### Create Configuration Files

Create a `rabbitmq.conf` file:

```
# Enable MQTT plugin
mqtt.listeners.tcp.default = 1883
mqtt.allow_anonymous = false
mqtt.vhost = /
mqtt.exchange = amq.topic

# Security settings
loopback_users = none
```

Create an `enabled_plugins` file:

```
[rabbitmq_management,rabbitmq_mqtt,rabbitmq_web_mqtt].
```

### Start the RabbitMQ Container

Run Docker Compose to start RabbitMQ:

```bash
docker-compose up -d
```

Verify that RabbitMQ is running:

```bash
docker ps
```

You should now be able to access the Management UI at http://localhost:15672 with the username `admin` and password `admin123`.

## Go Client Libraries for RabbitMQ

In Go, there are several libraries for working with RabbitMQ. We'll use the popular `github.com/rabbitmq/amqp091-go` package, which is a maintained fork of the original `github.com/streadway/amqp` package.

Let's start by installing the library:

```bash
go get github.com/rabbitmq/amqp091-go
```

## Building a Simple Publisher and Consumer

Let's create a basic publisher and consumer to understand the fundamentals.

### Publisher (Basic)

```go
package main

import (
    "context"
    "log"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
)

func main() {
    // Connect to RabbitMQ
    conn, err := amqp.Dial("amqp://admin:admin123@localhost:5672/")
    if err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer conn.Close()
    
    // Create a channel
    ch, err := conn.Channel()
    if err != nil {
        log.Fatalf("Failed to open a channel: %v", err)
    }
    defer ch.Close()
    
    // Declare a queue
    q, err := ch.QueueDeclare(
        "hello", // queue name
        false,   // durable
        false,   // delete when unused
        false,   // exclusive
        false,   // no-wait
        nil,     // arguments
    )
    if err != nil {
        log.Fatalf("Failed to declare a queue: %v", err)
    }
    
    // Context for publishing
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    
    // Message to publish
    body := "Hello World!"
    
    // Publish a message
    err = ch.PublishWithContext(
        ctx,
        "",     // exchange
        q.Name, // routing key
        false,  // mandatory
        false,  // immediate
        amqp.Publishing{
            ContentType: "text/plain",
            Body:        []byte(body),
        },
    )
    if err != nil {
        log.Fatalf("Failed to publish a message: %v", err)
    }
    
    log.Printf("Sent %s", body)
}
```

### Consumer (Basic)

```go
package main

import (
    "log"
    
    amqp "github.com/rabbitmq/amqp091-go"
)

func main() {
    // Connect to RabbitMQ
    conn, err := amqp.Dial("amqp://admin:admin123@localhost:5672/")
    if err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer conn.Close()
    
    // Create a channel
    ch, err := conn.Channel()
    if err != nil {
        log.Fatalf("Failed to open a channel: %v", err)
    }
    defer ch.Close()
    
    // Declare the same queue as the publisher
    q, err := ch.QueueDeclare(
        "hello", // queue name
        false,   // durable
        false,   // delete when unused
        false,   // exclusive
        false,   // no-wait
        nil,     // arguments
    )
    if err != nil {
        log.Fatalf("Failed to declare a queue: %v", err)
    }
    
    // Consume messages
    msgs, err := ch.Consume(
        q.Name, // queue
        "",     // consumer
        true,   // auto-ack
        false,  // exclusive
        false,  // no-local
        false,  // no-wait
        nil,    // args
    )
    if err != nil {
        log.Fatalf("Failed to register a consumer: %v", err)
    }
    
    // Forever channel to keep the consumer running
    forever := make(chan bool)
    
    // Process messages
    go func() {
        for d := range msgs {
            log.Printf("Received a message: %s", d.Body)
        }
    }()
    
    log.Printf("Waiting for messages. To exit press CTRL+C")
    <-forever
}
```

## Building a Robust RabbitMQ Client

For production use, we need a more robust client with connection recovery, proper error handling, and clean shutdown. Let's create a reusable RabbitMQ client package.

### Creating a RabbitMQ Client Package

Create a file named `rabbitmq/client.go`:

```go
package rabbitmq

import (
    "context"
    "errors"
    "fmt"
    "log"
    "sync"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
)

// Config holds the configuration for the RabbitMQ client
type Config struct {
    URL           string
    ReconnectDelay time.Duration
}

// Client is a wrapper around amqp.Connection and amqp.Channel
type Client struct {
    config Config
    conn   *amqp.Connection
    ch     *amqp.Channel
    
    connCloseChan chan *amqp.Error
    chCloseChan   chan *amqp.Error
    
    isConnected bool
    mu          sync.RWMutex
    
    // Hooks for connection events
    OnConnect    func()
    OnDisconnect func(err error)
}

// NewClient creates a new RabbitMQ client
func NewClient(config Config) *Client {
    if config.ReconnectDelay == 0 {
        config.ReconnectDelay = 5 * time.Second
    }
    
    client := &Client{
        config:      config,
        isConnected: false,
    }
    
    return client
}

// Connect establishes a connection to RabbitMQ
func (c *Client) Connect() error {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    if c.isConnected {
        return nil
    }
    
    var err error
    
    // Connect to RabbitMQ
    c.conn, err = amqp.Dial(c.config.URL)
    if err != nil {
        return fmt.Errorf("failed to connect to RabbitMQ: %w", err)
    }
    
    // Create a channel
    c.ch, err = c.conn.Channel()
    if err != nil {
        c.conn.Close()
        return fmt.Errorf("failed to open a channel: %w", err)
    }
    
    // Set up notification channels for connection and channel close
    c.connCloseChan = make(chan *amqp.Error)
    c.conn.NotifyClose(c.connCloseChan)
    
    c.chCloseChan = make(chan *amqp.Error)
    c.ch.NotifyClose(c.chCloseChan)
    
    c.isConnected = true
    
    // Start the reconnect listener
    go c.handleReconnect()
    
    // Notify connection established
    if c.OnConnect != nil {
        c.OnConnect()
    }
    
    return nil
}

// handleReconnect attempts to reconnect when the connection is lost
func (c *Client) handleReconnect() {
    var connErr, chErr *amqp.Error
    
    for {
        select {
        case connErr = <-c.connCloseChan:
            c.mu.Lock()
            c.isConnected = false
            c.mu.Unlock()
            
            if c.OnDisconnect != nil {
                c.OnDisconnect(connErr)
            }
            
            log.Printf("RabbitMQ connection closed: %v. Reconnecting...", connErr)
            c.reconnect()
            return
            
        case chErr = <-c.chCloseChan:
            c.mu.Lock()
            c.isConnected = false
            c.mu.Unlock()
            
            if c.OnDisconnect != nil {
                c.OnDisconnect(chErr)
            }
            
            log.Printf("RabbitMQ channel closed: %v. Reconnecting...", chErr)
            c.reconnect()
            return
        }
    }
}

// reconnect attempts to reconnect to RabbitMQ with exponential backoff
func (c *Client) reconnect() {
    backoff := c.config.ReconnectDelay
    maxBackoff := 2 * time.Minute
    
    for {
        time.Sleep(backoff)
        
        err := c.Connect()
        if err == nil {
            log.Println("Successfully reconnected to RabbitMQ")
            return
        }
        
        log.Printf("Failed to reconnect to RabbitMQ: %v", err)
        
        // Exponential backoff with maximum
        backoff *= 2
        if backoff > maxBackoff {
            backoff = maxBackoff
        }
    }
}

// IsConnected returns the current connection status
func (c *Client) IsConnected() bool {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.isConnected
}

// Connection returns the underlying AMQP connection
func (c *Client) Connection() *amqp.Connection {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.conn
}

// Channel returns the underlying AMQP channel
func (c *Client) Channel() *amqp.Channel {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.ch
}

// Close closes the connection and channel
func (c *Client) Close() error {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    if !c.isConnected {
        return nil
    }
    
    if err := c.ch.Close(); err != nil {
        return fmt.Errorf("failed to close channel: %w", err)
    }
    
    if err := c.conn.Close(); err != nil {
        return fmt.Errorf("failed to close connection: %w", err)
    }
    
    c.isConnected = false
    return nil
}

// DeclareQueue declares a queue and returns it
func (c *Client) DeclareQueue(name string, durable, autoDelete, exclusive bool) (amqp.Queue, error) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    if !c.isConnected {
        return amqp.Queue{}, errors.New("not connected to RabbitMQ")
    }
    
    return c.ch.QueueDeclare(
        name,       // name
        durable,    // durable
        autoDelete, // delete when unused
        exclusive,  // exclusive
        false,      // no-wait
        nil,        // arguments
    )
}

// DeclareExchange declares an exchange
func (c *Client) DeclareExchange(name, kind string, durable, autoDelete bool) error {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    if !c.isConnected {
        return errors.New("not connected to RabbitMQ")
    }
    
    return c.ch.ExchangeDeclare(
        name,       // name
        kind,       // type
        durable,    // durable
        autoDelete, // auto-deleted
        false,      // internal
        false,      // no-wait
        nil,        // arguments
    )
}

// BindQueue binds a queue to an exchange
func (c *Client) BindQueue(queueName, routingKey, exchangeName string) error {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    if !c.isConnected {
        return errors.New("not connected to RabbitMQ")
    }
    
    return c.ch.QueueBind(
        queueName,    // queue name
        routingKey,   // routing key
        exchangeName, // exchange
        false,        // no-wait
        nil,          // arguments
    )
}

// Publish publishes a message to an exchange
func (c *Client) Publish(ctx context.Context, exchange, routingKey string, mandatory, immediate bool, msg amqp.Publishing) error {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    if !c.isConnected {
        return errors.New("not connected to RabbitMQ")
    }
    
    return c.ch.PublishWithContext(
        ctx,
        exchange,   // exchange
        routingKey, // routing key
        mandatory,  // mandatory
        immediate,  // immediate
        msg,        // message
    )
}

// Consume starts consuming messages from a queue
func (c *Client) Consume(queueName, consumerName string, autoAck, exclusive bool) (<-chan amqp.Delivery, error) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    if !c.isConnected {
        return nil, errors.New("not connected to RabbitMQ")
    }
    
    return c.ch.Consume(
        queueName,    // queue
        consumerName, // consumer
        autoAck,      // auto-ack
        exclusive,    // exclusive
        false,        // no-local
        false,        // no-wait
        nil,          // args
    )
}

// QoS sets the prefetch count
func (c *Client) QoS(prefetchCount, prefetchSize int) error {
    c.mu.RLock()
    defer c.mu.RUnlock()
    
    if !c.isConnected {
        return errors.New("not connected to RabbitMQ")
    }
    
    return c.ch.Qos(
        prefetchCount, // prefetch count
        prefetchSize,  // prefetch size
        false,         // global
    )
}
```

## Common Messaging Patterns with RabbitMQ

Now let's explore some common messaging patterns in microservices architecture using our robust RabbitMQ client.

### 1. Work Queues (Task Distribution)

Work queues are useful for distributing time-consuming tasks among multiple workers.

#### Producer for Work Queue

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Declare a queue
    queue, err := client.DeclareQueue(
        "tasks", // name
        true,    // durable
        false,   // autoDelete
        false,   // exclusive
    )
    if err != nil {
        log.Fatalf("Failed to declare a queue: %v", err)
    }
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    go func() {
        for i := 1; ; i++ {
            select {
            case <-signals:
                return
            default:
                // Create a task message
                task := fmt.Sprintf("Task %d", i)
                
                // Context for publishing
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                
                // Publish the task
                err := client.Publish(
                    ctx,
                    "",        // exchange
                    queue.Name, // routing key
                    false,     // mandatory
                    false,     // immediate
                    amqp.Publishing{
                        ContentType:  "text/plain",
                        Body:         []byte(task),
                        DeliveryMode: amqp.Persistent, // Make message persistent
                    },
                )
                cancel()
                
                if err != nil {
                    log.Printf("Failed to publish a message: %v", err)
                } else {
                    log.Printf("Sent task: %s", task)
                }
                
                time.Sleep(1 * time.Second)
            }
        }
    }()
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}
```

#### Worker for Work Queue

```go
package main

import (
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Set reconnection handlers
    client.OnConnect = func() {
        log.Println("Connected to RabbitMQ, starting to consume messages")
        startConsuming(client)
    }
    
    client.OnDisconnect = func(err error) {
        log.Printf("Disconnected from RabbitMQ: %v", err)
    }
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}

func startConsuming(client *rabbitmq.Client) {
    // Declare the same queue as the producer
    queue, err := client.DeclareQueue(
        "tasks", // name
        true,    // durable
        false,   // autoDelete
        false,   // exclusive
    )
    if err != nil {
        log.Printf("Failed to declare a queue: %v", err)
        return
    }
    
    // Set QoS to limit the number of unacknowledged messages
    err = client.QoS(1, 0)
    if err != nil {
        log.Printf("Failed to set QoS: %v", err)
        return
    }
    
    // Start consuming messages
    msgs, err := client.Consume(
        queue.Name, // queue
        "",        // consumer
        false,     // auto-ack (important: using manual ack)
        false,     // exclusive
    )
    if err != nil {
        log.Printf("Failed to register a consumer: %v", err)
        return
    }
    
    // Process messages
    go func() {
        for d := range msgs {
            log.Printf("Received task: %s", d.Body)
            
            // Simulate processing time
            time.Sleep(2 * time.Second)
            
            // Acknowledge the message after processing
            if err := d.Ack(false); err != nil {
                log.Printf("Failed to acknowledge message: %v", err)
            } else {
                log.Printf("Completed task: %s", d.Body)
            }
        }
    }()
}
```

### 2. Publish/Subscribe (Fanout)

The publish/subscribe pattern broadcasts messages to multiple consumers using an exchange.

#### Publisher for Pub/Sub

```go
package main

import (
    "context"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Declare a fanout exchange
    exchangeName := "logs"
    if err := client.DeclareExchange(
        exchangeName, // name
        "fanout",    // type
        true,        // durable
        false,       // autoDelete
    ); err != nil {
        log.Fatalf("Failed to declare an exchange: %v", err)
    }
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    go func() {
        count := 0
        for {
            select {
            case <-signals:
                return
            default:
                count++
                // Create a log message
                message := []byte(time.Now().Format(time.RFC3339) + " - Log message #" + string(count))
                
                // Context for publishing
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                
                // Publish to the fanout exchange
                err := client.Publish(
                    ctx,
                    exchangeName, // exchange
                    "",          // routing key (not used in fanout)
                    false,       // mandatory
                    false,       // immediate
                    amqp.Publishing{
                        ContentType: "text/plain",
                        Body:        message,
                    },
                )
                cancel()
                
                if err != nil {
                    log.Printf("Failed to publish a message: %v", err)
                } else {
                    log.Printf("Sent log: %s", message)
                }
                
                time.Sleep(1 * time.Second)
            }
        }
    }()
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}
```

#### Subscriber for Pub/Sub

```go
package main

import (
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Set reconnection handlers
    client.OnConnect = func() {
        log.Println("Connected to RabbitMQ, starting to consume messages")
        startConsuming(client)
    }
    
    client.OnDisconnect = func(err error) {
        log.Printf("Disconnected from RabbitMQ: %v", err)
    }
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}

func startConsuming(client *rabbitmq.Client) {
    // Declare the same exchange as the publisher
    exchangeName := "logs"
    if err := client.DeclareExchange(
        exchangeName, // name
        "fanout",    // type
        true,        // durable
        false,       // autoDelete
    ); err != nil {
        log.Printf("Failed to declare an exchange: %v", err)
        return
    }
    
    // Declare an exclusive, auto-delete queue with a random name
    queue, err := client.DeclareQueue(
        "",    // empty name for random queue name
        false, // not durable
        true,  // autoDelete
        true,  // exclusive
    )
    if err != nil {
        log.Printf("Failed to declare a queue: %v", err)
        return
    }
    
    // Bind the queue to the exchange
    if err := client.BindQueue(queue.Name, "", exchangeName); err != nil {
        log.Printf("Failed to bind queue: %v", err)
        return
    }
    
    // Start consuming messages
    msgs, err := client.Consume(
        queue.Name, // queue
        "",        // consumer
        true,      // auto-ack
        false,     // exclusive
    )
    if err != nil {
        log.Printf("Failed to register a consumer: %v", err)
        return
    }
    
    // Process messages
    go func() {
        for d := range msgs {
            log.Printf("Received log: %s", d.Body)
        }
    }()
    
    log.Printf("Subscribed to logs exchange with queue %s", queue.Name)
}
```

### 3. Routing (Direct Exchange)

The routing pattern allows you to route messages to specific queues based on a routing key.

#### Publisher for Routing

```go
package main

import (
    "context"
    "log"
    "math/rand"
    "os"
    "os/signal"
    "strings"
    "syscall"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Declare a direct exchange
    exchangeName := "logs_direct"
    if err := client.DeclareExchange(
        exchangeName, // name
        "direct",    // type
        true,        // durable
        false,       // autoDelete
    ); err != nil {
        log.Fatalf("Failed to declare an exchange: %v", err)
    }
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Seed the random number generator
    rand.Seed(time.Now().UnixNano())
    
    // Define severity levels for logging
    severities := []string{"info", "warning", "error"}
    
    go func() {
        count := 0
        for {
            select {
            case <-signals:
                return
            default:
                count++
                
                // Choose a random severity
                severity := severities[rand.Intn(len(severities))]
                
                // Create a log message
                message := []byte(time.Now().Format(time.RFC3339) + " - " + 
                    strings.ToUpper(severity) + " - Log message #" + string(count))
                
                // Context for publishing
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                
                // Publish to the direct exchange with the severity as the routing key
                err := client.Publish(
                    ctx,
                    exchangeName, // exchange
                    severity,    // routing key is the severity
                    false,       // mandatory
                    false,       // immediate
                    amqp.Publishing{
                        ContentType: "text/plain",
                        Body:        message,
                    },
                )
                cancel()
                
                if err != nil {
                    log.Printf("Failed to publish a message: %v", err)
                } else {
                    log.Printf("Sent %s log: %s", severity, message)
                }
                
                time.Sleep(1 * time.Second)
            }
        }
    }()
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}
```

#### Subscriber for Routing (Error Handler)

```go
package main

import (
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Set reconnection handlers
    client.OnConnect = func() {
        log.Println("Connected to RabbitMQ, starting to consume messages")
        startConsuming(client)
    }
    
    client.OnDisconnect = func(err error) {
        log.Printf("Disconnected from RabbitMQ: %v", err)
    }
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}

func startConsuming(client *rabbitmq.Client) {
    // Declare the same exchange as the publisher
    exchangeName := "logs_direct"
    if err := client.DeclareExchange(
        exchangeName, // name
        "direct",    // type
        true,        // durable
        false,       // autoDelete
    ); err != nil {
        log.Printf("Failed to declare an exchange: %v", err)
        return
    }
    
    // Declare an exclusive, auto-delete queue with a random name
    queue, err := client.DeclareQueue(
        "error_logs", // specific name for this consumer
        true,         // durable
        false,        // not autoDelete
        false,        // not exclusive
    )
    if err != nil {
        log.Printf("Failed to declare a queue: %v", err)
        return
    }
    
    // Bind the queue to the exchange with routing key 'error'
    if err := client.BindQueue(queue.Name, "error", exchangeName); err != nil {
        log.Printf("Failed to bind queue: %v", err)
        return
    }
    
    // Start consuming messages
    msgs, err := client.Consume(
        queue.Name, // queue
        "",        // consumer
        true,      // auto-ack
        false,     // exclusive
    )
    if err != nil {
        log.Printf("Failed to register a consumer: %v", err)
        return
    }
    
    // Process messages
    go func() {
        for d := range msgs {
            log.Printf("Error handler received: %s", d.Body)
            
            // Here you would handle the error, e.g., send alerts, log to a database, etc.
        }
    }()
    
    log.Printf("Subscribed to logs_direct exchange for errors with queue %s", queue.Name)
}
```

### 4. Topics (Pattern Matching)

The topics pattern allows you to route messages based on wildcard pattern matching.

#### Publisher for Topics

```go
package main

import (
    "context"
    "fmt"
    "log"
    "math/rand"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Declare a topic exchange
    exchangeName := "logs_topic"
    if err := client.DeclareExchange(
        exchangeName, // name
        "topic",     // type
        true,        // durable
        false,       // autoDelete
    ); err != nil {
        log.Fatalf("Failed to declare an exchange: %v", err)
    }
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Seed the random number generator
    rand.Seed(time.Now().UnixNano())
    
    // Define facilities and severities for topic routing keys
    facilities := []string{"auth", "payment", "order", "shipping"}
    severities := []string{"info", "warning", "error", "critical"}
    
    go func() {
        count := 0
        for {
            select {
            case <-signals:
                return
            default:
                count++
                
                // Choose a random facility and severity
                facility := facilities[rand.Intn(len(facilities))]
                severity := severities[rand.Intn(len(severities))]
                
                // Create a routing key in the format "facility.severity"
                routingKey := fmt.Sprintf("%s.%s", facility, severity)
                
                // Create a log message
                message := []byte(time.Now().Format(time.RFC3339) + " - " + 
                    routingKey + " - Log message #" + string(count))
                
                // Context for publishing
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                
                // Publish to the topic exchange
                err := client.Publish(
                    ctx,
                    exchangeName, // exchange
                    routingKey,  // routing key
                    false,       // mandatory
                    false,       // immediate
                    amqp.Publishing{
                        ContentType: "text/plain",
                        Body:        message,
                    },
                )
                cancel()
                
                if err != nil {
                    log.Printf("Failed to publish a message: %v", err)
                } else {
                    log.Printf("Sent message with routing key %s: %s", routingKey, message)
                }
                
                time.Sleep(1 * time.Second)
            }
        }
    }()
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}
```

#### Subscriber for Topics (Payment Errors)

```go
package main

import (
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    "github.com/yourusername/yourapp/rabbitmq"
)

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Set reconnection handlers
    client.OnConnect = func() {
        log.Println("Connected to RabbitMQ, starting to consume messages")
        startConsuming(client)
    }
    
    client.OnDisconnect = func(err error) {
        log.Printf("Disconnected from RabbitMQ: %v", err)
    }
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}

func startConsuming(client *rabbitmq.Client) {
    // Declare the same exchange as the publisher
    exchangeName := "logs_topic"
    if err := client.DeclareExchange(
        exchangeName, // name
        "topic",     // type
        true,        // durable
        false,       // autoDelete
    ); err != nil {
        log.Printf("Failed to declare an exchange: %v", err)
        return
    }
    
    // Declare a durable queue for payment errors
    queue, err := client.DeclareQueue(
        "payment_errors", // specific name for this consumer
        true,            // durable
        false,           // not autoDelete
        false,           // not exclusive
    )
    if err != nil {
        log.Printf("Failed to declare a queue: %v", err)
        return
    }
    
    // Bind the queue to the exchange with routing patterns
    // This will capture all payment errors and critical messages
    if err := client.BindQueue(queue.Name, "payment.error", exchangeName); err != nil {
        log.Printf("Failed to bind queue: %v", err)
        return
    }
    
    if err := client.BindQueue(queue.Name, "payment.critical", exchangeName); err != nil {
        log.Printf("Failed to bind queue: %v", err)
        return
    }
    
    // Start consuming messages
    msgs, err := client.Consume(
        queue.Name, // queue
        "",        // consumer
        true,      // auto-ack
        false,     // exclusive
    )
    if err != nil {
        log.Printf("Failed to register a consumer: %v", err)
        return
    }
    
    // Process messages
    go func() {
        for d := range msgs {
            log.Printf("Payment error handler received: %s", d.Body)
            log.Printf("  Routing Key: %s", d.RoutingKey)
            
            // Here you would handle the payment error, e.g., notify support team, etc.
        }
    }()
    
    log.Printf("Subscribed to logs_topic exchange for payment errors")
}
```

### 5. Request-Reply Pattern

The request-reply pattern allows for synchronous communication between services.

#### Client for Request-Reply

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "math/rand"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
    "github.com/google/uuid"
    "github.com/yourusername/yourapp/rabbitmq"
)

// Request represents a calculation request
type Request struct {
    Operation string  `json:"operation"`
    A         float64 `json:"a"`
    B         float64 `json:"b"`
}

// Response represents a calculation response
type Response struct {
    Result float64 `json:"result"`
    Error  string  `json:"error,omitempty"`
}

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Declare request queue
    requestQueue, err := client.DeclareQueue(
        "rpc_queue", // name
        true,       // durable
        false,      // autoDelete
        false,      // exclusive
    )
    if err != nil {
        log.Fatalf("Failed to declare a queue: %v", err)
    }
    
    // Declare response queue (exclusive, auto-delete)
    responseQueue, err := client.DeclareQueue(
        "",    // empty name for a random name
        false, // not durable
        true,  // autoDelete
        true,  // exclusive
    )
    if err != nil {
        log.Fatalf("Failed to declare a queue: %v", err)
    }
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Start consuming responses
    responses, err := client.Consume(
        responseQueue.Name, // queue
        "",                // consumer
        true,              // auto-ack
        true,              // exclusive
    )
    if err != nil {
        log.Fatalf("Failed to register a consumer: %v", err)
    }
    
    // Map to track pending requests
    pendingRequests := make(map[string]chan Response)
    
    // Process responses in a goroutine
    go func() {
        for d := range responses {
            correlationID := d.CorrelationId
            
            // Find the channel for this correlation ID
            if ch, ok := pendingRequests[correlationID]; ok {
                var resp Response
                if err := json.Unmarshal(d.Body, &resp); err != nil {
                    log.Printf("Failed to unmarshal response: %v", err)
                    continue
                }
                
                // Send the response to the waiting goroutine
                ch <- resp
                
                // Remove from pending requests
                delete(pendingRequests, correlationID)
            } else {
                log.Printf("Received response for unknown correlation ID: %s", correlationID)
            }
        }
    }()
    
    // Operations to test
    operations := []string{"add", "subtract", "multiply", "divide"}
    
    // Send requests in a goroutine
    go func() {
        for {
            select {
            case <-signals:
                return
            default:
                // Choose a random operation
                operation := operations[rand.Intn(len(operations))]
                
                // Generate random numbers
                a := rand.Float64() * 100
                b := rand.Float64() * 100
                
                // Create a correlation ID
                correlationID := uuid.New().String()
                
                // Create a channel for this request
                responseCh := make(chan Response, 1)
                pendingRequests[correlationID] = responseCh
                
                // Create request
                req := Request{
                    Operation: operation,
                    A:         a,
                    B:         b,
                }
                
                // Marshal request to JSON
                reqBytes, err := json.Marshal(req)
                if err != nil {
                    log.Printf("Failed to marshal request: %v", err)
                    continue
                }
                
                // Context for publishing
                ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                
                // Publish the request
                err = client.Publish(
                    ctx,
                    "",              // exchange
                    requestQueue.Name, // routing key
                    false,           // mandatory
                    false,           // immediate
                    amqp.Publishing{
                        ContentType:   "application/json",
                        CorrelationId: correlationID,
                        ReplyTo:       responseQueue.Name,
                        Body:          reqBytes,
                    },
                )
                cancel()
                
                if err != nil {
                    log.Printf("Failed to publish a request: %v", err)
                    delete(pendingRequests, correlationID)
                    continue
                }
                
                log.Printf("Sent request: %s(%f, %f)", operation, a, b)
                
                // Wait for response with timeout
                select {
                case resp := <-responseCh:
                    if resp.Error != "" {
                        log.Printf("Received error response: %s", resp.Error)
                    } else {
                        log.Printf("Received response: %f", resp.Result)
                    }
                case <-time.After(5 * time.Second):
                    log.Printf("Request timed out: %s", correlationID)
                    delete(pendingRequests, correlationID)
                }
                
                time.Sleep(2 * time.Second)
            }
        }
    }()
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}
```

#### Server for Request-Reply

```go
package main

import (
    "context"
    "encoding/json"
    "errors"
    "log"
    "os"
    "os/signal"
    "syscall"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
    "github.com/yourusername/yourapp/rabbitmq"
)

// Request represents a calculation request
type Request struct {
    Operation string  `json:"operation"`
    A         float64 `json:"a"`
    B         float64 `json:"b"`
}

// Response represents a calculation response
type Response struct {
    Result float64 `json:"result"`
    Error  string  `json:"error,omitempty"`
}

func main() {
    // Create RabbitMQ client
    client := rabbitmq.NewClient(rabbitmq.Config{
        URL:           "amqp://admin:admin123@localhost:5672/",
        ReconnectDelay: 5 * time.Second,
    })
    
    // Set reconnection handlers
    client.OnConnect = func() {
        log.Println("Connected to RabbitMQ, starting to consume requests")
        startConsuming(client)
    }
    
    client.OnDisconnect = func(err error) {
        log.Printf("Disconnected from RabbitMQ: %v", err)
    }
    
    // Connect to RabbitMQ
    if err := client.Connect(); err != nil {
        log.Fatalf("Failed to connect to RabbitMQ: %v", err)
    }
    defer client.Close()
    
    // Set up signal handling for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Wait for termination signal
    <-signals
    log.Println("Shutting down...")
}

func startConsuming(client *rabbitmq.Client) {
    // Declare the request queue
    queue, err := client.DeclareQueue(
        "rpc_queue", // name
        true,       // durable
        false,      // autoDelete
        false,      // exclusive
    )
    if err != nil {
        log.Printf("Failed to declare a queue: %v", err)
        return
    }
    
    // Set QoS to limit the number of unacknowledged messages
    err = client.QoS(1, 0)
    if err != nil {
        log.Printf("Failed to set QoS: %v", err)
        return
    }
    
    // Start consuming requests
    requests, err := client.Consume(
        queue.Name, // queue
        "",        // consumer
        false,     // auto-ack (important: using manual ack)
        false,     // exclusive
    )
    if err != nil {
        log.Printf("Failed to register a consumer: %v", err)
        return
    }
    
    // Process requests
    go func() {
        for d := range requests {
            // Unmarshal request
            var req Request
            if err := json.Unmarshal(d.Body, &req); err != nil {
                log.Printf("Failed to unmarshal request: %v", err)
                d.Nack(false, false) // Reject message without requeue
                continue
            }
            
            log.Printf("Received request: %s(%f, %f)", req.Operation, req.A, req.B)
            
            // Process the calculation
            result, err := calculate(req)
            
            // Create response
            resp := Response{
                Result: result,
            }
            if err != nil {
                resp.Error = err.Error()
            }
            
            // Marshal response to JSON
            respBytes, err := json.Marshal(resp)
            if err != nil {
                log.Printf("Failed to marshal response: %v", err)
                d.Nack(false, true) // Reject and requeue
                continue
            }
            
            // Context for publishing
            ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
            
            // Publish the response
            err = client.Publish(
                ctx,
                "",        // exchange
                d.ReplyTo, // routing key
                false,     // mandatory
                false,     // immediate
                amqp.Publishing{
                    ContentType:   "application/json",
                    CorrelationId: d.CorrelationId,
                    Body:          respBytes,
                },
            )
            cancel()
            
            if err != nil {
                log.Printf("Failed to publish response: %v", err)
                d.Nack(false, true) // Reject and requeue
                continue
            }
            
            // Acknowledge the message
            d.Ack(false)
            log.Printf("Sent response for request: %s", d.CorrelationId)
        }
    }()
    
    log.Printf("Server is ready to receive calculation requests")
}

// calculate performs the requested calculation
func calculate(req Request) (float64, error) {
    switch req.Operation {
    case "add":
        return req.A + req.B, nil
    case "subtract":
        return req.A - req.B, nil
    case "multiply":
        return req.A * req.B, nil
    case "divide":
        if req.B == 0 {
            return 0, errors.New("division by zero")
        }
        return req.A / req.B, nil
    default:
        return 0, errors.New("unknown operation")
    }
}
```

## Advanced Patterns and Best Practices

### 1. Dead Letter Exchanges (DLX)

Dead Letter Exchanges are used to handle messages that can't be delivered or processed. Here's how to implement a DLX:

```go
// Declare a queue with DLX
queue, err := client.Channel().QueueDeclare(
    "my_queue", // name
    true,      // durable
    false,     // autoDelete
    false,     // exclusive
    false,     // noWait
    amqp.Table{
        "x-dead-letter-exchange":    "dlx",
        "x-dead-letter-routing-key": "failed",
    },
)
```

### 2. Message Acknowledgement Patterns

Different acknowledgement patterns for different reliability needs:

```go
// 1. Auto-ack (least reliable, highest throughput)
msgs, err := client.Consume(
    queue.Name, // queue
    "",        // consumer
    true,      // auto-ack
    false,     // exclusive
)

// 2. Manual ack (reliable, good throughput)
msgs, err := client.Consume(
    queue.Name, // queue
    "",        // consumer
    false,     // no auto-ack
    false,     // exclusive
)
// Process the message and then ack
d.Ack(false) // false means don't ack multiple messages

// 3. Manual ack with retry (most reliable, lower throughput)
msgs, err := client.Consume(
    queue.Name, // queue
    "",        // consumer
    false,     // no auto-ack
    false,     // exclusive
)
// Try to process the message
if err := processMessage(d.Body); err != nil {
    // If it's a temporary error, requeue the message
    if isTemporaryError(err) {
        d.Nack(false, true) // Requeue the message
    } else {
        // If it's a permanent error, don't requeue
        d.Nack(false, false)
    }
} else {
    // Successfully processed, acknowledge
    d.Ack(false)
}
```

### 3. Publisher Confirms

Publisher confirms ensure that messages are safely received by RabbitMQ:

```go
// Enable publisher confirms
if err := ch.Confirm(false); err != nil {
    log.Fatalf("Failed to enable publisher confirms: %v", err)
}

// Set up notification channels
confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 1))
returns := ch.NotifyReturn(make(chan amqp.Return, 1))

// Publish with confirm
err := ch.PublishWithContext(
    ctx,
    exchange,   // exchange
    routingKey, // routing key
    true,       // mandatory (if true, message will be returned if it can't be routed)
    false,      // immediate
    amqp.Publishing{...},
)

// Wait for confirmation
go func() {
    for {
        select {
        case confirm := <-confirms:
            if confirm.Ack {
                log.Printf("Message confirmed with delivery tag: %d", confirm.DeliveryTag)
            } else {
                log.Printf("Message rejected with delivery tag: %d", confirm.DeliveryTag)
            }
        case returned := <-returns:
            log.Printf("Message returned: %s", returned.Body)
        }
    }
}()
```

### 4. Message Durability and Persistence

Ensure messages survive broker restarts:

```go
// Declare a durable queue
queue, err := ch.QueueDeclare(
    "durable_queue", // name
    true,           // durable
    false,          // autoDelete
    false,          // exclusive
    false,          // noWait
    nil,            // arguments
)

// Publish persistent message
err := ch.PublishWithContext(
    ctx,
    exchange,   // exchange
    routingKey, // routing key
    false,      // mandatory
    false,      // immediate
    amqp.Publishing{
        ContentType:  "application/json",
        Body:         []byte(body),
        DeliveryMode: amqp.Persistent, // Make message persistent
    },
)
```

### 5. Circuit Breaker Pattern

Implement a circuit breaker to handle RabbitMQ connection issues:

```go
package rabbitmq

import (
    "errors"
    "sync"
    "time"
)

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
    failureThreshold int
    resetTimeout     time.Duration
    failureCount     int
    lastFailure      time.Time
    state            int
    mu               sync.RWMutex
}

const (
    StateClosed = iota
    StateOpen
    StateHalfOpen
)

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(failureThreshold int, resetTimeout time.Duration) *CircuitBreaker {
    return &CircuitBreaker{
        failureThreshold: failureThreshold,
        resetTimeout:     resetTimeout,
        state:            StateClosed,
    }
}

// Execute runs the function if the circuit is closed or half-open
func (cb *CircuitBreaker) Execute(fn func() error) error {
    cb.mu.RLock()
    if cb.state == StateOpen {
        if time.Since(cb.lastFailure) > cb.resetTimeout {
            cb.mu.RUnlock()
            cb.mu.Lock()
            cb.state = StateHalfOpen
            cb.mu.Unlock()
        } else {
            cb.mu.RUnlock()
            return errors.New("circuit breaker is open")
        }
    } else {
        cb.mu.RUnlock()
    }
    
    err := fn()
    
    cb.mu.Lock()
    defer cb.mu.Unlock()
    
    switch cb.state {
    case StateClosed:
        if err != nil {
            cb.failureCount++
            if cb.failureCount >= cb.failureThreshold {
                cb.state = StateOpen
                cb.lastFailure = time.Now()
            }
        } else {
            cb.failureCount = 0
        }
    case StateHalfOpen:
        if err != nil {
            cb.state = StateOpen
            cb.lastFailure = time.Now()
        } else {
            cb.state = StateClosed
            cb.failureCount = 0
        }
    }
    
    return err
}
```

## Production Considerations

### 1. Connection Pooling

For high-throughput applications, implement a connection pool:

```go
package rabbitmq

import (
    "sync"
    "time"
    
    amqp "github.com/rabbitmq/amqp091-go"
)

// Pool represents a pool of RabbitMQ connections
type Pool struct {
    url        string
    size       int
    clients    []*Client
    current    int
    mu         sync.Mutex
}

// NewPool creates a new connection pool
func NewPool(url string, size int) (*Pool, error) {
    if size <= 0 {
        size = 5 // Default size
    }
    
    pool := &Pool{
        url:     url,
        size:    size,
        clients: make([]*Client, size),
    }
    
    // Initialize all clients
    for i := 0; i < size; i++ {
        client := NewClient(Config{
            URL:           url,
            ReconnectDelay: 5 * time.Second,
        })
        
        if err := client.Connect(); err != nil {
            return nil, err
        }
        
        pool.clients[i] = client
    }
    
    return pool, nil
}

// Get returns a client from the pool
func (p *Pool) Get() *Client {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    client := p.clients[p.current]
    p.current = (p.current + 1) % p.size
    
    return client
}

// Close closes all connections in the pool
func (p *Pool) Close() {
    for _, client := range p.clients {
        client.Close()
    }
}
```

### 2. Monitoring and Health Checks

Implement health checks to monitor RabbitMQ connections:

```go
// Health check handler for your HTTP server
func healthCheckHandler(pool *rabbitmq.Pool) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        client := pool.Get()
        
        if !client.IsConnected() {
            w.WriteHeader(http.StatusServiceUnavailable)
            json.NewEncoder(w).Encode(map[string]string{
                "status": "error",
                "message": "RabbitMQ connection is down",
            })
            return
        }
        
        // Check if we can declare a test queue
        _, err := client.Channel().QueueDeclare(
            "health_check", // name
            false,         // durable
            true,          // autoDelete
            true,          // exclusive
            false,         // noWait
            nil,           // arguments
        )
        
        if err != nil {
            w.WriteHeader(http.StatusServiceUnavailable)
            json.NewEncoder(w).Encode(map[string]string{
                "status": "error",
                "message": "Failed to declare test queue: " + err.Error(),
            })
            return
        }
        
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{
            "status": "ok",
            "message": "RabbitMQ connection is healthy",
        })
    }
}
```

### 3. Graceful Shutdown

Implement graceful shutdown to ensure message processing completes:

```go
func main() {
    // Initialize RabbitMQ client, etc.
    
    // Handle signals for graceful shutdown
    signals := make(chan os.Signal, 1)
    signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
    
    // Start a goroutine to handle shutdown signals
    go func() {
        sig := <-signals
        log.Printf("Received signal %s, shutting down gracefully...", sig)
        
        // Stop accepting new messages
        // This could involve closing a channel that your consumers check
        close(stopConsumingCh)
        
        // Wait for in-flight messages to complete processing
        // This could be implemented with a WaitGroup
        log.Printf("Waiting for in-flight messages to complete...")
        processingWg.Wait()
        
        // Close RabbitMQ connections
        log.Printf("Closing RabbitMQ connections...")
        client.Close()
        
        // Exit the program
        os.Exit(0)
    }()
    
    // Your main application code...
}
```

### 4. Error Handling and Retries

Implement a retry mechanism with exponential backoff:

```go
// retryWithBackoff attempts to execute the given function with exponential backoff
func retryWithBackoff(fn func() error, maxRetries int) error {
    var err error
    
    backoff := 100 * time.Millisecond
    maxBackoff := 30 * time.Second
    
    for i := 0; i < maxRetries; i++ {
        err = fn()
        if err == nil {
            return nil
        }
        
        log.Printf("Attempt %d failed: %v. Retrying in %v...", i+1, err, backoff)
        
        // Wait before retrying
        time.Sleep(backoff)
        
        // Exponential backoff with jitter
        backoff = time.Duration(float64(backoff) * 1.5)
        backoff += time.Duration(rand.Int63n(int64(backoff) / 2))
        
        if backoff > maxBackoff {
            backoff = maxBackoff
        }
    }
    
    return fmt.Errorf("failed after %d attempts: %w", maxRetries, err)
}
```

## Conclusion

Message-driven architecture leveraging RabbitMQ and Go provides a powerful foundation for building scalable, resilient, and loosely coupled microservices. By understanding the various messaging patterns and implementing best practices, you can create robust applications that can handle high throughput while remaining maintainable.

The Go programming language's concurrency model, with goroutines and channels, makes it particularly well-suited for handling asynchronous message processing, while RabbitMQ's reliability and feature set provide a solid messaging infrastructure.

Whether you're building a simple work queue or a complex event-driven system, the patterns and practices outlined in this guide will help you implement effective message-driven microservices that can scale to meet your application's needs.

Remember these key principles:

1. Use the right messaging pattern for your specific use case
2. Implement proper error handling and reliability measures
3. Design for failure by leveraging RabbitMQ's features like dead letter exchanges
4. Monitor and maintain your messaging infrastructure
5. Plan for graceful degradation and recovery

With these fundamentals in place, you'll be well-equipped to build resilient message-driven microservices in Go.