---
title: "Building a Lightweight Kafka Clone in Go: Architecture, Implementation, and Lessons"
date: 2025-10-16T09:00:00-05:00
draft: false
tags: ["Go", "Kafka", "Message Broker", "Distributed Systems", "Event Streaming"]
categories: ["Distributed Systems", "Go Programming"]
---

Message brokers form the backbone of modern distributed systems, enabling loose coupling, asynchronous communication, and data streaming between services. Apache Kafka has emerged as the industry standard for high-throughput, fault-tolerant event streaming — but its deployment complexity can be overkill for many use cases. As an exercise in both learning and practical engineering, I built a lightweight Kafka-inspired message broker in Go, focusing on the core concepts while simplifying the operational model.

This article details the architecture, implementation decisions, performance characteristics, and lessons learned from this project. Whether you're interested in understanding Kafka's internals, learning distributed systems concepts, or need a simpler message broker for your applications, this deep dive will provide valuable insights into building resilient data systems.

## Table of Contents

1. [Core Concepts and Architecture](#core-concepts-and-architecture)
2. [Implementation Details](#implementation-details)
   - [Topic and Partition Management](#topic-and-partition-management)
   - [Message Format and Storage](#message-format-and-storage)
   - [Producer Implementation](#producer-implementation)
   - [Consumer Implementation](#consumer-implementation)
   - [Broker Coordination](#broker-coordination)
3. [Performance Optimizations](#performance-optimizations)
   - [Disk I/O Strategies](#disk-io-strategies)
   - [Lock Contention Management](#lock-contention-management)
   - [Memory Management](#memory-management)
4. [Handling Failures](#handling-failures)
   - [Crash Recovery](#crash-recovery)
   - [Data Integrity](#data-integrity)
   - [Producer Acknowledgments](#producer-acknowledgments)
5. [Advanced Features](#advanced-features)
   - [Log Segmentation](#log-segmentation)
   - [Message Compression](#message-compression)
   - [Consumer Groups](#consumer-groups)
   - [Basic Replication](#basic-replication)
6. [Lessons Learned](#lessons-learned)
7. [Comparison with Kafka](#comparison-with-kafka)
8. [When to Use This vs. Full Kafka](#when-to-use-this-vs-full-kafka)
9. [Conclusion](#conclusion)

## Core Concepts and Architecture

The architecture of our lightweight message broker mirrors the fundamental components of Kafka but with significant simplifications:

### Key Components

1. **Topics**: Named channels to which messages are published
2. **Partitions**: Ordered, immutable sequences of messages within a topic
3. **Producers**: Clients that publish messages to topics
4. **Consumers**: Clients that subscribe to topics and process messages
5. **Broker**: The service that manages topics, partitions, and facilitates message flow

### Architectural Choices

The system is designed as a single-node broker to eliminate the complexity of distributed consensus:

```
┌───────────────────────────────────────────────────┐
│                     Broker                        │
│                                                   │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────┐  │
│  │   Topic A   │   │   Topic B   │   │ Topic C │  │
│  │ ┌─────────┐ │   │ ┌─────────┐ │   │ ┌─────┐ │  │
│  │ │Partition│ │   │ │Partition│ │   │ │Part.│ │  │
│  │ │    0    │ │   │ │    0    │ │   │ │  0  │ │  │
│  │ └─────────┘ │   │ └─────────┘ │   │ └─────┘ │  │
│  │ ┌─────────┐ │   │ ┌─────────┐ │   │         │  │
│  │ │Partition│ │   │ │Partition│ │   │         │  │
│  │ │    1    │ │   │ │    1    │ │   │         │  │
│  │ └─────────┘ │   │ └─────────┘ │   │         │  │
│  └─────────────┘   └─────────────┘   └─────────┘  │
│                                                   │
└───────────────────────────────────────────────────┘
         ▲                     ▲
         │                     │
┌────────┴───────┐    ┌────────┴───────┐
│    Producer    │    │    Consumer    │
└────────────────┘    └────────────────┘
```

### Design Principles

1. **Simplicity**: Focus on the core messaging functionality without unnecessary complexity
2. **Durability**: All messages are persisted to disk before acknowledgment
3. **Performance**: Optimize for high throughput and low latency
4. **Reliability**: Handle failures gracefully and ensure data integrity
5. **Resource Efficiency**: Minimize memory usage and system resource requirements

## Implementation Details

Let's explore the implementation details of each component.

### Topic and Partition Management

A topic is represented as a directory on disk, with each partition as a separate file within that directory:

```go
// TopicManager handles topic and partition creation and access
type TopicManager struct {
    baseDir string
    topics  map[string]*Topic
    mu      sync.RWMutex
}

// Topic represents a named channel for messages
type Topic struct {
    name       string
    partitions []*Partition
    mu         sync.RWMutex
}

// Partition represents an ordered, immutable sequence of messages
type Partition struct {
    topic     *Topic
    id        int
    file      *os.File
    mu        sync.Mutex
    offset    int64
    lastSync  time.Time
    syncEvery time.Duration
}

// CreateTopic creates a new topic with the specified number of partitions
func (tm *TopicManager) CreateTopic(name string, numPartitions int) (*Topic, error) {
    tm.mu.Lock()
    defer tm.mu.Unlock()
    
    // Check if topic already exists
    if _, exists := tm.topics[name]; exists {
        return nil, fmt.Errorf("topic %s already exists", name)
    }
    
    // Create topic directory
    topicDir := filepath.Join(tm.baseDir, name)
    if err := os.MkdirAll(topicDir, 0755); err != nil {
        return nil, fmt.Errorf("failed to create topic directory: %w", err)
    }
    
    // Create topic and its partitions
    topic := &Topic{
        name:       name,
        partitions: make([]*Partition, numPartitions),
    }
    
    for i := 0; i < numPartitions; i++ {
        partition, err := createPartition(topic, i, topicDir)
        if err != nil {
            return nil, fmt.Errorf("failed to create partition %d: %w", i, err)
        }
        topic.partitions[i] = partition
    }
    
    tm.topics[name] = topic
    return topic, nil
}

// createPartition creates a new partition file
func createPartition(topic *Topic, id int, topicDir string) (*Partition, error) {
    // Create or open partition file
    filePath := filepath.Join(topicDir, fmt.Sprintf("partition-%d.log", id))
    file, err := os.OpenFile(filePath, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0644)
    if err != nil {
        return nil, fmt.Errorf("failed to open partition file: %w", err)
    }
    
    // Get current file size as initial offset
    info, err := file.Stat()
    if err != nil {
        file.Close()
        return nil, fmt.Errorf("failed to stat partition file: %w", err)
    }
    
    partition := &Partition{
        topic:     topic,
        id:        id,
        file:      file,
        offset:    info.Size(),
        syncEvery: 50 * time.Millisecond,
    }
    
    // Start background sync goroutine
    go partition.syncLoop()
    
    return partition, nil
}

// syncLoop periodically syncs partition data to disk
func (p *Partition) syncLoop() {
    ticker := time.NewTicker(p.syncEvery)
    defer ticker.Stop()
    
    for range ticker.C {
        p.mu.Lock()
        if time.Since(p.lastSync) >= p.syncEvery {
            p.file.Sync()
            p.lastSync = time.Now()
        }
        p.mu.Unlock()
    }
}
```

### Message Format and Storage

Messages are stored on disk using a simple binary format:

```
┌────────┬────────┬─────────────────┐
│ Length │ Header │ Message Payload │
│ (8B)   │ (var)  │      (var)      │
└────────┴────────┴─────────────────┘
```

The implementation:

```go
// Message represents a single message in the system
type Message struct {
    Key       []byte
    Value     []byte
    Timestamp time.Time
}

// MessageHeader contains metadata about a message
type MessageHeader struct {
    KeySize    uint32
    Timestamp  int64
}

// writeMessage writes a message to the partition file
func (p *Partition) writeMessage(msg *Message) (int64, error) {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    // Record the current offset before writing
    currentOffset := p.offset
    
    // Calculate header size and total size
    header := MessageHeader{
        KeySize:    uint32(len(msg.Key)),
        Timestamp:  msg.Timestamp.UnixNano(),
    }
    
    // Serialize header
    headerBytes := make([]byte, 12) // 4 + 8 bytes
    binary.BigEndian.PutUint32(headerBytes[0:4], header.KeySize)
    binary.BigEndian.PutUint64(headerBytes[4:12], uint64(header.Timestamp))
    
    // Calculate total message size
    totalSize := uint64(len(headerBytes) + len(msg.Key) + len(msg.Value))
    
    // Write length prefix
    sizeBytes := make([]byte, 8)
    binary.BigEndian.PutUint64(sizeBytes, totalSize)
    if _, err := p.file.Write(sizeBytes); err != nil {
        return -1, fmt.Errorf("failed to write message size: %w", err)
    }
    
    // Write header
    if _, err := p.file.Write(headerBytes); err != nil {
        return -1, fmt.Errorf("failed to write message header: %w", err)
    }
    
    // Write key (if present)
    if len(msg.Key) > 0 {
        if _, err := p.file.Write(msg.Key); err != nil {
            return -1, fmt.Errorf("failed to write message key: %w", err)
        }
    }
    
    // Write value
    if _, err := p.file.Write(msg.Value); err != nil {
        return -1, fmt.Errorf("failed to write message value: %w", err)
    }
    
    // Update partition offset
    p.offset += int64(8 + totalSize)
    
    // Schedule sync if needed
    if time.Since(p.lastSync) >= p.syncEvery {
        p.file.Sync()
        p.lastSync = time.Now()
    }
    
    return currentOffset, nil
}

// readMessage reads a message from the partition file at the specified offset
func (p *Partition) readMessage(offset int64) (*Message, int64, error) {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    // Seek to the offset
    if _, err := p.file.Seek(offset, io.SeekStart); err != nil {
        return nil, offset, fmt.Errorf("failed to seek to offset: %w", err)
    }
    
    // Read message size
    sizeBytes := make([]byte, 8)
    if _, err := io.ReadFull(p.file, sizeBytes); err != nil {
        return nil, offset, fmt.Errorf("failed to read message size: %w", err)
    }
    totalSize := binary.BigEndian.Uint64(sizeBytes)
    
    // Read the full message
    msgBytes := make([]byte, totalSize)
    if _, err := io.ReadFull(p.file, msgBytes); err != nil {
        return nil, offset, fmt.Errorf("failed to read message: %w", err)
    }
    
    // Parse header
    keySize := binary.BigEndian.Uint32(msgBytes[0:4])
    timestamp := binary.BigEndian.Uint64(msgBytes[4:12])
    
    // Extract key and value
    headerSize := 12
    var key []byte
    if keySize > 0 {
        key = msgBytes[headerSize : headerSize+int(keySize)]
    }
    value := msgBytes[headerSize+int(keySize):]
    
    // Create message
    msg := &Message{
        Key:       key,
        Value:     value,
        Timestamp: time.Unix(0, int64(timestamp)),
    }
    
    // Calculate next offset
    nextOffset := offset + int64(8) + int64(totalSize)
    
    return msg, nextOffset, nil
}
```

### Producer Implementation

The producer provides an API for publishing messages to topics:

```go
// Producer publishes messages to topics
type Producer struct {
    broker      *Broker
    acks        int // 0=no ack, 1=leader ack
    partitioner PartitionStrategy
}

// PartitionStrategy determines which partition a message is sent to
type PartitionStrategy func(key []byte, numPartitions int) int

// DefaultPartitioner implements a simple hash-based partitioning strategy
func DefaultPartitioner(key []byte, numPartitions int) int {
    if len(key) == 0 {
        return rand.Intn(numPartitions)
    }
    
    // Simple hash function
    h := fnv.New32a()
    h.Write(key)
    return int(h.Sum32()) % numPartitions
}

// NewProducer creates a new producer
func NewProducer(broker *Broker, acks int) *Producer {
    return &Producer{
        broker:      broker,
        acks:        acks,
        partitioner: DefaultPartitioner,
    }
}

// Produce sends a message to the specified topic
func (p *Producer) Produce(topicName string, msg *Message) (int, int64, error) {
    // Set message timestamp if not set
    if msg.Timestamp.IsZero() {
        msg.Timestamp = time.Now()
    }
    
    // Get topic
    topic, err := p.broker.GetTopic(topicName)
    if err != nil {
        return -1, -1, fmt.Errorf("failed to get topic: %w", err)
    }
    
    // Determine partition
    numPartitions := len(topic.partitions)
    partitionID := p.partitioner(msg.Key, numPartitions)
    
    // Get partition
    partition := topic.partitions[partitionID]
    
    // Write message to partition
    offset, err := partition.writeMessage(msg)
    if err != nil {
        return -1, -1, fmt.Errorf("failed to write message: %w", err)
    }
    
    // Force sync to disk if acks=1
    if p.acks > 0 {
        partition.mu.Lock()
        partition.file.Sync()
        partition.lastSync = time.Now()
        partition.mu.Unlock()
    }
    
    return partitionID, offset, nil
}
```

### Consumer Implementation

The consumer provides an API for subscribing to topics and consuming messages:

```go
// Consumer reads messages from topics
type Consumer struct {
    broker     *Broker
    groupID    string
    offsets    map[string]map[int]int64 // topic -> partition -> offset
    mu         sync.Mutex
    autoCommit bool
}

// NewConsumer creates a new consumer
func NewConsumer(broker *Broker, groupID string) *Consumer {
    return &Consumer{
        broker:     broker,
        groupID:    groupID,
        offsets:    make(map[string]map[int]int64),
        autoCommit: true,
    }
}

// Subscribe subscribes to a topic
func (c *Consumer) Subscribe(topicName string) error {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    // Get topic
    topic, err := c.broker.GetTopic(topicName)
    if err != nil {
        return fmt.Errorf("failed to get topic: %w", err)
    }
    
    // Initialize offsets for this topic
    if _, exists := c.offsets[topicName]; !exists {
        c.offsets[topicName] = make(map[int]int64)
    }
    
    // Initialize offsets for each partition
    for _, partition := range topic.partitions {
        // If we already have an offset for this partition, use it
        if _, exists := c.offsets[topicName][partition.id]; exists {
            continue
        }
        
        // Otherwise, load from offset store or start from beginning
        offset, err := c.loadOffset(topicName, partition.id)
        if err != nil {
            // If no stored offset, start from beginning
            c.offsets[topicName][partition.id] = 0
        } else {
            c.offsets[topicName][partition.id] = offset
        }
    }
    
    return nil
}

// Poll consumes messages from the subscribed topics
func (c *Consumer) Poll(timeoutMs int) ([]*ConsumerRecord, error) {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    var records []*ConsumerRecord
    
    // Try to consume from each topic and partition
    for topicName, partitionOffsets := range c.offsets {
        topic, err := c.broker.GetTopic(topicName)
        if err != nil {
            return nil, fmt.Errorf("failed to get topic: %w", err)
        }
        
        for partitionID, offset := range partitionOffsets {
            partition := topic.partitions[partitionID]
            
            // Check if we've reached the end of the partition
            if offset >= partition.offset {
                continue
            }
            
            // Read message
            msg, nextOffset, err := partition.readMessage(offset)
            if err != nil {
                // Skip corrupted messages
                if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
                    // Update offset to skip this message
                    c.offsets[topicName][partitionID] = partition.offset
                    continue
                }
                return nil, fmt.Errorf("failed to read message: %w", err)
            }
            
            // Create consumer record
            record := &ConsumerRecord{
                Topic:     topicName,
                Partition: partitionID,
                Offset:    offset,
                Key:       msg.Key,
                Value:     msg.Value,
                Timestamp: msg.Timestamp,
            }
            
            records = append(records, record)
            
            // Update offset
            c.offsets[topicName][partitionID] = nextOffset
            
            // Auto-commit offset if enabled
            if c.autoCommit {
                c.commitOffset(topicName, partitionID, nextOffset)
            }
            
            // Only read one message per partition per poll to be fair
            break
        }
    }
    
    return records, nil
}

// CommitOffsets commits the current offsets to storage
func (c *Consumer) CommitOffsets() error {
    c.mu.Lock()
    defer c.mu.Unlock()
    
    for topicName, partitionOffsets := range c.offsets {
        for partitionID, offset := range partitionOffsets {
            if err := c.commitOffset(topicName, partitionID, offset); err != nil {
                return err
            }
        }
    }
    
    return nil
}

// commitOffset commits a single offset to storage
func (c *Consumer) commitOffset(topic string, partition int, offset int64) error {
    // In a real implementation, this would persist the offset
    // to a file or database. For simplicity, we're just logging it.
    log.Printf("Committed offset %d for topic %s, partition %d", 
        offset, topic, partition)
    return nil
}

// loadOffset loads a committed offset from storage
func (c *Consumer) loadOffset(topic string, partition int) (int64, error) {
    // In a real implementation, this would load the offset from
    // a file or database. For simplicity, we're returning an error.
    return 0, fmt.Errorf("no stored offset")
}

// ConsumerRecord represents a consumed message with metadata
type ConsumerRecord struct {
    Topic     string
    Partition int
    Offset    int64
    Key       []byte
    Value     []byte
    Timestamp time.Time
}
```

### Broker Coordination

The broker ties everything together:

```go
// Broker coordinates the message flow between producers and consumers
type Broker struct {
    topicManager *TopicManager
    mu           sync.RWMutex
}

// NewBroker creates a new broker
func NewBroker(dataDir string) (*Broker, error) {
    // Create data directory if it doesn't exist
    if err := os.MkdirAll(dataDir, 0755); err != nil {
        return nil, fmt.Errorf("failed to create data directory: %w", err)
    }
    
    // Create topic manager
    topicManager := &TopicManager{
        baseDir: dataDir,
        topics:  make(map[string]*Topic),
    }
    
    // Create broker
    broker := &Broker{
        topicManager: topicManager,
    }
    
    // Load existing topics
    if err := broker.loadTopics(); err != nil {
        return nil, fmt.Errorf("failed to load topics: %w", err)
    }
    
    return broker, nil
}

// loadTopics loads existing topics from disk
func (b *Broker) loadTopics() error {
    // Read topic directories
    entries, err := os.ReadDir(b.topicManager.baseDir)
    if err != nil {
        return fmt.Errorf("failed to read data directory: %w", err)
    }
    
    // Process each topic directory
    for _, entry := range entries {
        if !entry.IsDir() {
            continue
        }
        
        topicName := entry.Name()
        topicDir := filepath.Join(b.topicManager.baseDir, topicName)
        
        // Find partition files
        partitionFiles, err := filepath.Glob(filepath.Join(topicDir, "partition-*.log"))
        if err != nil {
            return fmt.Errorf("failed to glob partition files: %w", err)
        }
        
        // Create topic with the correct number of partitions
        numPartitions := len(partitionFiles)
        if numPartitions > 0 {
            _, err := b.topicManager.CreateTopic(topicName, numPartitions)
            if err != nil {
                return fmt.Errorf("failed to load topic %s: %w", topicName, err)
            }
        }
    }
    
    return nil
}

// CreateTopic creates a new topic
func (b *Broker) CreateTopic(name string, numPartitions int) error {
    _, err := b.topicManager.CreateTopic(name, numPartitions)
    return err
}

// GetTopic gets a topic by name
func (b *Broker) GetTopic(name string) (*Topic, error) {
    b.mu.RLock()
    defer b.mu.RUnlock()
    
    topic, exists := b.topicManager.topics[name]
    if !exists {
        return nil, fmt.Errorf("topic %s does not exist", name)
    }
    
    return topic, nil
}

// ListTopics lists all topics
func (b *Broker) ListTopics() []string {
    b.mu.RLock()
    defer b.mu.RUnlock()
    
    topics := make([]string, 0, len(b.topicManager.topics))
    for topicName := range b.topicManager.topics {
        topics = append(topics, topicName)
    }
    
    return topics
}
```

## Performance Optimizations

To achieve high throughput, several performance optimizations were implemented.

### Disk I/O Strategies

One of the most critical performance aspects is managing disk writes efficiently:

```go
// Batch writes to improve throughput
type BatchWriter struct {
    partition   *Partition
    buffer      bytes.Buffer
    maxSize     int
    maxMessages int
    count       int
}

// Add a message to the batch
func (bw *BatchWriter) Add(msg *Message) error {
    // Serialize message
    msgBytes, err := serializeMessage(msg)
    if err != nil {
        return err
    }
    
    // Check if we would exceed batch size
    if bw.buffer.Len()+len(msgBytes) > bw.maxSize || bw.count >= bw.maxMessages {
        if err := bw.Flush(); err != nil {
            return err
        }
    }
    
    // Add to buffer
    bw.buffer.Write(msgBytes)
    bw.count++
    
    return nil
}

// Flush writes the batch to disk
func (bw *BatchWriter) Flush() error {
    if bw.buffer.Len() == 0 {
        return nil
    }
    
    // Acquire lock
    bw.partition.mu.Lock()
    defer bw.partition.mu.Unlock()
    
    // Write buffer to file
    if _, err := bw.partition.file.Write(bw.buffer.Bytes()); err != nil {
        return err
    }
    
    // Update offset
    bw.partition.offset += int64(bw.buffer.Len())
    
    // Reset buffer
    bw.buffer.Reset()
    bw.count = 0
    
    return nil
}
```

### Lock Contention Management

To reduce lock contention, the system uses fine-grained locking and lock-free operations where possible:

```go
// PartitionWriter manages writes to a partition with reduced lock contention
type PartitionWriter struct {
    partition *Partition
    writeCh   chan writeRequest
    done      chan struct{}
}

type writeRequest struct {
    msg      *Message
    resultCh chan writeResult
}

type writeResult struct {
    offset int64
    err    error
}

// NewPartitionWriter creates a new partition writer
func NewPartitionWriter(partition *Partition) *PartitionWriter {
    pw := &PartitionWriter{
        partition: partition,
        writeCh:   make(chan writeRequest, 1000),
        done:      make(chan struct{}),
    }
    
    // Start writer goroutine
    go pw.writeLoop()
    
    return pw
}

// Write sends a message to be written asynchronously
func (pw *PartitionWriter) Write(msg *Message) (int64, error) {
    resultCh := make(chan writeResult, 1)
    
    // Send write request
    pw.writeCh <- writeRequest{
        msg:      msg,
        resultCh: resultCh,
    }
    
    // Wait for result
    result := <-resultCh
    return result.offset, result.err
}

// writeLoop processes write requests in a dedicated goroutine
func (pw *PartitionWriter) writeLoop() {
    // Create a batch writer for efficiency
    bw := &BatchWriter{
        partition:   pw.partition,
        maxSize:     1024 * 1024, // 1MB
        maxMessages: 1000,
    }
    
    // Use a ticker to flush periodically
    ticker := time.NewTicker(10 * time.Millisecond)
    defer ticker.Stop()
    
    for {
        select {
        case req := <-pw.writeCh:
            // Serialize message
            msgBytes, err := serializeMessage(req.msg)
            if err != nil {
                req.resultCh <- writeResult{-1, err}
                continue
            }
            
            // Record current offset
            offset := pw.partition.offset
            
            // Add to batch
            if err := bw.Add(req.msg); err != nil {
                req.resultCh <- writeResult{-1, err}
                continue
            }
            
            // Send result
            req.resultCh <- writeResult{offset, nil}
            
        case <-ticker.C:
            // Flush batch periodically
            bw.Flush()
            
        case <-pw.done:
            // Flush before exiting
            bw.Flush()
            return
        }
    }
}

// Close stops the writer
func (pw *PartitionWriter) Close() error {
    close(pw.done)
    return nil
}
```

### Memory Management

Careful memory management is crucial for high-throughput systems:

```go
// MessagePool provides a pool of message objects to reduce allocations
var messagePool = sync.Pool{
    New: func() interface{} {
        return &Message{}
    },
}

// GetMessage gets a message from the pool
func GetMessage() *Message {
    return messagePool.Get().(*Message)
}

// PutMessage returns a message to the pool
func PutMessage(msg *Message) {
    // Clear message fields
    msg.Key = nil
    msg.Value = nil
    msg.Timestamp = time.Time{}
    
    // Return to pool
    messagePool.Put(msg)
}

// BufferPool provides a pool of byte buffers
var bufferPool = sync.Pool{
    New: func() interface{} {
        return bytes.NewBuffer(make([]byte, 0, 4096))
    },
}

// GetBuffer gets a buffer from the pool
func GetBuffer() *bytes.Buffer {
    return bufferPool.Get().(*bytes.Buffer)
}

// PutBuffer returns a buffer to the pool
func PutBuffer(buf *bytes.Buffer) {
    buf.Reset()
    bufferPool.Put(buf)
}
```

## Handling Failures

Robust failure handling is essential for message brokers.

### Crash Recovery

When the broker starts, it needs to recover the state of all partitions:

```go
// RecoverPartition recovers a partition after a crash
func RecoverPartition(topicDir string, partitionID int) (*Partition, error) {
    filePath := filepath.Join(topicDir, fmt.Sprintf("partition-%d.log", partitionID))
    
    // Open the file
    file, err := os.OpenFile(filePath, os.O_RDWR, 0644)
    if err != nil {
        return nil, fmt.Errorf("failed to open partition file: %w", err)
    }
    
    // Scan the file to find the valid end
    var offset int64 = 0
    reader := bufio.NewReader(file)
    
    for {
        // Remember current position
        currentOffset := offset
        
        // Read message size
        sizeBytes := make([]byte, 8)
        _, err := io.ReadFull(reader, sizeBytes)
        if err != nil {
            if err == io.EOF {
                // Reached end of file, file is valid
                break
            }
            if err == io.ErrUnexpectedEOF {
                // Partial write detected, truncate file here
                log.Printf("Partial write detected at offset %d, truncating", currentOffset)
                file.Truncate(currentOffset)
                offset = currentOffset
                break
            }
            return nil, fmt.Errorf("failed to read message size: %w", err)
        }
        
        // Parse message size
        messageSize := binary.BigEndian.Uint64(sizeBytes)
        
        // Skip message content
        if _, err := io.CopyN(io.Discard, reader, int64(messageSize)); err != nil {
            if err == io.EOF || err == io.ErrUnexpectedEOF {
                // Partial write detected, truncate file here
                log.Printf("Partial message detected at offset %d, truncating", currentOffset)
                file.Truncate(currentOffset)
                offset = currentOffset
                break
            }
            return nil, fmt.Errorf("failed to skip message: %w", err)
        }
        
        // Update offset
        offset = currentOffset + 8 + int64(messageSize)
    }
    
    // Seek to the end
    if _, err := file.Seek(offset, io.SeekStart); err != nil {
        return nil, fmt.Errorf("failed to seek to end: %w", err)
    }
    
    // Create partition
    partition := &Partition{
        id:        partitionID,
        file:      file,
        offset:    offset,
        syncEvery: 50 * time.Millisecond,
    }
    
    // Start background sync goroutine
    go partition.syncLoop()
    
    return partition, nil
}
```

### Data Integrity

To ensure data integrity, we use checksums and careful file handling:

```go
// Message format with checksum
// ┌────────┬────────┬─────────┬─────────────────┬──────────┐
// │ Length │ Header │ Checksum│ Message Payload │ Checksum │
// │ (8B)   │ (var)  │  (4B)   │      (var)      │   (4B)   │
// └────────┴────────┴─────────┴─────────────────┴──────────┘

// writeMessageWithIntegrity writes a message with checksums
func (p *Partition) writeMessageWithIntegrity(msg *Message) (int64, error) {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    // Record current offset
    currentOffset := p.offset
    
    // Serialize message header and payload
    headerBytes, payloadBytes, err := serializeMessageParts(msg)
    if err != nil {
        return -1, err
    }
    
    // Calculate checksums
    headerChecksum := crc32.ChecksumIEEE(headerBytes)
    payloadChecksum := crc32.ChecksumIEEE(payloadBytes)
    
    // Calculate total message size
    totalSize := uint64(len(headerBytes) + 4 + len(payloadBytes) + 4) // header + header checksum + payload + payload checksum
    
    // Write length prefix
    sizeBytes := make([]byte, 8)
    binary.BigEndian.PutUint64(sizeBytes, totalSize)
    if _, err := p.file.Write(sizeBytes); err != nil {
        return -1, fmt.Errorf("failed to write message size: %w", err)
    }
    
    // Write header
    if _, err := p.file.Write(headerBytes); err != nil {
        return -1, fmt.Errorf("failed to write message header: %w", err)
    }
    
    // Write header checksum
    checksumBytes := make([]byte, 4)
    binary.BigEndian.PutUint32(checksumBytes, headerChecksum)
    if _, err := p.file.Write(checksumBytes); err != nil {
        return -1, fmt.Errorf("failed to write header checksum: %w", err)
    }
    
    // Write payload
    if _, err := p.file.Write(payloadBytes); err != nil {
        return -1, fmt.Errorf("failed to write message payload: %w", err)
    }
    
    // Write payload checksum
    binary.BigEndian.PutUint32(checksumBytes, payloadChecksum)
    if _, err := p.file.Write(checksumBytes); err != nil {
        return -1, fmt.Errorf("failed to write payload checksum: %w", err)
    }
    
    // Update partition offset
    p.offset += int64(8 + totalSize)
    
    // Schedule sync if needed
    if time.Since(p.lastSync) >= p.syncEvery {
        p.file.Sync()
        p.lastSync = time.Now()
    }
    
    return currentOffset, nil
}

// readMessageWithIntegrity reads a message with integrity checking
func (p *Partition) readMessageWithIntegrity(offset int64) (*Message, int64, error) {
    p.mu.Lock()
    defer p.mu.Unlock()
    
    // Seek to the offset
    if _, err := p.file.Seek(offset, io.SeekStart); err != nil {
        return nil, offset, fmt.Errorf("failed to seek to offset: %w", err)
    }
    
    // Read message size
    sizeBytes := make([]byte, 8)
    if _, err := io.ReadFull(p.file, sizeBytes); err != nil {
        return nil, offset, fmt.Errorf("failed to read message size: %w", err)
    }
    totalSize := binary.BigEndian.Uint64(sizeBytes)
    
    // Read the full message
    msgBytes := make([]byte, totalSize)
    if _, err := io.ReadFull(p.file, msgBytes); err != nil {
        return nil, offset, fmt.Errorf("failed to read message: %w", err)
    }
    
    // Extract header length (first 4 bytes of message)
    headerLength := binary.BigEndian.Uint32(msgBytes[0:4])
    
    // Extract parts
    headerBytes := msgBytes[0:headerLength]
    headerChecksumBytes := msgBytes[headerLength:headerLength+4]
    payloadBytes := msgBytes[headerLength+4:len(msgBytes)-4]
    payloadChecksumBytes := msgBytes[len(msgBytes)-4:]
    
    // Verify checksums
    headerChecksum := binary.BigEndian.Uint32(headerChecksumBytes)
    if calculatedHeaderChecksum := crc32.ChecksumIEEE(headerBytes); calculatedHeaderChecksum != headerChecksum {
        return nil, offset, fmt.Errorf("header checksum mismatch")
    }
    
    payloadChecksum := binary.BigEndian.Uint32(payloadChecksumBytes)
    if calculatedPayloadChecksum := crc32.ChecksumIEEE(payloadBytes); calculatedPayloadChecksum != payloadChecksum {
        return nil, offset, fmt.Errorf("payload checksum mismatch")
    }
    
    // Parse message
    msg, err := deserializeMessage(headerBytes, payloadBytes)
    if err != nil {
        return nil, offset, fmt.Errorf("failed to deserialize message: %w", err)
    }
    
    // Calculate next offset
    nextOffset := offset + int64(8) + int64(totalSize)
    
    return msg, nextOffset, nil
}
```

### Producer Acknowledgments

Different acknowledgment levels provide trade-offs between performance and durability:

```go
// AckMode defines the producer acknowledgment levels
type AckMode int

const (
    // AckNone means no acknowledgment is required
    AckNone AckMode = 0
    
    // AckLeader means the leader must acknowledge
    AckLeader AckMode = 1
    
    // AckAll means all replicas must acknowledge (not implemented in this version)
    AckAll AckMode = -1
)

// ProduceOptions defines options for producing messages
type ProduceOptions struct {
    AckMode AckMode
    Timeout time.Duration
}

// ProduceResult represents the result of a produce operation
type ProduceResult struct {
    Topic     string
    Partition int
    Offset    int64
    Error     error
}

// ProduceAsync sends a message asynchronously
func (p *Producer) ProduceAsync(topicName string, msg *Message, options ProduceOptions) <-chan ProduceResult {
    resultCh := make(chan ProduceResult, 1)
    
    go func() {
        // Apply timeout
        ctx, cancel := context.WithTimeout(context.Background(), options.Timeout)
        defer cancel()
        
        // Get topic
        topic, err := p.broker.GetTopic(topicName)
        if err != nil {
            resultCh <- ProduceResult{
                Topic: topicName,
                Error: fmt.Errorf("failed to get topic: %w", err),
            }
            return
        }
        
        // Determine partition
        numPartitions := len(topic.partitions)
        partitionID := p.partitioner(msg.Key, numPartitions)
        
        // Get partition
        partition := topic.partitions[partitionID]
        
        // Write message to partition
        offset, err := partition.writeMessage(msg)
        if err != nil {
            resultCh <- ProduceResult{
                Topic:     topicName,
                Partition: partitionID,
                Error:     fmt.Errorf("failed to write message: %w", err),
            }
            return
        }
        
        // Handle acknowledgment
        switch options.AckMode {
        case AckLeader:
            // Sync to disk
            partition.mu.Lock()
            partition.file.Sync()
            partition.lastSync = time.Now()
            partition.mu.Unlock()
        case AckNone:
            // No sync required
        }
        
        // Send result
        resultCh <- ProduceResult{
            Topic:     topicName,
            Partition: partitionID,
            Offset:    offset,
            Error:     nil,
        }
    }()
    
    return resultCh
}
```

## Advanced Features

Beyond the basic implementation, several advanced features can enhance functionality.

### Log Segmentation

To manage disk space and allow log retention policies, we implement log segmentation:

```go
// LogSegment represents a segment of a partition log
type LogSegment struct {
    file       *os.File
    baseOffset int64
    maxSize    int64
    startTime  time.Time
}

// SegmentedPartition manages multiple log segments
type SegmentedPartition struct {
    topic          *Topic
    id             int
    dir            string
    activeSegment  *LogSegment
    segments       []*LogSegment
    mu             sync.Mutex
    maxSegmentSize int64
    retention      time.Duration
}

// NewSegmentedPartition creates a new segmented partition
func NewSegmentedPartition(topic *Topic, id int, dir string) (*SegmentedPartition, error) {
    sp := &SegmentedPartition{
        topic:          topic,
        id:             id,
        dir:            dir,
        maxSegmentSize: 1024 * 1024 * 1024, // 1GB
        retention:      7 * 24 * time.Hour, // 7 days
    }
    
    // Create partition directory
    partitionDir := filepath.Join(dir, fmt.Sprintf("partition-%d", id))
    if err := os.MkdirAll(partitionDir, 0755); err != nil {
        return nil, fmt.Errorf("failed to create partition directory: %w", err)
    }
    
    // Load existing segments
    if err := sp.loadSegments(); err != nil {
        return nil, fmt.Errorf("failed to load segments: %w", err)
    }
    
    // Create active segment if none exists
    if len(sp.segments) == 0 {
        if err := sp.createNewSegment(0); err != nil {
            return nil, fmt.Errorf("failed to create initial segment: %w", err)
        }
    } else {
        // Set the last segment as active
        sp.activeSegment = sp.segments[len(sp.segments)-1]
    }
    
    // Start segment cleaner
    go sp.segmentCleanerLoop()
    
    return sp, nil
}

// createNewSegment creates a new log segment
func (sp *SegmentedPartition) createNewSegment(baseOffset int64) error {
    // Create segment file
    fileName := fmt.Sprintf("%020d.log", baseOffset)
    filePath := filepath.Join(sp.dir, fileName)
    
    file, err := os.OpenFile(filePath, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0644)
    if err != nil {
        return fmt.Errorf("failed to create segment file: %w", err)
    }
    
    // Create segment
    segment := &LogSegment{
        file:       file,
        baseOffset: baseOffset,
        startTime:  time.Now(),
    }
    
    // Add to segments list
    sp.segments = append(sp.segments, segment)
    sp.activeSegment = segment
    
    return nil
}

// loadSegments loads existing log segments
func (sp *SegmentedPartition) loadSegments() error {
    // Find segment files
    pattern := filepath.Join(sp.dir, "*.log")
    matches, err := filepath.Glob(pattern)
    if err != nil {
        return fmt.Errorf("failed to glob segment files: %w", err)
    }
    
    // Sort segment files by base offset
    sort.Strings(matches)
    
    // Load each segment
    for _, match := range matches {
        // Extract base offset from filename
        baseName := filepath.Base(match)
        baseOffsetStr := strings.TrimSuffix(baseName, ".log")
        baseOffset, err := strconv.ParseInt(baseOffsetStr, 10, 64)
        if err != nil {
            return fmt.Errorf("invalid segment filename %s: %w", baseName, err)
        }
        
        // Open segment file
        file, err := os.OpenFile(match, os.O_RDWR|os.O_APPEND, 0644)
        if err != nil {
            return fmt.Errorf("failed to open segment file %s: %w", match, err)
        }
        
        // Get file info
        info, err := file.Stat()
        if err != nil {
            file.Close()
            return fmt.Errorf("failed to stat segment file %s: %w", match, err)
        }
        
        // Create segment
        segment := &LogSegment{
            file:       file,
            baseOffset: baseOffset,
            startTime:  info.ModTime(),
        }
        
        // Add to segments list
        sp.segments = append(sp.segments, segment)
    }
    
    return nil
}

// writeMessage writes a message to the active segment, rolling if necessary
func (sp *SegmentedPartition) writeMessage(msg *Message) (int64, error) {
    sp.mu.Lock()
    defer sp.mu.Unlock()
    
    // Get file info
    info, err := sp.activeSegment.file.Stat()
    if err != nil {
        return -1, fmt.Errorf("failed to stat segment file: %w", err)
    }
    
    // Check if segment is full
    if info.Size() >= sp.maxSegmentSize {
        // Roll segment
        newBaseOffset := sp.activeSegment.baseOffset + info.Size()
        if err := sp.createNewSegment(newBaseOffset); err != nil {
            return -1, fmt.Errorf("failed to roll segment: %w", err)
        }
    }
    
    // Calculate offset within segment
    segmentOffset := info.Size()
    
    // Calculate global offset
    globalOffset := sp.activeSegment.baseOffset + segmentOffset
    
    // Serialize message
    msgBytes, err := serializeMessage(msg)
    if err != nil {
        return -1, fmt.Errorf("failed to serialize message: %w", err)
    }
    
    // Write message to active segment
    if _, err := sp.activeSegment.file.Write(msgBytes); err != nil {
        return -1, fmt.Errorf("failed to write message: %w", err)
    }
    
    return globalOffset, nil
}

// segmentCleanerLoop periodically cleans up old segments
func (sp *SegmentedPartition) segmentCleanerLoop() {
    ticker := time.NewTicker(1 * time.Hour)
    defer ticker.Stop()
    
    for range ticker.C {
        sp.cleanOldSegments()
    }
}

// cleanOldSegments removes segments older than the retention period
func (sp *SegmentedPartition) cleanOldSegments() {
    sp.mu.Lock()
    defer sp.mu.Unlock()
    
    // Can't clean if we only have one segment
    if len(sp.segments) <= 1 {
        return
    }
    
    cutoffTime := time.Now().Add(-sp.retention)
    
    // Find segments to remove
    var newSegments []*LogSegment
    for i, segment := range sp.segments {
        // Skip the active segment
        if segment == sp.activeSegment {
            newSegments = append(newSegments, segment)
            continue
        }
        
        // Skip segments newer than cutoff
        if segment.startTime.After(cutoffTime) {
            newSegments = append(newSegments, segment)
            continue
        }
        
        // Skip the newest segment that's older than cutoff
        // (we need at least one old segment for historical data)
        if i > 0 && sp.segments[i-1].startTime.Before(cutoffTime) && 
           (i == len(sp.segments)-1 || sp.segments[i+1].startTime.After(cutoffTime)) {
            newSegments = append(newSegments, segment)
            continue
        }
        
        // Remove this segment
        log.Printf("Removing old segment %s (created at %s)", 
            segment.file.Name(), segment.startTime)
        
        segment.file.Close()
        os.Remove(segment.file.Name())
    }
    
    sp.segments = newSegments
}
```

### Message Compression

To improve storage efficiency and network throughput, we implement message compression:

```go
// CompressionType defines the compression algorithm used
type CompressionType int

const (
    // CompressionNone means no compression is used
    CompressionNone CompressionType = 0
    
    // CompressionGzip uses gzip compression
    CompressionGzip CompressionType = 1
    
    // CompressionSnappy uses snappy compression
    CompressionSnappy CompressionType = 2
)

// CompressedMessage represents a message with compression metadata
type CompressedMessage struct {
    Message
    CompressionType CompressionType
}

// Compress compresses a message payload
func Compress(msg *Message, compressionType CompressionType) (*CompressedMessage, error) {
    // Create compressed message
    compMsg := &CompressedMessage{
        Message: Message{
            Key:       msg.Key,
            Timestamp: msg.Timestamp,
        },
        CompressionType: compressionType,
    }
    
    // Compress payload
    switch compressionType {
    case CompressionNone:
        compMsg.Value = msg.Value
        
    case CompressionGzip:
        var buf bytes.Buffer
        writer := gzip.NewWriter(&buf)
        
        if _, err := writer.Write(msg.Value); err != nil {
            return nil, fmt.Errorf("failed to compress with gzip: %w", err)
        }
        
        if err := writer.Close(); err != nil {
            return nil, fmt.Errorf("failed to close gzip writer: %w", err)
        }
        
        compMsg.Value = buf.Bytes()
        
    case CompressionSnappy:
        compMsg.Value = snappy.Encode(nil, msg.Value)
        
    default:
        return nil, fmt.Errorf("unknown compression type: %d", compressionType)
    }
    
    return compMsg, nil
}

// Decompress decompresses a message payload
func Decompress(compMsg *CompressedMessage) (*Message, error) {
    // Create decompressed message
    msg := &Message{
        Key:       compMsg.Key,
        Timestamp: compMsg.Timestamp,
    }
    
    // Decompress payload
    switch compMsg.CompressionType {
    case CompressionNone:
        msg.Value = compMsg.Value
        
    case CompressionGzip:
        reader, err := gzip.NewReader(bytes.NewReader(compMsg.Value))
        if err != nil {
            return nil, fmt.Errorf("failed to create gzip reader: %w", err)
        }
        
        value, err := io.ReadAll(reader)
        if err != nil {
            return nil, fmt.Errorf("failed to decompress with gzip: %w", err)
        }
        
        if err := reader.Close(); err != nil {
            return nil, fmt.Errorf("failed to close gzip reader: %w", err)
        }
        
        msg.Value = value
        
    case CompressionSnappy:
        value, err := snappy.Decode(nil, compMsg.Value)
        if err != nil {
            return nil, fmt.Errorf("failed to decompress with snappy: %w", err)
        }
        
        msg.Value = value
        
    default:
        return nil, fmt.Errorf("unknown compression type: %d", compMsg.CompressionType)
    }
    
    return msg, nil
}
```

### Consumer Groups

To distribute message processing across multiple consumers, we implement consumer groups:

```go
// ConsumerGroup coordinates multiple consumers in a group
type ConsumerGroup struct {
    broker   *Broker
    groupID  string
    members  map[string]*GroupMember
    topics   map[string][]int // topic -> partitions
    mu       sync.Mutex
    strategy PartitionAssignmentStrategy
}

// GroupMember represents a member of a consumer group
type GroupMember struct {
    id         string
    topics     []string
    partitions map[string][]int // topic -> partitions
    lastHeartbeat time.Time
}

// PartitionAssignmentStrategy determines how partitions are assigned to consumers
type PartitionAssignmentStrategy func(members map[string]*GroupMember, topics map[string][]int) map[string]map[string][]int

// RangeAssignmentStrategy assigns partitions to consumers using the range strategy
func RangeAssignmentStrategy(members map[string]*GroupMember, topics map[string][]int) map[string]map[string][]int {
    // Map of member ID -> topic -> partitions
    assignments := make(map[string]map[string][]int)
    
    // Initialize assignments map
    for memberID, member := range members {
        assignments[memberID] = make(map[string][]int)
        
        // Initialize empty arrays for each topic the member is subscribed to
        for _, topic := range member.topics {
            assignments[memberID][topic] = []int{}
        }
    }
    
    // Create a mapping of topics to interested members
    topicMembers := make(map[string][]string)
    for _, topic := range topics {
        topicMembers[topic] = []string{}
    }
    
    for memberID, member := range members {
        for _, topic := range member.topics {
            if _, exists := topics[topic]; exists {
                topicMembers[topic] = append(topicMembers[topic], memberID)
            }
        }
    }
    
    // Assign partitions for each topic
    for topic, partitions := range topics {
        interestedMembers := topicMembers[topic]
        if len(interestedMembers) == 0 {
            continue
        }
        
        // Sort member IDs for deterministic assignment
        sort.Strings(interestedMembers)
        
        // Calculate partitions per member
        numPartitions := len(partitions)
        numMembers := len(interestedMembers)
        
        partitionsPerMember := numPartitions / numMembers
        remainder := numPartitions % numMembers
        
        start := 0
        for i, memberID := range interestedMembers {
            // Calculate member's partition count (distribute remainder)
            count := partitionsPerMember
            if i < remainder {
                count++
            }
            
            end := start + count
            if end > numPartitions {
                end = numPartitions
            }
            
            // Assign partitions to member
            for j := start; j < end; j++ {
                assignments[memberID][topic] = append(assignments[memberID][topic], partitions[j])
            }
            
            start = end
        }
    }
    
    return assignments
}

// NewConsumerGroup creates a new consumer group
func NewConsumerGroup(broker *Broker, groupID string) *ConsumerGroup {
    return &ConsumerGroup{
        broker:   broker,
        groupID:  groupID,
        members:  make(map[string]*GroupMember),
        topics:   make(map[string][]int),
        strategy: RangeAssignmentStrategy,
    }
}

// Join adds a consumer to the group
func (cg *ConsumerGroup) Join(memberID string, topics []string) (map[string][]int, error) {
    cg.mu.Lock()
    defer cg.mu.Unlock()
    
    // Check if member already exists
    if member, exists := cg.members[memberID]; exists {
        // Update topics
        member.topics = topics
        member.lastHeartbeat = time.Now()
    } else {
        // Create new member
        cg.members[memberID] = &GroupMember{
            id:         memberID,
            topics:     topics,
            partitions: make(map[string][]int),
            lastHeartbeat: time.Now(),
        }
    }
    
    // Load topics
    for _, topicName := range topics {
        if _, exists := cg.topics[topicName]; !exists {
            // Get topic
            topic, err := cg.broker.GetTopic(topicName)
            if err != nil {
                return nil, fmt.Errorf("failed to get topic %s: %w", topicName, err)
            }
            
            // Get partitions
            partitions := make([]int, len(topic.partitions))
            for i := range topic.partitions {
                partitions[i] = i
            }
            
            cg.topics[topicName] = partitions
        }
    }
    
    // Rebalance group
    assignments := cg.rebalance()
    
    return assignments[memberID], nil
}

// Leave removes a consumer from the group
func (cg *ConsumerGroup) Leave(memberID string) error {
    cg.mu.Lock()
    defer cg.mu.Unlock()
    
    // Remove member
    delete(cg.members, memberID)
    
    // Rebalance group
    cg.rebalance()
    
    return nil
}

// Heartbeat updates a member's last heartbeat time
func (cg *ConsumerGroup) Heartbeat(memberID string) error {
    cg.mu.Lock()
    defer cg.mu.Unlock()
    
    // Check if member exists
    member, exists := cg.members[memberID]
    if !exists {
        return fmt.Errorf("member %s does not exist", memberID)
    }
    
    // Update heartbeat
    member.lastHeartbeat = time.Now()
    
    return nil
}

// CheckHeartbeats removes members that haven't sent a heartbeat recently
func (cg *ConsumerGroup) CheckHeartbeats() {
    cg.mu.Lock()
    defer cg.mu.Unlock()
    
    // Find expired members
    expiredMembers := []string{}
    deadline := time.Now().Add(-30 * time.Second)
    
    for memberID, member := range cg.members {
        if member.lastHeartbeat.Before(deadline) {
            expiredMembers = append(expiredMembers, memberID)
        }
    }
    
    // Remove expired members
    for _, memberID := range expiredMembers {
        delete(cg.members, memberID)
    }
    
    // Rebalance if any members were removed
    if len(expiredMembers) > 0 {
        cg.rebalance()
    }
}

// rebalance reassigns partitions to consumers
func (cg *ConsumerGroup) rebalance() map[string]map[string][]int {
    // Assign partitions using strategy
    assignments := cg.strategy(cg.members, cg.topics)
    
    // Update member assignments
    for memberID, topicPartitions := range assignments {
        member, exists := cg.members[memberID]
        if !exists {
            continue
        }
        
        member.partitions = topicPartitions
    }
    
    return assignments
}
```

### Basic Replication

For fault tolerance, we implement a simple leader-follower replication mechanism:

```go
// ReplicatedPartition represents a partition with replication
type ReplicatedPartition struct {
    partition  *Partition
    replicaID  int
    isLeader   bool
    replicas   []*PartitionReplica
    replicaCh  chan *Message
    done       chan struct{}
}

// PartitionReplica represents a remote partition replica
type PartitionReplica struct {
    id        int
    client    *ReplicaClient
    lastOffset int64
}

// ReplicaClient handles communication with a replica
type ReplicaClient struct {
    address string
    client  *http.Client
}

// NewReplicatedPartition creates a new replicated partition
func NewReplicatedPartition(partition *Partition, replicaID int, isLeader bool, replicaAddresses []string) *ReplicatedPartition {
    rp := &ReplicatedPartition{
        partition: partition,
        replicaID: replicaID,
        isLeader:  isLeader,
        replicaCh: make(chan *Message, 1000),
        done:      make(chan struct{}),
    }
    
    // Create replica clients
    for id, address := range replicaAddresses {
        // Skip self
        if id == replicaID {
            continue
        }
        
        client := &ReplicaClient{
            address: address,
            client:  &http.Client{Timeout: 5 * time.Second},
        }
        
        replica := &PartitionReplica{
            id:     id,
            client: client,
        }
        
        rp.replicas = append(rp.replicas, replica)
    }
    
    // Start replication if leader
    if isLeader {
        go rp.replicationLoop()
    }
    
    return rp
}

// Write writes a message to the partition and replicates if needed
func (rp *ReplicatedPartition) Write(msg *Message) (int64, error) {
    // Write to local partition
    offset, err := rp.partition.writeMessage(msg)
    if err != nil {
        return -1, err
    }
    
    // Replicate if leader
    if rp.isLeader {
        rp.replicaCh <- msg
    }
    
    return offset, nil
}

// replicationLoop sends messages to replicas
func (rp *ReplicatedPartition) replicationLoop() {
    for {
        select {
        case msg := <-rp.replicaCh:
            // Send to all replicas
            for _, replica := range rp.replicas {
                go rp.sendToReplica(replica, msg)
            }
        case <-rp.done:
            return
        }
    }
}

// sendToReplica sends a message to a specific replica
func (rp *ReplicatedPartition) sendToReplica(replica *PartitionReplica, msg *Message) {
    // Serialize message
    msgBytes, err := serializeMessage(msg)
    if err != nil {
        log.Printf("Failed to serialize message for replica %d: %v", replica.id, err)
        return
    }
    
    // Create request
    url := fmt.Sprintf("http://%s/replicate", replica.client.address)
    req, err := http.NewRequest("POST", url, bytes.NewBuffer(msgBytes))
    if err != nil {
        log.Printf("Failed to create request for replica %d: %v", replica.id, err)
        return
    }
    
    // Set headers
    req.Header.Set("Content-Type", "application/octet-stream")
    req.Header.Set("X-Replica-ID", strconv.Itoa(rp.replicaID))
    req.Header.Set("X-Topic", rp.partition.topic.name)
    req.Header.Set("X-Partition", strconv.Itoa(rp.partition.id))
    
    // Send request
    resp, err := replica.client.client.Do(req)
    if err != nil {
        log.Printf("Failed to send message to replica %d: %v", replica.id, err)
        return
    }
    defer resp.Body.Close()
    
    // Check response
    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        log.Printf("Failed to replicate to %d: %s - %s", replica.id, resp.Status, body)
        return
    }
    
    // Parse response for new offset
    var result struct {
        Offset int64 `json:"offset"`
    }
    
    if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
        log.Printf("Failed to parse replica %d response: %v", replica.id, err)
        return
    }
    
    // Update last offset
    replica.lastOffset = result.Offset
}

// Close stops replication
func (rp *ReplicatedPartition) Close() error {
    close(rp.done)
    return nil
}
```

## Lessons Learned

Building a lightweight message broker taught me several valuable lessons:

### 1. The Importance of Sequential I/O

Kafka's design leverages sequential I/O for optimal performance. The append-only log structure achieves incredible throughput by minimizing disk seeks:

```go
// Benchmark sequential writes vs. random writes
func BenchmarkIO(b *testing.B) {
    // Create test file
    file, err := os.CreateTemp("", "benchmark")
    if err != nil {
        b.Fatal(err)
    }
    defer os.Remove(file.Name())
    defer file.Close()
    
    data := make([]byte, 4096)
    rand.Read(data)
    
    b.Run("Sequential", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            if _, err := file.Write(data); err != nil {
                b.Fatal(err)
            }
        }
    })
    
    b.Run("Random", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            offset := rand.Int63n(int64(b.N * len(data)))
            if _, err := file.WriteAt(data, offset); err != nil {
                b.Fatal(err)
            }
        }
    })
}
```

### 2. The Complexity of Distributed Systems

Even without implementing a distributed protocol like Raft, coordination between producers, consumers, and the broker is challenging. Consistency guarantees are particularly difficult to manage.

### 3. The Power of Go's Concurrency Model

Go's goroutines and channels provided a clean way to implement concurrent reads and writes:

```go
// Using channels to coordinate readers and writers
type Broker struct {
    writeCh chan writeRequest
    readCh  chan readRequest
    stopCh  chan struct{}
}

func (b *Broker) Start() {
    go func() {
        for {
            select {
            case req := <-b.writeCh:
                // Handle write request
                offset, err := req.partition.Write(req.msg)
                req.resultCh <- writeResult{offset, err}
                
            case req := <-b.readCh:
                // Handle read request
                msg, nextOffset, err := req.partition.Read(req.offset)
                req.resultCh <- readResult{msg, nextOffset, err}
                
            case <-b.stopCh:
                return
            }
        }
    }()
}
```

### 4. The Trade-off Between Durability and Performance

Ensuring durability requires careful consideration of persistence strategies:

```go
// Durability vs. Performance benchmark
func BenchmarkDurability(b *testing.B) {
    file, err := os.CreateTemp("", "benchmark")
    if err != nil {
        b.Fatal(err)
    }
    defer os.Remove(file.Name())
    defer file.Close()
    
    data := make([]byte, 4096)
    rand.Read(data)
    
    b.Run("NoSync", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            if _, err := file.Write(data); err != nil {
                b.Fatal(err)
            }
        }
    })
    
    b.Run("SyncEveryWrite", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            if _, err := file.Write(data); err != nil {
                b.Fatal(err)
            }
            if err := file.Sync(); err != nil {
                b.Fatal(err)
            }
        }
    })
    
    b.Run("SyncEvery10Writes", func(b *testing.B) {
        for i := 0; i < b.N; i++ {
            if _, err := file.Write(data); err != nil {
                b.Fatal(err)
            }
            if i%10 == 0 {
                if err := file.Sync(); err != nil {
                    b.Fatal(err)
                }
            }
        }
    })
}
```

### 5. The Need for Careful Error Handling

Robust error handling is crucial for a message broker:

```go
// Example of robust error handling
func (p *Partition) writeWithResilience(msg *Message) (int64, error) {
    // Try write operation with retry
    var offset int64
    var err error
    
    for retries := 0; retries < 3; retries++ {
        offset, err = p.writeMessage(msg)
        if err == nil {
            break
        }
        
        // Check if error is retryable
        if isRetryableError(err) {
            time.Sleep(time.Duration(retries*100) * time.Millisecond)
            continue
        }
        
        // Non-retryable error
        return -1, err
    }
    
    // Log if we succeeded after retries
    if err == nil && retries > 0 {
        log.Printf("Write succeeded after %d retries", retries)
    }
    
    return offset, err
}

func isRetryableError(err error) bool {
    // Check if error is temporary or resource-related
    var tempErr interface{ Temporary() bool }
    if errors.As(err, &tempErr) && tempErr.Temporary() {
        return true
    }
    
    // Check specific error types
    if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EBUSY) {
        return true
    }
    
    return false
}
```

## Comparison with Kafka

While my lightweight implementation captures the core concepts of Kafka, several key differences exist:

| Feature | Lightweight Implementation | Apache Kafka |
|---------|----------------------------|--------------|
| **Architecture** | Single-node broker | Distributed cluster with ZooKeeper |
| **Replication** | Simple leader-follower | Sophisticated replication protocol |
| **Partitioning** | Basic round-robin or hash | More advanced partitioning strategies |
| **Retention** | Simple time-based | Configurable retention policies |
| **API** | Basic producer/consumer | Comprehensive client APIs |
| **Performance** | Good for single-node | Exceptional distributed performance |
| **Fault Tolerance** | Limited | High with proper configuration |
| **Ecosystem** | Standalone | Rich ecosystem (Connect, Streams, etc.) |

## When to Use This vs. Full Kafka

This lightweight implementation is suitable for:

1. **Development and testing**: When you need Kafka-like semantics without the operational overhead
2. **Embedded applications**: When you need a message broker within a single application
3. **Edge computing**: When resources are constrained but message persistence is required
4. **Learning**: To understand the internals of message brokers

Apache Kafka is better for:

1. **Production systems**: When reliability and scalability are critical
2. **High-throughput applications**: When you need to process millions of messages per second
3. **Multi-node deployments**: When a single point of failure is unacceptable
4. **Complex event processing**: When you need Kafka Streams or ksqlDB

## Conclusion

Building a lightweight Kafka clone in Go was an educational journey that provided deep insights into message broker architecture, performance optimization, and failure handling. The resulting system, while not a replacement for Apache Kafka, demonstrates how core messaging patterns can be implemented efficiently with minimal operational complexity.

Key takeaways:

1. Append-only logs provide an elegant model for durable, high-performance messaging
2. Go's concurrency model is well-suited for implementing message brokers
3. The trade-offs between performance, durability, and complexity are non-trivial
4. Many of Kafka's design decisions become clear when you attempt to implement similar functionality
5. A simpler implementation can be valuable in specific scenarios where operational simplicity is prioritized

The open-source community has also created several lightweight Kafka alternatives worth exploring, such as NATS Streaming, Redpanda, and RabbitMQ Streams. Each makes different trade-offs, but all are inspired by the robust messaging semantics pioneered by Kafka.

I hope this exploration has provided valuable insights into message broker design and implementation. The code examples demonstrate how a relatively small codebase can capture the essence of a sophisticated messaging system while remaining approachable and educational.

---

*Would you be interested in a GitHub repository with the complete implementation? Let me know in the comments!*