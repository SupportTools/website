---
title: "Complete Guide: Install Kubernetes Cluster on Ubuntu with Kubeadm and Swap Support"
date: 2025-02-14T02:00:00-05:00
draft: false
tags: ["Kubernetes", "kubeadm", "Containerd", "CgroupV2", "Swap", "Ubuntu", "Container Runtime", "Cluster Installation", "DevOps", "Container Orchestration", "K8s Installation", "System Administration"]
categories:
- Kubernetes
- Installation Guide
- System Administration
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to install a production-ready Kubernetes cluster on Ubuntu using kubeadm. This comprehensive guide covers enabling swap support, configuring CgroupV2, setting up containerd, and troubleshooting common issues for a successful deployment."
more_link: "yes"
url: "/install-kubernetes-kubeadm-ubuntu/"
---

Setting up a Kubernetes cluster can be complex, but kubeadm simplifies the process significantly. This comprehensive guide walks you through installing a production-ready Kubernetes cluster on Ubuntu, with advanced features like swap support, CgroupV2 configuration, and containerd setup. Whether you're building a development environment or preparing for production deployment, this guide provides all the necessary steps and best practices.

<!--more-->

# [System Requirements and Prerequisites](#prerequisites)
Before beginning the installation, ensure your system meets these requirements:

## Hardware Requirements
- Minimum 4 CPU cores
- 16GB RAM (8GB minimum for testing)
- 50GB available disk space
- Static IP address configured (Example: `192.168.1.41` for master node)

## Software Requirements
- Ubuntu 20.04 LTS or newer
- Root or sudo privileges
- Internet connectivity for package downloads

# [Preparing the System](#system-preparation)
## Configuring CgroupV2
Enable CgroupV2 for improved container resource management:

```bash
sudo apt update && sudo apt install -y grub2-common
sudo sed -i 's/GRUB_CMDLINE_LINUX=""/GRUB_CMDLINE_LINUX="systemd.unified_cgroup_hierarchy=1"/' /etc/default/grub
sudo update-grub
sudo reboot
```

## Setting Up System Configuration
Configure essential system settings:

```bash
# Set timezone
timedatectl set-timezone Europe/Budapest

# Install required utilities
sudo apt install -y chrony net-tools vim

# Enable and start chronyd for time synchronization
sudo systemctl enable --now chronyd

# Disable unnecessary services
sudo systemctl stop ufw
sudo systemctl disable ufw
sudo systemctl disable apparmor
sudo systemctl stop apparmor
```

# [Installing Container Runtime](#container-runtime)
## Setting Up Containerd
Install and configure containerd as the container runtime:

```bash
# Install containerd
sudo apt update
sudo apt install -y containerd

# Create default configuration
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
```

## Configuring Containerd
Modify containerd configuration for Kubernetes compatibility:

```bash
# Enable SystemdCgroup
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# Configure kernel modules
cat <<EOF | sudo tee /etc/modules-load.d/containerd.conf
overlay
br_netfilter
EOF

# Load kernel modules
sudo modprobe overlay
sudo modprobe br_netfilter

# Configure system settings
cat <<EOF | sudo tee /etc/sysctl.d/99-kubernetes-cri.conf
net.bridge.bridge-nf-call-iptables  = 1
net.ipv4.ip_forward                 = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF

sudo sysctl --system
```

# [Installing Kubernetes Components](#kubernetes-installation)
## Installing Required Packages
Install kubeadm, kubelet, and kubectl:

```bash
# Add Kubernetes repository
sudo apt update
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo apt-key add -
echo "deb https://apt.kubernetes.io/ kubernetes-xenial main" | sudo tee /etc/apt/sources.list.d/kubernetes.list

# Install Kubernetes components
sudo apt update
sudo apt install -y kubelet kubeadm kubectl
```

## Configuring Kubelet for Swap Support
Enable swap support in kubelet configuration:

```bash
cat << EOF | sudo tee /etc/default/kubelet
KUBELET_EXTRA_ARGS="--node-ip=192.168.1.41 --cgroup-driver=systemd --fail-swap-on=false"
EOF

# Enable and start kubelet
sudo systemctl enable --now kubelet
sudo systemctl status kubelet

# Pull required images
sudo kubeadm config images pull
```

# [Initializing the Kubernetes Cluster](#cluster-initialization)
## Creating the Cluster Configuration
Create a kubeadm configuration file:

```yaml
apiVersion: "kubeadm.k8s.io/v1beta3"
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: 192.168.100.10
  bindPort: 6443
nodeRegistration:
  criSocket: unix:///run/containerd/containerd.sock
  imagePullPolicy: IfNotPresent
  taints: null
  kubeletExtraArgs:
    runtime-cgroups: "/system.slice/containerd.service"
    rotate-server-certificates: "true"
---
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
controlPlaneEndpoint: "192.168.100.10:6443"
networking:
  serviceSubnet: "10.96.0.0/12"
  podSubnet: "10.244.0.0/16"
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
enableServer: true
failSwapOn: false
cgroupDriver: "systemd"
featureGates:
  NodeSwap: true
memorySwap:
  swapBehavior: LimitedSwap
```

## Initializing the Control Plane
Initialize the Kubernetes control plane:

```bash
# Initialize cluster
sudo kubeadm init --config kubeadm-config.yaml

# Configure kubectl
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# Install network plugin (Flannel)
kubectl apply -f https://github.com/coreos/flannel/raw/master/Documentation/kube-flannel.yml
```

# [Adding Worker Nodes](#worker-nodes)
Join worker nodes to the cluster using the token provided during initialization:

```bash
kubeadm join 192.168.100.10:6443 --token XXXXXXXX \
    --discovery-token-ca-cert-hash sha256:XXXXXXXX
```

# [Post-Installation Setup](#post-installation)
## Installing Additional Tools
Enhance your cluster management capabilities:

```bash
sudo apt install -y kubectx helm
```

## Verifying the Installation
Check cluster status and component health:

```bash
# Verify node status
kubectl get nodes

# Check pod status
kubectl get pods --all-namespaces

# Verify cluster info
kubectl cluster-info
```

# [Troubleshooting Common Issues](#troubleshooting)
- **Pod Network Issues**: Ensure proper network plugin configuration
- **Node Status NotReady**: Check kubelet status and logs
- **Container Runtime Errors**: Verify containerd configuration
- **Certificate Issues**: Check certificate expiration and renewal
- **Memory/Swap Errors**: Verify swap configuration in kubelet

# [Best Practices and Security Considerations](#best-practices)
1. **Regular Updates**: Keep all components updated
2. **Backup Strategy**: Implement regular etcd backups
3. **Security Hardening**: 
   - Enable RBAC
   - Use network policies
   - Implement pod security standards
4. **Resource Management**:
   - Configure resource quotas
   - Implement limit ranges
5. **Monitoring**:
   - Set up monitoring tools
   - Configure logging solutions

# [Conclusion](#conclusion)
You now have a fully functional Kubernetes cluster with swap support running on Ubuntu. This setup provides a solid foundation for running containerized applications in both development and production environments. Remember to regularly update components and follow security best practices to maintain a healthy cluster.

For more Kubernetes guides and best practices, [visit our blog](https://support.tools).
