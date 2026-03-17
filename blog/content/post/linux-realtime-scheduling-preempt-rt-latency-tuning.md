---
title: "Linux Real-Time Scheduling: PREEMPT_RT Patch, Latency Tuning, and RT Workload Isolation"
date: 2030-01-25T00:00:00-05:00
draft: false
tags: ["Linux", "Real-Time", "PREEMPT_RT", "Kernel", "Latency", "CPU Isolation", "Performance"]
categories: ["Linux", "Performance", "Systems"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Configure Linux real-time scheduling with PREEMPT_RT, tune SCHED_FIFO and SCHED_RR policies, isolate CPUs with isolcpus, manage interrupt affinity, and measure latency with cyclictest for production RT workloads."
more_link: "yes"
url: "/linux-realtime-scheduling-preempt-rt-latency-tuning/"
---

Real-time Linux is not about being fast — it is about being predictable. A system where the 99.9999th percentile latency is bounded tightly is far more valuable for control systems, telecommunications, financial trading, and industrial automation than a system that averages fast but occasionally stalls for 50 milliseconds. The PREEMPT_RT patch transforms the mainline Linux kernel into a fully preemptible real-time kernel by converting spinlocks to mutexes, making interrupt handlers threaded, and eliminating the final non-preemptible code sections.

This guide covers building and configuring an RT kernel, configuring CPU isolation, tuning interrupt affinity, setting real-time scheduling policies, and validating latency with cyclictest.

<!--more-->

## Understanding Linux Preemption Models

The Linux kernel supports five preemption models, each trading throughput for latency:

| Kernel Config | Preemption Model | Typical Worst-Case Latency |
|---|---|---|
| `PREEMPT_NONE` | No preemption (server default) | 100ms+ |
| `PREEMPT_VOLUNTARY` | Voluntary preemption points | 10-100ms |
| `PREEMPT` | Standard preemptible kernel | 1-10ms |
| `PREEMPT_RT` | Full preemption (RT patch) | 50-500us |
| `PREEMPT_RT` + tuning | Full preemption, tuned | 10-100us |

The PREEMPT_RT patch, maintained by Thomas Gleixner and Sebastian Siewior, was partially merged into mainline with kernel 5.15 and fully integrated as of 6.6 (RHEL 9.2+ and Ubuntu 24.04 include it).

### What PREEMPT_RT Changes

Without PREEMPT_RT, these kernel sections are non-preemptible and introduce latency:
- Spinlock critical sections
- Interrupt service routines (ISRs)
- Softirq handlers
- RCU read-side critical sections

With PREEMPT_RT:
- Spinlocks become sleeping mutexes (rt_mutex)
- ISRs run as threaded interrupts (IRQF_NO_THREAD forces hard-IRQ)
- Softirqs run in dedicated kernel threads (`ksoftirqd`)
- Timer callbacks are threaded

## Building the PREEMPT_RT Kernel

### On Systems Without Native RT Kernel Packages

```bash
# Check if RT patch is available as distro package first
uname -r
# If kernel version >= 6.6 and distro ships it:
apt-cache search linux-image | grep realtime
# Ubuntu:
sudo apt install linux-image-realtime linux-headers-realtime

# Fedora/RHEL:
sudo dnf install kernel-rt kernel-rt-devel
```

### Building from Source (when distro packages are unavailable)

```bash
# Install build dependencies
sudo apt install -y build-essential libncurses-dev bison flex \
  libssl-dev libelf-dev dwarves bc pahole

# Fetch kernel source matching RT patch version
KVER="6.6.20"
RT_PATCH="patch-6.6.20-rt26.patch.xz"

wget https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KVER}.tar.xz
wget https://cdn.kernel.org/pub/linux/kernel/projects/rt/6.6/${RT_PATCH}

tar xf linux-${KVER}.tar.xz
cd linux-${KVER}
xz -d ../${RT_PATCH}
patch -p1 < ../patch-${KVER}-rt26.patch

# Use current kernel config as base
cp /boot/config-$(uname -r) .config
make olddefconfig

# Enable full preemption
scripts/config --set-val CONFIG_PREEMPT_RT y
scripts/config --set-val CONFIG_HZ_1000 y
scripts/config --set-val CONFIG_HZ 1000
scripts/config --disable CONFIG_CPU_FREQ_DEFAULT_GOV_ONDEMAND
scripts/config --enable CONFIG_CPU_FREQ_DEFAULT_GOV_PERFORMANCE

# Disable debugging overhead
scripts/config --disable CONFIG_DEBUG_PREEMPT
scripts/config --disable CONFIG_LATENCYTOP
scripts/config --disable CONFIG_SCHEDSTATS
scripts/config --disable CONFIG_LOCKDEP
scripts/config --disable CONFIG_PROVE_LOCKING
scripts/config --disable CONFIG_DEBUG_LOCK_ALLOC

# Build with all available cores
make -j$(nproc) bindeb-pkg LOCALVERSION=-rt

# Install
sudo dpkg -i ../linux-image-${KVER}-rt_*.deb ../linux-headers-${KVER}-rt_*.deb

# Update GRUB to boot RT kernel
sudo update-grub
```

### Verifying RT Kernel Boot

```bash
uname -a
# Expected output:
# Linux hostname 6.6.20-rt #1 SMP PREEMPT_RT Sat Mar 15 12:00:00 UTC 2026 x86_64

cat /sys/kernel/realtime
# Output: 1

# Check preemption model
zcat /proc/config.gz | grep PREEMPT
# CONFIG_PREEMPT_RT=y
# CONFIG_PREEMPT=y
# CONFIG_PREEMPT_COUNT=y
# CONFIG_PREEMPTION=y
```

## CPU Isolation with isolcpus

CPU isolation removes cores from the general-purpose scheduler, dedicating them exclusively to RT tasks. This eliminates OS interference from system threads, workqueue threads, RCU callbacks, and scheduler tick interrupts.

### GRUB Configuration for CPU Isolation

```bash
# Edit GRUB cmdline
sudo vi /etc/default/grub

# Add to GRUB_CMDLINE_LINUX_DEFAULT:
# Isolate CPUs 2-7 (keep 0-1 for OS tasks)
# nohz_full=2-7: tickless mode on isolated CPUs (no scheduler ticks)
# rcu_nocbs=2-7: offload RCU callbacks from isolated CPUs
# irqaffinity=0-1: restrict IRQs to non-isolated CPUs
GRUB_CMDLINE_LINUX_DEFAULT="quiet splash isolcpus=2-7 nohz_full=2-7 rcu_nocbs=2-7 irqaffinity=0-1 nosoftlockup mitigations=off"

sudo update-grub
sudo reboot
```

### Verifying CPU Isolation

```bash
# Verify isolated CPUs
cat /sys/devices/system/cpu/isolated
# 2-7

cat /sys/devices/system/cpu/nohz_full
# 2-7

# Confirm no system threads running on isolated CPUs
ps -eo pid,psr,comm | awk '$2 >= 2 && $2 <= 7'
# Should show only user-pinned processes

# Check scheduler domains
cat /proc/schedstat  # cpus in domain
```

### Moving Kernel Threads Off Isolated CPUs

Even with `isolcpus`, some kernel threads may still wake on isolated CPUs. Move them explicitly:

```bash
# Create a script to migrate kernel threads to CPU 0-1
#!/bin/bash
# /usr/local/sbin/migrate-kthreads.sh

HOUSEKEEPING_CPUS="0-1"
CPUMASK=$(printf '%x' $((0x3)))  # 0b11 = CPUs 0 and 1

for PID in $(ls /proc | grep -E '^[0-9]+$'); do
    COMM=$(cat /proc/$PID/comm 2>/dev/null)
    # Skip user processes
    if [ -d /proc/$PID/task ]; then
        for TID in /proc/$PID/task/*; do
            TID=$(basename $TID)
            taskset -p $CPUMASK $TID 2>/dev/null || true
        done
    fi
done

# Specifically handle workqueue threads
for WQ_CPU_DIR in /sys/bus/workqueue/devices/*/; do
    echo $CPUMASK > ${WQ_CPU_DIR}/cpumask 2>/dev/null || true
done

echo "Kernel threads migrated to CPUs $HOUSEKEEPING_CPUS"
```

```bash
# Run at boot via systemd
sudo tee /etc/systemd/system/migrate-kthreads.service << 'EOF'
[Unit]
Description=Migrate kernel threads to housekeeping CPUs
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/migrate-kthreads.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo chmod +x /usr/local/sbin/migrate-kthreads.sh
sudo systemctl enable --now migrate-kthreads
```

## Interrupt Affinity Configuration

Interrupts not explicitly managed can cause latency spikes on RT CPUs. Configure irqbalance to restrict to housekeeping CPUs and manually assign critical interrupts.

### Configuring irqbalance

```bash
# Configure irqbalance to exclude isolated CPUs
sudo tee /etc/default/irqbalance << 'EOF'
ENABLED=1
ONESHOT=0
OPTIONS="--hintpolicy=exact"
# Banned CPUs: 2-7 (our isolated set)
# Hex mask: CPUs 0-1 = 0x3
IRQBALANCE_BANNED_CPUS=fc  # binary: 11111100 = ban CPUs 2-7 on 8-core system
EOF

sudo systemctl restart irqbalance
```

### Manual Interrupt Affinity for Network Cards

```bash
# List all network interrupts
grep -E 'eth|ens|enp|mlx' /proc/interrupts

# For a NIC with IRQs 120-127 (one per queue):
# Pin RX queues to housekeeping CPUs
for IRQ in $(grep -E 'enp6s0' /proc/interrupts | awk -F: '{print $1}' | tr -d ' '); do
    echo 3 > /proc/irq/$IRQ/smp_affinity      # 0x3 = CPUs 0-1
    echo "0-1" > /proc/irq/$IRQ/smp_affinity_list
done

# Verify
cat /proc/irq/120/smp_affinity_list
# 0-1
```

### Script: Automated IRQ Affinity

```bash
#!/bin/bash
# /usr/local/sbin/set-irq-affinity.sh
# Pins all IRQs to housekeeping CPUs

HOUSEKEEPING_MASK="3"      # hex: CPUs 0-1
HOUSEKEEPING_LIST="0-1"

# Move all IRQs except reserved ones
for IRQ in /proc/irq/*/; do
    IRQ_NUM=$(basename $IRQ)
    [ "$IRQ_NUM" = "0" ] && continue   # Skip timer
    [ "$IRQ_NUM" = "2" ] && continue   # Skip cascade

    echo $HOUSEKEEPING_MASK > /proc/irq/$IRQ_NUM/smp_affinity 2>/dev/null
done

# Restore NVMe IRQs to all CPUs for throughput (non-RT path)
for IRQ in $(grep -E 'nvme' /proc/interrupts | awk -F: '{print $1}' | tr -d ' '); do
    echo ff > /proc/irq/$IRQ/smp_affinity 2>/dev/null || true
done

echo "IRQ affinity set. Housekeeping: $HOUSEKEEPING_LIST"
```

## Real-Time Scheduling Policies

Linux provides three RT-capable scheduling policies:

| Policy | Priority Range | Behavior |
|---|---|---|
| `SCHED_FIFO` | 1-99 | Run until voluntarily yields or preempted by higher priority |
| `SCHED_RR` | 1-99 | Round-robin with time quantum among equal-priority tasks |
| `SCHED_DEADLINE` | EDF parameters | Earliest-Deadline-First, guaranteed CPU budget |

### Setting RT Priority with chrt

```bash
# Run a process with SCHED_FIFO priority 50
sudo chrt -f 50 ./my-rt-application

# Change priority of existing process
sudo chrt -f -p 50 <PID>

# Run with SCHED_RR
sudo chrt -r 25 ./my-rt-application

# Check scheduling policy of a process
chrt -p <PID>
# pid 12345's current scheduling policy: SCHED_FIFO
# pid 12345's current scheduling priority: 50

# SCHED_DEADLINE example
# Budget: 1ms execution every 10ms period
sudo chrt --deadline --sched-runtime 1000000 --sched-period 10000000 ./rt-app
```

### Setting RT Priorities Programmatically in C

```c
#include <sched.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>

int set_realtime_priority(int policy, int priority) {
    struct sched_param sp;
    memset(&sp, 0, sizeof(sp));
    sp.sched_priority = priority;

    if (sched_setscheduler(0, policy, &sp) < 0) {
        perror("sched_setscheduler");
        return -1;
    }

    // Lock all current and future memory to prevent page faults
    if (mlockall(MCL_CURRENT | MCL_FUTURE) < 0) {
        perror("mlockall");
        return -1;
    }

    // Pre-fault the stack
    char stack_prefault[MAX_SAFE_STACK];
    memset(stack_prefault, 0, MAX_SAFE_STACK);

    printf("Scheduling policy set: policy=%d priority=%d\n", policy, priority);
    return 0;
}

int main(void) {
    // Validate RT priority range
    int max_pri = sched_get_priority_max(SCHED_FIFO);
    int min_pri = sched_get_priority_min(SCHED_FIFO);
    printf("SCHED_FIFO priority range: %d-%d\n", min_pri, max_pri);

    // Set SCHED_FIFO priority 80 (high priority, leaving headroom for watchdogs)
    return set_realtime_priority(SCHED_FIFO, 80);
}
```

### RT Limits via ulimit and PAM

```bash
# /etc/security/limits.d/99-realtime.conf
# Allow 'rtuser' group members to set RT priorities
@rtuser    -    rtprio     99
@rtuser    -    memlock    unlimited
@rtuser    -    nice       -20

# Add user to rtuser group
sudo groupadd rtuser
sudo usermod -aG rtuser myapp-user

# Verify (after re-login)
su - myapp-user -c "ulimit -r"
# 99
```

## Memory Locking: Preventing Page Faults in RT Tasks

Page faults introduce unpredictable latency. RT processes must lock their memory:

```c
#include <sys/mman.h>

// Lock all mapped memory
mlockall(MCL_CURRENT | MCL_FUTURE);

// Pre-allocate and touch all stack pages
void prefault_stack(size_t size) {
    volatile char stack[size];
    // Touch each page (4KB apart) to fault it in
    for (size_t i = 0; i < size; i += 4096) {
        stack[i] = 0;
    }
}

// Pre-allocate heap memory for RT path
// Allocate a large pool at startup, never malloc() in the RT loop
void *rt_buffer = malloc(64 * 1024 * 1024);  // 64MB pool
memset(rt_buffer, 0, 64 * 1024 * 1024);      // Fault all pages now
```

## Measuring Latency with cyclictest

`cyclictest` is the standard RT latency benchmark. It measures the time between when a timer fires and when the test thread actually wakes up — the scheduling latency.

### Installing cyclictest

```bash
# Ubuntu/Debian
sudo apt install rt-tests

# Build from source
git clone https://git.kernel.org/pub/scm/utils/rt-tests/rt-tests.git
cd rt-tests
make
sudo make install
```

### Running cyclictest

```bash
# Standard RT latency test
# -l1000000: 1M iterations
# -m: mlockall
# -S: SMP, test all CPUs
# -p90: SCHED_FIFO priority 90
# -i200: 200us interval
# -d0: duration 0 (run until count reached)
sudo cyclictest -l1000000 -m -S -p90 -i200 -d0

# Sample output:
# T: 0 (12345) P:90 I:200 C:1000000 Min:      5 Act:    8 Avg:    9 Max:     42
# T: 1 (12346) P:90 I:200 C:1000000 Min:      5 Act:    7 Avg:    8 Max:     38
# T: 2 (12347) P:90 I:200 C:1000000 Min:      5 Act:    8 Avg:    9 Max:     51
# (Min/Avg/Max latency in microseconds)

# Long-running stress test with hardware stress
sudo stress-ng --cpu 4 --io 2 --vm 1 --vm-bytes 512M &
sudo cyclictest -l10000000 -m -S -p90 -i200 -d0 -h400 | tee cyclictest-stress.txt

# Visualize latency histogram
python3 -c "
import sys
data = {}
for line in open('cyclictest-stress.txt'):
    if line.startswith('#'):
        continue
    parts = line.split()
    if len(parts) >= 2:
        latency = int(parts[0])
        count = int(parts[1])
        data[latency] = data.get(latency, 0) + count

total = sum(data.values())
cumulative = 0
print('Latency(us) Count     CumulativePct')
for lat in sorted(data.keys()):
    cumulative += data[lat]
    pct = cumulative * 100.0 / total
    print(f'{lat:10d} {data[lat]:8d}  {pct:.6f}%')
    if pct > 99.9999:
        break
"
```

### Targeted CPU Isolation Test

```bash
# Test only isolated CPUs (e.g., CPUs 2-7)
# Pin cyclictest threads to isolated CPUs
sudo cyclictest --smp \
    -a 2-7 \
    -p99 \
    -i100 \
    -l5000000 \
    -m \
    -q \
    --histfile=latency-isolated.hist

# Compare with non-isolated CPUs under load
sudo cyclictest --smp \
    -a 0-1 \
    -p99 \
    -i100 \
    -l5000000 \
    -m \
    --histfile=latency-housekeeping.hist
```

### Acceptable Latency Targets

| Use Case | Maximum Acceptable Latency |
|---|---|
| Audio/Video production | < 1ms |
| Industrial control (PLC replacement) | < 500us |
| Soft real-time (telco) | < 100us |
| Hard real-time (flight control) | < 50us |
| Trading (co-location) | < 10us |

## Tuning BIOS and Hardware for RT

Software tuning alone cannot achieve sub-100us latency without BIOS configuration:

```bash
# Check and disable CPU frequency scaling
# C-states introduce latency when CPU wakes from sleep
# Disable deep C-states
for state in /sys/devices/system/cpu/cpu*/cpuidle/state*/disable; do
    echo 1 > $state 2>/dev/null || true
done

# Force performance governor (prevents P-state transitions)
for CPU in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $CPU 2>/dev/null || true
done

# Disable NUMA balancing (causes page migrations = latency)
echo 0 > /proc/sys/kernel/numa_balancing

# Disable transparent huge pages (can cause latency on THP promotion)
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# Disable CPU vulnerability mitigations (if security allows)
# WARNING: Only for isolated/air-gapped RT systems
# Add to GRUB: mitigations=off
cat /sys/devices/system/cpu/vulnerabilities/spectre_v2

# Tune network stack for RT (if RT process involves networking)
sysctl -w net.core.busy_poll=50
sysctl -w net.core.busy_read=50

# Disable watchdog (fires on isolated CPUs, adds latency)
echo 0 > /proc/sys/kernel/watchdog
```

### BIOS Settings Checklist

```
# Items to configure in BIOS/UEFI:
[ ] CPU Power Management: Performance or Maximum
[ ] Intel Turbo Boost: Disabled (unpredictable frequency changes)
[ ] Enhanced Intel SpeedStep (EIST): Disabled
[ ] C-States: Disabled (or max C1 only)
[ ] Intel Hyper-Threading: Context-dependent (disable for tightest isolation)
[ ] NUMA Interleaving: Enabled (if workload is NUMA-aware)
[ ] Memory Frequency: Maximum rated speed
[ ] PCIe ASPM: Disabled
[ ] SMI (System Management Interrupts): Minimize (hardware-dependent)
```

## Identifying Latency Sources with ftrace

When cyclictest shows unexpected spikes, ftrace helps identify the cause:

```bash
# Enable function latency tracer
echo 0 > /sys/kernel/debug/tracing/tracing_on
echo latency_hist > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/options/latency-format

# Capture the worst latency event
echo 1 > /sys/kernel/debug/tracing/tracing_on
# Run your RT workload...
echo 0 > /sys/kernel/debug/tracing/tracing_on

cat /sys/kernel/debug/tracing/trace | head -100

# Use wakeup_rt tracer for RT wakeup latency
echo wakeup_rt > /sys/kernel/debug/tracing/current_tracer
echo 1 > /sys/kernel/debug/tracing/tracing_on
# ...
```

### Using osnoise tracer

```bash
# The osnoise tracer measures OS-induced noise on isolated CPUs
echo osnoise > /sys/kernel/debug/tracing/current_tracer

# Configure to monitor CPUs 2-7
echo 2-7 > /sys/kernel/debug/tracing/osnoise/cpus

# Set runtime and period (in microseconds)
echo 950000 > /sys/kernel/debug/tracing/osnoise/runtime_us
echo 1000000 > /sys/kernel/debug/tracing/osnoise/period_us

echo 1 > /sys/kernel/debug/tracing/tracing_on
sleep 10
echo 0 > /sys/kernel/debug/tracing/tracing_on

grep "osnoise" /sys/kernel/debug/tracing/trace_pipe | head -20
```

## Running RT Workloads in Containers

Kubernetes and containers can host RT workloads if properly configured:

### Pod Specification for RT Workloads

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: rt-workload
  namespace: production
  annotations:
    # Request RT scheduling capability
    cpu-manager-policy: static
spec:
  nodeSelector:
    node-role.kubernetes.io/rt-node: "true"
  containers:
    - name: rt-app
      image: yourorg/rt-application:latest
      resources:
        requests:
          cpu: "4"        # Exclusive CPUs via static CPU manager
          memory: "2Gi"
        limits:
          cpu: "4"
          memory: "2Gi"
      securityContext:
        capabilities:
          add:
            - SYS_NICE     # Allow setting RT priority
            - IPC_LOCK     # Allow mlockall
        runAsNonRoot: false  # RT apps typically need elevated caps
      env:
        - name: RT_PRIORITY
          value: "80"
        - name: SCHED_POLICY
          value: "FIFO"
```

### Kubernetes CPU Manager for RT

```bash
# Configure CPU manager policy to 'static' on RT nodes
# /var/lib/kubelet/config.yaml
cpuManagerPolicy: static
cpuManagerReconcilePeriod: 5s
reservedSystemCPUs: "0-1"  # Reserve CPUs for OS

# Restart kubelet
sudo systemctl restart kubelet

# Verify CPU manager state
kubectl get node <rt-node> -o jsonpath='{.status.allocatable.cpu}'
# Should show reduced CPU count due to reservation
```

## Systemd Service Configuration for RT Processes

```ini
# /etc/systemd/system/rt-application.service
[Unit]
Description=Real-Time Application
After=migrate-kthreads.service
Requires=migrate-kthreads.service

[Service]
Type=simple
User=rtapp
Group=rtuser
ExecStart=/opt/rt-app/bin/rt-application --cpu-affinity=2-7 --rt-priority=80
CPUAffinity=2-7
CPUSchedulingPolicy=fifo
CPUSchedulingPriority=80
LimitMEMLOCK=infinity
LimitRTPRIO=99
Nice=-20

# Restart on failure with backoff
Restart=on-failure
RestartSec=1s
StartLimitIntervalSec=60s
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
```

## Comprehensive Tuning Script

```bash
#!/bin/bash
# /usr/local/sbin/rt-tune.sh
# Apply all RT tuning settings at boot

set -euo pipefail

ISOLATED_CPUS="2-7"
HOUSEKEEPING_CPUS="0-1"
HOUSEKEEPING_MASK="3"

echo "=== Applying RT tuning ==="

# 1. CPU frequency scaling
echo "Setting performance governor..."
for GOV in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    echo performance > $GOV 2>/dev/null || true
done

# 2. Disable C-states on isolated CPUs
echo "Disabling deep C-states..."
for CPU in $(echo $ISOLATED_CPUS | tr '-' ' ' | xargs seq); do
    for STATE in /sys/devices/system/cpu/cpu${CPU}/cpuidle/state*/disable; do
        echo 1 > $STATE 2>/dev/null || true
    done
done

# 3. IRQ affinity
echo "Setting IRQ affinity..."
for IRQ_DIR in /proc/irq/*/; do
    IRQ=$(basename $IRQ_DIR)
    [ "$IRQ" = "0" ] || [ "$IRQ" = "2" ] && continue
    echo $HOUSEKEEPING_MASK > /proc/irq/$IRQ/smp_affinity 2>/dev/null || true
done

# 4. Kernel parameters
echo "Setting kernel parameters..."
sysctl -w kernel.numa_balancing=0
sysctl -w kernel.watchdog=0
sysctl -w kernel.nmi_watchdog=0
sysctl -w vm.stat_interval=120
sysctl -w vm.dirty_ratio=10
sysctl -w vm.dirty_background_ratio=5

# 5. Transparent huge pages
echo "Disabling THP..."
echo never > /sys/kernel/mm/transparent_hugepage/enabled
echo never > /sys/kernel/mm/transparent_hugepage/defrag

# 6. RCU callbacks off isolated CPUs
echo "Configuring RCU..."
echo $HOUSEKEEPING_CPUS > /sys/devices/system/cpu/rcu_nocbs 2>/dev/null || true
echo $HOUSEKEEPING_CPUS > /sys/devices/system/cpu/rcu_exp_nocbs 2>/dev/null || true

# 7. Workqueue threads
echo "Migrating workqueue threads..."
for WQ in /sys/bus/workqueue/devices/*/; do
    echo $HOUSEKEEPING_MASK > ${WQ}cpumask 2>/dev/null || true
done

echo "=== RT tuning complete ==="

# Verify isolation
echo "Isolated CPUs: $(cat /sys/devices/system/cpu/isolated)"
echo "nohz_full CPUs: $(cat /sys/devices/system/cpu/nohz_full)"
```

## Key Takeaways

Real-time Linux performance is achieved through layered, systematic configuration:

1. **PREEMPT_RT kernel**: The foundation. Without it, worst-case latency is unbounded. As of kernel 6.6, RT support is fully mainlined.

2. **CPU isolation is non-negotiable**: `isolcpus`, `nohz_full`, and `rcu_nocbs` together remove the scheduler tick, RCU callbacks, and general-purpose scheduling from RT CPUs.

3. **IRQ affinity prevents interruption**: Network cards, NVMe, and other peripherals generate thousands of interrupts per second. They must be confined to housekeeping CPUs.

4. **Memory locking eliminates page fault latency**: `mlockall(MCL_CURRENT | MCL_FUTURE)` and pre-faulting the stack are mandatory for any RT process.

5. **BIOS configuration matters as much as Linux**: Turbo Boost, C-states, and PCIe ASPM all introduce variable latency that no software tuning can compensate for.

6. **cyclictest is the truth**: Run it under realistic load for millions of iterations. A maximum latency of 100us under stress is a reasonable target for general RT workloads. Trading and control applications may require 10-50us.

7. **ftrace and osnoise reveal hidden noise**: When cyclictest shows unexpected spikes, these tools identify whether the source is kernel scheduling, SMIs, or device interrupts.
