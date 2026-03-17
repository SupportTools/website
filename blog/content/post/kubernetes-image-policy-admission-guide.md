---
title: "Kubernetes Image Policy: Enforcing Registry and Signature Verification"
date: 2027-12-21T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kyverno", "Cosign", "Sigstore", "Supply Chain Security", "OPA", "Notary", "Admission Control"]
categories:
- Kubernetes
- Security
- Supply Chain
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes image policy enforcement covering Kyverno image verification with Cosign, Sigstore TUF, OPA Gatekeeper image constraints, private registry enforcement, Notary v2, and image digest pinning."
more_link: "yes"
url: "/kubernetes-image-policy-admission-guide/"
---

Container image supply chain attacks remain one of the most impactful and underdefended attack surfaces in Kubernetes deployments. Image policy enforcement through admission webhooks catches unsigned images, images from unauthorized registries, and images without pinned digests before they ever run as pods. This guide covers Kyverno-based image verification with Cosign, Sigstore TUF integration, OPA Gatekeeper alternatives, Notary v2, and the operational patterns for managing image policies in multi-team clusters.

<!--more-->

# Kubernetes Image Policy: Enforcing Registry and Signature Verification

## The Supply Chain Attack Surface

The SolarWinds and XZ Utils incidents demonstrated that supply chain compromise can occur at any stage between developer commit and running container. Kubernetes clusters face attacks at four layers:

1. **Registry spoofing**: Pod spec references `docker.io/library/nginx:latest` instead of an internally approved registry
2. **Tag mutation**: A tag like `v1.2.3` is overwritten with a malicious image
3. **Unsigned images**: CI pipeline produces images with no signature; there is no proof of origin
4. **Unverified builds**: Images from third parties without provenance attestations

Image admission policies address all four through:
- Allowlist registries to prevent external or unknown registry pulls
- Require digest pinning to prevent tag mutation
- Require Cosign signatures from specific key holders or keyless OIDC identities
- Require provenance attestations (SLSA) for regulated workloads

## Tool Selection

| Tool | Signature Verification | Attestation | Policy Language | Installation |
|------|----------------------|-------------|-----------------|--------------|
| Kyverno | Cosign, Notary v2 | SLSA, custom | YAML | Helm |
| OPA Gatekeeper | External (via rego) | No native | Rego | Helm |
| Connaisseur | Cosign, Notary v2 | No | YAML | Helm |
| Ratify (ORAS) | Cosign, Notary v2 | SLSA | Rego+YAML | Helm |

For most organizations, Kyverno provides the best balance of expressiveness, operational simplicity, and native Cosign support.

## Kyverno Installation

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm upgrade --install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set admissionController.replicas=3 \
  --set backgroundController.enabled=true \
  --set reportsController.enabled=true \
  --set cleanupController.enabled=true \
  --set config.webhooks[0].namespaceSelector.matchExpressions[0].key=kubernetes.io/metadata.name \
  --set config.webhooks[0].namespaceSelector.matchExpressions[0].operator=NotIn \
  --set "config.webhooks[0].namespaceSelector.matchExpressions[0].values={kube-system,kyverno}" \
  --version 3.2.6 \
  --wait

kubectl get pods -n kyverno
```

## Registry Allowlist Policy

The first policy to deploy: deny any image from a registry not on the approved list.

```yaml
# kyverno-registry-allowlist.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-image-registries
  annotations:
    policies.kyverno.io/title: Restrict Image Registries
    policies.kyverno.io/category: Supply Chain Security
    policies.kyverno.io/severity: high
    policies.kyverno.io/description: |
      All container images must be sourced from approved internal registries
      or explicitly approved public mirrors. Docker Hub, GHCR, and other
      external registries are blocked unless mirrored internally.
spec:
  validationFailureAction: enforce
  background: true
  rules:
    - name: check-image-registry
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces:
                - "!kube-system"
                - "!kyverno"
                - "!cert-manager"
                - "!gpu-operator"
      validate:
        message: |
          Image {{ request.object.spec.containers[*].image }} is from a non-approved registry.
          Approved registries: registry.internal.example.com, gcr.io/distroless
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: NotIn
                    value:
                      - "registry.internal.example.com/*"
                      - "gcr.io/distroless/*"
                      - "registry.k8s.io/*"
                      - "quay.io/kyverno/*"
                      - "public.ecr.aws/eks-distro/*"
          - list: "request.object.spec.initContainers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: NotIn
                    value:
                      - "registry.internal.example.com/*"
                      - "gcr.io/distroless/*"
                      - "registry.k8s.io/*"
          - list: "request.object.spec.ephemeralContainers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: NotIn
                    value:
                      - "registry.internal.example.com/*"
                      - "gcr.io/distroless/*"
```

## Digest Pinning Policy

Tags are mutable. A digest (`sha256:abc...`) is immutable. Enforce digest references in production:

```yaml
# kyverno-require-digest.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-image-digest
  annotations:
    policies.kyverno.io/title: Require Image Digest
    policies.kyverno.io/category: Supply Chain Security
    policies.kyverno.io/description: |
      Production namespaces must reference images by digest to prevent
      tag mutation attacks. Tags alone are not sufficient.
spec:
  validationFailureAction: enforce
  background: true
  rules:
    - name: check-digest
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces:
                - payments
                - identity
                - api-gateway
                - data-pipeline
      validate:
        message: |
          Image {{ element.image }} must include a digest (sha256:...).
          Use: registry.internal.example.com/app:v1.2.3@sha256:abc...
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ element.image }}"
                    operator: NotMatch
                    value: ".*@sha256:[0-9a-f]{64}"
```

Mutation policy to auto-resolve tags to digests at admission time:

```yaml
# kyverno-mutate-to-digest.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: mutate-image-to-digest
  annotations:
    policies.kyverno.io/title: Mutate Image to Digest
spec:
  rules:
    - name: resolve-image-digest
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces:
                - payments
                - identity
      mutate:
        foreach:
          - list: "request.object.spec.containers"
            patchStrategicMerge:
              spec:
                containers:
                  - name: "{{ element.name }}"
                    image: "{{ element.image }}"
        imageResolve:
          enabled: true
          secrets:
            - name: registry-pull-secret
              namespace: payments
```

## Cosign Signature Verification

### Generating a Signing Key Pair

```bash
# Generate key pair stored in Kubernetes secret
cosign generate-key-pair k8s://kyverno/cosign-platform-key

# Verify the secret was created
kubectl get secret cosign-platform-key -n kyverno

# Export public key for use in policies
kubectl get secret cosign-platform-key -n kyverno \
  -o jsonpath='{.data.cosign\.pub}' | base64 -d > cosign.pub
cat cosign.pub
```

### Signing Images in CI

```bash
# In GitHub Actions or Tekton (after build and push):
IMAGE_REF="registry.internal.example.com/payments/payment-service:v1.5.2@sha256:abc123..."

cosign sign \
  --key k8s://kyverno/cosign-platform-key \
  --annotations "git-commit=${GITHUB_SHA}" \
  --annotations "build-date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --annotations "ci-pipeline=github-actions" \
  "${IMAGE_REF}"
```

### Kyverno Image Verification Policy

```yaml
# kyverno-verify-signature.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signature
  annotations:
    policies.kyverno.io/title: Verify Cosign Image Signature
    policies.kyverno.io/category: Supply Chain Security
    policies.kyverno.io/severity: critical
    policies.kyverno.io/description: |
      All images in production namespaces must be signed by the platform
      CI pipeline using the Cosign platform signing key.
spec:
  validationFailureAction: enforce
  background: false
  webhookTimeoutSeconds: 30
  rules:
    - name: verify-platform-signature
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces:
                - payments
                - identity
                - api-gateway
      verifyImages:
        - imageReferences:
            - "registry.internal.example.com/*"
          skipImageReferences:
            - "registry.internal.example.com/platform/debug-tools:*"
          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEexample_platform_public_key
                      AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
                      -----END PUBLIC KEY-----
                    signatureAlgorithm: sha256
                    rekor:
                      url: https://rekor.sigstore.dev
          mutateDigest: true
          verifyDigest: true
          required: true
```

## Keyless Signing with Sigstore/OIDC

Keyless signing ties the image signature to the CI pipeline's OIDC identity, eliminating long-lived signing keys:

```bash
# In GitHub Actions with OIDC token injection:
cosign sign \
  --oidc-issuer https://token.actions.githubusercontent.com \
  --oidc-provider github-actions \
  registry.internal.example.com/payments/payment-service:latest
```

Kyverno policy for keyless verification:

```yaml
# kyverno-keyless-verification.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-keyless-signature
spec:
  validationFailureAction: enforce
  background: false
  rules:
    - name: verify-github-actions-identity
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces:
                - payments
      verifyImages:
        - imageReferences:
            - "registry.internal.example.com/*"
          attestors:
            - entries:
                - keyless:
                    subject: "https://github.com/example-org/payment-service/.github/workflows/build.yaml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
                    ctlog:
                      url: https://ctfe.sigstore.dev/test
          mutateDigest: true
          required: true
```

## SLSA Provenance Attestation Verification

Beyond signatures, SLSA provenance attestations prove the image was built from a specific source commit in a trusted pipeline:

```bash
# Generate provenance attestation after build
cosign attest \
  --predicate ./slsa-provenance.json \
  --type slsaprovenance \
  --key k8s://kyverno/cosign-platform-key \
  registry.internal.example.com/payments/payment-service@sha256:abc123...
```

```yaml
# SLSA provenance JSON (generated by pipeline)
# slsa-provenance.json
{
  "buildType": "https://github.com/Attestations/GitHubActionsWorkflow@v1",
  "builder": {
    "id": "https://github.com/example-org/payment-service/.github/workflows/build.yaml"
  },
  "invocation": {
    "configSource": {
      "uri": "git+https://github.com/example-org/payment-service@refs/heads/main",
      "digest": {
        "sha1": "abc123def456"
      },
      "entryPoint": ".github/workflows/build.yaml"
    }
  },
  "metadata": {
    "buildStartedOn": "2027-12-16T10:00:00Z",
    "buildFinishedOn": "2027-12-16T10:15:00Z",
    "completeness": {
      "arguments": true,
      "environment": false,
      "materials": true
    }
  }
}
```

Kyverno policy to verify SLSA provenance:

```yaml
# kyverno-slsa-attestation.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-slsa-provenance
spec:
  validationFailureAction: enforce
  background: false
  rules:
    - name: check-slsa-provenance
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces:
                - payments
      verifyImages:
        - imageReferences:
            - "registry.internal.example.com/*"
          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys:
                        publicKeys: |-
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEexample_platform_public_key==
                          -----END PUBLIC KEY-----
              conditions:
                - all:
                    - key: "{{ attestation.predicate.buildType }}"
                      operator: Equals
                      value: "https://github.com/Attestations/GitHubActionsWorkflow@v1"
                    - key: "{{ attestation.predicate.builder.id }}"
                      operator: In
                      value:
                        - "https://github.com/example-org/payment-service/.github/workflows/build.yaml"
                        - "https://github.com/example-org/payment-service/.github/workflows/release.yaml"
```

## OPA Gatekeeper Alternative

For organizations already running Gatekeeper, image policy is expressed as ConstraintTemplates:

```yaml
# gatekeeper-image-allowlist-template.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sallowedregistries
spec:
  crd:
    spec:
      names:
        kind: K8sAllowedRegistries
      validation:
        openAPIV3Schema:
          type: object
          properties:
            registries:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8sallowedregistries

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not allowed_registry(container.image)
          msg := sprintf(
            "Container %v uses image from non-allowed registry: %v",
            [container.name, container.image]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.initContainers[_]
          not allowed_registry(container.image)
          msg := sprintf(
            "InitContainer %v uses image from non-allowed registry: %v",
            [container.name, container.image]
          )
        }

        allowed_registry(image) {
          registry := input.parameters.registries[_]
          startswith(image, registry)
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRegistries
metadata:
  name: allowed-registries
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  parameters:
    registries:
      - "registry.internal.example.com/"
      - "gcr.io/distroless/"
      - "registry.k8s.io/"
```

## Notary v2 Integration

For organizations using Harbor as their registry, Notary v2 signatures are enforced at the registry level and validated by Ratify:

```yaml
# ratify-verifier-notaryv2.yaml
apiVersion: config.ratify.deislabs.io/v1beta1
kind: Verifier
metadata:
  name: notaryv2
spec:
  name: notaryv2
  artifactTypes: application/vnd.cncf.notary.signature
  parameters:
    verificationCertStores:
      certs:
        - certStore: platform-notary-certs
    trustPolicyDoc:
      version: "1.0"
      trustPolicies:
        - name: platform-policy
          registryScopes:
            - "registry.internal.example.com/*"
          signatureVerification:
            level: strict
          trustStores:
            - "ca:platform-notary-certs"
          trustedIdentities:
            - "x509.subject: CN=example-org Platform CA"
```

## Operational Runbook

### Onboarding a New Service

```bash
# 1. Generate and push signed image from CI pipeline
docker build -t registry.internal.example.com/payments/new-service:v1.0.0 .
docker push registry.internal.example.com/payments/new-service:v1.0.0

# Get the digest
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' \
  registry.internal.example.com/payments/new-service:v1.0.0)

# 2. Sign the image
cosign sign \
  --key k8s://kyverno/cosign-platform-key \
  "${DIGEST}"

# 3. Verify the signature before deployment
cosign verify \
  --key k8s://kyverno/cosign-platform-key \
  "${DIGEST}" | jq .

# 4. Update Deployment to use digest
kubectl set image deployment/new-service \
  new-service="${DIGEST}" \
  -n payments

# 5. Confirm policy evaluation
kubectl get polr -n payments -o wide | grep new-service
```

### Emergency Break-Glass

When an urgent unverified image must be deployed (e.g., incident response tooling):

```yaml
# Emergency bypass annotation (requires Kyverno policy to allow this)
# This approach requires explicit opt-in in the ClusterPolicy
apiVersion: v1
kind: Pod
metadata:
  name: emergency-debug
  namespace: incident-response
  labels:
    breakglass: "true"
  annotations:
    kyverno.io/verify-images: "false"
    # Audit trail: requires approval from two platform engineers
    breakglass-approved-by: "eng1@example.com,eng2@example.com"
    breakglass-ticket: "INC-12345"
    breakglass-expires: "2027-12-16T20:00:00Z"
spec:
  containers:
    - name: debug
      image: registry.internal.example.com/platform/debug-tools:latest
```

```yaml
# Kyverno exception for emergency access
apiVersion: kyverno.io/v2alpha1
kind: PolicyException
metadata:
  name: emergency-breakglass
  namespace: incident-response
spec:
  exceptions:
    - policyName: verify-image-signature
      ruleNames:
        - verify-platform-signature
  match:
    any:
      - resources:
          kinds: [Pod]
          namespaces: [incident-response]
          selector:
            matchLabels:
              breakglass: "true"
```

## Policy Testing

Test policies without enforcement using dry-run:

```bash
# Test a pod manifest against active policies
kubectl apply --dry-run=server -f test-pod.yaml

# Kyverno CLI for offline policy testing
kyverno apply ./policies/ --resource ./test-pod.yaml

# Test multiple resources
kyverno test ./kyverno-tests/
```

```yaml
# kyverno-tests/verify-signature-test.yaml
apiVersion: cli.kyverno.io/v1alpha1
kind: Test
metadata:
  name: verify-signature-tests
policies:
  - ../kyverno-verify-signature.yaml
resources:
  - resources/pod-signed.yaml
  - resources/pod-unsigned.yaml
results:
  - policy: verify-image-signature
    rule: verify-platform-signature
    resource: pod-signed
    result: pass
  - policy: verify-image-signature
    rule: verify-platform-signature
    resource: pod-unsigned
    result: fail
```

## Monitoring and Reporting

Track policy violations with Prometheus:

```yaml
# kyverno-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kyverno-supply-chain-alerts
  namespace: kyverno
spec:
  groups:
    - name: kyverno.supply-chain
      rules:
        - alert: UnauthorizedRegistryAttempt
          expr: |
            increase(kyverno_policy_results_total{
              policy_name="restrict-image-registries",
              result="fail"
            }[5m]) > 0
          labels:
            severity: high
            team: security
          annotations:
            summary: "Attempt to use unauthorized image registry blocked"

        - alert: SignatureVerificationFailure
          expr: |
            increase(kyverno_policy_results_total{
              policy_name="verify-image-signature",
              result="fail"
            }[5m]) > 0
          labels:
            severity: critical
            team: security
          annotations:
            summary: "Image signature verification failure - possible supply chain attack"
```

## Summary

Image policy enforcement is a defense-in-depth layer that catches supply chain threats at admission time before any malicious code executes. The recommended deployment sequence:

1. Start in audit mode (`validationFailureAction: audit`) to baseline violations without breaking deployments
2. Deploy registry allowlist policy first - the highest-impact, lowest-disruption control
3. Add digest pinning requirement for production namespaces
4. Implement Cosign signature verification after establishing a CI signing pipeline
5. Graduate to keyless OIDC signing to eliminate long-lived signing keys
6. Add SLSA provenance attestation requirements for regulated workloads
7. Monitor policy violation metrics and alert on any bypass attempts
