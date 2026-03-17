---
title: "Kubernetes Secrets Management with External Secrets Operator: AWS Secrets Manager and HashiCorp Vault"
date: 2031-08-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "External Secrets Operator", "AWS Secrets Manager", "HashiCorp Vault", "Secrets Management", "Security", "IRSA"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to deploying External Secrets Operator on Kubernetes for centralized secrets management, covering AWS Secrets Manager integration with IRSA, HashiCorp Vault dynamic secrets, secret rotation, and multi-cluster patterns."
more_link: "yes"
url: "/kubernetes-external-secrets-operator-aws-secrets-manager-hashicorp-vault/"
---

Kubernetes Secrets are base64-encoded strings stored in etcd. They are accessible to anyone with the right RBAC permissions, replicated across control plane nodes, and — unless you encrypt etcd at rest and in transit — not particularly secret. The security-conscious approach is to treat Kubernetes Secrets as a distribution mechanism rather than a storage mechanism: the actual secret values live in a purpose-built secrets store (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault), and the External Secrets Operator (ESO) synchronizes them into Kubernetes Secrets that your workloads consume normally.

This guide covers deploying ESO in production, configuring AWS Secrets Manager with IRSA authentication, integrating with HashiCorp Vault for dynamic credentials, implementing secret rotation, and operating multi-cluster secret distribution.

<!--more-->

# Kubernetes Secrets Management with External Secrets Operator: AWS Secrets Manager and HashiCorp Vault

## Why External Secrets Operator

The alternative approaches to external secret management each have drawbacks that ESO avoids:

- **AWS Secrets Manager CSI Driver**: Mounts secrets as files rather than environment variables; requires pods to be recreated to pick up rotated secrets
- **Vault Agent Sidecar**: Adds a sidecar container to every pod; complicates pod scheduling and adds overhead
- **Manual sync scripts**: Ad-hoc, prone to failure, difficult to audit

ESO runs as a controller that watches `ExternalSecret` resources and reconciles them against external stores, creating and updating standard Kubernetes Secrets that pods consume normally. Rotation is automatic: when a secret changes in the external store, ESO updates the Kubernetes Secret within the configured refresh interval.

## Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version 0.10.3 \
  --set installCRDs=true \
  --set webhook.create=true \
  --set certController.create=true \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"="arn:aws:iam::<account-id>:role/external-secrets-controller"
```

Verify installation:

```bash
kubectl get pods -n external-secrets
kubectl get crd | grep external-secrets
# Should show:
# clusterexternalsecrets.external-secrets.io
# clustersecretstores.external-secrets.io
# externalsecrets.external-secrets.io
# secretstores.external-secrets.io
```

## AWS Secrets Manager Integration

### IAM Role for Service Account (IRSA)

The recommended authentication method for EKS is IRSA. ESO assumes an IAM role without storing any AWS credentials in the cluster.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowExternalSecretsController",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:ListSecretVersionIds"
      ],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:<account-id>:secret:production/*"
      ]
    },
    {
      "Sid": "AllowSSMParameterStore",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath"
      ],
      "Resource": [
        "arn:aws:ssm:us-east-1:<account-id>:parameter/production/*"
      ]
    }
  ]
}
```

Trust policy for the IAM role (allows ESO ServiceAccount to assume it):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/<oidc-id>"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/<oidc-id>:sub": "system:serviceaccount:external-secrets:external-secrets",
          "oidc.eks.us-east-1.amazonaws.com/id/<oidc-id>:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

### ClusterSecretStore for AWS Secrets Manager

A `ClusterSecretStore` is available across all namespaces. Use it for secrets shared across teams or applications.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      # auth: uses IRSA (pod's service account credentials)
      # No credentials needed when using IRSA
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### Namespace-Scoped SecretStore

Use a `SecretStore` when different namespaces should use different AWS accounts or different IAM roles.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  namespace: production
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      # Assume a specific role for this namespace
      # This role can have more restrictive resource policies
      role: arn:aws:iam::<account-id>:role/production-secrets-reader
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-production
            namespace: production
```

### Creating Secrets in AWS Secrets Manager

```bash
# Create a structured JSON secret
aws secretsmanager create-secret \
  --name "production/database/postgres" \
  --description "PostgreSQL database credentials" \
  --secret-string '{
    "host": "postgres.internal.example.com",
    "port": "5432",
    "database": "orders",
    "username": "app_user",
    "password": "<your-db-password>"
  }'

# Create a plain string secret
aws secretsmanager create-secret \
  --name "production/api-keys/stripe" \
  --secret-string "<your-stripe-secret-key>"

# Update an existing secret
aws secretsmanager put-secret-value \
  --secret-id "production/database/postgres" \
  --secret-string '{
    "host": "postgres.internal.example.com",
    "port": "5432",
    "database": "orders",
    "username": "app_user",
    "password": "<new-db-password>"
  }'
```

### ExternalSecret Resource

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  # How often to sync from the external store
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: database-credentials
    # What to do if the secret already exists:
    # Owner: ESO owns the secret and manages it entirely
    # Merge: ESO merges with existing secret (preserves fields ESO doesn't manage)
    creationPolicy: Owner
    # deletionPolicy: Retain keeps the Kubernetes secret when the ExternalSecret is deleted
    # Delete removes it (default)
    deletionPolicy: Retain
    # Template to format the output secret
    template:
      type: Opaque
      engineVersion: v2
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .database }}"
      metadata:
        labels:
          app: order-service
          managed-by: external-secrets
        annotations:
          external-secrets.io/source: "production/database/postgres"
  data:
    # Extract individual keys from a JSON secret
    - secretKey: username
      remoteRef:
        key: production/database/postgres
        property: username
    - secretKey: password
      remoteRef:
        key: production/database/postgres
        property: password
    - secretKey: host
      remoteRef:
        key: production/database/postgres
        property: host
    - secretKey: port
      remoteRef:
        key: production/database/postgres
        property: port
    - secretKey: database
      remoteRef:
        key: production/database/postgres
        property: database
```

### DataFrom for Bulk Secret Extraction

When a JSON secret in Secrets Manager should map directly to Kubernetes Secret keys:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-config
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: app-config
    creationPolicy: Owner
  # Extract all key-value pairs from a JSON secret
  dataFrom:
    - extract:
        key: production/app/config
        # Optionally filter to specific keys
        # metadataPolicy: Fetch  # also fetch secret metadata tags
    # Merge multiple secrets
    - extract:
        key: production/api-keys/stripe
        # Rewrite key names
        rewrite:
          - regexp:
              source: "^(.*)$"
              target: "STRIPE_$1"
```

## HashiCorp Vault Integration

### Vault SecretStore with Kubernetes Auth

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com:8200"
      path: "secret"
      version: "v2"
      # Vault CA certificate for TLS verification
      caProvider:
        type: ConfigMap
        name: vault-ca
        namespace: external-secrets
        key: ca.crt
      auth:
        # Kubernetes auth method: Vault validates the pod's service account token
        kubernetes:
          mountPath: kubernetes
          role: external-secrets
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

Configure Vault for Kubernetes authentication:

```bash
# Enable Kubernetes auth method in Vault
vault auth enable kubernetes

# Configure it with the cluster's API server info
vault write auth/kubernetes/config \
  token_reviewer_jwt="$(kubectl get secret \
    $(kubectl get serviceaccount external-secrets -n external-secrets \
      -o jsonpath='{.secrets[0].name}') \
    -n external-secrets -o jsonpath='{.data.token}' | base64 -d)" \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert="$(kubectl config view --raw \
    --minify --flatten -o jsonpath='{.clusters[].cluster.certificate-authority-data}' \
    | base64 -d)"

# Create a policy that grants read access
vault policy write external-secrets - << 'EOF'
path "secret/data/production/*" {
  capabilities = ["read", "list"]
}

path "database/creds/production-role" {
  capabilities = ["read"]
}
EOF

# Create a role binding the Kubernetes service account to the policy
vault write auth/kubernetes/role/external-secrets \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=external-secrets \
  ttl=1h
```

### Static Secrets from Vault KV

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: vault-credentials
  namespace: production
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: vault
    kind: ClusterSecretStore
  target:
    name: vault-credentials
    creationPolicy: Owner
  data:
    - secretKey: api-key
      remoteRef:
        key: production/api-keys
        property: stripe_key
        # Vault KV v2: specify a version for pinned secrets
        version: "5"
```

### Dynamic Database Credentials from Vault

Vault can generate short-lived database credentials. ESO fetches fresh credentials each refresh cycle.

```bash
# Configure Vault Database secrets engine
vault secrets enable database

vault write database/config/postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="production-role" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.internal.example.com:5432/orders" \
  username="vault_admin" \
  password="<vault-admin-password>"

vault write database/roles/production-role \
  db_name=postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"
```

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: dynamic-db-credentials
  namespace: production
spec:
  # Refresh more frequently than the credential TTL
  refreshInterval: 45m
  secretStoreRef:
    name: vault
    kind: ClusterSecretStore
  target:
    name: dynamic-db-credentials
    creationPolicy: Owner
    template:
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@postgres.internal.example.com:5432/orders"
  data:
    - secretKey: username
      remoteRef:
        # Vault dynamic secrets path
        key: database/creds/production-role
        property: username
    - secretKey: password
      remoteRef:
        key: database/creds/production-role
        property: password
```

## Secret Rotation

### Automatic Rotation via RefreshInterval

The simplest rotation strategy is short `refreshInterval`. ESO polls the external store on each interval and updates the Kubernetes Secret if the value has changed.

```yaml
spec:
  # Rotate every 15 minutes
  refreshInterval: 15m
```

For application pods to pick up rotated secrets, they must either:

1. Read secrets from files (with a volume mount) and watch for file changes
2. Restart periodically via a Kubernetes Job or rolling update
3. Use the Reloader controller to trigger rolling restarts when secrets change

### Triggering Rolling Restarts on Secret Change

The `stakater/reloader` controller monitors Secrets and ConfigMaps and triggers rolling restarts when they change.

```bash
helm repo add stakater https://stakater.github.io/stakater-charts
helm install reloader stakater/reloader -n kube-system
```

Annotate your Deployment to watch a specific secret:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  annotations:
    # Trigger a rolling restart when this secret changes
    secret.reloader.stakater.com/reload: "database-credentials"
    # Or watch all secrets used by the deployment:
    reloader.stakater.com/auto: "true"
```

### AWS Secrets Manager Automatic Rotation

Configure automatic rotation in AWS to rotate the underlying secret, which ESO will then pick up.

```bash
# Enable automatic rotation for a secret (every 30 days)
aws secretsmanager rotate-secret \
  --secret-id "production/database/postgres" \
  --rotation-lambda-arn "arn:aws:lambda:us-east-1:<account-id>:function:SecretsManagerRotation" \
  --rotation-rules AutomaticallyAfterDays=30

# Force immediate rotation for testing
aws secretsmanager rotate-secret \
  --secret-id "production/database/postgres" \
  --rotate-immediately
```

## ClusterExternalSecret for Multi-Namespace Distribution

`ClusterExternalSecret` creates `ExternalSecret` resources in multiple namespaces matching a label selector.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterExternalSecret
metadata:
  name: tls-certificate
spec:
  externalSecretName: tls-certificate
  # Create in all namespaces with this label
  namespaceSelector:
    matchLabels:
      environment: production
  refreshTime: 1h
  externalSecretSpec:
    refreshInterval: 1h
    secretStoreRef:
      name: aws-secrets-manager
      kind: ClusterSecretStore
    target:
      name: tls-certificate
      creationPolicy: Owner
    data:
      - secretKey: tls.crt
        remoteRef:
          key: production/tls/wildcard-cert
          property: certificate
      - secretKey: tls.key
        remoteRef:
          key: production/tls/wildcard-cert
          property: private_key
```

## Monitoring and Alerting

### ESO Metrics

ESO exposes Prometheus metrics on port 8080.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: external-secrets
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: external-secrets
  namespaceSelector:
    matchNames:
      - external-secrets
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
```

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-alerts
  namespace: monitoring
spec:
  groups:
    - name: external-secrets
      rules:
        - alert: ExternalSecretSyncFailure
          expr: externalsecret_sync_calls_error > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "ExternalSecret {{ $labels.name }} in namespace {{ $labels.namespace }} is failing to sync"
            description: "Check ESO logs and verify the secret exists in {{ $labels.store }}"

        - alert: ExternalSecretNotSynced
          expr: |
            time() - externalsecret_sync_calls_success_timestamp_seconds > 3600
          for: 15m
          labels:
            severity: warning
          annotations:
            summary: "ExternalSecret {{ $labels.name }} has not synced in >1 hour"

        - alert: ExternalSecretStoreConnectionFailure
          expr: externalsecret_provider_api_calls_errors_total > 0
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "ESO cannot connect to secret store {{ $labels.provider }}"
```

### Checking Sync Status

```bash
# Check status of all ExternalSecrets
kubectl get externalsecrets -A

# Detailed status for a specific ExternalSecret
kubectl describe externalsecret database-credentials -n production

# Check sync conditions
kubectl get externalsecret database-credentials -n production \
  -o jsonpath='{.status.conditions}' | python3 -m json.tool

# View ESO controller logs
kubectl logs -n external-secrets \
  -l app.kubernetes.io/name=external-secrets \
  --since=1h | grep -E "ERROR|WARN|sync"
```

## Security Hardening

### Network Policies

Restrict ESO controller access to only the external secret stores it needs to communicate with.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: external-secrets-controller
  namespace: external-secrets
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: external-secrets
  policyTypes:
    - Egress
    - Ingress
  ingress:
    # Allow Prometheus scraping
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - port: 8080
    # Allow webhook traffic from API server
    - ports:
        - port: 9443
  egress:
    # Allow HTTPS to AWS endpoints
    - ports:
        - port: 443
          protocol: TCP
    # Allow DNS
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # Allow Kubernetes API server
    - ports:
        - port: 6443
          protocol: TCP
```

### RBAC for ESO Operations Team

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-secrets-reader
rules:
  - apiGroups: ["external-secrets.io"]
    resources:
      - externalsecrets
      - clustersecretstores
      - secretstores
      - clusterexternalsecrets
    verbs: [get, list, watch]
  # Cannot read the actual Kubernetes Secrets (by design)
  - apiGroups: [""]
    resources: [secrets]
    verbs: []
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: external-secrets-operator
rules:
  - apiGroups: ["external-secrets.io"]
    resources:
      - externalsecrets
      - secretstores
    verbs: [get, list, watch, create, update, patch, delete]
  - apiGroups: ["external-secrets.io"]
    resources:
      - clustersecretstores
      - clusterexternalsecrets
    verbs: [get, list, watch]
```

### Audit Logging for Secret Access

Enable CloudTrail for AWS Secrets Manager access:

```bash
# Verify CloudTrail is logging Secrets Manager API calls
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventSource,AttributeValue=secretsmanager.amazonaws.com \
  --max-results 20 \
  --query 'Events[].{Time:EventTime,User:Username,Event:EventName,SecretId:Resources[0].ResourceName}'
```

## Multi-Cluster Configuration

For organizations running multiple Kubernetes clusters, a central `ClusterSecretStore` in a management cluster can push secrets to workload clusters via `PushSecret`.

```yaml
# PushSecret: ESO creates a Kubernetes Secret in the local cluster
# and pushes it to an external store (reverse of ExternalSecret)
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: generated-secret
  namespace: cert-manager
spec:
  # Push to AWS Secrets Manager
  secretStoreRefs:
    - name: aws-secrets-manager
      kind: ClusterSecretStore
  selector:
    secret:
      name: wildcard-tls-cert
  data:
    - match:
        secretKey: tls.crt
        remoteRef:
          remoteKey: production/tls/wildcard-cert
          property: certificate
    - match:
        secretKey: tls.key
        remoteRef:
          remoteKey: production/tls/wildcard-cert
          property: private_key
  updatePolicy: Replace
  deletionPolicy: Delete
```

## Troubleshooting Common Issues

```bash
# ESO cannot authenticate to AWS
# Check: Is the service account annotated with the correct role ARN?
kubectl get serviceaccount external-secrets -n external-secrets -o yaml | grep role-arn

# Check: Does the IAM trust policy reference the correct OIDC provider?
aws iam get-role --role-name external-secrets-controller \
  --query 'Role.AssumeRolePolicyDocument'

# ESO cannot find the secret
# Verify the secret exists in Secrets Manager
aws secretsmanager describe-secret --secret-id production/database/postgres

# Check the SecretStore health
kubectl get secretstore -n production
kubectl describe secretstore aws-secrets-manager -n production
# Look for: Status: Conditions: Valid:True

# Secret is not updating despite changes in Secrets Manager
# Force an immediate resync by updating the ExternalSecret annotation
kubectl annotate externalsecret database-credentials \
  force-sync=$(date +%s) \
  --overwrite \
  -n production

# View all ESO events
kubectl get events -n production \
  --field-selector reason=SecretSyncedError \
  --sort-by='.lastTimestamp'
```

## Summary

External Secrets Operator provides a clean separation between secret storage and secret consumption in Kubernetes. The operational patterns that matter most in production:

- Use IRSA on EKS rather than static credentials; the role's trust policy is the only credential you need to protect
- Set `refreshInterval` based on how quickly you need rotated secrets to propagate; 15-60 minutes is typical for database credentials
- Use `ClusterExternalSecret` to distribute common secrets (TLS certificates, shared API keys) across multiple namespaces without duplication
- Deploy Reloader alongside ESO to trigger rolling restarts when secrets change, ensuring pods do not use stale credentials
- Monitor `externalsecret_sync_calls_error` as a primary SLI for your secrets infrastructure
- Use `PushSecret` for the reverse flow — generating credentials locally (e.g., cert-manager TLS certs) and pushing them to central stores for distribution to other systems
