---
title: "Kubernetes Node Problem Detector and Cluster Autoscaler Integration for Automated Remediation"
date: 2031-07-04T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "Cluster Autoscaler", "SRE", "Automated Remediation", "Observability"]
categories: ["Kubernetes", "SRE"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Learn how to deploy and configure the Kubernetes Node Problem Detector to surface node health issues as events and conditions, integrate with the Cluster Autoscaler for automated node replacement, and build custom problem detectors for enterprise environments."
more_link: "yes"
url: "/kubernetes-node-problem-detector-cluster-autoscaler-automated-remediation/"
---

Kubernetes nodes fail in ways that the kubelet cannot detect: kernel bugs, disk I/O errors, OOM events outside of cgroup limits, hardware failures, and network interface degradation. These failures cause workloads to silently degrade or hang while the scheduler continues placing new pods on the broken node. Node Problem Detector (NPD) fills this gap by monitoring system logs, kernel messages, and custom health scripts, surfacing problems as Node Conditions and Events that drive automated remediation.

<!--more-->

# Kubernetes Node Problem Detector and Cluster Autoscaler Integration for Automated Remediation

## Why Node Problem Detector Exists

The kubelet's built-in health checks verify that the kubelet itself is running and that containers can be started. They do not detect:

- Kernel OOM events in processes outside Kubernetes cgroups
- NFS mount failures that cause pod I/O to hang
- Disk full events on non-pod volumes
- Network driver errors causing packet loss
- GPU failures on nodes running ML workloads
- Time synchronization drift

Without NPD, these failures are discovered only when users report problems, often hours after the node began degrading. NPD watches system logs, kernel messages, and custom scripts, converting detected problems into:

1. **Node Conditions**: Long-lived status indicators (e.g., `KernelDeadlock=True`)
2. **Node Events**: Point-in-time events attached to the Node object

The Cluster Autoscaler and node remediation controllers watch these conditions to automatically cordon, drain, and replace affected nodes.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                       Kubernetes Node                    │
│                                                          │
│  ┌─────────────────┐    ┌──────────────────────────────┐│
│  │  Node Problem   │───▶│  Node Conditions             ││
│  │  Detector       │    │  - KernelDeadlock            ││
│  │  (DaemonSet)    │    │  - ReadonlyFilesystem        ││
│  │                 │    │  - DiskPressure              ││
│  │  Plugin types:  │    │  - NetworkUnavailable        ││
│  │  - SystemLogMonitor │  └──────────────────────────────┘│
│  │  - KernelMonitor│    ┌──────────────────────────────┐│
│  │  - CustomPlugin │───▶│  Node Events                 ││
│  └─────────────────┘    │  - OOMKilling                ││
│         │               │  - FilesystemCorruption      ││
│         ▼               └──────────────────────────────┘│
│  /var/log/kern.log                                       │
│  /dev/kmsg                                               │
│  Custom health scripts                                   │
└─────────────────────────────────────────────────────────┘
                  │
                  ▼ Node Conditions
┌──────────────────────────────────────────────────────────┐
│  Cluster Autoscaler                                      │
│  - Treats unhealthy nodes as scale-down candidates       │
│  - Will not scale up with unhealthy node templates       │
└──────────────────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────┐
│  Node Auto Repair (Kured, MachineHealthCheck)            │
│  - Watches for problem conditions                        │
│  - Cordons, drains, and replaces nodes                   │
└──────────────────────────────────────────────────────────┘
```

## Deploying Node Problem Detector

### Helm Deployment

```bash
helm repo add deliveryhero https://charts.deliveryhero.io/
helm repo update

helm install node-problem-detector deliveryhero/node-problem-detector \
  --namespace kube-system \
  --values npd-values.yaml
```

```yaml
# npd-values.yaml
image:
  repository: registry.k8s.io/node-problem-detector/node-problem-detector
  tag: "v0.8.18"
  pullPolicy: IfNotPresent

updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1

# Resource allocation
resources:
  requests:
    cpu: 20m
    memory: 20Mi
  limits:
    cpu: 200m
    memory: 100Mi

# Required to access host logs and kernel messages
hostPID: true
hostNetwork: false

# Required volumes for log access
volumeMounts:
- name: log
  mountPath: /var/log
  readOnly: true
- name: kmsg
  mountPath: /dev/kmsg
  readOnly: true
- name: localtime
  mountPath: /etc/localtime
  readOnly: true

volumes:
- name: log
  hostPath:
    path: /var/log
- name: kmsg
  hostPath:
    path: /dev/kmsg
    type: CharDevice
- name: localtime
  hostPath:
    path: /etc/localtime

# Security context
securityContext:
  privileged: true

serviceAccount:
  create: true
  name: node-problem-detector

# Prometheus metrics
metrics:
  enabled: true
  port: 20257

settings:
  log_monitors:
  - /config/kernel-monitor.json
  - /config/docker-monitor.json
  - /config/systemd-monitor.json
  custom_plugin_monitors:
  - /config/custom-plugin-monitor.json
```

### RBAC

```yaml
# npd-rbac.yaml
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
  verbs: ["get", "patch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: node-problem-detector
subjects:
- kind: ServiceAccount
  name: node-problem-detector
  namespace: kube-system
roleRef:
  kind: ClusterRole
  name: node-problem-detector
  apiGroup: rbac.authorization.k8s.io
```

## Built-in Monitor Configuration

### Kernel Monitor

The kernel monitor watches `/dev/kmsg` (kernel message ring buffer) for patterns indicating problems:

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
      "reason": "FilesystemIsReadWrite",
      "message": "Filesystem is not read-only"
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
      "pattern": "task \\S+:\\w+ blocked for more than \\w+ seconds"
    },
    {
      "type": "temporary",
      "reason": "UnregisterNetDevice",
      "pattern": "unregister_netdevice: waiting for \\S+ to become free. Usage count = \\d+"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "AUFSUmountHung",
      "pattern": "task umount\\.aufs:\\w+ blocked for more than \\w+ seconds"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "DockerHung",
      "pattern": "task docker:\\w+ blocked for more than \\w+ seconds"
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

### System Log Monitor

The system log monitor watches `/var/log/syslog` or `/var/log/messages`:

```json
{
  "plugin": "filelog",
  "pluginConfig": {
    "timestamp": "^time=\"(\\S+)\"",
    "message": "msg=\"([^\"]+)\"",
    "logPath": "/var/log/syslog"
  },
  "logPath": "/var/log/syslog",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "syslog-monitor",
  "conditions": [
    {
      "type": "NTPProblem",
      "reason": "NTPIsSync",
      "message": "NTP sync is normal"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "NTPProblem",
      "reason": "NTPSyncFailed",
      "pattern": "ntpd.*time sync not possible"
    }
  ]
}
```

## Custom Plugin Monitor

Custom plugins run arbitrary scripts to check health conditions not covered by log monitoring. This is the most flexible mechanism.

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invokeInterval": "60s",
    "timeout": "30s",
    "maxOutputLength": 80,
    "concurrency": 1
  },
  "source": "custom-plugin-monitor",
  "skipInitialStatus": true,
  "conditions": [
    {
      "type": "NFSMountHealthy",
      "reason": "NFSMountIsHealthy",
      "message": "NFS mounts are healthy"
    },
    {
      "type": "DiskIOHealthy",
      "reason": "DiskIOIsHealthy",
      "message": "Disk I/O is healthy"
    },
    {
      "type": "ContainerRuntimeHealthy",
      "reason": "ContainerRuntimeIsHealthy",
      "message": "Container runtime is healthy"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "NFSMountHealthy",
      "reason": "NFSMountUnresponsive",
      "path": "/config/plugin/check_nfs_mounts.sh"
    },
    {
      "type": "permanent",
      "condition": "DiskIOHealthy",
      "reason": "DiskIOError",
      "path": "/config/plugin/check_disk_io.sh"
    },
    {
      "type": "permanent",
      "condition": "ContainerRuntimeHealthy",
      "reason": "ContainerRuntimeUnhealthy",
      "path": "/config/plugin/check_containerd.sh"
    }
  ]
}
```

### NFS Mount Health Check Plugin

```bash
#!/bin/bash
# /config/plugin/check_nfs_mounts.sh
# Exit codes:
#   0: healthy (condition = OK)
#   1: unhealthy (condition = problem detected)
#   2: unknown (condition unchanged)

set -euo pipefail

TIMEOUT=10
PROBLEM_FOUND=0

# Get all NFS mounts
NFS_MOUNTS=$(mount | grep -E '\bnfs[34]?\b' | awk '{print $3}' || true)

if [ -z "$NFS_MOUNTS" ]; then
    # No NFS mounts, nothing to check
    exit 0
fi

while IFS= read -r mount_point; do
    # Try to stat the mount point with a timeout
    if ! timeout "$TIMEOUT" stat "$mount_point" > /dev/null 2>&1; then
        echo "NFS mount unresponsive: $mount_point"
        PROBLEM_FOUND=1
        continue
    fi

    # Verify we can list files
    if ! timeout "$TIMEOUT" ls "$mount_point" > /dev/null 2>&1; then
        echo "NFS mount listing failed: $mount_point"
        PROBLEM_FOUND=1
    fi
done <<< "$NFS_MOUNTS"

exit $PROBLEM_FOUND
```

### Disk I/O Health Check Plugin

```bash
#!/bin/bash
# /config/plugin/check_disk_io.sh

set -euo pipefail

TEMP_FILE=$(mktemp /tmp/disk-io-check-XXXXX)
trap "rm -f $TEMP_FILE" EXIT

# Write test
if ! timeout 10 dd if=/dev/zero of="$TEMP_FILE" bs=4k count=256 oflag=direct 2>/dev/null; then
    echo "Disk write test failed on $(df $TEMP_FILE | tail -1 | awk '{print $1}')"
    exit 1
fi

# Read test
if ! timeout 10 dd if="$TEMP_FILE" of=/dev/null bs=4k iflag=direct 2>/dev/null; then
    echo "Disk read test failed"
    exit 1
fi

# Check for I/O errors in kernel logs
IO_ERRORS=$(dmesg --time-format reltime 2>/dev/null | grep -E "I/O error|blk_update_request|end_request.*error" | wc -l || echo 0)
if [ "$IO_ERRORS" -gt 5 ]; then
    echo "Elevated I/O error count in kernel log: $IO_ERRORS errors"
    exit 1
fi

exit 0
```

### Container Runtime Health Check

```bash
#!/bin/bash
# /config/plugin/check_containerd.sh

set -euo pipefail

# Check if containerd socket is responsive
if ! timeout 5 ctr version > /dev/null 2>&1; then
    echo "containerd is not responding to version query"
    exit 1
fi

# Check containerd service status
if ! systemctl is-active containerd > /dev/null 2>&1; then
    echo "containerd systemd service is not active"
    exit 1
fi

# Check for zombie containers (containers that failed to start/stop)
ZOMBIE_COUNT=$(ctr containers list 2>/dev/null | grep -c "zombie" || echo 0)
if [ "$ZOMBIE_COUNT" -gt 0 ]; then
    echo "Found $ZOMBIE_COUNT zombie containers"
    # Don't fail on zombie containers - just report
fi

exit 0
```

## Configuring the Cluster Autoscaler for NPD Integration

The Cluster Autoscaler treats nodes with certain conditions as unhealthy and will not count them as healthy capacity. It will also replace them if they are part of a node group.

```yaml
# cluster-autoscaler-deployment.yaml (relevant sections)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cluster-autoscaler
  namespace: kube-system
spec:
  template:
    spec:
      containers:
      - name: cluster-autoscaler
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.30.0
        command:
        - ./cluster-autoscaler
        - --cloud-provider=aws
        - --namespace=kube-system
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/my-cluster

        # Tell the autoscaler which Node Conditions indicate an unhealthy node
        # These conditions will cause the node to be treated as unschedulable
        - --status-config-map-name=cluster-autoscaler-status
        - --scale-down-enabled=true
        - --scale-down-delay-after-add=10m
        - --scale-down-unneeded-time=10m

        # Node conditions that indicate the node is unhealthy
        # The autoscaler treats nodes with these conditions as not ready
        - --node-deletion-delay-timeout=2m
```

The Cluster Autoscaler itself does not read NPD conditions directly. You need a remediation controller that watches NPD conditions and uses them to taint/drain nodes. Two options:

### Option 1: Machine Health Check (Cluster API)

```yaml
# machinehealthcheck.yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineHealthCheck
metadata:
  name: worker-mhc
  namespace: default
spec:
  clusterName: my-cluster
  selector:
    matchLabels:
      cluster.x-k8s.io/cluster-name: my-cluster
      nodepool: workers

  # Time to wait before considering a condition as a failure
  nodeStartupTimeout: 20m

  unhealthyConditions:
  # Standard Kubernetes conditions
  - type: Ready
    status: "False"
    timeout: 5m
  - type: Ready
    status: Unknown
    timeout: 5m

  # NPD-added conditions
  - type: KernelDeadlock
    status: "True"
    timeout: 0s   # Immediately remediate kernel deadlocks
  - type: ReadonlyFilesystem
    status: "True"
    timeout: 0s
  - type: DiskIOHealthy
    status: "False"
    timeout: 2m
  - type: NFSMountHealthy
    status: "False"
    timeout: 5m
  - type: ContainerRuntimeHealthy
    status: "False"
    timeout: 2m

  maxUnhealthy: "33%"
  remediationTemplate:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta2
    kind: AWSMachineTemplate
    name: worker-remediation-template
    namespace: default
```

### Option 2: Kured (Kubernetes Reboot Daemon) for OS-Level Issues

```yaml
# kured-daemonset.yaml (helm values)
configuration:
  rebootSentinel: /var/run/reboot-required
  period: 1h

  # Kured watches for node conditions set by NPD
  # and reboots nodes with the following conditions
  nodeLabels:
    "node.kubernetes.io/kured.sh/reboot-required": "true"

  # Commands to run before/after reboot
  preRebootNodeLabels:
  - "kured.sh/reboot-in-progress=true"
  postRebootNodeLabels:
  - "kured.sh/last-reboot=2006-01-02"

  # Maintenance window configuration
  startTime: "02:00"
  endTime: "06:00"
  timeZone: "America/New_York"

  # PDB-aware draining
  blockingPodSelector:
  - "app=critical-service"
```

## Custom Remediation Controller

For advanced scenarios, implement a custom controller that reacts to NPD conditions:

```go
// cmd/node-remediator/main.go
package main

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/clientcmd"
	"go.uber.org/zap"
)

// ProblemCondition defines a node condition that requires remediation.
type ProblemCondition struct {
	Type              corev1.NodeConditionType
	Status            corev1.ConditionStatus
	GracePeriod       time.Duration
	Action            RemediationAction
}

type RemediationAction string

const (
	ActionCordon       RemediationAction = "cordon"
	ActionCordonDrain  RemediationAction = "cordon+drain"
	ActionReboot       RemediationAction = "reboot"
	ActionTerminate    RemediationAction = "terminate"
)

var problemConditions = []ProblemCondition{
	{
		Type:        "KernelDeadlock",
		Status:      corev1.ConditionTrue,
		GracePeriod: 0,
		Action:      ActionCordonDrain,
	},
	{
		Type:        "ReadonlyFilesystem",
		Status:      corev1.ConditionTrue,
		GracePeriod: 30 * time.Second,
		Action:      ActionCordonDrain,
	},
	{
		Type:        "DiskIOHealthy",
		Status:      corev1.ConditionFalse,
		GracePeriod: 5 * time.Minute,
		Action:      ActionCordonDrain,
	},
	{
		Type:        "NFSMountHealthy",
		Status:      corev1.ConditionFalse,
		GracePeriod: 10 * time.Minute,
		Action:      ActionCordon,
	},
}

type NodeRemediator struct {
	client    kubernetes.Interface
	logger    *zap.Logger
	// Track when each condition was first observed per node
	firstSeen map[string]map[corev1.NodeConditionType]time.Time
}

func NewNodeRemediator(client kubernetes.Interface, logger *zap.Logger) *NodeRemediator {
	return &NodeRemediator{
		client:    client,
		logger:    logger,
		firstSeen: make(map[string]map[corev1.NodeConditionType]time.Time),
	}
}

func (r *NodeRemediator) ProcessNode(ctx context.Context, node *corev1.Node) {
	for _, condition := range node.Status.Conditions {
		for _, problem := range problemConditions {
			if condition.Type != problem.Type || condition.Status != problem.Status {
				continue
			}

			// Track first observation
			if _, ok := r.firstSeen[node.Name]; !ok {
				r.firstSeen[node.Name] = make(map[corev1.NodeConditionType]time.Time)
			}

			observedAt, alreadyTracked := r.firstSeen[node.Name][problem.Type]
			if !alreadyTracked {
				r.firstSeen[node.Name][problem.Type] = time.Now()
				r.logger.Warn("problem condition detected",
					zap.String("node", node.Name),
					zap.String("condition", string(problem.Type)),
					zap.String("gracePeriod", problem.GracePeriod.String()),
				)
				continue
			}

			// Check if grace period has elapsed
			if time.Since(observedAt) < problem.GracePeriod {
				r.logger.Info("condition within grace period, waiting",
					zap.String("node", node.Name),
					zap.String("condition", string(problem.Type)),
					zap.Duration("remaining", problem.GracePeriod - time.Since(observedAt)),
				)
				continue
			}

			// Execute remediation
			r.logger.Error("initiating node remediation",
				zap.String("node", node.Name),
				zap.String("condition", string(problem.Type)),
				zap.String("action", string(problem.Action)),
			)

			r.remediate(ctx, node, problem.Action, condition)
		}
	}
}

func (r *NodeRemediator) remediate(ctx context.Context, node *corev1.Node, action RemediationAction, condition corev1.NodeCondition) {
	switch action {
	case ActionCordon:
		r.cordonNode(ctx, node, condition)
	case ActionCordonDrain:
		if err := r.cordonNode(ctx, node, condition); err != nil {
			r.logger.Error("failed to cordon node", zap.Error(err))
			return
		}
		r.drainNode(ctx, node)
	}
}

func (r *NodeRemediator) cordonNode(ctx context.Context, node *corev1.Node, condition corev1.NodeCondition) error {
	nodeCopy := node.DeepCopy()
	nodeCopy.Spec.Unschedulable = true

	// Add a taint so existing pods are evicted
	taint := corev1.Taint{
		Key:    "node.kubernetes.io/node-problem-detector",
		Value:  string(condition.Type),
		Effect: corev1.TaintEffectNoSchedule,
	}
	nodeCopy.Spec.Taints = append(nodeCopy.Spec.Taints, taint)

	_, err := r.client.CoreV1().Nodes().Update(ctx, nodeCopy, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("cordoning node %s: %w", node.Name, err)
	}

	r.logger.Info("node cordoned", zap.String("node", node.Name))
	return nil
}
```

## Monitoring NPD with Prometheus

```yaml
# ServiceMonitor for NPD metrics
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: node-problem-detector
  namespace: kube-system
  labels:
    app: node-problem-detector
spec:
  selector:
    matchLabels:
      app: node-problem-detector
  endpoints:
  - port: metrics
    path: /metrics
    interval: 30s
```

Key Prometheus queries for NPD:

```promql
# Nodes with kernel deadlock condition
kube_node_status_condition{condition="KernelDeadlock",status="true"} == 1

# OOM kill rate per node (from NPD events)
rate(node_problem_detector_problem_counter{reason="OOMKilling"}[5m])

# Nodes with filesystem health issues
kube_node_status_condition{condition="ReadonlyFilesystem",status="true"} == 1

# Problem event rate (useful for alerting)
rate(node_problem_detector_problem_counter[5m]) > 0

# Nodes with any NPD-detected problem
count by (node) (
  kube_node_status_condition{
    condition=~"KernelDeadlock|ReadonlyFilesystem|DiskIOHealthy|NFSMountHealthy",
    status="true"
  } == 1
)
```

### Alerting Rules

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-problem-detector-alerts
  namespace: kube-system
spec:
  groups:
  - name: node-problem-detector
    rules:
    - alert: NodeKernelDeadlock
      expr: kube_node_status_condition{condition="KernelDeadlock",status="true"} == 1
      for: 0m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Node {{ $labels.node }} has kernel deadlock"
        description: "Node Problem Detector detected a kernel deadlock on {{ $labels.node }}. Immediate remediation required."
        runbook_url: "https://wiki.myorg.com/runbooks/node-kernel-deadlock"

    - alert: NodeReadonlyFilesystem
      expr: kube_node_status_condition{condition="ReadonlyFilesystem",status="true"} == 1
      for: 30s
      labels:
        severity: critical
      annotations:
        summary: "Node {{ $labels.node }} filesystem is read-only"
        description: "The root filesystem on {{ $labels.node }} has been remounted read-only, indicating disk errors."

    - alert: NodeDiskIODegraded
      expr: kube_node_status_condition{condition="DiskIOHealthy",status="false"} == 1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node {{ $labels.node }} disk I/O is degraded"

    - alert: NodeOOMKillingFrequent
      expr: rate(node_problem_detector_problem_counter{reason="OOMKilling"}[5m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Frequent OOM kills on {{ $labels.node }}"
        description: "Node {{ $labels.node }} is experiencing frequent OOM kills (> 6/minute). Consider increasing memory limits or adding nodes."
```

## NPD Custom Plugin for GPU Health

For nodes with NVIDIA GPUs:

```bash
#!/bin/bash
# /config/plugin/check_gpu_health.sh

set -euo pipefail

# Check if nvidia-smi is available
if ! command -v nvidia-smi &> /dev/null; then
    # No GPUs on this node, return healthy
    exit 0
fi

# Check for GPU errors
GPU_ERRORS=$(nvidia-smi --query-gpu=ecc.errors.corrected.volatile.total --format=csv,noheader,nounits 2>/dev/null | awk '{sum+=$1} END {print sum}')

if [ "$GPU_ERRORS" -gt 1000 ]; then
    echo "GPU has excessive ECC errors: $GPU_ERRORS"
    exit 1
fi

# Check for uncorrected errors (these are serious)
GPU_UNCORRECTED=$(nvidia-smi --query-gpu=ecc.errors.uncorrected.volatile.total --format=csv,noheader,nounits 2>/dev/null | awk '{sum+=$1} END {print sum}')

if [ "$GPU_UNCORRECTED" -gt 0 ]; then
    echo "GPU has uncorrected ECC errors: $GPU_UNCORRECTED"
    exit 1
fi

# Check all GPUs are accessible and running
GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)
HEALTHY_COUNT=$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null | wc -l)

if [ "$GPU_COUNT" != "$HEALTHY_COUNT" ]; then
    echo "Not all GPUs are healthy: $HEALTHY_COUNT/$GPU_COUNT responsive"
    exit 1
fi

exit 0
```

Add to the custom plugin monitor config:

```json
{
  "type": "permanent",
  "condition": "GPUHealthy",
  "reason": "GPUError",
  "path": "/config/plugin/check_gpu_health.sh"
}
```

## Conclusion

Node Problem Detector bridges the gap between kernel/OS health and Kubernetes workload scheduling. By surfacing kernel deadlocks, filesystem errors, and custom application health failures as Node Conditions, it enables the Cluster Autoscaler, Machine Health Checks, and custom remediation controllers to automatically replace broken nodes before users notice the impact. The custom plugin interface is the critical feature for enterprise deployments: every environment has unique health signals (NFS mounts, proprietary hardware, legacy monitoring agents), and the plugin interface allows those signals to be expressed in the same Node Condition model that the rest of the Kubernetes ecosystem understands.
