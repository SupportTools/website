---
title: "Kubernetes Service Account Tokens: Bound Tokens, IRSA, and Workload Identity"
date: 2028-03-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Service Accounts", "IRSA", "Workload Identity", "SPIFFE", "IAM"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes service account token security, covering projected tokens with audience/expiry, TokenRequest API, AWS IRSA, GKE Workload Identity, Azure AKS with Entra ID, SPIFFE/SPIRE, and short-lived credential best practices."
more_link: "yes"
url: "/kubernetes-service-account-tokens-guide/"
---

Service account tokens are the identity foundation for workloads running in Kubernetes. The legacy model—long-lived secrets mounted automatically into every pod—is a persistent security liability. Modern Kubernetes provides bound service account tokens that are audience-scoped, time-limited, and rotated automatically. Cloud providers have built upon this foundation to enable direct IAM role assumption without static credentials through IRSA (AWS), Workload Identity (GCP), and Entra Workload ID (Azure).

This guide covers the full token lifecycle, cloud IAM integration patterns, and SPIFFE/SPIRE for cross-cluster identity.

<!--more-->

## Legacy Token Problems

The original service account token mechanism created a secret, wrote it to etcd, and mounted it into every pod automatically:

```bash
# Legacy token — never expires, broad audience, persisted in etcd
kubectl get secret -n production -o yaml | grep -A3 type | grep kubernetes.io/service-account-token

# Vulnerabilities:
# 1. No expiration — a stolen token remains valid indefinitely
# 2. No audience binding — token is accepted by any API server
# 3. etcd exposure — tokens stored as readable secrets
# 4. Bulk mounting — every pod received a token even when not needed
```

## Projected Service Account Tokens

Kubernetes 1.20+ defaults to projected volumes with bound tokens. These tokens are:
- **Audience-scoped**: only accepted by a specific service
- **Time-limited**: expire after a configurable TTL
- **Auto-rotated**: kubelet refreshes the token before expiry
- **Not stored in etcd**: generated on demand by the TokenRequest API

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: order-service
  namespace: production
spec:
  serviceAccountName: order-service
  automountServiceAccountToken: false  # Disable default mount
  volumes:
    - name: kube-api-access
      projected:
        defaultMode: 0444
        sources:
          # Bound service account token — 1 hour TTL, kubernetes audience
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: "https://kubernetes.default.svc.cluster.local"
          # CA bundle for API server TLS verification
          - configMap:
              name: kube-root-ca.crt
              items:
                - key: ca.crt
                  path: ca.crt
          # Pod namespace injection
          - downwardAPI:
              items:
                - path: namespace
                  fieldRef:
                    fieldPath: metadata.namespace
  containers:
    - name: app
      image: registry.support.tools/order-service:v2.3.1
      volumeMounts:
        - name: kube-api-access
          mountPath: /var/run/secrets/kubernetes.io/serviceaccount
          readOnly: true
```

### TokenRequest API

For fine-grained token issuance programmatically:

```bash
# Request a short-lived token for a specific audience
kubectl create token order-service \
  --namespace production \
  --audience https://vault.support.tools \
  --duration 15m

# Via API
curl -X POST \
  "https://kubernetes.default.svc/api/v1/namespaces/production/serviceaccounts/order-service/token" \
  -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
  -H "Content-Type: application/json" \
  -d '{
    "apiVersion": "authentication.k8s.io/v1",
    "kind": "TokenRequest",
    "spec": {
      "audiences": ["https://vault.support.tools"],
      "expirationSeconds": 900
    }
  }'
```

### Disabling Legacy Token Auto-Mount Cluster-Wide

```yaml
# Prevent legacy tokens from being auto-mounted
# Set on ServiceAccount objects
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-service
  namespace: production
automountServiceAccountToken: false

# Disable auto-mount for all service accounts in a namespace
# via admission webhook that patches ServiceAccount on creation
```

## AWS IRSA (IAM Roles for Service Accounts)

IRSA allows pods to assume AWS IAM roles without static credentials. The mechanism uses the Kubernetes OIDC endpoint as a trusted token issuer.

### EKS OIDC Setup

```bash
# Get the OIDC issuer URL for the cluster
CLUSTER_NAME="production-eks"
OIDC_ISSUER=$(aws eks describe-cluster \
  --name ${CLUSTER_NAME} \
  --query "cluster.identity.oidc.issuer" \
  --output text)
# https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE

# Create OIDC Identity Provider in IAM (one-time setup per cluster)
eksctl utils associate-iam-oidc-provider \
  --cluster ${CLUSTER_NAME} \
  --approve
```

### IAM Role with Trust Policy

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
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:production:order-service",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

```bash
# Create the role
aws iam create-role \
  --role-name order-service-role \
  --assume-role-policy-document file://trust-policy.json

# Attach S3 read policy
aws iam attach-role-policy \
  --role-name order-service-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
```

### Service Account Annotation

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-service
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/order-service-role"
    # Optional: customize token audience
    eks.amazonaws.com/audience: "sts.amazonaws.com"
    # Optional: token expiry (default 86400s)
    eks.amazonaws.com/token-expiration: "3600"
```

The EKS Pod Identity Webhook automatically mounts a projected token with audience `sts.amazonaws.com` into pods using this service account, and sets `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN` environment variables. The AWS SDK reads these automatically:

```go
// No credential configuration needed — SDK discovers IRSA automatically
import (
	"context"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func newS3Client(ctx context.Context) (*s3.Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("us-east-1"),
		// IRSA token automatically used when AWS_WEB_IDENTITY_TOKEN_FILE is set
	)
	if err != nil {
		return nil, err
	}
	return s3.NewFromConfig(cfg), nil
}
```

## GKE Workload Identity Federation

GKE Workload Identity maps Kubernetes service accounts to Google Service Accounts:

```bash
# Enable Workload Identity on the cluster
gcloud container clusters update production-gke \
  --workload-pool=my-project.svc.id.goog \
  --zone us-central1-a

# Create a Google Service Account
gcloud iam service-accounts create order-service \
  --project my-project \
  --display-name "Order Service"

# Grant the GCP service account access to GCS
gcloud projects add-iam-policy-binding my-project \
  --member "serviceAccount:order-service@my-project.iam.gserviceaccount.com" \
  --role "roles/storage.objectViewer"

# Bind Kubernetes SA to GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  order-service@my-project.iam.gserviceaccount.com \
  --role "roles/iam.workloadIdentityUser" \
  --member "serviceAccount:my-project.svc.id.goog[production/order-service]"
```

```yaml
# Kubernetes Service Account with Workload Identity annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-service
  namespace: production
  annotations:
    iam.gke.io/gcp-service-account: "order-service@my-project.iam.gserviceaccount.com"
```

```go
// GCS client — Workload Identity credentials loaded automatically
import "cloud.google.com/go/storage"

func newStorageClient(ctx context.Context) (*storage.Client, error) {
	// google.FindDefaultCredentials() discovers Workload Identity metadata
	return storage.NewClient(ctx)
}
```

## Azure AKS with Entra Workload Identity

Microsoft Entra Workload Identity replaces the deprecated AAD Pod Identity:

```bash
# Enable OIDC issuer and Workload Identity on AKS
az aks update \
  --resource-group production-rg \
  --name production-aks \
  --enable-oidc-issuer \
  --enable-workload-identity

# Get the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --resource-group production-rg \
  --name production-aks \
  --query "oidcIssuerProfile.issuerUrl" \
  --output tsv)

# Create a managed identity
az identity create \
  --name order-service-identity \
  --resource-group production-rg \
  --location eastus

CLIENT_ID=$(az identity show \
  --name order-service-identity \
  --resource-group production-rg \
  --query clientId -o tsv)

# Grant Storage Blob Data Reader role to the managed identity
az role assignment create \
  --assignee-object-id $(az identity show \
    --name order-service-identity \
    --resource-group production-rg \
    --query principalId -o tsv) \
  --role "Storage Blob Data Reader" \
  --scope "/subscriptions/<subscription-id>/resourceGroups/production-rg/providers/Microsoft.Storage/storageAccounts/orderstorage"

# Create federated identity credential
az identity federated-credential create \
  --name order-service-k8s-federated \
  --identity-name order-service-identity \
  --resource-group production-rg \
  --issuer "${OIDC_ISSUER}" \
  --subject "system:serviceaccount:production:order-service" \
  --audience "api://AzureADTokenExchange"
```

```yaml
# Pod spec with Workload Identity labels
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-service
  namespace: production
  annotations:
    azure.workload.identity/client-id: "<CLIENT_ID>"
    azure.workload.identity/tenant-id: "<TENANT_ID>"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"  # Required label
    spec:
      serviceAccountName: order-service
      containers:
        - name: app
          image: registry.support.tools/order-service:v2.3.1
          # Workload Identity webhook injects:
          # AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_FEDERATED_TOKEN_FILE
```

## SPIFFE/SPIRE for Cross-Cluster Identity

SPIFFE (Secure Production Identity Framework For Everyone) and its reference implementation SPIRE provide cryptographic workload identity across multiple clusters and cloud providers, independent of any single cloud IAM system.

### SPIRE Architecture

```
SPIRE Server (management cluster)
  ├── Node Attestor — verifies node identity (k8s PSAT, AWS, GCP)
  ├── Workload Attestor — verifies pod identity (k8s SA, labels)
  └── CA — issues SVID certificates to agents

SPIRE Agent (each worker node, as DaemonSet)
  ├── Attests with Server using node PSAT
  ├── Exposes Workload API (Unix socket)
  └── Issues X.509-SVIDs and JWT-SVIDs to authorized workloads
```

### SPIRE Server Registration

```bash
# Register a workload entry for order-service
kubectl exec -n spire \
  deployment/spire-server -- \
  /opt/spire/bin/spire-server entry create \
    -spiffeID "spiffe://support.tools/production/order-service" \
    -parentID "spiffe://support.tools/k8s-node/worker-1" \
    -selector "k8s:ns:production" \
    -selector "k8s:sa:order-service" \
    -selector "k8s:pod-label:app:order-service" \
    -ttl 3600
```

### Consuming SPIFFE SVIDs in Go

```go
// internal/identity/spiffe.go
package identity

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"

	"github.com/spiffe/go-spiffe/v2/spiffeid"
	"github.com/spiffe/go-spiffe/v2/spiffetls"
	"github.com/spiffe/go-spiffe/v2/workloadapi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

const workloadSocketPath = "unix:///run/spiffe/sockets/agent.sock"

// NewSPIFFEClient creates a gRPC client authenticated with SPIFFE X.509-SVID.
func NewSPIFFEClient(ctx context.Context, serverAddr string, serverID spiffeid.ID) (*grpc.ClientConn, error) {
	source, err := workloadapi.NewX509Source(ctx,
		workloadapi.WithClientOptions(workloadapi.WithAddr(workloadSocketPath)),
	)
	if err != nil {
		return nil, err
	}

	tlsConfig := spiffetls.TLSClientConfig(
		spiffetls.AuthorizeID(serverID),
		source,
	)

	return grpc.DialContext(ctx, serverAddr,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
	)
}

// GetJWTSVID obtains a JWT-SVID for presenting to a service that accepts JWTs.
func GetJWTSVID(ctx context.Context, audience string) (string, error) {
	client, err := workloadapi.New(ctx,
		workloadapi.WithAddr(workloadSocketPath),
	)
	if err != nil {
		return "", err
	}
	defer client.Close()

	svid, err := client.FetchJWTSVID(ctx, jwtsvid.Params{
		Audience: audience,
	})
	if err != nil {
		return "", err
	}
	return svid.Marshal(), nil
}
```

## Token Rotation and Short-Lived Credential Best Practices

### Monitoring Token Expiry

```bash
# Decode projected token and check expiry
TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
echo "${TOKEN}" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool

# Output includes:
# "exp": 1735000000,
# "iat": 1734996400,
# "aud": ["https://kubernetes.default.svc.cluster.local"],
# "sub": "system:serviceaccount:production:order-service"
```

### Prometheus Alert for Expiring Tokens

```yaml
# RBAC must grant access to tokenreviews for token inspection
groups:
  - name: token.alerts
    rules:
      - alert: ServiceAccountTokenExpiringSoon
        expr: |
          (kube_pod_container_info{container="token-checker"} * on(pod, namespace)
          group_left() kube_pod_created) > 0
        annotations:
          description: "Manual token management required"
```

### Vault Integration with Projected Tokens

```yaml
# Pod spec using Vault agent sidecar with IRSA-style projected token
spec:
  serviceAccountName: order-service
  volumes:
    - name: vault-token
      projected:
        sources:
          - serviceAccountToken:
              path: vault-token
              expirationSeconds: 600
              audience: "https://vault.support.tools"
  containers:
    - name: vault-agent
      image: vault:1.15.0
      args:
        - agent
        - -config=/etc/vault/agent.hcl
      volumeMounts:
        - name: vault-token
          mountPath: /var/run/secrets/vault
```

```hcl
# vault-agent.hcl
auto_auth {
  method "kubernetes" {
    mount_path = "auth/kubernetes"
    config = {
      role              = "order-service"
      token_path        = "/var/run/secrets/vault/vault-token"
    }
  }
  sink "file" {
    config = {
      path = "/vault/secrets/vault-token"
    }
  }
}
```

## Audit Policy for Token Activity

```yaml
# Enable audit logging for TokenRequest and TokenReview operations
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Metadata
    verbs: ["create"]
    resources:
      - group: "authentication.k8s.io"
        resources: ["tokenreviews"]
      - group: ""
        resources: ["serviceaccounts/token"]
    namespaces: ["production", "staging"]
```

## Production Checklist

```
Token Configuration
[ ] automountServiceAccountToken: false on all ServiceAccounts not needing API access
[ ] Projected volumes with explicit expirationSeconds (max 86400, recommend 3600)
[ ] Audience scoped to specific service endpoints, not wildcards
[ ] Legacy static token secrets deleted or blocked via admission webhook

Cloud Identity
[ ] IRSA/Workload Identity configured instead of node-level IAM roles
[ ] Trust policy conditions restrict to specific namespace/SA combinations
[ ] IAM role permissions follow least-privilege principle
[ ] Token TTL set to minimum needed (default 86400 reduced to 3600)

SPIFFE/SPIRE (cross-cluster)
[ ] SPIRE agent running as DaemonSet with node PSAT attestation
[ ] Workload entries registered for all production services
[ ] SVID rotation period set to 1 hour
[ ] Trust bundle distributed to all mesh participants

Monitoring
[ ] Audit logging capturing TokenRequest and TokenReview operations
[ ] Alerts on unexpected cross-namespace token usage
[ ] Rotation monitoring for manually managed tokens
[ ] velero/backup excludes token secrets from backup
```

Moving from long-lived mounted tokens to bound projected tokens with cloud IAM integration eliminates the most common Kubernetes credential exposure vector. The combination of short TTLs, audience scoping, and automatic rotation means a stolen token has a narrow window of exploitability, and cloud IAM integration means applications never need to manage static credentials at all.
