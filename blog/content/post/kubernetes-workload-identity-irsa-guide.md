---
title: "Kubernetes Workload Identity: IRSA, Workload Identity Federation, and Pod Identity for AWS, GCP, and Azure"
date: 2028-07-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "IRSA", "Workload Identity", "AWS", "GCP", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Kubernetes workload identity across AWS IRSA, GCP Workload Identity Federation, and Azure Pod Identity, including setup, troubleshooting, and security hardening."
more_link: "yes"
url: "/kubernetes-workload-identity-irsa-guide/"
---

Workload identity is the mechanism by which Kubernetes pods authenticate to cloud provider APIs without storing long-lived credentials. Whether you are running on AWS, GCP, or Azure, the fundamental goal is identical: bind a Kubernetes service account to a cloud IAM identity so pods receive short-lived tokens scoped to exactly what they need. Getting this right eliminates the class of secret-sprawl incidents that plague teams who rely on static access keys stored in Kubernetes secrets.

This guide covers the full lifecycle of workload identity across all three major clouds, including the OIDC federation mechanics, practical YAML configurations, debugging techniques, and security hardening that turns a basic setup into a production-ready control plane.

<!--more-->

# Kubernetes Workload Identity: IRSA, Workload Identity Federation, and Pod Identity

## Section 1: The Core Problem — Why Static Credentials Are Dangerous

Before diving into configuration, it is worth understanding what workload identity replaces.

The naive approach to giving a pod access to an S3 bucket, a GCS bucket, or an Azure Blob container is to create an IAM user or service account key, store it as a Kubernetes Secret, and mount it into the pod. This approach has several critical failure modes:

- Secrets stored in etcd are base64-encoded, not encrypted by default unless you configure encryption at rest.
- Key rotation requires redeployment or a rolling restart.
- A single leaked KUBECONFIG or `kubectl exec` session exposes the long-lived credential.
- There is no audit trail linking a specific pod execution to a specific API call.
- Over-permission is the norm because teams grant broad access to avoid constant key rotation.

Workload identity eliminates all of these problems by replacing static keys with dynamically issued, short-lived OIDC tokens that carry pod-level metadata. The cloud provider validates the token against the cluster's OIDC endpoint, issues a provider-scoped token with a configurable lifetime, and revokes it automatically when the token expires.

## Section 2: OIDC Fundamentals for Kubernetes

All three cloud providers use the same underlying mechanism: OIDC token exchange. The Kubernetes API server acts as an OIDC identity provider. It issues projected service account tokens that contain claims like:

```json
{
  "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
  "sub": "system:serviceaccount:production:my-app",
  "aud": ["sts.amazonaws.com"],
  "exp": 1735689600,
  "iat": 1735686000,
  "kubernetes.io": {
    "namespace": "production",
    "pod": {
      "name": "my-app-7d9f8b-xk4qp",
      "uid": "abc123"
    },
    "serviceaccount": {
      "name": "my-app",
      "uid": "def456"
    }
  }
}
```

The cloud provider's STS or equivalent validates this token against the cluster's JWKS endpoint, checks that the subject matches the trust policy, and returns a short-lived cloud credential.

### Enabling the OIDC Provider on the Cluster

For self-managed clusters, you need to configure the API server with OIDC settings and publish the JWKS endpoint publicly. Managed clusters (EKS, GKE, AKS) handle this automatically.

For a self-managed cluster with kubeadm:

```yaml
# kubeadm-config.yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
apiServer:
  extraArgs:
    service-account-issuer: "https://k8s.example.com"
    service-account-key-file: "/etc/kubernetes/pki/sa.pub"
    service-account-signing-key-file: "/etc/kubernetes/pki/sa.key"
    api-audiences: "https://k8s.example.com,sts.amazonaws.com"
```

Then publish the OIDC discovery document and JWKS at your issuer URL. You need two files accessible via HTTPS:

```json
// https://k8s.example.com/.well-known/openid-configuration
{
  "issuer": "https://k8s.example.com",
  "jwks_uri": "https://k8s.example.com/openid/v1/jwks",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"]
}
```

```bash
# Extract the JWKS from your cluster
kubectl get --raw /openid/v1/jwks | jq .
```

Upload the JWKS to a public S3 bucket, GCS bucket, or any static HTTPS endpoint.

## Section 3: AWS IRSA (IAM Roles for Service Accounts)

IRSA is the most mature implementation and serves as a reference architecture for the others.

### Step 1: Create the OIDC Provider in AWS

For EKS clusters, this is a two-command operation:

```bash
# Get the OIDC issuer URL
OIDC_URL=$(aws eks describe-cluster \
  --name my-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text)

echo "OIDC URL: ${OIDC_URL}"

# Get the thumbprint
THUMBPRINT=$(openssl s_client -connect \
  $(echo $OIDC_URL | sed 's|https://||' | cut -d/ -f1):443 \
  -showcerts </dev/null 2>/dev/null | \
  openssl x509 -fingerprint -noout | \
  sed 's/SHA1 Fingerprint=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')

# Create the OIDC provider
aws iam create-open-id-connect-provider \
  --url "${OIDC_URL}" \
  --client-id-list "sts.amazonaws.com" \
  --thumbprint-list "${THUMBPRINT}"
```

Or use eksctl which automates this:

```bash
eksctl utils associate-iam-oidc-provider \
  --cluster my-cluster \
  --region us-east-1 \
  --approve
```

### Step 2: Create the IAM Role with a Trust Policy

The trust policy is the critical piece. It restricts which service accounts can assume this role:

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
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:production:my-app",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

The `sub` condition is what scopes the role to a specific namespace and service account. Without it, any service account in your cluster could assume the role.

```bash
# Create the role
aws iam create-role \
  --role-name my-app-production \
  --assume-role-policy-document file://trust-policy.json

# Attach the permissions policy
aws iam attach-role-policy \
  --role-name my-app-production \
  --policy-arn arn:aws:iam::123456789012:policy/MyAppPolicy
```

### Step 3: Annotate the Kubernetes Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/my-app-production"
    # Optional: set token expiration (default 86400 seconds)
    eks.amazonaws.com/token-expiration: "3600"
    # Optional: disable session tags for compatibility
    eks.amazonaws.com/sts-regional-endpoints: "true"
```

### Step 4: Configure the Pod

The pod must use the annotated service account and have the projected token volume mounted. The EKS Pod Identity Webhook handles this automatically if installed:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      serviceAccountName: my-app
      containers:
      - name: app
        image: my-app:latest
        env:
        - name: AWS_DEFAULT_REGION
          value: "us-east-1"
        # AWS SDK reads these automatically when present
        # The webhook injects AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
```

If you are not using the webhook, you can configure the projected token manually:

```yaml
spec:
  serviceAccountName: my-app
  volumes:
  - name: aws-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600
          audience: sts.amazonaws.com
  containers:
  - name: app
    image: my-app:latest
    env:
    - name: AWS_WEB_IDENTITY_TOKEN_FILE
      value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
    - name: AWS_ROLE_ARN
      value: "arn:aws:iam::123456789012:role/my-app-production"
    - name: AWS_DEFAULT_REGION
      value: us-east-1
    volumeMounts:
    - name: aws-token
      mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
      readOnly: true
```

### Using IRSA from Go

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

func main() {
    // AWS SDK v2 automatically reads AWS_WEB_IDENTITY_TOKEN_FILE
    // and AWS_ROLE_ARN environment variables
    cfg, err := config.LoadDefaultConfig(context.Background(),
        config.WithRegion("us-east-1"),
    )
    if err != nil {
        log.Fatalf("failed to load config: %v", err)
    }

    client := s3.NewFromConfig(cfg)

    output, err := client.ListBuckets(context.Background(), &s3.ListBucketsInput{})
    if err != nil {
        log.Fatalf("failed to list buckets: %v", err)
    }

    for _, bucket := range output.Buckets {
        fmt.Printf("Bucket: %s\n", *bucket.Name)
    }
}
```

### EKS Pod Identity (Newer Approach)

AWS introduced EKS Pod Identity in 2023 as an alternative to IRSA that does not require an OIDC provider:

```bash
# Enable the Pod Identity Agent addon
aws eks create-addon \
  --cluster-name my-cluster \
  --addon-name eks-pod-identity-agent \
  --addon-version v1.0.0-eksbuild.1

# Create a Pod Identity association
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace production \
  --service-account my-app \
  --role-arn arn:aws:iam::123456789012:role/my-app-production
```

The Pod Identity agent runs as a DaemonSet and serves credentials via a local IMDS-like endpoint at `169.254.170.23`. No webhook or annotation is required on the service account — only the association matters.

```yaml
# Trust policy for Pod Identity (simpler than IRSA)
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

## Section 4: GCP Workload Identity Federation

GCP's implementation has evolved from Workload Identity (for GKE workloads accessing GCP APIs) to Workload Identity Federation (for external workloads accessing GCP APIs). For GKE clusters, you use Workload Identity.

### Enable Workload Identity on GKE

```bash
# Enable on a new cluster
gcloud container clusters create my-cluster \
  --workload-pool=my-project.svc.id.goog \
  --region us-central1

# Enable on an existing cluster
gcloud container clusters update my-cluster \
  --workload-pool=my-project.svc.id.goog \
  --region us-central1

# Enable on node pools
gcloud container node-pools update default-pool \
  --cluster=my-cluster \
  --workload-metadata=GKE_METADATA \
  --region us-central1
```

### Create the GCP Service Account

```bash
# Create a GCP service account
gcloud iam service-accounts create my-app-gsa \
  --display-name="My App GSA" \
  --project=my-project

# Grant the service account permissions
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:my-app-gsa@my-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

# Allow the Kubernetes service account to impersonate the GCP service account
gcloud iam service-accounts add-iam-policy-binding \
  my-app-gsa@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[production/my-app]"
```

The member format `serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA_NAME]` is the binding between the Kubernetes service account and the GCP service account.

### Annotate the Kubernetes Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app
  namespace: production
  annotations:
    iam.gke.io/gcp-service-account: "my-app-gsa@my-project.iam.gserviceaccount.com"
```

### Pod Configuration for GKE Workload Identity

No special pod configuration is needed for GKE Workload Identity. The GKE metadata server handles token issuance via the instance metadata API at `169.254.169.254`. The GCP SDK will automatically obtain credentials.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: my-app
      containers:
      - name: app
        image: my-app:latest
        # No special environment variables needed
        # Application Default Credentials (ADC) work automatically
```

### Using Workload Identity from Go

```go
package main

import (
    "context"
    "fmt"
    "log"

    "cloud.google.com/go/storage"
    "google.golang.org/api/iterator"
)

func main() {
    ctx := context.Background()

    // storage.NewClient() uses Application Default Credentials automatically
    // On GKE with Workload Identity, ADC fetches tokens from the metadata server
    client, err := storage.NewClient(ctx)
    if err != nil {
        log.Fatalf("failed to create storage client: %v", err)
    }
    defer client.Close()

    it := client.Buckets(ctx, "my-project")
    for {
        bucketAttrs, err := it.Next()
        if err == iterator.Done {
            break
        }
        if err != nil {
            log.Fatalf("error iterating buckets: %v", err)
        }
        fmt.Printf("Bucket: %s\n", bucketAttrs.Name)
    }
}
```

### GCP Workload Identity Federation for Non-GKE Clusters

If you are running on EKS or a self-managed cluster and need to access GCP APIs, use Workload Identity Federation:

```bash
# Create a workload identity pool
gcloud iam workload-identity-pools create my-pool \
  --location="global" \
  --display-name="My Pool"

# Create a provider for your Kubernetes cluster
gcloud iam workload-identity-pools providers create-oidc my-provider \
  --location="global" \
  --workload-identity-pool="my-pool" \
  --display-name="My K8s Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.namespace=assertion['kubernetes.io']['namespace'],attribute.service_account=assertion['kubernetes.io']['serviceaccount']['name']" \
  --issuer-uri="https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"

# Grant access scoped to a specific namespace and service account
gcloud iam service-accounts add-iam-policy-binding \
  my-app-gsa@my-project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/my-pool/attribute.service_account/my-app"
```

Generate the credential configuration file:

```bash
gcloud iam workload-identity-pools create-cred-config \
  projects/123456789/locations/global/workloadIdentityPools/my-pool/providers/my-provider \
  --service-account=my-app-gsa@my-project.iam.gserviceaccount.com \
  --credential-source-file=/var/run/secrets/tokens/gcp-token \
  --credential-source-type=text \
  --output-file=credential-config.json
```

Store this as a ConfigMap and mount it:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gcp-credential-config
  namespace: production
data:
  credential-config.json: |
    {
      "type": "external_account",
      "audience": "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/my-pool/providers/my-provider",
      "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
      "token_url": "https://sts.googleapis.com/v1/token",
      "credential_source": {
        "file": "/var/run/secrets/tokens/gcp-token"
      },
      "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/my-app-gsa@my-project.iam.gserviceaccount.com:generateAccessToken"
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: my-app
      volumes:
      - name: gcp-token
        projected:
          sources:
          - serviceAccountToken:
              path: gcp-token
              expirationSeconds: 3600
              audience: "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/my-pool/providers/my-provider"
      - name: gcp-credential-config
        configMap:
          name: gcp-credential-config
      containers:
      - name: app
        image: my-app:latest
        env:
        - name: GOOGLE_APPLICATION_CREDENTIALS
          value: /var/run/secrets/gcp/credential-config.json
        volumeMounts:
        - name: gcp-token
          mountPath: /var/run/secrets/tokens
          readOnly: true
        - name: gcp-credential-config
          mountPath: /var/run/secrets/gcp
          readOnly: true
```

## Section 5: Azure Workload Identity

Azure went through several iterations: AAD Pod Identity (v1, deprecated), AAD Pod Identity v2, and finally the current Azure Workload Identity using OIDC federation.

### Enable OIDC Issuer and Workload Identity on AKS

```bash
# Enable OIDC issuer and workload identity on new cluster
az aks create \
  --resource-group my-rg \
  --name my-cluster \
  --enable-oidc-issuer \
  --enable-workload-identity \
  --node-count 3

# Enable on existing cluster
az aks update \
  --resource-group my-rg \
  --name my-cluster \
  --enable-oidc-issuer \
  --enable-workload-identity

# Get the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --resource-group my-rg \
  --name my-cluster \
  --query "oidcIssuerProfile.issuerUrl" \
  --output tsv)

echo "OIDC Issuer: ${OIDC_ISSUER}"
```

### Create the Azure Managed Identity and Federated Credential

```bash
# Create a user-assigned managed identity
az identity create \
  --name my-app-identity \
  --resource-group my-rg

# Get the client ID and resource ID
CLIENT_ID=$(az identity show \
  --name my-app-identity \
  --resource-group my-rg \
  --query clientId \
  --output tsv)

# Assign Azure RBAC role to the managed identity
az role assignment create \
  --assignee "${CLIENT_ID}" \
  --role "Storage Blob Data Reader" \
  --scope "/subscriptions/SUBSCRIPTION_ID/resourceGroups/my-rg/providers/Microsoft.Storage/storageAccounts/mystorage"

# Create the federated identity credential
az identity federated-credential create \
  --name my-app-federated-credential \
  --identity-name my-app-identity \
  --resource-group my-rg \
  --issuer "${OIDC_ISSUER}" \
  --subject "system:serviceaccount:production:my-app" \
  --audiences "api://AzureADTokenExchange"
```

### Annotate the Kubernetes Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app
  namespace: production
  annotations:
    azure.workload.identity/client-id: "CLIENT_ID_HERE"
    azure.workload.identity/tenant-id: "TENANT_ID_HERE"  # Optional if same tenant
  labels:
    azure.workload.identity/use: "true"
```

### Pod Configuration for Azure Workload Identity

The Azure Workload Identity mutating admission webhook injects the required environment variables and volume mounts:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    metadata:
      labels:
        app: my-app
        azure.workload.identity/use: "true"  # Required label
    spec:
      serviceAccountName: my-app
      containers:
      - name: app
        image: my-app:latest
        # The webhook injects:
        # AZURE_CLIENT_ID
        # AZURE_TENANT_ID
        # AZURE_FEDERATED_TOKEN_FILE
        # AZURE_AUTHORITY_HOST
```

### Using Azure Workload Identity from Go

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
    "github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
)

func main() {
    // WorkloadIdentityCredential reads AZURE_CLIENT_ID, AZURE_TENANT_ID,
    // and AZURE_FEDERATED_TOKEN_FILE automatically
    cred, err := azidentity.NewWorkloadIdentityCredential(nil)
    if err != nil {
        log.Fatalf("failed to create credential: %v", err)
    }

    client, err := azblob.NewClient(
        "https://mystorage.blob.core.windows.net",
        cred,
        nil,
    )
    if err != nil {
        log.Fatalf("failed to create blob client: %v", err)
    }

    ctx := context.Background()
    pager := client.NewListContainersPager(nil)
    for pager.More() {
        page, err := pager.NextPage(ctx)
        if err != nil {
            log.Fatalf("error listing containers: %v", err)
        }
        for _, container := range page.ContainerItems {
            fmt.Printf("Container: %s\n", *container.Name)
        }
    }
}
```

## Section 6: Terraform Automation for Workload Identity

Managing workload identity bindings manually at scale is error-prone. Terraform modules encapsulate the pattern:

### AWS IRSA Terraform Module

```hcl
# modules/irsa/main.tf
variable "cluster_name" {}
variable "namespace" {}
variable "service_account_name" {}
variable "role_name" {}
variable "policy_arns" { type = list(string) }

data "aws_eks_cluster" "cluster" {
  name = var.cluster_name
}

data "aws_iam_openid_connect_provider" "cluster" {
  url = data.aws_eks_cluster.cluster.identity[0].oidc[0].issuer
}

locals {
  oidc_provider_arn = data.aws_iam_openid_connect_provider.cluster.arn
  oidc_host         = replace(data.aws_eks_cluster.cluster.identity[0].oidc[0].issuer, "https://", "")
}

data "aws_iam_policy_document" "trust" {
  statement {
    effect = "Allow"
    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }
    actions = ["sts:AssumeRoleWithWebIdentity"]
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account_name}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = var.role_name
  assume_role_policy = data.aws_iam_policy_document.trust.json

  tags = {
    ManagedBy        = "terraform"
    KubernetesNS     = var.namespace
    KubernetesKSA    = var.service_account_name
  }
}

resource "aws_iam_role_policy_attachment" "this" {
  for_each   = toset(var.policy_arns)
  role       = aws_iam_role.this.name
  policy_arn = each.value
}

output "role_arn" { value = aws_iam_role.this.arn }

# modules/irsa/kubernetes.tf
resource "kubernetes_service_account" "this" {
  metadata {
    name      = var.service_account_name
    namespace = var.namespace
    annotations = {
      "eks.amazonaws.com/role-arn" = aws_iam_role.this.arn
    }
  }
  depends_on = [aws_iam_role_policy_attachment.this]
}
```

Usage:

```hcl
module "my_app_irsa" {
  source = "./modules/irsa"

  cluster_name         = "my-cluster"
  namespace            = "production"
  service_account_name = "my-app"
  role_name            = "my-app-production"
  policy_arns          = [
    "arn:aws:iam::123456789012:policy/MyAppS3Policy",
    "arn:aws:iam::aws:policy/AmazonSQSReadOnlyAccess",
  ]
}
```

## Section 7: Debugging Workload Identity Issues

### AWS IRSA Debugging

```bash
# Check if the OIDC provider exists
aws iam list-open-id-connect-providers

# Verify the service account annotation
kubectl get serviceaccount my-app -n production \
  -o jsonpath='{.metadata.annotations}'

# Check the projected token
kubectl exec -it my-app-pod -n production -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token | \
  cut -d. -f2 | base64 -d 2>/dev/null | jq .

# Test assuming the role manually
TOKEN=$(kubectl exec -it my-app-pod -n production -- \
  cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token)

aws sts assume-role-with-web-identity \
  --role-arn arn:aws:iam::123456789012:role/my-app-production \
  --role-session-name test \
  --web-identity-token "${TOKEN}"

# Check the current identity from inside the pod
kubectl exec -it my-app-pod -n production -- \
  aws sts get-caller-identity
```

Common errors and solutions:

```bash
# Error: WebIdentityErr: failed to retrieve credentials
# Cause: OIDC provider not associated or thumbprint mismatch
# Fix: Re-create the OIDC provider

# Error: InvalidIdentityToken: Couldn't retrieve verification key from your identity provider
# Cause: JWKS endpoint not accessible or cached incorrectly
# Fix: Wait 5 minutes for propagation or create a new OIDC provider

# Error: AccessDenied: Not authorized to perform: sts:AssumeRoleWithWebIdentity
# Cause: Trust policy sub condition does not match
# Fix: Verify namespace and service account name in trust policy
aws iam get-role --role-name my-app-production \
  --query 'Role.AssumeRolePolicyDocument'
```

### GCP Workload Identity Debugging

```bash
# Verify the node pool has GKE_METADATA enabled
gcloud container node-pools describe default-pool \
  --cluster=my-cluster \
  --region=us-central1 \
  --format="value(config.workloadMetadataConfig.mode)"

# Check the IAM binding
gcloud iam service-accounts get-iam-policy \
  my-app-gsa@my-project.iam.gserviceaccount.com

# Test from inside the pod
kubectl exec -it my-app-pod -n production -- \
  curl -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email

# Verify the active account
kubectl exec -it my-app-pod -n production -- \
  curl -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/
```

### Azure Workload Identity Debugging

```bash
# Check the webhook is installed
kubectl get mutatingwebhookconfiguration | grep azure-wi-webhook

# Verify the federated credential
az identity federated-credential list \
  --identity-name my-app-identity \
  --resource-group my-rg

# Check injected environment variables
kubectl exec -it my-app-pod -n production -- env | grep AZURE

# Validate token exchange manually
TOKEN=$(kubectl exec -it my-app-pod -n production -- \
  cat $AZURE_FEDERATED_TOKEN_FILE)

curl -X POST "https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  -d "client_id=${AZURE_CLIENT_ID}" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=${TOKEN}" \
  -d "scope=https://storage.azure.com/.default" \
  -d "requested_token_use=on_behalf_of"
```

## Section 8: Security Hardening

### Principle of Least Privilege

Always scope trust policies to the most specific subject possible. Use namespace and service account conditions together:

```json
{
  "Condition": {
    "StringEquals": {
      "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE:sub": [
        "system:serviceaccount:production:my-app",
        "system:serviceaccount:production:my-app-worker"
      ],
      "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE:aud": "sts.amazonaws.com"
    }
  }
}
```

Never use wildcards in the sub condition. An over-permissive condition like `system:serviceaccount:production:*` allows any pod in the namespace to assume the role.

### Token Expiration

Set short token expiration times. The default is 24 hours for most implementations; 1 hour is more appropriate for production workloads:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  annotations:
    eks.amazonaws.com/token-expiration: "3600"
```

### Network Controls

Limit egress to STS and cloud provider endpoints only. Using network policies:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: my-app-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: my-app
  policyTypes:
  - Egress
  egress:
  - ports:
    - port: 443
      protocol: TCP
    to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 169.254.169.254/32  # Block IMDS except via workload identity path
```

### Audit Logging

Enable CloudTrail (AWS), Cloud Audit Logs (GCP), or Azure Activity Logs to track AssumeRole calls:

```bash
# AWS: Query CloudTrail for AssumeRoleWithWebIdentity calls
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --start-time "2024-01-01T00:00:00Z" \
  --query 'Events[].{Time:EventTime,User:Username,Role:Resources[0].ResourceName}'
```

### Namespace Isolation

Enforce strict namespace boundaries using OPA Gatekeeper or Kyverno to prevent service accounts from being created with cross-namespace trust assumptions:

```yaml
# Kyverno policy to require IRSA annotations only reference approved roles
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-irsa-roles
spec:
  validationFailureAction: Enforce
  rules:
  - name: validate-role-arn
    match:
      any:
      - resources:
          kinds:
          - ServiceAccount
    validate:
      message: "IRSA role ARN must match pattern arn:aws:iam::123456789012:role/{{request.namespace}}-*"
      pattern:
        metadata:
          annotations:
            eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/{{request.namespace}}-*"
```

## Section 9: Multi-Cloud Workload Identity

Some teams need pods to access APIs on multiple cloud providers simultaneously. The pattern combines multiple projected token volumes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: multi-cloud-app
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: multi-cloud-app
      volumes:
      - name: aws-token
        projected:
          sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: sts.amazonaws.com
      - name: gcp-token
        projected:
          sources:
          - serviceAccountToken:
              path: gcp-token
              expirationSeconds: 3600
              audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/my-pool/providers/my-provider"
      containers:
      - name: app
        image: multi-cloud-app:latest
        env:
        - name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: /var/run/secrets/aws/token
        - name: AWS_ROLE_ARN
          value: "arn:aws:iam::123456789012:role/multi-cloud-app"
        - name: GOOGLE_APPLICATION_CREDENTIALS
          value: /var/run/secrets/gcp-config/credential-config.json
        volumeMounts:
        - name: aws-token
          mountPath: /var/run/secrets/aws
          readOnly: true
        - name: gcp-token
          mountPath: /var/run/secrets/gcp-token
          readOnly: true
```

## Section 10: Monitoring Workload Identity Health

A key operational gap is detecting when workload identity breaks silently. This often happens after certificate rotation or OIDC thumbprint changes.

```go
// pkg/health/workload_identity.go
package health

import (
    "context"
    "fmt"
    "os"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/sts"
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    workloadIdentityStatus = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "workload_identity_status",
        Help: "1 if workload identity is functional, 0 if broken",
    })
    workloadIdentityLastSuccess = promauto.NewGauge(prometheus.GaugeOpts{
        Name: "workload_identity_last_success_timestamp",
        Help: "Unix timestamp of last successful credential refresh",
    })
)

func CheckAWSIdentity(ctx context.Context) error {
    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        workloadIdentityStatus.Set(0)
        return fmt.Errorf("loading AWS config: %w", err)
    }

    client := sts.NewFromConfig(cfg)
    _, err = client.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
    if err != nil {
        workloadIdentityStatus.Set(0)
        return fmt.Errorf("getting caller identity: %w", err)
    }

    workloadIdentityStatus.Set(1)
    workloadIdentityLastSuccess.SetToCurrentTime()
    return nil
}

func StartIdentityProbe(ctx context.Context, interval time.Duration) {
    go func() {
        ticker := time.NewTicker(interval)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                if err := CheckAWSIdentity(ctx); err != nil {
                    fmt.Fprintf(os.Stderr, "workload identity check failed: %v\n", err)
                }
            }
        }
    }()
}
```

Set up an alert:

```yaml
# Prometheus alert rule
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
    - alert: WorkloadIdentityBroken
      expr: workload_identity_status == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Workload identity is not functioning"
        description: "Pod {{ $labels.pod }} in namespace {{ $labels.namespace }} cannot obtain cloud credentials"

    - alert: WorkloadIdentityStale
      expr: time() - workload_identity_last_success_timestamp > 3600
      for: 15m
      labels:
        severity: warning
      annotations:
        summary: "Workload identity credentials not refreshed recently"
```

## Conclusion

Workload identity is one of the highest-leverage security improvements available to Kubernetes operators. A single afternoon of configuration eliminates the need for static credentials across your entire platform. The patterns across AWS, GCP, and Azure are structurally identical — OIDC federation, subject binding, and short-lived tokens — which means knowledge transfers across clouds.

The critical operational details are in the trust policy scoping (always namespace-and-name, never wildcard), token expiration settings (1 hour for production), and ongoing health monitoring. Teams that invest in Terraform modules for workload identity setup find that new service integrations take minutes rather than hours, with full auditability built in from the start.
