---
title: "Kubernetes Node Problem Detector: Kernel Panic Detection, OOM Detection, Custom Conditions, and Remedy Controller"
date: 2032-01-13T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "Monitoring", "OOM", "Kernel", "Node Management", "Reliability", "SRE"]
categories:
- Kubernetes
- Monitoring
- DevOps
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive enterprise guide to Kubernetes Node Problem Detector: configuring kernel panic and OOM detection, writing custom problem detectors, surfacing node conditions, and integrating the Remedy Controller for automated remediation."
more_link: "yes"
url: "/kubernetes-node-problem-detector-kernel-panic-oom-custom-conditions-remedy/"
---

Kubernetes node health is typically managed through kubelet readiness signals, but these address only the Kubernetes layer. Nodes can suffer from dozens of conditions that kubelet does not detect: kernel panics, out-of-memory kills, NFS timeouts, disk corruption, Docker daemon hangs, kernel deadlocks, and custom application-level problems. Node Problem Detector (NPD) bridges this gap by monitoring system logs, kernel events, and health scripts, translating detected problems into Kubernetes `NodeCondition` objects and events that can trigger scheduling decisions, alerts, and automated remediation.

<!--more-->

# Kubernetes Node Problem Detector: Enterprise Production Guide

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│  Kubernetes Node                                               │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Node Problem Detector (DaemonSet)                      │  │
│  │                                                          │  │
│  │  Source Plugins:           Problem Types:               │  │
│  │  ┌──────────────────┐     ┌───────────────────────────┐ │  │
│  │  │ SystemLogMonitor │────►│ NodeCondition (permanent) │ │  │
│  │  │ (journald/syslog)│     │ NodeEvent (transient)     │ │  │
│  │  └──────────────────┘     └───────────────────────────┘ │  │
│  │  ┌──────────────────┐                                   │  │
│  │  │ KernelMonitor    │     Outputs:                      │  │
│  │  │ (kmsg, /dev/kmsg)│────►K8s API: Node.Status.Conditions│ │
│  │  └──────────────────┘     Prometheus: /metrics           │  │
│  │  ┌──────────────────┐                                   │  │
│  │  │ CustomPlugins    │                                   │  │
│  │  │ (scripts/checks) │                                   │  │
│  │  └──────────────────┘                                   │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐    │
│  │  Remedy Controller (optional)                         │    │
│  │  Watches NodeConditions → Triggers remediation        │    │
│  └───────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

### Problem Types

**NodeCondition** (persisted on Node object):
- Type field on `node.status.conditions`
- Visible to scheduler: taints/tolerations can be auto-applied
- Persists until explicitly cleared
- Example: `KernelDeadlock`, `MemoryPressure`, `DiskPressure`

**NodeEvent** (transient event):
- Kubernetes Event object (TTL 1 hour by default)
- Does not affect scheduling
- Useful for alerting and audit trails
- Example: `OOMKilling`, `TaskHungInKernelD`

## Part 1: Installation

### Helm Chart Installation (Recommended)

```bash
# Add the NPD Helm chart
helm repo add deliveryhero https://charts.deliveryhero.io/
helm repo update

# Or use the official chart from kubernetes/node-problem-detector
helm repo add npd https://raw.githubusercontent.com/kubernetes/node-problem-detector/master/charts
helm repo update
```

### Values Configuration

```yaml
# values-npd.yaml
image:
  repository: registry.k8s.io/node-problem-detector/node-problem-detector
  tag: v0.8.18
  pullPolicy: IfNotPresent

resources:
  requests:
    cpu: 20m
    memory: 100Mi
  limits:
    cpu: 200m
    memory: 512Mi

# Mount host paths for log access
hostMountPaths:
  varlog:
    hostPath: /var/log
    mountPath: /var/log
  kmsg:
    hostPath: /dev/kmsg
    mountPath: /dev/kmsg

securityContext:
  privileged: true  # Required for /dev/kmsg access

# Service account for Node status updates
serviceAccount:
  create: true
  name: node-problem-detector

rbac:
  create: true

# Enable Prometheus metrics
metrics:
  enabled: true
  port: 20257
  serviceMonitor:
    enabled: true
    namespace: monitoring

# DaemonSet tolerations: run on all nodes including tainted ones
tolerations:
  - operator: Exists
    effect: NoExecute
  - operator: Exists
    effect: NoSchedule

priorityClassName: system-node-critical

# NPD configuration (passed as configmaps)
settings:
  log_monitors:
    - /config/kernel-monitor.json
    - /config/docker-monitor.json
    - /config/systemd-monitor.json
  custom_plugin_monitors:
    - /config/custom-plugin-monitor.json
```

```bash
helm install node-problem-detector npd/node-problem-detector \
    --namespace kube-system \
    --values values-npd.yaml
```

### Manual DaemonSet Deployment

```yaml
# npd-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-problem-detector
  namespace: kube-system
  labels:
    app: node-problem-detector
spec:
  selector:
    matchLabels:
      app: node-problem-detector
  template:
    metadata:
      labels:
        app: node-problem-detector
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "20257"
    spec:
      serviceAccountName: node-problem-detector
      hostNetwork: false
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists
          effect: NoExecute
        - operator: Exists
          effect: NoSchedule
      containers:
        - name: node-problem-detector
          image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.18
          securityContext:
            privileged: true
          command:
            - /node-problem-detector
            - --logtostderr
            - --log-monitors=/config/kernel-monitor.json
            - --log-monitors=/config/docker-monitor.json
            - --log-monitors=/config/systemd-monitor.json
            - --custom-plugin-monitors=/config/custom-plugin-monitor.json
            - --apiserver-override=https://$(KUBERNETES_SERVICE_HOST):$(KUBERNETES_SERVICE_PORT)?inClusterConfig=true
            - --address=0.0.0.0
            - --port=20257
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
          ports:
            - containerPort: 20257
              name: metrics
          volumeMounts:
            - name: log
              mountPath: /var/log
              readOnly: true
            - name: kmsg
              mountPath: /dev/kmsg
              readOnly: true
            - name: config
              mountPath: /config
          resources:
            requests:
              cpu: 20m
              memory: 100Mi
            limits:
              cpu: 200m
              memory: 512Mi
      volumes:
        - name: log
          hostPath:
            path: /var/log
        - name: kmsg
          hostPath:
            path: /dev/kmsg
        - name: config
          configMap:
            name: node-problem-detector-config
```

### RBAC Resources

```yaml
# rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: node-problem-detector
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: node-problem-detector
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: node-problem-detector
subjects:
  - kind: ServiceAccount
    name: node-problem-detector
    namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-problem-detector
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "patch"]
  - apiGroups: [""]
    resources: ["nodes/status"]
    verbs: ["get", "update", "patch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch", "update"]
```

## Part 2: Built-in Problem Detectors

### Kernel Monitor Configuration

```json
// /config/kernel-monitor.json
{
  "plugin": "kmsg",
  "logPath": "/dev/kmsg",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "kernel-monitor",
  "conditions": [
    {
      "type": "KernelDeadlock",
      "reason": "KernelHasNoDeadlock",
      "message": "kernel has no deadlock"
    },
    {
      "type": "ReadonlyFilesystem",
      "reason": "FilesystemIsNotReadOnly",
      "message": "Filesystem is not read-only"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "OOMKilling",
      "pattern": "Kill process \\d+ (.+) score \\d+ or sacrifice child\\nKilled process \\d+ (.+) total-vm:\\d+kB, anon-rss:\\d+kB, file-rss:\\d+kB"
    },
    {
      "type": "temporary",
      "reason": "TaskHungInKernelD",
      "pattern": "task (.+):\\d+ blocked for more than \\d+ seconds\\."
    },
    {
      "type": "temporary",
      "reason": "UnregisterNetDevice",
      "pattern": "unregister_netdevice: waiting for (.+) to become free. Usage count = \\d+"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "AUFSUmountHung",
      "pattern": "task (.+):\\d+ blocked for more than \\d+ seconds\\."
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "DockerHung",
      "pattern": "task docker:\\d+ blocked for more than \\d+ seconds\\."
    },
    {
      "type": "permanent",
      "condition": "ReadonlyFilesystem",
      "reason": "FilesystemIsReadOnly",
      "pattern": "Remounting filesystem read-only"
    }
  ]
}
```

### System Log Monitor (journald)

```json
// /config/systemd-monitor.json
{
  "plugin": "journald",
  "pluginConfig": {
    "since": ""
  },
  "logPath": "/var/log/journal",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "systemd-monitor",
  "conditions": [
    {
      "type": "ContainerRuntimeUnhealthy",
      "reason": "ContainerRuntimeIsHealthy",
      "message": "container runtime is functioning normally"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "ContainerRuntimeDown",
      "pattern": ".*containerd.*Failed to start containerd.*",
      "filter": [
        {
          "key": "SYSTEMD_UNIT",
          "value": "containerd.service"
        }
      ]
    },
    {
      "type": "permanent",
      "condition": "ContainerRuntimeUnhealthy",
      "reason": "ContainerRuntimeCrashLooping",
      "pattern": ".*containerd.*too many open files.*"
    }
  ]
}
```

### Docker/containerd Monitor

```json
// /config/docker-monitor.json
{
  "plugin": "journald",
  "pluginConfig": {
    "since": ""
  },
  "logPath": "/var/log/journal",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "docker-monitor",
  "conditions": [],
  "rules": [
    {
      "type": "temporary",
      "reason": "CorruptDockerImage",
      "pattern": "Error trying v2 registry: failed to register layer: Error processing tar file\\(exit status 1\\): container_linux\\.go:378: starting container process caused",
      "filter": [
        {
          "key": "_SYSTEMD_UNIT",
          "value": "docker.service"
        }
      ]
    },
    {
      "type": "temporary",
      "reason": "DockerOOMKilled",
      "pattern": "OOM killer invoked"
    }
  ]
}
```

## Part 3: Custom Plugin Monitors

### Custom Plugin Architecture

Custom plugins are shell scripts (or any executable) that NPD calls periodically. The exit code determines the result:

- **Exit 0**: Healthy (condition OK, no event)
- **Exit 1**: Problem detected (raises NodeCondition or NodeEvent)
- **Exit 2**: Unknown/transient error (not reported as problem)

### Custom Plugin Monitor Configuration

```json
// /config/custom-plugin-monitor.json
{
  "plugin": "custom",
  "pluginConfig": {
    "invokeIntervalMs": 30000,
    "timeoutMs": 10000,
    "maxOutputLen": 80,
    "concurrency": 3
  },
  "source": "custom-plugin-monitor",
  "skipInitialStatus": true,
  "metricsReporting": true,
  "conditions": [
    {
      "type": "NFSConnectivity",
      "reason": "NFSIsConnected",
      "message": "NFS is connected and accessible"
    },
    {
      "type": "NetworkLatencyHigh",
      "reason": "NetworkLatencyIsNormal",
      "message": "Network latency is within acceptable limits"
    },
    {
      "type": "DiskPerformanceDegraded",
      "reason": "DiskPerformanceIsNormal",
      "message": "Disk I/O performance is normal"
    },
    {
      "type": "GPUUnhealthy",
      "reason": "GPUIsHealthy",
      "message": "GPU devices are healthy"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "NFSConnectivity",
      "reason": "NFSMountFailed",
      "path": "/config/custom-plugins/check_nfs.sh"
    },
    {
      "type": "permanent",
      "condition": "NetworkLatencyHigh",
      "reason": "NetworkLatencyExceeded",
      "path": "/config/custom-plugins/check_network_latency.sh",
      "timeout": "5s"
    },
    {
      "type": "permanent",
      "condition": "DiskPerformanceDegraded",
      "reason": "DiskIOSlow",
      "path": "/config/custom-plugins/check_disk_performance.sh",
      "timeout": "30s"
    },
    {
      "type": "temporary",
      "reason": "SystemMemoryFragmented",
      "path": "/config/custom-plugins/check_memory_fragmentation.sh"
    },
    {
      "type": "permanent",
      "condition": "GPUUnhealthy",
      "reason": "GPUError",
      "path": "/config/custom-plugins/check_gpu.sh"
    }
  ]
}
```

### NFS Check Plugin

```bash
#!/bin/bash
# /config/custom-plugins/check_nfs.sh
# Check NFS mount availability and I/O health

set -euo pipefail

NFS_MOUNTS=()
while IFS= read -r mount; do
    NFS_MOUNTS+=("$mount")
done < <(awk '$3 ~ /^nfs/ {print $2}' /proc/mounts)

if [[ ${#NFS_MOUNTS[@]} -eq 0 ]]; then
    # No NFS mounts — not a problem
    exit 0
fi

FAILED_MOUNTS=()
TIMEOUT=5

for mount_point in "${NFS_MOUNTS[@]}"; do
    # Check if the mount is stale (hangs on stat)
    if ! timeout "$TIMEOUT" stat "$mount_point" &>/dev/null; then
        FAILED_MOUNTS+=("$mount_point (stat timeout)")
        continue
    fi

    # Check if we can create/read/delete a test file
    test_file="${mount_point}/.nfs_health_check_$(hostname)_$$"
    if ! timeout "$TIMEOUT" touch "$test_file" &>/dev/null; then
        FAILED_MOUNTS+=("$mount_point (write failed)")
        continue
    fi
    timeout "$TIMEOUT" rm -f "$test_file" &>/dev/null || true
done

if [[ ${#FAILED_MOUNTS[@]} -gt 0 ]]; then
    echo "NFS mount failures: ${FAILED_MOUNTS[*]}"
    exit 1
fi

exit 0
```

### Disk Performance Check Plugin

```bash
#!/bin/bash
# /config/custom-plugins/check_disk_performance.sh
# Detect degraded disk I/O (indicates potential hardware failure or I/O subsystem issue)

set -euo pipefail

# Threshold: alert if any disk shows >100ms avg I/O wait time
IOWAIT_THRESHOLD_MS=100

# Read I/O stats from /proc/diskstats
# Field 14: weighted time spent doing I/Os (ms)
# Field 6+10: total I/Os (reads + writes)
declare -A DISK_IO_TIME_1
declare -A DISK_IO_COUNT_1

sample_disk_stats() {
    local -n result=$1
    while read -r _ _ dev _ _ _ io_time _ _ _ _weighted_io_time _; do
        [[ "$dev" =~ ^(sd|vd|nvme|xvd) ]] || continue
        result["${dev}_io_time"]=$io_time
    done < /proc/diskstats
}

# Sample once, wait 5 seconds, sample again
sample_disk_stats DISK_IO_TIME_1
sleep 5

declare -A DISK_IO_TIME_2
sample_disk_stats DISK_IO_TIME_2

SLOW_DISKS=()

for key in "${!DISK_IO_TIME_2[@]}"; do
    dev="${key%_io_time}"
    t1="${DISK_IO_TIME_1[$key]:-0}"
    t2="${DISK_IO_TIME_2[$key]}"

    # ms of I/O wait during the 5-second interval
    io_wait_ms=$((t2 - t1))

    # Convert to per-second average
    io_wait_per_sec=$((io_wait_ms / 5))

    if [[ $io_wait_per_sec -gt $IOWAIT_THRESHOLD_MS ]]; then
        SLOW_DISKS+=("$dev: ${io_wait_per_sec}ms/s I/O wait")
    fi
done

if [[ ${#SLOW_DISKS[@]} -gt 0 ]]; then
    echo "Disk I/O degraded: ${SLOW_DISKS[*]}"
    exit 1
fi

exit 0
```

### Memory Fragmentation Check

```bash
#!/bin/bash
# /config/custom-plugins/check_memory_fragmentation.sh
# Detect severe memory fragmentation (causes allocation failures, OOM)

set -euo pipefail

# Check fragmentation index for order-9 (2MB) allocations
# A high fragmentation index (>850) indicates severe fragmentation
FRAGMENTATION_THRESHOLD=850

FRAGMENTED_ZONES=()

while read -r zone_name order fragindex; do
    if [[ "$zone_name" == *"Normal"* ]] && [[ "$order" == "9" ]]; then
        if [[ $fragindex -gt $FRAGMENTATION_THRESHOLD ]]; then
            FRAGMENTED_ZONES+=("Zone $zone_name order $order: frag=$fragindex")
        fi
    fi
done < <(cat /sys/kernel/debug/extfrag/extfrag_index 2>/dev/null | \
         awk 'NR>1 {print $1, $2, $NF}')

# Also check /proc/buddyinfo for large allocation availability
CRITICAL_ZONES=()
while IFS= read -r line; do
    if echo "$line" | grep -q "Normal"; then
        # Check if high-order (order 9+) pages are depleted
        order9=$(echo "$line" | awk '{print $(NF-0)}')
        if [[ "${order9:-0}" -eq 0 ]]; then
            CRITICAL_ZONES+=("Normal zone has no order-9 pages")
        fi
    fi
done < /proc/buddyinfo

if [[ ${#FRAGMENTED_ZONES[@]} -gt 0 ]] || [[ ${#CRITICAL_ZONES[@]} -gt 0 ]]; then
    echo "Memory fragmentation: ${FRAGMENTED_ZONES[*]} ${CRITICAL_ZONES[*]}"
    exit 1
fi

exit 0
```

### GPU Health Check Plugin

```bash
#!/bin/bash
# /config/custom-plugins/check_gpu.sh
# Validate NVIDIA GPU health via nvidia-smi

set -euo pipefail

# If no GPUs, exit healthy
if ! command -v nvidia-smi &>/dev/null; then
    exit 0
fi

PROBLEM_GPUS=()

# Check for hardware errors, remapped rows, or error states
while IFS=',' read -r index name health ecc_errors xid; do
    xid="${xid// /}"
    if [[ "$health" != "OK" ]]; then
        PROBLEM_GPUS+=("GPU $index ($name): health=$health")
    fi
    if [[ "${xid:-0}" -gt 0 ]]; then
        PROBLEM_GPUS+=("GPU $index ($name): XID error count=$xid")
    fi
done < <(nvidia-smi --query-gpu=index,name,health,ecc.errors.corrected.volatile.total,xid.last_service \
            --format=csv,noheader 2>/dev/null || echo "query_failed")

if [[ ${#PROBLEM_GPUS[@]} -gt 0 ]]; then
    echo "GPU problems detected: ${PROBLEM_GPUS[*]}"
    exit 1
fi

# Check driver status
if ! nvidia-smi -pm 0 &>/dev/null; then
    echo "GPU driver not responding"
    exit 1
fi

exit 0
```

## Part 4: Delivering Plugins via ConfigMap

```yaml
# custom-plugins-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-detector-custom-plugins
  namespace: kube-system
data:
  check_nfs.sh: |
    #!/bin/bash
    # ... (script content from above)

  check_disk_performance.sh: |
    #!/bin/bash
    # ... (script content from above)

  check_memory_fragmentation.sh: |
    #!/bin/bash
    # ... (script content from above)

  check_gpu.sh: |
    #!/bin/bash
    # ... (script content from above)
```

```yaml
# Add to DaemonSet volumes and volumeMounts:
volumes:
  - name: custom-plugins
    configMap:
      name: node-problem-detector-custom-plugins
      defaultMode: 0755  # Execute permission

containers:
  - name: node-problem-detector
    volumeMounts:
      - name: custom-plugins
        mountPath: /config/custom-plugins
```

## Part 5: NodeConditions in Action

### Viewing NodeConditions

```bash
# View all conditions on a node
kubectl describe node node1 | grep -A 100 "Conditions:"

# Example output showing NPD-managed conditions:
# Type                       Status  LastHeartbeatTime   Reason
# ----                       ------  -----------------   ------
# KernelDeadlock             False   ...                 KernelHasNoDeadlock
# ReadonlyFilesystem         False   ...                 FilesystemIsNotReadOnly
# NFSConnectivity            False   ...                 NFSIsConnected
# DiskPerformanceDegraded    False   ...                 DiskPerformanceIsNormal
# MemoryPressure             False   ...                 KubeletHasSufficientMemory
# Ready                      True    ...                 KubeletReady

# Query conditions via API
kubectl get node node1 -o jsonpath='{.status.conditions[*]}' | jq .
```

### Using NodeConditions in Pod Scheduling

Automatically taint nodes with problems:

```yaml
# taint-controller.yaml — watches NodeConditions and applies taints
# This pattern is implemented by the Cluster Autoscaler and Node Auto-Provisioner
# For custom conditions, use the Remedy Controller or write a simple controller

apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-taint-config
  namespace: kube-system
data:
  config.yaml: |
    conditions:
      - type: KernelDeadlock
        taint:
          key: node.kubernetes.io/kernel-deadlock
          effect: NoSchedule
      - type: NFSConnectivity
        taint:
          key: node.kubernetes.io/nfs-unavailable
          effect: NoSchedule
      - type: DiskPerformanceDegraded
        taint:
          key: node.kubernetes.io/disk-degraded
          effect: NoExecute
          tolerationSeconds: 300
```

### Manually Setting Node Conditions for Testing

```bash
# Set a test condition using kubectl
kubectl patch node node1 --type=json -p='[
  {
    "op": "add",
    "path": "/status/conditions/-",
    "value": {
      "type": "NFSConnectivity",
      "status": "True",
      "reason": "NFSMountFailed",
      "message": "Test: NFS mount /data is unavailable",
      "lastHeartbeatTime": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
      "lastTransitionTime": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }
  }
]'

# Verify
kubectl get node node1 -o jsonpath='{.status.conditions[?(@.type=="NFSConnectivity")]}'
```

## Part 6: Remedy Controller

The Remedy Controller (part of the cluster-api-provider-azure and available as a standalone component) watches NodeConditions and takes automated remediation actions.

### NodeRemediation CRD

```yaml
# Install the Remedy Controller CRDs and operator
# (Available from various HA operators; shown here as a pattern)

apiVersion: remedy.platformengineering.io/v1alpha1
kind: NodeRemediation
metadata:
  name: kernel-deadlock-remediation
spec:
  # Watch for this condition
  condition:
    type: KernelDeadlock
    status: "True"

  # Actions to take when condition is detected
  actions:
    # Step 1: Cordon the node (prevent new pods)
    - type: CordonNode
      order: 1

    # Step 2: Wait for in-flight pods to complete
    - type: WaitForPodCompletion
      order: 2
      timeout: 5m

    # Step 3: Drain non-critical pods
    - type: DrainNode
      order: 3
      parameters:
        gracePeriodSeconds: 60
        ignoreDaemonSets: true
        deleteEmptyDirData: true
      timeout: 10m

    # Step 4: Trigger node repair (cloud provider specific)
    - type: TriggerNodeRepair
      order: 4

  # Recovery: uncordon node when condition clears
  recovery:
    uncordonOnConditionClear: true
```

### Custom Remedy Controller with kubectl

A simple bash-based remedy controller using watch:

```bash
#!/bin/bash
# remedy-controller.sh — watches for NPD conditions and remediates

set -euo pipefail

CONDITION_TYPE="${1:-KernelDeadlock}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-300}"

echo "Watching for NodeCondition: $CONDITION_TYPE"

# Watch for condition changes
kubectl get nodes -w -o json 2>/dev/null | \
jq -c --unbuffered '
  .status.conditions[]?
  | select(.type == "'"$CONDITION_TYPE"'" and .status == "True")
  | {node: (input.metadata.name // "unknown"), condition: .type, reason: .reason, message: .message}
' | while read -r event; do
    NODE=$(echo "$event" | jq -r '.node')
    REASON=$(echo "$event" | jq -r '.reason')
    MESSAGE=$(echo "$event" | jq -r '.message')

    echo "DETECTED: Node $NODE has $CONDITION_TYPE: $REASON - $MESSAGE"

    # Cordon the node
    echo "Cordoning node: $NODE"
    kubectl cordon "$NODE"

    # Send alert (webhook/slack)
    # curl -s -X POST "$ALERT_WEBHOOK" \
    #     -H "Content-Type: application/json" \
    #     -d "{\"text\":\"Node $NODE: $CONDITION_TYPE detected - $MESSAGE\"}"

    # Drain (with safety guards)
    echo "Draining node: $NODE (timeout: ${DRAIN_TIMEOUT}s)"
    kubectl drain "$NODE" \
        --ignore-daemonsets \
        --delete-emptydir-data \
        --grace-period=60 \
        --timeout="${DRAIN_TIMEOUT}s" \
        --force=false || echo "Drain completed with warnings"

    echo "Node $NODE drained. Manual investigation required for $CONDITION_TYPE."
done
```

## Part 7: Monitoring NPD with Prometheus

### Key Metrics

NPD exposes metrics at `:20257/metrics`:

```
# Number of node problem detector checks per type
npd_custom_plugin_check_count{check_name="check_nfs",status="success"}
npd_custom_plugin_check_count{check_name="check_nfs",status="failure"}
npd_custom_plugin_check_count{check_name="check_nfs",status="timeout"}

# Plugin check duration
npd_custom_plugin_check_duration_seconds{check_name="check_disk_performance"}

# Log monitor errors found
npd_log_monitor_errors_found_total{source="kernel-monitor",reason="OOMKilling"}
```

### PrometheusRule for NPD Alerting

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-problem-detector-alerts
  namespace: monitoring
spec:
  groups:
    - name: node-problem-detector
      interval: 30s
      rules:
        # Alert when NPD itself is not running
        - alert: NodeProblemDetectorDown
          expr: |
            absent(up{job="node-problem-detector"}) or
            sum by (node) (up{job="node-problem-detector"}) == 0
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Node Problem Detector is not running on some nodes"

        # Alert on OOM kills (kernel event)
        - alert: NodeOOMKillDetected
          expr: |
            increase(npd_log_monitor_errors_found_total{reason="OOMKilling"}[5m]) > 0
          labels:
            severity: warning
          annotations:
            summary: "OOM kill detected on node {{ $labels.node }}"
            description: "The kernel OOM killer has been invoked on this node"

        # Alert on kernel deadlock condition
        - alert: NodeKernelDeadlock
          expr: |
            kube_node_status_condition{condition="KernelDeadlock",status="true"} == 1
          for: 1m
          labels:
            severity: critical
          annotations:
            summary: "Kernel deadlock on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} has a kernel deadlock. Manual intervention required."

        # Alert on NFS connectivity loss
        - alert: NodeNFSConnectivityLost
          expr: |
            kube_node_status_condition{condition="NFSConnectivity",status="true"} == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "NFS connectivity lost on node {{ $labels.node }}"

        # Alert on disk performance degradation
        - alert: NodeDiskPerformanceDegraded
          expr: |
            kube_node_status_condition{condition="DiskPerformanceDegraded",status="true"} == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Disk performance degraded on node {{ $labels.node }}"

        # Alert on custom plugin timeout (indicates script issue)
        - alert: NPDPluginTimeout
          expr: |
            increase(npd_custom_plugin_check_count{status="timeout"}[15m]) > 3
          labels:
            severity: warning
          annotations:
            summary: "NPD plugin {{ $labels.check_name }} is timing out frequently"
```

### Grafana Dashboard Queries

```promql
# OOM kill rate across cluster
sum by (node) (rate(npd_log_monitor_errors_found_total{reason="OOMKilling"}[5m]))

# Nodes with active problem conditions
count by (condition) (
  kube_node_status_condition{
    condition=~"KernelDeadlock|NFSConnectivity|DiskPerformanceDegraded|GPUUnhealthy",
    status="true"
  } == 1
)

# Plugin check success rate
sum by (check_name) (
  rate(npd_custom_plugin_check_count{status="success"}[5m])
) /
sum by (check_name) (
  rate(npd_custom_plugin_check_count[5m])
)
```

## Summary

Node Problem Detector extends Kubernetes' native health monitoring to cover the full spectrum of node-level issues:

1. **Built-in detectors** for kernel panics, kernel deadlocks, OOM kills, task hangs, and readonly filesystem remounts provide immediate value with zero custom configuration.

2. **Custom plugin monitors** enable domain-specific health checks—NFS mount availability, disk I/O performance, memory fragmentation, GPU health—surfaced as first-class Kubernetes NodeConditions.

3. **NodeConditions** persist problem state on the Node object, making it visible to schedulers, operators, and observability systems—enabling automatic taint application to prevent new workloads from landing on unhealthy nodes.

4. **NodeEvents** provide transient records of detected problems for audit trails and alerting, even when they don't warrant a persistent condition.

5. **The Remedy Controller pattern** transforms detected conditions into automated responses—cordoning, draining, and repair actions—closing the loop from detection to remediation without human intervention for well-understood failure modes.

The combination of NPD with kube-state-metrics (for `kube_node_status_condition` metrics), Prometheus alerting, and a Remedy Controller creates a complete node lifecycle management pipeline that can detect, classify, and remediate a wide range of infrastructure failures in production Kubernetes clusters.
