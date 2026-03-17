---
title: "DevSecOps Container Security Pipeline: From Code to Production"
date: 2027-10-26T00:00:00-05:00
draft: false
tags: ["DevSecOps", "Container Security", "CI/CD", "Trivy", "Supply Chain"]
categories:
- Security
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "End-to-end container security pipeline covering Dockerfile scanning with Hadolint, SBOM generation with Syft, Trivy vulnerability scanning, Cosign image signing, admission control for signed images, SLSA provenance, and runtime security."
more_link: "yes"
url: "/devsecops-container-security-pipeline-guide/"
---

A container security pipeline that slows delivery will be bypassed. One that runs automatically and fails fast catches vulnerabilities before they reach production without adding friction to the development workflow. This guide builds a complete pipeline from Dockerfile commit to signed, attested production deployment, with each gate adding security value while maintaining developer velocity.

<!--more-->

# DevSecOps Container Security Pipeline: From Code to Production

## Section 1: Dockerfile Security Scanning with Hadolint

Hadolint parses Dockerfiles against a ruleset derived from Docker best practices and the CIS Docker Benchmark. It runs in milliseconds and catches issues that Trivy cannot:

```bash
# Install hadolint
curl -sSL https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64 \
  -o /usr/local/bin/hadolint && chmod +x /usr/local/bin/hadolint

# Run against a Dockerfile
hadolint Dockerfile

# Run with custom rule ignores (for intentional deviations)
hadolint --ignore DL3008 --ignore DL3018 Dockerfile

# Output as SARIF for GitHub Code Scanning
hadolint -f sarif Dockerfile > hadolint-results.sarif
```

### Common Hadolint Findings and Remediation

```dockerfile
# BEFORE — Multiple issues flagged by hadolint:
FROM ubuntu:latest                     # DL3007: use specific tag
RUN apt-get install curl -y            # DL3008: pin package versions
RUN curl https://example.com/setup.sh | sh  # DL4006: use set -o pipefail

# AFTER — Hadolint compliant:
FROM ubuntu:22.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl=7.81.0-1ubuntu1.16 \
    && rm -rf /var/lib/apt/lists/*

# Run as non-root (hadolint warning DL3002 if USER is not set)
RUN groupadd --gid 65534 appgroup \
    && useradd --uid 65534 --gid appgroup --shell /bin/sh --no-create-home appuser
USER 65534:65534
```

### Production-Grade Dockerfile Template

```dockerfile
# syntax=docker/dockerfile:1.9
# checkov:skip=CKV_DOCKER_2: HEALTHCHECK defined in Kubernetes
FROM golang:1.23-alpine3.20 AS builder

# Install build dependencies with pinned versions.
RUN apk add --no-cache \
    git=2.45.2-r0 \
    ca-certificates=20240705-r0

WORKDIR /build

# Cache dependency download separately from source compilation.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY . .

RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -trimpath \
    -o /app/server \
    ./cmd/server

# ---- Final stage ----
FROM scratch

# Import only the CA certs needed for HTTPS.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

COPY --from=builder /app/server /server

# Non-root UID/GID must be set here for scratch images.
USER 65534:65534

EXPOSE 8080 9090

ENTRYPOINT ["/server"]
```

---

## Section 2: SBOM Generation with Syft

A Software Bill of Materials (SBOM) is a machine-readable inventory of every library in a container image. It enables vulnerability tracking without re-scanning the image.

```bash
# Install Syft
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin

# Generate SBOM in SPDX JSON format (most tool-compatible)
syft packages ghcr.io/myorg/myapp:v1.2.3 \
  -o spdx-json=myapp-sbom.spdx.json

# Generate in CycloneDX format (preferred by Dependency-Track)
syft packages ghcr.io/myorg/myapp:v1.2.3 \
  -o cyclonedx-json=myapp-sbom.cdx.json

# Generate from a local directory (before building the image)
syft packages dir:. -o spdx-json=source-sbom.spdx.json

# Attach SBOM to the OCI image using ORAS
oras attach ghcr.io/myorg/myapp:v1.2.3 \
  --artifact-type application/spdx+json \
  myapp-sbom.spdx.json:application/spdx+json

# Or use Cosign to attach the SBOM as an attestation:
cosign attest --type spdxjson \
  --predicate myapp-sbom.spdx.json \
  ghcr.io/myorg/myapp:v1.2.3
```

### Automated SBOM in CI

```yaml
# .github/workflows/sbom.yaml
name: SBOM Generation

on:
  push:
    tags: ["v*"]

jobs:
  sbom:
    runs-on: ubuntu-latest
    permissions:
      packages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - name: Build image
        id: build
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/myorg/myapp:${{ github.ref_name }}
          sbom: true        # BuildKit native SBOM
          provenance: true  # SLSA provenance attestation

      - name: Install Syft
        uses: anchore/sbom-action/download-syft@v0

      - name: Generate CycloneDX SBOM
        uses: anchore/sbom-action@v0
        with:
          image: ghcr.io/myorg/myapp:${{ github.ref_name }}
          artifact-name: myapp-${{ github.ref_name }}.cdx.json
          output-file: myapp.cdx.json
          format: cyclonedx-json

      - name: Upload SBOM to release
        uses: softprops/action-gh-release@v2
        with:
          files: myapp.cdx.json
```

---

## Section 3: Vulnerability Scanning with Trivy

Trivy scans container images, filesystems, git repositories, and Kubernetes clusters for vulnerabilities, misconfigurations, secrets, and license issues.

### CI Integration with Policy Gates

```yaml
# .github/workflows/security.yaml (security gate portion)
  trivy-scan:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: ghcr.io/myorg/myapp:${{ github.sha }}
          format: json
          output: trivy-results.json

      - name: Evaluate vulnerability policy
        run: |
          python3 << 'EOF'
          import json, sys

          with open('trivy-results.json') as f:
              data = json.load(f)

          critical = 0
          high_fixable = 0

          for result in data.get('Results', []):
              for vuln in result.get('Vulnerabilities', []):
                  sev = vuln.get('Severity', '')
                  fixed = vuln.get('FixedVersion', '') != ''

                  if sev == 'CRITICAL':
                      print(f"CRITICAL: {vuln['VulnerabilityID']} in {vuln['PkgName']}")
                      critical += 1

                  if sev == 'HIGH' and fixed:
                      print(f"HIGH (fixable): {vuln['VulnerabilityID']} in {vuln['PkgName']}")
                      high_fixable += 1

          print(f"\nSummary: {critical} CRITICAL, {high_fixable} HIGH (fixable)")

          if critical > 0:
              print("FAIL: CRITICAL vulnerabilities found")
              sys.exit(1)

          if high_fixable > 5:
              print("FAIL: More than 5 fixable HIGH vulnerabilities")
              sys.exit(1)

          print("PASS: Vulnerability policy satisfied")
          EOF

      - name: Upload Trivy results to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: trivy-results.sarif
```

### Trivy Configuration for Production

```yaml
# .trivy.yaml — project-level Trivy configuration
vulnerability:
  type:
    - os
    - library
  severity:
    - CRITICAL
    - HIGH
    - MEDIUM
  ignore-unfixed: false

misconfiguration:
  include-non-failures: false

secret:
  config: trivy-secret.yaml

# trivy-secret.yaml — custom secret detection rules
rules:
  - id: company-api-key
    category: "Company"
    title: "Internal API Key"
    severity: "CRITICAL"
    regex: "MYCOMPANY_[A-Z0-9]{32}"
    path: ""
    allow-rules:
      - id: test-files
        path: ".*_test\\.go"
```

### Scheduled Fleet Scanning

```yaml
# k8s/cronjob-fleet-scan.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: fleet-vulnerability-scan
  namespace: security
spec:
  schedule: "0 2 * * *"   # 2 AM daily
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: trivy-scanner
          containers:
            - name: trivy
              image: aquasec/trivy:0.58.0
              command:
                - /bin/sh
                - -c
                - |
                  trivy k8s \
                    --report summary \
                    --severity CRITICAL,HIGH \
                    --format json \
                    --output /reports/fleet-$(date +%Y%m%d).json \
                    cluster
              volumeMounts:
                - name: reports
                  mountPath: /reports
          volumes:
            - name: reports
              persistentVolumeClaim:
                claimName: security-reports-pvc
          restartPolicy: OnFailure
```

---

## Section 4: Container Image Signing with Cosign

Cosign provides keyless signing via OIDC (Sigstore), eliminating the need to manage long-lived signing keys.

### Keyless Signing in GitHub Actions

```yaml
# .github/workflows/sign.yaml
  sign:
    runs-on: ubuntu-latest
    needs: build
    permissions:
      packages: write
      id-token: write  # Required for keyless OIDC signing
    steps:
      - uses: sigstore/cosign-installer@v3.7.0

      - name: Sign image
        run: |
          cosign sign --yes \
            ghcr.io/myorg/myapp@${{ needs.build.outputs.digest }}
        env:
          COSIGN_EXPERIMENTAL: "1"

      - name: Verify signature (self-check)
        run: |
          cosign verify \
            --certificate-identity-regexp="https://github.com/myorg/myapp/.*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            ghcr.io/myorg/myapp@${{ needs.build.outputs.digest }}
```

### SLSA Provenance Generation

```yaml
# .github/workflows/provenance.yaml
  provenance:
    needs: build
    permissions:
      actions: read
      id-token: write
      packages: write
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.0.0
    with:
      image: ghcr.io/myorg/myapp
      digest: ${{ needs.build.outputs.digest }}
      registry-username: ${{ github.actor }}
    secrets:
      registry-password: ${{ secrets.GITHUB_TOKEN }}
```

Verify provenance:

```bash
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp="https://github.com/slsa-framework/slsa-github-generator/.*" \
  --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
  ghcr.io/myorg/myapp:v1.2.3 | jq -r '.payload | @base64d | fromjson | .predicate'
```

---

## Section 5: Admission Control to Enforce Signed Images

### Sigstore Policy Controller

```bash
# Install the Sigstore Policy Controller (enforces image signatures in Kubernetes)
helm repo add sigstore https://sigstore.github.io/helm-charts
helm install policy-controller sigstore/policy-controller \
  -n cosign-system --create-namespace \
  --set webhook.namespaceSelector.matchExpressions[0].key=policy.sigstore.dev/include \
  --set webhook.namespaceSelector.matchExpressions[0].operator=In \
  --set webhook.namespaceSelector.matchExpressions[0].values[0]=true
```

```yaml
# clusterimagePolicy.yaml — require signed images in all labeled namespaces
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: require-signed-images
spec:
  images:
    - glob: "ghcr.io/myorg/**"
  authorities:
    - keyless:
        url: https://fulcio.sigstore.dev
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subject: https://github.com/myorg/myapp/.github/workflows/sign.yaml@refs/heads/main
      ctlog:
        url: https://rekor.sigstore.dev
```

```bash
# Label the production namespace to enforce the policy
kubectl label namespace production policy.sigstore.dev/include=true

# Test that unsigned images are rejected
kubectl run unsigned-test \
  --image=nginx:latest \
  --namespace=production
# Error: admission webhook "policy.sigstore.dev" denied the request:
# image nginx:latest is not signed
```

### Kyverno Policy for Vulnerability Gate

```yaml
# kyverno-policy.yaml — block images with CRITICAL CVEs at admission time
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: block-critical-vulnerabilities
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: check-trivy-scan
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [production, staging]
      validate:
        message: "Image must pass Trivy vulnerability scan with no CRITICAL findings."
        cel:
          expressions:
            - expression: |
                object.spec.containers.all(container,
                  has(container.image) &&
                  container.image.contains('@sha256:')
                )
              message: "All production images must reference digests, not tags."
```

---

## Section 6: Dependency Confusion Attack Prevention

Dependency confusion attacks trick package managers into downloading a malicious public package instead of a private one.

### Go Module Proxy Configuration

```bash
# Force all packages under github.com/myorg to use the internal proxy
GONOSUMCHECK=github.com/myorg/*
GOPRIVATE=github.com/myorg/*
GONOSUMDB=github.com/myorg/*

# In the Dockerfile:
ENV GOPRIVATE=github.com/myorg/*
ENV GONOSUMDB=github.com/myorg/*
ENV GOFLAGS=-mod=readonly
```

### Dependency Pinning Verification

```bash
#!/usr/bin/env bash
# check-deps.sh — verify all dependencies have expected checksums

# Compare go.sum against a known-good baseline
git diff HEAD~1 go.sum | grep "^+" | grep -v "^+++" | while read line; do
  package=$(echo "$line" | awk '{print $1}' | sed 's/^+//')
  echo "New dependency or version change: $package"
done

# Scan for typosquatting in direct dependencies
go mod graph | awk '{print $1}' | sort -u | while read pkg; do
  # Check if package name is suspiciously close to common packages
  python3 -c "
import sys
import difflib
pkg = '$pkg'.split('@')[0]
common = ['github.com/golang/protobuf', 'github.com/pkg/errors', 'github.com/stretchr/testify']
for c in common:
    ratio = difflib.SequenceMatcher(None, pkg, c).ratio()
    if ratio > 0.85 and pkg != c:
        print(f'WARNING: {pkg} is {ratio:.0%} similar to {c}', file=sys.stderr)
"
done
```

---

## Section 7: Runtime Security Monitoring

### Falco Rules for Container Threats

```yaml
# falco/rules/custom.yaml
- rule: Crypto Miner Execution
  desc: Detect execution of known crypto mining tools
  condition: >
    spawned_process and
    (proc.name in (xmrig, ccminer, cgminer, minerd, t-rex) or
     proc.cmdline contains "stratum+tcp")
  output: >
    Crypto miner executed
    (user=%user.name command=%proc.cmdline container=%container.name image=%container.image.repository)
  priority: CRITICAL
  tags: [cryptomining, T1496]

- rule: Container Escape via proc Mount
  desc: Detect attempts to mount the host /proc filesystem
  condition: >
    evt.type = mount and
    mount.dest = "/proc" and
    container.id != ""
  output: >
    Possible container escape via /proc mount
    (user=%user.name container=%container.name)
  priority: CRITICAL
  tags: [container_escape, T1611]

- rule: Unexpected Outbound Connection from Protected Container
  desc: Alert on outbound connections from containers that should not make them
  condition: >
    outbound and
    container.image.repository in (protected_images) and
    not fd.rip in (allowed_external_ips)
  output: >
    Unexpected outbound connection
    (image=%container.image.repository dest=%fd.rip:%fd.rport)
  priority: HIGH

- list: protected_images
  items:
    - "ghcr.io/myorg/database-proxy"
    - "ghcr.io/myorg/payment-service"

- list: allowed_external_ips
  items:
    - "10.0.0.0/8"
    - "172.16.0.0/12"
    - "192.168.0.0/16"
```

```yaml
# falco/values.yaml (helm chart)
falco:
  grpc:
    enabled: true
  grpcOutput:
    enabled: true
  jsonOutput: true
  rules_file:
    - /etc/falco/falco_rules.yaml
    - /etc/falco/k8s_audit_rules.yaml
    - /etc/falco/rules.d/custom.yaml

falcosidekick:
  enabled: true
  config:
    slack:
      webhookurl: "https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url"
      minimumpriority: "warning"
    prometheus:
      listenport: "2801"
```

---

## Section 8: Complete Pipeline Integration

The complete pipeline assembles all security gates in sequence:

```yaml
# .github/workflows/security-pipeline.yaml
name: Security Pipeline

on:
  push:
    branches: [main]
  pull_request:

jobs:
  # Gate 1: Static analysis
  static-analysis:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Hadolint
        uses: hadolint/hadolint-action@v3.1.0
        with:
          dockerfile: Dockerfile
          failure-threshold: warning
      - name: gosec
        run: |
          go install github.com/securego/gosec/v2/cmd/gosec@latest
          gosec -severity medium ./...
      - name: govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...

  # Gate 2: Build with provenance
  build:
    needs: static-analysis
    runs-on: ubuntu-latest
    permissions:
      packages: write
      id-token: write
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build and push
        id: build
        uses: docker/build-push-action@v6
        with:
          push: ${{ github.event_name != 'pull_request' }}
          tags: ghcr.io/myorg/myapp:${{ github.sha }}
          provenance: true
          sbom: true

  # Gate 3: SBOM + vulnerability scan
  scan:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          image: ghcr.io/myorg/myapp:${{ github.sha }}
          format: cyclonedx-json
          output-file: sbom.cdx.json

      - name: Scan SBOM with Trivy
        run: |
          trivy sbom sbom.cdx.json \
            --exit-code 1 \
            --severity CRITICAL

  # Gate 4: Sign
  sign:
    needs: scan
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      packages: write
      id-token: write
    steps:
      - uses: sigstore/cosign-installer@v3
      - name: Sign image
        run: |
          cosign sign --yes \
            ghcr.io/myorg/myapp@${{ needs.build.outputs.digest }}

  # Gate 5: SLSA provenance
  provenance:
    needs: sign
    if: github.event_name != 'pull_request'
    permissions:
      actions: read
      id-token: write
      packages: write
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.0.0
    with:
      image: ghcr.io/myorg/myapp
      digest: ${{ needs.build.outputs.digest }}
      registry-username: ${{ github.actor }}
    secrets:
      registry-password: ${{ secrets.GITHUB_TOKEN }}
```

---

## Section 9: Security Gate Metrics and SLA

Tracking gate performance prevents security from becoming a blocker:

```go
// security/metrics.go
package security

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// GateDuration tracks how long each security gate takes.
	GateDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "cicd",
			Subsystem: "security",
			Name:      "gate_duration_seconds",
			Help:      "Duration of each security gate.",
			Buckets:   []float64{10, 30, 60, 120, 300, 600},
		},
		[]string{"gate", "result"},
	)

	// GateBlockedDeployments counts deployments blocked by security gates.
	GateBlockedDeployments = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "cicd",
			Subsystem: "security",
			Name:      "blocked_deployments_total",
			Help:      "Deployments blocked by security gates.",
		},
		[]string{"gate", "reason"},
	)

	// CriticalVulnerabilitiesBlocked tracks critical CVEs prevented from reaching production.
	CriticalVulnerabilitiesBlocked = promauto.NewCounter(
		prometheus.CounterOpts{
			Namespace: "cicd",
			Subsystem: "security",
			Name:      "critical_vulnerabilities_blocked_total",
			Help:      "Critical vulnerabilities blocked from reaching production.",
		},
	)
)
```

Target SLAs for security gates that preserve velocity:

| Gate | Target Duration | Max Acceptable |
|---|---|---|
| Hadolint | 5 seconds | 30 seconds |
| gosec + govulncheck | 60 seconds | 3 minutes |
| Trivy image scan | 90 seconds | 5 minutes |
| Cosign sign | 10 seconds | 30 seconds |
| SLSA provenance | 30 seconds | 2 minutes |
| Total pipeline overhead | ~4 minutes | 10 minutes |

Any gate exceeding its maximum should trigger a platform investigation — slow security gates are abandoned security gates.

---

## Section 10: Defense in Depth Summary

The pipeline provides security at five distinct layers:

1. **Pre-build**: Hadolint catches Dockerfile misconfigurations before any image is built. gosec and govulncheck catch code-level security issues before they are packaged.

2. **Build**: BuildKit generates native SBOM and provenance attestations. The FROM scratch or distroless base eliminates OS-level attack surface.

3. **Post-build**: Trivy scans the final image against the full CVE database including language packages. SBOM is attached as an OCI artifact for ongoing tracking.

4. **Deployment gate**: Sigstore Policy Controller or Kyverno rejects any image without a valid OIDC signature from the CI pipeline. Only code that passed all gates can reach production.

5. **Runtime**: Falco monitors actual container behavior and fires on anomalies that static scanning cannot detect (zero-day exploits, insider threat, misconfiguration exploitation).

No single layer is sufficient. An attacker that bypasses Trivy (zero-day CVE) will still be caught by Falco's behavioral rules when they attempt post-exploitation activity.

---

## Section 11: Image Lifecycle Management

Stale images accumulate vulnerabilities. Automate lifecycle policies:

```yaml
# Harbor robot account policy (or Quay.io tag expiration):
# Delete untagged images after 7 days.
# Delete images tagged as "pr-*" after 14 days.
# Retain the last 10 production tags indefinitely.

# registry/cleanup-policy.yaml (Harbor API)
apiVersion: v1
kind: ConfigMap
metadata:
  name: harbor-cleanup-policy
  namespace: registry
data:
  policy.json: |
    {
      "rules": [
        {
          "action": "retain",
          "selectors": [
            {"kind": "regexOrName", "decoration": "matches", "pattern": "v[0-9]+\\.[0-9]+\\.[0-9]+"}
          ],
          "scopeSelectors": {
            "repository": [{"kind": "doublestar", "decoration": "repoMatches", "pattern": "**"}]
          },
          "template": "latestPushedK",
          "parameters": {"latestPushedK": 10}
        },
        {
          "action": "retain",
          "selectors": [
            {"kind": "regexOrName", "decoration": "matches", "pattern": "pr-.*"}
          ],
          "template": "nDaysSinceLastPull",
          "parameters": {"nDaysSinceLastPull": 14}
        }
      ]
    }
```

```bash
#!/usr/bin/env bash
# tag-cleanup.sh — remove old PR images from GHCR
# Requires: gh CLI authenticated, jq

REGISTRY="ghcr.io"
OWNER="myorg"
REPO="myapp"

# List all package versions tagged as pr-*
gh api \
  "/orgs/${OWNER}/packages/container/${REPO}/versions?per_page=100" \
  --jq '.[] | select(.metadata.container.tags[] | startswith("pr-")) | {id: .id, tags: .metadata.container.tags, created: .created_at}' \
| jq -c '.' | while read version; do
  created=$(echo "$version" | jq -r '.created')
  age_days=$(( ( $(date +%s) - $(date -d "$created" +%s) ) / 86400 ))
  if [ "$age_days" -gt 14 ]; then
    id=$(echo "$version" | jq -r '.id')
    echo "Deleting version $id (${age_days} days old)"
    gh api --method DELETE "/orgs/${OWNER}/packages/container/${REPO}/versions/${id}"
  fi
done
```

---

## Section 12: Container Image Hardening Checklist

Before any image is promoted to production, validate against this checklist programmatically:

```go
// security/image_checker.go
package security

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/go-containerregistry/pkg/crane"
	"github.com/google/go-containerregistry/pkg/v1/config"
)

// ImageCheck represents a single image hardening check.
type ImageCheck struct {
	Name    string
	Check   func(cfg *config.ConfigFile) error
}

// StandardChecks returns the full set of image hardening checks.
func StandardChecks() []ImageCheck {
	return []ImageCheck{
		{
			Name: "no-root-user",
			Check: func(cfg *config.ConfigFile) error {
				user := cfg.Config.User
				if user == "" || user == "root" || user == "0" || strings.HasPrefix(user, "0:") {
					return fmt.Errorf("image runs as root (user=%q)", user)
				}
				return nil
			},
		},
		{
			Name: "no-latest-tag",
			Check: func(cfg *config.ConfigFile) error {
				// This check is enforced at build time; here we verify metadata.
				labels := cfg.Config.Labels
				if labels["org.opencontainers.image.version"] == "" {
					return fmt.Errorf("missing org.opencontainers.image.version label")
				}
				return nil
			},
		},
		{
			Name: "has-healthcheck",
			Check: func(cfg *config.ConfigFile) error {
				if cfg.Config.Healthcheck == nil {
					// Health checks in Kubernetes manifests are preferred over Docker HEALTHCHECK.
					// This check only warns, not fails.
					return nil
				}
				return nil
			},
		},
		{
			Name: "no-secrets-in-env",
			Check: func(cfg *config.ConfigFile) error {
				sensitiveKeys := []string{"PASSWORD", "SECRET", "TOKEN", "KEY", "CREDENTIAL"}
				for _, env := range cfg.Config.Env {
					parts := strings.SplitN(env, "=", 2)
					if len(parts) != 2 {
						continue
					}
					key := strings.ToUpper(parts[0])
					for _, s := range sensitiveKeys {
						if strings.Contains(key, s) && parts[1] != "" {
							return fmt.Errorf("potential secret in ENV: %s", parts[0])
						}
					}
				}
				return nil
			},
		},
	}
}

// RunChecks validates an image against all standard checks.
func RunChecks(ctx context.Context, imageRef string) []error {
	img, err := crane.Pull(imageRef)
	if err != nil {
		return []error{fmt.Errorf("pull image: %w", err)}
	}

	cfgFile, err := img.ConfigFile()
	if err != nil {
		return []error{fmt.Errorf("get config: %w", err)}
	}

	var failures []error
	for _, check := range StandardChecks() {
		if err := check.Check(cfgFile); err != nil {
			failures = append(failures, fmt.Errorf("check %s: %w", check.Name, err))
		}
	}
	return failures
}
```

These programmatic checks run as a final gate before the image is promoted from the build registry to the production registry, ensuring every image in production satisfies the organization's hardening baseline.
