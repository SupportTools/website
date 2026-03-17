---
title: "GitOps Secrets Management: Sealed Secrets, SOPS, and External Secrets"
date: 2028-01-14T00:00:00-05:00
draft: false
tags: ["GitOps", "Secrets Management", "Sealed Secrets", "SOPS", "External Secrets", "ArgoCD", "Vault"]
categories:
- Kubernetes
- Security
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to GitOps secrets management covering Sealed Secrets controller, kubeseal CLI workflows, SOPS with age/GPG encryption, ArgoCD Vault plugin integration, External Secrets Operator comparison, secret rotation without commits, git-crypt for team secrets, and CI/CD secrets injection patterns."
more_link: "yes"
url: "/gitops-secrets-management-patterns-guide/"
---

GitOps mandates that all cluster state is described in git. Secrets present a fundamental conflict with this principle: storing plaintext credentials in git is a critical security vulnerability, but not storing them in git breaks the GitOps contract and creates configuration drift. Several mature approaches resolve this tension, each with distinct operational characteristics. Sealed Secrets encrypts secrets for a specific cluster using asymmetric cryptography. SOPS encrypts secret files using age, GPG, or KMS keys before committing. External Secrets Operator externalizes secrets entirely, storing them in Vault, AWS Secrets Manager, or GCP Secret Manager and synchronizing them into Kubernetes on demand. This guide examines all three approaches and the patterns for rotating secrets without committing new values to git.

<!--more-->

# GitOps Secrets Management: Sealed Secrets, SOPS, and External Secrets

## Section 1: The GitOps Secrets Problem

### Why Plaintext Secrets Cannot Go in Git

Git history is permanent. A secret committed to a git repository, even if immediately deleted in a subsequent commit, remains in the git object store and is accessible via `git log --all`, `git show <hash>`, or any clone made before the deletion. Tools like gitleaks and truffleHog routinely find secrets committed years ago in "cleaned" repositories.

The problem compounds in organizations:
- Teams fork repositories; forks contain the full history.
- CI/CD systems clone repositories; build logs may contain secret values.
- Git hosting providers (GitHub, GitLab) index repository content.
- Backup systems snapshot git repositories.

### Solution Taxonomy

```
Secret Management Approaches for GitOps
├── Encrypt-in-git
│   ├── Sealed Secrets (Kubernetes-aware, cluster-bound encryption)
│   ├── SOPS (flexible, multi-KMS, file-level encryption)
│   └── git-crypt (repository-level, GPG-based)
└── External-to-git
    ├── External Secrets Operator (CRD-based sync from external stores)
    ├── ArgoCD Vault Plugin (decrypt at deploy time)
    └── Vault Agent Sidecar (inject at pod start)
```

### Choosing an Approach

| Factor | Sealed Secrets | SOPS | External Secrets |
|--------|---------------|------|-----------------|
| Secret storage | In git (encrypted) | In git (encrypted) | External store |
| Key management | Cluster controller key | age/GPG/KMS | External store native |
| Offline operation | Yes | Yes | Requires connectivity |
| Rotation without git commit | No | No | Yes |
| Multi-cluster support | Difficult | Yes (shared keys) | Yes |
| Audit trail | Git log | Git log | External store audit log |
| Complexity | Low | Medium | Medium-High |

## Section 2: Sealed Secrets

Sealed Secrets encrypts a Kubernetes Secret for a specific cluster using the cluster's public key. Only the Sealed Secrets controller in that cluster can decrypt it.

### Installation

```bash
# Install the Sealed Secrets controller
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version 2.15.0 \
  --set fullnameOverride=sealed-secrets-controller \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=64Mi

# Install kubeseal CLI
VERSION=$(curl -s https://api.github.com/repos/bitnami-labs/sealed-secrets/releases/latest \
  | jq -r '.tag_name')
curl -sLO "https://github.com/bitnami-labs/sealed-secrets/releases/download/${VERSION}/kubeseal-${VERSION#v}-linux-amd64.tar.gz"
tar xzf "kubeseal-${VERSION#v}-linux-amd64.tar.gz" kubeseal
sudo mv kubeseal /usr/local/bin/kubeseal
```

### Creating Sealed Secrets

```bash
# Method 1: From a literal value
kubectl create secret generic db-credentials \
  --from-literal=DB_PASSWORD=mysecretpassword \
  --from-literal=DB_URL=postgresql://user:mysecretpassword@db.internal:5432/mydb \
  --dry-run=client \
  -o yaml \
  | kubeseal \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system \
    --format yaml \
  > db-credentials-sealed.yaml

# Verify the sealed secret
cat db-credentials-sealed.yaml

# Method 2: From an existing secret
kubectl get secret my-existing-secret -n production -o yaml \
  | kubeseal \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system \
    --format yaml \
  > my-secret-sealed.yaml

# Apply to cluster
kubectl apply -f db-credentials-sealed.yaml

# Verify Kubernetes Secret was created
kubectl get secret db-credentials -n default
```

### SealedSecret YAML Structure

```yaml
# db-credentials-sealed.yaml (safe to commit to git)
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-credentials
  namespace: production
  annotations:
    # Scope controls where this sealed secret can be used
    sealedsecrets.bitnami.com/cluster-wide: "false"  # Namespace-scoped
spec:
  encryptedData:
    # Base64-encoded asymmetrically encrypted values
    DB_PASSWORD: "AgByJYhj7k..."  # Long encrypted blob
    DB_URL: "AgC3xPQm9f..."       # Long encrypted blob
  template:
    metadata:
      name: db-credentials
      namespace: production
    type: Opaque
```

### Sealed Secret Scope Modes

```bash
# Strict scope (default): sealed for specific name + namespace
kubeseal --scope strict

# Namespace-wide scope: can be renamed within the namespace
kubeseal --scope namespace-wide

# Cluster-wide scope: can be used in any namespace (less secure)
kubeseal --scope cluster-wide
```

### Rotating the Sealed Secrets Controller Key

The controller periodically generates new keys. Old keys are retained for decryption; new secrets are encrypted with the latest key.

```bash
# List current sealing keys
kubectl get secrets -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o name

# Force key rotation (generate a new key immediately)
kubectl label secret \
  -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  sealedsecrets.bitnami.com/sealed-secrets-key-

kubectl delete pod \
  -n kube-system \
  -l app.kubernetes.io/name=sealed-secrets

# Backup the sealing key (critical for disaster recovery)
kubectl get secret \
  -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o yaml > sealed-secrets-keys-backup.yaml

# Encrypt this backup before storing it!
gpg --symmetric sealed-secrets-keys-backup.yaml
```

### Multi-Cluster Sealed Secrets

To use the same sealed secrets across multiple clusters, export and import the controller key:

```bash
# Export public certificate from cluster-1
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  > cluster-1-sealed-secrets-cert.pem

# Seal for cluster-1 using its certificate
kubectl create secret generic shared-secret \
  --from-literal=API_KEY=myapikey \
  --dry-run=client -o yaml \
  | kubeseal \
    --cert=cluster-1-sealed-secrets-cert.pem \
    --format yaml \
  > shared-secret-cluster1-sealed.yaml

# Or: share the same key across clusters (same cert = same encryption)
# Import cluster-1's key into cluster-2
kubectl apply -n kube-system -f cluster-1-master-key.yaml
kubectl delete pod -n kube-system -l app.kubernetes.io/name=sealed-secrets
```

## Section 3: SOPS with age and GPG

SOPS (Secrets OPerationS) is a more flexible alternative that encrypts specific values within YAML/JSON/ENV files while leaving keys and structure visible in git.

### Installing SOPS

```bash
# Install SOPS
VERSION="v3.8.1"
curl -sLO "https://github.com/mozilla/sops/releases/download/${VERSION}/sops-${VERSION}.linux.amd64"
sudo mv "sops-${VERSION}.linux.amd64" /usr/local/bin/sops
sudo chmod +x /usr/local/bin/sops

# Install age (modern encryption tool)
VERSION="v1.1.1"
curl -sLO "https://github.com/FiloSottile/age/releases/download/${VERSION}/age-${VERSION}-linux-amd64.tar.gz"
tar xzf "age-${VERSION}-linux-amd64.tar.gz"
sudo mv age/age age/age-keygen /usr/local/bin/
```

### Generating age Keys

```bash
# Generate an age keypair
age-keygen -o ~/.config/sops/age/keys.txt

# Output:
# Public key: age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyq
# AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGP

# Public key - share this (add to SOPS config)
# Private key - keep secret (do NOT commit)

# For CI/CD, store private key as a CI secret variable
# SOPS_AGE_KEY=AGE-SECRET-KEY-1QYQSZQGP...
```

### SOPS Configuration File

```yaml
# .sops.yaml (committed to git - safe, contains only public keys)
creation_rules:
# Production secrets: require 3-of-5 team members to decrypt
- path_regex: secrets/production/.*\.yaml$
  age:
  - age1team-member-1-public-key
  - age1team-member-2-public-key
  - age1team-member-3-public-key
  - age1ci-cd-system-public-key
  - age1backup-public-key

# Staging secrets: any team member can decrypt
- path_regex: secrets/staging/.*\.yaml$
  age:
  - age1team-member-1-public-key
  - age1team-member-2-public-key
  - age1ci-cd-system-public-key

# AWS KMS for production (if using AWS)
- path_regex: secrets/production/.*\.yaml$
  kms:
  - arn: arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id
    role: arn:aws:iam::123456789012:role/sops-encryption-role
    aws_profile: ""

# GCP KMS integration
- path_regex: secrets/gcp/.*\.yaml$
  gcp_kms:
  - resource_id: projects/myproject/locations/global/keyRings/sops/cryptoKeys/production-secrets

# Default rule: require at least the CI key
- path_regex: secrets/.*\.yaml$
  age:
  - age1ci-cd-system-public-key
```

### Encrypting Kubernetes Secrets with SOPS

```bash
# Create a secret manifest (plaintext, not committed)
cat > /tmp/db-credentials.yaml <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: production
type: Opaque
stringData:
  DB_PASSWORD: "my-actual-database-password"
  DB_URL: "postgresql://user:my-actual-database-password@db.internal:5432/mydb"
  JWT_SECRET: "my-jwt-signing-secret-key-64-chars-minimum"
EOF

# Encrypt the secret (only the stringData/data values are encrypted)
sops --encrypt \
  --encrypted-regex '^(stringData|data)$' \
  /tmp/db-credentials.yaml > secrets/production/db-credentials.yaml

# The output retains YAML structure but encrypts values:
# stringData:
#   DB_PASSWORD: ENC[AES256_GCM,data:xyz...,type:str]
#   DB_URL: ENC[AES256_GCM,data:abc...,type:str]

# Verify encryption worked
cat secrets/production/db-credentials.yaml

# Decrypt for inspection (requires private key)
sops --decrypt secrets/production/db-credentials.yaml

# Edit in-place (opens in $EDITOR with decrypted view)
sops secrets/production/db-credentials.yaml

# Commit the encrypted file
git add secrets/production/db-credentials.yaml
git commit -m "feat: add db-credentials for production"
```

### Deploying SOPS-Encrypted Secrets with ArgoCD

ArgoCD does not natively decrypt SOPS. Options:

1. **argocd-vault-plugin** with SOPS backend
2. **helm-secrets** plugin
3. **KSOPS** kustomize plugin

```yaml
# argocd-application-with-ksops.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-secrets
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/myorg/k8s-secrets
    targetRevision: main
    path: secrets/production
    plugin:
      name: argocd-vault-plugin
      env:
      - name: AVP_TYPE
        value: sops
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

### KSOPS Kustomize Plugin

```yaml
# kustomization.yaml with KSOPS
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

generators:
- ksops-gen.yaml
```

```yaml
# ksops-gen.yaml
apiVersion: viaduct.ai/v1
kind: ksops
metadata:
  name: ksops-generator
  annotations:
    config.kubernetes.io/function: |
      exec:
        path: ksops
files:
- secrets/production/db-credentials.yaml
- secrets/production/api-keys.yaml
```

## Section 4: External Secrets Operator

External Secrets Operator (ESO) pulls secrets from external stores (Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault) and creates Kubernetes Secrets from them.

### Installing External Secrets Operator

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version 0.9.14 \
  --set installCRDs=true \
  --set replicaCount=2 \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=64Mi
```

### AWS Secrets Manager Integration

```yaml
# aws-secretsmanager-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        # Use IRSA (IAM Role for Service Accounts)
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
---
# IAM role must have secretsmanager:GetSecretValue permission
```

```yaml
# external-secret-from-aws.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  refreshInterval: "1h"  # Re-sync from AWS every hour
  secretStoreRef:
    kind: ClusterSecretStore
    name: aws-secretsmanager
  target:
    name: db-credentials  # Creates this Kubernetes Secret
    creationPolicy: Owner  # ESO owns the secret lifecycle
    template:
      type: Opaque
      data:
        # Construct DB_URL from multiple fields
        DB_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:5432/{{ .dbname }}"
  data:
  # Map specific fields from the AWS secret
  - secretKey: DB_PASSWORD
    remoteRef:
      key: production/api-server/database
      property: password
  - secretKey: DB_USERNAME
    remoteRef:
      key: production/api-server/database
      property: username
  dataFrom:
  # Or import all key-value pairs from the AWS secret
  - extract:
      key: production/api-server/database
```

### HashiCorp Vault Integration

```yaml
# vault-secretstore.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
      caBundle: |
        LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCi4uLgotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==
```

```yaml
# vault-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-server-vault-secrets
  namespace: production
spec:
  refreshInterval: "30m"
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: api-server-secrets
    creationPolicy: Owner
  data:
  - secretKey: JWT_SECRET
    remoteRef:
      key: secret/production/api-server
      property: jwt_secret
  - secretKey: STRIPE_API_KEY
    remoteRef:
      key: secret/production/api-server
      property: stripe_api_key
  dataFrom:
  - extract:
      key: secret/production/api-server
```

### Secret Rotation Without Git Commits

ESO's `refreshInterval` enables automatic rotation. When a secret is rotated in AWS Secrets Manager or Vault, ESO detects the change on the next refresh and updates the Kubernetes Secret:

```bash
# Rotate a secret in AWS Secrets Manager
aws secretsmanager rotate-secret \
  --secret-id production/api-server/database \
  --rotation-lambda-arn arn:aws:lambda:us-east-1:123456789012:function:rotation-lambda

# Or update the secret value directly
aws secretsmanager put-secret-value \
  --secret-id production/api-server/database \
  --secret-string '{"password":"new-rotated-password","username":"apiuser","host":"db.internal","dbname":"production"}'

# ESO will pick up the new value within refreshInterval (default: 1h)
# Force immediate refresh:
kubectl annotate externalsecret db-credentials \
  -n production \
  force-sync=$(date +%s) \
  --overwrite

# Verify the Kubernetes Secret was updated
kubectl get secret db-credentials -n production \
  -o jsonpath='{.data.DB_PASSWORD}' | base64 -d
```

### PushSecret: Writing to External Stores

ESO also supports PushSecret, which writes Kubernetes Secret values to external stores:

```yaml
# push-secret.yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-tls-cert-to-vault
  namespace: cert-manager
spec:
  refreshInterval: "10m"
  secretStoreRefs:
  - name: vault-backend
    kind: ClusterSecretStore
  selector:
    secret:
      name: wildcard-tls-cert
  data:
  - match:
      secretKey: tls.crt
      remoteRef:
        remoteKey: secret/infrastructure/tls-certs
        property: certificate
  - match:
      secretKey: tls.key
      remoteRef:
        remoteKey: secret/infrastructure/tls-certs
        property: private_key
```

## Section 5: ArgoCD Vault Plugin

The ArgoCD Vault Plugin (AVP) is a plugin that runs during ArgoCD sync and replaces placeholder values in manifests with secrets from Vault or other backends.

### Installing AVP as an ArgoCD Plugin

```yaml
# argocd-cm configmap patch for AVP
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  configManagementPlugins: |
    - name: argocd-vault-plugin
      generate:
        command: ["argocd-vault-plugin"]
        args: ["generate", "./"]
    - name: argocd-vault-plugin-helm
      generate:
        command: ["sh", "-c"]
        args: ["helm template $ARGOCD_APP_NAME -n $ARGOCD_APP_NAMESPACE -f <(echo $ARGOCD_ENV_HELM_VALUES) . | argocd-vault-plugin generate -"]
    - name: argocd-vault-plugin-kustomize
      generate:
        command: ["sh", "-c"]
        args: ["kustomize build . | argocd-vault-plugin generate -"]
```

### Manifest with AVP Placeholders

```yaml
# deployment.yaml with AVP placeholder syntax
apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: production
  annotations:
    avp.kubernetes.io/path: "secret/data/production/api-server"
    avp.kubernetes.io/secret-version: "latest"
type: Opaque
stringData:
  # AVP replaces <placeholders> with values from Vault path
  JWT_SECRET: <jwt_secret>
  DATABASE_URL: <database_url>
  STRIPE_API_KEY: <stripe_api_key>
```

```yaml
# application.yaml using AVP plugin
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: api-server
  namespace: argocd
spec:
  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main
    path: apps/api-server
    plugin:
      name: argocd-vault-plugin
      env:
      - name: AVP_TYPE
        value: vault
      - name: VAULT_ADDR
        value: https://vault.internal.example.com:8200
      - name: AVP_AUTH_TYPE
        value: k8s
      - name: AVP_K8S_ROLE
        value: argocd
  destination:
    server: https://kubernetes.default.svc
    namespace: production
```

## Section 6: git-crypt for Team Secrets

git-crypt encrypts specific files in a repository using GPG. Any git operation (clone, checkout) transparently decrypts the files for authorized users.

### git-crypt Setup

```bash
# Install git-crypt
apt-get install git-crypt  # or: brew install git-crypt

# Initialize in a repository
cd my-infrastructure-repo
git-crypt init

# Add team members by GPG key ID
git-crypt add-gpg-user alice@example.com
git-crypt add-gpg-user bob@example.com
git-crypt add-gpg-user ci-system@example.com

# Configure which files to encrypt via .gitattributes
cat > .gitattributes <<'EOF'
secrets/**/*.yaml filter=git-crypt diff=git-crypt
*.env filter=git-crypt diff=git-crypt
EOF

# After adding secrets and committing, files are transparently encrypted
git add secrets/ .gitattributes
git commit -m "feat: add encrypted secrets directory"
git push

# On another machine, after cloning:
git-crypt unlock /path/to/gpg-key  # Or via GPG keyring
```

### Exporting git-crypt Key for CI/CD

```bash
# Export the symmetric key for CI/CD (NOT the GPG key)
git-crypt export-key /tmp/git-crypt-key
base64 /tmp/git-crypt-key > /tmp/git-crypt-key-b64

# Store in CI/CD secret (e.g., GitHub Actions secret)
# GIT_CRYPT_KEY = <base64 content>

# In CI/CD pipeline:
# echo "$GIT_CRYPT_KEY" | base64 -d > /tmp/git-crypt-key
# git-crypt unlock /tmp/git-crypt-key
# rm /tmp/git-crypt-key
```

## Section 7: CI/CD Secrets Injection Patterns

### GitHub Actions with External Secrets

```yaml
# .github/workflows/deploy.yaml
name: Deploy to Production
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write  # For OIDC-based AWS authentication
      contents: read

    steps:
    - uses: actions/checkout@v4

    # OIDC-based AWS credentials (no static keys)
    - uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy
        aws-region: us-east-1

    # Login to ECR without static credentials
    - uses: aws-actions/amazon-ecr-login@v2

    # Build and push (image tag used for Kubernetes deployment)
    - name: Build and push image
      env:
        REGISTRY: 123456789012.dkr.ecr.us-east-1.amazonaws.com
        IMAGE: api-server
        TAG: ${{ github.sha }}
      run: |
        docker build -t ${REGISTRY}/${IMAGE}:${TAG} .
        docker push ${REGISTRY}/${IMAGE}:${TAG}

    # Deploy: update image tag in git (ArgoCD/Flux picks it up)
    - name: Update image tag
      run: |
        git config user.name "github-actions[bot]"
        git config user.email "github-actions[bot]@users.noreply.github.com"

        # Update the image tag in the Helm values file
        yq eval ".image.tag = \"${{ github.sha }}\"" \
          -i apps/api-server/values-production.yaml

        git add apps/api-server/values-production.yaml
        git commit -m "ci: update api-server image to ${{ github.sha }}"
        git push
```

### Vault Dynamic Secrets for CI/CD

Instead of long-lived CI/CD credentials, Vault dynamic secrets generate short-lived credentials on demand:

```bash
# Enable database secrets engine
vault secrets enable database

# Configure PostgreSQL connection
vault write database/config/production-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="*" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.internal:5432/production?sslmode=require" \
  username="vault-manager" \
  password="vault-manager-password"

# Create a role for API server
vault write database/roles/api-server-read \
  db_name=production-postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# In the application, request dynamic credentials at startup
vault read database/creds/api-server-read
# Response:
# lease_id: database/creds/api-server-read/abcd1234
# username: v-api-server-abcdef
# password: A1B-randomgeneratedpassword

# Configure renewal (Vault agent handles this automatically)
```

## Section 8: Secret Scanning Prevention

### Pre-commit Hook for Secret Detection

```bash
# Install gitleaks
VERSION="v8.18.2"
curl -sLO "https://github.com/gitleaks/gitleaks/releases/download/${VERSION}/gitleaks_${VERSION#v}_linux_x64.tar.gz"
tar xzf "gitleaks_${VERSION#v}_linux_x64.tar.gz"
sudo mv gitleaks /usr/local/bin/

# Configure gitleaks
cat > .gitleaks.toml <<'EOF'
[extend]
useDefault = true

# Custom rules for organization-specific secrets
[[rules]]
description = "Internal API Key"
regex = '''INTERNAL-API-[A-Z0-9]{32}'''
tags = ["internal", "api-key"]

[[rules]]
description = "Database Connection String with Credentials"
regex = '''postgresql://[^:]+:[^@]+@'''
tags = ["database", "credential"]

# Allowlist false positives
[allowlist]
description = "Allowlist for known safe patterns"
paths = [
  "docs/examples/.*",
  "test/fixtures/.*"
]
regexes = [
  "EXAMPLE.*KEY",
  "placeholder.*password",
  "test.*secret"
]
EOF

# Install pre-commit hook
cat > .git/hooks/pre-commit <<'HOOK'
#!/bin/bash
gitleaks protect --staged --config=.gitleaks.toml
if [ $? -ne 0 ]; then
    echo "Secret detected! Fix before committing."
    exit 1
fi
HOOK
chmod +x .git/hooks/pre-commit

# Or use pre-commit framework
cat > .pre-commit-config.yaml <<'EOF'
repos:
- repo: https://github.com/gitleaks/gitleaks
  rev: v8.18.2
  hooks:
  - id: gitleaks
EOF

pre-commit install
```

### GitHub Advanced Security Secret Scanning

```yaml
# .github/workflows/secret-scan.yaml
name: Secret Scanning
on:
  push:
  pull_request:
  schedule:
  - cron: "0 0 * * 0"  # Weekly full scan

jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Full history

    - uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

    # Also scan for SOPS-unencrypted files that should be encrypted
    - name: Check for unencrypted secrets
      run: |
        # Find YAML files in secrets/ that are NOT encrypted by SOPS
        find secrets/ -name "*.yaml" | while read f; do
          if ! grep -q "ENC\[" "${f}" 2>/dev/null; then
            echo "WARNING: ${f} may not be SOPS-encrypted"
          fi
        done
```

## Section 9: Choosing the Right Pattern

### Decision Framework

```
Start here: Does the secret need to be rotated without a git commit?
│
├── YES → Use External Secrets Operator
│   ├── Already using AWS? → Use Secrets Manager + ESO
│   ├── Already using Vault? → Use Vault + ESO
│   └── GCP? → Use Secret Manager + ESO
│
└── NO → Can tolerate encrypt-in-git?
    ├── YES → Choose based on team size and tooling:
    │   ├── Single cluster, simple team → Sealed Secrets
    │   ├── Multi-cluster, or need per-environment keys → SOPS + age
    │   └── Full repository encryption → git-crypt
    │
    └── Compliance requires external storage → External Secrets Operator
```

### Production Reference Architecture

```yaml
# Recommended production setup: External Secrets Operator + Vault
# All secrets live in Vault; ESO syncs them to Kubernetes
# git contains only ESO ExternalSecret CRDs (no secret values)

# secrets/production/db-credentials-external-secret.yaml
# (SAFE to commit - contains no secret values)
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  refreshInterval: "1h"
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  target:
    name: db-credentials
    creationPolicy: Owner
    deletionPolicy: Delete  # Delete the K8s secret when ESO object is deleted
  dataFrom:
  - extract:
      key: secret/production/api-server/database
```

## Conclusion

No single secrets management approach is universally correct. The choice depends on the cluster topology (single vs. multi-cluster), operational requirements (rotation without code changes), existing toolchain (AWS/GCP/Vault), and team size.

For organizations starting fresh with GitOps, External Secrets Operator with a secrets backend (Vault for on-premises, or the cloud provider's native service for cloud deployments) provides the cleanest separation of concerns: git contains intent (which secrets are needed) without containing values (the actual credentials). Rotation happens in the external store and propagates automatically.

For simpler deployments or teams without existing secrets infrastructure, Sealed Secrets with per-cluster keys provides strong security guarantees with minimal operational overhead. SOPS bridges the gap when multi-cluster support or portable encryption is needed without the complexity of a full secrets management service.

Regardless of which tool is chosen, pre-commit hooks and CI pipeline secret scanning are non-negotiable: the best secrets management architecture can be undermined by a single accidental plaintext commit that persists in git history indefinitely.
