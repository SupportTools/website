---
title: "Azure AKS Production Deployment: Managed Identity, Azure Policy, and AGIC"
date: 2027-08-06T00:00:00-05:00
draft: false
tags: ["Azure", "AKS", "Kubernetes", "Cloud", "Production"]
categories:
- Azure
- Kubernetes
- Cloud
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive production guide for Azure Kubernetes Service covering cluster architecture, Azure Workload Identity, Azure CNI Overlay, Application Gateway Ingress Controller, Azure Policy for Kubernetes, KEDA, GitOps with Flux, and AKS cluster upgrade procedures."
more_link: "yes"
url: "/azure-aks-production-deployment-guide/"
---

Azure Kubernetes Service (AKS) provides a managed Kubernetes platform deeply integrated with the Azure ecosystem. Properly leveraging Azure Workload Identity, Azure CNI Overlay networking, the Application Gateway Ingress Controller, and Azure Monitor for Containers transforms a basic AKS deployment into a production-ready platform. This guide covers every critical component from initial cluster design through ongoing operational procedures.

<!--more-->

# [Azure AKS Production Deployment](#azure-aks-production-deployment)

## Section 1: AKS Cluster Architecture

### Network Architecture Planning

AKS supports several networking models. For production workloads, Azure CNI Overlay provides the best combination of pod density, network isolation, and operational simplicity. Overlay mode allocates pod IPs from a private overlay network rather than the VNet CIDR, eliminating the IP exhaustion problem that plagued original Azure CNI.

```
Production VNet: 10.0.0.0/16

AKS subnet (node IPs): 10.0.1.0/24
API server subnet (private cluster): 10.0.0.0/28
Application Gateway subnet: 10.0.2.0/27
Internal load balancer subnet: 10.0.3.0/24

Pod CIDR (overlay, not in VNet): 192.168.0.0/16
Service CIDR: 172.20.0.0/16
DNS Service IP: 172.20.0.10
```

### Cluster Creation with Azure CLI

```bash
# Create resource group
az group create \
  --name prod-rg \
  --location eastus

# Create VNet and subnets
az network vnet create \
  --resource-group prod-rg \
  --name prod-vnet \
  --address-prefix 10.0.0.0/16

az network vnet subnet create \
  --resource-group prod-rg \
  --vnet-name prod-vnet \
  --name aks-subnet \
  --address-prefix 10.0.1.0/24

az network vnet subnet create \
  --resource-group prod-rg \
  --vnet-name prod-vnet \
  --name appgw-subnet \
  --address-prefix 10.0.2.0/27

# Get subnet ID
AKS_SUBNET_ID=$(az network vnet subnet show \
  --resource-group prod-rg \
  --vnet-name prod-vnet \
  --name aks-subnet \
  --query id \
  --output tsv)

# Create AKS cluster
az aks create \
  --resource-group prod-rg \
  --name prod-aks \
  --location eastus \
  --kubernetes-version 1.30.0 \
  --node-count 3 \
  --node-vm-size Standard_D4s_v5 \
  --os-disk-size-gb 128 \
  --os-disk-type Managed \
  --network-plugin azure \
  --network-plugin-mode overlay \
  --network-policy cilium \
  --network-dataplane cilium \
  --pod-cidr 192.168.0.0/16 \
  --service-cidr 172.20.0.0/16 \
  --dns-service-ip 172.20.0.10 \
  --vnet-subnet-id "${AKS_SUBNET_ID}" \
  --enable-private-cluster \
  --private-dns-zone system \
  --enable-managed-identity \
  --enable-oidc-issuer \
  --enable-workload-identity \
  --enable-addons monitoring,azure-keyvault-secrets-provider \
  --workspace-resource-id /subscriptions/SUB_ID/resourceGroups/monitoring-rg/providers/Microsoft.OperationalInsights/workspaces/prod-workspace \
  --zones 1 2 3 \
  --generate-ssh-keys \
  --auto-upgrade-channel patch \
  --node-os-upgrade-channel NodeImage \
  --uptime-sla
```

### System and User Node Pools

AKS distinguishes between system and user node pools. System node pools run critical cluster components (CoreDNS, konnectivity, metrics-server). User node pools run application workloads. This separation ensures that cluster infrastructure is not displaced by application resource contention.

```bash
# System node pool is created with the cluster
# Add a user node pool for applications
az aks nodepool add \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name apppool \
  --node-count 3 \
  --min-count 3 \
  --max-count 50 \
  --enable-cluster-autoscaler \
  --node-vm-size Standard_D8s_v5 \
  --os-disk-size-gb 128 \
  --os-disk-type Managed \
  --node-taints "" \
  --labels role=application tier=app \
  --zones 1 2 3 \
  --mode User \
  --os-sku AzureLinux \
  --enable-node-public-ip false

# Add a spot node pool for cost-optimized burst workloads
az aks nodepool add \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name spotpool \
  --node-count 0 \
  --min-count 0 \
  --max-count 100 \
  --enable-cluster-autoscaler \
  --priority Spot \
  --eviction-policy Delete \
  --spot-max-price -1 \
  --node-vm-size Standard_D8s_v5 \
  --node-taints kubernetes.azure.com/scalesetpriority=spot:NoSchedule \
  --labels kubernetes.azure.com/scalesetpriority=spot role=spot \
  --zones 1 2 3 \
  --mode User
```

## Section 2: Managed Identity and Azure Workload Identity

### Cluster-Level Managed Identity

AKS uses a system-assigned or user-assigned managed identity for cluster operations (pulling images from ACR, managing load balancers, reading VNet configuration). A user-assigned identity provides better lifecycle control and is recommended for production.

```bash
# Create user-assigned managed identity for the cluster
az identity create \
  --resource-group prod-rg \
  --name prod-aks-identity

IDENTITY_ID=$(az identity show \
  --resource-group prod-rg \
  --name prod-aks-identity \
  --query id \
  --output tsv)

IDENTITY_CLIENT_ID=$(az identity show \
  --resource-group prod-rg \
  --name prod-aks-identity \
  --query clientId \
  --output tsv)

# Grant the identity Contributor rights on the VNet resource group
az role assignment create \
  --assignee "${IDENTITY_CLIENT_ID}" \
  --role "Network Contributor" \
  --scope /subscriptions/SUB_ID/resourceGroups/prod-rg
```

### Azure Workload Identity

Azure Workload Identity replaces the deprecated AAD Pod Identity. It uses the Kubernetes service account token projected into pods, which is then exchanged with Azure AD for managed identity credentials. No long-lived secrets or identity components running as DaemonSets are required.

```bash
# Get the OIDC issuer URL
OIDC_ISSUER=$(az aks show \
  --resource-group prod-rg \
  --name prod-aks \
  --query "oidcIssuerProfile.issuerUrl" \
  --output tsv)

echo "OIDC Issuer: ${OIDC_ISSUER}"

# Create a user-assigned managed identity for the application
az identity create \
  --resource-group prod-rg \
  --name app-kv-identity

APP_IDENTITY_CLIENT_ID=$(az identity show \
  --resource-group prod-rg \
  --name app-kv-identity \
  --query clientId \
  --output tsv)

APP_IDENTITY_OBJECT_ID=$(az identity show \
  --resource-group prod-rg \
  --name app-kv-identity \
  --query principalId \
  --output tsv)

# Grant the identity access to Key Vault secrets
az keyvault set-policy \
  --name prod-keyvault \
  --object-id "${APP_IDENTITY_OBJECT_ID}" \
  --secret-permissions get list

# Create federated identity credential
az identity federated-credential create \
  --name app-federated-credential \
  --identity-name app-kv-identity \
  --resource-group prod-rg \
  --issuer "${OIDC_ISSUER}" \
  --subject "system:serviceaccount:production:app-sa" \
  --audience api://AzureADTokenExchange
```

### Kubernetes Service Account and Pod Configuration

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
  namespace: production
  annotations:
    azure.workload.identity/client-id: APP_IDENTITY_CLIENT_ID_VALUE
    azure.workload.identity/tenant-id: TENANT_ID_VALUE
  labels:
    azure.workload.identity/use: "true"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: app-sa
      containers:
        - name: app
          image: myregistry.azurecr.io/my-app:latest
          env:
            - name: AZURE_CLIENT_ID
              value: APP_IDENTITY_CLIENT_ID_VALUE
            - name: AZURE_TENANT_ID
              valueFrom:
                configMapKeyRef:
                  name: azure-config
                  key: tenantId
```

## Section 3: Azure CNI vs Kubenet vs CNI Overlay

### Networking Model Comparison

**Kubenet:** Pods receive IPs from an internal overlay. Only nodes have VNet IPs. Cross-node pod traffic is NATted. Simple setup but has UDR management overhead and doesn't support Azure Network Policy.

**Azure CNI:** Every pod receives a VNet IP. Full L3 connectivity without NAT. Requires pre-allocating IP addresses per node, leading to rapid VNet IP exhaustion. Supports Azure Network Policy.

**Azure CNI Overlay:** Pods receive IPs from a private overlay CIDR not in the VNet. Nodes have VNet IPs. Pod-to-pod traffic is routed via the Azure SDN stack. Eliminates IP exhaustion while maintaining full pod connectivity and supporting both Azure and Cilium network policies.

**Azure CNI Powered by Cilium:** Uses Cilium as the CNI with Azure routing. Provides eBPF-based dataplane, Hubble observability, and the richest set of network policy features.

```bash
# Migrate from Azure CNI to Azure CNI Overlay (requires node pool recreation)
az aks nodepool add \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name newapppool \
  --node-count 3 \
  --network-plugin azure \
  --network-plugin-mode overlay \
  --pod-cidr 192.168.0.0/16

# Cordon and drain old node pool
kubectl cordon -l agentpool=apppool
kubectl drain -l agentpool=apppool \
  --ignore-daemonsets \
  --delete-emptydir-data

# Delete old node pool after validating workload migration
az aks nodepool delete \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name apppool
```

## Section 4: Application Gateway Ingress Controller (AGIC)

### AGIC Architecture

The Application Gateway Ingress Controller (AGIC) provisions and configures Azure Application Gateway based on Kubernetes Ingress resources. AGIC runs as a pod in the cluster and watches Ingress events, translating them into Application Gateway configurations. This provides enterprise-grade WAF, SSL offload, and routing capabilities integrated into the Kubernetes control loop.

```bash
# Create Application Gateway
APPGW_SUBNET_ID=$(az network vnet subnet show \
  --resource-group prod-rg \
  --vnet-name prod-vnet \
  --name appgw-subnet \
  --query id \
  --output tsv)

az network public-ip create \
  --resource-group prod-rg \
  --name prod-appgw-pip \
  --allocation-method Static \
  --sku Standard \
  --zone 1 2 3

az network application-gateway create \
  --resource-group prod-rg \
  --name prod-appgw \
  --location eastus \
  --sku WAF_v2 \
  --capacity 2 \
  --vnet-name prod-vnet \
  --subnet appgw-subnet \
  --public-ip-address prod-appgw-pip \
  --private-ip-address 10.0.2.4 \
  --http-settings-protocol Http \
  --frontend-port 80 \
  --routing-rule-type Basic \
  --priority 1

# Enable WAF on Application Gateway
az network application-gateway waf-config set \
  --resource-group prod-rg \
  --gateway-name prod-appgw \
  --enabled true \
  --firewall-mode Prevention \
  --rule-set-type OWASP \
  --rule-set-version 3.2

# Enable AGIC add-on
APPGW_ID=$(az network application-gateway show \
  --resource-group prod-rg \
  --name prod-appgw \
  --query id \
  --output tsv)

az aks enable-addons \
  --resource-group prod-rg \
  --name prod-aks \
  --addons ingress-appgw \
  --appgw-id "${APPGW_ID}"
```

### AGIC Ingress Resources

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: prod-ingress
  namespace: production
  annotations:
    kubernetes.io/ingress.class: azure/application-gateway
    appgw.ingress.kubernetes.io/ssl-redirect: "true"
    appgw.ingress.kubernetes.io/connection-draining: "true"
    appgw.ingress.kubernetes.io/connection-draining-timeout: "30"
    appgw.ingress.kubernetes.io/request-timeout: "30"
    appgw.ingress.kubernetes.io/use-private-ip: "false"
    appgw.ingress.kubernetes.io/waf-policy-for-path: /subscriptions/SUB_ID/resourceGroups/prod-rg/providers/Microsoft.Network/applicationGatewayWebApplicationFirewallPolicies/prod-waf-policy
spec:
  tls:
    - hosts:
        - api.example.com
      secretName: api-tls-secret
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /api/v1
            pathType: Prefix
            backend:
              service:
                name: api-v1-svc
                port:
                  number: 8080
          - path: /api/v2
            pathType: Prefix
            backend:
              service:
                name: api-v2-svc
                port:
                  number: 8080
```

### Path-Based Routing with Backend Health Probes

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api-v1-svc
  namespace: production
  annotations:
    appgw.ingress.kubernetes.io/health-probe-path: "/healthz"
    appgw.ingress.kubernetes.io/health-probe-interval: "30"
    appgw.ingress.kubernetes.io/health-probe-timeout: "5"
    appgw.ingress.kubernetes.io/health-probe-unhealthy-threshold: "3"
spec:
  type: ClusterIP
  selector:
    app: api
    version: v1
  ports:
    - port: 8080
      targetPort: 8080
```

## Section 5: Azure Key Vault Provider for Secrets Store CSI Driver

### Configuration

The Secrets Store CSI Driver with Azure Key Vault provider mounts secrets from Azure Key Vault as volumes in pods. Combined with Workload Identity, no credentials are needed in the cluster.

```bash
# The secret provider add-on is installed during cluster creation
# Verify it's enabled
az aks show \
  --resource-group prod-rg \
  --name prod-aks \
  --query "addonProfiles.azureKeyvaultSecretsProvider" \
  --output yaml
```

```yaml
# SecretProviderClass for Key Vault integration
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: azure-kv-secrets
  namespace: production
spec:
  provider: azure
  secretObjects:
    - secretName: app-secrets
      type: Opaque
      data:
        - objectName: database-password
          key: DB_PASSWORD
        - objectName: api-key
          key: EXTERNAL_API_KEY
  parameters:
    usePodIdentity: "false"
    clientID: APP_IDENTITY_CLIENT_ID_VALUE
    keyvaultName: prod-keyvault
    cloudName: AzurePublicCloud
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
        - |
          objectName: tls-cert
          objectType: secret
          objectVersion: ""
    tenantId: TENANT_ID_VALUE
```

```yaml
# Pod using Key Vault secrets
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: production
spec:
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: app-sa
      volumes:
        - name: kv-secrets
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: azure-kv-secrets
      containers:
        - name: app
          image: myregistry.azurecr.io/my-app:latest
          volumeMounts:
            - name: kv-secrets
              mountPath: /mnt/secrets
              readOnly: true
          envFrom:
            - secretRef:
                name: app-secrets
```

## Section 6: Azure Policy for Kubernetes

### Gatekeeper Integration

Azure Policy for Kubernetes uses OPA Gatekeeper to enforce policies on AKS clusters. Policy assignments in Azure translate into Gatekeeper ConstraintTemplates and Constraints automatically.

```bash
# Enable Azure Policy add-on
az aks enable-addons \
  --resource-group prod-rg \
  --name prod-aks \
  --addons azure-policy

# Verify Gatekeeper components are running
kubectl get pods -n gatekeeper-system
kubectl get constrainttemplate
```

### Built-in Azure Policy Assignments

```bash
# Assign baseline security policy initiative
az policy assignment create \
  --name "aks-baseline-security" \
  --scope /subscriptions/SUB_ID/resourceGroups/prod-rg/providers/Microsoft.ContainerService/managedClusters/prod-aks \
  --policy-set-definition "a8640138-9b0a-4a28-b8cb-1666c838647d" \
  --enforcement-mode Default

# Assign individual policy to require resource limits
az policy assignment create \
  --name "require-resource-limits" \
  --scope /subscriptions/SUB_ID/resourceGroups/prod-rg/providers/Microsoft.ContainerService/managedClusters/prod-aks \
  --policy "e345eecc-fa47-480f-9e88-67dcc122b164" \
  --enforcement-mode Default
```

### Custom Gatekeeper Constraints

```yaml
# Require specific labels on all production deployments
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-team-label
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
      - production
      - staging
  parameters:
    message: "Deployment must have 'team' and 'cost-center' labels"
    labels:
      - key: team
        allowedRegex: "^[a-z][a-z0-9-]+$"
      - key: cost-center
        allowedRegex: "^[A-Z]{2}-[0-9]{4}$"
---
# Block latest tag in production
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sDisallowedTags
metadata:
  name: no-latest-tag-production
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    namespaces:
      - production
  parameters:
    tags:
      - latest
      - ""
```

## Section 7: KEDA with Azure Service Bus

### Installing KEDA

KEDA (Kubernetes Event-Driven Autoscaler) scales workloads based on external event sources including Azure Service Bus, Event Hub, Storage Queues, and more.

```bash
# Install KEDA
helm repo add kedacore https://kedacore.github.io/charts
helm repo update

helm install keda kedacore/keda \
  --namespace keda \
  --create-namespace \
  --set watchNamespace="" \
  --set operator.replicaCount=2 \
  --set metricsServer.replicaCount=2 \
  --set resources.operator.requests.cpu=50m \
  --set resources.operator.requests.memory=100Mi \
  --set resources.operator.limits.cpu=1 \
  --set resources.operator.limits.memory=1000Mi
```

### ScaledObject for Azure Service Bus

```yaml
# Store Service Bus connection string in a secret
# (In production, use Azure Workload Identity instead)
apiVersion: v1
kind: Secret
metadata:
  name: servicebus-auth
  namespace: production
type: Opaque
stringData:
  connection: Endpoint=sb://prod-servicebus.servicebus.windows.net/;SharedAccessKeyName=listen;SharedAccessKey=REPLACE_WITH_YOUR_KEY
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: servicebus-trigger-auth
  namespace: production
spec:
  secretTargetRef:
    - parameter: connection
      name: servicebus-auth
      key: connection
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-processor
  pollingInterval: 30
  cooldownPeriod: 300
  minReplicaCount: 1
  maxReplicaCount: 50
  advanced:
    restoreToOriginalReplicaCount: true
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
          policies:
            - type: Percent
              value: 50
              periodSeconds: 60
        scaleUp:
          stabilizationWindowSeconds: 0
          policies:
            - type: Pods
              value: 10
              periodSeconds: 60
  triggers:
    - type: azure-servicebus
      metadata:
        namespace: prod-servicebus.servicebus.windows.net
        queueName: orders
        messageCount: "5"
        activationMessageCount: "1"
      authenticationRef:
        name: servicebus-trigger-auth
```

### KEDA with Azure Workload Identity

```yaml
# Using Workload Identity for KEDA triggers (no secret required)
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: azure-wi-trigger-auth
  namespace: production
spec:
  podIdentity:
    provider: azure-workload
    identityId: APP_IDENTITY_CLIENT_ID_VALUE
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: event-processor-scaler
  namespace: production
spec:
  scaleTargetRef:
    name: event-processor
  triggers:
    - type: azure-eventhub
      metadata:
        eventHubName: prod-events
        eventHubNamespace: prod-eventhub.servicebus.windows.net
        consumerGroup: event-processor
        storageAccountName: prodkvedastate
        blobContainer: checkpoints
        checkpointStrategy: blobMetadata
      authenticationRef:
        name: azure-wi-trigger-auth
```

## Section 8: AKS Monitoring with Azure Monitor

### Container Insights

```bash
# Enable Container Insights if not done at cluster creation
az aks enable-addons \
  --resource-group prod-rg \
  --name prod-aks \
  --addons monitoring \
  --workspace-resource-id /subscriptions/SUB_ID/resourceGroups/monitoring-rg/providers/Microsoft.OperationalInsights/workspaces/prod-workspace
```

### Log Analytics Queries

```kql
// CPU utilization by namespace over 1 hour
KubePodInventory
| where TimeGenerated > ago(1h)
| where Namespace in ("production", "staging")
| join kind=inner (
    Perf
    | where TimeGenerated > ago(1h)
    | where ObjectName == "K8SContainer"
    | where CounterName == "cpuUsageNanoCores"
    | summarize AvgCPU = avg(CounterValue) by Computer, InstanceName, CounterName
) on Computer
| summarize AvgCPUByNamespace = avg(AvgCPU) by Namespace
| render columnchart

// OOMKilled pods in last 24 hours
KubeEvents
| where TimeGenerated > ago(24h)
| where Reason == "OOMKilling"
| project TimeGenerated, Name, Namespace, Message
| order by TimeGenerated desc

// Failed pods by reason
KubePodInventory
| where TimeGenerated > ago(1h)
| where PodStatus == "Failed"
| summarize Count = count() by PodStatus, Namespace, ContainerStatusReason
| render table
```

### Diagnostic Settings for Control Plane Logs

```bash
# Enable diagnostic settings for AKS control plane logs
az monitor diagnostic-settings create \
  --resource /subscriptions/SUB_ID/resourceGroups/prod-rg/providers/Microsoft.ContainerService/managedClusters/prod-aks \
  --name aks-diagnostics \
  --workspace /subscriptions/SUB_ID/resourceGroups/monitoring-rg/providers/Microsoft.OperationalInsights/workspaces/prod-workspace \
  --logs '[
    {"category": "kube-apiserver", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "kube-audit", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "kube-audit-admin", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}},
    {"category": "kube-controller-manager", "enabled": true, "retentionPolicy": {"days": 30, "enabled": true}},
    {"category": "kube-scheduler", "enabled": true, "retentionPolicy": {"days": 30, "enabled": true}},
    {"category": "cluster-autoscaler", "enabled": true, "retentionPolicy": {"days": 30, "enabled": true}},
    {"category": "cloud-controller-manager", "enabled": true, "retentionPolicy": {"days": 30, "enabled": true}},
    {"category": "guard", "enabled": true, "retentionPolicy": {"days": 90, "enabled": true}}
  ]'
```

### Azure Managed Prometheus and Grafana

```bash
# Enable Azure Monitor managed Prometheus and Grafana
az aks update \
  --resource-group prod-rg \
  --name prod-aks \
  --enable-azure-monitor-metrics \
  --azure-monitor-workspace-resource-id /subscriptions/SUB_ID/resourceGroups/monitoring-rg/providers/microsoft.monitor/accounts/prod-amp-workspace \
  --grafana-resource-id /subscriptions/SUB_ID/resourceGroups/monitoring-rg/providers/Microsoft.Dashboard/grafana/prod-grafana
```

## Section 9: GitOps with Flux on AKS

### Installing Flux via AKS Extension

```bash
# Enable GitOps add-on (Flux v2) on AKS cluster
az k8s-configuration flux create \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --cluster-type managedClusters \
  --name cluster-config \
  --namespace flux-system \
  --scope cluster \
  --url https://github.com/myorg/fleet-gitops.git \
  --branch main \
  --kustomization name=infra path=./clusters/prod-aks/infrastructure prune=true \
  --kustomization name=apps path=./clusters/prod-aks/apps prune=true dependsOn=infra
```

### Flux Kustomization Structure

```
fleet-gitops/
├── clusters/
│   └── prod-aks/
│       ├── infrastructure/
│       │   ├── kustomization.yaml
│       │   ├── namespaces.yaml
│       │   ├── cert-manager/
│       │   ├── external-secrets/
│       │   └── monitoring/
│       └── apps/
│           ├── kustomization.yaml
│           ├── production/
│           │   ├── api-deployment.yaml
│           │   └── web-deployment.yaml
│           └── staging/
└── base/
    ├── api/
    └── web/
```

```yaml
# clusters/prod-aks/infrastructure/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespaces.yaml
  - cert-manager/
  - external-secrets/
  - monitoring/
```

### Flux Image Automation for CD

```yaml
# ImageRepository to watch ACR for new tags
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: api-image
  namespace: flux-system
spec:
  image: myregistry.azurecr.io/api
  interval: 5m
  provider: azure
---
# ImagePolicy to select the latest semver tag
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: api-policy
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: api-image
  policy:
    semver:
      range: ">=1.0.0 <2.0.0"
---
# ImageUpdateAutomation to commit new tag to Git
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageUpdateAutomation
metadata:
  name: prod-image-update
  namespace: flux-system
spec:
  interval: 30m
  sourceRef:
    kind: GitRepository
    name: fleet-gitops
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: fluxcd@example.com
        name: FluxCD
      messageTemplate: "chore: update image tags [skip ci]"
    push:
      branch: main
  update:
    path: ./clusters/prod-aks/apps
    strategy: Setters
```

## Section 10: Upgrading AKS Clusters

### Upgrade Planning

AKS cluster upgrades proceed in stages: control plane first, then each node pool. The `--max-surge` parameter controls how many surge nodes are provisioned during the upgrade to ensure workload continuity.

```bash
# List available upgrades
az aks get-upgrades \
  --resource-group prod-rg \
  --name prod-aks \
  --output table

# Check current cluster version
az aks show \
  --resource-group prod-rg \
  --name prod-aks \
  --query "currentKubernetesVersion" \
  --output tsv
```

### Configuring Upgrade Settings

```bash
# Configure surge count for node pool upgrade
az aks nodepool update \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name apppool \
  --max-surge 33% \
  --drain-timeout 60 \
  --node-soak-duration 5
```

### Performing the Upgrade

```bash
# Upgrade control plane only first
az aks upgrade \
  --resource-group prod-rg \
  --name prod-aks \
  --kubernetes-version 1.31.0 \
  --control-plane-only \
  --no-wait

# Monitor upgrade status
az aks show \
  --resource-group prod-rg \
  --name prod-aks \
  --query "provisioningState"

# Wait for control plane completion
az aks wait \
  --resource-group prod-rg \
  --name prod-aks \
  --updated

# Upgrade system node pool
az aks nodepool upgrade \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name nodepool1 \
  --kubernetes-version 1.31.0 \
  --no-wait

az aks nodepool wait \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name nodepool1 \
  --updated

# Upgrade user node pools after system pool completes
az aks nodepool upgrade \
  --resource-group prod-rg \
  --cluster-name prod-aks \
  --name apppool \
  --kubernetes-version 1.31.0
```

### Auto-Upgrade Channel Configuration

```bash
# Set auto-upgrade to patch channel (recommended for production)
az aks update \
  --resource-group prod-rg \
  --name prod-aks \
  --auto-upgrade-channel patch

# Configure node OS upgrade channel
az aks update \
  --resource-group prod-rg \
  --name prod-aks \
  --node-os-upgrade-channel NodeImage
```

## Section 11: ACR Integration and Image Security

### Attaching ACR to AKS

```bash
# Create Azure Container Registry
az acr create \
  --resource-group prod-rg \
  --name myregistry \
  --sku Premium \
  --admin-enabled false \
  --zone-redundancy enabled

# Attach ACR to AKS (grants AcrPull to kubelet managed identity)
az aks update \
  --resource-group prod-rg \
  --name prod-aks \
  --attach-acr myregistry
```

### Image Scanning with Defender for Containers

```bash
# Enable Microsoft Defender for Containers
az security pricing create \
  --name Containers \
  --tier Standard

# Enable ACR image scanning
az acr update \
  --name myregistry \
  --resource-group prod-rg \
  --sku Premium

# Defender for Containers automatically scans images pushed to ACR Premium
# View vulnerability findings
az security assessment list \
  --query "[?displayName=='Container Registry images should have vulnerability findings resolved']" \
  --output table
```

## Section 12: Network Policies with Cilium

### Advanced Network Policies

When using Azure CNI Overlay with Cilium dataplane, extended network policy features become available including L7 policies and FQDN-based egress filtering.

```yaml
# Allow only specific external FQDNs from production pods
apiVersion: "cilium.io/v2"
kind: CiliumNetworkPolicy
metadata:
  name: production-egress-policy
  namespace: production
spec:
  endpointSelector:
    matchLabels:
      app: api
  egress:
    - toFQDNs:
        - matchName: "api.example.com"
        - matchName: "db.example.com"
        - matchPattern: "*.azure.com"
    - toEndpoints:
        - matchLabels:
            k8s:io.kubernetes.pod.namespace: kube-system
      toPorts:
        - ports:
            - port: "53"
              protocol: UDP
          rules:
            dns:
              - matchPattern: "*"
    - toEndpoints:
        - {}
      toPorts:
        - ports:
            - port: "5432"
              protocol: TCP
```

## Section 13: Cluster Hardening and Security

### Azure AD Integration and RBAC

```bash
# Enable Azure AD integration with Kubernetes RBAC
az aks update \
  --resource-group prod-rg \
  --name prod-aks \
  --enable-aad \
  --enable-azure-rbac

# Create ClusterRoleBinding for Azure AD group
GROUP_OBJECT_ID=$(az ad group show \
  --group "AKS Prod Admins" \
  --query id \
  --output tsv)
```

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: aks-prod-admins
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: GROUP_OBJECT_ID_VALUE
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: prod-namespace-edit
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: DEVELOPER_GROUP_OBJECT_ID_VALUE
```

### Pod Security Admission

```bash
# Apply restricted pod security standard to production namespace
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.31 \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted
```

## Section 14: Disaster Recovery

### Velero for AKS Backup

```bash
# Create storage account for Velero backups
az storage account create \
  --name prodaksbackups \
  --resource-group prod-rg \
  --location eastus \
  --sku Standard_GRS \
  --kind StorageV2

az storage container create \
  --name velero-backups \
  --account-name prodaksbackups

# Install Velero with Azure plugin
velero install \
  --provider azure \
  --plugins velero/velero-plugin-for-microsoft-azure:v1.10.0 \
  --bucket velero-backups \
  --secret-file ./credentials-velero \
  --backup-location-config \
    resourceGroup=prod-rg,storageAccount=prodaksbackups,subscriptionId=SUB_ID \
  --snapshot-location-config \
    apiTimeout=5m,resourceGroup=prod-rg,subscriptionId=SUB_ID \
  --use-node-agent \
  --default-volumes-to-fs-backup

# Create scheduled backup
velero schedule create daily-production-backup \
  --schedule "0 2 * * *" \
  --include-namespaces production,staging \
  --ttl 720h \
  --storage-location default
```

## Section 15: Production Readiness Checklist

**Cluster Architecture:**
- Private cluster enabled with private DNS zone
- Availability zones configured for node pools
- System and user node pools separated with appropriate taints
- Azure CNI Overlay for pod IP efficiency
- Auto-upgrade channel set to patch with maintenance windows

**Security:**
- Azure Workload Identity replacing pod identity
- Azure Key Vault provider for secret injection
- Azure Policy add-on with Gatekeeper enforcement
- Microsoft Defender for Containers enabled
- Azure AD RBAC integration
- Private registry with ACR and AcrPull for kubelet identity
- Pod Security Standards enforced per namespace

**Networking:**
- AGIC provisioning Application Gateway with WAF
- Cilium network policy enforced in production namespaces
- Private endpoints for Azure PaaS services used by cluster workloads

**Reliability:**
- PodDisruptionBudgets for all critical workloads
- Cluster autoscaler on user node pools
- KEDA for event-driven scaling
- Velero scheduled backups with cross-region replication
- Liveness, readiness, and startup probes on all containers

**Observability:**
- Container Insights with Log Analytics workspace
- Control plane diagnostic logs enabled (90-day retention)
- Azure Managed Prometheus with Grafana
- Alert rules for node resource saturation and pod failure rates
- Cost allocation tags applied for chargeback

**GitOps:**
- Flux v2 managing all cluster configuration from Git
- Image update automation for continuous delivery
- Separate Kustomization layers for infrastructure and applications
