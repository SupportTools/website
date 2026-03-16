---
title: "Kubernetes RBAC Advanced Authorization: Roles, Bindings, and Audit Hardening"
date: 2027-06-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RBAC", "Security", "Authorization", "Audit"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes RBAC covering the full authorization model, principle of least privilege, aggregated ClusterRoles, service account hardening, audit policy configuration, rbac-tool and kubectl-who-can, common misconfigurations, wildcard verb dangers, token automounting, and a production hardening checklist."
more_link: "yes"
url: "/kubernetes-rbac-advanced-authorization-guide/"
---

Role-Based Access Control is the primary authorization mechanism in Kubernetes, but it is also one of the most frequently misconfigured components in production clusters. Overly permissive ClusterRoles, service accounts with cluster-admin bindings, wildcard verbs on all resources, and automounted tokens that leak credentials into every pod are patterns seen repeatedly in production security reviews.

This guide covers the full RBAC model from fundamentals to advanced patterns: Role vs ClusterRole scoping, aggregation labels for maintainable permission sets, service account hardening, comprehensive audit policy design, using rbac-tool and kubectl-who-can to analyse the current permission state, the most dangerous misconfigurations and how to detect them, and a production hardening checklist.

<!--more-->

# Kubernetes RBAC Advanced Authorization: Roles, Bindings, and Audit Hardening

## Section 1: The RBAC Model

### Core Resources

Kubernetes RBAC has four primary resource types:

| Resource | Scope | Purpose |
|----------|-------|---------|
| `Role` | Namespaced | Permissions within a single namespace |
| `ClusterRole` | Cluster-wide | Permissions across all namespaces OR for cluster-scoped resources |
| `RoleBinding` | Namespaced | Grants a Role or ClusterRole to subjects within a namespace |
| `ClusterRoleBinding` | Cluster-wide | Grants a ClusterRole to subjects across all namespaces |

The critical distinction: a `ClusterRole` describes a set of permissions, but it only applies cluster-wide when bound with a `ClusterRoleBinding`. When bound with a `RoleBinding`, the ClusterRole's permissions apply only within the binding's namespace. This enables defining permission sets once as ClusterRoles and reusing them across namespaces.

### Subjects

RBAC bindings apply to subjects of three types:

```yaml
subjects:
- kind: User              # Human user (authenticated via OIDC, X.509, etc.)
  name: "alice@example.com"
  apiGroup: rbac.authorization.k8s.io
- kind: Group             # Group of users
  name: "dev-team"
  apiGroup: rbac.authorization.k8s.io
- kind: ServiceAccount    # Pod identity
  name: "my-service-account"
  namespace: production
```

### Verbs and Resources

RBAC permissions are (verb, resource, [subresource]) tuples. Standard verbs:

| Verb | HTTP Method | Description |
|------|------------|-------------|
| `get` | GET | Retrieve a single resource |
| `list` | GET | List resources |
| `watch` | GET (streaming) | Watch for resource changes |
| `create` | POST | Create a resource |
| `update` | PUT | Replace a resource |
| `patch` | PATCH | Partially update a resource |
| `delete` | DELETE | Delete a resource |
| `deletecollection` | DELETE (bulk) | Delete multiple resources |
| `escalate` | special | Update a Role to grant permissions the caller doesn't have |
| `bind` | special | Create bindings to Roles the caller doesn't have |
| `impersonate` | special | Act as another user/group/SA |

### Example: Minimal Read-Only Role

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: production
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch"]
```

### Example: Namespace Admin Role

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: namespace-admin
  namespace: production
rules:
- apiGroups: ["", "apps", "batch", "autoscaling", "networking.k8s.io"]
  resources:
  - pods
  - pods/exec
  - pods/portforward
  - services
  - endpoints
  - deployments
  - statefulsets
  - daemonsets
  - replicasets
  - jobs
  - cronjobs
  - horizontalpodautoscalers
  - ingresses
  - networkpolicies
  - configmaps
  - persistentvolumeclaims
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch"]   # No create/update — secrets managed separately
```

## Section 2: Principle of Least Privilege

### Scoping Roles to Minimum Required Access

The principle of least privilege requires granting only the exact permissions needed for a task to function. Common violations:

**Anti-pattern: Wildcard verbs**
```yaml
# DANGEROUS: grants all verbs on all resources
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
```

**Anti-pattern: Cluster-admin for namespace-scoped work**
```yaml
# DANGEROUS: grants full cluster control
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
```

**Better pattern: Namespace-scoped Role with explicit verbs**
```yaml
rules:
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "update", "patch"]
  # Omit: create, delete, deletecollection
```

### Resource Names for Fine-Grained Access

Restrict access to specific named resources within a resource type:

```yaml
# Grant access to only the "frontend" ConfigMap in production
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: frontend-config-reader
  namespace: production
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["frontend-config", "frontend-feature-flags"]
  verbs: ["get", "watch"]
```

Note: `resourceNames` cannot be used with `list` or `watch` on collection endpoints. Use `get` and `watch` on specific resources, and grant `list` separately if the pod needs to discover the configmap name dynamically.

### Subresource Access Control

Subresources are treated as separate resources in RBAC. This enables granular control:

```yaml
# Allow log viewing and port-forwarding but NOT exec
rules:
- apiGroups: [""]
  resources: ["pods/log", "pods/portforward"]
  verbs: ["get", "create"]
# Explicitly NOT including:
# - pods/exec  (interactive shell access)
# - pods/attach
```

`pods/exec` is particularly sensitive: anyone with this permission can run arbitrary commands in any pod in the namespace, effectively bypassing all application-level access controls.

## Section 3: Aggregated ClusterRoles

### The Aggregation Pattern

ClusterRole aggregation allows composing permission sets from smaller ClusterRoles using label selectors. The built-in `view`, `edit`, and `admin` ClusterRoles use this pattern, and custom extensions can add to them.

```yaml
# Base ClusterRole with aggregation selector
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: custom-aggregate-view
aggregationRule:
  clusterRoleSelectors:
  - matchLabels:
      rbac.example.com/aggregate-to-view: "true"
rules: []   # Rules are populated automatically from matching ClusterRoles
---
# Extension ClusterRole that aggregates into the above
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: custom-crd-view
  labels:
    rbac.example.com/aggregate-to-view: "true"
rules:
- apiGroups: ["monitoring.coreos.com"]
  resources: ["prometheusrules", "servicemonitors", "podmonitors"]
  verbs: ["get", "list", "watch"]
```

### Extending Built-In ClusterRoles

The built-in ClusterRoles `view`, `edit`, and `admin` aggregate from ClusterRoles labelled with `rbac.authorization.k8s.io/aggregate-to-view`, `aggregate-to-edit`, and `aggregate-to-admin` respectively:

```yaml
# Allow 'view' users to see Istio resources
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: istio-view
  labels:
    rbac.authorization.k8s.io/aggregate-to-view: "true"
rules:
- apiGroups: ["networking.istio.io", "security.istio.io"]
  resources:
  - virtualservices
  - destinationrules
  - gateways
  - peerauthentications
  - authorizationpolicies
  verbs: ["get", "list", "watch"]
---
# Allow 'edit' users to manage Argo Rollouts
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: argo-rollouts-edit
  labels:
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
rules:
- apiGroups: ["argoproj.io"]
  resources: ["rollouts", "rollouts/scale", "rollouts/status"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

## Section 4: Service Account RBAC

### Why Service Account RBAC Matters

Every Kubernetes pod runs with a service account. If that service account has excessive permissions, any vulnerability in the application (RCE, SSRF) can be leveraged to access the Kubernetes API and cause cluster-wide damage.

The most dangerous pattern: running workloads with `cluster-admin`:

```yaml
# NEVER DO THIS
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: app-cluster-admin
roleRef:
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: my-app
  namespace: production
```

### Dedicated Service Accounts per Workload

Create a dedicated service account for each deployment rather than using the `default` service account:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backend-api
  namespace: production
  annotations:
    # Optional: link to IAM role for IRSA (AWS) / Workload Identity (GCP)
    eks.amazonaws.com/role-arn: "arn:aws:iam::123456789012:role/backend-api-role"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: backend-api
  namespace: production
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["backend-api-config"]
  verbs: ["get", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["backend-api-db-credentials"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: backend-api
  namespace: production
roleRef:
  kind: Role
  name: backend-api
subjects:
- kind: ServiceAccount
  name: backend-api
  namespace: production
---
# Reference in the Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: backend-api
      automountServiceAccountToken: false   # Disable if no Kubernetes API access needed
```

### Disabling Token Automounting

By default, Kubernetes mounts a service account token into every pod at `/var/run/secrets/kubernetes.io/serviceaccount/token`. For pods that never call the Kubernetes API, this is an unnecessary attack surface.

```yaml
# Disable at the ServiceAccount level (applies to all pods using this SA)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: static-website
  namespace: production
automountServiceAccountToken: false
---
# Override at the Pod level (takes precedence over SA setting)
spec:
  automountServiceAccountToken: false
```

For pods that DO need API access, use projected service account tokens with bounded lifetimes and audience restrictions:

```yaml
spec:
  volumes:
  - name: kube-api-token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600    # 1 hour (minimum: 600s)
          audience: "kubernetes.default.svc"
  containers:
  - name: app
    volumeMounts:
    - name: kube-api-token
      mountPath: /var/run/secrets/kubernetes.io/serviceaccount
      readOnly: true
```

## Section 5: Audit Policy Configuration

### Why Audit Logs Are Critical

Kubernetes audit logs record every API request: who made it, what they requested, what was returned, and when. Without audit logs, determining the blast radius of a compromised credential or insider threat is impossible.

Audit logs are configured at the kube-apiserver level via an audit policy file.

### Audit Policy Design

The audit policy uses a rule-matching approach: the first matching rule determines the audit level for the request.

Audit levels:
- `None`: Do not log.
- `Metadata`: Log request metadata (user, verb, resource) but not request/response body.
- `Request`: Log metadata and request body.
- `RequestResponse`: Log metadata, request body, and response body.

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
- RequestReceived    # Avoid duplicate entries for two-stage requests

rules:
# DO NOT log read-only access to non-sensitive resources (reduces noise)
- level: None
  users: ["system:kube-proxy"]
  verbs: ["watch"]
  resources:
  - group: ""
    resources: ["endpoints", "services", "services/status"]

# DO NOT log kubelet reads
- level: None
  users: ["kubelet"]
  verbs: ["get"]
  resources:
  - group: ""
    resources: ["nodes", "nodes/status"]

# DO NOT log controller-manager/scheduler reads
- level: None
  userGroups: ["system:nodes"]
  verbs: ["get", "list", "watch"]
  resources:
  - group: ""
    resources: ["secrets", "configmaps"]
  namespaces: ["kube-system"]

# DO NOT log frequent health checks
- level: None
  nonResourceURLs:
  - /healthz
  - /readyz
  - /livez
  - /metrics

# ALWAYS log at RequestResponse for secrets access
- level: RequestResponse
  resources:
  - group: ""
    resources: ["secrets"]
  omitStages: []

# ALWAYS log at RequestResponse for auth-sensitive resources
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources:
    - roles
    - rolebindings
    - clusterroles
    - clusterrolebindings

# Log service account token creation at RequestResponse
- level: RequestResponse
  resources:
  - group: ""
    resources: ["serviceaccounts/token"]

# Log exec, attach, portforward at Request level
- level: Request
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]

# Log all other writes at Request level
- level: Request
  verbs: ["create", "update", "patch", "delete", "deletecollection"]

# Default: log metadata for everything else
- level: Metadata
```

### Enabling Audit Logging on kube-apiserver

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
  - command:
    - kube-apiserver
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxsize=100       # MB per log file
    - --audit-log-maxbackup=10      # Number of rotated files to keep
    - --audit-log-maxage=30         # Days to retain log files
    - --audit-log-compress=true
    # Optional: send to webhook (e.g., for SIEM integration)
    - --audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
    - --audit-webhook-batch-max-size=200
    - --audit-webhook-batch-throttle-qps=10
```

### Shipping Audit Logs to a SIEM

```yaml
# audit-webhook.yaml
apiVersion: v1
kind: Config
clusters:
- name: audit-backend
  cluster:
    server: https://siem.internal.example.com/k8s-audit
    certificate-authority: /etc/kubernetes/ssl/siem-ca.crt
users:
- name: kube-apiserver
  user:
    client-certificate: /etc/kubernetes/ssl/audit-client.crt
    client-key: /etc/kubernetes/ssl/audit-client.key
contexts:
- context:
    cluster: audit-backend
    user: kube-apiserver
  name: webhook
current-context: webhook
```

## Section 6: rbac-tool and kubectl-who-can

### rbac-tool

`rbac-tool` is an open-source CLI for analysing and visualising Kubernetes RBAC configurations:

```bash
# Install
curl -s https://raw.githubusercontent.com/alcideio/rbac-tool/master/download.sh | bash

# Generate a visual HTML report of all RBAC rules
rbac-tool viz --outformat dot | dot -Tsvg > rbac-graph.svg

# Who can access what in a namespace?
rbac-tool who-can get secrets -n production

# What can a specific service account do?
rbac-tool policy-rules \
  --service-account=backend-api \
  --namespace=production

# Find all subjects with access to a sensitive resource
rbac-tool who-can create clusterrolebindings

# Analyse RBAC policy for a specific user
rbac-tool lookup \
  --subject User \
  --subject-name alice@example.com
```

### kubectl-who-can

```bash
# Install
kubectl krew install who-can

# Who can get secrets in the production namespace?
kubectl who-can get secrets -n production

# Who can exec into pods?
kubectl who-can create pods/exec -n production

# Who has cluster-wide escalation privileges?
kubectl who-can escalate clusterroles

# Who can create or update ClusterRoleBindings?
kubectl who-can create clusterrolebindings
kubectl who-can update clusterrolebindings

# Who has impersonation privileges?
kubectl who-can impersonate users
kubectl who-can impersonate serviceaccounts
```

### Detecting Over-Privileged Service Accounts

```bash
# Find all service accounts with cluster-admin
kubectl get clusterrolebindings -o json | jq -r '
  .items[] |
  select(.roleRef.name == "cluster-admin") |
  .subjects[]? |
  select(.kind == "ServiceAccount") |
  "\(.namespace)/\(.name)"'

# Find all RoleBindings granting cluster-admin in any namespace
kubectl get rolebindings --all-namespaces -o json | jq -r '
  .items[] |
  select(.roleRef.name == "cluster-admin") |
  "\(.metadata.namespace)/\(.metadata.name) -> \(.subjects[]?.kind)/\(.subjects[]?.name)"'
```

## Section 7: Common Misconfigurations

### Wildcard Verbs on All Resources

```bash
# Detect ClusterRoles with wildcard verbs
kubectl get clusterroles -o json | jq -r '
  .items[] |
  select(.metadata.name | startswith("system:") | not) |
  select(
    .rules[]? |
    (.verbs[]? == "*") and
    (.resources[]? == "*")
  ) |
  .metadata.name'
```

### Wildcard API Groups

A wildcard on `apiGroups` grants access to all API group resources, including CRDs that may not have been considered when the rule was written:

```yaml
# DANGEROUS: grants access to all CRDs and future API groups
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["get", "list"]
```

Detection:

```bash
kubectl get clusterroles,roles --all-namespaces -o json | jq -r '
  .items[] |
  select(.rules[]?.apiGroups[]? == "*") |
  "\(.kind)/\(.metadata.namespace)/\(.metadata.name)"'
```

### Bind and Escalate Verbs

The `bind` verb allows a user to create RoleBindings/ClusterRoleBindings to any role, even roles with more permissions than the user currently has. The `escalate` verb allows modifying a Role to add permissions the modifier does not have. These verbs effectively grant privilege escalation:

```bash
# Find who has bind or escalate
kubectl who-can bind clusterroles
kubectl who-can escalate clusterroles
kubectl who-can bind roles --all-namespaces
kubectl who-can escalate roles --all-namespaces
```

### Impersonation

The `impersonate` verb on `users`, `groups`, or `serviceaccounts` allows the holder to act as any user in the cluster, bypassing all RBAC checks for the impersonated principal. This is extremely sensitive:

```bash
# Find who can impersonate
kubectl who-can impersonate users
kubectl who-can impersonate groups
kubectl who-can impersonate serviceaccounts
```

Legitimate uses: aggregated API servers, testing tools (kubectl --as=). Revoke if unexpected.

### Secrets Access Without Restriction

Any service account that can `list` secrets in a namespace can read all secrets, including tokens, TLS certificates, and database passwords:

```bash
# Find all roles/clusterroles with secrets get/list without resourceNames
kubectl get roles,clusterroles --all-namespaces -o json | jq -r '
  .items[] |
  select(.rules[]? |
    (.resources[]? == "secrets") and
    (.verbs[]? | . == "get" or . == "list") and
    (.resourceNames == null or .resourceNames == [])
  ) |
  "\(.kind)/\(.metadata.namespace)/\(.metadata.name)"'
```

### pods/exec Access

`pods/exec` grants interactive shell access inside any pod matching the role's scope. This is equivalent to SSH into the application container:

```bash
# Find who can exec into pods in production
kubectl who-can create pods/exec -n production
```

Restrict exec access to break-glass service accounts only.

## Section 8: Advanced RBAC Patterns

### Break-Glass Emergency Access

Create a tightly controlled emergency access mechanism with full audit logging:

```yaml
# Emergency access ClusterRole
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: emergency-admin
  labels:
    access-type: break-glass
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
---
# No permanent binding — create and delete as needed
# Script to grant/revoke:
# kubectl create clusterrolebinding emergency-access-$(date +%s) \
#   --clusterrole=emergency-admin \
#   --user=alice@example.com \
#   --dry-run=server
```

Automate time-limited access via a controller that watches for emergency bindings and deletes them after a TTL.

### OIDC Group-Based RBAC

For teams using an OIDC provider (Okta, Azure AD, Google), map groups directly to ClusterRoles:

```yaml
# Bind the 'platform-engineers' OIDC group to cluster admin in platform namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: platform-engineers-admin
  namespace: platform
roleRef:
  kind: ClusterRole
  name: admin
subjects:
- kind: Group
  name: "platform-engineers"
  apiGroup: rbac.authorization.k8s.io
---
# Bind 'developers' group to namespace view in all app namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: developers-view
roleRef:
  kind: ClusterRole
  name: view
subjects:
- kind: Group
  name: "developers"
  apiGroup: rbac.authorization.k8s.io
```

### Namespace-Scoped Operator Service Accounts

When deploying operators that manage resources across a namespace:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-operator
  namespace: production
rules:
# The operator manages Deployments and Services in its namespace
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: [""]
  resources: ["services", "configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
# The operator watches its own CRD
- apiGroups: ["myapp.example.com"]
  resources: ["myresources", "myresources/status", "myresources/finalizers"]
  verbs: ["get", "list", "watch", "update", "patch"]
# The operator needs to create events for status reporting
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
```

## Section 9: Monitoring and Alerting for RBAC Events

### Prometheus Rules for RBAC Changes

```yaml
groups:
- name: rbac.rules
  rules:
  - alert: ClusterAdminBindingCreated
    expr: |
      increase(
        apiserver_audit_event_total{
          verb="create",
          objectRef_resource="clusterrolebindings",
          responseStatus_code=~"2.."
        }[5m]
      ) > 0
    labels:
      severity: critical
    annotations:
      summary: "A ClusterRoleBinding was created — verify it is authorised"

  - alert: SecretsAccessFromUnknownSA
    expr: |
      increase(
        apiserver_audit_event_total{
          verb=~"get|list",
          objectRef_resource="secrets",
          user_username!~"system:.*|.*@example.com"
        }[5m]
      ) > 0
    labels:
      severity: warning
    annotations:
      summary: "Unexpected principal accessing secrets: {{ $labels.user_username }}"
```

### Falco Rules for Runtime RBAC Violations

```yaml
# Falco rule: detect pod exec by unexpected users
- rule: Unexpected K8s User in Pod Exec
  desc: Detects kubectl exec by users not in the approved list
  condition: >
    ka.verb = create and
    ka.target.resource = pods/exec and
    not ka.user.name in (allowed_exec_users)
  output: >
    Unexpected kubectl exec:
    user=%ka.user.name pod=%ka.target.name
    namespace=%ka.target.namespace
  priority: WARNING
  source: k8s_audit

# Falco rule: detect new ClusterRoleBinding creation
- rule: ClusterRoleBinding Created
  desc: Alerts when a new ClusterRoleBinding is created
  condition: >
    ka.verb = create and
    ka.target.resource = clusterrolebindings
  output: >
    New ClusterRoleBinding created:
    user=%ka.user.name binding=%ka.target.name
  priority: NOTICE
  source: k8s_audit
```

## Section 10: Production Hardening Checklist

```
Kubernetes RBAC Production Hardening Checklist
================================================

Model and Scope
[ ] No ClusterRoleBindings to cluster-admin except for break-glass accounts
[ ] No wildcard verbs (*) in custom Roles or ClusterRoles
[ ] No wildcard apiGroups (*) in custom Roles or ClusterRoles
[ ] No wildcard resources (*) without justification and documentation
[ ] All custom Roles/ClusterRoles have owner annotations

Service Accounts
[ ] Dedicated ServiceAccount per workload (not default SA)
[ ] automountServiceAccountToken: false on all ServiceAccounts that don't call k8s API
[ ] Projected tokens with bounded expiry where API access is needed
[ ] No ServiceAccounts with cluster-admin or cluster-wide write access
[ ] IRSA/Workload Identity used instead of node-level IAM where possible

Sensitive Verbs
[ ] Review all grants of: bind, escalate, impersonate
[ ] pods/exec restricted to break-glass service accounts
[ ] pods/attach restricted similarly to exec
[ ] secrets list/get restricted to specific resourceNames where possible
[ ] No ServiceAccount with create/update on ClusterRoleBindings

Audit Logging
[ ] Audit policy configured with RequestResponse for secrets
[ ] Audit policy configured with RequestResponse for RBAC resources
[ ] Audit log rotation and retention configured
[ ] Audit logs shipped to immutable SIEM or object storage
[ ] Audit log alerts for ClusterRoleBinding creation, secret access

Tooling
[ ] rbac-tool or kubectl-who-can run quarterly for over-privilege review
[ ] CI/CD pipeline validates RBAC changes with conftest/OPA Gatekeeper
[ ] kubectl auth can-i tests in CI for regression detection
[ ] Automated detection of default service account usage

Aggregated ClusterRoles
[ ] CRD owners add aggregate-to-view/edit/admin labels for CRDs
[ ] Aggregated ClusterRoles reviewed when new CRDs are installed
[ ] Least-privilege review of built-in edit/admin ClusterRoles

Documentation
[ ] Every ClusterRoleBinding has a documented justification
[ ] Break-glass procedure documented and tested
[ ] Quarterly RBAC access review process documented
[ ] RBAC changes require two-person review in PRs
```

## Summary

Kubernetes RBAC is simple to misconfigure and dangerous when misconfigured. The patterns that appear most frequently in compromised clusters — wildcard verbs, cluster-admin for service accounts, unrestricted secrets access, disabled audit logging — are all avoidable with the discipline to apply least privilege consistently.

The most effective operational habit is treating RBAC changes as security changes: every new Role, RoleBinding, ClusterRole, and ClusterRoleBinding should go through the same review process as a firewall rule change. Tools like rbac-tool and kubectl-who-can make it practical to answer "who can do X?" before an incident rather than after one.

Audit logging is the non-negotiable foundation: without a complete audit trail, post-incident analysis is guesswork. A well-designed audit policy captures the sensitive operations (secret access, exec, RBAC mutations) at full detail while suppressing the high-volume noise (health check reads, kubelet routine watches) that makes audit logs unusable in practice.

The hardening checklist in this guide provides a structured approach to auditing an existing cluster's RBAC posture and closing the gaps before they are exploited.
