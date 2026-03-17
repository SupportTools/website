---
title: "Linux Kernel Live Patching: kpatch and livepatch for Zero-Downtime Security Updates"
date: 2031-04-25T00:00:00-05:00
draft: false
tags: ["Linux", "Security", "Kernel", "kpatch", "Live Patching", "RHEL", "Ubuntu"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete enterprise guide to Linux kernel live patching: livepatch framework mechanics, kpatch-build workflow, patch lifecycle management, consistency model, RHEL Live Patching and Ubuntu Livepatch integration, and automating live patching in enterprise patch management pipelines."
more_link: "yes"
url: "/linux-kernel-live-patching-kpatch-livepatch-zero-downtime-security/"
---

Kernel vulnerabilities require kernel updates, and kernel updates require reboots. In environments with strict uptime requirements — financial trading systems, telecom infrastructure, real-time data pipelines — even a coordinated maintenance window carries risk. Kernel live patching addresses this by applying security fixes to the running kernel in memory, deferring the reboot to the next planned maintenance window while eliminating the exposure window between CVE disclosure and patch deployment.

This guide covers the Linux kernel livepatch subsystem's design, the kpatch-build toolchain for creating patches, the active/replaced/disabled patch lifecycle, the kernel consistency model that makes live patching safe, enterprise live patch sources for RHEL and Ubuntu, and the automation patterns that integrate live patching into production patch management.

<!--more-->

# Linux Kernel Live Patching: kpatch and livepatch for Zero-Downtime Security Updates

## Section 1: The Linux Livepatch Framework

### How Kernel Live Patching Works

The Linux kernel livepatch framework (merged in kernel 4.0) uses `ftrace` function tracing infrastructure to redirect function calls from vulnerable kernel functions to patched replacements:

1. The live patch is loaded as a kernel module (`.ko` file).
2. The module registers a set of function patches with the livepatch subsystem.
3. The livepatch framework uses `ftrace` to add hooks at the start of each patched function.
4. When the kernel calls the patched function, `ftrace` redirects execution to the new (patched) implementation.
5. The old function's code remains in memory but is no longer executed for processes in the patched state.

### The Consistency Model

Simply replacing function pointers is not safe — if a thread is executing inside the vulnerable function when the patch is applied, it will return to old code after the patch hook is installed. The kernel uses a **consistency model** to ensure safety:

**Kpatch-compatible / per-process consistency**: Each process transitions to the patched state independently. The patching system tracks which processes have passed through "safe points" (function entries and returns) in the patched functions. A process is considered "patched" once it has not been executing any of the patched functions.

The consistency model goes through phases:
- `KLP_UNPATCHED` — system is running on original code
- `KLP_TRANSITION` — patch is loaded; processes are transitioning
- `KLP_PATCHED` — all processes have transitioned to patched code

During the transition phase, new processes and threads start in the patched state. Existing threads transition when they are not in any of the patched call stacks. The `transition` file in sysfs shows progress:

```bash
# Check transition status
cat /sys/kernel/livepatch/<patch-name>/transition

# 0 = not in transition, 1 = transition in progress
# forced = transition was forced
```

### Why Transition Can Get Stuck

A live patch transition can be permanently stuck if a thread is blocked (sleeping) inside a patched function or call chain. The most common cause:

```bash
# Find threads blocking the transition
cat /proc/<pid>/stack

# Look for threads with frames in patched functions
```

## Section 2: kpatch — The Build Toolchain

`kpatch` is a set of tools that automates the process of building a live patch kernel module from a source patch (`.patch` file).

### Installing kpatch-build

```bash
# On RHEL/CentOS/Rocky Linux
dnf install -y kpatch-build

# Install dependencies
dnf install -y kernel-devel kernel-debug-devel \
    rpm-build patchutils \
    elfutils-libelf-devel \
    pesign openssl-devel \
    bison flex libdw-devel

# On Ubuntu
apt-get install -y kpatch-build

# Install dependencies
apt-get install -y linux-headers-$(uname -r) \
    linux-source-$(uname -r) \
    dpkg-dev fakeroot \
    libelf-dev libssl-dev \
    bison flex
```

### The kpatch-build Workflow

kpatch-build compares the compiled output of the original and patched kernel source to identify which object files changed, then packages those changed functions into a kernel module:

```bash
#!/bin/bash
# build-livepatch.sh
set -euo pipefail

KERNEL_VERSION=$(uname -r)
PATCH_FILE="$1"
OUTPUT_NAME="${2:-livepatch-$(basename "${PATCH_FILE}" .patch)}"

echo "Building live patch for kernel: ${KERNEL_VERSION}"
echo "Patch file: ${PATCH_FILE}"
echo "Output name: ${OUTPUT_NAME}"

# Build the kernel module
kpatch-build \
    --name "${OUTPUT_NAME}" \
    --kernel "${KERNEL_VERSION}" \
    --skip-cleanup \
    "${PATCH_FILE}"

# Output: livepatch-<name>.ko in the current directory
ls -la "${OUTPUT_NAME}.ko"

# Get information about the generated module
modinfo "${OUTPUT_NAME}.ko"

echo "Build successful: ${OUTPUT_NAME}.ko"
```

### Example: Building a Patch for a CVE

```bash
# Scenario: CVE-2031-XXXX — a buffer overflow in the nf_tables module
# A minimal patch has been prepared

cat > cve-2031-xxxx-nftables.patch << 'EOF'
diff --git a/net/netfilter/nf_tables_api.c b/net/netfilter/nf_tables_api.c
index abc123..def456 100644
--- a/net/netfilter/nf_tables_api.c
+++ b/net/netfilter/nf_tables_api.c
@@ -1234,6 +1234,12 @@ static int nft_add_set_elem(struct nft_ctx *ctx, struct nft_set *set,

        nft_set_ext_prepare(&tmpl);

+       /* CVE-2031-XXXX: Validate element length before allocation
+        * to prevent integer overflow in size calculation */
+       if (elem.key.val.len > NFT_DATA_VALUE_MAXLEN) {
+               return -EINVAL;
+       }
+
        err = nft_setelem_parse_flags(set, nla[NFTA_SET_ELEM_FLAGS], &flags);
        if (err < 0)
                return err;
EOF

# Build the live patch module
kpatch-build \
    --name "kpatch-cve-2031-xxxx" \
    --kernel "$(uname -r)" \
    cve-2031-xxxx-nftables.patch

# Verify the module
file kpatch-cve-2031-xxxx.ko
modinfo kpatch-cve-2031-xxxx.ko | grep -E "name|depends|livepatch|srcversion"
```

### Build Failures and Diagnostics

kpatch-build builds the kernel twice (original and patched) and compares the results. Common failures:

```bash
# Build failed: "ERROR: kpatch-build: gcc exited with status 1"
# Check the build log
cat /tmp/kpatch/*/build.log | tail -50

# "ERROR: no changed objects found"
# The patch did not compile to different object code
# May indicate the change is in a header file (affects many objects)
# or the compiler optimized out the change

# "ERROR: multiple entries for function X"
# The patched function appears in multiple translation units
# Need to be more specific in the patch

# Check which functions are being patched
objdump -d kpatch-cve-2031-xxxx.ko | grep "<klp_"
```

## Section 3: Loading and Managing Live Patches

### Loading a Live Patch Module

```bash
# Load the live patch module
insmod kpatch-cve-2031-xxxx.ko

# Or with modprobe (if installed in /lib/modules/)
cp kpatch-cve-2031-xxxx.ko /lib/modules/$(uname -r)/extra/
depmod -a
modprobe kpatch-cve-2031-xxxx

# Verify it is loaded
lsmod | grep kpatch
cat /sys/kernel/livepatch/kpatch-cve-2031-xxxx/enabled
```

### Monitoring the Transition

```bash
# Check if the patch is transitioning
watch -n 1 cat /sys/kernel/livepatch/kpatch-cve-2031-xxxx/transition

# List all patched functions
ls /sys/kernel/livepatch/kpatch-cve-2031-xxxx/

# Check per-object patch status
cat /sys/kernel/livepatch/kpatch-cve-2031-xxxx/vmlinux/patched

# List all tasks and their patch states
cat /proc/*/status | grep -E "^(Name|Pid|KlpState):" | \
    paste - - - | grep "KlpState:" | grep -v "patched"
```

### Forcing a Stuck Transition

If the transition does not complete within a reasonable time (usually minutes), force it:

```bash
# Check who is blocking the transition
cat /sys/kernel/debug/livepatch/kpatch-cve-2031-xxxx/stack_tracer_enabled

# Enable stack tracing to identify blocking tasks
echo 1 > /sys/kernel/debug/livepatch/kpatch-cve-2031-xxxx/stack_tracer_enabled

# Review the kernel log
dmesg | grep -i "livepatch\|klp" | tail -20

# Force the transition (patches all tasks immediately — may cause brief hang)
echo 1 > /sys/kernel/livepatch/kpatch-cve-2031-xxxx/force

# Verify completion
cat /sys/kernel/livepatch/kpatch-cve-2031-xxxx/transition
# Expected: 0 (not in transition)
```

### Patch Lifecycle: Active, Replaced, Disabled

```bash
# ACTIVE — the current patch
cat /sys/kernel/livepatch/kpatch-cve-2031-xxxx/enabled
# Output: 1

# REPLACED — when a newer patch supersedes this one
# Install a cumulative patch (includes all previous patches)
insmod kpatch-cve-2031-cumulative.ko
# The cumulative patch replaces the individual patches
cat /sys/kernel/livepatch/kpatch-cve-2031-xxxx/enabled
# Output: 0 (replaced by cumulative)

# DISABLED — manually disabling a patch
echo 0 > /sys/kernel/livepatch/kpatch-cve-2031-xxxx/enabled

# REMOVING — unloading a patch (only possible when disabled)
rmmod kpatch-cve-2031-xxxx
```

### Listing All Active Patches

```bash
# List all loaded live patches
ls /sys/kernel/livepatch/

# Show detailed status
for patch in /sys/kernel/livepatch/*/; do
    name=$(basename "${patch}")
    enabled=$(cat "${patch}enabled")
    transition=$(cat "${patch}transition")
    echo "${name}: enabled=${enabled} transition=${transition}"
done

# Using kpatch command (if kpatch package is installed)
kpatch list
```

## Section 4: Enterprise Live Patch Providers

### RHEL Live Patching with kpatch Service

Red Hat provides pre-built kernel live patches through the RHEL subscription. These are applied and managed by the `kpatch` service:

```bash
# Install the kpatch service package
dnf install -y kpatch

# Enable and start the kpatch service
systemctl enable --now kpatch

# The kpatch service loads patches from /usr/lib/kpatch/<kernel-version>/
ls /usr/lib/kpatch/$(uname -r)/

# Install kernel live patches from Red Hat CDN
dnf install -y "kpatch-patch-$(uname -r | sed 's/\./-/g')"

# List installed live patches
kpatch list

# Load all installed patches
kpatch load --all

# Check loaded patches
kpatch status
```

### RHEL Kernel Live Patching via Subscription Manager

```bash
# Enable the RHEL Live Patching repository
subscription-manager repos --enable rhel-8-for-x86_64-baseos-rpms

# Check available live patches for the current kernel
dnf search kpatch-patch

# Install the latest available patch
dnf install -y "kpatch-patch-$(uname -r | tr - . | sed 's/\.el.*//' | tr . -)"

# Verify the patch is applied
kpatch list

# Expected output:
# Loaded patch modules:
# kpatch-patch-5_14_0-427_13_1 [enabled]
#
# Installed patch modules:
# kpatch-patch-5_14_0-427_13_1 (5.14.0-427.13.1.el9_4)
```

### Ubuntu Livepatch with Canonical

Ubuntu uses the Canonical Livepatch Service for kernel live patching. It requires an Ubuntu Pro subscription (free for up to 5 machines):

```bash
# Install the Canonical Livepatch client
snap install canonical-livepatch

# Enable Livepatch with your Ubuntu Pro token
canonical-livepatch enable <your-ubuntu-pro-token>

# Check status
canonical-livepatch status

# Detailed status
canonical-livepatch status --verbose

# Expected output:
# kernel: 5.15.0-100-generic
# fully-patched: true
# version: "94.1"
# fixes: |-
#   * CVE-2031-XXXX (medium)
#   * CVE-2031-YYYY (high)
# running: true
# authenticated: true
# enabled: true
# patchState: applied
# checkState: checked
# subscriptionEntitlement: true
```

### Ubuntu Pro with MaaS/Juju/Ansible Integration

```bash
# Enable Livepatch on multiple machines via cloud-init
cat > /etc/cloud/cloud.cfg.d/99-livepatch.cfg << 'EOF'
packages:
  - snapd

runcmd:
  - snap install canonical-livepatch
  - canonical-livepatch enable <your-ubuntu-pro-token>
EOF

# Ansible playbook for Ubuntu Livepatch deployment
```

```yaml
# ubuntu-livepatch.yml
---
- name: Enable Ubuntu Kernel Livepatch
  hosts: ubuntu_hosts
  become: true
  vars:
    ubuntu_pro_token: "{{ vault_ubuntu_pro_token }}"
  tasks:
  - name: Install snapd
    package:
      name: snapd
      state: present

  - name: Install canonical-livepatch snap
    snap:
      name: canonical-livepatch
      state: present

  - name: Enable Livepatch
    command: canonical-livepatch enable {{ ubuntu_pro_token }}
    register: livepatch_enable
    changed_when: livepatch_enable.rc == 0
    failed_when: livepatch_enable.rc != 0 and 'already enabled' not in livepatch_enable.stderr

  - name: Check Livepatch status
    command: canonical-livepatch status
    register: livepatch_status
    changed_when: false

  - name: Display Livepatch status
    debug:
      msg: "{{ livepatch_status.stdout_lines }}"

  - name: Assert fully patched
    assert:
      that:
        - "'fully-patched: true' in livepatch_status.stdout"
      fail_msg: "Host is not fully patched. Review livepatch status."
```

## Section 5: RHEL Ansible Automation for Live Patching

```yaml
# rhel-live-patching.yml
---
- name: Apply RHEL Kernel Live Patches
  hosts: rhel_hosts
  become: true
  vars:
    patching_window_minutes: 30
  tasks:
  - name: Gather kernel version facts
    set_fact:
      current_kernel: "{{ ansible_kernel }}"

  - name: Check kpatch service status
    systemd:
      name: kpatch
    register: kpatch_service

  - name: Install kpatch if not present
    package:
      name: kpatch
      state: present
    when: kpatch_service.status is undefined

  - name: Enable kpatch service
    systemd:
      name: kpatch
      enabled: true
      state: started

  - name: Find available live patches for current kernel
    shell: |
      dnf list available "kpatch-patch-*" 2>/dev/null | \
        grep "$(uname -r | tr '-' '.')" | \
        awk '{print $1}' | \
        head -1
    register: available_patch
    changed_when: false

  - name: Display available patch
    debug:
      msg: "Available live patch: {{ available_patch.stdout | default('none') }}"

  - name: Install kernel live patch
    package:
      name: "{{ available_patch.stdout }}"
      state: present
    when:
      - available_patch.stdout != ""
      - available_patch.stdout is defined
    register: patch_install

  - name: Load all installed patches
    command: kpatch load --all
    when: patch_install.changed
    register: kpatch_load

  - name: Verify patches are loaded
    command: kpatch list
    register: kpatch_list
    changed_when: false

  - name: Display patch status
    debug:
      msg: "{{ kpatch_list.stdout_lines }}"

  - name: Check for stuck transitions
    shell: |
      for patch in /sys/kernel/livepatch/*/; do
        transition=$(cat "${patch}transition" 2>/dev/null)
        if [ "${transition}" = "1" ]; then
          echo "STUCK: ${patch}"
        fi
      done
    register: stuck_transitions
    changed_when: false

  - name: Alert on stuck transitions
    debug:
      msg: "WARNING: Live patch transition stuck for {{ stuck_transitions.stdout }}"
    when: stuck_transitions.stdout != ""

  - name: Record patch status in inventory
    set_fact:
      live_patch_status:
        kernel: "{{ ansible_kernel }}"
        patch: "{{ available_patch.stdout | default('none') }}"
        applied: "{{ patch_install.changed | default(false) }}"
        loaded: "{{ kpatch_list.stdout }}"
        timestamp: "{{ ansible_date_time.iso8601 }}"
```

## Section 6: Integrating Live Patching into Patch Management

### Patch Management Policy with Live Patching

```
Traditional patching policy:
1. CVE disclosed → 2. Patch available → 3. Test in staging → 4. Schedule maintenance window → 5. Reboot

With live patching:
1. CVE disclosed → 2. Live patch available → 3. Apply live patch immediately (no downtime)
   [Optional later: 4. Schedule kernel update → 5. Reboot at next maintenance window]
```

### Compliance Scanning with Live Patches

```bash
#!/bin/bash
# compliance-check.sh — Check if all required CVEs are addressed

# List of CVEs that must be mitigated
REQUIRED_CVES=(
    "CVE-2031-XXXX"
    "CVE-2031-YYYY"
    "CVE-2031-ZZZZ"
)

echo "=== Kernel Live Patch Compliance Check ==="
echo "Host: $(hostname)"
echo "Kernel: $(uname -r)"
echo "Date: $(date)"
echo ""

# Check kpatch-applied patches
LOADED_PATCHES=$(kpatch list 2>/dev/null | grep "enabled" | awk '{print $1}')

echo "Loaded patches:"
kpatch list 2>/dev/null || echo "kpatch not available"
echo ""

# Check Canonical Livepatch (Ubuntu)
if command -v canonical-livepatch &>/dev/null; then
    echo "Canonical Livepatch status:"
    canonical-livepatch status 2>/dev/null
    echo ""
fi

# Check RHEL Advisory info
if command -v rpm &>/dev/null; then
    echo "Installed security advisories (last 30 days):"
    rpm -qa --queryformat "%{INSTALLTIME:date} %{NAME}\n" | \
        grep -E "kpatch|livepatch" | sort -r | head -10
fi

# Compare against required CVEs
echo "=== CVE Coverage Check ==="
for cve in "${REQUIRED_CVES[@]}"; do
    # Check if the CVE is mentioned in any loaded patch description
    if kpatch list 2>/dev/null | grep -qi "${cve}"; then
        echo "PASS: ${cve} — covered by live patch"
    elif rpm -qa --changelog 2>/dev/null | grep -qi "${cve}"; then
        echo "PASS: ${cve} — covered by kernel update"
    else
        echo "FAIL: ${cve} — not yet mitigated"
    fi
done
```

### Prometheus Monitoring for Live Patch Status

```bash
#!/bin/bash
# live-patch-exporter.sh — Emit Prometheus metrics for live patch status

METRICS_FILE="/var/lib/node-exporter/textfile/live-patch.prom"

{
    echo "# HELP node_livepatch_enabled Whether kernel live patching is active"
    echo "# TYPE node_livepatch_enabled gauge"

    # Count loaded patches
    PATCH_COUNT=$(ls /sys/kernel/livepatch/ 2>/dev/null | wc -l)
    echo "node_livepatch_patch_count ${PATCH_COUNT}"

    # Check for stuck transitions
    STUCK=0
    for patch in /sys/kernel/livepatch/*/; do
        transition=$(cat "${patch}transition" 2>/dev/null || echo "0")
        enabled=$(cat "${patch}enabled" 2>/dev/null || echo "0")
        name=$(basename "${patch}")

        echo "node_livepatch_patch_enabled{patch=\"${name}\"} ${enabled}"
        echo "node_livepatch_patch_transition{patch=\"${name}\"} ${transition}"

        [ "${transition}" = "1" ] && STUCK=$((STUCK + 1))
    done

    echo "node_livepatch_stuck_transitions ${STUCK}"

    # Canonical Livepatch status
    if command -v canonical-livepatch &>/dev/null; then
        if canonical-livepatch status 2>/dev/null | grep -q "fully-patched: true"; then
            echo "node_livepatch_canonical_fully_patched 1"
        else
            echo "node_livepatch_canonical_fully_patched 0"
        fi
    fi

} > "${METRICS_FILE}.tmp"

mv "${METRICS_FILE}.tmp" "${METRICS_FILE}"
```

```yaml
# prometheus-rule-livepatch.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: live-patch-alerts
  namespace: monitoring
spec:
  groups:
  - name: live-patch
    rules:
    - alert: LivePatchTransitionStuck
      expr: node_livepatch_stuck_transitions > 0
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "Live patch transition stuck on {{ $labels.instance }}"
        description: "A kernel live patch has been in transition for more than 30 minutes. A forced transition or reboot may be required."

    - alert: CanonicalLivepatchNotFullyPatched
      expr: node_livepatch_canonical_fully_patched == 0
      for: 2h
      labels:
        severity: warning
      annotations:
        summary: "Ubuntu Livepatch not fully applied on {{ $labels.instance }}"
        description: "Canonical Livepatch has been pending for more than 2 hours. Check the livepatch service."
```

## Section 7: Limitations and Caveats

### What Live Patching Cannot Fix

Live patching is not a universal solution. Certain types of kernel changes cannot be delivered as live patches:

1. **Data structure changes** — If a CVE fix requires changing the size or layout of a kernel struct that is embedded in long-lived kernel objects (e.g., `task_struct`, `inode`), a live patch cannot safely replace the struct layout.

2. **Module initialization code** — Code in `__init` sections runs only once at module load time. Live patches cannot re-execute initialization code.

3. **Interrupt handlers and timer callbacks** — These require careful consistency model handling; not all can be safely patched.

4. **Architecture-specific assembly** — Some platform code cannot be patched through the `ftrace` mechanism.

Vendors (Red Hat, Canonical) carefully evaluate each CVE to determine if it is live-patchable before publishing a live patch.

### Reboot Is Still Required

Live patching reduces the urgency of reboots but does not eliminate them. A reboot is still required to:

- Apply kernel updates that include non-live-patchable fixes.
- Consolidate multiple live patches into a clean kernel state.
- Recover from hardware issues that require a clean boot.
- Apply microcode updates (CPU firmware).

The recommended policy: **live patch immediately to close the CVE window, reboot at the next planned maintenance window to consolidate.**

### Testing Live Patches

```bash
# Test a live patch in a staging environment
# 1. Load the patch on the staging host
insmod /tmp/kpatch-test.ko

# 2. Verify transition completes
timeout 120 bash -c '
    while [ "$(cat /sys/kernel/livepatch/kpatch-test/transition)" = "1" ]; do
        sleep 5
    done
    echo "Transition complete"
'

# 3. Run the regression test suite
./run-kernel-tests.sh --suite=network --suite=security

# 4. Validate the CVE is mitigated
./cve-validation-tests.sh CVE-2031-XXXX

# 5. Check for new kernel warnings/oops
dmesg | grep -E "BUG|WARN|Oops|call trace" | wc -l
```

Kernel live patching is a powerful tool for security response but requires discipline: patches should be sourced from trusted vendors (Red Hat, Canonical), the consistency model must be monitored for stuck transitions, and reboots should still be scheduled to consolidate patches at regular maintenance intervals. Used correctly, live patching is the difference between "we were exposed to this critical vulnerability for six weeks while waiting for a maintenance window" and "we patched it within hours of vendor availability."
