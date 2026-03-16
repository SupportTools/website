---
title: "Apache Kafka Operations: Topic Management and Consumer Optimization"
date: 2026-04-30T00:00:00-05:00
draft: false
tags: ["Apache Kafka", "Stream Processing", "Event Streaming", "Distributed Systems", "Performance Tuning", "Message Queue", "DevOps"]
categories:
- Distributed Systems
- Streaming
- Performance
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Apache Kafka operations with this comprehensive guide covering topic partitioning strategies, consumer group management, performance tuning, exactly-once semantics, and production troubleshooting techniques"
more_link: "yes"
url: "/apache-kafka-operations-topic-management-consumer-optimization/"
---

Apache Kafka has become the backbone of modern data streaming architectures, processing trillions of messages daily at companies worldwide. While setting up a basic Kafka cluster is straightforward, operating it efficiently at scale requires deep understanding of its internals, careful tuning, and proactive management. This comprehensive guide explores advanced Kafka operations, from optimizing topic partitioning to implementing exactly-once semantics in production environments.

<!--more-->

# Apache Kafka Operations: Topic Management and Consumer Optimization

## Kafka Architecture Deep Dive

Understanding Kafka's architecture is crucial for effective operations. Unlike traditional message queues, Kafka's distributed log architecture provides unique advantages but also presents operational challenges that require careful consideration.

### Core Components and Their Interactions

Kafka's architecture consists of several interconnected components that work together to provide high-throughput, fault-tolerant messaging:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Producer   │     │   Producer   │     │   Producer   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┴────────────────────┘
                           │
                    ┌──────▼───────┐
                    │  Load Balancer│
                    └──────┬───────┘
                           │
       ┌───────────────────┴─────────────────────┐
       │                                         │
┌──────▼──────┐  ┌──────────────┐  ┌────────────▼─┐
│   Broker 1  │  │   Broker 2   │  │   Broker 3   │
│             │  │              │  │              │
│  Partition  │  │  Partition   │  │  Partition   │
│  Leaders    │  │  Leaders     │  │  Leaders     │
│  Replicas   │  │  Replicas    │  │  Replicas    │
└─────────────┘  └──────────────┘  └──────────────┘
       │                │                  │
       └────────────────┴──────────────────┘
                        │
              ┌─────────▼──────────┐
              │    ZooKeeper       │
              │   Ensemble         │
              └────────────────────┘
```

### Broker Architecture and Storage

Each Kafka broker manages multiple partitions, storing messages in segment files on disk. Understanding the storage architecture is essential for performance tuning:

```java
// Kafka storage structure
/kafka-logs/
├── topic1-0/
│   ├── 00000000000000000000.index
│   ├── 00000000000000000000.log
│   ├── 00000000000000000000.timeindex
│   ├── 00000000000000001024.index
│   ├── 00000000000000001024.log
│   └── 00000000000000001024.timeindex
├── topic1-1/
└── topic2-0/
```

Each partition directory contains:
- **Log segments**: Actual message data stored sequentially
- **Index files**: Offset to file position mappings for quick lookups
- **Time index files**: Timestamp to offset mappings for time-based queries

### Controller and Metadata Management

The Kafka controller is a critical component responsible for administrative operations:

```bash
# Check current controller
kafka-broker-api-versions.sh --bootstrap-server localhost:9092 | grep controller

# View controller logs
tail -f /var/log/kafka/controller.log | grep -E "Broker|Partition|Leader"
```

Controller responsibilities include:
1. **Partition Leader Election**: Selecting leaders for partitions during broker failures
2. **Replica Management**: Ensuring proper replication factor maintenance
3. **Topic Creation/Deletion**: Coordinating topic lifecycle operations
4. **Broker Registration**: Managing broker membership in the cluster

## Topic Partitioning Strategies

Effective partitioning is fundamental to Kafka performance and scalability. Poor partitioning choices can lead to hot partitions, consumer lag, and underutilized resources.

### Calculating Optimal Partition Count

The optimal partition count depends on multiple factors:

```python
def calculate_optimal_partitions(
    target_throughput_mb_s,
    producer_throughput_mb_s,
    consumer_throughput_mb_s,
    replication_factor,
    retention_hours,
    broker_count
):
    """
    Calculate optimal partition count based on throughput requirements
    """
    # Partition count based on producer throughput
    producer_partitions = math.ceil(
        target_throughput_mb_s / producer_throughput_mb_s
    )
    
    # Partition count based on consumer throughput
    consumer_partitions = math.ceil(
        target_throughput_mb_s / consumer_throughput_mb_s
    )
    
    # Consider replication overhead
    replication_overhead = replication_factor - 1
    network_partitions = math.ceil(
        (target_throughput_mb_s * replication_overhead) / 
        (broker_count * 1000)  # Assuming 1Gbps network per broker
    )
    
    # Use the maximum to ensure all constraints are met
    optimal_partitions = max(
        producer_partitions,
        consumer_partitions,
        network_partitions,
        broker_count  # At least one partition per broker
    )
    
    # Round up to nearest multiple of broker count for even distribution
    return math.ceil(optimal_partitions / broker_count) * broker_count

# Example calculation
partitions = calculate_optimal_partitions(
    target_throughput_mb_s=500,
    producer_throughput_mb_s=50,
    consumer_throughput_mb_s=80,
    replication_factor=3,
    retention_hours=168,
    broker_count=6
)
print(f"Recommended partitions: {partitions}")
```

### Custom Partitioner Implementation

For specialized use cases, implementing a custom partitioner ensures optimal data distribution:

```java
import org.apache.kafka.clients.producer.Partitioner;
import org.apache.kafka.common.Cluster;
import org.apache.kafka.common.PartitionInfo;
import java.util.Map;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

public class WeightedRoundRobinPartitioner implements Partitioner {
    private final ConcurrentHashMap<String, AtomicInteger> topicCounters = new ConcurrentHashMap<>();
    private final Map<Integer, Double> partitionWeights = new ConcurrentHashMap<>();
    
    @Override
    public void configure(Map<String, ?> configs) {
        // Parse partition weights from configuration
        String weights = (String) configs.get("partition.weights");
        if (weights != null) {
            for (String weight : weights.split(",")) {
                String[] parts = weight.split(":");
                partitionWeights.put(
                    Integer.parseInt(parts[0]), 
                    Double.parseDouble(parts[1])
                );
            }
        }
    }
    
    @Override
    public int partition(String topic, Object key, byte[] keyBytes, 
                        Object value, byte[] valueBytes, Cluster cluster) {
        List<PartitionInfo> partitions = cluster.partitionsForTopic(topic);
        int numPartitions = partitions.size();
        
        if (keyBytes != null) {
            // Use key-based partitioning for ordered messages
            return Utils.toPositive(Utils.murmur2(keyBytes)) % numPartitions;
        }
        
        // Weighted round-robin for keyless messages
        AtomicInteger counter = topicCounters.computeIfAbsent(
            topic, k -> new AtomicInteger(0)
        );
        
        int currentCount = counter.getAndIncrement();
        return selectWeightedPartition(currentCount, numPartitions);
    }
    
    private int selectWeightedPartition(int counter, int numPartitions) {
        double totalWeight = 0;
        for (int i = 0; i < numPartitions; i++) {
            totalWeight += partitionWeights.getOrDefault(i, 1.0);
        }
        
        double random = (counter % 100) / 100.0 * totalWeight;
        double weightSum = 0;
        
        for (int i = 0; i < numPartitions; i++) {
            weightSum += partitionWeights.getOrDefault(i, 1.0);
            if (random < weightSum) {
                return i;
            }
        }
        
        return numPartitions - 1;
    }
    
    @Override
    public void close() {
        topicCounters.clear();
        partitionWeights.clear();
    }
}
```

### Dynamic Partition Management

Production environments often require dynamic partition management to handle changing workloads:

```bash
#!/bin/bash
# Dynamic partition rebalancing script

KAFKA_HOME="/opt/kafka"
BOOTSTRAP_SERVER="localhost:9092"
TOPIC="high-volume-events"

# Function to get current partition count
get_partition_count() {
    $KAFKA_HOME/bin/kafka-topics.sh \
        --bootstrap-server $BOOTSTRAP_SERVER \
        --describe --topic $TOPIC \
        | grep "PartitionCount" \
        | awk '{print $2}'
}

# Function to calculate consumer lag
get_total_lag() {
    $KAFKA_HOME/bin/kafka-consumer-groups.sh \
        --bootstrap-server $BOOTSTRAP_SERVER \
        --group my-consumer-group \
        --describe 2>/dev/null \
        | grep $TOPIC \
        | awk '{sum += $5} END {print sum}'
}

# Function to add partitions
add_partitions() {
    local new_count=$1
    echo "Increasing partition count to $new_count"
    
    $KAFKA_HOME/bin/kafka-topics.sh \
        --bootstrap-server $BOOTSTRAP_SERVER \
        --alter --topic $TOPIC \
        --partitions $new_count
}

# Monitor and scale logic
monitor_and_scale() {
    local current_partitions=$(get_partition_count)
    local lag=$(get_total_lag)
    local lag_threshold=1000000  # 1M messages
    
    echo "Current partitions: $current_partitions, Lag: $lag"
    
    if [ "$lag" -gt "$lag_threshold" ]; then
        local new_partitions=$((current_partitions * 2))
        add_partitions $new_partitions
        
        # Trigger consumer rebalance
        echo "Partitions increased. Triggering consumer rebalance..."
        # Send SIGTERM to consumer processes to force rebalance
    fi
}

# Run monitoring loop
while true; do
    monitor_and_scale
    sleep 300  # Check every 5 minutes
done
```

## Consumer Group Management

Efficient consumer group management is crucial for maintaining high throughput and preventing message loss or duplication.

### Advanced Consumer Configuration

Optimize consumer performance with carefully tuned configurations:

```java
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import java.util.Properties;

public class OptimizedConsumerConfig {
    
    public static KafkaConsumer<String, String> createOptimizedConsumer(
            String bootstrapServers, String groupId) {
        Properties props = new Properties();
        
        // Basic configuration
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, groupId);
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  StringDeserializer.class.getName());
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  StringDeserializer.class.getName());
        
        // Performance optimizations
        props.put(ConsumerConfig.FETCH_MIN_BYTES_CONFIG, 50000); // 50KB
        props.put(ConsumerConfig.FETCH_MAX_WAIT_MS_CONFIG, 500);
        props.put(ConsumerConfig.MAX_PARTITION_FETCH_BYTES_CONFIG, 1048576); // 1MB
        
        // Increase session timeout for stability
        props.put(ConsumerConfig.SESSION_TIMEOUT_MS_CONFIG, 30000);
        props.put(ConsumerConfig.HEARTBEAT_INTERVAL_MS_CONFIG, 3000);
        
        // Optimize for throughput
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 1000);
        props.put(ConsumerConfig.MAX_POLL_INTERVAL_MS_CONFIG, 300000); // 5 minutes
        
        // Enable auto commit with optimized interval
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, true);
        props.put(ConsumerConfig.AUTO_COMMIT_INTERVAL_MS_CONFIG, 5000);
        
        // Partition assignment strategy
        props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
                  "org.apache.kafka.clients.consumer.RoundRobinAssignor");
        
        return new KafkaConsumer<>(props);
    }
    
    public static KafkaConsumer<String, String> createExactlyOnceConsumer(
            String bootstrapServers, String groupId) {
        Properties props = new Properties();
        
        // Basic configuration
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, groupId);
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, 
                  StringDeserializer.class.getName());
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, 
                  StringDeserializer.class.getName());
        
        // Exactly-once semantics configuration
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        props.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");
        
        // Idempotent consumer settings
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, 100); // Smaller batches
        
        return new KafkaConsumer<>(props);
    }
}
```

### Consumer Lag Monitoring and Alerting

Implement comprehensive lag monitoring to detect and respond to processing bottlenecks:

```python
import requests
import json
from datetime import datetime
from prometheus_client import Gauge, push_to_gateway
import logging

# Prometheus metrics
consumer_lag_gauge = Gauge(
    'kafka_consumer_lag_messages',
    'Consumer lag in number of messages',
    ['topic', 'partition', 'consumer_group']
)

consumer_lag_seconds_gauge = Gauge(
    'kafka_consumer_lag_seconds',
    'Consumer lag in seconds',
    ['topic', 'partition', 'consumer_group']
)

class KafkaLagMonitor:
    def __init__(self, kafka_manager_url, prometheus_gateway):
        self.kafka_manager_url = kafka_manager_url
        self.prometheus_gateway = prometheus_gateway
        self.logger = logging.getLogger(__name__)
        
    def get_consumer_groups(self):
        """Fetch all consumer groups from Kafka Manager"""
        response = requests.get(f"{self.kafka_manager_url}/api/consumer-groups")
        return response.json()
    
    def calculate_time_lag(self, current_offset, latest_offset, 
                          messages_per_second):
        """Calculate lag in seconds based on message rate"""
        message_lag = latest_offset - current_offset
        if messages_per_second > 0:
            return message_lag / messages_per_second
        return 0
    
    def monitor_consumer_lag(self):
        """Monitor lag for all consumer groups"""
        for group in self.get_consumer_groups():
            group_details = requests.get(
                f"{self.kafka_manager_url}/api/consumer-groups/{group['id']}"
            ).json()
            
            for topic_partition in group_details['partitions']:
                topic = topic_partition['topic']
                partition = topic_partition['partition']
                current_offset = topic_partition['currentOffset']
                log_end_offset = topic_partition['logEndOffset']
                lag = log_end_offset - current_offset
                
                # Update Prometheus metrics
                consumer_lag_gauge.labels(
                    topic=topic,
                    partition=partition,
                    consumer_group=group['id']
                ).set(lag)
                
                # Calculate time-based lag
                message_rate = self.get_message_rate(topic, partition)
                time_lag = self.calculate_time_lag(
                    current_offset, log_end_offset, message_rate
                )
                
                consumer_lag_seconds_gauge.labels(
                    topic=topic,
                    partition=partition,
                    consumer_group=group['id']
                ).set(time_lag)
                
                # Alert on high lag
                if lag > 100000 or time_lag > 300:  # 100k messages or 5 minutes
                    self.send_alert(group['id'], topic, partition, lag, time_lag)
        
        # Push metrics to Prometheus
        push_to_gateway(
            self.prometheus_gateway, 
            job='kafka_lag_monitor',
            registry=None
        )
    
    def get_message_rate(self, topic, partition):
        """Calculate message production rate for a topic partition"""
        # Implementation depends on your metrics system
        # This is a simplified example
        response = requests.get(
            f"{self.kafka_manager_url}/api/topics/{topic}/metrics"
        )
        metrics = response.json()
        return metrics.get('messagesPerSecond', {}).get(str(partition), 0)
    
    def send_alert(self, group, topic, partition, lag, time_lag):
        """Send alert for high consumer lag"""
        alert_data = {
            'severity': 'warning' if lag < 500000 else 'critical',
            'summary': f'High consumer lag detected for {group}',
            'description': (
                f'Consumer group {group} has {lag} messages '
                f'({time_lag:.1f} seconds) lag on {topic}-{partition}'
            ),
            'labels': {
                'consumer_group': group,
                'topic': topic,
                'partition': str(partition),
                'lag_messages': str(lag),
                'lag_seconds': str(time_lag)
            }
        }
        
        # Send to alerting system (e.g., AlertManager)
        requests.post(
            'http://alertmanager:9093/api/v1/alerts',
            json=[alert_data]
        )
        
        self.logger.warning(
            f"Alert sent: {alert_data['description']}"
        )

# Usage
if __name__ == "__main__":
    monitor = KafkaLagMonitor(
        kafka_manager_url="http://kafka-manager:9000",
        prometheus_gateway="prometheus-pushgateway:9091"
    )
    
    # Run monitoring every 30 seconds
    import time
    while True:
        monitor.monitor_consumer_lag()
        time.sleep(30)
```

### Consumer Rebalancing Strategies

Minimize the impact of consumer rebalancing with advanced strategies:

```java
import org.apache.kafka.clients.consumer.*;
import org.apache.kafka.common.TopicPartition;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

public class StickyAssignmentConsumer {
    private final KafkaConsumer<String, String> consumer;
    private final Map<TopicPartition, Long> partitionOwnership = new ConcurrentHashMap<>();
    private volatile boolean rebalancing = false;
    
    public StickyAssignmentConsumer(Properties props) {
        // Configure for sticky assignment
        props.put(ConsumerConfig.PARTITION_ASSIGNMENT_STRATEGY_CONFIG,
                  "org.apache.kafka.clients.consumer.StickyAssignor");
        
        this.consumer = new KafkaConsumer<>(props);
    }
    
    public void subscribe(List<String> topics) {
        consumer.subscribe(topics, new ConsumerRebalanceListener() {
            @Override
            public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
                rebalancing = true;
                System.out.println("Rebalancing started. Committing offsets...");
                
                // Commit current offsets before rebalancing
                commitOffsetsForPartitions(partitions);
                
                // Save state for sticky reassignment
                savePartitionState(partitions);
            }
            
            @Override
            public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
                System.out.println("Partitions assigned: " + partitions);
                
                // Restore processing state for retained partitions
                restorePartitionState(partitions);
                
                rebalancing = false;
            }
            
            @Override
            public void onPartitionsLost(Collection<TopicPartition> partitions) {
                System.out.println("Partitions lost: " + partitions);
                // Handle partition loss (e.g., during broker failure)
                partitions.forEach(partitionOwnership::remove);
            }
        });
    }
    
    private void commitOffsetsForPartitions(Collection<TopicPartition> partitions) {
        Map<TopicPartition, OffsetAndMetadata> offsetsToCommit = new HashMap<>();
        
        for (TopicPartition partition : partitions) {
            long position = consumer.position(partition);
            offsetsToCommit.put(
                partition, 
                new OffsetAndMetadata(position, "Pre-rebalance commit")
            );
        }
        
        try {
            consumer.commitSync(offsetsToCommit);
            System.out.println("Successfully committed offsets for " + 
                             partitions.size() + " partitions");
        } catch (CommitFailedException e) {
            System.err.println("Failed to commit offsets: " + e.getMessage());
        }
    }
    
    private void savePartitionState(Collection<TopicPartition> partitions) {
        for (TopicPartition partition : partitions) {
            // Save any partition-specific state
            partitionOwnership.put(partition, System.currentTimeMillis());
        }
    }
    
    private void restorePartitionState(Collection<TopicPartition> partitions) {
        for (TopicPartition partition : partitions) {
            if (partitionOwnership.containsKey(partition)) {
                // Partition was previously owned - restore state
                System.out.println("Restored ownership of partition: " + partition);
            } else {
                // New partition assignment
                System.out.println("Newly assigned partition: " + partition);
                partitionOwnership.put(partition, System.currentTimeMillis());
            }
        }
    }
    
    public void processMessages() {
        while (true) {
            ConsumerRecords<String, String> records = consumer.poll(
                Duration.ofMillis(100)
            );
            
            if (rebalancing) {
                // Skip processing during rebalance
                continue;
            }
            
            for (ConsumerRecord<String, String> record : records) {
                processRecord(record);
            }
            
            // Commit offsets after processing
            consumer.commitAsync((offsets, exception) -> {
                if (exception != null) {
                    System.err.println("Commit failed: " + exception.getMessage());
                }
            });
        }
    }
    
    private void processRecord(ConsumerRecord<String, String> record) {
        // Process the record
        System.out.printf(
            "Processed: topic=%s, partition=%d, offset=%d, value=%s%n",
            record.topic(), record.partition(), record.offset(), record.value()
        );
    }
}
```

## Performance Tuning and Monitoring

Optimizing Kafka performance requires understanding and tuning multiple layers of the stack, from JVM settings to OS kernel parameters.

### JVM Tuning for Kafka Brokers

Kafka brokers run on the JVM, making JVM tuning critical for performance:

```bash
# Optimized JVM settings for Kafka brokers
export KAFKA_HEAP_OPTS="-Xmx6g -Xms6g"
export KAFKA_JVM_PERFORMANCE_OPTS="-server \
    -XX:+UseG1GC \
    -XX:MaxGCPauseMillis=20 \
    -XX:InitiatingHeapOccupancyPercent=35 \
    -XX:+ExplicitGCInvokesConcurrent \
    -XX:+AlwaysPreTouch \
    -XX:+UnlockExperimentalVMOptions \
    -XX:+UseStringDeduplication \
    -XX:+ParallelRefProcEnabled \
    -XX:+DisableExplicitGC \
    -Djava.awt.headless=true"

# GC logging for monitoring
export KAFKA_GC_LOG_OPTS="-Xloggc:/var/log/kafka/gc.log \
    -XX:+PrintGCDetails \
    -XX:+PrintGCTimeStamps \
    -XX:+PrintGCDateStamps \
    -XX:+UseGCLogFileRotation \
    -XX:NumberOfGCLogFiles=10 \
    -XX:GCLogFileSize=100M"

# Additional optimizations
export KAFKA_OPTS="-Djava.net.preferIPv4Stack=true \
    -Djava.security.auth.login.config=/etc/kafka/kafka_jaas.conf \
    -Dcom.sun.management.jmxremote \
    -Dcom.sun.management.jmxremote.authenticate=false \
    -Dcom.sun.management.jmxremote.ssl=false \
    -Dcom.sun.management.jmxremote.port=9999"
```

### OS-Level Optimizations

Operating system tuning significantly impacts Kafka performance:

```bash
#!/bin/bash
# OS tuning script for Kafka nodes

# Increase file descriptor limits
cat >> /etc/security/limits.conf << EOF
* soft nofile 128000
* hard nofile 128000
* soft nproc 128000
* hard nproc 128000
EOF

# Optimize kernel parameters
cat >> /etc/sysctl.conf << EOF
# Network optimizations
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 134217728
net.ipv4.tcp_wmem = 4096 65536 134217728
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_slow_start_after_idle = 0

# Virtual memory optimizations
vm.swappiness = 1
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
vm.max_map_count = 262144

# File system optimizations
fs.file-max = 1000000
EOF

# Apply settings
sysctl -p

# Disable transparent huge pages
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Set up dedicated disk for Kafka logs
# Format with XFS for better performance
mkfs.xfs -f /dev/nvme1n1
mkdir -p /kafka-logs
mount -o noatime,nodiratime,nobarrier /dev/nvme1n1 /kafka-logs

# Add to fstab for persistence
echo "/dev/nvme1n1 /kafka-logs xfs noatime,nodiratime,nobarrier 0 0" >> /etc/fstab

# Set appropriate permissions
chown -R kafka:kafka /kafka-logs
```

### Comprehensive Performance Monitoring

Implement detailed monitoring to identify bottlenecks and optimize performance:

```python
import psutil
import requests
from kafka import KafkaAdminClient
from kafka.admin import ConfigResource, ConfigResourceType
import json
import time
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

class KafkaPerformanceMonitor:
    def __init__(self, bootstrap_servers, prometheus_gateway):
        self.admin_client = KafkaAdminClient(
            bootstrap_servers=bootstrap_servers,
            client_id='performance_monitor'
        )
        self.prometheus_gateway = prometheus_gateway
        self.registry = CollectorRegistry()
        self.setup_metrics()
        
    def setup_metrics(self):
        """Initialize Prometheus metrics"""
        self.broker_metrics = {
            'cpu_usage': Gauge(
                'kafka_broker_cpu_usage_percent',
                'CPU usage percentage',
                ['broker_id'],
                registry=self.registry
            ),
            'memory_usage': Gauge(
                'kafka_broker_memory_usage_bytes',
                'Memory usage in bytes',
                ['broker_id'],
                registry=self.registry
            ),
            'disk_usage': Gauge(
                'kafka_broker_disk_usage_percent',
                'Disk usage percentage',
                ['broker_id'],
                registry=self.registry
            ),
            'network_in': Gauge(
                'kafka_broker_network_in_bytes_per_sec',
                'Network input bytes per second',
                ['broker_id'],
                registry=self.registry
            ),
            'network_out': Gauge(
                'kafka_broker_network_out_bytes_per_sec',
                'Network output bytes per second',
                ['broker_id'],
                registry=self.registry
            ),
            'isr_shrinks': Gauge(
                'kafka_broker_isr_shrinks_per_sec',
                'ISR shrinks per second',
                ['broker_id'],
                registry=self.registry
            ),
            'request_latency': Gauge(
                'kafka_broker_request_latency_ms',
                'Request latency in milliseconds',
                ['broker_id', 'request_type'],
                registry=self.registry
            )
        }
        
    def collect_jmx_metrics(self, broker_id, jmx_port=9999):
        """Collect metrics from Kafka JMX"""
        jmx_queries = {
            'MessagesInPerSec': 'kafka.server:type=BrokerTopicMetrics,name=MessagesInPerSec',
            'BytesInPerSec': 'kafka.server:type=BrokerTopicMetrics,name=BytesInPerSec',
            'BytesOutPerSec': 'kafka.server:type=BrokerTopicMetrics,name=BytesOutPerSec',
            'RequestsPerSec': 'kafka.network:type=RequestMetrics,name=RequestsPerSec,request=*',
            'UnderReplicatedPartitions': 'kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions',
            'IsrShrinksPerSec': 'kafka.server:type=ReplicaManager,name=IsrShrinksPerSec',
            'LeaderElectionRateAndTime': 'kafka.controller:type=ControllerStats,name=LeaderElectionRateAndTimeMs'
        }
        
        metrics = {}
        for metric_name, mbean in jmx_queries.items():
            try:
                # Use JMX REST proxy or Jolokia
                response = requests.get(
                    f'http://broker-{broker_id}:{jmx_port}/jolokia/read/{mbean}'
                )
                data = response.json()
                metrics[metric_name] = data['value']
            except Exception as e:
                print(f"Failed to collect {metric_name}: {e}")
                
        return metrics
    
    def collect_system_metrics(self, broker_id):
        """Collect system-level metrics"""
        # CPU usage
        cpu_percent = psutil.cpu_percent(interval=1)
        self.broker_metrics['cpu_usage'].labels(
            broker_id=broker_id
        ).set(cpu_percent)
        
        # Memory usage
        memory = psutil.virtual_memory()
        self.broker_metrics['memory_usage'].labels(
            broker_id=broker_id
        ).set(memory.used)
        
        # Disk usage
        disk = psutil.disk_usage('/kafka-logs')
        self.broker_metrics['disk_usage'].labels(
            broker_id=broker_id
        ).set(disk.percent)
        
        # Network I/O
        net_io = psutil.net_io_counters()
        self.broker_metrics['network_in'].labels(
            broker_id=broker_id
        ).set(net_io.bytes_recv)
        self.broker_metrics['network_out'].labels(
            broker_id=broker_id
        ).set(net_io.bytes_sent)
    
    def analyze_performance(self):
        """Analyze performance and provide recommendations"""
        recommendations = []
        
        # Check CPU usage
        cpu_usage = psutil.cpu_percent(interval=1)
        if cpu_usage > 80:
            recommendations.append({
                'severity': 'warning',
                'issue': 'High CPU usage',
                'recommendation': 'Consider scaling horizontally or optimizing batch sizes'
            })
        
        # Check memory pressure
        memory = psutil.virtual_memory()
        if memory.percent > 85:
            recommendations.append({
                'severity': 'warning',
                'issue': 'High memory usage',
                'recommendation': 'Increase heap size or add more brokers'
            })
        
        # Check disk I/O
        disk_io = psutil.disk_io_counters()
        if disk_io.write_bytes > 100 * 1024 * 1024:  # 100MB/s
            recommendations.append({
                'severity': 'info',
                'issue': 'High disk write rate',
                'recommendation': 'Consider using faster SSDs or increasing log segment size'
            })
        
        return recommendations
    
    def run_monitoring_loop(self):
        """Main monitoring loop"""
        while True:
            try:
                # Get broker list
                cluster_metadata = self.admin_client.describe_cluster()
                
                for broker in cluster_metadata['brokers']:
                    broker_id = broker['node_id']
                    
                    # Collect system metrics
                    self.collect_system_metrics(broker_id)
                    
                    # Collect JMX metrics
                    jmx_metrics = self.collect_jmx_metrics(broker_id)
                    
                    # Update Prometheus metrics
                    if 'IsrShrinksPerSec' in jmx_metrics:
                        self.broker_metrics['isr_shrinks'].labels(
                            broker_id=broker_id
                        ).set(jmx_metrics['IsrShrinksPerSec']['Count'])
                
                # Push to Prometheus
                push_to_gateway(
                    self.prometheus_gateway,
                    job='kafka_performance_monitor',
                    registry=self.registry
                )
                
                # Analyze and log recommendations
                recommendations = self.analyze_performance()
                for rec in recommendations:
                    print(f"[{rec['severity']}] {rec['issue']}: {rec['recommendation']}")
                
            except Exception as e:
                print(f"Monitoring error: {e}")
            
            time.sleep(30)  # Collect metrics every 30 seconds

# Usage
if __name__ == "__main__":
    monitor = KafkaPerformanceMonitor(
        bootstrap_servers='localhost:9092',
        prometheus_gateway='prometheus-pushgateway:9091'
    )
    monitor.run_monitoring_loop()
```

## Exactly-Once Semantics Implementation

Implementing exactly-once semantics (EOS) in Kafka requires careful coordination between producers, brokers, and consumers.

### Producer Configuration for EOS

Configure producers for idempotent and transactional message delivery:

```java
import org.apache.kafka.clients.producer.*;
import org.apache.kafka.common.KafkaException;
import org.apache.kafka.common.errors.ProducerFencedException;
import java.util.Properties;
import java.util.UUID;

public class ExactlyOnceProducer {
    private final KafkaProducer<String, String> producer;
    private final String transactionalId;
    
    public ExactlyOnceProducer(String bootstrapServers) {
        this.transactionalId = "eos-producer-" + UUID.randomUUID();
        
        Properties props = new Properties();
        props.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG,
                  "org.apache.kafka.common.serialization.StringSerializer");
        props.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG,
                  "org.apache.kafka.common.serialization.StringSerializer");
        
        // Enable idempotence
        props.put(ProducerConfig.ENABLE_IDEMPOTENCE_CONFIG, true);
        
        // Configure for exactly-once semantics
        props.put(ProducerConfig.TRANSACTIONAL_ID_CONFIG, transactionalId);
        props.put(ProducerConfig.TRANSACTION_TIMEOUT_CONFIG, 60000); // 1 minute
        
        // Reliability settings
        props.put(ProducerConfig.ACKS_CONFIG, "all");
        props.put(ProducerConfig.RETRIES_CONFIG, Integer.MAX_VALUE);
        props.put(ProducerConfig.MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION, 5);
        
        // Performance optimizations
        props.put(ProducerConfig.COMPRESSION_TYPE_CONFIG, "lz4");
        props.put(ProducerConfig.BATCH_SIZE_CONFIG, 32768); // 32KB
        props.put(ProducerConfig.LINGER_MS_CONFIG, 20);
        props.put(ProducerConfig.BUFFER_MEMORY_CONFIG, 67108864); // 64MB
        
        this.producer = new KafkaProducer<>(props);
        
        // Initialize transactions
        producer.initTransactions();
    }
    
    public void sendTransactionalBatch(List<ProducerRecord<String, String>> records) {
        try {
            // Begin transaction
            producer.beginTransaction();
            
            // Send all records in the transaction
            List<Future<RecordMetadata>> futures = new ArrayList<>();
            for (ProducerRecord<String, String> record : records) {
                futures.add(producer.send(record));
            }
            
            // Wait for all sends to complete
            for (Future<RecordMetadata> future : futures) {
                RecordMetadata metadata = future.get();
                System.out.printf(
                    "Sent record to topic=%s partition=%d offset=%d%n",
                    metadata.topic(), metadata.partition(), metadata.offset()
                );
            }
            
            // Commit the transaction
            producer.commitTransaction();
            System.out.println("Transaction committed successfully");
            
        } catch (ProducerFencedException e) {
            // Another instance with the same transactional.id has been started
            System.err.println("Producer fenced, shutting down: " + e.getMessage());
            producer.close();
            throw e;
        } catch (KafkaException e) {
            // Abort the transaction on any error
            System.err.println("Transaction failed: " + e.getMessage());
            producer.abortTransaction();
            throw e;
        }
    }
    
    public void processAndForward(
            String inputTopic, 
            String outputTopic,
            MessageProcessor processor) {
        // Consumer for reading input
        KafkaConsumer<String, String> consumer = createTransactionalConsumer();
        consumer.subscribe(Collections.singletonList(inputTopic));
        
        while (true) {
            ConsumerRecords<String, String> records = consumer.poll(
                Duration.ofMillis(100)
            );
            
            if (!records.isEmpty()) {
                try {
                    // Begin transaction
                    producer.beginTransaction();
                    
                    // Process records and produce results
                    for (ConsumerRecord<String, String> record : records) {
                        String result = processor.process(record.value());
                        
                        producer.send(new ProducerRecord<>(
                            outputTopic,
                            record.key(),
                            result
                        ));
                    }
                    
                    // Send consumer offsets as part of transaction
                    Map<TopicPartition, OffsetAndMetadata> offsets = new HashMap<>();
                    for (TopicPartition partition : records.partitions()) {
                        List<ConsumerRecord<String, String>> partitionRecords = 
                            records.records(partition);
                        long lastOffset = partitionRecords
                            .get(partitionRecords.size() - 1)
                            .offset();
                        offsets.put(
                            partition, 
                            new OffsetAndMetadata(lastOffset + 1)
                        );
                    }
                    
                    // Commit offsets and transaction atomically
                    producer.sendOffsetsToTransaction(
                        offsets, 
                        consumer.groupMetadata()
                    );
                    producer.commitTransaction();
                    
                } catch (KafkaException e) {
                    System.err.println("Processing failed: " + e.getMessage());
                    producer.abortTransaction();
                    
                    // Reset consumer to last committed offset
                    consumer.seekToCommitted(records.partitions());
                }
            }
        }
    }
    
    private KafkaConsumer<String, String> createTransactionalConsumer() {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "eos-consumer-group");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG,
                  "org.apache.kafka.common.serialization.StringDeserializer");
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG,
                  "org.apache.kafka.common.serialization.StringDeserializer");
        
        // Read only committed messages
        props.put(ConsumerConfig.ISOLATION_LEVEL_CONFIG, "read_committed");
        props.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, false);
        
        return new KafkaConsumer<>(props);
    }
    
    public void close() {
        producer.close();
    }
    
    // Message processor interface
    public interface MessageProcessor {
        String process(String message);
    }
}
```

### Implementing Exactly-Once Stream Processing

Build reliable stream processing applications with exactly-once guarantees:

```java
import org.apache.kafka.streams.KafkaStreams;
import org.apache.kafka.streams.StreamsBuilder;
import org.apache.kafka.streams.StreamsConfig;
import org.apache.kafka.streams.kstream.*;
import org.apache.kafka.streams.processor.StateStore;
import org.apache.kafka.streams.state.KeyValueStore;
import org.apache.kafka.streams.state.Stores;
import java.util.Properties;

public class ExactlyOnceStreamProcessor {
    
    public static void main(String[] args) {
        Properties props = new Properties();
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "eos-stream-processor");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        
        // Enable exactly-once processing
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, 
                  StreamsConfig.EXACTLY_ONCE_V2);
        
        // Configure state stores
        props.put(StreamsConfig.STATE_DIR_CONFIG, "/var/kafka-streams");
        props.put(StreamsConfig.REPLICATION_FACTOR_CONFIG, 3);
        props.put(StreamsConfig.NUM_STANDBY_REPLICAS_CONFIG, 1);
        
        // Performance settings
        props.put(StreamsConfig.CACHE_MAX_BYTES_BUFFERING_CONFIG, 104857600); // 100MB
        props.put(StreamsConfig.COMMIT_INTERVAL_MS_CONFIG, 100);
        
        StreamsBuilder builder = new StreamsBuilder();
        
        // Define processing topology
        KStream<String, String> input = builder.stream("input-topic");
        
        // Stateful deduplication
        input
            .groupByKey()
            .aggregate(
                () -> new DedupState(),
                (key, value, state) -> state.process(value),
                Materialized.<String, DedupState>as(
                    Stores.persistentKeyValueStore("dedup-store")
                )
                .withValueSerde(new DedupStateSerde())
            )
            .toStream()
            .flatMapValues(state -> state.getUniqueValues())
            .to("output-topic");
        
        // Add exactly-once windowed aggregation
        input
            .groupByKey()
            .windowedBy(TimeWindows.of(Duration.ofMinutes(5)))
            .count(Materialized.as("windowed-counts"))
            .toStream()
            .map((windowedKey, count) -> KeyValue.pair(
                windowedKey.key(),
                String.format("%s:%d", windowedKey.window(), count)
            ))
            .to("aggregated-output");
        
        KafkaStreams streams = new KafkaStreams(builder.build(), props);
        
        // Handle graceful shutdown
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("Shutting down stream processor...");
            streams.close(Duration.ofSeconds(30));
        }));
        
        // Start processing
        streams.start();
    }
    
    // State class for deduplication
    static class DedupState {
        private final Set<String> seenIds = new HashSet<>();
        private final List<String> uniqueValues = new ArrayList<>();
        private static final int MAX_SIZE = 10000;
        
        public DedupState process(String value) {
            // Extract ID from value (customize based on your data)
            String id = extractId(value);
            
            if (!seenIds.contains(id)) {
                seenIds.add(id);
                uniqueValues.add(value);
                
                // Implement circular buffer to limit memory usage
                if (seenIds.size() > MAX_SIZE) {
                    String oldest = uniqueValues.remove(0);
                    seenIds.remove(extractId(oldest));
                }
            }
            
            return this;
        }
        
        public List<String> getUniqueValues() {
            List<String> result = new ArrayList<>(uniqueValues);
            uniqueValues.clear();
            return result;
        }
        
        private String extractId(String value) {
            // Implement based on your message format
            return value.split(":")[0];
        }
    }
}
```

## Production Troubleshooting Guide

When issues arise in production, having a systematic troubleshooting approach is essential.

### Common Issues and Solutions

#### 1. Consumer Lag Increasing

```bash
#!/bin/bash
# Diagnose consumer lag issues

BOOTSTRAP_SERVER="localhost:9092"
CONSUMER_GROUP="my-consumer-group"

# Check consumer lag
echo "=== Consumer Lag Analysis ==="
kafka-consumer-groups.sh \
    --bootstrap-server $BOOTSTRAP_SERVER \
    --group $CONSUMER_GROUP \
    --describe

# Check consumer performance
echo -e "\n=== Consumer Performance Metrics ==="
kafka-run-class.sh kafka.tools.ConsumerPerformance \
    --broker-list $BOOTSTRAP_SERVER \
    --topic my-topic \
    --messages 100000 \
    --threads 1 \
    --consumer.config /etc/kafka/consumer.properties

# Analyze partition distribution
echo -e "\n=== Partition Assignment ==="
kafka-consumer-groups.sh \
    --bootstrap-server $BOOTSTRAP_SERVER \
    --group $CONSUMER_GROUP \
    --describe \
    --members --verbose

# Check for rebalancing issues
echo -e "\n=== Recent Rebalances ==="
grep -i "rebalance" /var/log/kafka/consumer.log | tail -20

# Investigate slow partitions
echo -e "\n=== Slow Partition Detection ==="
kafka-consumer-groups.sh \
    --bootstrap-server $BOOTSTRAP_SERVER \
    --group $CONSUMER_GROUP \
    --describe 2>/dev/null | \
    awk 'NR>2 {print $1, $2, $5}' | \
    sort -k3 -nr | \
    head -10
```

#### 2. Broker Performance Degradation

```python
import subprocess
import json
import statistics
from datetime import datetime, timedelta

class KafkaBrokerDiagnostics:
    def __init__(self, broker_list):
        self.broker_list = broker_list
        
    def check_broker_health(self):
        """Comprehensive broker health check"""
        results = {}
        
        for broker in self.broker_list:
            print(f"\nDiagnosing broker {broker}...")
            results[broker] = {
                'jvm_metrics': self.check_jvm_health(broker),
                'disk_metrics': self.check_disk_health(broker),
                'network_metrics': self.check_network_health(broker),
                'replication_metrics': self.check_replication_health(broker),
                'recommendations': []
            }
            
            # Generate recommendations based on metrics
            self.generate_recommendations(results[broker])
            
        return results
    
    def check_jvm_health(self, broker):
        """Check JVM metrics and garbage collection"""
        metrics = {}
        
        # Parse GC logs
        gc_log_path = f"/var/log/kafka/{broker}/gc.log"
        try:
            with open(gc_log_path, 'r') as f:
                lines = f.readlines()[-1000:]  # Last 1000 lines
                
            gc_pauses = []
            for line in lines:
                if 'pause' in line.lower():
                    # Extract pause time (customize based on GC log format)
                    pause_match = re.search(r'(\d+\.\d+)ms', line)
                    if pause_match:
                        gc_pauses.append(float(pause_match.group(1)))
            
            metrics['avg_gc_pause_ms'] = statistics.mean(gc_pauses) if gc_pauses else 0
            metrics['max_gc_pause_ms'] = max(gc_pauses) if gc_pauses else 0
            metrics['gc_pause_count'] = len(gc_pauses)
            
        except Exception as e:
            metrics['error'] = str(e)
            
        return metrics
    
    def check_disk_health(self, broker):
        """Check disk I/O and utilization"""
        cmd = f"ssh {broker} 'iostat -x 1 10'"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        metrics = {
            'avg_util_percent': 0,
            'avg_await_ms': 0,
            'avg_write_mb_s': 0
        }
        
        if result.returncode == 0:
            lines = result.stdout.strip().split('\n')
            # Parse iostat output (implementation depends on format)
            # Extract utilization, await time, and throughput
            
        return metrics
    
    def check_network_health(self, broker):
        """Check network utilization and errors"""
        cmd = f"ssh {broker} 'netstat -i; ss -s'"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        metrics = {
            'rx_errors': 0,
            'tx_errors': 0,
            'dropped_packets': 0
        }
        
        # Parse network statistics
        # Extract error counts and dropped packets
        
        return metrics
    
    def check_replication_health(self, broker):
        """Check replication lag and ISR status"""
        cmd = [
            'kafka-replica-verification.sh',
            '--broker-list', ','.join(self.broker_list),
            '--topic-white-list', '.*'
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        metrics = {
            'under_replicated_partitions': 0,
            'offline_partitions': 0,
            'max_replication_lag': 0
        }
        
        # Parse verification output
        for line in result.stdout.split('\n'):
            if 'under replicated' in line.lower():
                metrics['under_replicated_partitions'] += 1
            # Extract other metrics
            
        return metrics
    
    def generate_recommendations(self, broker_metrics):
        """Generate actionable recommendations"""
        recommendations = broker_metrics['recommendations']
        
        # JVM recommendations
        jvm = broker_metrics['jvm_metrics']
        if jvm.get('avg_gc_pause_ms', 0) > 100:
            recommendations.append({
                'severity': 'high',
                'issue': 'High GC pause times',
                'action': 'Increase heap size or tune GC settings'
            })
        
        # Disk recommendations
        disk = broker_metrics['disk_metrics']
        if disk.get('avg_util_percent', 0) > 80:
            recommendations.append({
                'severity': 'high',
                'issue': 'High disk utilization',
                'action': 'Add more brokers or upgrade to faster SSDs'
            })
        
        # Replication recommendations
        replication = broker_metrics['replication_metrics']
        if replication.get('under_replicated_partitions', 0) > 0:
            recommendations.append({
                'severity': 'critical',
                'issue': 'Under-replicated partitions detected',
                'action': 'Check broker health and network connectivity'
            })
        
        return recommendations

# Usage
diagnostics = KafkaBrokerDiagnostics(['broker1', 'broker2', 'broker3'])
results = diagnostics.check_broker_health()

for broker, metrics in results.items():
    print(f"\n=== Broker {broker} Health Report ===")
    print(json.dumps(metrics, indent=2))
```

### Emergency Recovery Procedures

When facing critical issues, follow these emergency procedures:

```bash
#!/bin/bash
# Kafka emergency recovery procedures

# 1. Broker failure recovery
recover_failed_broker() {
    local broker_id=$1
    echo "Recovering broker $broker_id..."
    
    # Stop the broker gracefully
    systemctl stop kafka
    
    # Check and repair log segments
    kafka-log-dirs.sh \
        --bootstrap-server localhost:9092 \
        --broker-list $broker_id \
        --describe | grep ERROR
    
    # Verify log integrity
    kafka-run-class.sh kafka.tools.DumpLogSegments \
        --files /kafka-logs/topic-0/00000000000000000000.log \
        --verify-index-only
    
    # Clear corrupted segments if necessary
    # find /kafka-logs -name "*.corrupted" -delete
    
    # Restart broker
    systemctl start kafka
    
    # Monitor recovery
    watch -n 5 "kafka-broker-api-versions.sh \
        --bootstrap-server localhost:9092 | grep $broker_id"
}

# 2. Partition reassignment for load balancing
emergency_rebalance() {
    local topic=$1
    
    # Generate reassignment plan
    cat > /tmp/topics-to-move.json <<EOF
{
  "topics": [{"topic": "$topic"}],
  "version": 1
}
EOF
    
    # Generate balanced assignment
    kafka-reassign-partitions.sh \
        --bootstrap-server localhost:9092 \
        --topics-to-move-json-file /tmp/topics-to-move.json \
        --broker-list "1,2,3,4,5,6" \
        --generate > /tmp/reassignment.json
    
    # Execute reassignment
    kafka-reassign-partitions.sh \
        --bootstrap-server localhost:9092 \
        --reassignment-json-file /tmp/reassignment.json \
        --execute
    
    # Monitor progress
    watch -n 10 "kafka-reassign-partitions.sh \
        --bootstrap-server localhost:9092 \
        --reassignment-json-file /tmp/reassignment.json \
        --verify"
}

# 3. Consumer group reset for data reprocessing
reset_consumer_group() {
    local group=$1
    local topic=$2
    local reset_to=$3  # earliest, latest, or specific offset
    
    echo "Resetting consumer group $group for topic $topic..."
    
    # Stop consumers first
    echo "WARNING: Ensure all consumers in group $group are stopped!"
    read -p "Press enter to continue..."
    
    # Reset offsets
    kafka-consumer-groups.sh \
        --bootstrap-server localhost:9092 \
        --group $group \
        --topic $topic \
        --reset-offsets \
        --to-$reset_to \
        --execute
    
    # Verify reset
    kafka-consumer-groups.sh \
        --bootstrap-server localhost:9092 \
        --group $group \
        --describe
}

# 4. Emergency topic cleanup
emergency_topic_cleanup() {
    local topic=$1
    local retention_ms=$2  # e.g., 3600000 for 1 hour
    
    echo "Setting emergency retention for topic $topic..."
    
    # Temporarily reduce retention
    kafka-configs.sh \
        --bootstrap-server localhost:9092 \
        --entity-type topics \
        --entity-name $topic \
        --alter \
        --add-config retention.ms=$retention_ms
    
    # Force segment rotation
    kafka-configs.sh \
        --bootstrap-server localhost:9092 \
        --entity-type topics \
        --entity-name $topic \
        --alter \
        --add-config segment.ms=60000
    
    # Wait for cleanup
    echo "Waiting for cleanup to complete..."
    sleep 300
    
    # Restore normal retention
    kafka-configs.sh \
        --bootstrap-server localhost:9092 \
        --entity-type topics \
        --entity-name $topic \
        --alter \
        --delete-config retention.ms,segment.ms
}

# Main emergency menu
echo "=== Kafka Emergency Recovery ==="
echo "1. Recover failed broker"
echo "2. Emergency partition rebalance"
echo "3. Reset consumer group"
echo "4. Emergency topic cleanup"
echo "5. Full cluster recovery"

read -p "Select option: " option

case $option in
    1) read -p "Enter broker ID: " broker_id
       recover_failed_broker $broker_id ;;
    2) read -p "Enter topic name: " topic
       emergency_rebalance $topic ;;
    3) read -p "Enter consumer group: " group
       read -p "Enter topic: " topic
       read -p "Reset to (earliest/latest): " reset_to
       reset_consumer_group $group $topic $reset_to ;;
    4) read -p "Enter topic name: " topic
       read -p "Enter retention (ms): " retention
       emergency_topic_cleanup $topic $retention ;;
    5) echo "Full cluster recovery requires careful planning!"
       echo "Contact senior operations team." ;;
    *) echo "Invalid option" ;;
esac
```

## Conclusion

Operating Apache Kafka at scale requires deep understanding of its architecture, careful capacity planning, and proactive monitoring. This guide has covered the essential aspects of Kafka operations, from optimizing topic partitioning strategies to implementing exactly-once semantics and handling production emergencies.

Key takeaways for successful Kafka operations:

1. **Architecture Understanding**: Know how brokers, partitions, and consumer groups interact
2. **Capacity Planning**: Calculate partition counts based on throughput requirements
3. **Performance Tuning**: Optimize JVM, OS, and Kafka configurations for your workload
4. **Monitoring**: Implement comprehensive monitoring for early issue detection
5. **Exactly-Once Semantics**: Use transactions and idempotent producers for data integrity
6. **Emergency Preparedness**: Have procedures ready for common failure scenarios

As your Kafka deployment grows, continue to refine these practices and adapt them to your specific use cases. Remember that Kafka's strength lies in its distributed nature - embrace it by spreading load across brokers and partitions effectively.

For additional resources and community support, visit the [Apache Kafka documentation](https://kafka.apache.org/documentation/) and join the Kafka users mailing list. The journey to Kafka mastery is ongoing, but with these operational practices, you're well-equipped to handle production workloads with confidence.