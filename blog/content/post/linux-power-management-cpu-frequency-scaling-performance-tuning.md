---
title: "Linux Power Management and CPU Frequency Scaling: Performance Tuning for Workload-Specific Needs"
date: 2031-09-24T00:00:00-05:00
draft: false
tags: ["Linux", "Power Management", "CPU Scaling", "Performance", "Tuning", "cpupower"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux CPU frequency scaling, power governors, P-states, C-states, NUMA topology, and workload-specific performance tuning for production servers and Kubernetes nodes."
more_link: "yes"
url: "/linux-power-management-cpu-frequency-scaling-performance-tuning/"
---

CPU frequency scaling is one of the most impactful and least understood tuning levers in Linux system administration. A server set to an inappropriate power governor can exhibit up to 40% throughput degradation for latency-sensitive workloads, while servers running performance-heavy governors on lightly loaded systems waste significant energy. Understanding the full stack — from BIOS power settings through Linux kernel governors to workload-specific recommendations — is essential for maximizing both performance and efficiency in production environments.

This post covers the complete Linux power management stack: CPU frequency governors, P-states, C-states, NUMA memory effects, energy-aware scheduling, and practical tuning profiles for common production workloads including Kubernetes nodes, database servers, and high-frequency trading systems.

<!--more-->

# Linux Power Management and CPU Frequency Scaling

## The CPU Frequency Scaling Stack

```
┌─────────────────────────────────────────────────────────┐
│                   Workload Request                       │
│              (CPU-bound, I/O-bound, mixed)               │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│              Linux CPUFreq Subsystem                     │
│    Governor ──► Driver ──► Hardware Interface            │
│  (schedutil│performance│powersave│ondemand│conservative) │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                   CPU P-States                           │
│    Intel P-state / AMD P-state (performance levels)      │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                   CPU C-States                           │
│    C0 (active) │ C1 (halt) │ C3 (sleep) │ C6 (deep)     │
└─────────────────────────────────────────────────────────┘
```

## Viewing Current CPU Frequency State

```bash
# Current frequency for all CPUs
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq | paste - | column

# Detailed per-CPU info using cpupower
cpupower frequency-info -c all
# analyzing CPU 0:
#   driver: intel_pstate
#   CPUs which run at the same hardware frequency: 0
#   hardware limits: 800 MHz - 3.60 GHz
#   available cpufreq governors: performance powersave
#   current policy: frequency should be within 800 MHz and 3.60 GHz.
#                   The governor "performance" may decide which speed to use
#                   within this range.
#   current CPU frequency: 3.50 GHz (asserted by call to hardware)
#   boost state support:
#     Supported: yes
#     Active: yes

# Alternative: turbostat for real-time frequency measurement
turbostat --quiet --show CPU,Avg_MHz,Busy%,Bzy_MHz,TSC_MHz,IRQ

# Simpler: read /proc/cpuinfo
awk '/cpu MHz/{print NR": "$4" MHz"}' /proc/cpuinfo | head -16
```

## CPU Frequency Governors

The governor is the policy that decides what P-state to request based on CPU utilization:

| Governor | Behavior | Use Case |
|----------|----------|----------|
| `performance` | Always max frequency | Latency-sensitive, consistent performance |
| `powersave` | Always min frequency | Development, light workloads |
| `ondemand` | Jumps to max on load, scales down | General purpose (legacy) |
| `conservative` | Gradual scaling up/down | Power-sensitive environments |
| `schedutil` | CFS-scheduler-integrated scaling | Default on modern kernels |
| `userspace` | Manually controlled frequency | Testing, specialized control |

```bash
# View available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# performance powersave

# Check current governor (all CPUs)
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor | sort | uniq -c
#       96 schedutil

# Change to performance governor for all CPUs
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$cpu"
done

# Or use cpupower
cpupower frequency-set -g performance

# Verify
cpupower -c all frequency-info | grep "The governor"
```

### schedutil: The Modern Default

`schedutil` is integrated with the CFS scheduler and uses per-CPU utilization signals directly from the scheduler's `util_avg` values. It responds faster than `ondemand` (per-scheduler tick vs. timer-based sampling) and is more accurate about actual CPU pressure.

Tuning `schedutil` parameters:

```bash
# Rate limit (microseconds between frequency decisions)
# Default: 10000 (10ms). Lower = more responsive but more overhead
cat /sys/devices/system/cpu/cpufreq/schedutil/rate_limit_us

# For latency-sensitive workloads, reduce the rate limit
echo 500 > /sys/devices/system/cpu/cpufreq/schedutil/rate_limit_us

# Transition latency (hardware limit, not tunable)
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_transition_latency
# 4294967295 (unlimited, hardware decides)
```

## Intel P-States

Modern Intel CPUs use the `intel_pstate` driver rather than the legacy `acpi-cpufreq` driver. Intel P-states operate in two modes:

**Active mode**: The kernel requests a P-state and the hardware (HWP - Hardware-controlled Performance States) adjusts within that range.

**Passive mode**: Traditional CPUFreq governor model, compatible with all governors.

```bash
# Check which driver is active
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# intel_pstate (active mode)
# intel_cpufreq (passive mode)

# Check HWP status
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
# Available: default performance balance_performance balance_power power

# Set HWP preference for performance
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo performance > "$cpu" 2>/dev/null
done

# Switch intel_pstate to passive mode (enables all governors)
echo passive > /sys/devices/system/cpu/intel_pstate/status
# Revert: echo active > /sys/devices/system/cpu/intel_pstate/status
```

### Turbo Boost

Turbo Boost allows CPUs to temporarily exceed their base clock when thermal and power headroom permits:

```bash
# Check Turbo Boost status (0 = enabled, 1 = disabled)
cat /sys/devices/system/cpu/intel_pstate/no_turbo

# Disable Turbo Boost (for consistent latency, prevents thermal throttling)
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo

# Enable Turbo Boost
echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo

# Using cpupower
cpupower set --turbo-boost on

# Verify with turbostat
turbostat --show CPU,Avg_MHz,Bzy_MHz,TSC_MHz,Busy% --interval 1
```

For workloads requiring **consistent, predictable latency** (real-time processing, financial applications), disabling Turbo Boost eliminates thermal-throttling-induced latency spikes at the cost of peak throughput.

## AMD P-States

Modern AMD EPYC and Ryzen processors use `amd_pstate` or `amd_pstate_epp`:

```bash
# Check AMD P-state status
cat /sys/devices/system/cpu/amd_pstate/status
# active

# Available scaling drivers
ls /sys/devices/system/cpu/cpu0/cpufreq/
# amd-pstate-epp driver uses energy performance preference

# Set all CPUs to performance preference
for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo performance > "$f" 2>/dev/null
done

# AMD-specific: check current boost state
cat /sys/devices/system/cpu/cpufreq/boost
```

## C-States: Deep Sleep Tradeoffs

C-states are idle power states. Deeper states save more power but have higher wake latency:

| C-state | Latency | Power Saved | Description |
|---------|---------|-------------|-------------|
| C0 | 0 | 0% | Active execution |
| C1 | < 1 µs | 10-20% | Clock gated (halt instruction) |
| C1E | < 1 µs | 20-30% | Enhanced halt |
| C3 | < 50 µs | 40-50% | L1/L2 cache flush |
| C6 | < 200 µs | 60-70% | Core power gated |
| C7 | < 400 µs | 70-80% | LLC flushed |
| C8/C10 | ms range | > 80% | Package-level sleep |

For latency-sensitive workloads, deep C-states cause visible latency spikes:

```bash
# Disable all C-states deeper than C1
cpupower idle-set -d 2   # disable C-state index 2 and deeper

# Or set per-C-state via sysfs
for cpu in /sys/devices/system/cpu/cpu*/; do
    for cstate in "$cpu/cpuidle/state"*/; do
        state_name=$(cat "$cstate/name")
        case "$state_name" in
            POLL|C1|C1E) echo 0 > "$cstate/disable" ;;  # enable
            *)            echo 1 > "$cstate/disable" ;;  # disable
        esac
    done
done

# Verify current idle stats
cpupower idle-info -c 0

# Persistent configuration (RHEL/CentOS)
cat >> /etc/rc.d/rc.local <<'EOF'
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/; do
    [ "$(cat ${cpu}name)" = "C1" ] && continue
    [ "$(cat ${cpu}name)" = "POLL" ] && continue
    echo 1 > "${cpu}disable" 2>/dev/null
done
EOF
```

### kernel command line C-state control

```bash
# GRUB_CMDLINE_LINUX additions:

# Disable all C-states except C0 (maximum latency, minimum power savings)
# processor.max_cstate=0

# Limit to C1 (good balance for most server workloads)
# processor.max_cstate=1 idle=halt

# Intel-specific: limit to C1 without using ACPI idle driver
# intel_idle.max_cstate=1

# Disable mwait (forces use of HLT, simpler C-state model)
# idle=nomwait
```

## NUMA Memory and CPU Affinity

Non-Uniform Memory Access (NUMA) topology directly affects workload performance. Cross-NUMA memory accesses can be 2-3x slower than local memory accesses:

```bash
# View NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 48 49 50 51 52 53 54 55 56 57 58 59
# node 0 size: 128766 MB
# node 0 free: 32456 MB
# node 1 cpus: 12 13 14 15 16 17 18 19 20 21 22 23 60 61 62 63 64 65 66 67 68 69 70 71
# node 1 size: 128990 MB
# node 1 free: 45123 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# Run a process on NUMA node 0 exclusively
numactl --cpunodebind=0 --membind=0 my-latency-sensitive-app

# Bind a running process to a NUMA node
# (find existing PID first)
taskset -cp 0-23 $(pgrep my-app)

# View per-NUMA memory statistics
numastat
numastat -c  # per-process NUMA memory stats
numastat -n  # NUMA miss statistics
```

NUMA-aware Kubernetes:

```yaml
# Enable NUMA topology manager in kubelet
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
topologyManagerPolicy: single-numa-node   # restrict pods to single NUMA node
topologyManagerScope: pod
cpuManagerPolicy: static   # required for NUMA pinning to work
reservedSystemCPUs: "0-3"  # reserve for OS
```

```yaml
# Pod requesting NUMA-pinned resources
spec:
  containers:
    - name: latency-sensitive-app
      resources:
        requests:
          cpu: "16"          # exact CPU count for static policy
          memory: "32Gi"
          hugepages-2Mi: "4Gi"
        limits:
          cpu: "16"
          memory: "32Gi"
          hugepages-2Mi: "4Gi"
```

## IRQ Affinity

Interrupt requests (IRQs) from network interfaces and storage controllers should be balanced across CPU cores to prevent bottlenecks:

```bash
# View current IRQ affinity
cat /proc/interrupts | head -20

# View IRQ-to-CPU mapping
for irq in /proc/irq/*/smp_affinity_list; do
    echo "IRQ $(dirname $irq | xargs basename): $(cat $irq)"
done

# Assign NIC IRQs to specific CPUs
# First, find NIC IRQs
egrep "mlx5|eth0|ens" /proc/interrupts | awk '{print $1}' | tr -d ':'

# Bind IRQ 45 to CPUs 0-7
echo "ff" > /proc/irq/45/smp_affinity  # hex bitmask for CPUs 0-7

# Use irqbalance for automatic distribution
systemctl enable --now irqbalance

# Configure irqbalance to optimize for latency
cat > /etc/sysconfig/irqbalance <<'EOF'
IRQBALANCE_ARGS="--policyscript=/usr/share/irqbalance/default.policy"
IRQBALANCE_ONESHOT=0
EOF
```

## Workload-Specific Tuning Profiles

### Profile 1: Low-Latency (HFT, Real-Time Processing)

```bash
# /usr/local/bin/apply-latency-profile.sh
#!/bin/bash

echo "Applying low-latency CPU profile..."

# 1. Performance governor
cpupower frequency-set -g performance

# 2. Disable C-states (all except C1/POLL)
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/; do
    state_name=$(cat "${cpu}name" 2>/dev/null)
    [ "$state_name" = "C1" ] && echo 0 > "${cpu}disable" && continue
    [ "$state_name" = "POLL" ] && echo 0 > "${cpu}disable" && continue
    echo 1 > "${cpu}disable" 2>/dev/null
done

# 3. Disable Turbo Boost for consistent frequency
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null

# 4. Set min frequency = max frequency (prevent scaling)
MAX_FREQ=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_min_freq; do
    echo $MAX_FREQ > "$cpu"
done

# 5. Disable CPU SMT (Hyper-Threading) - reduces cache contention
# WARNING: reduces throughput; test before applying
# echo off > /sys/devices/system/cpu/smt/control

# 6. Reduce IRQ coalescing for network interfaces
for iface in $(ls /sys/class/net/ | grep -v lo); do
    ethtool -C "$iface" adaptive-rx off adaptive-tx off \
        rx-usecs 0 tx-usecs 0 2>/dev/null
done

# 7. Disable THP (transparent huge pages) - prevents GC pauses
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# 8. Kernel timer tuning
echo kernel.timer_migration=0 >> /etc/sysctl.d/99-latency.conf
sysctl -p /etc/sysctl.d/99-latency.conf

echo "Low-latency profile applied."
```

### Profile 2: Throughput-Optimized (Batch, ML/AI)

```bash
#!/bin/bash
# /usr/local/bin/apply-throughput-profile.sh

echo "Applying throughput CPU profile..."

# 1. Performance governor
cpupower frequency-set -g performance

# 2. Enable Turbo Boost for maximum throughput
echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null

# 3. Allow all C-states (saves power during memory-bound pauses)
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/; do
    echo 0 > "${cpu}disable" 2>/dev/null
done

# 4. Enable THP for large memory allocations
echo always > /sys/kernel/mm/transparent_hugepage/enabled
echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag

# 5. NUMA balancing on
echo 1 > /proc/sys/kernel/numa_balancing

# 6. IRQ balance optimized for throughput
systemctl restart irqbalance

echo "Throughput profile applied."
```

### Profile 3: Balanced (Kubernetes Worker Nodes)

```bash
#!/bin/bash
# /usr/local/bin/apply-balanced-profile.sh

echo "Applying balanced CPU profile for Kubernetes..."

# 1. schedutil governor (scheduler-integrated, responsive)
cpupower frequency-set -g schedutil

# 2. Tune schedutil for responsiveness
echo 500 > /sys/devices/system/cpu/cpufreq/schedutil/rate_limit_us 2>/dev/null

# 3. Enable Turbo Boost
echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null

# 4. Allow C-states up to C3 (balance latency/power)
cpupower idle-set -E   # enable all
cpupower idle-set -d 4 # disable C-states beyond index 3

# 5. Enable NUMA balancing for automatic page migration
echo 1 > /proc/sys/kernel/numa_balancing
echo 1000 > /proc/sys/kernel/numa_balancing_scan_period_min_ms
echo 60000 > /proc/sys/kernel/numa_balancing_scan_period_max_ms

# 6. Network interface tuning for mixed workloads
for iface in $(ls /sys/class/net/ | grep -v lo); do
    ethtool -C "$iface" adaptive-rx on adaptive-tx on 2>/dev/null
done

echo "Balanced profile applied."
```

## tuned: System-Wide Profile Management

`tuned` is the standard Linux tool for applying performance profiles:

```bash
# Install
dnf install -y tuned tuned-utils

# List available profiles
tuned-adm list
# Available profiles:
# - accelerator-performance - accelerator-performance
# - balanced - General non-specialized tuned profile
# - cpu-partitioning - Optimize for CPU partitioning
# - desktop - Optimize for the desktop use-case
# - hpc-compute - Optimize for HPC compute workloads
# - intel-sst - Configure for Intel Speed Select Technology
# - latency-performance - Optimize for deterministic performance at the cost of increased power consumption
# - network-latency - Optimize for deterministic performance at the cost of increased power consumption, focused on low latency network performance
# - network-throughput - Optimize for streaming network throughput, generally only necessary on older CPUs or 40G+ networks
# - optimize-serial-console - Optimize for serial console use
# - powersave - Spin down storage and apply aggressive power saving
# - throughput-performance - Broadly applicable tuning that provides excellent performance across a variety of common server workloads
# - virtual-guest - Optimize for running inside a virtual guest
# - virtual-host - Optimize for running KVM guests

# Apply profile
tuned-adm profile latency-performance
tuned-adm active

# Create custom profile
mkdir -p /usr/lib/tuned/kubernetes-node
cat > /usr/lib/tuned/kubernetes-node/tuned.conf <<'EOF'
[main]
summary=Kubernetes Worker Node Optimized Profile
include=throughput-performance

[cpu]
governor=schedutil
energy_perf_bias=performance
min_perf_pct=50

[scheduler]
numa_balancing=1

[sysctl]
kernel.numa_balancing=1
vm.swappiness=10
net.core.rmem_max=134217728
net.core.wmem_max=134217728
net.ipv4.tcp_rmem=4096 87380 134217728
net.ipv4.tcp_wmem=4096 65536 134217728

[vm]
transparent_hugepages=madvise
EOF

tuned-adm profile kubernetes-node
```

## Persistent Configuration with systemd

Apply CPU frequency settings at boot:

```bash
# /etc/systemd/system/cpu-performance.service
cat > /etc/systemd/system/cpu-performance.service <<'EOF'
[Unit]
Description=CPU Performance Profile
After=sysinit.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > $f; done'
ExecStart=/bin/bash -c 'echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo || true'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now cpu-performance
```

## Monitoring CPU Frequency in Production

```bash
# Real-time frequency monitoring with turbostat
turbostat --show CPU,Avg_MHz,Busy%,Bzy_MHz,TSC_MHz,POLL%,C1%,C3%,C6% \
    --interval 1

# Prometheus node_exporter CPU metrics
curl -s http://localhost:9100/metrics | grep node_cpu_scaling
# node_cpu_scaling_frequency_hertz{cpu="0"} 3.5e+09
# node_cpu_scaling_frequency_max_hertz{cpu="0"} 3.6e+09
# node_cpu_scaling_frequency_min_hertz{cpu="0"} 8e+08
```

Prometheus alert for frequency throttling:

```yaml
groups:
  - name: cpu_frequency
    rules:
      - alert: CPUFrequencyThrottled
        expr: |
          node_cpu_scaling_frequency_hertz /
          node_cpu_scaling_frequency_max_hertz < 0.7
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "CPU on {{ $labels.instance }} is throttled to {{ printf \"%.0f\" (mul $value 100) }}% of max"
          description: "Possible causes: thermal throttling, power limits, incorrect governor"

      - alert: CPUGovernorNotPerformance
        expr: |
          count by (instance) (
            node_cpu_info{governor!="performance", governor!="schedutil"}
          ) > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Non-performance CPU governor detected on {{ $labels.instance }}"
```

## BIOS/UEFI Settings

Linux kernel settings are overridden by BIOS power limits. Common BIOS settings to verify:

```
Power Management:
  [ ] Enable Power Cap / RAPL (set to max or disable)
  [X] Performance Per Watt Policy: Maximum Performance
  [ ] C-States: Disabled (for latency-sensitive) or C1 Only
  [ ] Turbo Boost: Enabled (for throughput) or Disabled (for consistency)
  [ ] P-States: OS Control (not autonomous)
  [ ] Power Capping: 250W+ (or disabled)

Memory:
  [X] Memory Operating Speed: Maximum
  [ ] Memory Power Management: Disabled
  [X] NUMA Interleaving: Disabled (enable only if NUMA-unaware workloads)
```

Check for RAPL (Running Average Power Limit) throttling:

```bash
# Check if RAPL is limiting CPU performance
cat /sys/class/powercap/intel-rapl/*/constraint_*/power_limit_uw
# e.g., 250000000 uw = 250 Watts

# Check for RAPL throttling events
turbostat --show CPU,Avg_MHz,IRQ,RINTR --interval 1 2>&1 | grep -i "throttle"

# Or use dmesg
dmesg | grep -i "cpu.*throttl\|power.*limit\|thermal"
```

## Summary

CPU frequency scaling profoundly impacts workload performance, and the default `schedutil` governor is a reasonable starting point for most workloads but not optimal for all. For latency-sensitive applications, disabling C-states and Turbo Boost while pinning to maximum frequency eliminates jitter at the cost of power consumption. For throughput-bound workloads, enabling Turbo Boost and allowing C-states during memory stalls can improve utilization. NUMA awareness, IRQ affinity, and BIOS power limits complete the picture. The key is measuring actual workload performance — using tools like `perf`, `turbostat`, and `numastat` — before and after changes, since the interaction between governor, C-states, Turbo Boost, and memory topology is complex enough that benchmark-driven validation is always necessary.
