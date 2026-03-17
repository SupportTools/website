---
title: "Go Dependency Management: Security Scanning with govulncheck and SBOM Generation"
date: 2031-05-16T00:00:00-05:00
draft: false
tags: ["Go", "Security", "SBOM", "govulncheck", "Supply Chain Security", "DevSecOps", "CI/CD"]
categories:
- Go
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Go dependency security covering govulncheck for CVE detection, nancy for auditing, cyclonedx-gomod for SBOM generation, go.sum integrity verification, vendoring security, and CI pipeline integration for supply chain security."
more_link: "yes"
url: "/go-dependency-security-govulncheck-sbom-generation/"
---

Software supply chain attacks have shifted from theoretical to routine threat vector. The compromise of a single upstream dependency can propagate vulnerabilities to thousands of downstream services. Go's module system provides a strong foundation — go.sum files, checksum databases, and module proxies all contribute to integrity — but knowing which dependencies contain known CVEs requires active tooling.

This guide covers the complete Go dependency security workflow: scanning with govulncheck, auditing with nancy, generating SBOMs with cyclonedx-gomod, verifying go.sum integrity, evaluating vendoring trade-offs, and integrating everything into a CI pipeline that enforces supply chain security before any code reaches production.

<!--more-->

# Go Dependency Management: Security Scanning with govulncheck and SBOM Generation

## Section 1: govulncheck — The Official Go Vulnerability Scanner

`govulncheck` is the Go team's official tool for finding known vulnerabilities in your module's dependencies. Unlike dependency-based scanners that flag every vulnerable version regardless of usage, govulncheck performs static analysis to identify which vulnerable code paths are actually reachable from your binary.

### 1.1 Installation and Basic Usage

```bash
# Install govulncheck
go install golang.org/x/vuln/cmd/govulncheck@latest

# Verify installation
govulncheck --version
# govulncheck v1.1.3

# Scan current module (analyzes source code reachability)
govulncheck ./...

# Output format:
# Vulnerability #1: GO-2024-2687
#   A maliciously crafted brotli stream can overflow a fixed-size lookup table
#   Call stacks in your code:
#     #1: main.go:45:22: myapp/cmd/main.go calls github.com/andybalholm/brotli.NewReader
#   Found in: github.com/andybalholm/brotli@v1.0.5
#   Fixed in: github.com/andybalholm/brotli@v1.1.0
#   More info: https://pkg.go.dev/vuln/GO-2024-2687

# Scan with JSON output for CI processing
govulncheck -json ./... | jq .

# Scan a specific binary (for deployed artifacts)
govulncheck -mode binary ./bin/myapp

# Scan with module-level analysis (faster, no reachability)
govulncheck -scan module ./...
```

### 1.2 Understanding govulncheck Output

```bash
# Full govulncheck run with verbose output
govulncheck -v ./...

# Example output breakdown:
# ==========
# Scanning your code and 127 packages across 38 dependent modules
# for known vulnerabilities...
# ==========

# Vulnerability #1: GO-2024-1234
#   CWE-400: Uncontrolled Resource Consumption
#   Affected: net/http - HTTP/2 CONTINUATION frame flood
#   Call stacks in your code:
#     #1: internal/server/http.go:78:14: myapp calls net/http/httputil.ReverseProxy.ServeHTTP
#   Found in: stdlib@go1.22.0
#   Fixed in: stdlib@go1.22.2
#   More info: https://pkg.go.dev/vuln/GO-2024-1234
#
# Vulnerability #2: GO-2023-5678
#   Only affecting code you import but NOT reachable from your code
#   (not shown by default - use -v to see)

# Key distinction:
# - "affecting" = vulnerability in code paths reachable from your app
# - "not affecting" = vulnerability in a transitive dep but no reachable path
```

### 1.3 Programmatic Integration

```go
// cmd/vulnscan/main.go
// Run govulncheck programmatically in your toolchain
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "os/exec"
)

type VulnResult struct {
    OSV struct {
        ID      string   `json:"id"`
        Aliases []string `json:"aliases"` // CVE numbers
        Summary string   `json:"summary"`
        Details string   `json:"details"`
    } `json:"osv"`
    Findings []struct {
        OSV   string `json:"osv"`
        FixedVersion string `json:"fixed_version"`
        Modules []struct {
            Path    string `json:"path"`
            Version string `json:"version"`
        } `json:"modules"`
        Stacks []struct {
            Message string `json:"message"`
        } `json:"stacks"`
    } `json:"finding"`
}

func runVulncheck(dir string) ([]VulnResult, error) {
    cmd := exec.Command("govulncheck", "-json", "./...")
    cmd.Dir = dir
    output, err := cmd.Output()

    // govulncheck exits with code 3 if vulnerabilities found
    if err != nil {
        if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() != 3 {
            return nil, fmt.Errorf("govulncheck failed: %w", err)
        }
    }

    var results []VulnResult
    decoder := json.NewDecoder(bytes.NewReader(output))
    for decoder.More() {
        var result VulnResult
        if err := decoder.Decode(&result); err != nil {
            continue
        }
        if result.OSV.ID != "" {
            results = append(results, result)
        }
    }

    return results, nil
}
```

## Section 2: nancy — FOSSA's OSS Dependency Auditor

`nancy` from Sonatype integrates with the OSS Index database for broader vulnerability coverage beyond Go's vulnerability database:

### 2.1 Installation and Usage

```bash
# Install nancy
go install github.com/sonatype-nexus-community/nancy@latest

# Basic scan
go list -json -deps ./... | nancy sleuth

# Or with specific output format
go list -json -deps ./... | nancy sleuth --output=json | jq .

# Exclude specific vulnerabilities (known false positives)
go list -json -deps ./... | nancy sleuth --exclude-vulnerability-file .nancy-ignore

# Audit with token for higher rate limits (register at ossindex.sonatype.com)
export OSSI_USERNAME="your-email@example.com"
export OSSI_TOKEN="<ossi-api-token>"
go list -json -deps ./... | nancy sleuth
```

### 2.2 .nancy-ignore File

```
# .nancy-ignore
# Format: SONATYPE-2020-0001 [optional comment]

# Known false positive - test-only dependency, not in production binary
CVE-2023-1234 test dependency only present in _test.go files

# Fix pending upstream - tracked in JIRA-4567
SONATYPE-2024-5678

# Expires: 2031-12-31 (when we expect upstream fix)
CVE-2024-9999
```

### 3.3 Combining govulncheck and nancy

```bash
#!/bin/bash
# scan-dependencies.sh
set -euo pipefail

FAIL=0

echo "=== Running govulncheck ==="
if ! govulncheck ./...; then
  echo "govulncheck: vulnerabilities found in reachable code paths"
  FAIL=1
fi

echo ""
echo "=== Running nancy ==="
if ! go list -json -deps ./... | nancy sleuth --exclude-vulnerability-file .nancy-ignore; then
  echo "nancy: vulnerabilities found in dependencies"
  FAIL=1
fi

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "Security scan failed. Review vulnerabilities above."
  exit 1
fi

echo ""
echo "All security scans passed."
```

## Section 3: SBOM Generation with cyclonedx-gomod

A Software Bill of Materials (SBOM) provides a complete inventory of all dependencies, enabling automated vulnerability tracking, license compliance, and supply chain transparency.

### 3.1 cyclonedx-gomod

```bash
# Install
go install github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@latest

# Generate SBOM for the module
cyclonedx-gomod mod -output sbom.json -json \
  -assert-licenses \
  -licenses \
  -std \
  github.com/myorg/myapp

# Generate SBOM for a specific application binary
cyclonedx-gomod app -output sbom-app.json -json \
  -main cmd/server \
  -licenses \
  -std \
  github.com/myorg/myapp

# Verify the SBOM is valid CycloneDX
cyclonedx-cli validate --input-file sbom.json --input-format json

# Convert to SPDX format (for tools that prefer SPDX)
# Using cyclonedx-cli
cyclonedx-cli convert \
  --input-file sbom.json \
  --input-format json \
  --output-file sbom.spdx \
  --output-format spdxjson
```

### 3.2 Understanding the SBOM Output

```json
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "serialNumber": "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
  "version": 1,
  "metadata": {
    "timestamp": "2031-05-16T12:00:00+00:00",
    "tools": [{
      "vendor": "CycloneDX",
      "name": "cyclonedx-gomod",
      "version": "v1.7.0"
    }],
    "component": {
      "type": "application",
      "name": "myapp",
      "version": "v2.1.0",
      "purl": "pkg:golang/github.com/myorg/myapp@v2.1.0"
    }
  },
  "components": [
    {
      "type": "library",
      "name": "github.com/go-chi/chi/v5",
      "version": "v5.0.12",
      "purl": "pkg:golang/github.com/go-chi/chi/v5@v5.0.12",
      "hashes": [{
        "alg": "SHA-256",
        "content": "abc123..."
      }],
      "licenses": [{
        "license": {"id": "MIT"}
      }],
      "scope": "required"
    }
  ],
  "dependencies": [
    {
      "ref": "pkg:golang/github.com/myorg/myapp@v2.1.0",
      "dependsOn": [
        "pkg:golang/github.com/go-chi/chi/v5@v5.0.12",
        "pkg:golang/github.com/lib/pq@v1.10.9"
      ]
    }
  ]
}
```

### 3.3 syft — Alternative SBOM Generator

```bash
# Install syft (from Anchore)
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin

# Generate SBOM from Go source
syft dir:. -o cyclonedx-json=sbom-syft.json

# Generate SBOM from a Docker image
syft registry.corp.example.com/myapp:v2.1.0 \
  -o cyclonedx-json=sbom-image.json \
  -o spdx-json=sbom-image.spdx.json

# Scan the SBOM with grype for vulnerabilities
grype sbom:sbom-image.json --fail-on high
```

### 3.4 Scanning SBOMs with grype

```bash
# Install grype
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin

# Scan a SBOM file
grype sbom:sbom.json

# Output:
# NAME                     INSTALLED    FIXED-IN   TYPE       VULNERABILITY        SEVERITY
# golang.org/x/net         v0.21.0      v0.23.0    go-module  CVE-2024-27304       High
# google.golang.org/grpc   v1.62.1      v1.64.0    go-module  CVE-2024-24786       Medium

# Fail build on High+ severity
grype sbom:sbom.json --fail-on high --output json | jq .

# Generate VEX (Vulnerability Exploitability eXchange) attestation
grype sbom:sbom.json \
  --output template \
  --template /usr/share/grype/templates/vex.json.tmpl > vex.json
```

## Section 4: go.sum Integrity Verification

### 4.1 How go.sum Works

```bash
# go.sum contains cryptographic hashes of each module version
cat go.sum | head -5
# github.com/go-chi/chi/v5 v5.0.12 h1:S1eTRDNS4EiRIZe8UYXRR2JoQIJXQSN1IJVpbTF2s6A=
# github.com/go-chi/chi/v5 v5.0.12/go.mod h1:f2LDg7xzb80y7v/Ks5g3Pfy1Q0/FBX2NJdSbTTXt5is=

# Each entry has two hashes:
# 1. Module zip file hash (h1: prefix = SHA-256 of zip file tree)
# 2. go.mod file hash

# The checksum database (sum.golang.org) provides a transparency log
# Verify module against checksum database
GONOSUMCHECK="" GOFLAGS="" go mod verify
# all modules verified

# Check if module was verified against checksum database
GONOSUMDB="" go env GONOSUMDB
GOPRIVATE="" go env GOPRIVATE

# GONOSUMDB should be empty in production (or only list internal modules)
# GOPRIVATE should list your internal module paths (skips sum check for private code)
```

### 4.2 Module Verification Best Practices

```bash
# Verify all dependencies are in go.sum
go mod verify
# OK means all current downloads match go.sum hashes

# Check for tidiness (ensure go.sum is complete)
go mod tidy
git diff go.sum  # Should show no changes in CI

# List all modules and their sources
go list -m -json all | jq '{module: .Path, version: .Version, dir: .Dir}'

# Check for replaced modules (potential supply chain risk)
go mod edit -json | jq '.Replace'

# Audit replace directives
cat go.mod | grep -A2 "^replace"
```

### 4.3 GONOSUMDB and Private Modules

```bash
# In CI, set explicit values to prevent silent sum check bypass
export GONOSUMDB="*.corp.example.com,*.internal.example.com"
export GOPRIVATE="*.corp.example.com,*.internal.example.com"
export GOPROXY="https://proxy.golang.org,direct"
export GONOSUMCHECK=""

# For fully air-gapped environments, use a private proxy
export GOPROXY="https://goproxy.corp.example.com|direct"
export GONOSUMDB="*.corp.example.com"
export GONOSUMCHECK="off"  # Only for fully controlled environments

# Set up Athens as a private Go module proxy
# Athens caches and serves modules with consistent hashes
docker run -d \
  -p 3000:3000 \
  -e ATHENS_STORAGE_TYPE=disk \
  -e ATHENS_DISK_STORAGE_ROOT=/var/lib/athens \
  -v /var/lib/athens:/var/lib/athens \
  gomods/athens:latest
```

## Section 5: Vendoring Security Considerations

### 5.1 When to Vendor

```bash
# Initialize vendor directory
go mod vendor

# Verify vendor directory matches go.sum
go mod vendor && git diff vendor/
# No diff = vendor is consistent with go.mod/go.sum

# Build using only vendored dependencies
go build -mod=vendor ./...

# Why vendor for security:
# + Dependencies are committed and audited
# + No network access needed at build time
# + No surprise version changes
# + Can apply custom patches to dependencies (with careful tracking)
#
# Why NOT to vendor:
# - Large repository size (can be 100MB+)
# - Harder to see security fixes (manual updates required)
# - Multi-module workspaces conflict with vendoring
```

### 5.2 Auditing the Vendor Directory

```bash
# Check for modified vendor files (should be zero diffs)
go mod vendor
git diff --stat vendor/

# Verify vendor against current module graph
go mod verify -mod=vendor

# Scan vendor directory specifically
govulncheck -mod=vendor ./...

# Check for vendor directory tampering (compare with module cache)
for dir in vendor/*/; do
  module=$(basename "$dir")
  # Compare vendor with what's in module cache
  echo "Checking $module..."
done

# Advanced: generate hash of entire vendor directory
find vendor/ -type f -name "*.go" | sort | xargs sha256sum | sha256sum
# Store this hash in CI artifacts and compare between builds
```

### 5.3 Detecting Dependency Confusion Attacks

```bash
# Check for internal module names that could be confused with public modules
# Dependency confusion: attacker publishes a public module with same name as internal module

# Ensure all internal modules are listed in GOPRIVATE
go env GOPRIVATE
# corp.example.com,*.corp.example.com

# Verify no public modules exist with your internal names
for module in $(grep "corp.example.com" go.mod | awk '{print $1}'); do
  echo -n "Checking $module on public proxy: "
  # A 200 from the public proxy means the module exists publicly (potential confusion)
  status=$(curl -s -o /dev/null -w "%{http_code}" "https://proxy.golang.org/$module/@v/list" 2>/dev/null)
  if [ "$status" = "200" ]; then
    echo "WARNING: Module exists on public proxy!"
  else
    echo "OK (not on public proxy)"
  fi
done
```

## Section 6: CI Pipeline Integration

### 6.1 GitHub Actions Security Pipeline

```yaml
# .github/workflows/go-security.yml
name: Go Security Scan

on:
  push:
    branches: ["main", "release/*"]
  pull_request:
  schedule:
    # Daily scan for new CVEs affecting existing code
    - cron: '0 2 * * *'

jobs:
  govulncheck:
    name: govulncheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true

      - name: Install govulncheck
        run: go install golang.org/x/vuln/cmd/govulncheck@latest

      - name: Run govulncheck
        run: govulncheck -json ./... | tee govulncheck-results.json

      - name: Check for vulnerabilities in reachable code
        run: |
          # Parse JSON output and fail on any finding with call stacks
          FINDINGS=$(cat govulncheck-results.json | jq -r 'select(.finding.stacks != null) | .finding.osv' | wc -l)
          if [ "$FINDINGS" -gt "0" ]; then
            echo "::error::govulncheck found $FINDINGS vulnerability(ies) in reachable code"
            cat govulncheck-results.json | jq -r 'select(.finding.stacks != null) | {id: .finding.osv, fixed: .finding.fixed_version}'
            exit 1
          fi
          echo "No vulnerabilities in reachable code paths"

      - name: Upload govulncheck results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: govulncheck-results
          path: govulncheck-results.json

  nancy:
    name: nancy dependency audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true

      - name: Install nancy
        run: go install github.com/sonatype-nexus-community/nancy@latest

      - name: Run nancy
        env:
          OSSI_USERNAME: ${{ secrets.OSSI_USERNAME }}
          OSSI_TOKEN: ${{ secrets.OSSI_TOKEN }}
        run: |
          go list -json -deps ./... | nancy sleuth \
            --exclude-vulnerability-file .nancy-ignore \
            --output json | tee nancy-results.json

  sbom-generation:
    name: Generate SBOM
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: true

      - name: Install cyclonedx-gomod
        run: go install github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@latest

      - name: Generate SBOM
        run: |
          cyclonedx-gomod app \
            -output sbom.json \
            -json \
            -main cmd/server \
            -licenses \
            -std \
            github.com/${{ github.repository }}

      - name: Validate SBOM
        run: |
          # Install CycloneDX CLI for validation
          curl -sL https://github.com/CycloneDX/cyclonedx-cli/releases/download/v0.25.1/cyclonedx-linux-x64 -o cyclonedx-cli
          chmod +x cyclonedx-cli
          ./cyclonedx-cli validate --input-file sbom.json --input-format json

      - name: Scan SBOM with grype
        run: |
          curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin
          grype sbom:sbom.json --fail-on high --output json | tee grype-results.json

      - name: Upload SBOM artifacts
        uses: actions/upload-artifact@v4
        with:
          name: sbom-artifacts
          path: |
            sbom.json
            grype-results.json

      - name: Attach SBOM to release
        if: github.event_name == 'release'
        uses: actions/upload-release-asset@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          upload_url: ${{ github.event.release.upload_url }}
          asset_path: ./sbom.json
          asset_name: sbom-cyclonedx.json
          asset_content_type: application/json

  go-sum-verification:
    name: go.sum integrity check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
          cache: false  # Don't cache - we want to verify from scratch

      - name: Verify go.sum integrity
        run: |
          # Ensure GONOSUMDB doesn't silently bypass sum checking
          if [ -n "$GONOSUMDB" ]; then
            echo "::warning::GONOSUMDB is set to $GONOSUMDB - some modules skip checksum verification"
          fi

          # Download all modules and verify against go.sum
          go mod download -x 2>&1 | grep -E "^#|verifying"

          # Verify all modules match go.sum
          go mod verify

      - name: Check for go.sum tidiness
        run: |
          go mod tidy
          if ! git diff --quiet go.sum; then
            echo "::error::go.sum is not tidy - run 'go mod tidy' and commit"
            git diff go.sum
            exit 1
          fi

  license-check:
    name: License compliance
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'

      - name: Install go-licenses
        run: go install github.com/google/go-licenses@latest

      - name: Check for prohibited licenses
        run: |
          # Fail if any GPL/AGPL licenses found (adjust for your policy)
          go-licenses check ./... \
            --disallowed_types="GPL-2.0,GPL-3.0,AGPL-3.0" \
            --ignore github.com/myorg/myapp

      - name: Generate license report
        run: |
          go-licenses report ./... \
            --ignore github.com/myorg/myapp \
            --template license-report-template.tpl > license-report.csv

      - name: Upload license report
        uses: actions/upload-artifact@v4
        with:
          name: license-report
          path: license-report.csv
```

### 6.2 Pre-commit Security Hooks

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: govulncheck
        name: govulncheck
        entry: bash -c 'govulncheck ./... || (echo "Run: govulncheck ./... to see details"; exit 1)'
        language: system
        pass_filenames: false
        types: [go]
        stages: [pre-push]  # Only on push, not every commit

      - id: go-sum-verify
        name: go.sum verification
        entry: bash -c 'go mod verify && go mod tidy && git diff --quiet go.sum || (echo "go.sum needs updating: run go mod tidy"; exit 1)'
        language: system
        pass_filenames: false
        types: [go]

      - id: nancy-scan
        name: nancy vulnerability scan
        entry: bash -c 'go list -json -deps ./... | nancy sleuth --exclude-vulnerability-file .nancy-ignore'
        language: system
        pass_filenames: false
        types: [go]
        stages: [pre-push]
```

### 6.3 Dependabot Configuration for Go

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: gomod
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "06:00"
      timezone: "America/New_York"
    # Group security fixes for faster review
    groups:
      security-updates:
        applies-to: security-updates
        update-types: ["minor", "patch"]
    # Review open PRs for major bumps individually
    open-pull-requests-limit: 10
    labels:
      - "dependencies"
      - "go"
    reviewers:
      - "platform-team"
    # Ignore test-only dependencies for faster upgrade cycles
    ignore:
      - dependency-name: "github.com/stretchr/testify"
        update-types: ["version-update:semver-major"]
```

## Section 7: SBOM Attestation with Cosign

For production artifacts, sign the SBOM alongside the container image:

```bash
# Install cosign
curl -sL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 -o cosign
chmod +x cosign && sudo mv cosign /usr/local/bin/

# Generate signing key
cosign generate-key-pair --output-key-prefix cosign

# Attach SBOM as attestation to container image
cosign attest \
  --predicate sbom.json \
  --type cyclonedx \
  --key cosign.key \
  registry.corp.example.com/myapp:v2.1.0

# Verify the attestation
cosign verify-attestation \
  --key cosign.pub \
  --type cyclonedx \
  registry.corp.example.com/myapp:v2.1.0 | jq '.payload | @base64d | fromjson'

# Use in-toto attestation format (SLSA provenance)
cosign attest \
  --predicate sbom.json \
  --type spdxjson \
  --key cosign.key \
  registry.corp.example.com/myapp:v2.1.0

# Verify at deployment time in Kubernetes via policy
# Using Kyverno or OPA Gatekeeper to require valid SBOM attestation
```

## Section 8: Ongoing Vulnerability Management

### 8.1 Triaging govulncheck Findings

```bash
#!/bin/bash
# triage-vulns.sh
# Generate a structured report for security review

govulncheck -json ./... 2>&1 | jq -r '
  select(.finding != null) |
  "=== " + .finding.osv + " ===",
  "Severity: " + (.osv.database_specific.severity // "UNKNOWN"),
  "Summary: " + .osv.summary,
  "Fixed in: " + .finding.fixed_version,
  "Affected modules:",
  (.finding.modules[] | "  - " + .path + "@" + .version),
  if .finding.stacks then
    "REACHABLE - Call stacks:",
    (.finding.stacks[] | "  " + .message)
  else
    "NOT REACHABLE from your code"
  end,
  ""
'
```

### 8.2 Automated Upgrade Script

```bash
#!/bin/bash
# upgrade-vulnerable.sh
# Automatically upgrade packages with known CVEs to fixed versions

govulncheck -json ./... 2>/dev/null | jq -r '
  select(.finding.fixed_version != null) |
  .finding.modules[].path + "@" + .finding.fixed_version
' | sort -u | while read module; do
  echo "Upgrading $module..."
  go get "$module"
done

go mod tidy
echo ""
echo "After upgrades - re-running govulncheck:"
govulncheck ./...
```

Supply chain security is not a one-time task but an ongoing operational discipline. The combination of govulncheck for reachability-aware CVE detection, cyclonedx-gomod for SBOM generation, and automated CI enforcement creates a defensible security posture that can demonstrate compliance to auditors and regulators while actually protecting your production systems.
