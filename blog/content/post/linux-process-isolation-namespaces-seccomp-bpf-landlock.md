---
title: "Linux Process Isolation: namespaces, seccomp-bpf, and Landlock LSM"
date: 2030-01-16T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Namespaces", "seccomp", "Landlock", "Containers", "Kernel"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux isolation primitives used by containers: user namespaces, seccomp-bpf filter writing, Landlock filesystem sandboxing, and unprivileged process confinement at the kernel level."
more_link: "yes"
url: "/linux-process-isolation-namespaces-seccomp-bpf-landlock/"
---

Container runtimes like containerd and CRI-O do not implement isolation themselves — they compose Linux kernel primitives: namespaces for resource visibility, cgroups for resource quotas, seccomp for syscall filtering, and capabilities for privilege decomposition. Understanding these primitives at the implementation level lets you build more secure container policies, write custom seccomp profiles, and use Landlock LSM for filesystem sandboxing in cases where SELinux or AppArmor are unavailable. This guide digs into each mechanism with working C and Go examples and production-ready configurations.

<!--more-->

# Linux Process Isolation: namespaces, seccomp-bpf, and Landlock LSM

## Linux Namespaces: The Foundation of Container Isolation

The Linux kernel provides eight namespace types, each isolating a different aspect of the system view:

| Namespace | Flag           | Isolates                          | Since    |
|-----------|----------------|-----------------------------------|----------|
| Mount     | `CLONE_NEWNS`  | Filesystem mount table            | 2.4.19   |
| UTS       | `CLONE_NEWUTS` | Hostname and domain name          | 2.6.19   |
| IPC       | `CLONE_NEWIPC` | SysV IPC, POSIX message queues    | 2.6.19   |
| PID       | `CLONE_NEWPID` | Process IDs                       | 2.6.24   |
| Network   | `CLONE_NEWNET` | Network devices, routing tables   | 2.6.29   |
| User      | `CLONE_NEWUSER`| UIDs/GIDs, capabilities           | 3.8      |
| Cgroup    | `CLONE_NEWCGROUP` | cgroup root directory           | 4.6      |
| Time      | `CLONE_NEWTIME`| Boot and monotonic clocks         | 5.6      |

### Inspecting Current Namespaces

```bash
# List all namespaces on the system
lsns

# Inspect a specific process's namespaces
ls -la /proc/$$/ns/

# Example output:
# lrwxrwxrwx 1 root root 0 cgroup -> cgroup:[4026531835]
# lrwxrwxrwx 1 root root 0 ipc -> ipc:[4026531839]
# lrwxrwxrwx 1 root root 0 mnt -> mnt:[4026531840]
# lrwxrwxrwx 1 root root 0 net -> net:[4026531992]
# lrwxrwxrwx 1 root root 0 pid -> pid:[4026531836]
# lrwxrwxrwx 1 root root 0 user -> user:[4026531837]
# lrwxrwxrwx 1 root root 0 uts -> uts:[4026531838]

# Check if two processes share a namespace
readlink /proc/1/ns/pid
readlink /proc/$$/ns/pid
```

### Creating Isolated Process Trees in C

```c
/* minimal_container.c - Demonstrates namespace creation */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sched.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>

#define STACK_SIZE (1024 * 1024)

struct child_args {
    char **argv;
    char *hostname;
};

static int child_func(void *arg) {
    struct child_args *args = (struct child_args *)arg;

    /* Set hostname in the new UTS namespace */
    if (sethostname(args->hostname, strlen(args->hostname)) != 0) {
        perror("sethostname");
        return 1;
    }

    /* Mount proc filesystem so ps/top work correctly */
    if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) {
        perror("mount proc");
        return 1;
    }

    /* Execute the target command */
    execvp(args->argv[0], args->argv);
    perror("execvp");
    return 1;
}

int main(int argc, char *argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <command> [args...]\n", argv[0]);
        return 1;
    }

    /* Allocate stack for child process */
    char *stack = malloc(STACK_SIZE);
    if (!stack) {
        perror("malloc");
        return 1;
    }
    char *stack_top = stack + STACK_SIZE;

    struct child_args args = {
        .argv = &argv[1],
        .hostname = "container",
    };

    /* Create child with new PID, UTS, IPC, and mount namespaces */
    int flags = CLONE_NEWPID | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWNS | SIGCHLD;

    pid_t pid = clone(child_func, stack_top, flags, &args);
    if (pid < 0) {
        perror("clone");
        free(stack);
        return 1;
    }

    printf("[host] Container started with PID %d\n", pid);

    /* Wait for child to complete */
    int status;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        free(stack);
        return 1;
    }

    free(stack);

    if (WIFEXITED(status)) {
        printf("[host] Container exited with status %d\n", WEXITSTATUS(status));
    }

    return 0;
}
```

### Unprivileged User Namespaces in Go

```go
// pkg/namespace/userns.go
package namespace

import (
    "fmt"
    "os"
    "os/exec"
    "strconv"
    "syscall"
)

// RunInUserNamespace executes a command inside a new user namespace
// mapping the current user to UID 0 inside the namespace.
// This requires no root privileges.
func RunInUserNamespace(command string, args ...string) error {
    uid := os.Getuid()
    gid := os.Getgid()

    cmd := exec.Command(command, args...)
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    // Request new user, PID, and UTS namespaces
    cmd.SysProcAttr = &syscall.SysProcAttr{
        Cloneflags: syscall.CLONE_NEWUSER |
            syscall.CLONE_NEWPID |
            syscall.CLONE_NEWUTS |
            syscall.CLONE_NEWIPC,

        // Map current user to root inside namespace
        UidMappings: []syscall.SysProcIDMap{
            {ContainerID: 0, HostID: uid, Size: 1},
        },
        GidMappings: []syscall.SysProcIDMap{
            {ContainerID: 0, HostID: gid, Size: 1},
        },

        // Set hostname in new UTS namespace
        Hostname: "sandbox",
    }

    return cmd.Run()
}

// RunWithNetworkNamespace creates an isolated network namespace
// with a loopback interface only
func RunWithNetworkNamespace(command string, args ...string) error {
    uid := os.Getuid()
    gid := os.Getgid()

    cmd := exec.Command(command, args...)
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    cmd.SysProcAttr = &syscall.SysProcAttr{
        Cloneflags: syscall.CLONE_NEWUSER |
            syscall.CLONE_NEWNET |
            syscall.CLONE_NEWPID,
        UidMappings: []syscall.SysProcIDMap{
            {ContainerID: 0, HostID: uid, Size: 1},
        },
        GidMappings: []syscall.SysProcIDMap{
            {ContainerID: 0, HostID: gid, Size: 1},
        },
    }

    return cmd.Run()
}

// WriteSubUIDMapping writes UID mapping for newuidmap
func WriteSubUIDMapping(pid int, uid int) error {
    mappingFile := fmt.Sprintf("/proc/%d/uid_map", pid)
    content := fmt.Sprintf("0 %d 1\n", uid)
    return os.WriteFile(mappingFile, []byte(content), 0)
}

// CheckUserNamespaceSupport verifies kernel support for unprivileged user namespaces
func CheckUserNamespaceSupport() error {
    data, err := os.ReadFile("/proc/sys/kernel/unprivileged_userns_clone")
    if err != nil {
        // File may not exist on all kernels (only on some Ubuntu configs)
        return nil
    }

    val := strconv.TrimSpace(string(data))
    if val != "1" {
        return fmt.Errorf("unprivileged user namespaces disabled: echo 1 > /proc/sys/kernel/unprivileged_userns_clone")
    }
    return nil
}
```

## seccomp-bpf: System Call Filtering

seccomp (Secure Computing Mode) with BPF allows processes to install filters on the system calls they can make. A `SECCOMP_RET_KILL_PROCESS` action terminates the process if it makes a disallowed syscall — this is the mechanism Docker, containerd, and Kubernetes use to restrict container syscall surfaces.

### Understanding BPF Filter Structure

```c
/* seccomp_filter.c - Low-level seccomp BPF filter example */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <linux/bpf.h>

/* BPF filter that blocks ptrace and kexec_load */
static struct sock_filter strict_filter[] = {
    /* Load the syscall number */
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
             offsetof(struct seccomp_data, nr)),

    /* Allow read(2) */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_read, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

    /* Allow write(2) */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_write, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

    /* Allow exit_group(2) */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_exit_group, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),

    /* Kill on ptrace */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ptrace, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

    /* Kill on kexec_load */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_kexec_load, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

    /* Default: kill on unrecognized syscall */
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
};

int install_seccomp_filter(void) {
    struct sock_fprog prog = {
        .len    = (unsigned short)(sizeof(strict_filter) / sizeof(strict_filter[0])),
        .filter = strict_filter,
    };

    /* Required: set no_new_privs before loading seccomp */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("prctl(NO_NEW_PRIVS)");
        return -1;
    }

    /* Load seccomp filter */
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) {
        perror("prctl(SECCOMP_MODE_FILTER)");
        return -1;
    }

    return 0;
}
```

### Production Seccomp Profile for Kubernetes

The following profile is suitable for most web service workloads — it blocks dangerous syscalls while allowing everything needed for a Go or Java service:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "architectures": [
    "SCMP_ARCH_X86_64",
    "SCMP_ARCH_X86",
    "SCMP_ARCH_X32"
  ],
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "access", "adjtimex",
        "alarm", "bind", "brk", "capget", "capset",
        "chdir", "chmod", "chown", "chown32",
        "clock_adjtime", "clock_adjtime64", "clock_getres",
        "clock_getres_time64", "clock_gettime", "clock_gettime64",
        "clock_nanosleep", "clock_nanosleep_time64",
        "close", "close_range", "connect", "copy_file_range",
        "creat", "dup", "dup2", "dup3",
        "epoll_create", "epoll_create1", "epoll_ctl",
        "epoll_pwait", "epoll_pwait2", "epoll_wait",
        "eventfd", "eventfd2",
        "execve", "execveat",
        "exit", "exit_group",
        "faccessat", "faccessat2", "fadvise64", "fadvise64_64",
        "fallocate", "fanotify_mark", "fchdir", "fchmod",
        "fchmodat", "fchown", "fchown32", "fchownat",
        "fcntl", "fcntl64", "fdatasync",
        "fgetxattr", "flistxattr",
        "flock", "fork", "fremovexattr", "fsetxattr",
        "fstat", "fstat64", "fstatat64", "fstatfs",
        "fstatfs64", "fsync", "ftruncate", "ftruncate64",
        "futex", "futex_time64", "futex_waitv",
        "get_mempolicy", "get_robust_list", "get_thread_area",
        "getcpu", "getcwd", "getdents", "getdents64",
        "getegid", "getegid32", "geteuid", "geteuid32",
        "getgid", "getgid32", "getgroups", "getgroups32",
        "getitimer", "getpeername", "getpgid", "getpgrp",
        "getpid", "getppid", "getpriority", "getrandom",
        "getresgid", "getresgid32", "getresuid", "getresuid32",
        "getrlimit", "getrusage", "getsid", "getsockname",
        "getsockopt", "gettid", "gettimeofday",
        "getuid", "getuid32",
        "getxattr",
        "inotify_add_watch", "inotify_init", "inotify_init1",
        "inotify_rm_watch", "ioctl",
        "io_cancel", "io_destroy", "io_getevents",
        "io_pgetevents", "io_pgetevents_time64",
        "io_setup", "io_submit", "io_uring_enter",
        "io_uring_register", "io_uring_setup",
        "ioprio_get", "ioprio_set",
        "kill",
        "lchown", "lchown32", "lgetxattr",
        "link", "linkat", "listen",
        "listxattr", "llistxattr",
        "lremovexattr", "lseek",
        "lsetxattr", "lstat", "lstat64",
        "madvise", "memfd_create", "memfd_secret",
        "mincore", "mkdir", "mkdirat",
        "mknod", "mknodat",
        "mlock", "mlock2", "mlockall",
        "mmap", "mmap2",
        "mount_setattr",
        "mprotect",
        "mq_getsetattr", "mq_notify", "mq_open",
        "mq_timedreceive", "mq_timedreceive_time64",
        "mq_timedsend", "mq_timedsend_time64",
        "mq_unlink",
        "mremap", "msgctl", "msgget", "msgrcv", "msgsnd",
        "msync", "munlock", "munlockall", "munmap",
        "nanosleep",
        "newfstatat",
        "open", "openat", "openat2",
        "pause",
        "pidfd_open", "pidfd_send_signal",
        "pipe", "pipe2", "poll", "ppoll", "ppoll_time64",
        "prctl", "pread64", "preadv", "preadv2",
        "prlimit64",
        "process_mrelease",
        "pselect6", "pselect6_time64",
        "ptrace",
        "pwrite64", "pwritev", "pwritev2",
        "read", "readahead", "readlink", "readlinkat",
        "readv", "recv", "recvfrom", "recvmmsg",
        "recvmmsg_time64", "recvmsg",
        "remap_file_pages", "removexattr",
        "rename", "renameat", "renameat2",
        "restart_syscall",
        "rmdir",
        "rseq",
        "rt_sigaction", "rt_sigpending", "rt_sigprocmask",
        "rt_sigqueueinfo", "rt_sigreturn",
        "rt_sigsuspend", "rt_sigtimedwait",
        "rt_sigtimedwait_time64",
        "rt_tgsigqueueinfo",
        "sched_getaffinity", "sched_getattr",
        "sched_getparam", "sched_getscheduler",
        "sched_rr_get_interval", "sched_rr_get_interval_time64",
        "sched_setaffinity", "sched_setattr",
        "sched_setparam", "sched_setscheduler",
        "sched_yield",
        "seccomp",
        "select",
        "semctl", "semget", "semop", "semtimedop",
        "semtimedop_time64",
        "send", "sendfile", "sendfile64",
        "sendmmsg", "sendmsg", "sendto",
        "set_mempolicy", "set_mempolicy_home_node",
        "set_robust_list", "set_thread_area",
        "set_tid_address",
        "setfsgid", "setfsgid32",
        "setfsuid", "setfsuid32",
        "setgid", "setgid32",
        "setgroups", "setgroups32",
        "setitimer",
        "setpgid", "setpriority", "setregid",
        "setregid32", "setresgid", "setresgid32",
        "setresuid", "setresuid32",
        "setreuid", "setreuid32",
        "setrlimit", "setsid",
        "setsockopt",
        "setuid", "setuid32",
        "setxattr",
        "shmat", "shmctl", "shmdt", "shmget",
        "shutdown", "sigaltstack",
        "signalfd", "signalfd4",
        "socket", "socketcall", "socketpair",
        "splice", "stat", "stat64",
        "statfs", "statfs64", "statx",
        "symlink", "symlinkat",
        "sync", "sync_file_range",
        "syncfs", "sysinfo",
        "tee", "tgkill", "time", "timer_create",
        "timer_delete", "timer_getoverrun",
        "timer_gettime", "timer_gettime64",
        "timer_settime", "timer_settime64",
        "timerfd_create", "timerfd_gettime",
        "timerfd_gettime64", "timerfd_settime",
        "timerfd_settime64", "times", "tkill",
        "truncate", "truncate64", "ugetrlimit",
        "umask", "uname",
        "unlink", "unlinkat",
        "utime", "utimensat", "utimensat_time64",
        "utimes",
        "vfork",
        "wait4", "waitid", "waitpid",
        "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["personality"],
      "action": "SCMP_ACT_ALLOW",
      "args": [
        {"index": 0, "value": 0, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 8, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 131072, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 131080, "op": "SCMP_CMP_EQ"},
        {"index": 0, "value": 4294967295, "op": "SCMP_CMP_EQ"}
      ]
    }
  ]
}
```

### Applying Seccomp in Kubernetes

```yaml
# Pod-level seccomp profile
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
  annotations:
    # Legacy annotation method (pre-1.19)
    # seccomp.security.alpha.kubernetes.io/pod: 'localhost/custom-profile.json'
spec:
  securityContext:
    # Modern method (1.22+ stable)
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/my-service-seccomp.json

  containers:
    - name: app
      image: registry.company.com/myapp:v2.0.0
      securityContext:
        # Container-level override (takes precedence over pod-level)
        seccompProfile:
          type: RuntimeDefault
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        runAsUser: 65534
        capabilities:
          drop:
            - ALL
```

### Writing Seccomp Profiles with libseccomp in Go

```go
// pkg/seccomp/builder.go
package seccomp

import (
    "encoding/json"
    "os"

    specs "github.com/opencontainers/runtime-spec/specs-go"
)

// ProfileBuilder constructs seccomp profiles programmatically
type ProfileBuilder struct {
    profile specs.LinuxSeccomp
}

func NewProfileBuilder() *ProfileBuilder {
    return &ProfileBuilder{
        profile: specs.LinuxSeccomp{
            DefaultAction: specs.ActErrno,
            Architectures: []specs.Arch{
                specs.ArchX86_64,
                specs.ArchX86,
                specs.ArchX32,
            },
        },
    }
}

// AllowSyscalls adds syscalls to the allowlist
func (b *ProfileBuilder) AllowSyscalls(names ...string) *ProfileBuilder {
    b.profile.Syscalls = append(b.profile.Syscalls, specs.LinuxSyscall{
        Names:  names,
        Action: specs.ActAllow,
    })
    return b
}

// BlockSyscall adds a syscall to the blocklist with kill action
func (b *ProfileBuilder) BlockSyscall(name string) *ProfileBuilder {
    b.profile.Syscalls = append(b.profile.Syscalls, specs.LinuxSyscall{
        Names:  []string{name},
        Action: specs.ActKillProcess,
    })
    return b
}

// AllowSyscallWithArgs allows a syscall only when argument matches
func (b *ProfileBuilder) AllowSyscallWithArgs(
    name string,
    argIndex uint,
    op specs.LinuxSeccompOperator,
    value uint64,
) *ProfileBuilder {
    b.profile.Syscalls = append(b.profile.Syscalls, specs.LinuxSyscall{
        Names:  []string{name},
        Action: specs.ActAllow,
        Args: []specs.LinuxSeccompArg{
            {Index: argIndex, Value: value, Op: op},
        },
    })
    return b
}

// Build returns the completed profile
func (b *ProfileBuilder) Build() specs.LinuxSeccomp {
    return b.profile
}

// WriteToFile serializes the profile to a JSON file
func (b *ProfileBuilder) WriteToFile(path string) error {
    data, err := json.MarshalIndent(b.profile, "", "  ")
    if err != nil {
        return err
    }
    return os.WriteFile(path, data, 0644)
}

// GoServiceProfile returns a seccomp profile suitable for Go HTTP services
func GoServiceProfile() specs.LinuxSeccomp {
    builder := NewProfileBuilder()

    // Networking
    builder.AllowSyscalls(
        "accept", "accept4", "bind", "connect",
        "getpeername", "getsockname", "getsockopt",
        "listen", "recv", "recvfrom", "recvmmsg", "recvmsg",
        "send", "sendmmsg", "sendmsg", "sendto",
        "setsockopt", "shutdown", "socket", "socketpair",
    )

    // File I/O
    builder.AllowSyscalls(
        "access", "chdir", "close", "creat",
        "dup", "dup2", "dup3",
        "fadvise64", "fallocate", "fcntl",
        "flock", "fstat", "fstatat64", "fstatfs",
        "fsync", "ftruncate",
        "getcwd", "getdents", "getdents64",
        "link", "linkat", "lseek",
        "mkdir", "mkdirat",
        "newfstatat", "open", "openat", "openat2",
        "read", "readahead", "readlink", "readlinkat", "readv",
        "rename", "renameat", "renameat2",
        "rmdir", "stat", "statfs", "statx",
        "symlink", "symlinkat",
        "truncate", "unlink", "unlinkat",
        "write", "writev",
    )

    // Process management
    builder.AllowSyscalls(
        "clone", "clone3",
        "execve", "execveat",
        "exit", "exit_group",
        "fork", "futex", "futex_time64", "futex_waitv",
        "getpid", "getppid", "gettid",
        "kill", "prctl",
        "rt_sigaction", "rt_sigpending", "rt_sigprocmask",
        "rt_sigqueueinfo", "rt_sigreturn",
        "rt_sigsuspend", "rt_sigtimedwait",
        "sched_getaffinity", "sched_yield",
        "set_robust_list", "set_tid_address",
        "tgkill", "tkill",
        "wait4", "waitid",
    )

    // Memory management
    builder.AllowSyscalls(
        "brk", "madvise", "memfd_create",
        "mincore", "mlock", "mlock2", "mlockall",
        "mmap", "mprotect", "mremap",
        "munlock", "munlockall", "munmap",
        "remap_file_pages",
    )

    // System info
    builder.AllowSyscalls(
        "arch_prctl",
        "clock_getres", "clock_gettime",
        "clock_nanosleep", "epoll_create",
        "epoll_create1", "epoll_ctl",
        "epoll_pwait", "epoll_pwait2", "epoll_wait",
        "eventfd", "eventfd2",
        "getrandom", "getrlimit",
        "getrusage", "gettimeofday",
        "inotify_add_watch", "inotify_init", "inotify_init1",
        "inotify_rm_watch",
        "nanosleep", "pause",
        "pipe", "pipe2", "poll", "ppoll",
        "prlimit64", "pselect6",
        "restart_syscall", "rseq",
        "seccomp", "select",
        "sigaltstack", "signalfd", "signalfd4",
        "sysinfo", "time", "timerfd_create",
        "timerfd_gettime", "timerfd_settime",
        "uname", "umask",
    )

    // Identity
    builder.AllowSyscalls(
        "capget", "capset",
        "getegid", "geteuid", "getgid", "getgroups",
        "getresgid", "getresuid",
        "getuid",
        "setgid", "setgroups",
        "setregid", "setresgid", "setresuid",
        "setreuid", "setuid",
    )

    // io_uring (modern async I/O used by some Go runtimes)
    builder.AllowSyscalls(
        "io_uring_enter", "io_uring_register", "io_uring_setup",
    )

    // Block dangerous syscalls explicitly
    builder.BlockSyscall("kexec_file_load")
    builder.BlockSyscall("kexec_load")
    builder.BlockSyscall("ptrace")
    builder.BlockSyscall("bpf")
    builder.BlockSyscall("perf_event_open")

    return builder.Build()
}
```

## Landlock LSM: Filesystem Sandboxing

Landlock (merged in Linux 5.13) is a stackable LSM that allows unprivileged processes to restrict their own filesystem access. Unlike SELinux/AppArmor which are system-wide policies, Landlock is self-imposed and requires no special configuration — a process can cage itself.

### Landlock Concepts

Landlock operates on two abstractions:

1. **Ruleset**: A set of allowed access rights (read, write, execute, etc.)
2. **Rules**: Specific path/device entries granted to the process

A process calls `landlock_create_ruleset()`, adds rules with `landlock_add_rule()`, then applies the ruleset with `landlock_restrict_self()`. After application, any filesystem access not covered by rules returns `EPERM`.

### Landlock in C

```c
/* landlock_sandbox.c - Restrict filesystem access to specific directories */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <fcntl.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <linux/landlock.h>

#ifndef landlock_create_ruleset
static inline int landlock_create_ruleset(
    const struct landlock_ruleset_attr *attr,
    size_t size,
    __u32 flags)
{
    return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
#endif

#ifndef landlock_add_rule
static inline int landlock_add_rule(
    int ruleset_fd,
    enum landlock_rule_type rule_type,
    const void *rule_attr,
    __u32 flags)
{
    return syscall(__NR_landlock_add_rule, ruleset_fd, rule_type, rule_attr, flags);
}
#endif

#ifndef landlock_restrict_self
static inline int landlock_restrict_self(int ruleset_fd, __u32 flags)
{
    return syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}
#endif

#define LANDLOCK_ACCESS_FS_READ  \
    (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)

#define LANDLOCK_ACCESS_FS_WRITE \
    (LANDLOCK_ACCESS_FS_WRITE_FILE |           \
     LANDLOCK_ACCESS_FS_REMOVE_DIR |           \
     LANDLOCK_ACCESS_FS_REMOVE_FILE |          \
     LANDLOCK_ACCESS_FS_MAKE_CHAR |            \
     LANDLOCK_ACCESS_FS_MAKE_DIR |             \
     LANDLOCK_ACCESS_FS_MAKE_REG |             \
     LANDLOCK_ACCESS_FS_MAKE_SOCK |            \
     LANDLOCK_ACCESS_FS_MAKE_FIFO |            \
     LANDLOCK_ACCESS_FS_MAKE_BLOCK |           \
     LANDLOCK_ACCESS_FS_MAKE_SYM |             \
     LANDLOCK_ACCESS_FS_REFER |                \
     LANDLOCK_ACCESS_FS_TRUNCATE)

static int add_path_rule(int ruleset_fd, const char *path,
                          __u64 allowed_access)
{
    struct landlock_path_beneath_attr path_attr = {
        .allowed_access = allowed_access,
    };

    path_attr.parent_fd = open(path, O_PATH | O_CLOEXEC);
    if (path_attr.parent_fd < 0) {
        fprintf(stderr, "Failed to open %s: %m\n", path);
        return -1;
    }

    int ret = landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH,
                                 &path_attr, 0);
    close(path_attr.parent_fd);
    return ret;
}

int apply_landlock_sandbox(void) {
    /* Define what filesystem operations we permit */
    struct landlock_ruleset_attr ruleset_attr = {
        .handled_access_fs =
            LANDLOCK_ACCESS_FS_READ |
            LANDLOCK_ACCESS_FS_WRITE |
            LANDLOCK_ACCESS_FS_EXECUTE,
    };

    int ruleset_fd = landlock_create_ruleset(&ruleset_attr,
                                              sizeof(ruleset_attr), 0);
    if (ruleset_fd < 0) {
        /* Landlock not supported on this kernel */
        perror("landlock_create_ruleset");
        return -1;
    }

    /* Allow read access to /usr and /lib */
    if (add_path_rule(ruleset_fd, "/usr", LANDLOCK_ACCESS_FS_READ |
                      LANDLOCK_ACCESS_FS_EXECUTE) < 0) {
        close(ruleset_fd);
        return -1;
    }

    if (add_path_rule(ruleset_fd, "/lib", LANDLOCK_ACCESS_FS_READ |
                      LANDLOCK_ACCESS_FS_EXECUTE) < 0) {
        close(ruleset_fd);
        return -1;
    }

    /* Allow read+write access to /tmp */
    if (add_path_rule(ruleset_fd, "/tmp",
                      LANDLOCK_ACCESS_FS_READ |
                      LANDLOCK_ACCESS_FS_WRITE) < 0) {
        close(ruleset_fd);
        return -1;
    }

    /* Allow read-only to /etc */
    if (add_path_rule(ruleset_fd, "/etc", LANDLOCK_ACCESS_FS_READ) < 0) {
        close(ruleset_fd);
        return -1;
    }

    /* Apply: no new privileges before restricting self */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        perror("prctl(NO_NEW_PRIVS)");
        close(ruleset_fd);
        return -1;
    }

    if (landlock_restrict_self(ruleset_fd, 0) != 0) {
        perror("landlock_restrict_self");
        close(ruleset_fd);
        return -1;
    }

    close(ruleset_fd);
    printf("[Landlock] Filesystem sandbox applied\n");
    return 0;
}
```

### Landlock in Go using golang.org/x/sys

```go
// pkg/landlock/sandbox.go
package landlock

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"

    "golang.org/x/sys/unix"
)

// AccessRight represents a Landlock filesystem access permission
type AccessRight uint64

const (
    AccessFSExecute    AccessRight = 1 << 0
    AccessFSWriteFile  AccessRight = 1 << 1
    AccessFSReadFile   AccessRight = 1 << 2
    AccessFSReadDir    AccessRight = 1 << 3
    AccessFSRemoveDir  AccessRight = 1 << 4
    AccessFSRemoveFile AccessRight = 1 << 5
    AccessFSMakeChar   AccessRight = 1 << 6
    AccessFSMakeDir    AccessRight = 1 << 7
    AccessFSMakeReg    AccessRight = 1 << 8
    AccessFSMakeSock   AccessRight = 1 << 9
    AccessFSMakeFifo   AccessRight = 1 << 10
    AccessFSMakeBlock  AccessRight = 1 << 11
    AccessFSMakeSym    AccessRight = 1 << 12
    AccessFSRefer      AccessRight = 1 << 13
    AccessFSTruncate   AccessRight = 1 << 14

    // Convenience combinations
    AccessFSRead  = AccessFSReadFile | AccessFSReadDir
    AccessFSWrite = AccessFSWriteFile | AccessFSRemoveDir | AccessFSRemoveFile |
        AccessFSMakeChar | AccessFSMakeDir | AccessFSMakeReg |
        AccessFSMakeSock | AccessFSMakeFifo | AccessFSMakeBlock |
        AccessFSMakeSym | AccessFSRefer | AccessFSTruncate
)

// PathRule defines allowed access for a specific filesystem path
type PathRule struct {
    Path          string
    AllowedAccess AccessRight
}

// Sandbox applies Landlock restrictions to the current process
func Sandbox(rules []PathRule) error {
    // Check Landlock ABI version
    abiVersion, err := getLandlockABI()
    if err != nil {
        return fmt.Errorf("landlock not supported: %w", err)
    }

    // Cap access rights to supported ABI version
    handledAccess := allAccessRights(abiVersion)

    rulesetAttr := landrulesetAttr{
        handledAccessFS: uint64(handledAccess),
    }

    rulesetFd, _, errno := syscall.Syscall(
        unix.SYS_LANDLOCK_CREATE_RULESET,
        uintptr(unsafe.Pointer(&rulesetAttr)),
        unsafe.Sizeof(rulesetAttr),
        0,
    )
    if errno != 0 {
        return fmt.Errorf("landlock_create_ruleset: %w", errno)
    }
    defer syscall.Close(int(rulesetFd))

    for _, rule := range rules {
        if err := addPathRule(int(rulesetFd), rule.Path, rule.AllowedAccess); err != nil {
            return fmt.Errorf("failed to add rule for %s: %w", rule.Path, err)
        }
    }

    // Set no_new_privs before restricting
    if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
        return fmt.Errorf("prctl(NO_NEW_PRIVS): %w", err)
    }

    _, _, errno = syscall.Syscall(
        unix.SYS_LANDLOCK_RESTRICT_SELF,
        rulesetFd,
        0,
        0,
    )
    if errno != 0 {
        return fmt.Errorf("landlock_restrict_self: %w", errno)
    }

    return nil
}

type landrulesetAttr struct {
    handledAccessFS uint64
}

type landpathBeneathAttr struct {
    allowedAccess uint64
    parentFd      int32
    _             [4]byte // padding
}

func addPathRule(rulesetFd int, path string, access AccessRight) error {
    parentFd, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
    if err != nil {
        return fmt.Errorf("open(%s): %w", path, err)
    }
    defer unix.Close(parentFd)

    attr := landpathBeneathAttr{
        allowedAccess: uint64(access),
        parentFd:      int32(parentFd),
    }

    _, _, errno := syscall.Syscall(
        unix.SYS_LANDLOCK_ADD_RULE,
        uintptr(rulesetFd),
        1, // LANDLOCK_RULE_PATH_BENEATH
        uintptr(unsafe.Pointer(&attr)),
    )
    if errno != 0 {
        return fmt.Errorf("landlock_add_rule: %w", errno)
    }
    return nil
}

func getLandlockABI() (int, error) {
    ret, _, errno := syscall.Syscall(
        unix.SYS_LANDLOCK_CREATE_RULESET,
        0, 0,
        1, // LANDLOCK_CREATE_RULESET_VERSION
    )
    if errno != 0 {
        return 0, fmt.Errorf("syscall: %w", errno)
    }
    return int(ret), nil
}

func allAccessRights(abiVersion int) AccessRight {
    rights := AccessFSRead | AccessFSWrite | AccessFSExecute
    if abiVersion >= 2 {
        rights |= AccessFSRefer
    }
    if abiVersion >= 3 {
        rights |= AccessFSTruncate
    }
    return rights
}

// WebServiceSandbox applies a conservative sandbox for web services
func WebServiceSandbox(configDir, dataDir, tmpDir string) error {
    rules := []PathRule{
        // Read-only system paths
        {Path: "/usr", AllowedAccess: AccessFSRead | AccessFSExecute},
        {Path: "/lib", AllowedAccess: AccessFSRead | AccessFSExecute},
        {Path: "/lib64", AllowedAccess: AccessFSRead | AccessFSExecute},
        {Path: "/etc", AllowedAccess: AccessFSRead},
        {Path: "/proc", AllowedAccess: AccessFSRead},
        {Path: "/sys/kernel/mm/transparent_hugepage", AllowedAccess: AccessFSRead},

        // Application-specific paths
        {Path: configDir, AllowedAccess: AccessFSRead},
        {Path: dataDir, AllowedAccess: AccessFSRead | AccessFSWrite},
        {Path: tmpDir, AllowedAccess: AccessFSRead | AccessFSWrite},
    }

    return Sandbox(rules)
}
```

## Combining Isolation Primitives

### Complete Sandbox Implementation

```go
// pkg/sandbox/sandbox.go - Production-ready process sandbox
package sandbox

import (
    "fmt"
    "os"
    "os/exec"
    "syscall"

    "github.com/company/sandbox/pkg/landlock"
    "github.com/company/sandbox/pkg/seccomp"
    "golang.org/x/sys/unix"
)

// Config defines isolation requirements
type Config struct {
    // Namespace flags
    NewUserNS   bool
    NewPIDNS    bool
    NewNetNS    bool
    NewMountNS  bool
    Hostname    string

    // UID/GID mappings (for user namespaces)
    UID int
    GID int

    // Landlock rules
    FSRules []landlock.PathRule

    // Seccomp profile path (empty = use RuntimeDefault)
    SeccompProfile string

    // Drop all capabilities
    DropAllCaps bool
}

// Apply installs isolation for the current process
// This must be called after fork but before exec
func Apply(cfg Config) error {
    // 1. Drop capabilities
    if cfg.DropAllCaps {
        if err := dropAllCapabilities(); err != nil {
            return fmt.Errorf("drop capabilities: %w", err)
        }
    }

    // 2. Set no_new_privs (prerequisite for seccomp + landlock)
    if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
        return fmt.Errorf("PR_SET_NO_NEW_PRIVS: %w", err)
    }

    // 3. Apply Landlock filesystem restrictions
    if len(cfg.FSRules) > 0 {
        if err := landlock.Sandbox(cfg.FSRules); err != nil {
            fmt.Printf("warning: landlock not available: %v\n", err)
            // Landlock may not be available on older kernels
        }
    }

    // 4. Load seccomp filter
    if cfg.SeccompProfile != "" {
        data, err := os.ReadFile(cfg.SeccompProfile)
        if err != nil {
            return fmt.Errorf("read seccomp profile: %w", err)
        }
        if err := applySeccompProfile(data); err != nil {
            return fmt.Errorf("apply seccomp: %w", err)
        }
    }

    return nil
}

func dropAllCapabilities() error {
    // Clear bounding set
    for cap := 0; cap <= 40; cap++ {
        if err := unix.Prctl(unix.PR_CAPBSET_DROP, uintptr(cap), 0, 0, 0); err != nil {
            // EINVAL means we've gone past the last valid capability
            if err == syscall.EINVAL {
                break
            }
        }
    }

    // Set inheritable, permitted, and effective sets to empty
    capData := [2]unix.CapUserData{}
    capHdr := unix.CapUserHeader{Version: unix.LINUX_CAPABILITY_VERSION_3}

    capData[0].Inheritable = 0
    capData[0].Permitted = 0
    capData[0].Effective = 0
    capData[1].Inheritable = 0
    capData[1].Permitted = 0
    capData[1].Effective = 0

    return unix.Capset(&capHdr, &capData[0])
}

// RunSandboxed runs a command with the specified isolation
func RunSandboxed(cfg Config, command string, args ...string) error {
    uid := os.Getuid()
    gid := os.Getgid()

    cmd := exec.Command(command, args...)
    cmd.Stdin = os.Stdin
    cmd.Stdout = os.Stdout
    cmd.Stderr = os.Stderr

    sysProcAttr := &syscall.SysProcAttr{}

    var cloneFlags uintptr
    if cfg.NewUserNS {
        cloneFlags |= syscall.CLONE_NEWUSER
        sysProcAttr.UidMappings = []syscall.SysProcIDMap{
            {ContainerID: 0, HostID: uid, Size: 1},
        }
        sysProcAttr.GidMappings = []syscall.SysProcIDMap{
            {ContainerID: 0, HostID: gid, Size: 1},
        }
    }
    if cfg.NewPIDNS {
        cloneFlags |= syscall.CLONE_NEWPID
    }
    if cfg.NewNetNS {
        cloneFlags |= syscall.CLONE_NEWNET
    }
    if cfg.NewMountNS {
        cloneFlags |= syscall.CLONE_NEWNS
    }

    if cfg.Hostname != "" {
        cloneFlags |= syscall.CLONE_NEWUTS
        sysProcAttr.Hostname = cfg.Hostname
    }

    sysProcAttr.Cloneflags = cloneFlags
    cmd.SysProcAttr = sysProcAttr

    return cmd.Run()
}
```

## Verification and Testing

### Checking Applied Namespaces

```bash
#!/bin/bash
# verify-isolation.sh - Verify process isolation

PID="${1:?PID required}"

echo "=== Namespace isolation for PID $PID ==="
echo ""

# Check each namespace
for ns in cgroup ipc mnt net pid user uts; do
    HOST_NS=$(readlink "/proc/1/ns/$ns" 2>/dev/null)
    PROC_NS=$(readlink "/proc/$PID/ns/$ns" 2>/dev/null)

    if [ "$HOST_NS" = "$PROC_NS" ]; then
        echo "[$ns] SHARED with host: $PROC_NS"
    else
        echo "[$ns] ISOLATED: $PROC_NS (host: $HOST_NS)"
    fi
done

echo ""
echo "=== Capabilities for PID $PID ==="
grep 'Cap' "/proc/$PID/status"

echo ""
echo "=== Seccomp mode ==="
grep 'Seccomp' "/proc/$PID/status"

echo ""
echo "=== Landlock (via /proc/PID/status) ==="
grep -i 'landlock\|NoNewPrivs' "/proc/$PID/status" 2>/dev/null || echo "Not available"
```

### Syscall Audit with strace

```bash
# Record all syscalls made by a process (for profile generation)
strace -f -e trace=all -o /tmp/strace.log ./my-service

# Extract unique syscall names
grep -oP '(?<=^)[a-z_0-9]+(?=\()' /tmp/strace.log | sort -u

# Generate a base seccomp allowlist
strace -f -e trace=all ./my-service 2>&1 | \
  grep -oP '^[a-z_0-9]+(?=\()' | \
  sort -u | \
  jq -Rn '[.,inputs]' > syscalls-used.json
```

## Production Integration: Kubernetes Pod Security

```yaml
# Complete secure pod spec combining all primitives
apiVersion: v1
kind: Pod
metadata:
  name: fully-isolated-service
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    fsGroup: 65534
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/my-service-seccomp.json
    sysctls:
      - name: net.ipv4.ip_unprivileged_port_start
        value: "1024"

  containers:
    - name: service
      image: registry.company.com/service:v1.0.0
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
        # Seccomp at container level overrides pod level
        seccompProfile:
          type: Localhost
          localhostProfile: profiles/my-service-seccomp.json
      volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: data
          mountPath: /data

  volumes:
    - name: tmp
      emptyDir:
        medium: Memory
        sizeLimit: 128Mi
    - name: data
      persistentVolumeClaim:
        claimName: service-data
```

## Conclusion

Linux process isolation is a layered practice, not a single mechanism:

- **Namespaces** provide visibility isolation: each namespace type isolates a specific resource view (filesystem mounts, process IDs, network interfaces, user identities)
- **User namespaces** enable unprivileged containers by mapping container root to an unprivileged host UID, making the entire isolation stack available without root
- **seccomp-bpf** reduces attack surface by eliminating syscalls the process will never use — this stops entire classes of kernel exploitation
- **Landlock LSM** allows processes to self-restrict filesystem access programmatically, requiring no system configuration and working even in unprivileged contexts
- **Capabilities** decompose the root privilege monolith into fine-grained tokens that can be dropped independently

The combination of these primitives — namespaces for isolation, seccomp for syscall filtering, Landlock for filesystem restriction, and capabilities for privilege control — forms the complete isolation model that production container runtimes implement. Understanding each layer enables writing more precise policies and building custom isolation tools for scenarios where container runtimes are not appropriate.
