---
title: "Linux SELinux for Kubernetes: Policy Development and Container Confinement"
date: 2030-10-14T00:00:00-05:00
draft: false
tags: ["SELinux", "Kubernetes", "Security", "Linux", "Container Security", "Policy Development"]
categories:
- Security
- Kubernetes
- Linux
author: "Matthew Mattox - mmattox@support.tools"
description: "Enterprise SELinux guide covering modes and context labeling, container label inheritance, custom type enforcement policies, audit2allow workflow, Kubernetes pod SELinux policies, and AVC denial debugging."
more_link: "yes"
url: "/linux-selinux-kubernetes-policy-development-container-confinement/"
---

SELinux provides mandatory access control enforcement that operates independently of discretionary file permissions and container runtime namespacing. In Kubernetes deployments, SELinux confinement prevents container escapes from reaching the host filesystem, limits lateral movement between containers, and satisfies compliance frameworks including DISA STIG, CIS Benchmarks, and NIST 800-190. The challenge is that most teams disable SELinux to solve permission errors, sacrificing the security boundary that justified the complexity.

<!--more-->

## SELinux Architecture and Modes

### Core Concepts

SELinux assigns a security context to every process, file, socket, and device on the system. Access decisions are made by comparing the source context, target context, and requested permission against the loaded policy.

```
Subject (Process)           Object (File/Socket/etc)
  user_u:role_r:type_t:s0    user_u:object_r:file_type_t:s0
        |                              |
        +----> SELinux Policy Engine <--+
                    |
              ALLOW or DENY
```

A security context has four components:
- **User**: SELinux user identity (unconfined_u, system_u, user_u)
- **Role**: RBAC role (object_r for files, system_r for daemons)
- **Type**: The primary enforcement unit; policy rules reference types
- **Level**: Multi-level security (MLS) sensitivity level (s0:c0.c1023)

### Enforcing, Permissive, and Disabled

```bash
# Check current mode
getenforce
sestatus -v

# Temporarily switch to permissive (survives reboot? No)
setenforce 0   # permissive
setenforce 1   # enforcing

# Set persistent mode in /etc/selinux/config
sed -i 's/^SELINUX=.*/SELINUX=enforcing/' /etc/selinux/config

# Set permissive for a single domain without affecting the rest of the policy
# This is far safer than setenforce 0 for debugging
semanage permissive -a container_t
semanage permissive -d container_t  # re-enable enforcement for that domain

# List all permissive domains
semanage permissive -l
```

### Policy Types

```bash
# Targeted policy: only specific daemons are confined
# MLS policy: multi-level security for classified environments
# Minimum policy: minimal targeted policy
cat /etc/selinux/config | grep SELINUXTYPE

# List available policy modules
semodule -l | head -30

# Show policy module details
semodule -l | grep container
```

## Container Context Labeling

### How Container Runtimes Apply SELinux Contexts

On Red Hat-based systems with `container-selinux` installed, container runtimes label containers with `container_t` type and use MCS (Multi-Category Security) labels to provide container-to-container isolation:

```bash
# View the SELinux context of a running container process
docker inspect --format='{{.HostConfig.SecurityOpt}}' my-container

# Examine the actual process context inside the container
docker exec my-container cat /proc/1/attr/current

# On the host, check running container processes
ps -eZ | grep container_t | head -10

# View file contexts inside container mounts
ls -Z /var/lib/containers/storage/overlay/

# Verify MCS label uniqueness per container
ps -eZ | awk '/container_t/{print $1}' | sort | uniq -d
# Should produce no output (each container gets unique c0,c1 pair)
```

### Kubernetes Pod SELinux Context Configuration

```yaml
# pod-with-selinux-context.yaml
apiVersion: v1
kind: Pod
metadata:
  name: confined-app
  namespace: production
spec:
  securityContext:
    seLinuxOptions:
      # Use container_t for standard confinement
      type: container_t
      # level restricts which host resources the container can access
      level: "s0:c123,c456"

  containers:
  - name: app
    image: your-registry.io/app:v1.2.3
    securityContext:
      seLinuxOptions:
        # Container-level overrides pod-level
        type: container_t
        level: "s0:c123,c456"
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
    volumeMounts:
    - name: data
      mountPath: /data

  volumes:
  - name: data
    hostPath:
      path: /data/app/production
      type: Directory
```

```bash
# Label host directories for container access
# container_file_t allows read-write access by container_t
chcon -Rt container_file_t /data/app/production

# Or use semanage for persistence across relabeling
semanage fcontext -a -t container_file_t '/data/app(/.*)?'
restorecon -Rv /data/app

# Verify the label was applied
ls -dZ /data/app/production
```

## Writing Custom Type Enforcement Policies

### Policy Module Structure

```
my_app_policy/
├── my_app.te      # Type enforcement rules
├── my_app.fc      # File context definitions
├── my_app.if      # Interface definitions (for other policies to use)
└── Makefile
```

### Type Enforcement File (my_app.te)

```te
# my_app.te - Custom SELinux policy for a Go service
policy_module(my_app, 1.0.0)

# Declare the new domain type
type my_app_t;
type my_app_exec_t;

# Declare file types this service manages
type my_app_var_run_t;
type my_app_log_t;
type my_app_data_t;
type my_app_config_t;
type my_app_tmp_t;

# Mark the binary as an entrypoint for the domain
domain_type(my_app_t)
domain_entry_file(my_app_t, my_app_exec_t)

# Allow standard init transitions
init_daemon_domain(my_app_t, my_app_exec_t)

# Allow systemd to launch the service
systemd_daemon_activatable(my_app_t, my_app_exec_t)

# Network permissions
# Allow binding to specific port range
corenet_tcp_bind_generic_node(my_app_t)
corenet_tcp_bind_http_port(my_app_t)
allow my_app_t self:tcp_socket { create bind listen accept read write };
allow my_app_t self:udp_socket { create bind read write };

# Allow outbound connections (for calling downstream services)
corenet_tcp_connect_http_port(my_app_t)
corenet_tcp_connect_postgresql_port(my_app_t)

# File system permissions
# PID file
files_pid_file(my_app_var_run_t)
manage_files_pattern(my_app_t, my_app_var_run_t, my_app_var_run_t)

# Log files
logging_log_file(my_app_log_t)
manage_files_pattern(my_app_t, my_app_log_t, my_app_log_t)
logging_log_filetrans(my_app_t, my_app_log_t, file)

# Configuration files (read-only)
files_config_file(my_app_config_t)
allow my_app_t my_app_config_t:file read_file_perms;
allow my_app_t my_app_config_t:dir list_dir_perms;

# Data directory (read-write)
allow my_app_t my_app_data_t:dir manage_dir_perms;
allow my_app_t my_app_data_t:file manage_file_perms;

# Temp files
files_tmp_file(my_app_tmp_t)
manage_files_pattern(my_app_t, my_app_tmp_t, my_app_tmp_t)
files_tmp_filetrans(my_app_t, my_app_tmp_t, file)

# DNS resolution
sysnet_read_config(my_app_t)
sysnet_dns_name_resolve(my_app_t)

# Allow reading /proc/self
allow my_app_t self:process { getsched signal_perms };
kernel_read_system_state(my_app_t)

# Allow reading shared libraries
libs_use_ld_so(my_app_t)
libs_use_shared_libs(my_app_t)

# Signal handling
allow my_app_t self:signal_perms;
```

### File Context Definitions (my_app.fc)

```
# my_app.fc - File context definitions

# Binary location
/usr/bin/my-app                             --  gen_context(system_u:object_r:my_app_exec_t,s0)
/usr/sbin/my-app                            --  gen_context(system_u:object_r:my_app_exec_t,s0)

# Configuration
/etc/my-app(/.*)?                               gen_context(system_u:object_r:my_app_config_t,s0)

# Data directory
/var/lib/my-app(/.*)?                           gen_context(system_u:object_r:my_app_data_t,s0)

# Log files
/var/log/my-app(/.*)?                           gen_context(system_u:object_r:my_app_log_t,s0)
/var/log/my-app\.log                        --  gen_context(system_u:object_r:my_app_log_t,s0)

# PID file
/run/my-app\.pid                            --  gen_context(system_u:object_r:my_app_var_run_t,s0)
/var/run/my-app(/.*)?                           gen_context(system_u:object_r:my_app_var_run_t,s0)
```

### Makefile for Policy Module

```makefile
# Makefile for SELinux policy module

POLICY_MODULE = my_app
VERSION = 1.0.0

# Build tools
CHECKMODULE = /usr/bin/checkmodule
SEMODULE_PACKAGE = /usr/bin/semodule_package
SEMODULE = /usr/bin/semodule

.PHONY: all build install clean check

all: build

check:
	$(CHECKMODULE) -M -m -o $(POLICY_MODULE).mod $(POLICY_MODULE).te

build: check
	$(SEMODULE_PACKAGE) -o $(POLICY_MODULE).pp -m $(POLICY_MODULE).mod -f $(POLICY_MODULE).fc

install: build
	$(SEMODULE) -i $(POLICY_MODULE).pp
	restorecon -Rv /usr/bin/my-app /etc/my-app /var/lib/my-app /var/log/my-app

clean:
	rm -f $(POLICY_MODULE).mod $(POLICY_MODULE).pp

remove:
	$(SEMODULE) -r $(POLICY_MODULE) || true
```

## The audit2allow Workflow

`audit2allow` translates AVC denial messages from the audit log into candidate policy rules. Use it as a starting point for policy development, not as an automatic policy generator.

### Step-by-Step audit2allow Process

```bash
# Step 1: Run the application in permissive mode for the specific domain
semanage permissive -a my_app_t

# Step 2: Exercise all application code paths
# Run integration tests, simulate production traffic, trigger all features

# Step 3: Collect AVC denials
# Option A: From audit log
ausearch -c my-app -m avc --start recent > /tmp/my_app_denials.txt

# Option B: From journald
journalctl -t setroubleshoot --since "1 hour ago" > /tmp/my_app_denials.txt

# Option C: Real-time monitoring
tail -f /var/log/audit/audit.log | grep -E 'AVC|avc' | grep my_app_t

# Step 4: Analyze denials with audit2why for human-readable explanations
audit2why < /tmp/my_app_denials.txt

# Step 5: Generate candidate policy
audit2allow -M my_app_additions < /tmp/my_app_denials.txt

# Step 6: REVIEW the generated .te file before installing
cat my_app_additions.te
```

### Reviewing audit2allow Output

```bash
# EXAMPLE OUTPUT - Review each rule carefully
# Generated by audit2allow:

module my_app_additions 1.0;

require {
    type my_app_t;
    type container_file_t;
    type proc_t;
    type sysfs_t;
    class file { read open };
    class dir search;
}

# !! REVIEW REQUIRED !!
# This rule allows my_app_t to read /proc files
# Is this expected? What specific /proc path triggered this?
allow my_app_t proc_t:file { read open };

# This rule is fine - reading app data files
allow my_app_t container_file_t:dir search;
allow my_app_t container_file_t:file { read open };
```

```bash
# Step 7: Refine the policy to use more specific types instead of broad allows
# Replace: allow my_app_t proc_t:file { read open };
# With the appropriate interface:
#   kernel_read_system_state(my_app_t)  -- for /proc/stat, /proc/meminfo
#   kernel_read_network_state(my_app_t) -- for /proc/net/*

# Step 8: Install refined policy and re-enforce
semodule -i my_app.pp
semanage permissive -d my_app_t

# Step 9: Verify no new denials
ausearch -c my-app -m avc --start recent
echo "Exit code $? (1 = no denials found)"
```

## SELinux for Kubernetes Pods: Complete Examples

### Database Pod with Read-Only Config

```yaml
# postgres-selinux-pod.yaml
apiVersion: v1
kind: Pod
metadata:
  name: postgres-confined
  namespace: databases
  annotations:
    # This annotation documents the SELinux label for auditing
    security.support.tools/selinux-context: "system_u:system_r:container_t:s0:c100,c200"
spec:
  securityContext:
    runAsUser: 999
    runAsGroup: 999
    fsGroup: 999
    seLinuxOptions:
      type: container_t
      level: "s0:c100,c200"

  initContainers:
  - name: chown-data
    image: busybox:1.36
    command: ["chown", "-R", "999:999", "/var/lib/postgresql/data"]
    securityContext:
      seLinuxOptions:
        type: container_t
        level: "s0:c100,c200"
    volumeMounts:
    - name: pgdata
      mountPath: /var/lib/postgresql/data

  containers:
  - name: postgres
    image: postgres:16.2
    securityContext:
      seLinuxOptions:
        type: container_t
        level: "s0:c100,c200"
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: false  # Postgres needs to write temp files
      capabilities:
        drop: ["ALL"]
        add: ["SETUID", "SETGID"]  # Required for postgres user switching
    volumeMounts:
    - name: pgdata
      mountPath: /var/lib/postgresql/data
    - name: config
      mountPath: /etc/postgresql/postgresql.conf
      subPath: postgresql.conf
      readOnly: true

  volumes:
  - name: pgdata
    persistentVolumeClaim:
      claimName: postgres-data
  - name: config
    configMap:
      name: postgres-config
```

```bash
# Label the PVC's underlying storage for container access
# Find the backing directory
kubectl get pvc postgres-data -o jsonpath='{.spec.volumeName}'
# PV_NAME=pvc-abc123-def456

# Label it appropriately
chcon -Rt container_file_t /var/lib/kubelet/pods/POD_UID/volumes/
```

### Pod Security Admission with SELinux

```yaml
# selinux-pod-security-policy.yaml (via PSA labels on namespace)
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    # Enforce restricted PSS - requires explicit SELinux context or RunAsAny
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.28
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
---
# ValidatingAdmissionPolicy for SELinux context enforcement
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: require-selinux-context
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: [""]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["pods"]
  validations:
  - expression: >
      has(object.spec.securityContext.seLinuxOptions) ||
      object.spec.containers.all(c,
        has(c.securityContext) && has(c.securityContext.seLinuxOptions)
      )
    message: "All pods must specify an SELinux context"
  - expression: >
      !has(object.spec.securityContext.seLinuxOptions) ||
      object.spec.securityContext.seLinuxOptions.type == 'container_t' ||
      object.spec.securityContext.seLinuxOptions.type == 'spc_t'
    message: "SELinux type must be container_t or spc_t"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: require-selinux-context-binding
spec:
  policyName: require-selinux-context
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels:
        selinux-enforcement: required
```

## Debugging AVC Denials Without Disabling SELinux

### Systematic Denial Investigation

```bash
#!/bin/bash
# selinux-debug.sh - Systematic AVC denial investigation
# Run as root on the affected node

set -euo pipefail

PROCESS_NAME="${1:-}"
TIME_WINDOW="${2:--1h}"

echo "=== SELinux AVC Denial Investigation ==="
echo "Process: ${PROCESS_NAME:-all}"
echo "Time window: ${TIME_WINDOW}"
echo ""

# 1. Get recent denials
echo "--- Recent AVC Denials ---"
if [ -n "$PROCESS_NAME" ]; then
    ausearch -c "$PROCESS_NAME" -m avc --start recent 2>/dev/null \
        || echo "No denials found for process: $PROCESS_NAME"
else
    ausearch -m avc --start recent 2>/dev/null | tail -50 \
        || echo "No recent AVC denials found"
fi

echo ""

# 2. Denial counts by domain
echo "--- Denial Count by Source Domain ---"
ausearch -m avc --start recent 2>/dev/null \
    | grep "type=AVC" \
    | grep -oP 'scontext=\S+' \
    | sort | uniq -c | sort -rn \
    || echo "Could not parse denial counts"

echo ""

# 3. Check if domain is in permissive mode
echo "--- Permissive Domains ---"
semanage permissive -l 2>/dev/null || echo "None"

echo ""

# 4. Check setroubleshoot for friendly explanations
echo "--- setroubleshoot Analysis ---"
if systemctl is-active setroubleshootd &>/dev/null; then
    sealert -a /var/log/audit/audit.log 2>/dev/null | head -100
else
    echo "setroubleshootd not running. Start with: systemctl start setroubleshootd"
fi

echo ""

# 5. Boolean settings that might help
echo "--- Relevant Boolean Settings ---"
getsebool -a | grep -E "container|http|network|write" | head -20
```

### Targeted Denial Investigation

```bash
# Find the exact file or socket that triggered the denial
ausearch -m avc --start recent | \
    grep "type=AVC" | \
    grep -oP 'tcontext=\S+|tclass=\S+|name=\S+' | \
    paste - - - | head -20

# Identify the exact syscall that triggered the denial
ausearch -m avc --start recent | \
    ausearch --interpret | \
    grep -A5 "type=SYSCALL" | head -40

# Check if an existing boolean would solve the issue
# Common boolean patterns for containers:
semanage boolean -l | grep -E "container|virt|svirt"

# Example: Allow containers to use cgroup namespaces
setsebool -P container_use_cephfs on
setsebool -P container_manage_cgroup on

# Allow containers to write to NFS mounts
setsebool -P virt_use_nfs on
setsebool -P virt_use_samba on
```

### Writing a Targeted Exception Without audit2allow

```bash
# Rather than using audit2allow blindly, write targeted rules

# Example: Application needs to read /proc/sys/kernel/hostname
# audit2allow would generate:
#   allow my_app_t sysctl_kernel_t:file { read open };
# But the correct approach is to use the existing interface:

# Check available interfaces
man 8 selinux-polgengui || true
grep -r "hostname" /usr/share/selinux/devel/include/ | grep "interface\|kernel_read"

# Use the correct interface in the .te file:
# kernel_read_kernel_sysctls(my_app_t)   <- reads /proc/sys/kernel/*
# kernel_read_net_sysctls(my_app_t)      <- reads /proc/sys/net/*
# kernel_read_vm_sysctls(my_app_t)       <- reads /proc/sys/vm/*

# This is safer than a broad 'allow' because it only allows
# the exact permissions needed for that specific /proc path
```

## Node-Level SELinux Management for Kubernetes

### DaemonSet for SELinux Context Management

```yaml
# selinux-node-setup-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: selinux-node-setup
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: selinux-node-setup
  template:
    metadata:
      labels:
        app: selinux-node-setup
    spec:
      hostPID: true
      hostIPC: false
      hostNetwork: false
      priorityClassName: system-node-critical

      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute

      initContainers:
      - name: selinux-setup
        image: registry.access.redhat.com/ubi9/ubi:latest
        securityContext:
          privileged: true
          seLinuxOptions:
            type: spc_t  # super-privileged container type for setup
        command:
        - /bin/bash
        - -c
        - |
          set -euo pipefail

          # Label storage directories for container access
          for dir in /var/lib/kubelet/pods /var/data /mnt/storage; do
            if [ -d "$dir" ]; then
              chcon -Rt container_file_t "$dir" || true
            fi
          done

          # Ensure SELinux is in enforcing mode
          CURRENT=$(cat /sys/fs/selinux/enforce 2>/dev/null || echo "0")
          if [ "$CURRENT" != "1" ]; then
            echo "WARNING: SELinux is not in enforcing mode (current: $CURRENT)"
          fi

          echo "SELinux node setup complete"
        volumeMounts:
        - name: host-root
          mountPath: /host
        - name: sys-fs-selinux
          mountPath: /sys/fs/selinux

      containers:
      - name: pause
        image: gcr.io/google_containers/pause:3.9
        resources:
          requests:
            cpu: 5m
            memory: 10Mi
          limits:
            cpu: 10m
            memory: 20Mi

      volumes:
      - name: host-root
        hostPath:
          path: /
      - name: sys-fs-selinux
        hostPath:
          path: /sys/fs/selinux
```

### Monitoring SELinux Enforcement with Prometheus

```yaml
# node-exporter-selinux-textfile.yaml
# Run this as a cron job on each node to generate SELinux metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: selinux-metrics-script
  namespace: monitoring
data:
  collect-selinux-metrics.sh: |
    #!/bin/bash
    # Collect SELinux metrics for Prometheus node-exporter textfile collector

    METRICS_FILE="/var/lib/node_exporter/textfile_collector/selinux.prom"

    # SELinux mode: 1=enforcing, 0=permissive, -1=disabled
    MODE=$(cat /sys/fs/selinux/enforce 2>/dev/null || echo "-1")
    echo "selinux_enforce_mode ${MODE}"

    # Count AVC denials in the last minute
    DENIALS=$(ausearch -m avc --start "$(date -d '1 minute ago' '+%m/%d/%Y %H:%M:%S')" 2>/dev/null \
        | grep -c "type=AVC" || echo "0")
    echo "selinux_avc_denials_per_minute ${DENIALS}"

    # Count permissive domains
    PERMISSIVE=$(semanage permissive -l 2>/dev/null | grep -c "^" || echo "0")
    echo "selinux_permissive_domain_count ${PERMISSIVE}"

    # Policy load time
    LOAD_TIME=$(stat -c %Y /sys/fs/selinux/policy 2>/dev/null || echo "0")
    echo "selinux_policy_load_timestamp_seconds ${LOAD_TIME}"

    > "${METRICS_FILE}.tmp"
    {
      echo "# HELP selinux_enforce_mode SELinux enforcement mode (1=enforcing, 0=permissive)"
      echo "# TYPE selinux_enforce_mode gauge"
      echo "selinux_enforce_mode ${MODE}"
      echo "# HELP selinux_avc_denials_per_minute AVC denial count in the last minute"
      echo "# TYPE selinux_avc_denials_per_minute counter"
      echo "selinux_avc_denials_per_minute ${DENIALS}"
      echo "# HELP selinux_permissive_domain_count Number of domains in permissive mode"
      echo "# TYPE selinux_permissive_domain_count gauge"
      echo "selinux_permissive_domain_count ${PERMISSIVE}"
    } > "${METRICS_FILE}.tmp"
    mv "${METRICS_FILE}.tmp" "${METRICS_FILE}"
```

## Production Hardening Checklist

```bash
#!/bin/bash
# selinux-kubernetes-audit.sh
# Audit SELinux configuration for Kubernetes nodes

echo "=== SELinux Kubernetes Production Audit ==="

# 1. Verify enforcing mode
echo -n "[CHECK] SELinux mode: "
MODE=$(getenforce)
if [ "$MODE" = "Enforcing" ]; then
    echo "PASS ($MODE)"
else
    echo "FAIL ($MODE) - must be Enforcing"
fi

# 2. Verify container-selinux is installed
echo -n "[CHECK] container-selinux package: "
rpm -q container-selinux &>/dev/null && echo "PASS" || echo "FAIL - install container-selinux"

# 3. Check for dangerous unconfined_t pods
echo -n "[CHECK] Pods running as unconfined_t: "
UNCONFINED=$(ps -eZ | grep unconfined_t | grep -v "ps\|grep\|bash\|sshd" | wc -l)
if [ "$UNCONFINED" -eq 0 ]; then
    echo "PASS"
else
    echo "WARNING - $UNCONFINED unconfined processes"
    ps -eZ | grep unconfined_t | grep -v "ps\|grep\|bash\|sshd" | head -10
fi

# 4. Check for spc_t containers (privileged containers bypass SELinux)
echo -n "[CHECK] spc_t (privileged) containers: "
SPC=$(ps -eZ | grep spc_t | wc -l)
if [ "$SPC" -eq 0 ]; then
    echo "PASS"
else
    echo "WARNING - $SPC privileged containers"
    ps -eZ | grep spc_t | head -10
fi

# 5. Check for permissive domains
echo -n "[CHECK] Permissive domains: "
PERMISSIVE=$(semanage permissive -l 2>/dev/null | grep -v "^$" | wc -l)
if [ "$PERMISSIVE" -eq 0 ]; then
    echo "PASS"
else
    echo "WARNING - $PERMISSIVE domains in permissive mode:"
    semanage permissive -l
fi

# 6. Recent AVC denials
echo -n "[CHECK] AVC denials in last hour: "
RECENT_DENIALS=$(ausearch -m avc --start "1 hour ago" 2>/dev/null | grep -c "type=AVC" || echo 0)
echo "$RECENT_DENIALS denials"

echo ""
echo "=== Audit Complete ==="
```

SELinux enforcing mode on Kubernetes nodes is not merely a compliance checkbox — it is a genuine defense-in-depth layer that has prevented real container escape exploits in production. The investment in policy development pays dividends each time a vulnerability in a container runtime, kernel, or application is exploited but stopped by the SELinux policy boundary.
