---
title: "Linux Cgroups v2 CPU Controller: Bandwidth Throttling and Burst Configuration"
date: 2031-03-26T00:00:00-05:00
draft: false
tags: ["Linux", "Cgroups", "Kubernetes", "CPU", "Performance", "Resource Management", "NUMA"]
categories:
- Linux
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux cgroups v2 CPU controller configuration, covering cpu.max for bandwidth control, cpu.weight for shares-based scheduling, cpu.burst for latency spikes, cpuset for NUMA binding, Kubernetes static CPU manager policy, and CFS throttling troubleshooting."
more_link: "yes"
url: "/linux-cgroups-v2-cpu-controller-bandwidth-throttling/"
---

The Linux cgroups v2 CPU controller is the foundation of Kubernetes CPU resource management, yet most practitioners interact with it only through `resources.requests.cpu` and `resources.limits.cpu`. Understanding what these fields actually configure in the kernel — and where the performance edge cases hide — is essential for running latency-sensitive workloads reliably.

This guide covers the complete cgroups v2 CPU control surface: `cpu.max` for hard bandwidth throttling, `cpu.weight` for proportional shares, `cpu.burst` for absorbing transient spikes without throttling, the `cpuset` controller for NUMA topology binding, Kubernetes' static CPU manager policy for latency-critical pods, and the specific CFS throttling behaviors that cause mysterious P99 latency spikes in production.

<!--more-->

# Linux Cgroups v2 CPU Controller: Bandwidth Throttling and Burst Configuration

## Section 1: Cgroups v2 CPU Controller Architecture

### Unified Hierarchy

Cgroups v2 uses a unified hierarchy where all controllers operate on the same tree. Unlike cgroups v1's split hierarchy (separate trees for cpu, cpuset, memory), v2 provides atomic operations across all resource types:

```bash
# Verify cgroups v2 is active
mount | grep cgroup2
# cgroup2 on /sys/fs/cgroup type cgroup2 (rw,nosuid,nodev,noexec,relatime)

# View the cgroup hierarchy for a container
systemd-cgls -l
# Or directly:
ls /sys/fs/cgroup/

# Find the cgroup for a specific process
cat /proc/$(pgrep -f myservice)/cgroup
# 0::/system.slice/myservice.service

# View all enabled controllers
cat /sys/fs/cgroup/cgroup.controllers
# cpuset cpu io memory hugetlb pids rdma misc
```

### Understanding the CFS Scheduler

The Completely Fair Scheduler (CFS) operates on a period/quota model:

- **Period** (`cpu.max` second field): The scheduling period, typically 100ms (100000 microseconds). This is the window over which CPU time is measured.
- **Quota** (`cpu.max` first field): Microseconds of CPU time allowed per period. If a cgroup uses its quota before the period ends, it is throttled until the next period begins.

A limit of 1 CPU = 100000/100000 = 100ms quota per 100ms period.
A limit of 0.5 CPU = 50000/100000 = 50ms quota per 100ms period.

## Section 2: cpu.max — Hard Bandwidth Control

### Reading and Writing cpu.max

```bash
# View CPU quota for a systemd service
cat /sys/fs/cgroup/system.slice/myservice.service/cpu.max
# 200000 100000  (quota=200ms, period=100ms = 2 CPUs allowed)

# View for a Kubernetes pod (format: /kubepods/burstable/pod<pod-uid>/<container-id>/)
cat /sys/fs/cgroup/kubepods/burstable/pod$(kubectl get pod mypod \
  -o jsonpath='{.metadata.uid}')/*/cpu.max

# Direct cgroup manipulation (for testing and debugging)
# Set a cgroup to use 0.5 CPUs (50ms quota per 100ms period)
echo "50000 100000" > /sys/fs/cgroup/test-cgroup/cpu.max

# Set to 2 CPUs
echo "200000 100000" > /sys/fs/cgroup/test-cgroup/cpu.max

# Remove the limit (max = unlimited)
echo "max 100000" > /sys/fs/cgroup/test-cgroup/cpu.max
```

### Understanding Throttling Statistics

```bash
# Check throttling statistics for a cgroup
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/<container-id>/cpu.stat
# usage_usec 1234567890
# user_usec 987654321
# system_usec 246913569
# core_sched.force_idle_usec 0
# nr_periods 12345
# nr_throttled 2345
# throttled_usec 234567890
# nr_bursts 0
# burst_usec 0

# Calculate throttle rate
cat << 'EOF' > /tmp/throttle-check.sh
#!/bin/bash
CGROUP_PATH="${1:-/sys/fs/cgroup}"
PATTERN="${2:-kubepods}"

find "${CGROUP_PATH}" -path "*${PATTERN}*" -name "cpu.stat" | while read -r stat_file; do
  NR_PERIODS=$(awk '/^nr_periods/{print $2}' "${stat_file}")
  NR_THROTTLED=$(awk '/^nr_throttled/{print $2}' "${stat_file}")
  THROTTLED_USEC=$(awk '/^throttled_usec/{print $2}' "${stat_file}")

  if [[ "${NR_PERIODS}" -gt 0 ]]; then
    THROTTLE_PCT=$(echo "scale=2; ${NR_THROTTLED} * 100 / ${NR_PERIODS}" | bc)
    if (( $(echo "${THROTTLE_PCT} > 1.0" | bc -l) )); then
      echo "THROTTLED: ${stat_file}"
      echo "  Throttle rate: ${THROTTLE_PCT}%"
      echo "  Throttled time: ${THROTTLED_USEC}us"
    fi
  fi
done
EOF
chmod +x /tmp/throttle-check.sh
/tmp/throttle-check.sh
```

### Kubernetes cpu.max Mapping

In Kubernetes, `resources.limits.cpu` directly maps to `cpu.max`:

```yaml
# This pod spec:
resources:
  requests:
    cpu: "1"       # Used for scheduling and cpu.weight
  limits:
    cpu: "2"       # Maps to cpu.max = "200000 100000"
```

Translates to kernel-level:
```bash
# Limit: 2 CPUs = 200000us quota per 100000us period
cat /sys/fs/cgroup/kubepods/pod<uid>/<container>/cpu.max
# 200000 100000
```

### The Thundering Herd Problem with cpu.max

A subtle issue with short-period CFS scheduling: even if your average CPU usage is well below the limit, brief spikes can exhaust the per-period quota and trigger throttling that appears as P99/P99.9 latency spikes.

For example, a Go garbage collection pause or a JVM safepoint may use 100% CPU for 50ms. If the period is 100ms and the quota is 150ms (1.5 CPUs), that single GC event consumes 33% of the period quota instantly, potentially throttling the process for the rest of the period.

This is addressed by `cpu.burst` — covered in Section 4.

## Section 3: cpu.weight — Proportional Shares Scheduling

### Weight vs. Quota

`cpu.weight` controls relative CPU allocation when the system is CPU-constrained. Unlike `cpu.max` (hard limit), weight is only relevant when CPUs are oversubscribed:

- Default weight: 100
- Range: 1-10000
- Proportional: a cgroup with weight 200 gets 2x the CPU time of a cgroup with weight 100

```bash
# View current weight
cat /sys/fs/cgroup/kubepods/burstable/pod<uid>/cpu.weight
# 100

# Set higher weight for critical service
echo "400" > /sys/fs/cgroup/critical-service/cpu.weight

# Kubernetes mapping: requests.cpu maps to cpu.weight
# 1000m (1 CPU request) = weight 100 (approximately)
# Kubernetes uses: weight = max(2, min(10000, 1024 * requests_milli / 1000))
```

### How Kubernetes Maps cpu.requests to cpu.weight

```bash
# The conversion formula in the kubelet:
# cpu_weight = max(2, min(10000, floor(1024 * cpu_request_milliCPU / 1000)))

# Examples:
# 100m  -> floor(1024 * 100 / 1000)  = 102
# 250m  -> floor(1024 * 250 / 1000)  = 256
# 500m  -> floor(1024 * 500 / 1000)  = 512
# 1000m -> floor(1024 * 1000 / 1000) = 1024
# 2000m -> floor(1024 * 2000 / 1000) = 2048

# Verify with a running pod
POD="mypod"
CONTAINER="main"
POD_UID=$(kubectl get pod ${POD} -o jsonpath='{.metadata.uid}')
CPU_REQUEST=$(kubectl get pod ${POD} -o jsonpath='{.spec.containers[0].resources.requests.cpu}')

echo "Pod ${POD} cpu.request: ${CPU_REQUEST}"
CGROUP=$(find /sys/fs/cgroup/kubepods -path "*${POD_UID}*" -name "cpu.weight" 2>/dev/null | head -1)
echo "Actual cpu.weight: $(cat ${CGROUP})"
```

## Section 4: cpu.burst — Absorbing Transient Spikes

### What cpu.burst Solves

`cpu.burst` was added in kernel 5.14 to address the latency cliff caused by CFS throttling during brief CPU spikes. It allows a cgroup to "borrow" future quota, accumulating unused bandwidth from under-utilized periods and spending it during bursts.

Think of it as a token bucket: unused quota tokens accumulate (up to `cpu.burst`), and transient spikes can spend the accumulated tokens without being throttled.

```bash
# Check current burst configuration
cat /sys/fs/cgroup/mypod/cpu.burst
# 0  (disabled by default)

# Enable burst: allow accumulation of up to 100ms of burst credit
echo "100000" > /sys/fs/cgroup/mypod/cpu.burst

# Kubernetes does not yet expose cpu.burst in pod spec (as of 1.30)
# Must be set via kubelet configuration or admission webhook
```

### Configuring cpu.burst via Kubernetes

Since `cpu.burst` isn't in the pod spec, configure it through the kubelet or an admission webhook:

```go
// webhook/cpu-burst-injector.go
// Admission webhook that sets cpu.burst for annotated pods

package webhook

import (
    "context"
    "encoding/json"
    "fmt"
    "strconv"

    corev1 "k8s.io/api/core/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

const (
    CPUBurstAnnotation = "kubernetes.io/cpu-burst"
)

type CPUBurstInjector struct {
    client  client.Client
    decoder *admission.Decoder
}

func (i *CPUBurstInjector) Handle(ctx context.Context, req admission.Request) admission.Response {
    pod := &corev1.Pod{}
    if err := i.decoder.Decode(req, pod); err != nil {
        return admission.Errored(400, err)
    }

    // Check for burst annotation
    burstAnnotation, ok := pod.Annotations[CPUBurstAnnotation]
    if !ok {
        return admission.Allowed("no burst annotation")
    }

    burstMicros, err := strconv.ParseInt(burstAnnotation, 10, 64)
    if err != nil {
        return admission.Errored(400, fmt.Errorf("invalid burst value: %w", err))
    }

    // Inject init container that sets cpu.burst for the pod's cgroup
    // (runs as privileged to write to cgroup)
    initContainer := corev1.Container{
        Name:  "set-cpu-burst",
        Image: "busybox",
        Command: []string{
            "sh", "-c",
            fmt.Sprintf("echo %d > /sys/fs/cgroup/$(cat /proc/self/cgroup | head -1 | cut -d: -f3)/cpu.burst || true", burstMicros),
        },
        SecurityContext: &corev1.SecurityContext{
            Privileged: boolPtr(true),
        },
        VolumeMounts: []corev1.VolumeMount{
            {Name: "cgroupfs", MountPath: "/sys/fs/cgroup"},
        },
    }

    pod.Spec.InitContainers = append([]corev1.Container{initContainer}, pod.Spec.InitContainers...)

    // Add cgroup volume
    hostPathType := corev1.HostPathDirectory
    pod.Spec.Volumes = append(pod.Spec.Volumes, corev1.Volume{
        Name: "cgroupfs",
        VolumeSource: corev1.VolumeSource{
            HostPath: &corev1.HostPathVolumeSource{
                Path: "/sys/fs/cgroup",
                Type: &hostPathType,
            },
        },
    })

    marshaled, err := json.Marshal(pod)
    if err != nil {
        return admission.Errored(500, err)
    }

    return admission.PatchResponseFromRaw(req.Object.Raw, marshaled)
}

func boolPtr(b bool) *bool { return &b }
```

### When to Use cpu.burst

```yaml
# Example: Java application with GC pauses
# cpu.max = 2 CPUs (200000 100000)
# Without burst: GC pause that uses 4 CPUs for 30ms gets throttled after ~50ms

# With burst = 200000 (200ms accumulated budget):
# GC pause can use its accumulated budget to run at full speed
# No throttling for brief GC pauses

apiVersion: v1
kind: Pod
metadata:
  name: java-service
  annotations:
    kubernetes.io/cpu-burst: "200000"  # 200ms burst budget
spec:
  containers:
    - name: java
      image: myapp:latest
      resources:
        requests:
          cpu: "1"
        limits:
          cpu: "2"
```

## Section 5: cpuset Controller — NUMA Binding

### NUMA Topology and CPU Pinning

On multi-socket or high-core-count systems, NUMA (Non-Uniform Memory Access) topology matters significantly for latency-sensitive workloads. A process running on CPU 0 accessing memory from the remote NUMA node may see 2-3x higher memory latency than local node access.

```bash
# View NUMA topology
numactl --hardware
# available: 2 nodes (0-1)
# node 0 cpus: 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23
# node 0 size: 64396 MB
# node 0 free: 58932 MB
# node 1 cpus: 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31
# node 1 size: 64502 MB
# node 1 free: 61203 MB
# node distances:
# node   0   1
#   0:  10  21
#   1:  21  10

# View current cpuset for a process
cat /proc/$(pgrep myservice)/cpuset
cat /sys/fs/cgroup$(cat /proc/$(pgrep myservice)/cpuset)/cpuset.cpus
```

### Manual cpuset Configuration

```bash
# Create a dedicated cgroup with cpuset
mkdir /sys/fs/cgroup/latency-critical

# Enable cpuset controller for the cgroup
echo "+cpuset +cpu" > /sys/fs/cgroup/latency-critical/cgroup.subtree_control

# Assign CPUs 0-7 (NUMA node 0) to the cgroup
echo "0-7" > /sys/fs/cgroup/latency-critical/cpuset.cpus

# Restrict memory to NUMA node 0
echo "0" > /sys/fs/cgroup/latency-critical/cpuset.mems

# Move a process to this cgroup
echo $(pgrep myservice) > /sys/fs/cgroup/latency-critical/cgroup.procs

# Verify
cat /sys/fs/cgroup/latency-critical/cpuset.cpus
cat /proc/$(pgrep myservice)/status | grep -E "Cpus_allowed|Mems_allowed"
```

## Section 6: Kubernetes Static CPU Manager Policy

### CPU Manager Policies

Kubernetes kubelet offers three CPU manager policies:

1. **none** (default): CPUs are shared across all pods using CFS scheduling. No CPU pinning.
2. **static**: Guaranteed QoS pods with integer CPU requests get exclusive, pinned CPUs.
3. **distribute-cpus-across-numa** (topology manager): Pins CPUs considering NUMA topology.

### Enabling Static CPU Manager

```yaml
# /var/lib/kubelet/config.yaml
kind: KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
cpuManagerPolicy: static
cpuManagerPolicyOptions:
  # Align CPU allocation with NUMA topology
  full-pcpus-only: "true"
  distribute-cpus-across-numa: "true"
  align-by-socket: "true"
topologyManagerPolicy: best-effort
topologyManagerScope: pod
```

```bash
# Apply CPU manager policy
# NOTE: requires removing the CPU manager state file and restarting kubelet
systemctl stop kubelet
rm -f /var/lib/kubelet/cpu_manager_state
# Edit /var/lib/kubelet/config.yaml with above settings
systemctl start kubelet

# Verify CPU manager is active
kubectl get node mynode -o jsonpath='{.metadata.annotations}' | \
  jq 'with_entries(select(.key | startswith("kubelet")))'

# Check kubelet logs for CPU manager initialization
journalctl -u kubelet | grep -i "cpu manager" | tail -20
```

### Pods That Get CPU Pinning

Only **Guaranteed QoS** pods with **integer CPU requests** get exclusive CPUs:

```yaml
# This pod gets CPU pinning (Guaranteed QoS, integer CPU)
apiVersion: v1
kind: Pod
metadata:
  name: latency-critical-service
spec:
  containers:
    - name: service
      image: myservice:latest
      resources:
        requests:
          cpu: "4"       # Integer, not "4000m"
          memory: 8Gi
        limits:
          cpu: "4"       # requests == limits = Guaranteed QoS
          memory: 8Gi
```

```yaml
# This pod does NOT get CPU pinning (non-integer CPU)
spec:
  containers:
    - name: service
      resources:
        requests:
          cpu: "3500m"  # Non-integer = shared pool
        limits:
          cpu: "4000m"
```

### Verifying CPU Pinning

```bash
# After deploying a Guaranteed QoS pod with integer CPU:
POD="latency-critical-service"
POD_UID=$(kubectl get pod ${POD} -o jsonpath='{.metadata.uid}')

# Find the cgroup
CGROUP=$(find /sys/fs/cgroup/kubepods/guaranteed -path "*${POD_UID}*" \
  -name "cpuset.cpus" 2>/dev/null | head -1)

echo "Pinned CPUs: $(cat ${CGROUP})"
# Example output: Pinned CPUs: 4-7  (4 dedicated CPUs, no sharing)

# Verify from within the pod
kubectl exec ${POD} -- cat /proc/self/status | grep Cpus_allowed_list
# Should show a specific CPU set, not all CPUs
```

## Section 7: CFS Throttling Troubleshooting

### Diagnosing P99 Latency Spikes from CFS Throttling

CFS throttling is one of the most common causes of unexplained P99 latency spikes in containerized services. The symptoms are:
- Normal P50/P95 latency
- Periodic P99/P99.9 latency spikes at regular intervals (often correlating with the CFS period)
- `nr_throttled` counter increasing in `cpu.stat`

```bash
#!/bin/bash
# diagnose-cfs-throttling.sh
# Find and report CFS-throttled containers in a Kubernetes cluster

NODE="${1:-$(hostname)}"

echo "=== CFS Throttling Report for node ${NODE} ==="
echo ""

# Find all container cgroups
find /sys/fs/cgroup/kubepods -name "cpu.stat" 2>/dev/null | while read -r stat_file; do
  # Extract cgroup path components
  CGROUP_PATH=$(dirname "${stat_file}")

  # Get stats
  NR_PERIODS=$(awk '/^nr_periods/{print $2}' "${stat_file}")
  NR_THROTTLED=$(awk '/^nr_throttled/{print $2}' "${stat_file}")
  THROTTLED_USEC=$(awk '/^throttled_usec/{print $2}' "${stat_file}")

  # Skip if no data
  [[ "${NR_PERIODS}" -eq 0 ]] && continue

  THROTTLE_PCT=$(echo "scale=2; ${NR_THROTTLED} * 100 / ${NR_PERIODS}" | bc)

  # Only report if throttling is significant (>1%)
  if (( $(echo "${THROTTLE_PCT} > 1.0" | bc -l) )); then
    # Try to find container name from cgroup path
    POD_ID=$(echo "${CGROUP_PATH}" | grep -oP 'pod[a-f0-9-]+' || echo "unknown")
    CONTAINER_ID=$(echo "${CGROUP_PATH}" | grep -oP '[a-f0-9]{64}' || echo "unknown")

    # Look up pod name
    POD_NAME=$(kubectl get pods -A -o jsonpath=\
"{range .items[?(.metadata.uid==\"$(echo ${POD_ID} | sed 's/pod//')\")]}{.metadata.name}{end}" \
2>/dev/null || echo "${POD_ID}")

    CPU_MAX=$(cat "${CGROUP_PATH}/cpu.max" 2>/dev/null || echo "unknown")

    echo "THROTTLED: ${POD_NAME} / ${CONTAINER_ID:0:12}"
    echo "  Throttle rate: ${THROTTLE_PCT}%"
    echo "  Throttled time: ${THROTTLED_USEC}us"
    echo "  CPU limit (cpu.max): ${CPU_MAX}"
    echo "  Cgroup: ${CGROUP_PATH}"
    echo ""
  fi
done
```

### Prometheus Metrics for CFS Throttling

The kubelet exposes CFS throttling metrics:

```bash
# On the node, query kubelet metrics
curl -s http://localhost:10255/metrics | \
  grep container_cpu_cfs_throttled

# Key metrics:
# container_cpu_cfs_periods_total - total CFS periods
# container_cpu_cfs_throttled_periods_total - throttled periods
# container_cpu_cfs_throttled_seconds_total - total throttled time
```

```yaml
# Prometheus recording rules and alerts for CFS throttling
groups:
  - name: cfs.throttling
    rules:
      - record: container:cpu_throttle_ratio:rate5m
        expr: |
          rate(container_cpu_cfs_throttled_periods_total[5m])
          /
          rate(container_cpu_cfs_periods_total[5m])

      - alert: ContainerCPUThrottling
        expr: |
          container:cpu_throttle_ratio:rate5m > 0.25
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Container CPU throttling >25%"
          description: |
            Container {{ $labels.container }} in pod {{ $labels.pod }}
            is throttled {{ $value | humanizePercentage }} of the time.
            Consider increasing cpu.limit or enabling cpu.burst.

      - alert: ContainerCPUThrottlingCritical
        expr: |
          container:cpu_throttle_ratio:rate5m > 0.5
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Container CPU throttling >50% - latency impact"
          description: |
            Container {{ $labels.container }} in {{ $labels.namespace }}/{{ $labels.pod }}
            CPU throttle ratio: {{ $value | humanizePercentage }}.
            Current limit: check cpu.max in cgroup.
```

### Resolution Strategies for CFS Throttling

**Option 1: Increase CPU limit**

```yaml
# Increase limit to eliminate throttling
resources:
  requests:
    cpu: "1"
  limits:
    cpu: "4"  # Was 2, now 4
```

**Option 2: Enable cpu.burst for transient spikes**

```bash
# Set burst budget to absorb brief spikes
echo "200000" > /sys/fs/cgroup/pod<uid>/cpu.burst
```

**Option 3: Remove CPU limit (controversial)**

```yaml
# Remove limit entirely for Guaranteed scheduling without throttling
# (requests == limits is NOT required - just requests for Guaranteed without throttling risk)
resources:
  requests:
    cpu: "2"
  # No limits: pod can use any available CPU
  # Risk: a runaway pod can starve other pods on the node
```

**Option 4: Use a longer CFS period**

```bash
# Longer period reduces throttling frequency for bursty workloads
# Default: 100ms period
# Increase to 500ms: quota is measured over 5x longer window
# Trade-off: longer recovery time if throttled

# This must be done at the cgroup level (not via Kubernetes API)
# Write new period (500ms = 500000us) while keeping same CPU fraction
QUOTA=$(cat /sys/fs/cgroup/mypod/cpu.max | awk '{print $1}')
echo "${QUOTA} 500000" > /sys/fs/cgroup/mypod/cpu.max
```

## Section 8: eBPF-Based CPU Monitoring

### Using BCC Tools for CPU Throttle Analysis

```bash
# Install BCC tools
apt-get install -y bpfcc-tools linux-headers-$(uname -r)

# Monitor CPU throttling events in real time
# runqslower: report processes waiting more than Xms for CPU
/usr/sbin/runqslower-bpfcc 10  # Report tasks waiting >10ms for CPU

# cpuunclaimed: identify idle CPUs while processes wait
/usr/sbin/cpuunclaimed-bpfcc -T 5

# offcputime: show where processes spend time off-CPU
# Useful for identifying if CFS throttling is the root cause of latency
/usr/sbin/offcputime-bpfcc -K 10 > /tmp/offcpu.txt
# Then visualize:
/usr/share/bcc/tools/offcputime.py | \
  /usr/share/FlameGraph/flamegraph.pl --color=io > /tmp/offcpu.svg
```

### Custom eBPF Program for Throttle Detection

```c
// cfs_throttle_trace.c
// eBPF program to trace CFS throttle events and measure duration

#include <uapi/linux/ptrace.h>
#include <linux/sched.h>

struct throttle_event {
    u32 pid;
    char comm[TASK_COMM_LEN];
    u64 duration_ns;
};

BPF_PERF_OUTPUT(events);
BPF_HASH(start_time, u32);

// Trace when a task is throttled
TRACEPOINT_PROBE(sched, sched_stat_wait) {
    u32 pid = bpf_get_current_pid_tgid();
    u64 ts = bpf_ktime_get_ns();
    start_time.update(&pid, &ts);
    return 0;
}

// Trace when a task resumes after throttle
TRACEPOINT_PROBE(sched, sched_wakeup) {
    u32 pid = args->pid;
    u64 *start = start_time.lookup(&pid);
    if (!start) return 0;

    struct throttle_event event = {};
    event.pid = pid;
    event.duration_ns = bpf_ktime_get_ns() - *start;
    bpf_get_current_comm(&event.comm, sizeof(event.comm));

    events.perf_submit(args, &event, sizeof(event));
    start_time.delete(&pid);
    return 0;
}
```

## Section 9: Node-Level CPU Configuration

### Isolating CPUs for Kubernetes

For latency-critical workloads, use kernel `isolcpus` to remove CPUs from the general scheduler and dedicate them to specific processes:

```bash
# Add to kernel command line (GRUB configuration)
# Isolate CPUs 8-15 for latency-critical containers
GRUB_CMDLINE_LINUX_DEFAULT="... isolcpus=8-15 nohz_full=8-15 rcu_nocbs=8-15"

# Apply GRUB change
update-grub
reboot

# After reboot, verify isolation
cat /sys/devices/system/cpu/isolated
# 8-15

# Verify no kernel threads on isolated CPUs
ps -eo pid,psr,comm | awk '$2 >= 8 && $2 <= 15'
```

### Kubernetes Topology Manager Integration

```yaml
# kubelet config for NUMA-aware scheduling
kind: KubeletConfiguration
apiVersion: kubelet.config.k8s.io/v1beta1
topologyManagerPolicy: single-numa-node  # Strict NUMA alignment
topologyManagerScope: pod
cpuManagerPolicy: static
reservedSystemCPUs: "0-3"  # Reserve CPUs 0-3 for system/kubelet
```

## Section 10: Comprehensive Monitoring Setup

### Node Exporter CPU Metrics

```yaml
# prometheus-cpu-recording-rules.yaml
groups:
  - name: cpu.node
    rules:
      - record: node:cpu_utilization:rate5m
        expr: |
          1 - avg without(cpu,mode) (
            rate(node_cpu_seconds_total{mode="idle"}[5m])
          )

      - record: node:cpu_iowait:rate5m
        expr: |
          avg without(cpu) (
            rate(node_cpu_seconds_total{mode="iowait"}[5m])
          )

      - alert: NodeCPUSaturation
        expr: node:cpu_utilization:rate5m > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Node {{ $labels.instance }} CPU is saturated"
          description: "CPU utilization: {{ $value | humanizePercentage }}"

      - alert: NodeCPUStealHigh
        expr: |
          rate(node_cpu_seconds_total{mode="steal"}[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU steal on {{ $labels.instance }}"
          description: |
            CPU steal of {{ $value | humanizePercentage }} indicates
            hypervisor resource contention. Consider dedicated instances.
```

## Conclusion

The cgroups v2 CPU controller provides fine-grained control over CPU resource allocation, but the default configurations create predictable failure modes for latency-sensitive workloads. The key insights are: `cpu.max` throttles immediately when the period quota is exhausted regardless of current system load; `cpu.burst` absorbs transient spikes by accumulating unused quota; `cpu.weight` only matters under contention; and the static CPU manager policy eliminates shared-pool jitter for Guaranteed QoS pods at the cost of reduced bin-packing efficiency.

The most impactful change for P99 latency improvement in most production clusters is monitoring CFS throttle ratio via the `container_cpu_cfs_throttled_periods_total` metric and either increasing limits or enabling `cpu.burst` for pods showing >10% throttle rates.
