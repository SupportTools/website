---
title: "Kubernetes Workload Identity: IRSA, Workload Identity Federation, and AKS Managed Identity"
date: 2027-08-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "IAM", "AWS", "GCP", "Azure"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Cloud-native workload identity patterns covering AWS IRSA via OIDC, GCP Workload Identity Federation, AKS managed identity with pod identity. Covers token projection, service account annotations, cross-cloud patterns, and troubleshooting identity binding failures."
more_link: "yes"
url: "/kubernetes-workload-identity-aws-gcp-azure-guide/"
---

Hardcoded cloud credentials in Kubernetes secrets represent one of the most persistent and dangerous security anti-patterns. Every major cloud provider now offers a cryptographic workload identity mechanism that eliminates static credentials entirely: AWS IRSA uses OIDC token projection to assume IAM roles, GCP Workload Identity Federation maps Kubernetes service accounts to GCP service accounts, and AKS workload identity leverages Azure AD federated credentials. Each mechanism delivers fine-grained, pod-level cloud permissions that rotate automatically and leave no credentials to leak.

<!--more-->

## How Workload Identity Works

### The OIDC Token Projection Pattern

All three cloud providers use a common mechanism: the Kubernetes API server acts as an OIDC provider, issuing short-lived tokens that cloud IAM systems can validate cryptographically:

```
1. Pod starts with projected service account token
2. Application presents token to cloud IAM endpoint
3. Cloud IAM validates token signature against OIDC discovery endpoint
4. Cloud IAM issues short-lived cloud credentials (15min–1hr)
5. Application uses cloud credentials to access resources
6. Token expires; application requests new credentials automatically
```

The projected token contains the service account name, namespace, and audience claims — enough information to establish identity without storing credentials anywhere.

## AWS IRSA (IAM Roles for Service Accounts)

### Setting Up OIDC Provider for EKS

```bash
# Get EKS cluster OIDC issuer URL
CLUSTER_NAME="production-cluster"
OIDC_ISSUER=$(aws eks describe-cluster \
  --name "$CLUSTER_NAME" \
  --query "cluster.identity.oidc.issuer" \
  --output text)

echo "OIDC Issuer: $OIDC_ISSUER"
# https://oidc.eks.us-east-1.amazonaws.com/id/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Check if OIDC provider already exists
aws iam list-open-id-connect-providers | grep $(echo $OIDC_ISSUER | awk -F/ '{print $NF}')

# Create the OIDC provider if it doesn't exist
eksctl utils associate-iam-oidc-provider \
  --cluster "$CLUSTER_NAME" \
  --approve

# Or using AWS CLI directly
OIDC_ID=$(echo $OIDC_ISSUER | awk -F/ '{print $NF}')
THUMBPRINT=$(openssl s_client -connect oidc.eks.us-east-1.amazonaws.com:443 \
  -servername oidc.eks.us-east-1.amazonaws.com 2>/dev/null | \
  openssl x509 -fingerprint -noout -sha1 | awk -F= '{print $2}' | tr -d ':' | tr '[:upper:]' '[:lower:]')

aws iam create-open-id-connect-provider \
  --url "$OIDC_ISSUER" \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list "$THUMBPRINT"
```

### Creating IAM Role with OIDC Trust Policy

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
NAMESPACE="production"
SERVICE_ACCOUNT="s3-reader-sa"

# Create the IAM role trust policy
cat > /tmp/trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_ISSUER#*//}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_ISSUER#*//}:sub": "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT}",
          "${OIDC_ISSUER#*//}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

# Create the IAM role
ROLE_NAME="eks-s3-reader-production"
aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document file:///tmp/trust-policy.json \
  --description "EKS IRSA role for S3 read access from production namespace"

# Attach a permissions policy to the role
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)
echo "Role ARN: $ROLE_ARN"
```

### Annotating the Kubernetes Service Account

```yaml
# service-account-irsa.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: s3-reader-sa
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/eks-s3-reader-production"
    eks.amazonaws.com/token-expiration: "86400"    # Token TTL in seconds
```

```bash
kubectl apply -f service-account-irsa.yaml

# Verify annotation
kubectl get sa s3-reader-sa -n production -o yaml | grep "eks.amazonaws.com"
```

### Pod Configuration with IRSA

```yaml
# pod-with-irsa.yaml
apiVersion: v1
kind: Pod
metadata:
  name: s3-reader-pod
  namespace: production
spec:
  serviceAccountName: s3-reader-sa   # Must match the annotated SA
  containers:
    - name: app
      image: amazon/aws-cli:latest
      command: ["sleep", "infinity"]
      env:
        # AWS SDK reads these automatically when using IRSA
        - name: AWS_DEFAULT_REGION
          value: "us-east-1"
      # No AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY needed
```

The EKS pod identity webhook automatically injects two environment variables into pods using annotated service accounts:
- `AWS_ROLE_ARN`: The IAM role ARN
- `AWS_WEB_IDENTITY_TOKEN_FILE`: Path to the projected service account token

```bash
# Verify IRSA is working
kubectl exec -n production s3-reader-pod -- \
  aws sts get-caller-identity

# Expected output:
# {
#   "UserId": "AROAI3UDYZEXAMPLE:botocore-session-...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:sts::123456789012:assumed-role/eks-s3-reader-production/botocore-session-..."
# }
```

### Using eksctl for IRSA (Simplified)

```bash
# eksctl creates the IAM role and service account together
eksctl create iamserviceaccount \
  --cluster production-cluster \
  --namespace production \
  --name s3-reader-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
  --approve \
  --override-existing-serviceaccounts
```

## GCP Workload Identity Federation

### Enabling Workload Identity on GKE

```bash
PROJECT_ID="my-gcp-project"
CLUSTER_NAME="production-cluster"
CLUSTER_ZONE="us-central1-a"

# Enable Workload Identity on existing cluster
gcloud container clusters update "$CLUSTER_NAME" \
  --zone "$CLUSTER_ZONE" \
  --workload-pool="${PROJECT_ID}.svc.id.goog"

# Enable on node pools
gcloud container node-pools update default-pool \
  --cluster "$CLUSTER_NAME" \
  --zone "$CLUSTER_ZONE" \
  --workload-metadata=GKE_METADATA

# Verify
gcloud container clusters describe "$CLUSTER_NAME" \
  --zone "$CLUSTER_ZONE" \
  --format="get(workloadIdentityConfig.workloadPool)"
```

### Creating GCP Service Account and IAM Binding

```bash
K8S_NAMESPACE="production"
K8S_SERVICE_ACCOUNT="gcs-reader-sa"
GCP_SERVICE_ACCOUNT="gcs-reader"

# Create GCP service account
gcloud iam service-accounts create "$GCP_SERVICE_ACCOUNT" \
  --display-name "GCS Reader for Kubernetes workloads" \
  --project "$PROJECT_ID"

GCP_SA_EMAIL="${GCP_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"

# Grant GCS permissions to the GCP SA
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${GCP_SA_EMAIL}" \
  --role "roles/storage.objectViewer"

# Allow the Kubernetes SA to impersonate the GCP SA
# This is the core Workload Identity binding
gcloud iam service-accounts add-iam-policy-binding "$GCP_SA_EMAIL" \
  --role "roles/iam.workloadIdentityUser" \
  --member "serviceAccount:${PROJECT_ID}.svc.id.goog[${K8S_NAMESPACE}/${K8S_SERVICE_ACCOUNT}]"
```

### Annotating the Kubernetes Service Account (GCP)

```yaml
# service-account-gcp-wi.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: gcs-reader-sa
  namespace: production
  annotations:
    iam.gke.io/gcp-service-account: "gcs-reader@my-gcp-project.iam.gserviceaccount.com"
```

```bash
# Verify the binding is working
kubectl run -it wi-test \
  --image=gcr.io/cloud-builders/gcloud \
  --restart=Never \
  --namespace=production \
  --serviceaccount=gcs-reader-sa \
  -- gcloud auth list

# Should show:
# Credentialed Accounts:
# ACTIVE  ACCOUNT
# *       gcs-reader@my-gcp-project.iam.gserviceaccount.com
```

### GCP Workload Identity for Non-GKE Clusters (Workload Identity Federation)

For clusters outside GCP (on-premises, AWS, other clouds):

```bash
# Create a Workload Identity Pool
gcloud iam workload-identity-pools create "k8s-external-pool" \
  --location="global" \
  --display-name="Kubernetes External Clusters" \
  --project "$PROJECT_ID"

# Add an OIDC provider for the external cluster
EXTERNAL_CLUSTER_ISSUER="https://oidc.eks.us-east-1.amazonaws.com/id/XXXXXXXXXXXXXXXX"

gcloud iam workload-identity-pools providers create-oidc "eks-production" \
  --location="global" \
  --workload-identity-pool="k8s-external-pool" \
  --display-name="EKS Production Cluster" \
  --attribute-mapping="google.subject=assertion.sub,attribute.namespace=assertion['kubernetes.io']['namespace'],attribute.service_account=assertion['kubernetes.io']['serviceaccount']['name']" \
  --issuer-uri="$EXTERNAL_CLUSTER_ISSUER" \
  --project "$PROJECT_ID"

# Allow specific Kubernetes SA to impersonate GCP SA
gcloud iam service-accounts add-iam-policy-binding "$GCP_SA_EMAIL" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/k8s-external-pool/attribute.service_account/gcs-reader-sa"
```

## AKS Workload Identity (Azure AD Federated Credentials)

### Enabling Workload Identity on AKS

```bash
RESOURCE_GROUP="production-rg"
CLUSTER_NAME="production-aks"
SUBSCRIPTION_ID="AZURE-SUBSCRIPTION-ID-REPLACE-ME"

# Create AKS cluster with workload identity enabled
az aks create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" \
  --enable-oidc-issuer \
  --enable-workload-identity \
  --generate-ssh-keys

# Get the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" \
  --query "oidcIssuerProfile.issuerUrl" \
  --output tsv)

echo "OIDC Issuer: $OIDC_ISSUER"
```

### Creating Azure Managed Identity and Federated Credential

```bash
IDENTITY_NAME="aks-storage-reader"
K8S_NAMESPACE="production"
K8S_SERVICE_ACCOUNT="storage-reader-sa"

# Create user-assigned managed identity
az identity create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME"

IDENTITY_CLIENT_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  --query clientId \
  --output tsv)

IDENTITY_OBJECT_ID=$(az identity show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$IDENTITY_NAME" \
  --query principalId \
  --output tsv)

# Assign storage permissions to the managed identity
STORAGE_ACCOUNT_ID="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Storage/storageAccounts/myStorageAccount"

az role assignment create \
  --assignee-object-id "$IDENTITY_OBJECT_ID" \
  --role "Storage Blob Data Reader" \
  --scope "$STORAGE_ACCOUNT_ID"

# Create federated credential linking Kubernetes SA to Managed Identity
az identity federated-credential create \
  --name "kubernetes-federated-credential" \
  --identity-name "$IDENTITY_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --issuer "$OIDC_ISSUER" \
  --subject "system:serviceaccount:${K8S_NAMESPACE}:${K8S_SERVICE_ACCOUNT}" \
  --audiences "api://AzureADTokenExchange"
```

### Kubernetes Service Account for AKS

```yaml
# service-account-aks-wi.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: storage-reader-sa
  namespace: production
  annotations:
    azure.workload.identity/client-id: "MANAGED-IDENTITY-CLIENT-ID-HERE"
```

```yaml
# pod-with-aks-wi.yaml
apiVersion: v1
kind: Pod
metadata:
  name: storage-reader-pod
  namespace: production
  labels:
    azure.workload.identity/use: "true"   # Required label for token injection
spec:
  serviceAccountName: storage-reader-sa
  containers:
    - name: app
      image: mcr.microsoft.com/azure-cli:latest
      command: ["sleep", "infinity"]
      # Azure Identity SDK reads AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE
      # injected automatically by the workload identity webhook
```

```bash
# Verify Azure workload identity
kubectl exec -n production storage-reader-pod -- \
  az login --federated-token "$(cat $AZURE_FEDERATED_TOKEN_FILE)" \
    --service-principal \
    --username "$AZURE_CLIENT_ID" \
    --tenant "$AZURE_TENANT_ID"

az storage blob list \
  --account-name myStorageAccount \
  --container-name mycontainer \
  --auth-mode login
```

## Cross-Cloud Identity Patterns

### AWS → GCP Access via OIDC Federation

EKS pods accessing GCP resources without static credentials:

```bash
# EKS pod uses IRSA to get AWS credentials
# AWS credentials are not needed for GCP access

# The EKS OIDC token is presented directly to GCP WIF
# GCP validates against the registered EKS OIDC provider
# Application uses Google auth libraries that support workload identity

# In the application (Python example):
# from google.auth import external_account
# credentials = external_account.Credentials.from_file(
#     "/var/run/secrets/gcp-wif/config.json"
# )
```

## Troubleshooting Identity Binding Failures

### AWS IRSA Debugging

```bash
# Error: "AccessDenied: not authorized to assume role"
# Check: Does the trust policy SubCondition match exactly?

# Verify the token audience
kubectl exec -n production $POD_NAME -- \
  cat $AWS_WEB_IDENTITY_TOKEN_FILE | \
  python3 -c "import sys,json,base64; t=sys.stdin.read().split('.')[1]; print(json.loads(base64.b64decode(t+'==')))"

# Expected claims:
# "aud": ["sts.amazonaws.com"]
# "sub": "system:serviceaccount:production:s3-reader-sa"

# Verify the service account annotation
kubectl get sa s3-reader-sa -n production -o jsonpath='{.metadata.annotations}'

# Test token exchange manually
aws sts assume-role-with-web-identity \
  --role-arn "arn:aws:iam::123456789012:role/eks-s3-reader-production" \
  --role-session-name "debug-session" \
  --web-identity-token "$(kubectl exec -n production $POD_NAME -- cat $AWS_WEB_IDENTITY_TOKEN_FILE)"
```

### GCP Workload Identity Debugging

```bash
# Error: "Permission denied" or "Unable to detect credentials"
# Check: Is the node pool running with GKE_METADATA?
gcloud container node-pools describe default-pool \
  --cluster "$CLUSTER_NAME" \
  --zone "$CLUSTER_ZONE" \
  --format="get(config.workloadMetadataConfig.mode)"
# Expected: GKE_METADATA

# Verify IAM binding
gcloud iam service-accounts get-iam-policy "$GCP_SA_EMAIL" \
  --format=json | jq '.bindings[] | select(.role == "roles/iam.workloadIdentityUser")'

# Check metadata server from pod
kubectl exec -n production $POD_NAME -- \
  curl -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/

# Verify token can access GCP API
kubectl exec -n production $POD_NAME -- \
  curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  https://storage.googleapis.com/storage/v1/b/my-bucket
```

### AKS Workload Identity Debugging

```bash
# Check if workload identity webhook is injecting environment variables
kubectl describe pod $POD_NAME -n production | grep -A 5 "Environment:"
# Should show: AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE

# Check pod has the required label
kubectl get pod $POD_NAME -n production -o jsonpath='{.metadata.labels.azure\.workload\.identity/use}'
# Expected: true

# Verify federated credential subject matches
az identity federated-credential list \
  --identity-name "$IDENTITY_NAME" \
  --resource-group "$RESOURCE_GROUP" | \
  jq '.[].subject'
# Expected: "system:serviceaccount:production:storage-reader-sa"

# Test token exchange
TOKEN=$(cat $AZURE_FEDERATED_TOKEN_FILE)
curl -X POST \
  "https://login.microsoftonline.com/$AZURE_TENANT_ID/oauth2/v2.0/token" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "client_id=$AZURE_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$TOKEN" \
  -d "scope=https://storage.azure.com/.default" \
  -d "requested_token_use=on_behalf_of"
```

### Common Failure Patterns

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| AWS: `AccessDenied` at assume role | Trust policy SubCondition mismatch | Verify `sub` claim matches `system:serviceaccount:NAMESPACE:SA_NAME` |
| GCP: 403 on metadata server | Node pool not using GKE_METADATA | Update node pool to `workload-metadata=GKE_METADATA` |
| AKS: Empty environment variables | Missing `azure.workload.identity/use: "true"` label | Add label to pod spec |
| All clouds: Token expired | Short-lived token not renewed | Verify SDK version supports token refresh; check `tokenExpirationSeconds` |
| All clouds: Wrong namespace | SA created in wrong namespace | Trust policy/IAM binding must use exact namespace:serviceaccount pair |

Workload identity eliminates the largest attack surface in cloud-native Kubernetes deployments: static credentials. The 15-minute default token lifetime means a compromised pod credential expires rapidly, and the absence of any stored secret means there is nothing to rotate, nothing to audit for unauthorized access, and nothing to accidentally commit to version control.
