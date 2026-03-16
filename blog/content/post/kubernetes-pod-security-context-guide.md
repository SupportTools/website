---
title: "Kubernetes Pod Security Context: Non-Root Containers, Capabilities, and Hardening Patterns"
date: 2027-06-01T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Pod Security", "Containers", "Hardening", "RBAC"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Kubernetes pod and container security contexts covering runAsNonRoot, Linux capabilities, seccomp profiles, read-only filesystems, Pod Security Standards, and hardening patterns for enterprise environments."
more_link: "yes"
url: "/kubernetes-pod-security-context-guide/"
---

Container security misconfiguration remains one of the most common vectors in Kubernetes compromise incidents. Pods running as root, with excess Linux capabilities, or with writable filesystems provide attackers with straightforward escalation paths after achieving any foothold in a container. Kubernetes security contexts expose the kernel-level security controls that harden containers against these attacks without requiring custom container images. This guide covers every significant security context field, their interactions, practical hardening patterns for production workloads, and integration with Pod Security Standards enforcement.

<!--more-->

## Pod-Level vs Container-Level Security Context

Kubernetes provides security context configuration at two levels: the pod spec and the individual container spec. Understanding which settings belong at which level is fundamental to correct configuration.

**Pod-level `securityContext`** (`spec.securityContext`) applies to all containers in the pod and controls settings that are shared across the pod's process namespace:

- `runAsUser`, `runAsGroup`, `runAsNonRoot`
- `fsGroup`, `fsGroupChangePolicy`, `supplementalGroups`
- `sysctls`
- `seccompProfile`
- `seLinuxOptions`
- `windowsOptions`

**Container-level `securityContext`** (`spec.containers[].securityContext`) applies to a single container and can override or extend the pod-level settings. Container-level settings control Linux process attributes that are per-process rather than per-pod:

- `capabilities` (add/drop)
- `privileged`
- `allowPrivilegeEscalation`
- `readOnlyRootFilesystem`
- `runAsUser`, `runAsGroup`, `runAsNonRoot` (override pod-level)
- `procMount`
- `seccompProfile` (override pod-level)
- `seLinuxOptions`

A general rule: set identity defaults (user, group, non-root enforcement) at the pod level for consistency, and set process-specific security controls (capabilities, privilege escalation, filesystem access) at the container level for precision.

## runAsNonRoot, runAsUser, and runAsGroup

### runAsNonRoot

`runAsNonRoot: true` instructs the container runtime to reject any container whose UID resolves to 0 (root) at startup. This is the single most impactful security context field.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
  namespace: production
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true    # Enforced at the pod level for all containers
        runAsUser: 1000       # Explicit UID
        runAsGroup: 1000      # Primary GID
```

If a container image is built with `USER root` in the Dockerfile and no `runAsUser` override is provided, the runtime will reject the pod at startup with an error such as:

```
Error: container has runAsNonRoot and image will run as root
```

This makes `runAsNonRoot: true` a useful enforcement gate even for images you do not control — it fails fast at pod creation rather than silently running as root.

### Choosing UIDs and GIDs

For custom-built application images, define a non-root user in the Dockerfile:

```dockerfile
# Dockerfile
FROM gcr.io/distroless/base-debian12

# Create a non-root user and group
# Note: distroless images handle this differently — use the built-in nonroot user
USER nonroot:nonroot

COPY --chown=nonroot:nonroot ./bin/app /app

EXPOSE 8080
ENTRYPOINT ["/app"]
```

For general-purpose base images:

```dockerfile
FROM ubuntu:24.04

RUN groupadd -g 10001 appgroup && \
    useradd -u 10001 -g appgroup -s /sbin/nologin -M appuser

COPY --chown=appuser:appgroup ./bin/app /app

USER 10001:10001
ENTRYPOINT ["/app"]
```

### Container-Level Override

When a pod contains containers with different security requirements, override at the container level:

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
  containers:
    - name: app
      # Inherits pod-level: runs as UID 1000
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true

    - name: metrics-exporter
      # Needs a different UID for its own process
      securityContext:
        runAsUser: 2000
        runAsGroup: 2000
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
```

## fsGroup and Volume Ownership

`fsGroup` controls the supplemental group ownership applied to mounted volumes. When a pod has `fsGroup: 3000`, Kubernetes chowns all files in mounted volumes to that GID and sets the setgid bit on new files. This allows containers running as different UIDs to all read and write shared volume data via the common group.

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 3000   # Shared GID for volume access
```

### fsGroupChangePolicy

On large volumes, chowning all files at mount time causes unacceptably long pod startup times. `fsGroupChangePolicy` controls this behavior:

- `Always` (default): Recursively chown on every mount
- `OnRootMismatch`: Only chown if the root directory ownership does not match `fsGroup`

```yaml
spec:
  securityContext:
    fsGroup: 3000
    fsGroupChangePolicy: "OnRootMismatch"  # Dramatically faster for pre-owned volumes
```

`OnRootMismatch` is the correct setting for production workloads with large data volumes. The trade-off is that files created outside the pod (e.g., by backup tools) may retain incorrect ownership and must be manually chowned.

### supplementalGroups

`supplementalGroups` adds additional GIDs to the container's process without affecting volume ownership. Use this to grant access to groups defined in the container image's `/etc/group`:

```yaml
spec:
  securityContext:
    runAsUser: 1000
    fsGroup: 3000
    supplementalGroups: [4000, 5000]  # Extra group memberships
```

## Linux Capabilities

Linux capabilities partition root privileges into distinct units that can be individually granted or revoked. The default capability set for Docker/containerd containers includes over a dozen capabilities that most applications do not need.

### The Principle: Drop ALL, Add Specific

The correct hardening approach is to drop all capabilities and then add back only those specifically required by the application:

```yaml
spec:
  containers:
    - name: app
      securityContext:
        capabilities:
          drop:
            - ALL        # Drop every capability
          add:
            - NET_BIND_SERVICE  # Add only what is needed (e.g., bind to port <1024)
```

### Capability Reference

| Capability | Purpose | Common Use Case |
|---|---|---|
| `NET_BIND_SERVICE` | Bind to ports below 1024 | HTTP/HTTPS servers, DNS |
| `NET_ADMIN` | Network administration | CNI plugins, network tools |
| `SYS_PTRACE` | Process tracing | Debuggers, profilers, APM agents |
| `SYS_TIME` | Set system clock | NTP daemons, time sync tools |
| `CHOWN` | Change file ownership | Setup containers that chown files |
| `DAC_OVERRIDE` | Bypass file permissions | Legacy applications requiring DAC override |
| `FOWNER` | Operations requiring file owner check bypass | Package managers |
| `SETUID`, `SETGID` | Change process UID/GID | Programs that drop privileges |
| `KILL` | Send signals to arbitrary processes | Process managers |
| `NET_RAW` | Raw network sockets | Ping, network diagnostic tools |

### Most Applications Need Zero Capabilities

A well-written application container running on ports above 1024 as a non-root user requires no capabilities. The following security context is appropriate for the vast majority of production microservices:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```

### Service Mesh Sidecar Interaction

Istio and similar service mesh implementations inject sidecar containers that traditionally require `NET_ADMIN` and `NET_RAW` capabilities to manipulate iptables for traffic interception. Modern service meshes address this through:

1. **CNI plugin mode**: Traffic redirection is performed by the CNI plugin at pod network setup time, before any container starts. Sidecars require no special capabilities. This is the recommended mode for hardened environments.

2. **Privileged init containers**: An `initContainer` with `NET_ADMIN`/`NET_RAW` configures iptables and then exits. The main sidecar container runs without special capabilities. The init container runs briefly and does not persist, reducing the attack surface.

```yaml
# Istio sidecar injection with CNI (no special capabilities needed)
annotations:
  sidecar.istio.io/interceptionMode: REDIRECT
  ambient.istio.io/redirection: enabled  # Ambient mode - no sidecar at all

# Or disable iptables redirect entirely for specific pods
annotations:
  traffic.sidecar.istio.io/excludeInboundPorts: "9090"
  traffic.sidecar.istio.io/excludeOutboundIPRanges: "10.0.0.0/8"
```

## allowPrivilegeEscalation

`allowPrivilegeEscalation: false` prevents any process inside the container from gaining more privileges than its parent process. Technically, this sets the `no_new_privs` bit on the process, which prevents `setuid` and `setgid` binaries from acquiring elevated privileges, and prevents ptrace-based privilege escalation.

This field should always be `false` unless the application explicitly requires privilege escalation (e.g., sudo wrappers or setuid binaries — both of which indicate architectural problems).

```yaml
securityContext:
  allowPrivilegeEscalation: false  # Always set this explicitly
```

Note: `allowPrivilegeEscalation` defaults to `true` when a container runs as root or has `CAP_SYS_ADMIN`. Setting it explicitly to `false` overrides these defaults.

## readOnlyRootFilesystem

`readOnlyRootFilesystem: true` mounts the container's root filesystem as read-only. This is a defense-in-depth measure that:

- Prevents attackers from writing tools or scripts to the container filesystem after gaining code execution
- Prevents accidental or intentional modification of application binaries at runtime
- Forces explicit declaration of which paths require write access via `emptyDir` or volume mounts

```yaml
spec:
  containers:
    - name: app
      securityContext:
        readOnlyRootFilesystem: true
      volumeMounts:
        # Application needs to write logs
        - name: log-volume
          mountPath: /var/log/app
        # Application needs a writable temp directory
        - name: tmp-volume
          mountPath: /tmp
        # Application needs a writable cache
        - name: cache-volume
          mountPath: /var/cache/app
  volumes:
    - name: log-volume
      emptyDir: {}
    - name: tmp-volume
      emptyDir:
        medium: Memory  # Use tmpfs for /tmp — faster and not tracked by disk pressure
        sizeLimit: 256Mi
    - name: cache-volume
      emptyDir:
        sizeLimit: 1Gi
```

### Working Around readOnlyRootFilesystem

Many applications write to locations that are part of the default image filesystem. Common required paths:

| Application | Required Writable Paths |
|---|---|
| Java applications | `/tmp` (JVM), `/proc` (read-only access is fine) |
| Nginx | `/var/cache/nginx`, `/var/run`, `/tmp` |
| Node.js | `/tmp` |
| Python/pip | `/tmp`, `~/.cache` |
| Go apps | Usually none if compiled statically |

When enabling `readOnlyRootFilesystem` for an existing application, run the container locally with `--read-only` and observe which paths fail with permission errors, then mount `emptyDir` volumes for those specific paths.

## privileged Containers

A `privileged: true` container has nearly all capabilities and bypasses most security mechanisms. It is equivalent to running a root process on the host with full access to host devices and namespaces.

Legitimate use cases are extremely narrow:

- Node-level components (CNI plugins, CSI drivers) that must configure the host network or block devices
- Hardware-level monitoring agents that must access host devices directly
- Legacy migration scenarios where containerization is being introduced incrementally

**Production rule**: If a workload requires `privileged: true`, it should run in its own dedicated namespace with strict access controls, be subject to additional security review, and be treated as a high-value attack target.

```yaml
# Example: CSI driver node plugin that legitimately needs privileged access
spec:
  containers:
    - name: csi-driver-node
      securityContext:
        privileged: true        # Required for mount namespace access
      volumeMounts:
        - name: dev-dir
          mountPath: /dev
        - name: kubelet-dir
          mountPath: /var/lib/kubelet
          mountPropagation: Bidirectional
```

For application workloads, `privileged: true` is never appropriate. Audit the cluster for privileged application containers:

```bash
# Find all privileged pods in the cluster
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.containers[].securityContext.privileged == true) |
  "\(.metadata.namespace)/\(.metadata.name)"
'

# Also check initContainers
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.initContainers[]?.securityContext.privileged == true) |
  "\(.metadata.namespace)/\(.metadata.name) (initContainer)"
'
```

## seccompProfile

Seccomp (secure computing mode) filters the system calls a container can make. The `RuntimeDefault` profile blocks the most dangerous syscalls (e.g., `ptrace`, `reboot`, `kexec_load`) while allowing everything needed for normal container operation.

```yaml
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault  # Strongly recommended for all production pods
```

Available profile types:

- `RuntimeDefault`: Uses the container runtime's default seccomp profile. Safe and covers the vast majority of workloads.
- `Localhost`: Loads a custom profile from the node filesystem at a specified path. Required for workloads with unusual syscall requirements.
- `Unconfined`: No seccomp filtering. This is the default if not specified — a significant security gap.

### Custom Seccomp Profiles

For workloads that need a custom profile (e.g., a Java JVM that requires additional syscalls not in RuntimeDefault), create a profile on the node at `/var/lib/kubelet/seccomp/profiles/`:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": [
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32"
  ],
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "access", "arch_prctl",
        "bind", "brk", "clone", "close", "connect",
        "dup", "dup2", "epoll_create", "epoll_create1",
        "epoll_ctl", "epoll_pwait", "epoll_wait",
        "execve", "exit", "exit_group",
        "fcntl", "fstat", "futex", "getcwd", "getdents64",
        "getpid", "getppid", "getuid", "getgid",
        "getsockname", "getsockopt", "gettid", "gettimeofday",
        "ioctl", "kill", "lseek", "madvise", "mmap",
        "mprotect", "munmap", "nanosleep", "newfstatat",
        "open", "openat", "pipe", "pipe2", "poll", "ppoll",
        "prctl", "pread64", "prlimit64", "pwrite64",
        "read", "readlink", "recvfrom", "recvmsg",
        "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "select", "sendmsg", "sendto", "set_robust_list",
        "set_tid_address", "setsockopt", "shutdown",
        "sigaltstack", "socket", "stat", "statfs", "tgkill",
        "umask", "uname", "wait4", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```yaml
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: "profiles/my-app-profile.json"
```

## Pod Security Standards

Kubernetes Pod Security Standards (PSS) replaced PodSecurityPolicy (deprecated in 1.21, removed in 1.25) as the built-in pod security enforcement mechanism. PSS defines three policy levels enforced via the `PodSecurity` admission controller:

| Level | Description | Suitable For |
|---|---|---|
| `privileged` | No restrictions | System-level infrastructure namespaces |
| `baseline` | Prevents known privilege escalations | General-purpose application namespaces |
| `restricted` | Hardened best practices | High-security application namespaces |

### Enabling PSS Enforcement

```bash
# Apply the restricted policy to an application namespace
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=latest \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=latest
```

The `warn` label generates admission warnings without blocking pods — useful for evaluating compliance before switching to `enforce`. The `audit` label records violations in the audit log without blocking.

### Restricted Profile Requirements

The `restricted` PSS level requires all of the following:

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault  # or Localhost
  containers:
    - securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true  # Not required by restricted, but best practice
        runAsNonRoot: true
        capabilities:
          drop:
            - ALL
        seccompProfile:
          type: RuntimeDefault
```

### Testing PSS Compliance

```bash
# Dry-run a pod manifest against the restricted policy
kubectl apply --dry-run=server -f my-pod.yaml -n production

# Check what would fail in an existing namespace
kubectl label namespace staging \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=latest

# Deploy a test workload and observe warnings
kubectl apply -f test-deployment.yaml -n staging
# Warning: would violate PodSecurity "restricted:latest": ...

# Audit existing pods in a namespace
kubectl get pods -n production -o json | \
  kubectl-convert -f - --local -o json | \
  jq -r '.items[] | select(.metadata != null) | .metadata.name' | \
  xargs -I {} kubectl get pod {} -n production \
    -o jsonpath='{.metadata.name}{"\n"}'
```

## Complete Hardened Deployment Example

The following manifest demonstrates a fully hardened deployment satisfying the restricted PSS profile, suitable for a typical stateless web service:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hardened-api
  namespace: production
  labels:
    app: hardened-api
    app.kubernetes.io/version: "1.5.0"
spec:
  replicas: 3
  selector:
    matchLabels:
      app: hardened-api
  template:
    metadata:
      labels:
        app: hardened-api
        app.kubernetes.io/version: "1.5.0"
    spec:
      # Pod-level security context
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001
        fsGroupChangePolicy: "OnRootMismatch"
        seccompProfile:
          type: RuntimeDefault
        # Prevent privilege escalation via setuid/setgid
        sysctls: []

      # Do not mount service account token unless required
      automountServiceAccountToken: false

      # Dedicated service account with minimal RBAC
      serviceAccountName: hardened-api

      containers:
        - name: api
          image: registry.example.com/hardened-api:1.5.0
          imagePullPolicy: Always

          # Container-level security context (most restrictive)
          securityContext:
            runAsNonRoot: true
            runAsUser: 10001
            runAsGroup: 10001
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
              # Uncomment only if application binds to port < 1024
              # add:
              #   - NET_BIND_SERVICE
            seccompProfile:
              type: RuntimeDefault

          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
            - name: metrics
              containerPort: 9090
              protocol: TCP

          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi

          volumeMounts:
            # Application needs writable /tmp
            - name: tmp
              mountPath: /tmp
            # Application writes logs here
            - name: logs
              mountPath: /var/log/app
            # Application config (read-only)
            - name: config
              mountPath: /etc/app
              readOnly: true

          env:
            - name: LOG_LEVEL
              value: "info"
            - name: PORT
              value: "8080"

          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3

          livenessProbe:
            httpGet:
              path: /healthz/live
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 30
            failureThreshold: 3

      volumes:
        - name: tmp
          emptyDir:
            medium: Memory
            sizeLimit: 256Mi
        - name: logs
          emptyDir:
            sizeLimit: 512Mi
        - name: config
          configMap:
            name: hardened-api-config
            defaultMode: 0444  # Read-only for all users

      # Spread across nodes for resilience
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: hardened-api
```

## Admission Webhook for Security Context Enforcement

For teams transitioning to hardened security contexts, an OPA Gatekeeper policy provides enforcement without requiring manual review of every pull request:

```yaml
# gatekeeper-constraint-template.yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8spodmustrunasnonroot
spec:
  crd:
    spec:
      names:
        kind: K8sPodMustRunAsNonRoot
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8spodmustrunasnonroot

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.securityContext.runAsNonRoot
          not input.review.object.spec.securityContext.runAsNonRoot
          msg := sprintf("Container '%v' must set securityContext.runAsNonRoot=true", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          container.securityContext.allowPrivilegeEscalation == true
          msg := sprintf("Container '%v' must not set allowPrivilegeEscalation=true", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not container.securityContext.capabilities.drop
          msg := sprintf("Container '%v' must drop all capabilities", [container.name])
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          cap_drop := container.securityContext.capabilities.drop
          not contains(cap_drop, "ALL")
          msg := sprintf("Container '%v' must drop ALL capabilities", [container.name])
        }
---
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sPodMustRunAsNonRoot
metadata:
  name: pod-must-run-as-non-root
spec:
  enforcementAction: deny
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
```

## Auditing Security Context Configuration

Regular auditing identifies security context gaps before they become incidents:

```bash
#!/bin/bash
# audit-security-contexts.sh
# Produces a report of security context compliance across all namespaces

echo "=== Security Context Audit ==="
echo "Date: $(date)"
echo ""

echo "--- Pods running as root (runAsUser=0 or no runAsNonRoot) ---"
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(
    (.spec.securityContext.runAsNonRoot != true) and
    (.spec.securityContext.runAsUser == null or .spec.securityContext.runAsUser == 0)
  ) |
  "\(.metadata.namespace)/\(.metadata.name)"
' | sort

echo ""
echo "--- Pods with privileged containers ---"
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(.spec.containers[].securityContext.privileged == true) |
  "\(.metadata.namespace)/\(.metadata.name)"
' | sort

echo ""
echo "--- Pods without seccompProfile ---"
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(
    (.spec.securityContext.seccompProfile == null) and
    (.spec.containers[].securityContext.seccompProfile == null)
  ) |
  "\(.metadata.namespace)/\(.metadata.name)"
' | sort | head -20

echo ""
echo "--- Pods with allowPrivilegeEscalation not explicitly false ---"
kubectl get pods -A -o json | jq -r '
  .items[] |
  select(
    .spec.containers[] |
    .securityContext.allowPrivilegeEscalation != false
  ) |
  "\(.metadata.namespace)/\(.metadata.name)"
' | sort | head -20

echo ""
echo "--- Namespaces without PSS enforcement ---"
kubectl get namespaces -o json | jq -r '
  .items[] |
  select(
    .metadata.labels["pod-security.kubernetes.io/enforce"] == null
  ) |
  .metadata.name
' | grep -v "kube-" | sort
```

## Security Context and PodDisruptionBudget Interaction

Hardened containers that do not mount writable persistent volumes are generally more tolerant of eviction and restart, which makes PDB configuration straightforward. However, `fsGroup` chown operations on large volumes can cause extended startup times that affect readiness probe thresholds:

```yaml
# For pods with large volumes and fsGroup, increase readiness probe tolerances
readinessProbe:
  httpGet:
    path: /healthz/ready
    port: 8080
  initialDelaySeconds: 60  # Increased to allow fsGroup chown to complete
  periodSeconds: 10
  failureThreshold: 6

# Use fsGroupChangePolicy: OnRootMismatch to minimize startup delay
spec:
  securityContext:
    fsGroup: 3000
    fsGroupChangePolicy: "OnRootMismatch"
```

Security contexts are a layered defense — no single field provides complete protection, but a pod configured with `runAsNonRoot`, `allowPrivilegeEscalation: false`, `capabilities.drop: ALL`, `readOnlyRootFilesystem`, and a `RuntimeDefault` seccomp profile is substantially more resilient to container escape attempts than the default configuration. Combined with PSS enforcement at the namespace level and admission webhooks for policy-as-code, security contexts form the foundation of a zero-trust workload security posture.
