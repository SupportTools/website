---
title: "Kubernetes CIS Benchmarking: Automated Security Hardening with kube-bench"
date: 2027-11-19T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "CIS", "kube-bench", "Hardening"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes CIS Benchmark controls, kube-bench deployment and scanning, API server hardening, etcd encryption, kubelet security configuration, RBAC minimization, Pod Security Standards, and automated remediation."
more_link: "yes"
url: /kubernetes-cis-hardening-kube-bench-guide/
---

The CIS Kubernetes Benchmark provides a prescriptive set of security controls validated against real-world attack vectors. Running kube-bench against a production cluster for the first time typically surfaces dozens of failures across control plane components, worker nodes, and etcd. Each finding represents a configuration that could allow privilege escalation, data exfiltration, or cluster compromise.

This guide walks through deploying kube-bench, interpreting findings, implementing remediations, and automating compliance scanning in CI/CD pipelines.

<!--more-->

# Kubernetes CIS Benchmarking: Automated Security Hardening with kube-bench

## Section 1: CIS Kubernetes Benchmark Overview

The CIS Kubernetes Benchmark (currently at version 1.9 for Kubernetes 1.29+) organizes controls into sections aligned with cluster components:

- **Section 1**: Control Plane Node Configuration
  - 1.1: Master node configuration files
  - 1.2: API Server
  - 1.3: Controller Manager
  - 1.4: Scheduler
- **Section 2**: Etcd Node Configuration
- **Section 3**: Control Plane Configuration
  - 3.1: Authentication and Authorization
  - 3.2: Logging
- **Section 4**: Worker Node Security Configuration
  - 4.1: Worker node configuration files
  - 4.2: Kubelet
- **Section 5**: Kubernetes Policies
  - 5.1: RBAC and Service Accounts
  - 5.2: Pod Security Standards
  - 5.3: Network Policies
  - 5.4: Secrets Management
  - 5.7: General Policies

Each control is marked as either **Automated** (testable programmatically) or **Manual** (requires human assessment).

## Section 2: Deploying kube-bench

Kube-bench runs as a Kubernetes Job, DaemonSet, or standalone binary. The Job approach is best for one-time audits, while the DaemonSet approach enables continuous compliance monitoring.

### One-Time Audit via Job

```yaml
# kube-bench-job.yaml - runs on control plane nodes
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-control-plane
  namespace: kube-system
spec:
  template:
    metadata:
      labels:
        app: kube-bench
    spec:
      hostPID: true
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      restartPolicy: Never
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:v0.8.0
        command:
        - kube-bench
        - run
        - --targets
        - master,etcd,controlplane,policies
        - --json
        volumeMounts:
        - name: var-lib-etcd
          mountPath: /var/lib/etcd
          readOnly: true
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: lib-systemd
          mountPath: /lib/systemd
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
        securityContext:
          privileged: true
      volumes:
      - name: var-lib-etcd
        hostPath:
          path: /var/lib/etcd
      - name: var-lib-kubelet
        hostPath:
          path: /var/lib/kubelet
      - name: etc-systemd
        hostPath:
          path: /etc/systemd
      - name: lib-systemd
        hostPath:
          path: /lib/systemd
      - name: etc-kubernetes
        hostPath:
          path: /etc/kubernetes
```

```yaml
# kube-bench-node-job.yaml - runs on worker nodes
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-node
  namespace: kube-system
spec:
  template:
    spec:
      hostPID: true
      restartPolicy: Never
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:v0.8.0
        command:
        - kube-bench
        - run
        - --targets
        - node,policies
        - --json
        volumeMounts:
        - name: var-lib-kubelet
          mountPath: /var/lib/kubelet
          readOnly: true
        - name: etc-systemd
          mountPath: /etc/systemd
          readOnly: true
        - name: etc-kubernetes
          mountPath: /etc/kubernetes
          readOnly: true
        securityContext:
          privileged: true
      volumes:
      - name: var-lib-kubelet
        hostPath:
          path: /var/lib/kubelet
      - name: etc-systemd
        hostPath:
          path: /etc/systemd
      - name: etc-kubernetes
        hostPath:
          path: /etc/kubernetes
```

Apply and collect results:

```bash
kubectl apply -f kube-bench-job.yaml
kubectl wait --for=condition=complete job/kube-bench-control-plane -n kube-system --timeout=300s

# Get results from completed pod
POD=$(kubectl get pods -n kube-system -l app=kube-bench -o name | head -1)
kubectl logs -n kube-system $POD | jq '.'

# Count failures by section
kubectl logs -n kube-system $POD | \
    jq '.Controls[].tests[].results[] | select(.status == "FAIL") | .test_number' | \
    sort | uniq -c | sort -rn
```

## Section 3: API Server Hardening (Section 1.2)

The API server is the most critical component. The following configurations address the most commonly failed CIS controls.

### kubeadm ClusterConfiguration for Hardened API Server

```yaml
# kubeadm-config.yaml - create cluster with hardened settings
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
kubernetesVersion: v1.29.3
controlPlaneEndpoint: "k8s-api.internal.example.com:6443"
apiServer:
  extraArgs:
    # 1.2.1 - Disable anonymous authentication
    anonymous-auth: "false"
    # 1.2.2 - Set RBAC authorization mode
    authorization-mode: "Node,RBAC"
    # 1.2.7 - Enable audit logging
    audit-log-path: "/var/log/kubernetes/audit.log"
    audit-log-maxage: "30"
    audit-log-maxbackup: "10"
    audit-log-maxsize: "100"
    audit-policy-file: "/etc/kubernetes/audit-policy.yaml"
    # 1.2.10 - Enable admission controllers
    enable-admission-plugins: "NodeRestriction,PodSecurity,EventRateLimit,AlwaysPullImages"
    # 1.2.16 - Secure port
    secure-port: "6443"
    # 1.2.17 - Profiling disabled
    profiling: "false"
    # 1.2.21 - Kubelet certificate authority
    kubelet-certificate-authority: "/etc/kubernetes/pki/ca.crt"
    # 1.2.24 - Service account lookup
    service-account-lookup: "true"
    # 1.2.25 - Service account key file
    service-account-key-file: "/etc/kubernetes/pki/sa.pub"
    # 1.2.26 - Request headers CA
    requestheader-client-ca-file: "/etc/kubernetes/pki/front-proxy-ca.crt"
    # 1.2.29 - TLS cipher suites
    tls-cipher-suites: "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384"
    # 1.2.30 - TLS minimum version
    tls-min-version: "VersionTLS12"
    # Encryption at rest
    encryption-provider-config: "/etc/kubernetes/enc/encryption-config.yaml"
  certSANs:
  - "k8s-api.internal.example.com"
  - "10.96.0.1"
  - "127.0.0.1"
  extraVolumes:
  - name: audit-policy
    hostPath: /etc/kubernetes/audit-policy.yaml
    mountPath: /etc/kubernetes/audit-policy.yaml
    readOnly: true
    pathType: File
  - name: audit-log
    hostPath: /var/log/kubernetes
    mountPath: /var/log/kubernetes
    pathType: DirectoryOrCreate
  - name: encryption-config
    hostPath: /etc/kubernetes/enc
    mountPath: /etc/kubernetes/enc
    readOnly: true
    pathType: DirectoryOrCreate
controllerManager:
  extraArgs:
    terminated-pod-gc-threshold: "10"
    profiling: "false"
    use-service-account-credentials: "true"
    rotate-certificates: "true"
    feature-gates: "RotateKubeletServerCertificate=true"
scheduler:
  extraArgs:
    profiling: "false"
```

### Audit Policy

```yaml
# /etc/kubernetes/audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
- RequestReceived
rules:
# Log all actions on sensitive resources
- level: RequestResponse
  resources:
  - group: "rbac.authorization.k8s.io"
    resources: ["clusterroles", "clusterrolebindings", "roles", "rolebindings"]
  - group: ""
    resources: ["serviceaccounts"]
  - group: "authentication.k8s.io"
    resources: ["tokenreviews"]
# Log pod execution at RequestResponse level
- level: RequestResponse
  verbs: ["create"]
  resources:
  - group: ""
    resources: ["pods/exec", "pods/attach", "pods/portforward"]
# Log secret access at metadata level (avoid logging secret values)
- level: Metadata
  resources:
  - group: ""
    resources: ["secrets"]
# Log node and pod changes
- level: RequestResponse
  verbs: ["create", "update", "patch", "delete"]
  resources:
  - group: ""
    resources: ["pods"]
# Default: log metadata for everything else
- level: Metadata
  omitStages:
  - RequestReceived
```

## Section 4: etcd Encryption at Rest (Section 2)

etcd stores all Kubernetes secrets. Without encryption at rest, anyone with filesystem access to etcd can read all secrets in plaintext.

```yaml
# /etc/kubernetes/enc/encryption-config.yaml
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  - aescbc:
      keys:
      - name: key1
        # Generate with: head -c 32 /dev/urandom | base64
        secret: "dGhpcyBpcyBhIDMyIGJ5dGUgZW5jcnlwdGlvbiBrZXkh"
  - identity: {}
```

For production environments, use a KMS provider to avoid storing the encryption key on disk:

```yaml
# /etc/kubernetes/enc/encryption-config.yaml (KMS v2)
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  - configmaps
  providers:
  - kms:
      apiVersion: v2
      name: aws-kms-provider
      endpoint: unix:///var/run/kmsplugin/socket.sock
      timeout:
        seconds: 3
  - identity: {}
```

After enabling encryption, force-encrypt all existing secrets:

```bash
# Re-encrypt all secrets to use the new encryption provider
kubectl get secrets --all-namespaces -o json | \
    kubectl replace -f -

# Verify a secret is encrypted in etcd
ETCDCTL_API=3 etcdctl \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    get /registry/secrets/default/my-secret | \
    hexdump -C | head -5
# Output should start with k8s:enc:aescbc if encrypted
```

## Section 5: Kubelet Security (Section 4.2)

The kubelet runs on every node and is a common attack vector for privilege escalation.

```yaml
# /var/lib/kubelet/config.yaml - KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# 4.2.1 - Disable anonymous authentication
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
    cacheTTL: 2m
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
# 4.2.2 - Set authorization mode to Webhook
authorization:
  mode: Webhook
  webhook:
    cacheAuthorizedTTL: 5m
    cacheUnauthorizedTTL: 30s
# 4.2.4 - Read-only port disabled
readOnlyPort: 0
# 4.2.5 - Streaming connection idle timeout
streamingConnectionIdleTimeout: 4h
# 4.2.6 - Protect kernel defaults
protectKernelDefaults: true
# 4.2.9 - Event QPS
eventRecordQPS: 5
# 4.2.10 - Certificate rotation
rotateCertificates: true
featureGates:
  RotateKubeletServerCertificate: true
# 4.2.11 - TLS certificates
tlsCertFile: /var/lib/kubelet/pki/kubelet.crt
tlsPrivateKeyFile: /var/lib/kubelet/pki/kubelet.key
# 4.2.12 - TLS minimum version
tlsMinVersion: VersionTLS12
# 4.2.13 - TLS cipher suites
tlsCipherSuites:
- TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
- TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
- TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305
- TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
- TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305
- TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
maxPods: 110
podPidsLimit: 4096
systemReserved:
  cpu: 200m
  memory: 500Mi
kubeReserved:
  cpu: 200m
  memory: 500Mi
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "10%"
  imagefs.available: "15%"
```

Apply the configuration:

```bash
sudo cp /var/lib/kubelet/config.yaml /var/lib/kubelet/config.yaml.backup
# Copy hardened config to /var/lib/kubelet/config.yaml
sudo systemctl restart kubelet
sudo systemctl status kubelet

# Verify settings
sudo curl -s --cacert /etc/kubernetes/pki/ca.crt \
    --cert /etc/kubernetes/pki/apiserver-kubelet-client.crt \
    --key /etc/kubernetes/pki/apiserver-kubelet-client.key \
    https://localhost:10250/configz | jq '.kubeletconfig.readOnlyPort'
# Should output 0
```

## Section 6: RBAC Minimization (Section 5.1)

### Audit Current RBAC Bindings

```bash
# Find all subjects with cluster-admin
kubectl get clusterrolebindings -o json | \
    jq '.items[] | select(.roleRef.name == "cluster-admin") |
        {name: .metadata.name, subjects: .subjects}'

# Find wildcarded permissions (very dangerous)
kubectl get clusterroles -o json | \
    jq '.items[] |
        select(.rules[]?.verbs[]? == "*" or .rules[]?.resources[]? == "*") |
        {name: .metadata.name}'

# Check for default service account bindings
kubectl get rolebindings,clusterrolebindings --all-namespaces -o json | \
    jq '.items[] | select(.subjects[]?.name == "default" and .subjects[]?.kind == "ServiceAccount")'

# Find service accounts with cluster roles
kubectl get clusterrolebindings -o json | \
    jq '.items[] | select(.subjects[]?.kind == "ServiceAccount") |
        {binding: .metadata.name, role: .roleRef.name}'
```

### Harden Default Service Account

CIS 5.1.5 requires that default service accounts have `automountServiceAccountToken: false`.

```bash
#!/bin/bash
# harden-default-service-accounts.sh
for NS in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
    echo "Patching default service account in namespace: $NS"
    kubectl patch serviceaccount default -n "$NS" \
        -p '{"automountServiceAccountToken": false}' || true
done
```

### Minimal Roles for Common Workload Patterns

```yaml
# Read-only monitoring role
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring-reader
rules:
- apiGroups: [""]
  resources: ["nodes", "nodes/metrics", "services", "endpoints", "pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["extensions", "networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch"]
- nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
  verbs: ["get"]
---
# Namespace-scoped deployer role
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
  namespace: production
rules:
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "watch", "update", "patch"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
  resourceNames: ["app-config", "feature-flags"]
```

## Section 7: Pod Security Standards (Section 5.2)

Pod Security Standards apply at namespace level and enforce one of three profiles: `privileged`, `baseline`, or `restricted`.

### Namespace-Level Pod Security Enforcement

```yaml
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
---
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

### Restricted Standard Compliant Pod

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
  namespace: production
spec:
  selector:
    matchLabels:
      app: secure-app
  template:
    metadata:
      labels:
        app: secure-app
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      automountServiceAccountToken: false
      containers:
      - name: app
        image: myapp:1.0.0
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          runAsUser: 10001
          seccompProfile:
            type: RuntimeDefault
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: tmp
        emptyDir: {}
```

### Apply Pod Security Labels in Bulk

```bash
#!/bin/bash
# apply-pod-security-standards.sh
PRODUCTION_NAMESPACES="production staging"
INFRASTRUCTURE_NAMESPACES="monitoring logging cert-manager ingress-nginx"
SYSTEM_NAMESPACES="kube-system longhorn-system rook-ceph"

for NS in $PRODUCTION_NAMESPACES; do
    kubectl label namespace "$NS" \
        pod-security.kubernetes.io/enforce=restricted \
        pod-security.kubernetes.io/enforce-version=v1.29 \
        pod-security.kubernetes.io/audit=restricted \
        pod-security.kubernetes.io/warn=restricted \
        --overwrite
done

for NS in $INFRASTRUCTURE_NAMESPACES; do
    kubectl label namespace "$NS" \
        pod-security.kubernetes.io/enforce=baseline \
        pod-security.kubernetes.io/audit=restricted \
        pod-security.kubernetes.io/warn=restricted \
        --overwrite
done

for NS in $SYSTEM_NAMESPACES; do
    kubectl label namespace "$NS" \
        pod-security.kubernetes.io/enforce=privileged \
        pod-security.kubernetes.io/audit=baseline \
        pod-security.kubernetes.io/warn=baseline \
        --overwrite
done
```

## Section 8: Network Policies (Section 5.3)

CIS 5.3.2 requires that all namespaces have at least one NetworkPolicy.

```yaml
# Default deny all ingress and egress
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
# Allow ingress from ingress controller only
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-controller
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: api-server
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: ingress-nginx
      podSelector:
        matchLabels:
          app.kubernetes.io/name: ingress-nginx
    ports:
    - protocol: TCP
      port: 8080
---
# Allow DNS resolution for all pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
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
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

## Section 9: Kyverno Policies for CIS Compliance

Kyverno enforces CIS-aligned policies at admission time:

```yaml
# Enforce no privilege escalation (CIS 5.2.5)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-privilege-escalation
  annotations:
    policies.kyverno.io/title: Disallow Privilege Escalation
    policies.kyverno.io/category: Pod Security Standards (Restricted)
    policies.kyverno.io/severity: high
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: no-privilege-escalation
    match:
      any:
      - resources:
          kinds: ["Pod"]
    validate:
      message: "Privilege escalation is disallowed. Set allowPrivilegeEscalation: false."
      pattern:
        spec:
          containers:
          - securityContext:
              allowPrivilegeEscalation: false
          =(initContainers):
          - securityContext:
              allowPrivilegeEscalation: false
---
# Require resource limits (CIS 5.2.10)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-resource-limits
  annotations:
    policies.kyverno.io/title: Require Resource Limits
    policies.kyverno.io/category: Best Practices
    policies.kyverno.io/severity: medium
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: require-limits
    match:
      any:
      - resources:
          kinds: ["Pod"]
          namespaces: ["production", "staging"]
    validate:
      message: "CPU and memory limits are required for all containers."
      pattern:
        spec:
          containers:
          - resources:
              limits:
                memory: "?*"
                cpu: "?*"
---
# Disallow host namespaces (CIS 5.2.2, 5.2.3, 5.2.4)
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-host-namespaces
  annotations:
    policies.kyverno.io/title: Disallow Host Namespaces
    policies.kyverno.io/severity: high
spec:
  validationFailureAction: Enforce
  background: true
  rules:
  - name: host-namespaces
    match:
      any:
      - resources:
          kinds: ["Pod"]
          namespaces: ["production", "staging"]
    validate:
      message: "Sharing the host namespaces is disallowed."
      pattern:
        spec:
          =(hostPID): false
          =(hostIPC): false
          =(hostNetwork): false
```

## Section 10: Continuous Compliance Monitoring

Integrate kube-bench into continuous monitoring:

```bash
#!/bin/bash
# run-cis-scan.sh - CI/CD integration script
set -euo pipefail

NAMESPACE="kube-bench"
THRESHOLD_FAIL=5

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Run the scan as a Job
cat <<'EOF' | kubectl apply -n "$NAMESPACE" -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench-ci
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      hostPID: true
      restartPolicy: Never
      tolerations:
      - operator: Exists
      containers:
      - name: kube-bench
        image: aquasec/kube-bench:v0.8.0
        command: ["kube-bench", "run", "--json"]
        securityContext:
          privileged: true
        volumeMounts:
        - mountPath: /var/lib/etcd
          name: etcd
          readOnly: true
        - mountPath: /etc/kubernetes
          name: k8s
          readOnly: true
        - mountPath: /var/lib/kubelet
          name: kubelet
          readOnly: true
        - mountPath: /etc/systemd
          name: systemd
          readOnly: true
      volumes:
      - hostPath: {path: /var/lib/etcd}
        name: etcd
      - hostPath: {path: /etc/kubernetes}
        name: k8s
      - hostPath: {path: /var/lib/kubelet}
        name: kubelet
      - hostPath: {path: /etc/systemd}
        name: systemd
EOF

kubectl wait --for=condition=complete job/kube-bench-ci -n "$NAMESPACE" --timeout=300s

RESULTS=$(kubectl logs -n "$NAMESPACE" job/kube-bench-ci)
FAIL_COUNT=$(echo "$RESULTS" | jq '[.Controls[].tests[].results[] | select(.status == "FAIL")] | length')
WARN_COUNT=$(echo "$RESULTS" | jq '[.Controls[].tests[].results[] | select(.status == "WARN")] | length')
PASS_COUNT=$(echo "$RESULTS" | jq '[.Controls[].tests[].results[] | select(.status == "PASS")] | length')

echo "CIS Benchmark Results: PASS=$PASS_COUNT FAIL=$FAIL_COUNT WARN=$WARN_COUNT"

echo ""
echo "Failures:"
echo "$RESULTS" | jq -r '
    .Controls[] |
    .tests[] |
    .results[] |
    select(.status == "FAIL") |
    "\(.test_number) - \(.test_desc)"
'

if [ "$FAIL_COUNT" -gt "$THRESHOLD_FAIL" ]; then
    echo "FAIL: $FAIL_COUNT failures exceed threshold of $THRESHOLD_FAIL"
    exit 1
fi

echo "CIS scan passed threshold check"
```

### Scheduled Weekly Scan with Reporting

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: kube-bench-weekly
  namespace: kube-bench
spec:
  schedule: "0 4 * * 1"
  successfulJobsHistoryLimit: 4
  failedJobsHistoryLimit: 2
  jobTemplate:
    spec:
      template:
        spec:
          hostPID: true
          restartPolicy: OnFailure
          tolerations:
          - operator: Exists
          containers:
          - name: kube-bench
            image: aquasec/kube-bench:v0.8.0
            command:
            - /bin/sh
            - -c
            - |
              kube-bench run --json > /tmp/results.json
              FAIL_COUNT=$(cat /tmp/results.json | jq '[.Controls[].tests[].results[] | select(.status == "FAIL")] | length')
              PASS_COUNT=$(cat /tmp/results.json | jq '[.Controls[].tests[].results[] | select(.status == "PASS")] | length')
              echo "Weekly CIS Results: PASS=$PASS_COUNT FAIL=$FAIL_COUNT"
              cat /tmp/results.json | jq -r '.Controls[] | .tests[] | .results[] | select(.status == "FAIL") | "\(.test_number) \(.test_desc)"'
            securityContext:
              privileged: true
            volumeMounts:
            - mountPath: /var/lib/etcd
              name: etcd
              readOnly: true
            - mountPath: /etc/kubernetes
              name: k8s
              readOnly: true
            - mountPath: /var/lib/kubelet
              name: kubelet
              readOnly: true
            - mountPath: /etc/systemd
              name: systemd
              readOnly: true
          volumes:
          - hostPath: {path: /var/lib/etcd}
            name: etcd
          - hostPath: {path: /etc/kubernetes}
            name: k8s
          - hostPath: {path: /var/lib/kubelet}
            name: kubelet
          - hostPath: {path: /etc/systemd}
            name: systemd
```

### Prometheus Alerting for CIS Failures

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: cis-benchmark-alerts
  namespace: monitoring
spec:
  groups:
  - name: cis
    rules:
    - alert: CISBenchmarkFailuresHigh
      expr: kube_bench_failures > 10
      for: 1h
      labels:
        severity: warning
      annotations:
        summary: "High number of CIS benchmark failures on {{ $labels.node }}"
        description: "{{ $value }} CIS benchmark failures detected. Review kube-bench output."
    - alert: CISBenchmarkFailuresCritical
      expr: kube_bench_failures > 25
      for: 30m
      labels:
        severity: critical
      annotations:
        summary: "Critical CIS benchmark failures on {{ $labels.node }}"
        description: "{{ $value }} CIS benchmark failures. Cluster security posture is degraded."
```

## Summary

CIS Kubernetes Benchmark compliance requires a layered approach:

**API server hardening** addresses the most impactful controls. Disable anonymous auth, enable audit logging with a comprehensive policy, enable admission plugins including NodeRestriction and PodSecurity, and enforce TLS 1.2+ with strong cipher suites.

**etcd encryption at rest** prevents secret exposure from storage-level attacks. Use KMS providers in production to avoid storing encryption keys on disk. After enabling, force-re-encrypt all existing secrets.

**Kubelet security** closes the most common privilege escalation path on worker nodes. Disable the read-only port, enable webhook authorization, and protect kernel defaults.

**RBAC minimization** requires systematic auditing. Find and remove cluster-admin bindings that are not absolutely necessary. Disable automounting of service account tokens by default across all namespaces.

**Pod Security Standards** apply at namespace level. Production namespaces should enforce `restricted`. Treat `baseline` as the minimum acceptable level for infrastructure namespaces.

**Network policies** with default-deny-all prevent lateral movement after a container compromise. Every namespace needs at least one NetworkPolicy with explicit allowlisting.

**Kyverno admission policies** enforce CIS controls at creation time, preventing non-compliant workloads from ever reaching production. Combine with scheduled kube-bench scans to catch drift.

**Continuous scanning** via weekly CronJobs and Prometheus alerting on failure counts gives visibility into compliance posture over time and catches regressions introduced by infrastructure changes.
