---
title: "RKE2 the Hard Way: Part 2 – Certificate Authority and TLS Certificates"
description: "Setting up a Certificate Authority and generating TLS certificates for Kubernetes components."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 2
draft: false
tags: ["kubernetes", "rke2", "tls", "certificates", "cfssl"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 2 of RKE2 the Hard Way, we configure a Certificate Authority (CA) and generate the TLS certificates required for securing Kubernetes."
more_link: ""
---

## Part 2 – Certificate Authority and TLS Certificates

In this part of the **"RKE2 the Hard Way"** training series, we will set up our own **Certificate Authority (CA)** and generate the necessary **TLS certificates** for securing our Kubernetes cluster. Kubernetes components communicate over TLS, and properly configured certificates are crucial for cluster security.

We'll use [`cfssl`](https://github.com/cloudflare/cfssl), Cloudflare's TLS toolkit, to create our CA and generate certificates.

> ✅ **Assumption:** All commands in this guide are run from `node01`, which is a Linux box.

### 0. Set Node IP Variables

Let's start by setting the IP addresses of our nodes as variables to make the rest of the commands easier to use without manual replacements:

```bash
# Set these variables to match your actual node IPs
export NODE1_IP=$(getent hosts node01 | awk '{print $1}')
export NODE2_IP=$(getent hosts node02 | awk '{print $1}')
export NODE3_IP=$(getent hosts node03 | awk '{print $1}')

# Verify the variables were set correctly
echo "Node1 IP: $NODE1_IP"
echo "Node2 IP: $NODE2_IP"
echo "Node3 IP: $NODE3_IP"
```

If the node IPs are not correctly resolved from the hostnames, you can set them manually:

```bash
# Only use this if the above method didn't work
# Replace these with your actual node IPs
export NODE1_IP=192.168.1.101
export NODE2_IP=192.168.1.102
export NODE3_IP=192.168.1.103

# Verify the variables
echo "Node1 IP: $NODE1_IP"
echo "Node2 IP: $NODE2_IP"
echo "Node3 IP: $NODE3_IP"
```

---

### 1. Install cfssl Tools

Download and install `cfssl` and `cfssljson` on `node01`:

```bash
# Download cfssl version 1.6.4 (a stable version)
curl -s -L -o /usr/local/bin/cfssl https://github.com/cloudflare/cfssl/releases/download/v1.6.4/cfssl_1.6.4_linux_amd64
curl -s -L -o /usr/local/bin/cfssljson https://github.com/cloudflare/cfssl/releases/download/v1.6.4/cfssljson_1.6.4_linux_amd64

# Make them executable
chmod +x /usr/local/bin/cfssl /usr/local/bin/cfssljson

# Verify installation
cfssl version
cfssljson --version
```

You should see output indicating the version of cfssl tools. If you encounter any issues downloading these binaries, you can try alternative methods:

```bash
# Alternative: Install using Go (if you have Go installed)
go install github.com/cloudflare/cfssl/cmd/cfssl@latest
go install github.com/cloudflare/cfssl/cmd/cfssljson@latest

# Or download pre-compiled binaries from the official distribution site
# For example:
wget -q --show-progress --https-only --timestamping \
  https://storage.googleapis.com/kubernetes-the-hard-way/cfssl/1.4.1/linux/cfssl \
  https://storage.googleapis.com/kubernetes-the-hard-way/cfssl/1.4.1/linux/cfssljson
chmod +x cfssl cfssljson
sudo mv cfssl cfssljson /usr/local/bin/
```

---

### 2. Create CA Configuration Files

Create a directory to store the CA and certificate files:

```bash
mkdir ca
cd ca
```

Create a file named `ca-config.json` using the following command:

```bash
cat > ca-config.json << EOF
{
  "signing": {
    "default": {
      "expiry": "8760h"
    },
    "profiles": {
      "kubernetes": {
        "usages": [
          "signing",
          "key encipherment",
          "server auth",
          "client auth"
        ],
        "expiry": "8760h"
      }
    }
  }
}
EOF
```

Then, create a file named `ca-csr.json`:

```bash
cat > ca-csr.json << EOF
{
  "CN": "kubernetes-ca",
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Rancher",
      "O": "SupportTools",
      "OU": "Kubernetes The Hard Way",
      "ST": "SUSE"
    }
  ]
}
EOF
```

---

### 3. Generate the CA Certificate and Key

```bash
cfssl gencert -initca ca-csr.json | cfssljson -bare ca
```

You should now have:

- `ca.pem`: CA certificate  
- `ca-key.pem`: CA private key

> 🔐 **Important:** Protect `ca-key.pem`. In production, use a secure vault or HSM to store it.

---

### 4. Generate Kubernetes API Server Certificate and Key

Create the Kubernetes API server certificate request file:

```bash
cat > kubernetes-csr.json << EOF
{
  "CN": "kubernetes",
  "hosts": [
    "127.0.0.1",
    "kubernetes",
    "kubernetes.default",
    "kubernetes.default.svc",
    "kubernetes.default.svc.cluster",
    "kubernetes.default.svc.cluster.local",
    "${NODE1_IP}",
    "${NODE2_IP}",
    "${NODE3_IP}",
    "node01",
    "node02",
    "node03"
  ],
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Rancher",
      "O": "SupportTools",
      "OU": "Kubernetes The Hard Way",
      "ST": "SUSE"
    }
  ]
}
EOF
```

Generate the certificate:

```bash
cfssl gencert \
  -profile=kubernetes \
  -ca=ca.pem \
  -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="127.0.0.1,kubernetes,kubernetes.default,kubernetes.default.svc,kubernetes.default.svc.cluster,kubernetes.default.svc.cluster.local,${NODE1_IP},${NODE2_IP},${NODE3_IP},node01,node02,node03" \
  kubernetes-csr.json | cfssljson -bare kubernetes
```

---

### 5. Generate Kubelet Client Certificates

For each node, create a kubelet certificate request file. Here's how to do it for node01 (repeat for each node):

```bash
cat > kubelet-node01-csr.json << EOF
{
  "CN": "system:node:node01",
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Rancher",
      "O": "system:nodes",
      "OU": "Kubernetes The Hard Way",
      "ST": "SUSE"
    }
  ]
}
EOF
```

Similarly for node02:

```bash
cat > kubelet-node02-csr.json << EOF
{
  "CN": "system:node:node02",
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Rancher",
      "O": "system:nodes",
      "OU": "Kubernetes The Hard Way",
      "ST": "SUSE"
    }
  ]
}
EOF
```

And for node03:

```bash
cat > kubelet-node03-csr.json << EOF
{
  "CN": "system:node:node03",
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Rancher",
      "O": "system:nodes",
      "OU": "Kubernetes The Hard Way",
      "ST": "SUSE"
    }
  ]
}
EOF
```

Generate the certificates for each node:

```bash
# For node01
cfssl gencert \
  -profile=kubernetes \
  -ca=ca.pem \
  -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="node01,${NODE1_IP}" \
  kubelet-node01-csr.json | cfssljson -bare kubelet-node01

# For node02
cfssl gencert \
  -profile=kubernetes \
  -ca=ca.pem \
  -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="node02,${NODE2_IP}" \
  kubelet-node02-csr.json | cfssljson -bare kubelet-node02

# For node03
cfssl gencert \
  -profile=kubernetes \
  -ca=ca.pem \
  -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="node03,${NODE3_IP}" \
  kubelet-node03-csr.json | cfssljson -bare kubelet-node03
```

---

### 6. Generate Admin Client Certificate

Create the admin client certificate request file:

```bash
cat > admin-csr.json << EOF
{
  "CN": "admin",
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Rancher",
      "O": "system:masters",
      "OU": "Kubernetes The Hard Way",
      "ST": "SUSE"
    }
  ]
}
EOF
```

Then:

```bash
cfssl gencert \
  -profile=kubernetes \
  -ca=ca.pem \
  -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="" \
  admin-csr.json | cfssljson -bare admin
```

---

### 7. Generate Service Account Key Pair

```bash
openssl genrsa -out service-account-key.pem 2048
openssl rsa -in service-account-key.pem -pubout -out service-account.pem
```

---

### 8. Organize Certificates

```bash
mkdir certs
mv ca*.pem kubernetes*.pem kubelet-*.pem admin*.pem service-account*.pem certs/
```

Your `certs/` directory now contains all the necessary files for the next steps.

---

### 9. Distribute Certificates to All Nodes

Each node (including node01) needs both the common certificates and its specific node certificates in the appropriate location.

#### First, set up certificates on node01:

```bash
# Create the destination directory on node01
sudo mkdir -p /etc/kubernetes/ssl/

# Copy the common certificates to node01
sudo cp certs/ca.pem /etc/kubernetes/ssl/
sudo cp certs/kubernetes*.pem /etc/kubernetes/ssl/
sudo cp certs/service-account*.pem /etc/kubernetes/ssl/
sudo cp certs/admin*.pem /etc/kubernetes/ssl/

# Copy and rename node-specific certificates for kubelet on node01
sudo cp certs/kubelet-node01.pem /etc/kubernetes/ssl/kubelet.pem
sudo cp certs/kubelet-node01-key.pem /etc/kubernetes/ssl/kubelet-key.pem

# Set proper permissions on node01
sudo chmod 600 /etc/kubernetes/ssl/*-key.pem
sudo chmod 644 /etc/kubernetes/ssl/*.pem

# Verify certificates on node01
ls -la /etc/kubernetes/ssl/
```

#### Next, set up certificates on node02 and node03:

```bash
# For node02
# First ensure SSH access is configured
ssh-copy-id node02   # If not already done

# Create directory on node02
ssh node02 "sudo mkdir -p /etc/kubernetes/ssl/"

# Copy the common certificates
rsync -avz certs/ca.pem certs/kubernetes*.pem certs/service-account*.pem certs/admin*.pem node02:/tmp/
ssh node02 "sudo mv /tmp/ca.pem /tmp/kubernetes*.pem /tmp/service-account*.pem /tmp/admin*.pem /etc/kubernetes/ssl/"

# Copy node-specific certificates
rsync -avz certs/kubelet-node02*.pem node02:/tmp/
ssh node02 "sudo mv /tmp/kubelet-node02.pem /etc/kubernetes/ssl/kubelet.pem"
ssh node02 "sudo mv /tmp/kubelet-node02-key.pem /etc/kubernetes/ssl/kubelet-key.pem"

# Set proper permissions on node02
ssh node02 "sudo chmod 600 /etc/kubernetes/ssl/*-key.pem"
ssh node02 "sudo chmod 644 /etc/kubernetes/ssl/*.pem"

# Verify certificates on node02
ssh node02 "ls -la /etc/kubernetes/ssl/"

# For node03
# First ensure SSH access is configured
ssh-copy-id node03   # If not already done

# Create directory on node03
ssh node03 "sudo mkdir -p /etc/kubernetes/ssl/"

# Copy the common certificates
rsync -avz certs/ca.pem certs/kubernetes*.pem certs/service-account*.pem certs/admin*.pem node03:/tmp/
ssh node03 "sudo mv /tmp/ca.pem /tmp/kubernetes*.pem /tmp/service-account*.pem /tmp/admin*.pem /etc/kubernetes/ssl/"

# Copy node-specific certificates
rsync -avz certs/kubelet-node03*.pem node03:/tmp/
ssh node03 "sudo mv /tmp/kubelet-node03.pem /etc/kubernetes/ssl/kubelet.pem"
ssh node03 "sudo mv /tmp/kubelet-node03-key.pem /etc/kubernetes/ssl/kubelet-key.pem"

# Set proper permissions on node03
ssh node03 "sudo chmod 600 /etc/kubernetes/ssl/*-key.pem"
ssh node03 "sudo chmod 644 /etc/kubernetes/ssl/*.pem"

# Verify certificates on node03
ssh node03 "ls -la /etc/kubernetes/ssl/"
```

Set the proper permissions for security on all nodes:

```bash
# Run on all nodes: node01, node02, and node03
sudo chmod 600 /etc/kubernetes/ssl/*-key.pem
sudo chmod 644 /etc/kubernetes/ssl/*.pem
```

Verify that the certificates are correctly placed on each node:

```bash
# Run on each node
ls -la /etc/kubernetes/ssl/
```

You should see:
- Common certificates: ca.pem, kubernetes*.pem, service-account*.pem
- Node-specific certificates: kubelet.pem and kubelet-key.pem

---

## Next Steps

Now that we have our certificates ready, we'll proceed to **Part 3** where we'll set up **containerd and kubelet**, which will need these certificates to function properly!

👉 Continue to **[Part 3: Setting up containerd and kubelet](/training/rke2-hard-way/03-setting-up-containerd-and-kubelet/)**
