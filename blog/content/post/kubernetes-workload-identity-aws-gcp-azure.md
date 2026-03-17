---
title: "Kubernetes Workload Identity for Cloud: Pod Identity with AWS, GCP, and Azure"
date: 2030-03-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "AWS", "GCP", "Azure", "Workload Identity", "IRSA", "Security", "OIDC"]
categories: ["Kubernetes", "Cloud", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Compare AWS IRSA vs EKS Pod Identity, configure GKE Workload Identity Federation, set up AKS Workload Identity, and implement cross-cloud secret access patterns with OIDC token projection."
more_link: "yes"
url: "/kubernetes-workload-identity-aws-gcp-azure/"
---

Kubernetes workload identity eliminates the single worst practice in cloud-native deployments: storing long-lived cloud credentials as Kubernetes Secrets. When your application pod automatically receives a short-lived, automatically-rotated credential bound to a specific IAM role, you eliminate the credential rotation burden, the risk of secret leakage, and the operational overhead of managing and distributing credentials.

Each cloud provider implements workload identity differently, and each has evolved their approach over time. This guide covers the current state-of-the-art for AWS (EKS Pod Identity and IRSA), GCP (Workload Identity Federation), and Azure (AKS Workload Identity), plus patterns for cross-cloud access.

<!--more-->

## The Problem with Long-Lived Credentials

Without workload identity, the common pattern is:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
type: Opaque
data:
  AWS_ACCESS_KEY_ID: "<base64-encoded-aws-access-key-id>"
  AWS_SECRET_ACCESS_KEY: "<base64-encoded-aws-secret-access-key>"
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - envFrom:
            - secretRef:
                name: aws-credentials
```

Problems with this approach:
- Credentials never expire automatically
- Rotation requires manual update of the Secret and pod restart
- Any pod with access to the Secret namespace can read the credentials
- Audit logs cannot distinguish which pod used the credentials
- Compromised credentials provide persistent access until manually revoked

Workload identity solves all of these by using OIDC tokens that are:
- Short-lived (typically 1 hour)
- Automatically rotated by the kubelet
- Pod-specific and auditable
- Bound to specific IAM roles with limited permissions

## AWS: IRSA vs EKS Pod Identity

AWS provides two mechanisms for pod IAM access. Understanding when to use each is important.

### IRSA (IAM Roles for Service Accounts)

IRSA was the original approach, available since 2019. It works on any Kubernetes cluster (not just EKS) by configuring the cluster's OIDC provider in AWS IAM.

**How it works:**
1. The EKS cluster has an OIDC issuer URL
2. AWS IAM trusts this OIDC issuer as an identity provider
3. The kubelet injects a projected service account token into pods
4. The pod's AWS SDK exchanges this token for temporary IAM credentials via `sts:AssumeRoleWithWebIdentity`

#### Setting Up IRSA

```bash
# Get the OIDC issuer URL for your EKS cluster
aws eks describe-cluster \
    --name my-cluster \
    --query "cluster.identity.oidc.issuer" \
    --output text
# Example: https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE

# Extract just the ID part
OIDC_ID=$(aws eks describe-cluster \
    --name my-cluster \
    --query "cluster.identity.oidc.issuer" \
    --output text | sed 's/.*\///')
echo $OIDC_ID
# EXAMPLED539D4633E53DE1B71EXAMPLE

# Check if OIDC provider exists in IAM
aws iam list-open-id-connect-providers | grep $OIDC_ID

# Create OIDC provider if it doesn't exist
eksctl utils associate-iam-oidc-provider \
    --cluster my-cluster \
    --region us-east-1 \
    --approve

# OR with AWS CLI directly:
aws iam create-open-id-connect-provider \
    --url "https://oidc.eks.us-east-1.amazonaws.com/id/${OIDC_ID}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "9e99a48a9960b14926bb7f3b02e22da2b0ab7280"
```

#### Creating an IAM Role for IRSA

```json
// trust-policy.json
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
                    "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:my-namespace:my-service-account",
                    "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
                }
            }
        }
    ]
}
```

```bash
# Create the IAM role
aws iam create-role \
    --role-name my-app-role \
    --assume-role-policy-document file://trust-policy.json

# Attach permission policy
aws iam attach-role-policy \
    --role-name my-app-role \
    --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Get the role ARN
ROLE_ARN=$(aws iam get-role --role-name my-app-role --query 'Role.Arn' --output text)
echo $ROLE_ARN
# arn:aws:iam::123456789012:role/my-app-role
```

#### Kubernetes Configuration for IRSA

```yaml
# service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: my-namespace
  annotations:
    # This annotation links the SA to the IAM role
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/my-app-role"
    # Optional: set token expiry (default 86400s = 24h, min 3600s = 1h)
    eks.amazonaws.com/token-expiration: "3600"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-namespace
spec:
  template:
    spec:
      serviceAccountName: my-service-account
      containers:
        - name: app
          image: my-app:v1.0
          # AWS SDK automatically uses the projected token
          # No credential environment variables needed
          env:
            - name: AWS_REGION
              value: "us-east-1"
```

The EKS pod identity mutating webhook automatically adds:
- `AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/serviceaccount/token`
- `AWS_ROLE_ARN=arn:aws:iam::123456789012:role/my-app-role`
- `AWS_DEFAULT_REGION=us-east-1`

### EKS Pod Identity (Newer Approach)

EKS Pod Identity was introduced in late 2023 and simplifies IRSA by moving the OIDC trust configuration to the EKS side rather than IAM:

```bash
# Create Pod Identity association
aws eks create-pod-identity-association \
    --cluster-name my-cluster \
    --namespace my-namespace \
    --service-account my-service-account \
    --role-arn arn:aws:iam::123456789012:role/my-app-pod-identity-role \
    --region us-east-1

# List associations
aws eks list-pod-identity-associations --cluster-name my-cluster

# The IAM role trust policy is simpler with Pod Identity:
cat << 'EOF' > pod-identity-trust-policy.json
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
    --assume-role-policy-document file://pod-identity-trust-policy.json
```

**IRSA vs EKS Pod Identity comparison:**

| Feature | IRSA | EKS Pod Identity |
|---------|------|-----------------|
| Works outside EKS | Yes | No |
| Cross-account access | With additional trust | Easier with session tags |
| IAM trust policy complexity | High (OIDC condition required) | Simple (service:pods.eks.amazonaws.com) |
| Available on all EKS versions | 1.13+ | 1.24+ |
| Multiple roles per SA | No | Yes (multiple associations) |

### IRSA with Terraform

```hcl
# terraform/irsa.tf

# Get the OIDC provider ARN
data "aws_eks_cluster" "cluster" {
  name = var.cluster_name
}

data "aws_iam_openid_connect_provider" "eks" {
  url = data.aws_eks_cluster.cluster.identity[0].oidc[0].issuer
}

# Create IAM role with trust policy
data "aws_iam_policy_document" "assume_role_policy" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.eks.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(data.aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account_name}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(data.aws_iam_openid_connect_provider.eks.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app_role" {
  name               = "${var.cluster_name}-${var.namespace}-${var.service_account_name}"
  assume_role_policy = data.aws_iam_policy_document.assume_role_policy.json

  tags = {
    "kubernetes.io/cluster"           = var.cluster_name
    "kubernetes.io/namespace"         = var.namespace
    "kubernetes.io/service-account"   = var.service_account_name
  }
}

resource "aws_iam_role_policy_attachment" "s3_read" {
  role       = aws_iam_role.app_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}

# Output the annotation for the Kubernetes service account
output "role_arn" {
  value = aws_iam_role.app_role.arn
}
```

## GCP: GKE Workload Identity Federation

GKE Workload Identity Federation (previously just "Workload Identity") maps Kubernetes service accounts to GCP IAM service accounts.

### Setting Up GKE Workload Identity

```bash
# Enable Workload Identity on a new cluster
gcloud container clusters create my-cluster \
    --workload-pool=my-project.svc.id.goog \
    --region=us-central1

# Or enable on an existing cluster
gcloud container clusters update my-cluster \
    --workload-pool=my-project.svc.id.goog \
    --region=us-central1

# Enable on a node pool
gcloud container node-pools update default-pool \
    --cluster=my-cluster \
    --workload-metadata=GKE_METADATA \
    --region=us-central1

# Verify Workload Identity is enabled
gcloud container clusters describe my-cluster \
    --region=us-central1 \
    --format="value(workloadIdentityConfig.workloadPool)"
# my-project.svc.id.goog
```

### Creating the IAM Binding

```bash
# Create a GCP service account
gcloud iam service-accounts create my-app-sa \
    --project=my-project \
    --display-name="My Application Service Account"

# Grant the GCP SA the permissions it needs
gcloud projects add-iam-policy-binding my-project \
    --member="serviceAccount:my-app-sa@my-project.iam.gserviceaccount.com" \
    --role="roles/storage.objectViewer"

# Bind the Kubernetes SA to the GCP SA
# This allows the K8s SA to impersonate the GCP SA
gcloud iam service-accounts add-iam-policy-binding \
    my-app-sa@my-project.iam.gserviceaccount.com \
    --project=my-project \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:my-project.svc.id.goog[my-namespace/my-service-account]"
```

### Kubernetes Configuration for GKE Workload Identity

```yaml
# service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: my-namespace
  annotations:
    # Annotation links K8s SA to GCP SA
    iam.gke.io/gcp-service-account: "my-app-sa@my-project.iam.gserviceaccount.com"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-namespace
spec:
  template:
    spec:
      serviceAccountName: my-service-account
      containers:
        - name: app
          image: gcr.io/my-project/my-app:v1.0
          # GCP client libraries automatically use workload identity
          # No credential file or environment variables needed
```

### Workload Identity Federation for Non-GKE Clusters

GCP supports Workload Identity Federation for external OIDC providers, enabling any Kubernetes cluster to authenticate to GCP:

```bash
# Create a Workload Identity Pool
gcloud iam workload-identity-pools create "external-k8s" \
    --project=my-project \
    --location="global" \
    --description="External Kubernetes clusters"

# Create an OIDC provider in the pool
# Use your cluster's OIDC issuer URL
gcloud iam workload-identity-pools providers create-oidc "my-k8s-cluster" \
    --project=my-project \
    --location="global" \
    --workload-identity-pool="external-k8s" \
    --issuer-uri="https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE" \
    --allowed-audiences="sts.amazonaws.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.namespace=assertion['kubernetes.io']['namespace'],attribute.service_account=assertion['kubernetes.io']['serviceaccount']['name']"

# Allow the specific K8s SA to impersonate a GCP SA
gcloud iam service-accounts add-iam-policy-binding \
    gcp-service-account@my-project.iam.gserviceaccount.com \
    --project=my-project \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/external-k8s/attribute.service_account/my-service-account"
```

## Azure: AKS Workload Identity

AKS Workload Identity uses the Azure AD Workload Identity feature to exchange Kubernetes service account tokens for Azure AD tokens.

### Setting Up AKS Workload Identity

```bash
# Enable OIDC issuer and Workload Identity on cluster
az aks update \
    --name my-cluster \
    --resource-group my-rg \
    --enable-oidc-issuer \
    --enable-workload-identity

# Get the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
    --name my-cluster \
    --resource-group my-rg \
    --query "oidcIssuerProfile.issuerUrl" \
    --output tsv)
echo $OIDC_ISSUER
# https://eastus.oic.prod-aks.azure.com/tenant-id/cluster-id/

# Create a User-Assigned Managed Identity
az identity create \
    --name my-app-identity \
    --resource-group my-rg \
    --location eastus

# Get identity details
CLIENT_ID=$(az identity show \
    --name my-app-identity \
    --resource-group my-rg \
    --query clientId \
    --output tsv)

# Assign permissions to the identity
# Example: access to Key Vault
az role assignment create \
    --assignee $CLIENT_ID \
    --role "Key Vault Secrets User" \
    --scope /subscriptions/sub-id/resourceGroups/my-rg/providers/Microsoft.KeyVault/vaults/my-kv

# Create federated credential binding
az identity federated-credential create \
    --name my-app-federated-credential \
    --identity-name my-app-identity \
    --resource-group my-rg \
    --issuer $OIDC_ISSUER \
    --subject "system:serviceaccount:my-namespace:my-service-account" \
    --audiences "api://AzureADTokenExchange"
```

### Kubernetes Configuration for AKS Workload Identity

```yaml
# service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: my-namespace
  annotations:
    # Link to the Azure Managed Identity's client ID
    azure.workload.identity/client-id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-namespace
  labels:
    azure.workload.identity/use: "true"  # Required label
spec:
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"  # Required on pod
    spec:
      serviceAccountName: my-service-account
      containers:
        - name: app
          image: myregistry.azurecr.io/my-app:v1.0
          # Azure SDK automatically uses workload identity
          # AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE are injected
          env:
            - name: AZURE_TENANT_ID
              value: "your-tenant-id"
```

The AKS workload identity mutating webhook injects:
- `AZURE_AUTHORITY_HOST`
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_FEDERATED_TOKEN_FILE=/var/run/secrets/azure/tokens/azure-identity-token`

## Cross-Cloud Secret Access Patterns

### AWS Secrets to GCP Workloads

```go
// Go application reading from AWS Secrets Manager from a GCP GKE pod
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "os"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/credentials"
    "github.com/aws/aws-sdk-go-v2/credentials/stscreds"
    "github.com/aws/aws-sdk-go-v2/service/secretsmanager"
    "github.com/aws/aws-sdk-go-v2/service/sts"

    "google.golang.org/api/iamcredentials/v1"
)

func getAWSCredentialsViaGCPWorkloadIdentity(ctx context.Context) (aws.Credentials, error) {
    // 1. Get GCP identity token via Workload Identity Federation
    gcpTokenSource, err := getGCPTokenSource(ctx)
    if err != nil {
        return aws.Credentials{}, fmt.Errorf("get GCP token: %w", err)
    }

    // 2. Exchange GCP token for AWS credentials via STS
    // This requires setting up AWS IAM to trust GCP's OIDC provider
    awsCfg, err := config.LoadDefaultConfig(ctx,
        config.WithRegion("us-east-1"),
        config.WithCredentialsProvider(
            stscreds.NewWebIdentityRoleProvider(
                sts.NewFromConfig(awsCfg),
                os.Getenv("AWS_ROLE_ARN"),
                &gcpTokenSource,
            ),
        ),
    )
    if err != nil {
        return aws.Credentials{}, err
    }

    return awsCfg.Credentials.Retrieve(ctx)
}
```

### External Secrets Operator for Unified Secret Management

```yaml
# external-secrets-operator handles cross-cloud secret fetching
# Install: helm install external-secrets external-secrets/external-secrets

# SecretStore for AWS Secrets Manager (using IRSA)
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secretsmanager
  namespace: my-namespace
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
---
# SecretStore for GCP Secret Manager (using Workload Identity)
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: gcp-secretmanager
  namespace: my-namespace
spec:
  provider:
    gcpsm:
      projectID: my-project
      auth:
        workloadIdentity:
          clusterLocation: us-central1
          clusterName: my-cluster
          serviceAccountRef:
            name: external-secrets-sa
---
# SecretStore for Azure Key Vault (using AKS Workload Identity)
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: azure-keyvault
  namespace: my-namespace
spec:
  provider:
    azurekv:
      vaultUrl: "https://my-keyvault.vault.azure.net"
      authType: WorkloadIdentity
      serviceAccountRef:
        name: external-secrets-sa
---
# ExternalSecret pulling from AWS
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: my-namespace
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: SecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: prod/myapp/database
        property: password
    - secretKey: username
      remoteRef:
        key: prod/myapp/database
        property: username
```

## OIDC Token Projection Details

Understanding the token projection mechanism helps diagnose issues:

```bash
# View the projected token inside a pod
kubectl exec -it my-pod -- cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token

# Decode and inspect the JWT
TOKEN=$(kubectl exec my-pod -- cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool

# Typical payload:
# {
#     "aud": ["sts.amazonaws.com"],
#     "exp": 1706745600,
#     "iat": 1706742000,
#     "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
#     "kubernetes.io": {
#         "namespace": "my-namespace",
#         "pod": {"name": "my-pod-xyz", "uid": "..."},
#         "serviceaccount": {"name": "my-service-account", "uid": "..."}
#     },
#     "nbf": 1706742000,
#     "sub": "system:serviceaccount:my-namespace:my-service-account"
# }

# Test AWS token exchange manually
aws sts assume-role-with-web-identity \
    --role-arn arn:aws:iam::123456789012:role/my-app-role \
    --role-session-name test-session \
    --web-identity-token "$TOKEN" \
    --duration-seconds 3600
```

## Debugging Workload Identity Issues

```bash
# AWS IRSA debugging
# Check if webhook is present
kubectl get pods -n kube-system | grep pod-identity-webhook

# Check pod's environment variables
kubectl exec my-pod -- env | grep AWS

# Test AWS credentials from within pod
kubectl exec my-pod -- aws sts get-caller-identity

# Common error: AccessDenied - check role trust policy
aws iam get-role --role-name my-app-role --query 'Role.AssumeRolePolicyDocument' | python3 -m json.tool

# GKE Workload Identity debugging
# Verify node pool has GKE_METADATA
gcloud container node-pools describe default-pool \
    --cluster my-cluster \
    --region us-central1 \
    --format="value(config.workloadMetadataConfig.mode)"
# Should show: GKE_METADATA

# Test from within pod (needs google-cloud-sdk)
kubectl exec my-pod -- gcloud auth print-access-token
kubectl exec my-pod -- curl -s "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    -H "Metadata-Flavor: Google"

# AKS Workload Identity debugging
# Check webhook is running
kubectl get pods -n kube-system | grep azure-wi-webhook

# Check pod labels
kubectl get pod my-pod -o jsonpath='{.metadata.labels}'

# Check injected files
kubectl exec my-pod -- ls /var/run/secrets/azure/tokens/
kubectl exec my-pod -- env | grep AZURE
```

## Key Takeaways

Cloud workload identity has matured significantly across all three major providers:

1. **IRSA remains the most portable option for AWS**: It works on any Kubernetes cluster pointing to AWS, not just EKS. EKS Pod Identity is simpler but EKS-only.
2. **GKE Workload Identity Federation enables non-GKE clusters**: Any cluster with an OIDC issuer can authenticate to GCP resources without static credentials.
3. **AKS Workload Identity requires both the OIDC issuer and the `azure.workload.identity/use` label**: Missing either one means the webhook won't inject credentials.
4. **External Secrets Operator abstracts the provider differences**: When your application needs secrets from multiple clouds or you want to migrate between providers, ESO provides a consistent interface.
5. **Token TTL should be short**: Use 1-hour tokens (minimum) rather than 24-hour defaults. Shorter TTLs mean compromised tokens expire faster.
6. **Audit logs are significantly better with workload identity**: CloudTrail, Cloud Audit Logs, and Azure Monitor can attribute API calls to specific pods and namespaces, not just "some EC2 instance with this role."
7. **Least privilege is easier to enforce**: With per-service-account roles, you can grant each microservice only the permissions it needs rather than sharing a broad role across all workloads.
