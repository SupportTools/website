---
title: "Kubernetes KEDA Event-Driven Autoscaling: Kafka, Redis, Prometheus Scalers, and Custom External Scalers"
date: 2031-10-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "Kafka", "Redis", "Prometheus", "Event-Driven"]
categories:
- Kubernetes
- Autoscaling
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to KEDA (Kubernetes Event-Driven Autoscaling): installing KEDA 2.x, configuring Kafka consumer lag scalers, Redis list length scalers, Prometheus metric scalers, and building custom external gRPC scalers for proprietary event sources."
more_link: "yes"
url: "/kubernetes-keda-event-driven-autoscaling-kafka-redis-prometheus/"
---

The Horizontal Pod Autoscaler scales on CPU and memory, but most real workloads scale on business signals: queue depth, consumer lag, pending request count, or a custom metric from a proprietary system. KEDA bridges that gap by implementing a custom metrics API server and a controller that configures HPA with external and custom metrics sourced from dozens of built-in scalers. This guide covers KEDA 2.x installation, production-ready scaler configurations for Kafka, Redis, and Prometheus, and the implementation of a custom external scaler using the gRPC protocol.

<!--more-->

# Kubernetes KEDA Event-Driven Autoscaling

## Section 1: KEDA Architecture

KEDA consists of three components:

**keda-operator**: Watches `ScaledObject` and `ScaledJob` resources. Manages HPA lifecycle and queries scalers for metric values.

**keda-metrics-apiserver**: Implements the Kubernetes External Metrics API. The HPA controller queries this server for metric values when making scaling decisions.

**keda-admission-webhooks**: Validates `ScaledObject` resources on creation and update.

```
┌─────────────────────────────────────────────────────────┐
│  Kubernetes Control Plane                                │
│                                                          │
│  ┌──────────────────────┐   ┌───────────────────────┐   │
│  │  HPA Controller       │──▶│  KEDA Metrics API     │   │
│  │  (queries metrics)    │   │  Server               │   │
│  └──────────────────────┘   └───────────┬───────────┘   │
│                                          │               │
│  ┌──────────────────────┐               │               │
│  │  KEDA Operator        │◀─────────────┘               │
│  │  (ScaledObject ctrl)  │   queries scalers            │
│  └──────────┬───────────┘                               │
└─────────────┼───────────────────────────────────────────┘
              │
    ┌─────────▼──────────────────────────────────┐
    │  External Systems                           │
    │  Kafka, Redis, Prometheus, RabbitMQ, etc.  │
    └─────────────────────────────────────────────┘
```

The HPA controller remains the mechanism that actually scales deployments; KEDA provides the metric values.

## Section 2: Installation

### Helm Installation

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.15.0 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=128Mi \
  --set resources.operator.limits.cpu=500m \
  --set resources.operator.limits.memory=256Mi \
  --set resources.metricApiServer.requests.cpu=100m \
  --set resources.metricApiServer.requests.memory=128Mi \
  --set prometheus.operator.enabled=true \
  --set prometheus.metricApiServer.enabled=true

# Verify installation
kubectl get pods -n keda
# keda-operator-...           1/1  Running
# keda-metrics-apiserver-...  1/1  Running
# keda-admission-webhooks-... 1/1  Running
```

### Verify External Metrics API

```bash
kubectl get apiservice v1beta1.external.metrics.k8s.io
# NAME                             SERVICE                     AVAILABLE
# v1beta1.external.metrics.k8s.io keda/keda-metrics-apiserver True
```

## Section 3: Kafka Scaler

The Kafka scaler measures consumer group lag (the difference between the latest offset and the committed offset) and scales workers to process the backlog.

### TriggerAuthentication for Kafka SASL/TLS

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-sasl-secret
  namespace: production
type: Opaque
stringData:
  sasl-username: "keda-consumer"
  sasl-password: "kafka-password-changeme"
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-sasl-secret
      key: sasl-username
    - parameter: password
      name: kafka-sasl-secret
      key: sasl-password
```

### ScaledObject for Kafka Consumer Deployment

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor

  # Minimum and maximum replicas (0 min = scale to zero)
  minReplicaCount: 2
  maxReplicaCount: 50

  # Stabilization windows
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300  # 5 minutes before scaling down
          policies:
            - type: Percent
              value: 25           # reduce by at most 25% per period
              periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0    # scale up immediately
          policies:
            - type: Pods
              value: 10           # add at most 10 pods per period
              periodSeconds: 30

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: "kafka-cluster.data-platform.svc.cluster.local:9092"
        consumerGroup: order-processor-group
        topic: orders.created
        # Scale 1 pod per N messages of lag
        lagThreshold: "100"
        # Offset reset policy if no committed offset exists
        offsetResetPolicy: latest
        # Authentication
        sasl: scram_sha512
        tls: enable
        # Lag calculation: how many partitions drive the metric
        partitionLimitation: ""  # empty = all partitions
      authenticationRef:
        name: kafka-trigger-auth
```

### Multi-Topic Scaler

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: event-processor-multi-topic
  namespace: production
spec:
  scaleTargetRef:
    name: event-processor
  minReplicaCount: 1
  maxReplicaCount: 100
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: "kafka-cluster.data-platform.svc.cluster.local:9092"
        consumerGroup: event-processor-group
        topic: events.high-priority
        lagThreshold: "50"   # more aggressive for high-priority
      authenticationRef:
        name: kafka-trigger-auth
    - type: kafka
      metadata:
        bootstrapServers: "kafka-cluster.data-platform.svc.cluster.local:9092"
        consumerGroup: event-processor-group
        topic: events.standard
        lagThreshold: "500"  # more relaxed for standard
      authenticationRef:
        name: kafka-trigger-auth
```

KEDA takes the maximum of all triggers when determining the desired replica count.

## Section 4: Redis Scaler

### Redis List Length Scaler

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: redis-secret
  namespace: production
stringData:
  connection: "rediss://default:redis-password-changeme@redis-cluster.cache.svc.cluster.local:6380"
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: address
      name: redis-secret
      key: connection
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: notification-sender-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: notification-sender
  minReplicaCount: 0   # scale to zero when queue is empty
  maxReplicaCount: 20
  pollingInterval: 10   # check every 10 seconds
  cooldownPeriod: 60    # wait 60s before scaling to zero
  triggers:
    - type: redis
      metadata:
        listName: notification-queue
        listLength: "10"   # 1 pod per 10 items
        activationListLength: "1"  # activate (from 0) at 1 item
        databaseIndex: "0"
      authenticationRef:
        name: redis-trigger-auth
```

### Redis Streams Scaler (Consumer Group Lag)

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: stream-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: stream-processor
  minReplicaCount: 1
  maxReplicaCount: 30
  triggers:
    - type: redis-streams
      metadata:
        stream: analytics-events
        consumerGroup: analytics-processor
        pendingEntriesCount: "200"  # scale at 200 unprocessed entries
        streamLength: ""             # optional: also scale on stream length
      authenticationRef:
        name: redis-trigger-auth
```

## Section 5: Prometheus Scaler

The Prometheus scaler evaluates a PromQL query and scales based on the result.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 3
  maxReplicaCount: 100
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 180
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        # Requests per second per pod target
        # Scale so each pod handles ~500 req/s
        metricName: http_requests_per_second
        query: |
          sum(rate(http_requests_total{namespace="production",
            service="api-server"}[2m]))
        threshold: "500"
        # activationThreshold: start scaling from 0 at this value
        activationThreshold: "10"
        ignoreNullValues: "false"
```

### Multi-Metric Prometheus Scaler

```yaml
# Scale on both CPU-equivalent load AND request rate
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ml-inference-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: ml-inference-server
  minReplicaCount: 2
  maxReplicaCount: 40
  triggers:
    # Scale based on pending inference requests
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        metricName: inference_queue_depth
        query: |
          sum(inference_request_queue_size{namespace="production"})
        threshold: "20"  # 1 pod per 20 queued requests

    # Scale based on GPU utilization
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        metricName: gpu_utilization
        query: |
          avg(DCGM_FI_DEV_GPU_UTIL{namespace="production",
            pod=~"ml-inference-.*"}) / 100
        threshold: "0.7"  # scale out when average GPU util > 70%
```

## Section 6: ScaledJob for Batch Processing

For batch jobs that should run once per event, use `ScaledJob` instead of `ScaledObject`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: etl-batch-job
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    backoffLimit: 3
    template:
      spec:
        containers:
          - name: etl-worker
            image: registry.example.com/etl-worker:v3.2.1
            env:
              - name: KAFKA_BROKERS
                value: "kafka-cluster.data-platform.svc.cluster.local:9092"
              - name: CONSUMER_GROUP
                value: "etl-batch-group"
            resources:
              requests:
                cpu: 500m
                memory: 1Gi
              limits:
                cpu: 2000m
                memory: 4Gi
        restartPolicy: Never
        serviceAccountName: etl-worker

  pollingInterval: 30
  maxReplicaCount: 10

  # Cleanup policy for completed/failed jobs
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 5

  # Scale mode: how to calculate replicas from metric
  # AccurateReplicas: one job per event (lagThreshold=1)
  # MultipleScalersCalculation: max of all trigger metrics
  scalingStrategy:
    strategy: "accurate"
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "0.5"

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: "kafka-cluster.data-platform.svc.cluster.local:9092"
        consumerGroup: etl-batch-group
        topic: etl.tasks.pending
        lagThreshold: "1"  # 1 job per pending message
      authenticationRef:
        name: kafka-trigger-auth
```

## Section 7: ClusterTriggerAuthentication for Shared Credentials

When multiple namespaces use the same Kafka cluster, define credentials once at cluster scope:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-cluster-auth
  namespace: keda   # stored in keda namespace
stringData:
  username: "keda-cluster-consumer"
  password: "kafka-cluster-password-changeme"
---
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: kafka-cluster-auth
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-cluster-auth
      key: username
    - parameter: password
      name: kafka-cluster-auth
      key: password
---
# Reference from any namespace
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: payment-processor-scaler
  namespace: payment-team
spec:
  scaleTargetRef:
    name: payment-processor
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: "kafka-cluster.data-platform.svc.cluster.local:9092"
        consumerGroup: payment-processor-group
        topic: payments.incoming
        lagThreshold: "50"
      authenticationRef:
        name: kafka-cluster-auth
        kind: ClusterTriggerAuthentication   # reference cluster-scoped auth
```

## Section 8: Building a Custom External Scaler

For proprietary event sources not covered by built-in scalers, implement the `ExternalScaler` gRPC interface.

### Proto Definition

```protobuf
// external_scaler.proto (from KEDA)
syntax = "proto3";
package externalscaler;

service ExternalScaler {
  rpc IsActive(ScaledObjectRef) returns (IsActiveResponse) {}
  rpc GetMetricSpec(ScaledObjectRef) returns (GetMetricSpecResponse) {}
  rpc GetMetrics(GetMetricsRequest) returns (GetMetricsResponse) {}
  rpc StreamIsActive(ScaledObjectRef) returns (stream IsActiveResponse) {}
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

### Go Implementation

```go
package externalscaler

import (
    "context"
    "fmt"
    "log/slog"
    "net"
    "strconv"

    pb "github.com/example/keda-scaler/proto"
    "google.golang.org/grpc"
    "google.golang.org/grpc/reflection"
)

// WorkQueueDepthScaler scales based on a proprietary work queue API.
type WorkQueueDepthScaler struct {
    pb.UnimplementedExternalScalerServer
    queueClient WorkQueueClient
}

type WorkQueueClient interface {
    GetQueueDepth(ctx context.Context, queueName string) (int64, error)
}

// IsActive returns true when there is at least one item in the queue.
// This controls scale-to-zero behavior.
func (s *WorkQueueDepthScaler) IsActive(
    ctx context.Context, ref *pb.ScaledObjectRef) (*pb.IsActiveResponse, error) {

    queueName, ok := ref.ScalerMetadata["queueName"]
    if !ok {
        return nil, fmt.Errorf("missing metadata: queueName")
    }

    depth, err := s.queueClient.GetQueueDepth(ctx, queueName)
    if err != nil {
        slog.Error("GetQueueDepth failed", "queue", queueName, "err", err)
        // Return active=true on error to avoid scaling to zero incorrectly
        return &pb.IsActiveResponse{Result: true}, nil
    }

    activationThreshold := int64(1)
    if v, ok := ref.ScalerMetadata["activationThreshold"]; ok {
        if n, err := strconv.ParseInt(v, 10, 64); err == nil {
            activationThreshold = n
        }
    }

    return &pb.IsActiveResponse{Result: depth >= activationThreshold}, nil
}

// GetMetricSpec declares the metric name and target value per replica.
func (s *WorkQueueDepthScaler) GetMetricSpec(
    ctx context.Context, ref *pb.ScaledObjectRef) (*pb.GetMetricSpecResponse, error) {

    queueName := ref.ScalerMetadata["queueName"]
    targetStr := ref.ScalerMetadata["targetDepthPerReplica"]
    target := int64(10) // default: 10 items per replica
    if n, err := strconv.ParseInt(targetStr, 10, 64); err == nil {
        target = n
    }

    return &pb.GetMetricSpecResponse{
        MetricSpecs: []*pb.MetricSpec{
            {
                MetricName: fmt.Sprintf("work_queue_depth_%s", queueName),
                TargetSize: target,
            },
        },
    }, nil
}

// GetMetrics returns the current metric value.
func (s *WorkQueueDepthScaler) GetMetrics(
    ctx context.Context, req *pb.GetMetricsRequest) (*pb.GetMetricsResponse, error) {

    queueName := req.ScaledObjectRef.ScalerMetadata["queueName"]

    depth, err := s.queueClient.GetQueueDepth(ctx, queueName)
    if err != nil {
        return nil, fmt.Errorf("GetQueueDepth %s: %w", queueName, err)
    }

    slog.Debug("GetMetrics", "queue", queueName, "depth", depth)

    return &pb.GetMetricsResponse{
        MetricValues: []*pb.MetricValue{
            {
                MetricName:  req.MetricName,
                MetricValue: depth,
            },
        },
    }, nil
}

// Serve starts the gRPC server on the given address.
func Serve(ctx context.Context, addr string, scaler *WorkQueueDepthScaler) error {
    lis, err := net.Listen("tcp", addr)
    if err != nil {
        return fmt.Errorf("listen %s: %w", addr, err)
    }

    srv := grpc.NewServer()
    pb.RegisterExternalScalerServer(srv, scaler)
    reflection.Register(srv)

    go func() {
        <-ctx.Done()
        srv.GracefulStop()
    }()

    slog.Info("External scaler serving", "addr", addr)
    return srv.Serve(lis)
}
```

### Deploying the Custom Scaler

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: work-queue-external-scaler
  namespace: keda
spec:
  replicas: 2
  selector:
    matchLabels:
      app: work-queue-external-scaler
  template:
    metadata:
      labels:
        app: work-queue-external-scaler
    spec:
      containers:
        - name: scaler
          image: registry.example.com/keda-external-scaler:v1.0.0
          ports:
            - name: grpc
              containerPort: 9000
          env:
            - name: WORK_QUEUE_API
              value: "http://work-queue-api.internal.svc.cluster.local"
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          readinessProbe:
            grpc:
              port: 9000
            initialDelaySeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: work-queue-external-scaler
  namespace: keda
spec:
  selector:
    app: work-queue-external-scaler
  ports:
    - name: grpc
      port: 9000
      targetPort: 9000
---
# ScaledObject using the custom external scaler
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: work-queue-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: work-queue-processor
  minReplicaCount: 0
  maxReplicaCount: 50
  triggers:
    - type: external
      metadata:
        scalerAddress: "work-queue-external-scaler.keda.svc.cluster.local:9000"
        queueName: "high-priority-tasks"
        targetDepthPerReplica: "5"
        activationThreshold: "1"
```

## Section 9: Monitoring KEDA with Prometheus

KEDA exposes Prometheus metrics for its operator and metrics server:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: keda-operator
  namespace: monitoring
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
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keda-alerts
  namespace: monitoring
spec:
  groups:
    - name: keda.scaling
      rules:
        - alert: KEDAScaledObjectNotActive
          expr: |
            keda_scaler_active{type!="external"} == 0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "ScaledObject {{ $labels.scaledObject }} in {{ $labels.namespace }} has been inactive for 30m"

        - alert: KEDAScalerErrors
          expr: |
            sum by (namespace, scaledObject, scaler) (
              rate(keda_scaler_errors_total[5m])
            ) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA scaler errors for {{ $labels.scaledObject }}/{{ $labels.scaler }}"

        - alert: KEDAOperatorDown
          expr: |
            up{job="keda-operator"} == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "KEDA operator is down — autoscaling is disabled"
```

## Section 10: Cron-Based Scheduled Scaling

KEDA's `cron` scaler supplements event-driven scaling with predictive capacity for known peak periods:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-combined-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 3
  maxReplicaCount: 100
  triggers:
    # Event-driven: scale on request rate
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        metricName: rps_per_pod
        query: |
          sum(rate(http_requests_total{service="api-server"}[2m]))
        threshold: "500"

    # Predictive: maintain minimum 20 replicas during business hours (US/Eastern)
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 8 * * 1-5"    # 08:00 weekdays
        end: "0 20 * * 1-5"     # 20:00 weekdays
        desiredReplicas: "20"

    # Maintain minimum 10 replicas during late-evening traffic
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 20 * * *"
        end: "0 2 * * *"
        desiredReplicas: "10"
```

## Section 11: Troubleshooting KEDA

### Diagnosing ScaledObject Issues

```bash
# Check ScaledObject status
kubectl describe scaledobject order-processor-scaler -n production

# Expected conditions:
# Type              Status  Reason
# Active            True    ScalerActive
# Ready             True    ScaledObjectReady
# Fallback          False   NoFallbackFound

# Check KEDA operator logs
kubectl logs -n keda deployment/keda-operator --tail=100 | \
  grep -E "error|warn|order-processor"

# Check metrics server logs
kubectl logs -n keda deployment/keda-metrics-apiserver --tail=50

# Query the external metrics API directly
kubectl get --raw \
  "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/s0-kafka-orders.created"

# Manually trigger a metric poll
kubectl patch scaledobject order-processor-scaler \
  -n production \
  --type='merge' \
  -p '{"metadata":{"annotations":{"autoscaling.keda.sh/paused-replicas": "5"}}}'
# Then remove the annotation to resume
```

### Testing Scalers Without Deploying Workloads

```bash
# Check if a specific Kafka topic has lag
kubectl run keda-debug --image=confluentinc/cp-kafka:7.7.0 \
  --restart=Never -n production -- \
  kafka-consumer-groups.sh \
    --bootstrap-server kafka-cluster.data-platform.svc.cluster.local:9092 \
    --group order-processor-group \
    --describe

# Check Redis list length
kubectl run redis-debug --image=redis:7.4 \
  --restart=Never -n production -- \
  redis-cli -u "$(kubectl get secret redis-secret -n production \
    -o jsonpath='{.data.connection}' | base64 -d)" \
  LLEN notification-queue
```

## Summary

KEDA transforms Kubernetes autoscaling from a CPU-centric reactive model into an event-driven system that scales on business signals. The built-in Kafka, Redis, and Prometheus scalers cover the majority of production use cases, while the custom external scaler gRPC interface handles proprietary event sources. `ScaledJob` extends the model to batch processing patterns where each event should spawn exactly one job. Combined with the cron scaler for predictive capacity, KEDA provides the complete autoscaling solution needed to handle variable-load production workloads without over-provisioning.
