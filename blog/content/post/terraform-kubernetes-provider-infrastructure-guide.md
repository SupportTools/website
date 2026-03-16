---
title: "Terraform Kubernetes Provider: Managing Cluster Resources as Infrastructure Code"
date: 2027-04-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Terraform", "Infrastructure as Code", "HashiCorp", "GitOps"]
categories: ["Kubernetes", "Infrastructure as Code", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Terraform Kubernetes provider for managing cluster resources, covering namespace provisioning, RBAC configuration, ConfigMaps, Secrets, and CRD management with Terraform, remote state backends, module patterns, and integration with Atlantis for PR-based workflows."
more_link: "yes"
url: "/terraform-kubernetes-provider-infrastructure-guide/"
---

Managing Kubernetes cluster resources with Terraform gives operations teams a single workflow for both cloud infrastructure and in-cluster objects. Rather than maintaining separate kubectl manifests, Helm charts, and Kustomize overlays with no audit trail, Terraform treats namespaces, RBAC bindings, ConfigMaps, and custom resources as first-class infrastructure state. Every change goes through `plan`, every drift is detectable, and every resource lifecycle is tracked in a versioned state file.

This guide covers the full operational picture: provider authentication patterns for EKS, GKE, and self-managed clusters; namespace and RBAC management; ConfigMap and Secret provisioning; CRD-based resources with `kubernetes_manifest`; Helm chart deployment; module patterns for cluster bootstrapping; and PR-based workflows with Atlantis.

<!--more-->

## Provider Configuration Patterns

### In-Cluster vs Kubeconfig Authentication

The Kubernetes provider supports three primary authentication methods. Choosing the right one depends on where Terraform runs and what cluster platform is in use.

```hcl
# terraform/providers.tf

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.13"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }

  backend "s3" {
    bucket         = "acme-terraform-state-prod"
    key            = "clusters/prod-us-east-1/kubernetes/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "acme-terraform-locks"
    encrypt        = true
  }
}

# Pattern 1: kubeconfig file (local dev, CI with KUBECONFIG env)
provider "kubernetes" {
  config_path    = pathexpand("~/.kube/config")
  config_context = "prod-us-east-1"
}

# Pattern 2: EKS via data source (recommended for AWS)
data "aws_eks_cluster" "main" {
  name = var.cluster_name
}

data "aws_eks_cluster_auth" "main" {
  name = var.cluster_name
}

provider "kubernetes" {
  host                   = data.aws_eks_cluster.main.endpoint
  cluster_ca_certificate = base64decode(data.aws_eks_cluster.main.certificate_authority[0].data)
  token                  = data.aws_eks_cluster_auth.main.token
}

provider "helm" {
  kubernetes {
    host                   = data.aws_eks_cluster.main.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.main.certificate_authority[0].data)
    token                  = data.aws_eks_cluster_auth.main.token
  }
}
```

```hcl
# terraform/providers_gke.tf — GKE authentication pattern

data "google_container_cluster" "main" {
  name     = var.cluster_name
  location = var.cluster_location
  project  = var.project_id
}

data "google_client_config" "default" {}

provider "kubernetes" {
  host                   = "https://${data.google_container_cluster.main.endpoint}"
  cluster_ca_certificate = base64decode(data.google_container_cluster.main.master_auth[0].cluster_ca_certificate)
  token                  = data.google_client_config.default.access_token
}
```

### Provider Version Pinning and Upgrade Patterns

```hcl
# terraform/versions.tf — lock files and version constraints

# Always pin to a minor version range, never use >= without upper bound
# kubernetes 2.x has breaking changes from 1.x in resource naming
terraform {
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.27.0, < 3.0.0"
    }
  }
}

# Upgrade workflow:
# 1. Update version constraint
# 2. Run: terraform init -upgrade
# 3. Review .terraform.lock.hcl diff in PR
# 4. Run: terraform plan — check for unexpected resource changes
# 5. Merge and apply in non-prod first
```

## Remote State Backend Configuration

```hcl
# terraform/backend.tf — S3 backend with DynamoDB locking

# S3 backend requires the bucket and DynamoDB table to exist before init
# Bootstrap with a separate Terraform configuration or Terraform Cloud

terraform {
  backend "s3" {
    bucket = "acme-terraform-state-prod"
    # Key structure: environment/component/terraform.tfstate
    key    = "prod-us-east-1/k8s-resources/terraform.tfstate"
    region = "us-east-1"

    # DynamoDB table for state locking — prevents concurrent applies
    dynamodb_table = "acme-terraform-locks"

    # Always encrypt state — it contains sensitive resource attributes
    encrypt = true

    # Use workspace-prefixed state for multi-environment support
    workspace_key_prefix = "workspaces"
  }
}
```

```hcl
# terraform/state_bootstrap/main.tf — Bootstrap the backend resources
# Run this once before any other Terraform configuration

resource "aws_s3_bucket" "terraform_state" {
  bucket = "acme-terraform-state-prod"

  # Prevent accidental deletion of state files
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
      # Use a CMK for additional control over key rotation
      kms_master_key_id = aws_kms_key.terraform_state.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = "acme-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "terraform_state" {
  description             = "KMS key for Terraform state encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}
```

## Namespace Provisioning

### Namespace Resources with Labels and Annotations

```hcl
# modules/namespace/main.tf

variable "name" {
  type        = string
  description = "Namespace name"
}

variable "labels" {
  type        = map(string)
  description = "Additional labels to apply"
  default     = {}
}

variable "annotations" {
  type        = map(string)
  description = "Additional annotations to apply"
  default     = {}
}

variable "resource_quota" {
  type = object({
    requests_cpu    = string
    requests_memory = string
    limits_cpu      = string
    limits_memory   = string
    pods            = number
  })
  description = "Resource quota for the namespace"
  default     = null
}

locals {
  # Standard labels applied to all namespaces
  standard_labels = {
    "app.kubernetes.io/managed-by" = "terraform"
    "support.tools/environment"    = var.environment
    "support.tools/team"           = var.team
  }

  merged_labels = merge(local.standard_labels, var.labels)
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name        = var.name
    labels      = local.merged_labels
    annotations = var.annotations
  }

  # Prevent Terraform from deleting the namespace if it contains resources
  lifecycle {
    ignore_changes = [
      # Ignore changes to labels managed by other tools (e.g. OLM)
      metadata[0].labels["olm.operatorgroup.good-labels"],
    ]
  }
}

resource "kubernetes_resource_quota_v1" "this" {
  count = var.resource_quota != null ? 1 : 0

  metadata {
    name      = "${var.name}-quota"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }

  spec {
    hard = {
      "requests.cpu"    = var.resource_quota.requests_cpu
      "requests.memory" = var.resource_quota.requests_memory
      "limits.cpu"      = var.resource_quota.limits_cpu
      "limits.memory"   = var.resource_quota.limits_memory
      "pods"            = tostring(var.resource_quota.pods)
    }
  }
}

resource "kubernetes_limit_range_v1" "this" {
  count = var.resource_quota != null ? 1 : 0

  metadata {
    name      = "${var.name}-limits"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }

  spec {
    limit {
      type = "Container"
      default = {
        # Default limits — pods without explicit limits get these
        cpu    = "500m"
        memory = "256Mi"
      }
      default_request = {
        # Default requests — ensure pods have sensible baseline requests
        cpu    = "100m"
        memory = "128Mi"
      }
    }

    limit {
      type = "Pod"
      max = {
        cpu    = "4"
        memory = "4Gi"
      }
    }
  }
}

output "name" {
  value = kubernetes_namespace_v1.this.metadata[0].name
}
```

```hcl
# environments/prod/namespaces.tf — instantiate namespace module

module "namespace_platform" {
  source = "../../modules/namespace"

  name        = "platform"
  environment = "prod"
  team        = "platform-engineering"

  labels = {
    "support.tools/cost-center" = "engineering"
    "support.tools/tier"        = "critical"
  }

  annotations = {
    # Pod security admission configuration
    "pod-security.kubernetes.io/enforce" = "restricted"
    "pod-security.kubernetes.io/audit"   = "restricted"
    "pod-security.kubernetes.io/warn"    = "restricted"
  }

  resource_quota = {
    requests_cpu    = "20"
    requests_memory = "40Gi"
    limits_cpu      = "40"
    limits_memory   = "80Gi"
    pods            = 200
  }
}

module "namespace_monitoring" {
  source = "../../modules/namespace"

  name        = "monitoring"
  environment = "prod"
  team        = "platform-engineering"

  annotations = {
    "pod-security.kubernetes.io/enforce" = "privileged" # Prometheus node-exporter needs host access
  }

  resource_quota = {
    requests_cpu    = "10"
    requests_memory = "20Gi"
    limits_cpu      = "20"
    limits_memory   = "40Gi"
    pods            = 100
  }
}
```

## RBAC Configuration

### ClusterRole, ClusterRoleBinding, and ServiceAccount

```hcl
# modules/rbac/main.tf — RBAC module for team-based access

variable "team_name" {
  type        = string
  description = "Team identifier for RBAC resources"
}

variable "namespaces" {
  type        = list(string)
  description = "Namespaces the team has access to"
}

variable "cluster_role" {
  type        = string
  description = "Built-in or custom cluster role to bind"
  default     = "edit"
  validation {
    condition     = contains(["view", "edit", "admin", "cluster-admin"], var.cluster_role) || can(regex("^custom-", var.cluster_role))
    error_message = "cluster_role must be a built-in role or start with 'custom-'"
  }
}

# Custom ClusterRole for read-only access to custom resources
resource "kubernetes_cluster_role_v1" "custom_reader" {
  metadata {
    name = "custom-${var.team_name}-reader"
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  # Allow reading all standard resources
  rule {
    api_groups = [""]
    resources  = ["pods", "services", "configmaps", "endpoints", "events"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = ["apps"]
    resources  = ["deployments", "replicasets", "daemonsets", "statefulsets"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = ["networking.k8s.io"]
    resources  = ["ingresses", "networkpolicies"]
    verbs      = ["get", "list", "watch"]
  }

  # Allow reading custom metrics for dashboards
  rule {
    api_groups = ["metrics.k8s.io"]
    resources  = ["pods", "nodes"]
    verbs      = ["get", "list"]
  }
}

# Service account for CI/CD pipeline access
resource "kubernetes_service_account_v1" "ci_deployer" {
  for_each = toset(var.namespaces)

  metadata {
    name      = "${var.team_name}-deployer"
    namespace = each.value
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
      "support.tools/team"           = var.team_name
    }
    annotations = {
      "support.tools/purpose" = "CI/CD pipeline deployments"
    }
  }
}

# Role binding per namespace — prefer RoleBinding over ClusterRoleBinding
resource "kubernetes_role_binding_v1" "ci_deployer" {
  for_each = toset(var.namespaces)

  metadata {
    name      = "${var.team_name}-deployer"
    namespace = each.value
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    # Use the built-in 'edit' role for deployment capabilities
    name = var.cluster_role
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.ci_deployer[each.value].metadata[0].name
    namespace = each.value
  }
}

# ClusterRoleBinding for cluster-wide read access (audit/monitoring)
resource "kubernetes_cluster_role_binding_v1" "team_reader" {
  metadata {
    name = "${var.team_name}-cluster-reader"
    labels = {
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.custom_reader.metadata[0].name
  }

  # Bind to the team's AD group synced via OIDC
  subject {
    kind      = "Group"
    name      = "team:${var.team_name}"
    api_group = "rbac.authorization.k8s.io"
  }
}

# Generate a long-lived token for the service account (Kubernetes 1.24+)
resource "kubernetes_secret_v1" "ci_deployer_token" {
  for_each = toset(var.namespaces)

  metadata {
    name      = "${var.team_name}-deployer-token"
    namespace = each.value
    annotations = {
      # This annotation triggers token generation for the service account
      "kubernetes.io/service-account.name" = kubernetes_service_account_v1.ci_deployer[each.value].metadata[0].name
    }
  }

  type = "kubernetes.io/service-account-token"
}

output "deployer_tokens" {
  description = "Service account tokens by namespace — use for CI/CD kubeconfig"
  sensitive   = true
  value = {
    for ns in var.namespaces :
    ns => kubernetes_secret_v1.ci_deployer_token[ns].data["token"]
  }
}
```

## ConfigMap and Secret Management

### ConfigMaps as Terraform Resources

```hcl
# modules/application_config/configmaps.tf

variable "application_name" {
  type        = string
  description = "Application identifier"
}

variable "namespace" {
  type        = string
  description = "Target namespace"
}

variable "config_data" {
  type        = map(string)
  description = "Key-value configuration data"
  default     = {}
}

variable "config_files" {
  type        = map(string)
  description = "File-like configuration data (e.g., nginx.conf content)"
  default     = {}
}

resource "kubernetes_config_map_v1" "app_config" {
  metadata {
    name      = "${var.application_name}-config"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"       = var.application_name
      "app.kubernetes.io/managed-by" = "terraform"
    }
    # Annotation triggers rolling restart of pods when ConfigMap changes
    annotations = {
      "support.tools/last-modified" = timestamp()
    }
  }

  # Simple key-value pairs become environment variable sources
  data = var.config_data

  # Binary data for non-UTF8 content
  # binary_data = {}
}

resource "kubernetes_config_map_v1" "app_files" {
  count = length(var.config_files) > 0 ? 1 : 0

  metadata {
    name      = "${var.application_name}-files"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"       = var.application_name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  # File content is stored as ConfigMap data with filename as key
  data = var.config_files
}
```

### Secrets with Sensitive Value Handling

```hcl
# modules/application_config/secrets.tf

variable "db_password" {
  type        = string
  description = "Database password"
  sensitive   = true # Marks the variable as sensitive in plan output
}

variable "api_credentials" {
  type = object({
    client_id     = string
    client_secret = string
    token_url     = string
  })
  sensitive = true
}

resource "kubernetes_secret_v1" "database" {
  metadata {
    name      = "${var.application_name}-db-credentials"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"       = var.application_name
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  # Kubernetes encodes secret data as base64 automatically
  # Terraform handles the encoding — pass plain text values
  data = {
    username = "app_${var.application_name}"
    password = var.db_password # sensitive() wrapper applied automatically
    host     = "postgres-rw.database.svc.cluster.local"
    port     = "5432"
    dbname   = var.application_name
    # Connection string for applications that prefer DSN format
    url = sensitive(
      "postgresql://app_${var.application_name}:${var.db_password}@postgres-rw.database.svc.cluster.local:5432/${var.application_name}?sslmode=require"
    )
  }

  type = "Opaque"
}

resource "kubernetes_secret_v1" "api_credentials" {
  metadata {
    name      = "${var.application_name}-api-credentials"
    namespace = var.namespace
  }

  # Use sensitive() for values derived from sensitive inputs
  data = {
    client_id     = sensitive(var.api_credentials.client_id)
    client_secret = sensitive(var.api_credentials.client_secret)
    token_url     = var.api_credentials.token_url # Not sensitive
  }

  type = "Opaque"
}

# Kubernetes TLS secret for ingress
variable "tls_cert" {
  type      = string
  sensitive = true
}

variable "tls_key" {
  type      = string
  sensitive = true
}

resource "kubernetes_secret_v1" "tls" {
  metadata {
    name      = "${var.application_name}-tls"
    namespace = var.namespace
  }

  data = {
    "tls.crt" = var.tls_cert
    "tls.key" = sensitive(var.tls_key)
  }

  type = "kubernetes.io/tls"
}
```

### Reading Secrets from AWS Secrets Manager

```hcl
# modules/application_config/aws_secrets.tf

data "aws_secretsmanager_secret" "db" {
  name = "prod/postgres/${var.application_name}"
}

data "aws_secretsmanager_secret_version" "db" {
  secret_id = data.aws_secretsmanager_secret.db.id
}

locals {
  # Parse JSON secret value into a map
  db_secret = sensitive(
    jsondecode(data.aws_secretsmanager_secret_version.db.secret_string)
  )
}

resource "kubernetes_secret_v1" "database_from_aws" {
  metadata {
    name      = "${var.application_name}-db-credentials"
    namespace = var.namespace
  }

  data = {
    username = local.db_secret["username"]
    password = local.db_secret["password"]
    host     = local.db_secret["host"]
    port     = tostring(local.db_secret["port"])
    dbname   = local.db_secret["dbname"]
  }

  type = "Opaque"
}
```

## Managing CRDs with kubernetes_manifest

### CRD and Custom Resource Management

```hcl
# modules/crds/main.tf — Deploy CRDs and wait for establishment

# kubernetes_manifest is the escape hatch for resources not covered
# by typed Kubernetes provider resources
resource "kubernetes_manifest" "cert_manager_clusterissuer" {
  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"

    metadata = {
      name = "letsencrypt-prod"
    }

    spec = {
      acme = {
        server = "https://acme-v02.api.letsencrypt.org/directory"
        email  = "platform@acme-corp.example.com"

        privateKeySecretRef = {
          name = "letsencrypt-prod-account-key"
        }

        solvers = [
          {
            dns01 = {
              route53 = {
                region       = "us-east-1"
                hostedZoneID = var.route53_zone_id
              }
            }
          }
        ]
      }
    }
  }

  # Wait for cert-manager to process the ClusterIssuer before continuing
  wait {
    fields = {
      "status.conditions[0].type"   = "Ready"
      "status.conditions[0].status" = "True"
    }
  }

  # Terraform needs to know about cert-manager before managing CRs
  depends_on = [helm_release.cert_manager]
}

# Prometheus ServiceMonitor CRD instance
resource "kubernetes_manifest" "service_monitor" {
  manifest = {
    apiVersion = "monitoring.coreos.com/v1"
    kind       = "ServiceMonitor"

    metadata = {
      name      = var.application_name
      namespace = var.namespace
      labels = {
        # Label required by Prometheus operator to discover ServiceMonitors
        "app.kubernetes.io/name" = var.application_name
        "release"                = "prometheus"
      }
    }

    spec = {
      selector = {
        matchLabels = {
          "app.kubernetes.io/name" = var.application_name
        }
      }

      endpoints = [
        {
          port     = "metrics"
          interval = "30s"
          path     = "/metrics"
          scheme   = "http"
        }
      ]
    }
  }
}

# VirtualService for Istio traffic management
resource "kubernetes_manifest" "virtual_service" {
  manifest = {
    apiVersion = "networking.istio.io/v1beta1"
    kind       = "VirtualService"

    metadata = {
      name      = var.application_name
      namespace = var.namespace
    }

    spec = {
      hosts    = [var.application_host]
      gateways = ["istio-system/main-gateway"]

      http = [
        {
          match = [{ uri = { prefix = "/api/" } }]
          route = [
            {
              destination = {
                host   = "${var.application_name}.${var.namespace}.svc.cluster.local"
                port   = { number = 8080 }
                subset = "stable"
              }
              weight = 90
            },
            {
              destination = {
                host   = "${var.application_name}.${var.namespace}.svc.cluster.local"
                port   = { number = 8080 }
                subset = "canary"
              }
              weight = 10
            }
          ]
        }
      ]
    }
  }
}
```

## Helm Provider for Chart Deployment

```hcl
# modules/cluster_addons/cert_manager.tf

resource "helm_release" "cert_manager" {
  name       = "cert-manager"
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  version    = "v1.14.4"
  namespace  = "cert-manager"

  # Create the namespace before deploying the chart
  create_namespace = true

  # Atomic install — roll back automatically on failure
  atomic   = true
  timeout  = 300 # 5 minutes for CRD installation

  # Upgrade waits for all resources to be ready
  wait = true

  values = [
    yamlencode({
      installCRDs = true

      replicaCount = 2

      resources = {
        requests = { cpu = "100m", memory = "128Mi" }
        limits   = { cpu = "500m", memory = "512Mi" }
      }

      podDisruptionBudget = {
        enabled      = true
        minAvailable = 1
      }

      prometheus = {
        enabled = true
        servicemonitor = {
          enabled = true
        }
      }

      # Enable leader election for HA
      global = {
        leaderElection = {
          namespace = "cert-manager"
        }
      }
    })
  ]
}

resource "helm_release" "ingress_nginx" {
  name       = "ingress-nginx"
  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  version    = "4.10.0"
  namespace  = "ingress-nginx"

  create_namespace = true
  atomic           = true
  timeout          = 300

  values = [
    yamlencode({
      controller = {
        replicaCount = 3

        resources = {
          requests = { cpu = "200m", memory = "256Mi" }
          limits   = { cpu = "1", memory = "512Mi" }
        }

        service = {
          type = "LoadBalancer"
          annotations = {
            "service.beta.kubernetes.io/aws-load-balancer-type"            = "nlb"
            "service.beta.kubernetes.io/aws-load-balancer-scheme"          = "internet-facing"
            "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type" = "ip"
          }
        }

        metrics = {
          enabled = true
          serviceMonitor = {
            enabled = true
          }
        }

        config = {
          "use-forwarded-headers"   = "true"
          "compute-full-forwarded-for" = "true"
          "use-proxy-protocol"      = "false"
          # Security headers
          "ssl-protocols"           = "TLSv1.2 TLSv1.3"
          "ssl-ciphers"             = "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256"
        }
      }
    })
  ]
}
```

## Terraform Module Patterns for Cluster Bootstrapping

### Complete Cluster Bootstrap Module

```hcl
# modules/cluster_bootstrap/main.tf

variable "cluster_name" {
  type        = string
  description = "EKS cluster name"
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod)"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod"
  }
}

variable "teams" {
  type = map(object({
    namespaces   = list(string)
    cluster_role = string
  }))
  description = "Map of team names to their RBAC configuration"
}

variable "addons" {
  type = object({
    cert_manager_version    = string
    ingress_nginx_version   = string
    external_dns_version    = string
    metrics_server_version  = string
  })
  description = "Addon versions to deploy"
}

# Deploy cluster addons in a defined order
module "cert_manager" {
  source = "./addons/cert_manager"

  version   = var.addons.cert_manager_version
  namespace = "cert-manager"
}

module "metrics_server" {
  source = "./addons/metrics_server"

  version   = var.addons.metrics_server_version
  namespace = "kube-system"
}

module "ingress_nginx" {
  source = "./addons/ingress_nginx"

  version     = var.addons.ingress_nginx_version
  namespace   = "ingress-nginx"
  environment = var.environment

  # Wait for cert-manager before nginx (ClusterIssuers need cert-manager)
  depends_on = [module.cert_manager]
}

module "external_dns" {
  source = "./addons/external_dns"

  version     = var.addons.external_dns_version
  namespace   = "external-dns"
  environment = var.environment
  cluster_name = var.cluster_name
}

# Provision team namespaces and RBAC
module "team_rbac" {
  for_each = var.teams

  source = "../rbac"

  team_name    = each.key
  namespaces   = each.value.namespaces
  cluster_role = each.value.cluster_role
  environment  = var.environment
}

# Standard NetworkPolicy for all namespaces
resource "kubernetes_manifest" "default_deny_all" {
  for_each = toset(flatten([for team in var.teams : team.namespaces]))

  manifest = {
    apiVersion = "networking.k8s.io/v1"
    kind       = "NetworkPolicy"

    metadata = {
      name      = "default-deny-all"
      namespace = each.value
    }

    spec = {
      podSelector = {}
      policyTypes = ["Ingress", "Egress"]
    }
  }
}
```

### Module Instantiation for Production

```hcl
# environments/prod/main.tf

module "cluster_bootstrap" {
  source = "../../modules/cluster_bootstrap"

  cluster_name = "prod-us-east-1"
  environment  = "prod"

  teams = {
    "payments" = {
      namespaces   = ["payments", "payments-staging"]
      cluster_role = "edit"
    }
    "platform" = {
      namespaces   = ["platform", "monitoring", "logging"]
      cluster_role = "admin"
    }
    "data-engineering" = {
      namespaces   = ["spark", "airflow", "data-lake"]
      cluster_role = "edit"
    }
  }

  addons = {
    cert_manager_version   = "v1.14.4"
    ingress_nginx_version  = "4.10.0"
    external_dns_version   = "1.14.3"
    metrics_server_version = "3.12.0"
  }
}
```

## Atlantis for PR-Based Terraform Workflows

### Atlantis Configuration

```yaml
# atlantis.yaml — root configuration for Atlantis server

version: 3
automerge: false
delete_source_branch_on_merge: false

projects:
  - name: prod-k8s-resources
    dir: environments/prod
    workspace: default
    terraform_version: v1.7.5
    # Only plan/apply when these paths change
    autoplan:
      when_modified:
        - "**/*.tf"
        - "**/*.tfvars"
        - "../../modules/**/*.tf"
      enabled: true
    apply_requirements:
      - approved
      - mergeable
    # Prevent concurrent applies to the same workspace
    delete_source_branch_on_merge: false

  - name: staging-k8s-resources
    dir: environments/staging
    workspace: default
    terraform_version: v1.7.5
    autoplan:
      when_modified:
        - "**/*.tf"
        - "**/*.tfvars"
      enabled: true
    apply_requirements:
      - approved
```

```yaml
# kubernetes/atlantis-deployment.yaml — Atlantis running in cluster

apiVersion: apps/v1
kind: Deployment
metadata:
  name: atlantis
  namespace: atlantis
  labels:
    app.kubernetes.io/name: atlantis
    app.kubernetes.io/managed-by: terraform
spec:
  replicas: 1  # Atlantis must run as a single replica for locking
  selector:
    matchLabels:
      app.kubernetes.io/name: atlantis
  template:
    metadata:
      labels:
        app.kubernetes.io/name: atlantis
    spec:
      serviceAccountName: atlantis
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: atlantis
          image: ghcr.io/runatlantis/atlantis:v0.28.1
          ports:
            - name: http
              containerPort: 4141
          env:
            - name: ATLANTIS_REPO_ALLOWLIST
              value: "github.com/acme-corp/*"
            - name: ATLANTIS_GH_USER
              value: "atlantis-bot"
            - name: ATLANTIS_GH_TOKEN
              valueFrom:
                secretKeyRef:
                  name: atlantis-github
                  key: token
            - name: ATLANTIS_GH_WEBHOOK_SECRET
              valueFrom:
                secretKeyRef:
                  name: atlantis-github
                  key: webhook-secret
            - name: ATLANTIS_DATA_DIR
              value: "/atlantis-data"
            - name: ATLANTIS_PORT
              value: "4141"
            # AWS credentials for S3 backend and EKS access
            - name: AWS_ROLE_ARN
              value: "arn:aws:iam::123456789012:role/atlantis-terraform"
            - name: AWS_WEB_IDENTITY_TOKEN_FILE
              value: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token"
          volumeMounts:
            - name: atlantis-data
              mountPath: /atlantis-data
            - name: aws-iam-token
              mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
          resources:
            requests:
              cpu: "250m"
              memory: "512Mi"
            limits:
              cpu: "1"
              memory: "2Gi"
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            initialDelaySeconds: 10
            periodSeconds: 5
      volumes:
        - name: atlantis-data
          persistentVolumeClaim:
            claimName: atlantis-data
        - name: aws-iam-token
          projected:
            sources:
              - serviceAccountToken:
                  audience: sts.amazonaws.com
                  expirationSeconds: 86400
                  path: token
```

## Drift Detection and Plan Strategies

### Scheduled Drift Detection

```bash
#!/usr/bin/env bash
# scripts/drift_detect.sh — Run terraform plan and alert on drift

set -euo pipefail

ENVIRONMENTS=("dev" "staging" "prod")
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
EXIT_CODE=0

for env in "${ENVIRONMENTS[@]}"; do
  echo "=== Checking drift in environment: ${env} ==="

  pushd "environments/${env}" > /dev/null

  # Initialize with current backend config
  terraform init -reconfigure -input=false > /dev/null 2>&1

  # Run plan and capture exit code
  # Exit code 0 = no changes, 1 = error, 2 = changes detected
  set +e
  terraform plan \
    -detailed-exitcode \
    -input=false \
    -out="${env}.tfplan" \
    -lock=false \    # Read-only drift check, don't acquire lock
    2>&1 | tee "/tmp/plan-${env}.txt"
  PLAN_EXIT=$?
  set -e

  case "${PLAN_EXIT}" in
    0)
      echo "No drift detected in ${env}"
      ;;
    1)
      echo "ERROR: Terraform plan failed for ${env}"
      EXIT_CODE=1
      # Alert on plan failure
      if [[ -n "${SLACK_WEBHOOK_URL}" ]]; then
        curl -s -X POST "${SLACK_WEBHOOK_URL}" \
          -H "Content-Type: application/json" \
          -d "{\"text\": \"Terraform plan FAILED for environment: ${env}\"}"
      fi
      ;;
    2)
      echo "DRIFT DETECTED in ${env}"
      EXIT_CODE=1
      # Alert on drift
      if [[ -n "${SLACK_WEBHOOK_URL}" ]]; then
        DRIFT_SUMMARY=$(grep -E "^  # |Plan:" "/tmp/plan-${env}.txt" | head -20 | tr '\n' '\\n')
        curl -s -X POST "${SLACK_WEBHOOK_URL}" \
          -H "Content-Type: application/json" \
          -d "{\"text\": \"Terraform DRIFT detected in ${env}:\n\`\`\`${DRIFT_SUMMARY}\`\`\`\"}"
      fi
      ;;
  esac

  popd > /dev/null
done

exit "${EXIT_CODE}"
```

```yaml
# .github/workflows/drift-detection.yaml

name: Terraform Drift Detection

on:
  schedule:
    # Run every 6 hours
    - cron: "0 */6 * * *"
  workflow_dispatch:

permissions:
  id-token: write  # For OIDC authentication to AWS
  contents: read

jobs:
  drift-detection:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        environment: [dev, staging, prod]
      fail-fast: false  # Check all environments even if one fails

    environment: ${{ matrix.environment }}

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/github-terraform-readonly
          aws-region: us-east-1

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.7.5"

      - name: Terraform Init
        run: terraform init -reconfigure
        working-directory: environments/${{ matrix.environment }}

      - name: Terraform Plan (Drift Detection)
        id: plan
        run: |
          # -detailed-exitcode: exit 2 if there are changes
          terraform plan \
            -detailed-exitcode \
            -lock=false \
            -input=false \
            -out=drift.tfplan
        working-directory: environments/${{ matrix.environment }}
        continue-on-error: true

      - name: Alert on Drift
        if: steps.plan.outcome == 'failure'
        run: |
          echo "Drift detected or plan failed for ${{ matrix.environment }}"
          # Notify Slack via webhook
          curl -s -X POST "${{ secrets.SLACK_WEBHOOK_URL }}" \
            -H "Content-Type: application/json" \
            -d '{"text":"Terraform drift detected in ${{ matrix.environment }}. Review: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
```

## Variables and Outputs Best Practices

```hcl
# environments/prod/variables.tf

variable "cluster_name" {
  type        = string
  description = "Name of the EKS cluster"
  default     = "prod-us-east-1"
}

variable "aws_region" {
  type        = string
  description = "AWS region where the cluster resides"
  default     = "us-east-1"
}

variable "route53_zone_id" {
  type        = string
  description = "Route53 hosted zone ID for external-dns"
}

# Use .tfvars files for environment-specific values
# Never commit .tfvars files containing secrets
# environments/prod/prod.tfvars (not committed)
# environments/prod/prod.tfvars.example (committed as documentation)
```

```hcl
# environments/prod/outputs.tf

output "namespace_names" {
  description = "All managed namespace names"
  value       = [for ns in module.cluster_bootstrap.namespaces : ns.name]
}

output "ingress_load_balancer_hostname" {
  description = "DNS hostname of the ingress load balancer"
  value       = module.cluster_bootstrap.ingress_nginx_lb_hostname
}

# Mark outputs containing sensitive values
output "deployer_tokens" {
  description = "CI/CD deployer tokens per namespace"
  sensitive   = true
  value       = module.cluster_bootstrap.deployer_tokens
}
```

## Lifecycle Rules and Import

```hcl
# Importing existing resources into Terraform state
# Use terraform import or import blocks (Terraform 1.5+)

# terraform/import.tf — import block for pre-existing namespaces

import {
  # Import the existing kube-system namespace
  id = "kube-system"
  to = kubernetes_namespace_v1.kube_system
}

resource "kubernetes_namespace_v1" "kube_system" {
  metadata {
    name = "kube-system"
  }

  # Ignore label/annotation changes managed by EKS
  lifecycle {
    ignore_changes = [
      metadata[0].labels,
      metadata[0].annotations,
    ]
  }
}
```

```bash
# Import workflow for existing resources

# 1. Add the import block or run terraform import
terraform import kubernetes_namespace_v1.monitoring monitoring

# 2. Run plan to see what Terraform wants to change
terraform plan

# 3. Add ignore_changes for fields managed externally
# 4. Verify plan shows no changes before committing
```

## Testing Terraform Configurations

```hcl
# tests/namespace_module_test.tftest.hcl — Terraform native tests (1.6+)

provider "kubernetes" {
  # Use a local kind cluster for testing
  config_path    = pathexpand("~/.kube/config")
  config_context = "kind-test"
}

run "namespace_created_with_correct_labels" {
  command = apply

  variables {
    name        = "test-namespace-tf"
    environment = "dev"
    team        = "platform"
    labels      = { "test" = "true" }
  }

  assert {
    condition     = kubernetes_namespace_v1.this.metadata[0].name == "test-namespace-tf"
    error_message = "Namespace name does not match expected value"
  }

  assert {
    condition     = kubernetes_namespace_v1.this.metadata[0].labels["support.tools/environment"] == "dev"
    error_message = "Environment label not set correctly"
  }

  assert {
    condition     = kubernetes_namespace_v1.this.metadata[0].labels["app.kubernetes.io/managed-by"] == "terraform"
    error_message = "managed-by label not set correctly"
  }
}

run "resource_quota_created" {
  command = apply

  variables {
    name        = "test-quota-namespace"
    environment = "dev"
    team        = "platform"
    resource_quota = {
      requests_cpu    = "2"
      requests_memory = "4Gi"
      limits_cpu      = "4"
      limits_memory   = "8Gi"
      pods            = 50
    }
  }

  assert {
    condition     = length(kubernetes_resource_quota_v1.this) == 1
    error_message = "Resource quota was not created"
  }
}
```

Managing Kubernetes resources through Terraform provides audit-trail-backed, plan-before-apply infrastructure management for cluster objects that Helm and kubectl alone cannot offer. Combined with Atlantis for PR workflows and scheduled drift detection, teams gain the confidence to know their cluster state matches what is declared in version control.
