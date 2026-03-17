---
title: "Kubernetes Autoscaling Deep Dive: VPA, HPA, KEDA, and Cluster Autoscaler Interaction Patterns"
date: 2028-08-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Autoscaling", "VPA", "HPA", "KEDA", "Cluster Autoscaler"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes autoscaling: VPA for right-sizing containers, HPA for replicas, KEDA for event-driven scaling, Cluster Autoscaler for node provisioning, and how to combine them safely without conflicts."
more_link: "yes"
url: "/kubernetes-autoscaling-vpa-hpa-keda-interaction-guide/"
---

Kubernetes provides four autoscaling mechanisms, each solving a different dimension of the problem: Vertical Pod Autoscaler (VPA) adjusts CPU and memory requests, Horizontal Pod Autoscaler (HPA) adjusts replica counts, KEDA scales based on external event sources, and Cluster Autoscaler provisions and decommissions nodes. Running all four simultaneously is powerful but requires careful configuration to avoid conflicts, thrashing, and unexpected pod restarts.

This guide covers each component in depth, their interaction patterns, conflict zones, and production configurations that work together.

<!--more-->

# [Kubernetes Autoscaling Deep Dive: VPA, HPA, KEDA, and Cluster Autoscaler](#kubernetes-autoscaling-deep-dive)

## Section 1: Autoscaling Dimensions

| Autoscaler | What It Scales | Trigger | Pod Disruption |
|-----------|----------------|---------|----------------|
| HPA | Replica count | CPU, memory, custom metrics | No (adds/removes pods) |
| VPA | CPU/memory requests | Historical usage | Yes (restarts pods to apply) |
| KEDA | Replica count (0 to N) | External events (queues, metrics) | No |
| Cluster Autoscaler | Node count | Pending pods, underutilized nodes | Yes (drains nodes) |

### Interaction Overview

```
External Traffic
    ↓
KEDA / HPA — decide replica count
    ↓
VPA — right-sizes each pod's requests
    ↓
Cluster Autoscaler — provisions nodes to fit pods
```

**Critical Rule**: Do not use VPA and HPA simultaneously on the same metric. If both react to CPU, they fight each other — HPA scales up replicas, VPA adjusts requests, which changes the CPU metric HPA watches.

## Section 2: Horizontal Pod Autoscaler (HPA)

### HPA v2 with Multiple Metrics

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-app-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 3
  maxReplicas: 50
  metrics:
  # CPU: scale when average pod CPU utilization exceeds 70%
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70

  # Memory: scale when average pod memory exceeds 80%
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80

  # Custom metric: requests per second from Prometheus
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"

  # External metric: SQS queue depth
  - type: External
    external:
      metric:
        name: sqs_queue_depth
        selector:
          matchLabels:
            queue: order-processing
      target:
        type: AverageValue
        averageValue: "30"  # Target: 30 messages per replica

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60    # Wait 60s before scaling up again
      policies:
      - type: Percent
        value: 100     # Can double replicas per period
        periodSeconds: 60
      - type: Pods
        value: 5       # Or add max 5 pods per period
        periodSeconds: 60
      selectPolicy: Max  # Use whichever policy allows more scale-up

    scaleDown:
      stabilizationWindowSeconds: 300   # Wait 5 minutes before scaling down
      policies:
      - type: Percent
        value: 20       # Remove at most 20% of replicas per period
        periodSeconds: 60
      selectPolicy: Min  # Use the most conservative scale-down policy
```

### HPA Status and Debugging

```bash
# Check HPA status
kubectl get hpa -n production
kubectl describe hpa web-app-hpa -n production

# Detailed metric values
kubectl get hpa web-app-hpa -n production \
  -o jsonpath='{.status.currentMetrics}' | python3 -m json.tool

# Watch scaling events
kubectl get events -n production \
  --field-selector reason=SuccessfulRescale \
  --sort-by=.lastTimestamp

# Check Metrics Server
kubectl top pods -n production
kubectl top nodes

# Check if custom metrics are available
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" | jq '.resources[].name'
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | jq '.resources[].name'
```

### Custom Metrics with Prometheus Adapter

```yaml
# Install prometheus-adapter to expose Prometheus metrics to HPA
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  -n monitoring \
  --set prometheus.url=http://prometheus.monitoring.svc \
  --set prometheus.port=9090

# Custom metric rule configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: adapter-config
  namespace: monitoring
data:
  config.yaml: |
    rules:
    - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
      seriesFilters: []
      resources:
        overrides:
          namespace:
            resource: namespace
          pod:
            resource: pod
      name:
        matches: "^(.*)_total"
        as: "${1}_per_second"
      metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'
```

## Section 3: Vertical Pod Autoscaler (VPA)

VPA is most valuable for:
- Right-sizing new services with unknown resource needs
- Memory-intensive workloads where requests are hard to estimate
- Services with variable load profiles (batch jobs that spike briefly)

### VPA Update Modes

| Mode | Behavior | Disruption |
|------|----------|------------|
| `Off` | Recommendations only (read logs/events) | None |
| `Initial` | Apply recommendations only at pod creation | None after creation |
| `Auto` | Continuously apply recommendations, restarts pods | Yes — pods restart |
| `Recreate` | Like Auto but only restarts (no in-place updates) | Yes |

Kubernetes 1.27+ supports **In-Place Pod Updates** (`InPlaceOrRecreate`), which changes resource limits without pod restart for some resources.

### VPA for Workload Right-Sizing

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: payment-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: payment-service
  updatePolicy:
    updateMode: "Off"       # Recommendation-only for production critical services
    evictionRequirements:
    - resources: ["cpu", "memory"]
      changeRequirement: TargetHigherThanRequests  # Only apply if recommendation is higher

  resourcePolicy:
    containerPolicies:
    - containerName: payment-service
      minAllowed:
        cpu: "100m"
        memory: "128Mi"
      maxAllowed:
        cpu: "4"
        memory: "8Gi"
      controlledResources: ["cpu", "memory"]
      controlledValues: RequestsAndLimits

    - containerName: istio-proxy
      mode: "Off"           # Don't auto-size the sidecar
```

```bash
# Check VPA recommendations
kubectl describe vpa payment-service-vpa -n production

# Output:
# Status:
#   Recommendation:
#     Container Recommendations:
#       Container Name:  payment-service
#       Lower Bound:
#         Cpu:     100m
#         Memory:  128Mi
#       Target:                    <-- USE THESE VALUES
#         Cpu:     450m
#         Memory:  512Mi
#       Uncapped Target:
#         Cpu:     450m
#         Memory:  512Mi
#       Upper Bound:
#         Cpu:     2
#         Memory:  2Gi
```

### VPA + HPA: Safe Combination

**Rule**: VPA should NOT control CPU when HPA is scaling on CPU. Use VPA for memory only, HPA for CPU.

```yaml
# VPA: manage only memory (HPA manages CPU scaling)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: web-app-vpa
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: web-app
      controlledResources: ["memory"]   # Only control memory
      minAllowed:
        memory: "128Mi"
      maxAllowed:
        memory: "4Gi"
---
# HPA: scale replicas based on CPU only (not memory)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-app-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web-app
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu              # Only scale on CPU
      target:
        type: Utilization
        averageUtilization: 70
  # Do NOT add memory metric here — VPA controls memory requests
```

### VPA Admission Controller

VPA modifies pod resource requests at admission time. Verify it's running:

```bash
# Check VPA components
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxx   1/1   Running
# vpa-recommender-xxx            1/1   Running
# vpa-updater-xxx                1/1   Running

# Check admission controller webhook
kubectl get mutatingwebhookconfigurations vpa-webhook-config

# Check VPA updater logs (shows eviction decisions)
kubectl logs -n kube-system deployment/vpa-updater -f
```

## Section 4: KEDA — Kubernetes Event-Driven Autoscaler

KEDA extends HPA with 50+ event source scalers: Kafka lag, RabbitMQ queue depth, Azure Service Bus, AWS SQS, Prometheus metrics, MySQL query results, and more.

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.12.0

# Verify
kubectl get crds | grep keda
```

### ScaledObject: Scale to Zero on Queue Depth

```yaml
# Scale order-processor based on SQS queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: order-processor
    kind: Deployment
    apiVersion: apps/v1

  # Scale to zero when queue is empty
  minReplicaCount: 0
  maxReplicaCount: 50

  # Wait 5 minutes before scaling to zero (prevents cold start thrash)
  cooldownPeriod: 300

  # Check queue every 30 seconds
  pollingInterval: 30

  # KEDA creates an HPA internally — this is the HPA's stabilization
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
          stabilizationWindowSeconds: 0    # Scale up immediately

  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: keda-aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/order-queue
      queueLength: "10"    # Target: 10 messages per replica
      awsRegion: us-east-1
      identityOwner: pod   # Use pod's IRSA credentials
```

### ScaledObject: Kafka Consumer Lag

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: event-processor-kafka
  namespace: production
spec:
  scaleTargetRef:
    name: event-processor
  minReplicaCount: 1
  maxReplicaCount: 100

  triggers:
  - type: kafka
    metadata:
      bootstrapServers: "kafka-cluster:9092"
      consumerGroup: event-processor-group
      topic: user-events
      lagThreshold: "1000"    # Scale up when lag exceeds 1000 per replica
      offsetResetPolicy: latest
    authenticationRef:
      name: kafka-credentials
```

### ScaledObject: Cron-Based Scaling (Predictive)

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: api-server-scheduled
  namespace: production
spec:
  scaleTargetRef:
    name: api-server
  minReplicaCount: 3
  maxReplicaCount: 50

  triggers:
  # Scale up before business hours
  - type: cron
    metadata:
      timezone: "America/New_York"
      start: "30 8 * * 1-5"    # 8:30 AM weekdays
      end:   "00 18 * * 1-5"   # 6:00 PM weekdays
      desiredReplicas: "20"

  # Scale up for end-of-month batch
  - type: cron
    metadata:
      timezone: "America/New_York"
      start: "0 0 28-31 * *"   # Last days of month
      end:   "0 6 1 * *"       # First day of next month
      desiredReplicas: "30"

  # Always-on baseline (combined with cron via KEDA's max-of logic)
  - type: cpu
    metricType: Utilization
    metadata:
      value: "70"
```

### ScaledObject: Prometheus Metrics

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-prometheus
  namespace: production
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 1
  maxReplicaCount: 30

  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc:9090
      metricName: worker_queue_depth
      threshold: "100"       # Scale up when metric exceeds 100
      query: |
        sum(worker_queue_pending_tasks{namespace="production"})
      namespace: production
```

### TriggerAuthentication for Secrets

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: keda-aws-credentials
  namespace: production
spec:
  # Use pod's IRSA credentials (preferred — no secrets needed)
  podIdentity:
    provider: aws-eks
---
# For non-IRSA environments, use a Secret
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-credentials
  namespace: production
spec:
  secretTargetRef:
  - parameter: username
    name: kafka-credentials-secret
    key: username
  - parameter: password
    name: kafka-credentials-secret
    key: password
  - parameter: ca
    name: kafka-credentials-secret
    key: ca.crt
```

### ScaledJob for Batch Processing

```yaml
# ScaledJob creates Kubernetes Jobs based on queue depth
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: batch-report-generator
  namespace: production
spec:
  jobTargetRef:
    template:
      spec:
        containers:
        - name: report-generator
          image: report-generator:v2.3.1
          env:
          - name: REPORT_TYPE
            value: "monthly"
        restartPolicy: OnFailure

  minReplicaCount: 0
  maxReplicaCount: 10

  # One job per queue item
  scalingStrategy:
    strategy: "accurate"  # or "default" (batch multiple items per job)

  triggers:
  - type: rabbitmq
    authenticationRef:
      name: rabbitmq-auth
    metadata:
      host: amqp://rabbitmq.production.svc:5672
      queueName: report-requests
      queueLength: "1"    # 1 message = 1 job
```

## Section 5: Cluster Autoscaler

The Cluster Autoscaler adds nodes when pods are pending due to insufficient resources and removes nodes when they are underutilized.

### Installation (AWS EKS)

```bash
# Deploy Cluster Autoscaler
kubectl apply -f https://raw.githubusercontent.com/kubernetes/autoscaler/master/cluster-autoscaler/cloudprovider/aws/examples/cluster-autoscaler-autodiscover.yaml

# Patch with your cluster name
kubectl -n kube-system patch deployment cluster-autoscaler \
  --type json \
  --patch '[
    {"op": "replace", "path": "/spec/template/spec/containers/0/command",
     "value": [
       "./cluster-autoscaler",
       "--v=4",
       "--stderrthreshold=info",
       "--cloud-provider=aws",
       "--skip-nodes-with-local-storage=false",
       "--expander=least-waste",
       "--node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/my-cluster",
       "--balance-similar-node-groups",
       "--skip-nodes-with-system-pods=false",
       "--scale-down-utilization-threshold=0.5",
       "--scale-down-unneeded-time=10m",
       "--scale-down-delay-after-add=10m"
     ]}]'
```

### Node Group Configuration

```bash
# Tag ASGs for Cluster Autoscaler discovery
aws autoscaling create-or-update-tags \
  --tags \
    ResourceId=my-node-group-asg,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/enabled,Value=true,PropagateAtLaunch=true \
    ResourceId=my-node-group-asg,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/my-cluster,Value=owned,PropagateAtLaunch=true

# Set limits on the ASG
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name my-node-group-asg \
  --min-size 3 \
  --max-size 100 \
  --desired-capacity 5
```

### Controlling Scale-Down

```yaml
# Prevent specific nodes from being scaled down
kubectl annotate node ip-10-0-1-100.us-east-1.compute.internal \
  cluster-autoscaler.kubernetes.io/scale-down-disabled=true

# Prevent pods from being evicted during scale-down
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-app-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: web-app
  minAvailable: "50%"    # Always keep 50% of pods running during scale-down
  # OR: maxUnavailable: 1  # At most 1 pod down at a time
```

### Expander Strategies

```bash
# least-waste: minimize wasted resources on new node
# random: random selection (good for balanced groups)
# most-pods: maximize pods schedulable on new node
# price: cheapest node group (requires custom pricing plugin)
# priority: user-defined priority ordering

# For mixed instance groups on AWS, use:
--expander=least-waste
--balance-similar-node-groups=true

# For spot instances, add spot nodegroup as lower priority:
--expander=priority
```

```yaml
# Priority expander configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |-
    10:
      - .*spot.*        # Prefer spot instances (cheaper)
    1:
      - .*on-demand.*   # Fall back to on-demand
```

## Section 6: Karpenter — Next-Generation Node Provisioning

Karpenter replaces Cluster Autoscaler for EKS with faster provisioning (< 60 seconds vs 3+ minutes) and more granular instance selection.

```bash
# Install Karpenter
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version v0.33.0 \
  --namespace karpenter \
  --create-namespace \
  --set settings.aws.clusterName=my-cluster \
  --set settings.aws.clusterEndpoint=$CLUSTER_ENDPOINT \
  --set settings.aws.defaultInstanceProfile=KarpenterNodeInstanceProfile \
  --set settings.aws.interruptionQueueName=my-cluster
```

```yaml
# NodePool: defines what nodes Karpenter can provision
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: default
spec:
  template:
    metadata:
      labels:
        karpenter.sh/capacity-type: spot
    spec:
      requirements:
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]
      - key: karpenter.k8s.aws/instance-family
        operator: In
        values: ["m5", "m5d", "m5n", "m6i", "m6id", "c5", "c5d", "c6i"]
      - key: karpenter.k8s.aws/instance-size
        operator: NotIn
        values: ["nano", "micro", "small"]
      nodeClassRef:
        name: default

  limits:
    cpu: "1000"         # Max total vCPUs across all Karpenter nodes
    memory: 4000Gi

  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s

---
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: default
spec:
  amiFamily: Bottlerocket
  role: KarpenterNodeRole-my-cluster
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: my-cluster
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: my-cluster
  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 50Gi
      volumeType: gp3
      iops: 3000
      throughput: 125
      encrypted: true
```

## Section 7: Conflict Prevention and Safe Combinations

### Conflict Zone: VPA + HPA on Same Metric

```yaml
# BAD: Both scale on CPU
# VPA changes CPU requests → HPA's utilization % changes → HPA rescales → VPA recalculates
# This creates an infinite feedback loop

# GOOD: VPA handles memory, HPA handles CPU
# VPA
spec:
  resourcePolicy:
    containerPolicies:
    - containerName: app
      controlledResources: ["memory"]   # Only memory

# HPA
spec:
  metrics:
  - type: Resource
    resource:
      name: cpu                          # Only CPU
```

### Conflict Zone: KEDA + HPA on Same Deployment

KEDA creates a managed HPA object internally. You cannot also create a separate HPA for the same deployment.

```bash
# Check for conflicting HPAs
kubectl get hpa -n production

# If you have both a manual HPA and a KEDA ScaledObject:
# Delete the manual HPA and let KEDA manage it
kubectl delete hpa web-app-hpa -n production
# Then KEDA's ScaledObject will create and manage the HPA automatically
```

### Cluster Autoscaler + VPA Race Condition

When VPA increases memory requests, existing pods may no longer fit on their current node. Cluster Autoscaler will provision new nodes. This is fine but can cause:
1. Burst of pod evictions (VPA updater)
2. Brief scale-up of cluster nodes
3. Pods rescheduled to new/existing nodes with larger capacity

```yaml
# Prevent excessive VPA restarts by setting conservative change thresholds
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
spec:
  updatePolicy:
    updateMode: "Auto"
    # Only restart if recommendation differs by >20% from current
    minChangeDiff:
      cpu: "0.2"       # 20% change threshold for CPU
      memory: "0.2"    # 20% change threshold for memory
```

### Graceful Scale-Down with PodDisruptionBudgets

```yaml
# Ensure Cluster Autoscaler scale-down doesn't violate availability
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  minAvailable: "60%"   # Keep at least 60% running at all times
```

## Section 8: Monitoring Autoscaling

### Prometheus Alerts for Scaling Issues

```yaml
groups:
- name: autoscaling
  rules:
  # HPA at maximum — scaling is constrained
  - alert: HPAAtMaximumReplicas
    expr: |
      kube_horizontalpodautoscaler_status_current_replicas
      == kube_horizontalpodautoscaler_spec_max_replicas
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
      description: "HPA has been at maxReplicas for 15m — increase maxReplicas or investigate load"

  # HPA at minimum — potential over-provisioning
  - alert: HPAAtMinimumReplicas
    expr: |
      kube_horizontalpodautoscaler_status_current_replicas
      == kube_horizontalpodautoscaler_spec_min_replicas
      AND kube_horizontalpodautoscaler_spec_min_replicas > 0
    for: 30m
    labels:
      severity: info

  # VPA recommending higher than current requests significantly
  - alert: VPARecommendingHigherResources
    expr: |
      label_replace(
        kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"}
        /
        kube_verticalpodautoscaler_status_recommendation_containerrecommendations_lowerbound{resource="memory"},
        "pod", "$1", "target_pod", "(.*)"
      ) > 2.0
    for: 30m
    labels:
      severity: warning
    annotations:
      summary: "VPA recommends 2x more memory than current lower bound"

  # Cluster Autoscaler scale-up failures
  - alert: ClusterAutoscalerUnschedulablePods
    expr: cluster_autoscaler_unschedulable_pods_count > 0
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "{{ $value }} pods cannot be scheduled"

  # KEDA scale-down to zero with jobs in queue
  - alert: KEDAScaledToZeroWithWork
    expr: |
      keda_scaler_metrics_value > 0
      AND keda_scaled_object_replicas_count == 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "KEDA scaled {{ $labels.scaledObject }} to zero but queue is not empty"
```

### Dashboards Key Metrics

```bash
# Prometheus queries for Grafana dashboard

# HPA scaling history
changes(kube_horizontalpodautoscaler_status_current_replicas{namespace="production"}[1h])

# Replica count over time
kube_deployment_spec_replicas{namespace="production"}

# VPA recommendations vs actual requests
kube_verticalpodautoscaler_status_recommendation_containerrecommendations_target{resource="memory"}
/ kube_pod_container_resource_requests{resource="memory", namespace="production"}

# Cluster Autoscaler activity
rate(cluster_autoscaler_scaled_up_nodes_total[5m])
rate(cluster_autoscaler_scaled_down_nodes_total[5m])

# KEDA queue depth
keda_scaler_metrics_value{namespace="production"}
```

## Section 9: Complete Production Configuration

### Multi-Tier Application with All Four Autoscalers

```yaml
# Tier 1: API servers — HPA on CPU + requests/sec
# Tier 2: Worker pool — KEDA on queue depth, scale to zero
# Tier 3: Database pool — VPA for right-sizing, no HPA
# Infrastructure: Cluster Autoscaler/Karpenter for nodes

---
# API Server: HPA
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-server-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 5
  maxReplicas: 100
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "200"
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
---
# API Server: VPA for memory only
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-server-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  updatePolicy:
    updateMode: "Initial"   # Apply at creation, don't restart running pods
  resourcePolicy:
    containerPolicies:
    - containerName: api-server
      controlledResources: ["memory"]  # Only memory — HPA handles CPU
      minAllowed:
        memory: "256Mi"
      maxAllowed:
        memory: "4Gi"
---
# Worker Pool: KEDA scale to zero
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 0        # Scale to zero
  maxReplicaCount: 50
  cooldownPeriod: 120
  pollingInterval: 15
  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: keda-aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/work-queue
      queueLength: "5"       # 1 replica per 5 messages
      awsRegion: us-east-1
      identityOwner: pod
---
# Worker VPA: right-size workers
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: worker-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: worker
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: worker
      controlledResources: ["cpu", "memory"]  # KEDA controls replicas, VPA controls sizing
      minAllowed:
        cpu: "500m"
        memory: "512Mi"
      maxAllowed:
        cpu: "8"
        memory: "16Gi"
```

## Section 10: Troubleshooting Guide

### HPA Not Scaling

```bash
# Check if metrics are available
kubectl describe hpa web-app-hpa -n production | grep -A 10 "Conditions"

# Common issue: metrics-server not installed
kubectl get deployment metrics-server -n kube-system

# Check if custom metrics API is available
kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1

# Check HPA events
kubectl get events -n production \
  --field-selector involvedObject.kind=HorizontalPodAutoscaler

# Manual metric check
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/production/pods" | jq
```

### KEDA ScaledObject Not Scaling

```bash
# Check ScaledObject status
kubectl describe scaledobject worker-scaledobject -n production

# Check KEDA operator logs
kubectl logs -n keda deployment/keda-operator -f | grep -i error

# Check trigger authentication
kubectl get triggerauthentication -n production
kubectl describe triggerauthentication keda-aws-credentials -n production

# Test the scaler manually
kubectl exec -n keda deployment/keda-operator -- \
  /usr/bin/keda --help

# Check SQS queue depth manually
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/work-queue \
  --attribute-names ApproximateNumberOfMessages
```

### Cluster Autoscaler Not Adding Nodes

```bash
# Check Cluster Autoscaler logs
kubectl logs -n kube-system deployment/cluster-autoscaler | tail -50

# Check why pods are pending
kubectl describe pod pending-pod-xxx -n production | grep -A 10 Events

# Common issues:
# 1. Node group at max size
aws autoscaling describe-auto-scaling-groups \
  --query 'AutoScalingGroups[*].{Name:AutoScalingGroupName,Min:MinSize,Max:MaxSize,Desired:DesiredCapacity}'

# 2. Pod has node selector that no node matches
kubectl get pod pending-pod-xxx -n production \
  -o jsonpath='{.spec.nodeSelector}'

# 3. Pod requests exceed largest available node
kubectl get pod pending-pod-xxx -n production \
  -o jsonpath='{.spec.containers[*].resources.requests}'
```

Understanding how VPA, HPA, KEDA, and Cluster Autoscaler interact — and where they conflict — is the difference between a cluster that scales smoothly under load and one that thrashes, starves, or leaves pods pending indefinitely. Separate the concerns: use VPA for right-sizing, HPA or KEDA for replica count, and Cluster Autoscaler/Karpenter for node capacity. When combining VPA with HPA, restrict each to a different resource dimension.
