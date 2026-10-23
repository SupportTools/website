---
title: "Ingress NGINX Controller on EKS: Retirement and Migrating to Traefik"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Load Balancers", "Ingress NGINX", "Traefik", "Gateway API", "EKS", "Amazon"]
categories:
- Known Good Designs
- Load Balancers
author: "Matthew Mattox - mmattox@support.tools"
description: "Ingress on Amazon EKS after the Ingress NGINX retirement: Traefik behind an AWS Load Balancer Controller NLB, Helm and Argo CD examples, and the correct load balancer annotations."
more_link: "yes"
url: "/known-good-designs/loadbalancers/ingress-nginx-controller-on-eks/"
---

![NGINX Architecture for EKS](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-eks/arch_nginx-for_eks.png)

This page used to describe Ingress NGINX on Amazon EKS. Ingress NGINX is now retired, so the known good design for a self-managed ingress controller on EKS is Traefik behind a Network Load Balancer created by the AWS Load Balancer Controller.

<!--more-->

## [Overview](#overview)

### [Ingress NGINX Is Retired](#ingress-nginx-is-retired)

Kubernetes SIG Network and the Security Response Committee retired Ingress NGINX in March 2026. There are no further releases, bug fixes, or security patches, and the repositories are read-only ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/), [Steering and SRC statement](https://kubernetes.io/blog/2026/01/29/ingress-nginx-statement/)). They recommend migrating to Gateway API or to another Ingress controller. Clusters still running it should plan a migration rather than a fresh install.

Rancher's own [Rancher on EKS guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster/rancher-on-amazon-eks) now uses Traefik and calls it the recommended migration path for Rancher environments, which is why this design uses it too.

### [Options on EKS](#options-on-eks)

| Option | When to use it |
|---|---|
| Traefik behind an NLB (this page) | One controller for many Ingresses, Gateway API support, portable across clusters |
| AWS Load Balancer Controller Ingress (ALB) | You want AWS-managed layer 7 with ACM certificates and WAF, one ALB per Ingress group |
| Another Ingress or Gateway API implementation | See the [Kubernetes ingress controllers list](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/) and [Gateway API implementations](https://gateway-api.sigs.k8s.io/guides/) |

Rancher's EKS guide advises against adding Traefik if you already use a managed ingress controller such as the ALB ingress.

---

![Design of NGINX Ingress Controller on EKS](https://cdn.support.tools/known-good-designs/load-balancers/ingress-nginx-controller-on-eks/design-of-NGINX-Ingress-Controller-on-EKS.png)

The diagram shows the original NGINX layout. The Traefik design has the same shape: an NLB in front, controller pods inside the cluster.

---

### [AWS Load Balancer Behavior](#aws-load-balancer-behavior)

From the [EKS network load balancing guide](https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html):

- A Service of `type: LoadBalancer` handled by the legacy AWS cloud provider controller gets a **Classic Load Balancer** by default. That controller only receives critical bug fixes.
- AWS recommends the **AWS Load Balancer Controller** (v2.7.2 or later) instead. It creates **Network Load Balancers** for Services and **Application Load Balancers** for Ingress objects. It never creates Classic Load Balancers.
- The annotation `service.beta.kubernetes.io/aws-load-balancer-type: "external"` hands the Service to the AWS Load Balancer Controller.
- NLBs are created `internal` by default. Add `service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"` for a public endpoint.
- `aws-load-balancer-nlb-target-type: "ip"` registers pod IPs directly (requires the Amazon VPC CNI); `instance` registers nodes and their NodePorts.
- Do not edit these annotations after the Service is created. Delete and recreate the Service instead.

An ALB is never created for a `type: LoadBalancer` Service. ALBs come only from Ingress objects handled by the AWS Load Balancer Controller.

On EKS Auto Mode, load balancing is built in; see the Auto Mode pages linked from the same AWS guide.

---

### [Helm Deployment Example](#helm-deployment-example)

Prerequisite: the [AWS Load Balancer Controller](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html) is installed, and public subnets are tagged `kubernetes.io/role/elb=1`.

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
       service.beta.kubernetes.io/aws-load-balancer-type: "external"
       service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
       service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
   ports:
     web:
       http:
         redirections:
           entryPoint:
             to: websecure
             scheme: https
             permanent: true
   ```

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

The `EXTERNAL-IP` column shows the NLB DNS name, for example `k8s-traefik-traefik-xxxxxxxxxx.elb.us-west-2.amazonaws.com`. Point your DNS records at it.

TLS is terminated by Traefik, with certificates from [cert-manager](/known-good-designs/cluster-services/cert-manager/) (use `ingressClassName: traefik` in the HTTP-01 solver). If you need ACM certificates, terminate at an ALB through the AWS Load Balancer Controller Ingress instead.

---

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
            service.beta.kubernetes.io/aws-load-balancer-type: "external"
            service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
            service.beta.kubernetes.io/aws-load-balancer-scheme: "internet-facing"
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
- **Network Load Balancer:** The AWS Load Balancer Controller creates an internet-facing NLB with IP targets.
- **Replicas and PDB:** Three Traefik replicas with a PodDisruptionBudget keep ingress available during node drains.
- **Prometheus Metrics:** Creates a ServiceMonitor (requires the Prometheus Operator CRDs).
- **Retry backoff:** Starts at 30 seconds and doubles up to 5 minutes. (`duration` must be shorter than `maxDuration`.)

---

### [Gateway API](#gateway-api)

Gateway API is the replacement the Kubernetes project points to. Traefik implements it through its Kubernetes Gateway provider: set `providers.kubernetesGateway.enabled: true` in the values, and the chart creates a GatewayClass and a default Gateway. See the [Traefik Gateway provider docs](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-gateway/) and use [ingress2gateway](https://github.com/kubernetes-sigs/ingress2gateway) to convert existing Ingress objects.

---

### [Migrating from Ingress NGINX](#migrating-from-ingress-nginx)

1. Inventory annotations: `kubectl get ingress -A -o yaml | grep nginx.ingress.kubernetes.io | sort | uniq -c`.
2. Check them against the [Traefik Ingress NGINX provider](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-ingress-nginx/), which serves Ingresses whose IngressClass uses the `k8s.io/ingress-nginx` controller and supports many, but not all, NGINX annotations. Snippet annotations are the usual blockers.
3. Install Traefik next to ingress-nginx with its own NLB, test each host against the new NLB with `curl --resolve`, then move DNS.
4. Remove ingress-nginx and its load balancer once traffic has drained.

---

### [References](#references)
- [Kubernetes: Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- [Rancher on Amazon EKS](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster/rancher-on-amazon-eks)
- [EKS: Route TCP and UDP traffic with Network Load Balancers](https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html)
- [AWS Load Balancer Controller service annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/)
- [Traefik documentation](https://doc.traefik.io/traefik/)
- [Gateway API guides](https://gateway-api.sigs.k8s.io/guides/)
