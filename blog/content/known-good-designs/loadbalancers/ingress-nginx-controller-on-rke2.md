---
title: "Ingress NGINX Controller on RKE2: Retirement and the Traefik Default"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Load Balancers", "Ingress NGINX", "Traefik", "Gateway API", "RKE2", "Kubernetes"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "How ingress works on RKE2 now that Ingress NGINX is retired: Traefik is the default from v1.36, how to customize it with HelmChartConfig, enable Gateway API, and migrate existing ingress-nginx clusters."
more_link: "yes"
url: "/known-good-designs/loadbalancers/ingress-nginx-controller-on-rke2/"
---

![NGINX Architecture for RKE2](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-rke2/arch_nginx-for_rke2.png)

RKE2 used to ship the Ingress NGINX Controller as its built-in ingress. That project is now retired, and RKE2 v1.36 deploys Traefik by default on new clusters. This page covers the current known good design for ingress on RKE2 and how to move existing clusters off ingress-nginx.

<!--more-->

## [Status of Ingress NGINX](#status-of-ingress-nginx)

- **Upstream:** Kubernetes SIG Network and the Security Response Committee announced on November 11, 2025 that Ingress NGINX would be retired in March 2026. After that there are no further releases, bug fixes, or security patches, and the repositories become read-only ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)). The Steering and Security Response Committees repeated the warning on January 29, 2026 ([statement](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)). They recommend migrating to Gateway API or another Ingress controller.
- **RKE2:** According to the [RKE2 networking services docs](https://docs.rke2.io/networking/networking_services):
  - Starting with v1.36, Traefik is the default ingress controller for new clusters.
  - v1.36 still ships ingress-nginx as deprecated. You must opt in with `ingress-controller: ingress-nginx`.
  - In v1.37, ingress-nginx is removed and unavailable for new clusters.
  - The RKE2 docs note that SUSE Rancher Prime LTS customers get extended Ingress NGINX support through December 2027 ([migration guide](https://docs.rke2.io/reference/ingress_migration)). Everyone else should migrate.

---

## [Choosing the Ingress Controller](#choosing-the-ingress-controller)

RKE2 selects its packaged ingress controller with the `ingress-controller` key in `/etc/rancher/rke2/config.yaml` on every server node:

```yaml
# traefik (default for new clusters on v1.36+), ingress-nginx (deprecated), or none
ingress-controller: traefik
```

Set `none` if you deploy your own controller or rely only on Gateway API through another implementation.

To see what an existing cluster runs:

```bash
kubectl get ingressclass
kubectl -n kube-system get daemonset | grep -E 'traefik|ingress-nginx'
```

---

## [How RKE2 Deploys Traefik](#how-rke2-deploys-traefik)

RKE2 manages Traefik as the `rke2-traefik` HelmChart in `kube-system`, upgraded together with RKE2 itself. The RKE2 packaging of the upstream Traefik chart changes several defaults (see the [rke2-traefik chart patch](https://github.com/rancher/rke2-charts/tree/main-source/packages/rke2-traefik)):

| Setting | Upstream Traefik chart | RKE2 `rke2-traefik` |
|---|---|---|
| Workload kind | Deployment | DaemonSet |
| Host ports | none | 80 and 443 on every node |
| Service type | LoadBalancer | ClusterIP |
| IngressClass | default class, unnamed | `traefik`, not marked default |

Because Traefik binds host ports 80 and 443 on every node, you can put any layer 4 load balancer (hardware, cloud, [kube-vip](/known-good-designs/loadbalancers/kube-vip-layer2/), or DNS round robin) in front of the nodes on those ports. Ports 80 and 443 on the nodes are then not available for other HostPort or NodePort services.

Set `ingressClassName: traefik` explicitly on your Ingress objects so they do not depend on a cluster default class.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
  namespace: default
spec:
  ingressClassName: traefik
  rules:
  - host: app.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: example
            port:
              number: 80
```

---

## [Customizing Traefik on RKE2](#customizing-traefik-on-rke2)

Do not edit the `HelmChart` object directly; RKE2 overwrites it. Use a `HelmChartConfig` named `rke2-traefik` in `kube-system`, either applied with kubectl or dropped into `/var/lib/rancher/rke2/server/manifests/` on a server node:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-traefik
  namespace: kube-system
spec:
  valuesContent: |-
    logs:
      general:
        level: INFO
    ports:
      websecure:
        transport:
          respondingTimeouts:
            readTimeout: 600s
```

The `valuesContent` keys are values of the upstream [Traefik Helm chart](https://github.com/traefik/traefik-helm-chart/blob/master/traefik/values.yaml). RKE2's own example in the networking docs sets the log level the same way.

### Gateway API

The RKE2 docs state that Gateway API on RKE2 requires Traefik. Enable Traefik's Gateway provider in the same `HelmChartConfig`:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: rke2-traefik
  namespace: kube-system
spec:
  valuesContent: |-
    providers:
      kubernetesGateway:
        enabled: true
```

The RKE2 docs list Traefik v3.7.x with Gateway API v1.5. From v1.37, the Gateway API CRDs ship in a standalone chart instead of with Traefik. Before the April 2026 RKE2 releases, disabling Traefik after enabling it removed the Gateway API CRDs (and every Gateway and HTTPRoute with them), so do not toggle Traefik off on clusters that use Gateway API.

After enabling, check the class name before writing Gateways:

```bash
kubectl get gatewayclass
```

---

## [Migrating an Existing ingress-nginx Cluster](#migrating-an-existing-ingress-nginx-cluster)

Upgrading an existing cluster does not by itself move your Ingress objects. Follow the [RKE2 ingress migration guide](https://docs.rke2.io/reference/ingress_migration); in short:

1. Set `ingressClassName: nginx` explicitly on every existing Ingress.
2. On each server, set `ingress-controller` to both controllers (`ingress-nginx` and `traefik`) and add a `rke2-traefik` HelmChartConfig that moves Traefik to ports 8000 and 8443 and enables Traefik's Ingress NGINX compatibility provider (`kubernetesIngressNGINX`).
3. Restart `rke2-server` on the control plane nodes and confirm both the `rke2-ingress-nginx-controller` and `rke2-traefik` DaemonSets are running.
4. Create copies of your Ingresses with the migration IngressClass `rke2-ingress-nginx-migration` and test them through ports 8000 and 8443. Load balancer health checks differ: `/healthz` for NGINX, `/ping` for Traefik.
5. Set `ingress-controller` to only `traefik`, remove the temporary ports from the HelmChartConfig, and restart.
6. Delete the old `nginx` Ingress objects.

Traefik's compatibility provider does not support every NGINX annotation. Check the [Traefik Ingress NGINX provider docs](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-ingress-nginx/) for your annotations, especially `configuration-snippet` and other snippet annotations, before migrating. The RKE2 guide notes the provider name in the HelmChartConfig changed from `kubernetesIngressNginx` to `kubernetesIngressNGINX` in the June 2026 RKE2 releases.

Rancher-provisioned downstream RKE2 clusters have their own migration guide in the Rancher documentation, linked from the [RKE2 for Rancher page](https://ranchermanager.docs.rancher.com/how-to-guides/new-user-guides/kubernetes-cluster-setup/rke2-for-rancher).

---

![Design of NGINX Ingress Controller on RKE2](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-rke2/design-of-NGINX-Ingress-Controller-on-RKE2.png)

The diagram above shows the legacy ingress-nginx layout. Traefik on RKE2 follows the same pattern: one controller pod per node, bound to host ports 80 and 443, with an external layer 4 load balancer in front of the nodes.

---

### [References](#references)
- [RKE2 networking services: Traefik, ingress-nginx, Gateway API](https://docs.rke2.io/networking/networking_services)
- [RKE2 ingress migration guide](https://docs.rke2.io/reference/ingress_migration)
- [Kubernetes: Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- [Kubernetes Steering and SRC statement on Ingress NGINX](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)
- [Traefik Kubernetes Gateway provider](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-gateway/)
- [Traefik Ingress NGINX provider](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-ingress-nginx/)
- [rke2-traefik chart packaging](https://github.com/rancher/rke2-charts/tree/main-source/packages/rke2-traefik)
