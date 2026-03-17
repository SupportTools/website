---
title: "Kyverno: Kubernetes-Native Policy Engine for Security and Compliance"
date: 2027-11-15T00:00:00-05:00
draft: false
tags: ["Kyverno", "Policy", "Security", "Kubernetes", "Compliance"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kyverno policy engine covering validate, mutate, generate, and verifyImages policies, ClusterPolicy vs Policy, background scanning, policy exceptions, admission controller configuration, reporting, and migration from OPA Gatekeeper."
more_link: "yes"
url: "/kubernetes-policy-engine-kyverno-guide/"
---

Kyverno is a policy engine designed specifically for Kubernetes. Unlike OPA Gatekeeper which requires learning Rego, Kyverno policies are Kubernetes resources written in YAML that use the same patterns as Kubernetes manifests. This makes Kyverno accessible to platform teams without dedicated policy language expertise while providing powerful capabilities for validation, mutation, resource generation, and image verification.

This guide covers all four Kyverno policy types in depth, explains the operational model for admission control and background scanning, demonstrates policy exceptions for emergency overrides, and provides a migration guide from OPA Gatekeeper.

<!--more-->

# Kyverno: Kubernetes-Native Policy Engine for Security and Compliance

## Architecture Overview

Kyverno operates as a set of Kubernetes admission controllers and background controllers:

**Admission Controller**: Intercepts API server requests (CREATE, UPDATE, DELETE) and applies policies before resources are persisted.

**Background Controller**: Continuously scans existing resources against policies and reports violations. Also generates and synchronizes resources triggered by policies.

**Reports Controller**: Manages PolicyReport and ClusterPolicyReport resources that aggregate policy evaluation results.

**Cleanup Controller**: Handles resource cleanup based on TTL and conditions defined in CleanupPolicy resources.

```
kubectl apply → API Server → Kyverno Admission Webhook
                                    │
                    ┌───────────────┤
                    │               │
              Validate Policy    Mutate Policy
              (allow/deny)       (modify resource)
                    │               │
                    └───────────────┘
                            │
                    Resource Stored in etcd
                            │
                    Generate Policy ──► Create child resources
                            │
                    VerifyImages Policy ──► Check image signatures
```

## Installation

### Production Helm Installation

```yaml
# kyverno-values.yaml
replicaCount: 3

podDisruptionBudget:
  minAvailable: 1

resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 1000m
    memory: 512Mi

initResources:
  requests:
    cpu: 10m
    memory: 64Mi
  limits:
    cpu: 100m
    memory: 256Mi

admissionController:
  replicas: 3
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 1Gi

backgroundController:
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi

cleanupController:
  replicas: 1

reportsController:
  replicas: 1

webhooksCleanup:
  enabled: true

policyExceptionsNamespace: "kyverno-exceptions"

metricsConfig:
  namespaces:
    include: []
    exclude:
    - kube-system
    - kyverno
    - cert-manager

generatecontrollerExtraResources: []

config:
  excludeKyvernoNamespace: true
  resourceFilters:
  - '[Event,*,*]'
  - '[*/*,kube-system,*]'
  - '[*/*,kube-public,*]'
  - '[*/*,kube-node-lease,*]'
  - '[*,kyverno,*]'
  - '[*,cert-manager,*]'

serviceMonitor:
  enabled: true
  namespace: monitoring
```

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.0 \
  --values kyverno-values.yaml

# Verify installation
kubectl get pods -n kyverno
kubectl get clusterpolicy
```

## Validate Policies

### Required Labels Policy

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-labels
  annotations:
    policies.kyverno.io/title: "Require Labels"
    policies.kyverno.io/category: "Best Practices"
    policies.kyverno.io/severity: medium
    policies.kyverno.io/subject: Pod, Namespace
    policies.kyverno.io/description: >-
      Requires that all workloads have team, environment, and app labels for
      cost attribution and operational identification.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-required-labels
    match:
      any:
      - resources:
          kinds:
          - Deployment
          - StatefulSet
          - DaemonSet
          - Job
          - CronJob
          namespaces:
          - "production"
          - "staging"
    validate:
      message: >-
        Workloads in production/staging must have labels:
        app.kubernetes.io/name, team, environment
      pattern:
        metadata:
          labels:
            app.kubernetes.io/name: "?*"
            team: "?*"
            environment: "?*"
```

### Restrict Image Registries

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
  annotations:
    policies.kyverno.io/title: "Restrict Image Registries"
    policies.kyverno.io/category: "Supply Chain Security"
    policies.kyverno.io/severity: high
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: validate-registries
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
          - staging
    validate:
      message: >-
        Images must come from approved registries:
        registry.company.com, gcr.io/company-prod, public.ecr.aws/approved
      foreach:
      - list: "request.object.spec.containers"
        deny:
          conditions:
            any:
            - key: "{{ element.image }}"
              operator: NotEquals
              value: "registry.company.com/*"
            - key: "{{ element.image }}"
              operator: NotEquals
              value: "gcr.io/company-prod/*"
            - key: "{{ element.image }}"
              operator: NotEquals
              value: "public.ecr.aws/approved/*"
```

### Pod Security Validation

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privileged-containers
  annotations:
    policies.kyverno.io/title: "Disallow Privileged Containers"
    policies.kyverno.io/category: "Pod Security"
    policies.kyverno.io/severity: critical
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: no-privileged-containers
    match:
      any:
      - resources:
          kinds:
          - Pod
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - kyverno
          - monitoring
    validate:
      message: "Privileged containers are not allowed in production namespaces."
      pattern:
        spec:
          containers:
          - =(securityContext):
              =(privileged): "false"
          =(initContainers):
          - =(securityContext):
              =(privileged): "false"
          =(ephemeralContainers):
          - =(securityContext):
              =(privileged): "false"

  - name: no-privilege-escalation
    match:
      any:
      - resources:
          kinds:
          - Pod
    exclude:
      any:
      - resources:
          namespaces:
          - kube-system
          - kyverno
    validate:
      message: "Privilege escalation is not allowed."
      pattern:
        spec:
          containers:
          - securityContext:
              allowPrivilegeEscalation: "false"
```

### Resource Request Requirements

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-requests
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-container-resources
    match:
      any:
      - resources:
          kinds:
          - Deployment
          - StatefulSet
          - DaemonSet
          namespaces:
          - production
          - staging
    validate:
      message: "All containers must specify CPU and memory requests."
      foreach:
      - list: "request.object.spec.template.spec.containers"
        deny:
          conditions:
            any:
            - key: "{{ element.resources.requests.cpu || '' }}"
              operator: Equals
              value: ""
            - key: "{{ element.resources.requests.memory || '' }}"
              operator: Equals
              value: ""
```

### Advanced Validation with Variables

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: validate-pdb-coverage
spec:
  validationFailureAction: Audit
  background: true
  rules:
  - name: check-deployment-has-pdb
    match:
      any:
      - resources:
          kinds:
          - Deployment
          namespaces:
          - production
    preconditions:
      any:
      - key: "{{ request.object.spec.replicas }}"
        operator: GreaterThanOrEquals
        value: 2
    validate:
      message: >-
        Deployments with 2+ replicas should have a PodDisruptionBudget.
        Create a PDB in namespace {{ request.object.metadata.namespace }}.
      deny:
        conditions:
          any:
          - key: "{{ length(request.object.spec.template.metadata.labels) }}"
            operator: LessThan
            value: 1
```

## Mutate Policies

### Add Default Labels

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-labels
spec:
  rules:
  - name: add-environment-label
    match:
      any:
      - resources:
          kinds:
          - Pod
          - Deployment
          - StatefulSet
    mutate:
      patchStrategicMerge:
        metadata:
          labels:
            +(managed-by): kyverno
            +(environment): >-
              {{ request.object.metadata.namespace | split(@, '-') | [0] }}
```

### Inject Security Context

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: inject-security-context
spec:
  rules:
  - name: set-security-context
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
          - staging
    preconditions:
      all:
      - key: "{{ request.object.spec.containers[].securityContext.runAsNonRoot || 'false' }}"
        operator: AnyNotIn
        value:
        - "true"
    mutate:
      foreach:
      - list: "request.object.spec.containers"
        patchStrategicMerge:
          spec:
            containers:
            - name: "{{ element.name }}"
              securityContext:
                runAsNonRoot: true
                allowPrivilegeEscalation: false
                seccompProfile:
                  type: RuntimeDefault
                capabilities:
                  drop:
                  - ALL
```

### Add Network Policy Annotation

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: annotate-pods-for-network-policy
spec:
  rules:
  - name: add-network-policy-annotation
    match:
      any:
      - resources:
          kinds:
          - Deployment
          namespaces:
          - production
    mutate:
      patchStrategicMerge:
        spec:
          template:
            metadata:
              annotations:
                +(network-policy.company.com/applied): "true"
                +(network-policy.company.com/last-reviewed): "{{ request.object.metadata.creationTimestamp }}"
```

### Mutate with JMESPath

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: auto-set-resource-limits
spec:
  rules:
  - name: set-limits-from-requests
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
    mutate:
      foreach:
      - list: "request.object.spec.containers"
        preconditions:
          all:
          - key: "{{ element.resources.requests.memory || '' }}"
            operator: NotEquals
            value: ""
          - key: "{{ element.resources.limits.memory || '' }}"
            operator: Equals
            value: ""
        patchStrategicMerge:
          spec:
            containers:
            - name: "{{ element.name }}"
              resources:
                limits:
                  memory: >-
                    {{ element.resources.requests.memory }}
```

## Generate Policies

### Auto-Create NetworkPolicy

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-default-networkpolicy
spec:
  rules:
  - name: create-networkpolicy
    match:
      any:
      - resources:
          kinds:
          - Namespace
          selector:
            matchLabels:
              environment: production
    generate:
      synchronize: true
      kind: NetworkPolicy
      name: default-deny
      namespace: "{{ request.object.metadata.name }}"
      data:
        spec:
          podSelector: {}
          policyTypes:
          - Ingress
          - Egress
          egress:
          - to:
            - namespaceSelector:
                matchLabels:
                  kubernetes.io/metadata.name: kube-system
            ports:
            - protocol: UDP
              port: 53
```

### Clone Secret to Namespaces

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: sync-registry-secret
spec:
  rules:
  - name: sync-imagepullsecret
    match:
      any:
      - resources:
          kinds:
          - Namespace
    generate:
      synchronize: true
      kind: Secret
      name: registry-credentials
      namespace: "{{ request.object.metadata.name }}"
      clone:
        namespace: default
        name: registry-credentials
```

### Generate RBAC for New Namespaces

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-team-rbac
spec:
  rules:
  - name: create-team-rolebinding
    match:
      any:
      - resources:
          kinds:
          - Namespace
          selector:
            matchLabels:
              team: "?*"
    generate:
      synchronize: true
      kind: RoleBinding
      name: team-developer-binding
      namespace: "{{ request.object.metadata.name }}"
      data:
        roleRef:
          apiGroup: rbac.authorization.k8s.io
          kind: ClusterRole
          name: developer
        subjects:
        - apiGroup: rbac.authorization.k8s.io
          kind: Group
          name: "{{ request.object.metadata.labels.team }}-developers"
```

### Generate ResourceQuota

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-resource-quota
spec:
  rules:
  - name: create-quota-small
    match:
      any:
      - resources:
          kinds:
          - Namespace
          selector:
            matchLabels:
              quota-tier: small
    generate:
      synchronize: true
      kind: ResourceQuota
      name: default-quota
      namespace: "{{ request.object.metadata.name }}"
      data:
        spec:
          hard:
            requests.cpu: "4"
            requests.memory: "8Gi"
            limits.cpu: "8"
            limits.memory: "16Gi"
            count/pods: "20"
            count/services: "10"
            persistentvolumeclaims: "5"
            requests.storage: "50Gi"

  - name: create-quota-large
    match:
      any:
      - resources:
          kinds:
          - Namespace
          selector:
            matchLabels:
              quota-tier: large
    generate:
      synchronize: true
      kind: ResourceQuota
      name: default-quota
      namespace: "{{ request.object.metadata.name }}"
      data:
        spec:
          hard:
            requests.cpu: "32"
            requests.memory: "64Gi"
            limits.cpu: "64"
            limits.memory: "128Gi"
            count/pods: "200"
            count/services: "50"
            persistentvolumeclaims: "50"
            requests.storage: "500Gi"
```

## VerifyImages Policies

### Cosign Image Signature Verification

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce
  background: false
  webhookTimeoutSeconds: 30
  failurePolicy: Fail
  rules:
  - name: verify-signature
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
    verifyImages:
    - imageReferences:
      - "registry.company.com/*"
      - "gcr.io/company-prod/*"
      attestors:
      - count: 1
        entries:
        - keys:
            publicKeys: |-
              -----BEGIN PUBLIC KEY-----
              MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
              -----END PUBLIC KEY-----
            signatureAlgorithm: sha256
            rekor:
              url: https://rekor.sigstore.dev
      mutateDigest: true
      required: true
      verifyDigest: true
```

### SBOM Attestation Verification

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-sbom-attestation
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: verify-sbom
    match:
      any:
      - resources:
          kinds:
          - Pod
          namespaces:
          - production
    verifyImages:
    - imageReferences:
      - "registry.company.com/*"
      attestations:
      - type: https://spdx.dev/Document
        conditions:
        - all:
          - key: "{{ documentNamespace }}"
            operator: NotEquals
            value: ""
      attestors:
      - entries:
        - keys:
            publicKeys: |-
              -----BEGIN PUBLIC KEY-----
              MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...
              -----END PUBLIC KEY-----
```

## Policy Exceptions

Policy exceptions allow specific resources to bypass policies without modifying the policy itself. This is critical for emergency access and for managed components that legitimately need to violate standard policies.

```yaml
apiVersion: kyverno.io/v2beta1
kind: PolicyException
metadata:
  name: allow-privileged-monitoring
  namespace: kyverno-exceptions
spec:
  exceptions:
  - policyName: disallow-privileged-containers
    ruleNames:
    - no-privileged-containers
    - no-privilege-escalation
  match:
    any:
    - resources:
        kinds:
        - Pod
        namespaces:
        - monitoring
        selector:
          matchLabels:
            app.kubernetes.io/name: node-exporter
```

```yaml
apiVersion: kyverno.io/v2beta1
kind: PolicyException
metadata:
  name: allow-internal-registry-bypass
  namespace: kyverno-exceptions
spec:
  exceptions:
  - policyName: restrict-image-registries
    ruleNames:
    - validate-registries
  match:
    any:
    - resources:
        kinds:
        - Pod
        namespaces:
        - kube-system
        - cert-manager
        - ingress-nginx
```

### Emergency Exception with Expiry

```yaml
apiVersion: kyverno.io/v2beta1
kind: PolicyException
metadata:
  name: emergency-exception-incident-2025
  namespace: kyverno-exceptions
  annotations:
    policy.company.com/approved-by: "security-team"
    policy.company.com/incident: "INC-2025-0042"
    policy.company.com/expires: "2025-11-30T23:59:59Z"
spec:
  exceptions:
  - policyName: require-resource-requests
    ruleNames:
    - check-container-resources
  match:
    any:
    - resources:
        kinds:
        - Deployment
        namespaces:
        - production
        names:
        - emergency-patch-service
```

## Policy Reports

### Viewing Policy Reports

```bash
# View policy violations in all namespaces
kubectl get policyreport -A

# Get detailed violations for a namespace
kubectl get policyreport -n production -o json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for report in data.get('items', []):
    for result in report.get('results', []):
        if result.get('result') == 'fail':
            print(f'{result[\"policy\"]}/{result[\"rule\"]}: {result[\"message\"]}')
            print(f'  Resource: {result[\"resources\"][0][\"kind\"]}/{result[\"resources\"][0][\"name\"]}')
            print()
"

# Get cluster-wide policy report
kubectl get clusterpolicyreport -o yaml

# Count violations by policy
kubectl get policyreport -A -o json | \
  python3 -c "
import json, sys
from collections import Counter
data = json.load(sys.stdin)
violations = Counter()
for report in data.get('items', []):
    for result in report.get('results', []):
        if result.get('result') == 'fail':
            violations[result['policy']] += 1
for policy, count in violations.most_common(10):
    print(f'{count:5d}  {policy}')
"
```

### PolicyReport Dashboard in Grafana

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kyverno-policy-alerts
  namespace: monitoring
spec:
  groups:
  - name: kyverno.policies
    rules:
    - alert: KyvernoPolicyViolations
      expr: |
        sum(kyverno_policy_results_total{rule_result="fail"}) by (policy_name, namespace_name) > 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Kyverno policy violations detected"
        description: "Policy {{ $labels.policy_name }} has {{ $value }} violations in {{ $labels.namespace_name }}"

    - alert: KyvernoAdmissionControllerDown
      expr: |
        absent(up{job="kyverno-admission-controller"} == 1)
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Kyverno admission controller is down"
        description: "Policy enforcement is not active"
```

## Background Scanning Configuration

```yaml
# Configure background scan interval and behavior
apiVersion: v1
kind: ConfigMap
metadata:
  name: kyverno
  namespace: kyverno
data:
  # Reduce background scan interval for faster reporting
  backgroundScan: "true"
  backgroundScanInterval: "1h"
  # Number of concurrent background scan workers
  backgroundScanWorkers: "2"
  # Generate reports for background scans
  generateSuccessEvents: "false"
```

## ClusterPolicy vs Policy Scope

```yaml
# ClusterPolicy: applies across all namespaces
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: cluster-wide-policy
spec:
  rules:
  - name: cluster-rule
    match:
      any:
      - resources:
          kinds:
          - Pod
          # No namespace restriction - applies everywhere

---
# Policy: namespace-scoped only
apiVersion: kyverno.io/v1
kind: Policy
metadata:
  name: namespace-scoped-policy
  namespace: production  # Only applies within production namespace
spec:
  rules:
  - name: production-rule
    match:
      any:
      - resources:
          kinds:
          - Deployment
```

## Migration from OPA Gatekeeper

### Comparison of Concepts

| OPA Gatekeeper | Kyverno |
|----------------|---------|
| ConstraintTemplate | ClusterPolicy (validate) |
| Constraint | ClusterPolicy with match rules |
| Rego policy | JMESPath/CEL expressions |
| Config (exclusions) | exclude block in policy |
| Audit | background: true |
| ExternalData | Context variables |

### Migrating a Gatekeeper Policy

**Original Gatekeeper ConstraintTemplate:**

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        properties:
          labels:
            type: array
            items:
              type: string
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequiredlabels

      violation[{"msg": msg, "details": {"missing_labels": missing}}] {
        provided := {label | input.review.object.metadata.labels[label]}
        required := {label | label := input.parameters.labels[_]}
        missing := required - provided
        count(missing) > 0
        msg := sprintf("Missing required labels: %v", [missing])
      }
```

**Equivalent Kyverno Policy:**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: k8s-required-labels
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-required-labels
    match:
      any:
      - resources:
          kinds:
          - Deployment
          - StatefulSet
          - DaemonSet
    validate:
      message: >-
        Required labels are missing: app.kubernetes.io/name, team, environment
      pattern:
        metadata:
          labels:
            app.kubernetes.io/name: "?*"
            team: "?*"
            environment: "?*"
```

### Migration Script

```bash
#!/bin/bash
# gatekeeper-to-kyverno-audit.sh
# Identifies existing Gatekeeper resources for migration assessment

echo "=== Gatekeeper to Kyverno Migration Assessment ==="
echo ""

echo "--- Existing ConstraintTemplates ---"
kubectl get constrainttemplates 2>/dev/null || echo "No ConstraintTemplates found"

echo ""
echo "--- Active Constraints ---"
kubectl get constraints -A 2>/dev/null || echo "No Constraints found"

echo ""
echo "--- Constraint Violation Count ---"
kubectl get constraints -A -o json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
total = 0
for item in data.get('items', []):
    status = item.get('status', {})
    violations = len(status.get('violations', []))
    total += violations
    if violations > 0:
        print(f'  {item[\"kind\"]}: {violations} violations')
print(f'Total violations: {total}')
" 2>/dev/null || echo "Could not retrieve violation data"

echo ""
echo "--- Migration Recommendation ---"
echo "1. Install Kyverno alongside Gatekeeper"
echo "2. Convert policies in Audit mode first"
echo "3. Verify violations match Gatekeeper output"
echo "4. Switch Kyverno to Enforce mode"
echo "5. Remove Gatekeeper ConstraintTemplates"
echo "6. Uninstall Gatekeeper"
```

### Side-by-Side Testing

```bash
# Install Kyverno in Audit mode while Gatekeeper remains active
# Both will report violations but only Gatekeeper blocks

# Compare violations
echo "Gatekeeper violations:"
kubectl get constraints -A -o json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data.get('items', []):
    for v in item.get('status', {}).get('violations', []):
        print(f'  {item[\"kind\"]}: {v[\"resource\"]} - {v[\"message\"]}')
"

echo ""
echo "Kyverno violations (audit mode):"
kubectl get policyreport -A -o json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for report in data.get('items', []):
    for result in report.get('results', []):
        if result.get('result') == 'fail':
            r = result.get('resources', [{}])[0]
            print(f'  {result[\"policy\"]}: {r.get(\"kind\")}/{r.get(\"name\")} - {result[\"message\"]}')
"
```

## Advanced Policy Patterns

### Using Context for External Data

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: validate-against-configmap
spec:
  rules:
  - name: check-allowed-images
    match:
      any:
      - resources:
          kinds:
          - Pod
    context:
    - name: allowedImages
      configMap:
        name: approved-images
        namespace: kyverno
    validate:
      message: >-
        Image {{ request.object.spec.containers[0].image }} is not in the approved images list.
      foreach:
      - list: "request.object.spec.containers"
        deny:
          conditions:
            all:
            - key: "{{ element.image }}"
              operator: AnyNotIn
              value: "{{ allowedImages.data.images | parse_yaml(@) }}"
```

### Cross-Namespace Policy with API Lookup

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: validate-service-account-exists
spec:
  rules:
  - name: check-sa-exists
    match:
      any:
      - resources:
          kinds:
          - Deployment
    context:
    - name: serviceAccountExists
      apiCall:
        urlPath: "/api/v1/namespaces/{{ request.object.metadata.namespace }}/serviceaccounts/{{ request.object.spec.template.spec.serviceAccountName }}"
        jmesPath: "metadata.name"
    validate:
      message: >-
        ServiceAccount {{ request.object.spec.template.spec.serviceAccountName }}
        does not exist in namespace {{ request.object.metadata.namespace }}
      deny:
        conditions:
          any:
          - key: "{{ serviceAccountExists }}"
            operator: Equals
            value: ""
```

## Kyverno CLI for Policy Testing

```bash
# Install Kyverno CLI
curl -LO https://github.com/kyverno/kyverno/releases/latest/download/kyverno-cli_linux_amd64.tar.gz
tar -xvf kyverno-cli_linux_amd64.tar.gz
sudo mv kyverno /usr/local/bin/

# Test a policy against a resource
kyverno apply policy.yaml --resource resource.yaml

# Run policy tests
kyverno test ./tests/

# Apply with verbose output
kyverno apply ./policies/ \
  --resource ./test-resources/ \
  --detailed-results
```

### Policy Test Structure

```yaml
# kyverno-tests/require-labels-test.yaml
name: require-labels-tests
policies:
- ../policies/require-labels.yaml
resources:
- test-resources/passing-deployment.yaml
- test-resources/failing-deployment.yaml
results:
- policy: require-labels
  rule: check-required-labels
  resource: passing-deployment
  namespace: production
  result: pass
- policy: require-labels
  rule: check-required-labels
  resource: failing-deployment
  namespace: production
  result: fail
```

```bash
# Run tests in CI pipeline
kyverno test ./kyverno-tests/ --detailed-results

# Generate policy documentation
kyverno docs --output ./docs/policies/
```

## Summary

Kyverno provides a comprehensive Kubernetes-native policy engine that covers the full lifecycle of resource governance.

**Policy types**: Validate policies enforce standards and compliance requirements. Mutate policies inject defaults and security contexts automatically. Generate policies create dependent resources for namespace provisioning. VerifyImages policies enforce supply chain security by validating cosign signatures.

**Admission vs background**: Set `validationFailureAction: Enforce` for blocking policies and `validationFailureAction: Audit` during rollout. Enable `background: true` to scan existing resources and populate PolicyReport resources.

**Policy exceptions**: Use `PolicyException` resources in a controlled namespace (protected by RBAC) to allow emergency overrides without modifying policies. Include incident references and expiry annotations for audit compliance.

**Migration from Gatekeeper**: Kyverno uses JMESPath instead of Rego, which significantly reduces the learning curve. Run both systems in parallel with Kyverno in Audit mode to verify equivalent coverage before switching Gatekeeper off.

**Testing**: The Kyverno CLI enables test-driven policy development. Write tests alongside policies and integrate them into CI pipelines to prevent regressions when policies are updated.

**Performance**: For clusters with high pod creation rates, configure the admission controller with 3+ replicas and appropriate resource limits. The background controller is less latency-sensitive but consumes memory proportional to the number of resources being scanned.

The combination of YAML-native policy syntax, integrated reporting via PolicyReport, and rich mutate/generate capabilities makes Kyverno a strong choice for platform engineering teams building self-service infrastructure with guardrails.
