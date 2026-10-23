---
title: "Ingress NGINX Controller on DOKS: Retirement, Gateway API, and Traefik"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Load Balancers", "Ingress NGINX", "Traefik", "Gateway API", "DOKS", "DigitalOcean"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Ingress on DigitalOcean Kubernetes (DOKS) after the Ingress NGINX retirement: the built-in Cilium Gateway API, Traefik behind a DigitalOcean Load Balancer, and the current load balancer annotations."
more_link: "yes"
url: "/known-good-designs/loadbalancers/ingress-nginx-controller-on-doks/"
---

![NGINX Architecture for DOKS](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-doks/arch_nginx-for_doks.png)

This page used to describe Ingress NGINX on DigitalOcean Kubernetes (DOKS). Ingress NGINX is now retired, and DOKS ships a managed Gateway API implementation, so the known good design has changed.

<!--more-->

## [Overview](#overview)

### [Ingress NGINX Is Retired](#ingress-nginx-is-retired)

Kubernetes SIG Network and the Security Response Committee retired Ingress NGINX in March 2026. There are no further releases, bug fixes, or security patches ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), [Steering and SRC statement](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)). The DigitalOcean Marketplace 1-Click app still installs it, but new clusters should not start on it.

### [Choosing a Design](#choosing-a-design)

| Design | Use when |
|---|---|
| **DOKS Gateway API (Cilium)** | The cluster uses VPC-native networking and runs Kubernetes 1.33 or later. No controller to install. |
| **Traefik behind a DigitalOcean Load Balancer** | You need Ingress objects (for example for charts such as Rancher that create Ingresses), or the cluster is not VPC-native. |

DOKS currently supports Kubernetes 1.34, 1.35, 1.36, and 1.37; 1.34 reaches end of support on October 27, 2026 ([DOKS supported releases](https://docs.digitalocean.com/products/kubernetes/details/supported-releases/)).

---

## [Option A: Built-in Gateway API](#option-a-built-in-gateway-api)

Per the [DOKS Gateway API guide](https://docs.digitalocean.com/products/kubernetes/how-to/use-gateway-api/), Gateway API is enabled by default on VPC-native clusters running 1.33 or later, backed by a managed Cilium implementation with the GatewayClass `cilium`. Check it:

```bash
kubectl get gatewayclass cilium
```

A Gateway provisions a DigitalOcean Load Balancer:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: example-gateway
  namespace: default
spec:
  gatewayClassName: cilium
  listeners:
    - name: http
      protocol: HTTP
      port: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: example-route
  namespace: default
spec:
  parentRefs:
    - name: example-gateway
  rules:
    - backendRefs:
        - name: my-service
          port: 80
```

For TLS, either terminate at the load balancer with a DigitalOcean certificate (`do-loadbalancer-certificate-id` or `do-loadbalancer-certificate-name` in `.spec.infrastructure.annotations`) or add an HTTPS listener that references a TLS Secret in the Gateway's namespace. cert-manager can fill that Secret from a ClusterIssuer annotation on the Gateway; see the [cert-manager design](/known-good-designs/cluster-services/cert-manager/). Gateway API limits `.spec.infrastructure.annotations` to 8 entries.

---

![Design of NGINX Ingress Controller](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-doks/design-of-NGINX-Ingress-Controller.png)

The diagram shows the original NGINX layout. Option B below has the same shape with Traefik in place of NGINX.

---

## [Option B: Traefik with a DigitalOcean Load Balancer](#option-b-traefik-with-a-digitalocean-load-balancer)

### [DigitalOcean Load Balancer Behavior](#digitalocean-load-balancer-behavior)

When a Service of `type: LoadBalancer` is created on DOKS, the DigitalOcean cloud controller creates a load balancer outside the cluster that forwards to the Service's node ports on every node. From the [DOKS load balancer guide](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/):

- Since DOKS 1.33.1-do.0, the default load balancer type is `REGIONAL_NETWORK` (a network load balancer). Set `service.beta.kubernetes.io/do-loadbalancer-type: "REGIONAL"` if you need an HTTP load balancer, for example for PROXY protocol.
- Configure the load balancer only through Service annotations. Changes made in the control panel can be overwritten by the reconciler or break the cluster's link to the load balancer.
- `externalTrafficPolicy: Local` marks nodes without a local pod as unhealthy, which lets nodes drain cleanly. DigitalOcean load balancers proxy connections, so `Local` does not preserve client IPs; use PROXY protocol or `X-Forwarded-For` for that.

### [Helm Deployment Example](#helm-deployment-example)

1. **Add the Traefik Helm repository:**
   ```bash
   helm repo add traefik https://traefik.github.io/charts
   helm repo update
   ```

2. **Create `traefik-values.yaml`:**
   ```yaml
   deployment:
     replicas: 3
   podDisruptionBudget:
     enabled: true
     maxUnavailable: 1
   ingressClass:
     enabled: true
     isDefaultClass: true
     name: traefik
   service:
     annotations:
       service.beta.kubernetes.io/do-loadbalancer-type: "REGIONAL"
       service.beta.kubernetes.io/do-loadbalancer-size-unit: "1"
   ```

   If you need real client IPs, add `do-loadbalancer-enable-proxy-protocol: "true"` and configure `ports.web.proxyProtocol` and `ports.websecure.proxyProtocol` in Traefik at the same time. PROXY protocol only works when the receiving software parses the header, so enable it on both sides together or not at all.

3. **Install Traefik** (chart 41.6.1 ships Traefik v3.7.13; check the chart index for newer releases):
   ```bash
   helm install traefik traefik/traefik \
     --namespace traefik \
     --create-namespace \
     --version 41.6.1 \
     -f traefik-values.yaml
   ```

4. **Verify:**
   ```bash
   kubectl -n traefik get pods
   kubectl -n traefik get svc traefik
   ```

### [Argo CD Deployment Example](#argocd-deployment-example)

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: traefik
  namespace: argocd
spec:
  destination:
    namespace: traefik
    server: https://kubernetes.default.svc
  project: cluster-services
  source:
    repoURL: https://traefik.github.io/charts
    chart: traefik
    targetRevision: 41.6.1
    helm:
      valuesObject:
        deployment:
          replicas: 3
        podDisruptionBudget:
          enabled: true
          maxUnavailable: 1
        ingressClass:
          enabled: true
          isDefaultClass: true
          name: traefik
        service:
          annotations:
            service.beta.kubernetes.io/do-loadbalancer-type: "REGIONAL"
            service.beta.kubernetes.io/do-loadbalancer-size-unit: "1"
        metrics:
          prometheus:
            serviceMonitor:
              enabled: true
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    retry:
      limit: 3
      backoff:
        duration: 30s
        factor: 2
        maxDuration: 5m
    syncOptions:
      - CreateNamespace=true
```

#### Key Features in the Configuration
- **Load Balancer:** An HTTP (`REGIONAL`) DigitalOcean Load Balancer with one size unit. Raise `do-loadbalancer-size-unit` (1 to 200) for more capacity.
- **Replicas and PDB:** Three Traefik replicas with a PodDisruptionBudget.
- **Prometheus Metrics:** Creates a ServiceMonitor (requires the Prometheus Operator CRDs).
- **Retry backoff:** Starts at 30 seconds and doubles up to 5 minutes. (`duration` must be shorter than `maxDuration`.)

---

### [Useful Load Balancer Annotations](#using-annotations-to-customize-the-load-balancer)

Set these on the Traefik Service through `service.annotations` in the chart values. All come from the [DOKS load balancer guide](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/):

| Annotation | Purpose |
|---|---|
| `service.beta.kubernetes.io/do-loadbalancer-type` | `REGIONAL` (HTTP) or `REGIONAL_NETWORK` (network, the default since 1.33.1-do.0) |
| `service.beta.kubernetes.io/do-loadbalancer-enable-proxy-protocol` | Send the PROXY header; HTTP (`REGIONAL`) load balancers only |
| `service.beta.kubernetes.io/do-loadbalancer-size-unit` | Capacity, 1 to 200 |
| `service.beta.kubernetes.io/do-loadbalancer-hostname` | Works around the hairpin problem where pods cannot reach the load balancer by IP; create the DNS record first |
| `service.beta.kubernetes.io/do-loadbalancer-certificate-id` | Terminate TLS at the load balancer with a DigitalOcean certificate (use with `do-loadbalancer-protocol: "https"`) |
| `service.beta.kubernetes.io/do-loadbalancer-tls-passthrough` | Pass TLS through to Traefik |

Sticky sessions (`do-loadbalancer-sticky-sessions-type: "cookies"`) pin clients to nodes, not pods, and require `externalTrafficPolicy: Local`. With an ingress controller in front of your apps, configure stickiness in Traefik instead.

Health check overrides need `service.beta.kubernetes.io/do-loadbalancer-override-health-check: "true"` before the port, path, or protocol annotations take effect, and DigitalOcean recommends leaving health checks at their defaults unless you have a reason. Traefik's health endpoint is `/ping`, not the `/healthz` path ingress-nginx used.

---

### [Migrating from Ingress NGINX](#migrating-from-ingress-nginx)

1. Inventory annotations: `kubectl get ingress -A -o yaml | grep nginx.ingress.kubernetes.io | sort | uniq -c`.
2. Check them against the [Traefik Ingress NGINX provider](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-ingress-nginx/), or convert to Gateway API with [ingress2gateway](https://github.com/kubernetes-sigs/ingress2gateway).
3. Install the new path next to ingress-nginx with its own load balancer, test each host with `curl --resolve`, then move DNS.
4. Remove ingress-nginx and its load balancer.

---

### [References](#references)
- [Kubernetes: Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- [DOKS: Use Gateway API](https://docs.digitalocean.com/products/kubernetes/how-to/use-gateway-api/)
- [DOKS: Configure load balancers](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/)
- [DOKS supported releases](https://docs.digitalocean.com/products/kubernetes/details/supported-releases/)
- [DigitalOcean Cloud Controller Manager service examples](https://github.com/digitalocean/digitalocean-cloud-controller-manager/tree/master/docs/controllers/services/examples)
- [Traefik documentation](https://doc.traefik.io/traefik/)
