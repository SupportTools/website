---
title: "HashiCorp Vault Dynamic Secrets for Kubernetes: Database Credentials On-Demand"
date: 2030-05-24T00:00:00-05:00
draft: false
tags: ["HashiCorp Vault", "Kubernetes", "Dynamic Secrets", "PostgreSQL", "MySQL", "MongoDB", "Security", "Secrets Management"]
categories:
- Kubernetes
- Security
- HashiCorp Vault
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Vault dynamic secrets for PostgreSQL, MySQL, and MongoDB in Kubernetes: Vault Agent injection, CSI secrets store driver, lease renewal, credential rotation, and audit logging."
more_link: "yes"
url: "/hashicorp-vault-dynamic-secrets-kubernetes-database-credentials/"
---

Managing database credentials in Kubernetes presents one of the most persistent security challenges in cloud-native infrastructure. Static credentials embedded in ConfigMaps, Secrets, or environment variables create long-lived attack surfaces that expand risk surface area across every environment. HashiCorp Vault's dynamic secrets engine transforms this problem by generating unique, short-lived credentials on demand—credentials that expire automatically, never reuse across requests, and leave a complete audit trail from creation to revocation.

This guide covers production-grade Vault dynamic secrets integration for PostgreSQL, MySQL, and MongoDB running in Kubernetes, including both the Vault Agent Injector and the Secrets Store CSI Driver delivery mechanisms.

<!--more-->

## Architecture Overview

Vault's dynamic secrets for databases operate through a broker pattern. When an application requests database credentials, Vault connects to the target database using a privileged management account, creates a new user with constrained permissions, returns the credentials to the requester, and stores a lease that controls credential lifetime. When the lease expires—or when the application renews it—Vault revokes the credentials and removes the database user.

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Kubernetes Pod │────▶│   Vault Server   │────▶│  PostgreSQL DB   │
│  (App + Agent)  │◀────│  Dynamic Secrets │◀────│  (Managed Creds) │
└─────────────────┘     └──────────────────┘     └──────────────────┘
       │                        │
       │ Vault Token            │ Audit Log
       │ (ServiceAccount)       ▼
       ▼               ┌──────────────────┐
  Mounted Secrets      │   Audit Backend  │
  /vault/secrets/      │   (S3/Syslog)    │
                       └──────────────────┘
```

This architecture delivers several properties that static secrets cannot:

- **Blast radius containment**: A compromised credential is valid for minutes or hours, not months or years
- **Per-application isolation**: Each pod receives unique credentials—lateral movement requires compromising Vault itself
- **Automatic revocation**: Pod deletion, service restart, or lease non-renewal triggers immediate credential cleanup
- **Complete accountability**: Every credential issuance links to a Kubernetes ServiceAccount, namespace, and workload identity

## Prerequisites and Vault Setup

### Vault Installation via Helm

Production Vault deployments on Kubernetes use the official Helm chart with HA configuration backed by an integrated Raft storage cluster.

```yaml
# vault-values.yaml
server:
  ha:
    enabled: true
    replicas: 3
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = true

        listener "tcp" {
          tls_disable = 1
          address = "[::]:8200"
          cluster_address = "[::]:8201"
          telemetry {
            unauthenticated_metrics_access = true
          }
        }

        storage "raft" {
          path = "/vault/data"
          retry_join {
            leader_api_addr = "http://vault-0.vault-internal:8200"
          }
          retry_join {
            leader_api_addr = "http://vault-1.vault-internal:8200"
          }
          retry_join {
            leader_api_addr = "http://vault-2.vault-internal:8200"
          }
          autopilot {
            cleanup_dead_servers         = "true"
            last_contact_threshold       = "200ms"
            last_contact_failure_threshold = "10m"
            max_trailing_logs            = 250000
            min_quorum                   = 3
            server_stabilization_time    = "10s"
          }
        }

        service_registration "kubernetes" {}

  affinity: |
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: vault
              app.kubernetes.io/instance: vault
              component: server
          topologyKey: kubernetes.io/hostname

  resources:
    requests:
      memory: 256Mi
      cpu: 250m
    limits:
      memory: 512Mi
      cpu: 500m

  dataStorage:
    enabled: true
    size: 10Gi
    storageClass: fast-ssd

  auditStorage:
    enabled: true
    size: 10Gi
    storageClass: fast-ssd

injector:
  enabled: true
  replicas: 2
  resources:
    requests:
      memory: 64Mi
      cpu: 50m
    limits:
      memory: 128Mi
      cpu: 250m

csi:
  enabled: true
```

```bash
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

kubectl create namespace vault

helm install vault hashicorp/vault \
  --namespace vault \
  --values vault-values.yaml \
  --version 0.27.0

# Initialize and unseal (production uses auto-unseal via KMS)
kubectl exec -n vault vault-0 -- vault operator init \
  -key-shares=5 \
  -key-threshold=3 \
  -format=json > vault-init.json

# Store init output in a secure location (AWS Secrets Manager, GCP Secret Manager, etc.)
# Never store vault-init.json in version control
```

### Kubernetes Authentication Method

Vault's Kubernetes auth method uses ServiceAccount tokens to authenticate workloads. The auth method validates tokens against the Kubernetes API server.

```bash
# Enable Kubernetes auth method
vault auth enable kubernetes

# Configure with in-cluster discovery
vault write auth/kubernetes/config \
  kubernetes_host="https://${KUBERNETES_PORT_443_TCP_ADDR}:443" \
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
  kubernetes_ca_cert="$(cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt)" \
  issuer="https://kubernetes.default.svc.cluster.local"
```

For external Vault instances (not running inside the cluster), use explicit API server addresses:

```bash
vault write auth/kubernetes/config \
  kubernetes_host="https://k8s-api.internal.example.com:6443" \
  kubernetes_ca_cert=@/path/to/ca.crt \
  disable_iss_validation=true
```

## PostgreSQL Dynamic Secrets

### Database Engine Configuration

The database secrets engine requires a privileged connection to create and revoke database users. This management account should have `CREATEROLE` and the ability to grant the permissions defined in the creation statement.

```bash
# Enable the database secrets engine
vault secrets enable -path=database database

# Configure PostgreSQL connection
vault write database/config/postgres-prod \
  plugin_name=postgresql-database-plugin \
  allowed_roles="app-readonly,app-readwrite,app-admin" \
  connection_url="postgresql://{{username}}:{{password}}@postgres-primary.databases.svc.cluster.local:5432/appdb?sslmode=require" \
  username="vault_manager" \
  password="<vault-manager-password>" \
  max_open_connections=5 \
  max_idle_connections=5 \
  max_connection_lifetime=300

# Rotate the management credentials immediately so Vault owns them
vault write -force database/rotate-root/postgres-prod
```

### Role Definitions

Roles define SQL statements executed when credentials are created and revoked. Use parameterized templates with `{{name}}`, `{{password}}`, and `{{expiration}}` placeholders.

```bash
# Read-only role — typical for reporting services
vault write database/roles/app-readonly \
  db_name=postgres-prod \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
    GRANT CONNECT ON DATABASE appdb TO \"{{name}}\";
    GRANT USAGE ON SCHEMA public TO \"{{name}}\";
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO \"{{name}}\";
  " \
  revocation_statements="
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM \"{{name}}\";
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM \"{{name}}\";
    REVOKE USAGE ON SCHEMA public FROM \"{{name}}\";
    REVOKE CONNECT ON DATABASE appdb FROM \"{{name}}\";
    DROP ROLE IF EXISTS \"{{name}}\";
  " \
  default_ttl=1h \
  max_ttl=24h

# Read-write role — application services
vault write database/roles/app-readwrite \
  db_name=postgres-prod \
  creation_statements="
    CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';
    GRANT CONNECT ON DATABASE appdb TO \"{{name}}\";
    GRANT USAGE ON SCHEMA public TO \"{{name}}\";
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO \"{{name}}\";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"{{name}}\";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO \"{{name}}\";
  " \
  revocation_statements="
    REASSIGN OWNED BY \"{{name}}\" TO vault_manager;
    DROP OWNED BY \"{{name}}\";
    DROP ROLE IF EXISTS \"{{name}}\";
  " \
  default_ttl=1h \
  max_ttl=24h
```

### Vault Policies

Policies grant access to specific secret paths. Define minimal-privilege policies scoped to each application.

```hcl
# policy-app-backend.hcl
path "database/creds/app-readwrite" {
  capabilities = ["read"]
}

path "sys/leases/renew" {
  capabilities = ["update"]
}

path "sys/leases/lookup" {
  capabilities = ["update"]
}

# Allow the token to look up itself
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
```

```bash
vault policy write app-backend policy-app-backend.hcl

# Create Kubernetes auth role binding the policy to a ServiceAccount
vault write auth/kubernetes/role/app-backend \
  bound_service_account_names=app-backend \
  bound_service_account_namespaces=production \
  policies=app-backend \
  ttl=1h \
  max_ttl=24h
```

## Vault Agent Injector Patterns

The Vault Agent Injector watches for pod annotations and mutates pod specs to include a Vault Agent sidecar. The agent authenticates to Vault, fetches secrets, and writes them to a shared volume as files or rendered templates.

### Kubernetes ServiceAccount Setup

```yaml
# serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-backend
  namespace: production
  annotations:
    vault.hashicorp.com/agent-inject: "true"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: app-backend-tokenreview
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:auth-delegator
subjects:
  - kind: ServiceAccount
    name: app-backend
    namespace: production
```

### Deployment with Agent Injection Annotations

```yaml
# deployment-app-backend.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-backend
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: app-backend
  template:
    metadata:
      labels:
        app: app-backend
      annotations:
        # Core injection annotations
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "app-backend"
        vault.hashicorp.com/agent-pre-populate-only: "false"

        # PostgreSQL credentials
        vault.hashicorp.com/agent-inject-secret-db-creds: "database/creds/app-readwrite"
        vault.hashicorp.com/agent-inject-template-db-creds: |
          {{- with secret "database/creds/app-readwrite" -}}
          export DB_USERNAME="{{ .Data.username }}"
          export DB_PASSWORD="{{ .Data.password }}"
          export DB_HOST="postgres-primary.databases.svc.cluster.local"
          export DB_PORT="5432"
          export DB_NAME="appdb"
          export DB_DSN="postgresql://{{ .Data.username }}:{{ .Data.password }}@postgres-primary.databases.svc.cluster.local:5432/appdb?sslmode=require"
          {{- end }}

        # Agent configuration
        vault.hashicorp.com/agent-limits-cpu: "250m"
        vault.hashicorp.com/agent-limits-mem: "128Mi"
        vault.hashicorp.com/agent-requests-cpu: "25m"
        vault.hashicorp.com/agent-requests-mem: "64Mi"

        # Lease renewal configuration
        vault.hashicorp.com/agent-cache-enable: "true"
        vault.hashicorp.com/agent-cache-use-auto-auth-token: "true"

        # Vault address (override if not using in-cluster Vault)
        vault.hashicorp.com/agent-inject-status: "update"

    spec:
      serviceAccountName: app-backend
      containers:
        - name: app-backend
          image: registry.internal.example.com/app-backend:v1.4.2
          command: ["/bin/sh", "-c"]
          args:
            - |
              source /vault/secrets/db-creds
              exec /app/server
          ports:
            - containerPort: 8080
          resources:
            requests:
              memory: 256Mi
              cpu: 100m
            limits:
              memory: 512Mi
              cpu: 500m
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
```

### Template Rendering for Multiple Secret Formats

Applications often need credentials in specific formats. Vault Agent templates support Go templating for any output format.

```yaml
# JDBC connection string format
vault.hashicorp.com/agent-inject-template-jdbc: |
  {{- with secret "database/creds/app-readwrite" -}}
  jdbc:postgresql://postgres-primary.databases.svc.cluster.local:5432/appdb?user={{ .Data.username }}&password={{ .Data.password }}&ssl=true
  {{- end }}

# JSON format for applications that parse config files
vault.hashicorp.com/agent-inject-template-config-json: |
  {{- with secret "database/creds/app-readwrite" -}}
  {
    "database": {
      "host": "postgres-primary.databases.svc.cluster.local",
      "port": 5432,
      "name": "appdb",
      "username": "{{ .Data.username }}",
      "password": "{{ .Data.password }}",
      "ssl_mode": "require",
      "max_connections": 25,
      "connection_timeout": 30
    }
  }
  {{- end }}

# .pgpass format
vault.hashicorp.com/agent-inject-template-pgpass: |
  {{- with secret "database/creds/app-readwrite" -}}
  postgres-primary.databases.svc.cluster.local:5432:appdb:{{ .Data.username }}:{{ .Data.password }}
  {{- end }}
```

## Secrets Store CSI Driver Integration

The Secrets Store CSI Driver provides an alternative delivery mechanism that mounts Vault secrets as volumes without requiring a sidecar. This approach works better for applications that cannot be modified to use environment variables and need secrets available as files at a specific path.

### CSI Driver Installation

```bash
helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm repo update

helm install csi-secrets-store secrets-store-csi-driver/secrets-store-csi-driver \
  --namespace kube-system \
  --set syncSecret.enabled=true \
  --set enableSecretRotation=true \
  --set rotationPollInterval=2m
```

### SecretProviderClass for PostgreSQL

```yaml
# secret-provider-class-postgres.yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: postgres-dynamic-creds
  namespace: production
spec:
  provider: vault
  parameters:
    vaultAddress: "http://vault.vault.svc.cluster.local:8200"
    roleName: "app-backend"
    objects: |
      - objectName: "db-username"
        secretPath: "database/creds/app-readwrite"
        secretKey: "username"
      - objectName: "db-password"
        secretPath: "database/creds/app-readwrite"
        secretKey: "password"

  # Sync to Kubernetes Secret for legacy applications
  secretObjects:
    - secretName: postgres-app-creds
      type: Opaque
      data:
        - objectName: db-username
          key: username
        - objectName: db-password
          key: password
```

### Pod Volume Mount Configuration

```yaml
# deployment-csi-example.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-legacy
  namespace: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app-legacy
  template:
    metadata:
      labels:
        app: app-legacy
    spec:
      serviceAccountName: app-backend
      volumes:
        - name: vault-db-creds
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: postgres-dynamic-creds
      containers:
        - name: app-legacy
          image: registry.internal.example.com/app-legacy:v2.1.0
          volumeMounts:
            - name: vault-db-creds
              mountPath: /run/secrets/database
              readOnly: true
          env:
            # Reference synced Kubernetes Secret
            - name: DB_USERNAME
              valueFrom:
                secretKeyRef:
                  name: postgres-app-creds
                  key: username
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: postgres-app-creds
                  key: password
```

## MySQL Dynamic Secrets

MySQL configuration follows the same pattern with MySQL-specific SQL statements.

```bash
# Configure MySQL connection
vault write database/config/mysql-prod \
  plugin_name=mysql-database-plugin \
  allowed_roles="mysql-app,mysql-migration" \
  connection_url="{{username}}:{{password}}@tcp(mysql-primary.databases.svc.cluster.local:3306)/appdb" \
  username="vault_manager" \
  password="<vault-manager-password>" \
  max_open_connections=5 \
  max_idle_connections=5 \
  max_connection_lifetime=300

vault write -force database/rotate-root/mysql-prod

# MySQL role definition
vault write database/roles/mysql-app \
  db_name=mysql-prod \
  creation_statements="
    CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}';
    GRANT SELECT, INSERT, UPDATE, DELETE ON appdb.* TO '{{name}}'@'%';
  " \
  revocation_statements="
    REVOKE ALL PRIVILEGES, GRANT OPTION FROM '{{name}}'@'%';
    DROP USER '{{name}}'@'%';
  " \
  rollback_statements="
    DROP USER IF EXISTS '{{name}}'@'%';
  " \
  default_ttl=1h \
  max_ttl=24h
```

### MySQL-Specific Connection Validation

```bash
# Test MySQL dynamic credentials manually
vault read database/creds/mysql-app

# Expected output:
# Key                Value
# ---                -----
# lease_id           database/creds/mysql-app/uAbKVpzLMKQJ5N7U4dBV8uIS
# lease_duration     1h
# lease_renewable    true
# password           A1a-RaNd0mPassw0rd
# username           v-kubernet-mysql-app-pQx7HmAq3SZDu
```

## MongoDB Dynamic Secrets

MongoDB authentication uses the `admin` database for user management. The configuration differs slightly from relational databases.

```bash
# Enable MongoDB plugin (requires MongoDB 3.6+)
vault write database/config/mongodb-prod \
  plugin_name=mongodb-database-plugin \
  allowed_roles="mongo-app,mongo-reporting" \
  connection_url="mongodb://{{username}}:{{password}}@mongodb-0.mongodb.databases.svc.cluster.local:27017,mongodb-1.mongodb.databases.svc.cluster.local:27017,mongodb-2.mongodb.databases.svc.cluster.local:27017/admin?replicaSet=rs0&ssl=true" \
  username="vault_manager" \
  password="<vault-manager-password>"

vault write -force database/rotate-root/mongodb-prod

# MongoDB role with specific database and collection permissions
vault write database/roles/mongo-app \
  db_name=mongodb-prod \
  creation_statements='{ "db": "appdb", "roles": [{"role": "readWrite", "db": "appdb"}, {"role": "read", "db": "appdb_audit"}] }' \
  revocation_statements='{ "db": "admin" }' \
  default_ttl=1h \
  max_ttl=24h
```

### MongoDB Atlas Integration

For teams using MongoDB Atlas, the Atlas database plugin uses the Atlas API instead of direct database connections.

```bash
vault write database/config/mongodb-atlas \
  plugin_name=mongodbatlas-database-plugin \
  allowed_roles="atlas-app" \
  public_key="<atlas-public-api-key>" \
  private_key="<atlas-private-api-key>" \
  project_id="<atlas-project-id>"

vault write database/roles/atlas-app \
  db_name=mongodb-atlas \
  creation_statements='{ "databaseName": "appdb", "roles": [{"databaseName": "appdb", "roleName": "readWrite"}] }' \
  default_ttl=1h \
  max_ttl=24h
```

## Lease Management and Renewal

### Understanding Lease Lifecycle

Every dynamic credential issuance creates a lease with a `lease_id`, `lease_duration`, and `renewable` status. The Vault Agent handles renewal automatically, but understanding the lifecycle matters for troubleshooting.

```bash
# List all active leases for the database path
vault list sys/leases/lookup/database/creds/app-readwrite

# Inspect a specific lease
vault write sys/leases/lookup \
  lease_id="database/creds/app-readwrite/uAbKVpzLMKQJ5N7U4dBV8uIS"

# Expected output:
# Key             Value
# ---             -----
# expire_time     2030-05-24T14:32:10.123456789Z
# id              database/creds/app-readwrite/uAbKVpzLMKQJ5N7U4dBV8uIS
# issue_time      2030-05-24T13:32:10.123456789Z
# last_renewal    <nil>
# renewable       true
# ttl             59m48s

# Manual lease renewal
vault write sys/leases/renew \
  lease_id="database/creds/app-readwrite/uAbKVpzLMKQJ5N7U4dBV8uIS" \
  increment=3600

# Revoke a specific lease (triggers database user deletion)
vault lease revoke database/creds/app-readwrite/uAbKVpzLMKQJ5N7U4dBV8uIS

# Revoke all leases for a path (emergency credential rotation)
vault lease revoke -prefix database/creds/app-readwrite
```

### Vault Agent Renewal Configuration

The Vault Agent's auto-auth and caching configuration controls how aggressively it renews leases.

```hcl
# vault-agent-config.hcl (used by the injector, not directly authored)
auto_auth {
  method "kubernetes" {
    mount_path = "auth/kubernetes"
    config = {
      role = "app-backend"
    }
  }

  sink "file" {
    config = {
      path = "/home/vault/.vault-token"
    }
  }
}

cache {
  use_auto_auth_token = true
}

template_config {
  static_secret_render_interval = "5m"
  exit_on_retry_failure         = true
}

template {
  source      = "/vault/templates/db-creds.tmpl"
  destination = "/vault/secrets/db-creds"
  perms       = 0400
  command     = "/bin/sh -c 'kill -HUP $(cat /tmp/app.pid)'"
}
```

### Credential Rotation Strategies

Production systems require coordinated credential rotation. The following patterns handle rotation without application downtime.

```yaml
# vault-rotation-policy.hcl
# Allow applications to renew their own leases
path "sys/leases/renew" {
  capabilities = ["update"]
}

# Allow reading current lease information
path "sys/leases/lookup" {
  capabilities = ["update"]
}

# Allow renewing the auth token itself
path "auth/token/renew-self" {
  capabilities = ["update"]
}
```

For applications that cannot tolerate credential rotation mid-request, use the `max_ttl` to force rotation at pod restart rather than in-place:

```bash
# Short TTL forces rotation at pod restart boundary
vault write database/roles/app-readwrite-short \
  db_name=postgres-prod \
  creation_statements="..." \
  default_ttl=8h \
  max_ttl=8h  # Non-renewable; rotation happens at pod restart
```

## Audit Logging Configuration

Vault's audit backends provide the complete chain of custody for every secret access. Production deployments require at minimum two audit backends for redundancy—Vault will block operations if all audit backends fail.

### File Audit Backend

```bash
# Enable file audit (writes to the audit storage volume)
vault audit enable file file_path=/vault/audit/vault_audit.log

# Verify audit is working
vault audit list -detailed

# Expected output:
# Path     Type    Replicated    Description    Options
# ----     ----    ----------    -----------    -------
# file/    file    true                         file_path=/vault/audit/vault_audit.log
```

### Syslog Audit Backend

```bash
# Enable syslog backend for centralized log aggregation
vault audit enable syslog tag="vault" facility="AUTH"
```

### Parsing Audit Logs for Database Operations

```bash
# Tail audit log and filter for database credential requests
tail -f /vault/audit/vault_audit.log | \
  jq 'select(.request.path | startswith("database/creds/"))'

# Example audit entry:
# {
#   "time": "2030-05-24T13:32:10.123Z",
#   "type": "response",
#   "auth": {
#     "client_token": "hmac-sha256:...",
#     "accessor": "hmac-sha256:...",
#     "display_name": "kubernetes-production-app-backend",
#     "policies": ["default", "app-backend"],
#     "metadata": {
#       "role": "app-backend",
#       "service_account_name": "app-backend",
#       "service_account_namespace": "production"
#     }
#   },
#   "request": {
#     "id": "8a7f3d21-...",
#     "operation": "read",
#     "path": "database/creds/app-readwrite"
#   },
#   "response": {
#     "data": {
#       "lease_id": "hmac-sha256:...",
#       "username": "hmac-sha256:..."
#     }
#   }
# }
```

### Audit Log Shipping with Fluentd

```yaml
# fluentd-vault-audit.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-vault-config
  namespace: vault
data:
  fluent.conf: |
    <source>
      @type tail
      path /vault/audit/vault_audit.log
      pos_file /var/log/fluentd-vault.pos
      tag vault.audit
      <parse>
        @type json
      </parse>
    </source>

    <filter vault.audit>
      @type record_transformer
      <record>
        cluster "production-us-east-1"
        environment "production"
      </record>
    </filter>

    <match vault.audit>
      @type elasticsearch
      host elasticsearch.monitoring.svc.cluster.local
      port 9200
      index_name vault-audit-%Y.%m.%d
      include_timestamp true
      <buffer>
        @type file
        path /var/log/fluentd-vault-buffer
        flush_interval 10s
        retry_max_interval 30s
        retry_forever false
        retry_max_times 5
      </buffer>
    </match>
```

## Production Hardening

### Network Policies

Restrict which pods can reach the Vault API server.

```yaml
# network-policy-vault.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: vault-access
  namespace: vault
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: vault
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              vault-access: "true"
      ports:
        - protocol: TCP
          port: 8200
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: vault
      ports:
        - protocol: TCP
          port: 8201  # Raft cluster port
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-vault-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      vault.hashicorp.com/agent-inject: "true"
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: vault
      ports:
        - protocol: TCP
          port: 8200
```

### Vault Sentinel Policies (Enterprise)

For Vault Enterprise, Sentinel policies provide fine-grained, attribute-based access control:

```python
# policy-time-restricted.sentinel
# Only allow credential issuance during business hours
import "time"

main = rule {
  time.now.weekday not in [0, 6] and
  time.now.hour >= 6 and
  time.now.hour <= 22
}
```

### Alert Rules for Vault Health

```yaml
# prometheus-vault-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vault-alerts
  namespace: monitoring
spec:
  groups:
    - name: vault.rules
      interval: 30s
      rules:
        - alert: VaultSealed
          expr: vault_core_unsealed == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Vault instance is sealed"
            description: "Vault instance {{ $labels.instance }} has been sealed for more than 1 minute"

        - alert: VaultLeaseCountHigh
          expr: vault_expire_num_leases > 50000
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High Vault lease count"
            description: "Vault has {{ $value }} active leases, which may indicate a lease accumulation issue"

        - alert: VaultDatabaseConnectionFailed
          expr: increase(vault_database_verifyConnection_error[5m]) > 3
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Vault cannot connect to database"
            description: "Vault has failed to verify database connection {{ $value }} times in the last 5 minutes"

        - alert: VaultTokenExpiringSoon
          expr: vault_token_count_by_ttl{creation_ttl=~".*"} > 0 and vault_token_count_by_ttl{creation_ttl="1h"} / vault_token_count > 0.8
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High proportion of short-lived tokens"
```

## Troubleshooting Common Issues

### Credential Revocation Failures

When Vault cannot revoke database credentials (e.g., the database is unreachable), leases enter a pending revocation state. Monitor and handle these:

```bash
# List leases pending revocation
vault list sys/leases/lookup/database/creds/app-readwrite

# Force revoke even if database is unreachable (use with caution)
vault lease revoke -force database/creds/app-readwrite/uAbKVpzLMKQJ5N7U4dBV8uIS

# Check for orphaned database users (run directly against PostgreSQL)
psql -U postgres -c "
  SELECT usename, valuntil
  FROM pg_user
  WHERE usename LIKE 'v-%'
  ORDER BY valuntil;
"
```

### Agent Injection Not Working

```bash
# Verify the injector webhook is registered
kubectl get mutatingwebhookconfigurations vault-agent-injector-cfg

# Check injector logs
kubectl logs -n vault -l app.kubernetes.io/name=vault-agent-injector --tail=50

# Verify pod annotations are parsed correctly
kubectl describe pod -n production <pod-name> | grep -A 20 "Annotations:"

# Common issue: namespace not labeled for injection
kubectl label namespace production vault-injection=enabled
```

### Permission Denied Errors

```bash
# Verify the Kubernetes auth role binding
vault read auth/kubernetes/role/app-backend

# Test authentication manually from within a pod
kubectl exec -n production <pod-name> -c vault-agent -- \
  vault write auth/kubernetes/login \
    role=app-backend \
    jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"

# Trace policy evaluation
vault token capabilities <token> database/creds/app-readwrite
```

## Summary

HashiCorp Vault dynamic secrets eliminate the static credential problem at its source. By generating unique, short-lived credentials for every workload, teams achieve the audit accountability and blast-radius containment that static secrets cannot provide. The combination of Vault Agent injection for standard workloads and the CSI Driver for legacy applications covers the full spectrum of Kubernetes deployment patterns.

The key operational practices covered in this guide—lease management, credential rotation without downtime, audit log shipping, and network policy hardening—form the foundation of a production-ready secrets management program that satisfies compliance requirements while remaining operationally sustainable.
