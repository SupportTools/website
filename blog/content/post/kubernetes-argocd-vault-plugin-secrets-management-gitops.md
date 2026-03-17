---
title: "Kubernetes ArgoCD Vault Plugin: Secrets Management for GitOps Workflows"
date: 2030-09-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ArgoCD", "HashiCorp Vault", "GitOps", "Secrets Management", "Security"]
categories:
- Kubernetes
- GitOps
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise ArgoCD Vault Plugin (AVP) guide covering plugin installation and authentication, secret placeholder syntax, templated secrets in Helm and Kustomize, Vault AppRole and Kubernetes auth, dynamic secrets in ArgoCD, and auditing secret access in GitOps pipelines."
more_link: "yes"
url: "/kubernetes-argocd-vault-plugin-secrets-management-gitops/"
---

GitOps creates a tension with secrets management: the entire point of GitOps is that Git is the source of truth, but secrets must never be committed to Git in plaintext. The ArgoCD Vault Plugin (AVP) resolves this tension by treating secret values as placeholders in Git-committed manifests, fetching actual values from Vault at sync time. The manifests in Git describe the structure of secrets without containing the values — Vault contains the values without describing the structure. Together they produce the final Kubernetes Secret objects.

<!--more-->

## How ArgoCD Vault Plugin Works

The plugin operates as a config management plugin in ArgoCD's application rendering pipeline:

```
Git Repository (with placeholders)
    │
    ▼
ArgoCD Application Sync
    │
    ▼
AVP Plugin (argocd-repo-server sidecar)
    │  1. Read manifest templates from Git
    │  2. Find placeholder strings: <path:secret/data/myapp#key>
    │  3. Authenticate to Vault
    │  4. Fetch secret values from Vault
    │  5. Replace placeholders with actual values
    ▼
Final Kubernetes Manifests (with actual secret values)
    │
    ▼
ArgoCD applies to cluster
```

The key insight: secret values never touch Git. The Git history shows the placeholder syntax. Vault audit logs show every secret access by the ArgoCD sync agent.

## Plugin Installation Methods

### Method 1: ArgoCD Image Updater / Sidecar Container (Recommended)

Install AVP as a sidecar to the `argocd-repo-server` deployment, which handles manifest rendering:

```yaml
# Patch argocd-repo-server to add AVP sidecar
# Apply via Kustomize overlay on top of official ArgoCD install

# kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - https://raw.githubusercontent.com/argoproj/argo-cd/v2.12.0/manifests/install.yaml

patches:
  - path: argocd-repo-server-avp-patch.yaml
    target:
      kind: Deployment
      name: argocd-repo-server

configMapGenerator:
  - name: argocd-cmp-cm
    behavior: merge
    files:
      - avp-helm.yaml
      - avp-kustomize.yaml
```

```yaml
# argocd-repo-server-avp-patch.yaml
- op: add
  path: /spec/template/spec/volumes/-
  value:
    name: custom-tools
    emptyDir: {}

- op: add
  path: /spec/template/spec/initContainers/-
  value:
    name: download-tools
    image: alpine:3.19
    command: [sh, -c]
    args:
      - |
        AVP_VERSION="1.18.1"
        cd /custom-tools
        wget -qO argocd-vault-plugin \
          "https://github.com/argoproj-labs/argocd-vault-plugin/releases/download/v${AVP_VERSION}/argocd-vault-plugin_${AVP_VERSION}_linux_amd64"
        chmod +x argocd-vault-plugin
        echo "AVP installed: $(./argocd-vault-plugin version)"
    volumeMounts:
      - name: custom-tools
        mountPath: /custom-tools

- op: add
  path: /spec/template/spec/containers/-
  value:
    name: avp
    command: [/var/run/argocd/argocd-cmp-server]
    image: quay.io/argoproj/argocd:v2.12.0
    securityContext:
      runAsNonRoot: true
      runAsUser: 999
    env:
      - name: AVP_TYPE
        value: vault
      - name: AVP_AUTH_TYPE
        value: k8s
      - name: AVP_K8S_ROLE
        value: argocd
      - name: VAULT_ADDR
        value: https://vault.vault.svc.cluster.local:8200
      - name: VAULT_SKIP_VERIFY
        value: "false"
      - name: VAULT_CAPATH
        value: /vault-tls/ca.crt
    volumeMounts:
      - name: var-files
        mountPath: /var/run/argocd
      - name: plugins
        mountPath: /home/argocd/cmp-server/plugins
      - name: tmp
        mountPath: /tmp
      - name: cmp-tmp
        mountPath: /tmp/cmp
      - name: custom-tools
        mountPath: /usr/local/bin
      - name: argocd-cmp-cm
        mountPath: /home/argocd/cmp-server/config/plugin.yaml
        subPath: avp-helm.yaml
      - name: vault-tls
        mountPath: /vault-tls
        readOnly: true

- op: add
  path: /spec/template/spec/volumes/-
  value:
    name: cmp-tmp
    emptyDir: {}

- op: add
  path: /spec/template/spec/volumes/-
  value:
    name: vault-tls
    secret:
      secretName: vault-tls-ca
```

### Plugin Configuration (ConfigManagementPlugin)

```yaml
# avp-helm.yaml - AVP plugin for Helm applications
apiVersion: argoproj.io/v1alpha1
kind: ConfigManagementPlugin
metadata:
  name: argocd-vault-plugin-helm
spec:
  allowConcurrency: true
  discover:
    find:
      command:
        - find
        - "."
        - -name
        - "Chart.yaml"
  generate:
    command:
      - bash
      - "-c"
      - |
        helm template $ARGOCD_APP_NAME \
          --include-crds \
          -n $ARGOCD_APP_NAMESPACE \
          -f <(echo "$ARGOCD_ENV_HELM_VALUES") \
          . | argocd-vault-plugin generate -
  lockRepo: false
```

```yaml
# avp-kustomize.yaml - AVP plugin for Kustomize applications
apiVersion: argoproj.io/v1alpha1
kind: ConfigManagementPlugin
metadata:
  name: argocd-vault-plugin-kustomize
spec:
  allowConcurrency: true
  discover:
    find:
      command:
        - find
        - "."
        - -name
        - "kustomization.yaml"
  generate:
    command:
      - bash
      - "-c"
      - |
        kustomize build --enable-helm . | argocd-vault-plugin generate -
  lockRepo: false
```

## Vault Authentication for ArgoCD

### Kubernetes Auth Method (Recommended)

Vault's Kubernetes auth method allows the ArgoCD service account to authenticate using its JWT token:

```bash
# Configure Kubernetes auth in Vault
vault auth enable kubernetes

# Configure the auth method to validate against the cluster
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc.cluster.local" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token \
  issuer="https://kubernetes.default.svc.cluster.local"

# Create a Vault policy for ArgoCD
vault policy write argocd - << 'EOF'
# Allow reading all application secrets
path "secret/data/apps/*" {
  capabilities = ["read"]
}

# Allow reading cluster-level secrets
path "secret/data/clusters/*" {
  capabilities = ["read"]
}

# Allow reading dynamic database credentials
path "database/creds/readonly-*" {
  capabilities = ["read"]
}

# Allow renewing leases on dynamic credentials
path "sys/leases/renew" {
  capabilities = ["update"]
}
EOF

# Create role binding the Kubernetes service account to the Vault policy
vault write auth/kubernetes/role/argocd \
  bound_service_account_names=argocd-repo-server \
  bound_service_account_namespaces=argocd \
  policies=argocd \
  ttl=1h \
  max_ttl=24h
```

### AppRole Authentication

AppRole is preferred when ArgoCD runs outside the Kubernetes cluster that Vault is aware of:

```bash
# Enable AppRole auth
vault auth enable approle

# Create AppRole for ArgoCD
vault write auth/approle/role/argocd \
  token_policies=argocd \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0  # Non-expiring secret ID

# Get role ID (non-sensitive, can be in ConfigMap)
vault read -field=role_id auth/approle/role/argocd/role-id

# Get secret ID (sensitive, store in Kubernetes Secret)
vault write -field=secret_id -f auth/approle/role/argocd/secret-id
```

```yaml
# Store AppRole credentials as Kubernetes Secret
apiVersion: v1
kind: Secret
metadata:
  name: argocd-vault-approle
  namespace: argocd
type: Opaque
stringData:
  AVP_ROLE_ID: "<vault-approle-role-id>"
  AVP_SECRET_ID: "<vault-approle-secret-id>"
```

```yaml
# Reference in AVP sidecar environment
env:
  - name: AVP_TYPE
    value: vault
  - name: AVP_AUTH_TYPE
    value: approle
  - name: VAULT_ADDR
    value: https://vault.example.com:8200
  - name: AVP_ROLE_ID
    valueFrom:
      secretKeyRef:
        name: argocd-vault-approle
        key: AVP_ROLE_ID
  - name: AVP_SECRET_ID
    valueFrom:
      secretKeyRef:
        name: argocd-vault-approle
        key: AVP_SECRET_ID
```

## Secret Placeholder Syntax

AVP supports a flexible placeholder syntax to reference secrets from Vault.

### KV v2 Secret Engine Paths

```yaml
# Full path syntax: <path:SECRET_PATH#KEY>
# path:   Vault KV v2 path (after the 'data' component is implicit)
# KEY:    Field within the secret

apiVersion: v1
kind: Secret
metadata:
  name: app-credentials
  namespace: production
  # AVP annotations can override defaults
  annotations:
    avp.kubernetes.io/path: "secret/data/apps/myapp"
type: Opaque
stringData:
  # Short syntax using avp.kubernetes.io/path annotation
  db-password: <db-password>
  api-key: <api-key>

  # Full path syntax (overrides annotation)
  oauth-secret: <path:secret/data/apps/oauth#client_secret>

  # Versioned secret (specific version)
  legacy-key: <path:secret/data/apps/myapp#legacy_key#3>
```

### Environment Variables as Placeholders

```yaml
# Reference Vault paths using ArgoCD app parameters
metadata:
  annotations:
    # Dynamic path based on ArgoCD app parameters
    avp.kubernetes.io/path: "secret/data/apps/<name>/<env>"
```

### Complex Secret Structures

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: database-config
  namespace: production
  annotations:
    avp.kubernetes.io/path: "secret/data/apps/myapp/database"
type: Opaque
stringData:
  # Compose a connection string from multiple Vault fields
  connection-string: "postgresql://<username>:<password>@<host>:5432/<database>?sslmode=require"
  # Individual fields
  host: <host>
  port: <port>
  username: <username>
  password: <password>
  database: <database>
```

## Using AVP with Helm

### Helm Values with Secret References

```yaml
# values.yaml in Git (safe to commit - no secret values)
app:
  name: my-application
  replicas: 3

database:
  host: db.internal.example.com
  port: 5432
  name: myapp_prod
  # Placeholder - actual value comes from Vault
  password: <path:secret/data/apps/myapp/database#password>

redis:
  host: redis.internal.example.com
  password: <path:secret/data/apps/myapp/redis#password>

api:
  external_api_key: <path:secret/data/apps/myapp/external-apis#payments_api_key>
  webhook_secret: <path:secret/data/apps/myapp/webhooks#signing_secret>
```

```yaml
# templates/secret.yaml in Helm chart
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-secrets
  namespace: {{ .Release.Namespace }}
type: Opaque
stringData:
  DB_PASSWORD: {{ .Values.database.password | quote }}
  REDIS_PASSWORD: {{ .Values.redis.password | quote }}
  API_KEY: {{ .Values.api.external_api_key | quote }}
  WEBHOOK_SECRET: {{ .Values.api.webhook_secret | quote }}
```

### ArgoCD Application Using AVP-Helm Plugin

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-application
  namespace: argocd
spec:
  project: production
  source:
    repoURL: https://github.com/myorg/k8s-manifests.git
    targetRevision: main
    path: apps/my-application
    plugin:
      name: argocd-vault-plugin-helm
      env:
        # Pass environment-specific Vault paths
        - name: ARGOCD_ENV_HELM_VALUES
          value: |
            environment: production
            vaultPath: secret/data/apps/my-application/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

## Using AVP with Kustomize

### Kustomize SecretGenerator with AVP

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml
  - service.yaml

secretGenerator:
  - name: app-secrets
    # Using envs file with AVP placeholders
    envs:
      - secrets.env
    options:
      disableNameSuffixHash: true
```

```bash
# base/secrets.env - committed to Git (placeholders, not values)
DB_PASSWORD=<path:secret/data/apps/myapp#db_password>
API_KEY=<path:secret/data/apps/myapp#api_key>
SMTP_PASSWORD=<path:secret/data/apps/myapp/smtp#password>
```

```yaml
# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

bases:
  - ../../base

patches:
  - path: replica-count.yaml

# Override with production-specific Vault paths
secretGenerator:
  - name: app-secrets
    envs:
      - secrets-prod.env
    options:
      disableNameSuffixHash: true
      behavior: replace
```

```bash
# overlays/production/secrets-prod.env
DB_PASSWORD=<path:secret/data/apps/myapp/production#db_password>
API_KEY=<path:secret/data/apps/myapp/production#api_key>
SMTP_PASSWORD=<path:secret/data/apps/myapp/production/smtp#password>
```

## Dynamic Secrets with Vault

Dynamic secrets generated by Vault (database credentials, AWS credentials) present a challenge for ArgoCD: the secret values change with each issuance and have TTLs.

### Database Dynamic Credentials

```bash
# Configure Vault database secrets engine
vault secrets enable database

vault write database/config/myapp-db \
  plugin_name=postgresql-database-plugin \
  allowed_roles="myapp-readonly,myapp-readwrite" \
  connection_url="postgresql://{{username}}:{{password}}@db.internal.example.com:5432/myapp?sslmode=require" \
  username="vault-admin" \
  password="<vault-db-admin-password>"

vault write database/roles/myapp-readonly \
  db_name=myapp-db \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="4h"
```

```yaml
# Secret template for dynamic database credentials
apiVersion: v1
kind: Secret
metadata:
  name: database-credentials
  namespace: production
  annotations:
    # Dynamic path using database secrets engine
    avp.kubernetes.io/path: "database/creds/myapp-readonly"
type: Opaque
stringData:
  # AVP reads dynamic credentials from 'username' and 'password' fields
  DB_USER: <username>
  DB_PASS: <password>
```

The challenge with dynamic secrets in ArgoCD is that each sync creates new credentials. The application must handle credential rotation gracefully (connection pooling libraries like pgbouncer help here) or use External Secrets Operator alongside AVP for rotation management.

### External Secrets Operator as Alternative

For dynamic secrets that need rotation without a full ArgoCD sync, consider using External Secrets Operator (ESO) for dynamic secrets while using AVP for static ones:

```yaml
# ExternalSecret for dynamic database credentials (rotated by ESO)
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  refreshInterval: 45m  # Refresh before 1h TTL expires
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
  data:
    - secretKey: DB_USER
      remoteRef:
        key: database/creds/myapp-readonly
        property: username
    - secretKey: DB_PASS
      remoteRef:
        key: database/creds/myapp-readonly
        property: password
```

## ArgoCD Application Project Security

Restrict which Vault paths each ArgoCD project can access via RBAC:

```yaml
# argocd-appproject.yaml
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: production-team-a
  namespace: argocd
spec:
  description: "Team A production applications"
  sourceRepos:
    - https://github.com/myorg/team-a-manifests.git
  destinations:
    - namespace: team-a-production
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
  namespaceResourceWhitelist:
    - group: "*"
      kind: "*"

  # Restrict which Vault paths this project can access
  # by configuring a project-specific AVP configuration
  roles:
    - name: deployer
      policies:
        - p, proj:production-team-a:deployer, applications, sync, production-team-a/*, allow
      groups:
        - team-a-deployers
```

```bash
# Vault policy scoped to team-a paths only
vault policy write argocd-team-a - << 'EOF'
path "secret/data/apps/team-a/*" {
  capabilities = ["read"]
}

path "secret/data/clusters/production/team-a/*" {
  capabilities = ["read"]
}

# Explicitly deny access to other teams' paths
path "secret/data/apps/team-b/*" {
  capabilities = ["deny"]
}
EOF

# Create team-a specific Kubernetes role
vault write auth/kubernetes/role/argocd-team-a \
  bound_service_account_names=argocd-repo-server \
  bound_service_account_namespaces=argocd \
  policies=argocd-team-a \
  ttl=1h
```

## Auditing Secret Access in GitOps Pipelines

### Vault Audit Log Configuration

```bash
# Enable file audit device
vault audit enable file file_path=/var/log/vault/audit.log

# Enable syslog for structured logging integration
vault audit enable syslog tag="vault" facility="AUTH"

# Verify audit is enabled
vault audit list
```

### Parsing Vault Audit Logs for ArgoCD Access

```bash
# Filter audit logs for ArgoCD sync operations
# Vault audit logs are JSONL format

# Find all secret reads by ArgoCD
cat /var/log/vault/audit.log | \
  jq -r 'select(.auth.display_name | contains("argocd")) |
    "\(.time) \(.auth.display_name) \(.request.path) \(.response.data.data | keys // [] | join(","))"'

# Aggregate by secret path and time
cat /var/log/vault/audit.log | \
  jq -r 'select(.auth.display_name | contains("argocd")) | .request.path' | \
  sort | uniq -c | sort -rn | head -20

# Alert on access to sensitive paths
cat /var/log/vault/audit.log | \
  jq -r 'select(.request.path | test("secret/data/apps/.*/production")) |
    select(.auth.display_name != "argocd") |
    "ALERT: Non-ArgoCD access to production secret: \(.auth.display_name) -> \(.request.path)"'
```

### OpenTelemetry Integration for Secret Access Tracing

```yaml
# Vault audit logs to OpenTelemetry via Fluent Bit
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-vault-audit
  namespace: vault
data:
  fluent-bit.conf: |
    [SERVICE]
        Flush 5
        Log_Level info

    [INPUT]
        Name tail
        Path /var/log/vault/audit.log
        Parser json
        Tag vault.audit

    [FILTER]
        Name grep
        Match vault.audit
        Regex auth.display_name argocd

    [FILTER]
        Name record_modifier
        Match vault.audit
        Record source vault-audit
        Record cluster production-cluster

    [OUTPUT]
        Name opentelemetry
        Match vault.audit
        Host otel-collector.monitoring.svc.cluster.local
        Port 4318
        logs_uri /v1/logs
```

## Troubleshooting AVP

### Common Issues

**Issue: Placeholder not replaced, appears literally in Secret**

```bash
# Check AVP logs in the argocd-repo-server pod
kubectl logs -n argocd deployment/argocd-repo-server -c avp --tail=100

# Verify Vault path exists and is accessible
vault kv get secret/apps/myapp

# Test AVP rendering manually
export VAULT_ADDR=https://vault.example.com:8200
export VAULT_TOKEN=<vault-token>
argocd-vault-plugin generate ./manifests/

# Check if placeholder syntax is correct
echo "DB_PASSWORD: <path:secret/data/apps/myapp#db_password>" | \
  argocd-vault-plugin generate -
```

**Issue: Authentication failure**

```bash
# Test Kubernetes auth manually
JWT=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
vault write auth/kubernetes/login \
  role=argocd \
  jwt=$JWT

# Verify role binding
vault read auth/kubernetes/role/argocd
```

**Issue: Sync fails with "secret path not found"**

```bash
# Verify the secret path with correct KV v2 syntax
# KV v2 stores at secret/data/<path>, metadata at secret/metadata/<path>
vault kv get -mount=secret apps/myapp

# Check Vault policy allows the path
vault token capabilities <token> secret/data/apps/myapp
```

### AVP Debug Mode

```yaml
# Enable debug logging in AVP sidecar
env:
  - name: AVP_LOG_LEVEL
    value: debug
  - name: VAULT_LOG_LEVEL
    value: debug
```

## Production Considerations

A production AVP deployment requires attention to several operational concerns:

**Secret rotation**: When Vault secrets rotate, ArgoCD applications using those secrets must sync again to pick up new values. Use ArgoCD's refresh and sync automation, or configure post-rotation webhooks that trigger ArgoCD sync.

**Vault HA**: The AVP sidecar's Vault connectivity is on the application sync path. Vault downtime = ArgoCD sync failure. Deploy Vault with 3+ nodes and Raft integrated storage for HA.

**Audit retention**: Vault audit logs capture every secret access with the full path. Retain these logs according to your compliance requirements (PCI DSS requires 1 year, SOC 2 requires audit trail for review period).

**Token TTL management**: Kubernetes auth tokens issued to AVP have a TTL. Long-running sync operations may encounter expired tokens. The `TTL: 1h` and `max_ttl: 24h` settings in the Kubernetes role balance security and operational continuity.

**Placeholder scanning in CI**: Add a pre-commit hook or CI check that verifies all placeholder strings follow the correct AVP syntax. Malformed placeholders silently appear as literal strings in secrets rather than failing with an error.

AVP transforms secrets management from a manual operational process into an auditable, Git-native workflow. Combined with Vault's robust access control and audit capabilities, it provides the security properties required for enterprise compliance while maintaining the developer experience benefits of GitOps.
