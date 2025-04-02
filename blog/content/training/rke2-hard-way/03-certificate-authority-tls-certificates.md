---
title: "RKE2 the Hard Way: Part 3 – Certificate Authority and TLS Certificates"
description: "Setting up a Certificate Authority and generating TLS certificates for Kubernetes components."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 3
draft: false
tags: ["kubernetes", "rke2", "tls", "certificates", "cfssl"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 3 of RKE2 the Hard Way, we configure a Certificate Authority (CA) and generate the TLS certificates required for securing Kubernetes."
more_link: ""
---

## Part 3 – Certificate Authority and TLS Certificates

**IMPORTANT**: Part 3 has been reordered in the training series. Previously, Part 2 was about setting up containerd and kubelet, but now Part 2 is about setting up containerd and kubelet. The Certificate Authority and TLS Certificates setup is now moved to Part 3.

In this part of the **"RKE2 the Hard Way"** training series, we will set up our own **Certificate Authority (CA)** and generate the necessary **TLS certificates** for securing our Kubernetes cluster. Kubernetes components communicate over TLS, and properly configured certificates are crucial for cluster security.

We’ll use [`cfssl`](https://github.com/cloudflare/cfssl), Cloudflare's TLS toolkit, to create our CA and generate certificates.

> ✅ **Assumption:** All commands in this guide are run from `node01`, which is a Linux box.

---

### 1. Install cfssl Tools

Download and install `cfssl` and `cfssljson` on `node01`:

```bash
curl -s -L -o /usr/local/bin/cfssl https://github.com/cloudflare/cfssl/releases/latest/download/cfssl-linux-amd64
curl -s -L -o /usr/local/bin/cfssljson https://github.com/cloudflare/cfssl/releases/latest/download/cfssljson-linux-amd64
chmod +x /usr/local/bin/cfssl /usr/local/bin/cfssljson
```

---

### 2. Create CA Configuration Files

Create a directory to store the CA and certificate files:

```bash
mkdir ca
cd ca
```

Create a file named `ca-config.json`:

```json
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
```

Then, create a file named `ca-csr.json`:

```json
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

Create `kubernetes-csr.json`:

```json
{
  "CN": "kubernetes",
  "hosts": [
    "127.0.0.1",
    "kubernetes",
    "kubernetes.default",
    "kubernetes.default.svc",
    "kubernetes.default.svc.cluster",
    "kubernetes.default.svc.cluster.local",
    "<NODE1_PRIVATE_IP>",
    "<NODE2_PRIVATE_IP>",
    "<NODE3_PRIVATE_IP>",
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
```

> Replace the `<NODE#_PRIVATE_IP>` placeholders with your actual node IPs.

Generate the certificate:

```bash
cfssl gencert \
  -profile=kubernetes \
  -ca=ca.pem \
  -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="127.0.0.1,kubernetes,kubernetes.default,kubernetes.default.svc,kubernetes.default.svc.cluster,kubernetes.default.svc.cluster.local,<NODE1_PRIVATE_IP>,<NODE2_PRIVATE_IP>,<NODE3_PRIVATE_IP>,node01,node02,node03" \
  kubernetes-csr.json | cfssljson -bare kubernetes
```

---

### 5. Generate Kubelet Client Certificates

Create `kubelet-csr.json` (replace `<NODE_HOSTNAME>`):

```json
{
  "CN": "system:node:<NODE_HOSTNAME>",
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
```

Generate the cert:

```bash
cfssl gencert \
  -profile=kubernetes \
  -ca=ca.pem \
  -ca-key=ca-key.pem \
  -config=ca-config.json \
  -hostname="<NODE_HOSTNAME>" \
  kubelet-csr.json | cfssljson -bare kubelet-<NODE_HOSTNAME>
```

Repeat for each node (`node01`, `node02`, `node03`).

---

### 6. Generate Admin Client Certificate

Create `admin-csr.json`:

```json
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

## Next Steps

Stay tuned for Part 4.
