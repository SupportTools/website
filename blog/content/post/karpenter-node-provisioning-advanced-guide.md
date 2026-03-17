---
title: "Karpenter Advanced Node Provisioning: Cost-Optimized Kubernetes Scaling"
date: 2027-10-10T00:00:00-05:00
draft: false
tags: ["Karpenter", "Kubernetes", "Autoscaling", "AWS", "Cost Optimization"]
categories:
- Kubernetes
- AWS
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Karpenter configuration guide covering NodePool and EC2NodeClass v1 API, Spot interruption handling, consolidation policies, GPU provisioning, ARM64 multi-arch support, drift detection, and migration from Cluster Autoscaler."
more_link: "yes"
url: "/karpenter-node-provisioning-advanced-guide/"
---

Karpenter replaces the Cluster Autoscaler with a fundamentally different approach to node provisioning. Rather than scaling predefined node groups, Karpenter provisions exactly the right EC2 instance type for each workload based on pending pod requirements, Spot availability, and cost. This guide covers advanced Karpenter configuration using the stable v1 API, with production patterns for cost optimization, GPU workloads, multi-architecture fleets, and safe migration from Cluster Autoscaler.

<!--more-->

# Karpenter Advanced Node Provisioning: Cost-Optimized Kubernetes Scaling

## Section 1: Installation and Prerequisites

### EKS Setup Requirements

Karpenter requires specific IAM permissions and cluster access to function. The recommended approach uses IRSA for the controller.

```bash
# Set environment variables
export CLUSTER_NAME="production-eks"
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION="us-east-1"
export KARPENTER_VERSION="1.1.0"
export KARPENTER_NAMESPACE="kube-system"

# Create IAM role for Karpenter controller
cat > karpenter-controller-policy.json <<'EOF'
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
        "pricing:GetProducts",
        "iam:PassRole"
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
      "Resource": "arn:aws:eks:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${CLUSTER_NAME}",
      "Sid": "EKSClusterEndpointLookup"
    }
  ],
  "Version": "2012-10-17"
}
EOF
```

### Helm Installation

```bash
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

## Section 2: NodePool and EC2NodeClass v1 API

The v1 API introduced in Karpenter 1.0 replaces the previously-beta Provisioner CRD. The key objects are `NodePool` (workload constraints and scheduling) and `EC2NodeClass` (AWS-specific instance configuration).

### EC2NodeClass — AWS Infrastructure Configuration

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: default
spec:
  # AMI selection — al2023 is recommended for new clusters
  amiFamily: AL2023

  # AMI selection can be pinned by query
  amiSelectorTerms:
    - alias: al2023@latest

  # Instance profile for worker nodes
  role: KarpenterNodeRole-production-eks

  # Subnet selection — nodes launch into subnets with these tags
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks

  # Security group selection
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks

  # EBS root volume configuration
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 50Gi
        volumeType: gp3
        iops: 3000
        throughput: 125
        encrypted: true
        deleteOnTermination: true

  # UserData for node initialization (AL2023 uses MIME multipart)
  userData: |
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="BOUNDARY"

    --BOUNDARY
    Content-Type: text/x-shellscript; charset="us-ascii"

    #!/bin/bash
    # Custom node initialization
    sysctl -w vm.max_map_count=262144
    sysctl -w net.core.somaxconn=32768
    sysctl -w net.ipv4.tcp_max_syn_backlog=16384
    echo "vm.max_map_count=262144" >> /etc/sysctl.conf
    echo "net.core.somaxconn=32768" >> /etc/sysctl.conf

    --BOUNDARY--

  # Instance metadata options
  metadataOptions:
    httpEndpoint: enabled
    httpProtocolIPv6: disabled
    httpPutResponseHopLimit: 1
    httpTokens: required  # Enforce IMDSv2

  # Tags applied to all EC2 instances
  tags:
    Environment: production
    ManagedBy: karpenter
    CostCenter: platform-engineering
```

### NodePool — Scheduling Constraints and Limits

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    metadata:
      labels:
        nodepool: default
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default

      # Requirements define which instances Karpenter can select
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
          values: ["4"]

        # Exclude instance families with older networking
        - key: karpenter.k8s.aws/instance-family
          operator: NotIn
          values: ["t2", "t3", "t3a"]

        - key: karpenter.k8s.aws/instance-size
          operator: NotIn
          values: ["nano", "micro", "small"]

      # Expiration: nodes are replaced after this duration
      # This forces periodic re-evaluation of better instance options
      expireAfter: 720h  # 30 days

      # Termination grace period for workload draining
      terminationGracePeriod: 30m

  # Disruption policy controls how Karpenter replaces nodes
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
    budgets:
      # Never consolidate more than 20% of nodes at once
      - nodes: "20%"
      # Disallow consolidation between 9 AM and 5 PM weekdays
      - nodes: "0"
        schedule: "0 9 * * 1-5"
        duration: 8h

  # Resource limits: Karpenter will not provision beyond these
  limits:
    cpu: "1000"
    memory: 4000Gi
```

## Section 3: Spot Instance Configuration and Interruption Handling

### Spot-Optimized NodePool

For batch and fault-tolerant workloads, prefer Spot but fall back to On-Demand:

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-preferred
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["4"]
      # Spot nodes expire sooner to reduce interruption blast radius
      expireAfter: 168h  # 7 days
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
  # Weight: when multiple NodePools match, higher weight is preferred
  weight: 50
```

### On-Demand NodePool for Critical Workloads

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: on-demand-critical
spec:
  template:
    metadata:
      labels:
        nodepool: on-demand-critical
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
          values: ["m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["5"]
      expireAfter: 720h
  disruption:
    # Never consolidate critical workload nodes
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30m
    budgets:
      - nodes: "10%"
  weight: 100
```

Workloads requiring On-Demand use node affinity:

```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["on-demand"]
              - key: nodepool
                operator: In
                values: ["on-demand-critical"]
```

### Spot Interruption Queue

Karpenter handles EC2 Spot interruption notices via an SQS queue. When AWS sends a two-minute warning, Karpenter cordons the node, drains workloads gracefully, and provisions replacements.

```bash
# Create SQS queue for interruption events
aws sqs create-queue \
  --queue-name "${CLUSTER_NAME}" \
  --attributes '{"MessageRetentionPeriod":"300"}'

# Create EventBridge rules for spot interruptions, rebalance events, and health events
aws events put-rule \
  --name "KarpenterInterruptionQueueRule" \
  --event-pattern '{
    "source": ["aws.ec2"],
    "detail-type": [
      "EC2 Spot Instance Interruption Warning",
      "EC2 Instance Rebalance Recommendation",
      "EC2 Instance State-change Notification"
    ]
  }' \
  --state ENABLED

# The Helm installation configures settings.interruptionQueue automatically
# Verify the queue name matches
kubectl -n kube-system get configmap karpenter-global-settings \
  -o jsonpath='{.data.interruptionQueue}'
```

## Section 4: Consolidation Policies

Consolidation removes underutilized nodes to reduce costs. Karpenter supports two consolidation policies:

- `WhenEmpty`: Only consolidate nodes with no non-daemonset pods.
- `WhenEmptyOrUnderutilized`: Also consolidate nodes whose workloads can be moved to fewer nodes.

### Consolidation Budgets

Budgets prevent consolidation during business hours or from removing too many nodes simultaneously:

```yaml
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 5m
  budgets:
    # Normal operations: allow up to 10% disruption
    - nodes: "10%"

    # Peak traffic hours Monday-Friday: no consolidation
    - nodes: "0"
      schedule: "0 8 * * 1-5"
      duration: 10h

    # Deployment windows: slow down disruption to 1 node at a time
    - nodes: "1"
      schedule: "30 18 * * 1-5"
      duration: 2h
```

### Do-Not-Disrupt Annotation

Prevent Karpenter from disrupting specific pods during critical operations:

```yaml
# Add to pod spec during database migrations or critical jobs
metadata:
  annotations:
    karpenter.sh/do-not-disrupt: "true"
```

Or prevent node consolidation for an entire node:

```bash
# Add annotation to a node to prevent any disruption
kubectl annotate node ip-10-0-1-100.ec2.internal \
  karpenter.sh/do-not-disrupt=true
```

## Section 5: GPU Node Provisioning

### EC2NodeClass for GPU Instances

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-nodes
spec:
  amiFamily: AL2023
  amiSelectorTerms:
    - alias: al2023@latest
  role: KarpenterNodeRole-production-eks
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        # GPU workloads often need more disk for model artifacts
        volumeSize: 200Gi
        volumeType: gp3
        iops: 3000
        throughput: 250
        encrypted: true
        deleteOnTermination: true
  userData: |
    MIME-Version: 1.0
    Content-Type: multipart/mixed; boundary="BOUNDARY"

    --BOUNDARY
    Content-Type: text/x-shellscript; charset="us-ascii"

    #!/bin/bash
    # Install NVIDIA drivers and container toolkit
    dnf install -y kernel-devel-$(uname -r) kernel-headers-$(uname -r)

    --BOUNDARY--
  tags:
    NodeType: gpu
    Environment: production
```

### NodePool for GPU Workloads

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: gpu-inference
spec:
  template:
    metadata:
      labels:
        nodepool: gpu-inference
        accelerator: nvidia
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: gpu-nodes
      taints:
        # Require explicit toleration to schedule on GPU nodes
        - key: nvidia.com/gpu
          value: "true"
          effect: NoSchedule
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]  # GPU spot is often unavailable
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["g4dn", "g5", "p3", "p4d", "p4de", "p5"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64"]
      # GPU nodes should not be consolidated aggressively
      expireAfter: 720h
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 10m
    budgets:
      - nodes: "1"
  limits:
    cpu: "200"
    memory: 1000Gi
    nvidia.com/gpu: "20"
```

GPU workload pod spec with toleration:

```yaml
spec:
  tolerations:
    - key: nvidia.com/gpu
      operator: Equal
      value: "true"
      effect: NoSchedule
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: nodepool
                operator: In
                values: ["gpu-inference"]
  containers:
    - name: inference
      image: support-tools/model-server:v1.0
      resources:
        limits:
          nvidia.com/gpu: "1"
          memory: 16Gi
        requests:
          nvidia.com/gpu: "1"
          memory: 16Gi
```

## Section 6: ARM64 Instance Selection with Multi-Arch Images

ARM64 (Graviton) instances provide 20-40% better price-performance than equivalent x86 instances for many workloads. Karpenter can select ARM64 instances automatically when multi-arch images are available.

### Multi-Arch NodePool

```yaml
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
        name: default
      requirements:
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["5"]
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 1m
```

### Building Multi-Arch Images

```dockerfile
# Dockerfile supporting both amd64 and arm64
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder
ARG TARGETARCH
ARG TARGETOS
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -ldflags="-s -w" -o server ./cmd/server

FROM --platform=$TARGETPLATFORM gcr.io/distroless/static:nonroot
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]
```

```bash
# Build and push multi-arch image
docker buildx create --use --name multi-arch-builder

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag support-tools/myapp:v2.5.0 \
  --push \
  .

# Verify manifest list
docker manifest inspect support-tools/myapp:v2.5.0
```

### Arch-Specific Pod Topology

For workloads that explicitly require Graviton:

```yaml
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: kubernetes.io/arch
                operator: In
                values: ["arm64"]
```

## Section 7: Drift Detection and Remediation

Karpenter's drift detection identifies nodes whose configuration has diverged from their NodePool or EC2NodeClass specification and replaces them automatically.

### Drift Sources

Drift is detected when:
- The AMI used for a node is no longer the latest matching `amiSelectorTerms`
- The launch template parameters have changed (userData, block device mappings)
- The NodePool requirements no longer match the node's instance type
- The NodePool expiry (`expireAfter`) has elapsed

### Drift Configuration

```yaml
# Global drift settings in Karpenter config
apiVersion: v1
kind: ConfigMap
metadata:
  name: karpenter-global-settings
  namespace: kube-system
data:
  # Enable drift detection (default: enabled)
  featureGates.drift: "true"
```

### Monitoring Drift

```bash
# Check nodes flagged for drift
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.karpenter\.sh/disruption-reason}{"\n"}{end}' \
  | grep -v "^$"

# Check NodeClaim status for drift
kubectl get nodeclaims \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Drifted")].status}{"\n"}{end}'
```

### Controlled AMI Updates

To control when AMI updates propagate across nodes, pin the AMI version in `EC2NodeClass` for production and update it deliberately:

```yaml
# Production EC2NodeClass: pin specific AMI
spec:
  amiSelectorTerms:
    - tags:
        # Pin to a specific tested AMI tag
        ami-validation-status: approved
        kubernetes-version: "1.31"
```

```bash
# When ready to update, tag the new AMI
aws ec2 create-tags \
  --resources ami-0123456789abcdef0 \
  --tags \
    Key=ami-validation-status,Value=approved \
    Key=kubernetes-version,Value=1.31

# Remove the tag from the old AMI
aws ec2 delete-tags \
  --resources ami-old0123456789abc \
  --tags Key=ami-validation-status
```

## Section 8: Weight-Based NodePool Priority

When multiple NodePools match a pod's requirements, Karpenter uses `weight` to determine preference. Higher weight NodePools are tried first.

```yaml
# Priority order for workload placement:
# 1. spot-burst (weight: 10): Spot instances for burst capacity
# 2. on-demand-standard (weight: 50): On-Demand for normal workloads
# 3. on-demand-reserved (weight: 100): Reserved instance pool (preferred)

---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: on-demand-reserved
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: reserved-class
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand"]
        - key: karpenter.k8s.aws/instance-family
          operator: In
          values: ["m5", "m6i", "m7i"]  # Match reserved instance family
  weight: 100
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: on-demand-standard
spec:
  template:
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
          values: ["c", "m", "r"]
  weight: 50
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: spot-burst
spec:
  template:
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
          values: ["c", "m", "r"]
  weight: 10
```

## Section 9: Pod Topology Spread Constraints Interaction

Karpenter respects pod topology spread constraints when making provisioning decisions. This allows spreading across availability zones or nodes while still benefiting from just-in-time provisioning.

```yaml
# Application deployment using topology spread
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
spec:
  replicas: 9
  template:
    spec:
      topologySpreadConstraints:
        # Spread evenly across 3 AZs (max 1 pod skew)
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-server

        # Spread across nodes (max 2 pods per node)
        - maxSkew: 2
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: api-server
```

Karpenter provisions nodes in the appropriate AZs to satisfy these constraints, selecting the cheapest available Spot instance in each zone that can accommodate the workload.

### Zonal NodePools

For workloads requiring explicit zone control:

```yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: us-east-1a
spec:
  role: KarpenterNodeRole-production-eks
  subnetSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks
        topology.kubernetes.io/zone: us-east-1a
  securityGroupSelectorTerms:
    - tags:
        karpenter.sh/discovery: production-eks
  amiFamily: AL2023
  amiSelectorTerms:
    - alias: al2023@latest
  blockDeviceMappings:
    - deviceName: /dev/xvda
      ebs:
        volumeSize: 50Gi
        volumeType: gp3
        encrypted: true
        deleteOnTermination: true
```

## Section 10: Migration from Cluster Autoscaler

### Migration Strategy

Migrating from Cluster Autoscaler to Karpenter requires careful coordination to avoid provisioning conflicts.

**Step 1: Deploy Karpenter alongside Cluster Autoscaler**

```bash
# Install Karpenter but do not create NodePools yet
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "${KARPENTER_VERSION}" \
  --namespace kube-system \
  --set "settings.clusterName=${CLUSTER_NAME}" \
  --set "settings.interruptionQueue=${CLUSTER_NAME}"

# Verify Karpenter controller starts without errors
kubectl -n kube-system logs deployment/karpenter -f
```

**Step 2: Create NodePools that do NOT overlap with existing node groups**

```yaml
# Create a Karpenter NodePool with a unique taint
# to test provisioning without disrupting existing workloads
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: karpenter-test
spec:
  template:
    metadata:
      labels:
        provisioner: karpenter
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
      taints:
        - key: karpenter-test
          value: "true"
          effect: NoSchedule
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["m"]
```

**Step 3: Validate Karpenter provisioning with test workloads**

```bash
# Deploy a test workload that tolerates the test taint
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: karpenter-test
spec:
  replicas: 5
  selector:
    matchLabels:
      app: karpenter-test
  template:
    metadata:
      labels:
        app: karpenter-test
    spec:
      tolerations:
        - key: karpenter-test
          operator: Equal
          value: "true"
          effect: NoSchedule
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: provisioner
                    operator: In
                    values: ["karpenter"]
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
EOF

# Watch Karpenter provision nodes
kubectl -n kube-system logs deployment/karpenter -f | grep "launched nodeclaim"
kubectl get nodes -l provisioner=karpenter -w
```

**Step 4: Disable Cluster Autoscaler on specific node groups**

```bash
# Add annotation to node groups to prevent Cluster Autoscaler scaling
aws autoscaling update-auto-scaling-group \
  --auto-scaling-group-name "${CLUSTER_NAME}-workers-20240101" \
  --tags "ResourceId=${CLUSTER_NAME}-workers-20240101,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/enabled,Value=false,PropagateAtLaunch=false"
```

**Step 5: Migrate workloads and remove Cluster Autoscaler**

```bash
# After all workloads are confirmed stable on Karpenter-provisioned nodes:
kubectl -n kube-system scale deployment cluster-autoscaler --replicas=0

# Remove Cluster Autoscaler after validation period
helm uninstall cluster-autoscaler -n kube-system

# Delete old node groups via AWS console or CLI
# (drain nodes first)
```

### Cluster Autoscaler vs Karpenter Comparison

| Feature | Cluster Autoscaler | Karpenter |
|---------|-------------------|-----------|
| Node selection | Fixed node groups | Any EC2 instance type |
| Provisioning time | 2-5 minutes | 30-90 seconds |
| Spot diversification | Requires multiple node groups | Automatic |
| Cost optimization | Limited to configured groups | Right-sizing per pod |
| ARM64 support | Requires dedicated node group | Automatic when multi-arch |
| Consolidation | Node group scale-down | Pod-aware bin packing |
| Drift detection | None | Built-in AMI and config drift |

## Section 11: Observability and Cost Analysis

### Karpenter Metrics

```bash
kubectl -n kube-system port-forward svc/karpenter 8080:8080

# Key provisioning metrics
curl -s http://localhost:8080/metrics | grep -E "karpenter_nodes|karpenter_pods|karpenter_provisioner"
```

Key metrics:

```
karpenter_nodes_total{nodepool}
karpenter_nodes_allocatable{nodepool, resource_type}
karpenter_pods_state{state}
karpenter_provisioner_scheduling_duration_seconds
karpenter_interruption_received_messages_total
karpenter_interruption_deleted_messages_total
```

### PrometheusRule for Karpenter

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: karpenter-alerts
  namespace: kube-system
  labels:
    release: prometheus
spec:
  groups:
    - name: karpenter
      rules:
        - alert: KarpenterProvisioningErrors
          expr: increase(karpenter_provisioner_scheduling_duration_seconds_count[5m]) == 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Karpenter has not scheduled any nodes in 10 minutes"

        - alert: KarpenterNodeNotReady
          expr: karpenter_nodes_total{lifecycle="ready"} / karpenter_nodes_total < 0.9
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "More than 10% of Karpenter nodes are not ready"

        - alert: KarpenterHighPendingPods
          expr: karpenter_pods_state{state="pending"} > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "More than 50 pods are pending in Karpenter queue"
```

### Cost Visibility

```bash
# Query node cost distribution by capacity type
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.karpenter\.sh/capacity-type}{"\t"}{.metadata.labels.node\.kubernetes\.io/instance-type}{"\n"}{end}' \
  | sort -k2

# Calculate spot savings estimate
ON_DEMAND_COUNT=$(kubectl get nodes \
  -l karpenter.sh/capacity-type=on-demand --no-headers | wc -l)
SPOT_COUNT=$(kubectl get nodes \
  -l karpenter.sh/capacity-type=spot --no-headers | wc -l)
echo "On-Demand: ${ON_DEMAND_COUNT}, Spot: ${SPOT_COUNT}"
echo "Approximate spot savings: ~70% on ${SPOT_COUNT} nodes"
```

The combination of just-in-time provisioning, right-sized instances, ARM64 support, and aggressive Spot utilization typically reduces EC2 costs by 40-70% compared to pre-provisioned fixed node groups, while simultaneously improving cluster responsiveness to workload demand spikes.
