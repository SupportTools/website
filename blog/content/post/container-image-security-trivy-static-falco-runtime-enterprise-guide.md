---
title: "Linux Container Image Security Scanning: Static Analysis with Trivy and Runtime with Falco"
date: 2031-08-25T00:00:00-05:00
draft: false
tags: ["Security", "Trivy", "Falco", "Container Security", "Kubernetes", "Vulnerability Scanning", "Runtime Security"]
categories: ["Security", "Kubernetes"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to container security covering Trivy for static vulnerability scanning in CI/CD, runtime threat detection with Falco, policy enforcement with OPA/Gatekeeper, and building a defense-in-depth security pipeline."
more_link: "yes"
url: "/container-image-security-trivy-static-falco-runtime-enterprise-guide/"
---

Container security operates at two distinct layers that must both be addressed: the image layer (what software is in the container) and the runtime layer (what the container does when it runs). Trivy handles the first layer — scanning image filesystems, OS packages, language dependencies, IaC files, and secrets for known vulnerabilities. Falco handles the second — monitoring system calls in real-time and alerting on behavioral anomalies that indicate compromise, data exfiltration, or lateral movement. Together they implement defense-in-depth: Trivy prevents known-vulnerable software from reaching production, Falco detects when an attacker exploits an unknown vulnerability or misconfiguration.

<!--more-->

# Linux Container Image Security Scanning: Static Analysis with Trivy and Runtime with Falco

## Why Both Layers Are Necessary

Static scanning (Trivy) catches:
- Known CVEs in OS packages (apt, yum, apk)
- Known CVEs in language packages (npm, pip, go modules, maven, cargo)
- Embedded secrets (API keys, certificates, passwords)
- Misconfigured Dockerfiles and Kubernetes manifests
- License compliance violations

Static scanning does NOT catch:
- Zero-day vulnerabilities not yet in NVD/CVE databases
- Runtime exploitation of "acceptable risk" vulnerabilities
- Insider threats or supply chain attacks that use legitimate software
- Configuration changes made after deployment
- Network exfiltration behavior

Runtime security (Falco) catches all of the above, because it watches behavior rather than contents.

## Trivy: Static Scanning

### Installation

```bash
# Install Trivy on Linux
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | \
  sh -s -- -b /usr/local/bin v0.50.0

# Verify
trivy --version
# trivy version 0.50.0

# For Kubernetes deployments, use the Trivy Operator (Helm chart)
helm repo add aquasecurity https://aquasecurity.github.io/helm-charts/
helm repo update

helm install trivy-operator aquasecurity/trivy-operator \
  --namespace trivy-system \
  --create-namespace \
  --version 0.20.0 \
  --set trivy.ignoreUnfixed=true \
  --set trivy.severity="HIGH,CRITICAL" \
  --set operator.scanJobTtl="1h"
```

### Container Image Scanning

```bash
# Basic image scan - output table format
trivy image nginx:1.25.3

# Scan with severity filter and exit code for CI
trivy image \
  --severity HIGH,CRITICAL \
  --exit-code 1 \
  --ignore-unfixed \
  myrepo/api-server:v1.2.3

# JSON output for pipeline integration
trivy image \
  --format json \
  --output trivy-results.json \
  --severity HIGH,CRITICAL \
  myrepo/api-server:v1.2.3

# Parse JSON for summary
jq -r '
  .Results[] |
  select(.Vulnerabilities != null) |
  "\(.Target): " +
  (.Vulnerabilities | group_by(.Severity) |
   map("\(.[0].Severity): \(length)") | join(", "))
' trivy-results.json
```

### Filesystem Scanning (for CI without Docker)

```bash
# Scan a directory (e.g., unpacked container layer or repo root)
trivy fs \
  --severity HIGH,CRITICAL \
  --security-checks vuln,secret,config \
  .

# Scan a specific language lockfile
trivy fs \
  --security-checks vuln \
  package-lock.json

# Scan a Dockerfile
trivy config Dockerfile

# Scan Kubernetes manifests
trivy config ./k8s/

# Example output for kubernetes manifest scan:
# Tests: 50 (SUCCESSES: 44, FAILURES: 6, EXCEPTIONS: 0)
# Failures: 6 (HIGH: 2, MEDIUM: 4)
#
# MEDIUM: Container should not run as root (Containers[0].SecurityContext.runAsNonRoot)
# HIGH: Capabilities should not include NET_RAW (Containers[0].SecurityContext.Capabilities.Add)
```

### Secret Detection

```bash
# Trivy detects hardcoded secrets in images and repos
trivy image \
  --security-checks secret \
  myrepo/api-server:v1.2.3

# Trivy detects these pattern types (configurable):
# - AWS Access Key IDs
# - GitHub tokens
# - Private SSH keys
# - JWT tokens
# - Generic API keys matching common patterns

# Custom secret patterns
cat > trivy-secret.yaml << 'EOF'
rules:
  - id: custom-internal-token
    category: general
    title: Internal Service Token
    severity: CRITICAL
    regex: "INTERNAL_TOKEN_[A-Z0-9]{32}"
    keywords:
      - "INTERNAL_TOKEN_"
EOF

trivy image \
  --security-checks secret \
  --secret-config trivy-secret.yaml \
  myrepo/api-server:v1.2.3
```

### CI/CD Integration

```yaml
# .github/workflows/security-scan.yml
name: Container Security Scan

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    permissions:
      security-events: write  # Required for SARIF upload

    steps:
      - uses: actions/checkout@v4

      - name: Build image for scanning
        run: |
          docker build -t scan-target:${{ github.sha }} .

      - name: Scan for vulnerabilities
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: scan-target:${{ github.sha }}
          format: sarif
          output: trivy-results.sarif
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: 1  # Fail the build on HIGH/CRITICAL

      - name: Upload results to GitHub Security tab
        if: always()  # Upload even on scan failure
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif

      - name: Scan Dockerfile and K8s manifests
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: config
          scan-ref: .
          format: table
          severity: HIGH,CRITICAL
          exit-code: 1

      - name: Scan for secrets
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: scan-target:${{ github.sha }}
          scan-type: image
          scanners: secret
          format: table
          exit-code: 1  # Always fail on secrets
```

### Trivy Operator in Kubernetes

The Trivy Operator automatically scans all images in the cluster and reports results as CRDs:

```bash
# View vulnerability reports for a namespace
kubectl get vulnerabilityreports -n production

# NAME                                                              REPOSITORY                    TAG      SCANNER   AGE
# replicaset-api-server-7d9f8b-api-server                         myrepo/api-server             v1.2.3   Trivy     2h
# replicaset-frontend-8c4f6d-frontend                             myrepo/frontend               v2.1.0   Trivy     2h

# Get detailed report for a specific workload
kubectl describe vulnerabilityreport \
  replicaset-api-server-7d9f8b-api-server \
  -n production

# Get critical and high CVEs across all pods
kubectl get vulnerabilityreports -A -o json | jq -r '
  .items[] |
  select(.report.summary.criticalCount > 0 or .report.summary.highCount > 0) |
  "\(.metadata.namespace)/\(.metadata.name): CRITICAL=\(.report.summary.criticalCount) HIGH=\(.report.summary.highCount)"
'
```

```yaml
# PrometheusRule for Trivy Operator metrics
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: trivy-vulnerability-alerts
  namespace: monitoring
spec:
  groups:
    - name: trivy.vulnerabilities
      rules:
        - alert: CriticalVulnerabilityDetected
          expr: |
            trivy_image_vulnerabilities{severity="CRITICAL"} > 0
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Critical vulnerability in {{ $labels.image_repository }}:{{ $labels.image_tag }}"
            description: "{{ $value }} CRITICAL CVEs found. Namespace: {{ $labels.namespace }}"

        - alert: HighVulnerabilityCountHigh
          expr: |
            sum by (image_repository, namespace) (
              trivy_image_vulnerabilities{severity="HIGH"}
            ) > 10
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High vulnerability count in {{ $labels.image_repository }}"
```

## Falco: Runtime Security

Falco monitors kernel system calls using eBPF (recommended) or a kernel module and evaluates them against a rule engine. When a rule matches, Falco generates an alert.

### Installation

```bash
# Install Falco via Helm (recommended for Kubernetes)
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --values falco-values.yaml

# falco-values.yaml
cat > falco-values.yaml << 'EOF'
# Use eBPF driver (no kernel module compilation required)
driver:
  kind: ebpf
  ebpf:
    hostNetwork: true

# Configure output channels
falco:
  # JSON output for log aggregation
  json_output: true
  json_include_output_property: true

  # Log to stdout (captured by container log driver)
  log_syslog: false
  log_stderr: true

  # Priority threshold (only alert on warnings and above)
  priority: warning

  grpc:
    enabled: true
    bind_address: "unix:///run/falco/falco.sock"
    threadiness: 8

  grpcOutput:
    enabled: true

# Enable the Prometheus metrics endpoint
metrics:
  enabled: true
  interval: 1m
  output_rule: true

# Deploy Falco Sidekick for output routing
falcosidekick:
  enabled: true
  webui:
    enabled: true
  config:
    slack:
      webhookurl: ""   # Configure with your Slack webhook
      minimumpriority: "warning"
    alertmanager:
      hostport: "http://alertmanager-operated.monitoring.svc.cluster.local:9093"
      minimumpriority: "warning"
    elasticsearch:
      hostport: "http://elasticsearch.logging.svc.cluster.local:9200"
      index: "falco-alerts"
      minimumpriority: "notice"
EOF
```

### Understanding Falco Rules

Falco rules define conditions on system call events:

```yaml
# falco-custom-rules.yaml
- rule: Container Escape via Privileged Execution
  desc: Detect execution of privileged commands that indicate container escape attempts
  condition: >
    spawned_process and
    container and
    proc.name in (nsenter, unshare) and
    (proc.args contains "user" or proc.args contains "pid" or proc.args contains "mnt")
  output: >
    Container escape attempt via namespace manipulation
    (user=%user.name user_loginuid=%user.loginuid
     command=%proc.cmdline pid=%proc.pid
     container_id=%container.id container_name=%container.name
     image=%container.image.repository:%container.image.tag
     namespace=%k8s.ns.name pod=%k8s.pod.name)
  priority: CRITICAL
  tags: [container, escape, mitre_privilege_escalation]

- rule: Suspicious Network Tool Execution
  desc: Detect network reconnaissance tools running inside containers
  condition: >
    spawned_process and
    container and
    proc.name in (nmap, masscan, nc, netcat, ncat, socat, tcpdump,
                  tshark, wireshark, hping3, zmap) and
    not proc.pname in (init, systemd, runc, containerd)
  output: >
    Network reconnaissance tool executed in container
    (user=%user.name command=%proc.cmdline
     container=%container.name image=%container.image.repository
     namespace=%k8s.ns.name pod=%k8s.pod.name)
  priority: WARNING
  tags: [container, network, mitre_discovery]

- rule: Crypto Mining Activity
  desc: Detect cryptocurrency mining by observing common miner process names and network patterns
  condition: >
    (spawned_process and
     proc.name in (xmrig, cgminer, bfgminer, ethminer, t-rex, lolminer,
                   gminer, nbminer, phoenixminer, teamredminer)) or
    (evt.type = connect and
     fd.sport in (3333, 4444, 5555, 7777, 8888, 9999, 14433, 45560, 45700) and
     container)
  output: >
    Possible cryptocurrency mining activity detected
    (user=%user.name command=%proc.cmdline connection=%fd.name
     container=%container.name namespace=%k8s.ns.name)
  priority: CRITICAL
  tags: [container, crypto_mining, mitre_resource_hijacking]

- rule: Write to Sensitive Container Paths
  desc: Detect writes to sensitive paths that indicate tampering
  condition: >
    open_write and
    container and
    (fd.name startswith /etc/ or
     fd.name startswith /usr/bin/ or
     fd.name startswith /usr/sbin/ or
     fd.name startswith /bin/ or
     fd.name startswith /sbin/) and
    not proc.name in (apt, apt-get, dpkg, rpm, yum, dnf, zypper, microdnf)
  output: >
    Sensitive path modified inside container
    (user=%user.name file=%fd.name command=%proc.cmdline
     container=%container.name namespace=%k8s.ns.name pod=%k8s.pod.name)
  priority: ERROR
  tags: [container, filesystem, mitre_persistence]

- rule: Kubernetes API Access from Container
  desc: Detect containers making direct API calls to the Kubernetes API server
  condition: >
    (evt.type in (connect, sendto) and
     container and
     fd.sport = 6443 and
     not proc.name in (kubectl, helm, terraform)) or
    (evt.type = open and
     container and
     fd.name startswith /var/run/secrets/kubernetes.io/serviceaccount and
     not proc.name in (java, node, python, ruby, go, kubectl))
  output: >
    Container making Kubernetes API call
    (user=%user.name command=%proc.cmdline connection=%fd.name
     container=%container.name namespace=%k8s.ns.name pod=%k8s.pod.name)
  priority: WARNING
  tags: [container, kubernetes, mitre_discovery]

- rule: Data Exfiltration via DNS
  desc: Detect unusually long DNS queries that may indicate DNS tunneling
  condition: >
    evt.type = sendmsg and
    container and
    fd.sport = 53 and
    evt.rawarg.data_len > 512
  output: >
    Suspicious large DNS query (possible tunneling)
    (user=%user.name bytes=%evt.rawarg.data_len
     container=%container.name namespace=%k8s.ns.name)
  priority: WARNING
  tags: [container, network, exfiltration]
```

### Falco Macro and List Management

```yaml
# falco-macros.yaml - Reusable building blocks
- macro: outbound_corp
  condition: >
    (fd.typechar = 4 or fd.typechar = 6) and
    (fd.ip != "127.0.0.1" and fd.net != "10.0.0.0/8" and
     fd.net != "172.16.0.0/12" and fd.net != "192.168.0.0/16")

- macro: allowed_image_registries
  condition: >
    (container.image.repository startswith "myrepo.dkr.ecr.us-east-1.amazonaws.com/" or
     container.image.repository startswith "gcr.io/my-project/" or
     container.image.repository startswith "ghcr.io/my-org/")

- list: privileged_namespaces
  items: [kube-system, monitoring, cert-manager, falco]

- rule: Unauthorized Container Registry
  desc: Detect containers running from unauthorized image registries
  condition: >
    container and
    not allowed_image_registries and
    not (k8s.ns.name in (privileged_namespaces))
  output: >
    Container running from unauthorized registry
    (image=%container.image.repository:%container.image.tag
     namespace=%k8s.ns.name pod=%k8s.pod.name)
  priority: WARNING
  tags: [container, supply_chain]
```

### Falco with eBPF Deep Dive

```bash
# Verify eBPF probe is loaded
kubectl logs -n falco -l app=falco | grep -i ebpf
# INFO Loading BPF probe...
# INFO BPF probe loaded successfully

# Check Falco kernel compatibility
kubectl exec -n falco ds/falco -- falco --list-events | head -20

# View live alerts from Falco
kubectl logs -n falco -l app=falco -f | jq '
  select(.priority == "Critical" or .priority == "Error") |
  {time: .time, rule: .rule, output: .output}'

# Test a rule is firing correctly (in development)
kubectl exec -n default deploy/test-pod -- sh -c "
  # This should trigger the 'Write to Sensitive Container Paths' rule
  touch /etc/test-falco-trigger
  rm /etc/test-falco-trigger
"

# Check if the alert was generated
kubectl logs -n falco -l app=falco --since=30s | grep "test-falco-trigger"
```

### Falco Sidekick Configuration for AlertManager Integration

```yaml
# falco-sidekick-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: falco-sidekick-config
  namespace: falco
data:
  config.yaml: |
    listenaddress: "0.0.0.0"
    listenport: 2801
    debug: false

    # AlertManager integration
    alertmanager:
      hostport: "http://alertmanager.monitoring.svc.cluster.local:9093"
      endpoint: "/api/v2/alerts"
      minimumpriority: "warning"
      checkcert: false
      mutualtls: false
      customHeaders:
        Content-Type: application/json

    # Elasticsearch for long-term storage
    elasticsearch:
      hostport: "http://elasticsearch.logging.svc.cluster.local:9200"
      index: "falco-alerts"
      type: "_doc"
      minimumpriority: "debug"
      checkcert: false
      suffix: "daily"  # Creates daily indices: falco-alerts-2031.08.25

    # PagerDuty for critical alerts
    pagerduty:
      apikey: ""  # Set via secret reference
      routingkey: ""
      minimumpriority: "critical"
      checkcert: true
```

## Building a Unified Security Pipeline

### Admission Control: Block Vulnerable Images

Use OPA/Gatekeeper to prevent deployment of images with known critical vulnerabilities:

```yaml
# ConstraintTemplate: require images to have been scanned recently
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireimagescanned
spec:
  crd:
    spec:
      names:
        kind: RequireImageScanned
      validation:
        type: object
        properties:
          maxAgeDays:
            type: integer
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requireimagescanned

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          image := container.image

          # Check for the scan annotation on the pod
          scan_time := input.review.object.metadata.annotations["trivy.security.io/last-scan-time"]
          not scan_time

          msg := sprintf("Container %v: image %v has not been scanned. Add trivy.security.io/last-scan-time annotation.", [container.name, image])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          scan_time := input.review.object.metadata.annotations["trivy.security.io/last-scan-time"]

          # Parse the scan time (assuming RFC3339)
          parsed_time := time.parse_rfc3339_ns(scan_time)
          age_ns := time.now_ns() - parsed_time
          max_age_ns := input.parameters.maxAgeDays * 24 * 60 * 60 * 1000000000

          age_ns > max_age_ns

          msg := sprintf("Container %v: image scan is too old (>%v days). Re-scan required.", [container.name, input.parameters.maxAgeDays])
        }
---
# Apply the constraint
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireImageScanned
metadata:
  name: require-recent-image-scan
spec:
  enforcementAction: deny
  parameters:
    maxAgeDays: 7
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces: ["production", "staging"]
    excludedNamespaces: ["kube-system", "falco", "monitoring"]
```

### CI/CD Security Gate Script

```bash
#!/bin/bash
# security-gate.sh - Full security validation pipeline

set -euo pipefail

IMAGE=${1:?Usage: security-gate.sh <image>}
MAX_CRITICAL=${2:-0}
MAX_HIGH=${3:-5}

echo "=== Security Gate: $IMAGE ==="
echo ""

# Step 1: Vulnerability scan
echo "--- Step 1: Vulnerability Scan ---"
VULN_JSON=$(trivy image \
  --format json \
  --ignore-unfixed \
  --quiet \
  "$IMAGE" 2>/dev/null)

CRITICAL=$(echo "$VULN_JSON" | jq '[.Results[].Vulnerabilities[]? | select(.Severity=="CRITICAL")] | length')
HIGH=$(echo "$VULN_JSON" | jq '[.Results[].Vulnerabilities[]? | select(.Severity=="HIGH")] | length')

echo "Critical CVEs: $CRITICAL (max allowed: $MAX_CRITICAL)"
echo "High CVEs: $HIGH (max allowed: $MAX_HIGH)"

if [ "$CRITICAL" -gt "$MAX_CRITICAL" ]; then
  echo "FAIL: Critical vulnerability count $CRITICAL exceeds threshold $MAX_CRITICAL"
  echo ""
  echo "Critical CVEs:"
  echo "$VULN_JSON" | jq -r '
    .Results[].Vulnerabilities[]? |
    select(.Severity=="CRITICAL") |
    "  \(.VulnerabilityID): \(.PkgName) \(.InstalledVersion) -> \(.FixedVersion // "no fix") | \(.Title)"
  ' | head -20
  exit 1
fi

if [ "$HIGH" -gt "$MAX_HIGH" ]; then
  echo "FAIL: High vulnerability count $HIGH exceeds threshold $MAX_HIGH"
  exit 1
fi

echo "PASS: Vulnerability counts within thresholds"
echo ""

# Step 2: Secret detection
echo "--- Step 2: Secret Detection ---"
SECRET_JSON=$(trivy image \
  --format json \
  --security-checks secret \
  --quiet \
  "$IMAGE" 2>/dev/null)

SECRET_COUNT=$(echo "$SECRET_JSON" | jq '[.Results[].Secrets[]?] | length')
if [ "$SECRET_COUNT" -gt 0 ]; then
  echo "FAIL: $SECRET_COUNT secrets detected in image"
  echo "$SECRET_JSON" | jq -r '
    .Results[].Secrets[]? |
    "  [\(.Severity)] \(.RuleID): \(.Title) in \(.Match)"
  '
  exit 1
fi
echo "PASS: No secrets detected"
echo ""

# Step 3: Dockerfile best practices (if Dockerfile present)
if [ -f Dockerfile ]; then
  echo "--- Step 3: Dockerfile Analysis ---"
  trivy config --severity HIGH,CRITICAL Dockerfile
  echo ""
fi

# Step 4: License compliance
echo "--- Step 4: License Compliance ---"
LICENSE_JSON=$(trivy image \
  --format json \
  --security-checks license \
  --severity CRITICAL \
  --quiet \
  "$IMAGE" 2>/dev/null)

LICENSE_COUNT=$(echo "$LICENSE_JSON" | jq '[.Results[].Licenses[]?] | length')
if [ "$LICENSE_COUNT" -gt 0 ]; then
  echo "WARNING: $LICENSE_COUNT license compliance issues"
  echo "$LICENSE_JSON" | jq -r '.Results[].Licenses[]? | "  \(.Severity): \(.Name) (\(.PackageName))"'
fi

echo ""
echo "=== Security Gate PASSED: $IMAGE ==="
echo "Critical: $CRITICAL, High: $HIGH, Secrets: $SECRET_COUNT"
```

## Trivy and Falco Integration: Closing the Loop

Falco detects a runtime attack → alert includes the container image → Trivy scans that image to identify which vulnerability was likely exploited → CVE is added to the Trivy ignore list pending patch or used to prioritize remediation:

```bash
#!/bin/bash
# incident-image-scan.sh - Triggered by Falco alert to scan the offending image
# Called by Falco Sidekick webhook

CONTAINER_IMAGE=${1:?}
ALERT_RULE=${2:-unknown}
INCIDENT_ID=${3:-$(date +%s)}

echo "Incident scan: $CONTAINER_IMAGE (rule: $ALERT_RULE, incident: $INCIDENT_ID)"

# Full scan with no filtering - we want everything for incident investigation
trivy image \
  --format json \
  --security-checks vuln,secret,config \
  "$CONTAINER_IMAGE" > "/tmp/incident-scan-${INCIDENT_ID}.json"

# Generate a human-readable report
trivy image \
  --format template \
  --template "@/opt/trivy/html.tpl" \
  --output "/var/reports/incident-${INCIDENT_ID}.html" \
  "$CONTAINER_IMAGE"

# Send to SIEM
curl -s -X POST \
  "http://elasticsearch.logging.svc.cluster.local:9200/security-incidents/_doc" \
  -H "Content-Type: application/json" \
  -d "{
    \"incident_id\": \"$INCIDENT_ID\",
    \"image\": \"$CONTAINER_IMAGE\",
    \"falco_rule\": \"$ALERT_RULE\",
    \"scan_results\": $(cat /tmp/incident-scan-${INCIDENT_ID}.json),
    \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }"

echo "Incident scan complete: /var/reports/incident-${INCIDENT_ID}.html"
```

## Summary

The Trivy + Falco combination provides coverage across the full container security lifecycle. Trivy at the CI/CD layer prevents known-vulnerable images from reaching production and detects misconfigurations before deployment. The Trivy Operator extends this continuously, catching newly-disclosed CVEs affecting already-deployed images. Falco at the runtime layer provides behavioral monitoring that catches what static analysis cannot: exploitation of unknown vulnerabilities, insider threats, and post-compromise activity.

The key operational principle is that these tools inform each other. A Falco alert triggers an immediate Trivy scan of the offending image, potentially revealing the CVE that was exploited. A Trivy scan finding a critical CVE in a deployed image triggers a Falco rule review to check whether behavioral indicators of exploitation are present in the logs. Together they create a security feedback loop that reduces both mean-time-to-detect (MTTD) and mean-time-to-respond (MTTR) for container security incidents.
