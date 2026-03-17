---
title: "Kubernetes CIS Benchmark: Automated Security Assessment and Remediation"
date: 2027-09-05T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "CIS", "Compliance"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "CIS Kubernetes Benchmark implementation covering kube-bench for automated scanning, API server hardening flags, etcd encryption at rest, RBAC minimization, network policy enforcement, and integrating benchmark results into CI pipelines."
more_link: "yes"
url: "/kubernetes-security-benchmarking-cis-guide/"
---

The CIS Kubernetes Benchmark provides a prescriptive set of security controls derived from industry consensus, covering API server configuration, etcd security, kubelet hardening, and RBAC minimization. Running automated assessments with kube-bench on a regular schedule and integrating results into CI pipelines ensures that security posture does not degrade between cluster upgrades. This guide covers the complete implementation: running kube-bench, interpreting results, remediating each control category, and maintaining compliance evidence for audit.

<!--more-->

## Section 1: CIS Kubernetes Benchmark Overview

The CIS Kubernetes Benchmark is organized into five sections:

| Section | Scope | Controls |
|---------|-------|---------|
| 1 | Control Plane Components | API server, controller manager, scheduler |
| 2 | etcd | Data encryption, authentication, TLS |
| 3 | Control Plane Configuration | Audit logs, admission controllers |
| 4 | Worker Nodes | kubelet, file permissions |
| 5 | Kubernetes Policies | RBAC, network policies, Pod Security Standards |

Checks are categorized as:
- **Level 1**: Practical security improvements with minimal operational impact
- **Level 2**: Defense-in-depth measures that may affect functionality

## Section 2: kube-bench Automated Scanning

### Running kube-bench as a Job

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench
  namespace: kube-system
spec:
  template:
    spec:
      hostPID: true
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      restartPolicy: Never
      volumes:
      - name: var-lib-etcd
        hostPath:
          path: /var/lib/etcd
      - name: var-lib-kubelet
        hostPath:
          path: /var/lib/kubelet
      - name: var-lib-kube-scheduler
        hostPath:
          path: /var/lib/kube-scheduler
      - name: var-lib-kube-controller-manager
        hostPath:
          path: /var/lib/kube-controller-manager
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
          path: /usr/local/mount-from-host/bin
      - name: etc-cni-netd
        hostPath:
          path: /etc/cni/net.d
      - name: opt-cni-bin
        hostPath:
          path: /opt/cni/bin
      containers:
      - name: kube-bench
        image: docker.io/aquasec/kube-bench:v0.9.0
        command: ["kube-bench", "--json", "--outputfile", "/tmp/results.json"]
        securityContext:
          privileged: true
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
        - name: usr-bin
          mountPath: /usr/local/mount-from-host/bin
          readOnly: true
```

### Parsing kube-bench Results

```bash
# Run kube-bench and extract failing checks
kubectl exec -n kube-system $(kubectl get pods -n kube-system -l app=kube-bench -o name | head -1) \
  -- cat /tmp/results.json | \
  jq -r '
    .Controls[] |
    .id as $section |
    .Tests[] |
    select(.results != null) |
    .id as $test_id |
    .results[] |
    select(.status == "FAIL") |
    [$section, $test_id, .test_number, .test_desc] |
    @tsv
  ' | sort | head -30

# Count by status
kubectl exec -n kube-system $(kubectl get pods -n kube-system -l app=kube-bench -o name | head -1) \
  -- cat /tmp/results.json | \
  jq -r '
    [
      .Controls[].Tests[].results[]? |
      .status
    ] |
    group_by(.) |
    map({"status": .[0], "count": length}) |
    .[]
  '
# {"status":"FAIL","count":12}
# {"status":"PASS","count":48}
# {"status":"WARN","count":7}
# {"status":"INFO","count":3}
```

## Section 3: API Server Hardening

### Critical API Server Flags

```yaml
# kube-apiserver manifest additions (/etc/kubernetes/manifests/kube-apiserver.yaml)
spec:
  containers:
  - command:
    - kube-apiserver
    # Authentication
    - --anonymous-auth=false                    # CIS 1.2.1
    - --token-auth-file=                        # CIS 1.2.2 (empty = disabled)

    # TLS
    - --tls-cert-file=/etc/kubernetes/pki/apiserver.crt
    - --tls-private-key-file=/etc/kubernetes/pki/apiserver.key
    - --tls-min-version=VersionTLS12            # CIS 1.2.33
    - --tls-cipher-suites=TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384

    # Authorization
    - --authorization-mode=Node,RBAC            # CIS 1.2.7
    - --enable-bootstrap-token-auth=false       # CIS 1.2.20

    # Admission controllers (CIS 1.2.10-16)
    - --enable-admission-plugins=NodeRestriction,PodSecurity,ResourceQuota,LimitRanger,ServiceAccount,DefaultStorageClass,DefaultTolerationSeconds,MutatingAdmissionWebhook,ValidatingAdmissionWebhook,PersistentVolumeClaimResize

    # Audit logging (CIS 1.2.22-25)
    - --audit-log-path=/var/log/kubernetes/audit/audit.log
    - --audit-log-maxage=30
    - --audit-log-maxbackup=10
    - --audit-log-maxsize=100
    - --audit-policy-file=/etc/kubernetes/audit/audit-policy.yaml

    # Service accounts (CIS 1.2.26-28)
    - --service-account-lookup=true
    - --service-account-key-file=/etc/kubernetes/pki/sa.pub
    - --service-account-signing-key-file=/etc/kubernetes/pki/sa.key
    - --service-account-issuer=https://kubernetes.default.svc.cluster.local

    # etcd TLS (CIS 1.2.29-31)
    - --etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt
    - --etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key
    - --etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt

    # Request timeout
    - --request-timeout=60s                     # CIS 1.2.32
    - --secure-port=6443
    - --insecure-port=0                         # CIS 1.2.18 (disable insecure port)
    - --profiling=false                         # CIS 1.2.19
    - --repair-malformed-updates=false
```

### Controller Manager Hardening

```yaml
# kube-controller-manager
- --profiling=false                             # CIS 1.3.1
- --use-service-account-credentials=true        # CIS 1.3.3
- --service-account-private-key-file=/etc/kubernetes/pki/sa.key
- --root-ca-file=/etc/kubernetes/pki/ca.crt
- --bind-address=127.0.0.1                      # CIS 1.3.7
- --terminated-pod-gc-threshold=10              # GC terminated pods
```

### Scheduler Hardening

```yaml
# kube-scheduler
- --profiling=false                             # CIS 1.4.1
- --bind-address=127.0.0.1                      # CIS 1.4.2
```

## Section 4: etcd Encryption at Rest

### Enabling Encryption for Secrets

```yaml
# /etc/kubernetes/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  # Primary: AES-GCM with 256-bit key (CIS 1.2.34)
  - aescbc:
      keys:
      - name: key1
        # Generate with: head -c 32 /dev/urandom | base64
        secret: BASE64_ENCODED_32_BYTE_KEY_REPLACE_ME
  # Fallback for existing unencrypted data
  - identity: {}
```

```bash
# Apply encryption config to API server
# Add to kube-apiserver manifest:
# --encryption-provider-config=/etc/kubernetes/encryption-config.yaml

# Restart API server to pick up changes
systemctl restart kubelet

# Re-encrypt all existing secrets
kubectl get secrets --all-namespaces -o json | \
  kubectl replace -f -

# Verify encryption is active
# Read a secret directly from etcd (should show encrypted content)
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  get /registry/secrets/default/test-secret | \
  hexdump -C | head

# Output should start with "k8s:enc:aescbc:v1:key1:" prefix
```

### Key Rotation

```bash
# Step 1: Generate new key
NEW_KEY=$(head -c 32 /dev/urandom | base64)

# Step 2: Update encryption config (new key first, old key second)
# providers:
# - aescbc:
#     keys:
#     - name: key2       ← NEW KEY (primary)
#       secret: $NEW_KEY
#     - name: key1       ← OLD KEY (fallback for existing data)
#       secret: $OLD_KEY
# - identity: {}

# Step 3: Restart API server

# Step 4: Re-encrypt all secrets with new key
kubectl get secrets --all-namespaces -o json | kubectl replace -f -

# Step 5: Remove old key from config and restart API server again
```

## Section 5: kubelet Hardening

### kubelet Configuration (CIS Section 4)

```yaml
# /var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
authentication:
  anonymous:
    enabled: false                   # CIS 4.2.1
  webhook:
    enabled: true                    # CIS 4.2.2
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
authorization:
  mode: Webhook                      # CIS 4.2.2
eventRecordQPS: 0
protectKernelDefaults: true          # CIS 4.2.6
makeIPTablesUtilChains: true         # CIS 4.2.7
readOnlyPort: 0                      # CIS 4.2.4 (disable read-only port)
tlsCertFile: /var/lib/kubelet/pki/kubelet.crt
tlsPrivateKeyFile: /var/lib/kubelet/pki/kubelet.key
tlsMinVersion: VersionTLS12          # CIS 4.2.13
tlsCipherSuites:
- TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
- TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
- TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
- TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
serverTLSBootstrap: true
rotateCertificates: true
```

### File Permission Checks

```bash
#!/usr/bin/env bash
# Verify CIS file permission controls (Section 4.1)

check_permission() {
    local file="$1"
    local expected_max="$2"
    local desc="$3"

    if [ ! -f "$file" ]; then
        echo "SKIP: $file not found"
        return
    fi

    actual=$(stat -c "%a" "$file")
    if [ "$actual" -le "$expected_max" ]; then
        echo "PASS: $desc - $file ($actual)"
    else
        echo "FAIL: $desc - $file (expected <= $expected_max, got $actual)"
    fi
}

# CIS 4.1.1-4.1.9
check_permission /etc/kubernetes/manifests/kube-apiserver.yaml 600 "API server manifest"
check_permission /etc/kubernetes/manifests/kube-controller-manager.yaml 600 "Controller manager manifest"
check_permission /etc/kubernetes/manifests/kube-scheduler.yaml 600 "Scheduler manifest"
check_permission /etc/kubernetes/manifests/etcd.yaml 600 "etcd manifest"
check_permission /etc/kubernetes/admin.conf 600 "admin kubeconfig"
check_permission /etc/kubernetes/pki/ca.crt 644 "CA certificate"
check_permission /etc/kubernetes/pki/ca.key 600 "CA key"
check_permission /etc/kubernetes/pki/apiserver.key 600 "API server key"
```

## Section 6: RBAC Minimization

### Audit Existing RBAC

```bash
# Find ClusterRoles with wildcard permissions
kubectl get clusterroles -o json | jq -r '
  .items[] |
  select(
    .rules[]? |
    (.verbs | contains(["*"])) or
    (.resources | contains(["*"]))
  ) |
  .metadata.name
' | grep -v "system:"

# Find subjects with cluster-admin binding
kubectl get clusterrolebindings -o json | jq -r '
  .items[] |
  select(.roleRef.name == "cluster-admin") |
  [.metadata.name,
   (.subjects[]? | [.kind, .name, (.namespace // "cluster")] | join(":"))
  ] |
  @tsv
'

# Find service accounts with token auto-mount enabled
kubectl get serviceaccounts --all-namespaces -o json | jq -r '
  .items[] |
  select(.automountServiceAccountToken != false) |
  [.metadata.namespace, .metadata.name] |
  @tsv
' | grep -v "kube-system\|default"
```

### Remediation: Least-Privilege Service Account

```yaml
# Before: Default service account with wildcard permissions
# After: Minimal service account

apiVersion: v1
kind: ServiceAccount
metadata:
  name: api-service
  namespace: production
automountServiceAccountToken: false    # CIS 5.1.5: Disable unless required

---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: api-service-role
  namespace: production
rules:
# Only the specific resources needed
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["api-config"]
  verbs: ["get", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["api-credentials"]
  verbs: ["get"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: api-service-binding
  namespace: production
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: api-service-role
subjects:
- kind: ServiceAccount
  name: api-service
  namespace: production

---
# Pod using the least-privilege service account
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  template:
    spec:
      serviceAccountName: api-service
      automountServiceAccountToken: true    # Explicitly enable where needed
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: api
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
```

## Section 7: Pod Security Standards

### Enforce Restricted Profile

```yaml
# Label namespace for restricted Pod Security Standard enforcement (CIS 5.2)
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.30
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.30
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.30
```

### Admission Configuration for Cluster-Wide Defaults

```yaml
# /etc/kubernetes/admission/pod-security-admission.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1
    kind: PodSecurityConfiguration
    defaults:
      enforce: "baseline"
      enforce-version: "latest"
      audit: "restricted"
      audit-version: "latest"
      warn: "restricted"
      warn-version: "latest"
    exemptions:
      namespaces:
      - kube-system
      - monitoring
      - logging
      runtimeClasses: []
      usernames: []
```

## Section 8: Network Policy Enforcement

### Default-Deny Policy (CIS 5.3)

```yaml
# Apply default-deny to each namespace
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
# Allow DNS resolution
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
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

### Automated Network Policy Enforcement Check

```bash
# Find namespaces without a default-deny policy
for ns in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    if ! kubectl get networkpolicy default-deny-all -n "$ns" &>/dev/null; then
        echo "FAIL: No default-deny NetworkPolicy in namespace: $ns"
    else
        echo "PASS: default-deny NetworkPolicy exists in: $ns"
    fi
done
```

## Section 9: CI/CD Integration

### GitHub Actions kube-bench Check

```yaml
# .github/workflows/cis-benchmark.yaml
name: CIS Kubernetes Benchmark
on:
  schedule:
  - cron: "0 6 * * *"    # Daily at 6 AM UTC
  push:
    branches: [main]
    paths:
    - "kubernetes/**"
    - "charts/**"

jobs:
  cis-benchmark:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v4

    - name: Setup kind cluster
      uses: helm/kind-action@v1.9.0
      with:
        config: .github/kind-config.yaml

    - name: Apply cluster hardening
      run: |
        kubectl apply -f kubernetes/security/

    - name: Run kube-bench
      run: |
        kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job.yaml
        kubectl wait --for=condition=complete job/kube-bench -n default --timeout=300s
        kubectl logs job/kube-bench > kube-bench-results.txt

    - name: Parse results and check failures
      run: |
        FAILS=$(grep -c "^\[FAIL\]" kube-bench-results.txt || true)
        echo "CIS benchmark failures: $FAILS"

        if [ "$FAILS" -gt "5" ]; then
          echo "::error::Too many CIS benchmark failures: $FAILS"
          cat kube-bench-results.txt
          exit 1
        fi

    - name: Upload results
      uses: actions/upload-artifact@v4
      with:
        name: kube-bench-results
        path: kube-bench-results.txt
        retention-days: 90
```

## Section 10: Compliance Reporting

### Automated Compliance Report

```bash
#!/usr/bin/env bash
# Generate CIS compliance report
set -euo pipefail

REPORT_DIR="/tmp/cis-report-$(date +%Y%m%d)"
mkdir -p "$REPORT_DIR"

# Run kube-bench
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-report
  namespace: kube-system
spec:
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      hostPID: true
      tolerations:
      - operator: Exists
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      restartPolicy: Never
      containers:
      - name: kube-bench
        image: docker.io/aquasec/kube-bench:v0.9.0
        command: ["kube-bench", "--json"]
        securityContext:
          privileged: true
        volumeMounts:
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
      volumes:
      - name: etc-kubernetes
        hostPath:
          path: /etc/kubernetes
EOF

kubectl wait --for=condition=complete job/kube-bench-report \
  -n kube-system --timeout=300s

# Extract JSON results
kubectl logs job/kube-bench-report -n kube-system > "$REPORT_DIR/results.json"

# Generate summary
jq -r '
  .Controls[] |
  . as $control |
  .Tests[] |
  . as $test |
  select(.results != null) |
  .results[] |
  [$control.id, $test.section, .test_number, .status, .test_desc] |
  @tsv
' "$REPORT_DIR/results.json" > "$REPORT_DIR/summary.tsv"

# Count by status
echo "=== CIS Benchmark Summary ==="
awk -F'\t' '{print $4}' "$REPORT_DIR/summary.tsv" | sort | uniq -c | sort -rn

# List FAIL items
echo ""
echo "=== Failing Controls ==="
awk -F'\t' '$4=="FAIL" {print $1"."$2" "$3": "$5}' "$REPORT_DIR/summary.tsv"

# Cleanup
kubectl delete job kube-bench-report -n kube-system
```

## Summary

CIS Kubernetes Benchmark compliance is not a one-time activity but a continuous process that must be integrated into cluster lifecycle management. Automated kube-bench scans in CI pipelines catch regressions introduced by version upgrades or configuration drift. The highest-impact controls are API server hardening flags (disabling anonymous auth, enabling Node+RBAC authorization, configuring audit logging), etcd encryption at rest for secrets, and enforcing restricted Pod Security Standards across application namespaces. RBAC minimization requires ongoing audit of service account permissions to prevent privilege escalation vectors.
