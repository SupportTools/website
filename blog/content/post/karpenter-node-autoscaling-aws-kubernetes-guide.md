---
title: "Karpenter: Just-in-Time Node Autoscaling for Kubernetes on AWS"
date: 2027-01-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "AWS", "Autoscaling", "EKS"]
categories: ["Kubernetes", "AWS", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep-dive into Karpenter, the just-in-time node provisioner for Kubernetes on AWS. Covers NodePool, EC2NodeClass, spot/on-demand mix, consolidation, drift detection, interruption handling, IRSA setup, and migration from Cluster Autoscaler."
more_link: "yes"
url: "/karpenter-node-autoscaling-aws-kubernetes-guide/"
---

Karpenter replaces the traditional Cluster Autoscaler on AWS-backed Kubernetes clusters with a fundamentally different provisioning model: rather than managing Auto Scaling Groups and working backward from available node group configurations, Karpenter evaluates unschedulable pods directly and provisions the single most efficient EC2 instance to satisfy those requirements — often in under 60 seconds. The result is faster scale-out, dramatically lower bin-packing waste, and a far simpler operational surface.

<!--more-->

## Executive Summary

**Karpenter** launched as an open-source project by AWS in 2021 and reached v1.0 in 2024. It operates as a Kubernetes controller that watches for pods marked `Unschedulable` and provisions new nodes by calling EC2 `RunInstances` directly, bypassing the Auto Scaling Group layer entirely. Two primary custom resources drive behavior: `NodePool` (scheduling constraints, limits, disruption policy) and `EC2NodeClass` (AWS-specific configuration — AMI, subnets, security groups, instance store). This guide walks through every layer of a production-grade Karpenter deployment, from IRSA setup through multi-arch support, consolidation tuning, and migration runbooks.

## Karpenter vs Cluster Autoscaler

### Architectural Differences

**Cluster Autoscaler (CA)** works within the constraints of pre-defined Auto Scaling Groups:

```
Unschedulable Pod
  → CA scans node group ASG configurations
  → Simulates which ASG could fit the pod
  → Calls ASG SetDesiredCapacity
  → ASG launches instance from fixed Launch Template
  → Instance registers with cluster (3-5 min typical)
```

**Karpenter** eliminates the ASG layer:

```
Unschedulable Pod
  → Karpenter reads pod requirements (resources, affinity, topology)
  → Selects optimal instance type from unrestricted EC2 catalog
  → Calls EC2 RunInstances with custom user-data
  → Instance registers with cluster (~60 s typical)
  → NodeClaim CRD tracks lifecycle
```

### Feature Comparison

| Capability | Cluster Autoscaler | Karpenter |
|---|---|---|
| Provisioning speed | 3-5 min | ~60 s |
| Instance selection | Fixed per ASG | Dynamic from full EC2 catalog |
| Spot diversification | Manual, per-ASG | Automatic, single NodePool |
| Bin-packing | Node group granularity | Pod-level bin-packing |
| Consolidation | Scale-down only | Node replacement + scale-down |
| Drift detection | None | AMI/instance drift auto-remediation |
| Custom AMIs | Launch Template per ASG | Single EC2NodeClass selector |
| Multi-arch | Separate ASGs | Single NodePool with arch constraint |

## Prerequisites and IRSA Setup

### IAM Role for Service Account

Karpenter calls EC2 and IAM APIs directly. The controller pod requires an IRSA role with the following policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowScopedEC2InstanceActions",
      "Effect": "Allow",
      "Resource": [
        "arn:aws:ec2:us-east-1::image/*",
        "arn:aws:ec2:us-east-1:111122223333:instance/*",
        "arn:aws:ec2:us-east-1:111122223333:volume/*",
        "arn:aws:ec2:us-east-1:111122223333:network-interface/*",
        "arn:aws:ec2:us-east-1:111122223333:launch-template/*",
        "arn:aws:ec2:us-east-1:111122223333:spot-instances-request/*"
      ],
      "Action": [
        "ec2:RunInstances",
        "ec2:CreateFleet",
        "ec2:CreateLaunchTemplate"
      ]
    },
    {
      "Sid": "AllowScopedEC2InstanceActionsWithTags",
      "Effect": "Allow",
      "Resource": [
        "arn:aws:ec2:us-east-1:111122223333:instance/*",
        "arn:aws:ec2:us-east-1:111122223333:launch-template/*"
      ],
      "Action": [
        "ec2:CreateTags"
      ],
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/kubernetes.io/cluster/production-cluster": "owned"
        },
        "StringLike": {
          "aws:RequestTag/karpenter.sh/nodepool": "*"
        }
      }
    },
    {
      "Sid": "AllowScopedDeletion",
      "Effect": "Allow",
      "Resource": [
        "arn:aws:ec2:us-east-1:111122223333:instance/*",
        "arn:aws:ec2:us-east-1:111122223333:launch-template/*"
      ],
      "Action": [
        "ec2:TerminateInstances",
        "ec2:DeleteLaunchTemplate"
      ],
      "Condition": {
        "StringLike": {
          "ec2:ResourceTag/karpenter.sh/nodepool": "*"
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
      "Sid": "AllowSSMReadActions",
      "Effect": "Allow",
      "Resource": "arn:aws:ssm:us-east-1::parameter/aws/service/*",
      "Action": "ssm:GetParameter"
    },
    {
      "Sid": "AllowPricingReadActions",
      "Effect": "Allow",
      "Resource": "*",
      "Action": "pricing:GetProducts"
    },
    {
      "Sid": "AllowInterruptionQueueActions",
      "Effect": "Allow",
      "Resource": "arn:aws:sqs:us-east-1:111122223333:karpenter-production",
      "Action": [
        "sqs:DeleteMessage",
        "sqs:GetQueueUrl",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage"
      ]
    },
    {
      "Sid": "AllowPassingInstanceRole",
      "Effect": "Allow",
      "Resource": "arn:aws:iam::111122223333:role/KarpenterNodeRole-production-cluster",
      "Action": "iam:PassRole"
    },
    {
      "Sid": "AllowScopedInstanceProfileActions",
      "Effect": "Allow",
      "Resource": "arn:aws:iam::111122223333:instance-profile/*",
      "Action": [
        "iam:AddRoleToInstanceProfile",
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:TagInstanceProfile"
      ]
    },
    {
      "Sid": "AllowAPIServerEndpointDiscovery",
      "Effect": "Allow",
      "Resource": "arn:aws:eks:us-east-1:111122223333:cluster/production-cluster",
      "Action": "eks:DescribeCluster"
    }
  ]
}
```

### Node IAM Role

Nodes provisioned by Karpenter require a separate IAM role:

```bash
#!/bin/bash
# create-karpenter-node-role.sh

CLUSTER_NAME="production-cluster"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create the node instance role
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

# Attach required managed policies
for policy in \
  AmazonEKSWorkerNodePolicy \
  AmazonEKS_CNI_Policy \
  AmazonEC2ContainerRegistryReadOnly \
  AmazonSSMManagedInstanceCore; do
  aws iam attach-role-policy \
    --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
    --policy-arn "arn:aws:iam::aws:policy/${policy}"
done

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name "KarpenterNodeInstanceProfile-${CLUSTER_NAME}"

aws iam add-role-to-instance-profile \
  --instance-profile-name "KarpenterNodeInstanceProfile-${CLUSTER_NAME}" \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}"

# Tag the role so Karpenter can discover it
aws iam tag-role \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --tags "Key=karpenter.k8s.aws/discovery,Value=${CLUSTER_NAME}"
```

### Interruption Handling — SQS Queue

Karpenter subscribes to EC2 Spot interruption notices, rebalance recommendations, and instance health events through an SQS queue. Create the queue and wire up EventBridge rules:

```bash
#!/bin/bash
# setup-karpenter-interruption-queue.sh

CLUSTER_NAME="production-cluster"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
QUEUE_NAME="karpenter-${CLUSTER_NAME}"

# Create SQS queue
QUEUE_URL=$(aws sqs create-queue \
  --queue-name "${QUEUE_NAME}" \
  --attributes '{
    "MessageRetentionPeriod": "300",
    "SqsManagedSseEnabled": "true"
  }' \
  --query QueueUrl --output text)

QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}"

# Allow EventBridge to send to the queue
aws sqs set-queue-attributes \
  --queue-url "${QUEUE_URL}" \
  --attributes "{
    \"Policy\": \"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":[\\\"events.amazonaws.com\\\",\\\"sqs.amazonaws.com\\\"]},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"${QUEUE_ARN}\\\"}]}\"
  }"

# Create EventBridge rules
for rule_name in \
  "KarpenterInterruptionRule-SpotInterruption" \
  "KarpenterInterruptionRule-RebalanceRecommendation" \
  "KarpenterInterruptionRule-InstanceStateChange" \
  "KarpenterInterruptionRule-ScheduledChange"; do

  case "$rule_name" in
    *SpotInterruption)
      PATTERN='{"source":["aws.ec2"],"detail-type":["EC2 Spot Instance Interruption Warning"]}'
      ;;
    *RebalanceRecommendation)
      PATTERN='{"source":["aws.ec2"],"detail-type":["EC2 Instance Rebalance Recommendation"]}'
      ;;
    *InstanceStateChange)
      PATTERN='{"source":["aws.ec2"],"detail-type":["EC2 Instance State-change Notification"]}'
      ;;
    *ScheduledChange)
      PATTERN='{"source":["aws.health"],"detail-type":["AWS Health Event"]}'
      ;;
  esac

  aws events put-rule \
    --name "${rule_name}" \
    --event-pattern "${PATTERN}" \
    --state ENABLED

  aws events put-targets \
    --rule "${rule_name}" \
    --targets "Id=1,Arn=${QUEUE_ARN}"
done

echo "SQS queue ARN: ${QUEUE_ARN}"
```

## Installing Karpenter with Helm

```bash
#!/bin/bash
# install-karpenter.sh

CLUSTER_NAME="production-cluster"
KARPENTER_VERSION="1.1.0"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION="us-east-1"

# Set environment variables for Helm
KARPENTER_NAMESPACE="kube-system"
CLUSTER_ENDPOINT=$(aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --query "cluster.endpoint" \
  --output text)
KARPENTER_IAM_ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterControllerRole-${CLUSTER_NAME}"

# Install Karpenter
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
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="${KARPENTER_IAM_ROLE_ARN}" \
  --set "settings.featureGates.spotToSpotConsolidation=true" \
  --wait
```

### Helm Values for Production HA

```yaml
# karpenter-values.yaml
replicas: 2

podDisruptionBudget:
  name: karpenter
  maxUnavailable: 1

priorityClassName: system-cluster-critical

affinity:
  nodeAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      nodeSelectorTerms:
      - matchExpressions:
        - key: karpenter.sh/nodepool
          operator: DoesNotExist
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
    - labelSelector:
        matchLabels:
          app.kubernetes.io/name: karpenter
      topologyKey: kubernetes.io/hostname

topologySpreadConstraints:
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: DoNotSchedule
  labelSelector:
    matchLabels:
      app.kubernetes.io/name: karpenter

controller:
  resources:
    requests:
      cpu: 1
      memory: 1Gi
    limits:
      cpu: 1
      memory: 1Gi

settings:
  clusterName: production-cluster
  interruptionQueue: karpenter-production-cluster
  batchMaxDuration: 10s
  batchIdleDuration: 1s
  featureGates:
    spotToSpotConsolidation: true

logLevel: info

serviceMonitor:
  enabled: true
  namespace: monitoring
  additionalLabels:
    release: kube-prometheus-stack
```

## EC2NodeClass — AWS-Specific Node Configuration

**EC2NodeClass** is the AWS provider-specific configuration that defines which AMIs, subnets, security groups, and instance profiles Karpenter uses when launching EC2 instances.

```yaml
# ec2nodeclass-general.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: general-purpose
spec:
  # AMI selection — EKS-optimized AMIs via SSM alias
  amiSelectorTerms:
  - alias: al2023@latest

  # Subnet discovery via tags
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster

  # Security group discovery via tags
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster

  # Instance profile for the launched nodes
  role: KarpenterNodeRole-production-cluster

  # EBS volume configuration
  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 100Gi
      volumeType: gp3
      iops: 3000
      throughput: 125
      encrypted: true
      kmsKeyID: arn:aws:kms:us-east-1:111122223333:key/mrk-abcdef1234567890

  # Instance metadata options
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1
    httpTokens: required   # IMDSv2 required

  # Associate public IPs (set false for private subnets)
  associatePublicIPAddress: false

  # User data injected before bootstrap
  userData: |
    #!/bin/bash
    set -ex
    # Custom pre-bootstrap logic
    /etc/eks/bootstrap.sh production-cluster \
      --b64-cluster-ca "${B64_CLUSTER_CA}" \
      --apiserver-endpoint "${API_SERVER_URL}" \
      --kubelet-extra-args '--max-pods=110 --node-labels=node.kubernetes.io/lifecycle=spot'
```

### Custom AMI with AL2023

```yaml
# ec2nodeclass-custom-ami.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: custom-ami
spec:
  # Select AMI by tag instead of SSM alias
  amiSelectorTerms:
  - tags:
      kubernetes-version: "1.31"
      ami-type: eks-optimized-hardened
      environment: production
  # Alternatively select by name pattern
  # - name: "eks-hardened-al2023-*"

  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster
      subnet-tier: private

  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster

  role: KarpenterNodeRole-production-cluster

  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 200Gi
      volumeType: gp3
      iops: 6000
      throughput: 250
      encrypted: true

  metadataOptions:
    httpEndpoint: enabled
    httpPutResponseHopLimit: 1
    httpTokens: required
```

### GPU Node Class

```yaml
# ec2nodeclass-gpu.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-nodes
spec:
  amiSelectorTerms:
  - alias: al2023@latest

  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster
      subnet-tier: private

  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster

  role: KarpenterNodeRole-production-cluster

  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 200Gi
      volumeType: gp3
      encrypted: true

  userData: |
    #!/bin/bash
    set -ex
    # Install NVIDIA drivers for GPU instances
    yum install -y kernel-devel-$(uname -r) kernel-headers-$(uname -r)
    # NVIDIA driver install handled by NVIDIA operator DaemonSet
    # Bootstrap with extra args for GPU
    /etc/eks/bootstrap.sh production-cluster \
      --kubelet-extra-args '--max-pods=110 --register-with-taints=nvidia.com/gpu=true:NoSchedule'
```

## NodePool CRD — Scheduling Policy and Limits

**NodePool** defines which pods Karpenter is allowed to provision nodes for, what instance types and capacities are allowed, and how aggressive consolidation should be.

```yaml
# nodepool-general.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general-purpose
spec:
  # Template for every Node provisioned by this NodePool
  template:
    metadata:
      labels:
        workload-class: general-purpose
      annotations:
        # Custom annotation propagated to Node objects
        cost-center: platform-team
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      # Instance requirements — all conditions are ANDed
      requirements:
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
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
        values: ["3"]
      - key: karpenter.k8s.aws/instance-size
        operator: NotIn
        values: ["nano", "micro", "small", "medium", "metal"]
      - key: karpenter.k8s.aws/instance-hypervisor
        operator: In
        values: ["nitro"]

      # Expiry: nodes older than 720h are replaced (drift)
      expireAfter: 720h

      # Startup taints: cleared once node is ready
      startupTaints:
      - key: node.cloudprovider.kubernetes.io/uninitialized
        effect: NoSchedule

  # Hard limits on total resource provisioned by this NodePool
  limits:
    cpu: 2000
    memory: 8000Gi

  # Disruption — how Karpenter consolidates
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
    # budgets: how many nodes can be disrupted simultaneously
    budgets:
    - nodes: "10%"
    # Protect nodes during business hours
    - nodes: "0"
      schedule: "0 9 * * mon-fri"
      duration: 8h

  # NodePool weight when multiple NodePools match a pod
  weight: 10
```

### Spot-Optimized NodePool

```yaml
# nodepool-spot-compute.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-compute
spec:
  template:
    metadata:
      labels:
        workload-class: batch
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot"]   # Spot only for batch
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["3"]
      - key: karpenter.k8s.aws/instance-size
        operator: In
        values: ["xlarge", "2xlarge", "4xlarge"]

      expireAfter: 336h

      taints:
      - key: workload-class
        value: batch
        effect: NoSchedule

  limits:
    cpu: 4000
    memory: 16000Gi

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
    budgets:
    - nodes: "20%"

  weight: 20
```

### GPU NodePool

```yaml
# nodepool-gpu.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-inference
spec:
  template:
    metadata:
      labels:
        workload-class: gpu
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: gpu-nodes

      requirements:
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64"]
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["on-demand"]   # GPU spot is scarce; on-demand for reliability
      - key: karpenter.k8s.aws/instance-family
        operator: In
        values: ["p3", "p4", "g4dn", "g5"]
      - key: karpenter.k8s.aws/instance-size
        operator: NotIn
        values: ["metal"]

      expireAfter: 2160h   # 90 days

      taints:
      - key: nvidia.com/gpu
        effect: NoSchedule

  limits:
    cpu: 256
    memory: 2000Gi
    nvidia.com/gpu: "32"

  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m
    budgets:
    - nodes: "0"    # Never disrupt GPU nodes during business hours
      schedule: "0 8 * * mon-fri"
      duration: 10h
    - nodes: "1"

  weight: 100
```

### Multi-Arch NodePool

```yaml
# nodepool-multiarch.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: multi-arch
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
        values: ["amd64", "arm64"]   # Graviton and x86
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["3"]

  limits:
    cpu: 1000
    memory: 4000Gi

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 2m
    budgets:
    - nodes: "10%"

  weight: 15
```

## Provisioning Workflow Deep Dive

### How Karpenter Selects Instances

When a pod becomes unschedulable, Karpenter:

1. Reads the pod's `resources.requests`, `nodeSelector`, `affinity`, `topologySpreadConstraints`, and tolerations.
2. Fetches the current EC2 instance type catalog from the `nodeClassRef` subnet AZs.
3. Scores each eligible instance type by bin-packing efficiency (CPU, memory, extended resources).
4. Prefers **spot** over **on-demand** if allowed by the `NodePool` requirements, selecting from the most price-stable spot pools (diversified across instance families).
5. Issues `RunInstances` with the selected instance type, subnet, security groups, user-data, and IAM instance profile.
6. Creates a `NodeClaim` CRD to track the in-flight provisioning request.
7. Once the instance registers as a Node, labels/taints from the `NodePool` template are applied.

### Pod Scheduling Interaction

Pods interact with Karpenter-provisioned nodes through standard Kubernetes scheduling primitives:

```yaml
# pod-with-karpenter-hints.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
spec:
  replicas: 6
  template:
    spec:
      # Request specific capacity type
      nodeSelector:
        karpenter.sh/capacity-type: on-demand
        workload-class: general-purpose

      # Topology spread across AZs
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: web-api

      # Tolerate batch taint if needed
      tolerations:
      - key: workload-class
        value: batch
        effect: NoSchedule
        operator: Equal

      containers:
      - name: api
        image: web-api:v2.5.0
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
          limits:
            cpu: 2000m
            memory: 2Gi
---
# Batch job targeting spot nodes
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing
spec:
  parallelism: 50
  template:
    spec:
      restartPolicy: OnFailure
      nodeSelector:
        workload-class: batch
      tolerations:
      - key: workload-class
        value: batch
        effect: NoSchedule
      containers:
      - name: processor
        image: data-processor:v1.0.0
        resources:
          requests:
            cpu: 2000m
            memory: 4Gi
```

## Consolidation and Drift Detection

### Consolidation Policy

**Consolidation** is Karpenter's mechanism for replacing or removing nodes after workloads shift, reducing idle capacity. Two policies are available:

- `WhenEmpty`: Remove nodes only when all pods have been evicted or completed.
- `WhenEmptyOrUnderutilized`: Actively bin-pack by replacing a lightly loaded node with a smaller instance type.

```yaml
# Consolidation with disruption budget
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 1m    # How long a node must be underutilized before consolidation
  budgets:
  # During any rolling window, no more than 10% of nodes may be disrupted
  - nodes: "10%"
  # Zero disruptions on weekends
  - nodes: "0"
    schedule: "0 0 * * sat-sun"
    duration: 48h
```

### Drift Detection

**Drift** occurs when a provisioned node's configuration diverges from the current `NodePool` or `EC2NodeClass` specification. Common drift triggers:

- A new AMI is published matching `amiSelectorTerms`
- The `EC2NodeClass` security groups or subnet tags change
- Node `expireAfter` TTL is reached

When drift is detected, Karpenter gracefully replaces the node: cordon and drain the old node, provision a replacement, then terminate the original.

```bash
# Force drift on all nodes in a NodePool to trigger rolling AMI update
kubectl annotate nodeclaims -l karpenter.sh/nodepool=general-purpose \
  karpenter.sh/voluntaryDisruptionClass=drift

# Check drift status
kubectl get nodeclaims -l karpenter.sh/nodepool=general-purpose \
  -o custom-columns=NAME:.metadata.name,STATE:.status.conditions[-1].type,REASON:.status.conditions[-1].message
```

## Interruption Handling

When the SQS queue is configured (via `settings.interruptionQueue`), Karpenter:

1. Receives Spot interruption warning (2-minute advance notice).
2. Immediately cordons the targeted node.
3. Drains pods respecting PodDisruptionBudgets.
4. Provisions a replacement node in parallel.
5. Terminates the interrupted instance after drain completes.

This results in a significantly smoother spot interruption experience compared to relying solely on node-termination-handler:

```yaml
# Verify interruption handling is active
# Check karpenter logs
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter \
  --since=1h | grep -i interrupt

# Example log output:
# {"level":"info","msg":"found interruption event","nodeID":"i-0abcdef1234567890","eventType":"SpotInterruption"}
# {"level":"info","msg":"cordoned node","node":"ip-10-0-1-50.ec2.internal"}
# {"level":"info","msg":"deleted node","node":"ip-10-0-1-50.ec2.internal"}
```

## Cost Optimization Patterns

### Spot Diversification Strategy

```yaml
# nodepool-spot-diversified.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-diversified
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot"]
      # Accept many instance families to maximize spot availability
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r", "t"]
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["2"]
      # Accept a range of sizes for flexibility
      - key: karpenter.k8s.aws/instance-size
        operator: In
        values: ["large", "xlarge", "2xlarge", "4xlarge"]
      - key: karpenter.k8s.aws/instance-hypervisor
        operator: In
        values: ["nitro"]

  limits:
    cpu: 5000
    memory: 20000Gi

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
    budgets:
    - nodes: "20%"

  weight: 5
```

### On-Demand Baseline with Spot Overflow

```yaml
# Two NodePools: on-demand baseline, spot overflow
# Priority is controlled by the `weight` field
# Lower weight = higher priority

---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: on-demand-baseline
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["on-demand"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["m"]
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["5"]
      - key: karpenter.k8s.aws/instance-size
        operator: In
        values: ["xlarge", "2xlarge"]
  limits:
    cpu: 200   # Baseline: only 200 vCPU on-demand
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
  weight: 100   # Low weight = used only when spot pools are full

---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-overflow
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["3"]
  limits:
    cpu: 5000
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
  weight: 10   # High weight = preferred
```

## Monitoring with Prometheus

### ServiceMonitor and Alerts

```yaml
# karpenter-monitoring.yaml
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: karpenter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: karpenter
  namespaceSelector:
    matchNames:
    - kube-system
  endpoints:
  - port: http-metrics
    interval: 30s
    path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: karpenter-alerts
  namespace: monitoring
spec:
  groups:
  - name: karpenter.provisioner
    interval: 30s
    rules:
    - alert: KarpenterNodeClaimNotLaunched
      expr: |
        karpenter_nodeclaims_total{state="launched"} == 0
        and karpenter_pods_state{state="pending"} > 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Karpenter has pending pods but no launched NodeClaims"
        description: "{{ $value }} pods are pending with no new nodes launched."

    - alert: KarpenterProvisioningErrors
      expr: |
        rate(karpenter_nodeclaims_total{state="failed"}[5m]) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Karpenter is failing to provision nodes"
        description: "NodeClaim failures detected."

    - alert: KarpenterNodePoolLimitReached
      expr: |
        karpenter_nodepool_usage_percent > 90
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "NodePool {{ $labels.nodepool }} usage above 90%"
        description: "Limit: {{ $value }}%"

    - alert: KarpenterHighInterruptionRate
      expr: |
        rate(karpenter_interruption_actions_performed_total[10m]) > 0.1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High spot interruption rate on Karpenter nodes"
        description: "Interruption actions: {{ $value }}/s"

    - alert: KarpenterConsolidationStalled
      expr: |
        karpenter_nodeclaims_total{state="terminating"} > 5
        and rate(karpenter_nodeclaims_total{state="terminated"}[10m]) == 0
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Karpenter consolidation stalled"
        description: "Nodes are stuck in terminating state."
```

### Key Metrics Reference

```bash
# Useful Karpenter Prometheus metrics

# Node provisioning latency
karpenter_nodes_total_time_in_state_seconds{state="pending"}

# NodeClaim lifecycle
karpenter_nodeclaims_total{state="initialized|launched|registered|failed|terminating"}

# NodePool utilization
karpenter_nodepool_usage{resource="cpu|memory"}
karpenter_nodepool_limit{resource="cpu|memory"}

# Pod scheduling latency (time between unschedulable → running)
karpenter_pods_total_time_in_state_seconds{state="pending"}

# Consolidation activity
karpenter_disruption_actions_performed_total{action="consolidation|emptiness|drift|expiration"}
karpenter_disruption_eligible_nodes

# EC2 instance type selection distribution
karpenter_nodeclaims_instance_type_selected_total
```

## Migrating from Cluster Autoscaler

### Migration Strategy

Migration should be phased to prevent disruption:

```bash
#!/bin/bash
# migrate-from-cluster-autoscaler.sh
# Phase 1: Install Karpenter alongside CA (parallel operation)
# Phase 2: Label workloads to prefer Karpenter nodes
# Phase 3: Scale down CA node groups to 0
# Phase 4: Remove CA

CLUSTER_NAME="production-cluster"

echo "=== Phase 1: Verify Karpenter is healthy ==="
kubectl rollout status deployment/karpenter -n kube-system --timeout=120s
kubectl get nodepools
kubectl get ec2nodeclasses

echo "=== Phase 2: Cordon all CA-managed nodes to stop CA from scheduling new pods ==="
# Do NOT drain yet — let workloads naturally shift
for node in $(kubectl get nodes -l karpenter.sh/nodepool -o name 2>/dev/null || echo ""); do
  echo "Karpenter node: $node"
done

echo "=== Phase 3: Scale CA-managed ASGs to 0 min/0 desired ==="
for asg in $(aws autoscaling describe-auto-scaling-groups \
  --query "AutoScalingGroups[?contains(Tags[?Key=='k8s.io/cluster-autoscaler/enabled'].Value,'true')].AutoScalingGroupName" \
  --output text); do
  echo "Scaling down ASG: $asg"
  aws autoscaling update-auto-scaling-group \
    --auto-scaling-group-name "${asg}" \
    --min-size 0 \
    --desired-capacity 0
done

echo "=== Phase 4: Remove Cluster Autoscaler deployment ==="
kubectl delete deployment cluster-autoscaler -n kube-system

echo "Migration complete. Monitor karpenter logs for 30 minutes."
```

### Validating Karpenter After Migration

```bash
#!/bin/bash
# validate-karpenter.sh

echo "=== NodePool Status ==="
kubectl get nodepools -o wide

echo ""
echo "=== NodeClaim Status ==="
kubectl get nodeclaims -o wide

echo ""
echo "=== Karpenter-Managed Nodes ==="
kubectl get nodes -l karpenter.sh/nodepool -o wide

echo ""
echo "=== Karpenter Controller Logs (last 100 lines) ==="
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter \
  --tail=100 --since=10m

echo ""
echo "=== Pending Pods ==="
kubectl get pods --all-namespaces --field-selector=status.phase=Pending

echo ""
echo "=== Disruption Events ==="
kubectl get events --all-namespaces --field-selector=reason=Disrupting \
  --sort-by='.lastTimestamp' | tail -20
```

## Operational Runbook

### Troubleshooting Common Issues

```bash
# Node stuck in pending / NodeClaim not progressing
# Replace CLAIM_NAME with the actual nodeclaim name from: kubectl get nodeclaims
CLAIM_NAME=$(kubectl get nodeclaims -l karpenter.sh/nodepool=general-purpose -o name | head -1)
kubectl describe ${CLAIM_NAME}
# Look for: conditions[type=Launched], events section

# Check EC2NodeClass readiness
kubectl get ec2nodeclass general-purpose -o yaml
# Conditions should show: SubnetsReady, SecurityGroupsReady, AMIReady

# Karpenter cannot select an instance type
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter | \
  grep -E "(no instance types|insufficient capacity|InsufficientInstanceCapacity)"

# Force immediate consolidation evaluation
kubectl annotate nodeclaims -l karpenter.sh/nodepool=general-purpose \
  karpenter.sh/voluntaryDisruptionClass=consolidation --overwrite

# Prevent a specific node from being disrupted
kubectl annotate node ip-10-0-1-50.ec2.internal \
  karpenter.sh/do-not-disrupt=true

# Check NodePool limits
kubectl get nodepool general-purpose -o jsonpath='{.status}'
```

## Conclusion

Karpenter delivers measurable improvements over Cluster Autoscaler in provisioning speed, cost efficiency through bin-packing and spot diversification, and operational simplicity through the `NodePool`/`EC2NodeClass` abstraction. Production deployments benefit from:

- Separating NodePools by workload class (general, batch, GPU) with distinct disruption budgets
- Enabling `spotToSpotConsolidation` to continually right-size spot capacity
- Configuring the SQS interruption queue for proactive spot replacement
- Setting `expireAfter` on NodePools to enforce rolling AMI updates through drift detection
- Implementing `disruption.budgets` with schedule-based protection windows during business hours
- Monitoring `karpenter_nodepool_usage_percent` to stay ahead of limit exhaustion
