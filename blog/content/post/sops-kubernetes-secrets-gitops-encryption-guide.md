---
title: "SOPS: Encrypting Kubernetes Secrets for GitOps Workflows"
date: 2027-01-03T00:00:00-05:00
draft: false
tags: ["SOPS", "Kubernetes", "GitOps", "Secrets", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Mozilla SOPS for encrypting Kubernetes secrets and Helm values in Git using AWS KMS, GCP KMS, and Age encryption with Flux and ArgoCD integration."
more_link: "yes"
url: "/sops-kubernetes-secrets-gitops-encryption-guide/"
---

GitOps workflows require storing all Kubernetes configuration in Git, but Kubernetes Secrets contain sensitive values that must never appear in plaintext in a repository. The common workarounds — storing secrets outside Git entirely, using placeholder values replaced by a CI pipeline, or relying on cluster-side operators that pull from external vaults — all introduce operational complexity and synchronization risks. **Mozilla SOPS** (Secrets OPerationS) takes a different approach: encrypt the secret values in-place within the YAML file, committing encrypted ciphertext directly to Git while keeping the file structure intact for review and diffing.

SOPS integrates with multiple key management systems (**AWS KMS**, **GCP KMS**, **Azure Key Vault**, **HashiCorp Vault**, and **Age**) through a pluggable provider model. The encryption is partial: only the values in a YAML file are encrypted, leaving keys, comments, and structure visible. This means code reviewers can see that a `DATABASE_PASSWORD` key was added without seeing the password itself, and Git history tracks when secrets were rotated.

This guide covers Age key management for team-based workflows, KMS integration for cloud-hosted keys, `.sops.yaml` creation rules for automated encryption, and full integration patterns for both Flux and ArgoCD GitOps controllers.

<!--more-->

## SOPS vs Sealed Secrets vs External Secrets

Understanding where SOPS fits requires comparing it to the two dominant alternatives:

**Sealed Secrets** (Bitnami) encrypts Kubernetes Secret objects using a cluster-specific key pair. The `kubeseal` CLI produces a `SealedSecret` custom resource that only the specific cluster can decrypt. This approach is simple but has significant limitations: secrets are bound to a single cluster (cross-cluster promotion requires re-sealing), the encryption key lives in the cluster (lost cluster = lost ability to decrypt archived secrets), and the controller must be running to decrypt.

**External Secrets Operator** (ESO) does not store encrypted values in Git at all — it stores references to secrets in an external store (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager) and the operator synchronizes the values into Kubernetes Secrets at runtime. ESO is excellent for secrets with dynamic values or complex rotation requirements but adds an external dependency (the secrets store must be available when pods start) and requires all secrets to exist in the external store before deployment.

**SOPS** occupies the middle ground: secrets are stored in Git (close to the code that uses them, reviewable, auditable) but encrypted with keys managed externally. The decryption key provider (KMS, Age) is the only external dependency, and it is only needed during deployment, not at runtime. SOPS is ideal for infrastructure-as-code workflows where the secret should follow the configuration.

| Feature | SOPS | Sealed Secrets | External Secrets |
|---|---|---|---|
| Secrets stored in Git | Yes (encrypted) | Yes (encrypted) | No (references only) |
| Cross-cluster promotion | Yes | Requires re-sealing | Yes |
| Offline capability | With Age keys | No | No |
| Runtime dependency | None | Sealed Secrets controller | ESO + secret store |
| Key rotation | Per-file re-encrypt | Cluster key rotation | Secret store native |
| Secret value review | Not possible (encrypted) | Not possible | In external store |

## Age Key Generation and Management

**Age** is a modern, simple encryption tool designed as a replacement for GPG. Unlike GPG, Age has no concept of key servers, expiry dates, or complex trust models — a key is simply a keypair, and possession of the private key is sufficient to decrypt.

Install Age and SOPS:

```bash
# Install Age
curl -Lo age.tar.gz https://github.com/FiloSottile/age/releases/download/v1.1.1/age-v1.1.1-linux-amd64.tar.gz
tar xf age.tar.gz
sudo mv age/age age/age-keygen /usr/local/bin/

# Install SOPS
curl -Lo sops https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
chmod +x sops
sudo mv sops /usr/local/bin/
```

Generate a team key for a specific environment. Store private keys in a secrets manager, not in Git:

```bash
# Generate the production encryption key
age-keygen -o /tmp/prod-sops.key

# Output example:
# Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
# The file /tmp/prod-sops.key contains the private key — store in AWS Secrets Manager

# Store the private key in AWS Secrets Manager
aws secretsmanager create-secret \
  --name "sops/prod/age-key" \
  --description "Age private key for SOPS encryption in production" \
  --secret-string "$(cat /tmp/prod-sops.key)" \
  --region us-east-1

# Remove local copy of private key
shred -u /tmp/prod-sops.key
```

For team workflows, use multiple Age recipient keys so that any team member with their own Age key can decrypt:

```bash
# Generate per-engineer keys (each engineer runs this locally)
age-keygen -o ~/.config/sops/age/keys.txt

# Display the public key to share with team
age-keygen -y ~/.config/sops/age/keys.txt
# Output: age1abc...xyz (share this public key, not the private key)
```

The SOPS Age environment variable controls which key is used for decryption:

```bash
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
# Or directly:
export SOPS_AGE_KEY="AGE-SECRET-KEY-1ABCDEF..."
```

## AWS KMS and GCP KMS Key Setup

For production environments, cloud KMS provides hardware-backed key storage with IAM-controlled access, audit logging, and automatic key rotation.

### AWS KMS Setup

```bash
# Create a dedicated KMS key for SOPS
aws kms create-key \
  --description "SOPS encryption key for Kubernetes secrets" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --region us-east-1

# Note the KeyId from the output, e.g.: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123

# Create an alias for easier reference
aws kms create-alias \
  --alias-name alias/sops-prod-k8s \
  --target-key-id arn:aws:kms:us-east-1:123456789012:key/mrk-abc123

# Grant decrypt access to the CI/CD IAM role and the GitOps controller role
aws kms create-grant \
  --key-id arn:aws:kms:us-east-1:123456789012:key/mrk-abc123 \
  --grantee-principal arn:aws:iam::123456789012:role/flux-kustomize-controller \
  --operations Decrypt GenerateDataKey
```

Attach the following IAM policy to any role that needs to encrypt or decrypt:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey"
      ],
      "Resource": "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
    }
  ]
}
```

### GCP KMS Setup

```bash
# Create keyring and key
gcloud kms keyrings create sops-k8s-prod \
  --location us-central1

gcloud kms keys create sops-encryption-key \
  --keyring sops-k8s-prod \
  --location us-central1 \
  --purpose encryption \
  --rotation-period 365d \
  --next-rotation-time "2028-01-01T00:00:00Z"

# Grant Cloud KMS CryptoKey Encrypter/Decrypter role to the GKE workload identity
gcloud kms keys add-iam-policy-binding sops-encryption-key \
  --keyring sops-k8s-prod \
  --location us-central1 \
  --member "serviceAccount:flux-kustomize-controller@my-project.iam.gserviceaccount.com" \
  --role roles/cloudkms.cryptoKeyEncrypterDecrypter
```

## .sops.yaml Creation Rules

The `.sops.yaml` file defines rules that map file patterns to encryption keys. This file lives at the root of the Git repository and controls which key is used when SOPS encrypts a file matching each pattern.

```yaml
# .sops.yaml
creation_rules:
  # Production secrets: use AWS KMS (primary) with Age fallback for offline operations
  - path_regex: environments/production/.*\.yaml$
    kms: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
    age: >-
      age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p,
      age1y8m84wz5e3r4k6j2n9hvgfe3dc5bpq7xlwa0s6t8mn9r7ekj4v2szu8qdy
    encrypted_regex: "^(data|stringData)$"

  # Staging secrets: use a separate KMS key
  - path_regex: environments/staging/.*\.yaml$
    kms: arn:aws:kms:us-east-1:123456789012:key/mrk-def456
    age: >-
      age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
    encrypted_regex: "^(data|stringData)$"

  # Helm values files: encrypt all top-level values that contain sensitive keys
  - path_regex: environments/.*/helm-values-secrets\.yaml$
    kms: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
    encrypted_regex: "^(password|token|secret|key|credential|apiKey|connectionString)$"

  # Development: Age-only encryption with all developer public keys
  - path_regex: environments/development/.*\.yaml$
    age: >-
      age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p,
      age1abc123def456ghi789jkl012mno345pqr678stu901vwx234yza567bcd890e,
      age1xyz987wvu654tsr321qpo098nml765kji432hgf109edc876baz543yxw210v
    encrypted_regex: "^(data|stringData)$"
```

The `encrypted_regex` field is critical — it restricts encryption to specific YAML keys, leaving structural keys like `apiVersion`, `kind`, and `metadata.name` in plaintext. This allows Git diffs to show meaningful change summaries.

## Encrypting Kubernetes Secrets

Create a plaintext secret file for encryption. Never commit this plaintext file to Git — only the encrypted version should be committed:

```yaml
# /tmp/database-credentials.yaml (plaintext — DO NOT COMMIT)
apiVersion: v1
kind: Secret
metadata:
  name: database-credentials
  namespace: order-service
type: Opaque
stringData:
  DB_HOST: postgres-primary.database.svc.cluster.local
  DB_PORT: "5432"
  DB_NAME: orders
  DB_USER: orders_app
  DB_PASSWORD: "xK9#mP2$vQ7nL4@wR6"
  DB_SSL_MODE: require
  DATABASE_URL: "postgresql://orders_app:xK9#mP2$vQ7nL4@wR6@postgres-primary.database.svc.cluster.local:5432/orders?sslmode=require"
```

Encrypt the file in place:

```bash
# Encrypt using rules from .sops.yaml (production path)
sops --encrypt /tmp/database-credentials.yaml \
  > environments/production/database-credentials.yaml

# Verify the output — only stringData values should be encrypted
cat environments/production/database-credentials.yaml
```

The resulting encrypted file looks like:

```yaml
# environments/production/database-credentials.yaml (safe to commit)
apiVersion: v1
kind: Secret
metadata:
    name: database-credentials
    namespace: order-service
type: Opaque
stringData:
    DB_HOST: ENC[AES256_GCM,data:8mK2...base64...,tag:abc123==,type:str]
    DB_PORT: ENC[AES256_GCM,data:Xm3p...,tag:def456==,type:str]
    DB_NAME: ENC[AES256_GCM,data:Kp9q...,tag:ghi789==,type:str]
    DB_USER: ENC[AES256_GCM,data:Nw7r...,tag:jkl012==,type:str]
    DB_PASSWORD: ENC[AES256_GCM,data:Vb5s...,tag:mno345==,type:str]
    DB_SSL_MODE: ENC[AES256_GCM,data:Qd4t...,tag:pqr678==,type:str]
    DATABASE_URL: ENC[AES256_GCM,data:Hy6u...,tag:stu901==,type:str]
sops:
    kms:
        - arn: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
          created_at: "2027-01-03T10:00:00Z"
          enc: AQICAHh...
          aws_profile: ""
    age:
        - recipient: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
          enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
            YWdlLWVuY3J5cHRpb24...
            -----END AGE ENCRYPTED FILE-----
    lastmodified: "2027-01-03T10:00:00Z"
    mac: ENC[AES256_GCM,data:MacValue==,tag:MacTag==,type:str]
    version: 3.8.1
```

Decrypt for editing:

```bash
# Edit in place (opens $EDITOR with decrypted content, re-encrypts on save)
sops environments/production/database-credentials.yaml

# Decrypt to stdout for inspection
sops --decrypt environments/production/database-credentials.yaml

# Decrypt a specific key
sops --decrypt --extract '["stringData"]["DB_PASSWORD"]' \
  environments/production/database-credentials.yaml
```

## Encrypting Helm Values Files

For Helm charts, maintain two values files: a non-sensitive `helm-values.yaml` committed in plaintext and a `helm-values-secrets.yaml` committed encrypted:

```yaml
# environments/production/helm-values-secrets.yaml (plaintext before encryption)
postgresql:
  password: "xK9#mP2$vQ7nL4@wR6"
  replicationPassword: "hT3&jN8*kM5pL9@qS7"

redis:
  password: "wB6^cF4!dG2eH1#iJ0"

jwt:
  secret: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."

stripe:
  apiKey: "sk_live_EXAMPLE_REPLACE_WITH_REAL_KEY"
  webhookSecret: "whsec_EXAMPLE_REPLACE_WITH_REAL_SECRET"
```

Encrypt with the helm-values-specific rule from `.sops.yaml`:

```bash
sops --encrypt environments/production/helm-values-secrets.yaml \
  > environments/production/helm-values-secrets.enc.yaml

# Move encrypted file to correct location
mv environments/production/helm-values-secrets.enc.yaml \
   environments/production/helm-values-secrets.yaml
```

When deploying with Helm outside of GitOps (e.g., from a CI pipeline), decrypt and merge:

```bash
# Decrypt secrets to a temporary file and merge with base values
sops --decrypt environments/production/helm-values-secrets.yaml \
  > /tmp/helm-secrets-decrypted.yaml

helm upgrade --install order-service ./charts/order-service \
  --namespace order-service \
  --values environments/production/helm-values.yaml \
  --values /tmp/helm-secrets-decrypted.yaml \
  --wait

# Always clean up decrypted files
shred -u /tmp/helm-secrets-decrypted.yaml
```

The `helm-secrets` plugin automates this workflow:

```bash
helm plugin install https://github.com/jkroepke/helm-secrets

# Use directly in helm commands
helm secrets upgrade --install order-service ./charts/order-service \
  --namespace order-service \
  --values environments/production/helm-values.yaml \
  --values sops://environments/production/helm-values-secrets.yaml
```

## Flux SOPS Decryption Controller

Flux's `kustomize-controller` has native SOPS support. Configure it by creating a Kubernetes Secret containing the decryption key and referencing it in the `Kustomization` resource.

### Age Key for Flux

```bash
# Export the Age private key to the cluster as a Kubernetes Secret
kubectl create secret generic sops-age-key \
  --namespace flux-system \
  --from-file=age.agekey=/tmp/prod-sops.key

# Verify
kubectl describe secret sops-age-key -n flux-system
```

Reference the decryption secret in the Flux Kustomization:

```yaml
# flux-kustomization-production.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-secrets
  namespace: flux-system
spec:
  interval: 10m
  path: ./environments/production
  prune: true
  sourceRef:
    kind: GitRepository
    name: cluster-config
  decryption:
    provider: sops
    secretRef:
      name: sops-age-key
  timeout: 5m
  wait: true
```

### AWS KMS for Flux via IRSA

For KMS-encrypted secrets, configure IRSA so the Flux controller authenticates to KMS using its Kubernetes service account:

```bash
# Annotate the Flux kustomize-controller service account with the IRSA role
kubectl annotate serviceaccount kustomize-controller \
  --namespace flux-system \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/flux-kustomize-controller

# Restart the controller to pick up the annotation
kubectl rollout restart deployment kustomize-controller -n flux-system
```

The IAM role `flux-kustomize-controller` must have the KMS policy from the earlier section. With IRSA configured, no `secretRef` is needed in the Kustomization for KMS — Flux uses the ambient AWS credentials:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-secrets
  namespace: flux-system
spec:
  interval: 10m
  path: ./environments/production
  prune: true
  sourceRef:
    kind: GitRepository
    name: cluster-config
  decryption:
    provider: sops
    # No secretRef needed when using IRSA — ambient AWS credentials handle KMS
  timeout: 5m
```

## ArgoCD with SOPS Plugin

ArgoCD does not have native SOPS support, but the **argocd-vault-plugin** supports SOPS as one of its backends. An alternative is a custom Config Management Plugin (CMP) that runs `sops --decrypt` as part of the manifest generation pipeline.

Configure a CMP as a sidecar in the ArgoCD repo-server:

```yaml
# argocd-repo-server-sops-patch.yaml
# Patch for argocd-repo-server to add SOPS CMP sidecar
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-repo-server
  namespace: argocd
spec:
  template:
    spec:
      volumes:
        - name: sops-age-key
          secret:
            secretName: sops-age-key
        - name: custom-tools
          emptyDir: {}
      initContainers:
        - name: download-sops
          image: alpine:3.19
          command:
            - sh
            - -c
            - |
              wget -qO /custom-tools/sops \
                https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
              chmod +x /custom-tools/sops
          volumeMounts:
            - name: custom-tools
              mountPath: /custom-tools
      containers:
        - name: sops-plugin
          image: alpine:3.19
          command: [/var/run/argocd/argocd-cmp-server]
          env:
            - name: SOPS_AGE_KEY_FILE
              value: /sops-keys/age.agekey
          volumeMounts:
            - name: var-files
              mountPath: /var/run/argocd
            - name: plugins
              mountPath: /home/argocd/cmp-server/plugins
            - name: sops-age-key
              mountPath: /sops-keys
              readOnly: true
            - name: custom-tools
              mountPath: /usr/local/bin
            - name: cmp-tmp
              mountPath: /tmp
          securityContext:
            runAsNonRoot: true
            runAsUser: 999
        - name: argocd-repo-server
          # Existing container — no changes needed
```

Create the CMP plugin configuration:

```yaml
# argocd-cmp-sops-plugin.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmp-cm
  namespace: argocd
data:
  plugin.yaml: |
    apiVersion: argoproj.io/v1alpha1
    kind: ConfigManagementPlugin
    metadata:
      name: sops-kustomize
    spec:
      version: v1.0
      init:
        command: [sh, -c]
        args:
          - |
            find . -name "*.yaml" -o -name "*.yml" | \
            xargs grep -l "ENC\[AES256_GCM" 2>/dev/null | \
            while read f; do
              sops --decrypt "$f" > "${f}.dec" && mv "${f}.dec" "$f"
            done
      generate:
        command: [kustomize, build, .]
      discover:
        find:
          glob: "**/kustomization.yaml"
```

Reference the plugin in the ArgoCD Application:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: order-service-production
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://github.com/example-org/cluster-config.git
    targetRevision: main
    path: environments/production/order-service
    plugin:
      name: sops-kustomize
  destination:
    server: https://kubernetes.default.svc
    namespace: order-service
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Key Rotation Procedures

Key rotation requires re-encrypting all files that use the old key. SOPS provides the `updatekeys` command for this:

```bash
# Step 1: Generate new Age key
age-keygen -o /tmp/new-prod-sops.key
NEW_PUBLIC_KEY=$(age-keygen -y /tmp/new-prod-sops.key)

# Step 2: Update .sops.yaml to add the new key alongside the old key
# (Both keys should be present during the transition period)
# Edit .sops.yaml to add the new age recipient

# Step 3: Re-encrypt all matching files with both old and new keys
find environments/production -name "*.yaml" | while read f; do
  if sops --decrypt "$f" > /dev/null 2>&1; then
    sops updatekeys "$f" --yes
    echo "Updated: $f"
  fi
done

# Step 4: Commit the re-encrypted files
git add environments/production/
git commit -m "chore: rotate SOPS Age key for production (add new key)"
git push

# Step 5: After deploying and confirming new key works, remove the old key
# Edit .sops.yaml to remove the old age recipient, then repeat step 3

# Step 6: Update the cluster secret with the new private key
kubectl create secret generic sops-age-key \
  --namespace flux-system \
  --from-file=age.agekey=/tmp/new-prod-sops.key \
  --dry-run=client -o yaml | kubectl apply -f -

# Step 7: Remove local copy of new private key
shred -u /tmp/new-prod-sops.key
```

## CI/CD Integration

In GitHub Actions, store the SOPS Age private key as a repository secret and use it to validate that all encrypted files are decryptable before merging:

```yaml
# .github/workflows/validate-secrets.yaml
name: Validate SOPS Encrypted Secrets

on:
  pull_request:
    paths:
      - 'environments/**/*.yaml'

jobs:
  validate-sops:
    name: Validate SOPS Encryption
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Install SOPS
        run: |
          curl -Lo /usr/local/bin/sops \
            https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
          chmod +x /usr/local/bin/sops

      - name: Configure Age key
        env:
          SOPS_AGE_KEY: ${{ secrets.SOPS_AGE_PRIVATE_KEY }}
        run: |
          mkdir -p ~/.config/sops/age
          echo "$SOPS_AGE_KEY" > ~/.config/sops/age/keys.txt

      - name: Find and validate all SOPS-encrypted files
        run: |
          FAILED=0
          while IFS= read -r file; do
            if grep -q 'ENC\[AES256_GCM' "$file" 2>/dev/null; then
              if sops --decrypt "$file" > /dev/null 2>&1; then
                echo "OK: $file"
              else
                echo "FAIL: $file could not be decrypted"
                FAILED=1
              fi
            fi
          done < <(find environments -name "*.yaml" -type f)
          exit $FAILED

      - name: Verify no plaintext secrets in unencrypted files
        run: |
          # Check that files NOT encrypted by SOPS don't contain common secret patterns
          # (Adjust patterns to match your naming conventions)
          find environments -name "*.yaml" -type f | while read f; do
            if ! grep -q 'sops:' "$f" 2>/dev/null; then
              if grep -qE '(password|secret|token|apikey|api_key)\s*:\s*["\x27]?[A-Za-z0-9+/]{16,}' "$f" 2>/dev/null; then
                echo "WARNING: Potential plaintext secret in $f"
              fi
            fi
          done
```

## Multi-Cluster and Multi-Environment Patterns

Enterprise environments typically have multiple clusters (dev, staging, production) and multiple regions. SOPS supports this through per-environment key configurations in `.sops.yaml` and environment-specific key rotation policies.

### Directory Structure for Multi-Environment GitOps

A well-organized repository structure makes SOPS rules deterministic:

```
cluster-config/
├── .sops.yaml                          # Root creation rules
├── environments/
│   ├── development/
│   │   ├── kustomization.yaml
│   │   ├── order-service/
│   │   │   └── database-secret.yaml    # Age-encrypted, dev key
│   ├── staging/
│   │   ├── kustomization.yaml
│   │   ├── order-service/
│   │   │   └── database-secret.yaml    # KMS-encrypted, staging key
│   └── production/
│       ├── kustomization.yaml
│       ├── order-service/
│       │   └── database-secret.yaml    # KMS-encrypted, prod key
├── base/
│   └── order-service/
│       ├── deployment.yaml             # Not encrypted
│       └── service.yaml                # Not encrypted
```

Each environment uses a separate KMS key or Age key, so compromise of the development encryption key does not expose production secrets. The `.sops.yaml` rules enforce this automatically by matching on path:

```yaml
# .sops.yaml (root of repository)
creation_rules:
  - path_regex: environments/production/.*
    kms: arn:aws:kms:us-east-1:123456789012:key/mrk-prod-abc123
    encrypted_regex: "^(data|stringData)$"

  - path_regex: environments/staging/.*
    kms: arn:aws:kms:us-east-1:123456789012:key/mrk-staging-def456
    encrypted_regex: "^(data|stringData)$"

  - path_regex: environments/development/.*
    age: age1devkey...
    encrypted_regex: "^(data|stringData)$"
```

### Promoting Secrets Between Environments

Promoting a secret from staging to production requires re-encrypting with the production key, since staging-encrypted values cannot be decrypted in production:

```bash
#!/usr/bin/env bash
# promote-secret.sh — promote a SOPS-encrypted secret from staging to production

set -euo pipefail

SECRET_PATH="$1"   # e.g., environments/staging/order-service/database-secret.yaml
TARGET_ENV="production"

# Derive the target path
TARGET_PATH="${SECRET_PATH/staging/$TARGET_ENV}"

# Decrypt the staging secret
DECRYPTED=$(sops --decrypt "$SECRET_PATH")

# Create the target directory if it doesn't exist
mkdir -p "$(dirname "$TARGET_PATH")"

# Write the decrypted content to the target path (will be encrypted by .sops.yaml rules)
echo "$DECRYPTED" > /tmp/promote-secret-tmp.yaml

# Re-encrypt with the production key (rules from .sops.yaml apply based on path)
sops --encrypt /tmp/promote-secret-tmp.yaml > "$TARGET_PATH"

# Clean up
shred -u /tmp/promote-secret-tmp.yaml

echo "Promoted: $SECRET_PATH -> $TARGET_PATH"
echo "Review the diff before committing:"
git diff "$TARGET_PATH" 2>/dev/null || echo "(new file)"
```

### Secret Inventory and Auditing

Maintain a machine-readable inventory of all encrypted secrets and their key ARNs for compliance auditing:

```bash
#!/usr/bin/env bash
# audit-sops-inventory.sh — generate an inventory of all SOPS-encrypted files

set -euo pipefail

echo "File,Environment,KeyType,KeyID,LastModified,Controls"

find environments -name "*.yaml" -type f | sort | while read -r file; do
  if grep -q 'sops:' "$file" 2>/dev/null; then
    env=$(echo "$file" | cut -d'/' -f2)
    last_modified=$(sops --output-type json --decrypt "$file" 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); \
                  print(d.get('sops',{}).get('lastmodified','unknown'))" 2>/dev/null || \
      echo "unknown")

    # Extract key type and ID from the sops metadata block
    key_info=$(grep -A5 'kms:' "$file" 2>/dev/null | \
               grep 'arn:' | \
               head -1 | \
               sed 's/.*arn:/arn:/' | \
               tr -d ' ' || echo "age")

    echo "$file,$env,kms,$key_info,$last_modified,NSA-CISA-SC28"
  fi
done
```

## Conclusion

SOPS provides a pragmatic balance between security and operational simplicity for GitOps workflows. Key takeaways from this guide:

- Use Age keys for team-based encryption where cloud KMS is unavailable or offline operation is needed; use AWS KMS or GCP KMS in CI/CD and GitOps controllers where cloud IAM provides access control without key distribution
- The `.sops.yaml` creation rules file is the central policy document — ensure it is reviewed carefully as it determines which keys can encrypt and decrypt secrets for each environment
- The `encrypted_regex` field should restrict encryption to value fields only (`data`, `stringData`), leaving structural YAML keys in plaintext for meaningful Git diffs
- Flux's native SOPS support via `kustomize-controller` is the simplest integration; ArgoCD requires a CMP sidecar but provides equivalent functionality
- Key rotation should follow a two-phase approach: add the new key while the old key is still active, re-encrypt all files, deploy and verify, then remove the old key — never remove a key before all files are re-encrypted with the new key
