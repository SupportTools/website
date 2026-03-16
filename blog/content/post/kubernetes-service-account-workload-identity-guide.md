---
title: "Kubernetes Service Accounts and Workload Identity: IRSA, Workload Identity Federation, and Pod Identity"
date: 2027-05-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Service Account", "IRSA", "Workload Identity", "AWS", "GCP", "Azure", "Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes service accounts and workload identity, covering IRSA on EKS, Workload Identity on GKE, Federated Identity on AKS, OIDC token validation, and least-privilege patterns for production workloads."
more_link: "yes"
url: "/kubernetes-service-account-workload-identity-guide/"
---

Kubernetes workloads frequently require access to cloud provider APIs, object storage, secrets managers, and other services that demand authentication and authorization. The legacy approach of embedding long-lived credentials as environment variables or mounting static secrets introduces significant security risk: credential rotation becomes a manual process, blast radius on compromise is unbounded, and audit trails are difficult to establish.

Workload identity solves these problems by binding short-lived, cryptographically verifiable tokens to Kubernetes service accounts. This guide covers the full lifecycle of workload identity — from foundational service account token mechanics through cloud-specific implementations on AWS, GCP, and Azure — with production-ready configurations and security hardening patterns.

<!--more-->

## Service Account Token Fundamentals

### Kubernetes Service Accounts

Every pod in Kubernetes runs under a service account. When no service account is specified, the pod uses the `default` service account in its namespace. Service accounts are namespace-scoped resources that provide an identity to workloads within the cluster.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-processor
  namespace: finance
  annotations:
    # Cloud-specific annotations added later
automountServiceAccountToken: false  # Opt-in rather than opt-out
```

The `automountServiceAccountToken: false` field is a critical security control. By default, Kubernetes mounts a service account token into every pod at `/var/run/secrets/kubernetes.io/serviceaccount/token`. Disabling auto-mount at the service account level prevents this for all pods using the account, unless overridden explicitly in the pod spec.

### Legacy vs. Bound Service Account Tokens

Kubernetes 1.24 removed automatic creation of long-lived token secrets. Before this change, each service account had a corresponding `kubernetes.io/service-account-token` secret that never expired. These tokens were problematic because:

- No expiration time means a compromised token remains valid indefinitely
- Tokens are valid for any audience — a token meant for the API server could be presented to other services
- Rotation required manual deletion and recreation of the secret

Bound service account tokens, introduced in Kubernetes 1.12 and made the default in 1.20, address all three issues:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: payment-worker
  namespace: finance
spec:
  serviceAccountName: payment-processor
  automountServiceAccountToken: false  # Disable default mount
  volumes:
    - name: payment-token
      projected:
        sources:
          - serviceAccountToken:
              audience: "https://s3.amazonaws.com"
              expirationSeconds: 3600
              path: token
          - configMap:
              name: kube-root-ca.crt
              items:
                - key: ca.crt
                  path: ca.crt
          - downwardAPI:
              items:
                - path: namespace
                  fieldRef:
                    apiVersion: v1
                    fieldPath: metadata.namespace
  containers:
    - name: worker
      image: payment-worker:v2.1.0
      volumeMounts:
        - name: payment-token
          mountPath: /var/run/secrets/tokens
          readOnly: true
```

This projected volume creates a token bound to:
- A specific audience (`https://s3.amazonaws.com`)
- A maximum lifetime of 3600 seconds
- The specific pod and service account (embedded in the JWT claims)

The kubelet automatically rotates the token before expiration, and the token is invalidated when the pod terminates.

### JWT Structure of Bound Tokens

A bound service account token is a standard JWT signed by the cluster's OIDC private key:

```json
{
  "aud": ["https://s3.amazonaws.com"],
  "exp": 1716840000,
  "iat": 1716836400,
  "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
  "kubernetes.io": {
    "namespace": "finance",
    "pod": {
      "name": "payment-worker-7d4f8b9c5-xk9mn",
      "uid": "f8c3de3d-1fea-4d7c-a8b0-29f63c4c3454"
    },
    "serviceaccount": {
      "name": "payment-processor",
      "uid": "1234abcd-5678-efgh-ijkl-mnopqrstuvwx"
    },
    "warnafter": 1716840000
  },
  "nbf": 1716836400,
  "sub": "system:serviceaccount:finance:payment-processor"
}
```

Cloud providers validate this JWT against the cluster's OIDC discovery endpoint to establish trust, then exchange it for cloud-native credentials.

### OIDC Discovery Endpoint

For workload identity to function, the cluster must expose an OIDC discovery document. The discovery endpoint follows the standard OpenID Connect specification:

```
GET https://<issuer>/.well-known/openid-configuration
```

The response includes the JWKS URI where cloud providers can fetch the public keys to verify token signatures:

```json
{
  "issuer": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
  "jwks_uri": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE/keys",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
```

For self-managed clusters, this discovery endpoint must be publicly accessible or the cloud provider must be configured to trust the cluster's CA directly.

## IRSA: IAM Roles for Service Accounts on EKS

### Architecture Overview

IAM Roles for Service Accounts (IRSA) is AWS's implementation of workload identity for EKS. The flow works as follows:

1. Pod requests a token from the Kubernetes API server projected volume
2. Token is issued with audience `sts.amazonaws.com`
3. AWS SDK calls `sts:AssumeRoleWithWebIdentity` with the token
4. STS validates the token against the cluster's OIDC provider
5. STS returns temporary credentials (access key, secret key, session token)
6. SDK uses temporary credentials for subsequent API calls

### Configuring the OIDC Provider

```bash
# Retrieve the OIDC issuer URL for your cluster
CLUSTER_NAME="production-cluster"
REGION="us-east-1"

OIDC_URL=$(aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --region "${REGION}" \
  --query "cluster.identity.oidc.issuer" \
  --output text)

# Create the OIDC provider in IAM
eksctl utils associate-iam-oidc-provider \
  --cluster "${CLUSTER_NAME}" \
  --region "${REGION}" \
  --approve

# Verify the provider was created
aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[*].Arn" \
  --output table
```

### Creating an IAM Role with OIDC Trust Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:finance:payment-processor",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

The `StringEquals` condition on `sub` is critical — it scopes the role assumption to a specific namespace and service account. Without this constraint, any service account in the cluster could assume the role.

```bash
# Create the role
aws iam create-role \
  --role-name payment-processor-role \
  --assume-role-policy-document file://trust-policy.json

# Attach a permission policy
aws iam attach-role-policy \
  --role-name payment-processor-role \
  --policy-arn arn:aws:iam::123456789012:policy/PaymentProcessorPolicy

# Tag for cost tracking and governance
aws iam tag-role \
  --role-name payment-processor-role \
  --tags Key=kubernetes-cluster,Value=production-cluster \
         Key=kubernetes-namespace,Value=finance \
         Key=kubernetes-service-account,Value=payment-processor
```

### Annotating the Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-processor
  namespace: finance
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/payment-processor-role"
    eks.amazonaws.com/token-expiration: "3600"
    # Optional: disable session tags to reduce token size
    eks.amazonaws.com/sts-regional-endpoints: "true"
automountServiceAccountToken: false
```

### Pod Configuration for IRSA

The EKS Pod Identity Webhook automatically mutates pods to inject the required environment variables and projected volumes:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: payment-worker
  namespace: finance
spec:
  serviceAccountName: payment-processor
  containers:
    - name: worker
      image: payment-worker:v2.1.0
      env:
        # These are injected automatically by the webhook
        # Shown here for documentation purposes
        - name: AWS_ROLE_ARN
          value: "arn:aws:iam::123456789012:role/payment-processor-role"
        - name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token"
        - name: AWS_DEFAULT_REGION
          value: "us-east-1"
      volumeMounts:
        - name: aws-iam-token
          mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
          readOnly: true
  volumes:
    - name: aws-iam-token
      projected:
        defaultMode: 420
        sources:
          - serviceAccountToken:
              audience: sts.amazonaws.com
              expirationSeconds: 3600
              path: token
```

### EKS Pod Identity (Next Generation IRSA)

AWS introduced EKS Pod Identity in 2023 as a simplified alternative to IRSA that removes the OIDC provider dependency:

```bash
# Enable the EKS Pod Identity Agent addon
aws eks create-addon \
  --cluster-name production-cluster \
  --addon-name eks-pod-identity-agent \
  --addon-version v1.0.0-eksbuild.1

# Create a pod identity association
aws eks create-pod-identity-association \
  --cluster-name production-cluster \
  --namespace finance \
  --service-account payment-processor \
  --role-arn arn:aws:iam::123456789012:role/payment-processor-role
```

With EKS Pod Identity, the trust policy is simpler:

```json
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
```

The agent runs as a DaemonSet and handles credential vending through a local IMDS-compatible endpoint, eliminating the need to manage OIDC providers.

### Validating IRSA Configuration

```bash
# Deploy a test pod
kubectl run irsa-test \
  --image=amazon/aws-cli:latest \
  --serviceaccount=payment-processor \
  --namespace=finance \
  --rm -it \
  --restart=Never \
  -- aws sts get-caller-identity

# Expected output shows the role ARN in the Arn field
# {
#     "UserId": "AROAIOSFODNN7EXAMPLE:botocore-session-1234567890",
#     "Account": "123456789012",
#     "Arn": "arn:aws:sts::123456789012:assumed-role/payment-processor-role/botocore-session-1234567890"
# }

# Verify token audience
kubectl exec -n finance payment-worker -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token | \
  cut -d. -f2 | \
  base64 -d 2>/dev/null | \
  python3 -m json.tool
```

## Workload Identity on GKE

### Architecture

GKE Workload Identity binds Kubernetes service accounts to Google Cloud service accounts (GSAs). The flow:

1. Pod presents its Kubernetes service account token to the GKE metadata server
2. GKE metadata server validates the token and issues a Google-signed OIDC token
3. Google Cloud APIs accept the OIDC token for authentication

GKE Workload Identity Federation (introduced in 2023) extends this to non-GKE clusters.

### Enabling Workload Identity on a GKE Cluster

```bash
# Enable Workload Identity on an existing cluster
gcloud container clusters update production-cluster \
  --region=us-central1 \
  --workload-pool=my-project.svc.id.goog

# Enable on node pools
gcloud container node-pools update default-pool \
  --cluster=production-cluster \
  --region=us-central1 \
  --workload-metadata=GKE_METADATA
```

### Creating the Google Cloud Service Account

```bash
PROJECT_ID="my-project"
GSA_NAME="payment-processor"

# Create the service account
gcloud iam service-accounts create "${GSA_NAME}" \
  --project="${PROJECT_ID}" \
  --display-name="Payment Processor Service Account" \
  --description="Used by payment-processor pods in finance namespace"

# Grant required permissions
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${GSA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer" \
  --condition="expression=resource.name.startsWith('projects/_/buckets/payment-'),title=payment-buckets-only"

# Bind the Kubernetes service account to the Google service account
gcloud iam service-accounts add-iam-policy-binding \
  "${GSA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:${PROJECT_ID}.svc.id.goog[finance/payment-processor]"
```

### Annotating the Kubernetes Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-processor
  namespace: finance
  annotations:
    iam.gke.io/gcp-service-account: "payment-processor@my-project.iam.gserviceaccount.com"
automountServiceAccountToken: false
```

### Pod Configuration for GKE Workload Identity

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: payment-worker
  namespace: finance
spec:
  serviceAccountName: payment-processor
  containers:
    - name: worker
      image: payment-worker:v2.1.0
      # The GKE metadata server handles authentication transparently
      # Application code uses Application Default Credentials (ADC)
      env:
        - name: GOOGLE_CLOUD_PROJECT
          value: "my-project"
```

### Verifying GKE Workload Identity

```bash
# Deploy verification pod
kubectl run workload-identity-test \
  --image=google/cloud-sdk:slim \
  --serviceaccount=payment-processor \
  --namespace=finance \
  --rm -it \
  --restart=Never \
  -- gcloud auth print-identity-token

# Check the active account
kubectl run workload-identity-test \
  --image=google/cloud-sdk:slim \
  --serviceaccount=payment-processor \
  --namespace=finance \
  --rm -it \
  --restart=Never \
  -- gcloud config get-value account

# Expected: payment-processor@my-project.iam.gserviceaccount.com
```

### GKE Workload Identity Federation for External Clusters

Workload Identity Federation allows non-GKE Kubernetes clusters to use the same trust mechanism:

```bash
# Create a Workload Identity Pool
gcloud iam workload-identity-pools create "kubernetes-pool" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="On-premises Kubernetes clusters"

# Create a provider for your cluster's OIDC issuer
gcloud iam workload-identity-pools providers create-oidc "production-cluster" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="kubernetes-pool" \
  --display-name="Production K8s Cluster" \
  --attribute-mapping="google.subject=assertion.sub,attribute.namespace=assertion['kubernetes.io']['namespace'],attribute.service_account_name=assertion['kubernetes.io']['serviceaccount']['name']" \
  --issuer-uri="https://kubernetes.example.com" \
  --allowed-audiences="https://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/kubernetes-pool/providers/production-cluster"

# Bind the KSA to a GSA using pool membership
gcloud iam service-accounts add-iam-policy-binding \
  "${GSA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${PROJECT_ID}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/kubernetes-pool/attribute.namespace/finance"
```

## Federated Identity on AKS (Azure)

### Architecture

Azure Workload Identity for AKS uses OpenID Connect federation to bind Kubernetes service accounts to Azure Managed Identities or Azure AD application registrations. Microsoft deprecated the older pod-managed identity (aad-pod-identity) in favor of this approach.

### Enabling OIDC Issuer on AKS

```bash
# Enable OIDC issuer on an existing cluster
az aks update \
  --resource-group production-rg \
  --name production-cluster \
  --enable-oidc-issuer \
  --enable-workload-identity

# Retrieve the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --resource-group production-rg \
  --name production-cluster \
  --query "oidcIssuerProfile.issuerUrl" \
  --output tsv)

echo "OIDC Issuer: ${OIDC_ISSUER}"
```

### Creating a Managed Identity

```bash
RESOURCE_GROUP="production-rg"
MANAGED_IDENTITY_NAME="payment-processor-identity"
SUBSCRIPTION_ID=$(az account show --query id --output tsv)

# Create a user-assigned managed identity
az identity create \
  --name "${MANAGED_IDENTITY_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --location eastus

# Retrieve the identity details
CLIENT_ID=$(az identity show \
  --name "${MANAGED_IDENTITY_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query clientId \
  --output tsv)

OBJECT_ID=$(az identity show \
  --name "${MANAGED_IDENTITY_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query principalId \
  --output tsv)

# Grant permissions (e.g., Storage Blob Data Reader)
STORAGE_ACCOUNT_ID=$(az storage account show \
  --name paymentstore \
  --resource-group "${RESOURCE_GROUP}" \
  --query id \
  --output tsv)

az role assignment create \
  --assignee-object-id "${OBJECT_ID}" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Reader" \
  --scope "${STORAGE_ACCOUNT_ID}"
```

### Creating the Federated Identity Credential

```bash
# Create the federated identity credential
az identity federated-credential create \
  --name payment-processor-fed-cred \
  --identity-name "${MANAGED_IDENTITY_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --issuer "${OIDC_ISSUER}" \
  --subject "system:serviceaccount:finance:payment-processor" \
  --audience "api://AzureADTokenExchange"
```

### Kubernetes Configuration for AKS Workload Identity

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-processor
  namespace: finance
  annotations:
    azure.workload.identity/client-id: "CLIENT_ID_PLACEHOLDER"
    azure.workload.identity/tenant-id: "TENANT_ID_PLACEHOLDER"
  labels:
    azure.workload.identity/use: "true"
automountServiceAccountToken: false
---
apiVersion: v1
kind: Pod
metadata:
  name: payment-worker
  namespace: finance
  labels:
    azure.workload.identity/use: "true"
spec:
  serviceAccountName: payment-processor
  containers:
    - name: worker
      image: payment-worker:v2.1.0
      env:
        # These are injected by the Azure Workload Identity webhook
        - name: AZURE_CLIENT_ID
          value: "CLIENT_ID_PLACEHOLDER"
        - name: AZURE_TENANT_ID
          value: "TENANT_ID_PLACEHOLDER"
        - name: AZURE_FEDERATED_TOKEN_FILE
          value: "/var/run/secrets/azure/tokens/azure-identity-token"
        - name: AZURE_AUTHORITY_HOST
          value: "https://login.microsoftonline.com/"
```

### Verifying AKS Workload Identity

```bash
# Test with Azure CLI
kubectl run azure-identity-test \
  --image=mcr.microsoft.com/azure-cli:latest \
  --serviceaccount=payment-processor \
  --namespace=finance \
  --labels="azure.workload.identity/use=true" \
  --rm -it \
  --restart=Never \
  -- az storage blob list \
     --account-name paymentstore \
     --container-name transactions \
     --auth-mode login

# Check token audience in the projected volume
kubectl exec -n finance payment-worker -- \
  cat /var/run/secrets/azure/tokens/azure-identity-token | \
  cut -d. -f2 | \
  base64 -d 2>/dev/null | \
  python3 -m json.tool | \
  grep -E '"aud"|"sub"|"iss"'
```

## Cross-Cloud Federation

### Federated Tokens for Multi-Cloud Access

Organizations running workloads on one cloud that need access to resources on another cloud can chain workload identity federations.

A pod on EKS needing access to GCP Cloud Storage:

```yaml
# Step 1: The pod gets its EKS IRSA token
# Step 2: Exchange the AWS token for a GCP token via Workload Identity Federation

apiVersion: v1
kind: ServiceAccount
metadata:
  name: cross-cloud-processor
  namespace: integrations
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/cross-cloud-processor-role"
automountServiceAccountToken: false
```

GCP configuration to trust AWS credentials:

```bash
# Create a pool that trusts AWS
gcloud iam workload-identity-pools create "aws-pool" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --display-name="AWS EKS clusters"

gcloud iam workload-identity-pools providers create-aws "production-eks" \
  --project="${PROJECT_ID}" \
  --location="global" \
  --workload-identity-pool="aws-pool" \
  --account-id="123456789012"
```

Application code using the GCP Auth library:

```python
import google.auth
from google.auth import aws

# Configure credential source from AWS role
credentials = aws.Credentials(
    audience="//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/aws-pool/providers/production-eks",
    subject_token_type="urn:ietf:params:aws:token-type:aws4_request",
    service_account_impersonation_url="https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/cross-cloud@my-project.iam.gserviceaccount.com:generateAccessToken",
    credential_source={
        "environment_id": "aws1",
        "region_url": "http://169.254.169.254/latest/meta-data/placement/availability-zone",
        "url": "http://169.254.169.254/latest/meta-data/iam/security-credentials",
        "imdsv2_session_token_url": "http://169.254.169.254/latest/api/token"
    }
)
```

## Pod Identity: KUBE2IAM and Modern Successors

### Why Node-Level Approaches Were Problematic

KUBE2IAM and KIAM intercepted IMDS requests at the network level to provide pod-level identity on EC2 nodes. This approach had several drawbacks:

- Race conditions during pod startup
- Node-level IMDS interception could be bypassed
- Required privileged DaemonSets
- Performance overhead on every IMDS call
- Complex annotation management

IRSA and EKS Pod Identity replace these with a cryptographically sound approach.

### Migrating from KUBE2IAM to IRSA

```bash
# Identify pods using kube2iam annotations
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[] | select(.metadata.annotations["iam.amazonaws.com/role"] != null) |
  "\(.metadata.namespace)/\(.metadata.name): \(.metadata.annotations["iam.amazonaws.com/role"])"'

# For each unique role, create IRSA trust policy
# Old kube2iam annotation
# iam.amazonaws.com/role: "arn:aws:iam::123456789012:role/my-role"

# New IRSA annotation on service account
# eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/my-role"
```

Migration script outline:

```bash
#!/bin/bash
# migration-kube2iam-to-irsa.sh

CLUSTER_NAME="${1:?Cluster name required}"
REGION="${2:-us-east-1}"

OIDC_URL=$(aws eks describe-cluster \
  --name "${CLUSTER_NAME}" \
  --region "${REGION}" \
  --query "cluster.identity.oidc.issuer" \
  --output text | sed 's|https://||')

# Get all unique role ARNs from pod annotations
kubectl get pods --all-namespaces -o json | \
  jq -r '.items[].metadata.annotations["iam.amazonaws.com/role"] // empty' | \
  sort -u | while read -r ROLE_ARN; do
    ROLE_NAME=$(echo "${ROLE_ARN}" | cut -d/ -f2)
    echo "Processing role: ${ROLE_NAME}"

    # Get current trust policy
    CURRENT_POLICY=$(aws iam get-role \
      --role-name "${ROLE_NAME}" \
      --query "Role.AssumeRolePolicyDocument" \
      --output json)

    # Add OIDC provider to trust policy
    # (This would need customization per role's namespace/service-account)
    echo "Current trust policy for ${ROLE_NAME}:"
    echo "${CURRENT_POLICY}" | jq .
  done
```

## OIDC Token Validation Deep Dive

### How Cloud Providers Validate Tokens

Token validation follows the JWT specification with cloud-specific additions:

```python
import jwt
import requests
from cryptography.hazmat.primitives.asymmetric import rsa

def validate_kubernetes_token(token: str, oidc_issuer: str, expected_audience: str) -> dict:
    """
    Validates a Kubernetes bound service account token.
    This demonstrates the validation flow cloud providers use internally.
    """
    # Fetch the OIDC configuration
    discovery_url = f"{oidc_issuer}/.well-known/openid-configuration"
    oidc_config = requests.get(discovery_url, timeout=10).json()

    # Fetch the JWKS (JSON Web Key Set)
    jwks_response = requests.get(oidc_config["jwks_uri"], timeout=10).json()

    # Decode header to get key ID
    header = jwt.get_unverified_header(token)
    kid = header.get("kid")

    # Find the matching key
    public_key = None
    for key_data in jwks_response["keys"]:
        if key_data.get("kid") == kid:
            public_key = jwt.algorithms.RSAAlgorithm.from_jwk(key_data)
            break

    if not public_key:
        raise ValueError(f"No matching key found for kid: {kid}")

    # Validate the token
    claims = jwt.decode(
        token,
        public_key,
        algorithms=["RS256"],
        audience=expected_audience,
        issuer=oidc_issuer,
        options={
            "verify_exp": True,
            "verify_nbf": True,
            "verify_iss": True,
            "verify_aud": True,
        }
    )

    return claims
```

### Token Caching and Rotation

AWS SDKs and Google Cloud client libraries handle token refresh automatically, but understanding the lifecycle helps when troubleshooting:

```go
package main

import (
    "context"
    "fmt"
    "os"
    "sync"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials/stscreds"
    "github.com/aws/aws-sdk-go-v2/service/sts"
)

// WebIdentityTokenFileProvider implements stscreds.IdentityTokenRetriever
// to read the token from the projected volume, handling rotation transparently.
type WebIdentityTokenFileProvider struct {
    mu       sync.Mutex
    filePath string
    token    string
    expiry   time.Time
}

func (p *WebIdentityTokenFileProvider) GetIdentityToken() ([]byte, error) {
    p.mu.Lock()
    defer p.mu.Unlock()

    // Always read fresh token from file — kubelet rotates it automatically
    tokenBytes, err := os.ReadFile(p.filePath)
    if err != nil {
        return nil, fmt.Errorf("reading token file %s: %w", p.filePath, err)
    }

    return tokenBytes, nil
}

func setupAWSConfig(ctx context.Context) (aws.Config, error) {
    roleARN := os.Getenv("AWS_ROLE_ARN")
    tokenFile := os.Getenv("AWS_WEB_IDENTITY_TOKEN_FILE")

    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        return aws.Config{}, fmt.Errorf("loading AWS config: %w", err)
    }

    stsClient := sts.NewFromConfig(cfg)
    tokenProvider := &WebIdentityTokenFileProvider{filePath: tokenFile}

    creds := stscreds.NewWebIdentityRoleProvider(
        stsClient,
        roleARN,
        tokenProvider,
        func(o *stscreds.WebIdentityRoleOptions) {
            o.RoleSessionName = "payment-processor"
            o.Duration = 3600 * time.Second
        },
    )

    cfg.Credentials = aws.NewCredentialsCache(creds)
    return cfg, nil
}
```

## Security Hardening and Least-Privilege Patterns

### Namespace Isolation

```yaml
# Restrict which service accounts can use workload identity
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: workload-identity-validator
rules:
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["serviceaccounts/token"]
    verbs: ["create"]
---
# Only specific service accounts should have cloud access
# Use NetworkPolicies to restrict IMDS/metadata endpoint access
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-imds-access
  namespace: finance
spec:
  podSelector:
    matchExpressions:
      - key: app
        operator: NotIn
        values: ["payment-processor", "transaction-logger"]
  policyTypes:
    - Egress
  egress:
    - ports:
        - protocol: TCP
          port: 80
      to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 169.254.169.254/32  # AWS IMDS
              - 169.254.170.2/32    # AWS ECS metadata
```

### Disabling automountServiceAccountToken Cluster-Wide

```yaml
# Patch the default service account in every namespace
# Use a controller or admission webhook to enforce this

apiVersion: v1
kind: ServiceAccount
metadata:
  name: default
  namespace: production
automountServiceAccountToken: false
```

Enforce via Kyverno policy:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disable-automount-service-account-token
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-automount-service-account-token
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Pods must explicitly set automountServiceAccountToken: false or mount tokens via projected volumes with specific audiences"
        pattern:
          spec:
            automountServiceAccountToken: "false"
    - name: check-serviceaccount-automount
      match:
        any:
          - resources:
              kinds:
                - ServiceAccount
              names:
                - "default"
      validate:
        message: "The default service account must have automountServiceAccountToken: false"
        pattern:
          automountServiceAccountToken: "false"
```

### Least-Privilege IAM Policies

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadPaymentBucketOnly",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::payment-transactions",
        "arn:aws:s3:::payment-transactions/*"
      ],
      "Condition": {
        "StringEquals": {
          "s3:prefix": ["incoming/", "processed/"]
        },
        "Bool": {
          "aws:SecureTransport": "true"
        }
      }
    },
    {
      "Sid": "WriteSQSQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:GetQueueUrl"
      ],
      "Resource": "arn:aws:sqs:us-east-1:123456789012:payment-queue"
    },
    {
      "Sid": "DenyAllElse",
      "Effect": "Deny",
      "NotAction": [
        "s3:GetObject",
        "s3:ListBucket",
        "sqs:SendMessage",
        "sqs:GetQueueUrl"
      ],
      "Resource": "*"
    }
  ]
}
```

### Auditing Service Account Token Usage

```bash
# Enable AWS CloudTrail to audit AssumeRoleWithWebIdentity calls
aws cloudtrail create-trail \
  --name workload-identity-audit \
  --s3-bucket-name audit-logs-bucket \
  --include-global-service-events \
  --is-multi-region-trail

# Query CloudTrail for unusual role assumptions
aws logs filter-log-events \
  --log-group-name CloudTrail/DefaultLogGroup \
  --filter-pattern '{ ($.eventName = AssumeRoleWithWebIdentity) && ($.errorCode EXISTS) }' \
  --start-time $(date -d "1 hour ago" +%s000)

# GCP: Audit service account impersonation
gcloud logging read \
  'protoPayload.serviceName="iamcredentials.googleapis.com" AND protoPayload.methodName="GenerateAccessToken"' \
  --project="${PROJECT_ID}" \
  --limit=50 \
  --format=json | jq '.[] | {time: .timestamp, caller: .protoPayload.authenticationInfo.principalEmail, target: .protoPayload.request.name}'
```

### Prometheus Monitoring for Workload Identity

```yaml
# ServiceMonitor for tracking token rotation and credential errors
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: workload-identity-alerts
  namespace: monitoring
spec:
  groups:
    - name: workload-identity
      interval: 60s
      rules:
        - alert: TokenExpirationApproaching
          expr: |
            (
              kube_pod_annotation{annotation_eks_amazonaws_com_role_arn!=""} * 0 +
              time() - kube_pod_start_time
            ) > 3000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Pod {{ $labels.pod }} in {{ $labels.namespace }} may have stale workload identity token"
            description: "Pod has been running for over 50 minutes. Verify token rotation is functioning."

        - alert: IRSAAuthFailure
          expr: |
            increase(aws_sts_assume_role_with_web_identity_errors_total[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "IRSA authentication failures detected"
            description: "AWS STS AssumeRoleWithWebIdentity is failing, pods may lose cloud access."
```

## Operational Runbook

### Debugging Token Issues

```bash
#!/bin/bash
# debug-workload-identity.sh

NAMESPACE="${1:?Namespace required}"
POD_NAME="${2:?Pod name required}"
CLOUD="${3:-aws}"  # aws, gcp, azure

echo "=== Workload Identity Debug Report ==="
echo "Pod: ${NAMESPACE}/${POD_NAME}"
echo "Cloud: ${CLOUD}"
echo ""

# Check service account annotation
SA_NAME=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.serviceAccountName}')

echo "--- Service Account: ${SA_NAME} ---"
kubectl get serviceaccount "${SA_NAME}" -n "${NAMESPACE}" -o yaml

echo ""
echo "--- Projected Volume Mounts ---"
kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" -o json | \
  jq '.spec.volumes[] | select(.projected != null)'

echo ""
echo "--- Token Contents ---"
case "${CLOUD}" in
  aws)
    TOKEN_PATH="/var/run/secrets/eks.amazonaws.com/serviceaccount/token"
    ;;
  gcp)
    TOKEN_PATH="/var/run/secrets/kubernetes.io/serviceaccount/token"
    ;;
  azure)
    TOKEN_PATH="/var/run/secrets/azure/tokens/azure-identity-token"
    ;;
esac

kubectl exec "${POD_NAME}" -n "${NAMESPACE}" -- \
  cat "${TOKEN_PATH}" 2>/dev/null | \
  cut -d. -f2 | \
  base64 -d 2>/dev/null | \
  python3 -m json.tool 2>/dev/null || \
  echo "Could not read token from ${TOKEN_PATH}"

echo ""
echo "--- Recent Pod Events ---"
kubectl get events -n "${NAMESPACE}" \
  --field-selector "involvedObject.name=${POD_NAME}" \
  --sort-by='.lastTimestamp' | tail -20
```

### Common Issues and Resolutions

```bash
# Issue 1: Token audience mismatch
# Error: "aud claim does not match expected audience"
# Resolution: Verify projected volume audience matches cloud provider expectation

# AWS: audience must be "sts.amazonaws.com"
# GCP: audience must be the full Workload Identity Pool provider URL
# Azure: audience must be "api://AzureADTokenExchange"

# Issue 2: Subject claim mismatch
# Error: "sub claim does not match trust policy condition"
# Verify: kubectl get sa <name> -n <namespace> -o jsonpath='{.metadata.uid}'
# Expected format: system:serviceaccount:<namespace>:<service-account-name>

# Issue 3: OIDC provider certificate expired (self-managed clusters)
# Verify: openssl s_client -connect <oidc-issuer-host>:443 </dev/null 2>/dev/null | openssl x509 -noout -dates
# Resolution: Update the OIDC provider certificate in IAM/cloud provider configuration

# Issue 4: Token file not mounted (webhook not running)
kubectl get pods -n kube-system -l app=eks-pod-identity-webhook
kubectl get mutatingwebhookconfigurations | grep -E "eks|workload-identity|azure"

# Issue 5: Role trust policy too restrictive
# Check: does the trust policy allow the specific namespace and service account combination?
aws iam get-role --role-name <role-name> \
  --query "Role.AssumeRolePolicyDocument" | python3 -m json.tool
```

## Summary

Kubernetes workload identity has matured significantly across all major cloud providers. The key architectural principles remain consistent:

- Bound service account tokens provide cryptographically verifiable, short-lived identities
- OIDC federation eliminates long-lived credentials entirely
- Each cloud provider offers native mechanisms (IRSA, GKE Workload Identity, AKS Federated Identity) that leverage the same underlying token infrastructure
- Least-privilege IAM policies scoped to specific namespaces and service accounts minimize blast radius

The transition from static credential injection to workload identity is one of the highest-impact security improvements available to Kubernetes operators. Combined with `automountServiceAccountToken: false` by default and Kyverno or OPA Gatekeeper enforcement, workload identity establishes a zero-trust posture for pod-to-cloud communication.
