---
title: "K3s Basics"
date: 2025-01-01T00:00:00-05:00
draft: true
tags: ["K3s", "Kubernetes", "Training"]
categories:
- K3s
- Training
author: "Matthew Mattox - mmattox@support.tools"
description: "Understanding the basics of K3s: a lightweight Kubernetes distribution"
more_link: "yes"
url: "/training/k3s/basics/"
---

K3s is a lightweight Kubernetes distribution built for IoT and Edge computing. This guide covers the fundamental concepts of K3s and how it differs from standard Kubernetes distributions.

<!--more-->

# [What is K3s?](#what-is-k3s)

K3s is a highly available, certified Kubernetes distribution designed to run production workloads in unattended, resource-constrained, remote locations or inside IoT appliances. It's packaged as a single binary of less than 100MB and has minimal to no operating system dependencies.

# [Key Components](#key-components)

## Core Components
- **kube-apiserver**: API server for managing the cluster
- **etcd/sqlite**: Data store for cluster state (configurable)
- **scheduler**: Assigns pods to nodes
- **controller-manager**: Manages various controllers
- **kubelet**: Manages containers on each node
- **containerd**: Container runtime

## K3s-Specific Components
- **Built-in Load Balancer**: For HA control plane access
- **Local Storage Provider**: Simple local path provisioner
- **Service Load Balancer**: Klipper load balancer for services
- **Network Policy Controller**: Built-in network policy enforcement
- **Helm Controller**: Native Helm chart management

# [Architecture Overview](#architecture-overview)

## Single-Server Setup
![K3s Single Server Architecture](/training/k3s/k3s-architecture-single-server.svg)

In a single-server setup:
- One node runs both control plane and worker components
- Uses SQLite as the default datastore
- Suitable for development and small deployments

## High-Availability Setup
![K3s HA Architecture](/training/k3s/k3s-architecture-ha-embedded.svg)

In an HA setup:
- Multiple server nodes run the control plane
- External datastore (etcd or other)
- Built-in load balancer for API access
- Increased fault tolerance

# [Installation Methods](#installation-methods)

## Quick Start
```bash
# Server installation
curl -sfL https://get.k3s.io | sh -

# Get kubeconfig
sudo cat /etc/rancher/k3s/k3s.yaml

# Add worker node
curl -sfL https://get.k3s.io | K3S_URL=https://myserver:6443 K3S_TOKEN=mynodetoken sh -
```

## Configuration Options
- **K3S_TOKEN**: Node registration token
- **K3S_URL**: URL of the API server
- **INSTALL_K3S_EXEC**: Additional arguments for k3s
- **K3S_DATASTORE_ENDPOINT**: External datastore configuration

# [Key Features](#key-features)

## Simplified Operations
- Single binary installation
- Automatic manifest and helm chart deployment
- Built-in service load balancer
- Automated certificate management

## Resource Efficiency
- Reduced memory footprint (~512MB)
- Optimized for ARM and x86_64
- Minimal external dependencies
- Streamlined kubernetes components

## Enhanced Security
- Removed legacy/alpha features
- Simplified SSL/TLS handling
- Secure by default configuration
- Regular security updates

# [Common Use Cases](#use-cases)

1. **Edge Computing**
   - IoT devices
   - Remote locations
   - Resource-constrained environments

2. **Development Environments**
   - Local testing
   - CI/CD pipelines
   - Learning Kubernetes

3. **Small Production Deployments**
   - Branch offices
   - Retail locations
   - Small business applications

# [Best Practices](#best-practices)

## Production Readiness
1. Use HA setup for critical workloads
2. Configure external datastore
3. Implement proper backup strategy
4. Monitor system resources

## Security
1. Use proper network policies
2. Regularly update K3s version
3. Secure node token distribution
4. Implement RBAC policies

## Performance
1. Size nodes appropriately
2. Use appropriate storage solutions
3. Monitor resource usage
4. Implement proper logging

# [Next Steps](#next-steps)

After understanding these basics, you can:
1. Set up your first K3s cluster
2. Explore high-availability configurations
3. Learn about the built-in load balancer
4. Deploy your first application

For more detailed information, visit the [official K3s documentation](https://rancher.com/docs/k3s/latest/en/).
