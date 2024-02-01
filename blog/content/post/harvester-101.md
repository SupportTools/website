---
title: "Deep Dive into Rancher Harvester: The Future of Hyperconverged Infrastructure"
date: 2024-02-01T10:00:00-05:00
draft: false
tags: ["Rancher", "Harvester", "Kubernetes", "Virtualization", "HCI"]
categories:
- Rancher
- Kubernetes
- Virtualization
- Hyperconverged Infrastructure
author: "Matthew Mattox - mmattox@support.tools
description: "An in-depth exploration of Rancher Harvester and its role in revolutionizing virtualization in Kubernetes environments."
more_link: "yes"
---

After transitioning my homelab from Proxmox to Harvester-v1.1.2, I've gained a unique perspective on Rancher Harvester's role in modern virtualization. This post delves deeper into Harvester, answering key questions and sharing my hands-on experience.

<!--more-->
## [Understanding Rancher Harvester](#understanding-rancher-harvester)

Rancher Harvester is not just a virtualization tool; it's a complete hyperconverged infrastructure (HCI) solution built on Kubernetes, designed to modernize and consolidate VM workloads alongside Kubernetes clusters. It represents the next step in the evolution of virtualization, blurring the lines between VMs and containerized applications.

## [Components of Harvester](#components-of-harvester)

Harvester marries several cutting-edge technologies:

- **RKE2**: Provides the Kubernetes cluster.
- **Rancher**: Manages high-level cluster operations.
- **Longhorn**: Acts as the storage backbone.
- **KubeVirt**: Enables running VMs on Kubernetes.
- **Linux Elements**: Provide the underlying stability and robustness.
- **Multis**: Provides the networking backbone.
- **KubeVIP**: Provides the load balancing backbone.

This synergy creates a seamless virtualization platform, streamlining the process of running VMs on Kubernetes.

### [RKE2](#rke2)

At the heart of Harvester is RKE2, a lightweight Kubernetes distribution that's easy to deploy and manage. This was a strategic choice, as RKE2 is designed with the enterprise in mind, offering a stable and secure foundation for Harvester.

### [Rancher](#rancher)

Rancher is the control plane for Harvester, providing a centralized interface for managing clusters and VMs. It's also the component that makes Harvester so easy to use, abstracting away the complexities of Kubernetes and enabling users to focus on their workloads.

### [Longhorn](#longhorn)

Longhorn is the storage solution for Harvester, providing a distributed block storage system for VMs. It's a perfect fit for Harvester, as it's built on Kubernetes and designed to be lightweight and easy to use.

NOTE: This is a key differentiator from Proxmox or VMware, which is designed to use a SAN or NAS for storage. Longhorn is a software-defined storage solution, eliminating the need for additional hardware. As of writing, Harvester really only supports Longhorn as a storage solution. You can find out more by reading the feature request [here](https://github.com/harvester/harvester/issues/1199). Tho there is nothing stopping a third-party storage provider as it's just Kubernetes.

You can find some excellent examples [here](https://harvesterhci.io/kb/use_rook_ceph_external_storage/).

### [KubeVirt](#kubevirt)

KubeVirt is the component that enables running VMs on Kubernetes. It's a perfect fit for Harvester, as it's built on Kubernetes and designed to be lightweight and easy to use. It basically allows you to run VMs as pods in Kubernetes.

### [Linux Elements](#linux-elements)

Linux Elements covers the underlying runs on OpenSUSE-based OS called SLE Micro. It's a lightweight OS designed for running containers and VMs, making it a perfect fit for Harvester. It covers the same idea as RancherOS, which is a lightweight OS designed for running containers and that's it. Also, it's paired with Elemental which handles managing the OS configuration and updates.

### [Multis](#multis)

Multis is the networking component of Harvester, providing a software-defined network for VMs. It's a perfect fit for Harvester, because it allows you to create mutiple network overlays for your VMs. For example, you might have a network for dev VMs and another for production VMs. This allows you to isolate the traffic for each network. And because it's fully VLAN aware, you can even extend your existing VLANs into Harvester.

### [KubeVIP](#kubevip)

KubeVIP is the load balancing component of Harvester, providing a software-defined load balancer for VMs. It's a perfect fit for Harvester, because it allows you to create load balancers for your nested clusters without needing to intergrate with an external load balancer IE F5 or HAProxy or MetalLB and get BGP working correctly.

## [Harvester's Workflow Explained](#harvesters-workflow-explained)

The workflow in Harvester is surprisingly intuitive:

- A Rancher frontend VM on Harvester requests a Kubernetes cluster.
- Harvester spins up VMs as Kubernetes nodes, automating what was once a manual process.

This setup not only simplifies cluster creation but also incorporates a Rancher cluster running on Harvester, itself running on Rancher - a unique and efficient nesting of technologies.

It is important to understand that Harvester VMs are type 1 VMs, meaning they have their own kernel, network stack, and storage. This means you can run any OS you want on them, including Windows.

## [Nested Kubernetes Clusters](#nested-kubernetes-clusters)

Harvester's nested Kubernetes clusters are a game-changer. Because you get the best of both worlds, you can run VMs and containers side-by-side, all managed togther. This is a huge advantage over Proxmox or VMware, which require separate management interfaces for VMs and containers each not knowing what the other is doing. Harvester bridges this gap because Rancher is managing both the phyiscal, virtual, and kubernetes infrastructure.

Now one question that comes up is why would you want to run a nested Kubernetes cluster? Well, there are a few reasons:

- Managing an OS on bare metal is hard, drivers, updates, etc. For example, if you need to patch the OS you need to drain the node, reboot, and then bring it back up. With a nested cluster, you can just mirgrate the workloads to another node, patch, and then migrate back.
- You can run a different version of Kubernetes on the nested cluster. For example, you can run a 1.27 cluster on one of the nested clusters and 1.26 on the other. This allows you to test upgrades before you do them on your production cluster.
- Isolation. You can run a nested cluster for your dev team and another for your production team. This allows you to isolate the workloads and resources for each team without needing to buy more hardware.

## [Hyperconverged Infrastructure Simplified](#hyperconverged-infrastructure-simplified)

Hyperconverged Infrastructure (HCI) integrates compute, virtualization, storage, and networking into a single cluster. Harvester embodies this definition by combining these elements under the centralized control of Kubernetes' etcd, using manifest files for infrastructure setup.

## [Why Choose Harvester?](#why-choose-harvester)

The choice of Harvester is more than a technical decision; it's a strategic one. It aligns with the expertise of those familiar with Kubernetes, offering a future-proof solution in the burgeoning field of HCI. It's not just about understanding the technology, but about mastering a system that's poised to become a staple in IT job descriptions.

## [Conclusion](#conclusion)

Through my journey from VMware ESXi to Harvester, I've come to appreciate Harvester as more than just an HCI solution. It's a forward-thinking approach to virtualization, perfectly suited for Kubernetes enthusiasts and those looking to stay ahead in the ever-evolving world of IT infrastructure.

Stay tuned for further insights and tutorials on maximizing the potential of Rancher Harvester in your environments.

---
