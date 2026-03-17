---
title: "Kubernetes Helm Secrets and SOPS: Encrypted Values in GitOps Workflows"
date: 2030-10-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Helm", "SOPS", "GitOps", "Secrets Management", "ArgoCD", "AWS KMS", "Security"]
categories:
- Kubernetes
- Security
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise secrets-in-Helm guide: SOPS encryption with AWS KMS, GCP KMS, and age keys, helm-secrets plugin workflow, encrypted values in CI/CD pipelines, ArgoCD integration, and migrating from unencrypted secrets."
more_link: "yes"
url: "/kubernetes-helm-secrets-sops-encrypted-values-gitops/"
---

Storing Kubernetes secrets in Git is a fundamental tension in GitOps workflows: the model requires all desired state to live in a Git repository, but secrets in plaintext expose credentials to anyone with repository access. SOPS (Secrets OPerationS) with Helm Secrets resolves this by encrypting secret values using key management services or age keys, enabling encrypted secrets to be committed to Git while remaining usable by CI/CD pipelines that hold decryption keys.

<!--more-->

## SOPS Architecture

SOPS encrypts individual values within YAML, JSON, ENV, and INI files while preserving the key names in plaintext. This allows diff review of structure changes without exposing secret values.

```yaml
# Before encryption (plaintext values.yaml)
database:
  password: my-database-password-here
  replication_password: replication-secret-here

redis:
  password: redis-auth-token-here

api:
  jwt_secret: jwt-signing-key-here
  oauth_client_secret: oauth-secret-here
```

```yaml
# After SOPS encryption (safe to commit to Git)
database:
    password: ENC[AES256_GCM,data:abcXYZ123==,iv:AAAA,tag:BBBB,type:str]
    replication_password: ENC[AES256_GCM,data:defXYZ456==,iv:CCCC,tag:DDDD,type:str]

redis:
    password: ENC[AES256_GCM,data:ghiXYZ789==,iv:EEEE,tag:FFFF,type:str]

api:
    jwt_secret: ENC[AES256_GCM,data:jklXYZ012==,iv:GGGG,tag:HHHH,type:str]
    oauth_client_secret: ENC[AES256_GCM,data:mnoXYZ345==,iv:IIII,tag:JJJJ,type:str]

sops:
    kms:
    -   arn: arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012
        created_at: '2030-10-18T12:00:00Z'
        enc: AQICAHi...
        aws_profile: ""
    gcp_kms:
    -   resource_id: projects/my-project/locations/us-east1/keyRings/my-keyring/cryptoKeys/my-key
        created_at: '2030-10-18T12:00:00Z'
        enc: CiQA...
    age:
    -   recipient: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
        enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
            YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSA...
            -----END AGE ENCRYPTED FILE-----
    lastmodified: '2030-10-18T12:00:00Z'
    mac: ENC[AES256_GCM,data:MAC_VALUE==,iv:MMMM,tag:NNNN,type:str]
    version: 3.9.0
```

## Key Management Setup

### AWS KMS Configuration

```bash
# Create a KMS key for SOPS (via AWS CLI)
aws kms create-key \
  --description "SOPS encryption key for Kubernetes secrets" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=Purpose,TagValue=sops-secrets \
         TagKey=Environment,TagValue=production

# Capture the key ARN
KEY_ARN=$(aws kms describe-key \
  --key-id "$(aws kms list-aliases --query 'Aliases[?AliasName==`alias/sops-production`].TargetKeyId' --output text)" \
  --query 'KeyMetadata.Arn' \
  --output text)

# Create a key alias for easier reference
aws kms create-alias \
  --alias-name alias/sops-production \
  --target-key-id "$KEY_ARN"

# Grant access to CI/CD role
aws kms create-grant \
  --key-id "$KEY_ARN" \
  --grantee-principal "arn:aws:iam::123456789012:role/github-actions-role" \
  --operations Decrypt GenerateDataKey

# Grant access to ArgoCD service account role
aws kms create-grant \
  --key-id "$KEY_ARN" \
  --grantee-principal "arn:aws:iam::123456789012:role/argocd-server-role" \
  --operations Decrypt
```

### GCP KMS Configuration

```bash
# Create GCP KMS keyring and key
gcloud kms keyrings create sops-production \
  --location us-east1

gcloud kms keys create sops-key \
  --keyring sops-production \
  --location us-east1 \
  --purpose encryption

GCP_KEY_ID="projects/my-project/locations/us-east1/keyRings/sops-production/cryptoKeys/sops-key"

# Grant CI/CD service account access
gcloud kms keys add-iam-policy-binding sops-key \
  --keyring sops-production \
  --location us-east1 \
  --member "serviceAccount:github-actions@my-project.iam.gserviceaccount.com" \
  --role "roles/cloudkms.cryptoKeyEncrypterDecrypter"
```

### Age Key Generation

```bash
# Install age
wget https://github.com/FiloSottile/age/releases/download/v1.2.0/age-v1.2.0-linux-amd64.tar.gz
tar xzf age-v1.2.0-linux-amd64.tar.gz
install -m 755 age/age age/age-keygen /usr/local/bin/

# Generate a key pair
age-keygen -o ~/.config/sops/age/keys.txt
# Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p

# For CI/CD: store the private key in CI secrets
# For team sharing: each developer generates their own age key
# and all public keys are added to .sops.yaml

# The keys.txt format:
# # created: 2030-10-18T12:00:00Z
# # public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
# AGE-SECRET-KEY-1...
```

## SOPS Configuration File

The `.sops.yaml` file in the repository root configures which keys are used for which files:

```yaml
# .sops.yaml
creation_rules:
  # Production secrets - require all key providers for redundancy
  - path_regex: environments/production/.*secrets.*\.yaml$
    kms: arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012
    gcp_kms: projects/my-project/locations/us-east1/keyRings/sops-production/cryptoKeys/sops-key
    age: >-
      age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p,
      age1mz9kx27ypzy4twsd9tuku9atmkx2m8qgqyylpxnxcn9xqp678mgqvxkm7l
    # Only encrypt values, not keys
    encrypted_regex: '^(password|secret|key|token|credential|cert|privateKey|clientSecret)$'

  # Staging secrets - AWS KMS only
  - path_regex: environments/staging/.*secrets.*\.yaml$
    kms: arn:aws:kms:us-east-1:123456789012:key/aaaabbbb-aaaa-bbbb-cccc-ddddeeeeffffgggg
    encrypted_regex: '^(password|secret|key|token|credential|cert|privateKey|clientSecret)$'

  # Development - age key only (no cloud KMS needed for dev)
  - path_regex: environments/dev/.*secrets.*\.yaml$
    age: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
    encrypted_regex: '^(password|secret|key|token|credential|cert|privateKey|clientSecret)$'

  # Default: catch-all for any missed files
  - kms: arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012
    encrypted_regex: '^(password|secret|key|token|credential|cert|privateKey|clientSecret)$'
```

## helm-secrets Plugin

### Installation

```bash
# Install helm-secrets plugin
helm plugin install https://github.com/jkroepke/helm-secrets --version v4.6.0

# Install SOPS binary
wget https://github.com/getsops/sops/releases/download/v3.9.0/sops-v3.9.0.linux.amd64
install -m 755 sops-v3.9.0.linux.amd64 /usr/local/bin/sops

# Verify installation
helm secrets version
sops --version
```

### Directory Structure

```
helm-charts/
├── .sops.yaml                           # SOPS key configuration
├── payment-service/
│   ├── Chart.yaml
│   ├── values.yaml                      # Non-secret defaults
│   └── templates/
│       ├── deployment.yaml
│       └── secret.yaml
└── environments/
    ├── production/
    │   ├── values.yaml                  # Non-secret prod overrides
    │   └── secrets.yaml                 # SOPS-encrypted secrets
    ├── staging/
    │   ├── values.yaml
    │   └── secrets.yaml
    └── dev/
        ├── values.yaml
        └── secrets.yaml
```

### Working with Encrypted Files

```bash
# Create a new secrets file
cat > /tmp/secrets-plaintext.yaml << 'EOF'
database:
  password: "my-secure-db-password-2030"
  replication_password: "repl-password-secure"

redis:
  password: "redis-auth-token-secret"

api:
  jwt_secret: "jwt-signing-key-256-bits"
  oauth_client_secret: "oauth-client-secret-value"

tls:
  # Note: Use placeholders like these in docs, actual values in the real file
  certificate: "<base64-encoded-tls-certificate>"
  private_key: "<base64-encoded-private-key>"
EOF

# Encrypt the file (SOPS reads .sops.yaml for key selection)
sops --encrypt /tmp/secrets-plaintext.yaml > environments/production/secrets.yaml
rm /tmp/secrets-plaintext.yaml  # Remove plaintext immediately

# Edit an encrypted file in-place (decrypts, opens editor, re-encrypts)
sops environments/production/secrets.yaml

# View decrypted content without persisting to disk
sops --decrypt environments/production/secrets.yaml

# Rotate encryption keys (re-encrypt with current .sops.yaml)
sops updatekeys environments/production/secrets.yaml

# Add a new key to an existing encrypted file
sops --rotate \
  --add-age age1newpublickey123... \
  environments/production/secrets.yaml
```

### Deploying with helm-secrets

```bash
# Deploy using helm-secrets (automatically decrypts secrets.yaml)
helm secrets upgrade --install payment-service ./helm-charts/payment-service \
  --namespace production \
  --create-namespace \
  -f ./helm-charts/payment-service/values.yaml \
  -f ./environments/production/values.yaml \
  -f ./environments/production/secrets.yaml  # Automatically decrypted by plugin

# Multiple secret files
helm secrets upgrade --install payment-service ./helm-charts/payment-service \
  -f values.yaml \
  -f environments/production/values.yaml \
  -f environments/production/secrets.yaml \
  -f environments/production/tls-secrets.yaml

# Diff changes before applying
helm secrets diff upgrade payment-service ./helm-charts/payment-service \
  -f values.yaml \
  -f environments/production/values.yaml \
  -f environments/production/secrets.yaml
```

## CI/CD Pipeline Integration

### GitHub Actions

```yaml
# .github/workflows/deploy.yaml
name: Deploy to Production

on:
  push:
    branches: [main]
    paths:
    - 'helm-charts/**'
    - 'environments/**'

permissions:
  id-token: write   # Required for OIDC auth to AWS
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-22.04
    environment: production

    steps:
    - uses: actions/checkout@v4

    - name: Configure AWS credentials via OIDC
      uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: arn:aws:iam::123456789012:role/github-actions-deploy
        aws-region: us-east-1

    - name: Install tools
      run: |
        # Install SOPS
        wget -qO /usr/local/bin/sops \
          https://github.com/getsops/sops/releases/download/v3.9.0/sops-v3.9.0.linux.amd64
        chmod +x /usr/local/bin/sops

        # Install Helm
        curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

        # Install helm-secrets plugin
        helm plugin install \
          https://github.com/jkroepke/helm-secrets \
          --version v4.6.0

    - name: Configure kubectl
      uses: azure/setup-kubectl@v3

    - name: Configure kubeconfig
      run: |
        aws eks update-kubeconfig \
          --region us-east-1 \
          --name production-cluster

    - name: Validate encrypted secrets
      run: |
        # Verify SOPS can decrypt secrets with the CI role
        sops --decrypt environments/production/secrets.yaml > /dev/null
        echo "Secrets decryption validated"

    - name: Lint Helm chart
      run: |
        # Lint with decrypted secrets
        helm secrets lint ./helm-charts/payment-service \
          -f ./environments/production/values.yaml \
          -f ./environments/production/secrets.yaml

    - name: Deploy
      run: |
        helm secrets upgrade --install payment-service \
          ./helm-charts/payment-service \
          --namespace production \
          --create-namespace \
          --atomic \
          --timeout 10m \
          -f ./helm-charts/payment-service/values.yaml \
          -f ./environments/production/values.yaml \
          -f ./environments/production/secrets.yaml

    - name: Verify deployment
      run: |
        kubectl rollout status deployment/payment-service \
          -n production \
          --timeout=5m
```

### GitLab CI

```yaml
# .gitlab-ci.yml
variables:
  HELM_SECRETS_VERSION: "4.6.0"
  SOPS_VERSION: "3.9.0"

stages:
  - validate
  - deploy

.base:
  image: alpine/helm:3.15.0
  before_script:
    # Install SOPS
    - wget -qO /usr/local/bin/sops
        "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64"
    - chmod +x /usr/local/bin/sops
    # Install helm-secrets
    - helm plugin install
        https://github.com/jkroepke/helm-secrets
        --version "${HELM_SECRETS_VERSION}"
    # Configure GCP credentials (stored in CI variable)
    - echo "$GCP_SERVICE_ACCOUNT_KEY" > /tmp/gcp-sa.json
    - export GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-sa.json
    # Configure kubectl
    - echo "$KUBE_CONFIG" | base64 -d > /tmp/kubeconfig
    - export KUBECONFIG=/tmp/kubeconfig

validate-secrets:
  extends: .base
  stage: validate
  script:
    - |
      for env in dev staging production; do
        if [ -f "environments/${env}/secrets.yaml" ]; then
          sops --decrypt "environments/${env}/secrets.yaml" > /dev/null
          echo "✓ ${env}/secrets.yaml validated"
        fi
      done

deploy-production:
  extends: .base
  stage: deploy
  only:
    - main
  environment:
    name: production
  script:
    - |
      helm secrets upgrade --install payment-service \
        ./helm-charts/payment-service \
        --namespace production \
        --create-namespace \
        --atomic \
        --timeout 10m \
        -f ./helm-charts/payment-service/values.yaml \
        -f ./environments/production/values.yaml \
        -f ./environments/production/secrets.yaml
```

## ArgoCD Integration

ArgoCD requires a custom approach since it doesn't natively run `helm secrets`. Two options exist: the helm-secrets ArgoCD plugin or the ArgoCD Vault Plugin.

### ArgoCD Helm Secrets Plugin

```yaml
# argocd-cm-patch.yaml
# Add helm-secrets as an ArgoCD config management plugin
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # Register helm-secrets as a custom plugin
  configManagementPlugins: |
    - name: helm-secrets
      generate:
        command: [sh, -c]
        args: ["helm secrets template $ARGOCD_APP_NAME . -f values.yaml -f secrets/$ENV/values.yaml -f secrets/$ENV/secrets.yaml --set global.image.tag=$IMAGE_TAG"]
```

```yaml
# argocd-repo-server-patch.yaml
# Add SOPS and helm-secrets to the argocd-repo-server pod
apiVersion: apps/v1
kind: Deployment
metadata:
  name: argocd-repo-server
  namespace: argocd
spec:
  template:
    spec:
      # Service account with KMS access via IRSA
      serviceAccountName: argocd-repo-server
      automountServiceAccountToken: true

      initContainers:
      - name: install-sops-and-helm-secrets
        image: alpine:3.19
        command:
        - /bin/sh
        - -c
        - |
          # Download SOPS
          wget -qO /custom-tools/sops \
            https://github.com/getsops/sops/releases/download/v3.9.0/sops-v3.9.0.linux.amd64
          chmod +x /custom-tools/sops

          # Download helm-secrets
          wget -qO /tmp/helm-secrets.tar.gz \
            https://github.com/jkroepke/helm-secrets/archive/refs/tags/v4.6.0.tar.gz
          tar xzf /tmp/helm-secrets.tar.gz -C /custom-tools/
        volumeMounts:
        - name: custom-tools
          mountPath: /custom-tools

      containers:
      - name: argocd-repo-server
        env:
        - name: HELM_PLUGINS
          value: /custom-tools/helm-secrets-4.6.0
        - name: HELM_SECRETS_BACKEND
          value: sops
        - name: SOPS_AGE_KEY_FILE
          value: /etc/sops/age/keys.txt
        volumeMounts:
        - name: custom-tools
          mountPath: /usr/local/bin/sops
          subPath: sops
        - name: custom-tools
          mountPath: /custom-tools
        - name: sops-age-key
          mountPath: /etc/sops/age

      volumes:
      - name: custom-tools
        emptyDir: {}
      - name: sops-age-key
        secret:
          secretName: argocd-sops-age-key
          items:
          - key: keys.txt
            path: keys.txt
```

```yaml
# argocd-application-with-secrets.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: payment-service
  namespace: argocd
spec:
  project: production

  source:
    repoURL: https://git.internal.example.com/platform/apps.git
    targetRevision: HEAD
    path: helm-charts/payment-service

    helm:
      valueFiles:
      - values.yaml
      - ../../environments/production/values.yaml
      - secrets+age-import:///etc/sops/age/keys.txt?../../environments/production/secrets.yaml

  destination:
    server: https://kubernetes.default.svc
    namespace: production

  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

## Migrating from Unencrypted Secrets

```bash
#!/bin/bash
# migrate-to-sops.sh
# Migrate existing Kubernetes secrets from plaintext to SOPS-encrypted

set -euo pipefail

NAMESPACE="${1:-production}"
OUTPUT_DIR="${2:-environments/production}"

mkdir -p "$OUTPUT_DIR"

echo "=== Migrating secrets from namespace: $NAMESPACE ==="

# List all secrets (exclude service account tokens and TLS certs managed by cert-manager)
SECRETS=$(kubectl get secrets -n "$NAMESPACE" \
  --field-selector type=Opaque \
  -o jsonpath='{.items[*].metadata.name}')

for SECRET_NAME in $SECRETS; do
  echo "Processing: $SECRET_NAME"

  # Export secret values
  SECRET_FILE="${OUTPUT_DIR}/${SECRET_NAME}-secrets.yaml"

  {
    echo "# Migrated from Kubernetes secret: ${NAMESPACE}/${SECRET_NAME}"
    echo "# Encrypted with SOPS - safe to commit to Git"
    echo ""

    kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" -o json \
      | jq -r '.data | to_entries[] | "\(.key): \(.value | @base64d)"'
  } > /tmp/plaintext-${SECRET_NAME}.yaml

  # Encrypt with SOPS
  sops --encrypt /tmp/plaintext-${SECRET_NAME}.yaml > "$SECRET_FILE"

  # Verify the encryption worked
  sops --decrypt "$SECRET_FILE" > /dev/null

  # Clean up plaintext
  rm /tmp/plaintext-${SECRET_NAME}.yaml

  echo "  -> Encrypted: $SECRET_FILE"
done

echo ""
echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "1. Review the encrypted files in $OUTPUT_DIR"
echo "2. Delete plaintext secrets from Git history if they were previously committed"
echo "3. Update your Helm templates to reference the new values"
echo "4. Add .gitignore entries for any plaintext secret files"
echo ""
echo "DO NOT commit plaintext secret files. Only commit SOPS-encrypted files."
```

### Helm Template for Secret Creation

```yaml
# templates/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-credentials
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "payment-service.labels" . | nindent 4 }}
  annotations:
    # Document the SOPS key used for this secret
    sops.mozilla.org/key-source: aws-kms
type: Opaque
stringData:
  database-password: {{ .Values.database.password | required "database.password is required" | quote }}
  database-replication-password: {{ .Values.database.replication_password | required "database.replication_password is required" | quote }}
  redis-password: {{ .Values.redis.password | required "redis.password is required" | quote }}
  jwt-secret: {{ .Values.api.jwt_secret | required "api.jwt_secret is required" | quote }}
  oauth-client-secret: {{ .Values.api.oauth_client_secret | required "api.oauth_client_secret is required" | quote }}
```

SOPS with helm-secrets represents a pragmatic balance between GitOps purity and secret security. The model works because KMS keys are access-controlled independently of the Git repository, CI/CD pipelines authenticate via OIDC rather than storing long-lived credentials, and the encrypted YAML diffs remain reviewable in pull requests. Teams that invest in this pattern gain both auditability and security — the two properties that secrets management in GitOps workflows must simultaneously satisfy.
