---
title: "Kubernetes RBAC Advanced Patterns: Least Privilege at Scale"
date: 2027-11-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "RBAC", "Security", "Audit", "Access Control"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes RBAC at enterprise scale: Role vs ClusterRole design, aggregated ClusterRoles, impersonation, audit log analysis for privilege discovery, OPA/Kyverno policy enforcement, and just-in-time access patterns."
more_link: "yes"
url: /kubernetes-rbac-least-privilege-guide/
---

Kubernetes RBAC is the access control layer that determines what every principal in your cluster can do. Most clusters start with a few ClusterRoleBindings for administrators and a handful of namespace-scoped Roles for application service accounts, but production environments accumulate permissions over time. Teams add broad permissions to unblock deployments, CI systems get cluster-admin for convenience, and service accounts end up with verbs like `*` on resources they never touch.

This guide covers the technical patterns that let you achieve and maintain least privilege at scale: how to design Roles that survive controller upgrades, how to discover what a principal actually needs through audit log analysis, how to enforce permission constraints with OPA and Kyverno, and how to implement just-in-time access so sensitive permissions exist only when they are needed.

<!--more-->

# Kubernetes RBAC Advanced Patterns: Least Privilege at Scale

## RBAC Fundamentals at Scale

The Kubernetes authorization model has four object types: Role, ClusterRole, RoleBinding, and ClusterRoleBinding. Understanding when to use each, and when their interaction creates unexpected effects, is the foundation of safe RBAC design.

### Role vs ClusterRole: The Right Scope

A Role exists in exactly one namespace and can only grant access to resources in that namespace. A ClusterRole is cluster-scoped but can be bound in two different ways:

1. Bound via ClusterRoleBinding: grants cluster-wide access to the ClusterRole's permissions.
2. Bound via RoleBinding in namespace N: grants the ClusterRole's permissions but scoped to namespace N only.

This second pattern is widely underused. Define capabilities in ClusterRoles and bind them into specific namespaces using RoleBindings. This approach eliminates duplicate Role definitions and makes permission changes cluster-wide.

```yaml
# Pattern: Define capability as ClusterRole, bind to namespace with RoleBinding.
# This ClusterRole represents the "app-operator" capability.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: app-operator
  labels:
    rbac.example.com/category: application
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
---
# Bind to team-alpha namespace only.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-alpha-operators
  namespace: team-alpha
subjects:
  - kind: Group
    name: team-alpha-operators
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: app-operator
  apiGroup: rbac.authorization.k8s.io
---
# The same ClusterRole bound in a different namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: team-beta-operators
  namespace: team-beta
subjects:
  - kind: Group
    name: team-beta-operators
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: app-operator
  apiGroup: rbac.authorization.k8s.io
```

`★ Insight ─────────────────────────────────────`
The ClusterRole-plus-RoleBinding pattern is the key to scalable RBAC. When you define permissions in ClusterRoles and scope them with RoleBindings, you can update the permission set in one place and it propagates to all bound namespaces. This is how the built-in `view`, `edit`, and `admin` ClusterRoles work.
`─────────────────────────────────────────────────`

### Aggregated ClusterRoles

Kubernetes built-in roles like `view`, `edit`, and `admin` use aggregation labels. Any ClusterRole with the matching label is automatically incorporated into the aggregate. You can extend built-in roles or define your own aggregate roles without patching them directly.

```yaml
# Extend the built-in view ClusterRole to include custom resources.
# Any ClusterRole with rbac.authorization.k8s.io/aggregate-to-view: "true"
# is automatically merged into the view ClusterRole.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: orders-viewer
  labels:
    rbac.authorization.k8s.io/aggregate-to-view: "true"
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
    rbac.authorization.k8s.io/aggregate-to-admin: "true"
rules:
  - apiGroups: ["orders.example.com"]
    resources: ["orders", "orderitems"]
    verbs: ["get", "list", "watch"]
---
# Custom aggregate ClusterRole for SRE team.
# The aggregationRule selects ClusterRoles that are combined into this one.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sre-aggregate
aggregationRule:
  clusterRoleSelectors:
    - matchLabels:
        rbac.example.com/aggregate-to-sre: "true"
rules: []  # Rules are populated automatically from selected ClusterRoles.
---
# Add monitoring access to the SRE aggregate.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sre-monitoring-access
  labels:
    rbac.example.com/aggregate-to-sre: "true"
rules:
  - apiGroups: ["monitoring.coreos.com"]
    resources: ["prometheuses", "alertmanagers", "prometheusrules", "servicemonitors"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods", "nodes", "namespaces"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log", "pods/exec"]
    verbs: ["get", "create"]
---
# Add incident response access to the SRE aggregate.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: sre-incident-access
  labels:
    rbac.example.com/aggregate-to-sre: "true"
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets", "statefulsets"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale"]
    verbs: ["update", "patch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "delete"]
```

## Audit Log Analysis for Permission Discovery

The most reliable way to determine what permissions a service account needs is to run it with elevated permissions, capture the audit log, and extract only the API calls it actually makes. This approach works for both existing services that have over-privileged access and new services being onboarded.

### Kubernetes Audit Policy

```yaml
# k8s/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - RequestReceived  # Omit the initial event; only record the response.
rules:
  # Log full request and response for secrets to detect credential access.
  - level: RequestResponse
    resources:
      - group: ""
        resources: ["secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]

  # Log full request/response for RBAC changes.
  - level: RequestResponse
    resources:
      - group: "rbac.authorization.k8s.io"
        resources: ["roles", "clusterroles", "rolebindings", "clusterrolebindings"]
    verbs: ["create", "update", "patch", "delete"]

  # Log metadata (no request/response body) for all other resource access.
  - level: Metadata
    resources:
      - group: ""
        resources: ["pods", "services", "configmaps", "endpoints", "serviceaccounts"]
      - group: "apps"
        resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
      - group: "batch"
        resources: ["jobs", "cronjobs"]

  # Log at Metadata level for everything else.
  - level: Metadata
```

Configure the API server to use the audit policy:

```yaml
# kubeadm ClusterConfiguration excerpt (control plane nodes only).
apiServer:
  extraArgs:
    audit-policy-file: /etc/kubernetes/audit-policy.yaml
    audit-log-path: /var/log/kubernetes/audit/audit.log
    audit-log-maxage: "30"
    audit-log-maxbackup: "10"
    audit-log-maxsize: "100"
  extraVolumes:
    - name: audit-policy
      hostPath: /etc/kubernetes/audit-policy.yaml
      mountPath: /etc/kubernetes/audit-policy.yaml
      readOnly: true
    - name: audit-log
      hostPath: /var/log/kubernetes/audit
      mountPath: /var/log/kubernetes/audit
```

### Audit Log Analysis Script

```bash
#!/usr/bin/env bash
# analyze-rbac-audit.sh
# Analyze Kubernetes audit logs to determine what permissions a service account
# actually needs. Run after deploying with broad permissions and exercising
# normal workload behavior.

set -euo pipefail

SERVICE_ACCOUNT="${1:-default}"
NAMESPACE="${2:-default}"
AUDIT_LOG="${3:-/var/log/kubernetes/audit/audit.log}"
OUTPUT_FILE="${4:-required-permissions.yaml}"

# The user identifier in audit logs for service accounts is:
# system:serviceaccount:<namespace>:<name>
USER="system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT}"

echo "Analyzing audit log for ${USER}..."

# Extract unique (apiGroup, resource, verb) tuples used by the service account.
PERMISSIONS=$(grep "\"username\":\"${USER}\"" "${AUDIT_LOG}" \
  | jq -r '
    select(.responseStatus.code >= 200 and .responseStatus.code < 300) |
    select(.stage == "ResponseComplete") |
    [
      (.objectRef.apiGroup // ""),
      (.objectRef.resource // ""),
      (.verb // "")
    ] | @tsv
  ' \
  | sort -u \
  | grep -v $'^\\t\\t')

if [ -z "$PERMISSIONS" ]; then
  echo "No successful API calls found for ${USER}"
  exit 0
fi

echo "Discovered API access patterns:"
echo "${PERMISSIONS}"
echo ""

# Generate a ClusterRole YAML from the discovered permissions.
cat > "${OUTPUT_FILE}" << HEREDOC
# Auto-generated by analyze-rbac-audit.sh
# Service account: ${USER}
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# IMPORTANT: Review before applying. Remove unnecessary permissions.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${SERVICE_ACCOUNT}-minimal
  annotations:
    rbac.example.com/generated: "true"
    rbac.example.com/source: "audit-log-analysis"
    rbac.example.com/review-required: "true"
rules:
HEREDOC

# Group verbs by apiGroup+resource.
declare -A GROUPED
while IFS=$'\t' read -r apigroup resource verb; do
  key="${apigroup}::${resource}"
  if [[ -v "GROUPED[$key]" ]]; then
    GROUPED[$key]="${GROUPED[$key]},${verb}"
  else
    GROUPED[$key]="${verb}"
  fi
done <<< "${PERMISSIONS}"

# Group rules by apiGroup.
declare -A BY_GROUP
for key in "${!GROUPED[@]}"; do
  IFS='::' read -r apigroup resource <<< "${key}"
  if [[ -v "BY_GROUP[$apigroup]" ]]; then
    BY_GROUP[$apigroup]="${BY_GROUP[$apigroup]}|${resource}:${GROUPED[$key]}"
  else
    BY_GROUP[$apigroup]="${resource}:${GROUPED[$key]}"
  fi
done

for apigroup in "${!BY_GROUP[@]}"; do
  echo "  - apiGroups: [\"${apigroup}\"]" >> "${OUTPUT_FILE}"
  echo "    resources:" >> "${OUTPUT_FILE}"

  # Collect unique resources for this apiGroup.
  declare -A SEEN_RESOURCES
  IFS='|' read -ra RESOURCE_VERB_PAIRS <<< "${BY_GROUP[$apigroup]}"
  for pair in "${RESOURCE_VERB_PAIRS[@]}"; do
    resource="${pair%%:*}"
    if [[ ! -v "SEEN_RESOURCES[$resource]" ]]; then
      echo "      - \"${resource}\"" >> "${OUTPUT_FILE}"
      SEEN_RESOURCES[$resource]=1
    fi
  done
  unset SEEN_RESOURCES

  echo "    verbs:" >> "${OUTPUT_FILE}"

  # Collect unique verbs for this apiGroup.
  declare -A SEEN_VERBS
  for pair in "${RESOURCE_VERB_PAIRS[@]}"; do
    verbs="${pair#*:}"
    IFS=',' read -ra VERB_ARRAY <<< "${verbs}"
    for v in "${VERB_ARRAY[@]}"; do
      if [[ ! -v "SEEN_VERBS[$v]" ]]; then
        echo "      - \"${v}\"" >> "${OUTPUT_FILE}"
        SEEN_VERBS[$v]=1
      fi
    done
  done
  unset SEEN_VERBS
done

echo "Generated minimal Role: ${OUTPUT_FILE}"
echo "Review carefully before applying to production."
```

### Continuous Audit Log Mining

For ongoing monitoring, stream audit events to identify privilege escalations and unexpected API access patterns.

```go
// tools/rbac-auditor/main.go
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

// AuditEvent is a single entry from the Kubernetes audit log.
type AuditEvent struct {
	Level      string    `json:"level"`
	AuditID    string    `json:"auditID"`
	Stage      string    `json:"stage"`
	Verb       string    `json:"verb"`
	User       UserInfo  `json:"user"`
	ObjectRef  ObjectRef `json:"objectRef"`
	Response   Response  `json:"responseStatus"`
	ReceivedAt time.Time `json:"requestReceivedTimestamp"`
}

type UserInfo struct {
	Username string   `json:"username"`
	Groups   []string `json:"groups"`
}

type ObjectRef struct {
	Resource    string `json:"resource"`
	Namespace   string `json:"namespace"`
	Name        string `json:"name"`
	APIGroup    string `json:"apiGroup"`
	Subresource string `json:"subresource"`
}

type Response struct {
	Code int `json:"code"`
}

var sensitiveResources = map[string]bool{
	"secrets":             true,
	"roles":               true,
	"clusterroles":        true,
	"rolebindings":        true,
	"clusterrolebindings": true,
	"serviceaccounts":     true,
	"pods/exec":           true,
	"nodes/proxy":         true,
}

var writeVerbs = map[string]bool{
	"create": true, "update": true, "patch": true,
	"delete": true, "deletecollection": true,
}

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: rbac-auditor <audit-log-file>")
	}

	f, err := os.Open(os.Args[1])
	if err != nil {
		log.Fatalf("open audit log: %v", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 2*1024*1024), 2*1024*1024)

	for scanner.Scan() {
		var event AuditEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue
		}

		// Only log completed responses.
		if event.Stage != "ResponseComplete" {
			continue
		}
		// Skip system components to reduce noise.
		if strings.HasPrefix(event.User.Username, "system:node:") {
			continue
		}
		// Skip non-2xx responses.
		if event.Response.Code < 200 || event.Response.Code >= 300 {
			continue
		}

		resource := event.ObjectRef.Resource
		if event.ObjectRef.Subresource != "" {
			resource += "/" + event.ObjectRef.Subresource
		}

		isSensitive := sensitiveResources[resource]
		isWrite := writeVerbs[event.Verb]
		isSA := strings.HasPrefix(event.User.Username, "system:serviceaccount:")

		if (isSensitive && isWrite) || (isSensitive && isSA) {
			fmt.Printf("[%s] ALERT user=%s verb=%s resource=%s ns=%s name=%s\n",
				event.ReceivedAt.UTC().Format(time.RFC3339),
				event.User.Username,
				event.Verb,
				resource,
				event.ObjectRef.Namespace,
				event.ObjectRef.Name,
			)
		}
	}

	if err := scanner.Err(); err != nil {
		log.Fatalf("scan: %v", err)
	}
}
```

## Impersonation

Kubernetes impersonation allows a principal to act as another user, group, or service account. This is powerful for SRE teams debugging authorization issues and for CI pipelines that need to deploy with application-level permissions rather than cluster-admin.

### Impersonation Role

```yaml
# Grant the SRE group permission to impersonate specific service accounts.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: impersonate-app-accounts
  labels:
    rbac.example.com/owner: "platform-team"
    rbac.example.com/purpose: "Allow SRE to impersonate app service accounts for debugging"
rules:
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["impersonate"]
    # Restrict to specific accounts using resourceNames.
    resourceNames:
      - "order-service"
      - "payment-service"
      - "inventory-service"
  # Allow impersonating the service account's UID and groups.
  - apiGroups: ["authentication.k8s.io"]
    resources: ["userextras/scopes"]
    verbs: ["impersonate"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: sre-can-impersonate-apps
subjects:
  - kind: Group
    name: sre-team
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: impersonate-app-accounts
  apiGroup: rbac.authorization.k8s.io
```

### Using Impersonation for Authorization Testing

```bash
# Test what the order-service account can do in production.
kubectl auth can-i --list \
  --as=system:serviceaccount:production:order-service \
  --namespace=production

# Check if it can read secrets (it should not need to in most cases).
kubectl auth can-i get secrets \
  --as=system:serviceaccount:production:order-service \
  --namespace=production

# Verify a developer's access before a deployment.
kubectl auth can-i create deployments \
  --as=jane.doe@example.com \
  --namespace=team-alpha

# Run an actual command impersonating the service account.
kubectl get pods -n production \
  --as=system:serviceaccount:production:order-service

# Verify the audit log captures impersonation.
# The audit log shows both the original user and the impersonated identity.
kubectl get pods -n production \
  --as=system:serviceaccount:production:order-service \
  --as-group=system:serviceaccounts \
  --as-group=system:authenticated
```

## Minimal Service Account Permissions

Every pod runs with the `default` service account unless specified otherwise. The default service account token is automounted, and the token can authenticate as that service account against the API server.

### Disable Automounting

```yaml
# Disable token automounting on the default service account cluster-wide.
# Apply this in every namespace to prevent accidental API access.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: default
  namespace: production
automountServiceAccountToken: false
---
# Application service account with explicit, documented permissions.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-service
  namespace: production
  annotations:
    rbac.example.com/purpose: "Read deployment status; write configmaps for feature flags"
    rbac.example.com/owner: "order-team"
    rbac.example.com/last-reviewed: "2024-06-15"
    rbac.example.com/ticket: "INFRA-2847"
automountServiceAccountToken: false
```

```yaml
# Pod spec with projected token volume (short-lived, auto-rotated).
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: order-service
      automountServiceAccountToken: false
      volumes:
        - name: kube-api-access
          projected:
            defaultMode: 0444
            sources:
              - serviceAccountToken:
                  # Token expires after 1 hour and kubelet auto-rotates it.
                  expirationSeconds: 3600
                  path: token
              - configMap:
                  name: kube-root-ca.crt
                  items:
                    - key: ca.crt
                      path: ca.crt
              - downwardAPI:
                  items:
                    - path: namespace
                      fieldRef:
                        fieldPath: metadata.namespace
      containers:
        - name: order-service
          image: registry.example.com/order-service:v1.4.2
          volumeMounts:
            - name: kube-api-access
              mountPath: /var/run/secrets/kubernetes.io/serviceaccount
              readOnly: true
```

## Permission Minimization Automation

Periodically reviewing all RBAC objects is too manual to be sustainable. Automate detection of over-privileged bindings.

### RBAC Audit Script

```bash
#!/usr/bin/env bash
# rbac-audit.sh
# Detect RBAC anti-patterns across all namespaces.
# Exit code 1 if violations found (suitable for CI gates).

set -euo pipefail

VIOLATIONS=0
REPORT_FILE="rbac-audit-$(date +%Y%m%d-%H%M%S).txt"

log() { echo "$*" | tee -a "${REPORT_FILE}"; }

log "RBAC Audit Report - $(date -u)"
log "================================="
log ""

# 1. Bindings that grant cluster-admin.
log "=== CLUSTER-ADMIN BINDINGS ==="
kubectl get clusterrolebindings -o json \
  | jq -r '
    .items[] |
    select(.roleRef.name == "cluster-admin") |
    "ClusterRoleBinding: " + .metadata.name +
    " -> " + ([.subjects[]? | .kind + "/" + .name] | join(", "))
  ' | while read -r line; do
    log "  ${line}"
    VIOLATIONS=$((VIOLATIONS + 1))
  done

log ""
log "=== WILDCARD VERB USAGE ==="
# 2. ClusterRoles with wildcard verbs (excluding system roles).
kubectl get clusterroles -o json \
  | jq -r '
    .items[] |
    select(.metadata.name | (startswith("system:") or startswith("kubeadm:")) | not) |
    . as $r |
    .rules[]? |
    select(.verbs[] == "*") |
    "ClusterRole: " + $r.metadata.name + " has wildcard verb on: " +
    (.resources // ["*"] | join(", "))
  ' | while read -r line; do
    log "  ${line}"
    VIOLATIONS=$((VIOLATIONS + 1))
  done

kubectl get roles --all-namespaces -o json \
  | jq -r '
    .items[] |
    . as $r |
    .rules[]? |
    select(.verbs[] == "*") |
    "Role " + $r.metadata.namespace + "/" + $r.metadata.name +
    " has wildcard verb on: " + (.resources // ["*"] | join(", "))
  ' | while read -r line; do
    log "  ${line}"
    VIOLATIONS=$((VIOLATIONS + 1))
  done

log ""
log "=== SERVICE ACCOUNTS WITH CLUSTER-WIDE BINDINGS ==="
# 3. Service accounts with ClusterRoleBindings.
kubectl get clusterrolebindings -o json \
  | jq -r '
    .items[] |
    . as $crb |
    .subjects[]? |
    select(.kind == "ServiceAccount") |
    "SA " + .namespace + "/" + .name +
    " via ClusterRoleBinding " + $crb.metadata.name +
    " -> role: " + $crb.roleRef.name
  ' | while read -r line; do
    log "  ${line}"
    VIOLATIONS=$((VIOLATIONS + 1))
  done

log ""
log "=== BINDINGS TO DEFAULT SERVICE ACCOUNTS ==="
# 4. Explicit bindings to the default service account.
kubectl get rolebindings --all-namespaces -o json \
  | jq -r '
    .items[] |
    . as $rb |
    .subjects[]? |
    select(.kind == "ServiceAccount" and .name == "default") |
    "RoleBinding " + $rb.metadata.namespace + "/" + $rb.metadata.name +
    " grants " + $rb.roleRef.name + " to default SA"
  ' | while read -r line; do
    log "  ${line}"
    VIOLATIONS=$((VIOLATIONS + 1))
  done

log ""
log "=== RBAC OBJECTS MISSING OWNERSHIP LABELS ==="
# 5. ClusterRoles without owner annotation (excluding system roles).
kubectl get clusterroles -o json \
  | jq -r '
    .items[] |
    select(.metadata.name | (startswith("system:") or startswith("kubeadm:")) | not) |
    select(.metadata.annotations["rbac.example.com/owner"] == null) |
    "ClusterRole: " + .metadata.name + " has no owner annotation"
  ' | while read -r line; do
    log "  ${line}"
  done

log ""
log "Audit complete. Violations: ${VIOLATIONS}"
log "Report: ${REPORT_FILE}"

if [ "${VIOLATIONS}" -gt 0 ]; then
  exit 1
fi
```

### Scheduled Audit CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: rbac-audit
  namespace: platform-tools
spec:
  schedule: "0 6 * * 1"  # Every Monday at 06:00 UTC.
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: rbac-auditor
          restartPolicy: OnFailure
          containers:
            - name: rbac-auditor
              image: registry.example.com/platform-tools:v2.1.0
              command: ["/bin/bash", "-c"]
              args:
                - |
                  /scripts/rbac-audit.sh 2>&1 | tee /tmp/report.txt
                  RESULT=$?
                  # Post first 100 lines to Slack.
                  SUMMARY=$(head -100 /tmp/report.txt)
                  curl -s -X POST \
                    -H 'Content-type: application/json' \
                    -d "{\"text\":\"Weekly RBAC Audit:\n\`\`\`${SUMMARY}\`\`\`\"}" \
                    "${SLACK_WEBHOOK_URL}"
                  exit $RESULT
              env:
                - name: SLACK_WEBHOOK_URL
                  valueFrom:
                    secretKeyRef:
                      name: platform-notifications
                      key: slack-webhook-url
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 256Mi
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: rbac-auditor
  labels:
    rbac.example.com/owner: "platform-team"
    rbac.example.com/purpose: "Read RBAC objects for weekly audit"
rules:
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "clusterroles", "rolebindings", "clusterrolebindings"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["serviceaccounts", "namespaces"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: rbac-auditor
subjects:
  - kind: ServiceAccount
    name: rbac-auditor
    namespace: platform-tools
roleRef:
  kind: ClusterRole
  name: rbac-auditor
  apiGroup: rbac.authorization.k8s.io
```

## OPA Gatekeeper RBAC Policies

Open Policy Agent Gatekeeper enforces admission policies that prevent over-privileged Roles from being created, even by users with RBAC write access.

### Block Wildcard Verbs

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snowildcardverbs
spec:
  crd:
    spec:
      names:
        kind: K8sNoWildcardVerbs
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptPrefixes:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8snowildcardverbs

        import future.keywords.in

        violation[{"msg": msg}] {
          input.review.kind.kind in {"Role", "ClusterRole"}
          rule := input.review.object.rules[_]
          "*" in rule.verbs
          not exempt(input.review.object.metadata.name)
          msg := sprintf(
            "%s %s/%s: wildcard verb (*) not permitted. Specify explicit verbs.",
            [
              input.review.kind.kind,
              input.review.object.metadata.namespace,
              input.review.object.metadata.name
            ]
          )
        }

        exempt(name) {
          prefix := input.parameters.exemptPrefixes[_]
          startswith(name, prefix)
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoWildcardVerbs
metadata:
  name: no-wildcard-verbs
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["rbac.authorization.k8s.io"]
        kinds: ["Role", "ClusterRole"]
    excludedNamespaces: ["kube-system"]
  parameters:
    exemptPrefixes:
      - "system:"
      - "kubeadm:"
```

### Block New cluster-admin Bindings

```yaml
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
            allowedBindingNames:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8snoclusteradminbinding

        import future.keywords.in

        violation[{"msg": msg}] {
          input.review.kind.kind in {"RoleBinding", "ClusterRoleBinding"}
          input.review.object.roleRef.name == "cluster-admin"
          not allowed_binding(input.review.object.metadata.name)
          msg := sprintf(
            "%s %s binds to cluster-admin. Use a least-privilege ClusterRole instead.",
            [input.review.kind.kind, input.review.object.metadata.name]
          )
        }

        allowed_binding(name) {
          name == input.parameters.allowedBindingNames[_]
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoClusterAdminBinding
metadata:
  name: no-new-cluster-admin-bindings
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["rbac.authorization.k8s.io"]
        kinds: ["RoleBinding", "ClusterRoleBinding"]
  parameters:
    allowedBindingNames:
      - "cluster-admin"  # The bootstrap binding created by kubeadm.
      - "kube-admin-emergency"  # Break-glass account.
```

### Require Ownership Labels

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirerbackownership
spec:
  crd:
    spec:
      names:
        kind: K8sRequireRBACOwnership
      validation:
        openAPIV3Schema:
          type: object
          properties:
            requiredLabels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequirerbacownership

        import future.keywords.in

        violation[{"msg": msg}] {
          input.review.kind.kind in {"Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"}
          not system_resource(input.review.object.metadata.name)
          label := input.parameters.requiredLabels[_]
          not input.review.object.metadata.labels[label]
          msg := sprintf(
            "%s %s is missing required label: %s",
            [input.review.kind.kind, input.review.object.metadata.name, label]
          )
        }

        system_resource(name) { startswith(name, "system:") }
        system_resource(name) { startswith(name, "kubeadm:") }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireRBACOwnership
metadata:
  name: require-rbac-ownership
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["rbac.authorization.k8s.io"]
        kinds: ["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"]
    excludedNamespaces: ["kube-system", "kube-public", "kube-node-lease"]
  parameters:
    requiredLabels:
      - "rbac.example.com/owner"
      - "rbac.example.com/purpose"
```

## Kyverno RBAC Policies

Kyverno provides a simpler DSL than Rego for many common RBAC policy patterns.

```yaml
# Prevent ClusterRoles from granting cluster-wide secret read access.
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-clusterwide-secret-access
  annotations:
    policies.kyverno.io/title: Restrict Cluster-Wide Secret Access
    policies.kyverno.io/category: RBAC Security
    policies.kyverno.io/description: >
      Prevents ClusterRoles from granting read access to secrets cluster-wide.
      Use namespace-scoped Roles bound with RoleBindings instead.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-secret-access
      match:
        any:
          - resources:
              kinds: ["ClusterRole"]
      exclude:
        any:
          - resources:
              names: ["system:*", "kubeadm:*", "cluster-admin"]
      validate:
        message: >
          ClusterRole {{ request.object.metadata.name }} grants cluster-wide
          secret access. Use a namespace-scoped Role instead.
        foreach:
          - list: "request.object.rules"
            deny:
              conditions:
                all:
                  - key: "secrets"
                    operator: AnyIn
                    value: "{{ element.resources }}"
                  - key: "{{ element.verbs }}"
                    operator: AnyIn
                    value: ["get", "list", "watch", "*"]
---
# Auto-label new RBAC objects with creator information.
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-rbac-creator-label
  annotations:
    policies.kyverno.io/title: Add RBAC Creator Label
    policies.kyverno.io/category: RBAC Governance
spec:
  rules:
    - name: add-creator
      match:
        any:
          - resources:
              kinds: ["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"]
      exclude:
        any:
          - resources:
              names: ["system:*", "kubeadm:*"]
          - subjects:
              - kind: ServiceAccount
                name: system:*
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(rbac.example.com/created-by): "{{ request.userInfo.username }}"
            annotations:
              +(rbac.example.com/created-at): "{{ request.time }}"
---
# Ensure Roles do not grant exec access to non-privileged namespaces
# without a specific annotation approving it.
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-pod-exec
  annotations:
    policies.kyverno.io/title: Restrict Pod Exec Access
    policies.kyverno.io/category: RBAC Security
spec:
  validationFailureAction: Audit
  background: false
  rules:
    - name: check-exec-annotation
      match:
        any:
          - resources:
              kinds: ["Role", "ClusterRole"]
      exclude:
        any:
          - resources:
              names: ["system:*", "kubeadm:*"]
              annotations:
                rbac.example.com/exec-approved: "true"
      validate:
        message: >
          {{ request.object.metadata.name }} grants pods/exec. Add annotation
          rbac.example.com/exec-approved: "true" after security review.
        foreach:
          - list: "request.object.rules"
            deny:
              conditions:
                all:
                  - key: "exec"
                    operator: AnyIn
                    value: "{{ element.verbs }}"
                  - key: "pods/exec"
                    operator: AnyIn
                    value: "{{ element.resources }}"
                  - key: "{{ request.object.metadata.annotations['rbac.example.com/exec-approved'] }}"
                    operator: NotEquals
                    value: "true"
```

## Namespace-Scoped Tenant Isolation

Multi-tenant clusters require each tenant to be restricted to their namespace without any path to cross-namespace access.

```yaml
# Reusable ClusterRole for full namespace control.
# Bind via RoleBinding (never ClusterRoleBinding) to scope to one namespace.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: namespace-admin
  labels:
    rbac.example.com/category: "tenant"
    rbac.example.com/owner: "platform-team"
    rbac.example.com/purpose: "Full control within a single namespace"
rules:
  - apiGroups: ["", "apps", "batch", "autoscaling", "networking.k8s.io"]
    resources:
      - deployments
      - replicasets
      - statefulsets
      - daemonsets
      - pods
      - pods/log
      - pods/exec
      - services
      - endpoints
      - configmaps
      - secrets
      - serviceaccounts
      - persistentvolumeclaims
      - jobs
      - cronjobs
      - horizontalpodautoscalers
      - ingresses
      - networkpolicies
    verbs: ["*"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
  # Allow tenants to create namespace-scoped RBAC objects.
  # The API server's escalation check prevents granting permissions
  # the tenant does not themselves have.
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings"]
    verbs: ["*"]
```

```bash
#!/usr/bin/env bash
# provision-tenant.sh
# Create a namespace with tenant RBAC and default network policies.

set -euo pipefail

TENANT="$1"
GROUP="$2"
NS="${TENANT}"

kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -

kubectl label namespace "${NS}" \
  "tenant=${TENANT}" \
  "pod-security.kubernetes.io/enforce=restricted" \
  "pod-security.kubernetes.io/enforce-version=latest" \
  --overwrite

# Bind namespace-admin into the tenant's namespace.
kubectl create rolebinding "${TENANT}-admins" \
  --clusterrole=namespace-admin \
  --group="${GROUP}" \
  --namespace="${NS}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Default-deny-all NetworkPolicy.
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ${NS}
  labels:
    rbac.example.com/owner: "platform-team"
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: ${NS}
  labels:
    rbac.example.com/owner: "platform-team"
spec:
  podSelector: {}
  ingress:
    - from:
        - podSelector: {}
  egress:
    - to:
        - podSelector: {}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-kube-dns
  namespace: ${NS}
  labels:
    rbac.example.com/owner: "platform-team"
spec:
  podSelector: {}
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        - podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
EOF

echo "Tenant ${TENANT} provisioned in namespace ${NS} for group ${GROUP}"
```

## Just-In-Time Access

Permanent elevated permissions increase blast radius. Just-in-time access grants permissions for a limited duration with an audit trail.

```go
// tools/jit-access/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// JITRequest defines a temporary access grant.
type JITRequest struct {
	Subject   string
	Namespace string
	Role      string
	Duration  time.Duration
	Requester string
	Ticket    string
}

// GrantTemporaryAccess creates a time-limited RoleBinding and schedules deletion.
func GrantTemporaryAccess(ctx context.Context, client kubernetes.Interface, req JITRequest) error {
	expiry := time.Now().Add(req.Duration)
	name := fmt.Sprintf("jit-%s-%s", req.Subject, time.Now().Format("20060102-150405"))

	binding := &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: req.Namespace,
			Labels: map[string]string{
				"rbac.example.com/jit":     "true",
				"rbac.example.com/subject": req.Subject,
			},
			Annotations: map[string]string{
				"rbac.example.com/jit":       "true",
				"rbac.example.com/expiry":    expiry.UTC().Format(time.RFC3339),
				"rbac.example.com/requester": req.Requester,
				"rbac.example.com/ticket":    req.Ticket,
			},
		},
		Subjects: []rbacv1.Subject{
			{Kind: "User", Name: req.Subject, APIGroup: "rbac.authorization.k8s.io"},
		},
		RoleRef: rbacv1.RoleRef{
			Kind:     "ClusterRole",
			Name:     req.Role,
			APIGroup: "rbac.authorization.k8s.io",
		},
	}

	created, err := client.RbacV1().RoleBindings(req.Namespace).Create(
		ctx, binding, metav1.CreateOptions{},
	)
	if err != nil {
		return fmt.Errorf("create JIT binding: %w", err)
	}

	log.Printf("JIT binding created: %s/%s for %s, expires %s (ticket: %s)",
		req.Namespace, created.Name, req.Subject,
		expiry.Format(time.RFC3339), req.Ticket)

	// Schedule deletion.
	go func() {
		select {
		case <-time.After(req.Duration):
		case <-ctx.Done():
			log.Printf("Context cancelled; JIT binding %s/%s will not be auto-deleted",
				req.Namespace, created.Name)
			return
		}

		delCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		if err := client.RbacV1().RoleBindings(req.Namespace).Delete(
			delCtx, created.Name, metav1.DeleteOptions{},
		); err != nil {
			log.Printf("ERROR: could not delete JIT binding %s/%s: %v",
				req.Namespace, created.Name, err)
			return
		}
		log.Printf("JIT binding expired and deleted: %s/%s", req.Namespace, created.Name)
	}()

	return nil
}

// RevokeExpiredBindings is called by the cleanup CronJob to catch any bindings
// whose in-process timer did not fire (pod restart, etc.).
func RevokeExpiredBindings(ctx context.Context, client kubernetes.Interface) error {
	bindings, err := client.RbacV1().RoleBindings("").List(ctx, metav1.ListOptions{
		LabelSelector: "rbac.example.com/jit=true",
	})
	if err != nil {
		return fmt.Errorf("list JIT bindings: %w", err)
	}

	now := time.Now().UTC()
	revoked := 0

	for _, b := range bindings.Items {
		expiryStr, ok := b.Annotations["rbac.example.com/expiry"]
		if !ok {
			continue
		}
		expiry, err := time.Parse(time.RFC3339, expiryStr)
		if err != nil {
			log.Printf("WARN: invalid expiry on %s/%s: %q", b.Namespace, b.Name, expiryStr)
			continue
		}
		if now.After(expiry) {
			if err := client.RbacV1().RoleBindings(b.Namespace).Delete(
				ctx, b.Name, metav1.DeleteOptions{},
			); err != nil {
				log.Printf("ERROR: delete %s/%s: %v", b.Namespace, b.Name, err)
				continue
			}
			log.Printf("Revoked expired JIT binding %s/%s (expired %s)",
				b.Namespace, b.Name, expiry.Format(time.RFC3339))
			revoked++
		}
	}

	log.Printf("Revoked %d expired JIT bindings", revoked)
	return nil
}

func main() {
	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		kubeconfig = os.Getenv("HOME") + "/.kube/config"
	}

	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		log.Fatalf("build config: %v", err)
	}

	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		log.Fatalf("build client: %v", err)
	}

	ctx := context.Background()

	switch os.Args[1] {
	case "grant":
		if err := GrantTemporaryAccess(ctx, client, JITRequest{
			Subject:   os.Args[2],
			Namespace: os.Args[3],
			Role:      os.Args[4],
			Duration:  4 * time.Hour,
			Requester: os.Getenv("REQUESTER"),
			Ticket:    os.Getenv("TICKET"),
		}); err != nil {
			log.Fatalf("grant: %v", err)
		}
	case "cleanup":
		if err := RevokeExpiredBindings(ctx, client); err != nil {
			log.Fatalf("cleanup: %v", err)
		}
	default:
		log.Fatalf("usage: jit-access <grant|cleanup> [args...]")
	}
}
```

### JIT Cleanup CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: jit-binding-cleanup
  namespace: platform-tools
  labels:
    rbac.example.com/owner: "platform-team"
    rbac.example.com/purpose: "Remove expired JIT RoleBindings every 15 minutes"
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 5
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: jit-cleanup
          restartPolicy: OnFailure
          containers:
            - name: jit-cleanup
              image: registry.example.com/jit-access:v1.0.0
              command: ["/jit-access", "cleanup"]
              resources:
                requests:
                  cpu: 50m
                  memory: 64Mi
                limits:
                  cpu: 200m
                  memory: 128Mi
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: jit-cleanup
  labels:
    rbac.example.com/owner: "platform-team"
    rbac.example.com/purpose: "List and delete expired JIT RoleBindings"
rules:
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["rolebindings"]
    verbs: ["list", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: jit-cleanup
  labels:
    rbac.example.com/owner: "platform-team"
    rbac.example.com/purpose: "Bind cleanup role to service account"
subjects:
  - kind: ServiceAccount
    name: jit-cleanup
    namespace: platform-tools
roleRef:
  kind: ClusterRole
  name: jit-cleanup
  apiGroup: rbac.authorization.k8s.io
```

## RBAC Testing in CI

Every RBAC change should be validated before it reaches production.

### Declarative Test File

```bash
#!/usr/bin/env bash
# test-rbac.sh
# Test RBAC permissions against a declarative test specification.
# Exit code 1 if any test fails.

set -euo pipefail

TESTS_FILE="${1:-rbac-tests.txt}"
PASS=0
FAIL=0

while IFS=' ' read -r expectation principal verb resource namespace; do
  [[ "${expectation:-}" == "#"* || -z "${expectation:-}" ]] && continue

  ns_flag=""
  [[ -n "${namespace:-}" ]] && ns_flag="--namespace=${namespace}"

  result=$(kubectl auth can-i "${verb}" "${resource}" \
    --as="${principal}" ${ns_flag} 2>/dev/null || echo "no")

  label="${principal} ${verb} ${resource} ${namespace:-cluster-wide}"

  if [[ "$expectation" == "allow" && "$result" == "yes" ]]; then
    echo "PASS [allow] ${label}"
    PASS=$((PASS + 1))
  elif [[ "$expectation" == "deny" && "$result" == "no" ]]; then
    echo "PASS [deny]  ${label}"
    PASS=$((PASS + 1))
  elif [[ "$expectation" == "allow" ]]; then
    echo "FAIL [allow] ${label} -- got: DENIED"
    FAIL=$((FAIL + 1))
  else
    echo "FAIL [deny]  ${label} -- got: ALLOWED"
    FAIL=$((FAIL + 1))
  fi
done < "${TESTS_FILE}"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
```

```
# rbac-tests.txt
# Format: <allow|deny> <principal> <verb> <resource> [namespace]

# order-service service account
allow  system:serviceaccount:production:order-service  get     deployments    production
allow  system:serviceaccount:production:order-service  list    configmaps     production
allow  system:serviceaccount:production:order-service  patch   deployments    production
deny   system:serviceaccount:production:order-service  delete  deployments    production
deny   system:serviceaccount:production:order-service  get     secrets        production
deny   system:serviceaccount:production:order-service  list    nodes
deny   system:serviceaccount:production:order-service  create  clusterroles

# CI deploy-bot
allow  system:serviceaccount:ci:deploy-bot  create  deployments    production
allow  system:serviceaccount:ci:deploy-bot  update  deployments    production
allow  system:serviceaccount:ci:deploy-bot  create  configmaps     production
deny   system:serviceaccount:ci:deploy-bot  create  clusterroles
deny   system:serviceaccount:ci:deploy-bot  get     secrets        kube-system
deny   system:serviceaccount:ci:deploy-bot  delete  namespaces

# Developer access
allow  jane.doe@example.com  get    pods         team-alpha
allow  jane.doe@example.com  list   deployments  team-alpha
allow  jane.doe@example.com  get    pods/log     team-alpha
deny   jane.doe@example.com  exec   pods         kube-system
deny   jane.doe@example.com  delete namespaces
deny   jane.doe@example.com  create clusterrolebindings
deny   jane.doe@example.com  get    secrets      kube-system
```

### CI Integration

```yaml
# .github/workflows/rbac-test.yaml
name: RBAC Tests
on:
  pull_request:
    paths:
      - "k8s/rbac/**"
      - "rbac-tests.txt"
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup kind cluster
        uses: helm/kind-action@v1.9.0
        with:
          cluster_name: rbac-test

      - name: Apply RBAC manifests
        run: |
          kubectl apply -f k8s/rbac/
          kubectl wait --for=condition=established crd/constraints.gatekeeper.sh --timeout=60s || true

      - name: Run RBAC tests
        run: |
          bash scripts/test-rbac.sh rbac-tests.txt
```

## Prometheus Alerts for RBAC Activity

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: rbac-security-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: rbac.security
      interval: 60s
      rules:
        - alert: ClusterAdminBindingCreated
          expr: |
            sum(increase(apiserver_audit_event_total{
              verb=~"create|update",
              objectRef_resource="clusterrolebindings",
              objectRef_name=~".*cluster-admin.*"
            }[5m])) > 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "cluster-admin ClusterRoleBinding created or modified"
            description: "Investigate immediately. Check audit logs for the creating user."
            runbook_url: "https://runbooks.example.com/rbac/cluster-admin"

        - alert: HighVolumeRBACChanges
          expr: |
            sum(increase(apiserver_audit_event_total{
              verb=~"create|update|delete|patch",
              objectRef_resource=~"roles|rolebindings|clusterroles|clusterrolebindings",
              objectRef_namespace="production"
            }[1h])) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Unusually high RBAC change volume in production"
            description: "{{ $value }} RBAC changes in production in the last hour."

        - alert: ServiceAccountSecretAccess
          expr: |
            sum by (user) (
              increase(apiserver_audit_event_total{
                verb=~"get|list",
                objectRef_resource="secrets",
                user=~"system:serviceaccount:.*"
              }[5m])
            ) > 50
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High secret access rate for service account {{ $labels.user }}"
            description: "{{ $value }} secret reads in 5 minutes by {{ $labels.user }}."

        - alert: WildcardRBACCreated
          expr: |
            sum(increase(apiserver_audit_event_total{
              verb=~"create|update",
              objectRef_resource=~"roles|clusterroles"
            }[5m])) > 0
          for: 0m
          labels:
            severity: info
          annotations:
            summary: "Role or ClusterRole created or modified"
            description: "Review the change to ensure no wildcard verbs were granted."
```

## Summary

Production Kubernetes RBAC at scale requires a systematic approach across four dimensions.

**Design**: ClusterRoles define capabilities; RoleBindings scope them per namespace. Aggregate ClusterRoles compose capabilities without forking definitions. Disable service account token automounting everywhere and use projected volumes with short expiry for workloads that genuinely need API access.

**Discovery**: Audit logs reveal what API calls a service account actually makes. The analysis script extracts a minimal permission set from the log, eliminating guesswork. Continuous audit event streaming catches privilege creep and sensitive resource access as it happens.

**Enforcement**: OPA Gatekeeper and Kyverno block over-privileged RBAC objects at admission time. Constraints against wildcard verbs, new cluster-admin bindings, missing ownership labels, and unapproved pod exec access prevent configuration drift before it reaches production.

**Lifecycle**: Weekly automated audits report violations with Slack notifications. CI tests validate every RBAC change with `kubectl auth can-i`. JIT bindings with 15-minute cleanup CronJobs ensure temporary access is revoked even if in-process timers fail.

Together these patterns give you a cluster where each principal has exactly the access it needs, every permission change is traceable through audit logs and labels, and violations are blocked or alerted before they create security incidents.
