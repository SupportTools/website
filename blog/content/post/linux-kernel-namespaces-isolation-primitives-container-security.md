---
title: "Linux Kernel Namespaces: Isolation Primitives Behind Container Security"
date: 2030-08-14T00:00:00-05:00
draft: false
tags: ["Linux", "Namespaces", "Containers", "Security", "Kernel", "Docker", "Kubernetes"]
categories:
- Linux
- Security
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux namespaces: PID, network, mount, UTS, IPC, user, cgroup, and time namespaces; unshare and nsenter tools; namespace manipulation in Go; container breakout concepts and defenses; and kernel namespace limitations."
more_link: "yes"
url: "/linux-kernel-namespaces-isolation-primitives-container-security/"
---

Linux namespaces are the kernel mechanism that makes containers possible. Every process runs inside a set of namespaces that define its view of the system: which process IDs are visible, which network interfaces exist, what the hostname is, and which filesystem hierarchy is mounted. Container runtimes like containerd and crun compose multiple namespaces to create an isolated execution environment that shares a kernel with the host while appearing to each container as though it has exclusive access to the system.

<!--more-->

## Namespace Types

Linux 6.x supports eight namespace types, each isolating a different aspect of the system:

| Namespace | Flag | Isolates |
|---|---|---|
| PID | `CLONE_NEWPID` | Process ID tree |
| Network | `CLONE_NEWNET` | Network stack, interfaces, routing |
| Mount | `CLONE_NEWNS` | Filesystem mount points |
| UTS | `CLONE_NEWUTS` | Hostname and NIS domain name |
| IPC | `CLONE_NEWIPC` | SysV IPC, POSIX message queues |
| User | `CLONE_NEWUSER` | UID/GID mappings |
| Cgroup | `CLONE_NEWCGROUP` | Cgroup root |
| Time | `CLONE_NEWTIME` | System clocks (CLOCK_MONOTONIC, CLOCK_BOOTTIME) |

Namespaces are created with three system calls: `clone(2)` (create process in new namespace), `unshare(2)` (move calling process to new namespace), and `setns(2)` (join an existing namespace via a file descriptor).

---

## PID Namespaces

A PID namespace creates an independent PID number space. The first process spawned in a new PID namespace gets PID 1 — analogous to init/systemd on a full Linux system. If this PID-1 process exits, all other processes in the namespace are killed.

### Nested PID Namespaces

PID namespaces are hierarchical. A process has a PID in every namespace from its own to the initial (host) namespace. The host can see all PIDs; a container's PID namespace can only see its own processes.

```bash
# Create a new PID namespace and run bash inside it
sudo unshare --pid --fork --mount-proc bash

# Inside the new namespace, process list is isolated
ps aux
# USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
# root         1  0.0  0.0  24364  4016 pts/0    S    10:00   0:00 bash
# root         8  0.0  0.0  42776  3756 pts/0    R+   10:00   0:00 ps aux
```

### Inspecting PID Namespaces

```bash
# Find the namespace inode for a running process
ls -la /proc/1234/ns/pid
# lrwxrwxrwx 1 root root 0 Aug 14 10:00 /proc/1234/ns/pid -> pid:[4026531836]

# List all PID namespaces on the system
lsns -t pid
# NS TYPE   NPROCS   PID USER     COMMAND
# 4026531836 pid     312   1 root     /sbin/init
# 4026532193 pid       3 1001 ubuntu   bash
```

---

## Network Namespaces

Network namespaces isolate the entire network stack: interfaces, routing tables, iptables rules, and sockets. Each network namespace starts with only a loopback interface. Container runtimes create a veth pair — a virtual ethernet cable with one end in the container network namespace and the other in the host namespace or a bridge.

### Manual Network Namespace Setup

```bash
# Create two network namespaces
ip netns add ns1
ip netns add ns2

# Create a veth pair
ip link add veth0 type veth peer name veth1

# Move each end into a namespace
ip link set veth0 netns ns1
ip link set veth1 netns ns2

# Configure IP addresses
ip netns exec ns1 ip addr add 10.0.0.1/24 dev veth0
ip netns exec ns2 ip addr add 10.0.0.2/24 dev veth1

# Bring interfaces up
ip netns exec ns1 ip link set veth0 up
ip netns exec ns1 ip link set lo up
ip netns exec ns2 ip link set veth1 up
ip netns exec ns2 ip link set lo up

# Test connectivity
ip netns exec ns1 ping -c 3 10.0.0.2
```

### Container CNI Network Setup Flow

```
Host Network Namespace
    │
    ├── eth0 (physical NIC)
    ├── cni0 (bridge: 10.244.0.1/24)
    │     ├── vethXXXXXX ◄──► eth0 in container ns (10.244.0.5/24)
    │     └── vethYYYYYY ◄──► eth0 in container ns (10.244.0.6/24)
    └── iptables rules for MASQUERADE, DNAT
```

---

## Mount Namespaces

Mount namespaces isolate the filesystem view. Each namespace has its own mount table. Changes in one namespace's mount table — mounting, unmounting, bind-mounts — are invisible to other namespaces unless mount propagation is configured.

### Mount Propagation Modes

| Mode | Description |
|---|---|
| `shared` | Events propagate to and from peer group |
| `slave` | Receives events from master, does not propagate outward |
| `private` | No propagation in either direction |
| `unbindable` | Private, and cannot be bind-mounted |

```bash
# Create a private namespace where host mounts are not visible
sudo unshare --mount bash

# Inside the new namespace, make the root mount private
mount --make-rprivate /

# Now mount something — it won't appear on the host
mount -t tmpfs tmpfs /tmp/isolated
ls /tmp/isolated  # visible here

# On the host in another terminal, /tmp/isolated is not mounted
cat /proc/mounts | grep isolated  # empty
```

### Overlay Filesystem for Container Layers

Container images use overlayfs, which composes multiple mount namespace layers:

```bash
# Create layer directories
mkdir -p /var/lib/overlay/{lower,upper,work,merged}

# Mount an overlay combining a read-only base (lower) with a writable layer (upper)
mount -t overlay overlay \
    -o lowerdir=/var/lib/overlay/lower,\
upperdir=/var/lib/overlay/upper,\
workdir=/var/lib/overlay/work \
    /var/lib/overlay/merged

# Writes go to upper, reads come from upper (if present) or lower
echo "container data" > /var/lib/overlay/merged/file.txt
ls /var/lib/overlay/upper/  # file.txt
ls /var/lib/overlay/lower/  # file.txt not here
```

---

## User Namespaces

User namespaces are the most powerful and most dangerous namespace type. They allow a process to have UID 0 (root) inside the namespace while being mapped to an unprivileged UID outside. This is the mechanism that enables rootless containers.

### UID/GID Mapping

```bash
# Create a user namespace as an unprivileged user
unshare --user --map-root-user bash

# Inside the namespace, whoami returns root
whoami
# root

# But from the host, the process runs as the original user
# /proc/<pid>/uid_map contains the mapping:
# 0 1001 1
# (namespace uid 0 maps to host uid 1001, count 1)
cat /proc/self/uid_map
```

### Rootless Container Security Model

In rootless containers, the container's UID 0 maps to an unprivileged host UID. If a process escapes the container's mount namespace, it finds itself as an unprivileged user on the host — severely limiting the blast radius of a container breakout.

```bash
# /etc/subuid and /etc/subgid define the subordinate UID ranges for each user
cat /etc/subuid
# ubuntu:100000:65536

# This means user 'ubuntu' can use UIDs 100000 through 165535 in user namespaces
```

---

## UTS Namespaces

UTS (UNIX Time-Sharing) namespaces isolate the hostname and NIS domain name. Containers use a UTS namespace to have their own hostname independent of the host.

```bash
# Create a UTS namespace with a custom hostname
sudo unshare --uts bash
hostname container-1
hostname  # returns container-1

# Host hostname unchanged in another terminal
hostname  # returns original host hostname
```

---

## IPC Namespaces

IPC namespaces isolate System V IPC objects (semaphores, message queues, shared memory) and POSIX message queues. Two processes in different IPC namespaces cannot communicate via these mechanisms even with the same IPC key.

```bash
# Create an IPC namespace
sudo unshare --ipc bash

# Create a shared memory segment
ipcmk -M 65536
# Shared memory id: 0

ipcs -m
# ------ Shared Memory Segments --------
# key        shmid      owner      perms      bytes      nattch

# The segment is invisible on the host (different IPC namespace)
```

---

## Cgroup Namespaces

Cgroup namespaces virtualize the process's view of the cgroup hierarchy. A process inside a cgroup namespace sees its root cgroup as `/`, hiding the full host cgroup path. This prevents containers from discovering the host's cgroup layout.

```bash
# View cgroup membership inside a container
cat /proc/self/cgroup
# 0::/

# On the host, the full path is visible
cat /proc/<container-pid>/cgroup
# 0::/system.slice/containerd.service/.../pod-abc123.slice/container-xyz.scope
```

---

## Time Namespaces

Time namespaces (added in Linux 5.6) allow a container to have a different offset for `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` clocks. This enables checkpoint/restore scenarios where a container that was suspended can resume with the correct elapsed time.

```bash
# The timens_offsets file controls per-namespace clock offsets
# This is typically managed by CRIU (Checkpoint/Restore in Userspace)
cat /proc/self/timens_offsets
# monotonic           0         0
# boottime            0         0
```

---

## Namespace Manipulation in Go

### Creating a New Network Namespace in Go

```go
// pkg/netns/create.go
package netns

import (
    "fmt"
    "os"
    "path/filepath"
    "runtime"

    "golang.org/x/sys/unix"
)

// CreateNamed creates a named network namespace at /var/run/netns/<name>.
// The caller must have CAP_SYS_ADMIN.
func CreateNamed(name string) error {
    nsPath := filepath.Join("/var/run/netns", name)

    // Ensure the bind mount target exists
    f, err := os.Create(nsPath)
    if err != nil {
        return fmt.Errorf("creating bind mount target %s: %w", nsPath, err)
    }
    f.Close()

    // Lock OS thread to prevent goroutine migration
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Save the current network namespace
    curNS, err := os.Open("/proc/self/ns/net")
    if err != nil {
        return fmt.Errorf("opening current netns: %w", err)
    }
    defer curNS.Close()

    // Create a new network namespace by calling unshare
    if err := unix.Unshare(unix.CLONE_NEWNET); err != nil {
        return fmt.Errorf("unsharing network namespace: %w", err)
    }

    // Bind-mount the new namespace to make it persistent
    if err := unix.Mount("/proc/self/ns/net", nsPath, "bind", unix.MS_BIND, ""); err != nil {
        return fmt.Errorf("bind mounting namespace: %w", err)
    }

    // Return to original namespace
    if err := unix.Setns(int(curNS.Fd()), unix.CLONE_NEWNET); err != nil {
        return fmt.Errorf("returning to original netns: %w", err)
    }

    return nil
}
```

### Entering an Existing Namespace

```go
// pkg/netns/enter.go
package netns

import (
    "fmt"
    "path/filepath"
    "runtime"

    "golang.org/x/sys/unix"
)

// InNamespace executes fn within the named network namespace.
func InNamespace(name string, fn func() error) error {
    nsPath := filepath.Join("/var/run/netns", name)

    // Lock thread to prevent migration to a different OS thread
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Save the current namespace
    origFD, err := unix.Open("/proc/self/ns/net", unix.O_RDONLY|unix.O_CLOEXEC, 0)
    if err != nil {
        return fmt.Errorf("opening current namespace: %w", err)
    }
    defer unix.Close(origFD)

    // Open and enter the target namespace
    targetFD, err := unix.Open(nsPath, unix.O_RDONLY|unix.O_CLOEXEC, 0)
    if err != nil {
        return fmt.Errorf("opening target namespace %s: %w", nsPath, err)
    }
    defer unix.Close(targetFD)

    if err := unix.Setns(targetFD, unix.CLONE_NEWNET); err != nil {
        return fmt.Errorf("entering namespace %s: %w", nsPath, err)
    }

    fnErr := fn()

    // Restore original namespace
    if err := unix.Setns(origFD, unix.CLONE_NEWNET); err != nil {
        return fmt.Errorf("restoring original namespace: %w", err)
    }

    return fnErr
}
```

---

## unshare and nsenter Tools

### unshare Examples

```bash
# Create a new UTS + PID + network namespace as root
sudo unshare --uts --pid --net --fork bash

# Create user namespace as unprivileged user (no root required)
unshare --user --map-root-user bash

# Create a namespace with a new mount and run a command
sudo unshare --mount --propagation private -- \
    sh -c 'mount -t tmpfs tmpfs /mnt && echo "isolated mount"'
```

### nsenter Examples

```bash
# Enter all namespaces of a running container (get PID from docker inspect)
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' my-container)

# Enter all namespaces
sudo nsenter --target "$CONTAINER_PID" \
    --mount --uts --ipc --net --pid -- bash

# Enter only the network namespace (useful for network debugging)
sudo nsenter --target "$CONTAINER_PID" --net -- ip addr show

# Enter the mount namespace to access the container filesystem
sudo nsenter --target "$CONTAINER_PID" --mount -- ls /etc
```

---

## Container Breakout Concepts and Defenses

### Privileged Container Risk

A container running with `--privileged` receives all Linux capabilities and access to all devices. An attacker inside such a container can mount the host filesystem and escape:

```bash
# Inside a privileged container — DO NOT RUN in production
# This demonstrates why privileged mode is dangerous

# List block devices (visible because of all-device access)
fdisk -l

# Mount the host root filesystem
mkdir /host-root
mount /dev/sda1 /host-root

# Now the entire host filesystem is accessible
ls /host-root/etc/shadow  # host credentials visible
```

**Defense**: Never run containers with `--privileged`. Use specific capability grants instead:

```yaml
# Kubernetes Pod Security — drop all capabilities, add only what is needed
securityContext:
  capabilities:
    drop:
      - ALL
    add:
      - NET_BIND_SERVICE   # Only if binding to ports < 1024
```

### runc CVE-2019-5736 Class Exploits

The runc container escape (CVE-2019-5736) exploited the fact that runc opened the container's `/proc/self/exe` to re-execute itself, allowing a malicious container to overwrite the runc binary on the host.

**Defenses**:
- Keep container runtime versions current
- Use seccomp profiles to restrict syscalls
- Use AppArmor or SELinux profiles
- Consider gVisor or Kata Containers for stronger isolation

### User Namespace Privilege Escalation

If user namespaces are enabled for unprivileged users, certain kernel vulnerabilities allow privilege escalation from inside a user namespace to the host. On enterprise systems, restrict user namespace creation:

```bash
# Restrict unprivileged user namespace creation (Debian/Ubuntu)
sysctl -w kernel.unprivileged_userns_clone=0
echo "kernel.unprivileged_userns_clone=0" >> /etc/sysctl.d/99-namespaces.conf
```

---

## Namespace Limitations

### No Isolation of

- **Time**: The system call `time(2)` always returns wall clock time (though time namespaces partially address `CLOCK_MONOTONIC`)
- **Kernel modules**: Any process with CAP_SYS_MODULE can load kernel modules host-wide
- **Kernel keyring**: The kernel keyring (`keyctl`) is partially namespace-aware but not fully isolated
- **Raw socket access**: Processes with CAP_NET_RAW in any network namespace can sniff traffic within that namespace

### Namespace File Descriptor Lifetime

Namespaces persist as long as:
1. At least one process is running in them, OR
2. A bind mount to `/proc/<pid>/ns/<type>` or `/var/run/netns/<name>` exists

Forgetting to unmount bind-mounted namespaces leads to namespace leaks:

```bash
# Check for leaked namespaces
lsns | grep -v "^4026531"  # 4026531xxx are the initial namespaces

# Clean up stale network namespaces
ip netns list
ip netns delete stale-ns-name
```

---

## Seccomp: Syscall Filtering Complementing Namespaces

Namespaces isolate resources but do not restrict which system calls a process can make. Seccomp-BPF provides syscall filtering:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "close", "stat", "fstat",
        "mmap", "mprotect", "munmap", "brk", "rt_sigaction",
        "rt_sigprocmask", "rt_sigreturn", "ioctl", "pread64",
        "pwrite64", "readv", "writev", "access", "pipe",
        "select", "sched_yield", "mremap", "msync", "mincore",
        "madvise", "shmget", "shmat", "shmctl", "dup", "dup2",
        "pause", "nanosleep", "getitimer", "alarm", "setitimer",
        "getpid", "sendfile", "socket", "connect", "accept",
        "sendto", "recvfrom", "sendmsg", "recvmsg", "shutdown",
        "bind", "listen", "getsockname", "getpeername",
        "socketpair", "setsockopt", "getsockopt", "clone",
        "fork", "vfork", "execve", "exit", "wait4", "kill",
        "uname", "fcntl", "flock", "fsync", "fdatasync",
        "truncate", "ftruncate", "getdents", "getcwd", "chdir",
        "fchdir", "rename", "mkdir", "rmdir", "creat", "link",
        "unlink", "symlink", "readlink", "chmod", "fchmod",
        "chown", "fchown", "lchown", "umask", "gettimeofday",
        "getrlimit", "getrusage", "sysinfo", "times", "getuid",
        "getgid", "setuid", "setgid", "geteuid", "getegid",
        "getppid", "getpgrp", "setsid", "setreuid", "setregid",
        "getgroups", "setgroups", "setresuid", "getresuid",
        "setresgid", "getresgid", "getpgid", "setfsuid",
        "setfsgid", "getsid", "capget", "capset", "sigaltstack",
        "utime", "mknod", "uselib", "personality", "ustat",
        "statfs", "fstatfs", "sysfs", "getpriority", "setpriority",
        "sched_setparam", "sched_getparam", "sched_setscheduler",
        "sched_getscheduler", "sched_get_priority_max",
        "sched_get_priority_min", "sched_rr_get_interval",
        "mlock", "munlock", "mlockall", "munlockall", "vhangup",
        "pivot_root", "prctl", "arch_prctl", "adjtimex",
        "setrlimit", "chroot", "sync", "acct", "settimeofday",
        "mount", "umount2", "swapon", "swapoff", "reboot",
        "sethostname", "setdomainname", "iopl", "ioperm",
        "create_module", "init_module", "delete_module",
        "get_kernel_syms", "query_module", "quotactl",
        "nfsservctl", "getpmsg", "putpmsg", "afs_syscall",
        "tuxcall", "security", "gettid", "readahead",
        "setxattr", "lsetxattr", "fsetxattr", "getxattr",
        "lgetxattr", "fgetxattr", "listxattr", "llistxattr",
        "flistxattr", "removexattr", "lremovexattr",
        "fremovexattr", "tkill", "time", "futex", "sched_setaffinity",
        "sched_getaffinity", "epoll_create", "epoll_ctl_old",
        "epoll_wait_old", "remap_file_pages", "getdents64",
        "set_tid_address", "restart_syscall", "semtimedop",
        "fadvise64", "timer_create", "timer_settime", "timer_gettime",
        "timer_getoverrun", "timer_delete", "clock_settime",
        "clock_gettime", "clock_getres", "clock_nanosleep",
        "exit_group", "epoll_wait", "epoll_ctl", "tgkill",
        "utimes", "mbind", "set_mempolicy", "get_mempolicy",
        "mq_open", "mq_unlink", "mq_timedsend", "mq_timedreceive",
        "mq_notify", "mq_getsetattr", "kexec_load", "waitid",
        "add_key", "request_key", "keyctl", "ioprio_set",
        "ioprio_get", "inotify_init", "inotify_add_watch",
        "inotify_rm_watch", "openat", "mkdirat", "mknodat",
        "fchownat", "futimesat", "newfstatat", "unlinkat",
        "renameat", "linkat", "symlinkat", "readlinkat",
        "fchmodat", "faccessat", "pselect6", "ppoll",
        "unshare", "set_robust_list", "get_robust_list",
        "splice", "tee", "sync_file_range", "vmsplice",
        "move_pages", "utimensat", "epoll_pwait",
        "signalfd", "timerfd_create", "eventfd",
        "fallocate", "timerfd_settime", "timerfd_gettime",
        "accept4", "signalfd4", "eventfd2", "epoll_create1",
        "dup3", "pipe2", "inotify_init1", "preadv", "pwritev",
        "rt_tgsigqueueinfo", "perf_event_open", "recvmmsg",
        "fanotify_init", "fanotify_mark", "prlimit64",
        "name_to_handle_at", "open_by_handle_at", "clock_adjtime",
        "syncfs", "sendmmsg", "setns", "getcpu",
        "process_vm_readv", "process_vm_writev",
        "kcmp", "finit_module", "sched_setattr", "sched_getattr",
        "renameat2", "seccomp", "getrandom", "memfd_create",
        "kexec_file_load", "bpf", "execveat", "userfaultfd",
        "membarrier", "mlock2", "copy_file_range", "preadv2",
        "pwritev2", "pkey_mprotect", "pkey_alloc", "pkey_free",
        "statx", "io_pgetevents", "rseq", "pidfd_send_signal",
        "io_uring_setup", "io_uring_enter", "io_uring_register",
        "open_tree", "move_mount", "fsopen", "fsconfig",
        "fsmount", "fspick", "pidfd_open", "clone3",
        "close_range", "openat2", "pidfd_getfd", "faccessat2",
        "process_madvise", "epoll_pwait2", "mount_setattr",
        "quotactl_fd", "landlock_create_ruleset",
        "landlock_add_rule", "landlock_restrict_self",
        "memfd_secret", "process_mrelease"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

---

## Conclusion

Linux namespaces form the foundational isolation layer of every container runtime. Understanding how PID, network, mount, user, UTS, IPC, cgroup, and time namespaces work individually — and how container runtimes compose them — is essential for designing secure container deployments, debugging container networking problems, and understanding the security implications of privileged containers and container escape vulnerabilities. For production Kubernetes environments, namespaces should be combined with seccomp profiles, AppArmor/SELinux mandatory access control, and careful capability management to achieve defense in depth.
