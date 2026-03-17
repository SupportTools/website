---
title: "GitOps Security: Signed Commits, SOPS Encryption, and Policy Gates in Flux/ArgoCD"
date: 2028-04-13T00:00:00-05:00
draft: false
tags: ["GitOps", "Security", "SOPS", "ArgoCD", "Flux", "Signed Commits"]
categories: ["GitOps", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to GitOps security covering GPG commit signing, SOPS secret encryption with age and KMS, policy gates in Flux and ArgoCD, and supply chain security for Kubernetes deployments."
more_link: "yes"
url: "/gitops-security-signed-commits-guide/"
---

GitOps brings powerful automation to Kubernetes deployments, but it also creates new attack surfaces: the Git repository becomes the source of truth for cluster state, making it a high-value target. This guide covers the full GitOps security stack — signed commits to verify authorship, SOPS encryption to protect secrets in Git, and policy gates in Flux and ArgoCD to prevent unauthorized changes from reaching production.

<!--more-->

# GitOps Security: Signed Commits, SOPS Encryption, and Policy Gates in Flux/ArgoCD

## The GitOps Threat Model

Before implementing security controls, understand what you're protecting against:

1. **Unauthorized changes**: Someone pushes malicious configuration directly to the main branch
2. **Secret exposure**: Kubernetes secrets committed to Git in plaintext are readable by everyone with repo access
3. **Compromised CI/CD**: A compromised pipeline injects malicious resources before deployment
4. **Drift detection bypass**: Changes made directly to the cluster (kubectl apply) that bypass Git
5. **Supply chain attacks**: Malicious container images or Helm charts introduced via dependency updates

Each requires different controls. This guide addresses all five.

## GPG/SSH Commit Signing

Signed commits provide cryptographic proof that a specific GPG key was used to create a commit. Combined with branch protection rules, this ensures only authorized individuals can merge code to protected branches.

### Setting Up GPG Signing

```bash
# Generate a GPG key (use ed25519 for modern systems)
gpg --full-generate-key
# Select: (9) ECC and ECC, (1) Curve 25519, key never expires

# List your keys
gpg --list-secret-keys --keyid-format=long

# Output:
# sec   ed25519/3AA5C34371567BD2 2024-01-15 [SC]
#       1F72F6A4C4A8C3D2B1E0F1234567890ABCDEF012
# uid                 [ultimate] Jane Doe <jane@example.com>
# ssb   cv25519/4BB6D45482678CE3 2024-01-15 [E]

# Export the public key to add to GitHub/GitLab
gpg --armor --export 3AA5C34371567BD2

# Configure git to sign commits
git config --global user.signingkey 3AA5C34371567BD2
git config --global commit.gpgsign true
git config --global gpg.program gpg

# Verify signing works
echo "test" | gpg --clearsign
```

### SSH Key Signing (GitHub's Preferred Method)

```bash
# Generate signing SSH key (separate from authentication key)
ssh-keygen -t ed25519 -C "jane@example.com" -f ~/.ssh/signing_key

# Configure git to use SSH for signing
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/signing_key.pub
git config --global commit.gpgsign true

# Add the public key to GitHub as a "Signing Key"
# (distinct from Authentication Key)
cat ~/.ssh/signing_key.pub

# Create an allowed_signers file for local verification
echo "jane@example.com $(cat ~/.ssh/signing_key.pub)" >> ~/.ssh/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers

# Verify a signed commit
git verify-commit HEAD
```

### GitHub Branch Protection with Required Signatures

```bash
# Using GitHub CLI
gh api repos/myorg/gitops-config/branches/main/protection \
    --method PUT \
    --field required_signatures=true \
    --field enforce_admins=true \
    --field required_status_checks='{"strict":true,"contexts":["policy-check","lint"]}' \
    --field required_pull_request_reviews='{"required_approving_review_count":2,"dismiss_stale_reviews":true}'

# Verify protection is active
gh api repos/myorg/gitops-config/branches/main/protection \
    --jq '.required_signatures.enabled'
```

### Enforcing Signed Commits in Flux

```yaml
# Flux GitRepository with commit verification
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: gitops-config
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/myorg/gitops-config
  ref:
    branch: main
  # Verify all commits are signed with an allowed key
  verify:
    mode: head  # Verify the latest commit
    secretRef:
      name: allowed-gpg-keys
---
# Secret containing allowed public keys
apiVersion: v1
kind: Secret
metadata:
  name: allowed-gpg-keys
  namespace: flux-system
type: Opaque
stringData:
  # Export format: gpg --armor --export KEY_ID
  jane.pub: |
    -----BEGIN PGP PUBLIC KEY BLOCK-----
    [GPG public key content]
    -----END PGP PUBLIC KEY BLOCK-----
  bob.pub: |
    -----BEGIN PGP PUBLIC KEY BLOCK-----
    [GPG public key content]
    -----END PGP PUBLIC KEY BLOCK-----
```

## SOPS: Encrypting Secrets in Git

SOPS (Secrets OPerationS) encrypts YAML/JSON files in place, leaving structure visible but values encrypted. This enables storing secrets in Git without exposing plaintext values.

### Setting Up SOPS with age

`age` is the modern replacement for GPG for SOPS encryption — simpler key management, no key server needed.

```bash
# Install age and sops
brew install age sops  # macOS
# or: apt-get install age && curl -L https://github.com/getsops/sops/releases/latest/download/sops_linux_amd64 -o /usr/local/bin/sops && chmod +x /usr/local/bin/sops

# Generate age key pair
age-keygen -o ~/.config/sops/age/keys.txt

# Output:
# Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
# Save this public key — it's safe to share

# View your keys
cat ~/.config/sops/age/keys.txt
```

### SOPS Configuration File

```yaml
# .sops.yaml — place in repository root
creation_rules:
  # Production secrets: encrypt with multiple keys (KMS + age for redundancy)
  - path_regex: "clusters/production/.*\.yaml$"
    encrypted_regex: "^(data|stringData)$"
    age: >-
      age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p,
      age1abc123...  # Second key for backup access
    kms:
    - arn: arn:aws:kms:us-east-1:123456789012:key/mrk-abc123
      aws_profile: production

  # Staging secrets: age key only
  - path_regex: "clusters/staging/.*\.yaml$"
    encrypted_regex: "^(data|stringData)$"
    age: age1staging-key-here

  # Development: less strict
  - path_regex: "clusters/dev/.*\.yaml$"
    encrypted_regex: "^(data|stringData)$"
    age: age1dev-key-here
```

### Encrypting Kubernetes Secrets

```bash
# Create a secret YAML file
cat > clusters/production/secrets/database-credentials.yaml << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: database-credentials
  namespace: team-payments
type: Opaque
stringData:
  host: "postgres-primary.db.internal"
  port: "5432"
  username: "payments_user"
  password: "super-secret-password-here"
  database: "payments_production"
EOF

# Encrypt with SOPS
sops --encrypt --in-place clusters/production/secrets/database-credentials.yaml

# The encrypted file looks like:
cat clusters/production/secrets/database-credentials.yaml
# apiVersion: v1
# kind: Secret
# metadata:
#   name: database-credentials
# ...
# stringData:
#   host: ENC[AES256_GCM,data:XY...==,tag:AB...==,type:str]
#   password: ENC[AES256_GCM,data:PQ...==,tag:CD...==,type:str]
# sops:
#   age:
#     - recipient: age1ql3z...
#       enc: |
#         -----BEGIN AGE ENCRYPTED FILE-----
#         ...

# Edit encrypted file (decrypts in editor, re-encrypts on save)
sops clusters/production/secrets/database-credentials.yaml

# Decrypt to stdout (for inspection)
sops --decrypt clusters/production/secrets/database-credentials.yaml

# Decrypt to file
sops --decrypt clusters/production/secrets/database-credentials.yaml \
    > /tmp/decrypted-secret.yaml
```

### SOPS with AWS KMS

```bash
# Create KMS key
aws kms create-key \
    --description "GitOps SOPS encryption key" \
    --key-usage ENCRYPT_DECRYPT \
    --key-spec SYMMETRIC_DEFAULT

# Create an alias
aws kms create-alias \
    --alias-name alias/gitops-sops \
    --target-key-id mrk-abc123

# Configure SOPS to use KMS
export SOPS_KMS_ARN="arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
sops --encrypt --kms $SOPS_KMS_ARN secret.yaml

# Create IAM policy for CI/CD access
cat > sops-ci-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"
    }
  ]
}
EOF
```

## Flux with SOPS Decryption

```bash
# Create the age key secret for Flux
kubectl create secret generic sops-age \
    --namespace=flux-system \
    --from-file=age.agekey=~/.config/sops/age/keys.txt

# Or for KMS: Flux uses the pod's IAM role via IRSA
# Configure IRSA for the flux-system service account
```

```yaml
# flux-system/kustomization.yaml — decrypt secrets before applying
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-secrets
  namespace: flux-system
spec:
  interval: 10m
  path: ./clusters/production/secrets
  prune: true
  sourceRef:
    kind: GitRepository
    name: gitops-config
  # Decryption configuration
  decryption:
    provider: sops
    secretRef:
      name: sops-age  # Secret containing the age private key
  # Health checks
  healthChecks:
  - apiVersion: v1
    kind: Secret
    name: database-credentials
    namespace: team-payments
```

## ArgoCD with SOPS: Using argocd-vault-plugin

For ArgoCD, use the `argocd-vault-plugin` or Helm secrets plugin:

```bash
# Install argocd-vault-plugin
# https://argocd-vault-plugin.readthedocs.io/

# ConfigMap for AVP configuration
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cmp-cm
  namespace: argocd
data:
  sops.yaml: |
    apiVersion: argoproj.io/v1alpha1
    kind: ConfigManagementPlugin
    metadata:
      name: sops
    spec:
      generate:
        command: [sh, -c]
        args: ['find . -name "*.yaml" -exec sops --decrypt {} \;']
EOF
```

```yaml
# ArgoCD Application with SOPS plugin
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-secrets
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://github.com/myorg/gitops-config
    targetRevision: main
    path: clusters/production/secrets
    plugin:
      name: sops
  destination:
    server: https://kubernetes.default.svc
    namespace: team-payments
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Policy Gates: Preventing Unauthorized Changes

### Flux Image Policy with Signing Verification

```yaml
# Require container images to be signed with Cosign
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: payment-service-policy
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: payment-service
  filterTags:
    pattern: '^[0-9]+\.[0-9]+\.[0-9]+$'
    extract: '$major.$minor.$patch'
  policy:
    semver:
      range: '>=1.0.0'
```

### ArgoCD AppProject with Resource Restrictions

```yaml
# AppProject restricts what resources ArgoCD can deploy
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production
  namespace: argocd
spec:
  description: "Production environment"

  # Allowed source repositories
  sourceRepos:
  - "https://github.com/myorg/gitops-config"
  - "https://charts.bitnami.com/bitnami"
  # Deny all others
  sourceNamespaces:
  - "argocd"

  # Allowed destinations
  destinations:
  - namespace: "team-*"
    server: https://kubernetes.default.svc
  # Deny cluster-level resources from non-system projects
  - namespace: "kube-system"
    server: "https://kubernetes.default.svc"

  # Cluster-scoped resource whitelist
  clusterResourceWhitelist:
  - group: ""
    kind: Namespace
  - group: "rbac.authorization.k8s.io"
    kind: ClusterRole
  - group: "rbac.authorization.k8s.io"
    kind: ClusterRoleBinding

  # Namespace-scoped resource blacklist (deny these)
  namespaceResourceBlacklist:
  - group: ""
    kind: ResourceQuota  # Teams cannot change their own quota
  - group: "networking.k8s.io"
    kind: NetworkPolicy  # Only platform team manages NetworkPolicies
  - group: "policy"
    kind: PodDisruptionBudget

  # Roles within the project
  roles:
  - name: developer
    description: "Read-only access for developers"
    policies:
    - p, proj:production:developer, applications, get, production/*, allow
    - p, proj:production:developer, applications, sync, production/*, deny
    groups:
    - "github:myorg:developers"

  - name: deployer
    description: "Can sync but not create applications"
    policies:
    - p, proj:production:deployer, applications, *, production/*, allow
    - p, proj:production:deployer, projects, *, *, deny
    groups:
    - "github:myorg:deployers"
```

### Admission Webhooks as a Policy Gate

```yaml
# OPA Gatekeeper constraint: require images from approved registries
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: allow-approved-registries
spec:
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaceSelector:
      matchLabels:
        managed-by: platform-team
  parameters:
    repos:
    - "registry.example.com/"           # Internal registry
    - "public.ecr.aws/myorg/"           # Approved ECR public
    - "ghcr.io/myorg/"                  # GitHub Container Registry
```

```yaml
# Kyverno policy: require image digest for pinned deployments
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-image-digest
spec:
  validationFailureAction: enforce
  background: false
  rules:
  - name: require-digest
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaceSelector:
            matchLabels:
              environment: production
    validate:
      message: "Production pods must use image digests (sha256:...) not mutable tags"
      foreach:
      - list: "request.object.spec.containers"
        deny:
          conditions:
            any:
            - key: "{{ element.image }}"
              operator: NotContains
              value: "@sha256:"
```

## Supply Chain Security with Sigstore/Cosign

```bash
# Sign container images with Cosign
cosign sign --key cosign.key \
    registry.example.com/payment-service@sha256:abc123...

# Verify image signature
cosign verify \
    --key cosign.pub \
    registry.example.com/payment-service:v1.2.3

# Generate SBOM (Software Bill of Materials)
cosign attest \
    --predicate sbom.json \
    --type cyclonedx \
    --key cosign.key \
    registry.example.com/payment-service@sha256:abc123...

# Verify SBOM attestation
cosign verify-attestation \
    --key cosign.pub \
    --type cyclonedx \
    registry.example.com/payment-service:v1.2.3
```

### Flux Image Verification with Cosign

```yaml
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: payment-service
  namespace: flux-system
spec:
  image: registry.example.com/payment-service
  interval: 1m
  provider: aws
  # Verify image signatures
  verify:
    provider: cosign
    secretRef:
      name: cosign-public-key
---
apiVersion: v1
kind: Secret
metadata:
  name: cosign-public-key
  namespace: flux-system
type: Opaque
data:
  # base64-encoded cosign public key
  cosign.pub: <base64-encoded-public-key>
```

## Git Repository Security Configuration

```bash
#!/bin/bash
# harden-gitops-repo.sh
# Apply security settings to a GitHub repository

REPO="myorg/gitops-config"

# Enable branch protection
gh api "repos/$REPO/branches/main/protection" \
    --method PUT \
    --raw-field '
{
  "required_signatures": true,
  "enforce_admins": true,
  "required_status_checks": {
    "strict": true,
    "contexts": ["sops-lint", "policy-check", "yamllint", "kubeconform"]
  },
  "required_pull_request_reviews": {
    "required_approving_review_count": 2,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": true
  },
  "restrictions": {
    "users": [],
    "teams": ["gitops-deployers"],
    "apps": ["github-actions"]
  },
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "lock_branch": false
}'

echo "Branch protection configured for $REPO/main"

# Enable secret scanning
gh api "repos/$REPO" \
    --method PATCH \
    --field security_and_analysis.secret_scanning.status=enabled \
    --field security_and_analysis.secret_scanning_push_protection.status=enabled

echo "Secret scanning enabled for $REPO"
```

## CI/CD Pipeline Security Gates

```yaml
# .github/workflows/gitops-validate.yaml
name: GitOps Security Validation

on:
  pull_request:
    branches: [main]

jobs:
  sops-lint:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
      with:
        # Ensure GPG verification is available
        ref: ${{ github.head_ref }}

    - name: Verify commit signatures
      run: |
        # Check all commits in PR are signed
        for commit in $(git log origin/main..HEAD --format="%H"); do
          if ! git verify-commit "$commit" 2>/dev/null; then
            echo "ERROR: Commit $commit is not signed"
            exit 1
          fi
          echo "PASS: Commit $commit is signed"
        done

    - name: Check for unencrypted secrets
      run: |
        # Scan for SOPS-managed files that are not encrypted
        find clusters/ -name "*.yaml" | while read file; do
          if grep -q "kind: Secret" "$file"; then
            if ! grep -q "^sops:" "$file"; then
              echo "ERROR: $file contains unencrypted Secret"
              exit 1
            fi
          fi
        done
        echo "All secrets are encrypted"

    - name: Validate SOPS encryption
      uses: getsops/sops-validate-action@v1
      with:
        file_pattern: "clusters/**/*.yaml"

  kubeconform:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Validate Kubernetes manifests
      run: |
        # Install kubeconform
        curl -Lo kubeconform.tar.gz https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz
        tar xzf kubeconform.tar.gz

        # Validate all non-secret YAML files
        find clusters/ -name "*.yaml" \
            ! -name "*secret*" \
            -exec ./kubeconform \
                -kubernetes-version 1.29.0 \
                -schema-location default \
                -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
                -strict \
                {} +

  policy-gates:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Run OPA policy checks
      run: |
        # Install OPA
        curl -Lo /usr/local/bin/opa https://github.com/open-policy-agent/opa/releases/latest/download/opa_linux_amd64
        chmod +x /usr/local/bin/opa

        # Run policies against changed manifests
        git diff --name-only origin/main..HEAD | \
            grep "\.yaml$" | \
            xargs -I{} opa eval \
                --data policies/ \
                --input {} \
                "data.gitops.deny" \
                --fail-defined
```

## Detecting Drift: ArgoCD and Flux

```yaml
# Flux alert for any out-of-sync resources
apiVersion: notification.toolkit.fluxcd.io/v1beta3
kind: Alert
metadata:
  name: drift-detected
  namespace: flux-system
spec:
  providerRef:
    name: slack
  eventSeverity: error
  eventSources:
  - kind: Kustomization
    name: "*"
  - kind: HelmRelease
    name: "*"
  inclusionList:
  - ".*drift.*"
  - ".*not ready.*"
  - ".*failed.*"
---
# ArgoCD Application with immediate self-heal
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  syncPolicy:
    automated:
      prune: true       # Remove resources deleted from Git
      selfHeal: true    # Revert manual changes to cluster
      allowEmpty: false # Prevent accidentally deleting everything
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

## Security Audit Script

```bash
#!/bin/bash
# gitops-security-audit.sh

REPO_PATH="${1:-.}"
echo "=== GitOps Security Audit ==="
echo "Repository: $REPO_PATH"
echo ""

ISSUES=0

# Check 1: Unencrypted secrets
echo "--- Checking for unencrypted secrets ---"
while IFS= read -r file; do
    if grep -q "kind: Secret" "$file" 2>/dev/null; then
        if ! grep -q "^sops:" "$file" 2>/dev/null; then
            echo "[FAIL] Unencrypted secret: $file"
            ((ISSUES++))
        else
            echo "[PASS] Encrypted: $file"
        fi
    fi
done < <(find "$REPO_PATH" -name "*.yaml" -not -path "*/.git/*")

echo ""

# Check 2: Hardcoded credentials patterns
echo "--- Scanning for credential patterns ---"
PATTERNS=(
    'password:\s*[^${}"\x27][^\s]+'
    'token:\s*[^${}"\x27][^\s]+'
    'api_key:\s*[^${}"\x27][^\s]+'
)

for pattern in "${PATTERNS[@]}"; do
    matches=$(grep -rn --include="*.yaml" -E "$pattern" "$REPO_PATH" 2>/dev/null | grep -v "^.*\.git/")
    if [ -n "$matches" ]; then
        echo "[WARN] Possible credential pattern found:"
        echo "$matches"
        ((ISSUES++))
    fi
done

echo ""

# Check 3: Image tags vs digests
echo "--- Checking for mutable image tags in production ---"
grep -rn "image:" "$REPO_PATH/clusters/production" 2>/dev/null | \
    grep -v "@sha256:" | \
    grep -v "^.*\.git/" | \
    while read line; do
        echo "[WARN] Mutable tag in production: $line"
        ((ISSUES++))
    done

echo ""
echo "=== Audit complete: $ISSUES issues found ==="
[ "$ISSUES" -eq 0 ] && exit 0 || exit 1
```

## Conclusion

GitOps security is a layered discipline. Signed commits establish identity and intent. SOPS encryption enables secrets to live alongside code without plaintext exposure. AppProject policies in ArgoCD and Kustomization access controls in Flux prevent privilege escalation through the GitOps pipeline. Admission webhooks enforce policy at the cluster admission layer as a final defense. Supply chain security with Cosign ensures deployed images come from trusted build processes. Together, these controls implement defense-in-depth for GitOps-managed Kubernetes infrastructure, ensuring that the automation that powers your deployments does not become a security liability.
