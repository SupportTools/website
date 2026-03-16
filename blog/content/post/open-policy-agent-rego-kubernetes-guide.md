---
title: "Open Policy Agent and Rego: Policy-as-Code for Kubernetes at Scale"
date: 2027-04-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Rego", "Policy", "Security", "Compliance"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying OPA Gatekeeper and writing Rego policies for Kubernetes admission control, authorization, and compliance enforcement at enterprise scale."
more_link: "yes"
url: "/open-policy-agent-rego-kubernetes-guide/"
---

Open Policy Agent (OPA) is a general-purpose policy engine that decouples policy decisions from application logic. In Kubernetes, OPA Gatekeeper extends the admission control webhook to enforce custom policies declared as code, giving platform teams a uniform, auditable mechanism to enforce security baselines, compliance requirements, and organizational standards across every cluster in the fleet. Policies written in Rego, OPA's purpose-built declarative language, live in version control alongside application manifests, enabling full GitOps workflows for governance.

This guide covers the complete OPA Gatekeeper lifecycle: architecture, installation, ConstraintTemplate authoring, testing with conftest, CI/CD integration, policy library management, dry-run mode, audit results, and production debugging techniques.

<!--more-->

## Section 1: Architecture Overview

OPA Gatekeeper integrates with the Kubernetes API server through two admission webhooks: a validating webhook that blocks non-compliant resources and a mutating webhook (optional) for policy-driven defaults. The controller watches `ConstraintTemplate` and `Constraint` custom resources and reconfigures the OPA policy engine in real time without restarting.

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  kubectl apply / CI Pipeline                                     │
│           │                                                       │
│           ▼                                                       │
│  Kubernetes API Server                                            │
│           │ AdmissionReview request                              │
│           ▼                                                       │
│  ┌────────────────────────────────────────────────────────┐      │
│  │  Gatekeeper Webhook (ValidatingWebhookConfiguration)   │      │
│  │  ┌──────────────────────────────────────────────────┐  │      │
│  │  │  Gatekeeper Controller Manager (3 replicas)      │  │      │
│  │  │  - OPA engine (Rego evaluation)                  │  │      │
│  │  │  - Constraint cache (in-memory)                  │  │      │
│  │  │  - Audit controller (periodic re-evaluation)     │  │      │
│  │  └──────────────────────────────────────────────────┘  │      │
│  └────────────────────────────────────────────────────────┘      │
│                                                                   │
│  Custom Resources                                                 │
│  ConstraintTemplate  →  defines the Rego policy logic            │
│  Constraint          →  instantiates the template with params    │
│  Config              →  controls which resources are synced      │
└─────────────────────────────────────────────────────────────────┘
```

### Key CRDs

- `ConstraintTemplate`: Defines the Rego policy logic and the schema of the `Constraint` custom resource it generates.
- `Constraint` (generated): Instantiates the template with parameters and targets (namespaces, resource kinds).
- `Config`: Controls which resources Gatekeeper replicates into its local cache for use in Rego policies that need to query existing resources.
- `AssignMetadata` / `Assign` / `ModifySet`: Mutation webhook CRDs (require the mutation webhook to be enabled).

---

## Section 2: Installing OPA Gatekeeper

### Prerequisites

```bash
# Verify cluster version (Gatekeeper requires Kubernetes >= 1.21)
kubectl version --short

# Confirm cert-manager status — not required but can be used for TLS management
kubectl get pods -n cert-manager 2>/dev/null || echo "cert-manager not found — not required"
```

### Install via Helm

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm upgrade --install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --version 3.16.3 \
  --set replicas=3 \
  --set auditInterval=60 \
  --set constraintViolationsLimit=100 \
  --set audit.logLevel=INFO \
  --set validatingWebhookTimeoutSeconds=15 \
  --set mutatingWebhookTimeoutSeconds=10 \
  --set emitAdmissionEvents=true \
  --set emitAuditEvents=true \
  --set logDenies=true \
  --wait
```

### Verify Installation

```bash
# All three replicas should be Running
kubectl get pods -n gatekeeper-system

# ValidatingWebhookConfiguration should be present
kubectl get validatingwebhookconfiguration gatekeeper-validating-webhook-configuration

# Core CRDs registered by the operator
kubectl get crd | grep gatekeeper
# Expected:
# constrainttemplates.templates.gatekeeper.sh
# configs.config.gatekeeper.sh
# constraintpodstatuses.status.gatekeeper.sh
# constrainttemplatepodstatuses.status.gatekeeper.sh
```

### Configure the Gatekeeper Config Resource

The `Config` resource controls which Kubernetes objects are synced into OPA's local cache. Policies that need to query existing resources (for uniqueness checks, cross-namespace validation) require the relevant kinds to be listed here.

```yaml
# gatekeeper-config.yaml
apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  sync:
    syncOnly:
      - group: ""
        version: "v1"
        kind: "Namespace"
      - group: ""
        version: "v1"
        kind: "Pod"
      - group: "apps"
        version: "v1"
        kind: "Deployment"
      - group: "apps"
        version: "v1"
        kind: "ReplicaSet"
      - group: "networking.k8s.io"
        version: "v1"
        kind: "Ingress"
  match:
    - excludedNamespaces:
        - gatekeeper-system
        - kube-system
      processes:
        - webhook
```

```bash
kubectl apply -f gatekeeper-config.yaml
```

---

## Section 3: Writing ConstraintTemplates

A `ConstraintTemplate` has two parts:
1. The CRD schema for the generated `Constraint` resource (parameters users can configure).
2. The Rego policy logic that evaluates incoming admission requests.

### Template 1: Require Resource Limits

This policy denies any container that does not specify CPU and memory limits.

```yaml
# constrainttemplate-requiredlimits.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlimits
  annotations:
    description: "Requires all containers to specify resource limits."
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLimits
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptContainers:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlimits

        violation[{"msg": msg, "details": {"container": container.name}}] {
          container := input_containers[_]
          not exempt_container(container)
          not container.resources.limits.cpu
          msg := sprintf("Container '%v' must specify a CPU limit.", [container.name])
        }

        violation[{"msg": msg, "details": {"container": container.name}}] {
          container := input_containers[_]
          not exempt_container(container)
          not container.resources.limits.memory
          msg := sprintf("Container '%v' must specify a memory limit.", [container.name])
        }

        input_containers[c] {
          c := input.review.object.spec.containers[_]
        }
        input_containers[c] {
          c := input.review.object.spec.initContainers[_]
        }

        exempt_container(container) {
          container.name == input.parameters.exemptContainers[_]
        }
```

```bash
kubectl apply -f constrainttemplate-requiredlimits.yaml

# Wait for the CRD to be generated
kubectl get crd k8srequiredlimits.constraints.gatekeeper.sh
```

### Instantiate the Constraint

```yaml
# constraint-requiredlimits.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLimits
metadata:
  name: require-resource-limits
spec:
  # enforcementAction: deny | warn | dryrun
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
      - cert-manager
      - monitoring
  parameters:
    exemptContainers:
      - istio-proxy
      - linkerd-proxy
```

```bash
kubectl apply -f constraint-requiredlimits.yaml

# Check constraint status — each Gatekeeper pod should show synced: true
kubectl get k8srequiredlimits require-resource-limits -o yaml | grep -A 20 status
```

### Template 2: Disallow Latest Image Tag

```yaml
# constrainttemplate-nolatesttag.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snolatesttag
  annotations:
    description: "Disallows container images tagged :latest or with no tag."
spec:
  crd:
    spec:
      names:
        kind: K8sNoLatestTag
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
        package k8snolatesttag

        violation[{"msg": msg}] {
          container := input_containers[_]
          not exempt_image(container.image)
          has_latest_tag(container.image)
          msg := sprintf(
            "Container image '%v' must not use ':latest' tag or an untagged image.",
            [container.image]
          )
        }

        has_latest_tag(image) {
          not contains(image, ":")
        }

        has_latest_tag(image) {
          endswith(image, ":latest")
        }

        exempt_image(image) {
          image == input.parameters.exemptImages[_]
        }

        input_containers[c] {
          c := input.review.object.spec.containers[_]
        }
        input_containers[c] {
          c := input.review.object.spec.initContainers[_]
        }
        input_containers[c] {
          c := input.review.object.spec.ephemeralContainers[_]
        }
```

```yaml
# constraint-nolatesttag.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoLatestTag
metadata:
  name: no-latest-tag
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  parameters:
    exemptImages:
      - "registry.internal/ops/debug:latest"
```

### Template 3: Required Labels

```yaml
# constrainttemplate-requiredlabels.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    description: "Requires resources to carry a specified set of labels."
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
              type: array
              items:
                type: object
                properties:
                  key:
                    type: string
                  allowedRegex:
                    type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_label": label.key}}] {
          label := input.parameters.labels[_]
          not has_label(label.key)
          msg := sprintf("Resource is missing required label '%v'.", [label.key])
        }

        violation[{"msg": msg, "details": {"invalid_label": label.key}}] {
          label := input.parameters.labels[_]
          has_label(label.key)
          label.allowedRegex != ""
          value := input.review.object.metadata.labels[label.key]
          not regex.match(label.allowedRegex, value)
          msg := sprintf(
            "Label '%v' has value '%v' which does not match regex '%v'.",
            [label.key, value, label.allowedRegex]
          )
        }

        has_label(key) {
          input.review.object.metadata.labels[key]
        }
```

```yaml
# constraint-requiredlabels-namespaces.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-ns-labels
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Namespace"]
  parameters:
    labels:
      - key: "team"
        allowedRegex: "^[a-z][a-z0-9-]+$"
      - key: "environment"
        allowedRegex: "^(production|staging|development|testing)$"
      - key: "cost-center"
        allowedRegex: ""
```

### Template 4: Block Privileged Containers

```yaml
# constrainttemplate-noprivileged.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snoprivilegedcontainer
  annotations:
    description: "Disallows privileged containers and dangerous capabilities."
spec:
  crd:
    spec:
      names:
        kind: K8sNoPrivilegedContainer
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedCapabilities:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8snoprivilegedcontainer

        violation[{"msg": msg}] {
          container := input_containers[_]
          container.securityContext.privileged == true
          msg := sprintf("Container '%v' must not run as privileged.", [container.name])
        }

        violation[{"msg": msg}] {
          container := input_containers[_]
          cap := container.securityContext.capabilities.add[_]
          not allowed_capability(cap)
          msg := sprintf(
            "Container '%v' adds forbidden capability '%v'.",
            [container.name, cap]
          )
        }

        violation[{"msg": msg}] {
          container := input_containers[_]
          container.securityContext.allowPrivilegeEscalation == true
          msg := sprintf(
            "Container '%v' must not allow privilege escalation.",
            [container.name]
          )
        }

        allowed_capability(cap) {
          cap == input.parameters.allowedCapabilities[_]
        }

        input_containers[c] {
          c := input.review.object.spec.containers[_]
        }
        input_containers[c] {
          c := input.review.object.spec.initContainers[_]
        }
```

---

## Section 4: Advanced Rego Patterns

### Querying Cached Resources via Data Inventory

When Gatekeeper syncs resources via the `Config` CRD, Rego policies can reference them through `data.inventory`. This enables policies that check uniqueness or enforce cross-namespace rules.

```yaml
# constrainttemplate-uniqueingresshost.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8suniqueingresshost
  annotations:
    description: "Ensures Ingress hostnames are unique across the cluster."
spec:
  crd:
    spec:
      names:
        kind: K8sUniqueIngressHost
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8suniqueingresshost

        # Build a set of all hostnames from the inventory cache
        existing_hosts[host] {
          ingress := data.inventory.namespace[_]["networking.k8s.io/v1"]["Ingress"][_]
          # Skip the resource being evaluated to allow UPDATE operations
          ingress.metadata.name != input.review.object.metadata.name
          host := ingress.spec.rules[_].host
        }

        violation[{"msg": msg}] {
          host := input.review.object.spec.rules[_].host
          existing_hosts[host]
          msg := sprintf(
            "Ingress hostname '%v' is already used by another Ingress resource.",
            [host]
          )
        }
```

### Allowed Registries with Namespace-Scoped Constraints

```yaml
# constrainttemplate-allowedregistries.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedrepos
  annotations:
    description: "Restricts container images to an approved list of registries."
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

        violation[{"msg": msg}] {
          container := input_containers[_]
          not allowed_repo(container.image)
          msg := sprintf(
            "Container image '%v' is from a disallowed registry. Allowed prefixes: %v",
            [container.image, input.parameters.repos]
          )
        }

        allowed_repo(image) {
          repo := input.parameters.repos[_]
          startswith(image, repo)
        }

        input_containers[c] {
          c := input.review.object.spec.containers[_]
        }
        input_containers[c] {
          c := input.review.object.spec.initContainers[_]
        }
```

```yaml
# constraint-allowedregistries-production.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: prod-allowed-repos
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        environment: production
  parameters:
    repos:
      - "registry.company.internal/"
      - "gcr.io/company-project/"
      - "public.ecr.aws/amazonlinux/"
```

---

## Section 5: Testing Policies with conftest

`conftest` is a testing framework built on OPA that validates configuration files against Rego policies before they are applied to the cluster. Integrating conftest into CI/CD pipelines catches violations at commit time, long before the admission webhook is reached.

### Install conftest

```bash
CONFTEST_VERSION="0.56.0"
curl -Lo conftest.tar.gz \
  "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz"
tar xzf conftest.tar.gz
sudo mv conftest /usr/local/bin/
conftest --version
```

### Policy Directory Layout

```
policies/
├── kubernetes/
│   ├── required_limits.rego
│   ├── no_latest_tag.rego
│   ├── required_labels.rego
│   ├── no_privileged.rego
│   └── allowed_repos.rego
└── data/
    └── allowed_repos.json
```

### conftest-Compatible Rego Policies

conftest expects policies in `deny`, `warn`, or `violation` rule format. The file structure mirrors Gatekeeper policies but without the `ConstraintTemplate` wrapper.

```rego
# policies/kubernetes/required_limits.rego
package main

deny[msg] {
  input.kind == "Pod"
  container := input.spec.containers[_]
  not container.resources.limits.cpu
  msg := sprintf("Container '%v' is missing a CPU limit", [container.name])
}

deny[msg] {
  input.kind == "Pod"
  container := input.spec.containers[_]
  not container.resources.limits.memory
  msg := sprintf("Container '%v' is missing a memory limit", [container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.cpu
  msg := sprintf("Deployment container '%v' is missing a CPU limit", [container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.memory
  msg := sprintf("Deployment container '%v' is missing a memory limit", [container.name])
}
```

```rego
# policies/kubernetes/no_latest_tag.rego
package main

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  has_latest(container.image)
  msg := sprintf(
    "Container '%v' uses image '%v' which has :latest tag",
    [container.name, container.image]
  )
}

has_latest(image) {
  endswith(image, ":latest")
}

has_latest(image) {
  not contains(image, ":")
}
```

### Running conftest Tests

```bash
# Test a single manifest
conftest test manifests/deployment.yaml \
  --policy policies/kubernetes/

# Test an entire directory
conftest test manifests/ \
  --policy policies/kubernetes/ \
  --all-namespaces

# Output in JSON for CI parsing
conftest test manifests/ \
  --policy policies/kubernetes/ \
  --output json | jq '.[] | select(.failures | length > 0)'

# Test with data files (for policies referencing data)
conftest test manifests/ \
  --policy policies/ \
  --data policies/data/

# TAP format for test reporter integration
conftest test manifests/ \
  --policy policies/kubernetes/ \
  --output tap
```

### Unit Tests for Rego Policies

OPA has a built-in test framework using the `test_` prefix convention.

```rego
# policies/kubernetes/required_limits_test.rego
package main

# Pod with no CPU limit should be denied
test_deny_pod_no_cpu_limit {
  deny[_] with input as {
    "kind": "Pod",
    "metadata": {"name": "test-pod"},
    "spec": {
      "containers": [{
        "name": "app",
        "image": "nginx:1.25",
        "resources": {
          "limits": {"memory": "128Mi"}
        }
      }]
    }
  }
}

# Pod with both limits should be allowed
test_allow_pod_with_limits {
  count(deny) == 0 with input as {
    "kind": "Pod",
    "metadata": {"name": "test-pod"},
    "spec": {
      "containers": [{
        "name": "app",
        "image": "nginx:1.25",
        "resources": {
          "limits": {
            "cpu": "500m",
            "memory": "128Mi"
          }
        }
      }]
    }
  }
}

# Deployment with missing limits should be denied
test_deny_deployment_no_limits {
  deny[_] with input as {
    "kind": "Deployment",
    "metadata": {"name": "test-deploy"},
    "spec": {
      "template": {
        "spec": {
          "containers": [{
            "name": "app",
            "image": "nginx:1.25",
            "resources": {}
          }]
        }
      }
    }
  }
}
```

```bash
# Run OPA unit tests
opa test policies/ -v

# Run with coverage report
opa test policies/ --coverage | jq '.coverage'

# Run tests matching a specific pattern
opa test policies/ -v -r "test_deny"
```

---

## Section 6: CI/CD Integration

### GitHub Actions Pipeline

```yaml
# .github/workflows/policy-check.yaml
name: Kubernetes Policy Check

on:
  pull_request:
    paths:
      - "manifests/**"
      - "helm/**"
      - "policies/**"

jobs:
  opa-unit-tests:
    name: OPA Policy Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install OPA
        run: |
          OPA_VERSION="0.68.0"
          curl -Lo opa \
            "https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}/opa_linux_amd64_static"
          chmod +x opa && sudo mv opa /usr/local/bin/
          opa version

      - name: Run unit tests with coverage
        run: |
          opa test policies/ --coverage --format json | tee coverage.json
          COVERAGE=$(jq '.coverage' coverage.json)
          echo "Policy coverage: ${COVERAGE}%"
          python3 -c "
          import json, sys
          with open('coverage.json') as f:
            data = json.load(f)
          if data['coverage'] < 80:
            print(f'Coverage {data[\"coverage\"]}% is below 80% threshold')
            sys.exit(1)
          "

  conftest-validation:
    name: Conftest Policy Validation
    runs-on: ubuntu-latest
    needs: opa-unit-tests
    steps:
      - uses: actions/checkout@v4

      - name: Install conftest
        run: |
          CONFTEST_VERSION="0.56.0"
          curl -Lo conftest.tar.gz \
            "https://github.com/open-policy-agent/conftest/releases/download/v${CONFTEST_VERSION}/conftest_${CONFTEST_VERSION}_Linux_x86_64.tar.gz"
          tar xzf conftest.tar.gz
          sudo mv conftest /usr/local/bin/

      - name: Install Helm
        uses: azure/setup-helm@v4
        with:
          version: "3.14.0"

      - name: Render Helm templates
        run: |
          helm template my-app ./helm/my-app \
            --values helm/my-app/values.yaml \
            --output-dir rendered/

      - name: Run conftest on rendered manifests
        run: |
          conftest test rendered/ \
            --policy policies/kubernetes/ \
            --output json | tee policy-results.json

          FAILURES=$(jq '[.[] | .failures | length] | add // 0' policy-results.json)
          echo "Total policy violations: ${FAILURES}"
          if [ "${FAILURES}" -gt 0 ]; then
            jq '.[] | select(.failures | length > 0)' policy-results.json
            exit 1
          fi

      - name: Upload policy results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: policy-results
          path: policy-results.json
```

---

## Section 7: The Gatekeeper Policy Library

The OPA Gatekeeper Policy Library is a community-maintained collection of ready-to-use ConstraintTemplates covering common security and compliance requirements.

### Installing Library Policies

```bash
# Clone the library
git clone https://github.com/open-policy-agent/gatekeeper-library.git
cd gatekeeper-library

# Install all general-purpose templates
kubectl apply -f library/general/

# Install Pod Security Policy equivalents
kubectl apply -f library/pod-security-policy/
```

### Using Library Policies for Pod Security Standards

The library includes templates that replicate Pod Security Standards in policy form with custom messaging and exclusion support.

```yaml
# Constraint: no host namespace sharing
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPHostNamespace
metadata:
  name: psp-host-namespace
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
```

```yaml
# Constraint: require non-root user context
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPAllowedUsers
metadata:
  name: psp-require-nonroot
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  parameters:
    runAsUser:
      rule: MustRunAsNonRoot
    runAsGroup:
      rule: MustRunAs
      ranges:
        - min: 1000
          max: 65535
    fsGroup:
      rule: MustRunAs
      ranges:
        - min: 1000
          max: 65535
```

---

## Section 8: Audit Mode and Violation Reporting

Gatekeeper's audit controller periodically re-evaluates all cached resources against all active constraints, identifying pre-existing violations from before policies were deployed.

### Checking Audit Results

```bash
# View total violations per constraint type
kubectl get constraints -A -o json | jq '
  [.items[] | {
    kind: .kind,
    name: .metadata.name,
    violations: (.status.totalViolations // 0),
    enforcementAction: .spec.enforcementAction
  }] | sort_by(-.violations)'

# View specific violation details for one constraint
kubectl describe k8srequiredlimits require-resource-limits

# Export all violations across all constraint types to CSV
kubectl get constraints --all-namespaces -o json | \
  jq -r '.items[] | .status.violations[]? |
    [.kind, .namespace, .name, .message] | @csv'
```

### Dry-Run Rollout Strategy

The recommended approach when introducing policies to production is to progress through enforcement stages:

```yaml
# Stage 1: dryrun — observe violations without blocking
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLimits
metadata:
  name: require-resource-limits
spec:
  enforcementAction: dryrun
  match:
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
```

```bash
# After 90+ seconds (audit cycle), count violations
kubectl get k8srequiredlimits require-resource-limits \
  -o jsonpath='{.status.totalViolations}'

# Promote to warn once violations are understood and remediated
kubectl patch k8srequiredlimits require-resource-limits \
  --type merge \
  --patch '{"spec":{"enforcementAction":"warn"}}'

# Final promotion to deny once all violations are resolved
kubectl patch k8srequiredlimits require-resource-limits \
  --type merge \
  --patch '{"spec":{"enforcementAction":"deny"}}'
```

### Prometheus Alerting for Violations

```yaml
# gatekeeper-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: gatekeeper-violation-alerts
  namespace: gatekeeper-system
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: gatekeeper
      rules:
        - alert: GatekeeperConstraintViolations
          expr: gatekeeper_violations > 0
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Gatekeeper constraint violations detected"
            description: >
              {{ $labels.constraint_kind }} '{{ $labels.constraint_name }}'
              has {{ $value }} violations.

        - alert: GatekeeperAuditStale
          expr: time() - gatekeeper_audit_last_run_time > 300
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Gatekeeper audit has not run recently"
            description: "Last audit was more than 5 minutes ago."

        - alert: GatekeeperWebhookHighLatency
          expr: |
            histogram_quantile(0.99,
              rate(gatekeeper_webhook_request_duration_seconds_bucket[5m])
            ) > 5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Gatekeeper webhook p99 latency is high"
            description: "p99 webhook latency is {{ $value }}s."
```

---

## Section 9: Mutation Policies

Gatekeeper's mutation feature allows policies to automatically inject or modify resource fields at admission time, enforcing defaults without requiring application teams to specify every security field.

### Enable the Mutation Webhook

```bash
helm upgrade gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --set enableMutation=true \
  --reuse-values
```

### AssignMetadata: Auto-Label Resources

```yaml
# mutation-add-labels.yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: AssignMetadata
metadata:
  name: add-managed-by-label
spec:
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod", "Deployment", "StatefulSet"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  location: "metadata.labels.managed-by"
  parameters:
    assign:
      value: "gatekeeper"
```

### Assign: Set Default Security Context

```yaml
# mutation-default-seccontext.yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: set-runasnonroot-default
spec:
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  location: "spec.securityContext.runAsNonRoot"
  parameters:
    assign:
      value: true
```

### ModifySet: Drop All Capabilities

```yaml
# mutation-drop-capabilities.yaml
apiVersion: mutations.gatekeeper.sh/v1
kind: ModifySet
metadata:
  name: drop-all-capabilities
spec:
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
  location: "spec.containers[name:*].securityContext.capabilities.drop"
  parameters:
    operation: merge
    values:
      fromList:
        - "ALL"
```

---

## Section 10: Debugging and Troubleshooting

### Test a Resource Against Constraints Before Applying

```bash
# Dry-run server-side to trigger admission webhooks
cat <<'EOF' | kubectl apply --dry-run=server -f -
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
  namespace: default
spec:
  containers:
    - name: app
      image: nginx
EOF
# Expected: error from server (Forbidden): ...
```

### Inspect Constraint Status

```bash
# Get full violation list with context
kubectl get k8srequiredlimits require-resource-limits -o json | jq '
  {
    totalViolations: .status.totalViolations,
    enforcementAction: .spec.enforcementAction,
    violations: [.status.violations[]? | {kind, namespace, name, message}]
  }'
```

### Enable Verbose Gatekeeper Logging

```bash
# Temporarily increase log verbosity
kubectl patch deployment gatekeeper-controller-manager \
  -n gatekeeper-system \
  --type json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--log-level=DEBUG"}]'

# Stream logs from all Gatekeeper pods with denial filtering
kubectl logs -n gatekeeper-system \
  -l control-plane=controller-manager \
  --prefix \
  -f | grep -E "denied|violation|error"
```

### Local Policy Testing with OPA CLI

```bash
# Create a test input file matching the AdmissionReview structure
cat > sample_input.json << 'EOF'
{
  "review": {
    "object": {
      "apiVersion": "v1",
      "kind": "Pod",
      "metadata": {
        "name": "test-pod",
        "namespace": "default"
      },
      "spec": {
        "containers": [
          {
            "name": "app",
            "image": "nginx",
            "resources": {}
          }
        ]
      }
    }
  },
  "parameters": {
    "exemptContainers": []
  }
}
EOF

# Evaluate the Rego policy directly
opa eval \
  --input sample_input.json \
  --data policies/kubernetes/required_limits_gatekeeper.rego \
  'data.k8srequiredlimits.violation' \
  --format pretty
```

### Common Issues Reference

```bash
# Issue: ConstraintTemplate stuck in Creating
kubectl describe constrainttemplate k8srequiredlimits | grep -A 10 Events
# Check for Rego syntax errors or missing target field

# Validate Rego syntax before applying
opa parse policies/kubernetes/required_limits.rego

# Issue: Constraint shows 0 violations but violations exist
# Verify resources are being synced into the cache
kubectl get config -n gatekeeper-system config \
  -o jsonpath='{.spec.sync.syncOnly}' | jq .

# Issue: Webhook timing out and blocking all admissions
# Check failure policy — Ignore prevents cluster lock-out
kubectl get validatingwebhookconfiguration \
  gatekeeper-validating-webhook-configuration \
  -o jsonpath='{.webhooks[0].failurePolicy}'

# Issue: Audit not running
kubectl logs -n gatekeeper-system \
  -l control-plane=audit-controller \
  --tail=50 | grep -E "audit|error"
```

---

## Section 11: Multi-Cluster Policy Governance with GitOps

### Policy Repository Structure

```
k8s-policies/
├── templates/
│   ├── k8srequiredlimits.yaml
│   ├── k8snolatesttag.yaml
│   ├── k8srequiredlabels.yaml
│   └── k8sallowedrepos.yaml
├── constraints/
│   ├── base/
│   │   ├── kustomization.yaml
│   │   ├── required-limits.yaml
│   │   └── no-latest-tag.yaml
│   ├── production/
│   │   ├── kustomization.yaml
│   │   └── patch-enforce-deny.yaml
│   └── development/
│       ├── kustomization.yaml
│       └── patch-enforce-warn.yaml
└── tests/
    ├── fixtures/
    │   ├── valid-deployment.yaml
    │   └── invalid-deployment.yaml
    └── policies/
        ├── required_limits.rego
        └── required_limits_test.rego
```

### ArgoCD Application for Policy Distribution

```yaml
# argocd-app-gatekeeper-policies.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gatekeeper-policies
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: "https://git.company.internal/platform/k8s-policies"
    targetRevision: main
    path: constraints/production
    kustomize: {}
  destination:
    server: "https://kubernetes.default.svc"
    namespace: gatekeeper-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
  # Prevent ArgoCD from treating status fields as drift
  ignoreDifferences:
    - group: "constraints.gatekeeper.sh"
      kind: "*"
      jsonPointers:
        - /status
    - group: "templates.gatekeeper.sh"
      kind: "ConstraintTemplate"
      jsonPointers:
        - /status
```

---

## Section 12: Performance Tuning

### Limiting Webhook Scope

Narrowing the `ValidatingWebhookConfiguration` rules to only the resource kinds covered by active constraints reduces unnecessary API server overhead.

```yaml
# Restrict webhook to only resources covered by policies
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: gatekeeper-validating-webhook-configuration
webhooks:
  - name: validation.gatekeeper.sh
    rules:
      - apiGroups: ["*"]
        apiVersions: ["*"]
        operations: ["CREATE", "UPDATE"]
        resources:
          - "pods"
          - "deployments"
          - "statefulsets"
          - "daemonsets"
          - "namespaces"
          - "ingresses"
    failurePolicy: Ignore
    timeoutSeconds: 15
    objectSelector:
      matchExpressions:
        - key: "policy.gatekeeper.sh/skip"
          operator: NotIn
          values: ["true"]
```

### Gatekeeper Controller Resource Tuning

```yaml
# values-production.yaml (Helm values)
controllerManager:
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2"
      memory: "1Gi"
  replicas: 3

audit:
  resources:
    requests:
      cpu: "200m"
      memory: "256Mi"
    limits:
      cpu: "1"
      memory: "512Mi"
  # Tune based on cluster size — larger clusters need longer intervals
  auditInterval: 120
  # Prevent memory pressure from large violation lists
  constraintViolationsLimit: 50
  # Resources evaluated per audit batch
  auditChunkSize: 500
```

---

OPA Gatekeeper transforms cluster governance from a reactive, manual process into a proactive, automated one. By expressing compliance requirements as Rego policies, platform teams gain version-controlled, testable, auditable enforcement that scales across entire fleets. The combination of admission-time blocking, audit-time violation reporting, conftest pre-commit testing, and GitOps distribution provides defense-in-depth for enterprise Kubernetes environments at any scale.
