---
title: "S3 Storage Classes: Minimum Duration, Size and Retrieval Fees"
date: 2025-09-11T09:00:00-05:00
lastmod: 2026-10-23T00:00:00-05:00
description: "Every S3 storage class side by side: minimum storage duration, 128 KB minimum billable size, retrieval fees and latency, plus lifecycle rules that avoid early deletion charges."
author: "Matthew Mattox - mmattox@support.tools"
draft: false
categories: ["AWS", "Storage", "Cost Optimization"]
tags: ["AWS", "S3", "S3 Storage Classes", "Data Lifecycle Management", "Cloud Architecture", "Cost Optimization", "Glacier", "S3 Intelligent-Tiering", "S3 Standard-IA", "AWS Outposts"]
---

# S3 Storage Classes: Minimum Duration, Size and Retrieval Fees

The cheaper S3 storage classes are only cheaper if your objects are big enough and stay long enough. This page starts with the minimums that decide that, then walks through each class with CLI and lifecycle examples.

## Quick answer

| Storage class | Minimum storage duration | Minimum billable size | Retrieval fee | First byte |
|---|---|---|---|---|
| S3 Standard | none | none | none | milliseconds |
| S3 Intelligent-Tiering | none | none, but objects under 128 KB are never auto-tiered and stay at Frequent Access rates | none (per-object monitoring fee) | milliseconds |
| S3 Express One Zone | 1 hour | none | per GB | single-digit milliseconds |
| S3 Standard-IA | 30 days | 128 KB | per GB | milliseconds |
| S3 One Zone-IA | 30 days | 128 KB | per GB | milliseconds |
| S3 Glacier Instant Retrieval | 90 days | 128 KB | per GB | milliseconds |
| S3 Glacier Flexible Retrieval | 90 days | 40 KB metadata overhead per object | per GB, by tier | minutes to hours |
| S3 Glacier Deep Archive | 180 days | 40 KB metadata overhead per object | per GB, by tier | hours |

What the minimums mean on the bill:

- **Minimum storage duration:** delete, overwrite or transition an object early and you still pay for the rest of the period. A Standard-IA object deleted after 10 days is billed for 30.
- **Minimum billable size:** a 20 KB object in Standard-IA, One Zone-IA or Glacier Instant Retrieval is billed as 128 KB. Lifecycle rules do not move objects smaller than 128 KB to these classes by default; use `ObjectSizeGreaterThan` to make that explicit.
- **Glacier overhead:** each object archived to Glacier Flexible Retrieval or Deep Archive adds 40 KB of metadata (8 KB billed at Standard rates, 32 KB at the archive rate), so archive tar or zip bundles rather than millions of small files.

A lifecycle rule that respects the minimums:

```json {filename="lifecycle.json"}
{
  "Rules": [
    {
      "ID": "logs-tiering",
      "Status": "Enabled",
      "Filter": { "And": { "Prefix": "logs/", "ObjectSizeGreaterThan": 131072 } },
      "Transitions": [
        { "Days": 30, "StorageClass": "STANDARD_IA" },
        { "Days": 120, "StorageClass": "GLACIER" }
      ],
      "Expiration": { "Days": 400 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket --lifecycle-configuration file://lifecycle.json
```

Transitioning to Glacier at day 120 leaves 90 days in Standard-IA and 280 days in Glacier Flexible Retrieval before expiry, so neither minimum is cut short.

Related guides on this site:

- [S3 with CloudFront and CORS](/post/aws-s3-cloudfront-cors-comprehensive-setup-guide/) for serving objects from these buckets.
- [Mount an S3 bucket on Linux with Mountpoint](/mount-aws-s3-bucket-linux-mountpoint/) for reading them as files.
- [Back up Kubernetes to S3 with Velero](/backup-kubernetes-cluster-aws-s3-velero/), a common source of objects that belong in Standard-IA.

## Introduction to S3 Storage Classes

AWS S3 is built on three design principles:

1. **Durability**: Ensures data remains intact without corruption
2. **Availability**: Determines how readily accessible your data is
3. **Cost**: Varies based on storage, retrieval, and data transfer requirements

Let's examine each storage class through these lenses, along with appropriate implementation patterns.

## S3 Standard

### Technical Specifications

- **Durability**: 99.999999999% (11 9's)
- **Availability**: 99.99%
- **AZ Redundancy**: Minimum 3 Availability Zones
- **Retrieval Time**: Milliseconds
- **Minimum Storage Duration**: None

### Implementation Use Cases

S3 Standard is ideal for:

- **Dynamic Websites**: Static website hosting with frequent content updates
- **Content Distribution**: Origin store for CDN-distributed content
- **Big Data Analytics**: Data lakes for platforms like Amazon Athena, EMR, or Redshift Spectrum
- **Mobile & Gaming Applications**: Assets that require frequent access and low latency

### Implementation Example

Here's an example of configuring an S3 bucket with the Standard storage class using Terraform:

```hcl
resource "aws_s3_bucket" "content_bucket" {
  bucket = "company-app-assets"
  
  tags = {
    Environment = "Production"
    Application = "Content-Platform"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "content_bucket_encryption" {
  bucket = aws_s3_bucket.content_bucket.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Default to Standard storage class
resource "aws_s3_bucket_intelligent_tiering_configuration" "content_bucket_tiering" {
  bucket = aws_s3_bucket.content_bucket.id
  name   = "EntireContentBucket"

  status = "Disabled"  # Ensures files stay in Standard unless explicitly changed
}
```

## S3 Intelligent-Tiering

### Technical Specifications

- **Durability**: 99.999999999% (11 9's)
- **Availability**: 99.9%
- **AZ Redundancy**: Minimum 3 Availability Zones
- **Retrieval Time**: Milliseconds
- **Automatic Tiering**: Objects move between Frequent Access, Infrequent Access (after 30 days without access) and Archive Instant Access (after 90 days); the Archive Access and Deep Archive Access tiers are optional and must be enabled
- **Monitoring Fee**: $0.0025 per 1,000 objects

### Implementation Use Cases

S3 Intelligent-Tiering is optimal for:

- **Unpredictable Access Patterns**: Data with changing or unknown access frequencies
- **Long-term Analytics Storage**: Datasets that may be accessed occasionally but irregularly
- **Media Archives**: Where some content becomes popular periodically

### Implementation Example

Here's how to configure Intelligent-Tiering with Terraform:

```hcl
resource "aws_s3_bucket" "analytics_bucket" {
  bucket = "company-analytics-data"
  
  tags = {
    Environment = "Production"
    Application = "Data-Analytics"
  }
}

# Configure Intelligent-Tiering
resource "aws_s3_bucket_intelligent_tiering_configuration" "analytics_tiering" {
  bucket = aws_s3_bucket.analytics_bucket.id
  name   = "EntireBucket"

  status = "Enabled"

  # Configure Archive tiers
  tiering {
    access_tier = "ARCHIVE_ACCESS"
    days        = 90
  }

  tiering {
    access_tier = "DEEP_ARCHIVE_ACCESS"
    days        = 180
  }
}
```

### Real-world Optimization Strategy

For a media company storing user-generated content:

1. Upload all new content to Intelligent-Tiering
2. The system automatically optimizes storage costs based on access patterns
3. Viral content remains in frequent access tiers
4. Unpopular content automatically moves to infrequent access, saving costs

## S3 Standard-IA (Infrequent Access)

### Technical Specifications

- **Durability**: 99.999999999% (11 9's)
- **Availability**: 99.9%
- **AZ Redundancy**: Minimum 3 Availability Zones
- **Retrieval Time**: Milliseconds
- **Minimum Storage Duration**: 30 days
- **Minimum Billable Object Size**: 128KB

### Implementation Use Cases

Standard-IA excels for:

- **Disaster Recovery Files**: Important backups needed quickly but accessed rarely
- **Regulatory Documentation**: Required data that is rarely accessed
- **Historical Transaction Data**: Must be available immediately when needed but is typically accessed infrequently

### Implementation Example

Example of implementing a lifecycle policy to move objects to Standard-IA:

```hcl
resource "aws_s3_bucket" "backup_bucket" {
  bucket = "company-system-backups"
  
  tags = {
    Environment = "Production"
    Application = "Backup-System"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backup_lifecycle" {
  bucket = aws_s3_bucket.backup_bucket.id

  rule {
    id      = "move-to-ia"
    status  = "Enabled"
    
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    
    # Consider objects 128KB or larger for IA
    filter {
      object_size_greater_than = 131072  # 128KB in bytes
    }
  }
}
```

## S3 One Zone-IA

### Technical Specifications

- **Durability**: 99.999999999% (11 9's) within a single AZ
- **Availability**: 99.5%
- **AZ Redundancy**: None (single AZ)
- **Retrieval Time**: Milliseconds
- **Minimum Storage Duration**: 30 days
- **Minimum Billable Object Size**: 128KB

### Implementation Use Cases

One Zone-IA is suitable for:

- **Secondary Backup Copies**: Where the primary backup is already in a more resilient storage class
- **Easily Reproducible Data**: Data that can be regenerated if the AZ fails
- **Non-critical Data**: Where cost savings outweigh the risk of unavailability during an AZ outage

### Implementation Example

Implementing One Zone-IA with lifecycle rules:

```hcl
resource "aws_s3_bucket" "secondary_backup_bucket" {
  bucket = "company-secondary-backups"
  
  tags = {
    Environment = "Production"
    Application = "Backup-System-Secondary"
  }
}

# Direct upload to One Zone-IA for objects over 256KB
resource "aws_s3_bucket_lifecycle_configuration" "secondary_backup_lifecycle" {
  bucket = aws_s3_bucket.secondary_backup_bucket.id

  rule {
    id      = "store-as-onezone"
    status  = "Enabled"
    
    # For new uploads larger than 256KB
    filter {
      object_size_greater_than = 262144  # 256KB in bytes
    }
    
    # Store directly in One Zone-IA
    transition {
      days          = 0
      storage_class = "ONEZONE_IA"
    }
  }
}
```

## S3 Glacier Instant Retrieval

### Technical Specifications

- **Durability**: 99.999999999% (11 9's)
- **Availability**: 99.9%
- **AZ Redundancy**: Minimum 3 Availability Zones
- **Retrieval Time**: Milliseconds
- **Minimum Storage Duration**: 90 days
- **Minimum Billable Object Size**: 128KB

### Implementation Use Cases

Glacier Instant Retrieval is perfect for:

- **Archived Data Requiring Immediate Access**: Like medical images or regulatory documents
- **Long-term Storage with Random Access Requirements**: Historical records that must be accessed quickly when needed
- **Media Archives**: Long-term storage of finished media projects

### Implementation Example

Configuring Glacier Instant Retrieval:

```hcl
resource "aws_s3_bucket" "medical_images_bucket" {
  bucket = "hospital-medical-images-archive"
  
  tags = {
    Environment = "Production"
    Application = "Medical-Records"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "medical_images_lifecycle" {
  bucket = aws_s3_bucket.medical_images_bucket.id

  rule {
    id      = "archive-older-records"
    status  = "Enabled"
    
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
    
    # Only apply to images over 1MB to optimize costs
    filter {
      object_size_greater_than = 1048576  # 1MB in bytes
    }
  }
}
```

## S3 Glacier Flexible Retrieval (formerly Glacier)

### Technical Specifications

- **Durability**: 99.999999999% (11 9's)
- **Availability**: 99.99% (after restoration)
- **AZ Redundancy**: Minimum 3 Availability Zones
- **Retrieval Time Options**:
  - Expedited: 1-5 minutes
  - Standard: 3-5 hours
  - Bulk: 5-12 hours
- **Minimum Storage Duration**: 90 days

### Implementation Use Cases

Glacier Flexible Retrieval works well for:

- **Long-term Backups**: Disaster recovery data that doesn't need immediate access
- **Compliance Archives**: Regulatory data that must be retained but is rarely accessed
- **Scientific Data Archives**: Raw experimental data retained for validation purposes

### Implementation Example

Here's how to implement a lifecycle policy for Glacier Flexible Retrieval:

```hcl
resource "aws_s3_bucket" "compliance_archive_bucket" {
  bucket = "company-compliance-records"
  
  tags = {
    Environment = "Production"
    Application = "Regulatory-Compliance"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "compliance_archive_lifecycle" {
  bucket = aws_s3_bucket.compliance_archive_bucket.id

  rule {
    id      = "compliance-tiered-storage"
    status  = "Enabled"
    
    # First move to Standard-IA
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    
    # Then move to Glacier after 90 days
    transition {
      days          = 90
      storage_class = "GLACIER"
    }
    
    # Keep in Glacier for 7 years total
    expiration {
      days = 2555  # Approximately 7 years
    }
  }
}
```

### Retrieval Examples

For retrieving Glacier Flexible Retrieval objects, use the S3 API with the appropriate restoration options. Here's an AWS CLI example:

```bash
# Expedited retrieval (fastest, most expensive)
aws s3api restore-object \
  --bucket company-compliance-records \
  --key financial/2022/q4-report.pdf \
  --restore-request '{"Days":5,"GlacierJobParameters":{"Tier":"Expedited"}}'

# Standard retrieval (balanced)
aws s3api restore-object \
  --bucket company-compliance-records \
  --key financial/2022/q4-report.pdf \
  --restore-request '{"Days":5,"GlacierJobParameters":{"Tier":"Standard"}}'

# Bulk retrieval (slowest, cheapest)
aws s3api restore-object \
  --bucket company-compliance-records \
  --key financial/2022/q4-report.pdf \
  --restore-request '{"Days":5,"GlacierJobParameters":{"Tier":"Bulk"}}'
```

## S3 Glacier Deep Archive

### Technical Specifications

- **Durability**: 99.999999999% (11 9's)
- **Availability**: 99.99% (after restoration)
- **AZ Redundancy**: Minimum 3 Availability Zones
- **Retrieval Time Options**:
  - Standard: Up to 12 hours
  - Bulk: Up to 48 hours
- **Minimum Storage Duration**: 180 days

### Implementation Use Cases

Glacier Deep Archive is designed for:

- **Long-term Legal Retention**: Data that must be retained for many years
- **Digital Preservation**: Historical archives with very rare access needs
- **Regulatory Compliance**: Data that must be retained for 7+ years

### Implementation Example

Implementing Glacier Deep Archive with lifecycle rules:

```hcl
resource "aws_s3_bucket" "legal_archive_bucket" {
  bucket = "company-legal-archives"
  
  tags = {
    Environment = "Production"
    Application = "Legal-Archive"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "legal_archive_lifecycle" {
  bucket = aws_s3_bucket.legal_archive_bucket.id

  rule {
    id      = "long-term-preservation"
    status  = "Enabled"
    
    # First move to Standard-IA
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    
    # Then move to Glacier after 6 months
    transition {
      days          = 180
      storage_class = "GLACIER"
    }
    
    # Finally move to Deep Archive after 1 year
    transition {
      days          = 365
      storage_class = "DEEP_ARCHIVE"
    }
    
    # Keep in Deep Archive for 10 years total before expiring
    expiration {
      days = 3650  # 10 years
    }
  }
}
```

## S3 on Outposts

### Technical Specifications

- **Durability**: Designed for 99.999999999% (11 9's)
- **Availability**: Depends on Outpost configuration
- **Redundancy**: Local redundancy within the Outpost
- **Retrieval Time**: Milliseconds (local)
- **Sizing**: Capacity must be provisioned in advance

### Implementation Use Cases

S3 on Outposts is appropriate for:

- **Data Residency Requirements**: When data must remain physically in a specific location
- **Low-Latency Processing**: Edge computing applications requiring fast local storage
- **Disconnected Operations**: Applications that must function even when disconnected from AWS Regions

### Implementation Example

Creating and managing S3 on Outposts requires the AWS Outposts service. Here's an example using AWS CLI:

```bash
# Create an S3 bucket on Outposts
aws s3control create-bucket \
  --bucket example-outpost-bucket \
  --outpost-id op-01234567890abcdef \
  --acl private

# Upload an object to the Outposts bucket
aws s3api put-object \
  --bucket arn:aws:s3-outposts:us-west-2:123456789012:outpost/op-01234567890abcdef/bucket/example-outpost-bucket \
  --key sample-file.txt \
  --body sample-file.txt
```

## Advanced Implementation: Comprehensive Lifecycle Management

For enterprise applications, implementing a sophisticated lifecycle management policy across multiple storage classes can optimize costs while meeting performance requirements.

Here's an example of a comprehensive lifecycle policy for a data processing application:

```hcl
resource "aws_s3_bucket" "enterprise_data_bucket" {
  bucket = "enterprise-data-processing"
  
  tags = {
    Environment = "Production"
    Application = "Data-Platform"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "enterprise_data_lifecycle" {
  bucket = aws_s3_bucket.enterprise_data_bucket.id

  # Rule for raw input data
  rule {
    id      = "raw-data-lifecycle"
    status  = "Enabled"
    
    filter {
      prefix = "raw/"
    }
    
    # Keep in Standard for 30 days
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    
    # Move to Glacier after 90 days
    transition {
      days          = 90
      storage_class = "GLACIER"
    }
    
    # Move to Deep Archive after 1 year
    transition {
      days          = 365
      storage_class = "DEEP_ARCHIVE"
    }
    
    # Delete after 7 years
    expiration {
      days = 2555
    }
  }
  
  # Rule for processed data
  rule {
    id      = "processed-data-lifecycle"
    status  = "Enabled"
    
    filter {
      prefix = "processed/"
    }
    
    # Use Intelligent-Tiering for processed data
    transition {
      days          = 0
      storage_class = "INTELLIGENT_TIERING"
    }
  }
  
  # Rule for reports
  rule {
    id      = "reports-lifecycle"
    status  = "Enabled"
    
    filter {
      prefix = "reports/"
    }
    
    # Keep reports in Standard for 60 days
    transition {
      days          = 60
      storage_class = "STANDARD_IA"
    }
    
    # Archive reports after 1 year
    transition {
      days          = 365
      storage_class = "GLACIER_IR"  # Use Instant Retrieval for quick access when needed
    }
    
    # Never expire reports
  }
  
  # Rule for temporary files
  rule {
    id      = "temp-files-lifecycle"
    status  = "Enabled"
    
    filter {
      prefix = "temp/"
    }
    
    # Delete temporary files after 7 days
    expiration {
      days = 7
    }
  }
}
```

## Cost Optimization Strategies

### 1. Size-Based Storage Class Selection

For optimal cost efficiency, consider the size of your objects when selecting storage classes:

- **Tiny Objects (<128KB)**: Keep in S3 Standard to avoid minimum size billing
- **Medium Objects (128KB-1MB)**: Good candidates for IA storage classes
- **Large Objects (>1MB)**: Best cost savings when moved to Glacier classes

### 2. Access Pattern Analysis

Regularly analyze access patterns to identify optimization opportunities:

```bash
# Get CloudWatch metrics for bucket by prefix
aws cloudwatch get-metric-statistics \
  --namespace AWS/S3 \
  --metric-name GetRequests \
  --dimensions Name=BucketName,Value=my-bucket Name=FilterId,Value=EntireBucket \
  --start-time 2025-01-01T00:00:00Z \
  --end-time 2025-01-31T23:59:59Z \
  --period 86400 \
  --statistics Sum
```

### 3. S3 Analytics Configuration

Enable S3 Analytics to receive storage recommendations:

```hcl
resource "aws_s3_bucket_analytics_configuration" "example_analytics" {
  bucket = aws_s3_bucket.enterprise_data_bucket.id
  name   = "entire-bucket-analysis"

  storage_class_analysis {
    data_export {
      destination {
        s3_bucket_destination {
          bucket_arn = aws_s3_bucket.analytics_destination.arn
          prefix     = "analytics-results"
        }
      }
      output_schema_version = "V_1"
    }
  }
}
```

### 4. Transition Cost Awareness

Remember that transitions between storage classes incur costs. Avoid frequent transitions for small files:

- Transition to Glacier: $0.05 per 1,000 requests
- Retrieval from Glacier: Varies by retrieval speed
- Early deletion penalties: Prorated minimum duration charges

## Storage Class Comparison Table

| Storage Class | Durability | Availability | Min Duration | Min Size | Retrieval Time | Use Case |
|---------------|------------|--------------|--------------|----------|----------------|----------|
| Standard | 11 9's | 99.99% | None | None | Milliseconds | Frequently accessed data |
| Intelligent-Tiering | 11 9's | 99.9% | None | None (objects under 128KB are not auto-tiered) | Milliseconds | Unknown access patterns |
| Standard-IA | 11 9's | 99.9% | 30 days | 128KB | Milliseconds | Infrequently accessed data |
| One Zone-IA | 11 9's (single AZ) | 99.5% | 30 days | 128KB | Milliseconds | Non-critical, infrequent access |
| Glacier Instant Retrieval | 11 9's | 99.9% | 90 days | 128KB | Milliseconds | Archive with immediate access needs |
| Glacier Flexible Retrieval | 11 9's | 99.99% (post-restore) | 90 days | 40KB overhead per object | Minutes to hours | Long-term archive, flexible retrieval |
| Glacier Deep Archive | 11 9's | 99.99% (post-restore) | 180 days | 40KB overhead per object | Hours | Lowest-cost long-term archive |
| S3 on Outposts | Varies | Varies | None | None | Milliseconds | On-premises data requirements |

## Conclusion

AWS S3 storage classes provide flexible options to optimize cost, performance, and durability based on your specific requirements. By implementing appropriate lifecycle policies and storage class strategies, organizations can significantly reduce storage costs while maintaining necessary performance characteristics.

A well-architected S3 implementation typically leverages multiple storage classes within a comprehensive lifecycle policy, transitioning objects based on age, access patterns, and business requirements.

For specific workloads, consider these best practices:

1. Use S3 Analytics to identify optimization opportunities
2. Implement lifecycle rules based on data access patterns
3. Consider object sizes when selecting storage classes
4. Balance retrieval costs against storage savings
5. Use Intelligent-Tiering for data with unpredictable access patterns

By taking advantage of the full spectrum of S3 storage classes, organizations can maintain optimal price-performance for their cloud storage needs.

## Additional Resources

- [AWS S3 Pricing Documentation](https://aws.amazon.com/s3/pricing/)
- [S3 Storage Classes Technical Documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)
- [S3 Lifecycle Management Guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html)
- [S3 Performance Design Patterns](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)