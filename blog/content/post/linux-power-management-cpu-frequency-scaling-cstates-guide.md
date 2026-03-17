---
title: "Linux Power Management: CPU Frequency Scaling, C-States, and Energy-Aware Scheduling"
date: 2030-01-28T00:00:00-05:00
draft: false
tags: ["Linux", "Power Management", "CPU", "Energy", "Kubernetes", "Performance", "RAPL"]
categories: ["Linux", "Performance", "Infrastructure"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Master Linux power management for servers: cpufreq governors, C-state tuning, energy-aware scheduling in Kubernetes, power capping with RAPL, and balancing performance vs power consumption."
more_link: "yes"
url: "/linux-power-management-cpu-frequency-scaling-cstates-guide/"
---

Power management on Linux servers is a multi-dimensional optimization problem. Data center operators want to maximize work per watt while meeting SLA latency requirements. The tools Linux provides — P-states for frequency scaling, C-states for idle power reduction, RAPL for power capping, and energy-aware scheduling for workload placement — form a complete power management stack that can reduce energy consumption by 30-60% on lightly loaded servers without sacrificing performance for critical workloads.

This guide covers the Linux power management stack from kernel cpufreq governors through RAPL power capping, with specific attention to Kubernetes energy-aware scheduling and monitoring power consumption with Prometheus.

<!--more-->

## The Linux Power Management Stack

Linux power management operates at multiple CPU levels simultaneously:

```
Application Layer         │ taskset, nice, chrt
─────────────────────────┤
Scheduler (CFS/EAS)       │ Energy-aware task placement
─────────────────────────┤
P-States (cpufreq)        │ Operating frequency/voltage (dynamic)
─────────────────────────┤
C-States (cpuidle)        │ Idle sleep depths (power gating)
─────────────────────────┤
Power Capping (RAPL)      │ Hardware power limits (TDP enforcement)
─────────────────────────┤
Hardware (CPU/Package)    │ Physical power delivery
```

### Understanding P-States vs C-States

- **P-States (Performance States)**: Active CPU frequency/voltage pairs. P0 is maximum performance, Pmax is minimum. Managed by `cpufreq` subsystem.
- **C-States (CPU Idle States)**: Sleep depths when CPU is idle. C0 is active, deeper states (C1, C1E, C2, C3, C6, C7...) progressively cut more power but take longer to wake.
- **T-States (Throttle States)**: Thermal throttling. Generally avoided in well-designed systems.

## CPU Frequency Scaling (cpufreq)

### Available Governors

```bash
# List available governors
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors
# conservative ondemand userspace powersave performance schedutil

# Check current governor on all CPUs
cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# Check current frequency
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq
# 3400000 (in KHz = 3.4 GHz)

# Check min/max supported frequencies
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq
cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq
```

### Governor Comparison

| Governor | Use Case | Behavior |
|---|---|---|
| `performance` | Low-latency, RT | Always at max frequency |
| `powersave` | Maximum efficiency | Always at min frequency |
| `ondemand` | General purpose | Scales up instantly, decays slowly |
| `conservative` | Gradual scaling | Scales up/down gradually |
| `schedutil` | Modern default | Uses CFS utilization signal |
| `userspace` | Manual control | User sets frequency directly |

### schedutil: The Modern Default

`schedutil` is the recommended governor for most production servers because it uses the kernel scheduler's utilization data directly, enabling sub-millisecond frequency decisions:

```bash
# Set schedutil on all CPUs
for CPU in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo schedutil > $CPU
done

# Configure schedutil parameters
# rate_limit_us: minimum time between frequency changes (default: 50000us = 50ms)
# For faster response on interactive workloads:
echo 500 > /sys/devices/system/cpu/cpufreq/schedutil/rate_limit_us

# For server workloads with predictable patterns (less churn):
echo 10000 > /sys/devices/system/cpu/cpufreq/schedutil/rate_limit_us
```

### Persistent Governor Configuration

```bash
# systemd-based persistent configuration
# /etc/systemd/system/cpufreq-governor.service
sudo tee /etc/systemd/system/cpufreq-governor.service << 'EOF'
[Unit]
Description=Set CPU Frequency Governor
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo schedutil > $f; done'
ExecStart=/bin/bash -c 'echo 1000 > /sys/devices/system/cpu/cpufreq/schedutil/rate_limit_us'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now cpufreq-governor

# Verify
sudo systemctl status cpufreq-governor
```

### Intel P-State Driver (HWP)

Modern Intel CPUs use the `intel_pstate` driver which bypasses the cpufreq governor and manages P-states in hardware:

```bash
# Check if intel_pstate is active
cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_driver
# intel_pstate  OR  intel_cpufreq (depending on BIOS/kernel config)

# Intel HWP (Hardware P-State) modes
cat /sys/devices/system/cpu/intel_pstate/status
# active  (HWP engaged, governor selection limited)

# HWP performance hint
# EPP = Energy Performance Preference (0=performance, 128=balance_performance,
#       192=balance_power, 255=power)
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference
# balance_performance

# Set all CPUs to performance EPP
for f in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
    echo performance > $f
done

# Available EPP values
cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_available_preferences
# default performance balance_performance balance_power power
```

## CPU Idle States (C-States)

### Understanding C-State Depths

```bash
# List all C-states for CPU0
ls /sys/devices/system/cpu/cpu0/cpuidle/
# state0  state1  state2  state3  state4

# Get C-state information
for STATE in /sys/devices/system/cpu/cpu0/cpuidle/state*/; do
    NAME=$(cat ${STATE}name)
    DESC=$(cat ${STATE}desc)
    LATENCY=$(cat ${STATE}latency)
    POWER=$(cat ${STATE}power)
    DISABLE=$(cat ${STATE}disable)
    echo "State: $NAME | Desc: $DESC | Exit Latency: ${LATENCY}us | Residency Power: ${POWER}mW | Disabled: $DISABLE"
done

# Example output on Intel server:
# State: POLL    | Desc: CPUIDLE CORE POLL IDLE            | Exit Latency: 0us   | Power: 4294967295mW | Disabled: 0
# State: C1      | Desc: MWAIT 0x00                         | Exit Latency: 2us   | Power: 0mW          | Disabled: 0
# State: C1E     | Desc: MWAIT 0x01                         | Exit Latency: 10us  | Power: 0mW          | Disabled: 0
# State: C3      | Desc: MWAIT 0x10                         | Exit Latency: 40us  | Power: 0mW          | Disabled: 0
# State: C6      | Desc: MWAIT 0x20                         | Exit Latency: 133us | Power: 0mW          | Disabled: 0
```

### C-State Tuning for Latency vs Power

```bash
# OPTION 1: Maximum performance (all deep C-states disabled)
# Best for RT workloads, trades idle power for latency
for STATE in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
    STATE_NAME=$(cat $(dirname $STATE)/name)
    # Only allow POLL and C1 states
    if [[ "$STATE_NAME" != "POLL" && "$STATE_NAME" != "C1" ]]; then
        echo 1 > $STATE
    fi
done

# OPTION 2: Balanced (disable C6+ but allow C1E/C3)
# Good for most production servers
for CPU in $(seq 0 $(($(nproc) - 1))); do
    for STATE_DIR in /sys/devices/system/cpu/cpu${CPU}/cpuidle/state*/; do
        STATE_NAME=$(cat ${STATE_DIR}name)
        LATENCY=$(cat ${STATE_DIR}latency)
        # Disable states with > 100us exit latency
        if [[ "$LATENCY" -gt 100 ]]; then
            echo 1 > ${STATE_DIR}disable
        fi
    done
done

# OPTION 3: Maximum power savings (all states enabled, let kernel decide)
for STATE in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
    echo 0 > $STATE
done

# OPTION 4: Use pm_qos for per-process latency requirements
# This is the recommended kernel interface
# Request max 50us CPU latency (disables C-states with higher exit latency)
cat /dev/cpu_dma_latency  # Open and hold to assert latency requirement
```

### CPU DMA Latency Interface

The proper kernel interface for C-state control is the latency QoS API:

```c
// rt-latency-hold.c
// Prevents deep C-states for the lifetime of this process
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

int main() {
    int fd = open("/dev/cpu_dma_latency", O_RDWR);
    if (fd < 0) {
        perror("open /dev/cpu_dma_latency");
        return 1;
    }

    // Request max 50 microsecond C-state exit latency
    // This prevents C3/C6/C7 states from being used
    int32_t latency_us = 50;
    if (write(fd, &latency_us, sizeof(latency_us)) < 0) {
        perror("write latency");
        return 1;
    }

    printf("Holding CPU DMA latency <= %d us. Press Ctrl+C to release.\n", latency_us);
    printf("This prevents deep C-states while this process runs.\n");

    // Hold the file descriptor open (C-state limit applies while open)
    pause();

    close(fd);
    return 0;
}
```

```bash
# Compile and run as a background service for RT applications
gcc -o rt-latency-hold rt-latency-hold.c
sudo ./rt-latency-hold &

# Verify latency QoS in effect
cat /sys/devices/system/cpu/cpu0/cpuidle/state4/disable
# 1  (disabled due to QoS request)
```

## RAPL: Running Average Power Limit

Intel RAPL provides hardware-level power monitoring and capping at the package, core, uncore (DRAM), and GPU domain levels.

### Reading Power with RAPL

```bash
# List RAPL zones
ls /sys/class/powercap/intel-rapl/
# intel-rapl:0  intel-rapl:1  (one per CPU socket)

# Check zone names
for ZONE in /sys/class/powercap/intel-rapl/*/; do
    NAME=$(cat ${ZONE}name)
    ENERGY=$(cat ${ZONE}energy_uj)  # In microjoules
    echo "Zone: $NAME | Energy: ${ENERGY} uJ"
done

# Read power consumption over 1 second interval
read_power() {
    local ZONE=$1
    local E1=$(cat $ZONE/energy_uj)
    sleep 1
    local E2=$(cat $ZONE/energy_uj)
    local POWER=$(echo "scale=2; ($E2 - $E1) / 1000000" | bc)
    echo "${POWER}W"
}

# CPU package power
read_power /sys/class/powercap/intel-rapl/intel-rapl:0
# 45.23W
```

### Configuring Power Limits with RAPL

```bash
# View current power limits
ZONE="/sys/class/powercap/intel-rapl/intel-rapl:0"

cat ${ZONE}/constraint_0_name       # long_term
cat ${ZONE}/constraint_0_power_limit_uw   # power limit in microwatts
cat ${ZONE}/constraint_0_time_window_us   # averaging window in microseconds

cat ${ZONE}/constraint_1_name       # short_term (turbo window)
cat ${ZONE}/constraint_1_power_limit_uw
cat ${ZONE}/constraint_1_time_window_us

# Set long-term power limit to 150W (150000000 uW)
echo 150000000 > ${ZONE}/constraint_0_power_limit_uw
echo 1          > ${ZONE}/enabled

# Verify
cat ${ZONE}/constraint_0_power_limit_uw
# 150000000
```

### turbostat: Comprehensive Power Monitoring

```bash
# Install turbostat
sudo apt install linux-tools-$(uname -r)

# Monitor CPU power, frequency, and C-state residency
sudo turbostat --quiet --show \
  CoreTmp,PkgTmp,Avg_MHz,Busy%,Bzy_MHz,TSC_MHz,IRQ,CPU%c1,CPU%c3,CPU%c6,CPU%c7,PkgWatt,CorWatt,RAMWatt \
  --interval 1

# Sample output:
# CoreTmp PkgTmp Avg_MHz Busy%  Bzy_MHz  IRQ  CPU%c1  CPU%c6  PkgWatt
#      45     48    1245  35.2%    3541  1205   42.1%   22.7%    78.3W
#      42     48    1102  28.4%    3541   982   48.6%   23.0%    72.1W
```

### powertop: Interactive Power Analysis

```bash
# Install powertop
sudo apt install powertop

# Interactive monitoring
sudo powertop

# Generate HTML report
sudo powertop --html=powertop-report.html --time=30

# Auto-tune for power savings (test in non-production first)
sudo powertop --auto-tune

# View wake-up sources (what prevents CPU from sleeping)
sudo powertop --csv=wakeups.csv --time=10
```

## Energy-Aware Scheduling in Linux

Energy-Aware Scheduling (EAS) in the Linux kernel allows the scheduler to place tasks on the most energy-efficient CPU based on a system energy model. Primarily designed for mobile (big.LITTLE), it also applies to server systems with asymmetric CPUs.

### Checking EAS Status

```bash
# EAS requires: schedutil governor + Energy Model (EM) + CONFIG_ENERGY_MODEL
cat /sys/kernel/debug/sched/features | grep EAS
# ENERGY_AWARE  (enabled)

# Energy model for the system
cat /sys/devices/system/cpu/cpufreq/policy0/em/table_size
cat /sys/devices/system/cpu/cpufreq/policy0/em/active_power
```

### EAS in Kubernetes: Node Energy Efficiency

Kubernetes does not natively understand CPU energy, but you can combine EAS with topology-aware scheduling:

```yaml
# Prefer nodes with lower utilization (EAS will place tasks more efficiently)
apiVersion: v1
kind: Pod
metadata:
  name: energy-efficient-workload
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: myapp
  # Request specific CPU topology for NUMA locality
  containers:
    - name: app
      resources:
        requests:
          cpu: "2"
        limits:
          cpu: "2"
```

### kepler: Kubernetes Energy Consumption Monitoring

```bash
# Deploy Kepler for per-pod power consumption metrics
helm repo add kepler https://sustainable-computing-io.github.io/kepler-helm-chart
helm install kepler kepler/kepler \
  --namespace monitoring \
  --set serviceMonitor.enabled=true \
  --set canMount.usrSrc=true

# Kepler exposes per-pod power metrics:
# kepler_container_joules_total{container_namespace, container_name, pod_name}
# kepler_container_cpu_joules_total
# kepler_container_dram_joules_total
```

### PromQL for Power Monitoring

```promql
# Total cluster power consumption in watts
sum(rate(kepler_node_package_joules_total[1m]))

# Power per namespace (top 10 most power-hungry)
topk(10,
  sum by (namespace) (
    rate(kepler_container_joules_total{container!=""}[1m])
  )
)

# Average CPU utilization vs power efficiency
(
  sum by (node) (rate(node_cpu_seconds_total{mode!="idle"}[5m]))
) / on(node) group_left() (
  sum by (node) (rate(kepler_node_package_joules_total[5m]))
)

# Alert: Node power exceeds cap
- alert: NodePowerExceedsCapacity
  expr: |
    sum by (node) (rate(kepler_node_package_joules_total[2m])) > 200
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Node {{ $labels.node }} power {{ $value | humanize }}W exceeds 200W cap"
```

## Complete Power Management Script

```bash
#!/bin/bash
# /usr/local/sbin/power-profile.sh
# Apply a named power profile to the system

PROFILE="${1:-balanced}"

apply_performance_profile() {
    echo "Applying PERFORMANCE profile..."
    # Max frequency, disable all C-states above C1
    for GOV in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        echo performance > $GOV 2>/dev/null || true
    done
    for EPP in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
        echo performance > $EPP 2>/dev/null || true
    done
    for CPU in $(seq 0 $(($(nproc) - 1))); do
        for STATE in /sys/devices/system/cpu/cpu${CPU}/cpuidle/state*/; do
            NAME=$(cat ${STATE}name 2>/dev/null)
            LATENCY=$(cat ${STATE}latency 2>/dev/null || echo 0)
            [[ "$LATENCY" -gt 10 ]] && echo 1 > ${STATE}disable 2>/dev/null || true
        done
    done
    echo "Performance profile applied."
}

apply_balanced_profile() {
    echo "Applying BALANCED profile..."
    for GOV in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        echo schedutil > $GOV 2>/dev/null || true
    done
    for EPP in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
        echo balance_performance > $EPP 2>/dev/null || true
    done
    # Allow C-states up to 100us exit latency
    for CPU in $(seq 0 $(($(nproc) - 1))); do
        for STATE in /sys/devices/system/cpu/cpu${CPU}/cpuidle/state*/; do
            LATENCY=$(cat ${STATE}latency 2>/dev/null || echo 0)
            if [[ "$LATENCY" -gt 100 ]]; then
                echo 1 > ${STATE}disable 2>/dev/null || true
            else
                echo 0 > ${STATE}disable 2>/dev/null || true
            fi
        done
    done
    echo "Balanced profile applied."
}

apply_powersave_profile() {
    echo "Applying POWERSAVE profile..."
    for GOV in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        echo powersave > $GOV 2>/dev/null || true
    done
    for EPP in /sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference; do
        echo power > $EPP 2>/dev/null || true
    done
    # Enable all C-states
    for STATE in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
        echo 0 > $STATE 2>/dev/null || true
    done
    echo "Powersave profile applied."
}

case "$PROFILE" in
    performance) apply_performance_profile ;;
    balanced)    apply_balanced_profile ;;
    powersave)   apply_powersave_profile ;;
    *)
        echo "Usage: $0 {performance|balanced|powersave}"
        exit 1
        ;;
esac

# Report current state
echo ""
echo "=== Current Power State ==="
echo "Governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)"
echo "Current frequency: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq) kHz"
if [ -f /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference ]; then
    echo "EPP: $(cat /sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference)"
fi
echo "C-states enabled:"
for STATE in /sys/devices/system/cpu/cpu0/cpuidle/state*/; do
    NAME=$(cat ${STATE}name)
    DISABLED=$(cat ${STATE}disable)
    STATUS=$([[ "$DISABLED" == "0" ]] && echo "enabled" || echo "disabled")
    echo "  $NAME: $STATUS"
done
```

## Kubernetes Power-Aware Node Configuration

### Node Labels for Power Profiles

```bash
# Label nodes by power profile
kubectl label node worker-01 power-profile=performance
kubectl label node worker-02 power-profile=balanced
kubectl label node worker-03 power-profile=powersave

# DaemonSet to apply profiles based on node labels
```

```yaml
# power-profile-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: power-profile-controller
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: power-profile-controller
  template:
    metadata:
      labels:
        app: power-profile-controller
    spec:
      hostPID: true
      tolerations:
        - operator: Exists
      containers:
        - name: power-controller
          image: yourorg/power-profile-controller:latest
          securityContext:
            privileged: true
          volumeMounts:
            - name: sys
              mountPath: /sys
            - name: proc
              mountPath: /proc
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          command:
            - /bin/bash
            - -c
            - |
              PROFILE=$(kubectl get node $NODE_NAME -o jsonpath='{.metadata.labels.power-profile}' 2>/dev/null || echo balanced)
              /usr/local/sbin/power-profile.sh "$PROFILE"
              # Watch for label changes
              kubectl get node $NODE_NAME -w -o jsonpath='{.metadata.labels.power-profile}' 2>/dev/null | \
                while read NEW_PROFILE; do
                  echo "Profile changed to: $NEW_PROFILE"
                  /usr/local/sbin/power-profile.sh "$NEW_PROFILE"
                done
      volumes:
        - name: sys
          hostPath:
            path: /sys
        - name: proc
          hostPath:
            path: /proc
```

### Workload Scheduling to Power Profiles

```yaml
# Schedule latency-sensitive workloads to performance nodes
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
spec:
  template:
    spec:
      nodeSelector:
        power-profile: performance
      containers:
        - name: api-gateway
          resources:
            requests:
              cpu: "2"
            limits:
              cpu: "4"
---
# Schedule batch workloads to power-saving nodes
apiVersion: batch/v1
kind: CronJob
metadata:
  name: report-generator
spec:
  jobTemplate:
    spec:
      template:
        spec:
          nodeSelector:
            power-profile: powersave
          containers:
            - name: report
              resources:
                requests:
                  cpu: "1"
                limits:
                  cpu: "2"
```

## Monitoring Power with node_exporter

```yaml
# node-exporter with power monitoring
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
spec:
  template:
    spec:
      containers:
        - name: node-exporter
          image: prom/node-exporter:latest
          args:
            - --collector.cpu
            - --collector.cpufreq          # CPU frequency metrics
            - --collector.thermal_zone     # Temperature metrics
            - --collector.powersupplyclass # PSU power metrics
            - --path.sysfs=/host/sys
          volumeMounts:
            - name: sys
              mountPath: /host/sys
              readOnly: true
```

```promql
# Current CPU frequency by node
node_cpu_scaling_frequency_hertz{cpu="cpu0"}

# Average CPU frequency across cluster
avg by (instance) (node_cpu_scaling_frequency_hertz)

# CPU temperature by core
node_hwmon_temp_celsius{chip=~"coretemp.*"}

# Alert: CPU thermal throttling detected
- alert: CPUThermalThrottling
  expr: node_cpu_scaling_frequency_hertz / node_cpu_scaling_frequency_max_hertz < 0.7
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "CPU {{ $labels.cpu }} on {{ $labels.instance }} running at {{ $value | humanizePercentage }} of max frequency"
```

## Key Takeaways

Linux power management provides fine-grained control over the CPU power-performance tradeoff:

1. **schedutil governor is the modern default**: It uses the scheduler's per-CPU utilization signal for sub-millisecond frequency decisions, combining responsiveness with efficiency better than `ondemand`.

2. **C-states are the biggest idle power levers**: Enabling C6/C7 on idle CPUs can reduce package power by 60-80% during low utilization periods. The tradeoff is wake latency (100-133us for C6).

3. **RAPL provides hardware power capping**: For workloads that must not exceed thermal or power budget constraints, RAPL constraints enforce limits in hardware without software polling.

4. **EPP on Intel HWP systems provides OS hints**: Setting Energy Performance Preference to `balance_performance` or `performance` communicates workload sensitivity to the hardware P-state manager.

5. **Kepler enables per-pod energy attribution**: Without pod-level energy data, you cannot chargeback power costs or identify energy-inefficient workloads. Kepler uses RAPL and eBPF to attribute energy to containers.

6. **Power profiles should match workload types**: Batch processing nodes can use `powersave`, API serving nodes need `balanced` or `performance`, RT nodes need `performance` with C-state limiting.

7. **Test power changes under realistic load**: A governor that saves power at 20% utilization may hurt throughput at 80%. Always benchmark with production-representative load before committing to settings.
