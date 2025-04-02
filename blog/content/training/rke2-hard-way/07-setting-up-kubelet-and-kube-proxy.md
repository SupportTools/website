---
title: "RKE2 the Hard Way: Part 7 – Setting up kubelet and kube-proxy on Worker Nodes"
description: "Configuring kubelet to register with the Kubernetes API server and setting up kube-proxy for cluster networking."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 7
draft: false
tags: ["kubernetes", "rke2", "kubelet", "kube-proxy", "worker-nodes"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 7 of RKE2 the Hard Way, we configure kubelet to register with the Kubernetes API server and set up kube-proxy for service networking."
more_link: ""
---

## Part 7 – Setting up kubelet and kube-proxy on Worker Nodes

In this part of the **"RKE2 the Hard Way"** training series, we will configure **kubelet** to register with the Kubernetes API server and set up **kube-proxy** on our nodes. We already installed containerd and kubelet in [Part 3](/training/rke2-hard-way/03-setting-up-containerd-and-kubelet/), but now we need to finalize their configuration to connect to our Kubernetes control plane.

- **kubelet** is the primary node agent that runs on each node. It ensures containers are running in a Pod and healthy.
- **kube-proxy** maintains network rules on nodes. These network rules allow network communication to your Pods from inside or outside of your cluster.

> ✅ **Note:** In our setup, all nodes (node01, node02, node03) are both control plane and worker nodes. This is common for smaller clusters and provides high availability without needing separate worker nodes.

---

### 1. Download kube-proxy Binary

First, download the kube-proxy binary on each node (if you haven't already):

```bash
# Download kube-proxy binary
KUBERNETES_VERSION="v1.32.3"
wget -q --show-progress --https-only --timestamping \
  "https://dl.k8s.io/${KUBERNETES_VERSION}/bin/linux/amd64/kube-proxy"

# Make it executable
chmod +x kube-proxy

# Move it to the appropriate directory
sudo mv kube-proxy /usr/local/bin/
```

---

### 2. Set Variables

First, set the necessary variables that we'll use throughout this process:

```bash
# Variables
NODE_NAME=$(hostname)
NODE_IP=$(hostname -I | awk '{print $1}')
API_SERVER_ENDPOINT="https://127.0.0.1:6443"  # Default to local API server on control plane nodes
# If using a load balancer, you can use this instead:
# API_SERVER_ENDPOINT="https://<LOAD_BALANCER_IP>:6443"

# Verify the variables
echo "Node name: $NODE_NAME"
echo "Node IP: $NODE_IP"
echo "API server endpoint: $API_SERVER_ENDPOINT"
```

> **Note:** We already generated all the necessary certificates in [Part 2](/training/rke2-hard-way/02-certificate-authority-tls-certificates/). They should be located in `/etc/kubernetes/ssl/` directory. We'll now use these certificates to configure the kubelet.

### 3. Create kubelet kubeconfig File

Now, create a kubeconfig file for kubelet on each node to authenticate with the Kubernetes API server:

```bash
# Create kubelet kubeconfig
kubectl config set-cluster kubernetes-the-hard-way \
  --certificate-authority=/etc/kubernetes/ssl/ca.pem \
  --embed-certs=true \
  --server=${API_SERVER_ENDPOINT} \
  --kubeconfig=kubelet.kubeconfig

kubectl config set-credentials system:node:${NODE_NAME} \
  --client-certificate=/etc/kubernetes/ssl/kubelet.pem \
  --client-key=/etc/kubernetes/ssl/kubelet-key.pem \
  --embed-certs=true \
  --kubeconfig=kubelet.kubeconfig

kubectl config set-context default \
  --cluster=kubernetes-the-hard-way \
  --user=system:node:${NODE_NAME} \
  --kubeconfig=kubelet.kubeconfig

kubectl config use-context default --kubeconfig=kubelet.kubeconfig

# Move the kubeconfig file to its final location
sudo mkdir -p /var/lib/kubelet/
sudo mv kubelet.kubeconfig /var/lib/kubelet/kubeconfig
```

---

### 4. Update kubelet Configuration

We need to update the kubelet configuration to register with the Kubernetes API server:

```bash
# Copy certificates to the kubelet directory for easier access
sudo cp /etc/kubernetes/ssl/ca.pem /etc/kubernetes/ssl/kubelet.pem /etc/kubernetes/ssl/kubelet-key.pem /var/lib/kubelet/

# Update the kubelet configuration file
sudo cat > /var/lib/kubelet/kubelet-config.yaml << EOF
kind: KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: "/var/lib/kubelet/ca.pem"
authorization:
  mode: Webhook
clusterDomain: "cluster.local"
clusterDNS:
  - "10.43.0.10"
resolvConf: "/run/systemd/resolve/resolv.conf"
runtimeRequestTimeout: "15m"
tlsCertFile: "/var/lib/kubelet/kubelet.pem"
tlsPrivateKeyFile: "/var/lib/kubelet/kubelet-key.pem"
registerNode: true
staticPodPath: "/etc/kubernetes/manifests"
cgroupDriver: "systemd"
featureGates:
  RotateKubeletServerCertificate: true
serializeImagePulls: false
EOF
```

---

### 5. Create kube-proxy kubeconfig File

Create a kubeconfig file for kube-proxy:

```bash
# Create kube-proxy kubeconfig
kubectl config set-cluster kubernetes-the-hard-way \
  --certificate-authority=/etc/kubernetes/ssl/ca.pem \
  --embed-certs=true \
  --server=${API_SERVER_ENDPOINT} \
  --kubeconfig=kube-proxy.kubeconfig

kubectl config set-credentials system:kube-proxy \
  --client-certificate=/etc/kubernetes/ssl/kubernetes.pem \
  --client-key=/etc/kubernetes/ssl/kubernetes-key.pem \
  --embed-certs=true \
  --kubeconfig=kube-proxy.kubeconfig

kubectl config set-context default \
  --cluster=kubernetes-the-hard-way \
  --user=system:kube-proxy \
  --kubeconfig=kube-proxy.kubeconfig

kubectl config use-context default --kubeconfig=kube-proxy.kubeconfig

# Create directory for kube-proxy
sudo mkdir -p /var/lib/kube-proxy

# Move the kubeconfig file to its final location
sudo mv kube-proxy.kubeconfig /var/lib/kube-proxy/kubeconfig
```

---

### 6. Create kube-proxy Configuration

Create a configuration file for kube-proxy:

```bash
sudo cat > /var/lib/kube-proxy/kube-proxy-config.yaml << EOF
kind: KubeProxyConfiguration
apiVersion: kubeproxy.config.k8s.io/v1alpha1
clientConnection:
  kubeconfig: "/var/lib/kube-proxy/kubeconfig"
mode: "iptables"
clusterCIDR: "10.42.0.0/16"
EOF
```

---

### 7. Create kube-proxy Static Pod Manifest

Now, create the static pod manifest for kube-proxy:

```bash
sudo cat > /etc/kubernetes/manifests/kube-proxy.yaml << EOF
apiVersion: v1
kind: Pod
metadata:
  name: kube-proxy
  namespace: kube-system
  labels:
    component: kube-proxy
    tier: node
spec:
  hostNetwork: true
  priorityClassName: system-node-critical
  containers:
  - name: kube-proxy
    image: registry.k8s.io/kube-proxy:${KUBERNETES_VERSION}
    command:
    - /usr/local/bin/kube-proxy
    - --config=/var/lib/kube-proxy/kube-proxy-config.yaml
    - --hostname-override=${NODE_NAME}
    securityContext:
      privileged: true
    volumeMounts:
    - mountPath: /var/lib/kube-proxy
      name: kube-proxy
    - mountPath: /run/xtables.lock
      name: xtables-lock
    - mountPath: /lib/modules
      name: lib-modules
      readOnly: true
  volumes:
  - name: kube-proxy
    hostPath:
      path: /var/lib/kube-proxy
  - name: xtables-lock
    hostPath:
      path: /run/xtables.lock
      type: FileOrCreate
  - name: lib-modules
    hostPath:
      path: /lib/modules
EOF
```

---

### 8. Verify Certificates

Verify that all the necessary certificates are in place:

```bash
# Check that certificates exist in the correct location
ls -la /etc/kubernetes/ssl/

# Verify node-specific certificates
ls -la /etc/kubernetes/ssl/kubelet.pem
ls -la /etc/kubernetes/ssl/kubelet-key.pem

# Verify other required certificates
ls -la /etc/kubernetes/ssl/ca.pem
ls -la /etc/kubernetes/ssl/kubernetes.pem
ls -la /etc/kubernetes/ssl/kubernetes-key.pem
```

> **Note:** If any certificates are missing, revisit [Part 2](/training/rke2-hard-way/02-certificate-authority-tls-certificates/) and ensure all certificates were properly generated and distributed to the nodes.

---

### 9. Restart kubelet Service

Now that we've updated the kubelet configuration, restart the kubelet service:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

---

### 10. Verify Node Registration

After a few moments, the nodes should register with the Kubernetes API server. Verify this by running:

```bash
kubectl get nodes
```

You should see all three nodes listed. Their status might initially be `NotReady` because we haven't set up a CNI plugin yet.

---

### 11. Verify kube-proxy Deployment

Check that kube-proxy is running as a static pod:

```bash
sudo crictl pods | grep kube-proxy
sudo crictl ps | grep kube-proxy
```

You can also check the logs:

```bash
# Find the container ID first
CONTAINER_ID=$(sudo crictl ps | grep kube-proxy | awk '{print $1}')
sudo crictl logs $CONTAINER_ID
```

---

## Next Steps

Now that we have completed the core Kubernetes components setup (etcd, kube-apiserver, kube-controller-manager, kube-scheduler, kubelet, and kube-proxy), we'll proceed to **Part 8** where we'll set up **Cilium as our Container Network Interface (CNI)** to enable pod networking.

👉 Continue to **[Part 8: Installing Cilium CNI](/training/rke2-hard-way/08-installing-cilium-cni/)**
