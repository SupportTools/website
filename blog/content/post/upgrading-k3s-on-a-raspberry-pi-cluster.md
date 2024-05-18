---
title: "Upgrading k3s on a Raspberry Pi Cluster"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["k3s", "Raspberry Pi", "Upgrade"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to upgrade k3s on a Raspberry Pi cluster, including handling control plane and worker nodes."
more_link: "yes"
---

Learn how to upgrade k3s on a Raspberry Pi cluster, including handling the control plane and worker nodes. This guide will walk you through the steps to ensure a smooth upgrade process.

<!--more-->

# [Upgrading k3s on a Raspberry Pi Cluster](#upgrading-k3s-on-a-raspberry-pi-cluster)

The Rancher documentation advises updating the server first, followed by the workers. Here's a detailed guide on upgrading k3s on your Raspberry Pi cluster.

## [Upgrading the Control Plane](#upgrading-the-control-plane)

This is a non-HA cluster with a single server node. The `kubectl drain` command doesn't evict pods with local storage, so we'll proceed with the upgrade directly:

```bash
sudo apt update
sudo apt upgrade
curl -sfL https://get.k3s.io | sh -
```

### [Disabling Klipper](#disabling-klipper)

To disable Klipper during installation, use the following command:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable servicelb" sh -
```

For more details, refer to:

- [Rancher Docs: Networking: Disabling the Service LB](https://rancher.com/docs/k3s/latest/en/networking/)
- [Rancher Docs: Installation Options: INSTALL_K3S_EXEC](https://rancher.com/docs/k3s/latest/en/installation/install-options/)

## [Upgrading Worker Nodes](#upgrading-worker-nodes)

### [Draining the Worker Node](#draining-the-worker-node)

On the master node, drain the worker node (e.g., rpi405):

```bash
kubectl drain rpi405 --ignore-daemonsets --pod-selector='app!=csi-attacher,app!=csi-provisioner'
```

### [Upgrading the Worker Node](#upgrading-the-worker-node)

On the worker node (rpi405):

```bash
sudo apt update
sudo apt upgrade
curl -sfL https://get.k3s.io | K3S_URL=https://rpi401:6443 K3S_TOKEN=K... sh -
```

You can find the token in `/var/lib/rancher/k3s/server/node-token` on the server node if needed.

### [Uncordoning the Worker Node](#uncordoning-the-worker-node)

After upgrading, uncordon the node:

```bash
kubectl uncordon rpi405
```

Repeat the process for each worker node.

## [Handling Pod Deletion Errors](#handling-pod-deletion-errors)

If you encounter errors deleting pods not managed by controllers, use the `--force` option:

```bash
error: cannot delete Pods not managed by ReplicationController, ReplicaSet, Job, DaemonSet or StatefulSet (use --force to override): default/busybox
```

Confirm that the pod is unused, then delete it:

```bash
kubectl delete pod busybox
```

Following these steps, you can efficiently upgrade k3s on your Raspberry Pi cluster, ensuring minimal workload disruption.
