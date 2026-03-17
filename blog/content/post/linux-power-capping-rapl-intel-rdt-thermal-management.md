---
title: "Linux Power Capping: RAPL, Intel RDT, and Thermal Management"
date: 2029-11-19T00:00:00-05:00
draft: false
tags: ["Linux", "Power Management", "RAPL", "Intel RDT", "Datacenter", "Performance"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Comprehensive guide to Linux power management for datacenters: RAPL energy domains, powercap sysfs interface, Intel RDT cache allocation, thermal throttling detection, and datacenter power budgeting strategies."
more_link: "yes"
url: "/linux-power-capping-rapl-intel-rdt-thermal-management/"
---

Datacenter power management has moved from a facilities concern to a software engineering discipline. As compute density increases and cooling becomes a strategic constraint, the ability to programmatically measure, limit, and optimize power consumption at the CPU level is a competitive advantage. Linux exposes this capability through RAPL (Running Average Power Limit), the powercap sysfs framework, and Intel RDT (Resource Director Technology). This guide covers each of these mechanisms in depth, with practical examples for datacenter power budgeting, thermal throttling detection, and cloud-native resource management.

<!--more-->

# Linux Power Capping: RAPL, Intel RDT, and Thermal Management

## RAPL: Running Average Power Limit

RAPL is Intel's power measurement and capping mechanism, available on Sandy Bridge (2011) and later processors. AMD introduced similar functionality (AMD RAPL) on Zen processors. RAPL operates on a model where the hardware continuously measures actual power consumption and the operating system can query these measurements or set power limits that the hardware enforces.

### Energy Domains

RAPL organizes power management into hierarchical energy domains:

**Package (PKG)**: The entire CPU socket, including cores, last-level cache, memory controller, and uncore components. This is the top-level domain for power budgeting.

**Power Plane 0 (PP0)**: The CPU cores only, excluding the uncore. On client processors, this is the primary domain for compute-heavy workloads.

**Power Plane 1 (PP1)**: The GPU on processors with integrated graphics (client platforms only; absent on server processors).

**DRAM**: Memory power consumption. Available on server processors, allowing independent memory power limits.

**Uncore**: Platform components not in PP0 or PP1 (last-level cache, memory controller, QPI/UPI links).

**Platform**: Total platform power (PSys on some Skylake+ processors).

```
Package (PKG)
├── PP0 (CPU Cores)
│   ├── Core 0
│   ├── Core 1
│   └── ... N cores
├── Uncore (LLC, Memory Controller, I/O)
├── PP1 (iGPU — client only)
└── DRAM (server processors)
```

### Accessing RAPL via Powercap sysfs

The `intel_rapl` kernel module exposes RAPL domains through the powercap sysfs hierarchy:

```bash
# Load the RAPL driver (usually loaded by default on modern kernels)
modprobe intel_rapl_msr    # For MSR-based RAPL
modprobe intel_rapl_mmio   # For MMIO-based RAPL (newer platforms)

# Explore the powercap hierarchy
ls /sys/devices/virtual/powercap/intel-rapl/

# Typical structure:
# intel-rapl:0/              — Package 0 (socket 0)
# intel-rapl:1/              — Package 1 (socket 1, NUMA systems)
# intel-rapl:0:0/            — PP0 of package 0 (CPU cores)
# intel-rapl:0:1/            — PP1 of package 0 (iGPU or DRAM)
# intel-rapl:0:2/            — DRAM of package 0 (server)

# Package domain details
cat /sys/devices/virtual/powercap/intel-rapl/intel-rapl:0/name
# package-0

cat /sys/devices/virtual/powercap/intel-rapl/intel-rapl:0:0/name
# core

cat /sys/devices/virtual/powercap/intel-rapl/intel-rapl:0:1/name
# uncore  # or dram on server platforms
```

### Reading Power Consumption

```bash
# Read current energy counter (in microjoules)
# This counter increments continuously; calculate power as delta/time
RAPL_DIR=/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0

cat $RAPL_DIR/energy_uj
# 234567890123  (microjoules since last reset or counter wraparound)

# Maximum energy counter value (for wraparound detection)
cat $RAPL_DIR/max_energy_range_uj
# 262143328850  (varies by processor)

# Simple power measurement script
measure_power() {
    local domain=$1
    local interval=${2:-1}
    local rapl_path="/sys/devices/virtual/powercap/intel-rapl/$domain"

    local e1=$(cat $rapl_path/energy_uj)
    sleep $interval
    local e2=$(cat $rapl_path/energy_uj)

    local delta=$((e2 - e1))
    # Handle counter wraparound
    if [ $delta -lt 0 ]; then
        local max=$(cat $rapl_path/max_energy_range_uj)
        delta=$((max - e1 + e2))
    fi

    local power_mw=$((delta / interval / 1000))
    echo "Power: ${power_mw} mW (${power_mw%???}.${power_mw: -3} W)"
}

# Measure package-0 power over 2 seconds
measure_power "intel-rapl:0" 2
# Power: 45123 mW (45.123 W)

# Measure all domains
for domain in /sys/devices/virtual/powercap/intel-rapl/intel-rapl:*/; do
    name=$(cat $domain/name)
    power=$(measure_power $(basename $domain) 1)
    echo "$name: $power"
done
```

### Setting Power Limits

RAPL supports two constraint windows per domain: short-term (window 1) and long-term (window 2). Short-term allows burst power above the average limit for brief periods.

```bash
RAPL_DIR=/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0

# View current constraints
cat $RAPL_DIR/constraint_0_name          # long_term
cat $RAPL_DIR/constraint_0_power_limit_uw  # current limit in microwatts
cat $RAPL_DIR/constraint_0_time_window_us  # averaging window in microseconds
cat $RAPL_DIR/constraint_0_max_power_uw    # hardware maximum power

cat $RAPL_DIR/constraint_1_name          # short_term
cat $RAPL_DIR/constraint_1_power_limit_uw
cat $RAPL_DIR/constraint_1_time_window_us

# Example: Set 65W long-term limit, 80W short-term limit for package-0
# Values are in microwatts (1W = 1,000,000 uW)

# Enable the constraint (must be enabled to take effect)
echo 1 > $RAPL_DIR/enabled

# Set long-term limit: 65W over 28-second window (default window)
echo 65000000 > $RAPL_DIR/constraint_0_power_limit_uw

# Set short-term limit: 80W over 976 microsecond window
echo 80000000 > $RAPL_DIR/constraint_1_power_limit_uw

# Verify
cat $RAPL_DIR/constraint_0_power_limit_uw
# 65000000
```

### RAPL Power Capping Script

```bash
#!/usr/bin/env bash
# rapl-cap.sh — Set package power limits across all NUMA sockets

set -euo pipefail

LONG_TERM_WATTS=${1:-65}
SHORT_TERM_WATTS=${2:-80}

LONG_TERM_UW=$((LONG_TERM_WATTS * 1000000))
SHORT_TERM_UW=$((SHORT_TERM_WATTS * 1000000))

POWERCAP_BASE="/sys/devices/virtual/powercap/intel-rapl"

# Find all package domains (not sub-domains)
for pkg_dir in $POWERCAP_BASE/intel-rapl:*/; do
    # Skip sub-domains (they have a second colon: intel-rapl:0:0)
    basename=$(basename $pkg_dir)
    if [[ $(echo $basename | tr -cd ':' | wc -c) -gt 1 ]]; then
        continue
    fi

    name=$(cat $pkg_dir/name)
    max_power=$(cat $pkg_dir/constraint_0_max_power_uw)

    # Safety check: don't set limits above hardware maximum
    if [ $LONG_TERM_UW -gt $max_power ]; then
        echo "WARNING: Requested ${LONG_TERM_WATTS}W exceeds max $((max_power/1000000))W for $name"
        LONG_TERM_UW=$max_power
    fi

    echo "Setting power limits for $name ($basename):"
    echo "  Long-term:  ${LONG_TERM_WATTS}W"
    echo "  Short-term: ${SHORT_TERM_WATTS}W"

    echo $LONG_TERM_UW  > $pkg_dir/constraint_0_power_limit_uw
    echo $SHORT_TERM_UW > $pkg_dir/constraint_1_power_limit_uw
    echo 1 > $pkg_dir/enabled

    echo "  Status: enabled"
done

echo "Power limits applied successfully"
```

### RAPL via Perf

```bash
# perf can read RAPL counters directly
perf stat -e 'power/energy-pkg/,power/energy-cores/,power/energy-ram/' \
  sleep 5

# Output:
# Performance counter stats for 'sleep 5':
#
#        234.56 Joules power/energy-pkg/
#        156.78 Joules power/energy-cores/
#         45.12 Joules power/energy-ram/
#
#       5.001234985 seconds time elapsed

# Run a workload and measure its total energy consumption
perf stat -e 'power/energy-pkg/' ./my-compute-workload

# Calculate average power: energy_joules / elapsed_seconds = watts
```

## Intel Resource Director Technology (RDT)

Intel RDT, available on Broadwell Xeon and later, provides mechanisms to monitor and control how CPU cache (LLC) and memory bandwidth are used by different workloads. This is critical for cloud environments where tenant workloads compete for shared hardware resources.

### RDT Components

**Cache Monitoring Technology (CMT)**: Monitor how much LLC cache a process occupies.

**Memory Bandwidth Monitoring (MBM)**: Monitor memory bandwidth consumed by a process.

**Cache Allocation Technology (CAT)**: Limit the LLC cache ways available to a process or set of processes.

**Memory Bandwidth Allocation (MBA)**: Limit memory bandwidth available to a process.

**Code and Data Prioritization (CDP)**: Separately allocate LLC ways to code versus data.

### Checking RDT Support

```bash
# Check CPU flags for RDT support
grep -o 'rdt[a-z_]*' /proc/cpuinfo | sort -u
# rdtm  (monitoring)
# rdta  (allocation)

# Or via kernel's resctrl
mount -t resctrl resctrl /sys/fs/resctrl
ls /sys/fs/resctrl/
# cpus           — CPUs in the default group
# cpus_list      — CPU list in human-readable format
# info/          — RDT capability information
# schemata       — Current allocation for default group
# tasks          — Tasks in default group
# mon_data/      — Monitoring data
# mon_groups/    — Monitoring groups
```

### Exploring RDT Capabilities

```bash
# Cache Allocation Technology info
cat /sys/fs/resctrl/info/L3/num_closids
# 16  (number of available allocation groups)

cat /sys/fs/resctrl/info/L3/cbm_mask
# 7ff  (full bitmask: 11 cache ways available)

cat /sys/fs/resctrl/info/L3/min_cbm_bits
# 1  (minimum bits in mask that must be set)

# Memory Bandwidth Allocation info
cat /sys/fs/resctrl/info/MB/bandwidth_gran
# 10  (granularity: multiples of 10%)

cat /sys/fs/resctrl/info/MB/min_bandwidth
# 10  (minimum: 10%)

cat /sys/fs/resctrl/info/MB/num_closids
# 8
```

### Cache Allocation with CAT

```bash
# View current schemata (allocation configuration)
cat /sys/fs/resctrl/schemata
# L3:0=7ff;1=7ff   (all 11 ways for both NUMA nodes, default)
# MB:0=max;1=max   (full bandwidth)

# Create resource groups for high-priority and low-priority workloads
mkdir /sys/fs/resctrl/high-priority
mkdir /sys/fs/resctrl/low-priority
mkdir /sys/fs/resctrl/best-effort

# Assign cache ways using bitmasks
# 11 ways total (0x7ff = 0b11111111111)
# high-priority: all 11 ways (can use full cache)
echo "L3:0=7ff;1=7ff" > /sys/fs/resctrl/high-priority/schemata

# low-priority: 7 ways (0x7f = 0b1111111)
echo "L3:0=07f;1=07f" > /sys/fs/resctrl/low-priority/schemata

# best-effort: 4 ways, non-overlapping with high-priority exclusive region
# 0x780 = 0b11110000000 (upper 4 ways)
echo "L3:0=780;1=780" > /sys/fs/resctrl/best-effort/schemata

# Assign processes to resource groups
# Method 1: By PID
echo $PID_OF_HIGH_PRIORITY_PROCESS > /sys/fs/resctrl/high-priority/tasks
echo $PID_OF_LOW_PRIORITY_PROCESS > /sys/fs/resctrl/low-priority/tasks

# Method 2: By CPU (all tasks on these CPUs use this group)
echo "0-7" > /sys/fs/resctrl/high-priority/cpus_list    # CPUs 0-7
echo "8-15" > /sys/fs/resctrl/low-priority/cpus_list    # CPUs 8-15
```

### Memory Bandwidth Allocation

```bash
# Limit best-effort workloads to 30% of memory bandwidth
echo "MB:0=30;1=30" > /sys/fs/resctrl/best-effort/schemata

# Full spec: both cache and bandwidth allocation together
cat > /sys/fs/resctrl/best-effort/schemata << 'EOF'
L3:0=780;1=780
MB:0=30;1=30
EOF

# Verify
cat /sys/fs/resctrl/best-effort/schemata
# L3:0=780;1=780
# MB:0=30;1=30
```

### Cache Monitoring with CMT

```bash
# Create monitoring groups to track LLC usage per workload
mkdir /sys/fs/resctrl/mon_groups/my-workload

# Assign the process to monitor
echo $PID > /sys/fs/resctrl/mon_groups/my-workload/tasks

# Read LLC occupancy (in bytes)
cat /sys/fs/resctrl/mon_groups/my-workload/mon_data/mon_L3_00/llc_occupancy
# 8388608  (8 MB of LLC occupied)

# Read memory bandwidth
cat /sys/fs/resctrl/mon_groups/my-workload/mon_data/mon_L3_00/mbm_total_bytes
# 1073741824  (total bytes read from/written to memory)

cat /sys/fs/resctrl/mon_groups/my-workload/mon_data/mon_L3_00/mbm_local_bytes
# 536870912  (bytes to local NUMA node)
```

### RDT Monitoring Script

```bash
#!/usr/bin/env bash
# rdt-monitor.sh — Continuously monitor LLC and memory bandwidth per group

while true; do
    echo "=== $(date) ==="
    for group in /sys/fs/resctrl/mon_groups/*/; do
        name=$(basename $group)
        for node_dir in $group/mon_data/*/; do
            node=$(basename $node_dir)
            llc=$(cat $node_dir/llc_occupancy 2>/dev/null || echo "N/A")
            mbm=$(cat $node_dir/mbm_total_bytes 2>/dev/null || echo "N/A")
            echo "  $name/$node: LLC=${llc} bytes, MBM=${mbm} bytes"
        done
    done
    sleep 5
done
```

## Thermal Management

### Thermal Zones and Trip Points

```bash
# List all thermal zones
for zone in /sys/class/thermal/thermal_zone*/; do
    type=$(cat $zone/type 2>/dev/null)
    temp=$(cat $zone/temp 2>/dev/null)
    echo "$(basename $zone) ($type): ${temp}°C ($(echo "scale=1; $temp/1000" | bc)°C)"
done

# Example output:
# thermal_zone0 (x86_pkg_temp): 55000°C (55.0°C)
# thermal_zone1 (acpitz): 27800°C (27.8°C)
# thermal_zone2 (pch_skylake): 52000°C (52.0°C)

# Inspect trip points for package thermal zone
zone=/sys/class/thermal/thermal_zone0
for i in 0 1 2 3; do
    trip_type=$(cat $zone/trip_point_${i}_type 2>/dev/null) || break
    trip_temp=$(cat $zone/trip_point_${i}_temp 2>/dev/null)
    echo "Trip $i: type=$trip_type temp=$(echo "scale=1; $trip_temp/1000" | bc)°C"
done

# Common trip types:
# active  — Enable a cooling device (fan)
# passive — Reduce CPU frequency (P-state throttling)
# hot     — Kernel warns, may trigger emergency
# critical — Emergency shutdown
```

### Detecting Thermal Throttling

```bash
# Method 1: Check for thermal throttle events via MSR
# Requires rdmsr tool (msr-tools package)
rdmsr -a 0x19C  # IA32_THERM_STATUS (per core)
# Bit 1: Thermal Throttle Status (1 = currently throttled)
# Bit 0: Thermal Throttle Log (1 = has been throttled since last clear)

# Method 2: Perf hardware events
perf stat -e 'cpu/event=0x3c,umask=0x01/' sleep 10
# (CPU_CLK_UNHALTED with thermal throttle mask)

# Method 3: powercap throttled flag
cat /sys/devices/virtual/powercap/intel-rapl/intel-rapl:0/constraint_0_max_power_uw
# If current power consumption > limit, throttling is occurring

# Method 4: turbostat (comprehensive thermal and frequency tool)
turbostat --interval 1 --show Package,Core,CPU,Avg_MHz,Busy%,Bzy_MHz,TSC_MHz,IPC,IRQ,SMI,Pkg%pc2,Pkg%pc6,Pkg%pc7,Pk%pc8,Pk%pc9,Pk%pc10,PkgWatt,CorWatt,RAMWatt,PKG_%,RAM_%

# turbostat output relevant to throttling:
# Bzy_MHz  — actual busy MHz (lower than max = throttling)
# PkgWatt  — package watts (near limit = power throttling)
# TSC_MHz  — time stamp counter MHz (consistent if not throttled)
```

### Monitoring Thermal Events with ftrace

```bash
# Enable thermal event tracing
echo 1 > /sys/kernel/debug/tracing/events/thermal/enable

# Watch for thermal events in real time
cat /sys/kernel/debug/tracing/trace_pipe

# Example output:
# kworker/0:2-123 [000] .... 12345.678901: thermal_temperature:
#   thermal_zone=x86_pkg_temp id=0 temp_prev=65000 temp=68000
# kworker/0:2-123 [000] .... 12345.679012: cdev_update:
#   type=Processor target=1  (reducing CPU to P-state 1)
```

### CPU Frequency and P-State Management

```bash
# Check current CPU frequency scaling
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
# powersave  or  performance  or  schedutil

# List available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# performance powersave

# Check current frequency
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
# 3600000  (3.6 GHz in kHz)

# Check if frequency is being limited by thermal throttling
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq
# If scaling_max_freq < cpuinfo_max_freq, governor has reduced the limit

# Set performance governor for latency-sensitive workloads
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $cpu
done

# Set energy-efficient governor (default on most modern systems)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo schedutil > $cpu
done
```

## Datacenter Power Budgeting

### Calculating TCO from Power Data

```bash
#!/usr/bin/env python3
# power-budget.py — Calculate datacenter power budget from RAPL measurements

import os
import time
import json

POWERCAP_BASE = "/sys/devices/virtual/powercap/intel-rapl"

def read_energy_uj(domain_path):
    try:
        with open(f"{domain_path}/energy_uj") as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return None

def get_domain_name(domain_path):
    try:
        with open(f"{domain_path}/name") as f:
            return f.read().strip()
    except FileNotFoundError:
        return "unknown"

def measure_power_watts(domain_path, interval=1.0):
    e1 = read_energy_uj(domain_path)
    if e1 is None:
        return None

    time.sleep(interval)

    e2 = read_energy_uj(domain_path)
    if e2 is None:
        return None

    delta_uj = e2 - e1
    if delta_uj < 0:  # Counter wraparound
        try:
            with open(f"{domain_path}/max_energy_range_uj") as f:
                max_uj = int(f.read().strip())
            delta_uj = max_uj - e1 + e2
        except (FileNotFoundError, ValueError):
            return None

    return (delta_uj / 1_000_000) / interval  # Joules/second = Watts

def collect_power_data():
    data = {}
    base_path = POWERCAP_BASE

    if not os.path.exists(base_path):
        return {}

    for entry in sorted(os.listdir(base_path)):
        domain_path = f"{base_path}/{entry}"
        if os.path.isdir(domain_path):
            name = get_domain_name(domain_path)
            watts = measure_power_watts(domain_path)
            if watts is not None:
                data[f"{entry} ({name})"] = round(watts, 3)

    return data

def calculate_tco(watts, pue=1.4, cost_per_kwh=0.12, hours_per_year=8760):
    """Calculate annual TCO based on power consumption"""
    # Total facility power = IT power * PUE
    total_watts = watts * pue

    # Annual energy consumption
    kwh_per_year = (total_watts / 1000) * hours_per_year

    # Annual electricity cost
    annual_cost = kwh_per_year * cost_per_kwh

    return {
        "it_power_w": watts,
        "total_facility_power_w": total_watts,
        "kwh_per_year": round(kwh_per_year, 2),
        "annual_electricity_cost_usd": round(annual_cost, 2),
        "pue": pue,
    }

if __name__ == "__main__":
    print("Measuring power consumption (2 second sample)...")
    power_data = collect_power_data()

    print("\nPower Measurements:")
    for domain, watts in power_data.items():
        print(f"  {domain}: {watts:.2f} W")

    # Get package-0 total for TCO calculation
    pkg_watts = next(
        (w for k, w in power_data.items() if "package-0" in k.lower()), None
    )

    if pkg_watts:
        print("\nTCO Analysis (per socket):")
        tco = calculate_tco(pkg_watts)
        for k, v in tco.items():
            print(f"  {k}: {v}")

        # Scale to rack (assume 20 servers, 2 sockets each)
        rack_pkg_watts = pkg_watts * 2 * 20  # 2 sockets * 20 servers
        rack_tco = calculate_tco(rack_pkg_watts)
        print("\nTCO Analysis (full rack, 20 servers x 2 sockets):")
        for k, v in rack_tco.items():
            print(f"  {k}: {v}")
```

### Prometheus Integration

```bash
# power-exporter.sh — Simple Prometheus textfile collector for RAPL metrics

#!/usr/bin/env bash
OUTPUT=/var/lib/node_exporter/textfile_collector/power.prom
POWERCAP_BASE=/sys/devices/virtual/powercap/intel-rapl

{
    echo "# HELP node_rapl_energy_joules_total Energy consumed in joules (cumulative counter)"
    echo "# TYPE node_rapl_energy_joules_total counter"
    echo "# HELP node_rapl_power_limit_watts Current power limit in watts"
    echo "# TYPE node_rapl_power_limit_watts gauge"
    echo "# HELP node_rapl_enabled Whether power limit is enabled"
    echo "# TYPE node_rapl_enabled gauge"

    for domain_dir in $POWERCAP_BASE/intel-rapl:*/; do
        domain=$(basename $domain_dir)
        name=$(cat $domain_dir/name 2>/dev/null || echo "unknown")
        energy=$(cat $domain_dir/energy_uj 2>/dev/null)
        limit_uw=$(cat $domain_dir/constraint_0_power_limit_uw 2>/dev/null)
        enabled=$(cat $domain_dir/enabled 2>/dev/null || echo 0)

        if [ -n "$energy" ]; then
            # Convert microjoules to joules for Prometheus counter
            energy_j=$(echo "scale=6; $energy / 1000000" | bc)
            echo "node_rapl_energy_joules_total{domain=\"$domain\",zone=\"$name\"} $energy_j"
        fi

        if [ -n "$limit_uw" ]; then
            limit_w=$(echo "scale=3; $limit_uw / 1000000" | bc)
            echo "node_rapl_power_limit_watts{domain=\"$domain\",zone=\"$name\",constraint=\"0\"} $limit_w"
        fi

        echo "node_rapl_enabled{domain=\"$domain\",zone=\"$name\"} $enabled"
    done

    # Thermal temperatures
    echo "# HELP node_thermal_zone_temp_celsius Current thermal zone temperature"
    echo "# TYPE node_thermal_zone_temp_celsius gauge"
    for zone_dir in /sys/class/thermal/thermal_zone*/; do
        zone=$(basename $zone_dir)
        type=$(cat $zone_dir/type 2>/dev/null || echo "unknown")
        temp_milli=$(cat $zone_dir/temp 2>/dev/null)
        if [ -n "$temp_milli" ]; then
            temp_c=$(echo "scale=3; $temp_milli / 1000" | bc)
            echo "node_thermal_zone_temp_celsius{zone=\"$zone\",type=\"$type\"} $temp_c"
        fi
    done

} > $OUTPUT

# Run this script via cron or systemd timer every 30 seconds
```

### Prometheus Alert Rules

```yaml
# power-alerts.yaml
groups:
  - name: power_thermal
    rules:
      - alert: HighPackagePower
        expr: |
          rate(node_rapl_energy_joules_total{zone="package-0"}[2m]) > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU package power on {{ $labels.instance }}"
          description: "Package power at {{ $value | humanize }}W, approaching thermal limits."

      - alert: CPUThermalThrottling
        expr: |
          node_thermal_zone_temp_celsius{type="x86_pkg_temp"} > 85
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "CPU thermal throttling on {{ $labels.instance }}"
          description: "CPU temperature {{ $value }}°C exceeds 85°C threshold."

      - alert: PowerLimitExceeded
        expr: |
          rate(node_rapl_energy_joules_total{zone="package-0"}[1m]) /
          node_rapl_power_limit_watts{zone="package-0",constraint="0"} > 0.95
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "CPU power near limit on {{ $labels.instance }}"
          description: "CPU using {{ $value | humanizePercentage }} of power limit."
```

## Kubernetes Integration: Power-Aware Scheduling

```yaml
# Node labels for power-capped nodes
apiVersion: v1
kind: Node
metadata:
  name: worker-01
  labels:
    topology.kubernetes.io/zone: us-east-1a
    node.kubernetes.io/power-profile: high-performance
    intel.feature.node.kubernetes.io/rdt: "true"  # Node Feature Discovery

---
# Pod scheduling on power-optimized nodes
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-workload
spec:
  nodeSelector:
    node.kubernetes.io/power-profile: high-performance

  # Request guaranteed QoS class (prevents eviction, gets dedicated resources)
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          cpu: "4"
          memory: "8Gi"
        limits:
          cpu: "4"          # Equal requests == limits → Guaranteed QoS
          memory: "8Gi"

---
# Intel RDT via Kubernetes (requires node feature discovery + RDT plugin)
apiVersion: v1
kind: Pod
metadata:
  name: best-effort-batch
  annotations:
    # Intel RDT resource class (maps to resctrl group)
    rdt.intel.com/resource-class: best-effort
spec:
  containers:
    - name: batch
      image: batch-processor:latest
      resources:
        requests:
          cpu: "2"
          memory: "4Gi"
```

## Summary

Linux power management has evolved into a sophisticated, programmable system for datacenter operators. RAPL provides fine-grained energy measurement and power limiting at the CPU package, core, and DRAM level through the clean powercap sysfs interface. Intel RDT complements RAPL by addressing the resource contention dimension — controlling how workloads share LLC cache and memory bandwidth. Thermal management through sysfs and perf enables proactive detection of throttling before it impacts application performance. Together, these mechanisms enable datacenter engineers to implement power budgeting, tenant isolation, and performance SLA guarantees that were previously only achievable by cloud hyperscalers with custom silicon.
