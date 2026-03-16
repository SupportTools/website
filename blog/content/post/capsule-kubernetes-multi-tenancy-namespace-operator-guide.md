---
title: "Capsule: Kubernetes Multi-Tenancy with Namespace Operator and Tenant CRDs"
date: 2027-01-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Tenancy", "Capsule", "Namespace", "Platform Engineering"]
categories: ["Kubernetes", "Platform Engineering", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Capsule multi-tenancy operator: Tenant CRDs, namespace inheritance, resource quotas, network policy enforcement, allowed registries, CapsuleProxy, and migration from raw namespaces."
more_link: "yes"
url: "/capsule-kubernetes-multi-tenancy-namespace-operator-guide/"
---

Platform teams operating shared Kubernetes clusters face a recurring tension: granting application teams enough autonomy to move fast while enforcing the governance guardrails that security and finance require. **Capsule** solves this by wrapping standard Kubernetes primitives — namespaces, RBAC, ResourceQuotas, NetworkPolicies — inside a single **Tenant** custom resource that platform engineers control and tenant owners consume through a self-service workflow.

<!--more-->

## Capsule vs vCluster vs Hierarchical Namespaces

Before committing to any multi-tenancy tool, understanding the tradeoffs across the three dominant approaches saves expensive migrations later.

```
Isolation Spectrum

Low overhead ◄─────────────────────────────────► High isolation
  Capsule          HNC             vCluster
  (namespace       (namespace      (virtual
  grouping +       trees +         control plane
  policy gate)     propagation)    per tenant)
```

**Capsule** groups one or more namespaces under a single Tenant object and enforces policies at the group boundary. Tenants share the host cluster control plane and node pool. The overhead is near zero — Capsule itself is a single controller deployment consuming roughly 50 MB of memory under normal load.

**vCluster** provisions a full virtual Kubernetes API server per tenant running inside the host cluster. Each tenant gets their own CRDs, admission webhooks, and cluster-scoped resources. The isolation is stronger but the operational cost per tenant is significant: each virtual cluster consumes an additional API server pod and etcd instance.

**Hierarchical Namespace Controller (HNC)** focuses purely on namespace tree propagation. It does not enforce admission policies, quota hierarchies, or allowed image registries. HNC complements Capsule but does not replace it.

**When to choose Capsule:**
- Tenant count exceeds 20 (vCluster overhead becomes prohibitive)
- Tenants are internal teams who do not need custom CRDs
- Platform team wants a single pane of glass over all tenants
- Compliance requires enforced image registry restrictions per team

## Capsule Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  Kubernetes Cluster                      │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │              capsule-controller-manager           │  │
│  │  ┌──────────────────┐  ┌───────────────────────┐ │  │
│  │  │  Tenant Reconciler│  │  Webhook (admission)  │ │  │
│  │  └──────────────────┘  └───────────────────────┘ │  │
│  └──────────────────────────────────────────────────┘  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Tenant: A   │  │  Tenant: B   │  │  Tenant: C   │  │
│  │  ns: a-dev   │  │  ns: b-dev   │  │  ns: c-prod  │  │
│  │  ns: a-stg   │  │  ns: b-stg   │  │              │  │
│  │  ns: a-prod  │  │  ns: b-prod  │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

The **admission webhook** is the enforcement point. Every CREATE/UPDATE request targeting namespaces within a tenant passes through it, allowing Capsule to enforce registry restrictions, storage class limits, and ingress class restrictions before the request reaches etcd.

## Installation

### Helm Installation

```bash
helm repo add projectcapsule https://projectcapsule.dev/charts
helm repo update

helm install capsule projectcapsule/capsule \
  --namespace capsule-system \
  --create-namespace \
  --version 0.7.3 \
  --set manager.options.forceTenantPrefix=true \
  --set manager.options.protectedNamespaceRegex='^(kube-.*|capsule-system|cert-manager|monitoring)$'
```

**`forceTenantPrefix`** — when enabled, every namespace created by a tenant owner is automatically prefixed with the tenant name (e.g., `alice-production`). This prevents namespace collisions across tenants and makes namespace ownership immediately visible in `kubectl get ns`.

**`protectedNamespaceRegex`** — namespaces matching this pattern cannot be claimed by any tenant. Always include your platform namespaces here.

### Verify Installation

```bash
kubectl -n capsule-system get pods
kubectl get crd tenants.capsule.clastix.io
kubectl get crd capsuleconfigurations.capsule.clastix.io
```

### Global Capsule Configuration

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: CapsuleConfiguration
metadata:
  name: default
spec:
  # Usernames that capsule treats as tenant owners (supports OIDC groups)
  userGroups:
    - capsule.clastix.io
  # Maximum number of namespaces a single tenant may create (cluster-wide default)
  # Individual tenants can override this downward only
  forceTenantPrefix: true
  protectedNamespaceRegex: "^(kube-.*|capsule-system|cert-manager|monitoring|logging|ingress-nginx)$"
```

Apply with `kubectl apply -f capsule-config.yaml`.

## Tenant CRD Structure

The **Tenant** custom resource is the core object. A minimal production Tenant looks like:

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: oil-company
spec:
  # One or more owners — Kubernetes users or groups
  owners:
    - name: alice
      kind: User
    - name: oil-company-admins
      kind: Group

  # Namespace quota
  namespaceOptions:
    quota: 10
    additionalMetadata:
      labels:
        cost-center: "cc-4421"
        data-classification: "confidential"
      annotations:
        contact: "platform-team@example.com"

  # Resource budgets applied to every namespace in this tenant
  resourceQuotas:
    scope: Tenant          # "Tenant" sums across all namespaces; "Namespace" applies per-namespace
    items:
      - hard:
          requests.cpu: "40"
          requests.memory: 80Gi
          limits.cpu: "80"
          limits.memory: 160Gi
          pods: "200"
          services: "50"
          persistentvolumeclaims: "20"

  limitRanges:
    items:
      - limits:
          - type: Pod
            max:
              cpu: "8"
              memory: 16Gi
            min:
              cpu: 50m
              memory: 64Mi
          - type: Container
            default:
              cpu: 500m
              memory: 512Mi
            defaultRequest:
              cpu: 100m
              memory: 128Mi
            max:
              cpu: "8"
              memory: 16Gi
```

### Namespace Quota Scopes

**`scope: Tenant`** — the quota is the aggregate across all namespaces belonging to the tenant. A tenant with a 40 CPU quota cannot exceed 40 CPUs total regardless of how many namespaces it has. This is the recommended mode for cost governance.

**`scope: Namespace`** — each namespace in the tenant receives its own independent quota. Useful when namespaces represent distinct environments with different sizing requirements.

## Allowed Registries

Unrestricted image pulls expose clusters to supply-chain attacks. Capsule enforces an allowlist of container registries at admission time.

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: oil-company
spec:
  owners:
    - name: alice
      kind: User
  containerRegistries:
    allowed:
      - "registry.example.com"
      - "ghcr.io/oil-company"
    allowedRegex: "^(public\\.ecr\\.aws/|registry\\.example\\.com/).*"
```

Any Pod submitted to a tenant namespace that references an image outside the allowlist is rejected at the webhook with a clear error message:

```
Error from server (Forbidden): admission webhook "namespace.capsule.clastix.io" denied the request:
  Container image docker.io/library/nginx:latest is not allowed for tenant oil-company.
  Allowed registries: registry.example.com, ghcr.io/oil-company
```

## Storage Class Restrictions

Tenants should only be allowed to claim storage from classes appropriate to their tier.

```yaml
spec:
  storageClasses:
    allowed:
      - "gp3-encrypted"
      - "gp3-standard"
    allowedRegex: "^gp3-.*"
```

Any PersistentVolumeClaim requesting a StorageClass not in the allowlist is denied. This prevents tenants from inadvertently provisioning expensive SSD storage when spinning up test workloads.

## Ingress Class Restrictions

Multi-tenant clusters typically run multiple ingress controllers — one for external traffic, one for internal traffic. Capsule confines each tenant to specific ingress classes:

```yaml
spec:
  ingressOptions:
    allowedClasses:
      allowed:
        - "nginx-internal"
      allowedRegex: "^nginx-.*"
    allowedHostnames:
      allowed:
        - "*.oil-company.internal"
        - "*.oil-company.example.com"
      allowedRegex: "^.*\\.oil-company\\.(internal|example\\.com)$"
    hostnameCollisionScope: Tenant   # prevents hostname conflicts within a tenant
```

**`hostnameCollisionScope`** options:
- `Disabled` — no collision checking
- `Tenant` — prevents two Ingress objects in the same tenant from claiming the same hostname
- `Cluster` — prevents any two Ingress objects cluster-wide from claiming the same hostname

## Network Policy Per Tenant

Capsule can inject baseline NetworkPolicies into every namespace a tenant creates. This is the mechanism for enforcing tenant isolation without requiring tenant owners to manage network policies themselves.

```yaml
spec:
  networkPolicies:
    items:
      # Deny all ingress from other tenants
      - ingress:
          - from:
              - namespaceSelector:
                  matchLabels:
                    capsule.clastix.io/tenant: oil-company
        podSelector: {}
        policyTypes:
          - Ingress
      # Allow DNS egress
      - egress:
          - ports:
              - port: 53
                protocol: UDP
              - port: 53
                protocol: TCP
        podSelector: {}
        policyTypes:
          - Egress
      # Allow egress within tenant namespaces
      - egress:
          - to:
              - namespaceSelector:
                  matchLabels:
                    capsule.clastix.io/tenant: oil-company
        podSelector: {}
        policyTypes:
          - Egress
```

Capsule automatically labels every tenant namespace with `capsule.clastix.io/tenant: <tenant-name>`, making namespace selectors in NetworkPolicy straightforward.

## RBAC and Service Account Mapping

### Tenant Owner Roles

Capsule grants tenant owners the `admin` ClusterRole scoped to each namespace in their tenant via automatically created RoleBindings:

```yaml
# Capsule creates this automatically in every tenant namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: capsule-alice-admin
  namespace: oil-company-production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: User
    name: alice
```

### Additional RBAC in Tenant Spec

Beyond the default admin binding, platform teams can inject custom ClusterRole bindings:

```yaml
spec:
  additionalRoleBindings:
    - clusterRoleName: "view"
      subjects:
        - kind: Group
          name: "oil-company-readonly"
          apiGroup: rbac.authorization.k8s.io
    - clusterRoleName: "custom-deploy-role"
      subjects:
        - kind: ServiceAccount
          name: "ci-deployer"
          namespace: "oil-company-ci"
```

### Image Pull Secrets

Rather than requiring tenant owners to configure image pull secrets in every namespace, Capsule propagates them automatically:

```yaml
spec:
  imagePullPolicies:
    - Always
  # Inject pull secrets into every namespace
  imagePullSecrets:
    - name: registry-credentials
```

The secret `registry-credentials` must exist in a namespace that Capsule can read. The recommended pattern is to store it in `capsule-system` and reference it via the tenant spec. Capsule copies it into each tenant namespace on creation and keeps it synchronized.

## GlobalTenant and Cross-Tenant Resources

**GlobalTenantResource** allows platform teams to propagate read-only resources — ConfigMaps, Secrets, NetworkPolicies — into all tenant namespaces matching a label selector without touching each tenant definition individually.

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: GlobalTenantResource
metadata:
  name: platform-ca-bundle
spec:
  # Propagate to all tenants
  tenantSelector: {}
  resyncPeriod: 60s
  pruningOnDelete: true
  resources:
    - namespaceSelector:
        matchLabels: {}
      rawItems:
        - apiVersion: v1
          kind: ConfigMap
          metadata:
            name: platform-ca-bundle
          data:
            ca.crt: |
              -----BEGIN CERTIFICATE-----
              MIIBvzCCAWWgAwIBAgIRAIB4EXAMPLE...
              -----END CERTIFICATE-----
```

**Use cases for GlobalTenantResource:**
- Corporate CA certificate bundle distributed to all namespaces
- OPA/Gatekeeper configuration ConfigMaps
- Default NetworkPolicy for platform-managed ingress controller egress
- Shared monitoring scrape configuration

### TenantResource for Tenant-Scoped Propagation

When a tenant owner wants to propagate a resource across their own namespaces (but not cross-tenant), they use **TenantResource**:

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: TenantResource
metadata:
  name: shared-db-credentials
  namespace: oil-company-production
spec:
  resyncPeriod: 30s
  resources:
    - namespaceSelector:
        matchLabels:
          capsule.clastix.io/tenant: oil-company
      rawItems:
        - apiVersion: v1
          kind: Secret
          metadata:
            name: db-read-replica
          type: Opaque
          stringData:
            host: "postgres-read.oil-company-production.svc.cluster.local"
            port: "5432"
```

## CapsuleProxy: kubectl for Tenant Owners

By default, tenant owners cannot run `kubectl get namespaces` and see only their own namespaces — they either see all namespaces (if they have cluster-level list permissions) or none. **CapsuleProxy** fixes this by acting as an API server proxy that filters list responses to show only tenant-owned resources.

### CapsuleProxy Installation

```bash
helm install capsule-proxy projectcapsule/capsule-proxy \
  --namespace capsule-system \
  --version 0.5.6 \
  --set options.generateCertificates=true \
  --set options.enableSSL=true \
  --set service.type=ClusterIP
```

### ProxySetting CRD

Each tenant owner configures what cluster-scoped resources they can list through the proxy:

```yaml
apiVersion: capsule.clastix.io/v1beta1
kind: ProxySetting
metadata:
  name: oil-company-proxy
  namespace: oil-company-production
spec:
  subjects:
    - name: alice
      kind: User
      proxySettings:
        - kind: Nodes
          operations:
            - List
            - Get
        - kind: StorageClasses
          operations:
            - List
            - Get
        - kind: IngressClasses
          operations:
            - List
            - Get
        - kind: PriorityClasses
          operations:
            - List
        - kind: RuntimeClasses
          operations:
            - List
```

With CapsuleProxy configured, Alice can run:

```bash
# Configure kubeconfig to use CapsuleProxy endpoint
kubectl config set-cluster capsule-cluster \
  --server=https://capsule-proxy.capsule-system.svc:9001 \
  --certificate-authority=/path/to/capsule-proxy-ca.crt

# These now work and return only Alice's resources
kubectl get namespaces
kubectl get nodes
kubectl get storageclasses
```

## Tenant Owner Self-Service

The goal of Capsule is to enable tenant owners to create and manage namespaces without platform team involvement. A well-designed Tenant spec grants exactly this:

```yaml
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: payments-team
spec:
  owners:
    - name: payments-team-lead
      kind: User
    - name: payments-admins
      kind: Group

  namespaceOptions:
    quota: 6
    additionalMetadata:
      labels:
        team: payments
        pci-scope: "true"

  resourceQuotas:
    scope: Tenant
    items:
      - hard:
          requests.cpu: "20"
          requests.memory: 40Gi
          limits.cpu: "40"
          limits.memory: 80Gi
          pods: "100"

  limitRanges:
    items:
      - limits:
          - type: Container
            default:
              cpu: 200m
              memory: 256Mi
            defaultRequest:
              cpu: 50m
              memory: 64Mi

  containerRegistries:
    allowed:
      - "registry.example.com/payments"
      - "public.ecr.aws/approved-images"

  storageClasses:
    allowed:
      - "gp3-encrypted"

  ingressOptions:
    allowedClasses:
      allowed:
        - "nginx-internal"
    allowedHostnames:
      allowedRegex: "^.*\\.payments\\.internal$"

  networkPolicies:
    items:
      - ingress:
          - from:
              - namespaceSelector:
                  matchLabels:
                    capsule.clastix.io/tenant: payments-team
              - namespaceSelector:
                  matchLabels:
                    kubernetes.io/metadata.name: monitoring
        podSelector: {}
        policyTypes:
          - Ingress
```

With this Tenant object in place, `payments-team-lead` can:

```bash
# Create a new namespace (auto-prefixed to payments-team-staging)
kubectl create namespace staging

# List only their namespaces via CapsuleProxy
kubectl get namespaces

# Deploy workloads — Capsule enforces all policy at admission
kubectl apply -f deployment.yaml
```

## Namespace Inheritance and Label Propagation

Capsule labels every namespace it manages. Platform engineers can use these labels in admission webhooks, OPA policies, and monitoring:

```
capsule.clastix.io/tenant: <tenant-name>
capsule.clastix.io/tenant.uid: <tenant-uid>
kubernetes.io/metadata.name: <namespace-name>
```

Additional labels from `namespaceOptions.additionalMetadata.labels` are applied at namespace creation and kept in sync. If the platform team adds a new label to the tenant spec, Capsule reconciles it to all existing namespaces in the tenant — no manual intervention required.

## Migrating from Raw Namespaces

Migrating an existing namespace into Capsule management is a two-step process: annotate the namespace to mark it as Capsule-managed, then update the Tenant spec to include it.

### Step 1: Annotate Existing Namespaces

```bash
# Mark the namespace as owned by the target tenant
kubectl annotate namespace legacy-payments-prod \
  capsule.clastix.io/tenant=payments-team

kubectl label namespace legacy-payments-prod \
  capsule.clastix.io/tenant=payments-team
```

### Step 2: Verify Tenant Adoption

```bash
kubectl get tenant payments-team -o jsonpath='{.status.namespaces}'
# Output: ["legacy-payments-prod","payments-team-staging","payments-team-prod"]

kubectl get tenant payments-team -o jsonpath='{.status.size}'
# Output: 3
```

### Step 3: Validate Policy Enforcement

After adoption, submit a test Pod that violates an allowed registry restriction:

```bash
kubectl -n legacy-payments-prod run test-violation \
  --image=docker.io/library/nginx:latest
# Expected: Error from server (Forbidden): admission webhook denied the request
```

### Rollback Considerations

If a namespace needs to be removed from Capsule management:

```bash
kubectl annotate namespace legacy-payments-prod \
  capsule.clastix.io/tenant-
kubectl label namespace legacy-payments-prod \
  capsule.clastix.io/tenant-
```

Capsule will stop reconciling it but will not delete any existing policies or quotas. Clean those up manually.

## Monitoring with Prometheus

Capsule exposes Prometheus metrics on port `8080` at `/metrics` on the controller pod.

### Key Metrics

| Metric | Description |
|--------|-------------|
| `capsule_tenant_count` | Total number of Tenant objects |
| `capsule_tenant_namespace_count` | Total namespaces across all tenants |
| `capsule_tenant_resource_quota_usage` | Resource quota utilization per tenant |

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: capsule-controller
  namespace: capsule-system
  labels:
    app.kubernetes.io/name: capsule
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: capsule
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: capsule-alerts
  namespace: capsule-system
spec:
  groups:
    - name: capsule.tenant
      rules:
        - alert: TenantNamespaceQuotaNearLimit
          expr: |
            (capsule_tenant_namespace_count / on(tenant) capsule_tenant_namespace_quota) > 0.85
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Tenant {{ $labels.tenant }} has used {{ $value | humanizePercentage }} of its namespace quota"

        - alert: TenantCPUQuotaHigh
          expr: |
            (
              sum by (tenant) (kube_resourcequota{resource="requests.cpu", type="used"})
              /
              sum by (tenant) (kube_resourcequota{resource="requests.cpu", type="hard"})
            ) > 0.90
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "Tenant {{ $labels.tenant }} CPU request quota above 90%"
```

## Production Hardening

### Webhook Availability

The Capsule admission webhook is in the critical path for all namespace and workload operations. A webhook outage blocks all tenant deployments. Configure it for high availability:

```yaml
# capsule-values.yaml
replicaCount: 3

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app.kubernetes.io/name: capsule
        topologyKey: kubernetes.io/hostname

# Ensure webhook has a failurePolicy appropriate for your SLA
# "Fail" blocks workloads if webhook is down — safer for security
# "Ignore" allows workloads through — safer for availability
webhookConfiguration:
  failurePolicy: Fail
  timeoutSeconds: 10
```

For clusters where availability trumps security enforcement, `Ignore` prevents a Capsule outage from taking down tenant workloads, but policy enforcement will be bypassed during the outage window. Log and alert on webhook errors to minimize this window.

### Protecting the CapsuleConfiguration

```bash
# Prevent accidental deletion of the global config
kubectl annotate capsuleconfiguration default \
  helm.sh/resource-policy=keep
```

### Backup

Backup all Tenant and CapsuleConfiguration objects with your standard Velero workflow:

```bash
velero backup create capsule-config \
  --include-resources tenants.capsule.clastix.io,capsuleconfigurations.capsule.clastix.io \
  --storage-location default
```

## Comparison with Hierarchical Namespaces and vCluster

| Feature | Capsule | HNC | vCluster |
|---------|---------|-----|---------|
| Namespace grouping | Tenant CRD | HierarchyConfiguration | Separate API server |
| Resource quota enforcement | Per-tenant aggregate or per-NS | No native enforcement | Per virtual cluster |
| Allowed registries | Yes, admission webhook | No | Per virtual cluster |
| Network policy injection | Yes, automatic | Via propagation | Per virtual cluster |
| Tenant self-service namespaces | Yes | Via subnamespace anchors | Full cluster admin |
| Custom CRDs per tenant | No | No | Yes |
| Control plane overhead | Near zero | Near zero | High |
| kubectl transparency | Via CapsuleProxy | Native | Native (separate kubeconfig) |

For most enterprise scenarios serving 10–100 internal development teams on shared clusters, Capsule provides the best balance of governance, self-service, and operational simplicity.

## Troubleshooting

### Webhook Admission Failures

```bash
# Check webhook configuration
kubectl get validatingwebhookconfigurations capsule-validating-webhook-configuration -o yaml

# Check controller logs
kubectl -n capsule-system logs -l app.kubernetes.io/name=capsule --tail=100

# Common cause: certificate expired for the webhook TLS
kubectl -n capsule-system get secret capsule-tls -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -dates
```

### Namespace Not Appearing in Tenant

```bash
# Verify namespace has correct label
kubectl get namespace oil-company-staging --show-labels

# Verify tenant status
kubectl get tenant oil-company -o jsonpath='{.status}'

# Check reconciler logs
kubectl -n capsule-system logs -l app.kubernetes.io/name=capsule \
  | grep "oil-company-staging"
```

### Resource Quota Not Enforced

```bash
# List ResourceQuota objects created by Capsule
kubectl get resourcequota -n oil-company-staging \
  -l capsule.clastix.io/tenant=oil-company

# Describe to see current usage vs hard limits
kubectl describe resourcequota -n oil-company-staging
```

Capsule is a mature, production-ready multi-tenancy solution that eliminates the gap between platform governance requirements and developer self-service. With Tenant CRDs as the single policy boundary, platform teams can enforce security posture across hundreds of namespaces without bespoke scripts or manual quota management.
