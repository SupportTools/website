---
title: "Kubernetes ConfigMaps and Secrets: Advanced Configuration Management Patterns"
date: 2027-08-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Configuration", "Secrets", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Advanced Kubernetes ConfigMap and Secret patterns including immutable ConfigMaps, projected volumes, external secret sync with ESO, secret rotation without pod restarts, and encryption at rest configuration."
more_link: "yes"
url: "/kubernetes-configmap-secrets-management-guide/"
---

Kubernetes ConfigMaps and Secrets are the primary mechanisms for injecting configuration and sensitive data into pods. While the basic usage is straightforward, production environments require advanced patterns: immutability for configuration stability, projected volumes for complex multi-source injection, External Secrets Operator integration for enterprise secret management systems, and encryption at rest to protect sensitive data in etcd. This guide covers all of these patterns with production-ready examples.

<!--more-->

## ConfigMap Fundamentals and Advanced Usage

### Multi-Key ConfigMaps for Application Configuration

ConfigMaps can store multiple configuration files in a single object. This pattern is useful for applications that read from a configuration directory:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-config
  namespace: production
data:
  nginx.conf: |
    worker_processes auto;
    worker_rlimit_nofile 65536;
    events {
        worker_connections 4096;
        use epoll;
        multi_accept on;
    }
    http {
        include /etc/nginx/mime.types;
        access_log /var/log/nginx/access.log combined buffer=16k flush=5s;
        error_log /var/log/nginx/error.log warn;
        gzip on;
        gzip_comp_level 5;
        gzip_types text/plain text/css application/json application/javascript;
        include /etc/nginx/conf.d/*.conf;
    }
  
  default.conf: |
    upstream backend {
        server backend-service.production.svc.cluster.local:8080;
        keepalive 32;
    }
    server {
        listen 80;
        server_name _;
        location /health {
            return 200 "healthy\n";
        }
        location / {
            proxy_pass http://backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_connect_timeout 5s;
            proxy_read_timeout 60s;
        }
    }

  prometheus.conf: |
    server {
        listen 9113;
        location /metrics {
            stub_status on;
        }
    }
```

Mount the ConfigMap as a directory:

```yaml
spec:
  containers:
    - name: nginx
      volumeMounts:
        - name: nginx-config
          mountPath: /etc/nginx/conf.d
          readOnly: true
  volumes:
    - name: nginx-config
      configMap:
        name: nginx-config
        items:
          - key: default.conf
            path: default.conf
          - key: prometheus.conf
            path: prometheus.conf
```

### Immutable ConfigMaps

Immutable ConfigMaps (and Secrets) cannot be updated after creation. This provides two benefits: preventing accidental configuration drift and allowing the kubelet to stop watching the ConfigMap for updates, reducing API server load in large clusters.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config-v1-2-3
  namespace: production
immutable: true
data:
  APP_VERSION: "1.2.3"
  LOG_LEVEL: "info"
  FEATURE_FLAGS: "feature_a=true,feature_b=false"
```

To update an immutable ConfigMap, create a new one with a version-suffixed name and update the Deployment to reference it:

```bash
# Create new version
kubectl create configmap app-config-v1-2-4 \
    --from-literal=APP_VERSION=1.2.4 \
    --from-literal=LOG_LEVEL=info \
    --from-literal=FEATURE_FLAGS=feature_a=true,feature_b=true \
    -n production

# Patch the Deployment to use new ConfigMap
kubectl patch deployment myapp -n production \
    -p '{"spec":{"template":{"spec":{"volumes":[{"name":"app-config","configMap":{"name":"app-config-v1-2-4"}}]}}}}'
```

## Secret Management

### Secret Types

| Type | Use Case |
|------|----------|
| `Opaque` | Arbitrary user-defined data (default) |
| `kubernetes.io/service-account-token` | ServiceAccount tokens |
| `kubernetes.io/dockerconfigjson` | Docker registry credentials |
| `kubernetes.io/tls` | TLS certificate and key |
| `kubernetes.io/ssh-auth` | SSH authentication data |
| `kubernetes.io/basic-auth` | Basic authentication credentials |

### Creating Secrets Securely

```bash
# From literal values (values are base64-encoded automatically)
kubectl create secret generic database-credentials \
    --from-literal=username=dbadmin \
    --from-literal=password=REPLACE_WITH_ACTUAL_PASSWORD_FROM_VAULT \
    -n production

# From files (preserves binary content)
kubectl create secret generic tls-certs \
    --from-file=tls.crt=/path/to/cert.pem \
    --from-file=tls.key=/path/to/key.pem \
    -n production

# TLS secret type
kubectl create secret tls app-tls \
    --cert=/path/to/tls.crt \
    --key=/path/to/tls.key \
    -n production
```

### Avoiding Secrets in Environment Variables

Mounting secrets as files is more secure than environment variables because:
- Environment variables are exposed in process listings
- Container inspection via `kubectl describe` shows env var names
- Files can be read with specific permissions

```yaml
# Preferred: mount as files
spec:
  containers:
    - name: app
      volumeMounts:
        - name: db-credentials
          mountPath: /run/secrets/db
          readOnly: true
  volumes:
    - name: db-credentials
      secret:
        secretName: database-credentials
        defaultMode: 0400   # Owner read-only

# Application reads from /run/secrets/db/username and /run/secrets/db/password
```

## Projected Volumes

Projected volumes allow multiple volume sources to be mounted into a single directory. This is useful for applications that need both a ServiceAccount token and a ConfigMap in the same path:

```yaml
spec:
  containers:
    - name: app
      volumeMounts:
        - name: combined-config
          mountPath: /etc/app
          readOnly: true
  volumes:
    - name: combined-config
      projected:
        sources:
          # Service account token with custom audience (for OIDC)
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
              audience: vault.example.com
          # ConfigMap
          - configMap:
              name: app-config
              items:
                - key: config.yaml
                  path: config.yaml
          # Secret
          - secret:
              name: database-credentials
              items:
                - key: password
                  path: db-password
                  mode: 0400
          # Downward API
          - downwardAPI:
              items:
                - path: pod-name
                  fieldRef:
                    fieldPath: metadata.name
                - path: namespace
                  fieldRef:
                    fieldPath: metadata.namespace
                - path: memory-limit
                  resourceFieldRef:
                    containerName: app
                    resource: limits.memory
```

Result: all sources are available under `/etc/app/` as individual files.

## External Secrets Operator

The External Secrets Operator (ESO) synchronizes secrets from external secret management systems (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, GCP Secret Manager) into Kubernetes Secrets. ESO is the production standard for enterprise clusters where secrets must be managed in a central secret store.

### SecretStore (Namespace-Scoped)

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
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
```

### ClusterSecretStore (Cluster-Wide)

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-cluster-store
spec:
  provider:
    vault:
      server: https://vault.corp.example.com
      path: secret
      version: v2
      auth:
        kubernetes:
          mountPath: kubernetes
          role: external-secrets
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
```

### ExternalSecret — AWS Secrets Manager

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: database-credentials
    creationPolicy: Owner
    template:
      type: Opaque
      data:
        # Transform the secret value using Go templates
        DATABASE_URL: "postgresql://{{ .username }}:{{ .password }}@{{ .host }}:5432/{{ .database }}"
  data:
    - secretKey: username
      remoteRef:
        key: production/database
        property: username
    - secretKey: password
      remoteRef:
        key: production/database
        property: password
    - secretKey: host
      remoteRef:
        key: production/database
        property: host
    - secretKey: database
      remoteRef:
        key: production/database
        property: database
```

### ExternalSecret — HashiCorp Vault

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-secrets
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: vault-cluster-store
    kind: ClusterSecretStore
  target:
    name: app-secrets
    creationPolicy: Owner
  dataFrom:
    - extract:
        key: secret/data/production/myapp
        # Extracts all key-value pairs from the Vault secret path
```

### Monitoring ESO Sync Status

```bash
# Check ExternalSecret sync status
kubectl get externalsecret database-credentials -n production

# NAME                    STORE                 REFRESH INTERVAL   STATUS         READY
# database-credentials    aws-secrets-manager   1h                 SecretSynced   True

# Describe for error details
kubectl describe externalsecret database-credentials -n production
```

## Secret Rotation Without Pod Restarts

Kubernetes secrets mounted as volumes are automatically updated when the underlying Secret object changes (with a short propagation delay of up to 60 seconds by default). This enables zero-downtime secret rotation for applications that reload configuration from files.

### Application Pattern: File-Based Secret Watching

```go
package main

import (
    "log/slog"
    "os"
    "sync"
    "time"

    "github.com/fsnotify/fsnotify"
)

type CredentialManager struct {
    mu       sync.RWMutex
    password string
    path     string
}

func NewCredentialManager(path string) (*CredentialManager, error) {
    cm := &CredentialManager{path: path}
    if err := cm.reload(); err != nil {
        return nil, err
    }
    go cm.watch()
    return cm, nil
}

func (cm *CredentialManager) reload() error {
    data, err := os.ReadFile(cm.path)
    if err != nil {
        return err
    }
    cm.mu.Lock()
    defer cm.mu.Unlock()
    cm.password = string(data)
    slog.Info("reloaded credential from file")
    return nil
}

func (cm *CredentialManager) watch() {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        slog.Error("failed to create file watcher", "error", err)
        return
    }
    defer watcher.Close()

    // Watch the directory containing the secret file
    // Kubernetes updates secrets via symlink swap in the parent directory
    dir := filepath.Dir(cm.path)
    if err := watcher.Add(dir); err != nil {
        slog.Error("failed to watch directory", "dir", dir, "error", err)
        return
    }

    for {
        select {
        case event := <-watcher.Events:
            if event.Op&fsnotify.Create != 0 || event.Op&fsnotify.Write != 0 {
                time.Sleep(100 * time.Millisecond) // allow write to complete
                if err := cm.reload(); err != nil {
                    slog.Error("failed to reload credential", "error", err)
                }
            }
        case err := <-watcher.Errors:
            slog.Error("file watcher error", "error", err)
        }
    }
}

func (cm *CredentialManager) Password() string {
    cm.mu.RLock()
    defer cm.mu.RUnlock()
    return cm.password
}
```

### Rotation Workflow

```bash
# 1. Update the secret in the external secret manager (AWS/Vault)
# ESO will sync the updated value to the Kubernetes Secret within refreshInterval

# 2. Verify the Kubernetes Secret has been updated
kubectl get secret database-credentials -n production \
    -o jsonpath='{.metadata.resourceVersion}'

# 3. Application automatically reloads from the mounted file
# No pod restart required

# 4. Verify application is using new credential
kubectl exec -it myapp-xxx -n production -- /app/healthcheck --db-ping
```

For environment-variable-based secrets, a pod restart is required. Use Reloader to automate this:

```yaml
# Reloader watches Secrets and ConfigMaps and triggers rolling restarts
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  annotations:
    secret.reloader.stakater.com/reload: "database-credentials"
    configmap.reloader.stakater.com/reload: "app-config"
```

## Encryption at Rest

By default, Kubernetes Secrets are stored unencrypted in etcd (only base64-encoded). For production clusters, encryption at rest must be explicitly configured.

### EncryptionConfiguration

```yaml
# /etc/kubernetes/encryption-config.yaml (on each control plane node)
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps
    providers:
      # AES-GCM with a 32-byte key (256-bit)
      - aescbc:
          keys:
            - name: key-20270815
              # Generate with: head -c 32 /dev/urandom | base64
              secret: BASE64_ENCODED_32_BYTE_KEY_REPLACE_ME
      # Identity (plaintext) must be last for reading unencrypted existing secrets
      - identity: {}
```

Enable in kube-apiserver:

```yaml
# In /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
    - command:
        - kube-apiserver
        - --encryption-provider-config=/etc/kubernetes/encryption-config.yaml
```

### Key Rotation

```bash
# 1. Add a new key at the TOP of the providers list
# The first provider is used for writing; others are used for reading

# New config with new key first:
# providers:
#   - aescbc:
#       keys:
#         - name: key-20280115   # New key at top
#           secret: NEW_BASE64_KEY_REPLACE_ME
#         - name: key-20270815   # Old key still present for reading
#           secret: OLD_BASE64_KEY_REPLACE_ME
#   - identity: {}

# 2. Reload kube-apiserver (restart the static pod)

# 3. Re-encrypt all secrets with the new key
kubectl get secrets --all-namespaces -o json | \
    kubectl replace -f -

# 4. After all secrets are re-encrypted, remove the old key from config
```

### Using KMS Provider (Recommended for Production)

For enterprise production clusters, use the KMS provider (envelope encryption) to avoid storing raw encryption keys in the filesystem:

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      - kms:
          apiVersion: v2
          name: aws-kms-provider
          endpoint: unix:///var/run/kmsplugin/socket.sock
          timeout: 3s
      - identity: {}
```

This requires a KMS plugin DaemonSet on each control plane node that communicates with the cloud KMS service (AWS KMS, GCP Cloud KMS, Azure Key Vault).

## RBAC for ConfigMaps and Secrets

Restrict who can read Secrets using fine-grained RBAC:

```yaml
# Allow pods in the production namespace to read only their own secrets
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: app-secret-reader
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames:
      - "database-credentials"
      - "app-tls"
    verbs: ["get", "watch", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: app-secret-reader
  namespace: production
subjects:
  - kind: ServiceAccount
    name: myapp-sa
    namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: app-secret-reader
```

### Audit Logging for Secret Access

Enable audit logging to track Secret access:

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all Secret reads at the Metadata level (no data captured)
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets"]
    verbs: ["get", "list", "watch"]
  # Log Secret writes at the RequestResponse level
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["secrets"]
    verbs: ["create", "update", "patch", "delete"]
```

## Summary

Advanced Kubernetes configuration management requires moving beyond basic ConfigMap and Secret usage. Immutable ConfigMaps eliminate configuration drift and reduce API server load. Projected volumes simplify multi-source configuration injection. External Secrets Operator provides the bridge between Kubernetes and enterprise secret management systems, enabling centralized rotation and audit trails. Encryption at rest with KMS envelope encryption ensures secrets cannot be read if etcd is compromised. Together these patterns form a defense-in-depth configuration management strategy that meets enterprise security requirements without sacrificing operational velocity.
