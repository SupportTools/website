---
title: "Kubernetes Karpenter: Next-Generation Node Autoscaling"
date: 2029-05-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "Autoscaling", "AWS", "EKS", "Node Management", "Spot Instances"]
categories: ["Kubernetes", "Cloud Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Karpenter next-generation node autoscaling: NodePool and EC2NodeClass configuration, provisioning policies, spot instance handling, bin packing, and consolidation strategies for production EKS clusters."
more_link: "yes"
url: "/kubernetes-karpenter-next-generation-node-autoscaling/"
---

Karpenter has fundamentally changed how teams think about node autoscaling in Kubernetes. Where the Cluster Autoscaler operates by scaling predefined node groups, Karpenter provisions exactly the right nodes for pending workloads in seconds rather than minutes — selecting instance types, availability zones, and capacity types dynamically based on pod requirements. This guide covers the full operational picture: architecture, NodePool and EC2NodeClass configuration, spot instance handling, bin packing, consolidation, and the operational differences that matter in production.

<!--more-->

# Kubernetes Karpenter: Next-Generation Node Autoscaling

## Why Karpenter Replaces Cluster Autoscaler for Most EKS Workloads

The Cluster Autoscaler (CA) works by adjusting the desired count of Auto Scaling Groups. This means your instance types are fixed at ASG creation time. If a pod requires 48 vCPUs and your ASG runs `m5.xlarge` (4 vCPUs), CA will provision 12 nodes rather than one `m5.12xlarge`. Bin packing is constrained by the ASG's instance type.

Karpenter operates differently: it watches for unschedulable pods, computes the aggregate resource requirements, and calls the EC2 API directly to launch the optimal instance. It is not bound by ASG configurations.

Key architectural differences:

| Feature | Cluster Autoscaler | Karpenter |
|---|---|---|
| Instance selection | Fixed per ASG | Dynamic, from allowed list |
| Provisioning latency | 3-5 minutes | 30-90 seconds |
| Bin packing | Per ASG only | Across all pending pods |
| Spot handling | Manual ASG configuration | Native, with fallback |
| Consolidation | Limited (scale-down only) | Full node consolidation |
| Multi-arch support | Manual ASG per arch | Single NodePool |

## Installing Karpenter on EKS

Karpenter requires an OIDC provider on your EKS cluster and an IAM role with EC2 and SQS permissions.

```bash
# Set environment variables
export CLUSTER_NAME="production-cluster"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export KARPENTER_VERSION="1.0.0"
export KARPENTER_NAMESPACE="kube-system"

# Create the Karpenter IAM role using eksctl
eksctl create iamserviceaccount \
  --cluster "${CLUSTER_NAME}" \
  --namespace "${KARPENTER_NAMESPACE}" \
  --name karpenter \
  --role-name "KarpenterControllerRole-${CLUSTER_NAME}" \
  --attach-policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME}" \
  --approve

# Add Karpenter Helm repository
helm repo add karpenter https://charts.karpenter.sh/
helm repo update

# Install Karpenter
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "${KARPENTER_VERSION}" \
  --namespace "${KARPENTER_NAMESPACE}" \
  --create-namespace \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.interruptionQueue=${CLUSTER_NAME}" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait
```

### IAM Policy for Karpenter Controller

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowScopedEC2InstanceActions",
      "Effect": "Allow",
      "Resource": [
        "arn:aws:ec2:*::image/*",
        "arn:aws:ec2:*::snapshot/*",
        "arn:aws:ec2:*:*:spot-instances-request/*",
        "arn:aws:ec2:*:*:security-group/*",
        "arn:aws:ec2:*:*:subnet/*",
        "arn:aws:ec2:*:*:launch-template/*",
        "arn:aws:ec2:*:*:volume/*",
        "arn:aws:ec2:*:*:network-interface/*",
        "arn:aws:ec2:*:*:instance/*"
      ],
      "Action": [
        "ec2:RunInstances",
        "ec2:CreateFleet"
      ]
    },
    {
      "Sid": "AllowScopedEC2InstanceActionsWithTags",
      "Effect": "Allow",
      "Resource": [
        "arn:aws:ec2:*:*:fleet/*",
        "arn:aws:ec2:*:*:instance/*",
        "arn:aws:ec2:*:*:volume/*",
        "arn:aws:ec2:*:*:network-interface/*",
        "arn:aws:ec2:*:*:launch-template/*",
        "arn:aws:ec2:*:*:spot-instances-request/*"
      ],
      "Action": [
        "ec2:CreateTags"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/kubernetes.io/cluster/CLUSTER_NAME": "owned"
        }
      }
    },
    {
      "Sid": "AllowScopedDeletion",
      "Effect": "Allow",
      "Resource": [
        "arn:aws:ec2:*:*:instance/*",
        "arn:aws:ec2:*:*:launch-template/*"
      ],
      "Action": [
        "ec2:TerminateInstances",
        "ec2:DeleteLaunchTemplate"
      ],
      "Condition": {
        "StringLike": {
          "aws:ResourceTag/karpenter.sh/nodepool": "*"
        }
      }
    },
    {
      "Sid": "AllowRegionalReadActions",
      "Effect": "Allow",
      "Resource": "*",
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
      ]
    },
    {
      "Sid": "AllowInterruptionQueueActions",
      "Effect": "Allow",
      "Resource": "arn:aws:sqs:*:*:CLUSTER_NAME",
      "Action": [
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ReceiveMessage"
      ]
    },
    {
      "Sid": "AllowSSMReadActions",
      "Effect": "Allow",
      "Resource": "arn:aws:ssm:*::parameter/aws/service/*",
      "Action": "ssm:GetParameter"
    },
    {
      "Sid": "AllowPricingReadActions",
      "Effect": "Allow",
      "Resource": "*",
      "Action": "pricing:GetProducts"
    },
    {
      "Sid": "AllowPassingInstanceRole",
      "Effect": "Allow",
      "Resource": "arn:aws:iam::*:role/KarpenterNodeRole-*",
      "Action": "iam:PassRole"
    },
    {
      "Sid": "AllowAPIServerEndpointDiscovery",
      "Effect": "Allow",
      "Resource": "arn:aws:eks:*:*:cluster/CLUSTER_NAME",
      "Action": "eks:DescribeCluster"
    }
  ]
}
```

## NodePool Configuration

The `NodePool` resource replaces the deprecated `Provisioner` CRD from Karpenter v0.x. It defines which pods Karpenter will handle and sets constraints on the nodes it can provision.

### Basic NodePool

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  # Template describes the nodes Karpenter will create
  template:
    metadata:
      labels:
        karpenter.sh/nodepool: default
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
    spec:
      # NodeClassRef points to the cloud-provider-specific config
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default

      # Requirements constrain which nodes Karpenter can provision
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["2"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]
        - key: karpenter.k8s.aws/instance-size
          operator: NotIn
          values: ["nano", "micro", "small", "medium", "large"]

      # Taints applied to all nodes from this NodePool
      taints: []

      # Startup taints are removed once node is ready
      startupTaints:
        - key: node.cloudprovider.kubernetes.io/uninitialized
          effect: NoSchedule

  # Limits set the maximum resources Karpenter can provision for this NodePool
  limits:
    cpu: 1000
    memory: 4000Gi

  # Disruption controls how Karpenter removes nodes
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    expireAfter: 720h  # 30 days
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
        node.kubernetes.io/lifecycle: spot
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default

      requirements:
        # Prefer spot, fall back to on-demand
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        # Use a wide variety of instance families to maximize spot availability
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r", "t"]
        # Minimum 2 vCPUs
        - key: karpenter.k8s.aws/instance-cpu
          operator: Gt
          values: ["1"]
        # Maximum 64 vCPUs to avoid large blast radius on spot reclamation
        - key: karpenter.k8s.aws/instance-cpu
          operator: Lt
          values: ["65"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]

      taints:
        - key: node.kubernetes.io/lifecycle
          value: spot
          effect: NoSchedule

  limits:
    cpu: 500
    memory: 2000Gi

  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 60s
    # Spot nodes may be terminated at any time, no need to expire them
    expireAfter: Never

  # Weight determines preference when multiple NodePools match
  weight: 10
```

### GPU NodePool

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu
spec:
  template:
    metadata:
      labels:
        node.kubernetes.io/instance-type-category: gpu
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: gpu

      requirements:
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["g", "p"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]

      taints:
        - key: nvidia.com/gpu
          effect: NoSchedule

  limits:
    cpu: 200
    memory: 800Gi

  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30s
    expireAfter: 168h  # 7 days

  weight: 50
```

## EC2NodeClass Configuration

`EC2NodeClass` provides AWS-specific configuration that NodePools reference. It controls AMI selection, subnets, security groups, instance profiles, and user data.

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # AMI family determines the bootstrap process and OS
  # Options: AL2, AL2023, Bottlerocket, Ubuntu, Custom
  amiFamily: AL2023

  # Use tag-based subnet discovery
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-cluster

  # Security group discovery by tag
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-cluster

  # Instance profile for the nodes
  instanceProfile: "KarpenterNodeInstanceProfile-production-cluster"

  # Block device mappings
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        deleteOnTermination: true

  # Tags applied to EC2 instances
  tags:
    Environment: production
    ManagedBy: karpenter
    ClusterName: production-cluster

  # User data for additional node configuration
  userData: |
    #!/bin/bash
    # Configure kubelet with additional flags
    cat >> /etc/kubernetes/kubelet/kubelet-config.json << EOF
    {
      "maxPods": 110,
      "kubeReserved": {
        "cpu": "100m",
        "memory": "300Mi"
      },
      "systemReserved": {
        "cpu": "100m",
        "memory": "300Mi"
      }
    }
    EOF
    # Enable kernel parameters for networking
    sysctl -w net.ipv4.conf.all.rp_filter=0
    sysctl -w net.ipv4.ip_local_port_range="1024 65535"
```

### Bottlerocket EC2NodeClass

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: bottlerocket
spec:
  amiFamily: Bottlerocket

  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-cluster

  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-cluster

  instanceProfile: "KarpenterNodeInstanceProfile-production-cluster"

  blockDeviceMappings:
    # Root volume
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 4Gi
        volumeType: gp3
        encrypted: true
    # Data volume for containers
    - deviceName: /dev/xvdb
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true

  # Bottlerocket uses TOML for user data
  userData: |
    [settings.kubernetes]
    max-pods = 110
    eviction-hard = "memory.available<5%,nodefs.available<10%"

    [settings.kernel]
    lockdown = "none"

    [settings.boot.kernel-parameters]
    "net.ipv4.conf.all.rp_filter" = "0"
```

## Spot Instance Handling

Karpenter integrates with the EC2 Instance Interruption Queue to handle spot termination notices gracefully. When AWS sends a two-minute warning before reclaiming a spot instance, Karpenter:

1. Cordons the node to prevent new pods from scheduling
2. Drains the node with a two-minute deadline
3. Terminates the instance after draining

### Setting Up the Interruption Queue

```bash
# Create the SQS queue for interruption notifications
aws sqs create-queue \
  --queue-name "${CLUSTER_NAME}" \
  --attributes '{
    "MessageRetentionPeriod": "300"
  }'

# Get the queue ARN
QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url "https://sqs.${AWS_DEFAULT_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/${CLUSTER_NAME}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

# Create EventBridge rules to forward interruption events
aws events put-rule \
  --name "KarpenterInterruptionQueueRule-${CLUSTER_NAME}" \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": [
      "EC2 Spot Instance Interruption Warning",
      "EC2 Rebalance Recommendation",
      "EC2 Instance State-change Notification",
      "EC2 Instance Scheduled Change"
    ]
  }'

# Add SQS as the target
aws events put-targets \
  --rule "KarpenterInterruptionQueueRule-${CLUSTER_NAME}" \
  --targets "[{\"Id\": \"1\", \"Arn\": \"${QUEUE_ARN}\"}]"
```

### NodePool Spot Fallback Strategy

Use a NodePool with weighted capacity types to implement automatic fallback from spot to on-demand:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: mixed-capacity
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        # Allow both capacity types — Karpenter will prefer spot due to cost
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        # Wide instance family selection improves spot availability
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r", "a", "x"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["3"]
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
```

### Pod Disruption Budgets for Spot Workloads

Always configure PDBs for workloads running on spot nodes:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
spec:
  minAvailable: "50%"
  selector:
    matchLabels:
      app: api-service
---
# For spot-tolerating workloads
apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch-worker
spec:
  replicas: 10
  template:
    spec:
      tolerations:
        - key: node.kubernetes.io/lifecycle
          operator: Equal
          value: spot
          effect: NoSchedule
      # Spread across nodes to reduce blast radius
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: batch-worker
      terminationGracePeriodSeconds: 120
      containers:
        - name: worker
          image: batch-worker:latest
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 30 && graceful-shutdown"]
```

## Bin Packing and Scheduling Simulation

Karpenter runs a scheduling simulation before provisioning any node. It evaluates all pending pods together and computes the minimal set of nodes that can satisfy all requirements including:

- Resource requests (CPU, memory, ephemeral storage, extended resources)
- Node affinity and anti-affinity rules
- Pod affinity and anti-affinity
- Topology spread constraints
- Taints and tolerations

This is fundamentally different from CA which evaluates pods one at a time. The simulation allows Karpenter to launch one `m5.16xlarge` instead of sixteen `m5.xlarge` instances when a batch job lands.

### Forcing Bin Packing Behavior

```yaml
# Prefer packing into fewer, larger nodes
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: batch-packed
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        # Allow large instances for better packing
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["8xlarge", "12xlarge", "16xlarge", "24xlarge"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m"]
  disruption:
    # Don't consolidate — batch jobs may need the capacity again soon
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m
```

## Node Consolidation

Consolidation is Karpenter's mechanism for reducing cost by replacing underutilized nodes with fewer, smaller nodes. It operates in two modes:

**WhenUnderutilized**: Continuously monitors node utilization and consolidates when doing so is safe and cost-effective. Can replace multiple nodes with a single cheaper node or terminate empty nodes.

**WhenEmpty**: Only terminates nodes with no non-daemonset pods scheduled. Less aggressive.

### Consolidation Configuration

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: consolidatable
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["m"]
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    # Nodes older than 7 days get replaced to pick up new AMIs / instance types
    expireAfter: 168h
```

### Preventing Consolidation on Critical Nodes

```yaml
# Annotation to prevent a specific node from being consolidated
kubectl annotate node <node-name> karpenter.sh/do-not-disrupt="true"

# Or at the pod level — prevent eviction during consolidation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-service
spec:
  template:
    metadata:
      annotations:
        # Prevents Karpenter from evicting this pod during consolidation
        karpenter.sh/do-not-disrupt: "true"
    spec:
      containers:
        - name: critical
          image: critical-service:latest
```

## Drift Detection and Node Replacement

Karpenter monitors nodes for drift — situations where the running node no longer matches what the NodePool or EC2NodeClass specifies. Common drift sources:

- AMI updates (new EKS-optimized AMI released)
- EC2NodeClass changes (new user data, different block device)
- NodePool requirement changes

```yaml
# Enable drift detection (default in Karpenter v1.x)
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: auto-updating
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
  disruption:
    # When drift is detected, replace nodes on a rolling basis
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    # Force node replacement after 30 days regardless of drift
    expireAfter: 720h
    # Budget controls how many nodes can be disrupted simultaneously
    budgets:
      - nodes: "10%"
      - nodes: "0"
        schedule: "0 8 * * MON-FRI"
        duration: 8h
```

### Disruption Budgets

Disruption budgets control the rate at which Karpenter can disrupt nodes, preventing mass simultaneous evictions:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: production-safe
spec:
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
    budgets:
      # Allow 10% of nodes to be disrupted at any given time
      - nodes: "10%"
      # Allow maximum 5 nodes to be disrupted simultaneously
      - nodes: "5"
      # No disruption during business hours on weekdays
      - nodes: "0"
        schedule: "0 8 * * MON-FRI"
        duration: 8h
      # Allow more aggressive disruption on weekends
      - nodes: "20%"
        schedule: "0 0 * * SAT"
        duration: 48h
```

## Multi-Architecture NodePools

Karpenter supports running both amd64 and arm64 (AWS Graviton) nodes from a single NodePool, which enables significant cost savings since Graviton instances are typically 20-40% cheaper.

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: multi-arch
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
```

Pods must be built as multi-arch images to run on both architectures:

```yaml
# Pod that can run on either architecture
apiVersion: apps/v1
kind: Deployment
metadata:
  name: multi-arch-service
spec:
  template:
    spec:
      # No architecture affinity — let Karpenter choose the cheapest
      containers:
        - name: service
          # Multi-arch manifest from Docker Hub or ECR
          image: my-org/service:latest
          resources:
            requests:
              cpu: "2"
              memory: 4Gi
```

## Operational Monitoring

### Key Metrics

Karpenter exposes Prometheus metrics on port 8080:

```yaml
# ServiceMonitor for Prometheus scraping
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: karpenter
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: karpenter
  endpoints:
    - port: http-metrics
      interval: 30s
      path: /metrics
```

Critical metrics to alert on:

```yaml
# PrometheusRule for Karpenter alerting
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: karpenter-alerts
  namespace: kube-system
spec:
  groups:
    - name: karpenter
      interval: 1m
      rules:
        - alert: KarpenterProvisioningFailed
          expr: |
            increase(karpenter_provisioner_scheduling_simulation_duration_seconds_count{result="failed"}[5m]) > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Karpenter provisioning simulation failing"

        - alert: KarpenterNodeNotReady
          expr: |
            karpenter_nodes_total{lifecycle="ready"} / karpenter_nodes_total < 0.9
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "More than 10% of Karpenter nodes not ready"

        - alert: KarpenterHighSpotInterruptions
          expr: |
            increase(karpenter_interruption_received_messages_total[1h]) > 10
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "High rate of spot interruptions"

        - alert: KarpenterConsolidationStuck
          expr: |
            karpenter_disruption_budgets_allowed_disruptions == 0
          for: 2h
          labels:
            severity: info
          annotations:
            summary: "Consolidation budget at zero — nodes may not be consolidating"
```

### Useful Debugging Commands

```bash
# View all Karpenter-managed nodes
kubectl get nodes -l karpenter.sh/nodepool

# View NodePool status including limits
kubectl get nodepool -o wide

# See detailed NodePool status
kubectl describe nodepool default

# View NodeClaims (the internal representation of provisioned nodes)
kubectl get nodeclaims

# Watch Karpenter controller logs in real time
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter \
  -c controller --tail=100 -f

# Check why a pod is unschedulable
kubectl describe pod <pending-pod-name> | grep -A 10 "Events:"

# Force consolidation (restart Karpenter to trigger a consolidation scan)
kubectl rollout restart deployment/karpenter -n kube-system

# Annotate a node to prevent disruption
kubectl annotate node <node-name> karpenter.sh/do-not-disrupt="true"

# Check Karpenter configuration
kubectl get configmap karpenter-global-settings -n kube-system -o yaml
```

## Migrating from Cluster Autoscaler

Migration should be done gradually:

```bash
# Step 1: Install Karpenter alongside CA
# Step 2: Create NodePools that match your existing node groups
# Step 3: Cordon all CA-managed nodes
kubectl cordon $(kubectl get nodes -l karpenter.sh/nodepool!= -o name)

# Step 4: Let Karpenter provision replacements as pods reschedule
# Monitor: watch kubectl get nodes

# Step 5: Drain CA nodes
kubectl get nodes -l karpenter.sh/nodepool!= -o name | \
  xargs -I{} kubectl drain {} --ignore-daemonsets --delete-emptydir-data

# Step 6: Scale down CA deployment
kubectl scale deployment cluster-autoscaler \
  --replicas=0 -n kube-system

# Step 7: After validating Karpenter, remove CA entirely
kubectl delete deployment cluster-autoscaler -n kube-system
```

## Production Checklist

Before running Karpenter in production, verify:

- Interruption queue is configured and EventBridge rules are active
- NodePool limits are set to prevent runaway costs
- PDBs exist for all stateful and critical workloads
- Disruption budgets are configured appropriately for production hours
- Multi-arch images are built and tested if using arm64 nodes
- Node expiry is configured for regular AMI rotation
- Spot fallback to on-demand is configured for production workloads
- Prometheus alerts are active for provisioning failures and high interruption rates
- `do-not-disrupt` annotations are applied to nodes running critical singletons
- CA is removed once Karpenter is validated to avoid conflicting decisions

## Summary

Karpenter delivers faster node provisioning, better bin packing, and lower costs than Cluster Autoscaler by eliminating the ASG constraint and implementing a full scheduling simulation before provisioning. The combination of spot instance handling with interruption queues, consolidation with disruption budgets, and drift detection with expiry-based rotation provides a complete lifecycle management solution for cluster nodes. The NodePool and EC2NodeClass API is expressive enough to handle diverse workloads from GPU training jobs to serverless-style burstable compute — all within a single controller.
