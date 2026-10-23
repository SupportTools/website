---
title: "Rancher on Small RKE2 Cluster"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Upstream Rancher Cluster", "RKE2", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Upstream Rancher Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy Rancher on a highly available three-node RKE2 cluster on your own servers, with Traefik ingress, cert-manager, and a supported OS."
more_link: "yes"
url: "/known-good-designs/upstream-rancher-cluster/rancher-rke2-small/"
---

This guide deploys Rancher on a small, highly available RKE2 cluster built from three servers that you provision yourself (bare metal or VMs). It follows the layout Rancher supports for the management (local) cluster.

<!--more-->

## [Overview](#overview)

### [Small RKE2 Cluster for Rancher](#small-rke2-cluster-for-rancher)

The design is **three RKE2 server nodes, each running etcd, the control plane, and workloads**. A fixed registration address (a layer 4 load balancer or DNS name) sits in front of the three nodes. Rancher is installed with Helm and exposed through the ingress controller that RKE2 ships by default. On RKE2 v1.36 and later, that controller is Traefik.

Why three nodes and not two: etcd needs a majority (quorum) of members to accept writes. With 2 members the majority is 2, so losing either node stops the cluster. With 3 members the majority is 2, so the cluster survives one node failure. Rancher's [recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture) publishes the fault tolerance table:

| etcd members | Majority | Failures tolerated |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 2 | 0 |
| 3 | 2 | 1 |
| 5 | 3 | 2 |

The [RKE2 HA documentation](https://docs.rke2.io/install/ha) gives the same rule: use an odd number of server nodes, and three is the recommended count.

Rancher's architecture guide normally says not to run workloads on etcd or control plane nodes. It makes one exception: a three-node cluster with all roles is valid for the Rancher management cluster, as long as nothing other than Rancher runs on it. If you plan to run other workloads, use three etcd/control plane servers plus two or more agent (worker) nodes instead.

### [Sizing](#sizing)

The [Rancher installation requirements](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/installation-requirements) size each node of an RKE2 management cluster by how much it will manage:

| Managed infrastructure | Max clusters | Max nodes | vCPUs per node | RAM per node |
|---|---|---|---|---|
| Small | 150 | 1500 | 4 | 16 GB |
| Medium | 300 | 3000 | 8 | 32 GB |
| Large | 500 | 5000 | 16 | 64 GB |

Use SSDs. Rancher performance depends on etcd, and both the Rancher and [RKE2 requirements](https://docs.rke2.io/install/requirements) pages recommend SSD storage for it. A highly available setup with at least three nodes is required for production.

### [Supported Operating Systems](#supported-operating-systems)

Pick an OS from the SUSE support matrix rather than from memory. As of Rancher v2.15.2 and RKE2 v1.36, the certified operating systems for RKE2 are:

- SLES 16.0, SLES 15 SP7, and SLE Micro 6.2 and 6.1 (the RKE2 v1.36 matrix also lists SLES 15 SP6 and SLE Micro 6.0)
- openSUSE Leap 16.0 and 15 SP7
- RHEL 10.2, 10.0, 9.8, 9.6, and 8.10 on the Rancher matrix (RHEL 10.1 and 9.7 also appear on the RKE2 matrix). Rocky Linux, Oracle Linux, and Amazon Linux 2023 count as validated through RHEL testing.
- Ubuntu 26.04, 24.04, and 22.04

The safest choice is a release that appears in both matrices, for example SLES 16.0 or 15 SP7, SLE Micro 6.2 or 6.1, RHEL 10.2, 10.0, or 9.8, or Ubuntu 26.04, 24.04, or 22.04.

Sources: [Rancher v2.15.2 support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/rancher-v2-15-2/) and [RKE2 v1.36 support matrix](https://www.suse.com/suse-rke2/support-matrix/all-supported-versions/rke2-v1-36/). CentOS Linux 8 reached end of life and does not appear in either matrix, so do not use it. The same matrix certifies RKE2 v1.34 through v1.36 for the Rancher v2.15.2 management cluster.

If `firewalld` is running, the Rancher requirements say to disable it or to configure a dedicated zone that allows the pod CIDR and internal node traffic.

---

## [Load Balancer and DNS](#load-balancer-and-dns)

Create a layer 4 (TCP) load balancer or a stable DNS name in front of the three nodes. Per the [RKE2 for Rancher guide](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-cluster-setup/rke2-for-rancher) and the [RKE2 HA guide](https://docs.rke2.io/install/ha), it needs these listeners:

| Port | Purpose |
|---|---|
| 9345/TCP | RKE2 supervisor, used by joining nodes |
| 6443/TCP | Kubernetes API |
| 80/TCP, 443/TCP | Rancher UI and API through the ingress controller |

Point a DNS record such as `rancher.example.com` at the load balancer. For on-prem networks without a hardware load balancer, [kube-vip](/known-good-designs/loadbalancers/kube-vip-layer2/) can provide the virtual IP.

---

## [RKE2 Cluster Installation](#rke2-cluster-installation)

### Step 1: Install the First Server

Create `/etc/rancher/rke2/config.yaml` before starting RKE2:

```yaml
token: <shared-secret>
tls-san:
  - rancher.example.com
  - <load-balancer-ip>
```

Install and start RKE2. Pin a v1.36 patch release that the Rancher support matrix certifies; v1.36.5+rke2r1 is the current patch at the time of writing:

```bash
curl -sfL https://get.rke2.io | INSTALL_RKE2_VERSION="v1.36.5+rke2r1" sh -
systemctl enable --now rke2-server.service
```

If you omit `token`, RKE2 generates one in `/var/lib/rancher/rke2/server/node-token`.

### Step 2: Join the Second and Third Servers

On each of the other two servers, create `/etc/rancher/rke2/config.yaml` with the same token and point it at the fixed registration address on port 9345:

```yaml
server: https://rancher.example.com:9345
token: <shared-secret>
tls-san:
  - rancher.example.com
  - <load-balancer-ip>
```

Then install and start RKE2 the same way as the first server. Join servers one at a time, and wait for each node to be `Ready` before adding the next one. Critical settings such as `cluster-cidr` must be identical on every server.

### Step 3: Configure kubectl

Copy `/etc/rancher/rke2/rke2.yaml` from the first server to your workstation and change the `server` field from `https://127.0.0.1:6443` to `https://rancher.example.com:6443`. Then confirm all three nodes are `Ready`:

```bash
kubectl get nodes
```

### Optional: Dedicated Worker Nodes

If you run anything besides Rancher on this cluster, add two or more agents. Agents join with the same `server` and `token` values:

```bash
curl -sfL https://get.rke2.io | INSTALL_RKE2_TYPE="agent" INSTALL_RKE2_VERSION="v1.36.5+rke2r1" sh -
systemctl enable --now rke2-agent.service
```

---

## [Ingress](#ingress)

You do not install an ingress controller yourself. RKE2 deploys one on server start, and Rancher's documentation says the same for RKE2 clusters.

- **RKE2 v1.36 and later (new clusters):** Traefik is the default. RKE2 runs it as a DaemonSet that binds ports 80 and 443 on every node, and creates an IngressClass named `traefik`. The [RKE2 for Rancher guide](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-cluster-setup/rke2-for-rancher) states that Rancher is served through the Traefik ingress on ports 80 and 443.
- **ingress-nginx:** The Kubernetes project retired Ingress NGINX in March 2026, with no further releases or security fixes ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), [Steering and Security Response Committee statement](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)). RKE2 v1.36 still ships it as deprecated behind `ingress-controller: ingress-nginx`, and the [RKE2 networking docs](https://docs.rke2.io/networking/networking_services) say v1.37 removes it for new clusters. Existing clusters should follow the [RKE2 ingress migration guide](https://docs.rke2.io/reference/ingress_migration).

The ingress controller is chosen with the `ingress-controller` key in each server's `config.yaml` (`traefik`, `ingress-nginx`, or `none`). Traefik settings are changed through a `HelmChartConfig` named `rke2-traefik` in `kube-system`.

---

## [cert-manager](#cert-manager)

Rancher-generated certificates and Let's Encrypt certificates both require cert-manager. Skip this step only if you bring your own certificate (`ingress.tls.source=secret`). Install a supported release; v1.21.2 is current, and the [cert-manager releases page](https://cert-manager.io/docs/releases/) lists 1.21 and 1.20 as supported:

```bash
helm install cert-manager oci://quay.io/jetstack/charts/cert-manager \
  --version v1.21.2 \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

See the [cert-manager known good design](/known-good-designs/cluster-services/cert-manager/) for details.

---

## [Rancher Deployment](#rancher-deployment)

Add the stable chart repository (recommended for production) and install Rancher. v2.15.2 is the current stable chart at the time of writing.

```bash
helm repo add rancher-stable https://releases.rancher.com/server-charts/stable
helm repo update

kubectl create namespace cattle-system

helm install rancher rancher-stable/rancher \
  --namespace cattle-system \
  --version 2.15.2 \
  --set hostname=rancher.example.com \
  --set bootstrapPassword=<unique-password> \
  --set ingress.ingressClassName=traefik \
  --set ingress.tls.source=letsEncrypt \
  --set letsEncrypt.email=admin@example.com \
  --set letsEncrypt.ingress.class=traefik
```

Notes on these values:

- The [Rancher Helm install guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster) says the chart does not set an `ingressClassName` by default, so the Ingress falls back to the cluster default class. Setting `ingress.ingressClassName=traefik` removes that ambiguity. The [Rancher on EKS guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster/rancher-on-amazon-eks) uses the same flag.
- `letsEncrypt.ingress.class` must match your ingress controller. The Rancher docs list `traefik` and `nginx` as options. Older examples that pass `nginx` will not solve HTTP-01 challenges on a Traefik cluster.
- Let's Encrypt HTTP-01 needs the hostname to be reachable from the internet on port 80. For internal-only installs, drop the three `letsEncrypt` lines to use Rancher-generated certificates, or use `ingress.tls.source=secret` with your own certificate.

### [Gateway API Exposure](#gateway-api-exposure)

The Rancher v2.15.2 chart also has a `networkExposure.type` value (`ingress`, `gateway`, or `none`). With `gateway`, Rancher creates Gateway API resources against the `gateway.gatewayClass.name` class (default `traefik`) instead of an Ingress. This option is in the chart's `values.yaml` but not yet on the documented Helm chart options page, so treat it as newer than the default path. On RKE2, Gateway API requires Traefik with `providers.kubernetesGateway.enabled: true` in the `rke2-traefik` HelmChartConfig. The default `ingress` exposure shown above is the conservative choice.

---

## [Testing and Validation](#testing-and-validation)

1. Check that Rancher and its Ingress are up:
   ```bash
   kubectl -n cattle-system rollout status deploy/rancher
   kubectl -n cattle-system get ingress
   ```
2. Check that the certificate was issued (Let's Encrypt or Rancher-generated):
   ```bash
   kubectl -n cattle-system get certificate
   ```
3. Browse to `https://rancher.example.com` and log in with the bootstrap password.
4. Test failure tolerance before going live: power off one node and confirm `kubectl get nodes` still answers and the Rancher UI still loads.

### Backups

Schedule RKE2 etcd snapshots and copy them off the nodes (RKE2 supports S3 targets). Rancher's production checklist also recommends recurring snapshots stored off-node. Install the Rancher Backups operator to back up Rancher's own resources.

---

## [References](#references)
- [Rancher: Setting up an RKE2 cluster for Rancher](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-cluster-setup/rke2-for-rancher)
- [Rancher installation requirements](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/installation-requirements)
- [Rancher Helm install guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster)
- [Rancher recommended cluster architecture](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-clusters-in-rancher-setup/checklist-for-production-ready-clusters/recommended-cluster-architecture)
- [RKE2 high availability](https://docs.rke2.io/install/ha)
- [RKE2 requirements](https://docs.rke2.io/install/requirements)
- [RKE2 networking services (Traefik, ingress-nginx, Gateway API)](https://docs.rke2.io/networking/networking_services)
- [SUSE Rancher v2.15.2 support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/rancher-v2-15-2/)
- [SUSE RKE2 v1.36 support matrix](https://www.suse.com/suse-rke2/support-matrix/all-supported-versions/rke2-v1-36/)
- [Kubernetes: Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
