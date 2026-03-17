---
title: "External Secrets Operator: Syncing Secrets from Vault, AWS SSM, and Azure Key Vault"
date: 2027-12-23T00:00:00-05:00
draft: false
tags: ["External Secrets Operator", "Kubernetes", "HashiCorp Vault", "AWS SSM", "Azure Key Vault", "Secret Management", "Security"]
categories:
- Kubernetes
- Security
- Secret Management
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to External Secrets Operator covering SecretStore vs ClusterSecretStore, ExternalSecret CRD, Vault dynamic secrets, AWS SSM and Secrets Manager, Azure Key Vault integration, secret rotation strategies, and pushSecret for bidirectional sync."
more_link: "yes"
url: "/kubernetes-external-secrets-operator-guide/"
---

Storing secrets directly in Kubernetes Secrets or Git repositories is a known anti-pattern: base64 encoding is not encryption, etcd stores are not secret management systems, and secret sprawl across cluster resources makes rotation and auditing impractical. The External Secrets Operator (ESO) bridges production secret stores (Vault, AWS SSM, Azure Key Vault, GCP Secret Manager) to Kubernetes Secrets, handling synchronization, rotation, and lifecycle management. This guide covers the complete ESO operational model from installation through advanced patterns including dynamic Vault credentials and bidirectional secret sync.

<!--more-->

# External Secrets Operator: Syncing Secrets from Vault, AWS SSM, and Azure Key Vault

## Architecture Overview

ESO introduces three CRD layers:

```
External Secret Store          ESO CRDs                  Kubernetes
─────────────────────          ────────────              ──────────
                               SecretStore
HashiCorp Vault  ─────────────►  (namespace-scoped)  ──► Secret
AWS SSM          ─────────────►
Azure Key Vault  ─────────────► ClusterSecretStore    ──► Secret
GCP Secret Mgr   ─────────────►  (cluster-scoped)

                               ExternalSecret        ──► Secret
                                 (references store,      (synced)
                                  maps keys to fields)

                               ClusterExternalSecret ──► Secret
                                 (multi-namespace        (synced)
                                  deployment)
```

The key operational separation:
- **SecretStore**: Namespace-scoped, holds authentication to one backend, used by ExternalSecrets in the same namespace
- **ClusterSecretStore**: Cluster-scoped, can be referenced from any namespace, used when a single Vault/SSM instance serves the entire cluster
- **ExternalSecret**: Declares which secrets to sync and how to map them to Kubernetes Secret fields
- **ClusterExternalSecret**: Deploys an ExternalSecret across multiple namespaces simultaneously

## Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set webhook.port=9443 \
  --set certController.create=true \
  --set controller.metrics.service.enabled=true \
  --set webhook.metrics.service.enabled=true \
  --version 0.10.7 \
  --wait

kubectl get pods -n external-secrets
# NAME                                              READY   STATUS
# external-secrets-...                              1/1     Running
# external-secrets-cert-controller-...             1/1     Running
# external-secrets-webhook-...                     1/1     Running
```

## HashiCorp Vault Integration

### Vault KV v2 with Kubernetes Auth

```bash
# Configure Vault Kubernetes auth (run inside Vault pod or with Vault CLI)
vault auth enable kubernetes

vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc.cluster.local:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token

# Create policy for payments namespace
vault policy write payments-kv-read - <<EOF
path "secret/data/payments/*" {
  capabilities = ["read", "list"]
}
path "secret/metadata/payments/*" {
  capabilities = ["read", "list"]
}
EOF

# Bind policy to Kubernetes service account
vault write auth/kubernetes/role/payments-reader \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=payments \
  policies=payments-kv-read \
  ttl=1h

# Store a secret
vault kv put secret/payments/database \
  username=payments_user \
  password=supersecret \
  host=postgres.payments.svc.cluster.local \
  port=5432 \
  database=payments
```

### Vault SecretStore

```yaml
# vault-secretstore.yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-payments
  namespace: payments
spec:
  provider:
    vault:
      server: "http://vault.vault.svc.cluster.local:8200"
      path: "secret"           # KV mount path
      version: "v2"            # KV version
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "payments-reader"
          serviceAccountRef:
            name: external-secrets     # SA in payments namespace
      caProvider:
        type: ConfigMap
        name: vault-ca
        key: ca.crt
        namespace: payments
```

### ExternalSecret for Database Credentials

```yaml
# payments-db-externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-database-credentials
  namespace: payments
  annotations:
    "helm.sh/hook": pre-install
spec:
  refreshInterval: "5m"       # How often to sync from Vault
  secretStoreRef:
    name: vault-payments
    kind: SecretStore
  target:
    name: payments-db-secret  # Name of the Kubernetes Secret to create/update
    creationPolicy: Owner      # ESO owns the lifecycle of this Secret
    deletionPolicy: Retain     # Keep Secret when ExternalSecret is deleted
    template:
      type: kubernetes.io/basic-auth
      metadata:
        labels:
          app: payment-service
          managed-by: external-secrets
      data:
        # Custom formatting: construct a connection string
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .database }}?sslmode=require"
        DB_HOST: "{{ .host }}"
        DB_PORT: "{{ .port }}"
  data:
    - secretKey: username
      remoteRef:
        key: payments/database
        property: username
    - secretKey: password
      remoteRef:
        key: payments/database
        property: password
    - secretKey: host
      remoteRef:
        key: payments/database
        property: host
    - secretKey: port
      remoteRef:
        key: payments/database
        property: port
    - secretKey: database
      remoteRef:
        key: payments/database
        property: database
```

### Vault Dynamic Secrets (Database Credentials)

For the highest security posture, use Vault's database secrets engine to generate ephemeral credentials rotated automatically:

```bash
# Enable database secrets engine
vault secrets enable database

# Configure PostgreSQL connection
vault write database/config/payments-db \
  plugin_name=postgresql-database-plugin \
  allowed_roles="payments-dynamic" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.payments.svc.cluster.local:5432/payments" \
  username="vault_admin" \
  password="vault_admin_password"

# Create role that generates credentials
vault write database/roles/payments-dynamic \
  db_name=payments-db \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; \
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\"; \
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO \"{{name}}\";" \
  revocation_statements="REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# Policy for dynamic secrets
vault policy write payments-dynamic - <<EOF
path "database/creds/payments-dynamic" {
  capabilities = ["read"]
}
EOF
```

```yaml
# vault-dynamic-externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-dynamic-db-creds
  namespace: payments
spec:
  refreshInterval: "30m"   # Rotate before TTL expires (1h TTL, refresh at 30m)
  secretStoreRef:
    name: vault-payments
    kind: SecretStore
  target:
    name: payments-dynamic-db-secret
    creationPolicy: Owner
    template:
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@postgres.payments.svc.cluster.local:5432/payments"
  data:
    - secretKey: username
      remoteRef:
        key: database/creds/payments-dynamic    # Dynamic path, not KV
        property: username
    - secretKey: password
      remoteRef:
        key: database/creds/payments-dynamic
        property: password
```

## AWS SSM Parameter Store Integration

### IAM Policy and IRSA

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:DescribeParameters"
      ],
      "Resource": [
        "arn:aws:ssm:us-east-1:123456789012:parameter/payments/*",
        "arn:aws:ssm:us-east-1:123456789012:parameter/shared/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt"
      ],
      "Resource": "arn:aws:kms:us-east-1:123456789012:key/mrk-1234567890abcdef"
    }
  ]
}
```

```yaml
# aws-cluster-secretstore.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-ssm-store
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
```

ServiceAccount with IRSA annotation:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets
  namespace: external-secrets
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/external-secrets-operator
```

### ExternalSecret from SSM

```yaml
# payments-ssm-externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-ssm-secrets
  namespace: payments
spec:
  refreshInterval: "10m"
  secretStoreRef:
    name: aws-ssm-store
    kind: ClusterSecretStore
  target:
    name: payments-config-secret
    creationPolicy: Owner
    template:
      data:
        STRIPE_API_KEY: "{{ .stripe_api_key }}"
        SENDGRID_API_KEY: "{{ .sendgrid_api_key }}"
        JWT_SIGNING_KEY: "{{ .jwt_signing_key }}"
  data:
    - secretKey: stripe_api_key
      remoteRef:
        key: /payments/production/stripe-api-key
    - secretKey: sendgrid_api_key
      remoteRef:
        key: /payments/production/sendgrid-api-key
    - secretKey: jwt_signing_key
      remoteRef:
        key: /shared/production/jwt-signing-key
```

### Bulk Import from SSM Path

```yaml
# Sync all parameters under a path prefix
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-all-ssm-secrets
  namespace: payments
spec:
  refreshInterval: "5m"
  secretStoreRef:
    name: aws-ssm-store
    kind: ClusterSecretStore
  target:
    name: payments-all-config
    creationPolicy: Owner
  dataFrom:
    - find:
        path: /payments/production
        name:
          regexp: ".*"     # All parameters under this path
      rewrite:
        - regexp:
            source: "/payments/production/(.*)"
            target: "$1"   # Strip the prefix from keys
```

## AWS Secrets Manager Integration

```yaml
# aws-secretsmanager-store.yaml
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
            name: external-secrets
            namespace: external-secrets
---
# ExternalSecret referencing a JSON secret
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-api-credentials
  namespace: payments
spec:
  refreshInterval: "15m"
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: payments-api-secret
    creationPolicy: Owner
  data:
    # Extract individual fields from a JSON secret
    - secretKey: api_key
      remoteRef:
        key: payments/production/api-credentials
        property: api_key          # JSON property path
    - secretKey: api_secret
      remoteRef:
        key: payments/production/api-credentials
        property: api_secret
    # Access nested JSON with dot notation
    - secretKey: oauth_client_id
      remoteRef:
        key: payments/production/api-credentials
        property: oauth.client_id  # Nested path
```

## Azure Key Vault Integration

```yaml
# azure-cluster-secretstore.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: azure-keyvault
spec:
  provider:
    azurekv:
      tenantId: "12345678-1234-1234-1234-123456789012"
      vaultUrl: "https://my-keyvault.vault.azure.net"
      authType: WorkloadIdentity    # Uses Azure Workload Identity (pod OIDC)
      serviceAccountRef:
        name: external-secrets
        namespace: external-secrets
---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-azure-secrets
  namespace: payments
spec:
  refreshInterval: "10m"
  secretStoreRef:
    name: azure-keyvault
    kind: ClusterSecretStore
  target:
    name: payments-azure-secret
    creationPolicy: Owner
  data:
    - secretKey: db_password
      remoteRef:
        key: payments-db-password        # Key Vault secret name
        version: ""                       # Latest version
    - secretKey: tls_cert
      remoteRef:
        key: payments-tls-cert           # Key Vault certificate
        property: certificate            # Extracts PEM cert
    - secretKey: tls_key
      remoteRef:
        key: payments-tls-cert
        property: key                    # Extracts private key
```

## ClusterExternalSecret for Multi-Namespace Deployment

Deploy the same secrets to multiple namespaces (e.g., a shared JWT signing key for all API services):

```yaml
# cluster-external-secret-jwt.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterExternalSecret
metadata:
  name: shared-jwt-signing-key
spec:
  # Target namespaces matching this selector
  namespaceSelectors:
    - matchLabels:
        secrets.platform.io/needs-jwt: "true"
  refreshTime: 1h
  externalSecretSpec:
    refreshInterval: "10m"
    secretStoreRef:
      name: aws-secrets-manager
      kind: ClusterSecretStore
    target:
      name: jwt-signing-key
      creationPolicy: Owner
      template:
        type: Opaque
    data:
      - secretKey: private_key
        remoteRef:
          key: shared/jwt-signing-keys
          property: private_key
      - secretKey: public_key
        remoteRef:
          key: shared/jwt-signing-keys
          property: public_key
```

Label namespaces to receive the secret:

```bash
kubectl label namespace payments secrets.platform.io/needs-jwt=true
kubectl label namespace identity secrets.platform.io/needs-jwt=true
kubectl label namespace api-gateway secrets.platform.io/needs-jwt=true
```

## Secret Rotation Strategies

### Automatic Rotation Trigger via Annotation

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payments-db-secret
  namespace: payments
  annotations:
    # Force immediate refresh when this annotation changes
    force-sync: "2027-12-16T00:00:00Z"
spec:
  refreshInterval: "5m"
  target:
    name: payments-db-credentials
    creationPolicy: Owner
    template:
      metadata:
        annotations:
          # Trigger pod restart when secret content changes
          reloader.stakater.com/match: "true"
```

The Reloader controller from stakater watches secrets and triggers rolling restarts when their content changes. Deploy alongside ESO:

```bash
helm upgrade --install reloader stakater/reloader \
  --namespace reloader \
  --create-namespace \
  --set reloader.watchGlobally=false \
  --version 1.0.115
```

### Rotation Notification via Webhook

Configure ESO to fire a webhook when a secret is refreshed:

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: Generator
metadata:
  name: rotation-notifier
  namespace: payments
spec:
  provider:
    webhook:
      url: "https://internal-webhooks.example.com/secret-rotated"
      method: POST
      body: |
        {
          "secret": "{{ .ExternalSecret.Name }}",
          "namespace": "{{ .ExternalSecret.Namespace }}",
          "timestamp": "{{ now | date \"2006-01-02T15:04:05Z07:00\" }}"
        }
      headers:
        Content-Type: application/json
        Authorization: "Bearer {{ .token }}"
```

## PushSecret: Bidirectional Sync

PushSecret writes a Kubernetes Secret to an external store, enabling cluster-generated values (TLS certs, generated API keys) to be published to central secret stores:

```yaml
# pushsecret-tls-cert.yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-payments-tls-cert
  namespace: payments
spec:
  updatePolicy: Replace
  deletionPolicy: Delete
  refreshInterval: "1h"
  secretStoreRefs:
    - name: vault-payments
      kind: SecretStore
  selector:
    secret:
      name: payments-tls      # Kubernetes Secret created by cert-manager
  data:
    - match:
        secretKey: tls.crt
        remoteRef:
          remoteKey: payments/tls-certificate
          property: certificate
    - match:
        secretKey: tls.key
        remoteRef:
          remoteKey: payments/tls-certificate
          property: private_key
```

## Monitoring and Alerting

```yaml
# eso-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-alerts
  namespace: external-secrets
spec:
  groups:
    - name: external-secrets.rules
      rules:
        - alert: ExternalSecretSyncFailed
          expr: |
            externalsecret_status_condition{
              condition="Ready",
              status="False"
            } == 1
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "ExternalSecret {{ $labels.name }}/{{ $labels.namespace }} sync failed"
            description: "Check SecretStore credentials and backend availability"

        - alert: ExternalSecretStaleSince
          expr: |
            (time() - externalsecret_status_sync_calls_total) > 900
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalSecret not synced in 15+ minutes"

        - alert: SecretStoreUnhealthy
          expr: |
            secretstore_status_condition{
              condition="Ready",
              status="False"
            } == 1
          for: 2m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "SecretStore {{ $labels.name }}/{{ $labels.namespace }} unhealthy"
            description: "Authentication to secret backend may have failed"
```

ServiceMonitor:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: external-secrets
  namespace: external-secrets
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: external-secrets
  endpoints:
    - port: metrics
      interval: 30s
```

## Operational Runbook

### Debugging a Failed ExternalSecret

```bash
# Check ExternalSecret status
kubectl describe externalsecret payments-database-credentials -n payments

# Check SecretStore status
kubectl describe secretstore vault-payments -n payments

# View ESO controller logs for the specific ExternalSecret
kubectl logs -n external-secrets deployment/external-secrets \
  | grep "payments-database-credentials" | tail -30

# Force immediate sync
kubectl annotate externalsecret payments-database-credentials \
  -n payments \
  force-sync="$(date +%s)" \
  --overwrite

# Verify the resulting Secret
kubectl get secret payments-db-secret -n payments -o jsonpath='{.data}' | \
  jq 'to_entries | map({key: .key, value: (.value | @base64d)}) | from_entries'
```

### Validating Secret Freshness

```bash
# Check last sync time for all ExternalSecrets in a namespace
kubectl get externalsecret -n payments -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.refreshTime}{"\n"}{end}'

# Confirm Secret has the updated-at annotation from ESO
kubectl get secret payments-db-secret -n payments \
  -o jsonpath='{.metadata.annotations.reconcile\.external-secrets\.io/data-hash}'
```

## Summary

The External Secrets Operator provides a Kubernetes-native interface to enterprise secret stores while maintaining clear separation between secret storage and secret consumption. The critical operational patterns are:

1. Use ClusterSecretStore for shared backends, SecretStore when namespace isolation of authentication is required
2. Enable Vault database secrets engine for dynamic credentials with automatic expiry
3. Configure IRSA/Workload Identity for AWS and Azure backends to avoid static credentials
4. Deploy Reloader alongside ESO to trigger rolling restarts when secret content changes
5. Use ClusterExternalSecret for secrets shared across multiple namespaces
6. Set refreshInterval conservatively (5-15 minutes) to balance freshness against backend API rate limits
7. Monitor SecretStore and ExternalSecret ready conditions with Prometheus alerts for immediate detection of sync failures
