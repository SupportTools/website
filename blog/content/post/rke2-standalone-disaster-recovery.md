---
title: "RKE2 Standalone - Disaster Recovery Guide"
date: 2023-10-11T00:00:00-06:00
draft: false
tags: ["Rancher", "RKE2", "Disaster Recovery"]
categories:
- Rancher
- Kubernetes
- RKE2
- Disaster Recovery
author: "Matthew Mattox - mmattox@support.tools."
description: "This comprehensive guide covers essential steps for disaster recovery in RKE2 clusters not managed by Rancher."
more_link: "yes"
---

# RKE2 Standalone - Disaster Recovery Guide

## Introduction

The RKE2 Standalone Disaster Recovery Guide aims to provide comprehensive instructions for recovering a standalone RKE2 cluster that Rancher does not manage. RKE2, a lightweight Kubernetes distribution, is a robust solution, but disasters can happen. In this guide, we'll address common scenarios like recovering after etcd quorum loss, restoring a cluster from a backup, and troubleshooting issues when nodes cannot join the cluster.

Please note that this guide assumes a basic familiarity with RKE2 and Kubernetes concepts. If you encounter any challenges or have questions, please ask for assistance.

<!--more-->

# [RKE2 Disaster Recovery](#rke2-disaster-recovery)

## [Overview](#overview)

This document is intended to provide a comprehensive guide to recovering an RKE2 cluster not managed by Rancher. This document will cover the following scenarios:

- [Recovering after etcd quorum loss](#recovering-after-etcd-quorum-loss)
- [Restoring a cluster from a backup](#restoring-a-cluster-from-a-backup)
- [Nodes are not able to join the cluster](#nodes-are-not-able-to-join-the-cluster)

## [Recovering after etcd quorum loss](#recovering-after-etcd-quorum-loss)

If the etcd quorum is lost, the cluster will be in a non-functional state. This can be caused by several different scenarios, including:

- More than 50% of the etcd nodes are lost or unreachable
- The etcd data directory is lost or corrupted
- Network partitioning of the etcd nodes (split brain)

The following steps can be used to recover from a lost etcd quorum:

### [SSH access to all master/etcd nodes](#ssh-access-to-all-masteretcd-nodes)

All the master/etcd nodes will need to be accessed via SSH. If SSH access is unavailable, the nodes must be accessed via the console or other remote access method. You should have root or sudo access to the nodes.

### [Before proceeding, capture logs from all master/etcd nodes](#before-proceeding-capture-logs-from-all-masteretcd-nodes)

Before proceeding, it is recommended to capture logs from all master/etcd nodes. This can be done by running the following command on each master/etcd node:

```bash
curl -Ls rnch.io/rancher2_logs | bash
```

This will create a tarball of the logs in the `/tmp` directory. If needed, the tarball can be copied off the node and extracted for review.

This is very important to do before proceeding, as the following steps will remove the etcd data directory, and the logs will be lost, so things like an RCA will be much more difficult.

### [Find out if there is still an etcd member running](#find-out-if-there-is-still-an-etcd-member-running)

The first step is to determine if an etcd member is still running. This can be done by running the following command on each master/etcd node:

```bash
export CRI_CONFIG_FILE=/var/lib/rancher/rke2/agent/etc/crictl.yaml
/var/lib/rancher/rke2/bin/crictl ps | grep etcd
```

If an etcd member is running, the output will look similar to the following:

```bash
root@node01:~# /var/lib/rancher/rke2/bin/crictl ps | grep etcd
fa1044d38fb23       c6b7a4f2f79b2       9 minutes ago       Running             etcd                       0                   a62dd384073b0       etcd-node01
root@node01:~# 
```

If no etcd member is running, the output will look similar to the following:

```bash
root@node03:~# /var/lib/rancher/rke2/bin/crictl ps | grep etcd
E1011 03:53:13.983145  356361 remote_runtime.go:390] "ListContainers with filter from runtime service failed" err="rpc error: code = Unavailable desc = connection error: desc = \"transport: Error while dialing dial unix /run/k3s/containerd/containerd.sock: connect: connection refused\"" filter="&ContainerFilter{Id:,State:&ContainerStateValue{State:CONTAINER_RUNNING,},PodSandboxId:,LabelSelector:map[string]string{},}"
FATA[0000] listing containers: rpc error: code = Unavailable desc = connection error: desc = "transport: Error while dialing dial unix /run/k3s/containerd/containerd.sock: connect: connection refused" 
root@node03:~# 
```

If an etcd member is running, then that node will be used to recover the etcd cluster. For the rest of this guide, we are going to assume that `node01` is our sole surviving etcd member.

**NOTE** If no etcd members are running, we must see who has the most recent etcd data. This can be done by running the following command on each master/etcd node:

```bash
ls -l /var/lib/rancher/rke2/server/db/etcd/member/wal/
```

### [Backup the etcd data directory](#backup-the-etcd-data-directory)

The next step is to back up the etcd data directory. This can be done by running the following command on all master/etcd nodes:

```bash
tar -czvf ~/etcd-backup.tar.gz /var/lib/rancher/rke2/server/db/snapshots
```

This will create a tarball of the etcd data directory in the user's home directory running the command. 

We also need to grab the token for the cluster as that is the encryption key for the etcd data. This can be done by running the following command on any master/etcd node:

```bash
cat /var/lib/rancher/rke2/server/token
```

This will output the token for the cluster.

**NOTE** The token can only be recovered if it is recovered. If the token is lost, the etcd data will not be recoverable. And the cluster will need to be rebuilt. This is why it is crucial to back up the token. I recommend storing the token in a password manager or other secure location.

### [Stop the RKE2 service on all master/etcd nodes](#stop-the-rke2-service-on-all-masteretcd-nodes)

The next step is to stop the RKE2 service on all master/etcd nodes. This can be done by running the following command on all master/etcd nodes:

```bash
systemctl stop rke2-server
rke2-killall.sh
```

### [Reset the etcd cluster from the surviving etcd member](#reset-the-etcd-cluster-from-the-surviving-etcd-member)

The next step is to reset the etcd cluster from the surviving etcd member. This can be done by running the following command on the surviving etcd member:

```bash
rke2 server --cluster-reset
```

This will reset the etcd cluster and remove the other etcd members from the etcd cluster but not from the Kubernetes cluster.

This command usually takes a few minutes to complete.

### [Start the RKE2 service on the surviving etcd member](#start-the-rke2-service-on-all-masteretcd-nodes)

At this point, the etcd data should be recovered, and the surviving etcd member should be able to start. This can be done by running the following command on the surviving etcd member:

```bash
systemctl start rke2-server
```

**NOTE** I usually recommend adding an `&` to the end of the command to run it in the background. This will allow you to continue monitoring the logs while the service starts. The system will return to the command prompt once the service is created, which can take a few minutes.

To monitor the logs, you can run the following command:

```bash
journalctl -u rke2-server -f
```

### [Verify the master node is back online](#verify-the-master-node-is-back-online)

Once the RKE2 service is started, the master node should return online. This can be verified by running the following command on the master node:

```bash
kubectl get nodes -o wide
```

**NOTE** You might see some nodes in a `Ready` state even though they are not online. This is because the nodes have not timed out yet, and if you wait a few minutes, they will be marked as `NotReady`.

### [Start the RKE2 service on the other master/etcd nodes](#start-the-rke2-service-on-the-other-masteretcd-nodes)

Our cluster is back online, but we still need to start the RKE2 service on the other master/etcd nodes. This can be done by running the following command on the other master/etcd nodes one at a time:

```bash
rm -rf /var/lib/rancher/rke2/server/db
systemctl start rke2-server
```

**NOTE** The first command we run is an `rm -rf` of the etcd data directory. This is because we will restore the etcd data from the surviving etcd member. And we need to remove the existing etcd data directory before we can restore the etcd data.

We must refrain from running these commands on the surviving etcd member, as we do not want to remove the etcd data we just recovered.

### [Verify all master nodes are back online](#verify-all-master-nodes-are-back-online)

Once the RKE2 service is started on all the master/etcd nodes, the master nodes should be back online. This can be verified by running the following command on the master nodes:

- Verify all master nodes are in a `Ready` state

```bash
kubectl get nodes -o wide
```

- Verify all etcd pods are in a `Running` state

```bash
kubectl -n kube-system get pods -l component=etcd -o wide
```

***NOTE** You might see some of the etcd pods in the `Running` state even though they are not online. You can tell this by looking at the `AGE` column. If the `AGE` column should be in the minutes range and not the hours range. If you see any etcd pods in the hours range, they are not online, and you need to verify that the RKE2 service is started on the node.

You can also verify that the etcd cluster is healthy by running the following command on any master node:

```bash
for etcdpod in $(kubectl -n kube-system get pod -l component=etcd --no-headers -o custom-columns=NAME:.metadata.name); do kubectl -n kube-system exec $etcdpod -- sh -c "ETCDCTL_ENDPOINTS='https://127.0.0.1:2379' ETCDCTL_CACERT='/var/lib/rancher/rke2/server/tls/etcd/server-ca.crt' ETCDCTL_CERT='/var/lib/rancher/rke2/server/tls/etcd/server-client.crt' ETCDCTL_KEY='/var/lib/rancher/rke2/server/tls/etcd/server-client.key' ETCDCTL_API=3 etcdctl member list"; done
```
You should see output similar to the following:

```bash
1a8d3e1d1e41231, started, a1ublabamd03-b76516fb, https://172.28.3.63:2380, https://172.28.3.63:2379, false
5c99806695f85090, started, a1ublabamd02-d8251d1c, https://172.28.3.62:2380, https://172.28.3.62:2379, false
9b0c89aa22680daf, started, a1ublabamd01-f32e7f4e, https://172.28.3.61:2380, https://172.28.3.61:2379, false
1a8d3e1d1e41231, started, a1ublabamd03-b76516fb, https://172.28.3.63:2380, https://172.28.3.63:2379, false
5c99806695f85090, started, a1ublabamd02-d8251d1c, https://172.28.3.62:2380, https://172.28.3.62:2379, false
9b0c89aa22680daf, started, a1ublabamd01-f32e7f4e, https://172.28.3.61:2380, https://172.28.3.61:2379, false
1a8d3e1d1e41231, started, a1ublabamd03-b76516fb, https://172.28.3.63:2380, https://172.28.3.63:2379, false
5c99806695f85090, started, a1ublabamd02-d8251d1c, https://172.28.3.62:2380, https://172.28.3.62:2379, false
9b0c89aa22680daf, started, a1ublabamd01-f32e7f4e, https://172.28.3.61:2380, https://172.28.3.61:2379, false
```

If you see any errors like the following, then the etcd cluster is not healthy:

```bash
5c99806695f85090, started, a1ublabamd02-d8251d1c, https://172.28.3.62:2380, https://172.28.3.62:2379, false
9b0c89aa22680daf, started, a1ublabamd01-f32e7f4e, https://172.28.3.61:2380, https://172.28.3.61:2379, false
5c99806695f85090, started, a1ublabamd02-d8251d1c, https://172.28.3.62:2380, https://172.28.3.62:2379, false
9b0c89aa22680daf, started, a1ublabamd01-f32e7f4e, https://172.28.3.61:2380, https://172.28.3.61:2379, false
Error from server: error dialing backend: proxy error from 127.0.0.1:9345 while dialing 172.28.3.63:10250, code 503: 503 Service Unavailable
```

## [Restoring a cluster from a backup](#restoring-a-cluster-from-a-backup)

The cluster will be non-functional if the etcd data directory is lost or corrupted. This can be caused by several different scenarios, including:

- The etcd data directory is lost or corrupted
- All etcd/masters are lost and unrecoverable
- Failed k8s upgrade

You will follow the same steps as [Recovering after etcd quorum loss](#recovering-after-etcd-quorum-loss) with the following exceptions:

For the cluster reset, you will run the following command on the surviving etcd member:

```bash
rke2 server --cluster-reset --cluster-reset-restore-path=<SNAPSHOT-NAME>
```

**NOTE** The `<SNAPSHOT-NAME>` is the name of the snapshot that you want to restore. You can get a list of snapshots by running the following command on the surviving etcd member:

```bash
ls -l /var/lib/rancher/rke2/server/db/snapshots
```

If you are using S3 as your backup location, go to the S3 bucket and get the name of the snapshot you want to restore from there.

Understanding that only that data is lost if the snapshots are stored locally is vital. We can only do something other than rebuilding the cluster. This goes the same for the token. If the token is lost then even with the etcd snapshots, we will be unable to recover the cluster. However, you can find the token on worker nodes, too, under the config file `/etc/rancher/rke2/config.yaml`

## [Nodes are not able to join the cluster](#nodes-are-not-able-to-join-the-cluster)

If the nodes cannot join the cluster, you must troubleshoot the issue. The following steps can be used to troubleshoot the issue:

- The bootstrap token is not valid on some nodes
- The master/etcd node(s) cannot communicate with each other (firewall, etc.)
- The worker node(s) are not able to communicate with the master/etcd nodes (firewall, etc)
- The bootstrap server defined in the `config.yaml` file is not reachable from the nodes
- If using a load balancer, the load balancer is not configured correctly or has failed nodes in the backend pool that requests are being sent to

### [Bootstrap token is not valid on some nodes](#bootstrap-token-is-not-valid-on-some-nodes)

All nodes in the cluster will need to have the same token in the `/etc/rancher/rke2/config.yaml` file. This token is created when the cluster is created and is stored in the `/var/lib/rancher/rke2/server/token` file on the master/etcd nodes.

If the token is not valid, then the rke2-server / rke2-agent service will not start because it cannot decrypt the connection information for the cluster.

**NOTE** The token can not be rotated and should never be changed.

You can test the token by running the following command on the master/etcd nodes:

```bash
curl -ks https://node:`cat /var/lib/rancher/rke2/server/token | awk -F ':' '{print $4}'`@node01:9345/v1-rke2/readyz
```

For worker nodes, you can run the following command:

```bash
curl -ks https://node:`cat /var/lib/rancher/rke2/server/agent-token  | awk -F ':' '{print $4}'`@node01:9345/v1-rke2/readyz
```

### [Master/etcd node(s) are not able to communicate with each other](#masteretcd-nodes-are-not-able-to-communicate-with-each-other)

If the master/etcd nodes cannot communicate with each other, then the cluster will not be able to form. This can be caused by several different scenarios, including:

- Firewall blocking traffic between the master/etcd nodes
- Network partitioning of the master/etcd nodes (split brain)

You can verify that the master/etcd nodes can communicate with each other by running the following command on each master/etcd node:

```bash
curl -vks https://node01:9345/ping
curl -vks https://node02:9345/ping
curl -vks https://node03:9345/ping
```

You should get the word `pong` back from each node.

All the firewall ports that need to be open can be found in the [RKE2 documentation](https://docs.rke2.io/install/requirements#inbound-network-rules).

### [Worker node(s) are not able to communicate with the master/etcd nodes](#worker-nodes-are-not-able-to-communicate-with-the-masteretcd-nodes)

If the worker nodes cannot communicate with the master/etcd nodes, then the worker nodes will not be able to join the cluster. This can be caused by several different scenarios, including:

- Firewall blocking traffic between the worker nodes and the master/etcd nodes
- Network partitioning of the worker nodes and the master/etcd nodes (split brain)
- The bootstrap server defined in the `config.yaml` file is not reachable from the nodes
- If using a load balancer, the load balancer is not configured correctly or has failed nodes in the backend pool that requests are being sent to.

You can verify that the worker nodes can communicate with the master/etcd nodes by running the following command on each worker node:

```bash
curl -ks https://node:`cat /var/lib/rancher/rke2/server/agent-token  | awk -F ':' '{print $4}'`@node01:9345/v1-rke2/readyz
```

You should get the word `ok` back from each node.

It's important to understand that worker nodes use `9345` to communicate with the master/etcd nodes during the bootstrap process. Once the worker node is joined to the cluster, it will use `6443` to communicate with the master/etcd nodes.

Once the worker node is joined to the cluster, RKE2 will get a list of all master nodes and will use that list to communicate with the master/etcd nodes. This means that if you are using a load balancer, then the load balancer will need to be configured to send traffic to all master/etcd nodes. The server defined in the `config.yaml` file is an introduction server only used during the bootstrap process.

# [Conclusion](#conclusion)

This concludes the RKE2 Disaster Recovery guide. If you have any questions or comments, don't hesitate to contact me on [Twitter](https://twitter.com/cube8021).