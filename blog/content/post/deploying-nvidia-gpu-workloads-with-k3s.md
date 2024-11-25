---
title: "Deploying Nvidia GPU Workloads with k3s: A Comprehensive Guide"
date: 2025-01-15T00:00:00-05:00
draft: true
tags: ["Nvidia", "k3s"]
categories:
- Nvidia
- k3s
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to set up and manage Nvidia GPU workloads in a k3s cluster."
more_link: "yes"
url: "/deploying-nvidia-gpu-workloads-with-k3s/"
---

In today's fast-paced technological landscape, leveraging GPUs for high-performance computing is more crucial than ever. This guide walks you through deploying Nvidia GPU workloads using k3s, a lightweight Kubernetes distribution ideal for edge and IoT devices.

<!--more-->

# [Deploying Nvidia GPU Workloads with k3s](#deploying-nvidia-gpu-workloads-with-k3s)
## Section 1: Introduction to Nvidia GPUs and k3s  
In recent years, the demand for accelerated computing has surged, with GPUs playing a pivotal role in fields like machine learning, data analytics, and scientific simulations. Nvidia GPUs are at the forefront of this revolution, offering unparalleled performance for parallel computing tasks.

On the other hand, **k3s** is a lightweight Kubernetes distribution designed for resource-constrained environments. It is ideal for edge computing, IoT devices, and small-scale deployments where the full weight of Kubernetes might be unnecessary.

Combining Nvidia GPUs with k3s allows developers and operators to deploy powerful GPU-accelerated applications in environments where resources are limited. This integration opens up new possibilities for edge computing applications that require significant computational power without the overhead of traditional Kubernetes deployments.

## Section 2: Setting Up Nvidia GPUs in a k3s Cluster  
Here, we'll dive into the step-by-step process of configuring your k3s cluster to support Nvidia GPUs. This includes installing the necessary drivers, configuring device plugins, and deploying sample workloads to test GPU acceleration.

### Prerequisites
- A system with an Nvidia GPU installed.
- The Nvidia driver installed on the host machine.
- **k3s** installed on your system.
- Docker or another compatible container runtime.

### Step 1: Install Nvidia Container Toolkit
The Nvidia Container Toolkit enables GPU support in your container runtime.

```bash
distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo systemctl restart docker
```

### Step 2: Deploy Nvidia Device Plugin
The Nvidia device plugin for Kubernetes advertises GPUs to the kubelet.

```bash
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.13.0/nvidia-device-plugin.yml
```

### Step 3: Verify GPU Availability
Check if the GPUs are recognized by the cluster:

```bash
kubectl get nodes "-o=custom-columns=NAME:.metadata.name,GPU:.status.allocatable.nvidia\.com/gpu"
```

### Step 4: Deploy a GPU-Accelerated Application
Create a sample pod that utilizes the GPU.

**gpu-test-pod.yaml**
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: gpu-test-pod
spec:
  containers:
  - name: gpu-test-container
    image: nvidia/cuda:11.0-base
    resources:
      limits:
        nvidia.com/gpu: 1
    command: ["nvidia-smi"]
```

Apply the pod manifest:

```bash
kubectl apply -f gpu-test-pod.yaml
```

### Step 5: Check the Pod Logs
Verify that the pod is utilizing the GPU:

```bash
kubectl logs gpu-test-pod
```

You should see the output of `nvidia-smi`, indicating that the GPU is accessible within the container.

### Conclusion
By following these steps, you have successfully set up Nvidia GPU support in your k3s cluster and deployed a GPU-accelerated application. This setup enables you to run complex workloads at the edge, leveraging the power of Nvidia GPUs with the simplicity of k3s.
