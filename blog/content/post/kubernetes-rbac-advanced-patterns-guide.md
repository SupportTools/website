---
title: "Kubernetes RBAC Advanced Patterns: Least Privilege, Aggregated Roles, and Audit-Driven Hardening"
date: 2027-07-02T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RBAC", "Security", "Least Privilege", "Audit", "Service Account"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes RBAC: least privilege patterns, aggregated ClusterRoles, audit log mining for minimal permission sets, service account RBAC for operators and CI/CD, ValidatingAdmissionPolicy for RBAC enforcement, and common over-permissioned configurations to avoid."
more_link: "yes"
url: "/kubernetes-rbac-advanced-patterns-guide/"
---

Kubernetes RBAC is the primary authorization mechanism for the API server, but misconfigured RBAC is one of the most common security findings in Kubernetes cluster audits. The default permissions granted to cluster components, the temptation to grant `cluster-admin` to CI/CD pipelines, and the complexity of multi-tenant namespace isolation all contribute to a proliferation of over-permissioned subjects. This guide covers the RBAC model in depth, patterns for constructing minimal permission sets from audit logs, aggregated ClusterRole composition, service account hardening for operators and CI/CD, impersonation controls, and tooling (rbac-tool, KubeAudit) for ongoing RBAC hygiene.

<!--more-->

## The Kubernetes RBAC Model

### Core Concepts

RBAC in Kubernetes is a deny-by-default, additive authorization model. No permissions are granted unless explicitly configured. The model has four core object types:

**Role**: A namespaced set of permission rules. A Role can only grant access to resources within its namespace.

**ClusterRole**: A cluster-scoped or cross-namespace set of permission rules. ClusterRoles can grant:
- Access to cluster-scoped resources (Nodes, PersistentVolumes, Namespaces).
- Access to non-resource URLs (`/healthz`, `/metrics`).
- Access to namespaced resources across all namespaces (when bound with ClusterRoleBinding).

**RoleBinding**: Binds a Role or ClusterRole to a set of subjects, scoped to the namespace where the RoleBinding exists. Binding a ClusterRole with a RoleBinding restricts that ClusterRole's permissions to the namespace.

**ClusterRoleBinding**: Binds a ClusterRole to subjects cluster-wide. Subjects receiving a ClusterRoleBinding can access resources in all namespaces.

### Subject Types

- **User**: An authenticated human user. Kubernetes does not manage user accounts directly; users are identified by their certificate CN or OIDC token claims.
- **Group**: A named set of users, typically populated by the authenticator (e.g., OIDC groups claim, certificate O field).
- **ServiceAccount**: A namespaced identity for in-cluster workloads. Pods are associated with a ServiceAccount and receive its token via the projected volume at `/var/run/secrets/kubernetes.io/serviceaccount/token`.

### Permission Resolution

When an API request arrives, the API server evaluates all RoleBindings and ClusterRoleBindings whose subjects include the request's identity. If any binding grants the requested verb on the requested resource, the request is allowed. There is no priority ordering; a single matching allow rule grants access.

This means:
- Removing a single binding does not reduce permissions if another binding grants the same permission.
- Auditing a subject's effective permissions requires aggregating all applicable bindings.

---

## Least Privilege Principle in Practice

### Never Grant cluster-admin

`cluster-admin` is a ClusterRole that grants all verbs on all resources. It is appropriate for break-glass emergency accounts and is not appropriate for:
- CI/CD pipelines (even deployment pipelines).
- Monitoring agents.
- Operators (operators should use the minimal permissions their controllers require).
- Developers (even in development namespaces).

```bash
# Find all cluster-admin bindings
kubectl get clusterrolebindings \
  -o json \
  | jq -r '.items[] |
    select(.roleRef.name == "cluster-admin") |
    "\(.metadata.name): \(.subjects[].name)"'
```

### Scoping ClusterRole Bindings to Namespaces

When a service needs read access to a resource type across all namespaces (e.g., a monitoring agent reading Pod metrics), use a ClusterRole bound with per-namespace RoleBindings rather than a ClusterRoleBinding. This prevents the service account from accessing resources in namespaces added in the future.

```yaml
# Define the permission set as a ClusterRole (reusable template)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pod-reader
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]

---
# Bind it only in specific namespaces using RoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: monitoring-pod-reader
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: pod-reader
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: monitoring
```

### Minimal Verb Sets

Grant only the verbs required for a service to function. Common patterns:

| Use Case | Verbs Needed |
|---|---|
| Read-only dashboard | `get`, `list`, `watch` |
| Controller that creates resources | `get`, `list`, `watch`, `create`, `update`, `patch` |
| Controller that manages finalizers | add `update` on the specific resource |
| Garbage collector | add `delete` |
| Status subresource updates | `update` on `status` subresource only |

```yaml
# Separate main resource and status subresource permissions
rules:
  # Main resource: read only
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]

  # Status subresource: can update
  - apiGroups: ["apps"]
    resources: ["deployments/status"]
    verbs: ["update", "patch"]
```

### ResourceName Restrictions

When a service needs access to specific named resources rather than all resources of a type:

```yaml
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["app-config", "feature-flags"]   # Restrict to specific ConfigMaps
    verbs: ["get", "watch"]

  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    resourceNames: ["my-controller-leader"]           # Specific lease for leader election
    verbs: ["get", "create", "update", "patch"]
```

---

## Aggregated ClusterRoles

Aggregated ClusterRoles allow multiple ClusterRoles to be composed into a single ClusterRole automatically. The parent ClusterRole uses label selectors to collect rules from child ClusterRoles. When child ClusterRoles are created or modified, the parent's effective rules update automatically.

This pattern is used by Kubernetes itself for the `admin`, `edit`, and `view` built-in roles: operators can extend these roles by creating ClusterRoles with the appropriate aggregate labels.

### Creating an Aggregate Parent

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-admin
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-platform-admin: "true"
rules: []    # Rules are populated automatically from matching ClusterRoles
```

### Creating Aggregate Children

```yaml
# Grant access to Argo CD application management
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: argocd-application-admin
  labels:
    rbac.example.com/aggregate-to-platform-admin: "true"
rules:
  - apiGroups: ["argoproj.io"]
    resources: ["applications", "appprojects"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

---
# Grant access to certificate management
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cert-manager-admin
  labels:
    rbac.example.com/aggregate-to-platform-admin: "true"
rules:
  - apiGroups: ["cert-manager.io"]
    resources: ["certificates", "certificaterequests", "issuers", "clusterissuers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

---
# Grant access to Flux GitOps resources
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: flux-admin
  labels:
    rbac.example.com/aggregate-to-platform-admin: "true"
rules:
  - apiGroups: ["kustomize.toolkit.fluxcd.io", "source.toolkit.fluxcd.io", "helm.toolkit.fluxcd.io"]
    resources: ["*"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

### Extending Built-In Roles

Add CRD permissions to the built-in `view`, `edit`, and `admin` roles for new operators:

```yaml
# Allow all users with 'view' rights to view Prometheus rules
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-rule-viewer
  labels:
    rbac.authorization.k8s.io/aggregate-to-view: "true"
rules:
  - apiGroups: ["monitoring.coreos.com"]
    resources: ["prometheusrules", "servicemonitors", "podmonitors"]
    verbs: ["get", "list", "watch"]

---
# Allow users with 'edit' rights to create/modify Prometheus rules
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus-rule-editor
  labels:
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
rules:
  - apiGroups: ["monitoring.coreos.com"]
    resources: ["prometheusrules", "servicemonitors", "podmonitors"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

---

## Audit Log Mining for Minimal Permission Sets

### Enabling Audit Logging

Configure the API server with an audit policy that captures RBAC-relevant events:

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all requests at RequestResponse level
  # (reduce for high-volume environments)
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete", "deletecollection"]
    omitStages:
      - RequestReceived

  # Log read operations at Metadata level (reduced verbosity)
  - level: Metadata
    verbs: ["get", "list", "watch"]
    omitStages:
      - RequestReceived

  # Ignore noisy system accounts
  - level: None
    users:
      - "system:kube-proxy"
      - "system:kube-controller-manager"
      - "system:kube-scheduler"
    verbs: ["get", "list", "watch"]
```

API server flags:

```yaml
# kube-apiserver.yaml additions
- --audit-log-path=/var/log/kubernetes/audit.log
- --audit-policy-file=/etc/kubernetes/audit-policy.yaml
- --audit-log-maxage=30
- --audit-log-maxbackup=10
- --audit-log-maxsize=100
```

### Extracting Permission Requirements from Audit Logs

After running a service account through its normal operation cycle, mine the audit logs to extract exactly what it accessed:

```bash
# Extract all API calls made by a specific service account
SA_NAME="my-operator"
SA_NAMESPACE="my-operator-system"
IDENTITY="system:serviceaccount:${SA_NAMESPACE}:${SA_NAME}"

jq -c --arg id "${IDENTITY}" '
  select(
    .user.username == $id or
    (.user.groups // [] | contains([$id]))
  ) |
  {
    verb: .verb,
    resource: .objectRef.resource,
    subresource: .objectRef.subresource,
    apiGroup: .objectRef.apiVersion,
    namespace: .objectRef.namespace
  }
' /var/log/kubernetes/audit.log \
  | sort -u \
  | jq -s '
    group_by(.apiGroup, .resource) |
    map({
      apiGroups: [.[0].apiGroup // ""],
      resources: [.[0].resource + (if .[0].subresource then "/" + .[0].subresource else "" end)],
      verbs: [.[].verb] | unique
    })
  '
```

### Generating a Minimal ClusterRole from Audit Output

```bash
# Generate a Role manifest from mined permissions
generate_role() {
  local sa_name=$1
  local sa_namespace=$2
  local output_file=$3

  IDENTITY="system:serviceaccount:${sa_namespace}:${sa_name}"

  cat > "${output_file}" <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${sa_name}-minimal
rules:
EOF

  jq -c --arg id "${IDENTITY}" '
    select(.user.username == $id) |
    {
      verb: .verb,
      resource: .objectRef.resource,
      subresource: .objectRef.subresource,
      apiGroup: .objectRef.apiVersion
    }
  ' /var/log/kubernetes/audit.log \
    | jq -rs '
      group_by(.apiGroup, .resource, .subresource) |
      map({
        apiGroups: [ (.[0].apiGroup // "" | split("/")[0:-1] | join("/")) ],
        resources: [
          .[0].resource +
          (if .[0].subresource and .[0].subresource != "" then "/" + .[0].subresource else "" end)
        ],
        verbs: [.[].verb] | unique
      }) |
      to_entries[] |
      "  - apiGroups: [\"" + (.value.apiGroups[0]) + "\"]\n    resources: [\"" + (.value.resources[0]) + "\"]\n    verbs: [" + (.value.verbs | map("\"" + . + "\"") | join(", ")) + "]"
    ' \
    | tr -d '"' >> "${output_file}"
}
```

---

## Service Account RBAC for Operators

### Operator Service Account Pattern

Operators typically need RBAC permissions scoped to their managed CRDs and the Kubernetes resources they create/modify. Avoid granting wildcard permissions:

```yaml
# Bad: wildcard permissions
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["*"]

# Good: explicit minimal permissions
rules:
  # Own CRDs
  - apiGroups: ["myoperator.io"]
    resources: ["myresources", "myresources/status", "myresources/finalizers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Kubernetes resources the operator manages
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  - apiGroups: [""]
    resources: ["services", "configmaps", "secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]   # Read-only for pod management

  # Events for operator status reporting
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]

  # Leader election
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    resourceNames: ["myoperator-leader"]
    verbs: ["get", "create", "update", "patch"]
```

### Operator with Namespace-Scoped Deployment

When an operator manages resources only in its own namespace, use Role + RoleBinding instead of ClusterRole + ClusterRoleBinding:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: myoperator-controller
  namespace: myoperator-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: myoperator-controller
  namespace: myoperator-system
rules:
  - apiGroups: ["myoperator.io"]
    resources: ["*"]
    verbs: ["*"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: myoperator-controller
  namespace: myoperator-system
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: myoperator-controller
subjects:
  - kind: ServiceAccount
    name: myoperator-controller
    namespace: myoperator-system
```

### CI/CD Pipeline Service Account

A deployment pipeline needs enough access to update Deployments, ConfigMaps, and Secrets in target namespaces. It does not need to create Namespaces, modify RBAC, or access other namespaces' Secrets:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cicd-deploy
  namespace: ci-system
  annotations:
    description: "Service account for deployment pipeline"
    team: "platform"
    last-reviewed: "2027-01-15"

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: deployment-manager
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch", "update", "patch"]

  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]

  # Secrets: get/update only (no list - prevents bulk secret extraction)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "update", "patch"]

  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]

  # Rollout status checking
  - apiGroups: ["apps"]
    resources: ["deployments/status", "statefulsets/status"]
    verbs: ["get"]

---
# Bind only to specific target namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cicd-deploy
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: deployment-manager
subjects:
  - kind: ServiceAccount
    name: cicd-deploy
    namespace: ci-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cicd-deploy
  namespace: staging
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: deployment-manager
subjects:
  - kind: ServiceAccount
    name: cicd-deploy
    namespace: ci-system
```

---

## Impersonation: The --as Flag

The `--as` flag allows subjects with `impersonate` permission to act as another user or group. This is useful for auditing effective permissions and for automation that acts on behalf of users.

### Granting Impersonation

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: user-impersonator
rules:
  - apiGroups: [""]
    resources: ["users", "groups", "serviceaccounts"]
    verbs: ["impersonate"]

  # Required for impersonating users with specific UID
  - apiGroups: ["authentication.k8s.io"]
    resources: ["userextras/scopes"]
    verbs: ["impersonate"]
```

### Verifying Effective Permissions via Impersonation

```bash
# Check what a specific service account can do
kubectl auth can-i --list \
  --as=system:serviceaccount:production:backend-service \
  -n production

# Check if a specific action is allowed
kubectl auth can-i get secrets \
  --as=system:serviceaccount:ci-system:cicd-deploy \
  -n production

# Check permissions as a member of a specific group
kubectl auth can-i create deployments \
  --as=developer@example.com \
  --as-group=platform-engineers \
  -n production
```

### Restricted Impersonation Scope

Limit impersonation to specific users or service accounts:

```yaml
rules:
  - apiGroups: [""]
    resources: ["users"]
    resourceNames: ["developer-1@example.com", "developer-2@example.com"]
    verbs: ["impersonate"]

  - apiGroups: [""]
    resources: ["serviceaccounts"]
    resourceNames: ["backend-service", "frontend-service"]
    verbs: ["impersonate"]
```

---

## User Groups and Group Bindings

### OIDC Group Claims

When using OIDC authentication (most production clusters do), groups are populated from the `groups` claim in the ID token. The API server is configured with:

```yaml
# kube-apiserver flags
- --oidc-groups-claim=groups
- --oidc-groups-prefix="oidc:"
```

With a prefix, group names in RoleBindings must be prefixed:

```yaml
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: "oidc:platform-engineers"   # prefix:group-name-from-OIDC
```

### Namespace-Per-Team Pattern

A common multi-tenant pattern assigns each team a namespace with full `admin` access within that namespace, but no access to other namespaces:

```yaml
# Create namespace
apiVersion: v1
kind: Namespace
metadata:
  name: team-payments
  labels:
    team: payments

---
# Bind the built-in admin ClusterRole to the payments team
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-payments-admin
  namespace: team-payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: admin
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: "oidc:team-payments"

---
# Give read-only access to the platform team (for support purposes)
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-team-view
  namespace: team-payments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
  - kind: Group
    apiGroup: rbac.authorization.k8s.io
    name: "oidc:platform-engineers"
```

---

## rbac-tool and KubeAudit for RBAC Analysis

### rbac-tool

`rbac-tool` provides commands for visualizing, auditing, and generating RBAC configurations.

```bash
# Install
go install github.com/alcideio/rbac-tool@latest

# List all permissions for a specific subject
rbac-tool policy-rules \
  -e "system:serviceaccount:production:backend-service"

# Generate a WHO-CAN query: who can delete Secrets?
rbac-tool who-can delete secrets -n production

# Visualize RBAC as a graph (requires DOT format viewer)
rbac-tool viz --outfile rbac-graph.dot
dot -Tpng rbac-graph.dot -o rbac-graph.png

# Lookup permissions of all service accounts
rbac-tool policy-rules \
  --kind ServiceAccount \
  -n production \
  | column -t
```

### KubeAudit

KubeAudit is a broader cluster security auditor that includes RBAC-specific checks:

```bash
# Install
go install github.com/Shopify/kubeaudit@latest

# Run all RBAC audits
kubeaudit rbac

# Specific RBAC checks:
# - automountServiceAccountToken enabled when not needed
kubeaudit automountserviceaccounttoken

# - Containers running as root
kubeaudit nonroot

# - Missing security context
kubeaudit securitycontext

# Run full audit and output JSON
kubeaudit all -f cluster-manifest.yaml --output json \
  | jq '.[] | select(.AuditResultName | startswith("RBAC"))'
```

### kubectl auth reconcile

When deploying RBAC changes across clusters, `kubectl auth reconcile` applies changes without erroring on missing permissions:

```bash
# Apply RBAC manifests and report what changed
kubectl auth reconcile \
  --dry-run=client \
  -f rbac-manifests/

# Apply for real
kubectl auth reconcile -f rbac-manifests/
```

---

## ValidatingAdmissionPolicy for RBAC Enforcement

ValidatingAdmissionPolicy (VAP, GA in Kubernetes 1.30+) can enforce organizational RBAC policies using CEL expressions, without requiring OPA Gatekeeper or Kyverno.

### Prevent ClusterRoleBinding to cluster-admin Outside kube-system

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: restrict-cluster-admin-binding
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["rbac.authorization.k8s.io"]
        apiVersions: ["v1"]
        resources: ["clusterrolebindings"]
        operations: ["CREATE", "UPDATE"]

  validations:
    - expression: >-
        object.roleRef.name != "cluster-admin" ||
        (
          has(object.metadata.annotations) &&
          "rbac.example.com/approved-by" in object.metadata.annotations
        )
      message: >-
        ClusterRoleBindings to cluster-admin require the annotation
        'rbac.example.com/approved-by' set to the approver's identity.
      reason: Forbidden

---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: restrict-cluster-admin-binding
spec:
  policyName: restrict-cluster-admin-binding
  validationActions: [Deny]
```

### Prevent Wildcard Permissions in Roles

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: no-wildcard-permissions
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["rbac.authorization.k8s.io"]
        apiVersions: ["v1"]
        resources: ["roles", "clusterroles"]
        operations: ["CREATE", "UPDATE"]

  validations:
    - expression: >-
        !object.rules.exists(rule,
          rule.verbs.exists(v, v == "*") ||
          rule.resources.exists(r, r == "*") ||
          rule.apiGroups.exists(g, g == "*")
        )
      message: >-
        Wildcard (*) permissions are not allowed in Role or ClusterRole rules.
        Specify explicit verbs, resources, and apiGroups.
      reason: Forbidden

---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: no-wildcard-permissions
spec:
  policyName: no-wildcard-permissions
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values: ["kube-system", "kube-public"]   # Exempt system namespaces
```

### Require Service Account Annotations

Enforce documentation discipline on service accounts:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-sa-annotations
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["serviceaccounts"]
        operations: ["CREATE"]

  validations:
    - expression: >-
        has(object.metadata.annotations) &&
        "description" in object.metadata.annotations &&
        "team" in object.metadata.annotations
      message: >-
        ServiceAccounts must have 'description' and 'team' annotations.
      reason: Invalid

---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-sa-annotations
spec:
  policyName: require-sa-annotations
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values: ["kube-system", "kube-public", "cert-manager", "flux-system"]
```

---

## Common Over-Permissioned Configurations

### automountServiceAccountToken

By default, Kubernetes mounts the service account token into every pod, even pods that never make API calls. An attacker with code execution in a pod can exfiltrate the token and use its RBAC permissions.

Disable auto-mounting cluster-wide and opt-in per workload:

```yaml
# Disable on the ServiceAccount (affects all pods using it)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: web-frontend
  namespace: production
automountServiceAccountToken: false

---
# Enable only for pods that need API access
apiVersion: v1
kind: Pod
metadata:
  name: api-accessor
spec:
  automountServiceAccountToken: true   # Override ServiceAccount setting
  serviceAccountName: api-accessor-sa
  containers:
    - name: app
      image: myapp:1.0
```

Set cluster-wide default via admission policy:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: deny-automount-default-sa
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        resources: ["pods"]
        operations: ["CREATE"]

  validations:
    - expression: >-
        object.spec.serviceAccountName != "default" ||
        (has(object.spec.automountServiceAccountToken) &&
         object.spec.automountServiceAccountToken == false)
      message: >-
        Pods using the default ServiceAccount must explicitly set
        automountServiceAccountToken: false, or use a dedicated ServiceAccount.
      reason: Forbidden
```

### The `default` Service Account

Every namespace has a `default` ServiceAccount automatically. Many Helm charts and manifests omit the `serviceAccountName` field, causing pods to run as `default`. If `default` has accumulated RoleBindings (which happens when operators are installed carelessly), all pods in the namespace inherit those permissions.

Audit and clean up bindings to `default`:

```bash
# Find all bindings to the 'default' service account
kubectl get rolebindings,clusterrolebindings \
  -A \
  -o json \
  | jq -r '
    .items[] |
    select(
      .subjects != null and
      (.subjects[] | .kind == "ServiceAccount" and .name == "default")
    ) |
    "\(.kind)/\(.metadata.namespace)/\(.metadata.name): \(.roleRef.name)"
  '
```

### Secrets Read Permission

`list` on Secrets is equivalent to reading all secrets in a namespace. Many RBAC configurations mistakenly grant `get,list,watch` on Secrets when only `get` on specific secrets is needed.

```yaml
# Bad: allows listing all secrets
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]

# Good: restrict to specific secrets by name
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["db-credentials", "api-key"]
    verbs: ["get"]
```

### nodes/proxy Subresource

The `nodes/proxy` subresource allows making arbitrary requests to the kubelet API on any node, effectively granting exec access to any pod on the node and access to sensitive node metadata:

```bash
# Find subjects with nodes/proxy permission
kubectl get clusterrolebindings,rolebindings \
  -A -o json \
  | jq -r '
    .items[] |
    select(
      .rules != null and
      (.rules[].resources | contains(["nodes/proxy"]))
    ) |
    .metadata.name
  '
```

Remove `nodes/proxy` from any role that does not explicitly require Kubernetes Dashboard-level access.

### escalate and bind Verbs

The `escalate` verb on Roles/ClusterRoles allows a user to modify a Role to add permissions they do not already have, bypassing the restriction that users cannot grant permissions they do not possess. The `bind` verb allows a user to create RoleBindings to roles they do not have, with the same effect.

```bash
# Find who has escalate/bind on RBAC resources
kubectl get clusterrolebindings,rolebindings \
  -A -o json \
  | jq -r '
    .items[] |
    select(
      .rules != null and
      (.rules[] | .verbs | (contains(["escalate"]) or contains(["bind"])))
    ) |
    "\(.kind)/\(.metadata.namespace // "cluster")/\(.metadata.name)"
  '
```

---

## RBAC Audit Checklist

Run this checklist quarterly:

```bash
#!/usr/bin/env bash
# rbac-audit.sh

echo "=== cluster-admin bindings ==="
kubectl get clusterrolebindings \
  -o jsonpath='{range .items[?(@.roleRef.name=="cluster-admin")]}{.metadata.name}{"\t"}{range .subjects[*]}{.kind}/{.name}{" "}{end}{"\n"}{end}'

echo ""
echo "=== Wildcard ClusterRoles ==="
kubectl get clusterroles -o json \
  | jq -r '
    .items[] |
    select(
      .rules and
      (.rules[] | .verbs | contains(["*"]) or
       .rules[] | .resources | contains(["*"]) or
       .rules[] | .apiGroups | contains(["*"]))
    ) |
    .metadata.name
  '

echo ""
echo "=== Service accounts with automountServiceAccountToken: true ==="
kubectl get serviceaccounts -A \
  -o jsonpath='{range .items[?(@.automountServiceAccountToken==true)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'

echo ""
echo "=== Bindings to default service accounts ==="
kubectl get rolebindings,clusterrolebindings \
  -A -o json \
  | jq -r '
    .items[] |
    select(
      .subjects != null and
      (.subjects[] | .kind == "ServiceAccount" and .name == "default")
    ) |
    "\(.kind)/\(.metadata.namespace // "cluster")/\(.metadata.name)"
  '

echo ""
echo "=== Roles with secrets list permission ==="
kubectl get roles,clusterroles \
  -A -o json \
  | jq -r '
    .items[] |
    select(
      .rules != null and
      (.rules[] |
        (.resources | contains(["secrets"])) and
        (.verbs | contains(["list"]))
      )
    ) |
    "\(.kind)/\(.metadata.namespace // "cluster")/\(.metadata.name)"
  '
```

---

## Summary

Kubernetes RBAC security requires a sustained, disciplined approach: principle of least privilege enforced through explicit minimal permission sets, aggregated ClusterRoles for composable role management, audit log mining to discover actual permission requirements rather than guessing, and ValidatingAdmissionPolicy to prevent future configuration drift. The most impactful improvements in most clusters are: removing unnecessary cluster-admin bindings, disabling automountServiceAccountToken by default, restricting CI/CD pipelines to namespace-scoped RoleBindings, and implementing admission policies that prevent wildcard permissions. Combined with quarterly rbac-tool and KubeAudit scans, these practices transform RBAC from a chronic security liability into a reliable, enforceable access control boundary.
