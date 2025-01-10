---
title: "Setting Up the Lab Environment for Longhorn Basics"
date: 2025-01-09T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Lab Setup"]
categories:
- Longhorn
- Kubernetes
- Lab Setup
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide to setting up the lab environment for the Longhorn Basics course, including cluster requirements and necessary tools."
more_link: "yes"
url: "/longhorn-lab-setup/"
---

Welcome to the **Longhorn Basics** course! This section provides step-by-step instructions for setting up the lab environment required to follow this course effectively.

<!--more-->

# Lab Environment Setup

## Course Agenda

This section is divided into two main parts:

1. **Cluster Requirements**
2. **Tools, Commands, and Utilities**

---

## Cluster Requirements

### Cluster Specifications

For this course, we assume you already have a Kubernetes cluster up and running. While any certified Kubernetes distribution will work, we recommend using **k3s** or **RKE2** for this course.

### Setting Up a Cluster

If you don’t have a cluster, use the following guides to set one up:

- **[RKE2 Setup Guide](https://www.rancher.academy/courses/take/rke2-basics/)**
- **[k3s Setup Guide](https://www.rancher.academy/courses/take/k3s-basics/)**

### RKE2 Cluster Details

For this course, we will use an **RKE2 cluster** with the following configuration:

- **Three nodes**: Each node will serve all roles (control plane, etcd, and worker).
- **Minimum hardware requirements per node**:
  - 2 vCPUs
  - 4GB RAM
  - 20GB of free disk space
- **Operating System**: All nodes will run **openSUSE Leap 15.2**, but you can use any Linux distribution of your choice.

### Important Notes

- You must have **root access** to all nodes.
- Ensure all nodes are accessible via **SSH**.

---

## Tools, Commands, and Utilities

### Required Tools

The following tools and utilities will be used extensively throughout this course:

1. **kubectl**: The command-line tool for interacting with Kubernetes clusters.
   - **Download Link**: [Install kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl/)

2. **Helm**: The package manager for Kubernetes, used to install Longhorn.
   - **Download Link**: [Install Helm](https://helm.sh/docs/intro/install/)

3. **SSH**: For accessing and managing nodes in the cluster.

### Running Commands

You can execute the commands from any Linux, macOS, or Windows machine. For consistency, all commands in this course will be run from the **first node** in the cluster using SSH.

---

With the lab environment set up, you're ready to dive into the **Longhorn Basics** course! In the next section, we will explore the architecture and components of Longhorn.
