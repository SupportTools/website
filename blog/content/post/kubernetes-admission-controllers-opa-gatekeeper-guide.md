---
title: "Kubernetes Admission Controllers: OPA Gatekeeper Policies and Constraint Frameworks"
date: 2029-12-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Gatekeeper", "Policy", "Security", "Admission Controllers", "Rego", "Compliance"]
categories:
- Kubernetes
- Security
- Policy
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide covering Gatekeeper installation, ConstraintTemplates, Rego policies, audit mode, mutation policies, and automated policy testing for Kubernetes security compliance."
more_link: "yes"
url: "/kubernetes-admission-controllers-opa-gatekeeper-guide/"
---

Kubernetes RBAC controls who can create and modify resources. OPA Gatekeeper controls what those resources are allowed to contain. Together they form a complete access control system: RBAC determines permission, Gatekeeper determines correctness. Without Gatekeeper (or an equivalent), any developer with `create deployment` permission can schedule containers with `privileged: true`, `hostPID: true`, or `runAsRoot: true` — regardless of organizational policy.

<!--more-->

## Section 1: Admission Controller Architecture

When a request reaches the Kubernetes API server, it passes through a sequential pipeline:

```
kubectl apply → API Server → Authentication → Authorization (RBAC)
    → Mutating Admission Webhooks (Gatekeeper mutations)
    → Object Validation
    → Validating Admission Webhooks (Gatekeeper validation)
    → etcd storage
```

Gatekeeper runs as both a mutating and validating admission webhook. The validating webhook rejects requests that violate constraints. The mutating webhook can inject default values and normalize configurations before validation.

### Gatekeeper vs Kyverno

Both are policy engines for Kubernetes. The key differences:

| Feature | OPA Gatekeeper | Kyverno |
|---|---|---|
| Policy language | Rego (general-purpose) | YAML-native rules |
| Learning curve | Steep (Rego is different) | Gentle (YAML familiar) |
| Expressiveness | Very high | Moderate |
| Audit mode | Built-in | Built-in |
| Mutation | Supported | Supported |
| Policy testing | OPA test framework | Kyverno CLI |

Gatekeeper's Rego language is more expressive for complex policies. Kyverno's YAML-based rules are more accessible for teams without policy-as-code experience.

## Section 2: Installing Gatekeeper

```bash
# Install Gatekeeper (latest stable)
kubectl apply -f https://raw.githubusercontent.com/open-policy-agent/gatekeeper/v3.17.0/deploy/gatekeeper.yaml

# Or via Helm
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --set replicas=3 \
  --set audit.interval=60 \
  --set audit.matchKindGroupOverride='[{"group": "", "kind": "Pod"}]' \
  --set validatingWebhookFailurePolicy=Fail \
  --set mutatingWebhookFailurePolicy=Ignore \
  --set logLevel=WARNING \
  --set resources.requests.cpu=100m \
  --set resources.requests.memory=512Mi \
  --set resources.limits.cpu=1000m \
  --set resources.limits.memory=1Gi
```

### Verifying Installation

```bash
kubectl get pods -n gatekeeper-system
# NAME                                             READY   STATUS    RESTARTS
# gatekeeper-audit-5f9b9c849d-xxxx                 1/1     Running   0
# gatekeeper-controller-manager-59b8d8f8f7-xxxx   1/1     Running   0
# gatekeeper-controller-manager-59b8d8f8f7-yyyy   1/1     Running   0
# gatekeeper-controller-manager-59b8d8f8f7-zzzz   1/1     Running   0

# Check webhook configuration
kubectl get validatingwebhookconfigurations gatekeeper-validating-webhook-configuration
kubectl get mutatingwebhookconfigurations gatekeeper-mutating-webhook-configuration

# Check for existing constraint violations (audit mode)
kubectl get constraints --all-namespaces
```

## Section 3: ConstraintTemplates and Constraints

Gatekeeper's policy model has two levels:

**ConstraintTemplate**: Defines the policy logic in Rego and creates a new CRD kind for instantiating the policy. Think of it as a policy class definition.

**Constraint**: An instance of a ConstraintTemplate that specifies which resources to check, which namespaces to apply to, and any policy-specific parameters.

### ConstraintTemplate: Require Resource Limits

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredresources
  annotations:
    description: "Requires containers to have resource requests and limits set."
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredResources
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptImages:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredresources

        import future.keywords.contains
        import future.keywords.if
        import future.keywords.in

        violation contains msg if {
          container := input.review.object.spec.containers[_]
          not exempt_image(container)
          missing_limits(container)
          msg := sprintf(
            "Container <%v> is missing resource limits. CPU and memory limits are required.",
            [container.name]
          )
        }

        violation contains msg if {
          container := input.review.object.spec.containers[_]
          not exempt_image(container)
          missing_requests(container)
          msg := sprintf(
            "Container <%v> is missing resource requests.",
            [container.name]
          )
        }

        # Same rules for initContainers
        violation contains msg if {
          container := input.review.object.spec.initContainers[_]
          not exempt_image(container)
          missing_limits(container)
          msg := sprintf(
            "InitContainer <%v> is missing resource limits.",
            [container.name]
          )
        }

        missing_limits(container) if {
          not container.resources.limits.cpu
        }

        missing_limits(container) if {
          not container.resources.limits.memory
        }

        missing_requests(container) if {
          not container.resources.requests.cpu
        }

        missing_requests(container) if {
          not container.resources.requests.memory
        }

        exempt_image(container) if {
          exemptions := {img | img := input.parameters.exemptImages[_]}
          container.image in exemptions
        }
```

### Instantiating the Constraint

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredResources
metadata:
  name: require-resource-limits
spec:
  enforcementAction: deny  # or: warn, dryrun
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaceSelector:
      matchExpressions:
        - key: policy.company.com/enforce-resources
          operator: In
          values: ["true"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
      - monitoring
  parameters:
    exemptImages:
      - "gcr.io/company/legacy-app:v1.0"
```

The `enforcementAction` field controls behavior:
- `deny`: Reject the request
- `warn`: Allow but return a warning message (visible in `kubectl apply` output)
- `dryrun`: Allow and record violations in audit only (for policy rollout)

## Section 4: Core Policy Library

### Disallow Privileged Containers

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8spspprivilegedcontainer
spec:
  crd:
    spec:
      names:
        kind: K8sPSPPrivilegedContainer
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8spspprivilegedcontainer

        import future.keywords.contains
        import future.keywords.if

        violation contains msg if {
          c := input_containers[_]
          c.securityContext.privileged == true
          msg := sprintf(
            "Privileged container not allowed: <%v> in pod <%v>",
            [c.name, input.review.object.metadata.name]
          )
        }

        input_containers contains c if {
          c := input.review.object.spec.containers[_]
        }

        input_containers contains c if {
          c := input.review.object.spec.initContainers[_]
        }

        input_containers contains c if {
          c := input.review.object.spec.ephemeralContainers[_]
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPPrivilegedContainer
metadata:
  name: psp-privileged-container
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
```

### Require Non-Root User

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8spspnonrootuser
spec:
  crd:
    spec:
      names:
        kind: K8sPSPNonRootUser
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8spspnonrootuser

        import future.keywords.contains
        import future.keywords.if

        violation contains msg if {
          # Pod-level runAsNonRoot not set to true
          not input.review.object.spec.securityContext.runAsNonRoot == true
          # No container-level override
          container := input.review.object.spec.containers[_]
          not container.securityContext.runAsNonRoot == true
          not container_has_run_as_user(container)
          msg := sprintf(
            "Container <%v> does not enforce running as non-root",
            [container.name]
          )
        }

        violation contains msg if {
          container := input.review.object.spec.containers[_]
          container.securityContext.runAsUser == 0
          msg := sprintf(
            "Container <%v> explicitly runs as root (UID 0)",
            [container.name]
          )
        }

        container_has_run_as_user(container) if {
          container.securityContext.runAsUser != 0
        }
```

### Allowed Container Registries

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedrepos
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedRepos
      validation:
        openAPIV3Schema:
          type: object
          properties:
            repos:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedrepos

        import future.keywords.contains
        import future.keywords.if
        import future.keywords.in

        violation contains msg if {
          container := input.review.object.spec.containers[_]
          not repo_allowed(container.image)
          msg := sprintf(
            "Container <%v> uses image <%v> from a disallowed registry",
            [container.name, container.image]
          )
        }

        repo_allowed(image) if {
          allowed := input.parameters.repos
          repo := allowed[_]
          startswith(image, repo)
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: allowed-repos
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
  parameters:
    repos:
      - "registry.company.com/"
      - "gcr.io/company/"
      - "ghcr.io/company/"
```

## Section 5: Mutation Policies

Gatekeeper mutations automatically set default values and normalize configurations before validation runs.

### Assign Default Security Context

```yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: set-default-security-context
spec:
  applyTo:
    - groups: [""]
      kinds: ["Pod"]
      versions: ["v1"]
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
  location: "spec.securityContext.runAsNonRoot"
  parameters:
    assign:
      value: true
---
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: set-default-seccomp
spec:
  applyTo:
    - groups: [""]
      kinds: ["Pod"]
      versions: ["v1"]
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
  location: "spec.securityContext.seccompProfile"
  parameters:
    assign:
      value:
        type: RuntimeDefault
```

### AssignMetadata for Label Injection

```yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: AssignMetadata
metadata:
  name: add-team-label
spec:
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaceSelector:
      matchExpressions:
        - key: team
          operator: Exists
  location: "metadata.labels.injected-by"
  parameters:
    assign:
      value: "gatekeeper"
```

## Section 6: Audit Mode and Violation Reporting

Gatekeeper's audit controller periodically scans all existing resources against active constraints and records violations. This is essential for:

1. Rolling out new policies gradually (start with `dryrun`, fix violations, switch to `deny`)
2. Detecting drift from compliant state
3. Compliance reporting

```bash
# Check audit violations for a specific constraint
kubectl describe K8sRequiredResources require-resource-limits

# Output includes:
# Status:
#   Audit Timestamp:  2029-12-01T14:23:00Z
#   By Pod:
#     Constraint UID:  ...
#     Enforced:        true
#     Id:              gatekeeper-audit-xxx
#     Observed Generation:  1
#     Operations:
#       audit
#       status
#     Template UID:  ...
#   Total Violations:  12
#   Violations:
#     Enforcement Action:  deny
#     Kind:                Pod
#     Message:             Container <app> is missing resource limits
#     Name:                my-app-7d9f-xxx
#     Namespace:           staging

# Export all violations to JSON for reporting
kubectl get constraints \
  -A \
  -o json | \
  jq '[.items[] | {
    "constraint": .metadata.name,
    "kind": .kind,
    "violations": .status.violations // []
  }]' > constraint-violations.json
```

## Section 7: Policy Testing

Gatekeeper policies should be tested before deployment using the OPA test framework:

```bash
# Install OPA CLI
curl -L -o opa \
  https://openpolicyagent.org/downloads/v0.68.0/opa_linux_amd64_static
chmod +x opa
sudo mv opa /usr/local/bin/

# Create a test file for the k8srequiredresources policy
cat > k8srequiredresources_test.rego << 'EOF'
package k8srequiredresources_test

import data.k8srequiredresources.violation

# Test: pod without resource limits should violate
test_missing_cpu_limit {
  count(violation) == 1 with input as {
    "review": {
      "object": {
        "metadata": {"name": "test-pod"},
        "spec": {
          "containers": [{
            "name": "app",
            "image": "nginx:latest",
            "resources": {
              "requests": {"cpu": "100m", "memory": "128Mi"},
              "limits": {"memory": "256Mi"}
            }
          }]
        }
      }
    },
    "parameters": {"exemptImages": []}
  }
}

# Test: pod with all resources set should not violate
test_all_resources_set {
  count(violation) == 0 with input as {
    "review": {
      "object": {
        "metadata": {"name": "test-pod"},
        "spec": {
          "containers": [{
            "name": "app",
            "image": "nginx:latest",
            "resources": {
              "requests": {"cpu": "100m", "memory": "128Mi"},
              "limits": {"cpu": "500m", "memory": "256Mi"}
            }
          }]
        }
      }
    },
    "parameters": {"exemptImages": []}
  }
}

# Test: exempt image should not violate
test_exempt_image {
  count(violation) == 0 with input as {
    "review": {
      "object": {
        "metadata": {"name": "test-pod"},
        "spec": {
          "containers": [{
            "name": "legacy",
            "image": "gcr.io/company/legacy-app:v1.0",
            "resources": {}
          }]
        }
      }
    },
    "parameters": {"exemptImages": ["gcr.io/company/legacy-app:v1.0"]}
  }
}
EOF

# Run tests
opa test k8srequiredresources.rego k8srequiredresources_test.rego -v

# Expected output:
# PASS: 3/3
# data.k8srequiredresources_test.test_missing_cpu_limit: PASS (1.2ms)
# data.k8srequiredresources_test.test_all_resources_set: PASS (0.8ms)
# data.k8srequiredresources_test.test_exempt_image: PASS (0.9ms)
```

## Section 8: Production Deployment Strategy

### Progressive Rollout Pattern

```bash
# Phase 1: Deploy constraints in dryrun mode
# Apply constraint with enforcementAction: dryrun
kubectl apply -f constraint-require-resources-dryrun.yaml

# Wait 24 hours for audit to surface all violations
kubectl get K8sRequiredResources require-resource-limits \
  -o jsonpath='{.status.totalViolations}'

# Phase 2: Switch to warn mode (allows, but kubectl shows warnings)
kubectl patch K8sRequiredResources require-resource-limits \
  --type='merge' \
  -p '{"spec":{"enforcementAction":"warn"}}'

# Phase 3: Notify teams with violation list
kubectl get K8sRequiredResources require-resource-limits \
  -o jsonpath='{.status.violations[*]}' | jq .

# Phase 4: After violations are remediated, enforce
kubectl patch K8sRequiredResources require-resource-limits \
  --type='merge' \
  -p '{"spec":{"enforcementAction":"deny"}}'
```

OPA Gatekeeper transforms Kubernetes security from an honor system into an enforced contract. Every resource that reaches etcd has passed every applicable constraint, making it possible to actually audit what is running in the cluster against your organizational policies — not just what you intended to be running.
