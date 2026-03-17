---
title: "Linux Namespaces and Cgroups: The Foundation of Container Isolation"
date: 2029-02-27T00:00:00-05:00
draft: false
tags: ["Linux", "Containers", "Namespaces", "cgroups", "Security", "Kernel"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep technical examination of Linux namespaces and cgroups — the kernel primitives that implement container isolation — covering PID, network, mount, user, and IPC namespaces alongside cgroup v2 resource controls for production container environments."
more_link: "yes"
url: "/linux-namespaces-cgroups-container-isolation-enterprise/"
---

Containers are not a single kernel feature — they are a composition of at least six Linux namespace types and the cgroup subsystem. Understanding these primitives is not merely academic: it directly informs how security boundaries are drawn, where isolation breaks down, why container escapes are possible, and how resource limits actually work. Operations teams that understand the underlying kernel mechanisms make better decisions about privilege, seccomp profiles, capability dropping, and resource allocation.

This guide traces the kernel path from a container runtime's `clone()` call through namespace isolation, cgroup resource assignment, and capability management — connecting theory to the concrete behaviors observed in production.

<!--more-->

## What Containers Actually Are

A container runtime (containerd, CRI-O, Docker) creates a container by calling `clone()` with a set of `CLONE_NEW*` flags. Each flag creates a new namespace — an isolated view of a kernel resource. The resulting process and all its children see only the resources visible within their namespaces.

```bash
# View the namespaces of a running container.
# PID 12345 is the init process (PID 1) of a container.
ls -la /proc/12345/ns/

# Output:
# lrwxrwxrwx 1 root root 0 /proc/12345/ns/cgroup -> 'cgroup:[4026531835]'
# lrwxrwxrwx 1 root root 0 /proc/12345/ns/ipc    -> 'ipc:[4026532412]'
# lrwxrwxrwx 1 root root 0 /proc/12345/ns/mnt    -> 'mnt:[4026532410]'
# lrwxrwxrwx 1 root root 0 /proc/12345/ns/net    -> 'net:[4026532414]'
# lrwxrwxrwx 1 root root 0 /proc/12345/ns/pid    -> 'pid:[4026532411]'
# lrwxrwxrwx 1 root root 0 /proc/12345/ns/user   -> 'user:[4026531837]'
# lrwxrwxrwx 1 root root 0 /proc/12345/ns/uts    -> 'uts:[4026532409]'

# If the namespace IDs match the host's init process (PID 1),
# the container shares that namespace with the host.
ls -la /proc/1/ns/

# Compare: a container sharing the host PID namespace (insecure).
# If /proc/12345/ns/pid equals /proc/1/ns/pid, the container is not PID isolated.
```

## PID Namespace

The PID namespace gives each container its own process ID space. PID 1 inside the container is not PID 1 on the host — it is some other PID visible from the host but appearing as PID 1 inside the container.

```bash
# Create a new PID namespace manually (for illustration).
# unshare creates a new process in a new namespace.
sudo unshare --pid --fork --mount-proc /bin/bash

# Inside the new namespace: only one process visible.
ps aux
# Output: only /bin/bash (as PID 1) and the ps command.

# From the host: both processes are visible with their host PIDs.
ps aux | grep bash

# A container's PID 1 receives SIGTERM when the container is stopped.
# If PID 1 does not handle SIGTERM, child processes may be orphaned.
# The tini init system exists specifically to handle this correctly.
```

### PID Namespace Security Implications

Sharing the host PID namespace (`--pid=host` or `hostPID: true` in Kubernetes) allows the container to see and signal all host processes. This is a significant privilege escalation vector.

```yaml
# Kubernetes PodSpec showing the hostPID risk.
apiVersion: v1
kind: Pod
metadata:
  name: debug-pod
  namespace: production
spec:
  # hostPID: true  # DANGEROUS: never use in production except debugging.
  # hostIPC: true  # DANGEROUS: allows shared memory with host.
  # hostNetwork: true  # HIGH RISK: bypasses network namespace isolation.
  containers:
  - name: app
    image: registry.example.com/app:v3.14.2
    securityContext:
      # Run as non-root to limit host interaction even if namespace escapes occur.
      runAsNonRoot: true
      runAsUser: 10000
      runAsGroup: 10000
      # Read-only root filesystem limits the blast radius of a container breakout.
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
      # Drop all capabilities, grant only what is needed.
      capabilities:
        drop: ["ALL"]
        add: ["NET_BIND_SERVICE"]  # Only if the service needs to bind to port < 1024.
```

## Network Namespace

Each container gets its own network stack: its own loopback interface, its own routing table, its own iptables rules, and its own IP address. The container runtime (with help from CNI plugins) creates a veth pair connecting the container's network namespace to a bridge or directly to the host.

```bash
# View network namespaces on a Kubernetes node.
# Each pod's pause container holds the network namespace.
ip netns list

# List veth pairs connecting containers to the host bridge.
ip link show type veth

# Enter a container's network namespace (equivalent to kubectl exec
# but more direct, useful for low-level debugging).
CONTAINER_PID=$(docker inspect --format='{{.State.Pid}}' my-container)
nsenter --target "$CONTAINER_PID" --net ip addr show

# Trace the network path from a container to a service.
nsenter --target "$CONTAINER_PID" --net -- \
  traceroute -T -p 5432 10.96.14.52  # Kubernetes service ClusterIP

# Capture traffic in a container's network namespace.
# Run tcpdump in the container's netns from the host.
nsenter --target "$CONTAINER_PID" --net -- \
  tcpdump -i eth0 -nn -s0 -w /tmp/capture.pcap 'tcp port 8080' &
```

### Network Namespace Internals

```bash
# Create a network namespace manually to understand the mechanics.
ip netns add test-ns

# Create a veth pair: one end in the host, one in the new namespace.
ip link add veth-host type veth peer name veth-ns
ip link set veth-ns netns test-ns

# Configure the host side.
ip addr add 10.200.0.1/24 dev veth-host
ip link set veth-host up

# Configure the container side.
ip netns exec test-ns ip addr add 10.200.0.2/24 dev veth-ns
ip netns exec test-ns ip link set veth-ns up
ip netns exec test-ns ip link set lo up
ip netns exec test-ns ip route add default via 10.200.0.1

# Test connectivity.
ip netns exec test-ns ping -c 1 10.200.0.1

# Clean up.
ip netns del test-ns
ip link del veth-host
```

## Mount Namespace and the Container Filesystem

The mount namespace isolates the filesystem view. Each container sees its own root filesystem — typically a union mount combining multiple OCI layers — without seeing the host filesystem.

```bash
# View a container's mount namespace from the host.
CONTAINER_PID=$(docker inspect --format='{{.State.Pid}}' my-container)
cat /proc/"$CONTAINER_PID"/mounts

# Enter the mount namespace to see the container's filesystem view.
nsenter --target "$CONTAINER_PID" --mount -- ls /

# Compare: the host's view of the same PID's root.
ls /proc/"$CONTAINER_PID"/root/

# A container with a writable root layer can modify its filesystem.
# This is why readOnlyRootFilesystem is a security control — not a performance one.

# Inspect the overlay filesystem that implements the container's layers.
mount | grep overlay
# overlay on /var/lib/containerd/io.containerd.runtime.v2.task/k8s.io/CONTAINER_ID/rootfs
# type overlay (rw,relatime,
#   lowerdir=LAYER1:LAYER2:LAYER3,
#   upperdir=UPPER_DIR,
#   workdir=WORK_DIR)
```

## User Namespace: Privilege Without Privilege

The user namespace is the most powerful namespace for security: it allows a process to be root inside the container while being an unprivileged user on the host. The mapping translates UIDs and GIDs between the container's view and the host's view.

```bash
# Create a user namespace where the current user (UID 1000) appears as root.
unshare --user --map-root-user /bin/bash

# Inside: we appear as root.
id
# uid=0(root) gid=0(root) groups=0(root)

# The mapping from host UID to container UID.
cat /proc/self/uid_map
# 0 1000 1 — container UID 0 maps to host UID 1000 for 1 UID.

# Kubernetes user namespace support (feature gate: UserNamespacesSupport).
# Requires kernel >= 6.3 and runc >= 1.2.
```

```yaml
# Kubernetes Pod with user namespace isolation (Kubernetes 1.30+).
apiVersion: v1
kind: Pod
metadata:
  name: user-ns-pod
  namespace: production
spec:
  hostUsers: false  # Enable user namespace isolation.
  containers:
  - name: app
    image: registry.example.com/app:v3.14.2
    securityContext:
      runAsUser: 0  # Appears as root inside, maps to unprivileged UID on host.
```

## cgroups v2: Resource Control

The control groups subsystem limits, accounts, and isolates resource usage. cgroups v2 introduces a unified hierarchy where all resource controllers operate on the same tree.

```bash
# View the cgroup hierarchy for a Kubernetes pod.
# Kubernetes organizes pods under /sys/fs/cgroup/kubepods/.
find /sys/fs/cgroup/kubepods -name 'cpu.max' | head -10

# Identify which cgroup a process belongs to.
cat /proc/$(pgrep -n nginx)/cgroup
# 0::/kubepods/burstable/pod4a8e0b62-3c9f-4d71-a7c2-8e1f0d3b9e4c/app-container

# View resource limits for a container cgroup.
CGROUP=/sys/fs/cgroup/kubepods/burstable/pod4a8e0b62-3c9f-4d71-a7c2-8e1f0d3b9e4c/app-container

echo "CPU max (quota/period in µs):"
cat "${CGROUP}/cpu.max"

echo "Memory max (bytes):"
cat "${CGROUP}/memory.max"

echo "Memory swap max:"
cat "${CGROUP}/memory.swap.max"

echo "CPU weight (relative priority):"
cat "${CGROUP}/cpu.weight"

echo "Current memory usage:"
cat "${CGROUP}/memory.current"

echo "Memory events (OOM, etc.):"
cat "${CGROUP}/memory.events"
```

### Memory Controller: OOM Behavior

```bash
# Monitor OOM kill events across all containers.
# The kernel logs OOM kills to dmesg with the container's cgroup path.
dmesg -w | grep -E 'oom_kill|Out of memory'

# View memory statistics for a container's cgroup.
cat /sys/fs/cgroup/kubepods/burstable/pod4a8e0b62/app/memory.stat

# Key fields in memory.stat:
# anon: anonymous memory (heap, stack)
# file: page cache
# kernel_stack: kernel stack for this cgroup's threads
# pagetables: page table entries
# slab: kernel slab allocations
# pgfault: total page faults
# pgmajfault: major page faults (disk reads)

# Simulate OOM pressure to test container behavior.
# stress-ng can allocate memory to trigger the OOM killer.
kubectl run oom-test --image=alexeiled/stress-ng --rm -it \
  --limits='memory=128Mi' -- stress-ng --vm 1 --vm-bytes 200M --timeout 30s

# Check whether the container was OOM killed.
kubectl describe pod oom-test | grep -A 5 'OOMKilled'
```

### CPU Controller: Bandwidth and Weight

```bash
# The cpu.max file format: "quota period" in microseconds.
# "max 100000" = unlimited CPU.
# "50000 100000" = 0.5 CPU (50% of each 100ms period).

# Set a CPU limit of 0.5 cores on a cgroup directly.
echo "50000 100000" > /sys/fs/cgroup/mygroup/cpu.max

# Monitor CPU throttling in real time with bpftrace.
bpftrace -e '
tracepoint:cgroup:cgroup_throttled {
    @throttled_ns[comm] = sum(args->throttled_time_ns);
}
interval:s:5 {
    print(@throttled_ns);
    clear(@throttled_ns);
}
'

# View psi (Pressure Stall Information) for CPU in a cgroup.
# PSI is available in kernel >= 4.20 and provides fine-grained resource pressure metrics.
cat /sys/fs/cgroup/kubepods/burstable/pod4a8e0b62/app/cpu.pressure
# some avg10=0.05 avg60=0.10 avg300=0.02 total=482347839
# full avg10=0.00 avg60=0.01 avg300=0.00 total=98734523
#
# "some" = at least one task is stalled
# "full" = all non-idle tasks are stalled
# avg10/60/300 = exponentially weighted moving average over 10s, 60s, 300s
```

## seccomp: Syscall Filtering

seccomp (secure computing mode) is the third pillar of container isolation alongside namespaces and cgroups. It filters which system calls a container is allowed to make.

```bash
# View the seccomp profile of a running container.
grep Seccomp /proc/$(pgrep -n nginx)/status
# Seccomp: 2  (0=disabled, 1=strict, 2=filter)

# Check which syscalls are blocked by the default seccomp profile.
strace -c -e trace=all sleep 1 2>&1 | grep -v 'No such'
```

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "access", "adjtimex", "alarm", "bind",
        "brk", "capget", "capset", "chdir", "chmod", "chown",
        "clock_getres", "clock_gettime", "clock_nanosleep",
        "close", "connect", "copy_file_range", "creat",
        "dup", "dup2", "dup3", "epoll_create", "epoll_create1",
        "epoll_ctl", "epoll_pwait", "epoll_wait",
        "eventfd", "eventfd2", "execve", "execveat", "exit", "exit_group",
        "faccessat", "fadvise64", "fallocate", "fanotify_mark",
        "fchdir", "fchmod", "fchmodat", "fchown", "fchownat",
        "fcntl", "fdatasync", "fgetxattr", "flistxattr",
        "flock", "fork", "fsetxattr", "fstat", "fstatfs",
        "fsync", "ftruncate", "futex", "getcpu",
        "getdents", "getdents64", "getegid", "geteuid", "getgid",
        "getgroups", "getitimer", "getpeername", "getpgid",
        "getpgrp", "getpid", "getppid", "getpriority",
        "getrandom", "getresgid", "getresuid", "getrlimit",
        "get_robust_list", "getrusage", "getsid", "getsockname",
        "getsockopt", "gettid", "gettimeofday", "getuid",
        "getxattr", "inotify_add_watch", "inotify_init",
        "inotify_init1", "inotify_rm_watch", "io_cancel",
        "ioctl", "io_destroy", "io_getevents", "io_setup",
        "io_submit", "kill", "lchown", "lgetxattr",
        "link", "linkat", "listen", "listxattr", "llistxattr",
        "lremovexattr", "lseek", "lsetxattr", "lstat",
        "madvise", "memfd_create", "mincore", "mkdir", "mkdirat",
        "mlock", "mlock2", "mlockall", "mmap", "mprotect",
        "mq_getsetattr", "mq_notify", "mq_open", "mq_timedreceive",
        "mq_timedsend", "mq_unlink", "mremap", "msgctl",
        "msgget", "msgrcv", "msgsnd", "msync", "munlock",
        "munlockall", "munmap", "nanosleep", "newfstatat",
        "open", "openat", "pause", "pipe", "pipe2", "poll",
        "ppoll", "prctl", "pread64", "preadv", "preadv2",
        "prlimit64", "pselect6", "ptrace", "pwrite64",
        "pwritev", "pwritev2", "read", "readahead", "readlink",
        "readlinkat", "readv", "reboot", "recv", "recvfrom",
        "recvmmsg", "recvmsg", "remap_file_pages",
        "removexattr", "rename", "renameat", "renameat2",
        "restart_syscall", "rmdir", "rt_sigaction",
        "rt_sigpending", "rt_sigprocmask", "rt_sigqueueinfo",
        "rt_sigreturn", "rt_sigsuspend", "rt_sigtimedwait",
        "rt_tgsigqueueinfo", "sched_getaffinity", "sched_getattr",
        "sched_getparam", "sched_get_priority_max",
        "sched_get_priority_min", "sched_getscheduler",
        "sched_setaffinity", "sched_setattr", "sched_setparam",
        "sched_setscheduler", "sched_yield", "select",
        "semctl", "semget", "semop", "semtimedop", "send",
        "sendfile", "sendmmsg", "sendmsg", "sendto",
        "setfsgid", "setfsuid", "setgid", "setgroups",
        "setitimer", "setpgid", "setpriority", "setregid",
        "setresgid", "setresuid", "setreuid", "setsid",
        "setsockopt", "setuid", "setxattr", "shmat",
        "shmctl", "shmdt", "shmget", "shutdown",
        "sigaltstack", "signalfd", "signalfd4", "socket",
        "socketpair", "splice", "stat", "statfs", "statx",
        "symlink", "symlinkat", "sync", "sync_file_range",
        "syncfs", "sysinfo", "tee", "tgkill", "time",
        "timer_create", "timer_delete", "timer_getoverrun",
        "timer_gettime", "timer_settime", "timerfd_create",
        "timerfd_gettime", "timerfd_settime", "times",
        "tkill", "truncate", "uname", "unlink", "unlinkat",
        "utime", "utimensat", "utimes", "vfork", "vmsplice",
        "wait4", "waitid", "waitpid", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

## Verifying Container Isolation

```bash
# Check all namespace isolation for a container.
CONTAINER_PID=$(docker inspect --format='{{.State.Pid}}' my-container)
HOST_PID=1

echo "=== Namespace Isolation Analysis ==="
for ns in cgroup ipc mnt net pid user uts; do
    CONTAINER_NS=$(readlink /proc/"$CONTAINER_PID"/ns/"$ns" | grep -o '\[.*\]')
    HOST_NS=$(readlink /proc/"$HOST_PID"/ns/"$ns" | grep -o '\[.*\]')
    if [ "$CONTAINER_NS" = "$HOST_NS" ]; then
        echo "SHARED: $ns namespace (security risk)"
    else
        echo "ISOLATED: $ns namespace ($CONTAINER_NS vs $HOST_NS)"
    fi
done

# Check Linux capabilities granted to the container.
grep CapEff /proc/"$CONTAINER_PID"/status | \
  awk '{print $2}' | \
  while read -r cap_hex; do
    python3 -c "
import sys
cap_hex = '$cap_hex'
caps = int(cap_hex, 16)
cap_names = {
    0: 'CAP_CHOWN', 1: 'CAP_DAC_OVERRIDE', 2: 'CAP_DAC_READ_SEARCH',
    3: 'CAP_FOWNER', 4: 'CAP_FSETID', 5: 'CAP_KILL',
    6: 'CAP_SETGID', 7: 'CAP_SETUID', 8: 'CAP_SETPCAP',
    9: 'CAP_LINUX_IMMUTABLE', 10: 'CAP_NET_BIND_SERVICE',
    11: 'CAP_NET_BROADCAST', 12: 'CAP_NET_ADMIN', 13: 'CAP_NET_RAW',
    14: 'CAP_IPC_LOCK', 15: 'CAP_IPC_OWNER', 16: 'CAP_SYS_MODULE',
    17: 'CAP_SYS_RAWIO', 18: 'CAP_SYS_CHROOT', 19: 'CAP_SYS_PTRACE',
    20: 'CAP_SYS_PACCT', 21: 'CAP_SYS_ADMIN', 22: 'CAP_SYS_BOOT',
    23: 'CAP_SYS_NICE', 24: 'CAP_SYS_RESOURCE', 25: 'CAP_SYS_TIME',
    26: 'CAP_SYS_TTY_CONFIG', 27: 'CAP_MKNOD', 28: 'CAP_LEASE',
    29: 'CAP_AUDIT_WRITE', 30: 'CAP_AUDIT_CONTROL', 31: 'CAP_SETFCAP',
}
enabled = [cap_names.get(i, f'CAP_{i}') for i in range(64) if caps & (1 << i)]
print('Effective capabilities:', ', '.join(enabled) if enabled else 'none')
"
  done
```

## Pod Security Standards

Kubernetes Pod Security Standards encode namespace and capability best practices into admission policy.

```yaml
# Apply the restricted Pod Security Standard to a namespace.
# This enforces the most secure container configuration.
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

The restricted standard requires:
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `seccompProfile.type: RuntimeDefault` or `Localhost`
- `capabilities.drop: ["ALL"]`
- No `hostPID`, `hostIPC`, or `hostNetwork`
- `readOnlyRootFilesystem: true` (recommended)

Understanding Linux namespaces and cgroups transforms container security from a checklist exercise into a principled practice. When the threat model of each namespace type is clear, security controls — capability dropping, seccomp profiles, read-only filesystems, user namespaces — can be applied with understanding rather than cargo-culted from configuration examples.
