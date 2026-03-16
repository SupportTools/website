---
title: "kube-bench: Automated CIS Kubernetes Benchmark Compliance Scanning"
date: 2027-02-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "kube-bench", "CIS", "Compliance", "Security"]
categories: ["Kubernetes", "Security", "Compliance"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying kube-bench for CIS Kubernetes Benchmark compliance scanning: installation methods, result interpretation, automated remediation, CI/CD integration, and SIEM reporting."
more_link: "yes"
url: "/kubebench-cis-kubernetes-compliance-automated-scanning-guide/"
---

The **CIS Kubernetes Benchmark** is the de facto standard for hardening Kubernetes cluster configurations against security threats. Maintained by the Center for Internet Security, it provides more than 100 specific configuration checks spanning the API server, etcd, kubelet, scheduler, and network policies. **kube-bench** is the open-source tool that automates these checks against a running cluster and produces machine-readable compliance reports. This guide covers production deployment, result interpretation, automated remediation, and integration into compliance pipelines.

<!--more-->

## CIS Kubernetes Benchmark Structure

### Check Categories

The CIS Kubernetes Benchmark is organized into numbered sections:

| Section | Scope | Example Checks |
|---|---|---|
| 1.x | Control Plane Components | API server flags, authentication configuration |
| 1.1 | Master node configuration files | `kube-apiserver.yaml` permissions |
| 1.2 | API Server | `--anonymous-auth=false`, `--audit-log-path`, TLS configuration |
| 1.3 | Controller Manager | `--bind-address=127.0.0.1`, rotation certificates |
| 1.4 | Scheduler | `--bind-address=127.0.0.1` |
| 2.x | etcd | TLS client/server certificates, authorization |
| 3.x | Control Plane Configuration | Logging, audit policies |
| 4.x | Worker Nodes | kubelet flags, systemd service permissions |
| 5.x | Kubernetes Policies | RBAC, network policies, pod security |

### Check Status Meanings

Each check produces one of four statuses:

- **PASS**: The check passed; the configuration is compliant
- **FAIL**: The check failed; remediation is required for compliance
- **WARN**: The check could not be automatically verified; manual review required
- **INFO**: Informational output; not a pass/fail check

WARN checks are common for organizational controls (such as ensuring an audit policy is appropriate for the environment) that cannot be evaluated by tool output alone.

## kube-bench Installation Methods

### Method 1: Kubernetes Job (Recommended for One-Time Scans)

Running kube-bench as a Kubernetes Job is the cleanest approach for periodic compliance reporting. The Job mounts host paths to access node configuration files:

```yaml
# kube-bench-job-master.yaml - scan control plane components
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-master
  namespace: kube-system
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
      - key: node-role.kubernetes.io/master
        operator: Exists
        effect: NoSchedule
      restartPolicy: Never
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:v0.8.0
        command: ["kube-bench", "run", "--targets", "master,etcd,controlplane,policies"]
        volumeMounts:
        - name: var-lib-etcd
          mountPath: /var/lib/etcd
          readOnly: true
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: var-lib-kube-scheduler
          mountPath: /var/lib/kube-scheduler
          readOnly: true
        - name: var-lib-kube-controller-manager
          mountPath: /var/lib/kube-controller-manager
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: lib-systemd
          mountPath: /lib/systemd/
          readOnly: true
        - name: srv-kubernetes
          mountPath: /srv/kubernetes/
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
        - name: usr-bin
          mountPath: /usr/local/mount-from-host/bin
          readOnly: true
        - name: etc-cni-netd
          mountPath: /etc/cni/net.d/
          readOnly: true
        - name: opt-cni-bin
          mountPath: /opt/cni/bin/
          readOnly: true
      volumes:
      - name: var-lib-etcd
        hostPath:
          path: "/var/lib/etcd"
      - name: var-lib-kubelet
        hostPath:
          path: "/var/lib/kubelet"
      - name: var-lib-kube-scheduler
        hostPath:
          path: "/var/lib/kube-scheduler"
      - name: var-lib-kube-controller-manager
        hostPath:
          path: "/var/lib/kube-controller-manager"
      - name: etc-systemd
        hostPath:
          path: "/etc/systemd"
      - name: lib-systemd
        hostPath:
          path: "/lib/systemd"
      - name: srv-kubernetes
        hostPath:
          path: "/srv/kubernetes"
      - name: etc-kubernetes
        hostPath:
          path: "/etc/kubernetes"
      - name: usr-bin
        hostPath:
          path: "/usr/bin"
      - name: etc-cni-netd
        hostPath:
          path: "/etc/cni/net.d/"
      - name: opt-cni-bin
        hostPath:
          path: "/opt/cni/bin/"
```

```yaml
# kube-bench-job-worker.yaml - scan worker nodes
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-worker
  namespace: kube-system
spec:
  template:
    spec:
      hostPID: true
      restartPolicy: Never
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:v0.8.0
        command: ["kube-bench", "run", "--targets", "node,policies"]
        volumeMounts:
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: lib-systemd
          mountPath: /lib/systemd/
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
        - name: etc-cni-netd
          mountPath: /etc/cni/net.d/
          readOnly: true
        - name: opt-cni-bin
          mountPath: /opt/cni/bin/
          readOnly: true
      volumes:
      - name: var-lib-kubelet
        hostPath:
          path: "/var/lib/kubelet"
      - name: etc-systemd
        hostPath:
          path: "/etc/systemd"
      - name: lib-systemd
        hostPath:
          path: "/lib/systemd"
      - name: etc-kubernetes
        hostPath:
          path: "/etc/kubernetes"
      - name: etc-cni-netd
        hostPath:
          path: "/etc/cni/net.d/"
      - name: opt-cni-bin
        hostPath:
          path: "/opt/cni/bin/"
```

Retrieve results:

```bash
kubectl apply -f kube-bench-job-master.yaml
kubectl wait --for=condition=complete job/kube-bench-master -n kube-system --timeout=300s
kubectl logs job/kube-bench-master -n kube-system
```

### Method 2: DaemonSet (Continuous Scanning)

A DaemonSet approach runs kube-bench on every node continuously, useful for drift detection:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kube-bench
  namespace: kube-system
  labels:
    app: kube-bench
spec:
  selector:
    matchLabels:
      app: kube-bench
  template:
    metadata:
      labels:
        app: kube-bench
    spec:
      hostPID: true
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:v0.8.0
        command:
        - /bin/sh
        - -c
        - |
          # Detect node role and run appropriate checks
          if [ -f /etc/kubernetes/manifests/kube-apiserver.yaml ]; then
            kube-bench run --targets master,etcd,controlplane,policies --json > /output/results.json
          else
            kube-bench run --targets node,policies --json > /output/results.json
          fi
          # Sleep to prevent container restart loop
          sleep 86400
        volumeMounts:
        - name: var-lib-etcd
          mountPath: /var/lib/etcd
          readOnly: true
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: lib-systemd
          mountPath: /lib/systemd
          readOnly: true
        - name: output
          mountPath: /output
      volumes:
      - name: var-lib-etcd
        hostPath:
          path: "/var/lib/etcd"
      - name: var-lib-kubelet
        hostPath:
          path: "/var/lib/kubelet"
      - name: etc-kubernetes
        hostPath:
          path: "/etc/kubernetes"
      - name: etc-systemd
        hostPath:
          path: "/etc/systemd"
      - name: lib-systemd
        hostPath:
          path: "/lib/systemd"
      - name: output
        hostPath:
          path: "/var/log/kube-bench"
```

### Method 3: Standalone Binary

For air-gapped or bare-metal environments:

```bash
# Install kube-bench binary directly on the node
KUBE_BENCH_VERSION="0.8.0"
curl -Lo kube-bench.tar.gz \
  "https://github.com/aquasecurity/kube-bench/releases/download/v${KUBE_BENCH_VERSION}/kube-bench_${KUBE_BENCH_VERSION}_linux_amd64.tar.gz"
tar -xzf kube-bench.tar.gz
sudo install kube-bench /usr/local/bin/

# Run against the control plane
sudo kube-bench run --targets master

# Run against a worker node
sudo kube-bench run --targets node

# Output JSON for processing
sudo kube-bench run --targets master --json > /tmp/bench-results.json
```

## Managed Service Benchmarks: EKS, AKS, GKE

Managed Kubernetes services control the control plane configuration, so many Section 1 checks will WARN or FAIL because they check files that do not exist on managed control planes. Use the provider-specific benchmark:

```bash
# EKS-specific benchmark
kube-bench run --benchmark eks-cis-1.4.0

# AKS-specific benchmark
kube-bench run --benchmark aks-cis-1.8.0

# GKE-specific benchmark
kube-bench run --benchmark gke-cis-1.4.0
```

### EKS-Specific Considerations

On EKS, kube-bench cannot scan the control plane nodes (managed by AWS). Focus on worker node checks:

```bash
# On an EKS worker node
kube-bench run --targets node --benchmark eks-cis-1.4.0 --json > eks-worker-results.json
```

Key EKS worker node checks that frequently fail in default configurations:

- **4.1.1**: Ensure that the kubelet service file permissions are set to `644` or more restrictive
- **4.2.2**: Ensure that the `--authorization-mode` argument is not set to `AlwaysAllow`
- **4.2.7**: Ensure that the `--make-iptables-util-chains` argument is set to `true`

## Reading and Interpreting Results

### Sample Output Analysis

```
== Summary master ==
34 checks PASS
7 checks FAIL
14 checks WARN
0 checks INFO

[FAIL] 1.2.6 Ensure that the --kubelet-certificate-authority argument is set as appropriate (Automated)
[FAIL] 1.2.13 Ensure that the admission control plugin SecurityContextDeny is not set (Automated)
[FAIL] 1.2.19 Ensure that the --audit-log-maxage argument is set to 30 or as appropriate (Automated)
[FAIL] 1.2.20 Ensure that the --audit-log-maxbackup argument is set to 10 or as appropriate (Automated)
[FAIL] 1.2.21 Ensure that the --audit-log-maxsize argument is set to 100 or as appropriate (Automated)
[FAIL] 1.2.22 Ensure that the --audit-log-path argument is set (Automated)
[FAIL] 1.3.2 Ensure that the --profiling argument is set to false (Automated)
```

### JSON Output Structure

```json
{
  "Controls": [
    {
      "id": "1",
      "version": "cis-1.9",
      "text": "Control Plane Components",
      "node_type": "master",
      "tests": [
        {
          "section": "1.2",
          "type": "master",
          "pass": 22,
          "fail": 7,
          "warn": 4,
          "info": 0,
          "desc": "API Server",
          "results": [
            {
              "test_number": "1.2.6",
              "test_desc": "Ensure that the --kubelet-certificate-authority argument is set",
              "audit": "ps -ef | grep kube-apiserver | grep -v grep",
              "AuditEnv": "",
              "AuditConfig": "",
              "type": "",
              "remediation": "Follow the Kubernetes documentation and set up the TLS connection between the apiserver and kubelets.",
              "test_info": ["flag '--kubelet-certificate-authority' not set"],
              "status": "FAIL",
              "actual_value": "",
              "scored": true,
              "IsMultiple": false,
              "expected_result": "'--kubelet-certificate-authority' is set",
              "reason": ""
            }
          ]
        }
      ]
    }
  ],
  "Totals": {
    "total_pass": 34,
    "total_fail": 7,
    "total_warn": 14,
    "total_info": 0
  }
}
```

## Automating Remediation for Common Findings

### API Server Hardening

Most API server failures relate to missing flags. For kubeadm-managed clusters, edit the static pod manifest:

```bash
# Edit the API server manifest
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
```

```yaml
# Additions to kube-apiserver command args for CIS compliance
spec:
  containers:
  - command:
    - kube-apiserver
    # Audit logging (1.2.19, 1.2.20, 1.2.21, 1.2.22)
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml
    # Authentication (1.2.1, 1.2.2)
    - --anonymous-auth=false
    - --kubelet-certificate-authority=/etc/kubernetes/pki/ca.crt
    # Authorization (1.2.7, 1.2.8)
    - --authorization-mode=Node,RBAC
    # Admission controllers (1.2.10, 1.2.11, 1.2.12, 1.2.13, 1.2.14, 1.2.15, 1.2.16)
    - --enable-admission-plugins=NodeRestriction,PodSecurity
    - --disable-admission-plugins=AlwaysAdmit
    # TLS (1.2.26, 1.2.27, 1.2.28, 1.2.29)
    - --tls-min-version=VersionTLS12
    - --tls-cipher-suites=TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
    # Profiling (1.2.21)
    - --profiling=false
    # Request timeout (1.2.38)
    - --request-timeout=300s
```

### Audit Policy Configuration

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
- RequestReceived
rules:
# Log pod create/delete/update at RequestResponse level
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods"]
  verbs: ["create", "update", "patch", "delete"]

# Log secret access at Metadata level (avoid logging secret values)
- level: Metadata
  resources:
  - group: ""
    resources: ["secrets", "configmaps"]
  verbs: ["get", "list", "watch"]

# Log exec commands
- level: RequestResponse
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]

# Log RBAC changes
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources: ["roles", "clusterroles", "rolebindings", "clusterrolebindings"]

# Minimal logging for read-only operations
- level: None
  verbs: ["get", "list", "watch"]
  users: ["system:serviceaccount:kube-system:kube-proxy"]

# Default: log at Metadata level
- level: Metadata
  omitStages:
  - RequestReceived
```

### kubelet Hardening (Check 4.2)

```yaml
# /var/lib/kubelet/config.yaml - CIS-compliant kubelet configuration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# 4.2.1 - Ensure anonymous auth is disabled
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt

# 4.2.2 - Ensure authorization mode is not AlwaysAllow
authorization:
  mode: Webhook

# 4.2.4 - Ensure kernel default module loading is disabled
protectKernelDefaults: true

# 4.2.6 - Ensure --make-iptables-util-chains is true
makeIPTablesUtilChains: true

# 4.2.7 - Ensure --hostname-override is not set (omit the key)

# 4.2.10 - Ensure --rotate-certificates is true
rotateCertificates: true

# 4.2.11 - Ensure RotateKubeletServerCertificate feature gate is true
featureGates:
  RotateKubeletServerCertificate: true

# 4.1.1 / 4.1.2 - TLS
tlsCertFile: /var/lib/kubelet/pki/kubelet.crt
tlsPrivateKeyFile: /var/lib/kubelet/pki/kubelet.key

# Event logging
eventRecordQPS: 0

# Streaming connection timeouts
streamingConnectionIdleTimeout: 4h0m0s

# Read-only port disabled (4.2.3)
readOnlyPort: 0
```

### etcd TLS Hardening (Section 2)

```yaml
# /etc/kubernetes/manifests/etcd.yaml additions
spec:
  containers:
  - command:
    - etcd
    # 2.1 - Ensure authentication is configured
    - --client-cert-auth=true
    - --auto-tls=false
    # 2.2 - Ensure peer certificate authentication
    - --peer-client-cert-auth=true
    - --peer-auto-tls=false
    # 2.3 - Ensure client cert file is configured
    - --cert-file=/etc/kubernetes/pki/etcd/server.crt
    - --key-file=/etc/kubernetes/pki/etcd/server.key
    # 2.4 - Ensure peer cert file is configured
    - --peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt
    - --peer-key-file=/etc/kubernetes/pki/etcd/peer.key
    # 2.5 - Trusted CA file
    - --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
    - --peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt
```

### RBAC Remediation (Section 5.1)

```bash
# 5.1.1 - Ensure cluster-admin role is used only where required
# List all cluster-admin bindings
kubectl get clusterrolebindings -o json | \
  jq '.items[] | select(.roleRef.name=="cluster-admin") |
      {name: .metadata.name, subjects: .subjects}'

# 5.1.3 - Ensure wildcards are not used in Roles and ClusterRoles
kubectl get clusterroles -o json | \
  jq '.items[] | select(.rules[]?.verbs[]? == "*") | .metadata.name'

kubectl get roles --all-namespaces -o json | \
  jq '.items[] | select(.rules[]?.verbs[]? == "*") |
      {namespace: .metadata.namespace, name: .metadata.name}'

# 5.1.5 - Ensure access to the default service account is restricted
# Remove automount from default service accounts
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  kubectl patch serviceaccount default -n "$ns" \
    -p '{"automountServiceAccountToken": false}' 2>/dev/null || true
done
```

## Custom Check Configuration

kube-bench supports custom check files for organization-specific requirements or to adjust remediation text:

```yaml
# /etc/kube-bench/custom/my-checks.yaml
controls:
  version: "custom-1.0"
  id: "custom"
  text: "Organization-Specific Checks"
  type: "custom"
  groups:
  - id: "custom.1"
    text: "Custom Security Controls"
    checks:
    - id: custom.1.1
      text: "Ensure Falco is deployed on all nodes"
      type: manual
      remediation: "Deploy Falco DaemonSet via Helm: helm install falco falcosecurity/falco"
      scored: false
    - id: custom.1.2
      text: "Ensure all namespaces have a NetworkPolicy default-deny"
      audit: |
        kubectl get networkpolicies --all-namespaces -o json | \
          jq '[.items[] | select(.spec.podSelector == {} and .spec.policyTypes != null)] | length'
      tests:
        test_items:
        - flag: "0"
          compare:
            op: gt
            value: "0"
      remediation: "Apply default-deny NetworkPolicy to all production namespaces"
      scored: true
```

Run with custom checks:

```bash
kube-bench run --config-dir /etc/kube-bench/custom --include-test-output
```

## JSON Output for SIEM Integration

### Parsing Results with jq

```bash
# Extract all FAIL checks with remediation text
kube-bench run --json | jq '
  .Controls[].tests[].results[]
  | select(.status == "FAIL")
  | {
      id: .test_number,
      description: .test_desc,
      remediation: .remediation,
      actual: .actual_value
    }
'

# Count fails by section
kube-bench run --json | jq '
  [.Controls[].tests[] | {
    section: .section,
    desc: .desc,
    fail: .fail,
    warn: .warn,
    pass: .pass
  }]
'

# Generate compliance score (percent passing scored checks)
kube-bench run --json | jq '
  (.Totals.total_pass / (.Totals.total_pass + .Totals.total_fail) * 100)
  | floor
  | tostring + "% CIS compliance score"
'
```

### Sending Results to Elasticsearch

```bash
#!/bin/bash
# kube-bench-to-es.sh - Ship results to Elasticsearch

CLUSTER_NAME="${CLUSTER_NAME:-production}"
ES_ENDPOINT="${ES_ENDPOINT:-https://elasticsearch.monitoring.svc.cluster.local:9200}"
ES_INDEX="kube-bench-results"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Run kube-bench and capture JSON
RESULTS=$(kube-bench run --json 2>/dev/null)

# Add metadata and ship to Elasticsearch
echo "$RESULTS" | jq --arg cluster "$CLUSTER_NAME" --arg ts "$TIMESTAMP" \
  '. + {cluster_name: $cluster, scan_timestamp: $ts, "@timestamp": $ts}' | \
  curl -s -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer EXAMPLE_TOKEN_REPLACE_ME" \
    --data-binary @- \
    "${ES_ENDPOINT}/${ES_INDEX}/_doc"

echo "Results shipped to Elasticsearch index: ${ES_INDEX}"
```

### Splunk HEC Integration

```python
#!/usr/bin/env python3
# kube-bench-to-splunk.py

import json
import subprocess
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
import os

SPLUNK_HEC_URL = os.environ.get("SPLUNK_HEC_URL", "https://splunk.example.com:8088/services/collector")
SPLUNK_TOKEN = os.environ.get("SPLUNK_TOKEN", "EXAMPLE_TOKEN_REPLACE_ME")
CLUSTER_NAME = os.environ.get("CLUSTER_NAME", "production")

def run_kube_bench():
    result = subprocess.run(
        ["kube-bench", "run", "--json"],
        capture_output=True,
        text=True
    )
    return json.loads(result.stdout)

def ship_to_splunk(data):
    event = {
        "time": datetime.now(timezone.utc).timestamp(),
        "sourcetype": "kube-bench",
        "source": "kube-bench",
        "index": "kubernetes-compliance",
        "event": {
            "cluster": CLUSTER_NAME,
            "totals": data["Totals"],
            "controls": data["Controls"]
        }
    }

    payload = json.dumps(event).encode("utf-8")
    req = urllib.request.Request(
        SPLUNK_HEC_URL,
        data=payload,
        headers={
            "Authorization": f"Splunk {SPLUNK_TOKEN}",
            "Content-Type": "application/json"
        }
    )
    with urllib.request.urlopen(req) as resp:
        return resp.read()

if __name__ == "__main__":
    results = run_kube_bench()
    ship_to_splunk(results)
    fail_count = results["Totals"]["total_fail"]
    print(f"Shipped results: {fail_count} failures")
    sys.exit(0 if fail_count == 0 else 1)
```

## CI/CD Pipeline Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/kube-bench.yml
name: CIS Kubernetes Compliance Scan

on:
  schedule:
  - cron: "0 6 * * 1"  # Weekly on Monday at 6 AM UTC
  workflow_dispatch:
    inputs:
      cluster:
        description: "Target cluster (dev/staging/prod)"
        required: true
        default: "staging"

jobs:
  compliance-scan:
    runs-on: ubuntu-latest
    steps:
    - name: Configure kubectl
      uses: azure/k8s-set-context@v3
      with:
        kubeconfig: ${{ secrets.KUBECONFIG_STAGING }}

    - name: Deploy kube-bench Job
      run: |
        kubectl apply -f - <<'EOF'
        apiVersion: batch/v1
        kind: Job
        metadata:
          name: kube-bench-ci-${{ github.run_number }}
          namespace: kube-system
        spec:
          ttlSecondsAfterFinished: 3600
          template:
            spec:
              hostPID: true
              restartPolicy: Never
              tolerations:
              - key: node-role.kubernetes.io/control-plane
                operator: Exists
                effect: NoSchedule
              nodeSelector:
                node-role.kubernetes.io/control-plane: ""
              containers:
              - name: kube-bench
                image: aquasec/kube-bench:v0.8.0
                command: ["kube-bench", "run", "--targets", "master,etcd", "--json"]
                volumeMounts:
                - name: etc-kubernetes
                  mountPath: /etc/kubernetes
                  readOnly: true
                - name: var-lib-kubelet
                  mountPath: /var/lib/kubelet
                  readOnly: true
              volumes:
              - name: etc-kubernetes
                hostPath:
                  path: /etc/kubernetes
              - name: var-lib-kubelet
                hostPath:
                  path: /var/lib/kubelet
        EOF

    - name: Wait for job completion
      run: |
        kubectl wait --for=condition=complete \
          job/kube-bench-ci-${{ github.run_number }} \
          -n kube-system \
          --timeout=300s

    - name: Collect results
      run: |
        kubectl logs job/kube-bench-ci-${{ github.run_number }} \
          -n kube-system > kube-bench-results.json

    - name: Check failure threshold
      run: |
        FAIL_COUNT=$(cat kube-bench-results.json | \
          python3 -c "import json,sys; d=json.load(sys.stdin); print(d['Totals']['total_fail'])")
        echo "CIS Benchmark failures: $FAIL_COUNT"
        if [ "$FAIL_COUNT" -gt "10" ]; then
          echo "ERROR: CIS compliance failures exceed threshold of 10"
          exit 1
        fi

    - name: Upload compliance report
      uses: actions/upload-artifact@v4
      with:
        name: kube-bench-report-${{ github.run_number }}
        path: kube-bench-results.json
        retention-days: 90
```

### CronJob for Scheduled Compliance Reporting

```yaml
# Scheduled compliance scan CronJob
apiVersion: batch/v1
kind: CronJob
metadata:
  name: kube-bench-scheduled
  namespace: kube-system
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 7
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          hostPID: true
          serviceAccountName: kube-bench
          restartPolicy: OnFailure
          tolerations:
          - key: node-role.kubernetes.io/control-plane
            operator: Exists
            effect: NoSchedule
          nodeSelector:
            node-role.kubernetes.io/control-plane: ""
          initContainers:
          - name: kube-bench
            image: aquasec/kube-bench:v0.8.0
            command:
            - /bin/sh
            - -c
            - kube-bench run --targets master,etcd,controlplane --json > /results/output.json
            volumeMounts:
            - name: etc-kubernetes
              mountPath: /etc/kubernetes
              readOnly: true
            - name: var-lib-etcd
              mountPath: /var/lib/etcd
              readOnly: true
            - name: results
              mountPath: /results
          containers:
          - name: shipper
            image: curlimages/curl:8.6.0
            command:
            - /bin/sh
            - -c
            - |
              CLUSTER="${CLUSTER_NAME:-production}"
              TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
              # Add metadata wrapper and ship to monitoring endpoint
              cat /results/output.json | \
                curl -s -X POST \
                  -H "Content-Type: application/json" \
                  -H "X-Cluster-Name: ${CLUSTER}" \
                  -H "X-Scan-Time: ${TIMESTAMP}" \
                  --data-binary @- \
                  http://compliance-collector.monitoring.svc.cluster.local/api/v1/kube-bench
            volumeMounts:
            - name: results
              mountPath: /results
          volumes:
          - name: etc-kubernetes
            hostPath:
              path: /etc/kubernetes
          - name: var-lib-etcd
            hostPath:
              path: /var/lib/etcd
          - name: results
            emptyDir: {}
```

## Comparison: kube-bench vs Kubescape vs Trivy

| Feature | kube-bench | Kubescape | Trivy |
|---|---|---|---|
| Primary focus | CIS Benchmarks | CIS + NSA + MITRE | Vulnerabilities + misconfigs |
| Control plane scanning | Yes | Yes | Limited |
| Worker node scanning | Yes | Yes | Yes |
| Image scanning | No | No | Yes |
| RBAC analysis | Limited (section 5) | Deep | Limited |
| Runtime checks | No | No | No |
| Managed service support | EKS, AKS, GKE | EKS, AKS, GKE | EKS, AKS |
| JSON output | Yes | Yes | Yes |
| Custom checks | Yes (YAML) | Yes (Rego) | Yes |
| License | Apache 2.0 | Apache 2.0 | Apache 2.0 |

Use kube-bench when CIS Benchmark compliance is a specific audit requirement. Pair it with Kubescape for broader framework coverage (NSA, MITRE ATT&CK) and Trivy for image vulnerability scanning.

## Exceptions and Accepted Risk Documentation

Compliance programs require formal documentation of accepted risks and exceptions. Maintain an exceptions register alongside kube-bench results:

```yaml
# compliance-exceptions.yaml
# Document checks that are accepted risks or not applicable
exceptions:
  - check_id: "1.2.13"
    description: "SecurityContextDeny admission plugin check"
    reason: "PodSecurity admission controller provides equivalent control in Kubernetes 1.23+"
    accepted_by: "security-team@example.com"
    accepted_date: "2026-01-15"
    review_date: "2026-07-15"
    risk_level: low

  - check_id: "3.2.1"
    description: "Ensure audit logging is configured"
    reason: "EKS managed control plane; audit logging configured via AWS CloudTrail"
    accepted_by: "platform-team@example.com"
    accepted_date: "2026-01-15"
    review_date: "2026-07-15"
    risk_level: low
    managed_service_note: "Not applicable to EKS managed control plane"

  - check_id: "1.3.7"
    description: "Ensure RotateKubeletServerCertificate is set to true"
    reason: "Using external cert-manager for certificate rotation with shorter lifetimes"
    accepted_by: "security-team@example.com"
    accepted_date: "2026-02-01"
    review_date: "2026-08-01"
    risk_level: low
    compensating_control: "cert-manager issues 24-hour kubelet server certificates"
```

This exceptions register should be version-controlled alongside cluster manifests and reviewed quarterly. Each exception requires a review date to prevent indefinite acceptance of risks.
