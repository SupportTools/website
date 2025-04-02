---
title: "RKE2 the Hard Way: Part 3 - Setting up the etcd Cluster"
description: "Configuring and setting up a three-node etcd cluster for Kubernetes."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 3
---

## Part 3 - Setting up the etcd Cluster

In this part of the "RKE2 the Hard Way" training series, we will set up a three-node etcd cluster. etcd is a distributed key-value store that Kubernetes uses as its backing store for all cluster data. A properly configured etcd cluster is essential for the stability and reliability of your Kubernetes cluster.

We will manually download, configure, and start etcd on each of our control plane nodes.

### 1. Download etcd Binaries

On each of your control plane nodes (node1, node2, node3), download the etcd release binaries.  You can find the latest release on the [etcd releases page](https://github.com/etcd-io/etcd/releases). For this guide, we will use etcd version `v3.5.9`.

```bash
ETCD_VERSION=v3.5.9
wget https://github.com/etcd-io/etcd/releases/download/${ETCD_VERSION}/etcd-${ETCD_VERSION}-linux-amd64.tar.gz
tar xzf etcd-${ETCD_VERSION}-linux-amd64.tar.gz
sudo mv etcd-${ETCD_VERSION}-linux-amd64/etcd* /usr/local/bin/
rm -rf etcd-${ETCD_VERSION}-linux-amd64*
```

These commands will:

*   Download the etcd binaries for Linux AMD64.
*   Extract the archive.
*   Move the `etcd` and `etcdctl` binaries to `/usr/local/bin/` so they are in your system's PATH.
*   Remove the downloaded archive and extracted directory.

**Repeat these steps on all three control plane nodes (node1, node2, and node3).**

### 2. Create etcd Configuration File

On each control plane node, create an etcd configuration file named `etcd.conf` in `/etc/etcd/`. You will need to customize this file for each node.

First, create the directory:

```bash
sudo mkdir -p /etc/etcd/
```

Now, create `/etc/etcd/etcd.conf` on **node1** with the following content. **Replace the placeholders with the actual IP addresses and hostnames of your nodes.**

```conf
#[Member]
# ETCD_NAME is the human-readable name for this member.
ETCD_NAME="node1"
# ETCD_DATA_DIR is the path to the data directory.
ETCD_DATA_DIR="/var/lib/etcd"
# ETCD_LISTEN_PEER_URLS is the list of URLs to listen on for peer traffic.
ETCD_LISTEN_PEER_URLS="https://<NODE1_PRIVATE_IP>:2380"
# ETCD_LISTEN_CLIENT_URLS is the list of URLs to listen on for client traffic.
ETCD_LISTEN_CLIENT_URLS="https://127.0.0.1:2379,https://<NODE1_PRIVATE_IP>:2379"

#[Clustering]
# ETCD_INITIAL_ADVERTISE_PEER_URLS is the list of this member's peer URLs to advertise to the rest of the cluster.
ETCD_INITIAL_ADVERTISE_PEER_URLS="https://<NODE1_PRIVATE_IP>:2380"
# ETCD_ADVERTISE_CLIENT_URLS is the list of client URLs to advertise to clients.
ETCD_ADVERTISE_CLIENT_URLS="https://<NODE1_PRIVATE_IP>:2379"
# ETCD_INITIAL_CLUSTER_TOKEN is the initial cluster token for the etcd cluster during bootstrap.
ETCD_INITIAL_CLUSTER_TOKEN="etcd-cluster-token"
# ETCD_INITIAL_CLUSTER is the initial cluster configuration for bootstrapping.
ETCD_INITIAL_CLUSTER="node1=https://<NODE1_PRIVATE_IP>:2380,node2=https://<NODE2_PRIVATE_IP>:2380,node3=https://<NODE3_PRIVATE_IP>:2380"
# ETCD_INITIAL_CLUSTER_STATE is the initial cluster state ("new" or "existing").
ETCD_INITIAL_CLUSTER_STATE="new"

# Enable TLS
ETCD_CERT_FILE="/etc/etcd/certs/kubernetes.pem"
ETCD_KEY_FILE="/etc/etcd/certs/kubernetes-key.pem"
ETCD_TRUSTED_CA_FILE="/etc/etcd/certs/ca.pem"
ETCD_PEER_CERT_FILE="/etc/etcd/certs/kubernetes.pem"
ETCD_PEER_KEY_FILE="/etc/etcd/certs/kubernetes-key.pem"
ETCD_PEER_TRUSTED_CA_FILE="/etc/etcd/certs/ca.pem"
```

**Customize for node2 and node3:**

Create `/etc/etcd/etcd.conf` on **node2**:

```conf
#[Member]
ETCD_NAME="node2"
ETCD_DATA_DIR="/var/lib/etcd"
ETCD_LISTEN_PEER_URLS="https://<NODE2_PRIVATE_IP>:2380"
ETCD_LISTEN_CLIENT_URLS="https://127.0.0.1:2379,https://<NODE2_PRIVATE_IP>:2379"

#[Clustering]
ETCD_INITIAL_ADVERTISE_PEER_URLS="https://<NODE2_PRIVATE_IP>:2380"
ETCD_ADVERTISE_CLIENT_URLS="https://<NODE2_PRIVATE_IP>:2379"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-cluster-token"
ETCD_INITIAL_CLUSTER="node1=https://<NODE1_PRIVATE_IP>:2380,node2=https://<NODE2_PRIVATE_IP>:2380,node3=https://<NODE3_PRIVATE_IP>:2380"
ETCD_INITIAL_CLUSTER_STATE="new"

# Enable TLS
ETCD_CERT_FILE="/etc/etcd/certs/kubernetes.pem"
ETCD_KEY_FILE="/etc/etcd/certs/kubernetes-key.pem"
ETCD_TRUSTED_CA_FILE="/etc/etcd/certs/ca.pem"
ETCD_PEER_CERT_FILE="/etc/etcd/certs/kubernetes.pem"
ETCD_PEER_KEY_FILE="/etc/etcd/certs/kubernetes-key.pem"
ETCD_PEER_TRUSTED_CA_FILE="/etc/etcd/certs/ca.pem"
```

Create `/etc/etcd/etcd.conf` on **node3**:

```conf
#[Member]
ETCD_NAME="node3"
ETCD_DATA_DIR="/var/lib/etcd"
ETCD_LISTEN_PEER_URLS="https://<NODE3_PRIVATE_IP>:2380"
ETCD_LISTEN_CLIENT_URLS="https://127.0.0.1:2379,https://<NODE3_PRIVATE_IP>:2379"

#[Clustering]
ETCD_INITIAL_ADVERTISE_PEER_URLS="https://<NODE3_PRIVATE_IP>:2380"
ETCD_ADVERTISE_CLIENT_URLS="https://<NODE3_PRIVATE_IP>:2379"
ETCD_INITIAL_CLUSTER_TOKEN="etcd-cluster-token"
ETCD_INITIAL_CLUSTER="node1=https://<NODE1_PRIVATE_IP>:2380,node2=https://<NODE2_PRIVATE_IP>:2380,node3=https://<NODE3_PRIVATE_IP>:2380"
ETCD_INITIAL_CLUSTER_STATE="new"

# Enable TLS
ETCD_CERT_FILE="/etc/etcd/certs/kubernetes.pem"
ETCD_KEY_FILE="/etc/etcd/certs/kubernetes-key.pem"
ETCD_TRUSTED_CA_FILE="/etc/etcd/certs/ca.pem"
ETCD_PEER_CERT_FILE="/etc/etcd/certs/kubernetes.pem"
ETCD_PEER_KEY_FILE="/etc/etcd/certs/kubernetes-key.pem"
ETCD_PEER_TRUSTED_CA_FILE="/etc/etcd/certs/ca.pem"
```

**Remember to replace all `<NODE*_PRIVATE_IP>` placeholders with the actual private IP addresses of your nodes in each file.**

**Also, create the certs directory on each node and copy the certificates:**

```bash
sudo mkdir -p /etc/etcd/certs
sudo cp ca.pem kubernetes.pem kubernetes-key.pem /etc/etcd/certs/
```
**You will need to securely copy the `ca.pem`, `kubernetes.pem`, and `kubernetes-key.pem` files from your workstation to each control plane node (e.g., using `scp`).**  Ensure the certificates are placed in `/etc/etcd/certs/` on each node.

### 3. Create etcd Systemd Service

On each control plane node, create a systemd service file for etcd to manage it as a service. Create `/etc/systemd/system/etcd.service` with the following content:

```ini
[Unit]
Description=etcd key-value store
Documentation=https://github.com/etcd-io/etcd
After=network.target

[Service]
Type=notify
WorkingDirectory=/var/lib/etcd/
EnvironmentFile=/etc/etcd/etcd.conf
ExecStart=/usr/local/bin/etcd \
  --logger=zap \
  --config-file=/etc/etcd/etcd.conf
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### 4. Start and Enable etcd Service

On each control plane node, start and enable the etcd service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable etcd
sudo systemctl start etcd
```

### 5. Verify etcd Cluster Health

After starting etcd on all three nodes, verify the cluster health from **node1**:

```bash
etcdctl --endpoints=https://<NODE1_PRIVATE_IP>:2379,https://<NODE2_PRIVATE_IP>:2379,https://<NODE3_PRIVATE_IP>:2379 \
  --cacert=/etc/etcd/certs/ca.pem \
  --cert=/etc/etcd/certs/kubernetes.pem \
  --key=/etc/etcd/certs/kubernetes-key.pem \
  endpoint health
```

**Replace `<NODE*_PRIVATE_IP>` placeholders with your node IPs.**

You should see output similar to this, indicating that all three etcd members are healthy:

```
https://<NODE1_PRIVATE_IP>:2379, health: true, took: ...
https://<NODE2_PRIVATE_IP>:2379, health: true, took: ...
https://<NODE3_PRIVATE_IP>:2379, health: true, took: ...
```

If you see errors, double-check your configuration files, certificate paths, and network connectivity between nodes.

**Next Steps:**

In the next part, we will configure and set up the Kubernetes API server, connecting it to our newly created etcd cluster.
