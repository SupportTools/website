---
title: "Kubernetes Autoscaling Deep Dive: HPA, VPA, KEDA, and Cluster Autoscaler Integration"
date: 2027-05-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HPA", "VPA", "KEDA", "Autoscaling", "Performance"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes autoscaling covering HPA v2 with custom and external metrics, VPA recommender modes, KEDA ScaledObject triggers for Prometheus, Kafka, and RabbitMQ, cluster autoscaler expander strategies, Karpenter, and cost optimization patterns for enterprise production environments."
more_link: "yes"
url: "/kubernetes-hpa-vpa-keda-autoscaling-guide/"
---

Autoscaling in Kubernetes spans three distinct dimensions: application-level horizontal scaling through HPA, application-level vertical resource adjustment through VPA, event-driven workload scaling through KEDA, and infrastructure-level node provisioning through Cluster Autoscaler or Karpenter. Each mechanism solves a different problem, and production systems typically layer all four together. This guide provides production-grade configuration patterns for each autoscaler, addresses the known conflicts between HPA and VPA, and covers the infrastructure autoscaling strategies that determine whether application scaling translates to actual capacity.

<!--more-->

## Horizontal Pod Autoscaler (HPA)

HPA v2 (available since Kubernetes 1.23 as stable) scales the number of pod replicas based on observed metrics. Unlike v1 which only supported CPU utilization, v2 supports arbitrary metrics from three sources: resource metrics (CPU/memory), custom metrics (application-specific metrics via the custom metrics API), and external metrics (metrics from outside the cluster).

### HPA Architecture

HPA operates on a control loop with a default 15-second sync period. The algorithm computes the desired replica count using:

```
desiredReplicas = ceil[currentReplicas * (currentMetricValue / desiredMetricValue)]
```

For multiple metrics, HPA computes the desired replicas for each metric independently and selects the maximum.

### Basic CPU and Memory Scaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

### HPA v2 with Custom Metrics

Custom metrics come from applications instrumented with Prometheus (or another metrics system) and exposed via an adapter (e.g., prometheus-adapter or kube-metrics-adapter).

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa-custom
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 30
  metrics:
  # CPU as a resource metric
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 65
  # Custom metric: requests per second per pod
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
  # Custom metric: queue depth per pod
  - type: Pods
    pods:
      metric:
        name: queue_messages_ready
        selector:
          matchLabels:
            queue: main-worker
      target:
        type: AverageValue
        averageValue: "10"
```

### HPA v2 with External Metrics

External metrics represent values from outside the cluster—a message queue depth, an SQS queue length, or a Datadog metric:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: worker-hpa-external
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: queue-worker
  minReplicas: 1
  maxReplicas: 100
  metrics:
  - type: External
    external:
      metric:
        name: sqs_queue_length
        selector:
          matchLabels:
            queue_name: orders-processing
      target:
        type: AverageValue
        averageValue: "50"
```

### Scale-Down Stabilization and Behavior Policies

By default, HPA can scale down aggressively. In production, premature scale-down followed by rapid scale-up creates latency spikes. The `behavior` field controls scaling velocity:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa-stabilized
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # Wait 5 minutes after last scale before scaling down
      policies:
      - type: Percent
        value: 10      # Scale down no more than 10% of current replicas
        periodSeconds: 60
      - type: Pods
        value: 2       # Scale down no more than 2 pods
        periodSeconds: 60
      selectPolicy: Min  # Use the most conservative policy
    scaleUp:
      stabilizationWindowSeconds: 0  # Scale up immediately
      policies:
      - type: Percent
        value: 100     # Allow doubling
        periodSeconds: 30
      - type: Pods
        value: 10      # Or adding 10 pods at a time
        periodSeconds: 30
      selectPolicy: Max  # Use the most aggressive policy for scale-up
```

### Preventing Flapping with Longer Stabilization Windows

For batch workloads that process jobs in bursts:

```yaml
behavior:
  scaleDown:
    stabilizationWindowSeconds: 600  # 10-minute window
    policies:
    - type: Percent
      value: 20
      periodSeconds: 120
  scaleUp:
    stabilizationWindowSeconds: 60
    policies:
    - type: Percent
      value: 200  # Allow tripling on scale-up
      periodSeconds: 30
    selectPolicy: Max
```

### Prometheus Adapter Configuration for Custom Metrics

```yaml
# prometheus-adapter ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: adapter-config
  namespace: monitoring
data:
  config.yaml: |
    rules:
    - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        matches: "^(.*)_total"
        as: "${1}_per_second"
      metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'

    - seriesQuery: 'rabbitmq_queue_messages_ready{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: {resource: "namespace"}
          pod: {resource: "pod"}
      name:
        matches: "rabbitmq_queue_messages_ready"
        as: "queue_messages_ready"
      metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```

## Vertical Pod Autoscaler (VPA)

VPA adjusts CPU and memory requests (and optionally limits) based on historical usage data. Unlike HPA which changes replica counts, VPA changes the resource profile of individual pods. This is particularly valuable for workloads where the right replica count is known but right-sizing resource requests is difficult.

### VPA Components

- **Recommender**: Continuously monitors resource usage and computes recommended requests. Does not modify pods.
- **Updater**: Evicts pods that have resource requests significantly different from the recommended values (only in Auto and Recreate modes).
- **Admission Controller**: Intercepts pod creation requests and applies the recommended resource values.

### Installing VPA

```bash
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler
./hack/vpa-up.sh

# Or via Helm
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install vpa fairwinds-stable/vpa \
  --namespace vpa-system \
  --create-namespace \
  --set recommender.enabled=true \
  --set updater.enabled=true \
  --set admissionController.enabled=true
```

### VPA Update Modes

```yaml
# Off mode: recommendations computed but not applied
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa-off
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Off"  # Never modify pods; read recommendations only

---
# Initial mode: apply on pod creation only, never evict
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa-initial
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Initial"

---
# Recreate mode: evict pods to apply new recommendations
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa-recreate
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Recreate"

---
# Auto mode: apply recommendations via eviction (default if updateMode omitted)
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa-auto
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"
```

### VPA Resource Policy and Bounds

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: myapp
      minAllowed:
        cpu: 100m
        memory: 128Mi
      maxAllowed:
        cpu: 4000m
        memory: 8Gi
      controlledResources:
      - cpu
      - memory
      controlledValues: RequestsAndLimits
    # Do not adjust the sidecar container
    - containerName: istio-proxy
      mode: "Off"
```

### Reading VPA Recommendations

```bash
kubectl describe vpa myapp-vpa -n production

# Output shows:
# Status:
#   Recommendation:
#     Container Recommendations:
#       Container Name: myapp
#       Lower Bound:
#         Cpu:     100m
#         Memory:  256Mi
#       Target:
#         Cpu:     500m
#         Memory:  1Gi
#       Uncapped Target:
#         Cpu:     450m
#         Memory:  900Mi
#       Upper Bound:
#         Cpu:     2000m
#         Memory:  4Gi
```

### VPA and HPA Coexistence

VPA and HPA cannot both manage CPU or memory on the same deployment simultaneously—they will conflict. The supported coexistence patterns are:

**Pattern 1: VPA manages memory, HPA manages CPU**

```yaml
# VPA: only adjust memory
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: myapp
      controlledResources:
      - memory   # Only control memory, not CPU

---
# HPA: scale on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

**Pattern 2: VPA in Off mode for recommendations, HPA for scaling**

```yaml
# VPA Off mode: use recommendations to inform manual request tuning
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa-recommend
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Off"
```

**Pattern 3: VPA manages requests, HPA uses custom metrics (not CPU/memory)**

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
    - containerName: myapp
      controlledResources:
      - cpu
      - memory

---
# HPA: scale on custom application metric (not CPU/memory)
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: myapp-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"
```

## KEDA (Kubernetes Event-Driven Autoscaling)

KEDA extends Kubernetes HPA capabilities with dozens of built-in scalers for external event sources. KEDA works by creating and managing an HPA object internally while adding a controller that fetches metrics from external sources and exposes them via the custom metrics API.

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.13.0 \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true
```

### KEDA ScaledObject Structure

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: myapp-scaledobject
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  pollingInterval: 15       # Check every 15 seconds
  cooldownPeriod: 300       # Wait 5 minutes before scaling to zero
  idleReplicaCount: 0       # Scale to zero when no messages
  minReplicaCount: 1        # Minimum replicas when active
  maxReplicaCount: 50       # Maximum replicas
  fallback:
    failureThreshold: 3     # Allow 3 consecutive failures before using fallback
    replicas: 5             # Fallback to 5 replicas on metric failure
  advanced:
    restoreToOriginalReplicaCount: true  # Restore original count on ScaledObject deletion
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
          - type: Percent
            value: 10
            periodSeconds: 60
  triggers: []  # Defined per scaler below
```

### Prometheus Scaler

Scale based on any Prometheus metric:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: app-prometheus-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 30
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus-operated.monitoring.svc.cluster.local:9090
      metricName: http_requests_per_second
      query: |
        sum(rate(http_requests_total{namespace="production",deployment="api-server"}[2m]))
      threshold: "100"         # Target: 100 requests/second per replica
      activationThreshold: "5" # Start scaling when > 5 req/s
```

### RabbitMQ Scaler

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: rabbitmq-secret
  namespace: production
type: Opaque
stringData:
  host: "amqp://user:password@rabbitmq.production.svc.cluster.local:5672/vhost"

---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-rabbitmq-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: queue-worker
  minReplicaCount: 0
  maxReplicaCount: 100
  cooldownPeriod: 60
  triggers:
  - type: rabbitmq
    authenticationRef:
      name: rabbitmq-trigger-auth
    metadata:
      host: "amqp://rabbitmq.production.svc.cluster.local:5672/vhost"
      protocol: amqp
      queueName: orders
      mode: QueueLength
      value: "10"              # 1 worker per 10 messages in queue
      activationValue: "1"    # Start at least 1 worker when any message arrives

---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: host
    name: rabbitmq-secret
    key: host
```

### Apache Kafka Scaler

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: kafka-consumer-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: kafka-consumer
  minReplicaCount: 1
  maxReplicaCount: 30
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-bootstrap.kafka.svc.cluster.local:9092
      consumerGroup: my-consumer-group
      topic: orders
      lagThreshold: "100"           # Scale when lag > 100 messages per partition
      offsetResetPolicy: latest
      allowIdleConsumers: "false"   # Do not scale beyond partition count
      scaleToZeroOnInvalidOffset: "false"
      excludePersistentLag: "false"
    authenticationRef:
      name: kafka-trigger-auth

---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-trigger-auth
  namespace: production
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-credentials
    key: sasl
  - parameter: username
    name: kafka-credentials
    key: username
  - parameter: password
    name: kafka-credentials
    key: password
  - parameter: tls
    name: kafka-credentials
    key: tls
  - parameter: ca
    name: kafka-credentials
    key: ca
  - parameter: cert
    name: kafka-credentials
    key: cert
  - parameter: key
    name: kafka-credentials
    key: key
```

### Cron Scaler

Scale based on time schedules—useful for predictable load patterns:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: app-cron-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicaCount: 2
  maxReplicaCount: 30
  triggers:
  # Business hours: scale up proactively
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 8 * * 1-5"    # 8 AM weekdays
      end: "0 18 * * 1-5"     # 6 PM weekdays
      desiredReplicas: "10"
  # Peak hours: maximum capacity
  - type: cron
    metadata:
      timezone: America/New_York
      start: "0 12 * * 1-5"   # Noon weekdays
      end: "0 14 * * 1-5"     # 2 PM weekdays
      desiredReplicas: "25"
```

### AWS SQS Scaler

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-worker-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sqs-worker
  minReplicaCount: 0
  maxReplicaCount: 50
  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: keda-aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/orders
      queueLength: "5"          # 1 worker per 5 messages
      awsRegion: us-east-1
      identityOwner: operator   # Use KEDA's IAM role (IRSA)

---
# Using IRSA for AWS authentication
apiVersion: keda.sh/v1alpha1
kind: ClusterTriggerAuthentication
metadata:
  name: keda-aws-credentials
spec:
  podIdentity:
    provider: aws
    identityId: arn:aws:iam::123456789012:role/keda-sqs-role
```

### KEDA ScaledJob for Batch Workloads

KEDA ScaledJob creates individual Jobs (not pods in a Deployment) for each work item:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: batch-processor
  namespace: production
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    activeDeadlineSeconds: 600
    backoffLimit: 3
    template:
      spec:
        containers:
        - name: processor
          image: myapp/processor:latest
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
        restartPolicy: Never
  pollingInterval: 10
  maxReplicaCount: 50
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10
  triggers:
  - type: rabbitmq
    metadata:
      protocol: amqp
      host: "amqp://rabbitmq.production.svc.cluster.local:5672/"
      queueName: batch-jobs
      mode: QueueLength
      value: "1"  # 1 job per message
    authenticationRef:
      name: rabbitmq-trigger-auth
  scalingStrategy:
    strategy: accurate           # accurate | default | custom
    customScalingQueueLengthDeduction: 1
    customScalingRunningJobPercentage: "0.5"
```

## Cluster Autoscaler

The Cluster Autoscaler (CA) adds and removes nodes based on pending pod pressure and node utilization. It integrates with cloud provider APIs (AWS, GCP, Azure) to provision or terminate instances.

### Core Concepts

- **Scale-up trigger**: A pod remains `Pending` because no existing node has sufficient resources
- **Scale-down trigger**: A node has been underutilized (below 50% by default) for more than 10 minutes and its pods can be rescheduled elsewhere
- **Scale-down safety**: Nodes with system pods, local storage, or pods with no replication controllers are not scaled down

### Expander Strategies

The `--expander` flag controls how CA selects which node group to expand when scale-up is needed:

| Expander | Behavior | Use Case |
|----------|----------|----------|
| `least-waste` | Minimize wasted resources after scale-up | Cost efficiency |
| `most-pods` | Maximize number of scheduled pods | Maximize throughput |
| `price` | Minimize cost (cloud-specific) | Cost optimization |
| `random` | Random selection | Testing, equal node groups |
| `priority` | User-defined priority list | Prefer specific instance types |

```yaml
# Cluster Autoscaler Deployment with priority expander
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
    spec:
      serviceAccountName: cluster-autoscaler
      containers:
      - image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
        name: cluster-autoscaler
        command:
        - ./cluster-autoscaler
        - --v=4
        - --stderrthreshold=info
        - --cloud-provider=aws
        - --skip-nodes-with-local-storage=false
        - --skip-nodes-with-system-pods=false
        - --expander=priority
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/my-cluster
        - --balance-similar-node-groups=true
        - --scale-down-enabled=true
        - --scale-down-delay-after-add=5m
        - --scale-down-unneeded-time=10m
        - --scale-down-utilization-threshold=0.5
        - --max-graceful-termination-sec=600
        - --max-node-provision-time=15m
        - --ignore-daemonsets-utilization=true
        resources:
          requests:
            cpu: 100m
            memory: 300Mi
          limits:
            cpu: 1000m
            memory: 1Gi
```

### Priority Expander Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |
    10:
    - .*spot.*             # Prefer spot/preemptible instances first
    20:
    - .*m5.xlarge.*        # Then m5.xlarge on-demand
    30:
    - .*m5.2xlarge.*       # Then m5.2xlarge
    40:
    - .*                   # Fallback to any node group
```

### Overprovisioning with Pause Pods

Overprovisioning maintains spare capacity by running low-priority placeholder pods that can be evicted immediately when real workloads arrive:

```yaml
# Low-priority PriorityClass for pause pods
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: overprovisioning
value: -1
globalDefault: false
description: "Priority class for overprovisioning placeholder pods"

---
# Deployment of pause containers to reserve capacity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: overprovisioning
  namespace: kube-system
spec:
  replicas: 5  # Reserve capacity for 5 pods
  selector:
    matchLabels:
      app: overprovisioning
  template:
    metadata:
      labels:
        app: overprovisioning
    spec:
      priorityClassName: overprovisioning
      terminationGracePeriodSeconds: 0
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
        resources:
          requests:
            cpu: 1000m
            memory: 1Gi
```

### Node Pool Sizing Recommendations

For production clusters, separate node pools by workload class to optimize cost and performance:

```yaml
# Example EKS node group configuration (Terraform)
resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "system"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = var.private_subnet_ids

  instance_types = ["m5.xlarge"]
  capacity_type  = "ON_DEMAND"

  scaling_config {
    desired_size = 3
    max_size     = 6
    min_size     = 3
  }

  labels = {
    "node-pool" = "system"
    "workload-type" = "system"
  }

  taint {
    key    = "CriticalAddonsOnly"
    value  = "true"
    effect = "NO_SCHEDULE"
  }
}

resource "aws_eks_node_group" "application" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "application-spot"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = var.private_subnet_ids

  # Multiple instance types for spot availability
  instance_types = ["m5.2xlarge", "m5d.2xlarge", "m5n.2xlarge", "m5a.2xlarge"]
  capacity_type  = "SPOT"

  scaling_config {
    desired_size = 3
    max_size     = 50
    min_size     = 1
  }

  labels = {
    "node-pool"     = "application"
    "workload-type" = "application"
  }
}
```

## Karpenter

Karpenter is a newer node provisioner from AWS (now a CNCF project) that provisions nodes directly from cloud APIs without requiring pre-defined Auto Scaling Groups. It provisions the right node for each workload based on pod requirements.

### Karpenter vs Cluster Autoscaler

| Feature | Cluster Autoscaler | Karpenter |
|---------|-------------------|-----------|
| Node group model | Pre-defined ASGs | Dynamic, no ASGs required |
| Node selection | Expander strategy | Per-pod scheduling constraints |
| Provisioning speed | 2-5 minutes | ~30-60 seconds |
| Instance diversity | Per-ASG definition | All instance types in one NodePool |
| Spot fallback | Manual ASG configuration | Automatic with weight configuration |
| Consolidation | Scale-down by utilization | Bin-packing consolidation |

### Karpenter NodePool Configuration

```yaml
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: default
spec:
  template:
    metadata:
      labels:
        node-pool: karpenter-default
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: default
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["m", "c", "r"]
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["4"]
      - key: karpenter.k8s.aws/instance-size
        operator: NotIn
        values: ["nano", "micro", "small", "medium"]
      taints: []
  limits:
    cpu: 1000
    memory: 4000Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    expireAfter: 720h  # Force node replacement every 30 days

---
apiVersion: karpenter.k8s.aws/v1beta1
kind: EC2NodeClass
metadata:
  name: default
spec:
  amiFamily: AL2
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
      volumeSize: 100Gi
      volumeType: gp3
      encrypted: true
```

### Karpenter Spot Interruption Handling

```yaml
# KEDA + Karpenter: scale down before spot interruption
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: spot-optimized
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: spot-optimized
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["m", "c"]
      - key: karpenter.k8s.aws/instance-size
        operator: In
        values: ["2xlarge", "4xlarge"]
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 60s
```

## Autoscaling Cost Impact and Optimization

### Setting Correct Resource Requests

Inaccurate resource requests are the leading cause of poor autoscaling behavior:

```yaml
# Under-requesting causes node saturation before HPA triggers
# Over-requesting causes artificial resource waste and delayed CA scale-down

# Use VPA in Off mode to gather recommendations
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: myapp-vpa-sizing
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: myapp
  updatePolicy:
    updateMode: "Off"  # Observe only
```

### Goldilocks: Automated VPA Recommendation Display

```bash
# Install Goldilocks for VPA recommendations dashboard
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm install goldilocks fairwinds-stable/goldilocks \
  --namespace goldilocks \
  --create-namespace

# Enable VPA recommendations for a namespace
kubectl label namespace production goldilocks.fairwinds.com/enabled=true

# Access the dashboard
kubectl port-forward -n goldilocks svc/goldilocks-dashboard 8080:80
```

### Cost Attribution with Resource Requests

```yaml
# Production autoscaling configuration with cost-aware settings
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cost-aware-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-server
  minReplicas: 2        # Cost floor: always 2 replicas
  maxReplicas: 20       # Cost ceiling: maximum 20 replicas
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 75  # Higher threshold = fewer replicas = lower cost
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 600  # Conservative scale-down to avoid thrashing
      policies:
      - type: Percent
        value: 25
        periodSeconds: 120
    scaleUp:
      stabilizationWindowSeconds: 30   # Fast scale-up for user-facing services
      policies:
      - type: Percent
        value: 50
        periodSeconds: 30
```

### Monitoring Autoscaling Events

```bash
# Watch HPA status
kubectl get hpa -n production -w

# HPA events
kubectl describe hpa myapp-hpa -n production

# KEDA ScaledObject status
kubectl describe scaledobject myapp-scaledobject -n production

# Cluster Autoscaler activity
kubectl -n kube-system logs -l app=cluster-autoscaler --tail=100 \
  | grep -E "scale_up|scale_down|node_group"

# Node scaling events
kubectl get events -n kube-system \
  --field-selector reason=TriggeredScaleUp \
  --sort-by='.lastTimestamp'
```

### PrometheusRule for Autoscaling Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: autoscaling-alerts
  namespace: monitoring
spec:
  groups:
  - name: autoscaling
    rules:
    - alert: HPAAtMaxReplicas
      expr: |
        kube_horizontalpodautoscaler_status_current_replicas
          == kube_horizontalpodautoscaler_spec_max_replicas
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "HPA {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }} at max replicas"
        description: "HPA has been at maximum replicas for 10 minutes, indicating potential capacity shortage."

    - alert: HPAScalingLimitReached
      expr: |
        kube_horizontalpodautoscaler_status_condition{condition="ScalingLimited",status="true"} == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "HPA scaling limited for {{ $labels.namespace }}/{{ $labels.horizontalpodautoscaler }}"
        description: "HPA scaling is being limited. Review minReplicas, maxReplicas, or behavior policies."

    - alert: HighPendingPodCount
      expr: |
        count(kube_pod_status_phase{phase="Pending"} == 1) by (namespace) > 5
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High pending pod count in namespace {{ $labels.namespace }}"
        description: "More than 5 pods have been pending for 5 minutes. Cluster Autoscaler may not be able to provision nodes."

    - alert: ClusterAutoscalerUnhealthy
      expr: |
        sum(up{job="cluster-autoscaler"}) == 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Cluster Autoscaler is not running"
        description: "Cluster Autoscaler has been down for more than 2 minutes. Node scaling will not function."
```

## Complete Reference: Autoscaling Decision Matrix

Use the following to determine which autoscaler(s) to deploy for each workload:

```
Workload Type            | HPA CPU | HPA Custom | VPA  | KEDA | CA/Karpenter
-------------------------|---------|------------|------|------|-------------
HTTP API (stateless)     | Yes     | Optional   | Off  | No   | Yes
Queue workers            | No      | No         | Off  | Yes  | Yes
Batch jobs               | No      | No         | No   | Yes  | Yes
Database (stateful)      | No      | No         | Yes  | No   | Yes
ML inference             | No      | Yes        | Yes  | No   | Yes
Scheduled workloads      | No      | No         | No   | Cron | Yes
Event-driven             | No      | No         | Off  | Yes  | Yes
```

The most common production pattern for stateless HTTP services is:
- HPA on CPU utilization with behavior policies
- VPA in Off mode for resource right-sizing recommendations
- Cluster Autoscaler or Karpenter for node provisioning
- KEDA for queue-based worker pods alongside HPA-managed API pods
