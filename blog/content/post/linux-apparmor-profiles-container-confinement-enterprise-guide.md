---
title: "Linux AppArmor Profiles: Profile Modes, Path-Based Access Control, Network Rules, Container Confinement, and AA Tools"
date: 2032-01-02T00:00:00-05:00
draft: false
tags: ["Linux", "AppArmor", "Security", "Containers", "Kubernetes", "Access Control", "Hardening"]
categories:
- Linux
- Security
- Containers
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux AppArmor mandatory access control: profile syntax, enforce and complain mode, path-based file access rules, capability restrictions, network rules, container confinement in Docker and Kubernetes, and the aa-genprof and aa-logprof tools."
more_link: "yes"
url: "/linux-apparmor-profiles-container-confinement-enterprise-guide/"
---

AppArmor (Application Armor) is a Linux Mandatory Access Control (MAC) system that confines programs to a limited set of resources. Unlike SELinux's label-based model, AppArmor uses path-based access control, making profiles more intuitive to write and maintain. For container security, AppArmor profiles provide the host-level enforcement layer that complements Kubernetes RBAC, Pod Security Standards, and seccomp filters. This guide covers AppArmor profile syntax from first principles, the complain-to-enforce workflow for safe profile development, container-specific profiles for Docker and Kubernetes, and the AA toolchain for automated profile generation and audit.

<!--more-->

# Linux AppArmor Profiles: Container Confinement Guide

## Section 1: AppArmor Architecture

AppArmor operates as an LSM (Linux Security Module) that intercepts kernel system calls and enforces access decisions based on:

1. **The process's active profile** — loaded into the kernel
2. **The action being taken** — file read, write, exec, network connect
3. **The target resource** — a path, capability, network address

### Profile Modes

| Mode | Behavior |
|------|----------|
| **enforce** | Violations are blocked and logged |
| **complain** | Violations are logged but allowed (audit mode) |
| **kill** | Process is killed on violation |
| **unconfined** | No AppArmor restrictions |

### AppArmor vs. SELinux

| Feature | AppArmor | SELinux |
|---------|----------|---------|
| Access model | Path-based | Label-based |
| Profile format | Human-readable text | Policy modules (complex) |
| Portability | Follows file paths | Follows file labels (survive moves) |
| Learning tools | aa-genprof, aa-logprof | audit2allow, sepolicy |
| Container support | Native (Docker, K8s) | Requires label propagation |
| Debian/Ubuntu | Default | Optional |
| RHEL/Fedora | Available | Default |

## Section 2: Installing and Managing AppArmor

### Installation

```bash
# Ubuntu/Debian (AppArmor is enabled by default since Ubuntu 10.04)
apt-get install apparmor apparmor-utils apparmor-profiles

# Enable AppArmor at boot (should be enabled by default)
systemctl enable apparmor
systemctl start apparmor

# Verify AppArmor is active
aa-status
# OR
apparmor_status
```

### Checking Profile Status

```bash
# View all loaded profiles and their mode
aa-status

# Output example:
# apparmor module is loaded.
# 76 profiles are loaded.
# 72 profiles are in enforce mode.
# 4 profiles are in complain mode.
# 0 profiles are in kill mode.

# List profiles and their current mode
aa-status --pretty-json 2>/dev/null | python3 -m json.tool | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
for mode, profiles in data.get('profiles', {}).items():
    for profile in profiles:
        print(f'{mode:12} {profile}')
" | sort -k2

# Check which processes are confined
aa-status | grep "processes are in enforce mode" -A 100 | head -30

# Check if a specific process has an AppArmor profile
cat /proc/$(pgrep nginx)/attr/current 2>/dev/null || echo "unconfined"
```

### AppArmor File Locations

```bash
# Profile definitions
ls /etc/apparmor.d/

# Abstractions (reusable include files)
ls /etc/apparmor.d/abstractions/

# Local overrides
ls /etc/apparmor.d/local/

# Compiled cache
ls /var/cache/apparmor/
```

## Section 3: Profile Syntax

### Basic Profile Structure

```
# /etc/apparmor.d/usr.bin.my-application

# Include statement — load pre-built abstractions
#include <tunables/global>

# Profile block
profile my-application /usr/bin/my-application {
    # Include common abstractions
    #include <abstractions/base>
    #include <abstractions/nameservice>

    # ===== Capability Rules =====
    capability net_bind_service,
    capability setuid,
    capability setgid,

    # ===== File Rules =====
    # Format: <path> <permissions>
    # Permissions: r=read, w=write, a=append, x=exec,
    #              l=link, k=lock, m=mmap

    # Binary itself (read + execute)
    /usr/bin/my-application    mr,

    # Config files (read-only)
    /etc/my-application/       r,
    /etc/my-application/**     r,

    # Log files (append-only)
    /var/log/my-application/   rw,
    /var/log/my-application/** rwa,

    # Runtime files
    /var/run/my-application/   rw,
    /var/run/my-application/** rw,

    # Temporary files
    /tmp/my-application-*      rw,
    owner /tmp/my-application/ rw,

    # ===== Network Rules =====
    # Format: network [<domain>] [<type>] [<protocol>]
    network inet tcp,
    network inet udp,
    network inet6 tcp,

    # ===== Mount Rules =====
    # Deny mounting filesystems
    deny mount,
    deny umount,

    # ===== Signal Rules =====
    signal send set=(term, kill) peer=@{profile_name},
    signal receive set=(term, kill),

    # ===== Ptrace Rules =====
    deny ptrace,

    # ===== Unix Domain Sockets =====
    unix (bind, listen, accept) type=stream addr="@my-application",
}
```

### Permission Characters Reference

```
r    - read
w    - write
a    - append (write without truncate)
x    - execute (from parent context)
ux   - execute unconfined
Ux   - execute unconfined (with sanitized environment)
px   - execute with own profile (PNAME profile must exist)
Px   - execute with own profile (sanitized env)
cx   - execute child profile
Cx   - execute child profile (sanitized env)
ix   - execute, inherit parent profile
m    - mmap with PROT_EXEC
l    - hard link
k    - lock (flock/fcntl)
```

### File Globbing

```
/path/to/file        # Exact path
/path/to/dir/        # Directory (trailing slash required)
/path/to/dir/**      # All files recursively under dir
/path/to/dir/*       # All files directly under dir (non-recursive)
/path/to/dir/[abc]*  # Files starting with a, b, or c
/path/to/*.conf      # Files ending in .conf

# Variables
@{HOME}    = /root /home/*
@{PROC}    = /proc/
@{sys}     = /sys/
```

## Section 4: Writing an AppArmor Profile for an nginx Web Server

### Step 1: Start in Complain Mode

Create the initial profile in complain mode:

```bash
# Create a bare complain-mode profile
cat > /etc/apparmor.d/usr.sbin.nginx << 'PROFILE'
#include <tunables/global>

profile nginx /usr/sbin/nginx {
    #include <abstractions/base>

    # Enable complain mode for this profile
    flags=(complain)
}
PROFILE

# Load the profile
apparmor_parser -r /etc/apparmor.d/usr.sbin.nginx

# Verify
aa-status | grep nginx
```

### Step 2: Exercise the Application

```bash
# Start nginx and generate real-world traffic
systemctl restart nginx

# Send varied HTTP requests to exercise all code paths
curl http://localhost/
curl http://localhost/static/app.js
curl http://localhost/api/health
curl http://localhost/nonexistent 2>&1  # 404 path

# Run for 30 minutes in production or staging
sleep 1800
```

### Step 3: Read and Analyze Audit Logs

```bash
# View AppArmor violations in audit log
grep "apparmor=" /var/log/audit/audit.log | head -30

# More readable format
aa-logprof --file /var/log/syslog

# Parse complain-mode logs
grep "ALLOWED" /var/log/syslog | grep nginx | \
  awk '{
    for(i=1;i<=NF;i++) {
      if($i ~ /^name=/) print $i
      if($i ~ /^requested_mask=/) print $i
    }
    print ""
  }' | sort | uniq -c | sort -rn
```

### Step 4: Generate a Proper Profile

```bash
# Use aa-logprof to interactively add rules
aa-logprof

# OR use aa-genprof for guided profile creation
aa-genprof nginx

# aa-genprof workflow:
# 1. Starts nginx with profiling
# 2. Prompts you to exercise the application
# 3. Scans audit logs
# 4. Prompts for each access to Allow/Deny/Glob/etc.
# 5. Writes the final profile
```

### Step 5: Production nginx Profile

The result after profiling a production nginx instance:

```
# /etc/apparmor.d/usr.sbin.nginx
# AppArmor profile for nginx

#include <tunables/global>

profile nginx /usr/sbin/nginx {
    #include <abstractions/base>
    #include <abstractions/nameservice>
    #include <abstractions/openssl>
    #include <abstractions/ssl_certs>

    # Capabilities
    capability chown,
    capability dac_override,
    capability net_bind_service,
    capability setgid,
    capability setuid,

    # Network access
    network inet tcp,
    network inet6 tcp,
    network unix stream,

    # Binary and libraries
    /usr/sbin/nginx                   mr,
    /usr/lib/nginx/modules/*.so       mr,

    # Configuration
    /etc/nginx/                       r,
    /etc/nginx/**                     r,

    # Dynamic configuration updates (for nginx -s reload)
    /etc/nginx/conf.d/*.conf          r,
    /etc/nginx/sites-enabled/**       r,

    # Logs
    /var/log/nginx/                   rw,
    /var/log/nginx/access.log         rwa,
    /var/log/nginx/error.log          rwa,
    owner /var/log/nginx/access.log.* rw,

    # PID and lock files
    /run/nginx.pid                    rw,
    /run/lock/nginx.lock              rw,

    # Static content (read-only)
    /var/www/html/                    r,
    /var/www/html/**                  r,

    # Temporary files
    /var/cache/nginx/                 rw,
    /var/cache/nginx/**               rw,

    # Proxy temp files
    /tmp/nginx-*                      rw,

    # SSL/TLS certificates
    /etc/ssl/certs/                   r,
    /etc/ssl/certs/**                 r,
    /etc/ssl/private/                 r,
    /etc/ssl/private/*.key            r,

    # System files
    /proc/sys/kernel/ngroups_max      r,
    /proc/*/limits                    r,

    # Unix sockets for backend communication
    /run/php-fpm.sock                 rw,

    # Worker process communication
    /tmp/nginx_worker_*               rw,

    # Deny dangerous operations
    deny /etc/shadow                  rwklx,
    deny /etc/gshadow                 rwklx,
    deny /proc/sysrq-trigger          rw,
    deny /sys/                        rwklx,
    deny mount,
    deny ptrace,

    # Signal handling
    signal send peer=nginx,
    signal receive peer=nginx,

    # Allow worker spawning
    /usr/sbin/nginx                   px -> nginx,
}
```

### Enforcing the Profile

```bash
# Switch from complain to enforce
aa-enforce /etc/apparmor.d/usr.sbin.nginx

# Reload the profile
apparmor_parser -r /etc/apparmor.d/usr.sbin.nginx

# Restart nginx to apply
systemctl restart nginx

# Verify enforcement
aa-status | grep -A2 nginx
```

## Section 5: Network Rules

AppArmor network rules restrict which network protocols and domains a process can use:

```
# Full network access (permissive)
network,

# Restrict to IPv4 TCP/UDP
network inet tcp,
network inet udp,

# Restrict to IPv6
network inet6 tcp,
network inet6 udp,

# Deny all network access
deny network,

# Unix domain sockets only
network unix,
network unix stream,
network unix dgram,

# Netlink sockets (for routing/netfilter)
network netlink raw,

# Raw sockets (deny to prevent packet injection)
deny network raw,
deny network packet,
```

### Combining with iptables

AppArmor network rules are not a replacement for iptables/nftables — they operate at a different level (process-level socket creation vs. packet-level filtering). Use them together:

```
# Profile restricts WHICH process can open TCP sockets
network inet tcp,

# iptables restricts WHICH destinations are reachable
# (add your iptables rules via systemd unit or Kubernetes NetworkPolicy)
```

## Section 6: Docker Container Profiles

Docker loads AppArmor profiles for containers. The default Docker profile (`docker-default`) is strict but not application-specific.

### Docker's Default Profile Location

```bash
# The docker-default profile is loaded dynamically
aa-status | grep docker

# View the profile
cat /etc/apparmor.d/docker-default 2>/dev/null || \
  docker inspect --format='{{.HostConfig.SecurityOpt}}' some-container
```

### Custom Profile for a Go Application Container

```
# /etc/apparmor.d/docker-go-http-server

#include <tunables/global>

profile docker-go-http-server flags=(attach_disconnected,mediate_deleted) {
    #include <abstractions/base>

    # Container filesystem access
    # All container rootfs mounts are via overlay/overlay2
    file,

    # Deny sensitive host paths
    deny /proc/sysrq-trigger    rwklx,
    deny /proc/sys/fs/          rwklx,
    deny /sys/firmware/**       rwklx,

    # Block kernel module loading
    deny /proc/sys/kernel/      rwklx,

    # Allow /proc self access
    /proc/@{pid}/attr/current   rw,
    /proc/@{pid}/fd/            r,
    /proc/@{pid}/status         r,
    /proc/@{pid}/maps           r,
    /proc/sys/kernel/ngroups_max r,

    # Network access
    network inet tcp,
    network inet udp,
    network inet6 tcp,
    network inet6 udp,
    network unix stream,

    # Capabilities allowed in containers
    capability net_bind_service,
    capability setuid,
    capability setgid,
    capability chown,

    # Deny dangerous capabilities
    deny capability sys_ptrace,
    deny capability sys_admin,
    deny capability sys_rawio,
    deny capability net_admin,
    deny capability sys_module,
    deny capability sys_boot,
    deny capability mac_admin,
    deny capability mac_override,

    # Deny pivot_root and mounts
    deny mount,
    deny umount,
    deny pivot_root,

    # Deny ptrace
    deny ptrace,

    # Signals
    signal peer=docker-go-http-server,
}
```

Load and apply the profile:

```bash
# Load the profile
apparmor_parser -r /etc/apparmor.d/docker-go-http-server

# Run a container with the custom profile
docker run \
  --security-opt "apparmor=docker-go-http-server" \
  -p 8080:8080 \
  your-go-http-server:latest

# Verify the profile is active
docker inspect --format='{{.HostConfig.SecurityOpt}}' <container-id>
```

## Section 7: Kubernetes AppArmor Integration

### Applying AppArmor Profiles to Pods

AppArmor profiles must be loaded on every node where the pod may run. Use a DaemonSet (see Section 8) for distribution.

```yaml
# pod-apparmor.yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
  namespace: production
  annotations:
    # Syntax: container.apparmor.security.beta.kubernetes.io/<container-name>: <profile>
    container.apparmor.security.beta.kubernetes.io/app: localhost/docker-go-http-server
spec:
  containers:
    - name: app
      image: your-go-http-server:latest
      ports:
        - containerPort: 8080
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

For Kubernetes 1.30+ (graduated from beta):

```yaml
# pod-apparmor-v130.yaml
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
spec:
  securityContext:
    appArmorProfile:
      type: Localhost
      localhostProfile: docker-go-http-server
  containers:
    - name: app
      image: your-go-http-server:latest
      securityContext:
        appArmorProfile:
          type: Localhost
          localhostProfile: docker-go-http-server
```

### Deployment with AppArmor

```yaml
# deployment-apparmor.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders-api
  namespace: production
spec:
  replicas: 3
  template:
    metadata:
      annotations:
        container.apparmor.security.beta.kubernetes.io/orders-api: localhost/orders-api-profile
    spec:
      containers:
        - name: orders-api
          image: your-registry/orders-api:v2.5.0
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 1000
            capabilities:
              drop: ["ALL"]
```

## Section 8: Distributing Profiles to Kubernetes Nodes

### DaemonSet Profile Installer

```yaml
# apparmor-profile-installer.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: apparmor-profile-installer
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: apparmor-profile-installer
  template:
    metadata:
      labels:
        app: apparmor-profile-installer
    spec:
      initContainers:
        - name: installer
          image: ubuntu:22.04
          securityContext:
            privileged: true
          command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              # Install AppArmor tools
              apt-get update -qq && apt-get install -y -qq apparmor apparmor-utils

              # Install profiles from ConfigMap
              mkdir -p /host/etc/apparmor.d
              for profile in /profiles/*; do
                name=$(basename "$profile")
                echo "Installing profile: $name"
                cp "$profile" "/host/etc/apparmor.d/${name}"
              done

              # Parse and load all installed profiles
              for profile in /profiles/*; do
                name=$(basename "$profile")
                echo "Loading profile: $name"
                chroot /host apparmor_parser -r "/etc/apparmor.d/${name}" && \
                  echo "Profile $name loaded" || \
                  echo "WARNING: Failed to load $name"
              done

              echo "AppArmor profiles installed successfully"
          volumeMounts:
            - name: host-root
              mountPath: /host
            - name: profiles
              mountPath: /profiles
              readOnly: true
      containers:
        - name: pause
          image: gcr.io/google-containers/pause:3.9
          resources:
            requests:
              cpu: 1m
              memory: 8Mi
      volumes:
        - name: host-root
          hostPath:
            path: /
        - name: profiles
          configMap:
            name: apparmor-profiles
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: apparmor-profiles
  namespace: kube-system
data:
  docker-go-http-server: |
    #include <tunables/global>

    profile docker-go-http-server flags=(attach_disconnected,mediate_deleted) {
      #include <abstractions/base>

      file,

      deny /proc/sysrq-trigger rwklx,
      deny /sys/firmware/** rwklx,

      /proc/@{pid}/attr/current rw,
      /proc/@{pid}/fd/ r,
      /proc/@{pid}/status r,

      network inet tcp,
      network inet udp,
      network unix stream,

      capability net_bind_service,
      capability setuid,
      capability setgid,
      capability chown,

      deny capability sys_ptrace,
      deny capability sys_admin,
      deny capability sys_module,
      deny capability net_admin,

      deny mount,
      deny umount,
      deny ptrace,

      signal peer=docker-go-http-server,
    }

  orders-api-profile: |
    #include <tunables/global>

    profile orders-api-profile flags=(attach_disconnected,mediate_deleted) {
      #include <abstractions/base>
      #include <abstractions/nameservice>

      file,

      deny /proc/sysrq-trigger rwklx,
      deny /sys/firmware/** rwklx,
      deny /etc/shadow rwklx,

      /proc/@{pid}/attr/current rw,
      /proc/@{pid}/status r,
      /proc/sys/kernel/ngroups_max r,

      network inet tcp,
      network inet udp,
      network inet6 tcp,
      network unix stream,

      capability net_bind_service,

      deny capability sys_ptrace,
      deny capability sys_admin,
      deny capability sys_module,
      deny mount,
      deny ptrace,
    }
```

## Section 9: AppArmor Tools Reference

### aa-genprof — Interactive Profile Generator

```bash
# Profile a new application
aa-genprof /usr/bin/my-application

# Workflow:
# 1. Puts the application in complain mode
# 2. Prompts you to run the application in a separate terminal
# 3. After running, press 'S' to scan for log entries
# 4. For each access attempt, choose:
#    A = Allow
#    D = Deny
#    G = Glob (auto-generalize the path)
#    N = new rule (manual)
#    Q = Quit and save
```

### aa-logprof — Profile Refinement from Logs

```bash
# Read syslog and update all profiles
aa-logprof

# Read from a specific log file
aa-logprof -f /var/log/audit/audit.log

# Preview changes without writing
aa-logprof -d

# Update a specific profile
aa-logprof -p /etc/apparmor.d/usr.sbin.nginx
```

### aa-enforce and aa-complain

```bash
# Set profile to enforce mode
aa-enforce /etc/apparmor.d/usr.sbin.nginx
aa-enforce /usr/sbin/nginx  # Can also use the binary path

# Set profile to complain mode
aa-complain /etc/apparmor.d/usr.sbin.nginx

# Disable a profile (keep loaded but inactive)
aa-disable /etc/apparmor.d/usr.sbin.nginx

# Unload a profile
apparmor_parser -R /etc/apparmor.d/usr.sbin.nginx

# Load/reload a profile
apparmor_parser -r /etc/apparmor.d/usr.sbin.nginx
# OR
service apparmor reload
```

### Debugging Violations

```bash
# Parse audit log for AppArmor events
grep "apparmor=" /var/log/audit/audit.log | \
  awk '{
    match($0, /apparmor="([^"]*)"/, mode);
    match($0, /profile="([^"]*)"/, prof);
    match($0, /name="([^"]*)"/, name);
    match($0, /requested_mask="([^"]*)"/, mask);
    printf "%s\t%s\t%s\t%s\n",
      mode[1], prof[1], mask[1], name[1]
  }' | sort | uniq -c | sort -rn | head -30

# Use aureport for summary
aureport --avc --summary 2>/dev/null | head -20

# Trace a specific process
strace -e trace=openat,read,write,connect,bind -p $(pgrep nginx) 2>&1 | \
  grep -E "EACCES|EPERM" | head -20
```

## Section 10: Advanced Profile Patterns

### Nested Profiles (Child Execution)

```
profile parent /usr/bin/parent {
    # ...

    # Allow spawning the child with its own profile
    /usr/bin/child  cx -> child_profile,

    # Define child profile inline
    profile child_profile {
        #include <abstractions/base>
        /usr/bin/child    mr,
        /tmp/child-work-* rw,
        network inet tcp,
    }
}
```

### Profile Stacking (overlapping confinement)

```bash
# Stack multiple profiles for defense in depth
# Both profiles must allow the action
docker run \
  --security-opt "apparmor=docker-default" \
  --security-opt "apparmor=application-specific" \
  your-app:latest

# In Kubernetes, profile stacking via annotation:
# container.apparmor.security.beta.kubernetes.io/app: "runtime/default:localhost/app-profile"
```

### Policy-as-Code with OPA

Enforce AppArmor profile requirements via OPA Gatekeeper:

```yaml
# opa-apparmor-constraint.yaml
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredAppArmorProfile
metadata:
  name: require-apparmor-profile
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
    namespaces:
      - "production"
      - "staging"
  parameters:
    allowedProfiles:
      - "localhost/docker-go-http-server"
      - "localhost/orders-api-profile"
      - "runtime/default"
```

### Monitoring AppArmor Violations in Prometheus

```bash
# Extend node-exporter textfile collector
cat > /usr/local/bin/collect-apparmor-metrics.sh << 'SCRIPT'
#!/bin/bash
OUTFILE="/var/lib/node_exporter/textfile_collector/apparmor.prom"

DENIED=$(grep "apparmor=\"DENIED\"" /var/log/audit/audit.log 2>/dev/null | wc -l || echo 0)
ALLOWED=$(grep "apparmor=\"ALLOWED\"" /var/log/audit/audit.log 2>/dev/null | wc -l || echo 0)
LOADED=$(aa-status --pretty-json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
profiles = data.get('profiles', {})
total = sum(len(v) for v in profiles.values())
print(total)
" 2>/dev/null || echo 0)

cat > "${OUTFILE}" << EOF
# HELP apparmor_denied_total Total AppArmor denied events
# TYPE apparmor_denied_total counter
apparmor_denied_total ${DENIED}
# HELP apparmor_allowed_total Total AppArmor complain-mode allowed events
# TYPE apparmor_allowed_total counter
apparmor_allowed_total ${ALLOWED}
# HELP apparmor_profiles_loaded Total AppArmor profiles loaded
# TYPE apparmor_profiles_loaded gauge
apparmor_profiles_loaded ${LOADED}
EOF
SCRIPT
chmod +x /usr/local/bin/collect-apparmor-metrics.sh

# Run via systemd timer or cron
echo "* * * * * root /usr/local/bin/collect-apparmor-metrics.sh" > \
  /etc/cron.d/apparmor-metrics
```

AppArmor profiles provide a principled, maintainable approach to container confinement that complements Kubernetes security primitives. The complain-to-enforce workflow ensures profiles are derived from real application behavior rather than guesswork, and the `aa-genprof`/`aa-logprof` toolchain makes profile creation accessible to operations engineers without deep security expertise. Combined with seccomp profiles and capability dropping, AppArmor forms the third pillar of a comprehensive container security architecture.
