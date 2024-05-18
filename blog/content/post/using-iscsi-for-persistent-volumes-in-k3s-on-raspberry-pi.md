---
title: "Using iSCSI for Persistent Volumes in k3s on Raspberry Pi"
date: 2024-05-28T02:11:00-05:00
draft: false
tags: ["k3s", "Raspberry Pi", "iSCSI", "Synology NAS", "Persistent Volumes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to use iSCSI for persistent volumes in k3s on a Raspberry Pi, with a Synology NAS as the iSCSI target."
more_link: "yes"
---

Learn how to use iSCSI for persistent volumes in k3s on a Raspberry Pi, with a Synology NAS as the iSCSI target. This guide will walk you through setting up the iSCSI target and configuring your Kubernetes deployment.

<!--more-->

# [Using iSCSI for Persistent Volumes in k3s on Raspberry Pi](#using-iscsi-for-persistent-volumes-in-k3s-on-raspberry-pi)

The default option for persistent volumes in k3s is local-path, which provisions storage on the node’s local disk. This ties the container to a specific node. To avoid this, we can use iSCSI. Here's how to set up iSCSI with a Synology NAS as the target.

## [Setting up the iSCSI Target](#setting-up-the-iscsi-target)

Setting up the iSCSI target on a Synology NAS is straightforward:

1. Log into the DS211.
2. Open the main menu and choose "iSCSI Manager" (or "SAN Manager" in DSM 7.x).
3. On the "Target" page, click "Create".
4. Give it a sensible name (e.g., "testing") and edit the IQN, replacing "Target-1" with "testing".
5. Skip CHAP authentication if on a local, trusted network.
6. Select "Create a new iSCSI LUN", name it (e.g., "testing-LUN-1"), and choose the default location and capacity (1GB for testing).
7. Choose between "Thick" and "Thin" provisioning.

Refer to these resources for additional guidance:

- [Synology KB: How to start using the iSCSI target service on Synology NAS](https://www.synology.com/en-global/knowledgebase)
- [TechRepublic: How to integrate a Synology NAS in your VMware Lab](https://www.techrepublic.com/article/how-to-integrate-a-synology-nas-into-your-vmware-lab/)
- [ServeTheHome: How to Setup an iSCSI Target Using a Synology DS1812+ NAS](https://www.servethehome.com/synology-ds1812-nas-setup-iscsi-targets/)

## [Installing the open-iscsi Package](#installing-the-open-iscsi-package)

Install the `open-iscsi` package on all cluster nodes:

```bash
sudo apt install open-iscsi
```

## [Mounting the Volume](#mounting-the-volume)

Here’s what the deployment configuration looks like:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: testing
  labels:
    app: testing
spec:
  replicas: 1
  selector:
    matchLabels:
      app: testing
  template:
    metadata:
      labels:
        app: testing
        name: testing
    spec:
      containers:
      - name: ubuntu
        image: ubuntu:latest
        command: ["/bin/sleep", "7d"]
        volumeMounts:
        - name: testing-vol
          mountPath: /var/lib/testing
      volumes:
      - name: testing-vol
        iscsi:
          targetPortal: 172.25.22.100:3260
          iqn: iqn.2000-01.com.synology:ds211.testing.88a4c0ddef
          lun: 1
          readOnly: false
```

## [Troubleshooting](#troubleshooting)

If the container refuses to mount the volume, ensure the `open-iscsi` package is installed and configured correctly. Run `iscsid` in debug mode for more details.

To manually mount the volume on a node, use:

```bash
sudo iscsiadm -m discovery -t sendtargets -p 172.25.22.100:3260
sudo iscsiadm -m node --targetname iqn.2000-01.com.synology:ds211.testing.88a4c0ddef --portal 172.25.22.100:3260 --login
```

## [Checking the Deployment](#checking-the-deployment)

Verify the deployment and ensure the volume is mounted correctly:

```bash
sudo kubectl get endpoints testing
curl 10.42.1.20:4000
```

Following these steps, you can set up and use iSCSI for persistent volumes in k3s on a Raspberry Pi.
