---
title: "Kubernetes Dynamic Admission Control: CEL Validation and ValidatingAdmissionPolicy"
date: 2029-07-31T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Admission Control", "CEL", "ValidatingAdmissionPolicy", "OPA", "Security", "Policy"]
categories: ["Kubernetes", "Security", "Policy"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes ValidatingAdmissionPolicy using CEL expressions: policy bindings, parameterized policies, migration from webhooks, and production-ready patterns for enterprise security enforcement."
more_link: "yes"
url: "/kubernetes-dynamic-admission-control-cel-validation-validatingadmissionpolicy/"
---

Kubernetes 1.28 promoted ValidatingAdmissionPolicy to beta, and 1.30 made it generally available. This native admission policy mechanism uses the Common Expression Language (CEL) to evaluate resource configurations at admission time, without requiring an external webhook server. For teams running OPA Gatekeeper or Kyverno solely for basic validation, ValidatingAdmissionPolicy offers a path to eliminate the external dependency and reduce policy evaluation latency from 10-50ms (webhook roundtrip) to under 1ms (in-process CEL evaluation). This guide covers everything from CEL syntax to parameterized policies to production migration strategies.

<!--more-->

# Kubernetes Dynamic Admission Control: CEL Validation and ValidatingAdmissionPolicy

## Why ValidatingAdmissionPolicy Over Webhooks

Traditional admission webhooks have several operational drawbacks:
- **Availability dependency**: If your webhook server is down, all matching resource creations fail (unless the webhook is configured as fail-open, which defeats the purpose)
- **Latency addition**: Every matching API request waits for a network roundtrip to the webhook server, typically adding 10-50ms
- **Operational complexity**: The webhook server is itself a Kubernetes workload that must be deployed, scaled, and maintained
- **Certificate management**: Webhooks require TLS certificates, adding a PKI management burden

ValidatingAdmissionPolicy solves all of these: it runs in-process in the API server, adds negligible latency, requires no external infrastructure, and has no availability dependency.

The trade-offs are expressiveness (CEL is less powerful than Rego or Python) and ecosystem (Gatekeeper and Kyverno have larger policy libraries). For standard validation patterns, CEL is sufficient.

## CEL Expression Language Fundamentals

CEL is a non-Turing-complete expression language designed to be safe, fast, and embeddable. It has no loops, no side effects, and no I/O — properties that make it safe to run untrusted expressions in the API server.

### CEL Syntax in Kubernetes Context

In Kubernetes CEL expressions:
- `object` refers to the resource being evaluated
- `oldObject` refers to the existing resource (for updates)
- `request` contains request metadata (user, groups, etc.)
- `params` contains the bound parameter object (for parameterized policies)
- `authorizer` provides authorization checks

```cel
# Basic field access
object.spec.replicas > 0

# String operations
object.metadata.name.startsWith("production-")

# List operations
object.spec.containers.all(c, c.resources.limits != null)

# Map operations
"app.kubernetes.io/name" in object.metadata.labels

# Conditional
object.spec.type == "LoadBalancer" ?
  object.spec.loadBalancerClass != "" :
  true

# Regular expressions
object.metadata.name.matches("^[a-z][a-z0-9-]{1,52}[a-z0-9]$")

# Null-safe navigation
object.spec.?securityContext.?runAsNonRoot.orValue(false)

# Quantity comparison (Kubernetes-specific extension)
object.spec.containers.all(c,
  c.resources.?limits.?memory.orValue("0").quantity() <
  quantity("1Gi")
)
```

### CEL Built-in Functions for Kubernetes

```cel
# Duration parsing
object.spec.?activeDeadlineSeconds.orValue(0) < duration("1h").getSeconds()

# URL parsing
url(object.spec.?externalURL.orValue("https://localhost")).getScheme() == "https"

# IP address validation (Kubernetes 1.30+)
isIP(object.spec.clusterIP)
cidr("10.0.0.0/8").containsIP(object.spec.clusterIP)

# Quantity arithmetic
object.spec.containers.sum(c, c.resources.limits.cpu.quantity()).compareTo(quantity("32")) <= 0
```

## Your First ValidatingAdmissionPolicy

### Enforcing Resource Limits

```yaml
# policies/require-resource-limits.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-resource-limits
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets", "daemonsets"]

  validations:
    - expression: |
        object.spec.template.spec.containers.all(c,
          c.?resources.?limits.?memory.hasValue() &&
          c.?resources.?limits.?cpu.hasValue()
        )
      message: "All containers must have memory and CPU limits set"
      reason: Invalid

    - expression: |
        object.spec.template.spec.?initContainers.orValue([]).all(c,
          c.?resources.?limits.?memory.hasValue() &&
          c.?resources.?limits.?cpu.hasValue()
        )
      message: "All init containers must have memory and CPU limits set"
      reason: Invalid

    - expression: |
        object.spec.template.spec.containers.all(c,
          c.resources.limits.memory.quantity() <= quantity("8Gi")
        )
      message: "Container memory limit cannot exceed 8Gi"
      reason: Invalid

  auditAnnotations:
    - key: "policy/require-resource-limits"
      valueExpression: |
        "Validated at " + string(request.requestReceivedTimestamp)
```

```yaml
# policies/require-resource-limits-binding.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-resource-limits-binding
spec:
  policyName: require-resource-limits
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
        - key: "policy.company.com/enforce-limits"
          operator: Exists
    excludeResourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]
        resourceNames: ["kube-system-exempt"]
```

### Testing the Policy

```bash
# Apply the policy and binding
kubectl apply -f policies/require-resource-limits.yaml
kubectl apply -f policies/require-resource-limits-binding.yaml

# Label a namespace for enforcement
kubectl label namespace production policy.company.com/enforce-limits=""

# Test with a deployment missing limits
cat <<EOF | kubectl apply -n production -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-no-limits
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
        - name: nginx
          image: nginx:1.25
          # No resources specified
EOF

# Expected output:
# Error from server (Invalid): error when creating "STDIN":
# Deployment.apps "test-no-limits" is invalid:
# []: Invalid value: "object": All containers must have memory and CPU limits set

# Test dry-run mode
cat <<EOF | kubectl apply -n production --dry-run=server -f -
apiVersion: apps/v1
kind: Deployment
...
EOF
```

## Parameterized Policies

Parameterized policies allow you to create a single policy template and configure it differently for different namespaces or teams using a parameter object.

### Policy with CRD Parameters

```yaml
# parameters/image-policy-params-crd.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: imagepolicies.policy.company.com
spec:
  group: policy.company.com
  names:
    kind: ImagePolicy
    plural: imagepolicies
    singular: imagepolicy
  scope: Cluster
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
              properties:
                allowedRegistries:
                  type: array
                  items:
                    type: string
                requireDigest:
                  type: boolean
                  default: false
                bannedTags:
                  type: array
                  items:
                    type: string
                  default: ["latest", "dev", "test"]
```

```yaml
# parameters/production-image-policy.yaml
apiVersion: policy.company.com/v1
kind: ImagePolicy
metadata:
  name: production-policy
spec:
  allowedRegistries:
    - "gcr.io/company/"
    - "registry.company.com/"
    - "docker.io/company/"
  requireDigest: true
  bannedTags:
    - "latest"
    - "dev"
    - "test"
    - "snapshot"
---
# parameters/staging-image-policy.yaml
apiVersion: policy.company.com/v1
kind: ImagePolicy
metadata:
  name: staging-policy
spec:
  allowedRegistries:
    - "gcr.io/company/"
    - "registry.company.com/"
    - "docker.io/company/"
    - "docker.io/library/"  # Allow official images in staging
  requireDigest: false
  bannedTags:
    - "latest"
```

```yaml
# policies/image-policy.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: image-policy
spec:
  failurePolicy: Fail
  paramKind:
    apiVersion: policy.company.com/v1
    kind: ImagePolicy
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets", "daemonsets"]
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]

  variables:
    - name: containers
      expression: |
        object.spec.template.spec.containers +
        object.spec.template.spec.?initContainers.orValue([])

  validations:
    - expression: |
        variables.containers.all(c,
          params.spec.allowedRegistries.exists(reg,
            c.image.startsWith(reg)
          )
        )
      messageExpression: |
        "Container uses disallowed registry. Allowed: " +
        params.spec.allowedRegistries.join(", ")
      reason: Forbidden

    - expression: |
        !params.spec.requireDigest ||
        variables.containers.all(c,
          c.image.contains("@sha256:")
        )
      message: "Image digest required. Use image@sha256:<digest> format."
      reason: Forbidden

    - expression: |
        variables.containers.all(c,
          !params.spec.bannedTags.exists(tag,
            c.image.endsWith(":" + tag)
          )
        )
      messageExpression: |
        "Image uses a banned tag. Banned tags: " +
        params.spec.bannedTags.join(", ")
      reason: Forbidden

  auditAnnotations:
    - key: "policy/image-check"
      valueExpression: |
        "ImagePolicy/" + params.metadata.name + " applied"
```

```yaml
# bindings/production-image-binding.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: image-policy-production
spec:
  policyName: image-policy
  paramRef:
    name: production-policy
    namespace: ""  # Cluster-scoped param
    parameterNotFoundAction: Deny  # Deny if param object doesn't exist
  validationActions: [Deny, Audit]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: production
---
# bindings/staging-image-binding.yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: image-policy-staging
spec:
  policyName: image-policy
  paramRef:
    name: staging-policy
    namespace: ""
    parameterNotFoundAction: Deny
  validationActions: [Deny, Audit]
  matchResources:
    namespaceSelector:
      matchLabels:
        environment: staging
```

## Advanced CEL Patterns

### Security Context Enforcement

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: pod-security-standards
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets", "daemonsets"]

  variables:
    - name: allContainers
      expression: |
        object.spec.template.spec.containers +
        object.spec.template.spec.?initContainers.orValue([])
    - name: podSpec
      expression: object.spec.template.spec

  validations:
    # No privileged containers
    - expression: |
        variables.allContainers.all(c,
          !c.?securityContext.?privileged.orValue(false)
        )
      message: "Privileged containers are not allowed"

    # No hostPID, hostIPC, hostNetwork
    - expression: |
        !variables.podSpec.?hostPID.orValue(false) &&
        !variables.podSpec.?hostIPC.orValue(false) &&
        !variables.podSpec.?hostNetwork.orValue(false)
      message: "hostPID, hostIPC, and hostNetwork are not allowed"

    # No privilege escalation
    - expression: |
        variables.allContainers.all(c,
          c.?securityContext.?allowPrivilegeEscalation.orValue(true) == false
        )
      message: "allowPrivilegeEscalation must be set to false"

    # Must run as non-root
    - expression: |
        variables.podSpec.?securityContext.?runAsNonRoot.orValue(false) == true ||
        variables.allContainers.all(c,
          c.?securityContext.?runAsUser.orValue(0) != 0
        )
      message: "Containers must run as non-root user"

    # Drop capabilities
    - expression: |
        variables.allContainers.all(c,
          c.?securityContext.?capabilities.?drop.orValue([]).exists(cap, cap == "ALL")
        )
      message: "Containers must drop ALL capabilities"

    # No host path volumes
    - expression: |
        variables.podSpec.?volumes.orValue([]).all(v,
          !has(v.hostPath)
        )
      message: "hostPath volumes are not allowed"

    # Seccomp profile required
    - expression: |
        variables.podSpec.?securityContext.?seccompProfile.?type.orValue("") == "RuntimeDefault" ||
        variables.podSpec.?securityContext.?seccompProfile.?type.orValue("") == "Localhost"
      message: "Seccomp profile must be RuntimeDefault or Localhost"
```

### Quota and Cost Control

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: deployment-cost-limits
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments"]

  validations:
    # Maximum replicas per deployment
    - expression: object.spec.replicas <= 50
      message: "Deployments may not have more than 50 replicas without platform team approval"
      reason: Forbidden

    # Maximum total CPU per deployment
    - expression: |
        int(object.spec.replicas) *
        object.spec.template.spec.containers.sum(c,
          c.?resources.?requests.?cpu.orValue("0").quantity().compareTo(quantity("100m"))
        ) <= quantity("200").compareTo(quantity("100m"))
      message: "Total CPU (replicas * per-pod CPU) cannot exceed 200 CPU cores"

    # Require disruption budget for large deployments
    - expression: |
        object.spec.replicas < 5 ||
        object.metadata.?annotations["policy.company.com/pdb-exempt"].orValue("false") == "true"
      message: "Deployments with 5+ replicas must have a PodDisruptionBudget. Add annotation policy.company.com/pdb-exempt=true to bypass."
      reason: Forbidden
```

### Immutability Enforcement on Updates

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: immutable-fields
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["UPDATE"]
        resources: ["deployments"]

  validations:
    # Namespace is immutable
    - expression: object.metadata.namespace == oldObject.metadata.namespace
      message: "Deployment namespace cannot be changed"

    # Application label is immutable
    - expression: |
        object.metadata.labels["app.kubernetes.io/name"] ==
        oldObject.metadata.labels["app.kubernetes.io/name"]
      message: "app.kubernetes.io/name label is immutable after creation"

    # Cannot change from stateful to stateless
    - expression: |
        !has(oldObject.spec.template.spec.volumes) ||
        object.spec.template.spec.?volumes.orValue([]).size() > 0 ==
        oldObject.spec.template.spec.?volumes.orValue([]).size() > 0
      message: "Cannot add or remove persistent volumes from an existing Deployment"
```

## Validation Actions: Deny, Warn, and Audit

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: resource-limits-audit-only
spec:
  policyName: require-resource-limits
  validationActions:
    # Deny: Reject the request with an error
    # Warn: Allow but include a warning in the response
    # Audit: Allow but log to the audit log with annotation

    # Rollout strategy: Start with Warn, then move to Deny
    - Warn
    - Audit
  matchResources:
    namespaceSelector:
      matchLabels:
        policy.company.com/mode: warn
```

```bash
# When using Warn mode, kubectl shows warnings:
kubectl apply -f deployment-without-limits.yaml
# Warning: All containers must have memory and CPU limits set
# deployment.apps/my-app created

# The object is created but the warning is logged
# Check audit log for Audit mode entries:
kubectl get events --field-selector reason=FailedAdmission
```

## Migration from Webhooks

### Audit Mode Migration Strategy

```yaml
# Step 1: Deploy policy in Audit-only mode
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-resource-limits-audit
spec:
  policyName: require-resource-limits
  validationActions: [Audit]  # Audit only - no denials
  matchResources:
    namespaceSelector: {}  # All namespaces

# Monitor audit log for violations for 2 weeks
# Fix violations
# Then switch to Warn mode for 1 week
# Then switch to Deny mode
```

```python
#!/usr/bin/env python3
# analyze-policy-violations.py

import subprocess
import json
from collections import defaultdict
from datetime import datetime, timedelta

def get_audit_events(hours: int = 24) -> list:
    """Fetch audit events with policy violation annotations."""
    since = (datetime.utcnow() - timedelta(hours=hours)).isoformat() + "Z"

    result = subprocess.run(
        ["kubectl", "get", "--raw",
         f"/api/v1/namespaces/kube-system/events?fieldSelector=reason=AdmissionViolation&since={since}"],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        return []

    events = json.loads(result.stdout)
    return events.get("items", [])

def analyze_violations(events: list) -> dict:
    """Analyze violation patterns by namespace and workload."""
    by_namespace = defaultdict(list)
    by_policy = defaultdict(list)

    for event in events:
        ns = event.get("involvedObject", {}).get("namespace", "unknown")
        name = event.get("involvedObject", {}).get("name", "unknown")
        message = event.get("message", "")

        # Extract policy name from annotation
        annotations = event.get("metadata", {}).get("annotations", {})
        policy = annotations.get("policy-name", "unknown")

        by_namespace[ns].append({"name": name, "message": message})
        by_policy[policy].append({"namespace": ns, "name": name})

    return {"by_namespace": dict(by_namespace), "by_policy": dict(by_policy)}

def print_migration_report(violations: dict) -> None:
    print("=== Policy Migration Readiness Report ===\n")

    print("Violations by policy:")
    for policy, items in violations["by_policy"].items():
        print(f"  {policy}: {len(items)} violations")
        namespaces = set(i["namespace"] for i in items)
        print(f"    Namespaces affected: {', '.join(sorted(namespaces))}")

    print("\nViolations by namespace:")
    for ns, items in violations["by_namespace"].items():
        print(f"  {ns}: {len(items)} violations")

    total = sum(len(v) for v in violations["by_namespace"].values())
    if total == 0:
        print("\n✓ No violations found. Safe to switch to Deny mode.")
    else:
        print(f"\n✗ {total} violations must be resolved before switching to Deny mode.")

if __name__ == "__main__":
    events = get_audit_events(24 * 7)  # Last 7 days
    violations = analyze_violations(events)
    print_migration_report(violations)
```

### Gatekeeper to ValidatingAdmissionPolicy Migration

```yaml
# Before: OPA Gatekeeper ConstraintTemplate
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireresourcelimits
spec:
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requireresourcelimits
        violation[{"msg": msg}] {
          container := input.review.object.spec.template.spec.containers[_]
          not container.resources.limits.memory
          msg := sprintf("Container '%v' missing memory limit", [container.name])
        }

# After: ValidatingAdmissionPolicy
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: requireresourcelimits
spec:
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["deployments", "statefulsets", "daemonsets"]
  validations:
    - expression: |
        object.spec.template.spec.containers.all(c,
          c.?resources.?limits.?memory.hasValue()
        )
      messageExpression: |
        "Containers missing memory limit: " +
        object.spec.template.spec.containers
          .filter(c, !c.?resources.?limits.?memory.hasValue())
          .map(c, c.name)
          .join(", ")
```

## Policy Testing with cel-go

```go
// policy_test.go
package policy_test

import (
    "testing"

    "github.com/google/cel-go/cel"
    "github.com/google/cel-go/checker/decls"
)

func TestResourceLimitPolicy(t *testing.T) {
    env, err := cel.NewEnv(
        cel.Declarations(
            decls.NewVar("object", decls.Dyn),
        ),
    )
    if err != nil {
        t.Fatal(err)
    }

    expression := `
        object.spec.template.spec.containers.all(c,
            c.resources.limits != null &&
            c.resources.limits.memory != null &&
            c.resources.limits.cpu != null
        )
    `

    ast, iss := env.Compile(expression)
    if iss.Err() != nil {
        t.Fatal(iss.Err())
    }

    prg, err := env.Program(ast)
    if err != nil {
        t.Fatal(err)
    }

    tests := []struct {
        name     string
        object   map[string]interface{}
        wantPass bool
    }{
        {
            name: "all containers have limits",
            object: map[string]interface{}{
                "spec": map[string]interface{}{
                    "template": map[string]interface{}{
                        "spec": map[string]interface{}{
                            "containers": []interface{}{
                                map[string]interface{}{
                                    "name": "app",
                                    "resources": map[string]interface{}{
                                        "limits": map[string]interface{}{
                                            "memory": "512Mi",
                                            "cpu":    "500m",
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            wantPass: true,
        },
        {
            name: "container missing memory limit",
            object: map[string]interface{}{
                "spec": map[string]interface{}{
                    "template": map[string]interface{}{
                        "spec": map[string]interface{}{
                            "containers": []interface{}{
                                map[string]interface{}{
                                    "name": "app",
                                    "resources": map[string]interface{}{
                                        "limits": map[string]interface{}{
                                            "cpu": "500m",
                                            // memory is missing
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            wantPass: false,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            out, _, err := prg.Eval(map[string]interface{}{
                "object": tt.object,
            })
            if err != nil {
                t.Fatalf("eval error: %v", err)
            }
            got := out.Value().(bool)
            if got != tt.wantPass {
                t.Errorf("policy evaluation = %v, want %v", got, tt.wantPass)
            }
        })
    }
}
```

## Monitoring Policy Enforcement

```yaml
# prometheus-rules/admission-policy-alerts.yaml
groups:
  - name: admissionpolicy
    rules:
      - alert: AdmissionPolicyViolationsHigh
        expr: |
          sum(rate(apiserver_admission_policy_check_total{result="deny"}[5m])) by (policy) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High denial rate for admission policy {{ $labels.policy }}"
          description: "Policy {{ $labels.policy }} is denying requests at {{ $value }} per second"

      - alert: AdmissionPolicyErrors
        expr: |
          sum(rate(apiserver_admission_policy_check_total{result="error"}[5m])) by (policy) > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Admission policy {{ $labels.policy }} is erroring"
          description: "CEL expression errors in policy {{ $labels.policy }}. Check policy syntax."
```

```bash
# Useful kubectl commands for policy management

# List all policies and their bindings
kubectl get validatingadmissionpolicies
kubectl get validatingadmissionpolicybindings

# Check policy evaluation status
kubectl describe validatingadmissionpolicy require-resource-limits

# Check binding status
kubectl describe validatingadmissionpolicybinding require-resource-limits-binding

# View recent admission events
kubectl get events --field-selector type=Warning --sort-by='.lastTimestamp' | grep -i policy

# Test a policy expression with kubectl --dry-run
kubectl apply --dry-run=server -f my-deployment.yaml
```

## Summary

ValidatingAdmissionPolicy with CEL represents the maturation of Kubernetes policy enforcement:

1. **CEL is expressive enough** for the vast majority of validation use cases: resource limits, security contexts, naming conventions, label requirements, and immutability enforcement
2. **Parameterized policies** allow a single policy template to be configured differently per namespace or environment using standard Kubernetes objects
3. **Validation actions** (Deny/Warn/Audit) enable gradual rollout without disrupting existing workloads
4. **In-process evaluation** eliminates the operational overhead of webhook servers and reduces admission latency to under 1ms
5. **Migration from Gatekeeper** is straightforward for most policies — Rego expressions translate directly to CEL with minor syntax differences

For organizations running Gatekeeper or Kyverno, ValidatingAdmissionPolicy is worth evaluating as a replacement for simple validation policies, reducing operational complexity while maintaining policy enforcement.
