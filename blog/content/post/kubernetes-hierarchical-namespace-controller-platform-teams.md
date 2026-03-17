---
title: "Kubernetes Hierarchical Namespace Controller: Namespace Trees for Platform Teams"
date: 2031-02-12T00:00:00-05:00
draft: false
tags: ["Kubernetes", "HNC", "Namespaces", "Platform Engineering", "RBAC", "Multi-tenancy"]
categories:
- Kubernetes
- Platform Engineering
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes Hierarchical Namespace Controller covering HNC installation, SubnamespaceAnchor resources, policy propagation for RBAC and NetworkPolicy, namespace deletion cascading, and migrating flat namespace structures to hierarchies."
more_link: "yes"
url: "/kubernetes-hierarchical-namespace-controller-platform-teams/"
---

Managing hundreds of namespaces in a large Kubernetes cluster is painful without structure. The Hierarchical Namespace Controller (HNC) transforms flat namespace forests into parent-child trees, enabling platform teams to propagate RBAC policies, NetworkPolicies, and LimitRanges from parent namespaces to all descendants automatically. This guide covers everything needed to deploy HNC in production and migrate an existing cluster.

<!--more-->

# Kubernetes Hierarchical Namespace Controller: Namespace Trees for Platform Teams

## The Problem with Flat Namespaces

A typical large Kubernetes cluster has namespaces organized like this:

```
team-a-dev
team-a-staging
team-a-prod
team-b-dev
team-b-staging
team-b-prod
infra-monitoring
infra-logging
shared-services
```

Managing RBAC for this structure requires creating identical RoleBindings in each namespace. When a new engineer joins team-a, an administrator must update three namespaces. When a new policy is required (NetworkPolicy, LimitRange, ResourceQuota), it must be applied to every namespace individually. This operational burden scales linearly with cluster size.

HNC solves this by allowing namespace hierarchies:

```
root
├── team-a (parent)
│   ├── team-a-dev
│   ├── team-a-staging
│   └── team-a-prod
├── team-b (parent)
│   ├── team-b-dev
│   ├── team-b-staging
│   └── team-b-prod
└── infra (parent)
    ├── infra-monitoring
    └── infra-logging
```

Policies applied to `team-a` are automatically propagated to all three child namespaces.

## Section 1: HNC Installation and Architecture

### Prerequisites

```bash
# Kubernetes 1.16+ is required
# kubectl and cluster admin access are required

kubectl version --short
# Server Version: v1.28.3
```

### Installing HNC

```bash
# Install HNC using the official manifest
# Check https://github.com/kubernetes-sigs/hierarchical-namespaces for the latest version
HNC_VERSION=v1.1.0

kubectl apply -f \
  https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/${HNC_VERSION}/default.yaml

# Wait for HNC to be ready
kubectl wait --for=condition=Ready pod \
  -l app=hnc-controller-manager \
  -n hnc-system \
  --timeout=120s

# Verify installation
kubectl get pods -n hnc-system
# NAME                                       READY   STATUS    RESTARTS
# hnc-controller-manager-7d6c5f9d4b-xk9p2   1/1     Running   0
```

### Installing the kubectl-hns Plugin

```bash
# Install the hierarchical namespace kubectl plugin
HNC_VERSION=v1.1.0
OS=$(uname | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/')

curl -L "https://github.com/kubernetes-sigs/hierarchical-namespaces/releases/download/${HNC_VERSION}/kubectl-hns_${OS}_${ARCH}" \
  -o /usr/local/bin/kubectl-hns
chmod +x /usr/local/bin/kubectl-hns

# Verify
kubectl hns version
```

### HNC Architecture Components

HNC installs these components:

```bash
kubectl get all -n hnc-system
# The key components are:
# - hnc-controller-manager: Main controller, watches HierarchyConfiguration and propagates objects
# - HierarchyConfiguration CRD: Defines parent-child relationships
# - SubnamespaceAnchor CRD: Creates child namespaces declaratively
# - HNCConfiguration CRD: Global HNC configuration (propagated resource types)

kubectl get crd | grep hnc
# hierarchyconfigurations.hnc.x-k8s.io
# hncconfigurations.hnc.x-k8s.io
# subnamespaceanchors.hnc.x-k8s.io
```

## Section 2: Creating Namespace Hierarchies

### Establishing a Parent-Child Relationship

```bash
# Create parent and child namespaces
kubectl create namespace team-a
kubectl create namespace team-a-dev

# Set team-a as the parent of team-a-dev
kubectl hns set team-a-dev --parent team-a

# Verify the hierarchy
kubectl hns describe team-a
# Hierarchy configuration for namespace team-a:
#   Depth: 1
#   Labels: none
#   Annotations: none
#   Children:
#     team-a-dev
#   Conditions: none

# Check the HierarchyConfiguration object directly
kubectl get hierarchyconfiguration -n team-a-dev -o yaml
```

```yaml
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: team-a-dev
spec:
  parent: team-a
status:
  children: []
  conditions: []
  parent: team-a
```

### SubnamespaceAnchor: Declarative Child Namespace Creation

Instead of creating namespaces and then setting parents, use SubnamespaceAnchor to create child namespaces declaratively:

```yaml
# team-a-children.yaml
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  # The anchor lives in the PARENT namespace
  name: team-a-dev
  namespace: team-a
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-a-staging
  namespace: team-a
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-a-prod
  namespace: team-a
```

```bash
kubectl apply -f team-a-children.yaml

# HNC automatically creates the child namespaces
kubectl get namespaces | grep team-a
# team-a             Active
# team-a-dev         Active
# team-a-staging     Active
# team-a-prod        Active

# The child namespaces have labels indicating their hierarchy
kubectl get namespace team-a-dev -o jsonpath='{.metadata.labels}' | jq
# {
#   "hnc.x-k8s.io/team-a": "allowed",
#   "kubernetes.io/metadata.name": "team-a-dev"
# }
```

### Deep Hierarchies

HNC supports multi-level hierarchies:

```yaml
# Create a three-level hierarchy: org -> team -> environment
---
# Level 1: Organization namespace
apiVersion: v1
kind: Namespace
metadata:
  name: engineering
---
# Level 2: Team namespace (child of engineering)
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: platform-team
  namespace: engineering
---
# Level 3: Environment namespace (child of platform-team)
# This is created by applying an anchor in the platform-team namespace
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: platform-team-prod
  namespace: platform-team
```

```bash
# Visualize the full tree
kubectl hns tree engineering
# engineering
# └── [s] platform-team
#     └── [s] platform-team-prod
# [s] = subnamespace (created via SubnamespaceAnchor)
```

## Section 3: Policy Propagation

### Configuring Resource Propagation

HNC propagates resources from parent to child namespaces. By default, it propagates RoleBindings and NetworkPolicies. You can extend this to other resource types:

```yaml
# hnc-config.yaml - Configure which resources HNC propagates
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HNCConfiguration
metadata:
  name: config
  namespace: hnc-system
spec:
  resources:
    - resource: rolebindings
      group: rbac.authorization.k8s.io
      mode: Propagate
    - resource: networkpolicies
      group: networking.k8s.io
      mode: Propagate
    - resource: limitranges
      group: ""
      mode: Propagate
    - resource: resourcequotas
      group: ""
      mode: Propagate
    - resource: configmaps
      group: ""
      mode: Propagate
    - resource: secrets
      group: ""
      mode: Propagate
```

```bash
kubectl apply -f hnc-config.yaml

# Verify propagation configuration
kubectl get hncconfigurations config -n hnc-system -o yaml
```

### RBAC Propagation

The most powerful use of HNC is propagating RBAC policies:

```yaml
# team-a-rbac.yaml
# Apply this in the team-a (parent) namespace.
# It will automatically propagate to team-a-dev, team-a-staging, team-a-prod.

---
# Grant team-a developers view access to all team-a namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: developer-view
  namespace: team-a
  # HNC propagates resources with this annotation set automatically
  # The annotation is added by HNC on propagated copies; it is set on the source
subjects:
  - kind: Group
    name: team-a-developers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
---
# Grant team-a leads edit access to all team-a namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: lead-edit
  namespace: team-a
subjects:
  - kind: Group
    name: team-a-leads
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: edit
  apiGroup: rbac.authorization.k8s.io
```

```bash
kubectl apply -f team-a-rbac.yaml

# Verify propagation to child namespaces
kubectl get rolebindings -n team-a-dev
# NAME            ROLE                AGE
# developer-view  ClusterRole/view    5s
# lead-edit       ClusterRole/edit    5s

# The propagated RoleBindings have an annotation indicating their source
kubectl get rolebinding developer-view -n team-a-dev -o yaml | grep annotations -A5
# annotations:
#   hnc.x-k8s.io/inherited-from: team-a
```

### NetworkPolicy Propagation

```yaml
# team-a-network-policy.yaml
# Applied in team-a; propagated to all children

---
# Deny all traffic by default for all team-a namespaces
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: team-a
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
# Allow intra-namespace communication within team-a namespaces
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: team-a
spec:
  podSelector: {}
  ingress:
    - from:
        - podSelector: {}
  egress:
    - to:
        - podSelector: {}
---
# Allow DNS resolution for all team-a namespace pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: team-a
spec:
  podSelector: {}
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
---
# Allow access to the monitoring namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-monitoring-scrape
  namespace: team-a
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
```

```bash
kubectl apply -f team-a-network-policy.yaml

# Verify all three child namespaces received the policies
for ns in team-a-dev team-a-staging team-a-prod; do
    echo "=== $ns ==="
    kubectl get networkpolicies -n "$ns"
done
```

### LimitRange Propagation

```yaml
# team-a-limits.yaml
# Propagated from team-a to all child namespaces

apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: team-a
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: "100m"
        memory: "128Mi"
      default:
        cpu: "500m"
        memory: "512Mi"
      max:
        cpu: "2"
        memory: "4Gi"
    - type: Pod
      max:
        cpu: "4"
        memory: "8Gi"
```

```bash
kubectl apply -f team-a-limits.yaml

# Verify propagation
kubectl get limitranges -n team-a-staging
# NAME             CREATED AT
# default-limits   2031-02-12T00:00:00Z
```

## Section 4: Propagation Modes and Exceptions

### Propagation Mode Reference

HNC supports three propagation modes for each resource type:

```yaml
spec:
  resources:
    # Propagate: copy from parent to all descendants (read-only in descendants)
    - resource: rolebindings
      group: rbac.authorization.k8s.io
      mode: Propagate

    # Remove: delete all existing copies in descendant namespaces
    # (used when disabling propagation for a resource type)
    - resource: configmaps
      group: ""
      mode: Remove

    # Ignore: do not propagate and do not remove existing
    # (useful for gradual migration)
    - resource: secrets
      group: ""
      mode: Ignore
```

### Preventing Propagation of Specific Resources

Use the `hnc.x-k8s.io/none` annotation to prevent a specific resource from being propagated:

```yaml
# This ConfigMap will NOT be propagated to child namespaces
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-only-config
  namespace: team-a
  annotations:
    hnc.x-k8s.io/none: "true"
data:
  environment: production
```

### Selectively Overriding Propagated Resources

A child namespace can override a propagated resource by creating its own version. HNC will not overwrite resources that are explicitly created in a child namespace:

```bash
# The default-limits LimitRange is propagated from team-a to team-a-prod
# But team-a-prod has higher requirements, so we override it:

kubectl apply -f - <<EOF
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: team-a-prod
  annotations:
    # Explicitly mark as a local override
    hnc.x-k8s.io/none: "true"
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: "500m"
        memory: "512Mi"
      default:
        cpu: "2"
        memory: "2Gi"
      max:
        cpu: "8"
        memory: "16Gi"
EOF

# HNC will now leave this resource alone in team-a-prod
# The version from team-a does NOT overwrite this local definition
```

## Section 5: Namespace Deletion and Cascading

### Understanding Deletion Semantics

When you delete a namespace that has SubnamespaceAnchor children, HNC prevents deletion by default to avoid accidental cascading deletes. The deletion behavior is controlled by the `HierarchyConfiguration`:

```bash
# Attempting to delete a parent namespace with children fails
kubectl delete namespace team-a
# Error: admission webhook denied the request:
# namespace team-a cannot be deleted because it has subnamespace anchors:
# team-a-dev, team-a-staging, team-a-prod

# To delete the entire tree, first delete the anchors
kubectl delete subnamespaceanchor team-a-dev -n team-a
kubectl delete subnamespaceanchor team-a-staging -n team-a
kubectl delete subnamespaceanchor team-a-prod -n team-a

# Now delete the parent
kubectl delete namespace team-a

# Alternative: use cascading deletion (deletes all children automatically)
kubectl hns set team-a --allowCascadingDeletion
kubectl delete namespace team-a
# This deletes team-a and all its subnamespace descendants
```

### Cascading Deletion Configuration

```yaml
# Allow cascading deletion for a specific namespace
apiVersion: hnc.x-k8s.io/v1alpha2
kind: HierarchyConfiguration
metadata:
  name: hierarchy
  namespace: team-a
spec:
  parent: ""   # team-a is a root namespace
  allowCascadingDeletion: true
```

```bash
# Set cascading deletion programmatically
kubectl patch hierarchyconfiguration hierarchy -n team-a \
  --type='merge' \
  -p '{"spec":{"allowCascadingDeletion":true}}'
```

## Section 6: Migrating Flat Namespaces to Hierarchies

### Migration Strategy

Migrating an existing cluster from flat namespaces to HNC hierarchies requires careful planning to avoid disrupting existing workloads.

**Phase 1: Assessment**

```bash
#!/bin/bash
# assess-namespaces.sh - Analyze existing namespace structure for HNC migration

echo "=== Namespace Inventory ==="
kubectl get namespaces -o custom-columns=\
"NAME:.metadata.name,AGE:.metadata.creationTimestamp,LABELS:.metadata.labels"

echo ""
echo "=== RoleBinding Count per Namespace ==="
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    count=$(kubectl get rolebindings -n "$ns" --no-headers 2>/dev/null | wc -l)
    echo "$ns: $count rolebindings"
done

echo ""
echo "=== Duplicate RoleBindings (candidates for consolidation) ==="
declare -A rb_subjects

for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    while IFS= read -r rb; do
        rb_name=$(echo "$rb" | awk '{print $1}')
        subjects=$(kubectl get rolebinding "$rb_name" -n "$ns" \
            -o jsonpath='{.subjects[*].name}' 2>/dev/null)
        key="${rb_name}:${subjects}"
        rb_subjects["$key"]+="$ns "
    done < <(kubectl get rolebindings -n "$ns" --no-headers 2>/dev/null)
done

for key in "${!rb_subjects[@]}"; do
    namespaces="${rb_subjects[$key]}"
    count=$(echo "$namespaces" | wc -w)
    if [ "$count" -gt 1 ]; then
        echo "RoleBinding '$key' exists in: $namespaces"
    fi
done
```

**Phase 2: Create Parent Namespaces**

```bash
#!/bin/bash
# create-parent-namespaces.sh - Create parent namespaces for each team

TEAMS=("team-a" "team-b" "team-c" "infra" "shared")

for team in "${TEAMS[@]}"; do
    # Create parent namespace if it doesn't exist
    kubectl get namespace "$team" > /dev/null 2>&1 || \
        kubectl create namespace "$team"

    # Label as a platform-managed parent
    kubectl label namespace "$team" \
        "platform.example.com/type=parent" \
        "platform.example.com/managed=true" \
        --overwrite

    echo "Created/configured parent namespace: $team"
done
```

**Phase 3: Establish Hierarchy for Existing Namespaces**

```bash
#!/bin/bash
# establish-hierarchy.sh - Reparent existing namespaces

# Define the namespace to parent mapping
declare -A NAMESPACE_PARENTS=(
    ["team-a-dev"]="team-a"
    ["team-a-staging"]="team-a"
    ["team-a-prod"]="team-a"
    ["team-b-dev"]="team-b"
    ["team-b-staging"]="team-b"
    ["team-b-prod"]="team-b"
    ["infra-monitoring"]="infra"
    ["infra-logging"]="infra"
)

for ns in "${!NAMESPACE_PARENTS[@]}"; do
    parent="${NAMESPACE_PARENTS[$ns]}"
    echo "Setting $parent as parent of $ns..."

    # Set the parent relationship
    kubectl hns set "$ns" --parent "$parent"

    # Wait for HNC to process the relationship
    sleep 2

    # Verify
    actual_parent=$(kubectl get hierarchyconfiguration hierarchy \
        -n "$ns" \
        -o jsonpath='{.spec.parent}' 2>/dev/null)

    if [ "$actual_parent" = "$parent" ]; then
        echo "  OK: $ns -> $parent"
    else
        echo "  ERROR: $ns parent is '$actual_parent', expected '$parent'"
    fi
done
```

**Phase 4: Consolidate Policies to Parent Namespaces**

```bash
#!/bin/bash
# consolidate-rolebindings.sh - Move duplicate RoleBindings to parent namespace

# Example: Move the developer-view RoleBinding to team-a
# (it currently exists in team-a-dev, team-a-staging, team-a-prod)

PARENT_NS="team-a"
RB_NAME="developer-view"

# Get the RoleBinding from one of the child namespaces as a template
kubectl get rolebinding "$RB_NAME" -n team-a-dev -o yaml | \
    sed "s/namespace: team-a-dev/namespace: ${PARENT_NS}/" | \
    # Remove resource version and uid to allow re-creation
    grep -v "resourceVersion:\|uid:\|creationTimestamp:" | \
    kubectl apply -f -

# Remove the now-redundant RoleBindings from child namespaces
# (HNC will propagate the one from the parent)
for child in team-a-dev team-a-staging team-a-prod; do
    kubectl delete rolebinding "$RB_NAME" -n "$child" --ignore-not-found
done

echo "Consolidated $RB_NAME to $PARENT_NS"
echo "HNC will propagate it to all children"
```

**Phase 5: Validation**

```bash
#!/bin/bash
# validate-migration.sh - Verify the hierarchy is correctly established

echo "=== Namespace Tree ==="
kubectl hns tree team-a

echo ""
echo "=== Propagated RoleBindings in children ==="
for ns in team-a-dev team-a-staging team-a-prod; do
    echo "--- $ns ---"
    kubectl get rolebindings -n "$ns" \
        -o custom-columns="NAME:.metadata.name,INHERITED:.metadata.annotations.hnc\.x-k8s\.io/inherited-from"
done

echo ""
echo "=== HNC Conditions (should be empty) ==="
kubectl get hierarchyconfigurations -A -o json | \
    jq -r '.items[] | select(.status.conditions != null and (.status.conditions | length) > 0) |
    "\(.metadata.namespace): \(.status.conditions[].message)"'
```

## Section 7: Advanced HNC Patterns

### Multi-Team Platform Architecture

```yaml
# complete-platform-hierarchy.yaml
# This manifest creates a complete platform namespace hierarchy

---
# Root platform namespace (cluster admin owned)
apiVersion: v1
kind: Namespace
metadata:
  name: platform
  labels:
    platform.example.com/tier: root
---
# Infrastructure parent namespace
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: infra
  namespace: platform
---
# Team parent namespaces
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-a
  namespace: platform
---
apiVersion: hnc.x-k8s.io/v1alpha2
kind: SubnamespaceAnchor
metadata:
  name: team-b
  namespace: platform
---
# Platform-wide RBAC: platform admins can manage all namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-admin
  namespace: platform
subjects:
  - kind: Group
    name: platform-admins
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: admin
  apiGroup: rbac.authorization.k8s.io
---
# Platform-wide NetworkPolicy: allow cluster DNS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-cluster-dns
  namespace: platform
spec:
  podSelector: {}
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
      to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
```

### HNC with Kyverno Policy Propagation

HNC can be used alongside Kyverno for additional policy enforcement:

```yaml
# kyverno-hnc-policy.yaml
# Enforce that all HNC child namespaces inherit a required label

apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-team-label-in-hnc-child
spec:
  validationFailureAction: enforce
  rules:
    - name: check-team-label
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchExpressions:
                  - key: hnc.x-k8s.io/included-namespace
                    operator: Exists
      validate:
        message: "HNC child namespaces must have a team label"
        pattern:
          metadata:
            labels:
              "platform.example.com/team": "?*"
```

## Section 8: Monitoring HNC

### HNC Metrics and Alerts

```yaml
# hnc-monitoring.yaml - PrometheusRule for HNC alerts

apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: hnc-alerts
  namespace: monitoring
spec:
  groups:
    - name: hnc
      rules:
        - alert: HNCControllerNotReady
          expr: |
            kube_deployment_status_replicas_ready{
              deployment="hnc-controller-manager",
              namespace="hnc-system"
            } < 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "HNC controller is not ready"
            description: "The HNC controller manager has been unavailable for more than 2 minutes."

        - alert: HNCPropagationErrors
          expr: |
            increase(controller_runtime_reconcile_errors_total{
              controller=~".*hnc.*"
            }[5m]) > 0
          for: 1m
          labels:
            severity: warning
          annotations:
            summary: "HNC reconciliation errors detected"
            description: "HNC is experiencing reconciliation errors that may indicate propagation failures."
```

```bash
# Check HNC controller metrics
kubectl port-forward -n hnc-system \
  deployment/hnc-controller-manager 8080:8080

# In another terminal
curl -s http://localhost:8080/metrics | grep hnc

# Check for HNC conditions that indicate problems
kubectl get hierarchyconfigurations -A \
  -o jsonpath='{range .items[?(@.status.conditions)]}{.metadata.namespace}{": "}{.status.conditions[*].message}{"\n"}{end}'
```

## Section 9: Troubleshooting Common HNC Issues

### Issue: Namespace Has Multiple Parents

```bash
# HNC prevents a namespace from having multiple parents
# This error appears when setting a parent on a namespace that already has one

kubectl hns set team-a-dev --parent team-b
# Error: namespace team-a-dev already has a parent: team-a
# You must remove the existing parent before setting a new one

# Remove existing parent first
kubectl hns set team-a-dev --root
# This makes team-a-dev a root namespace (no parent)

# Now set the new parent
kubectl hns set team-a-dev --parent team-b
```

### Issue: Propagated Resource Not Appearing in Child

```bash
# Debug propagation failures
kubectl hns describe team-a

# Check HNC controller logs for errors
kubectl logs -n hnc-system \
  -l app=hnc-controller-manager \
  --tail=100 | grep -i error

# Check if the resource type is configured for propagation
kubectl get hncconfigurations config -n hnc-system \
  -o jsonpath='{.spec.resources[*]}' | jq

# Verify the resource in the parent namespace does not have hnc.x-k8s.io/none annotation
kubectl get rolebinding developer-view -n team-a \
  -o jsonpath='{.metadata.annotations}'
```

### Issue: Namespace Loop Prevention

```bash
# HNC prevents cycles in the namespace hierarchy
kubectl hns set team-a --parent team-a-dev
# Error: Setting team-a's parent to team-a-dev would create a cycle:
# team-a -> team-a-dev -> team-a

# Verify current hierarchy before making changes
kubectl hns tree platform
```

## Conclusion

The Hierarchical Namespace Controller transforms namespace management from a tedious per-namespace chore into a scalable tree-based policy system. Platform teams can define RBAC policies, network policies, and resource limits once in a parent namespace and trust HNC to propagate them consistently to all descendants. The migration path from flat namespaces is gradual and safe — existing workloads continue running while the hierarchy is established around them. For any Kubernetes cluster managing more than a dozen teams or environments, HNC is a force multiplier that significantly reduces administrative overhead while improving policy consistency.
