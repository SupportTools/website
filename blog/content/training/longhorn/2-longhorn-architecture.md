---
title: "Understanding Longhorn Architecture"
date: 2025-01-09T00:00:00-05:00
draft: false
tags: ["Longhorn", "Kubernetes", "Architecture"]
categories:
- Longhorn
- Kubernetes
- Architecture
author: "Matthew Mattox - mmattox@support.tools"
description: "A guide to understanding the architecture of Longhorn, including its components and data flow."
more_link: "yes"
url: "/longhorn-architecture/"
---

In this section of the **Longhorn Basics** course, we will delve into the architecture of Longhorn, exploring its components and understanding the data flow.

<!--more-->

# Longhorn Architecture

## Course Agenda

This section is divided into the following parts:

1. **High-level overview of Longhorn architecture**
2. **Components of Longhorn**
3. **Data flow through Longhorn**

---

## High-level Overview of Longhorn Architecture

Longhorn architecture consists of three main components:

1. **Engine**: Responsible for providing the storage interface to pods.
2. **Replica**: Handles data storage.
3. **Local Disk**: The disk on the node where replicas are stored.

### Architectural Insight

As shown in the diagram (visualize Engine, Replica, and Local Disk interaction), the **Engine** acts as the intermediary between pods and the storage, while **Replicas** ensure data persistence, utilizing the **Local Disk** for physical storage.

---

## Components of Longhorn

Longhorn is composed of several key components, each playing a critical role in its functionality:

### 1. Manager

- Manages the lifecycle of Longhorn components.
- Oversees Longhorn’s configuration.

### 2. Engine

- Provides the storage interface to pods.
- Manages data flow between the pod and replicas.
- Functions like an iSCSI target, running inside a pod with a three-way mirror.

### 3. CSI Driver

- Offers a standard interface for Kubernetes to interact with Longhorn volumes.
- Handles formatting and mounting volumes on nodes where pods are scheduled.
- **Key Point**: Pods only see a block device and remain unaware of Longhorn's underlying operations.

### 4. Longhorn UI

- A web interface for managing Longhorn and its components.
- Acts as a user-friendly front for Longhorn CRDs (Custom Resource Definitions).

---

## Data Flow Through Longhorn

Understanding how data flows through Longhorn is essential for grasping its architecture:

1. **Pod Request**: The pod sends a storage request to the ext4 filesystem mounted on the node.
2. **Filesystem to Block Device**: The ext4 filesystem forwards the request to the iSCSI block device.
3. **Block Device to Engine**: The iSCSI block device delivers the request to the Engine via a cluster IP service pointing to the local pod running the Engine.
4. **Engine to Replicas**:
   - The Engine sends write requests to **all replicas**.
   - Read requests are sent to **one replica**, performing a local copy if available.
5. **Replica Storage**: The Replica writes the data to the **local disk**.

By leveraging this flow, Longhorn ensures high availability and data consistency across its components.

---

With this understanding of Longhorn’s architecture, you are now prepared to explore its installation and management in the next section!
