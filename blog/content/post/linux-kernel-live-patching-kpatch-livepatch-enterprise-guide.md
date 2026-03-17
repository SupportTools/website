---
title: "Linux Kernel Live Patching with kpatch and Canonical Livepatch for Zero-Downtime Security Updates"
date: 2031-06-10T00:00:00-05:00
draft: false
tags: ["Linux", "Kernel", "Live Patching", "kpatch", "Livepatch", "Security", "Zero Downtime"]
categories:
- Linux
- Security
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux kernel live patching covering kpatch on RHEL/CentOS and Canonical Livepatch on Ubuntu, enabling zero-downtime critical security updates in production environments."
more_link: "yes"
url: "/linux-kernel-live-patching-kpatch-livepatch-enterprise-guide/"
---

Critical kernel vulnerabilities like Dirty COW, Spectre/Meltdown, and various privilege escalation CVEs require rapid patching. The traditional response — schedule downtime, patch, reboot — is incompatible with SLA requirements that demand five or six nines of availability. Linux kernel live patching solves this by applying security fixes to a running kernel without requiring a reboot. This guide covers both the upstream kernel live patch infrastructure, kpatch on Red Hat-based systems, and Canonical Livepatch on Ubuntu, including how patches work internally, enterprise deployment patterns, and the operational limits of live patching.

<!--more-->

# Linux Kernel Live Patching

## How Kernel Live Patching Works

Kernel live patching modifies a running kernel by replacing vulnerable functions with patched versions. The mechanism relies on two Linux kernel features:

**ftrace**: The kernel function tracer, which can intercept function calls by modifying the first few bytes of a function to jump to a trampoline. Live patching uses ftrace's `FTRACE_OPS_FL_IPMODIFY` flag to redirect execution to a replacement function.

**kernel/livepatch**: The kernel live patch infrastructure (merged in Linux 4.0) provides the framework for loading, enabling, and disabling live patches as kernel modules. It handles consistency, ensuring the system transitions safely to the patched state.

The patching process:

1. A live patch module is loaded containing the replacement function.
2. The live patch infrastructure registers the patch and begins monitoring task stacks.
3. The **transition** phase begins: new tasks see the patched function; existing tasks are transitioned one at a time as they leave and re-enter the patched functions on their call stacks.
4. Once all tasks have transitioned, the patch is fully active.

The critical constraint: if a task is sleeping inside a function being patched (e.g., blocked in a syscall within the vulnerable code path), it cannot be transitioned until it wakes up and exits that function. The `klp_in_progress` state persists until all tasks transition.

### Checking the Kernel Live Patch Subsystem

```bash
# Verify live patch support is enabled
grep CONFIG_LIVEPATCH /boot/config-$(uname -r)
# Expected: CONFIG_LIVEPATCH=y

# Check if ftrace is enabled (required dependency)
grep CONFIG_FTRACE /boot/config-$(uname -r)
# Expected: CONFIG_FTRACE=y

grep CONFIG_DYNAMIC_FTRACE /boot/config-$(uname -r)
# Expected: CONFIG_DYNAMIC_FTRACE=y
```

## kpatch on Red Hat Enterprise Linux

kpatch is Red Hat's live patching solution, available through the `kpatch` package and delivered via the `kpatch-patch-*` kernel-specific packages.

### Installation on RHEL 8/9

```bash
# Install kpatch
dnf install kpatch kpatch-dnf

# The kpatch-dnf plugin enables automatic live patch installation with dnf

# List available kernel live patches
dnf list kpatch-patch\*

# Install patches for the running kernel
KVER=$(uname -r | sed 's/\.$(uname -m)//')
dnf install "kpatch-patch-$(echo $KVER | tr '.' '_' | tr '-' '_')"

# Alternative: install live patches matching the running kernel automatically
dnf kpatch install
```

### Installing and Loading a Specific Patch

```bash
# Install kpatch-patch for the running kernel
# The package name encodes the kernel version
uname -r
# Example output: 5.14.0-284.11.1.el9_2.x86_64

dnf install kpatch-patch-5_14_0-284_11_1_el9_2-1-1.x86_64

# Load the patch immediately (also done automatically by the package)
kpatch load /usr/lib/kpatch/5.14.0-284.11.1.el9_2.x86_64/kpatch-CVE-2023-32233.ko

# Verify the patch is active
kpatch list
```

Expected output from `kpatch list`:
```
Loaded patch modules:
kpatch_CVE_2023_32233 [enabled]

Installed patch modules:
kpatch_CVE_2023_32233 (5.14.0-284.11.1.el9_2.x86_64)
```

### Managing kpatch Patches

```bash
# Check patch status
kpatch list

# Load a patch module
kpatch load /path/to/kpatch-module.ko

# Unload a patch (reverts the function replacement)
kpatch unload kpatch_CVE_2023_32233

# Enable/disable without unloading
kpatch disable kpatch_CVE_2023_32233
kpatch enable kpatch_CVE_2023_32233

# Check the transition state (0 = complete, 1 = in progress)
cat /sys/kernel/livepatch/kpatch_CVE_2023_32233/transition

# Force transition by signaling tasks stuck in the transition (use with care)
# Check which tasks are blocking transition
grep -r "" /proc/*/task/*/patch_state 2>/dev/null | grep -v "^.*: 0$"
```

### Automating kpatch with Systemd

The `kpatch` service automatically loads installed patches on boot:

```bash
# Enable the kpatch service
systemctl enable kpatch

# Verify service status
systemctl status kpatch

# Check service logs
journalctl -u kpatch -n 50
```

The service reads `/usr/lib/kpatch/$(uname -r)/*.ko` and loads all patch modules at boot, ensuring patches survive reboots until a fully patched kernel is deployed.

### kpatch-dnf Plugin Automation

For automated patch management in enterprise environments:

```bash
# Configure kpatch-dnf to auto-install patches
cat /etc/dnf/plugins/kpatch.conf
```

```ini
[main]
enabled = 1
```

With this plugin enabled, `dnf update` automatically installs any available live patches for the running kernel alongside regular package updates.

## Canonical Livepatch on Ubuntu

Canonical's Livepatch service provides automated kernel live patches for Ubuntu LTS releases. It requires an Ubuntu Pro (or Ubuntu Advantage) subscription.

### Setting Up Canonical Livepatch

```bash
# Install Ubuntu Pro / Canonical Livepatch
# First, attach the machine to Ubuntu Pro
sudo pro attach <your-ubuntu-pro-token>

# Enable Livepatch (may be auto-enabled with Ubuntu Pro)
sudo pro enable livepatch

# Verify Livepatch is enabled
sudo pro status
```

Expected `pro status` output (relevant section):
```
SERVICE          ENTITLED  STATUS    DESCRIPTION
livepatch        yes       enabled   Canonical Kernel Livepatch
```

### Checking Livepatch Status

```bash
# Check current patch state
sudo canonical-livepatch status

# Verbose status showing individual patches
sudo canonical-livepatch status --verbose
```

Example output:
```
last check: 14 minutes ago
kernel: 5.15.0-91.101-generic
server check-in: succeeded
patches: applied
  cve-2024-1086 (patched): Remote privilege escalation via nf_tables
  cve-2023-52340 (patched): ICMPv6 denial of service
  cve-2023-4622 (patched): Unix socket use-after-free
```

### Manual Patch Operations

```bash
# Force an immediate check for new patches
sudo canonical-livepatch refresh

# Check the daemon status
systemctl status canonical-livepatch

# View daemon logs
journalctl -u canonical-livepatch -n 100 --no-pager

# Disable Livepatch (not recommended in production)
sudo canonical-livepatch disable

# Re-enable
sudo canonical-livepatch enable <token>
```

### Livepatch Configuration

```bash
# View current configuration
sudo canonical-livepatch config

# Set the patch check interval (default: 60 minutes)
sudo canonical-livepatch config interval=30

# Set proxy for environments behind a web proxy
sudo canonical-livepatch config https-proxy=http://proxy.example.com:3128
```

## Monitoring Live Patch State via /sys

The kernel live patch infrastructure exposes state through sysfs, which is useful for monitoring and automation:

```bash
# List all loaded live patches
ls /sys/kernel/livepatch/

# For each patch, check state
for patch in /sys/kernel/livepatch/*/; do
  name=$(basename "$patch")
  enabled=$(cat "${patch}enabled")
  transition=$(cat "${patch}transition")
  echo "Patch: $name | Enabled: $enabled | Transition: $transition"
done
```

Key sysfs attributes:
- `enabled`: 1 if the patch is active, 0 if disabled
- `transition`: 1 if the patch is in the middle of transitioning tasks, 0 if complete
- `force`: Write 1 to force the transition (skips safety checks — use only when tasks are known to be safe)

## Handling Stuck Transitions

A live patch stuck in transition is the most common operational issue. This occurs when a task is sleeping inside one of the functions being patched.

```bash
# Identify which tasks are blocking transition
for pid_dir in /proc/*/; do
  pid=$(basename "$pid_dir")
  if [[ -f "${pid_dir}task/${pid}/patch_state" ]]; then
    state=$(cat "${pid_dir}task/${pid}/patch_state" 2>/dev/null)
    if [[ "$state" != "0" ]]; then
      comm=$(cat "${pid_dir}comm" 2>/dev/null)
      echo "PID $pid ($comm): patch_state=$state"
    fi
  fi
done
```

`patch_state` values:
- `0`: Not in a patched function (can be transitioned)
- `1`: Patching in progress (old code path)
- `-1`: Unpatching in progress

### Options for Stuck Transitions

**Option 1: Wait** — The safest approach. Most tasks will transition within seconds to minutes as they complete their current syscall or sleep.

**Option 2: Signal the blocking task** — Send a signal to wake the sleeping task:
```bash
# Find the blocking PID
BLOCKING_PID=<pid>
# Send SIGCONT to wake it
kill -CONT $BLOCKING_PID
# Or SIGUSR1 if the process handles it gracefully
kill -USR1 $BLOCKING_PID
```

**Option 3: Force transition** — A last resort. Forces the transition even if some tasks haven't fully exited the patched function. This can cause issues if those tasks later return from the now-replaced function:
```bash
# Force transition for a specific patch (use with caution)
echo 1 > /sys/kernel/livepatch/<patch-name>/force
```

**Option 4: Reboot** — If the transition cannot complete within an acceptable window and the vulnerability is critical, a reboot with a fully patched kernel is the definitive solution.

## Enterprise Deployment: Ansible Automation

For fleet-wide live patch management with Ansible:

```yaml
# roles/kernel-livepatch/tasks/main.yml
---
- name: Install kpatch on RHEL/CentOS
  when: ansible_os_family == "RedHat"
  block:
    - name: Install kpatch package
      ansible.builtin.dnf:
        name:
          - kpatch
          - kpatch-dnf
        state: present

    - name: Enable kpatch service
      ansible.builtin.systemd:
        name: kpatch
        enabled: true
        state: started

    - name: Install live patches for running kernel
      ansible.builtin.command:
        cmd: dnf kpatch install -y
      register: kpatch_install
      changed_when: "'Nothing to do' not in kpatch_install.stdout"

    - name: Collect kpatch status
      ansible.builtin.command:
        cmd: kpatch list
      register: kpatch_status
      changed_when: false

    - name: Display kpatch status
      ansible.builtin.debug:
        var: kpatch_status.stdout_lines

- name: Configure Canonical Livepatch on Ubuntu
  when: ansible_distribution == "Ubuntu"
  block:
    - name: Ensure ubuntu-advantage-tools is present
      ansible.builtin.apt:
        name: ubuntu-advantage-tools
        state: present
        update_cache: true

    - name: Attach Ubuntu Pro (skip if already attached)
      ansible.builtin.command:
        cmd: pro attach {{ ubuntu_pro_token }}
      register: pro_attach
      failed_when:
        - pro_attach.rc != 0
        - "'already attached' not in pro_attach.stderr"
      changed_when: pro_attach.rc == 0
      no_log: true  # Token is sensitive

    - name: Enable Livepatch
      ansible.builtin.command:
        cmd: pro enable livepatch --assume-yes
      register: livepatch_enable
      changed_when: "'already enabled' not in livepatch_enable.stdout"

    - name: Trigger immediate patch check
      ansible.builtin.command:
        cmd: canonical-livepatch refresh
      changed_when: false

    - name: Get Livepatch status
      ansible.builtin.command:
        cmd: canonical-livepatch status --verbose
      register: livepatch_status
      changed_when: false

    - name: Display Livepatch status
      ansible.builtin.debug:
        var: livepatch_status.stdout_lines

- name: Verify transition is complete
  ansible.builtin.shell: |
    for patch in /sys/kernel/livepatch/*/; do
      transition=$(cat "${patch}transition" 2>/dev/null || echo "0")
      if [[ "$transition" == "1" ]]; then
        echo "TRANSITION_INCOMPLETE: $(basename $patch)"
        exit 1
      fi
    done
    echo "ALL_TRANSITIONS_COMPLETE"
  register: transition_check
  retries: 6
  delay: 10
  until: "'ALL_TRANSITIONS_COMPLETE' in transition_check.stdout"
  changed_when: false
```

## Prometheus Monitoring for Live Patch State

A shell-based collector for the Prometheus node exporter's textfile collector:

```bash
#!/bin/bash
# /usr/local/bin/livepatch-metrics.sh
# Run via cron every minute, output to /var/lib/prometheus/node-exporter/livepatch.prom

OUTPUT_FILE="/var/lib/prometheus/node-exporter/livepatch.prom"
TEMP_FILE="${OUTPUT_FILE}.tmp"

{
  echo "# HELP kernel_livepatch_patch_enabled Whether a live patch is currently enabled (1=enabled)"
  echo "# TYPE kernel_livepatch_patch_enabled gauge"
  echo "# HELP kernel_livepatch_patch_transition Whether a live patch is in transition (1=transitioning)"
  echo "# TYPE kernel_livepatch_patch_transition gauge"
  echo "# HELP kernel_livepatch_patches_total Total number of live patches loaded"
  echo "# TYPE kernel_livepatch_patches_total gauge"

  count=0
  for patch_dir in /sys/kernel/livepatch/*/; do
    [[ -d "$patch_dir" ]] || continue
    name=$(basename "$patch_dir")
    enabled=$(cat "${patch_dir}enabled" 2>/dev/null || echo "0")
    transition=$(cat "${patch_dir}transition" 2>/dev/null || echo "0")
    echo "kernel_livepatch_patch_enabled{patch=\"${name}\"} ${enabled}"
    echo "kernel_livepatch_patch_transition{patch=\"${name}\"} ${transition}"
    ((count++))
  done

  echo "kernel_livepatch_patches_total ${count}"

  # Detect if any transition has been stuck > 5 minutes
  # (Track start time via a marker file)
  for patch_dir in /sys/kernel/livepatch/*/; do
    [[ -d "$patch_dir" ]] || continue
    name=$(basename "$patch_dir")
    transition=$(cat "${patch_dir}transition" 2>/dev/null || echo "0")
    marker="/tmp/livepatch_transition_start_${name}"

    if [[ "$transition" == "1" ]]; then
      if [[ ! -f "$marker" ]]; then
        touch "$marker"
      fi
      start_time=$(stat -c %Y "$marker")
      now=$(date +%s)
      stuck_seconds=$((now - start_time))
    else
      rm -f "$marker"
      stuck_seconds=0
    fi
    echo "kernel_livepatch_transition_stuck_seconds{patch=\"${name}\"} ${stuck_seconds}"
  done

} > "$TEMP_FILE"

mv "$TEMP_FILE" "$OUTPUT_FILE"
```

### Prometheus Alert Rules

```yaml
# livepatch-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kernel-livepatch-alerts
  namespace: monitoring
spec:
  groups:
  - name: kernel-livepatch
    interval: 60s
    rules:
    - alert: KernelLivePatchTransitionStuck
      expr: kernel_livepatch_transition_stuck_seconds > 300
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Kernel live patch transition stuck on {{ $labels.instance }}"
        description: "Patch {{ $labels.patch }} has been in transition for {{ $value }}s on {{ $labels.instance }}"

    - alert: KernelLivePatchDisabled
      expr: kernel_livepatch_patch_enabled == 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Kernel live patch disabled on {{ $labels.instance }}"
        description: "Patch {{ $labels.patch }} is loaded but disabled on {{ $labels.instance }}"

    - alert: KernelLivePatchMissing
      expr: absent(kernel_livepatch_patches_total) or kernel_livepatch_patches_total == 0
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "No kernel live patches loaded on {{ $labels.instance }}"
        description: "No live patches are loaded on {{ $labels.instance }}. Check if patches are available for the running kernel version."
```

## Limitations and When to Reboot

Live patching is powerful but has real constraints:

### What Can Be Patched

- Function implementations: The body of a kernel function can be replaced.
- Bug fixes in existing code paths.
- Security fixes that change function behavior without changing data structures.

### What Cannot Be Patched

- **Struct layout changes**: If a vulnerability fix requires adding or modifying kernel data structures, live patching cannot apply it safely.
- **Init/exit functions**: Functions that run only during module load/unload cannot be live patched meaningfully.
- **Locks and static data**: Changes to lock semantics or global data structures are not safe to live patch.
- **Multiple function interactions**: Complex fixes spanning many interacting functions may not be supportable.

Both Red Hat and Canonical review each CVE to determine whether it is patchable via live patching. Not all critical CVEs have live patches available.

### Checking if a Reboot Is Still Required

```bash
# On RHEL/CentOS: check if a non-live-patchable update is pending
needs-restarting -r
# Exit code 1 means a reboot is needed for pending updates

# On Ubuntu: check Ubuntu Pro livepatch status
sudo canonical-livepatch status
# Look for "fully-patched: true" or CVEs listed as "applied"

# Check kernel commandline for pending reboot (Ubuntu)
if [[ -f /var/run/reboot-required ]]; then
  echo "Reboot required"
  cat /var/run/reboot-required.pkgs
fi
```

### Patch Accumulation and Reboot Windows

Live patches accumulate on a running kernel. Over time, a kernel may have 10 or more live patches applied. Best practice:

1. Apply live patches immediately when available to close vulnerabilities.
2. Schedule a proper kernel reboot during the next maintenance window (monthly or quarterly).
3. The reboot deploys a fully patched kernel, clearing all live patches.
4. After reboot, any new live patches released since the kernel build will be applied again.

This "live patch to survive, reboot to clean up" pattern provides maximum security with minimal disruption.

## Building Custom kpatch Modules

For environments where Red Hat's provided patches do not cover a specific vulnerability, it is possible to build custom kpatch modules. This requires a build environment matching the running kernel.

```bash
# Install build dependencies
dnf install kpatch-build kernel-devel-$(uname -r) \
  gcc elfutils elfutils-devel

# Create the patch file
cat > CVE-2024-example.patch << 'PATCH'
--- a/fs/namei.c
+++ b/fs/namei.c
@@ -100,7 +100,10 @@ static int example_vulnerable_function(struct path *path)
-    if (condition_that_allows_bypass)
-        return 0;
+    if (condition_that_allows_bypass) {
+        /* CVE-2024-example: enforce security check */
+        if (!has_capability(current, CAP_SYS_ADMIN))
+            return -EPERM;
+    }
     return do_real_work(path);
PATCH

# Build the kpatch module
kpatch-build -t vmlinux CVE-2024-example.patch

# The resulting module will be in the current directory
ls kpatch-CVE-2024-example.ko

# Load it
kpatch load kpatch-CVE-2024-example.ko

# Install it to survive reboots
kpatch install kpatch-CVE-2024-example.ko
```

Custom patch building is complex and requires kernel expertise. The patch must compile cleanly, and the function replacement must be semantically correct. Red Hat's kpatch-build tool performs consistency checks, but production deployment of custom patches should involve kernel engineers.

## Compliance and Audit Considerations

In regulated environments (PCI-DSS, HIPAA, FedRAMP), demonstrating that known CVEs are remediated is required. Live patching changes the traditional evidence model:

### Generating Compliance Reports

```bash
# RHEL: Show all applied live patches with CVE mappings
kpatch list | grep enabled

# Show CVE coverage via installed packages
rpm -qa kpatch-patch\* --queryformat '%{NAME} %{VERSION}-%{RELEASE}\n'

# Ubuntu: Livepatch audit log
sudo canonical-livepatch status --verbose | grep -E '(cve|patched|applied)'

# Export to structured format for audit
sudo canonical-livepatch status --format json 2>/dev/null || \
  sudo canonical-livepatch status --verbose
```

### Audit Trail in systemd Journal

```bash
# Show kpatch load/unload events
journalctl -k -g "livepatch" --since "30 days ago"

# On Ubuntu, Livepatch daemon logs
journalctl -u canonical-livepatch --since "30 days ago" | \
  grep -E "(applied|failed|CVE)"
```

For audit purposes, document the policy:

1. Critical and high CVEs are remediated within 24 hours via live patching.
2. The CVE-to-patch mapping is tracked in the change management system.
3. Kernel reboots to fully patched versions occur within 30 days on a scheduled maintenance window.
4. Patch state is continuously monitored via Prometheus with alerts for missed patches.

## Conclusion

Kernel live patching is no longer an exotic feature reserved for financial trading systems. With kpatch and Canonical Livepatch, it is production-ready infrastructure available to any enterprise running RHEL or Ubuntu. The operational model is clear: live patches close vulnerability windows immediately, full kernel updates during planned maintenance windows keep the patch count manageable. The key discipline is monitoring transition state, handling stuck transitions promptly, and never treating live patching as a substitute for proper kernel update hygiene — it is a tool for eliminating the gap between vulnerability disclosure and scheduled maintenance, not for avoiding reboots indefinitely.
