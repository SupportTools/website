---
title: "Kubernetes ValidatingAdmissionPolicy (CEL-Based): Policy Rules, Namespace Selectors, Audit/Warn/Deny Modes"
date: 2032-01-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "CEL", "Admission Control", "Policy", "Kyverno", "OPA", "GitOps"]
categories:
- Kubernetes
- Security
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A production enterprise guide to Kubernetes ValidatingAdmissionPolicy with CEL expressions: writing policy rules, binding with namespace selectors, audit/warn/deny enforcement modes, and migration from webhook-based solutions."
more_link: "yes"
url: "/kubernetes-validating-admission-policy-cel-rules-namespace-selectors-modes/"
---

ValidatingAdmissionPolicy (VAP), introduced as stable in Kubernetes 1.30, is the native alternative to external admission webhook solutions like Kyverno and OPA Gatekeeper. Rather than routing admission decisions through an external HTTP webhook server—with its associated latency, availability requirements, and certificate management overhead—VAP embeds policy evaluation directly in the API server using the Common Expression Language (CEL). This guide covers CEL expression authoring for Kubernetes policy, namespace and resource selection, the three enforcement modes (Audit, Warn, Deny), integration with observability stacks, and a practical migration strategy from webhook-based solutions.

<!--more-->

# Kubernetes ValidatingAdmissionPolicy: CEL-Based Enterprise Policy

## Architecture and Design Principles

### How VAP Differs from Webhook-Based Admission

```
Traditional webhook flow:
API Server → HTTPS call → Admission webhook server (external) → Response
              ~5-50ms latency                                 (network + compute)

VAP flow:
API Server → CEL evaluation (in-process) → Admit/Deny
              ~0.1-1ms latency            (pure in-process)
```

Advantages of VAP:
- No external service to operate or scale
- No webhook certificates to rotate
- Evaluation happens before object persistence (same API Server request)
- CEL expressions are validated at policy creation time (syntax errors caught immediately)
- Native integration with Kubernetes audit logging

Limitations:
- CEL has no network access (cannot call external services)
- CEL has a computational cost limit (prevents infinite loops, but limits complex logic)
- Cannot mutate objects (MutatingAdmissionPolicy is separate)
- No webhook-style side effects

### API Objects

VAP uses two Kubernetes objects:

1. **ValidatingAdmissionPolicy**: defines the CEL rules and what they apply to
2. **ValidatingAdmissionPolicyBinding**: binds a policy to specific namespaces/resources

This separation allows reusing one policy definition across multiple binding scopes.

## Part 1: CEL Expression Language for Kubernetes

### CEL Basics in Policy Context

CEL (Common Expression Language) is a typed, side-effect-free expression language that evaluates to a boolean (for validation), string (for messages), or other types. In Kubernetes policies, the primary variables available in expressions are:

| Variable | Type | Description |
|----------|------|-------------|
| `object` | Object | The resource being created/updated/deleted |
| `oldObject` | Object | The previous state (for updates; null on create) |
| `request` | Object | The admission request (user, groups, dryRun) |
| `params` | Object | Parameters from the policy binding |
| `namespaceObject` | Object | The namespace object (for namespace-scoped resources) |
| `authorizer` | Authorizer | Check RBAC permissions of the requesting user |

### CEL Expression Examples

```cel
# Simple field validation
object.spec.replicas >= 1 && object.spec.replicas <= 10

# String operations
object.metadata.name.startsWith("prod-") || object.metadata.name.startsWith("staging-")

# Container image validation
object.spec.containers.all(c, c.image.contains("@sha256:"))

# Security context checks
object.spec.containers.all(c,
  has(c.securityContext) &&
  c.securityContext.runAsNonRoot == true)

# Resource limits required
object.spec.containers.all(c,
  has(c.resources) &&
  has(c.resources.limits) &&
  has(c.resources.limits.memory) &&
  has(c.resources.limits.cpu))

# Annotation presence
has(object.metadata.annotations) &&
"owner" in object.metadata.annotations &&
object.metadata.annotations["owner"] != ""

# Label selector
has(object.metadata.labels) &&
"app.kubernetes.io/name" in object.metadata.labels

# Check update: prevent label deletion
(oldObject == null) ||
object.metadata.labels.all(k, k in oldObject.metadata.labels)

# Quantity comparison (resource limits)
quantity(object.spec.containers[0].resources.limits.memory) <= quantity("4Gi")
```

## Part 2: Writing ValidatingAdmissionPolicy

### Minimal Policy Structure

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-resource-limits
spec:
  # Failure policy: Fail (default) or Ignore
  # Fail: admission is denied if CEL evaluation fails or errors
  # Ignore: pass admission if policy cannot be evaluated
  failurePolicy: Fail

  # Resource type to match
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]

  # CEL validation rules
  validations:
    - expression: >
        object.spec.containers.all(c,
          has(c.resources) &&
          has(c.resources.limits) &&
          has(c.resources.limits.memory) &&
          has(c.resources.limits.cpu)
        )
      message: "All containers must have CPU and memory limits defined."
      reason: Invalid
```

### Comprehensive Pod Security Policy

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: pod-security-baseline
  annotations:
    policies.example.com/description: "Enforces Pod Security Standards baseline profile"
    policies.example.com/category: "security"
spec:
  failurePolicy: Fail

  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]

  # Variables: reusable sub-expressions
  variables:
    - name: allContainers
      expression: >
        (has(object.spec.initContainers) ? object.spec.initContainers : []) +
        (has(object.spec.containers) ? object.spec.containers : []) +
        (has(object.spec.ephemeralContainers) ? object.spec.ephemeralContainers : [])

    - name: podSpec
      expression: >
        object.kind == "Pod" ? object.spec :
        object.spec.template.spec

  validations:
    # Rule 1: Prohibit privileged containers
    - expression: >
        variables.allContainers.all(c,
          !has(c.securityContext) ||
          !has(c.securityContext.privileged) ||
          c.securityContext.privileged == false
        )
      message: "Privileged containers are not permitted."
      reason: Forbidden

    # Rule 2: Prohibit hostNetwork
    - expression: >
        !has(variables.podSpec.hostNetwork) ||
        variables.podSpec.hostNetwork == false
      message: "hostNetwork is not permitted."
      reason: Forbidden

    # Rule 3: Prohibit hostPID
    - expression: >
        !has(variables.podSpec.hostPID) ||
        variables.podSpec.hostPID == false
      message: "hostPID is not permitted."
      reason: Forbidden

    # Rule 4: Prohibit hostPath volumes
    - expression: >
        !has(variables.podSpec.volumes) ||
        variables.podSpec.volumes.all(v, !has(v.hostPath))
      message: "hostPath volumes are not permitted."
      reason: Forbidden

    # Rule 5: Prohibit host port exposure
    - expression: >
        variables.allContainers.all(c,
          !has(c.ports) ||
          c.ports.all(p,
            !has(p.hostPort) || p.hostPort == 0
          )
        )
      message: "Containers must not expose host ports."
      reason: Forbidden

    # Rule 6: Prohibit dangerous capabilities
    - expression: >
        variables.allContainers.all(c,
          !has(c.securityContext) ||
          !has(c.securityContext.capabilities) ||
          !has(c.securityContext.capabilities.add) ||
          c.securityContext.capabilities.add.all(cap,
            cap != "NET_ADMIN" &&
            cap != "SYS_ADMIN" &&
            cap != "SYS_PTRACE" &&
            cap != "SYS_CHROOT" &&
            cap != "DAC_OVERRIDE" &&
            cap != "SETUID" &&
            cap != "SETGID"
          )
        )
      message: "Containers must not add dangerous capabilities."
      reason: Forbidden

    # Rule 7: Require non-root
    - expression: >
        variables.allContainers.all(c,
          (has(c.securityContext) && has(c.securityContext.runAsNonRoot) &&
           c.securityContext.runAsNonRoot == true) ||
          (has(variables.podSpec.securityContext) &&
           has(variables.podSpec.securityContext.runAsNonRoot) &&
           variables.podSpec.securityContext.runAsNonRoot == true)
        )
      message: "Containers must run as non-root."
      reason: Forbidden

    # Rule 8: Require readOnlyRootFilesystem
    - expression: >
        variables.allContainers.all(c,
          has(c.securityContext) &&
          has(c.securityContext.readOnlyRootFilesystem) &&
          c.securityContext.readOnlyRootFilesystem == true
        )
      message: "Containers must use a read-only root filesystem."
      reason: Forbidden

    # Rule 9: Prohibit allowPrivilegeEscalation
    - expression: >
        variables.allContainers.all(c,
          !has(c.securityContext) ||
          !has(c.securityContext.allowPrivilegeEscalation) ||
          c.securityContext.allowPrivilegeEscalation == false
        )
      message: "Containers must not allow privilege escalation."
      reason: Forbidden
```

### Policy with Parameters

Parameters allow reusing a policy with different configuration per binding:

```yaml
# Define the parameter schema (optional but recommended)
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: replicas-range
spec:
  failurePolicy: Fail

  # Reference a parameter CRD
  paramKind:
    apiVersion: policy.example.com/v1
    kind: ReplicasPolicy

  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]

  validations:
    - expression: >
        object.spec.replicas >= params.spec.minReplicas &&
        object.spec.replicas <= params.spec.maxReplicas
      messageExpression: >
        "Deployment replicas (" + string(object.spec.replicas) + ") must be between " +
        string(params.spec.minReplicas) + " and " + string(params.spec.maxReplicas)
      reason: Invalid
```

```yaml
# Parameter CRD
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: replicaspolicies.policy.example.com
spec:
  group: policy.example.com
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [minReplicas, maxReplicas]
              properties:
                minReplicas:
                  type: integer
                  minimum: 1
                maxReplicas:
                  type: integer
                  maximum: 100
  scope: Namespaced
  names:
    plural: replicaspolicies
    singular: replicaspolicy
    kind: ReplicasPolicy
```

```yaml
# Parameter instance
apiVersion: policy.example.com/v1
kind: ReplicasPolicy
metadata:
  name: production-replicas
  namespace: production
spec:
  minReplicas: 2
  maxReplicas: 20
```

## Part 3: ValidatingAdmissionPolicyBinding

### Basic Binding

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: pod-security-baseline-production
spec:
  # Reference the policy
  policyName: pod-security-baseline

  # Enforcement action
  validationActions: [Deny]

  # Scope: which resources does this binding apply to?
  matchResources:
    # Namespace selector: apply to namespaces with this label
    namespaceSelector:
      matchLabels:
        environment: production

    # Object selector: apply to objects with this label
    objectSelector:
      matchExpressions:
        - key: security-policy-exempt
          operator: DoesNotExist

    # Exclude specific namespaces
    excludeResourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
        resourceNames: ["kube-proxy"]
```

### Namespace Selector Patterns

```yaml
# Pattern 1: Apply to all non-system namespaces
matchResources:
  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values:
          - kube-system
          - kube-public
          - kube-node-lease
          - cert-manager
          - monitoring

# Pattern 2: Apply to namespaces with specific label
matchResources:
  namespaceSelector:
    matchLabels:
      policy-profile: restricted

# Pattern 3: Apply to production and staging
matchResources:
  namespaceSelector:
    matchExpressions:
      - key: environment
        operator: In
        values: [production, staging]

# Pattern 4: Apply everywhere except exempted namespaces
matchResources:
  namespaceSelector:
    matchExpressions:
      - key: policy-exempt
        operator: DoesNotExist
```

### Replicas Policy Binding with Parameters

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: replicas-production
spec:
  policyName: replicas-range
  paramRef:
    name: production-replicas
    namespace: production
    parameterNotFoundAction: Deny  # Deny if parameter object not found
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: production
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: replicas-staging
spec:
  policyName: replicas-range
  paramRef:
    name: staging-replicas
    namespace: staging
    parameterNotFoundAction: Warn
  validationActions: [Warn]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: staging
```

## Part 4: Audit, Warn, and Deny Modes

### Understanding the Three Modes

| Mode | Effect | Audit Log | User Feedback | Object Created? |
|------|--------|-----------|---------------|-----------------|
| `Deny` | Rejects the request | Yes | Error message returned | No |
| `Warn` | Passes but warns | No | Warning header in response | Yes |
| `Audit` | Passes, logs annotation | Yes (annotation) | None | Yes |

### Audit Mode

Audit mode does not block requests but adds an annotation to the audit log entry:

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-labels-audit
spec:
  policyName: require-standard-labels
  validationActions: [Audit]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: development
```

Audit log entry when policy evaluates to false:

```json
{
  "kind": "Event",
  "apiVersion": "audit.k8s.io/v1",
  "verb": "create",
  "objectRef": {
    "resource": "deployments",
    "namespace": "dev",
    "name": "my-app"
  },
  "annotations": {
    "validation.policy.admission.k8s.io/validation_failure": "[{\"message\":\"Deployment must have app.kubernetes.io/name label\",\"policy\":\"require-standard-labels\",\"binding\":\"require-labels-audit\",\"expressionIndex\":0,\"validationActions\":[\"Audit\"]}]"
  }
}
```

### Warn Mode

Warn mode passes the request but includes a `Warning` header in the HTTP response. kubectl surfaces these warnings automatically:

```yaml
validationActions: [Warn]
```

```bash
# User sees warning but object is created:
kubectl apply -f deployment.yaml
# Warning: Deployment missing standard labels: app.kubernetes.io/name
# deployment.apps/my-app created
```

### Deny Mode

Deny mode rejects the admission request:

```bash
kubectl apply -f deployment.yaml
# Error from server: error when creating "deployment.yaml":
# admission webhook "validate.example.com" denied the request:
# [pod-security-baseline] Containers must run as non-root.
# [pod-security-baseline] Containers must not allow privilege escalation.
```

### Progressive Rollout Strategy

The recommended production rollout sequence:

```yaml
# Phase 1: Audit only (discovery)
# Deploy policy with Audit mode across all namespaces
# Run for 1-2 weeks to discover violations

# Phase 2: Warn in new namespaces
# New namespaces get Warn mode
# Existing namespaces remain Audit

# Phase 3: Warn in all non-production
# After teams have had time to fix violations

# Phase 4: Deny in production
# Full enforcement for production workloads

# Phase 5: Deny everywhere
# Complete enforcement

---
# Binding per phase:
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: pod-security-phase1-audit
spec:
  policyName: pod-security-baseline
  validationActions: [Audit]
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values: [kube-system, kube-public]
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: pod-security-production-deny
spec:
  policyName: pod-security-baseline
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: production
```

## Part 5: Advanced CEL Patterns

### Cross-Field Validation

```yaml
validations:
  # Ensure HPA max >= min replicas when both set
  - expression: >
      !has(object.spec.replicas) ||
      !has(object.metadata.annotations) ||
      !("autoscaling.alpha.kubernetes.io/max-replicas" in object.metadata.annotations) ||
      int(object.metadata.annotations["autoscaling.alpha.kubernetes.io/max-replicas"]) >=
        object.spec.replicas
    message: "HPA max-replicas annotation must be >= spec.replicas"

  # Validate label is consistent with namespace
  - expression: >
      !has(object.metadata.labels) ||
      !("environment" in object.metadata.labels) ||
      object.metadata.labels["environment"] == namespaceObject.metadata.labels["environment"]
    message: "The 'environment' label must match the namespace's environment label."
```

### Image Policy with CEL

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: image-policy
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets", "daemonsets"]

  variables:
    - name: allContainers
      expression: >
        (has(object.spec.containers) ? object.spec.containers : []) +
        (has(object.spec.initContainers) ? object.spec.initContainers : [])

  validations:
    # Must use approved registries
    - expression: >
        variables.allContainers.all(c,
          c.image.startsWith("registry.example.com/") ||
          c.image.startsWith("registry.k8s.io/") ||
          c.image.startsWith("gcr.io/google_containers/") ||
          c.image.startsWith("quay.io/")
        )
      message: "Images must be pulled from approved registries (registry.example.com, registry.k8s.io, gcr.io/google_containers, quay.io)."
      reason: Forbidden

    # Must be pinned by digest in production
    - expression: >
        namespaceObject.metadata.labels["environment"] != "production" ||
        variables.allContainers.all(c, c.image.contains("@sha256:"))
      message: "Production deployments must use digest-pinned images."
      reason: Forbidden

    # Prohibit 'latest' tag
    - expression: >
        variables.allContainers.all(c,
          !c.image.endsWith(":latest") &&
          !(c.image.lastIndexOf(":") == -1)
        )
      message: "Images must not use the 'latest' tag. Specify an explicit version tag or digest."
      reason: Forbidden
```

### User and Group-Based Policies

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: restrict-privileged-namespace-operations
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE", "DELETE"]
        resources: ["namespaces"]

  validations:
    # Only allow users in the platform-admin group to manage namespaces
    - expression: >
        request.userInfo.groups.exists(g, g == "system:masters") ||
        request.userInfo.groups.exists(g, g == "platform-admins")
      message: "Only platform-admins can manage namespaces."
      reason: Forbidden

    # Prevent deletion of system namespaces by non-cluster-admins
    - expression: >
        request.operation != "DELETE" ||
        !(object.metadata.name in ["kube-system", "kube-public", "monitoring", "cert-manager"]) ||
        request.userInfo.groups.exists(g, g == "system:masters")
      message: "System namespaces cannot be deleted except by cluster admins."
      reason: Forbidden
```

### Update-Specific Rules

```yaml
validations:
  # Prevent changing the storage class after creation
  - expression: >
      request.operation == "CREATE" ||
      !has(object.spec.storageClassName) ||
      !has(oldObject.spec.storageClassName) ||
      object.spec.storageClassName == oldObject.spec.storageClassName
    message: "storageClassName is immutable after creation."
    reason: Invalid

  # Prevent reducing replicas in production by more than 50%
  - expression: >
      request.operation == "CREATE" ||
      namespaceObject.metadata.labels["environment"] != "production" ||
      object.spec.replicas >= oldObject.spec.replicas / 2
    message: "Cannot reduce production replicas by more than 50% in a single update."
    reason: Invalid

  # Prevent label deletion (only additions allowed)
  - expression: >
      request.operation == "CREATE" ||
      oldObject.metadata.labels.all(k, k in object.metadata.labels)
    message: "Labels cannot be removed from existing resources."
    reason: Invalid
```

## Part 6: Observability Integration

### Monitoring VAP with Prometheus

```bash
# VAP metrics exposed by kube-apiserver
# View in Prometheus:
apiserver_admission_webhook_rejection_count        # For webhooks (not VAP)
apiserver_admission_step_admission_duration_seconds # Overall admission latency

# Check audit logs for VAP denials
kubectl logs -n kube-system kube-apiserver-* | \
    grep -i "validation_failure"
```

### Audit Policy for VAP Events

```yaml
# kube-apiserver audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Capture all admission failures at RequestResponse level
  - level: RequestResponse
    verbs: ["create", "update", "patch"]
    omitStages:
      - RequestReceived
    # Only log requests that resulted in policy violations
    # (policy annotation present in response)
```

```bash
# Parse audit log for VAP denials
jq -r 'select(.annotations["validation.policy.admission.k8s.io/validation_failure"] != null) |
  {
    time: .requestReceivedTimestamp,
    user: .user.username,
    namespace: .objectRef.namespace,
    resource: .objectRef.resource,
    name: .objectRef.name,
    policy_failure: .annotations["validation.policy.admission.k8s.io/validation_failure"]
  }' /var/log/kubernetes/audit.log | head -20
```

### Grafana Dashboard for Policy Violations

```promql
# Rate of admission rejections (all admission plugins)
rate(apiserver_admission_step_admission_duration_seconds_count{
  type="validating",
  rejected="true"
}[5m])

# Latency distribution for CEL evaluation
histogram_quantile(0.99,
  rate(apiserver_admission_step_admission_duration_seconds_bucket{
    type="validating"
  }[5m])
)
```

## Part 7: Migration from Webhook-Based Solutions

### Kyverno Policy to VAP Mapping

```yaml
# Kyverno ClusterPolicy (before)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-labels
spec:
  validationFailureAction: enforce
  rules:
    - name: check-for-labels
      match:
        any:
          - resources:
              kinds: ["Deployment"]
      validate:
        message: "The label 'app.kubernetes.io/name' is required."
        pattern:
          metadata:
            labels:
              app.kubernetes.io/name: "?*"
```

```yaml
# Equivalent ValidatingAdmissionPolicy (after)
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-labels
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
  validations:
    - expression: >
        has(object.metadata.labels) &&
        "app.kubernetes.io/name" in object.metadata.labels &&
        object.metadata.labels["app.kubernetes.io/name"] != ""
      message: "The label 'app.kubernetes.io/name' is required."
      reason: Invalid
```

### Testing Policies Before Enforcement

```bash
# Test a policy against a resource without creating it
# Use kubectl --dry-run=server to trigger admission without persistence

kubectl apply --dry-run=server -f - << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
  namespace: production
spec:
  replicas: 1
  selector:
    matchLabels:
      app: test
  template:
    metadata:
      labels:
        app: test
    spec:
      containers:
        - name: test
          image: nginx:latest
          securityContext:
            privileged: true
EOF
# Error from server: admission webhook denied: [pod-security-baseline]
#   Containers must run as non-root.
#   Containers must not allow privilege escalation.
#   Privileged containers are not permitted.
```

### Policy Test Suite

```bash
#!/bin/bash
# test-policies.sh — validate policies against test cases

set -euo pipefail

POLICY_DIR="./policies"
TEST_DIR="./tests"
FAILED=0
PASSED=0

for test_file in "${TEST_DIR}"/*.yaml; do
    test_name=$(basename "$test_file" .yaml)
    expected=$(yq '.expected' "$test_file")  # "pass" or "fail"

    resource=$(yq '.resource' "$test_file")

    if [[ "$expected" == "fail" ]]; then
        if kubectl apply --dry-run=server -f - <<< "$resource" 2>/dev/null; then
            echo "FAIL: $test_name — expected admission denial but got pass"
            FAILED=$((FAILED + 1))
        else
            echo "PASS: $test_name — correctly denied"
            PASSED=$((PASSED + 1))
        fi
    else
        if kubectl apply --dry-run=server -f - <<< "$resource" 2>/dev/null; then
            echo "PASS: $test_name — correctly admitted"
            PASSED=$((PASSED + 1))
        else
            echo "FAIL: $test_name — expected admission pass but got denial"
            FAILED=$((FAILED + 1))
        fi
    fi
done

echo ""
echo "Results: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
```

## Summary

Kubernetes ValidatingAdmissionPolicy with CEL represents a significant maturation of the Kubernetes policy ecosystem:

1. **CEL expressions** provide a safe, typed, evaluation-cost-limited language that catches syntax errors at policy creation time and evaluates in microseconds without network calls.

2. **Policy/Binding separation** enables reusing a single policy definition across multiple namespaces with different parameter values and enforcement modes.

3. **Audit mode** enables safe discovery of violations before enforcement—critical for migration from permissive environments.

4. **Warn mode** provides user feedback without blocking deployments, enabling teams to fix violations on their own schedule.

5. **Deny mode** enforces hard requirements with precise error messages tied to the specific CEL expression that failed.

6. The progressive rollout pattern (Audit → Warn → Deny) combined with namespace selector scoping enables organizations to adopt strict policies incrementally without disrupting existing workloads.

For organizations running Kyverno or OPA Gatekeeper, VAP is not an immediate replacement for complex policy logic (CEL cannot call external services), but it covers the majority of structural validation use cases with significantly lower operational overhead.
