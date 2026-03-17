---
title: "Kubernetes Secrets Encryption at Rest: KMS Providers and etcd Encryption"
date: 2028-01-08T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Secrets", "Encryption", "KMS", "etcd", "AWS KMS", "Vault"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes secrets encryption at rest covering EncryptionConfiguration, AES-GCM vs AES-CBC providers, AWS KMS envelope encryption, GCP Cloud KMS, HashiCorp Vault KMS integration, key rotation, and etcd backup encryption."
more_link: "yes"
url: "/kubernetes-secrets-encryption-at-rest-guide/"
---

Kubernetes stores secrets in etcd as base64-encoded data, not encrypted, unless an EncryptionConfiguration is explicitly configured. In default cluster installations, any principal with read access to the etcd datastore can retrieve the plaintext contents of every secret in the cluster. Enabling encryption at rest is a non-negotiable security control for production clusters that handle sensitive credentials, API keys, certificates, and connection strings. This guide covers the full spectrum of encryption options—from the built-in AES providers to envelope encryption via AWS KMS, GCP Cloud KMS, and HashiCorp Vault—along with key rotation procedures and etcd backup considerations.

<!--more-->

# Kubernetes Secrets Encryption at Rest: KMS Providers and etcd Encryption

## Section 1: Understanding the Encryption Gap

Before diving into configuration, understanding what "encryption at rest" means in the Kubernetes context is essential.

### What Is and Is Not Encrypted

The Kubernetes API server stores resource data in etcd. When you `kubectl get secret mysecret -o yaml`, the API server:
1. Authenticates and authorizes the request.
2. Reads the encrypted blob from etcd.
3. Decrypts it using the configured provider.
4. Returns the decrypted YAML to the client.

**What encryption at rest protects**:
- etcd data files on disk.
- etcd backups (when backup encryption is also configured).
- Unauthorized direct access to the etcd API.

**What encryption at rest does NOT protect**:
- Secrets in memory on the API server.
- Secrets delivered to kubelet (delivered unencrypted to the node).
- Secrets mounted as environment variables or volumes in pods.
- Secrets transmitted over the network (TLS handles this separately).

### Verifying Current Encryption Status

```bash
# Check if encryption is configured
kubectl get apiserver cluster -o yaml | grep -A5 encryption

# If no EncryptionConfiguration is set, etcd stores raw base64
# Verify by reading etcd directly:
ETCD_POD=$(kubectl -n kube-system get pod -l component=etcd -o name | head -1)
kubectl -n kube-system exec "${ETCD_POD}" -- \
  etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/my-secret \
  | strings | head -20

# Unencrypted secrets show readable YAML in the etcd value
# Encrypted secrets show binary/opaque data with provider prefix
```

## Section 2: EncryptionConfiguration API

### Provider Types and Selection

```yaml
# /etc/kubernetes/encryption-config.yaml
# This file is referenced by kube-apiserver --encryption-provider-config flag
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  # First listed provider is used for new writes
  # All listed providers are tried for reads (in order)

  # Option A: AES-GCM (recommended for new deployments)
  - aescbc:
      keys:
      - name: key1
        secret: "c2VjcmV0aXMzMmJ5dGVzZm9yYWVzMjU2YWxnb3JpdGhteA=="

  # Option B: AES-GCM (preferred over AES-CBC, AEAD)
  # - aesgcm:
  #     keys:
  #     - name: key1
  #       secret: "c2VjcmV0aXMzMmJ5dGVzZm9yYWVzMjU2YWxnb3JpdGhteA=="

  # Option C: Secretbox (XSalsa20-Poly1305, fast on systems without AES-NI)
  # - secretbox:
  #     keys:
  #     - name: key1
  #       secret: "c2VjcmV0aXMzMmJ5dGVzZm9yYWVzMjU2YWxnb3JpdGhteA=="

  # Identity provider MUST be last - used for reading unencrypted secrets
  - identity: {}
```

### AES-CBC vs AES-GCM Analysis

| Property | AES-CBC | AES-GCM |
|----------|---------|---------|
| Mode | Block cipher with chaining | Authenticated encryption |
| Authentication | None (unauthenticated) | Built-in (AEAD) |
| Padding oracle vulnerability | Possible | Not applicable |
| Performance | Moderate | High (hardware AES-NI) |
| Recommended for new deployments | No | Yes |
| IV size | 16 bytes (random per block) | 12 bytes (random per write) |
| Max data per key (safe) | Unlimited | 2^32 writes before rekey |

AES-GCM is the recommended choice. The IV nonce space (2^96) with 12-byte random nonces requires key rotation if a key encrypts more than approximately 4 billion secrets—an unlikely threshold in practice but worth planning for.

### Generating Encryption Keys

```bash
# Generate a 32-byte random key for AES-256
head -c 32 /dev/urandom | base64

# Store in a Kubernetes secret (for managed cluster providers)
kubectl create secret generic apiserver-encryption-key \
  --from-literal=key1="$(head -c 32 /dev/urandom | base64)" \
  --namespace kube-system

# Generate and verify key length
KEY=$(head -c 32 /dev/urandom | base64)
echo "${KEY}" | base64 -d | wc -c  # Must output 32
```

## Section 3: Applying EncryptionConfiguration

### On kubeadm-Managed Clusters

```bash
# Create the encryption config file on each control-plane node
cat > /etc/kubernetes/encryption-config.yaml <<'EOF'
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - aesgcm:
      keys:
      - name: key1
        secret: REPLACE_WITH_BASE64_KEY
  - identity: {}
EOF

# Edit the kube-apiserver manifest to add the flag
# On kubeadm clusters, this is /etc/kubernetes/manifests/kube-apiserver.yaml
cat >> /etc/kubernetes/manifests/kube-apiserver.yaml << 'PATCH'
# Add to spec.containers[0].command:
#   - --encryption-provider-config=/etc/kubernetes/encryption-config.yaml
# Add to spec.containers[0].volumeMounts:
#   - name: encryption-config
#     mountPath: /etc/kubernetes/encryption-config.yaml
#     readOnly: true
# Add to spec.volumes:
#   - name: encryption-config
#     hostPath:
#       path: /etc/kubernetes/encryption-config.yaml
#       type: File
PATCH
```

Practical kubeadm manifest patch:

```bash
# Use yq to safely patch the manifest
yq eval '.spec.containers[0].command += ["--encryption-provider-config=/etc/kubernetes/encryption-config.yaml"]' \
  -i /etc/kubernetes/manifests/kube-apiserver.yaml

yq eval '.spec.containers[0].volumeMounts += [{"name": "encryption-config", "mountPath": "/etc/kubernetes/encryption-config.yaml", "readOnly": true}]' \
  -i /etc/kubernetes/manifests/kube-apiserver.yaml

yq eval '.spec.volumes += [{"name": "encryption-config", "hostPath": {"path": "/etc/kubernetes/encryption-config.yaml", "type": "File"}}]' \
  -i /etc/kubernetes/manifests/kube-apiserver.yaml

# Restart kube-apiserver (kubelet handles static pod restart)
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sleep 5
mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# Wait for API server to come back
kubectl wait --for=condition=Ready pod/kube-apiserver-$(hostname) -n kube-system --timeout=120s
```

### Encrypting Existing Secrets

After enabling encryption, only newly created or updated secrets are encrypted. Existing secrets remain unencrypted until they are re-written:

```bash
# Force re-encryption of all secrets
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -

# Verify a specific secret is now encrypted in etcd
ETCD_POD=$(kubectl -n kube-system get pod -l component=etcd -o name | head -1)
kubectl -n kube-system exec "${ETCD_POD}" -- \
  etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/my-secret \
  | hexdump -C | head -5

# Encrypted secrets start with "k8s:enc:aesgcm:v1:" prefix in the stored value
```

## Section 4: AWS KMS Envelope Encryption

The built-in AES providers store the encryption key on the control-plane node filesystem. For higher security, KMS (Key Management Service) envelope encryption stores the data encryption key (DEK) encrypted by a key in the KMS, so the plaintext key never touches disk.

### Envelope Encryption Pattern

```
Secret Data  ──────▶  Encrypt with DEK  ──────▶  Encrypted Secret Data
                             │
DEK  ──────▶  Encrypt with KMS CMK  ──────▶  Encrypted DEK (stored with data)
                             │
KMS CMK  ──────▶  Stored in AWS KMS (never leaves HSM)
```

### AWS KMS Provider (KMS v2 Plugin)

Kubernetes 1.27+ includes a stable KMS v2 plugin API. The plugin is an external process that runs alongside the API server and communicates via a Unix socket.

```bash
# Create an AWS KMS key for Kubernetes encryption
aws kms create-key \
  --description "Kubernetes secrets encryption" \
  --key-usage ENCRYPT_DECRYPT \
  --origin AWS_KMS \
  --tags TagKey=Purpose,TagValue=K8sSecretsEncryption \
         TagKey=Cluster,TagValue=prod-cluster

# Note the KeyId ARN from the output
KEY_ARN="arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id-replace-me"

# Create an alias
aws kms create-alias \
  --alias-name alias/k8s-secrets-encryption \
  --target-key-id "${KEY_ARN}"

# Grant the kube-apiserver IAM role permissions
cat > kms-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "K8sEncryptionPermissions",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/eks-control-plane-role"
      },
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:DescribeKey",
        "kms:GenerateDataKey"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws kms put-key-policy \
  --key-id "${KEY_ARN}" \
  --policy-name default \
  --policy file://kms-policy.json
```

### Deploying aws-encryption-provider

```bash
# Deploy the AWS KMS encryption provider as a static pod
cat > /etc/kubernetes/manifests/aws-encryption-provider.yaml <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: aws-encryption-provider
  namespace: kube-system
  labels:
    app: aws-encryption-provider
spec:
  hostNetwork: true
  containers:
  - name: aws-encryption-provider
    image: public.ecr.aws/eks-distro/kubernetes-sigs/aws-encryption-provider:v0.3.0
    command:
    - /aws-encryption-provider
    - --key=arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id-replace-me
    - --listen=/var/run/kmsplugin/socket.sock
    - --health-port=:8083
    - --region=us-east-1
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 300m
        memory: 256Mi
    livenessProbe:
      httpGet:
        path: /healthz
        port: 8083
      initialDelaySeconds: 30
      periodSeconds: 10
    volumeMounts:
    - name: plugin-socket
      mountPath: /var/run/kmsplugin
  volumes:
  - name: plugin-socket
    hostPath:
      path: /var/run/kmsplugin
      type: DirectoryOrCreate
  priorityClassName: system-node-critical
  tolerations:
  - effect: NoSchedule
    operator: Exists
EOF
```

### EncryptionConfiguration with KMS v2

```yaml
# /etc/kubernetes/encryption-config-kms.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  # KMS v2 (Kubernetes 1.27+, stable 1.29+)
  - kms:
      apiVersion: v2
      name: aws-kms-provider
      # Socket where the plugin listens
      endpoint: unix:///var/run/kmsplugin/socket.sock
      # How long to cache DEKs locally before re-wrapping
      cachesize: 1000
      timeout: 3s
  # Fallback for reading old AES-encrypted secrets during migration
  - aesgcm:
      keys:
      - name: key1
        secret: REPLACE_WITH_BASE64_KEY
  - identity: {}
```

### EKS Native Secrets Encryption

For EKS clusters, enabling secrets encryption is done through the cluster configuration:

```bash
# Enable secrets encryption on an existing EKS cluster
aws eks associate-encryption-config \
  --cluster-name prod-cluster \
  --encryption-config '[{
    "provider": {
      "keyArn": "arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id-replace-me"
    },
    "resources": ["secrets"]
  }]'

# Monitor the update
aws eks describe-update \
  --name <update-id> \
  --cluster-name prod-cluster

# Create a new cluster with encryption enabled from the start
eksctl create cluster \
  --name prod-cluster-2 \
  --region us-east-1 \
  --secrets-encryption-key-arn "arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id"
```

## Section 5: GCP Cloud KMS Integration

```bash
# Create a Cloud KMS keyring and key
gcloud kms keyrings create k8s-secrets \
  --location us-central1

gcloud kms keys create encryption-key \
  --location us-central1 \
  --keyring k8s-secrets \
  --purpose encryption

KEY_NAME="projects/myproject/locations/us-central1/keyRings/k8s-secrets/cryptoKeys/encryption-key"

# Grant the GKE service account permissions
gcloud kms keys add-iam-policy-binding encryption-key \
  --location us-central1 \
  --keyring k8s-secrets \
  --member "serviceAccount:service-123456789@container-engine-robot.iam.gserviceaccount.com" \
  --role roles/cloudkms.cryptoKeyEncrypterDecrypter

# Enable application-layer secrets encryption on GKE
gcloud container clusters update prod-cluster \
  --location us-central1 \
  --database-encryption-key "${KEY_NAME}"
```

### GCP KMS EncryptionConfiguration for Self-Managed Clusters

```yaml
# /etc/kubernetes/encryption-config-gcp.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - kms:
      apiVersion: v2
      name: gcp-kms-provider
      endpoint: unix:///var/run/gcp-kms-plugin/socket.sock
      cachesize: 1000
      timeout: 5s
  - identity: {}
```

```bash
# Deploy GCP KMS plugin
cat > /etc/kubernetes/manifests/gcp-kms-plugin.yaml <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: gcp-kms-plugin
  namespace: kube-system
spec:
  hostNetwork: true
  containers:
  - name: gcp-kms-plugin
    image: gcr.io/google-containers/k8s-cloud-kms-plugin:v0.2.3
    args:
    - --logtostderr
    - --path-to-unix-socket=/var/run/gcp-kms-plugin/socket.sock
    - --key-uri=projects/myproject/locations/us-central1/keyRings/k8s-secrets/cryptoKeys/encryption-key
    volumeMounts:
    - name: plugin-socket
      mountPath: /var/run/gcp-kms-plugin
  volumes:
  - name: plugin-socket
    hostPath:
      path: /var/run/gcp-kms-plugin
      type: DirectoryOrCreate
EOF
```

## Section 6: HashiCorp Vault KMS Plugin

Vault Transit Secrets Engine provides encryption-as-a-service, suitable for organizations already using Vault.

### Configuring Vault for Kubernetes KMS

```bash
# Enable the transit secrets engine in Vault
vault secrets enable transit

# Create an encryption key
vault write -f transit/keys/k8s-secrets type=aes256-gcm96

# Create a policy for the Kubernetes API server
vault policy write k8s-encryption-policy - <<EOF
path "transit/encrypt/k8s-secrets" {
  capabilities = ["update"]
}
path "transit/decrypt/k8s-secrets" {
  capabilities = ["update"]
}
path "transit/keys/k8s-secrets" {
  capabilities = ["read"]
}
EOF

# Create a token for the KMS plugin
vault token create \
  -policy=k8s-encryption-policy \
  -period=87600h \
  -display-name=k8s-kms-plugin

# Or use AppRole authentication
vault auth enable approle
vault write auth/approle/role/k8s-kms \
  policies=k8s-encryption-policy \
  token_period=87600h

vault read auth/approle/role/k8s-kms/role-id
vault write -f auth/approle/role/k8s-kms/secret-id
```

### Deploying vault-k8s-kms-plugin

```bash
# Static pod manifest for Vault KMS plugin
cat > /etc/kubernetes/manifests/vault-kms-plugin.yaml <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: vault-kms-plugin
  namespace: kube-system
spec:
  hostNetwork: true
  containers:
  - name: vault-kms-plugin
    image: ghcr.io/postfinance/vault-k8s-kms-plugin:v1.0.0
    args:
    - --vault-addr=https://vault.internal.example.com:8200
    - --vault-token-file=/vault-token/token
    - --key-name=k8s-secrets
    - --listen=/var/run/vault-kms/socket.sock
    - --health-port=:8084
    volumeMounts:
    - name: vault-token
      mountPath: /vault-token
    - name: kms-socket
      mountPath: /var/run/vault-kms
    - name: vault-tls
      mountPath: /etc/ssl/vault
  volumes:
  - name: vault-token
    secret:
      secretName: vault-kms-token
  - name: kms-socket
    hostPath:
      path: /var/run/vault-kms
      type: DirectoryOrCreate
  - name: vault-tls
    hostPath:
      path: /etc/ssl/vault
EOF
```

```yaml
# /etc/kubernetes/encryption-config-vault.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - kms:
      apiVersion: v2
      name: vault-kms
      endpoint: unix:///var/run/vault-kms/socket.sock
      cachesize: 1000
      timeout: 10s
  - identity: {}
```

## Section 7: Key Rotation Procedures

Key rotation is the process of replacing an old encryption key with a new one. The procedure differs depending on whether the provider is built-in AES or a KMS service.

### Built-in AES Key Rotation

```bash
# Step 1: Add new key BEFORE old key in the config
# The first key is used for writes; old key remains for reads
cat > /etc/kubernetes/encryption-config.yaml <<'EOF'
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - aesgcm:
      keys:
      - name: key2  # New key - used for new writes
        secret: NEW_BASE64_KEY_REPLACE_ME
      - name: key1  # Old key - still needed for reads
        secret: OLD_BASE64_KEY_REPLACE_ME
  - identity: {}
EOF

# Step 2: Restart kube-apiserver on all control-plane nodes
# (kubelet will restart the static pod when the manifest changes)
touch /etc/kubernetes/manifests/kube-apiserver.yaml

# Step 3: Wait for API server to be healthy
kubectl wait --for=condition=Ready pod/kube-apiserver-$(hostname) \
  -n kube-system --timeout=120s

# Step 4: Re-encrypt all secrets with the new key
kubectl get secrets --all-namespaces -o json | kubectl replace -f -

# Step 5: Verify new secrets use the new key
ETCD_POD=$(kubectl -n kube-system get pod -l component=etcd -o name | head -1)
kubectl -n kube-system exec "${ETCD_POD}" -- \
  etcdctl \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/test-secret \
  | strings | grep "k8s:enc:aesgcm:v1:key2"

# Step 6: Remove old key from config once all secrets are re-encrypted
cat > /etc/kubernetes/encryption-config.yaml <<'EOF'
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - aesgcm:
      keys:
      - name: key2
        secret: NEW_BASE64_KEY_REPLACE_ME
  - identity: {}
EOF

# Step 7: Final API server restart
touch /etc/kubernetes/manifests/kube-apiserver.yaml
```

### KMS Key Rotation

KMS key rotation is simpler because the KMS service handles the actual key material. Kubernetes stores only encrypted DEKs (Data Encryption Keys).

```bash
# AWS KMS: Enable automatic annual key rotation
aws kms enable-key-rotation \
  --key-id "arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id-replace-me"

# AWS KMS: Perform immediate key rotation
aws kms rotate-key-on-demand \
  --key-id "arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id-replace-me"

# After KMS key rotation, re-encrypt secrets to use new key version
kubectl get secrets --all-namespaces -o json | kubectl replace -f -

# GCP KMS: Create a new key version
gcloud kms keys versions create \
  --location us-central1 \
  --keyring k8s-secrets \
  --key encryption-key

# Set the new version as primary
gcloud kms keys update encryption-key \
  --location us-central1 \
  --keyring k8s-secrets \
  --primary-version 2

# Vault Transit: Rotate the key
vault write -f transit/keys/k8s-secrets/rotate

# Re-wrap (re-encrypt) stored ciphertext with new key version
vault write transit/rewrap/k8s-secrets ciphertext=<old_ciphertext>
```

## Section 8: etcd Backup Encryption

When creating etcd snapshots for disaster recovery, the backup file contains the encrypted secrets if EncryptionConfiguration is enabled. However, it is advisable to also encrypt the backup file itself.

### Encrypted etcd Snapshot with AWS S3

```bash
#!/bin/bash
# etcd-encrypted-backup.sh
# Creates an etcd snapshot and uploads to encrypted S3 bucket

BACKUP_DATE=$(date +%Y%m%d-%H%M%S)
SNAPSHOT_FILE="/tmp/etcd-snapshot-${BACKUP_DATE}.db"
S3_BUCKET="etcd-backups-prod"
S3_PREFIX="snapshots"
KMS_KEY_ID="arn:aws:kms:us-east-1:123456789012:key/placeholder-key-id-replace-me"

# Detect etcd pod
ETCD_POD=$(kubectl -n kube-system get pod -l component=etcd -o name | head -1)

echo "Creating etcd snapshot..."
kubectl -n kube-system exec "${ETCD_POD}" -- \
  etcdctl snapshot save /tmp/etcd-snapshot.db \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Copy snapshot from pod
kubectl -n kube-system cp \
  "${ETCD_POD##*/}:/tmp/etcd-snapshot.db" \
  "${SNAPSHOT_FILE}"

echo "Verifying snapshot integrity..."
ETCD_CONTAINER=$(kubectl -n kube-system get pod -l component=etcd \
  -o jsonpath='{.items[0].spec.containers[0].name}')
kubectl -n kube-system exec "${ETCD_POD}" -c "${ETCD_CONTAINER}" -- \
  etcdctl snapshot status /tmp/etcd-snapshot.db \
  --write-out=table

echo "Uploading to S3 with KMS encryption..."
aws s3 cp "${SNAPSHOT_FILE}" \
  "s3://${S3_BUCKET}/${S3_PREFIX}/etcd-snapshot-${BACKUP_DATE}.db" \
  --sse aws:kms \
  --sse-kms-key-id "${KMS_KEY_ID}" \
  --storage-class STANDARD_IA

# Also encrypt locally before storing
openssl enc -aes-256-gcm \
  -in "${SNAPSHOT_FILE}" \
  -out "${SNAPSHOT_FILE}.enc" \
  -pass file:/etc/kubernetes/backup-encryption-key

aws s3 cp "${SNAPSHOT_FILE}.enc" \
  "s3://${S3_BUCKET}/${S3_PREFIX}/etcd-snapshot-${BACKUP_DATE}.db.enc" \
  --sse aws:kms \
  --sse-kms-key-id "${KMS_KEY_ID}"

# Cleanup local files
shred -u "${SNAPSHOT_FILE}" "${SNAPSHOT_FILE}.enc"

echo "Backup complete: etcd-snapshot-${BACKUP_DATE}.db"
```

### Restoring from Encrypted Backup

```bash
#!/bin/bash
# etcd-restore.sh
# Restores etcd from an S3-stored encrypted snapshot

SNAPSHOT_DATE="$1"
S3_BUCKET="etcd-backups-prod"
S3_KEY="snapshots/etcd-snapshot-${SNAPSHOT_DATE}.db"
RESTORE_DIR="/var/lib/etcd-restore"
DATA_DIR="/var/lib/etcd"

if [[ -z "${SNAPSHOT_DATE}" ]]; then
  echo "Usage: $0 <snapshot-date>"
  echo "Available snapshots:"
  aws s3 ls "s3://${S3_BUCKET}/snapshots/" | grep -v ".enc"
  exit 1
fi

echo "Downloading snapshot from S3..."
aws s3 cp "s3://${S3_BUCKET}/${S3_KEY}" /tmp/restore-snapshot.db

echo "Stopping kube-apiserver and etcd..."
mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml.bak
mv /etc/kubernetes/manifests/etcd.yaml /tmp/etcd.yaml.bak
sleep 10

echo "Restoring etcd from snapshot..."
etcdctl snapshot restore /tmp/restore-snapshot.db \
  --data-dir="${RESTORE_DIR}" \
  --name="$(hostname)" \
  --initial-cluster="$(hostname)=https://$(hostname -I | awk '{print $1}'):2380" \
  --initial-cluster-token="etcd-cluster-1" \
  --initial-advertise-peer-urls="https://$(hostname -I | awk '{print $1}'):2380"

echo "Replacing etcd data directory..."
mv "${DATA_DIR}" "${DATA_DIR}.old.$(date +%s)"
mv "${RESTORE_DIR}" "${DATA_DIR}"

echo "Restoring static pod manifests..."
mv /tmp/etcd.yaml.bak /etc/kubernetes/manifests/etcd.yaml
sleep 30
mv /tmp/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml

echo "Waiting for cluster to recover..."
until kubectl get nodes &>/dev/null; do
  echo "Waiting for API server..."
  sleep 10
done

echo "Restore complete. Verifying cluster state..."
kubectl get nodes
kubectl -n kube-system get pods
```

## Section 9: Secret Scanning in Git History

Secrets that were committed to git repositories before Kubernetes encryption was enabled may already be exposed. Scanning the git history is a prerequisite to a security remediation.

### truffleHog for Historical Secret Scanning

```bash
# Install truffleHog
pip install trufflehog3

# Scan a repository for secrets (including git history)
trufflehog3 \
  --format json \
  --output findings.json \
  https://github.com/myorg/infrastructure-repo

# Scan for specific secret types
trufflehog3 \
  --rules /etc/trufflehog/rules.json \
  --exclude-entropy \
  --branch main \
  .

# Custom rules for Kubernetes secrets
cat > k8s-secret-rules.json <<'EOF'
[
  {
    "reason": "Kubernetes Secret base64 value",
    "regex": "\"data\":\\s*\\{[^}]*\"[^\"]+\":\\s*\"[A-Za-z0-9+/]{20,}={0,2}\"",
    "flags": ["MULTILINE"],
    "severity": "HIGH"
  },
  {
    "reason": "AWS Access Key ID",
    "regex": "AKIA[A-Z0-9]{16}",
    "severity": "CRITICAL"
  }
]
EOF
```

### gitleaks for CI/CD Pipeline Scanning

```yaml
# .github/workflows/secret-scan.yaml
name: Secret Scan
on:
  pull_request:
  push:
    branches:
    - main

jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0  # Full history required

    - name: Run Gitleaks
      uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}

    - name: Upload findings
      uses: actions/upload-artifact@v3
      if: failure()
      with:
        name: gitleaks-report
        path: results.sarif
```

## Section 10: Monitoring and Alerting for Encryption Health

### Prometheus Metrics for Encryption

```yaml
# encryption-monitoring-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: k8s-encryption-monitoring
  namespace: monitoring
spec:
  groups:
  - name: encryption.health
    rules:
    - alert: KMSPluginUnhealthy
      expr: |
        kube_apiserver_storage_envelope_transformation_cache_misses_total
        > 1000
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "KMS plugin cache miss rate is high"
        description: "High KMS cache misses may indicate plugin issues or excessive secret rotation."

    - alert: KMSPluginEncryptionError
      expr: |
        increase(apiserver_storage_envelope_transformation_duration_seconds_count{
          transformation_type="from_storage",
          transformation_prefix="k8s:enc:kms:v2"
        }[5m]) == 0
        and
        kube_apiserver_audit_event_total > 0
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "KMS decryption appears to have stopped"
        description: "No KMS decryption events in the last 5 minutes despite API activity."

    # Monitor key rotation via KMS API calls
    - record: kms:encryption_operations_per_minute
      expr: |
        rate(apiserver_storage_envelope_transformation_duration_seconds_count[1m]) * 60
```

### Verifying Encryption Status Script

```bash
#!/bin/bash
# verify-encryption-status.sh
# Comprehensive check of Kubernetes secrets encryption health

echo "=== Kubernetes Secrets Encryption Status Check ==="
echo ""

# Check if encryption is configured
echo "1. EncryptionConfiguration status:"
if kubectl get apiserver cluster -o jsonpath='{.spec.encryption}' 2>/dev/null | grep -q "kms"; then
  echo "   KMS encryption: CONFIGURED"
elif kubectl get apiserver cluster -o jsonpath='{.spec.encryption}' 2>/dev/null | grep -q "aesgcm"; then
  echo "   AES-GCM encryption: CONFIGURED"
else
  echo "   WARNING: No encryption configuration detected"
fi

echo ""
echo "2. Sample secret etcd content check:"
ETCD_POD=$(kubectl -n kube-system get pod -l component=etcd -o name | head -1)
if [[ -n "${ETCD_POD}" ]]; then
  # Create a test secret
  kubectl create secret generic encryption-test \
    --from-literal=test-key=test-value \
    --namespace default \
    --dry-run=client -o yaml | kubectl apply -f -

  ETCD_VALUE=$(kubectl -n kube-system exec "${ETCD_POD}" -- \
    etcdctl \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    get /registry/secrets/default/encryption-test \
    2>/dev/null | head -c 30)

  if echo "${ETCD_VALUE}" | grep -q "k8s:enc"; then
    PROVIDER=$(echo "${ETCD_VALUE}" | grep -oP 'k8s:enc:[^:]+:[^:]+')
    echo "   Test secret encrypted with: ${PROVIDER}"
  else
    echo "   WARNING: Test secret is NOT encrypted in etcd"
  fi

  # Clean up
  kubectl delete secret encryption-test --namespace default
fi

echo ""
echo "3. Unencrypted secrets check:"
UNENCRYPTED=0
# This is expensive for large clusters - sample instead
for ns in default production staging; do
  for secret in $(kubectl get secrets -n "${ns}" -o name 2>/dev/null | head -5); do
    ETCD_KEY="/registry/secrets/${ns}/${secret##*/}"
    ETCD_VAL=$(kubectl -n kube-system exec "${ETCD_POD}" -- \
      etcdctl \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key \
      get "${ETCD_KEY}" 2>/dev/null | head -c 20)

    if ! echo "${ETCD_VAL}" | grep -q "k8s:enc"; then
      echo "   Unencrypted: ${ETCD_KEY}"
      ((UNENCRYPTED++))
    fi
  done
done

if [[ "${UNENCRYPTED}" -eq 0 ]]; then
  echo "   All sampled secrets are encrypted"
else
  echo "   WARNING: ${UNENCRYPTED} unencrypted secrets found in sample"
  echo "   Run: kubectl get secrets --all-namespaces -o json | kubectl replace -f -"
fi
```

## Conclusion

Encryption at rest for Kubernetes secrets is a defense-in-depth control that protects against unauthorized etcd access, disk theft, and backup exposure. The implementation choice should align with the organization's key management infrastructure: built-in AES providers are sufficient for environments without existing KMS infrastructure, while AWS KMS, GCP Cloud KMS, and HashiCorp Vault provide envelope encryption with centralized key management, audit logging, and hardware security module backing.

The operational discipline surrounding encryption—regular key rotation, backup verification, and monitoring of KMS plugin health—determines whether the control actually functions when needed. An encryption configuration that has not been tested through a full rotation and restore cycle should be treated as untested infrastructure rather than a security guarantee.
