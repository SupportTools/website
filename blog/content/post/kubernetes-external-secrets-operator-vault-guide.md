---
title: "External Secrets Operator: Syncing Vault and AWS Secrets Manager to Kubernetes"
date: 2028-10-22T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets", "Vault", "External Secrets", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to External Secrets Operator installation, SecretStore and ClusterSecretStore configuration, syncing from HashiCorp Vault, AWS Secrets Manager, and GCP Secret Manager with templating and push secrets."
more_link: "yes"
url: "/kubernetes-external-secrets-operator-vault-guide/"
---

Kubernetes Secrets are base64-encoded, not encrypted. Storing secret values directly in Git or relying on etcd encryption alone leaves secrets exposed to anyone with cluster access. External Secrets Operator (ESO) solves this by keeping secrets in dedicated secret managers — HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager — and synchronizing them into Kubernetes Secrets on a configurable schedule. This guide covers installation, every major provider, templating, push secrets, and how ESO compares to Sealed Secrets.

<!--more-->

# External Secrets Operator: Production Configuration Guide

## Installation

ESO is installed via the official Helm chart. The chart deploys the operator controller, CRDs, and webhook.

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --set webhook.port=9443 \
  --set certController.requeueInterval=5m \
  --version 0.10.3
```

Verify the installation:

```bash
kubectl -n external-secrets get pods
# NAME                                               READY   STATUS    RESTARTS   AGE
# external-secrets-7d8f9b6c9-xk2pn                 1/1     Running   0          2m
# external-secrets-cert-controller-b4f7d9c-lw9vz   1/1     Running   0          2m
# external-secrets-webhook-6d5c8b7f9-p3rts          1/1     Running   0          2m

kubectl get crds | grep external-secrets
# clustersecretstores.external-secrets.io
# externalsecrets.external-secrets.io
# secretstores.external-secrets.io
# pushsecrets.external-secrets.io
```

## HashiCorp Vault Integration

### Vault AppRole Authentication

AppRole is the recommended non-interactive authentication method for automated systems. ESO uses the role ID and secret ID to obtain a Vault token.

First, configure Vault:

```bash
# Enable AppRole auth
vault auth enable approle

# Create a policy for the secrets path
vault policy write external-secrets-policy - <<EOF
path "secret/data/production/*" {
  capabilities = ["read"]
}
path "secret/metadata/production/*" {
  capabilities = ["read", "list"]
}
EOF

# Create the AppRole
vault write auth/approle/role/external-secrets \
  token_policies="external-secrets-policy" \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0

# Obtain role ID and secret ID
vault read auth/approle/role/external-secrets/role-id
vault write -f auth/approle/role/external-secrets/secret-id
```

Store the credentials in Kubernetes:

```bash
kubectl create secret generic vault-approle \
  --namespace production \
  --from-literal=roleId=<ROLE_ID> \
  --from-literal=secretId=<SECRET_ID>
```

Create the SecretStore:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: production
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com:8200"
      path: "secret"
      version: "v2"
      auth:
        appRole:
          path: "approle"
          roleId: "eso-role-id-placeholder"
          secretRef:
            name: vault-approle
            key: roleId
          secretRef:
            name: vault-approle
            key: secretId
```

The correct YAML structure for AppRole:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: production
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com:8200"
      path: "secret"
      version: "v2"
      auth:
        appRole:
          path: "approle"
          roleRef:
            name: vault-approle
            key: roleId
          secretRef:
            name: vault-approle
            key: secretId
```

### Vault Kubernetes Authentication

For pods running inside the same or a trusted Kubernetes cluster, Vault Kubernetes auth is cleaner than AppRole because it leverages the pod's projected service account token.

Configure Vault:

```bash
vault auth enable kubernetes

vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"

vault write auth/kubernetes/role/external-secrets \
  bound_service_account_names="external-secrets" \
  bound_service_account_namespaces="external-secrets" \
  policies="external-secrets-policy" \
  ttl=1h
```

SecretStore using Kubernetes auth:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-k8s-backend
  namespace: production
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
          serviceAccountRef:
            name: "external-secrets"
```

### ClusterSecretStore for org-wide access

`ClusterSecretStore` operates at cluster scope, allowing any namespace to reference the same backend without duplicating credentials.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-cluster
spec:
  provider:
    vault:
      server: "https://vault.internal.example.com:8200"
      path: "secret"
      version: "v2"
      namespace: "production" # Vault Enterprise namespace
      caProvider:
        type: ConfigMap
        name: vault-ca
        namespace: external-secrets
        key: ca.crt
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets-cluster"
          serviceAccountRef:
            name: "external-secrets"
            namespace: "external-secrets"
```

### ExternalSecret syncing from Vault

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: database-secret
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@postgres:5432/appdb"
  data:
  - secretKey: username
    remoteRef:
      key: production/database
      property: username
  - secretKey: password
    remoteRef:
      key: production/database
      property: password
  dataFrom:
  - extract:
      key: production/app-config
```

`dataFrom.extract` pulls all key-value pairs from a Vault secret path into the Kubernetes Secret. With `data`, you pull individual fields and can rename keys.

## AWS Secrets Manager Integration

### IRSA (IAM Roles for Service Accounts)

The recommended approach on EKS uses IRSA to grant ESO access to AWS Secrets Manager without static credentials.

Create the IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:ListSecrets"
      ],
      "Resource": "arn:aws:secretsmanager:us-east-1:123456789012:secret:production/*"
    }
  ]
}
```

```bash
# Create the policy
aws iam create-policy \
  --policy-name ExternalSecretsPolicy \
  --policy-document file://eso-policy.json

# Create IRSA role
eksctl create iamserviceaccount \
  --name external-secrets \
  --namespace external-secrets \
  --cluster my-cluster \
  --attach-policy-arn arn:aws:iam::123456789012:policy/ExternalSecretsPolicy \
  --approve \
  --override-existing-serviceaccounts
```

ClusterSecretStore for AWS:

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
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

ExternalSecret from AWS Secrets Manager:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payment-service-secrets
  namespace: production
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: payment-secrets
    creationPolicy: Owner
  data:
  - secretKey: stripe_api_key
    remoteRef:
      key: production/payment-service
      property: stripe_api_key
  - secretKey: stripe_webhook_secret
    remoteRef:
      key: production/payment-service
      property: stripe_webhook_secret
```

### AWS SSM Parameter Store

ESO also supports SSM Parameter Store with the `ParameterStore` service type:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-parameter-store
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
  name: app-config-params
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: aws-parameter-store
    kind: ClusterSecretStore
  target:
    name: app-config
    creationPolicy: Owner
  dataFrom:
  - find:
      path: /production/myapp
      name:
        regexp: ".*"
```

`find` with `path` and `regexp` fetches all parameters under a path hierarchy, making it easy to sync an entire application's configuration tree.

## GCP Secret Manager Integration

Create a Workload Identity binding:

```bash
# Create a GCP service account
gcloud iam service-accounts create external-secrets \
  --display-name "External Secrets Operator"

# Grant access to Secret Manager
gcloud projects add-iam-policy-binding my-project \
  --member "serviceAccount:external-secrets@my-project.iam.gserviceaccount.com" \
  --role "roles/secretmanager.secretAccessor"

# Bind to Kubernetes SA via Workload Identity
gcloud iam service-accounts add-iam-policy-binding \
  external-secrets@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[external-secrets/external-secrets]"

kubectl annotate serviceaccount external-secrets \
  --namespace external-secrets \
  iam.gke.io/gcp-service-account=external-secrets@my-project.iam.gserviceaccount.com
```

ClusterSecretStore for GCP:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: gcp-secret-manager
spec:
  provider:
    gcpsm:
      projectID: "my-gcp-project"
      auth:
        workloadIdentity:
          clusterLocation: us-central1
          clusterName: my-cluster
          clusterProjectID: my-gcp-project
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

## Secret Refresh Intervals

Refresh intervals control how often ESO polls the remote backend. Choose based on how frequently secrets rotate and how quickly you need changes reflected.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  # Sync every 5 minutes — appropriate for frequently rotated credentials
  refreshInterval: 5m

  # Sync every hour — suitable for long-lived secrets
  # refreshInterval: 1h

  # Never re-sync after initial creation
  # refreshInterval: 0

  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: db-secret
    creationPolicy: Owner
    deletionPolicy: Retain  # Keep the secret if the ExternalSecret is deleted
  data:
  - secretKey: password
    remoteRef:
      key: production/database
      property: password
```

Force an immediate refresh:

```bash
kubectl annotate externalsecret db-credentials \
  --namespace production \
  force-sync=$(date +%s) \
  --overwrite
```

## Templating Secret Values

ESO's template engine uses Go's `text/template` with sprig functions. This lets you compose multiple remote values into a single secret key.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-connection-string
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: app-connection-string
    creationPolicy: Owner
    template:
      type: Opaque
      engineVersion: v2
      data:
        # Construct a full connection string from individual parts
        DATABASE_URL: >-
          postgresql://{{ .db_user }}:{{ .db_password | urlPathEscape }}@
          {{- .db_host }}:5432/{{ .db_name }}?sslmode=require
        # Base64-encode a value (useful for some applications)
        API_KEY_B64: "{{ .api_key | b64enc }}"
        # Build a JSON config blob
        config.json: |
          {
            "database": {
              "host": "{{ .db_host }}",
              "port": 5432,
              "name": "{{ .db_name }}"
            },
            "redis": {
              "url": "{{ .redis_url }}"
            }
          }
  data:
  - secretKey: db_user
    remoteRef:
      key: production/database
      property: username
  - secretKey: db_password
    remoteRef:
      key: production/database
      property: password
  - secretKey: db_host
    remoteRef:
      key: production/database
      property: host
  - secretKey: db_name
    remoteRef:
      key: production/database
      property: name
  - secretKey: api_key
    remoteRef:
      key: production/api
      property: key
  - secretKey: redis_url
    remoteRef:
      key: production/redis
      property: url
```

### Generating TLS secrets from Vault PKI

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-tls-from-vault
  namespace: production
spec:
  refreshInterval: 24h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: api-tls
    creationPolicy: Owner
    template:
      type: kubernetes.io/tls
      data:
        tls.crt: "{{ .certificate }}"
        tls.key: "{{ .private_key }}"
  data:
  - secretKey: certificate
    remoteRef:
      key: production/tls/api
      property: certificate
  - secretKey: private_key
    remoteRef:
      key: production/tls/api
      property: private_key
```

## Push Secrets

PushSecret pushes a Kubernetes Secret value into an external secret manager. This is the reverse of ExternalSecret and is useful for seeding secrets or sharing values between clusters.

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-app-token
  namespace: production
spec:
  refreshInterval: 10m
  secretStoreRefs:
  - name: vault-backend
    kind: SecretStore
  selector:
    secret:
      name: app-token-local
  data:
  - match:
      secretKey: token
      remoteRef:
        remoteKey: production/shared/app-token
        property: token
```

## Comparing External Secrets Operator with Sealed Secrets

| Feature | External Secrets Operator | Sealed Secrets |
|---|---|---|
| Secret storage | External backend (Vault, AWS, GCP) | Kubernetes etcd (encrypted) |
| GitOps friendly | Partial — stores references only | Yes — SealedSecret CRD in Git |
| Rotation | Automatic on refresh interval | Manual re-seal required |
| Multi-cluster | Yes — shared backend | No — cluster-specific keys |
| Audit trail | In the external backend | Via Kubernetes audit logs |
| Operator required | Yes | Yes (controller) |
| Air-gapped clusters | Requires backend access | Works offline |
| Secret templating | Yes — powerful Go templates | No |

ESO is preferred when you already operate a secrets backend, need automatic rotation, or require cross-cluster sharing. Sealed Secrets is simpler for teams with no existing backend and a strong GitOps discipline.

## Monitoring and Alerting

ESO exposes Prometheus metrics on port 8080:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: external-secrets
  namespace: external-secrets
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: external-secrets
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
```

Key metrics to alert on:

```yaml
# Alert when sync fails
- alert: ExternalSecretSyncFailed
  expr: |
    externalsecret_sync_calls_error > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "ExternalSecret {{ $labels.name }} in {{ $labels.namespace }} is failing to sync"

# Alert when secret is not ready
- alert: ExternalSecretNotReady
  expr: |
    externalsecret_status_condition{condition="Ready", status="False"} == 1
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "ExternalSecret {{ $labels.name }} is not in Ready state"

# Alert on Vault authentication failures
- alert: VaultAuthFailed
  expr: |
    rate(externalsecret_provider_api_calls_error_total{provider="vault"}[5m]) > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Vault authentication is failing for External Secrets Operator"
```

## Debugging ExternalSecret Failures

```bash
# Check ExternalSecret status
kubectl describe externalsecret database-credentials -n production

# Look for conditions
kubectl get externalsecret database-credentials -n production -o jsonpath='{.status.conditions}' | jq .

# Check controller logs
kubectl logs -n external-secrets \
  -l app.kubernetes.io/name=external-secrets \
  --since=15m

# Check generated secret
kubectl get secret database-secret -n production -o jsonpath='{.data}' | jq 'keys'

# Verify the secret store is valid
kubectl get secretstore vault-backend -n production -o jsonpath='{.status.conditions}' | jq .
```

Common error messages:

```
# Vault path not found
could not get secret: secret not found

# Vault authentication failure
could not authenticate to vault: permission denied

# AWS credentials issue
could not get secret: AccessDeniedException: User is not authorized

# Wrong secret key name
could not get secret: key "username" not found in secret "production/database"
```

## RBAC for ExternalSecret

Restrict which namespaces can create ExternalSecrets pointing to a ClusterSecretStore:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-cluster
spec:
  conditions:
  - namespaceSelector:
      matchLabels:
        secrets.external-secrets.io/vault-access: "true"
  provider:
    vault:
      server: "https://vault.internal.example.com:8200"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets-cluster"
          serviceAccountRef:
            name: "external-secrets"
            namespace: "external-secrets"
```

Label namespaces that should have access:

```bash
kubectl label namespace production secrets.external-secrets.io/vault-access=true
kubectl label namespace staging secrets.external-secrets.io/vault-access=true
```

## Summary

External Secrets Operator provides a production-grade bridge between Kubernetes and secret management backends:

- Use `SecretStore` for namespace-scoped access and `ClusterSecretStore` for org-wide secret backends.
- Prefer Vault Kubernetes auth or AWS IRSA over static credentials in Kubernetes Secrets.
- Use `refreshInterval` to match your secret rotation policy — short intervals for frequently rotated credentials.
- Leverage the template engine to compose connection strings and structured configs from individual secret properties.
- Monitor `externalsecret_sync_calls_error` and `externalsecret_status_condition` metrics to detect sync failures early.
- Combine with `PushSecret` to seed secrets between environments or push generated credentials back to the vault.
