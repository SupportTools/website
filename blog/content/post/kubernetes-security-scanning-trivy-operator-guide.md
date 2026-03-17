---
title: "Kubernetes Security Scanning: Trivy Operator for Continuous Vulnerability Management"
date: 2028-01-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Trivy", "Vulnerability Scanning", "Compliance", "OPA", "DevSecOps"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes security scanning with the Trivy Operator covering VulnerabilityReport CRD, ConfigAuditReport, ExposedSecretReport, RBAC scanning, CIS benchmarks, OPA policy enforcement, scheduled scanning, and Grafana dashboards for security findings."
more_link: "yes"
url: "/kubernetes-security-scanning-trivy-operator-guide/"
---

Security scanning in Kubernetes must operate continuously, not just at build time. Container images pulled weeks ago may contain newly discovered CVEs. Workload configurations that were compliant at deployment may drift from policy. Secrets accidentally committed to container images or ConfigMaps persist indefinitely. The Trivy Operator addresses these requirements by running as a Kubernetes controller that continuously scans workloads, publishes findings as custom resources, and integrates with Prometheus for alerting. This guide covers the complete deployment and configuration of the Trivy Operator, from initial installation through policy-based blocking with OPA and executive-level reporting dashboards.

<!--more-->

# Kubernetes Security Scanning: Trivy Operator for Continuous Vulnerability Management

## Section 1: Trivy Operator Architecture

The Trivy Operator watches Kubernetes resources and creates scan jobs when they change. Scan results are stored as Custom Resources (CRDs) in the cluster, making them queryable with standard kubectl commands and scrapable by Prometheus.

```
┌──────────────────────────────────────────────────────────┐
│                  Kubernetes Cluster                       │
│                                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │           Trivy Operator (Deployment)            │   │
│  │                                                  │   │
│  │  Watches: Pods, Deployments, StatefulSets,       │   │
│  │           DaemonSets, Jobs, CronJobs             │   │
│  │                                                  │   │
│  │  Triggers scan jobs on:                          │   │
│  │  - New/updated workloads                         │   │
│  │  - Scheduled scans                               │   │
│  │  - CRD creation                                  │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                                 │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │  Scan Jobs (short-lived, ephemeral)              │   │
│  │  - Pull image and run trivy scanner              │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                                 │
│  ┌──────────────────────▼───────────────────────────┐   │
│  │  CRD Scan Reports                                │   │
│  │  - VulnerabilityReport                           │   │
│  │  - ConfigAuditReport                             │   │
│  │  - ExposedSecretReport                           │   │
│  │  - RbacAssessmentReport                         │   │
│  │  - InfraAssessmentReport                        │   │
│  │  - ClusterComplianceReport                      │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### CRD Reference

| CRD | Scope | What It Scans |
|-----|-------|---------------|
| `VulnerabilityReport` | Namespace | Container image CVEs |
| `ConfigAuditReport` | Namespace | Kubernetes resource misconfigurations |
| `ExposedSecretReport` | Namespace | Secrets embedded in container images |
| `RbacAssessmentReport` | Namespace | RBAC roles and bindings |
| `InfraAssessmentReport` | Namespace | Infrastructure configuration |
| `ClusterVulnerabilityReport` | Cluster | Node-level vulnerabilities |
| `ClusterConfigAuditReport` | Cluster | Cluster-scoped resources |
| `ClusterComplianceReport` | Cluster | CIS, NSA benchmarks |
| `ClusterInfraAssessmentReport` | Cluster | Infrastructure assessment |

## Section 2: Installing the Trivy Operator

### Helm Installation

```bash
helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm repo update

helm install trivy-operator aqua/trivy-operator \
  --namespace trivy-system \
  --create-namespace \
  --version 0.21.0 \
  --values trivy-operator-values.yaml
```

```yaml
# trivy-operator-values.yaml
trivy:
  # Use a specific version to prevent scan result drift
  imageTag: "0.48.0"

  # Scan severity filter (include only these severities)
  severity: UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL

  # Timeout for each scan job
  timeout: "5m0s"

  # Enable Java vulnerability scanning
  javaDbRepositoryInsecure: false

  # Offline mode: use pre-downloaded DB
  offlineScan: false

  # Image scanning skip list (known false positives or approved exceptions)
  skipFiles:
  - "/path/to/false-positive/file"

  ignoreUnfixed: true  # Only report vulnerabilities with available fixes

operator:
  # Scan all namespaces except system ones
  targetNamespaces: "production,staging,development"
  excludeNamespaces: "kube-system,trivy-system,cert-manager"

  # Enable all scan types
  vulnerabilityScannerEnabled: true
  configAuditScannerEnabled: true
  secretScannerEnabled: true
  rbacAssessmentScannerEnabled: true
  infraAssessmentScannerEnabled: true
  clusterComplianceEnabled: true

  # Scan on schedule (in addition to on-change scans)
  scanJobTTL: "24h"

  # Resource limits for scan jobs
  scanJobCPURequest: "100m"
  scanJobCPULimit: "500m"
  scanJobMemoryRequest: "100M"
  scanJobMemoryLimit: "500M"

  # How often to rescan unchanged workloads
  scanJobConcurrentScanJobsLimit: "10"

  # Metrics
  metricsVulnIdEnabled: true

serviceMonitor:
  enabled: true
  namespace: monitoring

# Private registry credentials
registryServer: "registry.internal.example.com"
registryUsername: ""  # Use a secret reference
registryPassword: ""

# Compliance reports
compliance:
  # Available: nsa, cis, pss-restricted, pss-baseline
  specs:
  - nsa
  - cis
```

### Private Registry Configuration

```bash
# Create registry credentials secret
kubectl create secret docker-registry trivy-operator-registry-creds \
  --docker-server=registry.internal.example.com \
  --docker-username=trivy-scanner \
  --docker-password=<scanner-token> \
  --namespace trivy-system

# Reference in Helm values
# trivy.imagePullSecret: trivy-operator-registry-creds
```

## Section 3: VulnerabilityReport CRD

### Understanding Vulnerability Reports

```bash
# List all vulnerability reports in a namespace
kubectl get vulnerabilityreports -n production

# Show a specific report
kubectl get vulnerabilityreport \
  replicaset-api-server-abc123-api-server \
  -n production \
  -o yaml

# Count vulnerabilities by severity
kubectl get vulnerabilityreports -n production -o json | \
  jq '[.items[].report.summary] | {
    total: length,
    critical: [.[].criticalCount] | add,
    high: [.[].highCount] | add,
    medium: [.[].mediumCount] | add,
    low: [.[].lowCount] | add
  }'
```

Sample VulnerabilityReport output:

```yaml
apiVersion: aquasecurity.github.io/v1alpha1
kind: VulnerabilityReport
metadata:
  name: replicaset-api-server-abc123-api-server
  namespace: production
  labels:
    trivy-operator.resource.kind: ReplicaSet
    trivy-operator.resource.name: api-server-abc123
    trivy-operator.resource.namespace: production
    trivy-operator.container.name: api-server
spec:
  scanner:
    name: Trivy
    vendor: Aqua Security
    version: "0.48.0"
  registry:
    server: registry.internal.example.com
  artifact:
    repository: api-server
    digest: sha256:abc123def456...
    tag: "2.1.0"
  summary:
    criticalCount: 2
    highCount: 8
    mediumCount: 23
    lowCount: 45
    unknownCount: 1
  vulnerabilities:
  - vulnerabilityID: CVE-2023-44487
    resource: golang.org/x/net
    installedVersion: "0.14.0"
    fixedVersion: "0.17.0"
    severity: HIGH
    score: 7.5
    title: "HTTP/2 rapid reset attack (CONTINUATION flood)"
    description: "..."
    primaryLink: "https://nvd.nist.gov/vuln/detail/CVE-2023-44487"
    links:
    - "https://github.com/golang/x/net/issues/..."
    target: "Go"
    class: "lang-pkgs"
```

### Querying Reports for Remediation

```bash
#!/bin/bash
# vulnerability-report.sh
# Generate a remediation report for all CRITICAL vulnerabilities

NAMESPACE="${1:-production}"

echo "=== Critical Vulnerability Report: ${NAMESPACE} ==="
echo ""

kubectl get vulnerabilityreports -n "${NAMESPACE}" -o json | \
  jq -r '
    .items[] |
    .metadata.name as $report |
    .metadata.labels["trivy-operator.resource.name"] as $workload |
    .metadata.labels["trivy-operator.container.name"] as $container |
    .spec.artifact.tag as $tag |
    .report.vulnerabilities[]? |
    select(.severity == "CRITICAL") |
    {
      workload: $workload,
      container: $container,
      image_tag: $tag,
      cve_id: .vulnerabilityID,
      package: .resource,
      installed: .installedVersion,
      fixed_in: .fixedVersion,
      title: .title
    }
  ' | \
  jq -r '[.workload, .container, .cve_id, .package, .installed, .fixed_in] | @tsv' | \
  sort | uniq | \
  column -t -s $'\t'
```

## Section 4: ConfigAuditReport

ConfigAuditReport scans Kubernetes resource configurations against security best practices.

### Interpreting Config Audit Reports

```bash
# List config audit reports
kubectl get configauditreports -n production -o wide

# Get a specific report
kubectl describe configauditreport \
  replicaset-api-server-abc123 \
  -n production

# Find all failing checks
kubectl get configauditreports -n production -o json | \
  jq '
    .items[] |
    .metadata.name as $report |
    .report.checks[]? |
    select(.success == false) |
    {
      report: $report,
      checkID: .checkID,
      title: .title,
      severity: .severity,
      category: .category,
      description: .description
    }
  ' | jq -r '[.severity, .checkID, .title, .report] | @tsv' | \
  sort | column -t -s $'\t'
```

Sample ConfigAuditReport:

```yaml
apiVersion: aquasecurity.github.io/v1alpha1
kind: ConfigAuditReport
metadata:
  name: replicaset-api-server-abc123
  namespace: production
report:
  checks:
  - checkID: KSV001
    title: "Process can elevate its own privileges"
    description: "Security context should have allowPrivilegeEscalation=false"
    severity: MEDIUM
    success: false
    remediation: "Set allowPrivilegeEscalation=false in the container securityContext"
    category: "Security"

  - checkID: KSV003
    title: "Default capabilities not dropped"
    description: "Containers should drop ALL capabilities"
    severity: LOW
    success: false
    remediation: "Set capabilities.drop=[ALL] in the container securityContext"

  - checkID: KSV011
    title: "CPU not limited"
    description: "Enforcing CPU limits prevents DoS via CPU starvation"
    severity: LOW
    success: false
    remediation: "Set resources.limits.cpu"

  - checkID: KSV014
    title: "Root filesystem not read-only"
    description: "Set readOnlyRootFilesystem=true"
    severity: LOW
    success: false

  - checkID: KSV104
    title: "Seccomp profile not set"
    description: "Set seccomp profile to RuntimeDefault or Localhost"
    severity: MEDIUM
    success: false

  summary:
    criticalCount: 0
    highCount: 1
    mediumCount: 8
    lowCount: 12
```

## Section 5: ExposedSecretReport

The ExposedSecretReport scans container image layers for embedded secrets.

```bash
# List exposed secret reports
kubectl get exposedSecretReports -n production

# Detailed view
kubectl get exposedSecretReport \
  replicaset-api-server-abc123-api-server \
  -n production \
  -o json | \
  jq '.report.secrets[]? | {
    target: .target,
    ruleID: .ruleID,
    title: .title,
    severity: .severity,
    match: .match
  }'
```

Sample finding:
```yaml
secrets:
- target: "app/config/database.yaml"
  ruleID: "aws-access-key-id"
  title: "AWS Access Key ID"
  category: "AWS"
  severity: CRITICAL
  match: "EXAMPLEAWSACCESSKEY123"  # Matches are redacted in real output

- target: ".env"
  ruleID: "private-key"
  title: "RSA Private Key"
  category: "Asymmetric Private Key"
  severity: CRITICAL
```

## Section 6: RBAC Assessment Reports

```bash
# List RBAC assessment reports
kubectl get rbacAssessmentReports -n production

# Find dangerous RBAC bindings
kubectl get rbacAssessmentReports -n production -o json | \
  jq '
    .items[] |
    .report.checks[]? |
    select(.success == false and .severity == "HIGH") |
    {
      subject: .subjects,
      checkID: .checkID,
      title: .title,
      description: .description
    }
  '
```

Common RBAC findings:

```yaml
checks:
- checkID: KSV041
  title: "Manages secrets"
  description: "ServiceAccount has GET/LIST/WATCH permissions on secrets"
  severity: HIGH
  success: false
  subjects:
  - kind: ServiceAccount
    name: api-server
    namespace: production

- checkID: KSV044
  title: "Can impersonate users/groups/serviceaccounts"
  description: "RBAC role allows impersonation"
  severity: CRITICAL
  success: false
```

## Section 7: CIS Benchmarks via ClusterComplianceReport

```bash
# List compliance reports
kubectl get clustercompliancereports

# Get CIS benchmark results
kubectl get clustercompliancereport cis -o yaml | \
  jq '.status.summaryReport | {
    passed: .summaryControls.passCount,
    failed: .summaryControls.failCount,
    total: .summaryControls.totalCount,
    pass_rate: ((.summaryControls.passCount / .summaryControls.totalCount) * 100 | round)
  }'

# Get failed CIS controls
kubectl get clustercompliancereport cis -o json | \
  jq '
    .status.detailReport.results[]? |
    select(.checks[]?.success == false) |
    {
      id: .id,
      name: .name,
      description: .description,
      severity: .severity,
      failed_checks: [.checks[] | select(.success == false) | .id]
    }
  '
```

## Section 8: Policy-Based Blocking with OPA and Trivy

Combining Trivy scan results with OPA Gatekeeper constraints allows blocking deployments that have known critical vulnerabilities.

### OPA ConstraintTemplate for Vulnerability Blocking

```yaml
# vulnerability-constraint-template.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8sblockvulnerabilities
spec:
  crd:
    spec:
      names:
        kind: K8sBlockVulnerabilities
      validation:
        openAPIV3Schema:
          type: object
          properties:
            severityThreshold:
              type: string
              enum: [CRITICAL, HIGH, MEDIUM, LOW]
            maxCriticalVulnerabilities:
              type: integer
            maxHighVulnerabilities:
              type: integer
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8sblockvulnerabilities

      import future.keywords.if
      import future.keywords.in

      violation[{"msg": msg}] if {
          # Get the pod spec
          container := input.review.object.spec.containers[_]
          image := container.image

          # Look up VulnerabilityReport for this image
          report := data.inventory.namespace[input.review.object.metadata.namespace]["aquasecurity.github.io/v1alpha1"]["VulnerabilityReport"][_]
          report.spec.artifact.tag == image

          # Check critical vulnerability count
          criticals := report.report.summary.criticalCount
          max_critical := object.get(input.parameters, "maxCriticalVulnerabilities", 0)

          criticals > max_critical

          msg := sprintf(
              "Container '%s' uses image '%s' with %d critical vulnerabilities (max: %d)",
              [container.name, image, criticals, max_critical]
          )
      }
```

```yaml
# vulnerability-constraint.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sBlockVulnerabilities
metadata:
  name: block-critical-vulnerabilities
spec:
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
    - production
  enforcementAction: deny  # Use warn for soft enforcement
  parameters:
    severityThreshold: CRITICAL
    maxCriticalVulnerabilities: 0
    maxHighVulnerabilities: 5
```

### Kyverno Policy for Image Scanning Gate

Kyverno offers a more concise policy language for simple scanning gates:

```yaml
# kyverno-vulnerability-policy.yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: check-vulnerability-reports
spec:
  validationFailureAction: Enforce
  background: false
  rules:
  - name: check-image-vulnerabilities
    match:
      any:
      - resources:
          kinds: ["Pod"]
          namespaces: ["production"]
    preconditions:
      all:
      - key: "{{ request.operation || 'BACKGROUND' }}"
        operator: AnyIn
        value: ["CREATE", "UPDATE"]
    validate:
      message: |
        Container '{{ element.name }}' uses image '{{ element.image }}' which has
        {{ count(images.*.*.vulnerabilities[?severity == 'CRITICAL'][]) }} critical vulnerabilities.
        Deploy to staging first and remediate critical CVEs.
      foreach:
      - list: "request.object.spec.containers"
        context:
        - name: images
          apiCall:
            method: GET
            urlPath: "/apis/aquasecurity.github.io/v1alpha1/namespaces/production/vulnerabilityreports"
            jmesPath: |
              items[?spec.artifact.tag == '{{ element.image }}'] | [0]
        deny:
          conditions:
            all:
            - key: "{{ images.report.summary.criticalCount || `0` }}"
              operator: GreaterThan
              value: "0"
```

## Section 9: Scheduled Scanning

### Configuring Scan Frequency

```yaml
# trivy-operator-scheduling.yaml
# In the trivy-operator Helm values
operator:
  # Scan resources that haven't been scanned in X hours
  scanJobTTL: "24h"

  # Configure node collector for infrastructure scans
  nodeCollectorImageRef: "ghcr.io/aquasecurity/node-collector:0.3.1"

  # Scan concurrency
  scanJobConcurrentScanJobsLimit: "10"

  # Private registry scan schedule
  privateRegistryScanJobSchedule: "0 2 * * *"  # Daily at 2am

  # Compliance scan schedule
  complianceScanJobSchedule: "0 3 * * 1"  # Weekly Monday at 3am
```

### CronJob for Scan Summary Reports

```yaml
# scan-summary-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vulnerability-summary-report
  namespace: trivy-system
spec:
  schedule: "0 8 * * 1"  # Monday morning report
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: trivy-report-sa
          restartPolicy: OnFailure
          containers:
          - name: reporter
            image: bitnami/kubectl:latest
            command:
            - /bin/bash
            - -c
            - |
              echo "=== Weekly Vulnerability Summary ===" > /tmp/report.txt
              echo "Date: $(date)" >> /tmp/report.txt
              echo "" >> /tmp/report.txt

              # Count by severity across all namespaces
              kubectl get vulnerabilityreports -A -o json | \
                jq -r '
                  [.items[].report.summary] |
                  {
                    "Total Reports": length,
                    "Critical": [.[].criticalCount] | add // 0,
                    "High": [.[].highCount] | add // 0,
                    "Medium": [.[].mediumCount] | add // 0,
                    "Low": [.[].lowCount] | add // 0
                  }
                ' >> /tmp/report.txt

              # Top 10 most vulnerable images
              echo "" >> /tmp/report.txt
              echo "=== Top 10 Most Vulnerable Images ===" >> /tmp/report.txt
              kubectl get vulnerabilityreports -A -o json | \
                jq -r '
                  [.items[] | {
                    image: .spec.artifact.tag,
                    namespace: .metadata.namespace,
                    critical: .report.summary.criticalCount,
                    high: .report.summary.highCount,
                    total: (.report.summary.criticalCount + .report.summary.highCount)
                  }] | sort_by(-.total) | .[0:10] |
                  .[] | [.namespace, .image, .critical, .high] | @tsv
                ' | column -t -s $'\t' >> /tmp/report.txt

              # Post to Slack
              curl -X POST \
                -H "Content-type: application/json" \
                -d "{\"text\": \"$(cat /tmp/report.txt | sed 's/"/\\"/g' | tr '\n' '\\n')\"}" \
                https://hooks.slack.com/services/T0000000/B0000000/placeholder-webhook-url
```

## Section 10: Grafana Dashboard for Security Findings

### Prometheus Metrics from Trivy Operator

```yaml
# trivy-prometheusrule.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: trivy-vulnerability-alerts
  namespace: monitoring
spec:
  groups:
  - name: trivy.vulnerabilities
    rules:
    # Alert on new critical vulnerabilities
    - alert: CriticalVulnerabilityFound
      expr: |
        sum by (namespace, container_name, image_tag) (
          trivy_image_vulnerabilities{severity="CRITICAL"} > 0
        )
      for: 10m
      labels:
        severity: critical
        team: security
      annotations:
        summary: "Critical vulnerability in {{ $labels.container_name }}"
        description: "Image {{ $labels.image_tag }} in {{ $labels.namespace }} has {{ $value }} critical vulnerabilities."
        runbook_url: "https://runbooks.example.com/critical-cve-response"

    # Alert on exposed secrets in images
    - alert: ExposedSecretInImage
      expr: |
        sum by (namespace, container_name) (
          trivy_image_exposed_secrets > 0
        )
      for: 0m
      labels:
        severity: critical
      annotations:
        summary: "Exposed secret in container image"
        description: "Container {{ $labels.container_name }} in {{ $labels.namespace }} has embedded secrets."

    # Alert on config audit failures
    - alert: HighSeverityConfigAuditFailure
      expr: |
        sum by (namespace, resource_name) (
          trivy_resource_configaudits{severity="HIGH",success="false"} > 5
        )
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Multiple HIGH config audit failures for {{ $labels.resource_name }}"

    # SLO: No more than 5% of workloads with CRITICAL vulnerabilities
    - alert: VulnerabilitySLOBreach
      expr: |
        (
          count(sum by (namespace, resource_name) (trivy_image_vulnerabilities{severity="CRITICAL"} > 0))
          /
          count(sum by (namespace, resource_name) (trivy_image_vulnerabilities))
        ) > 0.05
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Vulnerability SLO breached"
        description: "More than 5% of workloads have CRITICAL vulnerabilities."
```

### Grafana Dashboard Queries

```promql
# Total vulnerabilities by severity across all namespaces
sum by (severity) (trivy_image_vulnerabilities)

# Vulnerabilities over time (trend)
sum by (severity) (
  rate(trivy_image_vulnerabilities[1h])
)

# Top 10 namespaces by critical vulnerability count
topk(10,
  sum by (namespace) (
    trivy_image_vulnerabilities{severity="CRITICAL"}
  )
)

# ConfigAudit check pass rate by namespace
sum by (namespace) (trivy_resource_configaudits{success="true"})
/
sum by (namespace) (trivy_resource_configaudits)
* 100

# Mean Time to Remediate critical vulnerabilities
# (Requires custom tracking; approximate from scan timestamps)
avg(
  timestamp() - (
    trivy_image_vulnerabilities{severity="CRITICAL"} * 0 +
    timestamp(trivy_image_vulnerabilities{severity="CRITICAL"})
  )
)
```

## Section 11: Vulnerability Database Management

### Air-Gapped Environments

```bash
# Download vulnerability databases for offline use
# On an internet-connected machine:
trivy image --download-db-only \
  --db-repository ghcr.io/aquasecurity/trivy-db \
  --cache-dir /tmp/trivy-cache

# Package for transfer
tar czf trivy-db-$(date +%Y%m%d).tar.gz -C /tmp/trivy-cache db

# Upload to internal registry
aws s3 cp trivy-db-$(date +%Y%m%d).tar.gz \
  s3://internal-tools/trivy/

# In trivy-operator-values.yaml for air-gapped mode:
# trivy:
#   dbRepositoryInsecure: false
#   dbRepository: "registry.internal.example.com/trivy-db:latest"
```

### Trivy Database Update Job

```yaml
# trivy-db-update-job.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: trivy-db-update
  namespace: trivy-system
spec:
  schedule: "0 */6 * * *"  # Every 6 hours
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          initContainers:
          - name: db-updater
            image: aquasec/trivy:0.48.0
            command:
            - trivy
            - image
            - --download-db-only
            - --db-repository
            - ghcr.io/aquasecurity/trivy-db
            - --cache-dir
            - /trivy-cache
            volumeMounts:
            - name: trivy-cache
              mountPath: /trivy-cache
          containers:
          - name: push-to-registry
            image: gcr.io/go-containerregistry/crane:latest
            command:
            - /bin/sh
            - -c
            - |
              # Repackage and push to internal registry
              crane push /trivy-cache/db \
                registry.internal.example.com/trivy-db:latest
            volumeMounts:
            - name: trivy-cache
              mountPath: /trivy-cache
          volumes:
          - name: trivy-cache
            emptyDir:
              sizeLimit: 500Mi
```

## Section 12: Integration with CI/CD

### Blocking Deployments Based on Scan Results

```bash
#!/bin/bash
# ci-vulnerability-gate.sh
# Used in CI/CD pipeline to check scan results before allowing deployment

NAMESPACE="staging"
WORKLOAD="$1"
SEVERITY_THRESHOLD="${2:-HIGH}"  # Block on HIGH and above by default

if [[ -z "${WORKLOAD}" ]]; then
  echo "Usage: $0 <deployment-name> [severity-threshold]"
  exit 1
fi

echo "Checking vulnerability scan results for ${WORKLOAD} in ${NAMESPACE}..."

# Wait for scan to complete (up to 5 minutes)
for i in $(seq 1 30); do
  REPORT=$(kubectl get vulnerabilityreports -n "${NAMESPACE}" \
    -l "trivy-operator.resource.name=${WORKLOAD}" \
    -o json 2>/dev/null)

  REPORT_COUNT=$(echo "${REPORT}" | jq '.items | length')
  if [[ "${REPORT_COUNT}" -gt 0 ]]; then
    break
  fi

  echo "Waiting for scan report... (${i}/30)"
  sleep 10
done

if [[ "${REPORT_COUNT}" -eq 0 ]]; then
  echo "ERROR: No vulnerability report found after timeout."
  exit 1
fi

# Extract severity counts
CRITICAL=$(echo "${REPORT}" | jq '[.items[].report.summary.criticalCount] | add // 0')
HIGH=$(echo "${REPORT}" | jq '[.items[].report.summary.highCount] | add // 0')

echo "Critical: ${CRITICAL}"
echo "High:     ${HIGH}"

case "${SEVERITY_THRESHOLD}" in
  CRITICAL)
    if [[ "${CRITICAL}" -gt 0 ]]; then
      echo "BLOCKED: ${CRITICAL} critical vulnerabilities found."
      exit 1
    fi
    ;;
  HIGH)
    if [[ "${CRITICAL}" -gt 0 ]] || [[ "${HIGH}" -gt 0 ]]; then
      echo "BLOCKED: ${CRITICAL} critical + ${HIGH} high vulnerabilities found."
      exit 1
    fi
    ;;
esac

echo "PASSED: No vulnerabilities above threshold."
exit 0
```

## Conclusion

The Trivy Operator transforms vulnerability scanning from a point-in-time CI/CD gate into a continuous security control that runs throughout the lifecycle of workloads. VulnerabilityReports detect newly published CVEs in images already running in production. ConfigAuditReports catch security misconfigurations introduced through Helm value changes or manual kubectl edits. ExposedSecretReports surface secrets that were accidentally built into images.

The integration with OPA Gatekeeper or Kyverno closes the feedback loop: scan results become admission webhook constraints that prevent known-vulnerable images or misconfigured workloads from reaching production. The Prometheus metrics and Grafana dashboards provide the visibility required for security SLO tracking and executive reporting, completing the continuous vulnerability management lifecycle.
