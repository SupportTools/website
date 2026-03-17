---
title: "Kubernetes Secrets Management: External Secrets Operator with Vault and AWS SSM"
date: 2029-08-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets", "HashiCorp Vault", "AWS SSM", "External Secrets", "Security", "GitOps"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes secrets management using External Secrets Operator with HashiCorp Vault and AWS SSM/Secrets Manager, including ExternalSecret CRD patterns, SecretStore configuration, and automatic secret rotation."
more_link: "yes"
url: "/kubernetes-secrets-management-external-secrets-operator-vault-aws-ssm/"
---

Storing secrets in Kubernetes native Secrets is problematic: they are base64-encoded (not encrypted), they often end up in Git, and they lack audit trails. External Secrets Operator (ESO) solves this by treating external secret stores as the source of truth and syncing secrets into Kubernetes without ever committing them to version control. This guide covers production-ready ESO configuration with HashiCorp Vault and AWS SSM/Secrets Manager, including automatic rotation.

<!--more-->

# Kubernetes Secrets Management: External Secrets Operator with Vault and AWS SSM

## Why External Secrets Operator

The fundamental problem with Kubernetes Secrets:

1. **Base64 is not encryption** — anyone with `kubectl get secret` access can read all values
2. **ETCD encryption at rest** solves storage but not access control granularity
3. **GitOps workflows** require secrets in Git, which is dangerous
4. **Rotation** requires manual updates and Pod restarts
5. **Audit trails** are limited — no native "who read this secret when"

External Secrets Operator addresses all of these by:
- Pulling secrets from secure stores (Vault, AWS SSM, GCP SM, Azure KV) at runtime
- Never storing plaintext values in Git — only references
- Enabling per-secret IAM/policy-based access control
- Supporting automatic rotation via polling or webhook triggers

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                         │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  External Secrets Operator (ESO)                     │  │
│  │                                                      │  │
│  │  ┌─────────────────┐    ┌────────────────────────┐  │  │
│  │  │  ClusterSecretStore│   │  SecretStore (namespaced)│  │
│  │  │  (global)       │    │  (per-namespace)       │  │
│  │  └────────┬────────┘    └──────────┬─────────────┘  │  │
│  │           │                        │                 │  │
│  │  ┌────────┴────────────────────────┴──────────────┐  │  │
│  │  │           ExternalSecret CRD                   │  │  │
│  │  │  (defines what to pull and how to map it)      │  │  │
│  │  └────────────────────────┬───────────────────────┘  │  │
│  │                           │                           │  │
│  │                   ┌───────▼────────┐                  │  │
│  │                   │ Kubernetes     │                  │  │
│  │                   │ Secret         │                  │  │
│  │                   └────────────────┘                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌────────────────┐            ┌─────────────────────┐
│ HashiCorp Vault │           │ AWS SSM Parameter    │
│ (KV v2, dynamic │           │ Store / Secrets Mgr  │
│  secrets)       │           │                     │
└────────────────┘            └─────────────────────┘
```

## Installing External Secrets Operator

```bash
# Add the Helm repository
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

# Install ESO into its own namespace
helm install external-secrets \
  external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set webhook.port=9443 \
  --set metrics.service.enabled=true \
  --set metrics.service.port=8080 \
  --version 0.10.0

# Verify installation
kubectl -n external-secrets get pods
kubectl -n external-secrets get crds | grep external-secrets.io

# Expected CRDs:
# clustersecretstores.external-secrets.io
# externalsecrets.external-secrets.io
# secretstores.external-secrets.io
# clusterexternalsecrets.external-secrets.io
# pushsecrets.external-secrets.io
```

## HashiCorp Vault Integration

### Vault Prerequisites

```bash
# Enable the KV secrets engine v2
vault secrets enable -path=secret kv-v2

# Write some secrets for testing
vault kv put secret/myapp/database \
  username=appuser \
  password=supersecret \
  host=postgres.internal \
  port=5432

vault kv put secret/myapp/api-keys \
  stripe_key=sk_live_placeholder \
  sendgrid_key=SG.placeholder

# Enable Kubernetes auth method
vault auth enable kubernetes

# Configure Kubernetes auth
# (Run this from within the cluster or with cluster credentials)
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Create a policy for ESO to read secrets
vault policy write eso-reader - <<'EOF'
path "secret/data/myapp/*" {
  capabilities = ["read", "list"]
}

path "secret/metadata/myapp/*" {
  capabilities = ["read", "list"]
}

# For dynamic database credentials
path "database/creds/myapp-role" {
  capabilities = ["read"]
}
EOF

# Create a Kubernetes auth role binding
vault write auth/kubernetes/role/eso-role \
  bound_service_account_names=external-secrets-sa \
  bound_service_account_namespaces=external-secrets,production,staging \
  policies=eso-reader \
  ttl=1h
```

### Vault SecretStore Configuration

```yaml
# vault-secretstore.yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: production
spec:
  provider:
    vault:
      server: "https://vault.internal:8200"
      path: "secret"
      version: "v2"

      # Authentication: Kubernetes ServiceAccount token
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "eso-role"
          serviceAccountRef:
            name: "external-secrets-sa"
          # Optional: use a different JWT audience
          # audiences:
          #   - vault

      # TLS configuration for Vault server
      caBundle: |
        LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...  # Base64-encoded CA cert

      # Optional: Vault namespace for Vault Enterprise
      # namespace: "admin"

---
# ClusterSecretStore for cluster-wide use
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-cluster-backend
spec:
  provider:
    vault:
      server: "https://vault.internal:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "eso-role"
          serviceAccountRef:
            name: "external-secrets-sa"
            namespace: "external-secrets"
```

### ServiceAccount for Vault Auth

```yaml
# eso-serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets-sa
  namespace: external-secrets
  annotations:
    # For AWS IRSA if also using AWS provider
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/external-secrets-role"

---
# RBAC for the token review
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: external-secrets-tokenreview
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:auth-delegator
subjects:
  - kind: ServiceAccount
    name: external-secrets-sa
    namespace: external-secrets
```

### ExternalSecret: Basic Key-Value Mapping

```yaml
# app-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-database-credentials
  namespace: production
spec:
  # How often to sync (pull from Vault and update the K8s Secret)
  refreshInterval: 1h

  # Reference to the SecretStore
  secretStoreRef:
    name: vault-backend
    kind: SecretStore

  # The target Kubernetes Secret to create/update
  target:
    name: myapp-database-credentials
    creationPolicy: Owner  # ESO owns the Secret lifecycle
    deletionPolicy: Retain  # Keep Secret if ExternalSecret is deleted
    template:
      type: Opaque
      metadata:
        labels:
          app: myapp
          managed-by: external-secrets
      # Optional: transform the data using Go templates
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/mydb"
        DATABASE_HOST: "{{ .host }}"
        DATABASE_PORT: "{{ .port }}"

  # Mapping from Vault paths to Secret keys
  data:
    - secretKey: username
      remoteRef:
        key: myapp/database
        property: username

    - secretKey: password
      remoteRef:
        key: myapp/database
        property: password

    - secretKey: host
      remoteRef:
        key: myapp/database
        property: host

    - secretKey: port
      remoteRef:
        key: myapp/database
        property: port
```

### ExternalSecret: Bulk Import with dataFrom

```yaml
# bulk-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-all-secrets
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: myapp-all-secrets
    creationPolicy: Owner

  # Pull ALL key-value pairs from a Vault path
  dataFrom:
    - extract:
        key: myapp/database
        # conversionStrategy: Default  # Default: use as-is
        # decodingStrategy: None       # No additional decoding
    - extract:
        key: myapp/api-keys

  # You can combine dataFrom with individual data entries
  data:
    - secretKey: EXTRA_SECRET
      remoteRef:
        key: myapp/special
        property: value
```

### ExternalSecret: Dynamic Database Credentials

Vault can generate short-lived database credentials. ESO integrates with this workflow:

```bash
# Vault setup for dynamic credentials
vault secrets enable database

vault write database/config/postgresql \
  plugin_name=postgresql-database-plugin \
  allowed_roles="myapp-role" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.internal:5432/mydb" \
  username="vault" \
  password="vault-password"

vault write database/roles/myapp-role \
  db_name=postgresql \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"
```

```yaml
# dynamic-creds-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-dynamic-db-creds
  namespace: production
spec:
  # Refresh more frequently than TTL to avoid expiry mid-use
  refreshInterval: 45m

  secretStoreRef:
    name: vault-backend
    kind: SecretStore

  target:
    name: myapp-dynamic-db-creds
    creationPolicy: Owner
    template:
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@postgres.internal:5432/mydb"

  data:
    - secretKey: username
      remoteRef:
        key: database/creds/myapp-role
        property: username

    - secretKey: password
      remoteRef:
        key: database/creds/myapp-role
        property: password
```

## AWS SSM Parameter Store Integration

### IAM Configuration

```bash
# Create IAM policy for SSM access
cat > eso-ssm-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSSMRead",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:DescribeParameters"
      ],
      "Resource": [
        "arn:aws:ssm:us-east-1:123456789012:parameter/myapp/*"
      ]
    },
    {
      "Sid": "AllowKMSDecrypt",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:DescribeKey"
      ],
      "Resource": [
        "arn:aws:kms:us-east-1:123456789012:key/mrk-placeholder"
      ]
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name ExternalSecretsOperatorSSM \
  --policy-document file://eso-ssm-policy.json

# For EKS with IRSA
aws iam create-role \
  --role-name external-secrets-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:external-secrets:external-secrets-sa"
        }
      }
    }]
  }'

aws iam attach-role-policy \
  --role-name external-secrets-role \
  --policy-arn arn:aws:iam::123456789012:policy/ExternalSecretsOperatorSSM
```

### Store Parameters in SSM

```bash
# Store secrets with SecureString type (KMS encrypted)
aws ssm put-parameter \
  --name "/myapp/production/database/password" \
  --value "supersecretpassword" \
  --type SecureString \
  --key-id "alias/myapp-secrets" \
  --description "Production database password for myapp"

aws ssm put-parameter \
  --name "/myapp/production/database/username" \
  --value "appuser" \
  --type SecureString \
  --key-id "alias/myapp-secrets"

aws ssm put-parameter \
  --name "/myapp/production/api/stripe-key" \
  --value "sk_live_placeholder" \
  --type SecureString \
  --key-id "alias/myapp-secrets"
```

### SSM SecretStore Configuration

```yaml
# aws-ssm-secretstore.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-ssm-backend
spec:
  provider:
    aws:
      service: ParameterStore
      region: us-east-1
      # IRSA authentication via ServiceAccount annotation
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
```

### SSM ExternalSecret

```yaml
# ssm-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-aws-secrets
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-ssm-backend
    kind: ClusterSecretStore
  target:
    name: myapp-aws-secrets
    creationPolicy: Owner

  # Individual parameter mapping
  data:
    - secretKey: DATABASE_PASSWORD
      remoteRef:
        key: /myapp/production/database/password

    - secretKey: DATABASE_USERNAME
      remoteRef:
        key: /myapp/production/database/username

    - secretKey: STRIPE_API_KEY
      remoteRef:
        key: /myapp/production/api/stripe-key

  # Bulk import from a path prefix
  dataFrom:
    - find:
        path: /myapp/production/
        name:
          regexp: ".*"
        tags:
          Environment: production
```

## AWS Secrets Manager Integration

AWS Secrets Manager supports JSON secrets and automatic rotation:

```bash
# Create a JSON secret in Secrets Manager
aws secretsmanager create-secret \
  --name "myapp/production/database" \
  --description "Production database credentials" \
  --secret-string '{
    "username": "appuser",
    "password": "supersecretpassword",
    "host": "postgres.internal",
    "port": "5432",
    "dbname": "myapp"
  }'

# Enable automatic rotation
aws secretsmanager rotate-secret \
  --secret-id "myapp/production/database" \
  --rotation-lambda-arn "arn:aws:lambda:us-east-1:123456789012:function:SecretsManagerRDSPostgreSQLRotationSingleUser" \
  --rotation-rules AutomaticallyAfterDays=30
```

```yaml
# aws-secrets-manager-store.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager-backend
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
# secretsmanager-external-secret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-database-json
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager-backend
    kind: ClusterSecretStore
  target:
    name: myapp-database-json
    creationPolicy: Owner
    template:
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .dbname }}"

  # Extract individual fields from a JSON secret
  data:
    - secretKey: username
      remoteRef:
        key: myapp/production/database
        property: username

    - secretKey: password
      remoteRef:
        key: myapp/production/database
        property: password

    - secretKey: host
      remoteRef:
        key: myapp/production/database
        property: host

    - secretKey: port
      remoteRef:
        key: myapp/production/database
        property: port

    - secretKey: dbname
      remoteRef:
        key: myapp/production/database
        property: dbname

  # Or pull the entire JSON as a single key
  # data:
  #   - secretKey: credentials.json
  #     remoteRef:
  #       key: myapp/production/database
```

## Secret Rotation Triggers

### Polling-Based Rotation

ESO's `refreshInterval` handles most rotation cases by periodically re-pulling from the secret store:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-rotating-secret
  namespace: production
spec:
  # Pull every 15 minutes — short enough to pick up rotated secrets
  # without excessive API calls
  refreshInterval: 15m
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: myapp-rotating-secret
    creationPolicy: Owner
```

### Annotation-Based Force Refresh

```bash
# Force an immediate refresh by adding/updating an annotation
kubectl annotate externalsecret myapp-database-credentials \
  force-sync=$(date +%s) \
  --overwrite \
  -n production

# The ESO controller will detect the annotation change and re-sync
```

### Vault Sentinel Integration

For Vault Enterprise, you can use Vault Sentinel policies to trigger ESO refresh:

```bash
# Create a Vault event that signals rotation
vault write sys/policies/sentinel/eso-rotation \
  policy=@rotation-policy.sentinel

# ESO can be configured to watch Vault events (v0.9+)
```

### Kubernetes Event-Driven Refresh

```yaml
# Trigger refresh when a Vault lease expires
# via ClusterExternalSecret with webhooks
apiVersion: external-secrets.io/v1beta1
kind: ClusterExternalSecret
metadata:
  name: cluster-wide-config
spec:
  externalSecretName: cluster-config
  namespaceSelector:
    matchLabels:
      managed-by: eso
  refreshTime: 1h
  externalSecretSpec:
    refreshInterval: 30m
    secretStoreRef:
      name: vault-cluster-backend
      kind: ClusterSecretStore
    target:
      name: cluster-config
      creationPolicy: Owner
    dataFrom:
      - extract:
          key: cluster/config
```

## Monitoring and Alerting

### Prometheus Metrics

ESO exposes metrics that should be scraped and alerted on:

```yaml
# prometheus-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: external-secrets-metrics
  namespace: external-secrets
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: external-secrets
  endpoints:
    - port: metrics
      interval: 30s
```

### Key Metrics and Alerts

```yaml
# external-secrets-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-alerts
  namespace: external-secrets
spec:
  groups:
    - name: external-secrets
      rules:
        # Alert when an ExternalSecret sync fails
        - alert: ExternalSecretSyncFailed
          expr: |
            externalsecret_sync_calls_error > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ExternalSecret sync failed"
            description: "ExternalSecret {{ $labels.name }} in namespace {{ $labels.namespace }} has failed to sync"

        # Alert when a secret store is not ready
        - alert: SecretStoreNotReady
          expr: |
            externalsecret_provider_api_calls_errors_total > 0
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Secret store unreachable"
            description: "Cannot reach secret provider for {{ $labels.name }}"

        # Alert when a secret is about to expire (for dynamic secrets)
        - alert: ExternalSecretExpiringSoon
          expr: |
            externalsecret_sync_calls_total{status="success"} == 0
          for: 2h
          labels:
            severity: warning
          annotations:
            summary: "ExternalSecret has not synced successfully recently"
```

### Checking Sync Status

```bash
# Check the status of all ExternalSecrets in a namespace
kubectl get externalsecrets -n production

# Detailed status of a specific secret
kubectl describe externalsecret myapp-database-credentials -n production

# Look for events indicating sync failures
kubectl get events -n production --field-selector reason=UpdateFailed

# Check ESO operator logs
kubectl -n external-secrets logs -l app.kubernetes.io/name=external-secrets --tail=50

# Verify the generated Kubernetes Secret exists and has values
kubectl get secret myapp-database-credentials -n production
kubectl get secret myapp-database-credentials -n production -o jsonpath='{.data}' | \
  python3 -c "import sys,json,base64; [print(k,'=',base64.b64decode(v).decode()) for k,v in json.load(sys.stdin).items()]"
```

## Multi-Tenant Secret Isolation

### Namespace-Scoped SecretStores

```yaml
# Each team/namespace gets its own SecretStore with limited Vault access
---
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: team-alpha-vault
  namespace: team-alpha
spec:
  provider:
    vault:
      server: "https://vault.internal:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "team-alpha-eso-role"
          serviceAccountRef:
            name: "eso-sa"  # namespace-local SA

---
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: team-beta-vault
  namespace: team-beta
spec:
  provider:
    vault:
      server: "https://vault.internal:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "team-beta-eso-role"
          serviceAccountRef:
            name: "eso-sa"
```

```bash
# Vault roles scoped to team namespaces
vault write auth/kubernetes/role/team-alpha-eso-role \
  bound_service_account_names=eso-sa \
  bound_service_account_namespaces=team-alpha \
  policies=team-alpha-reader \
  ttl=1h

vault write auth/kubernetes/role/team-beta-eso-role \
  bound_service_account_names=eso-sa \
  bound_service_account_namespaces=team-beta \
  policies=team-beta-reader \
  ttl=1h
```

## Troubleshooting Common Issues

### Issue 1: SecretStore Reports "Invalid Credentials"

```bash
# Check the SecretStore status
kubectl describe secretstore vault-backend -n production
# Look for: Status.Conditions[].Message

# Verify the ServiceAccount token is valid
kubectl -n production exec -it debug-pod -- \
  vault write auth/kubernetes/login \
    role=eso-role \
    jwt=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)

# Check Vault audit logs
vault audit list
vault audit enable file file_path=/vault/logs/audit.log
```

### Issue 2: Secret Exists but Values Are Stale

```bash
# Force an immediate re-sync
kubectl annotate externalsecret myapp-database-credentials \
  force-sync=$(date +%s) --overwrite -n production

# Check the last sync time
kubectl get externalsecret myapp-database-credentials -n production \
  -o jsonpath='{.status.refreshTime}'
```

### Issue 3: ExternalSecret Status Shows "SecretSyncedError"

```bash
# Get detailed error message
kubectl get externalsecret myapp-database-credentials -n production \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}'

# Common causes:
# - Vault path doesn't exist
# - KV version mismatch (v1 vs v2)
# - Property name doesn't exist in the secret
# - Network connectivity to Vault

# Test connectivity from within the cluster
kubectl -n production run vault-test --image=vault:latest --rm -it -- \
  vault kv get -address=https://vault.internal:8200 secret/myapp/database
```

## GitOps Workflow Integration

The ESO workflow enables clean GitOps without secrets in Git:

```yaml
# In your Git repository — NO sensitive values
# Only references to external secret paths
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: myapp-secrets
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-cluster-backend
    kind: ClusterSecretStore
  target:
    name: myapp-secrets
    creationPolicy: Owner
  dataFrom:
    - extract:
        key: myapp/production  # Path in Vault — safe to commit
```

```bash
# ArgoCD or Flux deploys this manifest from Git
# ESO controller syncs the actual secrets from Vault at runtime
# The resulting Kubernetes Secret is never committed to Git
# ArgoCD ignores the generated Secret via resource exclusions

# ArgoCD application with secret exclusion
argocd app create myapp \
  --repo https://github.com/myorg/myapp-config \
  --path k8s/production \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace production \
  --sync-policy automated \
  --resource-exclusion "Secret" # Prevents ArgoCD from managing generated Secrets
```

External Secrets Operator provides the bridge between Kubernetes-native workloads and enterprise secret management systems, enabling teams to adopt GitOps while maintaining proper secret hygiene and audit trails.
