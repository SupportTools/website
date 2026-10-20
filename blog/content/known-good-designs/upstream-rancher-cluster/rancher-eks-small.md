---
title: "Rancher on Small EKS Cluster"
date: 2024-12-17T00:00:00-05:00
draft: false
tags: ["Known Good Designs", "Upstream Rancher Cluster", "EKS", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Upstream Rancher Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy a small EKS cluster with Rancher using Terraform and Helm."
more_link: "yes"
url: "/known-good-designs/upstream-rancher-cluster/rancher-eks-small/"
---

This guide demonstrates how to deploy a small EKS cluster with Rancher installed, using Terraform for infrastructure provisioning and Helm for application deployment.

<!--more-->

## [Overview](#overview)

### [Small EKS Cluster for Rancher](#small-eks-cluster-for-rancher)
This configuration deploys a lightweight Amazon EKS cluster consisting of two `c8g.xlarge` nodes, the NGINX ingress controller, and Rancher as the Kubernetes management platform. This setup is ideal for development and testing environments.

---

## [Terraform Script](#terraform-script)

#### Infrastructure Provisioning
The following Terraform script provisions the EKS cluster:

```terraform
provider "aws" {
  region = "us-west-2"
}

module "eks" {
  source          = "terraform-aws-modules/eks/aws"
  cluster_name    = "rancher-eks-small"
  cluster_version = "1.27"
  subnets         = ["subnet-abc123", "subnet-def456"] # Replace with your subnet IDs
  vpc_id          = "vpc-123456" # Replace with your VPC ID

  node_groups = {
    rancher = {
      desired_capacity = 2
      max_capacity     = 3
      min_capacity     = 2

      instance_type = "c8g.xlarge"
    }
  }
}
```

---

## [Ingress NGINX Deployment](#ingress-nginx-deployment)

Deploy the NGINX ingress controller using Helm:

#### Create the Namespace
```yaml
resource "kubernetes_namespace" "ingress_nginx" {
  metadata {
    name = "ingress-nginx"
  }
}
```

#### Helm Chart Deployment
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
    name  = "controller.service.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-backend-protocol"
    value = "HTTP"
  }

  set {
    name  = "controller.service.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-ssl-ports"
    value = "443"
  }

  set {
    name  = "controller.service.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-ssl-cert"
    value = "arn:aws:acm:region:account-id:certificate/certificate-id" # Replace with your ACM cert ARN
  }
}
```

---

## [Rancher Deployment](#rancher-deployment)

#### Create the Namespace
```yaml
resource "kubernetes_namespace" "cattle_system" {
  metadata {
    name = "cattle-system"
  }
}
```

#### Helm Chart Deployment
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

## [Testing and Validation](#testing-and-validation)

#### Accessing Rancher
1. Once the Helm installation is complete, verify the Rancher pods:
   ```bash
   kubectl get pods -n cattle-system
   ```

2. Access Rancher via the hostname you specified:
   ```
   https://rancher.your-domain.com
   ```

#### Testing NGINX Ingress
Deploy a sample application and verify ingress access using the LoadBalancer endpoint.

---

## [References](#references)
- [Terraform AWS EKS Module Documentation](https://github.com/terraform-aws-modules/terraform-aws-eks)
- [Ingress NGINX Documentation](https://kubernetes.github.io/ingress-nginx/)
- [Rancher Helm Chart Documentation](https://rancher.com/docs/rancher/v2.7/en/installation/helm-chart-install/)
