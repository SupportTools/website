---
title: "Hierarchical Namespace Controller: Namespace Trees for Kubernetes"
date: 2027-01-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HNC", "Multi-Tenancy", "Namespaces", "RBAC"]
categories: ["Kubernetes", "Platform Engineering"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to the Hierarchical Namespace Controller (HNC): namespace trees, object propagation, subnamespace anchors, kubectl-hns plugin, depth labels, and production deployment patterns."
more_link: "yes"
url: "/hnc-hierarchical-namespace-controller-kubernetes-guide/"
---

Flat Kubernetes namespaces solve the immediate problem of workload isolation but create a management tax as organizations grow. When a platform team operates 200 namespaces across 30 product teams, propagating a NetworkPolicy update or a LimitRange change becomes a scripting exercise that is easy to get wrong. **Hierarchical Namespace Controller (HNC)** introduces namespace trees — parent namespaces that propagate objects down to their children — eliminating the synchronization problem at the source.

<!--more-->

## HNC Architecture

HNC extends Kubernetes with two primary custom resources and a set of controller loops that synchronize object state through the namespace hierarchy.

### Core Components

```
┌─────────────────────────────────────────────────────────────────┐
│                         kube-apiserver                          │
├─────────────────────────────────────────────────────────────────┤
│                         HNC Manager                             │
│                                                                  │
│  ┌──────────────────────┐  ┌──────────────────────────────┐    │
│  │  HierarchyConfig     │  │  Object Propagation           │    │
│  │  Reconciler          │  │  Controllers                  │    │
│  │  - builds tree graph │  │  - Role / RoleBinding         │    │
│  │  - manages labels    │  │  - NetworkPolicy              │    │
│  │  - validates cycles  │  │  - ConfigMap / Secret         │    │
│  └──────────────────────┘  │  - LimitRange / ResourceQuota │    │
│                             └──────────────────────────────┘    │
│  ┌──────────────────────┐                                        │
│  │  SubnamespaceAnchor  │                                        │
│  │  Reconciler          │                                        │
│  │  - creates child NS  │                                        │
│  │  - propagates parent │                                        │
│  └──────────────────────┘                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Custom Resources

**HierarchyConfiguration** — one per namespace, defines the namespace's parent and propagation settings:

```yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: team-payments
spec:
  parent: org-platform
```

**SubnamespaceAnchor** — a lightweight object placed in a parent namespace to request child namespace creation:

```yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-payments-prod
  namespace: team-payments
```

## Namespace Tree Concepts

### Tree Terminology

```
org-platform                    (root)
├── team-payments               (child of org-platform)
│   ├── team-payments-dev       (grandchild)
│   ├── team-payments-stg       (grandchild)
│   └── team-payments-prod      (grandchild)
├── team-frontend               (child of org-platform)
│   ├── team-frontend-dev       (grandchild)
│   └── team-frontend-prod      (grandchild)
└── team-data                   (child of org-platform)
    └── team-data-prod          (grandchild)
```

**Root namespace** — a namespace with no parent. Objects placed here propagate to all descendants.

**Full namespace** — a namespace created conventionally (`kubectl create namespace`) and adopted into the tree by setting a parent via `HierarchyConfiguration`.

**Subnamespace** — a namespace created via `SubnamespaceAnchor`, whose lifecycle is tied to the parent namespace. Deleting the anchor deletes the child namespace.

### Depth Labels

HNC automatically applies depth labels to every namespace in the tree. These labels enable namespace selectors in NetworkPolicy and RBAC to express "this namespace and all its descendants":

```
# org-platform namespace
hnc.x-k8s.io/depth: "0"

# team-payments namespace (depth 1 from org-platform)
hnc.x-k8s.io/org-platform.tree.hnc.x-k8s.io/depth: "1"
hnc.x-k8s.io/depth: "0"

# team-payments-prod namespace (depth 2 from org-platform, depth 1 from team-payments)
hnc.x-k8s.io/org-platform.tree.hnc.x-k8s.io/depth: "2"
hnc.x-k8s.io/team-payments.tree.hnc.x-k8s.io/depth: "1"
hnc.x-k8s.io/depth: "0"
```

A NetworkPolicy in `org-platform` can use `namespaceSelector: matchExpressions: [{key: "hnc.x-k8s.io/org-platform.tree.hnc.x-k8s.io/depth", operator: Exists}]` to match every namespace in the entire tree.

## Installation

### Prerequisites

HNC requires Kubernetes 1.27 or later. The webhook requires cert-manager for TLS certificate provisioning.

```bash
# Install cert-manager if not already present
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true

# Install HNC
helm repo add hnc https://kubernetes-sigs.github.io/hierarchical-namespaces/charts
helm repo update
helm install hnc hnc/hnc \
  --namespace hnc-system \
  --create-namespace \
  --version 1.1.0 \
  --set noWebhook=false
```

### Install kubectl-hns Plugin

The `kubectl-hns` plugin is the primary user interface for HNC operations.

```bash
# Install via krew
kubectl krew install hns

# Verify
kubectl hns version

# Or install manually
HNC_VERSION=v1.1.0
OS=$(uname | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
curl -L "https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/${HNC_VERSION}/kubectl-hns_${OS}_${ARCH}" \
  -o /usr/local/bin/kubectl-hns
chmod +x /usr/local/bin/kubectl-hns
```

### Verify Installation

```bash
kubectl -n hnc-system get pods
kubectl get crd hierarchyconfigurations.hnc.x-k8s.io
kubectl get crd subnamespaceanchors.hnc.x-k8s.io
kubectl hns tree --all-namespaces
```

## Building Namespace Trees

### Creating the Root Namespace

The root namespace is a standard Kubernetes namespace. Platform teams typically create it with labels that policies can target:

```bash
kubectl create namespace org-platform
kubectl label namespace org-platform \
  team=platform \
  environment=shared
```

### Creating Child Namespaces via SubnamespaceAnchors

Tenant owners with `admin` access to the parent namespace can create child namespaces without cluster-admin privileges:

```bash
# Create a child namespace (HNC reconciler creates the actual namespace)
kubectl hns create team-payments -n org-platform

# Verify
kubectl hns tree org-platform
# org-platform
# └── [s] team-payments

# [s] indicates the namespace is a subnamespace
```

Equivalent YAML for GitOps workflows:

```yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-payments
  namespace: org-platform
```

### Creating Deeper Subtrees

Team leads can further subdivide their namespace without platform team involvement:

```bash
# team-payments admin creates environment namespaces
kubectl hns create team-payments-dev -n team-payments
kubectl hns create team-payments-stg -n team-payments
kubectl hns create team-payments-prod -n team-payments

# Verify the full tree
kubectl hns tree org-platform
# org-platform
# └── [s] team-payments
#     ├── [s] team-payments-dev
#     ├── [s] team-payments-stg
#     └── [s] team-payments-prod
```

### Adopting Existing Namespaces

Existing namespaces can be adopted into the tree by setting a parent:

```bash
kubectl hns set legacy-payments-prod --parent team-payments

# Or via HierarchyConfiguration
kubectl apply -f - <<EOF
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: legacy-payments-prod
spec:
  parent: team-payments
EOF
```

HNC validates that adopting the namespace does not create a cycle and that the parent exists before accepting the change.

## Object Propagation

### Configuring Propagated Resource Types

HNC does not propagate all resource types by default. The platform team controls the propagation configuration globally via the `HNCConfiguration` singleton:

```yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
spec:
  resources:
    # RBAC — propagate down
    - resource: roles
      mode: Propagate
    - resource: rolebindings
      mode: Propagate
    # Network policy — propagate down
    - resource: networkpolicies
      mode: Propagate
    # Resource limits — propagate down
    - resource: limitranges
      mode: Propagate
    # ConfigMaps — propagate down
    - resource: configmaps
      mode: Propagate
    # Secrets — propagate down (use with caution)
    - resource: secrets
      mode: Propagate
    # ResourceQuota — ignored by HNC (use Capsule or manual management)
    - resource: resourcequotas
      mode: Ignore
```

**Propagation modes:**
- `Propagate` — objects in a parent are copied to all descendants and kept in sync
- `Remove` — propagated copies are deleted; new objects in descendants are not affected
- `Ignore` — HNC ignores this resource type entirely

### Propagating RBAC

Placing a RoleBinding in a parent namespace causes it to cascade to all descendants. This is the primary use case for most platform teams:

```yaml
# Place in org-platform namespace — applies to all teams
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-sre-admin
  namespace: org-platform
  annotations:
    # Prevent HNC from propagating to a specific namespace
    propagate.hnc.x-k8s.io/excluded-namespaces: "team-payments-prod"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - kind: Group
    name: platform-sre
    apiGroup: rbac.authorization.k8s.io
```

After reconciliation, HNC creates a copy of this RoleBinding in every descendant namespace. The copies are immutable from within the child namespace — attempts to delete or modify them are rejected by the webhook.

### Propagating NetworkPolicy

```yaml
# Place in org-platform — applies to all descendants
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-ingress
  namespace: org-platform
spec:
  podSelector: {}
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 9090
          protocol: TCP
        - port: 8080
          protocol: TCP
  policyTypes:
    - Ingress
```

### Propagation Exceptions

Sometimes a policy should not apply to a specific descendant. The `propagate.hnc.x-k8s.io/excluded-namespaces` annotation on the source object prevents propagation to named namespaces:

```yaml
metadata:
  annotations:
    propagate.hnc.x-k8s.io/excluded-namespaces: "team-payments-dev,team-payments-stg"
```

For more complex exceptions, the child namespace can override a propagated object by creating a local copy with the same name — HNC's `none` propagation mode annotation tells the controller to stop managing that object in the child:

```yaml
# In team-payments-dev namespace — local override of the propagated NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-ingress
  namespace: team-payments-dev
  annotations:
    propagate.hnc.x-k8s.io/none: "true"
spec:
  # Development-specific policy with broader access
  podSelector: {}
  ingress:
    - {}  # Allow all in dev
  policyTypes:
    - Ingress
```

## Propagating Custom Resources

HNC can propagate any custom resource registered in the `HNCConfiguration`. This enables platform-specific abstractions to flow through the hierarchy:

```yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
spec:
  resources:
    - group: monitoring.coreos.com
      resource: servicemonitors
      mode: Propagate
    - group: kyverno.io
      resource: policies
      mode: Propagate
    - group: networking.istio.io
      resource: sidecars
      mode: Propagate
```

After adding `servicemonitors` to propagation, placing a default ServiceMonitor in `org-platform` automatically configures Prometheus scraping in every team namespace without individual team action.

## Subnamespace Creation Workflow

A complete self-service workflow for a new team onboarding:

### Platform Team: Create Root

```bash
# 1. Create the team's root namespace
kubectl create namespace team-ml

# 2. Set parent to the organization root
kubectl hns set team-ml --parent org-platform

# 3. Grant team lead admin access to the root namespace
kubectl apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-ml-lead-admin
  namespace: team-ml
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - kind: User
    name: bob
    apiGroup: rbac.authorization.k8s.io
EOF
```

### Team Lead: Create Sub-Environments

```bash
# Bob creates his own environment namespaces without platform team
kubectl hns create team-ml-experiments -n team-ml
kubectl hns create team-ml-training -n team-ml
kubectl hns create team-ml-serving -n team-ml

# Verify the tree
kubectl hns tree team-ml
# team-ml
# ├── [s] team-ml-experiments
# ├── [s] team-ml-training
# └── [s] team-ml-serving

# Bob has admin access in all subnamespaces automatically via RoleBinding propagation
kubectl -n team-ml-training get pods
```

## Depth Labels for Policy Application

Depth labels enable precise NetworkPolicy scoping across the namespace tree. A common production pattern uses depth labels to allow communication within a team's subtree while denying cross-team traffic:

```yaml
# Allow intra-team traffic (any namespace in team-payments subtree)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-intra-team
  namespace: team-payments
spec:
  podSelector: {}
  ingress:
    - from:
        - namespaceSelector:
            matchExpressions:
              - key: "team-payments.tree.hnc.x-k8s.io/depth"
                operator: Exists
  policyTypes:
    - Ingress
```

```yaml
# Place in org-platform — deny all cross-team traffic by default
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-cross-team
  namespace: org-platform
spec:
  podSelector: {}
  policyTypes:
    - Ingress
```

## Cross-Tree References

HNC does not natively support cross-tree references — a namespace in one tree cannot propagate objects into another tree. For cross-team shared resources, the recommended pattern is a dedicated shared namespace:

```bash
kubectl create namespace shared-platform-config
kubectl hns set shared-platform-config --parent org-platform
```

Place shared ConfigMaps, CA bundles, and monitoring configurations here. All teams can read from this namespace by granting view access via a propagated RoleBinding in `org-platform`.

For more complex cross-tree needs, `GlobalTenantResource` from Capsule or a dedicated controller is more appropriate.

## High Availability Production Deployment

HNC's admission webhook is in the critical path for namespace operations and object creation. A production-grade deployment requires multiple replicas across separate nodes:

```yaml
# hnc-values.yaml
replicaCount: 2

affinity:
  podAntiAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels:
            app: hnc-controller-manager
        topologyKey: kubernetes.io/hostname

resources:
  requests:
    cpu: 100m
    memory: 150Mi
  limits:
    cpu: 500m
    memory: 512Mi

webhook:
  failurePolicy: Fail   # Change to Ignore if availability > security
  timeoutSeconds: 10
```

### Webhook Disruption Budget

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: hnc-controller-manager-pdb
  namespace: hnc-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: hnc-controller-manager
```

## Use Cases

### Team Namespace Hierarchy

The canonical HNC use case is organizing team namespaces:

```
platform-root
├── team-checkout
│   ├── team-checkout-dev
│   ├── team-checkout-stg
│   └── team-checkout-prod
├── team-catalog
│   ├── team-catalog-dev
│   └── team-catalog-prod
└── infra
    ├── infra-monitoring
    ├── infra-logging
    └── infra-security
```

Policies placed at `platform-root` propagate everywhere. Policies placed at `infra` only reach infrastructure namespaces.

### Environment Promotion Hierarchy

An alternative topology models the promotion lifecycle:

```
environment-root
├── dev
│   ├── dev-checkout
│   ├── dev-catalog
│   └── dev-payments
├── stg
│   ├── stg-checkout
│   └── stg-payments
└── prod
    ├── prod-checkout
    └── prod-payments
```

RoleBindings and NetworkPolicies placed in `dev` apply only to development namespaces, enabling more permissive policies in lower environments without affecting production.

## Limitations

Understanding HNC's limitations prevents misapplication:

**No resource quota hierarchy.** HNC does not enforce aggregate resource quotas across a namespace tree. Each namespace receives an independent ResourceQuota. For aggregate quota enforcement, Capsule is the appropriate tool.

**No admission policy enforcement.** HNC does not restrict which container images, StorageClasses, or IngressClasses can be used. This is outside HNC's scope.

**Cycle detection.** HNC prevents namespace cycles but the validation is synchronous — a HierarchyConfiguration that would create a cycle is rejected at admission time. Plan your tree topology carefully before adoption.

**Object name conflicts.** If a child namespace already contains an object with the same name as a propagated object, HNC detects a conflict and marks the object with a `ObjectConflict` condition. Resolve by deleting or renaming the child's copy.

```bash
# Check for propagation conflicts
kubectl hns describe team-payments-prod
# Look for ObjectConflict in the status conditions
```

**Deletion propagation.** Deleting a subnamespace anchor deletes the child namespace and all its contents. This is intentional but can be surprising. Use `kubectl hns set <ns> --allowCascadingDeletion` to enable this behavior deliberately and `kubectl hns set <ns> --noCascadingDeletion` to prevent accidental deletion.

## Monitoring

### HNC Controller Metrics

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: hnc-controller-manager
  namespace: hnc-system
spec:
  selector:
    matchLabels:
      app: hnc-controller-manager
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Metrics

| Metric | Description |
|--------|-------------|
| `controller_runtime_reconcile_total` | Total reconcile attempts by controller |
| `controller_runtime_reconcile_errors_total` | Failed reconciliations |
| `hnc_object_propagated_total` | Objects propagated successfully |
| `hnc_object_conflict_total` | Object name conflicts detected |
| `hnc_namespace_conditions_total` | Namespaces with active conditions |

### Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hnc-alerts
  namespace: hnc-system
spec:
  groups:
    - name: hnc.propagation
      rules:
        - alert: HNCPropagationErrors
          expr: increase(controller_runtime_reconcile_errors_total{controller="object"}[5m]) > 0
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "HNC object propagation errors detected"

        - alert: HNCNamespaceConditionActive
          expr: hnc_namespace_conditions_total > 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "HNC namespace conditions active — check kubectl hns describe"
```

## Common Operations Reference

```bash
# View full tree
kubectl hns tree --all-namespaces

# View tree rooted at a specific namespace
kubectl hns tree org-platform

# Check namespace conditions and propagation status
kubectl hns describe team-payments

# Move a namespace to a different parent
kubectl hns set team-payments --parent new-parent-ns

# List all propagated objects in a namespace
kubectl get roles,rolebindings,networkpolicies -n team-payments-prod \
  -l hnc.x-k8s.io/inherited-from

# View what would propagate from a parent
kubectl hns config describe

# Temporarily suppress propagation for an object type
kubectl hns config set-resource networkpolicies --mode=Ignore
```

## GitOps Integration

HNC fits naturally into GitOps workflows. The full namespace tree can be represented in Git as a set of SubnamespaceAnchor and HierarchyConfiguration manifests:

```
gitops-repo/
└── namespaces/
    ├── org-platform/
    │   └── namespace.yaml
    ├── team-payments/
    │   ├── subnamespace-anchor.yaml   # placed in org-platform
    │   ├── rbac/
    │   │   └── rolebinding-admin.yaml
    │   └── network-policy/
    │       └── default-deny.yaml
    └── team-payments-prod/
        ├── subnamespace-anchor.yaml   # placed in team-payments
        └── resource-quota.yaml
```

An ArgoCD Application watching the `namespaces/` directory creates the HNC objects and policy manifests:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: namespace-tree
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://git.example.com/platform/gitops.git
    targetRevision: main
    path: namespaces
  destination:
    server: https://kubernetes.default.svc
    namespace: ""    # cluster-scoped objects, namespace set per resource
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - ApplyOutOfSyncOnly=true
      - ServerSideApply=true
```

With this setup, onboarding a new team is a pull request that adds a directory under `namespaces/` — reviewed by the platform team and applied automatically once merged.

## Upgrading HNC

HNC maintains backward compatibility across minor versions. The upgrade procedure:

```bash
# 1. Check current version
kubectl -n hnc-system get deployment hnc-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].image}'

# 2. Update Helm chart
helm repo update
helm upgrade hnc hnc/hnc \
  --namespace hnc-system \
  --version 1.2.0 \
  --reuse-values

# 3. Verify CRD schema migration (if CRD version changed)
kubectl get crd hierarchyconfigurations.hnc.x-k8s.io \
  -o jsonpath='{.status.storedVersions}'

# 4. Check controller health post-upgrade
kubectl -n hnc-system rollout status deployment/hnc-controller-manager

# 5. Verify propagation is working
kubectl hns tree org-platform
```

For major version upgrades (e.g., v1.x to v2.x), check the migration guide in the HNC release notes. Major versions occasionally change the `HierarchyConfiguration` API version, requiring a conversion step.

## Integration with OPA Gatekeeper

HNC depth labels and the `capsule.clastix.io/tenant` label (when used alongside Capsule) integrate cleanly with OPA Gatekeeper constraints. A common pattern uses depth labels to enforce that production namespaces require specific resource limits:

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirelimitrange
spec:
  crd:
    spec:
      names:
        kind: RequireLimitRange
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirelimitrange

        violation[{"msg": msg}] {
          input.review.kind.kind == "Namespace"
          # Only enforce on namespaces at depth >= 2 (grandchildren of root)
          label_key := concat("", [input.review.object.metadata.labels["hnc.x-k8s.io/org-platform.tree.hnc.x-k8s.io/depth"]])
          to_number(label_key) >= 2
          not namespace_has_limitrange
          msg := "Production-tier namespaces must have a LimitRange propagated from parent"
        }

        namespace_has_limitrange {
          # Check would be done via data.inventory in a real policy
          true
        }
```

HNC complements namespace-based multi-tenancy tooling by solving a distinct problem: keeping policy objects synchronized across a growing namespace forest. Combined with Capsule for quota and registry enforcement, it delivers a complete platform engineering toolkit for shared Kubernetes clusters.
