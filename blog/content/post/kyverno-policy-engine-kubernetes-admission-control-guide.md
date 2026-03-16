---
title: "Kyverno: Kubernetes-Native Policy Engine for Admission Control"
date: 2027-02-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kyverno", "Policy", "Security", "Admission Control"]
categories: ["Security", "Kubernetes", "Policy Management"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to deploying and operating Kyverno as a Kubernetes-native policy engine, covering validate, mutate, generate, and verify-image rules with JMESPath, CEL, background scanning, policy exceptions, and CI/CD integration."
more_link: "yes"
url: "/kyverno-policy-engine-kubernetes-admission-control-guide/"
---

Kyverno is a CNCF graduated policy engine purpose-built for Kubernetes. Unlike OPA Gatekeeper, which requires learning Rego, Kyverno policies are plain Kubernetes resources written in YAML. The engine validates, mutates, generates, and verifies image signatures through a single admission webhook without any external dependency on a policy language runtime.

This guide covers production deployment patterns, all four rule types, advanced context variables with JMESPath and CEL expressions, background scanning, policy exceptions, supply-chain image verification via Cosign, the Kyverno CLI for CI/CD gate checks, and high-availability configuration for enterprise clusters.

<!--more-->

## Why Kyverno Over OPA Gatekeeper

Both tools enforce admission control, but the operational trade-offs differ significantly:

| Capability | Kyverno | OPA Gatekeeper |
|---|---|---|
| Policy language | YAML / JMESPath / CEL | Rego |
| Mutation support | Native ClusterPolicy | AssignMetadata CRD |
| Resource generation | Native generate rule | External webhook |
| Image verification | Native Cosign/Notary | cosign-webhook sidecar |
| Background scanning | Built-in | Audit controller |
| Policy reports | PolicyReport CRD | Via violation status |
| CLI dry-run | `kyverno apply` | `conftest` / manual |

Kyverno's Kubernetes-native design means policies are consumable by any team that already reads YAML, and the generate rules reduce boilerplate provisioning that typically requires custom controllers.

## Architecture Overview

### Core Components

Kyverno deploys three distinct workloads:

- **admission-controller** — validates and mutates resources in the admission path
- **background-controller** — runs background scans and processes generate rules for existing resources
- **cleanup-controller** — garbage-collects generated resources when triggers are removed
- **reports-controller** — aggregates PolicyReport and ClusterPolicyReport objects

Each controller communicates only with the Kubernetes API server; no separate database or sidecar is required.

### Webhook Configuration

Kyverno self-registers two webhooks:

- `MutatingWebhookConfiguration/kyverno-resource-mutating-webhook-cfg` — fires on `CREATE` and `UPDATE`
- `ValidatingWebhookConfiguration/kyverno-resource-validating-webhook-cfg` — fires on `CREATE`, `UPDATE`, and `DELETE`

Failure policy defaults to `Ignore` during initial rollout; operators should switch to `Fail` after stabilizing policies in production.

## High-Availability Installation

### Helm Deployment

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.0 \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=2 \
  --set cleanupController.replicas=2 \
  --set reportsController.replicas=2 \
  --set admissionController.podDisruptionBudget.enabled=true \
  --set admissionController.podDisruptionBudget.minAvailable=1 \
  --set admissionController.topologySpreadConstraints[0].maxSkew=1 \
  --set admissionController.topologySpreadConstraints[0].topologyKey=topology.kubernetes.io/zone \
  --set admissionController.topologySpreadConstraints[0].whenUnsatisfiable=DoNotSchedule \
  --set features.policyExceptions.enabled=true \
  --set features.backgroundScan.enabled=true \
  --set features.backgroundScan.backgroundScanInterval=1h \
  --set config.webhooks[0].namespaceSelector.matchExpressions[0].key=kubernetes.io/metadata.name \
  --set config.webhooks[0].namespaceSelector.matchExpressions[0].operator=NotIn \
  --set "config.webhooks[0].namespaceSelector.matchExpressions[0].values={kyverno,kube-system}"
```

### Production values.yaml

```yaml
# kyverno-values.yaml
admissionController:
  replicas: 3
  resources:
    requests:
      cpu: 200m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop:
        - ALL
  podDisruptionBudget:
    enabled: true
    minAvailable: 1
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/component: admission-controller
          topologyKey: kubernetes.io/hostname

backgroundController:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

reportsController:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

cleanupController:
  replicas: 2

features:
  policyExceptions:
    enabled: true
    namespace: kyverno
  backgroundScan:
    enabled: true
    backgroundScanInterval: 1h
    backgroundScanWorkers: 2
  omitEvents:
    eventTypes: []

webhooksCleanup:
  enabled: true
  image:
    registry: ghcr.io

config:
  webhooks:
    - namespaceSelector:
        matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: NotIn
            values:
              - kyverno
              - kube-system

metricsConfig:
  namespaces:
    include: []
    exclude:
      - kyverno
```

Apply the installation:

```bash
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.0 \
  -f kyverno-values.yaml
```

Verify all pods are running:

```bash
kubectl -n kyverno get pods -w
kubectl -n kyverno get validatingwebhookconfigurations
kubectl -n kyverno get mutatingwebhookconfigurations
```

## ClusterPolicy vs Policy

**`ClusterPolicy`** applies cluster-wide and can match resources in any namespace. **`Policy`** is namespace-scoped and only applies within the namespace where it is created. Both resources support the same rule types. Use `ClusterPolicy` for platform-wide guardrails and `Policy` for namespace-level customization by development teams.

```yaml
# ClusterPolicy applies to all namespaces (subject to match/exclude)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-labels
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-team-label
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
                - DaemonSet
      validate:
        message: "Deployments must carry a 'team' label."
        pattern:
          metadata:
            labels:
              team: "?*"
```

```yaml
# Policy is scoped to a single namespace
apiVersion: kyverno.io/v1
kind: Policy
metadata:
  name: team-alpha-limits
  namespace: team-alpha
spec:
  validationFailureAction: Enforce
  rules:
    - name: require-resource-limits
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "CPU and memory limits are required."
        pattern:
          spec:
            containers:
              - name: "*"
                resources:
                  limits:
                    cpu: "?*"
                    memory: "?*"
```

## Validate Rules

### Match and Exclude Blocks

The `match` block determines which resources a rule applies to, and `exclude` carves out exemptions. Both support `any` (OR) and `all` (AND) logic.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privilege-escalation
  annotations:
    policies.kyverno.io/title: Disallow Privilege Escalation
    policies.kyverno.io/category: Pod Security
    policies.kyverno.io/severity: high
    policies.kyverno.io/description: >-
      Privilege escalation allows processes inside containers to gain additional
      privileges. This policy prevents that by requiring allowPrivilegeEscalation: false.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: no-privilege-escalation
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchExpressions:
                  - key: kubernetes.io/metadata.name
                    operator: NotIn
                    values:
                      - kube-system
                      - kyverno
      exclude:
        any:
          - resources:
              annotations:
                kyverno.io/exemption: "privilege-escalation"
          - subjects:
              - kind: ServiceAccount
                name: privileged-sa
                namespace: platform-tools
      validate:
        message: "Privilege escalation is not allowed. Set allowPrivilegeEscalation: false."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.securityContext.allowPrivilegeEscalation }}"
                    operator: Equals
                    value: true
```

### Preconditions

**Preconditions** gate whether a rule body runs at all. They short-circuit evaluation before pattern matching, which improves performance and avoids false positives on optional fields.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-readiness-probes
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-readiness-probe
      match:
        any:
          - resources:
              kinds:
                - Deployment
      preconditions:
        all:
          # Only enforce on production namespaces
          - key: "{{ request.object.metadata.namespace }}"
            operator: AnyIn
            value:
              - production
              - staging
          # Skip Helm upgrade dry-runs
          - key: "{{ request.operation }}"
            operator: NotEquals
            value: DELETE
      validate:
        message: "Containers in production Deployments must define a readinessProbe."
        foreach:
          - list: "request.object.spec.template.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ element.readinessProbe }}"
                    operator: Equals
                    value: null
```

### JMESPath Expressions in Validate Rules

JMESPath provides powerful querying against the admission request object:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: check-image-tag
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: no-latest-tag
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: >-
          Using the 'latest' image tag is not allowed. Found: {{ request.object.spec.containers[].image }}.
          Use a specific version tag instead.
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.image }}"
                    operator: Equals
                    value: "*:latest"
                  - key: "{{ element.image }}"
                    operator: NotContains
                    value: ":"
```

### CEL Expressions

Kubernetes 1.30+ enables **CEL** (Common Expression Language) as an alternative to JMESPath pattern matching for validate rules:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: cel-resource-validation
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: validate-cpu-limit
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        cel:
          expressions:
            - expression: >-
                object.spec.containers.all(c,
                  has(c.resources) &&
                  has(c.resources.limits) &&
                  has(c.resources.limits.cpu)
                )
              message: "All containers must have CPU limits defined."
            - expression: >-
                object.spec.containers.all(c,
                  !has(c.securityContext) ||
                  !has(c.securityContext.privileged) ||
                  c.securityContext.privileged == false
                )
              message: "Privileged containers are not permitted."
```

## Mutate Rules

### Patching Resource Defaults

Mutate rules run before validation and can inject defaults, add labels, or fix misconfigured fields:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-resource-limits
spec:
  rules:
    - name: add-limits-if-missing
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchLabels:
                  kyverno.io/mutate-limits: "true"
      preconditions:
        all:
          - key: "{{ request.operation }}"
            operator: AnyIn
            value:
              - CREATE
              - UPDATE
      mutate:
        foreach:
          - list: "request.object.spec.containers"
            preconditions:
              all:
                - key: "{{ element.resources.limits.cpu }}"
                  operator: Equals
                  value: null
            patchStrategicMerge:
              spec:
                containers:
                  - name: "{{ element.name }}"
                    resources:
                      limits:
                        cpu: "500m"
                        memory: "512Mi"
                      requests:
                        cpu: "100m"
                        memory: "128Mi"
```

### Adding Annotations and Labels via mutateExistingOnPolicyUpdate

The `mutateExistingOnPolicyUpdate` flag also triggers mutation against existing resources when the policy itself changes, enabling bulk remediation of non-compliant resources without re-deploying them:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-cost-center-label
spec:
  mutateExistingOnPolicyUpdate: true
  rules:
    - name: add-label-from-namespace
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
              operations:
                - CREATE
                - UPDATE
      context:
        - name: nsLabels
          apiCall:
            urlPath: "/api/v1/namespaces/{{ request.object.metadata.namespace }}"
            jmesPath: "metadata.labels"
      preconditions:
        all:
          - key: "{{ nsLabels.\"cost-center\" || '' }}"
            operator: NotEquals
            value: ""
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              cost-center: "{{ nsLabels.\"cost-center\" }}"
```

## Generate Rules

**Generate rules** create new Kubernetes resources when a trigger resource is created or updated. Common use cases include provisioning default NetworkPolicies, LimitRanges, and RBAC objects for new namespaces.

### Auto-Provisioning NetworkPolicies for Namespaces

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-default-network-policy
  annotations:
    policies.kyverno.io/title: Generate Default NetworkPolicy
    policies.kyverno.io/category: Multi-Tenancy
    policies.kyverno.io/description: >-
      Creates a default-deny NetworkPolicy and a same-namespace allow policy
      whenever a new application namespace is created.
spec:
  rules:
    - name: generate-deny-all
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  environment: production
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny-all
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
        data:
          metadata:
            labels:
              managed-by: kyverno
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
              - Egress
    - name: generate-allow-same-namespace
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  environment: production
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: allow-same-namespace
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
        data:
          metadata:
            labels:
              managed-by: kyverno
          spec:
            podSelector: {}
            ingress:
              - from:
                  - podSelector: {}
            egress:
              - to:
                  - podSelector: {}
```

### Cloning a ConfigMap Across Namespaces

The `clone` strategy copies an existing resource from a source namespace to the target namespace, keeping it synchronized:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: clone-tls-bundle
spec:
  rules:
    - name: clone-ca-bundle
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  inject-ca-bundle: "true"
      generate:
        apiVersion: v1
        kind: ConfigMap
        name: ca-bundle
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
        clone:
          namespace: kyverno
          name: corporate-ca-bundle
```

### Generating RBAC Objects for New Namespaces

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-namespace-rbac
spec:
  rules:
    - name: generate-developer-rolebinding
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  team: "?*"
      context:
        - name: teamName
          variable:
            jmesPath: "request.object.metadata.labels.team"
      generate:
        apiVersion: rbac.authorization.k8s.io/v1
        kind: RoleBinding
        name: developer-binding
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
        data:
          subjects:
            - kind: Group
              name: "{{ teamName }}-developers"
              apiGroup: rbac.authorization.k8s.io
          roleRef:
            kind: ClusterRole
            name: edit
            apiGroup: rbac.authorization.k8s.io
```

## Verify Image Rules

**Verify image rules** integrate Cosign keyless signing or key-based signing into the admission path, blocking unsigned or improperly signed container images.

### Key-Based Cosign Signature Verification

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-signed-images
  annotations:
    policies.kyverno.io/title: Verify Image Signatures
    policies.kyverno.io/category: Supply Chain Security
    policies.kyverno.io/severity: high
spec:
  validationFailureAction: Enforce
  background: false
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-image-signature
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchLabels:
                  image-signing: required
      verifyImages:
        - imageReferences:
            - "registry.company.com/*"
          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXXXXXXXXXXXXXXXXXXXXXXXXXX
                      XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
                      -----END PUBLIC KEY-----
                    signatureAlgorithm: sha256
          mutateDigest: true
          verifyDigest: true
          required: true
```

### Keyless Signing with Sigstore Fulcio

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-keyless-signed-images
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-keyless
      match:
        any:
          - resources:
              kinds:
                - Pod
      verifyImages:
        - imageReferences:
            - "ghcr.io/myorg/*"
          attestors:
            - count: 1
              entries:
                - keyless:
                    subject: "https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
          attestations:
            - predicateType: https://slsa.dev/provenance/v0.2
              conditions:
                - all:
                    - key: "{{ builder.id }}"
                      operator: Equals
                      value: "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v1.9.0"
```

## Context Variables

Context variables let rules pull data from ConfigMaps, API server calls, and image registries at evaluation time.

### ConfigMap Context

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: allowed-registries-from-configmap
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-registry
      match:
        any:
          - resources:
              kinds:
                - Pod
      context:
        - name: allowedRegistries
          configMap:
            name: allowed-registries
            namespace: kyverno
      validate:
        message: >-
          Image registry not in the approved list. Allowed: {{ allowedRegistries.data.list }}.
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: AnyNotIn
                    value: "{{ allowedRegistries.data.list | parse_yaml(@) }}"
```

The referenced ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: allowed-registries
  namespace: kyverno
data:
  list: |
    - "registry.company.com/"
    - "gcr.io/trusted-project/"
    - "docker.io/company/"
```

### API Call Context

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: check-namespace-quota
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-quota-exists
      match:
        any:
          - resources:
              kinds:
                - Namespace
              operations:
                - CREATE
      context:
        - name: existingQuotas
          apiCall:
            urlPath: "/api/v1/namespaces/{{ request.object.metadata.name }}/resourcequotas"
            jmesPath: "items | length(@)"
      preconditions:
        all:
          - key: "{{ request.object.metadata.labels.environment || 'none' }}"
            operator: Equals
            value: production
      validate:
        message: "Production namespaces must have at least one ResourceQuota before namespace creation completes."
        deny:
          conditions:
            all:
              - key: "{{ existingQuotas }}"
                operator: LessThan
                value: 1
```

### imageRegistry Context

The `imageRegistry` context type queries an OCI registry for image metadata without pulling the image:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: check-image-labels
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-image-has-maintainer-label
      match:
        any:
          - resources:
              kinds:
                - Pod
      context:
        - name: imageData
          imageRegistry:
            reference: "{{ request.object.spec.containers[0].image }}"
            jmesPath: "configData.config.Labels"
      validate:
        message: "Container images must have a 'maintainer' OCI label."
        deny:
          conditions:
            all:
              - key: "{{ imageData.maintainer || '' }}"
                operator: Equals
                value: ""
```

## Background Scanning

Background scanning evaluates existing cluster resources against policies even when no admission event occurs. Scan results populate `PolicyReport` and `ClusterPolicyReport` CRDs:

```bash
# Check background scan results
kubectl get policyreport -A
kubectl get clusterpolicyreport

# Examine a specific namespace report
kubectl get policyreport -n production -o yaml

# List all violations in the cluster
kubectl get policyreport -A -o json \
  | jq '.items[].results[] | select(.result=="fail") | {policy: .policy, resource: .resources[0].name, message: .message}'
```

Configure scan interval and concurrency via Helm values:

```yaml
features:
  backgroundScan:
    enabled: true
    backgroundScanInterval: 1h
    backgroundScanWorkers: 4
    skipResourceFilters: false
```

## Policy Exceptions

**PolicyException** resources grant targeted exemptions to specific resources without modifying the policy itself:

```yaml
apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  name: exempt-legacy-app
  namespace: kyverno          # Must be in the configured exceptions namespace
spec:
  exceptions:
    - policyName: disallow-privilege-escalation
      ruleNames:
        - no-privilege-escalation
    - policyName: require-labels
      ruleNames:
        - check-team-label
  match:
    any:
      - resources:
          kinds:
            - Deployment
          namespaces:
            - legacy-apps
          names:
            - payment-processor-v1
          operations:
            - CREATE
            - UPDATE
  conditions:
    any:
      - key: "{{ request.object.metadata.annotations.\"kyverno.io/exception-reason\" || '' }}"
        operator: NotEquals
        value: ""
```

Restrict who can create PolicyExceptions using RBAC:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kyverno-exception-manager
rules:
  - apiGroups:
      - kyverno.io
    resources:
      - policyexceptions
    verbs:
      - create
      - update
      - delete
      - get
      - list
      - watch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kyverno-exception-manager
subjects:
  - kind: Group
    name: platform-admins
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: ClusterRole
  name: kyverno-exception-manager
  apiGroup: rbac.authorization.k8s.io
```

## Policy Reports

Policy reports are Kubernetes-native objects that represent the compliance posture of the cluster:

```bash
# Summary view of all namespace reports
kubectl get policyreport -A \
  --sort-by='.metadata.namespace' \
  -o custom-columns='NAMESPACE:.metadata.namespace,PASS:.summary.pass,FAIL:.summary.fail,WARN:.summary.warn,ERROR:.summary.error,SKIP:.summary.skip'

# Export all failures to JSON for a SIEM or ticketing system
kubectl get policyreport -A -o json \
  | jq '[.items[] | .results[] | select(.result=="fail") | {
      namespace: .resources[0].namespace,
      name: .resources[0].name,
      kind: .resources[0].kind,
      policy: .policy,
      rule: .rule,
      message: .message,
      category: .category,
      severity: .severity
    }]' > policy-violations.json
```

### Prometheus Integration for Policy Reports

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kyverno
  namespace: kyverno
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kyverno
  endpoints:
    - port: metrics-port
      interval: 30s
      path: /metrics
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kyverno-policy-alerts
  namespace: kyverno
spec:
  groups:
    - name: kyverno
      rules:
        - alert: KyvernoPolicyViolationsHigh
          expr: >
            sum by (policy_name) (
              kyverno_policy_results_total{rule_result="fail"}
            ) > 10
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High Kyverno policy violation count"
            description: "Policy {{ $labels.policy_name }} has {{ $value }} failures."

        - alert: KyvernoAdmissionWebhookDown
          expr: up{job="kyverno-svc"} == 0
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Kyverno admission webhook is unreachable"
            description: "Kyverno admission controller pod may be down or unhealthy."

        - alert: KyvernoHighWebhookLatency
          expr: >
            histogram_quantile(0.99,
              rate(kyverno_admission_review_duration_seconds_bucket[5m])
            ) > 2
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Kyverno admission webhook p99 latency above 2s"
```

## Kyverno CLI for CI/CD

The **Kyverno CLI** (`kyverno`) tests policies against resource manifests in a pipeline without a live cluster:

### Installation

```bash
# Via Homebrew
brew install kyverno

# Via curl
curl -Lo kyverno https://github.com/kyverno/kyverno/releases/download/v1.12.0/kyverno_linux_amd64_v1.12.0.tar.gz
tar -xzf kyverno_linux_amd64_v1.12.0.tar.gz
chmod +x kyverno
mv kyverno /usr/local/bin/kyverno
```

### Testing Policies Locally

```bash
# Apply policies to manifests (dry-run, no cluster required)
kyverno apply ./policies/ --resource ./manifests/deployment.yaml

# Test with multiple resources
kyverno apply ./policies/ --resource ./manifests/ -o table

# Output as JSON for pipeline consumption
kyverno apply ./policies/ --resource ./manifests/ -o json > kyverno-results.json

# Exit non-zero on policy failures (useful for CI gates)
kyverno apply ./policies/ --resource ./manifests/ --detailed-results
echo "Exit code: $?"
```

### CLI Test Suites

Define test cases with expected outcomes:

```yaml
# kyverno-test.yaml
name: require-labels-test
policies:
  - ./policies/require-labels.yaml
resources:
  - ./test-resources/deployment-with-labels.yaml
  - ./test-resources/deployment-without-labels.yaml
results:
  - policy: require-labels
    rule: check-team-label
    resource: deployment-with-labels
    result: pass
  - policy: require-labels
    rule: check-team-label
    resource: deployment-without-labels
    result: fail
```

Run tests:

```bash
kyverno test ./tests/
# Example output:
# Executing require-labels-test...
# test/require-labels-test.yaml       require-labels/check-team-label  PASSED
```

### GitHub Actions Integration

```yaml
# .github/workflows/kyverno-gate.yaml
name: Kyverno Policy Gate

on:
  pull_request:
    paths:
      - 'manifests/**'
      - 'helm/**'

jobs:
  kyverno-validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Kyverno CLI
        run: |
          curl -Lo kyverno.tar.gz https://github.com/kyverno/kyverno/releases/download/v1.12.0/kyverno_linux_amd64_v1.12.0.tar.gz
          tar -xzf kyverno.tar.gz kyverno
          chmod +x kyverno
          mv kyverno /usr/local/bin/kyverno

      - name: Render Helm templates
        run: |
          helm template myapp ./helm/myapp \
            --values ./helm/myapp/values-production.yaml \
            --output-dir ./rendered

      - name: Run Kyverno policy checks
        run: |
          kyverno apply ./policies/ \
            --resource ./rendered/ \
            --detailed-results \
            -o table
        # Non-zero exit code fails the workflow

      - name: Run Kyverno test suites
        run: |
          kyverno test ./kyverno-tests/
```

## Admission Webhook Configuration

Fine-tune the webhook to reduce latency and avoid false rejections:

```yaml
# Adjust webhook timeout and failure policy after stabilization
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: kyverno-resource-validating-webhook-cfg
webhooks:
  - name: validate.kyverno.svc-fail
    admissionReviewVersions:
      - v1
    clientConfig:
      service:
        name: kyverno-svc
        namespace: kyverno
        port: 443
    failurePolicy: Fail          # Switch from Ignore once policies are stable
    matchPolicy: Equivalent
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values:
            - kyverno
            - kube-system
    rules:
      - apiGroups:
          - "*"
        apiVersions:
          - "*"
        operations:
          - CREATE
          - UPDATE
        resources:
          - "*"
    sideEffects: None
    timeoutSeconds: 10           # Keep under kube-apiserver's 30s limit
```

Verify webhook health:

```bash
# Check webhook endpoint connectivity
kubectl get endpoints -n kyverno kyverno-svc

# Confirm recent admission reviews are succeeding
kubectl -n kyverno logs -l app.kubernetes.io/component=admission-controller \
  --tail=100 | grep -E "(admitted|denied|error)"

# View webhook latency histogram
kubectl -n kyverno exec -it deploy/kyverno-admission-controller -- \
  wget -qO- http://localhost:9090/metrics \
  | grep kyverno_admission_review_duration_seconds
```

## Troubleshooting Common Issues

### Policy Not Triggering

```bash
# Confirm the policy is ready
kubectl get clusterpolicy -o wide

# Check for syntax errors
kubectl describe clusterpolicy require-labels | grep -A 20 Conditions

# Test with CLI before applying
kyverno apply ./policy.yaml --resource ./test-pod.yaml --detailed-results
```

### Webhook Timeout Causing Pod Creation Failures

```bash
# Check kyverno pod readiness
kubectl -n kyverno get pods

# Review recent events for timeout errors
kubectl get events -A --field-selector reason=FailedCreate \
  | grep kyverno

# Temporarily set failurePolicy to Ignore for emergency recovery
kubectl patch validatingwebhookconfiguration kyverno-resource-validating-webhook-cfg \
  --type='json' \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Ignore"}]'
```

### Background Scan Not Producing Reports

```bash
# Confirm background controller is running
kubectl -n kyverno get deploy kyverno-background-controller

# Force a manual scan
kubectl -n kyverno rollout restart deploy/kyverno-background-controller

# Check logs for scan errors
kubectl -n kyverno logs -l app.kubernetes.io/component=background-controller \
  --tail=200 | grep -E "(ERROR|scan)"
```

## Best Practices

### Policy Lifecycle Management

1. **Audit mode first**: Start with `validationFailureAction: Audit` to observe violations without blocking workloads. Promote to `Enforce` only after confirming no legitimate workloads are blocked.

2. **Version control all policies**: Store `ClusterPolicy` manifests in a GitOps repository alongside application manifests. Apply changes through pull request review.

3. **Use policy annotations**: Add `policies.kyverno.io/title`, `policies.kyverno.io/category`, `policies.kyverno.io/severity`, and `policies.kyverno.io/description` annotations to every policy for discoverability.

4. **Scope with namespaceSelector**: Restrict policies to relevant namespaces to reduce webhook latency and avoid interfering with system workloads.

5. **Test before applying**: Run `kyverno apply` against every manifest changed in a pull request. Gate merges on zero failures.

6. **Document exceptions**: Every `PolicyException` must include a comment or annotation explaining the business justification and an expiry date where applicable.

### Performance Tuning

- Keep `background: false` on expensive `verifyImages` rules since signature verification adds significant latency to the admission path.
- Use `preconditions` to short-circuit evaluation when rules are not applicable to the resource being admitted.
- Scale admission controller replicas to at least 3 across different nodes in production clusters with high admission rates.
- Monitor `kyverno_admission_review_duration_seconds` and alert when p99 exceeds 2 seconds.

## Conclusion

Kyverno delivers comprehensive Kubernetes policy management through a purely declarative YAML interface. The four rule types — validate, mutate, generate, and verify image — cover the full lifecycle from admission control to supply-chain security without requiring operators to learn a specialized language. Background scanning combined with `PolicyReport` CRDs provides continuous compliance visibility, and the Kyverno CLI integrates naturally into existing CI/CD pipelines as a pre-merge policy gate. For organizations running multiple clusters, a GitOps-driven approach to policy distribution ensures consistent enforcement across all environments.
