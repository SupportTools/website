---
title: "External Secrets Operator: Enterprise Secret Management for Kubernetes"
date: 2027-10-09T00:00:00-05:00
draft: false
tags: ["External Secrets", "Kubernetes", "HashiCorp Vault", "AWS Secrets Manager", "Security"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to External Secrets Operator for Kubernetes secret management. Covers SecretStore and ClusterSecretStore configuration, all major providers, ExternalSecret templating, push secrets, rotation automation, IRSA integration, and multi-tenancy patterns."
more_link: "yes"
url: "/external-secrets-operator-guide/"
---

Managing secrets in Kubernetes clusters without a dedicated secrets management integration results in either insecure practices — storing secrets in Git, manually copying them between clusters — or operational complexity that does not scale. The External Secrets Operator (ESO) bridges enterprise secret stores with Kubernetes, keeping secrets in authoritative stores while presenting them as native Kubernetes Secret objects to applications. This guide covers every aspect of ESO deployment and configuration for production enterprise environments.

<!--more-->

# External Secrets Operator: Enterprise Secret Management for Kubernetes

## Section 1: Architecture and Core Concepts

External Secrets Operator introduces four primary CRDs:

- **SecretStore**: Namespace-scoped store definition. Applications within the same namespace reference it for secrets.
- **ClusterSecretStore**: Cluster-scoped store definition. Any namespace can reference it, making it suitable for shared infrastructure secrets.
- **ExternalSecret**: Namespace-scoped resource that maps keys from a SecretStore to a Kubernetes Secret.
- **ClusterExternalSecret**: Cluster-scoped resource that creates ExternalSecrets across multiple namespaces matching a selector.

### Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version 0.10.3 \
  --set installCRDs=true \
  --set replicaCount=2 \
  --set leaderElect=true \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=512Mi \
  --set metrics.service.enabled=true \
  --set serviceMonitor.enabled=true \
  --set serviceMonitor.labels.release=prometheus
```

Verify installation:

```bash
kubectl -n external-secrets get pods
kubectl get crds | grep external-secrets.io
```

## Section 2: AWS Secrets Manager Provider

### IRSA-Based Authentication

The recommended authentication method for EKS clusters is IAM Roles for Service Accounts (IRSA). This eliminates static credentials from the cluster entirely.

Create the IAM policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowSecretsManagerRead",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:ListSecretVersionIds"
      ],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:production/*",
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/*"
      ]
    }
  ]
}
```

Create the IAM role with OIDC trust policy:

```bash
# Get OIDC provider URL
OIDC_URL=$(aws eks describe-cluster \
  --name production-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text | sed 's|https://||')

# Create trust policy
cat > trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/${OIDC_URL}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_URL}:sub": "system:serviceaccount:external-secrets:external-secrets",
          "${OIDC_URL}:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
EOF

aws iam create-role \
  --role-name eks-external-secrets \
  --assume-role-policy-document file://trust-policy.json

aws iam attach-role-policy \
  --role-name eks-external-secrets \
  --policy-arn arn:aws:iam::123456789012:policy/ExternalSecretsPolicy
```

Annotate the ESO service account:

```bash
kubectl -n external-secrets annotate serviceaccount external-secrets \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/eks-external-secrets
```

### ClusterSecretStore for AWS Secrets Manager

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secretsmanager
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

### ExternalSecret from AWS Secrets Manager

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
    deletionPolicy: Retain
    template:
      engineVersion: v2
      type: Opaque
      data:
        # Reference template variables to build connection string
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .dbname }}?sslmode=require"
        DATABASE_HOST: "{{ .host }}"
        DATABASE_PORT: "{{ .port }}"
        DATABASE_USER: "{{ .username }}"
        DATABASE_PASSWORD: "{{ .password }}"
  data:
    - secretKey: username
      remoteRef:
        key: production/database/primary
        property: username
    - secretKey: password
      remoteRef:
        key: production/database/primary
        property: password
    - secretKey: host
      remoteRef:
        key: production/database/primary
        property: host
    - secretKey: port
      remoteRef:
        key: production/database/primary
        property: port
    - secretKey: dbname
      remoteRef:
        key: production/database/primary
        property: dbname
```

### Fetching an Entire Secret as JSON

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-config-full
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: app-config-full
    creationPolicy: Owner
  dataFrom:
    - extract:
        key: production/app/config
        # All key-value pairs in the secret become individual keys in the K8s Secret
```

## Section 3: HashiCorp Vault Provider

### Vault Authentication — Kubernetes Auth Method

```bash
# Enable Kubernetes auth in Vault
vault auth enable kubernetes

# Configure Kubernetes auth
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"

# Create policy for external secrets
vault policy write external-secrets - <<'POLICY'
path "secret/data/production/*" {
  capabilities = ["read"]
}
path "secret/metadata/production/*" {
  capabilities = ["list", "read"]
}
path "kv/data/shared/*" {
  capabilities = ["read"]
}
POLICY

# Create Vault role bound to Kubernetes service account
vault write auth/kubernetes/role/external-secrets \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=external-secrets \
  ttl=1h
```

### ClusterSecretStore for HashiCorp Vault

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: https://vault.vault.svc.cluster.local:8200
      path: secret
      version: v2
      caBundle: |-
        LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...
      auth:
        kubernetes:
          mountPath: kubernetes
          role: external-secrets
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### ExternalSecret from Vault KV v2

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payment-service-secrets
  namespace: payment
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: payment-service-secrets
    creationPolicy: Owner
    template:
      engineVersion: v2
      data:
        STRIPE_API_KEY: "{{ .stripe_api_key }}"
        STRIPE_WEBHOOK_SECRET: "{{ .stripe_webhook_secret }}"
        ENCRYPTION_KEY: "{{ .encryption_key | b64dec }}"
  data:
    - secretKey: stripe_api_key
      remoteRef:
        key: secret/production/payment-service
        property: stripe_api_key
    - secretKey: stripe_webhook_secret
      remoteRef:
        key: secret/production/payment-service
        property: stripe_webhook_secret
    - secretKey: encryption_key
      remoteRef:
        key: secret/production/payment-service
        property: encryption_key
```

### Vault Dynamic Secrets via ESO

ESO supports fetching dynamically generated credentials from Vault's database secrets engine:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: dynamic-db-credentials
  namespace: app
spec:
  # Short refresh interval to stay within credential TTL
  refreshInterval: 10m
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: dynamic-db-credentials
    creationPolicy: Owner
  data:
    - secretKey: username
      remoteRef:
        key: database/creds/readonly-role
        property: username
    - secretKey: password
      remoteRef:
        key: database/creds/readonly-role
        property: password
```

## Section 4: GCP Secret Manager Provider

### Workload Identity Authentication

```bash
# Create GCP service account
gcloud iam service-accounts create external-secrets-gsa \
  --display-name "External Secrets Operator"

# Grant access to Secret Manager
gcloud projects add-iam-policy-binding my-gcp-project \
  --member "serviceAccount:external-secrets-gsa@my-gcp-project.iam.gserviceaccount.com" \
  --role "roles/secretmanager.secretAccessor"

# Bind GCP service account to Kubernetes service account
gcloud iam service-accounts add-iam-policy-binding \
  external-secrets-gsa@my-gcp-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-gcp-project.svc.id.goog[external-secrets/external-secrets]"

# Annotate Kubernetes service account
kubectl -n external-secrets annotate serviceaccount external-secrets \
  iam.gke.io/gcp-service-account=external-secrets-gsa@my-gcp-project.iam.gserviceaccount.com
```

### ClusterSecretStore for GCP Secret Manager

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: gcp-secret-manager
spec:
  provider:
    gcpsm:
      projectID: my-gcp-project
      auth:
        workloadIdentity:
          clusterLocation: us-central1
          clusterName: production-cluster
          clusterProjectID: my-gcp-project
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### ExternalSecret from GCP Secret Manager

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: gcp-app-secrets
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: gcp-secret-manager
    kind: ClusterSecretStore
  target:
    name: gcp-app-secrets
    creationPolicy: Owner
  data:
    - secretKey: api-key
      remoteRef:
        key: projects/my-gcp-project/secrets/production-api-key
        version: latest
    - secretKey: oauth-client-secret
      remoteRef:
        key: projects/my-gcp-project/secrets/production-oauth-secret
        version: "3"  # Pin to specific version
```

## Section 5: Azure Key Vault Provider

### Managed Identity Authentication

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: azure-keyvault
spec:
  provider:
    azurekv:
      authType: ManagedIdentity
      vaultUrl: https://production-keyvault.vault.azure.net/
      # For user-assigned managed identity:
      identityId: /subscriptions/sub-id/resourcegroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/eso-identity
```

### ExternalSecret from Azure Key Vault

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: azure-app-secrets
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: azure-keyvault
    kind: ClusterSecretStore
  target:
    name: azure-app-secrets
    creationPolicy: Owner
  data:
    - secretKey: connection-string
      remoteRef:
        key: production-sql-connection-string
    - secretKey: storage-key
      remoteRef:
        key: production-storage-account-key
        version: "abc123def456"  # Optional version ID
    - secretKey: tls-cert
      remoteRef:
        key: production-tls-certificate
        metadataPolicy: Fetch
```

## Section 6: ExternalSecret Templating and Data Transforms

ESO's template engine allows transforming secrets before creating the Kubernetes Secret.

### Advanced Template Usage

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: complex-secret
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: complex-secret
    creationPolicy: Owner
    template:
      engineVersion: v2
      type: kubernetes.io/dockerconfigjson
      data:
        # Build a Docker registry credentials JSON
        .dockerconfigjson: |
          {
            "auths": {
              "{{ .registry_host }}": {
                "auth": "{{ printf "%s:%s" .registry_user .registry_password | b64enc }}"
              }
            }
          }
  data:
    - secretKey: registry_host
      remoteRef:
        key: production/registry/credentials
        property: host
    - secretKey: registry_user
      remoteRef:
        key: production/registry/credentials
        property: username
    - secretKey: registry_password
      remoteRef:
        key: production/registry/credentials
        property: password
```

### TLS Secret Generation

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: tls-secret
  namespace: ingress-nginx
spec:
  refreshInterval: 24h
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: wildcard-tls
    creationPolicy: Owner
    template:
      engineVersion: v2
      type: kubernetes.io/tls
      data:
        tls.crt: "{{ .cert }}"
        tls.key: "{{ .key }}"
  data:
    - secretKey: cert
      remoteRef:
        key: secret/production/tls/wildcard
        property: certificate
    - secretKey: key
      remoteRef:
        key: secret/production/tls/wildcard
        property: private_key
```

### Using Template Functions

ESO templates support Sprig functions and base64 encoding/decoding:

```yaml
target:
  template:
    engineVersion: v2
    data:
      # Base64 encode a value
      encoded_secret: "{{ .raw_value | b64enc }}"

      # Decode a base64-encoded value from the store
      decoded_value: "{{ .b64_value | b64dec }}"

      # Convert JSON string to formatted output
      app_config: |
        host={{ .db_host }}
        port={{ .db_port }}
        name={{ .db_name }}
        user={{ .db_user }}
        password={{ .db_password }}

      # Conditional logic
      log_level: "{{ if eq .environment \"production\" }}warn{{ else }}debug{{ end }}"

      # String manipulation
      normalized_name: "{{ .service_name | lower | replace \"_\" \"-\" }}"

      # Date-based value
      rotation_date: "{{ now | date \"2006-01-02\" }}"
```

## Section 7: Push Secrets Back to Stores

ESO supports writing Kubernetes Secrets back to external stores. This enables GitOps workflows for certificate rotation where cert-manager generates a certificate that needs to be stored in a central secrets store.

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-cert-to-vault
  namespace: production
spec:
  refreshInterval: 10m
  secretStoreRefs:
    - name: vault-backend
      kind: ClusterSecretStore
  selector:
    secret:
      name: production-tls-cert
  data:
    - match:
        secretKey: tls.crt
        remoteRef:
          remoteKey: secret/production/tls/current
          property: certificate
    - match:
        secretKey: tls.key
        remoteRef:
          remoteKey: secret/production/tls/current
          property: private_key
```

## Section 8: Secret Rotation Automation

### Force Refresh via Annotation

```bash
# Force immediate refresh of an ExternalSecret
kubectl -n production annotate externalsecret database-credentials \
  force-sync=$(date +%s) \
  --overwrite

# Check sync status
kubectl -n production get externalsecret database-credentials \
  -o jsonpath='{.status.conditions}'
```

### Automated Rotation with a Controller

For secrets that require application restarts after rotation, deploy a rollout trigger:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: secret-rotation-trigger
  namespace: production
spec:
  schedule: "0 3 * * 0"  # Weekly on Sunday at 3 AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: rotation-trigger
          restartPolicy: OnFailure
          containers:
            - name: trigger
              image: bitnami/kubectl:1.29
              command:
                - /bin/sh
                - -c
                - |
                  set -e

                  echo "Forcing ExternalSecret refresh..."
                  kubectl -n production annotate externalsecret database-credentials \
                    force-sync=$(date +%s) --overwrite

                  echo "Waiting for secret refresh..."
                  sleep 30

                  echo "Rolling deployments that use rotated secrets..."
                  kubectl -n production rollout restart deployment/api-server
                  kubectl -n production rollout restart deployment/worker

                  echo "Waiting for rollout completion..."
                  kubectl -n production rollout status deployment/api-server --timeout=5m
                  kubectl -n production rollout status deployment/worker --timeout=5m

                  echo "Rotation complete."
```

### Reloader Integration

For automatic pod restarts when secrets change, deploy Reloader alongside ESO:

```bash
helm repo add stakater https://stakater.github.io/stakater-charts
helm install reloader stakater/reloader \
  --namespace reloader \
  --create-namespace \
  --set reloader.watchGlobally=false
```

Annotate deployments to watch for secret changes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
  annotations:
    # Restart when any of these secrets change
    secret.reloader.stakater.com/reload: "database-credentials,payment-service-secrets"
spec:
  template:
    spec:
      containers:
        - name: api-server
          image: support-tools/api-server:v2.5.0
          envFrom:
            - secretRef:
                name: database-credentials
            - secretRef:
                name: payment-service-secrets
```

## Section 9: ClusterExternalSecret for Multi-Namespace Deployment

ClusterExternalSecret creates ExternalSecrets across all namespaces matching a selector. This eliminates the need to manually create ExternalSecrets in every namespace.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterExternalSecret
metadata:
  name: cluster-tls-cert
spec:
  # Create ExternalSecrets in all namespaces with this label
  namespaceSelectors:
    - matchLabels:
        external-secrets/tls: "enabled"
  refreshTime: 1m
  externalSecretSpec:
    refreshInterval: 24h
    secretStoreRef:
      name: vault-backend
      kind: ClusterSecretStore
    target:
      name: wildcard-tls
      creationPolicy: Owner
      template:
        type: kubernetes.io/tls
        data:
          tls.crt: "{{ .cert }}"
          tls.key: "{{ .key }}"
    data:
      - secretKey: cert
        remoteRef:
          key: secret/shared/tls/wildcard
          property: certificate
      - secretKey: key
        remoteRef:
          key: secret/shared/tls/wildcard
          property: private_key
```

Label namespaces to receive the secret:

```bash
kubectl label namespace production external-secrets/tls=enabled
kubectl label namespace staging external-secrets/tls=enabled
kubectl label namespace ingress-nginx external-secrets/tls=enabled
```

## Section 10: Multi-Tenancy Patterns

### Per-Tenant SecretStore with Namespace Isolation

Each tenant gets their own SecretStore with access only to their secrets:

```yaml
# Template for per-tenant SecretStore
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: tenant-secret-store
  namespace: tenant-acme
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            # Each tenant has their own service account with IRSA
            name: tenant-acme-external-secrets
            namespace: tenant-acme
```

Per-tenant IAM role restricts access to only that tenant's secrets:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      "Resource": "arn:aws:secretsmanager:us-east-1:123456789012:secret:tenants/acme/*"
    }
  ]
}
```

### Vault Namespace Isolation

For Vault Enterprise with namespaces:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: tenant-vault
  namespace: tenant-acme
spec:
  provider:
    vault:
      server: https://vault.vault.svc.cluster.local:8200
      path: secret
      version: v2
      namespace: tenants/acme  # Vault Enterprise namespace
      auth:
        kubernetes:
          mountPath: kubernetes
          role: tenant-acme
          serviceAccountRef:
            name: tenant-acme-sa
```

### Restricting ExternalSecret to Specific Stores

Use namespace-level network policies and RBAC to prevent tenants from referencing ClusterSecretStores they should not access:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecretStorePermission
metadata:
  name: restrict-clustersecretstore
  namespace: tenant-acme
spec:
  # Only allow ExternalSecrets in this namespace to use
  # tenant-specific stores, not shared cluster stores
  deny:
    - name: "*"
      kind: ClusterSecretStore
  allow:
    - name: tenant-secret-store
      kind: SecretStore
```

## Section 11: Operational Monitoring

### Prometheus Metrics

ESO exposes metrics that reveal sync status and errors:

```bash
kubectl -n external-secrets port-forward svc/external-secrets-metrics 8080:8080
curl -s http://localhost:8080/metrics | grep externalsecret
```

Key metrics:

```
# Sync success/failure counts
externalsecret_sync_calls_total{name, namespace, synced}

# Time since last successful sync
externalsecret_sync_calls_duration_seconds{name, namespace}

# Number of secrets managed
externalsecret_status_condition{name, namespace, condition, status}
```

### PrometheusRule for ESO Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-alerts
  namespace: external-secrets
  labels:
    release: prometheus
spec:
  groups:
    - name: external-secrets
      rules:
        - alert: ExternalSecretSyncFailed
          expr: >
            externalsecret_status_condition{condition="Ready", status="False"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ExternalSecret {{ $labels.namespace }}/{{ $labels.name }} sync failed"
            description: "ExternalSecret has been failing to sync for 5 minutes."

        - alert: ExternalSecretNotSynced
          expr: >
            time() - externalsecret_sync_calls_total{synced="true"} > 7200
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ExternalSecret {{ $labels.namespace }}/{{ $labels.name }} not synced recently"
            description: "ExternalSecret has not synced successfully in over 2 hours."

        - alert: ExternalSecretsControllerDown
          expr: up{job="external-secrets"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "External Secrets Operator is down"
```

### Debugging Sync Failures

```bash
# Check ExternalSecret status conditions
kubectl -n production get externalsecret database-credentials \
  -o jsonpath='{.status.conditions}' | python3 -m json.tool

# Check controller logs for a specific secret
kubectl -n external-secrets logs deployment/external-secrets \
  | grep "database-credentials" | tail -20

# Describe ExternalSecret for full status
kubectl -n production describe externalsecret database-credentials

# Check events
kubectl -n production get events \
  --field-selector involvedObject.name=database-credentials \
  --sort-by='.lastTimestamp'

# Validate SecretStore connectivity
kubectl -n external-secrets logs deployment/external-secrets \
  | grep -E "ERROR|failed|SecretStore" | tail -30
```

## Section 12: Production Readiness Checklist

```bash
#!/bin/bash
# eso-readiness-check.sh

NAMESPACE="external-secrets"

echo "=== External Secrets Operator Readiness Check ==="

echo ""
echo "1. Controller deployment health"
kubectl -n "${NAMESPACE}" get deployment external-secrets \
  -o jsonpath='Desired: {.spec.replicas}, Ready: {.status.readyReplicas}{"\n"}'

echo ""
echo "2. All ExternalSecrets synced"
FAILED=$(kubectl get externalsecrets --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
  | grep -v "True" | wc -l)
echo "Failed/unsynced ExternalSecrets: ${FAILED}"

echo ""
echo "3. SecretStore connectivity"
kubectl get secretstores --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

echo ""
echo "4. ClusterSecretStore connectivity"
kubectl get clustersecretstores \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}'

echo ""
echo "5. ServiceMonitor presence"
kubectl -n "${NAMESPACE}" get servicemonitor external-secrets --no-headers 2>/dev/null \
  || echo "WARNING: No ServiceMonitor found"

echo ""
echo "6. PrometheusRule presence"
kubectl get prometheusrule external-secrets-alerts -n "${NAMESPACE}" --no-headers 2>/dev/null \
  || echo "WARNING: No PrometheusRule found"

echo ""
echo "7. Recent sync errors in controller logs"
kubectl -n "${NAMESPACE}" logs deployment/external-secrets \
  --since=1h | grep -c "ERROR" | xargs echo "Error count (last 1h):"

echo ""
echo "=== Readiness check complete ==="
```

The External Secrets Operator provides a consistent, provider-agnostic interface for enterprise secret management that scales from a single cluster to a fleet of hundreds. By eliminating static secrets from cluster configurations and providing automated rotation, ESO dramatically reduces the attack surface and operational burden associated with secret management in Kubernetes environments.
