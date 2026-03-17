---
title: "Kubernetes Workload Identity Federation: OIDC, JWT, and Cloud IAM Integration"
date: 2028-05-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OIDC", "JWT", "IAM", "Workload Identity", "Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Workload Identity Federation, covering OIDC token projection, JWT validation, GKE Workload Identity, EKS IRSA, AKS Workload Identity, and implementing custom identity federation for cloud-agnostic deployments."
more_link: "yes"
url: "/kubernetes-workload-identity-federation-guide/"
---

Workload identity federation eliminates the need for long-lived credentials in containerized workloads. Instead of mounting AWS access keys or GCP service account JSON files into pods, workload identity allows your pod to present a short-lived Kubernetes service account token — signed by Kubernetes's OIDC provider — and exchange it for cloud credentials with a strictly scoped lifetime. This guide covers the full stack: Kubernetes OIDC provider configuration, JWT projection, GKE Workload Identity, EKS IRSA, AKS Workload Identity, and building a cloud-agnostic federation layer.

<!--more-->

# Kubernetes Workload Identity Federation: OIDC, JWT, and Cloud IAM Integration

## The Credential Management Problem

Traditional container security approaches have significant problems:

- **Mounted secrets**: Long-lived API keys in ConfigMaps/Secrets that rotate rarely and leak easily
- **Node-level IAM roles**: All pods on a node share the same AWS/GCP/Azure identity — over-privileged
- **Service account key files**: JSON key files that persist on disk, travel with container images, and expire on inconvenient schedules

Workload Identity Federation solves this through token exchange:

1. Kubernetes issues a short-lived JWT (Service Account Token) signed by its OIDC private key
2. The JWT contains claims identifying the pod's service account
3. The cloud IAM system trusts Kubernetes's OIDC issuer and accepts the JWT
4. Cloud IAM returns short-lived cloud credentials (AWS STS tokens, GCP access tokens, Azure managed identity tokens)
5. Credentials expire automatically — typically in 1 hour

## Kubernetes as an OIDC Provider

Kubernetes exposes an OIDC-compatible discovery endpoint that allows external systems to verify JWT signatures:

```bash
# View the OIDC configuration
kubectl get --raw /.well-known/openid-configuration | jq .
# {
#   "issuer": "https://kubernetes.default.svc.cluster.local",
#   "jwks_uri": "https://kubernetes.default.svc.cluster.local/openid/v1/jwks",
#   "response_types_supported": ["id_token"],
#   "subject_types_supported": ["public"],
#   "id_token_signing_alg_values_supported": ["RS256"]
# }

# View the public signing keys (JWKS)
kubectl get --raw /openid/v1/jwks | jq .
```

For cloud OIDC federation to work, the Kubernetes OIDC issuer URL must be publicly accessible (or the cloud provider must have network access to it). Cloud providers typically cache the JWKS, so the issuer only needs to be reachable at setup time.

### Configuring the API Server OIDC Issuer

```bash
# For kubeadm clusters, set the service-account-issuer flag
# This must be a publicly accessible URL for cloud federation
# /etc/kubernetes/manifests/kube-apiserver.yaml

spec:
  containers:
  - command:
    - kube-apiserver
    # ...
    - --service-account-issuer=https://oidc.k8s.internal.acme.com
    - --service-account-key-file=/etc/kubernetes/pki/sa.pub
    - --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
    - --api-audiences=https://oidc.k8s.internal.acme.com,kubernetes.default.svc
```

For managed Kubernetes services (GKE, EKS, AKS), the OIDC issuer is configured automatically.

## Service Account Token Projection

Kubernetes can project short-lived, audience-specific tokens into pods:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments-service
  namespace: payments
  annotations:
    # GKE: Link to GCP service account
    iam.gke.io/gcp-service-account: payments-service@acme-platform.iam.gserviceaccount.com
    # EKS: ARN of the IAM role
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/payments-service
    # AKS: Client ID of the managed identity
    azure.workload.identity/client-id: "00000000-0000-0000-0000-000000000000"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-service
  namespace: payments
spec:
  template:
    spec:
      serviceAccountName: payments-service

      # Project a short-lived token specifically for Google APIs
      volumes:
        - name: gcp-token
          projected:
            sources:
              - serviceAccountToken:
                  audience: https://iam.googleapis.com/
                  expirationSeconds: 3600
                  path: token
        - name: aws-token
          projected:
            sources:
              - serviceAccountToken:
                  audience: sts.amazonaws.com
                  expirationSeconds: 86400
                  path: token

      containers:
        - name: payments
          image: ghcr.io/acme-corp/payments-service:latest
          volumeMounts:
            - name: gcp-token
              mountPath: /var/run/secrets/tokens/gcp
              readOnly: true
            - name: aws-token
              mountPath: /var/run/secrets/tokens/aws
              readOnly: true
          env:
            # Tell SDKs where to find the credential files
            - name: GOOGLE_APPLICATION_CREDENTIALS_TOKEN_FILE
              value: /var/run/secrets/tokens/gcp/token
            - name: AWS_WEB_IDENTITY_TOKEN_FILE
              value: /var/run/secrets/tokens/aws/token
            - name: AWS_ROLE_ARN
              value: arn:aws:iam::123456789012:role/payments-service
```

### Decoding the Projected JWT

```bash
# Get the projected token
TOKEN=$(cat /var/run/secrets/tokens/gcp/token)

# Decode the JWT (base64url decode the payload)
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
# {
#   "aud": ["https://iam.googleapis.com/"],
#   "exp": 1715001600,
#   "iat": 1714998000,
#   "iss": "https://oidc.k8s.internal.acme.com",
#   "kubernetes.io": {
#     "namespace": "payments",
#     "pod": {
#       "name": "payments-service-abc123",
#       "uid": "abc123-def456"
#     },
#     "serviceaccount": {
#       "name": "payments-service",
#       "uid": "xyz789-abc123"
#     }
#   },
#   "nbf": 1714998000,
#   "sub": "system:serviceaccount:payments:payments-service"
# }
```

## GKE Workload Identity

GKE Workload Identity allows Kubernetes service accounts to impersonate Google service accounts:

### Setting Up GKE Workload Identity

```bash
# Enable Workload Identity on the cluster
gcloud container clusters update acme-production \
  --workload-pool=acme-platform.svc.id.goog \
  --region us-east1

# Enable on node pools (required)
gcloud container node-pools update default-pool \
  --cluster acme-production \
  --workload-metadata=GKE_METADATA \
  --region us-east1

# Create a Google service account
gcloud iam service-accounts create payments-service \
  --display-name="Payments Service Account" \
  --project acme-platform

# Grant the GCP SA permissions it needs
gcloud projects add-iam-policy-binding acme-platform \
  --member="serviceAccount:payments-service@acme-platform.iam.gserviceaccount.com" \
  --role="roles/bigquery.dataEditor"

gcloud projects add-iam-policy-binding acme-platform \
  --member="serviceAccount:payments-service@acme-platform.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Allow the Kubernetes SA to impersonate the GCP SA
# This creates a policy binding on the GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  payments-service@acme-platform.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:acme-platform.svc.id.goog[payments/payments-service]"
# Format: serviceAccount:{PROJECT}.svc.id.goog[{K8S_NAMESPACE}/{K8S_SA_NAME}]

# Annotate the Kubernetes service account
kubectl annotate serviceaccount payments-service \
  --namespace payments \
  iam.gke.io/gcp-service-account=payments-service@acme-platform.iam.gserviceaccount.com
```

### Verifying GKE Workload Identity

```bash
# Test from a pod
kubectl run -it --rm debug \
  --image=google/cloud-sdk:slim \
  --namespace payments \
  --overrides='{"spec":{"serviceAccountName":"payments-service"}}' \
  -- bash

# Inside the pod
gcloud auth list
# Shows: payments-service@acme-platform.iam.gserviceaccount.com

# Verify token
curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=$(gcloud auth print-access-token)"
```

## EKS IAM Roles for Service Accounts (IRSA)

### Setting Up IRSA

```bash
# Install eksctl for simplified setup
# https://github.com/eksutil/eksctl

# Enable OIDC provider for the cluster
eksctl utils associate-iam-oidc-provider \
  --cluster acme-production \
  --region us-east-1 \
  --approve

# Get the OIDC issuer URL
OIDC_URL=$(aws eks describe-cluster \
  --name acme-production \
  --region us-east-1 \
  --query "cluster.identity.oidc.issuer" \
  --output text)
echo $OIDC_URL
# https://oidc.eks.us-east-1.amazonaws.com/id/ABCDEF1234567890

# Get the OIDC provider ARN
OIDC_ARN=$(aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?ends_with(Arn, '${OIDC_URL##*/}')].Arn" \
  --output text)
```

### Creating an IAM Role with Trust Policy

```bash
# Create trust policy document
NAMESPACE="payments"
SA_NAME="payments-service"
AWS_ACCOUNT_ID="123456789012"

cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_URL#https://}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_URL#https://}:sub": "system:serviceaccount:${NAMESPACE}:${SA_NAME}",
          "${OIDC_URL#https://}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

# Create the IAM role
aws iam create-role \
  --role-name payments-service-eks \
  --assume-role-policy-document file://trust-policy.json \
  --description "IAM role for payments-service in EKS"

# Attach policies
aws iam attach-role-policy \
  --role-name payments-service-eks \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Custom policy for specific resources
aws iam put-role-policy \
  --role-name payments-service-eks \
  --policy-name payments-s3-policy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "s3:GetObject",
          "s3:PutObject"
        ],
        "Resource": "arn:aws:s3:::acme-payments-data/*"
      },
      {
        "Effect": "Allow",
        "Action": [
          "secretsmanager:GetSecretValue"
        ],
        "Resource": "arn:aws:secretsmanager:us-east-1:123456789012:secret:payments/*"
      }
    ]
  }'

# Annotate the Kubernetes service account
kubectl annotate serviceaccount payments-service \
  --namespace payments \
  "eks.amazonaws.com/role-arn=arn:aws:iam::${AWS_ACCOUNT_ID}:role/payments-service-eks"
```

### Go SDK Integration for IRSA

```go
package aws

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

// NewAWSConfigFromIRSA creates an AWS config that uses IRSA for authentication.
// The SDK automatically uses the token at AWS_WEB_IDENTITY_TOKEN_FILE
// and role at AWS_ROLE_ARN environment variables.
func NewAWSConfigFromIRSA(ctx context.Context, region string) (aws.Config, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		// The SDK will automatically use WebIdentityCredentialProvider
		// when AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN are set
	)
	if err != nil {
		return aws.Config{}, fmt.Errorf("loading AWS config: %w", err)
	}

	return cfg, nil
}

// GetSecret retrieves a secret value using IRSA-authenticated AWS SDK
func GetSecret(ctx context.Context, secretName string) (string, error) {
	cfg, err := NewAWSConfigFromIRSA(ctx, "us-east-1")
	if err != nil {
		return "", err
	}

	client := secretsmanager.NewFromConfig(cfg)

	result, err := client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: &secretName,
	})
	if err != nil {
		return "", fmt.Errorf("getting secret %q: %w", secretName, err)
	}

	if result.SecretString != nil {
		return *result.SecretString, nil
	}

	return string(result.SecretBinary), nil
}
```

## AKS Workload Identity

Azure Kubernetes Service uses the Microsoft Entra Workload Identity pattern:

```bash
# Install the workload identity webhook
helm repo add azure-workload-identity https://azure.github.io/azure-workload-identity/charts
helm install workload-identity-webhook azure-workload-identity/workload-identity-webhook \
  --namespace azure-workload-identity-system \
  --create-namespace \
  --set azureTenantID="${AZURE_TENANT_ID}"

# Create a managed identity
az identity create \
  --resource-group acme-rg \
  --name payments-service-identity

IDENTITY_CLIENT_ID=$(az identity show \
  --name payments-service-identity \
  --resource-group acme-rg \
  --query clientId -o tsv)

IDENTITY_OBJECT_ID=$(az identity show \
  --name payments-service-identity \
  --resource-group acme-rg \
  --query principalId -o tsv)

# Grant permissions to the managed identity
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee-object-id "$IDENTITY_OBJECT_ID" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/acme-rg/providers/Microsoft.KeyVault/vaults/acme-payments-kv"

# Get the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --name acme-aks \
  --resource-group acme-rg \
  --query "oidcIssuerProfile.issuerUrl" -o tsv)

# Create federated credential (link K8s SA to Azure managed identity)
az identity federated-credential create \
  --name payments-service-fedcred \
  --identity-name payments-service-identity \
  --resource-group acme-rg \
  --issuer "$OIDC_ISSUER" \
  --subject "system:serviceaccount:payments:payments-service" \
  --audience "api://AzureADTokenExchange"

# Annotate the Kubernetes service account
kubectl annotate serviceaccount payments-service \
  --namespace payments \
  "azure.workload.identity/client-id=${IDENTITY_CLIENT_ID}"

# Label the pod to use workload identity
# (The webhook injects the necessary environment variables and volume)
kubectl label pod/payments-service-abc123 \
  azure.workload.identity/use=true
```

```yaml
# Pod template for AKS Workload Identity
spec:
  serviceAccountName: payments-service
  labels:
    azure.workload.identity/use: "true"  # Triggers webhook injection
  # The webhook automatically injects:
  # - AZURE_TENANT_ID env var
  # - AZURE_CLIENT_ID env var
  # - AZURE_FEDERATED_TOKEN_FILE env var → /var/run/secrets/azure/tokens/azure-identity-token
  # - Volume mount at /var/run/secrets/azure/tokens/
```

## Cloud-Agnostic Workload Identity with Custom OIDC Federation

For environments running on bare metal or private clouds, you can implement workload identity federation against any OIDC-compatible identity provider:

### Vault JWT Auth as a Universal Credential Backend

```go
package vaultauth

import (
	"context"
	"fmt"
	"os"
	"time"

	vault "github.com/hashicorp/vault/api"
)

// VaultWorkloadIdentity exchanges a Kubernetes SA token for Vault credentials
type VaultWorkloadIdentity struct {
	client    *vault.Client
	role      string
	tokenPath string
	cache     *credentialCache
}

type Credentials struct {
	Token     string
	ExpiresAt time.Time
	Policies  []string
}

type credentialCache struct {
	creds     *Credentials
	expiresAt time.Time
}

func New(vaultAddr, role, tokenPath string) (*VaultWorkloadIdentity, error) {
	config := vault.DefaultConfig()
	config.Address = vaultAddr

	client, err := vault.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("creating vault client: %w", err)
	}

	return &VaultWorkloadIdentity{
		client:    client,
		role:      role,
		tokenPath: tokenPath,
	}, nil
}

// GetToken returns a valid Vault token, refreshing if necessary
func (v *VaultWorkloadIdentity) GetToken(ctx context.Context) (string, error) {
	// Return cached token if still valid (with 5 minute buffer)
	if v.cache != nil && time.Now().Add(5*time.Minute).Before(v.cache.expiresAt) {
		return v.cache.creds.Token, nil
	}

	// Read the projected service account token
	tokenBytes, err := os.ReadFile(v.tokenPath)
	if err != nil {
		return "", fmt.Errorf("reading service account token: %w", err)
	}

	// Exchange for Vault token via JWT auth
	secret, err := v.client.Auth().Login(ctx, &vault.AuthMethod{
		Path: "auth/kubernetes",
		Type: "jwt",
	})
	if err != nil {
		return "", fmt.Errorf("vault JWT login: %w", err)
	}

	// Alternative: use the JWT auth path directly
	loginData := map[string]interface{}{
		"jwt":  string(tokenBytes),
		"role": v.role,
	}

	secret, err = v.client.Logical().WriteWithContext(ctx, "auth/kubernetes/login", loginData)
	if err != nil {
		return "", fmt.Errorf("vault login: %w", err)
	}

	if secret.Auth == nil {
		return "", fmt.Errorf("vault login returned no auth")
	}

	ttl := time.Duration(secret.Auth.LeaseDuration) * time.Second
	v.cache = &credentialCache{
		creds: &Credentials{
			Token:    secret.Auth.ClientToken,
			ExpiresAt: time.Now().Add(ttl),
			Policies: secret.Auth.Policies,
		},
		expiresAt: time.Now().Add(ttl),
	}

	return secret.Auth.ClientToken, nil
}

// GetDatabaseCredentials exchanges a Vault token for short-lived DB credentials
func (v *VaultWorkloadIdentity) GetDatabaseCredentials(ctx context.Context, role string) (*DBCredentials, error) {
	token, err := v.GetToken(ctx)
	if err != nil {
		return nil, err
	}

	v.client.SetToken(token)

	secret, err := v.client.Logical().ReadWithContext(ctx, fmt.Sprintf("database/creds/%s", role))
	if err != nil {
		return nil, fmt.Errorf("getting database credentials: %w", err)
	}

	return &DBCredentials{
		Username:  secret.Data["username"].(string),
		Password:  secret.Data["password"].(string),
		ExpiresIn: time.Duration(secret.LeaseDuration) * time.Second,
	}, nil
}

type DBCredentials struct {
	Username  string
	Password  string
	ExpiresIn time.Duration
}
```

### Vault Kubernetes Auth Configuration

```bash
# Enable Kubernetes auth in Vault
vault auth enable kubernetes

# Configure with the cluster's OIDC info
vault write auth/kubernetes/config \
  kubernetes_host="https://k8s-api.internal.acme.com:6443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
  issuer="https://oidc.k8s.internal.acme.com"

# Or using OIDC discovery (preferred for public issuers)
vault write auth/kubernetes/config \
  oidc_discovery_url="https://oidc.k8s.internal.acme.com"

# Create a role for the payments service
vault write auth/kubernetes/role/payments-service \
  bound_service_account_names=payments-service \
  bound_service_account_namespaces=payments \
  policies=payments-policy \
  ttl=1h

# Create the Vault policy
vault policy write payments-policy - << 'EOF'
path "secret/data/payments/*" {
  capabilities = ["read", "list"]
}
path "database/creds/payments-service" {
  capabilities = ["read"]
}
path "kv/data/shared/config" {
  capabilities = ["read"]
}
EOF
```

## Token Renewal and Rotation

Projected tokens expire (default 1 hour). The kubelet automatically rotates them at 80% of the TTL. Applications must reload them periodically:

```go
package tokenmanager

import (
	"context"
	"log/slog"
	"os"
	"sync"
	"time"
)

// TokenManager handles automatic token refresh from a projected volume
type TokenManager struct {
	tokenPath    string
	mu           sync.RWMutex
	currentToken string
	lastLoaded   time.Time
	refreshInterval time.Duration
}

func New(tokenPath string, refreshInterval time.Duration) *TokenManager {
	tm := &TokenManager{
		tokenPath:       tokenPath,
		refreshInterval: refreshInterval,
	}
	// Load initial token
	tm.reload()
	return tm
}

// GetToken returns the current token, reloading from disk if stale
func (tm *TokenManager) GetToken() string {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	if time.Since(tm.lastLoaded) > tm.refreshInterval {
		// Upgrade to write lock and reload
		tm.mu.RUnlock()
		tm.mu.Lock()
		tm.reload()
		tm.mu.Unlock()
		tm.mu.RLock()
	}

	return tm.currentToken
}

// RunRefreshLoop continuously refreshes the token in the background
func (tm *TokenManager) RunRefreshLoop(ctx context.Context) {
	ticker := time.NewTicker(tm.refreshInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tm.mu.Lock()
			tm.reload()
			tm.mu.Unlock()
		}
	}
}

func (tm *TokenManager) reload() {
	data, err := os.ReadFile(tm.tokenPath)
	if err != nil {
		slog.Error("failed to reload token", "path", tm.tokenPath, "error", err)
		return
	}

	newToken := string(data)
	if newToken != tm.currentToken {
		slog.Info("token refreshed", "path", tm.tokenPath)
		tm.currentToken = newToken
	}
	tm.lastLoaded = time.Now()
}
```

## Validating JWT Tokens (Custom OIDC Verification)

For custom federation implementations, validate JWTs correctly:

```go
package oidcvalidator

import (
	"context"
	"fmt"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

type Validator struct {
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
}

func New(ctx context.Context, issuerURL string, audience string) (*Validator, error) {
	provider, err := oidc.NewProvider(ctx, issuerURL)
	if err != nil {
		return nil, fmt.Errorf("creating OIDC provider for %s: %w", issuerURL, err)
	}

	verifier := provider.Verifier(&oidc.Config{
		ClientID:          audience,
		SkipClientIDCheck: false,
		Now:               time.Now,
	})

	return &Validator{
		provider: provider,
		verifier: verifier,
	}, nil
}

type KubernetesClaims struct {
	Kubernetes struct {
		Namespace string `json:"namespace"`
		Pod       struct {
			Name string `json:"name"`
			UID  string `json:"uid"`
		} `json:"pod"`
		ServiceAccount struct {
			Name string `json:"name"`
			UID  string `json:"uid"`
		} `json:"serviceaccount"`
	} `json:"kubernetes.io"`
}

// ValidateAndExtractClaims validates a Kubernetes projected token
func (v *Validator) ValidateAndExtractClaims(ctx context.Context, rawToken string) (*oidc.IDToken, *KubernetesClaims, error) {
	token, err := v.verifier.Verify(ctx, rawToken)
	if err != nil {
		return nil, nil, fmt.Errorf("verifying token: %w", err)
	}

	var claims KubernetesClaims
	if err := token.Claims(&claims); err != nil {
		return nil, nil, fmt.Errorf("extracting claims: %w", err)
	}

	return token, &claims, nil
}
```

## Security Best Practices

### Minimal Service Account Permissions

```yaml
# Only grant what's needed — avoid cluster-admin for workloads
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payments-service
  namespace: payments
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["payments-config"]  # Specific resource name
    verbs: ["get", "watch"]
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["payments-tls"]
    verbs: ["get"]

---
# Disable automounting the default token for pods that use IRSA/GKE WI
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments-service
  namespace: payments
automountServiceAccountToken: false  # We'll use projected tokens instead
```

### Audit the OIDC Federation Setup

```bash
# Verify the OIDC issuer in a projected token
TOKEN=$(kubectl exec -n payments deploy/payments-service -- \
  cat /var/run/secrets/tokens/gcp/token)

# Decode and verify
PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null)
echo "$PAYLOAD" | jq '{iss, sub, aud, exp: (.exp | todate)}'

# Verify against the OIDC provider
ISSUER=$(echo "$PAYLOAD" | jq -r .iss)
curl -s "${ISSUER}/.well-known/openid-configuration" | jq .jwks_uri

# Check GKE Workload Identity bindings
gcloud iam service-accounts get-iam-policy \
  payments-service@acme-platform.iam.gserviceaccount.com \
  --format=json | jq '.bindings[] | select(.role=="roles/iam.workloadIdentityUser")'
```

## Conclusion

Workload identity federation is the production-standard approach to credential management in Kubernetes. By replacing long-lived API keys with short-lived, automatically-rotated tokens backed by cryptographic OIDC assertions, it eliminates entire classes of credential compromise incidents.

The implementation path is straightforward on managed Kubernetes (GKE, EKS, AKS — each provider has native support) and achievable on self-managed clusters through Vault or custom OIDC federation. The key architectural principle: the pod proves its identity through the Kubernetes service account JWT (a cryptographically signed assertion from the cluster's trusted OIDC provider), and the cloud IAM or secrets manager accepts this assertion in exchange for short-lived, scoped credentials. No secrets stored in Kubernetes, no credentials in container images, no manual rotation.
