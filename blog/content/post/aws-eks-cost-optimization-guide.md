---
title: "AWS EKS Cost Optimization: Spot Instances, Karpenter, and Right-Sizing"
date: 2028-02-09T00:00:00-05:00
draft: false
tags: ["AWS", "EKS", "Karpenter", "Spot Instances", "Cost Optimization", "FinOps", "Kubernetes", "Graviton"]
categories:
- AWS
- Kubernetes
- FinOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to EKS cost optimization using Karpenter NodePools with spot instances, consolidation policies, Graviton ARM instances, KEDA scale-to-zero, and right-sizing strategies for enterprise workloads."
more_link: "yes"
url: "/aws-eks-cost-optimization-karpenter-spot-instances-right-sizing/"
---

AWS EKS clusters without deliberate cost controls are expensive to run. Default configurations leave significant money on the table: on-demand instances where spot would work, over-provisioned nodes with 40% average CPU utilization, StatefulSets running at full capacity overnight when usage is zero, and x86 instances where Graviton ARM would deliver the same performance at 20% lower cost. This guide covers the complete EKS cost optimization stack for production environments.

<!--more-->

# AWS EKS Cost Optimization: Spot Instances, Karpenter, and Right-Sizing

## The Cost Optimization Hierarchy

Effective EKS cost reduction requires addressing all layers simultaneously:

1. **Right-size pods** — Reduce CPU/memory requests to match actual usage (VPA or manual tuning)
2. **Use spot instances** — Replace on-demand with spot for interruption-tolerant workloads
3. **Consolidate nodes** — Karpenter bin-packing ensures nodes are maximally utilized
4. **Scale to zero** — KEDA eliminates idle resources for event-driven workloads
5. **Use Graviton** — ARM instances for compatible workloads at lower cost per vCPU
6. **Reserve baseline capacity** — Savings Plans and Reserved Instances for predictable loads

## Karpenter: NodePool and EC2NodeClass

Karpenter replaces the Cluster Autoscaler as the recommended node provisioner for EKS. It provisions nodes in under 60 seconds (compared to 3–5 minutes with the Cluster Autoscaler), selects optimal instance types automatically, and consolidates workloads onto fewer nodes when demand decreases.

### Installing Karpenter

```bash
# Set environment variables
export CLUSTER_NAME="production-cluster"
export AWS_ACCOUNT_ID="123456789012"
export AWS_REGION="us-east-1"
export KARPENTER_VERSION="1.0.0"
export KARPENTER_NAMESPACE="kube-system"

# Create Karpenter IAM role using eksctl
eksctl create iamserviceaccount \
  --name karpenter \
  --namespace "${KARPENTER_NAMESPACE}" \
  --cluster "${CLUSTER_NAME}" \
  --role-name "KarpenterNodeRole-${CLUSTER_NAME}" \
  --attach-policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/KarpenterControllerPolicy-${CLUSTER_NAME}" \
  --approve

# Tag subnets and security groups for Karpenter discovery
aws ec2 create-tags \
  --resources subnet-0a1b2c3d4e5f6789a subnet-0b2c3d4e5f6789ab subnet-0c3d4e5f6789abc \
  --tags "Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}"

# Install Karpenter via Helm
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

### EC2NodeClass: Instance Configuration

```yaml
# ec2nodeclass-general.yaml
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: general-purpose
spec:
  # AMI family — AL2023 is the current recommended Amazon Linux for EKS
  amiFamily: AL2023

  # AMI selection: use the latest EKS-optimized AMI for the cluster's Kubernetes version
  amiSelectorTerms:
  - alias: al2023@latest

  # Subnet selection: Karpenter provisions nodes in subnets with this tag
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster
      # Restrict to private subnets only; public subnet nodes should be avoided
      aws:subnet-type: private

  # Security group selection
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster

  # IAM role for EC2 instances (the node IAM role, not the controller role)
  role: "KarpenterNodeRole-production-cluster"

  # Instance store: use nvme instance storage when available
  instanceStorePolicy: RAID0

  # Block device configuration for the root volume
  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 100Gi
      volumeType: gp3
      # IOPS: gp3 allows up to 16000 IOPS; 3000 is sufficient for most workloads
      iops: 3000
      throughput: 125
      encrypted: true
      # Use KMS key for EBS encryption
      kmsKeyID: "arn:aws:kms:us-east-1:123456789012:key/mrk-12345678abcdef"
      deleteOnTermination: true

  # User data: inject EKS bootstrap configuration
  userData: |
    #!/bin/bash
    /etc/eks/bootstrap.sh production-cluster \
      --kubelet-extra-args '--max-pods=110 --node-labels=node-role/compute=true'

  # Tags applied to all EC2 instances provisioned by this NodeClass
  tags:
    Environment: production
    ManagedBy: karpenter
    CostCenter: platform-engineering
---
# Separate NodeClass for GPU workloads
apiVersion: karpenter.k8s.aws/v1
kind: EC2NodeClass
metadata:
  name: gpu-compute
spec:
  amiFamily: AL2023
  amiSelectorTerms:
  - alias: al2023@latest
  subnetSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster
  securityGroupSelectorTerms:
  - tags:
      karpenter.sh/discovery: production-cluster
  role: "KarpenterNodeRole-production-cluster"
  blockDeviceMappings:
  - deviceName: /dev/xvda
    ebs:
      volumeSize: 200Gi
      volumeType: gp3
      iops: 6000
      throughput: 500
      encrypted: true
      deleteOnTermination: true
  tags:
    Environment: production
    ManagedBy: karpenter
    NodeType: gpu-compute
```

### NodePool: Spot and On-Demand Strategy

```yaml
# nodepool-general-spot.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general-spot
spec:
  template:
    metadata:
      labels:
        node-pool: general-spot
        workload-class: stateless
      annotations:
        # Node is eligible for Karpenter consolidation
        karpenter.sh/do-not-disrupt: "false"
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose

      requirements:
      # Instance generation: current and previous generation for broad availability
      - key: karpenter.k8s.aws/instance-generation
        operator: Gt
        values: ["2"]

      # Architecture: allow both x86 and Graviton ARM
      # ARM instances (Graviton) provide ~20% better price-performance for most workloads
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64", "arm64"]

      # Capacity type: SPOT preferred, with on-demand fallback
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]

      # Instance size: exclude nano/micro/small (too small for production workloads)
      - key: karpenter.k8s.aws/instance-size
        operator: NotIn
        values: ["nano", "micro", "small"]

      # Exclude instances with less than 4 vCPUs (bin-packing efficiency)
      - key: karpenter.k8s.aws/instance-cpu
        operator: Gt
        values: ["3"]

      # Exclude bare-metal instances (not cost-effective for general workloads)
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]  # Compute, Memory, Memory-intensive families

      # Avoid instances with local HDD (NVMe preferred or none)
      - key: karpenter.k8s.aws/instance-local-nvme
        operator: DoesNotExist

      # Exclude network-intensive instances reserved for data transfer workloads
      - key: karpenter.k8s.aws/instance-network-bandwidth
        operator: Lt
        values: ["100000"]  # Exclude 100Gbps+ instances for cost control

      # Taints to repel pods that should not run on this pool
      taints: []

      # Kubelet configuration: tune for production workloads
      kubelet:
        maxPods: 110
        # System reserved resources — protect the node from workload OOM
        systemReserved:
          cpu: 200m
          memory: 500Mi
          ephemeral-storage: 1Gi
        kubeReserved:
          cpu: 200m
          memory: 500Mi
          ephemeral-storage: 1Gi
        evictionHard:
          memory.available: 500Mi
          nodefs.available: 10%
          nodefs.inodesFree: 10%
        evictionSoft:
          memory.available: 1Gi
          nodefs.available: 15%
        evictionSoftGracePeriod:
          memory.available: 90s
          nodefs.available: 120s

  # Disruption policy: control when Karpenter can consolidate or replace nodes
  disruption:
    # Consolidation: remove under-utilized nodes and repack workloads
    consolidationPolicy: WhenEmptyOrUnderutilized
    # Minimum time a node must be empty before termination
    consolidateAfter: 30s
    # Maximum disruption budget during consolidation
    budgets:
    # Allow up to 20% of nodes to be disrupted at any time
    - maxUnavailable: "20%"
    # Restrict disruption during business hours (UTC+0 — adjust for timezone)
    - schedule: "0 9-17 * * Mon-Fri"
      duration: 8h
      maxUnavailable: "5%"

  # Node pool limits: prevent runaway scaling
  limits:
    cpu: "500"         # Maximum total CPU across all nodes in this pool
    memory: "2000Gi"   # Maximum total memory

  # Node pool weight: higher weight = preferred over lower-weight pools
  weight: 100
---
# nodepool-general-ondemand.yaml — fallback for spot-incompatible workloads
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general-ondemand
spec:
  template:
    metadata:
      labels:
        node-pool: general-ondemand
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose
      requirements:
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["on-demand"]
      - key: kubernetes.io/arch
        operator: In
        values: ["amd64", "arm64"]
      - key: karpenter.k8s.aws/instance-category
        operator: In
        values: ["c", "m", "r"]
      - key: karpenter.k8s.aws/instance-size
        operator: In
        values: ["large", "xlarge", "2xlarge", "4xlarge"]
      kubelet:
        maxPods: 110
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 60s
    budgets:
    - maxUnavailable: "10%"
  limits:
    cpu: "200"
    memory: "800Gi"
  # Lower weight: on-demand pool used only when spot pool cannot satisfy requirements
  weight: 10
```

### NodePool for Graviton (ARM) Workloads

```yaml
# nodepool-graviton.yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: graviton-spot
spec:
  template:
    metadata:
      labels:
        node-pool: graviton-spot
        kubernetes.io/arch: arm64
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: general-purpose
      requirements:
      # ONLY Graviton (ARM) instances
      - key: kubernetes.io/arch
        operator: In
        values: ["arm64"]
      - key: karpenter.sh/capacity-type
        operator: In
        values: ["spot", "on-demand"]
      # c7g, m7g, r7g families — Graviton3
      - key: karpenter.k8s.aws/instance-family
        operator: In
        values: ["c7g", "m7g", "r7g", "c6g", "m6g", "r6g"]
      taints:
      # Taint so only arm64-compatible pods schedule here
      - key: kubernetes.io/arch
        value: arm64
        effect: NoSchedule
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
  limits:
    cpu: "300"
    memory: "1200Gi"
  weight: 90
```

## Spot Instance Interruption Handling

Spot instances receive a 2-minute interruption notice. Proper handling prevents application disruption.

### Pod Configuration for Spot Tolerance

```yaml
# deployment-spot-tolerant.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-worker
  namespace: commerce
spec:
  replicas: 10
  selector:
    matchLabels:
      app: order-worker
  template:
    metadata:
      labels:
        app: order-worker
    spec:
      # Tolerate the spot interruption taint (Karpenter adds this on termination notice)
      tolerations:
      - key: karpenter.sh/interruption
        operator: Exists
        effect: NoSchedule

      # Prefer spot nodes
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 80
            preference:
              matchExpressions:
              - key: karpenter.sh/capacity-type
                operator: In
                values: ["spot"]

      # Generous termination grace period: allow in-flight work to complete
      # Must be less than 2 minutes (spot interruption notice window)
      terminationGracePeriodSeconds: 90

      containers:
      - name: order-worker
        image: registry.example.com/order-worker:v2.0.0
        lifecycle:
          preStop:
            exec:
              # Signal the worker to stop accepting new work and drain the queue
              command: ["/app/graceful-shutdown", "--timeout=80s"]
        resources:
          requests:
            cpu: "2"
            memory: 4Gi
          limits:
            cpu: "4"
            memory: 8Gi
```

### PodDisruptionBudget for Spot Workloads

```yaml
# pdb-order-worker.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: order-worker-pdb
  namespace: commerce
spec:
  # During Karpenter consolidation or spot interruption,
  # at least 70% of replicas must remain available.
  # For 10 replicas: at least 7 must be running.
  minAvailable: "70%"
  selector:
    matchLabels:
      app: order-worker
```

## KEDA: Scale-to-Zero for Batch Workloads

KEDA (Kubernetes Event-Driven Autoscaling) scales deployments to zero when no work is available and back to the desired replica count when events arrive. This is critical cost control for overnight batch jobs, queue consumers, and webhook processors.

### Installing KEDA

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm upgrade --install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --version 2.14.0 \
  --set prometheus.metricServer.enabled=true \
  --set prometheus.operator.enabled=true
```

### ScaledObject for SQS Queue Consumer

```yaml
# scaledobject-order-consumer.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-consumer-scaledobject
  namespace: commerce
spec:
  scaleTargetRef:
    name: order-consumer
    kind: Deployment

  # Scale down to 0 replicas when queue is empty
  minReplicaCount: 0
  maxReplicaCount: 50

  # Wait 5 minutes of idle before scaling to zero
  # This prevents thrashing for bursty workloads
  cooldownPeriod: 300

  # Scale from 0 to 1 replica when a message arrives (scale-up trigger)
  activationThreshold: 1

  # Check queue depth every 30 seconds
  pollingInterval: 30

  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      # Reference to TriggerAuthentication with AWS credentials (via IRSA)
      name: keda-aws-credentials
    metadata:
      # SQS queue URL (IRSA handles authentication — no hardcoded credentials)
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/order-processing
      queueLength: "10"       # Target: 10 messages per replica
      awsRegion: us-east-1
      # Use visible + not-visible messages for accurate queue depth
      scaleOnInFlight: "true"
---
# TriggerAuthentication using IRSA (IAM Roles for Service Accounts)
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: keda-aws-credentials
  namespace: commerce
spec:
  podIdentity:
    # KEDA uses the pod's IRSA annotations for AWS authentication
    # No credentials stored in Kubernetes secrets
    provider: aws
```

### ScaledJob for Overnight Batch Processing

```yaml
# scaledjob-report-generator.yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: report-generator
  namespace: data-platform
spec:
  jobTargetRef:
    template:
      spec:
        containers:
        - name: report-generator
          image: registry.example.com/report-generator:v1.0.0
          resources:
            requests:
              cpu: "4"
              memory: 8Gi
          # Graviton preference for cost optimization on CPU-intensive batch work
          env:
          - name: REPORT_DATE
            value: "$(date -u +%Y-%m-%d)"
        # Batch jobs can tolerate spot interruption: use spot exclusively
        tolerations:
        - key: karpenter.sh/capacity-type
          value: spot
          operator: Equal
          effect: NoSchedule
        nodeSelector:
          karpenter.sh/capacity-type: spot
        restartPolicy: OnFailure

  pollingInterval: 60
  # Remove completed jobs after 1 hour
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  maxReplicaCount: 20

  triggers:
  - type: aws-sqs-queue
    authenticationRef:
      name: keda-aws-credentials
    metadata:
      queueURL: https://sqs.us-east-1.amazonaws.com/123456789012/report-requests
      queueLength: "1"  # One job per message
      awsRegion: us-east-1
```

## Right-Sizing with VPA

The Vertical Pod Autoscaler recommends and optionally applies right-sized resource requests based on historical usage.

```yaml
# vpa-order-service.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: order-service-vpa
  namespace: commerce
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service

  updatePolicy:
    # "Auto": automatically apply recommendations (requires pod restart)
    # "Recreate": only apply when pod is recreated
    # "Initial": only apply to new pods, not running ones
    # "Off": only generate recommendations, do not apply
    updateMode: "Off"   # Start in "Off" mode to observe recommendations first

  resourcePolicy:
    containerPolicies:
    - containerName: order-service
      # VPA recommendation range: prevent VPA from recommending too small or too large
      minAllowed:
        cpu: 100m
        memory: 256Mi
      maxAllowed:
        cpu: "8"
        memory: 16Gi
      # controlledResources: which resources VPA manages
      controlledResources: ["cpu", "memory"]
      # controlledValues: VPA adjusts requests only, leaving limits unchanged
      # "RequestsAndLimits" sets both; "RequestsOnly" sets only requests
      controlledValues: RequestsOnly
```

### Reading VPA Recommendations

```bash
# View VPA recommendations without applying them
kubectl describe vpa order-service-vpa -n commerce

# Sample output:
# Recommendation:
#   Container Recommendations:
#     Container Name: order-service
#     Lower Bound:
#       Cpu:     200m
#       Memory:  512Mi
#     Target:
#       Cpu:     800m       # Recommended request
#       Memory:  1.5Gi      # Recommended request
#     Uncapped Target:
#       Cpu:     800m
#       Memory:  1.5Gi
#     Upper Bound:
#       Cpu:     2
#       Memory:  4Gi

# Compare current requests against VPA recommendations
kubectl get vpa order-service-vpa -n commerce \
  -o jsonpath='{.status.recommendation.containerRecommendations[0].target}'
```

## Savings Plans and Reserved Instances

Karpenter and KEDA handle variable workloads efficiently on spot instances, but the baseline steady-state load benefits from committed pricing.

```bash
# Analyze EC2 usage patterns for Savings Plan recommendations
aws ce get-savings-plans-purchase-recommendation \
  --savings-plans-type COMPUTE_SP \
  --term-in-years ONE_YEAR \
  --payment-option NO_UPFRONT \
  --lookback-period-in-days THIRTY_DAYS \
  --query 'SavingsPlansPurchaseRecommendation.SavingsPlansPurchaseRecommendationDetails' \
  --output table

# View current Savings Plans utilization
aws ce get-savings-plans-utilization \
  --time-period Start="$(date -u -d '30 days ago' +%Y-%m-%d)",End="$(date -u +%Y-%m-%d)" \
  --query 'Total'

# Compute Savings Plans cover all EC2 instance types and sizes across all regions.
# They provide ~17-66% discount over on-demand depending on term and payment.
# Recommended approach:
# 1. Use Karpenter spot for ~70% of workload
# 2. Cover baseline ~30% with 1-year Compute Savings Plans (No Upfront)
# 3. Avoid instance-specific reservations — Karpenter changes instance types frequently
```

## Cost Monitoring and Alerting

```yaml
# kubecost-values.yaml — Kubecost configuration for EKS cost monitoring
global:
  prometheus:
    fqdn: http://prometheus-operated.monitoring.svc.cluster.local:9090
    enabled: false  # Use existing Prometheus

kubecostProductConfigs:
  clusterName: production-cluster
  currencyCode: USD
  # Share cluster costs across teams by namespace label
  labelMappingConfigs:
    enabled: true
    owner_label: team
    team_label: team
    department_label: cost-center

# AWS integration for accurate spot pricing
awsSpotDataFeed:
  enabled: true
  bucketName: cost-optimization-spot-feed
  region: us-east-1

# Alert when namespace cost exceeds $500/day
alertConfigs:
  alerts:
  - type: budget
    threshold: 500
    window: daily
    aggregation: namespace
    filter: "commerce"
    ownerContact: "commerce-team@example.com"
```

### Cost Attribution Script

```bash
#!/usr/bin/env bash
# eks-cost-report.sh — generate daily cost breakdown by namespace

set -euo pipefail

CLUSTER="${1:-production-cluster}"
DATE="${2:-$(date -u -d '1 day ago' +%Y-%m-%d)}"

echo "=== EKS Cost Report: ${CLUSTER} | ${DATE} ==="

# Query Kubecost API for namespace-level costs
KUBECOST_URL="http://kubecost.monitoring.svc.cluster.local:9090"

curl -sG "${KUBECOST_URL}/model/allocation" \
  --data-urlencode "window=${DATE}" \
  --data-urlencode "aggregate=namespace" \
  --data-urlencode "step=1d" \
  --data-urlencode "accumulate=true" \
  | jq -r '
    .data[0]
    | to_entries
    | sort_by(-.value.totalCost)
    | .[]
    | [.key, (.value.totalCost | . * 100 | round / 100 | tostring),
       (.value.cpuCost | . * 100 | round / 100 | tostring),
       (.value.ramCost | . * 100 | round / 100 | tostring)]
    | @tsv
  ' | column -t -s $'\t' -N "Namespace,Total($),CPU($),Memory($)"
```

A well-tuned EKS cost strategy combining Karpenter NodePools with spot/on-demand mixing, Graviton instances for ARM-compatible workloads, KEDA scale-to-zero for event-driven consumers, VPA right-sizing, and Compute Savings Plans for baseline capacity can reduce EKS compute costs by 50–70% compared to default on-demand configurations without sacrificing reliability or performance.
