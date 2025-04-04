---
title: "CKA Prep: Part 7 – Cluster Maintenance"
description: "Understanding Kubernetes cluster maintenance, upgrades, backups, and recovery for the CKA exam."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 7
draft: false
tags: ["kubernetes", "cka", "maintenance", "upgrade", "backup", "k8s", "exam-prep"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## Cluster Maintenance Overview

Cluster maintenance is a critical aspect of Kubernetes administration and a significant part of the CKA exam. This section covers key maintenance activities including node management, upgrades, and backup/restore procedures.

## Node Maintenance

### Cordoning and Draining Nodes

When performing maintenance on a node, you need to safely move workloads away from it:

#### Cordoning a Node

Cordoning marks a node as unschedulable, preventing new pods from being scheduled on it.

```bash
# Mark a node as unschedulable
kubectl cordon node01
```

#### Draining a Node

Draining evicts all pods from a node (except mirror pods and pods not managed by a controller) and marks it as unschedulable.

```bash
# Drain a node
kubectl drain node01 --ignore-daemonsets

# Drain a node forcefully (even if it has pods not managed by a controller)
kubectl drain node01 --ignore-daemonsets --force
```

#### Uncordoning a Node

After maintenance is complete, make the node schedulable again.

```bash
# Mark a node as schedulable
kubectl uncordon node01
```

### Key Flags for `kubectl drain`

- `--ignore-daemonsets`: Ignores DaemonSet-managed pods
- `--delete-emptydir-data`: Allows deletion of pods using emptyDir volumes
- `--force`: Continues even if there are pods not managed by a controller
- `--grace-period=<seconds>`: Period of time to wait before force terminating pods
- `--timeout=<duration>`: The length of time to wait before giving up

## Kubernetes Upgrades

The CKA exam often includes tasks related to cluster upgrades. Understanding the upgrade process is crucial.

### Upgrade Process Overview

1. Upgrade the control plane components
2. Upgrade worker nodes
3. Upgrade kubectl on admin workstations
4. Verify the upgrade

### kubeadm Upgrade Workflow

#### 1. Pre-upgrade Checks

```bash
# Check the current version
kubectl version

# Check the upgrade plan
kubeadm upgrade plan
```

#### 2. Upgrading the Control Plane

```bash
# Update package lists
apt update

# Upgrade kubeadm
apt-get install -y kubeadm=1.26.0-00  # Replace with target version

# Plan the upgrade
kubeadm upgrade plan

# Apply the upgrade (on control-plane node)
kubeadm upgrade apply v1.26.0  # Replace with target version

# Upgrade kubelet and kubectl
apt-get install -y kubelet=1.26.0-00 kubectl=1.26.0-00  # Replace with target version

# Restart kubelet
systemctl daemon-reload
systemctl restart kubelet
```

#### 3. Upgrading Worker Nodes

For each worker node:

```bash
# (On the worker node) Drain the node from the control plane
kubectl drain node01 --ignore-daemonsets

# (On the worker node) Update kubeadm
apt-get update
apt-get install -y kubeadm=1.26.0-00  # Replace with target version

# (On the worker node) Upgrade node configuration
kubeadm upgrade node

# (On the worker node) Upgrade kubelet
apt-get install -y kubelet=1.26.0-00 kubectl=1.26.0-00  # Replace with target version

# (On the worker node) Restart kubelet
systemctl daemon-reload
systemctl restart kubelet

# (On the control plane) Make the node schedulable again
kubectl uncordon node01
```

#### 4. Verifying the Upgrade

```bash
# Check the status of all nodes
kubectl get nodes

# Verify component versions
kubectl version
kubectl get nodes -o wide
```

## Cluster Backup and Restore

Backing up and restoring a Kubernetes cluster is another important topic for the CKA exam.

### Key Components to Back Up

1. **etcd data**: Contains all cluster state
2. **Application data**: Persistent volumes used by applications
3. **Cluster configuration**: Certificates, kubeconfig files, etc.

### Backup and Restore etcd

etcd is the most critical component to back up as it contains all the cluster state information.

#### Backing Up etcd

Using etcdctl:

```bash
# Using etcdctl with ETCDCTL_API=3
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /tmp/etcd-backup.db
```

Verify the backup:

```bash
ETCDCTL_API=3 etcdctl --write-out=table snapshot status /tmp/etcd-backup.db
```

#### Restoring etcd from Backup

```bash
# Stop the API server
systemctl stop kube-apiserver

# Restore the snapshot
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --data-dir=/var/lib/etcd-backup \
  snapshot restore /tmp/etcd-backup.db

# Update etcd configuration to use the restored data directory
# Edit /etc/kubernetes/manifests/etcd.yaml to point to the new data directory

# Restart kubelet to pick up the changes
systemctl restart kubelet

# Start the API server
systemctl start kube-apiserver
```

### Backing Up Kubernetes Resources

You can also back up Kubernetes resources using kubectl:

```bash
# Back up all resources in all namespaces
kubectl get all --all-namespaces -o yaml > all-resources.yaml

# Back up specific resource types
kubectl get deployments -A -o yaml > deployments.yaml
kubectl get services -A -o yaml > services.yaml
kubectl get configmaps -A -o yaml > configmaps.yaml
kubectl get secrets -A -o yaml > secrets.yaml
kubectl get pv -o yaml > persistent-volumes.yaml
kubectl get pvc -A -o yaml > persistent-volume-claims.yaml
```

## OS Upgrades

Sometimes you need to perform OS-level upgrades on cluster nodes.

### General Procedure

1. **Prepare the node**:
   - Drain the node to evacuate workloads
   - Mark it as unschedulable

2. **Perform the upgrade**:
   - Execute OS upgrade procedure
   - Reboot if necessary

3. **Return the node to service**:
   - Verify node health
   - Mark it as schedulable

```bash
# Drain the node
kubectl drain node01 --ignore-daemonsets

# Perform OS upgrade (example for Ubuntu)
ssh node01 "sudo apt update && sudo apt upgrade -y"

# Reboot if necessary
ssh node01 "sudo reboot"

# Wait for node to be ready
kubectl get nodes node01 -w

# Uncordon the node
kubectl uncordon node01
```

## Monitoring and Resource Management

Understanding how to monitor cluster resources is also important for the CKA exam.

### Node and Pod Metrics

You can use the Metrics Server to collect resource utilization data.

```bash
# Deploy Metrics Server (if not already installed)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# View node metrics
kubectl top nodes

# View pod metrics
kubectl top pods -A
```

### Resource Quotas and Limits

You can use ResourceQuotas to limit resource consumption at the namespace level:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: development
spec:
  hard:
    pods: "10"
    requests.cpu: "4"
    requests.memory: 5Gi
    limits.cpu: "8"
    limits.memory: 10Gi
```

### LimitRanges

LimitRanges set default, minimum, and maximum resource constraints for pods:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: resource-limits
  namespace: development
spec:
  limits:
  - type: Container
    default:
      cpu: 500m
      memory: 256Mi
    defaultRequest:
      cpu: 100m
      memory: 50Mi
    max:
      cpu: 2
      memory: 2Gi
    min:
      cpu: 50m
      memory: 10Mi
```

## Sample Exam Questions

### Question 1: Drain a Node

**Task**: The node `worker01` needs to undergo maintenance. Safely evict all the pods from it, ensuring the workloads are moved to other nodes in the cluster. Ignore DaemonSets during the eviction.

**Solution**:

```bash
# Drain the node
kubectl drain worker01 --ignore-daemonsets

# Verify the node is marked as SchedulingDisabled
kubectl get nodes worker01
```

### Question 2: Upgrade Kubernetes

**Task**: The cluster is currently running Kubernetes v1.25.0, and you need to upgrade it to v1.26.0. Start by upgrading the control plane components on `master` node.

**Solution**:

```bash
# First, check the current version
kubectl version --short

# Update package lists
ssh master "sudo apt update"

# Upgrade kubeadm on the master node
ssh master "sudo apt-get install -y kubeadm=1.26.0-00"

# Check the upgrade plan
ssh master "sudo kubeadm upgrade plan"

# Apply the upgrade
ssh master "sudo kubeadm upgrade apply v1.26.0"

# Upgrade kubelet and kubectl
ssh master "sudo apt-get install -y kubelet=1.26.0-00 kubectl=1.26.0-00"

# Restart kubelet
ssh master "sudo systemctl daemon-reload && sudo systemctl restart kubelet"

# Verify the upgrade
kubectl get nodes
```

### Question 3: Backup etcd

**Task**: Create a snapshot backup of the etcd database on the control plane node. Save the backup to `/tmp/etcd-backup.db`.

**Solution**:

```bash
# Get the etcd pod name
kubectl get pods -n kube-system | grep etcd

# Get the etcd endpoints and certificate paths
# If etcd is running as a static pod (common in kubeadm setups)
ssh master "sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /tmp/etcd-backup.db"

# Verify the backup
ssh master "sudo ETCDCTL_API=3 etcdctl --write-out=table snapshot status /tmp/etcd-backup.db"
```

### Question 4: Restore etcd

**Task**: The etcd database is corrupted. Restore it from a backup file located at `/tmp/etcd-backup.db`.

**Solution**:

```bash
# Stop the API server
ssh master "sudo systemctl stop kube-apiserver"

# Restore from the backup
ssh master "sudo ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  --data-dir=/var/lib/etcd-restored \
  snapshot restore /tmp/etcd-backup.db"

# Update etcd pod manifest to use the new data directory
ssh master "sudo sed -i 's|/var/lib/etcd|/var/lib/etcd-restored|g' /etc/kubernetes/manifests/etcd.yaml"

# Wait for the etcd pod to restart
kubectl get pods -n kube-system -w | grep etcd

# Start the API server
ssh master "sudo systemctl start kube-apiserver"

# Verify cluster functionality
kubectl get nodes
```

## Key Tips for Cluster Maintenance

1. **Master node operations**:
   - Always be extra careful when working on control plane nodes
   - Understand the implications of each change
   - Have a rollback plan ready

2. **Node draining best practices**:
   - Always use `--ignore-daemonsets` when draining
   - Consider using `--timeout` to avoid hanging operations
   - If needed, use `--force` with caution

3. **Upgrade sequence**:
   - Always upgrade components in the right order (kubeadm, control plane, kubelet)
   - Upgrade one node at a time
   - Test thoroughly after each step

4. **etcd backup procedures**:
   - Take regular backups of etcd
   - Store backups in a safe location
   - Practice restoration procedures

5. **Resource management**:
   - Implement ResourceQuotas and LimitRanges
   - Monitor resource usage regularly
   - Set appropriate requests and limits on workloads

## Practice Exercises

To reinforce your understanding, try these exercises in your practice environment:

1. Perform a full cluster upgrade from one minor version to the next
2. Create and restore an etcd backup
3. Drain nodes for maintenance and then return them to service
4. Implement resource quotas in a namespace and test their enforcement
5. Set up a LimitRange and observe its effects on new pods
6. Practice recovering from various failure scenarios (node failure, etcd failure, etc.)
7. Simulate an OS upgrade procedure on a worker node

## What's Next

In the next part, we'll explore Kubernetes Troubleshooting techniques, covering:
- Application Failure
- Control Plane Failures
- Worker Node Failures
- Networking Issues
- Storage Problems
- Resource Constraints

👉 Continue to **[Part 8: Troubleshooting](/training/cka-prep/08-troubleshooting/)**
