---
title: "Kubernetes Node Management: Taints, Tolerations, Affinity, and Node Lifecycle Operations"
date: 2027-08-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Management", "Scheduling"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Kubernetes node management covering taints and tolerations, pod affinity and anti-affinity, node lifecycle hooks, cordon/drain/delete procedures, Node Problem Detector, NodeLocal DNS Cache, and upgrade strategies."
more_link: "yes"
url: "/kubernetes-node-management-advanced-guide/"
---

Effective node management is the foundation of a stable, well-utilized Kubernetes cluster. The scheduling primitives — taints, tolerations, and affinity rules — determine where workloads land, whether they spread across failure domains, and how the cluster handles node failures. Node lifecycle procedures — cordon, drain, and delete — dictate how maintenance is performed without disrupting running applications. This guide provides production-ready patterns for all of these topics, along with Node Problem Detector configuration and safe node upgrade strategies.

<!--more-->

## Taints and Tolerations

Taints are key-value pairs applied to nodes that repel pods. Tolerations are the matching annotations on pods that allow them to be scheduled onto tainted nodes. Together they enforce placement policies without modifying individual workload manifests.

### Taint Effects

| Effect | Behavior |
|--------|----------|
| `NoSchedule` | Pods without a matching toleration are not scheduled on this node (existing pods are not evicted) |
| `PreferNoSchedule` | The scheduler avoids placing pods without a matching toleration, but will do so if no other node is available |
| `NoExecute` | Pods without a matching toleration are evicted if already running, and not scheduled if not yet placed |

### Applying and Removing Taints

```bash
# Add a taint
kubectl taint node worker-01 dedicated=gpu:NoSchedule

# Add a NoExecute taint (also evicts existing pods)
kubectl taint node worker-01 maintenance=true:NoExecute

# Remove a taint (note the trailing minus sign)
kubectl taint node worker-01 dedicated=gpu:NoSchedule-

# Remove all taints with key "dedicated"
kubectl taint node worker-01 dedicated-
```

### Toleration Examples

```yaml
spec:
  tolerations:
    # Exact match: tolerate the dedicated=gpu taint
    - key: dedicated
      operator: Equal
      value: gpu
      effect: NoSchedule

    # Key-only match: tolerate any value for "dedicated" with NoSchedule
    - key: dedicated
      operator: Exists
      effect: NoSchedule

    # Tolerate a NoExecute taint for up to 60 seconds before eviction
    - key: node.kubernetes.io/not-ready
      operator: Exists
      effect: NoExecute
      tolerationSeconds: 60

    # Tolerate all taints — use with caution, typically for DaemonSets
    - operator: Exists
```

### Built-in Taints

Kubernetes applies several taints automatically:

```
node.kubernetes.io/not-ready:NoExecute
node.kubernetes.io/unreachable:NoExecute
node.kubernetes.io/memory-pressure:NoSchedule
node.kubernetes.io/disk-pressure:NoSchedule
node.kubernetes.io/pid-pressure:NoSchedule
node.kubernetes.io/unschedulable:NoSchedule
node.kubernetes.io/network-unavailable:NoSchedule
```

DaemonSet pods automatically receive tolerations for `not-ready` and `unreachable` with a `tolerationSeconds` of 0, ensuring they always run on every node.

## Node Affinity

Node affinity constrains which nodes a pod can be scheduled on, based on node labels. It replaces and extends `nodeSelector`.

### Required vs. Preferred

```yaml
spec:
  affinity:
    nodeAffinity:
      # Hard requirement: only schedule on nodes in us-east-1a or us-east-1b
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values:
                  - us-east-1a
                  - us-east-1b

      # Soft preference: prefer GPU nodes (weight 80 out of 100)
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: accelerator
                operator: In
                values:
                  - nvidia-tesla-a100
        - weight: 20
          preference:
            matchExpressions:
              - key: node-type
                operator: In
                values:
                  - compute-optimized
```

### Labeling Nodes for Affinity

```bash
# Zone and region (typically set by cloud provider)
kubectl label node worker-01 topology.kubernetes.io/zone=us-east-1a
kubectl label node worker-01 topology.kubernetes.io/region=us-east-1

# Custom workload type labels
kubectl label node worker-01 workload-type=cpu-intensive
kubectl label node worker-02 workload-type=memory-intensive
kubectl label node worker-03 accelerator=nvidia-tesla-a100

# Node tier for cost separation
kubectl label node spot-01 node.example.com/tier=spot
kubectl label node ondemand-01 node.example.com/tier=on-demand
```

## Pod Affinity and Anti-Affinity

Pod affinity/anti-affinity controls pod placement relative to other pods already running in the cluster, based on their labels.

### Co-Location (Affinity)

Schedule pods on nodes that are already running pods with specific labels. Useful for application/cache co-location:

```yaml
spec:
  affinity:
    podAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: redis-cache
            topologyKey: kubernetes.io/hostname
```

### Spreading (Anti-Affinity)

Force replicas onto different nodes or zones to survive failures:

```yaml
spec:
  affinity:
    podAntiAffinity:
      # Hard: no two replicas on the same node
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: frontend
          topologyKey: kubernetes.io/hostname

      # Soft: prefer spreading across availability zones
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: frontend
            topologyKey: topology.kubernetes.io/zone
```

### Topology Spread Constraints (Preferred Approach)

Topology spread constraints provide finer-grained spreading than pod anti-affinity and are the recommended approach for modern clusters (Kubernetes 1.19+):

```yaml
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: frontend
    - maxSkew: 2
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app: frontend
```

`maxSkew` defines the maximum allowed imbalance between any two topology domains. `whenUnsatisfiable: DoNotSchedule` makes the constraint a hard requirement; `ScheduleAnyway` makes it a soft preference.

## Node Lifecycle: Cordon, Drain, and Delete

### Cordon

Cordoning a node marks it as unschedulable, preventing new pods from being placed on it while existing pods continue to run:

```bash
kubectl cordon worker-01

# Verify
kubectl get node worker-01
# NAME         STATUS                     ROLES    AGE   VERSION
# worker-01    Ready,SchedulingDisabled   <none>   30d   v1.31.0
```

### Drain

Draining a node evicts all pods (respecting PodDisruptionBudgets) and cordons the node in preparation for maintenance:

```bash
# Standard drain with timeout
kubectl drain worker-01 \
    --ignore-daemonsets \
    --delete-emissary-data \
    --timeout=300s

# Drain without honoring PDBs — use only in emergencies
kubectl drain worker-01 \
    --ignore-daemonsets \
    --delete-emissary-data \
    --disable-eviction \
    --force \
    --timeout=120s
```

**Important flags:**

| Flag | Purpose |
|------|---------|
| `--ignore-daemonsets` | Skip DaemonSet-managed pods (they will restart on other nodes) |
| `--delete-emissary-data` | Allow deletion of pods with emptyDir volumes |
| `--timeout` | Give up if drain is not complete within this duration |
| `--force` | Delete pods not managed by a ReplicaSet/Deployment |
| `--disable-eviction` | Use DELETE instead of eviction API (bypasses PDBs) |

### Checking for Blocking Evictions

Before draining in production, identify what is blocking:

```bash
# List pods that would be affected
kubectl drain worker-01 --ignore-daemonsets --dry-run

# Check PDBs that might block eviction
kubectl get pdb --all-namespaces

# Check for pods with local storage
kubectl get pods --all-namespaces --field-selector spec.nodeName=worker-01 \
    -o json | jq '.items[] | select(.spec.volumes[]?.emptyDir != null) | .metadata.name'
```

### Uncordon

After maintenance, mark the node schedulable again:

```bash
kubectl uncordon worker-01
```

### Removing a Node from the Cluster

When permanently decommissioning a node:

```bash
# 1. Cordon to prevent new scheduling
kubectl cordon worker-01

# 2. Drain all workloads
kubectl drain worker-01 --ignore-daemonsets --delete-emissary-data --timeout=300s

# 3. Delete the Node object
kubectl delete node worker-01

# 4. (If using kubeadm) On the node itself, reset kubeadm state
kubeadm reset
```

## Node Problem Detector

Node Problem Detector (NPD) is a DaemonSet that monitors node health and reports kernel panics, OOM kills, corrupted file systems, and other hardware/OS issues as Node Conditions and Events.

### Deployment

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-problem-detector
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-problem-detector
  template:
    metadata:
      labels:
        app: node-problem-detector
    spec:
      serviceAccountName: node-problem-detector
      hostNetwork: true
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists
          effect: NoSchedule
      containers:
        - name: node-problem-detector
          image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.19
          command:
            - /node-problem-detector
            - --logtostderr
            - --system-log-monitors=/config/kernel-monitor.json
            - --custom-plugin-monitors=/config/custom-plugin-monitor.json
            - --prometheus-address=0.0.0.0
            - --prometheus-port=20257
          ports:
            - containerPort: 20257
              name: prometheus
          securityContext:
            privileged: true
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          volumeMounts:
            - name: log
              mountPath: /var/log
              readOnly: true
            - name: kmsg
              mountPath: /dev/kmsg
              readOnly: true
            - name: config
              mountPath: /config
      volumes:
        - name: log
          hostPath:
            path: /var/log/
        - name: kmsg
          hostPath:
            path: /dev/kmsg
        - name: config
          configMap:
            name: node-problem-detector-config
```

### Custom Problem Monitor Configuration

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "30s",
    "timeout": "5s",
    "max_output_length": 80,
    "concurrency": 3
  },
  "source": "custom-plugin-monitor",
  "conditions": [
    {
      "type": "NTPProblem",
      "reason": "NTPIsUp",
      "message": "NTP service is running"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "NTPProblem",
      "reason": "NTPServiceNotRunning",
      "message": "NTP service is not running",
      "path": "/config/plugin/check_ntp.sh"
    }
  ]
}
```

### Taint-Based Eviction from NPD Conditions

Configure the node condition to taint the node when a problem is detected:

```yaml
# Cluster Autoscaler and NPD integration via node-taint-manager
# When NPD reports a permanent condition, a separate controller applies:
kubectl taint node worker-01 node.kubernetes.io/disk-pressure:NoSchedule
```

## Node Upgrade Strategies

### In-Place Node Upgrade (kubeadm)

The standard in-place upgrade procedure for kubeadm-managed clusters:

```bash
# On the control plane node — upgrade kubeadm
apt-mark unhold kubeadm
apt-get update && apt-get install -y kubeadm=1.32.0-00
apt-mark hold kubeadm

# Verify the upgrade plan
kubeadm upgrade plan

# Apply the upgrade
kubeadm upgrade apply v1.32.0

# Upgrade kubelet and kubectl on control plane
apt-mark unhold kubelet kubectl
apt-get update && apt-get install -y kubelet=1.32.0-00 kubectl=1.32.0-00
apt-mark hold kubelet kubectl
systemctl daemon-reload
systemctl restart kubelet

# For each worker node:
# 1. Upgrade kubeadm on the worker
apt-get install -y kubeadm=1.32.0-00

# 2. Drain the worker from the control plane
kubectl drain worker-01 --ignore-daemonsets --delete-emissary-data

# 3. Upgrade the node configuration
kubeadm upgrade node

# 4. Upgrade kubelet
apt-get install -y kubelet=1.32.0-00 kubectl=1.32.0-00
systemctl daemon-reload
systemctl restart kubelet

# 5. Uncordon
kubectl uncordon worker-01
```

### Rolling Node Replacement (Cloud-Native)

For cloud-managed node groups, replace nodes rather than upgrading in place. This produces cleaner nodes and is faster at scale:

```bash
# 1. Create a new node group with the upgraded version
# (cloud-provider-specific — example shows conceptual steps)

# 2. Cordon all old nodes
for node in $(kubectl get nodes -l node-group=workers-v131 -o name); do
    kubectl cordon "$node"
done

# 3. Drain old nodes one by one, waiting for new pods to be ready
for node in $(kubectl get nodes -l node-group=workers-v131 -o name); do
    kubectl drain "$node" --ignore-daemonsets --delete-emissary-data --timeout=300s
    echo "Drained $node, sleeping 30s before next node"
    sleep 30
done

# 4. Delete old node objects after cloud instances are terminated
for node in $(kubectl get nodes -l node-group=workers-v131 -o name); do
    kubectl delete "$node"
done
```

### Pre-Upgrade Node Validation Script

```bash
#!/usr/bin/env bash
set -euo pipefail

NODE="${1:?Usage: $0 <node-name>}"

echo "=== Pre-upgrade validation for node: ${NODE} ==="

# Check node is Ready
STATUS=$(kubectl get node "${NODE}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
if [[ "${STATUS}" != "True" ]]; then
    echo "ERROR: Node is not Ready (status: ${STATUS})"
    exit 1
fi

# Check pods on node are all Running or Completed
NOT_READY=$(kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=${NODE}" \
    --no-headers \
    | awk '{print $4}' \
    | grep -vE "^(Running|Completed|Succeeded)$" \
    | wc -l)

if [[ "${NOT_READY}" -gt 0 ]]; then
    echo "WARNING: ${NOT_READY} pods are not in Running/Completed state on ${NODE}"
    kubectl get pods --all-namespaces --field-selector "spec.nodeName=${NODE}" \
        | grep -vE "Running|Completed|Succeeded"
fi

# Check disk pressure
DISK_PRESSURE=$(kubectl get node "${NODE}" -o jsonpath='{.status.conditions[?(@.type=="DiskPressure")].status}')
if [[ "${DISK_PRESSURE}" == "True" ]]; then
    echo "ERROR: Node has DiskPressure condition"
    exit 1
fi

# Check memory pressure
MEM_PRESSURE=$(kubectl get node "${NODE}" -o jsonpath='{.status.conditions[?(@.type=="MemoryPressure")].status}')
if [[ "${MEM_PRESSURE}" == "True" ]]; then
    echo "ERROR: Node has MemoryPressure condition"
    exit 1
fi

echo "=== Node ${NODE} passed pre-upgrade validation ==="
```

## Cluster Autoscaler Integration

When using the Cluster Autoscaler, node taints and labels must be propagated correctly to the node group configuration so the autoscaler can make correct scale-up decisions.

### Node Group Label Propagation (AWS)

```yaml
# In the Cluster Autoscaler Deployment
- name: cluster-autoscaler
  image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.31.0
  command:
    - ./cluster-autoscaler
    - --cloud-provider=aws
    - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production-cluster
    - --balance-similar-node-groups=true
    - --skip-nodes-with-local-storage=false
    - --skip-nodes-with-system-pods=false
    - --expander=least-waste
    - --scale-down-enabled=true
    - --scale-down-delay-after-add=10m
    - --scale-down-unneeded-time=10m
```

### Preventing Autoscaler from Removing Specific Nodes

```bash
# Add annotation to prevent scale-down
kubectl annotate node worker-stateful-01 cluster-autoscaler.kubernetes.io/scale-down-disabled=true
```

## Node Conditions Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-lifecycle-alerts
  namespace: monitoring
spec:
  groups:
    - name: node-lifecycle
      rules:
        - alert: NodeNotReady
          expr: kube_node_status_condition{condition="Ready",status="true"} == 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.node }} is not Ready"

        - alert: NodeDiskPressure
          expr: kube_node_status_condition{condition="DiskPressure",status="true"} == 1
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.node }} has DiskPressure"

        - alert: NodeMemoryPressure
          expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.node }} has MemoryPressure"

        - alert: NodeUnschedulable
          expr: kube_node_spec_unschedulable == 1
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.node }} has been cordoned for over 30 minutes"
```

## Summary

Production node management requires a disciplined approach to taints and tolerations for workload isolation, topology spread constraints for availability, and well-tested cordon/drain procedures that respect PodDisruptionBudgets. Node Problem Detector fills the gap between OS-level events and Kubernetes conditions, enabling automated taint-based eviction when hardware or kernel problems are detected. For upgrades, rolling node replacement is faster and produces cleaner results than in-place upgrades at scale, and pre-upgrade validation scripts prevent maintenance windows from producing unexpected disruptions.
