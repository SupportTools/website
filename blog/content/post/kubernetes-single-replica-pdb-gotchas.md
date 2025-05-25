---
title: "Kubernetes Single-Replica PDB Gotchas: Avoid Downtime and Resource Waste"
date: 2027-01-14T09:00:00-05:00
draft: false
tags: ["Kubernetes", "PodDisruptionBudget", "EKS", "Cluster Autoscaler", "High Availability"]
categories:
- Kubernetes
- DevOps
- Best Practices
author: "Matthew Mattox - mmattox@support.tools"
description: "Discover why single-replica workloads with strict PodDisruptionBudgets can lead to unexpected downtime during node maintenance and block cluster scaling operations."
more_link: "yes"
url: "/kubernetes-single-replica-pdb-gotchas/"
---

While PodDisruptionBudgets (PDBs) are designed to ensure application availability during voluntary disruptions, they can sometimes do more harm than good, especially in non-HA environments with single-replica workloads. This article reveals two serious operational pitfalls caused by combining strict PDBs with single-replica deployments, and provides practical solutions.

<!--more-->

# Kubernetes Single-Replica PDB Gotchas: Avoid Downtime and Resource Waste

PodDisruptionBudgets (PDBs) are a powerful Kubernetes feature that helps maintain application availability during voluntary disruptions like node drains. However, when used with single-replica workloads, they can create counterintuitive problems that lead to unexpected downtime and resource inefficiency.

Single-replica workloads are common in development, staging, and cost-sensitive environments. While this pattern works well in many scenarios, combining it with strict PDBs can lead to serious operational issues. Let's explore two critical problems and their solutions.

## Problem 1: Increased Downtime During Node Maintenance

### The Scenario

Consider an EKS cluster with the following configuration:

- Workloads running on EKS Managed Node Groups
- AWS Patch Manager configured to automatically patch and reboot nodes
- Single-replica deployments and statefulsets
- PDBs with `minAvailable: 1` (no allowed disruptions)

During a scheduled maintenance window, the following sequence occurs:

1. AWS Patch Manager applies security patches that require node reboots
2. A node enters the `NotReady` state after patching
3. The kubelet tries to drain the node, but is blocked by the PDB
4. After timeout, the node reboots anyway, forcefully terminating the pods
5. Applications experience downtime until the node returns and pods restart
6. In the worst case, applications with slow startup times extend the outage

### Why This Happens

The fundamental issue is a mismatch between your infrastructure reality and configuration. With a single replica protected by a strict PDB (`minAvailable: 1`), Kubernetes cannot honor both constraints simultaneously during a node drain:

1. It can't maintain the `minAvailable: 1` requirement (keep 1 pod running)
2. It can't successfully drain the node (remove all pods)

Kubernetes prioritizes the PDB constraint, so the drain operation stalls. However, AWS Patch Manager will eventually reboot the node after timeout, forcefully terminating pods without the graceful shutdown sequence that would occur with a proper drain.

Ironically, the PDB designed to prevent downtime actually causes more abrupt downtime.

### Solution

For non-HA environments with single-replica workloads, consider these options:

1. **Remove the PDB entirely** for single-replica workloads
2. **Use multiple replicas** across nodes if availability is critical (true HA)
3. **Configure less restrictive PDBs** that allow brief disruptions (e.g., `maxUnavailable: 1`)
4. **Coordinate maintenance windows** with acceptable downtime periods

Here's a more appropriate PDB for non-HA workloads:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: example-app
```

This configuration acknowledges that downtime is acceptable during maintenance, allowing for a controlled, graceful pod termination rather than a forced kill.

## Problem 2: Cluster Autoscaler Inefficiency and Resource Waste

### The Scenario

Consider the same EKS cluster with Cluster Autoscaler configured:

- Cluster Autoscaler monitors resource utilization and scales nodes
- Some workloads run with a single replica
- These workloads have PDBs with `minAvailable: 1`
- A node with only such workloads becomes underutilized

The Cluster Autoscaler identifies the node as a scale-down candidate but encounters this error:

```
node ip-12-34-56-78.us-west-2.compute.internal cannot be removed: not enough pod disruption budget to move my-namespace/my-critical-app-xyz
```

As a result, the node remains in the cluster despite being mostly idle, wasting resources and increasing costs.

### Why This Happens

The Cluster Autoscaler follows these steps when scaling down:

1. Identify underutilized nodes
2. Check if pods can be safely evicted
3. Attempt to reschedule pods to other nodes
4. If all pods can move, drain the node and terminate it

With a single-replica pod protected by a strict PDB, step 2 fails—the pod cannot be evicted without violating the PDB requirement of maintaining 1 available pod. Since the pod can't be moved, the node can't be drained, and the scale-down operation is abandoned.

### Solution

For cost-efficient autoscaling with single-replica workloads:

1. **Remove or relax PDBs** for non-critical workloads
2. **Add the safe-to-evict annotation** to allow eviction:

```yaml
annotations:
  cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
```

3. **Increase replicas and use proper HA** for truly critical workloads
4. **Use node taints and tolerations** to group similar workloads together

For example, a deployment with relaxed autoscaling constraints:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example-app
spec:
  replicas: 1
  template:
    metadata:
      annotations:
        cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
    spec:
      # ... rest of pod spec
```

## Other Common Factors Blocking Node Scale-Down

Beyond strict PDBs, several other factors can prevent the Cluster Autoscaler from scaling down nodes:

1. **Pods missing the safe-to-evict annotation**: Some system pods (especially in `kube-system`) aren't evictable without explicit marking
2. **Pods using local storage** (`emptyDir`, `hostPath`, or local persistent volumes)
3. **Pods with strict node affinity** or pod anti-affinity rules
4. **DaemonSet pods**: These are tied to nodes and not considered for eviction
5. **Mirror Pods** (static pods): Created directly by the kubelet, not controlled by the API server

To address system pods that block scale-down, add the safe-to-evict annotation:

```yaml
annotations:
  cluster-autoscaler.kubernetes.io/safe-to-evict: "true"
```

This is particularly important for system pods in `kube-system` namespace, such as CoreDNS, metrics-server, or CNI plugin pods.

## Making Better Architectural Decisions

The core issue in both problems is a mismatch between availability goals and infrastructure reality. Here are guidelines for making better decisions:

### For Dev/Test and Non-Critical Environments

1. **Skip PDBs entirely** or use `maxUnavailable: 1`
2. **Accept occasional brief downtime** during maintenance
3. **Mark pods as safe to evict** to enable efficient autoscaling
4. **Schedule maintenance during low-traffic periods**

### For Production and Critical Environments

1. **Use proper HA with multiple replicas** across nodes
2. **Configure appropriate PDBs** that reflect your HA architecture
3. **Implement pod topology spread constraints** to distribute replicas
4. **Use node affinity and anti-affinity** to control pod placement

For example, a proper HA deployment might look like:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-app
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    # ... pod spec with appropriate resources
    spec:
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: critical-app
```

With the corresponding PDB:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: critical-app-pdb
spec:
  minAvailable: 2  # Always keep at least 2 pods running
  selector:
    matchLabels:
      app: critical-app
```

## Conclusion

PDBs are valuable tools for maintaining application availability, but they must be aligned with your actual infrastructure capabilities and HA design. For single-replica workloads in non-HA environments:

1. **Recognize that downtime is inevitable** during maintenance
2. **Don't fight against this reality** with overly strict PDBs
3. **Configure for graceful handling** of expected disruptions
4. **Properly design for HA** when uptime is truly critical

By making these adjustments, you can avoid the counterintuitive situation where availability constraints actually increase downtime and resource waste. Remember that Kubernetes features like PDBs work best when they align with the actual resilience capabilities of your application architecture.