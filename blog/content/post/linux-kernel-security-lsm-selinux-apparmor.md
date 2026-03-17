---
title: "Linux Kernel Security: LSM Framework, SELinux Policies, and AppArmor Profile Development"
date: 2030-03-05T00:00:00-05:00
draft: false
tags: ["Linux", "SELinux", "AppArmor", "LSM", "seccomp", "Security", "Kernel"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to the Linux Security Modules framework, writing custom SELinux policies with audit2allow, AppArmor profile development workflows, and seccomp integration for production hardening."
more_link: "yes"
url: "/linux-kernel-security-lsm-selinux-apparmor/"
---

The Linux Security Modules (LSM) framework is the kernel-level foundation that underpins every mandatory access control system in modern Linux distributions. Understanding how SELinux, AppArmor, and seccomp interact with the LSM hook infrastructure allows security engineers to build defense-in-depth policies that survive real-world adversarial conditions. This guide covers the architecture from kernel hooks through to production policy deployment, with a focus on enterprise environments running containerized workloads.

<!--more-->

## The LSM Framework Architecture

The LSM framework was merged into the Linux kernel in 2.6 and provides a set of hook points throughout the kernel that allow security modules to intercept and authorize security-sensitive operations. Before the LSM framework, the only mandatory access controls available were ad-hoc patches like LIDS that were difficult to maintain across kernel versions.

### Hook Architecture

The kernel defines hundreds of hook points, each corresponding to a security-sensitive operation. When the kernel is about to perform such an operation, it calls the registered security hooks. If any hook returns a non-zero value, the operation is denied.

```c
// Simplified representation of how LSM hooks work in the kernel
// From security/security.c

int security_file_permission(struct file *file, int mask)
{
    int ret;

    ret = call_int_hook(file_permission, 0, file, mask);
    if (ret)
        return ret;

    return fsnotify_perm(file, mask);
}

// The hook list is built at compile time or via registration
// Each LSM module registers its hooks during init
static int __init selinux_init(void)
{
    security_add_hooks(selinux_hooks, ARRAY_SIZE(selinux_hooks),
                       &selinux_lsmid);
    return 0;
}
```

The key hook categories include:

- **inode hooks**: File creation, permission checks, attribute setting
- **file hooks**: Open, read, write, ioctl, mmap operations
- **task hooks**: Process creation, signal sending, capability checks
- **network hooks**: Socket creation, bind, connect, send/recv operations
- **IPC hooks**: Shared memory, semaphore, message queue access
- **key hooks**: Keyring access and manipulation

### Stacking LSMs

Since kernel 4.2, the LSM framework supports stacking multiple security modules. This is now used in production — Ubuntu systems commonly run AppArmor as the primary LSM with Yama providing additional ptrace restrictions.

```bash
# Check which LSMs are active on your system
cat /sys/kernel/security/lsm

# Common output on Ubuntu 22.04
# lockdown,capability,landlock,yama,apparmor

# On RHEL/CentOS with SELinux
cat /sys/kernel/security/lsm
# lockdown,capability,yama,selinux

# Check via boot parameters
cat /proc/cmdline | grep -o 'lsm=[^ ]*'

# Kernel compile-time configuration
grep -E 'CONFIG_(SECURITY_SELINUX|SECURITY_APPARMOR|SECURITY_YAMA|SECURITY_LANDLOCK)' \
    /boot/config-$(uname -r)
```

The lockdown LSM is worth special mention — it implements the kernel's lockdown feature (integrity and confidentiality modes) that restricts even root from performing operations that could compromise the kernel's integrity.

## SELinux: Architecture and Policy Model

SELinux implements a Type Enforcement (TE) security model with optional Multi-Level Security (MLS) and Multi-Category Security (MCS). Every process and object is assigned a security context, and the policy defines which contexts can interact with which other contexts.

### Security Contexts

A security context takes the form `user:role:type:level` where:

- **user**: SELinux user (not Unix user) — `system_u`, `unconfined_u`, `staff_u`
- **role**: The role a user can assume — `system_r`, `object_r`, `sysadm_r`
- **type**: The most granular part of TE policy — `httpd_t`, `sshd_t`, `container_t`
- **level**: MLS/MCS sensitivity level — `s0`, `s0:c1,c2`

```bash
# View contexts of running processes
ps -eZ | grep httpd
# system_u:system_r:httpd_t:s0    1234 ? 00:00:01 httpd

# View file contexts
ls -Z /var/www/html/
# system_u:object_r:httpd_sys_content_t:s0 index.html

# View your current context
id -Z
# unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023

# View context of a network socket
ss -Z -tlnp | grep :80

# Check context of a specific file
stat --printf='%C\n' /etc/shadow
# system_u:object_r:shadow_t:s0
```

### Policy Architecture: Modules and the Policy Store

SELinux policy is stored in a compiled binary format (`.pp` files) and loaded into the kernel. The policy store manages which modules are active and their priority.

```bash
# List installed policy modules
semodule -l | head -20

# Show module details
semodule -l -v | grep httpd

# The policy store location
ls /etc/selinux/targeted/policy/
# policy.31  (the compiled binary)

# Active module store
ls /var/lib/selinux/targeted/active/modules/

# Check current enforcement mode
getenforce
# Enforcing

# Temporarily set to permissive (for troubleshooting only)
setenforce 0

# Persistent mode change (requires reboot)
sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config
```

### Writing SELinux Policy with audit2allow

The standard workflow for creating SELinux policy starts with running the application in permissive mode, capturing AVC (Access Vector Cache) denials in the audit log, and using `audit2allow` to generate policy from those denials.

#### Step 1: Enable Permissive Mode for a Domain

```bash
# Put just the target domain into permissive mode (not the entire system)
semanage permissive -a myapp_t

# Verify
semodule -l | grep permissive
# permissivedomains  (module managing permissive domains)

# List all permissive domains
semanage permissive -l
```

#### Step 2: Exercise the Application

Run the application through all its code paths while permissive. The kernel will log AVC denials to the audit log without blocking operations.

```bash
# Watch AVC messages in real time
ausearch -m AVC -ts recent -i | tail -f

# Or use audit2why for human-readable explanations
ausearch -m AVC -ts today | audit2why

# Sample AVC denial
# type=AVC msg=audit(1709654321.123:456): avc:  denied  { read } for
#   pid=12345 comm="myapp" name="config.yaml" dev="sda1" ino=789012
#   scontext=system_u:system_r:myapp_t:s0
#   tcontext=system_u:object_r:etc_t:s0
#   tclass=file permissive=1
```

#### Step 3: Generate Policy with audit2allow

```bash
# Generate a policy module from recent AVC denials
ausearch -m AVC -ts today | audit2allow -M myapp_policy

# This creates:
# myapp_policy.te   (human-readable Type Enforcement rules)
# myapp_policy.pp   (compiled policy module)

# Examine the generated .te file
cat myapp_policy.te
```

```
module myapp_policy 1.0;

require {
    type myapp_t;
    type etc_t;
    type var_log_t;
    type proc_t;
    class file { read open getattr };
    class dir { search getattr };
}

#============= myapp_t ==============
allow myapp_t etc_t:file { read open getattr };
allow myapp_t etc_t:dir { search getattr };
allow myapp_t var_log_t:file { write append create open };
allow myapp_t proc_t:file { read };
```

#### Step 4: Review and Refine the Policy

The auto-generated policy is a starting point, not a final policy. Review each rule carefully.

```bash
# Check if a rule is too broad
sesearch --allow -s myapp_t -t etc_t -c file
# Look for rules that grant access to sensitive files

# Use audit2allow with -R to check for existing interfaces you can reuse
ausearch -m AVC -ts today | audit2allow -R
# This suggests using existing policy interfaces rather than raw allow rules
```

A well-written `.te` file for a custom application:

```
policy_module(myapp, 1.0.0)

########################################
#
# Declarations
#

type myapp_t;
type myapp_exec_t;

# Establish the domain transition
init_daemon_domain(myapp_t, myapp_exec_t)

type myapp_conf_t;
files_config_file(myapp_conf_t)

type myapp_log_t;
logging_log_file(myapp_log_t)

type myapp_var_run_t;
files_pid_file(myapp_var_run_t)

########################################
#
# myapp local policy
#

# Allow standard init daemon operations
allow myapp_t self:fifo_file rw_fifo_file_perms;
allow myapp_t self:unix_stream_socket create_stream_socket_perms;

# Network: allow binding to port 8080
allow myapp_t self:tcp_socket { create accept listen bind connect };
corenet_tcp_bind_generic_node(myapp_t)
corenet_tcp_bind_http_cache_port(myapp_t)

# Read our own configuration
allow myapp_t myapp_conf_t:file read_file_perms;
allow myapp_t myapp_conf_t:dir list_dir_perms;

# Write to our own log
allow myapp_t myapp_log_t:file { create write append setattr };
allow myapp_t myapp_log_t:dir { write add_name };

# Write PID file
allow myapp_t myapp_var_run_t:file manage_file_perms;
allow myapp_t myapp_var_run_t:dir manage_dir_perms;
files_pid_filetrans(myapp_t, myapp_var_run_t, file)

# DNS lookups
sysnet_dns_name_resolve(myapp_t)
```

#### Step 5: Build and Install the Module

```bash
# Compile the .te file
checkmodule -M -m -o myapp.mod myapp.te
semodule_package -o myapp.pp -m myapp.mod

# Or use the Makefile approach (requires selinux-policy-devel)
make -f /usr/share/selinux/devel/Makefile myapp.pp

# Install the module
semodule -i myapp.pp

# Verify installation
semodule -l | grep myapp

# Remove permissive domain now that policy is written
semanage permissive -d myapp_t

# Test in enforcing mode
setenforce 1
systemctl restart myapp
journalctl -u myapp -n 50
ausearch -m AVC -ts recent -c myapp
```

### File Context Management

After writing policy, you need to set correct file contexts on your application's files.

```bash
# Define file contexts in your policy module
# Create myapp.fc file:
cat > myapp.fc << 'EOF'
/usr/sbin/myapp          --  gen_context(system_u:object_r:myapp_exec_t,s0)
/etc/myapp(/.*)?             gen_context(system_u:object_r:myapp_conf_t,s0)
/var/log/myapp(/.*)?         gen_context(system_u:object_r:myapp_log_t,s0)
/var/run/myapp\.pid      --  gen_context(system_u:object_r:myapp_var_run_t,s0)
EOF

# Compile with file contexts
semodule_package -o myapp.pp -m myapp.mod -f myapp.fc

# Apply file contexts to existing files
restorecon -Rv /usr/sbin/myapp /etc/myapp /var/log/myapp

# Verify
ls -Z /usr/sbin/myapp
# system_u:object_r:myapp_exec_t:s0 /usr/sbin/myapp

# For container images, label at build time
# In Dockerfile or buildah script:
# RUN chcon -t myapp_exec_t /usr/sbin/myapp
```

### SELinux Boolean Management

Booleans provide switchable behavior without recompiling policy:

```bash
# List all booleans
getsebool -a | grep httpd

# Common booleans for web applications
setsebool -P httpd_can_network_connect on
setsebool -P httpd_can_network_connect_db on
setsebool -P httpd_use_nfs on

# Define a custom boolean in your policy
gen_bool(myapp_connect_db, false)

# Use it in policy rules
if (myapp_connect_db) {
    allow myapp_t mysqld_t:tcp_socket { connect };
    allow myapp_t mysqld_port_t:tcp_socket { name_connect };
}
```

## AppArmor: Profile Development Workflow

AppArmor uses a path-based model rather than the label-based model of SELinux. Profiles specify allowed accesses by absolute path, which makes AppArmor policies easier to write but less precise for some use cases.

### Profile Structure

```
# AppArmor profile for a custom application
# /etc/apparmor.d/usr.sbin.myapp

#include <tunables/global>

/usr/sbin/myapp {
  #include <abstractions/base>
  #include <abstractions/nameservice>
  #include <abstractions/ssl_certs>

  # Capabilities
  capability net_bind_service,
  capability setuid,
  capability setgid,
  capability dac_override,

  # Network
  network inet tcp,
  network inet6 tcp,
  network inet udp,

  # Binary and libraries
  /usr/sbin/myapp mr,
  /usr/lib/myapp/** mr,
  /usr/lib{,32,64}/**.so* mr,

  # Configuration (read-only)
  /etc/myapp/ r,
  /etc/myapp/** r,

  # Logging (append)
  /var/log/myapp/ rw,
  /var/log/myapp/** rw,

  # PID file
  /var/run/myapp.pid rw,

  # Temp directory
  /tmp/myapp-** rw,
  owner /tmp/myapp-** rw,

  # /proc access
  @{PROC}/@{pid}/status r,
  @{PROC}/@{pid}/fd/ r,
  @{PROC}/sys/kernel/hostname r,

  # Deny everything else explicitly
  deny /etc/shadow r,
  deny /root/** rw,
  deny @{PROC}/[0-9]*/mem rw,
}
```

### AppArmor Profile Development with aa-genprof

```bash
# Install AppArmor utilities
apt-get install apparmor-utils

# Generate an initial profile using aa-genprof
# This runs the program and asks you about accesses
aa-genprof /usr/sbin/myapp

# In another terminal, run your application
systemctl start myapp
# Exercise all functionality

# Back in aa-genprof, press S to scan, then F to finish

# The profile is placed in complain mode initially
# Check its status
aa-status | grep myapp

# View the generated profile
cat /etc/apparmor.d/usr.sbin.myapp
```

### Using aa-logprof for Iterative Development

```bash
# Run in complain mode first to collect all denials without blocking
aa-complain /usr/sbin/myapp

# Check complain mode is active
aa-status --complain | grep myapp

# Or set via profile header:
# profile /usr/sbin/myapp flags=(complain) {

# Exercise the application thoroughly
systemctl restart myapp
# Run all test cases, integration tests, etc.

# Examine logged denials
grep "apparmor" /var/log/syslog | grep myapp | head -30

# Use aa-logprof to update the profile based on logged events
aa-logprof

# aa-logprof will prompt for each new access pattern:
# Profile: /usr/sbin/myapp
# Execute: /bin/bash
# Severity: 4
# (I)nherit / (C)hild / (N)amed / (X) ix On/Off / (D)eny / Abo(r)t / (F)inish

# After updating the profile, enforce it
aa-enforce /usr/sbin/myapp

# Reload the profile
apparmor_parser -r /etc/apparmor.d/usr.sbin.myapp

# Verify enforcement
aa-status | grep -A2 myapp
```

### AppArmor Abstractions and Variables

AppArmor provides reusable abstractions to avoid policy duplication:

```bash
# List available abstractions
ls /etc/apparmor.d/abstractions/

# Common abstractions
# base         - Basic system functionality
# nameservice  - DNS resolution
# ssl_certs    - Reading CA certificates
# python       - Python interpreter paths
# ruby         - Ruby interpreter paths
# user-tmp     - User temporary files

# Custom abstraction for your organization
cat > /etc/apparmor.d/abstractions/myorg-common << 'EOF'
  # MyOrg common policy
  /etc/myorg/ca-bundle.crt r,
  /var/run/myorg.sock rw,
  network inet stream,
  capability net_admin,
EOF

# Use in your profile
# /usr/sbin/myapp {
#   #include <abstractions/myorg-common>
#   ...
# }

# AppArmor variables (tunables)
cat /etc/apparmor.d/tunables/home
# @{HOME}=/home/*/ /root/
# @{HOMEDIRS}=/home/

# Custom tunables
cat > /etc/apparmor.d/tunables/myapp << 'EOF'
@{MYAPP_CONF}=/etc/myapp/ /opt/myapp/etc/
@{MYAPP_DATA}=/var/lib/myapp/ /opt/myapp/data/
EOF
```

### AppArmor for Containers

AppArmor profiles are critical for container hardening. Docker and containerd both support applying AppArmor profiles to containers.

```bash
# The default Docker AppArmor profile
cat /etc/apparmor.d/docker-default

# Load a custom profile for a specific container
apparmor_parser -r /etc/apparmor.d/myapp-container

# Run container with custom profile
docker run --security-opt apparmor=myapp-container myapp:latest

# In Kubernetes pod spec
# securityContext:
#   appArmorProfile:
#     type: Localhost
#     localhostProfile: myapp-container

# Kubernetes AppArmor annotation (older API)
# metadata:
#   annotations:
#     container.apparmor.security.beta.kubernetes.io/myapp: localhost/myapp-container
```

A container-optimized AppArmor profile:

```
#include <tunables/global>

profile myapp-container flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  # Allow all file operations in container filesystem
  file,

  # Deny dangerous mounts
  deny mount,
  deny remount,
  deny umount,

  # Deny privileged operations
  deny capability sys_admin,
  deny capability sys_ptrace,
  deny capability sys_module,
  deny capability sys_rawio,
  deny capability mknod,
  deny capability setpcap,

  # Allow network but restrict raw sockets
  network inet stream,
  network inet dgram,
  network inet6 stream,
  network inet6 dgram,
  deny network raw,
  deny network packet,

  # Deny /proc writes
  deny @{PROC}/sys/kernel/** wklx,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/mem rwklx,
  deny @{PROC}/kmem rwklx,
  deny @{PROC}/kcore rwklx,

  # Deny /dev access beyond basics
  deny /dev/sd* rwklx,
  deny /dev/nvme* rwklx,
  /dev/null rw,
  /dev/zero r,
  /dev/urandom r,
  /dev/random r,
}
```

## seccomp: System Call Filtering

seccomp (Secure Computing Mode) operates at a lower level than SELinux or AppArmor — it filters system calls before they reach the kernel proper. Combined with LSMs, seccomp provides complementary protection.

### seccomp-bpf Filters

Modern seccomp uses BPF (Berkeley Packet Filter) programs to make per-syscall decisions. The filter has access to the syscall number and arguments.

```c
// Example seccomp filter using libseccomp
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>

int apply_seccomp_filter(void) {
    scmp_filter_ctx ctx;
    int rc;

    // Default deny action: kill the process
    ctx = seccomp_init(SCMP_ACT_KILL_PROCESS);
    if (!ctx) {
        return -1;
    }

    // Allow essential syscalls
    rc  = seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(read), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(write), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(open), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(openat), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(close), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(stat), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(fstat), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(mmap), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(mprotect), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(munmap), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(brk), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(rt_sigaction), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(rt_sigprocmask), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(exit), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(exit_group), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(nanosleep), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(getpid), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(socket), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(connect), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(accept), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(accept4), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(sendto), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(recvfrom), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(bind), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(listen), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(getsockopt), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(setsockopt), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(epoll_create1), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(epoll_ctl), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(epoll_wait), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(futex), 0);
    rc |= seccomp_rule_add(ctx, SCMP_ACT_ALLOW, SCMP_SYS(clone), 0);

    // Log violations before killing (use SCMP_ACT_LOG for audit)
    // For production, use SCMP_ACT_KILL_PROCESS

    if (rc != 0) {
        seccomp_release(ctx);
        return rc;
    }

    // Load the filter into the kernel
    rc = seccomp_load(ctx);
    seccomp_release(ctx);
    return rc;
}
```

### Container seccomp Profiles

Docker and Kubernetes use JSON-format seccomp profiles:

```json
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "defaultErrnoRet": 1,
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": [
        "SCMP_ARCH_X86",
        "SCMP_ARCH_X32"
      ]
    },
    {
      "architecture": "SCMP_ARCH_AARCH64",
      "subArchitectures": [
        "SCMP_ARCH_ARM"
      ]
    }
  ],
  "syscalls": [
    {
      "names": [
        "accept",
        "accept4",
        "access",
        "adjtimex",
        "alarm",
        "bind",
        "brk",
        "capget",
        "capset",
        "chdir",
        "chmod",
        "chown",
        "chroot",
        "clock_getres",
        "clock_gettime",
        "clock_nanosleep",
        "close",
        "connect",
        "copy_file_range",
        "creat",
        "dup",
        "dup2",
        "dup3",
        "epoll_create",
        "epoll_create1",
        "epoll_ctl",
        "epoll_ctl_old",
        "epoll_pwait",
        "epoll_wait",
        "epoll_wait_old",
        "eventfd",
        "eventfd2",
        "execve",
        "execveat",
        "exit",
        "exit_group",
        "faccessat",
        "fadvise64",
        "fallocate",
        "fanotify_mark",
        "fchdir",
        "fchmod",
        "fchmodat",
        "fchown",
        "fchownat",
        "fcntl",
        "fdatasync",
        "fgetxattr",
        "flistxattr",
        "flock",
        "fork",
        "fremovexattr",
        "fsetxattr",
        "fstat",
        "fstatfs",
        "fsync",
        "ftruncate",
        "futex",
        "futimesat",
        "getcpu",
        "getcwd",
        "getdents",
        "getdents64",
        "getegid",
        "geteuid",
        "getgid",
        "getgroups",
        "getitimer",
        "getpeername",
        "getpgid",
        "getpgrp",
        "getpid",
        "getppid",
        "getpriority",
        "getrandom",
        "getresgid",
        "getresuid",
        "getrlimit",
        "get_robust_list",
        "getrusage",
        "getsid",
        "getsockname",
        "getsockopt",
        "get_thread_area",
        "gettid",
        "gettimeofday",
        "getuid",
        "getxattr",
        "inotify_add_watch",
        "inotify_init",
        "inotify_init1",
        "inotify_rm_watch",
        "io_cancel",
        "ioctl",
        "io_destroy",
        "io_getevents",
        "ioprio_get",
        "ioprio_set",
        "io_setup",
        "io_submit",
        "ipc",
        "kill",
        "lchown",
        "lgetxattr",
        "link",
        "linkat",
        "listen",
        "listxattr",
        "llistxattr",
        "lremovexattr",
        "lseek",
        "lsetxattr",
        "lstat",
        "madvise",
        "memfd_create",
        "mincore",
        "mkdir",
        "mkdirat",
        "mknod",
        "mknodat",
        "mlock",
        "mlock2",
        "mlockall",
        "mmap",
        "mprotect",
        "mq_getsetattr",
        "mq_notify",
        "mq_open",
        "mq_timedreceive",
        "mq_timedsend",
        "mq_unlink",
        "mremap",
        "msgctl",
        "msgget",
        "msgrcv",
        "msgsnd",
        "munlock",
        "munlockall",
        "munmap",
        "nanosleep",
        "newfstatat",
        "open",
        "openat",
        "pause",
        "pipe",
        "pipe2",
        "poll",
        "ppoll",
        "prctl",
        "pread64",
        "preadv",
        "preadv2",
        "prlimit64",
        "pselect6",
        "ptrace",
        "pwrite64",
        "pwritev",
        "pwritev2",
        "read",
        "readahead",
        "readlink",
        "readlinkat",
        "readv",
        "recv",
        "recvfrom",
        "recvmmsg",
        "recvmsg",
        "remap_file_pages",
        "removexattr",
        "rename",
        "renameat",
        "renameat2",
        "restart_syscall",
        "rmdir",
        "rt_sigaction",
        "rt_sigpending",
        "rt_sigprocmask",
        "rt_sigqueueinfo",
        "rt_sigreturn",
        "rt_sigsuspend",
        "rt_sigtimedwait",
        "rt_tgsigqueueinfo",
        "sched_getaffinity",
        "sched_getattr",
        "sched_getparam",
        "sched_get_priority_max",
        "sched_get_priority_min",
        "sched_getscheduler",
        "sched_setaffinity",
        "sched_yield",
        "seccomp",
        "select",
        "semctl",
        "semget",
        "semop",
        "semtimedop",
        "send",
        "sendfile",
        "sendmmsg",
        "sendmsg",
        "sendto",
        "set_robust_list",
        "setitimer",
        "setpgid",
        "setpriority",
        "setresgid",
        "setresuid",
        "set_thread_area",
        "setuid",
        "setxattr",
        "shmat",
        "shmctl",
        "shmdt",
        "shmget",
        "sigaltstack",
        "signalfd",
        "signalfd4",
        "sigreturn",
        "socket",
        "socketcall",
        "socketpair",
        "splice",
        "stat",
        "statfs",
        "statx",
        "symlink",
        "symlinkat",
        "sync",
        "sync_file_range",
        "syncfs",
        "sysinfo",
        "tee",
        "tgkill",
        "time",
        "timer_create",
        "timer_delete",
        "timerfd_create",
        "timerfd_gettime",
        "timerfd_settime",
        "timer_getoverrun",
        "timer_gettime",
        "timer_settime",
        "times",
        "tkill",
        "truncate",
        "uname",
        "unlink",
        "unlinkat",
        "utime",
        "utimensat",
        "utimes",
        "vfork",
        "vmsplice",
        "wait4",
        "waitid",
        "waitpid",
        "write",
        "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": [
        "ptrace"
      ],
      "action": "SCMP_ACT_ALLOW",
      "includes": {
        "minKernel": "4.8"
      }
    }
  ]
}
```

### Kubernetes seccomp Integration

```yaml
# Kubernetes pod with custom seccomp profile
# Profile must exist on every node at:
# /var/lib/kubelet/seccomp/profiles/myapp.json
apiVersion: v1
kind: Pod
metadata:
  name: myapp-hardened
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/myapp.json
  containers:
  - name: myapp
    image: myapp:latest
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
      runAsNonRoot: true
      runAsUser: 1000
      capabilities:
        drop:
        - ALL
        add:
        - NET_BIND_SERVICE
```

### Using seccomp with LSMs Together

The combination of seccomp (limiting syscall surface) and LSM (limiting what those syscalls can access) provides layered defense:

```bash
# strace to discover what syscalls an application actually uses
strace -f -c /usr/sbin/myapp 2>&1 | head -50

# Use oci-seccomp-bpf-hook to auto-generate profiles for containers
# (part of containers/oci-seccomp-bpf-hook)
podman run --annotation io.containers.trace-syscall=of:/tmp/myapp.json \
    myapp:latest

# The generated profile can then be used with:
podman run --security-opt seccomp=/tmp/myapp.json myapp:latest

# systemd service hardening with seccomp
# In /etc/systemd/system/myapp.service:
# [Service]
# SystemCallFilter=read write open openat close stat fstat mmap mprotect munmap \
#                  brk rt_sigaction rt_sigprocmask socket connect accept bind \
#                  listen epoll_create1 epoll_ctl epoll_wait futex clone exit_group
# SystemCallErrorNumber=EPERM
```

## Putting It All Together: Defense in Depth

The combination of SELinux/AppArmor with seccomp creates multiple independent security layers:

```bash
# Audit configuration summary script
#!/bin/bash
echo "=== LSM Status ==="
cat /sys/kernel/security/lsm
echo ""

echo "=== SELinux Status ==="
if command -v getenforce &>/dev/null; then
    getenforce
    sestatus
fi
echo ""

echo "=== AppArmor Status ==="
if command -v aa-status &>/dev/null; then
    aa-status --summary
fi
echo ""

echo "=== Seccomp Support ==="
grep -r "Seccomp" /proc/$$/status
echo ""

echo "=== Kernel Lockdown ==="
if [ -f /sys/kernel/security/lockdown ]; then
    cat /sys/kernel/security/lockdown
fi

echo "=== Recent SELinux Denials (last hour) ==="
ausearch -m AVC -ts recent 2>/dev/null | tail -20

echo "=== AppArmor DENIED events (last 100 lines) ==="
grep -i "apparmor.*DENIED" /var/log/syslog 2>/dev/null | tail -10
```

## Troubleshooting Common Issues

### SELinux Blocking Legitimate Operations

```bash
# The most common troubleshooting workflow
# 1. Check if SELinux is the cause
ausearch -m AVC -ts recent | audit2why

# 2. Common issue: wrong file context after manual file placement
restorecon -RFv /path/to/your/files

# 3. Port context issues
semanage port -l | grep http
# Add a new port to an existing type
semanage port -a -t http_port_t -p tcp 8443

# 4. Process executing under wrong domain
ps -eZ | grep myapp
# If it shows unconfined_t, the exec context may be wrong
ls -Z /usr/sbin/myapp
# Fix: restorecon -v /usr/sbin/myapp

# 5. Debugging domain transitions
sesearch --type_trans -s init_t -t myapp_exec_t
```

### AppArmor Profile Debugging

```bash
# Enable verbose logging
echo 1 > /sys/module/apparmor/parameters/debug

# Parse and check a profile for syntax errors
apparmor_parser -p /etc/apparmor.d/usr.sbin.myapp

# Check if a profile is loaded
apparmor_parser -L /var/lib/apparmor/cache/.features

# Force reload all profiles
service apparmor restart

# Check if a specific process is confined
cat /proc/$(pgrep myapp)/attr/current
```

## Key Takeaways

The Linux Security Modules framework provides a kernel-level foundation for mandatory access control that cannot be bypassed by userspace applications, even those running as root. The key principles for enterprise deployment are:

1. Run in permissive mode first, collect all denials, then generate policy — never write policy from scratch without observing real behavior
2. Use `audit2allow -R` to leverage existing policy interfaces rather than writing raw allow rules
3. AppArmor profiles for containers should explicitly deny dangerous capabilities and /proc/sys paths even if your application does not need them
4. seccomp and LSMs are complementary — seccomp reduces the kernel attack surface, LSMs control what allowed operations can access
5. File contexts must be set correctly before enabling enforcement — use `restorecon` after any manual file operations
6. Monitor AVC denials continuously in production using `ausearch` integrated with your SIEM to detect both policy violations and potential intrusion attempts
7. The lockdown LSM should be enabled on production systems to prevent even privileged processes from compromising kernel integrity through mechanisms like `/dev/mem` or unsigned kernel modules
