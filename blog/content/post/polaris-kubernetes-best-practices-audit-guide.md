---
title: "Polaris: Kubernetes Best Practices Auditing and Admission Control"
date: 2027-02-23T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Polaris", "Best Practices", "Security", "Audit"]
categories: ["Security", "Kubernetes", "Compliance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying Polaris for Kubernetes workload auditing and admission control, covering built-in checks, custom JSON Schema checks, dashboard usage, CI/CD integration with SARIF output, and webhook-based enforcement."
more_link: "yes"
url: "/polaris-kubernetes-best-practices-audit-guide/"
---

Polaris is a Fairwinds open-source tool that audits Kubernetes workloads against a curated set of best-practice checks covering security contexts, resource management, health probes, networking configuration, and container image hygiene. It ships in three modes: a read-only **dashboard**, a **CLI** for CI/CD pipelines, and an **admission webhook** that blocks non-compliant workloads at deploy time.

This guide walks through full production deployment, understanding the check library, writing custom JSON Schema checks, integrating with GitHub CI via SARIF output, configuring the admission webhook, and managing exemptions for legacy workloads.

<!--more-->

## What Polaris Checks

Polaris ships with check categories that map directly to Kubernetes security and reliability best practices:

| Category | Examples |
|---|---|
| Security | `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation`, `capabilities` |
| Efficiency | `cpuRequestsMissing`, `memoryRequestsMissing`, `cpuLimitsMissing`, `memoryLimitsMissing` |
| Reliability | `livenessProbeMissing`, `readinessProbeMissing`, `tagNotSpecified`, `latestTagAllowed` |
| Networking | `hostNetworkSet`, `hostPortSet`, `hostPIDSet`, `hostIPCSet` |
| Images | `insecureCapabilities`, `dangerousCapabilities`, `privilegeEscalationAllowed` |

Each check has a configurable **severity**: `ignore`, `warning`, or `danger`. Checks marked `danger` fail the workload in webhook mode and reduce the compliance score in dashboard and CLI output.

## Architecture

**Polaris Dashboard** — A Kubernetes deployment that continuously reads all workloads from the API server and renders a compliance score per workload and per namespace. No admission webhook is involved; it is purely read-only.

**Polaris CLI** — A binary that accepts Helm charts, raw manifests, or a live cluster connection and outputs a scored compliance report. Used as a CI/CD gate or local developer tool.

**Polaris Admission Webhook** — A `ValidatingWebhookConfiguration` that intercepts CREATE and UPDATE requests for Pods, Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs and blocks those that fail `danger`-severity checks.

All three modes share a single configuration file (`polaris.yaml`) that controls which checks run and at what severity.

## Installation

### Helm Deployment

```bash
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update

helm install polaris fairwinds-stable/polaris \
  --namespace polaris \
  --create-namespace \
  --version 9.0.0 \
  --set dashboard.enable=true \
  --set dashboard.replicas=2 \
  --set webhook.enable=false \
  --set config.checks.securityContext.readOnlyRootFilesystem=warning \
  --set config.checks.securityContext.runAsNonRoot=danger \
  --set config.checks.images.tagNotSpecified=danger
```

### Production values.yaml

```yaml
# polaris-values.yaml
dashboard:
  enable: true
  replicas: 2
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
  service:
    type: ClusterIP
    port: 80
  ingress:
    enabled: true
    ingressClassName: nginx
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
      nginx.ingress.kubernetes.io/auth-type: basic
      nginx.ingress.kubernetes.io/auth-secret: polaris-basic-auth
    hosts:
      - host: polaris.internal.company.com
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: polaris-tls
        hosts:
          - polaris.internal.company.com

webhook:
  enable: false   # Enable after validating all exemptions are in place

config:
  checks:
    # Security
    securityContext:
      readOnlyRootFilesystem: warning
      runAsNonRoot: danger
      runAsRootAllowed: danger
      allowPrivilegeEscalation: danger
      privilegeEscalationAllowed: danger
    capabilities:
      dangerousCapabilities: danger
      insecureCapabilities: warning
      notReadOnlyRootFilesystem: warning
    # Resources
    requests:
      cpuRequestsMissing: danger
      memoryRequestsMissing: danger
    limits:
      cpuLimitsMissing: warning
      memoryLimitsMissing: danger
    # Health
    healthChecks:
      livenessProbeMissing: warning
      readinessProbeMissing: danger
    # Images
    images:
      tagNotSpecified: danger
      latestTagAllowed: danger
      pullPolicyNotAlways: warning
    # Networking
    networking:
      hostNetworkSet: danger
      hostPortSet: warning
      hostPIDSet: danger
      hostIPCSet: danger
  exemptions:
    []   # Populated in section below
```

```bash
helm install polaris fairwinds-stable/polaris \
  --namespace polaris \
  --create-namespace \
  --version 9.0.0 \
  -f polaris-values.yaml
```

### CLI Installation

```bash
# macOS
brew install fairwinds/tap/polaris

# Linux
curl -Lo polaris https://github.com/FairwindsOps/polaris/releases/download/9.0.0/polaris_linux_amd64.tar.gz
tar -xzf polaris_linux_amd64.tar.gz polaris
chmod +x polaris
mv polaris /usr/local/bin/polaris

# Verify
polaris version
```

## The Polaris Configuration File

All behavior is driven by a single `polaris.yaml` config:

```yaml
# polaris.yaml — production configuration
checks:
  securityContext:
    readOnlyRootFilesystem: warning
    runAsNonRoot: danger
    runAsRootAllowed: danger
    allowPrivilegeEscalation: danger
    privilegeEscalationAllowed: danger
    seccompProfileRequired: warning
    appArmorAnnotationRequired: ignore
  capabilities:
    dangerousCapabilities: danger
    insecureCapabilities: warning
  requests:
    cpuRequestsMissing: danger
    memoryRequestsMissing: danger
  limits:
    cpuLimitsMissing: warning
    memoryLimitsMissing: danger
  healthChecks:
    livenessProbeMissing: warning
    readinessProbeMissing: danger
    startupProbeMissing: ignore
  images:
    tagNotSpecified: danger
    latestTagAllowed: danger
    pullPolicyNotAlways: warning
  networking:
    hostNetworkSet: danger
    hostPortSet: warning
    hostPIDSet: danger
    hostIPCSet: danger
  resources:
    priorityClassNotSet: ignore

# Minimum score to pass (0–100). Used by CLI --min-score flag.
scoreThreshold: 80

# Global exemptions by controller name
exemptions:
  - controllerNames:
      - kube-proxy
      - aws-node
      - coredns
    rules:
      - hostNetworkSet
      - hostPIDSet
      - runAsNonRoot

  - controllerNames:
      - prometheus-node-exporter
    rules:
      - hostNetworkSet
      - hostPIDSet
      - readOnlyRootFilesystem

  - namespace: kube-system
    rules:
      - runAsNonRoot
      - runAsRootAllowed
```

## Custom Checks with JSON Schema

Polaris supports **custom checks** defined as JSON Schema documents. These extend Polaris with organization-specific rules beyond the built-in library.

### Example: Require Team Label

```yaml
# custom-checks.yaml — embedded in polaris.yaml under customChecks key
customChecks:
  requireTeamLabel:
    successMessage: "Deployment has required 'team' label"
    failureMessage: "Deployment is missing required 'team' label"
    category: Organization
    target: Deployment
    schema:
      "$schema": "http://json-schema.org/draft-07/schema"
      type: object
      required:
        - metadata
      properties:
        metadata:
          type: object
          required:
            - labels
          properties:
            labels:
              type: object
              required:
                - team
              properties:
                team:
                  type: string
                  minLength: 1
```

### Example: Enforce Specific Image Registry

```yaml
customChecks:
  approvedImageRegistry:
    successMessage: "Container image is from an approved registry"
    failureMessage: "Container image must be from registry.company.com or gcr.io/trusted-project"
    category: Security
    target: Container
    schema:
      "$schema": "http://json-schema.org/draft-07/schema"
      type: object
      properties:
        image:
          type: string
          pattern: "^(registry\\.company\\.com|gcr\\.io/trusted-project)/.*"
```

### Example: Require Liveness Probe HTTP Handler

```yaml
customChecks:
  httpLivenessProbe:
    successMessage: "Liveness probe uses HTTP handler"
    failureMessage: "Liveness probe must use httpGet handler, not exec or tcpSocket"
    category: Reliability
    target: Container
    schema:
      "$schema": "http://json-schema.org/draft-07/schema"
      type: object
      required:
        - livenessProbe
      properties:
        livenessProbe:
          type: object
          required:
            - httpGet
          properties:
            httpGet:
              type: object
              required:
                - path
                - port
```

### Referencing External Check Files

For large organizations, store custom checks as separate YAML files and reference them:

```yaml
# polaris.yaml
customChecks:
  "$ref": "file:///etc/polaris/custom-checks.yaml"
```

## Dashboard Walkthrough

### Namespace Summary View

The dashboard landing page shows all namespaces with a compliance score (0–100) derived from the ratio of passing checks to total checks. Clicking a namespace reveals a per-controller breakdown.

### Controller Detail View

For each controller (Deployment, StatefulSet, DaemonSet), the dashboard shows:

- Overall score with a color indicator (green > 80, yellow 50–80, red < 50)
- Container-level check results grouped by category
- Pass/fail/warning status for each check
- A "raw config" tab showing the effective policy applied

### Score Calculation

Score = `(passing_checks / total_checks) * 100`

`ignore`-severity checks are excluded from the denominator. `warning` checks count against the numerator when they fail but do not count as `danger`. The minimum score threshold (configurable in `polaris.yaml`) gates CI/CD pipeline passage.

## Admission Webhook Configuration

Enable the admission webhook for enforce-on-write behavior. This mode blocks any workload that fails a `danger`-severity check at admission time.

### Enable via Helm

```bash
helm upgrade polaris fairwinds-stable/polaris \
  --namespace polaris \
  --reuse-values \
  --set webhook.enable=true \
  --set webhook.replicas=3 \
  --set webhook.failurePolicy=Fail
```

### Manual Webhook Registration

```yaml
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: polaris
  annotations:
    cert-manager.io/inject-ca-from: polaris/polaris-webhook-cert
webhooks:
  - name: polaris.fairwinds.com
    admissionReviewVersions:
      - v1
      - v1beta1
    clientConfig:
      service:
        name: polaris-webhook
        namespace: polaris
        path: /validate
        port: 443
    rules:
      - apiGroups:
          - apps
        apiVersions:
          - v1
        operations:
          - CREATE
          - UPDATE
        resources:
          - deployments
          - daemonsets
          - statefulsets
      - apiGroups:
          - batch
        apiVersions:
          - v1
        operations:
          - CREATE
          - UPDATE
        resources:
          - jobs
          - cronjobs
      - apiGroups:
          - ""
        apiVersions:
          - v1
        operations:
          - CREATE
          - UPDATE
        resources:
          - pods
          - replicationcontrollers
    failurePolicy: Fail
    sideEffects: None
    timeoutSeconds: 10
    namespaceSelector:
      matchExpressions:
        - key: kubernetes.io/metadata.name
          operator: NotIn
          values:
            - kube-system
            - kube-public
            - polaris
```

### Testing the Webhook

```bash
# Deploy a non-compliant workload to verify blocking
cat <<'EOF' | kubectl apply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-noncompliant
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: test-noncompliant
  template:
    metadata:
      labels:
        app: test-noncompliant
    spec:
      containers:
        - name: test
          image: nginx:latest
EOF

# Expected: admission webhook rejection
# Error from server: error when creating "...": admission webhook "polaris.fairwinds.com" denied the request:
# Container 'test' failed checks: [tagNotSpecified latestTagAllowed runAsNonRoot]
```

## Exemptions via Annotations

Individual controllers can opt out of specific checks using Polaris annotations. This is preferable to wide-scope exemptions in `polaris.yaml` because it documents the exemption close to the resource that needs it.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: node-exporter
  namespace: monitoring
  annotations:
    polaris.fairwinds.com/hostNetworkSet-exempt: "true"
    polaris.fairwinds.com/hostNetworkSet-exempt-reason: "Node exporter requires host network for interface metrics"
    polaris.fairwinds.com/runAsNonRoot-exempt: "true"
    polaris.fairwinds.com/runAsNonRoot-exempt-reason: "Requires root for sysfs access"
spec:
  template:
    spec:
      hostNetwork: true
      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.7.0
          securityContext:
            runAsUser: 0
```

The annotation format is `polaris.fairwinds.com/<check-name>-exempt: "true"`. The optional `-reason` annotation documents the justification and is visible in the dashboard.

## CI/CD Integration

### Basic Pipeline Check

```bash
# Audit a directory of manifests against a local config
polaris audit \
  --audit-path ./manifests/ \
  --config ./polaris.yaml \
  --format score

# Gate on minimum score
polaris audit \
  --audit-path ./manifests/ \
  --config ./polaris.yaml \
  --min-score 80

echo "Exit code: $?"   # Non-zero if score < 80
```

### Helm Chart Auditing

```bash
# Render the chart and pipe to Polaris
helm template myapp ./helm/myapp \
  --values ./helm/myapp/values-production.yaml \
  | polaris audit \
    --config ./polaris.yaml \
    --format pretty \
    --stdin

# Or using the --helm-chart flag
polaris audit \
  --helm-chart ./helm/myapp \
  --helm-values ./helm/myapp/values-production.yaml \
  --config ./polaris.yaml \
  --min-score 80
```

### SARIF Output for GitHub Code Scanning

SARIF (Static Analysis Results Interchange Format) integrates Polaris findings directly into the GitHub Security tab:

```bash
polaris audit \
  --audit-path ./manifests/ \
  --config ./polaris.yaml \
  --format sarif \
  --output-file results.sarif
```

```yaml
# .github/workflows/polaris-audit.yaml
name: Polaris Kubernetes Audit

on:
  push:
    branches:
      - main
  pull_request:
    paths:
      - 'manifests/**'
      - 'helm/**'

jobs:
  polaris-audit:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      actions: read
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Install Polaris
        run: |
          curl -Lo polaris.tar.gz \
            https://github.com/FairwindsOps/polaris/releases/download/9.0.0/polaris_linux_amd64.tar.gz
          tar -xzf polaris.tar.gz polaris
          chmod +x polaris
          mv polaris /usr/local/bin/polaris

      - name: Render Helm templates
        run: |
          helm template myapp ./helm/myapp \
            --values ./helm/myapp/values-production.yaml \
            --output-dir ./rendered-manifests

      - name: Run Polaris audit (table output for PR comment)
        run: |
          polaris audit \
            --audit-path ./rendered-manifests/ \
            --config ./polaris.yaml \
            --format pretty \
            --min-score 75 \
            | tee polaris-results.txt

      - name: Generate SARIF for GitHub Security tab
        run: |
          polaris audit \
            --audit-path ./rendered-manifests/ \
            --config ./polaris.yaml \
            --format sarif \
            --output-file results.sarif

      - name: Upload SARIF results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif
          category: polaris-kubernetes

      - name: Post PR comment on failure
        if: failure() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const results = fs.readFileSync('polaris-results.txt', 'utf8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `## Polaris Audit Failed\n\`\`\`\n${results.slice(0, 4000)}\n\`\`\``
            });
```

### JSON Output for Custom Processing

```bash
# Full JSON report for integration with SIEM or ticketing systems
polaris audit \
  --audit-path ./manifests/ \
  --config ./polaris.yaml \
  --format json \
  | jq '[.Results[] | select(.PodResult.Results[].Success == false) | {
      name: .Name,
      namespace: .Namespace,
      kind: .Kind,
      failures: [.PodResult.Results[] | select(.Success == false) | {check: .ID, severity: .Severity, message: .Message}]
    }]' > polaris-failures.json
```

## Comparison with kube-score and kubeconform

| Feature | Polaris | kube-score | kubeconform |
|---|---|---|---|
| Focus | Best practices + security | Best practices | Schema validation |
| Custom checks | JSON Schema | Limited | None (schema only) |
| Admission webhook | Yes | No | No |
| Dashboard | Yes | No | No |
| SARIF output | Yes | No | Yes |
| Scoring | Yes (0–100) | Yes (pass/warn/crit) | Pass/fail |
| CI/CD integration | Yes | Yes | Yes |
| Live cluster audit | Yes | No | No |

Use **kubeconform** for fast API schema validation in CI, **kube-score** for a lightweight best-practices check with no external dependencies, and **Polaris** when a persistent dashboard, admission webhook, and custom checks are required. The tools are complementary and can run in the same pipeline.

## Integration with Fairwinds Insights

Polaris is the foundation of Fairwinds Insights, a SaaS platform that aggregates Polaris findings with Goldilocks rightsizing data, Nova (outdated image detection), Pluto (deprecated API detection), and RBAC Reporter across multiple clusters into a single compliance dashboard.

For teams already running open-source Polaris and Goldilocks, Insights adds:

- Multi-cluster aggregation and trending
- Jira/PagerDuty/Slack ticket automation for policy failures
- RBAC-controlled team-level views
- SLA tracking for compliance improvement

The `polaris.yaml` configuration used locally is fully compatible with Insights; no migration is required.

## Scoring and Reporting

### Generating a Baseline Report

```bash
# Audit a live cluster (requires kubeconfig)
polaris audit \
  --cluster \
  --config ./polaris.yaml \
  --format json \
  --output-file baseline-$(date +%Y%m%d).json

# Compare scores over time
jq '.Score' baseline-20270101.json
jq '.Score' baseline-20270201.json
```

### Namespace-Level Score Summary

```bash
polaris audit \
  --cluster \
  --config ./polaris.yaml \
  --format json \
  | jq '[.Results[] | {namespace: .Namespace, score: .PodResult.Score, name: .Name, kind: .Kind}]
    | group_by(.namespace)[]
    | {namespace: .[0].namespace, avg_score: (map(.score) | add / length)}' \
  | jq -s 'sort_by(-.avg_score)'
```

### Tracking Progress in Grafana

Store scores in a time-series database for trend visualization:

```bash
#!/usr/bin/env bash
# push-polaris-metrics.sh — pushes score to Prometheus Pushgateway

SCORE=$(polaris audit --cluster --config ./polaris.yaml --format json | jq '.Score')
CLUSTER_NAME="${CLUSTER_NAME:-production}"

cat <<EOF | curl --data-binary @- "http://prometheus-pushgateway.monitoring:9091/metrics/job/polaris/cluster/${CLUSTER_NAME}"
# HELP polaris_cluster_score Overall Polaris compliance score for the cluster
# TYPE polaris_cluster_score gauge
polaris_cluster_score{cluster="${CLUSTER_NAME}"} ${SCORE}
EOF
```

Schedule with a CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: polaris-metrics-pusher
  namespace: polaris
spec:
  schedule: "0 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: polaris
          containers:
            - name: polaris-pusher
              image: registry.company.com/polaris-metrics:1.0.0
              command:
                - /bin/sh
                - /scripts/push-polaris-metrics.sh
              env:
                - name: CLUSTER_NAME
                  value: production
          restartPolicy: OnFailure
```

## Best Practices

### Incremental Enforcement

Start with all checks at `warning` severity, establish a baseline score, then promote specific checks to `danger` on a schedule. This prevents blocking existing workloads while building organizational awareness. A typical 90-day adoption path:

1. **Week 1–2**: Deploy dashboard in audit mode. Measure baseline score per namespace.
2. **Week 3–4**: Promote `runAsNonRoot`, `tagNotSpecified`, `memoryRequestsMissing` to `danger`.
3. **Week 5–6**: Enable the admission webhook with `failurePolicy: Ignore` to observe but not block.
4. **Week 7–8**: Switch `failurePolicy: Fail` after all critical workloads have valid exemptions.
5. **Month 3**: Add custom checks for organization-specific requirements.

### Exemption Governance

Require that any annotation-based exemption in production is accompanied by a GitHub issue or Jira ticket tracking the remediation plan. Add a CI check that detects new exemptions in PRs and requires approval from the platform team:

```bash
# In CI — flag new Polaris exemptions for review
git diff HEAD~1 -- manifests/ \
  | grep "^+" \
  | grep "polaris.fairwinds.com.*-exempt:" \
  && echo "WARNING: New Polaris exemption detected — platform team review required" \
  || echo "No new Polaris exemptions"
```

### Config Consistency

Store a single `polaris.yaml` in a dedicated config repository and reference it from all pipelines. Avoid per-team config drift by serving the config file from a ConfigMap mounted into the dashboard and webhook deployments.

## Troubleshooting

### Webhook Blocking Legitimate Workloads

When the admission webhook is first enabled with `failurePolicy: Fail`, previously deployed workloads may be blocked on their next update. Use this diagnostic workflow:

```bash
# Identify which checks are failing for a specific resource
polaris audit \
  --cluster \
  --namespace kube-system \
  --config ./polaris.yaml \
  --format json \
  | jq '[.Results[] | select(.PodResult.Results[].Success == false)
    | {name: .Name, failures: [.PodResult.Results[] | select(.Success == false) | .ID]}]'

# Test a specific manifest against the live webhook config
cat <<'EOF' > /tmp/test-deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: webhook-test
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: webhook-test
  template:
    metadata:
      labels:
        app: webhook-test
    spec:
      containers:
        - name: nginx
          image: nginx:1.25.4
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 100m
              memory: 128Mi
          securityContext:
            runAsNonRoot: false
EOF
kubectl apply -f /tmp/test-deploy.yaml --dry-run=server
```

### Temporarily Disabling the Webhook for Maintenance

```bash
# Set failurePolicy to Ignore to allow all traffic through during maintenance
kubectl patch validatingwebhookconfiguration polaris \
  --type='json' \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Ignore"}]'

# Perform maintenance tasks...

# Re-enable strict mode
kubectl patch validatingwebhookconfiguration polaris \
  --type='json' \
  -p='[{"op":"replace","path":"/webhooks/0/failurePolicy","value":"Fail"}]'
```

### Dashboard Shows No Workloads

```bash
# Verify Polaris service account can read resources
kubectl auth can-i list deployments \
  --as=system:serviceaccount:polaris:polaris \
  -A

# Check dashboard logs for RBAC errors
kubectl -n polaris logs -l app.kubernetes.io/name=polaris \
  --tail=100 | grep -E "(error|forbidden)"

# Confirm the dashboard can reach the API server
kubectl -n polaris exec -it deploy/polaris-dashboard -- \
  wget -qO- http://kubernetes.default.svc.cluster.local/healthz
```

## Polaris in a Multi-Tool Security Stack

Polaris is most effective as part of a layered security and compliance stack:

| Tool | Purpose | Complements Polaris |
|---|---|---|
| Kyverno | Policy enforcement and mutation | Enforces policies Polaris reports on |
| Goldilocks | Resource rightsizing recommendations | Fixes `cpuRequestsMissing` findings |
| Trivy | Image vulnerability scanning | Covers image security beyond tags |
| Falco | Runtime threat detection | Covers runtime vs admission-time checks |
| kube-bench | CIS benchmark compliance | Node-level checks vs workload-level |

The recommended pipeline order is:

1. **kubeconform** — Validate API schema (fastest, fails fast)
2. **Polaris CLI** — Best-practices and custom checks
3. **Kyverno apply** — Organization-specific policy enforcement
4. **Trivy** — Image vulnerability gate
5. **Deploy to staging** — Runtime validation with Falco

Each tool runs in sequence, with earlier failures blocking later stages to minimize pipeline time for clearly non-compliant changes.

### Makefile Target for Local Developer Use

```makefile
# Makefile — polaris targets for local developer workflow
POLARIS_CONFIG ?= ./polaris.yaml
MANIFESTS_DIR  ?= ./manifests

.PHONY: polaris-check polaris-report

polaris-check:
	@echo "Running Polaris best-practices check..."
	polaris audit \
	  --audit-path $(MANIFESTS_DIR) \
	  --config $(POLARIS_CONFIG) \
	  --min-score 80 \
	  --format pretty
	@echo "Polaris check passed."

polaris-report:
	@echo "Generating Polaris HTML report..."
	polaris audit \
	  --audit-path $(MANIFESTS_DIR) \
	  --config $(POLARIS_CONFIG) \
	  --format pretty \
	  --output-file ./polaris-report.txt
	@echo "Report written to ./polaris-report.txt"

polaris-sarif:
	@echo "Generating SARIF for GitHub Security tab..."
	polaris audit \
	  --audit-path $(MANIFESTS_DIR) \
	  --config $(POLARIS_CONFIG) \
	  --format sarif \
	  --output-file ./results.sarif
	@echo "SARIF written to ./results.sarif"
```

Developers run `make polaris-check` before pushing a branch, catching compliance failures locally before the CI pipeline runs.

## Conclusion

Polaris delivers a practical and approachable path to Kubernetes best-practices enforcement. The three-mode architecture — dashboard for visibility, CLI for pipeline gates, and admission webhook for enforcement — allows teams to adopt compliance incrementally without disrupting existing workloads. Custom JSON Schema checks extend the built-in library to cover organization-specific policies, and SARIF integration surfaces findings directly in GitHub Security scanning workflows. Combined with Goldilocks for resource rightsizing and Kyverno for policy enforcement, Polaris forms a complete workload quality baseline for any Kubernetes platform team.
