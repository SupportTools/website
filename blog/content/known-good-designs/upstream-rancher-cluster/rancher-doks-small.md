---
title: "Rancher on Small DOKS Cluster"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Upstream Rancher Cluster", "DOKS", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Upstream Rancher Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy Rancher on a small three-node DigitalOcean Kubernetes (DOKS) lab cluster with Terraform and Helm, using Traefik and cert-manager."
more_link: "yes"
url: "/known-good-designs/upstream-rancher-cluster/rancher-doks-small/"
---

This guide deploys Rancher on a small DigitalOcean Kubernetes Service (DOKS) cluster, using Terraform for the cluster and Helm for Traefik, cert-manager, and Rancher.

<!--more-->

## [Overview](#overview)

### [Small DOKS Cluster for Rancher](#small-doks-cluster-for-rancher)

The design is a three-node DOKS cluster with Traefik as the ingress controller, cert-manager, and Rancher.

**Support status:** DOKS is not a certified platform for the Rancher management cluster. The [Rancher v2.15.2 support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/rancher-v2-15-2/) certifies RKE2, K3s, EKS, AKS, GKE, and ACK (each at Kubernetes 1.34 to 1.36). Rancher installs on any conformant cluster, so this design works for development, labs, and testing. For a supported production install, use [Rancher on RKE2](/known-good-designs/upstream-rancher-cluster/rancher-rke2-small/) or [Rancher on EKS](/known-good-designs/upstream-rancher-cluster/rancher-eks-small/).

- **Three nodes:** The [Rancher installation requirements](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/installation-requirements) call for at least three nodes for high availability, and the Rancher chart runs three replicas by default.
- **Node size:** The hosted Kubernetes table sizes each node at 4 vCPUs and 16 GB RAM for a small install. This design uses the `g-4vcpu-16gb` Droplet size. Confirm the slug is offered in your region with `doctl kubernetes options sizes`.
- **Kubernetes version:** DOKS supports 1.34, 1.35, 1.36, and 1.37 at the time of writing ([DOKS supported releases](https://docs.digitalocean.com/products/kubernetes/details/supported-releases/)). Rancher v2.15.2 accepts Kubernetes below 1.37, so use 1.35 or 1.36.
- **Ingress:** Ingress NGINX was retired in March 2026 ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)). Rancher's chart creates an Ingress, so this design uses Traefik rather than the DOKS built-in Gateway API.

---

## [Terraform Script](#terraform-script)

### Infrastructure Provisioning

This uses the [`digitalocean_kubernetes_cluster`](https://registry.terraform.io/providers/digitalocean/digitalocean/latest/docs/resources/kubernetes_cluster) resource from the official DigitalOcean provider.

```hcl
terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

provider "digitalocean" {
  token = var.digitalocean_token # Your DigitalOcean API token
}

data "digitalocean_kubernetes_versions" "rancher" {
  version_prefix = "1.35."
}

resource "digitalocean_kubernetes_cluster" "rancher" {
  name    = "rancher-doks-small"
  region  = "nyc3"
  version = data.digitalocean_kubernetes_versions.rancher.latest_version
  ha      = true # Highly available DOKS control plane

  node_pool {
    name       = "rancher"
    size       = "g-4vcpu-16gb"
    node_count = 3
  }
}
```

Save the kubeconfig for the Helm steps:

```bash
doctl kubernetes cluster kubeconfig save rancher-doks-small
kubectl get nodes
```

---

## [Traefik Deployment](#traefik-deployment)

```hcl
resource "helm_release" "traefik" {
  name             = "traefik"
  namespace        = "traefik"
  create_namespace = true
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = "41.6.1"

  values = [yamlencode({
    deployment          = { replicas = 3 }
    podDisruptionBudget = { enabled = true, maxUnavailable = 1 }
    ingressClass        = { enabled = true, isDefaultClass = true, name = "traefik" }
    service = {
      annotations = {
        "service.beta.kubernetes.io/do-loadbalancer-size-unit" = "1"
      }
    }
  })]
}
```

The DigitalOcean cloud controller creates a load balancer for the Traefik Service. Since DOKS 1.33.1-do.0 that is a network (`REGIONAL_NETWORK`) load balancer by default, which passes TCP straight to Traefik, so Traefik terminates TLS with the certificate cert-manager issues. See [Ingress on DOKS](/known-good-designs/loadbalancers/ingress-nginx-controller-on-doks/) for annotations such as PROXY protocol, which needs the HTTP (`REGIONAL`) type.

---

## [cert-manager Deployment](#cert-manager-deployment)

Rancher-generated and Let's Encrypt certificates both need cert-manager. v1.21.2 is current; the [cert-manager releases page](https://cert-manager.io/docs/releases/) lists 1.21 and 1.20 as supported.

```hcl
resource "helm_release" "cert_manager" {
  name             = "cert-manager"
  namespace        = "cert-manager"
  create_namespace = true
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = "v1.21.2"

  values = [yamlencode({
    crds = { enabled = true }
  })]
}
```

---

## [Rancher Deployment](#rancher-deployment)

```hcl
resource "helm_release" "rancher" {
  name             = "rancher"
  namespace        = "cattle-system"
  create_namespace = true
  repository       = "https://releases.rancher.com/server-charts/stable"
  chart            = "rancher"
  version          = "2.15.2"

  values = [yamlencode({
    hostname          = "rancher.your-domain.com" # Replace with your hostname
    bootstrapPassword = "change-me-unique"        # Replace with a unique password
    ingress = {
      ingressClassName = "traefik"
      tls              = { source = "letsEncrypt" }
    }
    letsEncrypt = {
      email       = "admin@your-domain.com" # Replace with your email
      environment = "production"
      ingress     = { class = "traefik" }
    }
  })]

  depends_on = [helm_release.cert_manager, helm_release.traefik]
}
```

- Use the `stable` repository for anything long-lived. The previous version of this page pinned Rancher 2.7.0 from the `latest` repository; that release predates every Kubernetes version DOKS still offers.
- `letsEncrypt.ingress.class` must match the ingress controller (`traefik` here). With the old `nginx` value, HTTP-01 challenges are never answered on a Traefik cluster.
- Point the hostname's DNS record at the load balancer IP (`kubectl -n traefik get svc traefik`) before Let's Encrypt runs the HTTP-01 challenge.
- Keep `bootstrapPassword` out of version control.

---

## [Testing and Validation](#testing-and-validation)

### Accessing Rancher
1. Verify Rancher and its certificate:
   ```bash
   kubectl -n cattle-system rollout status deploy/rancher
   kubectl -n cattle-system get ingress,certificate
   ```

2. Access Rancher via the hostname you specified:
   ```
   https://rancher.your-domain.com
   ```

### Testing Traefik
Deploy a sample application with an Ingress that sets `ingressClassName: traefik` and confirm it answers through the load balancer IP.

---

## [References](#references)
- [DigitalOcean Terraform provider: kubernetes_cluster](https://registry.terraform.io/providers/digitalocean/digitalocean/latest/docs/resources/kubernetes_cluster)
- [DOKS: Configure load balancers](https://docs.digitalocean.com/products/kubernetes/how-to/configure-load-balancers/)
- [Rancher installation requirements](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/installation-requirements)
- [Rancher Helm install guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster)
- [SUSE Rancher v2.15.2 support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/rancher-v2-15-2/)
- [cert-manager Helm installation](https://cert-manager.io/docs/installation/helm/)
