---
title: "Linux Power Management: CPU Frequency Scaling and Energy Efficiency for Kubernetes"
date: 2030-08-07T00:00:00-05:00
draft: false
tags: ["Linux", "Power Management", "Kubernetes", "CPU", "Energy Efficiency", "Performance", "cpufreq"]
categories:
- Linux
- Kubernetes
author: "Matthew Mattox - mmattox@support.tools"
description: "Linux power management for Kubernetes nodes: cpufreq governors, Intel P-state and AMD P-state drivers, turbo boost control, energy-aware scheduling, power profiling with powerstat and Intel PCM, and balancing performance vs energy cost in production clusters."
more_link: "yes"
url: "/linux-power-management-cpu-frequency-scaling-energy-efficiency-kubernetes/"
---

CPU power management is one of the most impactful and least discussed levers available to Kubernetes operators. The choice of cpufreq governor alone can swing tail latency by 30% for latency-sensitive workloads, while consuming 40% more energy than necessary for batch workloads that tolerate slower CPUs. Production clusters require intentional power management policies aligned with workload requirements.

<!--more-->

## Overview

This guide covers the Linux CPU frequency scaling subsystem, Intel and AMD platform-specific power management drivers, turbo boost control, energy-aware scheduling in Kubernetes, power profiling tools, and strategies for deploying different power policies across node pools.

## Linux CPU Frequency Scaling Architecture

### The cpufreq Subsystem

The Linux cpufreq subsystem sits between userspace policy (governors) and hardware (drivers):

```
┌─────────────────────────────────────────────────────────┐
│                      Userspace                          │
│          (sysfs: /sys/devices/system/cpu/)              │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                   cpufreq Core                          │
├───────────────────────────────────────────────────────  │
│  Governors                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │performance│ │powersave │ │schedutil │ │  ondemand│   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
├─────────────────────────────────────────────────────────┤
│  Drivers                                                │
│  ┌────────────────┐ ┌────────────────┐                 │
│  │ intel_pstate   │ │ amd_pstate     │                 │
│  │ (HWP/EPP)      │ │ (CPPC)         │                 │
│  └────────────────┘ └────────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

### Inspecting Current Configuration

```bash
# Check available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# active governor:
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor

# Current frequency
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
# Min/max allowed frequency
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_min_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq

# Hardware min/max
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq

# Check driver in use
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# e.g., intel_pstate or acpi-cpufreq or amd_pstate
```

### Governor Overview

| Governor | Behavior | Best for |
|----------|----------|---------|
| `performance` | Always runs at max frequency | Latency-critical workloads, benchmarks |
| `powersave` | Always runs at minimum frequency | Idle nodes, batch with no latency SLA |
| `schedutil` | Scales based on scheduler load (CFS) | General purpose; default on modern kernels |
| `ondemand` | Scales up aggressively, down slowly | Legacy; replaced by schedutil |
| `conservative` | Scales up slowly, down slowly | Embedded; rarely used in data centers |

### Setting Governors via cpupower

```bash
# Install cpupower
apt install -y linux-tools-$(uname -r)   # Ubuntu
dnf install -y kernel-tools              # RHEL/Rocky

# Set performance governor on all CPUs
cpupower frequency-set -g performance

# Set schedutil (power-efficient, latency-aware) on all CPUs
cpupower frequency-set -g schedutil

# Set min/max frequency bounds (useful for capping thermal)
cpupower frequency-set -d 1.2GHz -u 3.6GHz

# Verify
cpupower frequency-info
cpupower monitor
```

## Intel P-state Driver

### Hardware-Managed Power (HWP)

Modern Intel CPUs (Skylake+) support Hardware-Managed Power (HWP), where the CPU hardware itself manages P-states based on hints from the OS via the Energy Performance Preference (EPP) register.

```bash
# Check if HWP is active
cat /sys/devices/system/cpu/intel_pstate/status
# Values: active (HWP), passive (cpufreq governors), off

# Check if HWP is available
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_available_preferences
# Output: default performance balance_performance balance_power power

# Read current EPP value per core
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
```

### Energy Performance Preference Values

| EPP Value | CPU Behavior | Typical Use |
|-----------|-------------|-------------|
| `performance` | Maximize frequency, ignore power | Real-time trading, gaming engines |
| `balance_performance` | Lean toward performance | Latency-sensitive web services |
| `default` | Hardware default balance | General workloads |
| `balance_power` | Lean toward power savings | Mixed or variable load |
| `power` | Maximize efficiency | Batch, CI workers, idle nodes |

```bash
# Set EPP on all CPUs to balance_performance
for cpu in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo "balance_performance" > "$cpu"
done

# Verify
grep . /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference | head -5
```

### intel_pstate Tuning Parameters

```bash
# /sys/devices/system/cpu/intel_pstate/

# Min/max performance percentage (0-100, where 100 = max turbo)
cat /sys/devices/system/cpu/intel_pstate/min_perf_pct   # default: 0
cat /sys/devices/system/cpu/intel_pstate/max_perf_pct   # default: 100

# Disable turbo boost system-wide
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
# Re-enable
echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo

# Cap max frequency to 80% of turbo to reduce thermal throttling
echo 80 > /sys/devices/system/cpu/intel_pstate/max_perf_pct
```

## AMD P-state Driver

### AMD P-state CPPC Driver (Kernel 5.17+)

The `amd_pstate` driver uses Collaborative Processor Performance Control (CPPC) for energy-aware frequency scaling on Zen 2+ processors.

```bash
# Check AMD P-state mode
cat /sys/devices/system/cpu/amd_pstate/status
# Values: active, passive, guided

# Enable active mode (CPPC-controlled, similar to Intel HWP)
echo active > /sys/devices/system/cpu/amd_pstate/status

# AMD P-state EPP is configured the same way as Intel:
echo "balance_performance" > /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference

# Kernel cmdline to control AMD P-state mode
# amd_pstate=active (default for ACPI CPPC-capable systems in kernel 6.1+)
# amd_pstate=passive (use cpufreq governors instead)
# amd_pstate=guided (AMD-CPPC guided mode)
```

### GRUB Configuration for Power Policy

```bash
# /etc/default/grub
GRUB_CMDLINE_LINUX="... intel_pstate=active amd_pstate=active"
# For maximum performance (disable P-state drivers, use ACPI tables):
# GRUB_CMDLINE_LINUX="... intel_pstate=disable"

# For AMD performance mode:
GRUB_CMDLINE_LINUX="... amd_pstate=active amd_pstate.shared_mem=1"

update-grub  # Ubuntu/Debian
grub2-mkconfig -o /boot/grub2/grub.cfg  # RHEL/Rocky
```

## Turbo Boost Control

Turbo Boost (Intel) / Precision Boost (AMD) allows CPUs to briefly exceed base clock when thermal budget permits. In Kubernetes workloads, uncontrolled turbo causes frequency variance that makes latency p99/p999 measurements noisy.

### Per-Instance Turbo Control

```bash
# Disable turbo on all CPUs
# Intel:
echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
# AMD (via MSR):
for cpu in $(seq 0 $(($(nproc)-1))); do
    rdmsr -p $cpu 0xC0010015
    # Bit 25 is the boost disable bit
    wrmsr -p $cpu 0xC0010015 0x02000000  # disable boost
done

# Alternative: use kernel parameter
echo 0 > /sys/devices/system/cpu/cpufreq/boost   # AMD universal interface

# Verify
cat /proc/cpuinfo | grep "cpu MHz"
turbostat --interval 5 --quiet
```

### Systemd Service for Persistent Governor and Turbo Settings

```ini
# /etc/systemd/system/cpu-power-policy.service
[Unit]
Description=CPU Power Policy Configuration
After=multi-user.target
DefaultDependencies=no

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/apply-cpu-power-policy.sh

[Install]
WantedBy=multi-user.target
```

```bash
#!/bin/bash
# /usr/local/bin/apply-cpu-power-policy.sh
set -euo pipefail

POLICY="${CPU_POWER_POLICY:-balance_performance}"
TURBO_ENABLED="${CPU_TURBO_ENABLED:-true}"
MAX_PERF_PCT="${CPU_MAX_PERF_PCT:-100}"

# Detect driver
DRIVER=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver 2>/dev/null || echo "unknown")

echo "Applying CPU power policy: POLICY=$POLICY DRIVER=$DRIVER TURBO=$TURBO_ENABLED"

case "$DRIVER" in
    intel_pstate)
        # Set EPP
        for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
            echo "$POLICY" > "$f" 2>/dev/null || true
        done
        # Turbo control
        if [[ "$TURBO_ENABLED" == "false" ]]; then
            echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo
        else
            echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo
        fi
        echo "$MAX_PERF_PCT" > /sys/devices/system/cpu/intel_pstate/max_perf_pct
        ;;
    amd_pstate|amd_pstate_epp)
        for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
            echo "$POLICY" > "$f" 2>/dev/null || true
        done
        if [[ "$TURBO_ENABLED" == "false" ]]; then
            echo 0 > /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || true
        else
            echo 1 > /sys/devices/system/cpu/cpufreq/boost 2>/dev/null || true
        fi
        ;;
    acpi-cpufreq)
        # Use cpupower for legacy ACPI driver
        case "$POLICY" in
            performance) cpupower frequency-set -g performance ;;
            power|powersave) cpupower frequency-set -g powersave ;;
            *) cpupower frequency-set -g schedutil ;;
        esac
        ;;
esac

echo "CPU power policy applied successfully"
```

## Energy-Aware Scheduling in Kubernetes

Kubernetes energy-aware scheduling routes pods to nodes that minimize energy consumption while satisfying resource constraints.

### Node Labels for Power Policy

```bash
# Label nodes by their power profile
kubectl label node worker-01 power-policy=performance turbo=enabled
kubectl label node worker-02 power-policy=balanced turbo=enabled
kubectl label node worker-batch-01 power-policy=powersave turbo=disabled
kubectl label node worker-batch-02 power-policy=powersave turbo=disabled

# Label nodes with CPU architecture for affinity
kubectl label node worker-01 cpu-vendor=intel cpu-gen=icelake
kubectl label node worker-batch-01 cpu-vendor=amd cpu-gen=zen3
```

### DaemonSet to Apply Per-Node Power Policy

```yaml
# power-policy-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: cpu-power-policy
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: cpu-power-policy
  template:
    metadata:
      labels:
        app: cpu-power-policy
    spec:
      priorityClassName: system-node-critical
      hostPID: true
      tolerations:
      - operator: Exists
      volumes:
      - name: sys
        hostPath:
          path: /sys
      initContainers:
      - name: apply-policy
        image: registry.support.tools/cpu-power-policy:v1.0.0
        securityContext:
          privileged: true
        env:
        - name: CPU_POWER_POLICY
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['power-policy']
        - name: CPU_TURBO_ENABLED
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['turbo']
        volumeMounts:
        - name: sys
          mountPath: /sys
        command: ["/usr/local/bin/apply-cpu-power-policy.sh"]
      containers:
      - name: pause
        image: registry.k8s.io/pause:3.9
        resources:
          requests:
            cpu: 10m
            memory: 8Mi
          limits:
            cpu: 10m
            memory: 8Mi
```

### Pod Scheduling with Power Policy Affinity

```yaml
# latency-critical deployment targeting performance nodes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-api
spec:
  template:
    spec:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
            - matchExpressions:
              - key: power-policy
                operator: In
                values:
                - performance
              - key: turbo
                operator: In
                values:
                - enabled
      containers:
      - name: payment-api
        image: registry.support.tools/payment-api:v3.2.1
        resources:
          requests:
            cpu: "2"
            memory: "1Gi"
          limits:
            cpu: "4"
            memory: "2Gi"
---
# Batch workload targeting low-power nodes
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
  jobTemplate:
    spec:
      template:
        spec:
          affinity:
            nodeAffinity:
              requiredDuringSchedulingIgnoredDuringExecution:
                nodeSelectorTerms:
                - matchExpressions:
                  - key: power-policy
                    operator: In
                    values:
                    - powersave
          containers:
          - name: report-generator
            image: registry.support.tools/report-generator:v1.0.0
```

### CPU Manager Policy

For Guaranteed QoS pods requiring low-latency CPU access, use the `static` CPU Manager policy:

```yaml
# kubelet config
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  full-pcpus-only: "true"  # Allocate complete physical CPUs (avoids HT splitting)
reservedSystemCPUs: "0,1"   # Reserve CPUs 0 and 1 for OS/kubelet
topologyManagerPolicy: best-effort
topologyManagerScope: pod
```

## Power Profiling with powerstat and Intel PCM

### powerstat

```bash
# Install powerstat
apt install -y powerstat  # Ubuntu
# Or build from source for RHEL

# Monitor power consumption every 5 seconds
sudo powerstat -d 0 5 10

# Sample output:
# Time  User   Nice  Sys  Idle  Wait  Ctxt/s  IRQ/s  Fork  Exec  Exit  Watts
# 12:00  23.4    0.0  2.1  74.5   0.0  127432  84521   312   298   287  142.3
# 12:01  31.2    0.0  3.4  65.4   0.0  198543  96234   418   392   384  189.7
```

### Intel Performance Counter Monitor (PCM)

```bash
# Install Intel PCM
git clone https://github.com/intel/pcm.git
cd pcm && mkdir build && cd build
cmake .. && make -j$(nproc)
sudo make install

# Monitor CPU power and frequency
sudo pcm 5  # 5-second intervals

# Monitor DRAM, package, and core power
sudo pcm-power 5

# Monitor per-core frequency
sudo pcm-core 5

# Output example:
# Socket 0: package power = 87.5W, DRAM power = 12.3W
# Core 0: freq=3600MHz, IPC=2.31, temp=52°C
# Core 1: freq=3400MHz, IPC=1.87, temp=48°C
```

### turbostat for Detailed Frequency Analysis

```bash
# Install
apt install -y linux-tools-common linux-tools-$(uname -r)

# Monitor with 5-second interval
sudo turbostat --interval 5 --show \
  Package,Core,CPU,Avg_MHz,Busy%,Bzy_MHz,TSC_MHz,IRQ,SMI,POLL%,C1%,C3%,C6%,PTSC,PkgWatt,CoreWatt,RAMWatt

# Sample output (truncated):
# Package  Core  CPU  Avg_MHz  Busy%  Bzy_MHz  TSC_MHz  PkgWatt
#       0     0    0     3412   94.6     3609     3600    87.3
#       0     0    1     3389   94.0     3605     3600    87.3
#       0     1    2     2891   80.2     3602     3600    87.3
```

### perf for Energy Events

```bash
# Measure energy consumption during a workload
sudo perf stat -e power/energy-pkg/,power/energy-ram/ \
  -I 1000 \
  -- sleep 60

# Output:
# 1.000 s   energy-pkg:  87,421.23 Joules
# 1.000 s   energy-ram:  12,183.45 Joules

# Per-process energy attribution
sudo perf stat -e power/energy-pkg/ -p $(pidof workload-binary)
```

## Balancing Performance vs Energy Cost

### Cost-Per-Request Analysis

Energy cost can be attributed to workload types:

```bash
# Measure requests/second and watts simultaneously
# In terminal 1: run load test
hey -n 100000 -c 100 http://service:8080/api/endpoint

# In terminal 2: measure power
sudo turbostat --interval 1 --quiet --show PkgWatt

# Calculate:
# RPS=5000, PkgWatt=120W -> 120W / 5000 RPS = 0.024 Wh per 1000 requests
```

### Node Pool Power Policy Matrix

| Node Pool | Governor | EPP | Turbo | Target Workloads |
|-----------|----------|-----|-------|-----------------|
| `perf-pool` | active (HWP) | performance | enabled | Payment, auth, real-time APIs |
| `balanced-pool` | active (HWP) | balance_performance | enabled | Web services, microservices |
| `efficient-pool` | active (HWP) | balance_power | enabled | Background jobs, async processing |
| `batch-pool` | powersave | power | disabled | CI/CD, nightly ETL, data processing |

### Cluster Autoscaler Integration

Scale batch node pools down during off-peak hours to eliminate idle power consumption:

```yaml
# cluster-autoscaler-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-status
  namespace: kube-system
data:
  nodes: |
    batch-pool:
      min: 0         # Scale to zero during off-peak
      max: 50
      schedule:      # Only available during business hours
        up: "0 6 * * 1-5"
        down: "0 22 * * 1-5"
```

### Thermal Throttling Detection

```bash
# Check for thermal throttling events
sudo dmesg | grep -i "thermal\|throttle\|overheat"

# Monitor thermal zones
watch -n 1 "cat /sys/class/thermal/thermal_zone*/temp | awk '{print \$1/1000 \"°C\"}'"

# Check CPU throttle via MSR (Intel)
sudo rdmsr -p 0 0x1B1  # IA32_THERM_STATUS
# Bit 4: thermal throttle status

# Alert on consistent throttling in Prometheus
# node_cpu_core_throttles_total > 0 for sustained period
```

## BIOS/UEFI Settings for Production Clusters

Kubernetes performance nodes should have these BIOS settings configured before OS installation:

| Setting | Value | Reason |
|---------|-------|--------|
| CPU Performance Mode | Maximum | Override OS power management |
| C-States | Enabled (C1) or Disabled | Deep C-states add wake latency |
| Turbo Boost/XFR | Enabled | Allow hardware frequency boosting |
| Hyperthreading | Enabled | Required for CPU Manager static policy |
| NUMA | Enabled | Required for topology-aware scheduling |
| Power Cap | Not set | Let CPU manage thermally |
| Memory Power Management | Performance | Avoid DRAM frequency scaling |

For batch/efficiency nodes:
- Enable all C-states (C6, PC6) for deep sleep savings
- Enable power capping at 80% of TDP
- Enable memory power management

## Summary

Linux CPU power management is a multi-layer system where the optimal configuration depends entirely on workload characteristics. Latency-sensitive Kubernetes workloads benefit from the `performance` EPP on Intel HWP and AMD P-state CPPC systems, with turbo enabled and deep C-states potentially disabled to eliminate wake latency. Batch workloads achieve 30-40% energy savings with `balance_power` or `powersave` settings with no impact on throughput-oriented SLAs. Node labels, DaemonSet-driven policy application, and pod affinity rules provide the Kubernetes-native mechanism for enforcing these policies consistently across heterogeneous cluster fleets.
