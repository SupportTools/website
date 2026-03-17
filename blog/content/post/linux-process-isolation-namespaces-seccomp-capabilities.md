---
title: "Linux Process Isolation: namespaces, seccomp, and capabilities deep dive"
date: 2029-06-29T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Namespaces", "seccomp", "Capabilities", "Containers", "Kernel"]
categories: ["Linux", "Security", "Containers"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive deep dive into Linux process isolation mechanisms: user namespaces, capability bounding sets, no-new-privs bit, ambient capabilities, seccomp profiles, and how containers leverage these primitives."
more_link: "yes"
url: "/linux-process-isolation-namespaces-seccomp-capabilities/"
---

Containers are not a magic isolation technology — they are a composition of Linux kernel primitives assembled by a container runtime. Understanding namespaces, capabilities, and seccomp individually is essential for building and auditing secure container deployments. This post dissects each mechanism, shows how they interact, and explains the security properties (and limits) each provides.

<!--more-->

# Linux Process Isolation: namespaces, seccomp, and capabilities deep dive

## Why the Isolation Stack Matters

A container runtime like containerd or crun constructs an isolated environment by combining:

1. **Namespaces** — restrict what the process can see (filesystems, networks, PIDs, users)
2. **Capabilities** — restrict what the process can do as root within its namespace
3. **seccomp** — restrict which syscalls the process can make
4. **cgroups** — restrict how much of the host's resources the process can consume
5. **LSMs (AppArmor/SELinux)** — mandatory access control on top of everything

This post focuses on namespaces, capabilities, and seccomp. Each layer provides defense-in-depth: breaking through one layer still leaves the others.

## Section 1: Linux Namespaces

A namespace wraps a global system resource in an abstraction so that processes within the namespace see an isolated instance of that resource. Linux provides eight namespace types as of kernel 5.6.

### Namespace Types

| Namespace | Flag | Isolates |
|-----------|------|----------|
| Mount | CLONE_NEWNS | Filesystem mount tree |
| UTS | CLONE_NEWUTS | Hostname and NIS domain name |
| IPC | CLONE_NEWIPC | System V IPC, POSIX message queues |
| PID | CLONE_NEWPID | Process ID number space |
| Network | CLONE_NEWNET | Network devices, stacks, ports |
| User | CLONE_NEWUSER | User and group ID number spaces |
| Cgroup | CLONE_NEWCGROUP | Cgroup root directory |
| Time | CLONE_NEWTIME | Boot and monotonic clocks (kernel 5.6+) |

### Creating Namespaces with unshare

```bash
# Create new UTS, IPC, PID, mount, and network namespaces
sudo unshare --uts --ipc --pid --mount --net --fork bash

# Inside: hostname is isolated
hostname container-host
hostname
# container-host

# From host: still original hostname (separate UTS namespace)
```

### PID Namespaces

In a PID namespace, the first process has PID 1. It becomes the init process for that namespace and must reap zombie children. If PID 1 dies, all other processes in the namespace are killed.

```bash
# Inspect PID namespaces
ls -la /proc/self/ns/pid
# lrwxrwxrwx 1 root root 0 ... /proc/self/ns/pid -> pid:[4026531836]

# See what namespace a process is in
ls -la /proc/<PID>/ns/

# Enter an existing namespace (nsenter)
nsenter --target <container-PID> --pid --mount --uts --ipc --net bash
```

Checking namespaces programmatically in Go:

```go
package main

import (
    "fmt"
    "os"
    "syscall"
)

func getNS(nsType string) (uint64, error) {
    path := fmt.Sprintf("/proc/self/ns/%s", nsType)
    var stat syscall.Stat_t
    if err := syscall.Stat(path, &stat); err != nil {
        return 0, err
    }
    return stat.Ino, nil
}

func main() {
    for _, ns := range []string{"pid", "net", "mnt", "uts", "ipc", "user"} {
        ino, err := getNS(ns)
        if err != nil {
            fmt.Fprintf(os.Stderr, "namespace %s: %v\n", ns, err)
            continue
        }
        fmt.Printf("%-6s namespace inode: %d\n", ns, ino)
    }
}
```

### User Namespaces: The Most Powerful and Dangerous

User namespaces allow a process to have a full set of capabilities within the namespace while having no privileges on the host. This is what enables rootless containers.

```bash
# Create a user namespace as unprivileged user
unshare --user bash

# Inside: I appear to be root
id
# uid=0(root) gid=0(root)

# View UID map for this process
cat /proc/self/uid_map
# 0   1000   1  (container UID 0 = host UID 1000, for 1 mapping)
```

#### UID/GID Mapping

```bash
# View UID map for a container process
# Format: container-start  host-start  count
cat /proc/<container-PID>/uid_map
# 0       100000      65536
# container UIDs 0-65535 map to host UIDs 100000-165535

# Configure subuid/subgid for rootless containers
cat /etc/subuid
# mmattox:100000:65536

cat /etc/subgid
# mmattox:100000:65536
```

#### Security Implications of User Namespaces

User namespaces significantly expand the attack surface because unprivileged users can create namespaces and exercise capabilities within them. Several historical kernel vulnerabilities were exploitable via user namespace creation by unprivileged users.

Mitigation — restrict who can create user namespaces:

```bash
# Ubuntu/Debian: restrict unprivileged user namespace creation
echo 0 > /proc/sys/kernel/unprivileged_userns_clone

# Red Hat/CentOS (kernel 6.1+)
sysctl -w kernel.unprivileged_userns_clone=0

# Persist in sysctl.conf
echo 'kernel.unprivileged_userns_clone=0' >> /etc/sysctl.d/99-security.conf
```

### Network Namespaces and veth Pairs

```bash
# Create a network namespace
ip netns add myns

# Create a veth pair
ip link add veth0 type veth peer name veth1

# Move one end into the namespace
ip link set veth1 netns myns

# Configure inside the namespace
ip netns exec myns ip addr add 192.168.100.2/24 dev veth1
ip netns exec myns ip link set veth1 up
ip netns exec myns ip link set lo up

# Configure the host end
ip addr add 192.168.100.1/24 dev veth0
ip link set veth0 up

# Enable IP forwarding and NAT for internet access
echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -A POSTROUTING -s 192.168.100.0/24 -o eth0 -j MASQUERADE
```

This is the same sequence a container runtime performs when setting up container networking, minus the overlay network abstraction.

## Section 2: Linux Capabilities

The traditional Unix model has two privilege levels: privileged (UID 0) and unprivileged. Capabilities divide the privileges of root into distinct units that can be independently granted or removed.

### Key Capabilities Relevant to Containers

```
CAP_CHOWN             Change file UIDs and GIDs
CAP_DAC_OVERRIDE      Bypass DAC (discretionary access control) checks
CAP_FOWNER            Bypass checks for operations on owned files
CAP_KILL              Send signals to any process
CAP_NET_BIND_SERVICE  Bind to ports below 1024
CAP_NET_RAW           Use raw sockets
CAP_SETGID            Set any GID
CAP_SETUID            Set any UID
CAP_SYS_ADMIN         mount, ioctl, ptrace, and many more
CAP_SYS_PTRACE        ptrace any process
CAP_SYS_CHROOT        Use chroot()
CAP_NET_ADMIN         Configure network interfaces, routes, firewall
CAP_SYS_MODULE        Load/unload kernel modules
```

`CAP_SYS_ADMIN` is sometimes called "the new root" because it grants so many privileges that having it is nearly equivalent to being root. Containers should never run with `CAP_SYS_ADMIN` unless absolutely required.

### Capability Sets

Each process has five capability sets:

| Set | Description |
|-----|-------------|
| Permitted | Superset of effective; caps the process can use |
| Effective | Currently active capabilities |
| Inheritable | Capabilities preserved across execve() |
| Bounding | Limits what can be in Permitted; can only be reduced |
| Ambient | Inherited by unprivileged executables |

```bash
# Inspect capabilities of a process
cat /proc/self/status | grep Cap
# CapInh: 0000000000000000
# CapPrm: 0000000000000000
# CapEff: 0000000000000000
# CapBnd: 000001ffffffffff
# CapAmb: 0000000000000000

# Decode capability bitmask
capsh --decode=000001ffffffffff

# Display current process capabilities in human-readable form
capsh --print
```

### Capability Bounding Set

The bounding set is the ceiling for the permitted set. Even if a binary has file capabilities set, it cannot acquire capabilities not in its bounding set.

Dropping capabilities using prctl in a Go process:

```go
package main

import (
    "fmt"
    "syscall"
    "unsafe"
)

const (
    PR_CAPBSET_DROP = 24
    CAP_NET_RAW     = 13
    CAP_SYS_ADMIN   = 21
)

func dropBoundingCap(cap uintptr) error {
    _, _, errno := syscall.RawSyscall(
        syscall.SYS_PRCTL,
        PR_CAPBSET_DROP,
        cap,
        0,
    )
    if errno != 0 {
        return fmt.Errorf("prctl PR_CAPBSET_DROP(%d): %w", cap, errno)
    }
    return nil
}

func hardenProcess() error {
    // Drop capabilities not needed by a typical web server
    capsToRemove := []uintptr{
        CAP_NET_RAW,    // raw sockets
        CAP_SYS_ADMIN,  // broad admin operations
    }
    for _, cap := range capsToRemove {
        if err := dropBoundingCap(cap); err != nil {
            return fmt.Errorf("dropping cap %d: %w", cap, err)
        }
    }
    return nil
}

// Suppress unused import warning
var _ = unsafe.Sizeof
```

### No-New-Privs Bit

The `no_new_privs` flag prevents the process and its descendants from gaining additional privileges through setuid binaries or file capabilities. It is irreversible.

Setting no-new-privs in Go:

```go
package main

import (
    "fmt"
    "syscall"
)

const PR_SET_NO_NEW_PRIVS = 38

func setNoNewPrivs() error {
    _, _, errno := syscall.RawSyscall(
        syscall.SYS_PRCTL,
        PR_SET_NO_NEW_PRIVS,
        1, 0,
    )
    if errno != 0 {
        return fmt.Errorf("prctl PR_SET_NO_NEW_PRIVS: %w", errno)
    }
    return nil
}
```

In Kubernetes:

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    image: myapp:latest
    securityContext:
      allowPrivilegeEscalation: false   # sets no_new_privs
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 10000
      runAsGroup: 10000
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE
```

### Ambient Capabilities

Ambient capabilities allow unprivileged executables to inherit capabilities from a parent process without the executable having file capabilities set.

```bash
# Run a service as non-root with NET_BIND_SERVICE
setpriv --ambient-caps +net_bind_service \
        --reuid 1000 --regid 1000 \
        nginx -g 'daemon off;'

# Verify ambient capabilities in the process
grep CapAmb /proc/$(pgrep nginx)/status
```

Setting ambient capabilities programmatically:

```go
package main

import (
    "fmt"
    "syscall"
)

const (
    PR_CAP_AMBIENT       = 47
    PR_CAP_AMBIENT_RAISE = 2
    PR_SET_KEEPCAPS      = 8
    CAP_NET_BIND_SERVICE = 10
)

// setAmbientCap raises a capability into the ambient set.
// The capability must already be in both the inheritable and permitted sets.
func setAmbientCap(cap uintptr) error {
    // Keep caps across setuid
    if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, PR_SET_KEEPCAPS, 1, 0); errno != 0 {
        return fmt.Errorf("PR_SET_KEEPCAPS: %w", errno)
    }
    // Raise cap into ambient set
    if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, cap); errno != 0 {
        return fmt.Errorf("PR_CAP_AMBIENT_RAISE(%d): %w", cap, errno)
    }
    return nil
}
```

## Section 3: seccomp — Syscall Filtering

seccomp (Secure Computing Mode) restricts the system calls a process can make. The kernel evaluates a BPF program for each syscall and either allows it, blocks it, or kills the process.

### seccomp Modes

**Mode 1 (SECCOMP_MODE_STRICT)**: Only allows `read`, `write`, `_exit`, and `sigreturn`. Extremely restrictive, rarely used directly.

**Mode 2 (SECCOMP_MODE_FILTER)**: Attaches a BPF program that is evaluated for each syscall. This is what containers use.

### The Docker/OCI Default seccomp Profile

The default seccomp profile for containers blocks roughly 44 syscalls out of ~435 available, including:

```
add_key           kexec_load        mount
clone             keyctl            nfsservctl
create_module     lookup_dcookie    open_by_handle_at
delete_module     mbind             pivot_root
finit_module      migrate_pages     process_vm_readv
get_kernel_syms   mincore           process_vm_writev
```

The most dangerous blocked syscalls:
- `kexec_load` / `kexec_file_load` — load a new kernel (complete host takeover)
- `create_module` / `delete_module` / `init_module` / `finit_module` — kernel module operations
- `ptrace` — trace other processes
- `mount` — mount filesystems

### Writing a Custom seccomp Profile

A minimal allowlist profile for a web server:

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
        "bind", "brk", "close", "connect",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_wait",
        "exit", "exit_group",
        "fcntl", "fstat", "futex",
        "getdents64", "getpeername", "getpid", "getppid",
        "getsockname", "getsockopt", "gettid", "gettimeofday",
        "listen", "lseek",
        "mmap", "mprotect", "munmap",
        "nanosleep", "newfstatat",
        "openat",
        "poll", "pread64", "pwrite64",
        "read", "recvfrom", "recvmsg",
        "rt_sigaction", "rt_sigprocmask", "rt_sigreturn",
        "select", "sendmsg", "sendto",
        "set_robust_list", "setsockopt", "sigaltstack",
        "socket", "socketpair",
        "write"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

### Generating a Profile with strace

```bash
# Profile an application's syscalls
strace -f -e trace=all -o strace.out ./myapp

# Extract unique syscall names
grep -oP '^\w+(?=\()' strace.out | sort -u > syscalls.txt

# Using seccomp-tools (Ruby gem)
gem install seccomp-tools
seccomp-tools dump ./myapp
```

### Applying seccomp in Kubernetes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/myapp-seccomp.json
  containers:
  - name: app
    image: myapp:latest
    securityContext:
      seccompProfile:
        type: RuntimeDefault
```

Distributing custom profiles via DaemonSet:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: seccomp-profile-deployer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: seccomp-deployer
  template:
    metadata:
      labels:
        app: seccomp-deployer
    spec:
      initContainers:
      - name: install-profile
        image: busybox:1.36
        command: ["/bin/sh", "-c"]
        args:
        - |
          mkdir -p /host/seccomp/profiles
          cp /profiles/myapp-seccomp.json /host/seccomp/profiles/
        volumeMounts:
        - name: host-seccomp
          mountPath: /host/seccomp
        - name: profiles
          mountPath: /profiles
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
      volumes:
      - name: host-seccomp
        hostPath:
          path: /var/lib/kubelet/seccomp
      - name: profiles
        configMap:
          name: seccomp-profiles
```

### seccomp and Capability Interaction

seccomp filters run before capability checks in the kernel. The evaluation order is:

```
User Process
    |
    v
seccomp filter (BPF program evaluated in kernel)
    |  allowed
    v
Capability check (is CAP_X in effective set?)
    |  permitted
    v
Namespace check (is operation valid in this namespace?)
    |  valid
    v
Kernel executes syscall
```

A syscall blocked by seccomp is blocked regardless of capabilities. Even a container that somehow gains elevated capabilities cannot escape if the relevant syscall is blocked by seccomp.

## Section 4: The Container Security Model in Practice

### What a Container Runtime Does at Startup

When containerd runs a container, it performs roughly these steps in order:

```
1. Clone with CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET
2. (Optionally) CLONE_NEWUSER for rootless containers
3. Set up UID/GID mappings via newuidmap/newgidmap
4. Mount the overlay filesystem for the container's rootfs
5. Bind-mount /dev, /proc, /sys into the container
6. pivot_root into the container's rootfs
7. Apply capability bounding set (drop all but required)
8. Apply seccomp filter
9. Set no_new_privs via prctl()
10. Set UID/GID to the container user
11. exec() the container entrypoint
```

Steps 7-10 occur in this order deliberately: capabilities and seccomp must be set before dropping privileges. After exec(), the seccomp filter is in place for all application code.

### Kubernetes Pod Security Standards

Kubernetes v1.25 replaced PodSecurityPolicy with Pod Security Standards enforced via the Pod Security Admission controller:

```yaml
# Label a namespace with a security standard
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

The **restricted** profile requires:
- `runAsNonRoot: true`
- `allowPrivilegeEscalation: false`
- `seccompProfile.type: RuntimeDefault` or `Localhost`
- All capabilities dropped
- No `hostPID`, `hostIPC`, `hostNetwork`
- No `privileged: true`

### Auditing Container Security Posture

```bash
# Check what capabilities a running container has
docker inspect <container> --format '{{.HostConfig.CapAdd}}'
docker inspect <container> --format '{{.HostConfig.CapDrop}}'

# Check seccomp profile applied to container
docker inspect <container> --format '{{.HostConfig.SecurityOpt}}'

# From inside a container: what capabilities do I have?
cat /proc/self/status | grep Cap
capsh --print

# Check if no_new_privs is set
cat /proc/self/status | grep NoNewPrivs

# CIS benchmark checks with kube-bench
kube-bench run --targets node

# Container image security scanning with trivy
trivy image --security-checks vuln,config myapp:latest
```

### What the Isolation Does NOT Prevent

Understanding the limits of isolation helps reason about defense-in-depth requirements:

**Namespace isolation does NOT prevent:**
- Exploiting kernel vulnerabilities (all namespaces share the same kernel)
- Side-channel attacks (Spectre, Meltdown, cache timing attacks)
- CPU resource exhaustion (that is cgroups' job)
- Network-level attacks if NET_RAW capability is available

**Capabilities do NOT prevent:**
- Syscalls that do not require capabilities (read, write, most socket operations)
- Exploiting kernel vulnerabilities through allowed syscalls
- Userspace exploits (memory corruption in the container process)

**seccomp does NOT prevent:**
- Attacks using allowed syscalls
- Kernel vulnerabilities in allowed syscall handlers

This is why defense-in-depth is mandatory. Additional layers (AppArmor, SELinux, gVisor, Kata Containers) add meaningful security for higher-risk workloads.

## Section 5: Tooling Reference

```bash
# Namespace tools
unshare --help          # create new namespaces
nsenter --help          # enter existing namespaces
lsns                    # list all namespaces on the system
lsns -t net             # list network namespaces only
ip netns list           # list network namespaces managed by iproute2

# Capability tools
capsh --print           # print current capabilities
capsh --decode=MASK     # decode hex capability mask
getcap /path/to/binary  # read file capabilities
setcap 'cap_net_bind_service+ep' /path/to/binary
captest                 # test capabilities

# seccomp tools
seccomp-tools dump CMD  # dump seccomp filter applied to a process
scmp_sys_resolver NAME  # resolve syscall name to number

# Process inspection
cat /proc/PID/status    # all process attributes including capabilities
cat /proc/PID/ns/       # namespace links
cat /proc/PID/cgroup    # cgroup membership
```

## Conclusion

Linux process isolation is not a single mechanism but a layered system where each component addresses a different threat model. Namespaces restrict visibility and address space sharing. Capabilities bound the power of root within those namespaces. The no-new-privs bit prevents privilege escalation through setuid binaries. Ambient capabilities allow capability delegation to unprivileged executables. And seccomp provides the final line of defense by restricting the kernel's attack surface to the syscalls the application actually needs.

For production container deployments, the minimum security posture should be:
- Drop all capabilities and add back only what is needed
- Enable `allowPrivilegeEscalation: false`
- Apply `RuntimeDefault` seccomp profile at minimum
- Run as non-root user
- Use user namespaces for rootless runtimes when possible
- Enforce via Pod Security Standards at the namespace level

The kernel attack surface reduction from a proper seccomp profile plus capability restrictions is significant. A container with no capabilities and a tight seccomp profile is a much harder target than one that merely runs as a non-root user.
