---
title: "eBPF Security Enforcement in Kubernetes: From Detection to Prevention"
date: 2027-11-21T00:00:00-05:00
draft: false
tags: ["eBPF", "Kubernetes", "Security", "Tetragon", "Falco"]
categories:
- Kubernetes
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive comparison of eBPF-based Kubernetes security tools including Tetragon, Falco, and Tracee. Covers kernel tracing hooks, syscall filtering, network enforcement, process execution monitoring, file access control, and incident response."
more_link: "yes"
url: "/ebpf-kubernetes-security-enforcement-guide/"
---

Traditional container security tools operate at the container runtime layer or via admission webhooks. Both approaches have a fundamental weakness: they cannot observe or enforce behavior inside a running container without attaching kernel probes. eBPF changes this completely by running security logic directly in the Linux kernel, with visibility into every syscall, network packet, and file operation regardless of what the container or application does to evade detection.

This guide covers the three major eBPF security tools for Kubernetes - Tetragon, Falco, and Tracee - their architectures, deployment patterns, and practical enforcement configurations.

<!--more-->

# eBPF Security Enforcement in Kubernetes: From Detection to Prevention

## Section 1: eBPF Security Architecture

eBPF (Extended Berkeley Packet Filter) programs run in the Linux kernel in a sandboxed virtual machine. They are loaded via the `bpf()` syscall and attached to kernel hooks including:

- **kprobes/kretprobes**: Arbitrary kernel function entry/exit
- **tracepoints**: Stable kernel instrumentation points (syscall entry/exit, network events)
- **XDP (eXpress Data Path)**: Network packet processing at the lowest level
- **LSM (Linux Security Module) hooks**: Security enforcement points

For container security, the most relevant attachment points are:

```
Process Events:
  sched_process_exec → new process started
  sched_process_exit → process exited

Syscall Events:
  sys_enter_openat  → file open attempt
  sys_enter_connect → network connection attempt
  sys_enter_execve  → binary execution

Network Events:
  tcp_connect        → TCP connection established
  tcp_sendmsg        → data sent on TCP socket

Security Events (LSM):
  security_file_open → file access check
  security_bprm_check → binary execution check
  security_socket_connect → network connection check
```

The critical advantage over traditional tools: eBPF hooks run in the kernel context where it is impossible for a compromised container to bypass them, even with container escape capabilities. A privileged container that breaks out of namespace isolation is still subject to kernel-level eBPF enforcement.

## Section 2: Tool Comparison

### Tetragon (Cilium Project)

Tetragon combines deep observability with in-kernel enforcement. It can not only detect but also kill processes, drop network connections, and override return values - all from kernel space.

**Architecture**: Agent DaemonSet + gRPC event stream + Kubernetes controller for TracingPolicy CRDs.

**Strengths**:
- In-kernel enforcement (SIGKILL, network drop) without userspace round-trip
- Deep integration with Cilium network policies
- Rich process lineage tracking
- Kubernetes-native policy language (TracingPolicy CRDs)

**Limitations**:
- Requires Cilium for full enforcement features (or standalone mode with reduced capabilities)
- Learning curve for TracingPolicy DSL

### Falco (CNCF)

Falco is the most mature and widely adopted container security tool. It uses a rules engine with a well-established DSL that security teams are already familiar with.

**Architecture**: Agent DaemonSet with kernel module or eBPF driver + rules engine + outputs (syslog, gRPC, HTTP, Slack).

**Strengths**:
- Large community rule library
- Multiple output channels
- Well-documented rule language
- CIS benchmark rule sets included
- Falco Sidekick for alert routing

**Limitations**:
- Detection only (no enforcement); requires external automation for response
- High cardinality events can cause performance issues without careful tuning

### Tracee (Aqua Security)

Tracee focuses on cloud-native threat detection with signature-based detection for known attack patterns and an open policy language.

**Architecture**: Agent DaemonSet + OPA-based signature engine + Prometheus metrics.

**Strengths**:
- OPA policy language for custom signatures
- Built-in artifact capture
- Strong focus on supply chain security
- Prometheus-native metrics

**Limitations**:
- Younger project, smaller community than Falco
- Enforcement requires external integration

## Section 3: Tetragon Deployment and Enforcement

### Tetragon Installation

```bash
helm repo add cilium https://helm.cilium.io
helm repo update

helm install tetragon cilium/tetragon \
  --namespace kube-system \
  --version 1.1.2 \
  --set tetragon.grpc.address=localhost:54321 \
  --set tetragon.btf="" \
  --set tetragon.exportFilename=/var/run/cilium/tetragon/tetragon.log \
  --set tetragon.enableProcessCred=true \
  --set tetragon.enableProcessNs=true \
  --set tetragonOperator.enabled=true

# Verify installation
kubectl get pods -n kube-system -l app.kubernetes.io/name=tetragon
kubectl exec -n kube-system ds/tetragon -c tetragon -- tetra status
```

### TracingPolicy: Process Execution Monitoring

TracingPolicy is the Tetragon CRD that defines what to observe and what action to take.

```yaml
# Monitor and kill unauthorized binary execution
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: enforce-allowed-binaries
spec:
  kprobes:
  - call: "security_bprm_check"
    syscall: false
    return: false
    args:
    - index: 0
      type: "linux_binprm"
    selectors:
    # Kill any execution of /usr/bin/curl in production pods
    - matchArgs:
      - index: 0
        operator: "Postfix"
        values:
        - "/usr/bin/curl"
        - "/usr/bin/wget"
        - "/usr/bin/nc"
        - "/usr/bin/ncat"
        - "/usr/bin/netcat"
        - "/bin/nc"
      matchNamespaces:
      - namespace: InClusterNamespace
        operator: In
        values:
        - "production"
      matchCapabilities:
      - type: Effective
        operator: NotIn
        values:
        - "CAP_SYS_ADMIN"  # Allow if process has sysadmin (for debugging)
      actions:
      - action: Sigkill
        # Sigkill terminates the process in the kernel, before it can do anything
```

### TracingPolicy: File Access Control

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: protect-sensitive-files
spec:
  kprobes:
  - call: "security_file_open"
    syscall: false
    return: false
    args:
    - index: 0
      type: "file"
    selectors:
    # Alert on access to sensitive paths
    - matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/etc/shadow"
        - "/etc/passwd"
        - "/root/.ssh"
        - "/proc/sysrq-trigger"
      actions:
      - action: Post  # Generate alert event
        rateLimit: "1/minute"  # Rate limit to avoid alert storms

    # Kill on /etc/shadow write attempts
    - matchArgs:
      - index: 0
        operator: "Equal"
        values:
        - "/etc/shadow"
      matchActions:
      - action: Sigkill
```

### TracingPolicy: Network Enforcement

```yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-c2-connections
spec:
  kprobes:
  - call: "tcp_connect"
    syscall: false
    return: false
    args:
    - index: 0
      type: "sock"
    selectors:
    # Block connections to known malicious IP ranges
    - matchArgs:
      - index: 0
        operator: "DAddr"
        values:
        - "10.0.0.1/32"       # Example C2 server
        - "192.168.100.0/24"  # Example malicious range
      actions:
      - action: Override
        argError: -111  # ECONNREFUSED - connection refused in kernel
```

### Reading Tetragon Events

```bash
# Real-time event stream
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
    tetra getevents -o compact

# Filter for specific namespace
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
    tetra getevents -o compact --namespace production

# Filter for process execution events only
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
    tetra getevents --process-exec --output json | \
    jq 'select(.process_exec != null) |
        {time: .time,
         pod: .process_exec.process.pod.name,
         binary: .process_exec.process.binary,
         args: .process_exec.process.arguments}'

# Get killed processes
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
    tetra getevents --output json | \
    jq 'select(.process_kprobe.action == "SIGKILL")'
```

## Section 4: Falco Deployment and Rules

### Falco Installation with eBPF Driver

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

helm install falco falcosecurity/falco \
  --namespace falco \
  --create-namespace \
  --version 4.6.0 \
  --set driver.kind=ebpf \
  --set falco.grpc.enabled=true \
  --set falco.grpc_output.enabled=true \
  --set falco.json_output=true \
  --set falco.log_level=info \
  --set falco.priority=warning

# Install Falco Sidekick for alert routing
helm install falcosidekick falcosecurity/falcosidekick \
  --namespace falco \
  --version 0.7.14 \
  --set config.slack.webhookurl="https://hooks.slack.com/services/REPLACE/WITH/WEBHOOK" \
  --set config.slack.minimumpriority=warning \
  --set config.pagerduty.routingkey="REPLACE_WITH_ROUTING_KEY" \
  --set config.pagerduty.minimumpriority=critical \
  --set webui.enabled=true
```

### Critical Falco Rules

```yaml
# /etc/falco/falco_rules.local.yaml
# Custom rules that augment the default ruleset

# Rule: Detect shell in container (common post-exploitation)
- rule: Shell Spawned in Container
  desc: >
    A shell was spawned inside a container. This is a common indicator
    of interactive exploitation or debugging access.
  condition: >
    spawned_process and
    container and
    not container.image.repository in (allowed_shell_images) and
    proc.name in (shell_binaries)
  output: >
    Shell spawned in container
    (user=%user.name user_loginname=%user.loginname
     container_id=%container.id container_name=%container.name
     image=%container.image.repository:%container.image.tag
     shell=%proc.name parent=%proc.pname cmdline=%proc.cmdline)
  priority: WARNING
  tags: [container, shell, MITRE_Execution]

# Rule: Detect package manager execution (persistence mechanism)
- rule: Package Manager Executed in Container
  desc: Package management tools should not run in production containers
  condition: >
    spawned_process and
    container and
    proc.name in (package_mgmt_binaries) and
    not proc.pname in (allowed_package_mgmt_parents)
  output: >
    Package manager executed in container
    (user=%user.name container_id=%container.id
     image=%container.image.repository
     cmd=%proc.cmdline)
  priority: ERROR
  tags: [container, software_mgmt, MITRE_Persistence]

# Rule: Detect credential file access
- rule: Credentials File Accessed
  desc: Sensitive credential files accessed in unexpected context
  condition: >
    open_read and
    fd.name in (sensitive_files) and
    not proc.name in (allowed_credential_readers) and
    not user.name in (allowed_system_users)
  output: >
    Sensitive file accessed
    (user=%user.name cmd=%proc.cmdline file=%fd.name
     container=%container.name image=%container.image.repository)
  priority: WARNING
  tags: [filesystem, credentials, MITRE_CredentialAccess]

# Rule: Detect outbound connection to non-standard ports
- rule: Unexpected Outbound Connection
  desc: Container made connection to unexpected external service
  condition: >
    outbound and
    container and
    not fd.sport in (allowed_outbound_ports) and
    not fd.sip in (allowed_outbound_ips) and
    not proc.name in (allowed_outbound_procs)
  output: >
    Unexpected outbound connection
    (command=%proc.cmdline connection=%fd.name
     container=%container.name image=%container.image.repository)
  priority: WARNING
  tags: [network, MITRE_CommandAndControl]

# Lists used by rules above
- list: shell_binaries
  items: [bash, csh, ksh, sh, tcsh, zsh, dash, ash, fish]

- list: package_mgmt_binaries
  items: [apt, apt-get, yum, dnf, pip, pip3, npm, yarn, gem, cargo]

- list: sensitive_files
  items: [/etc/shadow, /etc/passwd, /root/.ssh/id_rsa, /etc/kubernetes/admin.conf]

- list: allowed_shell_images
  items: [toolbox, debug-container]

- list: allowed_outbound_ports
  items: [53, 80, 443, 5432, 6379, 9092]

# Macro to identify outbound connections
- macro: outbound
  condition: >
    (evt.type=connect or evt.type=sendto) and
    fd.typechar=4 and
    (fd.sport!=0 and fd.dport!=0) and
    fd.sip != "0.0.0.0" and
    not fd.dip in (rfc_1918_addresses)

- list: rfc_1918_addresses
  items: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
```

### Automated Response with Falco Talon

Falco Talon provides automated response actions triggered by Falco events:

```yaml
# falco-talon-rules.yaml
- action: kill-pod
  parameters:
    graceful_period: 0
  match:
    - output_fields:
        container.name: ".*"
      priority: critical
      rule: ".*shell.*"

- action: label-pod
  parameters:
    labels:
      quarantine: "true"
      quarantine-reason: "security-incident"
  match:
    - output_fields:
        container.name: ".*"
      priority: warning
      rule: "Credentials File Accessed"

- action: notify-slack
  parameters:
    webhook_url: "https://hooks.slack.com/services/REPLACE/WITH/WEBHOOK"
    message: |
      *Security Alert*: {{ .Rule }}
      *Container*: {{ index .OutputFields "container.name" }}
      *Image*: {{ index .OutputFields "container.image.repository" }}
      *Command*: {{ index .OutputFields "proc.cmdline" }}
  match:
    - priority: warning
```

## Section 5: Tracee Deployment and Signatures

### Tracee Installation

```bash
helm repo add aquasecurity https://aquasecurity.github.io/helm-charts
helm repo update

helm install tracee aquasecurity/tracee \
  --namespace tracee-system \
  --create-namespace \
  --version 0.21.0 \
  --set config.output.json=true \
  --set config.output.webhooks[0].url=http://falcosidekick:2801 \
  --set config.cache.type=ring \
  --set config.cache.size=512
```

### Tracee Signature for Container Escape Detection

```go
// signatures/container_escape.go
package main

import (
    "github.com/aquasecurity/tracee/pkg/signatures/signature"
    "github.com/aquasecurity/tracee/types/detect"
    "github.com/aquasecurity/tracee/types/protocol"
    "github.com/aquasecurity/tracee/types/trace"
)

type ContainerEscapeDetector struct {
    cb  detect.SignatureHandler
    seenMounts map[string]bool
}

func (d *ContainerEscapeDetector) Init(cb detect.SignatureHandler) error {
    d.cb = cb
    d.seenMounts = make(map[string]bool)
    return nil
}

func (d *ContainerEscapeDetector) GetMetadata() (detect.SignatureMetadata, error) {
    return detect.SignatureMetadata{
        ID:          "TRC-1001",
        Version:     "1.0.0",
        Name:        "Container Escape via Mount",
        Description: "Detects potential container escape via privileged mount operations",
        Tags:        []string{"container", "escape", "MITRE_PrivilegeEscalation"},
        Properties: map[string]interface{}{
            "Severity": 4,  // 0-4, 4 = Critical
        },
    }, nil
}

func (d *ContainerEscapeDetector) GetSelectedEvents() ([]detect.RuleEventSelector, error) {
    return []detect.RuleEventSelector{
        {Source: "tracee", Name: "security_sb_mount"},
        {Source: "tracee", Name: "container_create"},
    }, nil
}

func (d *ContainerEscapeDetector) OnEvent(event protocol.Event) error {
    eventObj, ok := event.Payload.(trace.Event)
    if !ok {
        return nil
    }

    switch eventObj.EventName {
    case "security_sb_mount":
        // Check if mounting the host filesystem
        if srcArg, err := eventObj.GetArgByName("dev_name"); err == nil {
            src, _ := srcArg.Value.(string)
            if src == "/dev/sda" || src == "/dev/nvme0n1" {
                d.cb(detect.Finding{
                    SigMetadata: detect.SignatureMetadata{
                        ID:   "TRC-1001",
                        Name: "Container Escape via Host Disk Mount",
                    },
                    Event: event,
                    Data: map[string]interface{}{
                        "mounted_device": src,
                        "container_id":   eventObj.Container.ID,
                    },
                })
            }
        }
    }
    return nil
}

func (d *ContainerEscapeDetector) OnSignal(signal detect.Signal) error {
    return nil
}

func (d *ContainerEscapeDetector) Close() {}
```

## Section 6: Kernel Syscall Filtering with Seccomp

Seccomp filters restrict which syscalls a container can make, providing a defense-in-depth layer complementary to eBPF tools. Kubernetes 1.19+ can apply seccomp profiles via SecurityContext.

### Custom Seccomp Profile

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
        "accept", "accept4", "access", "adjtimex", "alarm", "bind", "brk",
        "capget", "capset", "chdir", "chmod", "chown", "chroot", "clock_getres",
        "clock_gettime", "clock_nanosleep", "close", "connect", "copy_file_range",
        "creat", "dup", "dup2", "dup3", "epoll_create", "epoll_create1",
        "epoll_ctl", "epoll_pwait", "epoll_wait", "eventfd", "eventfd2",
        "execve", "execveat", "exit", "exit_group", "faccessat", "faccessat2",
        "fadvise64", "fallocate", "fanotify_mark", "fchdir", "fchmod",
        "fchmodat", "fchown", "fchownat", "fcntl", "fdatasync", "fgetxattr",
        "flistxattr", "flock", "fork", "fremovexattr", "fsetxattr", "fstat",
        "fstatat64", "fstatfs", "fsync", "ftruncate", "futex", "getcpu",
        "getcwd", "getdents", "getdents64", "getegid", "geteuid", "getgid",
        "getgroups", "getitimer", "getpeername", "getpgid", "getpgrp",
        "getpid", "getppid", "getpriority", "getrandom", "getrlimit",
        "getrusage", "getsid", "getsockname", "getsockopt", "gettid",
        "gettimeofday", "getuid", "getxattr", "inotify_add_watch",
        "inotify_init", "inotify_init1", "inotify_rm_watch", "io_cancel",
        "io_destroy", "io_getevents", "io_setup", "io_submit",
        "ioctl", "ioprio_get", "ioprio_set", "ipc", "kill", "lchown",
        "lgetxattr", "link", "linkat", "listen", "listxattr", "llistxattr",
        "lremovexattr", "lseek", "lsetxattr", "lstat", "madvise",
        "memfd_create", "mincore", "mkdir", "mkdirat", "mknod", "mknodat",
        "mlock", "mlock2", "mlockall", "mmap", "mprotect", "mq_getsetattr",
        "mq_notify", "mq_open", "mq_timedreceive", "mq_timedsend",
        "mq_unlink", "mremap", "msgctl", "msgget", "msgrcv", "msgsnd",
        "msync", "munlock", "munlockall", "munmap", "nanosleep", "newfstatat",
        "open", "openat", "openat2", "pause", "pipe", "pipe2", "poll",
        "ppoll", "prctl", "pread64", "preadv", "preadv2", "prlimit64",
        "pselect6", "ptrace", "pwrite64", "pwritev", "pwritev2", "read",
        "readahead", "readlink", "readlinkat", "readv", "recv", "recvfrom",
        "recvmmsg", "recvmsg", "remap_file_pages", "removexattr", "rename",
        "renameat", "renameat2", "restart_syscall", "rmdir", "rt_sigaction",
        "rt_sigpending", "rt_sigprocmask", "rt_sigqueueinfo",
        "rt_sigreturn", "rt_sigsuspend", "rt_sigtimedwait",
        "rt_tgsigqueueinfo", "sched_getaffinity", "sched_getattr",
        "sched_getparam", "sched_get_priority_max",
        "sched_get_priority_min", "sched_getscheduler", "sched_setaffinity",
        "sched_yield", "seccomp", "select", "semctl", "semget", "semop",
        "semtimedop", "send", "sendfile", "sendmmsg", "sendmsg", "sendto",
        "set_robust_list", "set_tid_address", "setfsgid", "setfsuid",
        "setgid", "setgroups", "setitimer", "setpgid", "setpriority",
        "setregid", "setresgid", "setresuid", "setreuid", "setsid",
        "setsockopt", "setuid", "setxattr", "shmat", "shmctl", "shmdt",
        "shmget", "shutdown", "sigaltstack", "signalfd", "signalfd4",
        "socket", "socketcall", "socketpair", "splice", "stat", "statfs",
        "statx", "symlink", "symlinkat", "sync", "sync_file_range",
        "sysfs", "sysinfo", "tee", "tgkill", "time", "timer_create",
        "timer_delete", "timer_getoverrun", "timer_gettime", "timer_settime",
        "timerfd_create", "timerfd_gettime", "timerfd_settime", "times",
        "tkill", "truncate", "umask", "uname", "unlink", "unlinkat",
        "utime", "utimensat", "utimes", "vfork", "vmsplice", "wait4",
        "waitid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

Store seccomp profiles using a ConfigMap and reference via node local storage or Kubernetes Security Profile Operator:

```yaml
# Using Security Profiles Operator (SPO)
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: api-server-profile
  namespace: production
spec:
  defaultAction: SCMP_ACT_ERRNO
  architectures:
  - SCMP_ARCH_X86_64
  syscalls:
  - action: SCMP_ACT_ALLOW
    names:
    - read
    - write
    - open
    - close
    - stat
    - fstat
    - mmap
    - mprotect
    - munmap
    - brk
    - rt_sigaction
    - rt_sigprocmask
    - rt_sigreturn
    - ioctl
    - pread64
    - pwrite64
    - readv
    - writev
    - access
    - pipe
    - select
    - sched_yield
    - mremap
    - msync
    - mincore
    - madvise
    - shmget
    - shmat
    - shmctl
    - dup
    - dup2
    - pause
    - nanosleep
    - getitimer
    - alarm
    - setitimer
    - getpid
    - sendfile
    - socket
    - connect
    - accept
    - sendto
    - recvfrom
    - sendmsg
    - recvmsg
    - shutdown
    - bind
    - listen
    - getsockname
    - getpeername
    - socketpair
    - setsockopt
    - getsockopt
    - clone
    - fork
    - vfork
    - execve
    - exit
    - wait4
    - kill
    - uname
    - fcntl
    - flock
    - fsync
    - fdatasync
    - truncate
    - ftruncate
    - getdents
    - getcwd
    - chdir
    - fchdir
    - rename
    - mkdir
    - rmdir
    - creat
    - link
    - unlink
    - symlink
    - readlink
    - chmod
    - fchmod
    - chown
    - fchown
    - lchown
    - umask
    - gettimeofday
    - getrlimit
    - getrusage
    - sysinfo
    - times
    - ptrace
    - getuid
    - syslog
    - getgid
    - setuid
    - setgid
    - geteuid
    - getegid
    - setpgid
    - getppid
    - getpgrp
    - setsid
    - setreuid
    - setregid
    - getgroups
    - setgroups
    - setresuid
    - getresuid
    - setresgid
    - getresgid
    - getpgid
    - setfsuid
    - setfsgid
    - getsid
    - capget
    - capset
    - rt_sigpending
    - rt_sigtimedwait
    - rt_sigqueueinfo
    - rt_sigsuspend
    - sigaltstack
    - utime
    - mknod
    - uselib
    - personality
    - ustat
    - statfs
    - fstatfs
    - sysfs
    - getpriority
    - setpriority
    - sched_setparam
    - sched_getparam
    - sched_setscheduler
    - sched_getscheduler
    - sched_get_priority_max
    - sched_get_priority_min
    - sched_rr_get_interval
    - mlock
    - munlock
    - mlockall
    - munlockall
    - vhangup
    - modify_ldt
    - pivot_root
    - _sysctl
    - prctl
    - arch_prctl
    - adjtimex
    - setrlimit
    - chroot
    - sync
    - acct
    - settimeofday
    - futex
    - sched_setaffinity
    - sched_getaffinity
    - set_thread_area
    - io_setup
    - io_destroy
    - io_getevents
    - io_submit
    - io_cancel
    - get_thread_area
    - lookup_dcookie
    - epoll_create
    - epoll_ctl_old
    - epoll_wait_old
    - remap_file_pages
    - getdents64
    - set_tid_address
    - restart_syscall
    - semtimedop
    - fadvise64
    - timer_create
    - timer_settime
    - timer_gettime
    - timer_getoverrun
    - timer_delete
    - clock_settime
    - clock_gettime
    - clock_getres
    - clock_nanosleep
    - exit_group
    - epoll_wait
    - epoll_ctl
    - tgkill
    - utimes
    - vserver
    - mbind
    - set_mempolicy
    - get_mempolicy
    - mq_open
    - mq_unlink
    - mq_timedsend
    - mq_timedreceive
    - mq_notify
    - mq_getsetattr
    - kexec_load
    - waitid
    - add_key
    - request_key
    - keyctl
    - ioprio_set
    - ioprio_get
    - inotify_init
    - inotify_add_watch
    - inotify_rm_watch
    - migrate_pages
    - openat
    - mkdirat
    - mknodat
    - fchownat
    - futimesat
    - newfstatat
    - unlinkat
    - renameat
    - linkat
    - symlinkat
    - readlinkat
    - fchmodat
    - faccessat
    - pselect6
    - ppoll
    - unshare
    - set_robust_list
    - get_robust_list
    - splice
    - tee
    - sync_file_range
    - vmsplice
    - move_pages
    - utimensat
    - epoll_pwait
    - signalfd
    - timerfd_create
    - eventfd
    - fallocate
    - timerfd_settime
    - timerfd_gettime
    - accept4
    - signalfd4
    - eventfd2
    - epoll_create1
    - dup3
    - pipe2
    - inotify_init1
    - preadv
    - pwritev
    - rt_tgsigqueueinfo
    - perf_event_open
    - recvmmsg
    - fanotify_init
    - fanotify_mark
    - prlimit64
    - name_to_handle_at
    - open_by_handle_at
    - clock_adjtime
    - syncfs
    - sendmmsg
    - setns
    - getcpu
    - process_vm_readv
    - process_vm_writev
    - kcmp
    - finit_module
    - sched_setattr
    - sched_getattr
    - renameat2
    - seccomp
    - getrandom
    - memfd_create
    - kexec_file_load
    - bpf
    - execveat
    - userfaultfd
    - membarrier
    - mlock2
    - copy_file_range
    - preadv2
    - pwritev2
    - statx
    - io_pgetevents
    - rseq
    - pidfd_send_signal
    - io_uring_setup
    - io_uring_enter
    - io_uring_register
    - open_tree
    - move_mount
    - fsopen
    - fsconfig
    - fsmount
    - fspick
    - pidfd_open
    - clone3
    - close_range
    - openat2
    - pidfd_getfd
    - faccessat2
    - process_madvise
    - epoll_pwait2
    - mount_setattr
    - landlock_create_ruleset
    - landlock_add_rule
    - landlock_restrict_self
    - memfd_secret
    - process_mrelease
```

Reference the seccomp profile in Pod spec:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-api
  namespace: production
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: operator/production/api-server-profile.json
  containers:
  - name: api
    image: myapp:1.0.0
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
      readOnlyRootFilesystem: true
```

## Section 7: Incident Response with eBPF Data

When an incident occurs, eBPF tools provide forensic data that traditional tools cannot: the complete process lineage, all syscalls made, all files accessed, and all network connections established by the attacker.

### Tetragon Forensic Collection

```bash
# Collect full process execution history for a compromised pod
COMPROMISED_POD="api-server-7d4f8c9b-xkp2z"
NAMESPACE="production"

# Get all processes started in the pod since compromise
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
    tetra getevents \
    --process-exec \
    --output json | \
    jq --arg pod "$COMPROMISED_POD" '
        select(.process_exec.process.pod.name == $pod) |
        {
            time: .time,
            binary: .process_exec.process.binary,
            args: .process_exec.process.arguments,
            parent: .process_exec.parent.binary,
            user: .process_exec.process.capabilities.effective
        }
    ' > /tmp/compromised-pod-processes.json

# Get all network connections
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
    tetra getevents \
    --process-kprobe \
    --output json | \
    jq --arg pod "$COMPROMISED_POD" '
        select(.process_kprobe.process.pod.name == $pod) |
        select(.process_kprobe.function_name == "tcp_connect") |
        {
            time: .time,
            binary: .process_kprobe.process.binary,
            destination: .process_kprobe.args
        }
    ' > /tmp/compromised-pod-network.json

echo "Process history saved to /tmp/compromised-pod-processes.json"
echo "Network connections saved to /tmp/compromised-pod-network.json"
```

### Automated Quarantine Response

```bash
#!/bin/bash
# quarantine-pod.sh
# Called by Falco webhook when critical alert fires

POD_NAME="${1}"
NAMESPACE="${2}"
RULE="${3}"

echo "Quarantining pod $POD_NAME in namespace $NAMESPACE (rule: $RULE)"

# Label pod for quarantine
kubectl label pod "$POD_NAME" -n "$NAMESPACE" \
    security.k8s.io/quarantine=true \
    security.k8s.io/quarantine-reason="$RULE" \
    security.k8s.io/quarantine-time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Apply network policy to isolate the pod
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: quarantine-${POD_NAME}
  namespace: ${NAMESPACE}
spec:
  podSelector:
    matchLabels:
      security.k8s.io/quarantine: "true"
  policyTypes:
  - Ingress
  - Egress
  # No ingress or egress rules means all traffic is blocked
EOF

# Collect diagnostic data before killing
kubectl describe pod "$POD_NAME" -n "$NAMESPACE" > /tmp/forensics-${POD_NAME}-describe.txt
kubectl logs "$POD_NAME" -n "$NAMESPACE" --all-containers > /tmp/forensics-${POD_NAME}-logs.txt

# Delete the pod (Deployment will recreate a clean one)
kubectl delete pod "$POD_NAME" -n "$NAMESPACE"

echo "Pod quarantined and deleted. Forensics saved to /tmp/forensics-${POD_NAME}-*.txt"
```

## Section 8: Performance Tuning

eBPF security tools add overhead. Tune them to minimize impact on application performance.

### Falco Performance Tuning

```yaml
# falco-values.yaml for production tuning
falco:
  # Buffer between kernel and userspace
  bufferSize: 8388608  # 8MB ring buffer

  # Drop policy: if ring buffer is full, drop events
  dropFailedExit: false

  # Reduce output verbosity
  jsonOutput: true
  jsonIncludeOutputProperty: true
  logLevel: warning

  # Disable expensive rules for high-frequency events
  rules_file:
  - /etc/falco/falco_rules.yaml
  - /etc/falco/falco_rules.local.yaml

  # Disable syscalls not needed for rules (reduces kernel overhead)
  syscall_event_drops:
    actions:
    - log
    - alert
    rate: 0.03333
    max_burst: 10

  # Reduce metrics emission frequency
  metrics:
    enabled: true
    interval: 1m
    output_rule: true
    resource_utilization_enabled: true
    state_counters_enabled: true
    kernel_event_counters_enabled: true
    libbpf_stats_enabled: true
```

```bash
# Monitor Falco drop rate
kubectl exec -n falco ds/falco -- \
    curl -s localhost:8765/metrics | \
    grep falco_drops

# If drop rate > 5%, increase buffer size or reduce rule complexity
```

## Summary

eBPF security tools in Kubernetes provide kernel-level visibility and enforcement that no application-level or admission-webhook approach can match:

**Tetragon** is the best choice when you need enforcement (not just detection) in-kernel. It can SIGKILL processes and drop network connections before they complete, providing true prevention rather than detection-and-react. Use TracingPolicy to define precise, Kubernetes-aware enforcement rules.

**Falco** is the best choice for mature, production-grade detection with an extensive community rule library. Its output routing via Falco Sidekick enables sophisticated alert workflows. Pair with Falco Talon or custom webhooks for automated response.

**Tracee** is the best choice for supply chain security and signature-based detection using OPA policies, with native Prometheus metrics integration.

**Seccomp profiles** provide defense in depth by restricting syscalls at the kernel level before any eBPF program processes them. Use the Security Profiles Operator to manage profiles as Kubernetes resources.

**Incident response** with eBPF data is far richer than with traditional tools. Process lineage, complete network activity, and file access records captured at the kernel level provide the forensic data needed to understand the full scope of a compromise.

The combination of Tetragon (enforcement) + Falco (alerting with rules library) + Seccomp (syscall restriction) provides comprehensive defense across the container lifecycle.
