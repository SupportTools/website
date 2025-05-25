---
title: "AWS S3 with CloudFront and CORS: Complete Guide to Secure, High-Performance Content Delivery"
date: 2025-09-09T09:00:00-05:00
draft: false
categories: ["AWS", "CloudFront", "S3", "Web Development"]
tags: ["AWS S3", "CloudFront", "CORS", "CDN", "Content Delivery", "Static Website Hosting", "Origin Access Control", "Response Headers", "Terraform", "Web Performance"]
---

# AWS S3 with CloudFront and CORS: Complete Guide to Secure, High-Performance Content Delivery

Building modern web applications requires efficient content delivery that balances performance, security, and global accessibility. Amazon S3 combined with CloudFront provides a powerful foundation for serving static assets, while proper CORS configuration ensures seamless cross-origin access. This comprehensive guide explores the intricacies of setting up, securing, and optimizing this architecture.

## Understanding the S3 + CloudFront + CORS Ecosystem

Before diving into implementation details, let's understand how these components work together:

### The Architecture Overview

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Web Browser   │───▶│   CloudFront     │───▶│   Amazon S3     │
│                 │    │   (Edge Cache)   │    │   (Origin)      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                        │                       │
         │                        │                       │
    CORS Headers              Cache Headers         Static Assets
    Security Headers          Response Policies     Origin Policies
```

### Component Roles

**Amazon S3:**
- **Storage**: Hosts static assets (HTML, CSS, JS, images, videos)
- **Origin**: Serves as the authoritative source for CloudFront
- **Security**: Configured with bucket policies and access controls

**CloudFront:**
- **Distribution**: Global edge locations for content caching
- **Security**: SSL/TLS termination and DDoS protection
- **Optimization**: Compression, caching, and header manipulation
- **Access Control**: Origin Access Control (OAC) for secure S3 access

**CORS (Cross-Origin Resource Sharing):**
- **Permission System**: Controls which domains can access resources
- **Browser Security**: Enforced by browsers for XMLHttpRequest and Fetch API
- **Header Management**: Configured through CloudFront response headers policies

## Deep Dive: CORS Fundamentals

CORS is often misunderstood, leading to security vulnerabilities or broken functionality. Let's explore it thoroughly:

### Same-Origin vs. Cross-Origin Requests

**Same-Origin Request (Allowed by default):**
```javascript
// Current page: https://example.com/page
fetch('https://example.com/api/data') // ✅ Same origin
```

**Cross-Origin Request (Requires CORS):**
```javascript
// Current page: https://example.com/page
fetch('https://api.other-domain.com/data') // ❌ Requires CORS headers
```

### CORS Preflight Mechanism

For certain requests, browsers send a preflight OPTIONS request:

```http
OPTIONS /api/data HTTP/1.1
Host: api.other-domain.com
Origin: https://example.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: Content-Type, Authorization
```

Server response allowing the request:
```http
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://example.com
Access-Control-Allow-Methods: GET, POST, PUT, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

### CORS Headers Explained

| Header | Purpose | Example |
|--------|---------|---------|
| `Access-Control-Allow-Origin` | Specifies allowed origins | `https://example.com` or `*` |
| `Access-Control-Allow-Methods` | Allowed HTTP methods | `GET, POST, PUT, DELETE` |
| `Access-Control-Allow-Headers` | Allowed request headers | `Content-Type, Authorization` |
| `Access-Control-Allow-Credentials` | Allow cookies/auth | `true` or `false` |
| `Access-Control-Max-Age` | Preflight cache duration | `86400` (24 hours) |
| `Access-Control-Expose-Headers` | Headers exposed to client | `X-Custom-Header` |

## CloudFront Response Headers Policies

CloudFront Response Headers Policies provide a powerful way to add, modify, or remove HTTP headers without changing your origin server configuration.

### Managed Policies

AWS provides several pre-configured policies:

**SimpleCORS:**
```json
{
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD",
  "access-control-max-age": "86400"
}
```

**CORS-with-preflight:**
```json
{
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS,PUT,POST,PATCH,DELETE",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400"
}
```

**CORS-and-SecurityHeaders:**
```json
{
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,OPTIONS,PUT,POST,PATCH,DELETE",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
  "strict-transport-security": "max-age=63072000; includeSubdomains; preload",
  "content-type-options": "nosniff",
  "frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin"
}
```

### Custom Response Headers Policy

For more control, create custom policies:

```hcl
resource "aws_cloudfront_response_headers_policy" "custom_cors" {
  name = "custom-cors-policy"

  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec      = 86400

    access_control_allow_headers {
      items = ["Content-Type", "Authorization", "X-Custom-Header"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    }

    access_control_allow_origins {
      items = ["https://example.com", "https://app.example.com"]
    }

    access_control_expose_headers {
      items = ["X-Custom-Response-Header"]
    }

    origin_override = true
  }

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains        = true
      preload                   = true
      override                  = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}
```

## Complete Infrastructure Setup with Terraform

Let's build a production-ready S3 + CloudFront setup with comprehensive CORS support:

### Enhanced Terraform Configuration

```hcl
# Variables for customization
variable "bucket_name" {
  description = "S3 bucket name for static website"
  type        = string
  default     = "my-static-site-bucket"
}

variable "allowed_origins" {
  description = "List of allowed origins for CORS"
  type        = list(string)
  default     = ["https://example.com", "https://app.example.com"]
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

# Random suffix for unique bucket name
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

locals {
  bucket_name = "${var.bucket_name}-${random_id.bucket_suffix.hex}"
}

# S3 Bucket for static website hosting
resource "aws_s3_bucket" "site_bucket" {
  bucket = local.bucket_name

  tags = {
    Name        = "Static Website Bucket"
    Environment = var.environment
  }
}

# S3 Bucket versioning
resource "aws_s3_bucket_versioning" "site_bucket_versioning" {
  bucket = aws_s3_bucket.site_bucket.id
  versioning_configuration {
    status = "Enabled"
  }
}

# S3 Bucket encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "site_bucket_encryption" {
  bucket = aws_s3_bucket.site_bucket.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Block public access to S3 bucket
resource "aws_s3_bucket_public_access_block" "site_bucket_pab" {
  bucket = aws_s3_bucket.site_bucket.id

  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

# S3 bucket lifecycle configuration
resource "aws_s3_bucket_lifecycle_configuration" "site_bucket_lifecycle" {
  bucket = aws_s3_bucket.site_bucket.id

  rule {
    id     = "delete_incomplete_multipart_uploads"
    status = "Enabled"

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "transition_old_versions"
    status = "Enabled"

    noncurrent_version_transition {
      noncurrent_days = 30
      storage_class   = "STANDARD_IA"
    }

    noncurrent_version_transition {
      noncurrent_days = 90
      storage_class   = "GLACIER"
    }

    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }
}

# Origin Access Control for CloudFront
resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "${local.bucket_name}-oac"
  description                       = "OAC for ${local.bucket_name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Custom Response Headers Policy for CORS and Security
resource "aws_cloudfront_response_headers_policy" "custom_headers" {
  name = "${local.bucket_name}-headers-policy"

  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec      = 86400

    access_control_allow_headers {
      items = [
        "Accept",
        "Accept-Language",
        "Content-Language",
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Custom-Header"
      ]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    }

    access_control_allow_origins {
      items = var.allowed_origins
    }

    access_control_expose_headers {
      items = ["ETag", "X-Custom-Response-Header"]
    }

    origin_override = true
  }

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains        = true
      preload                   = true
      override                  = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }

  custom_headers_config {
    items {
      header   = "X-Custom-Header"
      value    = "CustomValue"
      override = false
    }
  }
}

# Cache Policies
resource "aws_cloudfront_cache_policy" "static_assets" {
  name        = "${local.bucket_name}-static-cache-policy"
  comment     = "Cache policy for static assets"
  default_ttl = 86400
  max_ttl     = 31536000
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    query_strings_config {
      query_string_behavior = "none"
    }

    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["CloudFront-Viewer-Country"]
      }
    }

    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "cdn" {
  origin {
    domain_name              = aws_s3_bucket.site_bucket.bucket_regional_domain_name
    origin_id                = "S3-${local.bucket_name}"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id

    # Custom origin headers if needed
    custom_header {
      name  = "X-Origin-Verify"
      value = "CloudFront-Distribution"
    }
  }

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "CDN for ${local.bucket_name}"
  default_root_object = "index.html"

  # Custom error pages
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
    error_caching_min_ttl = 300
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
    error_caching_min_ttl = 300
  }

  # Default cache behavior
  default_cache_behavior {
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "S3-${local.bucket_name}"
    compress                   = true
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id           = aws_cloudfront_cache_policy.static_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_headers.id

    # Lambda@Edge or CloudFront Functions can be attached here
    # function_association {
    #   event_type   = "viewer-request"
    #   function_arn = aws_cloudfront_function.auth.arn
    # }
  }

  # Additional cache behaviors for different content types
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "S3-${local.bucket_name}"
    compress                   = false
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id           = aws_cloudfront_cache_policy.static_assets.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_headers.id
    min_ttl                    = 0
    default_ttl                = 0
    max_ttl                    = 0
  }

  # Price class - adjust based on your global reach requirements
  price_class = "PriceClass_100"

  # Geographic restrictions
  restrictions {
    geo_restriction {
      restriction_type = "none"
      # locations        = ["US", "CA", "GB", "DE"] # Whitelist specific countries
    }
  }

  # SSL certificate
  viewer_certificate {
    cloudfront_default_certificate = true
    # For custom domain:
    # acm_certificate_arn            = aws_acm_certificate.ssl_certificate.arn
    # ssl_support_method             = "sni-only"
    # minimum_protocol_version       = "TLSv1.2_2021"
  }

  # Web Application Firewall
  # web_acl_id = aws_wafv2_web_acl.cloudfront_waf.arn

  tags = {
    Name        = "Static Website CDN"
    Environment = var.environment
  }
}

# S3 Bucket Policy for CloudFront OAC
resource "aws_s3_bucket_policy" "cloudfront_access" {
  bucket = aws_s3_bucket.site_bucket.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipalReadOnly"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.site_bucket.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn
          }
        }
      }
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.site_bucket_pab]
}

# Outputs
output "cloudfront_distribution_id" {
  description = "CloudFront Distribution ID"
  value       = aws_cloudfront_distribution.cdn.id
}

output "cloudfront_domain_name" {
  description = "CloudFront Distribution Domain Name"
  value       = aws_cloudfront_distribution.cdn.domain_name
}

output "s3_bucket_name" {
  description = "S3 Bucket Name"
  value       = aws_s3_bucket.site_bucket.id
}

output "s3_bucket_domain_name" {
  description = "S3 Bucket Domain Name"
  value       = aws_s3_bucket.site_bucket.bucket_domain_name
}
```

### Advanced Security Configuration

Add WAF and additional security layers:

```hcl
# WAF Web ACL for CloudFront
resource "aws_wafv2_web_acl" "cloudfront_waf" {
  name  = "${local.bucket_name}-waf"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Rate limiting rule
  rule {
    name     = "RateLimitRule"
    priority = 1

    override_action {
      none {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitRule"
      sampled_requests_enabled   = true
    }

    action {
      block {}
    }
  }

  # AWS Managed Rules - Core Rule Set
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSetMetric"
      sampled_requests_enabled   = true
    }
  }

  tags = {
    Name        = "CloudFront WAF"
    Environment = var.environment
  }
}

# CloudWatch Log Group for WAF
resource "aws_cloudwatch_log_group" "waf_log_group" {
  name              = "/aws/wafv2/${local.bucket_name}"
  retention_in_days = 30
}

# WAF Logging Configuration
resource "aws_wafv2_web_acl_logging_configuration" "waf_logging" {
  resource_arn            = aws_wafv2_web_acl.cloudfront_waf.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf_log_group.arn]
}
```

## Content Upload and Management

### Automated Deployment Pipeline

Create a deployment script for uploading content:

```bash
#!/bin/bash
# deploy-static-site.sh

set -e

BUCKET_NAME="$1"
CLOUDFRONT_DISTRIBUTION_ID="$2"
SOURCE_DIR="$3"

if [ -z "$BUCKET_NAME" ] || [ -z "$CLOUDFRONT_DISTRIBUTION_ID" ] || [ -z "$SOURCE_DIR" ]; then
    echo "Usage: $0 <bucket-name> <cloudfront-distribution-id> <source-directory>"
    exit 1
fi

echo "Deploying static site to S3 bucket: $BUCKET_NAME"

# Sync files to S3 with optimized settings
aws s3 sync "$SOURCE_DIR" "s3://$BUCKET_NAME" \
    --delete \
    --exact-timestamps \
    --cache-control "max-age=31536000" \
    --exclude "*.html" \
    --exclude "*.json"

# HTML files with shorter cache (for SPA routing)
aws s3 sync "$SOURCE_DIR" "s3://$BUCKET_NAME" \
    --exclude "*" \
    --include "*.html" \
    --include "*.json" \
    --cache-control "max-age=300, must-revalidate"

# Set proper content types
find "$SOURCE_DIR" -name "*.js" -exec aws s3 cp {} "s3://$BUCKET_NAME/{}" \
    --content-type "application/javascript" \
    --cache-control "max-age=31536000" \;

find "$SOURCE_DIR" -name "*.css" -exec aws s3 cp {} "s3://$BUCKET_NAME/{}" \
    --content-type "text/css" \
    --cache-control "max-age=31536000" \;

find "$SOURCE_DIR" -name "*.svg" -exec aws s3 cp {} "s3://$BUCKET_NAME/{}" \
    --content-type "image/svg+xml" \
    --cache-control "max-age=31536000" \;

echo "Creating CloudFront invalidation..."
INVALIDATION_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --paths "/*" \
    --query 'Invalidation.Id' \
    --output text)

echo "Invalidation created: $INVALIDATION_ID"
echo "Waiting for invalidation to complete..."

aws cloudfront wait invalidation-completed \
    --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --id "$INVALIDATION_ID"

echo "Deployment completed successfully!"
```

### GitHub Actions Workflow

Automate deployment with GitHub Actions:

```yaml
# .github/workflows/deploy.yml
name: Deploy Static Site

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '18'
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Build site
      run: npm run build
      
    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v4
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: us-east-1
        
    - name: Deploy to S3 and CloudFront
      run: |
        chmod +x ./scripts/deploy-static-site.sh
        ./scripts/deploy-static-site.sh \
          ${{ secrets.S3_BUCKET_NAME }} \
          ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} \
          ./dist
        
    - name: Notify deployment status
      if: always()
      uses: 8398a7/action-slack@v3
      with:
        status: ${{ job.status }}
        webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

## CORS Testing and Validation

### Comprehensive CORS Testing Suite

Create a testing framework to validate CORS functionality:

```html
<!-- cors-test.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CORS Test Suite</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .test-result { margin: 10px 0; padding: 10px; border-radius: 5px; }
        .success { background-color: #d4edda; border: 1px solid #c3e6cb; color: #155724; }
        .error { background-color: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; }
        .warning { background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404; }
    </style>
</head>
<body>
    <h1>CORS Test Suite</h1>
    <div id="test-results"></div>
    
    <script>
        class CORSTestSuite {
            constructor(baseUrl) {
                this.baseUrl = baseUrl;
                this.results = [];
            }
            
            async runAllTests() {
                const tests = [
                    this.testSimpleGET,
                    this.testPreflightedPOST,
                    this.testWithCredentials,
                    this.testCustomHeaders,
                    this.testInvalidOrigin
                ];
                
                for (const test of tests) {
                    try {
                        await test.call(this);
                    } catch (error) {
                        this.addResult('error', `Test failed: ${error.message}`);
                    }
                }
                
                this.displayResults();
            }
            
            async testSimpleGET() {
                const response = await fetch(`${this.baseUrl}/test.json`);
                
                if (response.ok) {
                    this.addResult('success', 'Simple GET request: PASSED');
                } else {
                    this.addResult('error', `Simple GET request: FAILED (${response.status})`);
                }
                
                // Check CORS headers
                const corsHeader = response.headers.get('Access-Control-Allow-Origin');
                if (corsHeader) {
                    this.addResult('success', `CORS header present: ${corsHeader}`);
                } else {
                    this.addResult('warning', 'No CORS header in response');
                }
            }
            
            async testPreflightedPOST() {
                try {
                    const response = await fetch(`${this.baseUrl}/api/test`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ test: 'data' })
                    });
                    
                    this.addResult('success', 'Preflighted POST request: PASSED');
                } catch (error) {
                    this.addResult('error', `Preflighted POST request: FAILED (${error.message})`);
                }
            }
            
            async testWithCredentials() {
                try {
                    const response = await fetch(`${this.baseUrl}/test.json`, {
                        credentials: 'include'
                    });
                    
                    const corsCredentials = response.headers.get('Access-Control-Allow-Credentials');
                    if (corsCredentials === 'true') {
                        this.addResult('success', 'Credentials request: PASSED');
                    } else {
                        this.addResult('warning', 'Credentials not explicitly allowed');
                    }
                } catch (error) {
                    this.addResult('error', `Credentials request: FAILED (${error.message})`);
                }
            }
            
            async testCustomHeaders() {
                try {
                    const response = await fetch(`${this.baseUrl}/test.json`, {
                        headers: {
                            'X-Custom-Header': 'test-value'
                        }
                    });
                    
                    this.addResult('success', 'Custom headers request: PASSED');
                } catch (error) {
                    this.addResult('error', `Custom headers request: FAILED (${error.message})`);
                }
            }
            
            async testInvalidOrigin() {
                // This test simulates a request from a non-allowed origin
                // In practice, this would be tested from a different domain
                this.addResult('warning', 'Invalid origin test: Manual testing required from unauthorized domain');
            }
            
            addResult(type, message) {
                this.results.push({ type, message, timestamp: new Date() });
            }
            
            displayResults() {
                const container = document.getElementById('test-results');
                container.innerHTML = '';
                
                this.results.forEach(result => {
                    const div = document.createElement('div');
                    div.className = `test-result ${result.type}`;
                    div.innerHTML = `
                        <strong>${result.timestamp.toLocaleTimeString()}</strong>: ${result.message}
                    `;
                    container.appendChild(div);
                });
            }
        }
        
        // Initialize and run tests
        document.addEventListener('DOMContentLoaded', () => {
            const cloudFrontDomain = 'https://d123456789.cloudfront.net'; // Replace with your domain
            const testSuite = new CORSTestSuite(cloudFrontDomain);
            testSuite.runAllTests();
        });
    </script>
</body>
</html>
```

### Command-Line CORS Testing

```bash
#!/bin/bash
# cors-test.sh

CLOUDFRONT_DOMAIN="$1"
ORIGIN="$2"

if [ -z "$CLOUDFRONT_DOMAIN" ] || [ -z "$ORIGIN" ]; then
    echo "Usage: $0 <cloudfront-domain> <origin>"
    echo "Example: $0 https://d123456789.cloudfront.net https://example.com"
    exit 1
fi

echo "Testing CORS configuration for $CLOUDFRONT_DOMAIN"
echo "Testing from origin: $ORIGIN"
echo "=" "=" "=" "=" "=" "=" "=" "=" "=" "="

# Test simple GET request
echo "Testing simple GET request..."
RESPONSE=$(curl -s -I -H "Origin: $ORIGIN" "$CLOUDFRONT_DOMAIN/test.json")
echo "$RESPONSE" | grep -i "access-control-allow-origin" && echo "✅ CORS headers present" || echo "❌ No CORS headers"

# Test preflight OPTIONS request
echo -e "\nTesting preflight OPTIONS request..."
PREFLIGHT_RESPONSE=$(curl -s -I \
    -X OPTIONS \
    -H "Origin: $ORIGIN" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type" \
    "$CLOUDFRONT_DOMAIN/api/test")

echo "$PREFLIGHT_RESPONSE" | grep -i "access-control-allow-methods" && echo "✅ Methods allowed" || echo "❌ Methods not specified"
echo "$PREFLIGHT_RESPONSE" | grep -i "access-control-allow-headers" && echo "✅ Headers allowed" || echo "❌ Headers not specified"

# Test with invalid origin
echo -e "\nTesting with invalid origin..."
INVALID_RESPONSE=$(curl -s -I -H "Origin: https://malicious-site.com" "$CLOUDFRONT_DOMAIN/test.json")
INVALID_CORS=$(echo "$INVALID_RESPONSE" | grep -i "access-control-allow-origin")

if [ -z "$INVALID_CORS" ]; then
    echo "✅ Invalid origin correctly rejected"
else
    echo "⚠️  Invalid origin allowed: $INVALID_CORS"
fi

echo -e "\nCORS testing completed."
```

## Performance Optimization

### Cache Optimization Strategies

Implement intelligent caching based on content type:

```hcl
# Cache policy for static assets (long cache)
resource "aws_cloudfront_cache_policy" "static_long_cache" {
  name        = "static-long-cache"
  comment     = "Long cache for immutable static assets"
  default_ttl = 31536000  # 1 year
  max_ttl     = 31536000  # 1 year
  min_ttl     = 31536000  # 1 year

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    query_strings_config {
      query_string_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# Cache policy for HTML files (short cache)
resource "aws_cloudfront_cache_policy" "html_short_cache" {
  name        = "html-short-cache"
  comment     = "Short cache for HTML files"
  default_ttl = 300       # 5 minutes
  max_ttl     = 86400     # 1 day
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true

    query_strings_config {
      query_string_behavior = "all"
    }

    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["CloudFront-Viewer-Country", "CloudFront-Is-Mobile-Viewer"]
      }
    }

    cookies_config {
      cookie_behavior = "none"
    }
  }
}

# Additional cache behaviors in CloudFront distribution
resource "aws_cloudfront_distribution" "cdn_optimized" {
  # ... other configuration ...

  # Static assets - long cache
  ordered_cache_behavior {
    path_pattern               = "*.js"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "S3-${local.bucket_name}"
    compress                   = true
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id           = aws_cloudfront_cache_policy.static_long_cache.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_headers.id
  }

  ordered_cache_behavior {
    path_pattern               = "*.css"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "S3-${local.bucket_name}"
    compress                   = true
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id           = aws_cloudfront_cache_policy.static_long_cache.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_headers.id
  }

  ordered_cache_behavior {
    path_pattern               = "/images/*"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "S3-${local.bucket_name}"
    compress                   = false  # Images are already compressed
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id           = aws_cloudfront_cache_policy.static_long_cache.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_headers.id
  }

  # HTML files - short cache
  ordered_cache_behavior {
    path_pattern               = "*.html"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    target_origin_id           = "S3-${local.bucket_name}"
    compress                   = true
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id           = aws_cloudfront_cache_policy.html_short_cache.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.custom_headers.id
  }
}
```

### Performance Monitoring

Set up CloudWatch monitoring for performance metrics:

```hcl
# CloudWatch Dashboard for monitoring
resource "aws_cloudwatch_dashboard" "cdn_performance" {
  dashboard_name = "${local.bucket_name}-performance"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6

        properties = {
          metrics = [
            ["AWS/CloudFront", "Requests", "DistributionId", aws_cloudfront_distribution.cdn.id],
            [".", "BytesDownloaded", ".", "."],
            [".", "OriginLatency", ".", "."],
            [".", "CacheHitRate", ".", "."]
          ]
          view    = "timeSeries"
          stacked = false
          region  = "us-east-1"
          title   = "CloudFront Performance Metrics"
          period  = 300
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6

        properties = {
          metrics = [
            ["AWS/CloudFront", "4xxErrorRate", "DistributionId", aws_cloudfront_distribution.cdn.id],
            [".", "5xxErrorRate", ".", "."]
          ]
          view    = "timeSeries"
          stacked = false
          region  = "us-east-1"
          title   = "Error Rates"
          period  = 300
        }
      }
    ]
  })
}

# CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "high_error_rate" {
  alarm_name          = "${local.bucket_name}-high-error-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "4xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = "300"
  statistic           = "Average"
  threshold           = "5"
  alarm_description   = "This metric monitors 4xx error rate"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DistributionId = aws_cloudfront_distribution.cdn.id
  }
}

resource "aws_cloudwatch_metric_alarm" "low_cache_hit_rate" {
  alarm_name          = "${local.bucket_name}-low-cache-hit-rate"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = "3"
  metric_name         = "CacheHitRate"
  namespace           = "AWS/CloudFront"
  period              = "300"
  statistic           = "Average"
  threshold           = "80"
  alarm_description   = "This metric monitors cache hit rate"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DistributionId = aws_cloudfront_distribution.cdn.id
  }
}

# SNS topic for alerts
resource "aws_sns_topic" "alerts" {
  name = "${local.bucket_name}-alerts"
}
```

## Security Best Practices

### Content Security Policy (CSP)

Implement robust CSP headers:

```hcl
resource "aws_cloudfront_response_headers_policy" "security_enhanced" {
  name = "${local.bucket_name}-security-enhanced"

  security_headers_config {
    content_security_policy {
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "connect-src 'self' https://api.example.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ])
      override = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains        = true
      preload                   = true
      override                  = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }

  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec      = 86400

    access_control_allow_headers {
      items = ["Content-Type", "Authorization", "X-Requested-With"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }

    access_control_allow_origins {
      items = var.allowed_origins
    }

    origin_override = true
  }
}
```

## Troubleshooting Common Issues

### CORS Issues Diagnostic Guide

Common CORS problems and solutions:

**Issue 1: "Access to fetch at '...' from origin '...' has been blocked by CORS policy"**

```bash
# Check if proper CORS headers are set
curl -I -H "Origin: https://example.com" https://d123456789.cloudfront.net/test.json

# Should return:
# Access-Control-Allow-Origin: https://example.com
# or
# Access-Control-Allow-Origin: *
```

**Solution:**
- Verify response headers policy is attached to the cache behavior
- Check that the origin is included in the allowed origins list
- Ensure the distribution has deployed (can take 15-20 minutes)

**Issue 2: Preflight OPTIONS requests failing**

```bash
# Test preflight request
curl -I \
  -X OPTIONS \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Content-Type" \
  https://d123456789.cloudfront.net/api/endpoint
```

**Solution:**
- Ensure OPTIONS method is included in allowed methods
- Verify Access-Control-Allow-Methods includes the requested method
- Check Access-Control-Allow-Headers includes requested headers

**Issue 3: CloudFront not serving updated content**

```bash
# Create invalidation
aws cloudfront create-invalidation \
  --distribution-id E123456789 \
  --paths "/*"

# Check cache headers
curl -I https://d123456789.cloudfront.net/test.css | grep -i cache
```

**Solution:**
- Create CloudFront invalidation
- Verify cache policies are correctly configured
- Use versioned URLs for static assets

## Conclusion

Successfully implementing S3 with CloudFront and CORS requires careful attention to security, performance, and cross-origin access requirements. The key benefits of this architecture include:

1. **Global Performance**: CloudFront's edge locations ensure fast content delivery worldwide
2. **Enhanced Security**: Origin Access Control, WAF, and security headers provide robust protection
3. **Cost Efficiency**: Reduced origin server load and optimized data transfer costs
4. **Scalability**: Automatic scaling to handle traffic spikes
5. **Flexibility**: Fine-grained control over caching, CORS, and security policies

### Best Practices Summary

- **Use Origin Access Control (OAC)** instead of Legacy Origin Access Identity (OAI)
- **Implement proper CORS headers** through CloudFront response headers policies
- **Set up appropriate cache policies** based on content type and update frequency
- **Monitor performance and security** with CloudWatch and WAF
- **Automate deployments** with CI/CD pipelines
- **Test CORS configuration** thoroughly across different origins and request types

By following this comprehensive guide, you'll have a robust, secure, and high-performing content delivery solution that scales with your application's needs while maintaining proper cross-origin access controls.

## Additional Resources

- [AWS CloudFront Documentation](https://docs.aws.amazon.com/cloudfront/)
- [S3 Security Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
- [CORS Specification (W3C)](https://www.w3.org/TR/cors/)
- [CloudFront Response Headers Policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/response-headers-policies.html)
- [Web Application Firewall (WAF) Documentation](https://docs.aws.amazon.com/waf/)