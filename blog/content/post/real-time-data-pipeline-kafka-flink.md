---
title: "Real-Time Data Pipeline Architecture with Apache Kafka and Flink"
date: 2026-11-03T00:00:00-05:00
draft: false
tags: ["Apache Kafka", "Apache Flink", "Real-Time Processing", "Data Engineering", "Stream Processing", "Event Streaming", "Data Pipeline", "Big Data"]
categories:
- Data Engineering
- Real-Time Analytics
- Stream Processing
author: "Matthew Mattox - mmattox@support.tools"
description: "Master real-time data pipeline architecture using Apache Kafka and Flink for high-throughput, low-latency data processing. Learn production-ready configurations, optimization techniques, and best practices for building scalable streaming data platforms."
more_link: "yes"
url: "/real-time-data-pipeline-kafka-flink/"
---

Building robust real-time data pipelines is crucial for modern data-driven organizations that need to process and analyze streaming data at scale. Apache Kafka and Apache Flink form a powerful combination for creating high-performance, fault-tolerant streaming data platforms that can handle millions of events per second with minimal latency.

<!--more-->

# Real-Time Data Pipeline Architecture with Apache Kafka and Flink

## Introduction to Real-Time Data Processing

Real-time data processing has become essential for applications ranging from fraud detection and real-time recommendations to IoT analytics and financial trading systems. Traditional batch processing approaches introduce latency that can be unacceptable for time-sensitive use cases. Apache Kafka provides a distributed streaming platform for building real-time data pipelines, while Apache Flink offers sophisticated stream processing capabilities with exactly-once semantics and low-latency processing.

This comprehensive guide explores the architecture, implementation, and optimization of real-time data pipelines using Kafka and Flink, providing production-ready configurations and best practices for enterprise deployments.

## Architecture Overview

### Core Components

A typical real-time data pipeline architecture consists of several key components:

1. **Data Sources**: Applications, databases, IoT devices, and external APIs
2. **Message Broker**: Apache Kafka for reliable data ingestion and buffering
3. **Stream Processor**: Apache Flink for real-time data transformation and analytics
4. **Data Sinks**: Databases, data lakes, and downstream applications
5. **Monitoring and Observability**: Metrics, logging, and alerting systems

### High-Level Architecture

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pipeline-architecture
data:
  architecture.yaml: |
    components:
      data_sources:
        - web_applications
        - mobile_apps
        - iot_sensors
        - database_cdc
        - external_apis
      
      kafka_cluster:
        brokers: 3
        replication_factor: 3
        partitions_per_topic: 12
        
      flink_cluster:
        job_managers: 2
        task_managers: 6
        slots_per_task_manager: 4
        
      data_sinks:
        - elasticsearch
        - postgresql
        - s3_data_lake
        - redis_cache
        - downstream_services
```

## Apache Kafka Configuration

### Broker Configuration

Proper Kafka configuration is critical for achieving high throughput and reliability:

```properties
# /opt/kafka/config/server.properties

# Broker ID and networking
broker.id=1
listeners=PLAINTEXT://0.0.0.0:9092
advertised.listeners=PLAINTEXT://kafka-broker-1:9092

# Log configuration for high throughput
log.dirs=/var/kafka-logs
num.network.threads=8
num.io.threads=16
socket.send.buffer.bytes=102400
socket.receive.buffer.bytes=102400
socket.request.max.bytes=104857600

# Replication and durability
default.replication.factor=3
min.insync.replicas=2
unclean.leader.election.enable=false
log.retention.hours=168
log.segment.bytes=1073741824

# Performance optimizations
num.replica.fetchers=4
replica.fetch.max.bytes=1048576
replica.fetch.min.bytes=1
replica.fetch.wait.max.ms=500

# Compression
compression.type=snappy
```

### Topic Configuration

Creating topics optimized for real-time processing:

```bash
#!/bin/bash
# create-topics.sh

KAFKA_HOME="/opt/kafka"
BOOTSTRAP_SERVERS="kafka-broker-1:9092,kafka-broker-2:9092,kafka-broker-3:9092"

# User events topic
$KAFKA_HOME/bin/kafka-topics.sh --create \
  --bootstrap-server $BOOTSTRAP_SERVERS \
  --topic user-events \
  --partitions 24 \
  --replication-factor 3 \
  --config cleanup.policy=delete \
  --config retention.ms=604800000 \
  --config segment.ms=86400000 \
  --config compression.type=snappy

# Transaction events topic
$KAFKA_HOME/bin/kafka-topics.sh --create \
  --bootstrap-server $BOOTSTRAP_SERVERS \
  --topic transaction-events \
  --partitions 12 \
  --replication-factor 3 \
  --config cleanup.policy=delete \
  --config retention.ms=2592000000 \
  --config min.insync.replicas=2

# Processed results topic
$KAFKA_HOME/bin/kafka-topics.sh --create \
  --bootstrap-server $BOOTSTRAP_SERVERS \
  --topic processed-results \
  --partitions 6 \
  --replication-factor 3 \
  --config cleanup.policy=delete \
  --config retention.ms=259200000
```

### Producer Configuration

High-performance producer configuration for real-time ingestion:

```java
// KafkaProducerConfig.java
package com.supporttools.pipeline.producer;

import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;

import java.util.Properties;
import java.util.concurrent.Future;
import java.util.concurrent.CompletableFuture;

public class OptimizedKafkaProducer {
    private final KafkaProducer<String, String> producer;
    
    public OptimizedKafkaProducer(String bootstrapServers) {
        Properties props = new Properties();
        
        // Connection settings
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        
        // Performance optimizations
        props.put(ProducerConfig.BATCH_SIZE_CONFIG, 32768);
        props.put(ProducerConfig.LINGER_MS_CONFIG, 5);
        props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67108864);
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "snappy");
        
        // Reliability settings
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        
        // Timeout settings
        props.put(ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 30000);
        props.put(ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 120000);
        
        this.producer = new KafkaProducer<>(props);
    }
    
    public CompletableFuture<Void> sendAsync(String topic, String key, String value) {
        ProducerRecord<String, String> record = new ProducerRecord<>(topic, key, value);
        
        CompletableFuture<Void> future = new CompletableFuture<>();
        
        producer.send(record, (metadata, exception) -> {
            if (exception != null) {
                future.completeExceptionally(exception);
            } else {
                future.complete(null);
            }
        });
        
        return future;
    }
    
    public void close() {
        producer.close();
    }
}
```

## Apache Flink Stream Processing

### Flink Cluster Configuration

Configuring Flink for high-performance stream processing:

```yaml
# flink-conf.yaml
jobmanager.rpc.address: flink-jobmanager
jobmanager.rpc.port: 6123
jobmanager.bind-host: 0.0.0.0
jobmanager.memory.process.size: 2048m
jobmanager.memory.jvm-metaspace.size: 256m

taskmanager.bind-host: 0.0.0.0
taskmanager.rpc.port: 6122
taskmanager.memory.process.size: 4096m
taskmanager.memory.managed.fraction: 0.4
taskmanager.numberOfTaskSlots: 4

# Network buffers
taskmanager.memory.network.fraction: 0.1
taskmanager.memory.network.min: 128mb
taskmanager.memory.network.max: 1gb

# Checkpointing
state.backend: rocksdb
state.checkpoints.dir: s3://flink-checkpoints/
state.savepoints.dir: s3://flink-savepoints/
execution.checkpointing.interval: 30s
execution.checkpointing.min-pause: 5s
execution.checkpointing.timeout: 10min
execution.checkpointing.max-concurrent-checkpoints: 1

# Restart strategy
restart-strategy: fixed-delay
restart-strategy.fixed-delay.attempts: 10
restart-strategy.fixed-delay.delay: 30s

# Performance tuning
parallelism.default: 4
taskmanager.memory.segment-size: 32kb
```

### Real-Time Processing Job

Implementing a comprehensive Flink streaming job:

```java
// RealTimeProcessingJob.java
package com.supporttools.pipeline.flink;

import org.apache.flink.api.common.eventtime.WatermarkStrategy;
import org.apache.flink.api.common.functions.AggregateFunction;
import org.apache.flink.api.common.functions.MapFunction;
import org.apache.flink.api.common.serialization.SimpleStringSchema;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeHint;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.tuple.Tuple2;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.connector.kafka.source.KafkaSource;
import org.apache.flink.connector.kafka.source.enumerator.initializer.OffsetsInitializer;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.streaming.api.windowing.assigners.TumblingEventTimeWindows;
import org.apache.flink.streaming.api.windowing.time.Time;
import org.apache.flink.util.Collector;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;

public class RealTimeProcessingJob {
    
    public static void main(String[] args) throws Exception {
        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
        
        // Enable checkpointing
        env.enableCheckpointing(30000);
        env.getCheckpointConfig().setCheckpointingMode(CheckpointingMode.EXACTLY_ONCE);
        
        // Configure Kafka source
        KafkaSource<String> kafkaSource = KafkaSource.<String>builder()
                .setBootstrapServers("kafka-broker-1:9092,kafka-broker-2:9092")
                .setTopics("user-events", "transaction-events")
                .setGroupId("flink-processing-group")
                .setStartingOffsets(OffsetsInitializer.latest())
                .setValueOnlyDeserializer(new SimpleStringSchema())
                .build();
        
        // Create data stream
        DataStream<String> rawEvents = env.fromSource(
                kafkaSource,
                WatermarkStrategy.<String>forBoundedOutOfOrderness(Duration.ofSeconds(5))
                        .withTimestampAssigner((event, timestamp) -> extractTimestamp(event)),
                "kafka-source"
        );
        
        // Parse and enrich events
        DataStream<EnrichedEvent> enrichedEvents = rawEvents
                .map(new EventParser())
                .keyBy(event -> event.getUserId())
                .process(new EventEnricher());
        
        // Aggregate events in tumbling windows
        DataStream<AggregatedMetrics> aggregatedMetrics = enrichedEvents
                .keyBy(event -> event.getEventType())
                .window(TumblingEventTimeWindows.of(Time.minutes(1)))
                .aggregate(new EventAggregator());
        
        // Detect anomalies
        DataStream<AnomalyAlert> anomalies = enrichedEvents
                .keyBy(event -> event.getUserId())
                .process(new AnomalyDetector());
        
        // Configure Kafka sink
        KafkaSink<String> kafkaSink = KafkaSink.<String>builder()
                .setBootstrapServers("kafka-broker-1:9092,kafka-broker-2:9092")
                .setRecordSerializer(KafkaRecordSerializationSchema.builder()
                        .setTopic("processed-results")
                        .setValueSerializationSchema(new SimpleStringSchema())
                        .build()
                )
                .build();
        
        // Send results to Kafka
        aggregatedMetrics
                .map(metrics -> convertToJson(metrics))
                .sinkTo(kafkaSink);
        
        anomalies
                .map(alert -> convertToJson(alert))
                .sinkTo(kafkaSink);
        
        env.execute("Real-Time Data Processing Job");
    }
    
    private static long extractTimestamp(String event) {
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode node = mapper.readTree(event);
            return node.get("timestamp").asLong();
        } catch (Exception e) {
            return System.currentTimeMillis();
        }
    }
    
    // Event parser
    public static class EventParser implements MapFunction<String, EnrichedEvent> {
        private final ObjectMapper mapper = new ObjectMapper();
        
        @Override
        public EnrichedEvent map(String value) throws Exception {
            JsonNode node = mapper.readTree(value);
            
            return new EnrichedEvent(
                    node.get("userId").asText(),
                    node.get("eventType").asText(),
                    node.get("timestamp").asLong(),
                    node.get("data").toString()
            );
        }
    }
    
    // Event enricher with state
    public static class EventEnricher extends KeyedProcessFunction<String, EnrichedEvent, EnrichedEvent> {
        private ValueState<UserProfile> userProfileState;
        
        @Override
        public void open(Configuration parameters) {
            ValueStateDescriptor<UserProfile> descriptor = new ValueStateDescriptor<>(
                    "user-profile",
                    TypeInformation.of(new TypeHint<UserProfile>() {})
            );
            userProfileState = getRuntimeContext().getState(descriptor);
        }
        
        @Override
        public void processElement(EnrichedEvent event, Context context, Collector<EnrichedEvent> out) throws Exception {
            UserProfile profile = userProfileState.value();
            
            if (profile == null) {
                profile = new UserProfile(event.getUserId());
            }
            
            // Enrich event with user profile data
            profile.updateActivity(event);
            event.setUserSegment(profile.getSegment());
            event.setRiskScore(profile.getRiskScore());
            
            userProfileState.update(profile);
            out.collect(event);
        }
    }
    
    // Event aggregator
    public static class EventAggregator implements AggregateFunction<EnrichedEvent, EventAccumulator, AggregatedMetrics> {
        
        @Override
        public EventAccumulator createAccumulator() {
            return new EventAccumulator();
        }
        
        @Override
        public EventAccumulator add(EnrichedEvent event, EventAccumulator accumulator) {
            accumulator.addEvent(event);
            return accumulator;
        }
        
        @Override
        public AggregatedMetrics getResult(EventAccumulator accumulator) {
            return accumulator.getMetrics();
        }
        
        @Override
        public EventAccumulator merge(EventAccumulator a, EventAccumulator b) {
            return a.merge(b);
        }
    }
    
    // Anomaly detector
    public static class AnomalyDetector extends KeyedProcessFunction<String, EnrichedEvent, AnomalyAlert> {
        private ValueState<Double> baselineState;
        private ValueState<Long> lastEventTimeState;
        
        @Override
        public void open(Configuration parameters) {
            ValueStateDescriptor<Double> baselineDescriptor = new ValueStateDescriptor<>(
                    "baseline",
                    Double.class
            );
            baselineState = getRuntimeContext().getState(baselineDescriptor);
            
            ValueStateDescriptor<Long> timeDescriptor = new ValueStateDescriptor<>(
                    "last-event-time",
                    Long.class
            );
            lastEventTimeState = getRuntimeContext().getState(timeDescriptor);
        }
        
        @Override
        public void processElement(EnrichedEvent event, Context context, Collector<AnomalyAlert> out) throws Exception {
            Double baseline = baselineState.value();
            Long lastEventTime = lastEventTimeState.value();
            
            if (baseline == null) {
                baseline = 1.0;
            }
            
            if (lastEventTime == null) {
                lastEventTime = event.getTimestamp();
            }
            
            // Calculate event frequency
            long timeDiff = event.getTimestamp() - lastEventTime;
            double currentRate = 1000.0 / Math.max(timeDiff, 1);
            
            // Update baseline using exponential moving average
            baseline = 0.9 * baseline + 0.1 * currentRate;
            
            // Detect anomaly if current rate is significantly higher than baseline
            if (currentRate > baseline * 3.0 && currentRate > 10.0) {
                AnomalyAlert alert = new AnomalyAlert(
                        event.getUserId(),
                        "HIGH_FREQUENCY",
                        currentRate,
                        baseline,
                        event.getTimestamp()
                );
                out.collect(alert);
            }
            
            baselineState.update(baseline);
            lastEventTimeState.update(event.getTimestamp());
        }
    }
    
    private static String convertToJson(Object obj) {
        try {
            ObjectMapper mapper = new ObjectMapper();
            return mapper.writeValueAsString(obj);
        } catch (Exception e) {
            return "{}";
        }
    }
}
```

### Data Models

Supporting data model classes:

```java
// EnrichedEvent.java
package com.supporttools.pipeline.model;

public class EnrichedEvent {
    private String userId;
    private String eventType;
    private long timestamp;
    private String data;
    private String userSegment;
    private double riskScore;
    
    public EnrichedEvent(String userId, String eventType, long timestamp, String data) {
        this.userId = userId;
        this.eventType = eventType;
        this.timestamp = timestamp;
        this.data = data;
    }
    
    // Getters and setters
    public String getUserId() { return userId; }
    public String getEventType() { return eventType; }
    public long getTimestamp() { return timestamp; }
    public String getData() { return data; }
    public String getUserSegment() { return userSegment; }
    public void setUserSegment(String userSegment) { this.userSegment = userSegment; }
    public double getRiskScore() { return riskScore; }
    public void setRiskScore(double riskScore) { this.riskScore = riskScore; }
}

// UserProfile.java
package com.supporttools.pipeline.model;

import java.util.HashMap;
import java.util.Map;

public class UserProfile {
    private String userId;
    private Map<String, Integer> eventCounts;
    private long lastActivityTime;
    private double riskScore;
    private String segment;
    
    public UserProfile(String userId) {
        this.userId = userId;
        this.eventCounts = new HashMap<>();
        this.lastActivityTime = System.currentTimeMillis();
        this.riskScore = 0.5;
        this.segment = "NEW";
    }
    
    public void updateActivity(EnrichedEvent event) {
        eventCounts.merge(event.getEventType(), 1, Integer::sum);
        lastActivityTime = event.getTimestamp();
        
        // Update risk score based on activity patterns
        int totalEvents = eventCounts.values().stream().mapToInt(Integer::intValue).sum();
        if (totalEvents > 1000) {
            segment = "HIGH_VOLUME";
            riskScore = Math.min(0.8, riskScore + 0.1);
        } else if (totalEvents > 100) {
            segment = "ACTIVE";
            riskScore = Math.max(0.2, riskScore - 0.05);
        }
    }
    
    public String getSegment() { return segment; }
    public double getRiskScore() { return riskScore; }
}

// EventAccumulator.java
package com.supporttools.pipeline.model;

import java.util.HashMap;
import java.util.Map;

public class EventAccumulator {
    private Map<String, Long> eventCounts;
    private long totalEvents;
    private long windowStart;
    private long windowEnd;
    
    public EventAccumulator() {
        this.eventCounts = new HashMap<>();
        this.totalEvents = 0;
        this.windowStart = Long.MAX_VALUE;
        this.windowEnd = Long.MIN_VALUE;
    }
    
    public void addEvent(EnrichedEvent event) {
        eventCounts.merge(event.getEventType(), 1L, Long::sum);
        totalEvents++;
        windowStart = Math.min(windowStart, event.getTimestamp());
        windowEnd = Math.max(windowEnd, event.getTimestamp());
    }
    
    public EventAccumulator merge(EventAccumulator other) {
        other.eventCounts.forEach((k, v) -> eventCounts.merge(k, v, Long::sum));
        totalEvents += other.totalEvents;
        windowStart = Math.min(windowStart, other.windowStart);
        windowEnd = Math.max(windowEnd, other.windowEnd);
        return this;
    }
    
    public AggregatedMetrics getMetrics() {
        return new AggregatedMetrics(eventCounts, totalEvents, windowStart, windowEnd);
    }
}

// AggregatedMetrics.java
package com.supporttools.pipeline.model;

import java.util.Map;

public class AggregatedMetrics {
    private Map<String, Long> eventCounts;
    private long totalEvents;
    private long windowStart;
    private long windowEnd;
    
    public AggregatedMetrics(Map<String, Long> eventCounts, long totalEvents, long windowStart, long windowEnd) {
        this.eventCounts = eventCounts;
        this.totalEvents = totalEvents;
        this.windowStart = windowStart;
        this.windowEnd = windowEnd;
    }
    
    // Getters
    public Map<String, Long> getEventCounts() { return eventCounts; }
    public long getTotalEvents() { return totalEvents; }
    public long getWindowStart() { return windowStart; }
    public long getWindowEnd() { return windowEnd; }
}

// AnomalyAlert.java
package com.supporttools.pipeline.model;

public class AnomalyAlert {
    private String userId;
    private String anomalyType;
    private double currentValue;
    private double baselineValue;
    private long timestamp;
    
    public AnomalyAlert(String userId, String anomalyType, double currentValue, double baselineValue, long timestamp) {
        this.userId = userId;
        this.anomalyType = anomalyType;
        this.currentValue = currentValue;
        this.baselineValue = baselineValue;
        this.timestamp = timestamp;
    }
    
    // Getters
    public String getUserId() { return userId; }
    public String getAnomalyType() { return anomalyType; }
    public double getCurrentValue() { return currentValue; }
    public double getBaselineValue() { return baselineValue; }
    public long getTimestamp() { return timestamp; }
}
```

## Kubernetes Deployment

### Kafka Deployment

```yaml
# kafka-deployment.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
  namespace: data-platform
spec:
  serviceName: kafka-headless
  replicas: 3
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      containers:
      - name: kafka
        image: confluentinc/cp-kafka:7.4.0
        ports:
        - containerPort: 9092
        - containerPort: 9093
        env:
        - name: KAFKA_BROKER_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: KAFKA_ZOOKEEPER_CONNECT
          value: "zookeeper:2181"
        - name: KAFKA_LISTENER_SECURITY_PROTOCOL_MAP
          value: "PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT"
        - name: KAFKA_ADVERTISED_LISTENERS
          value: "PLAINTEXT://$(HOSTNAME).kafka-headless:9092"
        - name: KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR
          value: "3"
        - name: KAFKA_TRANSACTION_STATE_LOG_MIN_ISR
          value: "2"
        - name: KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR
          value: "3"
        - name: KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS
          value: "0"
        - name: KAFKA_JMX_PORT
          value: "9999"
        - name: KAFKA_JMX_HOSTNAME
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
        volumeMounts:
        - name: kafka-data
          mountPath: /var/lib/kafka/data
  volumeClaimTemplates:
  - metadata:
      name: kafka-data
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 100Gi
      storageClassName: fast-ssd
---
apiVersion: v1
kind: Service
metadata:
  name: kafka-headless
  namespace: data-platform
spec:
  clusterIP: None
  selector:
    app: kafka
  ports:
  - port: 9092
    name: kafka
---
apiVersion: v1
kind: Service
metadata:
  name: kafka
  namespace: data-platform
spec:
  selector:
    app: kafka
  ports:
  - port: 9092
    name: kafka
```

### Flink Deployment

```yaml
# flink-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flink-jobmanager
  namespace: data-platform
spec:
  replicas: 2
  selector:
    matchLabels:
      app: flink
      component: jobmanager
  template:
    metadata:
      labels:
        app: flink
        component: jobmanager
    spec:
      containers:
      - name: jobmanager
        image: flink:1.17.1-scala_2.12-java11
        args: ["jobmanager"]
        ports:
        - containerPort: 6123
          name: rpc
        - containerPort: 6124
          name: blob-server
        - containerPort: 8081
          name: webui
        env:
        - name: FLINK_PROPERTIES
          value: |
            jobmanager.rpc.address: flink-jobmanager
            taskmanager.numberOfTaskSlots: 4
            blob.server.port: 6124
            jobmanager.rpc.port: 6123
            taskmanager.rpc.port: 6122
            jobmanager.memory.process.size: 2048m
            taskmanager.memory.process.size: 4096m
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "3Gi"
            cpu: "2000m"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: flink-taskmanager
  namespace: data-platform
spec:
  replicas: 6
  selector:
    matchLabels:
      app: flink
      component: taskmanager
  template:
    metadata:
      labels:
        app: flink
        component: taskmanager
    spec:
      containers:
      - name: taskmanager
        image: flink:1.17.1-scala_2.12-java11
        args: ["taskmanager"]
        ports:
        - containerPort: 6122
          name: rpc
        - containerPort: 6125
          name: query-state
        env:
        - name: FLINK_PROPERTIES
          value: |
            jobmanager.rpc.address: flink-jobmanager
            taskmanager.numberOfTaskSlots: 4
            blob.server.port: 6124
            jobmanager.rpc.port: 6123
            taskmanager.rpc.port: 6122
            jobmanager.memory.process.size: 2048m
            taskmanager.memory.process.size: 4096m
        resources:
          requests:
            memory: "4Gi"
            cpu: "2000m"
          limits:
            memory: "6Gi"
            cpu: "4000m"
---
apiVersion: v1
kind: Service
metadata:
  name: flink-jobmanager
  namespace: data-platform
spec:
  type: ClusterIP
  ports:
  - name: rpc
    port: 6123
  - name: blob-server
    port: 6124
  - name: webui
    port: 8081
  selector:
    app: flink
    component: jobmanager
---
apiVersion: v1
kind: Service
metadata:
  name: flink-jobmanager-rest
  namespace: data-platform
spec:
  type: LoadBalancer
  ports:
  - name: rest
    port: 8081
    targetPort: 8081
  selector:
    app: flink
    component: jobmanager
```

## Performance Optimization

### Kafka Optimization

Key performance tuning parameters for Kafka:

```bash
#!/bin/bash
# kafka-tuning.sh

# OS-level optimizations
echo 'vm.swappiness=1' >> /etc/sysctl.conf
echo 'vm.dirty_background_ratio=5' >> /etc/sysctl.conf
echo 'vm.dirty_ratio=60' >> /etc/sysctl.conf
echo 'vm.dirty_expire_centisecs=12000' >> /etc/sysctl.conf
echo 'net.core.rmem_default=262144' >> /etc/sysctl.conf
echo 'net.core.rmem_max=16777216' >> /etc/sysctl.conf
echo 'net.core.wmem_default=262144' >> /etc/sysctl.conf
echo 'net.core.wmem_max=16777216' >> /etc/sysctl.conf

sysctl -p

# JVM tuning for Kafka
export KAFKA_HEAP_OPTS="-Xmx6g -Xms6g"
export KAFKA_JVM_PERFORMANCE_OPTS="-server -XX:+UseG1GC -XX:MaxGCPauseMillis=20 -XX:InitiatingHeapOccupancyPercent=35 -XX:+ExplicitGCInvokesConcurrent -XX:MaxInlineLevel=15 -Djava.awt.headless=true"

# Topic configuration for high throughput
kafka-topics.sh --alter --bootstrap-server localhost:9092 \
  --topic high-throughput-topic \
  --config segment.bytes=1073741824 \
  --config segment.ms=86400000 \
  --config compression.type=snappy \
  --config cleanup.policy=delete \
  --config min.cleanable.dirty.ratio=0.1 \
  --config delete.retention.ms=86400000
```

### Flink Optimization

Flink performance tuning configuration:

```yaml
# flink-optimization.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flink-config
  namespace: data-platform
data:
  flink-conf.yaml: |
    # JobManager configuration
    jobmanager.memory.process.size: 2048m
    jobmanager.memory.jvm-metaspace.size: 256m
    
    # TaskManager configuration
    taskmanager.memory.process.size: 4096m
    taskmanager.memory.managed.fraction: 0.4
    taskmanager.memory.network.fraction: 0.15
    taskmanager.numberOfTaskSlots: 4
    
    # Network configuration
    taskmanager.network.memory.buffers-per-channel: 2
    taskmanager.network.memory.floating-buffers-per-gate: 8
    taskmanager.network.memory.buffer-debloat.enabled: true
    
    # State backend configuration
    state.backend: rocksdb
    state.backend.incremental: true
    state.backend.rocksdb.predefined-options: SPINNING_DISK_OPTIMIZED_HIGH_MEM
    state.backend.rocksdb.block.cache-size: 256m
    state.backend.rocksdb.write-buffer-size: 64m
    state.backend.rocksdb.thread.num: 4
    
    # Checkpointing configuration
    execution.checkpointing.interval: 30s
    execution.checkpointing.mode: EXACTLY_ONCE
    execution.checkpointing.timeout: 10min
    execution.checkpointing.max-concurrent-checkpoints: 1
    execution.checkpointing.min-pause: 5s
    
    # Restart strategy
    restart-strategy: exponential-delay
    restart-strategy.exponential-delay.initial-backoff: 10s
    restart-strategy.exponential-delay.max-backoff: 2min
    restart-strategy.exponential-delay.backoff-multiplier: 2.0
    restart-strategy.exponential-delay.reset-backoff-threshold: 10min
    restart-strategy.exponential-delay.jitter-factor: 0.1
    
    # Performance tuning
    taskmanager.memory.segment-size: 32kb
    parallelism.default: 4
    pipeline.object-reuse: true
    pipeline.generic-types: false
```

## Monitoring and Observability

### Prometheus Metrics

Comprehensive monitoring setup:

```yaml
# monitoring-stack.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s
    
    rule_files:
      - "kafka-rules.yml"
      - "flink-rules.yml"
    
    scrape_configs:
    - job_name: 'kafka'
      static_configs:
      - targets: ['kafka-jmx-exporter:9308']
      scrape_interval: 10s
      metrics_path: /metrics
    
    - job_name: 'flink-jobmanager'
      static_configs:
      - targets: ['flink-jobmanager:9999']
      scrape_interval: 10s
      metrics_path: /metrics
    
    - job_name: 'flink-taskmanager'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - data-platform
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_component]
        action: keep
        regex: taskmanager
      - source_labels: [__meta_kubernetes_pod_ip]
        target_label: __address__
        replacement: ${1}:9999
    
    alerting:
      alertmanagers:
      - static_configs:
        - targets:
          - alertmanager:9093

  kafka-rules.yml: |
    groups:
    - name: kafka.rules
      rules:
      - alert: KafkaBrokerDown
        expr: up{job="kafka"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Kafka broker is down"
          description: "Kafka broker {{ $labels.instance }} has been down for more than 1 minute."
      
      - alert: KafkaHighProducerLatency
        expr: kafka_producer_request_latency_avg > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High Kafka producer latency"
          description: "Producer latency is {{ $value }}ms on {{ $labels.instance }}"
      
      - alert: KafkaHighConsumerLag
        expr: kafka_consumer_lag_sum > 10000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High Kafka consumer lag"
          description: "Consumer lag is {{ $value }} on {{ $labels.instance }}"

  flink-rules.yml: |
    groups:
    - name: flink.rules
      rules:
      - alert: FlinkJobManagerDown
        expr: up{job="flink-jobmanager"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Flink JobManager is down"
          description: "Flink JobManager {{ $labels.instance }} has been down for more than 1 minute."
      
      - alert: FlinkJobFailed
        expr: flink_jobmanager_job_numRunningJobs == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "No Flink jobs running"
          description: "No Flink jobs are currently running."
      
      - alert: FlinkHighCheckpointDuration
        expr: flink_jobmanager_job_lastCheckpointDuration > 300000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High Flink checkpoint duration"
          description: "Checkpoint duration is {{ $value }}ms for job {{ $labels.job_name }}"
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "id": null,
    "title": "Real-Time Data Pipeline Dashboard",
    "tags": ["kafka", "flink", "streaming"],
    "style": "dark",
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "Kafka Throughput",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(kafka_server_brokertopicmetrics_messagesin_total[5m])",
            "legendFormat": "Messages In/sec"
          },
          {
            "expr": "rate(kafka_server_brokertopicmetrics_bytein_total[5m])",
            "legendFormat": "Bytes In/sec"
          }
        ],
        "yAxes": [
          {
            "label": "Messages/Bytes per second",
            "min": 0
          }
        ],
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 0,
          "y": 0
        }
      },
      {
        "id": 2,
        "title": "Flink Job Metrics",
        "type": "graph",
        "targets": [
          {
            "expr": "flink_taskmanager_job_task_numRecordsInPerSecond",
            "legendFormat": "Records In/sec"
          },
          {
            "expr": "flink_taskmanager_job_task_numRecordsOutPerSecond",
            "legendFormat": "Records Out/sec"
          }
        ],
        "yAxes": [
          {
            "label": "Records per second",
            "min": 0
          }
        ],
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 12,
          "y": 0
        }
      },
      {
        "id": 3,
        "title": "Consumer Lag",
        "type": "graph",
        "targets": [
          {
            "expr": "kafka_consumer_lag_sum",
            "legendFormat": "Consumer Lag - {{ $labels.group }}"
          }
        ],
        "yAxes": [
          {
            "label": "Lag (messages)",
            "min": 0
          }
        ],
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 0,
          "y": 8
        }
      },
      {
        "id": 4,
        "title": "Checkpoint Duration",
        "type": "graph",
        "targets": [
          {
            "expr": "flink_jobmanager_job_lastCheckpointDuration",
            "legendFormat": "Checkpoint Duration - {{ $labels.job_name }}"
          }
        ],
        "yAxes": [
          {
            "label": "Duration (ms)",
            "min": 0
          }
        ],
        "gridPos": {
          "h": 8,
          "w": 12,
          "x": 12,
          "y": 8
        }
      }
    ],
    "time": {
      "from": "now-1h",
      "to": "now"
    },
    "refresh": "10s"
  }
}
```

## Best Practices and Production Considerations

### Security Configuration

```yaml
# security-config.yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-ssl-certs
  namespace: data-platform
type: Opaque
data:
  kafka.server.keystore.jks: LS0tLS1CRUdJTi...
  kafka.server.truststore.jks: LS0tLS1CRUdJTi...
  kafka.client.keystore.jks: LS0tLS1CRUdJTi...
  kafka.client.truststore.jks: LS0tLS1CRUdJTi...
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: kafka-ssl-config
  namespace: data-platform
data:
  server.properties: |
    listeners=SSL://0.0.0.0:9093
    advertised.listeners=SSL://$(HOSTNAME).kafka-headless:9093
    security.inter.broker.protocol=SSL
    ssl.keystore.location=/etc/kafka/secrets/kafka.server.keystore.jks
    ssl.keystore.password=changeit
    ssl.key.password=changeit
    ssl.truststore.location=/etc/kafka/secrets/kafka.server.truststore.jks
    ssl.truststore.password=changeit
    ssl.client.auth=required
    ssl.enabled.protocols=TLSv1.2,TLSv1.3
    ssl.keystore.type=JKS
    ssl.truststore.type=JKS
```

### Data Governance

```java
// DataGovernanceUtils.java
package com.supporttools.pipeline.governance;

import org.apache.flink.api.common.functions.RichMapFunction;
import org.apache.flink.configuration.Configuration;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

public class DataGovernanceUtils {
    
    public static class PIIRedactionFunction extends RichMapFunction<String, String> {
        private Map<String, Pattern> piiPatterns;
        
        @Override
        public void open(Configuration parameters) {
            piiPatterns = new HashMap<>();
            
            // Email pattern
            piiPatterns.put("email", Pattern.compile(
                "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b"
            ));
            
            // Phone number pattern
            piiPatterns.put("phone", Pattern.compile(
                "\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b"
            ));
            
            // Credit card pattern
            piiPatterns.put("credit_card", Pattern.compile(
                "\\b(?:\\d{4}[-\\s]?){3}\\d{4}\\b"
            ));
            
            // SSN pattern
            piiPatterns.put("ssn", Pattern.compile(
                "\\b\\d{3}-\\d{2}-\\d{4}\\b"
            ));
        }
        
        @Override
        public String map(String value) {
            String redacted = value;
            
            for (Map.Entry<String, Pattern> entry : piiPatterns.entrySet()) {
                redacted = entry.getValue().matcher(redacted)
                    .replaceAll("[" + entry.getKey().toUpperCase() + "_REDACTED]");
            }
            
            return redacted;
        }
    }
    
    public static class DataLineageTracker {
        private String sourceSystem;
        private String processingJob;
        private long processingTimestamp;
        
        public DataLineageTracker(String sourceSystem, String processingJob) {
            this.sourceSystem = sourceSystem;
            this.processingJob = processingJob;
            this.processingTimestamp = System.currentTimeMillis();
        }
        
        public String addLineageMetadata(String data) {
            // Add lineage metadata to the data
            return data + String.format(
                ",\"_lineage\":{\"source\":\"%s\",\"processor\":\"%s\",\"timestamp\":%d}",
                sourceSystem, processingJob, processingTimestamp
            );
        }
    }
}
```

### Error Handling and Recovery

```java
// ErrorHandlingStrategies.java
package com.supporttools.pipeline.error;

import org.apache.flink.api.common.functions.MapFunction;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.util.OutputTag;

public class ErrorHandlingStrategies {
    
    public static final OutputTag<String> ERROR_TAG = new OutputTag<String>("errors"){};
    
    public static class RobustEventProcessor implements MapFunction<String, ProcessedEvent> {
        
        @Override
        public ProcessedEvent map(String value) throws Exception {
            try {
                // Attempt to process the event
                return processEvent(value);
            } catch (Exception e) {
                // Log the error and create an error event
                System.err.println("Error processing event: " + value + ", Error: " + e.getMessage());
                throw e; // Re-throw to trigger side output
            }
        }
        
        private ProcessedEvent processEvent(String value) throws Exception {
            // Implement your event processing logic here
            if (value == null || value.trim().isEmpty()) {
                throw new IllegalArgumentException("Empty event received");
            }
            
            // Parse and validate the event
            // Transform the event
            // Return processed event
            
            return new ProcessedEvent(value, System.currentTimeMillis());
        }
    }
    
    public static DataStream<ProcessedEvent> createRobustPipeline(DataStream<String> input) {
        SingleOutputStreamOperator<ProcessedEvent> processedStream = input
            .map(new RobustEventProcessor())
            .name("robust-event-processor");
        
        // Handle errors via side output
        DataStream<String> errorStream = processedStream.getSideOutput(ERROR_TAG);
        
        // Send errors to dead letter queue
        errorStream.addSink(new DeadLetterQueueSink())
            .name("error-sink");
        
        return processedStream;
    }
    
    public static class ProcessedEvent {
        private String data;
        private long timestamp;
        
        public ProcessedEvent(String data, long timestamp) {
            this.data = data;
            this.timestamp = timestamp;
        }
        
        // Getters
        public String getData() { return data; }
        public long getTimestamp() { return timestamp; }
    }
}
```

## Conclusion

Building production-ready real-time data pipelines with Apache Kafka and Flink requires careful consideration of architecture, configuration, monitoring, and operational practices. This comprehensive guide provides the foundation for implementing high-performance streaming data platforms that can handle enterprise-scale workloads with reliability and efficiency.

Key takeaways for successful implementations:

1. **Proper Resource Planning**: Size your Kafka and Flink clusters based on expected throughput and latency requirements
2. **Comprehensive Monitoring**: Implement detailed observability to detect and resolve issues quickly
3. **Security by Design**: Implement encryption, authentication, and data governance from the start
4. **Error Handling**: Build robust error handling and recovery mechanisms into your pipelines
5. **Performance Testing**: Conduct thorough performance testing under realistic load conditions

By following these patterns and practices, you can build real-time data pipelines that provide the foundation for data-driven decision making and real-time analytics in your organization.