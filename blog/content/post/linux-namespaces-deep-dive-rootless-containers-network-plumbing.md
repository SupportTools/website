---
title: "Linux Namespaces Deep Dive: Creating Isolated Environments, User Namespace Rootless Containers, and Network Namespace Plumbing"
date: 2031-10-08T00:00:00-05:00
draft: false
tags: ["Linux", "Namespaces", "Containers", "Security", "Networking", "Kernel", "rootless"]
categories:
- Linux
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive technical guide to Linux namespaces: how each of the 8 namespace types works at the kernel level, constructing rootless containers with user namespaces, and manually plumbing network namespaces with veth pairs, bridges, and iptables."
more_link: "yes"
url: "/linux-namespaces-deep-dive-rootless-containers-network-plumbing/"
---

Linux namespaces are the kernel primitive underlying every container runtime in production today. Understanding them at the syscall level—not just as an abstraction surfaced by Docker or containerd—gives platform engineers the mental model to debug container escapes, build custom isolation tools, and reason about the security boundaries between workloads. This guide dissects all eight namespace types, builds a rootless container by hand using only shell and standard utilities, and manually wires network namespaces with veth pairs, bridges, and iptables NAT rules.

<!--more-->

# Linux Namespaces Deep Dive

## Section 1: Namespace Fundamentals

A namespace wraps a global system resource and makes processes within it believe they have their own isolated instance of that resource. The kernel currently defines eight namespace types:

| Namespace | Flag | Isolates |
|---|---|---|
| Mount | `CLONE_NEWNS` | Filesystem mount table |
| UTS | `CLONE_NEWUTS` | Hostname and NIS domain name |
| IPC | `CLONE_NEWIPC` | System V IPC, POSIX message queues |
| PID | `CLONE_NEWPID` | Process ID numbers |
| Network | `CLONE_NEWNET` | Network devices, stacks, ports, routes |
| User | `CLONE_NEWUSER` | User and group IDs |
| Cgroup | `CLONE_NEWCGROUP` | cgroup root |
| Time | `CLONE_NEWTIME` | Boot and monotonic clocks |

Each process on a Linux system belongs to exactly one namespace of each type. The kernel's `clone(2)`, `unshare(2)`, and `setns(2)` syscalls are the three operations that create or switch namespaces.

### Inspecting Current Namespaces

```bash
# Every namespace is exposed as a symlink under /proc/<pid>/ns/
ls -la /proc/$$/ns/

# lrwxrwxrwx cgroup -> cgroup:[4026531835]
# lrwxrwxrwx ipc -> ipc:[4026531839]
# lrwxrwxrwx mnt -> mnt:[4026531841]
# lrwxrwxrwx net -> net:[4026531840]
# lrwxrwxrwx pid -> pid:[4026531836]
# lrwxrwxrwx pid_for_children -> pid:[4026531836]
# lrwxrwxrwx time -> time:[4026531834]
# lrwxrwxrwx time_for_children -> time:[4026531834]
# lrwxrwxrwx user -> user:[4026531837]
# lrwxrwxrwx uts -> uts:[4026531838]

# Compare two processes' namespaces
comm -23 \
  <(ls -la /proc/1/ns | awk '{print $NF}' | sort) \
  <(ls -la /proc/$$/ns | awk '{print $NF}' | sort)
```

The inode number in brackets (`4026531835`) uniquely identifies the namespace. Two processes sharing the same inode share the same namespace.

## Section 2: UTS and IPC Namespaces

These are the simplest namespaces to reason about.

### UTS Namespace

```bash
# Create a new UTS namespace and set a custom hostname
sudo unshare --uts /bin/bash
hostname container-01
hostname   # -> container-01

# In another terminal, verify host is unchanged
hostname   # -> prod-node-07
```

### IPC Namespace

System V shared memory segments and semaphores are isolated per IPC namespace. This prevents processes from one container accessing another's shared memory.

```bash
# Create shared memory in default namespace
ipcmk -M 65536
# Shared memory id: 3

ipcs -m
# ------ Shared Memory Segments --------
# key        shmid      owner     perms  bytes ...
# 0x00000000 3          root      644    65536

# Enter a new IPC namespace — segment is invisible
sudo unshare --ipc /bin/bash
ipcs -m
# ------ Shared Memory Segments --------
# (empty)
```

## Section 3: PID Namespaces

In a new PID namespace, the first process has PID 1 and must serve as an init process that reaps zombie children. The process still has its real PID visible from the parent namespace.

```bash
# Start a PID namespace; the shell appears as PID 1 inside
sudo unshare --pid --fork --mount-proc /bin/bash

echo $$           # -> 1
ps aux            # only shows processes in this namespace
cat /proc/1/status | grep NSpid
# NSpid: 1        <- PID inside namespace
# ... the process has a different PID in the parent namespace
```

### Viewing Nested PIDs from the Host

```bash
# From the host, find the container's init process
# (nspid shows PID as seen from that namespace)
cat /proc/<host-pid>/status | grep NSpid
```

### PID Namespace and /proc

Mounting a fresh `/proc` inside the PID namespace is mandatory for tools like `ps` and `top` to work correctly. Without it, they read the host's `/proc` and show all host processes.

```bash
sudo unshare --pid --fork /bin/bash
mount -t proc proc /proc
ps aux   # now only shows namespace-local processes
```

## Section 4: Mount Namespaces and Pivot Root

Mount namespaces isolate the filesystem mount table. Combined with `pivot_root(2)` or `chroot(2)`, they provide the filesystem isolation of a container.

### Building a Minimal Rootfs

```bash
# Create a minimal root filesystem using Alpine
mkdir -p /tmp/alpine-root
docker export $(docker create alpine) | tar -C /tmp/alpine-root -xf -

# Alternatively, download directly
ALPINE_VERSION=3.20.3
curl -sL https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-${ALPINE_VERSION}-x86_64.tar.gz \
  | tar -C /tmp/alpine-root -xzf -
```

### pivot_root vs chroot

`pivot_root` is the proper container approach because it replaces the root of the entire filesystem tree, preventing access to the old root via `..` traversal. `chroot` only changes the apparent root for a process and can be escaped.

```bash
# Full manual container setup using unshare and pivot_root
ROOTFS=/tmp/alpine-root

sudo unshare --mount --uts --ipc --pid --fork bash <<'INNER'
# Now inside new mount + uts + ipc + pid namespaces

# Bind-mount the new rootfs to itself (pivot_root requires a mount point)
mount --bind "${ROOTFS}" "${ROOTFS}"
cd "${ROOTFS}"

# Create old_root directory inside the new rootfs
mkdir -p old_root

# Perform the pivot
pivot_root . old_root

# Unmount old root to prevent access
umount -l /old_root
rmdir /old_root

# Mount essential virtual filesystems
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t tmpfs tmp /tmp
mount -t devtmpfs dev /dev

# Set hostname
hostname container-01

# Execute the container process
exec /bin/sh
INNER
```

## Section 5: User Namespaces — Rootless Containers

User namespaces are the key to rootless containers. They allow a non-privileged user to appear as UID 0 (root) inside a namespace, while being mapped to a non-privileged UID on the host.

### UID/GID Mapping

```bash
# As a regular user, create a user namespace
unshare --user --map-root-user bash

# Inside the namespace
id   # uid=0(root) gid=0(root)

# But from the host, the process runs as your real UID
# Check /proc/PID/uid_map:
# 0  1000  1  <- namespace uid 0 maps to host uid 1000, range 1
```

### Setting Up Subuid/Subgid for Broader Mappings

For mapping a full UID range (required for containers with multiple UIDs), configure `/etc/subuid` and `/etc/subgid`:

```bash
# /etc/subuid
# username:start_uid:count
mmattox:100000:65536
svcaccount:165536:65536

# /etc/subgid
mmattox:100000:65536
svcaccount:165536:65536
```

Use `newuidmap` and `newgidmap` (setuid helpers) to write the mappings:

```bash
# Start a process in a new user namespace
unshare --user --pid --fork sleep infinity &
CHILD_PID=$!

# Write UID mapping: ns uid 0 -> host uid 1000, range 1
#                    ns uid 1 -> host uid 100000, range 65535
newuidmap $CHILD_PID \
  0 1000 1 \
  1 100000 65535

newgidmap $CHILD_PID \
  0 1000 1 \
  1 100000 65535

# The process can now see UIDs 0-65535 inside its namespace
```

### Rootless Container with User + Mount + PID Namespaces

```bash
#!/bin/bash
# rootless-container.sh — runs a container as an unprivileged user
set -euo pipefail

ROOTFS="${1:-/home/mmattox/containers/alpine}"
COMMAND="${2:-/bin/sh}"
USER_ID=$(id -u)
GROUP_ID=$(id -g)

# newuidmap/newgidmap must be available as setuid helpers
check_helpers() {
  for cmd in newuidmap newgidmap; do
    if ! command -v "${cmd}" &>/dev/null; then
      echo "Missing: ${cmd}. Install uidmap package." >&2
      exit 1
    fi
  done
}
check_helpers

# Use unshare to enter all namespaces
# --user: new user namespace (allows mapping uid 0)
# --map-auto: map current UID to 0 with subuid range for others
# --mount: new mount namespace
# --pid --fork: new PID namespace
# --uts: new UTS namespace
exec unshare \
  --user \
  --map-auto \
  --mount \
  --pid \
  --fork \
  --uts \
  /bin/bash <<INNER
set -e

# Re-mount rootfs as private to avoid propagation
mount --make-rprivate /
mount --bind "${ROOTFS}" "${ROOTFS}"
cd "${ROOTFS}"

mkdir -p old_root
pivot_root . old_root
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t tmpfs dev /dev
mount -t tmpfs tmp /tmp
mount -t devpts devpts /dev/pts \
  -o "newinstance,ptmxmode=0666,gid=5,mode=620"

umount -l /old_root
rmdir /old_root

hostname "rootless-container"
exec ${COMMAND}
INNER
```

## Section 6: Network Namespaces

Network namespaces isolate the full network stack: interfaces, routing tables, iptables rules, socket namespaces. Each new network namespace starts with only the loopback interface (`lo`).

### Creating and Entering a Network Namespace

```bash
# Create a named network namespace (stored in /run/netns/)
sudo ip netns add container-net

# List namespaces
ip netns list
# container-net

# Execute a command inside the namespace
sudo ip netns exec container-net ip link list
# 1: lo: <LOOPBACK> mtu 65536 qdisc noop state DOWN

# Bring up loopback
sudo ip netns exec container-net ip link set lo up
sudo ip netns exec container-net ip addr add 127.0.0.1/8 dev lo
```

### Connecting with veth Pairs

A virtual Ethernet (veth) pair is a bidirectional tunnel: packets sent into one end appear on the other. Move one end into the container namespace.

```bash
# Create a veth pair: veth0 (host) <-> veth1 (container)
sudo ip link add veth0 type veth peer name veth1

# Move veth1 into the container namespace
sudo ip link set veth1 netns container-net

# Configure host side
sudo ip addr add 10.200.0.1/24 dev veth0
sudo ip link set veth0 up

# Configure container side
sudo ip netns exec container-net ip addr add 10.200.0.2/24 dev veth1
sudo ip netns exec container-net ip link set veth1 up
sudo ip netns exec container-net ip link set lo up

# Add default route in container namespace
sudo ip netns exec container-net ip route add default via 10.200.0.1

# Verify connectivity
sudo ip netns exec container-net ping -c2 10.200.0.1
```

### Bridge-Based Multi-Container Networking

In production, multiple containers connect to a single bridge, which routes packets between them and to the host.

```bash
#!/bin/bash
# setup-bridge-network.sh

BRIDGE="br-containers"
SUBNET="10.201.0"
HOST_IP="${SUBNET}.1"
BRIDGE_PREFIX=24

# Create bridge
sudo ip link add "${BRIDGE}" type bridge
sudo ip addr add "${HOST_IP}/${BRIDGE_PREFIX}" dev "${BRIDGE}"
sudo ip link set "${BRIDGE}" up

# Enable IP forwarding
sudo sysctl -w net.ipv4.ip_forward=1

# NAT for outbound traffic from containers
sudo iptables -t nat -A POSTROUTING \
  -s "${SUBNET}.0/${BRIDGE_PREFIX}" \
  ! -d "${SUBNET}.0/${BRIDGE_PREFIX}" \
  -j MASQUERADE

# Allow forwarding to/from bridge
sudo iptables -A FORWARD -i "${BRIDGE}" -j ACCEPT
sudo iptables -A FORWARD -o "${BRIDGE}" \
  -m state --state RELATED,ESTABLISHED -j ACCEPT

echo "Bridge ${BRIDGE} configured with subnet ${SUBNET}.0/${BRIDGE_PREFIX}"

# Function to attach a new container network namespace to the bridge
attach_container() {
  local ns_name="$1"
  local container_ip="$2"
  local veth_host="veth-${ns_name}"
  local veth_container="eth0"

  sudo ip netns add "${ns_name}"
  sudo ip link add "${veth_host}" type veth peer name "${veth_container}"
  sudo ip link set "${veth_host}" master "${BRIDGE}"
  sudo ip link set "${veth_host}" up
  sudo ip link set "${veth_container}" netns "${ns_name}"

  sudo ip netns exec "${ns_name}" ip addr add "${container_ip}/${BRIDGE_PREFIX}" dev "${veth_container}"
  sudo ip netns exec "${ns_name}" ip link set "${veth_container}" up
  sudo ip netns exec "${ns_name}" ip link set lo up
  sudo ip netns exec "${ns_name}" ip route add default via "${HOST_IP}"

  echo "Attached ${ns_name} at ${container_ip}"
}

attach_container "app-01" "${SUBNET}.10"
attach_container "app-02" "${SUBNET}.11"
attach_container "db-01"  "${SUBNET}.20"

# Test inter-container connectivity
sudo ip netns exec app-01 ping -c2 "${SUBNET}.11"
sudo ip netns exec app-01 ping -c2 8.8.8.8
```

## Section 7: Network Policy Enforcement with iptables

Replicating Kubernetes NetworkPolicy semantics at the iptables level:

```bash
#!/bin/bash
# network-policy.sh — restrict app-01 to only reach db-01 on port 5432

APP_IP="10.201.0.10"
DB_IP="10.201.0.20"
BRIDGE="br-containers"

# Create a custom chain for this policy
sudo iptables -N CONTAINER-POLICY 2>/dev/null || true
sudo iptables -F CONTAINER-POLICY

# Allow established connections
sudo iptables -A CONTAINER-POLICY \
  -m state --state RELATED,ESTABLISHED -j ACCEPT

# Allow app-01 -> db-01:5432
sudo iptables -A CONTAINER-POLICY \
  -s "${APP_IP}" -d "${DB_IP}" -p tcp --dport 5432 \
  -j ACCEPT

# Allow ICMP between containers on bridge (for health checks)
sudo iptables -A CONTAINER-POLICY \
  -i "${BRIDGE}" -p icmp -j ACCEPT

# Drop everything else forwarded through bridge
sudo iptables -A CONTAINER-POLICY \
  -i "${BRIDGE}" -j DROP

# Insert the policy chain into FORWARD
sudo iptables -I FORWARD 1 -i "${BRIDGE}" -j CONTAINER-POLICY

# Verify
sudo iptables -L CONTAINER-POLICY -v --line-numbers
```

## Section 8: Cgroup Namespace and Resource Isolation

Cgroup namespaces virtualize the view of `/sys/fs/cgroup`, ensuring a container sees its own cgroup root rather than the host hierarchy.

```bash
# Create cgroup v2 hierarchy for a container
CGROUP_PATH="/sys/fs/cgroup/containers/app-01"
sudo mkdir -p "${CGROUP_PATH}"

# Set memory limit: 512 MB
echo $((512 * 1024 * 1024)) | sudo tee "${CGROUP_PATH}/memory.max"

# Set CPU quota: 0.5 CPU (50000 us per 100000 us period)
echo "50000 100000" | sudo tee "${CGROUP_PATH}/cpu.max"

# Set PID limit
echo 256 | sudo tee "${CGROUP_PATH}/pids.max"

# Assign a process to this cgroup
echo $CONTAINER_PID | sudo tee "${CGROUP_PATH}/cgroup.procs"

# Enter cgroup namespace (container sees its own cgroup root)
sudo nsenter --cgroup --target $CONTAINER_PID \
  cat /sys/fs/cgroup/memory.max
# 536870912   <- sees its own limit as the root
```

## Section 9: Time Namespace

Introduced in Linux 5.6, the time namespace allows containers to have independent views of the `CLOCK_BOOTTIME` and `CLOCK_MONOTONIC` clocks. This is useful for checkpoint/restore (CRIU) and migrating containers between hosts.

```bash
# Check time namespace support
grep CONFIG_TIME_NS /boot/config-$(uname -r)
# CONFIG_TIME_NS=y

# Create a process in a new time namespace
sudo unshare --time /bin/bash

# Adjust the monotonic offset for this namespace
# (requires /proc/PID/timens_offsets)
PID=$$
echo "monotonic  0  500000000" > /proc/${PID}/timens_offsets
# Container's CLOCK_MONOTONIC is now 0.5 seconds ahead of the host
```

## Section 10: nsenter — Joining Existing Namespaces

`nsenter` lets you join the namespaces of a running process, useful for debugging containers without a shell:

```bash
# Join all namespaces of container PID 12345
sudo nsenter --all --target 12345 /bin/sh

# Join only the network and mount namespaces
sudo nsenter --net --mount --target 12345 ip addr

# Join network namespace only (useful for tcpdump inside container)
sudo nsenter --net --target 12345 tcpdump -i eth0 -w /tmp/capture.pcap

# Join via the namespace file directly (process may be gone)
sudo nsenter --net=/run/netns/container-net ip addr
```

## Section 11: Writing a Namespace-Aware Tool in Go

```go
package nstool

import (
    "fmt"
    "os"
    "path/filepath"
    "runtime"
    "syscall"
)

// NamespaceInfo describes one namespace a process belongs to.
type NamespaceInfo struct {
    Type  string
    Inode uint64
    Dev   uint64
}

// GetNamespaces returns all namespace inodes for the given PID.
func GetNamespaces(pid int) (map[string]NamespaceInfo, error) {
    types := []string{"cgroup", "ipc", "mnt", "net", "pid", "time", "user", "uts"}
    result := make(map[string]NamespaceInfo, len(types))

    for _, t := range types {
        path := filepath.Join("/proc", fmt.Sprintf("%d", pid), "ns", t)
        var st syscall.Stat_t
        if err := syscall.Lstat(path, &st); err != nil {
            if os.IsNotExist(err) {
                continue // kernel may not support this ns type
            }
            return nil, fmt.Errorf("stat %s: %w", path, err)
        }
        result[t] = NamespaceInfo{
            Type:  t,
            Inode: st.Ino,
            Dev:   st.Dev,
        }
    }
    return result, nil
}

// EnterNetNS executes fn while joined to the network namespace of pid.
// Must be called from a goroutine that has been locked to an OS thread.
func EnterNetNS(pid int, fn func() error) error {
    runtime.LockOSThread()
    defer runtime.UnlockOSThread()

    // Open current network namespace so we can restore it
    selfNetNS, err := os.Open("/proc/self/ns/net")
    if err != nil {
        return fmt.Errorf("open self netns: %w", err)
    }
    defer selfNetNS.Close()

    // Open target namespace
    targetNS, err := os.Open(
        filepath.Join("/proc", fmt.Sprintf("%d", pid), "ns", "net"),
    )
    if err != nil {
        return fmt.Errorf("open target netns: %w", err)
    }
    defer targetNS.Close()

    // Switch to target namespace using setns(2)
    if err := syscall.Setns(int(targetNS.Fd()), syscall.CLONE_NEWNET); err != nil {
        return fmt.Errorf("setns: %w", err)
    }

    // Execute the function in the target namespace
    fnErr := fn()

    // Restore original namespace
    if err := syscall.Setns(int(selfNetNS.Fd()), syscall.CLONE_NEWNET); err != nil {
        // This is fatal — we cannot recover
        panic(fmt.Sprintf("failed to restore network namespace: %v", err))
    }

    return fnErr
}

// ListInterfaces lists network interfaces visible within a container's netns.
func ListInterfaces(containerPID int) error {
    return EnterNetNS(containerPID, func() error {
        ifaces, err := net.Interfaces()
        if err != nil {
            return err
        }
        for _, iface := range ifaces {
            addrs, _ := iface.Addrs()
            fmt.Printf("  %s: %v\n", iface.Name, addrs)
        }
        return nil
    })
}
```

## Section 12: Security Considerations

### User Namespace Privilege Escalation Risks

User namespaces enable legitimate rootless containers but also provide an unprivileged attack surface. Keep these mitigations in place:

```bash
# Restrict user namespace creation to privileged processes (Debian/Ubuntu)
sudo sysctl -w kernel.unprivileged_userns_clone=0

# On systems with AppArmor, enable the userns restriction profile
sudo aa-enforce /etc/apparmor.d/userns

# Verify current policy
sysctl kernel.unprivileged_userns_clone
# kernel.unprivileged_userns_clone = 0
```

### Seccomp Filtering for Namespace Syscalls

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": ["unshare", "clone"],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 1,
      "comment": "Block namespace creation"
    },
    {
      "names": ["setns"],
      "action": "SCMP_ACT_ERRNO",
      "comment": "Block joining namespaces"
    }
  ]
}
```

### Namespace Audit Logging

```bash
# Audit namespace-related syscalls
sudo auditctl -a always,exit -F arch=b64 \
  -S clone -S unshare -S setns \
  -F key=namespace-ops

sudo ausearch -k namespace-ops --start today | \
  grep -E "(unshare|clone|setns)"
```

## Summary

Linux namespaces provide the isolation kernel primitive for all container runtimes. Understanding each type—from the simplicity of UTS to the complexity of user namespaces with UID mapping—enables engineers to build custom isolation tools, debug container escapes, and reason precisely about the security boundary between workloads. Network namespace plumbing with veth pairs and bridges reveals exactly what runtimes like containerd and crun do under the hood when creating pod sandboxes. The ability to write Go code that joins namespaces via `setns(2)` completes the picture for building namespace-aware observability and debugging tools.
