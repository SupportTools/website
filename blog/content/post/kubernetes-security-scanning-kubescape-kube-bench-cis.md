---
title: "Kubernetes Security Scanning: kubescape, kube-bench, and CIS Benchmarks"
date: 2029-11-07T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "CIS Benchmarks", "kubescape", "kube-bench", "DevSecOps", "Compliance"]
categories:
- Kubernetes
- Security
- DevSecOps
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes security scanning with CIS Kubernetes Benchmark, kubescape NSA/MITRE frameworks, kube-bench automated checks, remediation workflows, and CI gate integration."
more_link: "yes"
url: "/kubernetes-security-scanning-kubescape-kube-bench-cis/"
---

Security posture management for Kubernetes clusters requires systematic scanning across multiple dimensions: node configuration, API server hardening, workload policy compliance, and RBAC auditing. This post provides a practical framework for implementing continuous security scanning using kubescape and kube-bench, aligned with CIS Kubernetes Benchmarks and NSA/MITRE hardening guidance.

<!--more-->

# Kubernetes Security Scanning: kubescape, kube-bench, and CIS Benchmarks

## The Security Scanning Landscape

Kubernetes security scanning tools fall into three broad categories:

| Category | Tools | Scope |
|----------|-------|-------|
| Node/infrastructure | kube-bench, Lynis | OS config, kubelet, etcd, API server |
| Policy/workload | kubescape, Polaris, kube-score | Pod specs, RBAC, network policies |
| Image scanning | Trivy, Grype, Snyk | Container image CVEs |
| Runtime | Falco, Tetragon | Active threat detection |

This post focuses on the first two categories - static configuration scanning that can be integrated into CI/CD pipelines and scheduled cluster audits.

## CIS Kubernetes Benchmark Overview

The Center for Internet Security (CIS) Kubernetes Benchmark is the industry-standard framework for evaluating Kubernetes security. It covers:

- **Control Plane Components**: API server flags, controller manager settings, scheduler configuration
- **etcd**: Data encryption at rest, TLS configuration, access control
- **Kubelet**: Authentication, authorization mode, pod security
- **Worker Nodes**: OS hardening, kubelet, container runtime
- **Policies**: Pod Security Admission, RBAC, network policies, secrets management

The benchmark uses a scoring system:
- **Level 1**: Practical recommendations with minimal service impact
- **Level 2**: More hardened settings that may require operational changes
- **Scored**: Affects the benchmark score if not implemented
- **Not Scored**: Recommendations without automatic scoring impact

### Benchmark Versions

| Kubernetes Version | CIS Benchmark Version |
|-------------------|----------------------|
| 1.25-1.27 | CIS Kubernetes Benchmark v1.8 |
| 1.28-1.29 | CIS Kubernetes Benchmark v1.9 |
| 1.30+ | CIS Kubernetes Benchmark v1.10 |

## kube-bench: Automated CIS Benchmark Checks

kube-bench is the reference implementation for automated CIS Kubernetes Benchmark compliance checking. It runs checks against the running configuration of each component.

### Installation and Quick Start

```bash
# Run kube-bench as a Kubernetes Job (recommended for cluster access)
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job.yaml

# Watch for completion
kubectl wait --for=condition=complete job/kube-bench -n default --timeout=60s

# Get results
kubectl logs job/kube-bench

# Cleanup
kubectl delete job kube-bench
```

### Running kube-bench Locally

```bash
# Install kube-bench binary
curl -L https://github.com/aquasecurity/kube-bench/releases/latest/download/kube-bench_linux_amd64.tar.gz | tar xz
chmod +x kube-bench

# Run on control plane node
./kube-bench run --targets master

# Run on worker node
./kube-bench run --targets node

# Run with specific CIS benchmark version
./kube-bench run --version 1.29

# Output as JSON for CI processing
./kube-bench run --json --outputfile /tmp/kube-bench-results.json

# Run specific checks only
./kube-bench run --check 1.2.1,1.2.2,1.3.1
```

### kube-bench as a DaemonSet

For continuous compliance monitoring across all nodes:

```yaml
# kube-bench-daemonset.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: kube-bench-config
  namespace: security
data:
  run.sh: |
    #!/bin/bash
    set -e

    # Determine node role
    if kubectl get node $(hostname) -o jsonpath='{.metadata.labels}' 2>/dev/null | grep -q "node-role.kubernetes.io/control-plane"; then
        TARGET="master"
    else
        TARGET="node"
    fi

    echo "Running kube-bench for target: $TARGET"

    /usr/local/bin/kube-bench run \
        --targets $TARGET \
        --json \
        --outputfile /output/$(hostname)-$(date +%Y%m%d-%H%M%S).json

    echo "Scan complete. Results written to /output/"

    # Keep the container running for log inspection
    sleep 3600
---
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
        image: aquasec/kube-bench:latest
        command: ["/usr/local/bin/kube-bench"]
        args: ["run", "--targets", "master", "--json"]
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
        - name: etc-cni-netd
          mountPath: /etc/cni/net.d
          readOnly: true
        - name: opt-cni-bin
          mountPath: /opt/cni/bin
          readOnly: true
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
      - name: etc-cni-netd
        hostPath:
          path: /etc/cni/net.d
      - name: opt-cni-bin
        hostPath:
          path: /opt/cni/bin
      restartPolicy: Never
  backoffLimit: 1
```

### Parsing kube-bench JSON Output

```python
#!/usr/bin/env python3
# parse-kube-bench.py - Parse kube-bench JSON output

import json
import sys
from dataclasses import dataclass
from typing import List, Optional

@dataclass
class CheckResult:
    test_number: str
    description: str
    status: str  # PASS, FAIL, WARN, INFO
    scored: bool
    reason: Optional[str] = None
    remediation: Optional[str] = None

def parse_results(filepath: str) -> List[CheckResult]:
    with open(filepath) as f:
        data = json.load(f)

    results = []
    for control in data.get("Controls", []):
        for test in control.get("tests", []):
            for result in test.get("results", []):
                results.append(CheckResult(
                    test_number=result.get("test_number", ""),
                    description=result.get("test_desc", ""),
                    status=result.get("status", ""),
                    scored=result.get("scored", True),
                    reason=result.get("reason", ""),
                    remediation=result.get("remediation", ""),
                ))
    return results

def print_summary(results: List[CheckResult]):
    stats = {"PASS": 0, "FAIL": 0, "WARN": 0, "INFO": 0}
    failures = []

    for r in results:
        stats[r.status] = stats.get(r.status, 0) + 1
        if r.status == "FAIL" and r.scored:
            failures.append(r)

    print(f"Results: PASS={stats['PASS']} FAIL={stats['FAIL']} WARN={stats['WARN']} INFO={stats['INFO']}")
    print(f"\nScored failures ({len(failures)}):")
    for f in failures:
        print(f"  [{f.test_number}] {f.description}")
        if f.remediation:
            print(f"    Remediation: {f.remediation[:120]}...")

    # Exit with error if scored failures exist
    if failures:
        sys.exit(1)

if __name__ == "__main__":
    results = parse_results(sys.argv[1])
    print_summary(results)
```

## kubescape: NSA/MITRE Framework Scanning

kubescape evaluates Kubernetes clusters against multiple security frameworks simultaneously, including NSA Kubernetes Hardening Guidance, MITRE ATT&CK, and custom controls.

### Installation

```bash
# Linux/macOS
curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | /bin/bash

# Verify
kubescape version

# Helm installation for in-cluster operator
helm repo add kubescape https://kubescape.github.io/helm-charts/
helm install kubescape kubescape/kubescape-operator \
    -n kubescape --create-namespace \
    --set clusterName=$(kubectl config current-context)
```

### Running Framework Scans

```bash
# Scan against NSA framework
kubescape scan framework nsa --verbose

# Scan against MITRE ATT&CK
kubescape scan framework mitre --verbose

# Scan against all frameworks
kubescape scan framework all --verbose

# Scan against CIS Kubernetes Benchmark
kubescape scan framework cis-k8s --verbose

# Output as JSON
kubescape scan framework nsa --format json --output results/nsa-scan.json

# Scan specific namespaces only
kubescape scan framework nsa --include-namespaces production,staging

# Exclude namespaces
kubescape scan framework nsa --exclude-namespaces kube-system,monitoring

# Set a compliance threshold (non-zero exit code if below threshold)
kubescape scan framework nsa --compliance-threshold 75
```

### Scanning YAML Files Before Deployment

```bash
# Scan a single manifest
kubescape scan deployment.yaml

# Scan a directory of manifests
kubescape scan manifests/

# Scan Helm chart before deployment
helm template myapp ./charts/myapp | kubescape scan -

# Scan a specific control
kubescape scan control C-0017  # Run as root

# List all controls
kubescape list controls

# List available frameworks
kubescape list frameworks
```

### CI Gate Integration

```yaml
# .github/workflows/security-scan.yml
name: Security Scan

on:
  pull_request:
    paths:
    - 'k8s/**'
    - 'charts/**'

jobs:
  kubescape:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Install kubescape
      run: curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | /bin/bash

    - name: Scan Kubernetes manifests
      run: |
        kubescape scan framework nsa \
          --format junit \
          --output kubescape-results.xml \
          --compliance-threshold 80 \
          k8s/

    - name: Scan Helm charts
      run: |
        helm template myapp ./charts/myapp | kubescape scan \
          --format json \
          --output helm-scan-results.json \
          -

    - name: Parse and comment on PR
      uses: actions/github-script@v7
      with:
        script: |
          const fs = require('fs');
          const results = JSON.parse(fs.readFileSync('helm-scan-results.json', 'utf8'));
          const score = results.summaryDetails?.complianceScore || 0;

          const body = `## Security Scan Results
          **Compliance Score**: ${score}%
          **Passed**: ${results.summaryDetails?.passed || 0}
          **Failed**: ${results.summaryDetails?.failed || 0}

          ${score < 80 ? '> Warning: Compliance score below 80% threshold' : '> Scan passed'}`;

          github.rest.issues.createComment({
            issue_number: context.issue.number,
            owner: context.repo.owner,
            repo: context.repo.repo,
            body: body
          });

    - name: Upload results
      uses: actions/upload-artifact@v4
      if: always()
      with:
        name: security-scan-results
        path: |
          kubescape-results.xml
          helm-scan-results.json

  kube-bench:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
    - name: Setup Kind cluster
      uses: helm/kind-action@v1.8.0

    - name: Run kube-bench
      run: |
        kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-master.yaml
        kubectl wait --for=condition=complete job/kube-bench-master --timeout=120s
        kubectl logs job/kube-bench-master > kube-bench-results.txt
        cat kube-bench-results.txt

    - name: Check for critical failures
      run: |
        FAIL_COUNT=$(grep -c "^\[FAIL\]" kube-bench-results.txt || true)
        echo "FAIL count: $FAIL_COUNT"
        if [ "$FAIL_COUNT" -gt 10 ]; then
            echo "Too many CIS benchmark failures: $FAIL_COUNT"
            exit 1
        fi
```

### Gitlab CI Integration

```yaml
# .gitlab-ci.yml
security-scan:
  stage: security
  image: docker:latest
  services:
  - docker:dind
  variables:
    KUBESCAPE_THRESHOLD: "70"
  script:
  - docker run --rm
      -v $(pwd):/workspace
      -w /workspace
      quay.io/kubescape/kubescape:latest
      scan framework nsa
      --compliance-threshold $KUBESCAPE_THRESHOLD
      --format json
      --output /workspace/results.json
      k8s/
  artifacts:
    reports:
      junit: results.xml
    paths:
    - results.json
    when: always
    expire_in: 30 days
  rules:
  - if: $CI_MERGE_REQUEST_IID
    changes:
    - k8s/**/*
    - charts/**/*
```

## Common CIS Benchmark Failures and Remediation

### 1.2.1 - API Server Anonymous Auth

```bash
# Check current setting
kubectl get pod kube-apiserver-<node> -n kube-system -o jsonpath='{.spec.containers[0].command}' | \
    tr ' ' '\n' | grep anonymous

# Remediation: add to kube-apiserver manifest
# /etc/kubernetes/manifests/kube-apiserver.yaml
```

```yaml
# kube-apiserver.yaml remediation
spec:
  containers:
  - command:
    - kube-apiserver
    - --anonymous-auth=false                    # CIS 1.2.1
    - --audit-log-path=/var/log/audit.log       # CIS 1.2.18
    - --audit-log-maxage=30                     # CIS 1.2.19
    - --audit-log-maxbackup=10                  # CIS 1.2.20
    - --audit-log-maxsize=100                   # CIS 1.2.21
    - --authorization-mode=Node,RBAC            # CIS 1.2.7
    - --enable-admission-plugins=NodeRestriction,PodSecurity  # CIS 1.2.10
    - --encryption-provider-config=/etc/kubernetes/encryption.yaml  # CIS 1.2.33
    - --tls-min-version=VersionTLS12            # CIS 1.2.30
    - --tls-cipher-suites=TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256  # CIS 1.2.31
    - --kubelet-certificate-authority=/etc/kubernetes/pki/ca.crt  # CIS 1.2.3
    - --kubelet-client-certificate=/etc/kubernetes/pki/apiserver-kubelet-client.crt
    - --kubelet-client-key=/etc/kubernetes/pki/apiserver-kubelet-client.key
```

### 1.3.1 - Controller Manager Profiling

```yaml
# kube-controller-manager.yaml
spec:
  containers:
  - command:
    - kube-controller-manager
    - --profiling=false                         # CIS 1.3.1
    - --terminated-pod-gc-threshold=10          # CIS 1.3.1
    - --use-service-account-credentials=true    # CIS 1.3.4
    - --service-account-private-key-file=/etc/kubernetes/pki/sa.key  # CIS 1.3.5
    - --root-ca-file=/etc/kubernetes/pki/ca.crt  # CIS 1.3.6
    - --feature-gates=RotateKubeletServerCertificate=true  # CIS 1.3.7
    - --bind-address=127.0.0.1                  # CIS 1.3.7
```

### 4.2.1 - Kubelet Anonymous Auth

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
authentication:
  anonymous:
    enabled: false                              # CIS 4.2.1
  webhook:
    enabled: true                               # CIS 4.2.2
    cacheTTL: 2m0s
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
authorization:
  mode: Webhook                                 # CIS 4.2.2
  webhook:
    cacheAuthorizedTTL: 5m0s
    cacheUnauthorizedTTL: 30s
protectKernelDefaults: true                     # CIS 4.2.6
readOnlyPort: 0                                 # CIS 4.2.4
eventRecordQPS: 5
tlsCertFile: /var/lib/kubelet/pki/kubelet.crt
tlsPrivateKeyFile: /var/lib/kubelet/pki/kubelet.key
rotateCertificates: true                        # CIS 4.2.11
serverTLSBootstrap: true                        # CIS 4.2.12
```

### Workload Policy Fixes

```yaml
# Non-compliant deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-deployment
spec:
  template:
    spec:
      containers:
      - name: app
        image: myapp:latest
        # Missing: security context, resource limits, non-root user
---
# CIS-compliant deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: good-deployment
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true                       # C-0013: Run as non-root
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault                   # C-0034: Seccomp profile
      automountServiceAccountToken: false        # C-0034: No unnecessary SA token
      containers:
      - name: app
        image: myapp:1.2.3                       # Use specific tag, not latest
        securityContext:
          allowPrivilegeEscalation: false        # C-0016: No privilege escalation
          readOnlyRootFilesystem: true           # C-0017: Read-only root FS
          capabilities:
            drop:
            - ALL                               # C-0046: Drop all capabilities
            add:
            - NET_BIND_SERVICE                  # Add only what's needed
          runAsNonRoot: true
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"                     # C-0009: Resource limits required
        ports:
        - containerPort: 8080
          protocol: TCP
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
        volumeMounts:
        - name: tmp
          mountPath: /tmp                       # Writable temp dir since root FS is read-only
      volumes:
      - name: tmp
        emptyDir: {}
```

## kubescape Controls Reference

Key kubescape controls and their descriptions:

```bash
# C-0001: Forbidden Container Registries
# Prevent pods from using unauthorized registries
kubescape scan control C-0001

# C-0009: Resource Limits
# All containers must have CPU and memory limits
kubescape scan control C-0009

# C-0013: Non-root containers
# Containers must not run as root (UID 0)
kubescape scan control C-0013

# C-0016: Allow privilege escalation
# allowPrivilegeEscalation must be false
kubescape scan control C-0016

# C-0017: Immutable container filesystem
# readOnlyRootFilesystem must be true
kubescape scan control C-0017

# C-0020: Sensitive capabilities
# Check for dangerous capabilities like SYS_ADMIN, NET_ADMIN
kubescape scan control C-0020

# C-0034: Automatic SA token mounting
# automountServiceAccountToken should be false unless needed
kubescape scan control C-0034

# C-0044: Container hostPort
# Using hostPort bypasses network policies
kubescape scan control C-0044

# C-0045: Writable hostPath mount
# hostPath mounts with write access are dangerous
kubescape scan control C-0045

# C-0046: Insecure capabilities
# Containers should drop all capabilities
kubescape scan control C-0046

# View control details
kubescape scan control C-0016 --verbose
```

## Remediation Workflow Automation

### Automated Remediation Script

```bash
#!/bin/bash
# remediate-security.sh - Apply common security remediations

set -euo pipefail

NAMESPACE=${1:-default}

echo "=== Security Remediation for namespace: $NAMESPACE ==="

# Add default deny NetworkPolicy to all namespaces
apply_network_policy() {
    local ns=$1
    cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: $ns
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
EOF
    echo "Applied default-deny NetworkPolicy to $ns"
}

# Find deployments without resource limits
find_limitless_deployments() {
    kubectl get deployments -n $NAMESPACE -o json | \
        jq -r '.items[] | select(.spec.template.spec.containers[].resources.limits == null) | .metadata.name'
}

# Find pods running as root
find_root_pods() {
    kubectl get pods -n $NAMESPACE -o json | \
        jq -r '.items[] | select(
            (.spec.securityContext.runAsNonRoot != true) and
            (.spec.containers[].securityContext.runAsNonRoot != true)
        ) | .metadata.name'
}

# Report findings
echo ""
echo "=== Findings ==="
echo ""
echo "Deployments without resource limits:"
find_limitless_deployments || echo "  None found or error checking"

echo ""
echo "Pods potentially running as root:"
find_root_pods || echo "  None found or error checking"

echo ""
echo "=== Recommended Actions ==="
echo "1. Add resource limits to all deployments"
echo "2. Set runAsNonRoot: true in pod security contexts"
echo "3. Apply default-deny NetworkPolicies"
echo "4. Enable PodSecurity admission labels"

# Apply namespace labels for Pod Security Standards
kubectl label namespace $NAMESPACE \
    pod-security.kubernetes.io/enforce=restricted \
    pod-security.kubernetes.io/enforce-version=latest \
    pod-security.kubernetes.io/warn=restricted \
    pod-security.kubernetes.io/warn-version=latest \
    --overwrite

echo ""
echo "Applied Pod Security Standards labels to namespace $NAMESPACE"
```

### OPA/Gatekeeper Policies for Common Failures

```yaml
# gatekeeper-require-limits.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: requireresourcelimits
spec:
  crd:
    spec:
      names:
        kind: RequireResourceLimits
  targets:
  - target: admission.k8s.gatekeeper.sh
    rego: |
      package requireresourcelimits

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.limits.cpu
        msg := sprintf("Container '%v' missing CPU limit", [container.name])
      }

      violation[{"msg": msg}] {
        container := input.review.object.spec.containers[_]
        not container.resources.limits.memory
        msg := sprintf("Container '%v' missing memory limit", [container.name])
      }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: RequireResourceLimits
metadata:
  name: require-resource-limits
spec:
  match:
    kinds:
    - apiGroups: ["apps"]
      kinds: ["Deployment", "StatefulSet", "DaemonSet"]
    namespaces:
    - production
    - staging
```

## Scheduled Scanning with CronJob

```yaml
# security-scan-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: security-scan
  namespace: security
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: kubescape-sa
          containers:
          - name: kubescape
            image: quay.io/kubescape/kubescape:latest
            command:
            - /bin/sh
            - -c
            - |
              DATE=$(date +%Y%m%d)
              kubescape scan framework nsa \
                  --format json \
                  --output /reports/nsa-${DATE}.json

              kubescape scan framework mitre \
                  --format json \
                  --output /reports/mitre-${DATE}.json

              # Send summary to Slack
              NSA_SCORE=$(cat /reports/nsa-${DATE}.json | jq -r '.summaryDetails.complianceScore')
              MITRE_SCORE=$(cat /reports/mitre-${DATE}.json | jq -r '.summaryDetails.complianceScore')

              curl -s -X POST \
                  -H 'Content-type: application/json' \
                  --data "{\"text\": \"Security Scan Results\nNSA Framework: ${NSA_SCORE}%\nMITRE ATT&CK: ${MITRE_SCORE}%\"}" \
                  https://hooks.slack.com/services/<WORKSPACE_ID>/<CHANNEL_ID>/<WEBHOOK_TOKEN>
            volumeMounts:
            - name: reports
              mountPath: /reports
          volumes:
          - name: reports
            persistentVolumeClaim:
              claimName: security-reports-pvc
          restartPolicy: OnFailure
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubescape-sa
  namespace: security
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubescape-scanner
rules:
- apiGroups: [""]
  resources: ["*"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps", "extensions", "networking.k8s.io", "rbac.authorization.k8s.io", "policy"]
  resources: ["*"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubescape-scanner
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubescape-scanner
subjects:
- kind: ServiceAccount
  name: kubescape-sa
  namespace: security
```

## RBAC Audit

```bash
# Audit RBAC permissions - find overprivileged service accounts
# List all ClusterRoleBindings with cluster-admin
kubectl get clusterrolebindings -o json | \
    jq -r '.items[] | select(.roleRef.name == "cluster-admin") |
    .metadata.name + " -> " + (.subjects[]? | .kind + "/" + .name)'

# List service accounts with wildcard permissions
kubectl get clusterroles -o json | \
    jq -r '.items[] | select(.rules[]?.verbs[]? == "*") |
    .metadata.name'

# kubescape RBAC scan
kubescape scan control C-0035  # Cluster-admin binding
kubescape scan control C-0036  # Allowed roles
kubescape scan control C-0041  # HostNetwork access
kubescape scan control C-0057  # RBAC least privilege

# Find all roles/bindings for a service account
SA_NAME=myapp
SA_NS=production
kubectl get rolebindings,clusterrolebindings --all-namespaces -o json | \
    jq -r --arg sa "$SA_NAME" --arg ns "$SA_NS" '
    .items[] | select(
        .subjects[]? |
        select(.kind == "ServiceAccount" and .name == $sa and .namespace == $ns)
    ) | .metadata.name + " in " + (.metadata.namespace // "cluster-wide")'
```

## Metrics and Compliance Dashboard

```yaml
# Prometheus rules for security compliance tracking
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: security-compliance
  namespace: monitoring
spec:
  groups:
  - name: security
    interval: 1h
    rules:
    - record: kubescape:compliance_score:nsa
      expr: |
        # This requires kubescape operator with Prometheus integration
        kubescape_framework_compliance_score{framework="nsa"}

    - alert: LowComplianceScore
      expr: kubescape_framework_compliance_score < 70
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "Low security compliance score for {{ $labels.framework }}"
        description: "Compliance score is {{ $value }}%, below 70% threshold"

    - alert: CriticalSecurityControl
      expr: kubescape_control_failed_resources{severity="critical"} > 0
      for: 15m
      labels:
        severity: critical
      annotations:
        summary: "Critical security control failing: {{ $labels.control_name }}"
```

## Summary

A comprehensive Kubernetes security scanning strategy requires multiple tools working together:

- **kube-bench** validates node-level and control-plane configuration against CIS Kubernetes Benchmarks; run it as a Job on each node type after cluster provisioning and after any node configuration changes
- **kubescape** evaluates workload configurations against NSA, MITRE ATT&CK, and CIS frameworks; integrate it into CI pipelines to catch policy violations before deployment
- **CIS Benchmark remediation** focuses on API server flags (`--anonymous-auth=false`, `--authorization-mode=Node,RBAC`), kubelet configuration (`readOnlyPort=0`, `webhook` authorization), and etcd encryption
- **OPA/Gatekeeper policies** enforce compliance continuously as an admission webhook, preventing non-compliant workloads from being deployed
- **Scheduled scanning** with CronJobs provides continuous compliance monitoring with alerting when scores drop below thresholds

The goal is to make security scanning a standard part of the development workflow rather than a periodic audit, shifting security checks as early as possible in the CI/CD pipeline.
