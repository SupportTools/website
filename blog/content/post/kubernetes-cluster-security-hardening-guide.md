---
title: "Kubernetes Cluster Security Hardening: CIS Benchmark Implementation"
date: 2028-01-24T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "CIS Benchmark", "RBAC", "Hardening", "etcd", "API Server", "Compliance"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Kubernetes cluster security hardening based on CIS Benchmark covering API server flags, etcd TLS, kubelet hardening, RBAC audit logging, node OS hardening, network policies default-deny, admission controllers, PodSecurity levels, and image signing enforcement."
more_link: "yes"
url: "/kubernetes-cluster-security-hardening-guide/"
---

The CIS Kubernetes Benchmark provides a systematically developed set of security configuration guidelines for Kubernetes clusters. While no single hardening standard addresses every threat model, the CIS Benchmark covers the most impactful configuration changes that reduce attack surface across the control plane, worker nodes, and workload scheduling. This guide implements the CIS Kubernetes Benchmark v1.9 recommendations with operational context for each control.

<!--more-->

# Kubernetes Cluster Security Hardening: CIS Benchmark Implementation

## Section 1: API Server Hardening

The Kubernetes API server is the central control plane component and the primary attack surface. Every interaction with the cluster passes through it.

### Critical API Server Flags

```yaml
# kube-apiserver-hardening.yaml
# For kubeadm-managed clusters, these settings go in ClusterConfiguration
# For static pod manifests: /etc/kubernetes/manifests/kube-apiserver.yaml

# Apply via kubeadm:
# kubeadm init --config kubeadm-config.yaml
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
apiServer:
  extraArgs:
    # ── Authentication ────────────────────────────────────────────────────────
    # CIS 1.2.1: Disable anonymous authentication
    # Anonymous access allows unauthenticated requests to reach the API server
    anonymous-auth: "false"

    # CIS 1.2.2: Enable authentication via x509 client certificates
    # Required for node bootstrap and component authentication
    client-ca-file: "/etc/kubernetes/pki/ca.crt"

    # ── Authorization ─────────────────────────────────────────────────────────
    # CIS 1.2.7: Use RBAC authorization mode
    # Node authorization handles kubelet requests; RBAC handles all others
    # Webhook allows external authorization via OPA/Gatekeeper
    authorization-mode: "Node,RBAC"

    # ── Admission Control ────────────────────────────────────────────────────
    # CIS 1.2.9-1.2.14: Enable required admission controllers
    enable-admission-plugins: >
      NodeRestriction,
      PodSecurity,
      EventRateLimit,
      AlwaysPullImages,
      ResourceQuota,
      LimitRanger,
      ServiceAccount,
      DefaultStorageClass,
      DefaultTolerationSeconds,
      MutatingAdmissionWebhook,
      ValidatingAdmissionWebhook

    # Disable insecure admission plugins
    disable-admission-plugins: ""

    # ── Audit Logging ─────────────────────────────────────────────────────────
    # CIS 1.2.16-1.2.22: Enable comprehensive audit logging
    audit-log-path: "/var/log/kubernetes/audit/audit.log"
    audit-log-maxage: "30"         # Retain audit logs for 30 days
    audit-log-maxbackup: "10"      # Keep 10 rotated audit log files
    audit-log-maxsize: "100"       # Rotate at 100 MB
    audit-policy-file: "/etc/kubernetes/audit-policy.yaml"

    # ── TLS Configuration ─────────────────────────────────────────────────────
    # CIS 1.2.28: Restrict TLS versions — disable TLS 1.0 and 1.1
    tls-min-version: "VersionTLS12"
    # CIS 1.2.29: Use strong cipher suites only
    tls-cipher-suites: >
      TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
      TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
      TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
      TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
      TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
      TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305

    # ── Service Account Token ─────────────────────────────────────────────────
    # CIS 1.2.23: Require TLS for service account tokens
    service-account-lookup: "true"
    # CIS 1.2.30: Ensure service account key files are protected
    service-account-key-file: "/etc/kubernetes/pki/sa.pub"
    service-account-signing-key-file: "/etc/kubernetes/pki/sa.key"
    service-account-issuer: "https://kubernetes.default.svc.cluster.local"

    # ── Request Rate Limiting ─────────────────────────────────────────────────
    # Prevent API server overload from runaway clients or attacks
    max-requests-inflight: "400"
    max-mutating-requests-inflight: "200"

    # ── Feature Gates ─────────────────────────────────────────────────────────
    # Disable alpha features in production for stability and security
    feature-gates: "RotateKubeletServerCertificate=true"

    # ── Secrets Encryption ────────────────────────────────────────────────────
    encryption-provider-config: "/etc/kubernetes/encryption-config.yaml"
```

### Audit Policy

```yaml
# audit-policy.yaml
# Comprehensive audit policy for CIS compliance and security monitoring
apiVersion: audit.k8s.io/v1
kind: Policy
# Buffer requests before writing — reduces I/O overhead
omitStages:
  - RequestReceived  # Don't log initial request receipt, only completion

rules:
  # ── Suppress noisy system-generated events ──────────────────────────────────
  # Exclude read-only API calls from system components to reduce log volume
  - level: None
    users:
      - system:kube-proxy
    verbs:
      - watch
    resources:
      - group: ""
        resources:
          - endpoints
          - services
          - services/status

  - level: None
    userGroups:
      - system:nodes
    verbs:
      - get
    resources:
      - group: ""
        resources:
          - nodes
          - nodes/status

  # ── Suppress health check noise ──────────────────────────────────────────────
  - level: None
    nonResourceURLs:
      - /healthz
      - /readyz
      - /livez
      - /metrics

  # ── Log secrets access at Request level (include request body) ────────────────
  # Critical for detecting unauthorized secret access
  - level: Request
    resources:
      - group: ""
        resources:
          - secrets
          - configmaps
          - serviceaccounts/token
    verbs:
      - get
      - list
      - watch

  # ── Log all secret writes with full details ────────────────────────────────────
  - level: RequestResponse
    resources:
      - group: ""
        resources:
          - secrets
    verbs:
      - create
      - update
      - patch
      - delete

  # ── Log RBAC changes with full details ────────────────────────────────────────
  # Any change to RBAC roles/bindings is a potential privilege escalation
  - level: RequestResponse
    resources:
      - group: rbac.authorization.k8s.io
        resources:
          - roles
          - rolebindings
          - clusterroles
          - clusterrolebindings
    verbs:
      - create
      - update
      - patch
      - delete

  # ── Log admission webhook changes ─────────────────────────────────────────────
  - level: RequestResponse
    resources:
      - group: admissionregistration.k8s.io
        resources:
          - mutatingwebhookconfigurations
          - validatingwebhookconfigurations

  # ── Log pod creation and deletion ─────────────────────────────────────────────
  - level: Request
    resources:
      - group: ""
        resources:
          - pods
    verbs:
      - create
      - delete
      - deletecollection

  # ── Log namespace operations ───────────────────────────────────────────────────
  - level: Request
    resources:
      - group: ""
        resources:
          - namespaces
    verbs:
      - create
      - delete

  # ── Default rule: metadata only for everything else ────────────────────────────
  - level: Metadata
    omitStages:
      - RequestReceived
```

## Section 2: etcd Security

```yaml
# etcd-hardening.yaml
# etcd stores all cluster state — its compromise is total cluster compromise

# kubeadm ClusterConfiguration for etcd
apiVersion: kubeadm.k8s.io/v1beta3
kind: ClusterConfiguration
etcd:
  local:
    extraArgs:
      # ── Peer TLS: etcd cluster member communication ──────────────────────────
      # CIS 2.1: Require TLS for peer communication between etcd members
      peer-auto-tls: "false"  # Disable auto-generated (unvalidated) peer certs
      peer-cert-file: "/etc/kubernetes/pki/etcd/peer.crt"
      peer-key-file: "/etc/kubernetes/pki/etcd/peer.key"
      peer-client-cert-auth: "true"  # Require client cert for peer connections
      peer-trusted-ca-file: "/etc/kubernetes/pki/etcd/ca.crt"

      # ── Client TLS: API server to etcd communication ─────────────────────────
      # CIS 2.2: Require TLS for client connections
      cert-file: "/etc/kubernetes/pki/etcd/server.crt"
      key-file: "/etc/kubernetes/pki/etcd/server.key"
      client-cert-auth: "true"  # Require client cert from API server
      trusted-ca-file: "/etc/kubernetes/pki/etcd/ca.crt"

      # ── Data Protection ────────────────────────────────────────────────────────
      # CIS 2.5: Disable etcd anonymous requests
      auto-tls: "false"

      # CIS 2.6: Protect etcd data directory
      # data-dir permissions should be 0700 (set by systemd unit or kubeadm)
      data-dir: "/var/lib/etcd"
```

```bash
#!/bin/bash
# harden-etcd-datadir.sh
# Set correct permissions on etcd data directory
# Run on each etcd node

ETCD_DATA_DIR="/var/lib/etcd"
ETCD_USER="etcd"

# Ensure etcd data directory is owned by etcd user with restricted permissions
# CIS Benchmark 2.5: etcd data directory should not be world-readable
chown -R ${ETCD_USER}:${ETCD_USER} ${ETCD_DATA_DIR}
chmod 700 ${ETCD_DATA_DIR}

echo "etcd data directory permissions:"
ls -la $(dirname ${ETCD_DATA_DIR}) | grep etcd
```

## Section 3: Kubelet Hardening

```yaml
# kubelet-configuration.yaml
# /etc/kubernetes/kubelet-config.yaml on each worker node
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration

# ── Authentication ─────────────────────────────────────────────────────────────
# CIS 4.2.1: Disable anonymous kubelet API access
authentication:
  anonymous:
    enabled: false          # Reject unauthenticated requests
  webhook:
    enabled: true           # Allow bearer token authentication
    cacheTTL: "2m"
  x509:
    clientCAFile: "/etc/kubernetes/pki/ca.crt"

# ── Authorization ──────────────────────────────────────────────────────────────
# CIS 4.2.2: Require authorization for all kubelet API requests
authorization:
  mode: Webhook             # Delegate to Kubernetes API for authorization
  webhook:
    cacheAuthorizedTTL: "5m"
    cacheUnauthorizedTTL: "30s"

# ── TLS Configuration ──────────────────────────────────────────────────────────
# CIS 4.2.9: Kubelet should use TLS for its API
tlsCertFile: "/var/lib/kubelet/pki/kubelet.crt"
tlsPrivateKeyFile: "/var/lib/kubelet/pki/kubelet.key"
# Minimum TLS version
tlsMinVersion: "VersionTLS12"
tlsCipherSuites:
  - "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256"
  - "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"
  - "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384"
  - "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"

# ── Certificate Rotation ───────────────────────────────────────────────────────
# CIS 4.2.11: Enable automatic rotation of kubelet client certificates
rotateCertificates: true

# ── Protecting Node Identity ───────────────────────────────────────────────────
# CIS 4.2.12: Ensure kubelet does not use deprecated hostname override
# Not setting hostnameOverride ensures the node uses its actual hostname

# ── Read-Only Port ─────────────────────────────────────────────────────────────
# CIS 4.2.4: Disable unauthenticated kubelet read-only port
readOnlyPort: 0  # 0 = disabled

# ── Container Runtime ──────────────────────────────────────────────────────────
containerRuntimeEndpoint: "unix:///run/containerd/containerd.sock"

# ── Event Recording ────────────────────────────────────────────────────────────
# Limit event burst to prevent event flooding
eventRecordQPS: 50
eventBurst: 100

# ── Eviction ───────────────────────────────────────────────────────────────────
evictionHard:
  memory.available: "200Mi"
  nodefs.available: "5%"
  nodefs.inodesFree: "2%"
  imagefs.available: "10%"

# ── Sysctls ────────────────────────────────────────────────────────────────────
# Explicitly list allowed unsafe sysctls (empty = none allowed)
allowedUnsafeSysctls: []

# ── Image Pull Policy ─────────────────────────────────────────────────────────
# Serialize image pulls to prevent disk I/O contention
serializeImagePulls: true
maxParallelImagePulls: 3

# ── Garbage Collection ─────────────────────────────────────────────────────────
imageGCHighThresholdPercent: 85
imageGCLowThresholdPercent: 80
containerLogMaxSize: "100Mi"
containerLogMaxFiles: 5
```

## Section 4: RBAC Hardening

### Least-Privilege Service Accounts

```yaml
# rbac-hardening.yaml

# ── Remove overly-permissive default ClusterRoleBindings ──────────────────────
# CIS 5.1.1: Avoid overly permissive roles
# The default system:aggregate-to-admin ClusterRole allows escalation
# Review all ClusterRoleBindings that reference cluster-admin

# CIS 5.1.5: Restrict default service account permissions
# Default service account in every namespace should have no API access
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system:default-sa-readonly-restriction
  annotations:
    # Document why default service account is restricted
    rbac.kubernetes.io/autoupdate: "false"
subjects:
  # This is a placeholder — actual removal requires:
  # kubectl patch clusterrolebinding system:discovery \
  #   --type=json -p='[{"op":"remove","path":"/subjects/0"}]'

---
# ── Minimal service account for production workloads ─────────────────────────
apiVersion: v1
kind: ServiceAccount
metadata:
  name: payment-service
  namespace: production
  # CIS 5.1.6: Disable automounting service account tokens
  # when the application doesn't need API access
automountServiceAccountToken: false
---
# Service account that DOES need API access: minimal permissions
apiVersion: v1
kind: ServiceAccount
metadata:
  name: config-watcher
  namespace: production
automountServiceAccountToken: true  # Needed for API access
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: configmap-watcher
  namespace: production
rules:
  # Only the specific permissions needed — nothing more
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["application-config"]  # Explicitly named resource
    verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: config-watcher-configmap-access
  namespace: production
subjects:
  - kind: ServiceAccount
    name: config-watcher
    namespace: production
roleRef:
  kind: Role
  name: configmap-watcher
  apiGroup: rbac.authorization.k8s.io
```

### RBAC Audit Script

```bash
#!/bin/bash
# rbac-audit.sh
# Identify overly permissive RBAC bindings

echo "=== Kubernetes RBAC Security Audit ==="
echo ""

# 1. Find all subjects with cluster-admin privileges
echo "--- Subjects with cluster-admin ClusterRole ---"
kubectl get clusterrolebinding \
  -o json \
  | jq -r '
    .items[] |
    .metadata.name as $binding |
    select(.roleRef.name == "cluster-admin") |
    .subjects[]? |
    "\($binding)\t\(.kind)\t\(.name)\t\(.namespace // "cluster-scoped")"
  ' \
  | column -t -s $'\t' -N "BINDING,KIND,NAME,NAMESPACE"

# 2. Find wildcard permissions (*, *, *)
echo ""
echo "--- Roles/ClusterRoles with wildcard permissions ---"
kubectl get clusterrole,role \
  --all-namespaces \
  -o json \
  | jq -r '
    .items[] |
    .metadata.name as $name |
    .metadata.namespace as $ns |
    .rules[] |
    select(
      (.apiGroups | map(. == "*") | any) or
      (.resources | map(. == "*") | any) or
      (.verbs | map(. == "*") | any)
    ) |
    "\($name)\t\($ns // "ClusterRole")\t\(.apiGroups)\t\(.resources)\t\(.verbs)"
  ' \
  | column -t -s $'\t' -N "NAME,NAMESPACE,API_GROUPS,RESOURCES,VERBS"

# 3. Find service accounts with cluster-wide access
echo ""
echo "--- Service Accounts with ClusterRole bindings ---"
kubectl get clusterrolebinding \
  -o json \
  | jq -r '
    .items[] |
    .metadata.name as $binding |
    .roleRef.name as $role |
    .subjects[]? |
    select(.kind == "ServiceAccount") |
    "\(.namespace)/\(.name)\t\($role)\t\($binding)"
  ' \
  | sort \
  | column -t -s $'\t' -N "SERVICE_ACCOUNT,ROLE,BINDING"

# 4. Find pods with automounted service account tokens that may not need them
echo ""
echo "--- Pods with Automounted Service Account Tokens (potential risk) ---"
kubectl get pods --all-namespaces \
  -o json \
  | jq -r '
    .items[] |
    select(
      .spec.automountServiceAccountToken == true or
      .spec.automountServiceAccountToken == null  # null defaults to true
    ) |
    # Exclude system namespaces
    select(
      .metadata.namespace |
      IN("kube-system", "kube-public", "kube-node-lease") |
      not
    ) |
    [.metadata.namespace, .metadata.name, .spec.serviceAccountName] | @tsv
  ' \
  | column -t -s $'\t' -N "NAMESPACE,POD,SERVICE_ACCOUNT" \
  | head -50
```

## Section 5: Network Policies — Default Deny

```yaml
# default-deny-network-policy.yaml
# CIS 5.3.2: All namespaces should have network policies

# Default deny for all namespaces — apply to every namespace
# This is the recommended starting point; then add allow rules as needed
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: production
  annotations:
    # Document why this policy exists and what it does
    policy.kubernetes.io/description: "Default deny-all ingress and egress. Add more specific allow policies as needed."
spec:
  podSelector: {}  # Applies to ALL pods in namespace
  policyTypes:
    - Ingress
    - Egress
  # No ingress or egress rules = deny everything
---
# Allow DNS egress from all pods — required for service discovery
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-egress
  namespace: production
spec:
  podSelector: {}  # All pods
  policyTypes:
    - Egress
  egress:
    # Allow UDP and TCP DNS queries to CoreDNS
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
---
# Allow payment-service to reach its dependencies
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: payment-service-allow
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: payment-service
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Accept traffic from ingress controller
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/component: controller
      ports:
        - protocol: TCP
          port: 8080
    # Accept traffic from other services in the same namespace
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: production
          podSelector:
            matchLabels:
              allow-payment-service: "true"
      ports:
        - protocol: TCP
          port: 8080

  egress:
    # Allow connection to PostgreSQL
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: databases
          podSelector:
            matchLabels:
              app: postgresql
      ports:
        - protocol: TCP
          port: 5432
    # Allow connection to Redis
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: caches
          podSelector:
            matchLabels:
              app: redis
      ports:
        - protocol: TCP
          port: 6379
    # Allow HTTPS to external payment processors
    - ports:
        - protocol: TCP
          port: 443
```

## Section 6: Pod Security Standards

### PodSecurity Admission Controller

```yaml
# pod-security-namespaces.yaml
# CIS 5.2: Configure PodSecurity admission at namespace level
# Three levels: privileged (no restrictions), baseline (minimum restrictions), restricted (maximum)

# Production: use restricted mode for most workloads
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Enforce: reject pods that violate the policy
    pod-security.kubernetes.io/enforce: restricted
    # Warn: allow pods but warn about violations (useful during migration)
    pod-security.kubernetes.io/warn: restricted
    # Audit: log violations to audit log
    pod-security.kubernetes.io/audit: restricted
    # Version: use the policy from this Kubernetes version
    pod-security.kubernetes.io/enforce-version: v1.29
    pod-security.kubernetes.io/warn-version: v1.29
    pod-security.kubernetes.io/audit-version: v1.29
---
# Infrastructure namespaces: use baseline (some privileged operations required)
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/enforce-version: v1.29
---
# System namespace: privileged (required for system components)
# kube-system already has privileged mode by default
# Only change if you have specific requirements
```

### Restricted Policy Compliance

```yaml
# restricted-pod-example.yaml
# Example pod that complies with PodSecurity restricted policy
apiVersion: v1
kind: Pod
metadata:
  name: restricted-compliant-pod
  namespace: production
spec:
  # ── Restricted policy requirements ──────────────────────────────────────────
  securityContext:
    # Must not run as root
    runAsNonRoot: true
    # Explicit user ID (preferred for restricted)
    runAsUser: 1000
    runAsGroup: 1000
    # Seccomp profile required for restricted policy
    seccompProfile:
      type: RuntimeDefault  # Use containerd's default seccomp profile

  containers:
    - name: app
      image: app:latest
      securityContext:
        # Required: no privilege escalation
        allowPrivilegeEscalation: false
        # Required: read-only root filesystem
        readOnlyRootFilesystem: true
        # Required: drop all Linux capabilities
        capabilities:
          drop:
            - ALL
          # Only add capabilities that are explicitly needed
          # add: [] (empty for most applications)
        # Required: non-root user
        runAsNonRoot: true
        runAsUser: 1000

      # Applications needing writable directories must use emptyDir volumes
      volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: app-data
          mountPath: /var/app/data

  volumes:
    - name: tmp
      emptyDir: {}
    - name: app-data
      emptyDir:
        sizeLimit: "1Gi"
```

## Section 7: Image Signing Enforcement

### Cosign and Admission Webhook

```yaml
# image-signing-policy.yaml
# Enforce signed container images using Kyverno or Sigstore policy-controller

# Install policy-controller:
# helm install policy-controller sigstore/policy-controller -n cosign-system
apiVersion: policy.sigstore.dev/v1beta1
kind: ClusterImagePolicy
metadata:
  name: enforce-signed-images
spec:
  images:
    # Enforce signing for production registry images
    - glob: "registry.example.com/**"

  authorities:
    # Images must be signed by this key or keyless identity
    - key:
        hashAlgorithm: sha256
        # Public key in PEM format — corresponds to the CI/CD signing key
        data: |
          -----BEGIN PUBLIC KEY-----
          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPLACPLACPLACPLACPLACPLACPLAC
          PLACEHOLDER_PUBLIC_KEY_DATA_HERE_NOT_REAL_KEY_PLACEHOLDER
          -----END PUBLIC KEY-----

    # Keyless: signed by GitHub Actions CI/CD identity
    - keyless:
        url: "https://fulcio.sigstore.dev"
        identities:
          - issuer: "https://token.actions.githubusercontent.com"
            subject: "https://github.com/example-org/example-repo/.github/workflows/release.yml@refs/heads/main"
---
# Kyverno alternative: verify image signatures
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce  # Reject pods with unsigned images
  background: false                  # Only verify on admission, not existing pods
  rules:
    - name: verify-signature
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - production
                - staging
      verifyImages:
        - imageReferences:
            - "registry.example.com/*"
          attestors:
            - count: 1
              entries:
                - keyless:
                    subject: "https://github.com/example-org/*/.github/workflows/*.yml@refs/heads/main"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: "https://rekor.sigstore.dev"
```

## Section 8: Node OS Hardening

```bash
#!/bin/bash
# harden-kubernetes-node.sh
# Apply OS-level hardening to Kubernetes worker nodes
# Run on each worker node during provisioning

set -euo pipefail

echo "=== Kubernetes Node OS Hardening ==="

# ── Kernel Parameter Hardening ────────────────────────────────────────────────
cat > /etc/sysctl.d/99-kubernetes-hardening.conf << 'EOF'
# CIS Section 3: Networking parameters
# Disable IP forwarding for non-router nodes
# Note: Container networking requires this to be 1 — kubelet sets it
net.ipv4.ip_forward = 1

# Disable ICMP redirects (prevents routing attacks)
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# Disable source routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# Enable TCP SYN flood protection
net.ipv4.tcp_syncookies = 1

# Log suspicious packets (Martian packets — packets with impossible source addresses)
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1

# Ignore ICMP broadcasts (Smurf amplification prevention)
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable IP spoofing
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Protect against kernel pointer leaks (KASLR bypass)
kernel.kptr_restrict = 2

# Restrict dmesg access to root only
kernel.dmesg_restrict = 1

# Restrict ptrace to root and children only
kernel.yama.ptrace_scope = 1

# Disable core dumps for setuid programs
fs.suid_dumpable = 0
EOF

sysctl --system

# ── File Permissions Hardening ────────────────────────────────────────────────
echo "--- Hardening file permissions ---"

# CIS 4.1.1: Kubelet configuration file permissions
chmod 600 /etc/kubernetes/kubelet.conf 2>/dev/null || true
chmod 600 /var/lib/kubelet/config.yaml 2>/dev/null || true

# CIS 4.1.3: Proxy kubeconfig file permissions
chmod 600 /etc/kubernetes/kube-proxy.conf 2>/dev/null || true

# Kubernetes PKI files
find /etc/kubernetes/pki -name "*.key" -exec chmod 600 {} \;
find /etc/kubernetes/pki -name "*.crt" -exec chmod 644 {} \;
find /etc/kubernetes/pki -name "*.pub" -exec chmod 644 {} \;

# ── SSH Hardening ─────────────────────────────────────────────────────────────
echo "--- Hardening SSH daemon ---"
cat >> /etc/ssh/sshd_config << 'EOF'

# Kubernetes node SSH hardening
Protocol 2
PermitRootLogin no
PasswordAuthentication no
PermitEmptyPasswords no
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
PrintMotd no
MaxAuthTries 3
MaxSessions 10
LoginGraceTime 60
ClientAliveInterval 300
ClientAliveCountMax 2
AllowGroups ssh-users
EOF

systemctl restart sshd

# ── Unnecessary Service Removal ───────────────────────────────────────────────
echo "--- Disabling unnecessary services ---"
DISABLE_SERVICES=(
  "rpcbind"
  "nfs-server"
  "avahi-daemon"
  "cups"
  "dhcpd"
  "vsftpd"
  "dovecot"
  "smb"
)

for SERVICE in "${DISABLE_SERVICES[@]}"; do
  systemctl disable --now "${SERVICE}" 2>/dev/null && \
    echo "  Disabled: ${SERVICE}" || \
    echo "  Not installed: ${SERVICE}"
done

# ── Firewall Configuration ────────────────────────────────────────────────────
echo "--- Configuring firewall for Kubernetes worker node ---"

# Worker node ports (from Kubernetes documentation):
# 10250/tcp: kubelet API
# 10255/tcp: Read-only kubelet API (disabled if kubelet hardened)
# 30000-32767/tcp: NodePort services (only if using NodePort)

# Using iptables directly (UFW/firewalld may interfere with kube-proxy)
# These rules allow required cluster communication
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j ACCEPT      # SSH
iptables -A INPUT -p tcp --dport 10250 -j ACCEPT   # kubelet API (from control plane)
# Drop everything else
# Note: kube-proxy manages iptables rules for pod networking
# Do not add a blanket DROP rule before kube-proxy rules are established

echo "Node hardening complete."
```

## Section 9: Admission Controllers

### OPA Gatekeeper Policies

```yaml
# opa-gatekeeper-policies.yaml
# CIS 5.2.7: Prevent privileged containers
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8spspprivilegedcontainer
spec:
  crd:
    spec:
      names:
        kind: K8sPSPPrivilegedContainer
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8spspprivilegedcontainer

        import future.keywords.contains
        import future.keywords.if

        violation contains msg if {
          # Check containers
          c := input.review.object.spec.containers[_]
          c.securityContext.privileged == true
          msg := sprintf("Container <%v> in pod <%v> is running as privileged.",
            [c.name, input.review.object.metadata.name])
        }

        violation contains msg if {
          # Check init containers
          c := input.review.object.spec.initContainers[_]
          c.securityContext.privileged == true
          msg := sprintf("Init container <%v> in pod <%v> is running as privileged.",
            [c.name, input.review.object.metadata.name])
        }
---
# Apply the constraint
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPSPPrivilegedContainer
metadata:
  name: psp-privileged-container
spec:
  enforcementAction: deny  # deny | warn | dryrun
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - production
      - staging
    excludedNamespaces:
      - kube-system
      - monitoring
---
# Require resource limits on all containers
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredresources
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredResources
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredresources

        import future.keywords.contains
        import future.keywords.if

        violation contains msg if {
          c := input.review.object.spec.containers[_]
          not c.resources.limits.memory
          msg := sprintf("Container <%v> does not have a memory limit.", [c.name])
        }

        violation contains msg if {
          c := input.review.object.spec.containers[_]
          not c.resources.requests.memory
          msg := sprintf("Container <%v> does not have a memory request.", [c.name])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredResources
metadata:
  name: require-resource-limits
spec:
  enforcementAction: deny
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - production
```

## Section 10: CIS Benchmark Validation

```bash
#!/bin/bash
# run-cis-benchmark.sh
# Run kube-bench to validate CIS Benchmark compliance

# Install kube-bench: https://github.com/aquasecurity/kube-bench
# Run on control plane nodes for master checks
# Run on worker nodes for node checks

# Method 1: Run directly on the node
if command -v kube-bench > /dev/null 2>&1; then
  echo "Running kube-bench CIS assessment..."
  kube-bench \
    --benchmark cis-1.9 \
    run \
    --targets master,node,etcd,policies \
    --json \
    > /tmp/kube-bench-results.json

  # Summary
  echo ""
  echo "=== CIS Benchmark Summary ==="
  jq -r '.Controls[] | "\(.text): PASS=\(.pass) FAIL=\(.fail) WARN=\(.warn)"' \
    /tmp/kube-bench-results.json
fi

# Method 2: Run as a Kubernetes Job
cat << 'EOF' | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: kube-bench
  namespace: kube-system
spec:
  template:
    spec:
      hostPID: true
      nodeName: ""  # Set to specific node name to target
      restartPolicy: Never
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: kube-bench
          image: aquasec/kube-bench:latest
          command:
            - kube-bench
            - --benchmark
            - cis-1.9
            - run
            - --targets
            - master,node,etcd,policies
          volumeMounts:
            - name: var-lib-etcd
              mountPath: /var/lib/etcd
              readOnly: true
            - name: etc-kubernetes
              mountPath: /etc/kubernetes
              readOnly: true
            - name: etc-systemd
              mountPath: /etc/systemd
              readOnly: true
            - name: usr-bin
              mountPath: /usr/local/mount-from-host/bin
              readOnly: true
      volumes:
        - name: var-lib-etcd
          hostPath:
            path: "/var/lib/etcd"
        - name: etc-kubernetes
          hostPath:
            path: "/etc/kubernetes"
        - name: etc-systemd
          hostPath:
            path: "/etc/systemd"
        - name: usr-bin
          hostPath:
            path: "/usr/bin"
EOF

# Wait for job completion and get results
kubectl wait job/kube-bench -n kube-system --for=condition=complete --timeout=5m
kubectl logs job/kube-bench -n kube-system | grep -E "^\[PASS\]|^\[FAIL\]|^\[WARN\]"
```

## Summary

Kubernetes cluster security hardening addresses a defense-in-depth strategy across four layers:

**Control plane security**: API server flags eliminate anonymous access, enforce RBAC authorization, enable audit logging, and restrict TLS to modern versions. etcd mutual TLS prevents access by unauthorized API servers. The audit policy provides detailed logging of security-sensitive operations (secret access, RBAC changes, pod creation) while suppressing routine noise.

**Workload security**: PodSecurity admission enforces the CIS-recommended "restricted" policy for production namespaces, preventing privileged containers, requiring read-only root filesystems, and mandating capability drops. OPA Gatekeeper provides fine-grained policy enforcement beyond what PodSecurity covers.

**Network security**: Default-deny NetworkPolicies require explicit allow rules for all ingress and egress traffic, enforcing microsegmentation at the pod level. This limits lateral movement when a workload is compromised.

**Supply chain security**: Image signing enforcement via Cosign/Sigstore policy-controller or Kyverno ensures that only images built by authorized CI/CD pipelines can be scheduled in production namespaces, preventing malicious image injection.

Running kube-bench regularly against the CIS Kubernetes Benchmark provides a quantitative assessment of compliance posture and identifies configuration drift over time.
