---
title: "Kubernetes Service Account Token Projection: Workload Identity"
date: 2029-04-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Service Accounts", "OIDC", "AWS IRSA", "GCP Workload Identity", "Security", "Tokens"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes bound service account tokens, projected volume tokens, OIDC federation, AWS IRSA, GCP Workload Identity, and token expiry and rotation strategies."
more_link: "yes"
url: "/kubernetes-service-account-token-projection-workload-identity/"
---

Kubernetes workload identity has evolved dramatically from the early days of long-lived, auto-mounted service account tokens. Today, bound service account tokens with time-limited lifetimes, audience restrictions, and OIDC federation give platform teams the tools to implement true zero-trust identity for workloads running in any cloud. This guide covers the complete picture: token projection mechanics, OIDC discovery, AWS IRSA, GCP Workload Identity, and the operational patterns required to run these systems reliably at scale.

<!--more-->

# Kubernetes Service Account Token Projection: Workload Identity

## The Problem with Classic Service Account Tokens

Before Kubernetes 1.21, every pod received an automatically mounted service account token via a Secret. These tokens had three critical flaws:

1. **No expiry.** A leaked token remained valid until the ServiceAccount was deleted.
2. **No audience restriction.** A token issued for Pod A could be presented to any Kubernetes API endpoint, or any external system that accepted Kubernetes tokens.
3. **Secret-based distribution.** The token lived in etcd as a Secret, subject to all the risks of Secret exposure.

The TokenRequest API and projected volumes solve all three problems.

## Bound Service Account Tokens

A bound service account token is issued by the Kubernetes API server on demand. It is bound to:

- A specific ServiceAccount
- A specific Pod (optionally)
- A specific audience (`aud` claim)
- A maximum lifetime (`exp` claim)

### TokenRequest API

You can request a token manually with `kubectl`:

```bash
kubectl create token my-service-account \
  --audience=https://kubernetes.default.svc.cluster.local \
  --duration=1h \
  --namespace=default
```

The returned JWT contains standard OIDC claims:

```json
{
  "aud": ["https://kubernetes.default.svc.cluster.local"],
  "exp": 1714435200,
  "iat": 1714431600,
  "iss": "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE",
  "kubernetes.io": {
    "namespace": "default",
    "pod": {
      "name": "my-pod-7d4f9b8c-xkrqt",
      "uid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    },
    "serviceaccount": {
      "name": "my-service-account",
      "uid": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
    }
  },
  "nbf": 1714431600,
  "sub": "system:serviceaccount:default:my-service-account"
}
```

### Projected Volume Tokens

Rather than calling the TokenRequest API directly, most workloads consume tokens via a projected volume. The kubelet automatically manages token refresh.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: token-demo
  namespace: default
spec:
  serviceAccountName: my-service-account
  volumes:
  - name: token
    projected:
      sources:
      - serviceAccountToken:
          audience: https://kubernetes.default.svc.cluster.local
          expirationSeconds: 3600          # 1 hour; kubelet refreshes at 80% of lifetime
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
  - name: app
    image: my-app:latest
    volumeMounts:
    - name: token
      mountPath: /var/run/secrets/kubernetes.io/serviceaccount
      readOnly: true
```

The kubelet refreshes the token when it reaches 80% of its `expirationSeconds` age or when it has less than 10 minutes remaining, whichever comes first.

### Disabling Auto-Mounting

For workloads that do not need to talk to the Kubernetes API, disable auto-mounting at the ServiceAccount level:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: default
automountServiceAccountToken: false
```

Or selectively at the Pod level:

```yaml
spec:
  automountServiceAccountToken: false
```

## OIDC Discovery and Federation

The real power of projected tokens comes from OIDC federation. Kubernetes acts as an OIDC provider, and external systems can verify tokens using the cluster's public keys.

### Cluster OIDC Issuer

The OIDC issuer URL is set in the API server configuration:

```
--service-account-issuer=https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE
--service-account-signing-key-file=/etc/kubernetes/pki/sa.key
--service-account-key-file=/etc/kubernetes/pki/sa.pub
```

For self-managed clusters, the OIDC discovery document must be publicly accessible:

```
GET https://<issuer>/.well-known/openid-configuration
GET https://<issuer>/openid/v1/jwks
```

### Verifying a Token Manually

```python
import jwt
import requests
from jwt.algorithms import RSAAlgorithm

issuer = "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"

# Fetch JWKS
oidc_config = requests.get(f"{issuer}/.well-known/openid-configuration").json()
jwks = requests.get(oidc_config["jwks_uri"]).json()

# Decode without verification first to get kid
header = jwt.get_unverified_header(token)
key = next(k for k in jwks["keys"] if k["kid"] == header["kid"])
public_key = RSAAlgorithm.from_jwk(key)

claims = jwt.decode(
    token,
    public_key,
    algorithms=["RS256"],
    audience="https://kubernetes.default.svc.cluster.local",
    issuer=issuer,
)
```

## AWS IAM Roles for Service Accounts (IRSA)

IRSA allows pods to assume AWS IAM roles without static credentials. The pod's projected token is exchanged for temporary AWS credentials via the AWS STS AssumeRoleWithWebIdentity API.

### Step 1: Enable OIDC Provider on EKS

```bash
# Get cluster OIDC issuer URL
OIDC_URL=$(aws eks describe-cluster \
  --name my-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text)

# Extract the OIDC ID (last path segment)
OIDC_ID=$(echo "$OIDC_URL" | awk -F'/' '{print $NF}')

# Create the IAM OIDC provider
aws iam create-open-id-connect-provider \
  --url "$OIDC_URL" \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list "$(openssl s_client -showcerts -connect oidc.eks.us-east-1.amazonaws.com:443 </dev/null 2>/dev/null \
    | openssl x509 -fingerprint -noout -sha1 \
    | sed 's/.*=//' | tr -d ':')"
```

### Step 2: Create the IAM Role

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
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:default:my-service-account",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name my-pod-role \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy \
  --role-name my-pod-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
```

### Step 3: Annotate the ServiceAccount

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: default
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/my-pod-role
    eks.amazonaws.com/token-expiration: "86400"   # 24 hours; default is 86400
```

### Step 4: Configure the Pod

The EKS Pod Identity Webhook automatically injects the necessary environment variables and volume mounts when it sees the annotation. The resulting pod spec includes:

```yaml
env:
- name: AWS_ROLE_ARN
  value: arn:aws:iam::123456789012:role/my-pod-role
- name: AWS_WEB_IDENTITY_TOKEN_FILE
  value: /var/run/secrets/eks.amazonaws.com/serviceaccount/token
volumeMounts:
- mountPath: /var/run/secrets/eks.amazonaws.com/serviceaccount
  name: aws-iam-token
  readOnly: true
volumes:
- name: aws-iam-token
  projected:
    sources:
    - serviceAccountToken:
        audience: sts.amazonaws.com
        expirationSeconds: 86400
        path: token
```

The AWS SDK automatically reads `AWS_WEB_IDENTITY_TOKEN_FILE` and calls `AssumeRoleWithWebIdentity`.

### IRSA with Pod Identity Agent (New Model)

AWS introduced EKS Pod Identity as a simpler alternative to IRSA in 2023:

```bash
# Enable the add-on
aws eks create-addon \
  --cluster-name my-cluster \
  --addon-name eks-pod-identity-agent

# Create the association (no OIDC provider setup required)
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace default \
  --service-account my-service-account \
  --role-arn arn:aws:iam::123456789012:role/my-pod-role
```

No ServiceAccount annotation required. The Pod Identity Agent runs as a DaemonSet and intercepts IMDS requests on the node.

## GCP Workload Identity Federation

GCP Workload Identity allows GKE pods to impersonate Google Service Accounts (GSAs) using Kubernetes Service Account tokens.

### Architecture

```
Pod --> KSA token --> Workload Identity Pool --> GSA impersonation --> GCP APIs
```

### Step 1: Enable Workload Identity on GKE

```bash
gcloud container clusters update my-cluster \
  --workload-pool=my-project.svc.id.goog \
  --region us-central1
```

For node pools:

```bash
gcloud container node-pools update default-pool \
  --cluster=my-cluster \
  --region=us-central1 \
  --workload-metadata=GKE_METADATA
```

### Step 2: Create and Bind Accounts

```bash
# Create Google Service Account
gcloud iam service-accounts create my-gsa \
  --display-name="My Pod GSA"

# Grant the GSA permissions
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:my-gsa@my-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

# Allow KSA to impersonate GSA
gcloud iam service-accounts add-iam-policy-binding \
  my-gsa@my-project.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:my-project.svc.id.goog[default/my-service-account]"
```

### Step 3: Annotate the KSA

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: default
  annotations:
    iam.gke.io/gcp-service-account: my-gsa@my-project.iam.gserviceaccount.com
```

The GKE Metadata Server on each node handles the credential exchange transparently. Application code uses ADC (Application Default Credentials) without modification.

### Verifying Workload Identity

```bash
kubectl run -it --rm \
  --image=google/cloud-sdk:slim \
  --serviceaccount=my-service-account \
  --namespace=default \
  verify-wi -- /bin/bash

# Inside the pod:
curl -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
# Should return: my-gsa@my-project.iam.gserviceaccount.com

gcloud auth list
# Should show my-gsa@my-project.iam.gserviceaccount.com as ACTIVE
```

## Azure Workload Identity

Azure follows the same OIDC federation model:

```bash
# Install the mutating webhook
helm install workload-identity-webhook azure-workload-identity/workload-identity-webhook \
  --namespace azure-workload-identity-system \
  --create-namespace \
  --set azureTenantID="${AZURE_TENANT_ID}"

# Federate the KSA with an Azure Managed Identity
az identity federated-credential create \
  --name my-federated-credential \
  --identity-name my-managed-identity \
  --resource-group my-rg \
  --issuer "${OIDC_ISSUER_URL}" \
  --subject "system:serviceaccount:default:my-service-account" \
  --audience api://AzureADTokenExchange
```

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: default
  labels:
    azure.workload.identity/use: "true"
  annotations:
    azure.workload.identity/client-id: "<MANAGED_IDENTITY_CLIENT_ID>"
    azure.workload.identity/tenant-id: "<AZURE_TENANT_ID>"
```

## Token Expiry and Rotation

### Understanding the Refresh Cycle

The kubelet refreshes projected tokens proactively:

```
Token issued with expirationSeconds=3600

t=0:    token issued, exp=t+3600
t=2880: kubelet requests new token (80% of 3600 = 2880s)
t=2880: new token written to volume mount
t=3600: old token expires
```

Applications must re-read the token file on each request rather than caching it. Most SDK implementations handle this automatically.

### Application-Side Token Refresh

In Go, implement a TokenSource that re-reads the file:

```go
package identity

import (
    "os"
    "sync"
    "time"

    "golang.org/x/oauth2"
)

// FileTokenSource reads a bearer token from a file.
// It re-reads the file before returning an expired token.
type FileTokenSource struct {
    path    string
    mu      sync.Mutex
    token   *oauth2.Token
}

func NewFileTokenSource(path string) *FileTokenSource {
    return &FileTokenSource{path: path}
}

func (f *FileTokenSource) Token() (*oauth2.Token, error) {
    f.mu.Lock()
    defer f.mu.Unlock()

    // Re-read if expired or not yet loaded
    if f.token == nil || f.token.Expiry.Before(time.Now().Add(30*time.Second)) {
        raw, err := os.ReadFile(f.path)
        if err != nil {
            return nil, fmt.Errorf("reading token file %s: %w", f.path, err)
        }
        // Parse expiry from JWT claims
        exp, err := jwtExpiry(string(raw))
        if err != nil {
            return nil, err
        }
        f.token = &oauth2.Token{
            AccessToken: strings.TrimSpace(string(raw)),
            Expiry:      exp,
        }
    }
    return f.token, nil
}

func jwtExpiry(token string) (time.Time, error) {
    parts := strings.Split(token, ".")
    if len(parts) != 3 {
        return time.Time{}, fmt.Errorf("invalid JWT format")
    }
    payload, err := base64.RawURLEncoding.DecodeString(parts[1])
    if err != nil {
        return time.Time{}, err
    }
    var claims struct {
        Exp int64 `json:"exp"`
    }
    if err := json.Unmarshal(payload, &claims); err != nil {
        return time.Time{}, err
    }
    return time.Unix(claims.Exp, 0), nil
}
```

### Monitoring Token Age with Prometheus

```go
var tokenAge = prometheus.NewGaugeVec(
    prometheus.GaugeOpts{
        Name: "serviceaccount_token_age_seconds",
        Help: "Age of the current service account token in seconds.",
    },
    []string{"path"},
)

func recordTokenAge(path string) {
    raw, err := os.ReadFile(path)
    if err != nil {
        return
    }
    exp, err := jwtExpiry(strings.TrimSpace(string(raw)))
    if err != nil {
        return
    }
    tokenAge.WithLabelValues(path).Set(time.Until(exp).Seconds())
}
```

Alert when token age drops below 5 minutes:

```yaml
groups:
- name: workload-identity
  rules:
  - alert: ServiceAccountTokenExpiringSoon
    expr: serviceaccount_token_age_seconds < 300
    for: 1m
    labels:
      severity: warning
    annotations:
      summary: "Service account token expiring in less than 5 minutes"
      description: "Token at {{ $labels.path }} expires in {{ $value | humanizeDuration }}"
```

## RBAC for Service Accounts

Projected tokens are only as safe as the RBAC policies attached to the ServiceAccount. Follow the principle of least privilege:

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: default
automountServiceAccountToken: false   # Use projected volumes explicitly

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-pod-role
  namespace: default
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list"]
  resourceNames: ["app-config"]   # Restrict to specific resources

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-pod-rolebinding
  namespace: default
subjects:
- kind: ServiceAccount
  name: my-service-account
  namespace: default
roleRef:
  kind: Role
  name: my-pod-role
  apiGroup: rbac.authorization.k8s.io
```

## Multi-Audience Tokens

A single projected volume can include multiple token sources for different audiences:

```yaml
volumes:
- name: tokens
  projected:
    sources:
    - serviceAccountToken:
        audience: https://kubernetes.default.svc.cluster.local
        expirationSeconds: 3600
        path: k8s-token
    - serviceAccountToken:
        audience: sts.amazonaws.com
        expirationSeconds: 86400
        path: aws-token
    - serviceAccountToken:
        audience: api://AzureADTokenExchange
        expirationSeconds: 3600
        path: azure-token
```

## Security Hardening Checklist

```yaml
# Pod-level hardening alongside projected tokens
spec:
  automountServiceAccountToken: false   # Use explicit projected volumes
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 2000
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop: ["ALL"]
    volumeMounts:
    - name: tokens
      mountPath: /var/run/secrets/tokens
      readOnly: true
```

## Troubleshooting

### Token Not Refreshing

```bash
# Check kubelet logs for token refresh activity
journalctl -u kubelet --since "10 minutes ago" | grep -i "token\|serviceaccount"

# Verify projected volume contents
kubectl exec -it my-pod -- cat /var/run/secrets/tokens/token | \
  python3 -c "
import sys, base64, json
token = sys.stdin.read().strip()
parts = token.split('.')
payload = json.loads(base64.b64decode(parts[1] + '=='))
import datetime
print('exp:', datetime.datetime.fromtimestamp(payload['exp']))
print('iss:', payload.get('iss'))
print('aud:', payload.get('aud'))
"
```

### IRSA Credential Errors

```bash
# Test AssumeRoleWithWebIdentity manually
TOKEN=$(cat /var/run/secrets/eks.amazonaws.com/serviceaccount/token)
aws sts assume-role-with-web-identity \
  --role-arn arn:aws:iam::123456789012:role/my-pod-role \
  --role-session-name test-session \
  --web-identity-token "$TOKEN"
```

### GCP Workload Identity Debugging

```bash
# Check metadata server
curl -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/"

# Verify node pool has GKE_METADATA workload metadata mode
gcloud container node-pools describe default-pool \
  --cluster=my-cluster \
  --region=us-central1 \
  --format="value(config.workloadMetadataConfig.mode)"
```

## Best Practices Summary

- Always use projected volumes with explicit audiences rather than relying on auto-mounted tokens.
- Set `expirationSeconds` based on your security posture: shorter for high-privilege roles, longer for read-only roles that need fewer API calls.
- Disable `automountServiceAccountToken: false` at the ServiceAccount level for all service accounts, and opt in explicitly via projected volumes.
- Use dedicated ServiceAccounts for each workload type; never share ServiceAccounts across different applications.
- Audit token usage with `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>`.
- For cloud credentials, prefer IRSA/Workload Identity over node IAM roles to avoid cross-workload credential escalation.
- Monitor token expiry and alert before tokens expire.
- Rotate signing keys annually using the `--service-account-key-file` flag (Kubernetes supports multiple concurrent public keys during rotation).
