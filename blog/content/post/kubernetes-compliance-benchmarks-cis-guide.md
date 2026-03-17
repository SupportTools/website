---
title: "Kubernetes CIS Benchmark Compliance: Automated Scanning and Remediation"
date: 2028-03-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "CIS Benchmark", "Security", "Compliance", "kube-bench", "OPA Gatekeeper", "Trivy"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete guide to Kubernetes CIS Benchmark v1.9 compliance: kube-bench automated scanning, remediation scripts for common findings, OPA Gatekeeper runtime enforcement policies, Trivy operator continuous scanning, and audit report generation."
more_link: "yes"
url: "/kubernetes-compliance-benchmarks-cis-guide/"
---

The CIS Kubernetes Benchmark provides a prescriptive set of security controls for Kubernetes clusters, divided into control plane, worker node, etcd, policies, and managed Kubernetes sections. Achieving and maintaining compliance requires automated scanning, systematic remediation of findings, runtime policy enforcement to prevent regression, and continuous monitoring that generates auditor-friendly reports. This guide covers the complete compliance workflow from initial kube-bench scan through remediation and ongoing enforcement.

<!--more-->

## CIS Kubernetes Benchmark v1.9 Structure

The benchmark is organized into five sections:

| Section | Scope | Examples |
|---|---|---|
| 1. Control Plane Components | API server, scheduler, controller manager | Anonymous auth disabled, TLS enabled |
| 2. etcd | etcd configuration | TLS peer certificates, client auth |
| 3. Control Plane Configuration | Kubeconfig, PKI | Certificate file permissions |
| 4. Worker Nodes | kubelet, kube-proxy | Authentication, authorization mode |
| 5. Kubernetes Policies | RBAC, Pod Security, NetworkPolicy | Default deny, admin role limits |

Each control has a Level designation:
- **Level 1**: Reasonable baseline, minimal performance/operational impact
- **Level 2**: Defense in depth, may have significant operational impact

## kube-bench: Automated CIS Scanning

kube-bench runs CIS Benchmark checks and reports pass/fail/warning for each control.

### Running kube-bench as a Kubernetes Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-master
  namespace: kube-system
spec:
  template:
    spec:
      hostPID: true
      restartPolicy: Never
      volumes:
      - name: var-lib-etcd
        hostPath:
          path: /var/lib/etcd
      - name: var-lib-kubelet
        hostPath:
          path: /var/lib/kubelet
      - name: var-lib-kube-controller-manager
        hostPath:
          path: /var/lib/kube-controller-manager
      - name: var-lib-kube-scheduler
        hostPath:
          path: /var/lib/kube-scheduler
      - name: var-lib-kube-proxy
        hostPath:
          path: /var/lib/kube-proxy
      - name: etc-systemd
        hostPath:
          path: /etc/systemd
      - name: lib-systemd
        hostPath:
          path: /lib/systemd
      - name: srv-kubernetes
        hostPath:
          path: /srv/kubernetes
      - name: etc-kubernetes
        hostPath:
          path: /etc/kubernetes
      - name: usr-bin
        hostPath:
          path: /usr/bin
      - name: etc-cni-netd
        hostPath:
          path: /etc/cni/net.d/
      - name: opt-cni-bin
        hostPath:
          path: /opt/cni/bin/
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:v0.8.0
        command: ["kube-bench", "run",
                  "--targets", "master,etcd,policies",
                  "--json",
                  "--outputfile", "/tmp/results.json"]
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
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
```

### Running kube-bench from the Node

```bash
# Direct execution on a control plane node
docker run --rm \
  --pid=host \
  -v /etc:/etc:ro \
  -v /var:/var:ro \
  -v /lib/systemd:/lib/systemd:ro \
  -v /usr/bin/kube-apiserver:/usr/bin/kube-apiserver:ro \
  aquasec/kube-bench:v0.8.0 \
  run \
  --targets master \
  --json | jq '.Controls[].tests[].results[] | select(.status == "FAIL")'

# Run on worker node
docker run --rm \
  --pid=host \
  -v /etc:/etc:ro \
  -v /var:/var:ro \
  aquasec/kube-bench:v0.8.0 \
  run \
  --targets node \
  --json
```

### Parsing kube-bench Results

```bash
# Extract all FAIL findings with their remediation text
kubectl logs -n kube-system job/kube-bench-master | \
  jq -r '.Controls[].tests[].results[] |
  select(.status == "FAIL") |
  "\(.test_number) | \(.test_desc) | \(.remediation)"' | \
  column -t -s '|'

# Count findings by status
kubectl logs -n kube-system job/kube-bench-master | \
  jq '{
    pass: [.Controls[].tests[].results[] | select(.status == "PASS")] | length,
    fail: [.Controls[].tests[].results[] | select(.status == "FAIL")] | length,
    warn: [.Controls[].tests[].results[] | select(.status == "WARN")] | length,
    info: [.Controls[].tests[].results[] | select(.status == "INFO")] | length
  }'

# Get specific section results
kubectl logs -n kube-system job/kube-bench-master | \
  jq '.Controls[] | select(.id == "1.2") | .tests[].results[] | {id: .test_number, status, desc: .test_desc}'
```

## Remediation Scripts for Common Findings

### 1.2.1 Anonymous Authentication Disabled

```bash
# Finding: --anonymous-auth=true or not set
# Check current setting
ps aux | grep kube-apiserver | grep anonymous-auth

# Remediate: edit API server manifest (kubeadm clusters)
# /etc/kubernetes/manifests/kube-apiserver.yaml
# Add: --anonymous-auth=false

# Automated remediation script
APISERVER_MANIFEST="/etc/kubernetes/manifests/kube-apiserver.yaml"
if grep -q "anonymous-auth=true" "$APISERVER_MANIFEST" 2>/dev/null; then
    sed -i 's/--anonymous-auth=true/--anonymous-auth=false/' "$APISERVER_MANIFEST"
    echo "Fixed: anonymous-auth set to false"
elif ! grep -q "anonymous-auth" "$APISERVER_MANIFEST"; then
    # Add the flag
    sed -i '/- kube-apiserver/a\    - --anonymous-auth=false' "$APISERVER_MANIFEST"
    echo "Added: anonymous-auth=false"
fi
```

### 1.2.6 AlwaysAdmit Admission Controller Not Set

```bash
#!/bin/bash
# Check for AlwaysAdmit in enable-admission-plugins
APISERVER_MANIFEST="/etc/kubernetes/manifests/kube-apiserver.yaml"

# Remove AlwaysAdmit from enable-admission-plugins
if grep -q "AlwaysAdmit" "$APISERVER_MANIFEST"; then
    sed -i 's/AlwaysAdmit,//' "$APISERVER_MANIFEST"
    sed -i 's/,AlwaysAdmit//' "$APISERVER_MANIFEST"
    sed -i 's/AlwaysAdmit//' "$APISERVER_MANIFEST"
    echo "Removed AlwaysAdmit from admission plugins"
fi

# Verify recommended admission plugins are enabled
REQUIRED_PLUGINS="NodeRestriction,PodSecurity"
if ! grep -q "NodeRestriction" "$APISERVER_MANIFEST"; then
    echo "WARNING: NodeRestriction admission plugin not enabled"
fi
```

### 1.2.16 Audit Logging Enabled

```yaml
# Audit policy for comprehensive logging
apiVersion: audit.k8s.io/v1
kind: Policy
metadata:
  name: production-audit-policy
rules:
# Log all requests from system:masters group (privileged access)
- level: RequestResponse
  groups: ["system:masters"]

# Log all secrets operations at Request level (no secret content)
- level: Metadata
  resources:
  - group: ""
    resources: ["secrets", "configmaps"]

# Log pod exec and attach (potential privilege escalation)
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]

# Log RBAC changes
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"]

# Log kube-system namespace changes
- level: RequestResponse
  namespaces: ["kube-system"]

# Default: log metadata only for everything else
- level: Metadata
  omitStages:
  - RequestReceived
```

```bash
# Add audit logging to kube-apiserver manifest
# Requires audit policy file and log path to be mounted

cat >> /etc/kubernetes/manifests/kube-apiserver.yaml << 'PATCH'
    - --audit-policy-file=/etc/kubernetes/audit/policy.yaml
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100
PATCH
```

### 4.2.1 kubelet Anonymous Authentication Disabled

```bash
#!/bin/bash
# Fix kubelet configuration on all worker nodes

KUBELET_CONFIG="/var/lib/kubelet/config.yaml"

# Check if anonymous auth is enabled
if python3 -c "
import yaml, sys
with open('$KUBELET_CONFIG') as f:
    cfg = yaml.safe_load(f)
auth = cfg.get('authentication', {})
anon = auth.get('anonymous', {})
sys.exit(0 if anon.get('enabled', True) else 1)
" 2>/dev/null; then
    echo "FAIL: kubelet anonymous auth is enabled"
    # Patch the config
    python3 << 'EOF'
import yaml
with open('/var/lib/kubelet/config.yaml') as f:
    cfg = yaml.safe_load(f)
cfg.setdefault('authentication', {}).setdefault('anonymous', {})['enabled'] = False
cfg.setdefault('authorization', {})['mode'] = 'Webhook'
with open('/var/lib/kubelet/config.yaml', 'w') as f:
    yaml.dump(cfg, f)
print("Fixed: anonymous auth disabled, authorization mode set to Webhook")
EOF
    systemctl restart kubelet
fi
```

### 5.1.3 Minimize Wildcard Use in RBAC Roles

```bash
# Find ClusterRoles and Roles with wildcard verbs or resources
kubectl get clusterroles -o json | \
  jq -r '.items[] |
  select(
    .rules[]? |
    (.verbs[]? == "*") or (.resources[]? == "*") or (.apiGroups[]? == "*")
  ) |
  .metadata.name' | \
  grep -v "^system:"  # Exclude system-managed roles

# Find RoleBindings that grant cluster-admin to non-system accounts
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] |
  select(.roleRef.name == "cluster-admin") |
  .subjects[]? |
  select(.name | startswith("system:") | not) |
  "\(.kind)/\(.name) in \(.namespace // "cluster")"'
```

### 5.2.1 Pod Security Standards Enforcement

```yaml
# Apply restricted Pod Security Standards to all namespaces (except system)
# Label namespaces to enforce PSS
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.29
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.29
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.29
```

```bash
# Apply PSS labels to all non-system namespaces
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' | \
           tr ' ' '\n' | grep -v "^kube-\|^default$"); do
  kubectl label namespace "$ns" \
    pod-security.kubernetes.io/enforce=restricted \
    pod-security.kubernetes.io/warn=restricted \
    pod-security.kubernetes.io/audit=restricted \
    --overwrite
  echo "Applied PSS to namespace: $ns"
done
```

## OPA Gatekeeper Policies for Runtime Enforcement

Gatekeeper enforces policies using OPA's Rego language. These policies prevent non-compliant resources from being created, maintaining compliance state at runtime.

### Install Gatekeeper

```bash
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm upgrade --install gatekeeper gatekeeper/gatekeeper \
  --namespace gatekeeper-system \
  --create-namespace \
  --set replicas=3 \
  --set auditInterval=60 \
  --set constraintViolationsLimit=100
```

### ConstraintTemplate: Require Non-Root Container

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirenonrootcontainer
spec:
  crd:
    spec:
      names:
        kind: K8sRequireNonRootContainer
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
      package k8srequirenonrootcontainer

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not is_exempt(container)
        not container.securityContext.runAsNonRoot == true
        not container.securityContext.runAsUser > 0
        msg := sprintf("Container '%v' must set runAsNonRoot=true or runAsUser > 0", [container.name])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.initContainers[_]
        not is_exempt(container)
        not container.securityContext.runAsNonRoot == true
        not container.securityContext.runAsUser > 0
        msg := sprintf("Init container '%v' must set runAsNonRoot=true or runAsUser > 0", [container.name])
      }

      is_exempt(container) {
        exempt := input.parameters.exemptImages[_]
        startswith(container.image, exempt)
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireNonRootContainer
metadata:
  name: require-non-root-container
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
    - kube-public
    - gatekeeper-system
  parameters:
    exemptImages:
    - "registry.k8s.io/"
    - "quay.io/prometheus/"
```

### ConstraintTemplate: No Privileged Containers

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snoprivilegedcontainer
spec:
  crd:
    spec:
      names:
        kind: K8sNoPrivilegedContainer
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8snoprivilegedcontainer

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        container.securityContext.privileged == true
        msg := sprintf("Privileged container '%v' is not allowed", [container.name])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.initContainers[_]
        container.securityContext.privileged == true
        msg := sprintf("Privileged init container '%v' is not allowed", [container.name])
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoPrivilegedContainer
metadata:
  name: no-privileged-containers
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
```

### ConstraintTemplate: Require Resource Limits

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequireresourcelimits
spec:
  crd:
    spec:
      names:
        kind: K8sRequireResourceLimits
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8srequireresourcelimits

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not has_limits(container)
        msg := sprintf("Container '%v' must specify resource limits for cpu and memory", [container.name])
      }

      has_limits(container) {
        container.resources.limits.cpu
        container.resources.limits.memory
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireResourceLimits
metadata:
  name: require-resource-limits
spec:
  enforcementAction: warn  # warn first, then switch to deny
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    excludedNamespaces:
    - kube-system
    - monitoring
```

### ConstraintTemplate: Block Host Network

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8snohostnamespace
spec:
  crd:
    spec:
      names:
        kind: K8sNoHostNamespace
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package k8snohostnamespace

      violation[{"msg": msg}] {
        input.review.object.spec.hostNetwork == true
        msg := "Pod must not use host network namespace"
      }

      violation[{"msg": msg}] {
        input.review.object.spec.hostPID == true
        msg := "Pod must not use host PID namespace"
      }

      violation[{"msg": msg}] {
        input.review.object.spec.hostIPC == true
        msg := "Pod must not use host IPC namespace"
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sNoHostNamespace
metadata:
  name: no-host-namespaces
spec:
  enforcementAction: deny
  match:
    kinds:
    - apiGroups: [""]
      kinds: ["Pod"]
    excludedNamespaces:
    - kube-system
    - kube-flannel
    - calico-system
```

## Trivy Operator for Continuous Compliance Scanning

The Trivy Operator continuously scans cluster resources for vulnerabilities and CIS compliance, storing results as Kubernetes custom resources.

```bash
helm repo add aqua https://aquasecurity.github.io/helm-charts
helm repo update

helm upgrade --install trivy-operator aqua/trivy-operator \
  --namespace trivy-system \
  --create-namespace \
  --set="trivy.ignoreUnfixed=true" \
  --set="compliance.specs[0]=k8s-cis-1.23" \
  --set="compliance.specs[1]=nsa-1.0"
```

### Querying Trivy Compliance Results

```bash
# List all compliance reports
kubectl get clustercompliancereports

# View CIS compliance summary
kubectl get clustercompliancereports cis -o json | \
  jq '{
    total_checks: (.status.summary.totalCount // 0),
    pass: (.status.summary.passCount // 0),
    fail: (.status.summary.failCount // 0),
    compliance_score: (
      if (.status.summary.totalCount // 0) > 0 then
        ((.status.summary.passCount // 0) * 100 / .status.summary.totalCount | floor)
      else 0 end
    )
  }'

# List failed CIS controls
kubectl get clustercompliancereports cis -o json | \
  jq -r '.status.controlCheck[] |
  select(.severity == "CRITICAL" or .severity == "HIGH") |
  select(.totalFail > 0) |
  "\(.id) | \(.name) | fail=\(.totalFail)"' | \
  column -t -s '|'

# Get vulnerability reports for a specific namespace
kubectl get vulnerabilityreports -n production -o json | \
  jq -r '.items[] |
  .metadata.name + " | " +
  (.report.summary.criticalCount | tostring) + " critical | " +
  (.report.summary.highCount | tostring) + " high"' | \
  column -t -s '|'
```

### ConfigAuditReport Review

```bash
# Check configuration audit findings across all namespaces
kubectl get configauditreports -A -o json | \
  jq -r '.items[] |
  select(.report.summary.criticalCount > 0 or .report.summary.highCount > 0) |
  "\(.metadata.namespace)/\(.metadata.name): critical=\(.report.summary.criticalCount) high=\(.report.summary.highCount)"'

# Get details of failed checks
kubectl get configauditreports -n production <name> -o json | \
  jq '.report.checks[] |
  select(.severity == "CRITICAL") |
  {id: .id, severity, title, description: .description[:200]}'
```

## Generating Compliance Reports for Auditors

### Automated Compliance Report Script

```bash
#!/bin/bash
# generate-compliance-report.sh
# Generates a comprehensive compliance report for auditors

set -euo pipefail

REPORT_DIR="/tmp/compliance-report-$(date +%Y%m%d)"
mkdir -p "$REPORT_DIR"

echo "Generating Kubernetes CIS Compliance Report"
echo "Date: $(date -u)"
echo "Cluster: $(kubectl config current-context)"

# 1. kube-bench results
echo "Running kube-bench scan..."
kubectl delete job kube-bench -n kube-system 2>/dev/null || true
kubectl create -f /etc/kubernetes/compliance/kube-bench-job.yaml
kubectl wait --for=condition=complete job/kube-bench -n kube-system --timeout=5m

kubectl logs -n kube-system job/kube-bench > "${REPORT_DIR}/kube-bench-raw.json"

# Parse results
python3 << 'PYEOF' > "${REPORT_DIR}/kube-bench-summary.json"
import json, sys

with open('/tmp/compliance-report-$(date +%Y%m%d)/kube-bench-raw.json') as f:
    results = json.load(f)

summary = {"pass": 0, "fail": 0, "warn": 0, "info": 0, "findings": []}
for control in results.get("Controls", []):
    for test in control.get("tests", []):
        for result in test.get("results", []):
            status = result["status"].lower()
            summary[status] = summary.get(status, 0) + 1
            if status == "fail":
                summary["findings"].append({
                    "id": result["test_number"],
                    "description": result["test_desc"],
                    "remediation": result.get("remediation", ""),
                    "level": result.get("test_level", 1)
                })

print(json.dumps(summary, indent=2))
PYEOF

# 2. Gatekeeper violations
echo "Collecting Gatekeeper violations..."
kubectl get constraints -A -o json | \
  jq '[.items[] |
  select(.status.totalViolations > 0) |
  {
    name: .metadata.name,
    kind: .kind,
    violations: .status.totalViolations,
    details: [.status.violations[]? | {resource: "\(.kind)/\(.name)", namespace: .namespace, message: .message}]
  }]' > "${REPORT_DIR}/gatekeeper-violations.json"

# 3. RBAC audit
echo "Running RBAC audit..."
cat > "${REPORT_DIR}/rbac-audit.json" << 'EOF'
{
  "cluster_admin_bindings": null,
  "wildcard_roles": null,
  "service_account_tokens": null
}
EOF

# Cluster-admin bindings
kubectl get clusterrolebindings -o json | \
  jq '[.items[] |
  select(.roleRef.name == "cluster-admin") |
  {name: .metadata.name, subjects: .subjects}]' > "${REPORT_DIR}/cluster-admin-bindings.json"

# Wildcard RBAC roles
kubectl get clusterroles -o json | \
  jq '[.items[] |
  select(any(.rules[]?; .verbs[]? == "*" or .resources[]? == "*")) |
  select(.metadata.name | startswith("system:") | not) |
  {name: .metadata.name}]' > "${REPORT_DIR}/wildcard-roles.json"

# 4. Pod Security Standards compliance
echo "Checking Pod Security Standards..."
kubectl get namespaces -o json | \
  jq '[.items[] |
  select(.metadata.name | startswith("kube-") | not) |
  {
    name: .metadata.name,
    pss_enforce: (.metadata.labels."pod-security.kubernetes.io/enforce" // "NOT SET"),
    pss_audit: (.metadata.labels."pod-security.kubernetes.io/audit" // "NOT SET")
  } |
  select(.pss_enforce != "restricted" or .pss_audit != "restricted")
  ]' > "${REPORT_DIR}/pss-non-compliant-namespaces.json"

# 5. Certificate expiry check
echo "Checking certificate expiry..."
for cert in /etc/kubernetes/pki/*.crt /etc/kubernetes/pki/etcd/*.crt; do
  if [ -f "$cert" ]; then
    EXPIRY=$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null | cut -d= -f2)
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$EXPIRY" +%s)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    echo "{\"cert\": \"$cert\", \"days_remaining\": $DAYS_LEFT}"
  fi
done | jq -s '.' > "${REPORT_DIR}/certificate-expiry.json"

# 6. Generate HTML report
python3 << 'PYEOF' > "${REPORT_DIR}/compliance-report.html"
import json
from datetime import datetime

with open('/tmp/compliance-report-*/kube-bench-summary.json') as f:
    bench = json.load(f)

with open('/tmp/compliance-report-*/gatekeeper-violations.json') as f:
    violations = json.load(f)

html = f"""<!DOCTYPE html>
<html>
<head><title>Kubernetes CIS Compliance Report</title>
<style>
body {{ font-family: Arial, sans-serif; margin: 20px; }}
.pass {{ color: green; }} .fail {{ color: red; }} .warn {{ color: orange; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
th {{ background-color: #f2f2f2; }}
</style>
</head>
<body>
<h1>Kubernetes CIS Benchmark Compliance Report</h1>
<p>Generated: {datetime.utcnow().isoformat()}Z</p>
<h2>Summary</h2>
<table>
<tr><th>Status</th><th>Count</th></tr>
<tr><td class="pass">PASS</td><td>{bench.get("pass", 0)}</td></tr>
<tr><td class="fail">FAIL</td><td>{bench.get("fail", 0)}</td></tr>
<tr><td class="warn">WARN</td><td>{bench.get("warn", 0)}</td></tr>
</table>
<h2>Failed Controls</h2>
<table>
<tr><th>ID</th><th>Description</th><th>Level</th><th>Remediation</th></tr>
{"".join(f'<tr><td>{f["id"]}</td><td>{f["description"]}</td><td>{f["level"]}</td><td>{f["remediation"][:200]}</td></tr>' for f in bench.get("findings", []))}
</table>
</body>
</html>"""

print(html)
PYEOF

echo ""
echo "=== Compliance Report Summary ==="
echo "Report directory: $REPORT_DIR"
echo ""
cat "${REPORT_DIR}/kube-bench-summary.json" | \
  jq '"PASS: \(.pass), FAIL: \(.fail), WARN: \(.warn)"' -r
echo ""
VIOLATION_COUNT=$(jq '[.[].violations] | add // 0' "${REPORT_DIR}/gatekeeper-violations.json")
echo "Gatekeeper violations: $VIOLATION_COUNT"
echo ""
echo "Non-compliant namespaces (PSS): $(jq 'length' "${REPORT_DIR}/pss-non-compliant-namespaces.json")"
echo ""
echo "Files generated:"
ls -la "$REPORT_DIR/"
```

### Compliance Dashboard in Grafana

```
# Kube-bench pass rate (from Trivy ClusterComplianceReport)
sum(kube_resourcequota_hard{resource="pods"}) by (namespace)

# Gatekeeper constraint violations
sum(kube_customresource_info{customresource_group="constraints.gatekeeper.sh"}) by (kind)

# Critical CVE count by namespace
sum(trivy_vulnerability_id{severity="CRITICAL"}) by (namespace)

# PSS non-compliant pods
count(kube_pod_info) by (namespace) unless on(namespace)
kube_namespace_labels{label_pod_security_kubernetes_io_enforce="restricted"}
```

## Compliance as Code: GitOps Integration

Store compliance policies in Git and deploy via Argo CD:

```yaml
# argocd-compliance-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cluster-compliance
  namespace: argocd
spec:
  project: platform
  source:
    repoURL: https://github.com/example/cluster-policies
    targetRevision: HEAD
    path: compliance
  destination:
    server: https://kubernetes.default.svc
    namespace: gatekeeper-system
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
```

The directory structure for compliance policies:

```
compliance/
├── gatekeeper/
│   ├── templates/
│   │   ├── require-non-root.yaml
│   │   ├── no-privileged.yaml
│   │   ├── require-limits.yaml
│   │   └── no-host-namespaces.yaml
│   └── constraints/
│       ├── require-non-root-constraint.yaml
│       ├── no-privileged-constraint.yaml
│       └── ...
├── pss/
│   └── namespace-labels.yaml
└── rbac/
    └── audit-roles.yaml
```

Compliance is not a point-in-time assessment—it is a continuous process. Automated scanning with kube-bench and Trivy detects drift from the baseline. Gatekeeper policies enforce controls at admission time, preventing non-compliant resources from entering the cluster. GitOps management of policies ensures that compliance controls are versioned, reviewed, and deployed consistently across all environments.
