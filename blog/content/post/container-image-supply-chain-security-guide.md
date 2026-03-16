---
title: "Container Image Supply Chain Security: Sigstore, SLSA, and Admission Enforcement"
date: 2027-06-23T00:00:00-05:00
draft: false
tags: ["Supply Chain Security", "Sigstore", "Cosign", "SLSA", "Kubernetes", "Security"]
categories:
- Security
- Kubernetes
- DevSecOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to container image supply chain security covering the full threat model, Cosign keyless signing, Rekor transparency logs, SLSA provenance levels, Policy Controller and Kyverno admission enforcement, SBOM generation with Syft, and vulnerability scanning with Grype."
more_link: "yes"
url: "/container-image-supply-chain-security-guide/"
---

The SolarWinds attack demonstrated that compromising software build infrastructure is a more efficient attack vector than compromising production systems directly. For containerized workloads, this means the question is not just whether a container runtime is configured securely, but whether the images running in that runtime were built from trusted code using trusted processes. Supply chain security addresses this question with a combination of cryptographic signing, transparency logs, provenance attestation, and admission-time policy enforcement.

<!--more-->

# Container Image Supply Chain Security

## Section 1: The Supply Chain Threat Model

Before implementing controls, understanding what needs to be protected is essential. The container image supply chain has several attack surfaces.

### Attack Vectors

**Source code tampering**: An attacker with write access to a source repository injects malicious code that appears in the next build. Defense: branch protection, signed commits, code review requirements.

**Dependency confusion / typosquatting**: A malicious package with a name similar to (or identical to) an internal package is published to a public registry and pulled into a build. Defense: private package proxies, dependency pinning to hash, dependency scanning.

**Build system compromise**: The CI/CD system itself is compromised, and the attacker modifies the build process to inject malicious code into artifacts that would otherwise pass source code review. Defense: ephemeral build environments, hermetic builds, SLSA provenance generation with attestation.

**Registry tampering**: An attacker with write access to the image registry replaces a legitimate image with a malicious one while preserving the tag. Defense: image signing with digest verification, immutable tags (SHA-pinned references).

**Admission-time policy bypass**: A developer manually deploys an unsigned or unverified image to bypass the CI pipeline entirely. Defense: admission webhook enforcement requiring valid signatures.

**Runtime compromise via known vulnerabilities**: A container running an image with known CVEs is exploited after deployment. Defense: continuous vulnerability scanning, freshness policies, automated patching workflows.

### The SLSA Framework

Supply-chain Levels for Software Artifacts (SLSA, pronounced "salsa") defines four progressive levels of supply chain security guarantees:

**SLSA Level 1**: Provenance exists and describes how the artifact was built. Not tamper-resistant.

**SLSA Level 2**: Provenance is signed by the build system. The build system is a hosted service (not developer workstations).

**SLSA Level 3**: The build system itself is hardened. Source and build instructions are reviewed. The build is isolated from other builds.

**SLSA Level 4** (highest): Two-party review for all changes. Hermetic builds (no network access during build). Strong provenance controls throughout.

Most organizations should target SLSA Level 3 for production images. Level 4 is appropriate for critical infrastructure components (base images, core platform services).

## Section 2: Sigstore — The Signing Infrastructure

Sigstore is a collection of open-source tools and a public-good infrastructure service for signing and verifying software artifacts. Its key insight is that short-lived, certificate-backed signatures tied to an OIDC identity eliminate the need to manage long-lived signing keys.

### Sigstore Components

**Cosign**: The CLI and Go library for signing and verifying container images, files, and attestations.

**Fulcio**: A certificate authority that issues short-lived code signing certificates backed by OIDC tokens. When cosign requests a certificate, Fulcio verifies the OIDC token from GitHub Actions (or another provider) and issues a certificate binding the signing key to the identity in the token.

**Rekor**: An append-only transparency log (similar to Certificate Transparency for TLS) that records all signed artifacts. Every signature is recorded as an immutable entry; verification requires checking that the signature's entry exists in Rekor.

### Installing Cosign

```bash
# Install cosign CLI
COSIGN_VERSION=v2.4.0
curl -sLO "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"
curl -sLO "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64.sig"

# Verify the cosign binary with the previous version (bootstrap trust)
cosign verify-blob \
  --certificate-identity "https://github.com/sigstore/cosign/.github/workflows/release.yml@refs/tags/${COSIGN_VERSION}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --bundle cosign-linux-amd64.sig \
  cosign-linux-amd64

chmod +x cosign-linux-amd64
sudo mv cosign-linux-amd64 /usr/local/bin/cosign
```

## Section 3: Keyless Signing with Cosign

Keyless signing uses OIDC tokens from the build environment to obtain short-lived certificates from Fulcio. No private key needs to be stored or rotated.

### Signing in GitHub Actions

```yaml
# .github/workflows/build-and-sign.yml
name: Build and Sign

on:
  push:
    branches: [main]

jobs:
  build-sign:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write        # CRITICAL: required for keyless signing

    steps:
    - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Install cosign
      uses: sigstore/cosign-installer@dc72c7d5c4d10cd6bcb8cf6e3fd625a9e5e537da  # v3.7.0

    - name: Login to GHCR
      uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567  # v3.3.0
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    - name: Build and push
      id: build
      uses: docker/build-push-action@471d1dc4e07e5cdedd8fcfe5faff9ef7f15fd03b  # v6.9.0
      with:
        context: .
        push: true
        tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
        # Always reference by digest to prevent TOCTOU attacks
        provenance: mode=max
        sbom: true

    - name: Sign the image
      # GITHUB_TOKEN is used to authenticate with GHCR for pushing the signature
      # The OIDC token is used to obtain a Fulcio certificate
      run: |
        cosign sign \
          --yes \
          --rekor-url https://rekor.sigstore.dev \
          "ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}"

    - name: Verify the signature
      run: |
        cosign verify \
          --certificate-identity-regexp \
            "https://github.com/${{ github.repository }}/.github/workflows/.*" \
          --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
          --rekor-url https://rekor.sigstore.dev \
          "ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}"
```

### Signing with Key Pairs (Air-Gapped / Enterprise)

For environments without internet access to Fulcio/Rekor, or where regulatory requirements mandate key-based signing:

```bash
# Generate key pair — store the private key in a KMS or secrets manager
cosign generate-key-pair \
  --kms "awskms:///arn:aws:kms:us-east-1:123456789012:key/mrk-abc123"

# For local key files (less recommended)
cosign generate-key-pair
# Outputs: cosign.key (encrypted private key), cosign.pub (public key)

# Sign with KMS key
cosign sign \
  --key "awskms:///arn:aws:kms:us-east-1:123456789012:key/mrk-abc123" \
  --rekor-url https://rekor.internal.example.com \
  ghcr.io/org/app@sha256:abc123

# Verify with public key
cosign verify \
  --key cosign.pub \
  --rekor-url https://rekor.internal.example.com \
  ghcr.io/org/app@sha256:abc123
```

### Running a Private Rekor Instance

For air-gapped environments:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: rekor
  namespace: sigstore
spec:
  chart:
    spec:
      chart: rekor
      sourceRef:
        kind: HelmRepository
        name: sigstore
  values:
    rekor:
      config:
        treeID: ""  # Auto-generated
      extraArgs:
      - --rekor_server.hostname=rekor.internal.example.com
    redis:
      enabled: true
    mysql:
      enabled: true
    trillian:
      enabled: true
```

## Section 4: Cosign Attestations

Beyond signatures, Cosign can attach structured attestations to images. Attestations carry verifiable metadata: SLSA provenance, vulnerability scan results, SBOMs, test results, and custom predicates.

### Generating SLSA Provenance

When using Tekton Chains, SLSA provenance is generated automatically. For GitHub Actions:

```yaml
# Using slsa-github-generator for SLSA Level 3
- name: Generate SLSA provenance
  uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.0.0
  with:
    image: ghcr.io/${{ github.repository }}
    digest: ${{ steps.build.outputs.digest }}
    registry-username: ${{ github.actor }}
  secrets:
    registry-password: ${{ secrets.GITHUB_TOKEN }}
```

For manual provenance generation:

```bash
# Create a provenance predicate
cat > provenance.json << 'EOF'
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v1",
  "subject": [
    {
      "name": "ghcr.io/org/app",
      "digest": {"sha256": "abc123def456..."}
    }
  ],
  "predicate": {
    "buildDefinition": {
      "buildType": "https://github.com/slsa-framework/slsa-github-generator/container@v1",
      "externalParameters": {
        "workflow": {
          "ref": "refs/heads/main",
          "repository": "https://github.com/org/app",
          "path": ".github/workflows/build.yml"
        }
      },
      "resolvedDependencies": [
        {
          "uri": "git+https://github.com/org/app@refs/heads/main",
          "digest": {"sha1": "abc123"}
        }
      ]
    },
    "runDetails": {
      "builder": {"id": "https://github.com/slsa-framework/slsa-github-generator@v2.0.0"},
      "metadata": {
        "invocationId": "https://github.com/org/app/actions/runs/12345678",
        "startedOn": "2027-06-23T10:00:00Z",
        "finishedOn": "2027-06-23T10:15:00Z"
      }
    }
  }
}
EOF

# Attach provenance attestation
cosign attest \
  --predicate provenance.json \
  --type slsaprovenance1 \
  --yes \
  ghcr.io/org/app@sha256:abc123def456...
```

### Attaching Vulnerability Scan Results

```bash
# Scan with Grype and save results
grype ghcr.io/org/app@sha256:abc123 \
  -o cyclonedx-json > vulnerabilities.json

# Attach as attestation
cosign attest \
  --predicate vulnerabilities.json \
  --type "https://cyclonedx.org/bom/v1.5" \
  --yes \
  ghcr.io/org/app@sha256:abc123

# Verify and retrieve vulnerability attestation
cosign verify-attestation \
  --type "https://cyclonedx.org/bom/v1.5" \
  --certificate-identity-regexp "https://github.com/org/app/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/org/app@sha256:abc123 | jq '.payload | @base64d | fromjson'
```

## Section 5: SBOM Generation with Syft

Software Bill of Materials (SBOM) documents every component in a software artifact. It is the ingredient list for a container image.

### Generating SBOMs with Syft

```bash
# Install Syft
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | \
  sh -s -- -b /usr/local/bin

# Generate SBOM for a container image
syft ghcr.io/org/app:latest \
  -o spdx-json=sbom.spdx.json \
  -o cyclonedx-json=sbom.cdx.json

# Generate SBOM for a local directory (during build)
syft dir:. \
  -o spdx-json=sbom-source.spdx.json

# Generate SBOM with package type filtering
syft ghcr.io/org/app:latest \
  -o spdx-json \
  --select-catalogers "go-module-file-cataloger,dpkg-db-cataloger"
```

### Attaching SBOM as OCI Attestation

```bash
# Attach SBOM as a CycloneDX attestation
cosign attest \
  --predicate sbom.cdx.json \
  --type cyclonedx \
  --yes \
  ghcr.io/org/app@sha256:abc123

# Attach SBOM as an SPDX attestation
cosign attest \
  --predicate sbom.spdx.json \
  --type spdx \
  --yes \
  ghcr.io/org/app@sha256:abc123
```

### Using Docker Buildx SBOM Integration

Docker Buildx can generate SBOMs natively during image builds:

```bash
# Build with SBOM generation
docker buildx build \
  --sbom=true \
  --provenance=mode=max \
  --push \
  --tag ghcr.io/org/app:latest \
  .

# The SBOM and provenance are automatically attached to the image index
# Inspect with: docker buildx imagetools inspect ghcr.io/org/app:latest
```

## Section 6: Vulnerability Scanning with Grype

Grype is Anchore's vulnerability scanner for container images and filesystems. It uses the Grype vulnerability database, which aggregates CVEs from NVD, GitHub Security Advisories, and OS-specific vulnerability databases.

### Installing and Running Grype

```bash
# Install Grype
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | \
  sh -s -- -b /usr/local/bin

# Scan an image
grype ghcr.io/org/app:latest

# Scan with severity filter — fail on HIGH and CRITICAL
grype ghcr.io/org/app:latest \
  --fail-on high \
  --output json > scan-results.json

# Scan a local filesystem
grype dir:.

# Scan an SBOM file
grype sbom:./sbom.spdx.json

# Update vulnerability database
grype db update
```

### Grype in CI with Policy Enforcement

```yaml
- name: Scan image with Grype
  uses: anchore/scan-action@v4
  id: scan
  with:
    image: ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
    fail-build: true
    severity-cutoff: high
    output-format: sarif

- name: Upload Grype SARIF
  uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: ${{ steps.scan.outputs.sarif }}
```

### Configuring Grype Ignore Rules

Not all CVEs are immediately fixable. Grype supports ignore rules to suppress known-acceptable findings:

```yaml
# .grype.yaml
ignore:
  # Ignore specific CVEs
  - vulnerability: CVE-2023-1234
    reason: "Not exploitable in this configuration — no network exposure"

  # Ignore by package name and version
  - package:
      name: openssl
      version: 3.0.7-r0
      type: apk
    reason: "Patched in next release, deploying in 7 days"

  # Ignore by severity for specific paths
  - vulnerability:
      severity: low
    reason: "Low severity findings are acceptable"

# Fail on unmatched HIGH or CRITICAL
fail-on-severity: high
```

## Section 7: Policy Controller Admission Enforcement

Sigstore's Policy Controller is a Kubernetes admission webhook that enforces image signing requirements before pods are admitted to the cluster.

### Installing Policy Controller

```bash
helm repo add sigstore https://sigstore.github.io/helm-charts
helm repo update

helm install policy-controller sigstore/policy-controller \
  --namespace cosign-system \
  --create-namespace \
  --set cosign.webhookName=policy.sigstore.dev
```

### ClusterImagePolicy

The `ClusterImagePolicy` CRD defines which images require signatures and what verification criteria they must meet:

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
  # All images from the org's registry must be signed
  - glob: "ghcr.io/org/**"
  # Internal registry
  - glob: "registry.internal.example.com/**"

  authorities:
  # Keyless signature from GitHub Actions
  - name: github-actions-keyless
    keyless:
      url: https://fulcio.sigstore.dev
      identities:
      - issuer: https://token.actions.githubusercontent.com
        subjectRegExp: "https://github.com/org/[^/]+/.github/workflows/.*@refs/heads/main"
    ctlog:
      url: https://rekor.sigstore.dev

  # Policy: all must pass
  policy:
    type: cue
    data: |
      package sigstore
      import "time"

      // Reject images signed more than 90 days ago
      deny[msg] {
        cert := input.sig.cert
        notAfter := time.parse_rfc3339_ns(cert.notAfter)
        ageInSeconds := (time.now_ns() - notAfter) / 1000000000
        ageInSeconds < 0  // Certificate expired (past notAfter)
        msg := sprintf("Certificate expired at %s", [cert.notAfter])
      }
```

### Namespace-Scoped Enforcement

The Policy Controller is opt-in per namespace via labels:

```bash
# Enable policy enforcement in a namespace
kubectl label namespace production \
  policy.sigstore.dev/include=true

# Enable with a warning mode first (audit only, no blocking)
kubectl label namespace production \
  policy.sigstore.dev/warn=true
```

### Policy for SLSA Provenance Attestation

```yaml
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-slsa-provenance
spec:
  images:
  - glob: "ghcr.io/org/**"

  authorities:
  - name: slsa-provenance-attestation
    keyless:
      url: https://fulcio.sigstore.dev
      identities:
      - issuer: https://token.actions.githubusercontent.com
        subjectRegExp: "https://github.com/org/.*/.*@refs/heads/main"
    attestations:
    - name: must-have-provenance
      predicateType: https://slsa.dev/provenance/v1
      policy:
        type: cue
        data: |
          package sigstore

          // Require SLSA Level 2+: hosted build system
          deny[msg] {
            not startswith(
              input.predicate.runDetails.builder.id,
              "https://github.com/slsa-framework/slsa-github-generator"
            )
            msg := "Image must be built with SLSA GitHub generator"
          }

          // Require the source repository to be from the org
          deny[msg] {
            not startswith(
              input.predicate.buildDefinition.resolvedDependencies[0].uri,
              "git+https://github.com/org/"
            )
            msg := "Image must be built from org/* repository"
          }
```

## Section 8: Kyverno Image Verification Policies

Kyverno provides a more accessible policy language (YAML) for image verification compared to the Policy Controller's CUE-based approach.

### Installing Kyverno

```bash
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set replicaCount=3 \
  --set admissionController.replicas=3
```

### Kyverno Image Verification Policy

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-signed-images
  annotations:
    policies.kyverno.io/title: Require Signed Images
    policies.kyverno.io/description: >
      All container images must be signed with cosign keyless signatures
      from GitHub Actions workflows in the org organization.
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: check-image-signature
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces:
          - production
          - staging
    verifyImages:
    - imageReferences:
      - "ghcr.io/org/*"
      - "registry.internal.example.com/*"
      attestors:
      - count: 1
        entries:
        - keyless:
            subject: "https://github.com/org/*/github/workflows/*@refs/heads/main"
            issuer: "https://token.actions.githubusercontent.com"
            rekor:
              url: https://rekor.sigstore.dev
      # Mutate the image reference to include the digest (pin by digest)
      mutateDigest: true
      verifyDigest: true
      required: true

  - name: check-sbom-attestation
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces:
          - production
    verifyImages:
    - imageReferences:
      - "ghcr.io/org/*"
      attestations:
      - type: https://cyclonedx.org/bom/v1.5
        attestors:
        - entries:
          - keyless:
              subject: "https://github.com/org/*/github/workflows/*"
              issuer: "https://token.actions.githubusercontent.com"
        conditions:
        - all:
          - key: "{{ components | length(@) }}"
            operator: GreaterThanOrEquals
            value: 1
            message: "SBOM must contain at least one component"
```

### Kyverno Policy for Vulnerability Scanning

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-vulnerability-scan
spec:
  validationFailureAction: Enforce
  rules:
  - name: check-vulnerability-attestation
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces: [production]
    verifyImages:
    - imageReferences:
      - "ghcr.io/org/*"
      attestations:
      - type: https://cosign.sigstore.dev/attestation/vuln/v1
        attestors:
        - entries:
          - keyless:
              issuer: "https://token.actions.githubusercontent.com"
              subject: "https://github.com/org/*/github/workflows/*"
        conditions:
        - all:
          # Scanner must have run within the last 7 days
          - key: "{{ time_diff('{{ metadata.scanFinishedOn }}', '{{ time_now_utc() }}') }}"
            operator: LessThanOrEquals
            value: "168h"
            message: "Vulnerability scan must be less than 7 days old"
          # No critical vulnerabilities allowed
          - key: "{{ scanner.result.summary.CRITICAL }}"
            operator: Equals
            value: 0
            message: "Images with CRITICAL vulnerabilities are not allowed in production"
```

## Section 9: End-to-End Pipeline Example

### Complete CI/CD Pipeline with Supply Chain Security

```yaml
# .github/workflows/secure-build.yml
name: Secure Build and Sign

on:
  push:
    branches: [main]

permissions: {}

jobs:
  build-and-sign:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write         # Keyless signing
      attestations: write     # GitHub attestation API
      security-events: write  # SARIF upload

    env:
      IMAGE: ghcr.io/${{ github.repository }}
      DIGEST: ""

    steps:
    - name: Checkout
      uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

    - name: Install cosign
      uses: sigstore/cosign-installer@dc72c7d5c4d10cd6bcb8cf6e3fd625a9e5e537da  # v3.7.0

    - name: Install Syft
      uses: anchore/sbom-action/download-syft@55dc4ee22412511ee8c3a9e30c541cd631f4c5e1  # v0.17.8

    - name: Install Grype
      uses: anchore/scan-action/download-grype@v4

    - name: Set up Docker Buildx
      uses: docker/setup-buildx-action@6524bf65af31da8d45b59e8c27de4bd072b392f5  # v3.8.0

    - name: Login to GHCR
      uses: docker/login-action@9780b0c442fbb1117ed29e0efdff1e18412f7567  # v3.3.0
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}

    # Step 1: Build and push with provenance and SBOM
    - name: Build and push image
      id: build
      uses: docker/build-push-action@471d1dc4e07e5cdedd8fcfe5faff9ef7f15fd03b  # v6.9.0
      with:
        context: .
        push: true
        tags: |
          ${{ env.IMAGE }}:${{ github.sha }}
          ${{ env.IMAGE }}:latest
        labels: |
          org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}
          org.opencontainers.image.revision=${{ github.sha }}
        provenance: mode=max
        sbom: true

    # Step 2: Sign the image with keyless cosign
    - name: Sign image
      run: |
        cosign sign \
          --yes \
          "${{ env.IMAGE }}@${{ steps.build.outputs.digest }}"

    # Step 3: Generate SBOM with Syft
    - name: Generate SBOM
      run: |
        syft "${{ env.IMAGE }}@${{ steps.build.outputs.digest }}" \
          -o spdx-json=sbom.spdx.json \
          -o cyclonedx-json=sbom.cdx.json

    # Step 4: Attach SBOM as attestation
    - name: Attest SBOM
      run: |
        cosign attest \
          --yes \
          --predicate sbom.spdx.json \
          --type spdx \
          "${{ env.IMAGE }}@${{ steps.build.outputs.digest }}"

        cosign attest \
          --yes \
          --predicate sbom.cdx.json \
          --type cyclonedx \
          "${{ env.IMAGE }}@${{ steps.build.outputs.digest }}"

    # Step 5: Vulnerability scan
    - name: Scan with Grype
      id: grype
      uses: anchore/scan-action@v4
      with:
        image: ${{ env.IMAGE }}@${{ steps.build.outputs.digest }}
        fail-build: true
        severity-cutoff: critical
        output-format: json

    # Step 6: Attach vulnerability scan results as attestation
    - name: Attest vulnerability scan
      if: always()
      run: |
        cosign attest \
          --yes \
          --predicate ${{ steps.grype.outputs.json }} \
          --type "https://cosign.sigstore.dev/attestation/vuln/v1" \
          "${{ env.IMAGE }}@${{ steps.build.outputs.digest }}"

    # Step 7: Generate GitHub-native attestation (works with gh attestation verify)
    - name: Generate GitHub attestation
      uses: actions/attest-build-provenance@v2
      with:
        subject-name: ${{ env.IMAGE }}
        subject-digest: ${{ steps.build.outputs.digest }}
        push-to-registry: true

    # Step 8: Upload SARIF results for Code Scanning
    - name: Upload Grype SARIF
      uses: github/codeql-action/upload-sarif@v3
      if: always()
      with:
        sarif_file: ${{ steps.grype.outputs.sarif }}

    # Step 9: Output summary
    - name: Create security summary
      run: |
        cat << 'EOF' >> "$GITHUB_STEP_SUMMARY"
        ## Security Summary

        ### Image Details
        - **Image**: `${{ env.IMAGE }}`
        - **Digest**: `${{ steps.build.outputs.digest }}`
        - **SHA**: `${{ github.sha }}`

        ### Attestations Generated
        - Cosign keyless signature
        - SBOM (SPDX + CycloneDX)
        - Vulnerability scan results
        - SLSA provenance (via Docker Buildx)
        - GitHub build provenance attestation

        ### Verification Command
        ```bash
        cosign verify \
          --certificate-identity-regexp "https://github.com/${{ github.repository }}/.github/workflows/.*" \
          --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
          "${{ env.IMAGE }}@${{ steps.build.outputs.digest }}"
        ```
        EOF
```

## Section 10: Verification Workflows

### Pre-Deployment Verification Script

```bash
#!/bin/bash
# verify-image.sh — verify all supply chain requirements before deployment
set -euo pipefail

IMAGE_REF="${1:?Usage: verify-image.sh <image@digest>}"
REKOR_URL="${REKOR_URL:-https://rekor.sigstore.dev}"
EXPECTED_ISSUER="${EXPECTED_ISSUER:-https://token.actions.githubusercontent.com}"
EXPECTED_SUBJECT_REGEXP="${EXPECTED_SUBJECT_REGEXP:-https://github.com/org/.*/github/workflows/.*@refs/heads/main}"

echo "=== Verifying supply chain for: ${IMAGE_REF} ==="

# 1. Verify image signature
echo "[1/4] Checking image signature..."
cosign verify \
  --certificate-identity-regexp "${EXPECTED_SUBJECT_REGEXP}" \
  --certificate-oidc-issuer "${EXPECTED_ISSUER}" \
  --rekor-url "${REKOR_URL}" \
  "${IMAGE_REF}" > /dev/null 2>&1
echo "  OK: Image signature verified"

# 2. Verify SLSA provenance attestation
echo "[2/4] Checking SLSA provenance..."
PROVENANCE=$(cosign verify-attestation \
  --type slsaprovenance1 \
  --certificate-identity-regexp "${EXPECTED_SUBJECT_REGEXP}" \
  --certificate-oidc-issuer "${EXPECTED_ISSUER}" \
  "${IMAGE_REF}" 2>/dev/null | jq -r '.payload | @base64d | fromjson')

BUILDER=$(echo "${PROVENANCE}" | jq -r '.predicate.runDetails.builder.id')
echo "  OK: SLSA provenance verified — Builder: ${BUILDER}"

# 3. Verify SBOM attestation
echo "[3/4] Checking SBOM attestation..."
cosign verify-attestation \
  --type spdx \
  --certificate-identity-regexp "${EXPECTED_SUBJECT_REGEXP}" \
  --certificate-oidc-issuer "${EXPECTED_ISSUER}" \
  "${IMAGE_REF}" > /dev/null 2>&1
echo "  OK: SBOM attestation present"

# 4. Verify vulnerability scan (must be recent and no critical CVEs)
echo "[4/4] Checking vulnerability scan..."
VULN=$(cosign verify-attestation \
  --type "https://cosign.sigstore.dev/attestation/vuln/v1" \
  --certificate-identity-regexp "${EXPECTED_SUBJECT_REGEXP}" \
  --certificate-oidc-issuer "${EXPECTED_ISSUER}" \
  "${IMAGE_REF}" 2>/dev/null | jq -r '.payload | @base64d | fromjson' || echo "{}")

if [ "${VULN}" = "{}" ]; then
  echo "  WARN: No vulnerability scan attestation found"
else
  CRITICAL=$(echo "${VULN}" | jq -r '.predicate.scanner.result.summary.CRITICAL // 0')
  SCAN_TIME=$(echo "${VULN}" | jq -r '.predicate.metadata.scanFinishedOn // "unknown"')
  if [ "${CRITICAL}" -gt 0 ]; then
    echo "  FAIL: ${CRITICAL} CRITICAL vulnerabilities found (scanned at ${SCAN_TIME})"
    exit 1
  fi
  echo "  OK: No CRITICAL vulnerabilities (scanned at ${SCAN_TIME})"
fi

echo ""
echo "=== All supply chain checks passed ==="
```

### GitHub CLI Attestation Verification

```bash
# Verify using GitHub's native attestation infrastructure
gh attestation verify \
  oci://ghcr.io/org/app@sha256:abc123 \
  --owner org

# Expected output:
# Loaded digest sha256:abc123 for ghcr.io/org/app
# Loaded 1 attestation from GitHub API
# ✓ Verification succeeded!
# sha256:abc123 was attested by:
# REPO         PREDICATE_TYPE
# org/app      https://slsa.dev/provenance/v1
```

## Section 11: Troubleshooting Supply Chain Verification

### Common Verification Failures

**"no signatures found"**: The image was not signed, or the signature was pushed to a different registry than where the image is being pulled from. Check that `cosign sign` and the current pull reference point to the same registry host.

```bash
# Check what's stored in the registry alongside the image
cosign triangulate ghcr.io/org/app@sha256:abc123
# Output: ghcr.io/org/app:sha256-abc123.sig

# List all cosign-attached artifacts
crane ls ghcr.io/org/app | grep sha256
```

**"certificate identity does not match"**: The GitHub Actions workflow path in the certificate doesn't match the expected pattern. Check the exact workflow path:

```bash
# Inspect the signing certificate
cosign verify \
  --output json \
  --certificate-identity-regexp ".*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  ghcr.io/org/app@sha256:abc123 | jq '.[0].optional.Subject'
```

**"rekor entry not found"**: The signature was created with `--no-tlog-upload`. For keyless signatures, Rekor inclusion is mandatory. Re-sign without that flag.

**Kyverno Policy Controller not enforcing**: Check that the namespace has the required label and that the webhook is correctly installed:

```bash
# Verify Policy Controller webhook
kubectl get validatingwebhookconfiguration | grep policy

# Check Policy Controller logs
kubectl logs -n cosign-system \
  -l app=policy-controller-webhook \
  --since=1h

# Test policy manually
kubectl run test-pod \
  --image=ghcr.io/org/app:latest \
  --dry-run=server
```

Building a complete supply chain security posture requires integrating all these components: Syft generates SBOMs during the build, Grype scans for vulnerabilities, Cosign signs the image and attaches attestations to Rekor, and Policy Controller or Kyverno enforces that only images meeting all requirements can run in production. The end result is a cryptographic audit trail from source commit to running container that satisfies SLSA Level 3 requirements and provides the evidence needed for compliance audits and incident investigations.
