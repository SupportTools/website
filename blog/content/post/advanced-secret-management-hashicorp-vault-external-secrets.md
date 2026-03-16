---
title: "Advanced Secret Management with HashiCorp Vault and External Secrets: Enterprise Security Framework 2026"
date: 2026-04-15T00:00:00-05:00
draft: false
tags: ["Secret Management", "HashiCorp Vault", "External Secrets", "Kubernetes Security", "DevSecOps", "Security Automation", "Credential Management", "Enterprise Security", "Zero Trust", "Encryption", "PKI", "Compliance", "Security Policies", "Access Control", "Secret Rotation"]
categories:
- Security
- Secret Management
- DevSecOps
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced secret management with HashiCorp Vault and External Secrets for enterprise environments. Comprehensive guide to secure credential management, automated secret rotation, and enterprise-grade security frameworks."
more_link: "yes"
url: "/advanced-secret-management-hashicorp-vault-external-secrets/"
---

Advanced secret management represents a critical foundation of enterprise security architecture, requiring sophisticated approaches to credential storage, rotation, and access control that integrate seamlessly with modern cloud-native applications and infrastructure. This comprehensive guide explores enterprise HashiCorp Vault implementations, External Secrets Operator integration, and production-ready security frameworks for managing sensitive data at scale.

<!--more-->

# [Enterprise Secret Management Architecture](#enterprise-secret-management-architecture)

## Comprehensive Security Framework

Modern secret management requires zero-trust security models that provide granular access control, automated credential rotation, and comprehensive audit capabilities while maintaining high availability and performance across distributed systems.

### Advanced Secret Management Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│              Enterprise Secret Management Platform              │
├─────────────────┬─────────────────┬─────────────────┬───────────┤
│   Secret        │   Authentication│   Authorization │   Audit   │
│   Storage       │   & Identity    │   & Policies    │   & Compliance│
├─────────────────┼─────────────────┼─────────────────┼───────────┤
│ ┌─────────────┐ │ ┌─────────────┐ │ ┌─────────────┐ │ ┌───────┐ │
│ │ Vault       │ │ │ OIDC/LDAP   │ │ │ RBAC        │ │ │ Audit │ │
│ │ KV Store    │ │ │ K8s Auth    │ │ │ Policies    │ │ │ Logs  │ │
│ │ PKI         │ │ │ AWS Auth    │ │ │ Namespaces  │ │ │ SIEM  │ │
│ │ Database    │ │ │ TLS Certs   │ │ │ Paths       │ │ │ Alerts│ │
│ └─────────────┘ │ └─────────────┘ │ └─────────────┘ │ └───────┘ │
│                 │                 │                 │           │
│ • Encryption    │ • Multi-factor  │ • Fine-grained  │ • Compliance│
│ • Versioning    │ • Dynamic       │ • Time-bound    │ • Monitoring│
│ • Replication   │ • Short-lived   │ • Conditional   │ • Forensics│
└─────────────────┴─────────────────┴─────────────────┴───────────┘
```

### HashiCorp Vault Enterprise Configuration

```hcl
# vault-enterprise-config.hcl
# Advanced Vault configuration for enterprise deployment

# Storage backend with high availability
storage "consul" {
  address = "consul.vault.svc.cluster.local:8500"
  path    = "vault/"
  service = "vault"
  
  # HA configuration
  ha_enabled = "true"
  
  # TLS configuration
  scheme = "https"
  tls_cert_file = "/vault/tls/consul-client.pem"
  tls_key_file  = "/vault/tls/consul-client-key.pem"
  tls_ca_file   = "/vault/tls/consul-ca.pem"
  
  # Performance tuning
  max_parallel = "128"
  check_timeout = "5s"
  consistency_mode = "strong"
}

# Alternative storage: Integrated Raft for cloud environments
storage "raft" {
  path = "/vault/data"
  node_id = "vault-${VAULT_NODE_ID}"
  
  # Raft cluster configuration
  retry_join {
    leader_api_addr = "https://vault-0.vault.vault.svc.cluster.local:8200"
    leader_ca_cert_file = "/vault/tls/vault-ca.pem"
    leader_client_cert_file = "/vault/tls/vault-client.pem"
    leader_client_key_file = "/vault/tls/vault-client-key.pem"
  }
  
  retry_join {
    leader_api_addr = "https://vault-1.vault.vault.svc.cluster.local:8200"
    leader_ca_cert_file = "/vault/tls/vault-ca.pem"
    leader_client_cert_file = "/vault/tls/vault-client.pem"
    leader_client_key_file = "/vault/tls/vault-client-key.pem"
  }
  
  retry_join {
    leader_api_addr = "https://vault-2.vault.vault.svc.cluster.local:8200"
    leader_ca_cert_file = "/vault/tls/vault-ca.pem"
    leader_client_cert_file = "/vault/tls/vault-client.pem"
    leader_client_key_file = "/vault/tls/vault-client-key.pem"
  }
}

# HTTP listener with TLS
listener "tcp" {
  address       = "0.0.0.0:8200"
  tls_cert_file = "/vault/tls/vault-server.pem"
  tls_key_file  = "/vault/tls/vault-server-key.pem"
  tls_client_ca_file = "/vault/tls/vault-ca.pem"
  
  # TLS configuration
  tls_min_version = "tls12"
  tls_cipher_suites = "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"
  tls_prefer_server_cipher_suites = "true"
  tls_require_and_verify_client_cert = "false"
  
  # Security headers
  x_forwarded_for_authorized_addrs = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  x_forwarded_for_hop_skips = "1"
  x_forwarded_for_reject_not_authorized = "true"
  
  # Performance and limits
  max_request_size = 33554432
  max_request_duration = "90s"
}

# Cluster listener for HA
listener "tcp" {
  address         = "0.0.0.0:8201"
  cluster_address = "0.0.0.0:8201"
  tls_cert_file   = "/vault/tls/vault-server.pem"
  tls_key_file    = "/vault/tls/vault-server-key.pem"
  tls_client_ca_file = "/vault/tls/vault-ca.pem"
}

# Telemetry and monitoring
telemetry {
  prometheus_retention_time = "24h"
  disable_hostname = true
  
  # StatsD configuration
  statsd_address = "statsd.monitoring.svc.cluster.local:8125"
  
  # DogStatsD configuration
  dogstatsd_addr = "datadog-agent.monitoring.svc.cluster.local:8125"
  dogstatsd_tags = ["environment:production", "service:vault"]
}

# Enterprise license
license_path = "/vault/license/vault.hclic"

# Seal configuration - Auto-unseal with AWS KMS
seal "awskms" {
  region     = "us-west-2"
  kms_key_id = "arn:aws:kms:us-west-2:123456789012:key/12345678-1234-1234-1234-123456789012"
  endpoint   = "https://kms.us-west-2.amazonaws.com"
}

# Alternative seal - Azure Key Vault
seal "azurekeyvault" {
  client_id      = "12345678-1234-1234-1234-123456789012"
  client_secret  = "abcd1234"
  tenant_id      = "12345678-1234-1234-1234-123456789012"
  vault_name     = "vault-enterprise-seal"
  key_name       = "vault-seal-key"
  environment    = "AzurePublicCloud"
}

# Enterprise features
api_addr = "https://vault.company.com:8200"
cluster_addr = "https://vault-internal.company.com:8201"
cluster_name = "vault-production-cluster"

# Caching and performance
cache_size = "32768"
disable_cache = false
disable_mlock = false

# UI and API configuration
ui = true
raw_storage_endpoint = false
introspection_endpoint = false
disable_sealwrap = false
disable_indexing = false
disable_sentinel_trace = false

# Log configuration
log_level = "INFO"
log_format = "json"
log_file = "/vault/logs/vault.log"
log_rotate_bytes = 104857600
log_rotate_duration = "24h"
log_rotate_max_files = 10

# Default lease TTL
default_lease_ttl = "24h"
max_lease_ttl = "720h"

# Plugin directory
plugin_directory = "/vault/plugins"
```

### Kubernetes External Secrets Operator Configuration

```yaml
# external-secrets-operator.yaml
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: vault-backend
  namespace: external-secrets-system
spec:
  provider:
    vault:
      server: "https://vault.vault.svc.cluster.local:8200"
      path: "secret"
      version: "v2"
      namespace: "production"
      
      # Authentication methods
      auth:
        # Kubernetes service account authentication
        kubernetes:
          mountPath: "kubernetes"
          role: "external-secrets-operator"
          serviceAccountRef:
            name: "external-secrets-operator"
            namespace: "external-secrets-system"
        
        # Alternative: JWT authentication
        jwt:
          path: "jwt"
          role: "external-secrets"
          secretRef:
            name: "vault-jwt-token"
            key: "token"
        
        # Alternative: AppRole authentication
        appRole:
          path: "approle"
          roleId: "external-secrets-role-id"
          secretRef:
            name: "vault-approle-secret"
            key: "secret-id"
      
      # TLS configuration
      tls:
        serverName: "vault.vault.svc.cluster.local"
        caBundle: |
          -----BEGIN CERTIFICATE-----
          MIIDXTCCAkWgAwIBAgIJAKL0UG5jKUyxMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV
          BAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBX
          aWRnaXRzIFB0eSBMdGQwHhcNMjEwMjE0MDUxNTE4WhcNMjIwMjE0MDUxNTE4WjBF
          -----END CERTIFICATE-----
        
        # Client certificate authentication
        clientCert:
          secretRef:
            name: "vault-client-cert"
            key: "tls.crt"
        clientKey:
          secretRef:
            name: "vault-client-cert"
            key: "tls.key"
      
      # Connection settings
      timeout: "30s"
      readYourWrites: true
      forwardInconsistent: false
---
# External secret for application credentials
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: application-secrets
  namespace: production
  labels:
    app: web-application
    environment: production
spec:
  refreshInterval: "300s"
  
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  
  target:
    name: application-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
    
    template:
      type: Opaque
      metadata:
        labels:
          app: web-application
          managed-by: external-secrets
        annotations:
          external-secrets.io/refresh-interval: "300s"
      
      data:
        # Database credentials
        DATABASE_URL: "postgresql://{{ .database_username }}:{{ .database_password }}@{{ .database_host }}:{{ .database_port }}/{{ .database_name }}"
        
        # API keys
        API_KEY: "{{ .api_key }}"
        WEBHOOK_SECRET: "{{ .webhook_secret }}"
        
        # TLS certificates
        TLS_CERT: "{{ .tls_cert | base64decode }}"
        TLS_KEY: "{{ .tls_key | base64decode }}"
        
        # Custom configuration
        CONFIG_JSON: |
          {
            "database": {
              "host": "{{ .database_host }}",
              "port": {{ .database_port }},
              "username": "{{ .database_username }}",
              "password": "{{ .database_password }}",
              "name": "{{ .database_name }}",
              "ssl_mode": "require"
            },
            "redis": {
              "url": "redis://{{ .redis_password }}@{{ .redis_host }}:{{ .redis_port }}/0"
            },
            "external_apis": {
              "payment_gateway": {
                "api_key": "{{ .payment_api_key }}",
                "secret": "{{ .payment_secret }}",
                "endpoint": "{{ .payment_endpoint }}"
              }
            }
          }
  
  data:
  # Database credentials
  - secretKey: database_username
    remoteRef:
      key: applications/web-app
      property: database_username
  
  - secretKey: database_password
    remoteRef:
      key: applications/web-app
      property: database_password
  
  - secretKey: database_host
    remoteRef:
      key: applications/web-app
      property: database_host
  
  - secretKey: database_port
    remoteRef:
      key: applications/web-app
      property: database_port
  
  - secretKey: database_name
    remoteRef:
      key: applications/web-app
      property: database_name
  
  # API credentials
  - secretKey: api_key
    remoteRef:
      key: applications/web-app
      property: api_key
  
  - secretKey: webhook_secret
    remoteRef:
      key: applications/web-app
      property: webhook_secret
  
  # TLS certificates
  - secretKey: tls_cert
    remoteRef:
      key: pki/issue/web-app-cert
      property: certificate
  
  - secretKey: tls_key
    remoteRef:
      key: pki/issue/web-app-cert
      property: private_key
  
  # Redis credentials
  - secretKey: redis_host
    remoteRef:
      key: cache/redis
      property: host
  
  - secretKey: redis_port
    remoteRef:
      key: cache/redis
      property: port
  
  - secretKey: redis_password
    remoteRef:
      key: cache/redis
      property: password
  
  # Payment gateway credentials
  - secretKey: payment_api_key
    remoteRef:
      key: external-apis/payment-gateway
      property: api_key
  
  - secretKey: payment_secret
    remoteRef:
      key: external-apis/payment-gateway
      property: secret
  
  - secretKey: payment_endpoint
    remoteRef:
      key: external-apis/payment-gateway
      property: endpoint
---
# Push secret to external system
apiVersion: external-secrets.io/v1alpha1
kind: PushSecret
metadata:
  name: backup-secrets
  namespace: production
spec:
  refreshInterval: "24h"
  
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault-backend
  
  selector:
    secret:
      name: application-secrets
  
  data:
  - match:
      secretKey: database_password
      remoteRef:
        remoteKey: backups/database-credentials
        property: password
  
  - match:
      secretKey: api_key
      remoteRef:
        remoteKey: backups/api-credentials
        property: api_key
```

### Vault Secrets Management Automation

```bash
#!/bin/bash
# vault-secrets-automation.sh
# Advanced secret management automation for enterprise Vault

set -euo pipefail

# Configuration
VAULT_ADDR="${VAULT_ADDR:-https://vault.company.com:8200}"
VAULT_NAMESPACE="${VAULT_NAMESPACE:-production}"
VAULT_TOKEN_FILE="${VAULT_TOKEN_FILE:-/var/run/secrets/vault/token}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Logging function
log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message" >&2
}

# Initialize Vault client
vault_init() {
    log "INFO" "Initializing Vault client"
    
    # Set Vault address
    export VAULT_ADDR="$VAULT_ADDR"
    export VAULT_NAMESPACE="$VAULT_NAMESPACE"
    
    # Authenticate with Vault
    if [[ -f "$VAULT_TOKEN_FILE" ]]; then
        export VAULT_TOKEN=$(cat "$VAULT_TOKEN_FILE")
        log "INFO" "Using token from file: $VAULT_TOKEN_FILE"
    elif [[ -n "${VAULT_ROLE_ID:-}" && -n "${VAULT_SECRET_ID:-}" ]]; then
        log "INFO" "Authenticating with AppRole"
        vault_token=$(vault write -field=token auth/approle/login \
            role_id="$VAULT_ROLE_ID" \
            secret_id="$VAULT_SECRET_ID")
        export VAULT_TOKEN="$vault_token"
    elif [[ -n "${KUBERNETES_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
        log "INFO" "Authenticating with Kubernetes service account"
        vault_token=$(vault write -field=token auth/kubernetes/login \
            role="$VAULT_K8S_ROLE" \
            jwt="$KUBERNETES_SERVICE_ACCOUNT_TOKEN")
        export VAULT_TOKEN="$vault_token"
    else
        log "ERROR" "No authentication method available"
        exit 1
    fi
    
    # Verify authentication
    if ! vault token lookup >/dev/null 2>&1; then
        log "ERROR" "Failed to authenticate with Vault"
        exit 1
    fi
    
    log "INFO" "Successfully authenticated with Vault"
}

# Setup Vault authentication methods
setup_auth_methods() {
    log "INFO" "Setting up Vault authentication methods"
    
    # Enable and configure Kubernetes auth
    if ! vault auth list | grep -q "kubernetes/"; then
        log "INFO" "Enabling Kubernetes authentication"
        vault auth enable kubernetes
    fi
    
    vault write auth/kubernetes/config \
        token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
        kubernetes_host="https://kubernetes.default.svc.cluster.local" \
        kubernetes_ca_cert="$(cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt)"
    
    # Create Kubernetes auth role for External Secrets Operator
    vault write auth/kubernetes/role/external-secrets-operator \
        bound_service_account_names="external-secrets-operator" \
        bound_service_account_namespaces="external-secrets-system" \
        policies="external-secrets-policy" \
        ttl=24h
    
    # Enable and configure AppRole auth
    if ! vault auth list | grep -q "approle/"; then
        log "INFO" "Enabling AppRole authentication"
        vault auth enable approle
    fi
    
    # Create AppRole for CI/CD systems
    vault write auth/approle/role/cicd-pipeline \
        token_policies="cicd-policy" \
        token_ttl=1h \
        token_max_ttl=4h \
        bind_secret_id=true \
        secret_id_ttl=24h
    
    # Enable and configure LDAP auth
    if ! vault auth list | grep -q "ldap/"; then
        log "INFO" "Enabling LDAP authentication"
        vault auth enable ldap
    fi
    
    vault write auth/ldap/config \
        url="ldaps://ldap.company.com" \
        userattr="sAMAccountName" \
        userdn="ou=users,dc=company,dc=com" \
        groupdn="ou=groups,dc=company,dc=com" \
        groupfilter="(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={{.UserDN}}))" \
        groupattr="cn" \
        binddn="cn=vault-service,ou=service-accounts,dc=company,dc=com" \
        bindpass="$LDAP_BIND_PASSWORD" \
        insecure_tls=false \
        starttls=false
    
    log "INFO" "Authentication methods configured successfully"
}

# Setup secret engines
setup_secret_engines() {
    log "INFO" "Setting up Vault secret engines"
    
    # Enable KV v2 secret engine for applications
    if ! vault secrets list | grep -q "secret/"; then
        log "INFO" "Enabling KV v2 secret engine at secret/"
        vault secrets enable -path=secret kv-v2
    fi
    
    vault secrets tune -max-lease-ttl=8760h secret/
    
    # Enable database secrets engine
    if ! vault secrets list | grep -q "database/"; then
        log "INFO" "Enabling database secret engine"
        vault secrets enable database
    fi
    
    # Configure PostgreSQL database connection
    vault write database/config/postgresql \
        plugin_name="postgresql-database-plugin" \
        connection_url="postgresql://{{username}}:{{password}}@postgres.database.svc.cluster.local:5432/postgres?sslmode=require" \
        allowed_roles="readonly,readwrite,admin" \
        username="vault" \
        password="$POSTGRES_VAULT_PASSWORD"
    
    # Create database roles
    vault write database/roles/readonly \
        db_name="postgresql" \
        creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
        default_ttl="1h" \
        max_ttl="24h"
    
    vault write database/roles/readwrite \
        db_name="postgresql" \
        creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"{{name}}\";" \
        default_ttl="1h" \
        max_ttl="24h"
    
    # Enable PKI secret engine for certificates
    if ! vault secrets list | grep -q "pki/"; then
        log "INFO" "Enabling PKI secret engine"
        vault secrets enable pki
    fi
    
    vault secrets tune -max-lease-ttl=87600h pki/
    
    # Generate root CA
    vault write -field=certificate pki/root/generate/internal \
        common_name="Company Root CA" \
        country="US" \
        organization="Company Inc" \
        ou="IT Department" \
        ttl=87600h > /tmp/root_ca.crt
    
    # Configure PKI URLs
    vault write pki/config/urls \
        issuing_certificates="$VAULT_ADDR/v1/pki/ca" \
        crl_distribution_points="$VAULT_ADDR/v1/pki/crl"
    
    # Create PKI role for application certificates
    vault write pki/roles/web-app-cert \
        allowed_domains="company.com,*.company.com" \
        allow_subdomains=true \
        max_ttl="720h" \
        generate_lease=true \
        require_cn=false \
        allow_ip_sans=true \
        allow_localhost=true \
        server_flag=true \
        client_flag=true
    
    # Enable AWS secrets engine
    if ! vault secrets list | grep -q "aws/"; then
        log "INFO" "Enabling AWS secret engine"
        vault secrets enable aws
    fi
    
    vault write aws/config/root \
        access_key="$AWS_ACCESS_KEY_ID" \
        secret_key="$AWS_SECRET_ACCESS_KEY" \
        region="us-west-2"
    
    # Create AWS role for EC2 instances
    vault write aws/roles/ec2-role \
        credential_type="iam_user" \
        policy_document='{
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": [
                        "ec2:Describe*",
                        "s3:GetObject",
                        "s3:PutObject"
                    ],
                    "Resource": "*"
                }
            ]
        }'
    
    log "INFO" "Secret engines configured successfully"
}

# Setup policies
setup_policies() {
    log "INFO" "Setting up Vault policies"
    
    # External Secrets policy
    cat << 'EOF' | vault policy write external-secrets-policy -
# External Secrets Operator policy
path "secret/data/applications/*" {
  capabilities = ["read"]
}

path "secret/metadata/applications/*" {
  capabilities = ["read"]
}

path "pki/issue/web-app-cert" {
  capabilities = ["create", "update"]
}

path "database/creds/readonly" {
  capabilities = ["read"]
}

path "database/creds/readwrite" {
  capabilities = ["read"]
}
EOF
    
    # CI/CD pipeline policy
    cat << 'EOF' | vault policy write cicd-policy -
# CI/CD Pipeline policy
path "secret/data/cicd/*" {
  capabilities = ["create", "read", "update", "delete"]
}

path "secret/metadata/cicd/*" {
  capabilities = ["read", "delete"]
}

path "aws/creds/ec2-role" {
  capabilities = ["read"]
}

path "pki/issue/web-app-cert" {
  capabilities = ["create", "update"]
}
EOF
    
    # Application policy
    cat << 'EOF' | vault policy write application-policy -
# Application access policy
path "secret/data/applications/{{identity.entity.aliases.AUTH_METHOD_ACCESSOR.metadata.service_account_name}}/*" {
  capabilities = ["read"]
}

path "database/creds/readwrite" {
  capabilities = ["read"]
}

path "pki/issue/web-app-cert" {
  capabilities = ["create", "update"]
}
EOF
    
    # Admin policy
    cat << 'EOF' | vault policy write admin-policy -
# Admin policy
path "*" {
  capabilities = ["create", "read", "update", "delete", "list", "sudo"]
}
EOF
    
    log "INFO" "Policies created successfully"
}

# Rotate secrets automatically
rotate_secrets() {
    log "INFO" "Starting secret rotation process"
    
    # Get list of applications
    applications=$(vault kv list -format=json secret/applications | jq -r '.[]')
    
    for app in $applications; do
        log "INFO" "Rotating secrets for application: $app"
        
        # Generate new database password
        new_db_password=$(openssl rand -base64 32)
        
        # Generate new API key
        new_api_key=$(openssl rand -hex 32)
        
        # Update secrets in Vault
        vault kv put secret/applications/"$app" \
            database_password="$new_db_password" \
            api_key="$new_api_key" \
            rotation_timestamp="$(date -Iseconds)"
        
        # Trigger application restart to pick up new secrets
        kubectl rollout restart deployment/"$app" -n production || true
        
        log "INFO" "Rotated secrets for application: $app"
    done
    
    log "INFO" "Secret rotation completed"
}

# Main execution
main() {
    case "${1:-}" in
        init)
            vault_init
            ;;
        setup-auth)
            vault_init
            setup_auth_methods
            ;;
        setup-engines)
            vault_init
            setup_secret_engines
            ;;
        setup-policies)
            vault_init
            setup_policies
            ;;
        setup-all)
            vault_init
            setup_auth_methods
            setup_secret_engines
            setup_policies
            ;;
        rotate)
            vault_init
            rotate_secrets
            ;;
        *)
            echo "Usage: $0 {init|setup-auth|setup-engines|setup-policies|setup-all|rotate}"
            exit 1
            ;;
    esac
}

main "$@"
```

This comprehensive secret management guide provides enterprise-ready patterns for advanced HashiCorp Vault and External Secrets implementations, enabling organizations to achieve secure, scalable, and compliant credential management at enterprise scale.

Key benefits of this advanced secret management approach include:

- **Zero Trust Security**: Comprehensive authentication and authorization frameworks
- **Automated Secret Rotation**: Intelligent credential lifecycle management
- **Kubernetes Integration**: Seamless secret injection into cloud-native applications
- **Compliance and Audit**: Complete audit trails and regulatory compliance support
- **High Availability**: Enterprise-grade reliability and disaster recovery
- **Multi-Cloud Support**: Unified secret management across diverse cloud environments

The implementation patterns demonstrated here enable organizations to achieve security excellence while maintaining operational efficiency and developer productivity.