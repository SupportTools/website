---
title: "Kubescape: Kubernetes Security Posture Management and Compliance"
date: 2027-03-14T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Kubescape", "Security", "RBAC", "Compliance", "NSA/CISA"]
categories: ["Kubernetes", "Security", "Compliance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to Kubescape for Kubernetes security posture management, covering NSA/CISA and MITRE ATT&CK framework scanning, in-cluster operator mode, CI/CD integration, custom exception policies, RBAC risk scoring, and compliance reporting."
more_link: "yes"
url: "/kubescape-security-posture-management-guide/"
---

Security posture management for Kubernetes is not a one-time gate — it requires continuous scanning across the cluster, the container images, the RBAC configuration, and the network policies. Kubescape addresses this problem with a single tool that covers NSA/CISA hardening guidelines, MITRE ATT&CK for containers, SOC 2, CIS Kubernetes benchmarks, and custom organizational policies, all within a Kubernetes-native operator model.

This guide covers the full operational surface: CLI scanning, in-cluster operator deployment, CI/CD pipeline integration, exception policy management, RBAC risk scoring, and compliance report generation.

<!--more-->

## Kubescape CLI vs Operator Architecture

Kubescape operates in two modes with complementary use cases.

### CLI mode

The Kubescape CLI is a stateless binary that connects to the Kubernetes API server (or reads local YAML files) and evaluates controls against the cluster state. It is appropriate for:

- Ad-hoc cluster assessments
- Pre-commit YAML validation in developer workstations
- CI/CD pipeline gates that scan manifests before deployment
- One-shot compliance snapshots for audit purposes

```bash
# Install Kubescape CLI
curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | /bin/bash

# Scan the entire cluster against NSA/CISA framework
kubescape scan framework nsa --format pretty-printer --verbose

# Scan specific namespaces
kubescape scan framework nsa \
  --namespaces production,staging \
  --format json \
  --output nsa-report.json

# Scan a local YAML file before applying
kubescape scan deployment.yaml --format pretty-printer
```

### Operator mode

The Kubescape Operator is a Helm-deployed controller that runs continuously inside the cluster. It:

- Schedules periodic scans via CronJobs
- Stores results as Kubernetes CRDs (`WorkloadConfigurationScan`, `VulnerabilityManifest`, etc.)
- Exposes Prometheus metrics for continuous posture monitoring
- Integrates with the Kubescape SaaS dashboard (optional) or runs fully air-gapped

The operator is the recommended mode for production clusters where continuous compliance visibility is required.

## Installing the Kubescape Operator

```bash
# Add the Kubescape Helm repository
helm repo add kubescape https://kubescape.github.io/helm-charts/
helm repo update

# Create the namespace
kubectl create namespace kubescape

# Install with production values
helm upgrade --install kubescape kubescape/kubescape-operator \
  --namespace kubescape \
  --version 1.21.0 \
  --values kubescape-values.yaml \
  --wait
```

### Production Helm values

```yaml
# kubescape-values.yaml

# Global settings
global:
  # Set to your cluster name for multi-cluster reporting
  clusterName: "prod-us-east-1"
  # Image pull policy for air-gapped environments
  imagePullPolicy: IfNotPresent

# Kubescape scanner configuration
kubescape:
  enabled: true
  resources:
    requests:
      cpu: 150m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  # Frameworks to scan — can include multiple
  frameworks:
    - name: NSA
    - name: MITRE
    - name: CIS-v1.24
  # Scan schedule — 2:00 AM UTC daily
  schedule: "0 2 * * *"
  # Severity threshold — only report controls at or above this level
  submitReport: true
  # Fail-safe: do not fail the operator if scan encounters an error
  failThreshold: 0

# Kubevuln — container image vulnerability scanner
kubevuln:
  enabled: true
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  # Scan on every new pod start (image push detection)
  scanNewDeployment: true
  # SBOM generation
  createSBOM: true
  # CVE database update schedule
  schedule: "0 6 * * *"

# Storage — keeps scan results as CRDs
storage:
  enabled: true
  resources:
    requests:
      cpu: 50m
      memory: 100Mi
    limits:
      cpu: 200m
      memory: 256Mi

# Prometheus metrics
prometheus:
  enabled: true
  serviceMonitor:
    enabled: true
    namespace: monitoring
    labels:
      release: kube-prometheus-stack

# Node agent for runtime threat detection
nodeAgent:
  enabled: true
  resources:
    requests:
      cpu: 100m
      memory: 180Mi
    limits:
      cpu: 500m
      memory: 512Mi

# RBAC configuration
rbac:
  # Allow Kubescape to read all resources for scanning
  clusterReader: true
```

## NSA/CISA Kubernetes Hardening Framework

The NSA/CISA Kubernetes Hardening Guidance document defines controls across authentication, authorization, network, pod security, and supply chain categories. Kubescape maps each recommendation to a specific control ID.

### High-priority NSA/CISA controls

| Control ID | Name | Category | Default Severity |
|---|---|---|---|
| C-0001 | Forbidden Container Registries | Supply chain | Critical |
| C-0007 | Data Destruction | Pod security | High |
| C-0009 | Resource Policies | Availability | Medium |
| C-0016 | Allow Privilege Escalation | Pod security | High |
| C-0017 | Immutable Container Filesystem | Pod security | Medium |
| C-0021 | Ingress and Egress Blocked | Network | Medium |
| C-0026 | Kubernetes CronJob | Workload hygiene | Low |
| C-0030 | Ingress and Egress Blocked | Network | Medium |
| C-0034 | Automatic Mapping of Service Account | RBAC | Medium |
| C-0035 | Cluster-admin Binding | RBAC | Critical |
| C-0041 | HostNetwork Access | Pod security | High |
| C-0044 | Container Hostport | Network | Low |
| C-0045 | Writable HostPath Mount | Pod security | Critical |
| C-0046 | Insecure Capabilities | Pod security | Medium |
| C-0048 | HostPath Mount | Pod security | Medium |
| C-0050 | Resources CPU Limit and Request | Availability | Low |
| C-0055 | Linux Hardening | Pod security | Medium |
| C-0057 | Privileged Container | Pod security | Critical |
| C-0058 | Impersonation Permissions | RBAC | High |
| C-0065 | No Impersonation | RBAC | Medium |

### Running a targeted NSA scan

```bash
# Scan only NSA controls in the production namespace
kubescape scan framework nsa \
  --namespaces production \
  --format json \
  --output /tmp/nsa-prod-$(date +%Y%m%d).json \
  --verbose

# Scan a specific control
kubescape scan control C-0035 \
  --namespaces production \
  --format pretty-printer

# Scan from a local YAML file without cluster access
kubescape scan framework nsa \
  --local \
  --input-dir ./manifests/production/ \
  --format junit \
  --output nsa-junit.xml
```

## MITRE ATT&CK for Containers Framework

The MITRE ATT&CK framework maps adversary tactics and techniques to Kubernetes-specific attack paths. Kubescape evaluates controls corresponding to each MITRE technique.

### MITRE tactics coverage in Kubescape

```
Initial Access:
  - C-0002: External-facing service exposed (no NetworkPolicy ingress restriction)
  - C-0021: Missing network policies (lateral movement risk)

Execution:
  - C-0016: Allow privilege escalation (enables exec escape chains)
  - C-0057: Privileged container (full host access)
  - C-0044: Container HostPort binding

Persistence:
  - C-0045: Writable HostPath mount
  - C-0048: HostPath mount (any)
  - C-0034: Auto-mounted service account tokens

Privilege Escalation:
  - C-0035: Cluster-admin ClusterRoleBinding
  - C-0058: Impersonation permissions in RBAC roles
  - C-0007: Exec into containers permission

Defense Evasion:
  - C-0017: Mutable container filesystem

Credential Access:
  - C-0012: Secret access in RBAC (get/list/watch on secrets)
  - C-0015: List Kubernetes secrets

Lateral Movement:
  - C-0041: HostNetwork access (access to host network stack)
  - C-0056: Unsafe sysctls

Impact:
  - C-0009: Missing CPU/memory limits (resource exhaustion)
  - C-0001: Container from untrusted registry (supply chain attack)
```

```bash
# Scan MITRE framework
kubescape scan framework mitre \
  --namespaces production,staging \
  --format json \
  --output /tmp/mitre-$(date +%Y%m%d).json

# Generate human-readable summary
kubescape scan framework mitre \
  --namespaces production \
  --format pretty-printer \
  --verbose 2>&1 | tee /tmp/mitre-report.txt
```

## Exception Policies

Exception policies suppress false positives or accepted risks. They are stored as `PostureExceptionPolicy` CRDs.

### Namespace-scoped exception

```yaml
# exception-kube-system.yaml
# Suppress C-0034 (auto-mounted service accounts) for system components
# that legitimately require the default service account token
apiVersion: softwarecomposition.kubescape.io/v1beta1
kind: PostureExceptionPolicy
metadata:
  name: kube-system-sa-token-exception
  namespace: kubescape
spec:
  reason: "kube-system components require service account tokens for API access"
  subject:
    - apiGroups: [""]
      namespaces: ["kube-system"]
      kinds: ["Pod"]
  vulnerabilities:
    - category: "postureExceptions"
      controlIDs: ["C-0034"]
```

### Workload-specific exception with expiry

```yaml
# exception-legacy-app.yaml
# Temporary exception for a legacy application pending security remediation
# Expires 2027-06-01
apiVersion: softwarecomposition.kubescape.io/v1beta1
kind: PostureExceptionPolicy
metadata:
  name: legacy-payments-privilege-escalation-exception
  namespace: kubescape
  annotations:
    # Annotation for audit trail — not enforced by Kubescape
    kubescape.io/expiry: "2027-06-01"
    kubescape.io/ticket: "SEC-4821"
    kubescape.io/approved-by: "security-team@example.com"
spec:
  reason: "Legacy payments service requires allowPrivilegeEscalation pending PCI remediation (SEC-4821)"
  subject:
    - apiGroups: ["apps"]
      namespaces: ["production"]
      kinds: ["Deployment"]
      names: ["payments-legacy"]
  vulnerabilities:
    - category: "postureExceptions"
      controlIDs: ["C-0016"]
```

### Cluster-wide exception for a registry allowlist

```yaml
# exception-registry-allowlist.yaml
# Allow images from the internal registry without triggering C-0001
apiVersion: softwarecomposition.kubescape.io/v1beta1
kind: PostureExceptionPolicy
metadata:
  name: internal-registry-allowlist
  namespace: kubescape
spec:
  reason: "Internal registry registry.example.com is approved and scanned by Trivy"
  subject:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
  vulnerabilities:
    - category: "postureExceptions"
      controlIDs: ["C-0001"]
      images:
        - "registry.example.com/*"
```

## CI/CD Integration

### GitHub Actions pipeline gate

```yaml
# .github/workflows/kubescape-scan.yaml
name: Kubescape Security Scan

on:
  pull_request:
    paths:
      - 'deploy/kubernetes/**'
      - 'helm/**'
  push:
    branches:
      - main

jobs:
  kubescape-scan:
    name: Scan Kubernetes Manifests
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write    # required for SARIF upload

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Install Kubescape
        run: |
          # Install the Kubescape CLI binary
          curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | /bin/bash
          echo "$HOME/.kubescape/bin" >> "$GITHUB_PATH"

      - name: Run NSA framework scan
        run: |
          # Scan manifests in the deploy directory
          kubescape scan framework nsa \
            --local \
            --input-dir ./deploy/kubernetes/ \
            --format sarif \
            --output kubescape-nsa.sarif \
            --fail-threshold 80    # fail if compliance score below 80%

      - name: Upload SARIF results to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: kubescape-nsa.sarif
          category: kubescape-nsa

      - name: Run MITRE ATT&CK scan
        run: |
          kubescape scan framework mitre \
            --local \
            --input-dir ./deploy/kubernetes/ \
            --format junit \
            --output kubescape-mitre-junit.xml \
            --fail-threshold 75

      - name: Publish JUnit test results
        uses: dorny/test-reporter@v1
        if: always()
        with:
          name: Kubescape MITRE Results
          path: kubescape-mitre-junit.xml
          reporter: java-junit
```

### GitLab CI integration

```yaml
# .gitlab-ci.yml (kubescape stage excerpt)
kubescape-scan:
  stage: security
  image: ubuntu:22.04
  before_script:
    - apt-get update -qq && apt-get install -y -qq curl
    # Install Kubescape CLI
    - curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | /bin/bash
    - export PATH="$HOME/.kubescape/bin:$PATH"
  script:
    # Scan Helm-rendered manifests
    - helm template myapp ./helm/myapp -f helm/myapp/values-production.yaml > /tmp/rendered.yaml
    - kubescape scan framework nsa
        --local
        --input-file /tmp/rendered.yaml
        --format json
        --output kubescape-report.json
        --fail-threshold 80
    # Convert to JUnit for GitLab test results widget
    - kubescape scan framework nsa
        --local
        --input-file /tmp/rendered.yaml
        --format junit
        --output kubescape-junit.xml
  artifacts:
    when: always
    paths:
      - kubescape-report.json
      - kubescape-junit.xml
    reports:
      junit: kubescape-junit.xml
  rules:
    - changes:
        - helm/**
        - deploy/**
```

## RBAC Risk Scoring

Kubescape scores RBAC configurations based on permissions that enable lateral movement, privilege escalation, and credential theft. The scoring uses a weighted model considering:

- Verb sensitivity (create/update/delete > get/list/watch)
- Resource criticality (secrets, clusterroles, pods/exec)
- Scope (cluster-wide vs namespace-scoped)

### Scanning RBAC configuration

```bash
# Scan RBAC controls specifically
kubescape scan control C-0035,C-0058,C-0007,C-0012,C-0015,C-0065 \
  --format json \
  --output rbac-risk-report.json

# Generate RBAC-focused HTML report
kubescape scan framework nsa \
  --format html \
  --output rbac-posture.html \
  --verbose
```

### WorkloadConfigurationScan CRD (operator mode)

When the operator runs, it stores results in `WorkloadConfigurationScan` objects. These can be queried directly:

```bash
# List all workload scan results in production
kubectl get workloadconfigurationscans -n production

# Get detailed results for a specific deployment
kubectl get workloadconfigurationscan -n production deployments-nginx-ingress-controller \
  -o jsonpath='{.spec.controls}' | jq '
    to_entries |
    map(select(.value.status.status == "failed")) |
    map({controlID: .key, name: .value.name, severity: .value.severity.severity})
  '

# Find all failed critical controls across the cluster
kubectl get workloadconfigurationscans -A \
  -o json | jq '
    [.items[] |
      {
        namespace: .metadata.namespace,
        name: .metadata.name,
        criticalFailures: [
          .spec.controls | to_entries[] |
          select(.value.status.status == "failed" and .value.severity.severity == "Critical") |
          .value.name
        ]
      } |
      select(.criticalFailures | length > 0)
    ]
  '
```

## Network Policy Coverage Gap Detection

Kubescape identifies workloads that lack ingress or egress NetworkPolicy coverage — a common misconfiguration that allows unconstrained lateral movement.

### Control C-0260: Missing NetworkPolicy

```bash
# Check network policy coverage
kubescape scan control C-0260 \
  --namespaces production,staging \
  --format json \
  --output network-policy-gaps.json

# Parse the output to find unprotected workloads
python3 << 'PYEOF'
import json

with open('network-policy-gaps.json') as f:
    report = json.load(f)

for result in report.get('results', []):
    for resource in result.get('resourcesWithInconsistencies', []):
        namespace = resource.get('object', {}).get('namespace', 'unknown')
        name = resource.get('object', {}).get('name', 'unknown')
        kind = resource.get('object', {}).get('kind', 'unknown')
        print(f"UNPROTECTED: {kind}/{namespace}/{name}")
PYEOF
```

### Generating a NetworkPolicy skeleton for unprotected workloads

```bash
# Use Kubescape to suggest network policies
kubescape scan control C-0260 \
  --namespaces production \
  --format json \
  --output /tmp/np-gaps.json

# Generate baseline deny-all policies for flagged namespaces
for ns in production staging; do
  kubectl apply -f - << NETPOL
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: ${ns}
spec:
  podSelector: {}    # applies to all pods in namespace
  policyTypes:
    - Ingress
    - Egress
NETPOL
done
```

## Remediation Priority Workflow

Kubescape outputs a risk score per control. A structured remediation workflow ensures the highest-impact issues are addressed first.

### Risk prioritization script

```python
#!/usr/bin/env python3
# remediation-priority.py — parse Kubescape JSON output and prioritize remediation

import json
import sys
from dataclasses import dataclass
from typing import List

SEVERITY_WEIGHT = {
    "Critical": 100,
    "High": 70,
    "Medium": 40,
    "Low": 10,
}

@dataclass
class ControlResult:
    control_id: str
    name: str
    severity: str
    failed_resources: int
    total_resources: int

    @property
    def failure_rate(self) -> float:
        if self.total_resources == 0:
            return 0.0
        return self.failed_resources / self.total_resources

    @property
    def risk_score(self) -> float:
        weight = SEVERITY_WEIGHT.get(self.severity, 0)
        return weight * self.failure_rate * (1 + self.failed_resources / 10)

def parse_report(path: str) -> List[ControlResult]:
    with open(path) as f:
        data = json.load(f)

    results = []
    for summary in data.get('summaryDetails', {}).get('controls', {}).values():
        status_info = summary.get('statusInfo', {})
        failed = status_info.get('numberOfFailed', 0)
        passed = status_info.get('numberOfPassed', 0)
        total = failed + passed

        results.append(ControlResult(
            control_id=summary.get('controlID', 'unknown'),
            name=summary.get('name', 'unknown'),
            severity=summary.get('scoreFactor', {}).get('baseScore', 'Low'),
            failed_resources=failed,
            total_resources=total,
        ))

    return sorted(results, key=lambda r: r.risk_score, reverse=True)

if __name__ == '__main__':
    report_path = sys.argv[1] if len(sys.argv) > 1 else 'nsa-report.json'
    controls = parse_report(report_path)

    print(f"{'Control ID':<12} {'Severity':<10} {'Failed':<8} {'Total':<8} {'RiskScore':<10} Name")
    print("-" * 80)
    for c in controls[:20]:   # show top 20 highest-risk controls
        print(
            f"{c.control_id:<12} {c.severity:<10} "
            f"{c.failed_resources:<8} {c.total_resources:<8} "
            f"{c.risk_score:<10.1f} {c.name}"
        )
```

### Running the prioritization workflow

```bash
# 1. Generate the scan report
kubescape scan framework nsa \
  --namespaces production \
  --format json \
  --output /tmp/nsa-report.json

# 2. Run the prioritization script
python3 remediation-priority.py /tmp/nsa-report.json

# 3. Generate fix suggestions for top control
kubescape scan control C-0057 \
  --namespaces production \
  --format pretty-printer \
  --verbose 2>&1 | grep -A5 "FAILED"
```

## Prometheus Metrics from Kubescape Operator

The Kubescape operator exposes Prometheus metrics for continuous posture monitoring.

### Key metrics

| Metric | Type | Description |
|---|---|---|
| `kubescape_controls_total` | Gauge | Total controls evaluated per scan |
| `kubescape_controls_passed_total` | Gauge | Passed controls count |
| `kubescape_controls_failed_total` | Gauge | Failed controls count by severity |
| `kubescape_cluster_compliance_score` | Gauge | Overall compliance score 0-100 |
| `kubescape_vulnerabilities_total` | Gauge | CVE count by severity per workload |
| `kubescape_scan_duration_seconds` | Histogram | Time to complete a scan |

### Prometheus alerting rules

```yaml
# kubescape-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubescape-posture-alerts
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: kubescape-posture
      interval: 60s
      rules:
        # Alert when compliance score drops below 70%
        - alert: KubescapeComplianceScoreLow
          expr: kubescape_cluster_compliance_score < 70
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Cluster compliance score below 70% ({{ $value | humanizePercentage }})"
            description: "The Kubescape compliance score for cluster {{ $labels.cluster_name }} has dropped to {{ $value }}. Investigate new deployments for policy violations."

        # Alert when critical control failures increase
        - alert: KubescapeCriticalControlFailures
          expr: |
            increase(kubescape_controls_failed_total{severity="Critical"}[1h]) > 0
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "New critical Kubescape control failures detected"
            description: "{{ $value }} new critical control failures detected in the last hour. Review recent deployments."

        # Alert on new critical CVEs
        - alert: KubescapeCriticalCVEsDetected
          expr: |
            kubescape_vulnerabilities_total{severity="Critical"} > 0
          for: 0m
          labels:
            severity: high
          annotations:
            summary: "Critical CVEs detected in workload {{ $labels.workload_name }}"
            description: "{{ $value }} critical CVEs found in {{ $labels.namespace }}/{{ $labels.workload_name }}"
```

## Compliance Report Generation

### Generating a full compliance report

```bash
# Generate HTML compliance report for SOC 2 review
kubescape scan framework nsa,mitre \
  --namespaces production,staging,kube-system \
  --format html \
  --output compliance-report-$(date +%Y%m%d).html \
  --verbose

# Generate JSON report for programmatic processing
kubescape scan framework nsa \
  --namespaces production \
  --format json \
  --output /tmp/compliance-$(date +%Y%m%d).json

# Upload to S3 for audit archive
aws s3 cp /tmp/compliance-$(date +%Y%m%d).json \
  s3://audit-reports/kubescape/$(date +%Y/%m)/compliance-$(date +%Y%m%d).json \
  --server-side-encryption AES256
```

### Automated compliance snapshot via CronJob

```yaml
# kubescape-compliance-snapshot.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: kubescape-compliance-snapshot
  namespace: kubescape
spec:
  schedule: "0 1 * * 1"      # Every Monday at 1:00 AM UTC
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: kubescape-compliance-sa
          restartPolicy: OnFailure
          containers:
            - name: kubescape-reporter
              image: kubescape/kubescape:v3.0.0
              command: [sh, -c]
              args:
                - |
                  # Run NSA and MITRE scans
                  DATE=$(date +%Y%m%d)
                  kubescape scan framework nsa,mitre \
                    --format json \
                    --output /tmp/report-${DATE}.json \
                    --submit false

                  # Upload to S3
                  aws s3 cp /tmp/report-${DATE}.json \
                    "s3://audit-reports/kubescape/${DATE}/report.json" \
                    --server-side-encryption AES256

                  echo "Compliance snapshot saved to s3://audit-reports/kubescape/${DATE}/report.json"
              env:
                - name: AWS_ACCESS_KEY_ID
                  valueFrom:
                    secretKeyRef:
                      name: aws-audit-credentials
                      key: access-key-id
                - name: AWS_SECRET_ACCESS_KEY
                  valueFrom:
                    secretKeyRef:
                      name: aws-audit-credentials
                      key: secret-access-key
                - name: AWS_DEFAULT_REGION
                  value: us-east-1
              resources:
                requests:
                  cpu: 200m
                  memory: 256Mi
                limits:
                  cpu: 500m
                  memory: 512Mi
```

## Summary

Kubescape provides a comprehensive, Kubernetes-native security posture management platform. The key operational decisions for production adoption are:

1. Deploy the in-cluster operator for continuous monitoring — CLI scans are suitable for CI/CD gates but do not provide ongoing visibility
2. Start with NSA/CISA framework scans and address Critical and High controls first using the risk-weighted prioritization approach
3. Use exception policies with audit trail annotations (`kubescape.io/ticket`, `kubescape.io/expiry`) to manage accepted risks without suppressing visibility
4. Integrate SARIF output into GitHub Advanced Security or GitLab Security Dashboard to give developers actionable feedback in their pull request workflow
5. Set Prometheus alerts on `kubescape_cluster_compliance_score` to detect regression from new deployments
6. Schedule weekly compliance snapshots to S3 for audit trail and trend analysis across releases
