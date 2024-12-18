---
title: "Rancher on Small DOKS Cluster"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Upstream Rancher Cluster", "DOKS", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Upstream Rancher Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy a small DOKS cluster with Rancher using Terraform and Helm."
more_link: "yes"
url: "/known-good-designs/upstream-rancher-cluster/rancher-doks-small/"
---

This guide demonstrates how to deploy a small DOKS (DigitalOcean Kubernetes Service) cluster with Rancher installed, using Terraform for infrastructure provisioning and Helm for application deployment.

<!--more-->

# [Overview](#overview)

## [Small DOKS Cluster for Rancher](#small-doks-cluster-for-rancher)
This configuration deploys a lightweight DigitalOcean Kubernetes cluster consisting of two nodes, the NGINX ingress controller, and Rancher as the Kubernetes management platform. This setup is ideal for development and testing environments.

---

# [Terraform Script](#terraform-script)

### Infrastructure Provisioning
The following Terraform script provisions the DOKS cluster:

```terraform
provider "digitalocean" {
  token = "${var.digitalocean_token}" # Replace with your DigitalOcean API token
}

module "kubernetes" {
  source         = "terraform-digitalocean-modules/kubernetes/digitalocean"
  cluster_name   = "rancher-doks-small"
  region         = "nyc3"
  version        = "1.27"
  node_pool_size = 2
  node_pool_type = "s-4vcpu-8gb"
}
```

---

# [Ingress NGINX Deployment](#ingress-nginx-deployment)

Deploy the NGINX ingress controller using Helm:

### Create the Namespace
```yaml
resource "kubernetes_namespace" "ingress_nginx" {
  metadata {
    name = "ingress-nginx"
  }
}
```

### Helm Chart Deployment
```yaml
resource "helm_release" "nginx_ingress" {
  name       = "ingress-nginx"
  namespace  = kubernetes_namespace.ingress_nginx.metadata[0].name
  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  version    = "4.10.1"

  set {
    name  = "controller.service.type"
    value = "LoadBalancer"
  }

  set {
    name  = "controller.service.annotations.service\.beta\.kubernetes\.io/do-loadbalancer-sticky-sessions-type"
    value = "cookies"
  }

  set {
    name  = "controller.service.annotations.service\.beta\.kubernetes\.io/do-loadbalancer-protocol"
    value = "http"
  }

  set {
    name  = "controller.service.annotations.service\.beta\.kubernetes\.io/do-loadbalancer-healthcheck-path"
    value = "/healthz"
  }
}
```

---

# [Rancher Deployment](#rancher-deployment)

### Create the Namespace
```yaml
resource "kubernetes_namespace" "cattle_system" {
  metadata {
    name = "cattle-system"
  }
}
```

### Helm Chart Deployment
```yaml
resource "helm_release" "rancher" {
  name       = "rancher"
  namespace  = kubernetes_namespace.cattle_system.metadata[0].name
  repository = "https://releases.rancher.com/server-charts/latest"
  chart      = "rancher"
  version    = "2.7.0"

  set {
    name  = "hostname"
    value = "rancher.your-domain.com" # Replace with your hostname
  }

  set {
    name  = "ingress.tls.source"
    value = "letsEncrypt"
  }

  set {
    name  = "letsEncrypt.email"
    value = "admin@your-domain.com" # Replace with your email
  }

  set {
    name  = "letsEncrypt.environment"
    value = "production"
  }
}
```

---

# [Testing and Validation](#testing-and-validation)

### Accessing Rancher
1. Once the Helm installation is complete, verify the Rancher pods:
   ```bash
   kubectl get pods -n cattle-system
   ```

2. Access Rancher via the hostname you specified:
   ```
   https://rancher.your-domain.com
   ```

### Testing NGINX Ingress
Deploy a sample application and verify ingress access using the LoadBalancer endpoint.

---

# [References](#references)
- [Terraform DigitalOcean Kubernetes Module Documentation](https://github.com/terraform-digitalocean-modules/terraform-digitalocean-kubernetes)
- [Ingress NGINX Documentation](https://kubernetes.github.io/ingress-nginx/)
- [Rancher Helm Chart Documentation](https://rancher.com/docs/rancher/v2.7/en/installation/helm-chart-install/)
