---
title: "Replacing a Failed Control Plane Node in a HA Kubernetes Cluster"  
date: 2024-09-05T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "Control Plane", "HA Cluster", "ETCD", "Kubeadm"]  
categories:  
- Kubernetes  
- High Availability  
author: "Matthew Mattox - mmattox@support.tools."  
description: "A step-by-step guide on replacing a failed control plane node in a highly available Kubernetes cluster."  
more_link: "yes"  
url: "/replace-failed-control-plane-node-kubernetes-ha-cluster/"  
---

In this guide, we will walk through the process of replacing a failed control plane node in a highly available multi-master Kubernetes cluster.

<!--more-->

### Before We Begin

We are working in a Kubernetes homelab environment. One of our control plane nodes, **node1**, has failed and needs to be removed from the cluster and replaced with a new node.

#### Pre-check Validation

Start by checking the node status:

```bash
kubectl get no
```

Output:

```plaintext
NAME    STATUS    ROLES           AGE    VERSION
node1   NotReady  control-plane   375d   v1.26.4
node2   Ready     control-plane   327d   v1.26.4
node3   Ready     control-plane   456d   v1.26.4
node4   Ready     none            456d   v1.26.4
node5   Ready     none            327d   v1.26.4
node6   Ready     none            456d   v1.26.4
```

Additionally, you’ll need the ETCD client. If it’s not installed, use the following commands to download and install it:

```bash
ETCD_VER=v3.5.9
GITHUB_URL=https://github.com/etcd-io/etcd/releases/download
DOWNLOAD_URL=${GITHUB_URL}
mkdir -p /tmp/etcd-download-test
curl -fsSL ${DOWNLOAD_URL}/${ETCD_VER}/etcd-${ETCD_VER}-linux-amd64.tar.gz -o /tmp/etcd-${ETCD_VER}-linux-amd64.tar.gz
tar xzvf /tmp/etcd-${ETCD_VER}-linux-amd64.tar.gz -C /tmp/etcd-download-test --strip-components=1
sudo cp /tmp/etcd-download-test/etcdctl /usr/local/bin/
etcdctl version
```

### Remove an Unhealthy ETCD Member

To remove the unhealthy **node1** node from the ETCD cluster, first check the ETCD member status:

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints 127.0.0.1:2379 \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/server.crt \
  --key /etc/kubernetes/pki/etcd/server.key \
  member list
```

Remove the ETCD member with the ID associated with **node1**:

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints 127.0.0.1:2379 \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/server.crt \
  --key /etc/kubernetes/pki/etcd/server.key \
  member remove df4ce5503d32478a
```

After removal, check the ETCD member list to confirm the node has been removed:

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints 127.0.0.1:2379 \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/server.crt \
  --key /etc/kubernetes/pki/etcd/server.key \
  member list
```

### Replace the Failed Control Plane

To replace the failed control plane node:

1. **Drain and delete the failed node**:

    ```bash
    kubectl drain node1
    kubectl delete node node1
    ```

2. **Deploy the new node** using your preferred deployment method (e.g., Ansible, Packer, Terraform).

3. **Generate a new certificate key** on a working control plane:

    ```bash
    sudo kubeadm init phase upload-certs --upload-certs
    ```

4. **Print the kubeadm join command**:

    ```bash
    sudo kubeadm token create --print-join-command --certificate-key <certificate-key>
    ```

5. **Join the new control plane**:

    ```bash
    sudo kubeadm join kube.example.com:6443 \
      --token <token> \
      --discovery-token-ca-cert-hash <ca-cert-hash> \
      --control-plane \
      --certificate-key <certificate-key>
    ```

### Final Verification

Once the node has joined the cluster, verify its status:

```bash
kubectl get node
```

Check the ETCD membership to ensure that the new node is part of the cluster:

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints 127.0.0.1:2379 \
  --cacert /etc/kubernetes/pki/etcd/ca.crt \
  --cert /etc/kubernetes/pki/etcd/server.crt \
  --key /etc/kubernetes/pki/etcd/server.key \
  member list
```

### Final Thoughts

Replacing a failed control plane node in a highly available Kubernetes cluster is a straightforward process with kubeadm and ETCD tools. This process ensures that the cluster maintains its HA capabilities without disruption.
