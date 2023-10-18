---
title: "RKE2 with Rancher - Disaster Recovery Guide"
date: 2023-10-18T01:15:00-06:00
draft: false
tags: ["Rancher", "RKE2", "Disaster Recovery"]
categories:
- Rancher
- Kubernetes
- RKE2
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools."
description: "This comprehensive guide covers essential steps for disaster recovery of RKE2 clusters that are managed by Rancher."
more_link: "yes"
---

## RKE2 with Rancher - Disaster Recovery Guide

### Introduction

The purpose of this guide is to provide a comprehensive guide for disaster recovery of RKE2 clusters managed by Rancher. RKE2, a CNCF-certified Kubernetes distribution, is a fully conformant Kubernetes distribution focusing on security and simplicity. Rancher is a CNCF-certified Kubernetes management platform that provides a single pane of glass for managing multiple Kubernetes clusters. Rancher can manage RKE2 clusters and other Kubernetes distributions such as RKE, EKS, AKS, GKE, and more.

Please note that this guide is intended to be something other than a replacement for the official documentation. This guide is designed to supplement the official documentation and provide a comprehensive guide for disaster recovery of RKE2 clusters that Rancher manages. This guide also assumes a basic understanding of Kubernetes, RKE2, and Rancher.

<!--more-->

## [RKE2 Disaster Recovery](#rke2-disaster-recovery)

### [Overview](#overview)

This document is intended to provide a comprehensive guide to recovering an RKE2 cluster managed by Rancher. This document will cover the following scenarios:

- [Recovering after the lost all master nodes](#recovering-after-the-lost-all-master-nodes)
- [Failed RKE2 upgrade](#failed-rke2-upgrade)
- [RKE2 downgrade](#k8s-downgrade)
- [Recovering after etcd quorum loss](#recovering-after-etcd-quorum-loss)
- [Lost bootstrap node](#lost-bootstrap-node)

### [Recovering after the lost all master nodes](#recovering-after-the-lost-all-master-nodes)

This section will cover the steps to recover an RKE2 cluster after losing all control plane nodes. This section assumes that you have an etcd backup in S3 or a copy of the etcd snapshot on one of the master nodes.

**NOTE**: If you do not have an etcd backup and you have lost all master nodes, you will need to create a new RKE2 cluster and restore your applications from the backup. There is only one way to recover an RKE2 cluster with an etcd backup or copy of the data.

This scenario can be caused by several different issues, including:

- Someone accidentally deleted all master nodes from the Rancher UI
- Someone accidentally deleting all master nodes from the infrastructure IE AWS, GCP, Azure, VMware, etc.
- A misconfigured AutoScaling Group (ASG) that replaced all master nodes with new nodes but didn't wait for the etcd data to be fully synced before terminating the old nodes.

The steps below will cover recovering an RKE2 cluster after the loss of all master nodes.

#### [SSH access to all master/etcd nodes](#ssh-access-to-all-masteretcd-nodes)

All the master/etcd nodes will need to be accessed via SSH. If SSH access is unavailable, the nodes must be accessed via the console or other remote access method. You should have root or sudo access to the nodes.

#### [Before proceeding, capture logs from all master/etcd nodes](#before-proceeding-capture-logs-from-all-masteretcd-nodes)

Before proceeding, it is recommended to capture logs from all master/etcd nodes. This can be done by running the following command on each master/etcd node:

```bash
curl -Ls rnch.io/rancher2_logs | bash
```

This will create a tarball of the logs in the `/tmp` directory. If needed, the tarball can be copied off the node and extracted for review.

This is very important to do before proceeding, as the following steps will remove the etcd data directory, and the logs will be lost, so things like an RCA will be much more difficult.

#### [Find your etcd backup](#find-your-etcd-backup)

You will need to find your etcd backup. If you have configured S3 backups, you can skip to the next step. If you have not configured S3 backups, you must find a copy of the etcd snapshot on one of the master nodes. The etcd snapshot is at `/var/lib/rancher/rke2/server/db/snap/db`.

What you need to do is find the most recent etcd snapshot. You can do this by running the following command on one of the master nodes:

```bash
ls -l /var/lib/rancher/rke2/server/db/snap/db
```

This will list all the etcd snapshots. You will want to find the most recent timestamp. You then need to go into Rancher and confirm that the etcd snapshot you found is also located in Rancher. If not, you will need to replace the filename to match the etcd snapshot in Rancher.

#### [Bootstrapping a new master node](#bootstrapping-a-new-master-node)

At this point, you will need a new master node. This can be done by creating a new node in your infrastructure or using one existing node. This is a temporary node and will be removed after the cluster is recovered. This node will need to access the etcd snapshot you found in the previous step.

We first need to remove all the current master nodes from Rancher.

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Machines` tab
3. Select all the master nodes
4. Click on the `Delete` button

**NOTE**: If you are using a node driver like AWS, GCP, Azure, etc., this will trigger the deletion of the nodes in the infrastructure. Hence, we need to create a new node in the previous step, and you should ensure that the new node is not part of the node driver. Finally, if you are using local-only etcd backups, you will need to provide the new node can access the etcd snapshot—IE rsync the etcd snapshot to the new node before deleting the old master nodes.

If a node is stuck in the `Deleting` state, you might need to remove a stuck finalizer, which can be done using the steps:

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Machines` tab
3. Select the node that is stuck in the `Deleting` state
4. Click on the `Edit as YAML` button
5. Remove the `machine.cluster.x-k8s.io` finalizer

At this point, you should only have worker nodes in the cluster. You can confirm this by going to the `Nodes` tab in Rancher. If you have any master nodes left, you will need to remove them. It is recommended to power off the nodes, disconnect the network, or run the command `rke2-killall.sh` on the nodes to prevent them from returning online during recovery.

We now need to add our temporary master node to the cluster, but this node must be assigned the role of `all` (etcd, controlplane, and worker).

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Registration` tab
3. Check the box for `etcd, controlplane, and worker.`
4. Copy the Registration Command and run it on the new temporary master node

At this point, the node should get stuck in the registering state. This is expected as the node cannot access the etcd snapshot. We will fix this in the next step.

#### [Restoring the etcd snapshot](#restoring-the-etcd-snapshot)

We currently have an empty etcd cluster on our temporary master nodes. So, we need to restore the etcd snapshot we found in this node's previous steps.

1. Go to the cluster in the Rancher Cluster Manager view
2. Go to the action menu in the top right corner
3. Select `Restore Snapshot`
4. Select the etcd snapshot that you found in the previous steps

At this point, Rancher should take over and restore the etcd snapshot. Once the restore is done, the temporary master node should be in the `Active` state. You can confirm this by going to the `Nodes` tab in Rancher. The worker nodes will bounce up and down as they are trying to connect to the new master node. This is expected and will self-correct once the cluster is fully recovered.

#### [Restoring the cluster to full HA](#restoring-the-cluster-to-full-ha)

We have a working cluster, the service has been restored to the applications, and the cluster is fully functional. However, we are not in a fully HA state yet. We must add the master nodes back to the cluster and remove the temporary master node.

**NOTE**: Because the temporary master node is in the `all` role, you might see some pods scheduled on the temporary master node. This is expected, and once the node is `active,` you can `cordon` and `drain` the node to move the pods off the node.

1. Go to the cluster in the Rancher Explorer view
2. Go to `cluster`, then click on the `Nodes` menu
3. Select the temporary master node
4. Click on the `Cordon` button
5. Click on the `Drain` button

You can then rejoin the old master nodes back to the cluster:

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Registration` tab
3. Check the box for `etcd, controlplane` or whatever they were before
4. Copy the Registration Command and run it on the old master nodes.

**NOTE**: It is recommended to clean the old nodes before adding them back to the cluster. This can be done by running the following command on each node:

```bash
curl -sLO https://github.com/rancherlabs/support-tools/raw/master/extended-rancher-2-cleanup/extended-cleanup-rancher2.sh
```

Please see the official documentation for more information [here](https://www.suse.com/support/kb/doc/?id=000020162).

It is not recommended to all the old master nodes back to the cluster at the same time. It is recommended to add one node at a time and wait for the node to be fully `active` before adding the next node.

Once all the old master nodes have been added back to the cluster, you can remove the temporary master node:

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Machines` tab
3. Select the temporary master node
4. Click on the `Delete` button

**NOTE**: You might see workers being updated during this process. This is expected, and they will self-correct once the cluster is fully updated.

At this point, the cluster should be fully recovered and in a fully HA state. You can confirm this by going to the `Nodes` tab in Rancher. You should see all the master nodes in the `Active` state and all the worker nodes in the `Ready` state.

## [Failed RKE2 upgrade](#failed-rke2-upgrade)

This section will cover the steps to recover an RKE2 cluster after a failed RKE2 upgrade. This section assumes that you have etcd backups and no master nodes have been lost.

We first want to capture the logs from all the master nodes. This can be done by running the following command on each master node:

```bash
curl -Ls rnch.io/rancher2_logs | bash
```

This will create a tarball of the logs in the `/tmp` directory. If needed, the tarball can be copied off the node and extracted for review.

This is very important to do before proceeding, as the following steps will remove the etcd data directory, and the logs will be lost, so things like an RCA will be much more difficult.

We are first going to try a snapshot restore.

1. Go to the cluster in the Rancher Cluster Manager view
2. Go to the action menu in the top right corner
3. Select `Restore Snapshot`
4. Select an etcd snapshot that is before the upgrade

At this point, Rancher should take over and restore the etcd snapshot. Once the restore is done, the cluster should be in its state before the upgrade. You can confirm this by going to the `Nodes` tab in Rancher. The worker nodes will bounce up and down as they are trying to connect to the new master node. This is expected and will self-correct once the cluster is fully recovered. This process can take some time, depending on the size of the cluster.

If the snapshot restore fails, we will need to manually recover the cluster using the steps from the RKE2 Standalone Disaster Recovery Guide [here](https://support.tools/post/rke2-standalone-disaster-recovery/).

## [RKE2 downgrade](#rke2-downgrade)

This section will cover the steps required to downgrade an RKE2 cluster. This section assumes that you have etcd backups and no master nodes have been lost.

**NOTE** This process is not officially supported by Rancher. Please use it at your own risk.

If the cluster is healthy, you need to downgrade the cluster. For example, a k8s application has issues with the newer version of k8s, and fixing the application will take some time. You can downgrade the cluster to the previous version of k8s to get the application back online. 

We first want to capture the logs from all the master nodes. This can be done by running the following command on each master node:

```bash
curl -Ls rnch.io/rancher2_logs | bash
```

This will create a tarball of the logs in the `/tmp` directory. If needed, the tarball can be copied off the node and extracted for review.

This is very important to do before proceeding, as the following steps will remove the etcd data directory, and the logs will be lost, so things like an RCA will be much more difficult.

We are first going to take a snapshot of the cluster.

1. Go to the cluster in the Rancher Cluster Manager view
2. Go to the action menu in the top right corner
3. Select `Take Snapshot`

At this point, Rancher should take a snapshot of the cluster. You will see the new snapshot popup in the list of snapshots.

We now need to edit the rke2 upgrade plan to downgrade the cluster.

1. Open a kubectl shell to the cluster
2. Run the following command to get the plans that need to be changed:

```bash
kubectl -n cattle-system get plan
```

You should see something like this:

```bash
AME               IMAGE                  CHANNEL   VERSION
rke2-master-plan   rancher/rke2-upgrade             v1.26.9+rke2r1
rke2-worker-plan   rancher/rke2-upgrade             v1.26.9+rke2r1
```

**NOTE**: The version will differ depending on the version of k8s you are running.

3. Run the following command to edit the master plan:

```bash
kubectl -n cattle-system edit plan rke2-master-plan
```

4. Change the version to the previous version of k8s under `spec.version` IE `v1.26.8+rke2r1` **NOTE**: The version will be different depending on the version of k8s that you are running and need to be the full version IE `v1.26.8+rke2r1` not `v1.26.8`.

5. Run the following command to edit the worker plan:

```bash
kubectl -n cattle-system edit plan rke2-worker-plan
```

6. Change the version to the previous version of k8s under `spec.version` IE `v1.26.8+rke2r1` **NOTE**: The version will be different depending on the version of k8s that you are running and need to be the full version IE `v1.26.8+rke2r1` not `v1.26.8`.

At this point, RKE2 should take over and downgrade the cluster. You can monitor the process by running the following command:

```bash
kubectl -n cattle-system get pods -w
```

**NOTE**: You should see pods created for each node starting with the master nodes. Once the master nodes are done, you should see pods being created for the worker nodes. You will see the nodes disconnect and reconnect during this process. This is expected and will self-correct once the node is fully downgraded.

Once the upgrade is done, the cluster should be in the previous version of k8s. You can confirm this by running the following command:

```bash
kubectl get nodes -o wide
```

You should see the nodes in the previous version of k8s.

Currently, the cluster is in the previous version of k8s, and you can start troubleshooting the application. But, it is crucial to remember that the cluster is unsupported. You should wait to make any changes to the cluster until the cluster is upgraded to the latest version of k8s, and you should upgrade the cluster as soon as possible.

## [Recovering after etcd quorum loss](#recovering-after-etcd-quorum-loss)

This section will cover the steps required to recover an RKE2 cluster after an etcd quorum loss. This section assumes that you have a single healthy master node with the other master nodes in an unhealthy state, IE, Offline, NotReady, etc.

We first want to capture the logs from all the master nodes. This can be done by running the following command on each master node:

```bash
curl -Ls rnch.io/rancher2_logs | bash
```

This will create a tarball of the logs in the `/tmp` directory. If needed, the tarball can be copied off the node and extracted for review.

This is very important to do before proceeding, as the following steps will remove the etcd data directory, and the logs will be lost, so things like an RCA will be much more difficult.

We are first going to take a snapshot of the cluster.

1. Go to the cluster in the Rancher Cluster Manager view
2. Go to the action menu in the top right corner
3. Select `Take Snapshot`

At this point, Rancher should take a snapshot of the cluster. You will see the new snapshot popup in the list of snapshots.

We now need to remove the unhealthy master nodes from the cluster. This can be done by using the following steps:

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Machines` tab
3. Select the unhealthy master nodes
4. Click on the `Delete` button

**NOTE**: If you are using a node driver like AWS, GCP, Azure, etc. this will trigger the deletion of the nodes in the infrastructure. So please double-check that you are only deleting the unhealthy master nodes and not the healthy master nodes. If you are using local-only etcd backups, you must ensure that the healthy master node can access the etcd snapshot—IE rsync the etcd snapshot to the healthy master node before deleting the unhealthy master nodes.

If a node is stuck in the `Deleting` state, you might need to remove a stuck finalizer, which can be done using the steps:

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Machines` tab
3. Select the node that is stuck in the `Deleting` state
4. Click on the `Edit as YAML` button
5. Remove the `machine.cluster.x-k8s.io` finalizer

At this point, you should only have the healthy master node in the cluster. You can confirm this by going to the `Nodes` tab in Rancher. If you have any unhealthy master nodes left, you will need to remove them. It is recommended to power off the nodes, disconnect the network, or run the command `rke2-killall.sh` on the nodes to prevent them from returning online during recovery.

The cluster should be in an `Active` state, and the applications should be working. However, we are not in a fully HA state yet. We need to add the additional master nodes back to the cluster using the following steps:

1. Go to the cluster in the Rancher Cluster Manager view
2. Click on the `Registration` tab
3. Check the box for `etcd, controlplane` or whatever they were before
4. Copy the Registration Command and run it on the old master nodes.

**NOTE**: It is recommended to clean the old nodes before adding them back to the cluster. This can be done by running the following command on each node:

```bash
curl -sLO https://github.com/rancherlabs/support-tools/raw/master/extended-rancher-2-cleanup/extended-cleanup-rancher2.sh
```

Please see the official documentation for more information [here](https://www.suse.com/support/kb/doc/?id=000020162).

It is not recommended to all the old master nodes back to the cluster at the same time. It is recommended to add one node at a time and wait for the node to be fully `active` before adding the next node.

Once all the old master nodes have been added to the cluster, you should be fully HA. You can confirm this by going to the `Nodes` tab in Rancher. You should see all the master nodes in the `Active` state and all the worker nodes in the `Ready` state.

If you are not fully HA, you can restore the cluster from the snapshot you took in the previous steps.

1. Go to the cluster in the Rancher Cluster Manager view
2. Go to the action menu in the top right corner
3. Select `Restore Snapshot`
4. Select the snapshot that you took in the previous steps

At this point, Rancher should take over and restore the snapshot. Once the restore is done, the cluster should be in its state before the upgrade. You can confirm this by going to the `Nodes` tab in Rancher. The worker nodes will bounce up and down as they are trying to connect to the new master node. This is expected and will self-correct once the cluster is fully recovered. This process can take some time, depending on the size of the cluster.

If the snapshot restore fails, we will need to manually recover the cluster using the steps from the RKE2 Standalone Disaster Recovery Guide [here](https://support.tools/post/rke2-standalone-disaster-recovery/).

## [Lost bootstrap node](#lost-bootstrap-node)

This section will cover the steps required to recover an RKE2 cluster after the loss of the bootstrap node. **NOTE** Rancher should be able to recover from this scenario automatically, but if you are having issues, you can use the steps below to retrieve the cluster.

We first want to capture the logs from all the master nodes. This can be done by running the following command on each master node:

```bash
curl -Ls rnch.io/rancher2_logs | bash
```

This will create a tarball of the logs in the `/tmp` directory. If needed, the tarball can be copied off the node and extracted for review.

This is very important to do before proceeding, as the following steps will remove the etcd data directory, and the logs will be lost, so things like an RCA will be much more difficult.

We are first going to take a snapshot of the cluster.

1. Go to the cluster in the Rancher Cluster Manager view
2. Go to the action menu in the top right corner
3. Select `Take Snapshot`

At this point, Rancher should take a snapshot of the cluster. You will see the new snapshot popup in the list of snapshots.

### [Fixing the cluster via Rancher](#fixing-the-cluster-via-rancher)

We are first going to try to fix the cluster via Rancher.

1. Open a kubectl shell to the local cluster
2. Run the following command to update the annotations for the control-plane node plan:

```bash
kubectl annotate secret -n fleet-default -l cluster.x-k8s.io/cluster-name=<cluster-name>,rke.cattle.io/init-node=true rke.cattle.io/join-url=https://<control-plane-node-ip>:9345
```

**NOTE**: You must replace `<cluster-name>` with the name of your cluster and `<control-plane-node-ip>` with the IP address of one of the control plane nodes.

3. Run the following command to update the annotations for the worker node plan:

```bash
kubectl annotate secret -n fleet-default -l cluster.x-k8s.io/cluster-name=<cluster-name>,rke.cattle.io/init-node!=true rke.cattle.io/joined-to=https://<control-plane-node-ip>:9345
```

**NOTE**: You must replace `<cluster-name>` with the name of your cluster and `<control-plane-node-ip>` with the IP address of one of the control plane nodes.

At this point, Rancher should take over and fix the cluster. You can monitor the process by viewing the `Nodes` tab in Rancher. You should see the nodes disconnect and reconnect during this process. This is expected and will self-correct once the node is fully recovered.

Please see [GH-42856](https://github.com/rancher/rancher/issues/42856#issue-1901592956) for more information.