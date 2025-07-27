---
title: "Understanding Persistent Volume Namespaces in k3s on Raspberry Pi"
date: 2024-05-18T19:26:00-05:00
draft: false
tags: ["k3s", "Raspberry Pi", "Persistent Volumes", "Kubernetes"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn about the namespace scoping of Persistent Volume Claims and Persistent Volumes in k3s on Raspberry Pi."
more_link: "yes"
url: "/understanding-persistent-volume-namespaces-in-k3s-on-raspberry-pi/"
---

Learn about the namespace scoping of Persistent Volume Claims and Persistent Volumes in k3s on Raspberry Pi. This guide will help you understand how they interact within a Kubernetes cluster.

<!--more-->

# [Understanding Persistent Volume Namespaces in k3s on Raspberry Pi](#understanding-persistent-volume-namespaces-in-k3s-on-raspberry-pi)

In Kubernetes, Persistent Volume Claims (PVCs) are namespace-scoped, while Persistent Volumes (PVs) are not. This distinction is important for managing storage in your k3s cluster on Raspberry Pi.

## [Viewing Persistent Volume Claims](#viewing-persistent-volume-claims)

PVCs are specific to namespaces. Here's how to view them:

```bash
kubectl get pvc
```

Example output:

```
NAME              STATUS   VOLUME           CAPACITY   ACCESS MODES   STORAGECLASS   AGE
testing-vol-pvc   Bound    testing-vol-pv   1Gi        RWO            iscsi          27h
```

To view PVCs in a specific namespace:

```bash
kubectl --namespace docker-registry get pvc
```

Example output:

```
NAME                  STATUS   VOLUME               CAPACITY   ACCESS MODES   STORAGECLASS   AGE
docker-registry-pvc   Bound    docker-registry-pv   1Gi        RWO            iscsi          23h
```

## [Viewing Persistent Volumes](#viewing-persistent-volumes)

PVs are not namespace-scoped. Here's how to view them:

```bash
kubectl get pv
```

Example output:

```
NAME                 CAPACITY   ACCESS MODES   RECLAIM POLICY   STATUS   CLAIM                                 STORAGECLASS   REASON   AGE
testing-vol-pv       1Gi        RWO            Retain           Bound    default/testing-vol-pvc               iscsi                   27h
docker-registry-pv   1Gi        RWO            Retain           Bound    docker-registry/docker-registry-pvc   iscsi                   23h
```

This distinction between PVCs and PVs is crucial for managing and allocating storage resources within your k3s cluster, ensuring that your applications have access to the necessary storage while maintaining proper namespace isolation.

By following these steps, you can effectively manage and understand the interactions between Persistent Volume Claims and Persistent Volumes in your k3s setup on Raspberry Pi.
