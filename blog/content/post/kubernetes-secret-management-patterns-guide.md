---
title: "Kubernetes Secret Management: From Sealed Secrets to External Secrets Operator"
date: 2027-04-17T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets", "Security", "Vault", "External Secrets", "Sealed Secrets"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise patterns for Kubernetes secret management covering Sealed Secrets, External Secrets Operator, Vault Agent Injector, CSI Secrets Store Driver, and GitOps-compatible workflows."
more_link: "yes"
url: "/kubernetes-secret-management-patterns-guide/"
---

Kubernetes Secrets are base64-encoded, not encrypted, by default. Any user with read access to the cluster's etcd or a namespace's secrets can trivially decode them. Enterprise-grade secret management requires encrypting secrets at rest, storing source-of-truth credentials outside the cluster, rotating secrets without pod restarts, and enabling GitOps workflows without committing plaintext credentials to version control.

This guide covers the full spectrum of Kubernetes secret management patterns: Sealed Secrets for GitOps-compatible encryption, External Secrets Operator (ESO) for synchronization from AWS Secrets Manager, HashiCorp Vault, and GCP Secret Manager, the Vault Agent Injector for sidecar-based secret delivery, the Secrets Store CSI Driver for filesystem-mounted secrets, automatic secret rotation, and IRSA/Workload Identity for cloud-native authentication.

<!--more-->

## Section 1: The Secret Management Spectrum

### Threat Model

```
Threat                          │ Sealed  │ ESO   │ Vault │ CSI   │
────────────────────────────────┼─────────┼───────┼───────┼───────┤
Plaintext in Git                │ Blocked │ OK    │ OK    │ OK    │
base64 in etcd (at rest)        │ OK*     │ OK    │ OK    │ OK    │
Namespace read access leak      │ Partial │ Limit │ Limit │ Limit │
Cluster admin access leak       │ No      │ No    │ No    │ No    │
Secret rotation without restart │ No      │ Yes   │ Yes   │ Yes   │
Centralized audit trail         │ No      │ Yes   │ Yes   │ Yes   │
Cross-cluster sharing           │ No      │ Yes   │ Yes   │ Yes   │

* Requires separate etcd encryption-at-rest configuration
```

### Decision Framework

| Requirement | Recommended Solution |
|---|---|
| GitOps with no external dependency | Sealed Secrets |
| Secrets in AWS Secrets Manager | ESO with AWS provider |
| Secrets in HashiCorp Vault | ESO or Vault Agent Injector |
| Dynamic credentials (DB, cloud) | Vault Agent Injector |
| Secrets mounted as files | CSI Secrets Store Driver |
| Multi-cloud, single operator | ESO |

---

## Section 2: Enabling etcd Encryption at Rest

Before deploying any secret management solution, etcd encryption at rest must be enabled to protect secrets from direct etcd access.

### EncryptionConfiguration

```yaml
# /etc/kubernetes/pki/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      # Primary provider: AES-GCM with a 256-bit key
      - aescbc:
          keys:
            - name: key1
              # Generate: head -c 32 /dev/urandom | base64
              secret: REPLACE_WITH_BASE64_32_BYTE_KEY
      # Identity: allows reading unencrypted secrets (for migration)
      - identity: {}
```

```bash
# Apply to kube-apiserver by adding the flag:
# --encryption-provider-config=/etc/kubernetes/pki/encryption-config.yaml

# After enabling, re-encrypt all existing secrets
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -

# Verify a secret is encrypted in etcd
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/my-secret | hexdump -C | head
# Output should show k8s:enc:aescbc:v1 prefix
```

---

## Section 3: Sealed Secrets

Sealed Secrets uses asymmetric cryptography to encrypt Kubernetes Secrets into `SealedSecret` objects that can be safely committed to Git. Only the Sealed Secrets controller in the cluster holds the private key needed to decrypt them.

### Install Sealed Secrets Controller

```bash
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm repo update

helm upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
  --namespace kube-system \
  --version 2.15.3 \
  --set fullnameOverride=sealed-secrets-controller \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=64Mi \
  --set resources.limits.cpu=200m \
  --set resources.limits.memory=128Mi \
  --wait
```

### Install kubeseal CLI

```bash
KUBESEAL_VERSION="0.27.0"
curl -Lo kubeseal.tar.gz \
  "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz"
tar xzf kubeseal.tar.gz
sudo install -m 755 kubeseal /usr/local/bin/
kubeseal --version
```

### Creating a SealedSecret

```bash
# Method 1: Seal from a raw Secret manifest
kubectl create secret generic db-credentials \
  --namespace production \
  --from-literal=username=appuser \
  --from-literal=password=EXAMPLE_TOKEN_REPLACE_ME \
  --dry-run=client \
  -o yaml | \
  kubeseal \
    --controller-namespace kube-system \
    --controller-name sealed-secrets-controller \
    --format yaml > sealed-db-credentials.yaml

cat sealed-db-credentials.yaml
```

```yaml
# sealed-db-credentials.yaml — safe to commit to Git
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  encryptedData:
    # These are encrypted ciphertexts — safe to store in Git
    username: AgBvJxKP8... (long base64-encoded ciphertext)
    password: AgCdKjLm9... (long base64-encoded ciphertext)
  template:
    metadata:
      name: db-credentials
      namespace: production
    type: Opaque
```

```bash
# Apply the SealedSecret — controller decrypts and creates the Secret
kubectl apply -f sealed-db-credentials.yaml

# Verify the resulting Secret was created
kubectl get secret db-credentials -n production
kubectl get sealedsecret db-credentials -n production
```

### Namespace and Cluster Scopes

By default, SealedSecrets are scoped to a specific namespace, preventing cross-namespace decryption attacks.

```bash
# Strict scope (default): bound to both name and namespace
kubeseal --scope strict ...

# Namespace-wide scope: bound to namespace only, any name
kubeseal --scope namespace-wide ...

# Cluster-wide scope: can be decrypted in any namespace
kubeseal --scope cluster-wide ...
```

### Key Rotation

```bash
# Generate a new sealing key manually (optional — controller auto-rotates every 30 days)
kubectl annotate secret \
  -n kube-system \
  sealed-secrets-key \
  sealedsecrets.bitnami.com/rotate-now=""

# Backup the sealing key for disaster recovery
kubectl get secret \
  -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
  -o yaml > sealing-key-backup.yaml

# IMPORTANT: Store this backup securely — it decrypts all SealedSecrets
```

### Automated CI/CD Workflow

```yaml
# .github/workflows/seal-secrets.yaml
name: Seal and Apply Secrets

on:
  workflow_dispatch:
    inputs:
      environment:
        description: "Target environment"
        required: true
        type: choice
        options: [development, staging, production]

jobs:
  seal-secrets:
    runs-on: ubuntu-latest
    environment: ${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4

      - name: Install kubeseal
        run: |
          curl -Lo kubeseal.tar.gz \
            "https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.27.0/kubeseal-0.27.0-linux-amd64.tar.gz"
          tar xzf kubeseal.tar.gz
          sudo install -m 755 kubeseal /usr/local/bin/

      - name: Seal secrets from environment variables
        env:
          DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
          API_KEY: ${{ secrets.API_KEY }}
        run: |
          kubectl create secret generic app-secrets \
            --namespace=${{ inputs.environment }} \
            --from-literal=db_password="${DB_PASSWORD}" \
            --from-literal=api_key="${API_KEY}" \
            --dry-run=client \
            -o yaml | \
            kubeseal \
              --cert ./sealing-certs/${{ inputs.environment }}-cert.pem \
              --format yaml > sealed-app-secrets.yaml

      - name: Apply SealedSecret
        run: kubectl apply -f sealed-app-secrets.yaml
```

---

## Section 4: External Secrets Operator (ESO)

External Secrets Operator watches `ExternalSecret` and `ClusterExternalSecret` custom resources and synchronizes secrets from external providers (AWS Secrets Manager, Vault, GCP Secret Manager, Azure Key Vault, and others) into Kubernetes Secrets on a configurable interval.

### Install ESO

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version 0.10.5 \
  --set installCRDs=true \
  --set resources.requests.cpu=50m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=256Mi \
  --wait
```

### ESO with AWS Secrets Manager (IRSA)

#### Create IAM Policy and Role

```bash
# Create IAM policy for Secrets Manager access
cat > secrets-manager-policy.json << 'EOF'
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
EOF

aws iam create-policy \
  --policy-name ESOSecretsManagerPolicy \
  --policy-document file://secrets-manager-policy.json

# Create IAM role with OIDC trust for the ESO service account
eksctl create iamserviceaccount \
  --cluster my-cluster \
  --namespace external-secrets \
  --name external-secrets \
  --attach-policy-arn arn:aws:iam::123456789012:policy/ESOSecretsManagerPolicy \
  --approve \
  --override-existing-serviceaccounts
```

#### ClusterSecretStore for AWS

```yaml
# cluster-secret-store-aws.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      # Use IRSA — no static credentials required
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

#### ExternalSecret Syncing from AWS

```yaml
# external-secret-db.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-credentials
  namespace: production
spec:
  # Sync every 1 hour
  refreshInterval: 1h

  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore

  target:
    name: db-credentials       # Name of the resulting Kubernetes Secret
    creationPolicy: Owner      # ESO owns the secret — deletes it when ExternalSecret is deleted
    template:
      type: Opaque
      metadata:
        labels:
          managed-by: external-secrets
      data:
        # Construct the secret fields from template
        DATABASE_URL: "postgres://{{ .username }}:{{ .password }}@{{ .host }}:5432/{{ .database }}"
        REDIS_URL: "redis://:{{ .redis_password }}@{{ .redis_host }}:6379"

  data:
    - secretKey: username
      remoteRef:
        key: "production/database"
        property: username
    - secretKey: password
      remoteRef:
        key: "production/database"
        property: password
    - secretKey: host
      remoteRef:
        key: "production/database"
        property: host
    - secretKey: database
      remoteRef:
        key: "production/database"
        property: database_name
    - secretKey: redis_password
      remoteRef:
        key: "production/redis"
        property: password
    - secretKey: redis_host
      remoteRef:
        key: "production/redis"
        property: host
```

```bash
# Apply and monitor sync status
kubectl apply -f external-secret-db.yaml

# Check sync status
kubectl get externalsecret db-credentials -n production
# READY=True means the Secret was created successfully

# Describe for detailed status including last sync time
kubectl describe externalsecret db-credentials -n production
```

### ESO with HashiCorp Vault

```yaml
# cluster-secret-store-vault.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
spec:
  provider:
    vault:
      server: "https://vault.company.internal:8200"
      path: "secret"
      version: "v2"
      # Kubernetes authentication method
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

```yaml
# external-secret-vault.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-secrets
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: vault-backend
    kind: ClusterSecretStore
  target:
    name: app-secrets
    creationPolicy: Owner
  dataFrom:
    # Pull all key-value pairs from a Vault path
    - extract:
        key: "production/app"
        version: "WORKAROUND_LATEST"
```

### ESO with GCP Secret Manager (Workload Identity)

```yaml
# cluster-secret-store-gcp.yaml
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
          clusterName: my-gke-cluster
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### ClusterExternalSecret for Multi-Namespace Distribution

```yaml
# cluster-external-secret-tls.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterExternalSecret
metadata:
  name: wildcard-tls-cert
spec:
  # Deploy ExternalSecrets to all namespaces with this label
  namespaceSelector:
    matchLabels:
      inject-tls: "true"
  refreshTime: 1h
  externalSecretSpec:
    refreshInterval: 1h
    secretStoreRef:
      name: aws-secrets-manager
      kind: ClusterSecretStore
    target:
      name: wildcard-tls
      creationPolicy: Owner
      template:
        type: kubernetes.io/tls
    data:
      - secretKey: tls.crt
        remoteRef:
          key: "production/wildcard-cert"
          property: certificate
      - secretKey: tls.key
        remoteRef:
          key: "production/wildcard-cert"
          property: private_key
```

---

## Section 5: HashiCorp Vault Agent Injector

The Vault Agent Injector uses a mutating admission webhook to automatically inject Vault Agent sidecar containers into pods, which authenticate to Vault and render secrets to a shared memory filesystem. Applications read secrets as files without any code changes.

### Install Vault (Production HA Mode)

```yaml
# vault-values.yaml
injector:
  enabled: true
  replicas: 2
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 250m
      memory: 128Mi

server:
  ha:
    enabled: true
    replicas: 3
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = true
        cluster_name = "vault-production"

        storage "raft" {
          path = "/vault/data"
          retry_join {
            leader_api_addr = "https://vault-0.vault-internal:8200"
          }
          retry_join {
            leader_api_addr = "https://vault-1.vault-internal:8200"
          }
          retry_join {
            leader_api_addr = "https://vault-2.vault-internal:8200"
          }
        }

        listener "tcp" {
          tls_disable = 0
          address = "[::]:8200"
          cluster_address = "[::]:8201"
          tls_cert_file = "/vault/userconfig/vault-tls/tls.crt"
          tls_key_file  = "/vault/userconfig/vault-tls/tls.key"
        }

        seal "awskms" {
          region     = "us-east-1"
          kms_key_id = "alias/vault-unseal"
        }

  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1
      memory: 512Mi

  dataStorage:
    enabled: true
    size: 10Gi
    storageClass: premium-rwo
```

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

helm upgrade --install vault hashicorp/vault \
  --namespace vault \
  --create-namespace \
  --version 0.28.1 \
  --values vault-values.yaml \
  --wait
```

### Configure Vault Kubernetes Auth

```bash
# Exec into a Vault pod
kubectl exec -it vault-0 -n vault -- vault operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > vault-init.json

# Unseal (with AWS KMS auto-unseal, this is not needed)
# Store init output securely — contains root token and unseal keys

# Enable Kubernetes auth method
kubectl exec -it vault-0 -n vault -- vault auth enable kubernetes

kubectl exec -it vault-0 -n vault -- vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443"

# Create a policy for the application
kubectl exec -it vault-0 -n vault -- vault policy write app-production - << 'EOF'
path "secret/data/production/*" {
  capabilities = ["read"]
}
path "database/creds/app-role" {
  capabilities = ["read"]
}
EOF

# Create a role binding the policy to a Kubernetes service account
kubectl exec -it vault-0 -n vault -- vault write \
  auth/kubernetes/role/app-production \
  bound_service_account_names=app \
  bound_service_account_namespaces=production \
  policies=app-production \
  ttl=1h
```

### Vault Agent Injector Annotations

```yaml
# deployment-with-vault-injection.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  namespace: production
spec:
  template:
    metadata:
      annotations:
        # Enable Vault Agent injection
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "app-production"
        vault.hashicorp.com/agent-inject-status: "update"

        # Inject secret as a file at /vault/secrets/db-credentials
        vault.hashicorp.com/agent-inject-secret-db-credentials: "secret/data/production/database"
        vault.hashicorp.com/agent-inject-template-db-credentials: |
          {{- with secret "secret/data/production/database" -}}
          export DB_HOST="{{ .Data.data.host }}"
          export DB_USER="{{ .Data.data.username }}"
          export DB_PASS="{{ .Data.data.password }}"
          export DB_NAME="{{ .Data.data.database }}"
          {{- end -}}

        # Dynamic database credentials
        vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/app-role"
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/app-role" -}}
          {{ .Data.username }}:{{ .Data.password }}
          {{- end -}}

        # Resource limits for injected Vault Agent
        vault.hashicorp.com/agent-limits-cpu: "100m"
        vault.hashicorp.com/agent-limits-mem: "128Mi"
        vault.hashicorp.com/agent-requests-cpu: "50m"
        vault.hashicorp.com/agent-requests-mem: "64Mi"

        # Pre-populate secrets before the application starts
        vault.hashicorp.com/agent-init-first: "true"

    spec:
      serviceAccountName: app
      containers:
        - name: app
          image: registry.company.internal/app:1.5.0
          command: ["/bin/sh", "-c"]
          args:
            - |
              source /vault/secrets/db-credentials
              exec /app/server
          volumeMounts:
            - name: vault-secrets
              mountPath: /vault/secrets
              readOnly: true
```

---

## Section 6: Secrets Store CSI Driver

The Secrets Store CSI Driver mounts secrets, keys, and certificates stored in external secret stores directly as Kubernetes volumes. The secrets are never stored in the Kubernetes Secret API object (unless configured with `syncAsKubernetesSecret`).

### Install the CSI Driver

```bash
helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm repo update

helm upgrade --install csi-secrets-store \
  secrets-store-csi-driver/secrets-store-csi-driver \
  --namespace kube-system \
  --version 1.4.5 \
  --set syncSecret.enabled=true \
  --set enableSecretRotation=true \
  --set rotationPollInterval=2m \
  --wait

# Install the AWS provider
kubectl apply -f https://raw.githubusercontent.com/aws/secrets-store-csi-driver-provider-aws/main/deployment/aws-provider-installer.yaml
```

### SecretProviderClass for AWS Secrets Manager

```yaml
# secret-provider-class-aws.yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: app-secrets-aws
  namespace: production
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: "production/database"
        objectType: "secretsmanager"
        objectAlias: "database"
        jmesPath:
          - path: "username"
            objectAlias: "db_username"
          - path: "password"
            objectAlias: "db_password"
          - path: "host"
            objectAlias: "db_host"
      - objectName: "production/api-key"
        objectType: "secretsmanager"
        objectAlias: "api_key"
  # Optionally sync as a Kubernetes Secret as well
  secretObjects:
    - secretName: app-secrets-synced
      type: Opaque
      data:
        - objectName: "db_username"
          key: username
        - objectName: "db_password"
          key: password
        - objectName: "api_key"
          key: api_key
```

```yaml
# Pod using CSI volume for secrets
apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: production
spec:
  serviceAccountName: app-sa   # Must have IRSA annotations for AWS provider
  containers:
    - name: app
      image: registry.company.internal/app:1.5.0
      volumeMounts:
        - name: secrets-store-vol
          mountPath: "/mnt/secrets"
          readOnly: true
      # Env vars from synced Kubernetes Secret (optional)
      envFrom:
        - secretRef:
            name: app-secrets-synced
  volumes:
    - name: secrets-store-vol
      csi:
        driver: secrets-store.csi.k8s.io
        readOnly: true
        volumeAttributes:
          secretProviderClass: "app-secrets-aws"
```

### SecretProviderClass for Vault

```yaml
# secret-provider-class-vault.yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: vault-secrets
  namespace: production
spec:
  provider: vault
  parameters:
    vaultAddress: "https://vault.company.internal:8200"
    roleName: "app-production"
    objects: |
      - objectName: "db-username"
        secretPath: "secret/data/production/database"
        secretKey: "username"
      - objectName: "db-password"
        secretPath: "secret/data/production/database"
        secretKey: "password"
      - objectName: "tls.crt"
        secretPath: "pki/issue/app-role"
        secretKey: "certificate"
      - objectName: "tls.key"
        secretPath: "pki/issue/app-role"
        secretKey: "private_key"
```

---

## Section 7: Secret Rotation

### ESO Automatic Rotation

ESO polls the external provider on the `refreshInterval` schedule. When the upstream secret changes, ESO updates the Kubernetes Secret automatically.

```yaml
# Configure short refresh interval for frequently-rotated secrets
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: rotating-db-credentials
  namespace: production
spec:
  # Poll every 5 minutes for fast rotation detection
  refreshInterval: 5m
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: db-credentials
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: "production/database"
        property: password
```

### Triggering Application Reload on Secret Rotation

The `stakater/Reloader` controller watches ConfigMaps and Secrets and triggers rolling restarts when they change.

```bash
helm repo add stakater https://stakater.github.io/stakater-charts
helm repo update

helm upgrade --install reloader stakater/reloader \
  --namespace kube-system \
  --version 1.0.119 \
  --set reloader.watchGlobally=false \
  --wait
```

```yaml
# Add annotation to trigger rolling restart on secret change
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
  namespace: production
  annotations:
    # Trigger rolling restart when this secret changes
    reloader.stakater.com/auto: "true"
    # Or target specific secrets
    secret.reloader.stakater.com/reload: "db-credentials,api-keys"
```

### Vault Dynamic Secrets for Databases

Vault's database secrets engine generates short-lived, unique credentials per request, eliminating long-lived database passwords entirely.

```bash
# Enable the database secrets engine
vault secrets enable database

# Configure connection to PostgreSQL
vault write database/config/app-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="app-role" \
  connection_url="postgresql://{{username}}:{{password}}@postgres.production.svc:5432/appdb?sslmode=require" \
  username="vault-root" \
  password="EXAMPLE_TOKEN_REPLACE_ME"

# Create a role that generates credentials
vault write database/roles/app-role \
  db_name=app-postgres \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
                       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
  default_ttl="1h" \
  max_ttl="24h"

# Test dynamic credential generation
vault read database/creds/app-role
# Output:
# Key                Value
# ---                -----
# lease_id           database/creds/app-role/abc123...
# lease_duration     1h
# password           A1B2-C3D4-...
# username           v-kubernetes-app-role-abc123
```

---

## Section 8: IRSA and Workload Identity

### IRSA for AWS EKS

IRSA (IAM Roles for Service Accounts) allows Kubernetes pods to assume IAM roles without storing static AWS credentials.

```bash
# Get the OIDC provider ARN for the cluster
aws eks describe-cluster --name my-cluster \
  --query "cluster.identity.oidc.issuer" \
  --output text

# Create the OIDC provider if it doesn't exist
eksctl utils associate-iam-oidc-provider \
  --cluster my-cluster \
  --approve

# Create an IAM role with a trust policy scoped to a specific service account
cat > trust-policy.json << 'TRUSTEOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:production:app-sa",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
TRUSTEOF

aws iam create-role \
  --role-name app-production-role \
  --assume-role-policy-document file://trust-policy.json
```

```yaml
# Service account with IRSA annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
  namespace: production
  annotations:
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/app-production-role"
    eks.amazonaws.com/token-expiration: "86400"
```

### GKE Workload Identity

```bash
# Enable Workload Identity on the GKE cluster
gcloud container clusters update my-cluster \
  --workload-pool=my-project.svc.id.goog

# Create IAM binding between Kubernetes SA and GCP SA
gcloud iam service-accounts add-iam-policy-binding \
  app-sa@my-project.iam.gserviceaccount.com \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:my-project.svc.id.goog[production/app-sa]"
```

```yaml
# GKE service account annotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
  namespace: production
  annotations:
    iam.gke.io/gcp-service-account: "app-sa@my-project.iam.gserviceaccount.com"
```

---

## Section 9: GitOps Integration Patterns

### Pattern 1: SealedSecrets + ArgoCD

```yaml
# argocd-app-with-sealed-secrets.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-app
  namespace: argocd
spec:
  project: production
  source:
    repoURL: "https://git.company.internal/platform/app"
    targetRevision: main
    path: manifests/production
    # SealedSecrets live alongside regular manifests
    # argocd does not need special handling
  destination:
    server: "https://kubernetes.default.svc"
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
  # Ignore the decrypted Secret status to prevent false drift detection
  ignoreDifferences:
    - group: "bitnami.com"
      kind: SealedSecret
      jsonPointers:
        - /status
```

### Pattern 2: ESO + ArgoCD (External Secret References)

```yaml
# Only ExternalSecret manifests live in Git
# No actual credential values are ever committed

# manifests/production/external-secrets.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
  data:
    - secretKey: password
      remoteRef:
        key: "production/database"
        property: password
```

```yaml
# ArgoCD ignores ESO-managed secret content to prevent drift alerts
ignoreDifferences:
  - group: "external-secrets.io"
    kind: ExternalSecret
    jsonPointers:
      - /status
  - group: ""
    kind: Secret
    # Ignore the managed-fields annotation added by ESO
    jsonPointers:
      - /metadata/resourceVersion
```

---

## Section 10: Monitoring and Alerting

### ESO Sync Status Metrics

```yaml
# PrometheusRule for ESO
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-alerts
  namespace: external-secrets
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: external-secrets
      rules:
        - alert: ExternalSecretSyncFailed
          expr: |
            externalsecret_sync_calls_error > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "ExternalSecret sync is failing"
            description: >
              ExternalSecret {{ $labels.name }} in namespace {{ $labels.namespace }}
              has had {{ $value }} sync failures.

        - alert: ExternalSecretNotReady
          expr: |
            externalsecret_status_condition{condition="Ready",status="False"} == 1
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "ExternalSecret is not ready"

        - alert: SealedSecretDecryptionFailed
          expr: |
            sealed_secrets_controller_condition{type="Synced",status="False"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "SealedSecret decryption failure"
            description: "SealedSecret {{ $labels.name }} failed to decrypt."
```

### Auditing Secret Access with Kubernetes Audit Logs

```yaml
# audit-policy.yaml — capture all secret access
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all secret reads at the RequestResponse level
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["secrets"]
    verbs: ["get", "list", "watch"]
    omitStages:
      - RequestReceived

  # Log secret creates and updates
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets"]
    verbs: ["create", "update", "patch", "delete"]
```

---

Robust secret management requires layering multiple controls: etcd encryption at rest as the baseline, GitOps-compatible encryption via Sealed Secrets or External Secrets references in version control, centralized secret storage in Vault or cloud-native secret managers as the source of truth, and platform-managed authentication via IRSA or Workload Identity to eliminate long-lived credentials entirely. Combining these layers produces a system where no plaintext credential ever touches version control, secrets rotate automatically, and every access generates an auditable event.
