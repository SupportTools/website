---
title: "Kyverno: Kubernetes-Native Policy Engine for Security and Compliance"
date: 2028-10-18T00:00:00-05:00
draft: false
tags: ["Kyverno", "Kubernetes", "Policy", "Security", "Compliance"]
categories:
- Kyverno
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kyverno ClusterPolicy and Policy, covering validation, mutation, generation rules, image verification with Cosign, policy reports, background scanning, and comparison with OPA Gatekeeper."
more_link: "yes"
url: "/kubernetes-kyverno-policy-engine-guide/"
---

Every Kubernetes cluster without a policy engine is one misconfigured Deployment away from a security incident — a container running as root, an image pulled from an untrusted registry, a namespace created without resource quotas. Kyverno is a Kubernetes-native policy engine that validates, mutates, and generates resources using familiar Kubernetes YAML rather than a separate policy language like Rego. This makes it accessible to platform engineers who know YAML deeply but may not want to learn OPA's data model.

This guide covers Kyverno's four policy types in depth, production installation, image verification with Cosign, policy reports for compliance visibility, and a direct comparison with OPA Gatekeeper to help you choose the right tool.

<!--more-->

# Kyverno: Kubernetes-Native Policy Engine for Security and Compliance

## Installation

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

# Production: 3 replicas for HA, separate deployments for admission and background controller
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=2 \
  --set cleanupController.replicas=1 \
  --set reportsController.replicas=2 \
  --set admissionController.resources.limits.memory=512Mi \
  --set admissionController.resources.limits.cpu=500m \
  --version 3.3.0 \
  --wait

# Verify
kubectl get pods -n kyverno
# NAME                                         READY   STATUS    RESTARTS   AGE
# kyverno-admission-controller-xxx             1/1     Running   0          2m
# kyverno-background-controller-xxx            1/1     Running   0          2m
# kyverno-cleanup-controller-xxx               1/1     Running   0          2m
# kyverno-reports-controller-xxx               1/1     Running   0          2m
```

## ClusterPolicy vs Policy

- **ClusterPolicy**: cluster-scoped, applies across all namespaces (or filtered by `namespaceSelector`)
- **Policy**: namespace-scoped, only applies within the namespace where it is created

Use ClusterPolicy for security baselines that must hold everywhere. Use Policy for team-specific rules.

## Validation Rules

Validation rules admit or reject resources based on pattern matching, deny conditions, or CEL expressions.

### Requiring Security Context

```yaml
# validate-no-root-containers.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-root-containers
  annotations:
    policies.kyverno.io/title: Disallow Root Containers
    policies.kyverno.io/category: Pod Security
    policies.kyverno.io/severity: high
    policies.kyverno.io/description: >-
      Containers must not run as root. Requires runAsNonRoot=true
      or a specific non-root runAsUser.
spec:
  validationFailureAction: Enforce   # Enforce=block, Audit=log-only
  background: true                   # Also scan existing resources
  rules:
    - name: check-containers
      match:
        any:
          - resources:
              kinds: ["Pod"]
      exclude:
        any:
          - resources:
              namespaces: ["kube-system", "kyverno"]
      validate:
        message: >-
          Containers must set securityContext.runAsNonRoot=true
          or securityContext.runAsUser > 0.
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.securityContext.runAsNonRoot || false }}"
                    operator: Equals
                    value: false
                  - key: "{{ element.securityContext.runAsUser || 0 }}"
                    operator: Equals
                    value: 0
```

### Requiring Resource Limits

```yaml
# validate-resource-limits.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-limits
      match:
        any:
          - resources:
              kinds: ["Pod"]
      exclude:
        any:
          - resources:
              namespaces: ["kube-system"]
      validate:
        message: "All containers must specify CPU and memory limits."
        foreach:
          - list: "request.object.spec.[containers, initContainers, ephemeralContainers][]"
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

### Restricting Image Registries

```yaml
# validate-allowed-registries.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-registries
      match:
        any:
          - resources:
              kinds: ["Pod"]
      exclude:
        any:
          - resources:
              namespaces: ["kube-system", "kyverno", "cert-manager"]
      validate:
        message: >-
          Images must come from registry.yourorg.com or gcr.io/distroless.
          Found: {{ request.object.spec.containers[].image }}.
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: NotEquals
                    value: "registry.yourorg.com/*"
                  - key: "{{ element.image }}"
                    operator: NotEquals
                    value: "gcr.io/distroless/*"
                  - key: "{{ element.image }}"
                    operator: NotEquals
                    value: "public.ecr.aws/eks-distro/*"
```

### Using CEL Expressions (Kyverno 1.11+)

```yaml
# validate-pod-labels-cel.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-pod-labels
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: require-team-label
      match:
        any:
          - resources:
              kinds: ["Deployment", "StatefulSet", "DaemonSet"]
      validate:
        cel:
          expressions:
            - expression: >-
                has(object.spec.template.metadata.labels) &&
                has(object.spec.template.metadata.labels.team)
              message: "Pod template must have a 'team' label."
            - expression: >-
                has(object.spec.template.metadata.labels) &&
                has(object.spec.template.metadata.labels.app)
              message: "Pod template must have an 'app' label."
            - expression: >-
                !has(object.spec.template.spec.hostNetwork) ||
                object.spec.template.spec.hostNetwork == false
              message: "hostNetwork is not permitted."
```

## Mutation Rules

Mutation rules modify resources before they are stored, injecting defaults or transforming values.

### Defaulting Security Context

```yaml
# mutate-security-context.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-security-context
spec:
  rules:
    - name: add-security-context
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
                  - (name): "{{ element.name }}"
                    securityContext:
                      +(runAsNonRoot): true
                      +(allowPrivilegeEscalation): false
                      +(readOnlyRootFilesystem): true
                      +(seccompProfile):
                        type: RuntimeDefault
                      capabilities:
                        +(drop): ["ALL"]
```

The `+()` syntax means "add if not present" — it never overwrites values the user has explicitly set.

### Adding Required Labels

```yaml
# mutate-add-labels.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-managed-by-label
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
                - Job
                - CronJob
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(app.kubernetes.io/managed-by): kyverno-policy
          spec:
            template:
              metadata:
                labels:
                  +(app.kubernetes.io/managed-by): kyverno-policy
```

### Image Tag Mutation (Pinning to Digest)

```yaml
# mutate-image-to-digest.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pin-image-digest
spec:
  rules:
    - name: pin-digest
      match:
        any:
          - resources:
              kinds: ["Pod"]
      mutate:
        foreach:
          - list: "request.object.spec.containers"
            context:
              - name: imageData
                imageRegistry:
                  reference: "{{ element.image }}"
                  jmesPath: "to_string(@)"
            patchStrategicMerge:
              spec:
                containers:
                  - (name): "{{ element.name }}"
                    image: "{{ element.image | regex_replace_all('(.+):(.+)', '{{1}}') }}@{{ imageData.manifest.digest }}"
```

## Generation Rules

Generation rules create new resources when a triggering resource is created. This is powerful for ensuring every namespace gets NetworkPolicies and ResourceQuotas automatically.

### Auto-Generate NetworkPolicy per Namespace

```yaml
# generate-network-policy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-network-policy
spec:
  rules:
    - name: generate-default-deny
      match:
        any:
          - resources:
              kinds: ["Namespace"]
      generate:
        synchronize: true   # Keep in sync if policy changes; delete if namespace deleted
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny-all
        namespace: "{{ request.object.metadata.name }}"
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
              - Egress
            egress:
              # Allow DNS
              - ports:
                  - port: 53
                    protocol: UDP
                  - port: 53
                    protocol: TCP
              # Allow access to kube-apiserver
              - ports:
                  - port: 443
                    protocol: TCP
                to:
                  - ipBlock:
                      cidr: 0.0.0.0/0
                      except:
                        - 10.0.0.0/8
                        - 172.16.0.0/12
                        - 192.168.0.0/16
```

### Auto-Generate ResourceQuota per Namespace

```yaml
# generate-resource-quota.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-resource-quota
spec:
  rules:
    - name: generate-quota
      match:
        any:
          - resources:
              kinds: ["Namespace"]
              selector:
                matchLabels:
                  team: "?*"  # Only for namespaces with a team label
      generate:
        synchronize: true
        apiVersion: v1
        kind: ResourceQuota
        name: team-quota
        namespace: "{{ request.object.metadata.name }}"
        data:
          spec:
            hard:
              requests.cpu: "4"
              requests.memory: "8Gi"
              limits.cpu: "8"
              limits.memory: "16Gi"
              pods: "50"
              services: "20"
              persistentvolumeclaims: "10"
---
# Also generate LimitRange
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-limit-range
spec:
  rules:
    - name: generate-limit-range
      match:
        any:
          - resources:
              kinds: ["Namespace"]
              selector:
                matchLabels:
                  team: "?*"
      generate:
        synchronize: true
        apiVersion: v1
        kind: LimitRange
        name: default-limits
        namespace: "{{ request.object.metadata.name }}"
        data:
          spec:
            limits:
              - type: Container
                default:
                  cpu: "500m"
                  memory: "512Mi"
                defaultRequest:
                  cpu: "100m"
                  memory: "128Mi"
                max:
                  cpu: "4"
                  memory: "8Gi"
```

## Image Verification with Cosign

Kyverno can verify that container images are signed with Cosign before allowing them to run:

```yaml
# verify-image-signatures.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce
  background: false  # Image verification must happen at admission time
  webhookTimeoutSeconds: 30
  rules:
    - name: check-image-signature
      match:
        any:
          - resources:
              kinds: ["Pod"]
      verifyImages:
        - imageReferences:
            - "registry.yourorg.com/*"
          # Keyless verification using Sigstore transparency log
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/yourorg/*/.github/workflows/*.yaml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
          # Optional: verify image attestations (SBOM, vulnerability scan)
          attestations:
            - type: https://spdx.dev/Document
              conditions:
                - all:
                    - key: "{{ components[].name }}"
                      operator: AnyNotIn
                      value:
                        - "log4j-core"  # Block if this component is present
          mutateDigest: true    # Replace image:tag with image@sha256:digest
          required: true
          verifyDigest: true
```

Sign an image with Cosign in your CI pipeline:

```bash
# In GitHub Actions after docker push:
- name: Sign image with Cosign (keyless)
  run: |
    cosign sign \
      --yes \
      registry.yourorg.com/myapp:${{ github.sha }}
  env:
    COSIGN_EXPERIMENTAL: "1"
```

## Policy Reports

Kyverno generates `PolicyReport` and `ClusterPolicyReport` resources showing the audit results of background scans against existing resources:

```bash
# View cluster-wide policy report
kubectl get clusterpolicyreports

# View namespace policy reports
kubectl get policyreports -A

# Detailed view of failures
kubectl get policyreport -n payments -o jsonpath='{.results[?(@.result=="fail")]}' | \
  jq '{policy: .policy, resource: "\(.resources[0].namespace)/\(.resources[0].name)", message: .message}'
```

Example policy report output:

```json
{
  "policy": "disallow-root-containers",
  "resource": "payments/payment-processor-6d8f9b",
  "message": "Containers must set securityContext.runAsNonRoot=true"
}
```

Expose policy reports in Grafana using the Policy Reporter tool:

```bash
helm install policy-reporter policy-reporter/policy-reporter \
  --namespace policy-reporter \
  --create-namespace \
  --set ui.enabled=true \
  --set kyvernoPlugin.enabled=true \
  --set monitoring.enabled=true
```

## Testing Policies with Kyverno CLI

Before applying policies to the cluster, test them against sample resources:

```bash
# Install kyverno CLI
brew install kyverno
# or
go install github.com/kyverno/kyverno@latest

# Test a policy against a resource
kyverno apply validate-no-root-containers.yaml \
  --resource test-pod.yaml

# Run all policies in a directory against all resources in another directory
kyverno apply ./policies/ --resource ./test-resources/ --output table

# Generate policy tests
kyverno test ./policies/tests/
```

Kyverno test file format:

```yaml
# policies/tests/validate-no-root.yaml
name: disallow-root-containers-test
policies:
  - validate-no-root-containers.yaml
resources:
  - test/pod-pass.yaml
  - test/pod-fail.yaml
results:
  - policy: disallow-root-containers
    rule: check-containers
    resource: pod-pass
    result: pass
  - policy: disallow-root-containers
    rule: check-containers
    resource: pod-fail
    result: fail
```

## Exception Handling

Kyverno PolicyExceptions allow specific resources to bypass policies with documented justification:

```yaml
# policy-exception-monitoring.yaml
apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  name: prometheus-node-exporter-exception
  namespace: monitoring
spec:
  exceptions:
    - policyName: disallow-root-containers
      ruleNames:
        - check-containers
    - policyName: require-resource-limits
      ruleNames:
        - check-limits
  match:
    any:
      - resources:
          kinds: ["DaemonSet"]
          namespaces: ["monitoring"]
          names: ["prometheus-node-exporter"]
  # Exceptions can be time-limited for temporary bypasses
  # podSecurity exceptions for specific controls
```

## Kyverno vs OPA Gatekeeper

| Feature | Kyverno | OPA Gatekeeper |
|---------|---------|----------------|
| **Policy language** | YAML/JMESPath/CEL | Rego (separate language) |
| **Learning curve** | Low (Kubernetes-native) | Medium-High (Rego) |
| **Validation** | Yes | Yes |
| **Mutation** | Yes | Yes (via Mutation policies) |
| **Generation** | Yes (built-in) | No (requires manual work) |
| **Image verification** | Yes (Cosign built-in) | Limited (requires OPA extension) |
| **Policy reports** | Yes (built-in) | Via separate tooling |
| **Policy testing** | Yes (kyverno test CLI) | Yes (opa test) |
| **External data** | Via context variables | Via OPA external data |
| **Performance** | Good | Good |
| **Community** | Active, CNCF incubating | Mature, CNCF graduated |
| **Policy library** | kyverno.io/policies | github.com/open-policy-agent/gatekeeper-library |

**Choose Kyverno** when your team works primarily in Kubernetes YAML, you need generation rules, or you want built-in Cosign image verification.

**Choose OPA Gatekeeper** when you need complex policy logic that benefits from Rego's expressiveness, when you already use OPA elsewhere (application authorization), or when you need very fine-grained policy modularization.

## Migrating to Enforce Mode Safely

Start all policies in `Audit` mode, monitor policy reports for 1-2 weeks, resolve violations, then switch to `Enforce`:

```bash
# Switch a single policy from Audit to Enforce
kubectl patch clusterpolicy disallow-root-containers \
  --type=merge \
  -p '{"spec":{"validationFailureAction":"Enforce"}}'

# Check admission webhook timeout — increase if policies are slow
kubectl get validatingwebhookconfiguration kyverno-resource-validating-webhook-cfg \
  -o jsonpath='{.webhooks[0].timeoutSeconds}'
```

Monitor Kyverno's admission controller latency:

```promql
# P99 admission webhook latency
histogram_quantile(0.99,
  rate(kyverno_admission_review_duration_seconds_bucket[5m])
)

# Policy violation rate (Audit mode)
sum by (policy_name, rule_name) (
  rate(kyverno_policy_results_total{rule_result="fail"}[5m])
)
```

Kyverno's YAML-native approach makes it accessible to the entire platform engineering team, not just the subset comfortable with Rego. The combination of validation for blocking bad configurations, mutation for enforcing defaults, and generation for bootstrapping namespace resources covers the vast majority of policy needs in a production Kubernetes platform.
