---
title: "Kyverno Policy Engine: Kubernetes-Native Policy Management at Enterprise Scale"
date: 2027-08-25T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kyverno", "Policy", "Security"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Kyverno policy engine for Kubernetes covering ClusterPolicy vs Policy resources, validation/mutation/generation rules, image verification with Cosign, policy exceptions, policy reports, and CI/CD integration with kyverno-cli."
more_link: "yes"
url: "/kyverno-policy-engine-kubernetes-guide/"
---

Kyverno brings Kubernetes-native policy management to cluster governance — no Rego, no separate policy language, just YAML that mirrors the Kubernetes resource model teams already know. At enterprise scale, Kyverno's validation webhooks enforce security standards, mutation rules inject mandatory sidecars and labels, generation rules automate resource provisioning, and image verification with Cosign closes supply chain gaps that purely runtime controls cannot address.

<!--more-->

## Kyverno Architecture and Installation

### Architecture Overview

Kyverno operates as three distinct controllers:

- **Admission Controller**: Validates and mutates resources via webhooks before they persist
- **Background Controller**: Applies policies to existing resources and generates new ones
- **Reports Controller**: Aggregates policy results into `PolicyReport` objects

```bash
# Install Kyverno via Helm
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=2 \
  --set reportsController.replicas=2 \
  --set admissionController.resources.requests.cpu=100m \
  --set admissionController.resources.requests.memory=256Mi \
  --set admissionController.resources.limits.cpu=1000m \
  --set admissionController.resources.limits.memory=1Gi

# Verify installation
kubectl get pods -n kyverno
kubectl get crd | grep kyverno
```

Key CRDs installed:
- `clusterpolicies.kyverno.io`
- `policies.kyverno.io`
- `clusteradmissionreports.kyverno.io`
- `policyreports.wgpolicyk8s.io`
- `policyexceptions.kyverno.io`

### ClusterPolicy vs Policy

| Resource | Scope | Use Case |
|----------|-------|----------|
| `ClusterPolicy` | All namespaces | Security baselines, cluster-wide standards |
| `Policy` | Single namespace | Team-specific rules, namespace overrides |

## Validation Policies

### Requiring Resource Limits

```yaml
# require-resource-limits.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
  annotations:
    policies.kyverno.io/title: Require Resource Limits
    policies.kyverno.io/category: Best Practices
    policies.kyverno.io/severity: medium
    policies.kyverno.io/description: >-
      Resource limits prevent a single container from starving
      other workloads. CPU and memory limits are required on all containers.
spec:
  validationFailureAction: Enforce      # Enforce = block, Audit = log only
  background: true
  rules:
    - name: check-container-resources
      match:
        any:
          - resources:
              kinds: ["Pod"]
      exclude:
        any:
          - resources:
              namespaces:
                - kube-system
                - kyverno
                - monitoring
      validate:
        message: "Resource limits for CPU and memory are required on all containers."
        pattern:
          spec:
            containers:
              - name: "*"
                resources:
                  limits:
                    memory: "?*"
                    cpu: "?*"
            initContainers:
              - name: "*"
                resources:
                  limits:
                    memory: "?*"
                    cpu: "?*"
```

### Disallow Privileged Containers

```yaml
# disallow-privileged.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privileged-containers
  annotations:
    policies.kyverno.io/title: Disallow Privileged Containers
    policies.kyverno.io/severity: high
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-privileged
      match:
        any:
          - resources:
              kinds: ["Pod"]
      exclude:
        any:
          - resources:
              namespaces: ["kube-system"]
          - subjects:
              - kind: ServiceAccount
                name: privileged-workload-sa
                namespace: ops-tools
      validate:
        message: "Privileged containers are not allowed."
        deny:
          conditions:
            any:
              - key: "{{ request.object.spec.containers[].securityContext.privileged | contains(@, true) }}"
                operator: Equals
                value: true
              - key: "{{ request.object.spec.initContainers[].securityContext.privileged | contains(@, true) }}"
                operator: Equals
                value: true
```

### CEL-Based Validation (Kyverno v1.11+)

```yaml
# require-labels-cel.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-labels-cel
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: check-required-labels
      match:
        any:
          - resources:
              kinds: ["Deployment", "StatefulSet", "DaemonSet"]
      validate:
        cel:
          expressions:
            - expression: "has(object.metadata.labels) && has(object.metadata.labels['app.kubernetes.io/name'])"
              message: "Label 'app.kubernetes.io/name' is required"
            - expression: "has(object.metadata.labels) && has(object.metadata.labels['app.kubernetes.io/version'])"
              message: "Label 'app.kubernetes.io/version' is required"
            - expression: >-
                has(object.metadata.labels) &&
                has(object.metadata.labels['team']) &&
                object.metadata.labels['team'] in ['platform', 'backend', 'frontend', 'data', 'security']
              message: "Label 'team' must be one of: platform, backend, frontend, data, security"
```

## Mutation Policies

### Injecting Default Labels

```yaml
# add-default-labels.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-labels
spec:
  rules:
    - name: add-managed-by-label
      match:
        any:
          - resources:
              kinds: ["Deployment", "StatefulSet", "DaemonSet"]
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(app.kubernetes.io/managed-by): "helm"   # + prefix = add only if missing
```

### Injecting Security Context

```yaml
# inject-security-context.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: inject-default-security-context
spec:
  rules:
    - name: inject-container-security-context
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
                    securityContext:
                      +(allowPrivilegeEscalation): false
                      +(readOnlyRootFilesystem): true
                      +(runAsNonRoot): true
                      +(seccompProfile):
                        type: RuntimeDefault
```

### Adding Istio Sidecar Injection Annotation

```yaml
# enable-istio-injection.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: enable-istio-injection
spec:
  rules:
    - name: add-istio-annotation
      match:
        any:
          - resources:
              kinds: ["Pod"]
              namespaces: ["production", "staging"]
      exclude:
        any:
          - resources:
              annotations:
                sidecar.istio.io/inject: "false"
      mutate:
        patchStrategicMerge:
          metadata:
            annotations:
              +(sidecar.istio.io/inject): "true"
```

## Generation Policies

Generation rules create new resources when a trigger resource is created:

```yaml
# generate-network-policies.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: generate-default-network-policies
spec:
  rules:
    - name: default-deny-ingress
      match:
        any:
          - resources:
              kinds: ["Namespace"]
              selector:
                matchLabels:
                  network-policy: "managed"
      generate:
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny-ingress
        namespace: "{{ request.object.metadata.name }}"
        synchronize: true    # Kyverno keeps the generated resource in sync
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Ingress

    - name: allow-dns-egress
      match:
        any:
          - resources:
              kinds: ["Namespace"]
              selector:
                matchLabels:
                  network-policy: "managed"
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
                  - protocol: UDP
                    port: 53
                  - protocol: TCP
                    port: 53
```

## Image Verification with Cosign

### Verifying Signed Container Images

```yaml
# verify-image-signatures.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
  annotations:
    policies.kyverno.io/title: Verify Image Signatures
    policies.kyverno.io/severity: critical
spec:
  validationFailureAction: Enforce
  background: false    # Image verification requires admission — not background
  webhookTimeoutSeconds: 30
  rules:
    - name: check-signature
      match:
        any:
          - resources:
              kinds: ["Pod"]
              namespaces: ["production", "staging"]
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - count: 1
              entries:
                - keyless:
                    subject: "https://github.com/example-org/*/.github/workflows/*.yaml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev

    - name: check-internal-signature
      match:
        any:
          - resources:
              kinds: ["Pod"]
      verifyImages:
        - imageReferences:
            - "registry.internal.example.com/*"
          attestors:
            - entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...EXAMPLE-PUBLIC-KEY...
                      -----END PUBLIC KEY-----
          mutateDigest: true       # Replace tag with digest for immutability
          verifyDigest: true
          required: true
```

### Verifying SBOM Attestations

```yaml
# verify-sbom-attestation.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-sbom-attestation
spec:
  validationFailureAction: Enforce
  rules:
    - name: check-sbom
      match:
        any:
          - resources:
              kinds: ["Pod"]
              namespaces: ["production"]
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestations:
            - type: https://spdx.dev/Document
              conditions:
                any:
                  - key: "{{ attestation.statement.predicate.spdxVersion }}"
                    operator: Equals
                    value: "SPDX-2.3"
              attestors:
                - entries:
                    - keyless:
                        subject: "https://github.com/example-org/*"
                        issuer: "https://token.actions.githubusercontent.com"
```

## Policy Exceptions

For legitimate exceptions, `PolicyException` avoids disabling cluster-wide policies:

```yaml
# exception-monitoring-stack.yaml
apiVersion: kyverno.io/v2alpha1
kind: PolicyException
metadata:
  name: monitoring-stack-exception
  namespace: monitoring
spec:
  exceptions:
    - policyName: disallow-privileged-containers
      ruleNames:
        - check-privileged
    - policyName: require-resource-limits
      ruleNames:
        - check-container-resources
  match:
    any:
      - resources:
          kinds: ["Pod"]
          namespaces: ["monitoring"]
          selector:
            matchLabels:
              app.kubernetes.io/name: prometheus-node-exporter
```

Restrict PolicyException creation to cluster admins via RBAC — exceptions should require approval, not be self-service.

## Policy Reports

```bash
# View cluster-wide policy reports
kubectl get clusterpolicyreports

# View namespace-scoped policy reports
kubectl get policyreports -A

# Find failing policies
kubectl get policyreports -A -o json | jq -r \
  '.items[] | select(.summary.fail > 0) | {
    namespace: .metadata.namespace,
    name: .metadata.name,
    fail_count: .summary.fail
  }'

# View detailed results for a specific namespace
kubectl get policyreport -n production -o yaml | \
  jq -r '.results[] | select(.result == "fail") | {
    policy: .policy,
    rule: .rule,
    resource: .resources[0].name,
    message: .message
  }'
```

## CI/CD Integration with kyverno-cli

The kyverno-cli enables policy testing in CI pipelines before deployment:

```bash
# Install kyverno-cli
curl -sLO https://github.com/kyverno/kyverno/releases/download/v1.11.0/kyverno-cli_v1.11.0_linux_x86_64.tar.gz
tar xzf kyverno-cli_v1.11.0_linux_x86_64.tar.gz
mv kyverno /usr/local/bin/

# Validate that Kubernetes manifests pass policies
kyverno apply policies/ --resource manifests/ --detailed-results

# Test with specific policy and resource
kyverno apply require-resource-limits.yaml \
  --resource deployment.yaml \
  --detailed-results
```

### Policy Unit Testing

```yaml
# kyverno-test.yaml
name: Require Resource Limits Tests
policies:
  - require-resource-limits.yaml
resources:
  - test-resources/
results:
  - policy: require-resource-limits
    rule: check-container-resources
    resource: test-deployment-missing-limits
    kind: Deployment
    result: fail

  - policy: require-resource-limits
    rule: check-container-resources
    resource: test-deployment-with-limits
    kind: Deployment
    result: pass

  - policy: require-resource-limits
    rule: check-container-resources
    resource: test-deployment-missing-limits
    namespace: kube-system   # excluded namespace
    kind: Deployment
    result: skip
```

```bash
# Run policy tests
kyverno test policies/tests/kyverno-test.yaml

# Output:
# Passing test cases...  5/5
# Failing test cases...  0/5
```

### GitHub Actions Integration

```yaml
# .github/workflows/kyverno-policy-check.yaml
name: Kyverno Policy Check

on:
  pull_request:
    paths:
      - 'k8s/**'
      - 'helm/**'

jobs:
  policy-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install kyverno-cli
        run: |
          curl -sLO https://github.com/kyverno/kyverno/releases/download/v1.11.0/kyverno-cli_v1.11.0_linux_x86_64.tar.gz
          tar xzf kyverno-cli_v1.11.0_linux_x86_64.tar.gz
          sudo mv kyverno /usr/local/bin/

      - name: Render Helm charts
        run: |
          helm template my-app charts/my-application -f charts/my-application/ci/default-values.yaml \
            > /tmp/rendered-manifests.yaml

      - name: Apply Kyverno policies
        run: |
          kyverno apply policies/ \
            --resource /tmp/rendered-manifests.yaml \
            --detailed-results \
            --policy-report

      - name: Check for violations
        run: |
          if kyverno apply policies/ \
            --resource /tmp/rendered-manifests.yaml 2>&1 | grep -q "FAIL"; then
            echo "Policy violations found! Review the output above."
            exit 1
          fi
```

Kyverno's admission controller, mutation rules, generation policies, and image verification combine to create defense-in-depth across the workload lifecycle. Policy reports provide continuous compliance visibility without blocking operations, while the kyverno-cli shifts policy enforcement left into CI pipelines — catching violations before they reach the cluster rather than blocking deployment at admission time.
