---
title: "Linux Kernel Live Patching: kpatch and livepatch"
date: 2029-06-06T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Live Patching", "kpatch", "Security", "RHEL", "Ubuntu", "Uptime"]
categories: ["Linux", "Security"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kernel live patching covering the livepatch architecture, kpatch-build workflow, patch application without reboot, consistency model and limitations, and enterprise use cases for RHEL and Ubuntu with Canonical Livepatch and Red Hat KPatch."
more_link: "yes"
url: "/linux-kernel-live-patching-kpatch-livepatch/"
---

Critical kernel vulnerabilities — CVE-class privilege escalation flaws, use-after-free in networking code, local denial-of-service — demand immediate remediation. In a typical patching workflow, kernel updates require a reboot, and rebooting production systems involves coordination, maintenance windows, and service disruption. Linux kernel live patching solves this problem: a kernel security patch can be applied to the running kernel without interrupting processes, network connections, or system state. This guide covers the kernel livepatch infrastructure, the kpatch toolchain for building patches, consistency model semantics, and enterprise service options from Red Hat and Canonical.

<!--more-->

# Linux Kernel Live Patching: kpatch and livepatch

## Architecture Overview

Linux kernel live patching was merged into the mainline kernel in version 4.0 (2015). It combines two kernel mechanisms:

1. **ftrace**: The kernel function tracing infrastructure. Live patching hooks into ftrace to redirect calls to patched functions.
2. **kprobes**: The kernel probe mechanism used to safely install trampolines at function entry points.

The live patching infrastructure lives in `kernel/livepatch/`. The key operations:

1. A patch module (a `.ko` kernel module) is loaded containing the replacement function(s)
2. The livepatch framework registers the patch with the kernel's livepatch subsystem
3. ftrace installs a trampoline at the entry point of the original function
4. New calls to the original function are redirected to the patched version
5. The transition from old to new code is governed by the consistency model

### The Consistency Model

The most critical — and most misunderstood — aspect of live patching is the consistency model. Simply redirecting new calls to the patched function is insufficient if there are threads currently executing the old function or if other kernel code has pointers to the old function's call sites.

The kernel uses a **per-process consistency model** called "stack-based" consistency:

- A patched system is considered consistent when all tasks have been scheduled at least once with the new function
- The kernel checks each task's call stack during context switches to verify no old functions are active
- The patch is fully "active" only when all tasks have transitioned

This means:
- There is a transition period during which both old and new function versions may execute simultaneously
- Tasks that are sleeping or blocked may delay the transition
- Some patches may take seconds to minutes to fully activate in production systems with long-running tasks

```bash
# Check the live patching state
cat /sys/kernel/livepatch/*/enabled
# 1 = enabled (transitioning or complete)
# 0 = disabled

cat /sys/kernel/livepatch/*/transition
# 1 = still transitioning (some tasks on old code)
# 0 = transition complete (all tasks on new code)

# Check per-task transition state
cat /sys/kernel/livepatch/*/*/patched
# Shows which kernel objects are patched

# Force transition completion (use with caution — see limitations)
echo 1 > /sys/kernel/livepatch/<patch-name>/force
# WARNING: Forcibly completing transition may leave tasks in inconsistent state
# Only use if you understand the specific patch and are confident it is safe
```

## kpatch: Building Live Patches

kpatch is the upstream toolchain for building live patches from kernel source diffs. It was originally developed by Josh Poimboeuf at Red Hat.

### Installing kpatch

```bash
# RHEL / Fedora
dnf install kpatch kpatch-build

# Ubuntu / Debian
apt-get install kpatch kpatch-build

# Build from source (for latest features)
git clone https://github.com/dynup/kpatch.git
cd kpatch
make
sudo make install
```

### Prerequisites for kpatch-build

```bash
# Install build dependencies (RHEL/Fedora)
dnf install kernel-devel kernel-debug-devel \
    elfutils-libelf-devel openssl-devel \
    gcc bison flex pahole \
    rpmbuild rpm-build

# Install build dependencies (Ubuntu)
apt-get install linux-source linux-headers-$(uname -r) \
    elfutils libelf-dev openssl libssl-dev \
    gcc bison flex dwarves \
    dpkg-dev

# Verify the running kernel source is available
ls /usr/src/linux-headers-$(uname -r)/
# or
ls /lib/modules/$(uname -r)/build/
```

### Building a Live Patch from a CVE Fix

```bash
# Step 1: Get the upstream kernel fix as a diff
# Example: CVE-2024-XXXXX fix
wget https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/patch/?id=<commit-hash> \
  -O cve-fix.patch

# Step 2: Identify which source files are modified
grep "^---\|^+++" cve-fix.patch
# --- a/net/ipv4/tcp_input.c
# +++ b/net/ipv4/tcp_input.c

# Step 3: Build the live patch module
kpatch-build \
  --vmlinux /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  cve-fix.patch

# If vmlinux is not available, extract it:
# For RHEL: install kernel-debuginfo
# For Ubuntu: install linux-image-$(uname -r)-dbgsym

# Step 4: Output is a .ko kernel module
ls *.ko
# kpatch-cve-fix.ko

# Step 5: Examine what the patch contains
modinfo kpatch-cve-fix.ko
# srcversion: ...
# depends: livepatch
# vermagic: 6.x.x-xxx.x.x.el9.x86_64 SMP preempt mod_unload modversions
```

### kpatch-build Options

```bash
# Build with debug output to understand what changed
kpatch-build \
  --debug \
  --vmlinux /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  cve-fix.patch

# Specify output directory
kpatch-build \
  -o /tmp/patches/ \
  --vmlinux /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  cve-fix.patch

# Build for a different kernel version (cross-version patching)
kpatch-build \
  --sourcedir /usr/src/kernels/6.x.x-xxx.x.x/ \
  --vmlinux /path/to/vmlinux \
  cve-fix.patch

# Build from multiple patches
kpatch-build \
  --vmlinux /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  patch1.patch patch2.patch

# Test the patch before applying (dry run)
kpatch-build \
  --skip-cleanup \
  --vmlinux /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
  cve-fix.patch
```

## Applying Live Patches

### Manual Application with kpatch

```bash
# Load the patch module
kpatch load kpatch-cve-fix.ko

# Verify the patch is loaded and active
kpatch list
# Loaded patch modules:
# kpatch-cve-fix [enabled]

# Check detailed status
kpatch status
# Loaded patches:
#   Name: kpatch-cve-fix
#   State: enabled
#   Functions patched: tcp_input_skb_process (net/ipv4/tcp_input.c)

# Make the patch persistent across reboots (installs to /var/lib/kpatch/)
kpatch install kpatch-cve-fix.ko

# Remove a patch (only if safe — unloading may not always be possible)
kpatch unload kpatch-cve-fix

# Uninstall from persistent storage
kpatch uninstall kpatch-cve-fix
```

### Direct Module Loading

```bash
# Load via insmod/modprobe (for patches not managed by kpatch tool)
insmod /path/to/kpatch-module.ko

# Verify via sysfs
ls /sys/kernel/livepatch/
# kpatch_cve_fix/

cat /sys/kernel/livepatch/kpatch_cve_fix/enabled
# 1

cat /sys/kernel/livepatch/kpatch_cve_fix/transition
# 0 (fully transitioned)
# 1 (still transitioning)

# Check which functions are patched
ls /sys/kernel/livepatch/kpatch_cve_fix/
# enabled  transition  vmlinux/  net/  ...

# See the specific patched function
ls /sys/kernel/livepatch/kpatch_cve_fix/vmlinux/
# tcp_input_skb_process

cat /sys/kernel/livepatch/kpatch_cve_fix/vmlinux/tcp_input_skb_process/patched
# 1
```

### Monitoring Transition Progress

```bash
#!/bin/bash
# monitor-livepatch-transition.sh

PATCH_NAME="kpatch_cve_fix"
MAX_WAIT=300  # 5 minutes

start_time=$(date +%s)
echo "Monitoring live patch transition for: $PATCH_NAME"

while true; do
    transition=$(cat "/sys/kernel/livepatch/${PATCH_NAME}/transition" 2>/dev/null)
    if [ "$transition" = "0" ]; then
        elapsed=$(( $(date +%s) - start_time ))
        echo "Patch fully applied after ${elapsed} seconds"
        exit 0
    fi

    elapsed=$(( $(date +%s) - start_time ))
    if [ $elapsed -gt $MAX_WAIT ]; then
        echo "WARNING: Patch still transitioning after ${MAX_WAIT}s"
        echo "Tasks blocking transition:"
        # Find tasks still running old code (requires /proc/*/patch_state in newer kernels)
        for pid in /proc/[0-9]*/; do
            patch_state=$(cat "${pid}patch_state" 2>/dev/null)
            if [ "$patch_state" = "-1" ]; then  # -1 = blocking
                comm=$(cat "${pid}comm" 2>/dev/null)
                echo "  PID $(basename $pid): $comm"
            fi
        done
        exit 1
    fi

    echo "Transition in progress... (${elapsed}s elapsed)"
    sleep 5
done
```

## Writing a Minimal Live Patch Module

For environments where kpatch-build is not available, you can write a live patch module manually:

```c
// mypatch.c — minimal kernel live patch module
// This example patches a hypothetical vulnerable function

#include <linux/module.h>
#include <linux/kernel.h>
#include <linux/livepatch.h>

MODULE_LICENSE("GPL");
MODULE_AUTHOR("Security Team");
MODULE_DESCRIPTION("Live patch for CVE-2024-XXXXX");
MODULE_INFO(livepatch, "Y");

// The replacement function — must have the same signature as the original
static long patched_vulnerable_function(int param1, void __user *param2)
{
    // Patched implementation that fixes the vulnerability
    if (!param2) {
        return -EFAULT;
    }
    // ... rest of fixed implementation
    return 0;
}

// Define the patched function list
static struct klp_func funcs[] = {
    {
        .old_name = "vulnerable_function",  // Function to replace
        .new_func = patched_vulnerable_function,
    },
    {}  // Terminator
};

// Define the object (module or vmlinux) containing the patched function
static struct klp_object objs[] = {
    {
        // NULL means the vmlinux (core kernel)
        // For a kernel module: .name = "module_name"
        .name = NULL,
        .funcs = funcs,
    },
    {}  // Terminator
};

// Define the patch
static struct klp_patch patch = {
    .mod = THIS_MODULE,
    .objs = objs,
};

static int __init mypatch_init(void)
{
    int ret;

    ret = klp_enable_patch(&patch);
    if (ret) {
        pr_err("livepatch: failed to enable patch: %d\n", ret);
        return ret;
    }

    pr_info("livepatch: CVE-2024-XXXXX patch applied\n");
    return 0;
}

static void __exit mypatch_exit(void)
{
    // Note: klp_disable_patch is intentionally not called here
    // The kernel manages patch lifetime through klp_enable_patch
    pr_info("livepatch: patch module unloaded\n");
}

module_init(mypatch_init);
module_exit(mypatch_exit);
```

```makefile
# Makefile for the live patch module
obj-m := mypatch.o

KDIR := /lib/modules/$(shell uname -r)/build

default:
	$(MAKE) -C $(KDIR) M=$(PWD) modules

clean:
	$(MAKE) -C $(KDIR) M=$(PWD) clean
```

```bash
# Build the module
make

# Sign the module (required for Secure Boot)
/usr/src/linux-headers-$(uname -r)/scripts/sign-file \
    sha256 \
    /path/to/signing-key.pem \
    /path/to/signing-cert.pem \
    mypatch.ko

# Load
insmod mypatch.ko
```

## Enterprise Live Patching Services

### Red Hat KPatch / RHEL Live Patching

Red Hat provides live patches for RHEL through the `kpatch` package. Patches are delivered via subscription:

```bash
# Install kpatch and kpatch-patch packages
dnf install kpatch kpatch-patch-$(uname -r | sed 's/-/_/g')

# List available patches
dnf list kpatch-patch-*

# Install a specific CVE patch
dnf install kpatch-patch-6_9_8-200_el9

# Check patch status
kpatch list

# Enable automatic kpatch updates (systemd service)
systemctl enable --now kpatch

# View patch changelog
rpm -q --changelog kpatch-patch-6_9_8-200_el9
```

RHEL live patching is available with an active RHEL subscription and RHEL 7+. Key limitations:
- Patches are provided for the full kernel lifetime, not just the latest
- Not all CVEs can be live-patched (architecture limitations apply)
- Patches require a fully consistent system state to apply

```bash
# Verify a specific CVE is remediated
kpatch list | grep CVE-2024-XXXXX

# Or check with insights
insights-client --check-results | grep livepatch
```

### Canonical Livepatch (Ubuntu)

Ubuntu's Livepatch service is provided through Ubuntu Pro:

```bash
# Install and enable Ubuntu Pro
pro attach <UBUNTU_PRO_TOKEN>

# Enable Livepatch
pro enable livepatch

# Check Livepatch status
canonical-livepatch status
# kernel: 6.8.0-45-generic
# fully-patched: true
# version: "110"
# fixes:
#   - patch-id: CVE-2024-43860
#     name: CVE-2024-43860
#     patched: true
#   - patch-id: CVE-2024-43861
#     name: CVE-2024-43861
#     patched: true

# Check verbose status
canonical-livepatch status --verbose

# Disable Livepatch
canonical-livepatch disable

# View currently applied patches
canonical-livepatch status | jq '.patches[].name'
```

### Livepatch in Kubernetes Environments

For Kubernetes worker nodes, live patching eliminates the need to drain and reboot nodes for kernel CVE remediation:

```bash
#!/bin/bash
# k8s-livepatch-status.sh — check livepatch status across all nodes

echo "=== Livepatch Status Across Kubernetes Nodes ==="

for node in $(kubectl get nodes -o name); do
    node_name=${node#node/}
    echo ""
    echo "--- Node: $node_name ---"

    # Run kpatch/canonical-livepatch status on the node
    kubectl debug node/"$node_name" \
        -it \
        --image=ubuntu:22.04 \
        -- bash -c "
            # Check for kpatch (RHEL/CentOS)
            if command -v kpatch >/dev/null 2>&1; then
                echo 'kpatch patches:'
                kpatch list
            fi
            # Check for canonical-livepatch (Ubuntu)
            if command -v canonical-livepatch >/dev/null 2>&1; then
                echo 'canonical-livepatch status:'
                canonical-livepatch status --format json
            fi
        " 2>/dev/null || \
    kubectl get node "$node_name" -o jsonpath='{.metadata.annotations}' | \
        jq '{node: "'$node_name'", annotations: .}'
done
```

### Ansible Playbook for Livepatch Rollout

```yaml
---
# playbook-livepatch.yml — apply kernel live patches across infrastructure
- name: Apply kernel live patches
  hosts: production_servers
  become: true
  vars:
    ubuntu_pro_token: "{{ vault_ubuntu_pro_token }}"

  tasks:
    - name: Check kernel version
      command: uname -r
      register: kernel_version
      changed_when: false

    - name: Get current livepatch status
      command: canonical-livepatch status --format json
      register: livepatch_status
      changed_when: false
      when: ansible_distribution == "Ubuntu"
      ignore_errors: true

    - name: Display pre-patch status
      debug:
        var: livepatch_status.stdout_lines
      when: ansible_distribution == "Ubuntu"

    # Ubuntu Pro / Canonical Livepatch
    - name: Install Ubuntu Pro client
      apt:
        name: ubuntu-advantage-tools
        state: present
        update_cache: true
      when: ansible_distribution == "Ubuntu"

    - name: Attach Ubuntu Pro
      command: pro attach {{ ubuntu_pro_token }}
      when:
        - ansible_distribution == "Ubuntu"
        - "'attached' not in livepatch_status.stdout | default('')"
      register: pro_attach
      changed_when: "'This machine is now attached' in pro_attach.stdout"

    - name: Enable Livepatch
      command: pro enable livepatch
      when: ansible_distribution == "Ubuntu"
      register: livepatch_enable
      changed_when: "'Livepatch enabled' in livepatch_enable.stdout"

    # RHEL / CentOS kpatch
    - name: Install kpatch package (RHEL)
      dnf:
        name:
          - kpatch
          - "kpatch-patch-{{ kernel_version.stdout | replace('-', '_') }}"
        state: present
      when: ansible_os_family == "RedHat"
      ignore_errors: true  # Package may not exist for this exact kernel version

    - name: Enable kpatch service (RHEL)
      systemd:
        name: kpatch
        enabled: true
        state: started
      when: ansible_os_family == "RedHat"

    - name: List applied kpatch patches (RHEL)
      command: kpatch list
      register: kpatch_list
      changed_when: false
      when: ansible_os_family == "RedHat"

    - name: Display post-patch status (RHEL)
      debug:
        var: kpatch_list.stdout_lines
      when: ansible_os_family == "RedHat"

    - name: Get final livepatch status (Ubuntu)
      command: canonical-livepatch status --format json
      register: final_livepatch_status
      changed_when: false
      when: ansible_distribution == "Ubuntu"

    - name: Assert patches are applied (Ubuntu)
      assert:
        that:
          - "'fully-patched' in final_livepatch_status.stdout"
        fail_msg: "Livepatch did not fully apply on {{ inventory_hostname }}"
        success_msg: "Livepatch fully applied on {{ inventory_hostname }}"
      when: ansible_distribution == "Ubuntu"
```

## Known Limitations

Understanding what live patching cannot do is as important as knowing what it can do:

**Functions that cannot be live-patched**:
- Functions that are already executing when the patch is applied (handled by consistency model)
- Functions that are inlined by the compiler at other call sites
- Very short functions (less than 5 bytes on x86-64, needed for the trampoline)
- Functions in the live patching infrastructure itself
- Init functions (run only during boot)

**State changes**:
- Structural kernel data structure changes (adding fields to structs) require reboot
- Changes that modify the layout of per-CPU data require reboot
- Driver initialization code changes require reboot

**Architecture support**:
- Live patching is fully supported on x86-64 and s390
- arm64 support was added in kernel 4.6 but is less mature
- 32-bit architectures have limited support

```bash
# Check if live patching is available on this kernel
grep CONFIG_LIVEPATCH /boot/config-$(uname -r)
# CONFIG_LIVEPATCH=y  — enabled
# CONFIG_LIVEPATCH is not set  — not available

# Check if ftrace is available (required)
grep CONFIG_FUNCTION_TRACER /boot/config-$(uname -r)
# CONFIG_FUNCTION_TRACER=y

# Check available live patches in the running kernel
ls /sys/kernel/livepatch/

# Verify a function can be patched (check if it's inlined or too short)
# Using nm to check function existence in vmlinux
nm /usr/lib/debug/lib/modules/$(uname -r)/vmlinux | grep " T " | grep vulnerable_function
```

## Security Considerations

Live patches are kernel modules and have full kernel privileges. Security controls:

```bash
# Secure Boot — live patch modules must be signed with a trusted key
# Check if module signing is enforced
cat /proc/sys/kernel/modules_disabled
# 0 = modules can be loaded
# 1 = no new modules can be loaded (after a security lockdown)

# Check lockdown mode
cat /sys/kernel/security/lockdown
# none — no lockdown
# integrity — prevents loading unsigned modules
# confidentiality — prevents all access to kernel internals

# Sign modules for Secure Boot environments
openssl req -new -x509 -newkey rsa:2048 \
    -keyout signing_key.pem \
    -out signing_cert.pem \
    -days 365 \
    -subj "/CN=Kernel Module Signing/"

# Add cert to MOK (Machine Owner Key) database
mokutil --import signing_cert.pem

# Sign the patch module
/usr/src/linux-headers-$(uname -r)/scripts/sign-file \
    sha256 \
    signing_key.pem \
    signing_cert.pem \
    kpatch-module.ko
```

## Monitoring and Compliance

```bash
#!/bin/bash
# livepatch-compliance-check.sh — verify live patches are applied for known CVEs

REQUIRED_CVES=(
    "CVE-2024-26596"
    "CVE-2024-26597"
    "CVE-2024-26598"
)

check_rhel_kpatch() {
    local cve=$1
    kpatch list 2>/dev/null | grep -qi "$cve"
}

check_ubuntu_livepatch() {
    local cve=$1
    canonical-livepatch status 2>/dev/null | grep -qi "$cve"
}

echo "=== Live Patch Compliance Report: $(date) ==="
echo "Host: $(hostname)"
echo "Kernel: $(uname -r)"
echo ""

PASS=0
FAIL=0

for cve in "${REQUIRED_CVES[@]}"; do
    patched=false

    if command -v kpatch >/dev/null 2>&1; then
        check_rhel_kpatch "$cve" && patched=true
    elif command -v canonical-livepatch >/dev/null 2>&1; then
        check_ubuntu_livepatch "$cve" && patched=true
    fi

    if $patched; then
        echo "PASS: $cve is live-patched"
        ((PASS++))
    else
        echo "FAIL: $cve is NOT live-patched"
        ((FAIL++))
    fi
done

echo ""
echo "Summary: $PASS compliant, $FAIL non-compliant"

if [ $FAIL -gt 0 ]; then
    exit 1
fi
```

## Summary

Linux kernel live patching is a mature, production-proven technology that allows security patches to be applied to the running kernel without rebooting. The kernel's consistency model ensures that patches are applied safely — every task on the system transitions to the patched code before the patch is considered fully active. kpatch-build automates the complex process of building patch modules from upstream kernel diffs. Enterprise teams should use Red Hat's kpatch subscription service (RHEL) or Canonical Livepatch (Ubuntu Pro) rather than building patches manually — these services provide tested, verified patches for the kernel versions in use. The primary limitations are that live patching cannot replace structural data changes or functions that are too short or inlined, meaning some CVEs still require a reboot. Deploy live patching as a first-response mechanism that buys time to schedule reboots during planned maintenance windows rather than as a permanent alternative to rebooting.
