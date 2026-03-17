---
title: "Kubernetes RBAC Deep Dive: Roles, ClusterRoles, and Least-Privilege Design Patterns"
date: 2030-07-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RBAC", "Security", "DevOps", "Access Control", "Audit Logging"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise Kubernetes RBAC guide covering role aggregation, impersonation, audit logging, RBAC linting tools, automated RBAC testing, and least-privilege design for CI/CD service accounts and operators."
more_link: "yes"
url: "/kubernetes-rbac-deep-dive-roles-clusterroles-least-privilege-design-patterns/"
---

Kubernetes Role-Based Access Control (RBAC) is the primary mechanism for governing what every principal — human, service account, or automated system — can do inside a cluster. Despite being foundational, RBAC is routinely misconfigured in production: overly broad ClusterRoles proliferate, service accounts accumulate wildcard permissions, and audit trails remain untapped. This post delivers a production-grade reference for designing, testing, and operating RBAC policies at enterprise scale.

<!--more-->

## Understanding the RBAC Data Model

Kubernetes RBAC consists of four object types that compose into a complete authorization model.

### Roles and ClusterRoles

A `Role` grants permissions within a single namespace. A `ClusterRole` grants permissions cluster-wide or can be bound into a namespace via a `RoleBinding`. Both objects define `rules` — lists of `apiGroups`, `resources`, and `verbs`.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
```

A `ClusterRole` with the same rules applies across all namespaces:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: pod-reader
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
```

### RoleBindings and ClusterRoleBindings

A `RoleBinding` connects a subject (User, Group, ServiceAccount) to a Role or ClusterRole within a namespace. A `ClusterRoleBinding` connects a subject to a ClusterRole cluster-wide.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: production
subjects:
  - kind: ServiceAccount
    name: monitoring-agent
    namespace: monitoring
roleRef:
  kind: ClusterRole
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

This pattern — binding a `ClusterRole` via a `RoleBinding` — is extremely powerful. It allows reusable role definitions while scoping permissions to a specific namespace.

### The Resource Hierarchy

Every Kubernetes API resource maps to a path in the API server. RBAC rules must match this hierarchy precisely:

```
/apis/{apiGroup}/{version}/namespaces/{namespace}/{resource}/{name}/{subresource}
```

Common API groups and their resources:

| API Group | Resources |
|-----------|-----------|
| `""` (core) | pods, services, configmaps, secrets, persistentvolumeclaims |
| `apps` | deployments, replicasets, statefulsets, daemonsets |
| `batch` | jobs, cronjobs |
| `rbac.authorization.k8s.io` | roles, rolebindings, clusterroles, clusterrolebindings |
| `networking.k8s.io` | ingresses, networkpolicies |
| `policy` | poddisruptionbudgets |

## Role Aggregation

ClusterRoles support aggregation labels, allowing composite roles to be built from smaller, purpose-specific roles. This is how the built-in `view`, `edit`, and `admin` roles are constructed.

### Defining Aggregated ClusterRoles

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-developer
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.platform.io/aggregate-to-developer: "true"
rules: []  # Populated automatically from matching ClusterRoles
```

Any ClusterRole with the label `rbac.platform.io/aggregate-to-developer: "true"` contributes its rules to `platform-developer`:

```yaml
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer-pods
  labels:
    rbac.platform.io/aggregate-to-developer: "true"
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec"]
    verbs: ["get", "list", "watch", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer-deployments
  labels:
    rbac.platform.io/aggregate-to-developer: "true"
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer-configmaps
  labels:
    rbac.platform.io/aggregate-to-developer: "true"
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

This approach allows teams to add permissions incrementally without editing the aggregating ClusterRole directly — a critical property for GitOps workflows.

### Extending Built-in Aggregated Roles

The built-in `view`, `edit`, and `admin` ClusterRoles use their own aggregation labels. Custom resources can extend these roles:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-crds-view
  labels:
    rbac.authorization.k8s.io/aggregate-to-view: "true"
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
    rbac.authorization.k8s.io/aggregate-to-admin: "true"
rules:
  - apiGroups: ["platform.io"]
    resources: ["applications", "environments"]
    verbs: ["get", "list", "watch"]
```

## Impersonation

Impersonation allows a subject to act as another user, group, or service account. It is required for tools like `kubectl --as` and is the mechanism underlying Kubernetes' support for authorization delegates.

### Granting Impersonation Permissions

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: developer-impersonation
rules:
  - apiGroups: [""]
    resources: ["users"]
    verbs: ["impersonate"]
    resourceNames: ["developer@example.com"]
  - apiGroups: [""]
    resources: ["groups"]
    verbs: ["impersonate"]
    resourceNames: ["system:developers"]
  - apiGroups: ["authentication.k8s.io"]
    resources: ["userextras/scopes"]
    verbs: ["impersonate"]
```

Impersonation should be granted sparingly and always scoped to specific `resourceNames`. Wildcarding impersonation targets is equivalent to full cluster admin for the impersonated principals.

### Testing Impersonation

```bash
# Check what a specific user can do
kubectl auth can-i --list --as=developer@example.com

# Check a specific permission
kubectl auth can-i get pods --as=developer@example.com -n production

# Impersonate a service account
kubectl auth can-i get secrets \
  --as=system:serviceaccount:monitoring:prometheus-agent \
  -n monitoring

# Impersonate with group membership
kubectl auth can-i create deployments \
  --as=developer@example.com \
  --as-group=system:developers \
  -n production
```

## Audit Logging for RBAC Decisions

Kubernetes API server audit logging captures the full lifecycle of every request, including RBAC authorization decisions. Effective audit configuration is essential for security compliance and incident investigation.

### Audit Policy Configuration

```yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Log all authentication and authorization failures at RequestResponse level
  - level: RequestResponse
    omitStages: ["RequestReceived"]
    users: []
    userGroups: []
    verbs: ["create", "update", "patch", "delete"]
    resources:
      - group: "rbac.authorization.k8s.io"
        resources:
          - "roles"
          - "rolebindings"
          - "clusterroles"
          - "clusterrolebindings"

  # Log secret access at Metadata level (no data in logs)
  - level: Metadata
    omitStages: ["RequestReceived"]
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
    verbs: ["get", "list", "watch"]

  # Log service account token creation
  - level: Request
    omitStages: ["RequestReceived"]
    resources:
      - group: ""
        resources: ["serviceaccounts/token"]
    verbs: ["create"]

  # Log exec and port-forward at RequestResponse
  - level: RequestResponse
    omitStages: ["RequestReceived"]
    resources:
      - group: ""
        resources: ["pods/exec", "pods/portforward", "pods/attach"]

  # Log all other requests at Metadata
  - level: Metadata
    omitStages: ["RequestReceived"]
```

### Parsing RBAC Audit Events

Audit log events are JSON objects. Key fields for RBAC analysis:

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "level": "RequestResponse",
  "auditID": "a3bcd123-...",
  "stage": "ResponseComplete",
  "requestURI": "/apis/apps/v1/namespaces/production/deployments",
  "verb": "create",
  "user": {
    "username": "developer@example.com",
    "groups": ["system:developers", "system:authenticated"]
  },
  "impersonatedUser": null,
  "sourceIPs": ["10.0.1.50"],
  "responseStatus": {
    "code": 201
  },
  "requestReceivedTimestamp": "2030-07-23T12:00:00.000000Z",
  "stageTimestamp": "2030-07-23T12:00:00.015000Z"
}
```

Querying audit logs with `jq` for RBAC-relevant events:

```bash
# Find all RBAC object mutations
cat /var/log/kubernetes/audit.log | \
  jq 'select(.objectRef.apiGroup == "rbac.authorization.k8s.io") |
      {time: .requestReceivedTimestamp, user: .user.username,
       verb: .verb, resource: .objectRef.resource, name: .objectRef.name}'

# Find all unauthorized (403) responses
cat /var/log/kubernetes/audit.log | \
  jq 'select(.responseStatus.code == 403) |
      {user: .user.username, verb: .verb,
       uri: .requestURI, time: .requestReceivedTimestamp}'

# Find service account token requests
cat /var/log/kubernetes/audit.log | \
  jq 'select(.objectRef.subresource == "token" and .verb == "create") |
      {user: .user.username, serviceAccount: .objectRef.name,
       namespace: .objectRef.namespace}'
```

### Shipping Audit Logs to SIEM

For production environments, audit logs should be forwarded to a SIEM. A Fluent Bit configuration for forwarding to Elasticsearch:

```ini
[INPUT]
    Name              tail
    Path              /var/log/kubernetes/audit.log
    Parser            json
    Tag               kube.audit
    Refresh_Interval  5
    Mem_Buf_Limit     50MB

[FILTER]
    Name              grep
    Match             kube.audit
    Regex             level (Request|RequestResponse)

[OUTPUT]
    Name              es
    Match             kube.audit
    Host              elasticsearch.logging.svc.cluster.local
    Port              9200
    Index             kube-audit
    Type              _doc
    Logstash_Format   On
    Logstash_Prefix   kube-audit
    Time_Key          requestReceivedTimestamp
```

## RBAC Linting Tools

Several tools exist to analyze RBAC configurations for security issues before they reach production.

### rbac-tool

`rbac-tool` is a kubectl plugin for visualizing and auditing RBAC:

```bash
# Install
kubectl krew install rbac-tool

# Show who can do what
kubectl rbac-tool who-can create deployments -n production

# Show what a principal can do
kubectl rbac-tool policy-rules -e developer@example.com

# Visualize RBAC graph
kubectl rbac-tool viz --outformat dot | dot -Tsvg > rbac.svg

# Find subjects with cluster-admin
kubectl rbac-tool who-can '*' '*' --cluster-wide
```

### KubiScan

KubiScan scans for risky RBAC permissions:

```bash
# Run KubiScan in a pod
kubectl run kubiscan \
  --image=cyberark/kubiscan:latest \
  --restart=Never \
  --rm -it \
  -- python3 kubiscan.py -rr

# Check for risky roles
kubectl run kubiscan \
  --image=cyberark/kubiscan:latest \
  --restart=Never \
  --rm -it \
  -- python3 kubiscan.py -rs
```

### rakkess (Access Matrix)

`rakkess` displays an access matrix for a given principal:

```bash
# Install via krew
kubectl krew install access-matrix

# Show all permissions for current user
kubectl access-matrix

# Show permissions for a service account
kubectl access-matrix --sa monitoring:prometheus-agent

# Show permissions for a specific namespace
kubectl access-matrix -n production
```

### Conftest with OPA Policies

Conftest can enforce RBAC policy as code during CI/CD:

```rego
# policy/rbac.rego
package main

deny[msg] {
  input.kind == "ClusterRole"
  rule := input.rules[_]
  rule.verbs[_] == "*"
  msg := sprintf("ClusterRole %s contains wildcard verb - use explicit verbs", [input.metadata.name])
}

deny[msg] {
  input.kind == "ClusterRole"
  rule := input.rules[_]
  rule.resources[_] == "*"
  not input.metadata.name == "cluster-admin"
  msg := sprintf("ClusterRole %s contains wildcard resource - use explicit resources", [input.metadata.name])
}

deny[msg] {
  input.kind == "ClusterRoleBinding"
  subject := input.subjects[_]
  subject.kind == "Group"
  subject.name == "system:unauthenticated"
  msg := "ClusterRoleBinding grants permissions to unauthenticated users"
}

deny[msg] {
  input.kind == "ClusterRoleBinding"
  input.roleRef.name == "cluster-admin"
  subject := input.subjects[_]
  not subject.name == "system:masters"
  msg := sprintf("Subject %s has cluster-admin via ClusterRoleBinding - use scoped ClusterRoles", [subject.name])
}

warn[msg] {
  input.kind == "Role"
  rule := input.rules[_]
  rule.resources[_] == "secrets"
  rule.verbs[_] == "list"
  msg := sprintf("Role %s can list secrets - consider restricting to get with resourceNames", [input.metadata.name])
}
```

Running policy checks in CI:

```bash
# Validate all RBAC manifests
conftest test rbac/ --policy policy/rbac.rego

# Output in JUnit format for CI
conftest test rbac/ \
  --policy policy/rbac.rego \
  --output junit \
  > rbac-policy-results.xml
```

## Automated RBAC Testing

Beyond static analysis, runtime testing validates that RBAC behaves as designed.

### kube-rbac-proxy Sidecar Testing

For admission webhook and operator development, test RBAC with a dedicated test suite:

```go
// rbac_test.go
package rbac_test

import (
    "context"
    "testing"

    authorizationv1 "k8s.io/api/authorization/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"
)

type RBACTestCase struct {
    Name          string
    User          string
    Group         string
    ServiceAccount string
    Namespace     string
    Verb          string
    Resource      string
    APIGroup      string
    ResourceName  string
    ExpectAllowed bool
}

func TestRBACPolicies(t *testing.T) {
    config, err := clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
    if err != nil {
        t.Fatalf("failed to build config: %v", err)
    }

    client, err := kubernetes.NewForConfig(config)
    if err != nil {
        t.Fatalf("failed to create client: %v", err)
    }

    cases := []RBACTestCase{
        {
            Name:          "developer can read pods in production",
            User:          "developer@example.com",
            Group:         "system:developers",
            Namespace:     "production",
            Verb:          "get",
            Resource:      "pods",
            APIGroup:      "",
            ExpectAllowed: true,
        },
        {
            Name:          "developer cannot delete production namespace",
            User:          "developer@example.com",
            Namespace:     "",
            Verb:          "delete",
            Resource:      "namespaces",
            APIGroup:      "",
            ResourceName:  "production",
            ExpectAllowed: false,
        },
        {
            Name:           "CI service account can update deployments in staging",
            ServiceAccount: "ci-deployer",
            Namespace:      "staging",
            Verb:           "update",
            Resource:       "deployments",
            APIGroup:       "apps",
            ExpectAllowed:  true,
        },
        {
            Name:           "CI service account cannot access secrets in production",
            ServiceAccount: "ci-deployer",
            Namespace:      "production",
            Verb:           "get",
            Resource:       "secrets",
            APIGroup:       "",
            ExpectAllowed:  false,
        },
    }

    for _, tc := range cases {
        t.Run(tc.Name, func(t *testing.T) {
            sar := buildSubjectAccessReview(tc)
            result, err := client.AuthorizationV1().
                SubjectAccessReviews().
                Create(context.Background(), sar, metav1.CreateOptions{})
            if err != nil {
                t.Fatalf("SubjectAccessReview failed: %v", err)
            }
            if result.Status.Allowed != tc.ExpectAllowed {
                t.Errorf("expected allowed=%v got allowed=%v reason=%q",
                    tc.ExpectAllowed, result.Status.Allowed, result.Status.Reason)
            }
        })
    }
}

func buildSubjectAccessReview(tc RBACTestCase) *authorizationv1.SubjectAccessReview {
    sar := &authorizationv1.SubjectAccessReview{
        Spec: authorizationv1.SubjectAccessReviewSpec{
            ResourceAttributes: &authorizationv1.ResourceAttributes{
                Namespace: tc.Namespace,
                Verb:      tc.Verb,
                Group:     tc.APIGroup,
                Resource:  tc.Resource,
                Name:      tc.ResourceName,
            },
        },
    }
    if tc.ServiceAccount != "" {
        ns := tc.Namespace
        if ns == "" {
            ns = "default"
        }
        sar.Spec.User = "system:serviceaccount:" + ns + ":" + tc.ServiceAccount
    } else {
        sar.Spec.User = tc.User
        if tc.Group != "" {
            sar.Spec.Groups = []string{tc.Group}
        }
    }
    return sar
}
```

### RBAC CI/CD Pipeline Integration

```yaml
# .github/workflows/rbac-validation.yaml
name: RBAC Validation

on:
  pull_request:
    paths:
      - 'manifests/rbac/**'
      - 'helm/*/templates/rbac/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install conftest
        run: |
          curl -Lo conftest.tar.gz \
            https://github.com/open-policy-agent/conftest/releases/latest/download/conftest_Linux_x86_64.tar.gz
          tar -xzf conftest.tar.gz
          sudo mv conftest /usr/local/bin/

      - name: Validate RBAC manifests with OPA
        run: |
          conftest test manifests/rbac/ \
            --policy policy/rbac.rego \
            --output json \
            | tee rbac-results.json
          # Fail if any deny rules triggered
          jq -e '.[] | select(.failures | length > 0) | halt_error(1)' rbac-results.json

      - name: Upload results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: rbac-policy-results
          path: rbac-results.json

  runtime-test:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - uses: actions/checkout@v4

      - name: Create kind cluster
        run: |
          kind create cluster --name rbac-test \
            --config kind-config.yaml

      - name: Apply RBAC manifests
        run: |
          kubectl apply -f manifests/rbac/

      - name: Run RBAC tests
        run: |
          go test ./rbac_test/ -v -timeout 5m
```

## Least-Privilege Design for CI/CD Service Accounts

CI/CD pipelines are a primary attack surface. Each pipeline stage should run with a dedicated service account scoped to the minimum permissions required.

### Deployment Pipeline Service Account

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: cicd
  annotations:
    description: "Service account for CI/CD deployment pipelines"
---
# Allow the CI deployer to manage deployments in specific namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
  namespace: staging
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "watch"]
  # Allow rollout status checks
  - apiGroups: ["apps"]
    resources: ["replicasets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-deployer-staging
  namespace: staging
subjects:
  - kind: ServiceAccount
    name: ci-deployer
    namespace: cicd
roleRef:
  kind: Role
  name: deployer
  apiGroup: rbac.authorization.k8s.io
```

### Image Pull Verification Service Account

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: image-scanner
  namespace: cicd
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: image-scanner
rules:
  # Read pods to find running images
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  # Read pod specs for image references
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "statefulsets"]
    verbs: ["get", "list", "watch"]
  # Create policy reports
  - apiGroups: ["wgpolicyk8s.io"]
    resources: ["clusterpolicyreports", "policyreports"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: image-scanner
subjects:
  - kind: ServiceAccount
    name: image-scanner
    namespace: cicd
roleRef:
  kind: ClusterRole
  name: image-scanner
  apiGroup: rbac.authorization.k8s.io
```

### Operator Service Account Pattern

Kubernetes operators often request overly broad permissions. The correct pattern restricts permissions to only the resources the operator manages:

```yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: myapp-operator
  namespace: myapp-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: myapp-operator
rules:
  # Manage the operator's own CRDs
  - apiGroups: ["myapp.io"]
    resources: ["myapps", "myapps/status", "myapps/finalizers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Create and manage owned resources
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["services", "configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Watch namespaces for multi-tenant operators
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list", "watch"]

  # Manage events for status reporting
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]

  # Finalizer management
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: myapp-operator
subjects:
  - kind: ServiceAccount
    name: myapp-operator
    namespace: myapp-system
roleRef:
  kind: ClusterRole
  name: myapp-operator
  apiGroup: rbac.authorization.k8s.io
```

## Namespace-Scoped RBAC for Multi-Tenant Clusters

In multi-tenant clusters, namespace isolation through RBAC is critical. Each tenant team should receive bounded permissions within their namespace(s) only.

### Tenant Admin Role Pattern

```yaml
---
# Tenant-scoped admin role (applied per namespace via RoleBinding)
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: tenant-admin
  labels:
    rbac.platform.io/role-type: tenant
rules:
  - apiGroups: ["", "apps", "batch", "autoscaling", "networking.k8s.io", "policy"]
    resources:
      - pods
      - pods/log
      - pods/exec
      - services
      - endpoints
      - configmaps
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
      - jobs
      - cronjobs
      - horizontalpodautoscalers
      - ingresses
      - networkpolicies
      - poddisruptionbudgets
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Allow reading secrets but not listing (prevents bulk exfiltration)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "watch", "create", "update", "patch", "delete"]

  # Read-only PVC management
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "delete"]

  # Cannot manage RBAC within the namespace
  # (Managed by platform team via GitOps)
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-admin
  namespace: team-alpha
subjects:
  - kind: Group
    name: platform:team-alpha:admins
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: tenant-admin
  apiGroup: rbac.authorization.k8s.io
```

## Troubleshooting RBAC Denials

When a request is denied, the API server returns a 403 with a reason message. Diagnosing the root cause requires understanding which bindings were evaluated.

### Using kubectl auth can-i

```bash
# Check a permission for the current user
kubectl auth can-i create deployments -n production

# Check with verbose output (shows RBAC evaluation)
kubectl auth can-i create deployments -n production -v=8

# List all permissions for current user in a namespace
kubectl auth can-i --list -n production

# Check for a service account
kubectl auth can-i get secrets \
  --as=system:serviceaccount:monitoring:prometheus \
  -n monitoring
```

### Tracing RBAC Decisions in Logs

API server RBAC decisions appear in the audit log with the evaluationError field when a request is denied:

```bash
# Watch for RBAC-denied requests in real time
kubectl logs -n kube-system \
  $(kubectl get pods -n kube-system -l component=kube-apiserver -o name | head -1) \
  | grep -i "rbac\|forbidden\|denied"
```

### Common RBAC Misconfigurations

1. **Missing subresource permissions**: `pods/exec` and `pods/log` are subresources and require separate rules from `pods`.
2. **Namespace mismatch in RoleBinding subjects**: The `namespace` field in a RoleBinding subject must exactly match the ServiceAccount's namespace.
3. **ClusterRoleBinding for namespace-scoped intent**: Using `ClusterRoleBinding` when `RoleBinding` was intended grants cluster-wide access.
4. **Missing `watch` verb**: Controllers that use informers need `list` and `watch`, not just `get`.
5. **Forgetting status subresources**: Operators updating status must include `resources: ["myresources/status"]` with `update` or `patch` verbs.

## Summary

Enterprise Kubernetes RBAC requires disciplined design across multiple dimensions: role aggregation for composability, impersonation controls for tooling, audit logging for compliance, and automated testing to prevent regressions. The least-privilege principle should be applied consistently to every principal — human operators, CI/CD pipelines, and Kubernetes operators alike. By combining static policy analysis with runtime SubjectAccessReview testing in CI/CD pipelines, teams can maintain robust access controls as clusters evolve at scale.
