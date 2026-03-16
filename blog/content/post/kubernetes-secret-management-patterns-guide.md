---
title: "Kubernetes Secret Management: From Sealed Secrets to External Secrets Operator"
date: 2027-04-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets", "Security", "HashiCorp Vault", "External Secrets"]
categories: ["Kubernetes", "Security", "Secret Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide comparing Kubernetes secret management approaches: native Secrets with etcd encryption, Sealed Secrets, External Secrets Operator with Vault/AWS SSM/GCP Secret Manager, CSI Secret Store driver, and best practices for secret rotation and audit logging."
more_link: "yes"
url: "/kubernetes-secret-management-patterns-guide/"
---

Kubernetes Secrets store sensitive data — database passwords, API tokens, TLS certificates — but the default behavior is frequently misunderstood: the base64 encoding applied to Secret values is encoding, not encryption. Anyone with `kubectl get secret` access can instantly retrieve the plaintext value. Worse, the raw data is stored unencrypted in etcd unless encryption-at-rest is explicitly configured. Production secret management requires a layered strategy covering storage encryption, access control, GitOps-safe distribution, rotation, and audit logging. This guide covers each layer from native Secrets through the full External Secrets Operator ecosystem.

<!--more-->

## Native Kubernetes Secrets: What They Are and Are Not

### The Base64 Misconception

```bash
# Create a secret with kubectl
kubectl create secret generic db-credentials \
  --from-literal=username=payments_app \
  --from-literal=password=hunter2 \
  --namespace payments-api

# Retrieve and decode — takes 5 seconds
kubectl get secret db-credentials -n payments-api -o jsonpath='{.data.password}' | base64 -d
# Output: hunter2
```

Base64 is reversible with zero key material. Any person or process with `get secrets` RBAC permission can read all secrets in the namespace. The access control problem and the at-rest encryption problem are separate concerns.

### etcd Encryption at Rest

Without encryption-at-rest configuration, secrets are stored as plaintext in etcd. Anyone with direct etcd access (backups, snapshots, etcd member access) can read all secrets:

```bash
# Demonstrate unencrypted secret in etcd (DO NOT run in production without understanding the impact)
# This requires direct etcd access, which only control-plane admins should have
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/payments-api/db-credentials | strings | grep -A2 "password"
# Without encryption: the value is visible in the output
```

### Configuring etcd Encryption at Rest

```yaml
# /etc/kubernetes/encryption-config.yaml
# Referenced by kube-apiserver --encryption-provider-config flag
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps           # Consider encrypting ConfigMaps too
    providers:
      # AES-GCM: recommended for new clusters (faster than CBC)
      - aescbc:
          keys:
            # Primary key — used for encryption
            - name: key-20250101
              secret: BASE64_ENCODED_32_BYTE_KEY_REPLACE_ME
            # Previous key — retained for decryption during rotation
            # - name: key-20240601
            #   secret: PREVIOUS_KEY_REPLACE_ME
      # Identity provider must be last — handles unencrypted legacy resources
      - identity: {}
```

```bash
# Generate a 32-byte AES key for the encryption config
head -c 32 /dev/urandom | base64

# Add to kube-apiserver static pod:
# - --encryption-provider-config=/etc/kubernetes/encryption-config.yaml

# After enabling encryption, existing secrets are NOT automatically re-encrypted.
# Force re-encryption of all secrets:
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -
# This touches every secret, causing the API server to re-write it with the new provider
```

### RBAC for Secrets

```yaml
# restrict-secret-access.yaml — RBAC to limit secret access to specific service accounts
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: payments-secret-reader
  namespace: payments-api
rules:
  # Allow only reading named secrets, not listing all secrets
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames:
      - db-credentials       # Only this specific secret
      - stripe-api-key       # Only this specific secret
    verbs: ["get"]
  # Explicitly do NOT grant 'list' — list returns all values in namespace
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payments-app-secret-access
  namespace: payments-api
subjects:
  - kind: ServiceAccount
    name: payments-api
    namespace: payments-api
roleRef:
  kind: Role
  name: payments-secret-reader
  apiGroup: rbac.authorization.k8s.io
```

## Sealed Secrets

### Architecture

Bitnami Sealed Secrets solves the GitOps problem: how can encrypted secret manifests be stored safely in a Git repository? The SealedSecret CRD contains asymmetrically encrypted values that only the in-cluster controller can decrypt. The public key is freely distributable; only the controller has the private key.

```bash
# Install Sealed Secrets controller
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version 2.15.4 \
  --set-string fullnameOverride=sealed-secrets-controller

# Install kubeseal CLI
curl -LO https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.26.3/kubeseal-0.26.3-linux-amd64.tar.gz
tar xf kubeseal-0.26.3-linux-amd64.tar.gz
install kubeseal /usr/local/bin/kubeseal
```

### Creating Sealed Secrets

```bash
# Method 1: Seal an existing Secret manifest
kubectl create secret generic db-credentials \
  --from-literal=username=payments_app \
  --from-literal=password=SomeDatabasePassword123 \
  --namespace payments-api \
  --dry-run=client -o yaml | \
  kubeseal \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system \
    --format yaml > sealed-db-credentials.yaml

# Method 2: Fetch the certificate and seal offline (useful in CI without cluster access)
kubeseal --fetch-cert \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  > sealed-secrets-public-cert.pem

kubectl create secret generic db-credentials \
  --from-literal=username=payments_app \
  --from-literal=password=SomeDatabasePassword123 \
  --namespace payments-api \
  --dry-run=client -o yaml | \
  kubeseal --cert sealed-secrets-public-cert.pem \
    --format yaml > sealed-db-credentials.yaml
```

```yaml
# sealed-db-credentials.yaml — Safe to commit to Git
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-credentials
  namespace: payments-api
spec:
  encryptedData:
    # These values are asymmetrically encrypted with the controller's public key
    # They cannot be decrypted without the controller's private key
    password: AgBy8hCHBZb...truncated...XzY=
    username: AgAUxM3K...truncated...pQ==
  template:
    metadata:
      name: db-credentials
      namespace: payments-api
    type: Opaque
```

### Controller Key Rotation

```bash
# Sealed Secrets key rotation — generate a new key pair
kubectl rollout restart deployment sealed-secrets-controller -n kube-system
# The controller generates a new key pair on every restart (configurable with --key-renew-period)

# List all sealing keys
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key=active

# After key rotation, existing SealedSecrets continue to work (old keys are retained)
# New SealedSecrets will be encrypted with the new key
# Re-seal existing secrets when the old key reaches its retirement date:
kubeseal --re-encrypt < sealed-db-credentials.yaml > sealed-db-credentials-new.yaml
```

## External Secrets Operator

### Architecture Overview

External Secrets Operator (ESO) synchronizes secrets from external stores (Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault) into Kubernetes Secrets. The key architectural advantage over Sealed Secrets is that the secret value never lives in Git at all — only a reference to the external secret name.

Core CRDs:
- `SecretStore` — namespace-scoped store configuration (how to authenticate to the external provider)
- `ClusterSecretStore` — cluster-scoped store (one store for all namespaces)
- `ExternalSecret` — defines which external secrets to sync and how to map them to a Kubernetes Secret

```bash
# Install External Secrets Operator
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version 0.10.3 \
  --set installCRDs=true \
  --set replicaCount=2
```

### HashiCorp Vault Provider

#### Kubernetes Auth Method (Recommended)

```yaml
# vault-cluster-secret-store.yaml — Cluster-wide store using Kubernetes auth
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-cluster-store
spec:
  provider:
    vault:
      server: https://vault.internal.support.tools:8200
      path: secret          # KV v2 mount path
      version: v2
      auth:
        kubernetes:
          mountPath: kubernetes
          role: external-secrets-operator  # Vault role bound to the ESO service account
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
      caBundle: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0t...  # Vault CA cert (base64)
```

```bash
# Configure Vault to accept Kubernetes auth
vault auth enable kubernetes

vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc.cluster.local:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Create Vault policy allowing ESO to read secrets
vault policy write external-secrets-reader - <<'EOF'
path "secret/data/payments/*" {
  capabilities = ["read"]
}
path "secret/metadata/payments/*" {
  capabilities = ["list", "read"]
}
EOF

# Create Kubernetes auth role binding the ESO service account to the policy
vault write auth/kubernetes/role/external-secrets-operator \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=external-secrets-reader \
  ttl=1h
```

#### ExternalSecret Syncing from Vault

```yaml
# payments-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: payments-api
spec:
  refreshInterval: 1h    # Re-sync from Vault every hour
  secretStoreRef:
    name: vault-cluster-store
    kind: ClusterSecretStore
  target:
    name: db-credentials  # Name of the Kubernetes Secret to create/update
    creationPolicy: Owner # ESO owns the Secret lifecycle
    deletionPolicy: Retain
    template:
      type: Opaque
      metadata:
        annotations:
          managed-by: external-secrets-operator
  data:
    # Map Vault secret key to Kubernetes Secret key
    - secretKey: username          # Key in resulting Kubernetes Secret
      remoteRef:
        key: payments/db-credentials  # Path in Vault KV v2
        property: username             # Field within the Vault secret
    - secretKey: password
      remoteRef:
        key: payments/db-credentials
        property: password
    - secretKey: host
      remoteRef:
        key: payments/db-credentials
        property: host
```

```bash
# Check ExternalSecret sync status
kubectl get externalsecret db-credentials -n payments-api
# NAME              STORE                REFRESH INTERVAL   STATUS   READY
# db-credentials    vault-cluster-store  1h                 SecretSynced  True

# Describe for detailed status
kubectl describe externalsecret db-credentials -n payments-api
```

### AWS Secrets Manager and Parameter Store Provider

```yaml
# aws-cluster-secret-store.yaml — IRSA-based authentication to AWS
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-store
spec:
  provider:
    aws:
      service: SecretsManager    # or ParameterStore
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
            # Service account annotated with:
            # eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/ExternalSecretsRole
```

```yaml
# aws-external-secret.yaml — Sync from AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payment-processor-credentials
  namespace: payments-api
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: aws-secrets-store
    kind: ClusterSecretStore
  target:
    name: payment-processor-credentials
    creationPolicy: Owner
  # Sync all keys from an AWS Secrets Manager secret as individual K8s Secret keys
  dataFrom:
    - extract:
        key: /payments/production/stripe-credentials  # AWS secret name/path
```

```yaml
# aws-parameter-store-secret.yaml — Sync from AWS Systems Manager Parameter Store
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-config-secrets
  namespace: payments-api
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: aws-parameter-store
    kind: ClusterSecretStore
  target:
    name: app-config-secrets
    creationPolicy: Owner
  data:
    - secretKey: database_url
      remoteRef:
        key: /production/payments-api/database_url  # SSM parameter path
    - secretKey: redis_url
      remoteRef:
        key: /production/payments-api/redis_url
```

### GCP Secret Manager Provider

```yaml
# gcp-cluster-secret-store.yaml — Workload Identity-based authentication
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: gcp-secrets-store
spec:
  provider:
    gcpsm:
      projectID: payments-production-123456
      auth:
        workloadIdentity:
          clusterLocation: us-central1
          clusterName: payments-prod-cluster
          clusterProjectID: payments-infrastructure-789012
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
            # K8s SA must be bound to a GCP SA via Workload Identity:
            # gcloud iam service-accounts add-iam-policy-binding \
            #   eso-reader@payments-production-123456.iam.gserviceaccount.com \
            #   --role roles/iam.workloadIdentityUser \
            #   --member "serviceAccount:payments-infrastructure-789012.svc.id.goog[external-secrets/external-secrets]"
```

```yaml
# gcp-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: gcp-db-password
  namespace: payments-api
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: gcp-secrets-store
    kind: ClusterSecretStore
  target:
    name: gcp-db-password
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: payments-db-password       # GCP Secret Manager secret name
        version: latest                  # or a specific version number
```

## Secrets Store CSI Driver

### CSI Driver vs External Secrets Operator

| Feature | ESO | CSI Driver |
|---|---|---|
| Secret storage | Creates Kubernetes Secrets | Mounts volume directly into pod (optional K8s Secret sync) |
| Access method | Environment variable or volume from K8s Secret | Volume mount (primary), K8s Secret (optional) |
| Rotation triggering | Automatic refresh creates new K8s Secret version | Requires pod restart or `SecretProviderClass` rotation |
| GitOps integration | ExternalSecret CRD in Git | SecretProviderClass CRD in Git |
| Provider support | Broader (many community providers) | AWS, Azure, GCP, Vault |
| etcd risk | Secret lands in etcd | Volume-only mode avoids etcd |

The CSI Driver's primary advantage is the volume-only mode that bypasses etcd entirely. The pod reads secrets from a mounted volume backed by the external provider.

```bash
# Install Secrets Store CSI Driver
helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm repo update

helm install csi-secrets-store secrets-store-csi-driver/secrets-store-csi-driver \
  --namespace kube-system \
  --version 1.4.4 \
  --set syncSecret.enabled=true \   # Enable K8s Secret sync (optional)
  --set enableSecretRotation=true \ # Enable rotation polling
  --set rotationPollInterval=2m

# Install Vault provider for CSI Driver
helm install vault-csi-provider hashicorp/vault-csi-provider \
  --namespace kube-system \
  --version 0.5.0
```

```yaml
# vault-secret-provider-class.yaml — CSI Driver SecretProviderClass for Vault
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: vault-db-credentials
  namespace: payments-api
spec:
  provider: vault
  parameters:
    vaultAddress: https://vault.internal.support.tools:8200
    roleName: payments-api                    # Vault Kubernetes auth role
    objects: |
      - objectName: db-username
        secretPath: secret/data/payments/db-credentials
        secretKey: username
      - objectName: db-password
        secretPath: secret/data/payments/db-credentials
        secretKey: password
  # Optional: sync to a Kubernetes Secret as well
  secretObjects:
    - secretName: vault-synced-db-credentials
      type: Opaque
      data:
        - objectName: db-username
          key: username
        - objectName: db-password
          key: password
```

```yaml
# pod-with-csi-secret-mount.yaml — Pod using CSI Driver for secret access
apiVersion: v1
kind: Pod
metadata:
  name: payments-api-pod
  namespace: payments-api
spec:
  serviceAccountName: payments-api
  containers:
  - name: payments-api
    image: registry.support.tools/payments/api-server:2.4.1
    volumeMounts:
    - name: vault-secrets
      mountPath: /mnt/secrets
      readOnly: true
    # Files available:
    # /mnt/secrets/db-username
    # /mnt/secrets/db-password
  volumes:
  - name: vault-secrets
    csi:
      driver: secrets-store.csi.k8s.io
      readOnly: true
      volumeAttributes:
        secretProviderClass: vault-db-credentials
```

## Secret Rotation Handling

### Automatic Pod Restart with Reloader

When ESO updates a Kubernetes Secret (due to a refreshInterval trigger or a manual push), pods using that secret via environment variables do not automatically pick up the new value. The Reloader controller watches for Secret changes and triggers rolling restarts.

```bash
# Install Reloader
helm repo add stakater https://stakater.github.io/stakater-charts
helm repo update

helm install reloader stakater/reloader \
  --namespace reloader \
  --create-namespace \
  --version 1.0.100 \
  --set reloader.watchGlobally=false  # Only watch annotated deployments
```

```yaml
# deployment-with-reloader.yaml — Deployment that auto-restarts on secret change
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-api
  namespace: payments-api
  annotations:
    # Trigger rolling restart when any of these secrets change
    secret.reloader.stakater.com/reload: "db-credentials,stripe-api-key"
    # Or watch all secrets used by this deployment
    # reloader.stakater.com/auto: "true"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: payments-api
  template:
    metadata:
      labels:
        app: payments-api
    spec:
      containers:
      - name: payments-api
        image: registry.support.tools/payments/api-server:2.4.1
        envFrom:
        - secretRef:
            name: db-credentials
```

### Vault Secret Rotation Workflow

```bash
#!/bin/bash
# rotate-vault-secret.sh — Rotate a secret in Vault and trigger ESO re-sync
# Usage: ./rotate-vault-secret.sh payments/db-credentials db-credentials payments-api
set -euo pipefail

VAULT_PATH="${1:?Vault path required}"
K8S_SECRET="${2:?Kubernetes Secret name required}"
K8S_NAMESPACE="${3:?Namespace required}"

# Step 1: Write new secret value to Vault
echo "Updating secret in Vault at ${VAULT_PATH}..."
vault kv put "${VAULT_PATH}" \
  username=payments_app \
  password="$(openssl rand -base64 32)" \
  host=db-primary.payments-api.svc.cluster.local \
  port=5432

# Step 2: Force ESO to re-sync immediately (bypass refreshInterval)
echo "Forcing ExternalSecret re-sync..."
kubectl annotate externalsecret "${K8S_SECRET}" \
  -n "${K8S_NAMESPACE}" \
  force-sync="$(date +%s)" \
  --overwrite

# Step 3: Wait for sync to complete
echo "Waiting for sync..."
kubectl wait externalsecret "${K8S_SECRET}" \
  -n "${K8S_NAMESPACE}" \
  --for=condition=Ready \
  --timeout=60s

# Step 4: Verify the K8s Secret was updated
NEW_HASH=$(kubectl get secret "${K8S_SECRET}" \
  -n "${K8S_NAMESPACE}" \
  -o jsonpath='{.data.password}' | md5sum)
echo "Secret updated. New hash: ${NEW_HASH}"

echo "Reloader will trigger rolling restart automatically."
```

## Secret Scanning in CI

### gitleaks Configuration

```toml
# .gitleaks.toml — Custom gitleaks configuration for the payments repository
title = "Payments Platform Secret Scanner"

[allowlist]
  description = "Allowlist for known false positives"
  regexes = [
    # Allow example secrets that are clearly documentation values
    "EXAMPLE_TOKEN_REPLACE_ME",
    "YOUR_SECRET_HERE",
    # Allow base64-encoded certificate data (not secrets)
    "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0t"
  ]
  paths = [
    # Sealed Secret encrypted values are intentionally base64-encoded
    '''.*sealed.*\.yaml''',
    # Test fixtures may contain example values
    '''test/fixtures/.*'''
  ]

[[rules]]
  description = "Vault AppRole Secret ID"
  id = "vault-approle-secret-id"
  regex = '''(?i)vault.*secret.*id.*[=:]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'''
  tags = ["vault", "secret-id"]

[[rules]]
  description = "Kubernetes service account token (legacy format)"
  id = "k8s-service-account-token"
  regex = '''eyJhbGciOiJSUzI1NiIsImtpZCI6'''
  tags = ["kubernetes", "service-account"]
```

```yaml
# .github/workflows/secret-scan.yaml — GitHub Actions workflow for secret scanning
name: Secret Scanning
on:
  pull_request:
  push:
    branches: [main, release/*]

jobs:
  gitleaks:
    name: Gitleaks Secret Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # Full history for comprehensive scanning

      - name: Run gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_CONFIG: .gitleaks.toml

  trufflehog:
    name: TruffleHog Deep Scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run TruffleHog
        uses: trufflesecurity/trufflehog@v3.67.4
        with:
          path: ./
          base: ${{ github.event.repository.default_branch }}
          head: HEAD
          extra_args: --debug --only-verified
```

## Comparison Table

| Approach | GitOps safe | Rotation support | etcd exposure | Complexity | Best for |
|---|---|---|---|---|---|
| Native Secrets (unencrypted) | No (base64) | Manual | Full | Low | Dev/test only |
| Native Secrets + etcd encryption | No (still base64 in repo) | Manual | Encrypted | Medium | Small clusters with strict repo access |
| Sealed Secrets | Yes | Key rotation manual | Encrypted via K8s | Low-Medium | Teams wanting GitOps with minimal infrastructure |
| External Secrets (Vault) | Yes (references only) | Automatic | Encrypted | Medium-High | Enterprises with existing Vault investment |
| External Secrets (AWS SSM) | Yes | Automatic | Encrypted | Medium | AWS-native workloads using IRSA |
| External Secrets (GCP SM) | Yes | Automatic | Encrypted | Medium | GCP-native workloads using Workload Identity |
| CSI Secret Store (volume-only) | Yes | Requires pod restart | None | High | Highest security posture; etcd bypass required |

## Operational Best Practices

### RBAC Audit for Secret Access

```bash
#!/bin/bash
# audit-secret-rbac.sh — Find all principals with secret access in a namespace
NAMESPACE="${1:?Namespace required}"

echo "=== Principals with secret access in namespace: ${NAMESPACE} ==="

echo ""
echo "--- Roles granting secret access ---"
kubectl get role -n "${NAMESPACE}" -o json | \
  jq -r '.items[] | select(.rules[]? | .resources[]? == "secrets") |
    .metadata.name'

echo ""
echo "--- RoleBindings binding secret-access roles ---"
kubectl get rolebinding -n "${NAMESPACE}" -o json | \
  jq -r '.items[] | .metadata.name + " -> " + (.subjects[]? | .kind + "/" + .name)'

echo ""
echo "--- ClusterRoles granting secret access (cluster-wide) ---"
kubectl get clusterrole -o json | \
  jq -r '.items[] | select(.rules[]? | .resources[]? == "secrets") |
    .metadata.name' | grep -v "^system:"

echo ""
echo "--- Direct secret access test for service accounts ---"
for sa in $(kubectl get serviceaccount -n "${NAMESPACE}" -o jsonpath='{.items[*].metadata.name}'); do
  result=$(kubectl auth can-i get secrets -n "${NAMESPACE}" \
    --as="system:serviceaccount:${NAMESPACE}:${sa}" 2>/dev/null)
  if [[ "${result}" == "yes" ]]; then
    echo "  WARNING: ${sa} can GET secrets in ${NAMESPACE}"
  fi
done
```

### Secret Health Dashboard Query

```bash
# Check all ExternalSecrets across all namespaces for sync failures
kubectl get externalsecrets --all-namespaces \
  -o custom-columns=\
'NAMESPACE:.metadata.namespace,NAME:.metadata.name,STORE:.spec.secretStoreRef.name,STATUS:.status.conditions[0].reason,READY:.status.conditions[0].status'

# Find ExternalSecrets that are not Ready
kubectl get externalsecrets --all-namespaces -o json | \
  jq -r '.items[] | select(.status.conditions[]? | .type == "Ready" and .status != "True") |
    [.metadata.namespace, .metadata.name,
     (.status.conditions[] | select(.type == "Ready") | .message)] | @tsv'
```

## Summary

A mature Kubernetes secret management strategy should be layered:

1. Enable etcd encryption-at-rest immediately — this is a one-time configuration change that protects against etcd backup exposure.
2. Use External Secrets Operator with HashiCorp Vault, AWS Secrets Manager, or GCP Secret Manager as the primary secret store. Secret values never enter Git repositories.
3. Use Sealed Secrets for teams or clusters that cannot operate a dedicated secret store — it provides GitOps safety with minimal infrastructure requirements.
4. Deploy Reloader alongside ESO to ensure pods automatically restart when secrets rotate.
5. Configure RBAC to use `resourceNames` restrictions on secret access — applications should only be able to read the specific secrets they need, not `list` all secrets in a namespace.
6. Integrate gitleaks and TruffleHog into CI pipelines to catch any credentials committed to source control before they reach production.
7. Audit RBAC secret access quarterly to catch privilege creep from forgotten service accounts and accumulated role bindings.
