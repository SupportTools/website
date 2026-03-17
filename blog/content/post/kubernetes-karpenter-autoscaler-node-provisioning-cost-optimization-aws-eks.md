---
title: "Kubernetes Karpenter Autoscaler: Node Provisioning, Consolidation, and Cost Optimization on AWS EKS"
date: 2031-06-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "AWS", "EKS", "Autoscaling", "Cost Optimization", "Node Provisioning"]
categories:
- Kubernetes
- AWS
- Cost Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Karpenter on AWS EKS covering NodePools, node consolidation, spot instance strategies, and measurable cost reduction techniques for production clusters."
more_link: "yes"
url: "/kubernetes-karpenter-autoscaler-node-provisioning-cost-optimization-aws-eks/"
---

Karpenter has become the de facto node autoscaler for AWS EKS, replacing the Cluster Autoscaler with a fundamentally different approach to node lifecycle management. Rather than scaling pre-defined node groups, Karpenter provisions nodes directly through the EC2 API based on pending pod requirements, enabling sub-60-second node launch times and significantly improved bin-packing efficiency. For enterprise teams running mixed workloads across Spot and On-Demand instances, Karpenter's consolidation logic alone can reduce compute costs by 30 to 60 percent compared to static node groups.

This guide covers every aspect of a production Karpenter deployment: installation, NodePool design, disruption budgets, consolidation policies, Spot fallback strategies, and the operational tooling needed to measure and sustain cost reductions over time.

<!--more-->

# Kubernetes Karpenter Autoscaler: Node Provisioning, Consolidation, and Cost Optimization on AWS EKS

## Why Karpenter Instead of Cluster Autoscaler

The Cluster Autoscaler operates on node groups (Auto Scaling Groups). When no node group has capacity for a pending pod, it identifies the best group to scale up and waits for EC2 to fulfill the request. This architecture has three fundamental limitations:

- Node group configuration must anticipate future workload shapes
- Scale-up latency is gated by ASG warm-up, often 3 to 5 minutes
- Bin-packing is limited to the instance types configured in each node group

Karpenter solves all three. It reads pod scheduling constraints directly (resource requests, node selectors, affinities, topology spread) and synthesizes the minimum EC2 instance that satisfies them. It maintains no ASG state — it creates and terminates instances directly through the EC2 Fleet API. The practical result is faster scaling, better packing, and dramatically simpler operational configuration.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    EKS Control Plane                     │
└─────────────────────────────┬───────────────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │        Karpenter Controller     │
              │  (Deployment in karpenter ns)   │
              │                                 │
              │  ┌─────────────────────────┐   │
              │  │   NodePool Controller   │   │
              │  │   NodeClaim Controller  │   │
              │  │   EC2NodeClass Ctrl     │   │
              │  └─────────────────────────┘   │
              └───────────┬────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
   ┌──────▼─────┐  ┌──────▼─────┐  ┌────▼──────┐
   │  EC2 Fleet │  │  EC2 Fleet │  │ EC2 Fleet │
   │  On-Demand │  │    Spot    │  │   Spot    │
   │  m7g.2xl   │  │  c7g.4xl   │  │ r7g.8xl   │
   └────────────┘  └────────────┘  └───────────┘
```

Karpenter uses two primary CRDs:

- **NodePool**: Defines constraints (instance families, zones, capacity types) and disruption policies
- **EC2NodeClass**: Defines AWS-specific configuration (AMI selector, subnets, security groups, user data)

A NodeClaim is the internal representation of an individual provisioned node — it is managed by the controller, not the operator.

## Installation

### Prerequisites

You need an EKS cluster with IRSA (IAM Roles for Service Accounts) configured. Karpenter requires specific IAM permissions to create and terminate EC2 instances, describe subnets and security groups, and interact with the EC2 Fleet API.

```bash
export CLUSTER_NAME="production-eks"
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export AWS_REGION="us-east-1"
export KARPENTER_VERSION="1.1.0"
export KARPENTER_NAMESPACE="kube-system"
```

### IAM Role for Karpenter Controller

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowEC2InstanceManagement",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeImages",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeLaunchTemplates",
        "ec2:CreateLaunchTemplate",
        "ec2:DeleteLaunchTemplate",
        "ec2:CreateFleet",
        "ec2:CreateTags"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowSpotInterruptionHandling",
      "Effect": "Allow",
      "Action": [
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ReceiveMessage"
      ],
      "Resource": "arn:aws:sqs:*:*:karpenter-*"
    },
    {
      "Sid": "AllowInstanceProfilePassRole",
      "Effect": "Allow",
      "Action": [
        "iam:PassRole",
        "iam:GetInstanceProfile",
        "iam:CreateInstanceProfile",
        "iam:TagInstanceProfile",
        "iam:AddRoleToInstanceProfile"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowPricingLookup",
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts"
      ],
      "Resource": "*"
    }
  ]
}
```

### Node IAM Role

Nodes launched by Karpenter need their own IAM role for SSM, ECR pull, and VPC CNI:

```bash
aws iam create-role \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ec2.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy

aws iam attach-role-policy \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy

aws iam attach-role-policy \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

aws iam attach-role-policy \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name "KarpenterNodeInstanceProfile-${CLUSTER_NAME}"

aws iam add-role-to-instance-profile \
  --instance-profile-name "KarpenterNodeInstanceProfile-${CLUSTER_NAME}" \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}"
```

### Tag Subnets and Security Groups

Karpenter uses tag-based discovery for subnets and security groups:

```bash
# Tag subnets in each AZ
for SUBNET_ID in $(aws ec2 describe-subnets \
  --filters "Name=tag:kubernetes.io/cluster/${CLUSTER_NAME},Values=shared,owned" \
  --query 'Subnets[].SubnetId' --output text); do
  aws ec2 create-tags \
    --resources "${SUBNET_ID}" \
    --tags "Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}"
done

# Tag cluster security group
CLUSTER_SG=$(aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --query "cluster.resourcesVpcConfig.clusterSecurityGroupId" \
  --output text)

aws ec2 create-tags \
  --resources "${CLUSTER_SG}" \
  --tags "Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}"
```

### Helm Installation

```bash
helm registry logout public.ecr.aws || true
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "${KARPENTER_VERSION}" \
  --namespace "${KARPENTER_NAMESPACE}" \
  --create-namespace \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.interruptionQueue=karpenter-${CLUSTER_NAME}" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --set replicas=2 \
  --wait
```

## EC2NodeClass Configuration

The EC2NodeClass defines the AWS-specific infrastructure configuration shared across NodePools:

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # AMI selection - use AL2023 for EKS 1.30+
  amiSelectorTerms:
    - alias: al2023@latest

  # Subnet discovery by tag
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks

  # Security group discovery
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks

  # Node IAM role
  role: "KarpenterNodeRole-production-eks"

  # EBS configuration
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        deleteOnTermination: true

  # Instance metadata service configuration
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1
    httpTokens: required

  # User data for node bootstrapping
  userData: |
    #!/bin/bash
    # Set kubelet max-pods based on instance type
    # This is automatically handled by AL2023 EKS AMI
    echo "Node bootstrap complete"

  # Tags applied to all EC2 instances launched by this class
  tags:
    ManagedBy: karpenter
    Environment: production
    Team: platform
```

### Specialized EC2NodeClass for GPU Nodes

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-nodes
spec:
  amiSelectorTerms:
    - alias: al2023@latest

  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks
        karpenter.sh/gpu: "true"

  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks

  role: "KarpenterNodeRole-production-eks"

  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 200Gi
        volumeType: gp3
        iops: 6000
        throughput: 500
        encrypted: true
        deleteOnTermination: true

  # Install NVIDIA drivers via userData
  userData: |
    #!/bin/bash
    set -ex
    dnf install -y kernel-devel
    # NVIDIA driver installation handled by device plugin DaemonSet

  tags:
    ManagedBy: karpenter
    NodeType: gpu
    Environment: production
```

## NodePool Design Patterns

### General-Purpose NodePool with Spot Prioritization

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
        # Custom annotation for cost reporting
        team: platform
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      # Scheduling requirements — what pods can land here
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
        - key: kubernetes.io/os
          operator: In
          values: ["linux"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["5"]
        - key: karpenter.k8s.aws/instance-size
          operator: NotIn
          values: ["nano", "micro", "small", "medium", "metal"]

      # Node expiry for security patching
      expireAfter: 720h  # 30 days

      # Startup taints cleared once node is ready
      startupTaints:
        - key: node.kubernetes.io/not-ready
          effect: NoSchedule

  # Disruption configuration
  disruption:
    # Replace nodes when cheaper options are available
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m

    # Budget: max nodes that can be disrupted simultaneously
    budgets:
      - nodes: "10%"
      - schedule: "0 2 * * *"   # Maintenance window: 2AM UTC
        duration: 2h
        nodes: "50%"

  # Resource limits prevent runaway scaling
  limits:
    cpu: 2000
    memory: 4000Gi
```

### Spot-Only NodePool for Fault-Tolerant Workloads

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-batch
spec:
  template:
    metadata:
      labels:
        node-type: spot-batch
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["5"]
        # Wide instance family diversity increases Spot availability
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values:
            - "m7g"
            - "m7i"
            - "m6g"
            - "m6i"
            - "c7g"
            - "c7i"
            - "c6g"
            - "c6i"
            - "m5"
            - "c5"

      taints:
        - key: workload-type
          value: batch
          effect: NoSchedule

      expireAfter: 24h

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
    budgets:
      - nodes: "20%"

  limits:
    cpu: 4000
    memory: 8000Gi
```

### On-Demand NodePool for Stateful Workloads

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: stateful-on-demand
spec:
  template:
    metadata:
      labels:
        node-type: stateful
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["r", "m"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["6"]
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["xlarge", "2xlarge", "4xlarge", "8xlarge"]

      taints:
        - key: workload-type
          value: stateful
          effect: NoSchedule

      # Longer expiry for stateful nodes to avoid disrupting databases
      expireAfter: 2160h  # 90 days

  disruption:
    # Only consolidate empty nodes; do not disrupt running stateful pods
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m
    budgets:
      - nodes: "5%"

  limits:
    cpu: 500
    memory: 2000Gi
```

## Pod Configuration for Karpenter

### Requesting Spot Capacity with On-Demand Fallback

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      # Spread across AZs and nodes for HA
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-service
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-service

      # Prefer Spot but allow On-Demand fallback
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: karpenter.sh/capacity-type
                    operator: In
                    values: ["spot"]
            - weight: 1
              preference:
                matchExpressions:
                  - key: karpenter.sh/capacity-type
                    operator: In
                    values: ["on-demand"]

      # Tolerate Spot interruption drains
      tolerations:
        - key: karpenter.sh/interruption
          operator: Exists
          effect: NoSchedule

      terminationGracePeriodSeconds: 60

      containers:
        - name: api
          image: your-registry/api-service:latest
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"

          # Lifecycle hook for graceful shutdown
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
```

### Batch Job Using Spot with Requeue on Interruption

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing-batch
spec:
  completions: 100
  parallelism: 20
  backoffLimit: 50
  template:
    spec:
      restartPolicy: OnFailure

      nodeSelector:
        node-type: spot-batch

      tolerations:
        - key: workload-type
          value: batch
          effect: NoSchedule
        - key: karpenter.sh/interruption
          operator: Exists
          effect: NoSchedule

      containers:
        - name: processor
          image: your-registry/data-processor:latest
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
          env:
            - name: CHECKPOINT_ENABLED
              value: "true"
            - name: CHECKPOINT_INTERVAL
              value: "30s"
```

## Spot Interruption Handling with SQS

Karpenter integrates with EC2 Spot interruption notices via an SQS queue. This enables graceful draining 2 minutes before termination.

```bash
# Create SQS queue for interruption notifications
aws sqs create-queue \
  --queue-name "karpenter-${CLUSTER_NAME}" \
  --attributes '{
    "MessageRetentionPeriod": "300",
    "ReceiveMessageWaitTimeSeconds": "20"
  }'

QUEUE_URL=$(aws sqs get-queue-url \
  --queue-name "karpenter-${CLUSTER_NAME}" \
  --query QueueUrl --output text)

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url "${QUEUE_URL}" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# EventBridge rule for Spot interruption warnings
aws events put-rule \
  --name "karpenter-interruption-${CLUSTER_NAME}" \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": [
      "EC2 Spot Instance Interruption Warning",
      "EC2 Instance Rebalance Recommendation",
      "EC2 Instance State-change Notification"
    ]
  }'

aws events put-targets \
  --rule "karpenter-interruption-${CLUSTER_NAME}" \
  --targets "[{
    \"Id\": \"karpenter-sqs\",
    \"Arn\": \"${QUEUE_ARN}\"
  }]"
```

## Consolidation Strategy Deep Dive

Karpenter's consolidation engine runs continuously and evaluates whether nodes can be merged or replaced with cheaper instances.

### How Consolidation Works

1. Karpenter identifies underutilized nodes (pods could fit on fewer nodes)
2. It simulates moving pods to remaining nodes, checking all scheduling constraints
3. If the simulation succeeds, it cordons the source node and evicts pods
4. After pods reschedule, it terminates the empty node

### Consolidation Tuning

```yaml
# Aggressive consolidation for dev/test
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 30s
  budgets:
    - nodes: "50%"

# Conservative consolidation for production
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 5m
  budgets:
    - nodes: "10%"
    # Never consolidate during business hours
    - schedule: "0 8 * * 1-5"   # Mon-Fri 8AM
      duration: 10h
      nodes: "0"
    # Allow maintenance window 2-4AM UTC
    - schedule: "0 2 * * *"
      duration: 2h
      nodes: "30%"
```

### Pod Disruption Budgets Integration

Karpenter respects PodDisruptionBudgets during consolidation. Always define PDBs for production workloads:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  # Allow at most 20% of pods to be unavailable
  maxUnavailable: "20%"
  selector:
    matchLabels:
      app: api-service
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb
  namespace: production
spec:
  # Never allow any database pods to be disrupted
  minAvailable: "100%"
  selector:
    matchLabels:
      app: postgresql
```

## Cost Optimization Patterns

### Multi-Architecture with Graviton3

ARM-based Graviton3 instances (m7g, c7g, r7g) offer 20-40% better price-performance than equivalent x86 instances. Karpenter can provision both architectures transparently:

```yaml
# NodePool that prefers Graviton
requirements:
  - key: kubernetes.io/arch
    operator: In
    values: ["arm64", "amd64"]  # arm64 listed first — preferred
  - key: karpenter.k8s.aws/instance-family
    operator: In
    values:
      - "m7g"   # Graviton3
      - "c7g"   # Graviton3
      - "r7g"   # Graviton3
      - "m7i"   # Intel fallback
      - "c7i"   # Intel fallback
```

Ensure your container images are multi-arch:

```bash
# Build multi-arch images with buildx
docker buildx create --use --name multi-arch-builder
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag your-registry/api-service:latest \
  --push .
```

### Right-Sizing with VPA + Karpenter

Use Vertical Pod Autoscaler in recommendation mode alongside Karpenter:

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: api-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  updatePolicy:
    # Recommendation only — Karpenter will right-size nodes
    updateMode: "Off"
  resourcePolicy:
    containerPolicies:
      - containerName: api
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: 8
          memory: 16Gi
        controlledResources: ["cpu", "memory"]
```

Query VPA recommendations and update deployments during off-peak hours:

```bash
kubectl get vpa api-service-vpa -n production -o json | \
  jq '.status.recommendation.containerRecommendations[0].target'
```

### Instance Type Diversity for Spot Availability

The more instance types you allow, the better Spot availability and lower interruption rates:

```yaml
requirements:
  - key: karpenter.sh/capacity-type
    operator: In
    values: ["spot"]
  - key: karpenter.k8s.aws/instance-category
    operator: In
    values: ["c", "m", "r"]
  - key: karpenter.k8s.aws/instance-generation
    operator: Gt
    values: ["4"]
  # Exclude only truly unsuitable sizes
  - key: karpenter.k8s.aws/instance-size
    operator: NotIn
    values: ["nano", "micro", "small", "medium"]
```

This configuration allows Karpenter to choose from 50+ instance types, maximizing Spot pool diversity and minimizing interruption risk.

## Observability and Cost Visibility

### Prometheus Metrics

Karpenter exposes rich metrics at port 8080:

```yaml
# Key metrics to monitor
karpenter_nodes_total                    # Total managed nodes by state
karpenter_pods_state                     # Pod states (pending, running)
karpenter_provisioner_scheduling_*       # Scheduling decision latency
karpenter_nodepool_usage                 # CPU/memory usage by NodePool
karpenter_nodepool_limit                 # Configured limits by NodePool
karpenter_interruption_received_messages # Spot interruptions received
karpenter_consolidation_*               # Consolidation event metrics
```

### Grafana Dashboard

```yaml
# Karpenter ServiceMonitor for Prometheus scraping
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: karpenter
  namespace: kube-system
  labels:
    release: prometheus-operator
spec:
  selector:
    matchLabels:
      app.kubernetes.io/instance: karpenter
  endpoints:
    - port: http-metrics
      interval: 30s
      path: /metrics
```

### Cost Attribution with AWS Cost Explorer Tags

```yaml
# Tag nodes for cost attribution
tags:
  ManagedBy: "karpenter"
  Environment: "production"
  Team: "platform"
  CostCenter: "engineering"
  # Karpenter auto-adds these labels as tags:
  # karpenter.sh/nodepool: <nodepool-name>
  # karpenter.k8s.aws/instance-type: <instance-type>
  # karpenter.sh/capacity-type: spot|on-demand
```

Activate these tags in AWS Cost Explorer for per-NodePool and per-capacity-type cost breakdowns.

## Operational Procedures

### Forcing Node Rollover for Security Patches

When a CVE requires immediate node replacement:

```bash
# Annotate all nodes managed by a NodePool for immediate expiry
kubectl annotate nodes \
  -l karpenter.sh/nodepool=general-purpose \
  karpenter.sh/voluntary-disruption="drift" \
  --overwrite

# Monitor replacement progress
watch kubectl get nodes -l karpenter.sh/nodepool=general-purpose
```

### Draining a Specific Node for Maintenance

```bash
# Cordon to prevent new scheduling
kubectl cordon node-xyz

# Drain with PDB respect
kubectl drain node-xyz \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --grace-period=60 \
  --timeout=300s

# Karpenter will terminate the empty node automatically
```

### Debugging Scheduling Failures

```bash
# Check pending pods and why they are not scheduling
kubectl get pods --field-selector status.phase=Pending -A

# Examine Karpenter scheduling decisions
kubectl logs -n kube-system \
  -l app.kubernetes.io/instance=karpenter \
  --tail=100 | grep -E "INFO|WARN|ERROR"

# Describe a pending pod for constraint details
kubectl describe pod <pending-pod> -n <namespace>

# Check NodePool status
kubectl get nodepools -o wide
kubectl describe nodepool general-purpose
```

### Validating Consolidation is Working

```bash
# Check node utilization
kubectl top nodes

# Count nodes by capacity type
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.labels.karpenter\.sh/capacity-type}{"\n"}{end}' | \
  sort | uniq -c

# Review consolidation events
kubectl get events -n kube-system \
  --field-selector reason=Consolidated \
  --sort-by='.lastTimestamp' | tail -20
```

## Production Best Practices

### 1. Always Define Resource Requests

Karpenter cannot provision the correct node size without accurate resource requests. Missing requests lead to oversized nodes:

```yaml
resources:
  requests:
    cpu: "500m"       # Always set
    memory: "512Mi"   # Always set
  limits:
    cpu: "2"          # Optional but recommended
    memory: "2Gi"     # Always set for memory
```

### 2. Separate Critical and Non-Critical Workloads

Use different NodePools with appropriate disruption settings:

```yaml
# Critical services: conservative disruption
disruption:
  consolidationPolicy: WhenEmpty
  budgets:
    - nodes: "5%"

# Batch jobs: aggressive consolidation
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 30s
  budgets:
    - nodes: "50%"
```

### 3. Set NodePool Limits to Prevent Runaway Costs

```yaml
limits:
  cpu: 1000      # Maximum 1000 CPU cores per NodePool
  memory: 2000Gi # Maximum 2TB RAM per NodePool
```

### 4. Use expireAfter for Security Hygiene

Nodes older than 30 days may be running unpatched kernels. The `expireAfter` field ensures regular node rotation:

```yaml
expireAfter: 720h  # 30 days
```

### 5. Multi-AZ Spread at the NodePool Level

Combine topology spread constraints with multi-AZ subnets in EC2NodeClass. Karpenter will distribute nodes across AZs automatically when pods have zone spread constraints.

## Cost Impact Summary

A representative enterprise cluster migration from Cluster Autoscaler to Karpenter with these patterns typically achieves:

| Metric | Before (Cluster Autoscaler) | After (Karpenter) |
|--------|----------------------------|-------------------|
| Average node utilization | 35-45% | 65-80% |
| Spot adoption rate | 20-30% | 60-80% |
| Node provisioning latency | 3-5 minutes | 30-60 seconds |
| Monthly compute cost | Baseline | 40-55% reduction |
| Wasted resource (unscheduled capacity) | 25-35% | 8-15% |

The combination of better bin-packing through flexible instance selection, aggressive consolidation, and high Spot adoption drives the majority of cost savings. Start with consolidation on dev and staging, validate PDB coverage, then roll out to production during a low-traffic maintenance window.

## Summary

Karpenter fundamentally changes how Kubernetes clusters consume compute capacity. By provisioning nodes directly from pod requirements rather than from fixed node group configurations, it achieves better utilization, faster response, and dramatically lower costs. The key operational levers are NodePool design (instance diversity, capacity type mix), disruption budgets (balancing cost versus stability), and Spot interruption handling (SQS integration and graceful draining). With the patterns in this guide, enterprise teams can deploy Karpenter safely and achieve measurable cost reductions within the first month of operation.
