---
title: "Kubernetes KEDA: Event-Driven Autoscaling with Custom and External Scalers"
date: 2030-12-07T00:00:00-05:00
draft: false
tags: ["KEDA", "Kubernetes", "Autoscaling", "Event-Driven", "Kafka", "Redis", "Prometheus"]
categories:
- Kubernetes
- DevOps
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to KEDA architecture, built-in scalers for Kafka, Redis, Prometheus, and Azure Service Bus, custom scaler development, ScaledObject and ScaledJob resources, cooldown periods, and zero-to-N scaling patterns for event-driven workloads."
more_link: "yes"
url: "/kubernetes-keda-event-driven-autoscaling-custom-scalers/"
---

Kubernetes Horizontal Pod Autoscaler (HPA) scales based on CPU and memory utilization — lagging indicators of load. By the time CPU spikes high enough to trigger scaling, the backlog of work has already grown and users are already experiencing degradation. KEDA (Kubernetes Event-Driven Autoscaling) inverts this model: it scales based on the actual queue depth, message lag, or metric value that drives work, enabling proactive scaling that keeps pace with demand and scales to zero when there is nothing to process.

This guide covers KEDA's architecture and installation, every major built-in scaler (Kafka, Redis, Prometheus, Azure Service Bus), how to write a custom external scaler in Go for proprietary systems, the ScaledObject and ScaledJob resource configurations, cooldown and stabilization tuning, and zero-to-N patterns for batch workloads.

<!--more-->

# Kubernetes KEDA: Event-Driven Autoscaling with Custom and External Scalers

## KEDA Architecture

KEDA extends Kubernetes with two custom controllers and a metrics adapter:

1. **ScaledObject Controller**: Watches ScaledObject resources and manages an HPA resource for each one. It polls the configured scaler(s) to determine the desired replica count and updates the HPA accordingly.

2. **ScaledJob Controller**: Manages Jobs instead of Deployments. Creates new Job instances as work arrives and lets them complete naturally, rather than scaling a long-running Deployment.

3. **KEDA Metrics Server**: Implements the Kubernetes External Metrics API. The HPA queries this server for metric values, which KEDA fetches from the configured scaler.

The separation of concerns is important: KEDA handles the "how many replicas?" calculation, and the Kubernetes HPA handles the actual pod scheduling. This means KEDA works with all existing Kubernetes controllers, not just Deployments — StatefulSets, KEDA-managed Jobs, and custom controllers can all be scaled.

### Scaler Lifecycle

For each ScaledObject:
1. KEDA calls the scaler's `IsActive()` method to determine if the deployment should scale from 0
2. KEDA calls the scaler's `GetMetricsAndActivity()` to get the current metric value
3. The metric value is normalized to the `targetValue` in the ScaledObject to calculate the desired replica count
4. KEDA updates the HPA's `spec.metrics` with the external metric
5. The HPA's standard algorithm computes `desiredReplicas = ceil(currentReplicas * (currentValue / targetValue))`

## Installation

```bash
# Install KEDA via Helm
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --values keda-values.yaml
```

```yaml
# keda-values.yaml
replicaCount: 2  # HA deployment

resources:
  operator:
    requests:
      cpu: 100m
      memory: 100Mi
    limits:
      cpu: 1000m
      memory: 1000Mi

  metricServer:
    requests:
      cpu: 100m
      memory: 100Mi
    limits:
      cpu: 1000m
      memory: 1000Mi

# Enable Prometheus metrics for KEDA itself
prometheus:
  operator:
    enabled: true
    port: 8080
  metricServer:
    enabled: true
    port: 9022

# Webhook for validation
webhooks:
  enabled: true

# Log level
logging:
  operator:
    level: info
    format: json
  metricServer:
    level: 0
```

Verify installation:

```bash
kubectl get pods -n keda
kubectl get crd | grep keda

# Expected CRDs:
# clustertriggerauthentications.keda.sh
# scaledjobs.keda.sh
# scaledobjects.keda.sh
# triggerauthentications.keda.sh
```

## TriggerAuthentication: Credential Management

KEDA uses `TriggerAuthentication` resources to store credentials for scalers, keeping secrets out of the ScaledObject spec:

```yaml
# Store Kafka credentials in a Secret
apiVersion: v1
kind: Secret
metadata:
  name: kafka-credentials
  namespace: production
type: Opaque
stringData:
  username: kafka-consumer
  password: <kafka-password>
  tls.crt: <base64-encoded-tls-certificate>
---
# Reference the secret in a TriggerAuthentication
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: username
      name: kafka-credentials
      key: username
    - parameter: password
      name: kafka-credentials
      key: password
    - parameter: ca
      name: kafka-credentials
      key: tls.crt
```

For cluster-wide credentials, use `ClusterTriggerAuthentication`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: prometheus-auth
spec:
  secretTargetRef:
    - parameter: bearerToken
      name: prometheus-token
      namespace: monitoring
      key: token
```

## Kafka Scaler

The Kafka scaler measures consumer group lag and scales based on the number of unprocessed messages.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: order-processor
    kind: Deployment

  # Minimum and maximum replicas
  minReplicaCount: 1
  maxReplicaCount: 50

  # How long to wait after scaling before making another scaling decision
  cooldownPeriod: 300  # 5 minutes

  # How long to wait before scaling down after metrics normalize
  # Prevents flapping
  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Percent
              value: 25
              periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
            - type: Pods
              value: 4
              periodSeconds: 30

  triggers:
    - type: kafka
      authenticationRef:
        name: kafka-trigger-auth
      metadata:
        bootstrapServers: kafka.kafka.svc.cluster.local:9092
        consumerGroup: order-processor-group
        topic: orders
        # Scale by 1 replica per 100 unprocessed messages
        lagThreshold: "100"
        # Offset reset policy for new consumer groups
        offsetResetPolicy: latest
        # TLS configuration
        tls: enable
        # Allow scaling from 0 when messages arrive
        activationLagThreshold: "1"
```

### Kafka with Multiple Topics

```yaml
triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka.kafka.svc.cluster.local:9092
      consumerGroup: multi-topic-consumer
      topic: orders,returns,inventory  # Comma-separated
      lagThreshold: "50"
    authenticationRef:
      name: kafka-trigger-auth
```

### Kafka with Schema Registry

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-sasl-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: sasl
      name: kafka-sasl-credentials
      key: sasl
    - parameter: username
      name: kafka-sasl-credentials
      key: username
    - parameter: password
      name: kafka-sasl-credentials
      key: password
---
# ScaledObject using SASL authentication
triggers:
  - type: kafka
    authenticationRef:
      name: kafka-sasl-auth
    metadata:
      bootstrapServers: kafka.example.com:9093
      consumerGroup: my-consumer-group
      topic: my-topic
      lagThreshold: "100"
      sasl: plaintext  # or scram_sha256, scram_sha512, gssapi
      tls: enable
```

## Redis Scaler

The Redis scaler supports list length, sorted set cardinality, and stream lag scaling:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: task-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: task-worker
  minReplicaCount: 0
  maxReplicaCount: 20
  cooldownPeriod: 60

  triggers:
    # Scale based on Redis list length (job queue)
    - type: redis
      authenticationRef:
        name: redis-trigger-auth
      metadata:
        address: redis.redis.svc.cluster.local:6379
        listName: task-queue
        # Scale by 1 replica per 10 items in the list
        listLength: "10"
        databaseIndex: "0"
        enableTLS: "false"
        # Activate (scale from 0) when at least 1 item exists
        activationListLength: "1"
```

### Redis Cluster Scaler

```yaml
triggers:
  - type: redis-cluster
    authenticationRef:
      name: redis-cluster-auth
    metadata:
      addresses: "redis-cluster-0:6379,redis-cluster-1:6379,redis-cluster-2:6379"
      listName: distributed-queue
      listLength: "20"
```

### Redis Streams Scaler

```yaml
triggers:
  - type: redis-streams
    metadata:
      address: redis.redis.svc.cluster.local:6379
      stream: event-stream
      consumerGroup: event-processors
      # Scale based on pending messages in the consumer group
      pendingEntriesCount: "50"
      activationPendingEntriesCount: "1"
```

## Prometheus Scaler

The Prometheus scaler allows scaling based on any Prometheus query result:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: api-worker
  minReplicaCount: 2
  maxReplicaCount: 100

  triggers:
    - type: prometheus
      authenticationRef:
        name: prometheus-auth
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        # Scale based on request queue depth
        query: |
          sum(rate(http_requests_pending_total{service="api"}[2m]))
        # Target: 100 pending requests per worker replica
        threshold: "100"
        # Minimum value to trigger scaling from 0
        activationThreshold: "10"
        # Skip SSL verification (for dev environments)
        ignoreNullValues: "false"
```

### Multi-Metric Prometheus Scaling

Scale based on multiple metrics with KEDA's multi-trigger support:

```yaml
triggers:
  # Scale based on CPU utilization (custom application metric)
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      query: |
        avg(rate(process_cpu_seconds_total{pod=~"api-worker-.*"}[2m])) * 100
      threshold: "70"  # Scale when avg CPU > 70%

  # Also scale based on request latency (P95 > 500ms)
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
      query: |
        histogram_quantile(0.95,
          sum(rate(http_request_duration_seconds_bucket{service="api"}[2m]))
          by (le)
        ) * 1000
      threshold: "500"  # 500ms in milliseconds
```

When multiple triggers are configured, KEDA takes the maximum replica count across all triggers. This means scaling up happens when any trigger warrants more replicas, and scaling down only happens when all triggers agree fewer replicas are needed.

## Azure Service Bus Scaler

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: azure-servicebus-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: connection
      name: servicebus-connection-string
      key: connectionString
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: servicebus-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: servicebus-worker
  minReplicaCount: 0
  maxReplicaCount: 30
  cooldownPeriod: 120

  triggers:
    - type: azure-servicebus
      authenticationRef:
        name: azure-servicebus-auth
      metadata:
        queueName: order-processing
        # Scale by 1 replica per 50 active messages
        messageCount: "50"
        # Include dead-letter messages in count
        activationMessageCount: "5"
        cloud: AzurePublicCloud
```

## ScaledJob: Event-Driven Batch Processing

`ScaledJob` creates Kubernetes Jobs instead of scaling a Deployment. Each unit of work spawns an independent Job that processes its work and exits. This is ideal for batch processing, video transcoding, or any workload where each unit of work is independent.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: video-transcoder
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1          # Each Job runs 1 pod
    completions: 1
    template:
      spec:
        restartPolicy: OnFailure
        containers:
          - name: transcoder
            image: ghcr.io/myorg/video-transcoder:v2.1.0
            resources:
              requests:
                cpu: "2"
                memory: "4Gi"
              limits:
                cpu: "4"
                memory: "8Gi"
            env:
              - name: QUEUE_NAME
                value: video-transcoding-queue

  # ScaledJob-specific settings
  maxReplicaCount: 10       # Maximum concurrent Jobs
  scalingStrategy:
    strategy: accurate      # accurate | default | custom

  # How long KEDA waits before checking if old Jobs should be cleaned up
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 3

  # Polling interval for new messages
  pollingInterval: 30

  triggers:
    - type: redis
      metadata:
        address: redis.redis.svc.cluster.local:6379
        listName: video-transcoding-queue
        listLength: "1"  # 1 Job per message
        activationListLength: "1"
```

### ScaledJob Scaling Strategies

```yaml
scalingStrategy:
  # accurate: Each Job processes exactly 1 message.
  # KEDA creates exactly as many Jobs as there are messages.
  strategy: accurate

  # default: KEDA creates Jobs based on metric value, using the
  # standard HPA formula. Can result in multiple messages per Job.
  # strategy: default

  # custom: Specify a custom multiplier for message-to-Job ratio
  # strategy: custom
  # customScalingQueueLengthDeduction: 1
  # customScalingRunningJobPercentage: "0.5"
```

## Zero-to-N Scaling Pattern

KEDA's killer feature is scaling to zero replicas when there is no work, and back up immediately when work arrives. This requires careful configuration to avoid cold start latency.

### Configuration for Zero-to-N

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: batch-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: batch-processor

  # 0 means scale to zero when idle
  minReplicaCount: 0
  maxReplicaCount: 20

  # Time to wait before scaling to zero after all work is done
  cooldownPeriod: 300

  # How often to poll the scaler
  pollingInterval: 15

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.kafka.svc.cluster.local:9092
        consumerGroup: batch-processor-group
        topic: batch-jobs
        lagThreshold: "50"
        # CRITICAL: activationLagThreshold controls the scale-from-zero trigger
        # Setting to "0" means scale up as soon as any message arrives
        activationLagThreshold: "0"
```

### Managing Cold Start Latency

When scaling from 0, the pod must start before it can process messages. Minimize cold start with:

```yaml
# Optimized Deployment for fast cold starts
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: production
spec:
  replicas: 0  # KEDA manages this
  template:
    spec:
      containers:
        - name: processor
          image: ghcr.io/myorg/batch-processor:v1.5.0
          # Pre-warm connections at startup
          env:
            - name: PREWARM_CONNECTIONS
              value: "true"
          # Fast startup probes
          startupProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 2
            periodSeconds: 2
            failureThreshold: 15
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            periodSeconds: 5
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"

  # Pre-pull the image on all nodes via DaemonSet or imagePullPolicy
  # strategy settings for fast scaling
  strategy:
    rollingUpdate:
      maxSurge: 10
      maxUnavailable: 0
```

### Pre-scaling for Predictable Load

For workloads with predictable load patterns (batch runs at known times), use KEDA's cron scaler alongside the event scaler:

```yaml
triggers:
  # Event-driven scaling for unexpected load
  - type: kafka
    metadata:
      bootstrapServers: kafka.kafka.svc.cluster.local:9092
      consumerGroup: batch-processor-group
      topic: batch-jobs
      lagThreshold: "50"
      activationLagThreshold: "0"

  # Cron-based pre-scaling for the Monday morning batch window
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 6 * * 1"   # Monday 6 AM
      end: "0 12 * * 1"    # Monday 12 PM
      desiredReplicas: "10"  # Pre-scale to 10 replicas
```

## Custom External Scaler

When your queue system is not supported by built-in KEDA scalers, implement an external scaler — a gRPC server that KEDA calls to get metric values.

### External Scaler gRPC Protocol

The external scaler implements the KEDA `externalscaler.proto` interface:

```protobuf
service ExternalScaler {
    rpc IsActive(ScaledObjectRef) returns (IsActiveResponse) {}
    rpc StreamIsActive(ScaledObjectRef) returns (stream IsActiveResponse) {}
    rpc GetMetricSpec(ScaledObjectRef) returns (GetMetricSpecResponse) {}
    rpc GetMetrics(GetMetricsRequest) returns (GetMetricsResponse) {}
}
```

### Implementing a Custom Scaler in Go

This example implements a scaler for a hypothetical proprietary job queue:

```go
// cmd/custom-scaler/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "net"
    "strconv"
    "time"

    pb "github.com/kedacore/keda/v2/pkg/scaling/scaler/externalscaler"
    "google.golang.org/grpc"
    "google.golang.org/grpc/reflection"
)

// QueueClient is an interface to your proprietary queue system.
type QueueClient interface {
    GetQueueDepth(ctx context.Context, queueName string) (int64, error)
    IsHealthy(ctx context.Context) bool
}

// ExternalScalerServer implements the KEDA external scaler gRPC interface.
type ExternalScalerServer struct {
    pb.UnimplementedExternalScalerServer
    queueClient QueueClient
}

// IsActive determines whether the target Deployment should be active (non-zero replicas).
// Return true when there is work to process.
func (s *ExternalScalerServer) IsActive(
    ctx context.Context,
    ref *pb.ScaledObjectRef,
) (*pb.IsActiveResponse, error) {
    queueName := ref.ScalerMetadata["queueName"]
    if queueName == "" {
        return nil, fmt.Errorf("queueName metadata is required")
    }

    depth, err := s.queueClient.GetQueueDepth(ctx, queueName)
    if err != nil {
        log.Printf("IsActive: failed to get queue depth for %s: %v", queueName, err)
        // Return false (scale to 0) on error to be safe
        return &pb.IsActiveResponse{Result: false}, nil
    }

    activationThreshold := int64(1)
    if v := ref.ScalerMetadata["activationThreshold"]; v != "" {
        if parsed, err := strconv.ParseInt(v, 10, 64); err == nil {
            activationThreshold = parsed
        }
    }

    log.Printf("IsActive: queue=%s depth=%d threshold=%d", queueName, depth, activationThreshold)
    return &pb.IsActiveResponse{Result: depth >= activationThreshold}, nil
}

// StreamIsActive streams IsActive responses. KEDA uses this for real-time activation.
func (s *ExternalScalerServer) StreamIsActive(
    ref *pb.ScaledObjectRef,
    stream pb.ExternalScaler_StreamIsActiveServer,
) error {
    // Poll queue every 10 seconds and stream the result
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-stream.Context().Done():
            return nil
        case <-ticker.C:
            resp, err := s.IsActive(stream.Context(), ref)
            if err != nil {
                continue
            }
            if err := stream.Send(resp); err != nil {
                return err
            }
        }
    }
}

// GetMetricSpec returns the metric name and target value.
// KEDA uses this to register the external metric with the Kubernetes metrics API.
func (s *ExternalScalerServer) GetMetricSpec(
    ctx context.Context,
    ref *pb.ScaledObjectRef,
) (*pb.GetMetricSpecResponse, error) {
    queueName := ref.ScalerMetadata["queueName"]
    if queueName == "" {
        return nil, fmt.Errorf("queueName metadata is required")
    }

    threshold := int64(10)  // Default: 10 items per replica
    if v := ref.ScalerMetadata["threshold"]; v != "" {
        if parsed, err := strconv.ParseInt(v, 10, 64); err == nil {
            threshold = parsed
        }
    }

    return &pb.GetMetricSpecResponse{
        MetricSpecs: []*pb.MetricSpec{
            {
                MetricName: fmt.Sprintf("custom-queue-%s", queueName),
                TargetSize: threshold,
            },
        },
    }, nil
}

// GetMetrics returns the current metric value.
// KEDA calls this on every polling interval.
func (s *ExternalScalerServer) GetMetrics(
    ctx context.Context,
    req *pb.GetMetricsRequest,
) (*pb.GetMetricsResponse, error) {
    queueName := req.ScaledObjectRef.ScalerMetadata["queueName"]
    if queueName == "" {
        return nil, fmt.Errorf("queueName metadata is required")
    }

    depth, err := s.queueClient.GetQueueDepth(ctx, queueName)
    if err != nil {
        return nil, fmt.Errorf("getting queue depth: %w", err)
    }

    log.Printf("GetMetrics: queue=%s depth=%d", queueName, depth)

    return &pb.GetMetricsResponse{
        MetricValues: []*pb.MetricValue{
            {
                MetricName:  fmt.Sprintf("custom-queue-%s", queueName),
                MetricValue: depth,
            },
        },
    }, nil
}

func main() {
    lis, err := net.Listen("tcp", ":6000")
    if err != nil {
        log.Fatalf("failed to listen: %v", err)
    }

    // Create your queue client implementation
    queueClient := NewMyQueueClient()

    server := grpc.NewServer()
    pb.RegisterExternalScalerServer(server, &ExternalScalerServer{
        queueClient: queueClient,
    })
    reflection.Register(server)

    log.Printf("External scaler listening on :6000")
    if err := server.Serve(lis); err != nil {
        log.Fatalf("failed to serve: %v", err)
    }
}
```

### Deploying the Custom Scaler

```yaml
# Deploy the external scaler as a Service and Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: custom-queue-scaler
  namespace: keda
spec:
  replicas: 2  # HA for the scaler itself
  selector:
    matchLabels:
      app: custom-queue-scaler
  template:
    metadata:
      labels:
        app: custom-queue-scaler
    spec:
      containers:
        - name: scaler
          image: ghcr.io/myorg/custom-queue-scaler:v1.0.0
          ports:
            - containerPort: 6000
              name: grpc
          env:
            - name: QUEUE_SERVICE_ADDR
              value: queue-service.production.svc.cluster.local:8080
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
---
apiVersion: v1
kind: Service
metadata:
  name: custom-queue-scaler
  namespace: keda
spec:
  selector:
    app: custom-queue-scaler
  ports:
    - port: 6000
      targetPort: 6000
      name: grpc
```

### Using the Custom Scaler

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: custom-queue-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: custom-queue-worker
  minReplicaCount: 0
  maxReplicaCount: 25
  cooldownPeriod: 120

  triggers:
    - type: external
      metadata:
        scalerAddress: custom-queue-scaler.keda.svc.cluster.local:6000
        # These metadata values are passed to your scaler's methods
        queueName: production-jobs
        threshold: "20"         # 20 items per replica
        activationThreshold: "1"
```

## Cooldown and Stabilization Tuning

Proper cooldown configuration prevents thrashing (rapid scale-up and scale-down cycles):

```yaml
spec:
  # Basic cooldown: KEDA waits this long after scaling before considering scale-down
  cooldownPeriod: 300  # 5 minutes

  # Advanced HPA behavior configuration
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          # Don't scale down for 5 minutes after the last scale-up
          stabilizationWindowSeconds: 300
          policies:
            # Scale down at most 25% of replicas per minute
            - type: Percent
              value: 25
              periodSeconds: 60
            # Or at most 2 pods per minute (whichever is more conservative)
            - type: Pods
              value: 2
              periodSeconds: 60
          # Use 'Min' to apply the most conservative policy
          selectPolicy: Min

        scaleUp:
          # Scale up aggressively (no stabilization window)
          stabilizationWindowSeconds: 0
          policies:
            # Add up to 4 pods per 30 seconds
            - type: Pods
              value: 4
              periodSeconds: 30
            # Or up to 100% of current replicas per minute
            - type: Percent
              value: 100
              periodSeconds: 60
          # Use 'Max' to apply the most aggressive policy
          selectPolicy: Max
```

## Monitoring KEDA

```yaml
# PrometheusRule for KEDA health monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: keda-alerts
  namespace: keda
spec:
  groups:
    - name: keda
      rules:
        - alert: KEDAScalerErrors
          expr: keda_scaler_errors_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA scaler is reporting errors"
            description: "Scaler {{ $labels.scaler }} for ScaledObject {{ $labels.scaledObject }} has {{ $value }} errors"

        - alert: KEDAScaledObjectNotReady
          expr: keda_scaled_object_paused == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "KEDA ScaledObject is paused"
            description: "ScaledObject {{ $labels.namespace }}/{{ $labels.scaledObject }} is paused"

        - alert: KEDAMaxReplicasReached
          expr: |
            keda_scaler_metrics_value
            /
            keda_scaler_metrics_target_value
            > 0.95
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "KEDA scaler approaching max replicas"
            description: "ScaledObject {{ $labels.scaledObject }} is at {{ $value | humanizePercentage }} of max replicas"
```

## Troubleshooting

### ScaledObject Not Scaling

```bash
# Check ScaledObject status
kubectl describe scaledobject order-processor-scaler -n production

# Look for events
kubectl get events -n production --field-selector reason=KEDAScalersStarted

# Check KEDA operator logs
kubectl logs -n keda -l app.kubernetes.io/name=keda-operator --tail=50

# Manually test the scaler
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/custom-queue-production-jobs" | jq .
```

### Scaling to Zero Issues

```bash
# Check if the HPA is managing zero replicas
kubectl get hpa -n production

# Verify the ScaledObject spec
kubectl get scaledobject -n production -o yaml

# Check if minReplicaCount is 0
# Check if activationLagThreshold (or equivalent) is set
```

## Summary

KEDA transforms Kubernetes autoscaling from a reactive, metrics-lag model to a proactive, event-driven model. The built-in scalers cover the most common queue systems (Kafka, Redis, Azure Service Bus) and observability tools (Prometheus), while the external scaler gRPC interface enables custom scalers for any proprietary system in under 200 lines of Go. Zero-to-N scaling with properly tuned cooldown periods eliminates idle resource waste while aggressive scale-up policies ensure responsiveness to sudden load. Combined with ScaledJob for batch workloads and cron-based pre-scaling for predictable patterns, KEDA provides a complete autoscaling solution for event-driven architectures.
