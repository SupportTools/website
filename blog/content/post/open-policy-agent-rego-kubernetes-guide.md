---
title: "Open Policy Agent: Rego Policy Language for Kubernetes Authorization"
date: 2027-04-10T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Gatekeeper", "Rego", "Policy", "Security"]
categories: ["Kubernetes", "Security", "Policy Enforcement"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Open Policy Agent with Gatekeeper on Kubernetes, covering Rego policy language fundamentals, ConstraintTemplate and Constraint CRDs, data replication for context-aware policies, external data providers, mutation webhooks, audit mode, and policy testing with OPA Playground and conftest."
more_link: "yes"
url: "/open-policy-agent-rego-kubernetes-guide/"
---

Open Policy Agent (OPA) with Gatekeeper brings the full expressive power of the Rego policy language to Kubernetes admission control. While Kyverno provides a YAML-native approach, OPA/Gatekeeper targets teams that need general-purpose policy logic, share policies across multiple systems (Kubernetes, CI pipelines, Terraform), or require the advanced data querying that Rego enables. The two-layer abstraction — ConstraintTemplates define the policy logic in Rego, and Constraints instantiate those templates with specific parameters — separates policy authoring from policy configuration.

This guide covers Gatekeeper's architecture, Rego fundamentals applied to Kubernetes objects, context-aware policies through data replication, mutation webhooks, and a full testing workflow with the OPA CLI and conftest.

<!--more-->

## OPA vs Kyverno Positioning

Both tools integrate with the Kubernetes admission controller webhook but differ in approach:

| Aspect | OPA/Gatekeeper | Kyverno |
|---|---|---|
| Policy Language | Rego (general purpose) | YAML-native |
| Learning curve | Higher (Rego required) | Lower |
| Cross-system reuse | Strong (CLI, CI, Terraform) | Kubernetes-only |
| Generate rules | No built-in | Yes |
| Mutation | Assign/AssignMetadata CRDs | patchStrategicMerge/JSON6902 |
| Image verification | No built-in | Yes (Cosign) |
| Data queries | Full Rego data.* | Context with limited JMESPath |

Choose Gatekeeper when the organization already uses OPA for non-Kubernetes policy (API authorization, Terraform, CI validation) and wants a single policy language. Choose Kyverno for simpler configuration-driven policies, generate rules, and built-in image verification.

## Gatekeeper Architecture

### Components

```
kube-apiserver
      │
      │ AdmissionRequest
      ▼
Gatekeeper Webhook Pod ──► Constraint evaluation (Rego) ──► Allow/Deny
      │                           │
      │               Data replication cache
      │               (namespaces, pods, services...)
      │
Audit Controller ──────► Periodically evaluates all existing resources
                         Reports violations in ConstraintStatus
```

### Gatekeeper Installation

```bash
# Install via Helm (recommended for production configuration control)
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --version "3.16.0" \
  --set "replicaCount=3" \
  --set "auditInterval=60" \
  --set "constraintViolationsLimit=100" \
  --set "logLevel=INFO" \
  --set "resources.requests.cpu=100m" \
  --set "resources.requests.memory=512Mi" \
  --set "resources.limits.cpu=1" \
  --set "resources.limits.memory=1Gi"
```

```yaml
# gatekeeper-system/values-production.yaml

replicaCount: 3

# Audit runs at this interval in seconds
auditInterval: 60

# Maximum violations to store per constraint
constraintViolationsLimit: 100

# Audit can be resource-intensive — tune based on cluster size
auditMatchKindOnly: false
auditChunkSize: 500

resources:
  requests:
    cpu: "200m"
    memory: "512Mi"
  limits:
    cpu: "2"
    memory: "2Gi"

podDisruptionBudget:
  minAvailable: 2

# Emit Prometheus metrics
metricsBackend: prometheus

# Webhook timeout — API server waits up to this many seconds
webhookTimeoutSeconds: 10

# failurePolicy: Fail is the safe default — rejects requests if webhook is down
# Consider Ignore for non-critical policies during initial rollout
emitAdmissionEvents: true
emitAuditEvents: true
```

## Rego Language Fundamentals

### Rules, Functions, and Comprehensions

```rego
# lib/kubernetes.rego — reusable library for Kubernetes policies

package lib.kubernetes

# A simple rule — evaluates to true if the condition holds
is_container := true {
  # The input document is the Kubernetes resource being evaluated
  input.kind == "Pod"
  count(input.spec.containers) > 0
}

# Function that returns all containers in a pod spec
# includes initContainers and ephemeralContainers
all_containers(pod_spec) := containers {
  containers := array.concat(
    object.get(pod_spec, "containers", []),
    array.concat(
      object.get(pod_spec, "initContainers", []),
      object.get(pod_spec, "ephemeralContainers", [])
    )
  )
}

# Rule using comprehension to collect all image names
container_images(containers) := images {
  images := {c.image | c := containers[_]}
}

# Function that checks if a string matches any regex in a set
matches_any(value, patterns) {
  pattern := patterns[_]
  regex.match(pattern, value)
}

# Rule that checks resource limits are set on a container
has_resource_limits(container) {
  container.resources.limits.cpu
  container.resources.limits.memory
}

# Rule checking that a container runs as non-root
runs_as_non_root(container) {
  # Check at container level first
  container.securityContext.runAsNonRoot == true
}

runs_as_non_root(container) {
  # Check at container level with runAsUser != 0
  container.securityContext.runAsUser > 0
}
```

```rego
# lib/exemptions.rego — shared exemption handling

package lib.exemptions

# Check if the resource has the exemption annotation
# Usage: lib.exemptions.is_exempt with data.exemptions as the config
is_exempt {
  # Check for the bypass annotation
  input.review.object.metadata.annotations["policy.support.tools/exempt"] == "true"
}

is_exempt {
  # Check if the namespace is in the exempt list
  namespace := input.review.object.metadata.namespace
  data.inventory.cluster.v1.Namespace[namespace].metadata.labels["policy.support.tools/exempt"] == "true"
}
```

### Built-in Functions and Data Sources

```rego
# Demonstrate built-in usage for policy logic

package policies.demo

import future.keywords.in
import future.keywords.every
import future.keywords.if
import future.keywords.contains

# String operations
valid_registry(image) if {
  # Check if image starts with an approved registry prefix
  approved_prefixes := {
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/",
    "ghcr.io/acme-corp/",
    "gcr.io/acme-corp-prod/"
  }
  some prefix in approved_prefixes
  startswith(image, prefix)
}

# Object operations
missing_labels(resource) := missing if {
  required := {"app.kubernetes.io/name", "app.kubernetes.io/version"}
  present := {k | resource.metadata.labels[k]}
  missing := required - present
}

# Array/set operations
privileged_containers(pod) := containers if {
  containers := [c.name |
    c := pod.spec.containers[_]
    c.securityContext.privileged == true
  ]
}

# Numeric comparisons
excessive_replicas(deployment) if {
  deployment.spec.replicas > 100
}

# Regular expressions
valid_image_tag(image) if {
  # Reject 'latest' tag — must use specific version
  parts := split(image, ":")
  count(parts) == 2
  tag := parts[1]
  tag != "latest"
  # Tag must be semver-like or a commit SHA (40 hex chars)
  regex.match(`^(v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?|[0-9a-f]{40})$`, tag)
}
```

## ConstraintTemplate and Constraint CRDs

### ConstraintTemplate with Embedded Rego

```yaml
# templates/k8srequiredlabels.yaml
# ConstraintTemplate that requires specific labels on resources

apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    metadata.gatekeeper.sh/title: "Required Labels"
    metadata.gatekeeper.sh/description: >-
      Requires specified labels to be present on resources.
      Used to enforce team ownership, cost allocation, and environment labeling.
    metadata.gatekeeper.sh/version: "1.0.1"
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            # Parameters that Constraint instances pass to this template
            labels:
              type: array
              description: "List of required label keys"
              items:
                type: object
                properties:
                  key:
                    type: string
                    description: "Required label key"
                  allowedRegex:
                    type: string
                    description: "Optional regex the label value must match"
            message:
              type: string
              description: "Custom violation message"

  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        import future.keywords.in

        # violation is the special rule name Gatekeeper looks for
        # It must produce a set of objects with a "msg" field
        violation[{"msg": msg}] {
          # Get the list of required labels from the Constraint's parameters
          label_config := input.parameters.labels[_]
          key := label_config.key

          # Check if the label is present
          not input.review.object.metadata.labels[key]

          # Format the violation message
          msg := sprintf(
            "Resource '%v/%v' is missing required label '%v'",
            [
              input.review.object.metadata.namespace,
              input.review.object.metadata.name,
              key
            ]
          )
        }

        violation[{"msg": msg}] {
          # Check label value matches regex if allowedRegex is specified
          label_config := input.parameters.labels[_]
          key := label_config.key
          regex_pattern := label_config.allowedRegex
          regex_pattern != ""

          # Label exists but value doesn't match the regex
          value := input.review.object.metadata.labels[key]
          not regex.match(regex_pattern, value)

          msg := sprintf(
            "Label '%v' on resource '%v/%v' has value '%v' which does not match pattern '%v'",
            [
              key,
              input.review.object.metadata.namespace,
              input.review.object.metadata.name,
              value,
              regex_pattern
            ]
          )
        }
```

### Constraint Instantiation

```yaml
# constraints/require-deployment-labels.yaml
# Constraint requiring specific labels on Deployments

apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-deployment-labels
spec:
  # enforcement action: deny, warn, or dryrun
  enforcementAction: deny

  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment"]
    # Exclude system namespaces from this constraint
    excludedNamespaces:
      - kube-system
      - kube-public
      - gatekeeper-system
      - cert-manager

  parameters:
    labels:
      - key: "app.kubernetes.io/name"
        allowedRegex: "^[a-z][a-z0-9-]{0,62}$"
      - key: "app.kubernetes.io/version"
      - key: "support.tools/team"
      - key: "support.tools/cost-center"
        allowedRegex: "^CC-[0-9]{4,6}$"
    message: "Required labels missing. See https://docs.acme-corp.example.com/labeling-standards"
```

### Advanced ConstraintTemplate: Container Security

```yaml
# templates/k8scontainersecurity.yaml
# Comprehensive container security policy

apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8scontainersecurity
  annotations:
    metadata.gatekeeper.sh/title: "Container Security Standards"
spec:
  crd:
    spec:
      names:
        kind: K8sContainerSecurity
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowPrivileged:
              type: boolean
              default: false
            allowPrivilegeEscalation:
              type: boolean
              default: false
            requiredDropCapabilities:
              type: array
              items:
                type: string
            allowedRegistries:
              type: array
              items:
                type: string

  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8scontainersecurity

        import future.keywords.in
        import future.keywords.every

        # Collect all containers (regular, init, ephemeral)
        all_containers := containers {
          containers := array.concat(
            object.get(input.review.object.spec, "containers", []),
            array.concat(
              object.get(input.review.object.spec, "initContainers", []),
              object.get(input.review.object.spec, "ephemeralContainers", [])
            )
          )
        }

        # Rule 1: No privileged containers unless explicitly allowed
        violation[{"msg": msg}] {
          not input.parameters.allowPrivileged
          c := all_containers[_]
          c.securityContext.privileged == true
          msg := sprintf("Container '%v' is running as privileged, which is not allowed", [c.name])
        }

        # Rule 2: No privilege escalation unless explicitly allowed
        violation[{"msg": msg}] {
          not input.parameters.allowPrivilegeEscalation
          c := all_containers[_]
          # allowPrivilegeEscalation defaults to true if unset — must be explicitly false
          not c.securityContext.allowPrivilegeEscalation == false
          msg := sprintf(
            "Container '%v' must explicitly set allowPrivilegeEscalation: false",
            [c.name]
          )
        }

        # Rule 3: Required capabilities must be dropped
        violation[{"msg": msg}] {
          required_drop := input.parameters.requiredDropCapabilities
          count(required_drop) > 0
          c := all_containers[_]

          # Check if the required drop is present
          required_cap := required_drop[_]
          dropped := {cap | cap := c.securityContext.capabilities.drop[_]}
          not required_cap in dropped
          not "ALL" in dropped

          msg := sprintf(
            "Container '%v' must drop capability '%v' (or drop ALL)",
            [c.name, required_cap]
          )
        }

        # Rule 4: Images must come from allowed registries
        violation[{"msg": msg}] {
          count(input.parameters.allowedRegistries) > 0
          c := all_containers[_]
          not any_registry_matches(c.image, input.parameters.allowedRegistries)
          msg := sprintf(
            "Container '%v' image '%v' is not from an allowed registry",
            [c.name, c.image]
          )
        }

        # Helper: check if image starts with any allowed registry
        any_registry_matches(image, registries) {
          registry := registries[_]
          startswith(image, registry)
        }
```

## Data Replication for Context-Aware Policies

### Config CRD for Data Replication

```yaml
# gatekeeper-system/config.yaml
# Configure which resources are replicated into OPA's data store

apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  sync:
    syncOnly:
      # Replicate these resources for use in policy context queries
      - group: ""
        version: "v1"
        kind: "Namespace"
      - group: ""
        version: "v1"
        kind: "Pod"
      - group: ""
        version: "v1"
        kind: "Service"
      - group: ""
        version: "v1"
        kind: "ServiceAccount"
      - group: "apps"
        version: "v1"
        kind: "Deployment"
      - group: "networking.k8s.io"
        version: "v1"
        kind: "Ingress"
      - group: "rbac.authorization.k8s.io"
        version: "v1"
        kind: "ClusterRole"
      - group: "rbac.authorization.k8s.io"
        version: "v1"
        kind: "ClusterRoleBinding"

  # Validation: check if webhook response was correct for troubleshooting
  validation:
    traces:
      - user: "alice@acme-corp.example.com"
        kind:
          group: ""
          kind: "Pod"
        dump: "All"
```

### Policies Using Replicated Data

```yaml
# templates/k8suniqueserviceselector.yaml
# Policy that uses data replication to detect service selector conflicts

apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8suniqueserviceselector
spec:
  crd:
    spec:
      names:
        kind: K8sUniqueServiceSelector
      validation:
        openAPIV3Schema:
          type: object

  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8suniqueserviceselector

        # data.inventory contains the replicated Kubernetes objects
        # Format: data.inventory.namespace.<namespace>.<apiVersion>.<Kind>.<name>

        violation[{"msg": msg}] {
          input.review.kind.kind == "Service"
          svc := input.review.object
          namespace := svc.metadata.namespace

          # Get all existing services in the namespace from replicated data
          existing := data.inventory.namespace[namespace]["v1"].Service
          existing_svc := existing[svc_name]

          # Skip the service being updated (same name)
          svc_name != svc.metadata.name

          # Check if selectors match
          existing_svc.spec.selector == svc.spec.selector

          msg := sprintf(
            "Service '%v' has duplicate selector with existing service '%v' in namespace '%v'",
            [svc.metadata.name, svc_name, namespace]
          )
        }
```

```yaml
# templates/k8sserviceaccountbinding.yaml
# Detect over-privileged service account bindings using data replication

apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sserviceaccountbinding
spec:
  crd:
    spec:
      names:
        kind: K8sServiceAccountBinding
      validation:
        openAPIV3Schema:
          type: object
          properties:
            prohibitedRoles:
              type: array
              items:
                type: string

  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sserviceaccountbinding

        import future.keywords.in

        # Check if a pod's service account has prohibited role bindings
        violation[{"msg": msg}] {
          input.review.kind.kind == "Pod"
          pod := input.review.object
          namespace := pod.metadata.namespace
          sa_name := object.get(pod.spec, "serviceAccountName", "default")

          # Look up ClusterRoleBindings from replicated data
          crb := data.inventory.cluster["rbac.authorization.k8s.io/v1"].ClusterRoleBinding[_]

          # Check if this CRB binds the pod's service account
          subject := crb.subjects[_]
          subject.kind == "ServiceAccount"
          subject.name == sa_name
          subject.namespace == namespace

          # Check if the bound role is in the prohibited list
          crb.roleRef.name in input.parameters.prohibitedRoles

          msg := sprintf(
            "Pod '%v' uses service account '%v' which is bound to prohibited ClusterRole '%v'",
            [pod.metadata.name, sa_name, crb.roleRef.name]
          )
        }
```

## External Data Providers

### ExternalData Provider for Runtime Context

```yaml
# external-data/provider.yaml — External data provider configuration

apiVersion: externaldata.gatekeeper.sh/v1beta1
kind: Provider
metadata:
  name: vulnerability-scanner
spec:
  # URL of the external data server
  url: "https://vuln-scanner.gatekeeper-system.svc.cluster.local:8443/validate"

  # TLS configuration
  caBundle: |
    -----BEGIN CERTIFICATE-----
    MIIBxTCCAW+gAwIBAgIJAMvDlb4OzCRzMA0GCSqGSIb3DQEBBQUAMCMxITAfBgNV
    [... certificate content ...]
    -----END CERTIFICATE-----

  timeout: 10  # seconds
```

```yaml
# templates/k8svulnscan.yaml — Policy using external data provider

apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8svulnscan
spec:
  crd:
    spec:
      names:
        kind: K8sVulnScan
      validation:
        openAPIV3Schema:
          type: object
          properties:
            maxCvssScore:
              type: number
              description: "Maximum allowed CVSS score for container images"

  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8svulnscan

        import future.keywords.in

        violation[{"msg": msg}] {
          # Build the list of images to check
          images := [c.image | c := input.review.object.spec.containers[_]]

          # Query the external data provider
          response := external_data({"provider": "vulnerability-scanner", "keys": images})
          count(response.errors) == 0

          # Process the response
          image_result := response.items[_]
          image_result.value.maxCvss > input.parameters.maxCvssScore

          msg := sprintf(
            "Image '%v' has CVSS score %.1f which exceeds maximum allowed %.1f",
            [image_result.key, image_result.value.maxCvss, input.parameters.maxCvssScore]
          )
        }

        violation[{"msg": msg}] {
          images := [c.image | c := input.review.object.spec.containers[_]]
          response := external_data({"provider": "vulnerability-scanner", "keys": images})

          # Report external data provider errors
          error := response.errors[_]
          msg := sprintf(
            "External data provider error for image '%v': %v",
            [error.key, error.error]
          )
        }
```

## Mutation Webhooks with Assign and AssignMetadata

### Assign CRD for Value Mutation

```yaml
# mutations/assign-security-context.yaml
# Assign default security context to containers missing it

apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: assign-container-security-context
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
      - gatekeeper-system

  location: "spec.containers[name:*].securityContext.allowPrivilegeEscalation"

  parameters:
    assign:
      value: false

---
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: assign-container-drop-capabilities
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
      - monitoring  # Node exporter needs NET_ADMIN

  location: "spec.containers[name:*].securityContext.capabilities.drop"

  parameters:
    assign:
      value:
        - "ALL"
```

### AssignMetadata CRD for Labels and Annotations

```yaml
# mutations/assign-metadata-labels.yaml
# Stamp standard labels on all Pods at admission time

apiVersion: mutations.gatekeeper.sh/v1
kind: AssignMetadata
metadata:
  name: stamp-managed-by
spec:
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["*"]
        kinds:
          - Pod
          - Deployment
          - StatefulSet
    excludedNamespaces:
      - kube-system
      - kube-public

  location: "metadata.labels.app\\.kubernetes\\.io/managed-by"

  parameters:
    assign:
      value: "gatekeeper"

---
apiVersion: mutations.gatekeeper.sh/v1
kind: AssignMetadata
metadata:
  name: stamp-environment-label
spec:
  match:
    scope: Namespaced
    kinds:
      - apiGroups: ["*"]
        kinds: ["Pod"]
    # Only apply to namespaces with the environment label
    namespaceSelector:
      matchExpressions:
        - key: "support.tools/environment"
          operator: Exists

  location: "metadata.labels.support\\.tools/environment"

  parameters:
    # Use fromMetadata to copy the value from the namespace label
    assign:
      fromMetadata:
        field: "namespaceName"  # Not available — use external data instead
      # For now, use a static value per constraint instance
      value: "prod"
```

## Audit Mode and Violation Reports

### Enforcement Actions

```yaml
# constraints/dryrun-first.yaml — Roll out with dryrun before enforce

apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: require-labels-dryrun
spec:
  # dryrun: record violations but don't block requests
  # Use this to understand the blast radius before enforcing
  enforcementAction: dryrun

  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment"]

  parameters:
    labels:
      - key: "app.kubernetes.io/name"
      - key: "support.tools/team"
```

```bash
# Audit workflow: check violations before switching to enforce

# View violations for a specific constraint
kubectl get k8srequiredlabels.constraints.gatekeeper.sh require-labels-dryrun \
  -o jsonpath='{.status.violations}' | jq .

# Count violations per namespace
kubectl get k8srequiredlabels.constraints.gatekeeper.sh require-labels-dryrun \
  -o json | jq '[.status.violations[] | .namespace] | group_by(.) | map({namespace: .[0], count: length}) | sort_by(-.count)'

# List all resources violating any constraint
kubectl get constraints --all-namespaces \
  -o json | jq '[.items[] | {
    constraint: .metadata.name,
    violations: .status.violations
  } | select(.violations != null)] | .[].violations[]'

# Once comfortable, switch to warn (shows violation message but allows request)
kubectl patch k8srequiredlabels.constraints.gatekeeper.sh require-labels-dryrun \
  --type merge \
  --patch '{"spec":{"enforcementAction":"warn"}}'

# Finally switch to deny when all existing violations are remediated
kubectl patch k8srequiredlabels.constraints.gatekeeper.sh require-labels-dryrun \
  --type merge \
  --patch '{"spec":{"enforcementAction":"deny"}}'
```

## Policy Testing with OPA CLI

### Unit Tests with opa test

```rego
# tests/k8srequiredlabels_test.rego

package k8srequiredlabels_test

import future.keywords.if

import data.k8srequiredlabels

# Mock input for a Deployment with all required labels
test_deployment_with_labels if {
  count(k8srequiredlabels.violation) == 0 with input as {
    "parameters": {
      "labels": [
        {"key": "app.kubernetes.io/name"},
        {"key": "support.tools/team"}
      ]
    },
    "review": {
      "object": {
        "metadata": {
          "name": "my-app",
          "namespace": "payments",
          "labels": {
            "app.kubernetes.io/name": "my-app",
            "support.tools/team": "payments"
          }
        }
      }
    }
  }
}

# Mock input for a Deployment missing required labels
test_deployment_missing_labels if {
  count(k8srequiredlabels.violation) == 2 with input as {
    "parameters": {
      "labels": [
        {"key": "app.kubernetes.io/name"},
        {"key": "support.tools/team"}
      ]
    },
    "review": {
      "object": {
        "metadata": {
          "name": "unlabeled-app",
          "namespace": "payments",
          "labels": {}
        }
      }
    }
  }
}

# Test regex validation on label value
test_deployment_invalid_label_value if {
  count(k8srequiredlabels.violation) == 1 with input as {
    "parameters": {
      "labels": [
        {
          "key": "support.tools/cost-center",
          "allowedRegex": "^CC-[0-9]{4,6}$"
        }
      ]
    },
    "review": {
      "object": {
        "metadata": {
          "name": "my-app",
          "namespace": "payments",
          "labels": {
            "support.tools/cost-center": "InvalidFormat"
          }
        }
      }
    }
  }
}
```

```bash
# Run OPA unit tests

# Install OPA CLI
curl -L -o /usr/local/bin/opa \
  "https://openpolicyagent.org/downloads/v0.63.0/opa_linux_amd64_static"
chmod +x /usr/local/bin/opa

# Run all tests in the policies directory
opa test policies/ tests/ --verbose

# Run tests with coverage report
opa test policies/ tests/ --coverage | jq '.files | to_entries[] | {file: .key, coverage: .value.coverage}'

# Test a specific policy with detailed output
opa test policies/k8srequiredlabels.rego tests/k8srequiredlabels_test.rego -v

# Check policy syntax
opa check policies/*.rego

# Format policies consistently
opa fmt --write policies/*.rego
```

## Conftest for CI Pipeline Validation

### Conftest Policy for Kubernetes Manifests

```rego
# policy/kubernetes/deny_latest_tag.rego
# Used with conftest to validate Kubernetes manifests in CI

package main

import future.keywords.in
import future.keywords.every

deny[msg] {
  input.kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}

  container := input.spec.template.spec.containers[_]
  image := container.image

  # Check for missing tag (image:latest or just image without tag)
  not contains(image, ":")
  msg := sprintf(
    "Container '%v' uses image '%v' without a tag. Specify a version tag.",
    [container.name, image]
  )
}

deny[msg] {
  input.kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}

  container := input.spec.template.spec.containers[_]
  parts := split(container.image, ":")
  count(parts) == 2
  parts[1] == "latest"

  msg := sprintf(
    "Container '%v' uses 'latest' tag. Use a specific version tag for reproducibility.",
    [container.name]
  )
}

warn[msg] {
  input.kind == "Deployment"
  not input.spec.strategy.type

  msg := "Deployment does not specify a rollout strategy. Consider RollingUpdate with explicit maxSurge/maxUnavailable."
}
```

```rego
# policy/kubernetes/require_resources.rego

package main

import future.keywords.in

deny[msg] {
  input.kind in {"Deployment", "StatefulSet", "DaemonSet"}

  container := input.spec.template.spec.containers[_]

  not container.resources.requests.cpu
  msg := sprintf(
    "Container '%v' in %v '%v' is missing CPU request",
    [container.name, input.kind, input.metadata.name]
  )
}

deny[msg] {
  input.kind in {"Deployment", "StatefulSet", "DaemonSet"}

  container := input.spec.template.spec.containers[_]
  not container.resources.limits.memory

  msg := sprintf(
    "Container '%v' in %v '%v' is missing memory limit",
    [container.name, input.kind, input.metadata.name]
  )
}
```

```bash
# CI integration with conftest

# Install conftest
curl -L \
  "https://github.com/open-policy-agent/conftest/releases/download/v0.50.0/conftest_0.50.0_Linux_x86_64.tar.gz" \
  | tar -xz -C /usr/local/bin conftest

# Test Kubernetes manifests in the k8s/ directory
conftest test k8s/ --policy policy/kubernetes/ --all-namespaces

# Test with multiple input formats
conftest test k8s/deployment.yaml --policy policy/kubernetes/ --output json

# Test Helm chart output
helm template my-app ./charts/my-app -f environments/prod/values.yaml \
  | conftest test - --policy policy/kubernetes/

# GitHub Actions step example
# - name: Validate Kubernetes manifests
#   run: |
#     conftest test k8s/ --policy policy/kubernetes/ \
#       --output github \
#       --update github.com/open-policy-agent/library/kubernetes
```

### Using the OPA Policy Library

```bash
# Gatekeeper Policy Library — pre-built templates maintained by OPA community
# https://open-policy-agent.github.io/gatekeeper-library/

# Install the library via kustomize
kubectl apply -k "https://github.com/open-policy-agent/gatekeeper-library/library/general?ref=v0.6.0"

# Available templates from the library:
# - K8sAllowedRepos: allowed container registries
# - K8sBlockNodePort: prohibit NodePort services
# - K8sContainerLimits: require resource limits
# - K8sDisallowedTags: prohibit specific image tags
# - K8sExternalIPs: control ExternalIPs on services
# - K8sPSPPrivilegedContainer: prohibit privileged containers
# - K8sRequiredAnnotations: require specific annotations
# - K8sRequiredLabels: require specific labels

# Apply a constraint using the library template
kubectl apply -f - <<'EOF'
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
      - "123456789012.dkr.ecr.us-east-1.amazonaws.com/"
      - "ghcr.io/acme-corp/"
      - "gcr.io/acme-corp-prod/"
EOF
```

Gatekeeper's ConstraintTemplate/Constraint separation enables policy administrators to define reusable policy logic while delegating parameter configuration to team leads or cluster administrators. Data replication brings full cluster context into policy decisions, external data providers extend that context to runtime systems, and the OPA test framework ensures every policy has unit tests before it ever reaches a real cluster.
