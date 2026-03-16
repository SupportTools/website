---
title: "Kubernetes Security Posture Management: kube-bench, Falco, and Policy Enforcement"
date: 2027-07-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "KSPM", "Falco", "Policy"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes Security Posture Management covering CIS benchmarks with kube-bench, Falco runtime detection, Tetragon eBPF enforcement, Kyverno policies, OPA Gatekeeper, RBAC auditing, and secrets scanning in CI/CD pipelines."
more_link: "yes"
url: "/kubernetes-security-posture-management-guide/"
---

Kubernetes clusters are high-value targets. A misconfigured RBAC role, an unpatched container image, or a privileged pod can escalate to full cluster compromise within minutes. Kubernetes Security Posture Management (KSPM) addresses this by continuously measuring cluster configuration against known-good benchmarks, enforcing policy at admission time, and detecting anomalous runtime behavior before attackers complete their objectives.

<!--more-->

# Kubernetes Security Posture Management: kube-bench, Falco, and Policy Enforcement

## Section 1: The KSPM Framework

KSPM operates across three planes:

- **Configuration posture**: Cluster and node configuration benchmarked against CIS Kubernetes Benchmark and vendor hardening guides
- **Policy enforcement**: Admission controllers that reject non-compliant workloads before they reach the scheduler
- **Runtime detection**: Behavioral monitoring that identifies exploitation, lateral movement, and data exfiltration in running containers

Each plane covers different attack surfaces. Configuration posture catches infrastructure misconfigurations. Policy enforcement stops insecure workloads from being deployed. Runtime detection catches attacks that slip through both earlier layers.

---

## Section 2: CIS Kubernetes Benchmark with kube-bench

### Running kube-bench

kube-bench executes the CIS Kubernetes Benchmark checks against the current node. It must run on each node type: control plane, etcd, and worker nodes.

**One-shot job on control plane nodes:**

```yaml
# kube-bench-master-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-master
  namespace: security
spec:
  template:
    spec:
      hostPID: true
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: kube-bench
          image: aquasec/kube-bench:v0.8.0
          command: ["kube-bench", "run", "--targets", "master", "--json"]
          volumeMounts:
            - name: var-lib-etcd
              mountPath: /var/lib/etcd
              readOnly: true
            - name: etc-kubernetes
              mountPath: /etc/kubernetes
              readOnly: true
            - name: usr-bin
              mountPath: /usr/local/mount-from-host/bin
              readOnly: true
          securityContext:
            privileged: false
            runAsNonRoot: true
            runAsUser: 65534
      restartPolicy: Never
      volumes:
        - name: var-lib-etcd
          hostPath:
            path: /var/lib/etcd
        - name: etc-kubernetes
          hostPath:
            path: /etc/kubernetes
        - name: usr-bin
          hostPath:
            path: /usr/bin
```

**Worker node check:**

```yaml
# kube-bench-node-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kube-bench-node
  namespace: security
spec:
  selector:
    matchLabels:
      app: kube-bench-node
  template:
    metadata:
      labels:
        app: kube-bench-node
    spec:
      hostPID: true
      initContainers:
        - name: kube-bench
          image: aquasec/kube-bench:v0.8.0
          command:
            - /bin/sh
            - -c
            - |
              kube-bench run --targets node --json \
                > /output/kube-bench-$(hostname)-$(date +%Y%m%d).json
          volumeMounts:
            - name: output
              mountPath: /output
            - name: etc-kubernetes
              mountPath: /etc/kubernetes
              readOnly: true
      containers:
        - name: pause
          image: gcr.io/google-containers/pause:3.9
      volumes:
        - name: output
          hostPath:
            path: /var/log/kube-bench
            type: DirectoryOrCreate
        - name: etc-kubernetes
          hostPath:
            path: /etc/kubernetes
```

**Parse kube-bench JSON output:**

```bash
# Extract failing checks with remediation
kubectl logs -n security job/kube-bench-master | jq '
  .Controls[].tests[].results[] |
  select(.status == "FAIL") |
  {
    test_number: .test_number,
    description: .test_desc,
    remediation: .remediation
  }'
```

### Automating Benchmark Tracking Over Time

Store kube-bench results in S3 and trend PASS/FAIL counts with Prometheus:

```python
#!/usr/bin/env python3
"""Parse kube-bench JSON and push metrics to Prometheus Pushgateway."""
import json
import sys
import requests

PUSHGATEWAY = "http://prometheus-pushgateway.monitoring.svc.cluster.local:9091"
CLUSTER = "prod-us-east-1"

def push_benchmark_metrics(results_json: str):
    data = json.loads(results_json)
    totals = {"PASS": 0, "FAIL": 0, "WARN": 0, "INFO": 0}

    for control in data.get("Controls", []):
        for test_group in control.get("tests", []):
            for result in test_group.get("results", []):
                status = result.get("status", "INFO")
                totals[status] = totals.get(status, 0) + 1

    metric_lines = []
    for status, count in totals.items():
        metric_lines.append(
            f'kube_bench_check_total{{cluster="{CLUSTER}",status="{status.lower()}"}} {count}'
        )

    payload = "\n".join(metric_lines) + "\n"
    resp = requests.post(
        f"{PUSHGATEWAY}/metrics/job/kube-bench/instance/{CLUSTER}",
        data=payload,
        headers={"Content-Type": "text/plain"}
    )
    resp.raise_for_status()
    print(f"Pushed: {totals}")

if __name__ == "__main__":
    push_benchmark_metrics(sys.stdin.read())
```

---

## Section 3: Falco Runtime Security

### Falco Architecture

Falco intercepts system calls using either a kernel module or eBPF probe, evaluates them against a rule engine, and emits alerts when behaviors match threat signatures. In Kubernetes, Falco also enriches events with pod metadata via the Kubernetes API.

**Install Falco with Helm:**

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --set driver.kind=ebpf \
  --set falcosidekick.enabled=true \
  --set falcosidekick.config.slack.webhookurl="SLACK_WEBHOOK_PLACEHOLDER" \
  --set falcosidekick.config.slack.minimumpriority="warning" \
  --set collectors.kubernetes.enabled=true \
  --set tty=true
```

### Custom Falco Rules

Falco rules are YAML with conditions written in a Sysdig filter language. The following rules cover high-value detection scenarios.

**Detect cryptocurrency miners:**

```yaml
# falco-custom-rules.yaml
- rule: Crypto Miner Process Detected
  desc: >
    Detect execution of known cryptocurrency miner binaries or
    processes with high CPU affinity flags.
  condition: >
    spawned_process and (
      proc.name in (xmrig, minerd, cpuminer, cgminer, bfgminer, ethminer) or
      proc.cmdline contains "--nicehash" or
      proc.cmdline contains "--donate-level" or
      proc.cmdline contains "stratum+tcp"
    )
  output: >
    Crypto miner detected
    (user=%user.name command=%proc.cmdline
     container=%container.name pod=%k8s.pod.name
     namespace=%k8s.ns.name image=%container.image.repository)
  priority: CRITICAL
  tags: [cryptomining, process]
```

**Detect shell spawned in container:**

```yaml
- rule: Shell Spawned in Container
  desc: >
    Alert when a shell is spawned inside a running container.
    Legitimate shells should only appear during init containers or
    debug sessions tagged with a specific annotation.
  condition: >
    spawned_process and
    container and
    shell_procs and
    not container.image.repository in (allowed_shell_images) and
    not k8s.pod.annotation[debug-session] = "true"
  output: >
    Shell spawned in container
    (user=%user.name shell=%proc.name
     parent=%proc.pname cmdline=%proc.cmdline
     pod=%k8s.pod.name namespace=%k8s.ns.name
     image=%container.image.repository:%container.image.tag)
  priority: WARNING
  tags: [shell, container_escape]

- list: allowed_shell_images
  items:
    - "bitnami/kubectl"
    - "alpine"
    - "busybox"
```

**Detect unexpected outbound network connection:**

```yaml
- macro: trusted_outbound_destinations
  condition: >
    fd.sip in (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) or
    fd.sport in (53, 443, 80)

- rule: Unexpected Outbound Connection from Container
  desc: >
    Detect containers establishing outbound connections to
    unexpected external destinations.
  condition: >
    outbound and
    container and
    not trusted_outbound_destinations and
    not proc.name in (curl, wget, node, python3, java)
  output: >
    Unexpected outbound connection
    (user=%user.name command=%proc.cmdline
     connection=%fd.name pod=%k8s.pod.name
     namespace=%k8s.ns.name)
  priority: WARNING
  tags: [network, exfiltration]
```

**Detect privileged container:**

```yaml
- rule: Privileged Container Started
  desc: >
    Alert when a privileged container is started. Privileged
    containers have full access to the host kernel and should
    be explicitly approved.
  condition: >
    container_started and
    container.privileged = true and
    not k8s.ns.name in (kube-system, falco, monitoring) and
    not k8s.pod.label[approved-privileged] = "true"
  output: >
    Privileged container started
    (pod=%k8s.pod.name namespace=%k8s.ns.name
     image=%container.image.repository
     privileged=%container.privileged)
  priority: CRITICAL
  tags: [container_escape, privilege_escalation]
```

### Falco Sidekick Alerting

Falco Sidekick routes alerts to multiple destinations. Configure it via the Helm values:

```yaml
# falco-sidekick-values.yaml
falcosidekick:
  enabled: true
  replicaCount: 2
  config:
    slack:
      webhookurl: ""  # Set via external secret
      minimumpriority: "warning"
      messageformat: >
        "[{{.Priority}}] {{.Rule}} - Pod: {{index .OutputFields \"k8s.pod.name\"}}
        Namespace: {{index .OutputFields \"k8s.ns.name\"}}"
    pagerduty:
      routingKey: ""  # Set via external secret
      minimumpriority: "critical"
    elasticsearch:
      hostport: "http://elasticsearch.logging.svc.cluster.local:9200"
      index: "falco-alerts"
      minimumpriority: "notice"
    prometheus:
      # Falco Sidekick exposes /metrics
      extralabels: ""
  webui:
    enabled: true
    replicaCount: 1
```

---

## Section 4: Tetragon eBPF Enforcement

Tetragon (Cilium project) extends Falco-style detection with in-kernel enforcement. Tetragon can block system calls, kill processes, or override file operations before they complete.

**Install Tetragon:**

```bash
helm repo add cilium https://helm.cilium.io
helm install tetragon cilium/tetragon \
  --namespace kube-system \
  --set tetragon.enabled=true \
  --set tetragonOperator.enabled=true
```

**TracingPolicy: block write to /etc/passwd in containers:**

```yaml
# tetragon-block-passwd-write.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-etc-passwd-write
spec:
  kprobes:
    - call: "security_file_permission"
      syscall: false
      args:
        - index: 0
          type: "file"
        - index: 1
          type: "int"
      selectors:
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/etc/passwd"
                - "/etc/shadow"
                - "/etc/sudoers"
            - index: 1
              operator: "Equal"
              values:
                - "2"  # MAY_WRITE
          matchNamespaces:
            - namespace: Mnt
              operator: NotIn
              values:
                - "host_mnt_ns_value"
          matchActions:
            - action: Sigkill
```

**TracingPolicy: detect /proc/[pid]/mem reads (process injection):**

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: detect-process-injection
spec:
  kprobes:
    - call: "fd_install"
      syscall: false
      args:
        - index: 1
          type: "file"
      selectors:
        - matchArgs:
            - index: 1
              operator: "Prefix"
              values:
                - "/proc/"
          matchActions:
            - action: Post
```

---

## Section 5: Kyverno Policy Library

Kyverno is a Kubernetes-native policy engine that evaluates admission requests against declarative rules.

**Install Kyverno:**

```bash
helm repo add kyverno https://kyverno.github.io/kyverno
helm install kyverno kyverno/kyverno \
  --namespace kyverno \
  --create-namespace \
  --set replicaCount=3 \
  --set resources.requests.cpu=500m \
  --set resources.requests.memory=512Mi
```

### Core Security Policies

**Disallow privileged containers:**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privileged-containers
  annotations:
    policies.kyverno.io/title: Disallow Privileged Containers
    policies.kyverno.io/severity: high
    policies.kyverno.io/category: Pod Security Standards (Baseline)
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: privileged-containers
      match:
        any:
          - resources:
              kinds:
                - Pod
      exclude:
        any:
          - resources:
              namespaces:
                - kube-system
                - falco
      validate:
        message: "Privileged mode is not allowed."
        pattern:
          spec:
            containers:
              - =(securityContext):
                  =(privileged): "false"
            initContainers:
              - =(securityContext):
                  =(privileged): "false"
```

**Require non-root user:**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-run-as-non-root
  annotations:
    policies.kyverno.io/severity: medium
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: run-as-non-root
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Containers must run as non-root user."
        anyPattern:
          - spec:
              securityContext:
                runAsNonRoot: true
          - spec:
              containers:
                - securityContext:
                    runAsNonRoot: true
```

**Disallow latest image tag:**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
  annotations:
    policies.kyverno.io/severity: medium
spec:
  validationFailureAction: Enforce
  background: true
  rules:
    - name: require-image-tag
      match:
        any:
          - resources:
              kinds:
                - Pod
      validate:
        message: "Images must not use the 'latest' tag or omit a tag."
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                any:
                  - key: "{{ element.image }}"
                    operator: Equals
                    value: "*:latest"
                  - key: "{{ element.image }}"
                    operator: NotContains
                    value: ":"
```

**Mutate: add seccomp profile:**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-seccomp-profile
spec:
  rules:
    - name: add-seccomp
      match:
        any:
          - resources:
              kinds:
                - Pod
      mutate:
        patchStrategicMerge:
          spec:
            securityContext:
              +(seccompProfile):
                type: RuntimeDefault
```

**Generate: default NetworkPolicy for new namespaces:**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: default-deny-all-traffic
spec:
  rules:
    - name: generate-default-networkpolicy
      match:
        any:
          - resources:
              kinds:
                - Namespace
      generate:
        kind: NetworkPolicy
        name: default-deny-all
        namespace: "{{request.object.metadata.name}}"
        synchronize: true
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
              - Egress
```

---

## Section 6: OPA Gatekeeper Constraints

OPA Gatekeeper uses ConstraintTemplates and Constraints to enforce custom policies with full Rego expressiveness.

**Install Gatekeeper:**

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --set replicas=3 \
  --set auditInterval=60 \
  --set constraintViolationsLimit=100
```

**ConstraintTemplate: require resource limits:**

```yaml
# require-resource-limits-template.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireresourcelimits
spec:
  crd:
    spec:
      names:
        kind: RequireResourceLimits
      validation:
        openAPIV3Schema:
          type: object
          properties:
            exemptImages:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package requireresourcelimits

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not has_cpu_limit(container)
          msg := sprintf(
            "Container '%s' does not have a CPU limit.", [container.name]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not has_memory_limit(container)
          msg := sprintf(
            "Container '%s' does not have a memory limit.", [container.name]
          )
        }

        has_cpu_limit(container) {
          container.resources.limits.cpu
        }

        has_memory_limit(container) {
          container.resources.limits.memory
        }
```

**Constraint applying the template:**

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireResourceLimits
metadata:
  name: require-resource-limits
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - gatekeeper-system
      - monitoring
  parameters:
    exemptImages: []
```

**Audit existing violations:**

```bash
kubectl get requireresourcelimits.constraints.gatekeeper.sh \
  require-resource-limits \
  -o jsonpath='{.status.violations}' | jq '.[] | {namespace: .namespace, name: .name, message: .message}'
```

---

## Section 7: RBAC Auditing with rbac-tool

### Enumerate Effective Permissions

```bash
# Install rbac-tool
kubectl krew install rbac-tool

# Show all subjects (users, groups, service accounts) and their roles
kubectl rbac-tool who-can get secrets --namespace production

# Visualize role bindings for a service account
kubectl rbac-tool viz --include-subjects=ServiceAccount \
  --sa-namespace=default --sa=default

# Find service accounts with wildcard verb permissions
kubectl rbac-tool lookup --kind=ClusterRole \
  | grep -E "\*.*\*"
```

**Automated RBAC audit script:**

```bash
#!/bin/bash
# rbac-audit.sh — find over-privileged service accounts
set -euo pipefail

echo "=== Service Accounts with cluster-admin ==="
kubectl get clusterrolebindings -o json | jq -r '
  .items[] |
  select(.roleRef.name == "cluster-admin") |
  .subjects[]? |
  select(.kind == "ServiceAccount") |
  "\(.namespace)/\(.name)"'

echo ""
echo "=== ClusterRoles with wildcard permissions ==="
kubectl get clusterroles -o json | jq -r '
  .items[] |
  select(.rules[]?.verbs[]? == "*") |
  .metadata.name'

echo ""
echo "=== Roles allowing secrets access outside kube-system ==="
kubectl get roles --all-namespaces -o json | jq -r '
  .items[] |
  select(
    (.metadata.namespace != "kube-system") and
    (.rules[]?.resources[]? == "secrets")
  ) |
  "\(.metadata.namespace)/\(.metadata.name)"'
```

### Kyverno Policy: Restrict ClusterRole Wildcards

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: restrict-wildcard-verbs
spec:
  validationFailureAction: Audit
  rules:
    - name: no-wildcard-verbs
      match:
        any:
          - resources:
              kinds:
                - ClusterRole
                - Role
      exclude:
        any:
          - resources:
              names:
                - cluster-admin
                - system:*
      validate:
        message: "ClusterRoles should not use wildcard verbs or resources."
        deny:
          conditions:
            any:
              - key: "{{ request.object.rules[].verbs[] }}"
                operator: AnyIn
                value: ["*"]
```

---

## Section 8: Secrets Scanning

### Pre-commit Scanning with detect-secrets

```bash
# Install detect-secrets
pip install detect-secrets

# Initialize baseline
detect-secrets scan > .secrets.baseline

# Scan working directory
detect-secrets scan --baseline .secrets.baseline
```

**CI/CD integration (GitHub Actions):**

```yaml
# .github/workflows/secrets-scan.yaml
name: Secrets Scan
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  detect-secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install detect-secrets
        run: pip install detect-secrets

      - name: Run detect-secrets
        run: |
          detect-secrets scan --baseline .secrets.baseline
          detect-secrets audit .secrets.baseline --report --fail-on-unaudited

      - name: Run gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**gitleaks configuration:**

```toml
# .gitleaks.toml
title = "gitleaks config"

[[rules]]
description = "AWS Access Key"
id = "aws-access-key"
regex = '''AKIA[0-9A-Z]{16}'''
tags = ["aws", "credentials"]

[[rules]]
description = "Generic API Key"
id = "generic-api-key"
regex = '''(?i)(api[_-]?key|apikey|api[_-]?token)["\s]*[:=]["\s]*[a-zA-Z0-9_\-]{20,}'''
tags = ["api-key"]

[[rules]]
description = "Kubernetes Service Account Token"
id = "k8s-sa-token"
regex = '''eyJhbGciOiJSUzI1NiIsImtpZCI6I'''
tags = ["kubernetes", "token"]

[allowlist]
description = "global allow list"
regexes = [
  "REPLACE_WITH_YOUR_WEBHOOK_TOKEN",
  "GITHUB_PAT_REPLACE_ME"
]
```

### Scanning Kubernetes Secrets at Rest

```bash
#!/bin/bash
# scan-k8s-secrets.sh — audit secrets content for plaintext credentials
for ns in $(kubectl get ns -o jsonpath='{.items[*].metadata.name}'); do
  kubectl get secrets -n "$ns" -o json 2>/dev/null | jq -r '
    .items[] |
    .metadata.namespace as $ns |
    .metadata.name as $name |
    .data // {} |
    to_entries[] |
    {
      namespace: $ns,
      secret: $name,
      key: .key,
      value_preview: (.value | @base64d | .[0:40])
    }' 2>/dev/null || true
done
```

---

## Section 9: Container Image Scanning in CI/CD

### Trivy Integration

Trivy scans container images for CVEs, misconfigurations, and exposed secrets.

**GitHub Actions workflow with Trivy:**

```yaml
# .github/workflows/image-scan.yaml
name: Container Image Security Scan
on:
  push:
    branches: [main]
  pull_request:

jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker image
        run: docker build -t myapp:${{ github.sha }} .

      - name: Run Trivy vulnerability scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: "myapp:${{ github.sha }}"
          format: "sarif"
          output: "trivy-results.sarif"
          severity: "CRITICAL,HIGH"
          exit-code: "1"
          ignore-unfixed: true

      - name: Upload Trivy scan results to GitHub Security tab
        uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: "trivy-results.sarif"

      - name: Trivy config scan (Dockerfile, Kubernetes manifests)
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: "config"
          scan-ref: "."
          severity: "HIGH,CRITICAL"
          exit-code: "1"
```

**Kyverno policy: block images with critical CVEs (using image verification):**

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-image-scan-attestation
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-scan-attestation
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - production
      verifyImages:
        - imageReferences:
            - "registry.myorg.com/*"
          attestations:
            - type: https://cosign.sigstore.dev/attestation/vuln/v1
              conditions:
                - all:
                    - key: "{{ scanner }}"
                      operator: Equals
                      value: "trivy"
                    - key: "{{ metadata.scanFinishedOn }}"
                      operator: GreaterThan
                      value: "{{ time_since('', '24h', '') }}"
```

---

## Section 10: Runtime Anomaly Detection and Security Dashboard

### Consolidated Security Metrics

Export security events from Falco, kube-bench, and Gatekeeper to Prometheus for a unified dashboard.

**Falco Prometheus metrics (via Falco Sidekick):**

```promql
# Alert rate by priority over time
rate(falcosidekick_inputs_total{priority=~"critical|warning"}[5m])

# Top violated rules in the past hour
topk(10,
  sum by (rule) (
    increase(falcosidekick_inputs_total[1h])
  )
)

# Gatekeeper constraint violations by namespace
sum by (namespace) (
  gatekeeper_violations{enforcement_action="deny"}
)
```

**Grafana dashboard JSON snippet for security overview panel:**

```json
{
  "title": "KSPM Overview",
  "panels": [
    {
      "title": "Falco Alerts — Last 24h",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(increase(falcosidekick_inputs_total{priority=\"critical\"}[24h]))",
          "legendFormat": "Critical"
        }
      ]
    },
    {
      "title": "kube-bench FAIL Count",
      "type": "gauge",
      "targets": [
        {
          "expr": "kube_bench_check_total{status=\"fail\"}",
          "legendFormat": "{{ cluster }}"
        }
      ]
    },
    {
      "title": "Policy Violations by Namespace",
      "type": "bargauge",
      "targets": [
        {
          "expr": "sum by (namespace) (gatekeeper_violations)",
          "legendFormat": "{{ namespace }}"
        }
      ]
    }
  ]
}
```

### Security Alerting Rules

```yaml
# security-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kspm-alerts
  namespace: monitoring
spec:
  groups:
    - name: kspm.critical
      rules:
        - alert: CriticalFalcoAlert
          expr: |
            increase(falcosidekick_inputs_total{priority="critical"}[5m]) > 0
          for: 0m
          labels:
            severity: critical
            team: security
          annotations:
            summary: "Critical Falco rule triggered"
            description: >
              A critical security event was detected.
              Check Falco UI or SIEM for details.

        - alert: PolicyViolationSpike
          expr: |
            increase(gatekeeper_violations_total[10m]) > 10
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Spike in Gatekeeper policy violations"
            description: >
              More than 10 policy violations in 10 minutes.
              Potential misconfigured deployment or attack attempt.

        - alert: KubeBenchFailureRegression
          expr: |
            kube_bench_check_total{status="fail"}
            > kube_bench_check_total{status="fail"} offset 1d
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "CIS benchmark failures increased"
            description: >
              kube-bench failure count increased compared to 24 hours ago.
              Review recent cluster configuration changes.
```

---

## Section 11: Integrated KSPM Pipeline

A complete KSPM pipeline combines all layers into a continuous enforcement loop.

```
Developer commits code
       │
       ▼
CI Pipeline (GitHub Actions)
  ├── gitleaks (secrets scan)
  ├── Trivy (image CVE scan)
  ├── Trivy config (K8s manifest lint)
  └── OPA Conftest (policy-as-code pre-deploy)
       │
       ▼
Admission Control (Kubernetes API server)
  ├── Kyverno (mutation + validation)
  └── OPA Gatekeeper (Rego constraints)
       │
       ▼
Running Workload
  ├── Falco (syscall-level detection)
  ├── Tetragon (eBPF enforcement)
  └── NetworkPolicy (lateral movement prevention)
       │
       ▼
Continuous Audit
  ├── kube-bench (CIS benchmark daily)
  ├── rbac-tool (RBAC drift detection)
  └── Prometheus + Grafana (unified security dashboard)
```

**OPA Conftest pre-deploy policy:**

```bash
# Install conftest
curl -L https://github.com/open-policy-agent/conftest/releases/download/v0.50.0/conftest_0.50.0_Linux_x86_64.tar.gz \
  | tar xz && mv conftest /usr/local/bin/

# Policy file: policy/kubernetes.rego
cat > policy/kubernetes.rego <<'EOF'
package main

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  not container.resources.limits.memory
  msg := sprintf("Container '%s' is missing memory limits", [container.name])
}

deny[msg] {
  input.kind == "Deployment"
  container := input.spec.template.spec.containers[_]
  container.securityContext.privileged == true
  msg := sprintf("Container '%s' is privileged", [container.name])
}

warn[msg] {
  input.kind == "Deployment"
  not input.spec.template.spec.securityContext.runAsNonRoot
  msg := "Deployment does not set runAsNonRoot at pod level"
}
EOF

# Scan Kubernetes manifests before apply
conftest test k8s/ --policy policy/
```

---

## Summary

Kubernetes Security Posture Management is not a single tool but a defense-in-depth strategy. kube-bench establishes baseline compliance against industry standards. Falco and Tetragon detect and block runtime threats using eBPF. Kyverno and OPA Gatekeeper enforce policy at admission time, preventing insecure workloads from reaching the scheduler. RBAC auditing identifies privilege accumulation. Secrets scanning in CI prevents credential exposure before code merges.

The combination of these controls, wired together through Prometheus metrics and a unified Grafana dashboard, gives security and platform teams the continuous visibility needed to maintain a defensible security posture across large multi-tenant Kubernetes environments.
