---
title: "Kubernetes Secrets Management: Sealed Secrets vs External Secrets Operator"
date: 2026-09-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Secrets Management", "Sealed Secrets", "External Secrets", "DevOps", "GitOps"]
categories: ["Kubernetes", "Security", "Cloud Native"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive comparison of Sealed Secrets and External Secrets Operator for managing Kubernetes secrets in production, including implementation patterns, security considerations, and enterprise best practices."
more_link: "yes"
url: "/kubernetes-secrets-management-sealed-secrets-external-secrets-comparison/"
---

Managing secrets securely in Kubernetes environments presents one of the most critical challenges in cloud-native infrastructure. While Kubernetes provides native Secret objects, storing these secrets in Git repositories or managing them across multiple clusters requires additional tooling. This comprehensive guide explores two leading solutions: Sealed Secrets and External Secrets Operator, providing enterprise-grade implementation patterns for production environments.

<!--more-->

# Kubernetes Secrets Management: Sealed Secrets vs External Secrets Operator

## The Secrets Management Challenge

Traditional Kubernetes Secrets face several critical limitations in enterprise environments:

### Native Secrets Limitations

**Storage Security**: Base64 encoding provides no encryption
- Secrets stored in etcd require encryption at rest configuration
- Git repository storage exposes sensitive data
- Version control history retains deleted secrets
- Access control relies solely on RBAC

**Operational Complexity**: Manual secret management doesn't scale
- Secret rotation requires manual updates across clusters
- No centralized secret lifecycle management
- Difficult audit trail maintenance
- Cross-environment synchronization challenges

## Sealed Secrets Architecture

Sealed Secrets, developed by Bitnami, uses asymmetric cryptography to encrypt secrets that can only be decrypted by the cluster controller.

### Core Components

```yaml
# Sealed Secrets Controller Architecture
apiVersion: v1
kind: Namespace
metadata:
  name: sealed-secrets
  labels:
    app.kubernetes.io/name: sealed-secrets
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: sealed-secrets-controller
  namespace: sealed-secrets
spec:
  replicas: 1
  selector:
    matchLabels:
      name: sealed-secrets-controller
  template:
    metadata:
      labels:
        name: sealed-secrets-controller
    spec:
      serviceAccountName: sealed-secrets-controller
      containers:
      - name: sealed-secrets-controller
        image: quay.io/bitnami/sealed-secrets-controller:v0.24.0
        command:
        - controller
        args:
        - --key-renew-period=720h
        - --key-rotation-enabled=true
        - --update-status=true
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 8081
          name: metrics
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          limits:
            cpu: 500m
            memory: 512Mi
          requests:
            cpu: 100m
            memory: 128Mi
        securityContext:
          runAsNonRoot: true
          runAsUser: 1001
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
```

### RBAC Configuration

```yaml
# Sealed Secrets Service Account and Permissions
apiVersion: v1
kind: ServiceAccount
metadata:
  name: sealed-secrets-controller
  namespace: sealed-secrets
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sealed-secrets-controller
rules:
- apiGroups:
  - ""
  resources:
  - secrets
  verbs:
  - get
  - list
  - create
  - update
  - delete
- apiGroups:
  - ""
  resources:
  - events
  verbs:
  - create
  - patch
- apiGroups:
  - bitnami.com
  resources:
  - sealedsecrets
  verbs:
  - get
  - list
  - watch
  - update
- apiGroups:
  - bitnami.com
  resources:
  - sealedsecrets/status
  verbs:
  - update
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sealed-secrets-controller
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: sealed-secrets-controller
subjects:
- kind: ServiceAccount
  name: sealed-secrets-controller
  namespace: sealed-secrets
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: sealed-secrets-key-admin
  namespace: sealed-secrets
rules:
- apiGroups:
  - ""
  resources:
  - secrets
  verbs:
  - get
  - list
  - create
  - update
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: sealed-secrets-controller
  namespace: sealed-secrets
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: sealed-secrets-key-admin
subjects:
- kind: ServiceAccount
  name: sealed-secrets-controller
  namespace: sealed-secrets
```

### Creating and Using Sealed Secrets

```bash
#!/bin/bash
# Sealed Secrets Creation and Management Script

set -euo pipefail

# Configuration
NAMESPACE="${NAMESPACE:-default}"
SECRET_NAME="${SECRET_NAME:-app-secrets}"
CONTROLLER_NAME="${CONTROLLER_NAME:-sealed-secrets-controller}"
CONTROLLER_NAMESPACE="${CONTROLLER_NAMESPACE:-sealed-secrets}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $*"
}

error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

# Install kubeseal CLI
install_kubeseal() {
    log "Installing kubeseal CLI..."

    local version="0.24.0"
    local os="linux"
    local arch="amd64"

    curl -L "https://github.com/bitnami-labs/sealed-secrets/releases/download/v${version}/kubeseal-${version}-${os}-${arch}.tar.gz" \
        -o /tmp/kubeseal.tar.gz

    tar xfz /tmp/kubeseal.tar.gz -C /tmp/
    sudo mv /tmp/kubeseal /usr/local/bin/
    sudo chmod +x /usr/local/bin/kubeseal
    rm /tmp/kubeseal.tar.gz

    log "kubeseal version: $(kubeseal --version)"
}

# Fetch public key from controller
fetch_public_key() {
    log "Fetching public key from sealed-secrets controller..."

    kubeseal --fetch-cert \
        --controller-name="${CONTROLLER_NAME}" \
        --controller-namespace="${CONTROLLER_NAMESPACE}" \
        > /tmp/sealed-secrets-public-key.pem

    log "Public key saved to /tmp/sealed-secrets-public-key.pem"
}

# Create sealed secret from literal values
create_sealed_secret_literal() {
    local secret_name="$1"
    local namespace="$2"
    shift 2
    local literals=("$@")

    log "Creating sealed secret: ${secret_name} in namespace: ${namespace}"

    # Build kubectl command
    local cmd="kubectl create secret generic ${secret_name} --namespace=${namespace} --dry-run=client -o yaml"

    for literal in "${literals[@]}"; do
        cmd="${cmd} --from-literal=${literal}"
    done

    # Create and seal the secret
    eval "${cmd}" | kubeseal \
        --controller-name="${CONTROLLER_NAME}" \
        --controller-namespace="${CONTROLLER_NAMESPACE}" \
        --format=yaml \
        > "${secret_name}-sealed.yaml"

    log "Sealed secret created: ${secret_name}-sealed.yaml"
}

# Create sealed secret from file
create_sealed_secret_file() {
    local secret_name="$1"
    local namespace="$2"
    local file_path="$3"

    log "Creating sealed secret from file: ${file_path}"

    kubectl create secret generic "${secret_name}" \
        --namespace="${namespace}" \
        --from-file="${file_path}" \
        --dry-run=client -o yaml | \
    kubeseal \
        --controller-name="${CONTROLLER_NAME}" \
        --controller-namespace="${CONTROLLER_NAMESPACE}" \
        --format=yaml \
        > "${secret_name}-sealed.yaml"

    log "Sealed secret created: ${secret_name}-sealed.yaml"
}

# Seal existing secret
seal_existing_secret() {
    local secret_name="$1"
    local namespace="$2"

    log "Sealing existing secret: ${secret_name}"

    kubectl get secret "${secret_name}" \
        --namespace="${namespace}" \
        -o yaml | \
    kubeseal \
        --controller-name="${CONTROLLER_NAME}" \
        --controller-namespace="${CONTROLLER_NAMESPACE}" \
        --format=yaml \
        > "${secret_name}-sealed.yaml"

    log "Existing secret sealed: ${secret_name}-sealed.yaml"
}

# Rotate sealed secrets encryption key
rotate_encryption_key() {
    log "Rotating sealed secrets encryption key..."

    # Label old key for deletion
    kubectl label secret \
        -n "${CONTROLLER_NAMESPACE}" \
        -l sealedsecrets.bitnami.com/sealed-secrets-key=active \
        sealedsecrets.bitnami.com/sealed-secrets-key=old \
        --overwrite

    # Restart controller to generate new key
    kubectl rollout restart deployment/"${CONTROLLER_NAME}" \
        -n "${CONTROLLER_NAMESPACE}"

    # Wait for rollout
    kubectl rollout status deployment/"${CONTROLLER_NAME}" \
        -n "${CONTROLLER_NAMESPACE}" \
        --timeout=300s

    log "Encryption key rotated successfully"
}

# Backup encryption keys
backup_encryption_keys() {
    local backup_dir="${1:-./sealed-secrets-backup}"

    log "Backing up sealed secrets encryption keys to: ${backup_dir}"

    mkdir -p "${backup_dir}"

    kubectl get secret \
        -n "${CONTROLLER_NAMESPACE}" \
        -l sealedsecrets.bitnami.com/sealed-secrets-key \
        -o yaml \
        > "${backup_dir}/sealed-secrets-keys-$(date +%Y%m%d-%H%M%S).yaml"

    log "Encryption keys backed up successfully"
}

# Verify sealed secret
verify_sealed_secret() {
    local sealed_secret_file="$1"

    log "Verifying sealed secret: ${sealed_secret_file}"

    if ! kubectl apply --dry-run=server -f "${sealed_secret_file}"; then
        error "Sealed secret validation failed"
        return 1
    fi

    log "Sealed secret is valid"
}

# Example usage
main() {
    log "Sealed Secrets Management Script"

    # Ensure kubeseal is installed
    if ! command -v kubeseal &> /dev/null; then
        install_kubeseal
    fi

    # Fetch public key
    fetch_public_key

    # Example: Create sealed secret from literals
    create_sealed_secret_literal \
        "database-credentials" \
        "production" \
        "username=admin" \
        "password=securePassword123"

    # Example: Create sealed secret from file
    # create_sealed_secret_file "tls-cert" "production" "./tls.crt"

    # Verify created sealed secret
    verify_sealed_secret "database-credentials-sealed.yaml"

    log "Sealed secrets management completed"
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
```

### Sealed Secret Example

```yaml
# Example Sealed Secret Resource
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: database-credentials
  namespace: production
  annotations:
    sealedsecrets.bitnami.com/cluster-wide: "true"
    sealedsecrets.bitnami.com/namespace-wide: "false"
spec:
  encryptedData:
    username: AgBvXR7ZT8... (encrypted data)
    password: AgCqT5YnM2... (encrypted data)
  template:
    metadata:
      name: database-credentials
      namespace: production
      labels:
        app: myapp
        component: database
    type: Opaque
```

## External Secrets Operator Architecture

External Secrets Operator synchronizes secrets from external secret management systems into Kubernetes.

### Controller Deployment

```yaml
# External Secrets Operator Installation
apiVersion: v1
kind: Namespace
metadata:
  name: external-secrets
  labels:
    app.kubernetes.io/name: external-secrets
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-secrets
  namespace: external-secrets
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: external-secrets
  template:
    metadata:
      labels:
        app.kubernetes.io/name: external-secrets
    spec:
      serviceAccountName: external-secrets
      containers:
      - name: external-secrets
        image: ghcr.io/external-secrets/external-secrets:v0.9.9
        args:
        - --concurrent=5
        - --enable-leader-election
        - --loglevel=info
        - --metrics-addr=:8080
        ports:
        - containerPort: 8080
          name: metrics
          protocol: TCP
        - containerPort: 8081
          name: healthz
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /healthz
            port: healthz
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /readyz
            port: healthz
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          limits:
            cpu: 200m
            memory: 256Mi
          requests:
            cpu: 100m
            memory: 128Mi
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: external-secrets-webhook
  namespace: external-secrets
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: external-secrets-webhook
  template:
    metadata:
      labels:
        app.kubernetes.io/name: external-secrets-webhook
    spec:
      serviceAccountName: external-secrets-webhook
      containers:
      - name: webhook
        image: ghcr.io/external-secrets/external-secrets:v0.9.9
        args:
        - webhook
        - --port=10250
        - --dns-name=external-secrets-webhook.external-secrets.svc
        - --cert-dir=/tmp/certs
        - --check-interval=5m
        - --loglevel=info
        ports:
        - containerPort: 10250
          name: webhook
          protocol: TCP
        - containerPort: 8081
          name: healthz
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /healthz
            port: healthz
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /readyz
            port: healthz
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          limits:
            cpu: 100m
            memory: 128Mi
          requests:
            cpu: 50m
            memory: 64Mi
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
        volumeMounts:
        - name: certs
          mountPath: /tmp/certs
          readOnly: false
      volumes:
      - name: certs
        emptyDir: {}
```

### AWS Secrets Manager Integration

```yaml
# SecretStore for AWS Secrets Manager
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
---
# ClusterSecretStore for Multi-Namespace Access
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager-global
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
---
# ExternalSecret Resource
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
    deletionPolicy: Retain
    template:
      type: Opaque
      metadata:
        labels:
          app: myapp
          component: database
      data:
        # Template the secret data
        connection-string: |
          postgresql://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .database }}
  dataFrom:
  - extract:
      key: prod/database/credentials
  # Or use individual data items
  data:
  - secretKey: username
    remoteRef:
      key: prod/database/credentials
      property: username
  - secretKey: password
    remoteRef:
      key: prod/database/credentials
      property: password
  - secretKey: host
    remoteRef:
      key: prod/database/credentials
      property: host
  - secretKey: port
    remoteRef:
      key: prod/database/credentials
      property: port
  - secretKey: database
    remoteRef:
      key: prod/database/credentials
      property: database
```

### HashiCorp Vault Integration

```yaml
# SecretStore for HashiCorp Vault
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: production
spec:
  provider:
    vault:
      server: "https://vault.company.com"
      path: "secret"
      version: "v2"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets"
          serviceAccountRef:
            name: external-secrets-sa
---
# ExternalSecret for Vault KV Store
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: vault-secrets
  namespace: production
spec:
  refreshInterval: 15m
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: vault-secrets
    creationPolicy: Owner
    template:
      engineVersion: v2
      data:
        config.json: |
          {
            "api_key": "{{ .api_key }}",
            "api_secret": "{{ .api_secret }}",
            "webhook_url": "{{ .webhook_url }}"
          }
  data:
  - secretKey: api_key
    remoteRef:
      key: prod/app/config
      property: api_key
  - secretKey: api_secret
    remoteRef:
      key: prod/app/config
      property: api_secret
  - secretKey: webhook_url
    remoteRef:
      key: prod/app/config
      property: webhook_url
---
# Dynamic Secret Example (Database Credentials)
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: dynamic-db-credentials
  namespace: production
spec:
  refreshInterval: 5m  # Short interval for dynamic credentials
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: dynamic-db-credentials
    creationPolicy: Owner
    deletionPolicy: Delete
  data:
  - secretKey: username
    remoteRef:
      key: database/creds/app-role
      property: username
  - secretKey: password
    remoteRef:
      key: database/creds/app-role
      property: password
```

### Google Secret Manager Integration

```yaml
# SecretStore for Google Secret Manager
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: gcpsm-secret-store
spec:
  provider:
    gcpsm:
      projectID: "my-gcp-project"
      auth:
        workloadIdentity:
          clusterLocation: us-central1
          clusterName: production-cluster
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
---
# ExternalSecret for GCP Secret Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: gcp-secrets
  namespace: production
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: gcpsm-secret-store
    kind: ClusterSecretStore
  target:
    name: gcp-secrets
    creationPolicy: Owner
  data:
  - secretKey: api-key
    remoteRef:
      key: prod-api-key
      version: latest
  - secretKey: database-password
    remoteRef:
      key: prod-database-password
      version: "1"  # Specific version
```

### Azure Key Vault Integration

```yaml
# SecretStore for Azure Key Vault
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: azure-keyvault
  namespace: production
spec:
  provider:
    azurekv:
      vaultUrl: "https://my-vault.vault.azure.net"
      tenantId: "tenant-id"
      authType: WorkloadIdentity
      serviceAccountRef:
        name: external-secrets-sa
---
# ExternalSecret for Azure Key Vault
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: azure-secrets
  namespace: production
spec:
  refreshInterval: 30m
  secretStoreRef:
    name: azure-keyvault
    kind: SecretStore
  target:
    name: azure-secrets
    creationPolicy: Owner
  data:
  - secretKey: connection-string
    remoteRef:
      key: database-connection-string
  - secretKey: storage-account-key
    remoteRef:
      key: storage-account-key
  - secretKey: certificate
    remoteRef:
      key: tls-certificate
```

## Advanced Configuration Patterns

### PushSecret for Bidirectional Sync

```yaml
# PushSecret - Push Kubernetes Secrets to External Provider
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-secret-example
  namespace: production
spec:
  refreshInterval: 10m
  secretStoreRefs:
  - name: aws-secrets-manager
    kind: SecretStore
  selector:
    secret:
      name: local-secret
  data:
  - match:
      secretKey: username
      remoteRef:
        remoteKey: prod/app/credentials
        property: username
  - match:
      secretKey: password
      remoteRef:
        remoteKey: prod/app/credentials
        property: password
```

### Secret Rotation Automation

```yaml
# Automated Secret Rotation Configuration
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: rotated-credentials
  namespace: production
  annotations:
    external-secrets.io/rotation-strategy: "recreate"
spec:
  refreshInterval: 5m
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: rotated-credentials
    creationPolicy: Owner
    deletionPolicy: Delete
    template:
      type: Opaque
      metadata:
        annotations:
          reloader.stakater.com/match: "true"
  data:
  - secretKey: credentials
    remoteRef:
      key: dynamic/database/creds/app
---
# Reloader Deployment for Automatic Pod Restarts
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-with-rotation
  namespace: production
  annotations:
    reloader.stakater.com/search: "true"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: app
        image: myapp:latest
        envFrom:
        - secretRef:
            name: rotated-credentials
```

## Monitoring and Observability

### Prometheus Metrics

```yaml
# ServiceMonitor for Sealed Secrets
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: sealed-secrets-controller
  namespace: sealed-secrets
spec:
  selector:
    matchLabels:
      name: sealed-secrets-controller
  endpoints:
  - port: metrics
    interval: 30s
    path: /metrics
---
# ServiceMonitor for External Secrets
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
    path: /metrics
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Secrets Management Overview",
    "panels": [
      {
        "title": "External Secrets Sync Status",
        "targets": [
          {
            "expr": "externalsecret_sync_calls_total",
            "legendFormat": "{{namespace}}/{{name}} - {{status}}"
          }
        ]
      },
      {
        "title": "Secret Sync Errors",
        "targets": [
          {
            "expr": "rate(externalsecret_sync_calls_error[5m])",
            "legendFormat": "{{namespace}}/{{name}}"
          }
        ]
      },
      {
        "title": "Sealed Secrets Controller Status",
        "targets": [
          {
            "expr": "sealed_secrets_controller_unseal_requests_total",
            "legendFormat": "Unseal Requests"
          }
        ]
      }
    ]
  }
}
```

### Alert Rules

```yaml
# PrometheusRule for Secrets Monitoring
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: secrets-management-alerts
  namespace: monitoring
spec:
  groups:
  - name: external-secrets
    interval: 30s
    rules:
    - alert: ExternalSecretSyncFailure
      expr: |
        externalsecret_sync_calls_error > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "External Secret sync failing"
        description: "External Secret {{ $labels.namespace }}/{{ $labels.name }} has failed to sync for 5 minutes"

    - alert: ExternalSecretNotReady
      expr: |
        externalsecret_status_condition{condition="Ready",status="False"} > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "External Secret not ready"
        description: "External Secret {{ $labels.namespace }}/{{ $labels.name }} is not in Ready state"

    - alert: SecretStoreNotReady
      expr: |
        secretstore_status_condition{condition="Ready",status="False"} > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Secret Store not ready"
        description: "Secret Store {{ $labels.namespace }}/{{ $labels.name }} is not in Ready state"

  - name: sealed-secrets
    interval: 30s
    rules:
    - alert: SealedSecretsControllerDown
      expr: |
        up{job="sealed-secrets-controller"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Sealed Secrets Controller is down"
        description: "The Sealed Secrets Controller has been down for 5 minutes"

    - alert: HighUnsealErrorRate
      expr: |
        rate(sealed_secrets_controller_unseal_errors_total[5m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "High unseal error rate"
        description: "Sealed Secrets Controller is experiencing high unseal error rate"
```

## Security Best Practices

### RBAC for Secrets Access

```yaml
# Restricted RBAC for Secrets Management
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: secrets-operator
  namespace: production
rules:
# Allow reading SecretStores and ExternalSecrets
- apiGroups: ["external-secrets.io"]
  resources: ["secretstores", "externalsecrets"]
  verbs: ["get", "list", "watch"]
# Allow creating and updating Secrets
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["create", "update", "patch"]
# Deny deletion of secrets
# - apiGroups: [""]
#   resources: ["secrets"]
#   verbs: ["delete"]
---
# Role for Application Access to Secrets
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: app-secrets-reader
  namespace: production
rules:
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["app-secrets", "database-credentials"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: app-secrets-reader
  namespace: production
subjects:
- kind: ServiceAccount
  name: myapp
  namespace: production
roleRef:
  kind: Role
  name: app-secrets-reader
  apiGroup: rbac.authorization.k8s.io
```

### Network Policies

```yaml
# Network Policy for External Secrets Controller
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
  - Ingress
  - Egress
  ingress:
  # Allow metrics scraping
  - from:
    - namespaceSelector:
        matchLabels:
          name: monitoring
    ports:
    - protocol: TCP
      port: 8080
  egress:
  # Allow DNS
  - to:
    - namespaceSelector:
        matchLabels:
          name: kube-system
    ports:
    - protocol: UDP
      port: 53
  # Allow Kubernetes API access
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          component: apiserver
    ports:
    - protocol: TCP
      port: 443
  # Allow external secret provider access (AWS, Vault, etc.)
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443
```

## Comparison and Selection Criteria

### Feature Comparison Matrix

| Feature | Sealed Secrets | External Secrets Operator |
|---------|---------------|---------------------------|
| **Storage** | Git repository (encrypted) | External secret management system |
| **Secret Source** | Kubernetes cluster only | Multiple providers (AWS, GCP, Azure, Vault) |
| **Encryption** | Asymmetric (RSA) | Provider-specific |
| **GitOps Friendly** | Excellent | Good (requires external system) |
| **Secret Rotation** | Manual re-encryption | Automatic sync |
| **Multi-Cluster** | Separate keys per cluster | Centralized secret source |
| **Complexity** | Low | Medium to High |
| **Dependencies** | None | External secret management system |
| **Cost** | Free | Depends on provider |
| **Backup/Recovery** | Git history | Provider-dependent |

### Decision Framework

**Choose Sealed Secrets when:**
- GitOps workflow is primary requirement
- Self-contained solution preferred
- No existing secret management infrastructure
- Cost is a primary concern
- Secrets don't require frequent rotation
- Multi-cluster secrets are cluster-specific

**Choose External Secrets Operator when:**
- Existing secret management system (Vault, AWS Secrets Manager)
- Dynamic secret generation required
- Frequent secret rotation needed
- Centralized secret management across multiple clusters
- Compliance requires dedicated secret management
- Complex secret templating and transformation needed

## Production Implementation Guide

### Migration Strategy

```bash
#!/bin/bash
# Migration from Sealed Secrets to External Secrets

set -euo pipefail

migrate_sealed_to_external() {
    local namespace="$1"
    local sealed_secret="$2"
    local secret_store="$3"
    local remote_path="$4"

    echo "Migrating sealed secret: ${sealed_secret}"

    # 1. Extract the unsealed secret
    kubectl get secret "${sealed_secret}" -n "${namespace}" -o json > "/tmp/${sealed_secret}.json"

    # 2. Upload to external provider (example: AWS Secrets Manager)
    local secret_data=$(kubectl get secret "${sealed_secret}" -n "${namespace}" -o json | \
        jq -r '.data | map_values(@base64d) | to_entries | map({key: .key, value: .value}) | from_entries')

    aws secretsmanager create-secret \
        --name "${remote_path}" \
        --secret-string "${secret_data}" \
        --region us-east-1

    # 3. Create ExternalSecret resource
    cat <<EOF | kubectl apply -f -
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${sealed_secret}
  namespace: ${namespace}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: ${secret_store}
    kind: SecretStore
  target:
    name: ${sealed_secret}
    creationPolicy: Owner
  dataFrom:
  - extract:
      key: ${remote_path}
EOF

    echo "Migration completed for: ${sealed_secret}"
}

# Example usage
# migrate_sealed_to_external "production" "app-secrets" "aws-secrets-manager" "prod/app/secrets"
```

### Disaster Recovery

```yaml
# Backup CronJob for External Secrets
apiVersion: batch/v1
kind: CronJob
metadata:
  name: external-secrets-backup
  namespace: external-secrets
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-sa
          containers:
          - name: backup
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              #!/bin/sh
              set -e

              BACKUP_DIR="/backup/external-secrets-$(date +%Y%m%d)"
              mkdir -p "$BACKUP_DIR"

              # Backup all ExternalSecret resources
              for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
                kubectl get externalsecrets -n "$ns" -o yaml > "$BACKUP_DIR/externalsecrets-$ns.yaml" 2>/dev/null || true
                kubectl get secretstores -n "$ns" -o yaml > "$BACKUP_DIR/secretstores-$ns.yaml" 2>/dev/null || true
              done

              # Backup ClusterSecretStores
              kubectl get clustersecretstores -o yaml > "$BACKUP_DIR/clustersecretstores.yaml"

              # Upload to S3
              aws s3 sync "$BACKUP_DIR" "s3://my-backup-bucket/external-secrets/"

              # Cleanup old backups (keep 30 days)
              find /backup -type d -mtime +30 -exec rm -rf {} +
            volumeMounts:
            - name: backup
              mountPath: /backup
          volumes:
          - name: backup
            persistentVolumeClaim:
              claimName: backup-pvc
          restartPolicy: OnFailure
```

## Conclusion

Both Sealed Secrets and External Secrets Operator provide robust solutions for Kubernetes secrets management, each with distinct advantages for different use cases. Sealed Secrets excels in GitOps-centric workflows with its simplicity and self-contained architecture, while External Secrets Operator shines in enterprise environments requiring integration with existing secret management infrastructure and dynamic secret rotation.

The choice between these solutions should be based on your organization's existing infrastructure, compliance requirements, operational complexity tolerance, and secret lifecycle management needs. Many organizations successfully implement both solutions, using Sealed Secrets for application configuration and External Secrets Operator for dynamic credentials and sensitive secrets requiring frequent rotation.

Implementing proper monitoring, backup strategies, and security controls remains critical regardless of which solution you choose, ensuring that your secrets management infrastructure provides the security, reliability, and operational efficiency required for production Kubernetes environments.