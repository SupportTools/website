---
title: "Linux Security Modules: AppArmor Profiles for Containers"
date: 2029-08-14T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "AppArmor", "Containers", "Kubernetes", "LSM"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide to AppArmor profiles for Linux containers: profile syntax, the default Docker profile, creating custom profiles with aa-genprof, learning mode, and applying profiles via Kubernetes AppArmor annotations."
more_link: "yes"
url: "/linux-security-modules-apparmor-profiles-containers/"
---

Namespaces and cgroups isolate containers from each other, but they do not restrict what a container can do in kernel space. A container running as root with no AppArmor profile can attempt raw socket creation, `ptrace` other processes, load kernel modules, and write to `/proc` entries. AppArmor confines processes by defining a mandatory access control policy — a profile that lists exactly what system calls, files, capabilities, and network operations are permitted. This post covers AppArmor from first principles through production container hardening.

<!--more-->

# Linux Security Modules: AppArmor Profiles for Containers

## Section 1: AppArmor Fundamentals

AppArmor is a Linux Security Module (LSM) that implements Mandatory Access Control (MAC). Unlike DAC (Discretionary Access Control, i.e., file permissions), MAC policies are enforced regardless of what the process owner wants.

### How AppArmor Works

```
Process launches
    └── kernel checks AppArmor profile for this executable
        ├── ALLOW — operation permitted
        ├── DENY — operation blocked (logged if audit)
        └── COMPLAIN — operation permitted but logged (learning mode)
```

A profile is attached to an **executable path**, not a user. The profile `/usr/sbin/nginx` applies to any process running that binary, regardless of who launched it.

### Checking AppArmor Status

```bash
# Check if AppArmor is enabled
aa-status
# apparmor module is loaded.
# 47 profiles are loaded.
# 45 profiles are in enforce mode.
# 2 profiles are in complain mode.

# Check for a specific profile
aa-status | grep docker
# docker-default

# Check a running process's profile
cat /proc/$(pidof nginx)/attr/current
# /usr/sbin/nginx (enforce)

# View AppArmor events
journalctl -k | grep apparmor | tail -20
# DENIED  operation=file read /etc/shadow

# dmesg view
dmesg | grep apparmor | tail -20
```

### AppArmor Kernel Configuration

```bash
grep -i apparmor /boot/config-$(uname -r)
# CONFIG_SECURITY_APPARMOR=y
# CONFIG_SECURITY_APPARMOR_BOOTPARAM_VALUE=1
# CONFIG_DEFAULT_SECURITY_APPARMOR=y

# Boot parameter (should already be set)
cat /proc/cmdline | grep apparmor
# ... security=apparmor apparmor=1 ...
```

## Section 2: Profile Syntax

AppArmor profiles live in `/etc/apparmor.d/`. The syntax is C-like with path rules, capability rules, and network rules.

### Basic Profile Structure

```
# /etc/apparmor.d/usr.sbin.nginx
# AppArmor profile for nginx

# Profile name matches the executable path
/usr/sbin/nginx {

  # Include common abstractions
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Capabilities (Linux privilege bits)
  capability net_bind_service,   # bind to ports < 1024
  capability setgid,
  capability setuid,
  capability dac_override,       # access files regardless of permissions

  # File access rules: path_expression  access_modes
  # Access modes: r=read, w=write, a=append, x=execute, l=link, k=lock, m=mmap
  /etc/nginx/**            r,
  /var/log/nginx/**        w,
  /var/run/nginx.pid       w,
  /usr/share/nginx/**      r,
  /run/nginx.pid           w,

  # Deny write to sensitive locations
  deny /etc/shadow         r,
  deny /etc/gshadow        r,
  deny /proc/sys/**        w,

  # Network rules
  network inet tcp,
  network inet6 tcp,

  # Allow execution of specific programs only
  /usr/bin/openssl         ix,  # ix = inherit + exec
  /bin/dash                Cx -> nginx_subprofile,  # child profile transition

  # Owner-based rules
  owner /tmp/nginx-*       rw,

  # Unix socket
  /run/nginx.sock          rw,

}
```

### Access Mode Reference

| Mode | Meaning |
|---|---|
| `r` | Read |
| `w` | Write |
| `a` | Append |
| `x` | Execute |
| `ix` | Execute and inherit current profile |
| `Px` | Execute and transition to named profile |
| `Cx` | Execute as child profile |
| `Ux` | Execute unconstrained (dangerous) |
| `m` | Memory-map executable |
| `l` | Hard link |
| `k` | Lock |

### Capability Reference

```
# Most commonly needed by containers:
capability chown,          # change file ownership
capability dac_override,   # override read/write/execute permission checks
capability fowner,         # bypass permission checks for owned files
capability fsetid,         # set setuid/setgid bits
capability kill,           # send signals to arbitrary processes
capability net_bind_service, # bind to privileged ports
capability net_raw,        # raw sockets (ping, packet capture) — often deny this
capability setgid,         # set group IDs
capability setuid,         # set user IDs
capability sys_chroot,     # chroot
capability sys_ptrace,     # ptrace — DENY for containers
capability sys_admin,      # broad admin — DENY for containers
capability sys_module,     # load kernel modules — DENY for containers
```

## Section 3: The Default Docker AppArmor Profile

Docker automatically loads a profile called `docker-default` for all containers unless overridden. Understanding what it allows and denies is essential.

```bash
# View the default Docker profile
cat /etc/apparmor.d/docker-default
# Or if it is generated at runtime:
docker inspect --format '{{.HostConfig.SecurityOpt}}' <container>
```

The `docker-default` profile:

```
#include <tunables/global>

profile docker-default flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  network,              # Allow all networking
  capability,           # Allow most capabilities
  file,                 # Allow all file access (broad)
  umount,

  # Deny dangerous capabilities
  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9],[^1-9][^0-9],
         [^1-9][^0-9][^0-9],[^1-9][^0-9][^0-9][^0-9]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/mem rwklx,
  deny @{PROC}/kmem rwklx,
  deny @{PROC}/kcore rwklx,

  deny mount,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/kernel/security/** rwklx,
}
```

The default profile blocks the most critical attack vectors but is still broad. Custom profiles should be significantly tighter for production workloads.

## Section 4: Creating Custom Profiles with aa-genprof

`aa-genprof` runs an application in complain mode, monitors what it does, and generates a profile from the observed behavior.

### Step 1: Install Tools

```bash
sudo apt-get install -y apparmor-utils apparmor-profiles apparmor-profiles-extra
```

### Step 2: Generate a Profile with aa-genprof

```bash
# Start profile generation for nginx
sudo aa-genprof /usr/sbin/nginx

# In another terminal, exercise all code paths:
# - Start nginx
# - Serve HTTP and HTTPS requests
# - Reload configuration
# - Log rotation
# - Health check endpoints

# Back in aa-genprof, press F (finish) when done
# aa-genprof generates: /etc/apparmor.d/usr.sbin.nginx
```

### Step 3: Review and Tighten the Generated Profile

The generated profile allows everything observed. Tighten it by adding `deny` rules:

```bash
# Generated profile will be broad — example tightening:

cat /etc/apparmor.d/usr.sbin.nginx
```

```
# GENERATED — review and tighten before enforcing
/usr/sbin/nginx {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # TIGHTEN: only the capabilities actually needed
  capability chown,
  capability dac_override,
  capability net_bind_service,
  capability setgid,
  capability setuid,

  # Explicitly deny dangerous capabilities
  deny capability sys_ptrace,
  deny capability sys_admin,
  deny capability sys_module,
  deny capability net_raw,
  deny capability mknod,

  # Read-only for config and static files
  /etc/nginx/**              r,
  /usr/share/nginx/**        r,

  # Write only to log directory and pid file
  /var/log/nginx/            r,
  /var/log/nginx/**          w,
  /run/nginx.pid             rw,
  /var/run/nginx.pid         rw,

  # Cache directory (if used)
  /var/cache/nginx/          r,
  /var/cache/nginx/**        rw,

  # Temp files
  owner /tmp/nginx-*         rw,

  # Deny write to anything under /etc except nginx config
  deny /etc/[^n]**           w,
  deny /etc/n[^g]**          w,

  # Deny access to sensitive files
  deny /etc/shadow           r,
  deny /etc/gshadow          r,
  deny /root/**              rw,
  deny /home/**              rw,

  # Network
  network inet tcp,
  network inet6 tcp,
  network unix stream,

  # Deny raw sockets
  deny network raw,
  deny network packet,
}
```

### Step 4: Load and Enforce

```bash
# Load the profile in complain mode first
sudo apparmor_parser -C /etc/apparmor.d/usr.sbin.nginx
aa-status | grep nginx
# /usr/sbin/nginx (complain)

# Test the application — monitor for denials
sudo journalctl -k -f | grep apparmor &
sudo nginx -t
sudo systemctl restart nginx

# After testing, switch to enforce mode
sudo aa-enforce /usr/sbin/nginx
aa-status | grep nginx
# /usr/sbin/nginx (enforce)
```

### Step 5: Update Profiles with aa-logprof

When AppArmor denies something legitimate, use `aa-logprof` to generate allow rules from the audit log:

```bash
# aa-logprof reads the audit log and suggests rules for denied operations
sudo aa-logprof

# It will prompt for each denied operation:
# Profile: /usr/sbin/nginx
# Operation: file_read
# Path: /proc/1/net/if_inet6
# Severity: 4
# (A)llow, (D)eny, (G)lob, (N)ew, (S)elf, a(B)ort, (I)gnore, (Q)uit?

# After choosing actions, save the updated profile
sudo apparmor_parser -r /etc/apparmor.d/usr.sbin.nginx
```

## Section 5: Container-Specific AppArmor Profiles

### Custom Profile for a Go Web Service Container

```bash
# /etc/apparmor.d/container-go-webservice
# Profile for a minimal Go web service container

profile container-go-webservice flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  # Minimal capabilities — Go services typically need none
  deny capability all,          # Deny all capabilities
  capability net_bind_service,  # Only if binding to port < 1024

  # Read-only access to the application binary and shared libraries
  /app/server              rix,  # run + inherit profile
  /lib/**                  r,
  /lib64/**                r,
  /usr/lib/**              r,
  /usr/lib64/**            r,

  # /tmp for ephemeral files
  owner /tmp/**            rw,

  # /proc restrictions — allow only what Go runtime needs
  @{PROC}/@{pid}/fd/       r,
  @{PROC}/@{pid}/status    r,
  @{PROC}/@{pid}/maps      r,
  @{PROC}/sys/kernel/ngroups_max r,

  # Deny dangerous /proc paths
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/mem           rwklx,
  deny @{PROC}/kmem          rwklx,
  deny @{PROC}/kcore         rwklx,
  deny @{PROC}/sys/**        w,

  # DNS resolution
  /etc/resolv.conf         r,
  /etc/nsswitch.conf       r,
  /etc/hosts               r,
  /etc/hostname            r,
  /run/systemd/resolve/**  r,

  # No write outside /tmp
  deny /etc/**             w,
  deny /usr/**             w,
  deny /lib/**             w,
  deny /bin/**             w,
  deny /sbin/**            w,

  # Network — restrict to TCP only
  network inet  tcp,
  network inet6 tcp,
  network inet  udp,    # needed for DNS
  network inet6 udp,
  deny network raw,
  deny network packet,

  # No mount operations
  deny mount,
  deny umount,

  # No ptrace
  deny ptrace,

  # No Unix domain sockets except to specific paths
  /run/systemd/journal/socket w,  # for syslog
}
```

### Loading the Profile

```bash
# Load the custom container profile
sudo apparmor_parser -r /etc/apparmor.d/container-go-webservice

# Verify loading
aa-status | grep go-webservice
```

## Section 6: Docker AppArmor Integration

### Using Custom Profiles with Docker

```bash
# Run container with custom profile
docker run -d \
    --security-opt apparmor=container-go-webservice \
    --name myapp \
    registry.internal/myapp:v1.0

# Disable AppArmor for a container (not recommended for production)
docker run -d \
    --security-opt apparmor=unconfined \
    --name debug-container \
    ubuntu:22.04

# Check which profile a running container uses
docker inspect myapp | jq '.[].HostConfig.SecurityOpt'
# ["apparmor=container-go-webservice"]
```

### Docker Compose AppArmor

```yaml
# docker-compose.yml
services:
  api:
    image: registry.internal/myapp:v1.0
    security_opt:
      - apparmor=container-go-webservice
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
```

## Section 7: Kubernetes AppArmor Annotations

Kubernetes supports AppArmor profiles via annotations (pre-1.30) and via SecurityContext (1.30+).

### Legacy Annotation Method (Kubernetes < 1.30)

```yaml
# pod-with-apparmor.yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: production
  annotations:
    # Format: container.apparmor.security.beta.kubernetes.io/<container-name>: <profile>
    container.apparmor.security.beta.kubernetes.io/myapp: localhost/container-go-webservice
    # Options:
    # runtime/default       — use the container runtime's default profile
    # localhost/<name>      — use a profile loaded on the node
    # unconfined            — disable AppArmor (not recommended)
spec:
  containers:
    - name: myapp
      image: registry.internal/myapp:v1.0
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
```

### Native SecurityContext Method (Kubernetes 1.30+)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: myapp
  namespace: production
spec:
  containers:
    - name: myapp
      image: registry.internal/myapp:v1.0
      securityContext:
        appArmorProfile:
          type: Localhost
          localhostProfile: container-go-webservice
        runAsNonRoot: true
        runAsUser: 1000
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
```

### Distributing Profiles to Kubernetes Nodes

```yaml
# DaemonSet to copy AppArmor profiles to all nodes
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: apparmor-loader
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: apparmor-loader
  template:
    metadata:
      labels:
        app: apparmor-loader
    spec:
      initContainers:
        - name: load-profiles
          image: registry.internal/apparmor-loader:v1.0
          securityContext:
            privileged: true
          volumeMounts:
            - name: apparmor-profiles
              mountPath: /profiles
            - name: apparmor-d
              mountPath: /etc/apparmor.d
          command:
            - /bin/sh
            - -c
            - |
              cp /profiles/*.profile /etc/apparmor.d/
              apparmor_parser -r /etc/apparmor.d/*.profile
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.9
      volumes:
        - name: apparmor-profiles
          configMap:
            name: apparmor-profiles
        - name: apparmor-d
          hostPath:
            path: /etc/apparmor.d
            type: DirectoryOrCreate
```

```yaml
# ConfigMap with profile content
apiVersion: v1
kind: ConfigMap
metadata:
  name: apparmor-profiles
  namespace: kube-system
data:
  container-go-webservice.profile: |
    profile container-go-webservice flags=(attach_disconnected,mediate_deleted) {
      #include <abstractions/base>
      deny capability sys_admin,
      deny capability sys_ptrace,
      deny capability sys_module,
      deny capability net_raw,
      capability net_bind_service,
      /app/server rix,
      /lib/** r,
      /usr/lib/** r,
      /etc/resolv.conf r,
      /etc/hosts r,
      deny /etc/** w,
      network inet tcp,
      network inet udp,
      deny network raw,
      deny mount,
      deny ptrace,
    }
```

## Section 8: Validating AppArmor Enforcement

### Testing That Denials Work

```bash
# Start a container with the profile applied
docker run -d \
    --security-opt apparmor=container-go-webservice \
    --name test-apparmor \
    ubuntu:22.04 sleep 3600

# Try operations that should be denied
docker exec test-apparmor cat /etc/shadow
# cat: /etc/shadow: Permission denied  ← GOOD

docker exec test-apparmor ping 8.8.8.8
# ping: socket: Operation not permitted  ← GOOD (raw socket denied)

# Verify AppArmor is actually enforcing (not just seccomp or capabilities)
docker exec test-apparmor bash -c "cat /proc/self/attr/current"
# container-go-webservice (enforce)

# Monitor denials in real-time
sudo journalctl -k -f | grep -E 'apparmor.*DENIED'
```

### Automated Profile Testing

```bash
#!/bin/bash
# test-apparmor-profile.sh
# Runs a container with a profile and verifies expected denials

PROFILE="container-go-webservice"
IMAGE="ubuntu:22.04"

echo "Testing AppArmor profile: $PROFILE"
CID=$(docker run -d \
    --security-opt "apparmor=${PROFILE}" \
    "$IMAGE" sleep 30)

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; docker rm -f "$CID"; exit 1; }

# Test 1: /etc/shadow should be denied
docker exec "$CID" cat /etc/shadow 2>/dev/null && fail "read /etc/shadow should be denied" || pass "read /etc/shadow denied"

# Test 2: Raw socket should be denied (ping uses ICMP raw socket)
docker exec "$CID" ping -c1 127.0.0.1 2>/dev/null && fail "raw socket should be denied" || pass "raw socket denied"

# Test 3: Write to /etc should be denied
docker exec "$CID" touch /etc/evil 2>/dev/null && fail "write to /etc should be denied" || pass "write to /etc denied"

# Test 4: Normal operations should work
docker exec "$CID" cat /etc/hosts || fail "read /etc/hosts should be allowed"
pass "read /etc/hosts allowed"

docker rm -f "$CID" > /dev/null
echo "All tests passed."
```

## Section 9: AppArmor and seccomp Together

AppArmor and seccomp are complementary, not redundant:

- **seccomp** filters syscalls by number — prevents calling dangerous syscalls at all
- **AppArmor** filters access to resources — allows the syscall but blocks the target

Use both for defense in depth:

```json
// custom-seccomp.json — used alongside AppArmor
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "accept", "accept4", "bind", "close", "connect",
        "epoll_create", "epoll_create1", "epoll_ctl", "epoll_wait",
        "exit", "exit_group", "fcntl", "futex",
        "getpid", "gettimeofday", "listen",
        "mmap", "mprotect", "munmap",
        "nanosleep", "openat", "read", "recvfrom", "recvmsg",
        "rt_sigaction", "rt_sigprocmask",
        "select", "sendmsg", "sendto", "setitimer",
        "socket", "stat", "sysinfo",
        "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```bash
# Apply both seccomp and AppArmor
docker run -d \
    --security-opt "apparmor=container-go-webservice" \
    --security-opt "seccomp=custom-seccomp.json" \
    registry.internal/myapp:v1.0
```

## Section 10: Production Checklist

- [ ] AppArmor loaded and active: `aa-status` shows profiles in enforce mode
- [ ] `docker-default` profile confirmed active for all containers without custom profiles
- [ ] Custom profiles created for all production workloads
- [ ] Profiles created using aa-genprof + real workload traffic (not just assumptions)
- [ ] Dangerous capabilities explicitly denied: `sys_admin`, `sys_ptrace`, `sys_module`, `net_raw`
- [ ] `/proc` write access denied except for specific required paths
- [ ] `/etc/shadow` and `/etc/gshadow` reads denied
- [ ] Profiles tested in complain mode before enforcing
- [ ] Automated profile test script in CI pipeline
- [ ] AppArmor profiles distributed to Kubernetes nodes via DaemonSet or node init
- [ ] Kubernetes pods annotated with AppArmor profile (or use SecurityContext in 1.30+)
- [ ] Prometheus alerting on AppArmor DENIED events (from audit log or node_exporter)
- [ ] AppArmor profile versioned in Git alongside application code

## Conclusion

AppArmor is one of the most underused security tools in container environments. Most teams rely on the broad `docker-default` profile and assume namespaces are sufficient. They are not: a container escape via kernel exploit bypasses namespace isolation, and AppArmor can prevent the exploit's payload from doing damage even after it runs.

The investment to create a custom AppArmor profile is low — `aa-genprof` does most of the work in an afternoon. The payoff is a container that literally cannot exfiltrate credentials, tamper with `/proc`, create raw sockets, or perform most post-exploitation actions, regardless of what vulnerability is exploited inside it.

Start with `docker-default`, harden to a custom profile for your most sensitive workloads, distribute profiles via Kubernetes DaemonSet, and monitor for DENIED events in Prometheus. That is defense in depth that requires no application changes.
