---
title: "KEDA: Event-Driven Autoscaling for Kubernetes Workloads"
date: 2028-09-22T00:00:00-05:00
draft: false
tags: ["KEDA", "Kubernetes", "Autoscaling", "Event-Driven", "Kafka"]
categories:
- KEDA
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to KEDA event-driven autoscaling for Kubernetes including ScaledObject and ScaledJob configuration, Kafka/RabbitMQ/Redis/Prometheus scalers, TriggerAuthentication, scaling from zero, and production operational patterns for batch workloads."
more_link: "yes"
url: "/keda-event-driven-autoscaling-kubernetes-guide-production/"
---

Kubernetes Horizontal Pod Autoscaler was designed for CPU and memory. Real applications scale on business metrics: queue depth, event lag, active connections, or custom Prometheus gauges. KEDA (Kubernetes Event-Driven Autoscaling) bridges that gap by extending the Kubernetes metrics API with event-source awareness. It scales workloads from zero to hundreds of replicas based on external signals, then scales back to zero when there is nothing to process — a capability HPA alone cannot deliver.

This guide covers KEDA deployment, the most common scalers, TriggerAuthentication for credential management, and patterns for batch job workloads.

<!--more-->

# KEDA: Event-Driven Autoscaling for Kubernetes Workloads

## Architecture Overview

KEDA installs three Kubernetes components:

1. **Metrics Server** — exposes custom and external metrics to the Kubernetes metrics API
2. **Operator** — watches `ScaledObject` and `ScaledJob` resources, creates/manages HPA objects
3. **Admission Webhooks** — validates ScaledObject configuration at admission time

KEDA does not replace HPA; it creates and manages HPA objects on your behalf, feeding them external metric values from configured scalers.

## Installing KEDA

```bash
# Install with Helm
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set watchNamespace="" \
  --set metricsServer.replicaCount=2 \
  --set operator.replicaCount=2 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=100Mi \
  --set resources.operator.limits.cpu=1 \
  --set resources.operator.limits.memory=1000Mi \
  --set resources.metricServer.requests.cpu=100m \
  --set resources.metricServer.requests.memory=100Mi \
  --set resources.metricServer.limits.cpu=1 \
  --set resources.metricServer.limits.memory=1000Mi

# Verify installation
kubectl get pods -n keda
kubectl get crd | grep keda
```

## ScaledObject: Scaling Deployments

`ScaledObject` maps a scaler trigger to a Kubernetes Deployment, StatefulSet, or custom resource.

### Basic Structure

```yaml
# keda-scaled-object-basic.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: my-app-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app

  # Scale between 0 and 50 replicas
  minReplicaCount: 0
  maxReplicaCount: 50

  # Wait 5 minutes of idle before scaling to zero
  cooldownPeriod: 300

  # Poll the scaler every 30 seconds
  pollingInterval: 30

  # Prevent flapping with stabilization windows
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 120
          policies:
            - type: Percent
              value: 25
              periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
            - type: Percent
              value: 100
              periodSeconds: 30

  triggers: []  # Defined per-scaler below
```

## Kafka Scaler

Scale consumers based on consumer group lag across partitions.

```yaml
# keda-kafka-scaler.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: order-processor
  minReplicaCount: 1
  maxReplicaCount: 30
  pollingInterval: 15
  cooldownPeriod: 60

  triggers:
    - type: kafka
      metadata:
        # Bootstrap servers (comma-separated)
        bootstrapServers: kafka-broker-0.kafka-headless:9092,kafka-broker-1.kafka-headless:9092
        consumerGroup: order-processor-group
        topic: orders
        # Target lag per partition replica
        lagThreshold: "100"
        # How to handle offset reset
        offsetResetPolicy: latest
        # SASL/TLS config
        sasl: plaintext
        tls: enable
      authenticationRef:
        name: kafka-credentials
```

```yaml
# kafka-trigger-auth.yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-credentials
  namespace: production
spec:
  secretTargetRef:
    - parameter: sasl
      name: kafka-secret
      key: sasl-mechanism
    - parameter: username
      name: kafka-secret
      key: username
    - parameter: password
      name: kafka-secret
      key: password
    - parameter: ca
      name: kafka-tls-secret
      key: ca.crt
    - parameter: cert
      name: kafka-tls-secret
      key: tls.crt
    - parameter: key
      name: kafka-tls-secret
      key: tls.key
```

```bash
# Create the Kafka credentials secret
kubectl create secret generic kafka-secret \
  --namespace production \
  --from-literal=sasl-mechanism=SCRAM-SHA-512 \
  --from-literal=username=keda-user \
  --from-literal=password=your-kafka-password

kubectl create secret generic kafka-tls-secret \
  --namespace production \
  --from-file=ca.crt=./ca.crt \
  --from-file=tls.crt=./client.crt \
  --from-file=tls.key=./client.key
```

## RabbitMQ Scaler

```yaml
# keda-rabbitmq-scaler.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: rabbitmq-consumer-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: message-processor
  minReplicaCount: 0
  maxReplicaCount: 20
  pollingInterval: 10
  cooldownPeriod: 120

  triggers:
    - type: rabbitmq
      metadata:
        # Queue name to monitor
        queueName: task-queue
        # Protocol: amqp or http
        protocol: http
        # Management API endpoint
        host: http://rabbitmq-management.rabbitmq:15672
        # Scale one replica per N messages
        queueLength: "50"
        # Optional: use vhost
        vhostName: /production
      authenticationRef:
        name: rabbitmq-auth
```

```yaml
# rabbitmq-trigger-auth.yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: host
      name: rabbitmq-credentials
      key: management-url  # http://user:pass@rabbitmq-management:15672
```

```bash
kubectl create secret generic rabbitmq-credentials \
  --namespace production \
  --from-literal=management-url="http://admin:password@rabbitmq-management.rabbitmq:15672"
```

## Redis Scaler

Scale based on Redis list length or stream consumer group pending entries.

```yaml
# keda-redis-list-scaler.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: redis-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: redis-worker
  minReplicaCount: 0
  maxReplicaCount: 25
  pollingInterval: 5
  cooldownPeriod: 60

  triggers:
    # Scale on list length (e.g., task queue)
    - type: redis
      metadata:
        address: redis-master.redis:6379
        listName: work-queue
        listLength: "10"
        databaseIndex: "0"
        enableTLS: "true"
      authenticationRef:
        name: redis-auth

    # Also scale on a Redis Streams consumer group
    - type: redis-streams
      metadata:
        address: redis-master.redis:6379
        stream: events-stream
        consumerGroup: workers
        pendingEntriesCount: "5"
      authenticationRef:
        name: redis-auth
```

```yaml
# redis-trigger-auth.yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: password
      name: redis-credentials
      key: redis-password
    - parameter: tls
      name: redis-tls
      key: tls.crt
```

## Prometheus Scaler

Scale on any Prometheus metric query result.

```yaml
# keda-prometheus-scaler.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: prometheus-based-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 50
  pollingInterval: 30

  triggers:
    # Scale on HTTP request rate
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring:9090
        metricName: http_requests_per_second
        # Each replica should handle 100 req/s
        threshold: "100"
        query: sum(rate(http_requests_total{service="api-server"}[2m]))

    # Scale on queue processing latency
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring:9090
        metricName: queue_latency_p99
        threshold: "5000"  # 5 seconds in milliseconds
        query: histogram_quantile(0.99, sum(rate(queue_processing_duration_milliseconds_bucket[5m])) by (le))
```

### Prometheus with Authentication

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: prometheus-auth
  namespace: production
spec:
  # Use a bearer token from a Kubernetes service account
  podIdentity:
    provider: none  # Use secretTargetRef instead
  secretTargetRef:
    - parameter: bearerToken
      name: prometheus-token
      key: token
    - parameter: ca
      name: prometheus-tls
      key: ca.crt
```

## Cron Scaler

Pre-scale workloads before known traffic spikes.

```yaml
# keda-cron-scaler.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: cron-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: batch-processor
  minReplicaCount: 1
  maxReplicaCount: 20

  triggers:
    # Scale up during business hours (EST)
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 8 * * 1-5"   # 8 AM weekdays
        end: "0 18 * * 1-5"    # 6 PM weekdays
        desiredReplicas: "10"

    # Scale up for nightly batch processing
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 2 * * *"     # 2 AM every day
        end: "0 4 * * *"       # 4 AM every day
        desiredReplicas: "15"
```

## ScaledJob: Event-Driven Batch Processing

`ScaledJob` creates a Kubernetes Job per trigger event rather than scaling a long-running Deployment. This is ideal for isolated batch tasks.

```yaml
# keda-scaled-job.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processor-job
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 3600  # 1-hour job timeout
    backoffLimit: 3
    template:
      spec:
        restartPolicy: Never
        containers:
          - name: processor
            image: my-registry/image-processor:v1.2.0
            env:
              - name: QUEUE_URL
                value: amqp://rabbitmq.rabbitmq:5672
              - name: QUEUE_NAME
                value: image-upload-queue
            resources:
              requests:
                cpu: "500m"
                memory: "512Mi"
              limits:
                cpu: "2"
                memory: "2Gi"

  # How many jobs to run concurrently
  maxReplicaCount: 10

  # Scale with queue depth
  pollingInterval: 10

  # Clean up successful jobs after 1 hour
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10

  triggers:
    - type: rabbitmq
      metadata:
        queueName: image-upload-queue
        protocol: http
        host: http://rabbitmq-management.rabbitmq:15672
        # Create one job per message (queueLength: "1")
        queueLength: "1"
      authenticationRef:
        name: rabbitmq-auth

  # Job scaling strategy
  scalingStrategy:
    strategy: "accurate"    # accurate | default | custom
    # For accurate: create exactly one job per pending message
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "1.0"
```

## ClusterTriggerAuthentication for Cross-Namespace Credentials

When multiple namespaces share the same external system credentials, use `ClusterTriggerAuthentication`:

```yaml
# cluster-trigger-auth.yaml
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: global-kafka-credentials
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-global-credentials
      key: username
    - parameter: password
      name: kafka-global-credentials
      key: password
```

```yaml
# Reference from any namespace
triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-broker:9092
      consumerGroup: my-group
      topic: my-topic
      lagThreshold: "50"
    authenticationRef:
      name: global-kafka-credentials
      kind: ClusterTriggerAuthentication  # Note the kind field
```

## Combining KEDA with HPA

KEDA manages HPA objects internally, but you can view them:

```bash
# KEDA creates an HPA for each ScaledObject
kubectl get hpa -n production
# NAME                    REFERENCE                TARGETS              MINPODS   MAXPODS   REPLICAS
# keda-hpa-kafka-scaler   Deployment/order-proc    50/100 (lag)         1         30        3

# View the managed HPA details
kubectl describe hpa keda-hpa-kafka-consumer-scaler -n production
```

Important: Do not create your own HPA targeting the same resource as a KEDA `ScaledObject`. KEDA manages that HPA exclusively. If you need CPU-based scaling alongside event-based scaling, add a CPU trigger to the KEDA ScaledObject:

```yaml
triggers:
  # Event-based: scale on Kafka lag
  - type: kafka
    metadata:
      bootstrapServers: kafka-broker:9092
      consumerGroup: my-group
      topic: orders
      lagThreshold: "100"
    authenticationRef:
      name: kafka-credentials

  # CPU-based: also scale if CPU is high regardless of lag
  - type: cpu
    metricType: Utilization
    metadata:
      value: "70"

  # Memory-based: scale if memory pressure exists
  - type: memory
    metricType: Utilization
    metadata:
      value: "80"
```

## Scaling to Zero and Back

Scaling to zero requires `minReplicaCount: 0` in the ScaledObject. When a trigger fires and the first message arrives, KEDA wakes the Deployment from zero replicas. The initial scale-up from zero to the first replica takes one polling interval.

For latency-sensitive applications, keep `minReplicaCount: 1` during business hours using a cron trigger:

```yaml
# keda-mixed-scaler.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: mixed-strategy-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-consumer
  minReplicaCount: 0
  maxReplicaCount: 20
  pollingInterval: 15
  cooldownPeriod: 300  # 5 minutes before scaling to zero

  triggers:
    # Main scaler: Kafka lag
    - type: kafka
      metadata:
        bootstrapServers: kafka-broker:9092
        consumerGroup: api-consumer-group
        topic: api-requests
        lagThreshold: "50"
      authenticationRef:
        name: kafka-credentials

    # Floor scaler: guarantee at least 1 replica during business hours
    - type: cron
      metadata:
        timezone: UTC
        start: "0 7 * * 1-5"
        end: "0 19 * * 1-5"
        desiredReplicas: "1"
```

## Observability and Debugging

### KEDA Metrics in Prometheus

KEDA exposes operator and scaler metrics. Add a `ServiceMonitor`:

```yaml
# keda-service-monitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keda-operator
  namespace: keda
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - keda
  selector:
    matchLabels:
      app: keda-operator
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

Key KEDA metrics to alert on:

```promql
# Scaler errors (should be 0)
keda_scaler_errors_total

# Active triggers per ScaledObject
keda_scaled_object_paused

# Current metric value from each scaler
keda_scaler_metrics_value

# HPA current replicas
keda_resource_totals{type="hpa"}
```

### Debugging ScaledObjects

```bash
# Check ScaledObject status
kubectl describe scaledobject kafka-consumer-scaler -n production

# Check if KEDA operator can reach the external system
kubectl logs -n keda -l app=keda-operator --tail=50 | grep -i error

# View the metrics KEDA is currently reporting
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | jq .

# Check specific metric values KEDA is reporting to HPA
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/s0-kafka-orders" | jq .

# Force a ScaledObject to pause (maintenance mode)
kubectl annotate scaledobject kafka-consumer-scaler \
  --namespace production \
  autoscaling.keda.sh/paused-replicas="3"

# Unpause
kubectl annotate scaledobject kafka-consumer-scaler \
  --namespace production \
  autoscaling.keda.sh/paused-replicas-
```

### Useful kubectl Commands

```bash
# List all ScaledObjects across all namespaces
kubectl get scaledobjects -A

# List all ScaledJobs
kubectl get scaledjobs -A

# List all TriggerAuthentications
kubectl get triggerauthentications -A
kubectl get clustertriggerauthentications

# Check KEDA operator health
kubectl get pods -n keda -o wide
kubectl top pods -n keda

# Watch scaling events in real time
kubectl get events -n production --field-selector reason=KEDAScaleTargetActivated -w
```

## Production Operational Patterns

### PodDisruptionBudget for Graceful Scaling

```yaml
# pdb-for-keda-target.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-processor-pdb
  namespace: production
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: order-processor
```

### Resource Quotas to Prevent Runaway Scaling

```yaml
# resource-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: keda-workload-limits
  namespace: production
spec:
  hard:
    requests.cpu: "40"
    requests.memory: 80Gi
    limits.cpu: "80"
    limits.memory: 160Gi
    pods: "100"
```

### Graceful Shutdown in Consumer Application (Go)

The consumer application must handle `SIGTERM` gracefully so in-flight messages complete before the pod terminates:

```go
// main.go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "github.com/IBM/sarama"
)

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Set up signal handling
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

    consumer, err := newKafkaConsumer(ctx)
    if err != nil {
        log.Fatalf("failed to create consumer: %v", err)
    }

    var wg sync.WaitGroup
    wg.Add(1)
    go func() {
        defer wg.Done()
        if err := consumer.Run(ctx); err != nil {
            log.Printf("consumer error: %v", err)
        }
    }()

    // Wait for shutdown signal
    sig := <-sigCh
    fmt.Printf("received signal %v, initiating graceful shutdown\n", sig)

    // Cancel context to stop accepting new messages
    cancel()

    // Wait for in-flight processing to complete (with timeout)
    shutdownCh := make(chan struct{})
    go func() {
        wg.Wait()
        close(shutdownCh)
    }()

    select {
    case <-shutdownCh:
        fmt.Println("graceful shutdown complete")
    case <-time.After(30 * time.Second):
        fmt.Println("shutdown timeout exceeded, forcing exit")
    }
}
```

```yaml
# deployment for the consumer
spec:
  template:
    spec:
      # Give the container 60 seconds to finish in-flight work
      terminationGracePeriodSeconds: 60
      containers:
        - name: order-processor
          image: my-registry/order-processor:v1.0.0
          lifecycle:
            preStop:
              exec:
                # Delay SIGTERM by 5 seconds to allow kube-proxy to drain connections
                command: ["/bin/sleep", "5"]
```

## Summary

KEDA transforms Kubernetes autoscaling from a resource-centric model to an event-driven model. Key takeaways:

- **ScaledObject** for long-running consumer Deployments; **ScaledJob** for isolated batch jobs that need per-message isolation
- **TriggerAuthentication** and **ClusterTriggerAuthentication** keep credentials out of ScaledObject manifests
- Multiple triggers on a single ScaledObject are ORed together — the highest desired replica count wins
- `minReplicaCount: 0` enables true scale-to-zero with a configurable `cooldownPeriod`
- KEDA creates and manages HPA objects; never create your own HPA for the same target
- Combine cron and event triggers to maintain a minimum replica floor during business hours while still scaling to zero overnight
- Graceful shutdown handling in your consumer is essential — without it, SIGTERM will drop in-flight messages during scale-in
