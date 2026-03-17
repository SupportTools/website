---
title: "Kubernetes Cluster Autoscaler v1.30+: Expander Strategies, Scale-Down Simulation, AWS/GCP/Azure Cloud Providers"
date: 2032-01-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Autoscaler", "AWS", "GCP", "Azure", "Auto Scaling", "Node Groups", "FinOps"]
categories:
- Kubernetes
- Cloud
- FinOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep-dive into Kubernetes Cluster Autoscaler v1.30+: configuring expander strategies for cost-optimal node provisioning, understanding scale-down simulation and safe eviction policies, multi-cloud provider configuration for AWS, GCP, and Azure, and production tuning for large clusters."
more_link: "yes"
url: "/kubernetes-cluster-autoscaler-v130-expander-strategies-cloud-providers/"
---

The Kubernetes Cluster Autoscaler (CA) is the engine that makes cloud-native infrastructure economically viable. Without it, teams either over-provision nodes to handle peak load (wasting money) or under-provision and experience scheduling failures. CA's scale-up and scale-down algorithms are sophisticated, but its default configuration is tuned for correctness and caution rather than cost efficiency. This guide covers CA v1.30+ configuration in depth: expander strategy selection and composition, the scale-down simulation algorithm, per-node-group policies, cloud provider integration for AWS ASGs, GCP MIGs, and Azure VMSSs, and production tuning for clusters with hundreds of nodes.

<!--more-->

# Kubernetes Cluster Autoscaler v1.30+: Production Guide

## Section 1: Cluster Autoscaler Architecture

CA runs as a Deployment in the cluster and operates on a polling loop:

1. **Scale-up loop** (every 10s by default): Finds unschedulable pods, determines which node group(s) can accommodate them, selects one using the configured expander, and requests a node increase from the cloud provider API.

2. **Scale-down loop** (every 10s): Identifies underutilized nodes (CPU + memory utilization below thresholds), simulates pod evacuation, and requests node termination if safe.

### Key Data Structures

```
Node Groups (ASG, MIG, VMSS)
├── Node Pool A: [node-1, node-2, node-3]  (min=1, max=10, desired=3)
├── Node Pool B: [node-4]                   (min=0, max=5, desired=1)
└── Node Pool C (spot): []                  (min=0, max=20, desired=0)

Pod Queue (unschedulable)
├── Pod X: needs 4 CPU, 8Gi RAM
├── Pod Y: needs 1 CPU, 2Gi RAM
└── Pod Z: needs 2 CPU, 4Gi RAM, spot tolerations
```

## Section 2: Installation

### Helm Installation

```bash
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update

# Install for AWS EKS
helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  --namespace kube-system \
  --version 9.37.0 \
  --set autoDiscovery.clusterName="prod-us-east-1" \
  --set awsRegion="us-east-1" \
  --set cloudProvider="aws" \
  --set rbac.serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::<account-id>:role/ClusterAutoscalerRole" \
  --set extraArgs.balance-similar-node-groups=true \
  --set extraArgs.skip-nodes-with-system-pods=false \
  --set extraArgs.expander="price\,least-waste" \
  --set extraArgs.scale-down-enabled=true \
  --set extraArgs.scale-down-delay-after-add="5m" \
  --set extraArgs.scale-down-unneeded-time="10m" \
  --set resources.requests.cpu=200m \
  --set resources.requests.memory=512Mi \
  --set resources.limits.cpu=1000m \
  --set resources.limits.memory=1Gi \
  --wait
```

### IRSA (IAM Roles for Service Accounts) on EKS

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
        "autoscaling:DescribeTags",
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

Trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/oidc.eks.<region>.amazonaws.com/id/<oidc-id>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.<region>.amazonaws.com/id/<oidc-id>:sub": "system:serviceaccount:kube-system:cluster-autoscaler"
        }
      }
    }
  ]
}
```

## Section 3: Node Group Configuration

### AWS Auto Scaling Group Tags

CA discovers ASGs via tags:

```bash
# Required tags for auto-discovery
aws autoscaling create-or-update-tags \
  --tags \
    "ResourceId=<asg-name>,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/enabled,Value=true,PropagateAtLaunch=false" \
    "ResourceId=<asg-name>,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/<cluster-name>,Value=owned,PropagateAtLaunch=false"

# Optional: specify GPU resources if the ASG has GPU nodes
aws autoscaling create-or-update-tags \
  --tags \
    "ResourceId=<gpu-asg-name>,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/node-template/resources/nvidia.com/gpu,Value=1,PropagateAtLaunch=false"
```

### Explicit Node Group Configuration (Alternative to Auto-Discovery)

```yaml
# cluster-autoscaler-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-status
  namespace: kube-system
data:
  nodes: |
    - name: prod-general-purpose
      min: 2
      max: 20
    - name: prod-compute-optimized
      min: 0
      max: 10
    - name: prod-spot-mixed
      min: 0
      max: 50
```

With explicit node group configuration in CA deployment args:

```yaml
# In the CA deployment args
- --nodes=2:20:prod-general-purpose
- --nodes=0:10:prod-compute-optimized
- --nodes=0:50:prod-spot-mixed
```

## Section 4: Expander Strategies

Expanders determine which node group to scale up when multiple groups could accommodate the pending pods.

### Available Expanders

| Expander | Algorithm | Best For |
|----------|-----------|----------|
| `random` | Random selection | Testing, uniform node groups |
| `most-pods` | Maximize pods scheduled per scale-up | Batch workloads |
| `least-waste` | Minimize CPU/memory waste | Cost efficiency |
| `price` | Minimize cost using cloud provider pricing | FinOps-focused |
| `priority` | User-defined priority weights per node group | Spot/on-demand tiering |
| `grpc` | Custom external expander | Custom business logic |

### Composing Expanders (v1.30+)

CA v1.30 supports expander composition — the first expander filters, subsequent expanders break ties:

```bash
# Try to minimize cost first, break ties by least-waste
--expander="price,least-waste"

# Prioritize spot/preemptible, fall back to least-waste
--expander="priority,least-waste"

# Most pods first for batch, then random for tie-breaking
--expander="most-pods,random"
```

### Priority Expander Configuration

The priority expander uses a ConfigMap to assign numerical priorities to node groups (higher = preferred):

```yaml
# priority-expander-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |
    # Spot instance groups (highest priority — cheapest)
    100:
      - .*spot.*
      - .*preemptible.*
      - .*p3dn.*
    # Compute-optimized on-demand (medium priority)
    50:
      - .*compute-optimized.*
      - .*c5.*
      - .*c6i.*
    # General-purpose on-demand (low priority)
    10:
      - .*general.*
      - .*m5.*
      - .*m6i.*
    # GPU instances (very low priority — only for GPU jobs)
    5:
      - .*gpu.*
      - .*g4dn.*
      - .*p3.*
```

The priority expander selects the group with the highest priority score. If multiple groups have the same priority, the configured secondary expander breaks the tie.

### price Expander

The `price` expander queries the cloud provider's pricing API to select the cheapest option. Configure it with AWS pricing:

```yaml
# AWS pricing data (cost per core, per GB RAM — estimated)
# The price expander uses instance type labels set by kube-node-labels
# or cloud provider metadata

# Verify instance type labels are present on nodes
kubectl get nodes -o json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for node in data['items']:
    name = node['metadata']['name']
    labels = node['metadata']['labels']
    instance_type = labels.get('node.kubernetes.io/instance-type', 'unknown')
    region = labels.get('topology.kubernetes.io/region', 'unknown')
    zone = labels.get('topology.kubernetes.io/zone', 'unknown')
    capacity_type = labels.get('eks.amazonaws.com/capacityType', 'ON_DEMAND')
    print(f'{name}: {instance_type} {capacity_type} {region}/{zone}')
"
```

## Section 5: Scale-Down Algorithm Deep Dive

### The Scale-Down Simulation Process

CA's scale-down algorithm works as follows every 10 seconds:

1. **Identify candidates**: Find nodes where:
   - All pods can be moved to other nodes
   - No system pods (kube-system) that can't be evicted
   - Not recently added (scale-down-delay-after-add)
   - Utilization below threshold (CPU + memory)

2. **Simulate pod evacuation**: For each candidate node, check:
   - All pods have a place to go on remaining nodes
   - PodDisruptionBudgets are not violated
   - No pods with local storage
   - No pods annotated `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`

3. **Select candidates**: Pick up to `max-empty-bulk-delete` (default 10) nodes if empty, or 1 node if still used.

4. **Request termination**: Call cloud provider API to remove the node from the group.

### Scale-Down Configuration Parameters

```yaml
# cluster-autoscaler deployment extraArgs
extraArgs:
  # Time a node must be underutilized before scale-down consideration
  scale-down-unneeded-time: "10m"

  # Time after scale-up before scale-down is considered
  scale-down-delay-after-add: "5m"

  # Time after a failed scale-down before retrying
  scale-down-delay-after-failure: "3m"

  # Time after scale-down before next scale-down
  scale-down-delay-after-delete: "0s"  # Can set to 0 for aggressive scale-down

  # Utilization threshold — nodes below this are candidates
  scale-down-utilization-threshold: "0.5"  # 50%

  # GPU utilization threshold
  scale-down-gpu-utilization-threshold: "0.5"

  # Time for unready nodes before deletion
  scale-down-unready-time: "20m"

  # Maximum nodes to delete simultaneously (empty nodes)
  max-empty-bulk-delete: "10"

  # Maximum graceful termination seconds per pod
  max-graceful-termination-sec: "600"

  # Consider pods that can't be evicted (system pods) when scaling down
  skip-nodes-with-system-pods: "true"

  # Consider pods with local storage
  skip-nodes-with-local-storage: "false"

  # Enable balance-similar-node-groups for even distribution
  balance-similar-node-groups: "true"
```

### Controlling Scale-Down for Individual Pods

```yaml
# Prevent a pod from being evicted during scale-down
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"

# Allow eviction even of pods that would normally block scale-down
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
```

### Node Annotations for Scale-Down Control

```bash
# Prevent a specific node from being scaled down
kubectl annotate node <node-name> \
  cluster-autoscaler.kubernetes.io/scale-down-disabled=true

# Re-enable scale-down for a node
kubectl annotate node <node-name> \
  cluster-autoscaler.kubernetes.io/scale-down-disabled-

# Set node eligibility time
kubectl annotate node <node-name> \
  "cluster-autoscaler.kubernetes.io/scale-down-unneeded-time=$(date -d '10 minutes ago' -Iseconds)"
```

### PodDisruptionBudgets for Safe Eviction

CA respects PDBs during scale-down. Ensure all stateful workloads have PDBs:

```yaml
# pdb-for-stateful-service.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: orders-api-pdb
  namespace: production
spec:
  minAvailable: 2  # Or use maxUnavailable: 1
  selector:
    matchLabels:
      app: orders-api
---
# For single-replica services, PDB prevents scale-down entirely
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: database-pdb
  namespace: production
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: postgres-primary
```

## Section 6: AWS EKS Managed Node Group Integration

### EKS Managed Node Group with Mixed Instance Policy

```yaml
# eks-nodegroup-mixed.yaml (eksctl config)
managedNodeGroups:
  - name: general-purpose
    instanceTypes:
      - m6i.large
      - m6a.large
      - m5.large
      - m5a.large
    minSize: 2
    maxSize: 20
    desiredCapacity: 4
    spot: false
    labels:
      node-type: general
      workload: application
    tags:
      k8s.io/cluster-autoscaler/enabled: "true"
      k8s.io/cluster-autoscaler/prod-us-east-1: "owned"
    updateConfig:
      maxUnavailablePercentage: 25

  - name: spot-general
    instanceTypes:
      - m6i.xlarge
      - m6a.xlarge
      - m5.xlarge
      - m5a.xlarge
      - m5n.xlarge
    minSize: 0
    maxSize: 50
    spot: true
    labels:
      node-type: spot
      eks.amazonaws.com/capacityType: SPOT
    taints:
      - key: spot
        value: "true"
        effect: NoSchedule
    tags:
      k8s.io/cluster-autoscaler/enabled: "true"
      k8s.io/cluster-autoscaler/prod-us-east-1: "owned"
```

### Karpenter vs. Cluster Autoscaler

Note: AWS now recommends Karpenter over Cluster Autoscaler for EKS. CA remains the choice for non-EKS clusters or multi-cloud environments:

```yaml
# Karpenter NodePool (for comparison)
apiVersion: karpenter.sh/v1beta1
kind: NodePool
metadata:
  name: general-purpose
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["m", "c", "r"]
        - key: karpenter.k8s.aws/instance-generation
          operator: Gt
          values: ["4"]
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1beta1
        kind: EC2NodeClass
        name: default
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
  limits:
    cpu: 1000
    memory: 4000Gi
```

## Section 7: GCP GKE Node Pool Configuration

### GKE Node Pool with Autoscaling

```bash
# Create an autoscaled node pool in GKE
gcloud container node-pools create general-purpose \
  --cluster=prod-cluster \
  --region=us-central1 \
  --machine-type=n2-standard-4 \
  --num-nodes=3 \
  --enable-autoscaling \
  --min-nodes=1 \
  --max-nodes=20 \
  --disk-type=pd-ssd \
  --disk-size=100GB \
  --node-labels=node-type=general \
  --scopes=cloud-platform

# Create a spot node pool
gcloud container node-pools create spot-pool \
  --cluster=prod-cluster \
  --region=us-central1 \
  --machine-type=n2-standard-4 \
  --spot \
  --num-nodes=0 \
  --enable-autoscaling \
  --min-nodes=0 \
  --max-nodes=50 \
  --node-taints=spot=true:NoSchedule \
  --node-labels=node-type=spot,cloud.google.com/gke-spot=true
```

### GKE Cluster Autoscaler Configuration

For GKE, CA is managed by GKE itself. The CA configuration is set via cluster-level flags:

```bash
# Enable autoscaling with expander configuration
gcloud container clusters update prod-cluster \
  --region=us-central1 \
  --enable-autoscaling \
  --autoscaling-profile=BALANCED

# For Optimize Utilization profile (more aggressive scale-down)
gcloud container clusters update prod-cluster \
  --region=us-central1 \
  --autoscaling-profile=OPTIMIZE_UTILIZATION

# Available profiles:
# BALANCED (default) — conservative
# OPTIMIZE_UTILIZATION — aggressive scale-down
```

For self-managed CA on GKE:

```yaml
# cluster-autoscaler-gke.yaml
extraArgs:
  cloud-provider: gce
  nodes: "1:20:projects/<project-id>/zones/us-central1-a/instanceGroups/gke-prod-cluster-general-pool"
  nodes: "0:50:projects/<project-id>/zones/us-central1-a/instanceGroups/gke-prod-cluster-spot-pool"
  expander: "price,least-waste"
```

## Section 8: Azure AKS Node Pool Configuration

### AKS Node Pool with Autoscaling

```bash
# Create a cluster with autoscaling enabled
az aks create \
  --resource-group prod-rg \
  --name prod-cluster \
  --node-count 3 \
  --enable-cluster-autoscaler \
  --min-count 1 \
  --max-count 20 \
  --node-vm-size Standard_D4s_v3

# Add a spot node pool
az aks nodepool add \
  --resource-group prod-rg \
  --cluster-name prod-cluster \
  --name spotpool \
  --enable-cluster-autoscaler \
  --min-count 0 \
  --max-count 50 \
  --priority Spot \
  --eviction-policy Delete \
  --spot-max-price -1 \  # Pay current spot price
  --node-vm-size Standard_D4s_v3 \
  --node-taints "kubernetes.azure.com/scalesetpriority=spot:NoSchedule" \
  --node-labels "kubernetes.azure.com/scalesetpriority=spot"

# Update autoscaler settings
az aks update \
  --resource-group prod-rg \
  --cluster-name prod-cluster \
  --cluster-autoscaler-profile \
    scale-down-delay-after-add=5m \
    scale-down-unneeded-time=10m \
    scale-down-utilization-threshold=0.5 \
    balance-similar-node-groups=true \
    expander=least-waste \
    max-graceful-termination-sec=600
```

### Azure-Specific CA Configuration

```yaml
# For self-managed CA on AKS with VMSS
extraArgs:
  cloud-provider: azure
  azure-use-instance-metadata: "true"
  azure-subscription-id: "<subscription-id>"
  azure-tenant-id: "<tenant-id>"
  azure-client-id: "<client-id>"
  azure-resource-group: "prod-rg"
  azure-cluster-name: "prod-cluster"
  node-resource-group: "MC_prod-rg_prod-cluster_eastus"
  expander: "price,least-waste"
```

## Section 9: Scale-Up Optimization

### Multiple Scale-Up Events

CA can process multiple unschedulable pods in a single scale-up event. Control the batch behavior:

```yaml
extraArgs:
  # Maximum nodes to add in a single scale-up event
  max-nodes-total: 1000

  # Scale-up only within the current zone/region
  balance-similar-node-groups: "true"

  # New node readiness timeout
  max-node-provision-time: "15m"

  # Retry scaling if it fails
  max-scale-up-empty-provision-time: "5m"
```

### Scaling for Spot/Preemptible Tolerations

```yaml
# Allow workloads to tolerate spot nodes while maintaining fallback
# workload-tolerations.yaml
spec:
  tolerations:
    - key: "spot"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: eks.amazonaws.com/capacityType
                operator: In
                values: ["SPOT"]
        - weight: 1
          preference:
            matchExpressions:
              - key: eks.amazonaws.com/capacityType
                operator: In
                values: ["ON_DEMAND"]
```

## Section 10: Monitoring and Troubleshooting

### CA Status and Logs

```bash
# Check CA status in real-time
kubectl -n kube-system get configmap cluster-autoscaler-status -o yaml

# Parse the status
kubectl -n kube-system get configmap cluster-autoscaler-status \
  -o jsonpath='{.data.status}' | \
  python3 -c "
import sys
lines = sys.stdin.read().split('\n')
for line in lines:
    if any(kw in line for kw in ['ScaleUp', 'ScaleDown', 'Error', 'Warn', 'NodeGroup']):
        print(line)
"

# Follow CA logs
kubectl -n kube-system logs -l app=cluster-autoscaler -f --tail=100

# Filter for scale events
kubectl -n kube-system logs -l app=cluster-autoscaler --tail=1000 | \
  grep -E "scale_up|scale_down|ScaleUp|ScaleDown|Expanding|Decreasing" | tail -30

# Check for errors
kubectl -n kube-system logs -l app=cluster-autoscaler --tail=1000 | \
  grep -i "error\|failed\|cannot" | tail -20
```

### Understanding Scale-Up Failures

```bash
# Check why pods are unschedulable
kubectl get events --field-selector reason=FailedScheduling -A | tail -20

# Check pending pod conditions
kubectl describe pod <pending-pod-name> -n <namespace> | \
  grep -A20 "Events:"

# Common reasons CA won't scale up:
# 1. Pod requests exceed max node size
# 2. MaxNodesTotal reached
# 3. All node groups at max size
# 4. Node group labels don't match pod nodeSelector
# 5. Pod has unsatisfiable constraints (topology.kubernetes.io/zone)

# Simulate scheduling manually
kubectl explain pod --api-version=v1 spec.nodeName
kubectl get nodes -o wide
```

### Prometheus Metrics

```yaml
# cluster-autoscaler exposes metrics on port 8085
# Add ServiceMonitor:
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cluster-autoscaler
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  namespaceSelector:
    matchNames:
      - kube-system
  selector:
    matchLabels:
      app: cluster-autoscaler
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

Key metrics:

```
# Scale events
cluster_autoscaler_scaled_up_nodes_total
cluster_autoscaler_scaled_down_nodes_total
cluster_autoscaler_failed_scale_ups_total

# Queue depth
cluster_autoscaler_unschedulable_pods_count
cluster_autoscaler_pending_pods_count

# Node group sizes
cluster_autoscaler_nodes_count
cluster_autoscaler_node_groups_count

# Latency
cluster_autoscaler_function_duration_seconds
```

### PrometheusRule Alerts

```yaml
# cluster-autoscaler-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cluster-autoscaler-alerts
  namespace: monitoring
spec:
  groups:
    - name: cluster.autoscaler
      rules:
        - alert: ClusterAutoscalerScaleUpFailed
          expr: |
            increase(cluster_autoscaler_failed_scale_ups_total[30m]) > 3
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Cluster Autoscaler failed to scale up"
            description: "{{ $value }} scale-up failures in the last 30 minutes. Check cloud provider quotas."

        - alert: ClusterAutoscalerUnschedulablePodsHigh
          expr: |
            cluster_autoscaler_unschedulable_pods_count > 20
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "High number of unschedulable pods"
            description: "{{ $value }} pods cannot be scheduled. Check node group max sizes and resource requests."

        - alert: ClusterAutoscalerNotRunning
          expr: |
            absent(cluster_autoscaler_nodes_count) == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Cluster Autoscaler is not running or not reporting metrics"

        - alert: ClusterMaxNodeCountApproaching
          expr: |
            sum(cluster_autoscaler_nodes_count) / sum(cluster_autoscaler_node_groups_count) > 0.85
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Cluster is approaching max node count"
            description: "Node groups are at {{ $value | humanizePercentage }} of their maximum capacity."
```

### Debugging Scale-Down Blocking

```bash
#!/usr/bin/env bash
# debug-scale-down.sh — Find why a node won't scale down
NODE=${1:-$(kubectl get nodes --no-headers | awk '{print $1}' | head -1)}

echo "=== Scale-Down Analysis for Node: ${NODE} ==="

echo ""
echo "--- Node Annotations ---"
kubectl get node "${NODE}" -o jsonpath='{.metadata.annotations}' | \
  python3 -m json.tool | grep -E "autoscaler|taint|disable"

echo ""
echo "--- Node Utilization ---"
kubectl top node "${NODE}" 2>/dev/null || echo "metrics-server not available"

echo ""
echo "--- Pods on Node ---"
kubectl get pods -A --field-selector spec.nodeName="${NODE}" \
  -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,OWNER:.metadata.ownerReferences[0].kind'

echo ""
echo "--- Pods Blocking Scale-Down ---"
kubectl get pods -A --field-selector spec.nodeName="${NODE}" -o json | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    anns = item['metadata'].get('annotations', {})

    # Check for safe-to-evict: false
    if anns.get('cluster-autoscaler.kubernetes.io/safe-to-evict') == 'false':
        print(f'BLOCKS (safe-to-evict=false): {ns}/{name}')
        continue

    # Check for local storage (emptyDir)
    for vol in item['spec'].get('volumes', []):
        if 'emptyDir' in vol:
            print(f'BLOCKS (emptyDir volume): {ns}/{name}')
            break

    # Check if in kube-system
    if ns == 'kube-system':
        owners = item['metadata'].get('ownerReferences', [])
        if not owners or owners[0].get('kind') == 'DaemonSet':
            print(f'BLOCKS (system pod/daemonset): {ns}/{name}')
"

echo ""
echo "--- PodDisruptionBudgets ---"
kubectl get pdb -A -o json | python3 -c "
import sys, json
data = json.load(sys.stdin)
for pdb in data['items']:
    disrupted = pdb['status'].get('disruptionsAllowed', 0)
    if disrupted == 0:
        print(f'PDB BLOCKING: {pdb[\"metadata\"][\"namespace\"]}/{pdb[\"metadata\"][\"name\"]} (0 disruptions allowed)')
"
```

Cluster Autoscaler v1.30+ with properly configured expander strategies, PDB-aware scale-down, and comprehensive Prometheus alerting transforms your cluster from a fixed-cost infrastructure into a cost-efficient, demand-responsive compute fabric. The key insight is that CA's conservative defaults protect correctness at the cost of efficiency — tune scale-down thresholds and expander composition deliberately, and monitor the results with the provided Prometheus rules.
