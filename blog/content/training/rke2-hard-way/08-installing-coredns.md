---
title: "RKE2 the Hard Way: Part 8 - Installing CoreDNS"
description: "Installing and configuring CoreDNS for Kubernetes cluster DNS resolution."
date: 2025-04-01
series: "RKE2 the Hard Way"
series_rank: 8
---

## Part 8 - Installing CoreDNS

In this part of the "RKE2 the Hard Way" training series, we will install and configure CoreDNS for Kubernetes cluster DNS resolution. CoreDNS is a flexible and extensible DNS server that is the recommended DNS provider for Kubernetes clusters.

We will deploy CoreDNS to provide internal DNS resolution for services and pods within our cluster.

### 1. Download CoreDNS Manifest

Download the recommended CoreDNS manifest for Kubernetes from the CoreDNS GitHub repository. We will use version `1.11.1`.

```bash
COREDNS_VERSION=1.11.1
wget https://raw.githubusercontent.com/coredns/coredns/release-${COREDNS_VERSION}/plugin/kubernetes/example/coredns.yaml
mv coredns.yaml coredns-manifest.yaml
```

These commands will:

*   Download the CoreDNS manifest file from GitHub.
*   Rename the manifest file to `coredns-manifest.yaml` for clarity.

### 2. Modify CoreDNS Manifest (Optional)

Review the downloaded `coredns-manifest.yaml` file.  For basic setup, the default manifest should work without modifications.

However, you might want to adjust the following:

*   `namespace`: Ensure it is deployed in the `kube-system` namespace (default).
*   `serviceAccountName`:  Using the `coredns` service account (default).
*   `image`:  Verify the CoreDNS image version if needed. The default image is `coredns/coredns:1.11.1`.
*   `args`:  Review the arguments passed to the CoreDNS container.  The default configuration should be suitable for most setups.

For this guide, we will use the default manifest without modifications.

### 3. Deploy CoreDNS

Use `kubectl` to deploy CoreDNS to the cluster using the downloaded manifest:

```bash
kubectl apply -f coredns-manifest.yaml
```

This command will create the necessary CoreDNS Deployment and Service in the `kube-system` namespace.

### 4. Verify CoreDNS Deployment

Verify that the CoreDNS pods are running correctly in the `kube-system` namespace:

```bash
kubectl get pods -n kube-system -l k8s-app=coredns
```

You should see output similar to this, with two CoreDNS replica pods running:

```
NAME                        READY   STATUS    RESTARTS   AGE
coredns-xxxxxxxxxx-xxxxx    1/1     Running   0          5m
coredns-yyyyyyyyyy-yyyyy    1/1     Running   0          5m
```

Also, verify the CoreDNS service:

```bash
kubectl get service -n kube-system coredns
```

Output should be similar to:

```
NAME       TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)         AGE
coredns    ClusterIP   10.96.0.10   <none>        53/UDP,53/TCP   5m
```

Note the `CLUSTER-IP` for the `coredns` service (e.g., `10.96.0.10`). This is the cluster DNS IP address that we configured in the kubelet configuration in Part 6.

### 5. Test DNS Resolution (After Cluster is More Complete)

Full DNS resolution testing will be more relevant once we have worker nodes fully joined and pods running. We will revisit DNS testing in a later part of this series when we deploy a test application.

**Next Steps:**

In the next part, we will install Ingress-Nginx to enable external access to services in our cluster.
