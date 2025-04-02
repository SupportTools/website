---
title: "RKE2 the Hard Way: Part 3 – Setting up containerd and kubelet"
description: "Installing and configuring containerd and kubelet on all nodes."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 3
draft: false
tags: ["kubernetes", "rke2", "containerd", "kubelet"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 3 of RKE2 the Hard Way, we set up containerd and kubelet, which will be the foundation for our Kubernetes cluster."
more_link: ""
---

## Part 3 – Setting up containerd and kubelet

In this part of the **"RKE2 the Hard Way"** training series, we will install and configure **containerd** (the container runtime) and **kubelet** (the Kubernetes node agent) on all our nodes. These components form the foundation of our Kubernetes cluster.

One of the key design decisions in RKE2 is to run the Kubernetes control plane components (etcd, kube-apiserver, kube-controller-manager, and kube-scheduler) as static pods managed by kubelet, rather than as systemd services. This approach simplifies deployment and maintenance, as kubelet manages the lifecycle of these critical components.

In this guide, we'll set up the necessary prerequisites to support this architecture.

> ✅ **Assumption:** All commands must be run on each node unless specified otherwise.

---

### 1. Install containerd

First, we'll install containerd as our container runtime:

```bash
# Install dependencies
apt-get update
apt-get install -y apt-transport-https ca-certificates curl software-properties-common

# Set up the Docker repository (which contains containerd)
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | apt-key add -
add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"

# Install containerd
apt-get update
apt-get install -y containerd.io

# Create default containerd configuration
mkdir -p /etc/containerd
containerd config default > /etc/containerd/config.toml

# Configure containerd with proper systemd cgroup settings
cat > /etc/containerd/config.toml << EOF
version = 2
root = "/var/lib/containerd"
state = "/run/containerd"

[grpc]
  address = "/run/containerd/containerd.sock"

[plugins]

  [plugins."io.containerd.grpc.v1.cri"]
    sandbox_image = "registry.k8s.io/pause:3.8"

    [plugins."io.containerd.grpc.v1.cri".containerd]
      default_runtime_name = "runc"
      snapshotter = "overlayfs"

      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"

          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            SystemdCgroup = true

  [plugins."io.containerd.grpc.v1.cri".cni]
    bin_dir = "/opt/cni/bin"
    conf_dir = "/etc/cni/net.d"

[plugins."io.containerd.runtime.v1.linux"]
  shim = "containerd-shim"
  runtime = "runc"
  runtime_root = ""
  no_shim = false
  shim_debug = false

[plugins."io.containerd.runtime.v2.task"]
  platforms = ["linux/amd64"]

[plugins."io.containerd.runtime.v2.runc"]
  options = { SystemdCgroup = true }

[cgroup]
  path = ""
EOF

# Make sure CNI directories exist
mkdir -p /opt/cni/bin /etc/cni/net.d

# Create a systemd override to ensure containerd uses our config file
mkdir -p /etc/systemd/system/containerd.service.d/
cat > /etc/systemd/system/containerd.service.d/override.conf << EOF
[Service]
ExecStart=
ExecStart=/usr/bin/containerd --config /etc/containerd/config.toml
EOF

# Reload systemd, restart and enable containerd
systemctl daemon-reload
systemctl restart containerd
systemctl enable containerd

# Verify the status after restart
systemctl status containerd
```

---

### 1.1 Install crictl and Verify containerd

We'll install `crictl`, which is a command-line interface for CRI-compatible container runtimes like containerd. This will allow us to interact with containerd and verify it's working correctly:

```bash
# Download crictl (version v1.32.0 in this example, matching our Kubernetes version)
CRICTL_VERSION="v1.32.0"
wget -q --show-progress --https-only --timestamping \
  "https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-amd64.tar.gz"

# Extract and install
tar -zxvf crictl-${CRICTL_VERSION}-linux-amd64.tar.gz
mv crictl /usr/local/bin/
rm crictl-${CRICTL_VERSION}-linux-amd64.tar.gz

# Configure crictl to use containerd
cat > /etc/crictl.yaml << EOF
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 10
debug: false
EOF
```

Now, verify that containerd is running correctly:

```bash
# Check containerd service status
systemctl status containerd

# Use crictl to verify connectivity to containerd
crictl version

# Example output should show both client and server versions:
# Version:  0.1.0
# RuntimeName:  containerd
# RuntimeVersion:  v1.6.x
# RuntimeApiVersion:  v1alpha2
```

If you see both client and server versions in the output, containerd is running correctly and crictl is properly configured to communicate with it.

---

### 2. Configure the System

Set up the necessary kernel modules and parameters:

```bash
# Load modules
cat > /etc/modules-load.d/k8s.conf << EOF
overlay
br_netfilter
EOF

modprobe overlay
modprobe br_netfilter

# Set kernel parameters
cat > /etc/sysctl.d/k8s.conf << EOF
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF

sysctl --system

# Disable swap
swapoff -a
sed -i '/swap/d' /etc/fstab
```

---

### 3. Install kubelet

Download and install the kubelet binary:

```bash
# Download kubelet binary (v1.32.3 in this example)
# First, return to your home directory if you're still in the CA directory from Part 2
cd $HOME

# Set the version and download with verbose output to see any potential issues
KUBELET_VERSION="v1.32.3"
wget -v --show-progress --https-only --timestamping \
  "https://dl.k8s.io/${KUBELET_VERSION}/bin/linux/amd64/kubelet"

# If the download above fails, try this alternative URL format
if [ ! -f kubelet ]; then
  echo "First download failed, trying alternative URL..."
  wget -v --show-progress --https-only --timestamping \
    "https://dl.k8s.io/release/${KUBELET_VERSION}/bin/linux/amd64/kubelet"
fi

# Verify the file exists before proceeding
if [ -f kubelet ]; then
  # Make the binary executable and move it to the appropriate directory
  chmod +x kubelet
  sudo mv kubelet /usr/local/bin/
  
  # Verify installation
  kubelet --version
else
  echo "ERROR: kubelet binary download failed. Please check network connectivity and URL."
  echo "You might try downloading directly in a browser and transferring the file."
fi
```

> **Note**: If you encounter download issues, try a different Kubernetes version (v1.27.6 is recommended for stability) or manually download the kubelet binary and transfer it to your system.

---

### 4. Create kubelet systemd Service

Create the systemd service file for kubelet:

```bash
cat > /etc/systemd/system/kubelet.service << EOF
[Unit]
Description=Kubernetes Kubelet
Documentation=https://github.com/kubernetes/kubernetes
After=containerd.service
Requires=containerd.service

[Service]
ExecStartPre=/bin/mkdir -p /var/lib/kubelet
ExecStartPre=/bin/mkdir -p /etc/kubernetes/manifests
ExecStart=/usr/local/bin/kubelet \\
  --config=/var/lib/kubelet/kubelet-config.yaml \\
  --container-runtime-endpoint=unix:///run/containerd/containerd.sock \\
  --kubeconfig=/var/lib/kubelet/kubeconfig \\
  --register-node=true \\
  --v=2

Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

---

### 5. Create Kubelet Configuration

Create the kubelet configuration file. We'll use sensible defaults for now:

```bash
mkdir -p /var/lib/kubelet

cat > /var/lib/kubelet/kubelet-config.yaml << EOF
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

> **Note**: Now that we've generated certificates in Part 2, we need to make them available to kubelet.

---

### 6. Link Certificates for Kubelet

In Part 2, we generated the necessary TLS certificates and copied them to `/etc/kubernetes/ssl/` on each node. Now we need to make them available at the location where kubelet expects to find them:

```bash
# Create the kubelet directory
mkdir -p /var/lib/kubelet/

# Create symbolic links to the certificates
sudo ln -sf /etc/kubernetes/ssl/ca.pem /var/lib/kubelet/
sudo ln -sf /etc/kubernetes/ssl/kubelet.pem /var/lib/kubelet/
sudo ln -sf /etc/kubernetes/ssl/kubelet-key.pem /var/lib/kubelet/

# Verify the symbolic links are in place
ls -la /var/lib/kubelet/
```

You should see the symbolic links to the CA certificate and the kubelet certificate and key for this node.

If you need to create actual copies instead of symbolic links (some systems might have issues with symlinks), you can use:

```bash
sudo cp /etc/kubernetes/ssl/ca.pem /var/lib/kubelet/
sudo cp /etc/kubernetes/ssl/kubelet.pem /var/lib/kubelet/
sudo cp /etc/kubernetes/ssl/kubelet-key.pem /var/lib/kubelet/
sudo chmod 600 /var/lib/kubelet/*-key.pem
sudo chmod 644 /var/lib/kubelet/*.pem
```

---

### 7. Prepare for Static Pods

Create the directory for static pod manifests:

```bash
mkdir -p /etc/kubernetes/manifests
```

This directory will be used to store the YAML manifests for our static pods (etcd, kube-apiserver, kube-controller-manager, kube-scheduler). When we place YAML files in this directory, kubelet will automatically create pods from these manifests.

---

### 8. Start and Verify kubelet Service

Now that we've set up the kubelet configuration, let's start the kubelet service:

```bash
# Enable and start the kubelet service
systemctl daemon-reload
systemctl enable kubelet
systemctl restart kubelet
```

Let's verify kubelet is running:

```bash
# Check kubelet service status
systemctl status kubelet
```

You'll likely see that kubelet is failing to start properly at this point, which is expected until we complete all the remaining steps. Let's check the logs to diagnose the issue:

```bash
# Get detailed kubelet logs with additional context
journalctl -u kubelet -n 100 --no-pager
```

Common errors you might encounter:

1. **Missing kubeconfig file** (this is the most common error and is expected):
   ```
   "failed to run Kubelet: invalid kubeconfig: stat /var/lib/kubelet/kubeconfig: no such file or directory"
   ```
   Let's create a temporary kubeconfig to get kubelet working. We'll create a proper one in Part 4, but this will allow us to proceed with setting up etcd as a static pod:

   ```bash
   # First, determine which node we're on and set the appropriate IP variable
   HOSTNAME=$(hostname)
   if [ "$HOSTNAME" = "node01" ]; then
     # Use the NODE1_IP variable we set in Part 2
     CURRENT_NODE_IP=${NODE1_IP}
   elif [ "$HOSTNAME" = "node02" ]; then
     CURRENT_NODE_IP=${NODE2_IP}
   elif [ "$HOSTNAME" = "node03" ]; then
     CURRENT_NODE_IP=${NODE3_IP}
   else
     echo "Unknown hostname: $HOSTNAME"
     exit 1
   fi
   
   # Create basic kubeconfig for kubelet 
   cat > /var/lib/kubelet/kubeconfig << EOF
   apiVersion: v1
   kind: Config
   clusters:
   - cluster:
       certificate-authority: /var/lib/kubelet/ca.pem
       server: https://${CURRENT_NODE_IP}:6443
     name: kubernetes
   contexts:
   - context:
       cluster: kubernetes
       user: kubelet
     name: kubelet
   current-context: kubelet
   users:
   - name: kubelet
     user:
       client-certificate: /var/lib/kubelet/kubelet.pem
       client-key: /var/lib/kubelet/kubelet-key.pem
   EOF
   ```

   After creating this file, restart kubelet:
   ```bash
   systemctl restart kubelet
   ```
   
   You may still see some errors in the kubelet logs since we haven't set up the API server yet, but this temporary kubeconfig will get kubelet running properly for static pods.

2. **Certificate issues**:
   ```
   failed to construct kubelet dependencies: unable to load client CA file /var/lib/kubelet/ca.pem: open /var/lib/kubelet/ca.pem: no such file or directory
   ```
   
   Ensure certificates are properly linked or copied:
   ```bash
   # Check if certificates exist and are accessible
   ls -la /etc/kubernetes/ssl/
   ls -la /var/lib/kubelet/
   
   # If not copied correctly, explicitly copy them (not just symlink)
   sudo cp /etc/kubernetes/ssl/ca.pem /var/lib/kubelet/
   sudo cp /etc/kubernetes/ssl/kubelet.pem /var/lib/kubelet/
   sudo cp /etc/kubernetes/ssl/kubelet-key.pem /var/lib/kubelet/
   sudo chmod 600 /var/lib/kubelet/*-key.pem
   sudo chmod 644 /var/lib/kubelet/ca.pem /var/lib/kubelet/kubelet.pem
   ```

3. **Container runtime connection failure**:
   ```
   Failed to connect to containerd: connection error: desc = "transport: Error while dialing dial unix:///run/containerd/containerd.sock: connect: no such file or directory"
   ```
   
   Check containerd status and socket:
   ```bash
   systemctl status containerd
   ls -la /run/containerd/containerd.sock
   ```

4. **CRI API version issues**:
   ```
   validate CRI v1 runtime API for endpoint "unix:///run/containerd/containerd.sock": rpc error: code = Unimplemented desc = unknown service runtime.v1.RuntimeService
   ```

   This error indicates that containerd's CRI plugin isn't properly configured. Fix it by:
   ```bash
   # Stop containerd and remove existing state
   systemctl stop containerd
   rm -rf /var/lib/containerd/*
   
   # Make sure containerd configuration has the CRI plugin enabled
   grep -A 5 "plugins.*cri" /etc/containerd/config.toml
   
   # Restart containerd and check status
   systemctl restart containerd
   systemctl status containerd
   
   # Restart kubelet
   systemctl restart kubelet
   ```

Don't worry if kubelet continues to show failures after these checks - it will remain in a failing state until we complete the entire setup by creating the kubeconfig file and setting up etcd in the following parts of this guide.

---

### 9. Verify Complete Setup

Let's make sure both containerd and kubelet services are properly configured:

#### Containerd verification:

```bash
# Verify containerd service is running
systemctl is-active containerd

# List running containerd processes
ps aux | grep containerd

# Check if crictl can communicate with containerd
crictl info
```

If these commands run without errors, containerd is properly set up.

#### Kubelet verification:

While kubelet won't be fully functional until we have certificates, we can verify the service is configured properly:

```bash
# Verify kubelet service is enabled
systemctl is-enabled kubelet

# Check if the kubelet binary is accessible
kubelet --version

# Verify kubelet config file exists
ls -la /var/lib/kubelet/kubelet-config.yaml

# Verify static pod directory exists
ls -la /etc/kubernetes/manifests
```

If these commands complete without errors, our foundation is properly set up for the next steps.

---

## Next Steps

Now that we have the foundational components (containerd and kubelet) installed and configured on all nodes, and have copied the certificates we generated in Part 2, we'll proceed to **Part 4** where we'll set up the **etcd cluster as static pods** managed by kubelet.

👉 Continue to **[Part 4: Setting up etcd Cluster as Static Pods](/training/rke2-hard-way/04-setting-up-etcd-cluster/)**
