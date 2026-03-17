---
title: "Linux Kernel Samepage Merging: Memory Deduplication for Virtualized Workloads"
date: 2029-01-21T00:00:00-05:00
draft: false
tags: ["Linux", "KSM", "Virtualization", "Memory", "KVM", "Performance", "Kernel"]
categories:
- Linux
- Virtualization
author: "Matthew Mattox - mmattox@support.tools"
description: "A technical deep dive into Linux Kernel Samepage Merging (KSM), covering internals, tuning parameters, security implications, and practical deployment strategies for KVM hosts and container environments."
more_link: "yes"
url: "/linux-kernel-samepage-merging-memory-deduplication/"
---

Linux Kernel Samepage Merging (KSM) is a memory management feature that allows the kernel to identify anonymous memory pages with identical content across different processes and merge them into a single copy-on-write page. For virtualization hosts running multiple VMs with similar operating systems or container hosts running identical images, KSM can reduce physical memory consumption by 20–40%, directly translating into higher VM density or reduced hardware costs.

This post covers the KSM subsystem architecture, tuning parameters, performance trade-offs, security considerations (particularly the Rowhammer and side-channel implications), and practical configuration for KVM and container workloads.

<!--more-->

## KSM Architecture

KSM was merged into the Linux kernel in version 2.6.32. It operates as a kernel thread (`ksmd`) that scans anonymous memory pages registered by user-space processes (or by the kernel on behalf of KVM guests) and builds a red-black tree of page content hashes.

### How KSM Works

1. **Page Registration**: An application (or the KVM hypervisor) marks memory regions as candidates for merging using the `madvise(MADV_MERGEABLE)` system call. KVM automatically marks guest memory as mergeable when KSM is enabled.

2. **Scanning**: The `ksmd` kernel thread periodically scans registered pages. It computes a hash of each page's content and looks up the hash in a red-black tree of stable pages (pages currently shared across processes).

3. **Merging**: When two pages have identical content, KSM promotes the second page to a copy-on-write state pointing at the same physical page frame. The original page frame is returned to the buddy allocator.

4. **Write Handling**: When a process attempts to write to a merged (read-only) page, the kernel triggers a page fault, allocates a new private page, copies the content, and remaps the page table entry. This is the standard copy-on-write mechanism.

### KSM Memory Regions

```
Virtual Address Space (Process A)         Virtual Address Space (Process B)
+---------------------------+             +---------------------------+
| Page @ 0x7f000000 [R/W]  |             | Page @ 0x7f001000 [R/W]  |
| Content: [identical data] |             | Content: [identical data] |
+---------------------------+             +---------------------------+
          |                                         |
          | After KSM merge:                        |
          v                                         v
+----------------------------------------------------------+
|         Single Physical Page Frame (copy-on-write)       |
+----------------------------------------------------------+
```

The `ksmd` thread processes pages in two passes:
- **Unstable tree**: New candidate pages are first added to the unstable tree (red-black tree sorted by content hash). Pages in this tree are volatile—they may change between scans.
- **Stable tree**: Once two pages merge successfully, the resulting shared page is moved to the stable tree and marked read-only.

## Enabling and Configuring KSM

### System-Level Activation

KSM is controlled through sysfs. The kernel must be compiled with `CONFIG_KSM=y` (enabled by default on most distributions):

```bash
# Check if KSM is available
ls -la /sys/kernel/mm/ksm/
# Expected output:
# -r--r--r-- 1 root root 4096 Jan 19 00:00 advisor_max_cpu
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 advisor_max_pages_to_scan
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 advisor_min_pages_to_scan
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 advisor_mode
# -r--r--r-- 1 root root 4096 Jan 19 00:00 full_scans
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 max_page_sharing
# -r--r--r-- 1 root root 4096 Jan 19 00:00 merge_across_nodes
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 pages_to_scan
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 run
# -r--r--r-- 1 root root 4096 Jan 19 00:00 pages_shared
# -r--r--r-- 1 root root 4096 Jan 19 00:00 pages_sharing
# -r--r--r-- 1 root root 4096 Jan 19 00:00 pages_unshared
# -r--r--r-- 1 root root 4096 Jan 19 00:00 pages_volatile
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 sleep_millisecs
# -r--r--r-- 1 root root 4096 Jan 19 00:00 stable_node_chains
# -r--r--r-- 1 root root 4096 Jan 19 00:00 stable_node_dups
# -rw-r--r-- 1 root root 4096 Jan 19 00:00 use_zero_pages

# Enable KSM (0=disabled, 1=running, 2=running+advisor)
echo 1 > /sys/kernel/mm/ksm/run

# Verify
cat /sys/kernel/mm/ksm/run
```

### Tuning Parameters

```bash
#!/bin/bash
# ksm-tune.sh — Apply production KSM tuning for a KVM virtualization host

# Number of pages scanned per batch. Higher = more CPU, faster merging.
# For a host with 256GB RAM and 64 VMs, 10000 is a reasonable starting point.
echo 10000 > /sys/kernel/mm/ksm/pages_to_scan

# Time in milliseconds to sleep between scan batches.
# Lower = more aggressive scanning, higher CPU usage.
# 50ms gives ~200 scan batches/second at 10000 pages each = 2M pages/sec.
echo 50 > /sys/kernel/mm/ksm/sleep_millisecs

# Maximum number of processes that can share a single merged page.
# Kernel default is 256. For container workloads, 512 is appropriate.
echo 512 > /sys/kernel/mm/ksm/max_page_sharing

# Merge zero pages with other zero pages (saves memory for zero-initialized regions).
# This is a significant win for freshly started VMs.
echo 1 > /sys/kernel/mm/ksm/use_zero_pages

# Allow merging across NUMA nodes.
# Set to 0 on NUMA systems to avoid cross-node page access latency penalties.
NUMA_NODES=$(cat /sys/devices/system/node/possible | tr ',' '\n' | wc -l)
if [ "${NUMA_NODES}" -gt 1 ]; then
    echo 0 > /sys/kernel/mm/ksm/merge_across_nodes
    echo "NUMA system detected (${NUMA_NODES} nodes): disabled cross-node merging"
else
    echo 1 > /sys/kernel/mm/ksm/merge_across_nodes
fi

# Enable KSM
echo 1 > /sys/kernel/mm/ksm/run

echo "KSM enabled with production settings"
echo "pages_to_scan: $(cat /sys/kernel/mm/ksm/pages_to_scan)"
echo "sleep_millisecs: $(cat /sys/kernel/mm/ksm/sleep_millisecs)"
echo "max_page_sharing: $(cat /sys/kernel/mm/ksm/max_page_sharing)"
echo "use_zero_pages: $(cat /sys/kernel/mm/ksm/use_zero_pages)"
echo "merge_across_nodes: $(cat /sys/kernel/mm/ksm/merge_across_nodes)"
```

### Persistent Configuration via systemd

```bash
# /etc/systemd/system/ksm-tune.service
cat > /etc/systemd/system/ksm-tune.service <<'EOF'
[Unit]
Description=KSM Memory Deduplication Tuning
After=systemd-modules-load.service
DefaultDependencies=no
Before=basic.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/ksm-tune.sh
ExecStop=/bin/sh -c 'echo 0 > /sys/kernel/mm/ksm/run'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ksm-tune.service
```

## Monitoring KSM Effectiveness

### Reading KSM Statistics

```bash
#!/bin/bash
# ksm-stats.sh — Display current KSM efficiency metrics

KSM_PATH="/sys/kernel/mm/ksm"
PAGE_SIZE=$(getconf PAGE_SIZE)

pages_shared=$(cat ${KSM_PATH}/pages_shared)
pages_sharing=$(cat ${KSM_PATH}/pages_sharing)
pages_unshared=$(cat ${KSM_PATH}/pages_unshared)
pages_volatile=$(cat ${KSM_PATH}/pages_volatile)
full_scans=$(cat ${KSM_PATH}/full_scans)

# pages_sharing: pages that are SHARING a merged page (additional copies that were eliminated)
# pages_shared: actual number of merged pages currently in use (physical pages saved)
# savings = pages_sharing - pages_shared (because pages_shared are still needed)
savings=$((pages_sharing - pages_shared))
savings_mb=$(( (savings * PAGE_SIZE) / 1024 / 1024 ))
savings_gb=$(echo "scale=2; ${savings_mb} / 1024" | bc)

echo "=== KSM Statistics ==="
printf "Pages shared (physical pages):  %12d  (%d MB)\n" \
    "${pages_shared}" $(( (pages_shared * PAGE_SIZE) / 1024 / 1024 ))
printf "Pages sharing (virtual pages):  %12d  (%d MB)\n" \
    "${pages_sharing}" $(( (pages_sharing * PAGE_SIZE) / 1024 / 1024 ))
printf "Memory saved:                   %12d  (%s GB)\n" \
    "${savings}" "${savings_gb}"
printf "Pages unshared (candidate):     %12d\n" "${pages_unshared}"
printf "Pages volatile (changing):      %12d\n" "${pages_volatile}"
printf "Full scans completed:           %12d\n" "${full_scans}"

if [ "${pages_sharing}" -gt 0 ]; then
    ratio=$(echo "scale=2; ${pages_sharing} / ${pages_shared}" | bc 2>/dev/null || echo "N/A")
    echo ""
    echo "Sharing ratio (sharing:shared): ${ratio}:1"
    echo "  A ratio > 2 indicates good deduplication potential"
fi
```

### Prometheus Node Exporter Integration

The Linux `node_exporter` exposes KSM metrics when run with the `--collector.ksm` flag (enabled by default in v1.6+):

```yaml
# node-exporter-daemonset-ksm.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      hostPID: true
      hostIPC: true
      hostNetwork: true
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.8.2
        args:
        - --path.procfs=/host/proc
        - --path.sysfs=/host/sys
        - --path.rootfs=/host
        - --collector.ksm
        - --collector.meminfo
        - --no-collector.wifi
        - --web.listen-address=:9100
        ports:
        - containerPort: 9100
          name: metrics
          hostPort: 9100
        volumeMounts:
        - name: proc
          mountPath: /host/proc
          readOnly: true
        - name: sys
          mountPath: /host/sys
          readOnly: true
        - name: root
          mountPath: /host
          readOnly: true
          mountPropagation: HostToContainer
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 256Mi
        securityContext:
          privileged: false
          capabilities:
            add:
            - SYS_PTRACE
      volumes:
      - name: proc
        hostPath:
          path: /proc
      - name: sys
        hostPath:
          path: /sys
      - name: root
        hostPath:
          path: /
```

### KSM Grafana Dashboard Queries

```
# Memory saved by KSM (GB)
(node_ksm_pages_sharing - node_ksm_pages_shared) * on(instance) node_memory_page_size_bytes / 1e9

# KSM sharing efficiency ratio
node_ksm_pages_sharing / node_ksm_pages_shared

# KSM scan rate (pages per second)
rate(node_ksm_pages_scanned_total[5m])

# Percentage of physical memory saved by KSM
(node_ksm_pages_sharing - node_ksm_pages_shared) * on(instance) node_memory_page_size_bytes
/ on(instance) node_memory_MemTotal_bytes * 100
```

## KSM for KVM Virtual Machines

KVM is the primary consumer of KSM on hypervisor nodes. QEMU automatically calls `madvise(MADV_MERGEABLE)` on guest memory allocations when `kvm.ksm_enabled` is set.

### libvirt Configuration

```xml
<!-- VM configuration with KSM memory backing -->
<domain type='kvm'>
  <name>ubuntu-22.04-prod-01</name>
  <uuid>550e8400-e29b-41d4-a716-446655440000</uuid>
  <memory unit='GiB'>16</memory>
  <currentMemory unit='GiB'>16</currentMemory>
  <memoryBacking>
    <!-- Enable KSM for this VM's memory -->
    <ksm enable='yes'/>
    <!-- Huge pages conflict with KSM — use regular pages -->
    <!-- <hugepages/> -->
    <!-- nosharepages disables KSM for this specific VM -->
    <!-- <nosharepages/> -->
  </memoryBacking>
  <vcpu placement='static'>4</vcpu>
  <cpu mode='host-passthrough'>
    <topology sockets='1' cores='4' threads='1'/>
    <cache mode='passthrough'/>
    <!-- Mitigate L1TF/Spectre side channels that KSM can worsen -->
    <feature policy='require' name='md-clear'/>
    <feature policy='require' name='spec-ctrl'/>
  </cpu>
  <!-- rest of VM configuration -->
</domain>
```

### Measuring KSM Impact per VM

```bash
#!/bin/bash
# ksm-per-vm.sh — Estimate KSM savings per running KVM guest

echo "=== KSM Savings Estimate per VM ==="
echo ""

for vm in $(virsh list --name 2>/dev/null); do
    pid=$(virsh domid "${vm}" 2>/dev/null)
    [ -z "${pid}" ] && continue

    # Get QEMU process PID from libvirt domain ID
    qemu_pid=$(virsh dominfo "${vm}" | grep -i "OS Type" | head -1)
    qemu_pid=$(ps aux | grep "qemu.*${vm}" | grep -v grep | awk '{print $2}' | head -1)
    [ -z "${qemu_pid}" ] && continue

    if [ -f "/proc/${qemu_pid}/smaps_rollup" ]; then
        # KSM-saved pages show as "LazyFree" or can be estimated from Shared_Clean
        shared_clean=$(grep "^Shared_Clean:" /proc/${qemu_pid}/smaps_rollup | awk '{print $2}')
        shared_dirty=$(grep "^Shared_Dirty:" /proc/${qemu_pid}/smaps_rollup | awk '{print $2}')
        rss=$(grep "^Rss:" /proc/${qemu_pid}/smaps_rollup | awk '{print $2}')

        total_shared=$(( (${shared_clean:-0} + ${shared_dirty:-0}) ))
        printf "VM: %-30s RSS: %6d MB  Shared: %6d MB  Ratio: %.1f%%\n" \
            "${vm}" \
            "$(( rss / 1024 ))" \
            "$(( total_shared / 1024 ))" \
            "$(echo "scale=1; ${total_shared} * 100 / ${rss}" | bc 2>/dev/null || echo 0)"
    fi
done
```

## KSM for Container Workloads

For container hosts (Kubernetes nodes), KSM provides similar benefits when containers run from identical base images:

```bash
#!/bin/bash
# enable-ksm-container-host.sh — KSM tuning optimized for container workloads

# Container workloads have many more distinct processes than VMs,
# so they need more aggressive scanning.

# For a node with 128GB RAM running 100 containers:
echo 20000 > /sys/kernel/mm/ksm/pages_to_scan
echo 20 > /sys/kernel/mm/ksm/sleep_millisecs

# Higher sharing ratio is acceptable for containers
echo 1000 > /sys/kernel/mm/ksm/max_page_sharing

# Zero pages are extremely common in freshly started containers
echo 1 > /sys/kernel/mm/ksm/use_zero_pages

# Enable KSM advisor mode (kernel 6.1+) for automatic tuning
# Mode 2 uses the kernel's heuristic to auto-tune pages_to_scan
if [ -f /sys/kernel/mm/ksm/advisor_mode ]; then
    echo 2 > /sys/kernel/mm/ksm/run  # 2 = run with advisor enabled
    # Set bounds for the advisor
    echo 500 > /sys/kernel/mm/ksm/advisor_min_pages_to_scan
    echo 30000 > /sys/kernel/mm/ksm/advisor_max_pages_to_scan
    echo "KSM advisor mode enabled"
else
    echo 1 > /sys/kernel/mm/ksm/run
fi

echo "Container host KSM configuration applied"
```

## Security Implications

KSM introduces security considerations that production teams must understand before enabling it.

### Side-Channel: Memory Deduplication Timing Attacks

When two processes share a KSM-merged page, a write by one process triggers a copy-on-write page fault that is measurably slower than a write to a private page. This timing difference can be used by a malicious process to determine whether specific memory content (e.g., a cryptographic key) is present in another process's address space—a class of attack documented in CVE-2015-2877 and related research.

**Mitigations:**
1. Disable KSM for security-sensitive workloads using `madvise(MADV_UNMERGEABLE)`.
2. In Kubernetes, isolate security-sensitive namespaces to dedicated nodes with KSM disabled.
3. Use `nosharepages` in libvirt configurations for VMs processing PCI-DSS or HIPAA data.

### Rowhammer Interaction

KSM increases the probability of Rowhammer exploits by colocating physically adjacent memory pages from different security domains. When KSM merges pages from different VMs onto the same DRAM bank, a Rowhammer attack against one VM's merged pages has a higher probability of flipping bits in adjacent rows used by another VM.

**Mitigations:**
1. ECC RAM substantially reduces Rowhammer risk.
2. Kernel KPTI (Kernel Page Table Isolation) limits the scope of successful exploits.
3. Disable cross-VM KSM in multi-tenant environments where guest workloads are not trusted.

### Recommended Security Profile

```bash
#!/bin/bash
# ksm-security-profile.sh — Apply security-conscious KSM settings

# Disable KSM across NUMA nodes to limit cross-tenant physical proximity
echo 0 > /sys/kernel/mm/ksm/merge_across_nodes

# Limit max_page_sharing to reduce the blast radius of side-channel attacks.
# A lower value means fewer VMs can share a single physical page.
echo 64 > /sys/kernel/mm/ksm/max_page_sharing

# Do NOT enable zero-page merging in multi-tenant environments.
# Zero pages from different tenants should remain private.
echo 0 > /sys/kernel/mm/ksm/use_zero_pages

echo 1 > /sys/kernel/mm/ksm/run
echo "Security-focused KSM profile applied"
```

## Performance Impact Analysis

### CPU Overhead

KSM's `ksmd` thread consumes CPU proportional to `pages_to_scan / sleep_millisecs`. At default settings (100 pages/200ms), the overhead is negligible. Aggressive settings (20,000 pages/20ms) can consume 2–5% of a single CPU core.

```bash
#!/bin/bash
# Measure ksmd CPU usage over 60 seconds
echo "Monitoring ksmd CPU usage for 60 seconds..."

# Find ksmd PID
KSMD_PID=$(pgrep -x ksmd)
if [ -z "${KSMD_PID}" ]; then
    echo "ksmd is not running (KSM may be disabled)"
    exit 1
fi

# Sample CPU usage
pidstat -p "${KSMD_PID}" 5 12 | tee /tmp/ksmd-cpu-stats.txt

echo ""
echo "=== Summary ==="
awk '/ksmd/ {sum+=$8; count++} END {printf "Average CPU: %.2f%%\n", sum/count}' \
    /tmp/ksmd-cpu-stats.txt
```

### Write Latency Impact

Copy-on-write faults incurred when writing to a KSM-merged page add approximately 2–10 microseconds per fault under normal conditions. For workloads that write frequently to previously read-only pages, this latency can accumulate.

```c
/* Measure COW fault latency — userspace benchmark */
/* compile: gcc -O2 -o cow-bench cow-bench.c */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/mman.h>

#define PAGE_SIZE 4096
#define NUM_PAGES 1000

static long timespec_diff_ns(struct timespec start, struct timespec end) {
    return (end.tv_sec - start.tv_sec) * 1000000000L + (end.tv_nsec - start.tv_nsec);
}

int main(void) {
    /* Allocate and fill pages with identical content to encourage KSM merging */
    size_t size = NUM_PAGES * PAGE_SIZE;
    char *mem = mmap(NULL, size, PROT_READ|PROT_WRITE,
                     MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
    if (mem == MAP_FAILED) { perror("mmap"); return 1; }

    /* Fill all pages with the same pattern to encourage KSM */
    for (int i = 0; i < NUM_PAGES; i++) {
        memset(mem + i * PAGE_SIZE, 0xAB, PAGE_SIZE);
    }

    /* Mark as mergeable */
    if (madvise(mem, size, MADV_MERGEABLE) != 0) {
        perror("madvise MERGEABLE");
    }

    /* Wait for KSM to merge pages */
    printf("Waiting 10s for KSM to merge pages...\n");
    struct timespec ts = {10, 0};
    nanosleep(&ts, NULL);

    /* Benchmark write faults */
    struct timespec t0, t1;
    long total_ns = 0;

    for (int i = 0; i < NUM_PAGES; i++) {
        clock_gettime(CLOCK_MONOTONIC, &t0);
        mem[i * PAGE_SIZE] = 0xFF;  /* Triggers COW if page was merged */
        clock_gettime(CLOCK_MONOTONIC, &t1);
        total_ns += timespec_diff_ns(t0, t1);
    }

    printf("Average write fault latency: %.2f ns over %d pages\n",
           (double)total_ns / NUM_PAGES, NUM_PAGES);

    munmap(mem, size);
    return 0;
}
```

## NUMA-Aware KSM Configuration

On multi-socket servers, cross-NUMA merging can cause severe performance degradation because a write fault on a page merged from a remote NUMA node must access remote memory for the copy:

```bash
#!/bin/bash
# numa-ksm-check.sh — Validate KSM settings for NUMA topology

NUMA_NODES=$(ls -d /sys/devices/system/node/node* 2>/dev/null | wc -l)
MERGE_ACROSS=$(cat /sys/kernel/mm/ksm/merge_across_nodes)

echo "NUMA topology:"
numactl --hardware 2>/dev/null | grep -E "node [0-9]+ cpus:|node [0-9]+ size:"

echo ""
echo "KSM NUMA settings:"
echo "  merge_across_nodes: ${MERGE_ACROSS}"
echo "  NUMA node count: ${NUMA_NODES}"

if [ "${NUMA_NODES}" -gt 1 ] && [ "${MERGE_ACROSS}" -eq 1 ]; then
    echo ""
    echo "WARNING: merge_across_nodes=1 on a ${NUMA_NODES}-node NUMA system."
    echo "This can cause COW faults to access remote NUMA memory, adding 50-200ns latency."
    echo "Recommend: echo 0 > /sys/kernel/mm/ksm/merge_across_nodes"
fi

# Show per-NUMA-node memory usage
for node in $(ls -d /sys/devices/system/node/node* | xargs -I{} basename {}); do
    free_pages=$(cat /sys/devices/system/node/${node}/meminfo | grep MemFree | awk '{print $4}')
    total_pages=$(cat /sys/devices/system/node/${node}/meminfo | grep MemTotal | awk '{print $4}')
    echo "  ${node}: Free=$(( free_pages / 1024 ))MB / Total=$(( total_pages / 1024 ))MB"
done
```

## Practical Deployment Recommendations

### For KVM Hypervisors

| Parameter | Development | Production (trusted tenants) | Production (multi-tenant) |
|---|---|---|---|
| `run` | 1 | 1 | 0 or 1 with restrictions |
| `pages_to_scan` | 1000 | 10000 | 5000 |
| `sleep_millisecs` | 200 | 50 | 100 |
| `use_zero_pages` | 1 | 1 | 0 |
| `merge_across_nodes` | 1 | 0 (NUMA) | 0 |
| `max_page_sharing` | 256 | 256 | 64 |

### For Kubernetes Nodes

Enable KSM on nodes running many identical-image workloads (e.g., Java application servers, Node.js services). Disable or constrain it on nodes running:
- Database pods (high write rate creates frequent COW faults)
- GPU workloads (CUDA memory is typically not anonymous and not registered with KSM)
- Security-sensitive namespaces (use node taints + tolerations to isolate)

### Expected Savings by Workload

| Workload Type | Expected KSM Savings |
|---|---|
| 50 Ubuntu 22.04 VMs (no workload) | 35–50% of guest RAM |
| 50 VMs running identical Java apps | 25–40% of guest RAM |
| 100 identical Alpine containers | 30–45% of container RSS |
| Mixed diverse workloads | 5–15% of total RAM |
| Database servers (heavy writes) | <5% (COW overhead may exceed savings) |

KSM is most effective when the workload has high page-level redundancy—identical OS pages, shared libraries, and zero-initialized memory. Workloads with high write rates or highly unique data (encrypted blocks, compressed data) see minimal benefit and potential latency regression.
