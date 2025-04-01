---
title: "RKE2 the Hard Way: Part 2 - Certificate Authority and TLS Certificates"
description: "Setting up a Certificate Authority and generating TLS certificates for Kubernetes components."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 2
---

## Part 2 - Certificate Authority and TLS Certificates

In this part of the "RKE2 the Hard Way" training series, we will set up our own Certificate Authority (CA) and generate the necessary TLS certificates for securing our Kubernetes cluster.  Kubernetes components communicate over TLS, and properly configured certificates are crucial for cluster security.

We will use `cfssl`, Cloudflare's TLS toolkit, to create our CA and generate certificates.

### 1. Install cfssl Tools

If you haven't already, download and install `cfssl` and `cfssljson` on your workstation. Follow the instructions on the [cfssl GitHub repository](https://github.com/cloudflare/cfssl).

For example, on macOS using Homebrew:

```bash
brew install cfssl
```

On Linux, you can download pre-compiled binaries from the GitHub releases page.

### 2. Create CA Configuration Files

Create a directory to store our CA and certificate files.

```bash
mkdir ca
cd ca
```

Create a file named `ca-config.json` with the following content:

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
      "L": "Austin",
      "O": "SupportTools",
      "OU": "Kubernetes The Hard Way",
      "ST": "Texas"
    }
  ]
}
```

This configuration file defines:

*   `signing`: Default signing profile with a certificate expiry of 8760 hours (365 days).
*   `profiles.kubernetes`: A specific profile for Kubernetes certificates with extended usages and the same expiry.
*   `names`:  Default subject information for the CA.

Create a file named `ca-csr.json` (CA Certificate Signing Request) with the following content:

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
      "L": "Austin",
      "O": "SupportTools",
      "OU": "Kubernetes The Hard Way",
      "ST": "Texas"
    }
  ]
}
```

This CSR defines:

*   `CN`: Common Name for the CA certificate.
*   `key`: Key algorithm (RSA) and size (2048 bits).
*   `names`: Subject information, same as `ca-config.json`.

### 3. Generate the CA Certificate and Key

Use `cfssl` to generate the CA certificate and private key:

```bash
cfssl gencert -initca ca-csr.json | cfssljson -bare ca
```

This command:

*   `cfssl gencert -initca ca-csr.json`:  Generates a CA certificate and key based on `ca-csr.json`.
*   `| cfssljson -bare ca`: Pipes the output to `cfssljson` to extract the certificate and key into `ca.pem` and `ca-key.pem` files.

You should now have the following files in your `ca` directory:

*   `ca.pem`: CA certificate.
*   `ca-key.pem`: CA private key.

**Important Security Note:**  Protect `ca-key.pem` as it is the root of trust for your cluster. In a production environment, you would use more secure key management practices. For this training, we are keeping it simple for educational purposes.

### 4. Generate Kubernetes API Server Certificate and Key

Create a file named `kubernetes-csr.json` for the Kubernetes API server certificate request:

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
    "<NODE1_HOSTNAME>",
    "<NODE2_HOSTNAME>",
    "<NODE3_HOSTNAME>"
  ],
  "key": {
    "algo": "rsa",
    "size": 2048
  },
  "names": [
    {
      "C": "US",
      "L": "Austin",
      "O": "SupportTools",
      "OU": "Kubernetes The Hard Way",
      "ST": "Texas"
    }
  ]
}
```

**Replace Placeholders:**

*   `<NODE1_PRIVATE_IP>`, `<NODE2_PRIVATE_IP>`, `<NODE3_PRIVATE_IP>`:  Replace with the private IP addresses of your control plane nodes.
*   `<NODE1_HOSTNAME>`, `<NODE2_HOSTNAME>`, `<NODE3_HOSTNAME>`: Replace with the hostnames of your control plane nodes.

**Note:**  Include all possible DNS names and IP addresses that clients might use to reach the API server.  `kubernetes`, `kubernetes.default`, etc., are internal service names.

Generate the Kubernetes API server certificate and key:

```bash
cfssl gencert -profile=kubernetes -ca=ca.pem -ca-key=ca-key.pem -config=ca-config.json -hostname="127.0.0.1,kubernetes,kubernetes.default,kubernetes.default.svc,kubernetes.default.svc.cluster,kubernetes.default.svc.cluster.local,<NODE1_PRIVATE_IP>,<NODE2_PRIVATE_IP>,<NODE3_PRIVATE_IP>,<NODE1_HOSTNAME>,<NODE2_HOSTNAME>,<NODE3_HOSTNAME>" kubernetes-csr.json | cfssljson -bare kubernetes
```

**Again, replace the placeholders in the `-hostname` flag with your node IPs and hostnames.**

This command:

*   `cfssl gencert -profile=kubernetes ... kubernetes-csr.json`: Generates a certificate using the `kubernetes` profile from `ca-config.json`, signing it with our CA (`ca.pem` and `ca-key.pem`), and using the hostname list.
*   `| cfssljson -bare kubernetes`: Extracts the certificate and key to `kubernetes.pem` and `kubernetes-key.pem`.

You should now have:

*   `kubernetes.pem`: Kubernetes API server certificate.
*   `kubernetes-key.pem`: Kubernetes API server private key.

### 5. Generate kubelet Client Certificates

For kubelet, we need client certificates for secure communication with the API server.

Create `kubelet-csr.json` for the kubelet client certificate request:

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
      "L": "Austin",
      "O": "System:Nodes",
      "OU": "Kubernetes The Hard Way",
      "ST": "Texas"
    }
  ]
}
```

**Replace `<NODE_HOSTNAME>` with the actual hostname of each node when generating certificates for each node.**  You'll need to repeat the following steps for each node, replacing the hostname accordingly.

Generate the kubelet client certificate and key:

```bash
cfssl gencert -profile=kubernetes -ca=ca.pem -ca-key=ca-key.pem -config=ca-config.json -hostname="<NODE_HOSTNAME>" kubelet-csr.json | cfssljson -bare kubelet
```

**Replace `<NODE_HOSTNAME>` in the `-hostname` flag and `kubelet-csr.json` content.**

This will create:

*   `kubelet.pem`: Kubelet client certificate.
*   `kubelet-key.pem`: Kubelet client private key.

**Repeat steps 5 for each of your nodes, creating unique kubelet certificates for each.**  Name them `kubelet-node1.pem`, `kubelet-node2.pem`, etc., to keep them organized.

### 6. Generate Admin Client Certificate

For `kubectl` access, we need an admin client certificate.

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
      "L": "Austin",
      "O": "system:masters",
      "OU": "Kubernetes The Hard Way",
      "ST": "Texas"
    }
  ]
}
```

Generate the admin client certificate and key:

```bash
cfssl gencert -profile=kubernetes -ca=ca.pem -ca-key=ca-key.pem -config=ca-config.json -hostname="" admin-csr.json | cfssljson -bare admin
```

This creates:

*   `admin.pem`: Admin client certificate.
*   `admin-key.pem`: Admin client private key.

### 7. Generate Service Account Key Pair

Kubernetes service accounts use a key pair for signing and verifying JWT tokens.

Generate the service account key pair:

```bash
openssl genrsa -out service-account-key.pem 2048
openssl rsa -in service-account-key.pem -pubout -out service-account.pem
```

This creates:

*   `service-account-key.pem`: Service account private key.
*   `service-account.pem`: Service account public key.

### 8. Organize Certificates

Create a `certs` directory to organize all generated certificates and keys:

```bash
mkdir certs
mv ca.pem ca-key.pem kubernetes.pem kubernetes-key.pem kubelet*.pem kubelet*.key admin.pem admin-key.pem service-account-key.pem service-account.pem certs/
```

Now your `ca/certs` directory should contain all the necessary certificates and keys for your Kubernetes cluster.

**Next Steps:**

In the next part, we will configure and set up the etcd cluster, using the certificates we generated in this part to secure etcd communication.
