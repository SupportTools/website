---
title: "Kube-VIP as TCP/UDP Load Balancer for RKE2"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Load Balancers", "Kube-VIP", "RKE2", "Kubernetes"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Configure kube-vip in Layer 2 (ARP) mode on RKE2 for a highly available control plane VIP and for Service type LoadBalancer addresses with the kube-vip cloud provider."
more_link: "yes"
url: "/known-good-designs/loadbalancers/kube-vip-layer2/"
---

![Kube-VIP Layer2 Load Balancer](https://cdn.support.tools/known-good-designs/load-balancers/kube-vip/kube-vip.png)

This guide sets up kube-vip in Layer 2 (ARP) mode on an RKE2 cluster for two jobs: a virtual IP for the RKE2 control plane, and external IPs for Services of `type: LoadBalancer`.

For ingress on RKE2 (Traefik by default from v1.36), see the [Ingress on RKE2 guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).

<!--more-->

## [Overview](#overview)

### [What is Kube-VIP?](#what-is-kube-vip)
kube-vip provides virtual IPs for Kubernetes clusters without an external load balancer. In Layer 2 mode, the elected leader node answers ARP for the VIP, so all traffic for that address lands on one node at a time and moves to another node on failure.

#### Key Features
- **Control plane VIP:** A single stable address for the Kubernetes API (6443) and the RKE2 supervisor (9345) across all server nodes. This is the "fixed registration address" the [RKE2 HA guide](https://docs.rke2.io/install/ha) asks for.
- **Service load balancer:** Assigns and advertises addresses for Services of `type: LoadBalancer`, with IP pools managed by the kube-vip cloud provider.
- **Failover:** Leader election moves the VIP when the active node fails.

Layer 2 mode is failover, not load spreading: one node receives all traffic for a given VIP. For true multi-node load spreading, use BGP mode or an external load balancer.

For more details, visit the [kube-vip documentation](https://kube-vip.io/).

![Kube-VIP Architecture](https://cdn.support.tools/known-good-designs/load-balancers/kube-vip/diagram.png)

---

## [Setup Instructions](#setup-instructions)

The steps follow the kube-vip [DaemonSet installation guide](https://kube-vip.io/docs/installation/daemonset/). Pick a free VIP on the node subnet (this example uses `192.168.1.100`) and note the node interface name (for example `eth0`).

### [Step 1: Add the VIP to the RKE2 Certificates](#step-1-add-the-vip-to-the-rke2-certificates)

On every server node, add the VIP (and any DNS name for it) to `tls-san` in `/etc/rancher/rke2/config.yaml` before starting RKE2:

```yaml
tls-san:
  - 192.168.1.100
  - rke2.example.com
```

### [Step 2: Generate the kube-vip Manifests](#step-2-generate-the-kube-vip-manifests)

kube-vip's RBAC manifest and DaemonSet must be in place before the other nodes join. RKE2 applies any manifest in `/var/lib/rancher/rke2/server/manifests/` on startup, so place them there on the first server.

1. **RBAC** (ServiceAccount, ClusterRole, ClusterRoleBinding):
   ```bash
   curl -sL https://kube-vip.io/manifests/rbac.yaml \
     -o /var/lib/rancher/rke2/server/manifests/kube-vip-rbac.yaml
   ```

2. **DaemonSet.** Generate it with the kube-vip image from any machine with Docker or Podman. Pin a release; v1.2.4 is used here:
   ```bash
   export VIP=192.168.1.100
   export INTERFACE=eth0
   export KVVERSION=v1.2.4

   docker run --network host --rm ghcr.io/kube-vip/kube-vip:$KVVERSION \
     manifest daemonset \
     --interface $INTERFACE \
     --address $VIP \
     --inCluster \
     --taint \
     --controlplane \
     --services \
     --arp \
     --leaderElection > kube-vip.yaml
   ```
   Copy `kube-vip.yaml` to `/var/lib/rancher/rke2/server/manifests/kube-vip.yaml` on the first server.

   - `--controlplane` advertises the control plane VIP.
   - `--services` makes kube-vip advertise Service `LoadBalancer` addresses.
   - `--inCluster` and `--taint` run kube-vip with its ServiceAccount and pin the pods to control plane nodes.

3. **Start the first server**, then confirm kube-vip is running and the VIP answers:
   ```bash
   kubectl -n kube-system get pods -l app.kubernetes.io/name=kube-vip-ds -o wide
   curl -k https://192.168.1.100:6443/version
   ```
   The label selector can differ between kube-vip versions; `kubectl -n kube-system get ds` shows the DaemonSet name if it does not match.

### [Step 3: Join the Other Servers Through the VIP](#step-3-join-the-other-servers-through-the-vip)

Because the leader node owns the whole VIP, both the supervisor (9345) and the API (6443) are reachable on it. Join the remaining servers and all agents with:

```yaml
server: https://192.168.1.100:9345
token: <shared-secret>
```

Use three servers (an odd number) so etcd keeps quorum when one fails.

### [Step 4: Test Failover](#step-4-test-failover)

1. Find the current leader. kube-vip records it in a Lease in `kube-system` (named `plndr-cp-lock` for the control plane by default):
   ```bash
   kubectl -n kube-system get lease
   ```
2. Check ARP from another host on the same network:
   ```bash
   arp -a | grep 192.168.1.100
   ```
3. Shut down the leader node and confirm `curl -k https://192.168.1.100:6443/version` keeps answering after a few seconds, with the ARP entry now pointing at a different MAC.

---

## [Service LoadBalancer Addresses](#customizing-load-balancers)

With `--services` enabled, kube-vip advertises any address set on a Service through the `kube-vip.io/loadbalancerIPs` annotation or `spec.loadBalancerIP`. To have addresses assigned automatically from a pool, install the [kube-vip cloud provider](https://kube-vip.io/docs/usage/cloud-provider/):

```bash
kubectl apply -f https://raw.githubusercontent.com/kube-vip/kube-vip-cloud-provider/main/manifest/kube-vip-cloud-controller.yaml
```

Then define pools in the `kubevip` ConfigMap in `kube-system`. `range-global` and `cidr-global` apply to all namespaces; `range-<namespace>` or `cidr-<namespace>` limits a pool to one namespace:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubevip
  namespace: kube-system
data:
  range-global: 192.168.1.200-192.168.1.220
```

The manifest URL above tracks the project's main branch; for production, download it once and commit a reviewed copy to your GitOps repository.

### Example: Expose Traefik Through a kube-vip Address

On RKE2, Traefik binds host ports 80 and 443 and its Service is `ClusterIP`. To give it a dedicated VIP instead of relying on node IPs, switch the Service to `LoadBalancer` with a `HelmChartConfig` and request a fixed address:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      spec:
        type: LoadBalancer
      annotations:
        kube-vip.io/loadbalancerIPs: "192.168.1.200"
```

### DHCP-Assigned Addresses

The kube-vip [Service documentation](https://kube-vip.io/docs/usage/kubernetes-services/) describes requesting a Service address from a DHCP server by setting `kube-vip.io/loadbalancerIPs: "0.0.0.0"`. Static addresses are easier to put in DNS and firewall rules, so prefer them unless your network team requires DHCP.

---

## [Deploying Kube-VIP via ArgoCD](#deploying-kube-vip-via-argocd)

The control plane VIP must exist before Argo CD can run, so keep the control plane DaemonSet in the RKE2 manifests directory as shown above. Manage the cloud provider and its ConfigMap with Argo CD by committing the reviewed manifests to Git:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: kube-vip-cloud-provider
  namespace: argocd
spec:
  destination:
    namespace: kube-system
    server: https://kubernetes.default.svc
  project: load-balancers
  source:
    repoURL: https://git.example.com/platform/cluster-services.git
    targetRevision: main
    path: kube-vip-cloud-provider
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

---

## [Integration with RKE2](#integration-with-rke2)

- kube-vip gives RKE2 the fixed registration address its HA guide requires, without a hardware load balancer.
- Traefik, the default RKE2 ingress from v1.36, can be reached either on the host ports 80 and 443 of every node or through its own kube-vip Service address as shown above. See the [Ingress on RKE2 guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).
- Do not run kube-vip Service advertisement and MetalLB on the same Services. Pick one Service load balancer per cluster.

---

## [References](#references)
- [kube-vip DaemonSet installation](https://kube-vip.io/docs/installation/daemonset/)
- [kube-vip cloud provider](https://kube-vip.io/docs/usage/cloud-provider/)
- [kube-vip Kubernetes Services](https://kube-vip.io/docs/usage/kubernetes-services/)
- [RKE2 high availability](https://docs.rke2.io/install/ha)
- [Ingress on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/)
