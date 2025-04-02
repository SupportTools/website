---
title: "RKE2 the Hard Way: Part 8 – Installing Cilium CNI"
description: "Installing and configuring the Cilium CNI for Kubernetes networking."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 8
draft: false
tags: ["kubernetes", "rke2", "cilium", "cni", "networking"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 8 of RKE2 the Hard Way, we install Cilium CNI to provide networking and network policy enforcement for our Kubernetes cluster."
more_link: ""
---

## Part 8 – Installing Cilium CNI

In this part of the **"RKE2 the Hard Way"** training series, we will install and configure the **Cilium CNI** (Container Network Interface). Cilium is a powerful, open-source CNI solution that provides advanced networking, security, and observability features for Kubernetes clusters.

At this point in our tutorial series, we have:
- Set up all the core Kubernetes components (etcd, kube-apiserver, kube-controller-manager, kube-scheduler)
- Configured kubelet and kube-proxy on our nodes

However, our cluster network is not yet functional for pod-to-pod communication. The CNI plugin is essential for implementing the Kubernetes networking model, which requires that:
1. Every pod gets its own IP address
2. Pods on a node can communicate with all pods on all nodes without NAT
3. Agents on a node can communicate with all pods on that node

Cilium uses eBPF (extended Berkeley Packet Filter) technology to provide high-performance networking, security, and visibility in Kubernetes environments.

---

### 1. Prepare for Cilium Installation

First, ensure you have Helm installed on your workstation, as we'll use it to deploy Cilium:

```bash
# Check if Helm is installed
helm version

# If not installed, follow the Helm installation instructions:
# https://helm.sh/docs/intro/install/
```

---

### 2. Add the Cilium Helm Repository

Add the Cilium Helm repository:

```bash
helm repo add cilium https://helm.cilium.io/
helm repo update
```

---

### 3. Install Cilium via Helm

Use Helm to install Cilium into the kube-system namespace:

```bash
# Define the API server endpoint variable - use the local node's IP initially
# Important: We need to use the actual IP because the service IP (10.43.0.1) isn't available yet
API_SERVER_IP=$(hostname -I | awk '{print $1}')
echo "Using API server IP: $API_SERVER_IP"

# Install Cilium with proper configuration
helm install cilium cilium/cilium --version 1.15.4 \
  --namespace kube-system \
  --set kubeProxyReplacement=partial \
  --set k8sServiceHost=$API_SERVER_IP \
  --set k8sServicePort=6443 \
  --set ipam.mode=kubernetes \
  --set tunnel=disabled \
  --set routingMode=native \
  --set ipv4NativeRoutingCIDR="10.42.0.0/16"
```

> **Note:** The above configuration:
> - Uses the node's IP address to reach the Kubernetes API server directly
> - Uses port 6443 which is the standard kube-apiserver port
> - Disables tunneling for better performance (using direct routing)
> - Sets the CIDR range to match what we configured for kube-proxy
> 
> **Important:** We can't use the Kubernetes service IP (10.43.0.1) at this stage because services rely on CNI which we're currently setting up.

This Helm command:
- Installs Cilium agents on all nodes
- Configures Cilium to connect to your API server
- Sets up IPAM (IP Address Management) to use the Kubernetes allocator
- Configures partial kube-proxy replacement (you can set to `strict` if you want Cilium to completely replace kube-proxy)

---

### 4. Verify Cilium Installation

Check that the Cilium pods are running:

```bash
kubectl get pods -n kube-system -l k8s-app=cilium
```

Example output:

```
NAME           READY   STATUS    RESTARTS   AGE
cilium-7l9x8   1/1     Running   0          1m
cilium-f9xmt   1/1     Running   0          1m
cilium-rq9tl   1/1     Running   0          1m
```

Also check the Cilium operator pods:

```bash
kubectl get pods -n kube-system -l name=cilium-operator
```

Example output:

```
NAME                              READY   STATUS    RESTARTS   AGE
cilium-operator-xxxxxxxxxx-abcd   1/1     Running   0          1m
```

---

### 5. Install the Cilium CLI (Optional)

For better management and diagnostics, you might want to install the Cilium CLI on your workstation:

```bash
# For Linux
curl -L --remote-name-all https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
tar xzvf cilium-linux-amd64.tar.gz
sudo mv cilium /usr/local/bin/

# For macOS
brew install cilium-cli
```

---

### 6. Verify Cluster Connectivity

Once Cilium is installed, you should be able to create pods that can communicate with each other. Let's create a simple test:

```bash
# Create a test namespace
kubectl create ns cilium-test

# Launch test pods
kubectl run ping-a --image=busybox -n cilium-test -- sleep 3600
kubectl run ping-b --image=busybox -n cilium-test -- sleep 3600

# Wait for pods to become ready
kubectl wait --for=condition=Ready pod/ping-a -n cilium-test
kubectl wait --for=condition=Ready pod/ping-b -n cilium-test

# Get the IP of ping-b
PING_B_IP=$(kubectl get pod ping-b -n cilium-test -o jsonpath='{.status.podIP}')

# Have ping-a ping ping-b
kubectl exec -n cilium-test ping-a -- ping -c 5 $PING_B_IP
```

If the ping is successful, your pod networking is working correctly.

---

### 7. Clean Up Test Resources

Once you've verified connectivity, clean up the test resources:

```bash
kubectl delete ns cilium-test
```

---

## Next Steps

With Cilium CNI successfully installed and providing networking for our cluster, we'll proceed to **Part 9** where we'll install **CoreDNS for DNS resolution** within our cluster.

👉 Continue to **[Part 9: Installing CoreDNS](/training/rke2-hard-way/09-installing-coredns/)**
