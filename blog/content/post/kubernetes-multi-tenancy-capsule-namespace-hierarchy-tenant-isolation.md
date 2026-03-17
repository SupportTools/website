---
title: "Kubernetes Multi-Tenancy with Capsule: Namespace Hierarchy and Tenant Isolation"
date: 2031-01-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Tenancy", "Capsule", "Namespace", "RBAC", "Network Policy", "Tenant Isolation"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to implementing Kubernetes multi-tenancy with the Capsule operator, covering Tenant CRDs, namespace quotas, network policy injection, ingress class restriction, and RBAC delegation."
more_link: "yes"
url: "/kubernetes-multi-tenancy-capsule-namespace-hierarchy-tenant-isolation/"
---

Multi-tenancy in Kubernetes means allowing multiple teams or customers to share a single cluster while maintaining strong isolation between them. The native Kubernetes primitives — namespaces, RBAC, and NetworkPolicy — provide the building blocks, but assembling them correctly across dozens of tenants is operationally expensive and error-prone. Capsule automates this assembly through a Tenant abstraction that enforces isolation policies at admission time. This guide covers Capsule's architecture, Tenant configuration, namespace quotas, network isolation, and the RBAC delegation model for enterprise clusters.

<!--more-->

# Kubernetes Multi-Tenancy with Capsule: Namespace Hierarchy and Tenant Isolation

## Section 1: Why Namespace-Per-Tenant Is Not Enough

The naive multi-tenancy model allocates one namespace per team and adds RBAC roles. This breaks down at scale for several reasons:

- **No resource ceiling**: Tenant A's pods can consume the entire cluster's CPU/memory.
- **No network isolation**: Pods in tenant-a can reach pods in tenant-b unless you manually create NetworkPolicies.
- **No ingress class restriction**: Tenant A can create Ingress resources using a reserved ingress class.
- **Namespace proliferation**: Large tenants need multiple namespaces for staging/production separation, but there is no group-level quota.
- **Manual toil**: Each new tenant requires creating RBAC roles, NetworkPolicies, LimitRanges, and ResourceQuotas manually.

Capsule solves these problems with the `Tenant` custom resource, which groups namespaces under a single administrative entity and enforces policies via admission webhooks.

## Section 2: Capsule Architecture

Capsule consists of:

1. **Capsule Controller Manager**: Watches `Tenant` objects and creates/updates child resources (RBAC bindings, LimitRanges, ResourceQuotas, NetworkPolicies, annotations).
2. **Capsule Webhook Server**: Validates and mutates incoming API requests to enforce tenant policies at admission time.
3. **Tenant CRD**: Defines the complete policy set for a group of namespaces.
4. **CapsuleConfiguration**: Cluster-wide operator settings.

### Installation via Helm

```bash
# Add the Capsule Helm repository
helm repo add projectcapsule https://projectcapsule.github.io/capsule
helm repo update

# Create the namespace
kubectl create namespace capsule-system

# Install Capsule with production-grade settings
helm install capsule projectcapsule/capsule \
  --namespace capsule-system \
  --set manager.resources.requests.cpu=200m \
  --set manager.resources.requests.memory=128Mi \
  --set manager.resources.limits.cpu=1000m \
  --set manager.resources.limits.memory=256Mi \
  --set manager.replicaCount=2 \
  --set webhooks.exclusive=true \
  --set webhooks.enableOwnerReference=true \
  --version 0.7.0

# Verify installation
kubectl get pods -n capsule-system
kubectl get crd | grep capsule
```

### CapsuleConfiguration

```yaml
# capsule-configuration.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: CapsuleConfiguration
metadata:
  name: default
spec:
  # Label applied to user groups that are treated as tenant owners
  userGroups:
  - capsule.clastix.io/group
  # Protection label prevents accidental deletion of tenant namespaces
  protectedNamespaceRegex: ""
  # Deny WILDCARD service account token mounts
  enableTLSRecognition: true
  # Force namespace labels set by Capsule to be immutable
  forceTenantPrefix: true
  # Namespace prefix format: <tenant-name>-<namespace-name>
  # Prevents cross-tenant namespace name collisions
```

## Section 3: Creating Tenants

### Basic Tenant

```yaml
# tenant-team-alpha.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: team-alpha
spec:
  # Tenant owners — these users/groups get admin access to all tenant namespaces
  owners:
  - name: alice@corp.example.com
    kind: User
  - name: team-alpha-leads
    kind: Group
  # Namespace quota — maximum namespaces this tenant can create
  namespaceOptions:
    quota: 5
    # Enforce namespace naming: all namespaces must start with "alpha-"
    # (when forceTenantPrefix is true in CapsuleConfiguration)
  # Node selector — tenant pods can only run on nodes with this label
  nodeSelector:
    node-pool: standard
```

### Apply and verify:

```bash
kubectl apply -f tenant-team-alpha.yaml

# Check tenant status
kubectl get tenant team-alpha
# NAME          STATE    NAMESPACE QUOTA   NAMESPACE COUNT   NODE SELECTOR           AGE
# team-alpha    Active   5                 0                 {"node-pool":"standard"}  30s

# View detailed status
kubectl describe tenant team-alpha
```

### Creating a Namespace as a Tenant Owner

With `forceTenantPrefix: true`, tenant owners create namespaces with their tenant name as prefix:

```bash
# As alice@corp.example.com (tenant owner of team-alpha)
kubectl create namespace alpha-production
kubectl create namespace alpha-staging
kubectl create namespace alpha-dev

# Capsule automatically:
# 1. Labels the namespace with capsule.clastix.io/tenant=team-alpha
# 2. Creates RBAC RoleBindings for alice and team-alpha-leads
# 3. Applies LimitRange, ResourceQuota, NetworkPolicy from Tenant spec
# 4. Injects node selector as namespace annotation
```

## Section 4: Resource Quotas and LimitRanges

Capsule propagates ResourceQuota and LimitRange objects to every namespace owned by a tenant. Changes to the Tenant spec are automatically synced to existing namespaces.

### Per-Namespace Quotas

```yaml
# tenant-with-quotas.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: team-beta
spec:
  owners:
  - name: bob@corp.example.com
    kind: User

  namespaceOptions:
    quota: 10

  # ResourceQuota applied to each namespace
  resourceQuotas:
    scope: Namespace
    items:
    - hard:
        requests.cpu: "8"
        requests.memory: 16Gi
        limits.cpu: "16"
        limits.memory: 32Gi
        pods: "50"
        services: "20"
        persistentvolumeclaims: "10"
        requests.storage: 500Gi
        count/configmaps: "100"
        count/secrets: "50"
        count/services.loadbalancers: "2"
        count/services.nodeports: "0"
    - hard:
        # Separate quota object for object count
        count/deployments.apps: "30"
        count/statefulsets.apps: "10"
        count/jobs.batch: "20"

  # LimitRange applied to each namespace
  limitRanges:
    items:
    - limits:
      - type: Container
        default:
          cpu: 500m
          memory: 512Mi
        defaultRequest:
          cpu: 100m
          memory: 128Mi
        max:
          cpu: "4"
          memory: 8Gi
        min:
          cpu: 10m
          memory: 16Mi
      - type: Pod
        max:
          cpu: "8"
          memory: 16Gi
      - type: PersistentVolumeClaim
        max:
          storage: 100Gi
        min:
          storage: 1Gi
```

### Tenant-Level Global Quota

For tenants spanning multiple namespaces, a global quota caps aggregate usage across all tenant namespaces:

```yaml
# tenant-global-quota.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: enterprise-customer-1
spec:
  owners:
  - name: enterprise-1-admin
    kind: Group

  namespaceOptions:
    quota: 20

  resourceQuotas:
    scope: Tenant
    items:
    - hard:
        # These limits apply to the ENTIRE tenant, not per namespace
        requests.cpu: "100"
        requests.memory: 200Gi
        limits.cpu: "200"
        limits.memory: 400Gi
        requests.storage: 10Ti
        pods: "500"
```

## Section 5: Network Policy Injection

Capsule injects NetworkPolicy objects into tenant namespaces automatically, enabling default-deny and tenant isolation without manual policy creation.

### Default Deny with Tenant-Internal Traffic Allowed

```yaml
# tenant-with-network-policies.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: isolated-tenant
spec:
  owners:
  - name: charlie@corp.example.com
    kind: User

  networkPolicies:
    items:
    # Policy 1: Default deny all ingress and egress
    - policyTypes:
      - Ingress
      - Egress
      podSelector: {}
      ingress: []
      egress: []

    # Policy 2: Allow intra-tenant traffic (between this tenant's namespaces)
    - policyTypes:
      - Ingress
      - Egress
      podSelector: {}
      ingress:
      - from:
        - namespaceSelector:
            matchLabels:
              capsule.clastix.io/tenant: isolated-tenant
      egress:
      - to:
        - namespaceSelector:
            matchLabels:
              capsule.clastix.io/tenant: isolated-tenant

    # Policy 3: Allow DNS resolution (required for service discovery)
    - policyTypes:
      - Egress
      podSelector: {}
      egress:
      - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53

    # Policy 4: Allow access from the monitoring namespace
    - policyTypes:
      - Ingress
      podSelector: {}
      ingress:
      - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
```

### Shared Services Access Pattern

Tenants frequently need access to shared services (databases, message queues, internal APIs) in dedicated namespaces:

```yaml
# Allow access to shared Kafka cluster in kafka-system namespace
    - policyTypes:
      - Egress
      podSelector: {}
      egress:
      - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kafka-system
        ports:
        - protocol: TCP
          port: 9092
        - protocol: TCP
          port: 9093
      # Allow access to internal API gateway
      - to:
        - namespaceSelector:
            matchLabels:
              service-tier: gateway
        ports:
        - protocol: TCP
          port: 443
```

## Section 6: Ingress Class Restriction

Without ingress class controls, any tenant can create an Ingress using the production ingress class, which could route traffic to internal services or exhaust certificates.

```yaml
# tenant-ingress-restriction.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: web-tenant
spec:
  owners:
  - name: webteam
    kind: Group

  # Restrict which IngressClasses this tenant can use
  ingressOptions:
    # Allowed classes (exact match or regex)
    allowedClasses:
      exact:
      - nginx-tenant
      - nginx-internal
    # Default ingress class assigned if none specified
    allowedHostnames:
      regex: "^.*\\.tenant\\.example\\.com$"
      exact:
      - "api.tenant.example.com"
      - "app.tenant.example.com"
    # Prevent hostname collision with other tenants
    # Each tenant can only use hostnames that match their allowed pattern
    hostnameCollisionScope: Cluster
```

### Storage Class Restriction

```yaml
  storageClasses:
    allowed:
      exact:
      - standard-tenant
      - standard-tenant-xfs
    default: standard-tenant
```

### Priority Class Restriction

```yaml
  priorityClasses:
    allowed:
      exact:
      - tenant-default
      - tenant-high
    default: tenant-default
```

## Section 7: RBAC Delegation to Tenant Admins

Capsule creates ClusterRole and RoleBinding objects that give tenant owners admin access scoped to their namespaces. Tenant owners can further delegate within their namespaces.

### What Tenant Owners Get By Default

Capsule creates a `capsule-<tenant-name>-owner` ClusterRole that allows:
- Full management of namespaces within the tenant
- Create/update/delete workloads within tenant namespaces
- Manage ServiceAccounts, Secrets, ConfigMaps within tenant namespaces
- Manage networking resources (Services, Ingresses) within tenant namespaces

### Custom Additional Roles

```yaml
# tenant-with-custom-rbac.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: platform-tenant
spec:
  owners:
  - name: platform-admin@corp.example.com
    kind: User
    # Give this owner cluster-scoped read permissions in addition to tenant admin
    clusterRoles:
    - view
    - capsule-namespace-deleter

  # Additional users with read-only access to all tenant namespaces
  additionalRoleBindings:
  - clusterRoleName: view
    subjects:
    - name: platform-developers
      kind: Group
      apiGroup: rbac.authorization.k8s.io
  # Allow specific service accounts to read secrets
  - clusterRoleName: secret-reader
    subjects:
    - name: ci-bot
      kind: ServiceAccount
      namespace: platform-ci
```

### Tenant Owner Self-Service: Creating Sub-Users

Once a tenant owner has their admin access, they can create RoleBindings within their namespaces without involving cluster admins:

```bash
# As tenant owner alice@corp.example.com
# Grant developer role to a team member in a specific namespace
kubectl create rolebinding dev-alice-in-prod \
  --clusterrole=edit \
  --user=developer@corp.example.com \
  --namespace=alpha-production

# Grant view-only to QA team in staging namespace
kubectl create rolebinding qa-view \
  --clusterrole=view \
  --group=qa-team \
  --namespace=alpha-staging
```

The Capsule webhook validates these operations and rejects any attempt to grant permissions beyond what the tenant owner themselves has.

## Section 8: Tenant Node Affinity and Taints

Capsule can enforce that tenant workloads only run on designated node pools:

```yaml
# tenant-dedicated-nodes.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: gpu-tenant
spec:
  owners:
  - name: ml-team
    kind: Group

  # Force all pods in this tenant to have this node selector
  # Capsule injects this into all pods via mutating webhook
  nodeSelector:
    dedicated: ml-workloads
    accelerator: nvidia-a100

  # Toleration automatically injected into all tenant pods
  runtimeClasses:
    allowed:
      exact:
      - nvidia
    default: nvidia
```

### Preventing Node Selector Override

Without Capsule, a tenant could bypass node selectors by overriding them in the pod spec. Capsule's mutating webhook enforces node selectors as immutable for tenant pods:

```bash
# This command as a tenant user will be REJECTED by Capsule webhook:
kubectl run my-pod --image=nginx \
  --overrides='{"spec":{"nodeSelector":{"dedicated":"other-pool"}}}' \
  -n alpha-production

# Error from Capsule:
# Error from server: admission webhook "node-selector.capsule.clastix.io" denied the request:
# cannot modify nodeSelector: dedicated=ml-workloads is required
```

## Section 9: Tenant Status and Observability

### Monitoring Tenant Health

```bash
# List all tenants with status
kubectl get tenants

# Example output:
# NAME                 STATE    NAMESPACE QUOTA   NAMESPACE COUNT   AGE
# team-alpha           Active   5                 3                 30d
# team-beta            Active   10                7                 45d
# enterprise-1         Active   20                15                90d
# gpu-tenant           Active   5                 2                 15d

# Check a tenant's namespace list
kubectl get namespaces -l capsule.clastix.io/tenant=team-alpha

# Describe tenant for full status
kubectl describe tenant team-alpha

# Check quota usage across all tenant namespaces
for ns in $(kubectl get ns -l capsule.clastix.io/tenant=team-alpha -o name | cut -d/ -f2); do
  echo "=== $ns ==="
  kubectl describe resourcequota -n "$ns"
done
```

### Prometheus Metrics

Capsule exposes Prometheus metrics for monitoring tenant health:

```yaml
# prometheus-servicemonitor.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: capsule-metrics
  namespace: capsule-system
  labels:
    app.kubernetes.io/name: capsule
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: capsule
  endpoints:
  - port: metrics
    scheme: http
    path: /metrics
    interval: 30s
```

Key metrics to monitor:
```
# Tenant namespace count by tenant
capsule_tenant_namespace_count{tenant="team-alpha"} 3

# Tenant resource quota usage
capsule_tenant_resource_quota_used{tenant="team-alpha", resource="pods"} 42

# Webhook request count and latency
capsule_webhook_request_total{webhook="namespace-owner-reference", code="200"} 1234
capsule_webhook_request_duration_seconds_bucket{webhook="node-selector"} ...
```

## Section 10: Advanced — GlobalTenantResource for Cross-Namespace Sharing

Capsule's `GlobalTenantResource` CRD allows platform admins to inject additional resources into all tenant namespaces — useful for sharing ConfigMaps, Secrets (e.g., image pull secrets), or custom resources.

```yaml
# global-tenant-resource-imagepullsecret.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: GlobalTenantResource
metadata:
  name: registry-pull-secret
spec:
  # Inject into all tenant namespaces
  tenantSelector: {}  # empty = all tenants
  resources:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: registry-pull-secret
    # Sync source from this namespace
    namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: registry-secrets
    # The actual secret data is referenced by name, not inlined
    resyncPeriod: 60s
```

### TenantResource for Per-Tenant Injection

```yaml
# tenant-resource-monitoring-config.yaml
apiVersion: capsule.clastix.io/v1beta2
kind: TenantResource
metadata:
  name: monitoring-scrape-config
  namespace: alpha-production  # must be a tenant namespace
spec:
  resources:
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: prometheus-scrape-config
    data:
      scrape.yaml: |
        job_name: alpha-production-apps
        kubernetes_sd_configs:
        - role: pod
          namespaces:
            own: true
        relabel_configs:
        - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
          action: keep
          regex: true
  resyncPeriod: 300s
  pruningOnDelete: true
```

## Section 11: Capsule Proxy — Self-Service Namespace Creation

Capsule Proxy allows tenant owners to list and create resources without direct cluster API access. This is critical for air-gapped or security-sensitive environments.

```bash
# Install Capsule Proxy
helm install capsule-proxy projectcapsule/capsule-proxy \
  --namespace capsule-system \
  --set replicaCount=2 \
  --set service.type=ClusterIP \
  --set options.additionalPaths[0]=/api/v1/namespaces

# Tenant owner creates namespace via Capsule Proxy (not direct API server):
# Set kubeconfig to point to capsule-proxy
kubectl --server=https://capsule-proxy.capsule-system:9001 \
  create namespace alpha-new-env

# Capsule Proxy validates tenant ownership before forwarding to API server
```

## Section 12: Production Operational Patterns

### Tenant Lifecycle Management Script

```bash
#!/bin/bash
# create-tenant.sh — Create a new Capsule tenant with standard policies
# Usage: ./create-tenant.sh <tenant-name> <owner-email> <namespace-quota> <cpu-limit> <memory-limit>

set -euo pipefail

TENANT_NAME=$1
OWNER_EMAIL=$2
NAMESPACE_QUOTA=${3:-5}
CPU_LIMIT=${4:-32}
MEMORY_LIMIT=${5:-64Gi}

cat <<EOF | kubectl apply -f -
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: ${TENANT_NAME}
  labels:
    provisioned-by: platform-team
    provisioned-date: "$(date -I)"
spec:
  owners:
  - name: ${OWNER_EMAIL}
    kind: User
  namespaceOptions:
    quota: ${NAMESPACE_QUOTA}
  resourceQuotas:
    scope: Tenant
    items:
    - hard:
        requests.cpu: "${CPU_LIMIT}"
        requests.memory: "${MEMORY_LIMIT}"
        limits.cpu: "$((CPU_LIMIT * 2))"
        limits.memory: "${MEMORY_LIMIT}"
        pods: "200"
  limitRanges:
    items:
    - limits:
      - type: Container
        default:
          cpu: 500m
          memory: 512Mi
        defaultRequest:
          cpu: 100m
          memory: 128Mi
        max:
          cpu: "4"
          memory: 8Gi
  networkPolicies:
    items:
    - policyTypes:
      - Ingress
      - Egress
      podSelector: {}
      ingress:
      - from:
        - namespaceSelector:
            matchLabels:
              capsule.clastix.io/tenant: ${TENANT_NAME}
      egress:
      - to:
        - namespaceSelector:
            matchLabels:
              capsule.clastix.io/tenant: ${TENANT_NAME}
      - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        ports:
        - protocol: UDP
          port: 53
EOF

echo "Tenant ${TENANT_NAME} created for owner ${OWNER_EMAIL}"
echo "Owner can now create namespaces prefixed with '${TENANT_NAME}-'"
```

### Audit Logging for Tenant Actions

```yaml
# audit-policy.yaml — Log all Capsule webhook events
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
# Log all Tenant object changes at Request level
- level: Request
  resources:
  - group: capsule.clastix.io
    resources: ["tenants", "tenants/status"]
  verbs: ["create", "update", "patch", "delete"]

# Log namespace creation/deletion (tenant owner activities)
- level: Request
  resources:
  - group: ""
    resources: ["namespaces"]
  verbs: ["create", "delete"]

# Log quota violations (admission denials)
- level: Request
  verbs: ["create", "update"]
  omitStages: ["RequestReceived"]
```

### Capacity Planning with Tenant Quotas

```bash
# Show total allocated quota vs cluster capacity
kubectl get resourcequota -A -o json | jq '
  [.items[] | {
    namespace: .metadata.namespace,
    tenant: .metadata.labels."capsule.clastix.io/tenant",
    cpu_hard: .spec.hard."requests.cpu",
    memory_hard: .spec.hard."requests.memory",
    cpu_used: .status.used."requests.cpu",
    memory_used: .status.used."requests.memory"
  }] | group_by(.tenant) | map({
    tenant: .[0].tenant,
    namespaces: length,
    total_cpu_hard: [.[].cpu_hard] | map(tonumber? // 0) | add,
    total_memory_hard: [.[].memory_hard] | length
  })'
```

## Summary

Capsule transforms Kubernetes multi-tenancy from a manual, error-prone process into a declarative, policy-driven system. The key operational advantages over raw namespace-based multi-tenancy are:

- **Automatic policy propagation**: NetworkPolicies, LimitRanges, and ResourceQuotas are created in every new namespace without manual intervention.
- **Admission-time enforcement**: Node selectors, ingress classes, and storage classes are validated at admission time, not just audited post-hoc.
- **Tenant-level quotas**: Global CPU/memory limits span all tenant namespaces, preventing quota splitting attacks.
- **Self-service with guardrails**: Tenant owners manage their own namespaces and RBAC without cluster-admin escalation.

For enterprises migrating to multi-tenant Kubernetes, the recommended path is to install Capsule, define a standard Tenant template for your organization, automate tenant onboarding with a script or GitOps workflow, and use Capsule Proxy to provide self-service access without exposing the API server directly.
