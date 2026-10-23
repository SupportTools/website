---
title: "MetalLB as TCP/UDP Load Balancer for RKE2"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Load Balancers", "MetalLB", "RKE2", "Kubernetes"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Configure MetalLB v0.16 in Layer 2 mode on RKE2 with IPAddressPool and L2Advertisement resources to give Service type LoadBalancer real IPs on bare metal."
more_link: "yes"
url: "/known-good-designs/loadbalancers/metallb-layer2/"
---

![MetalLB Layer2 Load Balancer](https://cdn.support.tools/known-good-designs/load-balancers/metallb-layer2/metallb-architecture.png)

This guide sets up MetalLB in Layer 2 mode so that Services of `type: LoadBalancer` on a bare-metal or on-prem RKE2 cluster get reachable IP addresses.

For ingress on RKE2 (Traefik by default from v1.36), see the [Ingress on RKE2 guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).

<!--more-->

## [Overview](#overview)

### [What is MetalLB?](#what-is-metallb)
MetalLB is a load balancer implementation for bare-metal Kubernetes clusters. It assigns addresses from pools you define to Services of `type: LoadBalancer` and announces them on the network, either with ARP/NDP (Layer 2 mode) or with BGP.

#### Key Features
- **Layer 2 announcement:** No router configuration needed; works on any flat network.
- **TCP and UDP Services:** Any Service of `type: LoadBalancer`.
- **Failover:** If the node announcing an address fails, another node takes over.

#### Layer 2 Limitations
From the MetalLB [Layer 2 concepts page](https://metallb.io/concepts/layer2/):

- All traffic for one Service IP arrives at a single elected node, so a Service's ingress bandwidth is limited to one node's bandwidth.
- Failover depends on clients updating their ARP caches. Modern operating systems switch within seconds, but some clients take longer.
- Layer 2 mode is a failover mechanism, not a load balancer. kube-proxy spreads the traffic to pods after it reaches the elected node.

#### What MetalLB Does Not Do
MetalLB only serves Services of `type: LoadBalancer`. It does not provide the RKE2 control plane VIP (the fixed registration address for ports 9345 and 6443). Use [kube-vip](/known-good-designs/loadbalancers/kube-vip-layer2/), DNS, or an external load balancer for that.

For more details, visit the [MetalLB documentation](https://metallb.io/).

---

## [Setup Instructions](#setup-instructions)

### [Step 1: Install MetalLB](#step-1-install-metallb)

The current release is v0.16.1 ([installation guide](https://metallb.io/installation/)). For Layer 2 only, the native manifest is enough:

```bash
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.16.1/config/manifests/metallb-native.yaml
```

Or install with Helm:

```bash
helm repo add metallb https://metallb.github.io/metallb
helm install metallb metallb/metallb \
  --namespace metallb-system \
  --create-namespace \
  --version 0.16.1
```

The Helm chart defaults to the FRR-K8s backend, which the MetalLB docs recommend if you will use BGP. The older FRR mode is deprecated.

If you changed kube-proxy to IPVS mode, enable `strictARP: true` in the kube-proxy configuration, as the installation guide requires.

Verify the pods:
```bash
kubectl get pods -n metallb-system
```

### [Step 2: Configure an Address Pool](#step-2-configure-the-metallb-configmap)

Since v0.13, MetalLB is configured with custom resources. The old `config` ConfigMap with `address-pools` is no longer read, so configurations copied from older guides silently do nothing.

Define a pool and advertise it in Layer 2 mode ([configuration guide](https://metallb.io/configuration/)):

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: default
  namespace: metallb-system
spec:
  addresses:
  - 192.168.1.240-192.168.1.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: default
  namespace: metallb-system
spec:
  ipAddressPools:
  - default
```

Apply it:
```bash
kubectl apply -f metallb-pool.yaml
```

The addresses must be on the node subnet and outside any DHCP scope. MetalLB does not obtain addresses from a DHCP server; earlier versions of this page showed a "DHCP pool" that MetalLB has never supported. If you need DHCP-assigned Service addresses, kube-vip offers that.

### [Step 3: Test MetalLB](#step-3-test-metallb)

1. **Create a Service with LoadBalancer Type**:
   ```yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: nginx-service
     namespace: default
   spec:
     selector:
       app: nginx
     ports:
       - protocol: TCP
         port: 80
         targetPort: 80
     type: LoadBalancer
   ```

2. **Validate the Assigned IP**:
   ```bash
   kubectl get svc nginx-service
   ```
   Expected output:
   ```plaintext
   NAME            TYPE           CLUSTER-IP       EXTERNAL-IP    PORT(S)        AGE
   nginx-service   LoadBalancer   10.43.12.34      192.168.1.240  80:30001/TCP   2m
   ```

3. **Check which node announces it**:
   ```bash
   kubectl describe svc nginx-service
   ```
   The events show the speaker node that announced the address.

With the default `externalTrafficPolicy: Cluster`, the client source IP is hidden behind the announcing node. With `Local`, pods see the real client IP, but only pods on the announcing node receive traffic ([usage guide](https://metallb.io/usage/)).

---

## [Deploying MetalLB via ArgoCD](#deploying-metallb-via-argocd)

Install the chart with Argo CD, and keep the pool and advertisement in Git as a second Application (or in the same repository path) so they sync after the CRDs exist:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: metallb
  namespace: argocd
spec:
  destination:
    namespace: metallb-system
    server: https://kubernetes.default.svc
  project: load-balancers
  source:
    repoURL: https://metallb.github.io/metallb
    chart: metallb
    targetRevision: 0.16.1
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

---

## [Dedicated Pool for Ingress](#customizing-load-balancers)

Create a separate pool for the ingress controller so its address never changes, with `autoAssign: false` so other Services cannot take addresses from it:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: ingress
  namespace: metallb-system
spec:
  addresses:
  - 192.168.1.200-192.168.1.210
  autoAssign: false
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: ingress
  namespace: metallb-system
spec:
  ipAddressPools:
  - ingress
```

On RKE2, Traefik's Service is `ClusterIP` by default (Traefik listens on host ports 80 and 443 on every node). To put it behind a MetalLB address, change the Service type with a `HelmChartConfig` and request the pool and a fixed IP through MetalLB's annotations:

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
        metallb.io/address-pool: ingress
        metallb.io/loadBalancerIPs: 192.168.1.200
```

`metallb.io/loadBalancerIPs` is preferred over `spec.loadBalancerIP`, which is planned for deprecation in the Kubernetes API.

---

## [Integration with RKE2](#integration-with-rke2)

- MetalLB gives RKE2 Services real addresses on bare metal; it does not replace the control plane VIP.
- RKE2 has its own ServiceLB (klipper-lb), off by default and enabled with `enable-servicelb`. Do not run ServiceLB and MetalLB together.
- Do not run MetalLB and kube-vip Service advertisement on the same cluster. Pick one.
- For ingress, see the [Ingress on RKE2 guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/).

---

## [References](#references)
- [MetalLB installation](https://metallb.io/installation/)
- [MetalLB configuration](https://metallb.io/configuration/)
- [MetalLB Layer 2 concepts](https://metallb.io/concepts/layer2/)
- [MetalLB usage](https://metallb.io/usage/)
- [RKE2 networking services](https://docs.rke2.io/networking/networking_services)
- [Ingress on RKE2 Guide](/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/)
- [Argo CD Documentation](https://argo-cd.readthedocs.io/en/stable/)
