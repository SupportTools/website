---
title: "Linux Realtime Preemption: PREEMPT_RT Patch and Latency Tuning"
date: 2029-09-23T00:00:00-05:00
draft: false
tags: ["Linux", "Realtime", "PREEMPT_RT", "Kernel", "Latency", "Industrial", "Embedded"]
categories: ["Linux", "Systems Programming"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Linux realtime preemption: building the PREEMPT_RT kernel, benchmarking with cyclictest, identifying and eliminating latency sources, threading IRQs, isolating CPUs for RT tasks, and designing industrial control systems on Linux."
more_link: "yes"
url: "/linux-realtime-preemption-preempt-rt-latency-tuning/"
---

Standard Linux is a general-purpose OS that optimizes for throughput over worst-case latency. The PREEMPT_RT patch converts it into a real-time operating system by making virtually every in-kernel lock preemptible, converting hardware interrupts to kernel threads, and eliminating the non-preemptible regions that cause latency spikes. The result is a kernel that can deliver consistent sub-100-microsecond worst-case latency on commodity hardware — sufficient for motor controllers, CNC machines, audio systems, and financial trading engines. This post covers the complete PREEMPT_RT setup from kernel build through cyclictest benchmarking to production deployment.

<!--more-->

# Linux Realtime Preemption: PREEMPT_RT Patch and Latency Tuning

## Understanding Realtime Requirements

Before diving into PREEMPT_RT, clarify what "realtime" means for your use case. There are three distinct categories:

**Hard realtime**: Missing a deadline causes catastrophic failure (aircraft flight control, automotive brake-by-wire, medical infusion pumps). Typically requires formal certification (DO-178C, ISO 26262) and often dedicated RTOS hardware.

**Firm realtime**: Missing an occasional deadline degrades quality but is not catastrophic (audio processing, video encoding, industrial PLCs). PREEMPT_RT Linux is well suited here.

**Soft realtime**: Best effort with predictable average latency (trading systems, game engines, high-frequency data acquisition). Standard Linux with tuning is often adequate.

PREEMPT_RT targets firm realtime with typical worst-case latency of 20-100 µs on modern hardware, compared to 1-10 ms for standard Linux.

## PREEMPT_RT Status in Mainline Linux

As of kernel 6.12, most PREEMPT_RT patches are merged into mainline Linux. You may not need to apply the out-of-tree patch at all for recent kernels:

```bash
# Check if your distribution kernel has PREEMPT_RT
uname -r
grep -E "PREEMPT_RT|PREEMPT_DYNAMIC" /boot/config-$(uname -r)

# On Ubuntu 24.04+, install the RT kernel directly
sudo apt-get install linux-realtime linux-headers-realtime
sudo reboot

# Verify RT kernel
uname -v | grep -i "PREEMPT_RT"
cat /sys/kernel/realtime  # should output "1" on RT kernel
```

## Building a PREEMPT_RT Kernel from Source

For kernels where you need the out-of-tree RT patch:

```bash
# Download kernel source and RT patch
KERNEL_VERSION="6.6.60"
RT_PATCH_VERSION="6.6.60-rt45"

wget https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz
wget https://cdn.kernel.org/pub/linux/kernel/projects/rt/6.6/patch-${RT_PATCH_VERSION}.patch.xz

# Extract and apply patch
tar xf linux-${KERNEL_VERSION}.tar.xz
cd linux-${KERNEL_VERSION}
xzcat ../patch-${RT_PATCH_VERSION}.patch.xz | patch -p1

# Start with your distro's config
cp /boot/config-$(uname -r) .config
make olddefconfig

# Configure PREEMPT_RT
make menuconfig
# Navigate to: General Setup -> Preemption Model
# Select: Fully Preemptible Kernel (Real-Time)
```

### Key Kernel Configuration Options

```bash
# Essential RT options
CONFIG_PREEMPT_RT=y           # Full preemption model
CONFIG_HZ_1000=y              # 1000Hz timer for finer scheduling granularity
CONFIG_HZ=1000

# Disable options that interfere with RT latency
CONFIG_CPU_FREQ_DEFAULT_GOV_ONDEMAND=n  # disable CPU frequency scaling governor
CONFIG_CPU_FREQ_DEFAULT_GOV_PERFORMANCE=y
CONFIG_INTEL_IDLE=n            # disable Intel idle driver (can cause latency spikes)
CONFIG_CPU_IDLE=n              # disable CPU idle states during RT operation

# NUMA and memory
CONFIG_NUMA_BALANCING=n        # disable automatic NUMA memory balancing

# Power management
CONFIG_PM_AUTOSLEEP=n
CONFIG_PM_WAKELOCKS=n

# Debugging (disable in production)
CONFIG_DEBUG_PREEMPT=n
CONFIG_LATENCYTOP=n           # adds overhead
CONFIG_PROVE_LOCKING=n        # adds significant overhead
CONFIG_LOCK_STAT=n

# IRQ threading
CONFIG_IRQ_FORCED_THREADING=y  # make all IRQ handlers threaded
```

```bash
# Build and install
make -j$(nproc) bzImage modules
sudo make modules_install
sudo make install

# Update bootloader
sudo update-grub
```

### Boot Parameters for RT

```bash
# /etc/default/grub — add to GRUB_CMDLINE_LINUX
GRUB_CMDLINE_LINUX="
  isolcpus=2,3               # isolate CPUs 2 and 3 for RT tasks
  nohz_full=2,3              # disable tick on isolated CPUs
  rcu_nocbs=2,3              # offload RCU callbacks from isolated CPUs
  irqaffinity=0,1            # restrict IRQs to non-isolated CPUs
  processor.max_cstate=1     # prevent deep CPU C-states
  idle=poll                  # polling idle (lowest latency, highest power)
  nosoftlockup               # disable softlockup detector
  nmi_watchdog=0             # disable NMI watchdog
  intel_pstate=disable       # use acpi-cpufreq instead of intel_pstate
  quiet                      # reduce boot verbosity
"
```

## cyclictest: Benchmarking RT Latency

`cyclictest` is the standard tool for measuring realtime latency. It sends periodic timer signals and measures the difference between expected and actual wakeup times.

```bash
# Install rt-tests (includes cyclictest)
sudo apt-get install rt-tests
# or build from source:
git clone https://git.kernel.org/pub/scm/linux/kernel/git/clrkwllms/rt-tests.git
cd rt-tests && make && sudo make install
```

### Basic Latency Measurement

```bash
# Run cyclictest for 60 seconds with highest RT priority
# -m: lock memory (mlockall)
# -p99: SCHED_FIFO priority 99
# -i500: 500 µs interval between wakeups
# -h200: histogram with 200 µs range
# -n: use nanosleep for timing
sudo cyclictest \
  --mlockall \
  --smp \
  --priority=99 \
  --interval=500 \
  --distance=0 \
  --loops=200000 \
  --histogram=200 \
  --histfile=latency-histogram.txt

# Typical output:
# T: 0 (12345) P:99 I:500 C:200000 Min:     5 Act:    8 Avg:    7 Max:      23
# T: 1 (12346) P:99 I:500 C:200000 Min:     6 Act:    9 Avg:    7 Max:      31
#
# Min/Avg/Max are in microseconds
# On PREEMPT_RT: Max typically < 100 µs
# On standard kernel: Max can exceed 1000 µs
```

### Generating a Latency Histogram

```bash
#!/bin/bash
# run-cyclictest.sh — comprehensive latency measurement with load

# Apply background load to stress-test RT isolation
stress-ng --cpu $(nproc) --vm 2 --vm-bytes 1G --io 4 &
STRESS_PID=$!

# Run cyclictest on isolated CPUs
sudo taskset -c 2,3 cyclictest \
  --mlockall \
  --smp \
  --affinity=2,3 \
  --priority=99 \
  --interval=200 \
  --distance=0 \
  --loops=1000000 \
  --histogram=400 \
  --histfile=/tmp/latency.hist \
  --quiet

kill $STRESS_PID

# Generate histogram plot with gnuplot
gnuplot << 'EOF'
set terminal png size 1200,600
set output '/tmp/latency-histogram.png'
set title "RT Latency Histogram"
set xlabel "Latency (µs)"
set ylabel "Count (log scale)"
set logscale y
set xrange [0:200]
set grid
set style fill solid
plot '/tmp/latency.hist' using 1:2 with boxes title 'CPU 2', \
     '/tmp/latency.hist' using 1:3 with boxes title 'CPU 3'
EOF

echo "Histogram saved to /tmp/latency-histogram.png"
```

### Interpreting cyclictest Results

```
Standard Kernel (untuned):
  Min: 4 µs    Avg: 15 µs    Max: 4382 µs

Standard Kernel (tuned):
  Min: 4 µs    Avg: 8 µs     Max: 890 µs

PREEMPT_RT (untuned):
  Min: 4 µs    Avg: 7 µs     Max: 132 µs

PREEMPT_RT (fully tuned + isolated CPUs):
  Min: 4 µs    Avg: 6 µs     Max: 23 µs
```

## Latency Sources and Remediation

### 1. CPU Frequency Scaling

P-states (CPU frequency scaling) cause latency when the CPU changes frequency during a critical section.

```bash
# Disable CPU frequency scaling for RT CPUs
for cpu in 2 3; do
    echo "performance" > /sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor
    # Or disable scaling entirely:
    echo 1 > /sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_max_freq
done

# Verify governor is applied
cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_governor
# Should print: performance

# For Intel systems: disable P-states entirely
# (requires intel_pstate=disable boot parameter, then use acpi-cpufreq)
cpupower frequency-set -g performance
```

### 2. CPU C-states (Deep Sleep)

Deep CPU C-states (C3, C6, C7) have wake-up latencies from 50 µs to over 1 ms.

```bash
# Disable deep C-states for RT CPUs
# Option 1: Use cpuidle driver
for cpu in 2 3; do
    # Disable C-states deeper than C1
    for state in /sys/devices/system/cpu/cpu${cpu}/cpuidle/state*/; do
        depth=$(cat ${state}/desc | grep -oP '\d+')
        if [ "${depth:-0}" -gt 1 ]; then
            echo 1 > ${state}/disable
        fi
    done
done

# Option 2: Use idle=poll boot parameter (no sleep at all)
# Boot with: idle=poll

# Option 3: Use cpu_dma_latency QoS (most portable)
# Write 0 to /dev/cpu_dma_latency to request C0/C1 only
cat > /sys/power/pm_qos_latency_tolerance << 'EOF'
0
EOF
```

```c
// latency_target.c — request low-latency power state from userspace
#include <stdio.h>
#include <fcntl.h>
#include <stdint.h>
#include <unistd.h>

int main(void) {
    int fd = open("/dev/cpu_dma_latency", O_RDWR);
    if (fd < 0) { perror("open cpu_dma_latency"); return 1; }

    // Request 0 µs latency tolerance
    // This prevents C-states deeper than C1
    int32_t latency = 0;
    write(fd, &latency, sizeof(latency));

    // Keep fd open to maintain the QoS request
    printf("PM QoS latency target: 0 µs\n");
    printf("Press Enter to release...\n");
    getchar();

    close(fd);
    return 0;
}
```

### 3. Memory Management: TLB Flushes and Page Faults

Page faults during RT task execution cause unpredictable latency. The solution is to pre-fault all memory and lock it.

```c
// rt_memory.c — proper memory management for RT tasks
#include <sys/mman.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

#define STACK_SIZE  (64 * 1024)   // 64 KB stack for RT task
#define HEAP_SIZE   (1024 * 1024) // 1 MB pre-allocated heap

// rt_init_memory must be called before RT task starts
int rt_init_memory(void) {
    // Lock all current and future memory pages
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        perror("mlockall");
        return -1;
    }

    // Pre-fault the stack by touching every page
    // Allocate stack with explicit pre-fault
    char stack[STACK_SIZE];
    memset(stack, 0, sizeof(stack));

    // Pre-fault heap
    void *heap = malloc(HEAP_SIZE);
    if (!heap) return -1;
    memset(heap, 0, HEAP_SIZE);
    free(heap);

    return 0;
}

// Example RT thread with proper setup
#include <pthread.h>
#include <sched.h>

void *rt_thread(void *arg) {
    // Pre-fault this thread's stack
    char stack_touch[STACK_SIZE];
    memset(stack_touch, 0, sizeof(stack_touch));

    // Set up period and deadline
    struct timespec period = {0, 1000000}; // 1 ms period
    struct timespec next_activation;
    clock_gettime(CLOCK_MONOTONIC, &next_activation);

    while (1) {
        // Add one period to next activation time
        next_activation.tv_nsec += period.tv_nsec;
        if (next_activation.tv_nsec >= 1000000000L) {
            next_activation.tv_nsec -= 1000000000L;
            next_activation.tv_sec++;
        }

        // Sleep until next activation
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next_activation, NULL);

        // Perform RT work here
        do_realtime_work();
    }
    return NULL;
}

int start_rt_thread(void) {
    pthread_t thread;
    pthread_attr_t attr;
    struct sched_param param;

    pthread_attr_init(&attr);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    pthread_attr_setschedpolicy(&attr, SCHED_FIFO);

    param.sched_priority = 90;
    pthread_attr_setschedparam(&attr, &param);

    // Set stack size and pre-allocate
    pthread_attr_setstacksize(&attr, STACK_SIZE);

    return pthread_create(&thread, &attr, rt_thread, NULL);
}
```

### 4. IRQ Threading

PREEMPT_RT converts hardware IRQ handlers to threaded handlers, making them preemptible. You can set the priority of IRQ threads to below your RT application.

```bash
# List all threaded IRQ handlers
ps -eo pid,comm,cls,rtprio | grep -E "irq/|ksoftirqd" | sort -k4 -n

# Set IRQ thread priorities
# Find the PID of the IRQ thread for a specific IRQ
IRQ_NUMBER=18  # example: network card IRQ
IRQ_PID=$(cat /proc/interrupts | grep -m1 "${IRQ_NUMBER}:" | awk '{print $NF}' | \
          xargs -I{} grep -r "{}$" /proc/*/comm 2>/dev/null | head -1 | \
          cut -d/ -f3)

# Set to SCHED_FIFO with priority 50 (below RT app at 90, above normal tasks)
chrt --fifo --pid 50 ${IRQ_PID}

# More systematic: set all IRQ threads to priority 50
for pid in $(ps -eo pid,comm | grep "irq/" | awk '{print $1}'); do
    chrt --fifo --pid 50 $pid 2>/dev/null
done

# Set softirq threads (ksoftirqd) to priority 20
for pid in $(ps -eo pid,comm | grep "ksoftirqd" | awk '{print $1}'); do
    chrt --fifo --pid 20 $pid 2>/dev/null
done
```

### 5. NUMA Effects

On multi-socket systems, memory accesses to remote NUMA nodes add latency.

```bash
# Check NUMA topology
numactl --hardware

# Pin RT task to a specific NUMA node (both CPU and memory)
numactl --cpubind=1 --membind=1 ./my-rt-application

# In code: use NUMA-aware allocation
# libnuma: numa_alloc_onnode(), numa_run_on_node()
```

### 6. Network Card and Storage IRQs

Even with CPU isolation, IRQs on isolated CPUs degrade RT performance. Force all IRQs to non-isolated CPUs.

```bash
# Set IRQ affinity for all IRQs to CPUs 0 and 1 (not RT CPUs 2 and 3)
# CPU affinity mask: 0x3 = binary 0011 = CPUs 0 and 1
for irq_file in /proc/irq/*/smp_affinity; do
    echo 3 > $irq_file 2>/dev/null  # 3 = binary 11 = CPUs 0+1
done

# For a specific device (e.g., eth0 with IRQs 23-26)
for irq in 23 24 25 26; do
    echo 3 > /proc/irq/${irq}/smp_affinity
done

# Verify
cat /proc/irq/23/smp_affinity_list  # should show "0-1"
```

## CPU Isolation for RT Tasks

CPU isolation prevents the Linux scheduler from running any tasks on specified CPUs, reserving them exclusively for RT processes.

```bash
# /etc/default/grub boot parameter (set during installation)
isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3

# After boot, verify isolated CPUs
cat /sys/devices/system/cpu/isolated  # should show "2-3"
cat /sys/devices/system/cpu/nohz_full # should show "2-3"

# Launch RT task on isolated CPU
taskset -c 2 ./my-rt-application

# Or in code:
#include <sched.h>
cpu_set_t cpus;
CPU_ZERO(&cpus);
CPU_SET(2, &cpus);
sched_setaffinity(0, sizeof(cpus), &cpus);
```

```bash
# Verify isolation is working: no other processes should be on CPUs 2-3
ps -eo pid,psr,comm | awk '$2==2 || $2==3 {print}'
# Should show only your RT process and kthread/0 (kernel idle thread)
```

## Complete RT Application Framework

```c
// rt_framework.h — reusable RT task framework
#pragma once

#include <stdint.h>
#include <time.h>
#include <pthread.h>

typedef struct rt_task_config {
    int         cpu;           // CPU to run on (isolcpus)
    int         priority;      // SCHED_FIFO priority (1-99)
    uint64_t    period_ns;     // task period in nanoseconds
    uint64_t    deadline_ns;   // deadline relative to period start
    size_t      stack_size;    // stack size (pre-faulted)
    void       *(*task_fn)(void *); // task function
    void       *arg;           // task argument
} rt_task_config_t;

typedef struct rt_task_stats {
    uint64_t iterations;
    uint64_t deadline_misses;
    int64_t  min_jitter_ns;
    int64_t  max_jitter_ns;
    int64_t  sum_jitter_ns;
} rt_task_stats_t;

int  rt_init(void);        // call once, before creating RT tasks
int  rt_task_create(const rt_task_config_t *cfg, pthread_t *thread);
void rt_task_wait_period(struct timespec *next, uint64_t period_ns,
                          rt_task_stats_t *stats);
```

```c
// rt_framework.c
#include "rt_framework.h"
#include <sys/mman.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

int rt_init(void) {
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        perror("mlockall");
        return -1;
    }

    // Pre-fault a large stack
    char touch[1024 * 1024];
    memset(touch, 0, sizeof(touch));
    return 0;
}

void rt_task_wait_period(struct timespec *next, uint64_t period_ns,
                          rt_task_stats_t *stats) {
    // Record expected wakeup time
    struct timespec expected = *next;

    // Sleep until next period
    clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, next, NULL);

    // Measure actual wakeup time for jitter tracking
    struct timespec actual;
    clock_gettime(CLOCK_MONOTONIC, &actual);

    int64_t jitter_ns =
        (actual.tv_sec - expected.tv_sec) * 1000000000LL +
        (actual.tv_nsec - expected.tv_nsec);

    stats->iterations++;
    stats->sum_jitter_ns += jitter_ns;
    if (jitter_ns < stats->min_jitter_ns) stats->min_jitter_ns = jitter_ns;
    if (jitter_ns > stats->max_jitter_ns) stats->max_jitter_ns = jitter_ns;

    // Advance next activation time
    next->tv_nsec += period_ns;
    while (next->tv_nsec >= 1000000000LL) {
        next->tv_nsec -= 1000000000LL;
        next->tv_sec++;
    }
}

// Example: 1 kHz motor control task
typedef struct motor_state {
    float position;
    float velocity;
    float setpoint;
    rt_task_stats_t stats;
} motor_state_t;

void *motor_control_task(void *arg) {
    motor_state_t *state = arg;

    // Pre-fault this thread's stack
    char stk[128 * 1024];
    memset(stk, 0, sizeof(stk));

    // Get initial time reference
    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);

    while (1) {
        // Wait for next 1ms period
        rt_task_wait_period(&next, 1000000ULL, &state->stats);

        // PID control loop (1 kHz)
        float error = state->setpoint - state->position;
        float kp = 1.0f, ki = 0.1f, kd = 0.01f;

        static float integral = 0, prev_error = 0;
        integral += error * 0.001f;        // integrate at 1ms
        float derivative = (error - prev_error) / 0.001f;
        prev_error = error;

        float output = kp * error + ki * integral + kd * derivative;
        apply_motor_output(output);
        read_encoder(&state->position, &state->velocity);

        // Check for deadline miss (jitter > 500 µs = task is late)
        if (state->stats.max_jitter_ns > 500000) {
            state->stats.deadline_misses++;
        }
    }
    return NULL;
}
```

## Industrial Control Use Case: Motion Controller

```c
// motion_controller.c — example 4-axis CNC motion controller
#include <math.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>

#define NUM_AXES     4
#define SERVO_PERIOD_NS  (1000000ULL)  // 1ms servo period = 1kHz

typedef struct axis_state {
    int64_t  commanded_pos;  // in encoder counts
    int64_t  actual_pos;
    int32_t  velocity;       // counts/sec
    int32_t  following_error;
    uint8_t  enabled;
    uint8_t  fault;
} axis_state_t;

typedef struct motion_controller {
    axis_state_t axes[NUM_AXES];
    int64_t      cycle_count;
    int64_t      max_jitter_ns;
    pthread_t    servo_thread;
} motion_controller_t;

static motion_controller_t mc;

// Servo interrupt simulation — called every 1ms
static void servo_cycle(void) {
    for (int i = 0; i < NUM_AXES; i++) {
        axis_state_t *ax = &mc.axes[i];
        if (!ax->enabled) continue;

        // Read encoder position (hardware I/O)
        ax->actual_pos = read_encoder_hw(i);

        // Calculate following error
        ax->following_error = (int32_t)(ax->commanded_pos - ax->actual_pos);

        // Fault on excessive following error (> 1000 counts)
        if (abs(ax->following_error) > 1000) {
            ax->fault = 1;
            ax->enabled = 0;
            printf("FAULT: axis %d following error %d\n",
                   i, ax->following_error);
            continue;
        }

        // PD control to drive actual to commanded
        float kp = 0.5f, kd = 0.01f;
        static int32_t prev_error[NUM_AXES] = {0};
        float d_error = (ax->following_error - prev_error[i]) / 0.001f;
        float output = kp * ax->following_error + kd * d_error;
        prev_error[i] = ax->following_error;

        write_dac_hw(i, (int16_t)output);  // -32768 to 32767
    }
    mc.cycle_count++;
}

static void *servo_thread_fn(void *arg) {
    (void)arg;

    // Pre-fault stack
    char stk[256 * 1024];
    memset(stk, 0, sizeof(stk));

    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);

    while (1) {
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);

        struct timespec actual;
        clock_gettime(CLOCK_MONOTONIC, &actual);
        int64_t jitter = (actual.tv_nsec - next.tv_nsec) +
                         (actual.tv_sec - next.tv_sec) * 1000000000LL;
        if (jitter > mc.max_jitter_ns) mc.max_jitter_ns = jitter;

        servo_cycle();

        // Advance period
        next.tv_nsec += SERVO_PERIOD_NS;
        if (next.tv_nsec >= 1000000000LL) {
            next.tv_nsec -= 1000000000LL;
            next.tv_sec++;
        }
    }
    return NULL;
}

int start_motion_controller(void) {
    // Initialize memory
    mlockall(MCL_CURRENT | MCL_FUTURE);
    memset(&mc, 0, sizeof(mc));

    // Create servo thread with SCHED_FIFO priority 90
    pthread_attr_t attr;
    struct sched_param param = {.sched_priority = 90};
    pthread_attr_init(&attr);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    pthread_attr_setschedpolicy(&attr, SCHED_FIFO);
    pthread_attr_setschedparam(&attr, &param);
    pthread_attr_setstacksize(&attr, 256 * 1024);

    int ret = pthread_create(&mc.servo_thread, &attr, servo_thread_fn, NULL);
    pthread_attr_destroy(&attr);

    if (ret == 0) {
        printf("Motion controller started (1kHz servo loop)\n");
    }
    return ret;
}
```

## Summary

PREEMPT_RT transforms Linux from a throughput-optimized OS into a deterministic, firm realtime system:

- **Kernel compilation**: Enable `CONFIG_PREEMPT_RT`, set `HZ=1000`, and disable drivers that introduce non-preemptible regions. For kernel 6.12+, check if PREEMPT_RT is already available in your distribution.
- **cyclictest** is the definitive latency measurement tool. Measure under load (stress-ng) to find worst-case latency, not best-case.
- **Latency sources** to eliminate: CPU frequency scaling (use performance governor), deep C-states (limit to C1 or use idle=poll), page faults (mlockall before RT work), IRQ storms on RT CPUs (isolcpus + irqaffinity).
- **CPU isolation** (`isolcpus`, `nohz_full`, `rcu_nocbs`) is the most impactful single change — it removes scheduler, RCU, and timer interruptions from RT CPU cores.
- **Application design**: Use `SCHED_FIFO` with appropriate priority, pre-fault all memory with `memset`, and use `clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, ...)` for period timing to avoid accumulated drift.
- **Achievable latency**: A fully tuned PREEMPT_RT system on modern server hardware delivers consistent worst-case wakeup jitter under 50 µs, suitable for 1 kHz or faster servo control loops.
