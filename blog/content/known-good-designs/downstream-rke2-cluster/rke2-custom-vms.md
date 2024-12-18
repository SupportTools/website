---
title: "Provisioning an RKE2 Cluster on Custom VMs"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Downstream RKE2 Cluster", "Custom VMs", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Downstream RKE2 Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Guide to provisioning an RKE2 cluster on custom VMs created outside Rancher."
more_link: "yes"
url: "/known-good-designs/downstream-rke2-cluster/rke2-custom-vms/"
---

This guide demonstrates how to provision an RKE2 cluster on custom VMs that are created and configured outside Rancher, and then import the cluster into Rancher for centralized management.

<!--more-->

# [Overview](#overview)

## [Custom VM RKE2 Cluster in Rancher](#custom-vm-rke2-cluster-in-rancher)
For environments where VMs are provisioned independently (e.g., via manual setup or external orchestration tools), RKE2 can be installed directly on the nodes and subsequently imported into Rancher for management.

---

# [Prerequisites](#prerequisites)

### VM Requirements
- **Operating System:** Ubuntu 22.04, CentOS 8, or similar Linux distributions.
- **Hardware:** Minimum 4 CPUs and 8 GB RAM per node.
- **Networking:**
  - Nodes must be able to communicate with each other on required ports.
  - Nodes must be accessible from your local machine or Rancher server.

### RKE2 Requirements
- RKE2 binaries must be installed on all nodes.
- A shared token for cluster authentication.

---

# [Setting Up RKE2](#setting-up-rke2)

### Step 1: Install RKE2 on Control Plane Nodes
1. SSH into each control-plane VM.
2. Install RKE2 using the installation script:
   ```bash
   curl -sfL https://get.rke2.io | sh -
   systemctl enable rke2-server.service
   systemctl start rke2-server.service
   ```
3. Retrieve the cluster token from `/var/lib/rancher/rke2/server/node-token` on the first control-plane node. This token will be required for adding other nodes to the cluster.

4. Copy the kubeconfig file to your local machine for kubectl access:
   ```bash
   scp root@<control-plane-ip>:/etc/rancher/rke2/rke2.yaml ./kubeconfig.yaml
   ```
   Update the server address in the kubeconfig file to the control-plane node's IP.

### Step 2: Install RKE2 on Worker Nodes
1. SSH into each worker VM.
2. Install RKE2 in agent mode:
   ```bash
   curl -sfL https://get.rke2.io | INSTALL_RKE2_TYPE="agent" sh -
   systemctl enable rke2-agent.service
   systemctl start rke2-agent.service
   ```
3. Configure the worker nodes to join the cluster by editing `/etc/rancher/rke2/config.yaml`:
   ```yaml
   server: https://<control-plane-ip>:9345
   token: <cluster-token>
   ```
4. Restart the RKE2 agent:
   ```bash
   systemctl restart rke2-agent.service
   ```

---

# [Importing the Cluster into Rancher](#importing-the-cluster-into-rancher)

### Step 1: Add Cluster in Rancher
1. Log in to Rancher.
2. Navigate to **Cluster Management** and click **Add Cluster**.
3. Select **Import an Existing Cluster**.

### Step 2: Generate Import Command
1. Provide a name for your cluster (e.g., `custom-vm-cluster`).
2. Copy the generated kubectl command for importing the cluster.

### Step 3: Run the Import Command
1. SSH into one of the control-plane nodes or a machine with access to the cluster.
2. Run the kubectl command to deploy the Rancher agents.
3. Verify the cluster's status in Rancher. Once the agents are deployed, the cluster should appear as **Active**.

---

# [Testing and Validation](#testing-and-validation)

### Accessing the Cluster
1. Use kubectl with the provided kubeconfig file:
   ```bash
   kubectl --kubeconfig=./kubeconfig.yaml get nodes
   ```

2. Ensure all control-plane and worker nodes are listed as **Ready**.

### Testing Workloads
Deploy a test workload to validate cluster functionality:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: nginx-test
  namespace: default
spec:
  containers:
  - name: nginx
    image: nginx:latest
    ports:
    - containerPort: 80
```
```bash
kubectl apply -f nginx-test.yaml
kubectl get pods
```

---

# [Considerations](#considerations)

- **Node Health Monitoring:** Ensure all nodes have sufficient resources and are accessible from Rancher.
- **Backup Configuration:** Regularly back up etcd and cluster configurations.
- **Security:** Use firewalls and VPNs to secure node communication.

---

# [References](#references)
- [RKE2 Documentation](https://docs.rke2.io/)
- [Rancher Import Cluster Documentation](https://rancher.com/docs/rancher/v2.7/en/cluster-provisioning/imported-clusters/)

