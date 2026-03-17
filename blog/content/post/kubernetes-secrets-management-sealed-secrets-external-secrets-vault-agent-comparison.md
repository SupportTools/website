---
title: "Kubernetes Sealed Secrets vs External Secrets vs Vault Agent: Choosing the Right Secrets Management Strategy"
date: 2031-09-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets", "Security", "Vault", "Sealed Secrets", "External Secrets Operator", "GitOps"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A detailed comparison of Kubernetes secrets management approaches: Sealed Secrets, External Secrets Operator, and Vault Agent Injector, with architectural analysis and decision criteria for enterprise teams."
more_link: "yes"
url: "/kubernetes-secrets-management-sealed-secrets-external-secrets-vault-agent-comparison/"
---

Secrets management is one of the first infrastructure problems teams hit when moving to Kubernetes, and the landscape of solutions has evolved significantly. Three approaches dominate enterprise deployments: Sealed Secrets for simple GitOps workflows, External Secrets Operator for teams with existing secret stores, and Vault Agent Injector for maximum security with dynamic secret generation. Each has a different threat model, operational complexity profile, and integration pattern.

This guide provides an architectural analysis of all three, with concrete implementation examples, decision criteria, and a hybrid approach that many production teams ultimately adopt.

<!--more-->

# Kubernetes Secrets Management: A Production Comparison

## The Problem with Native Kubernetes Secrets

Kubernetes Secrets are base64-encoded — not encrypted — by default. This means:

```bash
# Anyone with access to etcd can read secrets
kubectl get secret my-secret -o json | jq -r '.data.password' | base64 -d

# kubectl access allows reading secrets in plaintext
kubectl get secret my-secret -o jsonpath='{.data.password}' | base64 -d
```

The three main issues:
1. **Git safety**: Secrets cannot be committed to Git in their native form
2. **etcd encryption**: Encryption at rest requires explicit `EncryptionConfiguration` setup
3. **Rotation**: No built-in mechanism for automatic secret rotation

## Solution 1: Sealed Secrets

[Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets) by Bitnami encrypts Kubernetes Secrets using a controller-managed asymmetric key so they can be safely stored in Git.

### Architecture

```
Developer                      Kubernetes Cluster
    │                               │
    │  1. Create K8s Secret         │
    │──────────────────────────▶    │
    │                               │
    │  2. Encrypt with cluster      │
    │     public key → SealedSecret │
    │                               │
    │  3. Commit SealedSecret to Git │
    │──────────────────────────▶ Git │
    │                               │
    │           GitOps pipeline deploys SealedSecret
    │                               │
    │                      4. Controller decrypts
    │                         → creates K8s Secret
    │                               │
    │                      5. Pod reads K8s Secret
```

### Installation

```bash
# Install the Sealed Secrets controller
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets \
    --namespace kube-system \
    --set fullnameOverride=sealed-secrets-controller

# Install kubeseal CLI
KUBESEAL_VERSION="0.24.0"
curl -sSL "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${KUBESEAL_VERSION}/kubeseal-${KUBESEAL_VERSION}-linux-amd64.tar.gz" \
    | tar -xz kubeseal
sudo install -m 755 kubeseal /usr/local/bin/kubeseal
```

### Creating a Sealed Secret

```bash
# Create a regular Kubernetes Secret (do NOT apply to cluster)
kubectl create secret generic database-credentials \
    --from-literal=username=payments-app \
    --from-literal=password=<database-password-value> \
    --dry-run=client \
    -o yaml > secret.yaml

# Seal it (encrypts with cluster's public key)
kubeseal --controller-namespace kube-system \
         --controller-name sealed-secrets-controller \
         --format yaml \
         < secret.yaml > sealed-secret.yaml

# The sealed-secret.yaml is safe to commit to Git
# Delete the plaintext secret
rm secret.yaml

cat sealed-secret.yaml
```

Output:

```yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: database-credentials
  namespace: payments
spec:
  encryptedData:
    password: AgA3x8k9... # Encrypted with cluster public key
    username: AgB2m1j4... # Each value independently encrypted
  template:
    metadata:
      name: database-credentials
      namespace: payments
    type: Opaque
```

### Sealed Secret Scopes

Sealed Secrets support three scopes controlling where the secret can be decrypted:

```bash
# Strict (default): only decryptable in the specified namespace with the specified name
kubeseal --scope strict

# Namespace-wide: decryptable with any name in the specified namespace
kubeseal --scope namespace-wide

# Cluster-wide: decryptable anywhere in the cluster
kubeseal --scope cluster-wide
```

### Key Rotation and Backup

```bash
# Backup the sealing key (CRITICAL: if lost, all sealed secrets become unrecoverable)
kubectl get secret -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key \
    -o yaml > sealed-secrets-keys-backup.yaml
# Store this in a secure vault, NOT in Git

# Rotate the sealing key
kubectl delete secret -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key=active
# Controller will generate a new key; old keys are kept for decryption but new seals use new key

# Fetch the current public key (for offline sealing in CI/CD)
kubeseal --fetch-cert > cluster-public-key.pem
# Seal without cluster access:
kubeseal --cert cluster-public-key.pem < secret.yaml > sealed-secret.yaml
```

### Strengths and Limitations

**Strengths:**
- Perfect for GitOps: commit sealed secrets alongside application manifests
- No external dependencies beyond the controller
- Simple operational model

**Limitations:**
- No automatic rotation: when a secret changes, you must re-seal and commit
- Controller is a single point of failure for decryption
- No audit trail for secret access
- Secrets still land as plaintext Kubernetes Secrets in etcd (unless etcd encryption is configured)
- Cannot use the same sealed secret across clusters without cluster-wide scoping

## Solution 2: External Secrets Operator

[External Secrets Operator (ESO)](https://external-secrets.io) syncs secrets from external providers (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, HashiCorp Vault, etc.) into Kubernetes Secrets.

### Architecture

```
External Secret Store           Kubernetes Cluster
(Vault/AWS SM/GCP SM)               │
        │                           │
        │          ESO Controller   │
        │               │           │
        │  2. Fetch secret          │
        │◀──────────────────────────│
        │                           │
        │  3. Return secret value   │
        │──────────────────────────▶│
        │               │           │
        │     4. Create/Update      │
        │        K8s Secret         │
        │               │           │
        │     5. Pod reads          │
        │        K8s Secret         │
```

### Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
    --namespace external-secrets \
    --create-namespace \
    --set installCRDs=true
```

### Configuring AWS Secrets Manager Backend

```yaml
# SecretStore: defines connection to the secret provider
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: aws-secrets-manager
  namespace: payments
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        # Use IRSA (IAM Roles for Service Accounts)
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
---
# ServiceAccount for IRSA
apiVersion: v1
kind: ServiceAccount
metadata:
  name: external-secrets-sa
  namespace: payments
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<account-id>:role/ExternalSecretsRole
```

IAM policy for the IRSA role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:<account-id>:secret:payments/*"
      ]
    }
  ]
}
```

### Syncing Secrets

```yaml
# ExternalSecret: defines which secrets to sync and how
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: payments
spec:
  refreshInterval: 1h   # How often to resync from the source
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: database-credentials   # Name of the resulting K8s Secret
    creationPolicy: Owner         # ESO owns and manages the Secret lifecycle
    deletionPolicy: Retain        # Keep Secret if ExternalSecret is deleted
    template:
      type: Opaque
      engineVersion: v2
      data:
        # Transform the secret (e.g., build a connection string)
        POSTGRES_URI: "postgresql://{{ .username }}:{{ .password }}@db.payments.svc:5432/payments"
  data:
    - secretKey: username
      remoteRef:
        key: payments/database
        property: username
    - secretKey: password
      remoteRef:
        key: payments/database
        property: password
```

### ClusterSecretStore for Cross-Namespace Access

```yaml
# ClusterSecretStore: available to all namespaces
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-cluster-store
spec:
  provider:
    vault:
      server: "https://vault.vault.svc.cluster.local:8200"
      path: "secret"
      version: "v2"
      caBundle: <base64-encoded-vault-ca-certificate>
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets-role"
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### Push Secrets from Kubernetes to External Store

ESO also supports pushing secrets outward (useful for multi-cluster workflows):

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-app-secret
  namespace: source-cluster
spec:
  refreshInterval: 10m
  secretStoreRefs:
    - name: aws-secrets-manager
      kind: ClusterSecretStore
  selector:
    secret:
      name: app-credentials
  data:
    - match:
        secretKey: api-key
        remoteRef:
          remoteKey: myapp/api-credentials
          property: key
```

### Strengths and Limitations

**Strengths:**
- Automatic rotation: refreshInterval controls how often ESO syncs the latest value
- Works with existing secret stores (no Vault required)
- Separation of concerns: developers define what secrets they need, ops controls the source
- Multi-provider: can mix AWS SM, Vault, GCP SM in the same cluster

**Limitations:**
- Secrets still land as Kubernetes Secrets in etcd
- ESO controller must have broad read access to the secret store
- Rotation window: there is a lag between rotation in the source and the pod getting updated secrets (pod restart required unless using Reloader)
- More complex than Sealed Secrets for simple cases

### Triggering Pod Restart on Secret Update

Combine ESO with [Reloader](https://github.com/stakater/Reloader):

```yaml
# Annotate the Deployment to trigger rolling restart when the Secret changes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  annotations:
    reloader.stakater.com/auto: "true"
    # Or target specific secrets:
    # secret.reloader.stakater.com/reload: "database-credentials"
```

## Solution 3: Vault Agent Injector

HashiCorp Vault Agent Injector uses a mutating webhook to inject a Vault Agent sidecar into pods. The sidecar authenticates to Vault and writes secrets as files or environment variables, with automatic renewal.

### Architecture

```
Pod Creation                    Vault                  App Container
     │                            │                          │
     │  1. Pod created            │                          │
     ▼                            │                          │
[Webhook Mutation]                │                          │
     │                            │                          │
     │  2. Inject init container  │                          │
     │     + sidecar              │                          │
     ▼                            │                          │
[Init Container]                  │                          │
     │  3. Authenticate           │                          │
     │     (Kubernetes auth)      │                          │
     │──────────────────────────▶ │                          │
     │  4. Get token + lease      │                          │
     │◀────────────────────────── │                          │
     │  5. Fetch secrets          │                          │
     │──────────────────────────▶ │                          │
     │  6. Write to /vault/secrets/│                         │
     │                            │                          │
     │  7. Init completes         │                          │
     │──────────────────────────────────────────────────────▶│
     │                            │                          │
[Sidecar running]                 │   [App reads from /vault/secrets/]
     │  8. Renew lease            │                          │
     │     (continuous)           │                          │
     │──────────────────────────▶ │                          │
```

### Installation

```bash
# Add the Vault Helm chart
helm repo add hashicorp https://helm.releases.hashicorp.com

# Install Vault with the injector
helm install vault hashicorp/vault \
    --namespace vault \
    --create-namespace \
    --set "injector.enabled=true" \
    --set "server.ha.enabled=true" \
    --set "server.ha.replicas=3"
```

### Configuring Vault Kubernetes Auth

```bash
# Enable Kubernetes auth method
vault auth enable kubernetes

# Configure Kubernetes auth
vault write auth/kubernetes/config \
    kubernetes_host="https://${KUBERNETES_PORT_443_TCP_ADDR}:443" \
    kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
    issuer="https://kubernetes.default.svc.cluster.local"

# Create a policy for the payments service
vault policy write payments-policy - << 'EOF'
path "secret/data/payments/*" {
  capabilities = ["read"]
}
path "database/creds/payments-role" {
  capabilities = ["read"]
}
EOF

# Create a Kubernetes auth role
vault write auth/kubernetes/role/payments-app \
    bound_service_account_names=payments-app \
    bound_service_account_namespaces=payments \
    policies=payments-policy \
    ttl=1h
```

### Pod Annotations for Vault Injection

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-service
  namespace: payments
spec:
  template:
    metadata:
      annotations:
        # Enable injection
        vault.hashicorp.com/agent-inject: "true"
        # Vault address
        vault.hashicorp.com/address: "https://vault.vault.svc.cluster.local:8200"
        # Kubernetes auth role
        vault.hashicorp.com/role: "payments-app"
        # CA certificate for TLS verification
        vault.hashicorp.com/ca-cert: "/etc/ssl/certs/vault-ca.crt"

        # Static secret: inject from KV store
        vault.hashicorp.com/agent-inject-secret-database: "secret/data/payments/database"
        vault.hashicorp.com/agent-inject-template-database: |
          {{- with secret "secret/data/payments/database" -}}
          export DB_USERNAME="{{ .Data.data.username }}"
          export DB_PASSWORD="{{ .Data.data.password }}"
          export DB_HOST="{{ .Data.data.host }}"
          {{- end }}

        # Dynamic secret: inject database credentials from Vault DB secrets engine
        vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/payments-role"
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/payments-role" -}}
          POSTGRES_URI=postgresql://{{ .Data.username }}:{{ .Data.password }}@db.payments.svc:5432/payments
          {{- end }}

        # Agent sidecar resource limits
        vault.hashicorp.com/agent-limits-cpu: "100m"
        vault.hashicorp.com/agent-limits-mem: "64Mi"
        vault.hashicorp.com/agent-requests-cpu: "10m"
        vault.hashicorp.com/agent-requests-mem: "16Mi"

    spec:
      serviceAccountName: payments-app
      containers:
        - name: payment-service
          image: registry.example.com/payment-service:v1.2.3
          command: ["/bin/sh", "-c"]
          args:
            - |
              # Source the injected environment variables
              source /vault/secrets/database
              exec /app/payment-service
          volumeMounts: []  # Vault agent writes to /vault/secrets/
```

### Dynamic Database Credentials with Vault DB Engine

This is the key advantage of Vault Agent: truly dynamic, short-lived credentials:

```bash
# Enable the database secrets engine
vault secrets enable database

# Configure PostgreSQL connection
vault write database/config/payments-db \
    plugin_name=postgresql-database-plugin \
    allowed_roles="payments-role" \
    connection_url="postgresql://{{username}}:{{password}}@db.payments.svc:5432/payments" \
    username="vault-admin" \
    password="<vault-admin-password>"

# Create a role that generates short-lived credentials
vault write database/roles/payments-role \
    db_name=payments-db \
    creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
    default_ttl="1h" \
    max_ttl="4h"
```

Every pod gets unique, expiring database credentials. Even if a pod is compromised, the credentials expire within the TTL.

### Vault Agent vs. Vault CSI Provider

Vault also integrates with Kubernetes via the Secrets Store CSI Driver:

```yaml
# SecretProviderClass for Vault CSI
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: vault-database-creds
  namespace: payments
spec:
  provider: vault
  parameters:
    vaultAddress: "https://vault.vault.svc.cluster.local:8200"
    roleName: "payments-app"
    objects: |
      - objectName: "database-username"
        secretPath: "secret/data/payments/database"
        secretKey: "username"
      - objectName: "database-password"
        secretPath: "secret/data/payments/database"
        secretKey: "password"
  secretObjects:
    - secretName: vault-database-secret
      type: Opaque
      data:
        - objectName: database-username
          key: username
        - objectName: database-password
          key: password
---
# Pod using CSI volume
spec:
  containers:
    - name: app
      volumeMounts:
        - name: vault-secrets
          mountPath: "/vault/secrets"
          readOnly: true
  volumes:
    - name: vault-secrets
      csi:
        driver: secrets-store.csi.k8s.io
        readOnly: true
        volumeAttributes:
          secretProviderClass: vault-database-creds
```

CSI approach creates regular Kubernetes Secrets as a side effect, which some teams prefer for compatibility.

## Decision Framework

### Comparison Matrix

| Criteria | Sealed Secrets | External Secrets Operator | Vault Agent |
|----------|---------------|--------------------------|-------------|
| GitOps compatible | Excellent | Good | Poor (secrets in cluster) |
| Automatic rotation | Manual | Automatic (refreshInterval) | Automatic (TTL-based) |
| Dynamic secrets | No | Limited | Yes (DB, PKI, SSH) |
| External dependency | Controller only | Secret store + controller | Vault cluster |
| Audit trail | Limited | Depends on store | Full Vault audit |
| Complexity | Low | Medium | High |
| IRSA/Workload Identity | No | Yes | Yes |
| Secret in etcd | Yes | Yes | No (files only) |
| Encryption at rest | Requires etcd encryption config | Requires etcd encryption config | Not stored in etcd |
| Compliance (PCI/HIPAA) | Needs etcd encryption | Needs etcd encryption | Best (dynamic creds) |

### Decision Criteria

**Choose Sealed Secrets if:**
- You are primarily GitOps-driven (ArgoCD/Flux) and want secrets in the same repo as manifests
- You have a small-to-medium cluster with simple secret needs
- You do not have an existing secrets management platform
- The operational simplicity matters more than advanced features

**Choose External Secrets Operator if:**
- You already have AWS Secrets Manager, GCP Secret Manager, or Azure Key Vault
- You want automatic rotation without deploying Vault
- You need multi-cloud or hybrid-cloud secret sourcing
- You want to use different backends for different namespaces

**Choose Vault Agent if:**
- You need dynamic credentials (database, PKI, SSH)
- PCI-DSS, HIPAA, or SOC2 compliance requires dynamic secrets with full audit trails
- You want credentials to never exist as Kubernetes Secrets in etcd
- You are willing to operate a Vault cluster

### Hybrid Approach

Many large enterprises use all three:

```
Development/Non-sensitive:   Sealed Secrets (simple, Git-native)
Application secrets:         External Secrets Operator → Vault (centralized source)
Database credentials:        Vault Agent Injector (dynamic, short-lived)
TLS certificates:            Vault PKI Engine → cert-manager (dynamic)
```

## etcd Encryption (Required for Sealed Secrets and ESO)

If you use Sealed Secrets or ESO, configure etcd encryption at rest:

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - aescbc:
          keys:
            - name: key1
              secret: <base64-encoded-32-byte-key>
      - identity: {}  # Fallback: reads unencrypted secrets
```

```yaml
# kube-apiserver.yaml (add to existing flags)
spec:
  containers:
    - command:
        - kube-apiserver
        - --encryption-provider-config=/etc/kubernetes/encryption-config.yaml
```

```bash
# Verify encryption is working
# Create a secret and check raw etcd data
kubectl create secret generic test-encryption --from-literal=key=value
ETCDCTL_API=3 etcdctl --endpoints=localhost:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/healthcheck-client.crt \
    --key=/etc/kubernetes/pki/etcd/healthcheck-client.key \
    get /registry/secrets/default/test-encryption | hexdump -C | head
# Should see "k8s:enc:aescbc:v1:key1:" prefix indicating encryption
```

## Summary

Each secrets management approach solves a different problem:

- **Sealed Secrets** is the right choice when simplicity and GitOps compatibility are paramount, and your team does not have existing secrets infrastructure
- **External Secrets Operator** is the right choice when you have existing secrets in cloud provider stores and need automated rotation without Vault overhead
- **Vault Agent Injector** is the right choice when you need dynamic credentials, full audit trails, or compliance requires that credentials never be stored in Kubernetes

For new production deployments without existing constraints, starting with ESO backed by AWS Secrets Manager or Vault provides a good balance of security, operational simplicity, and future flexibility. Adding Vault Agent for database credential generation when you need it is a natural evolution path.

Regardless of the approach, always configure etcd encryption at rest and enforce least-privilege RBAC to ensure that cluster access does not automatically mean secret access.
