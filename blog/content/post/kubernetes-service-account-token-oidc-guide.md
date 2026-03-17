---
title: "Kubernetes Service Account Token Projection, Bound Tokens, and OIDC Identity Federation"
date: 2028-08-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Service Account", "OIDC", "Token Projection", "Identity"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical guide to Kubernetes service account token projection, bound service account tokens, OIDC discovery, and identity federation with AWS IRSA, GCP Workload Identity, and Vault for secretless authentication."
more_link: "yes"
url: "/kubernetes-service-account-token-oidc-guide/"
---

Kubernetes service account tokens have evolved significantly. The original, long-lived, auto-mounted tokens are a security liability — they don't expire, can't be scoped to specific audiences, and are readable by any process in the pod. Bound service account tokens, introduced in Kubernetes 1.13 and GA in 1.20, solve these problems. Combined with OIDC federation, they enable pods to authenticate to external services — AWS, GCP, Azure, HashiCorp Vault — without storing any static credentials.

This guide covers the token projection mechanism, OIDC discovery endpoint, AWS IRSA (IAM Roles for Service Accounts), GCP Workload Identity, and Vault integration.

<!--more-->

# [Kubernetes Service Account Token Projection, Bound Tokens, and OIDC Identity Federation](#k8s-service-account-tokens)

## Section 1: The Problem with Legacy Service Account Tokens

Legacy service account tokens (prior to Kubernetes 1.24) had several flaws:

1. **No expiry** — tokens never expired unless the secret was deleted
2. **No audience** — tokens could be used with any API server
3. **Auto-mounted** — every pod got a token by default
4. **Long-term storage** — stored as a Secret, accessible to anyone with Secret access in the namespace

```bash
# Check a legacy token (before 1.24)
kubectl get secret -n production \
  $(kubectl get sa myapp -n production -o jsonpath='{.secrets[0].name}') \
  -o jsonpath='{.data.token}' | base64 -d | \
  python3 -c "
import sys, json, base64
parts = sys.stdin.read().split('.')
payload = parts[1] + '=='
print(json.dumps(json.loads(base64.b64decode(payload)), indent=2))
"
# Output shows: exp is null (no expiry), aud is ['kubernetes']
```

### What Changed in Kubernetes 1.24+

Starting with Kubernetes 1.24:
- Auto-mounted secrets for service accounts are no longer automatically created
- All automatically projected tokens are bound tokens with 1-hour expiry by default
- The token is injected via the `projected` volume, not a Secret

```bash
# In Kubernetes 1.24+, service accounts don't have secrets automatically:
kubectl get serviceaccount myapp -n production -o yaml
# No .secrets field!

# The token is still injected, but via projected volume
kubectl get pod myapp-xxx -n production \
  -o jsonpath='{.spec.volumes[?(@.name=="kube-api-access-xxxxx")]}' | jq
```

## Section 2: Bound Service Account Tokens and Token Projection

### ServiceAccount Token Volume Projection

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: production
spec:
  serviceAccountName: myapp-sa
  volumes:
  # Default Kubernetes API token (auto-projected if automountServiceAccountToken: true)
  - name: kube-api-access
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600     # 1 hour expiry
          audience: "https://kubernetes.default.svc"  # audience for k8s API
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

  # Custom token for AWS (IRSA pattern)
  - name: aws-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 86400    # 24 hours for AWS STS
          audience: "sts.amazonaws.com"

  # Custom token for Vault
  - name: vault-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 7200    # 2 hours for Vault
          audience: "vault"

  containers:
  - name: app
    image: my-app:v2.3.1
    volumeMounts:
    - name: kube-api-access
      mountPath: /var/run/secrets/kubernetes.io/serviceaccount
    - name: aws-token
      mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
    - name: vault-token
      mountPath: /var/run/secrets/vault
```

### Token File Contents

The projected token file contains a signed JWT:

```bash
# Read and decode the projected token
TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | jq

# Example decoded payload:
{
  "aud": ["https://kubernetes.default.svc"],
  "exp": 1735689600,              # Expires in 1 hour
  "iat": 1735686000,
  "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
  "kubernetes.io": {
    "namespace": "production",
    "node": {
      "name": "ip-10-0-1-100.us-east-1.compute.internal",
      "uid": "abc123"
    },
    "pod": {
      "name": "myapp-7d9f8c-xxx",
      "uid": "def456"
    },
    "serviceaccount": {
      "name": "myapp-sa",
      "uid": "ghi789"
    },
    "warnafter": 1735689000        # Warn to rotate after this time
  },
  "nbf": 1735686000,
  "sub": "system:serviceaccount:production:myapp-sa"
}
```

### Token Auto-Rotation

The kubelet rotates projected tokens before they expire. Applications must re-read the token file periodically:

```go
package auth

import (
	"os"
	"sync"
	"time"
)

// TokenFile reads a service account token file, refreshing when it changes
type TokenFile struct {
	path         string
	mu           sync.RWMutex
	token        string
	lastRead     time.Time
	refreshInterval time.Duration
}

func NewTokenFile(path string) *TokenFile {
	tf := &TokenFile{
		path:            path,
		refreshInterval: 5 * time.Minute,
	}
	// Load immediately
	tf.refresh()
	// Start background refresh
	go tf.backgroundRefresh()
	return tf
}

func (tf *TokenFile) Token() string {
	tf.mu.RLock()
	defer tf.mu.RUnlock()
	return tf.token
}

func (tf *TokenFile) refresh() {
	data, err := os.ReadFile(tf.path)
	if err != nil {
		return
	}
	tf.mu.Lock()
	tf.token = string(data)
	tf.lastRead = time.Now()
	tf.mu.Unlock()
}

func (tf *TokenFile) backgroundRefresh() {
	ticker := time.NewTicker(tf.refreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		tf.refresh()
	}
}
```

## Section 3: Kubernetes OIDC Discovery

Kubernetes exposes an OIDC discovery endpoint that external services use to verify service account tokens.

### Enabling the OIDC Discovery Endpoint

On self-managed clusters, configure the API server:

```bash
# kube-apiserver flags
--service-account-issuer=https://kubernetes.example.com
--service-account-jwks-uri=https://kubernetes.example.com/openid/v1/jwks
--api-audiences=kubernetes,vault,sts.amazonaws.com
```

For EKS, the OIDC endpoint is managed automatically:

```bash
# Get the OIDC issuer URL for an EKS cluster
aws eks describe-cluster --name my-cluster --region us-east-1 \
  --query 'cluster.identity.oidc.issuer' --output text
# https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE

# Access the OIDC discovery document
curl https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE/.well-known/openid-configuration | jq

# Access the JWKS (public keys for token verification)
curl https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE/keys | jq
```

### OIDC Discovery Document

```json
{
  "issuer": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE",
  "jwks_uri": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE/keys",
  "authorization_endpoint": "urn:kubernetes:programmatic_authorization",
  "response_types_supported": ["id_token"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "claims_supported": ["sub", "iss"]
}
```

## Section 4: AWS IRSA (IAM Roles for Service Accounts)

IRSA allows Kubernetes pods to assume AWS IAM roles without storing AWS credentials. The pod's projected service account token is exchanged for temporary AWS credentials via AWS STS.

### Setting Up OIDC Provider in AWS

```bash
# Get EKS OIDC issuer
OIDC_ISSUER=$(aws eks describe-cluster --name my-cluster \
  --query 'cluster.identity.oidc.issuer' --output text)

OIDC_ID=$(echo $OIDC_ISSUER | cut -d/ -f5)

# Get the certificate thumbprint
THUMBPRINT=$(openssl s_client -servername oidc.eks.us-east-1.amazonaws.com \
  -showcerts -connect oidc.eks.us-east-1.amazonaws.com:443 < /dev/null 2>/dev/null | \
  openssl x509 -fingerprint -noout | \
  sed 's/://g' | awk -F= '{print tolower($2)}')

# Create the OIDC provider
aws iam create-open-id-connect-provider \
  --url $OIDC_ISSUER \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list $THUMBPRINT
```

### Creating an IAM Role with Trust Policy

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
NAMESPACE="production"
SERVICE_ACCOUNT="myapp-sa"

# Trust policy: allow the specific service account to assume this role
cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/${OIDC_ID}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/${OIDC_ID}:sub": "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT}",
          "oidc.eks.us-east-1.amazonaws.com/id/${OIDC_ID}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

# Create the role
aws iam create-role \
  --role-name myapp-production-role \
  --assume-role-policy-document file://trust-policy.json

# Attach permissions
aws iam attach-role-policy \
  --role-name myapp-production-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess

# Get role ARN
ROLE_ARN=$(aws iam get-role --role-name myapp-production-role \
  --query 'Role.Arn' --output text)
```

### Annotating the Service Account

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: myapp-sa
  namespace: production
  annotations:
    # This annotation tells the AWS SDK to use IRSA
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/myapp-production-role
    eks.amazonaws.com/token-expiration: "86400"  # 24h token for STS
```

### Using IRSA in Go with AWS SDK v2

```go
package aws

import (
	"context"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

func NewS3Client(ctx context.Context) (*s3.Client, error) {
	// AWS SDK v2 automatically detects IRSA when these env vars are set:
	// AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/secrets/eks.amazonaws.com/serviceaccount/token
	// AWS_ROLE_ARN=arn:aws:iam::123456789012:role/myapp-production-role
	// AWS_ROLE_SESSION_NAME=myapp-session

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(os.Getenv("AWS_REGION")),
	)
	if err != nil {
		return nil, fmt.Errorf("loading AWS config: %w", err)
	}

	return s3.NewFromConfig(cfg), nil
}

// Or explicitly configure the web identity credentials:
func NewS3ClientExplicit(ctx context.Context) (*s3.Client, error) {
	tokenFile := "/var/run/secrets/eks.amazonaws.com/serviceaccount/token"
	roleARN := os.Getenv("AWS_ROLE_ARN")

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(os.Getenv("AWS_REGION")),
	)
	if err != nil {
		return nil, err
	}

	stsClient := sts.NewFromConfig(cfg)
	cfg.Credentials = stscreds.NewWebIdentityRoleProvider(
		stsClient,
		roleARN,
		stscreds.IdentityTokenFile(tokenFile),
		func(o *stscreds.WebIdentityRoleOptions) {
			o.RoleSessionName = "myapp-session"
		},
	)

	return s3.NewFromConfig(cfg), nil
}
```

### EKS Pod Identity (Alternative to IRSA)

EKS Pod Identity (GA in 2024) is simpler than IRSA — no OIDC setup required:

```bash
# Enable Pod Identity Agent addon
aws eks create-addon \
  --cluster-name my-cluster \
  --addon-name eks-pod-identity-agent

# Create the association (no trust policy needed in IAM)
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace production \
  --service-account myapp-sa \
  --role-arn arn:aws:iam::123456789012:role/myapp-production-role

# The IAM role trust policy is automatically managed
# AWS SDK v2 uses the Pod Identity Agent's token endpoint
```

## Section 5: GCP Workload Identity

GCP's equivalent of IRSA for GKE:

```bash
# Enable Workload Identity on the cluster
gcloud container clusters update my-cluster \
  --workload-pool=my-project.svc.id.goog \
  --region us-east1

# Create a GCP service account
gcloud iam service-accounts create myapp-sa \
  --display-name="MyApp Service Account"

# Grant permissions to the GCP service account
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:myapp-sa@my-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

# Allow the Kubernetes service account to impersonate the GCP service account
gcloud iam service-accounts add-iam-policy-binding \
  myapp-sa@my-project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:my-project.svc.id.goog[production/myapp-sa]"

# Annotate the Kubernetes service account
kubectl annotate serviceaccount myapp-sa \
  --namespace production \
  iam.gke.io/gcp-service-account=myapp-sa@my-project.iam.gserviceaccount.com
```

```go
// GCP authentication with Workload Identity is automatic
// when using google.golang.org/api or cloud.google.com/go packages
package storage

import (
	"context"

	"cloud.google.com/go/storage"
	"google.golang.org/api/option"
)

func NewGCSClient(ctx context.Context) (*storage.Client, error) {
	// Workload Identity credentials are automatically used
	// via Application Default Credentials (ADC)
	return storage.NewClient(ctx)
}
```

## Section 6: HashiCorp Vault Kubernetes Auth

Vault's Kubernetes auth method verifies service account tokens:

```bash
# Enable Kubernetes auth in Vault
vault auth enable kubernetes

# Configure Vault to talk to Kubernetes API
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token \
  issuer="https://kubernetes.default.svc.cluster.local"

# Create a Vault role mapping k8s service account to Vault policies
vault write auth/kubernetes/role/myapp-role \
  bound_service_account_names=myapp-sa \
  bound_service_account_namespaces=production \
  policies=myapp-policy \
  ttl=1h \
  audience=vault

# Create policy granting access to secrets
vault policy write myapp-policy - << 'EOF'
path "secret/data/production/myapp/*" {
  capabilities = ["read"]
}
path "database/creds/myapp" {
  capabilities = ["read"]
}
EOF
```

### Go Client for Vault Kubernetes Auth

```go
package vault

import (
	"context"
	"fmt"
	"os"

	vault "github.com/hashicorp/vault/api"
	auth "github.com/hashicorp/vault/api/auth/kubernetes"
)

type Client struct {
	client     *vault.Client
	tokenFile  string
	vaultRole  string
	mountPath  string
}

func NewClient(addr, role, tokenFile string) (*Client, error) {
	config := vault.DefaultConfig()
	config.Address = addr

	client, err := vault.NewClient(config)
	if err != nil {
		return nil, fmt.Errorf("creating vault client: %w", err)
	}

	return &Client{
		client:    client,
		tokenFile: tokenFile,
		vaultRole: role,
		mountPath: "kubernetes",
	}, nil
}

func (c *Client) Authenticate(ctx context.Context) error {
	k8sAuth, err := auth.NewKubernetesAuth(
		c.vaultRole,
		auth.WithServiceAccountTokenPath(c.tokenFile),
		auth.WithMountPath(c.mountPath),
	)
	if err != nil {
		return fmt.Errorf("creating k8s auth: %w", err)
	}

	authInfo, err := c.client.Auth().Login(ctx, k8sAuth)
	if err != nil {
		return fmt.Errorf("vault login: %w", err)
	}

	if authInfo == nil {
		return fmt.Errorf("no auth info returned")
	}

	return nil
}

func (c *Client) GetSecret(ctx context.Context, path string) (map[string]any, error) {
	secret, err := c.client.KVv2("secret").Get(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("getting secret %q: %w", path, err)
	}
	return secret.Data, nil
}

func (c *Client) GetDynamicCredentials(ctx context.Context, role string) (*DatabaseCredentials, error) {
	secret, err := c.client.Logical().ReadWithContext(ctx, "database/creds/"+role)
	if err != nil {
		return nil, fmt.Errorf("getting db creds: %w", err)
	}

	return &DatabaseCredentials{
		Username: secret.Data["username"].(string),
		Password: secret.Data["password"].(string),
		TTL:      secret.LeaseDuration,
	}, nil
}
```

### Vault Agent for Transparent Secret Injection

Rather than coding Vault auth into your application, use Vault Agent as an init or sidecar container:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: production
  annotations:
    vault.hashicorp.com/agent-inject: "true"
    vault.hashicorp.com/role: "myapp-role"
    vault.hashicorp.com/agent-inject-secret-db-creds: "secret/data/production/myapp/database"
    vault.hashicorp.com/agent-inject-template-db-creds: |
      {{- with secret "secret/data/production/myapp/database" -}}
      DATABASE_URL=postgres://{{ .Data.data.username }}:{{ .Data.data.password }}@postgres:5432/mydb
      {{- end }}
spec:
  serviceAccountName: myapp-sa
  containers:
  - name: app
    image: my-app:v2.3.1
    command: ["/bin/sh", "-c"]
    args:
    - |
      # Load secrets injected by Vault Agent
      export $(cat /vault/secrets/db-creds | xargs)
      exec /app/server
    volumeMounts:
    - name: vault-secrets
      mountPath: /vault/secrets
      readOnly: true
```

## Section 7: Token Review API for External Validation

You can validate Kubernetes service account tokens from external services:

```go
package tokenreview

import (
	"context"
	"fmt"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

type Validator struct {
	client kubernetes.Interface
}

func NewValidator() (*Validator, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, err
	}
	return &Validator{client: client}, nil
}

type TokenInfo struct {
	ServiceAccount string
	Namespace      string
	PodName        string
	Authenticated  bool
}

func (v *Validator) ValidateToken(ctx context.Context, token string, audiences []string) (*TokenInfo, error) {
	review := &authenticationv1.TokenReview{
		Spec: authenticationv1.TokenReviewSpec{
			Token:     token,
			Audiences: audiences,
		},
	}

	result, err := v.client.AuthenticationV1().TokenReviews().Create(
		ctx, review, metav1.CreateOptions{},
	)
	if err != nil {
		return nil, fmt.Errorf("token review failed: %w", err)
	}

	if !result.Status.Authenticated {
		return &TokenInfo{Authenticated: false}, nil
	}

	info := &TokenInfo{
		Authenticated: true,
	}

	// Parse extra info
	if result.Status.User.Extra != nil {
		if ns := result.Status.User.Extra["authentication.kubernetes.io/namespace"]; len(ns) > 0 {
			info.Namespace = string(ns[0])
		}
		if pod := result.Status.User.Extra["authentication.kubernetes.io/pod-name"]; len(pod) > 0 {
			info.PodName = string(pod[0])
		}
	}

	// Username format: system:serviceaccount:NAMESPACE:SA_NAME
	parts := strings.Split(result.Status.User.Username, ":")
	if len(parts) == 4 {
		info.Namespace = parts[2]
		info.ServiceAccount = parts[3]
	}

	return info, nil
}
```

## Section 8: OIDC Token Verification Without Kubernetes

External services can verify tokens directly using the OIDC JWKS endpoint:

```go
package oidc

import (
	"context"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
)

type Verifier struct {
	verifier *oidc.IDTokenVerifier
}

func NewVerifier(ctx context.Context, issuerURL string, audiences []string) (*Verifier, error) {
	// Creates an OIDC provider from the discovery document
	provider, err := oidc.NewProvider(ctx, issuerURL)
	if err != nil {
		return nil, fmt.Errorf("creating OIDC provider: %w", err)
	}

	verifier := provider.Verifier(&oidc.Config{
		SkipClientIDCheck: len(audiences) == 0,
		ClientID:          audiences[0], // primary audience
	})

	return &Verifier{verifier: verifier}, nil
}

type Claims struct {
	Subject          string
	ServiceAccount   string
	Namespace        string
	PodName          string
	Issuer           string
}

func (v *Verifier) Verify(ctx context.Context, token string) (*Claims, error) {
	idToken, err := v.verifier.Verify(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("token verification failed: %w", err)
	}

	var claims struct {
		Kubernetes struct {
			Namespace      string `json:"namespace"`
			Pod            struct {
				Name string `json:"name"`
			} `json:"pod"`
			ServiceAccount struct {
				Name string `json:"name"`
			} `json:"serviceaccount"`
		} `json:"kubernetes.io"`
	}

	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("parsing claims: %w", err)
	}

	return &Claims{
		Subject:        idToken.Subject,
		ServiceAccount: claims.Kubernetes.ServiceAccount.Name,
		Namespace:      claims.Kubernetes.Namespace,
		PodName:        claims.Kubernetes.Pod.Name,
		Issuer:         idToken.Issuer,
	}, nil
}
```

## Section 9: Security Best Practices

### Disable Auto-mounting for All Pods

```yaml
# In the default ServiceAccount — disable auto-mount cluster-wide
apiVersion: v1
kind: ServiceAccount
metadata:
  name: default
  namespace: production
automountServiceAccountToken: false  # Opt-in per pod instead
---
# Pods that need the token opt in explicitly
apiVersion: v1
kind: Pod
spec:
  automountServiceAccountToken: true  # Override for pods that need it
  serviceAccountName: myapp-sa
```

### Namespace-Scoped Service Accounts

```yaml
# One service account per application, minimal permissions
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service-sa
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/payment-service-prod
automountServiceAccountToken: false  # Only mount when needed
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payment-service-role
  namespace: production
rules:
# Only the minimum permissions the service needs
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["payment-service-config"]
  verbs: ["get", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payment-service-binding
  namespace: production
subjects:
- kind: ServiceAccount
  name: payment-service-sa
  namespace: production
roleRef:
  kind: Role
  name: payment-service-role
  apiGroup: rbac.authorization.k8s.io
```

### Audit Token Usage

```bash
# Check which pods have service account tokens mounted
kubectl get pods -n production \
  -o jsonpath='{range .items[*]}{.metadata.name}: automount={.spec.automountServiceAccountToken}{"\n"}{end}'

# Find pods using the default service account
kubectl get pods -n production \
  -o jsonpath='{range .items[*]}{.metadata.name}: sa={.spec.serviceAccountName}{"\n"}{end}' | \
  grep "sa=default"

# Audit RBAC permissions for a service account
kubectl auth can-i --list \
  --as=system:serviceaccount:production:payment-service-sa

# Check for overly permissive IRSA roles
aws iam get-role-policy \
  --role-name payment-service-prod \
  --policy-name inline-policy
```

### Restricting Token Audiences

```yaml
# API server flag to restrict audience validation
# kube-apiserver: --api-audiences=kubernetes,vault,sts.amazonaws.com

# Pod: request only needed audiences
volumes:
- name: vault-token
  projected:
    sources:
    - serviceAccountToken:
        path: token
        audience: "vault"          # Only valid for Vault
        expirationSeconds: 7200
- name: aws-token
  projected:
    sources:
    - serviceAccountToken:
        path: token
        audience: "sts.amazonaws.com"  # Only valid for AWS STS
        expirationSeconds: 86400
```

## Section 10: Troubleshooting Token Issues

### Token Validation Debugging

```bash
# Decode and inspect a token without external tools
TOKEN=$(kubectl exec -n production myapp-xxx -- \
  cat /var/run/secrets/kubernetes.io/serviceaccount/token)

# Decode the header
echo $TOKEN | cut -d. -f1 | base64 -d 2>/dev/null | jq

# Decode the payload
echo $TOKEN | cut -d. -f2 | \
  python3 -c "import sys, base64, json; data = sys.stdin.read(); print(json.dumps(json.loads(base64.urlsafe_b64decode(data + '==')), indent=2))"

# Check token expiry
EXP=$(echo $TOKEN | cut -d. -f2 | \
  python3 -c "import sys, base64, json; data = sys.stdin.read(); claims=json.loads(base64.urlsafe_b64decode(data + '==')); print(claims.get('exp', 'none'))")
date -d "@$EXP"
```

### IRSA Not Working

```bash
# Check the service account annotation
kubectl get sa myapp-sa -n production \
  -o jsonpath='{.metadata.annotations}'

# Check the projected volume
kubectl get pod myapp-xxx -n production \
  -o jsonpath='{.spec.volumes[*]}' | python3 -m json.tool

# Check the AWS_ROLE_ARN env var is set
kubectl exec -n production myapp-xxx -- env | grep AWS

# Test STS token exchange manually
TOKEN=$(cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token)
aws sts assume-role-with-web-identity \
  --role-arn $AWS_ROLE_ARN \
  --role-session-name test-session \
  --web-identity-token $TOKEN
```

### Vault Authentication Failure

```bash
# Test Vault auth manually from inside the pod
TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
curl -s --request POST \
  --data "{\"jwt\": \"$TOKEN\", \"role\": \"myapp-role\"}" \
  https://vault.internal:8200/v1/auth/kubernetes/login | jq

# Check Vault's view of the token
vault write auth/kubernetes/login \
  role=myapp-role \
  jwt=$TOKEN
```

## Section 11: Complete Deployment Example

```yaml
# Complete production-ready deployment using IRSA
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service-sa
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/payment-service-prod
    eks.amazonaws.com/token-expiration: "86400"
automountServiceAccountToken: false  # Explicit mounting only
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: production
spec:
  replicas: 3
  template:
    spec:
      serviceAccountName: payment-service-sa
      automountServiceAccountToken: false  # Set explicitly on pod too

      volumes:
      # Kubernetes API access (for health checks, leader election)
      - name: kube-api-access
        projected:
          sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: "https://kubernetes.default.svc"
          - configMap:
              name: kube-root-ca.crt
              items:
              - key: ca.crt
                path: ca.crt
          - downwardAPI:
              items:
              - path: namespace
                fieldRef:
                  fieldPath: metadata.namespace

      # AWS access token (for S3, SQS, etc.)
      - name: aws-token
        projected:
          sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 86400
              audience: "sts.amazonaws.com"

      containers:
      - name: payment-service
        image: payment-service:v2.3.1
        env:
        - name: AWS_REGION
          value: us-east-1
        - name: AWS_ROLE_ARN
          valueFrom:
            fieldRef:
              fieldPath: metadata.annotations['eks.amazonaws.com/role-arn']
        - name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
        volumeMounts:
        - name: kube-api-access
          mountPath: /var/run/secrets/kubernetes.io/serviceaccount
          readOnly: true
        - name: aws-token
          mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
          readOnly: true

      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
```

This architecture eliminates all static credentials from the pod. The service account token is time-limited, audience-scoped, and automatically rotated by the kubelet — giving you a strong identity foundation for secretless authentication to any OIDC-compatible system.
