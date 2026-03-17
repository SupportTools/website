---
title: "Kubernetes Sealed Secrets vs External Secrets Operator: Architecture Comparison, Migration Path, Rotation Workflows"
date: 2031-12-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets Management", "Sealed Secrets", "External Secrets", "Security", "GitOps", "Vault"]
categories:
- Kubernetes
- Security
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of Sealed Secrets and External Secrets Operator for Kubernetes secret management: architecture trade-offs, migration procedures, and rotation workflows for production GitOps environments."
more_link: "yes"
url: "/kubernetes-sealed-secrets-vs-external-secrets-operator-guide/"
---

Every Kubernetes platform team eventually confronts the secrets management question: should secret material live in the Git repository (encrypted by the cluster's key) or in an external vault (referenced by pointers that live in Git)? Sealed Secrets and External Secrets Operator (ESO) represent these two philosophies. Neither is universally better—they solve different security models for different organizational contexts. This guide compares their architectures in depth, shows how to migrate between them, and covers the rotation workflows that determine their operational cost at scale.

<!--more-->

# Kubernetes Sealed Secrets vs External Secrets Operator: Complete Comparison

## Architecture Philosophy

### Sealed Secrets: Encryption at Rest in Git

```
Developer → kubeseal (encrypt) → SealedSecret YAML → Git
                                                        |
                                                        v
Kubernetes Controller (private key) → decrypts → native Secret
```

The controller holds the only copy of the private key. Any value encrypted against the cluster's public key can only be decrypted by that cluster's controller. This gives you:
- **Git as the single source of truth**: the sealed YAML is the authoritative record
- **No external dependency at runtime**: secrets are decrypted during reconciliation, no external call needed
- **Tight cluster coupling**: secrets encrypted for cluster A cannot be used in cluster B (by design)

### External Secrets Operator: Pointers + External Vault

```
Developer → writes ExternalSecret CRD (no secret material) → Git
                                                               |
                                                               v
ESO Controller → reads ExternalSecret → calls external backend (Vault, AWS SM, etc.)
             → creates native Secret in namespace
```

The actual secret bytes never appear in Git. The ExternalSecret CRD is a pointer:
- **External backends as source of truth**: AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, Azure KeyVault
- **Cross-cluster reuse**: the same secret in AWS Secrets Manager can serve 20 different clusters
- **Dynamic rotation**: when the backend secret is rotated, ESO syncs the new value automatically

## Section 1: Sealed Secrets — Deep Dive

### Installation

```bash
# Install Sealed Secrets controller
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --set fullnameOverride=sealed-secrets-controller \
  --set resources.requests.memory=64Mi \
  --set resources.requests.cpu=50m \
  --set resources.limits.memory=256Mi \
  --set resources.limits.cpu=200m

# Install kubeseal CLI
KUBESEAL_VERSION=$(curl -s https://api.github.com/repos/bitnami-labs/sealed-secrets/tags \
  | jq -r '.[0].name' | tr -d 'v')
curl -sL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz" \
  | tar xz kubeseal
sudo install -m 755 kubeseal /usr/local/bin/
```

### Creating Sealed Secrets

```bash
# Method 1: Seal from a Kubernetes secret manifest
kubectl create secret generic my-app-credentials \
  --from-literal=database-password=<my-db-password> \
  --from-literal=api-key=<my-api-key> \
  --dry-run=client \
  -o yaml | \
kubeseal \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  --format=yaml \
  > my-app-credentials-sealed.yaml

# Method 2: Seal with scope control
# --scope=strict: secret name AND namespace must match (default)
# --scope=namespace-wide: only namespace must match
# --scope=cluster-wide: any namespace (dangerous)
kubectl create secret generic my-app-credentials \
  --from-literal=database-password=<my-db-password> \
  --dry-run=client \
  -o yaml | \
kubeseal \
  --scope=strict \
  --name=my-app-credentials \
  --namespace=production \
  --format=yaml \
  > my-app-credentials-sealed.yaml

# The resulting SealedSecret YAML is safe to commit to Git
cat my-app-credentials-sealed.yaml
```

```yaml
# my-app-credentials-sealed.yaml (safe to commit to Git)
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: my-app-credentials
  namespace: production
  annotations:
    sealedsecrets.bitnami.com/managed: "true"
spec:
  encryptedData:
    database-password: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEq...  # Encrypted blob
    api-key: AgByABCDEFGHIJKLMNOPQRSTUVWXYZ...              # Encrypted blob
  template:
    metadata:
      name: my-app-credentials
      namespace: production
    type: Opaque
```

### Key Management and Rotation

The most critical operational concern with Sealed Secrets is key management:

```bash
# Export the signing key (MUST be backed up securely)
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
  -o yaml > sealed-secrets-master-key.yaml

# Store this backup in a secure location (external vault, encrypted backup)
# If you lose this key, ALL your sealed secrets become permanently unrecoverable

# List all keys (the controller creates a new key annually by default)
kubectl get secrets -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key \
  -o custom-columns=NAME:.metadata.name,CREATED:.metadata.creationTimestamp

# Force key rotation (creates new key, existing secrets still work with old key)
kubectl label secret -n kube-system sealed-secrets-XXXXXXXX \
  sealedsecrets.bitnami.com/sealed-secrets-key=active

# Re-seal ALL secrets after key rotation (recommended for security hygiene)
# Script to re-seal all secrets in all namespaces:
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
    for ss in $(kubectl get sealedsecret -n "$ns" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
        echo "Re-sealing $ns/$ss"
        # Get current decrypted value, re-encrypt with new key
        kubectl get secret "$ss" -n "$ns" -o yaml | \
          kubeseal --format=yaml \
            --controller-namespace=kube-system \
            --controller-name=sealed-secrets-controller \
          > "/tmp/$ns-$ss-resealed.yaml"
        kubectl apply -f "/tmp/$ns-$ss-resealed.yaml"
    done
done
```

### Sealed Secrets Limitations

1. **No rotation automation**: changing a secret requires re-sealing and committing a new YAML to Git
2. **Cluster binding**: migrating to a new cluster requires re-sealing all secrets with the new cluster's public key
3. **Key backup is mandatory**: if the controller key is lost, all secrets are permanently lost
4. **Large secret files in Git**: a 1000-character base64 secret produces a 1000+ character encrypted blob in Git history

## Section 2: External Secrets Operator — Deep Dive

### Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set resources.requests.memory=128Mi \
  --set resources.requests.cpu=100m \
  --set resources.limits.memory=512Mi \
  --set resources.limits.cpu=500m \
  --set webhook.enabled=true \
  --set certController.enabled=true \
  --set metrics.service.enabled=true
```

### SecretStore Configuration

```yaml
# ClusterSecretStore: available to all namespaces
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
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets

---
# AWS IAM policy for the service account (IRSA)
# Attach to the ServiceAccount via annotation:
# eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/external-secrets-role
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets-sa
  namespace: external-secrets
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-secrets-role"

---
# HashiCorp Vault store
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault
spec:
  provider:
    vault:
      server: "https://vault.example.com"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets

---
# GCP Secret Manager store
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: gcp-secrets
spec:
  provider:
    gcpsm:
      projectID: "my-gcp-project-id"
      auth:
        workloadIdentity:
          clusterLocation: "us-central1"
          clusterName: "my-cluster"
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
```

### ExternalSecret Resources

```yaml
# Basic ExternalSecret from AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: my-app-credentials
  namespace: production
spec:
  refreshInterval: 1h        # Check for rotation every hour
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: my-app-credentials  # Name of the Kubernetes Secret to create
    creationPolicy: Owner     # ESO owns this Secret (deletes it when ExternalSecret is deleted)
    deletionPolicy: Retain    # Keep the Secret even if ExternalSecret is deleted
    template:
      type: Opaque
      metadata:
        annotations:
          vault.hashicorp.com/agent-inject-status: "injected"
  data:
    # Single key from AWS Secrets Manager JSON
    - secretKey: database-password      # Key in Kubernetes Secret
      remoteRef:
        key: production/my-app          # AWS Secrets Manager secret name
        property: database_password     # JSON key within the secret value

    - secretKey: api-key
      remoteRef:
        key: production/my-app
        property: api_key

---
# ExternalSecret pulling an entire AWS secret as multiple keys
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
  dataFrom:
    - extract:
        key: production/database     # Pulls ALL keys from this JSON secret
      # The secret {"host":"db.internal","port":"5432","user":"app","pass":"secret"}
      # becomes: host, port, user, pass as Kubernetes Secret keys

---
# ExternalSecret from Vault with templating
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: tls-certificate
  namespace: ingress-nginx
spec:
  refreshInterval: 6h
  secretStoreRef:
    name: vault
    kind: ClusterSecretStore
  target:
    name: tls-wildcard-cert
    creationPolicy: Owner
    template:
      type: kubernetes.io/tls
      data:
        tls.crt: "{{ .certificate }}"
        tls.key: "{{ .private_key }}"
  data:
    - secretKey: certificate
      remoteRef:
        key: pki/wildcard-example-com
        property: certificate
    - secretKey: private_key
      remoteRef:
        key: pki/wildcard-example-com
        property: private_key
```

### Push Secrets (ESO Writing to External Backends)

```yaml
# PushSecret: write a Kubernetes Secret to an external backend
# Useful for seeding secrets into Vault from Kubernetes-managed secrets (cert-manager, etc.)
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-tls-to-vault
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRefs:
    - name: vault
      kind: ClusterSecretStore
  selector:
    secret:
      name: my-app-tls   # Source Kubernetes Secret
  data:
    - match:
        secretKey: tls.crt
        remoteRef:
          remoteKey: pki/my-app-cert
          property: certificate
    - match:
        secretKey: tls.key
        remoteRef:
          remoteKey: pki/my-app-cert
          property: private_key
```

## Section 3: Feature Comparison

| Feature | Sealed Secrets | External Secrets Operator |
|---------|---------------|--------------------------|
| Secret material in Git | Yes (encrypted) | No (only references) |
| External runtime dependency | None | Vault/AWS/GCP/Azure required |
| Multi-cluster sharing | Requires re-seal per cluster | Single backend serves all clusters |
| Automatic rotation sync | No (manual re-seal) | Yes (configurable refresh interval) |
| Dynamic secret generation | No | Yes (Vault dynamic secrets) |
| Secret backend independence | Not applicable | Can swap backends without re-sealing |
| Bootstrap problem | None | Need credentials to fetch credentials |
| Audit trail | Git history | External backend audit logs |
| Air-gapped environments | Yes (fully self-contained) | No (needs backend connectivity) |
| Setup complexity | Low | High (backend required) |
| Key rotation overhead | High (re-seal all secrets) | None |

## Section 4: Migration: Sealed Secrets to ESO

### Migration Strategy

The safest migration approach runs both systems in parallel, migrating one application at a time:

```bash
#!/bin/bash
# migrate-sealed-to-eso.sh
# Migrates a single application's secrets from Sealed Secrets to ESO

APP_NAME="$1"
NAMESPACE="$2"
VAULT_PATH="production/${APP_NAME}"

if [ -z "$APP_NAME" ] || [ -z "$NAMESPACE" ]; then
    echo "Usage: $0 <app-name> <namespace>"
    exit 1
fi

echo "Step 1: Export current secret values from Kubernetes"
# Get the currently decrypted secret (from the running cluster)
SECRETS=$(kubectl get secret "$APP_NAME" -n "$NAMESPACE" -o json)

echo "Step 2: Write to Vault"
# Extract each key and write to Vault
echo "$SECRETS" | jq -r '.data | keys[]' | while read KEY; do
    VALUE=$(echo "$SECRETS" | jq -r ".data[\"$KEY\"]" | base64 -d)
    vault kv put "$VAULT_PATH" "$KEY=$VALUE"
    echo "Written $KEY to Vault path $VAULT_PATH"
done

echo "Step 3: Create ExternalSecret manifest"
cat > "/tmp/${APP_NAME}-external-secret.yaml" << EOF
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${APP_NAME}
  namespace: ${NAMESPACE}
  labels:
    migrated-from: sealed-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault
    kind: ClusterSecretStore
  target:
    name: ${APP_NAME}
    creationPolicy: Owner
    deletionPolicy: Retain
  dataFrom:
    - extract:
        key: ${VAULT_PATH}
EOF

echo "Step 4: Apply ExternalSecret (will create/update the Kubernetes Secret)"
kubectl apply -f "/tmp/${APP_NAME}-external-secret.yaml"

echo "Step 5: Wait for secret sync"
kubectl wait externalsecret "${APP_NAME}" -n "${NAMESPACE}" \
  --for=condition=Ready \
  --timeout=60s

echo "Step 6: Verify secret values match"
# Compare original sealed secret values with new ESO-managed values
NEW_SECRETS=$(kubectl get secret "$APP_NAME" -n "$NAMESPACE" -o json)
echo "Old keys: $(echo "$SECRETS" | jq -r '.data | keys[]' | sort | tr '\n' ',')"
echo "New keys: $(echo "$NEW_SECRETS" | jq -r '.data | keys[]' | sort | tr '\n' ',')"

echo "Step 7: Delete SealedSecret (ExternalSecret now owns the Secret)"
kubectl delete sealedsecret "${APP_NAME}" -n "${NAMESPACE}"

echo "Migration complete for ${APP_NAME}"
```

### Bulk Migration Planning

```bash
# Inventory all SealedSecrets across the cluster
kubectl get sealedsecret -A -o json | \
  jq -r '.items[] | "\(.metadata.namespace)/\(.metadata.name)"' | \
  sort > sealed-secrets-inventory.txt

# Count by namespace
kubectl get sealedsecret -A --no-headers | awk '{print $1}' | sort | uniq -c | sort -rn

# Check which apps are high-priority (running pods that use these secrets)
kubectl get pods -A -o json | \
  jq -r '.items[] | .metadata.namespace + "/" + .metadata.name + " -> " +
    (.spec.volumes[]?.secret?.secretName // .spec.containers[]?.env[]?.valueFrom?.secretKeyRef?.name // "") |
    select(. != "")' | sort -u
```

## Section 5: Migration from ESO to Sealed Secrets

This is less common but necessary for air-gapped environments:

```bash
#!/bin/bash
# migrate-eso-to-sealed.sh

APP_NAME="$1"
NAMESPACE="$2"

echo "Step 1: Ensure the ESO-managed Secret exists"
kubectl get secret "$APP_NAME" -n "$NAMESPACE" || {
    echo "Error: Secret not found"
    exit 1
}

echo "Step 2: Seal the existing Secret"
kubectl get secret "$APP_NAME" -n "$NAMESPACE" -o yaml | \
  grep -v "kubectl.kubernetes.io/last-applied" | \
  grep -v "creationTimestamp" | \
  grep -v "resourceVersion" | \
  grep -v "uid:" | \
kubeseal \
  --controller-namespace=kube-system \
  --controller-name=sealed-secrets-controller \
  --scope=strict \
  --format=yaml \
  > "/tmp/${APP_NAME}-sealed.yaml"

echo "Step 3: Commit sealed secret to Git"
cp "/tmp/${APP_NAME}-sealed.yaml" "./secrets/${NAMESPACE}/${APP_NAME}-sealed.yaml"
git add "./secrets/${NAMESPACE}/${APP_NAME}-sealed.yaml"
git commit -m "chore: add sealed secret for ${NAMESPACE}/${APP_NAME} (migrated from ESO)"

echo "Step 4: Delete ExternalSecret (will trigger deletion of managed Secret)"
kubectl delete externalsecret "$APP_NAME" -n "$NAMESPACE"

echo "Step 5: Apply SealedSecret (controller decrypts and creates Secret)"
kubectl apply -f "./secrets/${NAMESPACE}/${APP_NAME}-sealed.yaml"

echo "Step 6: Verify"
kubectl get secret "$APP_NAME" -n "$NAMESPACE"
```

## Section 6: Secret Rotation Workflows

### Sealed Secrets Rotation

Every rotation requires a manual cycle:

```bash
#!/bin/bash
# rotate-sealed-secret.sh <name> <namespace> <key> <new-value>

SECRET_NAME="$1"
NAMESPACE="$2"
KEY="$3"
NEW_VALUE="$4"

# Get current SealedSecret YAML from Git
CURRENT_SS=$(kubectl get sealedsecret "$SECRET_NAME" -n "$NAMESPACE" -o yaml)

# Create a new Kubernetes Secret with updated value
# First extract all CURRENT values (requires cluster access to decrypt)
kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" -o json | \
  jq --arg key "$KEY" --arg val "$(echo -n "$NEW_VALUE" | base64)" \
     '.data[$key] = $val' | \
  kubectl apply -f - --dry-run=client -o yaml | \
kubeseal \
  --format=yaml \
  --controller-namespace=kube-system \
  --controller-name=sealed-secrets-controller \
  > "/tmp/${SECRET_NAME}-rotated.yaml"

# Apply the new SealedSecret
kubectl apply -f "/tmp/${SECRET_NAME}-rotated.yaml"

# Commit to Git
cp "/tmp/${SECRET_NAME}-rotated.yaml" "./secrets/${NAMESPACE}/${SECRET_NAME}.yaml"
git add "./secrets/${NAMESPACE}/${SECRET_NAME}.yaml"
git commit -m "security: rotate ${KEY} in ${NAMESPACE}/${SECRET_NAME}"
git push

echo "Rotation complete. Application pods may need rolling restart."
kubectl rollout restart deployment -l secret=${SECRET_NAME} -n "$NAMESPACE" 2>/dev/null || true
```

### ESO Rotation: AWS Secrets Manager

AWS Secrets Manager supports native rotation via Lambda functions. ESO automatically picks up the new value:

```bash
# AWS CLI: rotate secret immediately
aws secretsmanager rotate-secret \
  --secret-id production/my-app \
  --rotation-rules AutomaticallyAfterDays=30

# Force immediate rotation (useful for emergency rotation)
aws secretsmanager rotate-secret \
  --secret-id production/my-app \
  --rotate-immediately

# Check rotation status
aws secretsmanager describe-secret --secret-id production/my-app | \
  jq '{RotationEnabled, NextRotationDate, LastRotatedDate}'

# ESO will pick up the new value within refreshInterval (e.g., 1h)
# Force immediate sync:
kubectl annotate externalsecret my-app-credentials -n production \
  force-sync=$(date +%s) --overwrite
```

### ESO Rotation: HashiCorp Vault Dynamic Secrets

The most powerful rotation pattern: Vault generates new credentials on every read:

```yaml
# Vault policy for dynamic PostgreSQL credentials
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  refreshInterval: 15m     # New credentials every 15 minutes
  secretStoreRef:
    name: vault
    kind: ClusterSecretStore
  target:
    name: db-credentials
    creationPolicy: Owner
    template:
      data:
        PGHOST: "{{ .host }}"
        PGPORT: "5432"
        PGUSER: "{{ .username }}"
        PGPASSWORD: "{{ .password }}"
        PGDATABASE: "myapp"
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:5432/myapp"
  data:
    - secretKey: username
      remoteRef:
        key: database/creds/myapp-role
        property: username
        # Vault issues new credentials with a 15m lease
    - secretKey: password
      remoteRef:
        key: database/creds/myapp-role
        property: password
    - secretKey: host
      remoteRef:
        key: secret/data/production/database
        property: host
```

```hcl
# Vault configuration for dynamic PostgreSQL credentials
resource "vault_database_secret_backend_role" "myapp" {
  backend = vault_mount.db.path
  name    = "myapp-role"

  db_name = vault_database_secret_backend_connection.postgres.name

  creation_statements = [
    "CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' IN ROLE app_role;",
    "GRANT app_role TO \"{{name}}\";",
  ]

  revocation_statements = [
    "REVOKE app_role FROM \"{{name}}\";",
    "DROP ROLE IF EXISTS \"{{name}}\";",
  ]

  default_ttl = "15m"
  max_ttl     = "30m"
}
```

### ESO Rotation: Bulk Emergency Rotation

```bash
#!/bin/bash
# emergency-rotation.sh
# Immediately forces re-sync of all ExternalSecrets in a namespace

NAMESPACE="${1:-production}"

echo "Forcing re-sync of all ExternalSecrets in namespace: $NAMESPACE"

kubectl get externalsecrets -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}' | \
  tr ' ' '\n' | while read ES_NAME; do
    echo "Forcing sync: $ES_NAME"
    kubectl annotate externalsecret "$ES_NAME" -n "$NAMESPACE" \
      force-sync="$(date +%s)" \
      --overwrite
done

echo "Waiting for all ExternalSecrets to be Ready..."
kubectl wait externalsecret -n "$NAMESPACE" \
  --for=condition=Ready \
  --all \
  --timeout=120s

echo "Triggering rolling restart of all deployments (to pick up new secrets)"
kubectl rollout restart deployment -n "$NAMESPACE"
```

## Section 7: Observability and Auditing

### ESO Metrics

```promql
# External secrets sync failures
external_secrets_sync_calls_error{namespace="production"} > 0

# Time since last successful sync
time() - external_secrets_last_sync_time{namespace="production"} > 3600

# Secret provider calls by backend
rate(external_secrets_provider_api_calls_count_total[5m])
```

### ESO Alerting

```yaml
groups:
  - name: external-secrets
    rules:
      - alert: ExternalSecretSyncFailed
        expr: |
          external_secrets_sync_calls_error > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "ExternalSecret sync failing in {{ $labels.namespace }}/{{ $labels.name }}"

      - alert: ExternalSecretNotSynced
        expr: |
          time() - external_secrets_last_sync_time > 7200
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "ExternalSecret not synced in 2+ hours"

      - alert: SecretStoreConnectionFailed
        expr: |
          external_secrets_secret_store_status == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "SecretStore {{ $labels.name }} connection failed"
```

### Sealed Secrets Monitoring

```bash
# Check for any SealedSecrets that failed to decrypt
kubectl get sealedsecrets -A -o json | \
  jq '.items[] | select(.status.conditions[]?.type == "Synced" and .status.conditions[]?.status == "False") |
      "\(.metadata.namespace)/\(.metadata.name): \(.status.conditions[]?.message)"'

# Alert: SealedSecret sync failure
kubectl get events -A --field-selector reason=ErrUnsealFailed
```

## Section 8: Decision Framework

### When to Choose Sealed Secrets

Use Sealed Secrets when:
- You operate in air-gapped environments with no external network access
- Simplicity and self-containment are priorities (no external dependencies)
- Team size is small and secret rotation is infrequent
- All secrets are cluster-specific (no cross-cluster sharing needed)
- You want a simpler security model for compliance review

### When to Choose External Secrets Operator

Use External Secrets Operator when:
- You already use a secret backend (Vault, AWS Secrets Manager, etc.)
- You operate multiple clusters that need to share secrets
- Automated rotation without re-deploying code is a requirement
- Vault dynamic secrets provide significant security value (database credentials)
- You have a large team and want audit trails external to Kubernetes
- Secrets change frequently and the re-seal/commit cycle is too expensive

### Hybrid Approach

Many organizations run both:

```yaml
# Sealed Secrets for: bootstrap credentials, cross-cluster signing keys
# (things that must work before external secrets backend is available)

# ExternalSecret for: application credentials, database passwords, API keys
# (things that benefit from rotation and cross-cluster sharing)

# The bootstrap secret for ESO itself:
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: vault-approle-credentials
  namespace: external-secrets
spec:
  encryptedData:
    role-id: AgA...    # Encrypted Vault AppRole role-id
    secret-id: AgB...  # Encrypted Vault AppRole secret-id
```

## Conclusion

The Sealed Secrets vs ESO choice is not about which tool is better—it is about which security model matches your infrastructure:

1. **Sealed Secrets** treats the cluster's private key as the root of trust. Secret material lives in Git (encrypted), the cluster is self-sufficient, and the operational cost is paid during rotation cycles. The worst-case failure is key loss, which makes all sealed secrets permanently unrecoverable.

2. **ESO** treats external backends as the root of trust. Secret material never enters Git, rotation is automated, and multiple clusters can share a single secret definition. The worst-case failure is backend unavailability, which prevents new secrets from being created (existing Kubernetes Secrets continue to function).

Migration between the two is straightforward in either direction, and many production environments use both: Sealed Secrets for the bootstrap credentials needed before external backends are available, and ESO for everything else.
