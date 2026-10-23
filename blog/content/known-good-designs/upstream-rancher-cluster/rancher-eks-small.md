---
title: "Rancher on Small EKS Cluster"
date: 2024-12-17T00:00:00-05:00
lastmod: 2026-10-23
draft: false
tags: ["Known Good Designs", "Upstream Rancher Cluster", "EKS", "Rancher", "Kubernetes"]
categories:
- Known Good Designs
- Upstream Rancher Cluster
author: "Matthew Mattox - mmattox@support.tools"
description: "Deploy Rancher on a small three-node Amazon EKS cluster with Terraform and Helm, using Traefik behind an NLB and cert-manager."
more_link: "yes"
url: "/known-good-designs/upstream-rancher-cluster/rancher-eks-small/"
---

This guide deploys Rancher on a small Amazon EKS cluster, using Terraform for the infrastructure and Helm for Traefik, cert-manager, and Rancher.

<!--more-->

## [Overview](#overview)

### [Small EKS Cluster for Rancher](#small-eks-cluster-for-rancher)

The design is a three-node EKS managed node group spread across three availability zones, Traefik as the ingress controller behind a Network Load Balancer, cert-manager, and Rancher.

- **Three nodes:** The [Rancher installation requirements](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/installation-requirements) say a highly available setup with at least three nodes is required for production, and Rancher's [EKS guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster/rancher-on-amazon-eks) creates a three-node group. Rancher runs three replicas by default.
- **Node size:** For hosted Kubernetes, the requirements table sizes each node at 4 vCPUs and 16 GB RAM for a small install (up to 150 managed clusters and 1500 nodes), 8 vCPUs and 32 GB for medium, and 16 vCPUs and 64 GB for large. This design uses `m8g.xlarge` (4 vCPU, 16 GiB, Graviton). Rancher supports x86_64 and ARM64 nodes; use `m7i.xlarge` if you prefer x86_64.
- **Kubernetes version:** The [Rancher v2.15.2 support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/rancher-v2-15-2/) certifies EKS 1.34 through 1.36 for the Rancher management cluster. Pick a version from that range that EKS still offers in standard support.
- **Ingress:** The Kubernetes Ingress NGINX project was retired in March 2026 ([announcement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)). Rancher's EKS guide now uses Traefik.

---

## [Terraform Script](#terraform-script)

### Infrastructure Provisioning

This uses the [terraform-aws-modules EKS module](https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest) v21 syntax. Bring an existing VPC with private subnets in three availability zones, tagged for load balancers (`kubernetes.io/role/elb=1` on public subnets, `kubernetes.io/role/internal-elb=1` on private subnets).

```hcl
provider "aws" {
  region = "us-west-2"
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 21.0"

  name               = "rancher-eks-small"
  kubernetes_version = "1.35"

  endpoint_public_access                   = true
  enable_cluster_creator_admin_permissions = true

  addons = {
    coredns                = {}
    eks-pod-identity-agent = { before_compute = true }
    kube-proxy             = {}
    vpc-cni                = { before_compute = true }
  }

  vpc_id     = "vpc-123456"                                        # Replace with your VPC ID
  subnet_ids = ["subnet-abc123", "subnet-def456", "subnet-ghi789"] # Private subnets in 3 AZs

  eks_managed_node_groups = {
    rancher = {
      ami_type       = "AL2023_ARM_64_STANDARD"
      instance_types = ["m8g.xlarge"]

      min_size     = 3
      max_size     = 4
      desired_size = 3
    }
  }
}
```

After `terraform apply`, configure kubectl:

```bash
aws eks update-kubeconfig --region us-west-2 --name rancher-eks-small
kubectl get nodes
```

---

## [AWS Load Balancer Controller](#aws-load-balancer-controller)

AWS recommends the [AWS Load Balancer Controller](https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html) (v2.7.2 or later) for Services of `type: LoadBalancer`; the legacy in-tree controller creates Classic Load Balancers by default and only receives critical fixes ([EKS NLB guide](https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html)). Install it following the AWS guide before installing Traefik.

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
        "service.beta.kubernetes.io/aws-load-balancer-type"            = "external"
        "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type" = "ip"
        "service.beta.kubernetes.io/aws-load-balancer-scheme"          = "internet-facing"
      }
    }
  })]
}
```

The annotations make the AWS Load Balancer Controller create an internet-facing NLB with pod IP targets. TLS terminates in Traefik with the certificate cert-manager issues for Rancher. See [Ingress on EKS](/known-good-designs/loadbalancers/ingress-nginx-controller-on-eks/) for details.

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

- The `stable` repository is the one Rancher recommends for production. v2.15.2 is the current stable chart and supports Kubernetes below 1.37.
- `ingress.ingressClassName=traefik` is the setting Rancher's EKS guide uses. `letsEncrypt.ingress.class` must match the ingress controller; Rancher lists `traefik` and `nginx`.
- Create a DNS record for the hostname that points at the NLB name from `kubectl -n traefik get svc traefik` before Let's Encrypt tries the HTTP-01 challenge.
- Keep `bootstrapPassword` out of version control (use a variable marked `sensitive`).

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
Confirm the NLB has healthy targets in the EC2 console (**Target Groups**), then deploy a sample application with an Ingress that sets `ingressClassName: traefik`.

---

## [References](#references)
- [Rancher on Amazon EKS](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster/rancher-on-amazon-eks)
- [Rancher installation requirements](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/installation-requirements)
- [Rancher Helm install guide](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster)
- [SUSE Rancher v2.15.2 support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/rancher-v2-15-2/)
- [Terraform AWS EKS module](https://registry.terraform.io/modules/terraform-aws-modules/eks/aws/latest)
- [EKS: Network Load Balancers](https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html)
- [cert-manager Helm installation](https://cert-manager.io/docs/installation/helm/)
