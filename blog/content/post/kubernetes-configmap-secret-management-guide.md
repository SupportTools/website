---
title: "Kubernetes ConfigMap and Secret Lifecycle Management in Production"
date: 2028-01-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ConfigMap", "Secrets", "Security", "Reloader", "Production"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubernetes ConfigMap and Secret lifecycle management covering immutable resources, projected volumes, subPath mounting, automatic reload with Reloader, binary secrets, projected service account tokens, and secretRef vs envFrom patterns."
more_link: "yes"
url: "/kubernetes-configmap-secret-management-guide/"
---

ConfigMaps and Secrets are the primary mechanisms for injecting external configuration and credentials into Kubernetes workloads. While the basic usage is straightforward, production deployments expose edge cases in update propagation, size limits, binary data handling, and security posture that require deliberate design. This guide addresses the complete lifecycle: creation, mounting, update propagation, immutability, and secure access patterns.

<!--more-->

# Kubernetes ConfigMap and Secret Lifecycle Management in Production

## Section 1: ConfigMap Fundamentals and Size Limits

### ConfigMap Constraints

ConfigMaps have a 1 MiB data limit per object (enforced by etcd's value size limit). This limit applies to the total size of all key-value pairs. For larger configuration data, alternatives include:

- Operator-managed CRDs with separate storage backends
- S3/GCS buckets for configuration files, downloaded by init containers
- HashiCorp Vault for large configuration sets

```yaml
# configmap-basic.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: application-config
  namespace: production
  # Labels for selector-based lookups
  labels:
    app: payment-service
    environment: production
    config-type: application
  annotations:
    # Track the config version for rollback correlation
    config.kubernetes.io/version: "1.4.2"
    # Last updated timestamp for auditing
    config.kubernetes.io/last-updated: "2028-01-15T10:30:00Z"
data:
  # Simple key-value pairs
  LOG_LEVEL: "info"
  LOG_FORMAT: "json"
  MAX_CONNECTIONS: "100"
  FEATURE_FLAGS: "payment_v2=true,new_checkout=false"

  # Multi-line configuration file embedded as a single key
  # The key name can use file-extension conventions for tooling support
  app.yaml: |
    server:
      port: 8080
      read_timeout: 30s
      write_timeout: 30s
      shutdown_timeout: 60s

    database:
      max_open_connections: 25
      max_idle_connections: 5
      connection_max_lifetime: 5m

    cache:
      default_ttl: 5m
      max_size_mb: 512

  nginx.conf: |
    worker_processes auto;
    events {
        worker_connections 1024;
    }
    http {
        server {
            listen 8080;
            location / {
                proxy_pass http://localhost:8081;
            }
        }
    }
```

### Immutable ConfigMaps

Immutable ConfigMaps (Kubernetes 1.21+) provide two benefits:

1. Applications reading the ConfigMap cannot observe partial updates during rolling changes
2. The API server does not watch immutable ConfigMaps for changes, reducing apiserver load at scale (significant in clusters with thousands of ConfigMaps)

```yaml
# immutable-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: application-config-v1-4-2
  namespace: production
# Immutable: true prevents any future modifications to data or binaryData.
# To update, create a new ConfigMap with a new name/version suffix,
# then update Deployments to reference the new name.
immutable: true
data:
  LOG_LEVEL: "info"
  app.yaml: |
    server:
      port: 8080
```

```bash
#!/bin/bash
# rolling-configmap-update.sh
# Procedure for updating an immutable ConfigMap without downtime

set -euo pipefail

SERVICE_NAME="payment-service"
NAMESPACE="production"
OLD_VERSION="1.4.2"
NEW_VERSION="1.4.3"
OLD_CM_NAME="${SERVICE_NAME}-config-$(echo ${OLD_VERSION} | tr '.' '-')"
NEW_CM_NAME="${SERVICE_NAME}-config-$(echo ${NEW_VERSION} | tr '.' '-')"

echo "=== Immutable ConfigMap Rolling Update ==="
echo "From: ${OLD_CM_NAME}"
echo "To:   ${NEW_CM_NAME}"

# 1. Create the new ConfigMap
echo "Creating new ConfigMap ${NEW_CM_NAME}..."
kubectl apply -f - << EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${NEW_CM_NAME}
  namespace: ${NAMESPACE}
immutable: true
data:
  LOG_LEVEL: "warn"
  app.yaml: |
    server:
      port: 8080
      shutdown_timeout: 90s
EOF

# 2. Update the Deployment to reference the new ConfigMap
echo "Updating Deployment to use ${NEW_CM_NAME}..."
kubectl patch deployment ${SERVICE_NAME} \
  -n ${NAMESPACE} \
  --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/volumes/0/configMap/name","value":"'${NEW_CM_NAME}'"}]'

# 3. Wait for rollout to complete
echo "Waiting for rolling update to complete..."
kubectl rollout status deployment/${SERVICE_NAME} -n ${NAMESPACE} --timeout=5m

# 4. Remove old ConfigMap only after successful rollout
echo "Removing old ConfigMap ${OLD_CM_NAME}..."
kubectl delete configmap ${OLD_CM_NAME} -n ${NAMESPACE}

echo "ConfigMap update complete."
```

## Section 2: Secret Types and Binary Data

### Built-in Secret Types

```yaml
# secret-types.yaml
# Type: kubernetes.io/basic-auth
apiVersion: v1
kind: Secret
metadata:
  name: database-credentials
  namespace: production
type: kubernetes.io/basic-auth
stringData:
  # stringData is encoded automatically to base64 in data
  username: "app_user"
  password: "PLACEHOLDER_PASSWORD"  # Replace with actual password via CI/CD
---
# Type: kubernetes.io/tls
apiVersion: v1
kind: Secret
metadata:
  name: service-tls
  namespace: production
type: kubernetes.io/tls
data:
  # Must be base64-encoded PEM format
  # tls.crt: <base64-encoded certificate chain>
  # tls.key: <base64-encoded private key>
  tls.crt: ""  # Populated by cert-manager
  tls.key: ""  # Populated by cert-manager
---
# Type: kubernetes.io/dockerconfigjson
# Used by Kubernetes to pull images from private registries
apiVersion: v1
kind: Secret
metadata:
  name: registry-credentials
  namespace: production
type: kubernetes.io/dockerconfigjson
data:
  # .dockerconfigjson value is base64-encoded JSON
  .dockerconfigjson: ""  # Generated by: kubectl create secret docker-registry
---
# Type: Opaque (generic) — default for custom secrets
apiVersion: v1
kind: Secret
metadata:
  name: api-keys
  namespace: production
  annotations:
    # Annotation-based secret rotation tracking
    secret.kubernetes.io/rotation-date: "2028-01-01"
    secret.kubernetes.io/expiry-date: "2029-01-01"
type: Opaque
stringData:
  STRIPE_API_KEY: "sk_live_PLACEHOLDER_KEY"
  SENDGRID_API_KEY: "SG.PLACEHOLDER_KEY"
  INTERNAL_API_SECRET: "PLACEHOLDER_SECRET_VALUE"
```

### Binary Secrets

Some secrets are binary (TLS keystores, SSH keys, cryptographic material) and cannot be represented as UTF-8 strings. The `data` field accepts base64-encoded binary values.

```bash
#!/bin/bash
# create-binary-secret.sh
# Create a secret containing a Java PKCS12 keystore (binary format)

KEYSTORE_PATH="/path/to/service.p12"
TRUSTSTORE_PATH="/path/to/truststore.jks"
NAMESPACE="production"
SECRET_NAME="service-java-keystores"

# Encode binary files to base64 (single line, no wrapping)
KEYSTORE_B64=$(base64 -w 0 "${KEYSTORE_PATH}")
TRUSTSTORE_B64=$(base64 -w 0 "${TRUSTSTORE_PATH}")

# Create secret with binary data field
kubectl create secret generic "${SECRET_NAME}" \
  --namespace="${NAMESPACE}" \
  --from-file=service.p12="${KEYSTORE_PATH}" \
  --from-file=truststore.jks="${TRUSTSTORE_PATH}" \
  --dry-run=client -o yaml \
  | kubectl apply -f -

echo "Binary secret ${SECRET_NAME} created in ${NAMESPACE}."
echo "Keystore size: $(wc -c < ${KEYSTORE_PATH}) bytes"
```

```yaml
# binary-secret-mount.yaml
# Mount binary secrets as files in the container
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-service
  namespace: production
spec:
  selector:
    matchLabels:
      app: java-service
  template:
    spec:
      containers:
        - name: java-service
          image: java-service:4.2.0
          env:
            - name: KEYSTORE_PATH
              value: "/etc/ssl/keystores/service.p12"
            - name: TRUSTSTORE_PATH
              value: "/etc/ssl/keystores/truststore.jks"
            - name: KEYSTORE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: keystore-passwords
                  key: keystore_password
          volumeMounts:
            - name: java-keystores
              mountPath: /etc/ssl/keystores
              readOnly: true

      volumes:
        - name: java-keystores
          secret:
            secretName: service-java-keystores
            # Set file permissions on mounted secrets
            # 0400 = read-only for owner only
            defaultMode: 0400
```

## Section 3: Volume Mounting Patterns

### subPath Mounting for Selective File Injection

Without `subPath`, mounting a ConfigMap as a volume replaces the entire target directory. `subPath` mounts a single key as a file within an existing directory, preserving other directory contents.

```yaml
# subpath-mounting.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-with-custom-config
  namespace: production
spec:
  selector:
    matchLabels:
      app: nginx-custom
  template:
    spec:
      containers:
        - name: nginx
          image: nginx:1.25-alpine
          volumeMounts:
            # Mount only nginx.conf, not the entire ConfigMap
            # Without subPath: mounting at /etc/nginx would replace ALL nginx config files
            # With subPath: only nginx.conf is replaced, other files remain
            - name: nginx-config
              mountPath: /etc/nginx/nginx.conf
              subPath: nginx.conf  # Must match a key in the ConfigMap
              readOnly: true

            # Mount a specific environment file into an existing directory
            - name: app-config
              mountPath: /app/config/database.yml
              subPath: database.yml
              readOnly: true

            # Mount a secret as a specific file without replacing the directory
            - name: ssl-certs
              mountPath: /etc/ssl/certs/internal-ca.crt
              subPath: ca.crt
              readOnly: true

      volumes:
        - name: nginx-config
          configMap:
            name: nginx-configuration
        - name: app-config
          configMap:
            name: application-config
        - name: ssl-certs
          secret:
            secretName: internal-ca-cert
            defaultMode: 0444
```

### IMPORTANT: subPath Does Not Update on ConfigMap Changes

A critical limitation: volumes mounted with `subPath` do NOT automatically update when the ConfigMap or Secret changes. The kubelet syncs regular volume mounts (without `subPath`) within the `--sync-frequency` period (default 1 minute), but `subPath` mounts are static at pod creation time.

```yaml
# subpath-update-workaround.yaml
# Workaround: use a regular volume mount and symlink within the container
# The symlink approach allows auto-update without subPath limitation
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-auto-update
  namespace: production
spec:
  selector:
    matchLabels:
      app: nginx-auto-update
  template:
    spec:
      initContainers:
        # Create symlink from actual nginx config path to our mounted config
        - name: setup-config-symlink
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              # Remove default nginx.conf and create a symlink to our volume
              rm -f /etc/nginx/nginx.conf
              ln -sf /etc/nginx-config/nginx.conf /etc/nginx/nginx.conf
              echo "Config symlink created"
          volumeMounts:
            - name: nginx-root
              mountPath: /etc/nginx

      containers:
        - name: nginx
          image: nginx:1.25-alpine
          volumeMounts:
            # Mount the entire ConfigMap directory
            # This WILL auto-update when ConfigMap changes
            - name: nginx-config
              mountPath: /etc/nginx-config
            - name: nginx-root
              mountPath: /etc/nginx
          # Signal nginx to reload config when the mounted file changes
          lifecycle:
            postStart:
              exec:
                command:
                  - sh
                  - -c
                  - |
                    # Watch for config changes and signal nginx to reload
                    # In production, use Reloader (see Section 5) instead
                    (while true; do
                      inotifywait -e modify /etc/nginx-config/nginx.conf && \
                      nginx -t && \
                      nginx -s reload
                    done) &

      volumes:
        - name: nginx-config
          configMap:
            name: nginx-configuration
        - name: nginx-root
          emptyDir: {}
```

## Section 4: Projected Volumes

Projected volumes combine multiple sources (ConfigMaps, Secrets, service account tokens, downward API) into a single volume mount point, reducing the number of volume definitions in pod specifications.

```yaml
# projected-volume.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: projected-volume-demo
  namespace: production
spec:
  selector:
    matchLabels:
      app: projected-demo
  template:
    spec:
      serviceAccountName: payment-service
      containers:
        - name: app
          image: app:latest
          volumeMounts:
            # Single mount point combining 4 different sources
            - name: combined-config
              mountPath: /etc/app/config

      volumes:
        - name: combined-config
          projected:
            # Default permission mode for all mounted files
            defaultMode: 0440
            sources:
              # Source 1: Application ConfigMap
              - configMap:
                  name: application-config
                  items:
                    - key: app.yaml
                      path: app.yaml  # Mounted at /etc/app/config/app.yaml
                    - key: LOG_LEVEL
                      path: log-level.txt

              # Source 2: Database credentials Secret
              - secret:
                  name: database-credentials
                  items:
                    - key: password
                      path: db-password  # Mounted at /etc/app/config/db-password
                      mode: 0400  # Override to stricter permissions for password

              # Source 3: Downward API — expose pod metadata as files
              - downwardAPI:
                  items:
                    - path: pod-name
                      fieldRef:
                        fieldPath: metadata.name
                    - path: pod-namespace
                      fieldRef:
                        fieldPath: metadata.namespace
                    - path: pod-labels
                      fieldRef:
                        fieldPath: metadata.labels
                    - path: resource-limits-cpu
                      resourceFieldRef:
                        containerName: app
                        resource: limits.cpu

              # Source 4: Projected Service Account Token (PSAT)
              # Bound token with audience and expiry constraints
              - serviceAccountToken:
                  audience: "https://vault.example.com"
                  expirationSeconds: 3600  # Rotate every hour
                  path: vault-token  # Mounted at /etc/app/config/vault-token
```

### Projected Service Account Token Deep Dive

```yaml
# projected-service-account-token.yaml
# PSAT provides bound, audience-scoped tokens instead of the long-lived
# service account JWT tokens mounted by default
apiVersion: apps/v1
kind: Deployment
metadata:
  name: psat-demo
  namespace: production
spec:
  selector:
    matchLabels:
      app: psat-demo
  template:
    spec:
      serviceAccountName: psat-demo-service
      # Disable automatic service account token mounting
      # (the legacy long-lived token)
      automountServiceAccountToken: false
      containers:
        - name: app
          image: app:latest
          volumeMounts:
            - name: bound-tokens
              mountPath: /var/run/secrets/tokens
              readOnly: true

      volumes:
        - name: bound-tokens
          projected:
            sources:
              # Kubernetes API audience token — for calling kube-apiserver
              - serviceAccountToken:
                  audience: "kubernetes.default.svc"
                  expirationSeconds: 3600
                  path: kube-api-token

              # Vault audience token — for Vault JWT authentication
              - serviceAccountToken:
                  audience: "https://vault.production.example.com"
                  expirationSeconds: 1800  # Shorter for more sensitive operations
                  path: vault-token

              # Custom audience token for internal service mesh
              - serviceAccountToken:
                  audience: "https://service-mesh.internal"
                  expirationSeconds: 3600
                  path: mesh-token
```

## Section 5: Automatic Configuration Reload with Stakater Reloader

The Stakater Reloader watches ConfigMaps and Secrets for changes and triggers rolling restarts of Deployments, StatefulSets, and DaemonSets that reference the changed resources.

### Reloader Deployment

```yaml
# reloader-deployment.yaml
# Install Reloader via Helm:
# helm install reloader stakater/reloader -n stakater-reloader --create-namespace
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reloader
  namespace: stakater-reloader
spec:
  replicas: 1
  selector:
    matchLabels:
      app: reloader
  template:
    spec:
      serviceAccountName: reloader
      containers:
        - name: reloader
          image: ghcr.io/stakater/reloader:v1.0.69
          args:
            # Only watch resources with this annotation prefix (reduces noise)
            - "--auto-annotation=reloader.stakater.com/auto"
            # Also support legacy reload-on-change annotations
            - "--reload-on-change=true"
            # Sync period for re-checking watched resources
            - "--sync-after=5s"
            # Namespace scope — omit to watch all namespaces
            # - "--namespaces=production,staging"
```

### Configuring Reloader Annotations

```yaml
# deployment-with-reloader.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: application
  namespace: production
  annotations:
    # Strategy 1: Reload on ANY change to specified ConfigMaps or Secrets
    reloader.stakater.com/auto: "true"

    # Strategy 2: Reload only on changes to specific ConfigMaps
    # configmap.reloader.stakater.com/reload: "application-config,nginx-config"

    # Strategy 3: Reload on changes to specific Secrets
    # secret.reloader.stakater.com/reload: "database-credentials,api-keys"

    # Strategy 4: Reload on changes to any ConfigMap/Secret with matching search annotation
    # reloader.stakater.com/search: "true"
spec:
  selector:
    matchLabels:
      app: application
  template:
    spec:
      containers:
        - name: application
          image: app:latest
          envFrom:
            - configMapRef:
                name: application-config
            - secretRef:
                name: database-credentials
```

## Section 6: envFrom vs secretRef Patterns

### envFrom: Bulk Environment Variable Injection

```yaml
# envfrom-patterns.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: envfrom-demo
  namespace: production
spec:
  selector:
    matchLabels:
      app: envfrom-demo
  template:
    spec:
      containers:
        - name: app
          image: app:latest

          # envFrom injects ALL keys from a ConfigMap/Secret as environment variables
          # Useful for: configuration bundles, secret packages
          # Risk: injects ALL keys, including keys added later without explicit review
          envFrom:
            - configMapRef:
                name: application-config
                optional: false  # Fail pod if ConfigMap doesn't exist
            - secretRef:
                name: database-credentials
                optional: false
            # Prefix all keys from this source to avoid collisions
            - configMapRef:
                name: feature-flags
                prefix: "FF_"  # ENABLE_PAYMENTS becomes FF_ENABLE_PAYMENTS

          # env with valueFrom: explicit, named injection
          # Preferred for: sensitive values, values needing renaming
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: database-credentials
                  key: connection_string
                  optional: false

            - name: APP_VERSION
              valueFrom:
                configMapKeyRef:
                  name: deployment-metadata
                  key: version
                  optional: true  # Don't fail if key doesn't exist
                  # Default not supported here — use init container or entrypoint

            # Downward API inline
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
```

### Best Practice: Explicit vs. Bulk Injection Decision Matrix

```yaml
# injection-pattern-decision.yaml
# Use envFrom (bulk injection) when:
# - All keys in the ConfigMap/Secret are intended for this container
# - The ConfigMap/Secret is owned by the same team as the workload
# - Key names are controlled and will not collide with other sources

# Use valueFrom (explicit injection) when:
# - Only specific keys are needed from a shared ConfigMap/Secret
# - Key names need to be remapped for the application's expected variable names
# - The Secret contains sensitive keys that should only be exposed selectively
# - You want to document which specific configuration values the container uses

# Security recommendation:
# Prefer volume mounts over environment variables for secrets:
# - Environment variables are visible in /proc/$pid/environ
# - Environment variables are logged by some application frameworks
# - Volume files have configurable file permissions
# - Volume files support automatic rotation detection
```

## Section 7: Secret Rotation and Versioning

### External Secrets Operator Integration

```yaml
# external-secrets-example.yaml
# ExternalSecret pulls from AWS Secrets Manager and creates a Kubernetes Secret
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: payment-service-secrets
  namespace: production
spec:
  # Refresh interval — how often to sync from the external source
  refreshInterval: 1h

  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore

  target:
    name: payment-service-secrets  # Name of the created Kubernetes Secret
    creationPolicy: Owner          # Delete K8s secret when ExternalSecret is deleted
    # Template allows customization of the generated Secret
    template:
      type: Opaque
      metadata:
        annotations:
          # Track which ExternalSecret version created this Secret
          external-secrets.io/version: "{{ .version }}"

  data:
    # Map specific secret keys from AWS Secrets Manager
    - secretKey: stripe_api_key       # Key in Kubernetes Secret
      remoteRef:
        key: production/payment-service/stripe
        property: api_key             # Property within the secret JSON

    - secretKey: database_password
      remoteRef:
        key: production/payment-service/database
        property: password

  # Pull an entire secret as individual keys
  dataFrom:
    - extract:
        key: production/payment-service/config
```

### Sealed Secrets for GitOps

```bash
#!/bin/bash
# sealed-secret-creation.sh
# Create a SealedSecret that can be safely committed to Git
# Requires: kubeseal CLI and access to the sealed-secrets controller

NAMESPACE="production"
SECRET_NAME="database-credentials"

# Fetch the public key from the sealed-secrets controller
kubeseal --fetch-cert \
  --controller-name=sealed-secrets \
  --controller-namespace=sealed-secrets \
  > /tmp/sealed-secrets.pem

# Create the base secret (never commit this file)
kubectl create secret generic "${SECRET_NAME}" \
  --namespace="${NAMESPACE}" \
  --from-literal=username=app_user \
  --from-literal=password="PLACEHOLDER_DB_PASSWORD" \
  --dry-run=client -o yaml \
  | kubeseal \
    --cert=/tmp/sealed-secrets.pem \
    --format=yaml \
    --namespace="${NAMESPACE}" \
    > sealed-secret-${SECRET_NAME}.yaml

echo "SealedSecret created: sealed-secret-${SECRET_NAME}.yaml"
echo "This file is safe to commit to Git."
```

## Section 8: RBAC for ConfigMap and Secret Access

```yaml
# configmap-secret-rbac.yaml
# Principle of least privilege: grant only the access required
# by each service account

# Role allowing read-only access to specific ConfigMaps
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: configmap-reader
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    # Explicit resource names prevent access to other ConfigMaps
    resourceNames: ["application-config", "feature-flags"]
    verbs: ["get", "watch", "list"]
---
# Role allowing read-only access to specific Secrets
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: secret-reader
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["database-credentials", "api-keys"]
    verbs: ["get"]
    # Note: 'list' on secrets returns secret metadata but NOT values in older K8s
    # In K8s 1.27+, even list/watch may require explicit allowance
---
# Bind both roles to the service account
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payment-service-config-access
  namespace: production
subjects:
  - kind: ServiceAccount
    name: payment-service
    namespace: production
roleRef:
  kind: Role
  name: configmap-reader
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: payment-service-secret-access
  namespace: production
subjects:
  - kind: ServiceAccount
    name: payment-service
    namespace: production
roleRef:
  kind: Role
  name: secret-reader
  apiGroup: rbac.authorization.k8s.io
```

## Section 9: Audit and Compliance

### Detecting Secret Value Access in Audit Logs

```bash
#!/bin/bash
# audit-secret-access.sh
# Parse Kubernetes audit logs to identify who is accessing secret values

# Secret access appears in audit logs as 'get' on secrets resources
# with the specific secret name
AUDIT_LOG_PATH="/var/log/kubernetes/audit.log"

echo "=== Secret Access Audit Report ==="
echo "Time range: last 24 hours"
echo ""

# Parse JSON audit logs (requires jq)
cat "${AUDIT_LOG_PATH}" | \
  jq -r 'select(
    .objectRef.resource == "secrets" and
    .verb == "get" and
    .responseStatus.code == 200
  ) | [
    .requestReceivedTimestamp,
    .user.username,
    .objectRef.namespace,
    .objectRef.name,
    .sourceIPs[0]
  ] | @tsv' \
  | sort \
  | awk -F'\t' '{
    printf "%-30s %-40s %-20s %-30s %s\n", $1, $2, $3, $4, $5
  }'
```

### Encrypting Secrets at Rest

```yaml
# etcd-encryption-config.yaml
# Apply this EncryptionConfiguration to the kube-apiserver
# to encrypt secrets stored in etcd
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
    providers:
      # AES-GCM encryption — recommended for new deployments
      - aescbc:
          keys:
            - name: key1
              # 32-byte key, base64-encoded
              # Generate: head -c 32 /dev/urandom | base64
              secret: "PLACEHOLDER_BASE64_ENCODED_32_BYTE_KEY"
      # identity provider as fallback for unencrypted secrets created before
      # encryption was enabled (migration period only — remove after migration)
      - identity: {}
```

## Section 10: ConfigMap and Secret Troubleshooting

```bash
#!/bin/bash
# troubleshoot-configmap-secret.sh
# Diagnose common ConfigMap and Secret mounting issues

NAMESPACE="${1:?Usage: $0 <namespace> <pod-name>}"
POD_NAME="${2:?Usage: $0 <namespace> <pod-name>}"

echo "=== Diagnosing ${POD_NAME} in ${NAMESPACE} ==="

# 1. Check pod events for volume mounting errors
echo ""
echo "--- Pod Events ---"
kubectl get events \
  --namespace="${NAMESPACE}" \
  --field-selector="involvedObject.name=${POD_NAME}" \
  --sort-by='.lastTimestamp' \
  | tail -20

# 2. List all volumes defined in the pod spec
echo ""
echo "--- Volumes Defined ---"
kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{range .spec.volumes[*]}{.name}{"\t"}{.configMap.name}{"\t"}{.secret.secretName}{"\n"}{end}' \
  | column -t -s $'\t' -N "VOLUME,CONFIGMAP,SECRET"

# 3. Verify referenced ConfigMaps exist
echo ""
echo "--- ConfigMap Existence Check ---"
kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.volumes[*].configMap.name}' \
  | tr ' ' '\n' \
  | while read CM; do
    if [[ -n "${CM}" ]]; then
      kubectl get configmap "${CM}" -n "${NAMESPACE}" > /dev/null 2>&1 \
        && echo "  ConfigMap '${CM}': EXISTS" \
        || echo "  ConfigMap '${CM}': MISSING (this will cause pod to remain Pending)"
    fi
  done

# 4. Verify referenced Secrets exist
echo ""
echo "--- Secret Existence Check ---"
kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" \
  -o jsonpath='{.spec.volumes[*].secret.secretName}' \
  | tr ' ' '\n' \
  | while read SEC; do
    if [[ -n "${SEC}" ]]; then
      kubectl get secret "${SEC}" -n "${NAMESPACE}" > /dev/null 2>&1 \
        && echo "  Secret '${SEC}': EXISTS" \
        || echo "  Secret '${SEC}': MISSING (this will cause pod to remain Pending)"
    fi
  done

# 5. Check what is actually mounted in the container
echo ""
echo "--- Mounted Volume Contents ---"
kubectl exec "${POD_NAME}" -n "${NAMESPACE}" -- \
  find /etc /run /var/run -name "*.conf" -o -name "*.yaml" -o -name "*.env" \
  2>/dev/null | head -30
```

## Summary

ConfigMap and Secret management in production Kubernetes requires deliberate choices at each decision point:

**Immutability** eliminates the overhead of watching unchanged resources and prevents partial update observations during rolling changes. The versioned naming pattern (`service-config-v1-4-2`) makes the current configuration version explicit in deployment specifications.

**Projected volumes** consolidate multiple configuration sources into a single mount point, reducing pod spec complexity and enabling bound service account tokens with audience and expiry constraints—a significant security improvement over long-lived service account JWTs.

**subPath mounting limitations** are a common source of confusion: volumes mounted via `subPath` do not receive live updates. For applications requiring hot configuration reloads, either avoid `subPath` (mount the whole directory) or use the Stakater Reloader to trigger pod restarts when configuration changes.

**RBAC at the resource level** constrains secret access to explicitly named secrets, preventing a compromised service account from reading all secrets in a namespace. Combined with etcd encryption at rest and audit logging, this provides defense-in-depth for sensitive configuration data.
