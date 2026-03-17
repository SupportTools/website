---
title: "Linux Kdump Automation: Crash Collection Pipeline for Production Fleets"
date: 2031-01-28T00:00:00-05:00
draft: false
tags: ["Linux", "kdump", "Kernel", "Debugging", "Ansible", "Automation", "Monitoring", "Production", "SRE"]
categories:
- Linux
- Operations
- SRE
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to automating Linux kdump at fleet scale: Ansible-based configuration, crash dump offloading to S3/NFS, automated crash analysis with Python and the crash tool, alert integration, and dump storage lifecycle management."
more_link: "yes"
url: "/linux-kdump-automation-crash-collection-pipeline-production-fleets/"
---

Kernel crashes in production fleets are rare but high-severity events. Without a functioning crash dump collection pipeline, kernel panics produce nothing actionable - the system reboots and the evidence vanishes. kdump captures the kernel memory image at the moment of crash, enabling post-mortem analysis even for the most obscure kernel bugs. At fleet scale, manual kdump configuration is impractical. This guide covers automating kdump deployment across hundreds of hosts with Ansible, building a crash dump collection pipeline that offloads dumps to S3 or NFS, automating initial triage with Python, and managing dump storage lifecycle.

<!--more-->

# Linux Kdump Automation: Crash Collection Pipeline for Production Fleets

## kdump Architecture

kdump works by reserving a dedicated memory region at boot (crashkernel) and pre-loading a minimal "capture kernel" into that region. When the primary kernel crashes:

1. The primary kernel executes a machine check or panic handler
2. kexec boots the capture kernel from the pre-loaded image
3. The capture kernel (running in the reserved memory) has access to the crashed kernel's memory via `/proc/vmcore`
4. makedumpfile creates a compressed vmcore dump
5. The capture kernel executes configured actions (copy to disk, send over network, run scripts)
6. System reboots

```
RAM Layout with kdump enabled:
┌────────────────────────────────┐ ← top of RAM
│                                │
│   Primary Kernel + Apps        │
│                                │
├────────────────────────────────┤ ← crashkernel_high boundary
│                                │
│   Reserved for capture kernel  │ ← crashkernel=256M
│   (not accessible to primary)  │
│                                │
└────────────────────────────────┘ ← physical address 0
```

## Kernel and Boot Configuration

### GRUB Configuration

```bash
# /etc/default/grub - crashkernel parameter
# On systems with > 4GB RAM:
GRUB_CMDLINE_LINUX="... crashkernel=256M,high crashkernel=64M,low"

# On systems with < 4GB RAM:
GRUB_CMDLINE_LINUX="... crashkernel=192M"

# For large memory systems (> 64GB):
GRUB_CMDLINE_LINUX="... crashkernel=512M,high crashkernel=64M,low"

# Apply to GRUB
grub2-mkconfig -o /boot/grub2/grub.cfg

# On UEFI systems:
grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg

# Verify after reboot
cat /proc/cmdline | grep crashkernel
dmesg | grep -i crash
# [    0.000000] Reserving 256MB of memory at 2048MB for crashkernel (System RAM: 16384MB)
```

### kdump Service Configuration

```bash
# /etc/kdump.conf - kdump behavior configuration

# Where to write the dump
# Option 1: Local filesystem (fastest, but requires disk space)
path /var/crash
# Option 2: NFS mount (centralized collection)
# nfs nas.example.com:/exports/crash-dumps
# Option 3: SSH (secure remote collection)
# ssh kdump@crash-collector.example.com
# Option 4: Raw device
# raw /dev/sdb

# Dump filter level
# 0 = all pages (largest dump)
# 1 = kernel pages only (recommended default - much smaller)
# 2 = don't include free pages
# 17 = cache pages + private user + free pages excluded
core_collector makedumpfile -l --message-level 1 -d 31

# Script to run after dump is saved
extra_bins /sbin/makedumpfile

# Default action when dump fails
default shell  # Drop to shell for debugging (alternatives: reboot, poweroff, halt)

# Panic timeout (reboot after capture kernel runs)
# 0 = wait indefinitely
# Set to ensure automatic recovery
# Not in kdump.conf - set via:
# echo 60 > /proc/sys/kernel/panic
```

## Ansible Automation for Fleet Deployment

### Ansible Role Structure

```
roles/kdump/
├── tasks/
│   ├── main.yml
│   ├── configure.yml
│   ├── validate.yml
│   └── storage.yml
├── templates/
│   ├── kdump.conf.j2
│   ├── kdump-capture.sh.j2
│   └── kdump-grub.j2
├── handlers/
│   └── main.yml
├── vars/
│   └── main.yml
└── defaults/
    └── main.yml
```

### Role Defaults

```yaml
# roles/kdump/defaults/main.yml
---
kdump_enabled: true
kdump_path: /var/crash

# Memory reservation (adjust based on total RAM)
# Formula: 256M for first 4GB + 64M per additional 8GB
kdump_crashkernel_auto: true

# Dump compression and filtering
# -l = lzo compression, -d 31 = exclude cache/user/free pages
kdump_core_collector: "makedumpfile -l --message-level 1 -d 31"

# Remote collection
kdump_remote_enabled: false
kdump_remote_type: "nfs"  # nfs, ssh, s3
kdump_nfs_server: ""
kdump_nfs_path: "/exports/crash-dumps"
kdump_ssh_server: ""
kdump_ssh_user: "kdump"

# S3 offload
kdump_s3_bucket: ""
kdump_s3_prefix: "crash-dumps"
kdump_s3_region: "us-east-1"

# Notification
kdump_slack_webhook: ""
kdump_pagerduty_key: ""

# Auto-reboot after capture
kdump_panic_timeout: 60

# Local retention (days)
kdump_local_retention_days: 7
```

### Main Tasks

```yaml
# roles/kdump/tasks/main.yml
---
- name: Install kdump packages
  package:
    name:
    - kexec-tools
    - crash
    - kernel-debuginfo-common-{{ ansible_kernel.split('-')[1:] | join('-') | regex_replace('\.x86_64$', '') }}
    state: present
  register: kdump_install
  retries: 3
  delay: 10

- name: Calculate crashkernel parameter
  when: kdump_crashkernel_auto
  block:
  - name: Get total memory in MB
    set_fact:
      total_memory_mb: "{{ (ansible_memtotal_mb | int) }}"

  - name: Calculate crashkernel value
    set_fact:
      kdump_crashkernel_value: "{{ '512M,high crashkernel=64M,low' if (total_memory_mb | int) > 65536 else ('256M,high crashkernel=64M,low' if (total_memory_mb | int) > 4096 else '192M') }}"

- name: Check current crashkernel grub parameter
  command: grep -o 'crashkernel=[^ ]*' /proc/cmdline
  register: current_crashkernel
  changed_when: false
  failed_when: false

- name: Configure GRUB crashkernel parameter
  lineinfile:
    path: /etc/default/grub
    regexp: '^GRUB_CMDLINE_LINUX='
    line: 'GRUB_CMDLINE_LINUX="{{ existing_params }} crashkernel={{ kdump_crashkernel_value }}"'
  vars:
    existing_params: "{{ ansible_cmdline | dict2items | selectattr('key', 'ne', 'crashkernel') | map(attribute='key') | zip(ansible_cmdline | dict2items | selectattr('key', 'ne', 'crashkernel') | map(attribute='value')) | map('join', '=') | list | join(' ') }}"
  when: current_crashkernel.rc != 0
  notify: rebuild grub

- name: Template kdump configuration
  template:
    src: kdump.conf.j2
    dest: /etc/kdump.conf
    owner: root
    group: root
    mode: '0600'
  notify: restart kdump

- name: Template post-dump collection script
  template:
    src: kdump-capture.sh.j2
    dest: /usr/local/sbin/kdump-capture.sh
    owner: root
    group: root
    mode: '0750'

- name: Configure kernel panic auto-reboot
  sysctl:
    name: kernel.panic
    value: "{{ kdump_panic_timeout }}"
    sysctl_set: true
    state: present
    reload: true

- name: Enable and start kdump service
  systemd:
    name: kdump
    enabled: true
    state: started
  when: kdump_enabled

- name: Validate kdump setup
  import_tasks: validate.yml
```

### kdump Configuration Template

```jinja2
{# roles/kdump/templates/kdump.conf.j2 #}
# Managed by Ansible - do not edit manually
# Node: {{ inventory_hostname }}
# Generated: {{ ansible_date_time.iso8601 }}

{% if kdump_remote_enabled and kdump_remote_type == 'nfs' %}
nfs {{ kdump_nfs_server }}:{{ kdump_nfs_path }}
{% elif kdump_remote_enabled and kdump_remote_type == 'ssh' %}
ssh {{ kdump_ssh_user }}@{{ kdump_ssh_server }}
{% else %}
path {{ kdump_path }}
{% endif %}

core_collector {{ kdump_core_collector }}

# Post-capture script for S3 upload, alerting, etc.
extra_bins /bin/bash
post {{ '/usr/local/sbin/kdump-capture.sh' if kdump_s3_bucket or kdump_slack_webhook else '' }}

# Actions on failure
default reboot

# kdump auto-reserve
auto_reset_crashkernel yes
```

### Post-Capture Script Template

```jinja2
{# roles/kdump/templates/kdump-capture.sh.j2 #}
#!/bin/bash
# Managed by Ansible
# Runs inside the capture kernel after vmcore is saved

set -euo pipefail
exec > /var/log/kdump-capture.log 2>&1

HOSTNAME="{{ inventory_hostname }}"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_PATH="{{ kdump_path }}"
DUMP_FILE=$(ls -t "${DUMP_PATH}"/*/vmcore 2>/dev/null | head -1)

log() {
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

log "kdump capture script starting on ${HOSTNAME} at ${TIMESTAMP}"

if [ -z "${DUMP_FILE}" ]; then
    log "ERROR: No vmcore file found in ${DUMP_PATH}"
    exit 1
fi

DUMP_DIR=$(dirname "${DUMP_FILE}")
DUMP_SIZE=$(du -sh "${DUMP_FILE}" | cut -f1)
log "Dump file: ${DUMP_FILE} (${DUMP_SIZE})"

{% if kdump_s3_bucket %}
log "Uploading to S3..."
S3_KEY="{{ kdump_s3_prefix }}/${HOSTNAME}/${TIMESTAMP}/vmcore"
S3_META_KEY="{{ kdump_s3_prefix }}/${HOSTNAME}/${TIMESTAMP}/metadata.json"

# Create metadata file
cat > "${DUMP_DIR}/metadata.json" << METADATA
{
    "hostname": "${HOSTNAME}",
    "timestamp": "${TIMESTAMP}",
    "kernel": "$(uname -r)",
    "arch": "$(uname -m)",
    "uptime": "$(cat /proc/uptime | awk '{print $1}') seconds",
    "vmcore_size_bytes": $(stat -c%s "${DUMP_FILE}")
}
METADATA

# Upload metadata (small, fast)
aws s3 cp "${DUMP_DIR}/metadata.json" \
    "s3://{{ kdump_s3_bucket }}/${S3_META_KEY}" \
    --region {{ kdump_s3_region }} \
    --no-progress

# Upload vmcore (may be large)
aws s3 cp "${DUMP_FILE}" \
    "s3://{{ kdump_s3_bucket }}/${S3_KEY}" \
    --region {{ kdump_s3_region }} \
    --storage-class STANDARD_IA \
    --no-progress \
    --expected-size $(stat -c%s "${DUMP_FILE}")

log "Upload complete: s3://{{ kdump_s3_bucket }}/${S3_KEY}"
{% endif %}

{% if kdump_slack_webhook %}
log "Sending Slack notification..."

BACKTRACE=""
if command -v crash &>/dev/null; then
    CRASH_COMMANDS="bt\nq"
    BACKTRACE=$(echo -e "${CRASH_COMMANDS}" | crash \
        /usr/lib/debug/lib/modules/$(uname -r)/vmlinux \
        "${DUMP_FILE}" 2>/dev/null | tail -20 || echo "backtrace extraction failed")
fi

PAYLOAD=$(cat << PAYLOAD
{
    "text": ":red_circle: *Kernel Crash Detected*",
    "attachments": [{
        "color": "danger",
        "fields": [
            {"title": "Host", "value": "${HOSTNAME}", "short": true},
            {"title": "Time", "value": "${TIMESTAMP}", "short": true},
            {"title": "Kernel", "value": "$(uname -r)", "short": true},
            {"title": "Dump Size", "value": "${DUMP_SIZE}", "short": true}
        ]
    }]
}
PAYLOAD
)

curl -s -X POST \
    -H 'Content-type: application/json' \
    --data "${PAYLOAD}" \
    '{{ kdump_slack_webhook }}'
{% endif %}

log "kdump capture script complete"
```

### Validation Tasks

```yaml
# roles/kdump/tasks/validate.yml
---
- name: Check kdump service status
  systemd:
    name: kdump
  register: kdump_service_state

- name: Assert kdump is running
  assert:
    that:
    - kdump_service_state.status.ActiveState == "active"
    fail_msg: "kdump service is not active: {{ kdump_service_state.status.ActiveState }}"
    success_msg: "kdump service is active"

- name: Check crashkernel reservation
  command: dmesg
  register: dmesg_output
  changed_when: false

- name: Verify crashkernel is reserved
  assert:
    that:
    - "'crashkernel' in dmesg_output.stdout or 'Reserving' in dmesg_output.stdout"
    fail_msg: "crashkernel memory not reserved - reboot required"
    success_msg: "crashkernel memory reserved"
  # This will fail on first run before reboot - handle gracefully
  ignore_errors: true

- name: Check /proc/vmcore exists (capture kernel only)
  stat:
    path: /proc/vmcore
  register: vmcore_stat

- name: Verify reserved memory size
  shell: |
    reserved=$(dmesg | grep -oP 'Reserving \K[0-9]+MB')
    if [ -n "$reserved" ] && [ "$reserved" -lt 128 ]; then
      echo "WARNING: crashkernel only reserved ${reserved}MB - may not be sufficient"
      exit 1
    fi
    exit 0
  changed_when: false
  failed_when: false
  register: memory_check

- name: Report validation results
  debug:
    msg:
    - "kdump service: {{ kdump_service_state.status.ActiveState }}"
    - "crashkernel parameter: {{ current_crashkernel.stdout | default('not set - reboot needed') }}"
    - "memory check: {{ memory_check.stdout | default('ok') }}"
```

## Automated Crash Analysis with Python

### Crash Analysis Pipeline

```python
#!/usr/bin/env python3
"""
kdump_analyzer.py - Automated crash dump analysis pipeline.

Monitors a directory (or S3 bucket) for new vmcore files,
runs initial triage using the crash tool, and generates
structured reports.
"""

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict
import boto3

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s'
)
log = logging.getLogger(__name__)


@dataclass
class CrashReport:
    """Structured crash analysis report."""
    hostname: str
    timestamp: str
    kernel_version: str
    crash_time: str
    panic_message: str = ""
    oops_message: str = ""
    backtrace: List[str] = field(default_factory=list)
    modules_loaded: List[str] = field(default_factory=list)
    call_stack: List[str] = field(default_factory=list)
    process_name: str = ""
    cpu_count: int = 0
    memory_gb: float = 0.0
    potential_cause: str = "unknown"
    severity: str = "high"
    vmcore_path: str = ""
    vmcore_size_bytes: int = 0
    analysis_duration_seconds: float = 0.0


class CrashAnalyzer:
    """Analyzes kernel crash dumps using the crash tool."""

    # Patterns that indicate specific failure types
    PANIC_PATTERNS = {
        "null_pointer": re.compile(r"BUG: kernel NULL pointer dereference"),
        "use_after_free": re.compile(r"BUG: KASAN: use-after-free"),
        "stack_overflow": re.compile(r"kernel stack overflow"),
        "oom": re.compile(r"Out of memory: Kill process"),
        "rcu_stall": re.compile(r"INFO: rcu_sched self-detected stall"),
        "hung_task": re.compile(r"INFO: task \S+ blocked for more than"),
        "slab_corruption": re.compile(r"BUG: corrupted list"),
        "divide_error": re.compile(r"divide error:"),
        "general_protection": re.compile(r"general protection fault"),
        "watchdog_timeout": re.compile(r"Watchdog detected hard LOCKUP"),
        "memory_corruption": re.compile(r"KASAN: .* in kmalloc"),
    }

    def __init__(self, crash_binary: str = "crash", vmlinux_path: Optional[str] = None):
        self.crash_binary = crash_binary
        self.vmlinux_path = vmlinux_path

    def find_vmlinux(self, kernel_version: str) -> Optional[str]:
        """Find the vmlinux debug symbols for a given kernel version."""
        candidates = [
            f"/usr/lib/debug/lib/modules/{kernel_version}/vmlinux",
            f"/boot/vmlinux-{kernel_version}",
            f"/usr/src/debug/kernel-{kernel_version}/vmlinux",
        ]
        for path in candidates:
            if os.path.exists(path):
                return path
        return None

    def run_crash_commands(self, vmcore: str, vmlinux: str, commands: List[str]) -> str:
        """Run crash tool commands against a vmcore file."""
        # Create a command file
        with tempfile.NamedTemporaryFile(mode='w', suffix='.cmd', delete=False) as f:
            for cmd in commands:
                f.write(cmd + "\n")
            f.write("quit\n")
            cmd_file = f.name

        try:
            result = subprocess.run(
                [self.crash_binary, vmlinux, vmcore, '-s', '-i', cmd_file],
                capture_output=True,
                text=True,
                timeout=120,  # 2 minute timeout
            )
            return result.stdout + result.stderr
        except subprocess.TimeoutExpired:
            log.warning("crash tool timed out after 120 seconds")
            return "ERROR: crash tool timed out"
        except Exception as e:
            log.error("crash tool failed: %s", e)
            return f"ERROR: {e}"
        finally:
            os.unlink(cmd_file)

    def analyze(self, vmcore_path: str, metadata: Optional[Dict] = None) -> CrashReport:
        """Perform full crash analysis on a vmcore file."""
        start_time = time.time()

        report = CrashReport(
            hostname=metadata.get("hostname", "unknown") if metadata else "unknown",
            timestamp=datetime.now(timezone.utc).isoformat(),
            kernel_version="unknown",
            crash_time=metadata.get("timestamp", "unknown") if metadata else "unknown",
            vmcore_path=vmcore_path,
            vmcore_size_bytes=os.path.getsize(vmcore_path) if os.path.exists(vmcore_path) else 0,
        )

        # Extract kernel version from vmcore
        try:
            result = subprocess.run(
                ['strings', vmcore_path],
                capture_output=True, text=True, timeout=60
            )
            for line in result.stdout.split('\n'):
                if re.match(r'Linux version [0-9]', line):
                    match = re.search(r'Linux version (\S+)', line)
                    if match:
                        report.kernel_version = match.group(1)
                        break
        except Exception as e:
            log.warning("Failed to extract kernel version: %s", e)

        # Find vmlinux
        vmlinux = self.vmlinux_path or self.find_vmlinux(report.kernel_version)
        if not vmlinux:
            log.error("Cannot find vmlinux for kernel %s", report.kernel_version)
            report.potential_cause = "analysis_failed_no_vmlinux"
            report.analysis_duration_seconds = time.time() - start_time
            return report

        # Run crash analysis commands
        crash_output = self.run_crash_commands(vmcore_path, vmlinux, [
            "sys",          # System information
            "bt",           # Backtrace of panicking thread
            "ps",           # Running processes
            "kmsg",         # Kernel log buffer
            "mod",          # Loaded modules
            "files",        # Open files (if applicable)
            "vm",           # Virtual memory info
        ])

        # Parse crash output
        self._parse_crash_output(crash_output, report)

        # Extract panic message from kernel log
        self._extract_panic_info(crash_output, report)

        # Classify the crash
        report.potential_cause = self._classify_crash(report)

        report.analysis_duration_seconds = time.time() - start_time
        log.info("Analysis complete for %s: %s (%.1fs)",
                 vmcore_path, report.potential_cause, report.analysis_duration_seconds)
        return report

    def _parse_crash_output(self, output: str, report: CrashReport):
        """Parse crash tool output into report fields."""
        lines = output.split('\n')
        in_bt = False
        in_kmsg = False

        for line in lines:
            # CPU count
            if 'CPUS:' in line:
                match = re.search(r'CPUS:\s+(\d+)', line)
                if match:
                    report.cpu_count = int(match.group(1))

            # Process info
            if 'COMMAND:' in line:
                match = re.search(r'COMMAND:\s+"(\S+)"', line)
                if match:
                    report.process_name = match.group(1)

            # Backtrace
            if re.match(r'\s*#\d+\s+\[', line):
                in_bt = True
            if in_bt:
                if line.strip():
                    report.backtrace.append(line.strip())
                else:
                    in_bt = False

            # Kernel modules
            if re.match(r'\S+\s+\d+\s+\d+\s+\[', line):
                mod_match = re.match(r'(\S+)\s+', line)
                if mod_match:
                    report.modules_loaded.append(mod_match.group(1))

    def _extract_panic_info(self, output: str, report: CrashReport):
        """Extract panic and oops messages from kernel log."""
        for line in output.split('\n'):
            if any(kw in line for kw in ['Kernel panic', 'BUG:', 'OOPS:', 'Call Trace:']):
                if 'Kernel panic' in line:
                    report.panic_message = line.strip()
                elif 'BUG:' in line:
                    report.oops_message = line.strip()

    def _classify_crash(self, report: CrashReport) -> str:
        """Classify the crash cause based on panic and backtrace."""
        combined_text = f"{report.panic_message} {report.oops_message} {' '.join(report.backtrace)}"

        for cause, pattern in self.PANIC_PATTERNS.items():
            if pattern.search(combined_text):
                return cause

        if 'watchdog' in combined_text.lower():
            return 'watchdog_timeout'
        if 'oom' in combined_text.lower() or 'out of memory' in combined_text.lower():
            return 'oom_killer'
        if any(net_kw in combined_text.lower() for net_kw in ['tcp', 'udp', 'net', 'socket']):
            return 'network_subsystem'
        if any(disk_kw in combined_text.lower() for disk_kw in ['scsi', 'nvme', 'block', 'io']):
            return 'storage_subsystem'

        return 'unknown'


class S3CrashMonitor:
    """Monitors an S3 bucket for new crash dumps and analyzes them."""

    def __init__(self, bucket: str, prefix: str, region: str, analyzer: CrashAnalyzer):
        self.bucket = bucket
        self.prefix = prefix
        self.s3 = boto3.client('s3', region_name=region)
        self.analyzer = analyzer
        self.processed: set = set()

    def load_processed(self, state_file: str):
        """Load the set of already-processed vmcore keys."""
        if os.path.exists(state_file):
            with open(state_file) as f:
                self.processed = set(json.load(f))

    def save_processed(self, state_file: str):
        """Persist processed vmcore keys."""
        with open(state_file, 'w') as f:
            json.dump(list(self.processed), f)

    def poll(self, output_dir: str, state_file: str):
        """Poll S3 for new vmcore files and analyze them."""
        self.load_processed(state_file)
        os.makedirs(output_dir, exist_ok=True)

        paginator = self.s3.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=self.bucket, Prefix=self.prefix)

        for page in pages:
            for obj in page.get('Contents', []):
                key = obj['Key']
                if not key.endswith('/vmcore'):
                    continue
                if key in self.processed:
                    continue

                log.info("New vmcore found: s3://%s/%s", self.bucket, key)

                # Parse path: prefix/hostname/timestamp/vmcore
                parts = key.split('/')
                if len(parts) < 3:
                    continue

                hostname = parts[-3]
                timestamp = parts[-2]

                # Download vmcore to temp location
                with tempfile.NamedTemporaryFile(suffix='.vmcore', delete=False) as tmp:
                    tmp_path = tmp.name

                try:
                    log.info("Downloading %s...", key)
                    self.s3.download_file(self.bucket, key, tmp_path)

                    # Download metadata if available
                    metadata = None
                    meta_key = key.replace('/vmcore', '/metadata.json')
                    try:
                        meta_obj = self.s3.get_object(Bucket=self.bucket, Key=meta_key)
                        metadata = json.loads(meta_obj['Body'].read())
                    except Exception:
                        pass

                    # Analyze
                    report = self.analyzer.analyze(tmp_path, metadata)

                    # Save report
                    report_path = os.path.join(output_dir,
                        f"{hostname}-{timestamp}-crash-report.json")
                    with open(report_path, 'w') as f:
                        json.dump(asdict(report), f, indent=2)

                    log.info("Report saved: %s (cause: %s)", report_path, report.potential_cause)

                    # Upload report back to S3
                    report_key = key.replace('/vmcore', '/crash-report.json')
                    self.s3.upload_file(report_path, self.bucket, report_key)

                    self.processed.add(key)
                    self.save_processed(state_file)

                finally:
                    os.unlink(tmp_path)


def main():
    import argparse

    parser = argparse.ArgumentParser(description='kdump crash analysis pipeline')
    parser.add_argument('--s3-bucket', help='S3 bucket name')
    parser.add_argument('--s3-prefix', default='crash-dumps', help='S3 key prefix')
    parser.add_argument('--s3-region', default='us-east-1')
    parser.add_argument('--output-dir', default='/var/log/crash-reports')
    parser.add_argument('--state-file', default='/var/lib/kdump-analyzer/processed.json')
    parser.add_argument('--vmcore', help='Analyze a single vmcore file')
    parser.add_argument('--vmlinux', help='Path to vmlinux debug symbols')
    parser.add_argument('--daemon', action='store_true', help='Run as daemon, poll S3')
    parser.add_argument('--poll-interval', type=int, default=300)
    args = parser.parse_args()

    analyzer = CrashAnalyzer(vmlinux_path=args.vmlinux)

    if args.vmcore:
        report = analyzer.analyze(args.vmcore)
        print(json.dumps(asdict(report), indent=2))
        return

    if args.s3_bucket:
        monitor = S3CrashMonitor(
            args.s3_bucket, args.s3_prefix, args.s3_region, analyzer)

        if args.daemon:
            log.info("Starting daemon mode, polling every %ds", args.poll_interval)
            while True:
                try:
                    monitor.poll(args.output_dir, args.state_file)
                except Exception as e:
                    log.error("Poll failed: %s", e)
                time.sleep(args.poll_interval)
        else:
            monitor.poll(args.output_dir, args.state_file)


if __name__ == '__main__':
    main()
```

## Alert Integration

### Prometheus Alerting for kdump Events

```yaml
# prometheus-rules-kdump.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: kdump-alerts
  namespace: monitoring
spec:
  groups:
  - name: kdump
    rules:
    - alert: KernelCrashDetected
      expr: |
        increase(node_vmstat_pgmajfault[5m]) > 1000
        AND
        (time() - node_boot_time_seconds) < 300
      for: 0m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Possible kernel crash on {{ $labels.instance }}"
        description: "Node {{ $labels.instance }} rebooted recently and has high page faults - may be recovering from kernel crash"

    - alert: KdumpServiceDown
      expr: |
        node_systemd_unit_state{name="kdump.service",state="active"} == 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "kdump not active on {{ $labels.instance }}"
        description: "kdump service is not running on {{ $labels.instance }} - crash dumps will not be collected"
```

### Alert Webhook for Crash Reports

```python
# alert_integration.py
import json
import os
import requests
from typing import Optional

def send_crash_alert(report: dict, channels: list):
    """Send crash alert to configured notification channels."""

    # Format message
    severity_emoji = {
        "null_pointer": "🔴",
        "oom_killer": "🟡",
        "watchdog_timeout": "🔴",
        "use_after_free": "🔴",
        "unknown": "🟠",
    }

    cause = report.get("potential_cause", "unknown")
    emoji = severity_emoji.get(cause, "🟠")

    message = (
        f"{emoji} *Kernel Crash: {report.get('hostname', 'unknown')}*\n"
        f"• Time: {report.get('crash_time', 'unknown')}\n"
        f"• Kernel: {report.get('kernel_version', 'unknown')}\n"
        f"• Cause: {cause}\n"
        f"• Panic: {report.get('panic_message', 'N/A')[:100]}\n"
        f"• Dump size: {report.get('vmcore_size_bytes', 0) // (1024*1024)}MB"
    )

    for channel in channels:
        if channel.get("type") == "slack":
            _send_slack(channel["webhook_url"], message, report)
        elif channel.get("type") == "pagerduty":
            _send_pagerduty(channel["routing_key"], report)


def _send_slack(webhook_url: str, message: str, report: dict):
    payload = {
        "text": message,
        "attachments": [{
            "color": "danger",
            "fields": [
                {"title": "Backtrace", "value": "\n".join(report.get("backtrace", [])[:5])}
            ]
        }]
    }
    requests.post(webhook_url, json=payload, timeout=10)


def _send_pagerduty(routing_key: str, report: dict):
    payload = {
        "routing_key": routing_key,
        "event_action": "trigger",
        "dedup_key": f"kdump-{report.get('hostname')}-{report.get('crash_time')}",
        "payload": {
            "summary": f"Kernel crash on {report.get('hostname')}: {report.get('potential_cause')}",
            "severity": "critical",
            "source": report.get("hostname"),
            "component": "kernel",
            "custom_details": report,
        }
    }
    requests.post(
        "https://events.pagerduty.com/v2/enqueue",
        json=payload,
        timeout=10
    )
```

## Dump Storage Lifecycle Management

```python
#!/usr/bin/env python3
"""
kdump_lifecycle.py - Manage crash dump storage lifecycle.
"""

import boto3
import logging
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

def apply_s3_lifecycle_policy(bucket: str, prefix: str):
    """Apply S3 lifecycle rules to manage crash dump storage costs."""
    s3 = boto3.client('s3')

    lifecycle_config = {
        'Rules': [
            {
                'ID': 'crash-dumps-tiering',
                'Status': 'Enabled',
                'Filter': {'Prefix': prefix + '/'},
                'Transitions': [
                    # Move to Glacier after 30 days (analyzed by then)
                    {
                        'Days': 30,
                        'StorageClass': 'GLACIER'
                    },
                ],
                'Expiration': {
                    # Delete after 1 year
                    'Days': 365
                },
            },
            {
                'ID': 'crash-reports-retention',
                'Status': 'Enabled',
                'Filter': {'Prefix': prefix + '/'},
                'Expiration': {
                    'Days': 730  # Keep analysis reports for 2 years
                },
            }
        ]
    }

    s3.put_bucket_lifecycle_configuration(
        Bucket=bucket,
        LifecycleConfiguration=lifecycle_config
    )
    log.info("Applied lifecycle policy to s3://%s/%s", bucket, prefix)


def cleanup_local_dumps(dump_dir: str, retention_days: int = 7):
    """Remove old local crash dumps beyond retention period."""
    import os
    import shutil

    cutoff = datetime.now() - timedelta(days=retention_days)
    removed = 0

    for entry in os.scandir(dump_dir):
        if entry.is_dir():
            mtime = datetime.fromtimestamp(entry.stat().st_mtime)
            if mtime < cutoff:
                log.info("Removing old dump: %s (age: %d days)",
                    entry.path, (datetime.now() - mtime).days)
                shutil.rmtree(entry.path)
                removed += 1

    log.info("Removed %d old dump directories from %s", removed, dump_dir)
    return removed
```

## Conclusion

A production-ready kdump pipeline requires automation at every stage:

1. **Ansible deployment**: Configure crashkernel parameters, kdump.conf, and post-capture scripts consistently across fleets; validate that memory is reserved after reboot
2. **S3 offloading**: Upload vmcore files asynchronously from the capture kernel; use STANDARD_IA storage class for cost savings; add metadata JSON for structured triage
3. **Automated analysis**: Run the crash tool automatically; extract panic messages, backtraces, and crash causes; generate structured JSON reports for ticketing integration
4. **Alerting**: Combine node reboot detection with kdump service monitoring; route alerts based on crash severity; include kernel backtrace snippets in notifications
5. **Storage lifecycle**: S3 lifecycle policies transition vmcore files to Glacier after 30 days and expire after 1 year; clean local dumps after confirmation of S3 upload

The result is a system where every kernel panic produces a structured analysis report, an alert fires to the on-call engineer, and the raw crash dump is preserved for deep analysis - all without any human intervention at 3 AM.
