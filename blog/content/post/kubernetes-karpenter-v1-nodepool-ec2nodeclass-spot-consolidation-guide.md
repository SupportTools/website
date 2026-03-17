---
title: "Kubernetes Karpenter v1: NodePool, EC2NodeClass, Disruption Budgets, Spot Handling, and Consolidation"
date: 2031-11-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "AWS", "EKS", "Spot Instances", "Autoscaling", "Cost Optimization", "NodePool"]
categories:
- Kubernetes
- AWS
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to Karpenter v1: configuring NodePools and EC2NodeClasses for flexible instance selection, tuning disruption budgets for safe consolidation, handling Spot instance interruptions gracefully, and optimizing node provisioning for cost-efficiency."
more_link: "yes"
url: "/kubernetes-karpenter-v1-nodepool-ec2nodeclass-spot-consolidation-guide/"
---

Karpenter fundamentally changes how Kubernetes scales node infrastructure. Where the Cluster Autoscaler requires pre-configured node groups and scales them one node at a time, Karpenter provisions exactly the right node for each pending pod in seconds — choosing among hundreds of instance types, availability zones, and capacity types to find the optimal fit. With the v1 API stable in Karpenter 1.0, the resource model is now production-ready for enterprise deployments.

This guide covers the complete Karpenter v1 operational model: NodePool and EC2NodeClass configuration, disruption policies for safe consolidation, Spot instance handling, and the tuning required to run Karpenter reliably in large-scale production environments.

<!--more-->

# Kubernetes Karpenter v1: Production Configuration Guide

## Karpenter vs Cluster Autoscaler

| Feature | Karpenter | Cluster Autoscaler |
|---|---|---|
| Instance selection | Any instance type matching requirements | Fixed node groups |
| Provisioning speed | 30-60 seconds | 2-5 minutes |
| Bin packing | Exact-fit across 400+ instance types | Scales fixed groups |
| Spot handling | Native, multi-type fallback | Manual configuration |
| Consolidation | Built-in (removes underutilized nodes) | No |
| Node group management | None required | Required per shape |
| Disruption control | NodePool-level budgets | External tooling |

## Installation

### Prerequisites

```bash
# EKS cluster with OIDC provider
aws eks describe-cluster --name my-cluster \
  --query "cluster.identity.oidc.issuer" --output text

# Enable OIDC if not already done
eksctl utils associate-iam-oidc-provider \
  --cluster my-cluster \
  --approve
```

### IAM Configuration

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Node IAM role policy (attach these managed policies):
- `AmazonEKSWorkerNodePolicy`
- `AmazonEKS_CNI_Policy`
- `AmazonEC2ContainerRegistryReadOnly`
- `AmazonSSMManagedInstanceCore`

Karpenter controller IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowScopedEC2InstanceActions",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:CreateFleet"
      ],
      "Resource": [
        "arn:aws:ec2:*::image/*",
        "arn:aws:ec2:*::snapshot/*",
        "arn:aws:ec2:*:*:spot-instances-request/*",
        "arn:aws:ec2:*:*:security-group/*",
        "arn:aws:ec2:*:*:subnet/*",
        "arn:aws:ec2:*:*:launch-template/*",
        "arn:aws:ec2:*:*:network-interface/*",
        "arn:aws:ec2:*:*:volume/*"
      ]
    },
    {
      "Sid": "AllowScopedEC2InstanceActionsWithTags",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:CreateFleet",
        "ec2:CreateLaunchTemplate"
      ],
      "Resource": [
        "arn:aws:ec2:*:*:fleet/*",
        "arn:aws:ec2:*:*:instance/*"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/kubernetes.io/cluster/my-cluster": "owned"
        },
        "StringLike": {
          "aws:RequestTag/karpenter.sh/nodepool": "*"
        }
      }
    },
    {
      "Sid": "AllowEC2NodeManagement",
      "Effect": "Allow",
      "Action": [
        "ec2:TerminateInstances",
        "ec2:DeleteLaunchTemplate"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/kubernetes.io/cluster/my-cluster": "owned"
        }
      }
    },
    {
      "Sid": "AllowEC2ReadActions",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeImages",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSpotPriceHistory",
        "ec2:DescribeSubnets"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowSSMActions",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:*:*:parameter/aws/service/*"
    }
  ]
}
```

### Helm Installation

```bash
helm repo add karpenter https://charts.karpenter.sh/
helm repo update

helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version 1.0.6 \
  --namespace kube-system \
  --create-namespace \
  --set "settings.clusterName=my-cluster" \
  --set "settings.interruptionQueue=my-cluster-karpenter" \
  --set "controller.resources.requests.cpu=1" \
  --set "controller.resources.requests.memory=1Gi" \
  --set "controller.resources.limits.cpu=1" \
  --set "controller.resources.limits.memory=1Gi" \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::123456789012:role/KarpenterControllerRole" \
  --wait
```

## EC2NodeClass: Defining Hardware Configuration

`EC2NodeClass` defines the AWS-specific configuration for nodes: AMI, subnet selection, security groups, instance profile, and user data.

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: general-purpose
spec:
  # AMI family: AL2023 is recommended for new clusters
  # Options: AL2, AL2023, Bottlerocket, Windows2019, Windows2022, Custom
  amiFamily: AL2023

  # AMI selection: use SSM parameter for latest EKS-optimized AMI
  # This automatically tracks patch releases
  amiSelectorTerms:
  - alias: al2023@latest

  # Subnet selection: use subnets tagged for Karpenter
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: "my-cluster"

  # Security group selection
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: "my-cluster"

  # Instance profile for node IAM role
  role: KarpenterNodeRole-my-cluster

  # EBS root volume configuration
  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeType: gp3
      volumeSize: 50Gi
      iops: 3000
      throughput: 125
      encrypted: true
      # kmsKeyID: arn:aws:kms:us-east-1:123456789012:key/<key-id>
      deleteOnTermination: true

  # Instance metadata service (IMDSv2 required for security)
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1    # IMDSv2 only
    httpTokens: required          # Require session-oriented access

  # User data for additional node configuration
  userData: |
    #!/bin/bash
    /etc/eks/bootstrap.sh my-cluster \
      --b64-cluster-ca "${B64_CLUSTER_CA}" \
      --apiserver-endpoint "${API_SERVER_URL}" \
      --kubelet-extra-args "--max-pods=110"

  # Tags applied to provisioned EC2 instances
  tags:
    Team: platform
    Environment: production
    ManagedBy: karpenter
```

### GPU NodeClass

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-workloads
spec:
  amiFamily: AL2
  amiSelectorTerms:
  - alias: al2@latest

  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: "my-cluster"
      gpu-enabled: "true"

  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: "my-cluster"

  role: KarpenterNodeRole-my-cluster

  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeType: gp3
      volumeSize: 200Gi    # GPU workloads often have large model files
      iops: 6000
      throughput: 250
      encrypted: true
      deleteOnTermination: true

  metadataOptions:
    httpTokens: required
    httpPutResponseHopLimit: 1

  # GPU-specific user data: install NVIDIA drivers
  userData: |
    #!/bin/bash
    # NVIDIA drivers are pre-installed in the GPU-optimized AMI
    # This just configures the nvidia device plugin
    /etc/eks/bootstrap.sh my-cluster \
      --kubelet-extra-args "--node-labels=gpu=true"

  tags:
    Team: ml-platform
    CostCenter: ml-training
```

## NodePool: Scheduling Constraints and Behavior

`NodePool` defines which pods can use it, what instance types are acceptable, and how the pool behaves for disruption.

### General-Purpose NodePool

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general-purpose
spec:
  template:
    metadata:
      labels:
        node-type: general-purpose
      annotations:
        node.kubernetes.io/exclude-from-external-load-balancers: "false"

    spec:
      # Reference the EC2NodeClass
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      # Requirements: constraints on instance selection
      requirements:
      # Instance categories: exclude bare metal and micro instances
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]  # Compute, Memory-general, Memory-optimized

      # Generation: prefer 5th gen and newer
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["4"]

      # CPU architecture
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]

      # OS
      - key: kubernetes.io/os
        operator: In
        values: ["linux"]

      # Capacity type: prefer spot, fall back to on-demand
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]

      # Availability zones
      - key: topology.kubernetes.io/zone
        operator: In
        values: ["us-east-1a", "us-east-1b", "us-east-1c"]

      # Minimum CPU/RAM to avoid tiny instances
      - key: karpenter.k8s.aws/instance-cpu
        operator: Gt
        values: ["1"]
      - key: karpenter.k8s.aws/instance-memory
        operator: Gt
        values: ["3071"]  # > 3GB

      # Taint for node selection (optional)
      # taints:
      # - key: dedicated
      #   value: general
      #   effect: NoSchedule

      # Expiry time: max node lifetime (force periodic rotation)
      expireAfter: 720h  # 30 days

      # Termination grace period for pods on this node
      terminationGracePeriod: 24h

  # Disruption policy: controls when Karpenter can interrupt nodes
  disruption:
    # Consolidation policy
    consolidationPolicy: WhenEmptyOrUnderutilized
    # How long to wait before consolidating an underutilized node
    consolidateAfter: 1m

    # Budget: limits how many nodes can be disrupted simultaneously
    budgets:
    # Never disrupt more than 10% of nodes in this pool at once
    - nodes: "10%"
    # During business hours (9am-5pm UTC weekdays), be more conservative
    - nodes: "5%"
      schedule: "0 9-17 * * 1-5"
      duration: 8h
    # During deployment windows, pause all disruption
    - nodes: "0"
      schedule: "0 2 * * *"    # 2am UTC daily deployment window
      duration: 30m

  # Resource limits for this NodePool
  limits:
    cpu: "1000"
    memory: 2000Gi
```

### Spot-Optimized NodePool

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-optimized
spec:
  template:
    metadata:
      labels:
        node-type: spot

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
      # Large variety of instance types improves spot availability
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]

      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["3"]

      # Only spot
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot"]

      # Wide range of sizes: more options = better spot availability
      - key: karpenter.k8s.aws/instance-size
        operator: In
        values: ["xlarge", "2xlarge", "4xlarge", "8xlarge"]

      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]

      - key: kubernetes.io/os
        operator: In
        values: ["linux"]

      # Spot taint: pods must explicitly tolerate spot
      taints:
      - key: karpenter.sh/capacity-type
        value: spot
        effect: NoSchedule

      expireAfter: 168h  # 7 days max

  disruption:
    # Spot nodes can be consolidated more aggressively
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s

    budgets:
    - nodes: "20%"  # Allow more disruption for spot (spot terminations happen anyway)

  limits:
    cpu: "500"
    memory: 1000Gi
```

### On-Demand Reserved NodePool (Critical Workloads)

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: critical-on-demand
spec:
  weight: 100  # Higher weight = preferred over other pools

  template:
    metadata:
      labels:
        node-type: on-demand

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["on-demand"]  # No spot

      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["m"]  # Balanced: m6i, m6a, m7i, etc.

      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["5"]

      taints:
      - key: workload-type
        value: critical
        effect: NoSchedule

      expireAfter: 2160h  # 90 days

  disruption:
    # Very conservative: only remove truly empty nodes
    consolidationPolicy: WhenEmpty
    consolidateAfter: 10m

    budgets:
    # Never disrupt critical nodes automatically
    # Only allow disruption during maintenance windows
    - nodes: "0"    # Default: no disruption
    - nodes: "1"    # Only 1 at a time during maintenance window
      schedule: "0 3 * * 0"  # Sunday 3am
      duration: 4h

  limits:
    cpu: "200"
    memory: 400Gi
```

### GPU NodePool

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-pool
spec:
  template:
    metadata:
      labels:
        node-type: gpu

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: gpu-workloads

      requirements:
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["p", "g"]  # GPU instance families

      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["3"]

      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]

      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]

      taints:
      - key: nvidia.com/gpu
        effect: NoSchedule

      expireAfter: 720h

  disruption:
    # GPU workloads are expensive to migrate
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m
    budgets:
    - nodes: "10%"

  limits:
    cpu: "500"
    memory: 1000Gi
    # GPU-specific limits require NVIDIA device plugin
    "nvidia.com/gpu": "64"
```

## Spot Instance Handling

Karpenter handles EC2 Spot interruption notices automatically via the SQS interruption queue. When a 2-minute warning arrives, Karpenter:

1. Cordons the node (prevents new pod scheduling)
2. Sends a disruption signal to pods (respects PodDisruptionBudgets)
3. Drains the node
4. Terminates the instance

### SQS Interruption Queue Setup

```bash
# Create SQS queue for Spot interruption notices
aws sqs create-queue \
  --queue-name my-cluster-karpenter \
  --attributes '{"MessageRetentionPeriod":"300"}'

# Create EventBridge rules to forward EC2 events to SQS
aws events put-rule \
  --name SpotInterruptionRule \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": ["EC2 Spot Instance Interruption Warning"]
  }'

aws events put-rule \
  --name RebalanceRecommendationRule \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": ["EC2 Instance Rebalance Recommendation"]
  }'

aws events put-rule \
  --name InstanceStateChangeRule \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": ["EC2 Instance State-change Notification"]
  }'

# Get queue ARN
QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url $(aws sqs get-queue-url --queue-name my-cluster-karpenter --output text) \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

# Add EventBridge targets
for RULE in SpotInterruptionRule RebalanceRecommendationRule InstanceStateChangeRule; do
  aws events put-targets \
    --rule $RULE \
    --targets "Id=1,Arn=${QUEUE_ARN}"
done
```

### Pod Configuration for Spot Tolerance

Pods that can run on Spot must tolerate the spot taint and use appropriate disruption handling:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-processor
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: batch-processor
  template:
    metadata:
      labels:
        app: batch-processor
    spec:
      # Tolerate spot nodes
      tolerations:
      - key: karpenter.sh/capacity-type
        value: spot
        effect: NoSchedule

      # Prefer spot but fall back to on-demand
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["spot"]

      # Spread across AZs for resilience
      topologySpreadConstraints:
      - maxSkew: 2
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: batch-processor

      # Handle SIGTERM for spot interruption
      terminationGracePeriodSeconds: 120  # 2 minutes = spot interruption notice window

      containers:
      - name: processor
        image: batch-processor:latest
        lifecycle:
          preStop:
            exec:
              command: ["/app/checkpoint-and-stop.sh"]  # Save state before termination
```

### PodDisruptionBudget for Critical Workloads

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: "60%"  # Always keep 60% of pods running
  selector:
    matchLabels:
      app: api-server
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb
  namespace: production
spec:
  minAvailable: 2  # At least 2 database pods always available
  selector:
    matchLabels:
      app: database
```

## Consolidation Tuning

Consolidation removes underutilized nodes by rescheduling their pods to other nodes, then terminating the original. This can cause brief disruption — tune it carefully.

### Understanding Consolidation Decisions

Karpenter considers a node for consolidation when:
1. All pods can be rescheduled elsewhere without violating PDBs
2. The resulting node layout is cheaper (fewer or smaller nodes)
3. The `consolidateAfter` duration has elapsed since the node became underutilized

```yaml
# Tune per-workload consolidation with pod annotations
apiVersion: v1
kind: Pod
metadata:
  annotations:
    # Prevent this pod from being disrupted by consolidation
    karpenter.sh/do-not-disrupt: "true"
```

### Monitoring Consolidation Activity

```bash
# Watch Karpenter events
kubectl get events -n kube-system \
  --field-selector reason=Consolidation \
  --watch

# Karpenter metrics
kubectl port-forward -n kube-system svc/karpenter 8000:8000
curl localhost:8000/metrics | grep karpenter_

# Key metrics:
# karpenter_nodes_total{lifecycle="spot"}
# karpenter_nodes_total{lifecycle="on-demand"}
# karpenter_disruption_actions_performed_total{type="consolidation"}
# karpenter_disruption_budgets_allowed_disruptions
# karpenter_provisioner_scheduling_duration_seconds
```

Prometheus alerts:

```yaml
groups:
- name: karpenter
  rules:
  - alert: KarpenterNodeProvisioningTooSlow
    expr: |
      histogram_quantile(0.95,
        rate(karpenter_provisioner_scheduling_duration_seconds_bucket[10m])
      ) > 120
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Karpenter node provisioning p95 exceeds 2 minutes"

  - alert: KarpenterHighDisruptionRate
    expr: |
      rate(karpenter_disruption_actions_performed_total[1h]) > 10
    for: 15m
    labels:
      severity: warning
    annotations:
      summary: "Karpenter is performing more than 10 disruptions/hour"

  - alert: KarpenterUnschedulablePods
    expr: |
      kube_pod_status_unschedulable > 0
    for: 10m
    labels:
      severity: critical
    annotations:
      summary: "Pods have been unschedulable for 10 minutes"
      description: "{{ $value }} pods are unschedulable. Check NodePool limits and requirements."
```

## Workload Annotations for Fine-Grained Control

```yaml
# Prevent disruption entirely (for stateful workloads during critical operations)
metadata:
  annotations:
    karpenter.sh/do-not-disrupt: "true"

# Override node expiry for this pod's node
# (prevents forced recycling from expireAfter)
metadata:
  annotations:
    karpenter.sh/node-expiry-policy: "AlwaysExpire"  # or "NoExpiry"
```

## Multi-Architecture Support

```yaml
# ARM64 NodePool (Graviton: ~40% cost reduction for suitable workloads)
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: arm64-compute
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
      - key: kubernetes.io/arch
        operator: In
        values: ["arm64"]

      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]

      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["6"]  # Graviton3: c7g, m7g, r7g

      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]

      taints:
      - key: kubernetes.io/arch
        value: arm64
        effect: NoSchedule

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 2m
    budgets:
    - nodes: "15%"

  limits:
    cpu: "500"
    memory: 1000Gi
```

Pods that support arm64 must tolerate the taint and specify architecture:

```yaml
spec:
  tolerations:
  - key: kubernetes.io/arch
    value: arm64
    effect: NoSchedule
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - key: kubernetes.io/arch
            operator: In
            values: ["arm64"]
  containers:
  - name: app
    # Must be a multi-arch image or arm64-specific image
    image: my-app:latest
```

## Troubleshooting

```bash
# View Karpenter controller logs
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter \
  -c controller --tail=100 -f

# Check NodePool status
kubectl describe nodepool general-purpose

# List all Karpenter-managed nodes
kubectl get nodeclaims
kubectl get nodes -l karpenter.sh/nodepool

# Describe a NodeClaim for provisioning details
kubectl describe nodeclaim <nodeclaim-name>

# Check why pods are not scheduling
kubectl get pods -n production --field-selector=status.phase=Pending
kubectl describe pod <pending-pod-name> | grep -A10 Events

# Simulate scheduling (dry run)
kubectl run test --image=nginx \
  --overrides='{"spec":{"nodeSelector":{"karpenter.sh/nodepool":"general-purpose"}}}' \
  --dry-run=server

# Check instance type availability for requirements
kubectl get nodeclaims -o json | jq '.items[].spec.requirements'

# Force node expiry (for testing consolidation)
kubectl annotate node <node-name> karpenter.sh/voluntaryDisruptionEligible=true
```

## Summary

Karpenter v1's NodePool and EC2NodeClass API provides a clean, expressive model for defining heterogeneous node infrastructure. The key operational insights are: use wide instance type selection to improve Spot availability, configure disruption budgets that match your workload's tolerance for interruption, always set up the SQS interruption queue for proper Spot handling, and size `terminationGracePeriodSeconds` on pods to match the 2-minute Spot warning window. With consolidation tuned correctly, Karpenter typically reduces EC2 costs 20-40% compared to fixed node groups by continuously right-sizing the cluster and maximizing Spot utilization.
