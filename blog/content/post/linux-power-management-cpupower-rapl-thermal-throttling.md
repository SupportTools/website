---
title: "Linux Power Management: cpupower, Turbo Boost, Energy-Performance Governors, RAPL Power Capping, and Thermal Throttling"
date: 2031-12-30T00:00:00-05:00
draft: false
tags: ["Linux", "Power Management", "cpupower", "RAPL", "Thermal", "Performance", "System Administration"]
categories:
- Linux
- System Administration
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux CPU power management for production systems: cpupower governor configuration, Intel/AMD turbo boost control, RAPL power domain capping, thermal throttling detection and mitigation, and power-aware Kubernetes node configuration."
more_link: "yes"
url: "/linux-power-management-cpupower-rapl-thermal-throttling/"
---

Power management on Linux production systems involves tradeoffs between performance, power consumption, thermal envelope, and hardware longevity. Getting these tradeoffs wrong causes either thermal throttling that degrades application performance invisibly, or unnecessary energy consumption that drives up operational costs. This guide covers the Linux power management stack from the processor frequency scaling governor layer through Intel RAPL power capping to thermal zone monitoring, with practical recommendations for bare-metal Kubernetes node configuration.

<!--more-->

# Linux Power Management: cpupower, RAPL, and Thermal Throttling

## Section 1: The Linux CPU Frequency Scaling Architecture

The Linux kernel's CPU frequency scaling (cpufreq) subsystem manages processor clock frequencies dynamically. It consists of three layers:

1. **CPU-specific drivers** — hardware interface (intel_pstate, acpi-cpufreq, amd-pstate)
2. **Governors** — frequency selection policies
3. **Userspace interfaces** — sysfs, cpupower, powertop

### Checking the Current Driver and Governor

```bash
# Identify the active cpufreq driver
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver

# Check available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors

# Check current governor for all CPUs
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo "$(dirname $cpu | xargs -I{} basename {}): $(cat $cpu)"
done

# Check current frequency
grep -E "^cpu MHz" /proc/cpuinfo | head -8

# Use cpupower for a comprehensive view
cpupower frequency-info
```

### Available Governors

| Governor | Description | Use Case |
|----------|-------------|----------|
| `performance` | Always run at maximum frequency | Latency-sensitive workloads |
| `powersave` | Always run at minimum frequency | Energy-critical deployments |
| `ondemand` | Scale based on CPU utilization | General-purpose (legacy) |
| `conservative` | Scale up/down gradually | Stable workloads |
| `schedutil` | Scale based on scheduler utilization | Modern default, kernel-integrated |
| `userspace` | Allow userspace to set frequency | Manual control or testing |

### intel_pstate vs. acpi-cpufreq

Modern Intel processors use `intel_pstate`, which bypasses the traditional cpufreq governors and uses a hardware-level P-state algorithm. Check which driver is active:

```bash
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# Output: intel_pstate  OR  acpi-cpufreq
```

With `intel_pstate`, only `performance` and `powersave` governors are available (the pstate driver handles scaling internally). Force legacy mode if needed:

```bash
# Kernel command line parameter (requires reboot)
# Add to /etc/default/grub GRUB_CMDLINE_LINUX:
intel_pstate=disable

# Then install acpi-cpufreq and use all governors:
modprobe acpi-cpufreq
```

For AMD processors, `amd-pstate` provides similar functionality since kernel 5.17:

```bash
# Check AMD P-state mode
cat /sys/devices/system/cpu/amd_pstate/status
# Options: active, passive, guided, disable

# Enable active mode (CPPC-based autonomous control)
echo active | sudo tee /sys/devices/system/cpu/amd_pstate/status
```

## Section 2: cpupower — Setting Governors and Frequency Limits

### Installation

```bash
# Debian/Ubuntu
apt-get install linux-cpupower cpufrequtils

# RHEL/CentOS/Fedora
dnf install kernel-tools

# Verify
cpupower --version
```

### Setting Performance Governor

For production compute workloads, the `performance` governor prevents frequency scaling delays:

```bash
# Set all CPUs to performance governor
cpupower frequency-set -g performance

# Verify
cpupower frequency-info | grep "current policy"
```

Apply persistently via systemd:

```bash
# /etc/systemd/system/cpupower.service
cat > /etc/systemd/system/cpupower.service << 'EOF'
[Unit]
Description=Configure CPU power management
After=sysinit.target
Before=basic.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/cpupower frequency-set -g performance
ExecStop=/usr/bin/cpupower frequency-set -g powersave

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now cpupower.service
```

Or via tuned (preferred on RHEL-family systems):

```bash
# Install tuned
dnf install tuned

# List available profiles
tuned-adm list

# Apply latency-performance profile (sets performance governor + other tunings)
tuned-adm profile latency-performance

# For throughput-focused workloads
tuned-adm profile throughput-performance

# For Kubernetes nodes (combination profile)
tuned-adm profile network-throughput

# Verify active profile
tuned-adm active
```

### Custom tuned Profile for Kubernetes Nodes

```bash
mkdir -p /etc/tuned/k8s-node
cat > /etc/tuned/k8s-node/tuned.conf << 'EOF'
[main]
summary=Tuned profile for Kubernetes worker nodes

[cpu]
governor=performance
energy_perf_bias=performance
min_perf_pct=100

[vm]
# Disable transparent hugepage defrag to reduce latency spikes
transparent_hugepages=madvise

[disk]
# Deadline scheduler for SSDs
elevator=none

[net]
# Increase network buffer sizes
rmem_max=134217728
wmem_max=134217728
rmem_default=1048576
wmem_default=1048576

[sysctl]
# CPU scheduling
kernel.sched_min_granularity_ns=10000000
kernel.sched_wakeup_granularity_ns=15000000
# Memory management
vm.swappiness=10
vm.dirty_ratio=40
vm.dirty_background_ratio=10
EOF

tuned-adm profile k8s-node
```

### Frequency Constraints

```bash
# Set min and max frequency limits
cpupower frequency-set --min 2.0GHz --max 3.5GHz

# Check hardware limits
cpupower frequency-info -l

# Verify applied limits
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq

# Convert from kHz to GHz
awk '{printf "%.2f GHz\n", $1/1000000}' /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq
```

## Section 3: Turbo Boost Control

Intel Turbo Boost and AMD Precision Boost allow processors to temporarily exceed their base frequency. For production systems, the behavior depends on workload characteristics:

- **Enable turbo boost**: Maximum single-threaded performance, brief bursts
- **Disable turbo boost**: Predictable latency, reduced thermal load, lower power

### Intel Turbo Boost

```bash
# Check turbo boost status
cat /sys/devices/system/cpu/intel_pstate/no_turbo
# 0 = turbo enabled, 1 = turbo disabled

# Check if boost is available on the CPU
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/base_frequency
# If cpuinfo_max_freq > base_frequency, turbo is available

# Disable turbo boost
echo 1 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo

# Enable turbo boost
echo 0 | sudo tee /sys/devices/system/cpu/intel_pstate/no_turbo

# Verify current max frequency
grep -E "^cpu MHz" /proc/cpuinfo | awk '{print $NF}' | sort -n | tail -1
```

### AMD Precision Boost

```bash
# Check AMD boost status
cat /sys/devices/system/cpu/cpufreq/boost
# 1 = enabled, 0 = disabled (when using acpi-cpufreq)

# With amd-pstate driver
cat /sys/devices/system/cpu/cpu0/cpufreq/boost

# Disable AMD boost
echo 0 | sudo tee /sys/devices/system/cpu/cpufreq/boost

# For amd-pstate
echo 0 | sudo tee /sys/devices/system/cpu/cpu0/cpufreq/boost
```

### MSR-Based Turbo Control (Low-Level)

For systems where the sysfs interface is unavailable, use MSR writes:

```bash
# Install msr-tools
apt-get install msr-tools  # Debian/Ubuntu
modprobe msr

# Read current turbo status (Intel MSR 0x1A0, bit 38)
rdmsr -f 38:38 0x1A0  # 0 = turbo enabled, 1 = disabled

# Disable turbo via MSR on all CPUs
for cpu in $(seq 0 $(($(nproc) - 1))); do
    wrmsr -p $cpu 0x1A0 $(($(rdmsr -p $cpu -d 0x1A0) | (1 << 38)))
done
```

### Persistent Turbo Configuration

```bash
# /usr/local/bin/configure-turbo.sh
cat > /usr/local/bin/configure-turbo.sh << 'SCRIPT'
#!/bin/bash
# Configure turbo boost based on system role
# Usage: configure-turbo.sh [enable|disable]
set -euo pipefail

VENDOR=$(grep "vendor_id" /proc/cpuinfo | head -1 | awk '{print $NF}')
ACTION=${1:-enable}

case "$VENDOR" in
    GenuineIntel)
        SYSFS="/sys/devices/system/cpu/intel_pstate/no_turbo"
        if [ -f "$SYSFS" ]; then
            if [ "$ACTION" = "enable" ]; then
                echo 0 > "$SYSFS"
            else
                echo 1 > "$SYSFS"
            fi
            echo "Intel turbo ${ACTION}d"
        fi
        ;;
    AuthenticAMD)
        SYSFS="/sys/devices/system/cpu/cpufreq/boost"
        if [ -f "$SYSFS" ]; then
            if [ "$ACTION" = "enable" ]; then
                echo 1 > "$SYSFS"
            else
                echo 0 > "$SYSFS"
            fi
            echo "AMD boost ${ACTION}d"
        fi
        ;;
    *)
        echo "Unknown CPU vendor: $VENDOR"
        exit 1
        ;;
esac
SCRIPT
chmod +x /usr/local/bin/configure-turbo.sh
```

## Section 4: Energy Performance Bias (EPB)

The Energy Performance Bias (EPB) is an Intel hint to the processor about the preferred balance between performance and energy efficiency. It affects P-state selection at the hardware level.

```bash
# Check current EPB for CPU 0
cpupower info -b
# OR
cat /sys/devices/system/cpu/cpu0/power/energy_perf_bias
# Values: 0=performance, 4=balanced-performance, 6=normal, 8=balanced-power, 15=power

# Set EPB for performance (lowest latency)
cpupower set -b 0

# Set EPB for balanced performance
cpupower set -b 4

# Set for all CPUs
for cpu in /sys/devices/system/cpu/cpu*/power/energy_perf_bias; do
    echo 0 > "$cpu"
done
```

### Energy Performance Preference (EPP) for intel_pstate

EPP is a newer, more granular hint introduced with Intel's HWP (Hardware P-states) feature:

```bash
# Check EPP for CPU 0
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
# Values: default, performance, balance_performance, balance_power, power

# Check available preferences
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_available_preferences

# Set to performance for all CPUs
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo performance > "$cpu" 2>/dev/null || true
done

# Verify
grep "" /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference | head -4
```

## Section 5: RAPL — Running Average Power Limit

Intel's RAPL (Running Average Power Limit) allows software to monitor and cap power consumption at the package, core, and uncore (DRAM, GPU, etc.) level. This is critical for data center power budget enforcement and preventing thermal emergencies.

### RAPL Architecture

RAPL organizes power domains hierarchically:

```
Package (socket)
├── PP0 (Core domain — CPU cores + LLC)
├── PP1 (Uncore domain — GPU/display, if present)
└── DRAM domain (memory controller + DIMMs)
```

### Monitoring Power Consumption

```bash
# Install powercap tools
apt-get install linux-libc-dev  # headers for RAPL
# Or use powercap-utils:
apt-get install powercap-utils

# List RAPL domains
ls /sys/class/powercap/

# Read package power for socket 0
cat /sys/class/powercap/intel-rapl:0/energy_uj

# Calculate power consumption over 1 second
BEFORE=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
sleep 1
AFTER=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
echo "Package 0 power: $(( (AFTER - BEFORE) / 1000000 )) W"

# Use powertop for a comprehensive view
powertop --auto-tune  # Apply default power-saving settings
powertop --html=/tmp/powertop-report.html  # Generate report
```

### Programmatic RAPL Monitoring in Bash

```bash
#!/usr/bin/env bash
# rapl-monitor.sh — Continuous RAPL power monitoring
set -euo pipefail

INTERVAL=${1:-1}
RAPL_BASE="/sys/class/powercap"

declare -A PREV_ENERGY

# Get all package domains
mapfile -t DOMAINS < <(ls "${RAPL_BASE}" | grep "^intel-rapl:[0-9]$")

echo "Timestamp,Domain,Power_W"

while true; do
    TIMESTAMP=$(date -Iseconds)

    for domain in "${DOMAINS[@]}"; do
        ENERGY_FILE="${RAPL_BASE}/${domain}/energy_uj"
        NAME_FILE="${RAPL_BASE}/${domain}/name"

        if [ ! -f "${ENERGY_FILE}" ]; then
            continue
        fi

        CURRENT=$(cat "${ENERGY_FILE}")
        NAME=$(cat "${NAME_FILE}")

        if [ -n "${PREV_ENERGY[$domain]+_}" ]; then
            DIFF=$(( CURRENT - PREV_ENERGY[$domain] ))
            POWER_W=$(awk "BEGIN {printf \"%.2f\", ${DIFF} / (${INTERVAL} * 1000000)}")
            echo "${TIMESTAMP},${NAME},${POWER_W}"
        fi

        PREV_ENERGY[$domain]=$CURRENT
    done

    sleep "${INTERVAL}"
done
```

### Setting RAPL Power Limits

```bash
# Read current power limits for package 0
cat /sys/class/powercap/intel-rapl:0/constraint_0_name    # long_term
cat /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw  # current limit in microwatts
cat /sys/class/powercap/intel-rapl:0/constraint_0_time_window_us  # time window

cat /sys/class/powercap/intel-rapl:0/constraint_1_name    # short_term
cat /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw
cat /sys/class/powercap/intel-rapl:0/constraint_1_time_window_us

# Read TDP (max design power) in watts
cat /sys/class/powercap/intel-rapl:0/constraint_0_max_power_uw | \
  awk '{printf "%.0f W\n", $1/1000000}'

# Set long-term power limit to 100W for package 0
# (time window = 1 second = 1,000,000 microseconds)
echo 100000000 | sudo tee /sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw
echo 1000000 | sudo tee /sys/class/powercap/intel-rapl:0/constraint_0_time_window_us

# Enable the constraint
echo 1 | sudo tee /sys/class/powercap/intel-rapl:0/enabled

# Set short-term power limit to 120W for package 0
# (time window = 2.44ms = typical short_term window)
echo 120000000 | sudo tee /sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw
```

### RAPL via powerclamp (Intel)

For systems where RAPL writes are locked by BIOS/UEFI firmware, use intel_powerclamp as an alternative:

```bash
# Load the driver
modprobe intel_powerclamp

# Set idle injection ratio (0-50%, where higher = more power saving)
echo 20 | sudo tee /sys/class/thermal/cooling_device*/cur_state
# (find the correct cooling_device number first)
for dev in /sys/class/thermal/cooling_device*; do
    type=$(cat "$dev/type" 2>/dev/null)
    if [ "$type" = "intel_powerclamp" ]; then
        echo "Found powerclamp at: $dev"
        # Set 20% idle injection
        echo 20 > "$dev/cur_state"
    fi
done
```

## Section 6: Thermal Zone Monitoring and Throttling Detection

### Reading Thermal Zones

```bash
# List all thermal zones
ls /sys/class/thermal/thermal_zone*

for zone in /sys/class/thermal/thermal_zone*; do
    type=$(cat "$zone/type" 2>/dev/null || echo "unknown")
    temp=$(cat "$zone/temp" 2>/dev/null || echo "0")
    # Temperature is in millidegrees Celsius
    temp_c=$(awk "BEGIN {printf \"%.1f\", ${temp}/1000}")
    echo "${zone##*/} (${type}): ${temp_c}°C"
done
```

### Detecting CPU Thermal Throttling

Thermal throttling is invisible in application metrics but shows up in CPU MSRs. The `THERM_STATUS` MSR (0x19C) contains throttling state bits:

```bash
# Check thermal throttling via rdmsr
modprobe msr
apt-get install msr-tools

# Check THERM_STATUS MSR for CPU 0
# Bit 4 = currently throttling (CPU_Therm_Status)
THERM_STATUS=$(rdmsr -p 0 0x19C)
THROTTLING=$(( (0x$THERM_STATUS >> 4) & 1 ))
if [ "$THROTTLING" -eq 1 ]; then
    echo "WARNING: CPU 0 is currently being thermally throttled"
fi

# Check PACKAGE_THERM_STATUS MSR (0x1B1) for package-level throttling
PKG_THERM=$(rdmsr -p 0 0x1B1 2>/dev/null || echo "0")
PKG_THROTTLING=$(( (0x$PKG_THERM >> 4) & 1 ))
if [ "$PKG_THROTTLING" -eq 1 ]; then
    echo "WARNING: CPU package is currently being thermally throttled"
fi
```

### Monitoring Throttling via perf

```bash
# Count thermal throttle events
perf stat -e cpu-clock,cs,migrations,faults,\
thermal-throttle/cpu_thermal_throttle_count/,\
thermal-throttle/package_thermal_throttle_count/ \
-a sleep 10
```

### Kernel Thermal Framework and Trip Points

```bash
# Inspect trip points for a zone
ZONE="/sys/class/thermal/thermal_zone0"
for trip in "$ZONE"/trip_point_*_temp; do
    if [ -f "$trip" ]; then
        tripnum=$(echo "$trip" | grep -oP 'trip_point_\K[0-9]+')
        type=$(cat "${ZONE}/trip_point_${tripnum}_type" 2>/dev/null || echo "unknown")
        temp=$(cat "$trip")
        echo "Trip ${tripnum} (${type}): $(awk "BEGIN {printf \"%.0f\", ${temp}/1000}")°C"
    fi
done
```

Output example:
```
Trip 0 (passive): 95°C      ← Triggers P-state reduction
Trip 1 (critical): 105°C    ← Forces emergency shutdown
```

### Comprehensive Thermal and Throttling Script

```bash
#!/usr/bin/env bash
# thermal-status.sh — Comprehensive thermal health check
set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "=== CPU Thermal Status Report ==="
echo "Timestamp: $(date -R)"
echo ""

# CPU temperatures
echo "--- Temperature Zones ---"
for zone in /sys/class/thermal/thermal_zone*; do
    type=$(cat "$zone/type" 2>/dev/null || echo "unknown")
    temp_raw=$(cat "$zone/temp" 2>/dev/null || echo "0")
    temp_c=$(awk "BEGIN {printf \"%.1f\", ${temp_raw}/1000}")
    temp_int=${temp_c%.*}

    if [ "$temp_int" -ge 90 ]; then
        color=$RED
    elif [ "$temp_int" -ge 75 ]; then
        color=$YELLOW
    else
        color=$GREEN
    fi

    printf "${color}%-30s %s°C${NC}\n" "$type" "$temp_c"
done
echo ""

# Current CPU frequencies vs. max
echo "--- CPU Frequencies ---"
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
    cpu_name=$(echo "$cpu" | grep -oP 'cpu[0-9]+')
    cur_freq=$(cat "$cpu")
    max_freq=$(cat "$(dirname $cpu)/cpuinfo_max_freq")
    cur_ghz=$(awk "BEGIN {printf \"%.2f\", ${cur_freq}/1000000}")
    max_ghz=$(awk "BEGIN {printf \"%.2f\", ${max_freq}/1000000}")
    ratio=$(awk "BEGIN {printf \"%.0f\", (${cur_freq}/${max_freq})*100}")

    if [ "$ratio" -lt 70 ]; then
        color=$RED
        note="THROTTLED"
    elif [ "$ratio" -lt 90 ]; then
        color=$YELLOW
        note="REDUCED"
    else
        color=$GREEN
        note="OK"
    fi

    printf "${color}%-6s %s/%s GHz (%s%%) %s${NC}\n" \
      "$cpu_name" "$cur_ghz" "$max_ghz" "$ratio" "$note"
done | head -16  # Show first 16 CPUs
echo ""

# Current governor
echo "--- Governor ---"
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
echo ""

# RAPL power
echo "--- RAPL Power Domains ---"
for domain in /sys/class/powercap/intel-rapl:*; do
    [ -d "$domain" ] || continue
    name=$(cat "$domain/name" 2>/dev/null || echo "unknown")
    if [ -f "$domain/energy_uj" ]; then
        before=$(cat "$domain/energy_uj")
        sleep 0.5
        after=$(cat "$domain/energy_uj")
        power_w=$(awk "BEGIN {printf \"%.1f\", (${after}-${before})/500000}")
        echo "$name: ${power_w} W"
    fi
done
```

## Section 7: CPU Idle States (C-States)

C-states control how deeply the CPU sleeps when idle. Deeper C-states save more power but have higher wake-up latency.

```bash
# List available C-states and their latency
for cpu in /sys/devices/system/cpu/cpu0/cpuidle/state*; do
    name=$(cat "$cpu/name")
    latency=$(cat "$cpu/latency")
    power=$(cat "$cpu/power" 2>/dev/null || echo "N/A")
    enabled=$([ "$(cat $cpu/disable)" -eq 0 ] && echo "enabled" || echo "disabled")
    printf "%-10s latency=%-6s µs power=%-8s µW %s\n" "$name" "$latency" "$power" "$enabled"
done
```

### Disabling Deep C-States for Low Latency

For ultra-low latency applications (trading systems, real-time processing):

```bash
# Kernel parameter to limit C-state depth (add to GRUB_CMDLINE_LINUX)
# processor.max_cstate=1  — Only allow C0 (active) and C1 (halt)
# intel_idle.max_cstate=1 — For Intel idle driver

# Or at runtime via cpupower
cpupower idle-set -D 2  # Disable all C-states deeper than C2

# Disable C6 (deepest sleep) for all CPUs
for cpu in /sys/devices/system/cpu/cpu*/cpuidle/state*/name; do
    state_name=$(cat "$cpu")
    if [[ "$state_name" == "C6" || "$state_name" == "C7" ]]; then
        state_dir=$(dirname "$cpu")
        echo 1 > "${state_dir}/disable"
        echo "Disabled ${state_name} for $(dirname "$state_dir" | xargs -I{} basename {})"
    fi
done

# Verify
for cpu in /sys/devices/system/cpu/cpu0/cpuidle/state*; do
    name=$(cat "$cpu/name")
    disabled=$(cat "$cpu/disable")
    echo "$name: $([ $disabled -eq 1 ] && echo 'disabled' || echo 'enabled')"
done
```

## Section 8: Power Management for Kubernetes Nodes

### Node-Level Power Profile via DaemonSet

```yaml
# k8s-power-config-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-power-configurator
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-power-configurator
  template:
    metadata:
      labels:
        app: node-power-configurator
    spec:
      hostPID: true
      hostNetwork: true
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      initContainers:
        - name: configure-power
          image: debian:bookworm-slim
          securityContext:
            privileged: true
          command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail

              # Install cpupower
              apt-get update -qq && apt-get install -y -qq linux-cpupower

              # Set performance governor
              cpupower frequency-set -g performance
              echo "Performance governor applied"

              # Enable turbo boost
              VENDOR=$(grep "vendor_id" /proc/cpuinfo | head -1 | awk '{print $NF}')
              case "$VENDOR" in
                GenuineIntel)
                  if [ -f /sys/devices/system/cpu/intel_pstate/no_turbo ]; then
                    echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo
                    echo "Intel turbo boost enabled"
                  fi
                  # Set EPP to performance
                  for epp in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
                    echo performance > "$epp" 2>/dev/null || true
                  done
                  ;;
                AuthenticAMD)
                  if [ -f /sys/devices/system/cpu/cpufreq/boost ]; then
                    echo 1 > /sys/devices/system/cpu/cpufreq/boost
                    echo "AMD boost enabled"
                  fi
                  ;;
              esac

              # Disable transparent hugepage defrag
              echo madvise > /sys/kernel/mm/transparent_hugepage/defrag
              echo defer+madvise > /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true

              echo "Node power configuration complete"
          volumeMounts:
            - name: host-sys
              mountPath: /sys
            - name: host-proc
              mountPath: /proc
      containers:
        - name: pause
          image: gcr.io/google-containers/pause:3.9
          resources:
            requests:
              cpu: "1m"
              memory: "8Mi"
      volumes:
        - name: host-sys
          hostPath:
            path: /sys
        - name: host-proc
          hostPath:
            path: /proc
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
```

### Prometheus Metrics for Power Monitoring

```yaml
# node-exporter-power-config.yaml
# Extend node-exporter to collect RAPL metrics
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-exporter-config
  namespace: monitoring
data:
  rapl-metrics.sh: |
    #!/bin/bash
    # Output RAPL power consumption as Prometheus text format
    METRICS_FILE="/var/lib/node_exporter/textfile_collector/rapl.prom"

    declare -A PREV_ENERGY
    declare -A PREV_TIME

    echo "# HELP node_rapl_power_watts Current power consumption by RAPL domain" > "$METRICS_FILE"
    echo "# TYPE node_rapl_power_watts gauge" >> "$METRICS_FILE"

    for domain in /sys/class/powercap/intel-rapl:*; do
        [ -d "$domain" ] || continue
        domain_name=$(basename "$domain")
        display_name=$(cat "$domain/name" 2>/dev/null || echo "$domain_name")
        energy=$(cat "$domain/energy_uj" 2>/dev/null || continue)
        now=$(date +%s%N)

        if [ -n "${PREV_ENERGY[$domain_name]+_}" ]; then
            energy_diff=$(( energy - PREV_ENERGY[$domain_name] ))
            time_diff=$(( now - PREV_TIME[$domain_name] ))
            if [ $time_diff -gt 0 ]; then
                power_w=$(awk "BEGIN {printf \"%.3f\", ${energy_diff} * 1000 / ${time_diff}}")
                echo "node_rapl_power_watts{domain=\"${display_name}\"} ${power_w}" >> "$METRICS_FILE"
            fi
        fi

        PREV_ENERGY[$domain_name]=$energy
        PREV_TIME[$domain_name]=$now
    done
```

## Section 9: Thermal Throttling Prevention Strategies

### BIOS/UEFI Configuration Checklist

Power management effectiveness starts at the firmware level:

```bash
# Verify power management BIOS settings via dmidecode
dmidecode -t processor | grep -E "Max Speed|Current Speed|External Clock|Voltage"

# Check if HWP (Hardware P-States) is enabled
rdmsr 0x770 2>/dev/null | awk '{print "HWP enabled:", (strtonum("0x"$1) & 2) ? "yes" : "no"}'

# Check if C-states are allowed by BIOS
rdmsr 0xE2 2>/dev/null | awk '{val=strtonum("0x"$1); print "C-states locked:", (val & (1<<15)) ? "yes" : "no"}'
```

### Cooling and Thermal Paste Validation

```bash
# Monitor temperature under load
stress-ng --cpu 0 --cpu-method all --timeout 60s &
STRESS_PID=$!

while kill -0 $STRESS_PID 2>/dev/null; do
    MAX_TEMP=0
    for zone in /sys/class/thermal/thermal_zone*; do
        type=$(cat "$zone/type" 2>/dev/null || continue)
        [[ "$type" =~ "x86_pkg_temp" ]] || continue
        temp=$(cat "$zone/temp")
        temp_c=$(( temp / 1000 ))
        [ $temp_c -gt $MAX_TEMP ] && MAX_TEMP=$temp_c
    done

    FREQ=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq)
    FREQ_GHZ=$(awk "BEGIN {printf \"%.2f\", ${FREQ}/1000000}")

    echo "$(date +%H:%M:%S) Temp: ${MAX_TEMP}°C Freq: ${FREQ_GHZ} GHz"
    sleep 2
done

# If temperature reaches >90°C or frequency drops significantly, check cooling
```

### RAPL-Based Power Cap for Server Rooms

```bash
#!/usr/bin/env bash
# enforce-power-cap.sh — Enforce per-socket power caps for data center PDU budgets
set -euo pipefail

# Target: 65W per socket for dense 1U servers
TARGET_WATTS=65
TARGET_UW=$(( TARGET_WATTS * 1000000 ))
TIME_WINDOW_US=1000000  # 1 second averaging

for domain in /sys/class/powercap/intel-rapl:?; do
    [ -d "$domain" ] || continue
    name=$(cat "$domain/name")

    # Check max allowed power
    max_uw=$(cat "$domain/constraint_0_max_power_uw" 2>/dev/null || echo 0)

    if [ "$max_uw" -gt 0 ] && [ "$TARGET_UW" -le "$max_uw" ]; then
        echo "$TARGET_UW" > "$domain/constraint_0_power_limit_uw"
        echo "$TIME_WINDOW_US" > "$domain/constraint_0_time_window_us"
        echo 1 > "$domain/enabled"
        echo "Set ${name} long-term power limit to ${TARGET_WATTS}W"
    else
        echo "WARNING: Cannot set ${TARGET_WATTS}W limit for ${name} (max: $(( max_uw / 1000000 ))W)"
    fi
done
```

## Section 10: Monitoring Integration with Prometheus and Grafana

### Custom Node Exporter Textfile Metrics

```bash
#!/usr/bin/env bash
# /usr/local/bin/collect-power-metrics.sh
# Run every 30 seconds via systemd timer

OUTFILE="/var/lib/node_exporter/textfile_collector/power.prom"
TMPFILE="${OUTFILE}.tmp"

{
echo "# HELP node_cpu_scaling_governor Current CPU scaling governor (1=performance)"
echo "# TYPE node_cpu_scaling_governor gauge"
GOV=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo "unknown")
IS_PERF=$([ "$GOV" = "performance" ] && echo 1 || echo 0)
echo "node_cpu_scaling_governor{governor=\"${GOV}\"} ${IS_PERF}"

echo "# HELP node_cpu_turbo_enabled Whether turbo boost is enabled"
echo "# TYPE node_cpu_turbo_enabled gauge"
if [ -f /sys/devices/system/cpu/intel_pstate/no_turbo ]; then
    NO_TURBO=$(cat /sys/devices/system/cpu/intel_pstate/no_turbo)
    echo "node_cpu_turbo_enabled $(( 1 - NO_TURBO ))"
fi

echo "# HELP node_thermal_zone_celsius Temperature of thermal zones"
echo "# TYPE node_thermal_zone_celsius gauge"
for zone in /sys/class/thermal/thermal_zone*; do
    type=$(cat "$zone/type" 2>/dev/null || continue)
    temp_raw=$(cat "$zone/temp" 2>/dev/null || continue)
    temp_c=$(awk "BEGIN {printf \"%.1f\", ${temp_raw}/1000}")
    echo "node_thermal_zone_celsius{zone=\"$(basename $zone)\",type=\"${type}\"} ${temp_c}"
done

echo "# HELP node_cpu_max_frequency_ratio Ratio of current to max frequency"
echo "# TYPE node_cpu_max_frequency_ratio gauge"
CUR=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo 0)
MAX=$(cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null || echo 1)
RATIO=$(awk "BEGIN {printf \"%.3f\", ${CUR}/${MAX}}")
echo "node_cpu_max_frequency_ratio ${RATIO}"

} > "$TMPFILE" && mv "$TMPFILE" "$OUTFILE"
```

### Grafana Alert for Thermal Throttling

```yaml
# prometheus-power-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: power-management-alerts
  namespace: monitoring
spec:
  groups:
    - name: power.management
      rules:
        - alert: CPUThermalThrottlingDetected
          expr: |
            node_cpu_max_frequency_ratio < 0.8
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CPU throttling detected on {{ $labels.instance }}"
            description: "CPU frequency is at {{ $value | humanizePercentage }} of maximum, suggesting thermal throttling."

        - alert: CPUTemperatureCritical
          expr: |
            node_thermal_zone_celsius{type=~".*pkg.*|.*x86.*"} > 90
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Critical CPU temperature on {{ $labels.instance }}"
            description: "Thermal zone {{ $labels.type }} is at {{ $value }}°C."

        - alert: CPUNotInPerformanceMode
          expr: |
            node_cpu_scaling_governor{governor="performance"} == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "CPU not in performance mode on {{ $labels.instance }}"
            description: "Expected performance governor, got {{ $labels.governor }}."
```

Proper power management configuration is a force multiplier for Kubernetes node performance. A system running in `powersave` mode with deep C-states enabled can deliver 30-40% lower throughput than the same hardware configured with the `performance` governor and turbo boost enabled, while also exhibiting unpredictable latency spikes as the processor transitions between P-states. Instrument these metrics in Prometheus before they become production incidents.
