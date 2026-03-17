---
title: "Linux Power Management: CPU Frequency Scaling and C-States"
date: 2029-06-12T00:00:00-05:00
draft: false
tags: ["Linux", "Power Management", "CPU", "Performance", "Kernel", "Datacenter"]
categories: ["Linux", "System Administration"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux CPU power management: cpufreq governors, Intel and AMD P-state drivers, C-state latency tradeoffs, tuned profiles, and datacenter power budgeting strategies for balancing performance against energy consumption."
more_link: "yes"
url: "/linux-power-management-cpu-frequency-scaling-cstates/"
---

CPU power management on Linux is a multi-layer system that affects everything from server response latency to energy costs. In cloud and bare-metal datacenters, the wrong governor can add milliseconds of latency to every request, while the wrong C-state configuration can prevent servers from saving power during idle periods. This guide covers the complete Linux CPU power management stack: hardware P-states and C-states, the Linux governors and drivers that manage them, and the operational tools for tuning production systems.

<!--more-->

# Linux Power Management: CPU Frequency Scaling and C-States

## The CPU Power Management Stack

Linux CPU power management operates at two independent dimensions:

```
High Performance ◄─────────────────────────► Low Power

P-states (frequency/voltage):
  P0    P1    P2    P3  ...  Pn
  Max  ────────────────────  Min
  (highest frequency)       (lowest frequency while running)

C-states (sleep depth):
  C0    C1    C1E   C3    C6    C7    C8    C10
  ────────────────────────────────────────────
  Active  ────────────────────  Deep sleep
  (running) (power gate all)   (full idle)
```

P-states manage frequency and voltage while the CPU is executing instructions. C-states manage how deeply the CPU sleeps when it has no work to do.

## P-States: Frequency and Voltage Scaling

### The cpufreq Framework

The Linux `cpufreq` subsystem is the userspace-visible interface for frequency scaling. It exposes a sysfs interface under `/sys/devices/system/cpu/`:

```bash
# Show current CPU frequency information
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# conservative ondemand userspace powersave performance schedutil

cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
# schedutil

cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
# 3600000  (in kHz = 3.6 GHz)

cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq
# 800000   (800 MHz minimum)

cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq
# 5000000  (5.0 GHz maximum)

# Show frequencies for all CPUs
for cpu in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq; do
    freq=$(cat "$cpu")
    mhz=$((freq / 1000))
    cpu_num=$(echo "$cpu" | grep -o 'cpu[0-9]*')
    printf "%s: %d MHz\n" "$cpu_num" "$mhz"
done
```

### cpufreq Governors

#### performance Governor

```bash
# Set all CPUs to performance governor
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > "$cpu"
done

# Or use cpupower utility
cpupower frequency-set -g performance

# Effect: CPU runs at maximum frequency at all times
# Use case: Latency-sensitive workloads, benchmarking, consistent response times
# Cost: Maximum power draw regardless of load
```

#### powersave Governor

```bash
cpupower frequency-set -g powersave
# Effect: CPU runs at minimum frequency at all times
# Use case: Idle servers, development machines
# Cost: Worst application performance
```

#### schedutil Governor (Linux 4.7+, Recommended Default)

```bash
cpupower frequency-set -g schedutil
# Effect: Frequency follows CPU utilization using scheduler signals
# More responsive than ondemand because it uses scheduler statistics
# rather than polling — transitions happen in microseconds

# Tune schedutil's rate limit
cat /sys/devices/system/cpu/cpufreq/policy0/schedutil/rate_limit_us
# 1000 (1ms — default minimum time between frequency changes)

# Lower for more responsive scaling (at cost of more transitions)
echo 500 > /sys/devices/system/cpu/cpufreq/policy0/schedutil/rate_limit_us
```

#### ondemand Governor

```bash
cpupower frequency-set -g ondemand

# Tuning parameters
cat /sys/devices/system/cpu/cpufreq/ondemand/up_threshold
# 95  (increase frequency when utilization exceeds 95%)

echo 80 > /sys/devices/system/cpu/cpufreq/ondemand/up_threshold
# More aggressive scaling

cat /sys/devices/system/cpu/cpufreq/ondemand/sampling_rate
# 20000  (sample every 20ms)
```

### Intel P-State Driver

Modern Intel processors use the `intel_pstate` driver instead of the generic cpufreq driver. It directly controls hardware P-states without going through the cpufreq governor framework.

```bash
# Check which driver is in use
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# intel_pstate   or   acpi-cpufreq

# intel_pstate modes
cat /sys/devices/system/cpu/intel_pstate/status
# active    — Intel P-state driver controls frequency autonomously
# passive   — cpufreq governors control Intel P-state driver
# off       — fall back to acpi-cpufreq

# Switch to passive mode to use cpufreq governors with intel_pstate
echo passive > /sys/devices/system/cpu/intel_pstate/status

# Or disable at boot:
# GRUB_CMDLINE_LINUX="intel_pstate=passive"
# GRUB_CMDLINE_LINUX="intel_pstate=disable"   # use acpi-cpufreq entirely

# In active mode, the governor choice is limited to performance or powersave
# These are wrappers that set the P-state range, not traditional governors:
# performance: EPP (Energy Performance Preference) = 0 (maximum performance)
# powersave:   EPP controlled by the EPP policy

# Energy Performance Preference (EPP) — Intel hardware hint
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
# balance_performance

cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_available_preferences
# default performance balance_performance balance_power power

# For latency-sensitive servers:
for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo performance > "$f"
done
```

### AMD P-State Driver

```bash
# AMD equivalent (AMD processors use amd_pstate)
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# amd-pstate-epp   or   amd_pstate_ut (Zen 4+)

# AMD has three modes:
# disable  — use acpi-cpufreq
# passive  — use cpufreq governors
# active   — AMD P-state driver autonomous mode (like Intel active)
# guided   — hybrid: Linux hints, hardware decides within hints

cat /sys/devices/system/cpu/amd_pstate/status
# active

# Set EPP preference on AMD
for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo performance > "$f"
done
```

## C-States: CPU Sleep Depths

C-states define how deeply a CPU core sleeps when it has no work to do. Deeper C-states save more power but have higher wakeup latency.

### C-State Reference Table (Intel)

| State | Name | Exit Latency | Power Saved | Description |
|---|---|---|---|---|
| C0 | Active | 0 | 0% | Executing instructions |
| C1 | Halt | ~1µs | ~10% | Halt instruction, fast wake |
| C1E | Enhanced Halt | ~10µs | ~15% | C1 + voltage reduction |
| C3 | Sleep | ~50-80µs | ~30% | Cache flushes, shared cache off |
| C6 | Deep Power Down | ~100-300µs | ~60% | Core voltage gated |
| C7 | Enhanced C6 | ~200µs | ~70% | LLC power gated |
| C8/C10 | Package C-state | ~300µs-1ms | ~80%+ | Package-level gating |

The key insight: deeper C-states dramatically increase the latency of the first response after an idle period. For services with strict P99 latency SLAs, deep C-states can add hundreds of microseconds to tail latencies.

### Viewing C-State Statistics

```bash
# List available C-states and their usage
grep -r "" /sys/devices/system/cpu/cpu0/cpuidle/state*/

# More readable format using turbostat
turbostat --quiet --show Busy%,CPU%c1,CPU%c3,CPU%c6,CPU%c7 --interval 1

# Output example:
# Busy%  CPU%c1  CPU%c3  CPU%c6  CPU%c7
# 45.2   12.3    5.1     30.2    7.2

# cpupower idle-info
cpupower idle-info

# powertop for interactive monitoring
powertop
```

### Limiting C-States

```bash
# Method 1: Disable specific C-states via sysfs
# 0 = enable, 1 = disable
echo 1 > /sys/devices/system/cpu/cpu0/cpuidle/state3/disable  # Disable C3 on cpu0

# Disable on all CPUs
for cpu in /sys/devices/system/cpu/cpu*/; do
    for state in "$cpu"/cpuidle/state{3,4,5,6,7,8,9,10}/; do
        [ -f "${state}disable" ] && echo 1 > "${state}disable"
    done
done

# Method 2: Set latency requirement via PM QoS
# Tell the kernel that you need wakeup latency below X microseconds
# This automatically limits C-states to those within the latency budget
echo 10 > /dev/cpu_dma_latency  # Keep file open to maintain the requirement

# In Go:
f, _ := os.OpenFile("/dev/cpu_dma_latency", os.O_WRONLY, 0)
binary.Write(f, binary.LittleEndian, int32(10))
// Keep f open for the duration of the latency-sensitive period
defer f.Close()

# Method 3: Boot parameter — global max C-state depth
# Kernel boot parameter: processor.max_cstate=1
# Limits all CPUs to C1 at most (fast wakeup, higher idle power)
```

### Measuring C-State Impact on Latency

```bash
# cyclictest: measure scheduler and interrupt latency
apt install rt-tests
cyclictest --threads --priority=80 --distance=0 --interval=200 --histogram=400 --loops=10000

# Compare with C-states enabled vs disabled:
# C-states enabled:  P99 latency ~200µs, occasional spikes to 1ms+
# C-states disabled: P99 latency ~20µs, no spikes

# For Kubernetes nodes, use this test before enabling C-state limits:
for cpu in $(seq 0 $(($(nproc)-1))); do
    stress-ng --cpu 1 --cpu-affinity $cpu &
done
# Observe latency under load vs at idle
```

## Turbo Boost

Turbo Boost (Intel) and Precision Boost (AMD) allow CPUs to run above their base frequency when thermal and power headroom permit.

```bash
# Check if turbo is enabled
cat /sys/devices/system/cpu/intel_pstate/no_turbo
# 0 = turbo enabled, 1 = turbo disabled

# Disable turbo for consistent (non-bursty) performance
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo

# For acpi-cpufreq driver
echo 0 > /sys/devices/system/cpu/cpufreq/boost

# Why disable turbo?
# 1. Turbo frequency is not sustainable — it degrades under sustained load
# 2. Frequency changes cause latency spikes
# 3. Power capping in datacenters can force sudden frequency drops
# 4. More predictable performance for benchmarking and capacity planning
```

## tuned: Profile-Based Power Management

`tuned` is a daemon that applies a set of power management settings as a named profile. It is the standard way to configure power management on RHEL/CentOS/Fedora/AlmaLinux.

```bash
# Install tuned
dnf install tuned

# List available profiles
tuned-adm list

# Available profiles (common ones):
# balanced            — Default: moderate power savings
# performance         — Maximum performance
# latency-performance — Low latency + performance (no power saving)
# throughput-performance — CPU performance + network throughput
# network-latency     — Very low network latency
# network-throughput  — Maximum network throughput
# powersave           — Maximum power savings
# virtual-guest       — Optimized for running inside a VM
# virtual-host        — Optimized for a VM host

# Apply a profile
tuned-adm profile latency-performance

# Verify active profile
tuned-adm active
# Current active profile: latency-performance

# Check what settings the profile applies
tuned-adm profile-info latency-performance
```

### Creating a Custom tuned Profile

```bash
mkdir /etc/tuned/datacenter-performance
cat > /etc/tuned/datacenter-performance/tuned.conf <<'EOF'
[main]
summary=Datacenter performance profile with controlled C-states
include=throughput-performance

[cpu]
governor=performance
energy_perf_bias=performance
min_perf_pct=100
max_perf_pct=100
# Limit to C1 state (no deep sleep)
# latency=1 sets the PM QoS latency requirement to 1µs
latency=1

[vm]
transparent_hugepages=always

[disk]
# Disable disk power management for low-latency I/O
elevator=none
readahead=4096

[sysctl]
# Minimize timer interrupts
kernel.nmi_watchdog=0
kernel.timer_migration=0
vm.swappiness=1
net.core.busy_read=50
net.core.busy_poll=50
net.ipv4.tcp_fastopen=3
EOF

tuned-adm profile datacenter-performance
```

## Datacenter Power Budgeting

### RAPL: Running Average Power Limit

Intel RAPL (Running Average Power Limit) provides per-domain power limiting and measurement:

```bash
# Install powercap tools
apt install powercap-utils

# List available power zones
powercap-info -p intel-rapl

# Read current power consumption
cat /sys/class/powercap/intel-rapl:0/energy_uj  # Package 0 energy in microjoules
# Read it twice with a delay to calculate power:
E1=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
sleep 1
E2=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
echo "Power: $(( (E2 - E1) / 1000000 )) W"

# Set a power cap (limit package to 65W)
powercap-set -p intel-rapl -z 0 -c 0 -l 65000000  # in microwatts

# Read power limits
powercap-info -p intel-rapl -z 0 -c 0
```

### AMD RAPL (Zen 2+)

```bash
# AMD uses the same RAPL interface
cat /sys/class/powercap/intel-rapl:0/constraint_0_max_power_uw
cat /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw
```

### turbostat for Power Monitoring

```bash
# Comprehensive CPU state monitoring
turbostat --interval 5 --quiet --show \
    "Package,Core,CPU,Avg_MHz,Busy%,Bzy_MHz,TSC_MHz,IRQ,SMI,POLL,C1%,C3%,C6%,C7%,PkgWatt,RAMWatt,GFXWatt"

# Example output:
# Package  Core  CPU  Avg_MHz  Busy%  Bzy_MHz  PkgWatt  RAMWatt
#       0     0    0     2400   66.7     3600    45.2      8.1
#       0     0    4     1800   50.0     3600    45.2      8.1
```

### Power vs. Performance Tradeoffs

```bash
# Measure the cost of performance governor
tuned-adm profile powersave
sleep 5
POWER_SAVING=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
sleep 10
POWER_SAVING_END=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
SAVING_WATTS=$(( (POWER_SAVING_END - POWER_SAVING) / 10000000 ))

tuned-adm profile performance
sleep 5
POWER_PERF=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
sleep 10
POWER_PERF_END=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
PERF_WATTS=$(( (POWER_PERF_END - POWER_PERF) / 10000000 ))

echo "Powersave: ${SAVING_WATTS}W"
echo "Performance: ${PERF_WATTS}W"
echo "Difference: $(( PERF_WATTS - SAVING_WATTS ))W"

# Annual cost at $0.12/kWh with 1000 servers:
# 20W difference * 1000 servers * 8760h * $0.12/kWh = $21,024/year
```

## NUMA Power Management

On multi-socket systems, NUMA topology affects which package-level C-states are achievable:

```bash
# Check NUMA topology
numactl --hardware
lscpu | grep -E "NUMA|Socket"

# All cores in a package must be in compatible C-states for package C-states to activate
# If any core is in C0 on a socket, the package cannot enter deep C-states
# This is why busy workloads on a few cores can prevent package-level power savings

# NUMA-aware power management: consolidate workloads on one socket
# to allow the other socket to enter deep package C-states

# Check package C-state residency
turbostat --show "Package,Pkg%pc2,Pkg%pc3,Pkg%pc6,Pkg%pc7,Pkg%pc8,Pkg%pc10" --interval 5
```

## Kubernetes Power Management Considerations

### CPU Manager Policy

```yaml
# Kubelet configuration for CPU management
# topology-manager-policy: single-numa-node ensures NUMA-local allocation
# cpu-manager-policy: static ensures exclusive CPU allocation for Guaranteed pods
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
topologyManagerPolicy: single-numa-node
systemReservedCgroup: /system.slice
kubeReservedCgroup: /system.slice
```

### Power-Aware Scheduling

```bash
# Node labels for power profile visibility
kubectl label node worker-01 power-profile=performance
kubectl label node worker-02 power-profile=powersave

# Node taint for latency-sensitive workloads
kubectl taint node worker-01 latency=low:NoSchedule
```

```yaml
# Pod spec requesting a low-latency node
spec:
  tolerations:
  - key: latency
    operator: Equal
    value: low
    effect: NoSchedule
  nodeSelector:
    power-profile: performance
```

## Comprehensive Power Management Script

```bash
#!/bin/bash
# configure-power.sh — apply power management profile to a server

set -euo pipefail

PROFILE="${1:-balanced}"

case "$PROFILE" in
  latency)
    # Minimize latency: max frequency, no deep C-states
    cpupower frequency-set -g performance
    # Disable C-states deeper than C1
    for cpu in /sys/devices/system/cpu/cpu*/; do
      for state in "${cpu}cpuidle/state"[2-9]/ "${cpu}cpuidle/state"1[0-9]/; do
        [ -f "${state}disable" ] && echo 1 > "${state}disable"
      done
    done
    # Enable turbo
    [ -f /sys/devices/system/cpu/intel_pstate/no_turbo ] && \
      echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo
    # Set EPP to performance
    for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
      [ -f "$f" ] && echo performance > "$f"
    done
    echo "Applied: latency profile"
    ;;

  power)
    # Maximize power savings: lowest frequency, deep C-states
    cpupower frequency-set -g powersave
    # Enable all C-states
    for cpu in /sys/devices/system/cpu/cpu*/; do
      for state in "${cpu}cpuidle/state"*/; do
        [ -f "${state}disable" ] && echo 0 > "${state}disable"
      done
    done
    # Disable turbo
    [ -f /sys/devices/system/cpu/intel_pstate/no_turbo ] && \
      echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
    echo "Applied: power saving profile"
    ;;

  balanced|*)
    cpupower frequency-set -g schedutil
    # Allow C1 and C1E, disable C3+
    for cpu in /sys/devices/system/cpu/cpu*/; do
      for state in "${cpu}cpuidle/state"[3-9]/ "${cpu}cpuidle/state"1[0-9]/; do
        [ -f "${state}disable" ] && echo 1 > "${state}disable"
      done
    done
    echo "Applied: balanced profile"
    ;;
esac
```

## Summary

Linux CPU power management is a layered system where the wrong configuration at any layer can cause either unnecessary power consumption or unexpected latency spikes.

For production servers:

- **Latency-sensitive workloads** (databases, trading systems, real-time services): use `performance` governor or `latency-performance` tuned profile, limit C-states to C1/C1E, set EPP to `performance`.
- **General application servers**: use `schedutil` governor or `throughput-performance` tuned profile, allow C-states up to C6.
- **Batch/background workloads**: use `powersave` governor or `powersave` tuned profile, allow all C-states.
- **Kubernetes nodes**: use CPU Manager with `static` policy for Guaranteed pods requiring deterministic CPU behavior.

The 2-10x difference in idle power consumption between deep C-states and no C-states is significant at scale — but so is the 200-500µs latency penalty for waking from deep sleep. Measure both against your SLAs before choosing a profile.
