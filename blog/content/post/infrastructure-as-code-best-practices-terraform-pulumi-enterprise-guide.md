---
title: "Infrastructure as Code Best Practices with Terraform and Pulumi: Enterprise Production Framework 2026"
date: 2026-08-08T00:00:00-05:00
draft: false
tags: ["Infrastructure as Code", "Terraform", "Pulumi", "Cloud Infrastructure", "DevOps", "Automation", "AWS", "Azure", "GCP", "Kubernetes", "Enterprise Infrastructure", "Configuration Management", "Cloud Native", "Infrastructure Automation", "DevSecOps"]
categories:
- Infrastructure as Code
- DevOps
- Cloud Infrastructure
- Automation
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Infrastructure as Code best practices with Terraform and Pulumi for enterprise production environments. Complete guide to scalable infrastructure automation, multi-cloud deployment patterns, state management, and enterprise-grade IaC architectures."
more_link: "yes"
url: "/infrastructure-as-code-best-practices-terraform-pulumi-enterprise-guide/"
---

Infrastructure as Code (IaC) represents a fundamental shift toward programmatic infrastructure management, enabling reproducible, scalable, and auditable infrastructure deployment through declarative configuration and automation. This comprehensive guide explores advanced IaC implementation patterns using Terraform and Pulumi, covering enterprise-scale multi-cloud architectures, state management strategies, and production-ready automation frameworks.

<!--more-->

# [Enterprise Infrastructure as Code Architecture](#enterprise-infrastructure-as-code-architecture)

## IaC Design Principles and Implementation Strategy

Modern Infrastructure as Code implementations require sophisticated architectural patterns that balance flexibility, maintainability, security, and scalability across diverse cloud environments and organizational requirements.

### Comprehensive IaC Architecture Framework

```
┌─────────────────────────────────────────────────────────────────┐
│                Enterprise IaC Platform Architecture             │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│   Source        │   Orchestration │   Target        │   Policy  │
│   Management    │   Engines       │   Infrastructure│   Engine  │
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ Git Repos   │ │ │ Terraform   │ │ │ AWS/Azure   │ │ │ OPA   │ │
│ │ - Modules   │ │ │ Pulumi      │ │ │ GCP/K8s     │ │ │ Sentinel│ │
│ │ - Configs   │ │ │ Atlantis    │ │ │ On-Premise  │ │ │ Policy │ │
│ │ - Policies  │ │ │ Terragrunt  │ │ │ Edge/IoT    │ │ │ as Code│ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Versioning    │ • Plan/Apply    │ • Multi-cloud   │ • Security│
│ • Reviews       │ • State Mgmt    │ • Multi-region  │ • Compliance│
│ • Validation    │ • Drift Detect  │ • Multi-account │ • Governance│
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### Advanced Terraform Enterprise Configuration

Terraform provides mature infrastructure provisioning capabilities with sophisticated state management, module composition, and enterprise integration features for complex multi-cloud environments.

```hcl
# terraform/environments/production/main.tf
terraform {
  required_version = ">= 1.7.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.95"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 5.15"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
    vault = {
      source  = "hashicorp/vault"
      version = "~> 3.24"
    }
  }
  
  # Remote state configuration with encryption and locking
  backend "s3" {
    bucket         = "company-terraform-state-prod"
    key            = "infrastructure/production/terraform.tfstate"
    region         = "us-west-2"
    encrypt        = true
    dynamodb_table = "terraform-state-lock-prod"
    
    # Enhanced security configuration
    kms_key_id                = "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012"
    skip_region_validation    = false
    skip_credentials_validation = false
    skip_metadata_api_check   = false
    force_path_style         = false
    
    # Assume role for cross-account access
    assume_role {
      role_arn     = "arn:aws:iam::123456789012:role/TerraformExecutionRole"
      session_name = "terraform-production-session"
      external_id  = "terraform-external-id"
    }
  }
  
  # Cloud configuration for Terraform Cloud/Enterprise
  cloud {
    organization = "company-infrastructure"
    workspaces {
      name = "production-infrastructure"
    }
  }
}

# Provider configurations with advanced features
provider "aws" {
  region = var.aws_region
  
  # Assume role configuration for multi-account setup
  assume_role {
    role_arn     = var.aws_assume_role_arn
    session_name = "terraform-${var.environment}-session"
    external_id  = var.aws_external_id
  }
  
  # Default tags applied to all resources
  default_tags {
    tags = {
      Environment        = var.environment
      Project           = var.project_name
      Owner             = var.team_owner
      ManagedBy         = "terraform"
      CostCenter        = var.cost_center
      DataClassification = var.data_classification
      BackupPolicy      = var.backup_policy
      CreatedDate       = formatdate("YYYY-MM-DD", timestamp())
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    
    virtual_machine {
      delete_os_disk_on_deletion     = false
      graceful_shutdown             = true
      skip_shutdown_and_force_delete = false
    }
    
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
  
  # Service principal authentication
  client_id       = var.azure_client_id
  client_secret   = var.azure_client_secret
  tenant_id       = var.azure_tenant_id
  subscription_id = var.azure_subscription_id
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
  zone    = var.gcp_zone
  
  # Service account key for authentication
  credentials = var.gcp_service_account_key
  
  # Request timeout configuration
  request_timeout = "60s"
  
  # Batching configuration for performance
  batching {
    enable_batching = true
    send_after     = "10s"
  }
}

# Data sources for existing infrastructure
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

data "azurerm_subscription" "current" {}
data "azurerm_client_config" "current" {}

data "google_project" "current" {}
data "google_compute_zones" "available" {}

# Local values for computed configurations
locals {
  # Environment-specific configurations
  environment_config = {
    production = {
      instance_count = 5
      instance_type  = "m5.xlarge"
      min_size      = 3
      max_size      = 10
      desired_size  = 5
    }
    staging = {
      instance_count = 2
      instance_type  = "m5.large"
      min_size      = 1
      max_size      = 3
      desired_size  = 2
    }
    development = {
      instance_count = 1
      instance_type  = "m5.medium"
      min_size      = 1
      max_size      = 2
      desired_size  = 1
    }
  }
  
  # Common resource naming convention
  naming_convention = {
    prefix = "${var.organization}-${var.project_name}-${var.environment}"
    suffix = formatdate("YYYYMMDD", timestamp())
  }
  
  # Network configuration
  network_config = {
    vpc_cidr             = var.vpc_cidr
    availability_zones   = slice(data.aws_availability_zones.available.names, 0, 3)
    private_subnet_cidrs = [for i, az in local.network_config.availability_zones : cidrsubnet(var.vpc_cidr, 8, i)]
    public_subnet_cidrs  = [for i, az in local.network_config.availability_zones : cidrsubnet(var.vpc_cidr, 8, i + 10)]
    database_subnet_cidrs = [for i, az in local.network_config.availability_zones : cidrsubnet(var.vpc_cidr, 8, i + 20)]
  }
  
  # Security group rules
  security_group_rules = {
    web_ingress = [
      {
        from_port   = 80
        to_port     = 80
        protocol    = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
        description = "HTTP from anywhere"
      },
      {
        from_port   = 443
        to_port     = 443
        protocol    = "tcp"
        cidr_blocks = ["0.0.0.0/0"]
        description = "HTTPS from anywhere"
      }
    ]
    
    app_ingress = [
      {
        from_port       = 8080
        to_port         = 8080
        protocol        = "tcp"
        source_security_group_id = module.alb.security_group_id
        description     = "Application port from ALB"
      }
    ]
    
    db_ingress = [
      {
        from_port       = 5432
        to_port         = 5432
        protocol        = "tcp"
        source_security_group_id = module.app.security_group_id
        description     = "PostgreSQL from application"
      }
    ]
  }
}

# Variable definitions with validation
variable "environment" {
  description = "Environment name (production, staging, development)"
  type        = string
  
  validation {
    condition     = contains(["production", "staging", "development"], var.environment)
    error_message = "Environment must be one of: production, staging, development."
  }
}

variable "aws_region" {
  description = "AWS region for resource deployment"
  type        = string
  default     = "us-west-2"
  
  validation {
    condition = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "AWS region must be in the format: us-west-2, eu-central-1, etc."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.0.0.0/16"
  
  validation {
    condition = can(cidrhost(var.vpc_cidr, 0))
    error_message = "VPC CIDR must be a valid IPv4 CIDR block."
  }
}

variable "kubernetes_version" {
  description = "Kubernetes cluster version"
  type        = string
  default     = "1.29"
  
  validation {
    condition = can(regex("^[0-9]+\\.[0-9]+$", var.kubernetes_version))
    error_message = "Kubernetes version must be in the format: 1.29, 1.28, etc."
  }
}

variable "enable_monitoring" {
  description = "Enable comprehensive monitoring and logging"
  type        = bool
  default     = true
}

variable "enable_encryption" {
  description = "Enable encryption at rest and in transit"
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Number of days to retain backups"
  type        = number
  default     = 30
  
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 365
    error_message = "Backup retention must be between 7 and 365 days."
  }
}

# Module compositions for complex infrastructure
module "networking" {
  source = "../../modules/networking"
  
  environment             = var.environment
  vpc_cidr               = var.vpc_cidr
  availability_zones     = local.network_config.availability_zones
  private_subnet_cidrs   = local.network_config.private_subnet_cidrs
  public_subnet_cidrs    = local.network_config.public_subnet_cidrs
  database_subnet_cidrs  = local.network_config.database_subnet_cidrs
  
  enable_nat_gateway     = true
  enable_vpn_gateway     = var.environment == "production"
  enable_dns_hostnames   = true
  enable_dns_support     = true
  
  tags = local.common_tags
}

module "security" {
  source = "../../modules/security"
  
  environment         = var.environment
  vpc_id             = module.networking.vpc_id
  security_group_rules = local.security_group_rules
  
  enable_waf         = var.environment == "production"
  enable_shield      = var.environment == "production"
  enable_guardduty   = true
  enable_config      = true
  
  kms_key_deletion_window = var.environment == "production" ? 30 : 7
  
  depends_on = [module.networking]
  tags       = local.common_tags
}

module "compute" {
  source = "../../modules/compute"
  
  environment           = var.environment
  vpc_id               = module.networking.vpc_id
  private_subnet_ids   = module.networking.private_subnet_ids
  security_group_ids   = [module.security.app_security_group_id]
  
  instance_type        = local.environment_config[var.environment].instance_type
  min_size            = local.environment_config[var.environment].min_size
  max_size            = local.environment_config[var.environment].max_size
  desired_size        = local.environment_config[var.environment].desired_size
  
  enable_detailed_monitoring = var.enable_monitoring
  enable_encryption         = var.enable_encryption
  
  depends_on = [module.networking, module.security]
  tags       = local.common_tags
}

module "database" {
  source = "../../modules/database"
  
  environment              = var.environment
  vpc_id                  = module.networking.vpc_id
  database_subnet_ids     = module.networking.database_subnet_ids
  security_group_ids      = [module.security.db_security_group_id]
  
  engine_version          = "15.5"
  instance_class          = var.environment == "production" ? "db.r6g.xlarge" : "db.t4g.medium"
  allocated_storage       = var.environment == "production" ? 500 : 100
  max_allocated_storage   = var.environment == "production" ? 1000 : 200
  
  multi_az               = var.environment == "production"
  backup_retention_period = var.backup_retention_days
  backup_window          = "03:00-04:00"
  maintenance_window     = "sun:04:00-sun:05:00"
  
  enable_encryption      = var.enable_encryption
  enable_monitoring      = var.enable_monitoring
  enable_performance_insights = var.environment == "production"
  
  depends_on = [module.networking, module.security]
  tags       = local.common_tags
}

module "kubernetes" {
  source = "../../modules/kubernetes"
  
  environment           = var.environment
  vpc_id               = module.networking.vpc_id
  private_subnet_ids   = module.networking.private_subnet_ids
  public_subnet_ids    = module.networking.public_subnet_ids
  
  cluster_version      = var.kubernetes_version
  node_instance_types  = [local.environment_config[var.environment].instance_type]
  node_desired_size    = local.environment_config[var.environment].desired_size
  node_max_size        = local.environment_config[var.environment].max_size
  node_min_size        = local.environment_config[var.environment].min_size
  
  enable_cluster_autoscaler = true
  enable_vpc_cni           = true
  enable_coredns           = true
  enable_kube_proxy        = true
  
  enable_encryption        = var.enable_encryption
  enable_logging          = var.enable_monitoring
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
  
  depends_on = [module.networking, module.security]
  tags       = local.common_tags
}

module "monitoring" {
  source = "../../modules/monitoring"
  count  = var.enable_monitoring ? 1 : 0
  
  environment           = var.environment
  vpc_id               = module.networking.vpc_id
  private_subnet_ids   = module.networking.private_subnet_ids
  
  cluster_name         = module.kubernetes.cluster_name
  cluster_endpoint     = module.kubernetes.cluster_endpoint
  cluster_ca_certificate = module.kubernetes.cluster_ca_certificate
  
  enable_prometheus    = true
  enable_grafana      = true
  enable_alertmanager = true
  enable_elasticsearch = var.environment == "production"
  enable_jaeger       = true
  
  retention_days      = var.backup_retention_days
  
  depends_on = [module.kubernetes]
  tags       = local.common_tags
}

# Output values for consumption by other configurations
output "vpc_id" {
  description = "ID of the VPC"
  value       = module.networking.vpc_id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets"
  value       = module.networking.private_subnet_ids
}

output "public_subnet_ids" {
  description = "IDs of the public subnets"
  value       = module.networking.public_subnet_ids
}

output "cluster_name" {
  description = "Name of the EKS cluster"
  value       = module.kubernetes.cluster_name
}

output "cluster_endpoint" {
  description = "Endpoint for EKS control plane"
  value       = module.kubernetes.cluster_endpoint
  sensitive   = true
}

output "database_endpoint" {
  description = "Database instance endpoint"
  value       = module.database.endpoint
  sensitive   = true
}

output "load_balancer_dns" {
  description = "DNS name of the load balancer"
  value       = module.compute.load_balancer_dns
}
```

### Advanced Pulumi Enterprise Implementation

Pulumi enables infrastructure programming using familiar languages with sophisticated state management, policy enforcement, and cloud-native integration capabilities.

```typescript
// pulumi/infrastructure/production/index.ts
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as azure from "@pulumi/azure-native";
import * as gcp from "@pulumi/gcp";
import * as kubernetes from "@pulumi/kubernetes";
import * as policy from "@pulumi/policy";

// Configuration management with type safety
interface EnvironmentConfig {
  instanceType: string;
  minSize: number;
  maxSize: number;
  desiredSize: number;
  enableHighAvailability: boolean;
  enableEncryption: boolean;
  backupRetentionDays: number;
}

interface NetworkConfig {
  vpcCidr: string;
  availabilityZones: string[];
  enableNatGateway: boolean;
  enableVpnGateway: boolean;
}

interface SecurityConfig {
  enableWaf: boolean;
  enableShield: boolean;
  enableGuardDuty: boolean;
  kmsKeyDeletionWindow: number;
}

// Environment-specific configurations
const environmentConfigs: Record<string, EnvironmentConfig> = {
  production: {
    instanceType: "m5.xlarge",
    minSize: 3,
    maxSize: 10,
    desiredSize: 5,
    enableHighAvailability: true,
    enableEncryption: true,
    backupRetentionDays: 30,
  },
  staging: {
    instanceType: "m5.large",
    minSize: 1,
    maxSize: 3,
    desiredSize: 2,
    enableHighAvailability: false,
    enableEncryption: true,
    backupRetentionDays: 7,
  },
  development: {
    instanceType: "m5.medium",
    minSize: 1,
    maxSize: 2,
    desiredSize: 1,
    enableHighAvailability: false,
    enableEncryption: false,
    backupRetentionDays: 3,
  },
};

// Pulumi configuration with validation
const config = new pulumi.Config();
const environment = config.require("environment");
const projectName = config.require("projectName");
const awsRegion = config.get("awsRegion") || "us-west-2";
const kubernetesVersion = config.get("kubernetesVersion") || "1.29";

// Validate environment configuration
if (!environmentConfigs[environment]) {
  throw new Error(`Invalid environment: ${environment}. Must be one of: ${Object.keys(environmentConfigs).join(", ")}`);
}

const envConfig = environmentConfigs[environment];

// AWS provider configuration with enhanced security
const awsProvider = new aws.Provider("aws-provider", {
  region: awsRegion,
  assumeRole: {
    roleArn: config.get("awsAssumeRoleArn"),
    sessionName: `pulumi-${environment}-session`,
    externalId: config.get("awsExternalId"),
  },
  defaultTags: {
    tags: {
      Environment: environment,
      Project: projectName,
      ManagedBy: "pulumi",
      Owner: config.get("teamOwner") || "platform-team",
      CostCenter: config.get("costCenter") || "engineering",
      DataClassification: config.get("dataClassification") || "internal",
      CreatedDate: new Date().toISOString().split('T')[0],
    },
  },
});

// Advanced networking infrastructure with multi-AZ support
class NetworkingInfrastructure extends pulumi.ComponentResource {
  public readonly vpc: aws.ec2.Vpc;
  public readonly internetGateway: aws.ec2.InternetGateway;
  public readonly natGateways: aws.ec2.NatGateway[];
  public readonly publicSubnets: aws.ec2.Subnet[];
  public readonly privateSubnets: aws.ec2.Subnet[];
  public readonly databaseSubnets: aws.ec2.Subnet[];
  public readonly routeTables: aws.ec2.RouteTable[];

  constructor(name: string, args: NetworkConfig, opts?: pulumi.ComponentResourceOptions) {
    super("custom:infrastructure:Networking", name, {}, opts);

    // VPC with DNS support and enhanced networking
    this.vpc = new aws.ec2.Vpc(`${name}-vpc`, {
      cidrBlock: args.vpcCidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      enableNetworkAddressUsageMetrics: true,
      tags: {
        Name: `${projectName}-${environment}-vpc`,
        Type: "networking",
      },
    }, { parent: this, provider: awsProvider });

    // Internet Gateway for public internet access
    this.internetGateway = new aws.ec2.InternetGateway(`${name}-igw`, {
      vpcId: this.vpc.id,
      tags: {
        Name: `${projectName}-${environment}-igw`,
      },
    }, { parent: this, provider: awsProvider });

    // Get availability zones
    const azs = aws.getAvailabilityZones({
      state: "available",
    });

    // Create subnets across multiple availability zones
    this.publicSubnets = [];
    this.privateSubnets = [];
    this.databaseSubnets = [];
    this.natGateways = [];

    for (let i = 0; i < 3; i++) {
      const az = azs.then(azs => azs.names[i]);

      // Public subnets
      const publicSubnet = new aws.ec2.Subnet(`${name}-public-${i}`, {
        vpcId: this.vpc.id,
        cidrBlock: pulumi.interpolate`${args.vpcCidr.split('.')[0]}.${args.vpcCidr.split('.')[1]}.${10 + i}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: {
          Name: `${projectName}-${environment}-public-${i}`,
          Type: "public",
          "kubernetes.io/role/elb": "1",
        },
      }, { parent: this, provider: awsProvider });
      this.publicSubnets.push(publicSubnet);

      // NAT Gateway for private subnet internet access
      if (args.enableNatGateway) {
        const eip = new aws.ec2.Eip(`${name}-nat-eip-${i}`, {
          domain: "vpc",
          tags: {
            Name: `${projectName}-${environment}-nat-eip-${i}`,
          },
        }, { parent: this, provider: awsProvider });

        const natGateway = new aws.ec2.NatGateway(`${name}-nat-${i}`, {
          allocationId: eip.id,
          subnetId: publicSubnet.id,
          tags: {
            Name: `${projectName}-${environment}-nat-${i}`,
          },
        }, { parent: this, provider: awsProvider });
        this.natGateways.push(natGateway);
      }

      // Private subnets
      const privateSubnet = new aws.ec2.Subnet(`${name}-private-${i}`, {
        vpcId: this.vpc.id,
        cidrBlock: pulumi.interpolate`${args.vpcCidr.split('.')[0]}.${args.vpcCidr.split('.')[1]}.${i}.0/24`,
        availabilityZone: az,
        tags: {
          Name: `${projectName}-${environment}-private-${i}`,
          Type: "private",
          "kubernetes.io/role/internal-elb": "1",
        },
      }, { parent: this, provider: awsProvider });
      this.privateSubnets.push(privateSubnet);

      // Database subnets
      const databaseSubnet = new aws.ec2.Subnet(`${name}-database-${i}`, {
        vpcId: this.vpc.id,
        cidrBlock: pulumi.interpolate`${args.vpcCidr.split('.')[0]}.${args.vpcCidr.split('.')[1]}.${20 + i}.0/24`,
        availabilityZone: az,
        tags: {
          Name: `${projectName}-${environment}-database-${i}`,
          Type: "database",
        },
      }, { parent: this, provider: awsProvider });
      this.databaseSubnets.push(databaseSubnet);
    }

    // Route tables and associations
    this.routeTables = [];

    // Public route table
    const publicRouteTable = new aws.ec2.RouteTable(`${name}-public-rt`, {
      vpcId: this.vpc.id,
      tags: {
        Name: `${projectName}-${environment}-public-rt`,
      },
    }, { parent: this, provider: awsProvider });

    new aws.ec2.Route(`${name}-public-route`, {
      routeTableId: publicRouteTable.id,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: this.internetGateway.id,
    }, { parent: this, provider: awsProvider });

    this.publicSubnets.forEach((subnet, i) => {
      new aws.ec2.RouteTableAssociation(`${name}-public-rta-${i}`, {
        subnetId: subnet.id,
        routeTableId: publicRouteTable.id,
      }, { parent: this, provider: awsProvider });
    });

    // Private route tables (one per AZ for high availability)
    this.privateSubnets.forEach((subnet, i) => {
      const privateRouteTable = new aws.ec2.RouteTable(`${name}-private-rt-${i}`, {
        vpcId: this.vpc.id,
        tags: {
          Name: `${projectName}-${environment}-private-rt-${i}`,
        },
      }, { parent: this, provider: awsProvider });

      if (this.natGateways[i]) {
        new aws.ec2.Route(`${name}-private-route-${i}`, {
          routeTableId: privateRouteTable.id,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: this.natGateways[i].id,
        }, { parent: this, provider: awsProvider });
      }

      new aws.ec2.RouteTableAssociation(`${name}-private-rta-${i}`, {
        subnetId: subnet.id,
        routeTableId: privateRouteTable.id,
      }, { parent: this, provider: awsProvider });

      this.routeTables.push(privateRouteTable);
    });

    this.registerOutputs({
      vpcId: this.vpc.id,
      publicSubnetIds: this.publicSubnets.map(s => s.id),
      privateSubnetIds: this.privateSubnets.map(s => s.id),
      databaseSubnetIds: this.databaseSubnets.map(s => s.id),
    });
  }
}

// Enhanced security infrastructure with comprehensive protection
class SecurityInfrastructure extends pulumi.ComponentResource {
  public readonly kmsKey: aws.kms.Key;
  public readonly webSecurityGroup: aws.ec2.SecurityGroup;
  public readonly appSecurityGroup: aws.ec2.SecurityGroup;
  public readonly databaseSecurityGroup: aws.ec2.SecurityGroup;
  public readonly wafWebAcl?: aws.wafv2.WebAcl;

  constructor(name: string, args: { vpcId: pulumi.Input<string>; securityConfig: SecurityConfig }, opts?: pulumi.ComponentResourceOptions) {
    super("custom:infrastructure:Security", name, {}, opts);

    // KMS key for encryption at rest
    this.kmsKey = new aws.kms.Key(`${name}-kms`, {
      description: `KMS key for ${projectName} ${environment} environment`,
      deletionWindowInDays: args.securityConfig.kmsKeyDeletionWindow,
      enableKeyRotation: true,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "Enable IAM User Permissions",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${aws.getCallerIdentity().then(id => id.accountId)}:root` },
            Action: "kms:*",
            Resource: "*",
          },
          {
            Sid: "Allow CloudWatch Logs",
            Effect: "Allow",
            Principal: { Service: `logs.${awsRegion}.amazonaws.com` },
            Action: [
              "kms:Encrypt",
              "kms:Decrypt",
              "kms:ReEncrypt*",
              "kms:GenerateDataKey*",
              "kms:DescribeKey",
            ],
            Resource: "*",
          },
        ],
      }),
      tags: {
        Name: `${projectName}-${environment}-kms`,
      },
    }, { parent: this, provider: awsProvider });

    // Security groups with principle of least privilege
    this.webSecurityGroup = new aws.ec2.SecurityGroup(`${name}-web-sg`, {
      name: `${projectName}-${environment}-web-sg`,
      description: "Security group for web tier",
      vpcId: args.vpcId,
      
      ingress: [
        {
          fromPort: 80,
          toPort: 80,
          protocol: "tcp",
          cidrBlocks: ["0.0.0.0/0"],
          description: "HTTP from internet",
        },
        {
          fromPort: 443,
          toPort: 443,
          protocol: "tcp",
          cidrBlocks: ["0.0.0.0/0"],
          description: "HTTPS from internet",
        },
      ],
      
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          description: "All outbound traffic",
        },
      ],
      
      tags: {
        Name: `${projectName}-${environment}-web-sg`,
        Tier: "web",
      },
    }, { parent: this, provider: awsProvider });

    this.appSecurityGroup = new aws.ec2.SecurityGroup(`${name}-app-sg`, {
      name: `${projectName}-${environment}-app-sg`,
      description: "Security group for application tier",
      vpcId: args.vpcId,
      
      ingress: [
        {
          fromPort: 8080,
          toPort: 8080,
          protocol: "tcp",
          securityGroups: [this.webSecurityGroup.id],
          description: "Application port from web tier",
        },
        {
          fromPort: 9090,
          toPort: 9090,
          protocol: "tcp",
          securityGroups: [this.webSecurityGroup.id],
          description: "Metrics port from web tier",
        },
      ],
      
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          description: "All outbound traffic",
        },
      ],
      
      tags: {
        Name: `${projectName}-${environment}-app-sg`,
        Tier: "application",
      },
    }, { parent: this, provider: awsProvider });

    this.databaseSecurityGroup = new aws.ec2.SecurityGroup(`${name}-db-sg`, {
      name: `${projectName}-${environment}-db-sg`,
      description: "Security group for database tier",
      vpcId: args.vpcId,
      
      ingress: [
        {
          fromPort: 5432,
          toPort: 5432,
          protocol: "tcp",
          securityGroups: [this.appSecurityGroup.id],
          description: "PostgreSQL from application tier",
        },
      ],
      
      tags: {
        Name: `${projectName}-${environment}-db-sg`,
        Tier: "database",
      },
    }, { parent: this, provider: awsProvider });

    // WAF Web ACL for production environments
    if (args.securityConfig.enableWaf) {
      this.wafWebAcl = new aws.wafv2.WebAcl(`${name}-waf`, {
        name: `${projectName}-${environment}-waf`,
        description: "WAF for web application protection",
        scope: "REGIONAL",
        
        defaultAction: {
          allow: {},
        },
        
        rules: [
          {
            name: "AWSManagedRulesCommonRuleSet",
            priority: 1,
            action: {
              block: {},
            },
            statement: {
              managedRuleGroupStatement: {
                name: "AWSManagedRulesCommonRuleSet",
                vendorName: "AWS",
                excludedRules: [
                  { name: "SizeRestrictions_BODY" },
                  { name: "GenericRFI_BODY" },
                ],
              },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: "CommonRuleSetMetric",
              sampledRequestsEnabled: true,
            },
          },
          {
            name: "AWSManagedRulesKnownBadInputsRuleSet",
            priority: 2,
            action: {
              block: {},
            },
            statement: {
              managedRuleGroupStatement: {
                name: "AWSManagedRulesKnownBadInputsRuleSet",
                vendorName: "AWS",
              },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: "KnownBadInputsMetric",
              sampledRequestsEnabled: true,
            },
          },
          {
            name: "RateLimitRule",
            priority: 3,
            action: {
              block: {},
            },
            statement: {
              rateBasedStatement: {
                limit: 10000,
                aggregateKeyType: "IP",
              },
            },
            visibilityConfig: {
              cloudwatchMetricsEnabled: true,
              metricName: "RateLimitMetric",
              sampledRequestsEnabled: true,
            },
          },
        ],
        
        visibilityConfig: {
          cloudwatchMetricsEnabled: true,
          metricName: `${projectName}-${environment}-waf`,
          sampledRequestsEnabled: true,
        },
        
        tags: {
          Name: `${projectName}-${environment}-waf`,
        },
      }, { parent: this, provider: awsProvider });
    }

    // Enable GuardDuty for threat detection
    if (args.securityConfig.enableGuardDuty) {
      new aws.guardduty.Detector(`${name}-guardduty`, {
        enable: true,
        findingPublishingFrequency: "FIFTEEN_MINUTES",
        
        datasources: {
          s3Logs: { enable: true },
          kubernetes: { auditLogs: { enable: true } },
          malwareProtection: { scanEc2InstanceWithFindings: { ebsVolumes: { enable: true } } },
        },
        
        tags: {
          Name: `${projectName}-${environment}-guardduty`,
        },
      }, { parent: this, provider: awsProvider });
    }

    this.registerOutputs({
      kmsKeyId: this.kmsKey.id,
      webSecurityGroupId: this.webSecurityGroup.id,
      appSecurityGroupId: this.appSecurityGroup.id,
      databaseSecurityGroupId: this.databaseSecurityGroup.id,
      wafWebAclId: this.wafWebAcl?.id,
    });
  }
}

// EKS cluster with advanced configuration and add-ons
class KubernetesInfrastructure extends pulumi.ComponentResource {
  public readonly cluster: aws.eks.Cluster;
  public readonly nodeGroup: aws.eks.NodeGroup;
  public readonly addOns: aws.eks.Addon[];

  constructor(
    name: string,
    args: {
      vpcId: pulumi.Input<string>;
      privateSubnetIds: pulumi.Input<string>[];
      publicSubnetIds: pulumi.Input<string>[];
      securityGroupId: pulumi.Input<string>;
      kmsKeyId: pulumi.Input<string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("custom:infrastructure:Kubernetes", name, {}, opts);

    // IAM role for EKS cluster
    const clusterRole = new aws.iam.Role(`${name}-cluster-role`, {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "eks.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      tags: {
        Name: `${projectName}-${environment}-cluster-role`,
      },
    }, { parent: this, provider: awsProvider });

    new aws.iam.RolePolicyAttachment(`${name}-cluster-policy`, {
      role: clusterRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    }, { parent: this, provider: awsProvider });

    // EKS cluster with comprehensive configuration
    this.cluster = new aws.eks.Cluster(`${name}-cluster`, {
      name: `${projectName}-${environment}-cluster`,
      version: kubernetesVersion,
      roleArn: clusterRole.arn,
      
      vpcConfig: {
        subnetIds: pulumi.all([args.privateSubnetIds, args.publicSubnetIds]).apply(([privateIds, publicIds]) => [...privateIds, ...publicIds]),
        endpointPrivateAccess: true,
        endpointPublicAccess: environment !== "production",
        endpointPublicAccessCidrs: environment === "production" ? ["10.0.0.0/8"] : ["0.0.0.0/0"],
        securityGroupIds: [args.securityGroupId],
      },
      
      encryptionConfig: envConfig.enableEncryption ? {
        provider: {
          keyArn: args.kmsKeyId,
        },
        resources: ["secrets"],
      } : undefined,
      
      enabledClusterLogTypes: ["api", "audit", "authenticator", "controllerManager", "scheduler"],
      
      tags: {
        Name: `${projectName}-${environment}-cluster`,
        Environment: environment,
      },
    }, { parent: this, provider: awsProvider });

    // IAM role for node group
    const nodeRole = new aws.iam.Role(`${name}-node-role`, {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      tags: {
        Name: `${projectName}-${environment}-node-role`,
      },
    }, { parent: this, provider: awsProvider });

    const nodePolicies = [
      "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
      "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
      "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    ];

    nodePolicies.forEach((policy, index) => {
      new aws.iam.RolePolicyAttachment(`${name}-node-policy-${index}`, {
        role: nodeRole.name,
        policyArn: policy,
      }, { parent: this, provider: awsProvider });
    });

    // EKS node group with advanced configuration
    this.nodeGroup = new aws.eks.NodeGroup(`${name}-node-group`, {
      clusterName: this.cluster.name,
      nodeGroupName: `${projectName}-${environment}-nodes`,
      nodeRoleArn: nodeRole.arn,
      subnetIds: args.privateSubnetIds,
      
      instanceTypes: [envConfig.instanceType],
      amiType: "AL2_x86_64",
      capacityType: "ON_DEMAND",
      diskSize: 100,
      
      scalingConfig: {
        desiredSize: envConfig.desiredSize,
        maxSize: envConfig.maxSize,
        minSize: envConfig.minSize,
      },
      
      updateConfig: {
        maxUnavailablePercentage: 25,
      },
      
      remoteAccess: {
        ec2SshKey: config.get("sshKeyName"),
        sourceSecurityGroupIds: [args.securityGroupId],
      },
      
      launchTemplate: {
        name: pulumi.interpolate`${this.cluster.name}-launch-template`,
        version: "$Latest",
      },
      
      tags: {
        Name: `${projectName}-${environment}-node-group`,
        Environment: environment,
      },
    }, { parent: this, provider: awsProvider });

    // EKS add-ons for enhanced functionality
    this.addOns = [];
    const addOnConfigs = [
      { name: "vpc-cni", version: "v1.16.0-eksbuild.1" },
      { name: "coredns", version: "v1.10.1-eksbuild.7" },
      { name: "kube-proxy", version: "v1.29.0-eksbuild.1" },
      { name: "aws-ebs-csi-driver", version: "v1.26.1-eksbuild.1" },
    ];

    addOnConfigs.forEach((addonConfig) => {
      const addon = new aws.eks.Addon(`${name}-addon-${addonConfig.name}`, {
        clusterName: this.cluster.name,
        addonName: addonConfig.name,
        addonVersion: addonConfig.version,
        resolveConflicts: "OVERWRITE",
        tags: {
          Name: `${projectName}-${environment}-${addonConfig.name}`,
        },
      }, { parent: this, provider: awsProvider });
      this.addOns.push(addon);
    });

    this.registerOutputs({
      clusterName: this.cluster.name,
      clusterEndpoint: this.cluster.endpoint,
      clusterArn: this.cluster.arn,
      nodeGroupArn: this.nodeGroup.arn,
    });
  }
}

// Main infrastructure orchestration
async function main() {
  // Network infrastructure
  const networking = new NetworkingInfrastructure("networking", {
    vpcCidr: "10.0.0.0/16",
    availabilityZones: [], // Will be populated automatically
    enableNatGateway: true,
    enableVpnGateway: environment === "production",
  });

  // Security infrastructure
  const security = new SecurityInfrastructure("security", {
    vpcId: networking.vpc.id,
    securityConfig: {
      enableWaf: environment === "production",
      enableShield: environment === "production",
      enableGuardDuty: true,
      kmsKeyDeletionWindow: environment === "production" ? 30 : 7,
    },
  });

  // Kubernetes infrastructure
  const kubernetes = new KubernetesInfrastructure("kubernetes", {
    vpcId: networking.vpc.id,
    privateSubnetIds: networking.privateSubnets.map(s => s.id),
    publicSubnetIds: networking.publicSubnets.map(s => s.id),
    securityGroupId: security.appSecurityGroup.id,
    kmsKeyId: security.kmsKey.id,
  });

  // Export important infrastructure outputs
  return {
    vpcId: networking.vpc.id,
    clusterName: kubernetes.cluster.name,
    clusterEndpoint: kubernetes.cluster.endpoint,
    securityGroupIds: {
      web: security.webSecurityGroup.id,
      app: security.appSecurityGroup.id,
      database: security.databaseSecurityGroup.id,
    },
    kmsKeyId: security.kmsKey.id,
  };
}

// Execute main function and export outputs
export = main();
```

## [Multi-Cloud Infrastructure Management](#multi-cloud-infrastructure-management)

### Terraform Multi-Cloud Architecture

Enterprise organizations require sophisticated multi-cloud strategies that provide flexibility, resilience, and vendor independence while maintaining consistent operational patterns across diverse cloud platforms.

```hcl
# terraform/multi-cloud/main.tf
terraform {
  required_version = ">= 1.7.0"
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.95"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 5.15"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25"
    }
  }
}

# Multi-cloud provider configurations
locals {
  cloud_regions = {
    aws = {
      primary   = "us-west-2"
      secondary = "us-east-1"
      tertiary  = "eu-west-1"
    }
    azure = {
      primary   = "West US 2"
      secondary = "East US"
      tertiary  = "West Europe"
    }
    gcp = {
      primary   = "us-west1"
      secondary = "us-east1"
      tertiary  = "europe-west1"
    }
  }
  
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
    Owner       = var.team_owner
    MultiCloud  = "true"
  }
}

# AWS Configuration
provider "aws" {
  alias  = "primary"
  region = local.cloud_regions.aws.primary
  
  default_tags {
    tags = merge(local.common_tags, {
      Cloud  = "aws"
      Region = local.cloud_regions.aws.primary
    })
  }
}

provider "aws" {
  alias  = "secondary"
  region = local.cloud_regions.aws.secondary
  
  default_tags {
    tags = merge(local.common_tags, {
      Cloud  = "aws"
      Region = local.cloud_regions.aws.secondary
    })
  }
}

# Azure Configuration
provider "azurerm" {
  alias = "primary"
  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}

# GCP Configuration
provider "google" {
  alias   = "primary"
  project = var.gcp_project_id
  region  = local.cloud_regions.gcp.primary
}

# Multi-cloud networking with peering
module "aws_networking" {
  source = "./modules/aws-networking"
  
  providers = {
    aws = aws.primary
  }
  
  environment    = var.environment
  vpc_cidr      = "10.0.0.0/16"
  region        = local.cloud_regions.aws.primary
  enable_peering = true
  
  tags = local.common_tags
}

module "azure_networking" {
  source = "./modules/azure-networking"
  
  providers = {
    azurerm = azurerm.primary
  }
  
  environment      = var.environment
  vnet_cidr       = "10.1.0.0/16"
  location        = local.cloud_regions.azure.primary
  enable_peering  = true
  
  tags = local.common_tags
}

module "gcp_networking" {
  source = "./modules/gcp-networking"
  
  providers = {
    google = google.primary
  }
  
  environment    = var.environment
  vpc_cidr      = "10.2.0.0/16"
  region        = local.cloud_regions.gcp.primary
  enable_peering = true
  
  labels = local.common_tags
}

# Multi-cloud Kubernetes clusters
module "aws_eks" {
  source = "./modules/aws-eks"
  
  providers = {
    aws = aws.primary
  }
  
  cluster_name       = "${var.project_name}-${var.environment}-aws"
  vpc_id            = module.aws_networking.vpc_id
  subnet_ids        = module.aws_networking.private_subnet_ids
  kubernetes_version = var.kubernetes_version
  
  node_groups = {
    general = {
      instance_types = ["m5.large"]
      min_size      = 1
      max_size      = 10
      desired_size  = 3
    }
    spot = {
      instance_types = ["m5.large", "m5a.large", "m5d.large"]
      capacity_type  = "SPOT"
      min_size      = 0
      max_size      = 20
      desired_size  = 5
    }
  }
  
  tags = local.common_tags
}

module "azure_aks" {
  source = "./modules/azure-aks"
  
  providers = {
    azurerm = azurerm.primary
  }
  
  cluster_name       = "${var.project_name}-${var.environment}-azure"
  resource_group_id  = module.azure_networking.resource_group_id
  vnet_subnet_id    = module.azure_networking.private_subnet_id
  kubernetes_version = var.kubernetes_version
  
  node_pools = {
    system = {
      vm_size   = "Standard_D2s_v3"
      min_count = 1
      max_count = 5
      node_count = 3
    }
    user = {
      vm_size   = "Standard_D4s_v3"
      min_count = 0
      max_count = 20
      node_count = 5
    }
  }
  
  tags = local.common_tags
}

module "gcp_gke" {
  source = "./modules/gcp-gke"
  
  providers = {
    google = google.primary
  }
  
  cluster_name       = "${var.project_name}-${var.environment}-gcp"
  network           = module.gcp_networking.network_name
  subnetwork        = module.gcp_networking.private_subnet_name
  kubernetes_version = var.kubernetes_version
  
  node_pools = {
    default = {
      machine_type = "e2-standard-4"
      min_count    = 1
      max_count    = 10
      node_count   = 3
    }
    preemptible = {
      machine_type = "e2-standard-4"
      preemptible  = true
      min_count    = 0
      max_count    = 20
      node_count   = 5
    }
  }
  
  labels = local.common_tags
}

# Multi-cloud service mesh (Istio) configuration
module "istio_multi_cloud" {
  source = "./modules/istio-multi-cloud"
  
  clusters = {
    aws = {
      name      = module.aws_eks.cluster_name
      endpoint  = module.aws_eks.cluster_endpoint
      ca_cert   = module.aws_eks.cluster_ca_certificate
      region    = local.cloud_regions.aws.primary
      cloud     = "aws"
    }
    azure = {
      name      = module.azure_aks.cluster_name
      endpoint  = module.azure_aks.cluster_endpoint
      ca_cert   = module.azure_aks.cluster_ca_certificate
      region    = local.cloud_regions.azure.primary
      cloud     = "azure"
    }
    gcp = {
      name      = module.gcp_gke.cluster_name
      endpoint  = module.gcp_gke.cluster_endpoint
      ca_cert   = module.gcp_gke.cluster_ca_certificate
      region    = local.cloud_regions.gcp.primary
      cloud     = "gcp"
    }
  }
  
  enable_cross_network_policy = true
  enable_multi_primary       = true
  enable_locality_failover   = true
  
  tags = local.common_tags
}

# Multi-cloud monitoring and observability
module "monitoring_multi_cloud" {
  source = "./modules/monitoring-multi-cloud"
  
  clusters = {
    aws   = module.aws_eks.cluster_name
    azure = module.azure_aks.cluster_name
    gcp   = module.gcp_gke.cluster_name
  }
  
  enable_prometheus_federation = true
  enable_grafana_multi_cluster = true
  enable_jaeger_tracing       = true
  enable_centralized_logging  = true
  
  monitoring_namespace = "monitoring"
  
  tags = local.common_tags
}

# Output multi-cloud infrastructure details
output "infrastructure_summary" {
  value = {
    aws = {
      vpc_id       = module.aws_networking.vpc_id
      cluster_name = module.aws_eks.cluster_name
      endpoint     = module.aws_eks.cluster_endpoint
      region       = local.cloud_regions.aws.primary
    }
    azure = {
      vnet_id      = module.azure_networking.vnet_id
      cluster_name = module.azure_aks.cluster_name
      endpoint     = module.azure_aks.cluster_endpoint
      region       = local.cloud_regions.azure.primary
    }
    gcp = {
      network_name = module.gcp_networking.network_name
      cluster_name = module.gcp_gke.cluster_name
      endpoint     = module.gcp_gke.cluster_endpoint
      region       = local.cloud_regions.gcp.primary
    }
  }
  
  description = "Multi-cloud infrastructure summary"
  sensitive   = true
}
```

## [State Management and Backend Configuration](#state-management-backend-configuration)

### Advanced Terraform State Management

Enterprise Terraform implementations require sophisticated state management strategies that ensure consistency, security, and collaboration across distributed teams and environments.

```hcl
# terraform/backend-config/main.tf
# Advanced S3 backend configuration with encryption and locking
terraform {
  backend "s3" {
    # Primary state bucket with versioning and encryption
    bucket = "company-terraform-state-primary"
    key    = "infrastructure/${var.environment}/${var.component}/terraform.tfstate"
    region = "us-west-2"
    
    # Encryption configuration
    encrypt    = true
    kms_key_id = "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012"
    
    # State locking with DynamoDB
    dynamodb_table = "terraform-state-lock"
    
    # Cross-region replication for disaster recovery
    backup_file_path = "s3://company-terraform-state-backup/infrastructure/${var.environment}/${var.component}/terraform.tfstate"
    
    # Workspace management
    workspace_key_prefix = "workspaces"
    
    # Access control
    assume_role {
      role_arn     = "arn:aws:iam::123456789012:role/TerraformStateManagement"
      session_name = "terraform-state-session"
      external_id  = var.external_id
    }
    
    # Enhanced security settings
    skip_region_validation         = false
    skip_credentials_validation    = false
    skip_metadata_api_check       = false
    force_path_style              = false
    shared_credentials_file       = ""
    profile                       = ""
  }
}

# State bucket configuration with advanced security
resource "aws_s3_bucket" "terraform_state" {
  bucket = "company-terraform-state-primary"
  
  tags = {
    Name        = "Terraform State Bucket"
    Environment = "global"
    Purpose     = "terraform-state"
    Encryption  = "enabled"
  }
}

# Bucket versioning for state history
resource "aws_s3_bucket_versioning" "terraform_state_versioning" {
  bucket = aws_s3_bucket.terraform_state.id
  
  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption configuration
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state_encryption" {
  bucket = aws_s3_bucket.terraform_state.id
  
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_state_key.arn
      sse_algorithm     = "aws:kms"
    }
    
    bucket_key_enabled = true
  }
}

# Public access block for security
resource "aws_s3_bucket_public_access_block" "terraform_state_pab" {
  bucket = aws_s3_bucket.terraform_state.id
  
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle policy for state management
resource "aws_s3_bucket_lifecycle_configuration" "terraform_state_lifecycle" {
  bucket = aws_s3_bucket.terraform_state.id
  
  rule {
    id     = "state_lifecycle"
    status = "Enabled"
    
    expiration {
      expired_object_delete_marker = true
    }
    
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    
    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }
    
    noncurrent_version_transition {
      noncurrent_days = 60
      storage_class   = "GLACIER"
    }
  }
}

# Cross-region replication for disaster recovery
resource "aws_s3_bucket" "terraform_state_backup" {
  provider = aws.backup_region
  bucket   = "company-terraform-state-backup"
  
  tags = {
    Name        = "Terraform State Backup Bucket"
    Environment = "global"
    Purpose     = "terraform-state-backup"
  }
}

resource "aws_s3_bucket_replication_configuration" "terraform_state_replication" {
  role   = aws_iam_role.replication.arn
  bucket = aws_s3_bucket.terraform_state.id
  
  rule {
    id     = "state_backup_replication"
    status = "Enabled"
    
    destination {
      bucket        = aws_s3_bucket.terraform_state_backup.arn
      storage_class = "STANDARD_IA"
      
      encryption_configuration {
        replica_kms_key_id = aws_kms_key.terraform_state_backup_key.arn
      }
    }
  }
  
  depends_on = [aws_s3_bucket_versioning.terraform_state_versioning]
}

# DynamoDB table for state locking
resource "aws_dynamodb_table" "terraform_state_lock" {
  name           = "terraform-state-lock"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "LockID"
  
  attribute {
    name = "LockID"
    type = "S"
  }
  
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.terraform_state_key.arn
  }
  
  point_in_time_recovery {
    enabled = true
  }
  
  tags = {
    Name        = "Terraform State Lock Table"
    Environment = "global"
    Purpose     = "terraform-state-lock"
  }
}

# KMS key for state encryption
resource "aws_kms_key" "terraform_state_key" {
  description             = "KMS key for Terraform state encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Enable IAM User Permissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "Allow Terraform State Access"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/TerraformStateManagement"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })
  
  tags = {
    Name        = "Terraform State KMS Key"
    Environment = "global"
    Purpose     = "terraform-state-encryption"
  }
}

# State management automation script
resource "local_file" "state_management_script" {
  filename = "${path.module}/scripts/state-management.sh"
  content = templatefile("${path.module}/templates/state-management.sh.tpl", {
    state_bucket         = aws_s3_bucket.terraform_state.id
    backup_bucket        = aws_s3_bucket.terraform_state_backup.id
    dynamodb_table       = aws_dynamodb_table.terraform_state_lock.name
    kms_key_id          = aws_kms_key.terraform_state_key.id
    aws_region          = var.aws_region
    backup_region       = var.backup_region
  })
  
  file_permission = "0755"
}
```

This comprehensive Infrastructure as Code guide provides enterprise-ready patterns and configurations for advanced infrastructure automation using Terraform and Pulumi. The framework supports multi-cloud deployment, sophisticated state management, security integration, and operational monitoring necessary for production environments.

Key benefits of this advanced IaC approach include:

- **Declarative Infrastructure**: Complete infrastructure state managed through code
- **Multi-Cloud Flexibility**: Consistent patterns across AWS, Azure, and GCP
- **State Management**: Secure, distributed state with backup and recovery
- **Security Integration**: Encryption, access control, and policy enforcement
- **Operational Excellence**: Monitoring, alerting, and automation workflows
- **Scalability**: Enterprise-grade patterns for complex environments

The implementation patterns demonstrated here enable organizations to achieve reliable, secure, and scalable infrastructure automation at enterprise scale while maintaining operational excellence and security standards.