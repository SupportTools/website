---
title: "Kubernetes GitOps Secrets Management: Sealed Secrets, ESO, and Vault Agent"
date: 2027-08-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets Management", "GitOps", "Vault", "External Secrets"]
categories:
- Security
- Kubernetes
- GitOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production-grade guide to Kubernetes GitOps secrets management covering Bitnami Sealed Secrets, External Secrets Operator with Vault/AWS/GCP backends, Vault Agent Injector, SOPS encryption, secret rotation automation, drift detection, and multi-environment secret strategy."
more_link: "yes"
url: "/kubernetes-gitops-secrets-management-guide/"
---

Secrets in Git is the original sin of Kubernetes adoption. Credentials, API keys, and TLS certificates committed in plaintext or weakly encoded base64 have caused countless production security incidents. GitOps workflows demand that all Kubernetes configuration lives in version control, creating an apparent contradiction: how do secrets remain both Git-managed and secure? This guide examines every viable pattern — Bitnami Sealed Secrets, External Secrets Operator, Vault Agent Injector, and SOPS — and provides the architecture guidance needed to choose the right approach for each tier of a multi-environment strategy.

<!--more-->

# [Kubernetes GitOps Secrets Management: Sealed Secrets, ESO, and Vault Agent](#kubernetes-gitops-secrets-management-guide)

## Section 1: The Problem of Secrets in Git

### Why Native Kubernetes Secrets Fail GitOps

Kubernetes Secrets are base64-encoded, not encrypted. A Secret stored in a Git repository exposes credentials to anyone with repository read access, CI/CD systems, and audit logs.

```bash
# The problem: base64 is trivially reversible
kubectl get secret api-credentials -n production -o jsonpath='{.data.api-key}' | base64 -d
# Output: sk-live-abc123def456
```

Git history compounds the problem — even after deletion, credentials remain in the commit history indefinitely.

### Threat Model

| Threat | Sealed Secrets | ESO | Vault Agent |
|---|---|---|---|
| Git repo compromise | Protected (asymmetric encryption) | Protected (no secret in git) | Protected (no secret in git) |
| Cluster compromise | Partial (key in cluster) | Partial (IRSA/SA token) | Partial (Vault token) |
| CI/CD compromise | Protected | Depends on CI access | Depends on CI access |
| Secret rotation complexity | Manual re-seal | Automatic (backend-driven) | Automatic (Vault policy) |
| Audit trail | Limited | ESO audit + backend | Vault audit log |
| Multi-cluster support | Per-cluster keys | Single backend, multi-cluster | Vault namespaces |

---

## Section 2: Bitnami Sealed Secrets Architecture

Sealed Secrets uses asymmetric encryption: a controller in the cluster holds a private key; the `kubeseal` CLI encrypts secrets using the corresponding public key. Only the controller can decrypt the resulting SealedSecret.

### Installation

```bash
# Install the Sealed Secrets controller
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update
helm upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --set fullnameOverride=sealed-secrets-controller \
  --set image.tag=v0.27.0 \
  --set keyrenewperiod=720h \
  --set rateLimit=2 \
  --set rateLimitCluster=50

# Install kubeseal CLI
curl -Lo /usr/local/bin/kubeseal \
  https://github.com/bitnami-labs/sealed-secrets/releases/latest/download/kubeseal-0.27.0-linux-amd64.tar.gz
# Extract from archive:
tar -xvzf kubeseal-0.27.0-linux-amd64.tar.gz kubeseal
mv kubeseal /usr/local/bin/
chmod +x /usr/local/bin/kubeseal
```

### kubeseal Encryption Workflow

```bash
# Step 1: Create a plain Kubernetes secret (NEVER commit this)
kubectl create secret generic api-credentials \
  --namespace production \
  --from-literal=api-key=sk-live-EXAMPLE_KEY_REPLACE_ME \
  --from-literal=api-secret=EXAMPLE_SECRET_REPLACE_ME \
  --dry-run=client \
  -o yaml > /tmp/secret-plaintext.yaml

# Step 2: Seal the secret using the cluster's public key
kubeseal \
  --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system \
  --format yaml \
  < /tmp/secret-plaintext.yaml \
  > gitops/secrets/production/api-credentials-sealed.yaml

# Step 3: Verify the sealed secret structure (safe to commit)
cat gitops/secrets/production/api-credentials-sealed.yaml

# Step 4: Delete the plaintext version
rm -f /tmp/secret-plaintext.yaml

# Step 5: Commit the sealed secret
git add gitops/secrets/production/api-credentials-sealed.yaml
git commit -m "feat: add api-credentials sealed secret for production"
```

### SealedSecret Manifest Structure

```yaml
# gitops/secrets/production/api-credentials-sealed.yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: api-credentials
  namespace: production
  annotations:
    sealedsecrets.bitnami.com/cluster-wide: "false"
spec:
  encryptedData:
    # These values are ciphertext — safe for Git storage
    api-key: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEq...
    api-secret: AgBY6mMYrRTBnLjMlXGbSYjp9Kp8Y3...
  template:
    metadata:
      name: api-credentials
      namespace: production
      labels:
        app: api-server
        managed-by: sealed-secrets
    type: Opaque
```

### Scope Options

```bash
# Namespace-scoped (default): only decryptable in the specified namespace
kubeseal --scope namespace-wide --namespace production ...

# Cluster-scoped: decryptable in any namespace (use sparingly)
kubeseal --scope cluster-wide ...

# Strict (default): name and namespace are part of the encryption context
# A strict SealedSecret cannot be renamed or moved
kubeseal --scope strict ...
```

### Key Rotation and Backup

```bash
# Backup the current sealing keys (STORE SECURELY — offline HSM or Vault)
kubectl get secret \
  -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
  -o yaml > sealed-secrets-keys-backup-$(date +%Y%m%d).yaml

# After key rotation, all existing SealedSecrets continue to work
# (old keys are retained for decryption)
# Re-seal secrets with new key for forward security:
for f in gitops/secrets/**/*-sealed.yaml; do
  kubeseal \
    --re-encrypt \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system \
    < "${f}" > "${f}.new" && mv "${f}.new" "${f}"
done
```

---

## Section 3: External Secrets Operator (ESO)

ESO is an operator that synchronizes secrets from external stores (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault) into Kubernetes Secrets. The secret values never live in Git.

### Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set replicaCount=2 \
  --set webhook.replicaCount=2 \
  --set certController.replicaCount=2 \
  --version 0.10.0
```

### ESO with AWS Secrets Manager

```yaml
# eso/cluster-secret-store-aws.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      # Use IRSA (IAM Roles for Service Accounts)
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
---
# eso/external-secret-aws.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-credentials
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: api-credentials
    creationPolicy: Owner
    deletionPolicy: Retain
    template:
      type: Opaque
      metadata:
        labels:
          app: api-server
          managed-by: external-secrets
  data:
  - secretKey: api-key
    remoteRef:
      key: production/api-server/credentials
      property: api_key
  - secretKey: api-secret
    remoteRef:
      key: production/api-server/credentials
      property: api_secret

  # Optionally pull entire JSON secret as individual keys
  dataFrom:
  - extract:
      key: production/api-server/tls
```

### ESO with HashiCorp Vault

```yaml
# eso/secret-store-vault.yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: production
spec:
  provider:
    vault:
      server: "https://vault.support.tools:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "production-api-server"
          serviceAccountRef:
            name: api-server-sa
---
# eso/external-secret-vault.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
  data:
  - secretKey: username
    remoteRef:
      key: secret/data/production/postgres
      property: username
  - secretKey: password
    remoteRef:
      key: secret/data/production/postgres
      property: password
  - secretKey: host
    remoteRef:
      key: secret/data/production/postgres
      property: host
```

### ESO with GCP Secret Manager

```yaml
# eso/secret-store-gcp.yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: gcp-secret-manager
  namespace: production
spec:
  provider:
    gcpsm:
      projectID: my-gcp-project-id
      auth:
        workloadIdentity:
          clusterLocation: us-east1
          clusterName: production-cluster
          serviceAccountRef:
            name: external-secrets-sa
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: gcp-api-credentials
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: gcp-secret-manager
    kind: SecretStore
  target:
    name: gcp-api-credentials
  data:
  - secretKey: service-account-json
    remoteRef:
      key: production-service-account
      version: latest
```

---

## Section 4: Vault Agent Injector

The Vault Agent Injector mutates pods at admission time, injecting a sidecar that authenticates to Vault and writes secrets to a shared in-memory volume. The application reads secrets from the filesystem rather than environment variables, reducing exposure in process memory dumps.

### Vault Server Setup for Kubernetes Auth

```bash
# Configure Kubernetes auth backend
vault auth enable kubernetes

vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc.cluster.local:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Create Vault policy for api-server
vault policy write api-server-policy - <<'EOF'
path "secret/data/production/api-server/*" {
  capabilities = ["read"]
}

path "secret/data/production/shared/*" {
  capabilities = ["read"]
}

# Allow token renewal
path "auth/token/renew-self" {
  capabilities = ["update"]
}

# Allow token lookup (for TTL checks)
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
EOF

# Create Vault role binding ServiceAccount to policy
vault write auth/kubernetes/role/api-server \
  bound_service_account_names="api-server-sa" \
  bound_service_account_namespaces="production" \
  policies="api-server-policy" \
  ttl=1h \
  max_ttl=24h
```

### Vault Agent Injection via Pod Annotations

```yaml
# deployment/api-server-vault-agent.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Enable Vault Agent injection
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "api-server"
        vault.hashicorp.com/auth-path: "auth/kubernetes"

        # Secret 1: database credentials
        vault.hashicorp.com/agent-inject-secret-database.env: >
          secret/data/production/postgres
        vault.hashicorp.com/agent-inject-template-database.env: |
          {{- with secret "secret/data/production/postgres" -}}
          export DB_USERNAME="{{ .Data.data.username }}"
          export DB_PASSWORD="{{ .Data.data.password }}"
          export DB_HOST="{{ .Data.data.host }}"
          export DB_PORT="5432"
          {{- end }}

        # Secret 2: TLS certificate
        vault.hashicorp.com/agent-inject-secret-tls.crt: >
          pki/issue/api-server
        vault.hashicorp.com/agent-inject-template-tls.crt: |
          {{- with pkiCert "pki/issue/api-server" "common_name=api-server.production.svc" -}}
          {{ .Cert }}
          {{- end }}

        # Pre-populate secrets before app container starts
        vault.hashicorp.com/agent-init-first: "true"
        vault.hashicorp.com/agent-pre-populate-only: "false"
        vault.hashicorp.com/secret-volume-path: /vault/secrets

        # Resource limits for the injected sidecar
        vault.hashicorp.com/agent-requests-cpu: "50m"
        vault.hashicorp.com/agent-requests-mem: "64Mi"
        vault.hashicorp.com/agent-limits-cpu: "100m"
        vault.hashicorp.com/agent-limits-mem: "128Mi"
    spec:
      serviceAccountName: api-server-sa
      containers:
      - name: api-server
        image: registry.support.tools/api-server:1.0.0
        command:
        - /bin/sh
        - -c
        - |
          # Source Vault-injected secrets
          source /vault/secrets/database.env
          exec /app/api-server
        volumeMounts:
        - name: secrets
          mountPath: /vault/secrets
          readOnly: true
      volumes:
      - name: secrets
        emptyDir:
          medium: Memory   # tmpfs — never written to disk
```

---

## Section 5: Vault Agent vs ESO Trade-offs

| Dimension | Vault Agent Injector | External Secrets Operator |
|---|---|---|
| Secret delivery mechanism | Sidecar writes to tmpfs | Kubernetes Secret object |
| Secret visibility in k8s | Not stored as k8s Secret | Stored as k8s Secret (encrypted etcd) |
| Rotation delivery | Live file update (app must re-read) | Secret object updated; pod restart may be needed |
| Supported backends | Vault only | Vault, AWS SM, GCP SM, Azure KV, 1Password, many more |
| Operational complexity | High (Vault dependency, sidecar management) | Medium (ESO operator, store config) |
| Audit trail | Vault audit log (per-request) | ESO logs + backend audit |
| GitOps compatibility | ExternalSecret CRDs in Git | ExternalSecret CRDs in Git |
| Performance overhead | Sidecar per pod | Shared ESO controller |

**Recommendation**: Use ESO for most workloads; use Vault Agent only when the security policy prohibits storing secret values as Kubernetes Secret objects (e.g., highly regulated environments where etcd encryption alone is insufficient).

---

## Section 6: SOPS for GitOps Encryption

SOPS (Secrets OPerationS) encrypts secret values in YAML/JSON files while preserving the file structure. It integrates with age, AWS KMS, GCP KMS, Azure Key Vault, and HashiCorp Vault.

### Installation

```bash
# Install SOPS
curl -Lo /usr/local/bin/sops \
  https://github.com/getsops/sops/releases/latest/download/sops-v3.9.0.linux.amd64
chmod +x /usr/local/bin/sops

# Install age (recommended encryption backend)
curl -Lo age.tar.gz \
  https://github.com/FiloSottile/age/releases/latest/download/age-v1.2.0-linux-amd64.tar.gz
tar -xzf age.tar.gz
mv age/age age/age-keygen /usr/local/bin/
```

### age Key Generation and Configuration

```bash
# Generate age key pair
age-keygen -o ~/.config/sops/age/keys.txt
# Output: Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p

# Configure SOPS to use age key
cat > .sops.yaml << 'EOF'
creation_rules:
  # Production secrets: require all operators' keys
  - path_regex: gitops/secrets/production/.*\.yaml
    age: >-
      age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p,
      age1y2x4g9z5ph9n8mflp7jvl3z2mf7tnwqr9d6h5t8k4x2n6sah8kcqjqhpl

  # Staging: single operator key
  - path_regex: gitops/secrets/staging/.*\.yaml
    age: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p

  # KMS for CI/CD pipelines (AWS)
  - path_regex: gitops/secrets/shared/.*\.yaml
    kms: arn:aws:kms:us-east-1:123456789012:key/EXAMPLE-KEY-ID-REPLACE-ME
    age: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
EOF
```

### Encrypting a Kubernetes Secret with SOPS

```bash
# Create plain secret YAML
cat > /tmp/database-secret.yaml << 'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: database-credentials
  namespace: production
type: Opaque
stringData:
  username: dbuser
  password: EXAMPLE_PASSWORD_REPLACE_ME
  host: postgres.production.svc.cluster.local
EOF

# Encrypt with SOPS
sops --encrypt /tmp/database-secret.yaml \
  > gitops/secrets/production/database-credentials.enc.yaml

# Verify: inspect the encrypted file (values are ciphertext)
cat gitops/secrets/production/database-credentials.enc.yaml

# Decrypt for inspection (requires the age key in SOPS_AGE_KEY_FILE)
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
sops --decrypt gitops/secrets/production/database-credentials.enc.yaml

# Edit in-place (SOPS decrypts, opens editor, re-encrypts on save)
sops gitops/secrets/production/database-credentials.enc.yaml
```

### SOPS Integration with Flux CD

```yaml
# flux/gotk-secret-decryption.yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: production-secrets
  namespace: flux-system
spec:
  interval: 10m
  sourceRef:
    kind: GitRepository
    name: production-gitops
  path: ./gitops/secrets/production
  prune: true
  decryption:
    provider: sops
    secretRef:
      name: sops-age-key
---
# Store the age private key as a cluster secret (bootstrap only)
apiVersion: v1
kind: Secret
metadata:
  name: sops-age-key
  namespace: flux-system
type: Opaque
stringData:
  age.agekey: |
    # created: 2027-01-01T00:00:00Z
    # public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
    AGE_PRIVATE_KEY_REPLACE_ME
```

---

## Section 7: Secret Rotation Automation

### AWS Secrets Manager Rotation with ESO

```yaml
# eso/rotation-aware-external-secret.yaml
# ESO automatically picks up new versions when refreshInterval elapses
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: rotating-database-credentials
  namespace: production
  annotations:
    # Tag for monitoring rotation events
    secret-rotation/enabled: "true"
    secret-rotation/max-age-hours: "24"
spec:
  # Refresh every 15 minutes — picks up rotated secrets quickly
  refreshInterval: 15m
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
    # On update, annotate with rotation timestamp
    template:
      metadata:
        annotations:
          secret-rotation/last-rotated: "{{ now | date \"2006-01-02T15:04:05Z07:00\" }}"
  data:
  - secretKey: password
    remoteRef:
      key: production/postgres/credentials
      property: password
      # Always fetch the latest version
      metadataPolicy: Fetch
```

### Rotation-Triggered Pod Restart

```yaml
# rollout-restart/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: secret-rotation-script
  namespace: production
data:
  rotate.sh: |
    #!/bin/bash
    # Triggered by Argo Events when a secret is rotated
    NAMESPACE="${1:-production}"
    SECRET="${2}"
    DEPLOYMENT="${3}"

    echo "Secret ${SECRET} rotated — restarting ${DEPLOYMENT}"
    kubectl rollout restart deployment/"${DEPLOYMENT}" -n "${NAMESPACE}"
    kubectl rollout status deployment/"${DEPLOYMENT}" -n "${NAMESPACE}" --timeout=5m
```

### Vault Dynamic Secrets for Database Credentials

```bash
# Configure Vault database secrets engine
vault secrets enable database

vault write database/config/postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="production-api-server" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.production.svc.cluster.local:5432/appdb?sslmode=require" \
  username="vault-admin" \
  password="VAULT_ADMIN_PASSWORD_REPLACE_ME"

# Create a role that generates short-lived credentials
vault write database/roles/production-api-server \
  db_name=postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# Test: generate credentials
vault read database/creds/production-api-server
# Returns unique username/password valid for 1 hour
```

---

## Section 8: Audit Logging Secrets Access

### ESO Audit Events

```yaml
# prometheus-rules/secret-audit.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: secret-access-audit
  namespace: monitoring
spec:
  groups:
  - name: security.secrets
    rules:
    - alert: ExternalSecretSyncFailed
      expr: |
        externalsecret_sync_calls_total{status="error"} > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "ExternalSecret sync failed for {{ $labels.name }}"

    - alert: SecretStoreUnhealthy
      expr: |
        externalsecret_provider_api_calls_total{status="error"}
        /
        externalsecret_provider_api_calls_total
        > 0.1
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "SecretStore API error rate > 10%"
```

### Falco Secret Access Detection

```yaml
# falco/secret-access-rules.yaml
- rule: Unauthorized Kubernetes Secret Read
  desc: >
    A process read a Kubernetes service account token or secret file
    without being in the approved list.
  condition: >
    open_read
    and container
    and fd.name pmatch (/var/run/secrets/kubernetes.io/serviceaccount/token,
                        /var/run/secrets/kubernetes.io/serviceaccount/ca.crt)
    and not proc.name in (approved_k8s_sa_readers)
    and not container.name in (approved_sa_reading_containers)
  output: >
    Unauthorized service account token read (
    user=%user.name
    proc=%proc.name
    container=%container.name
    namespace=%k8s.ns.name
    file=%fd.name
    )
  priority: WARNING
  tags: [secrets, kubernetes, compliance]

- rule: Secret Environment Variable Logging
  desc: >
    A process wrote what appears to be a secret to stdout/stderr,
    risking credential exposure in logs.
  condition: >
    (evt.type in (write, writev))
    and fd.num in (1, 2)
    and container
    and (
      evt.arg.data pmatch (password=*, api_key=*, secret=*, token=*)
    )
  output: >
    Potential secret in stdout/stderr (
    container=%container.name
    namespace=%k8s.ns.name
    proc=%proc.name
    )
  priority: WARNING
  tags: [secrets, logging, compliance]
```

---

## Section 9: Detecting Secret Drift

Secret drift occurs when the value in the cluster diverges from the source of truth (the sealed secret or external backend). This can happen due to manual `kubectl edit secret` operations that bypass GitOps.

### Drift Detection with ESO

ESO automatically reconciles drift — if someone manually edits a synced secret, ESO overwrites it on the next refresh cycle. Monitor this via ESO events:

```bash
# Watch for drift correction events
kubectl get events -n production \
  --field-selector reason=Updated \
  -o custom-columns='TIME:.firstTimestamp,OBJECT:.involvedObject.name,MESSAGE:.message' | \
  grep -i "secret"
```

### Sealed Secrets Drift Detection Script

```bash
#!/bin/bash
# detect-secret-drift.sh
# Compares the checksum of decrypted SealedSecrets against the live Secret

NS="${1:-production}"

echo "=== Sealed Secret Drift Detection ==="
kubectl get sealedsecrets -n "${NS}" -o json | \
  jq -r '.items[].metadata.name' | while read SS_NAME; do
    # Get the SealedSecret's managed Secret generation
    SEALED_GEN=$(kubectl get sealedsecret "${SS_NAME}" -n "${NS}" \
      -o jsonpath='{.status.observedGeneration}' 2>/dev/null)

    # Check if a corresponding plain Secret exists
    if kubectl get secret "${SS_NAME}" -n "${NS}" &>/dev/null; then
      # Check if the Secret has been manually modified
      # (annotation set by sealed-secrets controller on creation)
      CONTROLLER_MANAGED=$(kubectl get secret "${SS_NAME}" -n "${NS}" \
        -o jsonpath='{.metadata.annotations.sealedsecrets\.bitnami\.com/managed}')

      if [ "${CONTROLLER_MANAGED}" != "true" ]; then
        echo "DRIFT DETECTED: ${NS}/${SS_NAME} — secret exists but is not controller-managed"
      else
        echo "OK: ${NS}/${SS_NAME} — managed by sealed-secrets controller"
      fi
    else
      echo "MISSING: ${NS}/${SS_NAME} — sealed secret exists but no corresponding Secret"
    fi
  done
```

### Git-Based Drift Detection (Pre-Commit Hook)

```bash
#!/bin/bash
# .git/hooks/pre-commit
# Block commits that contain unencrypted Kubernetes Secrets

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

for FILE in ${STAGED_FILES}; do
  # Check if the file looks like a Kubernetes Secret
  if echo "${FILE}" | grep -qE '\.(yaml|yml)$'; then
    if git show ":${FILE}" 2>/dev/null | grep -q "^kind: Secret$"; then
      # Check if it's a SealedSecret (allowed)
      if ! git show ":${FILE}" 2>/dev/null | grep -q "^kind: SealedSecret$"; then
        echo "ERROR: Unencrypted Kubernetes Secret detected: ${FILE}"
        echo "Use 'kubeseal' to encrypt before committing, or use ExternalSecret/SealedSecret."
        exit 1
      fi
    fi

    # Block plaintext credential patterns
    if git show ":${FILE}" 2>/dev/null | grep -qE '(password|api_key|secret_key|private_key)\s*:\s*["\x27][^"\x27]{8,}'; then
      echo "WARNING: Possible plaintext credential in: ${FILE}"
      echo "Review and encrypt before committing."
      exit 1
    fi
  fi
done

exit 0
```

---

## Section 10: Multi-Environment Secret Strategy

### Environment Tier Architecture

```
Repository Structure:
gitops/
├── secrets/
│   ├── base/              # Non-sensitive defaults (feature flags, config)
│   ├── development/       # SOPS-encrypted or Sealed Secrets (low risk)
│   │   └── database-credentials.enc.yaml
│   ├── staging/           # SealedSecrets or ESO (mirrors production pattern)
│   │   └── database-credentials-sealed.yaml
│   └── production/        # ESO pointing to production Vault/AWS SM
│       ├── external-secret-database.yaml   # Safe to commit
│       └── external-secret-tls.yaml        # Safe to commit
├── cluster-stores/        # SecretStore/ClusterSecretStore configs
│   ├── development/
│   │   └── local-vault-store.yaml
│   ├── staging/
│   │   └── aws-sm-store.yaml
│   └── production/
│       └── vault-store.yaml
└── kustomization.yaml
```

### Kustomize Overlays for Per-Environment Secrets

```yaml
# gitops/secrets/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- external-secret-database.yaml
- external-secret-cache.yaml
---
# gitops/secrets/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base
- cluster-store.yaml
patches:
- patch: |-
    - op: replace
      path: /spec/secretStoreRef/name
      value: vault-production
    - op: replace
      path: /spec/refreshInterval
      value: 15m
  target:
    kind: ExternalSecret
---
# gitops/secrets/staging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base
- cluster-store.yaml
patches:
- patch: |-
    - op: replace
      path: /spec/secretStoreRef/name
      value: aws-sm-staging
    - op: replace
      path: /spec/refreshInterval
      value: 1h
  target:
    kind: ExternalSecret
```

### Decision Matrix: Which Tool Per Environment

```yaml
# docs/secret-strategy-decision-matrix.yaml
# Not a Kubernetes resource — documentation artifact
strategy:
  development:
    tool: sops-with-age
    rationale: >
      Developers can commit SOPS-encrypted secrets with a shared team key.
      Low risk; no production credentials involved.
    rotation: Manual; annual key rotation
    audit: Git history

  staging:
    tool: sealed-secrets
    rationale: >
      Mirrors production workflow without requiring Vault/AWS infrastructure.
      Automated testing of SealedSecret workflows before production deployment.
    rotation: Re-seal on certificate renewal (annual)
    audit: Kubernetes API audit log

  production:
    tool: external-secrets-operator
    backend: hashicorp-vault
    rationale: >
      No secret values in Git; centralized audit in Vault; dynamic
      database credentials via Vault database engine eliminate long-lived
      credential exposure.
    rotation: Automatic via Vault leases (1h for database, 24h for API keys)
    audit: Vault audit log + Falco runtime detection
```

---

## Summary

Secrets management in GitOps-driven Kubernetes environments requires a deliberate architectural decision rather than a single universal solution. Sealed Secrets provides the simplest path to committing encrypted secrets in Git, with the trade-off of cluster-tied keys and manual rotation workflows. External Secrets Operator decouples secret storage from Kubernetes entirely, enabling centralized management across multiple clusters with automatic rotation and rich audit trails from backend services like Vault and AWS Secrets Manager. Vault Agent Injector provides the highest security posture for regulated environments by ensuring secret values never materialize as Kubernetes Secret objects. SOPS with age fills the gap for developer workflows where simple file-level encryption is sufficient. A mature multi-environment strategy uses each tool in its appropriate tier — SOPS for development, Sealed Secrets for staging validation, and ESO backed by Vault or a cloud-native secrets manager for production workloads requiring auditability, rotation automation, and drift detection.
