---
title: "Kubernetes Pod Security Admission: Replacing PodSecurityPolicy"
date: 2027-12-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Pod Security Admission", "PSA", "PSP", "seccomp", "AppArmor", "RBAC"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes Pod Security Admission replacing PodSecurityPolicy: PSA levels, namespace labels, warn/audit/enforce modes, PSP migration strategy, seccomp profiles, and AppArmor configuration."
more_link: "yes"
url: /kubernetes-psa-advanced-enterprise-guide/
---

PodSecurityPolicy was deprecated in Kubernetes 1.21 and removed in 1.25. Pod Security Admission (PSA) is its replacement, built directly into the API server as an admission controller. PSA enforces the Pod Security Standards: three pre-defined security profiles (privileged, baseline, restricted) applied at the namespace level. This guide covers the full migration from PSP, production configuration of all three modes, seccomp and AppArmor integration, and exceptions for workloads that cannot meet the restricted profile.

<!--more-->

# Kubernetes Pod Security Admission: Replacing PodSecurityPolicy

## The PSP Problem

PodSecurityPolicy had fundamental design flaws that made it operationally painful:

1. **RBAC complexity**: PSPs required `use` permission on the policy resource. Getting the right policy to apply to the right workload via ServiceAccount bindings was error-prone.
2. **No dry-run**: PSP had no warning-only mode. Testing policy changes required deploying to a separate cluster.
3. **Admission ordering**: When multiple PSPs applied to a workload, the selection behavior was non-deterministic.
4. **Mutation without visibility**: PSPs could mutate pod specs silently, making it difficult to understand what the actual pod configuration was.

Pod Security Admission addresses all of these by operating at the namespace level with three modes: enforce (reject), audit (log to audit), and warn (return warning headers). This makes PSA testable without blocking deployments.

## Pod Security Standards

PSA enforces three security standards:

### Privileged

No restrictions. Equivalent to no PSP. Used for:
- Kubernetes system namespaces (`kube-system`)
- Infrastructure workloads that require privileged access
- CNI, CSI, and device plugin DaemonSets

### Baseline

Prevents known privilege escalations. Specifically blocks:
- `hostProcess: true`
- `hostPID: true` / `hostIPC: true`
- `hostNetwork: true`
- `hostPort` assignments
- Most `capabilities` additions (allows `NET_BIND_SERVICE`)
- `privileged: true` containers
- Most `securityContext.procMount` values
- Most `volumes` of type `hostPath` (specific paths blocked)

### Restricted

Most restrictive. Encompasses baseline plus:
- Requires `runAsNonRoot: true`
- Requires `allowPrivilegeEscalation: false`
- Drops all capabilities (requires explicit `add` only)
- Restricts volume types to specific safe list
- Requires `seccompProfile.type` to be `RuntimeDefault` or `Localhost`

## Namespace Labels

PSA is configured entirely via namespace labels. No cluster-wide policy is required.

### Label Syntax

```
pod-security.kubernetes.io/<MODE>: <LEVEL>
pod-security.kubernetes.io/<MODE>-version: <VERSION>
```

Where:
- `<MODE>`: `enforce`, `audit`, `warn`
- `<LEVEL>`: `privileged`, `baseline`, `restricted`
- `<VERSION>`: Kubernetes version (e.g., `v1.28`) or `latest`

### Recommended Production Configuration

```yaml
# Most workload namespaces: enforce baseline, warn on restricted violations
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
```

```yaml
# Highly sensitive namespaces: enforce restricted
apiVersion: v1
kind: Namespace
metadata:
  name: payments
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.28
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.28
```

```yaml
# Infrastructure namespace: privileged allowed
apiVersion: v1
kind: Namespace
metadata:
  name: monitoring
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/warn: baseline
    pod-security.kubernetes.io/audit: baseline
```

```yaml
# kube-system: no restrictions (required for system components)
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
```

## Applying Labels to Existing Namespaces

When labeling namespaces with existing workloads, use the `--dry-run` flag first to identify violations:

```bash
# Dry-run: check what would fail if namespace was set to restricted
kubectl label --dry-run=server --overwrite namespace production \
  pod-security.kubernetes.io/enforce=restricted

# Output shows which existing pods would be rejected:
# Warning: existing pods in namespace "production" violate the new PodSecurity enforce level "restricted:latest"
# Warning: api-deployment-7d4b9f8-abc12: allowPrivilegeEscalation != false, unrestricted capabilities
```

Apply labels incrementally, starting with warn mode:

```bash
# Step 1: Add warn labels - observe warnings without blocking
kubectl label namespace production \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.28 \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=v1.28

# Step 2: Monitor audit events for violations
kubectl get events -n production --field-selector reason=FailedCreate

# Step 3: Fix violating workloads
# Step 4: Apply enforce label
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.28
```

## securityContext Best Practices for Restricted Level

Meeting the `restricted` level requires specific securityContext configuration:

### Deployment Meeting Restricted Level

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-api
  namespace: payments
spec:
  replicas: 3
  selector:
    matchLabels:
      app: secure-api
  template:
    metadata:
      labels:
        app: secure-api
    spec:
      # Pod-level security context
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
        # Supplement groups for file access
        supplementalGroups:
          - 2000
      automountServiceAccountToken: false
      containers:
        - name: api
          image: company/secure-api:1.0.0
          # Container-level security context
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            capabilities:
              drop:
                - ALL
              # Only add back what is needed
              # add: [NET_BIND_SERVICE]  # Only if binding port < 1024
          ports:
            - containerPort: 8080
              protocol: TCP
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: cache
              mountPath: /var/cache/app
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
      volumes:
        - name: tmp
          emptyDir: {}
        - name: cache
          emptyDir: {}
```

### Checking Security Context Compliance

```bash
# Check if a deployment's pods would pass the restricted profile
kubectl run test-pod --dry-run=server \
  --image=company/app:latest \
  -n payments 2>&1 | grep -i warning

# For existing deployments, check violations
kubectl get pods -n payments -o json | jq '
  .items[] |
  .metadata.name as $name |
  .spec.containers[] |
  select(
    .securityContext.allowPrivilegeEscalation != false or
    .securityContext.runAsNonRoot != true or
    (.securityContext.capabilities.drop | index("ALL")) == null
  ) |
  "\($name): \(.name) - security context violation"
'
```

## seccomp Profiles

Seccomp (secure computing mode) restricts which system calls a container can make. PSA restricted level requires either `RuntimeDefault` or `Localhost` seccomp profiles.

### RuntimeDefault

`RuntimeDefault` uses the container runtime's default seccomp profile, which blocks dangerous syscalls while allowing normal application operation.

```yaml
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
```

### Custom Localhost Profile

For applications requiring specific syscalls not in the default profile:

```bash
# Create a custom seccomp profile
mkdir -p /var/lib/kubelet/seccomp/profiles

cat > /var/lib/kubelet/seccomp/profiles/custom-app.json << 'EOF'
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "arch_prctl", "bind", "brk", "clone",
        "close", "connect", "dup", "dup2", "epoll_create", "epoll_create1",
        "epoll_ctl", "epoll_pwait", "epoll_wait", "execve", "exit",
        "exit_group", "fchmod", "fcntl", "fstat", "futex", "getcwd",
        "getdents64", "getegid", "geteuid", "getgid", "getpid", "getppid",
        "getsockname", "getsockopt", "getuid", "ioctl", "lseek",
        "madvise", "mmap", "mprotect", "munmap", "nanosleep", "newfstatat",
        "openat", "pipe", "pipe2", "poll", "prctl", "pread64",
        "read", "recvfrom", "recvmsg", "rseq", "rt_sigaction",
        "rt_sigprocmask", "rt_sigreturn", "sendmsg", "sendto",
        "set_robust_list", "set_tid_address", "setsockopt", "shutdown",
        "socket", "stat", "tgkill", "uname", "wait4", "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
EOF
```

Reference in pod spec:

```yaml
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/custom-app.json
```

## AppArmor Profiles

AppArmor provides mandatory access control on Linux, restricting file system access, network operations, and capability usage per process.

### Applying AppArmor via Annotation (Kubernetes < 1.30)

```yaml
metadata:
  annotations:
    container.apparmor.security.beta.kubernetes.io/app: runtime/default
```

### Applying AppArmor via securityContext (Kubernetes 1.30+)

```yaml
spec:
  containers:
    - name: app
      securityContext:
        appArmorProfile:
          type: RuntimeDefault
          # type: Localhost
          # localhostProfile: custom-profile
```

### Custom AppArmor Profile

```bash
# Create custom AppArmor profile
cat > /etc/apparmor.d/custom-app << 'EOF'
#include <tunables/global>

profile custom-app flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  # Allow network operations
  network inet tcp,
  network inet udp,

  # Allow read-only access to config
  /etc/app/** r,

  # Allow write to app-specific directories
  /var/log/app/** rw,
  /tmp/** rw,

  # Block sensitive files
  deny /etc/passwd r,
  deny /etc/shadow r,
  deny /proc/*/mem rw,
}
EOF

# Load profile
apparmor_parser -r -W /etc/apparmor.d/custom-app

# Verify it loaded
aa-status | grep custom-app
```

## Migrating from PodSecurityPolicy

### PSP to PSA Mapping

| PSP Field | PSA Equivalent |
|---|---|
| `privileged: false` | baseline/restricted level |
| `hostPID: false` | baseline/restricted level |
| `hostIPC: false` | baseline/restricted level |
| `hostNetwork: false` | baseline/restricted level |
| `runAsNonRoot: true` | restricted level |
| `allowPrivilegeEscalation: false` | restricted level |
| `defaultAddCapabilities: []` | securityContext.capabilities.add |
| `requiredDropCapabilities: [ALL]` | securityContext.capabilities.drop: [ALL] |
| `volumes:` allowed list | restricted level volume restrictions |
| `seLinux:` | Not directly supported by PSA |
| `seccompProfiles:` | securityContext.seccompProfile |

### PSP Migration Script

```bash
#!/bin/bash
# psp-migration-analysis.sh
# Analyze existing PSPs and identify equivalent PSA levels

set -euo pipefail

echo "=== PSP Migration Analysis ==="
echo ""

# List all PSPs and their key settings
kubectl get psp -o json 2>/dev/null | jq -r '
  .items[] |
  {
    name: .metadata.name,
    privileged: (.spec.privileged // false),
    hostPID: (.spec.hostPID // false),
    hostIPC: (.spec.hostIPC // false),
    hostNetwork: (.spec.hostNetwork // false),
    runAsNonRoot: (.spec.runAsUser.rule // ""),
    readOnlyRootFilesystem: (.spec.readOnlyRootFilesystem // false),
    dropCapabilities: (.spec.requiredDropCapabilities // [])
  } |
  "PSP: \(.name)\n  privileged=\(.privileged) hostPID=\(.hostPID) hostIPC=\(.hostIPC) hostNetwork=\(.hostNetwork)"
'

echo ""
echo "=== Namespaces using PSPs ==="
kubectl get rolebinding,clusterrolebinding -A -o json | jq -r '
  .items[] |
  select(.roleRef.name | startswith("psp:")) |
  "\(.metadata.namespace // "cluster"): \(.roleRef.name)"
' | sort -u

echo ""
echo "=== Suggested namespace labels ==="
# For each namespace, suggest appropriate PSA level
for NS in $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}'); do
  # Check if any pods in namespace use privileged containers
  PRIVILEGED=$(kubectl get pods -n "$NS" -o json 2>/dev/null | \
    jq '[.items[].spec.containers[].securityContext.privileged // false] | any' 2>/dev/null || echo "false")

  if [ "$PRIVILEGED" = "true" ]; then
    echo "  $NS: privileged (has privileged containers)"
  else
    echo "  $NS: baseline (recommended starting point)"
  fi
done
```

### Zero-Downtime PSP Removal

```bash
# Step 1: Install PSA admission controller (already built-in from 1.22+)
# Step 2: Add PSA labels to namespaces in warn mode
kubectl get namespaces -o name | while read ns; do
  kubectl label "$ns" \
    pod-security.kubernetes.io/warn=baseline \
    pod-security.kubernetes.io/warn-version=v1.28 \
    --overwrite 2>/dev/null || true
done

# Step 3: Monitor for warnings for 1-2 weeks
kubectl get events -A --field-selector reason=FailedCreate | grep "violate"

# Step 4: Fix violating workloads

# Step 5: Switch to enforce mode namespace by namespace
kubectl label namespace low-risk-namespace \
  pod-security.kubernetes.io/enforce=baseline --overwrite

# Step 6: After all namespaces are covered, disable PSP
# Edit kube-apiserver: remove PodSecurityPolicy from --enable-admission-plugins
```

## Admission Controller Configuration

The PSA admission controller can be configured cluster-wide via the `PodSecurity` admission plugin configuration:

```yaml
# /etc/kubernetes/psa-config.yaml
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
        # Exempt specific usernames (service accounts creating privileged pods)
        usernames:
          - "system:serviceaccount:kube-system:daemon-set-controller"
        # Exempt specific runtime classes
        runtimeClasses: []
        # Exempt specific namespaces from cluster defaults
        namespaces:
          - kube-system
          - kube-public
          - kube-node-lease
```

Pass this configuration to the API server:

```yaml
# kube-apiserver manifest addition
- --admission-plugin-config-file=/etc/kubernetes/psa-config.yaml
```

## Common Violations and Fixes

### Volume Type Violations

```yaml
# VIOLATION: hostPath volume not allowed in restricted
volumes:
  - name: data
    hostPath:
      path: /var/data

# FIX: Use PVC or emptyDir
volumes:
  - name: data
    persistentVolumeClaim:
      claimName: app-data-pvc
  - name: temp
    emptyDir:
      sizeLimit: 1Gi
```

### Privilege Escalation

```yaml
# VIOLATION: missing allowPrivilegeEscalation: false
containers:
  - name: app
    securityContext:
      runAsUser: 1000
      # Missing: allowPrivilegeEscalation: false

# FIX:
containers:
  - name: app
    securityContext:
      runAsUser: 1000
      allowPrivilegeEscalation: false
      capabilities:
        drop:
          - ALL
```

### Root Process Violations

```yaml
# VIOLATION: running as root or no user specified
spec:
  containers:
    - name: nginx
      image: nginx:latest
      # No securityContext - defaults to running as root

# FIX: Use non-root nginx image and configure user
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 101    # nginx non-root image uses uid 101
  containers:
    - name: nginx
      image: nginxinc/nginx-unprivileged:latest
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop:
            - ALL
```

## Audit Logging for PSA Violations

Configure audit logging to capture PSA violations in the audit log:

```yaml
# audit-policy.yaml
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  # Capture PSA violations at metadata level
  - level: Metadata
    resources:
      - group: ""
        resources: ["pods"]
    stages:
      - ResponseComplete
    omitStages:
      - RequestReceived
    annotations:
      authorization.k8s.io/reason: "pod-security"
```

Query audit logs for PSA violations:

```bash
# Find PSA enforcement violations in audit log
jq 'select(.annotations."pod-security.kubernetes.io/enforce-policy" != null)' \
  /var/log/kubernetes/audit.log | head -20

# Find warnings (non-blocking violations)
jq 'select(
  .responseObject.metadata.annotations |
  to_entries[] |
  .key | startswith("pod-security.kubernetes.io/warn")
)' /var/log/kubernetes/audit.log
```

## Summary

Pod Security Admission represents a significant improvement over PodSecurityPolicy in simplicity and operability. The namespace-label approach with warn/audit/enforce modes enables risk-free migration: warn mode reveals all violations before enforcement begins. The three-tier standard (privileged, baseline, restricted) covers the vast majority of enterprise use cases without requiring custom policy definitions.

The migration strategy for production clusters: apply warn labels to all namespaces immediately to establish a baseline, remediate violations over time, then convert to enforce labels namespace by namespace starting with the lowest-risk workloads. The `restricted` level with seccomp `RuntimeDefault` and dropped capabilities represents current Kubernetes security best practices for application workloads. Only infrastructure components with genuine system-level access requirements belong in `privileged` or `baseline` namespaces.
