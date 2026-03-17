---
title: "Linux OOM Killer Tuning: Memory Management for Kubernetes Nodes"
date: 2030-06-01T00:00:00-05:00
draft: false
tags: ["Linux", "OOM Killer", "Kubernetes", "Memory Management", "Performance", "Kernel", "Nodes"]
categories:
- Linux
- Kubernetes
- Performance
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Linux OOM killer behavior: oom_score_adj, memory overcommit settings, cgroup OOM events, per-pod OOM protection, and tuning memory pressure handling for production Kubernetes nodes."
more_link: "yes"
url: "/linux-oom-killer-tuning-kubernetes-node-memory-management/"
---

The Linux Out-of-Memory (OOM) killer is a last-resort mechanism that terminates processes when the kernel cannot satisfy a memory allocation request. In Kubernetes environments, the OOM killer directly influences which pods survive memory pressure events, making its configuration critical for production reliability. A poorly configured system kills infrastructure-critical processes (kubelet, systemd) instead of dispensable application containers—with predictable results.

This guide covers OOM killer mechanics from the kernel scoring algorithm through Kubernetes-specific tuning: oom_score_adj values, memory overcommit policies, cgroup OOM events, per-pod protection, and monitoring memory pressure before it triggers the OOM killer.

<!--more-->

## OOM Killer Mechanics

### When the OOM Killer Activates

The kernel considers OOM killing when a memory allocation fails after:
1. Reclaiming page cache (clean pages backing files)
2. Swapping anonymous pages (if swap is configured)
3. Dropping slab caches (dentry, inode caches)
4. Compacting memory to satisfy high-order allocations

Only when all reclaim paths are exhausted does the kernel invoke the OOM killer.

```bash
# Check OOM events in kernel log
dmesg -T | grep -i "oom\|killed\|out of memory"
# [2030-06-01 14:23:15] Out of memory: Kill process 12345 (java) score 847 or sacrifice child
# [2030-06-01 14:23:15] Killed process 12345 (java) total-vm:4194304kB, anon-rss:3145728kB, file-rss:0kB, shmem-rss:0kB

# Monitor OOM events in real time
journalctl -k -f | grep -i oom

# Check per-cgroup OOM events (v2)
cat /sys/fs/cgroup/kubepods.slice/pod-abc123.slice/container-def456.scope/memory.events
# low 0
# high 0
# max 0
# oom 1        -- OOM kill was invoked
# oom_kill 1   -- A process was killed
```

### OOM Score Calculation

The kernel assigns each process an OOM score (0-1000) based on memory usage relative to total system memory, then adds `oom_score_adj` to produce the final score. Higher scores are killed first.

```bash
# View OOM scores for all processes
for pid in /proc/[0-9]*; do
    [[ -f "$pid/oom_score" ]] || continue
    score=$(cat "$pid/oom_score")
    adj=$(cat "$pid/oom_score_adj")
    name=$(cat "$pid/comm" 2>/dev/null)
    printf "%5d %5d %5d %s\n" "${pid#/proc/}" "$score" "$adj" "$name"
done | sort -n -k2 -r | head -30

# Output columns: PID  OOM_SCORE  OOM_SCORE_ADJ  NAME
# 12345   847    0     java
# 23456   412    0     python3
# 34567   200  -900    kubelet
```

The raw OOM score calculation (approximate):

```
score = (process_rss_pages / total_memory_pages) * 1000 + oom_score_adj
```

For a process using 3GB on a 32GB node:
- `score = (3*1024*1024 / 32*1024*1024) * 1000 = 93.75`
- With `oom_score_adj=500`: final score = 593

### oom_score_adj Values

`oom_score_adj` ranges from -1000 to +1000:
- `-1000`: Process is completely immune to OOM killing
- `-900` to `-500`: High protection (systemd daemons, critical services)
- `0`: Default (pure memory-based score)
- `+500` to `+1000`: Highly likely to be killed first

```bash
# View current oom_score_adj for a process
cat /proc/12345/oom_score_adj
# 0

# View both score and adj
cat /proc/12345/oom_score      # Current effective score (includes adj)
cat /proc/12345/oom_score_adj  # Adjustment value only

# Set oom_score_adj for a process (requires root)
echo -500 > /proc/12345/oom_score_adj

# Protect a process from OOM killing entirely
echo -1000 > /proc/12345/oom_score_adj

# Make a process the first target for OOM kill
echo 1000 > /proc/12345/oom_score_adj
```

## Kubernetes OOM Score Configuration

### Kubernetes QoS Class and OOM Score Mapping

Kubernetes sets `oom_score_adj` based on pod QoS class:

| QoS Class | oom_score_adj | Rationale |
|-----------|---------------|-----------|
| Guaranteed | -998 | Protected — should survive memory pressure |
| Burstable | 2 to 999 | Scaled by memory limit; lower limit = higher adj |
| BestEffort | 1000 | First to be killed (no requests or limits) |

For Burstable pods, the adjustment is calculated as:
```
oom_score_adj = 1000 - (10 * memory_limit_MB / total_memory_MB)
```

A 512Mi limit pod on a 32Gi node:
```
1000 - (10 * 512 / 32768) = 1000 - 1.56 = 998
```

A 16Gi limit pod on a 32Gi node:
```
1000 - (10 * 16384 / 32768) = 1000 - 50 = 950
```

```bash
# Verify OOM score for a running pod
POD_NAME="app-backend-6d9f7b4c8-xk2lp"
NAMESPACE="production"

# Find the container's main process PID
CONTAINER_PID=$(kubectl exec -n $NAMESPACE $POD_NAME -- \
    cat /proc/1/status | grep "^Pid:" | awk '{print $2}')

# Get the host PID (container PID 1 maps to a host PID)
HOST_PID=$(cat /proc/$(pgrep -f "containerd-shim.*${NAMESPACE}/${POD_NAME}" | head -1)/status \
    | grep "^Pid:" | awk '{print $2}' 2>/dev/null)

echo "Container PID: $CONTAINER_PID"
echo "OOM Score: $(cat /proc/${HOST_PID}/oom_score 2>/dev/null)"
echo "OOM Score Adj: $(cat /proc/${HOST_PID}/oom_score_adj 2>/dev/null)"
```

### Critical System Process Protection

Kubernetes nodes have several processes that must survive memory pressure. These are configured by kubelet and systemd:

```bash
# Processes that should have maximum OOM protection:
# kubelet:        -999  (set by kubelet itself)
# containerd:     -999  (set by containerd)
# systemd:        -1000 (set by systemd itself)
# kube-proxy:     -999

# Verify kubelet's oom_score_adj
cat /proc/$(pgrep kubelet)/oom_score_adj
# -999

# Verify systemd
cat /proc/1/oom_score_adj
# -1000

# Check containerd
cat /proc/$(pgrep containerd | head -1)/oom_score_adj
# -999

# If kubelet oom_score_adj is not -999, kubelet may have been reconfigured
# Check kubelet config
grep -i oom /var/lib/kubelet/config.yaml
# oomScoreAdj: -999
```

### Systemd Unit OOM Protection

For node-level services that run outside of Kubernetes but on the same node:

```ini
# /etc/systemd/system/node-exporter.service
[Unit]
Description=Prometheus Node Exporter
After=network.target

[Service]
Type=simple
User=prometheus
ExecStart=/usr/local/bin/node_exporter
Restart=on-failure
RestartSec=5s

# OOM protection — node_exporter should survive memory pressure
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
```

```bash
# Apply immediately without restart
systemctl set-property node-exporter.service OOMScoreAdjust=-500

# Verify
cat /proc/$(pgrep node_exporter)/oom_score_adj
# -500
```

## Memory Overcommit Configuration

### Overcommit Policies

Linux's memory overcommit allows more memory to be "allocated" (reserved via mmap) than is physically present, relying on the observation that most programs don't use all their reserved memory simultaneously.

```bash
# View current overcommit policy
cat /proc/sys/vm/overcommit_memory
# 0 = Heuristic (default): allow some overcommit
# 1 = Always allow: disable OOM kill for commit, may deadlock
# 2 = Never: limit total commit to swap + overcommit_ratio% of RAM

cat /proc/sys/vm/overcommit_ratio
# 50 = 50% of RAM can be overcommitted (when overcommit_memory=2)

# View current memory commitment
cat /proc/meminfo | grep -i commit
# CommitLimit:    33292288 kB   -- maximum total commit allowed
# Committed_AS:   28473936 kB   -- currently committed memory

# Calculate headroom
awk '
/CommitLimit/ { limit=$2 }
/Committed_AS/ { used=$2 }
END { printf "Overcommit headroom: %.1f GB\n", (limit-used)/1024/1024 }
' /proc/meminfo
```

### Recommended Settings for Kubernetes Nodes

```bash
# For most Kubernetes nodes, these settings balance stability and density:
# Disable swap (required by Kubernetes by default)
swapoff -a
sed -i '/swap/d' /etc/fstab

# Keep heuristic overcommit (default), but adjust ratio
sysctl -w vm.overcommit_memory=0

# For nodes where OOM kills are acceptable and density is important:
sysctl -w vm.overcommit_memory=1  # Riskier but maximizes pod density

# For critical infrastructure nodes that must not OOM kill:
# overcommit_memory=2 prevents over-allocation at the cost of lower density
sysctl -w vm.overcommit_memory=2
sysctl -w vm.overcommit_ratio=80  # Allow 80% of RAM as commit space

# Persist settings
cat >> /etc/sysctl.d/99-kubernetes-memory.conf << 'EOF'
# Memory management for Kubernetes nodes
vm.overcommit_memory = 0

# Influence OOM killer aggressiveness (lower = kernel tries harder to reclaim before killing)
vm.panic_on_oom = 0
vm.oom_kill_allocating_task = 1

# Tune page reclaim behavior
vm.swappiness = 0                  # Avoid swap on Kubernetes nodes
vm.dirty_ratio = 20                # Start synchronous writeback at 20% dirty
vm.dirty_background_ratio = 5     # Start background writeback at 5% dirty
vm.min_free_kbytes = 131072       # Keep 128MB free to prevent OOM from free-page exhaustion

# Kernel memory accounting
vm.overcommit_kbytes = 0          # Use ratio-based limit, not absolute
EOF

sysctl -p /etc/sysctl.d/99-kubernetes-memory.conf
```

### oom_kill_allocating_task

```bash
# With oom_kill_allocating_task=0 (default):
# Kernel selects victim based purely on OOM score
# The allocating task may survive while a higher-score process is killed

# With oom_kill_allocating_task=1:
# Kill the task that triggered the OOM condition
# More predictable behavior — the task that consumed memory dies
cat /proc/sys/vm/oom_kill_allocating_task
# 0  (default)

# For Kubernetes: prefer killing the allocating task
sysctl -w vm.oom_kill_allocating_task=1
```

## cgroup OOM Events and Monitoring

### Monitoring cgroup Memory Events

```bash
#!/bin/bash
# monitor-cgroup-oom.sh
# Watch for OOM events across all pod cgroups

watch -n 2 '
for dir in /sys/fs/cgroup/kubepods.slice/*/pod*/*/; do
    events_file="${dir}memory.events"
    [[ -f "$events_file" ]] || continue

    oom_kill=$(grep "^oom_kill " "$events_file" | awk "{print \$2}")
    oom=$(grep "^oom " "$events_file" | awk "{print \$2}")
    high=$(grep "^high " "$events_file" | awk "{print \$2}")

    if [[ "$oom_kill" -gt 0 ]] || [[ "$high" -gt 100 ]]; then
        container=$(basename "$dir")
        pod=$(basename "$(dirname "$dir")")
        printf "OOM:%d HIGH:%d CONTAINER:%s POD:%s\n" \
            "$oom_kill" "$high" "$container" "$pod"
    fi
done
'
```

### cgroup Memory Threshold Notifications

```bash
# Set up memory threshold notification via eventfd (kernel mechanism)
# This is what container runtimes use internally

# More practical: use Prometheus alerts on cAdvisor metrics
# container_memory_working_set_bytes vs container_spec_memory_limit_bytes
```

### Prometheus Alerts for OOM Risk

```yaml
# prometheus-oom-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: oom-risk-alerts
  namespace: monitoring
spec:
  groups:
    - name: memory.oom
      interval: 30s
      rules:
        # Container OOM Kill detected
        - alert: ContainerOOMKilled
          expr: kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          for: 0m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} in pod {{ $labels.pod }} was OOM killed"
            description: "Pod {{ $labels.namespace }}/{{ $labels.pod }} container {{ $labels.container }} was OOMKilled. Check memory limits."

        # Container approaching memory limit (>90%)
        - alert: ContainerMemoryNearLimit
          expr: |
            container_memory_working_set_bytes{container!=""}
            /
            container_spec_memory_limit_bytes{container!=""}
            > 0.90
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Container {{ $labels.container }} memory usage at {{ printf \"%.0f\" (mul $value 100) }}%"
            description: "Container is using {{ printf \"%.0f\" (mul $value 100) }}% of its memory limit. OOM kill risk."

        # Node memory pressure
        - alert: NodeMemoryPressure
          expr: kube_node_status_condition{condition="MemoryPressure",status="true"} == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.node }} has MemoryPressure condition"
            description: "Kubernetes node is under memory pressure. Kubelet will start evicting pods."

        # Node memory utilization high
        - alert: NodeMemoryHighUtilization
          expr: |
            (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)) > 0.90
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Node {{ $labels.instance }} memory utilization {{ printf \"%.0f\" (mul $value 100) }}%"
            description: "Available memory on node is critically low. OOM kill is imminent."

        # Containers with OOM restarts in the last hour
        - alert: ContainerFrequentOOMRestarts
          expr: |
            increase(kube_pod_container_status_restarts_total[1h]) > 3
            and on (namespace, pod, container)
            kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
          for: 0m
          labels:
            severity: critical
          annotations:
            summary: "Container {{ $labels.container }} has restarted {{ $value }} times due to OOM in 1 hour"
```

## Kubernetes Eviction Configuration

Kubernetes has its own soft eviction mechanism that runs before the OOM killer, giving pods graceful shutdown time:

```yaml
# /var/lib/kubelet/config.yaml
evictionHard:
  memory.available: "200Mi"    # Evict pods when <200Mi available
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"

evictionSoft:
  memory.available: "500Mi"    # Start graceful eviction at 500Mi remaining
  nodefs.available: "15%"

evictionSoftGracePeriod:
  memory.available: "2m"       # Give pods 2 minutes to terminate gracefully
  nodefs.available: "2m"

evictionMaxPodGracePeriod: 120  # Maximum grace period for any soft eviction

evictionPressureTransitionPeriod: "5m"  # Time before exiting memory pressure

# Reserve memory for system + kubelet
systemReserved:
  memory: "512Mi"
  cpu: "100m"
kubeReserved:
  memory: "512Mi"
  cpu: "100m"
```

### Priority-Based Eviction Order

Kubernetes evicts pods in QoS order, but within the same QoS class, pods consuming more than their requests are evicted first:

```
Eviction Priority (first evicted to last):
1. BestEffort pods (no requests/limits)
2. Burstable pods exceeding requests
3. Burstable pods using less than requests
4. Guaranteed pods (never evicted, but OOM killed if they exceed limits)
```

```yaml
# PodDisruptionBudget to limit eviction impact
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: app-backend-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: app-backend
```

## Memory Limit Recommendations by Workload Type

### JVM Applications

Java garbage collectors request a large heap upfront. Set container limits 25-50% above the configured heap to account for non-heap memory:

```yaml
# For JVM with -Xmx=4g
resources:
  requests:
    memory: "4Gi"
  limits:
    memory: "6Gi"   # 4Gi heap + 2Gi for metaspace, native threads, GC overhead

env:
  - name: JAVA_OPTS
    value: >-
      -Xms4g
      -Xmx4g
      -XX:MaxMetaspaceSize=512m
      -XX:MaxDirectMemorySize=512m
      -XX:+UseContainerSupport
      -XX:+ExitOnOutOfMemoryError
```

### Go Applications

Go's GC reserves headroom beyond working set. Allow 2-3x the steady-state RSS:

```yaml
# For Go service with 500Mi steady-state RSS
resources:
  requests:
    memory: "256Mi"   # Request matches typical steady-state
  limits:
    memory: "1Gi"     # Allow room for GC cycles and traffic spikes

env:
  - name: GOGC
    value: "75"     # More aggressive GC, lower memory peak
  - name: GOMEMLIMIT
    value: "900MiB"  # Soft limit that triggers GC before hard OOM
```

The `GOMEMLIMIT` environment variable (Go 1.19+) sets a soft memory limit that triggers more aggressive GC before hitting the container hard limit, preventing OOM kills from GC timing issues.

### Node.js Applications

```yaml
# For Node.js with V8 heap limit
resources:
  requests:
    memory: "256Mi"
  limits:
    memory: "1Gi"

env:
  - name: NODE_OPTIONS
    value: "--max-old-space-size=768"  # 75% of container limit
```

## Analyzing OOM Kill Events

### Post-OOM Analysis Playbook

```bash
#!/bin/bash
# analyze-oom.sh
# Collect information after an OOM kill event

echo "=== OOM Kill Analysis ==="
echo ""

echo "--- Recent OOM events from kernel log ---"
journalctl -k --since "1 hour ago" | grep -A 10 "Out of memory" | head -80
echo ""

echo "--- cgroup memory events ---"
for cgroup in /sys/fs/cgroup/kubepods.slice/*/pod*/*/memory.events; do
    [[ -f "$cgroup" ]] || continue
    oom_kill=$(awk '/oom_kill/ {print $2}' "$cgroup")
    [[ "$oom_kill" -gt 0 ]] || continue
    echo "  $cgroup"
    cat "$cgroup"
    echo ""
done

echo "--- Kubernetes pod OOM status ---"
kubectl get pods --all-namespaces \
    --field-selector=status.phase=Running \
    -o json | \
    jq -r '.items[] | 
        select(.status.containerStatuses != null) |
        select(.status.containerStatuses[].lastState.terminated.reason == "OOMKilled") |
        "\(.metadata.namespace)/\(.metadata.name): OOMKilled at \(.status.containerStatuses[].lastState.terminated.finishedAt)"'

echo ""
echo "--- Current memory utilization ---"
free -h
echo ""
cat /proc/meminfo | grep -E "MemTotal|MemAvailable|Cached|Buffers|SwapTotal|SwapFree"
```

## Summary

The Linux OOM killer's behavior in Kubernetes environments is largely determined by `oom_score_adj` values that correspond to pod QoS classes. Guaranteed pods receive high protection, BestEffort pods are killed first, and Burstable pods fall in between based on their memory limits relative to node capacity.

Effective OOM prevention requires three layers: accurate container memory requests and limits (avoiding both over-restriction that causes legitimate OOM kills and under-restriction that causes node-level OOM events), memory overcommit settings calibrated to the workload mix, and Kubernetes eviction thresholds set to reclaim memory gracefully before the OOM killer activates. Prometheus alerting at 90% memory utilization with cgroup OOM event monitoring provides the early warning needed to respond before processes are killed.
