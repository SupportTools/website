---
title: "Linux Kernel Namespaces Deep Dive: PID, UTS, IPC, and User Namespaces"
date: 2031-02-11T00:00:00-05:00
draft: false
tags: ["Linux", "Namespaces", "Containers", "Security", "containerd", "runc"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive deep dive into Linux kernel namespaces covering PID, UTS, IPC, and user namespace isolation boundaries, UID/GID mapping, nested hierarchies, security implications, and how containerd and runc implement container isolation."
more_link: "yes"
url: "/linux-kernel-namespaces-deep-dive-pid-uts-ipc-user/"
---

Linux namespaces are the kernel-level isolation mechanism that makes containers possible. Understanding them at the system call level gives you deep insight into container security boundaries, privilege escalation paths, and why certain container configurations are inherently unsafe. This guide covers every namespace type with hands-on examples using unshare, nsenter, and direct system call exploration.

<!--more-->

# Linux Kernel Namespaces Deep Dive: PID, UTS, IPC, and User Namespaces

## The Namespace Model

Linux namespaces partition global system resources so that each namespace has its own independent view of that resource. The kernel currently implements eight namespace types:

| Namespace | Flag | Isolates |
|-----------|------|----------|
| Mount | CLONE_NEWNS | Filesystem mount points |
| UTS | CLONE_NEWUTS | Hostname and domain name |
| IPC | CLONE_NEWIPC | System V IPC, POSIX message queues |
| PID | CLONE_NEWPID | Process IDs |
| Network | CLONE_NEWNET | Network devices, addresses, routing |
| User | CLONE_NEWUSER | User and group IDs |
| Cgroup | CLONE_NEWCGROUP | cgroup root directory |
| Time | CLONE_NEWTIME | Boot and monotonic clock offsets |

Each running process belongs to exactly one namespace of each type. The namespace membership is visible through `/proc/<pid>/ns/`:

```bash
ls -la /proc/1/ns/
# lrwxrwxrwx 1 root root 0 /proc/1/ns/cgroup -> 'cgroup:[4026531835]'
# lrwxrwxrwx 1 root root 0 /proc/1/ns/ipc -> 'ipc:[4026531839]'
# lrwxrwxrwx 1 root root 0 /proc/1/ns/mnt -> 'mnt:[4026531840]'
# lrwxrwxrwx 1 root root 0 /proc/1/ns/net -> 'net:[4026531992]'
# lrwxrwxrwx 1 root root 0 /proc/1/ns/pid -> 'pid:[4026531836]'
# lrwxrwxrwx 1 root root 0 /proc/1/ns/time -> 'time:[4026531834]'
# lrwxrwxrwx 1 root root 0 /proc/1/ns/user -> 'user:[4026531837]'
# lrwxrwxrwx 1 root root 0 /proc/1/ns/uts -> 'uts:[4026531838]'
```

The number in brackets is the inode of the namespace. Two processes in the same namespace have symlinks pointing to the same inode.

## Section 1: UTS Namespace — Hostname Isolation

The UTS (UNIX Time-Sharing) namespace isolates two system identifiers: the hostname returned by `gethostname()` and the NIS domain name returned by `getdomainname()`. Every container gets its own UTS namespace, which is why a container shows the pod name as the hostname.

### Exploring UTS Namespaces

```bash
# Current hostname in the host UTS namespace
hostname
# Output: prod-node-01

# Create a new UTS namespace and change the hostname
sudo unshare --uts /bin/bash
hostname container-test
hostname
# Output: container-test

# In another terminal, verify the host hostname is unchanged
hostname
# Output: prod-node-01

# Verify the new UTS namespace inode differs
cat /proc/$$/ns/uts
# Output: uts:[4026532254]   <-- different from host's uts:[4026531838]
```

### UTS Namespace in Container Runtimes

```c
/* Minimal example of creating a UTS namespace — mirrors what runc does */
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    /* Create a new UTS namespace for this process */
    if (unshare(CLONE_NEWUTS) != 0) {
        perror("unshare");
        exit(1);
    }

    /* Set the hostname within the new namespace */
    const char *hostname = "my-container";
    if (sethostname(hostname, strlen(hostname)) != 0) {
        perror("sethostname");
        exit(1);
    }

    char buf[256];
    gethostname(buf, sizeof(buf));
    printf("Container hostname: %s\n", buf);

    return 0;
}
```

## Section 2: PID Namespace — Process Tree Isolation

The PID namespace isolates the process ID number space. Processes in a new PID namespace have their own PID 1 (typically the container's init process). PIDs within the namespace are independent of the host's PID space.

### PID Namespace Characteristics

```bash
# Create a new PID namespace; the first process inside has PID 1
sudo unshare --pid --fork --mount-proc /bin/bash

# Inside the new PID namespace
ps aux
# USER    PID %CPU %MEM    VSZ   RSS COMMAND
# root      1  0.0  0.0   4228  3328 /bin/bash
# root      8  0.0  0.0  37368  3380 ps aux

echo $$
# Output: 1  (this bash IS pid 1 in the new namespace)
```

### Nested PID Namespaces

PID namespaces form a tree. A process has a different PID in each ancestor namespace:

```bash
# On the host, find the bash process that appears as PID 1 inside the namespace
# It will have a regular (large) PID on the host
cat /proc/$(pgrep -f "unshare.*bash")/status | grep ^Pid
# Pid:   47823   <- Host PID

# Inside the namespace, the same process has PID 1
# The mapping is maintained by the kernel's pid namespace tree
```

### PID 1 Signal Semantics

```bash
# PID 1 in a namespace receives signals differently than PID 1 on the host.
# By default, PID 1 in a namespace does NOT receive signals unless it has
# registered a handler. This is why containers need a proper init process.

# Bad: running application directly as PID 1 (common Dockerfile anti-pattern)
# CMD ["myapp"]   <- myapp becomes PID 1, may not handle SIGTERM properly

# Better: use tini or dumb-init as PID 1
# CMD ["tini", "--", "myapp"]

# tini correctly:
# 1. Registers signal handlers
# 2. Forwards signals to the application
# 3. Reaps zombie processes (wait() for orphaned children)
```

### Viewing PID Namespace Hierarchy

```bash
# List all PID namespaces and their hierarchy
lsns -t pid
# NS         TYPE PID    PPID USER COMMAND
# 4026531836 pid  1      0    root /sbin/init
# 4026532254 pid  47823  1    root unshare --pid --fork --mount-proc /bin/bash
# 4026532261 pid  51204  47823 root /bin/bash

# Find which namespace a specific process belongs to
ls -la /proc/51204/ns/pid
# lrwxrwxrwx /proc/51204/ns/pid -> 'pid:[4026532261]'
```

## Section 3: IPC Namespace — Inter-Process Communication Isolation

The IPC namespace isolates System V IPC objects (message queues, semaphore sets, shared memory segments) and POSIX message queues. Without IPC namespace isolation, a container could read or write shared memory segments belonging to host processes.

### IPC Namespace Exploration

```bash
# Create some IPC resources on the host
ipcmk -Q          # Create a message queue
ipcmk -S 1        # Create a semaphore set with 1 semaphore
ipcmk -M 4096     # Create a 4096-byte shared memory segment

ipcs
# ------ Message Queues --------
# key        msqid      owner      perms
# 0x9f6a4a1c 0          root       644
#
# ------ Semaphore Arrays --------
# key        semid      owner      perms
# 0xa1b2c3d4 0          root       600
#
# ------ Shared Memory Segments --------
# key        shmid      owner      perms
# 0x12345678 0          root       644

# Enter a new IPC namespace — the host IPC objects are gone
sudo unshare --ipc /bin/bash
ipcs
# ------ Message Queues --------
# ------ Semaphore Arrays --------
# ------ Shared Memory Segments --------
# (empty — isolated from host)
```

### Security Implications of Missing IPC Isolation

Without IPC namespace isolation (the --ipc=host option in Docker), a container can see ALL host IPC objects. This is a significant information disclosure and potential attack vector. A privileged container could attach to shared memory segments belonging to other processes, potentially reading sensitive data like cryptographic material or database caches.

Always use separate IPC namespaces (the container runtime default). Only override with --ipc=host for specific inter-container communication needs where you have evaluated the security implications.

## Section 4: User Namespace — UID/GID Mapping

The user namespace is the most powerful and complex namespace type. It allows an unprivileged user to create a new user namespace where they appear as root, while the kernel maps their operations to unprivileged UIDs on the host.

### Understanding UID/GID Mapping

```bash
# Create a user namespace as an unprivileged user
# Maps host UID 1000 to container UID 0 (root)
unshare --user --map-root-user /bin/bash

# Inside the new user namespace
id
# uid=0(root) gid=0(root) groups=0(root),65534(nogroup)

# We appear as root inside, but the kernel knows the real UID
cat /proc/self/uid_map
# 0 1000 1

# Format: <namespace_uid> <host_uid> <count>
# This reads: starting at namespace UID 0, map to host UID 1000, for 1 UID
```

### Configuring UID/GID Maps

```bash
# Full user namespace with a larger UID range (requires newuidmap/newgidmap)
# This maps a range of UIDs: namespace UID 0-65535 -> host UID 100000-165535

# /etc/subuid must contain: username:100000:65536
# /etc/subgid must contain: username:100000:65536

# Create the namespace (backgrounded so parent can write maps)
unshare --user /bin/bash &
CHILD_PID=$!

# Write the UID map
# Format: ns_start host_start count
echo "0 1000 1" > /proc/${CHILD_PID}/uid_map

# Must write "deny" to setgroups before writing gid_map
echo "deny" > /proc/${CHILD_PID}/setgroups

# Write the GID map
echo "0 1000 1" > /proc/${CHILD_PID}/gid_map
```

### Programmatic User Namespace Creation in C

```c
/* user_ns_demo.c - Demonstrates user namespace UID mapping */
#define _GNU_SOURCE
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAP_BUF_SIZE 100
#define STACK_SIZE (1024 * 1024)

static char child_stack[STACK_SIZE];

static void write_ns_file(const char *path, const char *content) {
    int fd = open(path, O_WRONLY);
    if (fd == -1) {
        perror(path);
        exit(EXIT_FAILURE);
    }
    if (write(fd, content, strlen(content)) == -1) {
        perror("write");
        close(fd);
        exit(EXIT_FAILURE);
    }
    close(fd);
}

static int child_func(void *arg) {
    (void)arg;
    /* Wait for parent to write UID/GID maps */
    sleep(1);

    printf("Inside namespace: UID=%d GID=%d\n", getuid(), getgid());

    char buf[256];
    int fd = open("/proc/self/uid_map", O_RDONLY);
    if (fd != -1) {
        ssize_t n = read(fd, buf, sizeof(buf) - 1);
        if (n > 0) {
            buf[n] = '\0';
            printf("uid_map: %s", buf);
        }
        close(fd);
    }

    return 0;
}

int main(void) {
    char uid_map[MAP_BUF_SIZE];
    char gid_map[MAP_BUF_SIZE];
    char ns_path[256];

    pid_t child_pid = clone(child_func,
                            child_stack + STACK_SIZE,
                            CLONE_NEWUSER | SIGCHLD,
                            NULL);

    if (child_pid == -1) {
        perror("clone");
        exit(EXIT_FAILURE);
    }

    /* Write UID map: namespace UID 0 -> parent's UID */
    snprintf(uid_map, MAP_BUF_SIZE, "0 %d 1", getuid());
    snprintf(gid_map, MAP_BUF_SIZE, "0 %d 1", getgid());

    snprintf(ns_path, sizeof(ns_path), "/proc/%d/uid_map", child_pid);
    write_ns_file(ns_path, uid_map);

    /* Must write "deny" to setgroups before writing gid_map */
    snprintf(ns_path, sizeof(ns_path), "/proc/%d/setgroups", child_pid);
    write_ns_file(ns_path, "deny");

    snprintf(ns_path, sizeof(ns_path), "/proc/%d/gid_map", child_pid);
    write_ns_file(ns_path, gid_map);

    waitpid(child_pid, NULL, 0);
    return 0;
}
```

### User Namespace Capabilities

Within a user namespace, a process has a full set of capabilities — but those capabilities only apply to resources owned by that user namespace:

```bash
# Inside a user namespace as "root"
capsh --print
# Current: =ep
# This shows all capabilities enabled

# But these capabilities are SCOPED to the user namespace
# You cannot use CAP_NET_ADMIN to modify the host network
# You cannot use CAP_SYS_MODULE to load kernel modules

# What you CAN do:
# - Create other namespace types (as unprivileged user on host)
# - Bind to ports below 1024 within a network namespace you own
# - Manage mount namespaces you created
```

## Section 5: Nested Namespace Hierarchies

Namespaces can be nested, and understanding the hierarchy is critical for security analysis.

### Namespace Hierarchy in Container Environments

```bash
# Visualize namespace hierarchy
lsns
# NS         TYPE   NPROCS PID    PPID   USER COMMAND
# 4026531836 pid    156    1      0      root /sbin/init
# 4026531837 user   156    1      0      root /sbin/init
# 4026531838 uts    156    1      0      root /sbin/init
# 4026531839 ipc    156    1      0      root /sbin/init
# 4026531840 mnt    156    1      0      root /sbin/init
# 4026531992 net    156    1      0      root /sbin/init
# 4026532250 mnt    2      12340  1      root containerd-shim
# 4026532251 uts    1      12341  12340  root nginx
# 4026532252 ipc    1      12341  12340  root nginx
# 4026532253 pid    1      12341  12340  root nginx
# 4026532254 net    1      12341  12340  root nginx

# The nginx container process (12341) is in separate mnt/uts/ipc/pid/net namespaces
# but shares the host's user namespace (4026531837) in this example
```

### Entering Namespaces with nsenter

```bash
# Enter a specific container's namespace to debug it
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' my-container)

# Enter the PID namespace to see container processes
sudo nsenter --target $CONTAINER_PID --pid ps aux

# Enter the network namespace to inspect interfaces
sudo nsenter --target $CONTAINER_PID --net ip addr

# Enter all namespaces (full container context)
sudo nsenter --target $CONTAINER_PID \
    --mount --uts --ipc --pid --net \
    /bin/bash

# Enter only the network namespace of a container
# (useful for network debugging without affecting the filesystem view)
sudo nsenter --target $CONTAINER_PID --net -- \
    tcpdump -i eth0 -n

# nsenter is how 'kubectl exec' works internally:
# 1. CRI (containerd) returns the container's init PID
# 2. kubelet calls nsenter with the appropriate namespace flags
# 3. The exec'd process runs inside the container's namespaces
```

### Persisting Namespaces with Bind Mounts

A namespace lives as long as at least one process is in it, OR a file descriptor or bind mount references it:

```bash
# Create a persistent network namespace (survives even if no process is in it)
sudo ip netns add my-persistent-ns

# This creates a bind mount at /run/netns/my-persistent-ns
ls -la /run/netns/
# -r--r--r-- 1 root root 0 /run/netns/my-persistent-ns

# Add a veth pair and configure networking
sudo ip link add veth0 type veth peer name veth1
sudo ip link set veth1 netns my-persistent-ns
sudo ip netns exec my-persistent-ns ip addr add 192.168.100.1/24 dev veth1
sudo ip netns exec my-persistent-ns ip link set veth1 up

# The namespace persists even with no process running in it
# This is how CNI plugins set up container networking before the container starts

# Clean up
sudo ip netns del my-persistent-ns
```

## Section 6: How containerd and runc Use Namespaces

### The Container Runtime Namespace Stack

When you run a container, the following sequence occurs:

```
Docker CLI -> containerd -> containerd-shim -> runc -> container process
                                               |
                                               +-> Creates namespaces via clone()
                                               +-> Writes namespace files to /proc
                                               +-> Sets up pivot_root (mount namespace)
                                               +-> Configures UID/GID maps (user ns)
                                               +-> exec() the container entrypoint
```

### runc's Namespace Configuration (OCI Runtime Spec)

The OCI Runtime Specification defines namespace configuration in `config.json`:

```json
{
  "ociVersion": "1.0.2",
  "process": {
    "terminal": false,
    "user": {
      "uid": 0,
      "gid": 0
    },
    "args": ["/usr/local/bin/myapp"],
    "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    "cwd": "/"
  },
  "root": {
    "path": "rootfs",
    "readonly": false
  },
  "linux": {
    "namespaces": [
      {"type": "pid"},
      {"type": "network"},
      {"type": "ipc"},
      {"type": "uts"},
      {"type": "mount"},
      {"type": "cgroup"}
    ],
    "uidMappings": [
      {
        "containerID": 0,
        "hostID": 100000,
        "size": 65536
      }
    ],
    "gidMappings": [
      {
        "containerID": 0,
        "hostID": 100000,
        "size": 65536
      }
    ]
  }
}
```

### Namespace Management in Go (containerd style)

```go
package namespace

import (
    "fmt"
    "os"
    "path/filepath"
    "syscall"

    "golang.org/x/sys/unix"
)

// JoinNamespace makes the current process join the namespace
// referenced by the given file descriptor.
func JoinNamespace(fd uintptr, nsType int) error {
    return unix.Setns(int(fd), nsType)
}

// OpenNamespace opens the namespace file for the given process and type.
func OpenNamespace(pid int, nsType string) (*os.File, error) {
    path := filepath.Join("/proc", fmt.Sprintf("%d", pid), "ns", nsType)
    return os.Open(path)
}

// EnterContainerNamespaces enters all namespaces of a running container.
// This mirrors the logic used by kubectl exec and containerd.
func EnterContainerNamespaces(containerPID int) error {
    type nsEntry struct {
        name string
        flag int
    }

    nsEntries := []nsEntry{
        {"mnt", syscall.CLONE_NEWNS},
        {"uts", syscall.CLONE_NEWUTS},
        {"ipc", syscall.CLONE_NEWIPC},
        {"pid", syscall.CLONE_NEWPID},
        {"net", syscall.CLONE_NEWNET},
    }

    for _, entry := range nsEntries {
        f, err := OpenNamespace(containerPID, entry.name)
        if err != nil {
            return fmt.Errorf("opening %s namespace: %w", entry.name, err)
        }
        defer f.Close()

        if err := JoinNamespace(f.Fd(), entry.flag); err != nil {
            return fmt.Errorf("joining %s namespace: %w", entry.name, err)
        }
    }

    return nil
}
```

## Section 7: Security Implications

### Namespace Misconfigurations to Avoid

The following container configurations disable namespace isolation and create security risks:

```bash
# --pid=host: Container can see and signal all host processes
# Use only for monitoring agents that need host-wide process visibility.
docker run --pid=host --rm alpine ps aux

# --uts=host: Container can change the host hostname
# Avoid entirely; no legitimate use case in typical applications.
docker run --uts=host --rm alpine hostname attacker-name

# --ipc=host: Container can access host shared memory
# Use only when containers must share memory for high-performance IPC.
docker run --ipc=host --rm alpine ipcs

# --net=host: Container can bind to host ports and inspect host network
# Use only for network infrastructure containers (monitoring, CNI plugins).
docker run --net=host --rm alpine ss -tlnp
```

### User Namespace as the Security Boundary

The user namespace is the fundamental security boundary for rootless containers:

```bash
# With user namespace mapping, "root" in the container is actually UID 100000 on the host
# Even if the container escapes, it has no host privileges

# Verify rootless container operation
docker run --user 0 --rm alpine id
# uid=0(root) gid=0(root) groups=0(root)  <- looks like root inside

# But on the host, the process runs as a non-root UID
ps aux | grep "containerd"
# mmattox  47823  ...  <- running as the regular user, not root

# Check the effective UID from the host perspective
cat /proc/47823/status | grep -E "^[UG]id:"
# Uid:   1000    100000  100000  100000   <- real UID is 1000 (regular user)
# Gid:   1000    100000  100000  100000
```

### Seccomp and Namespace Interactions

```bash
# The default Docker/containerd seccomp profile blocks namespace-related syscalls
# that would allow privilege escalation:
#   - mount()       - prevents mounting from inside unprivileged containers
#   - reboot()      - prevents container from triggering host reboot
#   - kexec_load()  - prevents loading new kernels
#   - unshare()     - restricted flags to prevent nested namespace privilege escape

# Verify seccomp is active inside a container
cat /proc/self/status | grep Seccomp
# Seccomp:        2  (2 = SECCOMP_MODE_FILTER, using a BPF filter)

# List the seccomp syscall restrictions (requires libseccomp tools)
# Inside container:
grep -c "ALLOW" /proc/self/status || true
```

## Section 8: Namespace Debugging Tools

### Interactive Namespace Debug Script

```bash
#!/bin/bash
# ns-debug.sh - Debug a container's namespaces interactively

CONTAINER_NAME="${1:-}"
if [ -z "$CONTAINER_NAME" ]; then
    echo "Usage: $0 <container-name>"
    exit 1
fi

# Get the container's init PID
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' "$CONTAINER_NAME" 2>/dev/null)

if [ -z "$CONTAINER_PID" ] || [ "$CONTAINER_PID" = "0" ]; then
    echo "Container $CONTAINER_NAME is not running"
    exit 1
fi

echo "Container PID: $CONTAINER_PID"
echo ""
echo "Namespace membership:"
for ns in cgroup ipc mnt net pid time user uts; do
    ns_id=$(readlink "/proc/${CONTAINER_PID}/ns/${ns}" 2>/dev/null)
    host_id=$(readlink "/proc/1/ns/${ns}" 2>/dev/null)
    if [ "$ns_id" = "$host_id" ]; then
        echo "  $ns: SHARED with host ($ns_id)"
    else
        echo "  $ns: ISOLATED ($ns_id)"
    fi
done

echo ""
echo "Entering all container namespaces..."
exec sudo nsenter \
    --target "$CONTAINER_PID" \
    --mount \
    --uts \
    --ipc \
    --pid \
    --net \
    /bin/sh
```

### Namespace Census Script

```bash
#!/bin/bash
# ns-census.sh - Report namespace statistics for a host

echo "=== Namespace Census ==="
lsns --output NS,TYPE,NPROCS,PID,USER,COMMAND 2>/dev/null

echo ""
echo "=== Namespace Counts by Type ==="
for nstype in pid uts ipc mnt net user cgroup; do
    count=$(lsns -t "$nstype" --noheadings 2>/dev/null | wc -l)
    echo "  $nstype: $count namespaces"
done

echo ""
echo "=== Isolated Container Processes (non-host PID namespace) ==="
HOST_PID_NS=$(readlink /proc/1/ns/pid 2>/dev/null | tr -d 'pid:[]')
for pid_ns_link in /proc/*/ns/pid; do
    pid=$(echo "$pid_ns_link" | grep -oE '[0-9]+' | head -1)
    [ -z "$pid" ] && continue
    ns=$(readlink "$pid_ns_link" 2>/dev/null | tr -d 'pid:[]')
    [ -z "$ns" ] || [ "$ns" = "$HOST_PID_NS" ] && continue
    comm=$(cat "/proc/$pid/comm" 2>/dev/null || echo "unknown")
    echo "  PID $pid ($comm): pid_ns=$ns"
done | sort -u | head -20
```

## Section 9: Time Namespace

The time namespace (added in Linux 5.6) allows containers to have independent views of CLOCK_BOOTTIME and CLOCK_MONOTONIC. This is important for containers restored from checkpoints or migrated between hosts.

```bash
# Verify kernel supports time namespaces (requires Linux 5.6+)
uname -r

# Create a process with a time offset
unshare --time /bin/bash

# Inspect the time namespace offset file
cat /proc/self/timens_offsets
# boottime  0 0
# monotonic 0 0

# The timens_offsets format is: <clock_type> <seconds> <nanoseconds>
# CRIU (checkpoint/restore) uses this to maintain consistent timer
# values when restoring a container on a different host with different uptime.
```

## Section 10: Practical Reference

```bash
# CREATE a new namespace
unshare --<type> [--fork] command

# ENTER an existing namespace
nsenter --target <pid> --<type> command

# LIST all namespaces
lsns [--type <type>]

# CHECK process namespace membership
ls -la /proc/<pid>/ns/

# PERSIST a namespace via bind mount
sudo touch /run/my-netns
sudo mount --bind /proc/self/ns/net /run/my-netns

# RELEASE a persisted namespace
sudo umount /run/my-netns
rm /run/my-netns

# CHECK if two processes share a namespace
# Same inode = same namespace
readlink /proc/PID1/ns/net
readlink /proc/PID2/ns/net

# VERIFY namespace isolation in a container
CPID=$(docker inspect --format '{{.State.Pid}}' mycontainer)
for ns in pid uts ipc mnt net; do
    host=$(readlink /proc/1/ns/$ns)
    cont=$(readlink /proc/$CPID/ns/$ns)
    if [ "$host" = "$cont" ]; then
        echo "WARNING: $ns namespace is SHARED with host"
    else
        echo "OK: $ns namespace is ISOLATED"
    fi
done
```

## Conclusion

Linux namespaces are the foundation of container security and isolation. Understanding each namespace type's scope, the UID/GID mapping mechanics of user namespaces, and how runtimes like containerd and runc orchestrate namespace creation gives you the tools to reason about any container security question from first principles. The most critical security boundary is the user namespace — with proper rootless container configuration, even a container breakout grants no host privileges. Every deviation from the default namespace configuration should be treated as a deliberate security trade-off requiring explicit justification and documentation.
