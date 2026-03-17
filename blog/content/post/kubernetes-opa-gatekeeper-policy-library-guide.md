---
title: "Kubernetes OPA Gatekeeper Policy Library: Common Constraints and Custom Rules"
date: 2028-04-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Gatekeeper", "Policy", "Rego", "Security"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to building a production OPA Gatekeeper policy library covering resource limits, image policies, network controls, RBAC constraints, and custom Rego rules for enterprise Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-opa-gatekeeper-policy-library-guide/"
---

OPA Gatekeeper enforces policy as code in Kubernetes by intercepting admission requests and evaluating them against Rego rules. A well-structured policy library prevents entire classes of misconfigurations from reaching production. This guide builds a complete, reusable library of ConstraintTemplates and Constraints covering resource management, image governance, network policy enforcement, RBAC boundaries, and custom business rules.

<!--more-->

# Kubernetes OPA Gatekeeper Policy Library: Common Constraints and Custom Rules

## Gatekeeper Architecture Review

Gatekeeper runs as a ValidatingAdmissionWebhook that Kubernetes calls for every create, update, and delete operation on any configured resource type. When a request arrives, Gatekeeper evaluates it against all active Constraints. A violation causes the request to be denied with a descriptive error message.

The two-layer model:

- **ConstraintTemplate**: Defines the Rego policy logic and the schema for its configuration parameters. Think of it as a policy class.
- **Constraint**: An instance of a ConstraintTemplate with specific parameter values and scope (namespaces, resource kinds). Think of it as a policy instance.

This separation allows a single ConstraintTemplate to be instantiated multiple times with different parameters - for example, enforcing different allowed image registries in production vs development namespaces.

```
kubectl apply → API Server → ValidatingAdmissionWebhook
                                        ↓
                              Gatekeeper Controller
                                        ↓
                         Evaluate Rego (ConstraintTemplate)
                         against request + parameters (Constraint)
                                        ↓
                              Allow / Deny + Violation Message
```

## Installing Gatekeeper

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --version 3.17.0 \
  --set replicas=3 \
  --set controllerManager.resources.requests.cpu=100m \
  --set controllerManager.resources.requests.memory=512Mi \
  --set audit.resources.requests.cpu=100m \
  --set audit.resources.requests.memory=512Mi \
  --set auditInterval=60 \
  --set auditMatchKindOnly=true \
  --set enableExternalData=true \
  --set logLevel=WARNING
```

Verify installation:

```bash
kubectl get pods -n gatekeeper-system
kubectl get constrainttemplates
```

## Policy Library Structure

Organize policies in a git repository:

```
gatekeeper-policies/
├── templates/                  # ConstraintTemplates (policy definitions)
│   ├── resource-limits/
│   ├── image-policy/
│   ├── network-policy/
│   ├── rbac/
│   └── custom/
├── constraints/                # Constraint instances
│   ├── production/
│   ├── staging/
│   └── default/
└── tests/                      # Rego unit tests
    └── *.rego
```

## Resource Management Policies

### Require Resource Limits and Requests

Every container must specify CPU and memory limits to prevent resource contention:

```yaml
# templates/resource-limits/require-resource-limits.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireresourcelimits
  annotations:
    metadata.gatekeeper.sh/title: "Require Resource Limits"
    metadata.gatekeeper.sh/version: "1.0.0"
    description: >-
      Requires all containers to have CPU and memory resource limits and requests set.
      Optionally enforces minimum and maximum values.
spec:
  crd:
    spec:
      names:
        kind: RequireResourceLimits
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptContainers:
              type: array
              items:
                type: string
            maxCPULimit:
              type: string
            maxMemoryLimit:
              type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requireresourcelimits

        import future.keywords.if
        import future.keywords.in

        # Collect all containers including init and ephemeral
        all_containers[container] {
          container := input.review.object.spec.containers[_]
        }
        all_containers[container] {
          container := input.review.object.spec.initContainers[_]
        }
        all_containers[container] {
          container := input.review.object.spec.ephemeralContainers[_]
        }

        exempt(name) {
          name in input.parameters.exemptContainers
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not exempt(container.name)
          not container.resources.limits.cpu
          msg := sprintf("Container '%v' must specify resources.limits.cpu", [container.name])
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not exempt(container.name)
          not container.resources.limits.memory
          msg := sprintf("Container '%v' must specify resources.limits.memory", [container.name])
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not exempt(container.name)
          not container.resources.requests.cpu
          msg := sprintf("Container '%v' must specify resources.requests.cpu", [container.name])
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not exempt(container.name)
          not container.resources.requests.memory
          msg := sprintf("Container '%v' must specify resources.requests.memory", [container.name])
        }
```

```yaml
# constraints/production/require-resource-limits.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireResourceLimits
metadata:
  name: prod-require-resource-limits
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        environment: production
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
      - monitoring
  parameters:
    exemptContainers:
      - istio-init
      - istio-proxy
```

### Container Resource Ratio Check

Prevent CPU and memory limits far above requests (reservation waste):

```yaml
# templates/resource-limits/resource-ratio.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: containerresourceratio
spec:
  crd:
    spec:
      names:
        kind: ContainerResourceRatio
      validation:
        openAPIV3Schema:
          type: object
          properties:
            cpuLimitRequestRatio:
              type: number
            memoryLimitRequestRatio:
              type: number
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package containerresourceratio

        import future.keywords.if

        # Parse CPU value to millicores
        cpu_to_millicores(s) = v {
          endswith(s, "m")
          v := to_number(trim_suffix(s, "m"))
        }
        cpu_to_millicores(s) = v {
          not endswith(s, "m")
          v := to_number(s) * 1000
        }

        # Parse memory to bytes
        mem_to_bytes(s) = v {
          endswith(s, "Mi")
          v := to_number(trim_suffix(s, "Mi")) * 1048576
        }
        mem_to_bytes(s) = v {
          endswith(s, "Gi")
          v := to_number(trim_suffix(s, "Gi")) * 1073741824
        }
        mem_to_bytes(s) = v {
          endswith(s, "Ki")
          v := to_number(trim_suffix(s, "Ki")) * 1024
        }
        mem_to_bytes(s) = v {
          not endswith(s, "Mi")
          not endswith(s, "Gi")
          not endswith(s, "Ki")
          v := to_number(s)
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          limit := cpu_to_millicores(container.resources.limits.cpu)
          request := cpu_to_millicores(container.resources.requests.cpu)
          ratio := limit / request
          ratio > input.parameters.cpuLimitRequestRatio
          msg := sprintf(
            "Container '%v' CPU limit/request ratio %.2f exceeds maximum %.2f (limit: %v, request: %v)",
            [container.name, ratio, input.parameters.cpuLimitRequestRatio,
             container.resources.limits.cpu, container.resources.requests.cpu]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          limit := mem_to_bytes(container.resources.limits.memory)
          request := mem_to_bytes(container.resources.requests.memory)
          ratio := limit / request
          ratio > input.parameters.memoryLimitRequestRatio
          msg := sprintf(
            "Container '%v' memory limit/request ratio %.2f exceeds maximum %.2f",
            [container.name, ratio, input.parameters.memoryLimitRequestRatio]
          )
        }
```

```yaml
# constraints/production/resource-ratio.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: ContainerResourceRatio
metadata:
  name: prod-resource-ratio
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        environment: production
  parameters:
    cpuLimitRequestRatio: 10.0
    memoryLimitRequestRatio: 4.0
```

## Image Policy Constraints

### Require Approved Image Registries

```yaml
# templates/image-policy/allowed-registries.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: allowedimageregistries
  annotations:
    metadata.gatekeeper.sh/title: "Allowed Image Registries"
    metadata.gatekeeper.sh/version: "1.1.0"
spec:
  crd:
    spec:
      names:
        kind: AllowedImageRegistries
      validation:
        openAPIV3Schema:
          type: object
          properties:
            registries:
              type: array
              items:
                type: string
            allowLatestTag:
              type: boolean
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package allowedimageregistries

        import future.keywords.if
        import future.keywords.in

        # All containers including init
        all_containers[container] {
          container := input.review.object.spec.containers[_]
        }
        all_containers[container] {
          container := input.review.object.spec.initContainers[_]
        }

        # Check if image starts with any allowed registry
        registry_allowed(image) {
          registry := input.parameters.registries[_]
          startswith(image, registry)
        }

        # Extract tag from image
        image_tag(image) = tag {
          parts := split(image, ":")
          count(parts) > 1
          tag := parts[count(parts)-1]
        }
        image_tag(image) = "latest" {
          not contains(image, ":")
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not registry_allowed(container.image)
          msg := sprintf(
            "Container '%v' uses image '%v' from an unapproved registry. Allowed: %v",
            [container.name, container.image, input.parameters.registries]
          )
        }

        violation[{"msg": msg}] {
          not input.parameters.allowLatestTag
          container := all_containers[_]
          tag := image_tag(container.image)
          tag == "latest"
          msg := sprintf(
            "Container '%v' uses the 'latest' tag on image '%v'. Specify an immutable tag.",
            [container.name, container.image]
          )
        }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: AllowedImageRegistries
metadata:
  name: prod-allowed-registries
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        environment: production
  parameters:
    allowLatestTag: false
    registries:
      - "mycompany.azurecr.io/"
      - "gcr.io/my-project/"
      - "quay.io/organization/"
```

### Require Image Digest

For the most security-sensitive workloads, require image digest pins instead of tags:

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireimagedigest
spec:
  crd:
    spec:
      names:
        kind: RequireImageDigest
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requireimagedigest

        import future.keywords.if

        all_containers[container] {
          container := input.review.object.spec.containers[_]
        }
        all_containers[container] {
          container := input.review.object.spec.initContainers[_]
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not contains(container.image, "@sha256:")
          msg := sprintf(
            "Container '%v' image '%v' must use a digest pin (@sha256:...) not a mutable tag",
            [container.name, container.image]
          )
        }
```

## Security Context Policies

### Prohibit Privileged Containers

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: prohibitprivilegedcontainers
spec:
  crd:
    spec:
      names:
        kind: ProhibitPrivilegedContainers
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
        package prohibitprivilegedcontainers

        import future.keywords.if
        import future.keywords.in

        all_containers[container] {
          container := input.review.object.spec.containers[_]
        }
        all_containers[container] {
          container := input.review.object.spec.initContainers[_]
        }

        exempt_image(image) {
          image in input.parameters.exemptImages
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not exempt_image(container.image)
          container.securityContext.privileged == true
          msg := sprintf(
            "Container '%v' must not run as privileged",
            [container.name]
          )
        }

        violation[{"msg": msg}] {
          container := all_containers[_]
          not exempt_image(container.image)
          container.securityContext.allowPrivilegeEscalation == true
          msg := sprintf(
            "Container '%v' must not allow privilege escalation",
            [container.name]
          )
        }
```

### Enforce Read-Only Root Filesystem

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirereadonlyrootfilesystem
spec:
  crd:
    spec:
      names:
        kind: RequireReadOnlyRootFilesystem
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
        package requirereadonlyrootfilesystem

        import future.keywords.if
        import future.keywords.in

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.name in input.parameters.exemptContainers
          container.securityContext.readOnlyRootFilesystem != true
          msg := sprintf(
            "Container '%v' must have readOnlyRootFilesystem: true",
            [container.name]
          )
        }
```

### Require Non-Root User

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirenonrootuser
spec:
  crd:
    spec:
      names:
        kind: RequireNonRootUser
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedUIDs:
              type: array
              items:
                type: integer
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirenonrootuser

        import future.keywords.if
        import future.keywords.in

        # Check pod-level security context
        violation[{"msg": msg}] {
          input.review.object.spec.securityContext.runAsNonRoot != true
          not input.review.object.spec.securityContext.runAsUser
          # No container-level override for any container
          container := input.review.object.spec.containers[_]
          not container.securityContext.runAsNonRoot
          not container.securityContext.runAsUser
          msg := sprintf(
            "Pod or container '%v' must set runAsNonRoot: true or specify a non-zero runAsUser",
            [container.name]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          uid := container.securityContext.runAsUser
          uid == 0
          msg := sprintf(
            "Container '%v' must not run as root (runAsUser: 0)",
            [container.name]
          )
        }

        violation[{"msg": msg}] {
          input.review.object.spec.securityContext.runAsUser == 0
          msg := "Pod must not run as root (runAsUser: 0 in pod securityContext)"
        }
```

## Network Policy Enforcement

### Require NetworkPolicy

Enforce that every namespace has at least one NetworkPolicy:

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirenamespaceNetworkpolicy
spec:
  crd:
    spec:
      names:
        kind: RequireNamespaceNetworkPolicy
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirenamespaceNetworkpolicy

        import future.keywords.if

        violation[{"msg": msg}] {
          input.review.object.kind == "Namespace"
          # Check that the namespace has a NetworkPolicy defined
          # This is evaluated at Namespace creation time
          # The actual enforcement requires the audit mode to check existing namespaces
          not input.review.object.metadata.annotations["policy.network/exempt"]
          msg := sprintf(
            "Namespace '%v' must have a NetworkPolicy applied before creating workloads",
            [input.review.object.metadata.name]
          )
        }
```

### Restrict Ingress to Approved Sources

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: restrictingresssources
spec:
  crd:
    spec:
      names:
        kind: RestrictIngressSources
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedNamespaceLabels:
              type: array
              items:
                type: object
                properties:
                  key:
                    type: string
                  value:
                    type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package restrictingresssources

        import future.keywords.if
        import future.keywords.in

        # Allow if from-namespace selector matches allowed labels
        label_match(selector) {
          allowed := input.parameters.allowedNamespaceLabels[_]
          selector.namespaceSelector.matchLabels[allowed.key] == allowed.value
        }

        # Check each ingress rule
        violation[{"msg": msg}] {
          input.review.object.kind == "NetworkPolicy"
          ingress_rule := input.review.object.spec.ingress[_]
          from := ingress_rule.from[_]
          # Has ipBlock but no namespace restriction
          from.ipBlock
          not from.ipBlock.cidr in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
          msg := sprintf(
            "NetworkPolicy '%v' allows ingress from public IP range '%v'. Only RFC1918 ranges allowed.",
            [input.review.object.metadata.name, from.ipBlock.cidr]
          )
        }
```

## Label and Annotation Policies

### Require Standard Labels

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirestandardlabels
spec:
  crd:
    spec:
      names:
        kind: RequireStandardLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            requiredLabels:
              type: array
              items:
                type: object
                properties:
                  key:
                    type: string
                  allowedValues:
                    type: array
                    items:
                      type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirestandardlabels

        import future.keywords.if
        import future.keywords.in

        get_labels(obj) = obj.metadata.labels if {
          obj.metadata.labels
        }
        get_labels(obj) = {} if {
          not obj.metadata.labels
        }

        # Check pod template labels for Deployments and StatefulSets
        pod_labels = get_labels(input.review.object.spec.template) if {
          input.review.object.kind in ["Deployment", "StatefulSet", "DaemonSet"]
        }
        pod_labels = get_labels(input.review.object) if {
          input.review.object.kind == "Pod"
        }

        violation[{"msg": msg}] {
          required := input.parameters.requiredLabels[_]
          labels := pod_labels
          not labels[required.key]
          msg := sprintf(
            "Resource '%v' is missing required label '%v'",
            [input.review.object.metadata.name, required.key]
          )
        }

        violation[{"msg": msg}] {
          required := input.parameters.requiredLabels[_]
          count(required.allowedValues) > 0
          labels := pod_labels
          val := labels[required.key]
          not val in required.allowedValues
          msg := sprintf(
            "Resource '%v' label '%v' has invalid value '%v'. Allowed: %v",
            [input.review.object.metadata.name, required.key, val, required.allowedValues]
          )
        }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireStandardLabels
metadata:
  name: require-standard-labels
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  parameters:
    requiredLabels:
      - key: "app.kubernetes.io/name"
        allowedValues: []  # Any value accepted
      - key: "app.kubernetes.io/version"
        allowedValues: []
      - key: "app.kubernetes.io/managed-by"
        allowedValues: ["helm", "argocd", "flux"]
      - key: "environment"
        allowedValues: ["production", "staging", "development"]
      - key: "team"
        allowedValues: []
```

## RBAC Constraint Policies

### Prevent ClusterAdmin Binding

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: preventclusteradminbinding
spec:
  crd:
    spec:
      names:
        kind: PreventClusterAdminBinding
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedSubjects:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package preventclusteradminbinding

        import future.keywords.if
        import future.keywords.in

        is_cluster_admin_binding {
          input.review.object.kind in ["ClusterRoleBinding", "RoleBinding"]
          input.review.object.roleRef.name == "cluster-admin"
        }

        subject_allowed(subject) {
          subject.name in input.parameters.allowedSubjects
        }

        violation[{"msg": msg}] {
          is_cluster_admin_binding
          subject := input.review.object.subjects[_]
          not subject_allowed(subject)
          msg := sprintf(
            "ClusterRoleBinding to cluster-admin for subject '%v' of kind '%v' is not allowed. Subjects allowed: %v",
            [subject.name, subject.kind, input.parameters.allowedSubjects]
          )
        }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: PreventClusterAdminBinding
metadata:
  name: prevent-cluster-admin
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["rbac.authorization.k8s.io"]
        kinds: ["ClusterRoleBinding", "RoleBinding"]
  parameters:
    allowedSubjects:
      - "platform-admins"
      - "cluster-bootstrap"
      - "emergency-access"
```

## Custom Business Rules

### Require Specific Annotations for PodDisruptionBudget

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requirepdbforhadeployment
spec:
  crd:
    spec:
      names:
        kind: RequirePDBForHADeployment
      validation:
        openAPIV3Schema:
          type: object
          properties:
            minReplicas:
              type: integer
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requirepdbforhadeployment

        import future.keywords.if

        violation[{"msg": msg}] {
          input.review.object.kind == "Deployment"
          replicas := input.review.object.spec.replicas
          replicas >= input.parameters.minReplicas
          not input.review.object.metadata.annotations["policy.platform/pdb-exempt"]
          not input.review.object.metadata.annotations["policy.platform/has-pdb"]
          msg := sprintf(
            "Deployment '%v' has %v replicas (>=%v) but no PodDisruptionBudget annotation. Annotate with 'policy.platform/has-pdb: \"true\"' after creating a PDB.",
            [input.review.object.metadata.name, replicas, input.parameters.minReplicas]
          )
        }
```

### Enforce Service Mesh Injection

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireservicemeshinjection
spec:
  crd:
    spec:
      names:
        kind: RequireServiceMeshInjection
      validation:
        openAPIV3Schema:
          type: object
          properties:
            injectionLabel:
              type: string
              default: "istio-injection"
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requireservicemeshinjection

        import future.keywords.if

        injection_label := input.parameters.injectionLabel

        violation[{"msg": msg}] {
          input.review.object.kind == "Namespace"
          not input.review.object.metadata.annotations["mesh.platform/exempt"]
          not input.review.object.metadata.labels[injection_label]
          msg := sprintf(
            "Namespace '%v' must have the label '%v: enabled' for service mesh injection",
            [input.review.object.metadata.name, injection_label]
          )
        }

        violation[{"msg": msg}] {
          input.review.object.kind == "Namespace"
          val := input.review.object.metadata.labels[injection_label]
          val != "enabled"
          not input.review.object.metadata.annotations["mesh.platform/exempt"]
          msg := sprintf(
            "Namespace '%v' has '%v: %v' but must be 'enabled'",
            [input.review.object.metadata.name, injection_label, val]
          )
        }
```

## Rego Unit Testing

Gatekeeper policies should be unit tested using OPA's built-in test framework:

```rego
# tests/require-resource-limits_test.rego
package requireresourcelimits

import future.keywords.if

# Helper to build test review objects
make_pod(containers) = review if {
  review := {
    "object": {
      "spec": {
        "containers": containers,
        "initContainers": []
      }
    },
    "operation": "CREATE",
    "kind": {
      "kind": "Pod"
    }
  }
}

# Test: Pod with all resources set should pass
test_all_resources_set_passes if {
  input := {
    "review": make_pod([{
      "name": "app",
      "image": "nginx:1.25",
      "resources": {
        "requests": {"cpu": "100m", "memory": "128Mi"},
        "limits":   {"cpu": "500m", "memory": "512Mi"}
      }
    }]),
    "parameters": {"exemptContainers": []}
  }
  count(violation) == 0 with input as input
}

# Test: Pod missing CPU limit should fail
test_missing_cpu_limit_fails if {
  input := {
    "review": make_pod([{
      "name": "app",
      "image": "nginx:1.25",
      "resources": {
        "requests": {"cpu": "100m", "memory": "128Mi"},
        "limits":   {"memory": "512Mi"}
      }
    }]),
    "parameters": {"exemptContainers": []}
  }
  violations := violation with input as input
  count(violations) == 1
  violations[_].msg == "Container 'app' must specify resources.limits.cpu"
}

# Test: Exempt container should not be checked
test_exempt_container_passes if {
  input := {
    "review": make_pod([{
      "name": "istio-proxy",
      "image": "istio/proxyv2:1.18",
      "resources": {}
    }]),
    "parameters": {"exemptContainers": ["istio-proxy"]}
  }
  count(violation) == 0 with input as input
}
```

Run tests:

```bash
opa test ./tests/ -v
# Or test all templates
find templates/ -name "*.yaml" -exec \
  yq e '.spec.targets[0].rego' {} \; | \
  opa test /dev/stdin tests/ -v
```

## Audit Mode and Compliance Reporting

Set constraints to `warn` or `dryrun` during rollout to see violations without blocking:

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireResourceLimits
metadata:
  name: audit-require-resource-limits
spec:
  enforcementAction: warn  # warn | dryrun | deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
```

Generate an audit compliance report:

```bash
# List all constraint violations
kubectl get constraints -o json | \
  jq -r '.items[] | select(.status.totalViolations > 0) |
    [.metadata.name, .status.totalViolations] | @tsv' | \
  sort -k2 -rn

# Detailed violations for a specific constraint
kubectl get requireresourcelimits prod-require-resource-limits \
  -o jsonpath='{.status.violations}' | jq .

# Export to JSON for reporting
kubectl get constraints \
  -o json | \
  jq '[.items[] | {
    name: .metadata.name,
    kind: .kind,
    violations: .status.violations,
    total: .status.totalViolations
  }]' > compliance-report.json
```

## Mutation Webhook with Gatekeeper Mutations

Gatekeeper also supports Assign mutations to automatically inject defaults:

```yaml
# Automatically set resource requests if missing
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: default-cpu-request
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
  location: "spec.containers[name:*].resources.requests.cpu"
  parameters:
    assign:
      value: "100m"
---
apiVersion: mutations.gatekeeper.sh/v1
kind: Assign
metadata:
  name: default-memory-request
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
  location: "spec.containers[name:*].resources.requests.memory"
  parameters:
    assign:
      value: "128Mi"
```

## Deployment with Kustomize

Structure the policy library for multi-environment deployment:

```yaml
# kustomization.yaml (production)
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  # Templates
  - ../../templates/resource-limits/require-resource-limits.yaml
  - ../../templates/resource-limits/resource-ratio.yaml
  - ../../templates/image-policy/allowed-registries.yaml
  - ../../templates/image-policy/require-image-digest.yaml
  - ../../templates/security/prohibit-privileged.yaml
  - ../../templates/security/readonly-rootfs.yaml
  - ../../templates/security/require-nonroot.yaml
  - ../../templates/labels/require-standard-labels.yaml
  - ../../templates/rbac/prevent-cluster-admin.yaml
  # Constraints for production
  - constraints/require-resource-limits.yaml
  - constraints/resource-ratio.yaml
  - constraints/allowed-registries.yaml
  - constraints/prohibit-privileged.yaml
  - constraints/readonly-rootfs.yaml
  - constraints/require-nonroot.yaml
  - constraints/require-standard-labels.yaml
  - constraints/prevent-cluster-admin.yaml
```

```bash
# Deploy to production
kubectl apply -k environments/production/

# Validate before applying
kubectl apply -k environments/production/ --dry-run=server
```

## Summary

A well-organized Gatekeeper policy library addresses the most common Kubernetes security and operational failures:

- Resource limits and ratio enforcement prevents noisy-neighbor problems
- Image registry and tag policies prevent supply chain attacks
- Security context policies block privilege escalation and container breakout
- Label requirements enable observability and operational tooling
- RBAC constraints prevent accidental over-permissioning

Use `warn` enforcement action during initial rollout to measure impact before switching to `deny`. Run the OPA test suite in CI/CD to catch Rego logic errors before deploying policy updates. The audit mode compliance report provides a continuous view of policy adherence across the entire cluster fleet.
