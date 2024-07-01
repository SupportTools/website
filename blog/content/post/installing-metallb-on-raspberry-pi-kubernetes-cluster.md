---
title: "Installing MetalLB on Raspberry Pi Kubernetes Cluster"
date: 2024-06-30T23:18:00-05:00
draft: false
tags: ["Kubernetes", "Raspberry Pi", "MetalLB", "Helm"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to install MetalLB on a Raspberry Pi Kubernetes cluster using Helm for load balancing services."
more_link: "yes"
url: "/installing-metallb-on-raspberry-pi-kubernetes-cluster/"
---

Learn how to install MetalLB on a Raspberry Pi Kubernetes cluster using Helm for load-balancing services. This guide provides a detailed step-by-step process.

<!--more-->

# [Installing MetalLB on Raspberry Pi Kubernetes Cluster](#installing-metallb-on-raspberry-pi-kubernetes-cluster)

## [Installation with Helm](#installation-with-helm)

Follow the instructions from the [MetalLB installation guide](https://metallb.universe.tf/installation/#installation-with-helm).

### Add the Helm Repository

```bash
helm repo add metallb https://metallb.github.io/metallb
```

### Create the Values File

My home network is `192.168.28.x`, and my DHCP server allocates `.100` and up, so we’ll use a pool of addresses outside that range.

```yaml
# values.yaml
configInline:
  address-pools:
 - name: default
     protocol: layer2
     addresses:
 - 192.168.28.10-192.168.28.40
```

Note that since version 0.13.x, you can use CRDs to define the configuration without needing a ConfigMap.

### Run the Installation

```bash
helm --namespace metallb-system \
 install --create-namespace \
    metallb metallb/metallb -f values.yaml
```

To upgrade later:

```bash
helm --namespace metallb-system upgrade metallb metallb/metallb
```

## [Testing the Installation](#testing-the-installation)

### Create and Expose an NGINX Deployment

```bash
kubectl create deployment nginx --image=nginx
kubectl expose deployment nginx --type=LoadBalancer --port 80
```

### Verify the Services

```bash
kubectl get services
```

Example output:

```
NAME         TYPE           CLUSTER-IP      EXTERNAL-IP     PORT(S)        AGE
kubernetes   ClusterIP      10.43.0.1       <none>          443/TCP        5h53m
nginx        LoadBalancer   10.43.156.110   192.168.28.11   80:32580/TCP   117s
```

### Scale the Deployment

```bash
kubectl scale deployment --replicas=3 nginx
```

## [Disabling Klipper](#disabling-klipper)

I just remembered I need to disable Klipper, the K3s-provided load balancer. It doesn’t seem to do any harm, but I’ll deal with that later.

Following these steps, you can install MetalLB on your Raspberry Pi Kubernetes cluster, enabling load balancing for your services.
