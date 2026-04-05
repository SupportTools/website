---
title: "Kubernetes KEDA Advanced Scaling: HTTP Add-on, Custom Metrics, Cron Scalers, and Scale-to-Zero Patterns"
date: 2032-03-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "KEDA", "Autoscaling", "HTTP", "Custom Metrics", "Cron", "Scale-to-Zero"]
categories:
- Kubernetes
- Autoscaling
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep-dive into KEDA advanced scaling patterns including the HTTP Add-on, custom external metrics, cron-based scheduling, and scale-to-zero strategies for production Kubernetes workloads."
more_link: "yes"
url: "/kubernetes-keda-advanced-scaling-http-addon-custom-metrics-cron-scale-to-zero/"
---

Kubernetes Event-Driven Autoscaling (KEDA) extends the native Horizontal Pod Autoscaler with a rich ecosystem of scalers that respond to external signals rather than just CPU and memory. When combined with the HTTP Add-on for request-driven scaling, custom external metrics, cron-based scheduling, and scale-to-zero semantics, KEDA becomes a complete autoscaling platform capable of driving significant infrastructure cost reductions in production environments.

This guide covers advanced KEDA patterns used at enterprise scale, including multi-scaler composition, the nuances of scale-to-zero with graceful traffic handling, and the operational mechanics of the HTTP Add-on interceptor proxy.

<!--more-->

## KEDA Architecture and Core Concepts

### Component Overview

KEDA deploys three primary components into the cluster:

1. **keda-operator** - Watches ScaledObject and ScaledJob resources, queries scalers, and drives the HPA
2. **keda-operator-metrics-apiserver** - Implements the external metrics API so the HPA can consume KEDA-provided metrics
3. **keda-admission-webhooks** - Validates ScaledObject manifests before admission

```
                    ┌─────────────────┐
                    │   External      │
                    │   Metrics       │
                    │   Sources       │
                    └────────┬────────┘
                             │  poll / push
                    ┌────────▼────────┐
                    │  keda-operator  │
                    │  (scaler loop)  │
                    └────────┬────────┘
                             │  update desiredReplicas
                    ┌────────▼────────┐
           ┌────────│      HPA        │────────┐
           │        └─────────────────┘        │
           │                                   │
    ┌──────▼──────┐                   ┌────────▼────────┐
    │  ReplicaSet │                   │  metrics-server  │
    │  / Deploy   │                   │  (CPU / mem)     │
    └─────────────┘                   └──────────────────┘
```

### Installation via Helm

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set watchNamespace="" \
  --set operator.replicaCount=2 \
  --set metricsServer.replicaCount=2 \
  --set resources.operator.requests.cpu=100m \
  --set resources.operator.requests.memory=128Mi \
  --set resources.operator.limits.cpu=500m \
  --set resources.operator.limits.memory=512Mi \
  --set prometheus.operator.enabled=true \
  --set prometheus.metricServer.enabled=true
```

Verify the installation:

```bash
kubectl get pods -n keda
kubectl get crd | grep keda
```

Expected CRDs:

```
clustertriggerauthentications.keda.sh
scaledjobs.keda.sh
scaledobjects.keda.sh
triggerauthentications.keda.sh
```

---

## ScaledObject Deep Dive

A `ScaledObject` is the primary resource that links a deployment (or any scale target) to one or more scalers.

### Basic ScaledObject Structure

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: my-app-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  pollingInterval: 15        # seconds between metric polls
  cooldownPeriod: 300        # seconds to wait before scaling to zero
  idleReplicaCount: 0        # target replica count when idle (scale-to-zero)
  minReplicaCount: 1         # minimum replicas when active
  maxReplicaCount: 50        # hard ceiling
  fallback:
    failureThreshold: 3      # consecutive failures before fallback
    replicas: 3              # replicas to use during scaler failure
  advanced:
    restoreToOriginalReplicaCount: true
    horizontalPodAutoscalerConfig:
      name: my-app-hpa
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
          - type: Pods
            value: 4
            periodSeconds: 15
          - type: Percent
            value: 100
            periodSeconds: 15
          selectPolicy: Max
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: http_requests_per_second
      threshold: "100"
      query: sum(rate(http_requests_total{namespace="production",app="my-app"}[2m]))
```

### Understanding pollingInterval vs HPA Sync

KEDA polls scalers every `pollingInterval` seconds. The HPA then reconciles the actual pod count. For fast-responding workloads, a `pollingInterval` of 5–10 seconds is appropriate; for cost-sensitive batch workloads, 30–60 seconds reduces API pressure.

---

## HTTP Add-on: Request-Driven Scale-to-Zero

The KEDA HTTP Add-on solves the fundamental problem with scale-to-zero: if there are zero pods, who handles the first incoming request while new pods are starting?

### Architecture

The HTTP Add-on deploys an **interceptor proxy** that sits between the Ingress and the application pods. Incoming requests are queued by the interceptor while KEDA scales up the deployment, then forwarded once pods become ready.

```
Client → Ingress → HTTP Add-on Interceptor → Application Pods
                          │
                          └─ Metrics → KEDA HTTP Scaler → HPA → Pods
```

### HTTP Add-on Installation

```bash
helm install http-add-on kedacore/keda-add-ons-http \
  --namespace keda \
  --version 0.8.0 \
  --set interceptor.replicas.min=2 \
  --set interceptor.replicas.max=5 \
  --set interceptor.responseTimeout=1500 \
  --set scaler.replicas=2 \
  --set waitTimeout=20s
```

### HTTPScaledObject Configuration

```yaml
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: my-api-http-scaledobject
  namespace: production
spec:
  hosts:
  - my-api.example.com
  pathPrefixes:
  - /api/v1
  - /api/v2
  scaleTargetRef:
    deployment: my-api
    service: my-api-svc
    port: 8080
  replicas:
    min: 0          # true scale-to-zero
    max: 30
  scaledownPeriod: 300  # seconds of no traffic before scaling to zero
  targetPendingRequests: 100  # queue depth per pod
```

The corresponding Service and Deployment:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-api-svc
  namespace: production
spec:
  selector:
    app: my-api
  ports:
  - port: 8080
    targetPort: 8080
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-api
  namespace: production
spec:
  replicas: 0   # KEDA manages this
  selector:
    matchLabels:
      app: my-api
  template:
    metadata:
      labels:
        app: my-api
    spec:
      containers:
      - name: my-api
        image: registry.example.com/my-api:v1.2.3
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 3
          successThreshold: 1
          failureThreshold: 3
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
```

### Ingress Configuration for HTTP Add-on

The Ingress must route to the HTTP Add-on interceptor service, not directly to the application:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-api-ingress
  namespace: production
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
spec:
  ingressClassName: nginx
  rules:
  - host: my-api.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: keda-add-ons-http-interceptor-proxy
            port:
              number: 8080
```

The interceptor uses the `Host` header to determine which `HTTPScaledObject` owns the request.

### Interceptor Timeout Tuning

When pods are cold-starting, the interceptor must queue requests. The key tunables:

```bash
# Set via Helm values or environment variables on the interceptor deployment
KEDA_HTTP_INTERCEPTOR_RESPONSE_TIMEOUT=30s     # max queue wait per request
KEDA_HTTP_INTERCEPTOR_CONNECT_TIMEOUT=5s       # TCP connect timeout to backend
KEDA_HTTP_INTERCEPTOR_KEEP_ALIVE_TIMEOUT=30s
KEDA_HTTP_SCALER_POLLING_INTERVAL=1s           # how fast scaler notices new requests
```

Validate interceptor health:

```bash
kubectl get pods -n keda -l app=keda-add-ons-http-interceptor
kubectl logs -n keda -l app=keda-add-ons-http-interceptor --tail=50
```

---

## Custom External Metrics Scalers

### Prometheus Scaler with Complex PromQL

The Prometheus scaler is the most versatile custom scaler. Complex PromQL expressions allow scaling on business metrics:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: order-processor
  minReplicaCount: 2
  maxReplicaCount: 100
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: pending_orders_depth
      threshold: "50"
      # Scale based on queue depth minus processing capacity
      query: |
        max(
          keda_orders_pending_total{namespace="production"}
          /
          on() group_left
          scalar(keda_order_processor_capacity_total{namespace="production"})
        )
      ignoreNullValues: "false"
      queryParameters:
        timeout: "30s"
```

### External Scaler with gRPC

For metrics not available via standard scalers, a custom external scaler implements the KEDA gRPC protocol.

The proto definition (from KEDA):

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

A Go implementation of a custom external scaler:

```go
package main

import (
	"context"
	"fmt"
	"log"
	"net"

	pb "github.com/example/keda-scaler/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
)

type externalScalerServer struct {
	pb.UnimplementedExternalScalerServer
	metricsClient MetricsClient
}

func (s *externalScalerServer) IsActive(
	ctx context.Context,
	ref *pb.ScaledObjectRef,
) (*pb.IsActiveResponse, error) {
	queueDepth, err := s.metricsClient.GetQueueDepth(ctx, ref.ScalerMetadata["queueName"])
	if err != nil {
		return nil, fmt.Errorf("getting queue depth: %w", err)
	}
	return &pb.IsActiveResponse{Result: queueDepth > 0}, nil
}

func (s *externalScalerServer) GetMetricSpec(
	ctx context.Context,
	ref *pb.ScaledObjectRef,
) (*pb.GetMetricSpecResponse, error) {
	return &pb.GetMetricSpecResponse{
		MetricSpecs: []*pb.MetricSpec{
			{
				MetricName: "custom_queue_depth",
				TargetSize: 10,
			},
		},
	}, nil
}

func (s *externalScalerServer) GetMetrics(
	ctx context.Context,
	req *pb.GetMetricsRequest,
) (*pb.GetMetricsResponse, error) {
	queueName := req.ScaledObjectRef.ScalerMetadata["queueName"]
	depth, err := s.metricsClient.GetQueueDepth(ctx, queueName)
	if err != nil {
		return nil, fmt.Errorf("getting queue depth for %s: %w", queueName, err)
	}
	return &pb.GetMetricsResponse{
		MetricValues: []*pb.MetricValue{
			{
				MetricName:  "custom_queue_depth",
				MetricValue: depth,
			},
		},
	}, nil
}

func (s *externalScalerServer) StreamIsActive(
	ref *pb.ScaledObjectRef,
	stream pb.ExternalScaler_StreamIsActiveServer,
) error {
	// Long-polling implementation for push-based scaling
	for {
		select {
		case <-stream.Context().Done():
			return nil
		}
	}
}

func main() {
	lis, err := net.Listen("tcp", ":6000")
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}

	server := grpc.NewServer()
	pb.RegisterExternalScalerServer(server, &externalScalerServer{
		metricsClient: NewMetricsClient(),
	})
	reflection.Register(server)

	log.Println("External scaler listening on :6000")
	if err := server.Serve(lis); err != nil {
		log.Fatalf("failed to serve: %v", err)
	}
}
```

ScaledObject referencing the external scaler:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: custom-queue-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: queue-processor
  minReplicaCount: 0
  maxReplicaCount: 20
  triggers:
  - type: external
    metadata:
      scalerAddress: custom-keda-scaler.keda.svc.cluster.local:6000
      queueName: "critical-orders"
      tlsName: "keda-external-scaler-tls"
```

---

## Cron Scaler: Time-Based Scaling

The cron scaler pre-scales deployments based on predictable traffic patterns, eliminating cold-start latency during known peak windows.

### Basic Cron ScaledObject

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: batch-job-cron-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: batch-processor
  minReplicaCount: 0
  maxReplicaCount: 50
  triggers:
  - type: cron
    metadata:
      timezone: "America/New_York"
      start: "0 7 * * 1-5"    # 7:00 AM weekdays
      end: "0 19 * * 1-5"     # 7:00 PM weekdays
      desiredReplicas: "10"
  - type: cron
    metadata:
      timezone: "America/New_York"
      start: "0 11 * * 6"     # 11:00 AM Saturday
      end: "0 17 * * 6"       # 5:00 PM Saturday
      desiredReplicas: "5"
```

### Combining Cron with Event-Driven Scalers

Cron and event-driven scalers can coexist in a single `ScaledObject`. KEDA takes the maximum desired replica count across all active triggers:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-combined-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 100
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0
        scaleDown:
          stabilizationWindowSeconds: 180
  triggers:
  # Event-driven: scale on actual HTTP load
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: api_rps
      threshold: "200"
      query: sum(rate(http_requests_total{app="api-server"}[1m]))
  # Predictive: pre-scale before morning traffic ramp
  - type: cron
    metadata:
      timezone: "UTC"
      start: "45 6 * * 1-5"   # 6:45 AM UTC weekdays (pre-warm)
      end: "0 9 * * 1-5"
      desiredReplicas: "15"
  # Predictive: reduced night footprint
  - type: cron
    metadata:
      timezone: "UTC"
      start: "0 22 * * *"
      end: "0 6 * * *"
      desiredReplicas: "3"
```

This pattern ensures the cluster pre-warms before the morning ramp while still responding dynamically to unexpected load.

---

## TriggerAuthentication and SecretTargetRef

Most production scalers require authentication credentials. `TriggerAuthentication` manages these securely:

### AWS SQS Scaler with IAM Role (IRSA)

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: keda-sqs-reader
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/keda-sqs-reader
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: sqs-trigger-auth
  namespace: production
spec:
  podIdentity:
    provider: aws-eks
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-consumer-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: sqs-consumer
  minReplicaCount: 0
  maxReplicaCount: 30
  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: sqs-trigger-auth
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/my-queue
      queueLength: "5"
      awsRegion: us-east-1
      identityOwner: operator
```

### Kafka Scaler with SASL/TLS

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: kafka-credentials
  namespace: production
type: Opaque
stringData:
  sasl-password: "<kafka-sasl-password>"
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: password
    name: kafka-credentials
    key: sasl-password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: kafka-consumer
  pollingInterval: 10
  minReplicaCount: 1
  maxReplicaCount: 50
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-broker-0.kafka.svc.cluster.local:9093
      consumerGroup: my-consumer-group
      topic: orders
      lagThreshold: "100"
      offsetResetPolicy: latest
      allowIdleConsumers: "false"
      scaleToZeroOnInvalidOffset: "false"
      sasl: plaintext
      tls: enable
      username: my-kafka-user
    authenticationRef:
      name: kafka-trigger-auth
```

---

## ScaledJob for Batch Workloads

`ScaledJob` creates Kubernetes Jobs (not Deployments) in response to scaling events. Each scale unit is a new Job instance, ideal for queue-draining patterns:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processor-scaledjob
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 600
    backoffLimit: 2
    template:
      spec:
        restartPolicy: Never
        containers:
        - name: image-processor
          image: registry.example.com/image-processor:v2.1.0
          env:
          - name: QUEUE_URL
            value: https://sqs.us-east-1.amazonaws.com/123456789012/image-jobs
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
            limits:
              cpu: 2000m
              memory: 4Gi
  pollingInterval: 10
  maxReplicaCount: 20
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  scalingStrategy:
    strategy: "accurate"   # "default" | "accurate" | "eager"
    pendingPodConditions:
    - "Ready"
    - "PodScheduled"
    - "AnyPodNotRunning"
    customScalingQueueLengthDeduction: 0
    customScalingRunningJobPercentage: "0.5"
  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: sqs-trigger-auth
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/image-jobs
      queueLength: "1"
      awsRegion: us-east-1
```

The `accurate` scaling strategy accounts for jobs currently running when calculating how many new jobs to create.

---

## Scale-to-Zero: Operational Considerations

### Startup Probe Optimization

When scaling from zero, pods must pass their readiness probe before the interceptor forwards traffic. Aggressive readiness probes minimize latency:

```yaml
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 2
  periodSeconds: 1
  successThreshold: 1
  failureThreshold: 10    # allow up to 10 seconds startup
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 15
  periodSeconds: 10
  failureThreshold: 3
startupProbe:
  httpGet:
    path: /healthz
    port: 8080
  failureThreshold: 30
  periodSeconds: 1        # check every second for up to 30 seconds
```

### PodDisruptionBudget for Scale-Down Safety

When KEDA scales down, PDBs protect against taking too many pods offline simultaneously:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-api-pdb
  namespace: production
spec:
  minAvailable: "50%"
  selector:
    matchLabels:
      app: my-api
```

### Metrics for Scale-to-Zero Monitoring

KEDA exposes Prometheus metrics that should be scraped and alerted on:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: keda-operator-metrics
  namespace: keda
spec:
  selector:
    matchLabels:
      app: keda-operator
  podMetricsEndpoints:
  - port: metrics
    interval: 30s
```

Key metrics to alert on:

```promql
# ScaledObject fallback active (scaler failures)
keda_scaler_active{scaledObject="my-app-scaledobject"} == 0

# HPA patching errors
keda_internal_scale_loop_latency_bucket

# Scale-to-zero transition latency (HTTP Add-on)
keda_http_interceptor_request_count_total
keda_http_interceptor_response_wait_seconds_bucket
```

---

## Multi-Scaler Composition Patterns

### Priority Scaler for Cost-Aware Scaling

Using multiple scalers with different resource types allows cost-aware scaling strategies:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-cost-aware
  namespace: production
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 2
  maxReplicaCount: 100
  triggers:
  # Primary: scale on queue depth (cost-efficient)
  - type: aws-sqs-queue
    authenticationRef:
      name: sqs-trigger-auth
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/work-queue
      queueLength: "10"
      awsRegion: us-east-1
  # Secondary: ensure minimum capacity during business hours
  - type: cron
    metadata:
      timezone: "America/Chicago"
      start: "0 8 * * 1-5"
      end: "0 18 * * 1-5"
      desiredReplicas: "5"
  # Tertiary: CPU safety net
  - type: cpu
    metricType: Utilization
    metadata:
      value: "70"
```

KEDA selects the maximum desired replicas across all active triggers, so each scaler acts as an independent floor.

---

## Troubleshooting KEDA

### Inspecting ScaledObject Status

```bash
kubectl describe scaledobject my-app-scaledobject -n production
```

Look for:

```
Status:
  Conditions:
    Message:               ScaledObject is defined correctly and is ready for scaling
    Reason:                ScaledObjectReady
    Status:                "True"
    Type:                  Ready
  External Metric Names:   s0-prometheus-http_requests_per_second
  HPA Name:                keda-hpa-my-app-scaledobject
  Last Active Time:        2032-03-24T12:00:00Z
  Original Replica Count:  1
  Scale Target GVKR:       apps/v1/deployments
```

### Common Issues and Resolutions

**Issue: ScaledObject stuck at zero replicas despite traffic**

```bash
# Check KEDA operator logs
kubectl logs -n keda -l app=keda-operator --tail=100

# Verify metric is returning values
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/production/s0-prometheus-http_requests_per_second"

# Check HPA status
kubectl get hpa -n production keda-hpa-my-app-scaledobject -o yaml
```

**Issue: HTTP Add-on interceptor not routing to correct backend**

```bash
# List HTTPScaledObjects
kubectl get httpscaledobject -n production

# Check interceptor logs for host matching
kubectl logs -n keda -l app=keda-add-ons-http-interceptor | grep "host="

# Verify service endpoints
kubectl get endpoints my-api-svc -n production
```

**Issue: Cron trigger not activating**

```bash
# Verify timezone parsing (use TZ database names)
# Wrong: "EST", "US/Eastern"
# Correct: "America/New_York"

# Check operator logs for cron errors
kubectl logs -n keda -l app=keda-operator | grep -i cron

# Inspect scaler metadata
kubectl get scaledobject my-app -n production -o jsonpath='{.spec.triggers}'
```

### Debug Mode

```bash
# Enable debug logging on the operator
kubectl set env deployment/keda-operator -n keda KEDA_LOG_LEVEL=debug

# Watch scaling events
kubectl get events -n production --field-selector reason=SuccessfulRescale -w
```

---

## Production Hardening Checklist

```yaml
# Network policy allowing KEDA operator to reach metrics sources
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-keda-prometheus
  namespace: monitoring
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: prometheus
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: keda
      podSelector:
        matchLabels:
          app: keda-operator
    ports:
    - port: 9090
      protocol: TCP
```

```yaml
# RBAC for KEDA operator to patch HPA objects in production
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: keda-operator-extra-perms
rules:
- apiGroups: ["autoscaling"]
  resources: ["horizontalpodautoscalers"]
  verbs: ["*"]
- apiGroups: ["apps"]
  resources: ["deployments/scale", "statefulsets/scale"]
  verbs: ["get", "update", "patch"]
```

Key operational recommendations:

- Set `fallback.replicas` to a safe non-zero value so metric source outages do not cause unexpected scale-to-zero
- Always configure `cooldownPeriod` at least 2x longer than the longest request processing time to avoid mid-request scale-downs
- Use `TriggerAuthentication` with `podIdentity` (IRSA, Workload Identity) rather than static secrets wherever possible
- Monitor `keda_scaler_errors_total` and alert when it increases; this indicates metric source connectivity issues
- Test scale-to-zero recovery time in staging before enabling in production; acceptable cold-start latency varies by application
