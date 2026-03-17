---
title: "Kubernetes Multi-Tenancy with HNC (Hierarchical Namespace Controller): Namespace Trees, Policy Propagation, and Enterprise Isolation"
date: 2031-10-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HNC", "Multi-Tenancy", "RBAC", "Namespace", "Policy", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes multi-tenancy using HNC (Hierarchical Namespace Controller) covering namespace tree construction, automatic policy propagation, subnamespace ownership, RBAC inheritance, and enterprise isolation patterns."
more_link: "yes"
url: "/kubernetes-multi-tenancy-hnc-hierarchical-namespace-controller-policy-propagation/"
---

Multi-tenancy in Kubernetes traditionally requires either one cluster per tenant (expensive) or manual per-namespace RBAC/NetworkPolicy management (error-prone at scale). The Hierarchical Namespace Controller (HNC) introduces a namespace tree model where policies, RBAC, and resource quotas propagate automatically from parent namespaces to children. This guide covers HNC's complete feature set including subnamespace creation, propagation rules, exception handling, and integration with OPA Gatekeeper for enterprise isolation.

<!--more-->

# Kubernetes Multi-Tenancy with HNC

## Section 1: HNC Architecture

HNC extends Kubernetes with two primary CRDs:

- **HierarchyConfiguration** — defines the parent-child relationship for a namespace
- **SubnamespaceAnchor** — creates child namespaces owned by their parent

The HNC controller watches these CRDs and propagates objects (RoleBindings, NetworkPolicies, ResourceQuotas, etc.) from parent namespaces down the tree.

```
root-organization
├── team-platform
│   ├── team-platform-dev
│   ├── team-platform-staging
│   └── team-platform-prod
├── team-payments
│   ├── team-payments-dev
│   └── team-payments-prod
└── team-analytics
    ├── team-analytics-dev
    └── team-analytics-prod
```

Objects in `root-organization` propagate to ALL namespaces in the tree. Objects in `team-payments` propagate to `team-payments-dev` and `team-payments-prod` only.

## Section 2: Installation

```bash
# Install HNC (version 1.1.x)
kubectl apply -f https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/default.yaml

# Install HNC kubectl plugin (hnc plugin)
curl -L https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/v1.1.0/kubectl-hns_linux_amd64 \
  -o /usr/local/bin/kubectl-hns
chmod +x /usr/local/bin/kubectl-hns

# Verify installation
kubectl -n hnc-system get deployment
kubectl hns version

# Enable HNC for specific resource types (configure which objects propagate)
kubectl apply -f - <<'EOF'
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
spec:
  resources:
    - resource: rolebindings
      group: rbac.authorization.k8s.io
      mode: Propagate     # Propagate from parent to children
    - resource: networkpolicies
      group: networking.k8s.io
      mode: Propagate
    - resource: resourcequotas
      group: ""
      mode: Propagate
    - resource: limitranges
      group: ""
      mode: Propagate
    - resource: configmaps
      group: ""
      mode: Propagate     # Useful for shared config
    - resource: secrets
      group: ""
      mode: Propagate     # Careful with sensitive secrets
    - resource: serviceaccounts
      group: ""
      mode: Propagate
EOF
```

## Section 3: Building the Namespace Tree

### Creating the Root Organization Namespace

```bash
# Create root namespace
kubectl create namespace root-organization

# Initialize HNC configuration for root
kubectl hns set root-organization --root
```

### Creating Team Namespaces via SubnamespaceAnchor

```yaml
# team-platform-anchor.yaml
# Applied in the root-organization namespace
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-platform
  namespace: root-organization
spec:
  annotations:
    team: platform
    cost-center: "CC-1001"
  labels:
    team: platform
    tier: infrastructure
```

```bash
kubectl apply -f team-platform-anchor.yaml

# Verify the child namespace was created
kubectl get namespace team-platform
kubectl hns describe team-platform
# Output shows: Parent: root-organization

# Create child namespaces under team-platform
kubectl apply -f - <<'EOF'
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-platform-dev
  namespace: team-platform
spec:
  labels:
    environment: development
    team: platform
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-platform-staging
  namespace: team-platform
spec:
  labels:
    environment: staging
    team: platform
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-platform-prod
  namespace: team-platform
spec:
  labels:
    environment: production
    team: platform
EOF

# Verify tree structure
kubectl hns tree root-organization
# root-organization
# └── [s] team-platform
#     ├── [s] team-platform-dev
#     ├── [s] team-platform-staging
#     └── [s] team-platform-prod
```

### Creating the Full Organization Tree

```bash
#!/usr/bin/env bash
# setup-namespace-tree.sh

set -euo pipefail

declare -A TEAMS=(
  ["team-platform"]="CC-1001"
  ["team-payments"]="CC-1002"
  ["team-analytics"]="CC-1003"
  ["team-identity"]="CC-1004"
)

declare -A ENVS=(
  ["dev"]="development"
  ["staging"]="staging"
  ["prod"]="production"
)

# Create root
kubectl create namespace root-organization --dry-run=client -o yaml | kubectl apply -f -
kubectl hns set root-organization --root 2>/dev/null || true

# Create team namespaces
for team in "${!TEAMS[@]}"; do
  cost_center="${TEAMS[$team]}"

  kubectl apply -f - <<EOF
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: ${team}
  namespace: root-organization
spec:
  labels:
    team: ${team#team-}
    tier: team
  annotations:
    cost-center: "${cost_center}"
EOF

  # Wait for namespace to be created
  kubectl wait --for=condition=Ready namespace/${team} --timeout=30s

  # Create environment namespaces under each team
  for env_suffix in "${!ENVS[@]}"; do
    env_name="${ENVS[$env_suffix]}"
    kubectl apply -f - <<EOF
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: ${team}-${env_suffix}
  namespace: ${team}
spec:
  labels:
    team: ${team#team-}
    environment: ${env_name}
    tier: workload
EOF
  done
done

echo "Namespace tree created:"
kubectl hns tree root-organization
```

## Section 4: Policy Propagation

### Organization-Wide NetworkPolicy

```yaml
# networkpolicy-deny-all.yaml — applied to root-organization, propagates everywhere
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all-ingress
  namespace: root-organization
  annotations:
    # HNC will propagate this to all child namespaces
    hnc.x-k8s.io/propagate: "true"
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  egress:
    # Allow DNS
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # Allow HTTPS to external
    - ports:
        - protocol: TCP
          port: 443
```

```yaml
# networkpolicy-allow-intra-team.yaml — applied at team level
# Allows pods within the same team to communicate
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-intra-team
  namespace: team-payments
  # This propagates to team-payments-dev, team-payments-staging, team-payments-prod
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        # Allow from any namespace with matching team label
        - namespaceSelector:
            matchLabels:
              team: payments
```

### RBAC Propagation

```yaml
# rolebinding-team-admin.yaml — applied to team namespace, propagates to all env namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-admin
  namespace: team-payments
  # Propagated by HNC to team-payments-dev, team-payments-staging, team-payments-prod
subjects:
  - kind: Group
    name: payments-team-admins
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: admin
  apiGroup: rbac.authorization.k8s.io
```

```yaml
# rolebinding-org-readonly.yaml — applied to root, all teams get read access
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: org-readonly
  namespace: root-organization
subjects:
  - kind: Group
    name: all-engineers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
```

### ResourceQuota Propagation

```yaml
# quota-root-organization.yaml — base limits for all namespaces
apiVersion: v1
kind: ResourceQuota
metadata:
  name: org-base-quota
  namespace: root-organization
spec:
  hard:
    requests.cpu: "200"          # Total across org
    requests.memory: "400Gi"
    limits.cpu: "400"
    limits.memory: "800Gi"
    pods: "2000"
    services: "500"
    persistentvolumeclaims: "200"
    services.loadbalancers: "20"
    services.nodeports: "10"
```

```yaml
# quota-team-payments.yaml — team-specific quota
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-payments-quota
  namespace: team-payments
spec:
  hard:
    requests.cpu: "50"
    requests.memory: "100Gi"
    limits.cpu: "100"
    limits.memory: "200Gi"
    pods: "500"
```

```yaml
# quota-team-payments-prod.yaml — tighter limits for specific env
apiVersion: v1
kind: ResourceQuota
metadata:
  name: env-specific-quota
  namespace: team-payments-prod
spec:
  hard:
    # Prod gets dedicated limits — overrides team quota
    requests.cpu: "30"
    requests.memory: "60Gi"
    pods: "200"
    services.loadbalancers: "5"
```

## Section 5: Propagation Exceptions

Sometimes you need to prevent a propagated object from appearing in a specific child namespace.

### Object Exceptions

```yaml
# exception-annotated-networkpolicy.yaml
# Prevent a specific NetworkPolicy from propagating to a namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restricted-egress
  namespace: team-analytics
  annotations:
    # Exclude team-analytics-dev from receiving this propagated policy
    propagate.hnc.x-k8s.io/except: "team-analytics-dev"
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              environment: production
```

### Namespace-Level Exception (HNC Allowlist)

```yaml
# hierarchy-config-exception.yaml
# Prevent team-analytics-dev from receiving certain resource types
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: team-analytics-dev
spec:
  parent: team-analytics
  # Do not propagate ResourceQuotas to dev (developers need more headroom)
  exceptions:
    - group: ""
      resource: resourcequotas
      excludedNamespaces: []
```

## Section 6: Full Isolation Patterns

### Namespace Isolation with OPA Gatekeeper

```yaml
# gatekeeper-namespace-isolation.yaml
# Prevent pods in one team's namespace from accessing another team's services
apiVersion: templates.gatekeeper.sh/v1beta1
kind: ConstraintTemplate
metadata:
  name: k8snamespaceaffinitycheck
spec:
  crd:
    spec:
      names:
        kind: K8sNamespaceAffinityCheck
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedTeams:
              type: array
              items:
                type: string

  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8snamespaceaffinitycheck

        violation[{"msg": msg}] {
          # Check that NetworkPolicy selectors reference only same-team namespaces
          input.review.kind.kind == "NetworkPolicy"
          ns := input.review.object.metadata.namespace
          team := input.review.object.metadata.labels["team"]

          peer_ns_selector := input.review.object.spec.ingress[_].from[_].namespaceSelector
          peer_team := peer_ns_selector.matchLabels["team"]

          peer_team != team
          not peer_team in data.inventory.cluster["v1"]["Namespace"][_].metadata.labels["team"]

          msg := sprintf("NetworkPolicy in namespace %v (team: %v) references different team: %v", [ns, team, peer_team])
        }
```

```yaml
# Apply constraint for production namespaces
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNamespaceAffinityCheck
metadata:
  name: production-team-isolation
spec:
  match:
    namespaceSelector:
      matchLabels:
        environment: production
```

### Pod Security via HNC-Propagated PSA Labels

```yaml
# Apply Pod Security Standards via label propagation
# Applied to root-organization — propagates baseline everywhere
# Individual teams can strengthen their own namespaces
apiVersion: v1
kind: Namespace
metadata:
  name: root-organization
  labels:
    # Propagated baseline: blocks known-dangerous pod configurations
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.29
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.29
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.29
```

```bash
# Strengthen prod namespaces to restricted
kubectl label namespace team-payments-prod \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.29 \
  --overwrite
```

## Section 7: Advanced HNC Patterns

### Multi-Level Hierarchy for Platform Teams

```
root-organization
├── shared-infrastructure     # Owned by SRE
│   ├── monitoring            # Prometheus/Grafana
│   ├── logging               # EFK stack
│   └── ingress               # NGINX ingress
├── team-alpha                # Business unit
│   ├── project-apollo
│   │   ├── project-apollo-dev
│   │   └── project-apollo-prod
│   └── project-artemis
│       ├── project-artemis-dev
│       └── project-artemis-prod
└── team-beta
    └── ...
```

```bash
# Create multi-level tree
kubectl apply -f - <<'EOF'
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-alpha
  namespace: root-organization
spec:
  labels:
    business-unit: alpha
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: project-apollo
  namespace: team-alpha
spec:
  labels:
    business-unit: alpha
    project: apollo
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: project-apollo-dev
  namespace: project-apollo
spec:
  labels:
    environment: development
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: project-apollo-prod
  namespace: project-apollo
spec:
  labels:
    environment: production
EOF
```

### Self-Service Namespace Creation

Allow teams to create their own sub-namespaces without cluster-admin:

```yaml
# clusterrole-subnamespace-creator.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: subnamespace-creator
rules:
  - apiGroups: ["hnc.x-k8s.io"]
    resources: ["subnamespaceanchors"]
    verbs: ["create", "delete", "get", "list", "watch", "update", "patch"]
  - apiGroups: ["hnc.x-k8s.io"]
    resources: ["hierarchyconfigurations"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list", "watch"]
    # Note: not "create" — HNC creates namespaces, not the user
```

```yaml
# Grant team-payments admins the ability to create sub-namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: subns-creator
  namespace: team-payments    # Limited to their own namespace
subjects:
  - kind: Group
    name: payments-team-admins
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: subnamespace-creator
  apiGroup: rbac.authorization.k8s.io
```

### Propagated LimitRange for Defaults

```yaml
# limitrange-defaults.yaml — propagated from root to all namespaces
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: root-organization
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
        cpu: "8"
        memory: "16Gi"
      min:
        cpu: "50m"
        memory: "64Mi"
    - type: Pod
      max:
        cpu: "16"
        memory: "32Gi"
    - type: PersistentVolumeClaim
      max:
        storage: "200Gi"
      min:
        storage: "1Gi"
```

## Section 8: HNC with Kyverno for Enhanced Policy Propagation

```yaml
# kyverno-policy-propagate-networkpolicy.yaml
# Kyverno generates environment-specific NetworkPolicies in child namespaces
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-deny-all-network-policy
spec:
  rules:
    - name: deny-all-ingress
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  tier: workload
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: deny-all-ingress
        namespace: "{{request.object.metadata.name}}"
        synchronize: true   # Update when source changes
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
```

## Section 9: Monitoring HNC

```bash
# Check propagation status
kubectl hns describe team-payments

# List all propagated objects in a namespace
kubectl get rolebindings -n team-payments-prod \
  -l hnc.x-k8s.io/inherited-from

# Check for propagation failures
kubectl get events -n hnc-system | grep -i error

# HNC metrics (if Prometheus is configured)
kubectl port-forward -n hnc-system svc/hnc-controller-manager-metrics-service 8080:8080 &
curl localhost:8080/metrics | grep hnc_

# Key metrics:
# hnc_managed_namespaces_total
# hnc_hierarchy_config_objects_total
# hnc_propagated_objects_total
# hnc_propagation_exceptions_total

# List all namespaces with their parents
kubectl hns tree root-organization --all-namespaces

# Audit all propagated objects org-wide
kubectl get networkpolicies \
  -l hnc.x-k8s.io/inherited-from \
  --all-namespaces \
  -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,FROM:.metadata.labels.hnc\.x-k8s\.io/inherited-from'
```

## Section 10: Migration from Flat Namespaces

```bash
#!/usr/bin/env bash
# migrate-to-hnc.sh — migrates existing flat namespaces to HNC hierarchy

set -euo pipefail

PARENT_NS="${1:?parent namespace required}"
CHILD_NS="${2:?child namespace required}"

# Step 1: Verify both namespaces exist
kubectl get namespace "$PARENT_NS" "$CHILD_NS"

# Step 2: Set parent relationship
kubectl hns set "$CHILD_NS" --parent "$PARENT_NS"

# Step 3: Verify hierarchy
kubectl hns tree "$PARENT_NS"

# Step 4: Check for propagation conflicts
echo "Checking for object conflicts..."
for resource_type in rolebindings networkpolicies resourcequotas limitranges; do
    # Objects in parent that would conflict with existing objects in child
    PARENT_OBJECTS=$(kubectl get "$resource_type" -n "$PARENT_NS" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)
    for obj in $PARENT_OBJECTS; do
        if kubectl get "$resource_type" "$obj" -n "$CHILD_NS" &>/dev/null; then
            echo "CONFLICT: $resource_type/$obj exists in both $PARENT_NS and $CHILD_NS"
            echo "  Resolution: rename the child object or delete it if it's already managed by the parent"
        fi
    done
done

# Step 5: List what WILL be propagated from parent to child
echo ""
echo "Objects that will be propagated from $PARENT_NS to $CHILD_NS:"
for resource_type in rolebindings networkpolicies resourcequotas limitranges; do
    kubectl get "$resource_type" -n "$PARENT_NS" -o name 2>/dev/null | \
        sed "s|^|  |" || true
done
```

## Summary

HNC transforms Kubernetes multi-tenancy from a laborious per-namespace configuration problem into a hierarchical policy tree. The key operational patterns are:

- Model your organization as a tree: organization root → business unit → team → environment
- Apply organization-wide policies (default-deny NetworkPolicy, base ResourceQuota, LimitRange defaults) at the root — they propagate everywhere automatically
- Grant teams control over their own subtrees via `subnamespace-creator` ClusterRole bound to their team namespace — teams can create sub-environments without cluster-admin
- Use propagation exceptions (`propagate.hnc.x-k8s.io/except`) to relax policies in development namespaces without modifying the parent policy
- Combine HNC with OPA Gatekeeper to enforce cross-team isolation invariants that HNC itself does not enforce
- Monitor propagation status via `kubectl hns describe` and Prometheus metrics — a failed propagation silently breaks security policies in child namespaces
