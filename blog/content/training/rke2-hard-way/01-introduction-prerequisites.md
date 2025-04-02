---
title: "RKE2 the Hard Way: Part 1 – Introduction and Prerequisites for Building a Kubernetes Cluster"
description: "Introduction to the RKE2 the Hard Way training series and setting up the prerequisites."
date: 2025-04-01T00:00:00-00:00
series: "RKE2 the Hard Way"
series_rank: 1
draft: false
tags: ["kubernetes", "rke2", "bare-metal", "certificates", "linux"]
categories: ["Training", "RKE2"]
author: "Matthew Mattox"
description: "Before we build a highly available Kubernetes cluster from scratch, let's review the required tools and node setup."
more_link: ""
---

## Introduction

Welcome to the **"RKE2 the Hard Way"** training series! In this series, we’ll embark on a journey to build a Kubernetes cluster from scratch—mimicking the robust features of Rancher Kubernetes Engine 2 (RKE2)—without relying on any distribution-specific tools or installers.

It's called the *"hard way"* because we'll manually configure and set up each component of the Kubernetes cluster. This approach is designed to provide a deep understanding of how Kubernetes works under the hood and to highlight the automation and simplification RKE2 provides.

By the end of this series, you'll have a functional Kubernetes cluster with the following features:

* A three-node etcd cluster for high availability.
* All nodes acting as both control plane and worker nodes.
* Ingress-Nginx for external access to applications.
* CoreDNS for cluster DNS resolution.
* Cilium CNI for networking and network policy.

This series is inspired by [Kelsey Hightower’s "Kubernetes the Hard Way"](https://github.com/kelseyhightower/kubernetes-the-hard-way), but adapted to build a cluster with features similar to RKE2. Our goal is to give you a comprehensive understanding of Kubernetes components, their interactions, and how to manually configure them, all while appreciating the work RKE2 does on our behalf.

## Prerequisites

Before we begin, ensure you have the following in place:

### 1. Nodes

You'll need at least **three nodes** (virtual machines or physical servers). These nodes should meet the following requirements:

- **Operating System:** Ubuntu 24.04 or SUSE Linux Enterprise Server 15 SP5.
- **Architecture:** x86_64 (amd64).
- **Container Runtime**: containerd
- **CPU:** 2+ cores
- **Memory:** 4GB+ RAM
- **Disk:** 20GB+ storage
- **Network:** Connectivity between all nodes.
- **Hostname:** Each node should have a unique hostname.
- **Time Synchronization:** Ensure time sync is configured (`ntpd` or `systemd-timesyncd`).
- **Swap Disabled:** Swap should be disabled on all nodes (Kubernetes requires this for optimal performance and scheduling).

> ⚙️ **For the purposes of this training series, we will assume the nodes are named `node01`, `node02`, and `node03`.** Adjust accordingly if your nodes have different hostnames.

### 2. Workstation Tools

Your local machine (workstation) should have the following tools installed:

- `kubectl`: Kubernetes command-line tool.
- `curl`: For making HTTP requests.
- `openssl`: For certificate generation and inspection.
- `cfssl` and `cfssljson`: Cloudflare’s TLS toolkit for certificate management.
    Download from [https://github.com/cloudflare/cfssl](https://github.com/cloudflare/cfssl).
- `helm`: For installing Cilium CNI (optional, but recommended) - [https://helm.sh/docs/intro/install/](https://helm.sh/docs/intro/install/)

### 3. Internet Access

Nodes will need access to the internet to download binaries and container images.

### 4. Container Runtime

For this guide, we will use **containerd** as the container runtime. Ensure containerd is installed and configured on all nodes.  Refer to the containerd documentation for installation instructions: [https://containerd.io/docs/getting-started/](https://containerd.io/docs/getting-started/)

### 5. Administrative Privileges

Ensure you have `sudo` privileges on all nodes.

---

## Next Steps

Next, we will move to **Part 2** and set up the **Certificate Authority** and generate the **TLS certificates** for our Kubernetes cluster!

👉 Stay tuned for **Part 2: Setting up containerd and kubelet!**
