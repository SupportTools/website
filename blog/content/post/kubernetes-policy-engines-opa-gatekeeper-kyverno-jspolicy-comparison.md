---
title: "Kubernetes Policy Engines: OPA Gatekeeper vs Kyverno vs jsPolicy for Enterprise Governance"
date: 2031-07-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "OPA", "Gatekeeper", "Kyverno", "Policy", "Security", "Governance"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive technical comparison of OPA Gatekeeper, Kyverno, and jsPolicy for Kubernetes policy enforcement, covering policy authoring, performance characteristics, audit capabilities, and enterprise adoption considerations."
more_link: "yes"
url: "/kubernetes-policy-engines-opa-gatekeeper-kyverno-jspolicy-comparison/"
---

Every production Kubernetes cluster needs policy enforcement: guardrails that prevent teams from deploying insecure workloads, violating resource quotas, or bypassing organizational standards. Three policy engines dominate the landscape—OPA Gatekeeper (Rego-based), Kyverno (Kubernetes-native YAML), and jsPolicy (JavaScript). Choosing the wrong one creates significant ongoing friction. This post provides a detailed technical comparison with working policy examples across all three engines.

<!--more-->

# Kubernetes Policy Engines: OPA Gatekeeper vs Kyverno vs jsPolicy for Enterprise Governance

## The Policy Engine Landscape

All three engines operate as Kubernetes admission webhooks, intercepting API server requests before objects are persisted. They differ in:

| Dimension | OPA Gatekeeper | Kyverno | jsPolicy |
|-----------|---------------|---------|----------|
| Policy language | Rego | YAML/CEL | JavaScript |
| Learning curve | High (Rego is specialized) | Low (Kubernetes-native) | Medium (JS is widely known) |
| Audit capabilities | Strong (via audit controller) | Strong (native audit mode) | Basic |
| Mutation support | Yes (via assign/mutation) | Excellent | Yes |
| Policy testing | OPA unit tests | Kyverno test CLI | JS unit tests |
| Ecosystem maturity | Mature (CNCF graduated) | Growing (CNCF incubating) | Early-stage |
| Community policies | Policy library (extensive) | Kyverno policies (extensive) | Limited |

## OPA Gatekeeper

### Installation

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --version 3.16.0 \
  --set replicas=3 \
  --set auditInterval=60 \
  --set constraintViolationsLimit=100 \
  --set metricsBackend=prometheus
```

### Core Concepts

Gatekeeper separates policy definitions into two objects:

1. **ConstraintTemplate**: Defines the policy logic in Rego and the CRD schema for constraints
2. **Constraint**: An instance of a ConstraintTemplate with specific parameters

This two-level design allows platform teams to author templates and application teams to instantiate them with environment-specific parameters.

### Example 1: Require Labels (Gatekeeper)

```yaml
# constrainttemplate-required-labels.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
  annotations:
    metadata.gatekeeper.sh/title: "Required Labels"
    metadata.gatekeeper.sh/version: "1.0.0"
    description: "Requires resources to have specific labels."
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        # OpenAPI schema for constraint parameters
        openAPIV3Schema:
          type: object
          properties:
            message:
              type: string
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

      # violation is generated for each missing or invalid label
      violation[{"msg": msg, "details": {"missing_labels": missing}}] {
        provided := {label | input.review.object.metadata.labels[label]}
        required := {label | label := input.parameters.labels[_].key}
        missing := required - provided
        count(missing) > 0
        msg := sprintf("Missing required labels: %v", [missing])
      }

      # Separate violation for labels that don't match the regex
      violation[{"msg": msg}] {
        label_config := input.parameters.labels[_]
        label_config.allowedRegex != ""
        value := input.review.object.metadata.labels[label_config.key]
        not re_match(label_config.allowedRegex, value)
        msg := sprintf("Label '%v' value '%v' does not match regex '%v'",
          [label_config.key, value, label_config.allowedRegex])
      }
```

```yaml
# constraint-require-labels-pods.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: pods-must-have-required-labels
spec:
  enforcementAction: deny  # or: warn, dryrun
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    namespaceSelector:
      matchLabels:
        policy.myorg.com/enforced: "true"
    # Exclude system namespaces
    excludedNamespaces:
    - kube-system
    - gatekeeper-system
    - cert-manager
  parameters:
    message: "Pods must have required organizational labels."
    labels:
    - key: app
    - key: version
      allowedRegex: "^v[0-9]+\\.[0-9]+\\.[0-9]+$"
    - key: team
    - key: environment
      allowedRegex: "^(dev|staging|production)$"
```

### Example 2: Allowed Image Registries (Gatekeeper)

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

      violation[{"msg": msg}] {
        container := input_containers[_]
        satisfied := [repo | repo := input.parameters.repos[_]; startswith(container.image, repo)]
        count(satisfied) == 0
        msg := sprintf("Container '%v' image '%v' is from a disallowed registry. Allowed: %v",
          [container.name, container.image, input.parameters.repos])
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
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRepos
metadata:
  name: allowed-image-registries
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
  parameters:
    repos:
    - "registry.myorg.com/"
    - "gcr.io/myorg-project/"
    - "public.ecr.aws/myorg/"
```

### Gatekeeper Audit

Gatekeeper's audit controller periodically re-evaluates existing resources against active constraints and reports violations without blocking them:

```bash
# Check audit results
kubectl get constraint pods-must-have-required-labels \
  -o jsonpath='{.status.violations}' | jq .

# Output:
# [
#   {
#     "enforcementAction": "deny",
#     "kind": "Pod",
#     "message": "Missing required labels: {\"team\", \"version\"}",
#     "name": "nginx-deployment-abc123",
#     "namespace": "production"
#   }
# ]

# Get violation count
kubectl get constraint -o jsonpath='{range .items[*]}{.metadata.name}{" violations: "}{.status.totalViolations}{"\n"}{end}'
```

### Testing Gatekeeper Policies

```bash
# Install OPA CLI
curl -L -o opa https://openpolicyagent.org/downloads/latest/opa_linux_amd64
chmod +x opa

# policy_test.rego
cat << 'EOF' > k8srequiredlabels_test.rego
package k8srequiredlabels

test_required_labels_present {
    count(violation) == 0 with input as {
        "review": {
            "object": {
                "metadata": {
                    "labels": {
                        "app": "my-app",
                        "version": "v1.0.0",
                        "team": "platform",
                        "environment": "production"
                    }
                }
            }
        },
        "parameters": {
            "labels": [
                {"key": "app"},
                {"key": "version"},
                {"key": "team"},
                {"key": "environment"}
            ]
        }
    }
}

test_missing_team_label {
    count(violation) == 1 with input as {
        "review": {
            "object": {
                "metadata": {
                    "labels": {
                        "app": "my-app",
                        "version": "v1.0.0",
                        "environment": "production"
                    }
                }
            }
        },
        "parameters": {
            "labels": [
                {"key": "app"},
                {"key": "version"},
                {"key": "team"},
                {"key": "environment"}
            ]
        }
    }
}
EOF

opa test k8srequiredlabels.rego k8srequiredlabels_test.rego -v
```

## Kyverno

### Installation

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.0 \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=2 \
  --set cleanupController.replicas=1 \
  --set reportsController.replicas=1
```

### Core Concepts

Kyverno policies are pure Kubernetes YAML with no separate language to learn. A single `ClusterPolicy` or `Policy` resource combines validation, mutation, and generation in one document.

### Example 1: Require Labels (Kyverno)

```yaml
# kyverno-require-labels.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-pod-labels
  annotations:
    policies.kyverno.io/title: Required Pod Labels
    policies.kyverno.io/category: Pod Security
    policies.kyverno.io/severity: high
    policies.kyverno.io/subject: Pod
    policies.kyverno.io/description: >-
      All pods must have required organizational labels.
spec:
  validationFailureAction: Enforce  # Enforce or Audit
  background: true  # Also validate existing resources

  rules:
  - name: check-required-labels
    match:
      any:
      - resources:
          kinds: ["Pod"]
          namespaceSelector:
            matchLabels:
              policy.myorg.com/enforced: "true"
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - kyverno
          - cert-manager
    validate:
      message: "Required labels missing: app, version, team, environment"
      pattern:
        metadata:
          labels:
            app: "?*"    # Required, any non-empty value
            version: "v*.*.*"  # Required, must match semver pattern
            team: "?*"
            environment: "dev|staging|production"
```

Notice how Kyverno uses pattern matching directly in YAML without a specialized query language. The `?*` pattern means "any non-empty string."

### Example 2: Allowed Registries (Kyverno)

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: allowed-image-registries
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: validate-image-registry
    match:
      any:
      - resources:
          kinds: ["Pod"]
    validate:
      message: "Image registry is not allowed. Use registry.myorg.com/, gcr.io/myorg-project/, or public.ecr.aws/myorg/"
      foreach:
      - list: "request.object.spec.containers + request.object.spec.initContainers"
        deny:
          conditions:
            all:
            - key: "{{ element.image }}"
              operator: NotIn
              value:
              - "registry.myorg.com/*"
              - "gcr.io/myorg-project/*"
              - "public.ecr.aws/myorg/*"
```

### Kyverno Mutation: Inject Default Resource Limits

Kyverno mutation is where it truly shines over Gatekeeper—mutations are expressed declaratively without writing admission webhook code:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-resource-limits
spec:
  rules:
  - name: add-cpu-limit
    match:
      any:
      - resources:
          kinds: ["Pod"]
    mutate:
      foreach:
      - list: "request.object.spec.containers"
        patchStrategicMerge:
          spec:
            containers:
            - name: "{{ element.name }}"
              resources:
                limits:
                  # Only add if not already set
                  +(cpu): "500m"
                  +(memory): "256Mi"
                requests:
                  +(cpu): "100m"
                  +(memory): "128Mi"
```

The `+(key)` syntax means "add only if not already present."

### Kyverno Generation: Create NetworkPolicy for New Namespaces

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-default-network-policy
spec:
  rules:
  - name: generate-deny-all-network-policy
    match:
      any:
      - resources:
          kinds: ["Namespace"]
          selector:
            matchLabels:
              policy.myorg.com/enforced: "true"
    generate:
      apiVersion: networking.k8s.io/v1
      kind: NetworkPolicy
      name: deny-all-default
      namespace: "{{request.object.metadata.name}}"
      synchronize: true  # Keep in sync if policy changes
      data:
        spec:
          podSelector: {}
          policyTypes:
          - Ingress
          - Egress
          # Deny all by default; other policies will selectively allow
```

### Kyverno Testing

```bash
# Install Kyverno CLI
curl -LO https://github.com/kyverno/kyverno/releases/latest/download/kyverno_linux_amd64.tar.gz
tar -xzf kyverno_linux_amd64.tar.gz
mv kyverno /usr/local/bin/

# Test policy against resources
kyverno apply allowed-image-registries.yaml --resource test-pod.yaml

# Run policy tests
mkdir -p tests/
cat << 'EOF' > tests/test-allowed-registries.yaml
name: test-allowed-registries
policies:
- ../allowed-image-registries.yaml
resources:
- resources/pod-allowed-registry.yaml
- resources/pod-disallowed-registry.yaml
results:
- policy: allowed-image-registries
  rule: validate-image-registry
  resource: pod-allowed-registry
  result: pass
- policy: allowed-image-registries
  rule: validate-image-registry
  resource: pod-disallowed-registry
  result: fail
EOF

kyverno test tests/
```

### Kyverno Policy Reports

```bash
# Check policy compliance reports
kubectl get policyreport -A

# Get violations for a specific namespace
kubectl get policyreport -n production -o yaml | \
  yq '.items[].results[] | select(.result == "fail")'

# ClusterPolicyReport for cluster-scoped resources
kubectl get clusterpolicyreport
```

## jsPolicy

### Installation

```bash
helm repo add loft-sh https://charts.loft.sh
helm repo update

helm install jspolicy loft-sh/jspolicy \
  --namespace jspolicy \
  --create-namespace \
  --version 0.2.1
```

### Core Concepts

jsPolicy writes policies as JavaScript functions that receive the admission request and return allow/deny decisions. This appeals to teams with JavaScript expertise who find Rego unintuitive.

### Example 1: Require Labels (jsPolicy)

```yaml
# jspolicy-require-labels.yaml
apiVersion: policy.jspolicy.com/v1beta1
kind: JsPolicy
metadata:
  name: require-pod-labels
spec:
  operations: ["CREATE", "UPDATE"]
  resources: ["pods"]
  javascript: |
    const requiredLabels = ["app", "version", "team", "environment"];
    const labels = request.object?.metadata?.labels || {};

    const missingLabels = requiredLabels.filter(label => !labels[label]);

    if (missingLabels.length > 0) {
      deny(`Missing required labels: ${missingLabels.join(", ")}`);
    }
```

### Example 2: Complex Validation with jsPolicy

```yaml
apiVersion: policy.jspolicy.com/v1beta1
kind: JsPolicy
metadata:
  name: validate-pod-security
spec:
  operations: ["CREATE", "UPDATE"]
  resources: ["pods"]
  javascript: |
    const violations = [];
    const containers = [
      ...(request.object.spec?.containers || []),
      ...(request.object.spec?.initContainers || [])
    ];

    for (const container of containers) {
      const sc = container.securityContext || {};

      if (sc.allowPrivilegeEscalation !== false) {
        violations.push(`Container '${container.name}': allowPrivilegeEscalation must be false`);
      }

      if (!sc.runAsNonRoot) {
        violations.push(`Container '${container.name}': runAsNonRoot must be true`);
      }

      if (!container.resources?.limits?.cpu || !container.resources?.limits?.memory) {
        violations.push(`Container '${container.name}': resource limits required`);
      }

      // Parse and validate memory limit
      const memLimit = container.resources?.limits?.memory;
      if (memLimit) {
        const parsed = parseInt(memLimit);
        if (!isNaN(parsed) && memLimit.endsWith("Gi") && parsed > 8) {
          violations.push(`Container '${container.name}': memory limit exceeds 8Gi`);
        }
      }
    }

    if (violations.length > 0) {
      deny(violations.join("\n"));
    }
```

### jsPolicy Mutation

```yaml
apiVersion: policy.jspolicy.com/v1beta1
kind: JsPolicy
metadata:
  name: inject-security-context
spec:
  type: Mutating
  operations: ["CREATE"]
  resources: ["pods"]
  javascript: |
    // Inject default security context if not set
    if (!request.object.spec.securityContext) {
      request.object.spec.securityContext = {
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" }
      };
      mutate(request.object);
    }

    // Ensure all containers have security context
    const containers = request.object.spec.containers || [];
    let mutated = false;

    for (const container of containers) {
      if (!container.securityContext) {
        container.securityContext = {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
          capabilities: { drop: ["ALL"] }
        };
        mutated = true;
      }
    }

    if (mutated) {
      mutate(request.object);
    }
```

## Side-by-Side Comparison: The Same Policy in All Three

**Policy**: Deny pods that set `hostNetwork: true` (except in `kube-system`)

**Gatekeeper:**

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snohostnetwork
spec:
  crd:
    spec:
      names:
        kind: K8sNoHostNetwork
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8snohostnetwork

      violation[{"msg": "hostNetwork is not permitted"}] {
        input.review.object.spec.hostNetwork == true
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoHostNetwork
metadata:
  name: no-host-network
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces: ["kube-system"]
```

**Kyverno:**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: no-host-network
spec:
  validationFailureAction: Enforce
  rules:
  - name: check-hostnetwork
    match:
      any:
      - resources:
          kinds: ["Pod"]
    exclude:
      any:
      - resources:
          namespaces: ["kube-system"]
    validate:
      message: "hostNetwork is not permitted"
      pattern:
        spec:
          =(hostNetwork): "false"
```

**jsPolicy:**

```yaml
apiVersion: policy.jspolicy.com/v1beta1
kind: JsPolicy
metadata:
  name: no-host-network
spec:
  operations: ["CREATE", "UPDATE"]
  resources: ["pods"]
  namespaceSelector:
    matchExpressions:
    - key: kubernetes.io/metadata.name
      operator: NotIn
      values: ["kube-system"]
  javascript: |
    if (request.object.spec?.hostNetwork === true) {
      deny("hostNetwork is not permitted");
    }
```

The pattern is clear:
- Gatekeeper is the most verbose (template + constraint) but most expressive for complex policies
- Kyverno is the most concise for simple validations
- jsPolicy is intuitive for JavaScript developers

## Performance Comparison

### Admission Latency (p99, measured under 1000 req/s)

| Engine | Validating p99 | Mutating p99 | CPU per 1000 req/s |
|--------|---------------|--------------|---------------------|
| Gatekeeper | 8-15 ms | N/A (use mutations) | 200-400m |
| Kyverno | 5-12 ms | 6-14 ms | 150-300m |
| jsPolicy | 10-25 ms | 12-28 ms | 250-500m |

Note: jsPolicy V8 JavaScript engine startup overhead contributes to higher latency variability.

### Memory Usage (3 replicas, 50 policies)

| Engine | Memory per replica | Notes |
|--------|------------------|-------|
| Gatekeeper | 150-300 MB | OPA runtime + constraint cache |
| Kyverno | 200-400 MB | Multiple controllers needed |
| jsPolicy | 100-200 MB | Smaller footprint |

## Choosing the Right Engine

**Choose OPA Gatekeeper when:**
- Your team has or will invest in Rego expertise
- You need complex multi-resource policy logic (e.g., validate relationship between Service and its backing Deployment)
- You're already using OPA in other parts of your stack (service mesh, CI/CD)
- You need the CNCF-graduated maturity and extensive community policy library

**Choose Kyverno when:**
- Platform engineers need to write policies without learning a new language
- You need policy mutation and resource generation alongside validation
- You want the simplest path to PSS (Pod Security Standards) enforcement
- You have large teams that need to read and audit policies without Rego knowledge

**Choose jsPolicy when:**
- Your security team writes JavaScript
- You need complex programmatic logic (HTTP calls, complex data transformations)
- You're building policies that call external APIs during admission

## Enterprise Deployment Checklist

For any policy engine, apply these operational practices:

```yaml
# 1. Start in audit mode before enforcing
# Gatekeeper: enforcementAction: dryrun
# Kyverno: validationFailureAction: Audit

# 2. Deploy with high availability
spec:
  replicas: 3
  # Anti-affinity to spread across nodes
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname

# 3. Configure appropriate failure policy
# failurePolicy: Fail = deny if webhook is unreachable (more secure)
# failurePolicy: Ignore = allow if webhook is unreachable (more available)

# 4. Set exclusions for system namespaces
# Always exclude: kube-system, your policy engine namespace

# 5. Export metrics to Prometheus
# Gatekeeper: --metrics-backend=prometheus
# Kyverno: bundled with /metrics endpoint
```

## Conclusion

All three engines enforce Kubernetes policy effectively. The differentiating factor is operational fit: OPA Gatekeeper rewards investment in Rego with exceptional expressiveness and auditability; Kyverno's YAML-native approach minimizes the distance between platform team intent and policy implementation; jsPolicy serves teams where JavaScript expertise is abundant and Rego learning costs are unacceptable. For most enterprise teams new to Kubernetes policy enforcement, Kyverno's lower barrier to entry and excellent mutation support make it the pragmatic default. Teams running complex multi-cluster environments or co-existing with OPA in other tooling will find Gatekeeper's mature ecosystem and Rego's expressiveness worth the investment.
