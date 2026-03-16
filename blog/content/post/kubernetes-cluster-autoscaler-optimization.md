---
title: "Kubernetes Cluster Autoscaler Optimization: Node Scaling Best Practices"
date: 2026-08-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Autoscaler", "Node Scaling", "Cloud", "Cost Optimization", "Infrastructure"]
categories: ["Kubernetes", "DevOps", "Cloud Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to optimizing Kubernetes Cluster Autoscaler for efficient node scaling, including cloud provider integration, scaling policies, and cost optimization strategies."
more_link: "yes"
url: "/kubernetes-cluster-autoscaler-optimization/"
---

The Kubernetes Cluster Autoscaler automatically adjusts the size of a cluster by adding or removing nodes based on pod scheduling needs. This guide covers advanced configuration, cloud provider integration, optimization strategies, and troubleshooting for production environments.

<!--more-->

## Executive Summary

Cluster Autoscaler (CA) bridges the gap between pod-level autoscaling (HPA/VPA) and infrastructure provisioning by dynamically managing node count. Proper configuration ensures optimal resource utilization, cost efficiency, and application availability while preventing over-provisioning or resource starvation.

## Cluster Autoscaler Architecture

### Core Components and Flow

**How Cluster Autoscaler Works:**

```yaml
# Cluster Autoscaler Decision Loop
# 1. Scan for unschedulable pods (every 10 seconds)
# 2. Simulate pod placement on potential new nodes
# 3. Select optimal node group for expansion
# 4. Trigger cloud provider to add nodes
# 5. Monitor node utilization for scale-down opportunities
# 6. Safely drain and remove underutilized nodes

---
# Cluster Autoscaler Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  replicas: 1  # Should be 1 to avoid conflicts
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8085"
        prometheus.io/path: "/metrics"
    spec:
      priorityClassName: system-cluster-critical
      serviceAccountName: cluster-autoscaler
      containers:
      - name: cluster-autoscaler
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.28.2
        command:
        - ./cluster-autoscaler
        - --v=4
        - --stderrthreshold=info
        - --cloud-provider=aws  # or gce, azure, etc.
        - --namespace=kube-system
        - --nodes=3:100:k8s-worker-nodes-asg  # min:max:asg-name

        # Scaling behavior
        - --scale-down-enabled=true
        - --scale-down-delay-after-add=10m
        - --scale-down-unneeded-time=10m
        - --scale-down-utilization-threshold=0.5
        - --max-node-provision-time=15m
        - --max-graceful-termination-sec=600

        # Advanced options
        - --balance-similar-node-groups=true
        - --skip-nodes-with-local-storage=false
        - --skip-nodes-with-system-pods=false
        - --expander=least-waste  # or priority, random, most-pods
        - --new-pod-scale-up-delay=0s
        - --max-empty-bulk-delete=10
        - --max-total-unready-percentage=45
        - --ok-total-unready-count=3

        # AWS specific
        - --aws-use-static-instance-list=false
        - --balance-similar-node-groups=true

        resources:
          requests:
            cpu: 100m
            memory: 300Mi
          limits:
            cpu: 1000m
            memory: 1Gi

        env:
        - name: AWS_REGION
          value: us-west-2

        volumeMounts:
        - name: ssl-certs
          mountPath: /etc/ssl/certs/ca-certificates.crt
          readOnly: true

        livenessProbe:
          httpGet:
            path: /health-check
            port: 8085
          initialDelaySeconds: 120
          periodSeconds: 60

      volumes:
      - name: ssl-certs
        hostPath:
          path: /etc/ssl/certs/ca-bundle.crt

      nodeSelector:
        kubernetes.io/role: master

      tolerations:
      - effect: NoSchedule
        key: node-role.kubernetes.io/master
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cluster-autoscaler
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cluster-autoscaler
rules:
- apiGroups: [""]
  resources: [events, endpoints]
  verbs: [create, patch]
- apiGroups: [""]
  resources: [pods/eviction]
  verbs: [create]
- apiGroups: [""]
  resources: [pods/status]
  verbs: [update]
- apiGroups: [""]
  resources: [endpoints]
  resourceNames: [cluster-autoscaler]
  verbs: [get, update]
- apiGroups: [""]
  resources: [nodes]
  verbs: [watch, list, get, update]
- apiGroups: [""]
  resources: [namespaces, pods, services, replicationcontrollers, persistentvolumeclaims, persistentvolumes]
  verbs: [watch, list, get]
- apiGroups: [extensions]
  resources: [replicasets, daemonsets]
  verbs: [watch, list, get]
- apiGroups: [policy]
  resources: [poddisruptionbudgets]
  verbs: [watch, list]
- apiGroups: [apps]
  resources: [statefulsets, replicasets, daemonsets]
  verbs: [watch, list, get]
- apiGroups: [storage.k8s.io]
  resources: [storageclasses, csinodes, csidrivers, csistoragecapacities]
  verbs: [watch, list, get]
- apiGroups: [batch, extensions]
  resources: [jobs]
  verbs: [get, list, watch, patch]
- apiGroups: [coordination.k8s.io]
  resources: [leases]
  verbs: [create]
- apiGroups: [coordination.k8s.io]
  resourceNames: [cluster-autoscaler]
  resources: [leases]
  verbs: [get, update]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cluster-autoscaler
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-autoscaler
subjects:
- kind: ServiceAccount
  name: cluster-autoscaler
  namespace: kube-system
```

## Cloud Provider Integration

### AWS Auto Scaling Groups

**AWS IAM Policy for Cluster Autoscaler:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:DescribeScalingActivities",
        "autoscaling:DescribeTags",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeLaunchTemplateVersions"
      ],
      "Resource": ["*"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "ec2:DescribeImages",
        "ec2:GetInstanceTypesFromInstanceRequirements",
        "eks:DescribeNodegroup"
      ],
      "Resource": ["*"]
    }
  ]
}
```

**AWS ASG Configuration:**

```bash
#!/bin/bash
# configure-aws-asg.sh

ASG_NAME="k8s-worker-nodes"
MIN_SIZE=3
MAX_SIZE=100
DESIRED_SIZE=10

# Create launch template
aws ec2 create-launch-template \
  --launch-template-name k8s-worker-template \
  --version-description "Kubernetes worker node template" \
  --launch-template-data '{
    "ImageId": "ami-0abcdef1234567890",
    "InstanceType": "m5.xlarge",
    "IamInstanceProfile": {
      "Name": "k8s-worker-instance-profile"
    },
    "UserData": "'$(base64 -w0 user-data.sh)'",
    "TagSpecifications": [{
      "ResourceType": "instance",
      "Tags": [
        {"Key": "kubernetes.io/cluster/production", "Value": "owned"},
        {"Key": "k8s.io/cluster-autoscaler/enabled", "Value": "true"},
        {"Key": "k8s.io/cluster-autoscaler/production", "Value": "owned"}
      ]
    }]
  }'

# Create Auto Scaling Group
aws autoscaling create-auto-scaling-group \
  --auto-scaling-group-name ${ASG_NAME} \
  --launch-template "LaunchTemplateName=k8s-worker-template,Version=\$Latest" \
  --min-size ${MIN_SIZE} \
  --max-size ${MAX_SIZE} \
  --desired-capacity ${DESIRED_SIZE} \
  --vpc-zone-identifier "subnet-abc123,subnet-def456" \
  --tags \
    "Key=kubernetes.io/cluster/production,Value=owned,PropagateAtLaunch=true" \
    "Key=k8s.io/cluster-autoscaler/enabled,Value=true,PropagateAtLaunch=true" \
    "Key=k8s.io/cluster-autoscaler/production,Value=owned,PropagateAtLaunch=true"

# Enable metrics collection
aws autoscaling enable-metrics-collection \
  --auto-scaling-group-name ${ASG_NAME} \
  --metrics GroupMinSize GroupMaxSize GroupDesiredCapacity \
    GroupInServiceInstances GroupTotalInstances \
  --granularity "1Minute"
```

**Multi-AZ Node Groups:**

```yaml
# aws-multi-az-config.yaml
# Cluster Autoscaler with multiple ASGs for different AZs
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        command:
        - ./cluster-autoscaler
        - --cloud-provider=aws
        # Multiple node groups for different AZs
        - --nodes=3:30:k8s-workers-us-west-2a
        - --nodes=3:30:k8s-workers-us-west-2b
        - --nodes=3:30:k8s-workers-us-west-2c
        # Balance across AZs
        - --balance-similar-node-groups=true
        - --aws-use-static-instance-list=false
```

### Google Cloud (GKE)

**GKE Configuration:**

```bash
#!/bin/bash
# configure-gke-autoscaling.sh

CLUSTER_NAME="production-cluster"
ZONE="us-central1-a"
NODE_POOL="default-pool"

# Create node pool with autoscaling
gcloud container node-pools create ${NODE_POOL} \
  --cluster=${CLUSTER_NAME} \
  --zone=${ZONE} \
  --machine-type=n1-standard-4 \
  --num-nodes=3 \
  --enable-autoscaling \
  --min-nodes=3 \
  --max-nodes=50 \
  --enable-autorepair \
  --enable-autoupgrade \
  --disk-size=100 \
  --disk-type=pd-ssd \
  --node-labels=workload=general \
  --node-taints=key=value:NoSchedule

# Update existing node pool
gcloud container clusters update ${CLUSTER_NAME} \
  --zone=${ZONE} \
  --enable-autoscaling \
  --min-nodes=3 \
  --max-nodes=50 \
  --node-pool=${NODE_POOL}
```

**GKE Cluster Autoscaler Deployment:**

```yaml
# gke-cluster-autoscaler.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.28.2
        command:
        - ./cluster-autoscaler
        - --v=4
        - --cloud-provider=gce
        - --namespace=kube-system
        # GKE specific
        - --gce-project-id=my-gcp-project
        - --nodes=3:50:gke-production-cluster-default-pool
        - --scale-down-delay-after-add=10m
        - --scale-down-unneeded-time=10m
        env:
        - name: GOOGLE_APPLICATION_CREDENTIALS
          value: /var/secrets/google/key.json
        volumeMounts:
        - name: google-cloud-key
          mountPath: /var/secrets/google
      volumes:
      - name: google-cloud-key
        secret:
          secretName: cluster-autoscaler-gcp-key
```

### Azure (AKS)

**AKS Configuration:**

```bash
#!/bin/bash
# configure-aks-autoscaling.sh

RESOURCE_GROUP="production-rg"
CLUSTER_NAME="production-aks"
NODE_POOL_NAME="nodepool1"

# Enable cluster autoscaler
az aks nodepool update \
  --resource-group ${RESOURCE_GROUP} \
  --cluster-name ${CLUSTER_NAME} \
  --name ${NODE_POOL_NAME} \
  --enable-cluster-autoscaler \
  --min-count 3 \
  --max-count 50

# Update autoscaler profile
az aks update \
  --resource-group ${RESOURCE_GROUP} \
  --name ${CLUSTER_NAME} \
  --cluster-autoscaler-profile \
    scale-down-delay-after-add=10m \
    scale-down-unneeded-time=10m \
    scale-down-utilization-threshold=0.5 \
    max-graceful-termination-sec=600
```

## Node Group Strategies

### Heterogeneous Node Groups

**Multiple Instance Types:**

```yaml
# heterogeneous-nodes.yaml
# Deployment targeting specific node types
---
# General purpose workloads
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
spec:
  template:
    spec:
      nodeSelector:
        workload-type: general-purpose
        instance-size: medium
      containers:
      - name: web
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
---
# High-memory workloads
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache-service
spec:
  template:
    spec:
      nodeSelector:
        workload-type: memory-optimized
        instance-size: large
      containers:
      - name: cache
        resources:
          requests:
            cpu: 2000m
            memory: 16Gi
---
# GPU workloads
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ml-training
spec:
  template:
    spec:
      nodeSelector:
        workload-type: gpu
        gpu-type: nvidia-t4
      tolerations:
      - key: nvidia.com/gpu
        operator: Exists
        effect: NoSchedule
      containers:
      - name: training
        resources:
          requests:
            cpu: 4000m
            memory: 32Gi
            nvidia.com/gpu: 1
          limits:
            nvidia.com/gpu: 1
```

**Cluster Autoscaler Configuration for Multiple Node Groups:**

```yaml
# multi-nodegroup-autoscaler.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        command:
        - ./cluster-autoscaler
        - --v=4
        - --cloud-provider=aws

        # General purpose nodes (on-demand)
        - --nodes=5:30:k8s-general-purpose-asg

        # Memory optimized nodes (on-demand)
        - --nodes=2:10:k8s-memory-optimized-asg

        # Compute optimized nodes (spot)
        - --nodes=0:20:k8s-compute-spot-asg

        # GPU nodes (on-demand)
        - --nodes=0:5:k8s-gpu-asg

        # Balance similar node groups
        - --balance-similar-node-groups=true

        # Expander strategy
        - --expander=priority

        volumeMounts:
        - name: expander-config
          mountPath: /etc/cluster-autoscaler
      volumes:
      - name: expander-config
        configMap:
          name: cluster-autoscaler-priority-expander
---
# Priority expander configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |
    10:
      - k8s-compute-spot-asg.*  # Prefer spot instances
    20:
      - k8s-general-purpose-asg.*  # Then general purpose
    30:
      - k8s-memory-optimized-asg.*  # Then memory optimized
    50:
      - k8s-gpu-asg.*  # GPU nodes as last resort
```

### Spot Instance Integration

**Mixed Spot and On-Demand Configuration:**

```yaml
# spot-instance-config.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        command:
        - ./cluster-autoscaler
        - --cloud-provider=aws

        # On-demand baseline (critical workloads)
        - --nodes=5:20:k8s-ondemand-baseline

        # Spot instances (cost optimization)
        - --nodes=0:50:k8s-spot-diversified

        # Mixed on-demand/spot
        - --nodes=3:30:k8s-mixed-asg

        # Balance across spot instance types
        - --balance-similar-node-groups=true
        - --skip-nodes-with-local-storage=false

        # Allow mixed scheduling
        - --ignore-taint=scheduling.cast.ai/spot=true:NoSchedule
---
# Spot instance node affinity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: node.kubernetes.io/lifecycle
                operator: In
                values:
                - spot
      # Tolerate spot instance taints
      tolerations:
      - key: node.kubernetes.io/lifecycle
        operator: Equal
        value: spot
        effect: NoSchedule
      containers:
      - name: processor
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
```

## Scaling Policies and Optimization

### Scale-Down Behavior

**Optimized Scale-Down Configuration:**

```yaml
# scale-down-config.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        command:
        - ./cluster-autoscaler

        # Scale down configuration
        - --scale-down-enabled=true
        - --scale-down-delay-after-add=10m  # Wait 10min after scale-up
        - --scale-down-delay-after-delete=10s  # Wait 10s after node deletion
        - --scale-down-delay-after-failure=3m  # Wait 3min after failed deletion
        - --scale-down-unneeded-time=10m  # Node idle for 10min before removal
        - --scale-down-utilization-threshold=0.5  # Remove if <50% utilized
        - --scale-down-non-empty-candidates-count=30  # Consider 30 nodes
        - --scale-down-candidates-pool-ratio=0.1  # 10% of nodes per scan
        - --scale-down-candidates-pool-min-count=50  # Minimum 50 nodes to consider

        # Bulk operations
        - --max-empty-bulk-delete=10  # Delete up to 10 empty nodes at once
        - --max-node-provision-time=15m  # Max time to provision node
        - --max-graceful-termination-sec=600  # 10min graceful termination

        # Safety limits
        - --max-total-unready-percentage=45  # Don't scale if >45% nodes unready
        - --ok-total-unready-count=3  # Allow 3 unready nodes
```

**Preventing Unwanted Scale-Downs:**

```yaml
# prevent-scale-down.yaml
---
# Annotation on Pod to prevent node scale-down
apiVersion: v1
kind: Pod
metadata:
  name: stateful-app
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
spec:
  containers:
  - name: app
    image: stateful-app:v1
---
# Annotation on Node to prevent scale-down
apiVersion: v1
kind: Node
metadata:
  name: node-1
  annotations:
    cluster-autoscaler.kubernetes.io/scale-down-disabled: "true"
---
# PodDisruptionBudget prevents aggressive scale-down
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: critical-app-pdb
spec:
  minAvailable: 80%
  selector:
    matchLabels:
      app: critical-app
```

### Expander Strategies

**Priority Expander:**

```yaml
# priority-expander.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |
    # Higher number = higher priority
    10:
      - k8s-spot-.*  # Lowest cost - prefer spot
    20:
      - k8s-general-purpose-m5-.*  # General purpose M5
    30:
      - k8s-general-purpose-m6i-.*  # Newer generation M6i
    40:
      - k8s-memory-optimized-.*  # Expensive memory instances
    50:
      - k8s-compute-optimized-.*  # Expensive compute instances
    100:
      - k8s-gpu-.*  # Most expensive - last resort
```

**Least-Waste Expander (default):**

```yaml
# least-waste-config.yaml
# Selects node group that will have least idle resources after scale-up
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        command:
        - ./cluster-autoscaler
        - --expander=least-waste
        # Prefers node group with minimal resource waste
        # Example: If pod needs 2 CPU, 4GB RAM
        # - 4 CPU, 8GB node = 2 CPU, 4GB waste (selected)
        # - 8 CPU, 16GB node = 6 CPU, 12GB waste
```

**Price-Based Expander:**

```yaml
# price-based-expander.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        command:
        - ./cluster-autoscaler
        - --expander=price
        # Requires cloud provider pricing information
        # Selects cheapest node group that satisfies requirements
```

## Advanced Features

### Overprovising for Faster Scaling

**Pause Pods for Buffer Capacity:**

```yaml
# overprovisioning.yaml
---
# Low priority pause pods that get evicted when real workloads need space
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: overprovisioning
value: -1  # Lowest priority
globalDefault: false
description: "Priority class for overprovisioning pods"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: overprovisioner
  namespace: kube-system
spec:
  replicas: 3  # Maintain 3 buffer nodes worth of capacity
  selector:
    matchLabels:
      app: overprovisioner
  template:
    metadata:
      labels:
        app: overprovisioner
    spec:
      priorityClassName: overprovisioning
      terminationGracePeriodSeconds: 0
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
        resources:
          requests:
            # Size to match typical node capacity
            cpu: 3500m  # Leave room for system pods
            memory: 14Gi
---
# When real workloads arrive:
# 1. Pause pods get evicted (low priority)
# 2. Real pods scheduled immediately on existing nodes
# 3. Cluster autoscaler provisions new nodes
# 4. Pause pods get rescheduled, triggering more scale-up if needed
```

### Node Auto-Provisioning

**GKE Node Auto-Provisioning:**

```bash
#!/bin/bash
# Enable GKE Node Auto-Provisioning
gcloud container clusters update production-cluster \
  --enable-autoprovisioning \
  --autoprovisioning-config-file=autoprovisioning.yaml \
  --zone=us-central1-a
```

**autoprovisioning.yaml:**

```yaml
# autoprovisioning.yaml
# GKE automatically creates optimized node pools
autoprovisioningNodePoolDefaults:
  oauthScopes:
  - https://www.googleapis.com/auth/compute
  - https://www.googleapis.com/auth/devstorage.read_only
  - https://www.googleapis.com/auth/logging.write
  - https://www.googleapis.com/auth/monitoring
  serviceAccount: default
  management:
    autoRepair: true
    autoUpgrade: true
  diskSizeGb: 100
  diskType: pd-ssd

resourceLimits:
- resourceType: cpu
  minimum: 10
  maximum: 1000
- resourceType: memory
  minimum: 40
  maximum: 4000
- resourceType: nvidia-tesla-k80
  minimum: 0
  maximum: 16

autoprovisioningLocations:
- us-central1-a
- us-central1-b
- us-central1-c
```

## Monitoring and Observability

### Cluster Autoscaler Metrics

**ServiceMonitor for Prometheus:**

```yaml
# ca-servicemonitor.yaml
apiVersion: v1
kind: Service
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  ports:
  - port: 8085
    name: metrics
  selector:
    app: cluster-autoscaler
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cluster-autoscaler
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: cluster-autoscaler
  namespaceSelector:
    matchNames:
    - kube-system
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
# Cluster Autoscaler Alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cluster-autoscaler-alerts
  namespace: monitoring
spec:
  groups:
  - name: cluster-autoscaler
    interval: 30s
    rules:
    - alert: ClusterAutoscalerDown
      expr: up{job="cluster-autoscaler"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Cluster Autoscaler is down"
        description: "Cluster Autoscaler has been down for 5 minutes"

    - alert: ClusterAutoscalerErrors
      expr: rate(cluster_autoscaler_errors_total[5m]) > 0.1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Cluster Autoscaler experiencing errors"
        description: "Error rate is {{ $value }} errors/second"

    - alert: ClusterAutoscalerUnschedulablePods
      expr: cluster_autoscaler_unschedulable_pods_count > 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Unschedulable pods detected"
        description: "{{ $value }} pods cannot be scheduled"

    - alert: ClusterAutoscalerFailedScaleUps
      expr: rate(cluster_autoscaler_failed_scale_ups_total[10m]) > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Cluster Autoscaler failing to scale up"
        description: "Scale-up failures at rate {{ $value }}/sec"

    - alert: ClusterAutoscalerNodeGroupAtMax
      expr: cluster_autoscaler_nodes_count >= cluster_autoscaler_max_nodes_count
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Node group {{ $labels.node_group }} at maximum capacity"
        description: "Cannot scale up further - review limits"

    - alert: ClusterAutoscalerSlowScaleUp
      expr: histogram_quantile(0.99, rate(cluster_autoscaler_scale_up_duration_seconds_bucket[5m])) > 900
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Slow scale-up detected"
        description: "P99 scale-up time is {{ $value }}s (>15min)"
```

### Grafana Dashboard

**Cluster Autoscaler Dashboard:**

```json
{
  "dashboard": {
    "title": "Cluster Autoscaler Metrics",
    "panels": [
      {
        "title": "Node Count",
        "targets": [
          {
            "expr": "cluster_autoscaler_nodes_count",
            "legendFormat": "{{ node_group }} - Current"
          },
          {
            "expr": "cluster_autoscaler_max_nodes_count",
            "legendFormat": "{{ node_group }} - Max"
          },
          {
            "expr": "cluster_autoscaler_min_nodes_count",
            "legendFormat": "{{ node_group }} - Min"
          }
        ]
      },
      {
        "title": "Unschedulable Pods",
        "targets": [
          {
            "expr": "cluster_autoscaler_unschedulable_pods_count"
          }
        ]
      },
      {
        "title": "Scale Up/Down Events",
        "targets": [
          {
            "expr": "rate(cluster_autoscaler_scaled_up_nodes_total[5m])",
            "legendFormat": "Scale Up"
          },
          {
            "expr": "rate(cluster_autoscaler_scaled_down_nodes_total[5m])",
            "legendFormat": "Scale Down"
          }
        ]
      },
      {
        "title": "Scale Operation Duration",
        "targets": [
          {
            "expr": "histogram_quantile(0.99, rate(cluster_autoscaler_scale_up_duration_seconds_bucket[5m]))",
            "legendFormat": "P99 Scale Up Duration"
          }
        ]
      },
      {
        "title": "Failed Operations",
        "targets": [
          {
            "expr": "rate(cluster_autoscaler_failed_scale_ups_total[5m])",
            "legendFormat": "Failed Scale Ups"
          },
          {
            "expr": "rate(cluster_autoscaler_evicted_pods_total[5m])",
            "legendFormat": "Evicted Pods"
          }
        ]
      }
    ]
  }
}
```

## Troubleshooting

### Diagnostic Script

```bash
#!/bin/bash
# cluster-autoscaler-diagnostics.sh

echo "=== Cluster Autoscaler Status ==="
kubectl get deployment cluster-autoscaler -n kube-system

echo ""
echo "=== Cluster Autoscaler Logs ==="
kubectl logs -n kube-system -l app=cluster-autoscaler --tail=100

echo ""
echo "=== Unschedulable Pods ==="
kubectl get pods --all-namespaces --field-selector=status.phase=Pending

echo ""
echo "=== Node Status ==="
kubectl get nodes -o wide

echo ""
echo "=== Node Group Sizes (AWS) ==="
for asg in $(aws autoscaling describe-auto-scaling-groups \
  --query "AutoScalingGroups[?contains(Tags[?Key=='k8s.io/cluster-autoscaler/enabled'].Value, 'true')].AutoScalingGroupName" \
  --output text); do
  echo "ASG: $asg"
  aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names $asg \
    --query 'AutoScalingGroups[0].[MinSize,DesiredCapacity,MaxSize]' \
    --output text
done

echo ""
echo "=== Recent Cluster Autoscaler Events ==="
kubectl get events -n kube-system --sort-by='.lastTimestamp' | \
  grep cluster-autoscaler | tail -20

echo ""
echo "=== ConfigMap Status ==="
kubectl get configmap cluster-autoscaler-status -n kube-system -o yaml
```

## Best Practices

### Production Checklist

```yaml
# production-ca-checklist.yaml
# Essential configuration for production Cluster Autoscaler

# 1. Set appropriate node group limits
# - Min: High enough for baseline load
# - Max: Within cloud provider quota limits

# 2. Configure scale-down behavior
# - Delay after scale-up: 10-15 minutes
# - Unneeded time: 10 minutes
# - Utilization threshold: 0.4-0.6

# 3. Use PodDisruptionBudgets
# - Protect critical applications
# - Prevent aggressive scale-downs

# 4. Implement resource requests
# - All pods must have resource requests
# - Enables accurate scheduling decisions

# 5. Monitor autoscaler metrics
# - Unschedulable pods count
# - Scale operation duration
# - Failed scale-up attempts

# 6. Use node affinity and anti-affinity
# - Distribute workloads appropriately
# - Prevent resource waste

# 7. Configure overprovisioning
# - Faster scale-up for time-sensitive workloads
# - Balance cost vs. responsiveness

# 8. Test failover scenarios
# - Simulate node failures
# - Verify scale-up behavior

# 9. Set up alerts
# - Autoscaler unavailable
# - Scale-up failures
# - Node group at max capacity

# 10. Document configuration
# - Explain scaling decisions
# - Document expander choice
# - Maintain runbooks
```

## Conclusion

Kubernetes Cluster Autoscaler provides critical infrastructure elasticity for dynamic workloads. Key takeaways:

- Configure appropriate min/max node counts based on workload patterns
- Use multiple node groups for different workload types
- Implement conservative scale-down policies to prevent thrashing
- Leverage spot instances for cost optimization with appropriate fallbacks
- Monitor autoscaler metrics and set up comprehensive alerting
- Test scaling behavior under various load conditions
- Use PodDisruptionBudgets to protect critical workloads during scale-down
- Document autoscaling decisions and maintain operational runbooks

Properly configured Cluster Autoscaler reduces infrastructure costs while maintaining application availability and performance under variable load conditions.