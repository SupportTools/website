---
title: "Kubernetes CIS Benchmark Hardening: Securing Cluster Components"
date: 2028-11-15T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "CIS Benchmark", "Hardening", "Compliance"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes CIS Benchmark compliance covering API server hardening flags, etcd encryption at rest, controller manager and scheduler security, kubelet API protection, node hardening with Falco, and integrating kube-bench into CI/CD pipelines."
more_link: "yes"
url: "/kubernetes-security-benchmark-cis-hardening-guide/"
---

The CIS Kubernetes Benchmark provides a prescriptive, consensus-based security configuration guide for Kubernetes clusters. Running kube-bench against an unconfigured cluster typically reveals dozens of failing checks. This guide works through each major benchmark section, explains the attack vector each control mitigates, and provides the exact configuration changes required to achieve and maintain compliance.

<!--more-->

# Kubernetes CIS Benchmark Hardening: Securing Cluster Components

## CIS Benchmark Overview

The CIS Kubernetes Benchmark (currently v1.9 for Kubernetes 1.29+) is organized into sections matching the control plane components:

- **Section 1**: Control Plane Node Configuration
  - 1.1: Master Node Configuration Files
  - 1.2: API Server
  - 1.3: Controller Manager
  - 1.4: Scheduler
- **Section 2**: Etcd
- **Section 3**: Control Plane Configuration (network policies, RBAC)
- **Section 4**: Worker Nodes
  - 4.1: Worker Node Configuration Files
  - 4.2: Kubelet
- **Section 5**: Policies (RBAC, pod security, network policies)

Level 1 controls are practical for most environments. Level 2 controls provide stronger security with potentially higher operational cost.

## Running kube-bench

```bash
# Run on a control plane node
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-master.yaml

# Check results
kubectl logs job/kube-bench-master

# Run on a worker node
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-node.yaml

# Run directly (if you have node access)
kube-bench run --targets=master,etcd,node --benchmark cis-1.9

# Output as JSON for automated processing
kube-bench run --json > /tmp/kube-bench-results.json
```

Parse JSON results for CI/CD integration:

```bash
#!/bin/bash
# check-cis-compliance.sh
set -euo pipefail

kube-bench run --json > /tmp/results.json

FAIL_COUNT=$(jq '[.[] | .tests[].results[] | select(.status == "FAIL")] | length' /tmp/results.json)
WARN_COUNT=$(jq '[.[] | .tests[].results[] | select(.status == "WARN")] | length' /tmp/results.json)

echo "CIS Benchmark Results:"
echo "  FAIL: ${FAIL_COUNT}"
echo "  WARN: ${WARN_COUNT}"

# Print failing checks
jq -r '.[] | .tests[].results[] | select(.status == "FAIL") | "\(.test_number) \(.test_desc)"' \
  /tmp/results.json

# Exit non-zero if any critical controls fail
CRITICAL_FAIL=$(jq '[.[] | .tests[].results[] |
  select(.status == "FAIL") |
  select(.test_number | IN("1.2.1","1.2.6","1.2.17","2.1","2.2","4.2.1"))] |
  length' /tmp/results.json)

if [ "${CRITICAL_FAIL}" -gt 0 ]; then
  echo "CRITICAL: ${CRITICAL_FAIL} critical CIS controls failing"
  exit 1
fi
```

## Section 1.2: API Server Hardening

### Anonymous Authentication (CIS 1.2.1)

```bash
# Failing check: --anonymous-auth is not set to false
# Attack: unauthenticated access to the API server

# Fix: Add to kube-apiserver flags
--anonymous-auth=false
```

In a kubeadm cluster, edit `/etc/kubernetes/manifests/kube-apiserver.yaml`:

```yaml
# /etc/kubernetes/manifests/kube-apiserver.yaml
spec:
  containers:
  - command:
    - kube-apiserver
    - --anonymous-auth=false          # CIS 1.2.1
    - --audit-log-path=/var/log/kubernetes/audit.log  # CIS 1.2.22
    - --audit-log-maxage=30           # CIS 1.2.23
    - --audit-log-maxbackup=10        # CIS 1.2.24
    - --audit-log-maxsize=100         # CIS 1.2.25
    - --audit-policy-file=/etc/kubernetes/audit-policy.yaml  # CIS 1.2.22
    - --authorization-mode=Node,RBAC  # CIS 1.2.7 (no AlwaysAllow)
    - --enable-admission-plugins=NodeRestriction,PodSecurity,ServiceAccount  # CIS 1.2.10
    - --tls-min-version=VersionTLS12  # CIS 1.2.31
    - --tls-cipher-suites=TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384  # CIS 1.2.32
    - --kubelet-certificate-authority=/etc/kubernetes/pki/ca.crt  # CIS 1.2.5
    - --service-account-lookup=true   # CIS 1.2.26
    - --service-account-key-file=/etc/kubernetes/pki/sa.pub  # CIS 1.2.27
    - --etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt  # CIS 1.2.29
    - --etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt  # CIS 1.2.29
    - --etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key   # CIS 1.2.29
    - --request-timeout=300s
    - --profiling=false               # CIS 1.2.21
```

### Audit Policy Configuration

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
# Log all requests at Metadata level for security-relevant resources
- level: RequestResponse
  resources:
  - group: ""
    resources: ["secrets", "configmaps", "serviceaccounts", "pods"]
  - group: "rbac.authorization.k8s.io"
    resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"]

# Log pod exec/attach at RequestResponse (captures what commands are run)
- level: RequestResponse
  verbs: ["create"]
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]

# Log authentication failures
- level: Metadata
  users: ["system:anonymous"]

# Don't log read-only requests for common resources (reduces volume)
- level: None
  verbs: ["get", "list", "watch"]
  resources:
  - group: ""
    resources: ["events", "endpoints", "nodes", "namespaces"]
  - group: "apps"
    resources: ["replicasets", "deployments"]

# Default: log metadata for everything else
- level: Metadata
  omitStages:
  - "RequestReceived"
```

### Admission Controllers (CIS 1.2.10-1.2.17)

```bash
# Required admission controllers
--enable-admission-plugins=\
  NodeRestriction,\
  PodSecurity,\
  ServiceAccount,\
  AlwaysPullImages,\    # Ensures images are re-fetched with credentials each time
  DenyServiceExternalIPs  # Prevents CVE-2020-8554

# Disabled by default but check these are NOT enabled:
# --disable-admission-plugins MUST NOT include: AlwaysAdmit
# --authorization-mode MUST NOT include: AlwaysAllow
```

## Section 1.3: Controller Manager Hardening

```yaml
# /etc/kubernetes/manifests/kube-controller-manager.yaml
spec:
  containers:
  - command:
    - kube-controller-manager
    - --profiling=false                    # CIS 1.3.1
    - --use-service-account-credentials=true  # CIS 1.3.3
    - --service-account-private-key-file=/etc/kubernetes/pki/sa.key  # CIS 1.3.4
    - --root-ca-file=/etc/kubernetes/pki/ca.crt  # CIS 1.3.5
    - --bind-address=127.0.0.1            # CIS 1.3.7 (don't bind to 0.0.0.0)
```

## Section 1.4: Scheduler Hardening

```yaml
# /etc/kubernetes/manifests/kube-scheduler.yaml
spec:
  containers:
  - command:
    - kube-scheduler
    - --profiling=false      # CIS 1.4.1
    - --bind-address=127.0.0.1  # CIS 1.4.2
```

## Section 2: etcd Hardening

etcd contains all cluster state including Secrets. It must be protected with mutual TLS and encryption at rest.

### etcd TLS Configuration

```yaml
# /etc/kubernetes/manifests/etcd.yaml
spec:
  containers:
  - command:
    - etcd
    - --cert-file=/etc/kubernetes/pki/etcd/server.crt   # CIS 2.1
    - --key-file=/etc/kubernetes/pki/etcd/server.key    # CIS 2.1
    - --client-cert-auth=true                           # CIS 2.2
    - --trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt # CIS 2.2
    - --peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt  # CIS 2.3
    - --peer-key-file=/etc/kubernetes/pki/etcd/peer.key   # CIS 2.3
    - --peer-client-cert-auth=true                      # CIS 2.4
    - --peer-trusted-ca-file=/etc/kubernetes/pki/etcd/ca.crt  # CIS 2.4
    - --auto-tls=false                                  # CIS 2.6
    - --peer-auto-tls=false                             # CIS 2.7
```

### Encryption at Rest for Secrets

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
  - resources:
      - secrets
      - configmaps   # Also encrypt configmaps if they contain sensitive data
    providers:
      # AES-GCM is preferred over AES-CBC (authenticated encryption)
      - aescbc:
          keys:
            - name: key1
              # Generate: head -c 32 /dev/urandom | base64
              secret: <base64-encoded-32-byte-key>
      # Identity last: means unencrypted reads still work during migration
      - identity: {}
```

Add to kube-apiserver:

```bash
--encryption-provider-config=/etc/kubernetes/encryption-config.yaml
```

Encrypt existing secrets after enabling:

```bash
# Re-write all secrets to trigger encryption
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -

# Verify a secret is encrypted in etcd
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/my-secret | hexdump -C | head

# Encrypted output starts with: k8s:enc:aescbc:v1:key1:
# Unencrypted output starts with: k8s\n
```

Rotate encryption keys:

```yaml
# Step 1: Add new key first (both keys active)
providers:
  - aescbc:
      keys:
        - name: key2   # New key first = used for encryption
          secret: <new-key>
        - name: key1   # Old key second = still used for decryption
          secret: <old-key>
  - identity: {}

# Step 2: Re-encrypt all secrets with new key
kubectl get secrets --all-namespaces -o json | kubectl replace -f -

# Step 3: Remove old key
providers:
  - aescbc:
      keys:
        - name: key2
          secret: <new-key>
  - identity: {}
```

## Section 4.2: Kubelet Hardening

The kubelet exposes a powerful API on every node. Hardening it prevents unauthorized pod execution and data exfiltration.

```yaml
# /var/lib/kubelet/config.yaml (KubeletConfiguration)
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
authentication:
  anonymous:
    enabled: false         # CIS 4.2.1: no anonymous access
  webhook:
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
authorization:
  mode: Webhook            # CIS 4.2.2: not AlwaysAllow

# CIS 4.2.3: event QPS (set to 0 = unlimited for audit purposes)
eventRecordQPS: 5

# CIS 4.2.4: ensure kubelet has certs
tlsCertFile: /var/lib/kubelet/pki/kubelet.crt
tlsPrivateKeyFile: /var/lib/kubelet/pki/kubelet.key

# CIS 4.2.5: rotate kubelet certs automatically
rotateCertificates: true

# CIS 4.2.6: protect kernel defaults
protectKernelDefaults: true

# CIS 4.2.7: set hostname override if needed for certificate matching

# CIS 4.2.8: streaming connection idle timeout
streamingConnectionIdleTimeout: 4h

# CIS 4.2.9: disable read-only port
readOnlyPort: 0

# CIS 4.2.11: secure port (default: 10250)
port: 10250

# CIS 4.2.12: TLS minimum version
tlsMinVersion: VersionTLS12

# CIS 4.2.13: TLS cipher suites
tlsCipherSuites:
  - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
  - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384

# Disable profiling
enableDebuggingHandlers: false
```

## Section 4.1: Worker Node File Permissions

```bash
#!/bin/bash
# fix-node-file-permissions.sh

# CIS 4.1.1: kubelet.service file permissions
chmod 600 /lib/systemd/system/kubelet.service
chown root:root /lib/systemd/system/kubelet.service

# CIS 4.1.3: kubelet config file
chmod 600 /var/lib/kubelet/config.yaml
chown root:root /var/lib/kubelet/config.yaml

# CIS 4.1.5: kubeconfig file for kubelet
chmod 600 /etc/kubernetes/kubelet.conf
chown root:root /etc/kubernetes/kubelet.conf

# CIS 4.1.7: CNI config files
find /etc/cni/net.d -type f -exec chmod 600 {} \;
find /etc/cni/net.d -type f -exec chown root:root {} \;

# CIS 1.1.1: kube-apiserver manifest
chmod 600 /etc/kubernetes/manifests/kube-apiserver.yaml
chown root:root /etc/kubernetes/manifests/kube-apiserver.yaml

# CIS 1.1.3: kube-controller-manager manifest
chmod 600 /etc/kubernetes/manifests/kube-controller-manager.yaml
chown root:root /etc/kubernetes/manifests/kube-controller-manager.yaml

# CIS 1.1.5: kube-scheduler manifest
chmod 600 /etc/kubernetes/manifests/kube-scheduler.yaml
chown root:root /etc/kubernetes/manifests/kube-scheduler.yaml

# CIS 1.1.7: etcd manifest
chmod 600 /etc/kubernetes/manifests/etcd.yaml
chown root:root /etc/kubernetes/manifests/etcd.yaml

# CIS 2.7: etcd data directory
chmod 700 /var/lib/etcd
chown etcd:etcd /var/lib/etcd

echo "File permissions hardened"
```

## Runtime Security with Falco

Falco provides runtime threat detection on worker nodes by monitoring system calls:

```yaml
# falco-rules.yaml (custom rules for CIS compliance monitoring)
- rule: Unexpected K8s API Access from Container
  desc: Detect containers directly accessing the Kubernetes API
  condition: >
    k8s_audit and
    ka.target.resource in (secrets, serviceaccounts) and
    not ka.user.name startswith "system:"
  output: >
    K8s API accessed from container (user=%ka.user.name
    resource=%ka.target.resource ns=%ka.target.namespace)
  priority: WARNING
  tags: [k8s, cis]

- rule: Shell in Container
  desc: Shell opened in a running container
  condition: >
    spawned_process and
    container and
    shell_procs and
    not container.image.repository in (allowed_shell_containers)
  output: >
    Shell opened in container (user=%user.name container=%container.name
    image=%container.image.repository cmd=%proc.cmdline)
  priority: WARNING
  tags: [container, cis, mitre_execution]

- rule: Write to /etc in Container
  desc: Detect writes to /etc inside a container
  condition: >
    open_write and
    container and
    fd.name startswith /etc and
    not proc.name in (allowed_etc_writers)
  output: >
    Write to /etc in container (file=%fd.name container=%container.name
    image=%container.image.repository)
  priority: ERROR
  tags: [container, cis]

- rule: Privileged Container Started
  desc: A privileged container was started
  condition: >
    container_started and
    container.privileged = true and
    not container.image.repository in (allowed_privileged_images)
  output: >
    Privileged container started (container=%container.name
    image=%container.image.repository)
  priority: WARNING
  tags: [container, cis, mitre_privilege_escalation]
```

Deploy Falco as a DaemonSet:

```yaml
# falco-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: falco
  namespace: falco
spec:
  selector:
    matchLabels:
      app: falco
  template:
    metadata:
      labels:
        app: falco
    spec:
      tolerations:
      - effect: NoSchedule
        operator: Exists
      hostNetwork: true
      hostPID: true
      containers:
      - name: falco
        image: falcosecurity/falco-no-driver:0.37.0
        securityContext:
          privileged: true
        volumeMounts:
        - mountPath: /host/var/run/docker.sock
          name: docker-socket
        - mountPath: /host/dev
          name: dev-fs
        - mountPath: /host/proc
          name: proc-fs
          readOnly: true
        - mountPath: /etc/falco
          name: config-volume
      volumes:
      - name: docker-socket
        hostPath:
          path: /var/run/docker.sock
      - name: dev-fs
        hostPath:
          path: /dev
      - name: proc-fs
        hostPath:
          path: /proc
      - name: config-volume
        configMap:
          name: falco-config
```

## Section 5: RBAC and Pod Security Policies

### RBAC Least Privilege (CIS 5.1)

```bash
# Find overly permissive roles
kubectl get clusterrolebindings -o json | \
  jq -r '.items[] |
    select(.roleRef.name == "cluster-admin") |
    .subjects[]? |
    "\(.kind)/\(.name)"'

# Find roles with wildcard permissions
kubectl get clusterroles -o json | \
  jq -r '.items[] |
    select(.rules[]?.verbs[]? == "*") |
    .metadata.name'

# Check for default service account with bound roles
kubectl get rolebindings,clusterrolebindings -A -o json | \
  jq -r '.items[] |
    select(.subjects[]?.name == "default") |
    "\(.metadata.namespace)/\(.metadata.name)"'
```

### Pod Security Standards (CIS 5.2)

```yaml
# Enforce baseline pod security at namespace level
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
---
# For sensitive namespaces, enforce restricted
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

### Network Policies (CIS 5.3)

```yaml
# Default deny all ingress and egress in each namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
---
# Allow only necessary egress (DNS and specific services)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: production
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

## CI/CD Integration for Continuous CIS Compliance

```yaml
# .github/workflows/cis-benchmark.yaml
name: CIS Benchmark Check

on:
  schedule:
    - cron: '0 6 * * *'  # Daily at 6 AM
  push:
    paths:
      - 'k8s/**'
      - '.github/workflows/cis-benchmark.yaml'

jobs:
  cis-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up kubectl
        uses: azure/setup-kubectl@v3

      - name: Configure cluster access
        run: |
          echo "${{ secrets.KUBECONFIG }}" | base64 -d > ~/.kube/config

      - name: Run kube-bench
        run: |
          kubectl apply -f \
            https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-master.yaml
          kubectl wait --for=condition=complete job/kube-bench-master --timeout=120s
          kubectl logs job/kube-bench-master > /tmp/master-results.txt
          kubectl delete job kube-bench-master

          kubectl apply -f \
            https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-node.yaml
          kubectl wait --for=condition=complete job/kube-bench-node --timeout=120s
          kubectl logs job/kube-bench-node > /tmp/node-results.txt
          kubectl delete job kube-bench-node

      - name: Parse and fail on critical findings
        run: |
          CRITICAL_CONTROLS=("1.2.1" "1.2.6" "1.2.7" "2.1" "2.2" "4.2.1" "4.2.2")
          FAIL=0
          for control in "${CRITICAL_CONTROLS[@]}"; do
            if grep -q "\[FAIL\] ${control}" /tmp/master-results.txt; then
              echo "CRITICAL FAIL: CIS control ${control}"
              FAIL=1
            fi
          done
          if [ $FAIL -eq 1 ]; then exit 1; fi

      - name: Upload results as artifact
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cis-benchmark-results
          path: /tmp/*-results.txt
          retention-days: 90

      - name: Post results to Slack
        if: failure()
        uses: slackapi/slack-github-action@v1.26.0
        with:
          payload: |
            {
              "text": "CIS Benchmark failed on cluster ${{ vars.CLUSTER_NAME }}",
              "attachments": [{
                "color": "danger",
                "text": "Run workflow for details: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
              }]
            }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## Tracking Compliance Score Over Time

```bash
#!/bin/bash
# cis-score.sh — calculate compliance percentage

RESULTS_FILE="${1:-/tmp/kube-bench-results.json}"

PASS=$(jq '[.[] | .tests[].results[] | select(.status == "PASS")] | length' "$RESULTS_FILE")
FAIL=$(jq '[.[] | .tests[].results[] | select(.status == "FAIL")] | length' "$RESULTS_FILE")
WARN=$(jq '[.[] | .tests[].results[] | select(.status == "WARN")] | length' "$RESULTS_FILE")
TOTAL=$((PASS + FAIL))

SCORE=$(echo "scale=1; $PASS * 100 / $TOTAL" | bc)

echo "CIS Kubernetes Benchmark Score: ${SCORE}% (${PASS}/${TOTAL} passing)"
echo "FAIL: ${FAIL}, WARN: ${WARN}"

# Store in time-series (e.g., Prometheus Pushgateway)
cat <<EOF | curl -s --data-binary @- http://pushgateway:9091/metrics/job/cis-benchmark
# HELP cis_benchmark_pass_total CIS benchmark passing controls
# TYPE cis_benchmark_pass_total gauge
cis_benchmark_pass_total ${PASS}
# HELP cis_benchmark_fail_total CIS benchmark failing controls
# TYPE cis_benchmark_fail_total gauge
cis_benchmark_fail_total ${FAIL}
# HELP cis_benchmark_score_percent CIS compliance score
# TYPE cis_benchmark_score_percent gauge
cis_benchmark_score_percent ${SCORE}
EOF
```

## Summary

A complete CIS Kubernetes Benchmark hardening effort covers six areas:

1. **API server**: disable anonymous auth, enable audit logging, restrict authorization modes, configure TLS minimum version
2. **Controller manager and scheduler**: bind to localhost only, disable profiling
3. **etcd**: enforce mutual TLS for all client and peer connections, enable encryption at rest for secrets
4. **Kubelet**: disable anonymous auth, require webhook authorization, disable read-only port, rotate certificates
5. **File permissions**: restrict access to manifest files, kubelet config, and etcd data directory
6. **Policies**: RBAC least privilege, Pod Security Standards enforcement, default-deny NetworkPolicies

Run kube-bench regularly as a scheduled job, integrate it into CI/CD pipelines to catch regressions, and track compliance score over time to demonstrate improvement. The benchmark is not a finish line — new Kubernetes versions introduce new controls, and threat models evolve.
