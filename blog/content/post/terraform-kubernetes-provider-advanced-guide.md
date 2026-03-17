---
title: "Terraform Kubernetes Provider: Infrastructure and App Management"
date: 2027-10-13T00:00:00-05:00
draft: false
tags: ["Terraform", "Kubernetes", "IaC", "Provider", "DevOps"]
categories:
- Terraform
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Terraform Kubernetes provider patterns including kubernetes_manifest for CRDs, helm_release management, dynamic blocks, exec plugin auth for EKS/GKE/AKS, module design for reusable components, and managing operator CRD lifecycles."
more_link: "yes"
url: "/terraform-kubernetes-provider-advanced-guide/"
---

The Terraform Kubernetes provider bridges infrastructure provisioning and application deployment. Managing Kubernetes resources alongside cloud infrastructure in Terraform enables atomic apply operations that provision a cluster, configure RBAC, install operators, and deploy applications in a single workflow. This guide covers advanced provider usage patterns from CRD management through reusable module design, with production-ready configurations for enterprise environments.

<!--more-->

# Terraform Kubernetes Provider: Infrastructure and App Management

## Section 1: Provider Configuration

### Multi-Cluster Provider Configuration

Managing multiple clusters requires provider aliases. Each provider instance authenticates independently using cluster-specific credentials.

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.30"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.14"
    }
  }
}

# Production cluster — EKS with exec plugin
provider "kubernetes" {
  alias = "production"

  host                   = module.eks_production.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks_production.cluster_ca_certificate)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args = [
      "eks",
      "get-token",
      "--cluster-name", module.eks_production.cluster_name,
      "--region",       var.aws_region,
    ]
  }
}

# Staging cluster
provider "kubernetes" {
  alias = "staging"

  host                   = module.eks_staging.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks_staging.cluster_ca_certificate)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args = [
      "eks",
      "get-token",
      "--cluster-name", module.eks_staging.cluster_name,
      "--region",       var.aws_region,
    ]
  }
}

provider "helm" {
  alias = "production"

  kubernetes {
    host                   = module.eks_production.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks_production.cluster_ca_certificate)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args = [
        "eks",
        "get-token",
        "--cluster-name", module.eks_production.cluster_name,
        "--region",       var.aws_region,
      ]
    }
  }
}
```

### GKE Authentication with Workload Identity

```hcl
provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
}

data "google_client_config" "default" {}

data "google_container_cluster" "production" {
  name     = var.cluster_name
  location = var.gcp_region
}

provider "kubernetes" {
  alias = "gke_production"

  host  = "https://${data.google_container_cluster.production.endpoint}"
  token = data.google_client_config.default.access_token
  cluster_ca_certificate = base64decode(
    data.google_container_cluster.production.master_auth[0].cluster_ca_certificate
  )
}
```

## Section 2: kubernetes_manifest for CRDs

The `kubernetes_manifest` resource handles arbitrary Kubernetes objects including CRDs and custom resource instances that the typed `kubernetes_*` resources do not cover.

### Installing CRDs

```hcl
# Install cert-manager CRDs before the Helm release
resource "kubernetes_manifest" "cert_manager_crds" {
  provider = kubernetes.production

  # CRD manifest from cert-manager release
  manifest = yamldecode(file("${path.module}/crds/cert-manager-crds-v1.14.5.yaml"))

  # CRDs do not have a namespace
  field_manager {
    name            = "terraform"
    force_conflicts = true
  }
}

resource "helm_release" "cert_manager" {
  provider   = helm.production
  depends_on = [kubernetes_manifest.cert_manager_crds]

  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = "v1.14.5"
  namespace        = "cert-manager"
  create_namespace = true

  set {
    name  = "installCRDs"
    value = "false"  # CRDs managed by kubernetes_manifest above
  }
}
```

### Creating Custom Resource Instances

```hcl
# Create a ClusterIssuer after cert-manager is installed
resource "kubernetes_manifest" "cluster_issuer_letsencrypt" {
  provider   = kubernetes.production
  depends_on = [helm_release.cert_manager]

  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata = {
      name = "letsencrypt-production"
    }
    spec = {
      acme = {
        email  = var.acme_email
        server = "https://acme-v02.api.letsencrypt.org/directory"
        privateKeySecretRef = {
          name = "letsencrypt-production-account-key"
        }
        solvers = [
          {
            dns01 = {
              route53 = {
                region       = var.aws_region
                hostedZoneID = var.route53_zone_id
              }
            }
          }
        ]
      }
    }
  }
}

# Create a Certificate
resource "kubernetes_manifest" "api_server_certificate" {
  provider   = kubernetes.production
  depends_on = [kubernetes_manifest.cluster_issuer_letsencrypt]

  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "Certificate"
    metadata = {
      name      = "api-server-tls"
      namespace = "production"
    }
    spec = {
      secretName  = "api-server-tls-secret"
      duration    = "8760h"
      renewBefore = "720h"
      subject = {
        organizations = ["support.tools"]
      }
      commonName = "api.production.example.com"
      dnsNames = [
        "api.production.example.com",
        "api-internal.production.svc.cluster.local",
      ]
      issuerRef = {
        name = "letsencrypt-production"
        kind = "ClusterIssuer"
      }
    }
  }
}
```

### Handling CRD Deletion Order

CRDs must be deleted after all instances are removed. Use `prevent_destroy` to avoid accidental CRD deletion:

```hcl
resource "kubernetes_manifest" "external_secrets_crds" {
  provider = kubernetes.production

  manifest = yamldecode(
    file("${path.module}/crds/external-secrets-crds-v0.10.3.yaml")
  )

  lifecycle {
    prevent_destroy = true
    # Ignore future CRD changes that come from upstream
    ignore_changes = [manifest]
  }
}
```

## Section 3: helm_release Resource Management

### Complete helm_release with Values

```hcl
resource "helm_release" "kube_prometheus_stack" {
  provider         = helm.production
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "58.3.3"
  namespace        = "monitoring"
  create_namespace = true
  timeout          = 600
  atomic           = true
  cleanup_on_fail  = true
  wait             = true
  wait_for_jobs    = true

  values = [
    file("${path.module}/helm-values/kube-prometheus-stack.yaml"),
    yamlencode({
      prometheus = {
        prometheusSpec = {
          retention        = "${var.prometheus_retention_days}d"
          storageSpec = {
            volumeClaimTemplate = {
              spec = {
                storageClassName = var.storage_class_name
                accessModes      = ["ReadWriteOnce"]
                resources = {
                  requests = {
                    storage = "${var.prometheus_storage_size}Gi"
                  }
                }
              }
            }
          }
        }
      }
      grafana = {
        adminPassword = var.grafana_admin_password
        ingress = {
          enabled          = true
          ingressClassName = "nginx"
          hosts            = [var.grafana_hostname]
          tls = [
            {
              secretName = "grafana-tls"
              hosts      = [var.grafana_hostname]
            }
          ]
        }
      }
    })
  ]

  set_sensitive {
    name  = "grafana.adminPassword"
    value = var.grafana_admin_password
  }
}
```

### Helm Release with Computed Values

```hcl
# IAM role ARN is computed after EKS cluster creation
resource "helm_release" "karpenter" {
  provider         = helm.production
  depends_on       = [module.eks_production]
  name             = "karpenter"
  repository       = "oci://public.ecr.aws/karpenter"
  repository_oci_username = data.aws_ecrpublic_authorization_token.token.user_name
  repository_oci_password = data.aws_ecrpublic_authorization_token.token.password
  chart            = "karpenter"
  version          = "1.1.0"
  namespace        = "kube-system"
  create_namespace = false
  timeout          = 300
  atomic           = true

  set {
    name  = "settings.clusterName"
    value = module.eks_production.cluster_name
  }

  set {
    name  = "settings.interruptionQueue"
    value = module.eks_production.cluster_name
  }

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = aws_iam_role.karpenter_controller.arn
  }

  set {
    name  = "controller.resources.requests.cpu"
    value = "1"
  }

  set {
    name  = "controller.resources.requests.memory"
    value = "1Gi"
  }
}
```

## Section 4: Dynamic Blocks for Variable Workloads

Dynamic blocks allow generating repeated configuration elements from variables, enabling flexible module interfaces.

### Deployment with Dynamic Environment Variables

```hcl
resource "kubernetes_deployment" "api_server" {
  provider = kubernetes.production

  metadata {
    name      = "api-server"
    namespace = kubernetes_namespace.production.metadata[0].name
    labels = {
      app     = "api-server"
      version = var.app_version
    }
  }

  spec {
    replicas = var.replica_count

    selector {
      match_labels = {
        app = "api-server"
      }
    }

    template {
      metadata {
        labels = {
          app     = "api-server"
          version = var.app_version
        }
        annotations = merge(
          var.pod_annotations,
          {
            "prometheus.io/scrape" = "true"
            "prometheus.io/port"   = "9090"
          }
        )
      }

      spec {
        service_account_name = kubernetes_service_account.api_server.metadata[0].name

        container {
          name  = "api-server"
          image = "${var.image_repository}:${var.app_version}"

          resources {
            requests = {
              cpu    = var.resources.requests.cpu
              memory = var.resources.requests.memory
            }
            limits = {
              cpu    = var.resources.limits.cpu
              memory = var.resources.limits.memory
            }
          }

          # Dynamic environment variables from variable map
          dynamic "env" {
            for_each = var.environment_variables
            content {
              name  = env.key
              value = env.value
            }
          }

          # Dynamic environment variables from Kubernetes secrets
          dynamic "env" {
            for_each = var.secret_environment_variables
            content {
              name = env.key
              value_from {
                secret_key_ref {
                  name = env.value.secret_name
                  key  = env.value.secret_key
                }
              }
            }
          }

          # Dynamic volume mounts
          dynamic "volume_mount" {
            for_each = var.config_maps
            content {
              name       = volume_mount.key
              mount_path = volume_mount.value.mount_path
              read_only  = true
            }
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = var.health_port
            }
            initial_delay_seconds = 15
            period_seconds        = 20
            failure_threshold     = 3
          }

          readiness_probe {
            http_get {
              path = "/ready"
              port = var.health_port
            }
            initial_delay_seconds = 5
            period_seconds        = 10
            failure_threshold     = 3
          }
        }

        # Dynamic volumes from ConfigMaps
        dynamic "volume" {
          for_each = var.config_maps
          content {
            name = volume.key
            config_map {
              name = volume.value.config_map_name
            }
          }
        }

        # Node affinity
        dynamic "affinity" {
          for_each = var.node_selector != {} ? [1] : []
          content {
            node_affinity {
              required_during_scheduling_ignored_during_execution {
                node_selector_term {
                  dynamic "match_expressions" {
                    for_each = var.node_selector
                    content {
                      key      = match_expressions.key
                      operator = "In"
                      values   = [match_expressions.value]
                    }
                  }
                }
              }
            }
          }
        }

        topology_spread_constraint {
          max_skew           = 1
          topology_key       = "topology.kubernetes.io/zone"
          when_unsatisfiable = "DoNotSchedule"
          label_selector {
            match_labels = {
              app = "api-server"
            }
          }
        }
      }
    }
  }
}
```

### Variables for the Dynamic Deployment

```hcl
variable "environment_variables" {
  type        = map(string)
  description = "Plain environment variables for the container"
  default     = {}
}

variable "secret_environment_variables" {
  type = map(object({
    secret_name = string
    secret_key  = string
  }))
  description = "Environment variables sourced from Kubernetes Secrets"
  default     = {}
}

variable "config_maps" {
  type = map(object({
    config_map_name = string
    mount_path      = string
  }))
  description = "ConfigMaps to mount as volumes"
  default     = {}
}
```

## Section 5: Data Sources for Existing Resources

Read existing cluster resources without managing them:

```hcl
# Read existing namespace
data "kubernetes_namespace" "kube_system" {
  provider = kubernetes.production
  metadata {
    name = "kube-system"
  }
}

# Read existing ConfigMap
data "kubernetes_config_map" "aws_auth" {
  provider = kubernetes.production
  metadata {
    name      = "aws-auth"
    namespace = "kube-system"
  }
}

# Read existing Secret (e.g., service account token)
data "kubernetes_secret" "registry_credentials" {
  provider = kubernetes.production
  metadata {
    name      = "registry-credentials"
    namespace = "production"
  }
}

# Output the secret value (sensitive)
output "registry_server" {
  value     = data.kubernetes_secret.registry_credentials.data[".dockerconfigjson"]
  sensitive = true
}

# Read existing nodes to determine cluster size
data "kubernetes_nodes" "all" {
  provider = kubernetes.production
  metadata {
    labels = {
      "kubernetes.io/role" = "node"
    }
  }
}

output "node_count" {
  value = length(data.kubernetes_nodes.all.nodes)
}
```

## Section 6: State Management for Cluster Resources

### Remote State Configuration

```hcl
terraform {
  backend "s3" {
    bucket         = "company-terraform-state"
    key            = "clusters/production/kubernetes.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-locks"
  }
}
```

### State Isolation Strategy

Separate state files prevent large blast radius on changes:

```
├── terraform/
│   ├── clusters/
│   │   └── production/
│   │       ├── main.tf          # EKS cluster — state: clusters/production/eks.tfstate
│   │       └── variables.tf
│   ├── platform/
│   │   └── production/
│   │       ├── main.tf          # Operators, monitoring — state: platform/production.tfstate
│   │       └── providers.tf
│   └── applications/
│       └── production/
│           ├── main.tf          # App deployments — state: apps/production.tfstate
│           └── variables.tf
```

### Cross-State References

```hcl
# Platform layer reads cluster outputs from cluster state
data "terraform_remote_state" "eks_production" {
  backend = "s3"
  config = {
    bucket = "company-terraform-state"
    key    = "clusters/production/eks.tfstate"
    region = "us-east-1"
  }
}

provider "kubernetes" {
  host                   = data.terraform_remote_state.eks_production.outputs.cluster_endpoint
  cluster_ca_certificate = base64decode(
    data.terraform_remote_state.eks_production.outputs.cluster_ca_certificate
  )
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args = [
      "eks", "get-token",
      "--cluster-name", data.terraform_remote_state.eks_production.outputs.cluster_name,
      "--region",       "us-east-1",
    ]
  }
}
```

## Section 7: Module Design for Reusable Kubernetes Components

### Application Module Structure

```
modules/
└── kubernetes-app/
    ├── main.tf
    ├── variables.tf
    ├── outputs.tf
    ├── rbac.tf
    └── monitoring.tf
```

```hcl
# modules/kubernetes-app/main.tf
resource "kubernetes_namespace" "app" {
  count    = var.create_namespace ? 1 : 0
  provider = var.kubernetes_provider  # passed in via module input

  metadata {
    name = var.namespace
    labels = merge(
      {
        "app.kubernetes.io/managed-by" = "terraform"
        "environment"                  = var.environment
      },
      var.namespace_labels
    )
    annotations = var.pod_security_standard != "" ? {
      "pod-security.kubernetes.io/enforce"         = var.pod_security_standard
      "pod-security.kubernetes.io/enforce-version" = "latest"
      "pod-security.kubernetes.io/warn"            = var.pod_security_standard
      "pod-security.kubernetes.io/warn-version"    = "latest"
    } : {}
  }
}

resource "kubernetes_service_account" "app" {
  provider = var.kubernetes_provider

  metadata {
    name      = var.service_account_name
    namespace = var.create_namespace ? kubernetes_namespace.app[0].metadata[0].name : var.namespace
    annotations = var.irsa_role_arn != "" ? {
      "eks.amazonaws.com/role-arn" = var.irsa_role_arn
    } : {}
  }
}

resource "kubernetes_horizontal_pod_autoscaler_v2" "app" {
  count    = var.enable_hpa ? 1 : 0
  provider = var.kubernetes_provider

  metadata {
    name      = var.app_name
    namespace = var.create_namespace ? kubernetes_namespace.app[0].metadata[0].name : var.namespace
  }

  spec {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    scale_target_ref {
      api_version = "apps/v1"
      kind        = "Deployment"
      name        = var.app_name
    }

    metric {
      type = "Resource"
      resource {
        name = "cpu"
        target {
          type               = "Utilization"
          average_utilization = var.hpa_cpu_target
        }
      }
    }

    dynamic "metric" {
      for_each = var.custom_metrics
      content {
        type = "Pods"
        pods {
          metric {
            name = metric.value.name
          }
          target {
            type          = "AverageValue"
            average_value = metric.value.target
          }
        }
      }
    }
  }
}
```

### Module Call

```hcl
module "api_server" {
  source = "../../modules/kubernetes-app"

  app_name             = "api-server"
  namespace            = "production"
  create_namespace     = true
  environment          = "production"
  pod_security_standard = "restricted"
  image                = "support-tools/api-server:v2.5.0"
  irsa_role_arn        = aws_iam_role.api_server.arn
  service_account_name = "api-server"

  replica_count = 3
  enable_hpa    = true
  min_replicas  = 3
  max_replicas  = 20
  hpa_cpu_target = 60

  resources = {
    requests = { cpu = "200m",  memory = "256Mi" }
    limits   = { cpu = "1000m", memory = "1Gi"   }
  }

  environment_variables = {
    LOG_LEVEL    = "info"
    PORT         = "8080"
    METRICS_PORT = "9090"
  }

  secret_environment_variables = {
    DATABASE_URL = {
      secret_name = "database-credentials"
      secret_key  = "DATABASE_URL"
    }
  }

  custom_metrics = [
    {
      name   = "requests_per_second"
      target = "100"
    }
  ]

  namespace_labels = {
    team       = "platform"
    cost-center = "engineering"
  }
}
```

## Section 8: Managing Operator CRD Lifecycles

### Operator Installation Pattern

Install operators and their CRDs in the correct order, with proper lifecycle management:

```hcl
# 1. Install the operator via Helm
resource "helm_release" "external_secrets_operator" {
  provider         = helm.production
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = "0.10.3"
  namespace        = "external-secrets"
  create_namespace = true
  atomic           = true
  timeout          = 300

  set {
    name  = "installCRDs"
    value = "true"
  }

  set {
    name  = "replicaCount"
    value = "2"
  }
}

# 2. Wait for CRDs to be established before creating instances
resource "time_sleep" "wait_for_eso_crds" {
  depends_on      = [helm_release.external_secrets_operator]
  create_duration = "30s"
}

# 3. Create ClusterSecretStore
resource "kubernetes_manifest" "cluster_secret_store" {
  provider   = kubernetes.production
  depends_on = [time_sleep.wait_for_eso_crds]

  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ClusterSecretStore"
    metadata = {
      name = "aws-secretsmanager"
    }
    spec = {
      provider = {
        aws = {
          service = "SecretsManager"
          region  = var.aws_region
          auth = {
            jwt = {
              serviceAccountRef = {
                name      = "external-secrets"
                namespace = "external-secrets"
              }
            }
          }
        }
      }
    }
  }
}

# 4. Create ExternalSecret instances
resource "kubernetes_manifest" "database_credentials" {
  provider   = kubernetes.production
  depends_on = [kubernetes_manifest.cluster_secret_store]

  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ExternalSecret"
    metadata = {
      name      = "database-credentials"
      namespace = "production"
    }
    spec = {
      refreshInterval = "1h"
      secretStoreRef = {
        name = "aws-secretsmanager"
        kind = "ClusterSecretStore"
      }
      target = {
        name           = "database-credentials"
        creationPolicy = "Owner"
      }
      dataFrom = [
        {
          extract = {
            key = "production/database/primary"
          }
        }
      ]
    }
  }
}
```

### Operator CRD Version Upgrades

```hcl
# Use ignore_changes to prevent Terraform from overwriting CRDs
# that the operator manages independently after initial install
resource "kubernetes_manifest" "prometheus_operator_crds" {
  provider = kubernetes.production

  for_each = fileset("${path.module}/crds/prometheus-operator", "*.yaml")
  manifest = yamldecode(
    file("${path.module}/crds/prometheus-operator/${each.value}")
  )

  lifecycle {
    # Only manage initial creation; let the operator handle updates
    ignore_changes = [manifest]
  }

  field_manager {
    name            = "terraform"
    force_conflicts = false
  }
}
```

## Section 9: Production Patterns and Anti-Patterns

### Anti-Pattern: Managing Everything in One State File

Avoid putting cluster infrastructure and application resources in a single `terraform apply`. The blast radius of a misconfigured application deployment should not extend to cluster IAM roles or VPC configuration.

### Anti-Pattern: Using kubernetes_secret for Secret Values

```hcl
# AVOID: Storing secret values in Terraform state (state is often stored in S3)
resource "kubernetes_secret" "database_password" {  # BAD
  metadata { name = "db-password"; namespace = "production" }
  data = {
    password = "mysecretpassword"  # Stored in plaintext in tfstate
  }
}

# PREFER: Use External Secrets Operator and reference the store
resource "kubernetes_manifest" "database_external_secret" {  # GOOD
  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ExternalSecret"
    # ... fetches from AWS Secrets Manager at runtime
  }
}
```

### Pattern: Compute Tags from Module Inputs

```hcl
locals {
  common_labels = {
    "app.kubernetes.io/name"       = var.app_name
    "app.kubernetes.io/version"    = var.app_version
    "app.kubernetes.io/managed-by" = "terraform"
    "environment"                  = var.environment
    "team"                         = var.team
  }
}

resource "kubernetes_deployment" "app" {
  metadata {
    labels = local.common_labels
  }
  spec {
    template {
      metadata {
        labels = local.common_labels
      }
    }
  }
}
```

## Section 10: Validation and Testing

### Terraform Validation

```bash
# Format and validate all Terraform configurations
terraform fmt -recursive terraform/
terraform validate

# Plan with detailed output
terraform plan \
  -out=tfplan \
  -var-file=environments/production.tfvars

# Review the plan
terraform show -json tfplan | python3 -m json.tool | head -100
```

### Policy Validation with OPA/Conftest

```bash
# Install conftest
brew install conftest

# Write OPA policies for Terraform plans
cat > policies/kubernetes.rego <<'EOF'
package kubernetes

deny[msg] {
  input.resource_changes[_].type == "kubernetes_deployment"
  input.resource_changes[_].change.after.spec[0].template[0].spec[0].container[0].security_context == null
  msg := "Kubernetes deployment must have a security context defined"
}

deny[msg] {
  input.resource_changes[_].type == "kubernetes_deployment"
  container := input.resource_changes[_].change.after.spec[0].template[0].spec[0].container[0]
  container.resources[0].limits == null
  msg := sprintf("Container %v must have resource limits", [container.name])
}
EOF

# Run policy checks against Terraform plan
terraform plan -out=tfplan.binary
terraform show -json tfplan.binary > tfplan.json
conftest test tfplan.json --policy policies/
```

The Terraform Kubernetes provider, combined with the Helm provider and remote state references, provides a complete IaC solution for managing Kubernetes infrastructure. The key principles are state isolation by concern (cluster vs platform vs application), lifecycle management for CRDs (install separately, ignore upstream changes), and avoiding Terraform state for secret values by using External Secrets Operator.
