---
title: "RKE2 the Hard Way: Part 1 - Introduction and Prerequisites"
description: "Introduction to the RKE2 the Hard Way training series and setting up the prerequisites."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 1
---

## Introduction

Welcome to the "RKE2 the Hard Way" training series! In this series, we will embark on a journey to build a Kubernetes cluster from scratch, mimicking the robust features of Rancher Kubernetes Engine 2 (RKE2) but without relying on any distribution-specific tools or installers.

This is the "hard way" because we will manually configure and set up each component of the Kubernetes cluster. This approach is designed to provide you with a deep understanding of how Kubernetes works under the hood and how RKE2 simplifies the process.

By the end of this series, you will have a functional Kubernetes cluster with the following features:

*   Three-node etcd cluster for high availability.
*   All nodes acting as control plane and worker nodes.
*   Ingress-Nginx for external access to applications.
*   CoreDNS for cluster DNS resolution.
*   Cilium CNI for networking and network policy.

This series is inspired by Kelsey Hightower's "Kubernetes the Hard Way," but adapted to build a cluster with features similar to RKE2.

## Prerequisites

Before we begin, ensure you have the following prerequisites in place:

1.  **Nodes:** You will need at least three nodes (virtual machines or physical servers). These nodes should meet the following requirements:
    *   Operating System: Ubuntu 20.04 or CentOS 7/8 recommended.
    *   CPU: 2+ cores
    *   Memory: 4GB+ RAM
    *   Disk: 20GB+ storage
    *   Network: Connectivity between all nodes.
    *   Hostname: Each node should have a unique hostname.
    *   Time Synchronization: Ensure time synchronization is configured (e.g., using `ntpd` or `systemd-timesyncd`).
    *   Swap Disabled: Swap should be disabled on all nodes.

2.  **Workstation Tools:** You will need the following tools installed on your workstation (your local machine):
    *   `kubectl`: Kubernetes command-line tool.
    *   `curl`:  For making HTTP requests.
    *   `openssl`: For certificate generation.
    *   `cfssl` and `cfssljson`: Cloudflare's TLS toolkit for certificate management. You can download these from [https://github.com/cloudflare/cfssl](https://github.com/cloudflare/cfssl).

3.  **Internet Access:**  Nodes will need internet access to download binaries and container images.

4.  **Administrative Privileges:** You will need `sudo` privileges on all nodes.

**Next Steps:**

In the next part of this series, we will start by setting up the Certificate Authority and generating the necessary TLS certificates for our Kubernetes cluster components. Stay tuned!
