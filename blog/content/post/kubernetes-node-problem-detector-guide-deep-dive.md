---
title: "Kubernetes Node Problem Detector: Proactive Infrastructure Health Monitoring"
date: 2028-02-28T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "NPD", "Monitoring", "Node Health", "Prometheus"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A comprehensive guide to Kubernetes Node Problem Detector: NPD architecture, built-in problem detectors, custom problem definitions, condition taints integration, remediation automation, and Prometheus alerting on node conditions."
more_link: "yes"
url: "/kubernetes-node-problem-detector-guide-deep-dive/"
---

Node failures in Kubernetes often manifest as silent degradations before they cause pod evictions or node NotReady events. The Node Problem Detector (NPD) continuously monitors node-level health by analyzing kernel logs, system services, and custom metrics, then reports problems as Node Conditions or Events. When combined with condition-based taints and automated remediation, NPD transforms reactive incident response into proactive infrastructure health management. This guide covers NPD architecture, all built-in detectors, custom problem definitions, taint integration, remediation automation, and Prometheus-based alerting.

<!--more-->

## NPD Architecture

Node Problem Detector runs as a DaemonSet on every node. It reads problem definitions from ConfigMaps and monitors node health through two monitor types:

- **SystemLogMonitor**: Reads log files (kernel log `/dev/kmsg`, system logs) and matches patterns using regular expressions
- **CustomPluginMonitor**: Executes scripts or binaries and interprets their exit codes as health indicators

When a pattern matches or a plugin reports an error, NPD reports it as:
- **NodeCondition**: A persistent condition on the Node object (e.g., `KernelDeadlock=True`)
- **Event**: A Kubernetes Event attached to the Node

NodeConditions persist until explicitly cleared, making them visible to schedulers and operators. Events are ephemeral and auto-deleted.

### NPD DaemonSet Installation

```yaml
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
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      containers:
      - name: node-problem-detector
        image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.15
        command:
        - /node-problem-detector
        - --logtostderr
        - --config.system-log-monitor=/config/kernel-monitor.json
        - --config.system-log-monitor=/config/abrt-adaptor.json
        - --config.custom-plugin-monitor=/config/kernel-monitor-counter.json
        - --config.custom-plugin-monitor=/config/disk-mixed-ioerror-plugin-monitor.json
        - --prometheus-address=0.0.0.0
        - --prometheus-port=20257
        - --v=4
        securityContext:
          privileged: true
        env:
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
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
        - name: localtime
          mountPath: /etc/localtime
          readOnly: true
        resources:
          limits:
            cpu: "200m"
            memory: "100Mi"
          requests:
            cpu: "20m"
            memory: "20Mi"
        ports:
        - containerPort: 20257
          hostPort: 20257
          name: prometheus
      volumes:
      - name: log
        hostPath:
          path: /var/log
      - name: kmsg
        hostPath:
          path: /dev/kmsg
          type: CharDevice
      - name: config
        configMap:
          name: node-problem-detector-config
      - name: localtime
        hostPath:
          path: /etc/localtime
      tolerations:
      - effect: NoSchedule
        operator: Exists
      - effect: NoExecute
        operator: Exists
```

### RBAC Configuration

```yaml
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
  name: system:node-problem-detector
subjects:
- kind: ServiceAccount
  name: node-problem-detector
  namespace: kube-system
```

## Built-in Problem Detectors

### Kernel Deadlock Monitor

Detects hung tasks and kernel panics from `/dev/kmsg`:

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
      "reason": "TaskHung",
      "pattern": "task \\S+:\\w+ blocked for more than \\w+ seconds\\."
    },
    {
      "type": "temporary",
      "reason": "UnregisterNetDevice",
      "pattern": "unregister_netdevice: waiting for \\w+ to become free. Usage count = \\d+"
    },
    {
      "type": "temporary",
      "reason": "KernelOops",
      "pattern": "BUG: unable to handle kernel"
    },
    {
      "type": "temporary",
      "reason": "KernelOops",
      "pattern": "INFO: task [\\S ]+blocked for more than [\\d]+ seconds"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "AUFSUmountHung",
      "pattern": "task umount\\.aufs:\\w+ blocked for more than \\w+ seconds\\."
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "DockerHung",
      "pattern": "task docker:\\w+ blocked for more than \\w+ seconds\\."
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

### OOM Event Monitor

```json
{
  "plugin": "kmsg",
  "logPath": "/dev/kmsg",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "oom-monitor",
  "conditions": [],
  "rules": [
    {
      "type": "temporary",
      "reason": "OOMKilling",
      "pattern": "Killed process \\d+ \\((.+)\\) total-vm:\\d+kB"
    },
    {
      "type": "temporary",
      "reason": "MemoryPressure",
      "pattern": "Memory cgroup out of memory:"
    }
  ]
}
```

### NTP Problem Detector (Custom Plugin)

```bash
#!/bin/bash
# /config/check-ntp.sh
# Exit 0: healthy, Exit 1: warning, Exit 2: critical

NTP_OFFSET_MAX_MS=500

# Check if NTP service is running
if ! systemctl is-active --quiet ntp chronyd ntpd; then
  echo "NTP service is not running"
  exit 2
fi

# Check NTP offset
NTP_OFFSET=$(chronyc tracking 2>/dev/null | grep "System time" | \
  awk '{print $4}' | tr -d '-')

if [ -z "$NTP_OFFSET" ]; then
  # Try ntpstat if chronyc not available
  NTP_OFFSET=$(ntpstat 2>/dev/null | grep "time correct to within" | \
    awk '{print $5}')
fi

if [ -z "$NTP_OFFSET" ]; then
  echo "Cannot determine NTP offset"
  exit 1
fi

OFFSET_MS=$(echo "$NTP_OFFSET * 1000" | bc 2>/dev/null || echo "0")

if (( $(echo "$OFFSET_MS > $NTP_OFFSET_MAX_MS" | bc -l) )); then
  echo "NTP offset ${NTP_OFFSET}s exceeds ${NTP_OFFSET_MAX_MS}ms threshold"
  exit 2
fi

echo "NTP synchronized, offset: ${NTP_OFFSET}s"
exit 0
```

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "60s",
    "timeout": "30s",
    "max_output_length": 80,
    "concurrency": 1,
    "enable_message_change_based_condition_update": false
  },
  "source": "ntp-custom-plugin-monitor",
  "conditions": [
    {
      "type": "NTPProblem",
      "reason": "NTPIsUp",
      "message": "NTP service is running and synchronized"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "NTPWarning",
      "path": "/config/check-ntp.sh",
      "timeout": "30s"
    },
    {
      "type": "permanent",
      "condition": "NTPProblem",
      "reason": "NTPIsDown",
      "path": "/config/check-ntp.sh",
      "timeout": "30s"
    }
  ]
}
```

## Custom Problem Definitions

### Disk IO Error Detector

```bash
#!/bin/bash
# /config/check-disk-io.sh
# Detect disk IO errors from kernel log

ERRORS=$(dmesg --since "5 minutes ago" 2>/dev/null | \
  grep -c "I/O error\|SCSI error\|blk_update_request: I/O error")

if [ "$ERRORS" -gt 5 ]; then
  echo "Detected $ERRORS disk IO errors in the last 5 minutes"
  exit 2
elif [ "$ERRORS" -gt 0 ]; then
  echo "Detected $ERRORS disk IO errors in the last 5 minutes (warning)"
  exit 1
fi

echo "No disk IO errors detected"
exit 0
```

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "30s",
    "timeout": "15s",
    "max_output_length": 80,
    "concurrency": 1
  },
  "source": "disk-io-error-plugin-monitor",
  "conditions": [
    {
      "type": "DiskIOError",
      "reason": "NoDiskIOError",
      "message": "No disk IO errors detected"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "DiskIOWarning",
      "path": "/config/check-disk-io.sh",
      "timeout": "15s"
    },
    {
      "type": "permanent",
      "condition": "DiskIOError",
      "reason": "DiskIOErrorDetected",
      "path": "/config/check-disk-io.sh",
      "timeout": "15s"
    }
  ]
}
```

### Network Interface Error Detector

```bash
#!/bin/bash
# /config/check-network.sh

ERROR_THRESHOLD=1000

for IFACE in $(ls /sys/class/net/ | grep -v lo); do
  if [ -f "/sys/class/net/${IFACE}/statistics/rx_errors" ]; then
    RX_ERRORS=$(cat "/sys/class/net/${IFACE}/statistics/rx_errors")
    TX_ERRORS=$(cat "/sys/class/net/${IFACE}/statistics/tx_errors")

    if [ "$RX_ERRORS" -gt "$ERROR_THRESHOLD" ] || \
       [ "$TX_ERRORS" -gt "$ERROR_THRESHOLD" ]; then
      echo "Interface $IFACE has high errors: rx=$RX_ERRORS tx=$TX_ERRORS"
      exit 2
    fi
  fi
done

# Check for dropped packets indicating network saturation
for IFACE in $(ls /sys/class/net/ | grep -v lo); do
  if [ -f "/sys/class/net/${IFACE}/statistics/rx_dropped" ]; then
    RX_DROPPED=$(cat "/sys/class/net/${IFACE}/statistics/rx_dropped")
    if [ "$RX_DROPPED" -gt 10000 ]; then
      echo "Interface $IFACE has high drops: rx_dropped=$RX_DROPPED"
      exit 1
    fi
  fi
done

echo "Network interfaces healthy"
exit 0
```

### Container Runtime Health Check

```bash
#!/bin/bash
# /config/check-containerd.sh

# Check containerd is responding
if ! timeout 5 ctr version &>/dev/null; then
  echo "containerd is not responding"
  exit 2
fi

# Check for zombie container processes
ZOMBIE_COUNT=$(ps aux | grep -c 'Z.*containerd' || true)
if [ "$ZOMBIE_COUNT" -gt 5 ]; then
  echo "High number of zombie containerd processes: $ZOMBIE_COUNT"
  exit 1
fi

# Check containerd socket exists and is accessible
if [ ! -S "/run/containerd/containerd.sock" ]; then
  echo "containerd socket not found"
  exit 2
fi

echo "containerd healthy"
exit 0
```

## Condition Taints Integration

NodeConditions set by NPD can automatically trigger taints via the Node Condition Taint Manager, which is built into the default scheduler. However, NPD itself does not set taints—that requires either the scheduler's taint manager or a custom controller.

### Using node-problem-detector-remediation Operator

The NPD remediation operator watches NodeConditions and applies taints:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: node-problem-remediation
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: node-problem-remediation
  template:
    spec:
      containers:
      - name: remediation
        image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.15
        command:
        - /node-problem-detector
        - --config.custom-plugin-monitor=/config/remediation.json
```

### Manual Taint on Condition (Controller Script)

```python
#!/usr/bin/env python3
"""
Watch NodeConditions from NPD and apply/remove taints.
Runs as a Kubernetes controller.
"""

import time
from kubernetes import client, config, watch

CONDITION_TAINT_MAP = {
    "KernelDeadlock": {
        "key": "node.kubernetes.io/kernel-deadlock",
        "effect": "NoSchedule"
    },
    "ReadonlyFilesystem": {
        "key": "node.kubernetes.io/readonly-filesystem",
        "effect": "NoExecute"
    },
    "DiskIOError": {
        "key": "node.kubernetes.io/disk-io-error",
        "effect": "NoSchedule"
    },
    "NTPProblem": {
        "key": "node.kubernetes.io/ntp-problem",
        "effect": "NoSchedule"
    }
}

def main():
    config.load_incluster_config()
    v1 = client.CoreV1Api()
    w = watch.Watch()

    for event in w.stream(v1.list_node, timeout_seconds=0):
        node = event["object"]
        node_name = node.metadata.name

        for condition in (node.status.conditions or []):
            if condition.type not in CONDITION_TAINT_MAP:
                continue

            taint_spec = CONDITION_TAINT_MAP[condition.type]
            existing_taints = node.spec.taints or []
            has_taint = any(
                t.key == taint_spec["key"]
                for t in existing_taints
            )

            if condition.status == "True" and not has_taint:
                # Add taint
                new_taint = client.V1Taint(
                    key=taint_spec["key"],
                    effect=taint_spec["effect"],
                    time_added=None
                )
                patch = {"spec": {"taints": existing_taints + [new_taint]}}
                v1.patch_node(node_name, patch)
                print(f"Added taint {taint_spec['key']} to {node_name}")

            elif condition.status == "False" and has_taint:
                # Remove taint
                new_taints = [
                    t for t in existing_taints
                    if t.key != taint_spec["key"]
                ]
                patch = {"spec": {"taints": new_taints}}
                v1.patch_node(node_name, patch)
                print(f"Removed taint {taint_spec['key']} from {node_name}")

if __name__ == "__main__":
    main()
```

## Prometheus Metrics from NPD

NPD exposes metrics on port 20257 at `/metrics`. Key metrics include:

```
# Problem counts by type and source
problem_counter{reason="OOMKilling",source="kernel-monitor"} 3

# Gauge for whether a condition is currently true (1) or false (0)
problem_gauge{reason="KernelDeadlock",source="kernel-monitor",type="KernelDeadlock"} 0
problem_gauge{reason="ReadonlyFilesystem",source="kernel-monitor",type="ReadonlyFilesystem"} 0

# Plugin execution metrics
plugin_invocations_total{name="check-ntp",source="ntp-custom-plugin-monitor"} 1440
plugin_failures_total{name="check-ntp",source="ntp-custom-plugin-monitor"} 0
```

### Prometheus ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: node-problem-detector
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-problem-detector
  endpoints:
  - port: prometheus
    interval: 30s
    path: /metrics
---
apiVersion: v1
kind: Service
metadata:
  name: node-problem-detector
  namespace: kube-system
  labels:
    app: node-problem-detector
spec:
  clusterIP: None
  selector:
    app: node-problem-detector
  ports:
  - name: prometheus
    port: 20257
    targetPort: 20257
```

## Alerting on Node Conditions

### PrometheusRule for NPD Conditions

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
    - alert: NodeKernelDeadlock
      expr: problem_gauge{reason="KernelDeadlock"} == 1
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "Kernel deadlock detected on {{ $labels.instance }}"
        description: >-
          Node {{ $labels.instance }} has a kernel deadlock.
          The node should be drained and rebooted.
          Reason: {{ $labels.reason }}

    - alert: NodeReadonlyFilesystem
      expr: problem_gauge{reason="ReadonlyFilesystem"} == 1
      for: 1m
      labels:
        severity: critical
      annotations:
        summary: "Read-only filesystem on {{ $labels.instance }}"
        description: "Node {{ $labels.instance }} filesystem has been remounted read-only, indicating storage errors."

    - alert: NodeFrequentOOMKilling
      expr: rate(problem_counter{reason="OOMKilling"}[15m]) > 0.1
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Frequent OOM kills on {{ $labels.instance }}"
        description: >-
          Node {{ $labels.instance }} is experiencing OOM kills at a rate of
          {{ $value | humanize }} per second.

    - alert: NodeNTPProblem
      expr: problem_gauge{reason="NTPIsDown"} == 1
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "NTP synchronization problem on {{ $labels.instance }}"
        description: "Node {{ $labels.instance }} NTP is not synchronized. Certificate validation and log correlation may be affected."

    - alert: NodeDiskIOError
      expr: problem_gauge{reason="DiskIOErrorDetected"} == 1
      for: 2m
      labels:
        severity: critical
      annotations:
        summary: "Disk IO errors on {{ $labels.instance }}"
        description: "Node {{ $labels.instance }} is reporting disk IO errors. Data integrity may be at risk."

    - alert: NodeProblemDetectorDown
      expr: up{job="node-problem-detector"} == 0
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Node Problem Detector is down on {{ $labels.instance }}"
        description: "NPD has been down for 5 minutes on {{ $labels.instance }}. Node health monitoring is degraded."
```

### Grafana Dashboard for Node Conditions

Query patterns for Grafana panels:

```
# Panel: Nodes with active problems
count by (instance) (problem_gauge > 0)

# Panel: Problem rate over time
sum by (reason) (rate(problem_counter[5m]))

# Panel: OOM events by node (last hour)
sum by (instance) (increase(problem_counter{reason="OOMKilling"}[1h]))

# Panel: Plugin invocation success rate
1 - (
  sum by (name) (rate(plugin_failures_total[5m]))
  /
  sum by (name) (rate(plugin_invocations_total[5m]))
)

# Panel: Current condition status heatmap
# Value 1 = problem present, 0 = healthy
problem_gauge{type=~"KernelDeadlock|ReadonlyFilesystem|DiskIOError|NTPProblem"}
```

## ConfigMap Assembly

The complete ConfigMap for production NPD:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-detector-config
  namespace: kube-system
data:
  kernel-monitor.json: |
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
          "pattern": "Killed process \\d+"
        },
        {
          "type": "temporary",
          "reason": "TaskHung",
          "pattern": "task \\S+:\\w+ blocked for more than \\w+ seconds"
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

  check-ntp.sh: |
    #!/bin/bash
    if ! systemctl is-active --quiet chronyd ntpd 2>/dev/null; then
      echo "NTP service not running"
      exit 2
    fi
    echo "NTP running"
    exit 0

  check-disk-io.sh: |
    #!/bin/bash
    ERRORS=$(dmesg --since "5 minutes ago" 2>/dev/null | grep -c "I/O error" || echo 0)
    if [ "$ERRORS" -gt 5 ]; then
      echo "$ERRORS disk IO errors in last 5 minutes"
      exit 2
    fi
    echo "No disk IO errors"
    exit 0

  ntp-monitor.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invoke_interval": "60s",
        "timeout": "30s",
        "max_output_length": 80,
        "concurrency": 1
      },
      "source": "ntp-custom-plugin-monitor",
      "conditions": [
        {
          "type": "NTPProblem",
          "reason": "NTPIsUp",
          "message": "NTP service is running"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "NTPProblem",
          "reason": "NTPIsDown",
          "path": "/config/check-ntp.sh",
          "timeout": "30s"
        }
      ]
    }

  disk-io-monitor.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invoke_interval": "30s",
        "timeout": "15s",
        "max_output_length": 80,
        "concurrency": 1
      },
      "source": "disk-io-error-plugin-monitor",
      "conditions": [
        {
          "type": "DiskIOError",
          "reason": "NoDiskIOError",
          "message": "No disk IO errors detected"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "DiskIOError",
          "reason": "DiskIOErrorDetected",
          "path": "/config/check-disk-io.sh",
          "timeout": "15s"
        }
      ]
    }
```

## Verifying NPD Operation

```bash
# Check NPD pods are running on all nodes
kubectl get pods -n kube-system -l app=node-problem-detector -o wide

# Check NPD logs for condition detection
kubectl logs -n kube-system -l app=node-problem-detector --tail=50

# Check current node conditions (including NPD-reported ones)
kubectl describe node <node-name> | grep -A 20 "Conditions:"

# Check for NPD-generated events
kubectl get events -n kube-system --field-selector source=kernel-monitor

# Manually trigger a test OOM event (use with extreme caution)
# This is for development environments only
# echo "1" > /proc/sysrq-trigger  # NOT recommended in production

# Query NPD metrics directly
NODE_IP=$(kubectl get node <node-name> -o jsonpath='{.status.addresses[0].address}')
curl "http://${NODE_IP}:20257/metrics" | grep problem_gauge
```

Node Problem Detector transforms node health from a reactive concern—discovered when pods fail—into a proactive signal that enables automatic remediation before workloads are affected. Combined with condition taints, automated remediation controllers, and Prometheus alerting, NPD is a foundational component of enterprise Kubernetes operations.
