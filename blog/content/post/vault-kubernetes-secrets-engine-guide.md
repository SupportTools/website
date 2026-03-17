---
title: "HashiCorp Vault Kubernetes Secrets Engine: Dynamic Secret Generation"
date: 2027-11-10T00:00:00-05:00
draft: false
tags: ["Vault", "Kubernetes", "Secrets", "Security", "PKI"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to HashiCorp Vault Kubernetes integration covering Vault Agent Injector, Vault Secrets Operator, dynamic database credentials, PKI engine, Kubernetes auth, and migration from static secrets."
more_link: "yes"
url: "/vault-kubernetes-secrets-engine-guide/"
---

Static Kubernetes secrets are one of the highest-risk elements in container security. Credentials stored in Secrets are base64-encoded, often replicated across clusters, and lack rotation or revocation capabilities. HashiCorp Vault's Kubernetes integration addresses this through dynamic secret generation, where credentials are issued on demand and automatically expire without manual rotation.

This guide covers the Vault Agent Injector for sidecar-based secret injection, the Vault Secrets Operator for Kubernetes-native secret synchronization, dynamic database credentials, PKI certificate issuance, and a migration strategy for converting static secrets to Vault-managed credentials.

<!--more-->

# HashiCorp Vault Kubernetes Secrets Engine: Dynamic Secret Generation

## Architecture Overview

Vault's Kubernetes integration has two distinct integration patterns:

**Vault Agent Injector**: Uses a MutatingWebhook to inject a Vault Agent sidecar into annotated pods. The agent authenticates to Vault and writes secrets to a shared volume.

**Vault Secrets Operator (VSO)**: A Kubernetes operator that creates and manages Kubernetes Secret objects from Vault data. Secrets are synced on a configurable interval and deleted when the VSO resource is removed.

```
┌─────────────────────────────────────────────────────────┐
│  Vault Agent Injector Flow                              │
│                                                         │
│  Pod spec with annotations ──► MutatingWebhook          │
│                                        │                │
│                              Inject vault-agent sidecar │
│                                        │                │
│  vault-agent ──► Vault k8s auth ──► Issue token         │
│       │                                                 │
│       │ Write secrets to /vault/secrets/                │
│       │                                                 │
│  App container reads from shared tmpfs volume           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Vault Secrets Operator Flow                            │
│                                                         │
│  VaultStaticSecret CR ──► VSO controller                │
│  VaultDynamicSecret CR ──►      │                       │
│  VaultPKISecret CR ──────►      │                       │
│                                 │                       │
│                    Authenticate to Vault                │
│                                 │                       │
│                    Fetch/renew secrets                  │
│                                 │                       │
│                    Create/update Kubernetes Secret      │
│                                 │                       │
│  App pod references standard Kubernetes Secret          │
└─────────────────────────────────────────────────────────┘
```

## Vault Installation and Configuration

### Installing Vault via Helm

```yaml
# vault-values.yaml
global:
  enabled: true
  tlsDisable: false

server:
  enabled: true
  replicas: 3
  ha:
    enabled: true
    replicas: 3
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = true
        listener "tcp" {
          tls_disable = 0
          address = "[::]:8200"
          cluster_address = "[::]:8201"
          tls_cert_file = "/vault/userconfig/tls-server/tls.crt"
          tls_key_file  = "/vault/userconfig/tls-server/tls.key"
        }
        storage "raft" {
          path = "/vault/data"
          retry_join {
            leader_api_addr = "https://vault-0.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/tls-ca/tls.crt"
          }
          retry_join {
            leader_api_addr = "https://vault-1.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/tls-ca/tls.crt"
          }
          retry_join {
            leader_api_addr = "https://vault-2.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/tls-ca/tls.crt"
          }
        }
        seal "awskms" {
          region     = "us-east-1"
          kms_key_id = "alias/vault-auto-unseal"
        }
        service_registration "kubernetes" {}
  resources:
    requests:
      memory: 256Mi
      cpu: 250m
    limits:
      memory: 256Mi
  dataStorage:
    enabled: true
    size: 20Gi
    storageClass: gp3
  extraVolumes:
  - type: secret
    name: tls-server
  - type: secret
    name: tls-ca

injector:
  enabled: true
  replicas: 2
  resources:
    requests:
      memory: 128Mi
      cpu: 100m

ui:
  enabled: true
  serviceType: ClusterIP
```

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

helm install vault hashicorp/vault \
  --namespace vault \
  --create-namespace \
  --values vault-values.yaml

# Initialize and unseal (first time only with Raft)
kubectl exec -n vault vault-0 -- vault operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > vault-init.json

# Store unseal keys securely (AWS Secrets Manager recommended)
cat vault-init.json | jq -r '.unseal_keys_b64[]' | head -3 | while read key; do
  kubectl exec -n vault vault-0 -- vault operator unseal "$key"
done

# Join raft cluster
kubectl exec -n vault vault-1 -- vault operator raft join \
  https://vault-0.vault-internal:8200
kubectl exec -n vault vault-2 -- vault operator raft join \
  https://vault-0.vault-internal:8200
```

## Kubernetes Authentication Method

### Configuring the Kubernetes Auth Method

```bash
# Enable Kubernetes auth
vault auth enable kubernetes

# Configure the auth method
# Get service account JWT and CA cert from the cluster
VAULT_SA_NAME=$(kubectl get sa -n vault vault -o jsonpath="{.secrets[*]['name']}")
SA_JWT_TOKEN=$(kubectl get secret -n vault $VAULT_SA_NAME \
  -o jsonpath="{.data.token}" | base64 --decode)
SA_CA_CRT=$(kubectl config view --raw --minify --flatten \
  -o jsonpath="{.clusters[].cluster.certificate-authority-data}" | base64 --decode)
K8S_HOST=$(kubectl config view --raw --minify --flatten \
  -o jsonpath="{.clusters[].cluster.server}")

# Configure Kubernetes auth backend
vault write auth/kubernetes/config \
  token_reviewer_jwt="$SA_JWT_TOKEN" \
  kubernetes_host="$K8S_HOST" \
  kubernetes_ca_cert="$SA_CA_CRT" \
  issuer="https://kubernetes.default.svc.cluster.local"

# Verify configuration
vault read auth/kubernetes/config
```

### Creating Vault Policies

```hcl
# policy: payments-app
path "database/creds/payments-readonly" {
  capabilities = ["read"]
}

path "database/creds/payments-readwrite" {
  capabilities = ["read"]
}

path "secret/data/payments/*" {
  capabilities = ["read"]
}

path "pki/issue/payments-service" {
  capabilities = ["create", "update"]
}

path "sys/leases/renew" {
  capabilities = ["create"]
}

path "sys/leases/revoke" {
  capabilities = ["update"]
}
```

```bash
# Write policy
vault policy write payments-app payments-app.hcl

# Create Kubernetes auth role
vault write auth/kubernetes/role/payments-app \
  bound_service_account_names=payments-sa \
  bound_service_account_namespaces=production \
  policies=payments-app \
  ttl=24h \
  max_ttl=48h
```

## Dynamic Database Credentials

### PostgreSQL Dynamic Secrets

```bash
# Enable database secrets engine
vault secrets enable database

# Configure PostgreSQL connection
vault write database/config/production-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="payments-readonly,payments-readwrite,api-readwrite" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.production.svc:5432/payments?sslmode=verify-full" \
  username="vault-admin" \
  password="initial-password" \
  root_rotation_statements="ALTER USER '{{name}}' WITH PASSWORD '{{password}}'"

# Rotate the vault-admin password immediately
vault write -force database/rotate-root/production-postgres

# Create read-only role
vault write database/roles/payments-readonly \
  db_name=production-postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  revocation_statements="REVOKE ALL ON ALL TABLES IN SCHEMA public FROM \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# Create read-write role
vault write database/roles/payments-readwrite \
  db_name=production-postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\"; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"{{name}}\";" \
  revocation_statements="REVOKE ALL ON ALL TABLES IN SCHEMA public FROM \"{{name}}\"; DROP ROLE IF EXISTS \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# Test credential generation
vault read database/creds/payments-readonly
```

### MySQL Dynamic Secrets

```bash
vault write database/config/production-mysql \
  plugin_name=mysql-database-plugin \
  allowed_roles="api-readonly" \
  connection_url="{{username}}:{{password}}@tcp(mysql.production.svc:3306)/api_db" \
  username="vault-admin" \
  password="initial-password"

vault write database/roles/api-readonly \
  db_name=production-mysql \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON api_db.* TO '{{name}}'@'%';" \
  revocation_statements="REVOKE ALL PRIVILEGES, GRANT OPTION FROM '{{name}}'@'%'; DROP USER '{{name}}'@'%';" \
  default_ttl="1h" \
  max_ttl="24h"
```

## PKI Secrets Engine

### Setting Up a PKI Infrastructure

```bash
# Enable PKI engine for root CA
vault secrets enable -path=pki pki
vault secrets tune -max-lease-ttl=87600h pki

# Generate root CA
vault write -field=certificate pki/root/generate/internal \
  common_name="company.internal Root CA" \
  ttl=87600h \
  key_type=ec \
  key_bits=384 > /tmp/root-ca.crt

# Configure CRL and issuing certificate URLs
vault write pki/config/urls \
  issuing_certificates="https://vault.vault.svc.cluster.local:8200/v1/pki/ca" \
  crl_distribution_points="https://vault.vault.svc.cluster.local:8200/v1/pki/crl"

# Enable intermediate CA
vault secrets enable -path=pki-int pki
vault secrets tune -max-lease-ttl=43800h pki-int

# Generate intermediate CSR
vault write -format=json pki-int/intermediate/generate/internal \
  common_name="company.internal Intermediate CA" \
  key_type=ec \
  key_bits=256 | jq -r '.data.csr' > /tmp/pki-int.csr

# Sign intermediate with root CA
vault write -format=json pki/root/sign-intermediate \
  csr=@/tmp/pki-int.csr \
  format=pem_bundle \
  ttl=43800h | jq -r '.data.certificate' > /tmp/pki-int-signed.crt

# Import signed certificate
vault write pki-int/intermediate/set-signed \
  certificate=@/tmp/pki-int-signed.crt

# Create certificate roles for services
vault write pki-int/roles/payments-service \
  allowed_domains="payments.production.svc.cluster.local,payments.company.internal" \
  allow_subdomains=true \
  allow_bare_domains=true \
  max_ttl=72h \
  key_type=ec \
  key_bits=256 \
  require_cn=false \
  server_flag=true \
  client_flag=true \
  code_signing_flag=false \
  email_protection_flag=false

vault write pki-int/roles/api-gateway \
  allowed_domains="api.company.com,api-gateway.production.svc.cluster.local" \
  allow_bare_domains=true \
  max_ttl=720h \
  key_type=rsa \
  key_bits=2048
```

## Vault Agent Injector

### Configuring Agent Injector via Pod Annotations

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-service
  namespace: production
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "payments-app"
        vault.hashicorp.com/tls-secret: "vault-tls-ca"
        vault.hashicorp.com/ca-cert: "/vault/tls/ca.crt"
        vault.hashicorp.com/agent-pre-populate-only: "false"
        vault.hashicorp.com/agent-limits-cpu: "200m"
        vault.hashicorp.com/agent-limits-mem: "128Mi"
        vault.hashicorp.com/agent-requests-cpu: "50m"
        vault.hashicorp.com/agent-requests-mem: "64Mi"

        # Inject database credentials
        vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/payments-readwrite"
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/payments-readwrite" -}}
          export DB_USER="{{ .Data.username }}"
          export DB_PASSWORD="{{ .Data.password }}"
          export DB_HOST="postgres.production.svc.cluster.local"
          export DB_PORT="5432"
          export DB_NAME="payments"
          export DATABASE_URL="postgres://{{ .Data.username }}:{{ .Data.password }}@postgres.production.svc.cluster.local:5432/payments?sslmode=verify-full"
          {{- end }}

        # Inject static secrets from KV store
        vault.hashicorp.com/agent-inject-secret-app-config: "secret/data/payments/config"
        vault.hashicorp.com/agent-inject-template-app-config: |
          {{- with secret "secret/data/payments/config" -}}
          {{- range $key, $value := .Data.data -}}
          export {{ $key }}="{{ $value }}"
          {{ end -}}
          {{- end }}

        # Inject TLS certificate
        vault.hashicorp.com/agent-inject-secret-tls-cert: "pki-int/issue/payments-service"
        vault.hashicorp.com/agent-inject-template-tls-cert: |
          {{- with pkiCert "pki-int/issue/payments-service" "common_name=payments.production.svc.cluster.local" "ttl=24h" -}}
          {{ .Cert }}{{ .CA }}
          {{- end }}
        vault.hashicorp.com/agent-inject-secret-tls-key: "pki-int/issue/payments-service"
        vault.hashicorp.com/agent-inject-template-tls-key: |
          {{- with pkiCert "pki-int/issue/payments-service" "common_name=payments.production.svc.cluster.local" "ttl=24h" -}}
          {{ .Key }}
          {{- end }}
    spec:
      serviceAccountName: payments-sa
      containers:
      - name: payments-service
        image: registry.company.com/payments:3.2.1
        command:
        - /bin/bash
        - -c
        - |
          source /vault/secrets/app-config
          source /vault/secrets/db-creds
          exec /app/payments-service
        ports:
        - containerPort: 8080
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
```

### Service Account Configuration

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payments-sa
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/payments-service-role"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: vault-auth-delegator
subjects:
- kind: ServiceAccount
  name: vault
  namespace: vault
roleRef:
  kind: ClusterRole
  name: system:auth-delegator
  apiGroup: rbac.authorization.k8s.io
```

## Vault Secrets Operator (VSO)

VSO is the preferred method for Kubernetes-native secret management as it creates standard Kubernetes Secret objects.

### Installing Vault Secrets Operator

```yaml
# vso-values.yaml
controller:
  manager:
    clientCache:
      persistenceModel: direct-encrypted
      storageEncryption:
        enabled: true
        mount: kubernetes
        keyName: vso-client-cache
        transitMount: transit
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi

defaultVaultConnection:
  enabled: true
  address: https://vault.vault.svc.cluster.local:8200
  skipTLSVerify: false
  caCertSecretRef:
    name: vault-tls-ca
    key: ca.crt
```

```bash
helm install vault-secrets-operator hashicorp/vault-secrets-operator \
  --namespace vault-secrets-operator-system \
  --create-namespace \
  --values vso-values.yaml
```

### VaultConnection and VaultAuth Resources

```yaml
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultConnection
metadata:
  name: vault-connection
  namespace: production
spec:
  address: https://vault.vault.svc.cluster.local:8200
  skipTLSVerify: false
  caCertSecretRef:
    name: vault-tls-ca
    key: ca.crt
---
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultAuth
metadata:
  name: payments-vault-auth
  namespace: production
spec:
  vaultConnectionRef: vault-connection
  method: kubernetes
  mount: kubernetes
  kubernetes:
    role: payments-app
    serviceAccount: payments-sa
    audiences:
    - vault
```

### VaultDynamicSecret for Database Credentials

```yaml
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultDynamicSecret
metadata:
  name: payments-db-creds
  namespace: production
spec:
  vaultAuthRef: payments-vault-auth
  mount: database
  path: creds/payments-readwrite
  destination:
    name: payments-db-credentials
    create: true
  rolloutRestartTargets:
  - kind: Deployment
    name: payments-service
  refreshAfter: 45m
  revocationOnDelete: true
  allowStaticCreds: false
```

This creates a Kubernetes Secret named `payments-db-credentials`:

```yaml
# Automatically created and maintained by VSO
apiVersion: v1
kind: Secret
metadata:
  name: payments-db-credentials
  namespace: production
  labels:
    app.kubernetes.io/managed-by: hashicorp-vso
type: Opaque
data:
  username: <base64-encoded-dynamic-username>
  password: <base64-encoded-dynamic-password>
  lease_id: <base64-encoded-lease-id>
  lease_duration: <base64-encoded-duration>
```

### VaultStaticSecret for KV Secrets

```yaml
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultStaticSecret
metadata:
  name: payments-app-config
  namespace: production
spec:
  vaultAuthRef: payments-vault-auth
  mount: secret
  type: kv-v2
  path: payments/config
  refreshAfter: 1h
  destination:
    name: payments-app-config
    create: true
    labels:
      app: payments
    annotations:
      last-sync: "timestamp"
  rolloutRestartTargets:
  - kind: Deployment
    name: payments-service
```

### VaultPKISecret for TLS Certificates

```yaml
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultPKISecret
metadata:
  name: payments-tls-cert
  namespace: production
spec:
  vaultAuthRef: payments-vault-auth
  mount: pki-int
  role: payments-service
  commonName: payments.production.svc.cluster.local
  altNames:
  - payments.company.internal
  - payments-service
  ipSans:
  - 10.96.0.50
  ttl: 72h
  expiryOffset: 12h
  destination:
    name: payments-tls
    create: true
    type: kubernetes.io/tls
  rolloutRestartTargets:
  - kind: Deployment
    name: payments-service
```

## Static Secrets Migration

### Audit Existing Kubernetes Secrets

```bash
#!/bin/bash
# audit-k8s-secrets.sh
# Identifies secrets that should be migrated to Vault

echo "=== Kubernetes Secret Audit ==="
echo "Date: $(date)"
echo ""

# Find all secrets with database connection strings
echo "--- Potential Database Credentials ---"
kubectl get secrets -A -o json | python3 -c "
import json, sys, base64

data = json.load(sys.stdin)
db_patterns = ['DATABASE_URL', 'DB_PASSWORD', 'POSTGRES', 'MYSQL', 'MONGODB']

for item in data['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    secret_data = item.get('data', {})

    for key in secret_data:
        value = base64.b64decode(secret_data[key]).decode('utf-8', errors='ignore')
        for pattern in db_patterns:
            if pattern.lower() in key.lower() or pattern.lower() in value.lower():
                print(f'  {ns}/{name}: key={key}')
                break
"

# Find secrets not managed by any controller
echo ""
echo "--- Unmanaged Secrets (no owner references) ---"
kubectl get secrets -A -o json | python3 -c "
import json, sys

data = json.load(sys.stdin)
skip_types = ['kubernetes.io/service-account-token', 'kubernetes.io/dockerconfigjson',
              'helm.sh/release.v1', 'bootstrap.kubernetes.io/token']

for item in data['items']:
    ns = item['metadata']['namespace']
    name = item['metadata']['name']
    secret_type = item.get('type', 'Opaque')
    owners = item['metadata'].get('ownerReferences', [])
    managed_by = item['metadata'].get('labels', {}).get('app.kubernetes.io/managed-by', '')

    if (not owners and
        secret_type not in skip_types and
        managed_by not in ['hashicorp-vso', 'cert-manager', 'helm']):
        age = item['metadata'].get('creationTimestamp', 'unknown')
        print(f'  {ns}/{name} (type={secret_type}, created={age})')
"
```

### Migration Script

```bash
#!/bin/bash
# migrate-secret-to-vault.sh
# Migrates a Kubernetes secret to Vault KV store

NAMESPACE=$1
SECRET_NAME=$2
VAULT_PATH=${3:-"secret/data/$NAMESPACE/$SECRET_NAME"}

if [ -z "$NAMESPACE" ] || [ -z "$SECRET_NAME" ]; then
  echo "Usage: $0 <namespace> <secret-name> [vault-path]"
  exit 1
fi

echo "Migrating $NAMESPACE/$SECRET_NAME to Vault path $VAULT_PATH"

# Export secret data
SECRET_JSON=$(kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o json)

# Convert to Vault KV format
VAULT_DATA=$(echo "$SECRET_JSON" | python3 -c "
import json, sys, base64

data = json.load(sys.stdin)
kv_data = {}

for key, value in data.get('data', {}).items():
    decoded = base64.b64decode(value).decode('utf-8', errors='ignore')
    kv_data[key] = decoded

print(json.dumps({'data': kv_data}))
")

# Write to Vault
echo "Writing to Vault..."
echo "$VAULT_DATA" | vault kv put "$VAULT_PATH" -

echo "Verifying Vault write..."
vault kv get "$VAULT_PATH"

# Create VSO resource
echo ""
echo "Creating VaultStaticSecret resource..."
cat << EOF | kubectl apply -f -
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultStaticSecret
metadata:
  name: ${SECRET_NAME}
  namespace: ${NAMESPACE}
spec:
  vaultAuthRef: default-vault-auth
  mount: secret
  type: kv-v2
  path: ${NAMESPACE}/${SECRET_NAME}
  refreshAfter: 1h
  destination:
    name: ${SECRET_NAME}
    create: true
EOF

echo "Waiting for VSO to sync secret..."
sleep 5
kubectl get secret -n "$NAMESPACE" "$SECRET_NAME" -o yaml

echo ""
echo "Migration complete. Verify your application is using the synced secret."
echo "Once verified, the original static secret can be removed."
```

## Lease Management and Renewal

### Monitoring Lease Expiration

```bash
# List active leases for a path
vault list sys/leases/lookup/database/creds/

# Get lease details
vault write sys/leases/lookup \
  lease_id="database/creds/payments-readwrite/LEASE-ID"

# Renew a lease manually
vault write sys/leases/renew \
  lease_id="database/creds/payments-readwrite/LEASE-ID" \
  increment=3600

# Revoke a specific lease
vault lease revoke "database/creds/payments-readwrite/LEASE-ID"

# Revoke all leases for a path
vault lease revoke -prefix database/creds/payments-readwrite/
```

### Lease Expiration Monitoring

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vault-lease-alerts
  namespace: monitoring
spec:
  groups:
  - name: vault.leases
    rules:
    - alert: VaultLeaseAboutToExpire
      expr: |
        vault_expire_num_leases > 0
        AND
        vault_expire_num_leases{namespace!=""} > 100
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High number of active Vault leases"
        description: "{{ $value }} active leases - verify lease renewal is working"

    - alert: VaultDynamicSecretSyncFailed
      expr: |
        vso_vault_dynamic_secret_status{status="error"} > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "VSO Dynamic Secret sync failure"
        description: "VaultDynamicSecret {{ $labels.name }} in {{ $labels.namespace }} failed to sync"
```

## Vault High Availability Configuration

### Raft Storage Health Checks

```bash
# Check Raft cluster status
vault operator raft list-peers

# Check individual node health
for i in 0 1 2; do
  echo "--- vault-$i ---"
  kubectl exec -n vault vault-$i -- vault status
done

# Monitor autopilot status
vault operator raft autopilot state

# Configure autopilot
vault write sys/storage/raft/autopilot/configuration \
  dead_server_last_contact_threshold="10m" \
  last_contact_threshold="10s" \
  max_trailing_logs=250 \
  server_stabilization_time="10s"
```

### Backup Configuration

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vault-raft-backup
  namespace: vault
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: vault-backup
          restartPolicy: OnFailure
          containers:
          - name: backup
            image: hashicorp/vault:1.17.0
            env:
            - name: VAULT_ADDR
              value: https://vault.vault.svc.cluster.local:8200
            - name: VAULT_TOKEN
              valueFrom:
                secretKeyRef:
                  name: vault-backup-token
                  key: token
            - name: BACKUP_S3_BUCKET
              value: company-vault-backups
            command:
            - /bin/sh
            - -c
            - |
              DATE=$(date +%Y%m%d-%H%M%S)
              vault operator raft snapshot save /tmp/vault-snapshot-${DATE}.snap
              aws s3 cp /tmp/vault-snapshot-${DATE}.snap \
                s3://company-vault-backups/snapshots/vault-snapshot-${DATE}.snap \
                --sse aws:kms
              echo "Backup completed: vault-snapshot-${DATE}.snap"
            resources:
              requests:
                cpu: 100m
                memory: 128Mi
```

## Troubleshooting

### Debugging Vault Agent Injection

```bash
# Check if injector webhook is active
kubectl get mutatingwebhookconfigurations | grep vault

# View injector logs
kubectl logs -n vault deployment/vault-agent-injector -f

# Check injection occurred
kubectl describe pod -n production payments-service-xxx | grep -A5 "Init Containers"

# Debug vault-agent logs
kubectl exec -n production payments-service-xxx -c vault-agent-init -- \
  cat /vault/logs/vault-agent.log

# Check secret file was written
kubectl exec -n production payments-service-xxx -- \
  ls -la /vault/secrets/

# Verify token renewal
kubectl exec -n production payments-service-xxx -c vault-agent -- \
  vault token lookup
```

### Debugging VSO Sync Issues

```bash
# Check VSO controller logs
kubectl logs -n vault-secrets-operator-system \
  deployment/vault-secrets-operator-controller-manager -f

# Check VaultStaticSecret status
kubectl describe vaultstaticsecret -n production payments-app-config

# Check VaultDynamicSecret status
kubectl describe vaultdynamicsecret -n production payments-db-creds

# Check VaultAuth is working
kubectl get vaultauth -n production payments-vault-auth -o yaml

# Manual sync trigger
kubectl annotate vaultstaticsecret -n production payments-app-config \
  secrets.hashicorp.com/force-sync=$(date +%s) --overwrite
```

### Diagnosing Kubernetes Auth Issues

```bash
# Test Kubernetes auth from within the cluster
kubectl run vault-auth-test --rm -it \
  --serviceaccount=payments-sa \
  --image=hashicorp/vault:1.17.0 -- \
  sh -c "
VAULT_ADDR=https://vault.vault.svc.cluster.local:8200
VAULT_CACERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
TOKEN=\$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)

vault write auth/kubernetes/login \
  role=payments-app \
  jwt=\$TOKEN
"

# Check Vault can verify the service account token
vault write auth/kubernetes/login \
  role=payments-app \
  jwt="$(kubectl create token payments-sa -n production)"
```

## Summary

Vault's Kubernetes integration provides a complete solution for dynamic secret management in production environments. The key architectural decisions are:

**Injection method**: Use the Vault Secrets Operator for most scenarios as it creates standard Kubernetes Secrets compatible with all workloads. Use the Vault Agent Injector when applications need direct filesystem access to frequently-rotating credentials.

**Dynamic secrets**: Database credentials should always be dynamic with TTLs of 1-4 hours. This eliminates the risk of credential compromise and reduces the blast radius of security incidents.

**PKI**: Use Vault's PKI engine for internal TLS certificates. Short-lived certificates (24-72 hours) eliminate the certificate rotation operational burden while improving security.

**Migration**: Use the audit script to identify static secrets containing credentials, migrate them to Vault KV, and create VSO resources to sync them back as Kubernetes Secrets. This provides a transparent migration path for applications.

**Operations**: Monitor lease counts, sync status, and Raft cluster health. Configure automated backups to S3 with KMS encryption for disaster recovery.

The combination of dynamic credentials, short TTLs, and automatic rotation through VSO reduces the operational overhead of secret management while significantly improving the security posture of Kubernetes workloads.
