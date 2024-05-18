---
title: "Installing k3s on Ubuntu on Raspberry Pi"
date: 2024-05-18T19:26:00-05:00
draft: true
tags: ["Raspberry Pi", "k3s", "Ubuntu"]
categories:
- DevOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools."
description: "Learn how to install k3s on Ubuntu running on Raspberry Pi, including setup for control plane and agents."
more_link: "yes"
url: "/installing-k3s-on-ubuntu-on-raspberry-pi/"
---

Learn how to install k3s on Ubuntu running on Raspberry Pi, including setup for control plane and agents. Follow this guide for a smooth installation process.

<!--more-->

# [Installing k3s on Ubuntu on Raspberry Pi](#installing-k3s-on-ubuntu-on-raspberry-pi)

After reinstalling all of my nodes with Ubuntu, it's time to install k3s. Here's a step-by-step guide to get it running smoothly.

## [Installing Needed Modules](#installing-needed-modules)

Per k3s#4234, k3s requires some extra modules that aren’t installed by default on Ubuntu. Install them with:

```bash
sudo apt install linux-modules-extra-raspi
```

## [Installing k3s Control Plane](#installing-k3s-control-plane)

Follow the instructions from the [Rancher k3s Quick-Start Guide](https://rancher.com/docs/k3s/latest/en/quick-start/).

On the first node, run:

```bash
curl -sfL https://get.k3s.io | sh -
```

Then wait, occasionally running:

```bash
sudo k3s kubectl get nodes
```

to check on progress.

## [Installing k3s Agents](#installing-k3s-agents)

Once the control plane is up, grab the server token:

```bash
sudo cat /var/lib/rancher/k3s/server/node-token
```

On the other nodes, run:

```bash
curl -sfL https://get.k3s.io | K3S_URL=https://rpi401:6443 K3S_TOKEN=<node-token> sh -
```

## [Setting Up KUBECONFIG](#setting-up-kubeconfig)

Back on the primary node:

```bash
mkdir ~/.k3s
sudo cp /etc/rancher/k3s/k3s.yaml ~/.k3s/k3s.yaml
sudo chown $USER.$USER ~/.k3s/k3s.yaml
export KUBECONFIG=$HOME/.k3s/k3s.yaml   # add this to ~/.bashrc
```

## [Enabling Shell Auto-Completion](#enabling-shell-auto-completion)

Follow the instructions from the [Kubernetes documentation](https://kubernetes.io/docs/tasks/tools/included/optional-kubectl-configs-bash-linux/):

```bash
echo 'source <(kubectl completion bash)' >>~/.bashrc
```

## [Checking if it Works](#checking-if-it-works)

Finally, verify the setup by running:

```bash
kubectl get nodes
```

Example output:

```
NAME     STATUS   ROLES                  AGE   VERSION
rpi401   Ready    control-plane,master   80m   v1.21.7+k3s1
rpi405   Ready    <none>                 28s   v1.21.7+k3s1
rpi404   Ready    <none>                 18s   v1.21.7+k3s1
rpi403   Ready    <none>                 18s   v1.21.7+k3s1
rpi402   Ready    <none>                 32s   v1.21.7+k3s1
```

By following these steps, you can successfully install k3s on Ubuntu running on Raspberry Pi, setting up both the control plane and agents effectively.
