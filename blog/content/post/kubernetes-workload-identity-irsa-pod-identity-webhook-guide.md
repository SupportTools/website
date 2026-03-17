---
title: "Kubernetes Workload Identity with IRSA (IAM Roles for Service Accounts) and Pod Identity Webhooks"
date: 2031-08-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "AWS", "IRSA", "IAM", "Workload Identity", "Security", "EKS", "Pod Identity"]
categories: ["Kubernetes", "AWS", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes workload identity on AWS: IRSA architecture, OIDC provider configuration, EKS Pod Identity (the successor to IRSA), migration strategies, and multi-cloud workload identity patterns."
more_link: "yes"
url: "/kubernetes-workload-identity-irsa-pod-identity-webhook-guide/"
---

Workload identity solves a fundamental problem in cloud-native security: how does a Pod prove its identity to AWS (or other cloud providers) without storing long-lived credentials? The naive approach — mounting IAM credentials in a Secret — creates credential rotation problems, blast radius concerns, and secret sprawl. IRSA (IAM Roles for Service Accounts) solved this for EKS by binding IAM roles to Kubernetes ServiceAccounts using OIDC federation. EKS Pod Identity (2023+) improves on IRSA with simpler configuration and better performance. This guide covers both mechanisms, their architectural differences, and how to manage workload identity at scale.

<!--more-->

# Kubernetes Workload Identity with IRSA (IAM Roles for Service Accounts) and Pod Identity Webhooks

## Why Workload Identity Matters

Without workload identity:
```bash
# The naive approach: IAM user credentials in a Secret
kubectl create secret generic aws-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=<aws-access-key-id> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<aws-secret-access-key>
```

Problems with this approach:
- Credentials don't rotate automatically
- A compromised pod can exfiltrate credentials usable from anywhere
- Audit trail shows only "IAM user X did Y", not "Pod Z in Namespace N did Y"
- Secret must be synchronized across environments

With workload identity:
- No long-lived credentials anywhere in the cluster
- Credentials are short-lived tokens (1 hour max)
- CloudTrail entries include the full Kubernetes identity (namespace, service account, pod name)
- IAM role can have specific conditions limiting when tokens are valid

## IRSA Architecture

IRSA uses the following trust chain:

```
Kubernetes API
    │
    │  ServiceAccount token (projected volume, audience=sts.amazonaws.com)
    ▼
kubelet injects token into pod at /var/run/secrets/eks.amazonaws.com/serviceaccount/token
    │
    │  Pod calls STS AssumeRoleWithWebIdentity
    │  - Token: the SA token
    │  - RoleArn: arn:aws:iam::<account>:role/my-role
    ▼
AWS STS verifies token signature against the cluster's OIDC issuer URL
    │
    │  Returns temporary credentials (max 1 hour)
    ▼
Pod uses temporary credentials to call AWS APIs
```

The OIDC issuer URL is the bridge: AWS trusts tokens signed by the EKS cluster's OIDC provider because you configured that trust explicitly.

## Setting Up the OIDC Provider

### For EKS Clusters

```bash
# Get your cluster's OIDC issuer URL
CLUSTER_NAME=my-cluster
REGION=us-east-1

OIDC_URL=$(aws eks describe-cluster \
  --name "$CLUSTER_NAME" \
  --region "$REGION" \
  --query "cluster.identity.oidc.issuer" \
  --output text)

echo "OIDC URL: $OIDC_URL"
# Example: https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E

# Check if the OIDC provider is already registered
OIDC_ID=$(echo "$OIDC_URL" | cut -d '/' -f 5)
aws iam list-open-id-connect-providers | grep "$OIDC_ID"

# If not registered, create it
# Option 1: Using eksctl (recommended)
eksctl utils associate-iam-oidc-provider \
  --cluster "$CLUSTER_NAME" \
  --region "$REGION" \
  --approve

# Option 2: Manual creation
THUMBPRINT=$(openssl s_client -connect \
  "$(echo "$OIDC_URL" | cut -d'/' -f3):443" \
  -servername "$(echo "$OIDC_URL" | cut -d'/' -f3)" \
  2>/dev/null | openssl x509 -fingerprint -noout | \
  sed 's/SHA1 Fingerprint=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')

aws iam create-open-id-connect-provider \
  --url "$OIDC_URL" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "$THUMBPRINT"
```

### For Self-Managed Clusters (On-Premise or Other Cloud)

Self-managed clusters can use IRSA if they expose an OIDC discovery endpoint. This requires:

1. A publicly accessible OIDC discovery URL (or a private one accessible to AWS STS via VPC endpoints)
2. A signing key pair for ServiceAccount tokens
3. Configuration in the Kubernetes API server

```bash
# Generate a signing key pair for ServiceAccount tokens
openssl genrsa -out sa-signing-key.pem 2048
openssl rsa -in sa-signing-key.pem -pubout -out sa-signing-key-pub.pem

# Configure kube-apiserver with OIDC issuer
# Add these flags to kube-apiserver:
# --service-account-issuer=https://your-oidc-endpoint.example.com
# --service-account-key-file=/etc/kubernetes/pki/sa-signing-key.pem
# --service-account-signing-key-file=/etc/kubernetes/pki/sa-signing-key.pem
# --api-audiences=sts.amazonaws.com

# Host the OIDC discovery document
# GET https://your-oidc-endpoint.example.com/.well-known/openid-configuration
cat > oidc-config.json << 'EOF'
{
  "issuer": "https://your-oidc-endpoint.example.com",
  "jwks_uri": "https://your-oidc-endpoint.example.com/openid/v1/jwks",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
EOF
```

## Creating IAM Roles for Workloads

### Basic Pattern: Single Service Account

```bash
# Define the trust policy
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
NAMESPACE="production"
SERVICE_ACCOUNT="api-server"

cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_ID}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_ID}:aud": "sts.amazonaws.com",
          "${OIDC_ID}:sub": "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT}"
        }
      }
    }
  ]
}
EOF

# Create the role
aws iam create-role \
  --role-name "eks-${CLUSTER_NAME}-${NAMESPACE}-${SERVICE_ACCOUNT}" \
  --assume-role-policy-document file://trust-policy.json \
  --description "IRSA role for ${SERVICE_ACCOUNT} in ${NAMESPACE} namespace"

# Attach the permissions policy
aws iam attach-role-policy \
  --role-name "eks-${CLUSTER_NAME}-${NAMESPACE}-${SERVICE_ACCOUNT}" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"

# Or create a custom inline policy
aws iam put-role-policy \
  --role-name "eks-${CLUSTER_NAME}-${NAMESPACE}-${SERVICE_ACCOUNT}" \
  --policy-name "api-server-s3-access" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["s3:GetObject", "s3:PutObject"],
        "Resource": "arn:aws:s3:::my-app-bucket/*"
      },
      {
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": "arn:aws:s3:::my-app-bucket"
      }
    ]
  }'
```

### Kubernetes ServiceAccount with IRSA Annotation

```yaml
# serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api-server
  namespace: production
  annotations:
    # This annotation tells the IRSA webhook which IAM role to assume
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/eks-my-cluster-production-api-server
    # Optional: customize token expiry (default: 86400 seconds / 24 hours)
    eks.amazonaws.com/token-expiration: "3600"
    # Optional: for cross-account role assumption
    # eks.amazonaws.com/sts-regional-endpoints: "true"
automountServiceAccountToken: false  # Prevent the default SA token from being mounted
```

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: api-server
      containers:
        - name: api-server
          image: myrepo/api-server:v1.2.3
          env:
            # These environment variables are automatically set by the webhook
            # AWS_ROLE_ARN: arn:aws:iam::<account>:role/eks-my-cluster-production-api-server
            # AWS_WEB_IDENTITY_TOKEN_FILE: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
            - name: AWS_REGION
              value: us-east-1
            - name: AWS_DEFAULT_REGION
              value: us-east-1
          # AWS SDKs automatically use the IRSA credentials when these env vars are set
```

The IRSA webhook (pod-identity-webhook) automatically:
1. Adds `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` environment variables
2. Mounts the projected ServiceAccount token at `/var/run/secrets/eks.amazonaws.com/serviceaccount/token`

## How the Pod Identity Webhook Works

The pod-identity-webhook is a mutating admission webhook that modifies Pod specs before creation:

```bash
# View the webhook configuration
kubectl get mutatingwebhookconfigurations pod-identity-webhook -o yaml

# The webhook intercepts pods and checks if their ServiceAccount
# has the eks.amazonaws.com/role-arn annotation.
# If so, it mutates the pod spec to add:

# 1. Environment variables
# env:
#   - name: AWS_ROLE_ARN
#     value: arn:aws:iam::123456789:role/my-role
#   - name: AWS_WEB_IDENTITY_TOKEN_FILE
#     value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token

# 2. Volume mount for the projected token
# volumeMounts:
#   - name: aws-iam-token
#     mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
#     readOnly: true

# 3. Projected volume
# volumes:
#   - name: aws-iam-token
#     projected:
#       sources:
#         - serviceAccountToken:
#             audience: sts.amazonaws.com
#             expirationSeconds: 86400
#             path: token
```

### Installing the Webhook on Non-EKS Clusters

```bash
# Install the Amazon EKS Pod Identity Webhook on self-managed clusters
kubectl apply -f https://raw.githubusercontent.com/aws/amazon-eks-pod-identity-webhook/master/deploy/auth.yaml

# The webhook requires TLS certificates - use cert-manager
cat > webhook-certificate.yaml << 'EOF'
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: pod-identity-webhook
  namespace: kube-system
spec:
  secretName: pod-identity-webhook-cert
  duration: 8760h
  renewBefore: 720h
  dnsNames:
    - pod-identity-webhook
    - pod-identity-webhook.kube-system
    - pod-identity-webhook.kube-system.svc
    - pod-identity-webhook.kube-system.svc.cluster.local
  issuerRef:
    name: cluster-ca-issuer
    kind: ClusterIssuer
EOF

kubectl apply -f webhook-certificate.yaml

# Deploy the webhook
helm install pod-identity-webhook \
  --repo https://aws.github.io/eks-charts \
  eks/aws-pod-identity-webhook \
  --namespace kube-system \
  --set image.tag=v0.5.0 \
  --set config.defaultAudience=sts.amazonaws.com \
  --set config.annotationPrefix=eks.amazonaws.com \
  --set tls.secretName=pod-identity-webhook-cert
```

## EKS Pod Identity (Next Generation)

EKS Pod Identity (introduced 2023) is AWS's preferred replacement for IRSA. Key improvements:

| Feature | IRSA | EKS Pod Identity |
|---|---|---|
| Configuration | Annotation on ServiceAccount + IAM trust policy | EKS-side association only |
| IAM role portability | Role pinned to specific OIDC issuer | Role can be reused across clusters |
| Token rotation | Every 24h by default | Credentials rotate every 12h |
| Audit trail | Shows OIDC sub | Shows pod name and namespace |
| Cross-account | Requires additional STS configuration | Supported natively |
| ClusterRole | Not required | Required |

### Setting Up EKS Pod Identity

```bash
# Enable the EKS Pod Identity Agent addon
aws eks create-addon \
  --cluster-name my-cluster \
  --addon-name eks-pod-identity-agent \
  --addon-version v1.2.0-eksbuild.1

# Wait for the addon to be active
aws eks wait addon-active \
  --cluster-name my-cluster \
  --addon-name eks-pod-identity-agent

# Verify the DaemonSet is running
kubectl get daemonset -n kube-system eks-pod-identity-agent
```

### Creating a Pod Identity Association

```bash
# Create an IAM role for EKS Pod Identity
# Note: The trust policy is simpler - no OIDC provider needed
cat > pod-identity-trust.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "pods.eks.amazonaws.com"
      },
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ]
    }
  ]
}
EOF

aws iam create-role \
  --role-name my-app-pod-identity-role \
  --assume-role-policy-document file://pod-identity-trust.json

aws iam attach-role-policy \
  --role-name my-app-pod-identity-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Create the association (EKS-side configuration)
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace production \
  --service-account api-server \
  --role-arn arn:aws:iam::<account-id>:role/my-app-pod-identity-role

# List associations
aws eks list-pod-identity-associations \
  --cluster-name my-cluster \
  --namespace production
```

With EKS Pod Identity, NO annotation is needed on the ServiceAccount:

```yaml
# ServiceAccount needs NO annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api-server
  namespace: production
  # No eks.amazonaws.com/role-arn annotation needed
```

The Pod Identity Agent DaemonSet intercepts AWS API calls and provides credentials via the EC2 instance metadata endpoint (`169.254.170.23`), which is accessible only within the pod.

## Terraform for IRSA at Scale

Managing IRSA roles manually doesn't scale. Use Terraform to manage workload identity as code:

```hcl
# modules/irsa-role/main.tf
variable "cluster_name" {}
variable "cluster_oidc_issuer_url" {}
variable "namespace" {}
variable "service_account" {}
variable "iam_policies" {
  type = list(string)
  default = []
}
variable "inline_policies" {
  type    = map(string)
  default = {}
}

data "aws_iam_openid_connect_provider" "cluster" {
  url = var.cluster_oidc_issuer_url
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.cluster.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${data.aws_iam_openid_connect_provider.cluster.url}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${data.aws_iam_openid_connect_provider.cluster.url}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account}"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "eks-${var.cluster_name}-${var.namespace}-${var.service_account}"
  assume_role_policy = data.aws_iam_policy_document.trust.json

  tags = {
    ClusterName    = var.cluster_name
    Namespace      = var.namespace
    ServiceAccount = var.service_account
    ManagedBy      = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each   = toset(var.iam_policies)
  role       = aws_iam_role.this.name
  policy_arn = each.value
}

resource "aws_iam_role_policy" "inline" {
  for_each = var.inline_policies
  name     = each.key
  role     = aws_iam_role.this.id
  policy   = each.value
}

output "role_arn" {
  value = aws_iam_role.this.arn
}
```

```hcl
# Using the module
module "api_server_irsa" {
  source = "./modules/irsa-role"

  cluster_name             = module.eks.cluster_name
  cluster_oidc_issuer_url  = module.eks.cluster_oidc_issuer_url
  namespace                = "production"
  service_account          = "api-server"

  inline_policies = {
    s3-access = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "arn:aws:s3:::my-app-bucket/*"
      }]
    })
    ssm-access = jsonencode({
      Version = "2012-10-17"
      Statement = [{
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "arn:aws:ssm:us-east-1:*:parameter/my-app/*"
      }]
    })
  }
}

# Output the role ARN for use in the Kubernetes ServiceAccount annotation
output "api_server_role_arn" {
  value = module.api_server_irsa.role_arn
}
```

## Auditing Workload Identity Usage

AWS CloudTrail records every `AssumeRoleWithWebIdentity` call with full context:

```bash
# Query CloudTrail for IRSA usage
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --start-time "$(date -d '24 hours ago' -u +%Y-%m-%dT%H:%M:%SZ)" \
  --query 'Events[].{
    Time: EventTime,
    User: Username,
    Role: Resources[0].ResourceName
  }' | jq '.'

# The Username field contains the OIDC sub claim:
# system:serviceaccount:production:api-server
# This tells you exactly which SA/namespace made the call

# For EKS Pod Identity, the session tags include:
# - kubernetes-namespace: production
# - kubernetes-service-account: api-server
# - kubernetes-pod-name: api-server-7d9f8b-xyz
# - kubernetes-node-name: ip-10-0-1-100.ec2.internal
```

```python
# audit-irsa-usage.py - Analyze IRSA/Pod Identity usage for compliance reporting
import boto3
import json
from datetime import datetime, timedelta
from collections import defaultdict

cloudtrail = boto3.client('cloudtrail', region_name='us-east-1')

def get_irsa_events(hours=24):
    events = []
    paginator = cloudtrail.get_paginator('lookup_events')

    start_time = datetime.utcnow() - timedelta(hours=hours)

    for page in paginator.paginate(
        LookupAttributes=[{
            'AttributeKey': 'EventName',
            'AttributeValue': 'AssumeRoleWithWebIdentity'
        }],
        StartTime=start_time
    ):
        for event in page.get('Events', []):
            detail = json.loads(event.get('CloudTrailEvent', '{}'))
            request = detail.get('requestParameters', {})
            response = detail.get('responseElements', {})

            # Extract OIDC sub claim (Kubernetes identity)
            policy = request.get('webIdentityToken', '')
            sub = request.get('roleSessionName', 'unknown')

            events.append({
                'time': event['EventTime'].isoformat(),
                'role_arn': request.get('roleArn', 'unknown'),
                'session_name': sub,
                'source_ip': detail.get('sourceIPAddress', 'unknown'),
                'region': detail.get('awsRegion', 'unknown'),
            })

    return events

def summarize_usage(events):
    role_usage = defaultdict(lambda: {'count': 0, 'identities': set()})

    for event in events:
        role = event['role_arn']
        role_usage[role]['count'] += 1
        role_usage[role]['identities'].add(event['session_name'])

    return role_usage

if __name__ == '__main__':
    events = get_irsa_events(hours=24)
    usage = summarize_usage(events)

    print(f"IRSA/Pod Identity Usage Summary (last 24h)")
    print(f"Total AssumeRole calls: {len(events)}")
    print()

    for role, data in sorted(usage.items(), key=lambda x: x[1]['count'], reverse=True):
        print(f"Role: {role.split('/')[-1]}")
        print(f"  Calls: {data['count']}")
        print(f"  Identities: {', '.join(sorted(data['identities']))}")
        print()
```

## Migrating from Static Credentials to IRSA

```bash
#!/bin/bash
# migrate-to-irsa.sh - Scan a namespace for Deployments using static AWS credentials

NAMESPACE=${1:-default}

echo "Scanning namespace: $NAMESPACE"
echo ""

# Find deployments with AWS credential environment variables
kubectl get deployments -n "$NAMESPACE" -o json | jq -r '
  .items[] |
  select(
    .spec.template.spec.containers[].env[]? |
    .name == "AWS_ACCESS_KEY_ID" or .name == "AWS_SECRET_ACCESS_KEY"
  ) |
  .metadata.name
' | while read deployment; do
    echo "MIGRATION NEEDED: $deployment"
    echo "  Current ServiceAccount: $(kubectl get deployment $deployment -n $NAMESPACE -o jsonpath='{.spec.template.spec.serviceAccountName}')"
    echo ""
done

# Find secrets that look like AWS credentials
kubectl get secrets -n "$NAMESPACE" -o json | jq -r '
  .items[] |
  select(.data | keys[] | test("AWS_|aws_"))  |
  .metadata.name
' | while read secret; do
    echo "AWS CREDENTIAL SECRET: $secret"
    echo "  Keys: $(kubectl get secret $secret -n $NAMESPACE -o jsonpath='{.data}' | jq -r 'keys[]')"
    echo ""
done
```

## Troubleshooting IRSA

```bash
# Verify the webhook is running
kubectl get pods -n kube-system | grep pod-identity-webhook
kubectl logs -n kube-system -l app=pod-identity-webhook | tail -50

# Verify the projected token is mounted
kubectl exec -n production deploy/api-server -- \
  ls -la /var/run/secrets/eks.amazonaws.com/serviceaccount/

# Verify the token contents (it's a JWT)
kubectl exec -n production deploy/api-server -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token | \
  cut -d. -f2 | base64 -d 2>/dev/null | jq .
# Check that "iss" matches your OIDC URL and "aud" contains "sts.amazonaws.com"

# Test the credential chain manually
kubectl exec -n production deploy/api-server -- env | grep -E "AWS_ROLE|AWS_WEB"

# Test actual AWS credential acquisition
kubectl exec -n production deploy/api-server -- \
  aws sts get-caller-identity

# Expected output:
# {
#     "UserId": "AROAXXX:botocore-session-xxx",
#     "Account": "<account-id>",
#     "Arn": "arn:aws:sts::<account-id>:assumed-role/eks-my-cluster-production-api-server/botocore-session-xxx"
# }

# Debug STS token exchange
kubectl exec -n production deploy/api-server -- bash -c '
TOKEN=$(cat $AWS_WEB_IDENTITY_TOKEN_FILE)
aws sts assume-role-with-web-identity \
  --role-arn $AWS_ROLE_ARN \
  --role-session-name debug \
  --web-identity-token "$TOKEN" \
  --duration-seconds 3600
'
```

### Common Issues

**Token validation fails with "Issuer is not registered as a trusted provider"**:
```bash
# Verify the OIDC provider ARN matches what's in the IAM role trust policy
aws iam get-role --role-name my-role --query 'Role.AssumeRolePolicyDocument' | \
  python3 -m json.tool | grep oidc

# Compare with actual provider
aws iam list-open-id-connect-providers | grep oidc.eks
```

**"Unable to assume role" with ThumbprintMismatch**:
```bash
# Refresh the OIDC provider thumbprint
CERT=$(echo | openssl s_client \
  -connect oidc.eks.us-east-1.amazonaws.com:443 \
  -servername oidc.eks.us-east-1.amazonaws.com 2>/dev/null | \
  openssl x509 -fingerprint -sha1 -noout | \
  cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')

aws iam update-open-id-connect-provider-thumbprint \
  --open-id-connect-provider-arn arn:aws:iam::<account>:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE \
  --thumbprint-list "$CERT"
```

## Summary

Workload identity — whether through IRSA or EKS Pod Identity — is a non-negotiable security requirement for production Kubernetes on AWS. The transition from static credentials to short-lived, automatically rotated tokens dramatically reduces the blast radius of a compromised workload, provides genuine audit trails correlating AWS API calls to specific Kubernetes workloads, and eliminates the operational burden of credential rotation.

For new EKS clusters, use EKS Pod Identity rather than IRSA: the configuration is simpler (no OIDC trust policy required on the IAM role), the audit trail is richer (pod name in session tags), and AWS is actively investing in it as the preferred mechanism. For existing clusters with IRSA, the migration is straightforward — add the Pod Identity addon, create associations for each ServiceAccount, and remove the annotations when testing confirms correct operation.
