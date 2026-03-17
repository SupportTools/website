---
title: "Kubernetes Secrets Encryption at Rest: KMS Providers, etcd Encryption, and Rotation"
date: 2028-04-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Secrets", "Encryption", "KMS", "etcd", "Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to encrypting Kubernetes Secrets at rest using native etcd encryption, KMS provider integrations, and safe secret rotation strategies for production clusters."
more_link: "yes"
url: "/kubernetes-secrets-encryption-at-rest-deep-dive/"
---

Kubernetes Secrets are stored as plain base64-encoded values in etcd by default. Anyone with direct etcd access — or a backup of etcd data — can read every Secret in your cluster. Encryption at rest closes this gap by encrypting Secret data before it is written to etcd, ensuring that storage-level access does not yield plaintext credentials.

This guide covers every layer of the problem: the built-in `EncryptionConfiguration` API, AWS KMS, GCP Cloud KMS, and HashiCorp Vault KMS providers, key rotation without downtime, and the operational patterns that make the whole system auditable and maintainable.

<!--more-->

# Kubernetes Secrets Encryption at Rest

## Why Default Storage Is a Risk

When you create a Secret:

```bash
kubectl create secret generic db-password \
  --from-literal=password=supersecret
```

Kubernetes stores this in etcd as:

```
/registry/secrets/default/db-password → {"kind":"Secret",...,"data":{"password":"c3VwZXJzZWNyZXQ="}}
```

The value `c3VwZXJzZWNyZXQ=` is base64, not encryption. Anyone who can run `etcdctl get /registry/secrets/default/db-password` has the password. Etcd backup files, cloud snapshots, or disk images all leak the same data.

Encryption at rest means the stored bytes look like:

```
/registry/secrets/default/db-password → k8s:enc:aescbc:v1:key1:<binary ciphertext>
```

The prefix tells the API server which provider and key version decrypted the value on read.

## The EncryptionConfiguration API

The `EncryptionConfiguration` resource is loaded by the API server at startup via the `--encryption-provider-config` flag.

### Minimal AES-CBC Configuration

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
      - identity: {}
```

Generate a 32-byte key:

```bash
head -c 32 /dev/urandom | base64
```

The `identity` provider at the end is a fallback that reads unencrypted data. Keep it until all existing Secrets have been re-encrypted (covered in the rotation section).

### Provider Precedence

The first provider in the list is used for **writes**. All providers are tried in order for **reads**. This ordering enables zero-downtime key rotation: add a new key at the top, deploy, then re-encrypt all Secrets, then remove the old key.

### Supported Providers

| Provider | Algorithm | Notes |
|----------|-----------|-------|
| `identity` | None | Plaintext passthrough |
| `aescbc` | AES-CBC-256 | Built-in, no external dependency |
| `aesgcm` | AES-GCM-256 | Built-in, nonce reuse risk at scale |
| `secretbox` | XSalsa20-Poly1305 | Built-in, good performance |
| `kms` (v1) | Provider-defined | Envelope encryption, requires plugin |
| `kms` (v2) | Provider-defined | KMSv2 with performance improvements |

For production workloads with compliance requirements (FIPS, PCI-DSS, SOC 2), use a KMS provider so that the encryption keys themselves are managed externally and never reside on the cluster node filesystem.

## Envelope Encryption: How KMS Works

With KMS providers, Kubernetes uses **envelope encryption**:

1. The API server calls the KMS plugin to generate a **Data Encryption Key (DEK)** specific to this Secret.
2. The DEK encrypts the Secret value with AES-GCM.
3. The KMS plugin calls the external KMS to encrypt the DEK with the **Key Encryption Key (KEK)** stored in KMS.
4. The encrypted DEK and encrypted Secret value are both stored in etcd.

On read, the process reverses: the API server sends the encrypted DEK to KMS, receives the plaintext DEK, and decrypts the Secret locally. The plaintext KEK never leaves the KMS service.

```
┌─────────────┐   generate DEK    ┌────────────┐
│  API Server │ ◄───────────────► │ KMS Plugin │
│             │   encrypt DEK     │  (gRPC)    │
│  Secret     │ ◄───────────────► │            │
│  plaintext  │                   └─────┬──────┘
└──────┬──────┘                         │ AWS KMS / GCP KMS / Vault
       │                                │
       ▼                                ▼
   etcd stores:                   KEK stays in KMS
   [encrypted DEK | encrypted Secret]
```

## AWS KMS Provider Configuration

### Prerequisites

1. Create a symmetric KMS key in AWS.
2. Attach an IAM policy to the API server node role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey"
      ],
      "Resource": "arn:aws:kms:us-east-1:123456789012:key/mrk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    }
  ]
}
```

### Deploy the AWS KMS Plugin

The AWS encryption provider plugin runs as a DaemonSet on control plane nodes and exposes a Unix socket that the API server connects to.

```yaml
# aws-encryption-provider-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: aws-encryption-provider
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: aws-encryption-provider
  template:
    metadata:
      labels:
        app: aws-encryption-provider
    spec:
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
      hostNetwork: true
      containers:
        - name: aws-encryption-provider
          image: amazon/aws-encryption-provider:v0.3.0
          command:
            - /aws-encryption-provider
            - --key=arn:aws:kms:us-east-1:123456789012:key/mrk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
            - --region=us-east-1
            - --listen=/var/run/kmsplugin/socket.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /var/run/kmsplugin
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          readinessProbe:
            exec:
              command:
                - /bin/grpc_health_probe
                - -addr=unix:/var/run/kmsplugin/socket.sock
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: socket-dir
          hostPath:
            path: /var/run/kmsplugin
            type: DirectoryOrCreate
```

### EncryptionConfiguration for KMS v1

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps
    providers:
      - kms:
          name: aws-kms
          endpoint: unix:///var/run/kmsplugin/socket.sock
          cachesize: 1000
          timeout: 3s
      - identity: {}
```

### EncryptionConfiguration for KMS v2 (Kubernetes 1.27+)

KMS v2 adds a performance improvement: a single `GenerateDataKey` call caches the DEK for multiple Secrets during a time window, reducing KMS API calls.

```yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps
    providers:
      - kms:
          apiVersion: v2
          name: aws-kms-v2
          endpoint: unix:///var/run/kmsplugin/socket.sock
          timeout: 3s
      - identity: {}
```

## GCP Cloud KMS Provider

### IAM Setup

```bash
gcloud kms keyrings create k8s-secrets \
  --location=us-central1

gcloud kms keys create etcd-encryption \
  --location=us-central1 \
  --keyring=k8s-secrets \
  --purpose=encryption

# Grant API server service account access
gcloud kms keys add-iam-policy-binding etcd-encryption \
  --location=us-central1 \
  --keyring=k8s-secrets \
  --member="serviceAccount:k8s-api-server@my-project.iam.gserviceaccount.com" \
  --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"
```

### GCP KMS Plugin Deployment

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: gcp-kms-plugin
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: gcp-kms-plugin
  template:
    metadata:
      labels:
        app: gcp-kms-plugin
    spec:
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
      containers:
        - name: gcp-kms-plugin
          image: gcr.io/google-containers/k8s-cloud-kms-plugin:v0.2.0
          args:
            - --logtostderr
            - --integration-mode
            - --path-to-unix-socket=/var/run/kmsplugin/socket.sock
            - --key-uri=gcp-kms://projects/my-project/locations/us-central1/keyRings/k8s-secrets/cryptoKeys/etcd-encryption
          volumeMounts:
            - name: socket-dir
              mountPath: /var/run/kmsplugin
      volumes:
        - name: socket-dir
          hostPath:
            path: /var/run/kmsplugin
            type: DirectoryOrCreate
```

## HashiCorp Vault KMS Provider

Vault's Transit secrets engine acts as a KMS-compatible provider.

### Vault Setup

```bash
# Enable Transit engine
vault secrets enable transit

# Create encryption key
vault write -f transit/keys/k8s-secrets \
  type=aes256-gcm96

# Create policy
cat <<EOF | vault policy write k8s-api-server -
path "transit/encrypt/k8s-secrets" {
  capabilities = ["update"]
}
path "transit/decrypt/k8s-secrets" {
  capabilities = ["update"]
}
path "transit/datakey/plaintext/k8s-secrets" {
  capabilities = ["update"]
}
EOF

# Create AppRole
vault auth enable approle
vault write auth/approle/role/k8s-api-server \
  token_policies="k8s-api-server" \
  token_ttl=1h \
  token_max_ttl=24h

vault read auth/approle/role/k8s-api-server/role-id
vault write -f auth/approle/role/k8s-api-server/secret-id
```

### Vault KMS Plugin

```yaml
# vault-kms-plugin.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: vault-kms-plugin
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: vault-kms-plugin
  template:
    metadata:
      labels:
        app: vault-kms-plugin
    spec:
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          effect: NoSchedule
      containers:
        - name: vault-kms-plugin
          image: hashicorp/vault-k8s-kms-plugin:v0.1.0
          args:
            - --vault-addr=https://vault.internal:8200
            - --vault-token-file=/var/run/secrets/vault-token
            - --transit-key=k8s-secrets
            - --listen-addr=unix:///var/run/kmsplugin/socket.sock
          volumeMounts:
            - name: socket-dir
              mountPath: /var/run/kmsplugin
            - name: vault-token
              mountPath: /var/run/secrets
              readOnly: true
      volumes:
        - name: socket-dir
          hostPath:
            path: /var/run/kmsplugin
            type: DirectoryOrCreate
        - name: vault-token
          secret:
            secretName: vault-api-server-token
```

## API Server Configuration

Mount the encryption config file into the API server and set the flag. For kubeadm clusters:

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml (relevant sections)
spec:
  containers:
  - command:
    - kube-apiserver
    - --encryption-provider-config=/etc/kubernetes/encryption-config.yaml
    # ... other flags
    volumeMounts:
    - mountPath: /etc/kubernetes/encryption-config.yaml
      name: encryption-config
      readOnly: true
    - mountPath: /var/run/kmsplugin
      name: kmsplugin-socket
  volumes:
  - hostPath:
      path: /etc/kubernetes/encryption-config.yaml
      type: FileOrCreate
    name: encryption-config
  - hostPath:
      path: /var/run/kmsplugin
    name: kmsplugin-socket
```

After modifying the static pod manifest, kubelet will restart the API server automatically (usually within 60 seconds).

## Verifying Encryption Is Active

### Check the API Server Log

```bash
# On a control plane node
journalctl -u kubelet -f | grep -i "encryption"

# Or check API server pod logs
kubectl logs -n kube-system kube-apiserver-<node> | grep -i "encr"
```

### Inspect etcd Directly

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/db-password | hexdump -C | head -3
```

Encrypted output starts with the prefix `k8s:enc:`:

```
00000000  6b 38 73 3a 65 6e 63 3a  6b 6d 73 3a 76 31 3a 61  |k8s:enc:kms:v1:a|
```

Unencrypted output contains readable JSON. If you see JSON, encryption is not active.

## Encrypting Existing Secrets (Re-encryption)

New Secrets are encrypted immediately after enabling the config. Existing Secrets remain unencrypted until they are re-written. Force a re-encryption by touching all Secrets:

```bash
# Re-encrypt all Secrets in all namespaces
kubectl get secrets --all-namespaces -o json \
  | kubectl replace -f -
```

For large clusters, do this in batches to avoid overwhelming the API server:

```bash
#!/usr/bin/env bash
# re-encrypt-secrets.sh
set -euo pipefail

NAMESPACES=$(kubectl get ns -o jsonpath='{.items[*].metadata.name}')
BATCH_SIZE=50
SLEEP_SECONDS=2

for ns in $NAMESPACES; do
  echo "Processing namespace: $ns"
  secrets=$(kubectl get secrets -n "$ns" -o jsonpath='{.items[*].metadata.name}')
  count=0
  for secret in $secrets; do
    kubectl get secret "$secret" -n "$ns" -o json \
      | kubectl replace -n "$ns" -f - &>/dev/null || true
    count=$((count + 1))
    if (( count % BATCH_SIZE == 0 )); then
      echo "  Re-encrypted $count secrets, sleeping..."
      sleep "$SLEEP_SECONDS"
    fi
  done
  echo "  Namespace $ns: $count secrets processed"
done
echo "Done."
```

After re-encryption completes, verify that no unencrypted Secrets remain:

```bash
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/ --prefix --keys-only \
  | while read key; do
    value=$(etcdctl get "$key" --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key)
    if echo "$value" | grep -q '"kind":"Secret"'; then
      echo "UNENCRYPTED: $key"
    fi
  done
```

## Key Rotation

### Rotating AES-CBC Keys

**Step 1**: Add the new key at the top of the providers list, keep the old key.

```yaml
providers:
  - aescbc:
      keys:
        - name: key2
          secret: <new-base64-encoded-32-byte-key>
        - name: key1
          secret: <old-base64-encoded-32-byte-key>
  - identity: {}
```

**Step 2**: Restart all API server instances to pick up the new config.

**Step 3**: Re-encrypt all Secrets (same script as above). New Secrets will use key2; old Secrets will be re-encrypted with key2.

**Step 4**: Remove key1 from the config:

```yaml
providers:
  - aescbc:
      keys:
        - name: key2
          secret: <new-base64-encoded-32-byte-key>
  - identity: {}
```

**Step 5**: Restart API servers again. Remove the `identity` provider only after confirming no unencrypted data remains.

### Rotating KMS Keys

For KMS, key rotation is managed at the KMS service level:

```bash
# AWS KMS - enable automatic rotation (yearly)
aws kms enable-key-rotation \
  --key-id mrk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Or rotate immediately
aws kms rotate-key-on-demand \
  --key-id mrk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

When the KMS key rotates:
- Existing ciphertext can still be decrypted (KMS retains all key versions).
- New encryptions use the new key version automatically.
- No etcd re-encryption or API server restart is required for AWS KMS automatic rotation.

For manual key rotation (different key ID), follow the same add-at-top, re-encrypt, remove-old pattern.

## Encrypting ConfigMaps

Extend the `resources` list to include ConfigMaps, which may also contain sensitive data:

```yaml
resources:
  - resources:
      - secrets
      - configmaps
    providers:
      - kms:
          apiVersion: v2
          name: aws-kms
          endpoint: unix:///var/run/kmsplugin/socket.sock
          timeout: 3s
      - identity: {}
```

Re-encrypt ConfigMaps after applying:

```bash
kubectl get configmaps --all-namespaces -o json \
  | kubectl replace -f -
```

## Multi-Control-Plane Considerations

In HA clusters (multiple API server replicas):

1. Copy the updated `encryption-config.yaml` to **all** control plane nodes before restarting any API server.
2. The new config must be present on all nodes before the first restart, otherwise nodes with old config will fail to decrypt new objects.
3. Rolling restart pattern:

```bash
# For each control plane node, one at a time:
# 1. Update /etc/kubernetes/encryption-config.yaml
# 2. Wait for API server pod to restart (kubelet detects manifest change)
# 3. Verify API server is healthy
kubectl get --raw /healthz

# 4. Proceed to next node
```

## Audit Logging for KMS Operations

Configure the API server audit policy to capture Secret access:

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: RequestResponse
    verbs: ["get", "list", "watch"]
    resources:
      - group: ""
        resources: ["secrets"]
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets"]
```

Add to the API server:

```yaml
- --audit-policy-file=/etc/kubernetes/audit-policy.yaml
- --audit-log-path=/var/log/kubernetes/audit.log
- --audit-log-maxage=30
- --audit-log-maxbackup=10
- --audit-log-maxsize=100
```

## Monitoring KMS Plugin Health

Create a PrometheusRule to alert on KMS plugin unavailability:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kms-plugin-alerts
  namespace: monitoring
spec:
  groups:
    - name: kms-plugin
      rules:
        - alert: KMSPluginUnhealthy
          expr: |
            kube_pod_container_status_ready{
              namespace="kube-system",
              pod=~"aws-encryption-provider.*"
            } == 0
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "KMS encryption plugin is not ready"
            description: "Pod {{ $labels.pod }} is not ready. Secrets may not be decryptable."

        - alert: APIServerEncryptionConfigMissing
          expr: |
            absent(kube_pod_container_info{
              namespace="kube-system",
              container="kube-apiserver"
            })
          for: 5m
          labels:
            severity: warning
```

## Security Checklist

Before declaring encryption at rest production-ready:

- [ ] EncryptionConfiguration uses a KMS provider (not bare AES keys on disk) for compliance workloads
- [ ] KMS plugin DaemonSet has resource limits and liveness probes
- [ ] All control plane nodes have identical `encryption-config.yaml`
- [ ] All existing Secrets have been re-encrypted (no `identity` provider needed as fallback)
- [ ] etcd backups are tested for restorability with encryption enabled
- [ ] KMS key rotation policy is documented and tested
- [ ] Audit logging captures Secret access
- [ ] Alerts fire on KMS plugin health degradation
- [ ] The `encryption-config.yaml` file permissions are `600` and owned by root

## Backup and Disaster Recovery with Encryption

Etcd backups taken after enabling encryption are also encrypted. To restore:

1. The KMS plugin must be running and accessible to the API server.
2. The same KMS key (or key version, for rotated keys) must still exist in the KMS service.
3. Never delete KMS keys before confirming no etcd snapshots depend on them.

Test the restore path quarterly:

```bash
# Snapshot etcd
ETCDCTL_API=3 etcdctl snapshot save /tmp/etcd-backup.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# Restore to test cluster
ETCDCTL_API=3 etcdctl snapshot restore /tmp/etcd-backup.db \
  --data-dir=/var/lib/etcd-restore \
  --initial-cluster="master=https://127.0.0.1:2380" \
  --initial-advertise-peer-urls=https://127.0.0.1:2380 \
  --name=master

# Start API server against restored etcd
# Verify Secrets are readable (KMS must be reachable)
kubectl get secret db-password -o jsonpath='{.data.password}' | base64 -d
```

## Summary

Encrypting Kubernetes Secrets at rest is a non-negotiable control for any production cluster handling sensitive data. The implementation path is:

1. **Start with aescbc** if you need quick wins without external dependencies — it is better than nothing.
2. **Migrate to a KMS provider** as soon as possible to keep encryption keys outside the cluster filesystem.
3. **Re-encrypt all existing data** immediately after enabling encryption.
4. **Test rotation and restore** before an incident forces you to.
5. **Monitor the KMS plugin** as aggressively as you monitor the API server itself — if it goes down, Secrets become unreadable.

With envelope encryption and an external KMS, even a full etcd dump is worthless to an attacker who does not also have KMS access.
