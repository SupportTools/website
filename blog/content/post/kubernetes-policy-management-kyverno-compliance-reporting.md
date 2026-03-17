---
title: "Kubernetes Policy Management: Kyverno Policy Sets, Mutation Policies, and Compliance Reporting"
date: 2030-01-26T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kyverno", "Policy", "Security", "Compliance", "OPA", "Admission Control"]
categories: ["Kubernetes", "Security", "DevOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master advanced Kyverno usage including generate policies, mutation webhooks, ClusterPolicy best practices, audit vs enforce modes, policy reports, and enterprise compliance reporting for Kubernetes clusters."
more_link: "yes"
url: "/kubernetes-policy-management-kyverno-compliance-reporting/"
---

Kyverno has matured from a simple admission controller into a comprehensive Kubernetes-native policy engine capable of validating, mutating, generating, and verifying supply chain artifacts — all through Kubernetes-native YAML resources. Unlike OPA/Gatekeeper which requires learning Rego, Kyverno policies are written in YAML using familiar Kubernetes patterns and support complex JMESPath expressions, Kyverno functions, and CEL expressions natively.

This guide covers advanced Kyverno deployment, generate policies for automatic resource creation, mutation policies for standards enforcement, policy report integration, audit vs enforce modes, and building enterprise compliance dashboards.

<!--more-->

## Kyverno Architecture and Components

Kyverno runs as three separate deployments for HA and separation of concerns:

- **Admission Controller**: Validates and mutates resources at admission time (synchronous, blocks bad resources)
- **Background Controller**: Runs generate and mutate policies against existing resources
- **Reports Controller**: Aggregates policy results into PolicyReport and ClusterPolicyReport resources
- **Cleanup Controller**: Manages TTL-based resource cleanup

### Installing Kyverno with Helm (Production Configuration)

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

# Production installation with HA and resource tuning
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --version 3.2.6 \
  -f kyverno-values.yaml
```

### kyverno-values.yaml

```yaml
# kyverno-values.yaml
admissionController:
  replicas: 3
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app.kubernetes.io/component: admission-controller
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  startupProbe:
    failureThreshold: 20
  podDisruptionBudget:
    enabled: true
    minAvailable: 2

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

config:
  # Exclude kyverno system namespace from policies
  excludeGroupRole:
    - system:serviceaccounts:kyverno
  excludeUsername: []

features:
  policyExceptions:
    enabled: true
  backgroundScan:
    enabled: true
    backgroundScanWorkers: 4
    backgroundScanInterval: 1h
  generateValidatingAdmissionPolicy:
    enabled: false

# Metrics for Prometheus
metricsConfig:
  enabled: true
  namespaces:
    include: []
    exclude: ["kyverno", "kube-system"]

webhooksCleanup:
  enabled: true

crds:
  install: true
```

## Validation Policies

### ClusterPolicy: Require Resource Limits

```yaml
# policy-require-limits.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
  annotations:
    policies.kyverno.io/title: "Require Resource Limits"
    policies.kyverno.io/category: "Best Practices"
    policies.kyverno.io/severity: "medium"
    policies.kyverno.io/subject: "Pod"
    policies.kyverno.io/description: >-
      Require all containers to specify CPU and memory limits.
      This prevents resource exhaustion and ensures fair scheduling.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: validate-limits
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
          - subjects:
              - kind: ServiceAccount
                name: system:node
      validate:
        message: "CPU and memory limits are required for all containers."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.resources.limits.cpu || '' }}"
                    operator: Equals
                    value: ""
                  - key: "{{ element.resources.limits.memory || '' }}"
                    operator: Equals
                    value: ""
    - name: validate-init-container-limits
      match:
        any:
          - resources:
              kinds:
                - Pod
      preconditions:
        any:
          - key: "{{ request.object.spec.initContainers[] | length(@) }}"
            operator: GreaterThan
            value: 0
      validate:
        message: "CPU and memory limits are required for all init containers."
        foreach:
          - list: "request.object.spec.initContainers"
            deny:
              conditions:
                any:
                  - key: "{{ element.resources.limits.cpu || '' }}"
                    operator: Equals
                    value: ""
                  - key: "{{ element.resources.limits.memory || '' }}"
                    operator: Equals
                    value: ""
```

### ClusterPolicy: Disallow Privileged Containers

```yaml
# policy-disallow-privileged.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privileged-containers
  annotations:
    policies.kyverno.io/title: "Disallow Privileged Containers"
    policies.kyverno.io/category: "Pod Security"
    policies.kyverno.io/severity: "high"
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: privileged-containers
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Privileged mode is not allowed."
        pattern:
          spec:
            =(initContainers):
              - =(securityContext):
                  =(privileged): "false"
            containers:
              - =(securityContext):
                  =(privileged): "false"
    - name: disallow-host-namespaces
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Sharing the host namespaces is not allowed."
        pattern:
          spec:
            =(hostPID): "false"
            =(hostIPC): "false"
            =(hostNetwork): "false"
    - name: restrict-host-ports
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Host ports are not allowed."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.ports[].hostPort | max(@) || `0` }}"
                    operator: GreaterThan
                    value: 0
```

### Namespace-Scoped Policy

```yaml
# policy-namespace-labels.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-namespace-labels
spec:
  validationFailureAction: Audit
  background: true
  rules:
    - name: check-team-label
      match:
        any:
          - resources:
              kinds:
                - Namespace
      exclude:
        any:
          - resources:
              names:
                - kube-system
                - kube-public
                - kube-node-lease
                - kyverno
                - cert-manager
                - monitoring
      validate:
        message: "Namespace must have labels: 'team', 'environment', and 'cost-center'."
        pattern:
          metadata:
            labels:
              team: "?*"
              environment: "dev | staging | production"
              cost-center: "?*"
```

## Mutation Policies

Mutation policies automatically modify resources to enforce standards without blocking deployments.

### Auto-inject Security Context

```yaml
# policy-mutate-security-context.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-security-context
  annotations:
    policies.kyverno.io/title: "Add Default Security Context"
    policies.kyverno.io/category: "Security"
spec:
  rules:
    - name: add-container-security-context
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
      mutate:
        foreach:
          - list: "request.object.spec.containers"
            patchStrategicMerge:
              spec:
                containers:
                  - name: "{{ element.name }}"
                    securityContext:
                      allowPrivilegeEscalation: false
                      readOnlyRootFilesystem: true
                      runAsNonRoot: true
                      runAsUser: 1000
                      capabilities:
                        drop:
                          - ALL
                      seccompProfile:
                        type: RuntimeDefault
    - name: add-pod-security-context
      match:
        any:
          - resources:
              kinds:
                - Pod
      mutate:
        patchStrategicMerge:
          spec:
            +(securityContext):
              runAsNonRoot: true
              seccompProfile:
                type: RuntimeDefault
```

### Auto-inject Default Resource Requests

```yaml
# policy-mutate-resource-defaults.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-resources
  annotations:
    policies.kyverno.io/title: "Add Default Resource Requests"
spec:
  rules:
    - name: add-default-requests
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - development
                - staging
      mutate:
        foreach:
          - list: "request.object.spec.containers"
            preconditions:
              any:
                - key: "{{ element.resources.requests.cpu || '' }}"
                  operator: Equals
                  value: ""
            patchStrategicMerge:
              spec:
                containers:
                  - name: "{{ element.name }}"
                    resources:
                      requests:
                        +(cpu): "50m"
                        +(memory): "64Mi"
                      limits:
                        +(cpu): "500m"
                        +(memory): "512Mi"
```

### Add Labels and Annotations

```yaml
# policy-mutate-labels.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-required-labels
spec:
  rules:
    - name: add-labels
      match:
        any:
          - resources:
              kinds:
                - Deployment
                - StatefulSet
                - DaemonSet
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(app.kubernetes.io/managed-by): kyverno
          spec:
            template:
              metadata:
                labels:
                  +(app.kubernetes.io/version): "{{ request.object.spec.template.spec.containers[0].image | split(@, ':')[1] || 'unknown' }}"
    - name: add-network-policy-annotation
      match:
        any:
          - resources:
              kinds:
                - Namespace
      mutate:
        patchMerge:
          metadata:
            annotations:
              +(kyverno.io/network-policy-applied): "true"
              +(kyverno.io/scanned-at): "{{ time_now_utc() }}"
```

## Generate Policies

Generate policies automatically create companion resources when a trigger resource is created or modified. This is invaluable for automatically creating NetworkPolicies, RoleBindings, LimitRanges, and ResourceQuotas.

### Auto-create Default NetworkPolicy

```yaml
# policy-generate-netpolicy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-default-network-policy
  annotations:
    policies.kyverno.io/title: "Generate Default NetworkPolicy"
    policies.kyverno.io/category: "Multi-Tenancy"
    policies.kyverno.io/description: >-
      Automatically creates a default deny NetworkPolicy when a new namespace
      is created. All ingress and egress traffic is denied by default.
spec:
  rules:
    - name: default-deny
      match:
        any:
          - resources:
              kinds:
                - Namespace
      exclude:
        any:
          - resources:
              names:
                - kube-system
                - kyverno
                - monitoring
                - cert-manager
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny-all
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true   # Keep in sync; if deleted, regenerate
        data:
          metadata:
            labels:
              kyverno-generated: "true"
              policy: default-deny
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
              - Egress
    - name: allow-dns-egress
      match:
        any:
          - resources:
              kinds:
                - Namespace
      exclude:
        any:
          - resources:
              names:
                - kube-system
                - kyverno
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: allow-dns-egress
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Egress
            egress:
              - ports:
                  - port: 53
                    protocol: UDP
                  - port: 53
                    protocol: TCP
```

### Auto-create LimitRange and ResourceQuota

```yaml
# policy-generate-quota.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-resource-quota
spec:
  rules:
    - name: generate-limitrange
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  team: "?*"
      generate:
        apiVersion: v1
        kind: LimitRange
        name: default-limits
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
        data:
          spec:
            limits:
              - type: Container
                default:
                  cpu: "500m"
                  memory: "256Mi"
                defaultRequest:
                  cpu: "50m"
                  memory: "64Mi"
                max:
                  cpu: "4"
                  memory: "4Gi"
              - type: Pod
                max:
                  cpu: "8"
                  memory: "8Gi"
    - name: generate-resource-quota
      match:
        any:
          - resources:
              kinds:
                - Namespace
              selector:
                matchLabels:
                  environment: development
      generate:
        apiVersion: v1
        kind: ResourceQuota
        name: development-quota
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
        data:
          spec:
            hard:
              requests.cpu: "4"
              requests.memory: "8Gi"
              limits.cpu: "8"
              limits.memory: "16Gi"
              pods: "20"
              services: "10"
              persistentvolumeclaims: "10"
```

### Auto-create RBAC from Namespace Labels

```yaml
# policy-generate-rbac.yaml
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
      generate:
        apiVersion: rbac.authorization.k8s.io/v1
        kind: RoleBinding
        name: developer-binding
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true
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

## Verifying Image Signatures (Supply Chain Security)

```yaml
# policy-verify-images.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
  annotations:
    policies.kyverno.io/title: "Verify Image Signatures"
    policies.kyverno.io/category: "Supply Chain Security"
    policies.kyverno.io/severity: "high"
spec:
  validationFailureAction: Enforce
  background: false
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-cosign-signature
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - production
      verifyImages:
        - imageReferences:
            - "registry.yourorg.com/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/yourorg/*/.github/workflows/*.yaml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
          attestations:
            - type: https://cosign.sigstore.dev/attestation/vuln/v1
              conditions:
                - any:
                    - key: "{{ time_since('', scanner.result.summary.CRITICAL, '') }}"
                      operator: LessThan
                      value: "24h"
                      message: "Critical CVE scan must be less than 24 hours old."
              attestors:
                - entries:
                    - keyless:
                        subject: "https://github.com/yourorg/security-scanner/.github/workflows/scan.yaml@refs/heads/main"
                        issuer: "https://token.actions.githubusercontent.com"
```

## Policy Exceptions

When a policy is too strict for a specific workload, use PolicyException instead of weakening the policy globally:

```yaml
# policy-exception.yaml
apiVersion: kyverno.io/v2beta1
kind: PolicyException
metadata:
  name: legacy-app-exception
  namespace: legacy
spec:
  exceptions:
    - policyName: disallow-privileged-containers
      ruleNames:
        - privileged-containers
    - policyName: require-resource-limits
      ruleNames:
        - validate-limits
  match:
    any:
      - resources:
          kinds:
            - Pod
          namespaces:
            - legacy
          selector:
            matchLabels:
              app: legacy-monitoring-agent
  # Exception is valid for 90 days
  conditions:
    any:
      - key: "{{ time_before('', '2030-06-01T00:00:00Z', '') }}"
        operator: Equals
        value: true
```

## Audit vs Enforce Modes

The `validationFailureAction` field controls behavior:

- **`Enforce`**: Blocks the resource creation/update. Returns HTTP 403 to the user.
- **`Audit`**: Allows the resource but records violations in PolicyReport. Ideal for testing.

### Migration Strategy: Audit First, Then Enforce

```bash
# Step 1: Deploy in Audit mode
kubectl apply -f policy-require-limits.yaml
# (policy has validationFailureAction: Audit)

# Step 2: Check existing violations
kubectl get policyreports --all-namespaces
kubectl get clusterpolicyreports

# Step 3: Review specific violations
kubectl get policyreport -n myapp -o jsonpath='{.results[*]}' | \
  python3 -m json.tool | grep -A5 '"result": "fail"'

# Step 4: Fix violations in application manifests
# Step 5: Switch to Enforce
kubectl patch clusterpolicy require-resource-limits \
  --type='json' \
  -p='[{"op": "replace", "path": "/spec/validationFailureAction", "value": "Enforce"}]'
```

### Per-Namespace Failure Actions

```yaml
# Different enforcement per namespace group
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-labels
spec:
  validationFailureAction: Audit   # Default: audit everywhere
  validationFailureActionOverrides:
    - action: Enforce              # Enforce in production
      namespaces:
        - production
        - production-*
    - action: Audit               # Audit-only in dev
      namespaces:
        - development
        - dev-*
  rules:
    - name: check-labels
      match:
        any:
          - resources:
              kinds:
                - Deployment
      validate:
        message: "Deployment must have 'app.kubernetes.io/name' label."
        pattern:
          metadata:
            labels:
              app.kubernetes.io/name: "?*"
```

## Policy Reports and Compliance Dashboard

Kyverno writes results to PolicyReport (namespace-scoped) and ClusterPolicyReport (cluster-scoped) custom resources:

### Querying Policy Reports

```bash
# Summary of all policy results across all namespaces
kubectl get policyreports --all-namespaces \
  -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,PASS:.summary.pass,FAIL:.summary.fail,WARN:.summary.warn,ERROR:.summary.error,SKIP:.summary.skip

# Get detailed failures for a namespace
kubectl get policyreport -n production -o json | \
  jq '.results[] | select(.result=="fail") | {policy: .policy, rule: .rule, message: .message, resource: .resources[0].name}'

# Count total violations by policy
kubectl get policyreports --all-namespaces -o json | \
  jq -r '.items[].results[] | select(.result=="fail") | .policy' | \
  sort | uniq -c | sort -rn
```

### Grafana Dashboard Data via kyverno-policy-reporter

```bash
# Install policy reporter with Grafana dashboard
helm repo add policy-reporter https://kyverno.github.io/policy-reporter
helm install policy-reporter policy-reporter/policy-reporter \
  --namespace policy-reporter \
  --create-namespace \
  --set kyvernoPlugin.enabled=true \
  --set ui.enabled=true \
  --set grafana.enabled=true \
  --set grafana.namespace=monitoring \
  --set metrics.enabled=true

# Forward to local port for browsing
kubectl port-forward -n policy-reporter service/policy-reporter-ui 8082:8080
```

### Custom Compliance Report Script

```bash
#!/bin/bash
# compliance-report.sh - Generate HTML compliance report

OUTPUT_FILE="compliance-report-$(date +%Y%m%d).html"

# Collect data
TOTAL_PASS=$(kubectl get policyreports --all-namespaces -o json | \
  jq '[.items[].summary.pass] | add // 0')
TOTAL_FAIL=$(kubectl get policyreports --all-namespaces -o json | \
  jq '[.items[].summary.fail] | add // 0')
TOTAL=$(($TOTAL_PASS + $TOTAL_FAIL))
COMPLIANCE_PCT=$(echo "scale=1; $TOTAL_PASS * 100 / $TOTAL" | bc 2>/dev/null || echo "N/A")

# Get top violating namespaces
TOP_VIOLATORS=$(kubectl get policyreports --all-namespaces -o json | \
  jq -r '.items[] | "\(.summary.fail)\t\(.metadata.namespace)"' | \
  sort -rn | head -10)

# Get top violating policies
TOP_POLICIES=$(kubectl get policyreports --all-namespaces -o json | \
  jq -r '.items[].results[] | select(.result=="fail") | .policy' | \
  sort | uniq -c | sort -rn | head -10)

cat > $OUTPUT_FILE << EOF
<!DOCTYPE html>
<html>
<head><title>Kyverno Compliance Report - $(date)</title></head>
<body>
<h1>Kubernetes Policy Compliance Report</h1>
<p>Generated: $(date)</p>
<h2>Summary</h2>
<table border="1">
  <tr><th>Metric</th><th>Value</th></tr>
  <tr><td>Total Checks</td><td>$TOTAL</td></tr>
  <tr><td>Passing</td><td>$TOTAL_PASS</td></tr>
  <tr><td>Failing</td><td>$TOTAL_FAIL</td></tr>
  <tr><td>Compliance Rate</td><td>$COMPLIANCE_PCT%</td></tr>
</table>
<h2>Top Violating Namespaces</h2>
<pre>$TOP_VIOLATORS</pre>
<h2>Top Violating Policies</h2>
<pre>$TOP_POLICIES</pre>
</body>
</html>
EOF

echo "Report written to: $OUTPUT_FILE"
```

## Background Scan Configuration

Background scanning checks existing resources against policies, not just new admissions:

```yaml
# kyverno-configmap-background.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kyverno
  namespace: kyverno
data:
  # How often background scan runs
  backgroundScan: "true"
  backgroundScanWorkers: "4"
  backgroundScanInterval: "1h"
  # Max age of policy reports before recreation
  maxReportChangeRequest: "1000"
```

```bash
# Manually trigger background scan for a specific policy
kubectl annotate clusterpolicy require-resource-limits \
  kyverno.io/trigger-background-scan="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Watch background scan progress
kubectl get backgroundscanreports --all-namespaces -w
```

## Prometheus Metrics Integration

```yaml
# prometheus-servicemonitor-kyverno.yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kyverno
  namespace: monitoring
  labels:
    release: prometheus
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kyverno
  namespaceSelector:
    matchNames:
      - kyverno
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
```

### Key Kyverno Prometheus Metrics

```promql
# Policy admission requests by action and result
kyverno_admission_requests_total{resource_type="Pod"}

# Background scan results
kyverno_policy_results_total{policy_type="ClusterPolicy", result="fail"}

# Policy processing duration
histogram_quantile(0.99, kyverno_admission_request_duration_seconds_bucket)

# Alert: High policy violation rate
- alert: HighKyvernoPolicyViolationRate
  expr: |
    (
      increase(kyverno_policy_results_total{result="fail"}[5m]) /
      increase(kyverno_admission_requests_total[5m])
    ) > 0.1
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High Kyverno policy violation rate: {{ $value | humanizePercentage }}"
```

## Advanced Policy Patterns

### CEL Expressions (Kubernetes 1.28+)

```yaml
# policy-cel-expressions.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: validate-container-images-cel
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-image-registry
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
                  c.image.startsWith('registry.yourorg.com/') ||
                  c.image.startsWith('gcr.io/distroless/')
                )
              message: "Only images from registry.yourorg.com or gcr.io/distroless are allowed."
            - expression: >-
                !object.spec.containers.exists(c,
                  c.image.endsWith(':latest') || !c.image.contains(':')
                )
              message: "Image tag 'latest' or missing tag is not allowed."
```

### Context Variables from ConfigMap

```yaml
# policy-with-context.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: check-allowed-registries
spec:
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
        message: "Image registry '{{ images.containers.*.registry }}' is not in the allowed list."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image | split(@, '/')[0] }}"
                    operator: AnyNotIn
                    value: "{{ allowedRegistries.data.registries | parse_yaml(@) }}"
```

## Production Rollout Strategy

### Step-by-Step Rollout

```bash
# Phase 1: Deploy Kyverno in audit mode (all policies)
# Phase 2: Identify and fix violations (2 weeks)
# Phase 3: Enable enforce for highest-severity policies in production
# Phase 4: Enable enforce for all policies

# Create policy bundle for Helm chart or kustomize
mkdir policies
cp policy-*.yaml policies/

# Apply all policies
kubectl apply -f policies/

# Monitor admission webhook health
kubectl get validatingwebhookconfigurations kyverno-resource-validating-webhook-cfg
kubectl describe validatingwebhookconfigurations kyverno-resource-validating-webhook-cfg | grep -A3 "Failure Policy"

# FailurePolicy: Ignore means Kyverno outage does NOT block deployments
# FailurePolicy: Fail means Kyverno outage BLOCKS all deployments
# Recommended: Ignore for most policies, Fail only for critical security policies
```

## Key Takeaways

Kyverno's Kubernetes-native approach makes enterprise policy management accessible without learning a new DSL:

1. **Audit before enforce**: Always start policies in Audit mode to understand the blast radius. Use the policy reporter to quantify violations before switching to Enforce.

2. **Generate policies reduce toil**: Auto-generating NetworkPolicies, LimitRanges, and RoleBindings on namespace creation eliminates human error and ensures every namespace starts compliant.

3. **Mutation policies enforce without blocking**: Injecting security contexts and resource defaults via mutation prevents violations while maintaining developer velocity.

4. **PolicyExceptions over policy weakening**: When a specific workload needs an exception, create a PolicyException with an expiry rather than softening the policy globally.

5. **Background scanning catches drift**: Resources modified out-of-band or deployed before policies existed will be caught by background scans.

6. **Policy reporter provides the compliance dashboard**: The policy-reporter Helm chart integrates directly with Grafana and Slack for continuous compliance monitoring without custom tooling.

7. **HA deployment is mandatory**: Three admission controller replicas with PodDisruptionBudget ensures policy enforcement survives node failures. Never run a single replica in production.
