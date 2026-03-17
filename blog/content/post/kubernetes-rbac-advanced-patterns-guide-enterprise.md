---
title: "Kubernetes RBAC Advanced Patterns: Aggregated ClusterRoles, Impersonation, Audit Logging, and Least Privilege Design"
date: 2028-08-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RBAC", "Security", "Audit Logging", "Least Privilege"]
categories:
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into advanced Kubernetes RBAC patterns covering aggregated ClusterRoles, user impersonation, audit policy configuration, least privilege design principles, RBAC testing, and automated compliance verification for enterprise environments."
more_link: "yes"
url: "/kubernetes-rbac-advanced-patterns-guide-enterprise/"
---

Kubernetes RBAC is deceptively simple on the surface — Roles, ClusterRoles, Bindings — but real enterprise environments reveal a far more complex problem space. You need RBAC that is maintainable as teams grow, auditable for compliance, testable to catch privilege escalation, and capable of expressing least-privilege for dozens of controller service accounts without becoming an unmaintainable pile of hand-crafted bindings.

This guide covers the advanced patterns that experienced platform engineers use: aggregated ClusterRoles for composable permissions, impersonation for debugging and multi-tenancy, audit policy tuning to capture what you actually need, and systematic approaches to least-privilege design.

<!--more-->

# Kubernetes RBAC Advanced Patterns: Aggregated ClusterRoles, Impersonation, Audit Logging, and Least Privilege Design

## Section 1: RBAC Model Foundations

Before diving into advanced patterns, the exact semantics matter.

**Additive only**: RBAC is purely additive. There are no deny rules. If any binding grants a permission, the subject has it.

**Namespace scope vs cluster scope**:
- `Role` + `RoleBinding`: scoped to a single namespace
- `ClusterRole` + `ClusterRoleBinding`: cluster-wide
- `ClusterRole` + `RoleBinding`: applies the ClusterRole permissions within a specific namespace only (useful for reusable role definitions)

**Subjects**: `User`, `Group`, or `ServiceAccount`. Users and Groups are asserted by the authentication layer (certificates, OIDC, webhook); they are not Kubernetes objects.

```bash
# Verify what permissions a subject has
kubectl auth can-i --list --as=system:serviceaccount:production:api-server

# Check a specific permission
kubectl auth can-i get pods --as=system:serviceaccount:monitoring:prometheus -n production

# Check as a group member
kubectl auth can-i create deployments --as=developer@company.com --as-group=system:masters

# Verbose: which rules grant a permission
kubectl auth can-i get secrets -n kube-system \
  --as=system:serviceaccount:velero:velero \
  --v=6 2>&1 | grep "RBAC ALLOW"
```

## Section 2: Aggregated ClusterRoles

Aggregated ClusterRoles allow you to compose permissions from multiple sources. The aggregation controller watches for ClusterRoles with matching labels and merges their rules into the aggregating ClusterRole automatically.

This is the mechanism behind the built-in `admin`, `edit`, and `view` ClusterRoles — they aggregate from labeled ClusterRoles, so CRD controllers can extend them just by creating a properly labeled ClusterRole.

### The Aggregation Pattern

```yaml
# aggregating-clusterrole.yaml
# This ClusterRole is empty initially; its rules are populated
# by aggregating all ClusterRoles with the matching label selector.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-engineer
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.support.tools/platform-engineer: "true"
rules: [] # Managed by aggregation controller; do not edit manually
```

```yaml
# base-kubernetes-ops.yaml
# Grants core Kubernetes operational permissions
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-engineer-base
  labels:
    rbac.support.tools/platform-engineer: "true"
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec", "pods/portforward"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: [""]
    resources: ["services", "endpoints", "configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["namespaces", "nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

```yaml
# ingress-permissions.yaml
# Grants Ingress/Gateway API permissions, aggregated into platform-engineer
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-engineer-ingress
  labels:
    rbac.support.tools/platform-engineer: "true"
rules:
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses", "networkpolicies"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "httproutes", "tcproutes", "tlsroutes", "referencegrants"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

```yaml
# monitoring-permissions.yaml
# Added by the monitoring team; automatically extends platform-engineer
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-engineer-monitoring
  labels:
    rbac.support.tools/platform-engineer: "true"
rules:
  - apiGroups: ["monitoring.coreos.com"]
    resources: ["prometheusrules", "servicemonitors", "podmonitors", "probes"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["grafana.integreatly.org"]
    resources: ["grafanadashboards", "grafanadatasources"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

### Extending Built-in Roles for CRDs

When you install a CRD, users with `admin` or `edit` ClusterRoles cannot access the new resources by default. The aggregation pattern fixes this:

```yaml
# extend-admin-for-crd.yaml
# This ClusterRole automatically gets merged into the built-in 'admin' role
# because it has the required label.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: myapp-crd-admin
  labels:
    rbac.authorization.k8s.io/aggregate-to-admin: "true"
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
rules:
  - apiGroups: ["myapp.example.com"]
    resources: ["myresources", "myresources/status", "myresources/finalizers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
# Read-only variant for 'view' role
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: myapp-crd-view
  labels:
    rbac.authorization.k8s.io/aggregate-to-view: "true"
rules:
  - apiGroups: ["myapp.example.com"]
    resources: ["myresources"]
    verbs: ["get", "list", "watch"]
```

### Verifying Aggregation

```bash
# Verify the aggregated ClusterRole has accumulated the expected rules
kubectl get clusterrole platform-engineer -o json | jq '.rules | length'

# See all contributing ClusterRoles
kubectl get clusterroles -l rbac.support.tools/platform-engineer=true

# Check that built-in admin now includes CRD permissions
kubectl get clusterrole admin -o json | jq '.rules[] | select(.apiGroups[] == "myapp.example.com")'
```

## Section 3: Impersonation

Kubernetes RBAC includes an impersonation mechanism that allows a subject (user, service account) to act as a different user, group, or service account. This has two major use cases:

1. **Debugging**: A platform engineer can impersonate a developer's service account to reproduce permission errors.
2. **Multi-tenancy / proxy pattern**: A trusted proxy service account impersonates the calling user, enabling per-request RBAC enforcement in API gateway patterns.

### Granting Impersonation Permissions

```yaml
# impersonation-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: platform-engineer-impersonation
rules:
  # Allow impersonating any user (tighten with resourceNames in production)
  - apiGroups: [""]
    resources: ["users"]
    verbs: ["impersonate"]

  # Allow impersonating specific groups
  - apiGroups: [""]
    resources: ["groups"]
    verbs: ["impersonate"]
    resourceNames:
      - "developers"
      - "qa-engineers"
      - "data-scientists"

  # Allow impersonating service accounts in specific namespaces
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["impersonate"]
    resourceNames:
      - "system:serviceaccount:production:*"  # wildcard not supported; use per-SA grants

  # Required: allow setting impersonation-related extra headers
  - apiGroups: ["authentication.k8s.io"]
    resources: ["userextras/scopes", "userextras/remote-principals"]
    verbs: ["impersonate"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: platform-engineer-impersonation
subjects:
  - kind: Group
    name: platform-engineers
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: platform-engineer-impersonation
  apiGroup: rbac.authorization.k8s.io
```

### Using Impersonation

```bash
# Debug as another user
kubectl get pods -n production \
  --as=developer@company.com \
  --as-group=team-backend

# Debug as a service account
kubectl auth can-i --list \
  --as=system:serviceaccount:production:api-server \
  -n production

# Useful: see exactly what a controller can do
kubectl auth can-i --list \
  --as=system:serviceaccount:cert-manager:cert-manager \
  -n cert-manager

# Impersonate with extra metadata (requires API server impersonation extra headers)
kubectl get secrets \
  --as=system:serviceaccount:production:vault-agent \
  --as-group=vault-clients
```

### Proxy Pattern in Go

```go
// proxy-impersonation.go
// A trusted API gateway that forwards requests with impersonation headers.
package gateway

import (
    "net/http"
    "net/http/httputil"
    "net/url"

    "k8s.io/client-go/rest"
    "k8s.io/client-go/transport"
)

// ImpersonatingProxy creates a reverse proxy to the Kubernetes API server
// that attaches impersonation headers based on the authenticated caller.
type ImpersonatingProxy struct {
    target    *url.URL
    transport http.RoundTripper
}

func NewImpersonatingProxy(kubeAPIServer string, tlsConfig *rest.TLSClientConfig) (*ImpersonatingProxy, error) {
    target, err := url.Parse(kubeAPIServer)
    if err != nil {
        return nil, err
    }

    // Build transport using the proxy's service account credentials
    restConfig := &rest.Config{
        Host:      kubeAPIServer,
        TLSClientConfig: *tlsConfig,
    }
    rt, err := rest.TransportFor(restConfig)
    if err != nil {
        return nil, err
    }

    return &ImpersonatingProxy{target: target, transport: rt}, nil
}

func (p *ImpersonatingProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Extract the caller's identity from the gateway's auth layer
    callerUser := r.Header.Get("X-Auth-User")
    callerGroups := r.Header.Values("X-Auth-Groups")

    if callerUser == "" {
        http.Error(w, "authentication required", http.StatusUnauthorized)
        return
    }

    proxy := httputil.NewSingleHostReverseProxy(p.target)
    proxy.Transport = p.transport

    proxy.Director = func(req *http.Request) {
        req.URL.Scheme = p.target.Scheme
        req.URL.Host = p.target.Host

        // Set Kubernetes impersonation headers
        req.Header.Set("Impersonate-User", callerUser)
        req.Header.Del("Impersonate-Group")
        for _, group := range callerGroups {
            req.Header.Add("Impersonate-Group", group)
        }

        // Remove the gateway-internal auth headers
        req.Header.Del("X-Auth-User")
        req.Header.Del("X-Auth-Groups")
    }

    proxy.ServeHTTP(w, r)
}
```

## Section 4: Least Privilege Design

Least privilege in Kubernetes means: each identity has exactly the permissions it needs to function, no more. In practice, this requires systematic analysis of what each controller, operator, and user actually does.

### Service Account Audit Methodology

```bash
#!/bin/bash
# rbac-audit.sh
# Audits service account permissions in a namespace

set -euo pipefail

NAMESPACE=${1:-"production"}

echo "=== RBAC Audit for namespace: ${NAMESPACE} ==="
echo ""

# List all service accounts
echo "[Service Accounts]"
kubectl get serviceaccounts -n "${NAMESPACE}" -o name | sed 's|serviceaccount/||'
echo ""

# For each SA, list its effective permissions
kubectl get serviceaccounts -n "${NAMESPACE}" -o name | \
  sed 's|serviceaccount/||' | while read -r sa; do
  echo "--- ServiceAccount: ${sa} ---"
  kubectl auth can-i --list \
    --as="system:serviceaccount:${NAMESPACE}:${sa}" \
    -n "${NAMESPACE}" 2>/dev/null | \
    grep -v "^Resources\|^*\." | \
    grep -v "selfsubjectreviews\|selfsubjectaccessreviews" || \
    echo "  (no permissions)"
  echo ""
done
```

### Minimal Operator Service Account

Most operators need far fewer permissions than they request. Here's how to audit and minimize:

```bash
# Step 1: Run the operator with full permissions temporarily
# Step 2: Enable audit logging (see Section 5)
# Step 3: Extract what the operator actually called

# Extract API calls from audit log for a specific service account
cat /var/log/kubernetes/audit.log | jq -r '
  select(.user.username == "system:serviceaccount:operators:my-operator") |
  select(.stage == "ResponseComplete") |
  select(.responseStatus.code < 400) |
  "\(.verb) \(.objectRef.resource) \(.objectRef.namespace // "cluster")"
' | sort -u
```

Example output driving a minimal ClusterRole:

```yaml
# minimal-operator-role.yaml
# Derived from audit log analysis — only what the operator actually calls
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-operator
rules:
  # Core operations observed in audit log
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch"]
    # Restrict to specific secrets by name in production
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["apps"]
    resources: ["deployments/status"]
    verbs: ["get", "update", "patch"]
  # CRD own resources
  - apiGroups: ["myapp.example.com"]
    resources: ["myresources", "myresources/status", "myresources/finalizers"]
    verbs: ["get", "list", "watch", "update", "patch"]
  # Leader election
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

### Resource Name Restrictions

For high-security service accounts, restrict to specific resource names:

```yaml
# restricted-sa-role.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: restricted-secret-reader
  namespace: production
rules:
  # Only access specific secrets by name
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames:
      - "database-credentials"
      - "api-keys"
      - "tls-certificate"
    verbs: ["get"]
  # NOT list — listing reveals secret names even if you can't read values
```

```yaml
# restricted-configmap-writer.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: restricted-configmap-writer
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames:
      - "app-config"
      - "feature-flags"
    verbs: ["get", "update", "patch"]
  # Allow creating new configmaps (resourceNames restriction doesn't apply to create)
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["create"]
```

### Namespace-scoped vs Cluster-scoped Escalation

Watch out for these common privilege escalation paths:

```yaml
# DANGEROUS: grants namespace admin via ClusterRole + RoleBinding
# The subject can read ALL secrets in the namespace, including TLS certs,
# service account tokens, and external credentials.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: developer-namespace-admin
  namespace: production
subjects:
  - kind: User
    name: developer@company.com
roleRef:
  kind: ClusterRole
  name: admin  # built-in admin = full namespace access including secrets
  apiGroup: rbac.authorization.k8s.io
```

Safer pattern:

```yaml
# SAFER: custom role with specific permissions, no secret access
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: developer-role
  namespace: production
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
  # NO secrets, NO service accounts, NO roles/bindings
```

## Section 5: Audit Logging Configuration

Kubernetes API server audit logging records every API request. The challenge is balancing completeness (for forensics) against volume (for cost and performance).

### Audit Policy

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Do not log read-only URL paths
  - level: None
    nonResourceURLs:
      - /healthz
      - /readyz
      - /livez
      - /metrics
      - /version

  # Do not log routine watch/list of common resources by system components
  - level: None
    users:
      - system:kube-proxy
      - system:kube-scheduler
      - system:kube-controller-manager
    verbs: ["watch", "list", "get"]
    resources:
      - group: ""
        resources: ["endpoints", "services", "pods", "nodes"]

  # Do not log node self-updates (high volume)
  - level: None
    users:
      - system:node:*
    verbs: ["update", "patch"]
    resources:
      - group: ""
        resources: ["nodes/status", "pods/status"]

  # Do not log leader election leases (very high volume)
  - level: None
    resources:
      - group: "coordination.k8s.io"
        resources: ["leases"]

  # Log secret access at Metadata level (don't log values)
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps", "serviceaccounts/token"]

  # Log all pod exec and port-forward at RequestResponse (full body)
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["pods/exec", "pods/portforward", "pods/attach"]

  # Log all authentication failures at Metadata
  - level: Metadata
    omitStages:
      - RequestReceived
    users:
      - system:anonymous

  # Log RBAC mutations at RequestResponse
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources:
          - "roles"
          - "rolebindings"
          - "clusterroles"
          - "clusterrolebindings"

  # Log all write operations at Request level (no response body)
  - level: Request
    verbs: ["create", "update", "patch", "delete", "deletecollection"]

  # Default: log reads at Metadata (no request/response body)
  - level: Metadata
    omitStages:
      - RequestReceived
```

### API Server Flags for Audit

```bash
# kube-apiserver flags (add to static pod manifest or kubeadm config)
--audit-policy-file=/etc/kubernetes/audit-policy.yaml
--audit-log-path=/var/log/kubernetes/audit.log
--audit-log-maxage=30        # days
--audit-log-maxbackup=10     # files
--audit-log-maxsize=100      # MB per file
--audit-log-format=json
--audit-log-compress=true

# For webhook-based audit (e.g., to ship to SIEM)
--audit-webhook-config-file=/etc/kubernetes/audit-webhook.yaml
--audit-webhook-batch-max-size=400
--audit-webhook-batch-max-wait=5s
```

### Parsing Audit Logs

```bash
# Find all secret accesses by non-system users in the last hour
cat /var/log/kubernetes/audit.log | jq -r '
  select(.objectRef.resource == "secrets") |
  select(.user.username | startswith("system:") | not) |
  select(.stage == "ResponseComplete") |
  "\(.stageTimestamp) \(.user.username) \(.verb) \(.objectRef.namespace)/\(.objectRef.name) -> \(.responseStatus.code)"
' | tail -100

# Find failed API calls (permission denied)
cat /var/log/kubernetes/audit.log | jq -r '
  select(.responseStatus.code == 403) |
  "\(.stageTimestamp) \(.user.username) \(.verb) \(.objectRef.resource) -> DENIED"
' | sort | uniq -c | sort -rn | head -20

# Find pod exec events
cat /var/log/kubernetes/audit.log | jq -r '
  select(.objectRef.subresource == "exec") |
  "\(.stageTimestamp) \(.user.username) exec -> \(.objectRef.namespace)/\(.objectRef.name)"
'

# Detect potential privilege escalation: creating ClusterRoleBindings
cat /var/log/kubernetes/audit.log | jq -r '
  select(.objectRef.resource == "clusterrolebindings") |
  select(.verb == "create") |
  "\(.stageTimestamp) ALERT: \(.user.username) created ClusterRoleBinding \(.objectRef.name)"
'
```

### Audit Log Shipping with Vector

```yaml
# vector-audit-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vector-audit-config
  namespace: logging
data:
  vector.toml: |
    [sources.kubernetes_audit]
    type = "file"
    include = ["/var/log/kubernetes/audit.log"]
    read_from = "beginning"

    [transforms.parse_audit]
    type = "remap"
    inputs = ["kubernetes_audit"]
    source = '''
      . = parse_json!(string!(.message))
      .cluster = "production"
      .env = "prod"
    '''

    [transforms.filter_interesting]
    type = "filter"
    inputs = ["parse_audit"]
    condition = '''
      .verb == "create" || .verb == "delete" ||
      .objectRef.resource == "secrets" ||
      .objectRef.subresource == "exec" ||
      .responseStatus.code == 403 ||
      .objectRef.resource == "clusterrolebindings"
    '''

    [sinks.elasticsearch]
    type = "elasticsearch"
    inputs = ["filter_interesting"]
    endpoint = "http://elasticsearch:9200"
    index = "k8s-audit-%Y.%m.%d"
    bulk.action = "index"
```

## Section 6: RBAC Testing

### Unit Testing RBAC with rbac-tool

```bash
# Install rbac-tool
kubectl krew install rbac-tool

# Generate a visual RBAC graph
kubectl rbac-tool visualize --output-format=dot > rbac-graph.dot
dot -Tsvg rbac-graph.dot -o rbac-graph.svg

# Find all subjects with cluster-admin
kubectl rbac-tool who-can '*' '*' -n '*'

# Find all subjects that can exec into pods
kubectl rbac-tool who-can create pods/exec

# Summarize a service account's permissions
kubectl rbac-tool policy-rules -n production \
  --sa-namespace=production \
  --service-account=api-server
```

### Automated RBAC Testing with Go

```go
// rbac_test.go
package rbactest

import (
    "context"
    "testing"

    authv1 "k8s.io/api/authorization/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"
)

type RBACTest struct {
    Subject   authv1.SubjectAccessReviewSpec
    Resource  authv1.ResourceAttributes
    Expected  bool
    TestName  string
}

func TestRBACPolicies(t *testing.T) {
    config, err := clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile)
    if err != nil {
        t.Skipf("No kubeconfig available: %v", err)
    }
    client, err := kubernetes.NewForConfig(config)
    if err != nil {
        t.Fatal(err)
    }

    tests := []RBACTest{
        // Developer should be able to view pods
        {
            TestName: "developer-can-list-pods",
            Subject:  asUser("developer@company.com", "developers"),
            Resource: resource("", "pods", "production", "list"),
            Expected: true,
        },
        // Developer should NOT be able to access secrets
        {
            TestName: "developer-cannot-get-secrets",
            Subject:  asUser("developer@company.com", "developers"),
            Resource: resource("", "secrets", "production", "get"),
            Expected: false,
        },
        // Prometheus SA should be able to list pods cluster-wide
        {
            TestName: "prometheus-can-list-pods",
            Subject:  asServiceAccount("monitoring", "prometheus"),
            Resource: resource("", "pods", "", "list"),
            Expected: true,
        },
        // Prometheus SA should NOT create deployments
        {
            TestName: "prometheus-cannot-create-deployments",
            Subject:  asServiceAccount("monitoring", "prometheus"),
            Resource: resource("apps", "deployments", "production", "create"),
            Expected: false,
        },
        // API server SA can manage its own configmaps
        {
            TestName: "api-server-can-update-config",
            Subject:  asServiceAccount("production", "api-server"),
            Resource: resource("", "configmaps", "production", "update"),
            Expected: true,
        },
        // API server SA cannot access other namespaces
        {
            TestName: "api-server-cannot-access-staging",
            Subject:  asServiceAccount("production", "api-server"),
            Resource: resource("", "configmaps", "staging", "get"),
            Expected: false,
        },
    }

    for _, tt := range tests {
        t.Run(tt.TestName, func(t *testing.T) {
            sar := &authv1.SubjectAccessReview{
                Spec: authv1.SubjectAccessReviewSpec{
                    User:                  tt.Subject.User,
                    Groups:                tt.Subject.Groups,
                    ResourceAttributes:    &tt.Resource,
                },
            }
            result, err := client.AuthorizationV1().
                SubjectAccessReviews().
                Create(context.Background(), sar, metav1.CreateOptions{})
            if err != nil {
                t.Fatalf("SubjectAccessReview failed: %v", err)
            }

            if result.Status.Allowed != tt.Expected {
                t.Errorf("RBAC check for %s: got allowed=%v, want %v (reason: %s)",
                    tt.TestName, result.Status.Allowed, tt.Expected,
                    result.Status.Reason)
            }
        })
    }
}

func asUser(name string, groups ...string) authv1.SubjectAccessReviewSpec {
    return authv1.SubjectAccessReviewSpec{User: name, Groups: groups}
}

func asServiceAccount(namespace, name string) authv1.SubjectAccessReviewSpec {
    return authv1.SubjectAccessReviewSpec{
        User:   "system:serviceaccount:" + namespace + ":" + name,
        Groups: []string{"system:serviceaccounts", "system:serviceaccounts:" + namespace},
    }
}

func resource(apiGroup, resourceType, namespace, verb string) authv1.ResourceAttributes {
    return authv1.ResourceAttributes{
        Group:     apiGroup,
        Resource:  resourceType,
        Namespace: namespace,
        Verb:      verb,
    }
}
```

## Section 7: RBAC for GitOps (ArgoCD / Flux)

### ArgoCD RBAC Integration

ArgoCD has its own RBAC layer on top of Kubernetes RBAC. Configure it to integrate with group membership from OIDC:

```yaml
# argocd-rbac-cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.csv: |
    # Org-level admin
    g, org:platform-engineers, role:admin

    # Team-level project access
    p, role:team-backend, applications, get,    backend/*, allow
    p, role:team-backend, applications, sync,   backend/*, allow
    p, role:team-backend, applications, update, backend/*, allow
    g, org:backend-engineers, role:team-backend

    p, role:team-frontend, applications, get,    frontend/*, allow
    p, role:team-frontend, applications, sync,   frontend/*, allow
    g, org:frontend-engineers, role:team-frontend

    # Read-only role for all authenticated users
    p, role:readonly, applications, get, */*, allow
    p, role:readonly, clusters, get, *, allow
    g, org:developers, role:readonly

  policy.default: role:readonly
  scopes: "[groups]"
```

### Flux RBAC Restrictions

Flux controllers need cluster-level permissions to reconcile resources. Restricting to specific namespaces:

```yaml
# flux-restricted-role.yaml
# Instead of giving Flux full cluster-admin, restrict to specific namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: flux-restricted
rules:
  # Allow managing all resources in allowed namespaces (via RoleBinding, not ClusterRoleBinding)
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["*"]
---
# Bind only to specific namespaces
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: flux-restricted
  namespace: production  # Only this namespace
subjects:
  - kind: ServiceAccount
    name: flux-source-controller
    namespace: flux-system
  - kind: ServiceAccount
    name: flux-kustomize-controller
    namespace: flux-system
roleRef:
  kind: ClusterRole
  name: flux-restricted
  apiGroup: rbac.authorization.k8s.io
```

## Section 8: Compliance and Policy Enforcement

### OPA/Gatekeeper for RBAC Guardrails

```yaml
# constraint-no-clusteradmin.yaml
# Prevents creating ClusterRoleBindings to cluster-admin
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoClusterAdminBinding
metadata:
  name: no-cluster-admin-binding
spec:
  match:
    kinds:
      - apiGroups: ["rbac.authorization.k8s.io"]
        kinds: ["ClusterRoleBinding"]
  parameters:
    exemptGroups:
      - "platform-engineers"
```

```yaml
# constraint-template-no-cluster-admin.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snoclusteradminbinding
spec:
  crd:
    spec:
      names:
        kind: K8sNoClusterAdminBinding
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptGroups:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8snoclusteradminbinding

        violation[{"msg": msg}] {
          input.review.object.roleRef.name == "cluster-admin"
          subject := input.review.object.subjects[_]
          not exempt(subject)
          msg := sprintf(
            "ClusterRoleBinding to cluster-admin is not permitted for subject %v",
            [subject.name]
          )
        }

        exempt(subject) {
          group := input.parameters.exemptGroups[_]
          subject.kind == "Group"
          subject.name == group
        }
```

### Automated RBAC Drift Detection

```bash
#!/bin/bash
# rbac-drift-check.sh
# Compares current RBAC state against approved baseline stored in git

set -euo pipefail

BASELINE_DIR="./rbac-baseline"
CURRENT_DIR="/tmp/rbac-current"
mkdir -p "${CURRENT_DIR}"

# Export current RBAC state
echo "Exporting current RBAC state..."
kubectl get clusterroles -o yaml > "${CURRENT_DIR}/clusterroles.yaml"
kubectl get clusterrolebindings -o yaml > "${CURRENT_DIR}/clusterrolebindings.yaml"
kubectl get roles -A -o yaml > "${CURRENT_DIR}/roles.yaml"
kubectl get rolebindings -A -o yaml > "${CURRENT_DIR}/rolebindings.yaml"

# Strip managed fields and timestamps for clean comparison
for f in "${CURRENT_DIR}"/*.yaml; do
  yq eval 'del(.items[].metadata.managedFields, .items[].metadata.creationTimestamp, .items[].metadata.resourceVersion, .items[].metadata.uid)' -i "$f"
done

# Compare against baseline
DRIFT=0
for resource in clusterroles clusterrolebindings roles rolebindings; do
  echo "Checking ${resource}..."
  if ! diff -u "${BASELINE_DIR}/${resource}.yaml" "${CURRENT_DIR}/${resource}.yaml" > "/tmp/rbac-diff-${resource}.txt" 2>&1; then
    echo "  DRIFT DETECTED in ${resource}:"
    cat "/tmp/rbac-diff-${resource}.txt" | head -40
    DRIFT=1
  else
    echo "  OK: ${resource} matches baseline"
  fi
done

if [ "${DRIFT}" -eq 1 ]; then
  echo ""
  echo "ALERT: RBAC drift detected. Review changes above."
  echo "To update baseline: cp ${CURRENT_DIR}/*.yaml ${BASELINE_DIR}/"
  exit 1
fi

echo ""
echo "All RBAC checks passed."
```

## Section 9: Production RBAC Checklist

```bash
#!/bin/bash
# rbac-security-checklist.sh

set -euo pipefail

echo "=== Kubernetes RBAC Security Checklist ==="
ISSUES=0

echo ""
echo "[1] Checking for cluster-admin bindings..."
CLUSTER_ADMIN_BINDINGS=$(kubectl get clusterrolebindings -o json | jq -r '
  .items[] |
  select(.roleRef.name == "cluster-admin") |
  .metadata.name + " -> " + (.subjects[]? | .kind + ":" + .name)
')
if [ -n "${CLUSTER_ADMIN_BINDINGS}" ]; then
  echo "  WARNING: cluster-admin bindings found:"
  echo "${CLUSTER_ADMIN_BINDINGS}" | sed 's/^/    /'
  ISSUES=$((ISSUES + 1))
else
  echo "  OK: No unexpected cluster-admin bindings"
fi

echo ""
echo "[2] Checking for service accounts with wildcard permissions..."
kubectl get clusterroles -o json | jq -r '
  .items[] |
  . as $role |
  .rules[]? |
  select(.verbs[] == "*" and .resources[] == "*") |
  $role.metadata.name
' | sort -u | while read -r role; do
  BOUND=$(kubectl get clusterrolebindings -o json | jq -r --arg role "$role" '
    .items[] | select(.roleRef.name == $role) |
    .subjects[]? | select(.kind == "ServiceAccount") | .name
  ')
  if [ -n "${BOUND}" ]; then
    echo "  WARNING: Service accounts bound to wildcard role ${role}: ${BOUND}"
    ISSUES=$((ISSUES + 1))
  fi
done

echo ""
echo "[3] Checking for escalate/bind verbs on RBAC resources..."
kubectl get clusterroles -o json | jq -r '
  .items[] |
  . as $role |
  .rules[]? |
  select(
    (.verbs | map(. == "escalate" or . == "bind") | any) and
    (.apiGroups | map(. == "rbac.authorization.k8s.io") | any)
  ) |
  "  WARNING: " + $role.metadata.name + " has escalate/bind verb"
'

echo ""
echo "[4] Checking for impersonation permissions granted to non-platform roles..."
kubectl get clusterroles -o json | jq -r '
  .items[] |
  . as $role |
  .rules[]? |
  select(.verbs[] == "impersonate") |
  "  INFO: " + $role.metadata.name + " has impersonation permissions"
'

echo ""
echo "[5] Checking for service accounts that can list secrets..."
kubectl get clusterroles,roles -A -o json | jq -r '
  [.items[]? | . as $r |
    .rules[]? |
    select((.resources | map(. == "secrets" or . == "*") | any)) |
    select((.verbs | map(. == "list" or . == "*") | any)) |
    $r.metadata.name
  ] | unique[]
' | head -20

echo ""
if [ "${ISSUES}" -gt 0 ]; then
  echo "=== ${ISSUES} security issue(s) found. Review above. ==="
  exit 1
else
  echo "=== All RBAC security checks passed ==="
fi
```

## Conclusion

Enterprise Kubernetes RBAC requires moving beyond the defaults. Key patterns from this guide:

- **Aggregated ClusterRoles** eliminate the maintenance burden of monolithic roles by composing permissions from labeled building blocks. CRD operators can extend built-in roles without modifying cluster resources.
- **Impersonation** enables safe debugging (reproduce permission errors as the affected identity) and proxy patterns (per-request RBAC enforcement at a gateway layer).
- **Least privilege** requires audit log analysis to determine what each controller actually calls, not what its documentation claims. Resource name restrictions add an additional layer for high-security service accounts.
- **Audit policy tuning** balances completeness (capturing secret access, exec sessions, RBAC mutations) with volume (excluding high-frequency reads by system components).
- **Automated testing** with `SubjectAccessReview` catches regressions before they reach production. RBAC drift detection flags unauthorized changes against a git-controlled baseline.

The investment in systematic RBAC design pays dividends at audit time, incident response time, and every time a new team member joins and needs minimal access to do their job safely.
