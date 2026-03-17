---
title: "Hierarchical Namespace Controller: Tenant Isolation in Kubernetes"
date: 2028-12-09T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Tenancy", "HNC", "Namespaces", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Hierarchical Namespace Controller (HNC): SubnamespaceAnchors, propagated RBAC and policy objects, anchor-less namespaces, comparison with Capsule and vCluster, and self-service namespace patterns for large multi-tenant clusters."
more_link: "yes"
url: "/kubernetes-multitenancy-hierarchy-namespace-guide/"
---

Kubernetes namespaces are flat: they have no parent-child relationship. When a platform team manages dozens of tenants each with multiple environments (dev, staging, prod), they must duplicate RBAC bindings, NetworkPolicies, LimitRanges, and ResourceQuotas manually for each namespace. The Hierarchical Namespace Controller (HNC) from the Kubernetes SIG Multi-tenancy project introduces a namespace hierarchy where objects can propagate from parent to child automatically, and tenants can self-service create namespaces within their subtree.

This guide covers HNC architecture, self-service namespace creation, object propagation, operational patterns for large clusters, and when to choose HNC over Capsule or vCluster.

<!--more-->

# Hierarchical Namespace Controller: Tenant Isolation

## Section 1: HNC Architecture Overview

HNC introduces three CRDs:

- **HierarchyConfiguration**: One per namespace, defines the parent relationship
- **SubnamespaceAnchor**: A resource in a parent namespace that creates a child namespace
- **HNCConfiguration**: Cluster-wide configuration of which object types propagate

The controller watches these resources and:
1. Copies propagated objects (RoleBindings, LimitRanges, etc.) from parent to all descendants
2. Creates child namespaces when SubnamespaceAnchors are created
3. Deletes child namespaces when SubnamespaceAnchors are deleted (cascade)

```
cluster-root (virtual root, not a real namespace)
├── team-alpha (org namespace)
│   ├── alpha-dev
│   ├── alpha-staging
│   └── alpha-prod
├── team-beta (org namespace)
│   ├── beta-dev
│   └── beta-prod
└── infra (shared services)
    ├── monitoring
    └── logging
```

## Section 2: Installation

```bash
# Install HNC v1.1
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Verify
kubectl -n hnc-system get pods
# NAME                                      READY   STATUS    RESTARTS
# hnc-controller-manager-7d8f9c4b5f-x2kpq  1/1     Running   0

# Install the kubectl plugin
HNC_VERSION=v1.1.0
curl -L https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/${HNC_VERSION}/kubectl-hns_linux_amd64 \
  -o /usr/local/bin/kubectl-hns
chmod +x /usr/local/bin/kubectl-hns

# Verify plugin
kubectl hns --help
```

## Section 3: HNCConfiguration — Propagation Rules

Configure which object types propagate from parent to child namespaces:

```yaml
# hnc-configuration.yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config  # singleton; only one exists
spec:
  resources:
    # RoleBindings propagate so team RBAC in parent is inherited by children
    - resource: rolebindings
      group: rbac.authorization.k8s.io
      mode: Propagate

    # LimitRanges propagate to enforce memory/CPU defaults per tenant
    - resource: limitranges
      mode: Propagate

    # NetworkPolicies propagate for baseline isolation rules
    - resource: networkpolicies
      group: networking.k8s.io
      mode: Propagate

    # ResourceQuotas do NOT propagate by default — set per-namespace
    - resource: resourcequotas
      mode: Ignore

    # ConfigMaps can be propagated selectively
    - resource: configmaps
      mode: Propagate

    # Secrets: propagate with caution (only shared non-sensitive configs)
    - resource: secrets
      mode: Ignore

    # Custom: propagate OPA constraints
    - resource: k8srequiredlabels
      group: constraints.gatekeeper.sh
      mode: Propagate
```

```bash
kubectl apply -f hnc-configuration.yaml

# Verify the configuration
kubectl hns config describe
```

## Section 4: Creating the Tenant Hierarchy

### Platform team creates org-level namespaces

```bash
# Create top-level team namespaces
kubectl create namespace team-alpha
kubectl create namespace team-beta
kubectl create namespace infra

# Set labels for policy enforcement
kubectl label namespace team-alpha \
  tenant=team-alpha \
  cost-center=eng \
  pod-security.kubernetes.io/enforce=baseline

kubectl label namespace team-beta \
  tenant=team-beta \
  cost-center=product \
  pod-security.kubernetes.io/enforce=baseline
```

Apply RBAC to the org namespace — it will propagate to all children:

```yaml
# team-alpha-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-developers
  namespace: team-alpha  # propagates to alpha-dev, alpha-staging, alpha-prod
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: edit
subjects:
  - kind: Group
    name: team-alpha
    apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-leads
  namespace: team-alpha
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - kind: Group
    name: team-alpha-leads
    apiGroup: rbac.authorization.k8s.io
```

```yaml
# team-alpha-limitrange.yaml — propagates to all child namespaces
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-defaults
  namespace: team-alpha
spec:
  limits:
    - type: Container
      default:
        cpu: "500m"
        memory: "512Mi"
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      max:
        cpu: "4"
        memory: "8Gi"
    - type: Pod
      max:
        cpu: "8"
        memory: "16Gi"
```

```yaml
# baseline-network-policy.yaml — propagates to all team-alpha children
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-cross-tenant
  namespace: team-alpha
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow from same namespace (label propagation makes this work for children too)
    - from:
        - namespaceSelector:
            matchLabels:
              tenant: team-alpha
    # Allow from monitoring namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
      ports:
        - port: 9090
          protocol: TCP
  egress:
    # Allow within tenant
    - to:
        - namespaceSelector:
            matchLabels:
              tenant: team-alpha
    # Allow DNS
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # Allow internet egress
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
```

```bash
kubectl apply -f team-alpha-rbac.yaml
kubectl apply -f team-alpha-limitrange.yaml
kubectl apply -f baseline-network-policy.yaml
```

## Section 5: SubnamespaceAnchor — Self-Service Namespace Creation

Team leads can create child namespaces by creating SubnamespaceAnchors. This requires only `edit` access to the parent namespace, not cluster-admin.

```yaml
# alpha-environments.yaml
# Team lead creates these in the team-alpha namespace
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: alpha-dev
  namespace: team-alpha
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: alpha-staging
  namespace: team-alpha
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: alpha-prod
  namespace: team-alpha
```

```bash
kubectl apply -f alpha-environments.yaml

# Verify namespaces were created
kubectl get namespaces | grep alpha
# team-alpha      Active   5m
# alpha-dev       Active   30s
# alpha-staging   Active   30s
# alpha-prod      Active   30s

# Verify propagated objects
kubectl get rolebindings -n alpha-dev
# NAME                     ROLE                   AGE
# team-alpha-developers    ClusterRole/edit       25s  <- propagated
# team-alpha-leads         ClusterRole/admin      25s  <- propagated

kubectl get limitranges -n alpha-dev
# NAME                    CREATED AT
# team-alpha-defaults     2028-12-09T10:00:00Z  <- propagated

kubectl get networkpolicies -n alpha-dev
# NAME                CREATED AT
# deny-cross-tenant   2028-12-09T10:00:00Z  <- propagated
```

View the hierarchy tree:

```bash
kubectl hns tree team-alpha
# team-alpha
# ├── [s] alpha-dev
# ├── [s] alpha-staging
# └── [s] alpha-prod
# [s] indicates SubnamespaceAnchor

kubectl hns tree --all-namespaces
```

## Section 6: Selective Object Propagation with Labels

Not every object in the parent should propagate. Use label selectors to control what propagates:

```yaml
# This LimitRange propagates to all children (no selector)
apiVersion: v1
kind: LimitRange
metadata:
  name: shared-defaults
  namespace: team-alpha
  labels:
    propagate: "true"

---
# This LimitRange only applies in team-alpha (not propagated)
apiVersion: v1
kind: LimitRange
metadata:
  name: team-alpha-local-only
  namespace: team-alpha
  labels:
    propagate: "false"  # HNCConfiguration can filter on this label
```

In the HNCConfiguration, add selector-based filtering:

```yaml
spec:
  resources:
    - resource: limitranges
      mode: Propagate
      # Only propagate objects with this label
      selector:
        matchLabels:
          propagate: "true"
```

## Section 7: ResourceQuotas per Child Namespace

ResourceQuotas intentionally do not propagate (each environment needs its own quota). Apply them per child namespace via GitOps:

```yaml
# alpha-prod-quota.yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: alpha-prod-quota
  namespace: alpha-prod
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    count/pods: "100"
    count/services: "20"
    count/persistentvolumeclaims: "30"
    count/secrets: "50"
    count/configmaps: "50"
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: alpha-dev-quota
  namespace: alpha-dev
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    count/pods: "20"
```

## Section 8: Anchor-Less Namespaces and Managed Hierarchies

Some namespaces should be in the hierarchy without being subnamespace anchors (e.g., platform-managed namespaces that must not be deleted by the team):

```bash
# Set the parent of an existing namespace without a subnamespace anchor
kubectl hns set monitoring --parent infra

# View
kubectl hns tree infra
# infra
# └── monitoring    <- anchor-less (not deletable by team-alpha)
# └── logging       <- anchor-less
```

```yaml
# HierarchyConfiguration can also be created directly
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: monitoring
spec:
  parent: infra
```

## Section 9: HNC vs Capsule vs vCluster

| Feature | HNC | Capsule | vCluster |
|---------|-----|---------|---------|
| Architecture | Namespace hierarchy in single cluster | Tenant operator in single cluster | Virtual Kubernetes API server per tenant |
| Self-service namespace creation | Yes (SubnamespaceAnchor) | Yes (Tenant CRD) | Yes (full cluster API) |
| Object propagation | Yes (configurable types) | Limited | Full (virtual API) |
| Resource quota enforcement | Per-namespace | Tenant aggregate quotas | Per vCluster |
| Network isolation | Via propagated NetworkPolicy | Via propagated NetworkPolicy | Full network namespace per vCluster |
| API server isolation | No (shared) | No (shared) | Yes (separate) |
| CRD isolation | No | No | Yes |
| Performance overhead | Low | Low | High (extra API server) |
| Complexity | Medium | Medium | High |

**Choose HNC when:**
- Teams share the cluster API and need automated RBAC/policy inheritance
- Namespace hierarchies naturally model your org chart
- Object propagation reduces platform team toil significantly

**Choose Capsule when:**
- You need aggregate quota enforcement across a tenant's namespaces
- You want Tenant CRD as a first-class API object with rich spec
- Teams can be modeled as a flat set of namespaces (no deep hierarchy)

**Choose vCluster when:**
- Tenants need custom CRDs without cluster-admin rights
- True API server isolation is required (regulated environments)
- Performance cost of extra API server is acceptable

## Section 10: Self-Service Platform Workflow

A complete workflow for development teams:

```yaml
# 1. Platform team creates org namespace with policies
# platform-provision.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: team-gamma
  labels:
    tenant: team-gamma
    cost-center: platform
    pod-security.kubernetes.io/enforce: baseline
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-gamma-admin
  namespace: team-gamma
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: hnc.x-k8s.io:subnamespace-creator  # allows creating SubnamespaceAnchors
subjects:
  - kind: Group
    name: team-gamma-leads
    apiGroup: rbac.authorization.k8s.io
```

```bash
# 2. Team lead self-creates their environments (no platform team involvement)
kubectl create -f - << 'EOF'
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: gamma-dev
  namespace: team-gamma
EOF

# 3. Policies automatically propagate within seconds
kubectl get networkpolicies -n gamma-dev
# deny-cross-tenant   <- inherited from team-gamma

# 4. Developer has edit access immediately (RBAC propagated)
kubectl auth can-i create deployments --namespace gamma-dev --as-group=team-gamma
# yes
```

## Section 11: Troubleshooting Propagation

```bash
# Check why an object was not propagated
kubectl hns describe namespace alpha-dev
# Will show: propagated objects, conditions, parent info

# Conditions on the HierarchyConfiguration
kubectl get hierarchyconfiguration hierarchy -n alpha-dev -o yaml | grep -A20 conditions

# Check for propagation conflicts (same-name object in child)
# If a child already has an object with the same name as a parent,
# HNC will mark the namespace as "ActivitiesHalted"
kubectl get hierarchyconfiguration hierarchy -n alpha-dev \
  -o jsonpath='{.status.conditions}' | python3 -m json.tool

# Force re-sync a namespace tree
kubectl hns set team-alpha --allowCascadingDeletion
# (only needed for troubleshooting — do not leave this enabled)

# List all propagated objects in a namespace
kubectl get rolebindings,limitranges,networkpolicies -n alpha-dev \
  -l hnc.x-k8s.io/inherited-from

# Show origin namespace of a propagated object
kubectl get rolebinding team-alpha-developers -n alpha-dev \
  -o jsonpath='{.metadata.annotations.hnc\.x-k8s\.io/inherited-from}'
# team-alpha
```

## Section 12: Alerts and Monitoring

```yaml
# prometheus-rules-hnc.yaml
groups:
  - name: hnc
    rules:
      - alert: HNCControllerDown
        expr: up{job="hnc-controller-manager"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "HNC controller is down — namespace hierarchy not being maintained"

      - alert: HNCPropagationErrors
        expr: increase(controller_runtime_reconcile_errors_total{controller="hnc"}[10m]) > 5
        labels:
          severity: warning
        annotations:
          summary: "HNC has {{ $value }} reconcile errors in the last 10 minutes"

      - alert: HNCNamespaceConditionActivitiesHalted
        expr: |
          kube_namespace_labels{label_hnc_x_k8s_io_condition="ActivitiesHalted"} > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Namespace {{ $labels.namespace }} has HNC ActivitiesHalted condition"
```

HNC does not replace cluster-level RBAC or network segmentation — it automates their propagation. The result is that platform teams spend minutes per tenant instead of hours, and policy drift (where some child namespaces lack required policies) is structurally eliminated. For organizations with 50+ teams sharing a cluster, this difference is the boundary between a manageable and unmanageable multi-tenant platform.
