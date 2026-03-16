---
title: "Azure Service Operator v2: Managing Azure Resources from Kubernetes"
date: 2027-02-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Azure", "AKS", "Azure Service Operator", "Infrastructure as Code"]
categories: ["Cloud Architecture", "Kubernetes", "Infrastructure as Code"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Azure Service Operator v2 for managing Azure resources from Kubernetes, covering Workload Identity setup, OperatorConfig, resource provisioning, secret export, multi-subscription support, GitOps integration, and troubleshooting ARM errors."
more_link: "yes"
url: "/azure-service-operator-aks-kubernetes-resource-management-guide/"
---

**Azure Service Operator v2** (ASO v2) is a Kubernetes operator that provisions and manages Azure resources — AKS clusters, Azure SQL, Service Bus, Storage Accounts, Key Vault, and CosmosDB — through Kubernetes Custom Resources. Unlike ASO v1, which used a single monolithic operator, ASO v2 is built from generated CRDs derived directly from the Azure Resource Manager (ARM) type system, providing broader resource coverage, richer status conditions, and stable multi-subscription support.

<!--more-->

## Architecture Overview

ASO v2 deploys as a single Deployment (`azureserviceoperator-controller-manager`) alongside its webhook server. The controller watches ASO CRDs, converts the desired state into ARM API calls, and propagates the provisioned resource details back into the Kubernetes object's `status` block. Sensitive outputs (connection strings, keys) are written into Kubernetes Secrets.

```
kubectl apply -f AzureSqlServer.yaml
          ↓
  Kubernetes API (CRD stored in etcd)
          ↓
  ASO v2 controller (ARM API calls)
          ↓
  Azure Resource Manager
          ↓
  Azure Infrastructure (SQL Server, databases, firewall rules)
```

### Credential modes

| Mode | Authentication | Use case |
|---|---|---|
| Workload Identity | Federated identity (no secrets) | AKS with OIDC issuer |
| Pod-managed identity | Azure AD pod identity | Legacy AKS (v1 only) |
| Service Principal Secret | Client ID + secret in K8s Secret | Non-AKS or testing |
| Managed Identity (VM) | Node-level MSI | Non-AKS Azure VMs |

**Workload Identity** is the recommended approach for AKS clusters running ASO v2.

## Workload Identity Setup

### Prerequisites

- AKS cluster with OIDC issuer and Workload Identity enabled
- Azure CLI and `kubectl` authenticated

```bash
#!/bin/bash
set -euo pipefail

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
RESOURCE_GROUP="rg-aks-production"
AKS_CLUSTER="aks-production"
ASO_NAMESPACE="azureserviceoperator-system"
ASO_SA_NAME="azureserviceoperator-default"

# 1. Get OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${AKS_CLUSTER}" \
  --query "oidcIssuerProfile.issuerUrl" \
  -o tsv)

echo "OIDC Issuer: ${OIDC_ISSUER}"

# 2. Create the Azure AD managed identity for ASO
az identity create \
  --name "id-aso-controller" \
  --resource-group "${RESOURCE_GROUP}"

CLIENT_ID=$(az identity show \
  --name "id-aso-controller" \
  --resource-group "${RESOURCE_GROUP}" \
  --query clientId -o tsv)

PRINCIPAL_ID=$(az identity show \
  --name "id-aso-controller" \
  --resource-group "${RESOURCE_GROUP}" \
  --query principalId -o tsv)

# 3. Grant Contributor role at subscription scope
# Narrow this to specific resource groups in production
az role assignment create \
  --assignee "${PRINCIPAL_ID}" \
  --role "Contributor" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}"

# Grant User Access Administrator to allow ASO to create role assignments
az role assignment create \
  --assignee "${PRINCIPAL_ID}" \
  --role "User Access Administrator" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}"

# 4. Create federated credential binding
az identity federated-credential create \
  --name "aso-federated-credential" \
  --identity-name "id-aso-controller" \
  --resource-group "${RESOURCE_GROUP}" \
  --issuer "${OIDC_ISSUER}" \
  --subject "system:serviceaccount:${ASO_NAMESPACE}:${ASO_SA_NAME}" \
  --audience "api://AzureADTokenExchange"

echo "Managed Identity Client ID: ${CLIENT_ID}"
echo "Ready to install ASO v2 with Workload Identity"
```

## Installing ASO v2

```bash
#!/bin/bash
ASO_VERSION="v2.8.0"
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
CLIENT_ID=$(az identity show \
  --name "id-aso-controller" \
  --resource-group "rg-aks-production" \
  --query clientId -o tsv)

# Add the ASO Helm repository
helm repo add aso2 https://raw.githubusercontent.com/Azure/azure-service-operator/main/v2/charts
helm repo update

# Install ASO v2
helm upgrade --install aso2 aso2/azure-service-operator \
  --create-namespace \
  --namespace azureserviceoperator-system \
  --version "${ASO_VERSION}" \
  --set azureSubscriptionID="${SUBSCRIPTION_ID}" \
  --set azureTenantID="${TENANT_ID}" \
  --set azureClientID="${CLIENT_ID}" \
  --set useWorkloadIdentityAuth=true \
  --set crdPattern="resources.azure.com/*;containerservice.azure.com/*;sql.azure.com/*;servicebus.azure.com/*;storage.azure.com/*;keyvault.azure.com/*;documentdb.azure.com/*" \
  --set metrics.enable=true \
  --set podAnnotations."azure\.workload\.identity/use"=true \
  --wait

kubectl -n azureserviceoperator-system rollout status \
  deployment/azureserviceoperator-controller-manager --timeout=120s
```

## OperatorConfig CRD for Credential Configuration

**OperatorConfig** is the primary configuration resource for ASO v2. It controls which credentials the operator uses and which subscriptions it manages.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: aso-controller-settings
  namespace: azureserviceoperator-system
stringData:
  AZURE_SUBSCRIPTION_ID: "12345678-1234-1234-1234-123456789012"
  AZURE_TENANT_ID: "abcdef12-abcd-abcd-abcd-abcdef123456"
  AZURE_CLIENT_ID: "fedcba98-fedc-fedc-fedc-fedcba987654"
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: aso-controller-settings
  namespace: azureserviceoperator-system
data:
  # Additional subscriptions this operator can manage
  AZURE_TARGET_NAMESPACES: ""
  AZURE_OPERATOR_MODE: "watchers-and-webhooks"
  # Max concurrent reconciliations per resource type
  MAX_CONCURRENT_RECONCILES: "20"
  # Requeue duration for rate-limited errors
  RATE_LIMIT_MODE: "bucket"
```

### Per-namespace credential override

Namespace-scoped Secrets override the global credentials for resources in that namespace, enabling multi-tenant or multi-subscription scenarios.

```yaml
# Team A's namespace uses their own subscription
apiVersion: v1
kind: Secret
metadata:
  name: aso-credential
  namespace: team-alpha
type: Opaque
stringData:
  AZURE_SUBSCRIPTION_ID: "aaaa1111-aaaa-aaaa-aaaa-aaaa11111111"
  AZURE_TENANT_ID: "bbbb2222-bbbb-bbbb-bbbb-bbbb22222222"
  AZURE_CLIENT_ID: "cccc3333-cccc-cccc-cccc-cccc33333333"
---
# Team B's namespace uses a different subscription
apiVersion: v1
kind: Secret
metadata:
  name: aso-credential
  namespace: team-beta
type: Opaque
stringData:
  AZURE_SUBSCRIPTION_ID: "dddd4444-dddd-dddd-dddd-dddd44444444"
  AZURE_TENANT_ID: "bbbb2222-bbbb-bbbb-bbbb-bbbb22222222"
  AZURE_CLIENT_ID: "eeee5555-eeee-eeee-eeee-eeee55555555"
```

## Resource Provisioning

### AKS Cluster

```yaml
apiVersion: resources.azure.com/v1api20200601
kind: ResourceGroup
metadata:
  name: rg-team-alpha-workloads
  namespace: team-alpha
spec:
  location: eastus
  tags:
    Environment: production
    Team: team-alpha
    CostCenter: engineering
---
apiVersion: containerservice.azure.com/v1api20231001
kind: ManagedCluster
metadata:
  name: aks-team-alpha
  namespace: team-alpha
spec:
  location: eastus
  owner:
    name: rg-team-alpha-workloads
  dnsPrefix: aks-team-alpha
  kubernetesVersion: "1.29"
  identity:
    type: SystemAssigned
  agentPoolProfiles:
    - name: system
      count: 3
      vmSize: Standard_D4s_v5
      mode: System
      osType: Linux
      osSKU: AzureLinux
      enableAutoScaling: true
      minCount: 3
      maxCount: 10
      availabilityZones:
        - "1"
        - "2"
        - "3"
      nodeTaints:
        - CriticalAddonsOnly=true:NoSchedule
    - name: workload
      count: 3
      vmSize: Standard_D8s_v5
      mode: User
      osType: Linux
      enableAutoScaling: true
      minCount: 3
      maxCount: 50
  networkProfile:
    networkPlugin: azure
    networkPolicy: azure
    loadBalancerSku: standard
    outboundType: loadBalancer
  oidcIssuerProfile:
    enabled: true
  securityProfile:
    workloadIdentity:
      enabled: true
  operatorSpec:
    secrets:
      adminCredentials:
        name: aks-team-alpha-admin-kubeconfig
        key: kubeconfig
```

### Azure SQL Server and Database

```yaml
apiVersion: sql.azure.com/v1api20211101
kind: Server
metadata:
  name: sql-team-alpha
  namespace: team-alpha
spec:
  location: eastus
  owner:
    name: rg-team-alpha-workloads
  administratorLogin: sqladmin
  administratorLoginPassword:
    name: sql-admin-password
    key: password
  version: "12.0"
  minimalTlsVersion: "1.2"
  publicNetworkAccess: Disabled
  identity:
    type: SystemAssigned
  operatorSpec:
    secrets:
      fullyQualifiedDomainName:
        name: sql-connection-info
        key: server_fqdn
---
apiVersion: sql.azure.com/v1api20211101
kind: ServersDatabase
metadata:
  name: appdb
  namespace: team-alpha
spec:
  location: eastus
  owner:
    name: sql-team-alpha
  sku:
    name: GP_Gen5
    tier: GeneralPurpose
    capacity: 4
    family: Gen5
  maxSizeBytes: 34359738368
  zoneRedundant: true
  readScale: Enabled
  highAvailabilityReplicaCount: 1
  requestedBackupStorageRedundancy: Zone
  collation: SQL_Latin1_General_CP1_CI_AS
---
# Firewall rule for private endpoint subnet
apiVersion: sql.azure.com/v1api20211101
kind: ServersFirewallRule
metadata:
  name: allow-private-endpoint
  namespace: team-alpha
spec:
  owner:
    name: sql-team-alpha
  startIpAddress: "10.0.1.0"
  endIpAddress: "10.0.1.255"
```

### Azure Service Bus

```yaml
apiVersion: servicebus.azure.com/v1api20221001preview
kind: Namespace
metadata:
  name: sb-team-alpha
  namespace: team-alpha
spec:
  location: eastus
  owner:
    name: rg-team-alpha-workloads
  sku:
    name: Premium
    tier: Premium
    capacity: 1
  zoneRedundant: true
  identity:
    type: SystemAssigned
  operatorSpec:
    secrets:
      endpoint:
        name: servicebus-connection
        key: endpoint
---
apiVersion: servicebus.azure.com/v1api20221001preview
kind: NamespacesQueue
metadata:
  name: order-processing
  namespace: team-alpha
spec:
  owner:
    name: sb-team-alpha
  maxSizeInMegabytes: 5120
  defaultMessageTimeToLive: P14D
  lockDuration: PT5M
  maxDeliveryCount: 10
  enableDeadLetteringOnMessageExpiration: true
  requiresDuplicateDetection: true
  duplicateDetectionHistoryTimeWindow: PT10M
  enablePartitioning: true
---
apiVersion: servicebus.azure.com/v1api20221001preview
kind: NamespacesTopic
metadata:
  name: events
  namespace: team-alpha
spec:
  owner:
    name: sb-team-alpha
  maxSizeInMegabytes: 5120
  defaultMessageTimeToLive: P7D
  enablePartitioning: true
  requiresDuplicateDetection: false
```

### Storage Account

```yaml
apiVersion: storage.azure.com/v1api20230101
kind: StorageAccount
metadata:
  name: stteamalphaprod
  namespace: team-alpha
spec:
  location: eastus
  owner:
    name: rg-team-alpha-workloads
  kind: StorageV2
  sku:
    name: Standard_ZRS
  accessTier: Hot
  allowBlobPublicAccess: false
  minimumTlsVersion: TLS1_2
  supportsHttpsTrafficOnly: true
  networkAcls:
    defaultAction: Deny
    bypass:
      - AzureServices
    ipRules:
      - iPAddressOrRange: "203.0.113.100"
        action: Allow
  encryption:
    requireInfrastructureEncryption: true
    keySource: Microsoft.Storage
  operatorSpec:
    secrets:
      key1:
        name: storage-account-keys
        key: primary_key
      key2:
        name: storage-account-keys
        key: secondary_key
      connectionString1:
        name: storage-account-keys
        key: connection_string
---
apiVersion: storage.azure.com/v1api20230101
kind: StorageAccountsBlobServicesContainer
metadata:
  name: artifacts
  namespace: team-alpha
spec:
  owner:
    name: stteamalphaprod
  publicAccess: None
  metadata:
    environment: production
    team: team-alpha
```

### Azure Key Vault

```yaml
apiVersion: keyvault.azure.com/v1api20230701
kind: Vault
metadata:
  name: kv-team-alpha-prod
  namespace: team-alpha
spec:
  location: eastus
  owner:
    name: rg-team-alpha-workloads
  properties:
    sku:
      family: A
      name: premium
    tenantId: "bbbb2222-bbbb-bbbb-bbbb-bbbb22222222"
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    networkAcls:
      defaultAction: Deny
      bypass: AzureServices
      ipRules:
        - value: "203.0.113.100/32"
      virtualNetworkRules:
        - id: "/subscriptions/aaaa1111-aaaa-aaaa-aaaa-aaaa11111111/resourceGroups/rg-team-alpha-workloads/providers/Microsoft.Network/virtualNetworks/vnet-prod/subnets/snet-aks"
          ignoreMissingVnetServiceEndpoint: false
```

### CosmosDB

```yaml
apiVersion: documentdb.azure.com/v1api20210515
kind: DatabaseAccount
metadata:
  name: cosmos-team-alpha
  namespace: team-alpha
spec:
  location: eastus
  owner:
    name: rg-team-alpha-workloads
  kind: GlobalDocumentDB
  databaseAccountOfferType: Standard
  capabilities:
    - name: EnableServerless
  consistencyPolicy:
    defaultConsistencyLevel: Session
    maxStalenessPrefix: 100
    maxIntervalInSeconds: 5
  locations:
    - locationName: eastus
      failoverPriority: 0
      isZoneRedundant: true
  backupPolicy:
    type: Periodic
    periodicModeProperties:
      backupIntervalInMinutes: 240
      backupRetentionIntervalInHours: 720
      backupStorageRedundancy: Zone
  operatorSpec:
    secrets:
      primaryMasterKey:
        name: cosmos-credentials
        key: primary_key
      documentEndpoint:
        name: cosmos-credentials
        key: endpoint
---
apiVersion: documentdb.azure.com/v1api20210515
kind: SqlDatabase
metadata:
  name: appdata
  namespace: team-alpha
spec:
  owner:
    name: cosmos-team-alpha
  options:
    autoscaleSettings:
      maxThroughput: 4000
---
apiVersion: documentdb.azure.com/v1api20210515
kind: SqlDatabaseContainer
metadata:
  name: orders
  namespace: team-alpha
spec:
  owner:
    name: appdata
  resource:
    id: orders
    partitionKey:
      paths:
        - /customerId
      kind: Hash
      version: 2
    indexingPolicy:
      indexingMode: consistent
      automatic: true
    defaultTtl: 7776000
```

## Secret Export to Kubernetes Secrets

ASO v2 automatically exports resource attributes (connection strings, access keys, endpoints) to Kubernetes Secrets via the `operatorSpec.secrets` field. Pods consume these secrets through standard Kubernetes Secret mounts.

```yaml
# Reference ASO-managed secrets in an application Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server
  namespace: team-alpha
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
          image: company-registry.azurecr.io/api-server:1.5.2
          env:
            - name: SQL_SERVER_FQDN
              valueFrom:
                secretKeyRef:
                  name: sql-connection-info
                  key: server_fqdn
            - name: SERVICEBUS_ENDPOINT
              valueFrom:
                secretKeyRef:
                  name: servicebus-connection
                  key: endpoint
            - name: STORAGE_CONNECTION_STRING
              valueFrom:
                secretKeyRef:
                  name: storage-account-keys
                  key: connection_string
            - name: COSMOS_ENDPOINT
              valueFrom:
                secretKeyRef:
                  name: cosmos-credentials
                  key: endpoint
            - name: COSMOS_KEY
              valueFrom:
                secretKeyRef:
                  name: cosmos-credentials
                  key: primary_key
```

## Resource Ownership and Deletion

ASO v2 uses the `owner` field to establish parent-child relationships between resources. When a parent resource is deleted, ASO cascades the deletion to all owned child resources by default.

The `reconcilePolicy` annotation controls deletion behavior:

```yaml
# Skip deletion of the Azure resource when the K8s object is deleted
apiVersion: sql.azure.com/v1api20211101
kind: Server
metadata:
  name: sql-team-alpha
  namespace: team-alpha
  annotations:
    # Abandon: K8s object deletion does NOT delete the Azure resource
    serviceoperator.azure.com/reconcile-policy: detach-on-delete
spec:
  location: eastus
  owner:
    name: rg-team-alpha-workloads
  # ...
```

Valid `reconcile-policy` values:

- `manage` (default): Create, update, and delete the Azure resource.
- `detach-on-delete`: Manage but skip deletion when the Kubernetes object is removed.
- `skip`: Never touch the Azure resource; only track status.

## Condition-Based Status Monitoring

```bash
#!/bin/bash
# Monitor all ASO resources in a namespace for non-ready conditions
NAMESPACE=${1:-team-alpha}

echo "=== ASO Resource Health: ${NAMESPACE} ==="
echo ""

# Check each resource type
for KIND in \
  managedclusters.containerservice.azure.com \
  servers.sql.azure.com \
  serversdatabases.sql.azure.com \
  namespaces.servicebus.azure.com \
  storageaccounts.storage.azure.com \
  vaults.keyvault.azure.com \
  databaseaccounts.documentdb.azure.com; do

  RESOURCES=$(kubectl -n "${NAMESPACE}" get "${KIND}" \
    --no-headers 2>/dev/null | awk '{print $1}')

  for RESOURCE in ${RESOURCES}; do
    READY=$(kubectl -n "${NAMESPACE}" get "${KIND}" "${RESOURCE}" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
    REASON=$(kubectl -n "${NAMESPACE}" get "${KIND}" "${RESOURCE}" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null)

    if [[ "${READY}" != "True" ]]; then
      echo "NOT READY: ${KIND}/${RESOURCE} - Reason: ${REASON}"
      kubectl -n "${NAMESPACE}" get "${KIND}" "${RESOURCE}" \
        -o jsonpath='{.status.conditions}' | jq -r '.[] | "  [\(.type)] \(.status): \(.message)"'
      echo ""
    fi
  done
done

echo "=== Done ==="
```

## GitOps Integration with ArgoCD

```yaml
# ArgoCD Application managing Azure infrastructure
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: azure-infra-team-alpha
  namespace: argocd
spec:
  project: infrastructure
  source:
    repoURL: https://github.com/company/azure-infrastructure
    targetRevision: main
    path: environments/production/team-alpha
    kustomize:
      commonAnnotations:
        serviceoperator.azure.com/reconcile-policy: manage
  destination:
    server: https://kubernetes.default.svc
    namespace: team-alpha
  syncPolicy:
    automated:
      prune: false       # Prevent accidental Azure resource deletion
      selfHeal: true     # Revert out-of-band Azure changes
    syncOptions:
      - CreateNamespace=true
      - RespectIgnoreDifferences=true
    retry:
      limit: 10
      backoff:
        duration: 60s
        factor: 2
        maxDuration: 30m
  ignoreDifferences:
    # ASO writes ARM provisioning state back; ignore these
    - group: sql.azure.com
      kind: Server
      jsonPointers:
        - /spec/properties/fullyQualifiedDomainName
        - /spec/properties/privateEndpointConnections
    - group: storage.azure.com
      kind: StorageAccount
      jsonPointers:
        - /spec/properties/primaryEndpoints
        - /spec/properties/creationTime
```

## Comparison with Crossplane Azure Provider

| Aspect | ASO v2 | Crossplane Azure Provider |
|---|---|---|
| API coverage | Full ARM (generated from spec) | Growing (community-maintained) |
| Authentication | Workload Identity, SP, MSI | Workload Identity, SP |
| Multi-subscription | Native (per-namespace credential) | Via ProviderConfig per subscription |
| Secret export | `operatorSpec.secrets` | Composition + Secret StoreConfig |
| Resource composition | Kustomize overlays | XRDs and Compositions |
| Observability | Standard K8s conditions | Standard K8s conditions |
| Maintained by | Microsoft | CNCF / community |
| Update cadence | Tied to ARM API releases | Community release cycle |

ASO v2 is the better choice for Azure-only environments where API completeness and Microsoft support matter. Crossplane is preferred when the team already uses it for multi-cloud resource management.

## Upgrading from ASO v1

ASO v1 used a completely different CRD API group (`azure.microsoft.com`); ASO v2 uses `*.azure.com` groups. There is no in-place migration path. The upgrade procedure involves:

1. Deploying ASO v2 alongside v1 without resource overlap.
2. Creating ASO v2 resource manifests for each v1 resource.
3. Using `detach-on-delete` on v1 resources to remove the K8s objects without deleting Azure resources.
4. Applying ASO v2 manifests to adopt the existing Azure resources.
5. Decommissioning ASO v1.

```bash
#!/bin/bash
# Annotate all ASO v1 resources to not delete on removal
for CRD in $(kubectl get crd -l app=azure-service-operator \
  -o jsonpath='{.items[*].metadata.name}'); do

  RESOURCES=$(kubectl get "${CRD}" --all-namespaces \
    --no-headers 2>/dev/null | awk '{print $1"/"$2}')

  for NS_RESOURCE in ${RESOURCES}; do
    NS=$(echo "${NS_RESOURCE}" | cut -d/ -f1)
    NAME=$(echo "${NS_RESOURCE}" | cut -d/ -f2)
    KIND=$(echo "${CRD}" | cut -d. -f1)

    kubectl annotate "${KIND}" "${NAME}" -n "${NS}" \
      "skip-operator-resource-delete=true" \
      --overwrite
  done
done

echo "All ASO v1 resources annotated. Safe to delete K8s objects."
```

## Troubleshooting ARM Provisioning Errors

```bash
# View controller logs for a specific resource
kubectl -n azureserviceoperator-system logs \
  deployment/azureserviceoperator-controller-manager \
  --follow --tail=100 \
  | grep -A 5 "sql-team-alpha"

# Describe the resource for ARM error details
kubectl -n team-alpha describe server sql-team-alpha

# ARM errors appear in the Ready condition's message field
kubectl -n team-alpha get server sql-team-alpha \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].message}'

# Check Azure Activity Log for the resource group
az monitor activity-log list \
  --resource-group "rg-team-alpha-workloads" \
  --offset 1h \
  --query "[?status.value=='Failed'].[operationName.localizedValue,resourceId,properties.statusCode]" \
  --output table

# Verify the ASO managed identity has the required permissions
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
PRINCIPAL_ID=$(az identity show \
  --name "id-aso-controller" \
  --resource-group "rg-aks-production" \
  --query principalId -o tsv)

az role assignment list \
  --assignee "${PRINCIPAL_ID}" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}" \
  --query "[].{Role:roleDefinitionName,Scope:scope}" \
  --output table

# Force reconciliation on a stuck resource
kubectl -n team-alpha annotate server sql-team-alpha \
  "serviceoperator.azure.com/force-reconcile=$(date +%s)" \
  --overwrite

# Check the ARM deployment status directly
az deployment group list \
  --resource-group "rg-team-alpha-workloads" \
  --query "[?provisioningState!='Succeeded'].[name,provisioningState,timestamp]" \
  --output table
```

### Common ARM error codes and resolutions

| ARM Error Code | Cause | Resolution |
|---|---|---|
| `AuthorizationFailed` | Missing IAM role assignment | Add missing role to ASO managed identity |
| `QuotaExceeded` | Subscription core quota exhausted | Request quota increase via Azure portal |
| `InvalidParameter` | API version mismatch in spec | Update CRD version to match ARM API |
| `ResourceNotFound` on owner | Parent resource not yet ready | ASO will retry; check owner resource status |
| `NameAlreadyExists` | Resource name already taken | Use unique name; adopt with `detach-on-delete` |
| `ConflictingOperation` | ARM operation in progress | Wait for previous operation to complete |

Azure Service Operator v2 provides a mature, Microsoft-supported mechanism for managing Azure infrastructure declaratively from Kubernetes. The combination of Workload Identity authentication, rich secret export, per-namespace credential isolation, and ARM-derived CRDs makes it the most complete Azure-native infrastructure controller available for AKS environments.
