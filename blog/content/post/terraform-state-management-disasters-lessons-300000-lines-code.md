---
title: "Terraform State Management Disasters: Lessons from 300,000 Lines of Code"
date: 2026-12-01T00:00:00-05:00
draft: false
tags: ["Terraform", "Infrastructure as Code", "State Management", "DevOps", "Disaster Recovery", "Best Practices", "Production"]
categories: ["Infrastructure as Code", "DevOps", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive analysis of Terraform state management disasters based on Gruntwork's experience with 300,000+ lines of infrastructure code, including state corruption, locking issues, and production-ready solutions for enterprise deployments."
more_link: "yes"
url: "/terraform-state-management-disasters-lessons-300000-lines-code/"
---

Gruntwork's infrastructure codebase spans over 300,000 lines of Terraform code managing critical infrastructure for hundreds of customers. This scale has exposed every possible failure mode in Terraform state management—from state file corruption that destroyed entire environments to locking conflicts that blocked deployments for hours. These hard-learned lessons provide invaluable insights for any organization managing production infrastructure with Terraform. This comprehensive guide explores real-world state management disasters and implements production-hardened solutions to prevent catastrophic failures.

<!--more-->

## Executive Summary

Terraform state files are the single source of truth for your infrastructure, making them simultaneously the most critical and most vulnerable component of your infrastructure-as-code system. State file corruption, lost state, locking conflicts, and monolithic state files have all caused production outages and data loss. This post provides a complete framework for enterprise-grade Terraform state management, including remote backends, state isolation strategies, disaster recovery procedures, and architectural patterns learned from managing massive-scale infrastructure deployments.

## Understanding Terraform State Architecture

### What is Terraform State?

Terraform state is a JSON file that maps your configuration to real-world resources:

```json
{
  "version": 4,
  "terraform_version": "1.6.0",
  "serial": 42,
  "lineage": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "outputs": {},
  "resources": [
    {
      "mode": "managed",
      "type": "aws_instance",
      "name": "web",
      "provider": "provider[\"registry.terraform.io/hashicorp/aws\"]",
      "instances": [
        {
          "schema_version": 1,
          "attributes": {
            "id": "i-0123456789abcdef",
            "ami": "ami-0c55b159cbfafe1f0",
            "instance_type": "t3.micro",
            "private_ip": "10.0.1.42",
            "public_ip": "54.123.45.67",
            "tags": {
              "Name": "web-server-01"
            }
          },
          "sensitive_attributes": [],
          "private": "eyJlMmJmYjczMC...",
          "dependencies": [
            "aws_security_group.web",
            "aws_subnet.public"
          ]
        }
      ]
    }
  ]
}
```

### State File Components

```
┌─────────────────────────────────────────────────────────────────┐
│                     Terraform State File                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Metadata                                                   │ │
│  │  - Version: State format version                           │ │
│  │  - Terraform Version: Version that wrote this state        │ │
│  │  - Serial: Incrementing counter for state versions         │ │
│  │  - Lineage: UUID tracking state file identity              │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Resources                                                  │ │
│  │  For each managed resource:                                │ │
│  │    - Resource type (aws_instance, google_compute_instance) │ │
│  │    - Resource name (from configuration)                    │ │
│  │    - Provider information                                  │ │
│  │    - Current attributes (all resource properties)          │ │
│  │    - Metadata (schema version, dependencies)               │ │
│  │    - Sensitive attributes (marked as sensitive)            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Outputs                                                    │ │
│  │  - Named output values                                     │ │
│  │  - Values exported from this configuration                 │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Data Sources                                               │ │
│  │  - Read-only resources                                     │ │
│  │  - Query results from providers                            │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Disaster Scenario 1: State File Corruption

### The Incident

A team member running `terraform apply` experienced a network interruption mid-apply. The state file was partially written, creating a corrupted state that left infrastructure in an inconsistent state—some resources created, others not, and the state file not reflecting reality.

```bash
# The dreaded error
Error: Error acquiring the state lock

Error message: ConditionalCheckFailedException: The conditional request failed
Lock Info:
  ID:        a1b2c3d4-e5f6-7890-abcd-ef1234567890
  Path:      s3-bucket/production/terraform.tfstate
  Operation: OperationTypeApply
  Who:       user@hostname
  Version:   1.6.0
  Created:   2023-03-15 14:23:45.123456789 +0000 UTC
  Info:

# Followed by state corruption
Error: state data in S3 does not have the expected content.

This may be caused by unusually long delays in S3 processing a previous state
update. Please wait a few moments and try again. If this problem persists, and
neither S3 nor DynamoDB are experiencing an outage, you may need to manually
verify the remote state and update the Digest value stored in the DynamoDB table
to the following value: a1b2c3d4e5f67890abcdef1234567890
```

### Root Causes

1. **Network interruption** during state write operation
2. **No state file versioning** enabled on S3 bucket
3. **No automated backups** of state files
4. **Partial resource creation** without rollback capability
5. **Manual state lock override** without proper verification

### Prevention: Remote Backend with Versioning

```hcl
# terraform-backend.tf
# Production-grade remote backend configuration

terraform {
  required_version = ">= 1.6.0"

  # S3 backend with DynamoDB locking
  backend "s3" {
    # State file location
    bucket = "company-terraform-state"
    key    = "production/us-east-1/services/api/terraform.tfstate"
    region = "us-east-1"

    # State locking with DynamoDB
    dynamodb_table = "terraform-state-lock"

    # Encryption at rest
    encrypt = true
    kms_key_id = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012"

    # Access logging
    acl = "private"

    # Versioning (must be enabled on bucket)
    # This is configured at the bucket level, not here

    # Workspace support
    workspace_key_prefix = "workspaces"

    # Role assumption for cross-account access
    role_arn = "arn:aws:iam::123456789012:role/TerraformStateAccess"

    # Session tagging
    session_name = "terraform-${var.environment}"
  }
}
```

### S3 Bucket Configuration for State Storage

```hcl
# state-bucket.tf
# S3 bucket optimized for Terraform state storage

resource "aws_s3_bucket" "terraform_state" {
  bucket = "company-terraform-state"

  # Prevent accidental deletion
  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name        = "Terraform State Storage"
    Environment = "global"
    ManagedBy   = "terraform"
    Critical    = "true"
  }
}

# Enable versioning - CRITICAL for disaster recovery
resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Server-side encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.terraform_state.arn
    }
    bucket_key_enabled = true
  }
}

# Block all public access
resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle configuration for old versions
resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "delete-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 90  # Keep 90 days of history
    }
  }

  rule {
    id     = "delete-incomplete-uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Enable access logging
resource "aws_s3_bucket_logging" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  target_bucket = aws_s3_bucket.terraform_state_logs.id
  target_prefix = "state-access-logs/"
}

# Object lock for compliance (optional, very strict)
resource "aws_s3_bucket_object_lock_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    default_retention {
      mode = "GOVERNANCE"  # or "COMPLIANCE" for strictest control
      days = 30
    }
  }
}

# Bucket policy for least-privilege access
resource "aws_s3_bucket_policy" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnforcedTLS"
        Effect = "Deny"
        Principal = "*"
        Action = "s3:*"
        Resource = [
          aws_s3_bucket.terraform_state.arn,
          "${aws_s3_bucket.terraform_state.arn}/*"
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
      {
        Sid    = "DenyUnencryptedObjectUploads"
        Effect = "Deny"
        Principal = "*"
        Action = "s3:PutObject"
        Resource = "${aws_s3_bucket.terraform_state.arn}/*"
        Condition = {
          StringNotEquals = {
            "s3:x-amz-server-side-encryption" = "aws:kms"
          }
        }
      }
    ]
  })
}

# KMS key for encryption
resource "aws_kms_key" "terraform_state" {
  description             = "KMS key for Terraform state encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name      = "terraform-state-encryption"
    ManagedBy = "terraform"
  }
}

resource "aws_kms_alias" "terraform_state" {
  name          = "alias/terraform-state"
  target_key_id = aws_kms_key.terraform_state.key_id
}

# DynamoDB table for state locking
resource "aws_dynamodb_table" "terraform_state_lock" {
  name           = "terraform-state-lock"
  billing_mode   = "PAY_PER_REQUEST"  # On-demand pricing
  hash_key       = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # Point-in-time recovery
  point_in_time_recovery {
    enabled = true
  }

  # Server-side encryption
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.terraform_state.arn
  }

  tags = {
    Name        = "Terraform State Lock"
    Environment = "global"
    ManagedBy   = "terraform"
  }

  # Prevent accidental deletion
  lifecycle {
    prevent_destroy = true
  }
}

# CloudWatch alarm for state lock duration
resource "aws_cloudwatch_metric_alarm" "state_lock_duration" {
  alarm_name          = "terraform-state-lock-duration"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "1"
  metric_name         = "ConsumedWriteCapacityUnits"
  namespace           = "AWS/DynamoDB"
  period              = "300"
  statistic           = "Sum"
  threshold           = "100"
  alarm_description   = "Terraform state lock held for extended period"
  alarm_actions       = [aws_sns_topic.terraform_alerts.arn]

  dimensions = {
    TableName = aws_dynamodb_table.terraform_state_lock.name
  }
}
```

### State File Recovery Procedures

```bash
#!/bin/bash
# terraform-state-recovery.sh
# Automated state file recovery from S3 versioning

set -euo pipefail

BUCKET="company-terraform-state"
STATE_KEY="${1:-}"
RESTORE_VERSION="${2:-latest}"

if [[ -z "$STATE_KEY" ]]; then
  echo "Usage: $0 <state-key> [version-id]"
  echo "Example: $0 production/us-east-1/services/api/terraform.tfstate"
  exit 1
fi

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# List available versions
list_versions() {
  log "Available versions for $STATE_KEY:"
  aws s3api list-object-versions \
    --bucket "$BUCKET" \
    --prefix "$STATE_KEY" \
    --query 'Versions[*].[VersionId, LastModified, Size]' \
    --output table
}

# Download specific version
download_version() {
  local version_id=$1
  local output_file="terraform.tfstate.backup-$(date +%Y%m%d-%H%M%S)"

  log "Downloading version $version_id to $output_file"

  aws s3api get-object \
    --bucket "$BUCKET" \
    --key "$STATE_KEY" \
    --version-id "$version_id" \
    "$output_file"

  log "Downloaded to: $output_file"

  # Validate state file
  if terraform state pull > /dev/null 2>&1; then
    log "State file is valid"
  else
    log "WARNING: State file may be corrupt"
  fi

  # Show summary
  log "State file summary:"
  cat "$output_file" | jq '{
    version: .version,
    terraform_version: .terraform_version,
    serial: .serial,
    resource_count: (.resources | length)
  }'
}

# Restore version
restore_version() {
  local version_id=$1
  local backup_current="terraform.tfstate.pre-restore-$(date +%Y%m%d-%H%M%S)"

  log "Creating backup of current state: $backup_current"
  terraform state pull > "$backup_current"

  log "Restoring version $version_id"
  download_version "$version_id"

  local restored_file="terraform.tfstate.backup-$(date +%Y%m%d-%H%M%S)"

  log "Pushing restored state to Terraform"
  cat "$restored_file" | terraform state push -

  log "State restored successfully"
  log "Previous state backed up to: $backup_current"
}

# Main execution
log "Terraform State Recovery Tool"
log "============================="

if [[ "$RESTORE_VERSION" == "latest" ]]; then
  log "Listing available versions..."
  list_versions

  read -p "Enter version ID to restore (or 'cancel'): " version_input
  if [[ "$version_input" == "cancel" ]]; then
    log "Cancelled"
    exit 0
  fi
  RESTORE_VERSION="$version_input"
fi

# Confirm restoration
read -p "Restore state to version $RESTORE_VERSION? This cannot be undone. (yes/no): " confirm

if [[ "$confirm" == "yes" ]]; then
  restore_version "$RESTORE_VERSION"
else
  log "Cancelled"
  exit 0
fi
```

## Disaster Scenario 2: State Locking Conflicts

### The Incident

A CI/CD pipeline crashed mid-apply, leaving a state lock that blocked all subsequent operations. The team couldn't deploy for 2 hours while debugging the issue.

```bash
# The dreaded locked state
$ terraform apply
Acquiring state lock. This may take a few moments...

Error: Error acquiring the state lock

Error message: ConditionalCheckFailedException: The conditional request failed
Lock Info:
  ID:        jenkins-job-1234-abcd-5678-efgh
  Path:      s3-bucket/production/terraform.tfstate
  Operation: OperationTypeApply
  Who:       jenkins@ci-server-01
  Version:   1.6.0
  Created:   2023-03-15 12:00:00.000000000 +0000 UTC
  Info:

Terraform acquires a state lock to protect the state from being written
by multiple users at the same time. Please resolve the issue above and try
again. For most commands, you can disable locking with the "-lock=false"
flag, but this is not recommended.
```

### Safe Lock Management

```bash
#!/bin/bash
# terraform-lock-management.sh
# Safe state lock management

set -euo pipefail

DYNAMODB_TABLE="terraform-state-lock"
LOCK_ID="${1:-}"

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# List all active locks
list_locks() {
  log "Active Terraform state locks:"
  aws dynamodb scan \
    --table-name "$DYNAMODB_TABLE" \
    --output table \
    --query 'Items[*].[LockID.S, Info.S]'
}

# Get detailed lock information
get_lock_info() {
  local lock_id=$1

  log "Lock details for: $lock_id"
  aws dynamodb get-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"LockID\": {\"S\": \"$lock_id\"}}" \
    --output json | jq '.Item | {
      LockID: .LockID.S,
      Info: (.Info.S | fromjson)
    }'
}

# Force unlock (DANGEROUS - use only when necessary)
force_unlock() {
  local lock_id=$1

  log "WARNING: Force unlocking $lock_id"
  log "This should only be done if you're certain no Terraform process is running"

  read -p "Are you absolutely sure? Type 'force-unlock' to confirm: " confirm

  if [[ "$confirm" != "force-unlock" ]]; then
    log "Cancelled"
    return 1
  fi

  # Check if lock exists
  if ! aws dynamodb get-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"LockID\": {\"S\": \"$lock_id\"}}" \
    --output json | jq -e '.Item' > /dev/null; then
    log "Lock not found: $lock_id"
    return 1
  fi

  # Delete lock
  aws dynamodb delete-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"LockID\": {\"S\": \"$lock_id\"}}"

  log "Lock removed"

  # Verify removal
  if ! aws dynamodb get-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "{\"LockID\": {\"S\": \"$lock_id\"}}" \
    --output json | jq -e '.Item' > /dev/null; then
    log "Successfully verified lock removal"
  else
    log "ERROR: Lock still exists after deletion attempt"
    return 1
  fi
}

# Check lock age and auto-clean old locks
auto_clean_stale_locks() {
  local max_age_hours=${1:-4}  # Default: locks older than 4 hours
  local current_time=$(date +%s)

  log "Checking for stale locks older than $max_age_hours hours"

  aws dynamodb scan \
    --table-name "$DYNAMODB_TABLE" \
    --output json | \
    jq -r '.Items[] | .LockID.S' | \
    while read lock_id; do
      local lock_info=$(aws dynamodb get-item \
        --table-name "$DYNAMODB_TABLE" \
        --key "{\"LockID\": {\"S\": \"$lock_id\"}}" \
        --output json)

      local created=$(echo "$lock_info" | jq -r '.Item.Info.S | fromjson | .Created')
      local created_epoch=$(date -d "$created" +%s)
      local age_hours=$(( ($current_time - $created_epoch) / 3600 ))

      if [[ $age_hours -gt $max_age_hours ]]; then
        log "Stale lock found: $lock_id (age: ${age_hours}h)"
        log "Created: $created"
        echo "$lock_info" | jq '.Item.Info.S | fromjson'

        read -p "Remove this stale lock? (yes/no): " remove
        if [[ "$remove" == "yes" ]]; then
          force_unlock "$lock_id"
        fi
      fi
    done
}

# Main execution
case "${1:-list}" in
  list)
    list_locks
    ;;
  info)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 info <lock-id>"
      exit 1
    fi
    get_lock_info "$2"
    ;;
  unlock)
    if [[ -z "${2:-}" ]]; then
      echo "Usage: $0 unlock <lock-id>"
      exit 1
    fi
    force_unlock "$2"
    ;;
  clean)
    auto_clean_stale_locks "${2:-4}"
    ;;
  *)
    echo "Usage: $0 {list|info|unlock|clean} [args]"
    echo "  list           - List all active locks"
    echo "  info <lock-id> - Show detailed lock information"
    echo "  unlock <lock-id> - Force unlock (dangerous!)"
    echo "  clean [hours]  - Clean stale locks older than N hours"
    exit 1
    ;;
esac
```

## Disaster Scenario 3: Monolithic State Files

### The Problem

A single state file containing 10,000+ resources causes:
- **Slow operations**: `terraform plan` takes 15+ minutes
- **Blast radius**: Any error affects all resources
- **Locking conflicts**: Multiple teams blocked by single lock
- **Difficult rollbacks**: Can't roll back individual components

### Solution: State Isolation Strategy

```
# State isolation hierarchy
company-terraform-state/
├── production/
│   ├── us-east-1/
│   │   ├── networking/
│   │   │   ├── vpc/terraform.tfstate
│   │   │   ├── subnets/terraform.tfstate
│   │   │   └── security-groups/terraform.tfstate
│   │   ├── data/
│   │   │   ├── rds/terraform.tfstate
│   │   │   ├── elasticache/terraform.tfstate
│   │   │   └── s3/terraform.tfstate
│   │   ├── compute/
│   │   │   ├── eks/terraform.tfstate
│   │   │   ├── ec2/terraform.tfstate
│   │   │   └── lambda/terraform.tfstate
│   │   └── services/
│   │       ├── api/terraform.tfstate
│   │       ├── web/terraform.tfstate
│   │       └── workers/terraform.tfstate
│   └── eu-west-1/
│       └── ... (similar structure)
└── staging/
    └── ... (similar structure)
```

### Terragrunt for State Management

```hcl
# terragrunt.hcl (root)
# DRY Terraform configuration with Terragrunt

locals {
  # Parse account and region from path
  parsed = regex(".*/(?P<env>[^/]+)/(?P<region>[^/]+)/(?P<category>[^/]+)/(?P<name>[^/]+)$", get_terragrunt_dir())

  environment = local.parsed.env
  region      = local.parsed.region
  category    = local.parsed.category
  name        = local.parsed.name

  # Common tags
  common_tags = {
    Environment = local.environment
    ManagedBy   = "terraform"
    Region      = local.region
    Category    = local.category
  }
}

# Remote state configuration
remote_state {
  backend = "s3"

  generate = {
    path      = "backend.tf"
    if_exists = "overwrite"
  }

  config = {
    bucket         = "company-terraform-state"
    key            = "${path_relative_to_include()}/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-lock"
    kms_key_id     = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012"

    # S3 bucket versioning enabled
    skip_bucket_versioning            = false
    skip_bucket_ssencryption          = false
    skip_bucket_root_access           = false
    skip_bucket_enforced_tls          = false
    skip_bucket_public_access_blocking = false

    # DynamoDB table configuration
    dynamodb_table_tags = merge(
      local.common_tags,
      {
        Name = "terraform-state-lock-${local.environment}"
      }
    )

    # S3 bucket tags
    s3_bucket_tags = merge(
      local.common_tags,
      {
        Name = "terraform-state-${local.environment}"
      }
    )
  }
}

# Generate provider configuration
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite"
  contents  = <<EOF
provider "aws" {
  region = "${local.region}"

  default_tags {
    tags = ${jsonencode(local.common_tags)}
  }

  assume_role {
    role_arn = "arn:aws:iam::123456789012:role/TerraformExecution"
  }
}
EOF
}

# Common inputs for all configurations
inputs = {
  environment = local.environment
  region      = local.region
  category    = local.category
  name        = local.name
  common_tags = local.common_tags
}
```

### Module Structure with State Isolation

```hcl
# production/us-east-1/networking/vpc/terragrunt.hcl

terraform {
  source = "git::git@github.com:company/terraform-modules.git//networking/vpc?ref=v1.2.3"
}

include "root" {
  path = find_in_parent_folders()
}

# Dependencies on other state files
dependency "account" {
  config_path = "../../account"

  # Mock outputs for plan
  mock_outputs = {
    account_id = "123456789012"
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}

inputs = {
  vpc_cidr = "10.0.0.0/16"

  # Reference outputs from dependency
  account_id = dependency.account.outputs.account_id

  # Availability zones
  azs = ["us-east-1a", "us-east-1b", "us-east-1c"]

  # Subnet configuration
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  # DNS
  enable_dns_hostnames = true
  enable_dns_support   = true

  # NAT Gateway
  enable_nat_gateway = true
  single_nat_gateway = false
  one_nat_gateway_per_az = true

  tags = {
    Name = "production-vpc"
  }
}
```

## State Migration Strategies

```bash
#!/bin/bash
# terraform-state-migration.sh
# Safely migrate resources between state files

set -euo pipefail

SOURCE_DIR="${1:-}"
DEST_DIR="${2:-}"
RESOURCE_ADDRESS="${3:-}"

if [[ -z "$SOURCE_DIR" ]] || [[ -z "$DEST_DIR" ]] || [[ -z "$RESOURCE_ADDRESS" ]]; then
  echo "Usage: $0 <source-dir> <dest-dir> <resource-address>"
  echo "Example: $0 ./old-state ./new-state 'aws_instance.web'"
  exit 1
fi

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# Backup current state
backup_state() {
  local dir=$1
  local backup_file="terraform.tfstate.backup-$(date +%Y%m%d-%H%M%S)"

  log "Backing up state in $dir to $backup_file"
  (cd "$dir" && terraform state pull > "$backup_file")
}

# Move resource between states
migrate_resource() {
  log "Migrating $RESOURCE_ADDRESS from $SOURCE_DIR to $DEST_DIR"

  # Backup both states
  backup_state "$SOURCE_DIR"
  backup_state "$DEST_DIR"

  # Export resource from source
  log "Exporting resource from source state"
  local resource_state=$(cd "$SOURCE_DIR" && \
    terraform state show -json "$RESOURCE_ADDRESS")

  # Remove from source
  log "Removing resource from source state"
  (cd "$SOURCE_DIR" && terraform state rm "$RESOURCE_ADDRESS")

  # Import to destination
  log "Importing resource to destination state"

  # Extract resource ID for import
  local resource_id=$(echo "$resource_state" | jq -r '.values.id')

  if [[ -z "$resource_id" ]] || [[ "$resource_id" == "null" ]]; then
    log "ERROR: Could not extract resource ID"
    return 1
  fi

  (cd "$DEST_DIR" && terraform import "$RESOURCE_ADDRESS" "$resource_id")

  log "Migration complete"
  log "Verify with: terraform plan in both directories"
}

# Verify migration
verify_migration() {
  log "Verifying migration..."

  log "Running plan in source directory..."
  (cd "$SOURCE_DIR" && terraform plan -detailed-exitcode) || {
    local exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
      log "Changes detected in source (expected after removal)"
    elif [[ $exit_code -eq 1 ]]; then
      log "ERROR: Plan failed in source directory"
      return 1
    fi
  }

  log "Running plan in destination directory..."
  (cd "$DEST_DIR" && terraform plan -detailed-exitcode) || {
    local exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
      log "WARNING: Changes detected in destination"
      log "Review the plan carefully"
    elif [[ $exit_code -eq 1 ]]; then
      log "ERROR: Plan failed in destination directory"
      return 1
    fi
  }

  log "Migration verification complete"
}

# Main execution
log "Terraform State Migration Tool"
log "=============================="
log "Source: $SOURCE_DIR"
log "Destination: $DEST_DIR"
log "Resource: $RESOURCE_ADDRESS"

read -p "Proceed with migration? (yes/no): " confirm

if [[ "$confirm" == "yes" ]]; then
  migrate_resource
  verify_migration
else
  log "Cancelled"
  exit 0
fi
```

## Monitoring and Alerting

```yaml
# cloudwatch-state-monitoring.yaml
# CloudWatch alarms for Terraform state health

AWSTemplateFormatVersion: '2010-09-09'
Description: 'Terraform State Monitoring'

Resources:
  # SNS topic for alerts
  TerraformAlertsTopic:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: terraform-state-alerts
      DisplayName: Terraform State Alerts
      Subscription:
        - Endpoint: ops-team@company.com
          Protocol: email

  # Alarm for high state lock duration
  StateLockDurationAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: terraform-state-lock-duration-high
      AlarmDescription: Terraform state locked for extended period
      MetricName: ConsumedWriteCapacityUnits
      Namespace: AWS/DynamoDB
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 1
      Threshold: 100
      ComparisonOperator: GreaterThanThreshold
      AlarmActions:
        - !Ref TerraformAlertsTopic
      Dimensions:
        - Name: TableName
          Value: terraform-state-lock

  # Alarm for state file size growth
  StateFileSizeAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: terraform-state-file-size-growing
      AlarmDescription: Terraform state file growing rapidly
      MetricName: BucketSizeBytes
      Namespace: AWS/S3
      Statistic: Average
      Period: 86400  # Daily
      EvaluationPeriods: 7
      Threshold: 10485760  # 10MB
      ComparisonOperator: GreaterThanThreshold
      AlarmActions:
        - !Ref TerraformAlertsTopic
      Dimensions:
        - Name: BucketName
          Value: company-terraform-state
        - Name: StorageType
          Value: StandardStorage

  # Alarm for failed state operations
  StateOperationErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: terraform-state-operation-errors
      AlarmDescription: Errors during state operations
      MetricName: SystemErrors
      Namespace: AWS/DynamoDB
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 1
      Threshold: 5
      ComparisonOperator: GreaterThanThreshold
      AlarmActions:
        - !Ref TerraformAlertsTopic
      Dimensions:
        - Name: TableName
          Value: terraform-state-lock
```

## Best Practices Summary

Based on Gruntwork's experience with 300,000+ lines of Terraform code:

### State File Management

1. **Always use remote backends** with versioning enabled
2. **Enable state locking** with DynamoDB or equivalent
3. **Encrypt state files** at rest and in transit
4. **Implement automated backups** beyond S3 versioning
5. **Version control backend configuration** but not state files

### State Organization

1. **Isolate state files** by environment, region, and component
2. **Keep state files small** (<1000 resources per file)
3. **Use Terragrunt** or similar tools for DRY configuration
4. **Document dependencies** between state files
5. **Implement consistent naming** conventions

### Operational Procedures

1. **Test in non-production** before production changes
2. **Use CI/CD** for all production deployments
3. **Implement proper locking** with timeout mechanisms
4. **Monitor state operations** with CloudWatch/equivalent
5. **Practice disaster recovery** procedures regularly

### Security

1. **Use IAM roles** with least-privilege access
2. **Enable audit logging** for all state access
3. **Implement state file encryption** with KMS
4. **Restrict state access** to authorized users/systems
5. **Regular security audits** of state access patterns

## Conclusion

Terraform state management is critical infrastructure that requires the same rigor as production systems. The lessons learned from managing 300,000+ lines of Terraform code demonstrate that:

1. **State files are fragile**: Implement robust backup and recovery procedures
2. **Locking is critical**: But stale locks happen—have procedures to handle them safely
3. **Monolithic state is dangerous**: Isolate state files for blast radius reduction
4. **Automation is essential**: Manual state operations are error-prone
5. **Monitoring matters**: Detect issues before they become disasters

By implementing these patterns and procedures, organizations can build resilient infrastructure-as-code systems that survive the inevitable failures and scale to enterprise requirements.