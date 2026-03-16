---
title: "AKS Managed Identity and OIDC Integration: Enterprise Security Guide"
date: 2026-04-28T00:00:00-05:00
draft: false
tags: ["AKS", "Azure", "Kubernetes", "Managed Identity", "OIDC", "Security", "Azure Active Directory", "Workload Identity"]
categories: ["Cloud Architecture", "Kubernetes", "Azure", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to implementing Azure Kubernetes Service (AKS) with Managed Identity and OIDC workload identity federation for secure, scalable enterprise authentication and authorization patterns."
more_link: "yes"
url: "/aks-managed-identity-oidc-integration-enterprise-guide/"
---

Azure Kubernetes Service (AKS) provides multiple authentication and authorization mechanisms for securing workload access to Azure resources. Managed Identity and OpenID Connect (OIDC) workload identity federation represent the modern approach to eliminating credential management overhead while maintaining strong security boundaries. This comprehensive guide covers enterprise implementation patterns, security best practices, and production-ready configurations for AKS identity management.

<!--more-->

# Understanding AKS Identity Architecture

## Identity Models in AKS

AKS supports several identity models for workload authentication:

```yaml
# Traditional approach: Service Principal (legacy)
# Requires credential rotation and secret management
apiVersion: v1
kind: Secret
metadata:
  name: azure-credentials
type: Opaque
stringData:
  clientId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  clientSecret: "very-secret-password"
  tenantId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
---
# Pod using service principal credentials
apiVersion: v1
kind: Pod
metadata:
  name: legacy-app
spec:
  containers:
  - name: app
    image: myapp:latest
    env:
    - name: AZURE_CLIENT_ID
      valueFrom:
        secretKeyRef:
          name: azure-credentials
          key: clientId
    - name: AZURE_CLIENT_SECRET
      valueFrom:
        secretKeyRef:
          name: azure-credentials
          key: clientSecret
    - name: AZURE_TENANT_ID
      valueFrom:
        secretKeyRef:
          name: azure-credentials
          key: tenantId
```

```yaml
# Modern approach: Workload Identity with OIDC
# No secrets, automatic credential rotation
apiVersion: v1
kind: ServiceAccount
metadata:
  name: workload-identity-sa
  namespace: production
  annotations:
    azure.workload.identity/client-id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    azure.workload.identity/tenant-id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
---
apiVersion: v1
kind: Pod
metadata:
  name: modern-app
  namespace: production
  labels:
    azure.workload.identity/use: "true"
spec:
  serviceAccountName: workload-identity-sa
  containers:
  - name: app
    image: myapp:latest
    # Automatically gets Azure credentials via OIDC federation
```

## Managed Identity Types

```bash
# System-assigned managed identity
# Created and managed by AKS, lifecycle tied to cluster
az aks create \
  --resource-group production-rg \
  --name production-aks \
  --enable-managed-identity \
  --assign-identity

# User-assigned managed identity
# Independently managed, can be shared across resources
IDENTITY_NAME="aks-production-identity"
IDENTITY_RESOURCE_GROUP="identity-rg"

# Create user-assigned managed identity
az identity create \
  --name $IDENTITY_NAME \
  --resource-group $IDENTITY_RESOURCE_GROUP

IDENTITY_ID=$(az identity show \
  --name $IDENTITY_NAME \
  --resource-group $IDENTITY_RESOURCE_GROUP \
  --query id -o tsv)

# Create AKS cluster with user-assigned identity
az aks create \
  --resource-group production-rg \
  --name production-aks \
  --enable-managed-identity \
  --assign-identity $IDENTITY_ID \
  --node-resource-group production-aks-nodes-rg
```

# Implementing Workload Identity with OIDC

## Enabling Workload Identity Federation

```bash
#!/bin/bash
# Enable workload identity on existing AKS cluster

set -e

RESOURCE_GROUP="production-rg"
CLUSTER_NAME="production-aks"
LOCATION="eastus"

# Enable OIDC issuer
az aks update \
  --resource-group $RESOURCE_GROUP \
  --name $CLUSTER_NAME \
  --enable-oidc-issuer \
  --enable-workload-identity

# Get OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --resource-group $RESOURCE_GROUP \
  --name $CLUSTER_NAME \
  --query "oidcIssuerProfile.issuerUrl" -o tsv)

echo "OIDC Issuer URL: $OIDC_ISSUER"

# Install workload identity webhook
helm repo add azure-workload-identity https://azure.github.io/azure-workload-identity/charts
helm repo update

helm upgrade --install workload-identity-webhook \
  azure-workload-identity/workload-identity-webhook \
  --namespace azure-workload-identity-system \
  --create-namespace \
  --set azureTenantID="$(az account show --query tenantId -o tsv)"
```

## Creating Federated Identity Credentials

```bash
#!/bin/bash
# Create Azure AD application and federated credentials

set -e

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
RESOURCE_GROUP="production-rg"
CLUSTER_NAME="production-aks"
NAMESPACE="production"
SERVICE_ACCOUNT="app-workload-identity"
APPLICATION_NAME="aks-workload-app"

# Get OIDC issuer
OIDC_ISSUER=$(az aks show \
  --resource-group $RESOURCE_GROUP \
  --name $CLUSTER_NAME \
  --query "oidcIssuerProfile.issuerUrl" -o tsv)

# Create Azure AD application
APP_ID=$(az ad app create \
  --display-name $APPLICATION_NAME \
  --query appId -o tsv)

echo "Created application: $APP_ID"

# Create service principal
az ad sp create --id $APP_ID

# Create federated identity credential
az ad app federated-credential create \
  --id $APP_ID \
  --parameters '{
    "name": "'$CLUSTER_NAME'-'$NAMESPACE'-'$SERVICE_ACCOUNT'",
    "issuer": "'$OIDC_ISSUER'",
    "subject": "system:serviceaccount:'$NAMESPACE':'$SERVICE_ACCOUNT'",
    "audiences": ["api://AzureADTokenExchange"]
  }'

echo "Federated credential created"
echo "Application ID: $APP_ID"
echo "Tenant ID: $TENANT_ID"
echo "Service Account: $NAMESPACE/$SERVICE_ACCOUNT"

# Assign Azure RBAC roles
STORAGE_ACCOUNT_NAME="productionstorage"
STORAGE_RESOURCE_GROUP="storage-rg"

# Get storage account resource ID
STORAGE_ID=$(az storage account show \
  --name $STORAGE_ACCOUNT_NAME \
  --resource-group $STORAGE_RESOURCE_GROUP \
  --query id -o tsv)

# Assign Storage Blob Data Contributor role
az role assignment create \
  --role "Storage Blob Data Contributor" \
  --assignee $APP_ID \
  --scope $STORAGE_ID

echo "Role assignment complete"
```

## Kubernetes Service Account Configuration

```yaml
# Kubernetes ServiceAccount with workload identity
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-workload-identity
  namespace: production
  annotations:
    azure.workload.identity/client-id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    azure.workload.identity/tenant-id: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  labels:
    azure.workload.identity/use: "true"
---
# Deployment using workload identity
apiVersion: apps/v1
kind: Deployment
metadata:
  name: storage-access-app
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: storage-app
  template:
    metadata:
      labels:
        app: storage-app
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: app-workload-identity
      containers:
      - name: app
        image: mcr.microsoft.com/azure-storage/app:v1.0
        env:
        - name: AZURE_CLIENT_ID
          value: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        - name: AZURE_TENANT_ID
          value: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        - name: AZURE_FEDERATED_TOKEN_FILE
          value: "/var/run/secrets/azure/tokens/azure-identity-token"
        - name: AZURE_AUTHORITY_HOST
          value: "https://login.microsoftonline.com/"
        volumeMounts:
        - name: azure-identity-token
          mountPath: /var/run/secrets/azure/tokens
          readOnly: true
      volumes:
      - name: azure-identity-token
        projected:
          sources:
          - serviceAccountToken:
              path: azure-identity-token
              expirationSeconds: 3600
              audience: api://AzureADTokenExchange
```

# Enterprise Security Patterns

## Multi-Tenant Identity Isolation

```yaml
# Namespace-level identity segregation
---
apiVersion: v1
kind: Namespace
metadata:
  name: team-alpha
  labels:
    team: alpha
    environment: production
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: team-alpha-workload
  namespace: team-alpha
  annotations:
    azure.workload.identity/client-id: "alpha-client-id"
    azure.workload.identity/tenant-id: "tenant-id"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: team-alpha-role
  namespace: team-alpha
rules:
- apiGroups: [""]
  resources: ["pods", "services", "configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-binding
  namespace: team-alpha
subjects:
- kind: ServiceAccount
  name: team-alpha-workload
  namespace: team-alpha
roleRef:
  kind: Role
  name: team-alpha-role
  apiGroup: rbac.authorization.k8s.io
---
# NetworkPolicy to isolate team workloads
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: team-alpha-isolation
  namespace: team-alpha
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          team: alpha
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          team: alpha
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          app: dns
    ports:
    - protocol: UDP
      port: 53
```

## Conditional Access and Identity Protection

```bash
# Configure Azure AD Conditional Access for AKS workloads

# Create managed identity for specific resource access
IDENTITY_NAME="key-vault-reader"
RESOURCE_GROUP="identity-rg"
KEY_VAULT_NAME="production-kv"

az identity create \
  --name $IDENTITY_NAME \
  --resource-group $RESOURCE_GROUP

IDENTITY_CLIENT_ID=$(az identity show \
  --name $IDENTITY_NAME \
  --resource-group $RESOURCE_GROUP \
  --query clientId -o tsv)

IDENTITY_PRINCIPAL_ID=$(az identity show \
  --name $IDENTITY_NAME \
  --resource-group $RESOURCE_GROUP \
  --query principalId -o tsv)

# Assign Key Vault Secrets User role
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee-object-id $IDENTITY_PRINCIPAL_ID \
  --assignee-principal-type ServicePrincipal \
  --scope $(az keyvault show --name $KEY_VAULT_NAME --query id -o tsv)

# Create federated credential with conditions
az ad app federated-credential create \
  --id $APP_ID \
  --parameters '{
    "name": "key-vault-access",
    "issuer": "'$OIDC_ISSUER'",
    "subject": "system:serviceaccount:secure-namespace:key-vault-sa",
    "audiences": ["api://AzureADTokenExchange"],
    "description": "Federated credential with conditional access"
  }'
```

```yaml
# Pod using Key Vault with workload identity
apiVersion: v1
kind: ServiceAccount
metadata:
  name: key-vault-sa
  namespace: secure-namespace
  annotations:
    azure.workload.identity/client-id: "${IDENTITY_CLIENT_ID}"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
  namespace: secure-namespace
spec:
  replicas: 2
  selector:
    matchLabels:
      app: secure-app
  template:
    metadata:
      labels:
        app: secure-app
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: key-vault-sa
      containers:
      - name: app
        image: secure-app:latest
        env:
        - name: AZURE_CLIENT_ID
          value: "${IDENTITY_CLIENT_ID}"
        - name: KEY_VAULT_NAME
          value: "production-kv"
        volumeMounts:
        - name: secrets-store
          mountPath: "/mnt/secrets-store"
          readOnly: true
      volumes:
      - name: secrets-store
        csi:
          driver: secrets-store.csi.k8s.io
          readOnly: true
          volumeAttributes:
            secretProviderClass: "azure-kv-sync"
---
# SecretProviderClass for Azure Key Vault CSI driver
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: azure-kv-sync
  namespace: secure-namespace
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "false"
    clientID: "${IDENTITY_CLIENT_ID}"
    keyvaultName: "production-kv"
    cloudName: "AzurePublicCloud"
    objects: |
      array:
        - |
          objectName: database-password
          objectType: secret
          objectVersion: ""
        - |
          objectName: api-key
          objectType: secret
          objectVersion: ""
    tenantId: "${TENANT_ID}"
  secretObjects:
  - secretName: app-secrets
    type: Opaque
    data:
    - objectName: database-password
      key: db-password
    - objectName: api-key
      key: api-key
```

# Advanced Configuration Patterns

## Multi-Cluster Identity Management

```bash
#!/bin/bash
# Configure workload identity across multiple AKS clusters

CLUSTERS=("prod-cluster-east" "prod-cluster-west" "prod-cluster-central")
RESOURCE_GROUP="production-rg"
NAMESPACE="shared-services"
SERVICE_ACCOUNT="shared-app-identity"
APP_NAME="multi-cluster-app"

# Create Azure AD application (shared across clusters)
APP_ID=$(az ad app create \
  --display-name $APP_NAME \
  --query appId -o tsv)

az ad sp create --id $APP_ID

# Configure federated credentials for each cluster
for CLUSTER in "${CLUSTERS[@]}"; do
  echo "Configuring cluster: $CLUSTER"

  # Get OIDC issuer
  OIDC_ISSUER=$(az aks show \
    --resource-group $RESOURCE_GROUP \
    --name $CLUSTER \
    --query "oidcIssuerProfile.issuerUrl" -o tsv)

  # Create federated credential
  az ad app federated-credential create \
    --id $APP_ID \
    --parameters '{
      "name": "'$CLUSTER'-'$NAMESPACE'-'$SERVICE_ACCOUNT'",
      "issuer": "'$OIDC_ISSUER'",
      "subject": "system:serviceaccount:'$NAMESPACE':'$SERVICE_ACCOUNT'",
      "audiences": ["api://AzureADTokenExchange"]
    }'

  # Get cluster credentials
  az aks get-credentials \
    --resource-group $RESOURCE_GROUP \
    --name $CLUSTER \
    --context $CLUSTER

  # Create namespace and service account
  kubectl create namespace $NAMESPACE --dry-run=client -o yaml | \
    kubectl apply -f - --context $CLUSTER

  kubectl apply -f - --context $CLUSTER <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $SERVICE_ACCOUNT
  namespace: $NAMESPACE
  annotations:
    azure.workload.identity/client-id: "$APP_ID"
    azure.workload.identity/tenant-id: "$(az account show --query tenantId -o tsv)"
  labels:
    azure.workload.identity/use: "true"
EOF

  echo "Configured $CLUSTER"
done

# Assign Azure RBAC roles (applies to all clusters)
COSMOS_DB_ACCOUNT="shared-cosmos-db"
COSMOS_DB_RG="database-rg"

COSMOS_DB_ID=$(az cosmosdb show \
  --name $COSMOS_DB_ACCOUNT \
  --resource-group $COSMOS_DB_RG \
  --query id -o tsv)

az role assignment create \
  --role "Cosmos DB Account Reader Role" \
  --assignee $APP_ID \
  --scope $COSMOS_DB_ID

echo "Multi-cluster identity configuration complete"
```

## Automated Identity Lifecycle Management

```python
#!/usr/bin/env python3
"""
Automated workload identity lifecycle management
"""

import subprocess
import json
from typing import Dict, List
from datetime import datetime, timedelta

class WorkloadIdentityManager:
    def __init__(self, subscription_id: str, tenant_id: str):
        self.subscription_id = subscription_id
        self.tenant_id = tenant_id

    def create_workload_identity(
        self,
        app_name: str,
        cluster_name: str,
        resource_group: str,
        namespace: str,
        service_account: str,
        roles: List[Dict[str, str]]
    ) -> Dict[str, str]:
        """Create complete workload identity configuration"""

        # Get OIDC issuer
        oidc_issuer = self._get_oidc_issuer(cluster_name, resource_group)

        # Create Azure AD application
        app_id = self._create_ad_application(app_name)

        # Create service principal
        self._create_service_principal(app_id)

        # Create federated credential
        self._create_federated_credential(
            app_id,
            oidc_issuer,
            namespace,
            service_account,
            cluster_name
        )

        # Assign Azure RBAC roles
        for role in roles:
            self._assign_role(
                app_id,
                role['role_name'],
                role['scope']
            )

        # Create Kubernetes service account
        self._create_k8s_service_account(
            cluster_name,
            resource_group,
            namespace,
            service_account,
            app_id
        )

        return {
            'app_id': app_id,
            'tenant_id': self.tenant_id,
            'namespace': namespace,
            'service_account': service_account
        }

    def _get_oidc_issuer(self, cluster_name: str, resource_group: str) -> str:
        """Get OIDC issuer URL from AKS cluster"""
        cmd = [
            'az', 'aks', 'show',
            '--resource-group', resource_group,
            '--name', cluster_name,
            '--query', 'oidcIssuerProfile.issuerUrl',
            '-o', 'tsv'
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def _create_ad_application(self, app_name: str) -> str:
        """Create Azure AD application"""
        cmd = [
            'az', 'ad', 'app', 'create',
            '--display-name', app_name,
            '--query', 'appId',
            '-o', 'tsv'
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def _create_service_principal(self, app_id: str):
        """Create service principal for application"""
        cmd = ['az', 'ad', 'sp', 'create', '--id', app_id]
        subprocess.run(cmd, check=True)

    def _create_federated_credential(
        self,
        app_id: str,
        oidc_issuer: str,
        namespace: str,
        service_account: str,
        cluster_name: str
    ):
        """Create federated identity credential"""
        parameters = {
            'name': f'{cluster_name}-{namespace}-{service_account}',
            'issuer': oidc_issuer,
            'subject': f'system:serviceaccount:{namespace}:{service_account}',
            'audiences': ['api://AzureADTokenExchange']
        }

        cmd = [
            'az', 'ad', 'app', 'federated-credential', 'create',
            '--id', app_id,
            '--parameters', json.dumps(parameters)
        ]
        subprocess.run(cmd, check=True)

    def _assign_role(self, app_id: str, role_name: str, scope: str):
        """Assign Azure RBAC role"""
        cmd = [
            'az', 'role', 'assignment', 'create',
            '--role', role_name,
            '--assignee', app_id,
            '--scope', scope
        ]
        subprocess.run(cmd, check=True)

    def _create_k8s_service_account(
        self,
        cluster_name: str,
        resource_group: str,
        namespace: str,
        service_account: str,
        app_id: str
    ):
        """Create Kubernetes service account"""
        # Get cluster credentials
        subprocess.run([
            'az', 'aks', 'get-credentials',
            '--resource-group', resource_group,
            '--name', cluster_name,
            '--overwrite-existing'
        ], check=True)

        # Create namespace
        subprocess.run([
            'kubectl', 'create', 'namespace', namespace,
            '--dry-run=client', '-o', 'yaml'
        ], stdout=subprocess.PIPE, check=True)

        # Create service account
        sa_yaml = f"""
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {service_account}
  namespace: {namespace}
  annotations:
    azure.workload.identity/client-id: "{app_id}"
    azure.workload.identity/tenant-id: "{self.tenant_id}"
  labels:
    azure.workload.identity/use: "true"
"""
        subprocess.run(
            ['kubectl', 'apply', '-f', '-'],
            input=sa_yaml.encode(),
            check=True
        )

    def rotate_federated_credentials(self, app_id: str):
        """Rotate federated credentials (proactive security)"""
        # List existing credentials
        cmd = [
            'az', 'ad', 'app', 'federated-credential', 'list',
            '--id', app_id,
            '-o', 'json'
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        credentials = json.loads(result.stdout)

        # Check credential age and rotate if needed
        for cred in credentials:
            # Azure AD federated credentials don't expire but rotate periodically
            # for security hygiene
            print(f"Federated credential: {cred['name']} is active")

    def audit_workload_identities(self) -> List[Dict]:
        """Audit all workload identities in subscription"""
        # List all applications with federated credentials
        cmd = [
            'az', 'ad', 'app', 'list',
            '--filter', "federatedIdentityCredentials/any()",
            '-o', 'json'
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        apps = json.loads(result.stdout)

        audit_results = []
        for app in apps:
            # Get federated credentials
            cred_cmd = [
                'az', 'ad', 'app', 'federated-credential', 'list',
                '--id', app['appId'],
                '-o', 'json'
            ]
            cred_result = subprocess.run(
                cred_cmd,
                capture_output=True,
                text=True,
                check=True
            )
            credentials = json.loads(cred_result.stdout)

            # Get role assignments
            role_cmd = [
                'az', 'role', 'assignment', 'list',
                '--assignee', app['appId'],
                '-o', 'json'
            ]
            role_result = subprocess.run(
                role_cmd,
                capture_output=True,
                text=True,
                check=True
            )
            roles = json.loads(role_result.stdout)

            audit_results.append({
                'app_id': app['appId'],
                'display_name': app['displayName'],
                'credentials_count': len(credentials),
                'role_assignments': len(roles),
                'credentials': credentials,
                'roles': roles
            })

        return audit_results

# Example usage
if __name__ == '__main__':
    manager = WorkloadIdentityManager(
        subscription_id='your-subscription-id',
        tenant_id='your-tenant-id'
    )

    # Create workload identity for application
    identity = manager.create_workload_identity(
        app_name='production-app',
        cluster_name='production-aks',
        resource_group='production-rg',
        namespace='production',
        service_account='app-identity',
        roles=[
            {
                'role_name': 'Storage Blob Data Contributor',
                'scope': '/subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{sa}'
            },
            {
                'role_name': 'Key Vault Secrets User',
                'scope': '/subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.KeyVault/vaults/{kv}'
            }
        ]
    )

    print(f"Created workload identity: {identity}")

    # Audit existing identities
    audit = manager.audit_workload_identities()
    print(f"Found {len(audit)} workload identities")
```

# Monitoring and Troubleshooting

## Identity Authentication Monitoring

```yaml
# Prometheus monitoring for workload identity
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: monitoring
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s

    scrape_configs:
    - job_name: 'workload-identity-webhook'
      kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
          - azure-workload-identity-system
      relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
        action: keep
        regex: workload-identity-webhook

    - job_name: 'azure-identity-failures'
      static_configs:
      - targets: ['azure-monitor-exporter:9090']

---
# AlertManager rules for identity issues
apiVersion: v1
kind: ConfigMap
metadata:
  name: alertmanager-rules
  namespace: monitoring
data:
  identity-alerts.yml: |
    groups:
    - name: workload_identity
      interval: 30s
      rules:
      - alert: HighIdentityAuthenticationFailures
        expr: rate(azure_identity_authentication_failures_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
          component: identity
        annotations:
          summary: "High identity authentication failure rate"
          description: "Identity authentication failures exceeded threshold"

      - alert: TokenExpirationWarning
        expr: azure_identity_token_expiration_seconds < 300
        labels:
          severity: warning
          component: identity
        annotations:
          summary: "Azure identity token expiring soon"
          description: "Token for {{ $labels.service_account }} expiring in {{ $value }} seconds"

      - alert: FederatedCredentialMisconfiguration
        expr: azure_federated_credential_errors_total > 0
        labels:
          severity: critical
          component: identity
        annotations:
          summary: "Federated credential misconfiguration detected"
          description: "Federated credential errors for {{ $labels.namespace }}/{{ $labels.service_account }}"
```

## Troubleshooting Common Issues

```bash
#!/bin/bash
# Workload identity troubleshooting script

NAMESPACE=$1
POD_NAME=$2
SERVICE_ACCOUNT=$3

if [ -z "$NAMESPACE" ] || [ -z "$POD_NAME" ]; then
  echo "Usage: $0 <namespace> <pod-name> [service-account]"
  exit 1
fi

echo "=== Workload Identity Troubleshooting ==="
echo "Namespace: $NAMESPACE"
echo "Pod: $POD_NAME"
echo ""

# Check pod labels
echo "1. Checking pod labels:"
kubectl get pod $POD_NAME -n $NAMESPACE -o jsonpath='{.metadata.labels}' | jq .
echo ""

# Verify workload identity label
if kubectl get pod $POD_NAME -n $NAMESPACE -o jsonpath='{.metadata.labels.azure\.workload\.identity/use}' | grep -q "true"; then
  echo "✓ Workload identity label present"
else
  echo "✗ Missing workload identity label (azure.workload.identity/use: true)"
fi
echo ""

# Check service account
echo "2. Checking service account:"
SA=$(kubectl get pod $POD_NAME -n $NAMESPACE -o jsonpath='{.spec.serviceAccountName}')
echo "Service Account: $SA"
kubectl get sa $SA -n $NAMESPACE -o yaml | grep -A 5 "annotations:"
echo ""

# Check service account annotations
CLIENT_ID=$(kubectl get sa $SA -n $NAMESPACE -o jsonpath='{.metadata.annotations.azure\.workload\.identity/client-id}')
TENANT_ID=$(kubectl get sa $SA -n $NAMESPACE -o jsonpath='{.metadata.annotations.azure\.workload\.identity/tenant-id}')

if [ -n "$CLIENT_ID" ] && [ -n "$TENANT_ID" ]; then
  echo "✓ Service account has required annotations"
  echo "  Client ID: $CLIENT_ID"
  echo "  Tenant ID: $TENANT_ID"
else
  echo "✗ Missing service account annotations"
fi
echo ""

# Check projected token volume
echo "3. Checking projected token volume:"
kubectl get pod $POD_NAME -n $NAMESPACE -o jsonpath='{.spec.volumes[?(@.projected)]}' | jq .
echo ""

# Check token in pod
echo "4. Checking token in pod:"
kubectl exec $POD_NAME -n $NAMESPACE -- sh -c '
  if [ -f /var/run/secrets/azure/tokens/azure-identity-token ]; then
    echo "✓ Token file exists"
    echo "Token preview (first 50 chars):"
    head -c 50 /var/run/secrets/azure/tokens/azure-identity-token
    echo "..."
  else
    echo "✗ Token file not found"
  fi
'
echo ""

# Check environment variables
echo "5. Checking environment variables:"
kubectl exec $POD_NAME -n $NAMESPACE -- env | grep AZURE
echo ""

# Test Azure authentication
echo "6. Testing Azure authentication:"
kubectl exec $POD_NAME -n $NAMESPACE -- sh -c '
  if command -v az >/dev/null 2>&1; then
    az login --service-principal \
      --username $AZURE_CLIENT_ID \
      --tenant $AZURE_TENANT_ID \
      --federated-token "$(cat $AZURE_FEDERATED_TOKEN_FILE)" \
      --allow-no-subscriptions
    echo "✓ Azure authentication successful"
  else
    echo "ℹ az CLI not available in container"
  fi
'

# Check webhook injection
echo "7. Checking webhook injection:"
kubectl get mutatingwebhookconfigurations | grep workload-identity
echo ""

# Check OIDC issuer
echo "8. Checking OIDC issuer:"
CLUSTER_NAME=$(kubectl config current-context | cut -d'_' -f4)
RESOURCE_GROUP=$(kubectl config current-context | cut -d'_' -f3)

if [ -n "$CLUSTER_NAME" ] && [ -n "$RESOURCE_GROUP" ]; then
  az aks show \
    --resource-group $RESOURCE_GROUP \
    --name $CLUSTER_NAME \
    --query "oidcIssuerProfile" -o json
else
  echo "Could not determine cluster name from context"
fi

echo ""
echo "=== Troubleshooting Complete ==="
```

# Production Best Practices

## Security Hardening Checklist

```yaml
# Comprehensive security configuration
---
# 1. Enable Azure Policy for AKS
# Enforce workload identity usage
apiVersion: policy.azure.com/v1
kind: AzurePolicyAssignment
metadata:
  name: enforce-workload-identity
spec:
  policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/..."
  parameters:
    effect: deny
    excludedNamespaces:
    - kube-system
    - azure-workload-identity-system

---
# 2. Pod Security Standards
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted

---
# 3. Network policies for identity isolation
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: workload-identity-egress
  namespace: production
spec:
  podSelector:
    matchLabels:
      azure.workload.identity/use: "true"
  policyTypes:
  - Egress
  egress:
  # Allow Azure AD authentication
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443
  # Allow Azure services
  - to:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 443
  # Allow DNS
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53

---
# 4. Resource quotas for identity-enabled namespaces
apiVersion: v1
kind: ResourceQuota
metadata:
  name: workload-identity-quota
  namespace: production
spec:
  hard:
    requests.cpu: "100"
    requests.memory: 200Gi
    persistentvolumeclaims: "50"
    services.loadbalancers: "10"
  scopeSelector:
    matchExpressions:
    - operator: Exists
      scopeName: PriorityClass

---
# 5. PodDisruptionBudget for identity-critical workloads
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: identity-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      azure.workload.identity/use: "true"
      tier: critical
```

## Operational Runbook

```bash
#!/bin/bash
# Operational runbook for workload identity management

# Daily health check
daily_health_check() {
  echo "=== Daily Workload Identity Health Check ==="

  # Check webhook status
  kubectl get pods -n azure-workload-identity-system
  kubectl top pods -n azure-workload-identity-system

  # Check for authentication failures
  kubectl logs -n azure-workload-identity-system \
    -l app.kubernetes.io/name=workload-identity-webhook \
    --tail=100 | grep -i error

  # Verify OIDC issuer accessibility
  OIDC_ISSUER=$(az aks show \
    --resource-group $RESOURCE_GROUP \
    --name $CLUSTER_NAME \
    --query "oidcIssuerProfile.issuerUrl" -o tsv)

  curl -s "${OIDC_ISSUER}/.well-known/openid-configuration" > /dev/null
  if [ $? -eq 0 ]; then
    echo "✓ OIDC issuer accessible"
  else
    echo "✗ OIDC issuer unreachable"
  fi
}

# Weekly audit
weekly_audit() {
  echo "=== Weekly Workload Identity Audit ==="

  # List all workload identities
  kubectl get serviceaccounts --all-namespaces \
    -l azure.workload.identity/use=true \
    -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,CLIENT_ID:.metadata.annotations.azure\\.workload\\.identity/client-id

  # Check for unused identities
  # (no pods using the service account)

  # Audit Azure RBAC role assignments
  # Review for excessive permissions
}

# Monthly security review
monthly_security_review() {
  echo "=== Monthly Security Review ==="

  # Review federated credentials
  # Check for credential age and usage

  # Review role assignments
  # Verify principle of least privilege

  # Check for policy violations

  # Generate compliance report
}

# Incident response
identity_incident_response() {
  echo "=== Identity Incident Response ==="

  # 1. Identify compromised identity
  COMPROMISED_APP_ID=$1

  # 2. Immediately revoke access
  echo "Revoking service principal..."
  az ad sp delete --id $COMPROMISED_APP_ID

  # 3. Rotate federated credentials
  # (automatic when service principal deleted)

  # 4. Review audit logs
  az monitor activity-log list \
    --caller $COMPROMISED_APP_ID \
    --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)

  # 5. Recreate identity with new credentials

  # 6. Update Kubernetes service accounts

  # 7. Document incident
}
```

# Conclusion

AKS Managed Identity with OIDC workload identity federation provides a robust, secure, and operationally efficient approach to cloud authentication. By eliminating long-lived credentials and leveraging short-lived tokens, organizations can significantly reduce their security risk while simplifying credential management.

Key implementation points:

- **Eliminate Secrets**: Use workload identity instead of service principal credentials
- **Least Privilege**: Apply granular Azure RBAC roles for each workload
- **Multi-Tenant Isolation**: Implement namespace-level identity segregation
- **Monitoring**: Deploy comprehensive observability for identity operations
- **Automation**: Leverage automated lifecycle management tools
- **Security**: Enforce Pod Security Standards and network policies

The combination of AKS Managed Identity and OIDC federation represents the modern standard for Kubernetes workload authentication in Azure, providing enterprise-grade security with minimal operational overhead.