---
title: "Linux eBPF Security: LSM Hooks and Mandatory Access Control"
date: 2029-06-20T00:00:00-05:00
draft: false
tags: ["Linux", "eBPF", "Security", "LSM", "Tetragon", "KRSI", "Kernel Security"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A deep dive into BPF LSM programs and KRSI (Kernel Runtime Security Instrumentation), covering how to write MAC policies using eBPF hooks and how Tetragon implements security enforcement with zero kernel module requirements."
more_link: "yes"
url: "/linux-ebpf-security-lsm-hooks-mac/"
---

Traditional mandatory access control systems — SELinux, AppArmor, and TOMOYO — require loading kernel modules, managing complex policy languages, and accepting tight coupling with kernel internals. The introduction of BPF LSM (KRSI — Kernel Runtime Security Instrumentation) in Linux 5.7 changes the equation fundamentally: security policies can now be expressed as verified eBPF programs that attach to kernel security hooks, providing the same enforcement power as SELinux with the flexibility and portability of eBPF.

<!--more-->

# Linux eBPF Security: LSM Hooks and Mandatory Access Control

## Section 1: LSM Framework Overview

The Linux Security Module (LSM) framework provides a set of hooks — function call interception points — scattered throughout the kernel at security-sensitive operations. Traditional LSMs like SELinux register callbacks at these hooks during boot. BPF LSM extends this by allowing eBPF programs to attach to the same hooks at runtime.

### Available LSM Hooks (Selected)

The kernel exposes over 200 LSM hooks. Key categories:

```
File Operations:
  security_file_open          - File open
  security_file_permission    - Read/write/exec permission check
  security_file_ioctl         - ioctl call
  security_mmap_file          - Memory-mapped file
  security_file_fcntl         - fcntl system call

Process Operations:
  security_bprm_check         - Program execution (execve)
  security_task_kill          - Signal delivery
  security_task_setuid        - setuid
  security_ptrace_access_check - ptrace attach

Network Operations:
  security_socket_create      - Socket creation
  security_socket_connect     - TCP/UDP connect
  security_socket_bind        - Socket bind
  security_socket_accept      - Accept connection

IPC Operations:
  security_ipc_permission     - SysV IPC
  security_shm_shmat          - Shared memory attach
```

### Check Kernel Support

```bash
# Verify BPF LSM is enabled
cat /boot/config-$(uname -r) | grep -E "BPF_LSM|CONFIG_LSM"
# Should show:
# CONFIG_BPF_LSM=y
# CONFIG_LSM="lockdown,yama,integrity,apparmor,bpf"

# Check active LSMs at runtime
cat /sys/kernel/security/lsm

# Verify eBPF LSM capability
bpftool feature probe | grep lsm

# Check BTF availability (required for BPF LSM)
ls /sys/kernel/btf/vmlinux
```

### Kernel Boot Parameters

To enable BPF LSM on a system where it is not already active:

```bash
# Add to GRUB_CMDLINE_LINUX in /etc/default/grub
GRUB_CMDLINE_LINUX="lsm=lockdown,yama,integrity,apparmor,bpf"

# Apply
update-grub
reboot

# Verify after reboot
cat /sys/kernel/security/lsm
# lockdown,yama,integrity,apparmor,bpf
```

---

## Section 2: Writing BPF LSM Programs in C

BPF LSM programs are written using the same `libbpf` infrastructure as other eBPF programs, but with the `BPF_PROG_TYPE_LSM` program type and `SEC("lsm/hook_name")` section names.

### Prevent File Open by Path (Basic Example)

```c
// prevent_open.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define EPERM 1

// Define the blocked path as a map to allow runtime configuration
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 256);
    __type(key, char[256]);
    __type(value, __u8);
} blocked_paths SEC(".maps");

// Attach to the file_open LSM hook
SEC("lsm/file_open")
int BPF_PROG(restrict_file_open, struct file *file)
{
    char path[256] = {};
    struct dentry *dentry;
    struct qstr dname;
    __u8 *blocked;

    // Read the file's dentry and name
    dentry = BPF_CORE_READ(file, f_path.dentry);
    dname = BPF_CORE_READ(dentry, d_name);

    // Copy the filename (bounded to 255 chars)
    bpf_core_read_str(path, sizeof(path), dname.name);

    // Check if path is in the blocked map
    blocked = bpf_map_lookup_elem(&blocked_paths, path);
    if (blocked && *blocked == 1) {
        bpf_printk("BPF LSM: Blocked open of '%s'\n", path);
        return -EPERM;
    }

    return 0;  // Allow
}

char LICENSE[] SEC("license") = "GPL";
```

### Block execve of Specific Binaries

```c
// block_exec.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

#define EPERM 1
#define TASK_COMM_LEN 16

struct exec_event {
    __u32 pid;
    __u32 uid;
    char  comm[TASK_COMM_LEN];
    char  filename[256];
    int   blocked;
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 20);  // 1MB ring buffer
} events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 128);
    __type(key, char[256]);
    __type(value, __u8);
} blocked_binaries SEC(".maps");

SEC("lsm/bprm_check_security")
int BPF_PROG(block_exec, struct linux_binprm *bprm)
{
    struct exec_event *e;
    char filename[256] = {};
    __u8 *blocked;

    // Read the executable filename
    bpf_core_read_str(filename, sizeof(filename),
                      BPF_CORE_READ(bprm, filename));

    // Check if binary is blocked
    blocked = bpf_map_lookup_elem(&blocked_binaries, filename);

    // Reserve space in ring buffer
    e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e)
        goto out;

    e->pid = bpf_get_current_pid_tgid() >> 32;
    e->uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;
    bpf_get_current_comm(e->comm, sizeof(e->comm));
    bpf_core_read_str(e->filename, sizeof(e->filename),
                      BPF_CORE_READ(bprm, filename));
    e->blocked = (blocked && *blocked == 1) ? 1 : 0;

    bpf_ringbuf_submit(e, 0);

out:
    if (blocked && *blocked == 1) {
        bpf_printk("BPF LSM: Blocked exec of '%s' by pid %d\n",
                   filename, bpf_get_current_pid_tgid() >> 32);
        return -EPERM;
    }

    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

### Network Connection Control

```c
// network_control.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_endian.h>

#define AF_INET  2
#define AF_INET6 10
#define EPERM    1

struct blocked_port_key {
    __u16 port;
    __u8  proto;   // 0=tcp, 1=udp
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, struct blocked_port_key);
    __type(value, __u8);
} blocked_outbound_ports SEC(".maps");

SEC("lsm/socket_connect")
int BPF_PROG(restrict_outbound, struct socket *sock,
             struct sockaddr *address, int addrlen)
{
    struct sockaddr_in *addr4;
    struct blocked_port_key key = {};
    __u8 *blocked;
    __u16 dport;

    if (address->sa_family != AF_INET)
        return 0;  // Only handle IPv4 for this example

    addr4 = (struct sockaddr_in *)address;
    dport = bpf_ntohs(BPF_CORE_READ(addr4, sin_port));

    key.port = dport;
    key.proto = 0;  // TCP

    blocked = bpf_map_lookup_elem(&blocked_outbound_ports, &key);
    if (blocked && *blocked == 1) {
        bpf_printk("BPF LSM: Blocked outbound TCP to port %d\n", dport);
        return -EPERM;
    }

    return 0;
}

// Prevent privileged port binding by non-root processes
SEC("lsm/socket_bind")
int BPF_PROG(restrict_privileged_bind, struct socket *sock,
             struct sockaddr *address, int addrlen)
{
    struct sockaddr_in *addr4;
    __u16 port;
    __u32 uid;

    if (address->sa_family != AF_INET)
        return 0;

    addr4 = (struct sockaddr_in *)address;
    port = bpf_ntohs(BPF_CORE_READ(addr4, sin_port));
    uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;

    // Block non-root from binding to privileged ports
    if (port < 1024 && uid != 0) {
        bpf_printk("BPF LSM: Non-root uid=%d attempted bind to port %d\n",
                   uid, port);
        return -EPERM;
    }

    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

---

## Section 3: Userspace Loader with libbpf

```c
// loader.c
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include "block_exec.skel.h"

static volatile bool running = true;

static void sig_handler(int sig) {
    running = false;
}

static void handle_event(void *ctx, int cpu, void *data, __u32 size) {
    struct exec_event *e = data;
    printf("[%s] pid=%d uid=%d comm=%s file=%s\n",
           e->blocked ? "BLOCKED" : "ALLOWED",
           e->pid, e->uid, e->comm, e->filename);
}

int main() {
    struct block_exec_bpf *skel;
    struct ring_buffer *rb;
    int err;

    // Set up signal handling
    signal(SIGINT, sig_handler);
    signal(SIGTERM, sig_handler);

    // Open, load, and verify BPF application
    skel = block_exec_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open and load BPF skeleton\n");
        return 1;
    }

    // Attach BPF programs to LSM hooks
    err = block_exec_bpf__attach(skel);
    if (err) {
        fprintf(stderr, "Failed to attach BPF programs: %d\n", err);
        goto cleanup;
    }

    // Add blocked binaries to the map
    const char *blocked[] = {"/bin/nc", "/usr/bin/ncat", "/bin/netcat", NULL};
    __u8 val = 1;
    for (int i = 0; blocked[i]; i++) {
        char key[256] = {};
        strncpy(key, blocked[i], 255);
        bpf_map_update_elem(
            bpf_map__fd(skel->maps.blocked_binaries),
            key, &val, BPF_ANY);
        printf("Blocking: %s\n", key);
    }

    // Set up ring buffer consumer
    rb = ring_buffer__new(bpf_map__fd(skel->maps.events),
                          handle_event, NULL, NULL);
    if (!rb) {
        fprintf(stderr, "Failed to create ring buffer\n");
        goto cleanup;
    }

    printf("Monitoring execve events. Press Ctrl-C to exit.\n");

    while (running) {
        err = ring_buffer__poll(rb, 100 /* timeout_ms */);
        if (err == -EINTR) {
            break;
        }
        if (err < 0) {
            fprintf(stderr, "Error polling ring buffer: %d\n", err);
            break;
        }
    }

    ring_buffer__free(rb);
cleanup:
    block_exec_bpf__destroy(skel);
    return err < 0 ? 1 : 0;
}
```

---

## Section 4: Tetragon — Production BPF Security Enforcement

Tetragon (from Cilium project) provides a production-ready implementation of BPF LSM-based security enforcement with a Kubernetes-native policy language. It does not require SELinux or AppArmor.

### Install Tetragon on Kubernetes

```bash
# Install via Helm
helm repo add cilium https://helm.cilium.io
helm install tetragon cilium/tetragon \
  --namespace kube-system \
  --set tetragon.enableProcessCred=true \
  --set tetragon.enableProcessNs=true \
  --set tetragonOperator.enabled=true

# Verify installation
kubectl get pods -n kube-system -l app.kubernetes.io/name=tetragon
kubectl get crds | grep tetragon

# View available CRDs
# TracingPolicy       - global policies
# TracingPolicyNamespaced - namespace-scoped policies
```

### TracingPolicy: Block Sensitive File Access

```yaml
# tetragon-file-policy.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: block-sensitive-files
spec:
  kprobes:
  - call: "security_file_open"
    syscall: false
    return: false
    args:
    - index: 0
      type: "file"
    selectors:
    - matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/etc/shadow"
        - "/etc/passwd"
        - "/etc/sudoers"
        - "/.ssh/"
        - "/root/"
      matchActions:
      - action: Sigkill   # Kill the process attempting access
      - action: Override
        argError: -1      # Return EPERM
```

### TracingPolicy: Detect and Block Reverse Shells

```yaml
# tetragon-reverse-shell.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: detect-reverse-shell
spec:
  kprobes:
  # Detect suspicious socket+dup2 patterns (reverse shell technique)
  - call: "tcp_connect"
    syscall: false
    args:
    - index: 0
      type: "sock"
    selectors:
    - matchPIDs:
      - operator: NotIn
        isNamespacePID: true
        followForks: true
        values: [1]  # Not PID 1
      matchArgs:
      - index: 0
        operator: "NotDAddr"
        values:
        - "127.0.0.0/8"
        - "10.0.0.0/8"
        - "172.16.0.0/12"
        - "192.168.0.0/16"
      matchActions:
      - action: Post    # Generate an event
        rateLimit: "1/second"

  # Block bash/sh spawned by web server processes
  - call: "security_bprm_check"
    syscall: false
    args:
    - index: 0
      type: "linux_binprm"
    selectors:
    - matchBinaries:
      - operator: In
        values:
        - "/bin/bash"
        - "/bin/sh"
        - "/usr/bin/python3"
      matchNamespaces:
      - namespace: Net
        operator: In
        values: ["host"]
      matchActions:
      - action: Sigkill
```

### TracingPolicy: Namespace Escape Detection

```yaml
# tetragon-ns-escape.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: detect-namespace-escape
spec:
  kprobes:
  # Monitor setns() calls which switch namespaces
  - call: "__sys_setns"
    syscall: false
    args:
    - index: 0
      type: "int"      # fd
    - index: 1
      type: "int"      # nstype
    selectors:
    - matchCapabilities:
      - type: Effective
        operator: In
        values: ["CAP_SYS_ADMIN"]
      matchActions:
      - action: Post
        rateLimit: "10/minute"

  # Monitor unshare() which creates new namespaces
  - call: "ksys_unshare"
    syscall: false
    args:
    - index: 0
      type: "uint"   # flags (CLONE_NEWNET, CLONE_NEWPID, etc.)
    selectors:
    - matchActions:
      - action: Post
```

### Kubernetes-Aware TracingPolicyNamespaced

```yaml
# tetragon-ns-scoped.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicyNamespaced
metadata:
  name: production-file-restrictions
  namespace: production
spec:
  kprobes:
  - call: "security_file_open"
    syscall: false
    args:
    - index: 0
      type: "file"
    selectors:
    - matchLabels:
        app: api-server
      matchArgs:
      - index: 0
        operator: "Prefix"
        values:
        - "/proc/sys/"
        - "/sys/kernel/"
      matchActions:
      - action: Sigkill
```

---

## Section 5: Viewing and Processing Tetragon Events

### CLI Access

```bash
# Install tetra CLI
TETRAGON_VERSION=1.1.0
curl -L https://github.com/cilium/tetragon/releases/download/v${TETRAGON_VERSION}/tetra-linux-amd64.tar.gz | tar xz
mv tetra /usr/local/bin/

# Follow events from all pods
kubectl exec -n kube-system ds/tetragon -c tetragon -- tetra getevents -o compact

# Filter by namespace
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
  tetra getevents -o compact --namespace production

# Filter by event type
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
  tetra getevents --event-types PROCESS_EXEC,PROCESS_KPROBE
```

### JSON Event Processing

```bash
# Stream events as JSON and pipe to jq for analysis
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
  tetra getevents -o json | \
  jq 'select(.process_kprobe != null) |
      {
        time: .time,
        pid: .process_kprobe.process.pid,
        binary: .process_kprobe.process.binary,
        call: .process_kprobe.function_name,
        action: .process_kprobe.action
      }'

# Count kill events by binary
kubectl exec -n kube-system ds/tetragon -c tetragon -- \
  tetra getevents -o json --event-types PROCESS_KPROBE | \
  jq -r 'select(.process_kprobe.action == "KPROBE_ACTION_SIGKILL") |
          .process_kprobe.process.binary' | \
  sort | uniq -c | sort -rn
```

### Export to SIEM

```yaml
# tetragon-export.yaml — Ship events to external system
apiVersion: v1
kind: ConfigMap
metadata:
  name: tetragon-config
  namespace: kube-system
data:
  config.yaml: |
    export-filename: /var/run/cilium/tetragon/tetragon.log
    export-file-max-size-mb: 10
    export-file-rotation-interval: 1h
    export-allowlist: |
      {"event_set": ["PROCESS_EXEC", "PROCESS_EXIT", "PROCESS_KPROBE"]}
    export-denylist: |
      {"health_check": true}
```

---

## Section 6: Writing BPF LSM Programs in Go with cilium/ebpf

For teams preferring Go for tooling:

```go
// main.go — Go-based BPF LSM loader
package main

import (
    "encoding/binary"
    "fmt"
    "log"
    "net"
    "os"
    "os/signal"
    "syscall"

    "github.com/cilium/ebpf"
    "github.com/cilium/ebpf/link"
    "github.com/cilium/ebpf/ringbuf"
    "github.com/cilium/ebpf/rlimit"
)

//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -cflags "-O2 -g -Wall -Werror" LSM ./lsm.bpf.c

type ExecEvent struct {
    PID      uint32
    UID      uint32
    Comm     [16]byte
    Filename [256]byte
    Blocked  uint8
    _        [3]byte // padding
}

func main() {
    // Allow the current process to lock memory for eBPF maps
    if err := rlimit.RemoveMemlock(); err != nil {
        log.Fatalf("Failed to remove memlock limit: %v", err)
    }

    // Load pre-compiled programs and maps into the kernel
    objs := LSMObjects{}
    if err := LoadLSMObjects(&objs, nil); err != nil {
        log.Fatalf("Loading objects: %v", err)
    }
    defer objs.Close()

    // Attach BPF LSM program to the bprm_check_security hook
    lsm, err := link.AttachLSM(link.LSMOptions{
        Program: objs.BlockExec,
    })
    if err != nil {
        log.Fatalf("Attaching LSM: %v", err)
    }
    defer lsm.Close()

    // Add blocked binaries
    blockedBinaries := []string{
        "/bin/nc",
        "/usr/bin/ncat",
        "/bin/wget",
        "/usr/bin/curl",
    }
    val := uint8(1)
    for _, bin := range blockedBinaries {
        key := make([]byte, 256)
        copy(key, bin)
        if err := objs.BlockedBinaries.Put(key, val); err != nil {
            log.Printf("Failed to add %s to blocked list: %v", bin, err)
        } else {
            log.Printf("Blocking: %s", bin)
        }
    }

    // Read events from ring buffer
    rd, err := ringbuf.NewReader(objs.Events)
    if err != nil {
        log.Fatalf("Opening ring buffer reader: %v", err)
    }
    defer rd.Close()

    // Handle SIGINT/SIGTERM
    sig := make(chan os.Signal, 1)
    signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

    log.Println("Monitoring execve events. Press Ctrl-C to exit.")

    go func() {
        <-sig
        rd.Close()
    }()

    var event ExecEvent
    for {
        record, err := rd.Read()
        if err != nil {
            if err == ringbuf.ErrClosed {
                return
            }
            log.Printf("Reading from reader: %v", err)
            continue
        }

        if err := binary.Read(
            bytes.NewBuffer(record.RawSample),
            binary.LittleEndian,
            &event,
        ); err != nil {
            log.Printf("Parsing ringbuf event: %v", err)
            continue
        }

        comm := nullTermString(event.Comm[:])
        filename := nullTermString(event.Filename[:])
        status := "ALLOWED"
        if event.Blocked == 1 {
            status = "BLOCKED"
        }

        fmt.Printf("[%s] pid=%d uid=%d comm=%s file=%s\n",
            status, event.PID, event.UID, comm, filename)
    }
}

func nullTermString(b []byte) string {
    for i, c := range b {
        if c == 0 {
            return string(b[:i])
        }
    }
    return string(b)
}
```

---

## Section 7: Performance Considerations

BPF LSM programs run in the kernel's fast path — they are called on every security-sensitive operation. Performance overhead depends on the complexity of the program and the frequency of the hook.

### Measuring Overhead

```bash
# Baseline system call latency (no BPF LSM)
perf stat -e syscalls:sys_enter_openat sleep 1

# Measure overhead with BPF LSM attached
# Run a file-intensive benchmark
sysbench fileio --file-test-mode=rndrd --file-total-size=1G prepare
sysbench fileio --file-test-mode=rndrd --file-total-size=1G run

# Profile the BPF LSM program itself
bpftool prog profile id <PROG_ID> duration 5 instructions cycles
```

### Optimization Techniques

```c
// Use early returns to avoid unnecessary work
SEC("lsm/file_open")
int BPF_PROG(restrict_file_open, struct file *file)
{
    // Fast path: skip kernel files immediately
    struct dentry *dentry = BPF_CORE_READ(file, f_path.dentry);
    struct super_block *sb = BPF_CORE_READ(dentry, d_sb);
    unsigned long magic = BPF_CORE_READ(sb, s_magic);

    // Skip procfs (0x9fa0), sysfs (0x62656572), tmpfs (0x01021994)
    if (magic == 0x9fa0 || magic == 0x62656572 || magic == 0x01021994)
        return 0;

    // Only check regular files
    umode_t mode = BPF_CORE_READ(file, f_inode, i_mode);
    if (!S_ISREG(mode))
        return 0;

    // Now do the expensive map lookup
    // ...
    return 0;
}
```

### Typical Overhead

| Hook | Frequency | Typical Overhead |
|---|---|---|
| `security_file_open` | High | 50-200ns per call |
| `security_bprm_check` | Low | 200-500ns per exec |
| `security_socket_connect` | Medium | 100-300ns per connect |
| `security_task_kill` | Low | 50-100ns per signal |

For most production workloads, BPF LSM overhead is below 1% of total CPU, similar to or less than SELinux.

---

## Section 8: Comparing BPF LSM, SELinux, and AppArmor

| Feature | SELinux | AppArmor | BPF LSM |
|---|---|---|---|
| Policy language | Type Enforcement | Profiles | eBPF C / Tetragon YAML |
| Runtime update | No reload needed | Policy reload | Runtime via maps |
| Kernel requirements | Built-in module | Built-in module | Linux 5.7+ with CONFIG_BPF_LSM |
| Kubernetes integration | Complex | Moderate | Native (Tetragon) |
| Audit events | AVC messages | Kernel log | Ring buffer / JSON |
| Custom logic | Limited | Limited | Full eBPF program |
| Performance | ~1-3% overhead | ~1-2% overhead | ~0.5-1% overhead |
| Debugging | audit2allow | aa-logprof | bpftool / tetra CLI |

BPF LSM does not replace SELinux or AppArmor for compliance scenarios that explicitly require those frameworks. However, for cloud-native environments running Kubernetes, BPF LSM via Tetragon provides superior observability, easier policy management, and comparable enforcement capability.

### Coexistence

BPF LSM can run alongside SELinux or AppArmor. The `lsm=` boot parameter determines the stack order. All registered LSMs run in sequence, and the most restrictive outcome wins:

```bash
# Run BPF LSM alongside AppArmor
GRUB_CMDLINE_LINUX="lsm=lockdown,yama,integrity,apparmor,bpf"
```

This allows gradual migration: keep AppArmor profiles in place while building BPF LSM policies, then remove AppArmor profiles as BPF policies mature.
