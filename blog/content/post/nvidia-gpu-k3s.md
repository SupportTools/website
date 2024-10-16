---
title: "How to Install Nvidia GPU Drivers on K3s"
date: 2024-10-15T10:00:00-05:00
draft: false
tags: ["Nvidia", "K3s", "GPU"]
categories:
- Nvidia
- k3s
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed guide on installing Nvidia GPU drivers on K3s for machine learning workloads."
more_link: "yes"
url: "/nvidia-gpu-k3s/"
---

## How to Install Nvidia GPU Drivers on K3s

If you're running a K3s cluster and need to leverage Nvidia GPUs for AI or machine learning workloads, this guide will walk you through the installation and configuration process of Nvidia drivers for your Kubernetes environment.

<!--more-->

### 1. Prerequisites

Ensure the following before proceeding:

- A K3s cluster running on compatible nodes with Nvidia GPUs.
- Access to the node's terminal.

### 2. Installing Nvidia Drivers on the Node

```bash
sudo apt update
sudo apt install nvidia-driver-450 -y
```

### 3. Configuring K3s for GPU Access

To configure K3s to recognize GPUs, you need to install Nvidia's device plugin:

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/master/nvidia-device-plugin.yml
```

### 4. Verifying GPU Access

To verify that the GPU is accessible by K3s, run the following command:

```bash
kubectl get nodes -o json | jq '.items[] | {name:.metadata.name, gpus:.status.capacity.nvidia\.com/gpu}'
```
