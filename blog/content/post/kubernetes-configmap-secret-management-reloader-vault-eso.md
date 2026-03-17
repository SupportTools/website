---
title: "Kubernetes ConfigMap and Secret Management: Reloader, Vault Agent, and ESO Patterns"
date: 2030-02-16T00:00:00-05:00
draft: false
tags: ["Kubernetes", "ConfigMap", "Secrets", "HashiCorp Vault", "External Secrets Operator", "Reloader", "Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes configuration and secret management covering Reloader for automated rollouts, Vault Agent sidecar injection, External Secrets Operator synchronization, and zero-downtime secret rotation strategies."
more_link: "yes"
url: "/kubernetes-configmap-secret-management-reloader-vault-eso/"
---

Configuration and secret management in Kubernetes clusters is deceptively complex. The primitive resources — ConfigMap and Secret — are straightforward, but building a production-grade system that handles secret rotation without pod restarts, propagates configuration changes automatically, and integrates with enterprise secret managers requires composing several tools correctly. This guide covers the three most important patterns in 2030: Reloader for automatic rollout triggering, Vault Agent for dynamic secrets, and External Secrets Operator for synchronizing from cloud secret managers.

<!--more-->

## The Core Problem: Config and Secret Drift

The default Kubernetes behavior is to mount ConfigMaps and Secrets into pods at startup. If you update the ConfigMap or Secret, the volume contents eventually update (within `kubelet`'s sync period, typically 60–90 seconds), but the application rarely picks up the change automatically. Most applications read configuration at startup and never re-read it. The result is configuration drift: the running application is out of sync with what Kubernetes thinks it is running.

Three distinct problems require three distinct solutions:

1. **Rollout triggering**: When a ConfigMap or Secret changes, trigger a rolling restart of the pods that consume it. This is Reloader's job.
2. **Dynamic secrets from a vault**: Inject short-lived secrets (database credentials, TLS certificates, tokens) that are generated on-demand and rotated automatically. This is Vault Agent's job.
3. **Secret synchronization from cloud providers**: Mirror secrets from AWS Secrets Manager, GCP Secret Manager, or Azure Key Vault into Kubernetes Secrets. This is External Secrets Operator's job.

## Reloader: Automatic Rolling Restarts

### What Reloader Does

Reloader (github.com/stakater/Reloader) watches ConfigMap and Secret resources for changes and triggers a rolling restart of any Deployment, DaemonSet, or StatefulSet that references the changed resource. It eliminates the operational burden of manually triggering rollouts after configuration changes.

### Installing Reloader

```bash
# Install via Helm
helm repo add stakater https://stakater.github.io/stakater-charts
helm repo update

helm install reloader stakater/reloader \
  --namespace reloader-system \
  --create-namespace \
  --set reloader.watchGlobally=true \
  --set reloader.ignoreSecrets=false \
  --set reloader.ignoreConfigMaps=false \
  --set reloader.reloadStrategy=annotations \
  --set reloader.logFormat=json \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=128Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=512Mi \
  --set podMonitor.enabled=true
```

### Annotation-Based Configuration

Reloader uses annotations to control which resources trigger a restart for which workload:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  annotations:
    # Reload when ANY change occurs to these resources
    reloader.stakater.com/auto: "true"

    # Reload only when specific ConfigMaps change
    configmap.reloader.stakater.com/reload: "api-config,database-config"

    # Reload only when specific Secrets change
    secret.reloader.stakater.com/reload: "api-tls,database-credentials"

    # Search mode: reload when any ConfigMap/Secret mounted
    # by this deployment changes (auto-discovery)
    reloader.stakater.com/search: "true"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
    spec:
      containers:
      - name: api
        image: registry.example.com/api:1.0.0
        envFrom:
        - configMapRef:
            name: api-config
        - secretRef:
            name: database-credentials
        volumeMounts:
        - name: tls-certs
          mountPath: /etc/tls
          readOnly: true
      volumes:
      - name: tls-certs
        secret:
          secretName: api-tls
```

### Reloader with StatefulSets

For StatefulSets, Reloader performs an ordered rolling restart, respecting the StatefulSet's update strategy:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: database-proxy
  annotations:
    # Trigger rolling restart when the proxy config changes
    configmap.reloader.stakater.com/reload: "proxy-config"
    # Control update strategy via the StatefulSet spec
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0  # Update all pods
  selector:
    matchLabels:
      app: database-proxy
  template:
    metadata:
      labels:
        app: database-proxy
    spec:
      containers:
      - name: proxy
        image: registry.example.com/db-proxy:2.0.0
        volumeMounts:
        - name: proxy-config
          mountPath: /etc/proxy
          readOnly: true
      volumes:
      - name: proxy-config
        configMap:
          name: proxy-config
```

### Validating Reloader Behavior

```bash
# Watch Reloader events
kubectl get events -n reloader-system --watch

# Verify Reloader is processing changes
kubectl logs -n reloader-system deployment/reloader -f | \
  grep -E "(Updated|Triggered|Reload)"

# Simulate a config change and observe restart
kubectl patch configmap api-config \
  --patch '{"data": {"version": "2"}}'

# Verify pods were restarted
kubectl rollout status deployment/api-server
kubectl get pods -l app=api-server -o wide
```

## Vault Agent: Dynamic Secrets Injection

### Architecture

HashiCorp Vault Agent runs as an init container and sidecar in application pods, authenticating to Vault and rendering secret templates into files or environment variables. The agent handles:

- Authentication via Kubernetes service account token (Vault's Kubernetes auth method)
- Secret lease renewal before expiry
- Template rendering for complex secret formats
- Re-rendering when secrets rotate (optionally triggering a pod restart via a command exec)

### Vault Kubernetes Auth Setup

```bash
# Enable Kubernetes auth method in Vault
vault auth enable kubernetes

# Configure with the cluster's API server details
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"

# Create a policy for the application
vault policy write api-server-policy - <<'EOF'
# Read database credentials
path "database/creds/api-server-role" {
  capabilities = ["read"]
}

# Read TLS certificates
path "pki/issue/api-server" {
  capabilities = ["create", "update"]
}

# Read static secrets
path "secret/data/api-server/*" {
  capabilities = ["read"]
}
EOF

# Create a Kubernetes auth role binding the SA to the policy
vault write auth/kubernetes/role/api-server-role \
  bound_service_account_names=api-server \
  bound_service_account_namespaces=production \
  policies=api-server-policy \
  ttl=1h
```

### Vault Agent Injector Annotations

The Vault Agent Injector (part of the Vault Helm chart) uses pod annotations to inject the init container and sidecar:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: production
spec:
  selector:
    matchLabels:
      app: api-server
  template:
    metadata:
      labels:
        app: api-server
      annotations:
        # Enable injection
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "api-server-role"

        # Agent resource limits
        vault.hashicorp.com/agent-requests-cpu: "50m"
        vault.hashicorp.com/agent-requests-mem: "64Mi"
        vault.hashicorp.com/agent-limits-cpu: "200m"
        vault.hashicorp.com/agent-limits-mem: "128Mi"

        # Inject database credentials as a rendered template
        vault.hashicorp.com/agent-inject-secret-db-creds: >
          database/creds/api-server-role
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/api-server-role" -}}
          export DB_USERNAME="{{ .Data.username }}"
          export DB_PASSWORD="{{ .Data.password }}"
          export DB_HOST="postgres.production.svc.cluster.local"
          export DB_NAME="api"
          export DATABASE_URL="postgres://{{ .Data.username }}:{{ .Data.password }}@postgres.production.svc.cluster.local:5432/api?sslmode=require"
          {{- end }}

        # Inject TLS certificate as PEM files
        vault.hashicorp.com/agent-inject-secret-tls-cert: >
          pki/issue/api-server
        vault.hashicorp.com/agent-inject-template-tls-cert: |
          {{- with secret "pki/issue/api-server" "common_name=api.example.com" "ttl=24h" -}}
          {{ .Data.certificate }}
          {{ .Data.issuing_ca }}
          {{- end }}
        vault.hashicorp.com/agent-inject-secret-tls-key: >
          pki/issue/api-server
        vault.hashicorp.com/agent-inject-template-tls-key: |
          {{- with secret "pki/issue/api-server" "common_name=api.example.com" "ttl=24h" -}}
          {{ .Data.private_key }}
          {{- end }}

        # Pre-populate the files before the app container starts
        vault.hashicorp.com/agent-init-first: "true"

        # Re-run a command when secrets are renewed
        vault.hashicorp.com/agent-inject-command-db-creds: >
          /bin/sh -c "kill -HUP $(cat /var/run/app.pid)"
    spec:
      serviceAccountName: api-server
      containers:
      - name: api
        image: registry.example.com/api:1.0.0
        command:
        - /bin/sh
        - -c
        - |
          # Source the Vault-rendered environment file
          source /vault/secrets/db-creds
          # Start the application
          exec /app/server
        volumeMounts:
        - name: tls
          mountPath: /etc/tls
```

### Manual Vault Agent Configuration

For workloads that cannot use the injector (e.g., when the mutating webhook is unavailable during cluster bootstrap), configure Vault Agent as a sidecar directly:

```yaml
# vault-agent-config.yaml ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: vault-agent-config
  namespace: production
data:
  config.hcl: |
    vault {
      address = "https://vault.vault.svc.cluster.local:8200"
      ca_cert = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    }

    auto_auth {
      method "kubernetes" {
        mount_path = "auth/kubernetes"
        config {
          role = "api-server-role"
        }
      }

      sink "file" {
        config {
          path = "/home/vault/.vault-token"
        }
      }
    }

    template {
      source      = "/vault/templates/db-creds.ctmpl"
      destination = "/vault/secrets/db-creds"
      perms       = 0640
      command     = "kill -HUP $(cat /var/run/app.pid) 2>/dev/null || true"
    }

    template_config {
      static_secret_render_interval = "5m"
      exit_on_retry_failure         = true
    }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: vault-agent-templates
  namespace: production
data:
  db-creds.ctmpl: |
    {{- with secret "database/creds/api-server-role" -}}
    export DB_USERNAME="{{ .Data.username }}"
    export DB_PASSWORD="{{ .Data.password }}"
    {{- end }}
```

## External Secrets Operator: Cloud Secret Synchronization

### Architecture

External Secrets Operator (ESO) reconciles secrets from external providers (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, HashiCorp Vault, 1Password, and many others) into Kubernetes Secrets. It provides a declarative, GitOps-friendly interface for managing secret synchronization without storing secret values in the cluster's etcd.

### Installation

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets-system \
  --create-namespace \
  --set installCRDs=true \
  --set replicaCount=2 \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=256Mi \
  --set resources.limits.cpu=500m \
  --set resources.limits.memory=512Mi \
  --set serviceMonitor.enabled=true \
  --set metrics.service.enabled=true
```

### ClusterSecretStore: AWS Secrets Manager

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
      # Use IRSA (IAM Roles for Service Accounts) — no static credentials
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets-system
```

```bash
# Create the IAM policy
cat > /tmp/eso-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:ListSecretVersionIds"
      ],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:production/*"
      ]
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name ExternalSecretsPolicy \
  --policy-document file:///tmp/eso-policy.json

# Annotate the service account with the IAM role ARN
kubectl annotate serviceaccount external-secrets-sa \
  -n external-secrets-system \
  eks.amazonaws.com/role-arn=arn:aws:iam::123456789012:role/ExternalSecretsRole
```

### ExternalSecret: Basic Synchronization

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: database-credentials
  namespace: production
spec:
  # Sync interval: how often ESO checks for updates
  refreshInterval: 1h

  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore

  target:
    name: database-credentials    # name of the resulting Kubernetes Secret
    creationPolicy: Owner          # ESO owns and manages the Secret lifecycle
    deletionPolicy: Retain         # retain the Secret if the ExternalSecret is deleted
    template:
      # Add additional annotations/labels to the created Secret
      metadata:
        annotations:
          managed-by: external-secrets-operator
      # Transform the secret data before creating the Kubernetes Secret
      type: Opaque
      data:
        # Map AWS secret key to Kubernetes Secret key
        DB_HOST: "{{ .db_host }}"
        DB_PORT: "{{ .db_port }}"
        DB_NAME: "{{ .db_name }}"
        DB_USERNAME: "{{ .db_username }}"
        DB_PASSWORD: "{{ .db_password }}"
        DATABASE_URL: >
          postgres://{{ .db_username }}:{{ .db_password }}@{{ .db_host }}:{{ .db_port }}/{{ .db_name }}?sslmode=require

  data:
  - secretKey: db_host
    remoteRef:
      key: production/api-server/database
      property: host
  - secretKey: db_port
    remoteRef:
      key: production/api-server/database
      property: port
  - secretKey: db_name
    remoteRef:
      key: production/api-server/database
      property: database
  - secretKey: db_username
    remoteRef:
      key: production/api-server/database
      property: username
  - secretKey: db_password
    remoteRef:
      key: production/api-server/database
      property: password
```

### ExternalSecret: Whole Secret Extraction

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: api-tls-cert
  namespace: production
spec:
  refreshInterval: 6h

  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore

  target:
    name: api-tls-cert
    creationPolicy: Owner
    template:
      type: kubernetes.io/tls

  # Extract the entire secret as JSON and map specific fields
  dataFrom:
  - extract:
      key: production/api-server/tls
      conversionStrategy: Default
      decodingStrategy: Base64
    rewrite:
    - regexp:
        source: "(.+)"
        target: "tls_$1"
```

### SecretStore for HashiCorp Vault

```yaml
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: vault-backend
  namespace: production
spec:
  provider:
    vault:
      server: "https://vault.vault.svc.cluster.local:8200"
      path: "secret"
      version: "v2"
      # caBundle: base64-encoded Vault CA certificate
      # Retrieve with: kubectl get secret vault-tls -n vault -o jsonpath='{.data.ca\.crt}' | base64 -d
      caBundle: "<base64-encoded-vault-ca-certificate>"
      auth:
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets-role"
          serviceAccountRef:
            name: external-secrets-sa
```

### ClusterExternalSecret: Multi-Namespace Propagation

When the same secret must be available in multiple namespaces:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterExternalSecret
metadata:
  name: shared-tls-cert
spec:
  # Sync to all namespaces matching this selector
  namespaceSelector:
    matchLabels:
      environment: production

  # Or list specific namespaces
  # namespaces:
  # - production
  # - staging

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
        key: production/wildcard-cert
        property: certificate
    - secretKey: tls.key
      remoteRef:
        key: production/wildcard-cert
        property: private_key
```

### PushSecret: Writing Kubernetes Secrets to External Providers

ESO also supports pushing Kubernetes Secrets back to external providers, enabling bidirectional synchronization:

```yaml
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: push-db-credentials
  namespace: production
spec:
  refreshInterval: 10m
  secretStoreRefs:
  - name: aws-secrets-manager
    kind: ClusterSecretStore

  selector:
    secret:
      name: generated-db-password

  data:
  - match:
      secretKey: password
      remoteRef:
        remoteKey: production/generated/db-password
        property: password
```

## Secret Rotation Without Pod Restarts

### The Volume Mount Update Approach

Kubernetes automatically updates Secret-backed volumes within `kubelet`'s `--sync-frequency` period (default 60s). Applications that re-read files on SIGHUP or inotify can receive rotated secrets without a pod restart:

```go
// pkg/config/watcher.go
package config

import (
    "context"
    "log/slog"
    "os"
    "path/filepath"
    "sync"

    "github.com/fsnotify/fsnotify"
)

// SecretWatcher monitors a directory of secret files and calls
// reload when any file changes.
type SecretWatcher struct {
    dir     string
    reload  func() error
    watcher *fsnotify.Watcher
    mu      sync.RWMutex
}

func NewSecretWatcher(secretDir string, reload func() error) (*SecretWatcher, error) {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, err
    }

    // Watch the directory rather than individual files.
    // Kubernetes updates secrets via symlinks in a staging directory
    // and then atomically replaces the ..data symlink.
    // Watching the directory catches this atomic replacement.
    if err := watcher.Add(secretDir); err != nil {
        watcher.Close()
        return nil, err
    }

    return &SecretWatcher{
        dir:     secretDir,
        reload:  reload,
        watcher: watcher,
    }, nil
}

func (sw *SecretWatcher) Run(ctx context.Context) error {
    defer sw.watcher.Close()

    for {
        select {
        case <-ctx.Done():
            return nil
        case event, ok := <-sw.watcher.Events:
            if !ok {
                return nil
            }
            // Kubernetes rotates secrets by replacing the ..data symlink.
            // Detect the rename event on the symlink.
            if filepath.Base(event.Name) == "..data" &&
                event.Op&fsnotify.Create != 0 {
                slog.Info("Detected secret rotation",
                    "path", event.Name)
                if err := sw.reload(); err != nil {
                    slog.Error("Secret reload failed",
                        "error", err)
                    // Continue running — do not exit on reload failure
                }
            }
        case err, ok := <-sw.watcher.Errors:
            if !ok {
                return nil
            }
            slog.Error("fsnotify error", "error", err)
        }
    }
}
```

### Combining Reloader with ESO for Zero-Downtime Rotation

The recommended pattern for applications that cannot hot-reload secrets:

1. ESO syncs the updated secret from AWS Secrets Manager into a Kubernetes Secret
2. Reloader detects the Secret update and triggers a rolling restart
3. The rolling restart respects the Deployment's `maxUnavailable` and `maxSurge` settings

```yaml
# The Deployment annotated for both patterns
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  annotations:
    # Reloader: restart when this Secret changes
    secret.reloader.stakater.com/reload: "database-credentials,api-tls-cert"
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0     # Never reduce capacity during rotation
      maxSurge: 1           # Allow one extra pod during rotation
  template:
    spec:
      # Enough time for the old pods to drain connections
      terminationGracePeriodSeconds: 60
      containers:
      - name: api
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]  # Allow LB to drain
```

## Monitoring and Alerting

```yaml
# PrometheusRule for ESO health
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: external-secrets-alerts
  namespace: monitoring
spec:
  groups:
  - name: external-secrets
    rules:
    # Alert if any ExternalSecret has failed to sync
    - alert: ExternalSecretSyncFailed
      expr: |
        externalsecret_status_condition{type="Ready",status="False"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "ExternalSecret {{ $labels.name }} in {{ $labels.namespace }} failed to sync"
        description: "The ExternalSecret has not been successfully synchronized for 5 minutes."
        runbook: "https://runbooks.support.tools/external-secrets/sync-failed"

    # Alert if sync is lagging (older than 2x the refresh interval)
    - alert: ExternalSecretSyncStale
      expr: |
        (time() - externalsecret_sync_calls_total_last_success_time) > 7200
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "ExternalSecret {{ $labels.name }} sync is stale"

  - name: reloader
    rules:
    - alert: ReloaderNotRunning
      expr: |
        absent(up{job="reloader"}) == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Reloader is not running"
        description: "Config changes will not automatically trigger pod restarts"
```

## Key Takeaways

Production secret management in Kubernetes requires three complementary tools working in concert.

Reloader solves the rollout trigger problem cleanly: annotate your Deployments and StatefulSets, and configuration changes automatically propagate through rolling restarts. It requires no application changes and works with any ConfigMap or Secret.

Vault Agent is the right tool for dynamic, short-lived secrets: database credentials, PKI certificates, and API tokens that must rotate automatically before expiry. The Kubernetes auth method eliminates static credentials entirely, and the agent's template engine handles complex secret format requirements.

External Secrets Operator bridges the gap between enterprise secret management systems and Kubernetes. It enables GitOps workflows where secret definitions are stored in version control without storing actual secret values, while the actual credentials remain exclusively in the external secret store.

The combination of these three tools with a well-designed rotation strategy achieves the production gold standard: secrets rotate automatically, applications receive updated credentials without manual intervention, and no secret value ever touches a git repository.
