---
title: "Linux Power Management: CPU Frequency Scaling and Performance Governors"
date: 2031-05-14T00:00:00-05:00
draft: false
tags: ["Linux", "Power Management", "CPU", "Performance", "Kubernetes", "Systems"]
categories:
- Linux
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to Linux CPU frequency scaling covering cpufreq governors, P-states and C-states, turbo boost control, RAPL power capping, performance vs efficiency trade-offs for Kubernetes nodes, and cloud instance power configuration."
more_link: "yes"
url: "/linux-power-management-cpu-frequency-scaling-governors/"
---

CPU frequency scaling is the most impactful kernel-level tuning knob for workload performance that most infrastructure engineers never touch. Modern Intel and AMD processors can operate across a frequency range from ~800MHz to 5GHz+, and the Linux kernel's cpufreq subsystem decides where in that range to operate at any given moment. For Kubernetes nodes running latency-sensitive workloads, the wrong governor choice can add 30-200ms of response time variance that's invisible to standard monitoring but devastating to P99 latency.

This guide covers the complete power management stack: governors, P-states, C-states, turbo boost, RAPL power capping, and the specific tuning required for Kubernetes environments where you're paying for CPU time but not always getting consistent CPU frequency.

<!--more-->

# Linux Power Management: CPU Frequency Scaling and Performance Governors

## Section 1: The cpufreq Subsystem Architecture

Linux CPU frequency scaling consists of several layers:

```
Application Load
      │
      ▼
cpufreq Governor (decides target frequency)
├── performance   - Always max frequency
├── powersave     - Always min frequency
├── ondemand      - Reactive: scale based on utilization (legacy)
├── conservative  - Like ondemand but more gradual
├── schedutil     - Scheduler-integrated (modern, recommended)
└── userspace     - Manual frequency control
      │
      ▼
cpufreq Driver (hardware interface)
├── intel_pstate  - Intel-specific driver (P-state aware)
├── amd_pstate    - AMD-specific driver (modern AMD CPUs)
└── acpi-cpufreq  - Generic ACPI-based driver (fallback)
      │
      ▼
Hardware P-states
├── P0 - Maximum performance frequency
├── P1 - Slight reduction
├── ...
└── Pn - Minimum frequency
```

### 1.1 Checking Current Configuration

```bash
# Check which driver is active
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# intel_pstate  (Intel)
# amd_pstate    (AMD, kernel 5.17+)
# acpi-cpufreq  (fallback)

# Check available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# performance powersave

# Check current governor on all CPUs
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo "$(dirname $cpu | xargs basename): $(cat $cpu)"
done | head -10

# Or use cpupower (recommended tool)
cpupower frequency-info
# analyzing CPU 0:
#   driver: intel_pstate
#   CPUs which run at the same hardware frequency: 0
#   CPUs which need to have their frequency coordinated by software: 0
#   maximum transition latency:  Cannot determine or is not supported.
#   hardware limits: 800 MHz - 3.20 GHz
#   available cpufreq governors: performance powersave
#   current policy: frequency should be within 800 MHz and 3.20 GHz.
#                   The governor "performance" may decide which speed to use
#                   within this range.
#   current CPU frequency: Unable to call hardware
#   current CPU frequency: 3.20 GHz (asserted by call to kernel)
#   boost state support:
#     Supported: yes
#     Active: yes

# Check current frequency for each CPU
cpupower monitor
```

### 1.2 The intel_pstate Driver

On Intel systems with the `intel_pstate` driver, the governor operates differently. The driver has two modes:

- **Active mode** (default): Intel firmware controls P-states; the governor is more of a hint
- **Passive mode**: The generic cpufreq governor controls P-states directly

```bash
# Check intel_pstate mode
cat /sys/devices/system/cpu/intel_pstate/status
# active  or  passive  or  off

# Check P-state bounds (percentage of max frequency)
cat /sys/devices/system/cpu/intel_pstate/min_perf_pct
cat /sys/devices/system/cpu/intel_pstate/max_perf_pct
# 22    (minimum ~22% of max frequency)
# 100   (maximum 100% of max frequency)

# Check turbo boost status
cat /sys/devices/system/cpu/intel_pstate/no_turbo
# 0 = turbo enabled
# 1 = turbo disabled

# With intel_pstate active, available governors are limited to:
# performance  and  powersave (which enables EPP/HWP control)
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# performance powersave
```

### 1.3 AMD P-state Driver

Modern AMD systems (Zen 2+) benefit from the `amd_pstate` driver:

```bash
# Check AMD P-state support
cat /sys/devices/system/cpu/amd_pstate/status
# passive  (kernel 5.17-6.3)
# active   (kernel 6.3+ with CPPC support)

# AMD P-state extension (CPPC2) for better performance
cat /sys/devices/system/cpu/cpu0/cpufreq/amd_pstate_highest_perf
cat /sys/devices/system/cpu/cpu0/cpufreq/amd_pstate_nominal_perf
cat /sys/devices/system/cpu/cpu0/cpufreq/amd_pstate_lowest_nonlinear_perf

# Enable amd_pstate (if not already active)
# Add to kernel command line:
# amd_pstate=active   (for active/autonomous mode)
# amd_pstate=guided   (for guided mode)
# amd_pstate=passive  (for passive mode, uses generic governor)
```

## Section 2: cpufreq Governors in Depth

### 2.1 performance Governor

The `performance` governor sets the CPU to always run at maximum frequency. No dynamic scaling, no latency from frequency transitions:

```bash
# Set performance governor on all CPUs
cpupower frequency-set -g performance

# Or manually
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "$cpu"
done

# Verify
cpupower frequency-info | grep "The governor"
# The governor "performance" may decide which speed to use

# With intel_pstate in active mode, this enables max performance P-state
```

**When to use**: Latency-sensitive applications (trading systems, real-time games, ML inference), production Kubernetes nodes where consistent performance matters more than power.

**Impact**: 10-30% higher power consumption vs powersave. CPU temperature ~10-15°C higher. P99 latency typically 15-40% lower than ondemand.

### 2.2 powersave Governor

The `powersave` governor runs at minimum frequency. On modern CPUs with intel_pstate, this actually enables Hardware-Controlled Performance States (HWP) and Energy-Performance Preference (EPP):

```bash
# Set powersave governor
cpupower frequency-set -g powersave

# With intel_pstate, configure EPP for better performance within powersave
# energy_performance_preference controls the HWP hint:
# default, performance, balance_performance, balance_power, power
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
# balance_performance

# Set to performance for production (governor = powersave, EPP = performance)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
  echo performance > "$cpu" 2>/dev/null || true
done

# This combination (powersave + EPP=performance) is often BETTER than
# the "performance" governor alone on modern Intel CPUs because HWP
# can make micro-level frequency decisions faster than the OS
```

### 2.3 schedutil Governor

`schedutil` uses the CPU scheduler's utilization metrics to set frequency. It's reactive to actual load with lower latency than `ondemand`:

```bash
# Set schedutil governor (requires CONFIG_CPU_FREQ_GOV_SCHEDUTIL)
cpupower frequency-set -g schedutil

# Configure schedutil rate limit (microseconds between frequency updates)
cat /sys/devices/system/cpu/cpu0/cpufreq/schedutil/rate_limit_us
# 1000  (1ms default)

# Reduce for faster response (at cost of more overhead)
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/schedutil; do
  echo 500 > "$cpu/rate_limit_us" 2>/dev/null || true
done

# Schedutil respects the scheduler's util_est for prediction
# Enable utilization estimation for better schedutil behavior
sysctl kernel.sched_util_clamp_min_rt_default
echo 1024 > /sys/kernel/debug/sched/util_clamp/max
```

### 2.4 ondemand Governor (Legacy)

`ondemand` was the default for years. It samples CPU utilization every `sampling_rate` microseconds and scales up/down based on `up_threshold`:

```bash
# Check ondemand settings (if using acpi-cpufreq driver)
ls /sys/devices/system/cpu/cpu0/cpufreq/ondemand/
# sampling_rate  up_threshold  ignore_nice_load  powersave_bias

cat /sys/devices/system/cpu/cpu0/cpufreq/ondemand/sampling_rate
# 100000  (100ms - very slow to react!)

cat /sys/devices/system/cpu/cpu0/cpufreq/ondemand/up_threshold
# 95  (scale up when utilization > 95% - too high for burst workloads)

# Tune for faster response
echo 10000 > /sys/devices/system/cpu/cpu0/cpufreq/ondemand/sampling_rate  # 10ms
echo 80 > /sys/devices/system/cpu/cpu0/cpufreq/ondemand/up_threshold       # 80%
```

## Section 3: C-States (CPU Sleep States)

C-states are CPU power states when idle. Deeper C-states save more power but take longer to wake up:

```
C0: Active - CPU executing
C1: Halt - CPU stalled, fast wake (~1µs)
C1E: Enhanced Halt - ~1-2µs wake
C3: Sleep - ~50-150µs wake (L3 cache must be flushed)
C6: Deep Power Down - ~200-500µs wake (voltage reduced)
C7/C8/C10: Package C-states - deepest sleep, 1-10ms+ wake latency
```

### 3.1 Inspecting C-State Usage

```bash
# Check available C-states
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/name
# POLL
# C1
# C1E
# C3
# C6
# C7s
# C8

# Check C-state latency (wake-up time in microseconds)
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/latency
# 0     (POLL - no latency, burns power)
# 2     (C1)
# 10    (C1E)
# 50    (C3)
# 150   (C6)
# 200   (C7s)
# 300   (C8)

# Check time spent in each C-state
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/usage
cat /sys/devices/system/cpu/cpu0/cpuidle/state*/time  # microseconds

# Real-time C-state monitoring with turbostat
turbostat --show Busy%,Avg_MHz,C1%,C3%,C6%,C7%,CoreTmp --interval 5
```

### 3.2 Disabling Deep C-States for Low-Latency

For applications sensitive to wake-up latency (real-time trading, network functions, game servers):

```bash
# Method 1: Kernel boot parameter (permanent, affects all CPUs)
# Add to /etc/default/grub GRUB_CMDLINE_LINUX:
# intel_idle.max_cstate=1   (only C0/C1 allowed)
# processor.max_cstate=1

# Method 2: Disable individual C-states at runtime
# Disable C6 (state3 index may vary - check names first)
for state in /sys/devices/system/cpu/cpu*/cpuidle/state*/name; do
  name=$(cat "$state")
  if [[ "$name" == "C6" || "$name" == "C7s" || "$name" == "C8" ]]; then
    disable_file="${state%name}disable"
    echo 1 > "$disable_file"
    echo "Disabled $name on $(echo $disable_file | grep -o 'cpu[0-9]*')"
  fi
done

# Method 3: Using cpupower
cpupower idle-set --disable-by-latency 50  # Disable states with >50µs latency
cpupower idle-info  # Verify

# Method 4: /dev/cpu_dma_latency interface (for applications to set their own constraint)
# Writing 0 to this device prevents C-states with >0µs latency
# This is what real-time applications should do rather than disabling globally
```

### 3.3 Power Latency QoS from Application

```go
// In Go: prevent deep C-states while your app runs critical sections
package latency

import (
    "encoding/binary"
    "os"
)

type CPULatencyGuard struct {
    f *os.File
}

// NewCPULatencyGuard opens /dev/cpu_dma_latency and sets maximum latency in microseconds.
// Lower values prevent deeper sleep states.
// 0 = prevent any C-state (maximum performance, maximum power)
// 50 = allow up to C3 on most systems
func NewCPULatencyGuard(maxLatencyUs uint32) (*CPULatencyGuard, error) {
    f, err := os.OpenFile("/dev/cpu_dma_latency", os.O_WRONLY, 0)
    if err != nil {
        return nil, err
    }

    buf := make([]byte, 4)
    binary.LittleEndian.PutUint32(buf, maxLatencyUs)
    if _, err := f.Write(buf); err != nil {
        f.Close()
        return nil, err
    }

    return &CPULatencyGuard{f: f}, nil
}

func (g *CPULatencyGuard) Close() {
    if g.f != nil {
        g.f.Close()
        g.f = nil
    }
}

// Usage in latency-sensitive path:
// guard, _ := latency.NewCPULatencyGuard(0)  // Prevent all deep C-states
// defer guard.Close()
```

## Section 4: Turbo Boost Control

Turbo boost allows individual cores to run above their rated frequency when thermal budget permits. It's usually beneficial but adds frequency variability that can hurt consistent latency:

### 4.1 Checking and Controlling Turbo

```bash
# Intel: Check turbo status
cat /sys/devices/system/cpu/intel_pstate/no_turbo
# 0 = turbo enabled (default)
# 1 = turbo disabled

# Intel: Disable turbo
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo

# Intel: Enable turbo
echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo

# AMD: Check turbo (via boost)
cat /sys/devices/system/cpu/cpufreq/boost
# 1 = boost (turbo) enabled

# AMD: Disable turbo
echo 0 > /sys/devices/system/cpu/cpufreq/boost

# Using cpupower (works for both Intel and AMD)
cpupower frequency-set --turbo-boost  # Enable
cpupower frequency-set --no-turbo     # Disable

# Monitor turbo usage with turbostat
turbostat --show Busy%,Avg_MHz,Bzy_MHz,SMI --interval 1
# Bzy_MHz shows actual frequency when busy (includes turbo)
```

### 4.2 When to Disable Turbo

Turbo boost introduces frequency variability. Consider disabling when:
- Running benchmarks that require reproducible results
- Running applications with strict P99 latency SLOs (turbo can cause thermal throttling)
- Nodes are thermally throttling (disabling turbo gives more consistent base performance)

```bash
# Check if throttling is occurring
cat /sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count
cat /sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count

# Monitor with turbostat for throttle events
turbostat --show Busy%,Avg_MHz,Bzy_MHz,CoreTmp,PkgTmp,PkgWatt,RAMWatt 2>/dev/null

# Check thermal zones
for zone in /sys/class/thermal/thermal_zone*/; do
  echo "$(cat ${zone}type): $(cat ${zone}temp | awk '{print $1/1000}')°C"
done
```

## Section 5: RAPL Power Capping

Intel's Running Average Power Limit (RAPL) allows you to set per-package, per-core, and per-DRAM power limits from software:

### 5.1 Reading RAPL Power Data

```bash
# Check RAPL energy counters
ls /sys/class/powercap/intel-rapl/

# Read package power for socket 0
cat /sys/class/powercap/intel-rapl/intel-rapl:0/name
# package-0

cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj
# 12345678901  (microjoules, monotonically increasing)

# Read subzones (cores, uncore, DRAM)
ls /sys/class/powercap/intel-rapl/intel-rapl:0/

# Calculate power using rapl tool
cat > /tmp/rapl_power.sh << 'EOF'
#!/bin/bash
DOMAIN=${1:-/sys/class/powercap/intel-rapl/intel-rapl:0}
INTERVAL=${2:-1}

E1=$(cat "$DOMAIN/energy_uj")
sleep "$INTERVAL"
E2=$(cat "$DOMAIN/energy_uj")

DIFF=$((E2 - E1))
WATTS=$(echo "scale=2; $DIFF / 1000000 / $INTERVAL" | bc)
echo "Power: ${WATTS}W ($(cat $DOMAIN/name))"
EOF
chmod +x /tmp/rapl_power.sh
/tmp/rapl_power.sh

# Use turbostat for comprehensive power reporting
turbostat --Dump --show PkgWatt,CoreWatt,RAMWatt,GFXWatt 2>/dev/null
```

### 5.2 Setting RAPL Power Limits

```bash
# Check current power limits
cat /sys/class/powercap/intel-rapl/intel-rapl:0/constraint_0_name
# long_term
cat /sys/class/powercap/intel-rapl/intel-rapl:0/constraint_0_power_limit_uw
# 35000000  (35W in microwatts)
cat /sys/class/powercap/intel-rapl/intel-rapl:0/constraint_0_time_window_us
# 28000000  (28 second window)

cat /sys/class/powercap/intel-rapl/intel-rapl:0/constraint_1_name
# short_term
cat /sys/class/powercap/intel-rapl/intel-rapl:0/constraint_1_power_limit_uw
# 40000000  (40W)
cat /sys/class/powercap/intel-rapl/intel-rapl:0/constraint_1_time_window_us
# 2440000   (2.44 second window)

# Set a power cap (in microwatts)
# Reduce package to 28W to reduce thermal issues
echo 28000000 > /sys/class/powercap/intel-rapl/intel-rapl:0/constraint_0_power_limit_uw

# Use powercap tool (simpler interface)
apt-get install -y powercap-utils
powercap-info -p intel-rapl
powercap-set -p intel-rapl -z 0 -c 0 -l 28000000  # Package 0, constraint 0, 28W
```

### 5.3 RAPL-Aware Tuning for Cloud Instances

Cloud instances often run on oversubscribed hypervisors where RAPL limits are enforced at the VM level:

```bash
# Check if RAPL is available in the VM
ls /sys/class/powercap/intel-rapl/ 2>/dev/null || echo "RAPL not available (common in VMs)"

# On EC2/GCP/Azure, check for CPU steal time instead
# High steal time = noisy neighbor problem
vmstat 1 | awk '{print $16}' | grep -v wa  # steal% is column 16 in vmstat

# Monitor CPU steal with sar
sar -u 1 10 | awk '{print $NF}'  # Last column is %steal

# If steal > 10%, consider:
# 1. Moving to dedicated/bare-metal instances
# 2. Using CPU pinning (taskset or cpuset cgroups)
# 3. Moving to a different hypervisor host (stop/start the instance)
```

## Section 6: Kubernetes Node CPU Configuration

### 6.1 Setting Governor at Boot

For Kubernetes nodes, set the CPU governor via systemd or cloud-init:

```bash
# /etc/systemd/system/cpu-performance.service
cat > /etc/systemd/system/cpu-performance.service << 'EOF'
[Unit]
Description=CPU Performance Governor Setup
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/set-cpu-performance.sh

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/bin/set-cpu-performance.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail

# Set performance governor
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  echo performance > "$cpu" 2>/dev/null || true
done

# Set min/max to full range for performance governor
for cpu in /sys/devices/system/cpu/cpu*/cpufreq; do
  MAX=$(cat "$cpu/cpuinfo_max_freq" 2>/dev/null || echo 0)
  MIN=$(cat "$cpu/cpuinfo_min_freq" 2>/dev/null || echo 0)
  if [ "$MAX" -gt 0 ]; then
    echo "$MAX" > "$cpu/scaling_max_freq" 2>/dev/null || true
    echo "$MIN" > "$cpu/scaling_min_freq" 2>/dev/null || true
  fi
done

# Disable turbo for consistency (optional - remove if you want turbo)
# echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null || true

# Disable C-states deeper than C1E for latency
for state in /sys/devices/system/cpu/cpu*/cpuidle/state*/name; do
  name=$(cat "$state" 2>/dev/null || true)
  case "$name" in
    C3|C6|C7*|C8*|C10*)
      disable="${state%name}disable"
      echo 1 > "$disable" 2>/dev/null || true
      ;;
  esac
done

echo "CPU performance tuning applied"
SCRIPT

chmod +x /usr/local/bin/set-cpu-performance.sh
systemctl daemon-reload
systemctl enable --now cpu-performance.service
```

### 6.2 Kubernetes CPU Manager Policy

For Kubernetes workloads, the CPU Manager policy controls how CPUs are allocated:

```bash
# Check current CPU manager policy
cat /var/lib/kubelet/cpu_manager_state

# Configure kubelet for static CPU policy (enables CPU pinning)
cat > /etc/kubernetes/kubelet-config.yaml << 'EOF'
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 10s
# Reserve CPUs for system and kubelet daemons
reservedSystemCPUs: "0,1"  # Reserve CPUs 0 and 1 for system tasks
EOF

# Restart kubelet
systemctl restart kubelet
```

With `static` CPU manager policy, Guaranteed QoS pods with integer CPU requests get exclusive CPU cores:

```yaml
# pod-cpu-pinned.yaml
apiVersion: v1
kind: Pod
metadata:
  name: latency-sensitive-app
spec:
  containers:
    - name: app
      image: myapp:latest
      resources:
        requests:
          cpu: "4"          # Must be integer
          memory: "8Gi"
        limits:
          cpu: "4"          # Must equal requests for static policy
          memory: "8Gi"
      # Result: kubelet pins this pod to 4 exclusive CPUs
      # No other pods will share these CPUs
```

### 6.3 NUMA-Aware Topology Management

For multi-socket systems, NUMA topology affects memory latency:

```bash
# Check NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7
# node 0 size: 32000 MB
# node 1 cpus: 8 9 10 11 12 13 14 15
# node 1 size: 32000 MB

# Configure topology manager in kubelet
cat >> /etc/kubernetes/kubelet-config.yaml << 'EOF'
topologyManagerPolicy: single-numa-node  # Guarantee all resources from same NUMA node
topologyManagerScope: container          # Apply per-container (default)
EOF
```

### 6.4 Cloud Instance Power Configuration

Different cloud providers expose CPU performance tuning differently:

**AWS EC2:**
```bash
# EC2 instances use intel_pstate by default on Intel instances
# Check instance type's CPU capabilities
curl -s http://169.254.169.254/latest/meta-data/instance-type

# For C5n, M5, R5, etc. (Intel): intel_pstate + performance governor
cpupower frequency-set -g performance

# Check if Nitro hypervisor allows governor changes
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

# For T-series (burstable): be aware of CPU credit model
# High CPU utilization depletes credits → throttling
aws cloudwatch put-metric-alarm \
  --alarm-name "CPUCreditLow" \
  --metric-name CPUCreditBalance \
  --namespace AWS/EC2 \
  --statistic Average \
  --period 300 \
  --threshold 20 \
  --comparison-operator LessThanOrEqualToThreshold \
  --dimensions Name=InstanceId,Value=i-1234567890abcdef0 \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:AlertTopic
```

**GCP Compute Engine:**
```bash
# GCP uses host-level performance tuning
# Check if scaling_governor is controllable
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors

# For N2/C2 instances (Intel Cascade Lake): performance governor is effective
# For T2D (AMD): amd_pstate driver is available

# GCP recommends setting performance governor for production
cpupower frequency-set -g performance
```

## Section 7: Monitoring and Alerting

### 7.1 Prometheus Node Exporter Metrics

```bash
# CPU frequency metrics exposed by node_exporter
# node_cpu_frequency_hertz{cpu="0"} - current frequency
# node_cpu_frequency_max_hertz{cpu="0"} - max frequency
# node_cpu_frequency_min_hertz{cpu="0"} - min frequency

# Alert: CPU running significantly below max frequency (thermal throttle or wrong governor)
cat > /etc/prometheus/rules/cpu-frequency.yml << 'EOF'
groups:
  - name: cpu_frequency
    rules:
      - alert: CPUFrequencyTooLow
        expr: |
          (
            avg by(instance, cpu) (node_cpu_frequency_hertz)
            /
            avg by(instance, cpu) (node_cpu_frequency_max_hertz)
          ) < 0.7
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "CPU {{ $labels.cpu }} on {{ $labels.instance }} running at less than 70% of max frequency"
          description: "CPU may be thermally throttling or governor is set incorrectly. Current: {{ $value | humanizePercentage }}"

      - alert: CPUGovernorNotPerformance
        expr: |
          node_cpu_scaling_governor{governor!="performance"} == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "CPU governor is not set to 'performance' on {{ $labels.instance }}"
          description: "Governor {{ $labels.governor }} detected. Production Kubernetes nodes should use 'performance'."
EOF
```

### 7.2 Custom CPU Frequency Exporter

When node_exporter doesn't expose what you need:

```go
// cmd/cpu-freq-exporter/main.go
package main

import (
    "fmt"
    "net/http"
    "os"
    "path/filepath"
    "strconv"
    "strings"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
    cpuFreqHz = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "cpu_frequency_hz",
            Help: "Current CPU frequency in Hz",
        },
        []string{"cpu", "type"},
    )
    cpuGovernor = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "cpu_scaling_governor_active",
            Help: "CPU scaling governor (1=active)",
        },
        []string{"cpu", "governor"},
    )
    cpuTurboEnabled = prometheus.NewGauge(
        prometheus.GaugeOpts{
            Name: "cpu_turbo_enabled",
            Help: "1 if turbo boost is enabled",
        },
    )
)

func collectCPUMetrics() {
    cpus, _ := filepath.Glob("/sys/devices/system/cpu/cpu*/cpufreq")
    for _, cpufreq := range cpus {
        cpu := filepath.Base(filepath.Dir(cpufreq))

        if freq, err := readSysFile(cpufreq + "/scaling_cur_freq"); err == nil {
            if hz, err := strconv.ParseFloat(strings.TrimSpace(freq), 64); err == nil {
                cpuFreqHz.WithLabelValues(cpu, "current").Set(hz * 1000)
            }
        }

        if freq, err := readSysFile(cpufreq + "/scaling_max_freq"); err == nil {
            if hz, err := strconv.ParseFloat(strings.TrimSpace(freq), 64); err == nil {
                cpuFreqHz.WithLabelValues(cpu, "max").Set(hz * 1000)
            }
        }

        if governor, err := readSysFile(cpufreq + "/scaling_governor"); err == nil {
            cpuGovernor.WithLabelValues(cpu, strings.TrimSpace(governor)).Set(1)
        }
    }

    // Turbo status
    if noTurbo, err := readSysFile("/sys/devices/system/cpu/intel_pstate/no_turbo"); err == nil {
        if strings.TrimSpace(noTurbo) == "0" {
            cpuTurboEnabled.Set(1)
        } else {
            cpuTurboEnabled.Set(0)
        }
    }
}

func readSysFile(path string) (string, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return "", err
    }
    return string(data), nil
}

func main() {
    prometheus.MustRegister(cpuFreqHz, cpuGovernor, cpuTurboEnabled)

    http.Handle("/metrics", promhttp.Handler())
    http.HandleFunc("/collect", func(w http.ResponseWriter, r *http.Request) {
        collectCPUMetrics()
        fmt.Fprintln(w, "Collected")
    })

    // Collect on scrape
    http.HandleFunc("/scrape", func(w http.ResponseWriter, r *http.Request) {
        collectCPUMetrics()
        promhttp.Handler().ServeHTTP(w, r)
    })

    fmt.Println("CPU frequency exporter listening on :9100/metrics")
    http.ListenAndServe(":9100", nil)
}
```

CPU frequency management is the difference between consistent 5ms response times and unpredictable 50-200ms spikes. For production Kubernetes nodes, the investment of 15 minutes to configure `performance` governor, disable deep C-states, and verify turbo behavior pays dividends in predictable workload performance that no amount of application tuning can compensate for.
