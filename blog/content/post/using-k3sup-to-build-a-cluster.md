---
title: "Using k3sups to build a cluster"
date: 2022-07-14T22:57:00-05:00
draft: false
tags: ["k3s", "kubernetes", "k3sup"]
categories:
- k3s
- Kubernetes
- k3sup
author: "Matthew Mattox - mmattox@support.tools"
description: "Using k3sups to build a cluster"
more_link: "yes"
---

![](https://cdn.support.tools/posts/using-k3sup-to-build-a-cluster/k3sup.png)

For engineers, Kubernetes Installation can be a challenge since there is a huge selection of Kubernetes distributions and tools to set them up, making choosing the best one for your use case difficult. Getting started with a Kubernetes cluster requires different configuration challenges and utilities. We will discuss K3s, a very powerful lightweight Kubernetes distribution that you can install in a matter of minutes.

The K3s binary is designed to be a single binary of less than 40 MB that implements the Kubernetes API. It's like software without excess drivers.

K3s offer the following features:

- It can be run over a starting RAM of 512MB .
- For edge devices, K3s is a highly available, certified Kubernetes distribution.
- Even a Raspberry Pi can be used with great success.
- Instead of etcd, SQLite is used as the storage backend, and Containerd is used as the default container runtime (not Docker).
- With utilities like k3sup and k3d, you can easily install K3S. This post will show you how to install k3s using k3sup (ketchup), which is a lightweight utility to quickly and easily set up Kubeconfig with k3s on the local or remote machine.

<!--more-->
# [Prerequisite](#prerequisite)
- You need to have a Linux machine (VM or physical) with a minimum of 512MB of RAM.
- A supported Linux distribution (Ubuntu, CentOS, or RHEL). We'll be using Ubuntu 22.04 LTS.
- Sudo or root access.
- A working internet connection.

# [Installation](#installation)
Download the k3sup using the GitHub repo of Alex Ellis [https://github.com/alexellis/k3sup](https://github.com/alexellis/k3sup).

Command to install k3sup:
```bash
curl -sLS https://get.k3sup.dev | sh
```

Output:
```bash
root@demo:~# curl -sLS https://get.k3sup.dev | sh
x86_64
Downloading package https://github.com/alexellis/k3sup/releases/download/0.12.0/k3sup as /tmp/k3sup
Download complete.

Running with sufficient permissions to attempt to move k3sup to /usr/local/bin
New version of k3sup installed to /usr/local/bin
 _    _____                 
| | _|___ / ___ _   _ _ __  
| |/ / |_ \/ __| | | | '_ \ 
|   < ___) \__ \ |_| | |_) |
|_|\_\____/|___/\__,_| .__/ 
                     |_|    
Version: 0.12.0
Git Commit: c59d67b63ec76d5d5e399808cf4b11a1e02ddbc8

Give your support to k3sup via GitHub Sponsors:

https://github.com/sponsors/alexellis

================================================================
  Thanks for choosing k3sup.
  Support the project through GitHub Sponsors

  https://github.com/sponsors/alexellis
================================================================

root@demo:~# 
```

Now we can use k3sup to install k3s. In this example, we will use the k3sup utility to install k3s on a local machine.

Command:
```bash
k3sup install --local
```

Output:
```bash
root@demo:~# k3sup install --local
Running: k3sup install
2022/07/14 22:19:42 127.0.0.1
Executing: curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC='server --tls-san 127.0.0.1' INSTALL_K3S_CHANNEL='stable' sh -

[INFO]  Finding release for channel stable
[INFO]  Using v1.23.8+k3s2 as release
[INFO]  Downloading hash https://github.com/k3s-io/k3s/releases/download/v1.23.8+k3s2/sha256sum-amd64.txt
[INFO]  Downloading binary https://github.com/k3s-io/k3s/releases/download/v1.23.8+k3s2/k3s
[INFO]  Verifying binary download
[INFO]  Installing k3s to /usr/local/bin/k3s
[INFO]  Skipping installation of SELinux RPM
[INFO]  Creating /usr/local/bin/kubectl symlink to k3s
[INFO]  Creating /usr/local/bin/crictl symlink to k3s
[INFO]  Creating /usr/local/bin/ctr symlink to k3s
[INFO]  Creating killall script /usr/local/bin/k3s-killall.sh
[INFO]  Creating uninstall script /usr/local/bin/k3s-uninstall.sh
[INFO]  env: Creating environment file /etc/systemd/system/k3s.service.env
[INFO]  systemd: Creating service file /etc/systemd/system/k3s.service
[INFO]  systemd: Enabling k3s unit
Created symlink /etc/systemd/system/multi-user.target.wants/k3s.service → /etc/systemd/system/k3s.service.
[INFO]  systemd: Starting k3s
stderr: "Created symlink /etc/systemd/system/multi-user.target.wants/k3s.service → /etc/systemd/system/k3s.service.\n"stdout: "[INFO]  Finding release for channel stable\n[INFO]  Using v1.23.8+k3s2 as release\n[INFO]  Downloading hash https://github.com/k3s-io/k3s/releases/download/v1.23.8+k3s2/sha256sum-amd64.txt\n[INFO]  Downloading binary https://github.com/k3s-io/k3s/releases/download/v1.23.8+k3s2/k3s\n[INFO]  Verifying binary download\n[INFO]  Installing k3s to /usr/local/bin/k3s\n[INFO]  Skipping installation of SELinux RPM\n[INFO]  Creating /usr/local/bin/kubectl symlink to k3s\n[INFO]  Creating /usr/local/bin/crictl symlink to k3s\n[INFO]  Creating /usr/local/bin/ctr symlink to k3s\n[INFO]  Creating killall script /usr/local/bin/k3s-killall.sh\n[INFO]  Creating uninstall script /usr/local/bin/k3s-uninstall.sh\n[INFO]  env: Creating environment file /etc/systemd/system/k3s.service.env\n[INFO]  systemd: Creating service file /etc/systemd/system/k3s.service\n[INFO]  systemd: Enabling k3s unit\n[INFO]  systemd: Starting k3s\n"Saving file to: /root/kubeconfig

# Test your cluster with:
export KUBECONFIG=/root/kubeconfig
kubectl config set-context default
kubectl get node -o wide
root@demo:~# 
```

At this point, we have a k3s cluster running on our local machine. And we can verify that it is running by using the kubectl commands listed below.

```bash
export KUBECONFIG=/root/kubeconfig
kubectl config set-context default
kubectl get node -o wide
```

Output:
```bash
root@demo:~# kubectl get node -o wide
NAME   STATUS   ROLES                  AGE   VERSION        INTERNAL-IP    EXTERNAL-IP   OS-IMAGE           KERNEL-VERSION      CONTAINER-RUNTIME
demo   Ready    control-plane,master   56s   v1.23.8+k3s2   172.27.7.100   <none>        Ubuntu 22.04 LTS   5.15.0-27-generic   containerd://1.5.13-k3s1
root@demo:~# 
```