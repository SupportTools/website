---
title: "Kubernetes Security Scanning Pipeline: From Code to Runtime"
date: 2028-03-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Trivy", "Cosign", "Falco", "SBOM", "CI/CD", "GitHub Actions"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "End-to-end Kubernetes security scanning pipeline covering Trivy image scanning, Grype as an alternative, SBOM generation with Syft, OCI image signing with Cosign, Kubernetes admission policy for signature verification, Falco runtime scanning, and kube-hunter cluster auditing integrated into GitHub Actions."
more_link: "yes"
url: "/kubernetes-security-scanning-pipeline-guide/"
---

A complete Kubernetes security scanning pipeline spans four phases: build-time image scanning, software composition analysis, cryptographic image signing, and runtime threat detection. Each phase catches different classes of vulnerability. Build-time scanning identifies known CVEs before deployment. SBOM generation creates an auditable inventory. Image signing provides a verifiable chain of custody. Runtime scanning detects attacks that bypass static analysis. This guide assembles all four into a coherent pipeline with GitHub Actions integration.

<!--more-->

## Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Security Pipeline                         │
│                                                                 │
│  Build  ──► Scan ──► SBOM ──► Sign ──► Verify ──► Deploy      │
│                                                    │            │
│                                              Admission         │
│                                              Webhook           │
│                                              (signature        │
│                                               check)           │
│                                                                 │
│  Runtime:  Falco (behavioral)                                   │
│  Periodic: kube-hunter (cluster audit)                          │
└─────────────────────────────────────────────────────────────────┘
```

## Trivy Image Scanning

Trivy scans OCI images for OS package vulnerabilities, language ecosystem vulnerabilities (Go modules, npm, pip), secrets, and misconfigurations.

### Local Scanning

```bash
# Install Trivy
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin v0.58.0

# Full image scan with all scanners enabled
trivy image \
  --severity HIGH,CRITICAL \
  --scanners vuln,secret,misconfig \
  --format table \
  registry.example.com/api-service:v1.2.0

# Exit code 1 if any HIGH/CRITICAL found (for CI gate)
trivy image \
  --exit-code 1 \
  --severity HIGH,CRITICAL \
  --scanners vuln \
  --ignore-unfixed \
  registry.example.com/api-service:v1.2.0

# JSON output for programmatic processing
trivy image \
  --format json \
  --output scan-results.json \
  registry.example.com/api-service:v1.2.0

# Extract CVE count by severity
cat scan-results.json | jq '
  [.Results[].Vulnerabilities // [] | .[]] |
  group_by(.Severity) |
  map({severity: .[0].Severity, count: length})
'
```

### Trivy Configuration File

```yaml
# .trivy.yaml — project-level Trivy configuration
db:
  skip-update: false
  download-java-db-only: false

image:
  # Scan all layers, not just the last one
  scanners:
    - vuln
    - secret
    - misconfig
  severity:
    - HIGH
    - CRITICAL

vulnerability:
  # Skip vulnerabilities with no fix available
  ignore-unfixed: true
  # CVEs to ignore (with justification comments)
  ignorefile: .trivyignore

secret:
  config: trivy-secret.yaml

# Cache database between runs
cache:
  dir: .trivy-cache

timeout: 10m
```

```
# .trivyignore — CVEs accepted with justification
# CVE-2023-44487 - HTTP/2 Rapid Reset Attack
# Status: Mitigated by Kubernetes network policies; no external HTTP/2 exposure
CVE-2023-44487

# CVE-2024-21626 - runc container escape
# Status: Running on patched nodes (kernel 6.1+), rootless containers
CVE-2024-21626
```

## Grype as Alternative Scanner

Grype uses the Anchore vulnerability database and is particularly strong at detecting vulnerabilities in language-specific dependency files:

```bash
# Install Grype
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin

# Scan image
grype registry.example.com/api-service:v1.2.0 \
  --only-fixed \
  --fail-on high \
  --output table

# Scan a local SBOM (integrates with Syft)
grype sbom:api-service-sbom.spdx.json \
  --fail-on high

# Compare Trivy and Grype results for the same image
# (Running both is recommended for coverage)
grype registry.example.com/api-service:v1.2.0 --output json > grype-results.json
```

### Grype Configuration

```yaml
# .grype.yaml
output: "table"
fail-on-severity: "high"
only-fixed: true
ignore:
  - vulnerability: CVE-2023-44487
    reason: "Mitigated by network policy"
  - fix-state: "won't-fix"

db:
  update-on-start: true
  validate-age: true
  max-allowed-built-age: "120h"
```

## SBOM Generation with Syft

A Software Bill of Materials (SBOM) documents every component in a container image. It enables post-incident analysis, license compliance auditing, and rapid identification of affected images when new CVEs are announced.

```bash
# Install Syft
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin

# Generate SBOM in SPDX JSON format (standard format for exchange)
syft registry.example.com/api-service:v1.2.0 \
  --output spdx-json \
  --file api-service-sbom.spdx.json

# Generate SBOM in CycloneDX format (preferred for tooling integration)
syft registry.example.com/api-service:v1.2.0 \
  --output cyclonedx-json \
  --file api-service-sbom.cyclonedx.json

# Attach SBOM to OCI registry (co-located with the image)
syft attest registry.example.com/api-service:v1.2.0 \
  --output cyclonedx-json \
  --key cosign.key

# Verify attached SBOM
syft registry.example.com/api-service:v1.2.0 --select-layers all

# Query components from SBOM
cat api-service-sbom.spdx.json | jq '
  .packages | map({
    name: .name,
    version: .versionInfo,
    license: .licenseConcluded,
    type: .primaryPackagePurpose
  })
'
```

## OCI Image Signing with Cosign

Cosign signs OCI images and stores signatures in the same registry, co-located with the image. Admission policies can verify these signatures before allowing deployment.

### Key Generation and Management

```bash
# Install Cosign
curl -O -L https://github.com/sigstore/cosign/releases/download/v2.4.0/cosign-linux-amd64
chmod +x cosign-linux-amd64
mv cosign-linux-amd64 /usr/local/bin/cosign

# Generate key pair (for local/CI signing)
# Store the private key in a secret manager, not in source control
cosign generate-key-pair

# For keyless signing (Sigstore transparency log, OIDC-based)
# No keys to manage; identity is bound to OIDC token (GitHub Actions OIDC)
# COSIGN_EXPERIMENTAL=1 cosign sign --identity-token=$(cat $OIDC_TOKEN_FILE) IMAGE

# Sign an image (key-based)
cosign sign \
  --key cosign.key \
  --annotations "environment=production" \
  --annotations "built-by=github-actions" \
  registry.example.com/api-service:v1.2.0

# Sign with GitHub Actions OIDC (keyless, production recommended)
cosign sign \
  --rekor-url https://rekor.sigstore.dev \
  registry.example.com/api-service:v1.2.0
```

### Keyless Signing in GitHub Actions

```yaml
# .github/workflows/build-and-sign.yml (partial, sign step)
- name: Sign image with Cosign
  env:
    COSIGN_EXPERIMENTAL: "1"
  run: |
    cosign sign \
      --yes \
      --rekor-url https://rekor.sigstore.dev \
      --annotations "git-sha=${{ github.sha }}" \
      --annotations "workflow=${{ github.workflow }}" \
      --annotations "repository=${{ github.repository }}" \
      ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
```

### Signature Verification

```bash
# Verify image signature (key-based)
cosign verify \
  --key cosign.pub \
  registry.example.com/api-service:v1.2.0

# Verify keyless signature (check OIDC identity)
cosign verify \
  --rekor-url https://rekor.sigstore.dev \
  --certificate-identity-regexp "https://github.com/example-org/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  registry.example.com/api-service:v1.2.0

# Verify SBOM attestation
cosign verify-attestation \
  --key cosign.pub \
  --type cyclonedx \
  registry.example.com/api-service:v1.2.0
```

## Kubernetes Admission Policy for Signature Verification

### Using Kyverno

Kyverno is the most accessible policy engine for signature verification:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
  annotations:
    policies.kyverno.io/title: Verify Image Signatures
    policies.kyverno.io/category: Supply Chain Security
    policies.kyverno.io/description: >
      Requires all container images to be signed with the organization's
      Cosign key before deployment.
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: check-image-signature
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaceSelector:
                matchLabels:
                  # Apply to production namespaces only
                  environment: production
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |-
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyour+public+key+here==
                      -----END PUBLIC KEY-----
                    signatureAlgorithm: sha256
          # Also require SBOM attestation
          attestations:
            - predicateType: https://cyclonedx.org/bom
              attestors:
                - count: 1
                  entries:
                    - keys:
                        publicKeys: |-
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyour+public+key+here==
                          -----END PUBLIC KEY-----
```

### Using Sigstore Policy Controller

```yaml
# ClusterImagePolicy using Sigstore Policy Controller
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: production-image-policy
spec:
  images:
    - glob: "registry.example.com/**"
  authorities:
    - name: keyless-github-actions
      keyless:
        url: https://fulcio.sigstore.dev
        identities:
          - issuer: https://token.actions.githubusercontent.com
            subjectRegExp: "https://github.com/example-org/.*/\\.github/workflows/.*"
      ctlog:
        url: https://rekor.sigstore.dev
    - name: organization-key
      key:
        secretRef:
          name: cosign-public-key
          namespace: cosign-system
```

## Falco Runtime Security

Falco monitors kernel syscalls and Kubernetes audit events to detect threats at runtime — attacks that bypass static scanning.

### Installation via Helm

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --set driver.kind=modern_ebpf \
  --set falcosidekick.enabled=true \
  --set falcosidekick.webui.enabled=true \
  --set "falcosidekick.config.slack.webhookurl=PLACEHOLDER_SLACK_URL" \
  --set "falcosidekick.config.slack.minimumpriority=warning"
```

### Custom Falco Rules

```yaml
# /etc/falco/rules.d/custom-rules.yaml
- rule: Unexpected Outbound Network Connection
  desc: Alert on unexpected outbound connections from application containers
  condition: >
    outbound and
    not proc.name in (expected_outbound_processes) and
    not fd.rip in (allowed_external_ips) and
    container and
    not k8s.ns.name in (kube-system, monitoring)
  output: >
    Unexpected outbound connection from container
    (pod=%k8s.pod.name ns=%k8s.ns.name
     process=%proc.name destination=%fd.rip:%fd.rport)
  priority: WARNING
  tags: [network, mitre_exfiltration]

- rule: Container Shell Spawned
  desc: A shell was spawned in a container — potential compromise
  condition: >
    spawned_process and
    container and
    (proc.name in (shell_binaries) or
     proc.args startswith "-i" or
     proc.args startswith "--interactive") and
    not proc.pname in (allowed_shell_spawners) and
    not k8s.ns.name in (kube-system)
  output: >
    Shell spawned in container
    (user=%user.name pod=%k8s.pod.name ns=%k8s.ns.name
     image=%container.image.repository:%container.image.tag
     command=%proc.cmdline)
  priority: CRITICAL
  tags: [process, mitre_execution]

- rule: Sensitive File Read by Unexpected Process
  desc: Unexpected process reading sensitive files
  condition: >
    open_read and
    fd.name in (sensitive_files) and
    not proc.name in (allowed_sensitive_file_readers) and
    container
  output: >
    Sensitive file read
    (file=%fd.name process=%proc.name pod=%k8s.pod.name ns=%k8s.ns.name)
  priority: ERROR
  tags: [file, mitre_credential_access]

- macro: shell_binaries
  condition: >
    proc.name in (bash, sh, zsh, fish, dash, ksh, csh, tcsh)

- list: sensitive_files
  items:
    - /etc/shadow
    - /etc/sudoers
    - /etc/passwd
    - /root/.ssh/id_rsa
    - /var/run/secrets/kubernetes.io/serviceaccount/token

- list: allowed_shell_spawners
  items:
    - docker
    - containerd-shim
    - sshd
    - kubectl
```

### Falco Alert Integration

```yaml
# FalcoSidekick configuration for multi-channel alerting
apiVersion: v1
kind: ConfigMap
metadata:
  name: falcosidekick-config
  namespace: falco
data:
  config.yaml: |
    slack:
      webhookurl: "PLACEHOLDER_SLACK_URL"
      channel: "#security-alerts"
      minimumpriority: "warning"
      messageformat: |
        :rotating_light: *{{ .Priority }}* - {{ .Rule }}
        *Pod:* {{ index .OutputFields "k8s.pod.name" }}
        *Namespace:* {{ index .OutputFields "k8s.ns.name" }}
        *Message:* {{ .Output }}

    pagerduty:
      routingkey: "PLACEHOLDER_PAGERDUTY_KEY"
      minimumpriority: "critical"

    elasticsearch:
      hostport: "http://elasticsearch:9200"
      index: "falco"
      minimumpriority: "debug"
```

## kube-hunter for Cluster Auditing

kube-hunter actively probes the Kubernetes cluster for security weaknesses:

```bash
# Run kube-hunter in passive mode (from within the cluster)
kubectl run kube-hunter \
  --image=aquasec/kube-hunter:latest \
  --restart=Never \
  --rm \
  -it \
  -- kube-hunter --pod --report json > kube-hunter-report.json

# Analyze results
cat kube-hunter-report.json | jq '
  .vulnerabilities | sort_by(.severity) | reverse |
  map({
    severity: .severity,
    vulnerability: .vulnerability,
    description: .description,
    location: .location
  })
'

# Run from outside (network hunter)
docker run -it --rm aquasec/kube-hunter:latest \
  kube-hunter --remote <control-plane-ip> --report json

# Schedule periodic scan
```

### Periodic kube-hunter CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: kube-hunter-scan
  namespace: security
spec:
  schedule: "0 6 * * 1"  # Every Monday at 06:00 UTC
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: kube-hunter
          restartPolicy: Never
          containers:
            - name: kube-hunter
              image: aquasec/kube-hunter:latest
              command:
                - kube-hunter
                - --pod
                - --report
                - json
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 256Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-hunter
  namespace: security
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kube-hunter
rules:
  - apiGroups: [""]
    resources: ["pods", "nodes", "namespaces", "services", "endpoints"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "daemonsets"]
    verbs: ["get", "list"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["clusterroles", "clusterrolebindings"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kube-hunter
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kube-hunter
subjects:
  - kind: ServiceAccount
    name: kube-hunter
    namespace: security
```

## Complete GitHub Actions Pipeline

```yaml
# .github/workflows/security-pipeline.yml
name: Security Scanning Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: registry.example.com
  IMAGE_NAME: ${{ github.repository }}

permissions:
  contents: read
  packages: write
  id-token: write     # Required for keyless Cosign signing
  security-events: write  # Required for SARIF upload

jobs:
  build-and-scan:
    name: Build, Scan, and Sign
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - name: Build and Push Image
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Install Security Tools
        run: |
          # Install Trivy
          curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
            | sh -s -- -b /usr/local/bin v0.58.0

          # Install Syft
          curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh \
            | sh -s -- -b /usr/local/bin

          # Install Grype
          curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh \
            | sh -s -- -b /usr/local/bin

          # Install Cosign
          curl -O -L https://github.com/sigstore/cosign/releases/download/v2.4.0/cosign-linux-amd64
          chmod +x cosign-linux-amd64
          mv cosign-linux-amd64 /usr/local/bin/cosign

      - name: Run Trivy Vulnerability Scan
        run: |
          trivy image \
            --exit-code 0 \
            --severity HIGH,CRITICAL \
            --scanners vuln,secret \
            --ignore-unfixed \
            --format sarif \
            --output trivy-results.sarif \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}

      - name: Upload Trivy SARIF to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif
          category: trivy-image-scan

      - name: Fail on Critical Vulnerabilities
        run: |
          trivy image \
            --exit-code 1 \
            --severity CRITICAL \
            --ignore-unfixed \
            --scanners vuln \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}

      - name: Run Grype Scan
        run: |
          grype ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }} \
            --output sarif \
            --file grype-results.sarif \
            --only-fixed

      - name: Generate SBOM with Syft
        run: |
          syft ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }} \
            --output spdx-json \
            --file sbom.spdx.json

          syft ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }} \
            --output cyclonedx-json \
            --file sbom.cyclonedx.json

      - name: Upload SBOM Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: sbom-${{ github.sha }}
          path: |
            sbom.spdx.json
            sbom.cyclonedx.json

      - name: Sign Image with Cosign (keyless)
        if: github.event_name != 'pull_request'
        env:
          COSIGN_EXPERIMENTAL: "1"
        run: |
          cosign sign \
            --yes \
            --rekor-url https://rekor.sigstore.dev \
            --annotations "git-sha=${{ github.sha }}" \
            --annotations "workflow=${{ github.workflow }}" \
            --annotations "repository=${{ github.repository }}" \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}

      - name: Attach SBOM Attestation
        if: github.event_name != 'pull_request'
        env:
          COSIGN_EXPERIMENTAL: "1"
        run: |
          cosign attest \
            --yes \
            --predicate sbom.cyclonedx.json \
            --type cyclonedx \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}

  security-gate:
    name: Security Gate Check
    runs-on: ubuntu-latest
    needs: build-and-scan
    if: github.event_name != 'pull_request'

    steps:
      - name: Verify Image Signature
        env:
          COSIGN_EXPERIMENTAL: "1"
        run: |
          cosign verify \
            --rekor-url https://rekor.sigstore.dev \
            --certificate-identity-regexp "https://github.com/${{ github.repository }}/.*" \
            --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}

      - name: Verify SBOM Attestation
        env:
          COSIGN_EXPERIMENTAL: "1"
        run: |
          cosign verify-attestation \
            --rekor-url https://rekor.sigstore.dev \
            --type cyclonedx \
            --certificate-identity-regexp "https://github.com/${{ github.repository }}/.*" \
            --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}

          echo "Security gate passed: image is signed and SBOM is attested"
```

## Operational Runbook: Responding to Falco Alerts

```bash
#!/bin/bash
# respond-to-falco-alert.sh
# Called when Falco reports a CRITICAL event

POD_NAME="${1}"
NAMESPACE="${2}"
RULE="${3}"

echo "=== Falco Alert Response: ${RULE} ==="
echo "Pod: ${POD_NAME} / Namespace: ${NAMESPACE}"
echo "Time: $(date -u)"

# Capture current state before any action
echo "--- Pod Status ---"
kubectl describe pod "${POD_NAME}" -n "${NAMESPACE}"

echo "--- Recent Pod Logs ---"
kubectl logs "${POD_NAME}" -n "${NAMESPACE}" --tail=100 --timestamps

echo "--- Active Processes (if exec available) ---"
kubectl exec "${POD_NAME}" -n "${NAMESPACE}" -- ps auxf 2>/dev/null || true

echo "--- Network Connections ---"
kubectl exec "${POD_NAME}" -n "${NAMESPACE}" -- ss -tnp 2>/dev/null || true

# For CRITICAL events: cordon pod's node and isolate
if [[ "${RULE}" == *"CRITICAL"* ]]; then
    NODE=$(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" -o jsonpath='{.spec.nodeName}')
    echo "--- Applying NetworkPolicy Isolation ---"
    kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: isolate-${POD_NAME}
  namespace: ${NAMESPACE}
spec:
  podSelector:
    matchLabels:
      # Assumes pod has app label matching pod name prefix
      $(kubectl get pod "${POD_NAME}" -n "${NAMESPACE}" -o jsonpath='{.metadata.labels}' | jq -r 'to_entries[0] | "\(.key): \"\(.value)\""')
  policyTypes:
    - Ingress
    - Egress
EOF
    echo "Pod isolated. Investigate before removing isolation."
fi
```

## Summary

The security pipeline described here provides defense in depth across the container lifecycle. Trivy and Grype catch known CVEs at build time with complementary vulnerability databases. Syft creates a durable inventory for future auditing. Cosign provides cryptographic proof that an image passed through the authorized build pipeline. Kubernetes admission policies enforce that only signed images reach production. Falco catches what static analysis cannot: runtime attacks, container escapes, and credential access attempts.

The GitHub Actions pipeline integrates all phases into a single workflow with SARIF uploads to GitHub's security dashboard, enabling developers to see vulnerabilities in their pull request context rather than discovering them at deployment time.
