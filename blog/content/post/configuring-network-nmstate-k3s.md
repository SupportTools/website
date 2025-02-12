---
title: "How to Configure Network Interfaces in K3s Using NMState and Multus CNI"
date: 2025-03-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "K3s", "NMState", "Multus", "Networking", "CNI", "Network Configuration", "Container Networking", "Linux Networking", "Network Management"]
categories:
- Kubernetes
- Networking
- K3s
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to configuring network interfaces in K3s using NMState Operator and Multus CNI. Learn how to set up advanced networking, create network bridges, and manage multiple interfaces in Kubernetes clusters."
more_link: "yes"
url: "/configuring-network-nmstate-k3s/"
---

Managing network interfaces in Kubernetes can be challenging, especially when dealing with multiple networks or complex configurations. This comprehensive guide demonstrates how to use the NMState Operator and Multus CNI in K3s to implement advanced networking configurations, create network bridges, and manage multiple network interfaces effectively.

<!--more-->

# [Overview and Prerequisites](#overview)
Before we begin implementing advanced networking in K3s, ensure you have:
- A Linux machine or VM with K3s installed
- Two network interfaces available:
  - Primary interface for Kubernetes networking
  - Secondary interface for NMState-managed bridging
- Root/sudo privileges on the system
- Basic understanding of Kubernetes networking concepts

# [Setting Up K3s with k3sup](#k3s-setup)
We'll use `k3sup` for a streamlined K3s installation process:

```bash
curl -sLS https://get.k3sup.dev | sh

mkdir /root/.kube
IP=192.168.100.10

k3sup install --ip $IP --local --context pik3s \
  --merge \
  --local-path $HOME/.kube/config

k3sup ready --context pik3s
```

# [Installing and Configuring NMState Operator](#nmstate-installation)
## Setting Up Dependencies
First, install the required system packages:

```bash
yum install -y NetworkManager
systemctl start NetworkManager

dnf copr enable nmstate/nmstate
dnf install nmstate
```

## Deploying NMState Components
Apply the necessary Kubernetes resources:

```bash
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.80.1/nmstate.io_nmstates.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.80.1/namespace.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.80.1/service_account.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.80.1/role.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.80.1/role_binding.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.80.1/operator.yaml
```

## Creating the NMState Custom Resource
```yaml
apiVersion: nmstate.io/v1
kind: NMState
metadata:
  name: nmstate
```

# [Implementing Bridge Networking with NMState](#bridge-networking)
Create a bridge interface using NodeNetworkConfigurationPolicy:

```yaml
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: br1-enp0s9
spec:
  desiredState:
    interfaces:
    - name: br1
      type: linux-bridge
      state: up
      ipv4:
        address:
        - ip: 192.168.200.10
          prefix-length: 24
        dhcp: false
        enabled: true
      bridge:
        port:
        - name: enp0s9
```

# [Integrating Multus CNI](#multus-integration)
## Installation Process
Download and customize the Multus DaemonSet:

```bash
wget https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml
```

Add the Multus kubeconfig configuration:
```yaml
- "--multus-kubeconfig-file-host=/var/lib/rancher/k3s/agent/etc/cni/net.d/multus.d/multus.kubeconfig"
```

## Creating Network Attachment Definition
```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: multus-br1
spec:
  config: |
    {
      "cniVersion": "0.3.1",
      "type": "bridge",
      "bridge": "br1",
      "ipam": {
        "type": "host-local",
        "subnet": "192.168.200.0/24",
        "rangeStart": "192.168.200.240",
        "rangeEnd": "192.168.200.250"
      }
    }
```

# [Testing Multi-Interface Pod Deployment](#testing)
## Creating a Test Pod
Deploy a pod with multiple network interfaces:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: net-pod
  annotations:
    k8s.v1.cni.cncf.io/networks: multus-br1
spec:
  containers:
  - name: netshoot-pod
    image: nicolaka/netshoot
    command: ["tail"]
    args: ["-f", "/dev/null"]
  terminationGracePeriodSeconds: 0
```

## Verifying Network Configuration
Check network interface configuration:
```bash
kubectl exec -it net-pod -- ip addr
```

## Testing Network Connectivity
Verify pod-to-pod and pod-to-host communication:
```bash
# Pod to Pod
kubectl exec -it net-pod -- ping -c 1 -I net1 192.168.200.241

# Pod to Host
kubectl exec -it net-pod -- ping -c 1 -I net1 192.168.200.10
```

# [Troubleshooting and Best Practices](#troubleshooting)
- Always verify NetworkManager is running before applying NMState configurations
- Check pod logs and events for networking issues
- Ensure proper IPAM configuration to avoid IP conflicts
- Monitor network performance and connectivity regularly
- Keep CNI plugins and operators updated to their latest stable versions

# [Conclusion](#conclusion)
This guide demonstrated how to implement advanced networking in K3s using NMState and Multus CNI. We covered:
- Setting up K3s with proper networking prerequisites
- Implementing NMState for network interface management
- Configuring Multus CNI for multi-interface support
- Creating and testing network bridges
- Deploying and validating multi-interface pods

These tools provide powerful networking capabilities for your Kubernetes clusters, enabling complex network configurations while maintaining manageability and scalability.

For more Kubernetes networking guides and best practices, [visit our blog](https://support.tools).
