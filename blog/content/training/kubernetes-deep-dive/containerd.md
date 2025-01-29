---
title: "Understanding Containerd in Kubernetes"
date: 2025-01-29T00:00:00-00:00
draft: false
tags: ["kubernetes", "containerd", "container runtime", "cri"]
categories: ["Kubernetes Deep Dive"]
author: "Matthew Mattox"
description: "A deep dive into Containerd, Kubernetes' default container runtime, and how it interacts with the Kubernetes control plane."
url: "/training/kubernetes-deep-dive/containerd/"
---

## Introduction

Containerd is a **lightweight, OCI-compliant container runtime** that provides the fundamental building blocks for running containers. Originally part of Docker, it is now a separate project under the Cloud Native Computing Foundation (CNCF) and serves as the **default container runtime** in Kubernetes since version 1.20.

In this post, we’ll explore what Containerd is, how it integrates with Kubernetes, and how to troubleshoot and optimize its usage in Kubernetes clusters.

---

## What is Containerd?

Containerd is a **container runtime** responsible for managing the entire lifecycle of containers, including:

- **Pulling images** from container registries.
- **Storing and managing container images** locally.
- **Creating and running containers**.
- **Managing networking** via CNI plugins.
- **Handling container execution and monitoring**.

Unlike Docker, which includes additional tooling like CLI commands and build capabilities, Containerd is **strictly focused on running containers efficiently**.

---

## How Kubernetes Uses Containerd

Kubernetes interacts with Containerd using the **Container Runtime Interface (CRI)**. The flow works as follows:

1. **Kubelet** communicates with the container runtime using the CRI.
2. **Containerd receives CRI requests** and manages container lifecycle events.
3. **Containerd spawns containers using the runc component** (or another low-level runtime like Kata Containers).
4. **Container networking** is handled via a CNI plugin (e.g., Flannel, Calico, or Cilium).
5. **Storage is managed** through CSI (Container Storage Interface).

### Checking Runtime on a Kubernetes Node

To check whether Containerd is being used as the container runtime, run:

```bash
kubectl get nodes -o wide
```

To verify the runtime:

```bash
crictl info | jq '.config.runtime'
```

To list running containers:

```bash
crictl ps
```

---

## Containerd vs. Docker: What’s the Difference?

| Feature         | Containerd | Docker |
|----------------|------------|------------|
| **Purpose** | Lightweight container runtime | Full-fledged container management platform |
| **Kubernetes Integration** | Directly via CRI | Requires `dockershim` (deprecated) |
| **Image Management** | Yes | Yes |
| **Networking** | Uses CNI plugins | Uses built-in networking stack |
| **CLI Available** | No (uses `crictl`) | Yes (Docker CLI) |
| **Build Support** | No | Yes |

Since Kubernetes **deprecated Docker support in v1.20** and removed it in **v1.24**, Containerd is now the recommended and default container runtime.

---

## Managing Containerd

### Restarting Containerd
If Containerd is unresponsive or causing issues, restart it with:

```bash
systemctl restart containerd
```

Or check its status:

```bash
systemctl status containerd
```

### Viewing Container Logs

To debug issues with a specific container:

```bash
crictl logs <container_id>
```

To view system-wide logs:

```bash
journalctl -u containerd --no-pager -n 100
```

### Pulling Images with Containerd

Since Containerd does not have a CLI like Docker, you need to use `crictl`:

```bash
crictl pull nginx:latest
```

To list available images:

```bash
crictl images
```

To remove an image:

```bash
crictl rmi <image_id>
```

---

## Optimizing Containerd Performance

1. **Enable Image Caching**
   - Pre-pull images on nodes to reduce startup time.

2. **Adjust Containerd’s Runtime Configuration**
   - Modify `/etc/containerd/config.toml` for advanced tuning (e.g., increasing concurrent downloads).

3. **Monitor with Prometheus**
   - Expose metrics from Containerd and integrate with Prometheus & Grafana.

4. **Use Efficient Storage Drivers**
   - Choose the best storage backend (e.g., OverlayFS for performance).

5. **Limit Logging Overhead**
   - Configure log rotation to avoid excessive disk usage.

---

## Troubleshooting Containerd Issues

### Common Issues & Fixes

| Issue | Possible Cause | Solution |
|--------|---------------|----------|
| **Containers Stuck in `ContainerCreating`** | Image pull failure or CNI issue | Check `crictl ps` and network plugin logs |
| **High CPU Usage by Containerd** | Too many concurrent container operations | Restart Containerd and optimize its config |
| **Pod Fails to Start** | Image not found | Use `crictl pull <image>` to manually pull it |
| **Container Logs Not Available** | Logging driver misconfiguration | Check logs using `crictl logs <container_id>` |

---

## Conclusion

Containerd is the **default and recommended container runtime** for Kubernetes, providing a lightweight, efficient, and modular approach to container execution. Understanding how it integrates with Kubernetes, along with common troubleshooting and optimization techniques, ensures a **stable and high-performance Kubernetes environment**.

For more Kubernetes deep dives, visit [support.tools](https://support.tools)!
