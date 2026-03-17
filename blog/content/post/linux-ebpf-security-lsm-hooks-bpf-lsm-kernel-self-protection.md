---
title: "Linux eBPF Security: LSM Hooks, BPF-LSM, and Kernel Self-Protection"
date: 2030-04-23T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "BPF-LSM", "Security", "LSM", "Container Security", "Kernel", "Runtime Security"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to BPF-LSM for runtime security policies: writing LSM hook programs in C and Go, enforcement vs audit mode, MAC policy implementation with eBPF, container runtime security integration, and kernel self-protection mechanisms."
more_link: "yes"
url: "/linux-ebpf-security-lsm-hooks-bpf-lsm-kernel-self-protection/"
---

The Linux Security Module (LSM) framework has historically required kernel patches to add new security policies. AppArmor, SELinux, and Tomoyo are compiled into or loaded as kernel modules. BPF-LSM changes this: it allows eBPF programs to attach to any of the 240+ LSM hook points in the kernel, implementing custom security policies without recompiling the kernel or writing a kernel module. This means you can express a security policy in C (or Go via libbpf-go) and load it at runtime, attaching to precisely the kernel events relevant to your threat model. This guide covers the BPF-LSM architecture, writing security enforcement programs, auditing vs enforcement modes, container isolation policies, and integration with production security stacks.

<!--more-->

## BPF-LSM Architecture

### LSM Hook Points

The Linux kernel calls LSM hooks at security-critical operations. BPF-LSM allows attaching `BPF_PROG_TYPE_LSM` programs to these hooks:

```
Process operations:
  security_task_alloc         - new task creation
  security_bprm_check         - execve() permission check
  security_ptrace_access_check - ptrace() request
  
File operations:
  security_inode_create       - file creation
  security_inode_unlink       - file deletion
  security_file_open          - file open
  security_file_ioctl         - ioctl() call
  
Network operations:
  security_socket_create      - socket() call
  security_socket_connect     - connect() call
  security_socket_bind        - bind() call
  security_socket_sendmsg     - sendmsg()
  
Memory operations:
  security_mmap_addr          - mmap() address check
  security_mmap_file          - mmap() file mapping
  
IPC operations:
  security_msg_queue_msgsnd   - SysV message queue send
  security_shm_shmat          - shared memory attach
  
Mount/filesystem:
  security_sb_mount           - mount() call
  security_path_truncate      - file truncation

BPF:
  security_bpf                - BPF system call
  security_bpf_prog           - BPF program load
```

### BPF-LSM vs Other Security Mechanisms

```
Mechanism    Scope           Performance    Flexibility    Complexity
SELinux      System-wide     Medium         Low            Very high
AppArmor     Process/path    Medium         Medium         Medium
Seccomp      Syscall filter  High           Low            Low
BPF-LSM      Any LSM hook   High           Very high      Medium
Falco        Runtime audit   Medium         High           Low (rules)
```

### Kernel Requirements

```bash
# Check BPF-LSM support
cat /boot/config-$(uname -r) | grep -E "BPF_LSM|CONFIG_LSM"
# CONFIG_BPF_LSM=y
# CONFIG_LSM="landlock,lockdown,yama,integrity,apparmor,bpf"
# Note: "bpf" must be in the LSM list

# Runtime check
cat /sys/kernel/security/lsm
# lockdown,capability,yama,apparmor,bpf

# Check BPF program type support
bpftool prog help | grep lsm
# lsm

# Kernel version requirements
# BPF-LSM: >= 5.7
# sleepable BPF-LSM hooks: >= 5.11
# CO-RE (Compile Once, Run Everywhere): >= 5.8
uname -r
```

## Writing BPF-LSM Programs

### Denying execve() of Specific Binaries

```c
/* restrict-exec.bpf.c - BPF-LSM program to deny execve of /usr/bin/curl */
/* Build: clang -O2 -g -target bpf -D__TARGET_ARCH_x86 \
 *        -I/usr/include/bpf -c restrict-exec.bpf.c -o restrict-exec.bpf.o
 */

#include "vmlinux.h"      /* generated kernel BTF header */
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

/* Map: denied_executables - set of inodes we want to deny */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 256);
    __type(key, __u64);    /* inode number */
    __type(value, __u8);
} denied_inodes SEC(".maps");

/* Audit log map: ring buffer for security events */
struct security_event {
    __u32 pid;
    __u32 uid;
    __u64 inode;
    char  comm[16];
    char  filename[128];
    __u8  denied;
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 4096 * 1024);   /* 4 MB ring buffer */
} security_events SEC(".maps");

/* Attach to the bprm_check_security LSM hook */
SEC("lsm/bprm_check_security")
int BPF_PROG(check_exec, struct linux_binprm *bprm)
{
    struct file *file = BPF_CORE_READ(bprm, file);
    struct inode *inode = BPF_CORE_READ(file, f_inode);
    __u64 ino = BPF_CORE_READ(inode, i_ino);

    /* Look up this inode in the deny list */
    __u8 *denied = bpf_map_lookup_elem(&denied_inodes, &ino);

    /* Allocate a ring buffer entry for the security event */
    struct security_event *event = bpf_ringbuf_reserve(
        &security_events, sizeof(*event), 0);

    if (event) {
        event->pid   = bpf_get_current_pid_tgid() >> 32;
        event->uid   = bpf_get_current_uid_gid() & 0xFFFFFFFF;
        event->inode = ino;
        event->denied = (denied != NULL) ? 1 : 0;
        bpf_get_current_comm(event->comm, sizeof(event->comm));

        /* Read filename from bprm->filename */
        const char *fname = BPF_CORE_READ(bprm, filename);
        bpf_core_read_str(event->filename, sizeof(event->filename), fname);

        bpf_ringbuf_submit(event, 0);
    }

    /* Deny the execve if inode is in deny list */
    if (denied) {
        return -EPERM;
    }

    return 0;
}

char _license[] SEC("license") = "GPL";
```

### File Access Control

```c
/* file-access-control.bpf.c - Deny writes to specific directories */

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

/* Per-container policy map:
 * key: container_id (from cgroup) -> value: policy bitmask
 * Policy bits:
 *   bit 0: deny writes to /etc
 *   bit 1: deny writes to /usr
 *   bit 2: deny network bind to privileged ports (<1024)
 */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 4096);
    __type(key, __u64);     /* cgroup ID */
    __type(value, __u32);   /* policy bitmask */
} container_policies SEC(".maps");

#define POLICY_DENY_ETC_WRITE   (1U << 0)
#define POLICY_DENY_USR_WRITE   (1U << 1)
#define POLICY_DENY_PRIV_BIND   (1U << 2)

/* Path prefix check using BPF string operations */
static __always_inline int has_prefix(const char *str, const char *prefix, int prefix_len) {
    char buf[256];
    int len = bpf_probe_read_kernel_str(buf, sizeof(buf), str);
    if (len < prefix_len) return 0;

    /* BPF verifier requires bounded loop */
    for (int i = 0; i < prefix_len && i < 32; i++) {
        if (buf[i] != prefix[i]) return 0;
    }
    return 1;
}

/* LSM hook: inode_permission */
SEC("lsm/inode_permission")
int BPF_PROG(check_inode_perm, struct inode *inode, int mask)
{
    /* Only check write operations */
    if (!(mask & MAY_WRITE)) return 0;

    /* Get the cgroup ID for policy lookup */
    __u64 cgroup_id = bpf_get_current_cgroup_id();

    __u32 *policy = bpf_map_lookup_elem(&container_policies, &cgroup_id);
    if (!policy || *policy == 0) return 0;  /* no policy, allow */

    /* Get the path of the inode being accessed */
    struct dentry *dentry = NULL;
    /* Note: getting full path in BPF is complex; 
     * in production use fentry/kprobe with path_truncate */

    return 0;
}

/* More practical: hook inode_create to prevent file creation in sensitive dirs */
SEC("lsm/path_truncate")
int BPF_PROG(check_truncate, const struct path *path)
{
    __u64 cgroup_id = bpf_get_current_cgroup_id();
    __u32 *policy = bpf_map_lookup_elem(&container_policies, &cgroup_id);
    if (!policy) return 0;

    /* Read the filename of the file being truncated */
    struct dentry *dentry = BPF_CORE_READ(path, dentry);
    struct inode *parent_inode = BPF_CORE_READ(dentry, d_parent, d_inode);
    __u64 parent_ino = BPF_CORE_READ(parent_inode, i_ino);

    /* In production: maintain a map of sensitive directory inodes
     * and check parent_ino against it */
    _ = parent_ino;

    return 0;
}

char _license[] SEC("license") = "GPL";
```

### Network Binding Policy

```c
/* network-policy.bpf.c - Deny binding to privileged ports */

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

/* Map: allowed_ports - processes in this map can bind any port */
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 256);
    __type(key, __u32);    /* UID */
    __type(value, __u8);   /* 1 = allowed */
} privileged_uids SEC(".maps");

SEC("lsm/socket_bind")
int BPF_PROG(restrict_socket_bind, struct socket *sock,
             struct sockaddr *address, int addrlen)
{
    __u32 uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;

    /* Root always allowed */
    if (uid == 0) return 0;

    /* Check for privileged UID override */
    __u8 *allowed = bpf_map_lookup_elem(&privileged_uids, &uid);
    if (allowed) return 0;

    /* Check if binding to a privileged port (<1024) */
    __u16 port = 0;

    /* For IPv4 */
    if (address->sa_family == AF_INET) {
        struct sockaddr_in *addr4 = (struct sockaddr_in *)address;
        port = bpf_ntohs(BPF_CORE_READ(addr4, sin_port));
    }
    /* For IPv6 */
    else if (address->sa_family == AF_INET6) {
        struct sockaddr_in6 *addr6 = (struct sockaddr_in6 *)address;
        port = bpf_ntohs(BPF_CORE_READ(addr6, sin6_port));
    }

    if (port > 0 && port < 1024) {
        /* Log the attempt */
        bpf_printk("BPF-LSM: uid=%u attempted to bind to privileged port %u\n",
                   uid, port);
        return -EPERM;
    }

    return 0;
}

/* Deny connections to internal IP ranges from untrusted processes */
SEC("lsm/socket_connect")
int BPF_PROG(restrict_socket_connect, struct socket *sock,
             struct sockaddr *address, int addrlen)
{
    if (address->sa_family != AF_INET) return 0;

    struct sockaddr_in *addr4 = (struct sockaddr_in *)address;
    __u32 dest_ip = bpf_ntohl(BPF_CORE_READ(addr4, sin_addr.s_addr));
    __u16 dest_port = bpf_ntohs(BPF_CORE_READ(addr4, sin_port));

    /* Block connections to metadata service (169.254.169.254) */
    if (dest_ip == 0xA9FEA9FE && dest_port == 80) {
        __u32 pid = bpf_get_current_pid_tgid() >> 32;
        char comm[16];
        bpf_get_current_comm(comm, sizeof(comm));
        bpf_printk("BPF-LSM: pid=%u comm=%s blocked metadata access\n",
                   pid, comm);
        return -EPERM;
    }

    return 0;
}

char _license[] SEC("license") = "GPL";
```

## Go Userspace Loader with libbpf-go

```go
// cmd/bpf-security/main.go
// Build: go generate && go build
// Requires: libbpf, clang, linux-headers

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go \
//   -target bpf -cc clang \
//   SecurityProg ./restrict-exec.bpf.c \
//   -- -I/usr/include/bpf

package main

import (
    "bytes"
    "encoding/binary"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/cilium/ebpf/ringbuf"
    "github.com/cilium/ebpf/rlimit"
)

// SecurityEvent mirrors the BPF struct definition
type SecurityEvent struct {
    PID      uint32
    UID      uint32
    Inode    uint64
    Comm     [16]byte
    Filename [128]byte
    Denied   uint8
}

func main() {
    // Allow unlimited locked memory for eBPF maps
    if err := rlimit.RemoveMemlock(); err != nil {
        log.Fatalf("Failed to remove memlock limit: %v", err)
    }

    // Load BPF objects (compiled BPF bytecode)
    objs := SecurityProgObjects{}
    if err := LoadSecurityProgObjects(&objs, nil); err != nil {
        log.Fatalf("Failed to load BPF objects: %v", err)
    }
    defer objs.Close()

    // Populate the denied inodes map
    // In production: derive from filesystem stats of target binaries
    deniedInodes := []uint64{}  // add inode numbers here

    for _, inode := range deniedInodes {
        val := uint8(1)
        if err := objs.DeniedInodes.Put(inode, val); err != nil {
            log.Printf("Failed to add inode %d to deny list: %v", inode, err)
        }
    }

    // Attach the LSM program
    lsmLink, err := link.AttachLSM(link.LSMOptions{
        Program: objs.CheckExec,
    })
    if err != nil {
        log.Fatalf("Failed to attach LSM program: %v", err)
    }
    defer lsmLink.Close()

    log.Println("BPF-LSM security policy loaded and active")

    // Start ring buffer consumer for security events
    rd, err := ringbuf.NewReader(objs.SecurityEvents)
    if err != nil {
        log.Fatalf("Failed to create ring buffer reader: %v", err)
    }
    defer rd.Close()

    // Signal handling for graceful shutdown
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        for {
            record, err := rd.Read()
            if err != nil {
                if err == ringbuf.ErrClosed {
                    return
                }
                log.Printf("Ring buffer read error: %v", err)
                continue
            }

            var event SecurityEvent
            if err := binary.Read(bytes.NewReader(record.RawSample),
                binary.LittleEndian, &event); err != nil {
                log.Printf("Failed to decode event: %v", err)
                continue
            }

            comm := nullTerminatedString(event.Comm[:])
            filename := nullTerminatedString(event.Filename[:])

            if event.Denied == 1 {
                log.Printf("DENIED  execve: pid=%d uid=%d comm=%s file=%s inode=%d",
                    event.PID, event.UID, comm, filename, event.Inode)
            } else {
                log.Printf("ALLOWED execve: pid=%d uid=%d comm=%s file=%s",
                    event.PID, event.UID, comm, filename)
            }
        }
    }()

    sig := <-sigCh
    log.Printf("Received %v, removing security policy", sig)
    // LSM policy is automatically removed when lsmLink.Close() is called via defer
}

func nullTerminatedString(b []byte) string {
    for i, c := range b {
        if c == 0 {
            return string(b[:i])
        }
    }
    return string(b)
}
```

## Enforcement vs Audit Mode

Production BPF-LSM deployment typically starts in audit mode (log violations but allow) and promotes to enforcement mode after validation.

```go
// Audit/enforcement mode control
package policy

import (
    "github.com/cilium/ebpf"
)

const (
    ModeAudit   = 0
    ModeEnforce = 1
)

// PolicyConfig controls enforcement mode globally
type PolicyConfig struct {
    Mode uint32
}

// SetMode updates the enforcement mode in the BPF map
func SetMode(modeMap *ebpf.Map, mode uint32) error {
    key := uint32(0)
    return modeMap.Put(key, mode)
}
```

In the BPF program:

```c
/* Mode map: key=0, value=mode (0=audit, 1=enforce) */
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u32);
} policy_mode SEC(".maps");

#define MODE_AUDIT   0
#define MODE_ENFORCE 1

SEC("lsm/bprm_check_security")
int BPF_PROG(check_exec_with_mode, struct linux_binprm *bprm)
{
    /* ... (check logic from above) ... */

    /* Look up current mode */
    __u32 key = 0;
    __u32 *mode = bpf_map_lookup_elem(&policy_mode, &key);
    int current_mode = mode ? *mode : MODE_AUDIT;

    if (/* violation detected */) {
        /* Always log */
        bpf_printk("SECURITY VIOLATION: execve denied for inode %llu\n", ino);

        /* Only deny in enforce mode */
        if (current_mode == MODE_ENFORCE) {
            return -EPERM;
        }
    }

    return 0;
}
```

## Container Runtime Security Integration

### Integration with containerd/runc

BPF-LSM policies can be applied per-container by keying the policy map on cgroup IDs:

```go
// container-policy-loader.go
// Called by the container runtime when a new container starts

package containersec

import (
    "fmt"
    "os"
    "path/filepath"
    "strconv"
    "strings"

    "github.com/cilium/ebpf"
)

const (
    PolicyDenyEtcWrite  = 1 << 0
    PolicyDenyUsrWrite  = 1 << 1
    PolicyDenyPrivBind  = 1 << 2
    PolicyDenyMetadata  = 1 << 3
)

// GetCgroupID returns the cgroup v2 ID for a container's cgroup path
func GetCgroupID(cgroupPath string) (uint64, error) {
    // Read the cgroup.id file (requires cgroup v2)
    idFile := filepath.Join("/sys/fs/cgroup", cgroupPath, "cgroup.id")
    data, err := os.ReadFile(idFile)
    if err != nil {
        return 0, fmt.Errorf("read cgroup.id: %w", err)
    }

    id, err := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
    if err != nil {
        return 0, fmt.Errorf("parse cgroup id: %w", err)
    }
    return id, nil
}

// ApplyContainerPolicy loads a security policy for a container
func ApplyContainerPolicy(
    policyMap *ebpf.Map,
    cgroupPath string,
    policy uint32,
) error {
    cgroupID, err := GetCgroupID(cgroupPath)
    if err != nil {
        return fmt.Errorf("get cgroup id for %s: %w", cgroupPath, err)
    }

    if err := policyMap.Put(cgroupID, policy); err != nil {
        return fmt.Errorf("put policy for cgroup %d: %w", cgroupID, err)
    }

    return nil
}

// RemoveContainerPolicy removes a container's policy on cleanup
func RemoveContainerPolicy(policyMap *ebpf.Map, cgroupPath string) error {
    cgroupID, err := GetCgroupID(cgroupPath)
    if err != nil {
        // Container already gone
        return nil
    }
    return policyMap.Delete(cgroupID)
}

// DefaultContainerPolicy returns the default policy bitmask for untrusted containers
func DefaultContainerPolicy() uint32 {
    return PolicyDenyEtcWrite |
        PolicyDenyUsrWrite |
        PolicyDenyPrivBind |
        PolicyDenyMetadata
}
```

## Tetragon: Production BPF-LSM at Scale

Tetragon (from Cilium) is a production-ready BPF-LSM-based security enforcement platform that wraps the complexity of raw BPF-LSM with Kubernetes-native policy resources:

```yaml
# tetragon-policy.yaml - Kubernetes-native BPF-LSM policy
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: restrict-sensitive-syscalls
spec:
  # Deny execve of curl, wget, nc in production pods
  kprobes:
  - call: "security_bprm_check"
    syscall: false
    args:
    - index: 0
      type: "linux_binprm"
    selectors:
    - matchNamespaces:
      - operator: In
        namespaces: ["production"]
      matchBinaries:
      - operator: In
        values:
        - "/usr/bin/curl"
        - "/usr/bin/wget"
        - "/usr/bin/nc"
        - "/usr/bin/ncat"
      matchActions:
      - action: Sigkill  # Kill the process
```

```yaml
# Tetragon policy: block file modification in /etc
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: protect-etc-directory
spec:
  kprobes:
  - call: "security_file_open"
    syscall: false
    args:
    - index: 0
      type: "file"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/etc/"
      matchActions:
      - action: Override
        argError: -EPERM  # Return EPERM to the caller
```

## Kernel Self-Protection Mechanisms

BPF-LSM complements (not replaces) existing kernel self-protection features:

```bash
# Check kernel self-protection status

# KASLR (Kernel Address Space Layout Randomization)
cat /proc/kallsyms | grep startup_64 | awk '{print $1}'
# Non-deterministic address = KASLR active

# Stack canaries
cat /boot/config-$(uname -r) | grep CONFIG_STACKPROTECTOR
# CONFIG_STACKPROTECTOR_STRONG=y

# SMEP/SMAP (Supervisor Mode Execution/Access Prevention)
grep -o 'smep\|smap' /proc/cpuinfo | sort -u
# smep
# smap

# CET (Control-flow Enforcement Technology)
cat /proc/cpuinfo | grep -o 'ibt\|shstk' | sort -u

# Kernel lockdown mode
cat /sys/kernel/security/lockdown
# [none] integrity confidentiality

# Enable integrity lockdown (prevents unsigned module loading)
echo integrity | sudo tee /sys/kernel/security/lockdown

# IMA (Integrity Measurement Architecture)
# Check if IMA is active
cat /sys/kernel/security/ima/policy 2>/dev/null || echo "IMA not configured"

# Enable IMA measurement for all executables
echo "measure func=BPRM_CHECK" | sudo tee /sys/kernel/security/ima/policy
```

### seccomp + BPF-LSM: Defense in Depth

```yaml
# Kubernetes pod with both seccomp and BPF-LSM policies
apiVersion: v1
kind: Pod
metadata:
  name: secure-workload
  namespace: production
spec:
  securityContext:
    # Seccomp: syscall filter (first line of defense)
    seccompProfile:
      type: RuntimeDefault  # uses containerd/cri-o default

  containers:
  - name: app
    image: myapp:latest
    securityContext:
      # Drop all capabilities, add only what's needed
      capabilities:
        drop: ["ALL"]
        add: ["NET_BIND_SERVICE"]  # only if binding <1024
      # Run as non-root
      runAsNonRoot: true
      runAsUser: 1000
      # Read-only root filesystem (forces writable paths to be explicit)
      readOnlyRootFilesystem: true
      # Prevent privilege escalation
      allowPrivilegeEscalation: false
    # BPF-LSM policy is applied by Tetragon based on pod labels/namespace
    # - deny execve of shells in production
    # - deny bind to privileged ports
    # - deny write to /etc, /usr
    # - deny connect to metadata service
    volumeMounts:
    - name: tmp
      mountPath: /tmp
    - name: cache
      mountPath: /var/cache/app
  volumes:
  - name: tmp
    emptyDir: {}
  - name: cache
    emptyDir: {}
```

## Monitoring BPF-LSM Events

```bash
# Watch BPF trace pipe for security events
sudo cat /sys/kernel/debug/tracing/trace_pipe | grep "BPF-LSM:"

# Or use bpftool to inspect running programs
bpftool prog list type lsm
# 47: lsm  name check_exec  tag abc123  gpl
#     loaded_at 2030-04-23T10:00:00+0000  uid 0
#     xlated 256B  jited 192B  memlock 4096B  map_ids 12,13

# Pin programs and maps for persistence across loader crashes
bpftool prog pin id 47 /sys/fs/bpf/lsm_check_exec
bpftool map pin id 12 /sys/fs/bpf/denied_inodes

# Load from pinned path
bpftool prog load restrict-exec.bpf.o /sys/fs/bpf/lsm_check_exec

# Check map contents
bpftool map dump pinned /sys/fs/bpf/denied_inodes

# Performance profiling of BPF-LSM overhead
bpftool prog profile id 47 duration 10

# Output:
#          14447 run_cnt
#             27 run_time_ns  (avg 1.8ns per invocation)
```

## Key Takeaways

BPF-LSM represents a fundamental advancement in Linux runtime security: security policies that are as flexible as application code but with kernel-level enforcement and near-zero overhead.

**Architecture fundamentals**: BPF-LSM programs attach to any of 240+ LSM hook points. Each hook is called at a specific kernel operation, receives the relevant kernel data structures as arguments, and returns 0 (allow) or a negative error code (deny). The hook coverage spans exec, file, network, IPC, and BPF operations.

**Enforcement vs audit mode**: Never deploy a new BPF-LSM policy directly in enforcement mode in production. Start in audit mode (log violations, allow action) for at least 72 hours. Validate that no legitimate workflows are flagged before switching to enforcement. Use a feature flag (BPF map) to toggle modes without reloading programs.

**Container-aware policies**: Key your policy maps on cgroup IDs (not process IDs or UIDs) for container isolation. Cgroup IDs are stable for the container's lifetime, scoped to the container, and accessible from BPF. Integrate with the container runtime's lifecycle hooks to load/unload policies on container start/stop.

**Defense in depth**: BPF-LSM is most effective as one layer in a stack: seccomp (syscall filter) at the outermost layer, BPF-LSM (semantic security) in the middle, and read-only filesystems + dropped capabilities at the container configuration layer. No single mechanism covers all threat vectors.

**Production tooling**: Tetragon (from Cilium) provides Kubernetes-native CRD-based BPF-LSM policy management. It handles the operational complexity of loading, updating, and auditing BPF-LSM policies at scale. For most teams, Tetragon + TracingPolicy is the right abstraction rather than raw BPF-LSM programs.

**Kernel self-protection**: BPF-LSM does not replace KASLR, SMEP/SMAP, stack canaries, or seccomp — these operate at different layers. Enable integrity lockdown mode to prevent unsigned kernel module loading. Use IMA for runtime integrity measurement of executables and configuration files.
