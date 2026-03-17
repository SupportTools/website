---
title: "Kubernetes Sealed Secrets vs External Secrets Operator: GitOps Secret Management"
date: 2031-01-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets", "GitOps", "Sealed Secrets", "External Secrets Operator", "Security", "AWS", "Vault", "ArgoCD"]
categories:
- Kubernetes
- Security
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive comparison of Sealed Secrets and External Secrets Operator for Kubernetes secret management: encryption models, key rotation, AWS SSM/Secrets Manager/Vault integration, ClusterSecretStore scoping, and choosing the right approach for GitOps workflows."
more_link: "yes"
url: "/kubernetes-sealed-secrets-external-secrets-operator-gitops-secret-management/"
---

Secret management in GitOps environments presents a fundamental tension: secrets must be versioned and deployable like any other resource, but must never appear in plaintext in version control. Two mature solutions address this differently. Sealed Secrets encrypts secrets before they reach Git, keeping the secret store in the cluster. External Secrets Operator leaves secrets in a dedicated secret manager (AWS Secrets Manager, HashiCorp Vault, etc.) and synchronizes them into Kubernetes at runtime. This guide covers both approaches in depth, including operational patterns, security models, failure modes, and guidance for choosing between them.

<!--more-->

# Kubernetes Sealed Secrets vs External Secrets Operator: GitOps Secret Management

## The Core Problem

A naive GitOps workflow breaks down immediately with secrets:

```yaml
# DO NOT COMMIT - plaintext secret in Git
apiVersion: v1
kind: Secret
metadata:
  name: database-credentials
  namespace: production
type: Opaque
data:
  password: c3VwZXJzZWNyZXQxMjM=  # base64 is NOT encryption
```

Base64 encoding provides zero security - it's trivially reversible. Any repository access grants full access to all secrets. The solutions:

| Approach | Sealed Secrets | External Secrets Operator |
|----------|---------------|--------------------------|
| Where secrets live | Encrypted in Git | External secret manager |
| Encryption | Asymmetric (RSA/EC) per cluster | Delegated to provider |
| Offline deployability | Yes (all in Git) | No (requires network to secret manager) |
| Centralized governance | Limited | Yes (full audit trail in provider) |
| Rotation complexity | Manual re-seal | Automatic sync |
| Multi-cluster | Separate keys per cluster | Shared secret store |

## Sealed Secrets

### Architecture

Sealed Secrets consists of two components:

1. **kubeseal CLI**: encrypts Kubernetes secrets into SealedSecrets on developer workstations
2. **Sealed Secrets controller**: runs in the cluster, decrypts SealedSecrets into Kubernetes Secrets

The encryption is asymmetric: the public key encrypts (available to all developers), the private key decrypts (stored only in the cluster).

```
Developer workstation:
  kubectl create secret generic --dry-run=client -o yaml | kubeseal > sealed-secret.yaml
  git add sealed-secret.yaml && git push

ArgoCD/Flux applies sealed-secret.yaml to cluster

Sealed Secrets controller (in cluster):
  Detects new SealedSecret
  Decrypts using private key
  Creates/updates corresponding Kubernetes Secret
```

### Installation

```bash
# Install Sealed Secrets controller via Helm
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm install sealed-secrets \
  sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version 2.15.0 \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=64Mi \
  --set resources.limits.cpu=200m \
  --set resources.limits.memory=128Mi \
  --wait

# Install kubeseal CLI
KUBESEAL_VERSION=0.26.3
curl -L https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz | tar xz
sudo install kubeseal /usr/local/bin/
```

### Creating Sealed Secrets

```bash
# Method 1: Pipe from kubectl dry-run
kubectl create secret generic database-credentials \
  --namespace production \
  --from-literal=username=dbuser \
  --from-literal=password=changeme \
  --dry-run=client -o yaml | \
  kubeseal \
    --controller-name=sealed-secrets \
    --controller-namespace=kube-system \
    --format yaml > sealed-db-credentials.yaml

# Method 2: Seal an existing secret file
kubeseal \
  --controller-name=sealed-secrets \
  --controller-namespace=kube-system \
  --format yaml \
  < secret.yaml > sealed-secret.yaml

# Method 3: Use a cached public key (useful in CI without cluster access)
kubeseal --fetch-cert \
  --controller-name=sealed-secrets \
  --controller-namespace=kube-system > public-cert.pem

# Use cached cert in CI
kubectl create secret generic database-credentials \
  --namespace production \
  --from-literal=password=changeme \
  --dry-run=client -o yaml | \
  kubeseal \
    --cert public-cert.pem \
    --format yaml > sealed-db-credentials.yaml
```

The output SealedSecret is safe to commit:

```yaml
# sealed-db-credentials.yaml - safe for Git
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  encryptedData:
    username: AgBy8hCe...  # RSA-OAEP encrypted, safe in public repos
    password: AgBy8hCe...
  template:
    metadata:
      name: database-credentials
      namespace: production
    type: Opaque
```

### Scope: Namespace vs Cluster

Sealed Secrets supports three scopes controlling where a sealed secret can be decrypted:

```bash
# Strict (default): tied to specific name AND namespace
kubeseal --scope strict < secret.yaml > sealed-secret.yaml

# Namespace-wide: any name within the namespace can decrypt
kubeseal --scope namespace-wide < secret.yaml > sealed-secret.yaml

# Cluster-wide: can be deployed to any namespace
kubeseal --scope cluster-wide < secret.yaml > sealed-secret.yaml
```

The scope is encoded in the encrypted data - changing namespace or name will fail decryption for strict scope, providing anti-replay protection.

### Key Rotation

This is the most operationally complex aspect of Sealed Secrets:

```bash
# Check current sealing keys
kubectl get secrets -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key

# View key ages
kubectl get secrets -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp

# The controller generates a new key every 30 days by default
# Old keys are retained for decryption (but not used for new seals)

# Manually rotate keys (generate a new key immediately)
kubectl annotate service -n kube-system sealed-secrets \
  sealedsecrets.bitnami.com/rotate=true

# After rotation, re-seal all secrets with the new key
# This is the critical operational step - stale sealed secrets encrypted
# with old keys continue to work until the old key is deleted
```

### Backing Up Sealing Keys

**Critical**: If the cluster is destroyed and keys are lost, all sealed secrets become permanently unreadable.

```bash
# Backup all sealing keys to a secure external store
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o yaml > sealed-secrets-keys-backup.yaml

# This file contains PRIVATE KEYS - treat it with maximum sensitivity
# Store in: Vault, AWS Secrets Manager, encrypted S3 bucket, etc.
# NEVER commit to Git

# Restore keys to a new cluster
kubectl apply -f sealed-secrets-keys-backup.yaml -n kube-system
# Restart the sealed-secrets controller to pick up restored keys
kubectl rollout restart deployment sealed-secrets -n kube-system
```

### GitOps Integration

```yaml
# ArgoCD Application
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-secrets
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://github.com/example/k8s-manifests
    targetRevision: main
    path: production/secrets
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
```

Sealed secrets in the repository are just YAML files that ArgoCD applies like any other resource. No special plugin required.

## External Secrets Operator

### Architecture

ESO runs as a controller that reads ExternalSecret resources (describing which secrets to pull from external stores) and creates/syncs Kubernetes Secrets.

```
External Secret Manager (AWS, Vault, GCP, etc.)
         │
         │ ESO controller polls/watches
         │
    ClusterSecretStore / SecretStore
    (describes how to connect to the external store)
         │
    ExternalSecret
    (describes which secrets to pull and how to map them)
         │
         ▼
    Kubernetes Secret (created/synced by ESO)
         │
    Pod consumes as env var or volume
```

### Installation

```bash
# Install External Secrets Operator via Helm
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets \
  external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version 0.10.0 \
  --set installCRDs=true \
  --set resources.requests.cpu=10m \
  --set resources.requests.memory=32Mi \
  --set resources.limits.cpu=100m \
  --set resources.limits.memory=128Mi \
  --wait

# Verify CRDs
kubectl get crds | grep external-secrets
```

### SecretStore vs ClusterSecretStore

**SecretStore** is namespace-scoped: ExternalSecrets in namespace `foo` can only reference SecretStores in namespace `foo`.

**ClusterSecretStore** is cluster-scoped: ExternalSecrets in any namespace can reference it.

```yaml
# ClusterSecretStore: for platform-wide secrets (certificates, shared API keys)
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
        # Use IRSA (IAM Roles for Service Accounts) - no static credentials
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
---
# SecretStore: for team-specific secrets (scoped to one namespace)
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: team-alpha-secrets
  namespace: team-alpha
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      # Restrict to secrets with a specific path prefix
      additionalRoles:
      - arn:aws:iam::123456789012:role/team-alpha-secrets-role
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-team-alpha
            namespace: team-alpha
```

### AWS Secrets Manager Integration

```yaml
# ExternalSecret pulling from AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  # How often to sync (resync interval)
  refreshInterval: 1h
  # Which SecretStore to use
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  # Target Kubernetes Secret to create/update
  target:
    name: database-credentials
    creationPolicy: Owner  # ESO owns this secret (will recreate if deleted)
    template:
      type: Opaque
      # Optional: transform the data
      engineVersion: v2
      data:
        DATABASE_URL: "postgres://{{ .username }}:{{ .password }}@{{ .host }}:5432/{{ .database }}"
  # What to pull from the external store
  data:
  # Pull specific keys from a JSON secret
  - secretKey: username
    remoteRef:
      key: production/database/credentials
      property: username
  - secretKey: password
    remoteRef:
      key: production/database/credentials
      property: password
  - secretKey: host
    remoteRef:
      key: production/database/credentials
      property: host
  - secretKey: database
    remoteRef:
      key: production/database/credentials
      property: database
```

### AWS SSM Parameter Store Integration

```yaml
# Pull from AWS SSM Parameter Store (useful for hierarchical configs)
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-ssm
spec:
  provider:
    aws:
      service: ParameterStore
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-config
  namespace: production
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: aws-ssm
    kind: ClusterSecretStore
  target:
    name: app-config
    creationPolicy: Owner
  # Pull all parameters under a path prefix
  dataFrom:
  - extract:
      key: /production/myapp
      # This pulls all parameters under /production/myapp/
      # e.g., /production/myapp/api-key -> secret key "api-key"
      #        /production/myapp/redis-url -> secret key "redis-url"
```

### HashiCorp Vault Integration

```yaml
# ClusterSecretStore for Vault
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault
spec:
  provider:
    vault:
      server: https://vault.example.com
      path: secret  # KV mount path
      version: v2   # KV v2
      auth:
        # Kubernetes auth method
        kubernetes:
          mountPath: kubernetes
          role: external-secrets
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-keys
  namespace: payments
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: vault
    kind: ClusterSecretStore
  target:
    name: api-keys
    creationPolicy: Owner
  data:
  - secretKey: stripe-api-key
    remoteRef:
      key: payments/api-keys  # Vault path: secret/data/payments/api-keys
      property: stripe_api_key
  - secretKey: paypal-client-secret
    remoteRef:
      key: payments/api-keys
      property: paypal_client_secret
```

### PushSecret: Writing Secrets Back to External Stores

ESO 0.8+ supports bidirectional sync with PushSecret:

```yaml
# Push a Kubernetes Secret to AWS Secrets Manager
# (useful for cluster-generated secrets like TLS certs)
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: tls-cert-push
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRefs:
  - name: aws-secrets-manager
    kind: ClusterSecretStore
  selector:
    secret:
      name: production-tls-cert  # The Kubernetes Secret to push
  data:
  - match:
      secretKey: tls.crt
      remoteRef:
        remoteKey: production/tls/certificate
        property: certificate
  - match:
      secretKey: tls.key
      remoteRef:
        remoteKey: production/tls/certificate
        property: private_key
```

### Sync Policies and Error Handling

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: critical-secret
  namespace: production
spec:
  refreshInterval: 5m
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: critical-secret
    creationPolicy: Owner
    # DeletionPolicy controls what happens when ExternalSecret is deleted
    deletionPolicy: Retain  # Keep the Kubernetes Secret even if ExternalSecret is deleted
    # Other options: Delete (default), Merge
  data:
  - secretKey: api-key
    remoteRef:
      key: production/critical/api-key
```

Monitor sync status:

```bash
# Check ExternalSecret sync status
kubectl get externalsecrets -n production
# NAME               STORE                   REFRESH INTERVAL   STATUS         READY
# database-credentials aws-secrets-manager   1h                 SecretSynced   True
# api-keys             vault                 30m                SecretSynced   True
# critical-secret      aws-secrets-manager   5m                 SyncError      False

# Get detailed error information
kubectl describe externalsecret critical-secret -n production

# Check ESO controller logs for errors
kubectl logs -n external-secrets \
  -l app.kubernetes.io/name=external-secrets \
  --tail=100 | grep -E 'error|Error|WARN'
```

### Metrics and Alerting

```yaml
# PrometheusRule for ESO monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-alerts
  namespace: monitoring
spec:
  groups:
  - name: external_secrets
    rules:
    - alert: ExternalSecretSyncFailed
      expr: |
        externalsecret_status_condition{condition="Ready",status="False"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "ExternalSecret sync failing"
        description: "ExternalSecret {{ $labels.name }} in namespace {{ $labels.namespace }} has failed to sync for 5 minutes"

    - alert: ExternalSecretSyncOld
      expr: |
        (time() - externalsecret_sync_calls_total) > 7200
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "ExternalSecret not synced recently"
        description: "ExternalSecret {{ $labels.name }} has not synced in over 2 hours"
```

## Decision Framework

### Choose Sealed Secrets When

- **Air-gapped or offline environments**: No network access to external secret managers during deployment
- **Simple teams**: Fewer than 50 engineers, no dedicated platform team to manage secret manager infrastructure
- **Cost sensitivity**: No existing Vault/AWS Secrets Manager license; don't want to pay for secret manager API calls
- **Self-contained clusters**: Each cluster is fully autonomous; no cross-cluster secret sharing
- **GitOps purity**: Strong preference for everything in Git, including (encrypted) secrets

### Choose External Secrets Operator When

- **Existing secret manager investment**: Already using Vault, AWS Secrets Manager, or GCP Secret Manager
- **Centralized audit requirements**: Need a single audit trail for all secret access across clusters
- **Multi-cluster environments**: Dozens of clusters sharing secrets; re-sealing for each cluster's key is impractical
- **Automatic rotation**: Secrets rotate frequently (TLS certificates, API keys); re-sealing manually doesn't scale
- **Fine-grained access control**: Need per-secret, per-team access policies enforced at the secret manager level
- **Compliance requirements**: SOC2, PCI-DSS require comprehensive secret access logging

### Hybrid Approach

Many organizations use both:

- **Sealed Secrets** for cluster infrastructure secrets (bootstrap credentials, ArgoCD configuration)
- **External Secrets Operator** for application secrets (database passwords, API keys)

This provides cluster autonomy for bootstrapping while leveraging enterprise secret management for application workloads.

## Security Hardening

### Sealed Secrets

```yaml
# Restrict who can create SealedSecrets in sensitive namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: sealed-secret-creator
  namespace: production
rules:
- apiGroups: ["bitnami.com"]
  resources: ["sealedsecrets"]
  verbs: ["create", "update", "patch"]
  # Only specific secret names
  resourceNames: ["database-credentials", "tls-cert"]
---
# Read-only for developers - they can see sealed secrets but not decrypt them
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: sealed-secret-reader
  namespace: production
rules:
- apiGroups: ["bitnami.com"]
  resources: ["sealedsecrets"]
  verbs: ["get", "list", "watch"]
```

### External Secrets Operator

```yaml
# Restrict which namespaces can use ClusterSecretStore
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager-restricted
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
  # Only allow ExternalSecrets from specific namespaces
  namespaceSelector:
    matchLabels:
      environment: production
  # Only allow access to specific secret paths
  # Enforce via IAM policy on the role:
  # "Condition": {"StringLike": {"secretsmanager:SecretId": "arn:aws:secretsmanager:*:*:secret:production/*"}}
```

## Operational Runbooks

### Sealed Secrets Key Rotation Runbook

```bash
#!/bin/bash
# runbook-sealed-secrets-key-rotation.sh
set -euo pipefail

echo "Step 1: Backup current keys"
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o yaml > sealed-secrets-keys-$(date +%Y%m%d).yaml

echo "Keys backed up. Uploading to secure storage..."
aws s3 cp sealed-secrets-keys-$(date +%Y%m%d).yaml \
  s3://my-secure-backups/sealed-secrets/ \
  --sse aws:kms

echo "Step 2: Fetch new public cert"
kubeseal --fetch-cert \
  --controller-name=sealed-secrets \
  --controller-namespace=kube-system > new-public-cert.pem

echo "Step 3: Re-seal all secrets with new cert"
find . -name 'sealed-*.yaml' -exec sh -c '
  original=$(echo {} | sed "s/sealed-//")
  if [ -f "$original" ]; then
    kubeseal --cert new-public-cert.pem --format yaml < "$original" > {}
    echo "Re-sealed: {}"
  fi
' \;

echo "Step 4: Commit and push re-sealed secrets"
git add .
git commit -m "chore: rotate sealed secrets encryption key $(date +%Y%m%d)"
git push

echo "Key rotation complete. Old keys retained for backward compatibility."
echo "Monitor: kubectl get sealedsecrets -A -w"
```

### External Secrets Operator: Force Sync

```bash
# Force immediate re-sync of a specific ExternalSecret
kubectl annotate externalsecret database-credentials \
  -n production \
  force-sync=$(date +%s) \
  --overwrite

# Force re-sync of all ExternalSecrets in a namespace
for es in $(kubectl get externalsecrets -n production -o name); do
  kubectl annotate $es \
    -n production \
    force-sync=$(date +%s) \
    --overwrite
  echo "Force-synced: $es"
done

# Watch sync status
kubectl get externalsecrets -n production -w
```

## Conclusion

Sealed Secrets and External Secrets Operator solve the same problem differently, and both are production-proven at scale:

- **Sealed Secrets** is simpler, self-contained, and excellent for teams that prioritize GitOps purity and operational simplicity. Its main operational risk is key loss during cluster disasters - a risk mitigated by regular key backups.

- **External Secrets Operator** requires an external secret manager (adding operational complexity and cost) but provides centralized auditing, automatic rotation support, and multi-cluster secret sharing that Sealed Secrets cannot match.

For new greenfield deployments on managed cloud, ESO with AWS Secrets Manager or Vault is the more scalable choice. For edge clusters, air-gapped environments, or teams just getting started with GitOps, Sealed Secrets provides an excellent security posture with minimal operational overhead.
