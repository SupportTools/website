---
title: "Kubernetes Workload Identity: IRSA, Workload Identity Federation, and Pod Identity"
date: 2029-12-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Workload Identity", "IRSA", "GKE", "AWS", "Azure", "OIDC", "Security", "IAM", "Token Projection"]
categories:
- Kubernetes
- Security
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering AWS IRSA, GKE Workload Identity, Azure Workload Identity, OIDC federation patterns, projected service account token volumes, and multi-cloud workload identity architecture."
more_link: "yes"
url: "/kubernetes-workload-identity-irsa-workload-identity-federation-pod-identity/"
---

Static cloud credentials stored in Kubernetes Secrets are an operational and security liability: they expire, they leak through etcd backups, and rotating them requires coordinated changes across applications and infrastructure. Workload identity eliminates static credentials entirely by having the Kubernetes API server act as an OIDC identity provider. Each pod receives a short-lived, cryptographically signed JWT that AWS, GCP, and Azure can exchange for native cloud credentials — no secrets to rotate, no credentials to leak. This guide covers all three major cloud provider implementations plus the underlying OIDC federation mechanics.

<!--more-->

## The OIDC Token Projection Foundation

Every Kubernetes Workload Identity scheme builds on the same foundation: the `ServiceAccountTokenVolumeProjection` feature, which injects a pod-specific, audience-scoped JWT into a volume mount. This token is signed by the Kubernetes API server's private key and contains claims identifying the pod's namespace, service account name, and a unique identifier.

```yaml
# Manual token projection (cloud providers do this automatically)
apiVersion: v1
kind: Pod
metadata:
  name: token-demo
spec:
  serviceAccountName: my-sa
  volumes:
    - name: token
      projected:
        sources:
          - serviceAccountToken:
              audience: "https://sts.amazonaws.com"
              expirationSeconds: 3600
              path: token
  containers:
    - name: app
      image: ubuntu:22.04
      volumeMounts:
        - name: token
          mountPath: /var/run/secrets/tokens
          readOnly: true
      command: ["sh", "-c", "cat /var/run/secrets/tokens/token | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool; sleep 3600"]
```

Decode the token to see its claims:

```bash
kubectl exec token-demo -- \
  cat /var/run/secrets/tokens/token | \
  cut -d. -f2 | \
  base64 --decode 2>/dev/null | \
  python3 -m json.tool

# Output (abbreviated):
# {
#   "aud": ["https://sts.amazonaws.com"],
#   "exp": 1735084800,
#   "iat": 1735081200,
#   "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
#   "kubernetes.io": {
#     "namespace": "payment-service",
#     "pod": { "name": "payment-service-7d5f9b-xvk2p", "uid": "..." },
#     "serviceaccount": { "name": "payment-service", "uid": "..." }
#   },
#   "sub": "system:serviceaccount:payment-service:payment-service"
# }
```

## AWS: IAM Roles for Service Accounts (IRSA)

### How IRSA Works

1. EKS configures the API server to act as an OIDC provider with a public JWKS endpoint
2. AWS IAM is configured to trust this OIDC provider
3. The pod receives a projected token with audience `https://sts.amazonaws.com`
4. The AWS SDK automatically exchanges this token for temporary IAM credentials via `AssumeRoleWithWebIdentity`

### Enable OIDC on EKS

```bash
# Get the cluster's OIDC issuer URL
aws eks describe-cluster \
  --name my-eks-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text
# Output: https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE

# Associate OIDC provider with the cluster (if not already done)
eksctl utils associate-iam-oidc-provider \
  --cluster my-eks-cluster \
  --region us-east-1 \
  --approve

# Verify the provider is registered
aws iam list-open-id-connect-providers \
  | jq '.OpenIDConnectProviderList[].Arn'
```

### Create the IAM Role

```bash
# Get OIDC provider ARN
OIDC_ISSUER=$(aws eks describe-cluster \
  --name my-eks-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text)

OIDC_PROVIDER=$(echo "$OIDC_ISSUER" | sed 's|https://||')

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create trust policy
cat > trust-policy.json << EOF
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
          "${OIDC_PROVIDER}:sub": "system:serviceaccount:payment-service:payment-service"
        }
      }
    }
  ]
}
EOF

# Create the IAM role
aws iam create-role \
  --role-name payment-service-irsa \
  --assume-role-policy-document file://trust-policy.json \
  --description "IRSA role for payment-service Kubernetes workload"

# Attach permissions policy
aws iam attach-role-policy \
  --role-name payment-service-irsa \
  --policy-arn arn:aws:iam::aws:policy/SecretsManagerReadWrite

# Or create a custom scoped policy:
aws iam put-role-policy \
  --role-name payment-service-irsa \
  --policy-name payment-service-secrets-access \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ],
        "Resource": "arn:aws:secretsmanager:us-east-1:123456789012:secret:production/payment-service/*"
      },
      {
        "Effect": "Allow",
        "Action": [
          "s3:GetObject",
          "s3:PutObject"
        ],
        "Resource": "arn:aws:s3:::my-company-payment-uploads/*"
      }
    ]
  }'
```

### Annotate the Service Account

```yaml
# payment-service-sa.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: payment-service
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/payment-service-irsa
    # Optional: token expiry (default 86400s)
    eks.amazonaws.com/token-expiration: "3600"
```

The AWS SDK for Go automatically detects the `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` environment variables injected by the EKS Pod Identity Webhook:

```go
// No special code needed — aws-sdk-go-v2 handles IRSA automatically
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

func main() {
	// Automatically uses IRSA credentials when running in EKS
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("load AWS config: %v", err)
	}

	client := secretsmanager.NewFromConfig(cfg)
	result, err := client.GetSecretValue(context.Background(), &secretsmanager.GetSecretValueInput{
		SecretId: aws.String("production/payment-service/db-credentials"),
	})
	if err != nil {
		log.Fatalf("get secret: %v", err)
	}
	fmt.Println("Secret retrieved successfully")
}
```

### EKS Pod Identity (Newer Alternative to IRSA)

EKS Pod Identity (GA since 2024) is simpler than IRSA — no OIDC provider configuration required:

```bash
# Create a Pod Identity association
aws eks create-pod-identity-association \
  --cluster-name my-eks-cluster \
  --namespace payment-service \
  --service-account payment-service \
  --role-arn arn:aws:iam::123456789012:role/payment-service-pod-identity \
  --region us-east-1

# The EKS Pod Identity Agent DaemonSet handles token exchange
# Verify the agent is running
kubectl get daemonset eks-pod-identity-agent -n kube-system
```

## GCP: Workload Identity Federation

### Enable Workload Identity on GKE

```bash
# Create cluster with Workload Identity enabled
gcloud container clusters create my-gke-cluster \
  --workload-pool=my-gcp-project.svc.id.goog \
  --region us-central1

# Or enable on an existing cluster:
gcloud container clusters update my-gke-cluster \
  --workload-pool=my-gcp-project.svc.id.goog \
  --region us-central1

# Enable on a node pool (required after cluster update)
gcloud container node-pools update default-pool \
  --cluster my-gke-cluster \
  --workload-metadata=GKE_METADATA \
  --region us-central1
```

### Bind Kubernetes SA to GCP Service Account

```bash
# Create GCP service account
gcloud iam service-accounts create payment-service \
  --project my-gcp-project \
  --display-name "Payment Service Workload Identity"

# Grant permissions to GCP SA
gcloud projects add-iam-policy-binding my-gcp-project \
  --member="serviceAccount:payment-service@my-gcp-project.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding my-gcp-project \
  --member="serviceAccount:payment-service@my-gcp-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin" \
  --condition="resource.name.startsWith('projects/_/buckets/my-company-payment-uploads')"

# Allow the Kubernetes SA to impersonate the GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  payment-service@my-gcp-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-gcp-project.svc.id.goog[payment-service/payment-service]"
```

### Annotate Kubernetes Service Account

```yaml
# payment-service-sa.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: payment-service
  annotations:
    iam.gke.io/gcp-service-account: payment-service@my-gcp-project.iam.gserviceaccount.com
```

The GKE metadata server intercepts calls to the GCE metadata endpoint and returns short-lived tokens. Google Cloud client libraries in Go work automatically:

```go
// No configuration needed — GKE Workload Identity is transparent
package main

import (
	"context"
	"fmt"
	"log"

	secretmanager "cloud.google.com/go/secretmanager/apiv1"
	"cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
)

func main() {
	ctx := context.Background()
	// Automatically uses Workload Identity credentials in GKE
	client, err := secretmanager.NewClient(ctx)
	if err != nil {
		log.Fatalf("create secret manager client: %v", err)
	}
	defer client.Close()

	req := &secretmanagerpb.AccessSecretVersionRequest{
		Name: "projects/my-gcp-project/secrets/payment-db-password/versions/latest",
	}
	result, err := client.AccessSecretVersion(ctx, req)
	if err != nil {
		log.Fatalf("access secret version: %v", err)
	}
	fmt.Printf("Secret payload: %s\n", result.Payload.Data)
}
```

### Verify Workload Identity

```bash
# Test from inside the pod
kubectl run -it workload-identity-test \
  --image google/cloud-sdk:alpine \
  --namespace payment-service \
  --serviceaccount payment-service \
  --rm \
  -- /bin/sh

# Inside the pod:
curl -s "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
  -H "Metadata-Flavor: Google" | python3 -m json.tool

gcloud auth list
```

## Azure: Workload Identity (Azure AD)

### Setup Azure Workload Identity

```bash
# Install the Workload Identity Webhook via Helm
helm repo add azure-workload-identity https://azure.github.io/azure-workload-identity/charts
helm repo update

helm upgrade --install workload-identity-webhook \
  azure-workload-identity/workload-identity-webhook \
  --namespace azure-workload-identity-system \
  --create-namespace \
  --set azureTenantID=<your-tenant-id>

# Create Azure AD application
az ad app create --display-name payment-service-workload-identity
APP_CLIENT_ID=$(az ad app list --display-name payment-service-workload-identity \
  --query "[0].appId" -o tsv)
az ad sp create --id $APP_CLIENT_ID

# Get AKS OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --name my-aks-cluster \
  --resource-group my-rg \
  --query "oidcIssuerProfile.issuerUrl" -o tsv)

# Create federated identity credential
az ad app federated-credential create \
  --id $APP_CLIENT_ID \
  --parameters "{
    \"name\": \"payment-service-k8s\",
    \"issuer\": \"${OIDC_ISSUER}\",
    \"subject\": \"system:serviceaccount:payment-service:payment-service\",
    \"description\": \"Payment service Kubernetes workload\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"

# Grant Key Vault access
az keyvault set-policy \
  --name my-key-vault \
  --resource-group my-rg \
  --spn $APP_CLIENT_ID \
  --secret-permissions get list
```

### Annotate Kubernetes Service Account for Azure

```yaml
# payment-service-sa.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: payment-service
  annotations:
    azure.workload.identity/client-id: <app-client-id>
    azure.workload.identity/tenant-id: <azure-tenant-id>
```

Label the pod to enable the Azure Workload Identity webhook injection:

```yaml
# payment-service-deployment.yaml (snippet)
spec:
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: payment-service
```

The webhook injects `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_FEDERATED_TOKEN_FILE` environment variables automatically.

## On-Premises: SPIFFE/SPIRE for Non-Cloud Clusters

For self-managed clusters not on a major cloud provider, SPIRE (SPIFFE Runtime Environment) provides OIDC token issuance:

```yaml
# spire-server-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-server
  namespace: spire
data:
  server.conf: |
    server {
      bind_address = "0.0.0.0"
      bind_port = "8081"
      trust_domain = "example.org"
      data_dir = "/run/spire/data"
      log_level = "DEBUG"

      default_svid_ttl = "1h"
      ca_ttl = "24h"
    }

    plugins {
      DataStore "sql" {
        plugin_data {
          database_type = "postgres"
          connection_string = "host=postgres.spire.svc.cluster.local user=spire password=${SPIRE_DB_PASSWORD} dbname=spire"
        }
      }

      NodeAttestor "k8s_psat" {
        plugin_data {
          clusters = {
            "my-cluster" = {
              service_account_allow_list = ["spire:spire-agent"]
            }
          }
        }
      }

      KeyManager "disk" {
        plugin_data {
          keys_path = "/run/spire/data/keys.json"
        }
      }
    }
```

## Multi-Cloud Identity Architecture

For workloads that need credentials across multiple clouds simultaneously:

```yaml
# multi-cloud-sa.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: data-sync-service
  namespace: data-sync
  annotations:
    # AWS IRSA
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/data-sync-irsa
    # GCP Workload Identity
    iam.gke.io/gcp-service-account: data-sync@my-gcp-project.iam.gserviceaccount.com
    # Azure Workload Identity
    azure.workload.identity/client-id: <azure-app-client-id>
```

Multi-cloud credential acquisition in Go:

```go
// internal/cloud/credentials.go
package cloud

import (
	"context"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	gcpstorage "cloud.google.com/go/storage"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
)

type MultiCloudClients struct {
	AWS   *s3.Client
	GCP   *gcpstorage.Client
	Azure *azblob.ServiceClient
}

func NewMultiCloudClients(ctx context.Context) (*MultiCloudClients, error) {
	// AWS: reads AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE automatically
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}

	// GCP: reads from GKE metadata server or GOOGLE_APPLICATION_CREDENTIALS
	gcpClient, err := gcpstorage.NewClient(ctx)
	if err != nil {
		return nil, err
	}

	// Azure: reads AZURE_CLIENT_ID + AZURE_FEDERATED_TOKEN_FILE automatically
	cred, err := azidentity.NewWorkloadIdentityCredential(nil)
	if err != nil {
		return nil, err
	}
	azureClient, err := azblob.NewServiceClient(
		"https://mystorageaccount.blob.core.windows.net",
		cred,
		nil,
	)
	if err != nil {
		return nil, err
	}

	return &MultiCloudClients{
		AWS:   s3.NewFromConfig(awsCfg),
		GCP:   gcpClient,
		Azure: azureClient,
	}, nil
}
```

## Verifying and Debugging Workload Identity

```bash
# Check that environment variables are injected (IRSA)
kubectl exec -it <pod-name> -n payment-service -- env | grep -E "AWS_|AZURE_|GOOGLE_"

# Verify the token audience and subject
kubectl exec -it <pod-name> -n payment-service -- \
  cat $AWS_WEB_IDENTITY_TOKEN_FILE | \
  cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool

# Test AWS credential exchange manually
kubectl exec -it <pod-name> -n payment-service -- \
  aws sts get-caller-identity

# Test GCP identity
kubectl exec -it <pod-name> -n payment-service -- \
  curl -s "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email" \
  -H "Metadata-Flavor: Google"

# Test Azure identity
kubectl exec -it <pod-name> -n payment-service -- \
  curl -s "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/" \
  -H "Metadata: true" | python3 -m json.tool
```

## Summary

Kubernetes Workload Identity eliminates static cloud credentials from Kubernetes Secrets by leveraging the Kubernetes API server as an OIDC identity provider. AWS IRSA uses projected service account tokens exchanged for IAM credentials via `AssumeRoleWithWebIdentity`. EKS Pod Identity simplifies this further by removing the OIDC provider setup step. GKE Workload Identity binds Kubernetes ServiceAccounts to GCP Service Accounts via IAM policy, with the GKE metadata server performing the token exchange transparently. Azure Workload Identity uses federated credential trust anchored on the AKS OIDC issuer. All three approaches produce short-lived, automatically rotated credentials with no secrets to store in etcd — a significant improvement in both security posture and operational burden.
