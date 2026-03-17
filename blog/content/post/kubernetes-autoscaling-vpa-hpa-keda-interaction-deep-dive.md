---
title: "Kubernetes Autoscaling Deep Dive: VPA + HPA + KEDA Interaction"
date: 2029-11-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Autoscaling", "VPA", "HPA", "KEDA", "Scale-to-Zero", "Capacity Planning"]
categories: ["Kubernetes", "Performance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "In-depth guide to Kubernetes autoscaling: understanding VPA-HPA coexistence limitations, resolving KEDA-HPA conflicts, recommended multi-dimensional autoscaling patterns, scale-to-zero with KEDA, and capacity planning strategies."
more_link: "yes"
url: "/kubernetes-autoscaling-vpa-hpa-keda-interaction-deep-dive/"
---

Kubernetes provides three distinct autoscaling mechanisms, and their interactions are a source of significant confusion. The Horizontal Pod Autoscaler (HPA) scales replica count based on metrics. The Vertical Pod Autoscaler (VPA) adjusts CPU and memory requests based on historical usage. KEDA (Kubernetes Event-Driven Autoscaling) scales based on external event sources and supports scale-to-zero. Running all three simultaneously without understanding their interactions leads to thrashing, evictions, and poor utilization. This guide explains the constraints, safe configuration patterns, and capacity planning strategies.

<!--more-->

# Kubernetes Autoscaling Deep Dive: VPA + HPA + KEDA Interaction

## Section 1: Understanding Each Autoscaler

### Horizontal Pod Autoscaler (HPA)

HPA scales the number of pod replicas based on observed metrics. The default metric is CPU utilization, but HPA v2 supports any metric available through the metrics API.

```
Target metric: 50% CPU
Current pods: 3
Current CPU: 80%

Scale-up calculation:
  desiredReplicas = ceil(currentReplicas * (currentMetricValue / desiredMetricValue))
  desiredReplicas = ceil(3 * (80 / 50)) = ceil(4.8) = 5

Scale-down has a longer delay (stabilizationWindowSeconds) to prevent oscillation.
```

HPA does NOT modify resource requests/limits. It assumes the per-pod resource allocation is fixed and scales horizontally.

### Vertical Pod Autoscaler (VPA)

VPA adjusts CPU and memory requests (and optionally limits) for containers. It operates in three modes:

- **Off**: Computes recommendations but does not apply them
- **Initial**: Only applies recommendations to new pods (no restarts)
- **Auto/Recreate**: Evicts and recreates pods to apply recommendations (requires downtime)

VPA continuously monitors actual resource usage via the metrics server and builds a model of resource consumption over time (with outlier detection and buffering).

### KEDA (Kubernetes Event-Driven Autoscaling)

KEDA scales workloads based on external event sources: Kafka lag, SQS queue length, Redis list size, HTTP request rate, Prometheus queries, and 50+ other scalers. KEDA's killer feature is scale-to-zero — HPA cannot scale below 1 replica.

Internally, KEDA creates an HPA object and sets its target metric using the External Metrics API. This is the root of KEDA-HPA conflicts.

## Section 2: VPA-HPA Coexistence Limitations

### The Core Conflict

When both VPA and HPA are configured on the same Deployment:

1. HPA decides replica count based on CPU/memory utilization relative to requests
2. VPA changes CPU/memory requests on pods
3. HPA recalculates based on new requests
4. This creates a feedback loop that causes oscillation

**Example of the problem:**

```
Initial state: 3 replicas, CPU request=100m, actual CPU=80m (80% utilization)
HPA target: 60% CPU

Step 1: HPA sees 80% > 60%, scales to 4 replicas
Step 2: VPA sees 80m actual usage, reduces request to 90m per pod
Step 3: HPA recalculates: 80m/90m = 89% > 60%, scales to 5 replicas
Step 4: VPA sees 80m actual usage, reduces request to 90m per pod
→ This loop continues
```

### Safe VPA-HPA Coexistence Rules

**Rule 1**: Never configure VPA Auto/Recreate mode AND HPA on the same object using CPU or memory metrics.

**Rule 2**: You CAN use VPA Auto with HPA on custom metrics (not CPU/memory). This is the recommended pattern:

```yaml
# HPA uses ONLY custom metrics (not CPU/memory)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-gateway
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  minReplicas: 2
  maxReplicas: 20
  metrics:
    # Use request rate, not CPU — safe with VPA
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: 100  # 100 RPS per pod

---
# VPA handles right-sizing the CPU/memory requests
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-gateway
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  updatePolicy:
    updateMode: "Auto"  # Safe because HPA uses custom metrics only
  resourcePolicy:
    containerPolicies:
      - containerName: api-gateway
        minAllowed:
          cpu: 50m
          memory: 64Mi
        maxAllowed:
          cpu: 4
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits
```

**Rule 3**: Use VPA in Recommendation-only mode with HPA when you want HPA on CPU/memory:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-gateway-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  updatePolicy:
    updateMode: "Off"   # Never apply — just observe
  resourcePolicy:
    containerPolicies:
      - containerName: api-gateway
        controlledResources: ["cpu", "memory"]
```

Then review VPA recommendations and apply manually:

```bash
kubectl get vpa api-gateway-vpa -n production -o jsonpath='{.status.recommendation}'
# {"containerRecommendations":[{
#   "containerName":"api-gateway",
#   "lowerBound":{"cpu":"100m","memory":"128Mi"},
#   "target":{"cpu":"350m","memory":"512Mi"},
#   "uncappedTarget":{"cpu":"350m","memory":"512Mi"},
#   "upperBound":{"cpu":"2","memory":"2Gi"}
# }]}
```

## Section 3: KEDA-HPA Conflict Resolution

### How KEDA Creates HPA Objects

When you create a `ScaledObject`, KEDA:
1. Creates an HPA targeting your Deployment/StatefulSet
2. Registers an External Metrics API endpoint
3. HPA queries KEDA's metrics server for the scaler values

If you ALSO create an HPA manually for the same Deployment, you get two HPAs competing:

```bash
# This situation causes problems
kubectl get hpa -n production
# NAME                   REFERENCE               TARGETS     MINPODS   MAXPODS
# api-gateway            Deployment/api-gateway   80%/60%    2         20      # Your HPA
# keda-hpa-api-gateway   Deployment/api-gateway   42/100     1         100     # KEDA's HPA
```

Two HPAs can fight each other, causing rapid replica count oscillation.

### Solution: Single ScaledObject with CPU Trigger

Instead of both, use a ScaledObject that includes a CPU trigger alongside external triggers:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-gateway
  namespace: production
spec:
  scaleTargetRef:
    name: api-gateway
  minReplicaCount: 2
  maxReplicaCount: 50
  cooldownPeriod: 300
  pollingInterval: 15

  advanced:
    restoreToOriginalReplicaCount: false
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Percent
              value: 10
              periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
            - type: Percent
              value: 50
              periodSeconds: 60
            - type: Pods
              value: 5
              periodSeconds: 60
          selectPolicy: Max

  triggers:
    # CPU trigger (replaces manual HPA for CPU-based scaling)
    - type: cpu
      metricType: Utilization
      metadata:
        value: "60"  # 60% CPU utilization target

    # External trigger: Kafka consumer lag
    - type: kafka
      metadata:
        bootstrapServers: kafka.production.svc.cluster.local:9092
        consumerGroup: api-gateway-consumers
        topic: incoming-requests
        lagThreshold: "100"
        activationLagThreshold: "1"

    # External trigger: Prometheus metric
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc.cluster.local:9090
        metricName: http_requests_pending
        query: |
          sum(rate(http_requests_total{service="api-gateway",status!~"5.*"}[2m]))
        threshold: "200"
        activationThreshold: "10"
```

### Handling Existing HPA Objects

If you have an existing HPA and want to migrate to KEDA:

```bash
# Step 1: Note the current settings
kubectl get hpa api-gateway -n production -o yaml

# Step 2: Delete the existing HPA
kubectl delete hpa api-gateway -n production

# Step 3: Create the ScaledObject (KEDA will create a new HPA)
kubectl apply -f scaledobject.yaml

# Step 4: Verify KEDA created its HPA
kubectl get hpa -n production
# keda-hpa-api-gateway  Deployment/api-gateway  ...  2  50
```

## Section 4: Scale-to-Zero with KEDA

HPA has a minimum of 1 replica. KEDA supports scale-to-zero, which is critical for cost optimization in dev/staging environments or event-driven batch workloads.

### Basic Scale-to-Zero Configuration

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: batch-processor
  namespace: production
spec:
  scaleTargetRef:
    name: batch-processor
  # Setting minReplicaCount to 0 enables scale-to-zero
  minReplicaCount: 0
  maxReplicaCount: 20
  cooldownPeriod: 120      # Wait 120s after last message before scaling to 0

  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka.production.svc.cluster.local:9092
        consumerGroup: batch-processor-group
        topic: batch-jobs
        lagThreshold: "10"
        # activationThreshold: scale from 0 to 1 when lag > 1
        activationLagThreshold: "1"
        offsetResetPolicy: latest
```

### Scale-to-Zero for HTTP Workloads

For HTTP-based scale-to-zero, KEDA provides the HTTP Add-On:

```yaml
# Install KEDA HTTP Add-On first
helm repo add kedacore https://kedacore.github.io/charts
helm install http-add-on kedacore/keda-add-ons-http \
    --namespace keda \
    --set interceptor.replicas.min=2 \
    --set interceptor.replicas.max=10

---
# HTTPScaledObject for an HTTP service
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: api-gateway
  namespace: production
spec:
  host: api.example.com
  targetPendingRequests: 100
  scaleTargetRef:
    deployment: api-gateway
    service: api-gateway
    port: 80
  replicas:
    min: 0   # Scale to zero
    max: 20
```

### Scale-to-Zero with Warm-Up

The challenge with scale-to-zero is cold start latency. Mitigate this with:

```yaml
spec:
  # Keep 1 replica during business hours
  scaleTargetRef:
    name: api-gateway
  minReplicaCount: 0
  maxReplicaCount: 20

  # Time-based scaling to maintain a minimum during business hours
  triggers:
    - type: cron
      metadata:
        timezone: America/New_York
        start: "0 8 * * 1-5"    # Monday-Friday 8 AM
        end: "0 18 * * 1-5"     # Monday-Friday 6 PM
        desiredReplicas: "2"     # Maintain 2 replicas during work hours

    # Still scale on actual load outside hours
    - type: kafka
      metadata:
        bootstrapServers: kafka:9092
        consumerGroup: api-group
        topic: api-requests
        lagThreshold: "50"
        activationLagThreshold: "1"
```

### KEDA ScaledJob for Batch Workloads

For truly event-driven batch processing, use ScaledJob instead of ScaledObject:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: image-processor
  namespace: production
spec:
  jobTargetRef:
    template:
      spec:
        containers:
          - name: processor
            image: registry.example.com/image-processor:latest
            resources:
              requests:
                cpu: 500m
                memory: 1Gi
              limits:
                cpu: 2
                memory: 4Gi
        restartPolicy: Never

  pollingInterval: 10
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10
  maxReplicaCount: 50

  # One job per N messages
  scalingStrategy:
    strategy: accurate  # or: default, eager
    pendingJobCount: 5  # Max jobs waiting to start

  triggers:
    - type: aws-sqs-queue
      authenticationRef:
        name: keda-aws-credentials
      metadata:
        queueURL: https://sqs.us-east-1.amazonaws.com/123456789/image-jobs
        queueLength: "1"   # 1 job per message
        awsRegion: us-east-1
```

## Section 5: Recommended Multi-Dimensional Autoscaling Patterns

### Pattern 1: KEDA (Scale-to-Zero) + VPA (Right-Sizing)

Best for event-driven workloads where replicas scale from 0:

```yaml
# KEDA manages replica count (including scale-to-zero)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: event-processor
  namespace: production
spec:
  scaleTargetRef:
    name: event-processor
  minReplicaCount: 0
  maxReplicaCount: 30
  triggers:
    - type: kafka
      metadata:
        bootstrapServers: kafka:9092
        consumerGroup: events-group
        topic: events
        lagThreshold: "50"
        activationLagThreshold: "1"

---
# VPA right-sizes the pod resources
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: event-processor
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: event-processor
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: processor
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 8
          memory: 8Gi
```

**Why this works**: VPA only evicts pods when they are restarted (which happens during scale-down to 0 and scale-up from 0). KEDA's scale-to-zero provides natural restart opportunities for VPA to apply recommendations.

### Pattern 2: HPA on Custom Metrics + VPA Recommendation-Only

Best for always-on services where you need CPU/memory HPA:

```yaml
# HPA on custom metrics only
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-api
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-api
  minReplicas: 3
  maxReplicas: 50
  metrics:
    - type: External
      external:
        metric:
          name: nginx_ingress_requests_per_second
          selector:
            matchLabels:
              service: web-api
        target:
          type: AverageValue
          averageValue: 500
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 600

---
# VPA in recommendation mode (apply changes via Kustomize/Helm values)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: web-api
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-api
  updatePolicy:
    updateMode: "Off"
```

### Pattern 3: HPA on CPU + KEDA on External (with ScaledObject)

Use a single ScaledObject that includes both CPU and external triggers:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: payment-processor
  namespace: production
spec:
  scaleTargetRef:
    name: payment-processor
  minReplicaCount: 3    # Never scale below 3 (SLA requirement)
  maxReplicaCount: 100

  triggers:
    # Scale on CPU (replaces HPA)
    - type: cpu
      metricType: Utilization
      metadata:
        value: "70"

    # Scale on payment queue depth
    - type: rabbitmq
      authenticationRef:
        name: rabbitmq-auth
      metadata:
        protocol: amqp
        queueName: payment-queue
        mode: QueueLength
        value: "10"    # 10 messages per pod
        activationValue: "1"
```

## Section 6: Capacity Planning with Autoscaling

### Determining maxReplicas

```python
# capacity_planning.py
# Calculate maxReplicas based on load projections

def calculate_max_replicas(
    peak_load_multiplier: float,  # e.g., 3.0 for 3x normal peak
    avg_replicas_at_normal_load: int,
    safety_buffer: float = 1.3   # 30% buffer above calculated need
) -> int:
    """
    Calculate maxReplicas for HPA/KEDA configuration.

    Args:
        peak_load_multiplier: Expected peak load / normal load
        avg_replicas_at_normal_load: Observed average replicas under normal load
        safety_buffer: Safety factor (1.3 = 30% headroom above peak)
    """
    calculated = avg_replicas_at_normal_load * peak_load_multiplier * safety_buffer
    return int(calculated) + 1  # Round up

# Example: Black Friday planning
normal_replicas = 10    # What we see on average days
black_friday_multiplier = 8.0  # 8x normal traffic

max_replicas = calculate_max_replicas(
    peak_load_multiplier=black_friday_multiplier,
    avg_replicas_at_normal_load=normal_replicas,
    safety_buffer=1.3
)
print(f"Recommended maxReplicas: {max_replicas}")  # 105
```

### Resource Budget Calculation

```bash
#!/bin/bash
# scripts/autoscaling-resource-budget.sh
# Calculate total resource reservation at maxReplicas

NAMESPACE="production"
MAX_REPLICAS=100
CPU_REQUEST="500m"   # Per pod
MEMORY_REQUEST="1Gi"  # Per pod

CPU_TOTAL_MILLICORES=$((100 * 500))  # 50,000m = 50 CPUs
MEMORY_TOTAL_GI=100  # 100 Gi

echo "=== Autoscaling Resource Budget ==="
echo "Namespace: $NAMESPACE"
echo "Max replicas: $MAX_REPLICAS"
echo ""
echo "Peak resource requirements:"
echo "  CPU: ${CPU_TOTAL_MILLICORES}m ($(($CPU_TOTAL_MILLICORES / 1000)) cores)"
echo "  Memory: ${MEMORY_TOTAL_GI}Gi"
echo ""

# Check current node capacity
echo "=== Node Capacity ==="
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,CPU:.status.capacity.cpu,MEMORY:.status.capacity.memory'

echo ""
echo "=== Current Usage vs. Capacity ==="
kubectl top nodes
```

### VPA Recommendations as a Capacity Planning Tool

```bash
#!/bin/bash
# Collect VPA recommendations for all deployments in a namespace
# Use this to right-size resource requests before Black Friday

NAMESPACE="production"

echo "VPA Recommendations for namespace: $NAMESPACE"
echo "============================================="

kubectl get vpa -n "$NAMESPACE" -o json | \
  jq -r '.items[] |
    .metadata.name as $name |
    .status.recommendation.containerRecommendations[] |
    "\($name)/\(.containerName): CPU target=\(.target.cpu), Memory target=\(.target.memory)"'
```

## Section 7: Debugging Autoscaling Issues

### HPA Not Scaling

```bash
# Describe HPA for events
kubectl describe hpa api-gateway -n production

# Check if metrics are available
kubectl get --raw /apis/metrics.k8s.io/v1beta1/namespaces/production/pods

# Check custom metrics
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1/namespaces/production/pods/*/http_requests_per_second

# Check external metrics (KEDA)
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1/namespaces/production/kafka_consumer_lag

# Check HPA controller logs
kubectl logs -n kube-system -l component=controller-manager --tail=100 | grep HPA
```

### KEDA ScaledObject Issues

```bash
# Check ScaledObject status
kubectl get scaledobject api-gateway -n production -o yaml | grep -A20 "status:"

# Check KEDA operator logs
kubectl logs -n keda -l app=keda-operator --tail=100

# View the HPA that KEDA created
kubectl get hpa -n production keda-hpa-api-gateway -o yaml

# Check scaler metrics
kubectl get --raw /apis/external.metrics.k8s.io/v1beta1/namespaces/production/s0-kafka-incoming-requests

# TriggerAuthentication issues
kubectl describe triggerauthentication rabbitmq-auth -n production
```

### VPA Not Recommending

```bash
# Check VPA object status
kubectl describe vpa api-gateway -n production

# VPA requires at least 8 hours of data for reliable recommendations
# Check history duration
kubectl get vpa api-gateway -n production -o jsonpath='{.status.recommendation}'

# VPA admission controller logs
kubectl logs -n kube-system -l app=vpa-admission-controller --tail=50

# Check if metrics server is healthy
kubectl top pods -n production api-gateway
```

## Section 8: Production Configuration Example

A complete, production-ready autoscaling setup for a stateless web service:

```yaml
# HPA via KEDA (single source of truth for scaling)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: web-api
  namespace: production
  annotations:
    # Document the scaling rationale
    autoscaling.example.com/notes: |
      CPU trigger handles gradual load increases.
      Kafka trigger handles burst traffic from event queue.
      minReplicas=3 for HA across 3 AZs.
      maxReplicas=100 based on cluster capacity + 30% headroom.
spec:
  scaleTargetRef:
    name: web-api
  minReplicaCount: 3
  maxReplicaCount: 100
  cooldownPeriod: 300
  pollingInterval: 15
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 30
          policies:
            - type: Percent
              value: 100    # Double quickly
              periodSeconds: 30
        scaleDown:
          stabilizationWindowSeconds: 600  # Slow scale-down
          policies:
            - type: Percent
              value: 10     # Remove at most 10% per minute
              periodSeconds: 60
  triggers:
    - type: cpu
      metricType: Utilization
      metadata:
        value: "60"
    - type: kafka
      metadata:
        bootstrapServers: kafka.production.svc.cluster.local:9092
        consumerGroup: web-api-consumers
        topic: web-requests
        lagThreshold: "100"
        activationLagThreshold: "10"

---
# VPA in Recommendation mode (review weekly, apply via GitOps)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: web-api-advisor
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-api
  updatePolicy:
    updateMode: "Off"    # Recommendations only
  resourcePolicy:
    containerPolicies:
      - containerName: web-api
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 8
          memory: 8Gi
```

## Conclusion

Kubernetes autoscaling works best when each dimension is owned by a single controller. The fundamental rules:

1. **Never run VPA Auto and HPA on CPU/memory simultaneously** — they create feedback loops
2. **Use ScaledObject for everything** when KEDA is installed — it generates the HPA, preventing conflicts
3. **VPA recommendation mode is always safe** — it never conflicts with HPA or KEDA
4. **Scale-to-zero is free money** for batch and event-driven workloads — implement it with KEDA ScaledJob or ScaledObject with minReplicas=0

Key takeaways:
- KEDA subsumes HPA — do not create both for the same workload
- VPA Auto + KEDA is safe because scale-to-zero provides natural pod restart opportunities
- Set `stabilizationWindowSeconds` on scale-down to prevent thrashing from metric spikes
- Use VPA Off mode to generate right-sizing recommendations without risking disruption
- Plan maxReplicas based on peak load projection × safety buffer, not optimistic averages
