---
title: "Kubernetes Multi-Tenancy: Hierarchical Namespaces and Policy Propagation"
date: 2028-02-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Multi-Tenancy", "HNC", "Hierarchical Namespaces", "RBAC", "NetworkPolicy", "vCluster"]
categories:
- Kubernetes
- Platform Engineering
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes multi-tenancy using the Hierarchical Namespace Controller (HNC) for policy propagation across namespace hierarchies, SubnamespaceAnchor patterns, and comparison with vCluster isolation."
more_link: "yes"
url: "/kubernetes-multi-tenancy-hierarchical-namespaces-policy-propagation/"
---

Kubernetes multi-tenancy at scale requires more than just separate namespaces. Platform teams managing dozens or hundreds of tenant namespaces need a way to propagate baseline policies — NetworkPolicy, RBAC, LimitRange, ResourceQuota — without duplicating YAML across every namespace. The Hierarchical Namespace Controller (HNC) solves this by enabling parent-child namespace relationships where policies defined at the parent propagate automatically to all descendants. This guide covers HNC deployment, policy propagation patterns, and the tradeoffs between namespace-based tenancy and virtual cluster (vCluster) isolation.

<!--more-->

# Kubernetes Multi-Tenancy: Hierarchical Namespaces and Policy Propagation

## The Multi-Tenancy Problem at Scale

A platform team supporting 50 engineering teams on a shared Kubernetes cluster faces a recurring problem: each team gets one or more namespaces, and each namespace needs baseline policies applied at creation time. Without automation:

- Every new namespace requires manual application of NetworkPolicies, default RBAC, LimitRanges, and ResourceQuotas
- Policy updates (tightening NetworkPolicy rules, adjusting LimitRanges) must be applied to all existing namespaces individually
- Audit queries like "which namespaces lack the required egress policy" require scripted inventory checks
- Tenant namespace creation requires platform team intervention rather than self-service

HNC addresses these problems by treating namespaces as a tree. Policies at root or intermediate nodes propagate to all descendant namespaces.

## HNC Architecture

HNC introduces two concepts:

**Hierarchy**: A parent-child relationship between namespaces, stored in `HierarchyConfiguration` objects. A namespace can have at most one parent.

**Propagation**: Objects in parent namespaces marked for propagation are automatically copied to all descendant namespaces. HNC maintains these copies and updates them when the parent object changes.

```
cluster
├── platform (root, platform team)
│   ├── commerce (team namespace)
│   │   ├── commerce-dev
│   │   ├── commerce-staging
│   │   └── commerce-production
│   └── payments (team namespace)
│       ├── payments-dev
│       └── payments-production
└── infra (root, infrastructure team)
    ├── monitoring
    └── logging
```

In this hierarchy, a NetworkPolicy defined in `commerce` propagates to `commerce-dev`, `commerce-staging`, and `commerce-production`. A cluster-wide baseline policy defined in `platform` propagates to all team namespaces.

## Installing HNC

```bash
# Install HNC using kubectl plugin (recommended)
kubectl krew install hns
kubectl hns version

# Or install via kubectl apply
HNC_VERSION="v1.1.0"
kubectl apply -f "https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/${HNC_VERSION}/default.yaml"

# Verify HNC webhook and controller are running
kubectl get pods -n hnc-system

# Verify HNC API is available
kubectl api-resources | grep hnc
# Expected: subnamespaceanchors, hierarchyconfigurations, hncconfigurations
```

## HNCConfiguration: Defining Propagation Rules

The cluster-level `HNCConfiguration` object controls which resource types are propagated:

```yaml
# hnc-configuration.yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  # Singleton; there is exactly one HNCConfiguration per cluster
  name: config
spec:
  resources:
  # NetworkPolicy: propagate (copy) from parent to children
  # 'Propagate' means HNC creates a managed copy in each descendant namespace
  - resource: networkpolicies
    group: networking.k8s.io
    mode: Propagate

  # RBAC: propagate RoleBindings for baseline team access
  - resource: rolebindings
    group: rbac.authorization.k8s.io
    mode: Propagate

  # LimitRange: propagate default resource limits
  - resource: limitranges
    mode: Propagate

  # ResourceQuota: propagate per-namespace resource quotas
  - resource: resourcequotas
    mode: Propagate

  # Secrets: use 'Propagate' carefully — propagating secrets distributes
  # sensitive data to all child namespaces. Prefer 'None' and use External Secrets.
  - resource: secrets
    mode: None

  # ConfigMaps: propagate shared configuration
  - resource: configmaps
    mode: Propagate

  # ServiceAccounts: do NOT propagate — each namespace should manage its own
  - resource: serviceaccounts
    mode: None
```

## Creating a Namespace Hierarchy

```bash
# Create the root team namespace
kubectl create namespace commerce

# Make 'platform' the parent of 'commerce'
# This creates a HierarchyConfiguration in the commerce namespace
kubectl hns set commerce --parent platform

# Verify hierarchy
kubectl hns describe commerce
# Output:
# Namespace : commerce
# Parent    : platform
# Children  : []
# Conditions:
#   None

# Create child namespaces using SubnamespaceAnchor (self-service)
# SubnamespaceAnchor is created in the PARENT namespace; HNC creates the child
kubectl apply -f - <<EOF
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: commerce-dev
  namespace: commerce
EOF

# HNC automatically creates the 'commerce-dev' namespace as a child of 'commerce'
kubectl get namespace commerce-dev

# View the full hierarchy tree
kubectl hns tree platform
# platform
# ├── commerce
# │   ├── [s] commerce-dev
# │   ├── [s] commerce-staging
# │   └── [s] commerce-production
# └── payments
#     ├── [s] payments-dev
#     └── [s] payments-production
# [s] = SubnamespaceAnchor-managed namespace
```

## Policy Propagation in Practice

### Baseline NetworkPolicy at Platform Level

```yaml
# platform-deny-all-egress.yaml
# This NetworkPolicy is created in the 'platform' namespace.
# HNC propagates it to all descendant namespaces: commerce, payments,
# commerce-dev, commerce-staging, payments-dev, etc.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: baseline-deny-external-egress
  namespace: platform
  annotations:
    # Document that this is a platform-managed propagated policy
    hnc.x-k8s.io/managed-by: "platform-team"
    policy.platform/purpose: "Default deny external egress; teams add explicit allow rules"
spec:
  podSelector: {}  # Apply to all pods in the namespace
  policyTypes:
  - Egress
  egress:
  # Allow egress to pods within the same namespace
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: "$(metadata.namespace)"  # Self-reference
  # Allow egress to kube-system (DNS, metrics-server)
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - protocol: UDP
      port: 53    # DNS
    - protocol: TCP
      port: 443   # Kubernetes API
  # Allow egress to monitoring namespace (metrics scraping from pods)
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
```

### Team-Level NetworkPolicy Override

Teams can add additional policies in their own namespaces. The propagated baseline deny policy and the team's allow policy coexist — NetworkPolicy rules are additive (union of all matching policies):

```yaml
# commerce-allow-database.yaml
# Created in the 'commerce' namespace (not 'platform').
# This propagates to commerce-dev, commerce-staging, commerce-production
# but NOT to payments or its children.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-database-egress
  namespace: commerce
  annotations:
    hnc.x-k8s.io/managed-by: "commerce-team"
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: data-platform
    ports:
    - protocol: TCP
      port: 5432    # PostgreSQL
    - protocol: TCP
      port: 6379    # Redis
```

### Namespace-Specific Policy (Not Propagated)

Individual child namespaces can override or supplement inherited policies using annotation to exclude the object from propagation:

```yaml
# commerce-dev-debug-policy.yaml
# This NetworkPolicy is ONLY for commerce-dev (not inherited by children of commerce-dev)
# and will NOT propagate further because it has the 'no-propagation' annotation
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dev-debug-ingress
  namespace: commerce-dev
  annotations:
    # Prevent HNC from propagating this policy to child namespaces of commerce-dev
    hnc.x-k8s.io/inherited-from: ""   # Not inherited; locally defined
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  # Allow ingress from developer workstations in dev environment only
  - from:
    - namespaceSelector:
        matchLabels:
          environment: development
```

## RBAC Propagation

RBAC propagation distributes team access permissions to child namespaces automatically:

```yaml
# commerce-team-rbac.yaml
# Created in 'commerce' namespace; propagates to all commerce child namespaces.
# Grants the commerce-team group developer access.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: commerce-developers
  namespace: commerce
  annotations:
    hnc.x-k8s.io/managed-by: "platform-team"
subjects:
# Group membership managed via OIDC/LDAP integration with the cluster
- kind: Group
  name: "commerce-team"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  # 'developer' ClusterRole grants: get/list/watch/create/update pods, deployments,
  # services, configmaps, secrets, jobs, cronjobs
  name: developer
  apiGroup: rbac.authorization.k8s.io
---
# Platform-level admin binding propagates to ALL team namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-admins
  namespace: platform
  annotations:
    hnc.x-k8s.io/managed-by: "platform-team"
subjects:
- kind: Group
  name: "platform-engineering"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: admin
  apiGroup: rbac.authorization.k8s.io
```

## LimitRange and ResourceQuota Propagation

```yaml
# platform-default-limitrange.yaml
# Propagates to all namespaces: ensures no container runs without resource limits
apiVersion: v1
kind: LimitRange
metadata:
  name: default-container-limits
  namespace: platform
spec:
  limits:
  - type: Container
    # Default requests applied to containers that omit them
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    # Default limits applied to containers that omit them
    default:
      cpu: 500m
      memory: 512Mi
    # Maximum allowed limits per container
    max:
      cpu: "8"
      memory: 16Gi
    # Minimum allowed requests per container
    min:
      cpu: 10m
      memory: 16Mi
---
# commerce-resourcequota.yaml
# Per-team resource quota defined at the team namespace level
# and propagated to child (environment) namespaces
apiVersion: v1
kind: ResourceQuota
metadata:
  name: commerce-team-quota
  namespace: commerce
spec:
  hard:
    # Maximum total CPU across all pods in the namespace
    requests.cpu: "50"
    limits.cpu: "100"
    # Maximum total memory
    requests.memory: 100Gi
    limits.memory: 200Gi
    # Maximum number of pods
    pods: "200"
    # Maximum number of Services of type LoadBalancer (cost control)
    services.loadbalancers: "5"
    # Maximum number of PersistentVolumeClaims
    persistentvolumeclaims: "20"
    # Maximum PVC storage capacity
    requests.storage: 1Ti
```

## SubnamespaceAnchor: Self-Service Namespace Creation

SubnamespaceAnchor enables teams to create child namespaces within their hierarchy without cluster-admin privileges:

```yaml
# RBAC grant allowing the commerce team to create child namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: namespace-creator
  namespace: commerce
rules:
- apiGroups: ["hnc.x-k8s.io"]
  resources: ["subnamespaceanchors"]
  verbs: ["create", "delete", "get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: commerce-namespace-creator
  namespace: commerce
subjects:
- kind: Group
  name: "commerce-team-leads"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: namespace-creator
  apiGroup: rbac.authorization.k8s.io
```

```bash
# Commerce team lead creates a new environment namespace (no platform team required)
kubectl apply -f - <<EOF
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: commerce-canary
  namespace: commerce
EOF

# Verify the namespace was created with all inherited policies
kubectl get namespace commerce-canary
kubectl get networkpolicies -n commerce-canary
kubectl get rolebindings -n commerce-canary
kubectl get limitranges -n commerce-canary
```

## Propagation Control: Exceptions and Overrides

Not every object should propagate everywhere. HNC provides annotation-based controls:

```yaml
# Exclude a specific object from propagation to a specific child
# Use HNC's 'exceptions' field in HierarchyConfiguration
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: commerce-production
spec:
  parent: commerce
  # Exclude specific inherited objects by name
  # (useful for production namespace overrides)
  exceptions:
  - group: networking.k8s.io
    resource: networkpolicies
    excludedNamespaces: []  # No exclusions at this level
```

```yaml
# Mark an object as non-propagatable using annotations
apiVersion: v1
kind: ConfigMap
metadata:
  name: dev-only-config
  namespace: commerce
  annotations:
    # HNC will NOT propagate this ConfigMap to children
    propagate.hnc.x-k8s.io/none: "true"
data:
  debug-mode: "true"
  log-level: "DEBUG"
```

## HNC vs vCluster: Choosing the Right Isolation Model

HNC provides namespace-based soft tenancy. vCluster provides stronger isolation through virtual Kubernetes clusters. The choice depends on the required isolation level.

| Dimension | HNC (Namespace Tenancy) | vCluster (Virtual Cluster) |
|---|---|---|
| **API server access** | Shared (RBAC-scoped) | Per-tenant virtual API server |
| **CRD isolation** | Shared; tenant CRDs affect all tenants | Per-tenant CRD namespace |
| **Admission webhook isolation** | Shared webhooks | Tenant-specific webhooks possible |
| **Node access** | Shared nodes | Shared nodes (by default) |
| **RBAC scope** | Namespace-scoped only | Full cluster-admin within vcluster |
| **Kubernetes version** | Shared cluster version | Tenant can run a different k8s version |
| **Operational complexity** | Low | Medium |
| **Resource overhead** | Negligible | ~200MB per vCluster control plane |
| **Cost** | Negligible | ~$50-150/month per vCluster on cloud |

**Choose HNC when:**
- Tenants are internal teams with similar security requirements
- CRD conflicts are not a concern (all teams use the same operator set)
- Administrative simplicity is valued over strong isolation
- Hundreds of tenants make per-tenant control planes cost-prohibitive

**Choose vCluster when:**
- External customers need cluster-admin within their environment
- Tenants need custom CRDs that might conflict across tenants
- Compliance requires strong API server isolation
- Teams need to test different Kubernetes versions

## Auditing Propagation Status

```bash
# Check which objects have been propagated to a namespace
kubectl get networkpolicies -n commerce-dev -o yaml | \
  yq '.items[] | {name: .metadata.name, managed_by: .metadata.annotations["hnc.x-k8s.io/inherited-from"]}'

# List all namespaces in the hierarchy and their parent
kubectl hns tree platform

# Check for propagation errors (failed propagations show as conditions)
kubectl get hierarchyconfigurations -A -o yaml | \
  yq '.items[] | select(.status.conditions != null) | {namespace: .metadata.namespace, conditions: .status.conditions}'

# Verify a specific policy exists in all expected namespaces
for ns in commerce-dev commerce-staging commerce-production; do
  echo -n "Checking ${ns}: "
  kubectl get networkpolicy baseline-deny-external-egress -n "${ns}" \
    -o jsonpath='{.metadata.annotations.hnc\.x-k8s\.io/inherited-from}' 2>/dev/null || echo "MISSING"
done

# Show full hierarchy with resource counts per namespace
kubectl hns describe platform --full
```

## Namespace Lifecycle Management

```bash
#!/usr/bin/env bash
# team-namespace-provision.sh
# Provision a new team namespace hierarchy with all required objects.
# Usage: ./team-namespace-provision.sh <team-name> <parent-namespace>

set -euo pipefail

TEAM="${1:?Team name required}"
PARENT="${2:-platform}"
TEAM_NS="${TEAM}"

echo "=== Provisioning namespace hierarchy for team: ${TEAM} ==="

# Create team namespace as a child of the platform namespace
kubectl apply -f - <<EOF
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: ${TEAM_NS}
  namespace: ${PARENT}
EOF

# Wait for namespace to be created
kubectl wait --for=jsonpath='{.status.phase}'=Active \
  namespace "${TEAM_NS}" --timeout=30s

# Apply team-specific resource quota (not propagated — per-namespace control)
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: ${TEAM}-team-quota
  namespace: ${TEAM_NS}
  annotations:
    # Do not propagate this quota to child namespaces
    propagate.hnc.x-k8s.io/none: "true"
spec:
  hard:
    requests.cpu: "20"
    limits.cpu: "40"
    requests.memory: 40Gi
    limits.memory: 80Gi
    pods: "100"
EOF

# Grant namespace-creator rights to team leads
kubectl apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${TEAM}-namespace-creator
  namespace: ${TEAM_NS}
subjects:
- kind: Group
  name: "${TEAM}-leads"
  apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: namespace-creator
  apiGroup: rbac.authorization.k8s.io
EOF

echo "=== Team namespace '${TEAM_NS}' provisioned under '${PARENT}' ==="
echo "Team leads (group: ${TEAM}-leads) can create child namespaces."
echo "All platform policies have been propagated automatically."
kubectl hns tree "${PARENT}" | grep -A5 "${TEAM_NS}"
```

The Hierarchical Namespace Controller transforms Kubernetes multi-tenancy from a manual policy distribution problem into a declarative hierarchy management problem. Platform teams define policies once at the appropriate level of the namespace tree, and HNC ensures all descendant namespaces receive and maintain those policies — eliminating drift, reducing operational toil, and enabling self-service namespace creation without compromising baseline security posture.
