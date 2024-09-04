---
title: "Kubernetes Cluster Hardening: Set Minimum TLS Version to 1.3 in RKE"  
date: 2024-09-08T19:26:00-05:00  
draft: false  
tags: ["Kubernetes", "RKE", "TLS", "Security", "Cluster Hardening"]  
categories:  
- Kubernetes  
- Security  
- RKE  
author: "Matthew Mattox - mmattox@support.tools."  
description: "Learn how to enhance Kubernetes security by setting the minimum TLS version to 1.3 in an RKE cluster."  
more_link: "yes"  
url: "/kubernetes-cluster-hardening-tls-1-3-rke/"  
---

Securing a Kubernetes cluster is critical for production environments, and one important step is ensuring that only modern, secure versions of TLS are supported. In this guide, we will show how to configure a Kubernetes cluster built with Rancher Kubernetes Engine (RKE) to use TLS 1.3 as the minimum version for secure communication.

<!--more-->

### Why TLS 1.3?

TLS 1.3 provides significant security and performance improvements over earlier versions. It simplifies the handshake process and eliminates outdated cryptographic algorithms, offering enhanced privacy and reduced latency. For Kubernetes clusters, enforcing TLS 1.3 helps ensure that communication between the control plane, worker nodes, and external clients is secure.

### Pre-requisites

- A working RKE Kubernetes cluster.
- Access to modify the `cluster.yml` configuration file used by RKE.
- Basic knowledge of Kubernetes and RKE.

### Step 1: Locate the `cluster.yml` File

In an RKE environment, the `cluster.yml` file contains the configuration for your cluster. This file is typically located in the directory from which RKE was initially run. If you don't have it locally, you can retrieve it from your source control or the Rancher server.

```bash
ls
cluster.yml
```

### Step 2: Modify the API Server TLS Configuration

To enforce TLS 1.3, you'll need to modify the `kube-apiserver` configuration within the `cluster.yml` file.

1. Open the `cluster.yml` file in your preferred text editor:

    ```bash
    nano cluster.yml
    ```

2. Find the `services` section, and locate the `kube-api` subsection. If it doesn't exist, add it under `services`.

3. Modify or add the `extra_args` section to include the minimum TLS version as follows:

    ```yaml
    services:
      kube-api:
        extra_args:
          tls-min-version: "VersionTLS13"
    ```

This configuration forces the Kubernetes API server to only allow TLS 1.3 and higher versions for secure connections.

### Step 3: Modify the Kubelet TLS Configuration

Next, modify the `kubelet` service to ensure it also uses TLS 1.3 for communication with the API server and other components.

In the same `cluster.yml` file, locate the `kubelet` section under `services` and add the following:

```yaml
      kubelet:
        extra_args:
          tls-min-version: "VersionTLS13"
```

This ensures that both the API server and the kubelet service enforce the minimum TLS version.

### Step 4: Apply the Changes

Once the changes to the `cluster.yml` file are complete, you need to apply them to the cluster.

1. Save the `cluster.yml` file.

2. Run the following RKE command to apply the new configuration:

    ```bash
    rke up
    ```

This command will update your Kubernetes cluster with the new configuration. The process may take a few minutes depending on your environment size.

### Step 5: Verify the TLS Configuration

Once the update is complete, verify that the API server and kubelet are using TLS 1.3.

You can check the logs of the `kube-apiserver` and `kubelet` for the new TLS configuration:

```bash
kubectl logs -n kube-system <kube-apiserver-pod> | grep 'TLS'
```

Look for the confirmation that TLS 1.3 is being used in the output.

### Final Thoughts

Setting the minimum TLS version to 1.3 in your RKE-based Kubernetes cluster strengthens its security by enforcing modern cryptographic standards. This is a key step in hardening your cluster for production environments, ensuring secure communication between Kubernetes components and external clients.
