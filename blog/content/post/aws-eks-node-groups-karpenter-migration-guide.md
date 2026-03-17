---
title: "AWS EKS: Migrating from Managed Node Groups to Karpenter"
date: 2028-10-28T00:00:00-05:00
draft: false
tags: ["AWS", "EKS", "Karpenter", "Kubernetes", "Autoscaling"]
categories:
- AWS
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete migration guide from EKS Managed Node Groups to Karpenter including IRSA setup, NodePool and EC2NodeClass configuration, spot instance handling, consolidation, multi-arch support, and observability."
more_link: "yes"
url: "/aws-eks-node-groups-karpenter-migration-guide/"
---

Karpenter is AWS's next-generation node provisioner for Kubernetes, replacing the Cluster Autoscaler and Managed Node Groups for dynamic workloads. It provisions nodes in under 60 seconds, understands Kubernetes scheduling constraints natively, and consolidates underutilized nodes automatically. This guide walks through a production migration from Managed Node Groups to Karpenter, covering IRSA, NodePool and EC2NodeClass configuration, spot instance interruption handling, and the rollback procedure if things go wrong.

<!--more-->

# Migrating EKS from Managed Node Groups to Karpenter

## Prerequisites

- EKS cluster running Kubernetes 1.27+
- AWS CLI 2.x with administrator permissions
- eksctl or Terraform for IAM resources
- Helm 3.x

```bash
# Verify cluster
aws eks describe-cluster --name my-cluster --region us-east-1 \
  --query 'cluster.{Version:version,Status:status,Endpoint:endpoint}'

# Check current node groups
aws eks list-nodegroups --cluster-name my-cluster --region us-east-1
```

## Setting up Karpenter IAM and IRSA

Karpenter needs permission to manage EC2 instances, read SSM parameters for AMI IDs, and manage IAM pass-role operations.

### Create IAM roles

```bash
export CLUSTER_NAME="my-cluster"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Tag the cluster for Karpenter discovery
aws ec2 describe-vpcs --filters "Name=tag:kubernetes.io/cluster/${CLUSTER_NAME},Values=owned" \
  --query 'Vpcs[0].VpcId' --output text

# Create the Karpenter controller IAM policy
cat > /tmp/karpenter-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:CreateLaunchTemplate",
        "ec2:CreateFleet",
        "ec2:RunInstances",
        "ec2:CreateTags",
        "iam:PassRole",
        "ec2:TerminateInstances",
        "ec2:DeleteLaunchTemplate",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeInstances",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeImages",
        "ec2:DescribeSpotPriceHistory",
        "ssm:GetParameter",
        "pricing:GetProducts",
        "ec2:GetInstanceTypesFromInstanceRequirements",
        "sqs:DeleteMessage",
        "sqs:GetQueueUrl",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:DeleteMessage",
        "sqs:GetQueueUrl",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage"
      ],
      "Resource": "arn:aws:sqs:${AWS_DEFAULT_REGION}:${AWS_ACCOUNT_ID}:Karpenter-${CLUSTER_NAME}"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name KarpenterControllerPolicy-${CLUSTER_NAME} \
  --policy-document file:///tmp/karpenter-policy.json
```

### Create IRSA for Karpenter controller

```bash
# Create OIDC provider if not already done
eksctl utils associate-iam-oidc-provider \
  --cluster ${CLUSTER_NAME} \
  --region ${AWS_DEFAULT_REGION} \
  --approve

# Create service account with IRSA
eksctl create iamserviceaccount \
  --name karpenter \
  --namespace karpenter \
  --cluster ${CLUSTER_NAME} \
  --region ${AWS_DEFAULT_REGION} \
  --attach-policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME} \
  --approve \
  --override-existing-serviceaccounts
```

### Create the Karpenter node instance profile

Nodes launched by Karpenter need an IAM instance profile. This replaces the instance profile used by the managed node group.

```bash
# Create node role
cat > /tmp/karpenter-node-trust.json <<EOF
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
EOF

aws iam create-role \
  --role-name KarpenterNodeRole-${CLUSTER_NAME} \
  --assume-role-policy-document file:///tmp/karpenter-node-trust.json

# Attach required policies
for POLICY in \
  AmazonEKSWorkerNodePolicy \
  AmazonEKS_CNI_Policy \
  AmazonEC2ContainerRegistryReadOnly \
  AmazonSSMManagedInstanceCore; do
  aws iam attach-role-policy \
    --role-name KarpenterNodeRole-${CLUSTER_NAME} \
    --policy-arn arn:aws:iam::aws:policy/${POLICY}
done

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name KarpenterNodeInstanceProfile-${CLUSTER_NAME}

aws iam add-role-to-instance-profile \
  --instance-profile-name KarpenterNodeInstanceProfile-${CLUSTER_NAME} \
  --role-name KarpenterNodeRole-${CLUSTER_NAME}
```

### Configure aws-auth for Karpenter nodes

```bash
# Add the Karpenter node role to aws-auth
eksctl create iamidentitymapping \
  --cluster ${CLUSTER_NAME} \
  --region ${AWS_DEFAULT_REGION} \
  --arn arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${CLUSTER_NAME} \
  --username system:node:{{EC2PrivateDNSName}} \
  --groups system:bootstrappers system:nodes
```

### SQS interruption queue for spot handling

```bash
# Create SQS queue for EC2 interruption notices
aws sqs create-queue \
  --queue-name "Karpenter-${CLUSTER_NAME}" \
  --attributes '{"MessageRetentionPeriod":"300"}'

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.${AWS_DEFAULT_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/Karpenter-${CLUSTER_NAME} \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

# Create EventBridge rules to send EC2 events to the queue
cat > /tmp/eb-rule-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": ["events.amazonaws.com", "sqs.amazonaws.com"]
      },
      "Action": "sqs:SendMessage",
      "Resource": "${QUEUE_ARN}"
    }
  ]
}
EOF

aws sqs set-queue-attributes \
  --queue-url https://sqs.${AWS_DEFAULT_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/Karpenter-${CLUSTER_NAME} \
  --attributes "Policy=$(cat /tmp/eb-rule-policy.json)"

# EventBridge rules for spot interruption, health events, rebalance recommendations
for EVENT_RULE in \
  '{"source":["aws.ec2"],"detail-type":["EC2 Spot Instance Interruption Warning"]}' \
  '{"source":["aws.health"],"detail-type":["AWS Health Event"]}' \
  '{"source":["aws.ec2"],"detail-type":["EC2 Instance Rebalance Recommendation"]}' \
  '{"source":["aws.ec2"],"detail-type":["EC2 Instance State-change Notification"]}'; do
  RULE_NAME="Karpenter-${CLUSTER_NAME}-$(echo $EVENT_RULE | md5sum | cut -c1-8)"
  aws events put-rule \
    --name "${RULE_NAME}" \
    --event-pattern "${EVENT_RULE}" \
    --state ENABLED
  aws events put-targets \
    --rule "${RULE_NAME}" \
    --targets "Id=1,Arn=${QUEUE_ARN}"
done
```

## Installing Karpenter

```bash
export KARPENTER_VERSION="1.0.1"

# Tag subnets and security groups for Karpenter discovery
# Karpenter uses these tags to find where to launch nodes
SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters "Name=tag:kubernetes.io/cluster/${CLUSTER_NAME},Values=owned" \
  --query 'Subnets[*].SubnetId' --output text)

for SUBNET_ID in $SUBNET_IDS; do
  aws ec2 create-tags \
    --resources $SUBNET_ID \
    --tags "Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}"
done

# Tag the cluster security group
CLUSTER_SG=$(aws eks describe-cluster \
  --name ${CLUSTER_NAME} \
  --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
aws ec2 create-tags \
  --resources $CLUSTER_SG \
  --tags "Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}"

# Install Karpenter
helm repo add karpenter https://charts.karpenter.sh/
helm repo update

helm upgrade --install karpenter karpenter/karpenter \
  --namespace karpenter \
  --create-namespace \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.clusterEndpoint=$(aws eks describe-cluster --name ${CLUSTER_NAME} --query 'cluster.endpoint' --output text)" \
  --set "settings.aws.defaultInstanceProfile=KarpenterNodeInstanceProfile-${CLUSTER_NAME}" \
  --set "settings.aws.interruptionQueueName=Karpenter-${CLUSTER_NAME}" \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::${AWS_ACCOUNT_ID}:role/eksctl-${CLUSTER_NAME}-addon-iamserviceaccount-karpenter" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --version ${KARPENTER_VERSION}
```

## EC2NodeClass Configuration

`EC2NodeClass` defines the AMI, instance profile, subnets, security groups, and user data for nodes.

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # Use the EKS-optimized AMI, automatically updated
  amiSelectorTerms:
  - alias: al2023@latest    # Amazon Linux 2023

  # Instance profile for nodes
  role: KarpenterNodeRole-my-cluster

  # Subnet discovery using tags
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: my-cluster
      kubernetes.io/role/internal-elb: "1"  # Only private subnets

  # Security group discovery
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: my-cluster

  # Block device mappings
  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 50Gi
      volumeType: gp3
      iops: 3000
      throughput: 125
      encrypted: true
      kmsKeyID: arn:aws:kms:us-east-1:123456789012:key/mrk-xxxx

  # User data for custom node configuration
  userData: |
    #!/bin/bash
    cat >> /etc/kubernetes/kubelet/kubelet-config.json <<EOF
    {
      "maxPods": 110,
      "systemReserved": {
        "cpu": "100m",
        "memory": "256Mi",
        "ephemeral-storage": "1Gi"
      },
      "kubeReserved": {
        "cpu": "100m",
        "memory": "256Mi",
        "ephemeral-storage": "1Gi"
      }
    }
    EOF

  # Tags applied to all launched EC2 instances
  tags:
    Environment: production
    ManagedBy: karpenter
    Team: platform
---
# GPU node class for ML workloads
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu
spec:
  amiSelectorTerms:
  - alias: al2023@latest
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
      volumeSize: 200Gi
      volumeType: gp3
      encrypted: true
  tags:
    Environment: production
    NodeType: gpu
```

## NodePool Configuration

`NodePool` is the Karpenter CRD that replaces Cluster Autoscaler node groups. It defines which instance types, architectures, and zones are acceptable.

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    metadata:
      labels:
        node.kubernetes.io/pool: default
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      requirements:
      # Allow any generation of x86-64 instances
      - key: "kubernetes.io/arch"
        operator: In
        values: ["amd64"]

      # Allow on-demand and spot instances
      - key: "karpenter.sh/capacity-type"
        operator: In
        values: ["spot", "on-demand"]

      # Exclude previous generation and T-series instances
      - key: "karpenter.k8s.aws/instance-generation"
        operator: Gt
        values: ["3"]
      - key: "karpenter.k8s.aws/instance-family"
        operator: NotIn
        values: ["t2", "t3", "t3a"]

      # Minimum instance size
      - key: "karpenter.k8s.aws/instance-cpu"
        operator: Gt
        values: ["1"]
      - key: "karpenter.k8s.aws/instance-memory"
        operator: Gt
        values: ["3071"]  # > 3 GB

      # Allow multiple AZs for resilience
      - key: "topology.kubernetes.io/zone"
        operator: In
        values: ["us-east-1a", "us-east-1b", "us-east-1c"]

      # Startup taints — removed after node bootstraps
      startupTaints:
      - key: node.cloudprovider.kubernetes.io/uninitialized
        effect: NoSchedule

      # Termination grace period for pods
      terminationGracePeriod: 48h

  # Consolidation — Karpenter's bin-packing
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
    budgets:
    # Limit disruptions during business hours
    - schedule: "0 9 * * 1-5"    # Mon-Fri 9am
      duration: 8h
      nodes: "10%"               # Only disrupt 10% of nodes at a time
    # Allow faster consolidation outside business hours
    - nodes: "20%"

  # Limits prevent runaway scaling
  limits:
    cpu: 1000        # Maximum 1000 vCPU across all Karpenter-managed nodes
    memory: 4000Gi   # Maximum 4 TB of memory
---
# High-memory NodePool for data processing
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: memory-intensive
spec:
  template:
    metadata:
      labels:
        node.kubernetes.io/pool: memory-intensive
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
      - key: "kubernetes.io/arch"
        operator: In
        values: ["amd64"]
      - key: "karpenter.sh/capacity-type"
        operator: In
        values: ["on-demand"]  # No spot for memory-intensive
      - key: "karpenter.k8s.aws/instance-family"
        operator: In
        values: ["r6i", "r6a", "r7i", "r7a"]
      taints:
      - key: workload-type
        value: memory-intensive
        effect: NoSchedule
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 10m
  limits:
    cpu: 500
    memory: 8000Gi
---
# ARM64 NodePool for cost optimization
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: arm64
spec:
  template:
    metadata:
      labels:
        node.kubernetes.io/pool: arm64
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
      - key: "kubernetes.io/arch"
        operator: In
        values: ["arm64"]
      - key: "karpenter.sh/capacity-type"
        operator: In
        values: ["spot", "on-demand"]
      - key: "karpenter.k8s.aws/instance-family"
        operator: In
        values: ["m7g", "m6g", "c7g", "c6g", "r7g", "r6g"]
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
  limits:
    cpu: 500
    memory: 2000Gi
```

## Migrating Workloads from Managed Node Groups

The migration is done by gradually draining managed node groups while Karpenter provisions replacements.

### Step 1: Deploy Karpenter NodePool alongside existing node groups

```bash
# Verify Karpenter is running and can launch nodes
kubectl get nodepools
kubectl get ec2nodeclasses

# Test by creating a small deployment that Karpenter will schedule
kubectl run karpenter-test \
  --image=public.ecr.aws/eks-distro/kubernetes/pause:3.7 \
  --requests='cpu=1,memory=1Gi'

# Watch for new Karpenter-managed node
kubectl get nodes -w -l node.kubernetes.io/pool=default
```

### Step 2: Cordon managed node group nodes gradually

```bash
#!/bin/bash
# migrate-to-karpenter.sh

CLUSTER_NAME="${1:?cluster name required}"
NODEGROUP_NAME="${2:?node group name required}"
BATCH_SIZE="${3:-3}"  # Drain this many nodes at a time

# Get nodes in the managed node group
NODES=$(kubectl get nodes \
  -l eks.amazonaws.com/nodegroup=${NODEGROUP_NAME} \
  --no-headers -o name | tr '\n' ' ')

TOTAL=$(echo $NODES | wc -w)
echo "Found ${TOTAL} nodes in node group ${NODEGROUP_NAME}"

# Process in batches
BATCH=()
for NODE in $NODES; do
  BATCH+=($NODE)
  if [ ${#BATCH[@]} -eq $BATCH_SIZE ]; then
    echo "Draining batch: ${BATCH[*]}"
    for N in "${BATCH[@]}"; do
      kubectl cordon $N
    done
    for N in "${BATCH[@]}"; do
      kubectl drain $N \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --grace-period=60 \
        --timeout=300s
    done
    BATCH=()
    # Wait for Karpenter to provision replacements
    sleep 30
    kubectl get nodes -l node.kubernetes.io/pool=default
  fi
done
```

### Step 3: Scale down managed node group

```bash
# After all workloads are on Karpenter nodes
aws eks update-nodegroup-config \
  --cluster-name ${CLUSTER_NAME} \
  --nodegroup-name ${NODEGROUP_NAME} \
  --scaling-config minSize=0,maxSize=0,desiredSize=0

# Verify no pods remain on old nodes
kubectl get pods --all-namespaces \
  -o wide | grep -E "(${NODEGROUP_NAME}|old-node)"
```

## Karpenter Metrics and Observability

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: karpenter
  namespace: karpenter
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: karpenter
  endpoints:
  - port: http-metrics
    interval: 30s
    path: /metrics
```

Key Karpenter metrics:

```
# Node provisioning latency
karpenter_nodes_total_provisioning_duration_seconds

# Node consolidation count
karpenter_disruption_actions_performed_total{action="consolidation"}

# Nodes launched by instance type
karpenter_provisioner_scheduling_instance_type_selected

# Pod scheduling errors
karpenter_scheduler_scheduling_queue_depth

# Interruption notices received
karpenter_interruption_received_messages_total
```

### Grafana alert rules

```yaml
groups:
- name: karpenter
  rules:
  - alert: KarpenterFailedToLaunchNode
    expr: |
      sum(increase(karpenter_nodes_total_launch_errors_total[5m])) > 0
    for: 5m
    labels:
      severity: critical
    annotations:
      summary: "Karpenter is failing to launch nodes"

  - alert: KarpenterHighSchedueueDepth
    expr: karpenter_scheduler_scheduling_queue_depth > 50
    for: 10m
    labels:
      severity: warning
    annotations:
      summary: "Karpenter scheduling queue is deep — {{ $value }} pending pods"
```

## Cost Comparison

Karpenter typically reduces EC2 costs by 30-70% compared to Managed Node Groups through:

1. **Spot instance diversity**: Karpenter can select from 50+ instance types matching your requirements, dramatically increasing spot availability.
2. **Bin-packing**: Consolidation removes underutilized nodes, reducing total node count.
3. **Right-sizing**: Karpenter provisions the exact instance size needed, rather than using fixed node group sizes.
4. **Rapid scale-down**: Consolidation runs continuously, terminating unnecessary nodes within minutes.

```bash
# Check current node utilization to estimate consolidation opportunity
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,\
CPU_REQ:.status.allocatable.cpu,\
MEM_REQ:.status.allocatable.memory,\
INSTANCE:.metadata.labels.node\\.kubernetes\\.io/instance-type

# Karpenter logs show consolidation decisions
kubectl logs -n karpenter \
  -l app.kubernetes.io/name=karpenter \
  --since=1h | grep -i consolidat
```

## Summary

Migrating from Managed Node Groups to Karpenter is a significant but highly rewarding infrastructure change:

- Set up IRSA with the correct EC2 and SQS permissions before installation.
- Create the SQS interruption queue and EventBridge rules to handle spot interruptions gracefully.
- Configure `EC2NodeClass` for AMI discovery, storage, and node IAM settings.
- Use `NodePool` requirements to specify acceptable instance families, architectures, and capacity types.
- Enable `consolidationPolicy: WhenEmptyOrUnderutilized` for automatic bin-packing with disruption budgets to protect business-hours workloads.
- Migrate node groups gradually — drain in batches, verify Karpenter provisions replacements, then scale the old node group to zero.
- Monitor `karpenter_nodes_total_launch_errors_total` and queue depth to detect issues early.
