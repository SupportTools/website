---
title: "Benchmarking Kubernetes CNI Plugins on 40Gbit/s Networks"
date: 2024-10-30T10:00:00-05:00
draft: false
tags: ["Kubernetes", "CNI", "Networking", "Performance"]
categories:
- Kubernetes
- Networking
author: "Matthew Mattox - mmattox@support.tools"
description: "Explore the latest benchmarks of Kubernetes Container Network Interfaces (CNI) running over 40Gbit/s networks, comparing performance and insights for optimal cluster networking."
more_link: "yes"
url: "/benchmark-kubernetes-cni-40Gbit/"
---

## Introduction  

Understanding network performance within a **Kubernetes cluster** is critical for scaling applications efficiently. With a growing array of **Container Network Interface (CNI)** plugins available, finding the right one for your workloads can be challenging. This post covers the **latest benchmark** results of CNI plugins, leveraging **Kubernetes 1.26** with **RKE2** on Ubuntu 22.04, and tests conducted over **40Gbit/s networks**.

---

## Why Benchmark Kubernetes CNIs?  

The networking layer is integral to any Kubernetes cluster, as it manages **pod-to-pod communication** and ensures traffic flows seamlessly between services. Selecting a **CNI plugin** impacts cluster performance, resource consumption, and even energy efficiency. This benchmark provides insights into how different **CNI configurations** perform in **real-world scenarios**, including encryption with **WireGuard**, advanced routing with **eBPF**, and more.

---

## Setup and Testing Methodology  

To ensure accurate results, we used **three bare-metal Supermicro servers** connected via a **40Gbit switch**. Each test ran three times with fresh server installations. The **benchmark architecture** followed this structure:

- **a1**: Kubernetes control plane  
- **a2**: Benchmark server  
- **a3**: Benchmark client  

The **network settings** included jumbo frames (MTU 9000) to maximize throughput, with **WireGuard** installed for encrypted connections. The cluster was built using **RKE2** and configured with 21 different CNI variants across **Antrea**, **Calico**, **Cilium**, **Kube-OVN**, and more.

---

## Key Findings  

### eBPF Delivers Performance Gains  

- **eBPF-based plugins** like Calico and Cilium showed a slight performance boost in **multi-stream TCP tests**. eBPF eliminates the need for kube-proxy, resulting in lower CPU usage and faster networking.

### Encryption Overhead Varies  

- **WireGuard** proved more efficient than **IPsec** in most scenarios. However, **key rotation limitations** make IPsec more suitable for users requiring frequent key changes.

### Resource Efficiency  

- **Kube-router** emerged as the most lightweight CNI, consuming minimal resources while offering excellent performance. This makes it a great choice for **edge environments**.

### Challenges with UDP Performance  

- UDP-based tests highlighted **significant drop rates** under heavy traffic, raising concerns about the adoption of **HTTP/3** in production clusters.

---

## Test Results  

1. **TCP Performance**  
   - Direct Pod-to-Pod TCP bandwidth with multiple streams peaked at **~40Gbit/s** using **Calico** and **Cilium**.  
   - Single-stream TCP tests showed some variability, largely due to CPU scheduling across NUMA nodes.

2. **UDP Performance**  
   - **UDP tests** exhibited lower reliability and bandwidth, with **Kube-router** and **Antrea** performing unexpectedly well, surpassing some bare-metal setups.

3. **CPU and Memory Usage**  
   - CNIs with **encryption** consumed less CPU due to lower data throughput, but memory usage remained consistent across all tests, unaffected by network load.

---

## Recommendations  

### For Lightweight Clusters  
- **Kube-router**: Ideal for **edge deployments** with low resource availability, offering simplicity and reliable performance.

### For Standard Deployments  
- **Cilium**: The top recommendation for production clusters, with **eBPF optimizations** and rich observability tools like Hubble.

### For High-Performance Environments  
- **Calico VPP**: While setup can be complex, it offers unparalleled performance when properly fine-tuned.

---

## Conclusion  

Choosing the right **CNI plugin** depends on your workload requirements. **eBPF optimizations** are becoming the norm, but plugins like **Kube-router** provide excellent alternatives for lightweight clusters. This benchmark not only demonstrates how CNIs perform under **40Gbit/s conditions** but also offers insights into **resource efficiency** for sustainable computing.

For more detailed graphs and raw data, visit the full **benchmark repository**:  
[Benchmark Data Repository](https://github.com/InfraBuilder/benchmark-k8s-cni-2024-01).