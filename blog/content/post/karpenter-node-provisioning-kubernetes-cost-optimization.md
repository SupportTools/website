---
title: "Karpenter Node Provisioning: Dynamic Kubernetes Node Management and Cost Optimization"
date: 2030-06-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "AWS", "Cost Optimization", "Autoscaling", "EKS"]
categories:
- Kubernetes
- Cost Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Karpenter guide: NodePool and EC2NodeClass configuration, spot instance integration, consolidation policies, bin-packing optimization, and replacing Cluster Autoscaler in production."
more_link: "yes"
url: "/karpenter-node-provisioning-kubernetes-cost-optimization/"
---

Karpenter represents a fundamental rethinking of Kubernetes node autoscaling. Where the Cluster Autoscaler operates on predefined node groups and scales them up or down, Karpenter provisions exactly the instance type needed for each pending workload — in seconds rather than minutes. This guide covers production Karpenter deployment on EKS, NodePool and EC2NodeClass configuration, spot instance strategies, consolidation tuning, and a production-tested migration path from Cluster Autoscaler.

<!--more-->

## Karpenter vs. Cluster Autoscaler

The fundamental difference between Karpenter and Cluster Autoscaler:

| Capability | Cluster Autoscaler | Karpenter |
|---|---|---|
| Instance type selection | Fixed per node group | Dynamic, any type from pool |
| Provisioning time | 4-6 minutes (ASG warm-up) | 60-90 seconds |
| Bin-packing | Limited (node group based) | First-class, automatic |
| Spot handling | Manual node groups per type | Automatic fallback |
| Consolidation | No | Yes, with configurable policy |
| Cost awareness | Minimal | Price-optimized by default |

Karpenter directly calls the EC2 API to launch instances, bypassing Auto Scaling Groups entirely. This enables it to select from all instance types simultaneously rather than being constrained to a predefined group.

## Installation

### Prerequisites

Karpenter requires:
- EKS cluster with OIDC provider configured
- IAM roles with specific permissions
- The `karpenter` namespace
- Interruption queue for Spot handling

```bash
# Set environment variables
export CLUSTER_NAME="production-eks"
export AWS_DEFAULT_REGION="us-east-1"
export AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
export KARPENTER_VERSION="v0.37.0"

# Create the Karpenter controller IAM role
cat <<EOF > karpenter-controller-policy.json
{
  "Statement": [
    {
      "Action": [
        "ssm:GetParameter",
        "ec2:DescribeImages",
        "ec2:RunInstances",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeInstances",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeAvailabilityZones",
        "ec2:DeleteLaunchTemplate",
        "ec2:CreateTags",
        "ec2:CreateLaunchTemplate",
        "ec2:CreateFleet",
        "ec2:DescribeSpotPriceHistory",
        "pricing:GetProducts"
      ],
      "Effect": "Allow",
      "Resource": "*",
      "Sid": "Karpenter"
    },
    {
      "Action": "ec2:TerminateInstances",
      "Condition": {
        "StringLike": {
          "ec2:ResourceTag/karpenter.sh/nodepool": "*"
        }
      },
      "Effect": "Allow",
      "Resource": "*",
      "Sid": "ConditionalEC2Termination"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${CLUSTER_NAME}",
      "Sid": "PassNodeIAMRole"
    },
    {
      "Effect": "Allow",
      "Action": "eks:DescribeCluster",
      "Resource": "arn:aws:eks:${AWS_DEFAULT_REGION}:${AWS_ACCOUNT_ID}:cluster/${CLUSTER_NAME}",
      "Sid": "EKSClusterEndpointLookup"
    },
    {
      "Sid": "AllowScopedInstanceProfileCreationActions",
      "Effect": "Allow",
      "Resource": "*",
      "Action": [
        "iam:CreateInstanceProfile"
      ]
    },
    {
      "Sid": "AllowScopedInstanceProfileTagActions",
      "Effect": "Allow",
      "Resource": "*",
      "Action": [
        "iam:TagInstanceProfile"
      ]
    },
    {
      "Sid": "AllowScopedInstanceProfileActions",
      "Effect": "Allow",
      "Resource": "*",
      "Action": [
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:DeleteInstanceProfile"
      ]
    },
    {
      "Sid": "AllowInstanceProfileReadActions",
      "Effect": "Allow",
      "Resource": "*",
      "Action": "iam:GetInstanceProfile"
    }
  ],
  "Version": "2012-10-17"
}
EOF

# Create SQS queue for interruption handling
aws sqs create-queue \
  --queue-name "Karpenter-${CLUSTER_NAME}" \
  --attributes '{
    "MessageRetentionPeriod": "300",
    "SqsManagedSseEnabled": "true"
  }'

# Install Karpenter via Helm
helm registry logout public.ecr.aws || true
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "${KARPENTER_VERSION}" \
  --namespace karpenter \
  --create-namespace \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.interruptionQueue=Karpenter-${CLUSTER_NAME}" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait
```

## EC2NodeClass Configuration

`EC2NodeClass` defines the AWS-specific configuration for nodes Karpenter provisions. This includes AMIs, subnets, security groups, and instance profiles.

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # AMI selection: bottlerocket for enhanced security
  amiFamily: Bottlerocket

  # Use tags to discover subnets (matches any subnet tagged with cluster name)
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-eks"
        # Alternatively, use specific subnet IDs
        # kubernetes.io/role/internal-elb: "1"

  # Security groups by tag
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-eks"

  # IAM instance profile for nodes
  role: "KarpenterNodeRole-production-eks"

  # EBS volume configuration
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 50Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        # KMS key for EBS encryption
        kmsKeyID: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
        deleteOnTermination: true

  # Instance metadata service configuration
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1  # Restrict to pod level, not containers
    httpTokens: required  # IMDSv2 required

  # User data for Bottlerocket (TOML format)
  userData: |
    [settings.kubernetes]
    cluster-name = "production-eks"
    api-server = "https://CLUSTER_ENDPOINT"

    [settings.kubernetes.node-labels]
    "node.kubernetes.io/provisioner" = "karpenter"

    [settings.host-containers.admin]
    enabled = false

  # Tags applied to all provisioned instances
  tags:
    Environment: production
    Team: platform
    ManagedBy: karpenter
    Cluster: production-eks
```

### GPU-Specific NodeClass

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-nodes
spec:
  amiFamily: AL2

  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-eks"
        node-type: gpu

  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-eks"

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

  # NVIDIA driver installation via user data
  userData: |
    #!/bin/bash
    set -ex

    # Install NVIDIA drivers and container toolkit
    amazon-linux-extras install -y epel
    yum install -y kernel-devel-$(uname -r)

    # Install NVIDIA drivers
    distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
      gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    yum install -y nvidia-container-toolkit

    # Configure containerd for GPU
    nvidia-ctk runtime configure --runtime=containerd
    systemctl restart containerd
```

## NodePool Configuration

`NodePool` defines what workloads Karpenter can provision nodes for and which constraints apply.

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
        node-pool: general-purpose
        billing/team: platform

      annotations:
        # Disable cluster-autoscaler on these nodes
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"

    spec:
      # Reference to EC2NodeClass
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      # Taints applied to all nodes in this pool
      taints: []

      # Node requirements (hard constraints)
      requirements:
        # Instance family constraints
        - key: "karpenter.k8s.aws/instance-family"
          operator: In
          values:
            - m7i       # Intel 7th gen
            - m7a       # AMD 7th gen
            - m6i       # Intel 6th gen
            - m6a       # AMD 6th gen
            - c7i       # Compute optimized Intel
            - c7a       # Compute optimized AMD
            - c6i
            - c6a

        # Architecture
        - key: "kubernetes.io/arch"
          operator: In
          values: ["amd64"]

        # Capacity type: prefer spot, fall back to on-demand
        - key: "karpenter.sh/capacity-type"
          operator: In
          values:
            - spot
            - on-demand

        # CPU range: 2-32 vCPUs
        - key: "karpenter.k8s.aws/instance-cpu"
          operator: Gt
          values: ["1"]
        - key: "karpenter.k8s.aws/instance-cpu"
          operator: Lt
          values: ["33"]

        # Memory range: 4-128 GiB
        - key: "karpenter.k8s.aws/instance-memory"
          operator: Gt
          values: ["3071"]
        - key: "karpenter.k8s.aws/instance-memory"
          operator: Lt
          values: ["131073"]

        # Availability zones
        - key: "topology.kubernetes.io/zone"
          operator: In
          values:
            - us-east-1a
            - us-east-1b
            - us-east-1c

      # Startup taints that are removed when node is ready
      startupTaints:
        - key: "node.cloudprovider.kubernetes.io/uninitialized"
          effect: NoSchedule

      # Expiry: rotate nodes after 720h (30 days) to apply security patches
      expireAfter: 720h

      # Termination grace period
      terminationGracePeriod: 48h

  # Disruption configuration (consolidation and scale-down)
  disruption:
    # Consolidate empty or underutilized nodes
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s

    # Budget: at most 10% of nodes disrupted simultaneously
    budgets:
      - nodes: "10%"
      # No disruptions during business hours
      - nodes: "0"
        schedule: "0 9 * * mon-fri"    # 9 AM weekdays
        duration: 9h                    # For 9 hours
        timezone: "America/New_York"

  # Node count limits
  limits:
    cpu: "1000"
    memory: "4000Gi"
```

### Spot-Only NodePool for Batch Workloads

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: batch-spot
spec:
  template:
    metadata:
      labels:
        node-pool: batch-spot
        workload-type: batch

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      # Taint to prevent non-batch workloads
      taints:
        - key: workload-type
          value: batch
          effect: NoSchedule

      requirements:
        # Large selection of instance families for better spot availability
        - key: "karpenter.k8s.aws/instance-family"
          operator: In
          values:
            - m7i
            - m7a
            - m6i
            - m6a
            - m5
            - m5a
            - m5n
            - c7i
            - c7a
            - c6i
            - c6a
            - c5
            - c5a
            - r7i
            - r6i
            - r5

        # Only spot instances
        - key: "karpenter.sh/capacity-type"
          operator: In
          values:
            - spot

        - key: "kubernetes.io/arch"
          operator: In
          values: ["amd64"]

      expireAfter: 24h

  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m

  limits:
    cpu: "500"
    memory: "2000Gi"
```

### Memory-Optimized NodePool for Databases

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: memory-optimized
spec:
  template:
    metadata:
      labels:
        node-pool: memory-optimized
        workload-type: database

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      taints:
        - key: workload-type
          value: database
          effect: NoSchedule

      requirements:
        - key: "karpenter.k8s.aws/instance-family"
          operator: In
          values:
            - r7i
            - r7a
            - r6i
            - r6a
            - r5
            - x2idn
            - x2iedn

        # On-demand only for stateful workloads
        - key: "karpenter.sh/capacity-type"
          operator: In
          values:
            - on-demand

        - key: "karpenter.k8s.aws/instance-memory"
          operator: Gt
          values: ["32767"]  # 32+ GiB

      expireAfter: Never  # Do not expire database nodes

  disruption:
    # Only disrupt when empty (never consolidate database nodes)
    consolidationPolicy: WhenEmpty
    consolidateAfter: 1h
    budgets:
      - nodes: "1"  # At most 1 node at a time
```

## Workload Configuration for Karpenter

### Targeting Specific NodePools

Use `nodeSelector` or `nodeAffinity` to target specific NodePools:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      # Target the general-purpose NodePool
      nodeSelector:
        node-pool: general-purpose

      # Tolerate spot interruptions (Karpenter drains gracefully)
      tolerations:
        - key: "karpenter.sh/capacity-type"
          value: "spot"
          effect: NoSchedule

      # Prefer spreading across availability zones
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-server

      # Ensure graceful termination for spot interruptions
      terminationGracePeriodSeconds: 60

      containers:
        - name: api-server
          image: api-server:v1.5.2
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2000m"
              memory: "2Gi"
```

### Batch Job Configuration

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing-job
spec:
  parallelism: 20
  completions: 100
  template:
    spec:
      # Target batch-spot NodePool
      nodeSelector:
        node-pool: batch-spot
        workload-type: batch

      tolerations:
        - key: workload-type
          value: batch
          effect: NoSchedule

      # Restart on spot interruption
      restartPolicy: OnFailure

      containers:
        - name: processor
          image: data-processor:v2.1.0
          resources:
            requests:
              cpu: "3500m"
              memory: "7Gi"
            limits:
              cpu: "4000m"
              memory: "8Gi"
```

## Consolidation Configuration

Consolidation is Karpenter's ability to bin-pack workloads and terminate underutilized nodes. Tuning consolidation settings is critical for cost efficiency.

### Understanding Consolidation

Karpenter evaluates consolidation using a simulation: it asks "if this node is removed, can all its pods fit on existing or newly provisioned nodes at lower cost?" If yes, it cordons and drains the node.

```yaml
disruption:
  # WhenUnderutilized: consolidate when node utilization is low
  # WhenEmpty: only consolidate when all pods are gone
  consolidationPolicy: WhenUnderutilized

  # How long to wait before attempting consolidation after the node becomes eligible
  consolidateAfter: 30s

  # Budget controls how many nodes can be disrupted simultaneously
  budgets:
    # Default: at most 10% of nodes
    - nodes: "10%"

    # During business hours peak: no disruptions
    - nodes: "0"
      schedule: "0 8 * * mon-fri"    # 8 AM Monday-Friday
      duration: 10h                   # 10 hours

    # Weekend maintenance window
    - nodes: "20%"
      schedule: "0 2 * * sat"        # 2 AM Saturday
      duration: 4h
```

### Preventing Consolidation for Specific Workloads

```yaml
# Annotation to prevent pod eviction during consolidation
metadata:
  annotations:
    karpenter.sh/do-not-disrupt: "true"
```

Or prevent a node from being consolidated:

```yaml
# Node annotation (set by an operator or webhook)
kubectl annotate node <node-name> karpenter.sh/do-not-disrupt=true
```

## Migration from Cluster Autoscaler

### Phase 1: Deploy Karpenter in Parallel

Run Karpenter alongside Cluster Autoscaler initially. Karpenter will handle new NodePools while CA continues to manage existing node groups.

```bash
# Disable scale-down in Cluster Autoscaler temporarily
kubectl -n kube-system patch deployment cluster-autoscaler \
  -p '{"spec":{"template":{"spec":{"containers":[{"name":"cluster-autoscaler","command":["./cluster-autoscaler","--cloud-provider=aws","--skip-nodes-with-system-pods=false","--scale-down-enabled=false"]}]}}}}'
```

### Phase 2: Migrate Workloads

Move workloads from CA-managed node groups to Karpenter-managed NodePools by adding node selectors:

```yaml
# Before: workload on CA node group
spec:
  nodeSelector:
    node-group: general-purpose-v2

# After: workload on Karpenter NodePool
spec:
  nodeSelector:
    node-pool: general-purpose
```

### Phase 3: Drain CA Node Groups

Once workloads are moved to Karpenter nodes, cordon and drain CA node groups:

```bash
# Get CA-managed nodes
CA_NODES=$(kubectl get nodes \
  -l "eks.amazonaws.com/nodegroup=general-purpose-v2" \
  -o jsonpath='{.items[*].metadata.name}')

for node in ${CA_NODES}; do
  kubectl cordon "${node}"
done

# Drain each node
for node in ${CA_NODES}; do
  kubectl drain "${node}" \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --force \
    --grace-period=300
done

# Scale CA node group to 0
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name "general-purpose-v2" \
  --min-size 0 \
  --desired-capacity 0
```

### Phase 4: Remove Cluster Autoscaler

```bash
# Remove CA deployment
kubectl delete deployment cluster-autoscaler -n kube-system

# Remove CA IAM role bindings if applicable
kubectl delete clusterrolebinding cluster-autoscaler
kubectl delete clusterrole cluster-autoscaler
kubectl delete serviceaccount cluster-autoscaler -n kube-system
```

## Monitoring Karpenter

### Key Metrics

```yaml
# Prometheus scrape config for Karpenter
- job_name: karpenter
  static_configs:
    - targets: ["karpenter.karpenter.svc.cluster.local:8080"]
  relabel_configs:
    - source_labels: [__address__]
      target_label: instance
```

Important metrics to monitor:

```promql
# Node provisioning rate
rate(karpenter_provisioner_scheduling_simulation_duration_seconds_count[5m])

# Nodes launched
increase(karpenter_nodes_created_total[1h])

# Nodes terminated (including consolidation)
increase(karpenter_nodes_terminated_total[1h])

# Pending pod scheduling time
histogram_quantile(0.95, rate(karpenter_provisioner_scheduling_duration_seconds_bucket[5m]))

# Interruption events received
increase(karpenter_interruption_received_messages_total[1h])

# Spot interruptions handled
increase(karpenter_interruption_actions_performed_total{action="CordonAndDrain"}[1h])
```

### Alerting Rules

```yaml
groups:
  - name: karpenter_alerts
    rules:
      - alert: KarpenterProvisioningErrors
        expr: |
          increase(karpenter_nodes_created_total{result="failed"}[10m]) > 3
        for: 5m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Karpenter node provisioning failures"
          description: |
            Karpenter has failed to provision {{ $value }} nodes in the last 10 minutes.
            Check controller logs for API errors or capacity issues.

      - alert: KarpenterHighPendingPods
        expr: |
          kube_pod_status_phase{phase="Pending"} > 20
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Large number of pending pods"
          description: |
            {{ $value }} pods are pending. Karpenter may be unable to provision
            capacity (check instance type availability or NodePool limits).

      - alert: KarpenterNodePoolLimitApproaching
        expr: |
          (
            karpenter_nodepool_usage{resource="cpu"}
            /
            karpenter_nodepool_limit{resource="cpu"}
          ) > 0.85
        for: 15m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "NodePool CPU limit at {{ $value | humanizePercentage }}"
          description: |
            NodePool {{ $labels.nodepool }} CPU usage is approaching its configured limit.
            Increase the limit or optimize workload resource requests.
```

## Cost Analysis

### Calculating Savings

Spot instances typically provide 60-90% cost savings. Track effective savings:

```bash
# Query EC2 pricing for running Karpenter nodes
aws ec2 describe-instances \
  --filters "Name=tag:managed-by,Values=karpenter" \
  --query 'Reservations[*].Instances[*].[InstanceId,InstanceType,InstanceLifecycle,LaunchTime]' \
  --output table

# Get current spot prices
aws ec2 describe-spot-price-history \
  --instance-types m7i.large m7a.large c7i.large \
  --product-descriptions "Linux/UNIX" \
  --max-results 10 \
  --query 'SpotPriceHistory[*].[InstanceType,SpotPrice,Timestamp]' \
  --output table
```

### Cost Allocation Tags

Tag nodes provisioned by Karpenter with team and environment information for accurate cost attribution:

```yaml
# In EC2NodeClass
spec:
  tags:
    Environment: production
    Team: "{{ .Labels['billing/team'] }}"
    NodePool: "{{ .Labels['karpenter.sh/nodepool'] }}"
    CapacityType: "{{ .Labels['karpenter.sh/capacity-type'] }}"
```

## Summary

Karpenter's approach to node provisioning provides significant advantages over Cluster Autoscaler: faster provisioning, better bin-packing, automatic spot instance diversification, and consolidation-driven cost reduction. The key production considerations are:

- Use large instance family pools in NodePools to maximize spot availability
- Configure disruption budgets to prevent simultaneous consolidation of too many nodes
- Set `expireAfter` to rotate nodes regularly for security patching
- Use `karpenter.sh/do-not-disrupt` annotations for stateful workloads that cannot be disrupted
- Monitor NodePool limits to prevent hitting capacity ceilings during traffic spikes
- Run Karpenter in parallel with Cluster Autoscaler during migration, then remove CA after full workload transition

Production clusters typically see 30-50% cost reduction after migrating from CA to Karpenter, primarily from better instance type selection and consolidation efficiency.
