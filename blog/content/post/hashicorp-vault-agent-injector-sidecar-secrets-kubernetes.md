---
title: "HashiCorp Vault Agent Injector: Sidecar Secrets Management for Kubernetes"
date: 2028-12-27T00:00:00-05:00
draft: false
tags: ["HashiCorp Vault", "Kubernetes", "Secrets Management", "Security", "Sidecar", "PKI"]
categories:
- Security
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide to the HashiCorp Vault Agent Injector, covering Kubernetes auth configuration, secret rendering with templates, dynamic database credentials, PKI certificates, and agent lifecycle management."
more_link: "yes"
url: "/hashicorp-vault-agent-injector-sidecar-secrets-kubernetes/"
---

The Vault Agent Injector transforms how Kubernetes workloads access secrets: rather than requiring applications to implement Vault's API client, make authenticated calls, handle token renewal, and manage lease expiration, the injector handles all of that via a sidecar container. Applications read secrets from the filesystem as rendered files, exactly like they read any other configuration. The injector uses a mutating admission webhook to automatically add the Vault agent sidecar and init container to annotated pods, making secrets management a deployment-level concern rather than an application-level one.

<!--more-->

## Architecture Overview

The Vault Agent Injector consists of three components:

1. **Injector Service**: A Kubernetes Deployment running the mutating admission webhook. When a pod is created with `vault.hashicorp.com/agent-inject: "true"`, the injector mutates the pod spec to add the Vault agent sidecar and init container.

2. **Vault Agent Init Container**: Runs before the application container, authenticates to Vault, fetches all annotated secrets, renders them to shared volumes, and exits. This ensures secrets are available before the application starts.

3. **Vault Agent Sidecar**: Continues running alongside the application, renewing tokens, refreshing dynamic secrets before they expire, and re-rendering templates when secret values change.

```
Pod Mutation Flow:
─────────────────
API Server → MutatingAdmissionWebhook → Injector
                                            │
                                            ▼
                         Pod spec gets vault-agent-init added
                         Pod spec gets vault-agent sidecar added
                         Shared volume /vault/secrets added

Pod Startup:
────────────
vault-agent-init → Authenticates to Vault (Kubernetes JWT)
                 → Fetches secrets
                 → Renders templates to /vault/secrets/
                 → Exits 0

app-container   → Reads /vault/secrets/config.env

vault-agent     → Renews token every 30s
                 → Re-fetches dynamic creds before expiry
                 → Rewrites rendered files when values change
```

## Vault Installation and Configuration

```bash
# Install Vault with Helm
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

helm upgrade --install vault hashicorp/vault \
  --namespace vault \
  --create-namespace \
  --values vault-values.yaml \
  --version 0.28.0
```

```yaml
# vault-values.yaml
global:
  enabled: true
  tlsDisable: false

injector:
  enabled: true
  replicas: 2
  image:
    repository: hashicorp/vault-k8s
    tag: "1.4.2"
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 250m
      memory: 256Mi
  affinity: |
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: vault-agent-injector
        topologyKey: kubernetes.io/hostname
  failurePolicy: Ignore   # Don't block pod creation if injector is unavailable

server:
  enabled: true
  replicas: 3
  image:
    repository: hashicorp/vault
    tag: "1.17.3"
  ha:
    enabled: true
    replicas: 3
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = true
        listener "tcp" {
          address = "[::]:8200"
          cluster_address = "[::]:8201"
          tls_cert_file = "/vault/userconfig/vault-ha-tls/vault.crt"
          tls_key_file = "/vault/userconfig/vault-ha-tls/vault.key"
          tls_client_ca_file = "/vault/userconfig/vault-ha-tls/vault.ca"
        }
        storage "raft" {
          path = "/vault/data"
          retry_join {
            leader_api_addr = "https://vault-0.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-ha-tls/vault.ca"
          }
          retry_join {
            leader_api_addr = "https://vault-1.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-ha-tls/vault.ca"
          }
          retry_join {
            leader_api_addr = "https://vault-2.vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-ha-tls/vault.ca"
          }
        }
        service_registration "kubernetes" {}

  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 2000m
      memory: 2Gi

  dataStorage:
    storageClass: gp3-encrypted
    size: 20Gi

  auditStorage:
    enabled: true
    storageClass: gp3-encrypted
    size: 10Gi
```

## Kubernetes Auth Method Configuration

```bash
# Enable the Kubernetes auth method in Vault
vault auth enable kubernetes

# Configure the Kubernetes auth method
# Vault needs to verify the service account JWT tokens that pods present
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443" \
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt \
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
  issuer="https://kubernetes.default.svc.cluster.local"

# Create a policy for the production application
vault policy write production-app - <<EOF
# Read application secrets
path "secret/data/production/app/*" {
  capabilities = ["read"]
}

# Read database credentials (dynamic secrets)
path "database/creds/production-app-role" {
  capabilities = ["read"]
}

# Read PKI certificates
path "pki_int/issue/production-app" {
  capabilities = ["create", "update"]
}

# Renew tokens
path "auth/token/renew-self" {
  capabilities = ["update"]
}

# Look up own token
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
EOF

# Create a Kubernetes auth role that maps a service account to a Vault policy
vault write auth/kubernetes/role/production-app \
  bound_service_account_names=production-app \
  bound_service_account_namespaces=production \
  policies=production-app \
  ttl=1h \
  max_ttl=24h
```

## Writing Secrets to Vault

```bash
# Enable KV v2 secrets engine
vault secrets enable -path=secret kv-v2

# Write application configuration secrets
vault kv put secret/production/app/config \
  database_url="postgres://appuser:$(openssl rand -base64 32)@postgres.production.svc.cluster.local:5432/appdb?sslmode=verify-full" \
  redis_url="redis://redis.production.svc.cluster.local:6379/0" \
  jwt_signing_key="$(openssl rand -base64 64)" \
  api_key="sk-prod-$(openssl rand -hex 32)"

vault kv put secret/production/app/third-party \
  stripe_secret_key="sk_live_..." \
  sendgrid_api_key="SG...." \
  datadog_api_key="..."
```

## Pod Annotations for Injection

### Basic Secret Injection

```yaml
# deployment-with-vault-annotations.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
      annotations:
        # Enable injection
        vault.hashicorp.com/agent-inject: "true"

        # Vault address
        vault.hashicorp.com/address: "https://vault.vault.svc.cluster.local:8200"

        # Role for Kubernetes auth
        vault.hashicorp.com/role: "production-app"

        # TLS verification
        vault.hashicorp.com/tls-secret: "vault-ca-cert"
        vault.hashicorp.com/ca-cert: "/vault/tls/ca.crt"

        # Secret 1: Application config — write as environment file
        vault.hashicorp.com/agent-inject-secret-app-config: "secret/data/production/app/config"
        vault.hashicorp.com/agent-inject-template-app-config: |
          {{- with secret "secret/data/production/app/config" -}}
          export DATABASE_URL="{{ .Data.data.database_url }}"
          export REDIS_URL="{{ .Data.data.redis_url }}"
          export JWT_SIGNING_KEY="{{ .Data.data.jwt_signing_key }}"
          {{- end }}

        # Secret 2: Third-party credentials — write as properties file
        vault.hashicorp.com/agent-inject-secret-third-party: "secret/data/production/app/third-party"
        vault.hashicorp.com/agent-inject-template-third-party: |
          {{- with secret "secret/data/production/app/third-party" -}}
          STRIPE_SECRET_KEY={{ .Data.data.stripe_secret_key }}
          SENDGRID_API_KEY={{ .Data.data.sendgrid_api_key }}
          DATADOG_API_KEY={{ .Data.data.datadog_api_key }}
          {{- end }}

        # Agent resource limits
        vault.hashicorp.com/agent-limits-cpu: "100m"
        vault.hashicorp.com/agent-limits-mem: "64Mi"
        vault.hashicorp.com/agent-requests-cpu: "50m"
        vault.hashicorp.com/agent-requests-mem: "32Mi"

        # Pre-populate before app starts, keep renewing
        vault.hashicorp.com/agent-pre-populate: "true"
        vault.hashicorp.com/agent-pre-populate-only: "false"
    spec:
      serviceAccountName: production-app
      containers:
      - name: api-service
        image: api-service:2.4.1
        command:
        - /bin/sh
        - -c
        - |
          # Source the rendered secret file before starting the app
          source /vault/secrets/app-config
          exec /app/api-service
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
```

## Dynamic Database Credentials

Dynamic credentials are the killer feature of Vault for database access — short-lived usernames and passwords generated on demand:

```bash
# Configure Vault database secrets engine
vault secrets enable database

# Configure PostgreSQL connection
vault write database/config/production-postgres \
  plugin_name=postgresql-database-plugin \
  allowed_roles="production-app-role" \
  connection_url="postgresql://vault:$(vault-db-password)@postgres.production.svc.cluster.local:5432/appdb?sslmode=verify-full" \
  username="vault" \
  password="$(openssl rand -base64 32)" \
  root_rotation_statements="ALTER USER \"{{username}}\" WITH PASSWORD '{{password}}';"

# Create a role that generates credentials
vault write database/roles/production-app-role \
  db_name=production-postgres \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"{{name}}\";
  " \
  revocation_statements="
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM \"{{name}}\";
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM \"{{name}}\";
    DROP ROLE IF EXISTS \"{{name}}\";
  " \
  default_ttl="1h" \
  max_ttl="24h"

# Test dynamic credential generation
vault read database/creds/production-app-role
# Key                Value
# ---                -----
# lease_id           database/creds/production-app-role/AbCdEfGh...
# lease_duration     1h
# lease_renewable    true
# password           A1B2-C3D4-E5F6-G7H8
# username           v-kubernetes-production-AbCdEfGh
```

### Annotation for Dynamic Credentials

```yaml
annotations:
  vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/production-app-role"
  vault.hashicorp.com/agent-inject-template-db-creds: |
    {{- with secret "database/creds/production-app-role" -}}
    DB_USERNAME="{{ .Data.username }}"
    DB_PASSWORD="{{ .Data.password }}"
    DB_URL="postgres://{{ .Data.username }}:{{ .Data.password }}@postgres.production.svc.cluster.local:5432/appdb?sslmode=verify-full"
    {{- end }}

  # Render changes to a command (signal app to reload database connection)
  vault.hashicorp.com/agent-inject-command-db-creds: "kill -SIGHUP $(cat /tmp/app.pid)"
```

## PKI Certificate Injection

Vault's PKI secrets engine enables automatic TLS certificate provisioning with short TTLs:

```bash
# Set up intermediate CA
vault secrets enable -path=pki_int pki
vault secrets tune -max-lease-ttl=43800h pki_int

# Generate intermediate CSR
vault write -format=json pki_int/intermediate/generate/internal \
  common_name="production.support.tools Intermediate CA" \
  issuer_name="production-intermediate" | \
  jq -r '.data.csr' > pki_int.csr

# Sign the CSR with root CA (out of band or via another Vault PKI mount)
# vault write -format=json pki/root/sign-intermediate ...

# Create a role for issuing certificates to the application
vault write pki_int/roles/production-app \
  issuer_ref="production-intermediate" \
  allowed_domains="production.svc.cluster.local,support.tools" \
  allow_subdomains=true \
  allow_bare_domains=false \
  max_ttl="72h" \
  ttl="24h" \
  key_type="ec" \
  key_bits=256 \
  require_cn=false \
  server_flag=true \
  client_flag=true
```

```yaml
# PKI certificate annotation
annotations:
  vault.hashicorp.com/agent-inject-secret-tls-cert: "pki_int/issue/production-app"
  vault.hashicorp.com/agent-inject-template-tls-cert: |
    {{- with pkiCert "pki_int/issue/production-app" "common_name=api-service.production.svc.cluster.local" "ttl=24h" -}}
    {{ .Cert }}
    {{ .CA }}
    {{ .Key }}
    {{- end }}

  vault.hashicorp.com/agent-inject-secret-tls-key: "pki_int/issue/production-app"
  vault.hashicorp.com/agent-inject-template-tls-key: |
    {{- with pkiCert "pki_int/issue/production-app" "common_name=api-service.production.svc.cluster.local" -}}
    {{ .Key }}
    {{- end }}
```

## ServiceAccount Configuration

```yaml
# service-account.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: production-app
  namespace: production
  annotations:
    # Optional: bind to a specific Vault role (informational)
    vault.hashicorp.com/role: "production-app"
automountServiceAccountToken: true
---
# RBAC for the service account (application permissions, not Vault-related)
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: production-app
  namespace: production
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: production-app
  namespace: production
subjects:
- kind: ServiceAccount
  name: production-app
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: production-app
```

## Vault Agent ConfigMap for Advanced Scenarios

For complex secret rendering or pre-population of many secrets, provide a full Vault agent config:

```yaml
# vault-agent-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vault-agent-config
  namespace: production
data:
  config.hcl: |
    vault {
      address = "https://vault.vault.svc.cluster.local:8200"
      tls_ca_file = "/vault/tls/ca.crt"
      retry {
        num_retries = 5
      }
    }

    auto_auth {
      method "kubernetes" {
        mount_path = "auth/kubernetes"
        config = {
          role = "production-app"
          token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
        }
      }
      sink "file" {
        config = {
          path = "/home/vault/.vault-token"
          mode = 0400
        }
      }
    }

    cache {
      use_auto_auth_token = true
    }

    listener "unix" {
      address = "/alloc/tmp/.vault.sock"
      tls_disable = true
      socket_mode = "0600"
      socket_user = "1000"
    }

    template_config {
      static_secret_render_interval = "30s"
      exit_on_retry_failure = true
      max_connections_per_host = 95
    }

    template {
      source = "/vault/template/config.ctmpl"
      destination = "/vault/secrets/app.env"
      perms = 0400
      command = "kill -HUP $(pidof api-service) || true"
      backup = true
    }

    template {
      source = "/vault/template/db.ctmpl"
      destination = "/vault/secrets/db.env"
      perms = 0400
      error_on_missing_key = true
    }
```

## Debugging Injection Issues

```bash
# Verify injector is running and webhook is registered
kubectl get pods -n vault -l app.kubernetes.io/name=vault-agent-injector
kubectl get mutatingwebhookconfigurations vault-agent-injector-cfg

# Check injector logs for admission decisions
kubectl logs -n vault -l app.kubernetes.io/name=vault-agent-injector \
  --tail=50 | grep -E "handler|inject|error"

# Check what annotations the injector sees
kubectl get pod api-service-7d9f8b -n production -o json | \
  jq '.metadata.annotations | to_entries[] | select(.key | startswith("vault"))'

# Check vault-agent-init logs for auth failures
kubectl logs api-service-7d9f8b -n production -c vault-agent-init
# Look for: "Successfully authenticated to Vault" or "Error authenticating"

# Check vault-agent sidecar logs for renewal
kubectl logs api-service-7d9f8b -n production -c vault-agent
# Look for: "Renewed token" or "template rendered"

# Verify secrets were rendered
kubectl exec -n production api-service-7d9f8b -c api-service -- \
  ls -la /vault/secrets/
# -r-------- 1 vault vault  482 Dec 27 10:32 app-config
# -r-------- 1 vault vault  218 Dec 27 10:32 db-creds

# Test Vault authentication from within a pod
kubectl exec -n production api-service-7d9f8b -c api-service -- \
  vault login -method=kubernetes \
  role=production-app \
  jwt=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
```

## Audit Logging for Secret Access

```bash
# Enable audit logging in Vault
vault audit enable file file_path=/vault/audit/audit.log

# In production, use a structured log shipper (Fluent Bit → Elasticsearch)
# Query access logs for a specific secret path
grep '"path":"secret/data/production/app/config"' \
  /vault/audit/audit.log | \
  jq '{time: .time, operation: .request.operation,
       entity: .auth.entity_id,
       remote_addr: .request.remote_address}'
```

The Vault Agent Injector pattern provides Kubernetes workloads with transparent access to dynamic, short-lived secrets without requiring Vault SDK integration in application code. Combined with dynamic database credentials, PKI automation, and the sidecar renewal model, it establishes a security posture where secrets are never long-lived, never stored in etcd, and always accessed via cryptographically verified Kubernetes identity.
