---
title: "Kubernetes Pod Security Contexts: Complete Reference for Hardened Workloads"
date: 2028-03-11T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Security", "Pod Security", "seccomp", "AppArmor", "PSS", "Containers"]
categories: ["Kubernetes", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A complete reference for Kubernetes pod and container security contexts, covering runAsNonRoot, capability management, seccompProfile, AppArmor, readOnlyRootFilesystem, and PSS restricted profile compliance for hardened enterprise workloads."
more_link: "yes"
url: "/kubernetes-pod-security-context-guide-advanced/"
---

Pod security contexts are the primary mechanism for hardening container workloads in Kubernetes without requiring kernel-level configuration on each node. Correctly configured security contexts eliminate entire categories of container escape vulnerabilities: preventing privilege escalation, dropping unnecessary Linux capabilities, enforcing read-only filesystems, and restricting syscall surfaces through seccomp profiles. This guide provides a complete reference for every security context field along with practical patterns for achieving Pod Security Standards (PSS) restricted compliance.

<!--more-->

## Security Context Scope: Pod vs Container Level

Security context fields exist at two levels in the Pod spec:

- **`spec.securityContext`** (pod-level): Applies to all containers unless overridden. Governs: `runAsUser`, `runAsGroup`, `runAsNonRoot`, `fsGroup`, `fsGroupChangePolicy`, `supplementalGroups`, `sysctls`, `seccompProfile`, `seLinuxOptions`, `windowsOptions`.

- **`spec.containers[*].securityContext`** (container-level): Overrides pod-level for that container. Adds: `allowPrivilegeEscalation`, `capabilities`, `privileged`, `readOnlyRootFilesystem`, `procMount`, `seccompProfile` (can override pod-level).

```yaml
apiVersion: v1
kind: Pod
spec:
  securityContext:          # Pod-level — applies to all containers
    runAsNonRoot: true
    runAsUser: 10000
    runAsGroup: 10000
    fsGroup: 10000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      securityContext:      # Container-level — specific to this container
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
```

## runAsNonRoot and User/Group Configuration

### runAsNonRoot

```yaml
securityContext:
  runAsNonRoot: true
```

When `runAsNonRoot: true`, the container runtime refuses to start the container if the effective UID is 0 (root). This check happens after the image `USER` directive and any `runAsUser` override. If the image has no `USER` directive and no `runAsUser` is set, the pod will fail with:

```
Error: container has runAsNonRoot and image will run as root
```

Fix by setting an explicit non-root user:

```dockerfile
# Dockerfile
FROM gcr.io/distroless/static-debian12:nonroot
# Or explicitly
RUN addgroup --system --gid 10001 appgroup && \
    adduser --system --uid 10001 --ingroup appgroup --no-create-home appuser
USER 10001:10001
```

### runAsUser and runAsGroup

```yaml
spec:
  securityContext:
    runAsUser: 10001   # UID for all containers
    runAsGroup: 10001  # Primary GID for all containers
  containers:
    - name: sidecar
      securityContext:
        runAsUser: 20001  # Override for this container only
```

UIDs below 1000 are typically reserved for system accounts in Linux distributions. Use UIDs in the range 10000–65535 for application containers to avoid conflicts.

### fsGroup and Volume Ownership

`fsGroup` sets the supplemental group for volumes mounted into the pod. The kubelet will `chown` volume contents to this GID on mount:

```yaml
spec:
  securityContext:
    fsGroup: 10001
    fsGroupChangePolicy: "OnRootMismatch"  # Only chown if root ownership differs
```

`fsGroupChangePolicy: OnRootMismatch` significantly reduces startup time for large volumes by skipping the recursive chown when the volume root directory already has the correct ownership.

## allowPrivilegeEscalation: false

This is the single most impactful security context field. When set to `false`, it sets the `no_new_privs` bit on the container process, preventing:

- `setuid` / `setgid` binaries from gaining elevated privileges
- `execve()` calls from inheriting capabilities not in the ambient set
- sudo, su, and other privilege escalation tools from working

```yaml
containers:
  - name: app
    securityContext:
      allowPrivilegeEscalation: false
```

**When `privileged: true` is set, `allowPrivilegeEscalation` is implicitly true and cannot be overridden.** Never use `privileged: true` except for DaemonSets that genuinely need node-level access (CNI plugins, node monitoring agents).

## Linux Capabilities Management

### Drop ALL, Add Specific

The secure baseline is to drop all capabilities and add only what is explicitly needed:

```yaml
securityContext:
  capabilities:
    drop:
      - ALL
    add:
      - NET_BIND_SERVICE  # Only if the container binds to port < 1024
```

Common capability requirements and their implications:

| Capability | Required For | Risk Level |
|---|---|---|
| `NET_BIND_SERVICE` | Binding to ports < 1024 | Low — avoid by using port > 1024 |
| `NET_ADMIN` | Network interface config, iptables | High — grants broad network control |
| `SYS_PTRACE` | Debugging, profiling (strace, gdb) | High — enables process injection |
| `SYS_ADMIN` | Mount operations, cgroups, many syscalls | Critical — near-root equivalent |
| `CHOWN` | Changing file ownership | Medium |
| `SETUID` / `SETGID` | Changing process UID/GID | High |
| `AUDIT_WRITE` | Writing kernel audit log | Low |
| `KILL` | Sending signals to arbitrary processes | Medium |

Identify capability requirements before dropping:

```bash
# Check what capabilities a container actually uses
# Run with all caps enabled first, then inspect
docker run --cap-add=ALL \
  --security-opt=apparmor=unconfined \
  -v /var/log:/var/log/container \
  your-image:tag /entrypoint.sh &

# In another terminal, use pscap or getpcaps
pscap -a  # From libcap-ng-utils

# Or use inspektor gadget to trace capability checks
kubectl gadget trace capabilities \
  --namespace production \
  --podname app-xxx \
  --timeout 60s
```

### Capability Inheritance and Ambient Sets

For setuid-free capability inheritance in user namespaces (uncommon but valid for some init systems):

```yaml
securityContext:
  capabilities:
    drop:
      - ALL
    add:
      - NET_BIND_SERVICE
  # Note: ambient capabilities require securityContext.capabilities.add
  # and cannot be configured directly in Kubernetes — they're set by the runtime
```

## readOnlyRootFilesystem

```yaml
containers:
  - name: app
    securityContext:
      readOnlyRootFilesystem: true
    volumeMounts:
      - name: tmp
        mountPath: /tmp
      - name: cache
        mountPath: /var/cache/app
  volumes:
    - name: tmp
      emptyDir: {}
    - name: cache
      emptyDir:
        sizeLimit: 500Mi
```

A read-only root filesystem prevents attackers from writing malicious binaries or modifying configuration after initial compromise. Common failure modes when enabling this setting:

1. **Application writes to `/tmp`**: Add an `emptyDir` volume mounted at `/tmp`
2. **Application writes log files to the image**: Configure logging to stdout/stderr or mount a volume
3. **PID files in `/var/run`**: Mount `emptyDir` at `/var/run`
4. **Package manager cache**: Remove during build; add `emptyDir` for runtime package operations only if unavoidable

Diagnosing failures:

```bash
# Find write attempts from a running container
kubectl exec -n production app-xxx -- \
  strace -e trace=open,openat,write -f \
  your-command 2>&1 | grep -E "O_WRONLY|O_RDWR" | grep -v ENOENT
```

## seccompProfile

Seccomp (Secure Computing Mode) restricts the system calls a container can make to the kernel.

### RuntimeDefault Profile

```yaml
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault
```

`RuntimeDefault` uses the container runtime's default seccomp profile (Docker's default profile blocks ~44 syscalls including `ptrace`, `kexec_load`, `mount`, and others). This is the recommended minimum for all production workloads.

### Localhost Profile

```yaml
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/fine-grained-app.json
```

Localhost profiles are stored on each node at the kubelet's `--seccomp-profile-root` path (default: `/var/lib/kubelet/seccomp/`). Deploy profiles via DaemonSet or node bootstrapping:

```bash
# Copy profile to all nodes via DaemonSet
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: seccomp-profiles
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: seccomp-profiles
  template:
    metadata:
      labels:
        app: seccomp-profiles
    spec:
      initContainers:
        - name: copy-profiles
          image: alpine:3.19
          command:
            - sh
            - -c
            - cp /profiles/* /host/seccomp/profiles/
          volumeMounts:
            - name: profiles
              mountPath: /profiles
            - name: seccomp
              mountPath: /host/seccomp
      containers:
        - name: pause
          image: gcr.io/google_containers/pause:3.1
      volumes:
        - name: profiles
          configMap:
            name: seccomp-profiles
        - name: seccomp
          hostPath:
            path: /var/lib/kubelet/seccomp
            type: DirectoryOrCreate
EOF
```

### Generating a Fine-Grained Profile

```bash
# Run the application with audit mode to record all syscalls used
# then generate a restrictive profile

# Step 1: Run with logging profile
docker run \
  --security-opt seccomp=unconfined \
  --cap-add=SYS_PTRACE \
  your-image:tag

# Step 2: Extract syscalls using strace
strace -c -f your-application 2>&1 | tail -30

# Step 3: Use oci-seccomp-bpf-hook to auto-generate a profile
# https://github.com/containers/oci-seccomp-bpf-hook
```

A minimal custom seccomp profile:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
  "syscalls": [
    {
      "names": [
        "accept4", "access", "arch_prctl", "bind", "brk",
        "close", "connect", "epoll_create1", "epoll_ctl",
        "epoll_pwait", "execve", "exit_group", "fstat",
        "futex", "getdents64", "getpid", "getrandom",
        "getsockname", "getsockopt", "gettid", "listen",
        "mmap", "mprotect", "munmap", "nanosleep",
        "openat", "poll", "read", "recvfrom", "recvmsg",
        "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "sendmsg", "sendto", "setsockopt", "sigaltstack",
        "socket", "stat", "uname", "write"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

## AppArmor Annotations

AppArmor profiles provide MAC (mandatory access control) at the file system and network level, complementing seccomp's syscall restrictions.

```yaml
# Pre-Kubernetes 1.30 annotation syntax
metadata:
  annotations:
    container.apparmor.security.beta.kubernetes.io/app: runtime/default
    # Or for a custom profile:
    container.apparmor.security.beta.kubernetes.io/app: localhost/custom-profile
```

From Kubernetes 1.30, AppArmor is configured in the security context:

```yaml
containers:
  - name: app
    securityContext:
      appArmorProfile:
        type: RuntimeDefault
        # Or for localhost:
        # type: Localhost
        # localhostProfile: custom-profile
```

Verify AppArmor is enforcing:

```bash
kubectl exec -n production app-xxx -- \
  cat /proc/1/attr/current
# Should show: k8s-apparmor-example-deny-write (enforce)
```

## Privileged Containers and Alternatives

`privileged: true` grants the container all Linux capabilities and disables seccomp and AppArmor. It is equivalent to running as root on the host with a reduced namespace boundary.

```yaml
# Never use this in production application containers
securityContext:
  privileged: true  # AVOID — grants near-host-root access
```

Alternatives by use case:

| Need | Alternative to privileged |
|---|---|
| Host network access | `hostNetwork: true` (still risky, but scoped) |
| Node monitoring (eBPF) | Specific capabilities: `SYS_BPF`, `PERFMON` |
| Volume mounting operations | CSI drivers running as privileged (isolated from app) |
| Container-in-container (Docker-in-Docker) | Kaniko, Buildah, or rootless Podman |
| iptables manipulation (CNI) | Run only in kube-system DaemonSets, not application pods |
| Kernel module loading | `SYS_MODULE` capability on a dedicated init container |

### Detecting Privileged Containers in a Cluster

```bash
# Find all privileged containers cluster-wide
kubectl get pods --all-namespaces -o json | \
  jq -r '
    .items[] |
    .metadata.namespace as $ns |
    .metadata.name as $pod |
    .spec.containers[] |
    select(.securityContext.privileged == true) |
    "\($ns)/\($pod): \(.name)"
  '

# Find containers with SYS_ADMIN capability
kubectl get pods --all-namespaces -o json | \
  jq -r '
    .items[] |
    .metadata.namespace as $ns |
    .metadata.name as $pod |
    .spec.containers[] |
    select(.securityContext.capabilities.add[]? == "SYS_ADMIN") |
    "\($ns)/\($pod): \(.name)"
  '
```

## PSS Restricted Profile Compliance

The Pod Security Standards (PSS) define three levels: Privileged, Baseline, and Restricted. The Restricted level is the hardest and most secure. Achieving compliance requires all of the following:

```yaml
# Full PSS Restricted compliant pod spec
apiVersion: v1
kind: Pod
metadata:
  name: restricted-pod
  namespace: production
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile:
      type: RuntimeDefault          # Required for Restricted
  volumes:
    - name: tmp
      emptyDir: {}
  containers:
    - name: app
      image: gcr.io/distroless/static-debian12:nonroot
      securityContext:
        allowPrivilegeEscalation: false   # Required for Restricted
        readOnlyRootFilesystem: true       # Required for Restricted
        runAsNonRoot: true                 # Required for Restricted (redundant with pod-level)
        capabilities:
          drop:
            - ALL                          # Required for Restricted
          # add: []                        # No capabilities added in Restricted
        seccompProfile:
          type: RuntimeDefault             # Can override at container level
      volumeMounts:
        - name: tmp
          mountPath: /tmp
```

### Enforcing PSS via Namespace Labels

```bash
# Enforce restricted PSS for a namespace
kubectl label namespace production \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.29 \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=v1.29 \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=v1.29

# Test a pod spec against PSS before applying
kubectl apply --dry-run=server -f pod.yaml -n production
```

### PSS Compliance Checker Script

```bash
#!/bin/bash
# check-pss-compliance.sh
# Reports pods failing PSS restricted profile in a namespace

NAMESPACE=${1:-production}

echo "PSS Restricted compliance check for namespace: ${NAMESPACE}"
echo "================================================================"

PODS=$(kubectl get pods -n "${NAMESPACE}" -o json)

echo "${PODS}" | jq -r '
  .items[] |
  . as $pod |
  .metadata.name as $name |
  .spec.securityContext as $podSC |
  .spec.containers[] as $container |
  [
    # Check 1: runAsNonRoot
    if ($podSC.runAsNonRoot != true and $container.securityContext.runAsNonRoot != true) then
      "\($name)/\($container.name): FAIL - runAsNonRoot not set"
    else empty end,

    # Check 2: allowPrivilegeEscalation
    if ($container.securityContext.allowPrivilegeEscalation != false) then
      "\($name)/\($container.name): FAIL - allowPrivilegeEscalation not false"
    else empty end,

    # Check 3: capabilities.drop ALL
    if (($container.securityContext.capabilities.drop // []) | contains(["ALL"]) | not) then
      "\($name)/\($container.name): FAIL - capabilities.drop does not include ALL"
    else empty end,

    # Check 4: seccompProfile
    if (($podSC.seccompProfile.type // "") != "RuntimeDefault" and
        ($podSC.seccompProfile.type // "") != "Localhost" and
        ($container.securityContext.seccompProfile.type // "") != "RuntimeDefault" and
        ($container.securityContext.seccompProfile.type // "") != "Localhost") then
      "\($name)/\($container.name): FAIL - seccompProfile not set to RuntimeDefault or Localhost"
    else empty end,

    # Check 5: privileged
    if ($container.securityContext.privileged == true) then
      "\($name)/\($container.name): FAIL - container is privileged"
    else empty end
  ] | .[]
'

echo ""
echo "Scan complete."
```

## Security Context Admission with OPA Gatekeeper

### Constraint Template: Require Drop ALL Capabilities

```yaml
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequirecapabilitiesdropall
spec:
  crd:
    spec:
      names:
        kind: K8sRequireCapabilitiesDropAll
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequirecapabilitiesdropall

        import future.keywords

        violation[{"msg": msg}] {
          container := input.review.object.spec.containers[_]
          not drops_all(container.securityContext.capabilities.drop)
          msg := sprintf(
            "Container %v must drop ALL capabilities",
            [container.name]
          )
        }

        violation[{"msg": msg}] {
          container := input.review.object.spec.initContainers[_]
          not drops_all(container.securityContext.capabilities.drop)
          msg := sprintf(
            "InitContainer %v must drop ALL capabilities",
            [container.name]
          )
        }

        drops_all(drops) {
          drops[_] == "ALL"
        }
```

```yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireCapabilitiesDropAll
metadata:
  name: require-drop-all-capabilities
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    excludedNamespaces:
      - kube-system
      - monitoring
```

## Handling Init Containers

Init containers require the same security context treatment as regular containers:

```yaml
spec:
  initContainers:
    - name: migrate
      image: flyway/flyway:9-alpine
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        runAsUser: 10001
        capabilities:
          drop:
            - ALL
      volumeMounts:
        - name: flyway-tmp
          mountPath: /flyway/tmp
  volumes:
    - name: flyway-tmp
      emptyDir: {}
```

## Ephemeral Containers and Security

Ephemeral containers (for debugging) inherit pod-level security context but can specify their own container-level context. Note that ephemeral containers cannot add capabilities not present in the pod's security context:

```bash
# Attach a debug container (inherits pod security context)
kubectl debug -it app-pod-xxx \
  --image=gcr.io/distroless/base-debian12:debug \
  --target=app \
  -n production

# The ephemeral container cannot escape the pod's seccomp or AppArmor profile
```

## securityContext for Windows Containers

Windows containers on Kubernetes use a separate `windowsOptions` field:

```yaml
spec:
  securityContext:
    windowsOptions:
      runAsUserName: "ContainerUser"  # or "ContainerAdministrator"
      gmsaCredentialSpecName: webapp-gmsa  # Group Managed Service Account
```

Windows containers do not support Linux capabilities, seccomp, or AppArmor. The PSS Restricted profile explicitly excludes Windows containers from the `runAsNonRoot` requirement when `windowsOptions.runAsUserName` is specified.

## Distroless Images and Security Contexts

Distroless images (Google's `gcr.io/distroless/*`) contain only the application and its runtime dependencies — no shell, no package manager, no `su` binary. Combined with security contexts, they provide defense-in-depth:

```yaml
# Distroless + full security context hardening
apiVersion: v1
kind: Pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532    # distroless nonroot UID
    runAsGroup: 65532
    fsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      image: gcr.io/distroless/static-debian12:nonroot@sha256:<DIGEST>
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
```

Pin distroless images by digest rather than tag to prevent tag mutation attacks:

```bash
# Get the digest for the nonroot tag
crane digest gcr.io/distroless/static-debian12:nonroot
# sha256:abc123...

# Use in deployment
image: gcr.io/distroless/static-debian12:nonroot@sha256:abc123...
```

## Auditing Security Contexts with kube-score

kube-score evaluates manifests against security best practices:

```bash
# Install kube-score
brew install kube-score  # macOS
# or: go install github.com/zegl/kube-score/cmd/kube-score@latest

# Audit a manifest
kube-score score deployment.yaml

# Audit all manifests in a directory
kube-score score k8s/namespaces/production/*.yaml

# Audit live cluster resources
kubectl get deployments --all-namespaces -o yaml | kube-score score -
```

Sample output:

```
apps/v1/Deployment checkout-service                          💥 CRITICAL
    [CRITICAL] Container Security Context
        · checkout-service -> Container has no configured security context
    [CRITICAL] Container Resources
        · checkout-service -> CPU limit is not set

apps/v1/Deployment payment-service                          ✅ OK
```

## Security Context Exceptions and Override Strategy

When a workload legitimately requires elevated privileges (e.g., a log shipper DaemonSet that needs `hostPath` access), document the exception explicitly and scope it as narrowly as possible:

```yaml
# exceptions/log-shipper-exception.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequireCapabilitiesDropAll
metadata:
  name: require-drop-all-capabilities
spec:
  match:
    kinds:
      - apiGroups: ["apps"]
        kinds: ["DaemonSet"]
    excludedNamespaces:
      - kube-system    # Log shippers typically run here
      - monitoring
  enforcementAction: deny
```

```yaml
# Annotation on the exception workload for audit trail
metadata:
  annotations:
    security.example.com/exception-reason: "Node log collection requires hostPath access"
    security.example.com/exception-approved-by: "security-team"
    security.example.com/exception-approved-date: "2026-03-01"
    security.example.com/exception-review-date: "2027-03-01"
    security.example.com/jira-ticket: "SEC-4521"
```

## Seccomp Audit Mode for Profile Development

Before enforcing a custom seccomp profile, run in `SCMP_ACT_LOG` mode to capture all syscalls without blocking them:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": []
}
```

Collect the logged syscalls from the kernel audit log:

```bash
# On the node where the container runs
grep "type=SECCOMP" /var/log/audit/audit.log | \
  grep "comm=\"your-app\"" | \
  awk -F'syscall=' '{print $2}' | \
  awk '{print $1}' | sort -u | \
  while read syscall_num; do
    # Map syscall number to name
    ausyscall "${syscall_num}" 2>/dev/null || echo "${syscall_num}"
  done | sort -u
```

Convert the collected syscalls into an `SCMP_ACT_ERRNO` profile that allows only those specific calls, then test it in a staging environment before production enforcement.

## Summary

A production-hardened container security context applies multiple complementary controls: `allowPrivilegeEscalation: false` prevents the most common privilege escalation vectors, `capabilities: drop ALL` removes the attack surface from unnecessary Linux kernel operations, `readOnlyRootFilesystem: true` prevents post-compromise binary planting, and `seccompProfile: RuntimeDefault` restricts the syscall interface to a safe baseline. PSS Restricted enforcement via namespace labels provides cluster-wide admission control that prevents insecure workloads from being scheduled at all. Distroless base images, digest-pinned image references, and documented security context exceptions complete the defense-in-depth posture. The OPA Gatekeeper constraint templates extend this to custom organizational policies that the PSS framework does not cover, and tools like kube-score and Pluto provide continuous validation that the hardening baseline holds as workloads evolve.
