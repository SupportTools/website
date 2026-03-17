---
title: "Kubernetes KEDA: Event-Driven Autoscaling Beyond HPA"
date: 2029-04-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "HPA", "Kafka", "Prometheus", "Event-Driven"]
categories:
- Kubernetes
- Autoscaling
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into KEDA architecture, ScaledObject and ScaledJob resources, Kafka and Prometheus scalers, cron-based scaling, external scalers, and production patterns for event-driven autoscaling in Kubernetes."
more_link: "yes"
url: "/kubernetes-keda-event-driven-autoscaling-beyond-hpa-guide/"
---

Kubernetes Horizontal Pod Autoscaler covers CPU and memory scaling well, but modern applications demand scaling based on queue depth, message lag, custom business metrics, and scheduled load patterns. KEDA (Kubernetes Event-Driven Autoscaling) fills this gap with a rich ecosystem of scalers that integrate directly with event sources, message brokers, and monitoring systems.

This guide covers KEDA architecture from the ground up, walks through the most important scalers with production configurations, and shows how to build robust autoscaling pipelines that complement rather than conflict with existing HPA deployments.

<!--more-->

# Kubernetes KEDA: Event-Driven Autoscaling Beyond HPA

## Section 1: KEDA Architecture and Core Concepts

KEDA runs as a lightweight operator alongside the Kubernetes metrics server and extends the standard HPA machinery. Rather than replacing HPA, KEDA acts as an external metrics provider that feeds values into an HPA object it manages on your behalf.

### Component Overview

KEDA consists of three primary components:

**KEDA Operator**: Watches `ScaledObject` and `ScaledJob` custom resources, creates corresponding HPA objects, and manages the lifecycle of scaled workloads including scale-to-zero behavior.

**KEDA Metrics Adapter**: Implements the Kubernetes external metrics API. When HPA queries for a metric value, the adapter polls the configured trigger source and returns the current count.

**Scaler Plugins**: Built-in scalers for over 60 event sources. Each scaler knows how to connect to a specific system (Kafka, RabbitMQ, Redis, Prometheus, AWS SQS, etc.) and retrieve a numeric metric.

### Installing KEDA

```bash
# Install via Helm
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

kubectl create namespace keda

helm install keda kedacore/keda \
  --namespace keda \
  --set watchNamespace="" \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true \
  --version 2.13.0
```

Verify the installation:

```bash
kubectl get pods -n keda
# NAME                                      READY   STATUS    RESTARTS   AGE
# keda-admission-webhooks-xxx               1/1     Running   0          2m
# keda-operator-xxx                         1/1     Running   0          2m
# keda-operator-metrics-apiserver-xxx       1/1     Running   0          2m

kubectl get crd | grep keda
# clustertriggerauthentications.keda.sh
# scaledjobs.keda.sh
# scaledobjects.keda.sh
# triggerauthentications.keda.sh
```

### ScaledObject Resource Structure

A `ScaledObject` connects a Kubernetes workload (Deployment, StatefulSet, or any custom resource with a `/scale` subresource) to one or more event sources:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor
  pollingInterval: 15       # seconds between metric polls
  cooldownPeriod: 300       # seconds to wait before scaling to zero
  idleReplicaCount: 0       # scale to zero when idle
  minReplicaCount: 1        # minimum replicas when active
  maxReplicaCount: 50       # maximum replicas
  fallback:
    failureThreshold: 3     # tolerate 3 consecutive scaler failures
    replicas: 5             # fallback replica count during failures
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      name: worker-hpa      # custom HPA name
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
          - type: Percent
            value: 10
            periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
          - type: Percent
            value: 100
            periodSeconds: 15
          - type: Pods
            value: 4
            periodSeconds: 15
          selectPolicy: Max
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka.production:9092
      consumerGroup: order-processors
      topic: orders
      lagThreshold: "100"
```

### TriggerAuthentication for Secure Credentials

KEDA provides a dedicated resource for managing scaler credentials, keeping them separate from the ScaledObject:

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-credentials
    key: sasl_mechanism
  - parameter: username
    name: kafka-credentials
    key: username
  - parameter: password
    name: kafka-credentials
    key: password
  - parameter: tls
    name: kafka-credentials
    key: tls_mode
  - parameter: ca
    name: kafka-credentials
    key: ca_cert
```

Reference it from a ScaledObject trigger:

```yaml
  triggers:
  - type: kafka
    authenticationRef:
      name: kafka-trigger-auth
    metadata:
      bootstrapServers: kafka.production:9092
      consumerGroup: order-processors
      topic: orders
      lagThreshold: "100"
```

For cluster-wide authentication usable across namespaces:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: global-kafka-auth
spec:
  secretTargetRef:
  - parameter: username
    name: kafka-global-secret
    key: username
  - parameter: password
    name: kafka-global-secret
    key: password
```

## Section 2: Kafka Scaler — Consumer Lag Based Scaling

The Kafka scaler is one of the most commonly used in production. It scales based on consumer group lag — the difference between the latest offset on a partition and the consumer's committed offset.

### Basic Kafka ScaledObject

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: order-consumer
  minReplicaCount: 1
  maxReplicaCount: 30
  pollingInterval: 10
  cooldownPeriod: 60
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: "kafka-0.kafka-headless:9092,kafka-1.kafka-headless:9092,kafka-2.kafka-headless:9092"
      consumerGroup: order-processors
      topic: orders
      lagThreshold: "50"           # target: 50 messages lag per replica
      activationLagThreshold: "10" # minimum lag to activate scaling
      offsetResetPolicy: latest
      allowIdleConsumers: "false"
      scaleToZeroOnInvalidOffset: "false"
      excludePersistentLag: "false"
      version: "2.0.0"
      partitionLimitation: "0,1,2,3,4,5"  # only scale on these partitions
```

### Understanding Lag Threshold Calculations

KEDA calculates the desired replica count using:

```
desiredReplicas = ceil(totalLag / lagThreshold)
```

For a topic with 12 partitions, 600 messages of total lag, and `lagThreshold: 50`:

```
desiredReplicas = ceil(600 / 50) = 12 replicas
```

The `maxReplicaCount` caps this at 30, and KEDA will never scale beyond the partition count (12 in this case) because extra consumers would receive no messages.

### Multi-Topic Kafka Scaling

When consuming from multiple topics, use multiple triggers. KEDA uses the maximum value across all triggers:

```yaml
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka.production:9092
      consumerGroup: payment-processors
      topic: payments
      lagThreshold: "100"
  - type: kafka
    metadata:
      bootstrapServers: kafka.production:9092
      consumerGroup: payment-processors
      topic: payment-refunds
      lagThreshold: "50"
```

### Kafka with SASL/TLS Authentication

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-sasl-secret
  namespace: production
type: Opaque
stringData:
  sasl: "plaintext"
  username: "keda-consumer"
  password: "REPLACE_WITH_ACTUAL_PASSWORD"
  tls: "enable"
  ca: |
    -----BEGIN CERTIFICATE-----
    ... CA certificate content ...
    -----END CERTIFICATE-----
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-sasl-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-sasl-secret
    key: sasl
  - parameter: username
    name: kafka-sasl-secret
    key: username
  - parameter: password
    name: kafka-sasl-secret
    key: password
  - parameter: tls
    name: kafka-sasl-secret
    key: tls
  - parameter: ca
    name: kafka-sasl-secret
    key: ca
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: secure-kafka-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: secure-consumer
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
  - type: kafka
    authenticationRef:
      name: kafka-sasl-auth
    metadata:
      bootstrapServers: kafka.production:9093
      consumerGroup: secure-processors
      topic: secure-events
      lagThreshold: "200"
      saslType: "SCRAM-SHA-256"
```

## Section 3: Prometheus Scaler

The Prometheus scaler enables scaling based on any metric exposed in a Prometheus-compatible endpoint, making it the most flexible scaler for custom application metrics.

### Basic Prometheus ScaledObject

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: prometheus-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: http_requests_per_second
      threshold: "100"
      activationThreshold: "10"
      query: |
        sum(rate(http_requests_total{namespace="production",service="api-server"}[2m]))
      namespace: production
      customHeaders: "X-Scope-OrgID=production-tenant"
      ignoreNullValues: "false"
      unsafeSsl: "false"
```

### Complex Prometheus Queries for Business Metrics

```yaml
  triggers:
  # Scale based on pending job queue depth
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: pending_jobs
      threshold: "25"
      query: |
        sum(job_queue_pending_total{env="production"})

  # Scale based on error rate exceeding threshold
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: error_rate_trigger
      threshold: "1"
      activationThreshold: "0"
      query: |
        (
          sum(rate(http_requests_total{status=~"5..",service="payment-api"}[5m]))
          /
          sum(rate(http_requests_total{service="payment-api"}[5m]))
        ) > bool 0.05

  # Scale based on P99 latency
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: p99_latency_ms
      threshold: "500"
      query: |
        histogram_quantile(0.99,
          sum(rate(http_request_duration_milliseconds_bucket{service="api-server"}[5m]))
          by (le)
        )
```

### Prometheus with Authentication (Thanos/Cortex)

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: thanos-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: bearerToken
    name: thanos-token-secret
    key: token
  - parameter: ca
    name: thanos-tls-secret
    key: ca.crt
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: thanos-prometheus-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: analytics-worker
  triggers:
  - type: prometheus
    authenticationRef:
      name: thanos-auth
    metadata:
      serverAddress: https://thanos-query.monitoring:9091
      metricName: analytics_queue_depth
      threshold: "100"
      query: |
        sum(analytics_pending_events{tenant="acme"})
      authModes: "bearer"
```

## Section 4: Cron Scaler — Scheduled Scaling

The cron scaler provides time-based scaling independent of metrics, useful for predictable traffic patterns like business hours or batch jobs.

### Basic Cron ScaledObject

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: business-hours-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: web-frontend
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 8 * * 1-5"    # 8 AM weekdays
      end: "0 18 * * 1-5"     # 6 PM weekdays
      desiredReplicas: "10"
```

### Combining Cron with Metrics Scalers

The real power comes from combining cron with reactive scalers. The higher value wins:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: combined-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: checkout-service
  minReplicaCount: 2
  maxReplicaCount: 50
  triggers:
  # Business hours baseline
  - type: cron
    metadata:
      timezone: America/Chicago
      start: "0 9 * * 1-5"
      end: "0 21 * * 1-5"
      desiredReplicas: "5"
  # Weekend hours
  - type: cron
    metadata:
      timezone: America/Chicago
      start: "0 10 * * 0,6"
      end: "0 22 * * 0,6"
      desiredReplicas: "8"
  # Black Friday / Cyber Monday surge
  - type: cron
    metadata:
      timezone: America/Chicago
      start: "0 0 28 11 *"   # Nov 28 midnight
      end: "0 0 3 12 *"      # Dec 3 midnight
      desiredReplicas: "30"
  # Reactive Kafka scaler takes precedence when lag is high
  - type: kafka
    metadata:
      bootstrapServers: kafka.production:9092
      consumerGroup: checkout-processors
      topic: checkout-events
      lagThreshold: "20"
```

### Multi-Timezone Global Application

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: global-app-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: global-api
  minReplicaCount: 3
  maxReplicaCount: 40
  triggers:
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 8 * * 1-5"
      end: "0 18 * * 1-5"
      desiredReplicas: "10"
  - type: cron
    metadata:
      timezone: Europe/London
      start: "0 8 * * 1-5"
      end: "0 18 * * 1-5"
      desiredReplicas: "10"
  - type: cron
    metadata:
      timezone: Asia/Tokyo
      start: "0 8 * * 1-5"
      end: "0 18 * * 1-5"
      desiredReplicas: "8"
```

## Section 5: External Scalers

When built-in scalers don't cover your use case, KEDA supports external scalers via gRPC. You implement a small server that KEDA calls to retrieve metrics.

### External Scaler gRPC Interface

```protobuf
syntax = "proto3";

package externalscaler;

service ExternalScaler {
  rpc IsActive(ScaledObjectRef) returns (IsActiveResponse) {}
  rpc StreamIsActive(ScaledObjectRef) returns (stream IsActiveResponse) {}
  rpc GetMetricSpec(ScaledObjectRef) returns (GetMetricSpecResponse) {}
  rpc GetMetrics(GetMetricsRequest) returns (GetMetricsResponse) {}
}

message ScaledObjectRef {
  string name = 1;
  string namespace = 2;
  map<string, string> scalerMetadata = 3;
}

message IsActiveResponse {
  bool result = 1;
}

message GetMetricSpecResponse {
  repeated MetricSpec metricSpecs = 1;
}

message MetricSpec {
  string metricName = 1;
  int64 targetSize = 2;
}

message GetMetricsRequest {
  ScaledObjectRef scaledObjectRef = 1;
  string metricName = 2;
}

message GetMetricsResponse {
  repeated MetricValue metricValues = 1;
}

message MetricValue {
  string metricName = 1;
  int64 metricValue = 2;
}
```

### External Scaler Implementation in Go

```go
package main

import (
    "context"
    "database/sql"
    "log"
    "net"
    "strconv"

    pb "github.com/kedacore/keda/v2/pkg/scalers/externalscaler"
    _ "github.com/lib/pq"
    "google.golang.org/grpc"
)

type postgresScaler struct {
    pb.UnimplementedExternalScalerServer
    db *sql.DB
}

func (s *postgresScaler) IsActive(ctx context.Context, ref *pb.ScaledObjectRef) (*pb.IsActiveResponse, error) {
    var count int64
    err := s.db.QueryRowContext(ctx,
        "SELECT COUNT(*) FROM jobs WHERE status = 'pending' AND queue = $1",
        ref.ScalerMetadata["queueName"],
    ).Scan(&count)
    if err != nil {
        return nil, err
    }
    return &pb.IsActiveResponse{Result: count > 0}, nil
}

func (s *postgresScaler) GetMetricSpec(ctx context.Context, ref *pb.ScaledObjectRef) (*pb.GetMetricSpecResponse, error) {
    threshold, _ := strconv.ParseInt(ref.ScalerMetadata["threshold"], 10, 64)
    if threshold == 0 {
        threshold = 10
    }
    return &pb.GetMetricSpecResponse{
        MetricSpecs: []*pb.MetricSpec{{
            MetricName: "pendingJobs",
            TargetSize: threshold,
        }},
    }, nil
}

func (s *postgresScaler) GetMetrics(ctx context.Context, req *pb.GetMetricsRequest) (*pb.GetMetricsResponse, error) {
    var count int64
    err := s.db.QueryRowContext(ctx,
        "SELECT COUNT(*) FROM jobs WHERE status = 'pending' AND queue = $1",
        req.ScaledObjectRef.ScalerMetadata["queueName"],
    ).Scan(&count)
    if err != nil {
        return nil, err
    }
    return &pb.GetMetricsResponse{
        MetricValues: []*pb.MetricValue{{
            MetricName:  "pendingJobs",
            MetricValue: count,
        }},
    }, nil
}

func main() {
    db, err := sql.Open("postgres", "postgres://scaler:password@postgres:5432/jobsdb?sslmode=verify-full")
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    lis, err := net.Listen("tcp", ":6000")
    if err != nil {
        log.Fatal(err)
    }

    s := grpc.NewServer()
    pb.RegisterExternalScalerServer(s, &postgresScaler{db: db})
    log.Printf("External scaler listening on :6000")
    log.Fatal(s.Serve(lis))
}
```

Reference the external scaler from a ScaledObject:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: postgres-job-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: job-worker
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
  - type: external
    metadata:
      scalerAddress: postgres-external-scaler.keda:6000
      queueName: "high-priority"
      threshold: "5"
```

## Section 6: ScaledJob for Batch Workloads

`ScaledJob` is designed for one-time completion tasks rather than long-running services. Each trigger event creates a Kubernetes Job.

### ScaledJob Configuration

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processor
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 600
    backoffLimit: 3
    template:
      spec:
        restartPolicy: Never
        containers:
        - name: processor
          image: registry.example.com/image-processor:v1.2.0
          env:
          - name: QUEUE_URL
            value: "https://sqs.us-east-1.amazonaws.com/123456789/image-processing"
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
  pollingInterval: 30
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 5
  maxReplicaCount: 20
  scalingStrategy:
    strategy: "custom"
    customScalingQueueLengthDeduction: 1
    customScalingRunningJobPercentage: "0.5"
    pendingPodConditions:
    - "Ready"
    - "PodScheduled"
  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789/image-processing
      queueLength: "5"
      awsRegion: us-east-1
```

### ScaledJob Scaling Strategies

```yaml
  scalingStrategy:
    # "default": standard HPA behavior
    strategy: "default"

    # "custom": fine-grained control
    # strategy: "custom"
    # customScalingQueueLengthDeduction: 1  # subtract for each running job
    # customScalingRunningJobPercentage: "0.5"  # assume running jobs process 50% done

    # "accurate": counts pending pods as running
    # strategy: "accurate"
```

## Section 7: KEDA vs Native HPA

### Capability Comparison

| Feature | Native HPA | KEDA |
|---|---|---|
| CPU scaling | Yes | Via Prometheus |
| Memory scaling | Yes | Via Prometheus |
| Scale to zero | No | Yes |
| External metrics | Limited (custom metrics API) | 60+ scalers built-in |
| Kafka lag | No | Yes |
| SQS queue depth | No | Yes |
| Cron schedules | No | Yes |
| Batch jobs | No | ScaledJob |
| Fallback on errors | No | Yes |
| Multi-trigger OR logic | No | Yes |

### When to Use HPA Alone

Native HPA remains the right choice when:
- Scaling is purely CPU or memory driven
- You need strict declarative control of the HPA object
- You cannot run additional controllers in your cluster

### When to Use KEDA

KEDA is the right choice when:
- Your workloads consume from message queues or event streams
- You need scale-to-zero to reduce costs during off-hours
- Scaling should respond to business metrics (orders, payments, queue depth)
- You run batch jobs that should scale with queue depth
- Multiple heterogeneous trigger sources need to be combined

### Running KEDA Alongside Existing HPA

KEDA creates its own HPA objects. If you have existing HPAs on a deployment, you must remove them before adding a ScaledObject to avoid conflicts:

```bash
# Check for existing HPAs
kubectl get hpa -n production

# Remove conflicting HPA before creating ScaledObject
kubectl delete hpa order-processor-hpa -n production

# KEDA will create a new HPA named after the ScaledObject
kubectl get hpa -n production
# NAME                               REFERENCE                     TARGETS       MINPODS   MAXPODS   REPLICAS
# keda-hpa-worker-scaledobject       Deployment/order-processor    48/100        1         50        5
```

## Section 8: Production Patterns and Operational Considerations

### Scale-to-Zero Strategies

Scale-to-zero is powerful for cost reduction but requires careful design:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: nightly-processor
  namespace: production
spec:
  scaleTargetRef:
    name: report-generator
  idleReplicaCount: 0      # scale to zero
  minReplicaCount: 0       # 0 = allow scale to zero
  maxReplicaCount: 5
  cooldownPeriod: 600      # wait 10 minutes before scaling to zero
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka.production:9092
      consumerGroup: report-generators
      topic: report-requests
      lagThreshold: "1"
      activationLagThreshold: "1"
```

For scale-to-zero with HTTP triggers, consider KEDA HTTP Add-on:

```bash
helm install http-add-on kedacore/keda-add-ons-http \
  --namespace keda \
  --set interceptor.replicas.min=1 \
  --set interceptor.replicas.max=3
```

### Monitoring KEDA with Prometheus

KEDA exposes metrics on port 8080 of the operator:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keda-operator-monitor
  namespace: keda
spec:
  selector:
    matchLabels:
      app: keda-operator
  endpoints:
  - port: metricsapi
    interval: 30s
    path: /metrics
```

Key metrics to monitor:

```promql
# Scaler errors
keda_scaler_errors_total{namespace="production", scaledObject="worker-scaledobject"}

# Current metric value vs threshold
keda_scaler_metrics_value{namespace="production", scaledObject="worker-scaledobject"}

# Active replicas
keda_scaled_object_paused{namespace="production", scaledObject="worker-scaledobject"}

# HPA utilization
keda_resource_totals{namespace="production", resource="deployment", scaledObject="worker-scaledobject"}
```

### Grafana Dashboard

```json
{
  "panels": [
    {
      "title": "KEDA Scaling Events",
      "type": "graph",
      "targets": [
        {
          "expr": "keda_scaler_metrics_value{namespace=\"production\"}",
          "legendFormat": "{{scaledObject}} - {{metric}}"
        }
      ]
    },
    {
      "title": "Scaler Errors",
      "type": "stat",
      "targets": [
        {
          "expr": "increase(keda_scaler_errors_total[5m])",
          "legendFormat": "{{scaledObject}}"
        }
      ]
    }
  ]
}
```

### Pausing ScaledObjects During Maintenance

```bash
# Pause scaling (keeps current replica count)
kubectl annotate scaledobject worker-scaledobject \
  autoscaling.keda.sh/paused=true \
  -n production

# Pause and set specific replica count
kubectl annotate scaledobject worker-scaledobject \
  autoscaling.keda.sh/paused-replicas=3 \
  -n production

# Resume scaling
kubectl annotate scaledobject worker-scaledobject \
  autoscaling.keda.sh/paused- \
  -n production
```

### RBAC for KEDA Operator

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: keda-operator
  namespace: keda
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: keda-operator-role
rules:
- apiGroups: ["keda.sh"]
  resources: ["scaledobjects", "scaledjobs", "triggerauthentications", "clustertriggerauthentications"]
  verbs: ["get", "list", "watch", "update", "patch"]
- apiGroups: ["autoscaling"]
  resources: ["horizontalpodautoscalers"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "watch", "update", "patch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch"]
```

### Troubleshooting Common Issues

**ScaledObject not triggering:**

```bash
# Check ScaledObject conditions
kubectl describe scaledobject worker-scaledobject -n production

# Check KEDA operator logs
kubectl logs -n keda -l app=keda-operator --tail=100

# Check metrics adapter logs
kubectl logs -n keda -l app=keda-operator-metrics-apiserver --tail=100

# Manually query the metrics adapter
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/keda-kafka-orders" | jq .
```

**Scale-to-zero not working:**

```bash
# Verify idleReplicaCount is set to 0 and minReplicaCount is 0
kubectl get scaledobject worker-scaledobject -n production -o yaml | grep -A5 "idleReplicaCount\|minReplicaCount"

# Check cooldownPeriod - KEDA waits this many seconds after metric drops to zero
kubectl get scaledobject worker-scaledobject -n production -o yaml | grep cooldownPeriod
```

**Kafka scaler shows incorrect lag:**

```bash
# Manually check consumer group lag
kubectl run kafka-check --rm -it \
  --image=confluentinc/cp-kafka:7.5.0 \
  --restart=Never \
  -- kafka-consumer-groups \
  --bootstrap-server kafka.production:9092 \
  --describe \
  --group order-processors
```

### Complete Production ScaledObject with All Best Practices

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: production-worker
  namespace: production
  annotations:
    scaledobject.keda.sh/transfer-hpa-ownership: "true"
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-worker
  pollingInterval: 15
  cooldownPeriod: 300
  idleReplicaCount: 0
  minReplicaCount: 2
  maxReplicaCount: 50
  fallback:
    failureThreshold: 5
    replicas: 5
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
          - type: Percent
            value: 25
            periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
          - type: Percent
            value: 100
            periodSeconds: 30
          - type: Pods
            value: 10
            periodSeconds: 30
          selectPolicy: Max
  triggers:
  - type: kafka
    authenticationRef:
      name: kafka-trigger-auth
    metadata:
      bootstrapServers: "kafka-0.kafka:9092,kafka-1.kafka:9092,kafka-2.kafka:9092"
      consumerGroup: order-workers
      topic: orders
      lagThreshold: "100"
      activationLagThreshold: "5"
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring:9090
      metricName: queue_depth
      threshold: "200"
      query: sum(order_queue_pending_total{env="production"})
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 9 * * 1-5"
      end: "0 17 * * 1-5"
      desiredReplicas: "5"
```

## Section 9: Advanced KEDA Patterns

### Scaling Based on Cloud Provider Metrics

**AWS SQS:**

```yaml
  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: aws-keda-auth
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/my-queue
      queueLength: "10"
      awsRegion: us-east-1
      identityOwner: operator
```

**GCP Pub/Sub:**

```yaml
  triggers:
  - type: gcp-pubsub
    authenticationRef:
      name: gcp-keda-auth
    metadata:
      subscriptionName: my-subscription
      value: "5"
      projectID: my-gcp-project
      credentialsFromEnv: GOOGLE_APPLICATION_CREDENTIALS
```

**Azure Service Bus:**

```yaml
  triggers:
  - type: azure-servicebus
    authenticationRef:
      name: azure-keda-auth
    metadata:
      queueName: orders
      messageCount: "20"
      namespace: my-servicebus-namespace
```

### Redis List Scaler

```yaml
  triggers:
  - type: redis
    authenticationRef:
      name: redis-auth
    metadata:
      address: redis-master.production:6379
      listName: job-queue
      listLength: "10"
      enableTLS: "true"
      databaseIndex: "0"
```

### HTTP Traffic Scaler (KEDA HTTP Add-on)

```yaml
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: api-http-scaler
  namespace: production
spec:
  hosts:
  - api.example.com
  scaleTargetRef:
    name: api-server
    port: 8080
  replicas:
    min: 0
    max: 20
  targetPendingRequests: 100
```

## Summary

KEDA transforms Kubernetes autoscaling from a reactive CPU/memory model to a proactive, event-driven model that scales precisely with actual workload demands. The combination of 60+ built-in scalers, external scaler extensibility, and ScaledJob support for batch workloads makes KEDA a foundational component for cost-efficient, responsive Kubernetes platforms.

Key takeaways:
- Use `lagThreshold` in Kafka scalers to set the target messages-per-replica ratio
- Combine cron triggers with reactive triggers for predictable baseline plus burst scaling
- Set `idleReplicaCount: 0` and `minReplicaCount: 0` together to enable scale-to-zero
- Always configure `fallback.replicas` to prevent zero-replica scenarios during scaler failures
- Monitor `keda_scaler_errors_total` and `keda_scaler_metrics_value` in Prometheus for operational visibility
- Remove existing HPAs before creating ScaledObjects to avoid ownership conflicts
