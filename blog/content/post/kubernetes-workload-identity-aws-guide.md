---
title: "Kubernetes Workload Identity on AWS: IRSA and Pod Identity Deep Dive"
date: 2028-02-01T00:00:00-05:00
draft: false
tags: ["AWS", "EKS", "IAM", "IRSA", "Pod Identity", "Security", "Kubernetes", "Workload Identity"]
categories: ["AWS", "Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production deep dive into AWS workload identity for Kubernetes including IAM Roles for Service Accounts (IRSA) with OIDC provider setup, EKS Pod Identity, cross-account access patterns, least-privilege IAM policies, and token volume projection."
more_link: "yes"
url: "/kubernetes-workload-identity-aws-guide/"
---

Hardcoded AWS credentials in application code or environment variables are a persistent security risk: they cannot be scoped to a single workload, they do not rotate automatically, and their compromise requires immediate manual revocation and rotation. AWS provides two mechanisms to bind IAM roles to Kubernetes workloads without static credentials: IAM Roles for Service Accounts (IRSA), which uses OIDC token exchange, and EKS Pod Identity, a newer approach that simplifies the trust relationship configuration and eliminates the need to manage an OIDC provider separately.

<!--more-->

# Kubernetes Workload Identity on AWS: IRSA and Pod Identity Deep Dive

## The Problem with Static Credentials

```yaml
# DANGEROUS: Static credentials as environment variables
# These credentials cannot be scoped to a single pod and persist
# until manually rotated
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
  namespace: production
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: EXAMPLEAWSACCESSKEY123
  AWS_SECRET_ACCESS_KEY: example-secret-key-do-not-use

# The application then uses these credentials:
# env:
#   - name: AWS_ACCESS_KEY_ID
#     valueFrom:
#       secretKeyRef:
#         name: aws-credentials
#         key: AWS_ACCESS_KEY_ID
```

Problems with static credentials:
- No automatic rotation — credentials must be manually updated when the IAM user rotates keys
- Overly broad scope — the same key is used across all environments
- Difficult to audit — no correlation between API calls and specific pods or workloads
- Blast radius — compromised credentials affect all workloads using that IAM user

## IRSA: IAM Roles for Service Accounts

### Architecture

```
Pod (with IRSA annotation)
├── Projected ServiceAccount Token
│     └── /var/run/secrets/eks.amazonaws.com/serviceaccount/token
│           ├── iss: https://oidc.eks.us-east-1.amazonaws.com/id/CLUSTER_ID
│           ├── sub: system:serviceaccount:production:my-app
│           └── exp: 86400 (1 day, auto-rotated by kubelet)
│
└── AWS SDK Credential Chain
      ↓ checks environment variables (not set)
      ↓ checks ~/.aws/credentials (not present in container)
      ↓ checks EC2 instance metadata (IMDS v2) - gets node role
      ↓ checks EKS_TOKEN_FILE env var (set by IRSA webhook)
            → calls STS AssumeRoleWithWebIdentity
            → presents the projected SA token
            → STS validates token signature with OIDC provider
            → STS validates the trust policy conditions
            → returns temporary credentials (valid 1 hour, auto-renewed)
```

### Step 1: Create the OIDC Provider

```bash
# Get the OIDC issuer URL for your EKS cluster
OIDC_URL=$(aws eks describe-cluster \
  --name production-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text)

echo "OIDC URL: ${OIDC_URL}"
# Example: https://oidc.eks.us-east-1.amazonaws.com/id/ABCDEF1234567890

# Get the OIDC URL without the https:// prefix
OIDC_PROVIDER=$(echo $OIDC_URL | sed 's/https:\/\///')

# Check if the OIDC provider already exists
aws iam list-open-id-connect-providers | grep ${OIDC_PROVIDER}

# If it does not exist, create it
# First, get the thumbprint of the OIDC provider certificate
OIDC_THUMBPRINT=$(openssl s_client -servername oidc.eks.us-east-1.amazonaws.com \
  -showcerts -connect oidc.eks.us-east-1.amazonaws.com:443 2>/dev/null \
  | openssl x509 -fingerprint -sha1 -noout 2>/dev/null \
  | sed 's/://g' | sed 's/SHA1 Fingerprint=//' | tr '[:upper:]' '[:lower:]')

# Create the OIDC provider
aws iam create-open-id-connect-provider \
  --url "${OIDC_URL}" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "${OIDC_THUMBPRINT}"

# Using eksctl (recommended — handles thumbprint automatically)
eksctl utils associate-iam-oidc-provider \
  --cluster production-cluster \
  --region us-east-1 \
  --approve
```

### Step 2: Create the IAM Role with Trust Policy

```bash
# Set variables
CLUSTER_NAME="production-cluster"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OIDC_PROVIDER=$(aws eks describe-cluster \
  --name ${CLUSTER_NAME} \
  --query "cluster.identity.oidc.issuer" \
  --output text | sed 's/https:\/\///')

NAMESPACE="production"
SERVICE_ACCOUNT_NAME="my-app"

# Create the trust policy document
# The condition scopes the role to a specific ServiceAccount in a specific namespace
# Without the condition, ANY pod with OIDC tokens could assume this role
cat > /tmp/trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com",
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT_NAME}"
        }
      }
    }
  ]
}
EOF

# Create the IAM role
aws iam create-role \
  --role-name eks-my-app-production \
  --assume-role-policy-document file:///tmp/trust-policy.json \
  --description "IAM role for my-app in EKS production namespace"

# Attach the minimal required policies
# PRINCIPLE: attach only the permissions the workload actually needs
aws iam put-role-policy \
  --role-name eks-my-app-production \
  --policy-name s3-read-write-appdata \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ],
        "Resource": [
          "arn:aws:s3:::my-app-data-production/*"
        ]
      },
      {
        "Effect": "Allow",
        "Action": [
          "s3:ListBucket"
        ],
        "Resource": [
          "arn:aws:s3:::my-app-data-production"
        ]
      }
    ]
  }'

echo "IAM Role ARN: arn:aws:iam::${AWS_ACCOUNT_ID}:role/eks-my-app-production"
```

### Step 3: Annotate the Kubernetes ServiceAccount

```yaml
# production/serviceaccount-my-app.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app
  namespace: production
  annotations:
    # IRSA: link this ServiceAccount to the IAM role
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/eks-my-app-production"
    # Optional: set the token expiry (default 86400 = 1 day)
    # Shorter expiry = more frequent renewal = better security, more API calls
    eks.amazonaws.com/token-expiration: "86400"
    # Optional: disable IMDSv1/v2 fallback for this SA
    # Forces the workload to use IRSA exclusively
    eks.amazonaws.com/sts-regional-endpoints: "true"
```

### Step 4: Reference the ServiceAccount in the Deployment

```yaml
# production/deployment-my-app.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    spec:
      # Reference the annotated ServiceAccount
      serviceAccountName: my-app
      containers:
        - name: app
          image: gcr.io/my-org/my-app:1.5.3
          # The IRSA webhook automatically adds these environment variables
          # and the projected volume when the SA has the role-arn annotation:
          #   AWS_ROLE_ARN: arn:aws:iam::123456789012:role/eks-my-app-production
          #   AWS_WEB_IDENTITY_TOKEN_FILE: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
          # The AWS SDK picks these up automatically via the credential chain
          env:
            - name: AWS_REGION
              value: us-east-1
            - name: AWS_DEFAULT_REGION
              value: us-east-1
```

### Verifying IRSA is Working

```bash
# Exec into the pod and verify the environment variables are set
kubectl exec -it my-app-7d4b9c-xk2lm -n production -- env | grep AWS

# Verify the token file exists and inspect it (use jwt-cli or jq)
kubectl exec -it my-app-7d4b9c-xk2lm -n production -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token | \
  cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Verify the actual STS call succeeds
kubectl exec -it my-app-7d4b9c-xk2lm -n production -- \
  aws sts get-caller-identity

# Expected output:
# {
#     "UserId": "AROAEXAMPLE:botocore-session-XXXX",
#     "Account": "123456789012",
#     "Arn": "arn:aws:sts::123456789012:assumed-role/eks-my-app-production/botocore-session-XXXX"
# }
```

## EKS Pod Identity (Newer Approach)

EKS Pod Identity, generally available since EKS 1.24, simplifies IRSA by removing the OIDC provider requirement and providing a more streamlined trust configuration.

### Architecture Comparison

```
IRSA:
  Pod → STS AssumeRoleWithWebIdentity → OIDC Provider Validation → IAM Role

EKS Pod Identity:
  Pod → EKS Pod Identity Agent (DaemonSet) → EKS control plane → IAM Role
  (No STS call from the pod, no OIDC provider to manage)
```

### Enabling EKS Pod Identity

```bash
# Enable the EKS Pod Identity Agent addon on the cluster
aws eks create-addon \
  --cluster-name production-cluster \
  --addon-name eks-pod-identity-agent \
  --addon-version v1.2.0-eksbuild.1 \
  --service-account-role-arn arn:aws:iam::123456789012:role/eks-pod-identity-agent

# Verify the agent DaemonSet is running
kubectl get daemonset -n kube-system eks-pod-identity-agent

# Check the agent is running on all nodes
kubectl get pods -n kube-system -l app.kubernetes.io/name=eks-pod-identity-agent
```

### Creating an IAM Role for Pod Identity

With Pod Identity, the trust relationship is simpler — no OIDC provider ARN needed.

```bash
# Create an IAM role with the Pod Identity trust policy
cat > /tmp/pod-identity-trust-policy.json << EOF
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
  --role-name eks-pod-identity-my-app \
  --assume-role-policy-document file:///tmp/pod-identity-trust-policy.json

# Attach the policy
aws iam attach-role-policy \
  --role-name eks-pod-identity-my-app \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
```

### Creating the Pod Identity Association

```bash
# Associate the IAM role with the ServiceAccount via the EKS API
# No annotation on the ServiceAccount is needed for Pod Identity
aws eks create-pod-identity-association \
  --cluster-name production-cluster \
  --namespace production \
  --service-account my-app \
  --role-arn arn:aws:iam::123456789012:role/eks-pod-identity-my-app

# List associations
aws eks list-pod-identity-associations \
  --cluster-name production-cluster

# Describe a specific association
aws eks describe-pod-identity-association \
  --cluster-name production-cluster \
  --association-id a-XXXXXXXXXX
```

## Cross-Account IAM Access

Applications sometimes need to access resources in a different AWS account. This requires chaining role assumptions.

### Cross-Account Trust Policy

```bash
# In Account B (the account holding the target resources):
# Create a role that Account A's EKS pods can assume

cat > /tmp/cross-account-trust.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::111111111111:role/eks-my-app-production"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "my-app-production-cross-account"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name cross-account-s3-access \
  --assume-role-policy-document file:///tmp/cross-account-trust.json \
  --profile account-b

# Attach S3 permissions to the cross-account role in Account B
aws iam attach-role-policy \
  --role-name cross-account-s3-access \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
  --profile account-b

# In Account A: add permission for the workload role to assume the cross-account role
aws iam put-role-policy \
  --role-name eks-my-app-production \
  --policy-name assume-cross-account-role \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::222222222222:role/cross-account-s3-access"
    }]
  }'
```

### Application Code for Cross-Account Role Assumption

```go
// pkg/aws/crossaccount.go
package aws

import (
    "context"
    "fmt"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials/stscreds"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/aws/aws-sdk-go-v2/service/sts"
)

// NewCrossAccountS3Client creates an S3 client that assumes a role in a
// different AWS account before making API calls.
// The calling workload must have permission to call sts:AssumeRole on the target role.
func NewCrossAccountS3Client(ctx context.Context, targetRoleARN, externalID, region string) (*s3.Client, error) {
    // Load the default configuration — this uses IRSA credentials automatically
    // when running in an EKS pod with IRSA configured
    cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
    if err != nil {
        return nil, fmt.Errorf("loading AWS config: %w", err)
    }

    // Create an STS client using the current workload identity
    stsClient := sts.NewFromConfig(cfg)

    // Create a credentials provider that assumes the cross-account role
    // The credentials are automatically refreshed before expiry
    assumeRoleProvider := stscreds.NewAssumeRoleProvider(
        stsClient,
        targetRoleARN,
        func(o *stscreds.AssumeRoleOptions) {
            // ExternalID adds an additional security layer
            o.ExternalID = aws.String(externalID)
            // Session name for audit trail
            o.RoleSessionName = "my-app-production-cross-account"
            // Credential duration (max 1 hour for cross-account)
            o.Duration = 3600 * time.Second
        },
    )

    // Create a new config that uses the assumed role credentials
    crossAccountCfg, err := config.LoadDefaultConfig(
        ctx,
        config.WithRegion(region),
        config.WithCredentialsProvider(assumeRoleProvider),
    )
    if err != nil {
        return nil, fmt.Errorf("loading cross-account AWS config: %w", err)
    }

    return s3.NewFromConfig(crossAccountCfg), nil
}
```

## Projected Token Volume Details

Understanding how the IRSA token is delivered helps with debugging and security analysis.

```yaml
# The IRSA admission webhook automatically adds this volume projection
# to pods whose ServiceAccount has the IRSA annotation.
# This shows what it injects:
spec:
  volumes:
    - name: aws-iam-token
      projected:
        sources:
          - serviceAccountToken:
              # Audience: must match the STS audience
              audience: sts.amazonaws.com
              # Expiration seconds: token will be refreshed before this
              expirationSeconds: 86400
              # Where to mount the token in the container
              path: token
  containers:
    - name: app
      volumeMounts:
        - mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
          name: aws-iam-token
          readOnly: true
      env:
        - name: AWS_ROLE_ARN
          value: arn:aws:iam::123456789012:role/eks-my-app-production
        - name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
```

### Inspecting the Token

```bash
# Decode the projected token to verify its claims
TOKEN=$(kubectl exec my-app-7d4b9c-xk2lm -n production -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token)

# Decode the JWT payload (middle section, base64)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Expected output:
# {
#   "aud": ["sts.amazonaws.com"],
#   "exp": 1705416000,
#   "iat": 1705329600,
#   "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/CLUSTER_ID",
#   "kubernetes.io": {
#     "namespace": "production",
#     "pod": {
#       "name": "my-app-7d4b9c-xk2lm",
#       "uid": "abc123"
#     },
#     "serviceaccount": {
#       "name": "my-app",
#       "uid": "def456"
#     }
#   },
#   "nbf": 1705329600,
#   "sub": "system:serviceaccount:production:my-app"
# }
```

## Preventing IMDS Abuse

The EC2 Instance Metadata Service (IMDS) provides the node's IAM role credentials. Pods that do not need the node role should be prevented from accessing IMDS.

```yaml
# Restrict IMDS access at the pod level via hostNetwork: false (default)
# For stronger restriction, use a NetworkPolicy to block IMDS access

# networkpolicy-block-imds.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: block-imds
  namespace: production
spec:
  podSelector: {}  # Applies to all pods in the namespace
  policyTypes:
    - Egress
  egress:
    # Allow all egress EXCEPT to the IMDS endpoint (169.254.169.254)
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              # Block access to EC2 Instance Metadata Service
              # Workloads should use IRSA, not instance credentials
              - 169.254.169.254/32
```

Alternatively, enforce IMDSv2 at the instance level and set hop limit to 1 (prevents pod access):

```bash
# Modify the launch template to enforce IMDSv2 with hop limit of 1
# This prevents containers from accessing IMDS (their packets have hop count 2
# due to the extra network hop through the pod network)
aws ec2 modify-instance-metadata-options \
  --instance-id i-1234567890abcdef0 \
  --http-tokens required \
  --http-put-response-hop-limit 1 \
  --http-endpoint enabled

# For all new nodes via the EKS managed node group launch template:
aws eks update-nodegroup-config \
  --cluster-name production-cluster \
  --nodegroup-name production-nodegroup \
  --update-config '{"maxUnavailable": 1}'
```

## Terraform for IRSA Automation

```hcl
# terraform/modules/irsa/main.tf
# Reusable module for creating IRSA-enabled IAM roles

variable "cluster_name" {}
variable "cluster_oidc_issuer_url" {}
variable "namespace" {}
variable "service_account_name" {}
variable "role_name" {}
variable "policy_document" {
  description = "JSON policy document for the role"
}

# Data source to look up the OIDC provider ARN
data "aws_iam_openid_connect_provider" "cluster" {
  url = var.cluster_oidc_issuer_url
}

# Trust policy that scopes access to the specific namespace/serviceaccount
data "aws_iam_policy_document" "assume_role" {
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
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account_name}"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = var.role_name
  assume_role_policy = data.aws_iam_policy_document.assume_role.json

  tags = {
    ClusterName      = var.cluster_name
    Namespace        = var.namespace
    ServiceAccount   = var.service_account_name
    ManagedBy        = "terraform"
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.role_name}-policy"
  role   = aws_iam_role.this.id
  policy = var.policy_document
}

output "role_arn" {
  value = aws_iam_role.this.arn
}
```

## Summary

IRSA and EKS Pod Identity both solve the same fundamental problem — securely binding IAM permissions to Kubernetes workloads — through different mechanisms. IRSA uses OIDC token exchange with STS and requires managing an OIDC provider in IAM. Pod Identity uses an in-cluster agent and the EKS control plane, eliminating the OIDC provider dependency and simplifying the trust policy syntax. For new EKS clusters on 1.24+, Pod Identity is the recommended approach. For clusters already using IRSA, migration to Pod Identity is straightforward since the AWS SDK credential chain handles both transparently. Cross-account access follows the same chained role assumption pattern regardless of which binding mechanism is used. The projected ServiceAccount token, with its bounded expiry and precise subject claim, provides the cryptographic binding between the Kubernetes identity and the IAM role that makes workload-level credential isolation practical at scale.
