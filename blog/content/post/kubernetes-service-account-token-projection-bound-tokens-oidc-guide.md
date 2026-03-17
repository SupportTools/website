---
title: "Kubernetes Service Account Token Projection: Bound Tokens, Audience Validation, and OIDC Integration"
date: 2030-05-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Service Accounts", "OIDC", "Security", "Authentication", "JWT", "Token Projection"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes projected service account tokens: bound token lifecycle, audience validation, OIDC provider configuration, and secure inter-service authentication patterns for production clusters."
more_link: "yes"
url: "/kubernetes-service-account-token-projection-bound-tokens-oidc-guide/"
---

Kubernetes projected service account tokens represent a significant security advancement over the legacy auto-mounted token model. Where legacy tokens were long-lived, cluster-scoped, and mounted unconditionally into every pod, projected tokens are time-bound, audience-restricted, and volume-projected on demand. This architectural shift enables zero-trust inter-service authentication, Kubernetes-native OIDC federation with cloud providers, and fine-grained workload identity — all without managing external secret distribution.

This guide covers the complete lifecycle of projected tokens: how the kubelet requests and rotates them, how your application validates them, how to configure Kubernetes as an OIDC issuer, and how to build audience-restricted inter-service authentication patterns that hold up in adversarial production environments.

<!--more-->

## Understanding the Token Evolution

### Legacy Auto-Mounted Tokens

Before projected tokens, every pod received an automatically mounted service account token at `/var/run/secrets/kubernetes.io/serviceaccount/token`. These tokens had fundamental security weaknesses:

- **Perpetual validity**: tokens did not expire unless the service account was deleted
- **Cluster-scoped audience**: any service receiving the token could use it against the Kubernetes API
- **Unconditional mounting**: every pod received a token regardless of whether it needed API access
- **No rotation**: once compromised, a token remained valid until manual intervention

```bash
# Inspect a legacy token (Kubernetes < 1.24 default behavior)
kubectl exec -it legacy-pod -- cat /var/run/secrets/kubernetes.io/serviceaccount/token | \
  cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool

# Output shows no expiry, audience = kubernetes
{
  "iss": "kubernetes/serviceaccount",
  "kubernetes.io/serviceaccount/namespace": "default",
  "kubernetes.io/serviceaccount/service-account.name": "my-service",
  "sub": "system:serviceaccount:default:my-service"
}
```

### Projected Token Architecture

Projected tokens are requested by the kubelet via the `TokenRequest` API and include:

- **Bounded expiry**: configurable TTL (minimum 10 minutes, recommended 1 hour)
- **Audience restriction**: token is only valid for the specified audience strings
- **Automatic rotation**: kubelet rotates the token before expiry without pod restart
- **Node binding**: token is bound to the node and pod, preventing cross-node reuse

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Token Lifecycle                               │
│                                                                     │
│  Pod Created ──► kubelet calls TokenRequest API                     │
│                           │                                         │
│                           ▼                                         │
│              kube-apiserver mints JWT with:                         │
│              - aud: ["<audience>"]                                  │
│              - exp: now + expirationSeconds                         │
│              - iat: now                                             │
│              - sub: system:serviceaccount:<ns>:<sa>                 │
│              - kubernetes.io claims (pod, node refs)                │
│                           │                                         │
│                           ▼                                         │
│              kubelet writes to projected volume path                │
│                           │                                         │
│              ┌────────────┘                                         │
│              │  80% of TTL elapsed?                                 │
│              │  YES ──► kubelet requests new token                  │
│              │  NO  ──► continue serving existing token             │
│              └─────────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────────────────┘
```

## ServiceAccount Token Volume Projection

### Basic Projected Volume Configuration

```yaml
# pod-with-projected-token.yaml
apiVersion: v1
kind: Pod
metadata:
  name: workload-with-token
  namespace: production
spec:
  serviceAccountName: payment-service
  automountServiceAccountToken: false  # Disable legacy auto-mount
  volumes:
  - name: token-vol
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600        # 1 hour TTL
          audience: "payment-service"    # Restrict to this audience
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
  - name: app
    image: payment-service:v2.1.0
    volumeMounts:
    - name: token-vol
      mountPath: /var/run/secrets/kubernetes.io/serviceaccount
      readOnly: true
```

### Multi-Audience Token Projection

When a workload needs to authenticate to multiple services with different audiences, project multiple tokens:

```yaml
# pod-multi-audience-tokens.yaml
apiVersion: v1
kind: Pod
metadata:
  name: multi-auth-workload
  namespace: production
spec:
  serviceAccountName: order-processor
  automountServiceAccountToken: false
  volumes:
  - name: k8s-api-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 600         # 10 min for K8s API access
          audience: "https://kubernetes.default.svc.cluster.local"
  - name: vault-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600
          audience: "vault.production.svc"
  - name: aws-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600
          audience: "sts.amazonaws.com"  # For IRSA/OIDC federation
  containers:
  - name: processor
    image: order-processor:v3.0.0
    volumeMounts:
    - name: k8s-api-token
      mountPath: /var/run/secrets/kubernetes.io/serviceaccount
      readOnly: true
    - name: vault-token
      mountPath: /var/run/secrets/vault
      readOnly: true
    - name: aws-token
      mountPath: /var/run/secrets/aws
      readOnly: true
```

### Token Request API Direct Usage

For advanced scenarios where your controller or operator needs to mint tokens programmatically:

```go
// token_requester.go
package auth

import (
    "context"
    "fmt"
    "time"

    authv1 "k8s.io/api/authentication/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

type TokenRequester struct {
    client    kubernetes.Interface
    namespace string
    saName    string
}

func NewTokenRequester(client kubernetes.Interface, namespace, saName string) *TokenRequester {
    return &TokenRequester{
        client:    client,
        namespace: namespace,
        saName:    saName,
    }
}

// RequestBoundToken mints a token for a specific audience with a given TTL.
func (tr *TokenRequester) RequestBoundToken(
    ctx context.Context,
    audience string,
    expirationSeconds int64,
) (string, time.Time, error) {
    treq := &authv1.TokenRequest{
        Spec: authv1.TokenRequestSpec{
            Audiences:         []string{audience},
            ExpirationSeconds: &expirationSeconds,
        },
    }

    result, err := tr.client.CoreV1().
        ServiceAccounts(tr.namespace).
        CreateToken(ctx, tr.saName, treq, metav1.CreateOptions{})
    if err != nil {
        return "", time.Time{}, fmt.Errorf("token request failed: %w", err)
    }

    expiry := result.Status.ExpirationTimestamp.Time
    return result.Status.Token, expiry, nil
}

// RequestBoundTokenWithPodBinding binds the token to a specific pod and node.
// This prevents token reuse outside the original execution context.
func (tr *TokenRequester) RequestBoundTokenWithPodBinding(
    ctx context.Context,
    audience string,
    expirationSeconds int64,
    podName, podUID, nodeName string,
) (string, time.Time, error) {
    podRef := &authv1.BoundObjectReference{
        Kind:       "Pod",
        APIVersion: "v1",
        Name:       podName,
        UID:        k8stypes.UID(podUID),
    }

    treq := &authv1.TokenRequest{
        Spec: authv1.TokenRequestSpec{
            Audiences:         []string{audience},
            ExpirationSeconds: &expirationSeconds,
            BoundObjectRef:    podRef,
        },
    }

    result, err := tr.client.CoreV1().
        ServiceAccounts(tr.namespace).
        CreateToken(ctx, tr.saName, treq, metav1.CreateOptions{})
    if err != nil {
        return "", time.Time{}, fmt.Errorf("pod-bound token request failed: %w", err)
    }

    return result.Status.Token, result.Status.ExpirationTimestamp.Time, nil
}
```

## Kubernetes as an OIDC Issuer

### Enabling the OIDC Issuer Discovery Endpoint

Kubernetes exposes OIDC discovery documents that allow external systems to validate service account tokens without direct API access.

```yaml
# kube-apiserver configuration flags (add to /etc/kubernetes/manifests/kube-apiserver.yaml)
spec:
  containers:
  - name: kube-apiserver
    command:
    - kube-apiserver
    # OIDC issuer URL - must be publicly accessible for external federation
    - --service-account-issuer=https://oidc.example.com
    # Alternative: use the cluster's API server URL for internal federation
    # - --service-account-issuer=https://kubernetes.default.svc.cluster.local
    # Multiple issuers for migration scenarios
    - --service-account-issuer=https://oidc-legacy.example.com
    # Key files for signing tokens
    - --service-account-key-file=/etc/kubernetes/pki/sa.pub
    - --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
    # Enable the OIDC discovery endpoints
    - --service-account-jwks-uri=https://oidc.example.com/openid/v1/jwks
```

### Verifying OIDC Discovery

```bash
# Retrieve the OIDC discovery document from within the cluster
kubectl get --raw /.well-known/openid-configuration | python3 -m json.tool

# Expected output
{
    "issuer": "https://oidc.example.com",
    "jwks_uri": "https://oidc.example.com/openid/v1/jwks",
    "response_types_supported": ["id_token"],
    "subject_types_supported": ["public"],
    "id_token_signing_alg_values_supported": ["RS256"]
}

# Retrieve the public JWKS (JSON Web Key Set)
kubectl get --raw /openid/v1/jwks | python3 -m json.tool
```

### AWS IRSA (IAM Roles for Service Accounts) Integration

```bash
# Step 1: Create an OIDC provider in AWS IAM
CLUSTER_NAME="production-cluster"
OIDC_ISSUER=$(kubectl get --raw /.well-known/openid-configuration | \
    python3 -c "import json,sys; print(json.load(sys.stdin)['issuer'])")

# Get the thumbprint of the OIDC issuer certificate
OIDC_THUMBPRINT=$(echo | openssl s_client -servername $(echo $OIDC_ISSUER | sed 's|https://||') \
    -connect $(echo $OIDC_ISSUER | sed 's|https://||'):443 2>/dev/null | \
    openssl x509 -fingerprint -noout | sed 's/://g' | awk -F= '{print tolower($2)}')

# Create the OIDC provider
aws iam create-open-id-connect-provider \
    --url "$OIDC_ISSUER" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "$OIDC_THUMBPRINT"
```

```json
// IAM trust policy for IRSA
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Federated": "arn:aws:iam::<account-id>:oidc-provider/oidc.example.com"
            },
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {
                "StringEquals": {
                    "oidc.example.com:aud": "sts.amazonaws.com",
                    "oidc.example.com:sub": "system:serviceaccount:production:payment-service"
                }
            }
        }
    ]
}
```

```yaml
# ServiceAccount annotation for IRSA
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::<account-id>:role/payment-service-role"
```

## Token Validation with the TokenReview API

### Server-Side Token Validation

Services receiving projected tokens should validate them using the Kubernetes TokenReview API rather than performing local JWT verification. This ensures revoked tokens (via service account deletion) are rejected immediately.

```go
// token_validator.go
package auth

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    authv1 "k8s.io/api/authentication/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

type TokenValidator struct {
    client   kubernetes.Interface
    audience string
}

func NewTokenValidator(client kubernetes.Interface, audience string) *TokenValidator {
    return &TokenValidator{
        client:   client,
        audience: audience,
    }
}

type ValidationResult struct {
    Authenticated bool
    Username      string
    UID           string
    Groups        []string
    Extra         map[string]authv1.ExtraValue
    Namespace     string
    ServiceAccount string
}

// ValidateToken performs a TokenReview against the Kubernetes API.
// This is the authoritative validation path - it handles revocation correctly.
func (v *TokenValidator) ValidateToken(ctx context.Context, token string) (*ValidationResult, error) {
    review := &authv1.TokenReview{
        Spec: authv1.TokenReviewSpec{
            Token:     token,
            Audiences: []string{v.audience},
        },
    }

    result, err := v.client.AuthenticationV1().
        TokenReviews().
        Create(ctx, review, metav1.CreateOptions{})
    if err != nil {
        return nil, fmt.Errorf("TokenReview API call failed: %w", err)
    }

    if !result.Status.Authenticated {
        return &ValidationResult{Authenticated: false}, nil
    }

    // Parse the username to extract namespace and service account name
    // Format: system:serviceaccount:<namespace>:<name>
    parts := strings.Split(result.Status.User.Username, ":")
    var ns, saName string
    if len(parts) == 4 && parts[0] == "system" && parts[1] == "serviceaccount" {
        ns = parts[2]
        saName = parts[3]
    }

    return &ValidationResult{
        Authenticated:  true,
        Username:       result.Status.User.Username,
        UID:            result.Status.User.UID,
        Groups:         result.Status.User.Groups,
        Extra:          result.Status.User.Extra,
        Namespace:      ns,
        ServiceAccount: saName,
    }, nil
}

// HTTPMiddleware creates an HTTP middleware that validates Bearer tokens.
func (v *TokenValidator) HTTPMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        authHeader := r.Header.Get("Authorization")
        if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
            http.Error(w, "missing bearer token", http.StatusUnauthorized)
            return
        }

        token := strings.TrimPrefix(authHeader, "Bearer ")
        result, err := v.ValidateToken(r.Context(), token)
        if err != nil {
            http.Error(w, "token validation error", http.StatusInternalServerError)
            return
        }

        if !result.Authenticated {
            http.Error(w, "invalid token", http.StatusUnauthorized)
            return
        }

        // Add validated identity to request context
        ctx := context.WithValue(r.Context(), contextKeyIdentity, result)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Local JWT Validation (High-Throughput Path)

For high-throughput services where TokenReview API latency is a concern, implement local validation with periodic JWKS refresh. This trades immediate revocation detection for performance.

```go
// local_validator.go
package auth

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/lestrrat-go/jwx/v2/jwk"
    "github.com/lestrrat-go/jwx/v2/jwt"
)

type LocalTokenValidator struct {
    jwksURL    string
    audience   string
    issuer     string
    cache      jwk.Cache
    mu         sync.RWMutex
    lastFetch  time.Time
    fetchEvery time.Duration
}

func NewLocalTokenValidator(jwksURL, audience, issuer string) (*LocalTokenValidator, error) {
    cache, err := jwk.NewCache(context.Background(),
        jwk.WithRefreshInterval(15*time.Minute),
    )
    if err != nil {
        return nil, fmt.Errorf("failed to create JWKS cache: %w", err)
    }

    if err := cache.Register(jwksURL); err != nil {
        return nil, fmt.Errorf("failed to register JWKS URL: %w", err)
    }

    // Pre-populate cache
    if _, err := cache.Refresh(context.Background(), jwksURL); err != nil {
        return nil, fmt.Errorf("failed to fetch initial JWKS: %w", err)
    }

    return &LocalTokenValidator{
        jwksURL:    jwksURL,
        audience:   audience,
        issuer:     issuer,
        cache:      cache,
        fetchEvery: 15 * time.Minute,
    }, nil
}

// ValidateLocal performs local JWT validation using cached JWKS.
// NOTE: This does not check revocation - use alongside periodic TokenReview for sensitive operations.
func (v *LocalTokenValidator) ValidateLocal(ctx context.Context, tokenStr string) (jwt.Token, error) {
    keySet, err := v.cache.Get(ctx, v.jwksURL)
    if err != nil {
        return nil, fmt.Errorf("failed to get JWKS: %w", err)
    }

    token, err := jwt.Parse([]byte(tokenStr),
        jwt.WithKeySet(keySet),
        jwt.WithValidate(true),
        jwt.WithAudience(v.audience),
        jwt.WithIssuer(v.issuer),
        jwt.WithAcceptableSkew(30*time.Second),
    )
    if err != nil {
        return nil, fmt.Errorf("token validation failed: %w", err)
    }

    return token, nil
}

// ExtractKubernetesClaims extracts Kubernetes-specific claims from a validated token.
func ExtractKubernetesClaims(token jwt.Token) (map[string]interface{}, error) {
    k8sClaim, ok := token.Get("kubernetes.io")
    if !ok {
        return nil, fmt.Errorf("token missing kubernetes.io claim")
    }

    claims, ok := k8sClaim.(map[string]interface{})
    if !ok {
        return nil, fmt.Errorf("unexpected kubernetes.io claim type")
    }

    return claims, nil
}
```

## RBAC Integration for Service-to-Service Authorization

### Defining Service Account Permissions

```yaml
# rbac-payment-service.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: production
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payment-service-role
  namespace: production
rules:
# Read-only access to secrets the service needs
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["payment-gateway-credentials", "stripe-api-key"]
  verbs: ["get"]
# Allow reading own service account token for sub-service calls
- apiGroups: [""]
  resources: ["serviceaccounts/token"]
  resourceNames: ["payment-service"]
  verbs: ["create"]
# Read configmaps for dynamic configuration
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["payment-config"]
  verbs: ["get", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payment-service-binding
  namespace: production
subjects:
- kind: ServiceAccount
  name: payment-service
  namespace: production
roleRef:
  kind: Role
  name: payment-service-role
  apiGroup: rbac.authorization.k8s.io
---
# Cross-namespace access: allow payment-service to call order-service
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: payment-service-caller
rules:
- apiGroups: [""]
  resources: ["serviceaccounts/token"]
  verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payment-can-call-order
  namespace: orders  # Grants access in the orders namespace
subjects:
- kind: ServiceAccount
  name: payment-service
  namespace: production
roleRef:
  kind: ClusterRole
  name: payment-service-caller
  apiGroup: rbac.authorization.k8s.io
```

### Namespace-Scoped Token Authorization Policy

```yaml
# admission-policy-token-scope.yaml
# Using OPA Gatekeeper to enforce token audience policies
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireTokenAudience
metadata:
  name: require-audience-restriction
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    namespaces: ["production", "staging"]
  parameters:
    requiredAudiencePattern: "^[a-z0-9-]+\\.production\\.svc$"
    allowKubernetesDefaultAudience: false
```

## Vault Integration with Projected Tokens

### Configuring Vault Kubernetes Auth

```bash
# Enable Kubernetes auth method in Vault
vault auth enable kubernetes

# Configure the auth method with the cluster's OIDC issuer
vault write auth/kubernetes/config \
    kubernetes_host="https://kubernetes.default.svc.cluster.local:443" \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    issuer="https://kubernetes.default.svc.cluster.local" \
    disable_iss_validation=false

# Create a Vault role bound to the service account
vault write auth/kubernetes/role/payment-service \
    bound_service_account_names=payment-service \
    bound_service_account_namespaces=production \
    policies=payment-service-policy \
    audience=vault.production.svc \
    ttl=1h
```

```go
// vault_auth.go
package vault

import (
    "context"
    "fmt"
    "os"
    "time"

    vault "github.com/hashicorp/vault/api"
    auth "github.com/hashicorp/vault/api/auth/kubernetes"
)

type VaultClient struct {
    client    *vault.Client
    tokenPath string
    role      string
}

func NewVaultClient(vaultAddr, tokenPath, role string) (*VaultClient, error) {
    config := vault.DefaultConfig()
    config.Address = vaultAddr

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create vault client: %w", err)
    }

    return &VaultClient{
        client:    client,
        tokenPath: tokenPath,
        role:      role,
    }, nil
}

// Authenticate performs Kubernetes auth with the projected token.
// The token at tokenPath must have audience matching the Vault role configuration.
func (vc *VaultClient) Authenticate(ctx context.Context) error {
    k8sAuth, err := auth.NewKubernetesAuth(
        vc.role,
        auth.WithServiceAccountTokenPath(vc.tokenPath),
    )
    if err != nil {
        return fmt.Errorf("failed to create kubernetes auth: %w", err)
    }

    authInfo, err := vc.client.Auth().Login(ctx, k8sAuth)
    if err != nil {
        return fmt.Errorf("vault authentication failed: %w", err)
    }

    if authInfo == nil {
        return fmt.Errorf("vault auth returned nil info")
    }

    return nil
}

// GetSecretWithAutoRenew reads a secret and re-authenticates if the Vault token is near expiry.
func (vc *VaultClient) GetSecretWithAutoRenew(ctx context.Context, path string) (map[string]interface{}, error) {
    // Check if we need to re-authenticate
    token := vc.client.Token()
    if token == "" {
        if err := vc.Authenticate(ctx); err != nil {
            return nil, fmt.Errorf("re-authentication failed: %w", err)
        }
    }

    secret, err := vc.client.KVv2("secret").Get(ctx, path)
    if err != nil {
        // Try re-authenticating on 403
        if err := vc.Authenticate(ctx); err != nil {
            return nil, fmt.Errorf("vault read failed after re-auth attempt: %w", err)
        }
        secret, err = vc.client.KVv2("secret").Get(ctx, path)
        if err != nil {
            return nil, fmt.Errorf("vault read failed: %w", err)
        }
    }

    return secret.Data, nil
}
```

## Monitoring Token Health

### Prometheus Metrics for Token Rotation

```go
// token_metrics.go
package monitoring

import (
    "os"
    "sync"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    tokenExpiryGauge = promauto.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "kubernetes_sa_token_expiry_seconds",
            Help: "Seconds until the projected service account token expires",
        },
        []string{"audience", "path"},
    )

    tokenReadErrors = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "kubernetes_sa_token_read_errors_total",
            Help: "Total number of errors reading service account tokens",
        },
        []string{"audience", "path"},
    )

    tokenRotations = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "kubernetes_sa_token_rotations_total",
            Help: "Total number of token rotations detected",
        },
        []string{"audience", "path"},
    )
)

type TokenMonitor struct {
    mu       sync.RWMutex
    tokens   map[string]*tokenState
    interval time.Duration
}

type tokenState struct {
    path     string
    audience string
    content  string
    expiry   time.Time
}

func NewTokenMonitor(interval time.Duration) *TokenMonitor {
    return &TokenMonitor{
        tokens:   make(map[string]*tokenState),
        interval: interval,
    }
}

func (m *TokenMonitor) Watch(path, audience string) {
    m.mu.Lock()
    m.tokens[path] = &tokenState{path: path, audience: audience}
    m.mu.Unlock()

    go m.watchLoop(path, audience)
}

func (m *TokenMonitor) watchLoop(path, audience string) {
    ticker := time.NewTicker(m.interval)
    defer ticker.Stop()

    for range ticker.C {
        content, err := os.ReadFile(path)
        if err != nil {
            tokenReadErrors.WithLabelValues(audience, path).Inc()
            continue
        }

        m.mu.Lock()
        state := m.tokens[path]
        if string(content) != state.content {
            tokenRotations.WithLabelValues(audience, path).Inc()
            state.content = string(content)
        }
        m.mu.Unlock()

        // Parse expiry from JWT without full validation
        expiry := extractTokenExpiry(string(content))
        if !expiry.IsZero() {
            remaining := time.Until(expiry).Seconds()
            tokenExpiryGauge.WithLabelValues(audience, path).Set(remaining)
            state.expiry = expiry
        }
    }
}

func extractTokenExpiry(token string) time.Time {
    // Implementation: parse JWT claims without validation to extract exp
    // Use a lightweight JWT decode (not validate)
    parts := strings.Split(token, ".")
    if len(parts) != 3 {
        return time.Time{}
    }

    payload, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return time.Time{}
    }

    var claims struct {
        Exp int64 `json:"exp"`
    }
    if err := json.Unmarshal(payload, &claims); err != nil {
        return time.Time{}
    }

    return time.Unix(claims.Exp, 0)
}
```

### Alert Rules for Token Issues

```yaml
# prometheus-token-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: service-account-token-alerts
  namespace: monitoring
spec:
  groups:
  - name: sa-token-health
    interval: 30s
    rules:
    - alert: ServiceAccountTokenNearExpiry
      expr: kubernetes_sa_token_expiry_seconds < 300
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Service account token expiring soon"
        description: "Token at {{ $labels.path }} for audience {{ $labels.audience }} expires in {{ $value | humanizeDuration }}"

    - alert: ServiceAccountTokenReadError
      expr: increase(kubernetes_sa_token_read_errors_total[5m]) > 3
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Service account token read failures"
        description: "Token at {{ $labels.path }} has had {{ $value }} read errors in the last 5 minutes"

    - alert: ServiceAccountTokenRotationStalled
      expr: kubernetes_sa_token_expiry_seconds < 600 and increase(kubernetes_sa_token_rotations_total[30m]) == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Token rotation appears stalled"
        description: "Token at {{ $labels.path }} is near expiry but has not been rotated"
```

## Production Hardening

### ServiceAccount Hardening

```yaml
# hardened-serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: production
  annotations:
    # Disable credential auto-generation for legacy secret-based tokens
    kubernetes.io/enforce-mountable-secrets: "true"
# Explicitly do NOT list secrets here to prevent secret-based tokens
automountServiceAccountToken: false
---
# Namespace-level enforcement: disable auto-mount by default
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Label used by admission webhook to enforce automountServiceAccountToken: false
    security.example.com/require-explicit-token-mount: "true"
```

### Admission Webhook for Token Policy Enforcement

```go
// webhook_token_policy.go
package webhook

import (
    "encoding/json"
    "fmt"
    "net/http"

    admissionv1 "k8s.io/api/admission/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// EnforceTokenPolicy is a mutating/validating webhook that enforces token projection policies.
func EnforceTokenPolicy(w http.ResponseWriter, r *http.Request) {
    var review admissionv1.AdmissionReview
    if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    var pod corev1.Pod
    if err := json.Unmarshal(review.Request.Object.Raw, &pod); err != nil {
        http.Error(w, "cannot decode pod", http.StatusBadRequest)
        return
    }

    response := &admissionv1.AdmissionResponse{
        UID:     review.Request.UID,
        Allowed: true,
    }

    // Validate: no projected token should use an expiry shorter than 10 minutes
    // or longer than 24 hours
    for _, vol := range pod.Spec.Volumes {
        if vol.Projected == nil {
            continue
        }
        for _, src := range vol.Projected.Sources {
            if src.ServiceAccountToken == nil {
                continue
            }
            exp := int64(3600) // default
            if src.ServiceAccountToken.ExpirationSeconds != nil {
                exp = *src.ServiceAccountToken.ExpirationSeconds
            }
            if exp < 600 {
                response.Allowed = false
                response.Result = &metav1.Status{
                    Message: fmt.Sprintf(
                        "volume %q: token expirationSeconds %d is below minimum of 600",
                        vol.Name, exp,
                    ),
                }
            }
            if exp > 86400 {
                response.Allowed = false
                response.Result = &metav1.Status{
                    Message: fmt.Sprintf(
                        "volume %q: token expirationSeconds %d exceeds maximum of 86400",
                        vol.Name, exp,
                    ),
                }
            }
            // Validate: audience must not be empty
            if src.ServiceAccountToken.Audience == "" {
                response.Allowed = false
                response.Result = &metav1.Status{
                    Message: fmt.Sprintf(
                        "volume %q: token audience must be explicitly set",
                        vol.Name,
                    ),
                }
            }
        }
    }

    review.Response = response
    json.NewEncoder(w).Encode(review)
}
```

## Troubleshooting Token Issues

### Common Failure Patterns

```bash
# Symptom: Pod cannot authenticate to Vault despite correct configuration
# Diagnosis: Check token audience matches Vault role configuration
kubectl exec -it pod-name -- sh -c '
    TOKEN=$(cat /var/run/secrets/vault/token)
    # Decode JWT payload (base64url)
    echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool | grep -E "aud|iss|sub|exp|iat"
'

# Symptom: TokenReview returns Authenticated: false despite valid-looking token
# Diagnosis: Check issuer configuration
kubectl get --raw /.well-known/openid-configuration | python3 -c '
import json, sys
config = json.load(sys.stdin)
print("Issuer:", config["issuer"])
'

# Compare with what the token claims
# If issuers do not match, tokens will fail validation

# Symptom: Token rotation not happening (token nearing expiry without renewal)
# Check kubelet logs for token request errors
journalctl -u kubelet -n 200 | grep -i "token"
# Or from inside the cluster
kubectl get events --field-selector reason=FailedMount -n production

# Symptom: RBAC prevents service account from calling TokenRequest
# Verify the SA has token creation rights
kubectl auth can-i create serviceaccounts/token \
    --as=system:serviceaccount:production:payment-service \
    -n production

# Debugging TokenReview manually
kubectl create -f - <<EOF
apiVersion: authentication.k8s.io/v1
kind: TokenReview
spec:
  token: "$(cat /tmp/test-token)"
  audiences: ["payment-service"]
EOF
```

### Token Debugging Script

```bash
#!/usr/bin/env bash
# debug-projected-token.sh - Comprehensive token diagnostics

set -euo pipefail

TOKEN_PATH="${1:-/var/run/secrets/kubernetes.io/serviceaccount/token}"

if [ ! -f "$TOKEN_PATH" ]; then
    echo "ERROR: Token not found at $TOKEN_PATH"
    exit 1
fi

TOKEN=$(cat "$TOKEN_PATH")
HEADER=$(echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null)
PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null)

echo "=== Token Header ==="
echo "$HEADER" | python3 -m json.tool

echo ""
echo "=== Token Claims ==="
echo "$PAYLOAD" | python3 -m json.tool

echo ""
echo "=== Expiry Analysis ==="
EXP=$(echo "$PAYLOAD" | python3 -c "import json,sys,datetime; d=json.load(sys.stdin); print(datetime.datetime.fromtimestamp(d['exp']))")
IAT=$(echo "$PAYLOAD" | python3 -c "import json,sys,datetime; d=json.load(sys.stdin); print(datetime.datetime.fromtimestamp(d['iat']))")
NOW=$(date)
echo "Issued at:  $IAT"
echo "Expires at: $EXP"
echo "Current:    $NOW"

echo ""
echo "=== Token File Metadata ==="
stat "$TOKEN_PATH"
```

## Key Takeaways

Projected service account tokens represent the correct security model for workload identity in Kubernetes environments. The key architectural decisions that matter in production are:

**Always disable auto-mount and project explicitly**: Setting `automountServiceAccountToken: false` at both the namespace and pod level forces explicit opt-in, eliminating the ambient credential problem that makes cluster compromises catastrophic.

**Use audience restriction consistently**: Every projected token should specify the narrowest possible audience. A token for Vault should not be usable against the Kubernetes API or any other service. The audience claim is the primary boundary between different trust domains.

**Prefer TokenReview for sensitive authorization**: Local JWT validation is faster but cannot detect revoked tokens. For operations with security significance, always perform a TokenReview API call to verify the token is still valid.

**Monitor token rotation health**: The kubelet silently rotates tokens, but rotation can fail due to network partitions, node pressure, or RBAC misconfigurations. Alert on tokens approaching expiry without rotation activity.

**Federate with cloud IAM using OIDC**: The Kubernetes OIDC issuer capability eliminates the need for long-lived cloud credentials in pods. IRSA, Workload Identity, and equivalent mechanisms on other clouds should be the default credential strategy for cloud API access.

**Validate token audience on every request**: Services receiving tokens must validate the audience claim matches their expected identifier. An attacker who captures a token for Service A must not be able to replay it against Service B.

The shift to projected tokens is not just a security improvement — it enables a principled workload identity model where every service's identity is cryptographically provable, time-limited, and auditable.
