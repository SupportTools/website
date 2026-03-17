---
title: "Kubernetes Karpenter Node Provisioning: Just-in-Time Scaling with NodePool and NodeClass"
date: 2031-02-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Karpenter", "Autoscaling", "AWS", "Node Provisioning", "Cost Optimization"]
categories:
- Kubernetes
- Cloud Infrastructure
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Karpenter architecture, NodePool and NodeClass APIs, instance selection, spot interruption handling, and cost-optimized fleet management for enterprise Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-karpenter-node-provisioning-nodepool-nodeclass-guide/"
---

Karpenter replaces the Cluster Autoscaler with a fundamentally different philosophy: instead of scaling predefined node groups, it provisions nodes just-in-time based on pending pod requirements. The result is faster provisioning, better bin-packing, and significant cost reductions in environments with diverse workload profiles.

This guide covers the full Karpenter operational stack for enterprise teams — from initial installation through production-hardened NodePool and NodeClass configurations, spot fleet management, and consolidation policies that keep infrastructure costs under control.

<!--more-->

# Kubernetes Karpenter Node Provisioning: Just-in-Time Scaling with NodePool and NodeClass

## Section 1: Why Karpenter Replaces the Cluster Autoscaler

The Cluster Autoscaler (CAS) was designed for a world of fixed node groups. It watches for unschedulable pods and scales existing Auto Scaling Groups (ASGs) up or down. This model has several structural limitations:

- **Node group proliferation**: To support different instance types, you need separate ASGs, each with its own launch template.
- **Slow provisioning**: CAS must poll the AWS API to understand which instance types are available in an ASG, adding latency before a scale-up decision.
- **Rigid bin-packing**: CAS cannot choose a better instance type mid-flight — it picks from what the ASG offers.
- **Expensive over-provisioning**: To reduce latency, teams often keep warm nodes, paying for idle compute.

Karpenter solves these problems with direct EC2 Fleet API calls. When a pod is unschedulable, Karpenter evaluates every available instance type against the pod's resource requests, node selector, affinity, topology spread constraints, and taints. It then calls the EC2 Fleet API directly to launch the optimal instance — no ASG required.

### Karpenter vs Cluster Autoscaler Comparison

| Feature | Cluster Autoscaler | Karpenter |
|---|---|---|
| Provisioning model | Scale existing ASGs | Direct EC2/provider API |
| Instance type flexibility | Per-ASG configuration | Per-workload selection |
| Provisioning speed | 3-5 minutes typical | 30-90 seconds typical |
| Consolidation | Limited (scale down) | Bin-pack + replace |
| Spot diversification | Manual ASG setup | Built-in fleet diversification |
| Node lifecycle | ASG managed | Karpenter managed |
| Multi-architecture | Multiple ASGs | Single NodePool |

### Architecture Overview

Karpenter runs as a Deployment inside the cluster. Its components:

1. **Provisioner controller**: Watches for unschedulable pods and calls the cloud provider API to launch nodes.
2. **Node controller**: Monitors node health and triggers replacement when nodes enter terminal states.
3. **Disruption controller**: Implements consolidation, drift detection, and expiration.
4. **Webhook**: Validates NodePool and NodeClass objects.

The cloud provider interface is pluggable. AWS (`karpenter-provider-aws`) is the reference implementation, with Azure, GCP, and vSphere providers also available.

## Section 2: Installation on AWS EKS

### Prerequisites

You need an EKS cluster with IRSA (IAM Roles for Service Accounts) configured. Karpenter's controller pod needs specific IAM permissions to call EC2 and SSM APIs.

```bash
# Set environment variables
export CLUSTER_NAME="production-cluster"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION="us-east-1"
export KARPENTER_VERSION="1.1.0"
export KARPENTER_NAMESPACE="kube-system"
```

### IAM Role for Karpenter Controller

```bash
# Create the Karpenter controller IAM policy
cat > karpenter-controller-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Karpenter",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ec2:DescribeImages",
        "ec2:RunInstances",
        "ec2:DescribeLaunchTemplates",
        "ec2:CreateLaunchTemplate",
        "ec2:DeleteLaunchTemplate",
        "ec2:DescribeInstances",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeAvailabilityZones",
        "ec2:DeleteLaunchTemplate",
        "ec2:CreateTags",
        "ec2:DescribeTags",
        "ec2:TerminateInstances",
        "ec2:CreateFleet",
        "ec2:DescribeSpotPriceHistory",
        "pricing:GetProducts",
        "iam:PassRole",
        "eks:DescribeCluster",
        "iam:CreateInstanceProfile",
        "iam:TagInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ConditionalEC2Termination",
      "Effect": "Allow",
      "Action": "ec2:TerminateInstances",
      "Condition": {
        "StringLike": {
          "ec2:ResourceTag/karpenter.sh/nodepool": "*"
        }
      },
      "Resource": "*"
    },
    {
      "Sid": "PassNodeIAMRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterNodeRole-${CLUSTER_NAME}"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name "KarpenterControllerPolicy-${CLUSTER_NAME}" \
  --policy-document file://karpenter-controller-policy.json
```

### Node IAM Role

```bash
# Create the node IAM role that Karpenter-launched nodes will use
cat > node-trust-policy.json <<'EOF'
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
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --assume-role-policy-document file://node-trust-policy.json

# Attach required policies
for policy in AmazonEKSWorkerNodePolicy AmazonEKS_CNI_Policy AmazonEC2ContainerRegistryReadOnly AmazonSSMManagedInstanceCore; do
  aws iam attach-role-policy \
    --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
    --policy-arn "arn:aws:iam::aws:policy/${policy}"
done
```

### Install with Helm

```bash
# Add the Karpenter Helm repo
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
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::${AWS_ACCOUNT_ID}:role/KarpenterControllerRole-${CLUSTER_NAME}" \
  --wait
```

### Verify Installation

```bash
kubectl get pods -n kube-system -l app.kubernetes.io/name=karpenter
# Expected output:
# NAME                         READY   STATUS    RESTARTS   AGE
# karpenter-7d9f8b5c6d-x9q2p   2/2     Running   0          2m

kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter -c controller --tail=20
```

## Section 3: NodeClass — Configuring the EC2 Environment

The `EC2NodeClass` resource defines the infrastructure configuration for nodes: AMI selection, subnets, security groups, instance profiles, and user data. It is the Karpenter equivalent of a Launch Template.

### Basic EC2NodeClass

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # AMI selection — use EKS-optimized AMIs via alias
  amiSelectorTerms:
    - alias: al2023@latest

  # IAM instance profile for nodes
  role: "KarpenterNodeRole-production-cluster"

  # Subnet selection by tag
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-cluster"
        kubernetes.io/role/internal-elb: "1"

  # Security group selection by tag
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-cluster"

  # EBS volume configuration
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 100Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        kmsKeyID: "arn:aws:kms:us-east-1:123456789012:key/mrk-example"
        deleteOnTermination: true

  # User data is injected automatically for EKS AL2023
  # Additional user data can be provided here
  userData: |
    #!/bin/bash
    # Custom node initialization
    echo "vm.max_map_count=262144" >> /etc/sysctl.conf
    sysctl -p

    # Configure containerd for production
    mkdir -p /etc/containerd
    cat > /etc/containerd/config.toml <<'CONTAINERD_EOF'
    version = 2
    [plugins."io.containerd.grpc.v1.cri"]
      [plugins."io.containerd.grpc.v1.cri".containerd]
        default_runtime_name = "runc"
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
        runtime_type = "io.containerd.runc.v2"
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
          SystemdCgroup = true
    CONTAINERD_EOF
    systemctl restart containerd

  # Tags applied to launched EC2 instances
  tags:
    Environment: production
    ManagedBy: karpenter
    CostCenter: platform-engineering
```

### GPU NodeClass for ML Workloads

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-nodes
spec:
  amiSelectorTerms:
    - alias: al2023@latest

  role: "KarpenterNodeRole-production-cluster"

  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-cluster"
        workload-type: "gpu"

  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: "production-cluster"

  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 200Gi
        volumeType: gp3
        iops: 6000
        throughput: 250
        encrypted: true
        deleteOnTermination: true

  userData: |
    #!/bin/bash
    # Install NVIDIA drivers via DKMS
    yum install -y kernel-devel-$(uname -r) gcc make

    # NVIDIA Container Toolkit
    distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
    curl -s -L https://nvidia.github.io/libnvidia-container/${distribution}/libnvidia-container.repo | \
      tee /etc/yum.repos.d/nvidia-container-toolkit.repo
    yum install -y nvidia-container-toolkit

    # Configure containerd for GPU support
    nvidia-ctk runtime configure --runtime=containerd
    systemctl restart containerd

  tags:
    Environment: production
    NodeType: gpu
    ManagedBy: karpenter
```

## Section 4: NodePool — Defining Scheduling Constraints and Limits

The `NodePool` resource defines what types of nodes Karpenter can provision, how they are labelled and tainted, and when to disrupt them.

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
        node-role: worker
        environment: production
      annotations:
        # Custom annotations applied to nodes
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"

    spec:
      # Reference to the EC2NodeClass
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      # Requirements define what instances Karpenter can use
      requirements:
        # Allow both On-Demand and Spot
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]

        # Restrict to x86_64 and arm64
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]

        # Preferred instance families for cost optimization
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values:
            - m5
            - m5a
            - m5n
            - m6i
            - m6a
            - m6g   # ARM Graviton
            - m7i
            - m7a
            - m7g   # ARM Graviton 3

        # Instance size range — avoid nano/micro for production
        - key: karpenter.k8s.aws/instance-size
          operator: NotIn
          values: ["nano", "micro", "small"]

        # Generation constraint — prefer newer generations
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["4"]

      # Node taints
      taints: []

      # Startup taints — removed after node is ready
      startupTaints:
        - key: node.kubernetes.io/not-ready
          effect: NoSchedule

      # Node expiry — force rotation every 30 days
      expireAfter: 720h

      # Termination grace period
      terminationGracePeriod: 30m

  # Disruption configuration
  disruption:
    # Consolidation policy: WhenEmptyOrUnderutilized replaces underutilized nodes
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m

    # Budgets limit how many nodes can be disrupted simultaneously
    budgets:
      # No disruptions during business hours
      - nodes: "0"
        schedule: "0 9 * * MON-FRI"
        duration: 10h
        reasons:
          - Consolidation
          - Drift
      # Allow 10% disruption at other times
      - nodes: "10%"
        reasons:
          - Consolidation
          - Drift
          - Underutilized
      # Always allow expiration
      - nodes: "5%"
        reasons:
          - Expired

  # Resource limits — maximum resources Karpenter will provision
  limits:
    cpu: "1000"
    memory: 4000Gi
```

### Spot-Only NodePool for Batch Workloads

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-batch
spec:
  template:
    metadata:
      labels:
        node-role: batch-worker
        capacity-type: spot

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]

        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]

        # Wide instance family selection improves spot availability
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values:
            - c5
            - c5a
            - c5n
            - c6i
            - c6a
            - c6g
            - c7i
            - c7a
            - c7g
            - m5
            - m5a
            - m6i
            - m6a
            - r5
            - r6i

        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge"]

      taints:
        - key: workload-type
          value: batch
          effect: NoSchedule

      expireAfter: 24h

  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30s
    budgets:
      - nodes: "100%"

  limits:
    cpu: "500"
    memory: 2000Gi

  weight: 10  # Lower weight = lower scheduling priority
```

### GPU NodePool for ML Inference

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-inference
spec:
  template:
    metadata:
      labels:
        node-role: gpu-inference
        workload-type: ml

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: gpu-nodes

      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]  # GPUs on On-Demand for stability

        - key: karpenter.k8s.aws/instance-family
          operator: In
          values:
            - g4dn   # NVIDIA T4
            - g5     # NVIDIA A10G
            - p3     # NVIDIA V100
            - p4d    # NVIDIA A100

        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge"]

      taints:
        - key: nvidia.com/gpu
          effect: NoSchedule

      expireAfter: 168h  # 7 days for GPU nodes (expensive to replace)

  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 5m
    budgets:
      - nodes: "0"
        schedule: "0 8 * * MON-FRI"
        duration: 12h
        reasons:
          - Consolidation

  limits:
    cpu: "200"
    memory: 800Gi
    "nvidia.com/gpu": "32"
```

## Section 5: Pod Scheduling with Karpenter

### Requesting Specific Node Types

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
spec:
  replicas: 10
  selector:
    matchLabels:
      app: web-api
  template:
    metadata:
      labels:
        app: web-api
    spec:
      # Prefer spot instances for cost savings
      nodeSelector:
        karpenter.sh/capacity-type: spot

      # Topology spread across AZs and nodes
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: web-api
        - maxSkew: 2
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: web-api

      # Pod anti-affinity to spread across nodes
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    app: web-api
                topologyKey: kubernetes.io/hostname

      containers:
        - name: api
          image: your-registry/web-api:latest
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

### Workload Requesting Specific Instance Families

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memory-intensive-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: memory-intensive-app
  template:
    spec:
      # Request memory-optimized instances
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: karpenter.k8s.aws/instance-family
                    operator: In
                    values: ["r5", "r6i", "r7i", "r6a", "r7a"]
                  - key: karpenter.sh/capacity-type
                    operator: In
                    values: ["spot", "on-demand"]

      containers:
        - name: app
          image: your-registry/memory-app:latest
          resources:
            requests:
              cpu: 2
              memory: 24Gi
            limits:
              cpu: 4
              memory: 32Gi
```

### Batch Job with Spot Toleration

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: data-processing-batch
spec:
  parallelism: 20
  completions: 100
  backoffLimit: 3
  template:
    spec:
      restartPolicy: OnFailure

      # Target the spot-batch NodePool
      tolerations:
        - key: workload-type
          value: batch
          effect: NoSchedule

      nodeSelector:
        node-role: batch-worker

      # Checkpoint to S3 on spot interruption
      terminationGracePeriodSeconds: 120

      containers:
        - name: processor
          image: your-registry/batch-processor:latest
          env:
            - name: CHECKPOINT_INTERVAL
              value: "60"
            - name: S3_CHECKPOINT_BUCKET
              value: "my-checkpoint-bucket"
          resources:
            requests:
              cpu: 3
              memory: 6Gi
          lifecycle:
            preStop:
              exec:
                command:
                  - /bin/sh
                  - -c
                  - "python3 /app/checkpoint.py && sleep 30"
```

## Section 6: Spot Interruption Handling

Spot interruptions give 2 minutes of notice via an EC2 instance metadata event. Karpenter integrates with SQS interruption queues to act on these events before the instance is terminated.

### SQS Interruption Queue Setup

```bash
# Create the SQS queue for interruption events
aws sqs create-queue \
  --queue-name "${CLUSTER_NAME}" \
  --attributes '{
    "MessageRetentionPeriod": "300",
    "ReceiveMessageWaitTimeSeconds": "20"
  }'

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url "https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/${CLUSTER_NAME}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

# Configure EventBridge rules to route spot interruption events to SQS
cat > interruption-events-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "events.amazonaws.com"
      },
      "Action": "sqs:SendMessage",
      "Resource": "${QUEUE_ARN}"
    }
  ]
}
EOF

# Apply the queue policy
aws sqs set-queue-attributes \
  --queue-url "https://sqs.${AWS_REGION}.amazonaws.com/${AWS_ACCOUNT_ID}/${CLUSTER_NAME}" \
  --attributes "{\"Policy\": $(cat interruption-events-policy.json | jq -c .)}"

# Create EventBridge rules
for rule_name in SpotInterruption ScheduledChange InstanceStateChange RebalanceRecommendation; do
  aws events put-rule \
    --name "Karpenter${rule_name}Rule-${CLUSTER_NAME}" \
    --event-pattern "{
      \"source\": [\"aws.ec2\"],
      \"detail-type\": [\"EC2 Spot Instance Interruption Warning\"]
    }" \
    --state ENABLED

  aws events put-targets \
    --rule "Karpenter${rule_name}Rule-${CLUSTER_NAME}" \
    --targets "[{\"Id\": \"KarpenterInterruptionQueue\", \"Arn\": \"${QUEUE_ARN}\"}]"
done
```

### How Karpenter Handles Interruptions

When Karpenter receives a spot interruption warning, it:

1. Cordons the affected node immediately.
2. Starts provisioning a replacement node (on-demand or spot from a different pool).
3. Begins graceful eviction of pods from the interrupted node.
4. Waits for replacement node to become Ready.
5. Allows pods to reschedule on the new node.

This happens in under 90 seconds typically — well within the 2-minute interruption window.

### Application-Level Resilience for Spot

```yaml
# PodDisruptionBudget to ensure availability during evictions
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: web-api-pdb
spec:
  minAvailable: "80%"
  selector:
    matchLabels:
      app: web-api
---
# Use multiple replicas with anti-affinity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-api
spec:
  replicas: 10
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 2
  template:
    spec:
      # Graceful termination
      terminationGracePeriodSeconds: 60
      containers:
        - name: api
          image: your-registry/web-api:latest
          # Health check that fails quickly on shutdown
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 1
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
```

## Section 7: Consolidation — Eliminating Waste

Karpenter's consolidation controller continuously evaluates whether running nodes can be replaced with fewer, cheaper nodes without violating scheduling constraints.

### Consolidation Modes

```yaml
# WhenEmpty: Only remove completely empty nodes
disruption:
  consolidationPolicy: WhenEmpty
  consolidateAfter: 30s

# WhenEmptyOrUnderutilized: Replace underutilized nodes with smaller instances
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 1m
```

### Production Consolidation Configuration

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general-purpose
spec:
  # ... (template spec as above)

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m

    budgets:
      # Block consolidation during peak hours (9 AM - 7 PM weekdays)
      - nodes: "0"
        schedule: "0 9 * * MON-FRI"
        duration: 10h
        reasons: [Consolidation, Drift, Underutilized]

      # Allow 20% disruption outside peak hours
      - nodes: "20%"
        reasons: [Consolidation, Drift, Underutilized]

      # Always allow expiry replacements
      - nodes: "5%"
        reasons: [Expired]
```

### Monitoring Consolidation Activity

```bash
# Watch for consolidation events
kubectl get events --field-selector reason=Consolidation -w

# Check Karpenter metrics
kubectl port-forward -n kube-system svc/karpenter 8080:8080 &

# Karpenter exposes Prometheus metrics at /metrics
curl -s http://localhost:8080/metrics | grep karpenter_nodes

# Key metrics:
# karpenter_nodes_total — total nodes managed by Karpenter
# karpenter_nodes_allocatable — allocatable resources per node
# karpenter_disruption_consolidation_total — number of consolidations performed
# karpenter_disruption_budgets_allowed_disruptions — disruptions allowed by budget
```

## Section 8: Drift Detection and Node Rotation

Drift detection identifies nodes that no longer match the NodePool or NodeClass specification and replaces them.

```yaml
# Enable drift detection globally via Karpenter configuration
apiVersion: v1
kind: ConfigMap
metadata:
  name: karpenter-global-settings
  namespace: kube-system
data:
  featureGates: "Drift=true"
```

### Triggering Planned Rotation

```bash
# Annotate a node to trigger voluntary disruption
kubectl annotate node ip-10-0-1-100.ec2.internal \
  karpenter.sh/do-not-disrupt-

# OR: Annotate to prevent disruption
kubectl annotate node ip-10-0-1-100.ec2.internal \
  karpenter.sh/do-not-disrupt=true

# Rotate all nodes in a NodePool by changing expireAfter
kubectl patch nodepool general-purpose \
  --type=merge \
  -p '{"spec":{"template":{"spec":{"expireAfter":"1h"}}}}'

# After rotation completes, reset to normal
kubectl patch nodepool general-purpose \
  --type=merge \
  -p '{"spec":{"template":{"spec":{"expireAfter":"720h"}}}}'
```

### AMI Update Rotation Workflow

```bash
#!/bin/bash
# ami-rotation.sh — safely rotate all nodes to pick up a new AMI

CLUSTER_NAME="production-cluster"
NODEPOOL="general-purpose"

echo "Starting AMI rotation for NodePool: ${NODEPOOL}"

# 1. Annotate NodeClass to pick up new AMI alias
# Karpenter will automatically detect the new AMI via drift

# 2. Check drift status
kubectl get nodeclaims -o json | jq '
  .items[] |
  select(.metadata.labels["karpenter.sh/nodepool"] == "'${NODEPOOL}'") |
  {
    name: .metadata.name,
    ready: .status.conditions[] | select(.type == "Ready") | .status,
    drifted: (.status.conditions[] | select(.type == "Drifted") | .status // "False")
  }
'

# 3. Monitor the rotation
watch -n 5 "kubectl get nodes -l karpenter.sh/nodepool=${NODEPOOL} --sort-by=.metadata.creationTimestamp"
```

## Section 9: Cost Optimization Strategies

### Instance Type Scoring for Cost

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: cost-optimized
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      requirements:
        # Strong preference for Spot
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]

        # Graviton for 20% cost savings vs x86
        - key: kubernetes.io/arch
          operator: In
          values: ["arm64", "amd64"]

        # Prefer Graviton families
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values:
            - m7g    # Graviton 3 general purpose
            - m6g    # Graviton 2 general purpose
            - c7g    # Graviton 3 compute
            - c6g    # Graviton 2 compute
            - r7g    # Graviton 3 memory
            - m7i    # Intel
            - m7a    # AMD
            - c7i
            - c7a

        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["large", "xlarge", "2xlarge", "4xlarge"]
```

### Spot Diversification Best Practices

```bash
# Check spot price history to identify cheap instance types
aws ec2 describe-spot-price-history \
  --instance-types m5.xlarge m6i.xlarge m6a.xlarge m7i.xlarge \
  --product-descriptions "Linux/UNIX" \
  --start-time $(date -u -d "1 hour ago" +%Y-%m-%dT%H:%M:%S) \
  --query 'SpotPriceHistory[].{InstanceType:InstanceType, Price:SpotPrice, AZ:AvailabilityZone}' \
  --output table

# Check current interruption rates via AWS Spot Instance Advisor
# Higher diversification = lower interruption probability
```

### Resource-Based Cost Tagging

```yaml
# Tag nodes for cost attribution
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: team-frontend
spec:
  template:
    metadata:
      labels:
        team: frontend
        cost-center: platform

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
```

## Section 10: Observability and Troubleshooting

### Essential Karpenter Metrics

```yaml
# Prometheus ServiceMonitor for Karpenter
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
```

### Grafana Dashboard Queries

```promql
# Nodes provisioned per NodePool over time
sum(karpenter_nodes_total) by (nodepool)

# Pending pods waiting for nodes
karpenter_provisioner_scheduling_simulation_duration_seconds_count

# Disruption events rate
rate(karpenter_disruption_disruptions_total[5m])

# Node age distribution (detect stuck old nodes)
histogram_quantile(0.99,
  sum(karpenter_nodes_allocatable{resource="cpu"}) by (le, nodepool)
)

# Cost efficiency (spot vs on-demand ratio)
sum(karpenter_nodes_total{capacity_type="spot"}) /
sum(karpenter_nodes_total)
```

### Common Troubleshooting Commands

```bash
# Check why pods are pending
kubectl describe pod <pending-pod> | grep -A 20 Events

# Check NodeClaims (one per node launched by Karpenter)
kubectl get nodeclaims -o wide

# Check a specific NodeClaim
kubectl describe nodeclaim <nodeclaim-name>

# Check Karpenter controller logs for provisioning decisions
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter \
  -c controller \
  --since=10m | grep -E "(ERROR|WARN|provisioning|launching)"

# Check if NodePool limits are hit
kubectl get nodepool general-purpose -o json | \
  jq '{
    limits: .spec.limits,
    used: .status.resources
  }'

# Check disruption budget status
kubectl get nodepool general-purpose -o json | \
  jq '.status.conditions[] | select(.type == "DisruptionAllowed")'

# Force Karpenter to re-evaluate pending pods
kubectl annotate pods -l app=myapp \
  karpenter.sh/do-not-disrupt-
```

### NodeClaim State Machine

```bash
# Monitor the lifecycle of a NodeClaim
kubectl get nodeclaims -w

# States:
# Pending    -> Node request submitted to cloud provider
# Launching  -> Instance launching in EC2
# Registered -> Node registered in Kubernetes API
# Initialized -> Node passed initialization checks
# Ready      -> Node accepting workloads
```

### Debugging Provisioning Failures

```bash
# Check for common provisioning issues
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter \
  -c controller | grep -i "failed\|error\|cannot" | tail -50

# Common error patterns and fixes:
# 1. "no instance type found" — requirements too restrictive
# 2. "insufficient capacity" — instance type unavailable in AZ, add more families
# 3. "iam:PassRole denied" — IAM role permission missing
# 4. "subnet not found" — subnet tag missing or wrong value
# 5. "security group not found" — security group tag missing

# Check available instance types in the NodePool
kubectl get nodepool general-purpose -o json | \
  jq '.status.conditions[] | select(.type == "Ready")'
```

## Section 11: Multi-Tenant NodePool Architecture

For clusters shared across teams, use separate NodePools with namespace isolation:

```yaml
# Team-specific NodePool with namespace binding via label selectors
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: team-data
spec:
  template:
    metadata:
      labels:
        team: data-engineering

    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["r5", "r6i", "r7i"]
        - key: karpenter.k8s.aws/instance-size
          operator: In
          values: ["4xlarge", "8xlarge", "12xlarge", "16xlarge"]

      taints:
        - key: team
          value: data-engineering
          effect: NoSchedule

  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 2m

  limits:
    cpu: "400"
    memory: 3000Gi
    "ephemeral-storage": 5000Gi
---
# Namespace ResourceQuota ensuring pods only schedule on team nodes
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-data-quota
  namespace: team-data
spec:
  hard:
    requests.cpu: "200"
    requests.memory: 1500Gi
    pods: "500"
```

## Section 12: Migration from Cluster Autoscaler

```bash
#!/bin/bash
# migrate-from-cas.sh

# 1. Install Karpenter (following Section 2 above)

# 2. Create NodePools matching your existing ASG configurations

# 3. Cordon the CAS-managed ASG nodes (without draining yet)
for node in $(kubectl get nodes -l eks.amazonaws.com/nodegroup=workers -o name); do
  kubectl cordon $node
done

# 4. Scale down Cluster Autoscaler to zero
kubectl scale deployment cluster-autoscaler \
  -n kube-system \
  --replicas=0

# 5. Create a Karpenter NodePool that matches your existing config
# (See Section 4 above)

# 6. Wait for Karpenter to provision replacement nodes
kubectl get nodes -w

# 7. Once new nodes are Ready, drain old nodes
for node in $(kubectl get nodes -l eks.amazonaws.com/nodegroup=workers -o name); do
  kubectl drain $node \
    --ignore-daemonsets \
    --delete-emptydir-data \
    --grace-period=60 \
    --timeout=300s
done

# 8. Verify all workloads are running on Karpenter nodes
kubectl get pods --all-namespaces -o wide | grep -v "karpenter\."

# 9. Scale down the old ASG to 0
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name "eks-workers-${CLUSTER_NAME}" \
  --min-size 0 \
  --desired-capacity 0

# 10. Remove Cluster Autoscaler
kubectl delete deployment cluster-autoscaler -n kube-system
```

## Summary

Karpenter transforms cluster scaling from a reactive, node-group-based model to a proactive, workload-aware provisioning system. The key operational points are:

- **NodeClass** defines the EC2 environment (AMI, subnets, security groups, block devices). Update it to rotate AMIs or change instance configurations.
- **NodePool** defines scheduling constraints and provisioning limits. Use multiple NodePools for different workload profiles (spot batch, on-demand production, GPU).
- **Consolidation** is your primary cost lever — configure budgets to prevent disruptions during peak hours while aggressively consolidating off-peak.
- **Spot interruption handling** via SQS queues gives Karpenter the ability to preemptively cordon and drain nodes before AWS reclaims them.
- **Diversification** across instance families and sizes is the single most effective way to maintain spot availability — aim for at least 8-10 instance types per NodePool.

For production deployments, start with `WhenEmpty` consolidation, instrument Prometheus metrics, and graduate to `WhenEmptyOrUnderutilized` once you trust the disruption budget configuration.
