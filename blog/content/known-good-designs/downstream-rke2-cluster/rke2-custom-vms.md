---
title: "Provisioning an RKE2 Cluster on Custom VMs"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Downstream RKE2 Cluster", "Custom VMs", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Downstream RKE2 Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Create a Rancher-managed RKE2 custom cluster on VMs or servers you provision yourself, using the node registration command, and learn when importing is the right choice."
more_link: "yes"
url: "/known-good-designs/downstream-rke2-cluster/rke2-custom-vms/"
---

This guide provisions a downstream RKE2 cluster on VMs or bare-metal servers that you create outside Rancher. Rancher installs and manages RKE2 on those machines through its **custom cluster** flow: you create the cluster in Rancher, then run a registration command on each node.

<!--more-->

## [Overview](#overview)

### [Custom Cluster vs Imported Cluster](#custom-cluster-vs-imported-cluster)

Rancher has two ways to bring machines you own under management, and they are not interchangeable:

| | Custom cluster (this guide) | Imported (registered) cluster |
|---|---|---|
| Who installs RKE2 | Rancher, through the node registration command | You, before Rancher is involved |
| Kubernetes upgrades | Managed by Rancher | Only if version management is enabled, with an upgrade strategy |
| Cluster configuration | Editable in Rancher | Read-only view of launch arguments and environment variables |
| etcd snapshots | Managed by Rancher, including S3 targets | Local snapshots only for embedded etcd, S3 not supported |
| Node roles and pools | Managed by Rancher | Not managed |

The import column comes from Rancher's [registering existing clusters](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/register-existing-clusters) page.

Use the **custom cluster** flow when Rancher should own the cluster lifecycle on machines that already exist. **Import** an existing cluster when it is already running and its lifecycle is managed by something else (your own automation, another team, or a hosted service such as EKS, AKS, or GKE), and you want Rancher for access control, monitoring, and workload management without taking over upgrades.

Do not install RKE2 on the nodes yourself and then import them if you want Rancher to manage the cluster. That gives you the limited imported feature set above.

---

## [Prerequisites](#prerequisites)

### Node Layout

Follow Rancher's [recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture):

- **3 nodes with the etcd and controlplane roles.** etcd needs at least three members to survive the loss of one. Two etcd members tolerate zero failures, the same as one. Use an odd count (3 or 5).
- **2 or more nodes with the worker role**, so workloads can be rescheduled when a node fails. Rancher's guidance is not to combine the worker role with etcd or controlplane on downstream clusters.

A custom cluster needs at least one node of each role before it finishes provisioning.

### Operating System

Use an OS from the [RKE2 v1.36 support matrix](https://www.suse.com/suse-rke2/support-matrix/all-supported-versions/rke2-v1-36/), which certifies SLES 16.0, 15 SP7, and 15 SP6, SLE Micro 6.2, 6.1, and 6.0, RHEL 10.2, 10.1, 10.0, 9.8, and 9.7 (Rocky, Oracle, and Amazon Linux count as validated through RHEL testing), and Ubuntu 26.04, 24.04, and 22.04. CentOS Linux 8 is end of life and is not listed. Windows Server 2022 is supported as a worker only, and Windows clusters must use Calico or Flannel.

### Hardware

The [RKE2 requirements](https://docs.rke2.io/install/requirements) give a minimum of 2 CPUs and 4 GB RAM, with 4 CPUs and 8 GB RAM recommended. Use SSDs on etcd nodes. Size control plane and etcd nodes up as the cluster grows: 4 CPUs and 8 GB covers 226 to 450 agents.

### Networking

- Every node must reach the Rancher server URL on 443.
- Between nodes, open the RKE2 ports listed in the requirements page: 9345/TCP and 6443/TCP to the servers, 10250/TCP between all nodes, 2379 to 2381/TCP between etcd nodes, the NodePort range 30000 to 32767/TCP, and the ports for your CNI (for example 8472/UDP for VXLAN). Never expose 8472/UDP to the internet.
- Disable `firewalld` or configure a zone that allows pod CIDR and node traffic.

### Clean Nodes

Start from freshly installed machines. Do not pre-install RKE2. If you reuse a node from an earlier cluster, clean it first; Rancher's [custom cluster docs](https://ranchermanager.docs.rancher.com/reference-guides/cluster-configuration/rancher-server-configuration/use-existing-nodes) warn that provisioning may fail otherwise.

---

## [Creating the Custom Cluster](#creating-the-custom-cluster)

The steps follow Rancher's [Launching Kubernetes on existing custom nodes](https://ranchermanager.docs.rancher.com/reference-guides/cluster-configuration/rancher-server-configuration/use-existing-nodes) page.

### Step 1: Create the Cluster in Rancher
1. Open **☰ > Cluster Management** and click **Create**.
2. Select **Custom** (with the RKE2/K3s toggle set to RKE2).
3. Enter a cluster name, for example `custom-vm-cluster`.
4. Under **Cluster Configuration**, choose a Kubernetes version, the CNI, and any RKE2 options. New RKE2 v1.36 clusters use Traefik as the ingress controller by default (see [Ingress on RKE2](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/)).
5. Click **Create**. Rancher opens the **Registration** tab.

### Step 2: Register the etcd and Control Plane Nodes
1. On the **Registration** tab, under **Node Role**, select **etcd** and **Control Plane** only.
2. If the Rancher server certificate is signed by a private CA, make sure the nodes trust that CA. The generated command includes a CA checksum when one is needed.
3. Optionally click **Show Advanced** to set the node public and private IP addresses, override the hostname, or add labels and taints.
4. Copy the generated command and run it as root on each of the three control plane VMs. It has this shape (always copy the real command from your Rancher UI, because it contains your server URL, token, and CA checksum):
   ```bash
   curl -fL https://rancher.example.com/system-agent-install.sh | sudo sh -s - \
     --server https://rancher.example.com \
     --label 'cattle.io/os=linux' \
     --token <registration-token> \
     --etcd --controlplane
   ```

The command installs `rancher-system-agent`, which then installs and configures RKE2 as Rancher instructs. The role flags (`--etcd`, `--controlplane`, `--worker`, or `--all-roles`) and the optional `--address`, `--internal-address`, `--node-name`, `--label`, and `--taints` flags are described in Rancher's agent options reference.

### Step 3: Register the Worker Nodes
1. Return to the **Registration** tab and select only the **Worker** role.
2. Copy the new command and run it on each worker VM.

### Step 4: Wait for Active
The cluster moves to **Updating** while Rancher provisions components, then to **Active**. Watch progress under **Cluster Management**, or in the node list of the cluster.

---

## [Importing an Existing RKE2 Cluster](#importing-an-existing-rke2-cluster)

If the cluster already exists and you want to keep its lifecycle outside Rancher, import it instead:

1. Make sure your kubeconfig points at the target cluster (`kubectl get nodes`) and that you have cluster-admin rights.
2. In Rancher, open **☰ > Cluster Management** and click **Import Existing**, then choose **Generic**.
3. Name the cluster and, for RKE2 or K3s, decide whether to enable version management.
4. Click **Create**, copy the generated `kubectl apply` command, and run it against the cluster. If you get a certificate authority error, use the generated `curl` variant instead.
5. The cluster shows **Pending** while the agents deploy, then **Active**.

Remember the limitations listed in the comparison table above.

---

## [Testing and Validation](#testing-and-validation)

### Accessing the Cluster
1. In Rancher, open the cluster and download the kubeconfig (**Download KubeConfig** in the cluster view), or use the built-in kubectl shell.
2. Confirm all nodes are `Ready` and carry the expected roles:
   ```bash
   kubectl --kubeconfig=./custom-vm-cluster.yaml get nodes -o wide
   ```

### Testing Workloads
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-test
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nginx-test
  template:
    metadata:
      labels:
        app: nginx-test
    spec:
      containers:
      - name: nginx
        image: nginx:stable
        ports:
        - containerPort: 80
```
```bash
kubectl apply -f nginx-test.yaml
kubectl get pods -o wide
```

The two replicas should land on the worker nodes, not on the etcd and control plane nodes.

### Testing Failure Tolerance
Shut down one etcd and control plane node. The cluster should stay **Active** in Rancher and `kubectl` should keep working. Bring the node back before testing another.

---

## [Considerations](#considerations)

- **etcd backups:** Configure recurring etcd snapshots in the cluster configuration and send them to S3-compatible storage off the nodes.
- **Upgrades:** Upgrade Kubernetes from Rancher (**Edit Config**, then change the version), not by running the RKE2 installer on the nodes.
- **Security:** Restrict node ports with firewalls or security groups, and keep the registration token private. Anyone with it can join a node to the cluster.

---

## [References](#references)
- [Rancher: Launching Kubernetes on existing custom nodes](https://ranchermanager.docs.rancher.com/reference-guides/cluster-configuration/rancher-server-configuration/use-existing-nodes)
- [Rancher: Registering existing clusters](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/register-existing-clusters)
- [Rancher: Recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture)
- [RKE2 requirements](https://docs.rke2.io/install/requirements)
- [SUSE RKE2 v1.36 support matrix](https://www.suse.com/suse-rke2/support-matrix/all-supported-versions/rke2-v1-36/)
