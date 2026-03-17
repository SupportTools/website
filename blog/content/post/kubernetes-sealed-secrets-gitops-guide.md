---
title: "Sealed Secrets for GitOps: Encrypting Kubernetes Secrets for Safe Git Storage"
date: 2028-06-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "Sealed Secrets", "Security", "ArgoCD", "Flux"]
categories: ["Kubernetes", "Security", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Bitnami Sealed Secrets for Kubernetes GitOps workflows: kubeseal encryption, key rotation, multi-cluster secret management, comparison with External Secrets Operator, and Git security best practices."
more_link: "yes"
url: "/kubernetes-sealed-secrets-gitops/"
---

Storing Kubernetes Secrets in Git is a security anti-pattern — base64 encoding is not encryption, and any developer with repository access can decode the values. Sealed Secrets solves this by encrypting secrets with a cluster-specific key, producing a `SealedSecret` CRD that is safe to commit to Git. This guide covers the full production workflow: installation, encryption, key rotation, multi-cluster patterns, and the architectural trade-offs between Sealed Secrets and External Secrets Operator.

<!--more-->

## The Problem with Secrets in GitOps

GitOps requires all cluster state to be expressed as YAML in a Git repository. This creates an immediate tension with secrets management: the canonical GitOps workflow demands that secret values live in Git, but secret values are sensitive by definition.

Common misapproaches:
- **Plain base64 Secrets in Git**: Anyone with repo read access can `echo <value> | base64 -d` to recover the plaintext
- **Secrets excluded from Git**: Breaks the GitOps principle; secrets require out-of-band management
- **Helm values with vault-agent injection**: Adds operational complexity that Sealed Secrets avoids

Sealed Secrets provides asymmetric encryption: the public key is used to seal (encrypt) secrets, and only the private key held by the controller in the cluster can unseal them. Even with full Git access, an attacker cannot decrypt the sealed values.

## Architecture

The Sealed Secrets system has two components:

1. **Controller**: Runs in the cluster, holds the private key, watches for `SealedSecret` CRDs, and creates corresponding `Secret` objects
2. **kubeseal CLI**: A client-side tool that uses the cluster's public key to encrypt secrets before committing to Git

Encryption workflow:
```
Developer creates Secret YAML
  → kubeseal fetches cluster public key
    → kubeseal encrypts secret data with public key
      → SealedSecret YAML is committed to Git
        → ArgoCD/Flux syncs SealedSecret to cluster
          → Controller decrypts with private key
            → Controller creates Kubernetes Secret
```

The private key never leaves the cluster. Git repositories only contain sealed (encrypted) values.

## Installation

### Helm Installation

```bash
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version 2.16.0 \
  --set fullnameOverride=sealed-secrets-controller \
  --set image.pullPolicy=IfNotPresent \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=64Mi \
  --set resources.limits.cpu=200m \
  --set resources.limits.memory=128Mi
```

### Installing kubeseal CLI

```bash
# Linux (amd64)
KUBESEAL_VERSION=0.27.0
curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
tar -xvzf "kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz" kubeseal
install -m 755 kubeseal /usr/local/bin/kubeseal

# macOS (Apple Silicon)
brew install kubeseal

# Verify
kubeseal --version
```

### Verify Controller is Running

```bash
kubectl get pods -n kube-system -l app.kubernetes.io/name=sealed-secrets
kubectl logs -n kube-system -l app.kubernetes.io/name=sealed-secrets --tail=20
```

Expected output includes:
```
{"level":"info","msg":"Starting sealed-secrets controller","version":"v0.27.0"}
{"level":"info","msg":"Key generation complete: sealed-secrets-key..."}
```

## Creating Sealed Secrets

### Basic Workflow

```bash
# 1. Create a standard Kubernetes Secret (never commit this to Git)
kubectl create secret generic db-credentials \
  --from-literal=host=postgres.production.svc.cluster.local \
  --from-literal=port=5432 \
  --from-literal=database=appdb \
  --from-literal=username=appuser \
  --from-literal=password=S3cur3P@ssw0rd! \
  --namespace production \
  --dry-run=client \
  -o yaml > /tmp/db-credentials.yaml

# 2. Seal the secret (safe to commit)
kubeseal \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  --format=yaml \
  < /tmp/db-credentials.yaml \
  > kubernetes/production/db-credentials-sealed.yaml

# 3. Verify the sealed secret was created correctly
cat kubernetes/production/db-credentials-sealed.yaml

# 4. Clean up the plain secret (never commit this)
rm /tmp/db-credentials.yaml

# 5. Commit the sealed secret
git add kubernetes/production/db-credentials-sealed.yaml
git commit -m "feat: add database credentials sealed secret"
```

### Sealed Secret Structure

The output YAML:

```yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  creationTimestamp: null
  name: db-credentials
  namespace: production
spec:
  encryptedData:
    database: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEq... (truncated)
    host: AgAJt9gxG2ULu5sGrRSJ4Vn8oB3+DkRw... (truncated)
    password: AgCj7T3MNQkL9nrFe2PwDqUaVmMbXYh... (truncated)
    port: AgBt3kKqH4GmLpD7rXsNy2QwBvCdF9Jn... (truncated)
    username: AgD4fLmKqP2tXsHy7nVgBrQwCjMeDa... (truncated)
  template:
    metadata:
      creationTimestamp: null
      name: db-credentials
      namespace: production
    type: Opaque
```

### Sealing from Existing Secret

```bash
# Seal from an existing Secret in the cluster
kubectl get secret db-credentials -n production -o yaml | \
  kubeseal --format yaml > db-credentials-sealed.yaml
```

### Sealing with Certificate File (CI/CD Pipelines)

In CI/CD pipelines, kubeseal cannot connect to the cluster. Instead, use the public certificate:

```bash
# Fetch the public certificate (run once, store in repo)
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  > sealed-secrets-public-cert.pem

# Seal using the certificate (no cluster access required)
kubeseal \
  --cert sealed-secrets-public-cert.pem \
  --format yaml \
  < /tmp/secret.yaml \
  > sealed-secret.yaml
```

Store `sealed-secrets-public-cert.pem` in the repository. It is public and contains no sensitive information.

### CI/CD Integration

GitHub Actions workflow for sealing secrets in pipelines:

```yaml
name: Seal and Commit Secret

on:
  workflow_dispatch:
    inputs:
      secret_name:
        description: 'Secret name'
        required: true
      namespace:
        description: 'Target namespace'
        required: true
        default: 'production'

jobs:
  seal-secret:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install kubeseal
        run: |
          KUBESEAL_VERSION=0.27.0
          curl -OL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
          tar -xvzf "kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz" kubeseal
          sudo install -m 755 kubeseal /usr/local/bin/kubeseal

      - name: Create and seal secret
        env:
          SECRET_VALUE: ${{ secrets.NEW_SECRET_VALUE }}
        run: |
          # Create the plain secret YAML in memory
          kubectl create secret generic "${{ inputs.secret_name }}" \
            --from-literal=value="${SECRET_VALUE}" \
            --namespace "${{ inputs.namespace }}" \
            --dry-run=client -o yaml | \
          kubeseal \
            --cert ./deploy/sealed-secrets-public-cert.pem \
            --format yaml \
            > "./kubernetes/${{ inputs.namespace }}/${{ inputs.secret_name }}-sealed.yaml"

      - name: Commit sealed secret
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add "./kubernetes/${{ inputs.namespace }}/"
          git commit -m "chore: seal ${{ inputs.secret_name }} for ${{ inputs.namespace }}"
          git push
```

## Scoping and Secret Binding

By default, sealed secrets are bound to both a specific namespace and a specific secret name. This prevents a sealed secret from being reused in different contexts.

### Scope Options

```bash
# Strict (default): bound to name AND namespace
# Cannot be renamed or moved to another namespace
kubeseal --scope strict ...

# Namespace-wide: bound to namespace only
# Secret can be renamed within the namespace
kubeseal --scope namespace-wide ...

# Cluster-wide: not bound to name or namespace
# WARNING: Anyone with the sealed secret can deploy it anywhere
# Only use for bootstrap secrets
kubeseal --scope cluster-wide ...
```

### When to Use Each Scope

```yaml
# Strict scope (default) - appropriate for most production secrets
# The SealedSecret MUST be deployed as "db-credentials" in "production"
metadata:
  name: db-credentials
  namespace: production
  annotations:
    sealedsecrets.bitnami.com/cluster-wide: "false"   # strict
    sealedsecrets.bitnami.com/namespace-wide: "false"  # strict

---
# Cluster-wide scope - bootstrap secrets that may be deployed to multiple namespaces
# Use sparingly: a leaked SealedSecret can be deployed anywhere
metadata:
  name: registry-pull-secret
  annotations:
    sealedsecrets.bitnami.com/cluster-wide: "true"
```

## Key Rotation

The sealed-secrets controller automatically generates new keys on a schedule. Understanding key rotation is critical for production operations.

### Default Key Rotation Behavior

By default:
- A new key is generated every 30 days
- Old keys are **retained** for decryption of existing sealed secrets
- New sealed secrets are encrypted with the current (newest) key
- Existing sealed secrets continue to work with old keys

```bash
# List all keys
kubectl get secrets -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  --sort-by='.metadata.creationTimestamp'

NAME                           TYPE     DATA   AGE
sealed-secrets-key20240101     Opaque   2      180d
sealed-secrets-key20240201     Opaque   2      150d
sealed-secrets-key20240301     Opaque   2      120d
sealed-secrets-key20240401     Opaque   2       90d  # current
```

### Manual Key Rotation

```bash
# Trigger immediate key rotation
kubectl annotate secret \
  -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  sealedsecrets.bitnami.com/rotate-now=true

# Verify new key was generated
kubectl get secrets -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key
```

### Re-sealing After Key Rotation

After key rotation, existing sealed secrets still work (old keys are retained), but it is best practice to re-seal them with the new key:

```bash
#!/bin/bash
# re-seal-all.sh: Re-seal all secrets in the repository with the current key

CERT_FILE="./deploy/sealed-secrets-public-cert.pem"
SEALED_SECRETS_DIR="./kubernetes"

# Refresh the public certificate
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  > "${CERT_FILE}"

# Find all SealedSecret files
find "${SEALED_SECRETS_DIR}" -name "*-sealed.yaml" | while read -r file; do
    echo "Re-sealing: ${file}"

    # Extract the original secret from the cluster
    name=$(yq e '.metadata.name' "${file}")
    namespace=$(yq e '.metadata.namespace' "${file}")

    # Get the decrypted secret from the cluster and re-seal
    kubectl get secret "${name}" -n "${namespace}" -o yaml | \
      kubeseal \
        --cert "${CERT_FILE}" \
        --format yaml \
        > "${file}.new"

    mv "${file}.new" "${file}"
done

git add "${SEALED_SECRETS_DIR}"
git commit -m "chore: re-seal all secrets after key rotation"
```

### Configuring Key Rotation Schedule

```yaml
# In Helm values
keyRotationPeriod: "720h"  # 30 days (default)
# keyRotationPeriod: "0"  # Disable automatic rotation (not recommended for prod)
```

### Backup and Recovery of Sealing Keys

The controller's private keys must be backed up. Loss of the private key makes all sealed secrets permanently unrecoverable.

```bash
# Export all sealing keys (store securely, not in Git)
kubectl get secret \
  -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o yaml > sealed-secrets-keys-backup.yaml

# Encrypt the backup with GPG before storing
gpg --symmetric --cipher-algo AES256 sealed-secrets-keys-backup.yaml
rm sealed-secrets-keys-backup.yaml  # Remove plaintext

# Store the encrypted backup in:
# - AWS Secrets Manager
# - HashiCorp Vault
# - Offline secure storage
```

### Restoring Keys (Disaster Recovery)

```bash
# Decrypt the backup
gpg --decrypt sealed-secrets-keys-backup.yaml.gpg > sealed-secrets-keys-backup.yaml

# Restore keys to a new cluster
kubectl apply -f sealed-secrets-keys-backup.yaml

# Restart the controller to load the restored keys
kubectl rollout restart deployment/sealed-secrets-controller -n kube-system
```

## Multi-Cluster Secret Management

In multi-cluster environments, each cluster has its own sealing key. A secret sealed for cluster A cannot be decrypted by cluster B.

### Strategy 1: Per-Cluster Sealed Secrets

Maintain separate sealed secrets for each cluster:

```
├── kubernetes/
│   ├── clusters/
│   │   ├── prod-us-east-1/
│   │   │   ├── secrets/
│   │   │   │   └── db-credentials-sealed.yaml  # sealed for prod-us-east-1
│   │   │   └── cert.pem
│   │   ├── prod-eu-west-1/
│   │   │   ├── secrets/
│   │   │   │   └── db-credentials-sealed.yaml  # sealed for prod-eu-west-1
│   │   │   └── cert.pem
│   │   └── staging/
│   │       ├── secrets/
│   │       │   └── db-credentials-sealed.yaml  # sealed for staging
│   │       └── cert.pem
```

Automation for multi-cluster sealing:

```bash
#!/bin/bash
# multi-cluster-seal.sh: Seal a secret for all clusters

SECRET_FILE="$1"
SECRET_NAME=$(yq e '.metadata.name' "${SECRET_FILE}")
NAMESPACE=$(yq e '.metadata.namespace' "${SECRET_FILE}")

CLUSTERS=(prod-us-east-1 prod-eu-west-1 staging)

for cluster in "${CLUSTERS[@]}"; do
    cert="./kubernetes/clusters/${cluster}/cert.pem"
    output="./kubernetes/clusters/${cluster}/secrets/${SECRET_NAME}-sealed.yaml"

    kubeseal \
      --cert "${cert}" \
      --namespace "${NAMESPACE}" \
      --format yaml \
      < "${SECRET_FILE}" \
      > "${output}"

    echo "Sealed for ${cluster}: ${output}"
done
```

### Strategy 2: Shared Sealing Key (Not Recommended)

Some organizations synchronize a single sealing key across clusters to simplify management. This is not recommended because:
- Key compromise affects all clusters simultaneously
- Violates the principle of blast radius containment
- Makes key rotation more complex

### ArgoCD ApplicationSet with Per-Cluster Secrets

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: app-secrets
  namespace: argocd
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            environment: production
  template:
    metadata:
      name: "{{name}}-secrets"
    spec:
      project: production
      source:
        repoURL: https://github.com/example-org/gitops-repo
        targetRevision: main
        path: "kubernetes/clusters/{{name}}/secrets"
      destination:
        server: "{{server}}"
        namespace: production
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

## Sealed Secrets vs. External Secrets Operator

Both tools solve secrets-in-GitOps but with fundamentally different approaches.

### Sealed Secrets

**Approach**: Encryption at the Git layer. Secrets are encrypted before being stored in Git and decrypted in the cluster.

**Pros**:
- Fully offline: no external secret store required
- Simple architecture: one controller, one CRD
- GitOps-native: sealed secrets are real Kubernetes resources
- Works in air-gapped environments

**Cons**:
- Secret rotation requires re-sealing and committing to Git
- Per-cluster keys: multi-cluster management requires multiple sealed secrets for the same value
- No central secret store: difficult to audit who has access to which secrets
- Key backup/recovery is a manual operational burden

### External Secrets Operator (ESO)

**Approach**: Reference-based. Git stores references to secrets (not values), and ESO fetches the actual values from an external secret store (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, etc.).

**Pros**:
- Centralized secret management with existing enterprise workflows
- Native rotation: secret updates in the store propagate to the cluster automatically
- Rich access controls via IAM/Vault policies
- Audit trail in the secret store

**Cons**:
- External dependency: if the secret store is unavailable, new Pods cannot start
- More complex architecture: requires secret store setup and maintenance
- Not fully GitOps-native: actual values live outside Git

### Decision Matrix

| Requirement | Sealed Secrets | ESO |
|-------------|---------------|-----|
| Air-gapped cluster | Yes | No |
| Centralized secret rotation | No | Yes |
| Enterprise audit trail | No | Yes |
| Single cluster | Excellent | Good |
| Multi-cluster (same secret) | Complex | Simple |
| Existing Vault/AWS SM investment | Redundant | Native |
| Bootstrap secrets | Yes | Chicken-and-egg problem |

**Recommendation**: Use Sealed Secrets for bootstrapping (the secrets needed to connect ESO to Vault/AWS SM) and ESO for application secrets in multi-cluster or enterprise environments.

### Hybrid Approach

```yaml
# 1. SealedSecret stores the AWS credentials needed to bootstrap ESO
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: eso-aws-credentials
  namespace: external-secrets
spec:
  encryptedData:
    access-key-id: AgCj7T3MNQkL9nrFe2PwDq...
    secret-access-key: AgD4fLmKqP2tXsHy7nVgBr...

---
# 2. ESO SecretStore uses the bootstrapped credentials
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        secretRef:
          accessKeyIDSecretRef:
            name: eso-aws-credentials
            namespace: external-secrets
            key: access-key-id
          secretAccessKeySecretRef:
            name: eso-aws-credentials
            namespace: external-secrets
            key: secret-access-key

---
# 3. Application ExternalSecret references AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: db-credentials
  data:
    - secretKey: password
      remoteRef:
        key: prod/app/db
        property: password
```

## Security Best Practices

### Protecting the Repository

Even with encryption, sealed secrets repositories require access controls:

```bash
# .gitignore: never commit plain secrets
*.plain.yaml
*-plain.yaml
*-secret.yaml  # Add exceptions for SealedSecrets explicitly
!*-sealed.yaml
.env
.env.*
credentials/
secrets/plain/
```

### Pre-commit Hooks

Prevent accidentally committing plain secrets:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.4
    hooks:
      - id: gitleaks
        name: Detect hardcoded secrets

  - repo: local
    hooks:
      - id: no-plain-secrets
        name: Prevent plain Kubernetes Secrets
        language: pygrep
        entry: "kind: Secret"
        types: [yaml]
        # Allow SealedSecrets but not plain Secrets
        exclude: ".*-sealed\\.yaml$"
        pass_filenames: true
```

### RBAC for SealedSecret Management

```yaml
# Allow CI/CD to apply SealedSecrets but not read plain Secrets
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sealed-secrets-manager
rules:
  - apiGroups: ["bitnami.com"]
    resources: ["sealedsecrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Explicitly NO access to core/secrets
  # The controller creates Secrets internally from SealedSecrets
```

### Namespace Isolation

Sealed secrets are namespace-scoped by default. Verify the controller RBAC:

```bash
# The controller should only be able to manage secrets in specific namespaces
# Check what the controller can do
kubectl auth can-i get secrets --all-namespaces \
  --as=system:serviceaccount:kube-system:sealed-secrets-controller
```

### Auditing Sealed Secret Access

```bash
# Who has unsealed (read) which secrets
kubectl get events -n production \
  --field-selector reason=Unsealed

# Controller logs show all unseal operations
kubectl logs -n kube-system \
  -l app.kubernetes.io/name=sealed-secrets \
  | grep "Unsealed"
```

## Troubleshooting

### "Error decrypting key" After Controller Restart

```bash
# Check if the controller has all sealing keys
kubectl get secrets -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key

# If keys are missing, restore from backup
kubectl apply -f sealed-secrets-keys-backup.yaml
kubectl rollout restart deployment/sealed-secrets-controller -n kube-system
```

### "no key could decrypt secret" Error

This occurs when a SealedSecret was created with a key that no longer exists in the cluster:

```bash
# Check which key was used to seal the secret
kubectl describe sealedsecret db-credentials -n production
# Look for: "Conditions: ... Message: error decrypting key"

# Solution: re-seal with current key (requires access to plaintext values)
kubectl get secret db-credentials -n production -o yaml | \
  kubeseal --format yaml > db-credentials-sealed.yaml
```

### SealedSecret Not Reconciling

```bash
# Check controller logs for the specific secret
kubectl logs -n kube-system \
  -l app.kubernetes.io/name=sealed-secrets \
  | grep "db-credentials"

# Check the SealedSecret status
kubectl describe sealedsecret db-credentials -n production

# Verify the namespace in the SealedSecret matches the deployment namespace
yq e '.metadata.namespace' db-credentials-sealed.yaml
```

### Certificate Mismatch in CI/CD

```bash
# Verify the cert.pem matches the current cluster key
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  | diff - ./deploy/sealed-secrets-public-cert.pem

# If different, update the cert in the repository
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  > ./deploy/sealed-secrets-public-cert.pem
git add ./deploy/sealed-secrets-public-cert.pem
git commit -m "chore: update sealed secrets public certificate"
```

## Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: sealed-secrets-alerts
  namespace: kube-system
spec:
  groups:
    - name: sealed-secrets
      rules:
        - alert: SealedSecretDecryptionError
          expr: |
            increase(sealed_secrets_controller_error_count[5m]) > 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "SealedSecret decryption errors detected"
            description: "{{ $value }} decryption errors in the last 5 minutes"

        - alert: SealedSecretKeyExpiringSoon
          expr: |
            (sealed_secrets_controller_keyring_next_rotation_timestamp_seconds - time()) < 86400
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Sealed Secrets key rotating within 24 hours"
```

Sealed Secrets provides a practical, proven approach to GitOps-native secrets management that works in any environment, including air-gapped clusters. Combined with strong access controls, pre-commit hooks, and regular key rotation, it enables teams to maintain the full GitOps workflow without exposing sensitive values in version control.
