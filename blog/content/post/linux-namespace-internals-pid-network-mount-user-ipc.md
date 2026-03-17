---
title: "Linux Namespace Internals: PID, Network, Mount, User, and IPC Namespaces"
date: 2029-12-10T00:00:00-05:00
draft: false
tags: ["Linux", "Namespaces", "Containers", "Security", "Kernel", "cgroups", "unshare", "setns"]
categories:
- Linux
- Security
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux namespace implementation, setns and unshare syscalls, container isolation mechanics, namespace-based security hardening, and practical namespace manipulation techniques."
more_link: "yes"
url: "/linux-namespace-internals-pid-network-mount-user-ipc/"
---

Linux namespaces are the kernel primitive that makes containers possible. Docker, containerd, and Kubernetes all build their isolation on top of the seven namespace types: PID, network, mount, UTS, IPC, user, and cgroup. Understanding how namespaces actually work at the kernel level — how they are created, entered, and manipulated — enables you to debug container isolation failures, build custom container runtimes, and implement namespace-based security policies that go beyond what high-level container tools expose.

<!--more-->

## Namespace Fundamentals

A namespace wraps a global kernel resource and makes it appear to processes within the namespace as though they have their own isolated instance of that resource. The kernel tracks namespace membership via the `nsproxy` structure hung off each `task_struct`:

```c
// Simplified kernel structure
struct task_struct {
    // ...
    struct nsproxy *nsproxy;
    // ...
};

struct nsproxy {
    atomic_t count;
    struct uts_namespace    *uts_ns;
    struct ipc_namespace    *ipc_ns;
    struct mnt_namespace    *mnt_ns;
    struct pid_namespace    *pid_ns_for_children;
    struct net              *net_ns;
    struct cgroup_namespace *cgroup_ns;
};
```

Each namespace type has its own kernel structures and reference counting. Namespaces are created by `clone(2)` with namespace flags, `unshare(2)` for the calling process, or by opening `/proc/[pid]/ns/[type]` and calling `setns(2)`.

## Inspecting Namespaces

```bash
# View namespaces for a process
ls -la /proc/1/ns/
# lrwxrwxrwx 1 root root 0 Dec 10 00:00 cgroup -> 'cgroup:[4026531835]'
# lrwxrwxrwx 1 root root 0 Dec 10 00:00 ipc -> 'ipc:[4026531839]'
# lrwxrwxrwx 1 root root 0 Dec 10 00:00 mnt -> 'mnt:[4026531840]'
# lrwxrwxrwx 1 root root 0 Dec 10 00:00 net -> 'net:[4026531992]'
# lrwxrwxrwx 1 root root 0 Dec 10 00:00 pid -> 'pid:[4026531836]'
# lrwxrwxrwx 1 root root 0 Dec 10 00:00 user -> 'user:[4026531837]'
# lrwxrwxrwx 1 root root 0 Dec 10 00:00 uts -> 'uts:[4026531838]'

# The inode number (4026531835) uniquely identifies the namespace
# Two processes sharing the same inode are in the same namespace

# Check if a container process shares namespaces with init
CONTAINER_PID=$(docker inspect --format '{{.State.Pid}}' mycontainer)
ls -la /proc/1/ns/net /proc/${CONTAINER_PID}/ns/net
# Different inodes confirm network isolation
```

The `/proc/[pid]/ns/` files are magic symlinks — they keep the namespace alive even after all processes using it exit, as long as the file descriptor is open. This is how `nsenter` and `ip netns exec` retain named network namespaces.

## PID Namespaces

A PID namespace isolates the process ID number space. Processes in a child PID namespace have two PIDs: one within the namespace (starting at 1) and one in the parent namespace. PID 1 inside a container receives SIGKILL-equivalent behavior if it exits — the kernel signals all other processes in the namespace.

```bash
# Create a new PID namespace and run bash inside it
unshare --pid --fork --mount-proc bash

# PID 1 inside the namespace
echo $$
# 1

# Can't see host processes
ps aux
# Only sees processes in this namespace
```

### Creating a PID Namespace Programmatically

```c
#define _GNU_SOURCE
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>

#define STACK_SIZE (1024 * 1024)

int child_func(void *arg) {
    printf("Child PID in new namespace: %d\n", getpid()); // Will be 1
    execv("/bin/bash", (char *[]){"bash", NULL});
    return 0;
}

int main() {
    char *stack = malloc(STACK_SIZE);
    char *stack_top = stack + STACK_SIZE;

    // CLONE_NEWPID creates new PID namespace
    pid_t pid = clone(child_func, stack_top,
                      CLONE_NEWPID | SIGCHLD, NULL);
    printf("Child PID in host namespace: %d\n", pid);

    waitpid(pid, NULL, 0);
    free(stack);
    return 0;
}
```

### Container PID 1 Responsibility

In containers, PID 1 must reap zombie processes — children that have exited but whose exit status hasn't been collected. When a container uses `ENTRYPOINT ["/myapp"]`, the application becomes PID 1 and must handle `SIGCHLD` and `waitpid`. Applications not designed for this role should use `tini` or the Kubernetes `shareProcessNamespace` feature:

```yaml
# Pod spec with process namespace sharing (debugging)
spec:
  shareProcessNamespace: true
  containers:
  - name: app
    image: myapp:1.0
  - name: debug
    image: busybox
    command: ["sh"]
    stdin: true
    tty: true
```

## Network Namespaces

Network namespaces provide independent network stacks: interfaces, routing tables, iptables rules, and socket tables. Each container gets its own loopback interface and veth pair connected to the host bridge.

```bash
# Create a named network namespace (persisted in /run/netns/)
ip netns add mynet

# Create a veth pair
ip link add veth0 type veth peer name veth1

# Move veth1 into the namespace
ip link set veth1 netns mynet

# Configure the host side
ip addr add 192.168.100.1/24 dev veth0
ip link set veth0 up

# Configure the namespace side
ip netns exec mynet ip addr add 192.168.100.2/24 dev veth1
ip netns exec mynet ip link set veth1 up
ip netns exec mynet ip link set lo up
ip netns exec mynet ip route add default via 192.168.100.1

# Run a process in the network namespace
ip netns exec mynet ping 192.168.100.1

# List network interfaces visible from namespace
ip netns exec mynet ip addr show
```

### Entering a Container's Network Namespace

```bash
# Get container PID
CONTAINER_PID=$(docker inspect -f '{{.State.Pid}}' mycontainer)

# Enter the network namespace using nsenter
nsenter --target $CONTAINER_PID --net -- ip addr show
nsenter --target $CONTAINER_PID --net -- ss -tlnp
nsenter --target $CONTAINER_PID --net -- tcpdump -i eth0

# From Go: using setns syscall
```

```go
package nsutils

import (
    "fmt"
    "os"
    "runtime"
    "golang.org/x/sys/unix"
)

// EnterNetNS enters the network namespace of the given PID
// Must be called from a goroutine that is locked to an OS thread
func EnterNetNS(targetPID int, f func() error) error {
    // Lock the goroutine to the current OS thread
    // setns applies to the calling thread, not the process
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Save current network namespace
    selfNetNS, err := os.Open("/proc/self/ns/net")
    if err != nil {
        return fmt.Errorf("opening self net ns: %w", err)
    }
    defer selfNetNS.Close()

    // Open target namespace
    targetNetNS, err := os.Open(fmt.Sprintf("/proc/%d/ns/net", targetPID))
    if err != nil {
        return fmt.Errorf("opening target net ns: %w", err)
    }
    defer targetNetNS.Close()

    // Enter target namespace
    if err := unix.Setns(int(targetNetNS.Fd()), unix.CLONE_NEWNET); err != nil {
        return fmt.Errorf("setns to target: %w", err)
    }

    // Execute function in target namespace
    execErr := f()

    // Restore original namespace
    if err := unix.Setns(int(selfNetNS.Fd()), unix.CLONE_NEWNET); err != nil {
        return fmt.Errorf("restoring net ns: %w", err)
    }

    return execErr
}
```

## Mount Namespaces

Mount namespaces isolate the filesystem tree visible to a process. Container images use mount namespaces combined with overlayfs to present the union of image layers as a single filesystem.

```bash
# Create a new mount namespace
unshare --mount bash

# Mounts made here are invisible to the host
mount -t tmpfs tmpfs /tmp/isolated
# Host cannot see this mount

# Inspect mount propagation
cat /proc/self/mountinfo
# Each line: mount_id parent_id major:minor root mount_point options
# propagation type: shared, slave, private, unbindable
```

### Mount Propagation

Mount propagation controls whether mounts in one namespace appear in others:

```bash
# Make a mount point private (changes don't propagate)
mount --make-private /mnt/data

# Make a mount point shared (changes propagate to peers)
mount --make-shared /mnt/shared

# Make a mount point a slave (receives propagation but doesn't send)
mount --make-slave /mnt/receive

# Kubernetes uses slave propagation for hostPath volumes
# so container mounts don't escape to the host
```

### Pivot Root vs. chroot

Containers use `pivot_root` rather than `chroot` to change the root filesystem. `pivot_root` is more secure because it cannot be escaped via `chroot` tricks:

```go
// Simplified container root setup (requires new mount namespace)
func setupContainerRoot(newRoot string) error {
    // Bind mount the new root to itself (required for pivot_root)
    if err := unix.Mount(newRoot, newRoot, "", unix.MS_BIND|unix.MS_REC, ""); err != nil {
        return fmt.Errorf("bind mounting new root: %w", err)
    }

    // Create put_old directory for the old root
    putOld := filepath.Join(newRoot, ".old_root")
    if err := os.MkdirAll(putOld, 0700); err != nil {
        return fmt.Errorf("creating put_old: %w", err)
    }

    // Pivot to new root
    if err := unix.PivotRoot(newRoot, putOld); err != nil {
        return fmt.Errorf("pivot_root: %w", err)
    }

    // Change working directory to new root
    if err := os.Chdir("/"); err != nil {
        return fmt.Errorf("chdir to /: %w", err)
    }

    // Unmount and remove old root
    if err := unix.Unmount("/.old_root", unix.MNT_DETACH); err != nil {
        return fmt.Errorf("unmounting old root: %w", err)
    }
    return os.Remove("/.old_root")
}
```

## User Namespaces

User namespaces map UIDs and GIDs between inside and outside a namespace. A process can be UID 0 (root) inside the namespace but map to an unprivileged UID on the host. This enables rootless containers:

```bash
# Create a user namespace mapping current user to UID 0 inside
unshare --user --map-root-user bash

# Inside: we appear to be root
id
# uid=0(root) gid=0(root) groups=0(root)

# But from host, we're still the original user
cat /proc/self/uid_map
# 0  1000  1  (inside_uid  host_uid  range)
```

### User Namespace UID Maps

```bash
# /proc/[pid]/uid_map format:
# inside_uid_start  host_uid_start  length

# Full mapping for rootless container (newuidmap tool handles this)
cat /proc/$CONTAINER_PID/uid_map
# 0    1000    1      # root inside = host user 1000
# 1    100000  65536  # UIDs 1-65536 inside = 100000-165536 on host
```

User namespaces are the foundation of rootless containers in Podman and newer Docker configurations. When combined with PID, network, and mount namespaces, they provide strong isolation without requiring root on the host.

## IPC Namespaces

IPC namespaces isolate System V IPC objects (message queues, semaphores, shared memory) and POSIX message queues:

```bash
# Show host IPC resources
ipcs -a

# Create a new IPC namespace
unshare --ipc bash

# Create a shared memory segment inside — invisible to host
ipcmk -M 1024
ipcs -m  # visible here

# From host, original ipcs -m doesn't show the container's segment
```

Kubernetes enables IPC namespace sharing between containers in a pod via `spec.hostIPC: true` (shares the host's IPC namespace) or by default (all containers in a pod share an IPC namespace, enabling POSIX shared memory between them).

## UTS Namespaces

UTS namespaces isolate the hostname and NIS domain name:

```bash
# Create a UTS namespace
unshare --uts bash

# Change hostname inside — host is unaffected
hostname mycontainer
hostname
# mycontainer

# Host still has original hostname
# (verify from another terminal: hostname)
```

This is why each container can have its own hostname. The `POD_NAME` environment variable injected by Kubernetes corresponds to the hostname set in the pod's UTS namespace.

## Namespace Security Hardening

### Capabilities in User Namespaces

User namespaces grant a full set of capabilities within the namespace, but those capabilities only apply to resources within that namespace. This is intentional but has been the source of kernel privilege escalation CVEs:

```bash
# Check capabilities inside a user namespace
unshare --user --map-root-user -- capsh --print
# Current: cap_chown, cap_dac_override, ... (all capabilities)
# But these only apply within the namespace

# Disable user namespaces for untrusted workloads (system-wide)
echo 0 > /proc/sys/kernel/unprivileged_userns_clone  # Debian/Ubuntu
sysctl -w user.max_user_namespaces=0  # More portable
```

### Seccomp and Namespaces

Combine seccomp with namespace restrictions to prevent namespace-based attacks:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": ["unshare"],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 1
    },
    {
      "names": ["clone"],
      "action": "SCMP_ACT_ERRNO",
      "args": [
        {
          "index": 0,
          "value": 2114060288,
          "op": "SCMP_CMP_MASKED_EQ"
        }
      ]
    }
  ]
}
```

This seccomp profile blocks `unshare` entirely and blocks `clone` when namespace flags are set, preventing a compromised container from creating new namespaces that might enable privilege escalation.

### Kubernetes Namespace Mapping to Linux Namespaces

```yaml
# Full isolation for security-sensitive workloads
spec:
  hostPID: false         # Use own PID namespace (default)
  hostNetwork: false     # Use own network namespace (default)
  hostIPC: false         # Use own IPC namespace (default)
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      capabilities:
        drop:
        - ALL
```

Understanding Linux namespaces at this depth enables you to reason precisely about what a container can and cannot see, debug isolation failures that appear as mysterious connectivity or permission errors, and design security policies that address the actual kernel mechanisms rather than high-level abstractions.
