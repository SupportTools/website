---
title: "Kubernetes GitOps Security: Signed Commits, Policy as Code, and Supply Chain Attestation"
date: 2030-04-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "GitOps", "Security", "Sigstore", "Cosign", "SLSA", "Supply Chain", "ArgoCD", "Flux", "OPA Gatekeeper"]
categories: ["Kubernetes", "Security", "GitOps"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to securing Kubernetes GitOps pipelines with Sigstore image signing, Cosign attestations, SLSA provenance, OPA Gatekeeper policies for signature validation, and security hardening for Flux and ArgoCD deployments."
more_link: "yes"
url: "/kubernetes-gitops-security-signed-commits-policy-supply-chain-attestation/"
---

Software supply chain attacks have become one of the defining security threats of the 2020s. The SolarWinds, Log4Shell, and XZ Utils incidents demonstrated that attackers can compromise software at the build and distribution phases — before code ever reaches a production Kubernetes cluster. GitOps pipelines, where infrastructure state is driven by a Git repository, are both a powerful defense mechanism and a potential attack surface.

This guide builds a comprehensive supply chain security posture for Kubernetes GitOps deployments. Every container image entering the cluster must be signed with Cosign. Every build must produce SLSA provenance attestations. OPA Gatekeeper policies enforce signature verification at admission time. ArgoCD and Flux are hardened against common attack vectors.

<!--more-->

## The Supply Chain Threat Model

Before implementing controls, understanding what you are defending against prevents over-engineering in some areas while missing critical gaps in others.

```
Developer Workstation    Build Pipeline       Registry         Cluster
┌─────────────────┐    ┌─────────────┐    ┌──────────┐    ┌────────────┐
│ git commit      │    │ CI Build    │    │ Container │    │ Kubernetes │
│ code review     │───►│ Docker build│───►│ Registry  │───►│ Admission  │
│ signed commit   │    │ Tests       │    │ (ECR/GCR/ │    │ Webhook    │
└─────────────────┘    │ SAST/SCA    │    │ Artifactory)    │ (Gatekeeper│
                        │ Sign image  │    └──────────┘    └────────────┘
                        │ Push        │
                        │ attestation │
                        └─────────────┘

Attack surfaces:
① Developer account compromise → inject malicious code
② CI/CD pipeline compromise → inject at build time
③ Base image compromise → use vulnerable/malicious base
④ Registry MitM → replace image after push
⑤ Cluster admission → deploy unsigned/untrusted image
⑥ GitOps repo compromise → change desired state
```

The controls in this guide address:
- ② via SLSA provenance (attestation of build environment)
- ③ via base image signing and verification
- ④ via Cosign signing (signatures are external to the registry)
- ⑤ via Gatekeeper admission policies
- ⑥ via signed Git commits and ArgoCD/Flux security hardening

## Sigstore and Cosign

Sigstore is the public infrastructure for code signing. It provides:
- **Cosign**: Tool for signing container images
- **Fulcio**: Certificate Authority that issues short-lived signing certificates tied to OIDC identities
- **Rekor**: Immutable transparency log that records all signing events
- **Gitsign**: Tool for signing Git commits using Sigstore

### Keyless Signing with Cosign in CI/CD

```bash
# Install cosign
go install github.com/sigstore/cosign/v2/cmd/cosign@latest

# Keyless signing (uses OIDC identity from CI environment)
# This requires OIDC token from GitHub Actions, GitLab, or similar

# In GitHub Actions:
export COSIGN_EXPERIMENTAL=1  # or use --yes flag

# Sign an image using keyless method (no key management required)
cosign sign \
  --yes \
  ghcr.io/yourorg/yourapp:v1.2.3

# Verify keyless signature
cosign verify \
  --certificate-identity-regexp="https://github.com/yourorg/yourapp/.github/workflows/.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/yourorg/yourapp:v1.2.3

# List signatures for an image
cosign tree ghcr.io/yourorg/yourapp:v1.2.3
```

### Key-Based Signing for Private Infrastructure

For environments without OIDC providers, use long-lived key pairs managed in a secrets manager.

```bash
# Generate a signing key pair (store private key in Vault/KMS, never in plaintext)
cosign generate-key-pair

# This creates:
# cosign.key   — private key (encrypt and store securely)
# cosign.pub   — public key (distribute to verifiers)

# Sign using key pair
cosign sign \
  --key cosign.key \
  ghcr.io/yourorg/yourapp:v1.2.3

# Or sign using AWS KMS key
cosign sign \
  --key awskms:///arn:aws:kms:us-east-1:123456789012:key/<key-id> \
  ghcr.io/yourorg/yourapp:v1.2.3

# Sign using HashiCorp Vault transit key
cosign sign \
  --key hashivault://cosign-signing-key \
  ghcr.io/yourorg/yourapp:v1.2.3

# Verify with public key
cosign verify \
  --key cosign.pub \
  ghcr.io/yourorg/yourapp:v1.2.3

# Expected output:
# Verification for ghcr.io/yourorg/yourapp:v1.2.3 --
# The following checks were performed on each of these signatures:
#   - The cosign claims were validated
#   - Existence of the claims in the transparency log was verified
#   - The signatures were verified against the specified public key
```

### Complete CI/CD Signing Pipeline

```yaml
# .github/workflows/build-sign.yaml
name: Build and Sign Container Image
on:
  push:
    tags: ['v*']

permissions:
  contents: read
  packages: write
  id-token: write   # Required for OIDC keyless signing

jobs:
  build-sign-attest:
    runs-on: ubuntu-latest
    outputs:
      image-digest: ${{ steps.push.outputs.digest }}

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # Full history for SLSA provenance

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Install Cosign
        uses: sigstore/cosign-installer@v3
        with:
          cosign-release: 'v2.4.0'

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha

      - name: Build and push image
        id: push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          # Build provenance metadata for SLSA
          provenance: true
          sbom: true

      - name: Sign the image (keyless)
        run: |
          IMAGE="ghcr.io/${{ github.repository }}@${{ steps.push.outputs.digest }}"
          cosign sign --yes "$IMAGE"
          echo "Signed: $IMAGE"

      - name: Attest build provenance (SLSA)
        run: |
          IMAGE="ghcr.io/${{ github.repository }}@${{ steps.push.outputs.digest }}"
          cosign attest \
            --yes \
            --type slsaprovenance \
            --predicate <(echo '{
              "buildType": "https://github.com/actions/runner/attestations/v1",
              "builder": {
                "id": "https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}"
              },
              "invocation": {
                "configSource": {
                  "uri": "https://github.com/${{ github.repository }}",
                  "digest": {"sha1": "${{ github.sha }}"}
                }
              }
            }') \
            "$IMAGE"

      - name: Attest SBOM
        run: |
          IMAGE="ghcr.io/${{ github.repository }}@${{ steps.push.outputs.digest }}"
          # Generate SBOM
          cosign download sbom "$IMAGE" > sbom.json 2>/dev/null || \
            syft scan "$IMAGE" -o cyclonedx-json > sbom.json

          # Attest SBOM
          cosign attest \
            --yes \
            --type cyclonedx \
            --predicate sbom.json \
            "$IMAGE"

      - name: Verify signature before deployment
        run: |
          IMAGE="ghcr.io/${{ github.repository }}@${{ steps.push.outputs.digest }}"
          cosign verify \
            --certificate-identity-regexp="https://github.com/${{ github.repository }}/.github/workflows/.*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            "$IMAGE" | jq '.[0].optional'
```

## SLSA Provenance Attestation

SLSA (Supply-chain Levels for Software Artifacts) defines a framework for measuring the security of software build and distribution processes. Level 3 — the practical target for most organizations — requires:

- Build as code (CI configuration in version control)
- Signed attestations of build provenance
- Hermetic builds (no network access during build)
- Build environment isolation

```yaml
# Generate SLSA provenance using slsa-github-generator
name: SLSA Provenance
on:
  release:
    types: [created]

permissions:
  actions: read
  contents: write
  id-token: write

jobs:
  build:
    outputs:
      digest: ${{ steps.hash.outputs.digest }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build artifacts
        run: make build-release
      - name: Generate hash
        id: hash
        run: |
          sha256sum ./bin/myapp > checksums.txt
          DIGEST=$(cat checksums.txt | base64 -w0)
          echo "digest=$DIGEST" >> "$GITHUB_OUTPUT"

  provenance:
    needs: [build]
    # Use the official SLSA generator action
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.0.0
    with:
      base64-subjects: "${{ needs.build.outputs.digest }}"
      upload-assets: true
```

### Verifying SLSA Provenance

```bash
# Verify SLSA provenance attestation
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp="https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@refs/tags/v.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/yourorg/yourapp:v1.2.3 | jq '.[0].payload | @base64d | fromjson'

# Verify SBOM attestation
cosign verify-attestation \
  --type cyclonedx \
  --certificate-identity-regexp="https://github.com/yourorg/yourapp/.github/workflows/.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/yourorg/yourapp:v1.2.3 | jq '.[0].payload | @base64d | fromjson | .components | length'
```

## OPA Gatekeeper: Policy Enforcement at Admission

Gatekeeper enforces policies at Kubernetes admission time. Every resource submitted to the cluster must satisfy all active constraints before being accepted.

### Installing Gatekeeper

```bash
# Install Gatekeeper via Helm
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update

helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --set replicas=3 \
  --set auditInterval=60 \
  --set constraintViolationsLimit=20 \
  --set logLevel=INFO \
  --version 3.17.0
```

### Image Signature Verification Policy

```yaml
# constrainttemplate-image-signature.yaml
# This ConstraintTemplate uses the Ratify external data provider
# for signature verification (alternative to inline OPA)
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredsignedimage
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredSignedImage
      validation:
        openAPIV3Schema:
          type: object
          properties:
            allowedRegistries:
              type: array
              items:
                type: string
              description: "Registries that require signature verification"
            exemptNamespaces:
              type: array
              items:
                type: string
              description: "Namespaces exempt from signature requirements"
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredsignedimage

        import data.lib.helpers

        # Deny if image is not from an allowed registry
        violation[{"msg": msg}] {
          input.review.operation != "DELETE"
          container := input_containers[_]
          image := container.image
          not exempt_namespace
          not allowed_registry(image)
          msg := sprintf(
            "Image '%v' is not from an allowed registry. Allowed: %v",
            [image, input.parameters.allowedRegistries]
          )
        }

        # Main signature check using external data (Ratify)
        violation[{"msg": msg}] {
          input.review.operation != "DELETE"
          container := input_containers[_]
          image := container.image
          not exempt_namespace
          allowed_registry(image)

          # Query Ratify for verification result
          response := external_data({"provider": "ratify-provider", "keys": [image]})
          result := response.responses[image]
          result.isSuccess == false
          msg := sprintf(
            "Image '%v' failed signature verification: %v",
            [image, result.err]
          )
        }

        exempt_namespace {
          ns := input.review.object.metadata.namespace
          exempt := input.parameters.exemptNamespaces
          ns == exempt[_]
        }

        allowed_registry(image) {
          registry := input.parameters.allowedRegistries[_]
          startswith(image, registry)
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
# constraint-require-signed-images.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredSignedImage
metadata:
  name: require-signed-images
spec:
  enforcementAction: deny   # or "warn" for gradual rollout
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
      - apiGroups: ["batch"]
        kinds: ["Job", "CronJob"]
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
  parameters:
    allowedRegistries:
      - "ghcr.io/yourorg/"
      - "your-ecr-account.dkr.ecr.us-east-1.amazonaws.com/"
    exemptNamespaces:
      - kube-system
      - gatekeeper-system
      - monitoring
```

### Ratify: External Verification Provider

Ratify is a project that integrates with Gatekeeper to perform artifact verification (signature checking, SBOM attestation, SLSA level verification) as an external data provider.

```yaml
# ratify-config.yaml
apiVersion: config.ratify.deislabs.io/v1beta1
kind: Store
metadata:
  name: oras-store
spec:
  name: oras
  parameters:
    cacheEnabled: true
    ttl: 10
---
apiVersion: config.ratify.deislabs.io/v1beta1
kind: Verifier
metadata:
  name: verifier-cosign
spec:
  name: cosign
  artifactTypes: application/vnd.dev.cosign.artifact.sig.v1+json
  parameters:
    # Public key for verification (base64-encoded PEM)
    key: |
      <your-cosign-public-key-pem>
    # Or keyless configuration
    rekorURL: "https://rekor.sigstore.dev"
    certificateIdentity: "https://github.com/yourorg/yourapp/.github/workflows/build-sign.yaml@refs/heads/main"
    certificateOIDCIssuer: "https://token.actions.githubusercontent.com"
---
apiVersion: config.ratify.deislabs.io/v1beta1
kind: Verifier
metadata:
  name: verifier-sbom
spec:
  name: sbom
  artifactTypes: application/vnd.cyclonedx+json
  parameters:
    maximumAge: "24h"
---
apiVersion: config.ratify.deislabs.io/v1beta1
kind: Policy
metadata:
  name: ratify-policy
spec:
  type: config-policy
  parameters:
    artifactVerificationPolicies:
      application/vnd.dev.cosign.artifact.sig.v1+json: "any"
      application/vnd.cyclonedx+json: "any"
```

### Additional Gatekeeper Policies for Supply Chain Security

```yaml
# Require image digest instead of mutable tags
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredimagedigest
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredImageDigest
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredimagedigest

        violation[{"msg": msg}] {
          input.review.operation != "DELETE"
          container := input.review.object.spec.containers[_]
          not contains(container.image, "@sha256:")
          msg := sprintf(
            "Container '%v' uses mutable tag instead of digest: '%v'. Use image@sha256:<digest> format.",
            [container.name, container.image]
          )
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredImageDigest
metadata:
  name: require-image-digest
spec:
  enforcementAction: warn   # start with warn, switch to deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
      - production
```

```yaml
# Block images from untrusted registries
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
          container := input_containers[_]
          image := container.image
          not any_prefix_matches(image, input.parameters.registries)
          msg := sprintf(
            "Image '%v' is from an untrusted registry. Allowed registries: %v",
            [image, input.parameters.registries]
          )
        }

        any_prefix_matches(image, registries) {
          registry := registries[_]
          startswith(image, registry)
        }

        input_containers[c] {
          c := input.review.object.spec.containers[_]
        }
        input_containers[c] {
          c := input.review.object.spec.initContainers[_]
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sAllowedRegistries
metadata:
  name: allowed-registries-production
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - production
      - staging
  parameters:
    registries:
      - "ghcr.io/yourorg/"
      - "123456789012.dkr.ecr.us-east-1.amazonaws.com/"
      - "registry.k8s.io/"
      - "gcr.io/distroless/"
```

## Securing Git Commits with Gitsign

Gitsign integrates with Sigstore to sign Git commits using your OIDC identity rather than a GPG key.

```bash
# Install Gitsign
go install github.com/sigstore/gitsign@latest

# Configure Git to use Gitsign
git config --global gpg.x509.program gitsign
git config --global gpg.format x509
git config --global commit.gpgsign true

# Sign a commit (opens browser for OIDC authentication first time)
git commit -m "feat: add signed image validation"

# Verify a commit signature
git log --show-signature

# Verify a specific commit
gitsign verify \
  --certificate-identity="user@company.com" \
  --certificate-oidc-issuer="https://accounts.google.com" \
  HEAD

# Check all commits in a PR for signatures
git log origin/main..HEAD --show-signature | grep -E "(Good|BAD|No public)"
```

### Enforcing Signed Commits in GitHub

```yaml
# .github/workflows/verify-commits.yaml
name: Verify Commit Signatures
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  verify-commits:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Gitsign
        run: go install github.com/sigstore/gitsign@latest

      - name: Verify commit signatures
        run: |
          BASE_SHA="${{ github.event.pull_request.base.sha }}"
          HEAD_SHA="${{ github.event.pull_request.head.sha }}"

          echo "Verifying commits from $BASE_SHA to $HEAD_SHA..."

          FAILED=0
          for COMMIT in $(git log --format="%H" "${BASE_SHA}..${HEAD_SHA}"); do
            echo -n "Commit $COMMIT: "
            if gitsign verify \
              --certificate-oidc-issuer="https://accounts.google.com" \
              "$COMMIT" 2>/dev/null; then
              echo "OK"
            else
              echo "UNSIGNED or INVALID"
              FAILED=1
            fi
          done

          if [ "$FAILED" -eq 1 ]; then
            echo "ERROR: Some commits are not signed or have invalid signatures"
            exit 1
          fi
```

## ArgoCD Security Hardening

```yaml
# argocd-security-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # Only allow repositories explicitly configured
  repositories: |
    - url: https://github.com/yourorg/gitops-configs
      # Verify the repository content via SHA pinning
  repository.credentials: |
    - url: https://github.com/yourorg
      sshPrivateKeySecret:
        name: github-ssh-key
        key: sshPrivateKey

  # Restrict which namespaces ArgoCD can deploy to
  application.namespaces: "production,staging,development"

  # Disable anonymous access
  users.anonymous.enabled: "false"

  # OIDC SSO configuration
  oidc.config: |
    name: Okta
    issuer: https://yourorg.okta.com/oauth2/default
    clientID: <client-id>
    clientSecret: $oidc.okta.clientSecret
    requestedScopes: ["openid", "profile", "email", "groups"]
    requestedIDTokenClaims:
      groups:
        essential: true
```

```yaml
# argocd-rbac-cm.yaml — restrict who can deploy to production
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    # Admins can do everything
    p, role:admin, applications, *, */*, allow
    p, role:admin, clusters, *, *, allow
    p, role:admin, repositories, *, *, allow

    # Developers can sync to non-production
    p, role:developer, applications, get, */*, allow
    p, role:developer, applications, sync, staging/*, allow
    p, role:developer, applications, sync, development/*, allow

    # Production requires senior role
    p, role:senior, applications, *, production/*, allow

    # Group mappings (from OIDC groups)
    g, yourorg:platform-admins, role:admin
    g, yourorg:developers, role:developer
    g, yourorg:senior-engineers, role:senior
```

```yaml
# ArgoCD Application with sync policy requiring signature verification
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: production-app
  namespace: argocd
  annotations:
    # Notify on sync failure
    notifications.argoproj.io/subscribe.on-sync-failed.slack: production-alerts
spec:
  project: production
  source:
    repoURL: https://github.com/yourorg/gitops-configs
    targetRevision: HEAD
    path: apps/production
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=false
      - PrunePropagationPolicy=foreground
      - RespectIgnoreDifferences=true
    retry:
      limit: 3
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

## Flux Security Hardening

```yaml
# flux-system/gotk-sync.yaml — secure Flux source configuration
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 5m
  url: https://github.com/yourorg/fleet-infra
  ref:
    branch: main
  # Verify commit signatures from authorized Git identities
  verify:
    mode: head   # or "tag" for tag-based deployments
    secretRef:
      name: git-verification-key
  secretRef:
    name: flux-system    # SSH or HTTPS credentials
---
# Secret containing authorized public keys for commit verification
apiVersion: v1
kind: Secret
metadata:
  name: git-verification-key
  namespace: flux-system
type: Opaque
stringData:
  # Public key(s) authorized to sign deployable commits
  # These are OpenPGP/PGP public keys of authorized committers
  # (or Gitsign keyring configuration for Sigstore-based verification)
  author.pub: |
    <gpg-public-key-for-authorized-committer>
```

```yaml
# Flux ImagePolicy with Cosign signature verification
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImageRepository
metadata:
  name: yourapp
  namespace: flux-system
spec:
  image: ghcr.io/yourorg/yourapp
  interval: 5m
  # Policy for selecting which images are eligible for update
  exclusionList:
    - "^.*\\.sig$"     # Exclude cosign signature tags
    - "^.*\\.sbom$"    # Exclude SBOM tags
---
apiVersion: image.toolkit.fluxcd.io/v1beta2
kind: ImagePolicy
metadata:
  name: yourapp
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: yourapp
  policy:
    semver:
      range: ">=1.0.0"
  # Require that selected image has a valid Cosign signature
  # (handled by Gatekeeper admission policy — Flux selects, Gatekeeper verifies)
```

## Auditing and Compliance

```bash
# List all images in cluster and check their signature status
kubectl get pods -A -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' | \
  sort -u | while read image; do
    echo -n "Checking: $image ... "
    if cosign verify \
      --certificate-identity-regexp="https://github.com/yourorg/.*" \
      --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
      "$image" &>/dev/null; then
      echo "SIGNED"
    else
      echo "UNSIGNED or UNVERIFIABLE"
    fi
  done

# Check Gatekeeper constraint violations
kubectl get constraints -A
kubectl describe k8srequiredsignedimage require-signed-images | grep -A20 'Violations:'

# Audit Gatekeeper audit results
kubectl get k8srequiredsignedimage require-signed-images -o json | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
violations = data.get('status', {}).get('violations', [])
print(f'Total violations: {len(violations)}')
for v in violations[:10]:
    print(f'  {v[\"namespace\"]}/{v[\"name\"]}: {v[\"message\"][:80]}')
"
```

### Policy Compliance Dashboard

```yaml
# Prometheus alerting rule for supply chain policy violations
groups:
  - name: supply-chain-security
    rules:
      - alert: UnsignedImageDeployment
        expr: |
          gatekeeper_violations{constraint_kind="K8sRequiredSignedImage"} > 0
        for: 1m
        labels:
          severity: critical
          security: supply-chain
        annotations:
          summary: "Unsigned container images detected in cluster"
          description: "{{ $value }} pods are running unsigned images"

      - alert: GatekeeperAuditFailure
        expr: |
          gatekeeper_audit_last_run_time{} > 300
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Gatekeeper audit has not run in 5 minutes"

      - alert: RegistryPolicyViolation
        expr: |
          gatekeeper_violations{constraint_kind="K8sAllowedRegistries"} > 0
        for: 0m
        labels:
          severity: high
        annotations:
          summary: "Images from untrusted registries detected"
```

## Key Takeaways

Kubernetes GitOps security is a defense-in-depth problem. No single control is sufficient — the combination of signed images, provenance attestations, admission policies, and hardened GitOps controllers creates multiple independent barriers that an attacker must overcome.

Cosign keyless signing with Sigstore is the right default for most organizations in 2030. It eliminates private key management complexity while providing cryptographically verifiable proof that an image was built by a specific CI/CD pipeline. The Fulcio certificate ties the signature to a workflow identity, making it auditable and attributable.

OPA Gatekeeper with Ratify provides the enforcement layer. Without admission policies, even comprehensive signing infrastructure can be bypassed by a developer who pushes directly to the registry. Gatekeeper ensures that no unsigned or incorrectly-signed image can run in the cluster, regardless of how it was pushed.

Start enforcement in `warn` mode before switching to `deny`. Use the warning period to identify legitimate images that are not yet signed, fix the build pipelines for those images, and only switch to `deny` enforcement when you have high confidence that the policy will not block valid deployments. An overly aggressive rollout of signature enforcement that blocks a production deployment creates pressure to add broad exemptions that undermine the entire control.

SLSA provenance attestations provide the forensic trail needed to respond to supply chain incidents. When you need to determine whether a specific image was built from tampered source or in a compromised build environment, provenance attestations give you verifiable evidence of exactly what went into each build.
