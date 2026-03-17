---
title: "Kubernetes Node Problem Detector: Hardware and OS Issue Detection"
date: 2029-07-20T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "NPD", "Observability", "Hardware", "Node Health"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to Kubernetes Node Problem Detector covering NPD architecture, custom plugin scripts, condition types, remedy controller integration, GPU node monitoring, and cloud provider integration for production clusters."
more_link: "yes"
url: "/kubernetes-node-problem-detector-hardware-os-detection/"
---

Kubernetes is excellent at detecting and recovering from application-level failures, but it has no built-in mechanism for detecting hardware failures, OS-level corruption, kernel bugs, or disk errors on nodes. A node can be running and Ready while simultaneously suffering from a failing NVMe drive, ECC memory errors, or a hung filesystem — and your pods will silently fail or hang until someone notices. Node Problem Detector (NPD) fills this gap by monitoring system logs and metrics on each node, surfacing problems as node conditions and events that Kubernetes can act on.

<!--more-->

# Kubernetes Node Problem Detector: Hardware and OS Issue Detection

## Section 1: NPD Architecture

Node Problem Detector runs as a DaemonSet on every node. Each NPD pod reads system logs and metrics, evaluates them against configurable rules, and reports findings through two channels:

1. **Node Conditions**: persistent conditions on the Node object (e.g., `KernelDeadlock: True`) that the scheduler and controllers can observe
2. **Node Events**: ephemeral events visible via `kubectl get events --field-selector involvedObject.kind=Node`

### NPD Components

```
┌─────────────────────────────────────────────────────────┐
│                    NPD Pod (per node)                   │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────┐   │
│  │  Problem Daemon  │    │     Problem Client        │   │
│  │  (log monitor)   │───>│  (patches Node object)    │   │
│  │  (custom plugins)│    │  (emits events)           │   │
│  └─────────────────┘    └──────────────────────────┘   │
│          │                                               │
│  ┌───────▼────────────────────────────────────────┐    │
│  │  Monitored Sources                              │    │
│  │  /var/log/kern.log (kernel logs via syslog)    │    │
│  │  /dev/kmsg (kernel ring buffer)                │    │
│  │  journald (systemd journal)                    │    │
│  │  Custom scripts (hardware checks)              │    │
│  └────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
         │
         ▼ patches
┌─────────────────────────────┐
│  Node Object (Kubernetes)   │
│  conditions:                │
│  - KernelDeadlock: True     │
│  - ReadonlyFilesystem: True │
│  - DiskPressure: False      │
└─────────────────────────────┘
```

### Node Condition vs Event

```yaml
# Node condition (persistent, survives pod restarts)
apiVersion: v1
kind: Node
metadata:
  name: worker-node-1
status:
  conditions:
  - type: KernelDeadlock
    status: "True"
    lastHeartbeatTime: "2029-07-20T15:04:05Z"
    lastTransitionTime: "2029-07-20T14:00:00Z"
    reason: KernelHasDeadlock
    message: "kernel: task hung in state D more than 120 seconds"
  - type: ReadonlyFilesystem
    status: "False"
    lastHeartbeatTime: "2029-07-20T15:04:05Z"
    reason: FilesystemIsNotReadOnly
    message: ""
```

## Section 2: Installing NPD

```yaml
# npd-namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: node-problem-detector
```

```yaml
# npd-serviceaccount.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: node-problem-detector
  namespace: node-problem-detector
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
  namespace: node-problem-detector
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
  verbs: ["patch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch", "update"]
```

```yaml
# npd-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-problem-detector
  namespace: node-problem-detector
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
      hostNetwork: true
      hostPID: true
      tolerations:
      - operator: Exists
        effect: NoSchedule
      - operator: Exists
        effect: NoExecute
      priorityClassName: system-node-critical
      containers:
      - name: node-problem-detector
        image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.19
        command:
        - /node-problem-detector
        - --logtostderr
        - --system-log-monitors=/config/kernel-monitor.json,/config/docker-monitor.json
        - --custom-plugin-monitors=/config/custom-plugins/disk-monitor.json,/config/custom-plugins/mem-monitor.json
        - --prometheus-address=0.0.0.0
        - --prometheus-port=20257
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        resources:
          limits:
            cpu: 100m
            memory: 80Mi
          requests:
            cpu: 20m
            memory: 32Mi
        securityContext:
          privileged: true
        volumeMounts:
        - name: log
          mountPath: /var/log
          readOnly: true
        - name: kmsg
          mountPath: /dev/kmsg
          readOnly: true
        - name: config
          mountPath: /config
          readOnly: true
        - name: host-proc
          mountPath: /host/proc
          readOnly: true
        ports:
        - containerPort: 20257
          name: prometheus
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
      - name: host-proc
        hostPath:
          path: /proc
```

## Section 3: Configuration and Condition Types

### Kernel Monitor Configuration

```json
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
      "message": "filesystem is not read-only"
    },
    {
      "type": "CorruptDockerOverlay2",
      "reason": "NoCorruptDockerOverlay2",
      "message": "docker overlay2 is functioning properly"
    },
    {
      "type": "OOMKilling",
      "reason": "NoOOMKilling",
      "message": "kernel has no OOM killing"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "OOMKilling",
      "pattern": "Kill process \\d+ (.+) score \\d+ or sacrifice child"
    },
    {
      "type": "temporary",
      "reason": "TaskHung",
      "pattern": "task .{1,32} blocked for more than [0-9]+ seconds\\."
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "AUFSUmountHung",
      "pattern": "unregister_netdevice: waiting for .+ to become free. Usage count = [0-9]+"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "DockerHung",
      "pattern": "task .+:.+ blocked for more than [0-9]+ seconds\\."
    },
    {
      "type": "permanent",
      "condition": "ReadonlyFilesystem",
      "reason": "FilesystemIsReadOnly",
      "pattern": "EXT4-fs error .* remounting filesystem read-only"
    },
    {
      "type": "permanent",
      "condition": "ReadonlyFilesystem",
      "reason": "XFSFilesystemReadOnly",
      "pattern": "XFS.*filesystem is now read-only"
    },
    {
      "type": "permanent",
      "condition": "CorruptDockerOverlay2",
      "reason": "CorruptDockerOverlay2",
      "pattern": "Error processing tar file|invalid tar header"
    },
    {
      "type": "temporary",
      "reason": "NUMAMemoryError",
      "pattern": "HARDWARE ERROR.*MEMORY CONTROLLER.*ECC"
    },
    {
      "type": "permanent",
      "condition": "OOMKilling",
      "reason": "SystemOOM",
      "pattern": "Out of memory: Kill process|oom-kill:constraint=CONSTRAINT_NONE"
    }
  ]
}
```

### Docker/containerd Monitor

```json
{
  "plugin": "journald",
  "pluginConfig": {
    "source": "docker"
  },
  "logPath": "/var/log/journal",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "docker-monitor",
  "conditions": [
    {
      "type": "ContainerRuntimeUnhealthy",
      "reason": "ContainerRuntimeIsHealthy",
      "message": "container runtime on the node is functioning properly"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "ContainerRuntimeUnhealthy",
      "reason": "ContainerdUnhealthy",
      "pattern": "failed to start containerd daemon"
    },
    {
      "type": "temporary",
      "reason": "ContainerdStartupError",
      "pattern": "level=fatal.*containerd"
    },
    {
      "type": "temporary",
      "reason": "CNIError",
      "pattern": "CNI .* failed to set up pod .* network"
    }
  ]
}
```

## Section 4: Custom Plugin Scripts

Custom plugins execute shell scripts or binaries to detect problems that cannot be found by log pattern matching. They return exit code 0 (healthy) or non-zero (problem detected).

### Custom Plugin Configuration

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "30s",
    "timeout": "5s",
    "max_output_length": 80,
    "concurrency": 3
  },
  "source": "disk-monitor",
  "skipInitialStatus": true,
  "metricsReporting": true,
  "conditions": [
    {
      "type": "DiskHung",
      "reason": "NoDiskHung",
      "message": "disk is not hung"
    },
    {
      "type": "DiskReadonly",
      "reason": "DiskNotReadonly",
      "message": "disk is not read-only"
    },
    {
      "type": "DiskSlow",
      "reason": "DiskIsNotSlow",
      "message": "disk IO latency is within normal range"
    },
    {
      "type": "InodePressure",
      "reason": "NoInodePressure",
      "message": "no inode pressure"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "DiskHung",
      "reason": "HungTask",
      "path": "/config/custom-plugins/check-disk-hung.sh"
    },
    {
      "type": "permanent",
      "condition": "DiskReadonly",
      "reason": "ReadonlyMount",
      "path": "/config/custom-plugins/check-disk-readonly.sh"
    },
    {
      "type": "permanent",
      "condition": "DiskSlow",
      "reason": "HighIOLatency",
      "path": "/config/custom-plugins/check-disk-latency.sh"
    },
    {
      "type": "permanent",
      "condition": "InodePressure",
      "reason": "InodePressure",
      "path": "/config/custom-plugins/check-inode-pressure.sh"
    }
  ]
}
```

### check-disk-hung.sh

```bash
#!/bin/bash
# Check for hung disk IO — processes in D state waiting for disk
# Exit 0: healthy, Exit 1: problem, Exit 2: unknown

readonly TIMEOUT_SECONDS=30
readonly PROBLEM_OUTPUT_PREFIX="[D]"

count=0
while IFS= read -r line; do
    # Count processes in uninterruptible sleep (D state)
    state=$(echo "$line" | awk '{print $3}')
    if [[ "$state" == "D" ]]; then
        wchan=$(cat "/proc/$(echo "$line" | awk '{print $1}')/wchan" 2>/dev/null)
        # Check if wchan indicates disk wait
        if [[ "$wchan" == *"io"* ]] || [[ "$wchan" == *"disk"* ]] || \
           [[ "$wchan" == *"blk"* ]] || [[ "$wchan" == *"scsi"* ]]; then
            count=$((count + 1))
        fi
    fi
done < <(ps aux --no-headers 2>/dev/null)

if [[ "$count" -gt 5 ]]; then
    echo "${PROBLEM_OUTPUT_PREFIX} ${count} processes hung waiting for disk IO"
    exit 1
fi

# Check kernel log for io_schedule_timeout
hung=$(dmesg --time-format=notime 2>/dev/null | grep -c "io_schedule_timeout" || echo 0)
if [[ "$hung" -gt 0 ]]; then
    echo "${PROBLEM_OUTPUT_PREFIX} io_schedule_timeout detected in dmesg"
    exit 1
fi

exit 0
```

### check-disk-latency.sh

```bash
#!/bin/bash
# Measure actual disk IO latency using dd
# Exit 0: <50ms, Exit 1: >200ms (slow), Exit 2: error

readonly TEST_FILE="/tmp/npd-disk-test-$$"
readonly HIGH_LATENCY_MS=200
readonly WARN_LATENCY_MS=50

cleanup() {
    rm -f "$TEST_FILE"
}
trap cleanup EXIT

# Write 1 MB and measure latency
start_ns=$(date +%s%N)
if ! dd if=/dev/zero of="$TEST_FILE" bs=1M count=1 conv=fdatasync 2>/dev/null; then
    echo "[E] dd write failed — disk may be read-only or full"
    exit 2
fi
end_ns=$(date +%s%N)

latency_ms=$(( (end_ns - start_ns) / 1000000 ))

if [[ "$latency_ms" -gt "$HIGH_LATENCY_MS" ]]; then
    echo "[D] Disk write latency ${latency_ms}ms exceeds threshold ${HIGH_LATENCY_MS}ms"
    exit 1
fi

if [[ "$latency_ms" -gt "$WARN_LATENCY_MS" ]]; then
    echo "[W] Disk write latency ${latency_ms}ms is elevated"
    exit 0  # Warning only, not a problem condition
fi

exit 0
```

### check-inode-pressure.sh

```bash
#!/bin/bash
# Check inode usage across all mounted filesystems
# Exit 1 if any filesystem is >90% inode usage

readonly THRESHOLD_PCT=90

while IFS= read -r line; do
    # Parse df -i output
    pct=$(echo "$line" | awk '{print $5}' | tr -d '%')
    mount=$(echo "$line" | awk '{print $6}')

    # Skip tmpfs, proc, sys etc.
    fstype=$(findmnt -n -o FSTYPE "$mount" 2>/dev/null)
    case "$fstype" in
        tmpfs|proc|sysfs|devtmpfs|cgroup*|overlay) continue ;;
    esac

    if [[ -n "$pct" ]] && [[ "$pct" =~ ^[0-9]+$ ]]; then
        if [[ "$pct" -ge "$THRESHOLD_PCT" ]]; then
            echo "[D] Inode pressure on ${mount}: ${pct}% inodes used"
            exit 1
        fi
    fi
done < <(df -i 2>/dev/null | tail -n +2)

exit 0
```

### Memory ECC Custom Plugin

```bash
#!/bin/bash
# check-memory-ecc.sh
# Check EDAC (Error Detection and Correction) for memory errors
# Requires edac-utils to be installed on the host

readonly MAX_CE_PER_HOUR=100  # Correctable error threshold
readonly PROBLEM_PREFIX="[D]"

# Check if EDAC is available
if [[ ! -d /sys/bus/platform/drivers/ie31200_edac ]] && \
   [[ ! -d /sys/devices/system/edac ]]; then
    exit 0  # EDAC not available — skip silently
fi

# Check correctable errors
total_ce=0
for ce_file in /sys/devices/system/edac/mc/mc*/csrow*/ch*_ce_count; do
    [[ -r "$ce_file" ]] || continue
    count=$(cat "$ce_file" 2>/dev/null || echo 0)
    total_ce=$((total_ce + count))
done

# Check uncorrectable errors (any UE is critical)
total_ue=0
for ue_file in /sys/devices/system/edac/mc/mc*/ue_count; do
    [[ -r "$ue_file" ]] || continue
    count=$(cat "$ue_file" 2>/dev/null || echo 0)
    total_ue=$((total_ue + count))
done

if [[ "$total_ue" -gt 0 ]]; then
    echo "${PROBLEM_PREFIX} CRITICAL: ${total_ue} uncorrectable ECC memory errors detected"
    exit 1
fi

# For correctable errors, check rate (persist last count in tmpfs)
state_file="/tmp/npd-ecc-last-ce"
if [[ -f "$state_file" ]]; then
    last_ce=$(cat "$state_file")
    last_time=$(stat -c %Y "$state_file")
    now=$(date +%s)
    elapsed_hours=$(( (now - last_time) / 3600 ))
    if [[ "$elapsed_hours" -gt 0 ]]; then
        rate=$(( (total_ce - last_ce) / elapsed_hours ))
        if [[ "$rate" -gt "$MAX_CE_PER_HOUR" ]]; then
            echo "${PROBLEM_PREFIX} High correctable ECC error rate: ${rate}/hour (threshold: ${MAX_CE_PER_HOUR}/hour)"
            exit 1
        fi
    fi
fi

echo "$total_ce" > "$state_file"
exit 0
```

## Section 5: GPU Node Problem Detection

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "60s",
    "timeout": "30s",
    "max_output_length": 200,
    "concurrency": 1
  },
  "source": "gpu-monitor",
  "skipInitialStatus": false,
  "conditions": [
    {
      "type": "GPUHealthy",
      "reason": "GPUIsHealthy",
      "message": "all GPUs are healthy"
    },
    {
      "type": "GPUXidError",
      "reason": "NoGPUXidError",
      "message": "no GPU Xid errors detected"
    },
    {
      "type": "GPUMemoryError",
      "reason": "NoGPUMemoryError",
      "message": "no GPU memory errors detected"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "GPUHealthy",
      "reason": "GPUNotHealthy",
      "path": "/config/custom-plugins/check-gpu-health.sh"
    },
    {
      "type": "permanent",
      "condition": "GPUXidError",
      "reason": "GPUXidError",
      "path": "/config/custom-plugins/check-gpu-xid.sh"
    }
  ]
}
```

```bash
#!/bin/bash
# check-gpu-health.sh
# Uses nvidia-smi to verify all GPUs are healthy
# Requires nvidia-smi on the node (installed by nvidia-driver)

readonly PROBLEM_PREFIX="[D]"

# Check if nvidia-smi is available
if ! command -v nvidia-smi &>/dev/null; then
    exit 0  # Not a GPU node
fi

# Check overall GPU status
output=$(nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,ecc.errors.corrected.volatile.total,ecc.errors.uncorrected.volatile.total,gpu_bus_id --format=csv,noheader,nounits 2>&1)

if [[ $? -ne 0 ]]; then
    echo "${PROBLEM_PREFIX} nvidia-smi failed: ${output}"
    exit 1
fi

problem_found=0
while IFS=',' read -r idx name temp util ce ue bus; do
    idx=$(echo "$idx" | xargs)
    name=$(echo "$name" | xargs)
    ue=$(echo "$ue" | xargs)
    ce=$(echo "$ce" | xargs)

    if [[ "$ue" =~ ^[0-9]+$ ]] && [[ "$ue" -gt 0 ]]; then
        echo "${PROBLEM_PREFIX} GPU${idx} (${name}): ${ue} uncorrectable ECC errors"
        problem_found=1
    fi
done <<< "$output"

# Check for GPU not found in nvidia-smi vs expected count
expected_gpus=$(ls /dev/nvidia[0-9]* 2>/dev/null | wc -l)
actual_gpus=$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | wc -l)

if [[ "$actual_gpus" -lt "$expected_gpus" ]]; then
    echo "${PROBLEM_PREFIX} GPU count mismatch: expected ${expected_gpus}, detected ${actual_gpus}"
    problem_found=1
fi

exit $problem_found
```

```bash
#!/bin/bash
# check-gpu-xid.sh
# Check kernel logs for NVIDIA Xid errors (GPU hardware errors)

readonly PROBLEM_PREFIX="[D]"

# Critical Xid errors that indicate hardware failure
# Xid 13: Graphics Engine Exception
# Xid 31: GPU memory page fault
# Xid 38: Driver firmware error
# Xid 48: Double Bit ECC Error (unrecoverable)
# Xid 74: NVLINK Error
# Xid 79: GPU has fallen off the bus
CRITICAL_XIDs="13|31|38|48|74|79"

# Check dmesg from the last hour
recent_xids=$(dmesg --time-format=iso --since "1 hour ago" 2>/dev/null | \
    grep -E "NVRM: Xid .* (${CRITICAL_XIDs})" | tail -5)

if [[ -n "$recent_xids" ]]; then
    echo "${PROBLEM_PREFIX} Critical GPU Xid error detected: $(echo "$recent_xids" | head -1)"
    exit 1
fi

exit 0
```

## Section 6: Remedy Controller Integration

The Remedy Controller automatically takes remediation actions when NPD sets a problem condition. Common remedies include draining and cordoning nodes.

```yaml
# remedy-controller-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: remedy-controller
rules:
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list", "watch", "patch", "update"]
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "delete"]
- apiGroups: ["apps"]
  resources: ["daemonsets"]
  verbs: ["get"]
---
# Remedy ConfigMap — maps conditions to actions
apiVersion: v1
kind: ConfigMap
metadata:
  name: remedy-config
  namespace: node-problem-detector
data:
  config.yaml: |
    rules:
    - name: cordon-kernel-deadlock
      conditions:
      - type: KernelDeadlock
        status: "True"
      actions:
      - type: Cordon
        params:
          message: "Node cordoned by remedy controller: KernelDeadlock"
      - type: TaintNode
        params:
          key: node.kubernetes.io/problem
          value: KernelDeadlock
          effect: NoSchedule

    - name: drain-readonly-filesystem
      conditions:
      - type: ReadonlyFilesystem
        status: "True"
      actions:
      - type: Cordon
      - type: DrainNode
        params:
          grace_period: 30
          ignore_daemonsets: true
          delete_emptydir: false

    - name: cordon-gpu-failure
      conditions:
      - type: GPUHealthy
        status: "False"
      actions:
      - type: Cordon
        params:
          message: "GPU hardware failure detected"
      - type: TaintNode
        params:
          key: nvidia.com/gpu
          value: "unhealthy"
          effect: NoSchedule
```

### Custom Remedy Operator

```go
// remedy/controller.go
package remedy

import (
	"context"
	"fmt"
	"log/slog"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
)

type RemedyRule struct {
	Name       string
	Conditions []ConditionMatch
	Actions    []RemedyAction
}

type ConditionMatch struct {
	Type   string
	Status string
}

type RemedyAction struct {
	Type   string
	Params map[string]string
}

type RemedyReconciler struct {
	client    client.Client
	clientset kubernetes.Interface
	rules     []RemedyRule
	logger    *slog.Logger
}

func (r *RemedyReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	var node corev1.Node
	if err := r.client.Get(ctx, req.NamespacedName, &node); err != nil {
		return reconcile.Result{}, client.IgnoreNotFound(err)
	}

	for _, rule := range r.rules {
		if r.matchesConditions(&node, rule.Conditions) {
			r.logger.Info("remedy rule triggered",
				"node", node.Name,
				"rule", rule.Name,
			)
			if err := r.applyActions(ctx, &node, rule.Actions); err != nil {
				r.logger.Error("remedy action failed",
					"node", node.Name,
					"rule", rule.Name,
					"error", err,
				)
			}
		}
	}

	return reconcile.Result{}, nil
}

func (r *RemedyReconciler) matchesConditions(node *corev1.Node, conditions []ConditionMatch) bool {
	for _, match := range conditions {
		found := false
		for _, cond := range node.Status.Conditions {
			if string(cond.Type) == match.Type && string(cond.Status) == match.Status {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return len(conditions) > 0
}

func (r *RemedyReconciler) applyActions(ctx context.Context, node *corev1.Node, actions []RemedyAction) error {
	for _, action := range actions {
		switch action.Type {
		case "Cordon":
			if err := r.cordonNode(ctx, node); err != nil {
				return fmt.Errorf("cordon node: %w", err)
			}
		case "TaintNode":
			if err := r.taintNode(ctx, node, action.Params); err != nil {
				return fmt.Errorf("taint node: %w", err)
			}
		default:
			r.logger.Warn("unknown remedy action", "type", action.Type)
		}
	}
	return nil
}

func (r *RemedyReconciler) cordonNode(ctx context.Context, node *corev1.Node) error {
	if node.Spec.Unschedulable {
		return nil // Already cordoned
	}
	patch := []byte(`{"spec":{"unschedulable":true}}`)
	_, err := r.clientset.CoreV1().Nodes().Patch(
		ctx, node.Name, types.MergePatchType, patch, metav1.PatchOptions{})
	return err
}

func (r *RemedyReconciler) taintNode(ctx context.Context, node *corev1.Node, params map[string]string) error {
	taint := corev1.Taint{
		Key:    params["key"],
		Value:  params["value"],
		Effect: corev1.TaintEffect(params["effect"]),
	}

	for _, existing := range node.Spec.Taints {
		if existing.Key == taint.Key {
			return nil // Already tainted
		}
	}

	node.Spec.Taints = append(node.Spec.Taints, taint)
	return r.client.Update(ctx, node)
}
```

## Section 7: Cloud Provider Integration

### AWS Integration — EC2 Instance Health

```bash
#!/bin/bash
# check-aws-instance-health.sh
# Check EC2 instance health status via IMDSv2

readonly PROBLEM_PREFIX="[D]"
readonly METADATA_TOKEN_URL="http://169.254.169.254/latest/api/token"
readonly METADATA_BASE="http://169.254.169.254/latest/meta-data"

# Get IMDSv2 token
TOKEN=$(curl -sf -X PUT "${METADATA_TOKEN_URL}" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null)

if [[ -z "$TOKEN" ]]; then
    exit 0  # Not running on EC2
fi

curl_metadata() {
    curl -sf -H "X-aws-ec2-metadata-token: ${TOKEN}" "${METADATA_BASE}/$1"
}

INSTANCE_ID=$(curl_metadata "instance-id")
REGION=$(curl_metadata "placement/region")

if [[ -z "$INSTANCE_ID" ]]; then
    exit 0
fi

# Check EC2 instance health via AWS CLI
STATUS=$(aws ec2 describe-instance-status \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --query "InstanceStatuses[0].[InstanceStatus.Status,SystemStatus.Status]" \
    --output text 2>/dev/null)

if [[ -z "$STATUS" ]]; then
    exit 0
fi

instance_status=$(echo "$STATUS" | awk '{print $1}')
system_status=$(echo "$STATUS" | awk '{print $2}')

if [[ "$instance_status" == "impaired" ]] || [[ "$system_status" == "impaired" ]]; then
    echo "${PROBLEM_PREFIX} EC2 instance health check failed: instance=${instance_status} system=${system_status}"
    exit 1
fi

exit 0
```

## Section 8: Monitoring NPD with Prometheus

```yaml
# prometheus-npd-rules.yaml
groups:
  - name: node_problem_detector
    rules:
      - alert: NodeKernelDeadlock
        expr: kube_node_status_condition{condition="KernelDeadlock",status="true"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Kernel deadlock on node {{ $labels.node }}"
          description: "Node {{ $labels.node }} has a kernel deadlock condition"
          runbook: "https://runbooks.support.tools/node-kernel-deadlock"

      - alert: NodeReadonlyFilesystem
        expr: kube_node_status_condition{condition="ReadonlyFilesystem",status="true"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Read-only filesystem on node {{ $labels.node }}"
          description: "Filesystem on node {{ $labels.node }} has become read-only"

      - alert: NodeGPUUnhealthy
        expr: kube_node_status_condition{condition="GPUHealthy",status="false"} == 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "GPU unhealthy on node {{ $labels.node }}"

      - alert: NodeDiskSlow
        expr: kube_node_status_condition{condition="DiskSlow",status="true"} == 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Disk slow on node {{ $labels.node }}"

      - alert: NodeInodePressure
        expr: kube_node_status_condition{condition="InodePressure",status="true"} == 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Inode pressure on node {{ $labels.node }}"
```

## Section 9: Deploying with Helm

```yaml
# values for node-problem-detector Helm chart
# helm repo add node-problem-detector https://raw.githubusercontent.com/deliveryhero/helm-charts/master/stable
# helm install npd node-problem-detector/node-problem-detector -f values.yaml

image:
  repository: registry.k8s.io/node-problem-detector/node-problem-detector
  tag: v0.8.19
  pullPolicy: IfNotPresent

metrics:
  enabled: true
  port: 20257
  serviceMonitor:
    enabled: true
    namespace: monitoring
    interval: 30s

settings:
  log_monitors:
    - /config/kernel-monitor.json
    - /config/docker-monitor.json
  custom_plugin_monitors:
    - /config/custom-plugins/disk-monitor.json
    - /config/custom-plugins/gpu-monitor.json
    - /config/custom-plugins/mem-monitor.json

extraVolumes:
  - name: kmsg
    hostPath:
      path: /dev/kmsg

extraVolumeMounts:
  - name: kmsg
    mountPath: /dev/kmsg
    readOnly: true

tolerations:
  - key: node-role.kubernetes.io/control-plane
    operator: Exists
    effect: NoSchedule
  - operator: Exists
    effect: NoExecute
  - operator: Exists
    effect: NoSchedule

resources:
  limits:
    cpu: 100m
    memory: 100Mi
  requests:
    cpu: 20m
    memory: 32Mi

priorityClassName: system-node-critical

securityContext:
  privileged: true
```

## Section 10: Troubleshooting NPD

```bash
# Check NPD pod status
kubectl get pods -n node-problem-detector -o wide

# View NPD logs for a specific node
kubectl logs -n node-problem-detector \
    $(kubectl get pod -n node-problem-detector -o jsonpath='{.items[0].metadata.name}') \
    --tail=100 --follow

# Check current node conditions set by NPD
kubectl get nodes -o json | jq '.items[].status.conditions[] | select(.type | test("Kernel|Readonly|GPU|Disk|Inode"))'

# Manually simulate a problem to test condition reporting
kubectl debug node/worker-node-1 -it --image=busybox -- sh
# Inside debug container:
# cat /host/dev/kmsg  # view kernel messages
# echo "task test:0 blocked for more than 120 seconds." > /dev/kmsg  # inject test message

# Verify custom plugin script
kubectl exec -n node-problem-detector <npd-pod> -- /config/custom-plugins/check-disk-latency.sh
echo "Exit code: $?"

# Check events generated by NPD
kubectl get events --field-selector involvedObject.kind=Node --all-namespaces \
    --sort-by='.lastTimestamp' | tail -20

# Check NPD metrics
kubectl port-forward -n node-problem-detector <npd-pod> 20257:20257
curl http://localhost:20257/metrics | grep -E "problem_counter|problem_gauge"
```

## Section 11: Best Practices and Production Checklist

```
NPD Production Checklist:

Installation:
  [ ] NPD deployed as DaemonSet with system-node-critical priority class
  [ ] Tolerations for all node taints including NoExecute
  [ ] hostNetwork: true for direct kernel access
  [ ] Privileged security context for /dev/kmsg access
  [ ] Resource limits set (100m CPU, 100Mi RAM)

Configuration:
  [ ] Kernel monitor enabled for deadlock and readonly filesystem detection
  [ ] Custom disk plugin with latency threshold appropriate for storage type
  [ ] Inode pressure check configured (threshold at 85-90%)
  [ ] GPU check deployed on GPU node pools only
  [ ] Memory ECC check deployed on bare-metal nodes

Alerting:
  [ ] PagerDuty/OpsGenie alerts for critical conditions (KernelDeadlock, ReadonlyFilesystem)
  [ ] Slack notifications for warning conditions (DiskSlow, InodePressure)
  [ ] Prometheus rules deployed with proper severity labels

Remediation:
  [ ] Remedy controller deployed to auto-cordon problem nodes
  [ ] Taint applied to prevent new scheduling on problem nodes
  [ ] Runbooks created for each condition type
  [ ] Escalation path defined for GPU failures

Testing:
  [ ] Verify each custom script returns correct exit codes
  [ ] Test condition propagation with simulated kernel messages
  [ ] Verify remedy controller cordon action
  [ ] Test on all node types (general, GPU, high-memory)
```
