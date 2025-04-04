---
title: "CKA Prep: Part 8 – Troubleshooting"
description: "Mastering Kubernetes troubleshooting techniques for applications, control plane, networking, and more for the CKA exam."
date: 2025-04-04T00:00:00-00:00
series: "CKA Exam Preparation Guide"
series_rank: 8
draft: false
tags: ["kubernetes", "cka", "troubleshooting", "k8s", "exam-prep", "debugging"]
categories: ["Training", "Kubernetes Certification"]
author: "Matthew Mattox"
more_link: ""
---

## Kubernetes Troubleshooting Overview

Troubleshooting is a significant part of the CKA exam (approximately 30% of the curriculum). Being able to identify and resolve issues in a Kubernetes cluster is a critical skill for Kubernetes administrators.

## Troubleshooting Methodology

The key to effective troubleshooting is having a systematic approach:

1. **Identify the problem**: Determine what's not working
2. **Gather information**: Collect logs, events, and other diagnostic data
3. **Analyze the data**: Determine the cause of the problem
4. **Implement a solution**: Fix the issue
5. **Verify the solution**: Ensure the problem is resolved

## Application Troubleshooting

### Pod Lifecycle Issues

Common causes of pod lifecycle issues:

1. **Image Pull Errors**: Incorrect image name, private registry without credentials
2. **Resource Constraints**: Insufficient CPU or memory, resource quotas
3. **Node Affinity/Taints**: Pod can't be scheduled due to node selection constraints
4. **Volume Mount Issues**: Persistent volume problems
5. **Container Crashes**: Application errors, out of memory, liveness probe failures

### Diagnosing Pod Issues

```bash
# Check pod status
kubectl get pods 

# Describe pod for events and configuration
kubectl describe pod <pod-name>

# Check pod logs
kubectl logs <pod-name>

# Check previous pod logs (if container has restarted)
kubectl logs <pod-name> --previous

# Get pod YAML for validation
kubectl get pod <pod-name> -o yaml
```

### Common Pod Status Values

- **Pending**: Pod is waiting to be scheduled
- **ContainerCreating**: Pod has been scheduled and containers are being created
- **Running**: Pod is running successfully
- **CrashLoopBackOff**: Container is crashing repeatedly
- **Error**: Pod failed during startup
- **Terminating**: Pod is being deleted
- **Completed**: Pod has run to completion (usually for Jobs)
- **ImagePullBackOff**: Kubernetes can't pull the container image

### Troubleshooting Scenarios

#### Image Pull Errors

```bash
# Symptoms in kubectl describe pod output
Events:
  ...
  Failed to pull image "nginx:invalid": rpc error: code = NotFound desc = failed to pull and unpack image...

# Solutions
# 1. Fix the image name
kubectl set image deployment/nginx-deployment nginx=nginx:stable

# 2. Add ImagePullSecrets for private registry
kubectl create secret docker-registry regcred \
  --docker-server=<registry-server> \
  --docker-username=<username> \
  --docker-password=<password> \
  --docker-email=<email>

kubectl patch serviceaccount default -p '{"imagePullSecrets": [{"name": "regcred"}]}'
```

#### Container Crashing

```bash
# Check for crash loops
kubectl get pods | grep CrashLoopBackOff

# Check container logs
kubectl logs <pod-name>

# Check previous container logs
kubectl logs <pod-name> --previous

# Check events
kubectl describe pod <pod-name>
```

#### Resource Constraints

```bash
# Check resource usage
kubectl top pods

# Check resource requests/limits
kubectl describe pod <pod-name> | grep -A 3 Requests

# Check namespace resource quotas
kubectl describe quota -n <namespace>
```

## Control Plane Troubleshooting

Control plane issues can affect the entire cluster. The CKA exam may test your ability to diagnose and fix control plane components.

### Key Control Plane Components

- **kube-apiserver**: The front-end for the control plane
- **etcd**: Cluster state database
- **kube-scheduler**: Assigns pods to nodes
- **kube-controller-manager**: Runs controller processes
- **cloud-controller-manager**: Integrates with cloud provider (if applicable)

### Checking Component Status

```bash
# Check control plane pod status (in kubeadm-based clusters)
kubectl get pods -n kube-system

# Check detailed status
kubectl describe pod kube-apiserver-master -n kube-system
kubectl describe pod etcd-master -n kube-system
kubectl describe pod kube-scheduler-master -n kube-system
kubectl describe pod kube-controller-manager-master -n kube-system

# Check component logs
kubectl logs kube-apiserver-master -n kube-system
```

### For non-pod components (systemd services)

```bash
# Check service status
systemctl status kubelet

# View logs
journalctl -u kubelet
```

### Common Control Plane Issues

#### API Server Issues

```bash
# Symptoms: kubectl commands don't work, "connection refused"

# Check API server pod
kubectl get pod kube-apiserver-master -n kube-system

# Check API server logs
kubectl logs kube-apiserver-master -n kube-system

# Check API server manifest (on control plane node)
cat /etc/kubernetes/manifests/kube-apiserver.yaml

# Solutions (examples):
# - Fix certificate issues
# - Fix arguments in the manifest
# - Ensure etcd is working
```

#### etcd Issues

```bash
# Check etcd pod
kubectl get pod etcd-master -n kube-system

# Check etcd logs
kubectl logs etcd-master -n kube-system

# Check etcd health
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health

# Solutions (examples):
# - Restore from backup
# - Fix certificate issues
# - Fix networking issues
```

## Worker Node Troubleshooting

Worker node issues affect pod scheduling and operation on specific nodes.

### Checking Node Status

```bash
# List nodes and their status
kubectl get nodes

# Get detailed node information
kubectl describe node <node-name>

# Check node capacity and allocatable resources
kubectl describe node <node-name> | grep -A 10 Capacity
```

### Checking Kubelet

The kubelet is the primary agent on each node. Issues with the kubelet can cause node failures.

```bash
# Check kubelet status
systemctl status kubelet

# Check kubelet logs
journalctl -u kubelet

# Check kubelet configuration
cat /var/lib/kubelet/config.yaml
```

### Common Node Issues

#### Node is NotReady

```bash
# Check node status
kubectl get nodes
kubectl describe node <node-name>

# Check kubelet status
systemctl status kubelet

# Check kubelet logs
journalctl -u kubelet

# Common solutions:
# - Start kubelet: systemctl start kubelet
# - Fix kubelet configuration
# - Check node networking
# - Check container runtime (containerd/docker)
```

#### Node is SchedulingDisabled (cordoned)

```bash
# Check if node is cordoned
kubectl get nodes | grep SchedulingDisabled

# Uncordon the node
kubectl uncordon <node-name>
```

## Networking Troubleshooting

Networking issues can affect pod-to-pod and pod-to-service communication.

### Checking Network Connectivity

```bash
# Run a debugging pod
kubectl run network-debug --rm -it --image=nicolaka/netshoot -- /bin/bash

# Inside the pod, check DNS
nslookup kubernetes.default

# Check service connectivity
curl <service-name>.<namespace>.svc.cluster.local

# Check pod connectivity (by IP)
ping <pod-ip>

# Check node connectivity
ping <node-ip>
```

### Checking DNS

```bash
# Check CoreDNS pods
kubectl get pods -n kube-system -l k8s-app=kube-dns

# Check CoreDNS logs
kubectl logs -n kube-system -l k8s-app=kube-dns

# Check DNS configuration in a pod
kubectl exec <pod-name> -- cat /etc/resolv.conf
```

### Checking Services

```bash
# Check service definition
kubectl get service <service-name> -o yaml

# Check endpoints (should match pod IPs)
kubectl get endpoints <service-name>

# Check if selector matches pod labels
kubectl get pods --selector=<key>=<value>

# Check if service port matches container port
kubectl describe service <service-name>
kubectl describe pod <pod-name>
```

### Checking Network Policies

```bash
# List network policies
kubectl get networkpolicies

# Describe network policy
kubectl describe networkpolicy <policy-name>

# Check if network plugin supports network policies
kubectl get pods -n kube-system | grep cni
```

## Storage Troubleshooting

Storage issues can prevent pods from starting or accessing data.

### Checking Persistent Volumes

```bash
# List persistent volumes
kubectl get pv

# Check PV details
kubectl describe pv <pv-name>
```

### Checking Persistent Volume Claims

```bash
# List persistent volume claims
kubectl get pvc

# Check PVC details
kubectl describe pvc <pvc-name>
```

### Common Storage Issues

#### PVC in Pending State

```bash
# Check PVC status
kubectl get pvc
kubectl describe pvc <pvc-name>

# Check storage class
kubectl get storageclass
kubectl describe storageclass <storage-class-name>

# Solutions:
# - Create a matching PV manually
# - Check storage class provisioner
# - Check underlying storage system
```

#### Pod Can't Mount Volume

```bash
# Check pod events
kubectl describe pod <pod-name>

# Check volume mounts in the pod spec
kubectl get pod <pod-name> -o yaml | grep -A 5 volumeMounts

# Solutions:
# - Fix PVC/PV binding issues
# - Fix volume mount paths
# - Check underlying storage system
```

## Performance Troubleshooting

Performance issues can occur due to resource constraints or inefficient configurations.

### Checking Resource Usage

```bash
# Check node resource usage
kubectl top nodes

# Check pod resource usage
kubectl top pods

# Check container resource usage
kubectl top pods --containers
```

### Resource Constraints

```bash
# Check pod resource requests and limits
kubectl describe pod <pod-name> | grep -A 3 Requests

# Check namespace resource quotas
kubectl describe quota -n <namespace>

# Check limit ranges
kubectl describe limitranges -n <namespace>
```

## Sample Exam Questions

### Question 1: Troubleshoot a Failing Pod

**Task**: A pod named `web-app` in the `default` namespace is continuously crashing. Identify the issue and fix it so the pod becomes Running.

**Solution**:

```bash
# Check pod status
kubectl get pod web-app

# Check detailed info
kubectl describe pod web-app

# Check pod logs
kubectl logs web-app

# Assuming the logs show it's trying to connect to a non-existent database:
# 1. Create a ConfigMap with the correct database connection
kubectl create configmap db-config --from-literal=DB_HOST=db-service.default.svc.cluster.local

# 2. Update the pod to use the ConfigMap
kubectl edit pod web-app
# Add environment variables from the ConfigMap

# If the pod needs to be recreated:
kubectl delete pod web-app
kubectl apply -f fixed-web-app.yaml
```

### Question 2: Troubleshoot API Server Issues

**Task**: The Kubernetes API server on the control plane is not responding. Investigate and fix the issue.

**Solution**:

```bash
# SSH to the control plane node
ssh master

# Check the API server status
sudo crictl ps | grep kube-apiserver

# If not running, check the static pod manifest
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml

# Check for any errors in the manifest
# (For example, if there's a typo in an argument)

# Check API server logs
sudo crictl logs <api-server-container-id>

# Fix the manifest if there are issues
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml

# Wait for the API server to restart
# The kubelet will automatically restart the static pod

# Verify API server is running
kubectl get pods -n kube-system
```

### Question 3: Troubleshoot Service Connectivity

**Task**: Pods in namespace `app` cannot reach the `database` service in the same namespace. Investigate and fix the issue.

**Solution**:

```bash
# Check the service definition
kubectl get service database -n app

# Check if the service has endpoints
kubectl get endpoints database -n app

# If no endpoints, check if the service selector matches pod labels
kubectl describe service database -n app
kubectl get pods -n app --show-labels

# If selectors don't match, update the service to match the pod labels
kubectl edit service database -n app

# If network policies might be blocking traffic, check network policies
kubectl get networkpolicy -n app

# Test connectivity after fixing
kubectl run test-pod -n app --rm -it --image=busybox -- /bin/sh
# Inside the pod: wget -O- database:3306
```

### Question 4: Fix a Node in NotReady State

**Task**: Node `worker01` is in a NotReady state. Identify the issue and bring the node back to Ready state.

**Solution**:

```bash
# Check node status
kubectl describe node worker01

# SSH to the node
ssh worker01

# Check kubelet status
sudo systemctl status kubelet

# If kubelet is not running, start it
sudo systemctl start kubelet

# If kubelet is running but failing, check the logs
sudo journalctl -u kubelet

# Common issues to fix:
# - Disk pressure: sudo rm -rf /var/log/pods/old-logs/
# - Certificate issues: Check /var/lib/kubelet/pki/ files
# - Configuration issues: Check /var/lib/kubelet/config.yaml
# - CNI issues: Check /etc/cni/net.d/

# After fixing the issue, restart kubelet
sudo systemctl restart kubelet

# Verify the node is ready
kubectl get nodes
```

## Key Troubleshooting Tips

1. **Systematic approach**:
   - Start with basic checks and work toward more complex components
   - Check one component at a time
   - Document your findings and actions

2. **Log analysis**:
   - Learn to quickly find and interpret relevant log entries
   - Use `grep`, `tail`, and `head` to filter log output
   - Check both container logs and node-level logs

3. **API resource inspection**:
   - Master the `kubectl describe` command
   - Use `-o yaml` to get the full resource definition
   - Compare actual state vs desired state

4. **Connectivity testing**:
   - Use debugging containers (`netshoot`, `busybox`) to test network
   - Check DNS resolution, service connections, and pod-to-pod communication
   - Verify firewall and network policy configurations

5. **Control plane verification**:
   - Check each control plane component systematically
   - Verify certificate validity and paths
   - Ensure etcd health and connectivity

## Practice Exercises

To reinforce your troubleshooting skills, try these exercises in your practice environment:

1. Intentionally introduce an image pull error and fix it
2. Break a service by changing its selector and then fix it
3. Create a pod with resource requests exceeding available node resources
4. Corrupt the API server configuration and repair it
5. Misconfigure a volume mount and troubleshoot the issue
6. Create conflicting network policies and resolve the connectivity issues
7. Simulate a node failure and recover the workloads

## What's Next

In the next part, we'll explore Mock Exam Questions with comprehensive solutions that bring together all the topics we've covered:
- Application deployment and management
- Services and networking
- Storage configuration
- Security implementation
- Cluster maintenance
- Troubleshooting complex scenarios

👉 Continue to **[Part 9: Mock Exam Questions](/training/cka-prep/09-mock-exam-questions/)**
