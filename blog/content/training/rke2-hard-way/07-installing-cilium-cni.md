---
title: "RKE2 the Hard Way: Part 7 - Installing the Cilium CNI"
description: "Installing and configuring the Cilium CNI for Kubernetes networking."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 7
---

## Part 7 - Installing the Cilium CNI

In this part of the "RKE2 the Hard Way" training series, we will install and configure the Cilium CNI (Container Network Interface). Cilium is a powerful, open-source CNI solution that provides advanced networking, security, and observability features for Kubernetes. It leverages eBPF for high-performance packet processing and policy enforcement.

We will install Cilium on our Kubernetes cluster to provide networking and network policy enforcement.

### 1. Install Cilium CLI

On your workstation (your local machine), download and install the Cilium CLI (`cilium`). Follow the instructions on the [Cilium documentation](https://docs.cilium.io/en/stable/cli/install/).

For example, on macOS using Homebrew:

```bash
brew install cilium-cli
```

On Linux, you can download the binary from the Cilium GitHub releases page or use `apt` or `yum` repositories.

### 2. Install Cilium CNI

We will use the Cilium CLI to install Cilium on our Kubernetes cluster.  We need to configure `kubectl` to point to our newly built cluster.

**To configure `kubectl`, you would typically copy the admin kubeconfig file to your workstation and set the `KUBECONFIG` environment variable. However, since our cluster is not yet fully functional and we haven't created a kubeconfig file, we will skip this step for now and revisit it later when the API server is fully accessible.**

For now, we will assume you have `kubectl` configured to communicate with your API server (you may need to manually configure `kubectl` to point to one of your API server nodes using the admin certificate from Part 2).

Run the following command from your workstation to install Cilium:

```bash
cilium install
```

This command will:

*   Detect your Kubernetes environment.
*   Deploy the Cilium operator and Cilium agent as DaemonSets and Deployments in the `kube-system` namespace.
*   Configure Cilium with default settings suitable for most environments.

You can customize the Cilium installation using various options with the `cilium install` command. For this guide, we will use the default installation.

### 3. Verify Cilium Installation

After running `cilium install`, verify that Cilium pods are running correctly in the `kube-system` namespace:

```bash
kubectl get pods -n kube-system -l app.kubernetes.io/name=cilium
kubectl get pods -n kube-system -l app.kubernetes.io/name=cilium-operator
```

You should see output similar to this, with Cilium agent pods running on each node and the Cilium operator pod running:

```
NAME                                         READY   STATUS    RESTARTS   AGE
cilium-xxxxx                                 1/1     Running   0          10m
cilium-yyyyy                                 1/1     Running   0          10m
cilium-zzzzz                                 1/1     Running   0          10m
NAME                                             READY   STATUS    RESTARTS   AGE
cilium-operator-xxxxxxxxxxxxx-xxxxx              1/1     Running   0          10m
```

You can also check the Cilium status using the Cilium CLI:

```bash
cilium status
```

This command provides detailed information about the Cilium installation, including the status of components, eBPF features, and datapath mode.

### 4. Verify Network Connectivity (After Cluster is Fully Up)

Full network connectivity verification will be possible after the entire cluster is set up, including kubelet and kube-proxy on worker nodes, and CoreDNS.  We will revisit network testing in a later part of this series.

**Next Steps:**

In the next part, we will install and configure CoreDNS for cluster DNS resolution.
