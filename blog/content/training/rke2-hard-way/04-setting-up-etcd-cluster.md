---
title: "RKE2 the Hard Way: Part 4 – Setting up etcd Cluster as Static Pods"
description: "Configure and deploy an etcd cluster using static pods."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 4
draft: false
tags: ["kubernetes", "rke2", "etcd", "static pods", "high availability"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "In Part 4 of RKE2 the Hard Way, we set up an etcd cluster using static pods managed by kubelet."
more_link: ""
---

## Part 4 – Setting up etcd Cluster as Static Pods

In this part of the **"RKE2 the Hard Way"** training series, we will set up **etcd** as a clustered key-value store using **static pods** managed by kubelet. etcd is a consistent and highly-available key-value store used by Kubernetes to store all cluster data, including the state of the cluster, configuration data, and metadata.

In RKE2, etcd is deployed as a static pod managed by kubelet, instead of running directly as a systemd service. This makes it easier to manage, as kubelet handles lifecycle operations, restarts, and monitoring.

> ✅ **Assumption:** You've completed [Part 3](/training/rke2-hard-way/03-setting-up-containerd-and-kubelet/) with containerd and kubelet properly set up on all nodes.

---

### 1. Download and Install etcd Binary

First, we need to download and install the etcd binary on each node. This binary will be used to interact with the etcd cluster once it's running:

```bash
# Download etcd
ETCD_VERSION="v3.5.11"
wget -q --show-progress --https-only --timestamping \
  "https://github.com/etcd-io/etcd/releases/download/${ETCD_VERSION}/etcd-${ETCD_VERSION}-linux-amd64.tar.gz"

# Extract etcd
tar -xvf etcd-${ETCD_VERSION}-linux-amd64.tar.gz

# Move binaries to proper location
sudo mv etcd-${ETCD_VERSION}-linux-amd64/etcd* /usr/local/bin/

# Clean up
rm -rf etcd-${ETCD_VERSION}-linux-amd64*

# Verify the installation
etcd --version
etcdctl version
```

---

### 2. Create etcd Data Directory

Create a directory on each node to store etcd data:

```bash
# Create etcd data directory with proper permissions
sudo mkdir -p /var/lib/etcd
sudo chmod 700 /var/lib/etcd
```

---

### 3. Understanding etcd Bootstrapping

Before we create the etcd pod, let's understand how etcd bootstrapping works:

1. When starting a new etcd cluster, all nodes must agree on the initial cluster membership
2. Each node needs to know its own identity and the identities of all other nodes
3. The `--initial-cluster-state=new` flag tells etcd this is a new cluster bootstrap
4. Once the cluster is formed, this can be changed to `existing` for future restarts

**Important**: For successful bootstrapping, you must:
- Run these steps on all nodes at roughly the same time
- Ensure all nodes can reach each other over the network
- Use correct and consistent IP addresses
- Have the same `--initial-cluster` configuration on all nodes

### 4. Create etcd Static Pod Manifest

Now we'll create the static pod manifest for etcd. This YAML file will tell kubelet how to run etcd as a pod:

```bash
# First, determine which node we're on and set the appropriate IP variable
HOSTNAME=$(hostname)
if [ "$HOSTNAME" = "node01" ]; then
  # Use the NODE1_IP variable we set in Part 2
  CURRENT_NODE_IP=${NODE1_IP}
  ETCD_NAME="node01"
elif [ "$HOSTNAME" = "node02" ]; then
  CURRENT_NODE_IP=${NODE2_IP}
  ETCD_NAME="node02"
elif [ "$HOSTNAME" = "node03" ]; then
  CURRENT_NODE_IP=${NODE3_IP}
  ETCD_NAME="node03"
else
  echo "Unknown hostname: $HOSTNAME"
  exit 1
fi

# Clean up any old manifests to start fresh
rm -f /etc/kubernetes/manifests/etcd*.yaml

# Create the etcd manifest
# Note: kubelet will automatically append the node name to the pod name,
# so we just use "etcd" as the base name
cat > /etc/kubernetes/manifests/etcd.yaml << EOF
apiVersion: v1
kind: Pod
metadata:
  labels:
    component: etcd
    tier: control-plane
  name: etcd
  namespace: kube-system
spec:
  containers:
  - command:
    - etcd
    - --advertise-client-urls=https://${CURRENT_NODE_IP}:2379
    - --cert-file=/etc/kubernetes/ssl/kubernetes.pem
    - --client-cert-auth=true
    - --data-dir=/var/lib/etcd
    - --initial-advertise-peer-urls=https://${CURRENT_NODE_IP}:2380
    - --initial-cluster=node01=https://${NODE1_IP}:2380,node02=https://${NODE2_IP}:2380,node03=https://${NODE3_IP}:2380
    - --initial-cluster-state=new
    - --key-file=/etc/kubernetes/ssl/kubernetes-key.pem
    - --listen-client-urls=https://127.0.0.1:2379,https://${CURRENT_NODE_IP}:2379
    - --listen-metrics-urls=http://127.0.0.1:2381
    - --listen-peer-urls=https://${CURRENT_NODE_IP}:2380
    - --name=${ETCD_NAME}
    - --peer-cert-file=/etc/kubernetes/ssl/kubernetes.pem
    - --peer-client-cert-auth=true
    - --peer-key-file=/etc/kubernetes/ssl/kubernetes-key.pem
    - --peer-trusted-ca-file=/etc/kubernetes/ssl/ca.pem
    - --snapshot-count=10000
    - --trusted-ca-file=/etc/kubernetes/ssl/ca.pem
    image: registry.k8s.io/etcd:3.5.6-0
    name: etcd
    volumeMounts:
    - mountPath: /etc/kubernetes/ssl
      name: etcd-certs
    - mountPath: /var/lib/etcd
      name: etcd-data
  hostNetwork: true
  volumes:
  - hostPath:
      path: /etc/kubernetes/ssl
      type: DirectoryOrCreate
    name: etcd-certs
  - hostPath:
      path: /var/lib/etcd
      type: DirectoryOrCreate
    name: etcd-data
EOF
```

After creating this manifest, kubelet should detect it and start the etcd pod within a few seconds. This begins the bootstrap process for your etcd cluster.

**Note**: Run the above steps on all three nodes simultaneously or in quick succession. The etcd cluster will only form when all nodes start and can discover each other.

---

### 5. Verify etcd Pod Is Running

Let's verify that kubelet has started the etcd pod successfully:

```bash
# Wait for a few seconds for kubelet to start the pod
sleep 10

# Check for running etcd container
crictl ps | grep etcd
```

If the pod is running, you should see an etcd container in the output.

---

### 6. Check etcd Logs

Check the etcd logs to ensure it's running correctly:

```bash
# Get the etcd container ID
ETCD_CONTAINER_ID=$(crictl ps | grep etcd | awk '{print $1}')

# View the logs
crictl logs $ETCD_CONTAINER_ID
```

Look for log entries indicating that etcd has started successfully and is communicating with other cluster members.

---

### 7. Verify etcd Cluster Health

Once all three nodes have etcd running, we can verify the cluster health:

```bash
# Use etcdctl to check cluster health
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/ssl/ca.pem \
  --cert=/etc/kubernetes/ssl/kubernetes.pem \
  --key=/etc/kubernetes/ssl/kubernetes-key.pem \
  member list -w table
```

You should see all three etcd members listed with their status as 'started'. This indicates that the etcd cluster is healthy and all nodes are communicating with each other.

```
# Example output:
+------------------+---------+--------+------------------------+------------------------+------------+
|        ID        | STATUS  |  NAME  |       PEER ADDRS       |      CLIENT ADDRS      | IS LEARNER |
+------------------+---------+--------+------------------------+------------------------+------------+
| 8211f1d0f64f3269 | started | node01 | https://192.168.1.101:2380 | https://192.168.1.101:2379 |      false |
| 91bc3c398fb3c146 | started | node02 | https://192.168.1.102:2380 | https://192.168.1.102:2379 |      false |
| fd422379fda50e48 | started | node03 | https://192.168.1.103:2380 | https://192.168.1.103:2379 |      false |
+------------------+---------+--------+------------------------+------------------------+------------+
```

---

### 8. Verify Cluster Health with etcdctl

You can also check the overall health of the etcd cluster:

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/ssl/ca.pem \
  --cert=/etc/kubernetes/ssl/kubernetes.pem \
  --key=/etc/kubernetes/ssl/kubernetes-key.pem \
  endpoint health
```

If everything is working correctly, you should see `127.0.0.1:2379 is healthy` in the output.

---

### 9. Test Writing and Reading Data to etcd

Finally, let's test writing and reading data to confirm etcd is functioning correctly:

```bash
# Write data to etcd
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/ssl/ca.pem \
  --cert=/etc/kubernetes/ssl/kubernetes.pem \
  --key=/etc/kubernetes/ssl/kubernetes-key.pem \
  put mykey "RKE2 the Hard Way is working!"

# Read data from etcd
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/ssl/ca.pem \
  --cert=/etc/kubernetes/ssl/kubernetes.pem \
  --key=/etc/kubernetes/ssl/kubernetes-key.pem \
  get mykey
```

If you can write and read data successfully, your etcd cluster is fully operational.

---

### Troubleshooting etcd

If you encounter issues with etcd, here are some troubleshooting steps:

1. **Check kubelet logs for YAML parsing errors**:
   ```bash
   journalctl -u kubelet | grep -E "Could not process manifest file|yaml"
   ```
   If you see errors about YAML syntax, carefully check your manifest file - indentation and structure are critical.

2. **Check kubelet logs** for other pod startup issues:
   ```bash
   journalctl -u kubelet -n 100
   ```

3. **Check if the etcd pod manifest is properly created**:
   ```bash
   cat /etc/kubernetes/manifests/etcd.yaml
   ```

4. **Verify certificates are accessible** to the etcd container:
   ```bash
   ls -la /etc/kubernetes/ssl/
   ```

5. **Check etcd container logs** for specific errors:
   ```bash
   ETCD_CONTAINER_ID=$(crictl ps | grep etcd | awk '{print $1}')
   crictl logs $ETCD_CONTAINER_ID
   ```

6. **Verify ports 2379 and 2380 are open** on all nodes:
   ```bash
   # On the node where you're experiencing issues
   netstat -tulpn | grep -E '2379|2380'
   ```

7. **Check if etcd has proper network connectivity**:
   ```bash
   # Try to reach each etcd node
   telnet <node1-ip> 2380
   telnet <node2-ip> 2380
   telnet <node3-ip> 2380
   ```

8. **If etcd isn't forming a cluster**, you might need to reset it:
   ```bash
   # Remove the etcd data directory
   sudo rm -rf /var/lib/etcd/*
   
   # Delete the etcd pod
   sudo rm /etc/kubernetes/manifests/etcd.yaml
   
   # Wait a moment, then recreate the etcd manifest
   # (Use the same commands as in step 4)
   ```

---

## Next Steps

Now that we have our etcd cluster up and running as static pods, we'll proceed to **Part 5** where we'll set up the **Kubernetes API Server** as a static pod managed by kubelet.

👉 Continue to **[Part 5: Setting up Kubernetes API Server](/training/rke2-hard-way/05-setting-up-kube-apiserver/)**
