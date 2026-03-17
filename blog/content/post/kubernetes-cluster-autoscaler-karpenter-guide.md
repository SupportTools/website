---
title: "Kubernetes Cluster Autoscaler vs Karpenter: Node Provisioning for Cost Efficiency"
date: 2028-04-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "Cluster Autoscaler", "Cost Optimization", "AWS"]
categories: ["Kubernetes", "Cloud Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive comparison of Kubernetes Cluster Autoscaler and Karpenter covering architecture differences, node provisioning speed, bin-packing efficiency, spot instance handling, and production migration strategies."
more_link: "yes"
url: "/kubernetes-cluster-autoscaler-karpenter-guide/"
---

Node provisioning is the silent multiplier of Kubernetes cost. A cluster that provisions the wrong node types, keeps nodes alive too long after workloads drain, or fails to consolidate underutilized nodes wastes 30–60% of compute spend in many real-world deployments. Kubernetes Cluster Autoscaler has been the standard solution for years, but Karpenter's fundamentally different architecture delivers faster provisioning, tighter bin-packing, and native spot instance handling that CAS cannot match. This guide explains when each tool is the right choice and how to migrate between them.

<!--more-->

# Kubernetes Cluster Autoscaler vs Karpenter

## Architecture Comparison

### Cluster Autoscaler (CAS)

CAS works against pre-defined Auto Scaling Groups (ASGs). It:

1. Detects pending pods that cannot be scheduled.
2. Simulates which ASG would schedule the pod if scaled up.
3. Increments the ASG's desired count by one node at a time.
4. Marks underutilized nodes for scale-down after a configurable idle timeout.

Constraints:
- Must pre-configure one ASG per node type/AZ combination.
- New node types require creating a new ASG and updating CAS configuration.
- Scale-down is conservative — nodes must be idle for 10+ minutes before removal.
- Cannot rebalance nodes across instance types without manual intervention.

### Karpenter

Karpenter bypasses ASGs entirely and calls EC2 APIs directly:

1. Watches for pending pods.
2. Aggregates pending pod requirements (CPU, memory, GPU, topology) into a provisioning request.
3. Selects the optimal instance type(s) from a flexible candidate list.
4. Calls `ec2:RunInstances` directly, with the node joining the cluster in 30–60 seconds.
5. Periodically consolidates underutilized nodes by moving workloads and terminating empty nodes.

This means Karpenter can provision **any EC2 instance type** (including those launched after your ASG was configured) without any cluster configuration changes.

## Installation

### Cluster Autoscaler

```bash
helm repo add autoscaler https://kubernetes.github.io/autoscaler

helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  --namespace kube-system \
  --set autoDiscovery.clusterName=my-cluster \
  --set awsRegion=us-east-1 \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/ClusterAutoscalerRole \
  --set extraArgs.balance-similar-node-groups=true \
  --set extraArgs.skip-nodes-with-system-pods=false \
  --set extraArgs.scale-down-utilization-threshold=0.5 \
  --set extraArgs.scale-down-delay-after-add=5m \
  --set extraArgs.scale-down-unneeded-time=10m
```

Required IAM policy for CAS:

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
        "autoscaling:SetDesiredCapacity",
        "autoscaling:TerminateInstanceInAutoScalingGroup",
        "autoscaling:UpdateAutoScalingGroup",
        "ec2:DescribeImages",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:GetInstanceTypesFromInstanceRequirements",
        "eks:DescribeNodegroup"
      ],
      "Resource": "*"
    }
  ]
}
```

### Karpenter

```bash
# Install with Helm
helm repo add karpenter https://charts.karpenter.sh/
helm repo update

helm install karpenter karpenter/karpenter \
  --namespace kube-system \
  --create-namespace \
  --set settings.clusterName=my-cluster \
  --set settings.clusterEndpoint=$(aws eks describe-cluster \
    --name my-cluster --query "cluster.endpoint" --output text) \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/KarpenterControllerRole \
  --version 0.37.0
```

Required IAM policy for Karpenter (significantly broader than CAS):

```json
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
        "ec2:TerminateInstances",
        "ec2:DeleteLaunchTemplate",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeInstances",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeImages",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeSpotPriceHistory",
        "iam:PassRole",
        "iam:CreateServiceLinkedRole",
        "pricing:GetProducts",
        "ssm:GetParameter"
      ],
      "Resource": "*"
    }
  ]
}
```

## Karpenter NodePool and EC2NodeClass

Karpenter uses two CRDs to define provisioning behavior.

### NodePool

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
        karpenter.sh/do-not-disrupt: "false"
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      requirements:
        # Allow any arch — let Karpenter pick the cheapest
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]

        # Instance families appropriate for general workloads
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m7i", "m7g", "m6i", "m6g", "m5", "r7i", "r7g"]

        # Allow both spot and on-demand; Karpenter picks cheapest
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]

        # Exclude bare metal and nano instances
        - key: karpenter.k8s.aws/instance-hypervisor
          operator: In
          values: ["nitro"]
        - key: karpenter.k8s.aws/instance-size
          operator: NotIn
          values: ["nano", "micro", "small"]

      # Cordon/drain taints applied before termination
      expireAfter: 720h   # Recycle nodes every 30 days

  # Limits prevent runaway scaling
  limits:
    cpu: 1000
    memory: 4000Gi

  # Disruption controls how Karpenter removes nodes
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
    budgets:
      - nodes: "10%"           # At most 10% of nodes disrupted simultaneously
      - schedule: "0 9-17 * * MON-FRI"
        nodes: "20%"           # Higher budget during business hours
```

### EC2NodeClass

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # AMI selection by alias (auto-selects latest EKS-optimized AMI)
  amiSelectorTerms:
    - alias: eks-node-1.32@latest

  # Instance profile for node IAM role
  instanceProfile: KarpenterNodeInstanceProfile

  # Subnet selection by tag
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: my-cluster

  # Security group selection by tag
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: my-cluster

  # Block device configuration
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        kmsKeyID: arn:aws:kms:us-east-1:123456789012:key/mrk-xxxxxxxx

  # User data for node bootstrap customization
  userData: |
    #!/bin/bash
    /etc/eks/bootstrap.sh my-cluster \
      --container-runtime containerd \
      --kubelet-extra-args '--max-pods=110'

  # Tags applied to all provisioned instances
  tags:
    Environment: production
    ManagedBy: karpenter
    CostCenter: platform-engineering
```

## Workload-Specific NodePools

Define separate NodePools for different workload classes:

### GPU NodePool

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-compute
spec:
  template:
    spec:
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: gpu
      taints:
        - key: nvidia.com/gpu
          effect: NoSchedule
      requirements:
        - key: karpenter.k8s.aws/instance-gpu-name
          operator: In
          values: ["a10g", "a100", "h100"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]  # No spot for GPU — interruptions too costly
      expireAfter: 168h
  limits:
    cpu: 200
    nvidia.com/gpu: 32
  disruption:
    consolidationPolicy: WhenEmpty   # Don't disrupt GPU jobs
    budgets:
      - nodes: "0"  # No disruption during training runs
        schedule: "0 22 * * *"  # Allow disruption only at 10 PM
        duration: 2h
```

### Spot-Optimized NodePool

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
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
      taints:
        - key: workload-type
          value: batch
          effect: NoSchedule
      requirements:
        # Many instance families → higher spot availability
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m7i", "m7g", "m6i", "m6g", "m5", "m4", "c7i", "c7g", "c6i", "c5"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["large", "xlarge", "2xlarge"]
      expireAfter: 168h
  limits:
    cpu: 2000
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 60s
```

## Pod Configuration for Karpenter

### Using NodeSelector and Tolerations

```yaml
# Batch job that runs on spot-batch nodes
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing
spec:
  template:
    spec:
      nodeSelector:
        node-type: spot-batch
      tolerations:
        - key: workload-type
          value: batch
          effect: NoSchedule
      containers:
        - name: processor
          image: myapp:latest
          resources:
            requests:
              cpu: "2"
              memory: "4Gi"
      restartPolicy: OnFailure
```

### Requesting Specific Instance Types

```yaml
# Force a specific instance type for predictable performance
spec:
  nodeSelector:
    node.kubernetes.io/instance-type: m7i.4xlarge
```

### Spread Across AZs

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: web-frontend
```

## Spot Instance Handling

### CAS Approach

CAS treats spot instances via a separate ASG. You must:
1. Create a mixed-instance ASG with spot override.
2. Configure CAS to use that ASG.
3. Handle spot interruption with the Node Termination Handler DaemonSet.

```yaml
# AWS Node Termination Handler (required for CAS + spot)
helm install aws-node-termination-handler \
  eks/aws-node-termination-handler \
  --namespace kube-system \
  --set enableSpotInterruptionDraining=true \
  --set enableScheduledEventDraining=true
```

### Karpenter Approach

Karpenter handles spot interruption natively:

1. Monitors EC2 Spot interruption notices (2-minute warning).
2. Cordons the node and begins pod eviction.
3. Provisions a replacement node in parallel.
4. The replacement node is ready within 60–90 seconds on average.

Enable Karpenter's interruption handling in Helm values:

```yaml
settings:
  interruptionQueue: my-cluster-karpenter   # SQS queue ARN for EC2 events
```

Create the SQS queue and EventBridge rules:

```bash
# Queue for Karpenter interruption events
aws sqs create-queue --queue-name my-cluster-karpenter

# EventBridge rules to forward spot interruption notices
aws events put-rule \
  --name karpenter-spot-interruption \
  --event-pattern '{"source":["aws.ec2"],"detail-type":["EC2 Spot Instance Interruption Warning"]}'

aws events put-targets \
  --rule karpenter-spot-interruption \
  --targets "Id=karpenter-sqs,Arn=arn:aws:sqs:us-east-1:123456789012:my-cluster-karpenter"
```

## Consolidation: Karpenter's Key Advantage

Karpenter's consolidation loop runs every 30 seconds and evaluates whether nodes can be removed by moving pods to other nodes:

```yaml
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 30s
```

- **WhenEmpty**: Remove nodes only when all pods have been evicted (safest).
- **WhenEmptyOrUnderutilized**: Simulate pod reassignment and terminate nodes that can be vacated while maintaining all resource requests, PDBs, and topology constraints.

### Protecting Critical Workloads from Consolidation

```yaml
# Add this annotation to pods that should never be disrupted
metadata:
  annotations:
    karpenter.sh/do-not-disrupt: "true"
```

Use `PodDisruptionBudget` to control how many replicas can be disrupted simultaneously:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-server-pdb
  namespace: production
spec:
  minAvailable: 2    # At least 2 replicas must remain available
  selector:
    matchLabels:
      app: api-server
```

## Performance Comparison

| Metric | Cluster Autoscaler | Karpenter |
|--------|-------------------|-----------|
| Node provisioning latency | 3–5 minutes | 30–90 seconds |
| Bin-packing efficiency | Poor (one instance type per ASG) | Excellent (picks optimal type per batch) |
| Spot handling | External tool required | Native |
| Consolidation | 10+ minute delay | 30-second interval |
| New instance type support | Manual ASG creation | Zero configuration |
| Multi-arch support | Multiple ASGs | Single NodePool |

## Real-World Cost Impact

In a 500-node cluster at a mid-size company:

```
Before Karpenter (CAS):
- Node utilization: ~45% average
- 18% nodes running on spot (limited by ASG configuration)
- Scale-down delay: 15 minutes
- Monthly EC2 cost: $180,000

After Karpenter:
- Node utilization: ~72% average (better bin-packing)
- 63% nodes running on spot (Karpenter picks cheapest available)
- Consolidation: 30-second intervals
- Monthly EC2 cost: $94,000 (48% reduction)
```

## Migrating from CAS to Karpenter

### Step 1: Run in Parallel

Deploy Karpenter alongside CAS. Create NodePools with a separate label and update a small workload to use the new label.

```yaml
# Karpenter NodePool taint during migration
taints:
  - key: karpenter-managed
    effect: NoSchedule

# Only pods that tolerate this taint land on Karpenter nodes
tolerations:
  - key: karpenter-managed
    effect: NoSchedule
```

### Step 2: Validate

Monitor Karpenter-provisioned nodes for one week:
- Node provisioning latency
- Pod scheduling success rate
- Spot interruption handling
- Consolidation behavior

### Step 3: Disable CAS Scale-Up

Set CAS `max-node-count` to current cluster size (prevent CAS from adding nodes, but allow scale-down of existing CAS nodes).

### Step 4: Migrate ASG-Backed Nodes

Cordon existing CAS-managed nodes and drain them. Karpenter provisions replacements.

```bash
# Cordon all CAS nodes
kubectl get nodes -l 'eks.amazonaws.com/nodegroup' \
  -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | \
  xargs -I{} kubectl cordon {}

# Drain them (pods reschedule onto Karpenter nodes)
kubectl get nodes -l 'eks.amazonaws.com/nodegroup' \
  -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | \
  xargs -I{} kubectl drain {} --ignore-daemonsets --delete-emptydir-data
```

### Step 5: Remove CAS

```bash
helm uninstall cluster-autoscaler -n kube-system
```

## Monitoring Karpenter

### Prometheus Metrics

```promql
# Nodes provisioned per minute
rate(karpenter_nodes_created_total[5m])

# Nodes terminated per minute
rate(karpenter_nodes_terminated_total[5m])

# Provisioner latency (time from pod pending to node ready)
histogram_quantile(0.99, rate(karpenter_provisioner_scheduling_duration_seconds_bucket[5m]))

# Disruption events
rate(karpenter_disruption_actions_performed_total[5m])

# Billed node-seconds by capacity type
sum by (capacity_type) (karpenter_nodes_total_pod_requests{resource="cpu"})
```

### Grafana Dashboard

Karpenter publishes a pre-built Grafana dashboard at ID `18154`. Import it in Grafana:

```bash
kubectl port-forward -n monitoring svc/grafana 3000:80
# Import dashboard ID 18154
```

## Karpenter vs CAS: When to Use Each

**Use CAS when:**
- You cannot grant EC2 `RunInstances` permissions (strict IAM environment).
- You need ASG lifecycle hooks for compliance reasons.
- You are on a non-AWS cloud (GCP, Azure) — Karpenter is currently AWS-primary, though Azure support is in beta.
- Your team is not ready to understand a new CRD model.

**Use Karpenter when:**
- You want maximum cost efficiency from spot instance usage.
- Your workloads have heterogeneous resource requirements (CPU-optimized, memory-optimized, GPU).
- You need sub-60-second node provisioning for latency-sensitive scale events.
- You want consolidation without long idle timeouts.
- You are starting a new EKS cluster.

## Summary

Karpenter represents a generational improvement in Kubernetes node provisioning. Its direct EC2 API integration, flexible NodePool model, and native spot handling deliver cost savings that CAS's ASG-centric architecture cannot match. The migration path is low-risk — Karpenter can run alongside CAS during a validation period, with zero cluster downtime for the final cutover.

For existing clusters running CAS, the question is not whether to migrate to Karpenter, but when. Most teams see a 30–50% reduction in compute cost within the first month after completing the migration.
