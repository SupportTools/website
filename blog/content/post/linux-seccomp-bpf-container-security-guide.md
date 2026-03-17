---
title: "Linux Seccomp-BPF: Syscall Filtering for Container Security"
date: 2028-11-19T00:00:00-05:00
draft: false
tags: ["Linux", "Seccomp", "Security", "Containers", "Kubernetes"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux seccomp-BPF for container security covering BPF filter mechanics, profile generation with strace and seccomp-tools, Docker default profile analysis, Kubernetes seccomp profiles, OCI distribution, audit mode for profile development, and defense-in-depth with AppArmor."
more_link: "yes"
url: "/linux-seccomp-bpf-container-security-guide/"
---

Seccomp-BPF is one of the most powerful and underutilized container security mechanisms. By restricting which system calls a container can make, you dramatically reduce the attack surface available to any exploit running inside the container. A container with a well-crafted seccomp profile cannot call `ptrace`, `mount`, `kexec_load`, or dozens of other syscalls that attackers rely on for privilege escalation, even if they achieve code execution. This guide covers the mechanics, tooling, and production deployment of seccomp profiles.

<!--more-->

# Linux Seccomp-BPF: Syscall Filtering for Container Security

## Seccomp-BPF Filter Mechanics

Seccomp (Secure Computing Mode) was originally limited to allowing only 4 syscalls. Seccomp-BPF extends this by allowing arbitrary BPF (Berkeley Packet Filter) programs to evaluate each syscall and decide the action.

The BPF program receives a `seccomp_data` structure:

```c
struct seccomp_data {
    int   nr;                   /* system call number */
    __u32 arch;                 /* AUDIT_ARCH_* value */
    __u64 instruction_pointer;  /* CPU instruction pointer */
    __u64 args[6];              /* Up to 6 system call arguments */
};
```

### Actions (Most Restrictive to Least)

| Action | Effect |
|---|---|
| `SCMP_ACT_KILL_PROCESS` | Immediately kill the entire process |
| `SCMP_ACT_KILL` | Kill only the offending thread |
| `SCMP_ACT_TRAP` | Send SIGSYS to the process (catchable) |
| `SCMP_ACT_ERRNO(n)` | Return errno n (e.g., EPERM) — syscall fails, process continues |
| `SCMP_ACT_TRACE` | Notify ptrace tracer (for debugging) |
| `SCMP_ACT_LOG` | Log to audit subsystem and allow |
| `SCMP_ACT_ALLOW` | Allow the syscall |

In practice, production profiles use `SCMP_ACT_ERRNO(EPERM)` as the default action (deny returns an error) rather than `SCMP_ACT_KILL` to avoid crashing processes that speculatively call unsupported syscalls. `SCMP_ACT_LOG` is invaluable during profile development.

### How Docker and Kubernetes Apply Seccomp

Seccomp filters are applied to a process using the `seccomp(2)` system call or `prctl(PR_SET_SECCOMP)`. Container runtimes (containerd, crun, runc) apply the profile when creating the container process, before it starts executing any user code.

```
Fork/exec container → apply seccomp filter → exec container entrypoint
                      ↑ happens here, in privileged parent
```

Once applied, the filter cannot be removed (by design). Children inherit the filter. The filter stack can only be made more restrictive, never less.

## Generating Seccomp Profiles with strace

The practical approach to building a seccomp profile: run the application under strace to capture all syscalls it makes, then generate a whitelist from that output.

### Method 1: strace Direct Capture

```bash
# Run your application under strace and capture all syscalls
strace -f -e trace=all -o /tmp/strace.log ./myapp --flag value

# Extract unique syscall names
grep -oP '^\w+' /tmp/strace.log | sort -u

# For a Docker container
docker run --rm \
  --cap-add SYS_PTRACE \
  --security-opt seccomp=unconfined \
  myapp:latest \
  strace -f -e trace=all -o /tmp/strace.log /entrypoint.sh

# Extract from strace output (handles forked processes)
awk -F'(' '/^[a-z]/{print $1}' /tmp/strace.log | sort -u > /tmp/syscalls.txt
cat /tmp/syscalls.txt
```

### Method 2: oci-seccomp-bpf-hook for Container Tracing

The `oci-seccomp-bpf-hook` tool traces syscalls at the container level using BPF and generates a ready-to-use OCI profile:

```bash
# Install
go install github.com/containers/oci-seccomp-bpf-hook/cmd/oci-seccomp-bpf-hook@latest

# Run container with tracing enabled
docker run \
  --annotation io.containers.trace-syscall="of:/tmp/myapp-profile.json" \
  --rm \
  myapp:latest \
  ./run-tests.sh

# The generated profile is at /tmp/myapp-profile.json
cat /tmp/myapp-profile.json
```

### Method 3: seccomp-tools for Profile Analysis

```bash
# Install
gem install seccomp-tools

# Dump and analyze a BPF filter from a binary
seccomp-tools dump ./mybinary

# Disassemble a profile
seccomp-tools disasm /etc/docker/seccomp/default.json
```

## Analyzing the Docker Default Seccomp Profile

Docker's default profile blocks about 44 syscalls out of ~350 total. Understanding what it blocks and why is essential before creating custom profiles.

```bash
# Download and examine the default profile
curl -o /tmp/docker-default.json \
  https://raw.githubusercontent.com/moby/moby/master/profiles/seccomp/default.json

# Count blocked syscalls
cat /tmp/docker-default.json | \
  jq '[.syscalls[] | select(.action == "SCMP_ACT_ERRNO")] | length'

# See which syscalls are blocked
cat /tmp/docker-default.json | \
  jq -r '.syscalls[] | select(.action == "SCMP_ACT_ERRNO") | .names[]' | sort
```

Key syscalls blocked by Docker's default profile and why:

| Syscall | Reason |
|---|---|
| `ptrace` | Prevent container processes from tracing/modifying each other |
| `mount` | Prevent mounting filesystems (privilege escalation) |
| `umount2` | Prevent unmounting (e.g., security namespaces) |
| `kexec_file_load`, `kexec_load` | Prevent kernel replacement |
| `create_module`, `init_module`, `finit_module` | Prevent kernel module loading |
| `pivot_root` | Prevent filesystem namespace manipulation |
| `clone` with `CLONE_NEWUSER` | Prevent user namespace creation (privilege escalation vector) |
| `settimeofday`, `adjtimex` | Prevent time manipulation |
| `reboot` | Prevent system reboot |
| `acct` | Prevent process accounting manipulation |

The default profile is a reasonable starting point, but it still allows many syscalls that most applications never need.

## Building a Custom Tight Profile

### Step 1: Audit Mode Profile Development

Start with a log-all profile during testing to capture every syscall your application makes:

```json
{
  "defaultAction": "SCMP_ACT_LOG",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
  "syscalls": []
}
```

Run your application with this profile and collect the audit logs:

```bash
# Apply audit profile to Docker
docker run \
  --security-opt seccomp=/tmp/audit-profile.json \
  --rm \
  myapp:latest \
  ./run-full-test-suite.sh

# Collect seccomp audit events
journalctl -k | grep 'type=SECCOMP' | grep -oP 'syscall=\K[0-9]+' | \
  while read syscallnum; do
    ausyscall --exact "$syscallnum" 2>/dev/null || echo "unknown-$syscallnum"
  done | sort -u > /tmp/used-syscalls.txt

cat /tmp/used-syscalls.txt
```

### Step 2: Convert Syscall List to Profile

```python
#!/usr/bin/env python3
# generate_seccomp_profile.py
import json
import sys

def generate_profile(syscall_file, output_file):
    with open(syscall_file) as f:
        syscalls = [line.strip() for line in f if line.strip()]

    profile = {
        "defaultAction": "SCMP_ACT_ERRNO",
        "defaultErrnoRet": 1,  # EPERM
        "architectures": [
            "SCMP_ARCH_X86_64",
            "SCMP_ARCH_X86",
            "SCMP_ARCH_X32"
        ],
        "syscalls": [
            {
                "names": syscalls,
                "action": "SCMP_ACT_ALLOW"
            }
        ]
    }

    with open(output_file, 'w') as f:
        json.dump(profile, f, indent=2)

    print(f"Generated profile with {len(syscalls)} allowed syscalls -> {output_file}")
    print(f"Blocked syscalls: ~{350 - len(syscalls)}")

if __name__ == '__main__':
    generate_profile(sys.argv[1], sys.argv[2])
```

```bash
python3 generate_seccomp_profile.py /tmp/used-syscalls.txt /tmp/myapp-seccomp.json
# Generated profile with 47 allowed syscalls -> /tmp/myapp-seccomp.json
# Blocked syscalls: ~303
```

### Step 3: Verify and Test

```bash
# Test the tight profile
docker run \
  --security-opt seccomp=/tmp/myapp-seccomp.json \
  --rm \
  myapp:latest \
  ./run-full-test-suite.sh

# If tests pass, check for any denied calls in logs
journalctl -k | grep 'type=SECCOMP' | grep 'comm="myapp"'

# Test that attack techniques are blocked
docker run \
  --security-opt seccomp=/tmp/myapp-seccomp.json \
  --rm \
  myapp:latest \
  bash -c 'strace -e trace=ptrace echo "should fail"'
# Should return: ptrace(PTRACE_TRACEME) = -1 EPERM (Operation not permitted)
```

## Kubernetes Seccomp Profiles

### RuntimeDefault Profile

The safest starting point: use the container runtime's built-in default profile:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
spec:
  securityContext:
    seccompProfile:
      type: RuntimeDefault  # Use containerd/crun built-in default
  containers:
  - name: myapp
    image: ghcr.io/myorg/myapp:1.0.0
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 1000
      capabilities:
        drop:
        - ALL
```

### Localhost Profile from a File

For custom profiles, store the JSON file on each node and reference it:

```bash
# Copy profile to each node (use DaemonSet or node provisioner)
sudo mkdir -p /var/lib/kubelet/seccomp/profiles
sudo cp /tmp/myapp-seccomp.json /var/lib/kubelet/seccomp/profiles/myapp.json
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/myapp.json  # relative to /var/lib/kubelet/seccomp/
  containers:
  - name: myapp
    image: ghcr.io/myorg/myapp:1.0.0
```

### OCI Seccomp Profile Distribution with Security Profiles Operator

Distributing profile files to every node manually is operationally painful. The [Security Profiles Operator](https://github.com/kubernetes-sigs/security-profiles-operator) manages seccomp profiles as Kubernetes custom resources:

```bash
# Install the operator
kubectl apply -f https://raw.githubusercontent.com/kubernetes-sigs/security-profiles-operator/main/deploy/operator.yaml

# Wait for operator to be ready
kubectl -n security-profiles-operator wait --for condition=ready pod \
  -l app=security-profiles-operator --timeout=120s
```

Create a `SeccompProfile` custom resource:

```yaml
# seccomp-profile-myapp.yaml
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: myapp-profile
  namespace: myapp
spec:
  defaultAction: SCMP_ACT_ERRNO
  architectures:
  - SCMP_ARCH_X86_64
  syscalls:
  - action: SCMP_ACT_ALLOW
    names:
    # Process management
    - execve
    - exit
    - exit_group
    - wait4
    - waitpid
    - clone
    - fork
    - vfork
    # File operations
    - read
    - write
    - open
    - openat
    - close
    - stat
    - fstat
    - lstat
    - mmap
    - munmap
    - mprotect
    - brk
    - lseek
    - ioctl
    # Network
    - socket
    - connect
    - bind
    - listen
    - accept
    - accept4
    - send
    - sendto
    - recv
    - recvfrom
    - getsockname
    - getpeername
    - setsockopt
    - getsockopt
    - shutdown
    - epoll_create
    - epoll_create1
    - epoll_ctl
    - epoll_wait
    - epoll_pwait
    - poll
    - select
    - pselect6
    # Signals
    - rt_sigaction
    - rt_sigprocmask
    - rt_sigreturn
    - sigaltstack
    - kill
    # Time
    - clock_gettime
    - clock_nanosleep
    - nanosleep
    - gettimeofday
    # System
    - futex
    - set_robust_list
    - get_robust_list
    - getpid
    - getppid
    - getuid
    - geteuid
    - getgid
    - getegid
    - getgroups
    - arch_prctl
    - prctl
    - uname
    - getcwd
    - chdir
    - pread64
    - pwrite64
    - pipe
    - pipe2
    - fcntl
    - dup
    - dup2
    - dup3
    - sched_yield
    - sched_getaffinity
    - sched_setaffinity
    - getdents
    - getdents64
    - unlink
    - unlinkat
    - rename
    - renameat
    - mkdir
    - mkdirat
    - rmdir
    - readlink
    - readlinkat
    - chmod
    - fchmod
    - fchmodat
    - chown
    - fchown
    - fchownat
    - access
    - faccessat
    - truncate
    - ftruncate
    - statfs
    - fstatfs
    - sync
    - fsync
    - fdatasync
    - sendfile
    - splice
    - tee
    - copy_file_range
    - madvise
    - mincore
    - mlock
    - munlock
    - mremap
    - msync
    # Thread management
    - tgkill
    - tkill
    - gettid
    - set_tid_address
    - rseq
```

Reference the profile in a Pod:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: myapp
  annotations:
    # This annotation tells the operator to watch for profile updates
    container.seccomp.security.alpha.kubernetes.io/myapp: localhost/operator/myapp/myapp-profile.json
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: operator/myapp/myapp-profile.json
  containers:
  - name: myapp
    image: ghcr.io/myorg/myapp:1.0.0
```

The operator automatically distributes the profile JSON to `/var/lib/kubelet/seccomp/operator/` on every node.

## Recording Mode: Automated Profile Generation

The Security Profiles Operator can record syscalls from a running workload and generate a profile automatically:

```yaml
# Start recording syscalls from the myapp deployment
apiVersion: security-profiles-operator.x-k8s.io/v1alpha1
kind: ProfileRecording
metadata:
  name: myapp-recording
  namespace: myapp
spec:
  kind: SeccompProfile
  recorder: bpf
  podSelector:
    matchLabels:
      app: myapp
```

After running your test suite, stop the recording:

```bash
kubectl -n myapp delete profilerecording myapp-recording

# The operator creates a SeccompProfile from the recorded data
kubectl -n myapp get seccompprofiles
# NAME                    STATUS   AGE
# myapp-recording-myapp   Saved    30s
```

## Defense-in-Depth: Combining Seccomp with AppArmor

Seccomp restricts syscalls. AppArmor restricts file access, capabilities, and network operations based on application identity. Used together, they provide overlapping defenses:

```
Seccomp:
  - Blocks syscalls: ptrace, mount, kexec, etc.
  - Enforced by kernel for every syscall

AppArmor:
  - Restricts file read/write/execute paths
  - Restricts network operations (connect to specific ports)
  - Restricts capabilities
  - Enforced per-operation by LSM hooks
```

```bash
# AppArmor profile for a Go web server
cat > /etc/apparmor.d/myapp <<'EOF'
#include <tunables/global>

profile myapp flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  # Allow reading application files
  /app/**       r,
  /app/server   ix,     # execute the server binary

  # Allow writing to log directory only
  /var/log/myapp/** rw,

  # Deny writes to system files
  deny /etc/**  w,
  deny /usr/**  w,
  deny /bin/**  w,

  # Allow network: server binds on 8080
  network tcp,
  network udp,

  # Allow reading DNS config
  /etc/resolv.conf r,
  /etc/hosts       r,
  /etc/nsswitch.conf r,

  # Deny access to credentials
  deny /etc/shadow r,
  deny /etc/sudoers r,
  deny /root/** rw,
}
EOF

apparmor_parser -r -W /etc/apparmor.d/myapp
```

Apply AppArmor profile in Kubernetes:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  annotations:
    container.apparmor.security.beta.kubernetes.io/myapp: localhost/myapp
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/myapp.json
  containers:
  - name: myapp
    image: ghcr.io/myorg/myapp:1.0.0
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 65534
      capabilities:
        drop:
        - ALL
```

## Practical: Testing That Attack Techniques Are Blocked

After applying a profile, verify that common attack techniques are actually blocked:

```bash
#!/bin/bash
# test-seccomp-profile.sh
# Run inside the container to verify the profile works

echo "=== Testing seccomp profile effectiveness ==="

# Test 1: ptrace (required for debuggers, process injection)
echo -n "ptrace blocked: "
python3 -c "import ctypes; ctypes.CDLL(None).ptrace(0,0,0,0)" 2>&1 | \
  grep -q "Operation not permitted" && echo "PASS" || echo "FAIL"

# Test 2: mount (required for most privilege escalation)
echo -n "mount blocked: "
mount -t tmpfs tmpfs /tmp/test 2>&1 | \
  grep -q "Operation not permitted" && echo "PASS" || echo "FAIL"

# Test 3: kernel module loading
echo -n "init_module blocked: "
insmod /dev/null 2>&1 | \
  grep -qE "Operation not permitted|No such file" && echo "PASS" || echo "FAIL"

# Test 4: user namespace creation (CVE-2023-x type attacks)
echo -n "unshare --user blocked: "
unshare --user /bin/true 2>&1 | \
  grep -q "Operation not permitted" && echo "PASS" || echo "FAIL"

# Test 5: kexec (kernel replacement)
echo -n "kexec_load blocked: "
kexec -l /boot/vmlinuz 2>&1 | \
  grep -q "Operation not permitted" && echo "PASS" || echo "FAIL"

echo "=== Profile verification complete ==="
```

## Monitoring Seccomp Violations in Production

```yaml
# Prometheus rule for seccomp violations
groups:
- name: seccomp
  rules:
  - alert: SeccompViolation
    expr: increase(node_audit_seccomp_violations_total[5m]) > 0
    for: 0m
    labels:
      severity: warning
    annotations:
      summary: "Seccomp violation on {{ $labels.instance }}"
      description: "Process attempted a blocked syscall. Check audit log for details."
```

```bash
# Monitor seccomp violations in real time
auditctl -a always,exit -F arch=b64 -S all -F key=seccomp-violations
ausearch -k seccomp-violations -i | tail -20

# Alternative: use Falco for richer context
# Falco detects seccomp violations via kernel module/eBPF and provides
# container name, image, and process context
```

## Profile Testing in CI/CD

```yaml
# .github/workflows/seccomp-validation.yaml
name: Seccomp Profile Validation

on:
  pull_request:
    paths:
      - 'seccomp/**'
      - 'Dockerfile'

jobs:
  validate-profile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build container image
        run: docker build -t test-image:ci .

      - name: Run tests with seccomp profile
        run: |
          docker run \
            --rm \
            --security-opt seccomp=seccomp/myapp-profile.json \
            --security-opt no-new-privileges \
            test-image:ci \
            ./run-tests.sh

      - name: Verify attack techniques are blocked
        run: |
          docker run \
            --rm \
            --security-opt seccomp=seccomp/myapp-profile.json \
            test-image:ci \
            bash -c '
              # ptrace should be blocked
              python3 -c "import ctypes; ctypes.CDLL(None).ptrace(0,0,0,0)" \
                2>&1 | grep -q "Operation not permitted" || exit 1
              echo "Attack surface validation passed"
            '

      - name: Check profile diff
        if: github.event_name == 'pull_request'
        run: |
          git diff origin/main -- seccomp/myapp-profile.json | \
            jq -r '.syscalls[].names[]' | sort > /tmp/new-syscalls.txt

          # Fail if new syscalls were added that require review
          RISKY_SYSCALLS=("ptrace" "mount" "kexec_load" "init_module")
          for syscall in "${RISKY_SYSCALLS[@]}"; do
            if grep -q "^${syscall}$" /tmp/new-syscalls.txt; then
              echo "ERROR: Risky syscall '${syscall}' added to profile"
              exit 1
            fi
          done
```

## Summary

Seccomp-BPF is a kernel-enforced syscall whitelist that significantly reduces the attack surface of container workloads. The practical workflow is:

1. Run the application in audit mode (`SCMP_ACT_LOG` default) to capture all syscalls
2. Use strace, `oci-seccomp-bpf-hook`, or the Security Profiles Operator's recording mode to collect the syscall list
3. Generate a whitelist profile with `SCMP_ACT_ERRNO` as the default
4. Test the profile with the full application test suite plus explicit attack technique tests
5. Distribute profiles via the Security Profiles Operator (Kubernetes) or node provisioning (bare metal)
6. Reference the profile from pod security context alongside AppArmor and capability drops
7. Monitor for violations in production and update profiles as the application evolves

The combination of seccomp (syscall filtering), AppArmor/SELinux (file and capability MAC), dropped capabilities, and read-only root filesystems creates overlapping defensive layers where compromising one layer does not give an attacker full access. This is defense-in-depth at the OS level, without relying solely on network-perimeter controls.
