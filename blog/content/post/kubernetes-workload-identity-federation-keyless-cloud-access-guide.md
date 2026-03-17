---
title: "Kubernetes Workload Identity Federation: Keyless Cloud Access for Pods"
date: 2031-06-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "AWS", "GCP", "Azure", "IRSA", "Workload Identity", "OIDC", "Security"]
categories:
- Kubernetes
- Security
- Cloud Native
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes workload identity federation covering AWS IRSA, GKE Workload Identity, Azure Workload Identity, OIDC token projection, cross-cloud federation, and zero-secret access to cloud services from Kubernetes pods."
more_link: "yes"
url: "/kubernetes-workload-identity-federation-keyless-cloud-access-guide/"
---

Storing cloud credentials in Kubernetes Secrets is a significant security risk: secrets can be exfiltrated from etcd, leaked through environment variables, or exposed in container logs. Workload identity federation eliminates this risk by replacing static credentials with short-lived tokens issued by the Kubernetes API server itself. Each cloud provider has its own implementation, but all share the same foundation: OIDC (OpenID Connect) token projection and federation. This guide covers every major implementation and the cross-cloud patterns that enable a single Kubernetes cluster to access resources in multiple cloud providers simultaneously.

<!--more-->

# Kubernetes Workload Identity Federation: Keyless Cloud Access for Pods

## Section 1: The Problem with Static Credentials

The traditional approach to giving Kubernetes workloads access to cloud services involves storing credentials in Secrets:

```yaml
# The old way - do NOT do this
apiVersion: v1
kind: Secret
metadata:
  name: aws-credentials
type: Opaque
stringData:
  AWS_ACCESS_KEY_ID: "<aws-access-key-id>"
  AWS_SECRET_ACCESS_KEY: "<aws-secret-access-key>"
```

This approach has multiple problems:
- Credentials don't expire automatically
- Any pod with access to the secret can impersonate the service account
- Credentials must be rotated manually across all clusters
- etcd compromise exposes all credentials
- The principle of least privilege is hard to enforce consistently

Workload identity federation solves all of these by using the Kubernetes OIDC token as proof of identity.

## Section 2: OIDC Token Projection Foundation

Every Kubernetes cluster can act as an OIDC identity provider. When enabled, the API server issues short-lived JWT tokens to service accounts. These tokens are projected into pods via volume mounts.

### Enabling OIDC on a Cluster

```bash
# For self-managed clusters, kube-apiserver needs these flags:
# --service-account-issuer=https://<issuer-url>
# --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
# --api-audiences=<audience1,audience2>

# For EKS, this is configured automatically
# For GKE, this is configured automatically
# For AKS, this is configured automatically

# Check your cluster's OIDC issuer URL
kubectl get --raw /.well-known/openid-configuration | python3 -m json.tool | grep issuer

# For EKS clusters
aws eks describe-cluster --name my-cluster \
    --query "cluster.identity.oidc.issuer" --output text
# https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE1234567890ABCDEFGHIJKLMNOP
```

### How Token Projection Works

```yaml
# Kubernetes projects OIDC tokens into pods via ServiceAccountToken volumes
# This happens automatically when using the projected service account token mechanism

apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      serviceAccountName: my-service-account
      containers:
        - name: app
          image: myapp:1.0
          env:
            - name: AWS_WEB_IDENTITY_TOKEN_FILE
              value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
          volumeMounts:
            - name: aws-token
              mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
      volumes:
        - name: aws-token
          projected:
            sources:
              - serviceAccountToken:
                  # Token issued for the AWS STS audience
                  audience: sts.amazonaws.com
                  expirationSeconds: 86400
                  path: token
```

The projected token is a JWT signed by the Kubernetes API server's private key. When presented to a cloud provider's STS (Security Token Service), the provider fetches the cluster's OIDC public keys to verify the signature and issues a short-lived cloud credential.

## Section 3: AWS IRSA (IAM Roles for Service Accounts)

IRSA is the AWS implementation of workload identity federation for EKS clusters.

### Setting Up the OIDC Provider

```bash
# Get the cluster's OIDC issuer URL
OIDC_URL=$(aws eks describe-cluster \
    --name production-cluster \
    --query "cluster.identity.oidc.issuer" \
    --output text | sed 's|https://||')

# Create the OIDC identity provider in IAM
# First, get the certificate thumbprint
THUMBPRINT=$(openssl s_client \
    -connect oidc.eks.us-east-1.amazonaws.com:443 \
    -servername oidc.eks.us-east-1.amazonaws.com \
    2>/dev/null | openssl x509 -fingerprint -noout -sha1 \
    | sed 's/SHA1 Fingerprint=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')

# Create the OIDC provider
aws iam create-oidc-provider \
    --url "https://$OIDC_URL" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list "$THUMBPRINT"

# Or use eksctl (simpler):
eksctl utils associate-iam-oidc-provider \
    --cluster production-cluster \
    --approve
```

### Creating an IAM Role for a Service Account

```bash
# Define the trust policy
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OIDC_PROVIDER=$OIDC_URL

cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:my-app:my-service-account",
          "${OIDC_PROVIDER}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

# Create the role
aws iam create-role \
    --role-name my-app-s3-reader \
    --assume-role-policy-document file://trust-policy.json

# Attach the permissions policy
aws iam attach-role-policy \
    --role-name my-app-s3-reader \
    --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Get the role ARN
aws iam get-role --role-name my-app-s3-reader \
    --query "Role.Arn" --output text
# arn:aws:iam::123456789012:role/my-app-s3-reader
```

### Annotating the Service Account

```yaml
# service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: my-app
  annotations:
    # This annotation links the K8s service account to the IAM role
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/my-app-s3-reader
    # Optional: set token expiry (default 24 hours, min 1 hour)
    eks.amazonaws.com/token-expiration: "86400"
```

```bash
kubectl apply -f service-account.yaml

# The EKS Pod Identity Webhook (installed automatically) intercepts pod creation
# and adds the OIDC token volume and environment variables automatically
```

### Using IRSA in Applications

```go
// Go application using IRSA - no credentials needed in code
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

func main() {
    ctx := context.Background()

    // The SDK automatically uses the projected OIDC token via WebIdentityRoleProvider
    // Environment variables set by the webhook:
    // AWS_ROLE_ARN=arn:aws:iam::123456789012:role/my-app-s3-reader
    // AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/serviceaccount/token
    // AWS_REGION=us-east-1

    cfg, err := config.LoadDefaultConfig(ctx)
    if err != nil {
        log.Fatalf("failed to load AWS config: %v", err)
    }

    client := s3.NewFromConfig(cfg)

    // List buckets - works without any credentials in the code
    result, err := client.ListBuckets(ctx, &s3.ListBucketsInput{})
    if err != nil {
        log.Fatalf("failed to list buckets: %v", err)
    }

    for _, bucket := range result.Buckets {
        fmt.Printf("Bucket: %s\n", *bucket.Name)
    }
}
```

### Using eksctl for IRSA Setup

```bash
# eksctl simplifies the entire IRSA setup

# Create service account with IAM role in one command
eksctl create iamserviceaccount \
    --cluster production-cluster \
    --namespace my-app \
    --name my-service-account \
    --attach-policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
    --approve

# For custom inline policies
eksctl create iamserviceaccount \
    --cluster production-cluster \
    --namespace my-app \
    --name database-accessor \
    --attach-policy-arn arn:aws:iam::123456789012:policy/MyCustomPolicy \
    --approve
```

## Section 4: GKE Workload Identity

Google Kubernetes Engine's Workload Identity maps Kubernetes service accounts to Google Service Accounts (GSAs):

### Enabling Workload Identity on GKE

```bash
# Enable Workload Identity on a new cluster
gcloud container clusters create production-cluster \
    --workload-pool=PROJECT_ID.svc.id.goog \
    --region us-central1

# Enable on an existing cluster
gcloud container clusters update production-cluster \
    --workload-pool=PROJECT_ID.svc.id.goog \
    --region us-central1

# Enable on node pools (required if updating existing cluster)
gcloud container node-pools update default-pool \
    --cluster production-cluster \
    --region us-central1 \
    --workload-metadata=GKE_METADATA
```

### Binding Kubernetes SA to Google SA

```bash
PROJECT_ID=$(gcloud config get-value project)
KSA_NAME="my-service-account"
KSA_NAMESPACE="my-app"
GSA_NAME="my-app-service-account"

# Create the Google Service Account
gcloud iam service-accounts create $GSA_NAME \
    --display-name="My App Service Account"

# Grant permissions to the GSA
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$GSA_NAME@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.objectViewer"

# Allow the KSA to impersonate the GSA
gcloud iam service-accounts add-iam-policy-binding \
    $GSA_NAME@$PROJECT_ID.iam.gserviceaccount.com \
    --role roles/iam.workloadIdentityUser \
    --member "serviceAccount:$PROJECT_ID.svc.id.goog[$KSA_NAMESPACE/$KSA_NAME]"
```

### Annotating the Kubernetes Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: my-app
  annotations:
    iam.gke.io/gcp-service-account: my-app-service-account@PROJECT_ID.iam.gserviceaccount.com
```

### Using Workload Identity in Python

```python
# Python application using GKE Workload Identity
# No credentials file needed - Application Default Credentials (ADC) automatically
# uses the workload identity token

from google.cloud import storage
import google.auth

def list_gcs_buckets():
    # ADC automatically uses workload identity when running on GKE
    credentials, project = google.auth.default()

    client = storage.Client(credentials=credentials, project=project)
    buckets = list(client.list_buckets())

    for bucket in buckets:
        print(f"Bucket: {bucket.name}")

if __name__ == "__main__":
    list_gcs_buckets()
```

### Verifying Workload Identity

```bash
# Deploy a test pod to verify identity
kubectl run workload-identity-test \
    --image=google/cloud-sdk:slim \
    --serviceaccount=my-service-account \
    --namespace=my-app \
    -it --rm -- /bin/bash

# Inside the pod:
curl -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
# Expected output: my-app-service-account@PROJECT_ID.iam.gserviceaccount.com

gcloud auth list
# Should show the GSA as the active identity
```

## Section 5: Azure Workload Identity

Azure Workload Identity (AKS Managed Identity or Azure AD Workload Identity) federates Kubernetes service accounts with Azure Managed Identities or App Registrations.

### Setting Up AKS with OIDC and Workload Identity

```bash
# Enable OIDC issuer and Workload Identity on AKS
az aks update \
    --resource-group my-resource-group \
    --name production-cluster \
    --enable-oidc-issuer \
    --enable-workload-identity

# Get the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
    --resource-group my-resource-group \
    --name production-cluster \
    --query "oidcIssuerProfile.issuerUrl" \
    --output tsv)

echo "OIDC Issuer: $OIDC_ISSUER"
```

### Creating a Managed Identity and Federated Credential

```bash
# Create a User-Assigned Managed Identity
az identity create \
    --name my-app-identity \
    --resource-group my-resource-group

MANAGED_IDENTITY_CLIENT_ID=$(az identity show \
    --name my-app-identity \
    --resource-group my-resource-group \
    --query "clientId" --output tsv)

MANAGED_IDENTITY_PRINCIPAL_ID=$(az identity show \
    --name my-app-identity \
    --resource-group my-resource-group \
    --query "principalId" --output tsv)

# Grant permissions to the managed identity
STORAGE_ACCOUNT_ID=$(az storage account show \
    --name mystorageaccount \
    --resource-group my-resource-group \
    --query "id" --output tsv)

az role assignment create \
    --assignee-object-id $MANAGED_IDENTITY_PRINCIPAL_ID \
    --role "Storage Blob Data Reader" \
    --scope $STORAGE_ACCOUNT_ID

# Create a federated credential linking KSA -> Managed Identity
az identity federated-credential create \
    --name my-app-federated-credential \
    --identity-name my-app-identity \
    --resource-group my-resource-group \
    --issuer $OIDC_ISSUER \
    --subject "system:serviceaccount:my-app:my-service-account" \
    --audiences api://AzureADTokenExchange
```

### Kubernetes Resources for Azure Workload Identity

```yaml
# service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: my-app
  annotations:
    azure.workload.identity/client-id: "<managed-identity-client-id>"
  labels:
    azure.workload.identity/use: "true"

---
# pod.yaml - The Azure Workload Identity Webhook automatically injects
# the OIDC token and environment variables when these labels are present
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-app
spec:
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: my-service-account
      containers:
        - name: app
          image: myapp:1.0
          # The webhook injects:
          # AZURE_CLIENT_ID - Managed Identity client ID
          # AZURE_TENANT_ID - Azure tenant ID
          # AZURE_FEDERATED_TOKEN_FILE - Path to projected OIDC token
          # AZURE_AUTHORITY_HOST - Azure AD endpoint
```

### Using Azure Identity SDK

```go
// Go application using Azure Workload Identity
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
    "github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
)

func main() {
    ctx := context.Background()

    // WorkloadIdentityCredential reads from:
    // AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
    // These are injected by the Azure Workload Identity webhook
    credential, err := azidentity.NewWorkloadIdentityCredential(nil)
    if err != nil {
        log.Fatalf("failed to create credential: %v", err)
    }

    client, err := azblob.NewClient(
        "https://mystorageaccount.blob.core.windows.net",
        credential,
        nil,
    )
    if err != nil {
        log.Fatalf("failed to create blob client: %v", err)
    }

    // List containers - no credentials in code
    pager := client.NewListContainersPager(nil)
    for pager.More() {
        resp, err := pager.NextPage(ctx)
        if err != nil {
            log.Fatalf("failed to list containers: %v", err)
        }
        for _, container := range resp.ContainerItems {
            fmt.Printf("Container: %s\n", *container.Name)
        }
    }
}
```

## Section 6: Cross-Cloud Identity Federation

A single Kubernetes cluster can access resources in multiple cloud providers simultaneously. This is increasingly common for multi-cloud architectures.

### Multi-Cloud Service Account Configuration

```yaml
# Service account annotated for multiple cloud providers
# This requires custom handling since annotations are provider-specific

# Option 1: Separate service accounts per cloud
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-aws-access
  namespace: my-app
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/my-app-aws-role
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-gcp-access
  namespace: my-app
  annotations:
    iam.gke.io/gcp-service-account: my-app@PROJECT_ID.iam.gserviceaccount.com
```

### Using External Secrets Operator for Cross-Cloud Secrets

```yaml
# ExternalSecret pulling from both AWS and GCP
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: multi-cloud-config
  namespace: my-app
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: app-config
  data:
    - secretKey: database-url
      remoteRef:
        key: prod/my-app/database-url
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: gcp-config
  namespace: my-app
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: gcp-secret-manager
    kind: ClusterSecretStore
  target:
    name: gcp-config
  data:
    - secretKey: api-key
      remoteRef:
        key: my-app-api-key
        version: latest
```

### Federated Identity Without a Cloud Provider

For self-managed clusters and on-premises environments, HashiCorp Vault supports Kubernetes JWT authentication:

```hcl
# vault policy
path "secret/data/my-app/*" {
  capabilities = ["read"]
}
```

```bash
# Configure Vault Kubernetes auth method
vault auth enable kubernetes

vault write auth/kubernetes/config \
    kubernetes_host="https://kubernetes.default.svc" \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    issuer="https://kubernetes.default.svc.cluster.local"

# Create a role binding KSA to Vault policy
vault write auth/kubernetes/role/my-app-reader \
    bound_service_account_names=my-service-account \
    bound_service_account_namespaces=my-app \
    policies=my-app-read \
    ttl=1h
```

```go
// Go application authenticating to Vault using Kubernetes JWT
package main

import (
    "os"

    vault "github.com/hashicorp/vault/api"
    auth "github.com/hashicorp/vault/api/auth/kubernetes"
)

func getVaultClient() (*vault.Client, error) {
    config := vault.DefaultConfig()
    config.Address = os.Getenv("VAULT_ADDR")

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, err
    }

    // Use the Kubernetes service account JWT
    k8sAuth, err := auth.NewKubernetesAuth(
        "my-app-reader",  // Vault role name
        auth.WithServiceAccountTokenPath(
            "/var/run/secrets/kubernetes.io/serviceaccount/token",
        ),
    )
    if err != nil {
        return nil, err
    }

    authInfo, err := client.Auth().Login(context.Background(), k8sAuth)
    if err != nil {
        return nil, err
    }
    if authInfo == nil {
        return nil, fmt.Errorf("no auth info returned from Vault")
    }

    return client, nil
}
```

## Section 7: Token Projection Configuration

Fine-grained control over projected tokens enables multi-audience scenarios:

```yaml
# Pod with multiple projected tokens for different cloud providers
apiVersion: v1
kind: Pod
metadata:
  name: multi-cloud-app
spec:
  serviceAccountName: my-service-account
  containers:
    - name: app
      image: myapp:1.0
      volumeMounts:
        - name: aws-token
          mountPath: /var/run/secrets/aws
        - name: vault-token
          mountPath: /var/run/secrets/vault
      env:
        - name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: /var/run/secrets/aws/token
        - name: AWS_ROLE_ARN
          value: arn:aws:iam::123456789012:role/my-app-role
        - name: VAULT_K8S_TOKEN_PATH
          value: /var/run/secrets/vault/token
  volumes:
    - name: aws-token
      projected:
        sources:
          - serviceAccountToken:
              audience: sts.amazonaws.com
              expirationSeconds: 3600
              path: token
    - name: vault-token
      projected:
        sources:
          - serviceAccountToken:
              audience: vault
              expirationSeconds: 3600
              path: token
```

## Section 8: Policy as Code for Workload Identity

OPA/Gatekeeper can enforce workload identity requirements across the cluster:

```yaml
# Require all pods in production to use workload identity
# (no static credential secrets)
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoStaticCredentials
metadata:
  name: no-aws-static-credentials
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces: ["production"]
```

```rego
# rego policy: no-static-credentials.rego
package kubernetes.admission

deny[msg] {
    input.request.kind.kind == "Deployment"
    container := input.request.object.spec.template.spec.containers[_]
    env := container.env[_]
    env.name == "AWS_SECRET_ACCESS_KEY"
    msg := sprintf(
        "Container '%v' uses static AWS credentials. Use IRSA instead.",
        [container.name]
    )
}

deny[msg] {
    input.request.kind.kind == "Deployment"
    volume := input.request.object.spec.template.spec.volumes[_]
    volume.secret.secretName == "aws-credentials"
    msg := "Deployment uses static AWS credential secret. Use IRSA instead."
}
```

## Section 9: Auditing Workload Identity

```bash
# Audit IRSA token exchanges in AWS CloudTrail
aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
    --start-time 2024-01-01 \
    --end-time 2024-01-02 \
    --query "Events[*].{Time:EventTime,User:Username,Role:CloudTrailEvent}" \
    --output table

# Check which roles are being assumed from the cluster
aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
    --query 'Events[*].CloudTrailEvent' \
    --output text | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        event = json.loads(line)
        req = event.get('requestParameters', {})
        print(f\"{event['eventTime']}: {req.get('roleArn', 'unknown')} by {req.get('roleSessionName', 'unknown')}\")
    except:
        pass
"
```

### Kubernetes Audit Logs for Token Projection

```yaml
# audit-policy.yaml - Log service account token creation
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Request
    resources:
      - group: ""
        resources: ["serviceaccounts/token"]
    verbs: ["create"]
```

## Section 10: Troubleshooting Workload Identity

### IRSA Troubleshooting

```bash
# Verify the pod is receiving IRSA environment variables
kubectl exec -n my-app <pod-name> -- env | grep AWS
# Should show: AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE

# Verify the token is being projected
kubectl exec -n my-app <pod-name> -- \
    ls /var/run/secrets/eks.amazonaws.com/serviceaccount/
# Should show: token

# Decode and inspect the token
kubectl exec -n my-app <pod-name> -- \
    cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token | \
    cut -d'.' -f2 | base64 -d 2>/dev/null | python3 -m json.tool
# Should show: sub, aud, exp, iss fields

# Test credential resolution manually
kubectl exec -n my-app <pod-name> -- \
    aws sts get-caller-identity
# Should show the assumed IAM role ARN, not the base node role

# Common error: OIDC provider not created
aws iam list-open-id-connect-providers
# If missing, re-run: eksctl utils associate-iam-oidc-provider

# Common error: trust policy mismatch
# Check that the sub claim matches: system:serviceaccount:<namespace>:<sa-name>
# Check that the aud claim matches: sts.amazonaws.com
```

### GKE Workload Identity Troubleshooting

```bash
# Check if workload identity is active on node pool
kubectl describe node <node-name> | grep workload

# Verify metadata server is accessible
kubectl exec -n my-app <pod-name> -- \
    curl -s "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/" \
    -H "Metadata-Flavor: Google"

# Check GSA permissions
gcloud projects get-iam-policy $PROJECT_ID \
    --flatten="bindings[].members" \
    --filter="bindings.members:my-app-service-account@$PROJECT_ID.iam.gserviceaccount.com" \
    --format="table(bindings.role)"

# Verify KSA-to-GSA binding
gcloud iam service-accounts get-iam-policy \
    my-app-service-account@$PROJECT_ID.iam.gserviceaccount.com \
    --format="json" | python3 -m json.tool | grep serviceAccount
```

## Conclusion

Workload identity federation is the correct approach to cloud authentication from Kubernetes workloads. The elimination of static credentials removes an entire class of security vulnerability: long-lived credentials that can be exfiltrated and abused. Each major cloud provider has implemented this pattern — AWS IRSA, GKE Workload Identity, Azure Workload Identity — using the same OIDC foundation but with provider-specific tooling. For multi-cloud scenarios, separate service accounts per cloud provider with appropriate annotations is the cleanest architectural pattern. HashiCorp Vault's Kubernetes auth provides the same capability for on-premises and private cloud environments. Enforcing workload identity requirements with OPA/Gatekeeper policies ensures that static credentials cannot be introduced through misconfiguration or developer shortcuts.
