---
title: "Implementing Cloudflare Pages, KV-Namespace, and R2 with Terraform: Complete Deployment Guide"
date: 2025-12-04T09:00:00-05:00
draft: false
tags: ["Cloudflare", "Terraform", "Infrastructure as Code", "Cloudflare Pages", "KV Namespace", "R2 Storage", "AWS Secrets Manager", "GitOps", "CI/CD"]
categories:
- Infrastructure as Code
- Cloudflare
- Deployment
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Cloudflare Pages, KV-Namespace, and R2 storage using Terraform with secure credential management, modular configuration, and production-ready deployment practices."
more_link: "yes"
url: "/cloudflare-pages-terraform-deployment-guide/"
---

![Cloudflare Terraform Architecture](/images/posts/terraform/cloudflare-terraform-architecture.svg)

Learn how to implement a complete Cloudflare infrastructure using Terraform to deploy Cloudflare Pages with KV-Namespace and R2 storage. This guide covers secure credential management, modular configuration, GitOps integration, and production-ready deployment practices.

<!--more-->

# [Deploying Cloudflare Resources with Terraform](#terraform-cloudflare)

## [Introduction and Prerequisites](#introduction)

Cloudflare offers a powerful set of services that work seamlessly together to build modern web applications. In this guide, we'll implement a comprehensive Cloudflare deployment using Terraform to provision and manage:

1. **Cloudflare Pages**: For static site hosting with built-in CI/CD
2. **KV Namespace**: For key-value data storage
3. **R2 Storage**: For object storage (Cloudflare's S3-compatible service)
4. **DNS Configuration**: For domain mapping

Before starting, ensure you have:

- [Terraform](https://www.terraform.io/downloads.html) v1.0.0+ installed
- [Cloudflare account](https://dash.cloudflare.com/sign-up) with appropriate permissions
- [GitHub repository](https://github.com/) containing your application code
- [AWS account](https://aws.amazon.com/) (optional, for secrets management)

Let's begin with setting up our Terraform environment.

## [Setting Up the Terraform Environment](#terraform-setup)

### [Project Structure](#project-structure)

For maintainable infrastructure code, we'll use a modular structure:

```
cloudflare-terraform/
├── main.tf           # Main configuration entry point
├── variables.tf      # Input variables
├── outputs.tf        # Output values
├── providers.tf      # Provider configuration
├── modules/
│   ├── pages/        # Cloudflare Pages module
│   ├── kv/           # KV Namespace module
│   ├── r2/           # R2 Storage module
│   └── dns/          # DNS Configuration module
└── environments/
    ├── dev.tfvars    # Development environment variables
    ├── staging.tfvars # Staging environment variables
    └── prod.tfvars   # Production environment variables
```

### [Provider Configuration](#provider-configuration)

First, let's set up our `providers.tf` file:

```hcl
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.23"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.31"
    }
  }
  
  # Optional: Configure remote state
  backend "s3" {
    bucket         = "your-terraform-state-bucket"
    key            = "cloudflare/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}

# Cloudflare provider configuration
provider "cloudflare" {
  # We'll use Terraform variables to securely manage credentials
  # api_token = var.cloudflare_api_token
}

# AWS provider for secrets management (optional)
provider "aws" {
  region = var.aws_region
}
```

### [Variables Configuration](#variables-configuration)

Create a `variables.tf` file:

```hcl
# Cloudflare credentials
variable "cloudflare_api_token" {
  description = "Cloudflare API token"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for your domain"
  type        = string
}

# Project configuration
variable "project_name" {
  description = "Name of your Cloudflare Pages project"
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name (format: org/repo)"
  type        = string
}

variable "production_branch" {
  description = "Production branch for deployment"
  type        = string
  default     = "main"
}

# Domain configuration
variable "domain_name" {
  description = "Custom domain for your Cloudflare Pages project"
  type        = string
}

# AWS configuration (optional)
variable "aws_region" {
  description = "AWS region for secrets management"
  type        = string
  default     = "us-east-1"
}

variable "use_aws_secrets" {
  description = "Whether to fetch credentials from AWS Secrets Manager"
  type        = bool
  default     = false
}
```

## [Secure Credential Management](#credential-management)

Credentials should never be hardcoded in your Terraform files. We'll explore two approaches for secure credential management.

### [Option 1: Using Terraform Variables](#terraform-variables)

Create a `.tfvars` file that's excluded from version control:

```hcl
# secrets.tfvars (DO NOT COMMIT THIS FILE)
cloudflare_api_token = "your-cloudflare-api-token"
cloudflare_account_id = "your-cloudflare-account-id"
cloudflare_zone_id = "your-cloudflare-zone-id"
```

Apply with:

```bash
terraform apply -var-file="secrets.tfvars"
```

### [Option 2: AWS Secrets Manager Integration](#aws-secrets)

For enhanced security, we can fetch credentials from AWS Secrets Manager:

```hcl
# In main.tf
locals {
  # If using AWS Secrets Manager, fetch credentials from there
  cf_credentials = var.use_aws_secrets ? {
    api_token   = data.aws_secretsmanager_secret_version.cf_api_token[0].secret_string
    account_id  = data.aws_secretsmanager_secret_version.cf_account_id[0].secret_string
    zone_id     = data.aws_secretsmanager_secret_version.cf_zone_id[0].secret_string
  } : {
    api_token   = var.cloudflare_api_token
    account_id  = var.cloudflare_account_id
    zone_id     = var.cloudflare_zone_id
  }
}

# Fetch Cloudflare credentials from AWS Secrets Manager
data "aws_secretsmanager_secret_version" "cf_api_token" {
  count     = var.use_aws_secrets ? 1 : 0
  secret_id = "cloudflare/api-token"
}

data "aws_secretsmanager_secret_version" "cf_account_id" {
  count     = var.use_aws_secrets ? 1 : 0
  secret_id = "cloudflare/account-id"
}

data "aws_secretsmanager_secret_version" "cf_zone_id" {
  count     = var.use_aws_secrets ? 1 : 0
  secret_id = "cloudflare/zone-id"
}

# Update provider configuration in providers.tf
provider "cloudflare" {
  api_token = local.cf_credentials.api_token
}
```

## [Implementing Cloudflare Resources](#implementing-resources)

Now, let's create our main resources. We'll define them in modules for better organization.

### [KV Namespace Module](#kv-namespace)

Create `modules/kv/main.tf`:

```hcl
variable "namespace_name" {
  description = "Name of the KV namespace"
  type        = string
}

resource "cloudflare_workers_kv_namespace" "this" {
  title = var.namespace_name
}

output "id" {
  value = cloudflare_workers_kv_namespace.this.id
}

output "title" {
  value = cloudflare_workers_kv_namespace.this.title
}
```

### [R2 Storage Module](#r2-storage)

Create `modules/r2/main.tf`:

```hcl
variable "bucket_name" {
  description = "Name of the R2 bucket"
  type        = string
}

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

resource "cloudflare_r2_bucket" "this" {
  account_id = var.account_id
  name       = var.bucket_name
  
  # Optional: Configure lifecycle rules
  lifecycle_rule {
    enabled = true
    expiration {
      days = 30
    }
  }
}

output "name" {
  value = cloudflare_r2_bucket.this.name
}
```

### [Cloudflare Pages Module](#cloudflare-pages)

Create `modules/pages/main.tf`:

```hcl
variable "project_name" {
  description = "Name of the Cloudflare Pages project"
  type        = string
}

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "production_branch" {
  description = "Production branch for deployment"
  type        = string
  default     = "main"
}

variable "github_repo" {
  description = "GitHub repository name (format: org/repo)"
  type        = string
}

variable "build_command" {
  description = "Build command for the project"
  type        = string
  default     = "npm run build"
}

variable "destination_dir" {
  description = "Build output directory"
  type        = string
  default     = "dist"
}

variable "kv_namespace_id" {
  description = "KV namespace ID to bind to the Pages project"
  type        = string
}

variable "r2_bucket_name" {
  description = "R2 bucket name to bind to the Pages project"
  type        = string
}

variable "environment_variables" {
  description = "Environment variables for the Pages project"
  type        = map(string)
  default     = {}
}

locals {
  github_parts = split("/", var.github_repo)
  github_owner = local.github_parts[0]
  github_repo  = local.github_parts[1]
}

resource "cloudflare_pages_project" "this" {
  name              = var.project_name
  account_id        = var.account_id
  production_branch = var.production_branch

  source {
    type = "github"
    config {
      owner                      = local.github_owner
      repo_name                  = local.github_repo
      production_branch          = var.production_branch
      pr_comments_enabled        = true
      deployments_enabled        = true
      preview_deployment_setting = "all"
      preview_branch_includes    = ["*"]
    }
  }

  build_config {
    build_command   = var.build_command
    destination_dir = var.destination_dir
  }

  deployment_configs {
    preview {
      compatibility_flags       = []
      d1_databases              = {}
      durable_object_namespaces = {}
      fail_open                 = true
      environment_variables     = var.environment_variables
      kv_namespaces = {
        "KV_NAMESPACE" = var.kv_namespace_id
      }
      r2_buckets = {
        "R2_BUCKET" = var.r2_bucket_name
      }
    }
    production {
      compatibility_flags       = []
      d1_databases              = {}
      durable_object_namespaces = {}
      fail_open                 = true
      environment_variables     = var.environment_variables
      kv_namespaces = {
        "KV_NAMESPACE" = var.kv_namespace_id
      }
      r2_buckets = {
        "R2_BUCKET" = var.r2_bucket_name
      }
    }
  }
}

output "project_name" {
  value = cloudflare_pages_project.this.name
}

output "project_subdomain" {
  value = "${cloudflare_pages_project.this.name}.pages.dev"
}
```

### [DNS Configuration Module](#dns-configuration)

Create `modules/dns/main.tf`:

```hcl
variable "zone_id" {
  description = "Cloudflare zone ID"
  type        = string
}

variable "domain_name" {
  description = "Domain name for the Pages project"
  type        = string
}

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "project_name" {
  description = "Cloudflare Pages project name"
  type        = string
}

# Create CNAME record for validation
resource "cloudflare_record" "validation" {
  zone_id         = var.zone_id
  name            = var.domain_name
  value           = "${var.project_name}.pages.dev"
  type            = "CNAME"
  ttl             = 1
  proxied         = true
  allow_overwrite = false
}

# Link custom domain to Cloudflare Pages project
resource "cloudflare_pages_domain" "custom_domain" {
  account_id   = var.account_id
  project_name = var.project_name
  domain       = var.domain_name
  
  depends_on = [cloudflare_record.validation]
}

output "domain" {
  value = var.domain_name
}
```

## [Putting It All Together](#main-config)

Now, let's create the main configuration file (`main.tf`) to tie everything together:

```hcl
# Create KV Namespace
module "kv_namespace" {
  source         = "./modules/kv"
  namespace_name = "${var.project_name}-kv"
}

# Create R2 Bucket
module "r2_bucket" {
  source      = "./modules/r2"
  bucket_name = "${var.project_name}-bucket"
  account_id  = local.cf_credentials.account_id
}

# Create Cloudflare Pages Project
module "pages_project" {
  source            = "./modules/pages"
  project_name      = var.project_name
  account_id        = local.cf_credentials.account_id
  production_branch = var.production_branch
  github_repo       = var.github_repo
  build_command     = "npm run build"
  destination_dir   = "dist"
  kv_namespace_id   = module.kv_namespace.id
  r2_bucket_name    = module.r2_bucket.name
  
  environment_variables = {
    NODE_VERSION = "18"
    API_URL      = "https://api.example.com"
  }
}

# Configure DNS
module "dns" {
  source       = "./modules/dns"
  zone_id      = local.cf_credentials.zone_id
  domain_name  = var.domain_name
  account_id   = local.cf_credentials.account_id
  project_name = module.pages_project.project_name
}
```

Finally, create an `outputs.tf` file:

```hcl
output "pages_url" {
  description = "Default Cloudflare Pages URL"
  value       = "https://${module.pages_project.project_subdomain}"
}

output "custom_domain" {
  description = "Custom domain for the Pages project"
  value       = "https://${module.dns.domain}"
}

output "kv_namespace" {
  description = "KV namespace ID and title"
  value = {
    id    = module.kv_namespace.id
    title = module.kv_namespace.title
  }
}

output "r2_bucket" {
  description = "R2 bucket name"
  value       = module.r2_bucket.name
}
```

## [Environment-Specific Configurations](#environments)

For different environments, create environment-specific variable files:

### [Development Environment](#dev-env)

```hcl
# environments/dev.tfvars
project_name      = "my-project-dev"
github_repo       = "myorg/myrepo"
production_branch = "develop"
domain_name       = "dev.example.com"
```

### [Production Environment](#prod-env)

```hcl
# environments/prod.tfvars
project_name      = "my-project"
github_repo       = "myorg/myrepo"
production_branch = "main"
domain_name       = "www.example.com"
```

## [Deployment Workflow](#deployment-workflow)

Let's implement a comprehensive deployment workflow:

### [1. Initialize the Terraform Project](#terraform-init)

```bash
terraform init
```

### [2. Validate the Configuration](#terraform-validate)

```bash
terraform validate
```

### [3. Plan the Deployment](#terraform-plan)

For development:
```bash
terraform plan -var-file="secrets.tfvars" -var-file="environments/dev.tfvars" -out=dev.tfplan
```

For production:
```bash
terraform plan -var-file="secrets.tfvars" -var-file="environments/prod.tfvars" -out=prod.tfplan
```

### [4. Apply the Configuration](#terraform-apply)

```bash
terraform apply "dev.tfplan"
```

### [5. Destroy Resources When No Longer Needed](#terraform-destroy)

```bash
terraform destroy -var-file="secrets.tfvars" -var-file="environments/dev.tfvars"
```

## [Integrating with CI/CD](#cicd-integration)

Let's create a GitHub Actions workflow to automate deployments:

```yaml
# .github/workflows/terraform.yml
name: "Terraform Deployment"

on:
  push:
    branches:
      - main
      - develop
  pull_request:
    branches:
      - main
      - develop

jobs:
  terraform:
    name: "Terraform"
    runs-on: ubuntu-latest
    
    # Use different environments based on branch
    environment:
      ${{ github.ref == 'refs/heads/main' && 'production' || 'development' }}
    
    steps:
      - name: Checkout
        uses: actions/checkout@v3

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v2
        with:
          terraform_version: 1.5.7

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Terraform Init
        run: terraform init

      - name: Set environment variables
        run: |
          if [[ $GITHUB_REF == 'refs/heads/main' ]]; then
            echo "TF_VAR_FILE=environments/prod.tfvars" >> $GITHUB_ENV
            echo "ENVIRONMENT=production" >> $GITHUB_ENV
          else
            echo "TF_VAR_FILE=environments/dev.tfvars" >> $GITHUB_ENV
            echo "ENVIRONMENT=development" >> $GITHUB_ENV
          fi

      - name: Set Cloudflare credentials
        run: |
          cat << EOF > secrets.tfvars
          cloudflare_api_token = "${{ secrets.CLOUDFLARE_API_TOKEN }}"
          cloudflare_account_id = "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
          cloudflare_zone_id = "${{ secrets.CLOUDFLARE_ZONE_ID }}"
          EOF

      - name: Terraform Format
        run: terraform fmt -check

      - name: Terraform Plan
        run: terraform plan -var-file="secrets.tfvars" -var-file="${{ env.TF_VAR_FILE }}" -out=tfplan

      - name: Terraform Apply
        if: github.event_name == 'push'
        run: terraform apply "tfplan"
```

## [Advanced Configuration Patterns](#advanced-patterns)

### [Conditional Resource Creation](#conditional-resources)

You can conditionally create resources based on the environment:

```hcl
# Create preview environments only in development
resource "cloudflare_pages_project" "preview" {
  count = var.environment == "development" ? 1 : 0
  
  name              = "${var.project_name}-preview"
  account_id        = local.cf_credentials.account_id
  production_branch = "feature/*"
  
  # Additional configuration...
}
```

### [Custom Cloudflare Workers Integration](#workers-integration)

Integrate Cloudflare Workers with Pages for dynamic functionality:

```hcl
resource "cloudflare_worker_script" "api" {
  name    = "${var.project_name}-api"
  content = file("${path.module}/workers/api.js")
  
  kv_namespace_binding {
    name         = "KV_NAMESPACE"
    namespace_id = module.kv_namespace.id
  }
  
  r2_bucket_binding {
    name        = "R2_BUCKET"
    bucket_name = module.r2_bucket.name
  }
}

resource "cloudflare_worker_route" "api_route" {
  zone_id     = local.cf_credentials.zone_id
  pattern     = "${var.domain_name}/api/*"
  script_name = cloudflare_worker_script.api.name
}
```

### [Web Analytics Integration](#analytics-integration)

Add Cloudflare Web Analytics to your Pages deployment:

```hcl
resource "cloudflare_web_analytics_site" "analytics" {
  zone_tag = local.cf_credentials.zone_id
  auto_install = true
}

# Add the analytics token to your Pages environment variables
locals {
  enhanced_env_vars = merge(var.environment_variables, {
    CLOUDFLARE_ANALYTICS_TOKEN = cloudflare_web_analytics_site.analytics.analytics_token
  })
}

# Update the Pages module to use the enhanced env vars
module "pages_project" {
  # ... other configuration ...
  environment_variables = local.enhanced_env_vars
}
```

## [Best Practices and Production Considerations](#best-practices)

### [1. State Management](#state-management)

Always use a remote backend for your Terraform state:

```hcl
terraform {
  backend "s3" {
    bucket         = "your-terraform-state-bucket"
    key            = "cloudflare/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-locks"
  }
}
```

### [2. Secret Rotation](#secret-rotation)

Implement credential rotation using AWS Secrets Manager:

```hcl
resource "aws_secretsmanager_secret_rotation" "cloudflare_api_token" {
  secret_id           = aws_secretsmanager_secret.cloudflare_api_token.id
  rotation_lambda_arn = aws_lambda_function.rotate_cloudflare_token.arn
  
  rotation_rules {
    automatically_after_days = 30
  }
}
```

### [3. Module Versioning](#module-versioning)

Use semantic versioning for your Terraform modules:

```hcl
module "pages_project" {
  source  = "git::https://github.com/your-org/terraform-cloudflare-modules.git//pages?ref=v1.2.0"
  # Configuration...
}
```

### [4. Resource Tagging](#resource-tagging)

Use consistent tagging for all resources:

```hcl
locals {
  common_tags = {
    Environment = var.environment
    Project     = var.project_name
    ManagedBy   = "Terraform"
  }
}

resource "cloudflare_r2_bucket" "this" {
  # ... other configuration ...
  
  cors_rule {
    # ... configuration ...
  }
  
  meta {
    tags = jsonencode(local.common_tags)
  }
}
```

### [5. CI/CD Pipeline Security](#cicd-security)

Implement secure CI/CD practices:

1. Use OpenID Connect (OIDC) for AWS authentication instead of long-lived credentials
2. Implement approval workflows for production deployments
3. Enable drift detection to identify manual changes

## [Monitoring and Observability](#monitoring)

Integrate your Cloudflare resources with monitoring systems:

```hcl
resource "cloudflare_notification_policy" "pages_deployment" {
  account_id = local.cf_credentials.account_id
  name       = "${var.project_name}-deployment-alerts"
  
  enabled = true
  
  alert_type = "pages_deployment_status_changed"
  
  email_integration {
    id = cloudflare_notification_policy_email.admin.id
  }
  
  pagerduty_integration {
    id = cloudflare_notification_policy_pagerduty.oncall.id
  }
}

resource "cloudflare_notification_policy_email" "admin" {
  account_id = local.cf_credentials.account_id
  name       = "admin-email"
  email_address = "admin@example.com"
}
```

## [Troubleshooting Common Issues](#troubleshooting)

### [API Token Permissions](#api-token-permissions)

Ensure your API token has the correct permissions:

```
Account.Cloudflare Pages:Edit
Account.Workers KV Storage:Edit
Account.R2:Edit
Zone.DNS:Edit
```

### [GitHub Repository Access](#github-access)

For GitHub integration, Cloudflare needs access to your repository. Ensure the GitHub OAuth app is authorized for your organization.

### [Domain Verification Issues](#domain-verification)

If your custom domain fails to verify:

1. Check DNS propagation: `dig CNAME domain-name.example.com`
2. Verify the CNAME points to your Pages subdomain
3. Make sure the domain is properly added to your Cloudflare account

### [Build Failures](#build-failures)

For build failures:

1. Verify your build command is correct
2. Check if you need to set NODE_VERSION or other environment variables
3. Test the build locally before deploying

## [Conclusion](#conclusion)

By following this guide, you've implemented a comprehensive Cloudflare infrastructure using Terraform, including:

1. Cloudflare Pages for static site hosting with GitHub integration
2. KV Namespace for key-value storage
3. R2 Bucket for object storage
4. Custom domain configuration with DNS

This infrastructure is fully managed as code, version-controlled, and can be deployed to multiple environments. The modular approach allows for flexible expansion and maintenance as your needs grow.

## [Further Reading](#further-reading)

- [Cloudflare Terraform Provider Documentation](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
- [Getting Started with Cloudflare Pages](https://developers.cloudflare.com/pages)
- [KV Namespace Usage Guide](https://developers.cloudflare.com/workers/learning/how-kv-works)
- [R2 Storage Documentation](https://developers.cloudflare.com/r2/get-started)
- [Terraform Best Practices](/terraform-best-practices-infrastructure-as-code/)