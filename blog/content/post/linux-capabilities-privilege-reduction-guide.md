---
title: "Linux Capabilities: Privilege Reduction for Containers and Services"
date: 2028-12-08T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Capabilities", "Containers", "Kubernetes"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep guide to Linux capabilities: permitted/effective/inheritable/ambient/bounding sets, dropping capabilities in containers with Docker and Kubernetes securityContext, CAP_NET_BIND_SERVICE without root, and finding minimum required capabilities."
more_link: "yes"
url: "/linux-capabilities-privilege-reduction-guide/"
---

The traditional Linux privilege model has two levels: root (UID 0) and non-root. Root can do everything. This coarse boundary is why a compromised root process can do arbitrary damage. Linux capabilities divide the power of root into discrete units — 41 capabilities in Linux 5.x — so a process can be granted only the specific privileges it needs. A web server needs `CAP_NET_BIND_SERVICE` to listen on port 80 but nothing else. A network monitor needs `CAP_NET_RAW` for raw sockets but not `CAP_SYS_ADMIN`. Principle of least privilege applied to process privileges.

This guide covers all five capability sets, how to audit and drop capabilities in containers, ambient capabilities for non-root processes, and practical Kubernetes securityContext configuration.

<!--more-->

# Linux Capabilities: Privilege Reduction

## Section 1: The Five Capability Sets

Every process has five capability sets. Each set is a bitmask of the 41 defined capabilities.

| Set | Description |
|-----|-------------|
| **permitted** | The maximum capabilities a process may have (ceiling) |
| **effective** | Capabilities currently active and checked by the kernel |
| **inheritable** | Capabilities that can be inherited across execve |
| **ambient** | Capabilities inherited across execve even for non-root (Linux 4.3+) |
| **bounding** | Hard limit — capabilities cannot be added above this set |

Every file also has three capability sets (permitted, inheritable, effective) encoded in extended attributes.

```bash
# View process capabilities
cat /proc/$$/status | grep -i cap
# CapInh: 0000000000000000
# CapPrm: 000001ffffffffff
# CapEff: 000001ffffffffff
# CapBnd: 000001ffffffffff
# CapAmb: 0000000000000000

# Decode capability bitmask
capsh --decode=000001ffffffffff
# 0x000001ffffffffff=cap_chown,cap_dac_override,...,cap_block_suspend,cap_audit_read

# Full list of capabilities
man capabilities | grep -E "^\s+CAP_"

# View file capabilities
getcap /bin/ping
# /bin/ping cap_net_raw=ep

# All files with capabilities
find /usr /bin /sbin -xdev -exec getcap {} + 2>/dev/null | grep -v '^$'
```

## Section 2: Capability Reference

Essential capabilities for service hardening:

| Capability | What it allows | Common use |
|-----------|----------------|-----------|
| `CAP_NET_BIND_SERVICE` | Bind to ports < 1024 | Web servers |
| `CAP_NET_RAW` | Use raw/packet sockets | ping, tcpdump, network monitoring |
| `CAP_NET_ADMIN` | Network interface config | VPNs, bridges |
| `CAP_SYS_PTRACE` | Trace processes with ptrace | Debuggers, strace |
| `CAP_SYS_ADMIN` | Enormous range of admin ops | Mount, ioctl, many more |
| `CAP_CHOWN` | Change file ownership | Container entrypoints |
| `CAP_DAC_OVERRIDE` | Bypass file read/write/execute permission checks | — |
| `CAP_SETUID` | Change UID | su, setuid programs |
| `CAP_SETGID` | Change GID | — |
| `CAP_SYS_TIME` | Set system clock | chrony, ntpd |
| `CAP_SYS_NICE` | Change process priority | Real-time applications |
| `CAP_IPC_LOCK` | Lock memory (mlock) | Databases, vaults |
| `CAP_SYS_RESOURCE` | Override resource limits | — |

`CAP_SYS_ADMIN` is the most dangerous: it covers mount operations, ioctl on many devices, namespace creation, and dozens of other privileged operations. Never grant it to a container unless there is no alternative.

## Section 3: Inspecting and Dropping Capabilities

### Using capsh

```bash
# Install libcap
apt-get install -y libcap2-bin

# Show current capabilities
capsh --print
# Current: =ep
# Bounding set =cap_chown,...,cap_block_suspend,cap_audit_read
# Ambient set =
# Securebits: 00/0x0/1'b0
#  secure-noroot: no (unlocked)
#  secure-no-suid-fixup: no (unlocked)
#  secure-keep-caps: no (unlocked)
#  secure-no-ambient-raise: no (unlocked)
# uid=0(root) euid=0(root)

# Run a command with only CAP_NET_BIND_SERVICE
capsh --caps="cap_net_bind_service+eip" --user=www-data -- -c "python3 -m http.server 80"

# Drop all capabilities and run as non-root
capsh --drop=all --user=nobody -- -c "id; whoami"
```

### Using setpriv (util-linux)

```bash
# Run nginx with only the bind capability, as user www-data
setpriv \
  --reuid=www-data \
  --regid=www-data \
  --init-groups \
  --inh-caps=-all,+net_bind_service \
  --ambient-caps=+net_bind_service \
  -- nginx -g "daemon off;"
```

### Setting file capabilities

```bash
# Grant CAP_NET_BIND_SERVICE to a binary so non-root can run it on port 80
# This avoids running the entire process as root
setcap cap_net_bind_service=+ep /usr/local/bin/myserver

# Verify
getcap /usr/local/bin/myserver
# /usr/local/bin/myserver cap_net_bind_service=ep

# Now a non-root user can run it on port 80
su - appuser -c "/usr/local/bin/myserver --port=80"

# Remove file capabilities
setcap -r /usr/local/bin/myserver
```

## Section 4: Ambient Capabilities for Non-Root Processes

Before Linux 4.3, file capabilities were the only way to grant a non-root executable elevated privileges. Ambient capabilities allow a process to grant capabilities to its children across execve, even when the child executable has no file capabilities set.

```c
// ambient_demo.c — set CAP_NET_RAW as ambient before exec
#define _GNU_SOURCE
#include <sys/capability.h>
#include <sys/prctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    // Add CAP_NET_RAW to the inheritable set
    cap_t caps = cap_get_proc();
    cap_value_t cap_list[] = { CAP_NET_RAW };

    cap_set_flag(caps, CAP_INHERITABLE, 1, cap_list, CAP_SET);
    if (cap_set_proc(caps) < 0) {
        perror("cap_set_proc"); exit(1);
    }
    cap_free(caps);

    // Raise CAP_NET_RAW in the ambient set
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, CAP_NET_RAW, 0, 0) < 0) {
        perror("prctl PR_CAP_AMBIENT_RAISE"); exit(1);
    }

    // Now execve a non-setuid program; it will inherit CAP_NET_RAW
    char *args[] = { "/usr/bin/ping", "-c1", "127.0.0.1", NULL };
    execv("/usr/bin/ping", args);
    perror("execv");
    return 1;
}
```

```bash
gcc -o ambient_demo ambient_demo.c -lcap
# Must start with sufficient caps to raise ambient
sudo ./ambient_demo
```

In container/systemd contexts, set ambient capabilities in the service unit:

```ini
# /etc/systemd/system/myservice.service
[Service]
User=myservice
Group=myservice
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/myserver
```

```bash
systemctl daemon-reload
systemctl restart myservice

# Verify capabilities
cat /proc/$(pgrep myserver)/status | grep Cap
```

## Section 5: Capabilities in Docker Containers

Docker drops most capabilities by default. The default set includes a safe subset but still includes dangerous ones like `CAP_NET_ADMIN` and `CAP_SYS_PTRACE`.

```bash
# View default Docker capabilities
docker run --rm alpine sh -c "apk add -q libcap && capsh --print"

# Docker default effective caps include:
# cap_chown, cap_dac_override, cap_fowner, cap_fsetid,
# cap_kill, cap_setgid, cap_setuid, cap_setpcap,
# cap_net_bind_service, cap_net_raw, cap_sys_chroot,
# cap_mknod, cap_audit_write, cap_setfcap

# Best practice: drop ALL, then add back only what is required
docker run \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --user 1000:1000 \
  --read-only \
  myimage:latest

# For a database that needs to lock memory
docker run \
  --cap-drop ALL \
  --cap-add IPC_LOCK \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add SETUID \
  --cap-add SETGID \
  postgres:16

# Security scan: check capabilities of running containers
docker inspect $(docker ps -q) | \
  python3 -c "
import json, sys
containers = json.load(sys.stdin)
for c in containers:
    name = c['Name']
    caps = c['HostConfig'].get('CapAdd') or []
    dropped = c['HostConfig'].get('CapDrop') or []
    print(f'{name}: add={caps}, drop={dropped}')
"
```

## Section 6: Kubernetes securityContext

Kubernetes exposes Linux capabilities through `securityContext` at both pod and container level.

```yaml
# Minimal securityContext for a web application
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-webapp
  namespace: production
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 2000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          image: ghcr.io/example/webapp:v1.2.0
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
              add:
                - NET_BIND_SERVICE  # only if binding to port < 1024
          ports:
            - containerPort: 8080
```

```yaml
# For a network monitoring sidecar requiring raw socket access
- name: network-monitor
  image: ghcr.io/example/netmon:v1.0.0
  securityContext:
    allowPrivilegeEscalation: false
    capabilities:
      drop:
        - ALL
      add:
        - NET_RAW
        - NET_ADMIN
```

```yaml
# For a storage driver requiring privileged block device operations
# (avoid CAP_SYS_ADMIN if possible; use specific caps)
- name: storage-driver
  securityContext:
    capabilities:
      drop:
        - ALL
      add:
        - SYS_ADMIN   # required for mount(2) — no narrower alternative exists
        - CHOWN
        - DAC_OVERRIDE
```

Enforce capability restrictions cluster-wide with Pod Security Admission:

```yaml
# Enforce restricted policy on a namespace
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Reject pods that don't comply with restricted policy
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.29
    # Warn but allow for baseline policy
    pod-security.kubernetes.io/warn: baseline
    pod-security.kubernetes.io/warn-version: v1.29
```

The restricted PSA profile requires:
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`
- Only `NET_BIND_SERVICE` allowed in `capabilities.add`
- `runAsNonRoot: true`
- `seccompProfile.type: RuntimeDefault or Localhost`

## Section 7: Finding Required Capabilities

Before locking down a service, determine what capabilities it actually needs.

### Method 1: strace

```bash
# Run the binary with strace and look for permission errors
strace -e trace=all -f myservice 2>&1 | grep -E "EPERM|EACCES|capability"

# More targeted: track syscalls that require capabilities
strace -e trace=process,network,ipc -f myservice 2>&1 | head -100
```

### Method 2: Falco or Tetragon

```bash
# Tetragon policy to log capability checks
cat > cap-trace-policy.yaml << 'EOF'
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: capability-checks
spec:
  kprobes:
    - call: "cap_capable"
      syscall: false
      args:
        - index: 1
          type: int
          label: "cap"
      selectors:
        - matchArgs:
            - index: 1
              operator: "InMap"
              values:
                - "0"   # CAP_CHOWN
                - "6"   # CAP_SETUID
                - "7"   # CAP_SETGID
                - "10"  # CAP_NET_BIND_SERVICE
                - "13"  # CAP_NET_RAW
EOF

kubectl apply -f cap-trace-policy.yaml
kubectl exec -n kube-system ds/tetragon -- tetra getevents -o compact | grep cap_capable
```

### Method 3: Run with all caps dropped and observe failures

```bash
# Drop all capabilities; the service will log EPERM for any cap check it fails
docker run \
  --cap-drop ALL \
  --user 1000 \
  myimage:latest 2>&1 | grep -i "operation not permitted\|permission denied"

# Re-add caps one at a time until all errors resolve
docker run \
  --cap-drop ALL \
  --cap-add NET_BIND_SERVICE \
  --user 1000 \
  myimage:latest 2>&1 | grep -i "operation not permitted"
```

### Method 4: capsh –– with privilege dropping

```bash
# Test with only the suspected required capability
sudo capsh --caps="cap_net_bind_service+eip" --user=www-data -- \
  -c "exec /usr/local/bin/myserver --port=80" 2>&1
```

## Section 8: Audit Script for Production Containers

```bash
#!/bin/bash
# audit-capabilities.sh
# Audit all running containers for capability configuration

echo "=== Container Capability Audit ==="
echo ""

for container_id in $(docker ps -q); do
  name=$(docker inspect --format '{{.Name}}' $container_id | tr -d '/')
  image=$(docker inspect --format '{{.Config.Image}}' $container_id)
  cap_add=$(docker inspect --format '{{.HostConfig.CapAdd}}' $container_id)
  cap_drop=$(docker inspect --format '{{.HostConfig.CapDrop}}' $container_id)
  privileged=$(docker inspect --format '{{.HostConfig.Privileged}}' $container_id)
  user=$(docker inspect --format '{{.Config.User}}' $container_id)

  risk="LOW"
  if [ "$privileged" = "true" ]; then
    risk="CRITICAL"
  elif echo "$cap_add" | grep -qi "sys_admin\|sys_ptrace\|net_admin"; then
    risk="HIGH"
  elif [ -z "$cap_drop" ] || echo "$cap_drop" | grep -qvi "all"; then
    risk="MEDIUM"
  fi

  echo "Container: $name ($image)"
  echo "  Risk:       $risk"
  echo "  Privileged: $privileged"
  echo "  User:       ${user:-root}"
  echo "  Cap Add:    $cap_add"
  echo "  Cap Drop:   $cap_drop"
  echo ""
done
```

```bash
chmod +x audit-capabilities.sh
./audit-capabilities.sh
```

Capability reduction is one of the highest-impact, lowest-effort security improvements for containerized workloads. The combination of `--cap-drop ALL` in Docker or `capabilities.drop: [ALL]` in Kubernetes, combined with `allowPrivilegeEscalation: false` and a read-only root filesystem, eliminates the majority of privilege escalation paths that make container breakouts possible. Start every new service with no capabilities and add them back only when an `EPERM` proves they are required.
