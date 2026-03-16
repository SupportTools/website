---
title: "Kubescape: Kubernetes Security Scanning and Compliance Automation"
date: 2027-01-05T00:00:00-05:00
draft: false
tags: ["Kubescape", "Kubernetes", "Security", "Compliance", "NSA", "MITRE"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise guide to Kubescape for continuous Kubernetes security scanning against NSA/CISA, MITRE ATT&CK, and CIS benchmarks with CI/CD integration and operator deployment."
more_link: "yes"
url: "/kubescape-kubernetes-security-scanning-compliance-guide/"
---

Kubernetes cluster security is not a one-time configuration task — it is a continuous process of detecting configuration drift, enforcing policy compliance, and identifying newly published vulnerabilities in running workloads. Most teams manage this with a combination of manual audits, `kube-bench` for CIS benchmark checks, and Trivy for image scanning, but these tools operate in silos and require separate workflows. **Kubescape** consolidates runtime security posture assessment, compliance framework scanning, RBAC analysis, and vulnerability scanning into a single tool with native Kubernetes Operator support for continuous in-cluster scanning.

Kubescape was originally developed by ARMO and is now a CNCF Sandbox project. It implements controls from the **NSA/CISA Kubernetes Hardening Guide**, **MITRE ATT&CK for Containers**, **CIS Kubernetes Benchmark**, and several other frameworks. Unlike `kube-bench` (which only implements CIS benchmarks and requires running inside the cluster), Kubescape can scan clusters remotely via kubeconfig, scan manifests in CI pipelines before deployment, and operate as an always-on operator with Prometheus metrics export.

This guide covers CLI-based scanning, framework-specific controls, custom exceptions, the Kubescape Operator for continuous scanning, and integration patterns for GitHub Actions CI/CD pipelines.

<!--more-->

## Kubescape vs kube-bench vs Trivy

Understanding the niche each tool occupies prevents redundant tooling and coverage gaps:

**kube-bench** implements CIS Kubernetes Benchmark checks by inspecting cluster component configuration files directly (API server flags, kubelet configuration, etcd configuration). It must run as a Pod on the actual nodes to access these files. It does not scan workload configurations, image vulnerabilities, or RBAC.

**Trivy** is primarily an image vulnerability scanner with a secondary capability to scan Kubernetes manifests for misconfigurations. It excels at CVE detection across container images, SBOMs, and OS packages. Its misconfiguration scanning is less comprehensive than dedicated security posture tools and does not implement MITRE ATT&CK or NSA controls natively.

**Kubescape** focuses on the Kubernetes API plane: scanning object configurations (Deployments, Pods, RBAC, NetworkPolicies, PSAs) against security frameworks. It does not scan node-level configuration files (use kube-bench for that) and its vulnerability scanning is supplementary. The tools are complementary:

| Capability | Kubescape | kube-bench | Trivy |
|---|---|---|---|
| CIS Kubernetes Benchmark | Partial (API plane) | Full (node level) | Partial |
| NSA/CISA Hardening Guide | Full | No | No |
| MITRE ATT&CK for Containers | Full | No | No |
| Image CVE scanning | Basic | No | Full |
| RBAC analysis | Yes | No | No |
| Manifest scanning (CI) | Yes | No | Yes |
| In-cluster operator | Yes | No | Yes |
| Prometheus metrics | Yes | No | Yes |
| Remote scan via kubeconfig | Yes | No | Partial |

For a complete security posture program, run all three: Kubescape for Kubernetes API compliance, kube-bench for node hardening validation, and Trivy for image vulnerability management.

## CLI Installation and First Scan

```bash
# Install Kubescape CLI
curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | bash

# Verify installation
kubescape version
# Output: Kubescape version v3.0.3

# Update framework definitions
kubescape download all
```

Run the first cluster scan against all frameworks:

```bash
# Scan the current cluster context
kubescape scan --enable-host-scan \
  --verbose \
  --format pretty-printer \
  --output kubescape-report.txt

# Scan with compliance score threshold (fail if below 80%)
kubescape scan --compliance-threshold 80 \
  --format json \
  --output kubescape-results.json
```

Scan specific namespaces to reduce noise in large clusters:

```bash
# Scan only production workload namespaces
kubescape scan \
  --include-namespaces order-service,payment-service,inventory-service \
  --exclude-namespaces kube-system,monitoring,istio-system \
  --format sarif \
  --output kubescape-prod-namespaces.sarif
```

Scan local manifest files before cluster deployment:

```bash
# Scan a directory of Kubernetes manifests
kubescape scan dir ./k8s-manifests/ \
  --format json \
  --output ci-scan-results.json \
  --fail-threshold 0   # Fail on any control failure

# Scan a Helm chart
helm template my-release ./charts/order-service \
  --values environments/production/values.yaml | \
  kubescape scan -
```

## NSA/CISA Framework Scanning

The **NSA/CISA Kubernetes Hardening Guide** (published 2021, updated 2022) defines controls across four categories: Pod security, network separation, authentication/authorization, and audit logging. Kubescape implements these as the `NSA` framework.

```bash
# Scan against the NSA/CISA framework only
kubescape scan framework nsa \
  --verbose \
  --format pretty-printer

# Example output (abbreviated):
# Control: C-0002 (ConfigMap with sensitive data)
# Severity: High
# Failed resources: 3/45
#   - namespace: payment-service, name: stripe-config (ConfigMap)
#   - namespace: order-service, name: app-config (ConfigMap)
```

Key NSA controls and their remediation:

**C-0002 — Privileged container**: Containers with `securityContext.privileged: true` get full node access. The NSA guide requires no privileged containers except for specific node-level workloads.

**C-0046 — Insecure capabilities**: Containers should drop all capabilities and add only the minimum required. `NET_RAW` capability enables ARP poisoning attacks within the cluster.

**C-0016 — Allow privilege escalation**: `allowPrivilegeEscalation: false` prevents container processes from gaining more privileges than their parent.

Remediate these findings with a `SecurityContext` template:

```yaml
# Compliant security context for production pods
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile:
      type: RuntimeDefault

  containers:
    - name: order-service
      image: 123456789012.dkr.ecr.us-east-1.amazonaws.com/order-service:2.4.1
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 10001
        capabilities:
          drop:
            - ALL
          add: []   # Add specific capabilities only if required (e.g., NET_BIND_SERVICE)
      volumeMounts:
        - name: tmp-dir
          mountPath: /tmp    # Required if readOnlyRootFilesystem: true and app writes to /tmp
  volumes:
    - name: tmp-dir
      emptyDir:
        medium: Memory
        sizeLimit: 64Mi
```

Scan to verify remediation:

```bash
kubescape scan control C-0002 C-0046 C-0016 \
  --namespace order-service \
  --format json | jq '.summaryDetails.controlsSeverityCounters'
```

## MITRE ATT&CK for Kubernetes

The **MITRE ATT&CK framework** for containers maps attack techniques to Kubernetes-specific vectors. Kubescape's `MITRE` framework implements controls across the ATT&CK tactics: Initial Access, Execution, Persistence, Privilege Escalation, Defense Evasion, Credential Access, Discovery, Lateral Movement, Impact.

```bash
# Scan against the MITRE framework
kubescape scan framework mitre \
  --verbose \
  --format html \
  --output mitre-report.html
```

High-priority MITRE controls for Kubernetes:

**T1609 — Container and Resource Discovery via RBAC**: Overly permissive RBAC allows attackers who compromise one pod to discover and interact with other cluster resources.

```bash
# Identify over-privileged service accounts
kubescape scan control C-0035 C-0036 C-0037 \
  --verbose \
  --format pretty-printer
```

Remediation — restrict service account permissions with least privilege:

```yaml
# rbac-order-service.yaml — minimal RBAC for an application service account
apiVersion: v1
kind: ServiceAccount
metadata:
  name: order-service
  namespace: order-service
  annotations:
    description: "Service account for order-service. Has read-only access to its own ConfigMaps and Secrets."
automountServiceAccountToken: false  # Disable auto-mounting if the app doesn't use the Kubernetes API

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: order-service
  namespace: order-service
rules:
  # Only allow reading own ConfigMaps and Secrets by specific names
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["order-service-config"]
    verbs: ["get", "watch"]
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["orders-db-connection", "stripe-credentials"]
    verbs: ["get"]
  # No access to pods, deployments, or any other resources

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: order-service
  namespace: order-service
subjects:
  - kind: ServiceAccount
    name: order-service
    namespace: order-service
roleRef:
  kind: Role
  name: order-service
  apiGroup: rbac.authorization.k8s.io
```

**T1552 — Unsecured Credentials**: Secrets mounted as environment variables appear in process listings, crash dumps, and container inspection output. Kubescape control `C-0012` detects this pattern.

```yaml
# Compliant: mount secrets as files, not environment variables
spec:
  containers:
    - name: order-service
      # Do NOT use envFrom with secretRef for sensitive values
      # Instead, mount as files
      volumeMounts:
        - name: db-credentials
          mountPath: /run/secrets/database
          readOnly: true
  volumes:
    - name: db-credentials
      secret:
        secretName: orders-db-connection
        defaultMode: 0400
```

## CIS Kubernetes Benchmark

The **CIS Kubernetes Benchmark** is the most widely-adopted security baseline. Kubescape implements the API-plane CIS controls (not the node-level ones, which require kube-bench).

```bash
# Scan against CIS benchmark
kubescape scan framework cis-v1.23-t1.0.1 \
  --verbose

# List all CIS controls and their descriptions
kubescape list controls framework cis-v1.23-t1.0.1 \
  --format json | jq '.[] | {id: .controlID, name: .name, severity: .baseScore}'
```

CIS benchmark checks particularly relevant at the API plane:

**CIS 5.1.1** — Ensure that the cluster-admin role is used only where required. Kubescape detects any ClusterRoleBinding to the `cluster-admin` role.

```bash
# Find all cluster-admin bindings
kubectl get clusterrolebindings \
  -o json | \
  jq -r '.items[] | select(.roleRef.name=="cluster-admin") |
    "\(.metadata.name): subjects=\([.subjects[]? | "\(.kind)/\(.name)"] | join(","))"'
```

**CIS 5.7.4** — The default namespace should not be used. Kubescape detects resources deployed into the `default` namespace.

**CIS 5.4.1** — Prefer using secrets as files over secrets as environment variables. Aligned with the MITRE T1552 remediation above.

Generate a CIS compliance report in SARIF format for integration with GitHub Advanced Security:

```bash
kubescape scan framework cis-v1.23-t1.0.1 \
  --format sarif \
  --output cis-benchmark.sarif

# Upload to GitHub Code Scanning
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/example-org/cluster-config/code-scanning/sarifs \
  -f commit_sha="$(git rev-parse HEAD)" \
  -f ref="refs/heads/main" \
  -f sarif="$(gzip -c cis-benchmark.sarif | base64 -w0)"
```

## Custom Exception Rules

Not every failing control represents a genuine security risk in every environment. Kubescape supports **exceptions** to suppress specific findings that are accepted risks or false positives.

Create an exception for the monitoring namespace where privileged containers are required (e.g., node-exporter requires host networking and certain capabilities):

```yaml
# kubescape-exceptions.yaml
- name: monitoring-privileged-exception
  policyType: postureExceptionPolicy
  actions: [alertOnly]
  resources:
    - designatorType: Attribute
      attributes:
        namespace: monitoring
  posturePolicies:
    - frameworkName: NSA
      controlName: Privileged container

- name: system-daemonsets-host-pid
  policyType: postureExceptionPolicy
  actions: [alertOnly]
  resources:
    - designatorType: Attribute
      attributes:
        namespace: kube-system
    - designatorType: Attribute
      attributes:
        namespace: monitoring
  posturePolicies:
    - frameworkName: NSA
      controlName: hostPID, hostIPC privileges

- name: accepted-cluster-admin-binding
  policyType: postureExceptionPolicy
  actions: [alertOnly]
  resources:
    - designatorType: Attribute
      attributes:
        name: cluster-admin-bootstrap
        namespace: ""
        kind: ClusterRoleBinding
  posturePolicies:
    - frameworkName: CIS
      controlName: Minimize use of the cluster-admin role
  reason: "Bootstrapping cluster-admin for initial setup — reviewed and accepted 2027-01-05"
```

Apply exceptions to a scan:

```bash
kubescape scan framework nsa \
  --exceptions kubescape-exceptions.yaml \
  --format json \
  --output nsa-with-exceptions.json
```

Store exceptions in the cluster for the Operator to use:

```bash
kubectl apply -f kubescape-exceptions.yaml -n kubescape
```

## Kubescape Operator (In-Cluster Continuous Scanning)

The **Kubescape Operator** runs as a set of controllers in the cluster, scanning continuously and updating scan results as custom resources. It also exports Prometheus metrics, enabling alerting and dashboarding without manual scan runs.

Install the Operator via Helm:

```bash
helm repo add kubescape https://kubescape.github.io/helm-charts/
helm repo update

helm upgrade --install kubescape kubescape/kubescape-operator \
  --namespace kubescape \
  --create-namespace \
  --version 1.22.0 \
  --set clusterName=prod-us-east-1 \
  --set capabilities.continuousScan=enable \
  --set capabilities.vulnerabilityScan=enable \
  --set capabilities.nodeScan=enable \
  --set storage.enabled=true \
  --set storage.storageClass=gp3 \
  --set storage.size=50Gi \
  --set prometheusAnnotations.enabled=true \
  --set triggerNewImageScan=true \
  --wait
```

The Operator creates several custom resources. View the scan results:

```bash
# View all configuration scan summaries
kubectl get configurationscansummaries -n kubescape

# View detailed results for a specific namespace
kubectl get workloadconfigurationscans -n order-service -o yaml

# View vulnerability scan results
kubectl get vulnerabilitymanifests -n order-service

# View a node scan result
kubectl get hostscans
```

Configure scan schedules:

```yaml
# kubescape-operator-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubescape-operator-config
  namespace: kubescape
data:
  # Run full scans every 6 hours
  scanSchedule: "0 */6 * * *"
  # Trigger immediate scan on new image deployments
  triggerOnNewImage: "true"
  # Frameworks to scan against
  frameworks: "nsa,mitre,cis-v1.23-t1.0.1"
  # Fail threshold for admission webhooks
  failThreshold: "0.85"
```

## Prometheus Metrics Integration

The Kubescape Operator exposes metrics at `/metrics` that enable dashboarding and alerting in Grafana:

```bash
# Port-forward to inspect available metrics
kubectl port-forward -n kubescape svc/kubescape-metrics 8080:8080 &
curl -s http://localhost:8080/metrics | grep "^kubescape_"
```

Key metrics:

- `kubescape_resources_found` — total resources scanned
- `kubescape_resources_failed` — resources that failed one or more controls
- `kubescape_controls_failed` — number of controls that failed
- `kubescape_compliance_score` — overall compliance percentage per framework
- `kubescape_vulnerabilities_total` — total CVEs found by severity

Create a PrometheusRule for compliance regression alerting:

```yaml
# prometheus-rules-kubescape.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kubescape-compliance-alerts
  namespace: kubescape
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: kubescape.compliance
      interval: 300s
      rules:
        - alert: KubescapeComplianceScoreDegraded
          expr: |
            kubescape_compliance_score{framework="nsa"} < 0.75
          for: 30m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "NSA compliance score has fallen below 75%"
            description: "Current score: {{ $value | humanizePercentage }}. Review recent deployments for new misconfigurations."

        - alert: KubescapeCriticalControlFailed
          expr: |
            kubescape_controls_failed{severity="critical"} > 0
          for: 15m
          labels:
            severity: critical
            team: security
          annotations:
            summary: "{{ $value }} critical Kubescape controls are failing"
            description: "Critical security controls are failing. Immediate review required."

        - alert: KubescapeHighSeverityCVE
          expr: |
            sum(kubescape_vulnerabilities_total{severity="Critical"}) by (namespace) > 10
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "Namespace {{ $labels.namespace }} has more than 10 critical CVEs"
            description: "{{ $value }} critical CVEs detected. Review and update affected images."

        - alert: KubescapePrivilegedContainerDetected
          expr: |
            kubescape_resources_failed{control_name="Privileged container"} > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Privileged container detected"
            description: "A privileged container has been detected. This may indicate a security incident or misconfiguration."
```

## GitHub Actions CI/CD Integration

Integrate Kubescape into the CI/CD pipeline to block deployments that introduce new security regressions:

```yaml
# .github/workflows/kubescape-scan.yaml
name: Kubescape Security Scan

on:
  pull_request:
    paths:
      - 'k8s/**'
      - 'charts/**'
      - 'environments/**'

jobs:
  kubescape-manifest-scan:
    name: Scan Kubernetes Manifests
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      security-events: write    # For SARIF upload to GitHub Code Scanning
      checks: write

    steps:
      - uses: actions/checkout@v4

      - name: Install Kubescape
        run: |
          curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | bash
          echo "$HOME/.kubescape/bin" >> "$GITHUB_PATH"

      - name: Download latest framework definitions
        run: kubescape download all

      - name: Render Helm templates
        run: |
          mkdir -p /tmp/rendered-manifests
          for env in development staging production; do
            helm template order-service ./charts/order-service \
              --values environments/${env}/helm-values.yaml \
              --output-dir /tmp/rendered-manifests/${env}
          done

      - name: Scan manifests against NSA framework
        id: nsa-scan
        run: |
          kubescape scan framework nsa \
            /tmp/rendered-manifests/ \
            --format sarif \
            --output kubescape-nsa.sarif \
            --fail-threshold 80 \
            --exceptions kubescape-exceptions.yaml
        continue-on-error: true

      - name: Scan manifests against MITRE framework
        id: mitre-scan
        run: |
          kubescape scan framework mitre \
            /tmp/rendered-manifests/ \
            --format json \
            --output kubescape-mitre.json \
            --fail-threshold 80 \
            --exceptions kubescape-exceptions.yaml
        continue-on-error: true

      - name: Upload SARIF to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: kubescape-nsa.sarif
          category: kubescape-nsa

      - name: Parse scan results and create PR comment
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = JSON.parse(fs.readFileSync('kubescape-mitre.json', 'utf8'));
            const score = results.summaryDetails?.complianceScore?.toFixed(1) || 'N/A';
            const failed = results.summaryDetails?.controlsSeverityCounters?.failed || 0;
            const passed = results.summaryDetails?.controlsSeverityCounters?.passed || 0;

            const body = `## Kubescape Security Scan Results

            | Framework | Compliance Score | Passed | Failed |
            |-----------|-----------------|--------|--------|
            | MITRE ATT&CK | ${score}% | ${passed} | ${failed} |

            ${failed > 0 ? '**Action Required**: Review the SARIF findings in the Security tab.' : 'All controls passed.'}
            `;

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: body
            });

      - name: Fail if compliance below threshold
        run: |
          NSA_EXIT=${{ steps.nsa-scan.outcome == 'failure' && '1' || '0' }}
          MITRE_EXIT=${{ steps.mitre-scan.outcome == 'failure' && '1' || '0' }}
          if [ "$NSA_EXIT" = "1" ] || [ "$MITRE_EXIT" = "1" ]; then
            echo "Compliance threshold not met. Review findings and update configurations."
            exit 1
          fi
```

## Remediation Workflows

When Kubescape identifies failing controls, use the built-in fix suggestions and automate remediation for common patterns:

```bash
# List failing controls with remediation suggestions
kubescape scan framework nsa \
  --format json \
  --output failing-controls.json

# Extract controls with automated fixes available
jq -r '.results[] |
  select(.resourceID != null) |
  "\(.resourceID.namespace)/\(.resourceID.name): \(.controlID) — \(.description)"' \
  failing-controls.json | head -20
```

Automate common remediations with a fix script:

```bash
#!/usr/bin/env bash
# fix-missing-security-contexts.sh
# Adds default SecurityContext to Deployments missing one

set -euo pipefail

NAMESPACE="${1:-order-service}"

kubectl get deployments -n "$NAMESPACE" -o json | \
  jq -r '.items[] |
    select(.spec.template.spec.securityContext == null or
           .spec.template.spec.securityContext == {}) |
    .metadata.name' | \
while read -r deployment; do
  echo "Patching deployment: $deployment"
  kubectl patch deployment "$deployment" \
    -n "$NAMESPACE" \
    --type merge \
    -p '{
      "spec": {
        "template": {
          "spec": {
            "securityContext": {
              "runAsNonRoot": true,
              "seccompProfile": {
                "type": "RuntimeDefault"
              }
            }
          }
        }
      }
    }'
done
```

## Admission Webhook Integration

The Kubescape Operator can be configured as a **validating admission webhook** that evaluates deployments against security frameworks at admission time — blocking non-compliant workloads from being deployed rather than alerting after the fact. This shifts security left to the deployment phase.

Deploy the admission controller component:

```yaml
# kubescape-admission-controller-values.yaml
operator:
  admissionController:
    enabled: true
    failurePolicy: Ignore    # Use "Fail" only after all teams have remediated findings
    rules:
      # Block privileged containers in production namespaces
      - operations: ["CREATE", "UPDATE"]
        apiGroups: ["apps"]
        apiVersions: ["v1"]
        resources: ["deployments", "daemonsets", "statefulsets"]
        scope: "Namespaced"
    namespaceSelector:
      matchLabels:
        kubescape.io/enforce: "true"    # Only enforce on labeled namespaces
```

Label namespaces for enforcement:

```bash
# Enable enforcement for production namespaces
kubectl label namespace order-service kubescape.io/enforce=true
kubectl label namespace payment-service kubescape.io/enforce=true

# Leave monitoring and system namespaces unenforced
# (they have legitimate exceptions already configured)
```

The admission controller evaluates incoming workloads and returns a detailed rejection message when critical controls fail:

```bash
# Attempt to deploy a privileged container in an enforced namespace
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-privileged
  namespace: order-service
spec:
  replicas: 1
  selector:
    matchLabels:
      app: test-privileged
  template:
    metadata:
      labels:
        app: test-privileged
    spec:
      containers:
        - name: test
          image: alpine:3.19
          securityContext:
            privileged: true
EOF

# Expected output:
# Error from server: error when creating "STDIN": admission webhook
# "kubescape.io" denied the request:
# Control C-0002 (Privileged container) failed:
#   Container "test" is privileged. Remove privileged: true from the
#   container securityContext to remediate.
```

Configure graduated enforcement with a deny list for the most critical controls only:

```yaml
# kubescape-enforcement-policy.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kubescape-enforcement-policy
  namespace: kubescape
data:
  # Controls that always block admission (no exceptions)
  deny-controls: |
    C-0002   # Privileged container
    C-0016   # Allow privilege escalation
    C-0046   # Insecure capabilities (NET_ADMIN, SYS_ADMIN)
  # Controls that generate warnings but don't block
  warn-controls: |
    C-0013   # Non-root containers
    C-0034   # Seccomp profile not set
    C-0044   # Container resources not set
```

Monitor admission decisions via Prometheus:

```promql
# Track admission webhook denial rate by namespace
rate(kubescape_admission_denials_total[5m])

# Track admission webhook latency (should be <100ms for non-disruptive enforcement)
histogram_quantile(0.99, rate(kubescape_admission_webhook_duration_seconds_bucket[5m]))
```

## Conclusion

Kubescape provides a unified Kubernetes security scanning platform that bridges the gap between one-time audits and continuous compliance monitoring. Key takeaways from this guide:

- Use Kubescape for API-plane compliance (NSA, MITRE ATT&CK, CIS controls against Pod/RBAC/NetworkPolicy configurations), kube-bench for node-level CIS validation, and Trivy for container image CVE scanning — the three tools are complementary, not competitive
- The Kubescape Operator's continuous scanning with Prometheus metrics export enables proactive compliance monitoring and regression alerting without manual scan execution
- Configure exceptions early for known-acceptable risk decisions (privileged node-exporter DaemonSets, legitimate cluster-admin bindings); undifferentiated noise from unfilterd scans causes teams to ignore genuine findings
- Embed manifest scanning in CI pipelines with SARIF upload to GitHub Code Scanning to catch misconfigurations before they reach the cluster; the `--fail-threshold` flag enables soft enforcement with grace periods during remediation
- The compliance score is a lagging indicator; configure alert rules on specific high-severity controls (privileged container detection, cluster-admin binding changes) for immediate notification of critical security regressions
