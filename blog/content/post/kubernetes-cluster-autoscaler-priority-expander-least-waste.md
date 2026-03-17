---
title: "Kubernetes Cluster Autoscaler: Priority Expander and Least Waste Algorithms"
date: 2029-02-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Cluster Autoscaler", "Autoscaling", "Cost Optimization", "Node Groups", "FinOps"]
categories:
- Kubernetes
- Cost Optimization
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into Kubernetes Cluster Autoscaler expander algorithms, covering Priority Expander configuration for instance type preferences, Least Waste for cost optimization, and production tuning strategies for multi-node-group clusters."
more_link: "yes"
url: "/kubernetes-cluster-autoscaler-priority-expander-least-waste/"
---

The Kubernetes Cluster Autoscaler (CA) adds nodes to a cluster when pods are unschedulable and removes underutilized nodes to reduce cost. When multiple node groups can satisfy a pending pod's requirements, the CA uses an *expander* algorithm to decide which node group to scale. Choosing the wrong expander leads to suboptimal instance type selection, higher infrastructure costs, or workload placement failures.

This guide examines the two most operationally significant expanders—Priority and Least Waste—along with the grpc expander for custom logic, covering configuration syntax, decision logic, interaction with priorities, and production tuning to achieve predictable scale-out behavior in multi-node-group clusters.

<!--more-->

## Cluster Autoscaler Architecture and Decision Flow

Before examining expanders, it is important to understand when the CA invokes them.

```
Pod enters Pending state
        │
        ▼
CA simulation: can any existing node accommodate the pod?
  ├─ Yes → no action needed (scheduler will place it)
  └─ No → identify candidate node groups
               │
               ▼
     Filter: which node groups can be expanded?
     (templates, min/max limits, scale-up not in progress)
               │
               ▼
     EXPANDER: which node group to scale up?
     ┌──────────────┬──────────────────┬────────────┐
     │  random      │  least-waste     │  priority  │
     │  most-pods   │  price (cloud)   │  grpc      │
     └──────────────┴──────────────────┴────────────┘
               │
               ▼
     Scale chosen node group by 1 node
               │
               ▼
     Wait for node to become Ready (--max-node-provision-time)
               │
               ▼
     Re-evaluate unschedulable pods
```

The CA evaluates all node groups each cycle. The expander selects among candidates that passed all filter checks.

## Available Expanders

| Expander | Description | Best For |
|----------|-------------|---------|
| `random` | Picks randomly among valid candidates | Stateless balanced clusters |
| `most-pods` | Prefers node group that can schedule the most pending pods | Batch workloads with many similar pods |
| `least-waste` | Minimizes CPU and memory waste per node | Cost-sensitive clusters with mixed pod sizes |
| `price` | Prefers cheapest node (cloud-provider specific) | Pure cost optimization (AWS/GCP) |
| `priority` | Uses a user-defined ConfigMap to rank node groups | Instance type preferences, reserved vs spot |
| `grpc` | Delegates to an external gRPC service | Custom logic, multi-dimensional scoring |

Multiple expanders can be chained with commas: `--expander=priority,least-waste` means: use priority first; if it returns multiple equally-ranked candidates, use least-waste to break the tie.

## Least Waste Expander

Least Waste scores each candidate node group by computing how much CPU and memory would be wasted after placing the pending pod on a new node of that type.

### Waste Calculation

```
waste_cpu  = node_cpu  - pod_requested_cpu  - existing_pod_cpu_on_node
waste_mem  = node_mem  - pod_requested_mem  - existing_pod_mem_on_node

final_score = α × (waste_cpu / node_cpu) + (1-α) × (waste_mem / node_mem)
```

The CA uses equal weighting (α=0.5) by default and selects the node group with the lowest score.

### Example: Pod Requires 2 CPU / 4Gi

| Node Group | Node Size | Waste CPU | Waste Mem | Score |
|------------|-----------|-----------|-----------|-------|
| m5.large   | 2C/8Gi   | 0/2=0%    | 4/8=50%   | 25% |
| m5.xlarge  | 4C/16Gi  | 2/4=50%   | 12/16=75% | 62% |
| m5.2xlarge | 8C/32Gi  | 6/8=75%   | 28/32=87% | 81% |

Least Waste would choose m5.large, which wastes the fewest resources for this pod.

### Enabling Least Waste

```yaml
# cluster-autoscaler Helm values (cluster-autoscaler chart)
autoDiscovery:
  clusterName: prod-us-east-1
  enabled: true

extraArgs:
  expander: least-waste
  scale-down-enabled: "true"
  scale-down-delay-after-add: 10m
  scale-down-unneeded-time: 10m
  scale-down-utilization-threshold: "0.5"
  max-node-provision-time: 15m
  scan-interval: 10s
  # Emit detailed scoring to logs at debug level
  v: "4"
```

## Priority Expander

The Priority Expander reads a ConfigMap containing a list of regular expression patterns, each assigned a numeric priority. Node groups are matched against these patterns from highest to lowest priority; the highest-ranked matching group wins.

### Priority ConfigMap Format

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |-
    # Highest priority: reserved instances (cheapest)
    100:
      - .*-reserved-.*
    # High priority: spot instances for batch jobs
    80:
      - .*-spot-batch-.*
    # Normal on-demand for general workloads
    50:
      - .*-ondemand-general-.*
    # GPU nodes for ML workloads
    70:
      - .*-gpu-a10g-.*
      - .*-gpu-a100-.*
    # Lowest priority: large on-demand (expensive)
    10:
      - .*-ondemand-xlarge-.*
      - .*-ondemand-2xlarge-.*
```

The ConfigMap name must be exactly `cluster-autoscaler-priority-expander` in the same namespace as the CA.

### Real-World Multi-Node-Group Priority Configuration

Consider a production cluster with these node groups:

```
eks-reserved-m5-large-xxxxxx       # Reserved instances, m5.large
eks-ondemand-m5-xlarge-xxxxxx      # On-demand, m5.xlarge
eks-spot-m5-large-xxxxxx           # Spot, m5.large
eks-spot-m5-xlarge-xxxxxx          # Spot, m5.xlarge
eks-gpu-g4dn-xlarge-xxxxxx         # GPU nodes for ML
eks-ondemand-c5-2xlarge-xxxxxx     # Compute-optimized on-demand
```

Priority configuration:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-priority-expander
  namespace: kube-system
data:
  priorities: |-
    # 1. Reserved instances — lowest cost, highest preference
    100:
      - ^eks-reserved-.*
    # 2. Spot instances — low cost, acceptable interruption risk
    75:
      - ^eks-spot-.*
    # 3. GPU nodes — only when GPU pods are pending (other pods won't match)
    90:
      - ^eks-gpu-.*
    # 4. Standard on-demand — fallback for general workloads
    50:
      - ^eks-ondemand-m5-.*
    # 5. Large compute on-demand — last resort
    20:
      - ^eks-ondemand-c5-.*
```

Note: the priority expander only evaluates node groups that *can* accommodate the pending pod. GPU node groups are only selected when the pending pod has `nvidia.com/gpu` resource requests, because other pods cannot be scheduled there.

### Cluster Autoscaler Deployment with Priority Expander

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
  labels:
    app: cluster-autoscaler
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cluster-autoscaler
  template:
    metadata:
      labels:
        app: cluster-autoscaler
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
    spec:
      serviceAccountName: cluster-autoscaler
      priorityClassName: system-cluster-critical
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: cluster-autoscaler
          image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.32.0
          command:
            - ./cluster-autoscaler
            - --v=4
            - --stderrthreshold=info
            - --cloud-provider=aws
            - --skip-nodes-with-local-storage=false
            - --expander=priority,least-waste
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/prod-us-east-1
            - --balance-similar-node-groups=true
            - --skip-nodes-with-system-pods=false
            - --scale-down-enabled=true
            - --scale-down-delay-after-add=10m
            - --scale-down-unneeded-time=10m
            - --scale-down-utilization-threshold=0.5
            - --max-node-provision-time=15m
            - --scan-interval=10s
            - --max-graceful-termination-sec=600
            - --aws-use-static-instance-list=false
          env:
            - name: AWS_REGION
              value: us-east-1
          resources:
            requests:
              cpu: 100m
              memory: 600Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          livenessProbe:
            httpGet:
              path: /health-check
              port: 8085
            initialDelaySeconds: 45
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health-check
              port: 8085
            initialDelaySeconds: 5
            periodSeconds: 5
```

## Scale-Down Tuning

Scale-down is the source of most CA-related incidents. Premature scale-down evicts pods; too conservative scale-down wastes money.

```yaml
# Key scale-down parameters and their effects:

# --scale-down-utilization-threshold=0.5
# A node is considered for scale-down if its requested CPU AND memory are
# both below 50% of allocatable. Increase to 0.6-0.7 for tighter packing.

# --scale-down-unneeded-time=10m
# How long a node must be under threshold before being removed.
# Increase to 15-20m for workloads with bursty patterns.

# --scale-down-delay-after-add=10m
# Do not evaluate scale-down for this long after any scale-up.
# Prevents thrashing: scale-up → workload completes → immediate scale-down → scale-up.

# --scale-down-delay-after-delete=0s
# How long to wait after a node delete before trying to delete another.

# --skip-nodes-with-system-pods=true
# Prevents deletion of nodes running DaemonSet pods outside kube-system.
# Set to false if you use many DaemonSets across all nodes.
```

## Pod Disruption Budgets for Safe Scale-Down

The CA respects PodDisruptionBudgets when evaluating node draining. Without PDBs, the CA can evict all pods from a node simultaneously.

```yaml
# Ensure at least 1 replica is always available during scale-down
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api-service-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-service
  minAvailable: 1
---
# For a 3-replica deployment: never evict more than 1 at a time
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  selector:
    matchLabels:
      app: payment-service
  maxUnavailable: 1
```

## Preventing Scale-Down of Specific Nodes

```yaml
# Annotation to prevent CA from removing a specific node
kubectl annotate node ip-10-0-1-50.ec2.internal \
  cluster-autoscaler.kubernetes.io/scale-down-disabled=true

# Pod annotation to prevent CA from evicting a pod
# (used for system-critical pods)
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"
```

## Node Group Balancing

When `--balance-similar-node-groups=true`, the CA distributes scale-up across node groups with the same instance type to spread across availability zones.

```bash
# Check node group balance
kubectl -n kube-system logs -l app=cluster-autoscaler \
  | grep "Balancing" | tail -20

# Typical log output:
# Balancing similar node groups: [eks-ondemand-m5-large-us-east-1a eks-ondemand-m5-large-us-east-1b]
# Scale up: setting group eks-ondemand-m5-large-us-east-1b size to 5
```

## Monitoring Cluster Autoscaler

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cluster-autoscaler-alerts
  namespace: kube-system
spec:
  groups:
    - name: cluster-autoscaler
      rules:
        - alert: ClusterAutoscalerUnschedulablePods
          expr: |
            cluster_autoscaler_unschedulable_pods_count > 0
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "Unschedulable pods persisting for >15m"
            description: "{{ $value }} pods are unschedulable. CA may be unable to expand."

        - alert: ClusterAutoscalerNodeGroupAtMaxSize
          expr: |
            cluster_autoscaler_nodes_count == cluster_autoscaler_max_nodes_count
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Node group at maximum capacity"

        - alert: ClusterAutoscalerScaleUpErrors
          expr: |
            rate(cluster_autoscaler_failed_scale_ups_total[15m]) > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Cluster Autoscaler scale-up failures"
            description: "Scale-up failures may indicate IAM, quota, or instance availability issues"

        - alert: ClusterAutoscalerInactivity
          expr: |
            time() - cluster_autoscaler_last_activity > 300
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Cluster Autoscaler has been inactive for >5 minutes"
```

## Debugging Scale-Up Failures

```bash
# Check CA status endpoint
kubectl -n kube-system get configmap cluster-autoscaler-status -o yaml

# Watch CA logs for decision reasoning
kubectl -n kube-system logs -l app=cluster-autoscaler -f \
  | grep -E "scale_up|expander|unschedulable|nodegroup"

# Check why a pod is unschedulable
kubectl describe pod <pending-pod> -n <namespace> | grep -A 10 "Events:"

# List node groups with current sizes
kubectl -n kube-system get configmap cluster-autoscaler-status -o jsonpath='{.data.status}' \
  | grep -E "Name:|Min:|Max:|Ready:"

# Simulate a scale-up decision (requires CA running with --expander-verbose)
# Look for log lines like:
# "Expanding node group eks-ondemand-m5-large: evaluated score 0.23 (priority=50, waste=cpu:0.0% mem:12.5%)"
```

## gRPC Expander for Custom Logic

When Priority and Least Waste are insufficient, the gRPC expander delegates to an external service.

```yaml
# Configure CA to use the gRPC expander
extraArgs:
  expander: grpc
  grpc-expander-url: "https://custom-expander.platform.svc.cluster.local:443"
  grpc-expander-cert: /etc/ssl/certs/expander.crt
```

The gRPC service implements the `expander.Expander` interface, receiving the list of candidate node groups and returning the selected one. This enables scoring based on spot pricing APIs, custom reserved capacity trackers, or business-unit cost allocation requirements.

## Summary

The Cluster Autoscaler's expander selection determines how scale-out behaves under load. Least Waste minimizes resource fragmentation and suits general-purpose workloads where instance type diversity is limited. Priority Expander provides explicit, deterministic control over instance type selection, enabling reserved → spot → on-demand cascade patterns that significantly reduce compute costs in production. Combining `--expander=priority,least-waste` delivers the best of both: deterministic preference ordering with tie-breaking based on resource efficiency. Pairing the expander configuration with correct scale-down tuning, PodDisruptionBudgets, and Prometheus alerting produces a Cluster Autoscaler deployment that scales reliably without manual intervention.

## Node Group Auto-Discovery Tags

The CA uses AWS Auto Scaling Group tags to discover node groups automatically without listing each one explicitly.

```bash
# Required tags on each ASG for auto-discovery
# Tag 1: Mark as eligible for CA
aws autoscaling create-or-update-tags \
  --tags "ResourceId=eks-ondemand-m5-large-us-east-1a,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/enabled,Value=true,PropagateAtLaunch=true"

# Tag 2: Associate with cluster name
aws autoscaling create-or-update-tags \
  --tags "ResourceId=eks-ondemand-m5-large-us-east-1a,ResourceType=auto-scaling-group,Key=k8s.io/cluster-autoscaler/prod-us-east-1,Value=owned,PropagateAtLaunch=true"

# Verify tags are present
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names eks-ondemand-m5-large-us-east-1a \
  --query "AutoScalingGroups[0].Tags[?Key=='k8s.io/cluster-autoscaler/enabled']"
```

## Overprovisioning with Pause Pods

A common pattern for reducing scale-up latency is to maintain placeholder "overprovisioning" pods with low priority. When real workloads arrive, the CA evicts placeholders and real pods schedule immediately while the CA provisions replacement nodes in the background.

```yaml
# PriorityClass for overprovisioning pods (lowest possible priority)
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: overprovisioning
value: -1
preemptionPolicy: Never
globalDefault: false
description: "Priority class for cluster overprovisioning placeholder pods"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-overprovisioner
  namespace: kube-system
spec:
  replicas: 3  # One placeholder per zone
  selector:
    matchLabels:
      app: cluster-overprovisioner
  template:
    metadata:
      labels:
        app: cluster-overprovisioner
    spec:
      priorityClassName: overprovisioning
      terminationGracePeriodSeconds: 0
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
          resources:
            requests:
              cpu: "2"       # Reserve 2 CPU per placeholder
              memory: 4Gi   # Reserve 4Gi per placeholder
            limits:
              cpu: "2"
              memory: 4Gi
```

## Scale-Up Simulation with --dry-run

The CA supports a dry-run mode for testing expander decisions without actually scaling.

```bash
# Run CA in simulation mode to see what it would do
kubectl -n kube-system run ca-test \
  --image=registry.k8s.io/autoscaling/cluster-autoscaler:v1.32.0 \
  --rm -it --restart=Never \
  -- /cluster-autoscaler \
    --v=5 \
    --cloud-provider=aws \
    --expander=priority,least-waste \
    --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/prod-us-east-1 \
    --dry-run=true \
    2>&1 | grep -E "scale_up|selected|expander"
```

## Multi-Instance-Type Node Groups with Karpenter Comparison

While the CA manages pre-defined node groups (ASGs), Karpenter provisions individual nodes on demand with flexible instance type selection. Understanding the difference is critical for choosing the right tool.

```yaml
# Karpenter NodePool (for comparison with CA approach)
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general-purpose
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["on-demand", "spot"]
        - key: node.kubernetes.io/instance-type
          operator: In
          values:
            - m5.large
            - m5.xlarge
            - m5a.large
            - m6i.large
            - m6a.large
        - key: topology.kubernetes.io/zone
          operator: In
          values: ["us-east-1a", "us-east-1b", "us-east-1c"]
      nodeClassRef:
        apiVersion: karpenter.k8s.aws/v1
        kind: EC2NodeClass
        name: default
  limits:
    cpu: "1000"
    memory: 4000Gi
  disruption:
    consolidationPolicy: WhenUnderutilized
    consolidateAfter: 30s
```

| Aspect | Cluster Autoscaler | Karpenter |
|--------|-------------------|-----------|
| Node selection | Pre-defined ASGs | Dynamic from requirements |
| Scale-up latency | 1-3 minutes (ASG launch) | 45-90 seconds (direct EC2 API) |
| Instance diversity | Per-ASG | Flexible per NodePool |
| Bin packing | Via expander scoring | Native optimization |
| Spot diversification | Requires multiple ASGs | Native via weights |
| Maturity | GA, widely deployed | GA as of Karpenter v1.0 |

## Node Draining Best Practices

When the CA scales down a node, it drains it using the Kubernetes eviction API. Understanding the drain sequence prevents disruptions.

```bash
# The CA drain sequence for scale-down:
# 1. Cordon node (unschedulable)
# 2. Check PodDisruptionBudgets for each pod
# 3. Evict pods respecting PDB minAvailable/maxUnavailable
# 4. Wait for pods to terminate (--max-graceful-termination-sec)
# 5. Delete the node object
# 6. Terminate the cloud instance

# Manually cordon a node to prevent CA from scheduling new pods
kubectl cordon ip-10-0-1-50.ec2.internal

# Simulate what would happen when CA drains this node
kubectl drain ip-10-0-1-50.ec2.internal \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --dry-run

# Uncordon after maintenance
kubectl uncordon ip-10-0-1-50.ec2.internal
```

## Cluster Autoscaler Status Interpretation

```bash
# The status ConfigMap is the primary diagnostic tool
kubectl -n kube-system get configmap cluster-autoscaler-status -o yaml

# Key sections in the status output:
# ScaleUp:   Shows why scale-up did or did not occur
# ScaleDown: Shows which nodes are candidates for removal
# NodeGroups: Current and max size of each node group

# Example healthy status output:
# ScaleUp: NoActivity (ready=10 registered=10 longNotStarted=0)
# NodeGroup: eks-ondemand-m5-large-us-east-1a
#   min=1 max=20 current=5 ready=5 schedulable=5
#   ScaleDownStatus: ReadyForScaleDown
```
