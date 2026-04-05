---
title: "Linux Kernel Live Patching: kpatch, kGraft, and Livepatch for Zero-Downtime Security Updates"
date: 2032-03-14T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Live Patching", "kpatch", "Security", "CVE", "Zero-Downtime"]
categories:
- Linux
- Security
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Linux kernel live patching using kpatch, kGraft, and Canonical Livepatch—covering patch creation, consistency model, module lifecycle, and production deployment workflows."
more_link: "yes"
url: "/linux-kernel-live-patching-kpatch-kgraft-livepatch-zero-downtime/"
---

Every time a critical kernel CVE lands—think Dirty Pipe, Spectre variants, or the nf_tables privilege-escalation chain—operations teams face an uncomfortable choice: reboot hundreds of production nodes immediately and accept service disruption, or delay patching and accept security exposure. Linux kernel live patching eliminates that dilemma. kpatch, kGraft, and Canonical Livepatch all let administrators apply security-critical kernel fixes to running systems without a reboot, keeping workloads alive while closing vulnerability windows.

This guide covers the architecture of each solution, the kernel consistency model that makes live patching safe, how to build and validate patches from upstream CVE fixes, and the operational workflows required to manage live patches at enterprise scale across bare-metal, VM, and container-host fleets.

<!--more-->

## Why Kernel Live Patching Matters at Enterprise Scale

A typical production Kubernetes cluster might run 200 to 2,000 nodes. A forced rolling reboot to apply a kernel CVE fix requires draining nodes, migrating pods, waiting for node readiness, and repeating across every node in the fleet. On a well-tuned cluster that process might take 20 minutes per node—meaning days of continuous change-window work for a large fleet. During that window, unpatched nodes remain vulnerable.

Live patching compresses the vulnerability window from days to minutes. Once a live patch is loaded, all subsequent kernel function calls hit the patched code path. No reboot. No drain. No migration.

The trade-offs are real: live patches are not a permanent replacement for rebooting. They address specific CVEs in specific functions. Reboot-based patch cycles remain necessary for cumulative updates, microcode updates, and patches that modify data structures already in use. Live patching buys time and reduces urgency without eliminating the maintenance reboot entirely.

## Kernel Live Patching Architecture

### The Kernel Live Patching Subsystem

Linux kernels 4.0 and later include a unified live patching infrastructure under `CONFIG_LIVEPATCH`. All three major userspace frameworks—kpatch, kGraft, and Livepatch—use this subsystem.

The subsystem works by replacing the function pointer in the kernel's function redirect table (ftrace infrastructure). When a live patch module loads:

1. The module registers its replacement functions with the `klp_patch` structure.
2. The subsystem uses ftrace to redirect calls from the old function to the new one.
3. A consistency model ensures no CPU is executing inside the old function when the redirect activates.

```
Kernel Virtual Address Space
─────────────────────────────────────────────────────────
  Old function (vmlinux):     nf_tables_newrule()
    ├── ftrace trampoline ──────────────────────────────┐
    │                                                    │
  Live patch module:          klp_nf_tables_newrule()   │
    └──────────────────────────────────────────────────←┘
         ↑ activated after consistency check passes
```

### Consistency Models

The most critical design decision in live patching is the consistency model—the mechanism that guarantees no CPU is in the middle of executing the old function when the patch activates.

**Stop-machine model (early approach):** All CPUs stop simultaneously, patches apply, CPUs resume. Causes latency spikes. Not used in production-grade implementations.

**Per-task consistency model (current standard):** Each task is individually transitioned from old to new code. A task is eligible for transition when it is not currently executing any of the patched functions on its stack. The subsystem checks task stacks iteratively until all tasks have been transitioned.

```
Task state machine during live patch activation:
─────────────────────────────────────────────
  UNPATCHED ──→ (stack check) ──→ PATCHED
                     │
                     └─→ (patched function on stack) ──→ wait, retry
```

This means patch activation can take seconds to minutes in systems with long-running syscalls or kernel threads. The `/sys/kernel/livepatch/<patch>/transition` file shows activation progress.

### Module Structure

A live patch is a kernel module (`.ko`) with a special structure:

```c
// Simplified live patch module structure
#include <linux/kernel.h>
#include <linux/module.h>
#include <linux/livepatch.h>

// Replacement function
static int patched_vulnerable_function(struct sock *sk, int optname,
                                        char __user *optval, int optlen)
{
    // Fixed implementation
    if (optlen < 0)
        return -EINVAL;
    // ... rest of corrected logic
    return 0;
}

// Patch descriptor
static struct klp_func funcs[] = {
    {
        .old_name = "vulnerable_function",
        .new_func = patched_vulnerable_function,
    }, {}
};

static struct klp_object objs[] = {
    {
        /* name is NULL for vmlinux */
        .funcs = funcs,
    }, {}
};

static struct klp_patch patch = {
    .mod = THIS_MODULE,
    .objs = objs,
};

static int __init livepatch_init(void)
{
    return klp_enable_patch(&patch);
}

static void __exit livepatch_exit(void)
{
    /* klp_disable_patch handled automatically on module unload */
}

module_init(livepatch_init);
module_exit(livepatch_exit);
MODULE_LICENSE("GPL");
MODULE_INFO(livepatch, "Y");
```

## kpatch: Red Hat's Live Patching Framework

### Architecture Overview

kpatch, developed by Red Hat, provides tooling to automatically generate live patch modules from kernel source patches. The `kpatch-build` tool takes a unified diff (`.patch` file) and produces a compiled `.ko` module.

```
kpatch workflow:
─────────────────────────────────────────────────────────
  CVE patch (.patch file)
        │
        ▼
  kpatch-build
        │
        ├── Compiles original kernel
        ├── Applies patch, recompiles
        ├── Compares object files (changed functions)
        ├── Generates livepatch module source
        └── Compiles livepatch module
        │
        ▼
  livepatch-CVE-XXXX-XXXXX.ko
        │
        ▼
  kpatch load livepatch-CVE-XXXX-XXXXX.ko
```

### Installation

```bash
# RHEL/CentOS/Rocky Linux
dnf install kpatch kpatch-devel

# Ubuntu (kpatch from source)
apt-get install kpatch

# Verify kernel support
grep CONFIG_LIVEPATCH /boot/config-$(uname -r)
# Expected: CONFIG_LIVEPATCH=y

grep CONFIG_FTRACE_MCOUNT_RECORD /boot/config-$(uname -r)
# Expected: CONFIG_FTRACE_MCOUNT_RECORD=y
```

### Building a kpatch Module

The build process requires kernel source and build dependencies matching the running kernel exactly.

```bash
# Install build dependencies (RHEL/CentOS)
dnf install kernel-devel-$(uname -r) \
            kernel-debuginfo-$(uname -r) \
            rpm-build \
            elfutils-libelf-devel \
            gcc \
            make \
            patch

# Clone kpatch
git clone https://github.com/dynup/kpatch.git
cd kpatch
make
sudo make install

# Create a patch file for CVE-2024-XXXXX
# (Example: fixing a hypothetical buffer overflow in net/ipv4/tcp.c)
cat > cve-2024-example.patch << 'EOF'
diff --git a/net/ipv4/tcp.c b/net/ipv4/tcp.c
index abc123..def456 100644
--- a/net/ipv4/tcp.c
+++ b/net/ipv4/tcp.c
@@ -3100,6 +3100,10 @@ static int tcp_setsockopt_example(struct sock *sk, int optname,
                                    char __user *optval, int optlen)
 {
+       if (optlen < sizeof(int) || optlen > MAX_TCP_OPTION_SPACE) {
+               pr_warn_ratelimited("tcp: invalid optlen %d\n", optlen);
+               return -EINVAL;
+       }
        int val;
        if (get_user(val, (int __user *)optval))
                return -EFAULT;
EOF

# Build the live patch module
kpatch-build \
    --sourcedir /usr/src/kernels/$(uname -r) \
    --vmlinux /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
    cve-2024-example.patch

# Output: livepatch-cve-2024-example.ko
ls -lh livepatch-cve-2024-example.ko
```

### Loading and Managing kpatch Modules

```bash
# Load the patch
kpatch load livepatch-cve-2024-example.ko

# Check patch status
kpatch list
# Output:
# Loaded patch modules:
# livepatch-cve-2024-example [enabled]

# Verify via sysfs
ls /sys/kernel/livepatch/
# livepatch_cve_2024_example

cat /sys/kernel/livepatch/livepatch_cve_2024_example/enabled
# 1

# Monitor transition progress
watch -n 1 cat /sys/kernel/livepatch/livepatch_cve_2024_example/transition
# 0 = transition complete, 1 = in progress

# Check which tasks are blocking transition
cat /proc/*/task/*/patch_state 2>/dev/null | sort | uniq -c
# Output shows count of tasks in each patch state

# Enable auto-loading at boot (installs to /var/lib/kpatch/)
kpatch install livepatch-cve-2024-example.ko

# List installed patches
kpatch list
```

### Handling Transition Timeouts

In busy systems, some kernel threads may block patch transition indefinitely. Check and nudge them:

```bash
#!/bin/bash
# check-livepatch-transition.sh
# Identify tasks blocking live patch transition

PATCH_NAME="${1:-}"
if [ -z "$PATCH_NAME" ]; then
    echo "Usage: $0 <patch-name>"
    exit 1
fi

TRANSITION=$(cat /sys/kernel/livepatch/${PATCH_NAME}/transition 2>/dev/null)
if [ "$TRANSITION" = "0" ]; then
    echo "Patch ${PATCH_NAME}: transition complete"
    exit 0
fi

echo "Patch ${PATCH_NAME}: transition in progress"
echo ""
echo "Tasks blocking transition (patch_state = 1 means unpatched):"
for pid_dir in /proc/[0-9]*/task/[0-9]*/; do
    pid=$(echo "$pid_dir" | cut -d/ -f3)
    tid=$(echo "$pid_dir" | cut -d/ -f5)
    state_file="${pid_dir}patch_state"
    if [ -f "$state_file" ]; then
        state=$(cat "$state_file" 2>/dev/null)
        if [ "$state" = "1" ]; then
            comm=$(cat "/proc/${pid}/comm" 2>/dev/null || echo "unknown")
            echo "  PID=${pid} TID=${tid} COMM=${comm} STATE=${state}"
            # Show kernel stack
            cat "/proc/${pid}/task/${tid}/wchan" 2>/dev/null
        fi
    fi
done
```

## kGraft: SUSE's Approach

### Architecture Differences

kGraft, developed by SUSE, uses a different consistency model called "per-process consistency." Rather than waiting for each task to leave patched functions, kGraft uses a lazy migration approach with universe-based tracking.

SUSE merged kGraft concepts with kpatch-style per-function patching in the upstream kernel subsystem. Modern SUSE enterprise systems use the hybrid approach in the unified livepatch subsystem.

```bash
# SUSE Linux Enterprise live patching via zypper
zypper install kernel-livepatch-tools

# Check available live patches
zypper search kernel-livepatch

# Install a specific live patch
zypper install kernel-livepatch-5_14_21_150400_22_1-default-1-150400.1.3

# kGraft-style status check
kgr status
# Output:
# [0] nop
# [1] kernel-livepatch-5_14_21-default (enabled)
#  CVE-2024-XXXXX: fixed
```

### SUSE Kernel Live Patch RPM Structure

```bash
# Inspect a SUSE live patch RPM
rpm -ql kernel-livepatch-5_14_21_150400_22_1-default-1-150400.1.3
# /lib/modules/5.14.21-150400.22.1-default/livepatch/livepatch-5_14_21_150400_22_1-default.ko
# /usr/lib/systemd/system/kernel-livepatch-5_14_21_150400_22_1-default.service

# The service auto-loads the patch at boot
systemctl status kernel-livepatch-5_14_21_150400_22_1-default.service
```

## Canonical Livepatch

### Ubuntu Advantage Integration

Canonical Livepatch is integrated with Ubuntu Pro (formerly Ubuntu Advantage) and provides a managed patch delivery service. Patches are signed and delivered via the Canonical infrastructure.

```bash
# Enable Ubuntu Pro
pro attach <ubuntu-pro-token>

# Enable livepatch
pro enable livepatch

# Check livepatch status
canonical-livepatch status --verbose
# Output:
# last check: 2032-03-14 00:00:00 UTC
# kernel: 5.15.0-91-generic
# server check-in: succeeded
# patch state: applied
# patch version: 95.1
# fixes:
#  CVE-2024-0001: applied
#  CVE-2024-0002: applied
#  CVE-2024-0003: applied (needs-reboot for full effect)

# Force patch check
canonical-livepatch refresh

# Check specific patch details
canonical-livepatch status --format json | jq '.patches[]'
```

### Livepatch Daemon Configuration

```bash
# Livepatch daemon config
cat /etc/default/canonical-livepatch
# LIVEPATCH_ENABLED=1
# LIVEPATCH_CHECK_INTERVAL=1800

# Systemd service
systemctl status canonical-livepatch.service

# Journal logs
journalctl -u canonical-livepatch.service --since "1 hour ago"
```

## Production Deployment Patterns

### Fleet-Wide Live Patch Management with Ansible

```yaml
---
# ansible/playbooks/apply-livepatch.yml
- name: Apply kernel live patches across fleet
  hosts: "{{ target_hosts | default('all') }}"
  gather_facts: true
  become: true
  vars:
    patch_module_path: "/opt/livepatches/livepatch-cve-2024-example.ko"
    patch_name: "livepatch_cve_2024_example"
    transition_timeout_seconds: 300
    transition_check_interval: 10

  tasks:
    - name: Check kernel version compatibility
      assert:
        that:
          - ansible_kernel == "5.15.0-91-generic"
        fail_msg: "Kernel version mismatch: {{ ansible_kernel }}"
        success_msg: "Kernel version matches: {{ ansible_kernel }}"

    - name: Check if patch already loaded
      command: "kpatch list"
      register: kpatch_list
      changed_when: false

    - name: Skip if patch already active
      meta: end_host
      when: patch_name in kpatch_list.stdout

    - name: Copy live patch module
      copy:
        src: "{{ patch_module_path }}"
        dest: "/tmp/{{ patch_module_path | basename }}"
        mode: "0644"

    - name: Load live patch
      command: "kpatch load /tmp/{{ patch_module_path | basename }}"
      register: kpatch_load
      changed_when: true

    - name: Wait for patch transition to complete
      shell: |
        timeout={{ transition_timeout_seconds }}
        interval={{ transition_check_interval }}
        elapsed=0
        while [ $elapsed -lt $timeout ]; do
          state=$(cat /sys/kernel/livepatch/{{ patch_name }}/transition 2>/dev/null || echo "0")
          if [ "$state" = "0" ]; then
            echo "COMPLETE"
            exit 0
          fi
          sleep $interval
          elapsed=$((elapsed + interval))
        done
        echo "TIMEOUT"
        exit 1
      register: transition_result
      failed_when: transition_result.stdout != "COMPLETE"

    - name: Verify patch enabled
      command: "kpatch list"
      register: final_status
      changed_when: false

    - name: Assert patch is enabled
      assert:
        that:
          - patch_name in final_status.stdout
          - "'[enabled]' in final_status.stdout"

    - name: Install patch for persistence across reboots
      command: "kpatch install /tmp/{{ patch_module_path | basename }}"
      when: install_persistent | default(true) | bool

    - name: Record patching event
      lineinfile:
        path: /var/log/livepatch-audit.log
        line: "{{ ansible_date_time.iso8601 }} APPLIED {{ patch_name }} kernel={{ ansible_kernel }} host={{ inventory_hostname }}"
        create: true
```

### Kubernetes DaemonSet for Live Patch Delivery

For Kubernetes environments where node access is controlled, a privileged DaemonSet can deliver and apply live patches:

```yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: livepatch-config
  namespace: kube-system
data:
  patch-name: "livepatch-cve-2024-example"
  kernel-version: "5.15.0-91-generic"
  transition-timeout: "300"
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kernel-livepatch
  namespace: kube-system
  labels:
    app: kernel-livepatch
spec:
  selector:
    matchLabels:
      app: kernel-livepatch
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app: kernel-livepatch
    spec:
      hostPID: true
      hostNetwork: true
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      priorityClassName: system-node-critical
      initContainers:
        - name: apply-livepatch
          image: registry.example.com/kernel-livepatch:cve-2024-example-5.15.0-91
          imagePullPolicy: Always
          securityContext:
            privileged: true
          env:
            - name: KERNEL_VERSION
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              RUNNING_KERNEL=$(uname -r)
              EXPECTED_KERNEL=$(cat /etc/livepatch-config/kernel-version)
              PATCH_NAME=$(cat /etc/livepatch-config/patch-name)
              TIMEOUT=$(cat /etc/livepatch-config/transition-timeout)

              echo "Node: ${NODE_NAME}"
              echo "Running kernel: ${RUNNING_KERNEL}"
              echo "Expected kernel: ${EXPECTED_KERNEL}"

              if [ "${RUNNING_KERNEL}" != "${EXPECTED_KERNEL}" ]; then
                echo "SKIP: kernel version mismatch"
                exit 0
              fi

              # Check if already loaded
              if lsmod | grep -q "${PATCH_NAME//-/_}"; then
                echo "SKIP: patch already loaded"
                exit 0
              fi

              # Load the patch
              insmod /patches/${PATCH_NAME}.ko
              echo "Patch loaded, waiting for transition..."

              # Wait for transition
              elapsed=0
              while [ $elapsed -lt $TIMEOUT ]; do
                state=$(cat /sys/kernel/livepatch/${PATCH_NAME//-/_}/transition 2>/dev/null || echo "0")
                if [ "$state" = "0" ]; then
                  echo "Transition complete after ${elapsed}s"
                  break
                fi
                sleep 10
                elapsed=$((elapsed + 10))
              done

              if [ "$state" != "0" ]; then
                echo "WARNING: transition did not complete within ${TIMEOUT}s"
              fi

              echo "Live patch applied successfully"
          volumeMounts:
            - name: livepatch-config
              mountPath: /etc/livepatch-config
            - name: sys
              mountPath: /sys
            - name: lib-modules
              mountPath: /lib/modules
              readOnly: true
      containers:
        - name: monitor
          image: registry.example.com/kernel-livepatch:cve-2024-example-5.15.0-91
          command:
            - /bin/bash
            - -c
            - |
              PATCH_NAME=$(cat /etc/livepatch-config/patch-name)
              while true; do
                enabled=$(cat /sys/kernel/livepatch/${PATCH_NAME//-/_}/enabled 2>/dev/null || echo "0")
                transition=$(cat /sys/kernel/livepatch/${PATCH_NAME//-/_}/transition 2>/dev/null || echo "0")
                echo "patch_enabled=${enabled} transition=${transition}"
                sleep 60
              done
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
          volumeMounts:
            - name: livepatch-config
              mountPath: /etc/livepatch-config
              readOnly: true
            - name: sys
              mountPath: /sys
              readOnly: true
      volumes:
        - name: livepatch-config
          configMap:
            name: livepatch-config
        - name: sys
          hostPath:
            path: /sys
        - name: lib-modules
          hostPath:
            path: /lib/modules
```

## Validating Live Patches

### Pre-Application Testing

```bash
#!/bin/bash
# validate-livepatch.sh
# Validates a live patch module before loading in production

set -euo pipefail

PATCH_MODULE="${1:?Usage: $0 <patch.ko>}"
PATCH_NAME=$(modinfo "$PATCH_MODULE" | grep "^name:" | awk '{print $2}')
RUNNING_KERNEL=$(uname -r)

echo "=== Live Patch Validation ==="
echo "Module: $PATCH_MODULE"
echo "Patch name: $PATCH_NAME"
echo "Running kernel: $RUNNING_KERNEL"
echo ""

# 1. Verify module signature
echo "[1] Checking module signature..."
modinfo "$PATCH_MODULE" | grep -E "^(sig|signer|sig_key|sig_hashalgo):"

# 2. Verify livepatch attribute
echo "[2] Verifying livepatch module attribute..."
if modinfo "$PATCH_MODULE" | grep -q "livepatch.*Y"; then
    echo "    PASS: MODULE_INFO(livepatch, Y) present"
else
    echo "    FAIL: Not a livepatch module"
    exit 1
fi

# 3. Check kernel version compatibility
echo "[3] Checking kernel version compatibility..."
MOD_KERNEL=$(modinfo "$PATCH_MODULE" | grep "^vermagic:" | awk '{print $2}')
if [ "$MOD_KERNEL" = "$RUNNING_KERNEL" ]; then
    echo "    PASS: Kernel version match ($RUNNING_KERNEL)"
else
    echo "    FAIL: Kernel version mismatch (module: $MOD_KERNEL, running: $RUNNING_KERNEL)"
    exit 1
fi

# 4. Check for symbol conflicts
echo "[4] Checking symbol dependencies..."
modprobe --dry-run --verbose "$PATCH_MODULE" 2>&1 | head -20

# 5. Verify patched function exists in vmlinux
echo "[5] Checking patched functions exist in running kernel..."
PATCHED_FUNCS=$(nm "$PATCH_MODULE" 2>/dev/null | grep " klp_" | awk '{print $3}' | sed 's/klp_//')
for func in $PATCHED_FUNCS; do
    if grep -q "^$func$" /proc/kallsyms 2>/dev/null || \
       nm /proc/kcore 2>/dev/null | grep -q " $func$"; then
        echo "    PASS: $func found in kernel"
    else
        echo "    WARN: $func not found in /proc/kallsyms (may still be valid)"
    fi
done

# 6. Test load in non-production kernel (if available)
echo "[6] Dry-run load check..."
insmod --dry-run "$PATCH_MODULE" 2>&1 && echo "    PASS: dry-run succeeded" || echo "    INFO: dry-run not supported, manual testing recommended"

echo ""
echo "=== Validation complete ==="
```

### Post-Application Verification

```bash
#!/bin/bash
# verify-livepatch-applied.sh
# Confirms a live patch is correctly applied and active

PATCH_NAME="${1:?Usage: $0 <patch-name>}"
SYSFS_PATH="/sys/kernel/livepatch/${PATCH_NAME}"

echo "=== Live Patch Status ==="

# Check module loaded
if lsmod | grep -q "^${PATCH_NAME}"; then
    echo "Module: LOADED"
else
    echo "Module: NOT LOADED"
    exit 1
fi

# Check sysfs entries
if [ -d "$SYSFS_PATH" ]; then
    echo "sysfs path: EXISTS ($SYSFS_PATH)"
else
    echo "sysfs path: MISSING"
    exit 1
fi

# Check enabled state
ENABLED=$(cat "${SYSFS_PATH}/enabled")
echo "Enabled: $ENABLED (expected: 1)"

# Check transition state
TRANSITION=$(cat "${SYSFS_PATH}/transition")
echo "Transition: $TRANSITION (expected: 0 = complete)"

# List patched functions
echo ""
echo "Patched objects and functions:"
for obj_dir in "${SYSFS_PATH}"/*/; do
    obj_name=$(basename "$obj_dir")
    echo "  Object: $obj_name"
    for func_dir in "${obj_dir}"*/; do
        func_name=$(basename "$func_dir")
        old_size=$(cat "${func_dir}/old_size" 2>/dev/null || echo "N/A")
        new_size=$(cat "${func_dir}/new_size" 2>/dev/null || echo "N/A")
        echo "    Function: $func_name (old_size=${old_size}, new_size=${new_size})"
    done
done

# CVE verification test (if test script available)
if [ -x "/opt/livepatch-tests/${PATCH_NAME}-test.sh" ]; then
    echo ""
    echo "Running CVE verification test..."
    /opt/livepatch-tests/${PATCH_NAME}-test.sh
fi
```

## Monitoring and Alerting

### Prometheus Metrics for Live Patch State

```yaml
---
# prometheus/rules/livepatch.yml
groups:
  - name: kernel_livepatch
    rules:
      - alert: LivePatchTransitionStuck
        expr: |
          node_livepatch_transition == 1
        for: 10m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: "Live patch transition stuck on {{ $labels.instance }}"
          description: |
            Kernel live patch {{ $labels.patch }} on {{ $labels.instance }}
            has been in transition for over 10 minutes. Some kernel threads
            may be blocking the transition. Check /proc/*/task/*/patch_state.

      - alert: LivePatchNotEnabled
        expr: |
          node_livepatch_enabled == 0 and node_livepatch_loaded == 1
        for: 5m
        labels:
          severity: critical
          team: security
        annotations:
          summary: "Live patch loaded but not enabled on {{ $labels.instance }}"
          description: |
            Kernel live patch {{ $labels.patch }} is loaded but not enabled
            on {{ $labels.instance }}. Security fix may not be active.

      - alert: RequiredLivePatchMissing
        expr: |
          absent(node_livepatch_info{patch=~"livepatch-cve-2024-.*"})
        for: 1h
        labels:
          severity: critical
          team: security
        annotations:
          summary: "Required live patch missing on {{ $labels.instance }}"
          description: |
            Node {{ $labels.instance }} does not have required CVE live patches
            loaded. Immediate patching required.
```

### Custom node_exporter Textfile Collector

```bash
#!/bin/bash
# /opt/monitoring/livepatch-metrics.sh
# Generates Prometheus metrics for live patch state
# Run via cron every 60 seconds, output to node_exporter textfile directory

OUTPUT_DIR="/var/lib/node_exporter/textfile_collector"
OUTPUT_FILE="${OUTPUT_DIR}/livepatch.prom"
TEMP_FILE=$(mktemp)

{
echo "# HELP node_livepatch_enabled Whether the live patch is enabled (1=yes, 0=no)"
echo "# TYPE node_livepatch_enabled gauge"

echo "# HELP node_livepatch_transition Whether patch transition is in progress (1=yes, 0=no)"
echo "# TYPE node_livepatch_transition gauge"

echo "# HELP node_livepatch_loaded Whether the live patch module is loaded (1=yes, 0=no)"
echo "# TYPE node_livepatch_loaded gauge"

for patch_dir in /sys/kernel/livepatch/*/; do
    [ -d "$patch_dir" ] || continue
    patch_name=$(basename "$patch_dir")
    enabled=$(cat "${patch_dir}enabled" 2>/dev/null || echo "0")
    transition=$(cat "${patch_dir}transition" 2>/dev/null || echo "0")
    loaded=1

    labels="patch=\"${patch_name}\""
    echo "node_livepatch_enabled{${labels}} ${enabled}"
    echo "node_livepatch_transition{${labels}} ${transition}"
    echo "node_livepatch_loaded{${labels}} ${loaded}"
done

# Check for patches that should be loaded but aren't
REQUIRED_PATCHES_FILE="/etc/livepatch/required-patches"
if [ -f "$REQUIRED_PATCHES_FILE" ]; then
    while IFS= read -r required_patch; do
        [ -z "$required_patch" ] && continue
        [[ "$required_patch" == "#"* ]] && continue
        patch_dir="/sys/kernel/livepatch/${required_patch}"
        if [ -d "$patch_dir" ]; then
            echo "node_livepatch_required_missing{patch=\"${required_patch}\"} 0"
        else
            echo "node_livepatch_required_missing{patch=\"${required_patch}\"} 1"
        fi
    done < "$REQUIRED_PATCHES_FILE"
fi

} > "$TEMP_FILE"

mv "$TEMP_FILE" "$OUTPUT_FILE"
```

## Operational Runbook

### Applying an Emergency CVE Patch

```bash
# Step 1: Assess impact and identify affected nodes
# Determine which kernel version is affected
AFFECTED_KERNEL="5.15.0-91-generic"
AFFECTED_NODES=$(ansible all -m shell \
    -a "uname -r" \
    --one-line 2>/dev/null | \
    grep "$AFFECTED_KERNEL" | \
    cut -d: -f1)

echo "Affected nodes: $(echo "$AFFECTED_NODES" | wc -l)"

# Step 2: Verify patch module compatibility
# (patch module must have been pre-built for this kernel version)
kpatch-build --target-dir /opt/livepatches cve-2024-example.patch

# Step 3: Apply to canary nodes first (5% of fleet)
CANARY_NODES=$(echo "$AFFECTED_NODES" | shuf | head -n 5)
ansible "$CANARY_NODES" -m command \
    -a "kpatch load /opt/livepatches/livepatch-cve-2024-example.ko" \
    --become

# Step 4: Verify canary application
ansible "$CANARY_NODES" -m command \
    -a "kpatch list" \
    --become

# Step 5: Wait and monitor (15 minutes)
echo "Monitoring canary nodes for 15 minutes..."
sleep 900

# Step 6: Apply to remaining nodes in batches
ansible "$AFFECTED_NODES" \
    -m include_role \
    -a name=apply-livepatch \
    --forks 50 \
    --become

# Step 7: Audit and document
ansible "$AFFECTED_NODES" -m shell \
    -a "kpatch list && uname -r" \
    --become > /var/log/livepatch-audit-cve-2024-example.log
```

### Removing a Live Patch

```bash
# Disable patch (tasks transition back to original code)
echo 0 > /sys/kernel/livepatch/livepatch_cve_2024_example/enabled

# Wait for reverse transition
while [ "$(cat /sys/kernel/livepatch/livepatch_cve_2024_example/transition)" = "1" ]; do
    echo "Waiting for reverse transition..."
    sleep 5
done

# Unload module
rmmod livepatch_cve_2024_example

# Remove from persistent install
kpatch uninstall livepatch-cve-2024-example.ko

# Verify removed
kpatch list
```

## Security Considerations

### Module Signing

Production environments must enforce kernel module signing. Live patch modules must be signed with the same key used to sign other kernel modules.

```bash
# Sign a live patch module
openssl req -new -nodes -utf8 -sha256 -days 36500 \
    -batch -x509 \
    -config x509.genkey \
    -outform PEM \
    -out signing_key.pem \
    -keyout signing_key.pem

# Sign the module
/usr/src/linux-headers-$(uname -r)/scripts/sign-file \
    sha256 \
    signing_key.pem \
    signing_key.pem \
    livepatch-cve-2024-example.ko

# Verify signature
modinfo livepatch-cve-2024-example.ko | grep -E "^sig"
```

### SecureBoot Compatibility

When SecureBoot is enabled, only modules signed with trusted keys can load. Enroll the signing key in the MOK (Machine Owner Key) database:

```bash
# Import signing key certificate into MOK
mokutil --import signing_key_cert.pem

# Reboot and enroll in UEFI MOK manager
# After reboot, verify enrollment
mokutil --list-enrolled | grep -A 5 "Your Organization"

# Verify module can load under SecureBoot
dmesg | grep -i "module.*livepatch" | grep -v "FAILED"
```

## Conclusion

Kernel live patching is an essential capability for enterprise Linux fleet management. kpatch, kGraft/SUSE Livepatch, and Canonical Livepatch each provide production-grade implementations of the unified kernel livepatch subsystem. The key operational principles are:

- Build and sign patches ahead of CVE disclosure with pre-built modules for all supported kernel versions.
- Use canary deployment before fleet-wide rollout.
- Monitor transition state and alert on stuck transitions.
- Maintain an audit log of applied patches per node.
- Schedule reboot-based cumulative updates quarterly regardless of live patch coverage.

Live patching does not replace the kernel patch cycle—it compresses the vulnerability window between CVE disclosure and the scheduled maintenance reboot, which is precisely the window attackers target.
