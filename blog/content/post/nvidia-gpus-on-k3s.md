---
title: "Setting up Nvidia drivers for k3s"
date: 2022-07-05T03:24:00-05:00
draft: false
tags: ["Nvidia", "k3s"]
categories:
- Nvidia
- k3s
author: "Matthew Mattox - mmattox@support.tools."
description: "Implementing CUDA workloads on NVIDIA GPUs with K3s."
more_link: "yes"
---

Rather than telling you how great Kubernetes is, this article aims to show you how to enhance it for workloads requiring GPUs so you can get the most out of it. A few steps need to be followed if you wish to run Kubernetes Pods on K3S that use NVIDIA GPUs for CUDA workloads, and this process is straightforward. Despite this, it has come to my attention that there doesn't appear to be any set of instructions clearly showing the steps to follow, which components are needed, how to enable them, etc. As a result, I have decided to write this short article that outlines the necessary steps to be taken.

<!--more-->
# [Install steps](#install-steps)

## Install NVIDIA Drivers
We can first search the available drivers using apt:
```
sudo apt-get search nvidia-driver
```

As of the writing, the latest available driver version is 515, so let us go ahead and install this version:
```
sudo apt install nvidia-headless-515-server
```

Installing "headless" or "server" drivers is essential to pay attention. X11 is often included in the standard NVIDIA drivers suggested by many resources. In other words, once you install these standard drivers on your host, you can also enable the GUI as soon as you do so. There is an excellent chance that you would not want this for a Kubernetes node, although it will not impact how your Kubernetes cluster works. Alternatively, the headless server versions of the driver package only install the device drivers, and we would prefer to install them separately rather than the headless server versions.

## Install NVIDIA Container Toolkit
The NVIDIA Container Toolkit is a tool that allows you to run containers on NVIDIA GPUs. It is a prerequisite for running Kubernetes Pods on NVIDIA GPUs.

There is good documentation for the Container Toolkit. Make sure you only install the containerd version of the toolkit. Since Kubernetes already deprecated Docker, K3S does not use Docker at all. It uses only containerd to manage containers. It is not necessary to install Docker support since it will also implicitly install Containerd support. Still, since we don't want to install unnecessary packages on our Kubernetes nodes, we install Containerd directly.

The documentation is [here](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/overview.html). If you directly want to jump to the installation, first install the repositories:

```
distribution=$(. /etc/os-release;echo $ID$VERSION_ID) \
 && curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add — \
 && curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list
```

Now we can install the nvidia-container-runtime:

```
sudo apt update -y && sudo apt install nvidia-container-runtime
```

To test whether your GPU is exposed to a container, run a test container as follows:

```

sudo ctr image pull docker.io/nvidia/cuda:11.0-base
sudo ctr run --rm --gpus 0 -t docker.io/nvidia/cuda:11.0-base cuda-11.0-base nvidia-smi
```

You should see the nvidia-smi output, but running this time inside a container!

## Configure k3s to use nvidia-container-runtime
It is now time to tell K3S to use nvidia-container-runtime on our node's containerd.

For that, our friends at K3D have created a [practical guide](https://k3d.io/usage/guides/cuda/#configure-containerd). There is only one section in that guide we are interested in: "Configure containerd." The template they shared configures the containerd to use the nvidia-container-runtime plugin and some additional boilerplate settings. Using the following command, we can install that template on our node:

```
sudo wget https://k3d.io/v4.4.8/usage/guides/cuda/config.toml.tmpl -O /var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl
```

## Install NVIDIA device plugin for Kubernetes
We use the NVIDIA device plugin for Kubernetes to scan the GPUs on each node and expose them as GPU resources to the Kubernetes nodes using the device plugin.

You can also use the Helm chart to install the device plugin if you follow the documentation that comes with the plugin. A Helm controller built into K3S allows us to install Helm charts onto our cluster with just a couple of clicks. This Helm chart can be leveraged and deployed in the following way:

```
cat <<EOF | kubectl apply -f -
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: nvidia-device-plugin
  namespace: kube-system
spec:
  chart: nvidia-device-plugin
  repo: https://nvidia.github.io/k8s-device-plugin
EOF
```

In addition to applying the manifest directly, you can install the device plugin using "helm install." Ultimately, it comes down to what you like.

You can find the manifest files [here](https://github.com/NVIDIA/k8s-device-plugin#enabling-gpu-support-in-kubernetes).

## Test everything on a CUDA-enabled Pod
Finally, we can create a Pod that requests a GPU resource using the CUDA Docker image:

```
cat <<EOF | kubectl create -f -
apiVersion: v1
kind: Pod
metadata:
  name: gpu
spec:
  restartPolicy: Never
  containers:
    - name: gpu
      image: "nvidia/cuda:11.4.1-base-ubuntu20.04"
      command: [ "/bin/bash", "-c", "--" ]
      args: [ "while true; do sleep 30; done;" ]
      resources:
        limits:
          nvidia.com/gpu: 1
EOF
```

Finally, let us run the nvidia-smi on our Pod:

```
kubectl exec -it gpu -- nvidia-smi
Sun Jul 05 15:17:08 2022
+-----------------------------------------------------------------------------+
| NVIDIA-SMI 470.57.02    Driver Version: 470.57.02    CUDA Version: 11.4     |
|-------------------------------+----------------------+----------------------+
| GPU  Name        Persistence-M| Bus-Id        Disp.A | Volatile Uncorr. ECC |
| Fan  Temp  Perf  Pwr:Usage/Cap|         Memory-Usage | GPU-Util  Compute M. |
|                               |                      |               MIG M. |
|===============================+======================+======================|
|   0  NVIDIA GeForce ...  Off  | 00000000:01:00.0 Off |                  N/A |
| 33%   40C    P8    10W / 180W |      0MiB /  8117MiB |      0%      Default |
|                               |                      |                  N/A |
+-------------------------------+----------------------+----------------------+
+-----------------------------------------------------------------------------+
| Processes:                                                                  |
|  GPU   GI   CI        PID   Type   Process name                  GPU Memory |
|        ID   ID                                                   Usage      |
|=============================================================================|
|  No running processes found                                                 |
+-----------------------------------------------------------------------------+
```