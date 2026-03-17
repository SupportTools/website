---
title: "Kubernetes OPA Gatekeeper: Policy-as-Code, Constraint Templates, and Enterprise Policy Libraries"
date: 2028-06-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Gatekeeper", "Policy", "Security", "Compliance"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to OPA Gatekeeper for Kubernetes policy enforcement: ConstraintTemplate authoring in Rego, enterprise policy libraries, mutation policies, audit mode, and integration with CI/CD pipelines."
more_link: "yes"
url: "/kubernetes-opa-gatekeeper-policy-guide/"
---

OPA Gatekeeper turns Kubernetes admission control from a binary allow/deny decision into an expressive, auditable policy system. Without Gatekeeper, your only enforcement mechanisms are RBAC (which controls who can create resources) and PodSecurityAdmission (which enforces a small set of security policies). With Gatekeeper, you can express arbitrary business rules: no images from unapproved registries, all Deployments must have resource limits, Ingress hostnames must match a naming convention, labels must follow your tagging standards.

This guide covers the full Gatekeeper implementation: installing with best-practice configuration, authoring ConstraintTemplates in Rego, building a reusable policy library, using mutation policies, and integrating policy checks into CI/CD before resources reach the cluster.

<!--more-->

# Kubernetes OPA Gatekeeper: Policy-as-Code, Constraint Templates, and Enterprise Policy Libraries

## Section 1: Gatekeeper Architecture

Gatekeeper runs as an admission webhook that intercepts all CREATE and UPDATE operations on Kubernetes resources. The flow is:

1. User or controller submits a resource to kube-apiserver
2. kube-apiserver calls Gatekeeper webhook (ValidatingAdmissionWebhook)
3. Gatekeeper evaluates all Constraints that match the resource type
4. If any constraint is violated, the request is denied with the violation message
5. If all constraints pass, the resource is admitted

### Key Components

```
ConstraintTemplate  - Defines the Rego policy logic (cluster-scoped)
Constraint          - Instance of a template with specific parameters (cluster-scoped)
Config              - Which resources Gatekeeper replicates for audit (cluster-scoped)
MutationPolicy      - Mutating admission (Assign, AssignMetadata, ModifySet)
```

## Section 2: Installation

### Installing Gatekeeper with Helm

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --version 3.14.0 \
  --set replicas=3 \
  --set auditInterval=60 \
  --set constraintViolationsLimit=100 \
  --set audit.logLevel=ERROR \
  --set logLevel=ERROR \
  --set psp.enabled=false \
  --set image.pullPolicy=IfNotPresent \
  --set postInstall.labelNamespace.enabled=true \
  --wait
```

### Verify Installation

```bash
# Check Gatekeeper pods
kubectl get pods -n gatekeeper-system

# Check webhook configuration
kubectl get validatingwebhookconfigurations | grep gatekeeper

# Check if audit is running
kubectl logs -n gatekeeper-system -l control-plane=audit-controller -f

# Test that Gatekeeper is intercepting requests
kubectl run test --image=nginx:latest -n default
# This should succeed if no blocking policies are installed yet
```

### Gatekeeper Configuration

```yaml
# Exclude system namespaces from enforcement
apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  # Sync these resources for audit purposes
  sync:
    syncOnly:
    - group: ""
      version: "v1"
      kind: Namespace
    - group: "apps"
      version: "v1"
      kind: Deployment
    - group: "apps"
      version: "v1"
      kind: StatefulSet
    - group: ""
      version: "v1"
      kind: Pod
    - group: "networking.k8s.io"
      version: "v1"
      kind: Ingress

  # Exclude specific resources from admission control
  match:
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - gatekeeper-system
    - cert-manager
    - monitoring
```

## Section 3: Writing ConstraintTemplates

### Template 1: Required Resource Limits

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredresourcelimits
  annotations:
    metadata.gatekeeper.sh/title: "Required Resource Limits"
    metadata.gatekeeper.sh/version: "1.0.1"
    description: "Requires containers to have CPU and memory limits defined."
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredResourceLimits
      validation:
        # Parameters schema for the constraint
        openAPIV3Schema:
          type: object
          properties:
            cpu:
              description: "If true, require CPU limits"
              type: boolean
            memory:
              description: "If true, require memory limits"
              type: boolean
            exemptImages:
              description: "Images exempt from this policy"
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequiredresourcelimits

      # Import the input resource
      violation[{"msg": msg}] {
        # Apply to containers in pods/deployments/etc.
        container := input.review.object.spec.containers[_]

        # Check if container image is exempt
        not is_exempt_image(container.image)

        # Check CPU limits if required
        input.parameters.cpu == true
        not container.resources.limits.cpu

        msg := sprintf(
          "container <%v> has no CPU limit. CPU limits are required.",
          [container.name]
        )
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not is_exempt_image(container.image)

        input.parameters.memory == true
        not container.resources.limits.memory

        msg := sprintf(
          "container <%v> has no memory limit. Memory limits are required.",
          [container.name]
        )
      }

      # Also check initContainers
      violation[{"msg": msg}] {
        container := input.review.object.spec.initContainers[_]
        not is_exempt_image(container.image)

        input.parameters.cpu == true
        not container.resources.limits.cpu

        msg := sprintf(
          "initContainer <%v> has no CPU limit.",
          [container.name]
        )
      }

      # Helper: check if image is in the exempt list
      is_exempt_image(image) {
        exempt := input.parameters.exemptImages[_]
        glob.match(exempt, [], image)
      }
```

Apply the constraint:

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredResourceLimits
metadata:
  name: require-resource-limits
spec:
  enforcementAction: deny  # deny | warn | dryrun
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    - apiGroups: [""]
      kinds: ["Pod", "ReplicationController"]
    excludedNamespaces:
    - kube-system
    - monitoring
  parameters:
    cpu: true
    memory: true
    exemptImages:
    - "gcr.io/distroless/*"
    - "registry.k8s.io/*"
```

### Template 2: Approved Container Registries

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedrepos
  annotations:
    metadata.gatekeeper.sh/title: "Allowed Repositories"
    description: "Requires container images to come from approved registries."
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
              description: "Approved registry prefixes"
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8sallowedrepos

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not approved_repo(container.image)
        msg := sprintf(
          "container <%v> uses image <%v> from an unapproved registry. Approved registries: %v",
          [container.name, container.image, input.parameters.repos]
        )
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.initContainers[_]
        not approved_repo(container.image)
        msg := sprintf(
          "initContainer <%v> uses image <%v> from an unapproved registry.",
          [container.name, container.image]
        )
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.ephemeralContainers[_]
        not approved_repo(container.image)
        msg := sprintf(
          "ephemeralContainer <%v> uses image <%v> from an unapproved registry.",
          [container.name, container.image]
        )
      }

      approved_repo(image) {
        repo := input.parameters.repos[_]
        startswith(image, repo)
      }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: approved-registries
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"]
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
  parameters:
    repos:
    - "myregistry.example.com/"
    - "registry.k8s.io/"
    - "gcr.io/distroless/"
    - "docker.io/library/"    # Only official Docker Hub images
```

### Template 3: Required Labels

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    metadata.gatekeeper.sh/title: "Required Labels"
    description: "Requires resources to have specific labels for compliance and cost tracking."
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              description: "List of required label keys"
              type: array
              items:
                type: object
                properties:
                  key:
                    type: string
                  allowedRegex:
                    description: "Optional regex to validate label value"
                    type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequiredlabels

      # Check for missing required labels
      violation[{"msg": msg}] {
        required := input.parameters.labels[_]
        not input.review.object.metadata.labels[required.key]
        msg := sprintf(
          "<%v> <%v> is missing required label <%v>",
          [input.review.object.kind, input.review.object.metadata.name, required.key]
        )
      }

      # Check label value matches regex if specified
      violation[{"msg": msg}] {
        required := input.parameters.labels[_]
        required.allowedRegex != ""
        label_value := input.review.object.metadata.labels[required.key]
        not re_match(required.allowedRegex, label_value)
        msg := sprintf(
          "<%v> <%v> label <%v> has value <%v> which doesn't match required pattern <%v>",
          [
            input.review.object.kind,
            input.review.object.metadata.name,
            required.key,
            label_value,
            required.allowedRegex
          ]
        )
      }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: required-labels-deployments
spec:
  enforcementAction: warn  # Start with warn before switching to deny
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet"]
  parameters:
    labels:
    - key: app
    - key: team
      allowedRegex: "^(platform|backend|frontend|data|security)$"
    - key: cost-center
      allowedRegex: "^CC-[0-9]{4}$"
    - key: environment
      allowedRegex: "^(production|staging|development)$"
```

### Template 4: Namespace Label Requirements

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirednamespacelabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredNamespaceLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequirednamespacelabels

      violation[{"msg": msg}] {
        input.review.object.kind == "Namespace"
        required := input.parameters.labels[_]
        not input.review.object.metadata.labels[required]
        msg := sprintf(
          "Namespace <%v> is missing required label <%v>",
          [input.review.object.metadata.name, required]
        )
      }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredNamespaceLabels
metadata:
  name: require-namespace-labels
spec:
  enforcementAction: warn
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Namespace"]
    excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - gatekeeper-system
  parameters:
    labels:
    - team
    - environment
    - pod-security.kubernetes.io/enforce
```

### Template 5: No Privileged Containers

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snooprivilegedcontainer
  annotations:
    metadata.gatekeeper.sh/title: "No Privileged Containers"
    description: "Prevents containers from running in privileged mode."
spec:
  crd:
    spec:
      names:
        kind: K8sNoPrivilegedContainer
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedPrivilegedImages:
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8snooprivilegedcontainer

      violation[{"msg": msg}] {
        c := input.review.object.spec.containers[_]
        c.securityContext.privileged == true
        not is_allowed_privileged(c.image)
        msg := sprintf(
          "container <%v> is privileged. Privileged containers are not allowed.",
          [c.name]
        )
      }

      violation[{"msg": msg}] {
        c := input.review.object.spec.initContainers[_]
        c.securityContext.privileged == true
        not is_allowed_privileged(c.image)
        msg := sprintf(
          "initContainer <%v> is privileged.",
          [c.name]
        )
      }

      is_allowed_privileged(image) {
        allowed := input.parameters.allowedPrivilegedImages[_]
        glob.match(allowed, [], image)
      }
```

## Section 4: Mutation Policies

Gatekeeper mutation policies automatically modify resources during admission, adding defaults or enforcing standards without blocking.

### Assign: Add Default Security Context

```yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: add-run-as-nonroot
spec:
  applyTo:
  - groups: ["apps"]
    kinds: ["Deployment"]
    versions: ["v1"]
  match:
    scope: Namespaced
    namespaces: ["production", "staging"]
    excludedNamespaces: ["kube-system"]
  location: "spec.template.spec.securityContext.runAsNonRoot"
  parameters:
    assign:
      value: true

---
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: add-seccomp-profile
spec:
  applyTo:
  - groups: ["apps"]
    kinds: ["Deployment", "StatefulSet"]
    versions: ["v1"]
  match:
    scope: Namespaced
  location: "spec.template.spec.securityContext.seccompProfile"
  parameters:
    assign:
      value:
        type: RuntimeDefault
```

### AssignMetadata: Add Required Labels Automatically

```yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: AssignMetadata
metadata:
  name: add-creator-label
spec:
  match:
    scope: Namespaced
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet"]
  location: "metadata.labels.created-by-mutation"
  parameters:
    assign:
      value: "gatekeeper-mutation"
```

### Assign: Set Default Resource Requests

```yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: set-default-cpu-request
spec:
  applyTo:
  - groups: ["apps"]
    kinds: ["Deployment"]
    versions: ["v1"]
  match:
    scope: Namespaced
  # Only set if not already defined
  location: "spec.template.spec.containers[name:*].resources.requests.cpu"
  parameters:
    assign:
      value: "100m"

---
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: set-default-memory-request
spec:
  applyTo:
  - groups: ["apps"]
    kinds: ["Deployment"]
    versions: ["v1"]
  match:
    scope: Namespaced
  location: "spec.template.spec.containers[name:*].resources.requests.memory"
  parameters:
    assign:
      value: "128Mi"
```

## Section 5: Audit Mode and Compliance Reporting

Gatekeeper periodically audits existing resources against constraints, not just new ones. This is how you discover violations that existed before Gatekeeper was installed.

### Reading Audit Results

```bash
# List all constraints and their violation counts
kubectl get constraints -A

# Detailed audit results for a specific constraint
kubectl get k8srequiredresourcelimits require-resource-limits -o yaml | \
  yq '.status.violations'

# All violations across all constraints
kubectl get constraints -A -o json | jq '
  .items[] |
  {
    kind: .kind,
    name: .metadata.name,
    enforcementAction: .spec.enforcementAction,
    violations: (.status.violations // []) | length
  }
' | jq -s 'sort_by(-.violations)'

# Violations for a specific namespace
kubectl get constraints -A -o json | jq '
  .items[] |
  .status.violations[]? |
  select(.namespace == "production")
'
```

### Audit Report Script

```bash
#!/bin/bash
# gatekeeper-audit-report.sh
# Generate a compliance report from Gatekeeper audit results

echo "=== Gatekeeper Compliance Report ==="
echo "Generated: $(date)"
echo ""

TOTAL_VIOLATIONS=0
CONSTRAINTS_WITH_VIOLATIONS=0

# Iterate over all constraints
kubectl get constraints -A -o json | jq -c '.items[]' | while read constraint; do
    KIND=$(echo "${constraint}" | jq -r '.kind')
    NAME=$(echo "${constraint}" | jq -r '.metadata.name')
    ACTION=$(echo "${constraint}" | jq -r '.spec.enforcementAction')
    VIOLATIONS=$(echo "${constraint}" | jq '.status.violations | length // 0')

    if [ "${VIOLATIONS}" -gt 0 ]; then
        echo "--- ${KIND}/${NAME} (${ACTION}) ---"
        echo "Violations: ${VIOLATIONS}"
        echo "${constraint}" | jq -r '
          .status.violations[] |
          "  \(.namespace)/\(.name): \(.message)"
        ' | head -10

        if [ "${VIOLATIONS}" -gt 10 ]; then
            echo "  ... and $((VIOLATIONS - 10)) more"
        fi
        echo ""
    fi
done

echo "=== Summary ==="
TOTAL=$(kubectl get constraints -A -o json | \
  jq '[.items[].status.violations // [] | length] | add // 0')
echo "Total violations: ${TOTAL}"

BLOCKING=$(kubectl get constraints -A -o json | \
  jq '[.items[] | select(.spec.enforcementAction == "deny") | .status.violations // [] | length] | add // 0')
echo "Blocking violations (deny): ${BLOCKING}"
```

### Prometheus Metrics for Gatekeeper

Gatekeeper exposes Prometheus metrics for monitoring:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gatekeeper-alerts
  namespace: gatekeeper-system
spec:
  groups:
  - name: gatekeeper
    rules:
    - alert: GatekeeperHighViolationCount
      expr: |
        sum(gatekeeper_violations) by (enforcement_action, constraint_kind) > 50
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "High number of Gatekeeper violations"
        description: "{{ $labels.constraint_kind }} has {{ $value }} violations with action {{ $labels.enforcement_action }}"

    - alert: GatekeeperAuditRunFailing
      expr: |
        time() - gatekeeper_audit_last_run_time > 300
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Gatekeeper audit has not run in 5 minutes"

    - alert: GatekeeperWebhookDown
      expr: |
        up{job="gatekeeper-controller-manager"} == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Gatekeeper webhook controller is down"
```

## Section 6: CI/CD Integration with Conftest

### Pre-Commit Policy Validation

```bash
# Install conftest (uses OPA/Rego for Kubernetes manifest validation)
# https://www.conftest.dev/
brew install conftest
# or
wget https://github.com/open-policy-agent/conftest/releases/download/v0.49.0/conftest_0.49.0_Linux_x86_64.tar.gz

# Run conftest against manifests with Gatekeeper constraint templates
conftest test -p ./policies ./kubernetes/manifests/*.yaml
```

### Rego Unit Tests

```rego
# policies/tests/k8srequiredresourcelimits_test.rego
package k8srequiredresourcelimits

import future.keywords.if

# Test: container without CPU limit should fail
test_deny_missing_cpu_limit if {
    violation[_] with input as {
        "parameters": {"cpu": true, "memory": false, "exemptImages": []},
        "review": {
            "object": {
                "spec": {
                    "containers": [{
                        "name": "app",
                        "image": "nginx:latest",
                        "resources": {}
                    }]
                }
            }
        }
    }
}

# Test: container with CPU limit should pass
test_allow_with_cpu_limit if {
    count(violation) == 0 with input as {
        "parameters": {"cpu": true, "memory": false, "exemptImages": []},
        "review": {
            "object": {
                "spec": {
                    "containers": [{
                        "name": "app",
                        "image": "nginx:latest",
                        "resources": {
                            "limits": {"cpu": "500m"}
                        }
                    }]
                }
            }
        }
    }
}

# Test: exempt image should pass even without limits
test_allow_exempt_image if {
    count(violation) == 0 with input as {
        "parameters": {
            "cpu": true,
            "memory": true,
            "exemptImages": ["registry.k8s.io/*"]
        },
        "review": {
            "object": {
                "spec": {
                    "containers": [{
                        "name": "pause",
                        "image": "registry.k8s.io/pause:3.9",
                        "resources": {}
                    }]
                }
            }
        }
    }
}
```

Run unit tests:

```bash
# Run OPA unit tests
opa test ./policies/

# Run with coverage
opa test --coverage ./policies/

# Run conftest with built-in tests
conftest test --test --policy ./policies ./kubernetes/manifests/*.yaml
```

### GitHub Actions Pipeline

```yaml
# .github/workflows/policy-check.yaml
name: Kubernetes Policy Check

on:
  pull_request:
    paths:
    - 'kubernetes/**'

jobs:
  policy-check:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Install conftest
      run: |
        wget -q https://github.com/open-policy-agent/conftest/releases/download/v0.49.0/conftest_0.49.0_Linux_x86_64.tar.gz
        tar xzf conftest_0.49.0_Linux_x86_64.tar.gz
        sudo mv conftest /usr/local/bin/

    - name: Install OPA
      run: |
        curl -L -o opa https://openpolicyagent.org/downloads/v0.61.0/opa_linux_amd64_static
        chmod +x opa
        sudo mv opa /usr/local/bin/

    - name: Run Rego unit tests
      run: |
        opa test ./policies/ --v

    - name: Validate Kubernetes manifests against policies
      run: |
        conftest test \
          --policy ./policies \
          --namespace gatekeeper \
          kubernetes/manifests/*.yaml \
          kubernetes/manifests/**/*.yaml

    - name: Check constraint syntax
      run: |
        for f in $(find kubernetes/constraints -name "*.yaml"); do
          kubectl apply --dry-run=server -f $f || exit 1
        done
      env:
        KUBECONFIG: ${{ secrets.KUBECONFIG_DEV }}
```

## Section 7: Enterprise Policy Library

### Policy Library Structure

```
policies/
├── templates/
│   ├── k8srequiredresourcelimits.yaml
│   ├── k8sallowedrepos.yaml
│   ├── k8srequiredlabels.yaml
│   ├── k8snoprivilegedcontainer.yaml
│   ├── k8sreadonlyrootfilesystem.yaml
│   ├── k8snohostnamespace.yaml
│   ├── k8srequiredprobes.yaml
│   └── k8spoddisruptionbudget.yaml
├── constraints/
│   ├── production/
│   │   ├── require-resource-limits.yaml
│   │   ├── approved-registries.yaml
│   │   └── required-labels.yaml
│   └── development/
│       ├── require-resource-limits-warn.yaml
│       └── approved-registries-warn.yaml
├── mutations/
│   ├── add-default-security-context.yaml
│   └── add-default-resource-requests.yaml
└── tests/
    ├── k8srequiredresourcelimits_test.rego
    └── k8sallowedrepos_test.rego
```

### Read-Only Root Filesystem Template

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sreadonlyrootfilesystem
  annotations:
    metadata.gatekeeper.sh/title: "Read-Only Root Filesystem"
spec:
  crd:
    spec:
      names:
        kind: K8sReadOnlyRootFilesystem
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
      package k8sreadonlyrootfilesystem

      violation[{"msg": msg}] {
        c := input.review.object.spec.containers[_]
        not is_exempt(c.image)
        not c.securityContext.readOnlyRootFilesystem == true
        msg := sprintf(
          "container <%v> does not have a read-only root filesystem",
          [c.name]
        )
      }

      is_exempt(image) {
        exempt := input.parameters.exemptImages[_]
        glob.match(exempt, [], image)
      }
```

### Required Health Probes Template

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredprobes
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredProbes
      validation:
        openAPIV3Schema:
          type: object
          properties:
            probeTypes:
              description: "Which probe types to require: livenessProbe, readinessProbe, startupProbe"
              type: array
              items:
                type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequiredprobes

      # Build probe names to check
      probe_type_names := ["livenessProbe", "readinessProbe", "startupProbe"]

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        required := input.parameters.probeTypes[_]
        probe_type_names[_] == required
        not container[required]
        msg := sprintf(
          "container <%v> does not have a <%v> configured",
          [container.name, required]
        )
      }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredProbes
metadata:
  name: require-health-probes
spec:
  enforcementAction: warn
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet"]
  parameters:
    probeTypes:
    - readinessProbe
    - livenessProbe
```

## Section 8: Troubleshooting

### Common Issues and Solutions

```bash
# Issue 1: Webhook certificate errors
kubectl get secret -n gatekeeper-system | grep tls
kubectl describe validatingwebhookconfiguration gatekeeper-validating-webhook-configuration

# Regenerate webhook certificates
kubectl rollout restart deployment/gatekeeper-controller-manager -n gatekeeper-system

# Issue 2: Constraint template fails to compile
kubectl describe constrainttemplate k8srequiredresourcelimits
# Look for "Status.ByPod[*].Errors" in output

# Issue 3: Audit results not updating
kubectl logs -n gatekeeper-system -l control-plane=audit-controller --tail=50
# Check auditInterval setting
kubectl get cm -n gatekeeper-system -o yaml | grep auditInterval

# Issue 4: Policy not matching resources
# Test with a specific resource
kubectl run test-pod --image=nginx --dry-run=server -o yaml 2>&1

# Issue 5: Debug Rego evaluation
opa eval --input test-input.json --data policies/ "data.k8srequiredresourcelimits.violation"
```

### Testing a Constraint Before Applying

```bash
# Use dryrun enforcement action to see what would be blocked
kubectl apply -f - <<EOF
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredResourceLimits
metadata:
  name: test-resource-limits
spec:
  enforcementAction: dryrun  # Will not block, just audit
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment"]
  parameters:
    cpu: true
    memory: true
    exemptImages: []
EOF

# Wait for audit to run
sleep 120

# Check what would be blocked
kubectl get k8srequiredresourcelimits test-resource-limits -o yaml | \
  yq '.status.violations'
```

## Section 9: Key Takeaways

- Start with `enforcementAction: warn` or `dryrun` to assess blast radius before switching to `deny`
- Use `excludedNamespaces` to protect system namespaces from accidental breakage
- ConstraintTemplates define the Rego logic; Constraints instantiate them with parameters - separate concerns
- Mutation policies (Assign, AssignMetadata) automatically fix common issues instead of blocking them
- Gatekeeper audit runs on a schedule against existing resources - check `status.violations` on constraints
- Write Rego unit tests for every template using `opa test` - catch logic errors before deployment
- Use conftest in CI/CD to validate manifests against policies before they reach the cluster
- The `exemptImages` pattern is essential for system components that legitimately need elevated permissions
- Monitor `gatekeeper_violations` metric in Prometheus to track compliance over time
- Gatekeeper's `Config` resource controls which resources are synced for audit and cross-resource lookups
