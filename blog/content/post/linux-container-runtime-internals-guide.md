---
title: "Container Runtime Internals: containerd, runc, and the OCI Specification"
date: 2028-02-15T00:00:00-05:00
draft: false
tags: ["Containers", "containerd", "runc", "OCI", "Linux", "Security", "Kubernetes"]
categories:
- Containers
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into container runtime internals covering OCI specifications, containerd shim architecture, runc lifecycle management, cgroups v2, Linux namespaces, seccomp, and AppArmor/SELinux integration."
more_link: "yes"
url: "/linux-container-runtime-internals-guide/"
---

Understanding container runtime internals is essential for platform engineers who need to debug deep failures, optimize container startup performance, implement security controls below the Kubernetes API, and make informed decisions when evaluating runtime alternatives. The modern container stack involves at least three abstraction layers between a Kubernetes pod spec and an actual Linux process, and each layer has distinct responsibilities, failure modes, and configuration surfaces.

This guide examines the complete runtime stack from the OCI specification through containerd's architecture to runc's process lifecycle, covering the Linux kernel primitives—namespaces, cgroups v2, seccomp, AppArmor—that make container isolation possible.

<!--more-->

# Container Runtime Internals: containerd, runc, and the OCI Specification

## The Container Runtime Stack

The container runtime stack in a modern Kubernetes cluster has four principal layers:

```
┌─────────────────────────────────────┐
│         kubelet (Kubernetes)        │
│  Container Runtime Interface (CRI)  │
├─────────────────────────────────────┤
│       containerd (High-level RT)    │
│  Manages images, snapshots, tasks   │
├─────────────────────────────────────┤
│    containerd-shim-runc-v2          │
│  Per-container process supervisor   │
├─────────────────────────────────────┤
│         runc (Low-level RT)         │
│  Creates namespaces, cgroups,       │
│  executes container process         │
└─────────────────────────────────────┘
```

Each layer communicates through well-defined interfaces: kubelet uses CRI (gRPC), containerd manages shims via the Task API, and shims invoke runc via OCI Runtime Specification calls.

## The OCI Specification

The Open Container Initiative (OCI) defines two specifications that underpin all conformant runtimes.

### OCI Image Specification

An OCI image is a content-addressable artifact consisting of a manifest, an image index, a configuration, and one or more layers:

```json
// OCI image manifest (stored in registry)
// Each field is content-addressed by SHA256 digest
{
  "schemaVersion": 2,
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "config": {
    "mediaType": "application/vnd.oci.image.config.v1+json",
    // SHA256 digest of the image configuration blob
    "digest": "sha256:b5b2b2c507a0944348e0303114d8d93aaaa081732b86451d9bce1f432a537bc7",
    "size": 7023
  },
  "layers": [
    {
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      // Each layer is a tar archive of filesystem changes
      "digest": "sha256:e7c96db7181be991f19a9fb6975cdbbd73c65f4a2681348e63a141a2192a5f10",
      "size": 26688247
    },
    {
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "digest": "sha256:f910a506b6cb1dbec766725d70356f695ae2bf2bea6224dbe8c7c6ad4f3664a2",
      "size": 149
    }
  ]
}
```

```json
// OCI image configuration (the image config blob)
// Defines the execution environment and metadata
{
  "architecture": "amd64",
  "os": "linux",
  "config": {
    "Env": [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    ],
    "Entrypoint": ["/bin/server"],
    "Cmd": ["--config", "/etc/config.yaml"],
    "ExposedPorts": {
      "8080/tcp": {}
    },
    "WorkingDir": "/app",
    "User": "1000:1000"
  },
  "rootfs": {
    "type": "layers",
    "diff_ids": [
      // Uncompressed layer digests (used for verification)
      "sha256:5216338b40a7b96416b8b9858974bbe4acc3096ee60acbc4dfb1ee02aecceb10"
    ]
  },
  "history": [
    {
      "created": "2024-01-15T00:00:00Z",
      "created_by": "/bin/sh -c #(nop) ADD file:... in /",
      "empty_layer": false
    }
  ]
}
```

### OCI Runtime Specification

The OCI Runtime Specification defines the `config.json` file that runc reads to create a container. Understanding this spec reveals the full extent of container configuration:

```json
// config.json - OCI Runtime Specification bundle
// runc reads this file from the bundle directory to create a container
{
  "ociVersion": "1.1.0",

  // Root filesystem path within the bundle
  "root": {
    "path": "rootfs",
    "readonly": false
  },

  // Process to execute inside the container
  "process": {
    "terminal": false,
    "user": {
      "uid": 1000,
      "gid": 1000,
      // Additional supplementary group IDs
      "additionalGids": [2000]
    },
    "args": ["/bin/server", "--config", "/etc/config.yaml"],
    "env": [
      "PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
      "APP_ENV=production"
    ],
    "cwd": "/app",
    "capabilities": {
      // Capabilities available in the process's bounding set
      "bounding": ["CAP_NET_BIND_SERVICE"],
      // Effective capabilities at process start
      "effective": [],
      "permitted": ["CAP_NET_BIND_SERVICE"],
      "ambient": [],
      "inheritable": []
    },
    // No new privileges - prevents setuid binaries from escalating
    "noNewPrivileges": true,
    // Path to compiled seccomp BPF filter
    "apparmorProfile": "container-default"
  },

  // Hostname visible inside the container's UTS namespace
  "hostname": "my-container",

  // Filesystem mounts (proc, sys, dev, and application-specific)
  "mounts": [
    {
      "destination": "/proc",
      "type": "proc",
      "source": "proc",
      "options": []
    },
    {
      "destination": "/dev",
      "type": "tmpfs",
      "source": "tmpfs",
      "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]
    },
    {
      "destination": "/sys",
      "type": "sysfs",
      "source": "sysfs",
      "options": ["nosuid", "noexec", "nodev", "ro"]
    },
    {
      // Application configuration volume mount
      "destination": "/etc/config",
      "type": "bind",
      "source": "/var/lib/containerd/volumes/abc123/config",
      "options": ["rbind", "ro"]
    }
  ],

  // Linux-specific configuration
  "linux": {
    // cgroups v2 path for resource limits
    "cgroupsPath": "/kubepods/besteffort/pod1234/container5678",

    // Namespace configuration - creates new namespaces for isolation
    "namespaces": [
      {"type": "pid"},       // Isolated PID numbering
      {"type": "network"},   // Isolated network stack
      {"type": "ipc"},       // Isolated IPC (semaphores, shared memory)
      {"type": "uts"},       // Isolated hostname/domainname
      {"type": "mount"},     // Isolated filesystem view
      {"type": "user"}       // User/group ID mapping (when enabled)
    ],

    // UID/GID mappings for user namespace (when enabled)
    "uidMappings": [
      {
        "containerID": 0,    // Container root maps to...
        "hostID": 100000,    // ...host UID 100000
        "size": 65536        // Map 65536 UIDs
      }
    ],

    // Resource limits via cgroups v2
    "resources": {
      "memory": {
        "limit": 536870912,       // 512MB memory limit
        "reservation": 134217728, // 128MB soft limit
        "swap": 536870912         // No additional swap
      },
      "cpu": {
        "shares": 1024,           // Relative weight
        "quota": 100000,          // 100ms per period
        "period": 100000          // 100ms period = 1 CPU
      }
    },

    // Seccomp filter applied to all syscalls
    "seccomp": {
      "defaultAction": "SCMP_ACT_ERRNO",
      "architectures": ["SCMP_ARCH_X86_64"],
      "syscalls": [
        {
          // Allow essential syscalls
          "names": ["read", "write", "close", "fstat", "lseek",
                    "mmap", "mprotect", "munmap", "brk", "rt_sigaction",
                    "rt_sigprocmask", "rt_sigreturn", "access", "pipe",
                    "select", "sched_yield", "mremap", "msync", "mincore",
                    "madvise", "shmget", "shmat", "shmctl", "dup", "dup2",
                    "pause", "nanosleep", "getitimer", "alarm", "setitimer",
                    "getpid", "sendfile", "socket", "connect", "accept",
                    "sendto", "recvfrom", "sendmsg", "recvmsg", "shutdown",
                    "bind", "listen", "getsockname", "getpeername",
                    "socketpair", "setsockopt", "getsockopt", "clone",
                    "fork", "vfork", "execve", "exit", "wait4", "kill",
                    "uname", "semget", "semop", "semctl", "shmdt",
                    "msgget", "msgsnd", "msgrcv", "msgctl", "fcntl",
                    "flock", "fsync", "fdatasync", "truncate", "ftruncate",
                    "getdents", "getcwd", "chdir", "fchdir", "rename",
                    "mkdir", "rmdir", "creat", "link", "unlink", "symlink",
                    "readlink", "chmod", "fchmod", "chown", "fchown",
                    "lchown", "umask", "gettimeofday", "getrlimit",
                    "getrusage", "sysinfo", "times", "ptrace", "getuid",
                    "syslog", "getgid", "setuid", "setgid", "geteuid",
                    "getegid", "setpgid", "getppid", "getpgrp", "setsid",
                    "setreuid", "setregid", "getgroups", "setgroups",
                    "setresuid", "getresuid", "setresgid", "getresgid",
                    "getpgid", "setfsuid", "setfsgid", "getsid", "capget",
                    "capset", "rt_sigpending", "rt_sigtimedwait",
                    "rt_sigqueueinfo", "rt_sigsuspend", "sigaltstack",
                    "utime", "mknod", "uselib", "personality", "ustat",
                    "statfs", "fstatfs", "sysfs", "getpriority",
                    "setpriority", "sched_setparam", "sched_getparam",
                    "sched_setscheduler", "sched_getscheduler",
                    "sched_get_priority_max", "sched_get_priority_min",
                    "sched_rr_get_interval", "mlock", "munlock",
                    "mlockall", "munlockall", "vhangup", "modify_ldt",
                    "pivot_root", "_sysctl", "prctl", "arch_prctl",
                    "adjtimex", "setrlimit", "chroot", "sync", "acct",
                    "settimeofday", "mount", "umount2", "swapon", "swapoff",
                    "reboot", "sethostname", "setdomainname", "iopl",
                    "ioperm", "create_module", "init_module",
                    "delete_module", "get_kernel_syms", "query_module",
                    "quotactl", "nfsservctl", "getpmsg", "putpmsg",
                    "afs_syscall", "tuxcall", "security", "gettid",
                    "readahead", "setxattr", "lsetxattr", "fsetxattr",
                    "getxattr", "lgetxattr", "fgetxattr", "listxattr",
                    "llistxattr", "flistxattr", "removexattr",
                    "lremovexattr", "fremovexattr", "tkill", "time",
                    "futex", "sched_setaffinity", "sched_getaffinity",
                    "set_thread_area", "io_setup", "io_destroy",
                    "io_getevents", "io_submit", "io_cancel",
                    "get_thread_area", "lookup_dcookie", "epoll_create",
                    "epoll_ctl_old", "epoll_wait_old", "remap_file_pages",
                    "getdents64", "set_tid_address", "restart_syscall",
                    "semtimedop", "fadvise64", "timer_create",
                    "timer_settime", "timer_gettime", "timer_getoverrun",
                    "timer_delete", "clock_settime", "clock_gettime",
                    "clock_getres", "clock_nanosleep", "exit_group",
                    "epoll_wait", "epoll_ctl", "tgkill", "utimes",
                    "vserver", "mbind", "set_mempolicy", "get_mempolicy",
                    "mq_open", "mq_unlink", "mq_timedsend",
                    "mq_timedreceive", "mq_notify", "mq_getsetattr",
                    "kexec_load", "waitid", "add_key", "request_key",
                    "keyctl", "ioprio_set", "ioprio_get",
                    "inotify_init", "inotify_add_watch",
                    "inotify_rm_watch", "migrate_pages", "openat",
                    "mkdirat", "mknodat", "fchownat", "futimesat",
                    "newfstatat", "unlinkat", "renameat", "linkat",
                    "symlinkat", "readlinkat", "fchmodat", "faccessat",
                    "pselect6", "ppoll", "unshare", "set_robust_list",
                    "get_robust_list", "splice", "tee", "sync_file_range",
                    "vmsplice", "move_pages", "utimensat",
                    "epoll_pwait", "signalfd", "timerfd_create",
                    "eventfd", "fallocate", "timerfd_settime",
                    "timerfd_gettime", "accept4", "signalfd4",
                    "eventfd2", "epoll_create1", "dup3", "pipe2",
                    "inotify_init1", "preadv", "pwritev", "rt_tgsigqueueinfo",
                    "perf_event_open", "recvmmsg", "fanotify_init",
                    "fanotify_mark", "prlimit64", "name_to_handle_at",
                    "open_by_handle_at", "clock_adjtime", "syncfs",
                    "sendmmsg", "setns", "getcpu", "process_vm_readv",
                    "process_vm_writev", "kcmp", "finit_module",
                    "sched_setattr", "sched_getattr", "renameat2",
                    "seccomp", "getrandom", "memfd_create", "kexec_file_load",
                    "bpf", "execveat", "userfaultfd", "membarrier",
                    "mlock2", "copy_file_range", "preadv2", "pwritev2",
                    "pkey_mprotect", "pkey_alloc", "pkey_free",
                    "statx", "io_pgetevents", "rseq"],
          "action": "SCMP_ACT_ALLOW"
        }
      ]
    }
  }
}
```

## containerd Architecture

containerd is a CNCF graduated project that acts as the high-level container runtime. It manages the full container lifecycle at a level above kernel primitives but below the orchestrator.

### Containerd Component Architecture

```
containerd daemon
├── Content Store       (CAS for images/snapshots)
├── Snapshot Store      (overlay/btrfs/devmapper)
├── Image Store         (image metadata registry)
├── Task Service        (container execution)
│   └── containerd-shim-runc-v2  (per-container shim)
│       └── runc  (OCI runtime, exits after create)
├── Event System        (publishable event bus)
├── Metrics Service     (prometheus endpoints)
└── Plugins             (snapshotter, diff, content)
```

### Containerd Namespaces

containerd uses internal namespaces to isolate clients. Kubernetes uses the `k8s.io` namespace:

```bash
# List containers in the Kubernetes namespace
# The --namespace flag is containerd's internal namespace,
# not a Kubernetes namespace
ctr --namespace k8s.io containers list

# Inspect a specific container
ctr --namespace k8s.io containers info <container-id>

# List images pulled by containerd
ctr --namespace k8s.io images list

# Inspect the snapshot layers for a container
ctr --namespace k8s.io snapshots usage <snapshot-id>

# View task (running container) information
ctr --namespace k8s.io tasks list

# Execute a command in a running task
ctr --namespace k8s.io tasks exec \
  --exec-id debug-session \
  --tty \
  <container-id> \
  /bin/sh
```

### containerd-shim Architecture

The containerd-shim solves a critical operational problem: container processes must survive containerd restarts. The shim acts as a persistent parent process that holds file descriptors and reports container state back to containerd after a restart.

```
Before shim architecture:
  containerd → container-process
  If containerd dies, container-process becomes orphan
  Container state is lost on containerd restart

With shim architecture:
  containerd → shim → container-process
  If containerd dies, shim keeps running
  Container-process remains under shim supervision
  Containerd reconnects to shim on restart via abstract socket
```

The shim protocol uses a Unix domain socket at a well-known path:

```bash
# Shim sockets are created at this path pattern
# Each container gets its own shim and socket
ls /run/containerd/s/

# The socket name is derived from the bundle path hash
# containerd reconnects by finding the socket for each bundle

# Inspect a running shim process
ps aux | grep containerd-shim-runc-v2

# A shim creates: the container process, stdio FIFOs,
# and manages OCI lifecycle calls
# PID file created by shim for state tracking
cat /run/containerd/io.containerd.runtime.v2.task/k8s.io/<id>/init.pid
```

### Snapshotter: The Layered Filesystem

containerd's snapshotter manages the layered filesystem that becomes the container's rootfs. The overlay snapshotter is the default on Linux:

```bash
# Show snapshotter backend in use
containerd config dump | grep -A5 "snapshotter"

# Inspect overlay snapshotter mounts for a container snapshot
# The lower directories are the read-only image layers
# The upper directory is the writable container layer
cat /proc/mounts | grep overlay | head -5

# Example output:
# overlay /run/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/123/fs
#   overlay rw,lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/1/fs:
#           /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/2/fs,
#           upperdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/123/fs,
#           workdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/123/work

# Count snapshot layers (depth of image)
ctr --namespace k8s.io snapshots tree <image-ref> | wc -l
```

## runc: Container Lifecycle

runc is the reference OCI runtime implementation. It is a short-lived process; it creates the container and then exits (for `create`/`start`), or executes and stays alive (for `run`). The shim manages runc's output and container state.

### Container Lifecycle States

```
States:
  creating → created → running → stopped
                               ↓
                           deleted

Transitions triggered by runc subcommands:
  create    : creating → created
  start     : created → running
  exec      : running (adds a process to running container)
  kill      : running → stopped
  delete    : stopped → deleted

The OCI spec also defines:
  pause     : running → paused
  resume    : paused → running
```

### runc create/start Internals

```bash
# Manually creating a container with runc (for debugging)
# In production, containerd-shim invokes runc automatically

# Step 1: Create an OCI bundle directory
mkdir -p /tmp/mycontainer/rootfs

# Step 2: Extract a container filesystem
tar -C /tmp/mycontainer/rootfs -xf rootfs.tar

# Step 3: Generate a default config.json
runc spec --rootless   # For rootless containers
# OR
runc spec              # For root containers

# Step 4: Create the container (allocates namespaces, does NOT start process)
# This transitions from 'creating' to 'created' state
# runc exits after this step; shim holds state
runc create \
  --bundle /tmp/mycontainer \
  my-container-id

# Inspect created container state
runc state my-container-id
# Output:
# {
#   "ociVersion": "1.1.0",
#   "id": "my-container-id",
#   "status": "created",
#   "pid": 12345,
#   "bundle": "/tmp/mycontainer",
#   "created": "2024-01-15T10:30:00Z",
#   "owner": "root"
# }

# Step 5: Start the container (executes the entry process)
# Transitions from 'created' to 'running'
runc start my-container-id

# The init process (PID 1) is now running inside the container
runc ps my-container-id

# Execute an additional process in the running container
runc exec my-container-id /bin/sh

# Stop the container gracefully
runc kill my-container-id SIGTERM

# Delete the container (clean up namespaces, cgroups, state)
runc delete my-container-id
```

### runc exec Internals: nsenter

When runc executes a process in a running container, it uses `nsenter` semantics to join the container's existing namespaces:

```bash
# runc exec is equivalent to:
# nsenter --target <pid> --mount --uts --ipc --net --pid <command>

# Get the PID of the container's init process
CONTAINER_PID=$(runc state my-container-id | jq -r .pid)

# Manually join namespaces (what runc exec does internally)
nsenter \
  --target "${CONTAINER_PID}" \
  --mount \
  --uts \
  --ipc \
  --net \
  --pid \
  -- /bin/sh

# Verify we're inside the container's namespace
# PID 1 should be the container's init process
ls /proc/1/exe
```

## Linux Namespaces in Depth

Containers use Linux namespaces to provide isolated views of system resources. Each namespace type isolates a different resource category.

### PID Namespace

```bash
# PID namespaces give containers their own PID numbering.
# The container's init process appears as PID 1 inside,
# but has a different PID in the host namespace.

# Host-side view
CONTAINER_PID=$(crictl inspect <container-id> | jq -r .info.pid)
echo "Container init PID on host: ${CONTAINER_PID}"

# Container-side view (PID 1 inside)
kubectl exec -it <pod-name> -- cat /proc/1/cmdline

# The kernel maps between namespaced PIDs transparently
# /proc/<host-pid>/ns/pid shows the PID namespace inode
ls -la /proc/"${CONTAINER_PID}"/ns/pid

# PID namespace nesting: container cannot see host PIDs
kubectl exec -it <pod-name> -- ls /proc/ | wc -l
# Returns only the PIDs inside the container's PID namespace
```

### Network Namespace

```bash
# Each pod gets a dedicated network namespace shared by all containers.
# The pause/sandbox container holds the network namespace.

# Find the network namespace of a pod
SANDBOX_PID=$(crictl inspect \
  $(crictl pods --name <pod-name> -q) \
  | jq -r .info.pid)

# List network interfaces inside the pod's netns
nsenter \
  --target "${SANDBOX_PID}" \
  --net \
  -- ip addr show

# The veth pair: one end in pod netns, other end in host netns
# Find the host end of the veth pair
ip link show | grep veth

# Inspect iptables rules as seen from inside the netns
nsenter \
  --target "${SANDBOX_PID}" \
  --net \
  -- iptables -t nat -L PREROUTING -n -v
```

### Mount Namespace

```bash
# The mount namespace provides an isolated filesystem view.
# The container's rootfs is mounted in its own mount namespace.

# Inspect the container's mounts
CONTAINER_PID=$(runc state <id> | jq -r .pid)
cat /proc/"${CONTAINER_PID}"/mounts

# The overlay mount for the container rootfs
grep overlay /proc/"${CONTAINER_PID}"/mounts

# Propagation modes affect how mounts cross namespace boundaries
# shared: mounts propagate in both directions
# slave: mounts propagate from host to container only
# private: no propagation (default for containers)
# unbindable: cannot be bind-mounted
cat /proc/"${CONTAINER_PID}"/mountinfo | awk '{print $7, $5}'
```

### User Namespace

User namespaces enable rootless containers by mapping container UIDs to unprivileged host UIDs:

```bash
# Check if user namespaces are enabled in containerd
containerd config dump | grep -A3 "user_namespaces"

# User namespace UID mapping
# Container UID 0 (root) maps to host UID 100000 (unprivileged)
cat /proc/"${CONTAINER_PID}"/uid_map
# Output: 0  100000  65536

# A process that appears as root inside the container is
# actually running as an unprivileged user on the host,
# limiting the blast radius of container escapes.

# Enable rootless mode in containerd (experimental)
# /etc/containerd/config.toml
# [plugins."io.containerd.grpc.v1.cri".containerd]
#   enable_unprivileged_ports = true
#   enable_unprivileged_icmp = true
```

## cgroups v2 for Container Resource Control

cgroups v2 provides a unified hierarchy for all resource controllers, replacing the fragmented v1 interface.

### cgroups v2 Structure

```bash
# cgroups v2 mount point
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# Kubernetes pod cgroups hierarchy
# /sys/fs/cgroup/kubepods/
#   burstable/
#     pod<uid>/
#       <container-id>/    <- Per-container cgroup
#   besteffort/
#   guaranteed/

# Inspect CPU limits for a container
CGROUP_PATH="/sys/fs/cgroup/kubepods/guaranteed/pod${POD_UID}/${CONTAINER_ID}"

# CPU quota: how many microseconds per period the container can use
cat "${CGROUP_PATH}/cpu.max"
# Output: 100000 100000  (quota period = 1 CPU core)

# Memory limit
cat "${CGROUP_PATH}/memory.max"
# Output: 536870912 (512MB)

# Memory current usage
cat "${CGROUP_PATH}/memory.current"

# OOM events
cat "${CGROUP_PATH}/memory.events"
# low X           <- Memory below high watermark
# high X          <- Memory above high watermark (throttled)
# max X           <- Memory hit hard limit (throttled)
# oom X           <- OOM killer invoked
# oom_kill X      <- Process killed by OOM killer

# PSI (Pressure Stall Information) - new in cgroups v2
# Measures time processes spent waiting for resources
cat "${CGROUP_PATH}/cpu.pressure"
# some avg10=0.00 avg60=0.15 avg300=0.05 total=12345
# full avg10=0.00 avg60=0.00 avg300=0.00 total=1234

cat "${CGROUP_PATH}/memory.pressure"
cat "${CGROUP_PATH}/io.pressure"
```

### cgroups v2 Controller Configuration

```bash
# Enable all available controllers in the root cgroup
# Required before child cgroups can use them
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc

echo "+cpuset +cpu +io +memory +pids" > /sys/fs/cgroup/cgroup.subtree_control

# Create a custom cgroup for testing
mkdir -p /sys/fs/cgroup/test-container

# Set memory limit to 256MB
echo "268435456" > /sys/fs/cgroup/test-container/memory.max

# Set memory high watermark to 200MB (triggers reclaim before OOM)
echo "209715200" > /sys/fs/cgroup/test-container/memory.high

# Set CPU limit to 0.5 cores (500ms per 1000ms period)
echo "500000 1000000" > /sys/fs/cgroup/test-container/cpu.max

# Add a process to the cgroup
echo $$ > /sys/fs/cgroup/test-container/cgroup.procs

# Verify the process is in the cgroup
cat /sys/fs/cgroup/test-container/cgroup.procs
```

## Seccomp: Syscall Filtering

Seccomp (Secure Computing Mode) filters syscalls using BPF programs, reducing the kernel attack surface available to container processes.

### Default Seccomp Profile

```json
// default-seccomp.json
// The default containerd/Docker seccomp profile
// Blocks ~44 syscalls that are rarely needed in containers
// but provide significant kernel attack surface
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
        // Network administration - allows arbitrary IP configuration
        "sethostname",
        "setdomainname",
        // Loading kernel modules - full kernel code execution
        "init_module",
        "finit_module",
        "delete_module",
        // Raw disk access - filesystem bypass
        "mknod",
        // Changing system time - breaks log correlation
        "adjtimex",
        "settimeofday",
        "clock_settime",
        // Kernel keyring access
        "add_key",
        "request_key",
        "keyctl",
        // User namespace operations (explicit deny)
        "unshare",
        "clone"   // Blocked unless CLONE_NEWUSER not set
      ],
      "action": "SCMP_ACT_ERRNO"
    },
    {
      // These are allowed; all others blocked by defaultAction
      "names": [
        "accept", "accept4", "access", "adjtimex", "alarm",
        "bind", "brk", "capget", "capset", "chdir", "chmod",
        "chown", "chown32", "clock_getres", "clock_gettime",
        "clock_nanosleep", "close", "connect"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

### Custom Seccomp Profile for Specific Workloads

```json
// minimal-seccomp.json
// Minimal seccomp profile for a Go HTTP server
// Only allows syscalls actually needed by the workload
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": [
        // Go runtime essentials
        "read", "write", "close", "fstat", "lseek",
        "mmap", "mprotect", "munmap", "brk",
        "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "ioctl", "pread64", "pwrite64", "readv", "writev",
        "access", "pipe", "select", "sched_yield", "madvise",
        // Network (HTTP server)
        "socket", "connect", "accept", "sendto", "recvfrom",
        "sendmsg", "recvmsg", "shutdown", "bind", "listen",
        "getsockname", "getpeername", "setsockopt", "getsockopt",
        "accept4",
        // Process management
        "clone", "fork", "vfork", "execve", "exit", "wait4",
        "kill", "getpid", "getppid", "gettid",
        "futex", "set_tid_address", "exit_group",
        // File operations
        "open", "openat", "creat", "stat", "lstat", "fstat",
        "newfstatat", "unlink", "rename", "mkdir", "rmdir",
        "fcntl", "dup", "dup2", "dup3",
        // Time
        "gettimeofday", "nanosleep", "clock_gettime",
        "clock_getres", "clock_nanosleep",
        // Memory
        "mremap", "mlockall", "munlockall",
        // IDs
        "getuid", "getgid", "geteuid", "getegid",
        "getgroups", "getpgrp", "getpgid",
        // Epoll/poll (Go netpoller)
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_wait",
        "epoll_pwait", "poll", "ppoll",
        // Signals
        "sigaltstack", "rt_sigpending", "rt_sigsuspend",
        // Other Go runtime
        "prctl", "arch_prctl", "getrandom", "seccomp",
        "sched_getaffinity", "sched_setaffinity"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```bash
# Apply custom seccomp profile via Kubernetes Pod spec
# Kubernetes 1.19+ supports seccomp via securityContext
# Custom profiles must be placed on each node at:
# /var/lib/kubelet/seccomp/profiles/

# Copy profile to all nodes via DaemonSet (simplified)
kubectl create configmap custom-seccomp \
  --from-file=minimal-seccomp.json \
  -n kube-system

# Pod spec using custom seccomp profile
# pod-with-seccomp.yaml
cat <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: secure-api-server
spec:
  securityContext:
    seccompProfile:
      type: Localhost    # Use a custom profile from disk
      localhostProfile: profiles/minimal-seccomp.json
  containers:
  - name: api
    image: myregistry/api-server:v1.2.3
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 1000
      capabilities:
        drop: ["ALL"]
EOF
```

## AppArmor and SELinux Integration

### AppArmor Profile for Containers

```bash
# AppArmor profile for a web server container
# /etc/apparmor.d/container-web-server
cat > /etc/apparmor.d/container-web-server << 'EOF'
#include <tunables/global>

# Profile name matches the annotation value in the pod spec
profile container-web-server flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  # Executable permissions
  /usr/local/bin/server rix,       # Execute the server binary
  /lib/x86_64-linux-gnu/** mr,     # Read shared libraries
  /lib64/ld-linux-x86-64.so.2 mr, # Dynamic linker

  # Configuration read access
  /etc/config/** r,
  /etc/ssl/certs/** r,

  # Temporary files
  /tmp/** rw,
  /var/tmp/** rw,

  # Log output (via stdout/stderr - file descriptor passthrough)
  /proc/self/fd/* rw,
  /dev/stdout rw,
  /dev/stderr rw,

  # Network access (all network allowed at AppArmor level;
  # further restricted by NetworkPolicy at kernel netfilter level)
  network inet tcp,
  network inet6 tcp,
  network inet udp,

  # Explicitly deny dangerous capabilities
  deny /proc/sys/kernel/** w,
  deny /proc/sysrq-trigger rw,
  deny /sys/kernel/security/** rwx,
  deny /etc/passwd w,
  deny /etc/shadow rw,
  deny @{HOME}/.ssh/** rwx,
}
EOF

# Load the profile
apparmor_parser -r -W /etc/apparmor.d/container-web-server

# Verify it is loaded
aa-status | grep container-web-server
```

```yaml
# pod-with-apparmor.yaml
# Apply AppArmor profile via annotation
apiVersion: v1
kind: Pod
metadata:
  name: web-server
  annotations:
    # Format: container.apparmor.security.beta.kubernetes.io/<container-name>
    container.apparmor.security.beta.kubernetes.io/web: localhost/container-web-server
spec:
  containers:
  - name: web
    image: nginx:1.25
    securityContext:
      runAsNonRoot: true
      runAsUser: 101
      allowPrivilegeEscalation: false
```

### SELinux Context for Containers

```bash
# SELinux type enforcement for containers
# On SELinux-enabled systems, every process and file has a type label
# containers run with container_t type, files get container_file_t

# Check the SELinux context of a container process
ps -eZ | grep conmon

# Default SELinux type for Kubernetes containers
# container_t domain allows network access, tmpfs access
# but not host file access or device access

# Custom SELinux policy for a specific workload
# Allow container_t to read custom label
cat > my-app-policy.te << 'EOF'
policy_module(my-app, 1.0)

require {
    type container_t;
    type custom_config_t;
    class file { read open getattr };
    class dir { read open search getattr };
}

# Allow containers to read custom-labeled config files
allow container_t custom_config_t:file { read open getattr };
allow container_t custom_config_t:dir { read open search getattr };
EOF

# Compile and install the policy module
checkmodule -M -m -o my-app-policy.mod my-app-policy.te
semodule_package -o my-app-policy.pp -m my-app-policy.mod
semodule -i my-app-policy.pp

# Label files with the custom type
chcon -R -t custom_config_t /etc/my-app/config/

# Set SELinux context in Pod spec
# (Kubernetes alpha feature - requires SELinuxMount feature gate)
```

## CRI-O vs containerd

Both CRI-O and containerd implement the Kubernetes Container Runtime Interface. Key differences:

| Aspect | containerd | CRI-O |
|--------|-----------|-------|
| Scope | General-purpose runtime | Kubernetes-specific CRI |
| Plugin system | Extensible via plugins | Limited extensibility |
| Additional clients | Docker, nerdctl | None (Kubernetes only) |
| Image handling | Full image management | Delegates to containers/image |
| Default snapshotter | overlayfs | overlayfs |
| Config file | /etc/containerd/config.toml | /etc/crio/crio.conf |
| Shim protocol | containerd-shim v2 | Same (uses runc) |

```bash
# Check which runtime is in use on a node
kubectl get node <node-name> -o jsonpath='{.status.nodeInfo.containerRuntimeVersion}'
# Output: containerd://1.7.0 OR cri-o://1.28.0

# CRI-O specific: crictl works with both
crictl --runtime-endpoint unix:///run/crio/crio.sock ps

# containerd: also supports nerdctl (Docker-compatible CLI)
nerdctl --namespace k8s.io ps

# Switching runtime: requires node drain and reconfiguration
# Never change runtime on a live production node
```

## Debugging Container Runtime Issues

### containerd Health Checks

```bash
#!/bin/bash
# debug-containerd.sh
# Diagnostic script for containerd runtime issues

echo "=== containerd service status ==="
systemctl status containerd --no-pager | head -20

echo "=== containerd version ==="
containerd --version

echo "=== CRI endpoint health ==="
crictl info

echo "=== Disk space for container storage ==="
df -h /var/lib/containerd/

echo "=== Snapshot count ==="
ctr --namespace k8s.io snapshots list | wc -l

echo "=== Image storage usage ==="
du -sh /var/lib/containerd/io.containerd.content.v1.content/

echo "=== Recent containerd errors (last 100 lines) ==="
journalctl -u containerd --since "1 hour ago" \
  | grep -i "error\|failed\|fatal" \
  | tail -50

echo "=== Stale shim processes ==="
ps aux | grep "containerd-shim-runc" | grep -v grep

echo "=== OOM kills in last hour ==="
dmesg --since "1 hour ago" | grep "Out of memory\|oom_kill"
```

### Troubleshooting runc Failures

```bash
# runc failures are often reported as "failed to create containerd task"
# in kubelet logs. Diagnose with:

# Check kubelet events
kubectl describe pod <pod-name> | grep -A20 Events

# Get detailed runc error from containerd logs
journalctl -u containerd --since "5 minutes ago" \
  | grep -i "runc\|oci\|create task"

# Common causes and their indicators:
# 1. seccomp: "operation not permitted" with syscall name
#    -> check /proc/<pid>/status for Seccomp field
# 2. AppArmor: "permission denied" with apparmor in dmesg
#    -> dmesg | grep apparmor
# 3. SELinux: "permission denied" with avc in audit.log
#    -> ausearch -m avc -ts recent
# 4. OOM during startup: process killed before ready
#    -> dmesg | grep "killed process"
# 5. Image extraction failure: disk full during pull
#    -> df -h && ctr -n k8s.io content ls

# Run runc directly with debug output (requires bundle)
runc --debug create --bundle /tmp/test-bundle test-debug 2>&1
```

## Summary

The container runtime stack from OCI specification to kernel primitives is a well-specified sequence of abstractions. containerd manages the high-level lifecycle—image distribution, snapshot management, and task orchestration. The containerd-shim provides container process supervision that survives runtime restarts. runc translates OCI bundle configuration into kernel calls that establish namespaces, configure cgroups v2, apply seccomp filters, and execute the container process.

Understanding each layer enables accurate diagnosis when containers fail to start (runc config issues), behave unexpectedly (namespace or cgroup misconfiguration), trigger security alerts (seccomp/AppArmor violations), or consume unexpected resources (cgroups v2 PSI analysis). The OCI specification ensures that this knowledge transfers across compliant runtimes, making it a foundational investment for any team running containers in production.
