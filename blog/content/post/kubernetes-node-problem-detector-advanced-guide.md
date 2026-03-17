---
title: "Kubernetes Node Problem Detector: Advanced Configuration, Custom Problem Rules, and Cluster Autoscaler Integration"
date: 2028-06-18T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "NPD", "Node Health", "Cluster Autoscaler", "Observability"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Deep dive into Kubernetes Node Problem Detector: detecting kernel panics, OOM kills, disk pressure, and NTP drift with custom problem rules. Covers NodeConditions vs Events, Prometheus integration, and draining problematic nodes via Cluster Autoscaler integration."
more_link: "yes"
url: "/kubernetes-node-problem-detector-advanced-guide/"
---

Kubernetes workloads fail for reasons that happen below the container level: kernel OOM kills, corrupted disk sectors, NTP drift causing certificate validation failures, network interface flaps, and filesystem errors. The Kubelet reports node resource pressure (`MemoryPressure`, `DiskPressure`), but it has no visibility into kernel-level events, hardware faults, or infrastructure issues that affect workload behavior without triggering resource limits.

Node Problem Detector (NPD) fills this gap by continuously monitoring system logs, kernel messages, and system metrics to detect anomalous conditions, report them as Kubernetes NodeConditions and Events, and optionally trigger automated remediation through integration with the Cluster Autoscaler and Descheduler.

<!--more-->

## Architecture Overview

Node Problem Detector runs as a DaemonSet on every node. It reads problem definitions from configuration files, monitors log sources and system metrics, and translates detected problems into Kubernetes API objects:

```
┌─────────────────────────────────────────────────────────┐
│  Node Problem Detector DaemonSet                         │
│                                                          │
│  Problem Sources:              Problem Reporters:        │
│  ┌─────────────────┐          ┌──────────────────────┐  │
│  │ SystemLogMonitor│──────────► NodeCondition Manager │  │
│  │  /var/log/kern  │          └──────────────────────┘  │
│  └─────────────────┘          ┌──────────────────────┐  │
│  ┌─────────────────┐          │  Event Recorder      │  │
│  │  ABRTWatcher    │──────────►  (k8s Events)        │  │
│  │  /var/log/abrt  │          └──────────────────────┘  │
│  └─────────────────┘          ┌──────────────────────┐  │
│  ┌─────────────────┐          │  Prometheus Metrics  │  │
│  │ SystemStatsMonitor│────────► Exporter             │  │
│  │  /proc/stat     │          └──────────────────────┘  │
│  └─────────────────┘                                     │
└─────────────────────────────────────────────────────────┘
                │                         │
                ▼                         ▼
         Node Conditions              k8s Events
         (persistent state)          (point-in-time)
```

### NodeConditions vs Events

**NodeConditions** represent persistent node state:
- Stored in `node.status.conditions`
- Have `True/False/Unknown` status
- Show current health state (e.g., is the node currently experiencing OOM?)
- Used by the scheduler to determine node eligibility
- Visible in `kubectl describe node`

**Events** represent point-in-time occurrences:
- Stored as Kubernetes Event objects (with TTL)
- Record specific incidents (e.g., "OOM kill at 14:32:07")
- Useful for incident analysis but not for scheduling decisions

NPD can report to both: conditions track ongoing problems, events record individual occurrences.

## Deploying Node Problem Detector

### DaemonSet Deployment

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
---
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
      # Must run on every node, including masters
      tolerations:
      - operator: "Exists"
        effect: "NoExecute"
      - operator: "Exists"
        effect: "NoSchedule"
      priorityClassName: system-node-critical
      hostNetwork: false
      containers:
      - name: node-problem-detector
        image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.18
        command:
        - /node-problem-detector
        - --logtostderr
        - --system-log-monitors=/config/kernel-monitor.json,/config/docker-monitor.json
        - --custom-plugin-monitors=/config/custom-plugins.json
        - --prometheus-address=0.0.0.0
        - --prometheus-port=20257
        - --k8s-exporter-heartbeat-period=5m
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
        - name: localtime
          mountPath: /etc/localtime
          readOnly: true
        securityContext:
          privileged: true
        resources:
          requests:
            cpu: "20m"
            memory: "64Mi"
          limits:
            cpu: "200m"
            memory: "128Mi"
        ports:
        - name: metrics
          containerPort: 20257
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
      - name: localtime
        hostPath:
          path: /etc/localtime
```

## Built-in Problem Detection

### Kernel Monitor Configuration

```json
// /config/kernel-monitor.json
{
  "plugin": "filelog",
  "pluginConfig": {
    "timestamp": "^.{15}",
    "message": "kernel: \\[.*\\] (.*)",
    "timestampFormat": "Jan _2 15:04:05"
  },
  "logPath": "/var/log/kern.log",
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
    },
    {
      "type": "CorruptDockerOverlay2",
      "reason": "NoCorruptDockerOverlay2",
      "message": "No overlayfs corruption"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "OOMKilling",
      "pattern": "Kill process \\d+ (.+) score \\d+ or sacrifice child"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "AUFSUmountHung",
      "pattern": "task .+:.+, is blocked for more than [0-9]+ seconds\\."
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "DockerHung",
      "pattern": "task docker:.+, is blocked for more than [0-9]+ seconds\\."
    },
    {
      "type": "permanent",
      "condition": "ReadonlyFilesystem",
      "reason": "FilesystemIsReadOnly",
      "pattern": "Remounting filesystem read-only"
    },
    {
      "type": "permanent",
      "condition": "CorruptDockerOverlay2",
      "reason": "CorruptDockerOverlay2",
      "pattern": "l\\.backingFsBlockDev"
    }
  ]
}
```

### Systemd Monitor Configuration

```json
// /config/systemd-monitor.json
{
  "plugin": "journald",
  "pluginConfig": {
    "source": "systemd"
  },
  "lookback": "5m",
  "bufferSize": 10,
  "source": "systemd-monitor",
  "conditions": [
    {
      "type": "KubeletUnhealthy",
      "reason": "KubeletIsHealthy",
      "message": "kubelet is healthy"
    },
    {
      "type": "ContainerRuntimeUnhealthy",
      "reason": "ContainerRuntimeIsHealthy",
      "message": "container runtime is healthy"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "ContainerRuntimeCrash",
      "pattern": "containerd\\[\\d+\\]: panic: "
    },
    {
      "type": "permanent",
      "condition": "KubeletUnhealthy",
      "reason": "KubeletCrashLooping",
      "pattern": "kubelet.service: Start request repeated too quickly"
    },
    {
      "type": "permanent",
      "condition": "ContainerRuntimeUnhealthy",
      "reason": "ContainerRuntimeNotRunning",
      "pattern": "containerd.service.*Failed with result"
    }
  ]
}
```

## Custom Problem Detection

### Custom Plugin Architecture

Custom plugins allow arbitrary health checks through scripts or binaries. NPD calls the plugin on a schedule and interprets exit codes:

- Exit 0: OK
- Exit 1: Non-permanent problem (warning)
- Exit 2: Permanent problem (the node is broken, requires intervention)

```json
// /config/custom-plugins.json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "30s",
    "timeout": "5m",
    "max_output_length": 80,
    "concurrency": 3
  },
  "source": "custom-plugin-monitor",
  "skipInitialStatus": true,
  "metricsReporting": true,
  "conditions": [
    {
      "type": "NTPProblem",
      "reason": "NTPIsInSync",
      "message": "NTP is in sync"
    },
    {
      "type": "DiskIOProblem",
      "reason": "DiskIOIsHealthy",
      "message": "Disk I/O is healthy"
    },
    {
      "type": "PIDPressure",
      "reason": "NoPIDPressure",
      "message": "No PID pressure"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "NTPProblem",
      "reason": "NTPNotSynced",
      "path": "/config/plugins/check-ntp.sh"
    },
    {
      "type": "permanent",
      "condition": "DiskIOProblem",
      "reason": "DiskIOError",
      "path": "/config/plugins/check-disk-io.sh"
    },
    {
      "type": "temporary",
      "reason": "PIDPressureDetected",
      "path": "/config/plugins/check-pid-pressure.sh"
    },
    {
      "type": "temporary",
      "reason": "ConntrackTableFull",
      "path": "/config/plugins/check-conntrack.sh"
    }
  ]
}
```

### NTP Drift Detection Plugin

```bash
#!/bin/bash
# /config/plugins/check-ntp.sh
# Checks NTP synchronization and reports if drift exceeds threshold

DRIFT_THRESHOLD_MS=100  # Alert if drift exceeds 100ms
CRITICAL_THRESHOLD_MS=500  # Permanent condition if drift exceeds 500ms

# Check if chronyd or ntpd is available
if command -v chronyc >/dev/null 2>&1; then
    TRACKING=$(chronyc tracking 2>/dev/null)
    if [ $? -ne 0 ]; then
        echo "chronyd is not responding"
        exit 2
    fi

    # Extract offset in milliseconds
    OFFSET_MS=$(echo "$TRACKING" | grep "System time" | awk '{print $4}' | \
        awk '{printf "%.0f", $1 * 1000}')

    # Check if NTP is synchronized
    SYNCED=$(echo "$TRACKING" | grep -c "Reference ID.*0.0.0.0" || true)
    if [ "${SYNCED}" -gt 0 ]; then
        echo "NTP is not synchronized to any source"
        exit 2
    fi

elif command -v ntpq >/dev/null 2>&1; then
    OFFSET_LINE=$(ntpq -p 2>/dev/null | grep "^\*")
    if [ -z "$OFFSET_LINE" ]; then
        echo "ntpd has no synchronized source"
        exit 2
    fi
    OFFSET_MS=$(echo "$OFFSET_LINE" | awk '{printf "%.0f", $9}')
else
    # No NTP client found — this is a problem
    echo "No NTP client (chrony/ntpd) found on this node"
    exit 2
fi

ABS_OFFSET=$(echo "$OFFSET_MS" | tr -d '-')

if [ "${ABS_OFFSET}" -gt "${CRITICAL_THRESHOLD_MS}" ]; then
    echo "NTP drift critical: ${ABS_OFFSET}ms (threshold: ${CRITICAL_THRESHOLD_MS}ms)"
    exit 2
elif [ "${ABS_OFFSET}" -gt "${DRIFT_THRESHOLD_MS}" ]; then
    echo "NTP drift warning: ${ABS_OFFSET}ms (threshold: ${DRIFT_THRESHOLD_MS}ms)"
    exit 1
fi

echo "NTP synchronized, drift: ${ABS_OFFSET}ms"
exit 0
```

### Disk I/O Health Check

```bash
#!/bin/bash
# /config/plugins/check-disk-io.sh
# Detects disk I/O errors and problematic I/O wait

IO_WAIT_THRESHOLD=80    # Alert if iowait% > 80 for sustained period
ERROR_COUNT_THRESHOLD=5  # Alert if disk errors > 5 in last 5 minutes

# Check for disk errors in kernel log
DISK_ERRORS=$(dmesg --since "5 minutes ago" 2>/dev/null | \
    grep -cE "I/O error|medium error|MEDIUM ERROR|hardware error|reset ata" || echo "0")

if [ "${DISK_ERRORS}" -gt "${ERROR_COUNT_THRESHOLD}" ]; then
    echo "Disk I/O errors detected: ${DISK_ERRORS} errors in last 5 minutes"
    exit 2
fi

# Check for filesystem read-only remount
READONLY=$(dmesg --since "5 minutes ago" 2>/dev/null | \
    grep -c "Remounting filesystem read-only" || echo "0")

if [ "${READONLY}" -gt 0 ]; then
    echo "Filesystem remounted read-only — disk failure"
    exit 2
fi

# Check I/O wait percentage (average over 5 samples)
if command -v iostat >/dev/null 2>&1; then
    IOWAIT=$(iostat -c 1 5 2>/dev/null | \
        tail -n +4 | \
        awk 'NR>1 {sum+=$4; count++} END {if(count>0) printf "%.0f", sum/count; else print "0"}')

    if [ "${IOWAIT}" -gt "${IO_WAIT_THRESHOLD}" ]; then
        echo "High I/O wait: ${IOWAIT}% (threshold: ${IO_WAIT_THRESHOLD}%)"
        exit 1
    fi
fi

echo "Disk I/O healthy"
exit 0
```

### Connection Tracking Saturation Check

```bash
#!/bin/bash
# /config/plugins/check-conntrack.sh
# Alerts before the conntrack table fills up (which causes packet drops)

CONNTRACK_USAGE_WARN=75   # Warn at 75% usage
CONNTRACK_USAGE_CRIT=90   # Critical at 90% usage

CURRENT=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo "0")
MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo "0")

if [ "${MAX}" -eq 0 ]; then
    echo "conntrack not available on this node"
    exit 0
fi

USAGE_PCT=$(echo "scale=0; ${CURRENT} * 100 / ${MAX}" | bc)

if [ "${USAGE_PCT}" -ge "${CONNTRACK_USAGE_CRIT}" ]; then
    echo "Conntrack table ${USAGE_PCT}% full: ${CURRENT}/${MAX} entries"
    exit 1
elif [ "${USAGE_PCT}" -ge "${CONNTRACK_USAGE_WARN}" ]; then
    echo "Conntrack table ${USAGE_PCT}% full: ${CURRENT}/${MAX} entries"
    exit 1
fi

echo "Conntrack usage: ${USAGE_PCT}% (${CURRENT}/${MAX})"
exit 0
```

### PID Namespace Pressure Check

```bash
#!/bin/bash
# /config/plugins/check-pid-pressure.sh
# Kubernetes PID limits prevent kubelet from starting new containers

SYSTEM_PID_WARN=80   # Warn at 80% of PID max
POD_PID_WARN=80      # Warn if any namespace near PID limit

# System-wide PID usage
PID_MAX=$(cat /proc/sys/kernel/pid_max)
PID_CURRENT=$(cat /proc/sys/kernel/ns_last_pid 2>/dev/null || ls /proc | grep -c "^[0-9]")
PID_PCT=$(echo "scale=0; ${PID_CURRENT} * 100 / ${PID_MAX}" | bc)

if [ "${PID_PCT}" -ge "${SYSTEM_PID_WARN}" ]; then
    echo "System PID usage ${PID_PCT}%: ${PID_CURRENT}/${PID_MAX}"
    exit 1
fi

# Check per-cgroup PID limits for containers
# Find containers with >80% PID limit usage
for pids_max in /sys/fs/cgroup/pids/kubepods/**/pids.max; do
    max=$(cat "$pids_max" 2>/dev/null)
    [ "$max" = "max" ] && continue
    [ -z "$max" ] && continue

    dir=$(dirname "$pids_max")
    current=$(cat "${dir}/pids.current" 2>/dev/null || echo "0")
    pct=$(echo "scale=0; ${current} * 100 / ${max}" | bc 2>/dev/null || echo "0")

    if [ "${pct}" -ge "${POD_PID_WARN}" ]; then
        echo "Container cgroup at ${pct}% PID limit: ${current}/${max} in ${dir}"
        exit 1
    fi
done

echo "PID usage healthy: ${PID_PCT}% system-wide"
exit 0
```

## Packaging Plugins in ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-detector-config
  namespace: kube-system
data:
  kernel-monitor.json: |
    {
      "plugin": "filelog",
      ...
    }
  custom-plugins.json: |
    {
      "plugin": "custom",
      ...
    }
  check-ntp.sh: |
    #!/bin/bash
    # (content of check-ntp.sh)
  check-disk-io.sh: |
    #!/bin/bash
    # (content of check-disk-io.sh)
  check-conntrack.sh: |
    #!/bin/bash
    # (content of check-conntrack.sh)
  check-pid-pressure.sh: |
    #!/bin/bash
    # (content of check-pid-pressure.sh)
```

Note: The ConfigMap must mount the scripts as executable. Use an init container or `defaultMode: 0755` in the volume mount.

```yaml
volumes:
- name: config
  configMap:
    name: node-problem-detector-config
    defaultMode: 0755  # Scripts need execute permission
```

## Integrating with Cluster Autoscaler

### NodeConditions That Trigger Autoscaler Draining

The Cluster Autoscaler can be configured to drain and replace nodes with specific NodeConditions. This creates a self-healing loop:

1. NPD detects a problem and sets a NodeCondition to True
2. Cluster Autoscaler sees the NodeCondition
3. Autoscaler marks the node unschedulable and drains it
4. Autoscaler provisions a replacement node

```yaml
# Cluster Autoscaler configuration to act on NPD conditions
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-autoscaler-status
  namespace: kube-system
data:
  # These expander priorities are used with the priority expander
  priorities: |
    10:
      - .*

---
# The --node-group-auto-discovery and --balance-similar-node-groups flags
# are set in the Cluster Autoscaler Deployment.
# Key flag: --skip-nodes-with-system-pods=false to allow draining nodes with NPD
```

```yaml
# Cluster Autoscaler deployment with NPD-aware node eviction
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
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.29.0
        command:
        - ./cluster-autoscaler
        - --v=4
        - --stderrthreshold=info
        - --cloud-provider=aws
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production-cluster
        # Scale down nodes with these NPD conditions
        - --node-deletion-delay-after-taint=10s
        - --scale-down-enabled=true
        - --scale-down-unneeded-time=10m
        # Allow autoscaler to drain nodes marked by NPD
        - --max-graceful-termination-sec=600
```

### Automatic Node Cordon via NPD Webhook

NPD does not automatically cordon nodes — it only sets conditions. Create a controller to watch for specific NodeConditions and act:

```go
package controller

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/watch"
    "k8s.io/client-go/kubernetes"
    "go.uber.org/zap"
)

// NodeHealthController watches NodeConditions set by NPD and takes action
type NodeHealthController struct {
    client kubernetes.Interface
    logger *zap.Logger

    // NodeConditions that should trigger automatic cordon
    cordonConditions map[string]bool
    // NodeConditions that should trigger drain + delete
    drainConditions  map[string]bool
}

func NewNodeHealthController(client kubernetes.Interface, logger *zap.Logger) *NodeHealthController {
    return &NodeHealthController{
        client: client,
        logger: logger,
        cordonConditions: map[string]bool{
            "NTPProblem":            true,  // Time drift affects TLS/JWT
            "DiskIOProblem":         true,  // I/O errors risk data corruption
        },
        drainConditions: map[string]bool{
            "KernelDeadlock":        true,  // Node is likely stuck
            "ReadonlyFilesystem":    true,  // Container writes will fail
            "CorruptDockerOverlay2": true,  // Container starts will fail
        },
    }
}

func (c *NodeHealthController) Run(ctx context.Context) error {
    watcher, err := c.client.CoreV1().Nodes().Watch(ctx, metav1.ListOptions{})
    if err != nil {
        return fmt.Errorf("failed to watch nodes: %w", err)
    }
    defer watcher.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil
        case event, ok := <-watcher.ResultChan():
            if !ok {
                return fmt.Errorf("node watch channel closed")
            }
            if event.Type == watch.Modified {
                node, ok := event.Object.(*corev1.Node)
                if !ok {
                    continue
                }
                c.handleNodeConditions(ctx, node)
            }
        }
    }
}

func (c *NodeHealthController) handleNodeConditions(ctx context.Context, node *corev1.Node) {
    for _, cond := range node.Status.Conditions {
        if cond.Status != corev1.ConditionTrue {
            continue
        }

        condName := string(cond.Type)

        if c.drainConditions[condName] && !node.Spec.Unschedulable {
            c.logger.Warn("critical NPD condition detected, cordoning node",
                zap.String("node", node.Name),
                zap.String("condition", condName),
                zap.String("reason", cond.Reason),
                zap.String("message", cond.Message),
            )

            if err := c.cordonNode(ctx, node.Name); err != nil {
                c.logger.Error("failed to cordon node", zap.Error(err))
            }
        } else if c.cordonConditions[condName] && !node.Spec.Unschedulable {
            c.logger.Warn("NPD condition detected, cordoning node",
                zap.String("node", node.Name),
                zap.String("condition", condName),
            )
            if err := c.cordonNode(ctx, node.Name); err != nil {
                c.logger.Error("failed to cordon node", zap.Error(err))
            }
        }
    }
}

func (c *NodeHealthController) cordonNode(ctx context.Context, nodeName string) error {
    node, err := c.client.CoreV1().Nodes().Get(ctx, nodeName, metav1.GetOptions{})
    if err != nil {
        return err
    }

    if node.Spec.Unschedulable {
        return nil // Already cordoned
    }

    node.Spec.Unschedulable = true
    _, err = c.client.CoreV1().Nodes().Update(ctx, node, metav1.UpdateOptions{})
    return err
}
```

## Prometheus Integration

### NPD Metrics

NPD exports Prometheus metrics at `:20257/metrics`:

```promql
# Number of problem occurrences by type and source
problem_counter{reason="OOMKilling", source="kernel-monitor"}

# Current condition status
problem_gauge{condition="KernelDeadlock", node="node-01"}

# Custom plugin exit codes
custom_plugin_exit_code{plugin="check-ntp", node="node-01"}
```

### Prometheus Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-problem-detector-alerts
  namespace: monitoring
spec:
  groups:
  - name: node-problem-detector
    rules:
    # Alert on persistent node conditions
    - alert: NodeKernelDeadlock
      expr: |
        problem_gauge{condition="KernelDeadlock"} == 1
      for: 0m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Kernel deadlock on {{ $labels.node }}"
        description: "Node {{ $labels.node }} has a kernel deadlock. The node requires immediate attention and likely needs to be drained and rebooted."

    - alert: NodeReadonlyFilesystem
      expr: |
        problem_gauge{condition="ReadonlyFilesystem"} == 1
      for: 0m
      labels:
        severity: critical
        team: platform
      annotations:
        summary: "Read-only filesystem on {{ $labels.node }}"
        description: "Node {{ $labels.node }} has remounted its filesystem read-only. Container operations will fail. Node requires immediate replacement."

    - alert: NodeNTPDrift
      expr: |
        problem_gauge{condition="NTPProblem"} == 1
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "NTP synchronization problem on {{ $labels.node }}"
        description: "Node {{ $labels.node }} has NTP drift exceeding threshold. Certificate validation and distributed system coordination may be affected."

    - alert: NodeOOMKillFrequent
      expr: |
        rate(problem_counter{reason="OOMKilling"}[5m]) > 0.1
      for: 2m
      labels:
        severity: warning
      annotations:
        summary: "Frequent OOM kills on {{ $labels.node }}"
        description: "Node {{ $labels.node }} is experiencing >1 OOM kill per 10 seconds. Consider increasing node memory or reducing workload density."

    - alert: NodeConntrackNearLimit
      expr: |
        problem_gauge{condition="ConntrackPressure"} == 1
      for: 5m
      labels:
        severity: warning
        team: network
      annotations:
        summary: "Conntrack table near saturation on {{ $labels.node }}"
        description: "Node {{ $labels.node }} conntrack table >75% full. Network connections may start failing."

    # Alert when NPD itself is unhealthy
    - alert: NPDDown
      expr: |
        up{job="node-problem-detector"} == 0
      for: 5m
      labels:
        severity: warning
        team: platform
      annotations:
        summary: "Node Problem Detector down on {{ $labels.instance }}"
        description: "NPD is not running on {{ $labels.instance }}. Node problems will not be reported to Kubernetes."
```

## Viewing Node Conditions

```bash
# List all custom conditions on all nodes
kubectl get nodes -o custom-columns=\
'NAME:.metadata.name,CONDITIONS:.status.conditions[*].type' | head -20

# Check specific NPD conditions
kubectl get nodes -o json | \
  jq -r '.items[] |
    .metadata.name as $name |
    .status.conditions[] |
    select(.type | IN("KernelDeadlock", "ReadonlyFilesystem", "NTPProblem", "DiskIOProblem")) |
    "\($name): \(.type)=\(.status) [\(.reason)] \(.message)"'

# Show all non-True conditions that NPD manages
kubectl get nodes -o json | \
  jq -r '.items[] |
    .metadata.name as $name |
    .status.conditions[] |
    select(.status == "True") |
    select(.type | test("KernelDeadlock|ReadOnly|NTP|Disk|Conntrack")) |
    "PROBLEM: \($name) | \(.type) | \(.reason) | \(.message)"'

# View NPD events
kubectl get events -n kube-system \
  --field-selector source=node-problem-detector \
  --sort-by=.metadata.creationTimestamp | \
  tail -20
```

## Operational Best Practices

**Tune thresholds for environment**: Default NTP drift thresholds may be too sensitive in cloud environments where hypervisor time synchronization adds expected variability. Measure baseline drift before setting thresholds.

**Separate critical from non-critical conditions**: Not all NPD conditions warrant automatic cordon. NTP drift may warrant alerting but not immediate cordon; kernel deadlock warrants immediate drain.

**Test plugins in privileged containers before deployment**: Custom plugins run in the NPD container with host access. Test them manually before deploying to avoid false positives that cause unnecessary cordon events.

**Monitor NPD resource consumption**: The `filelog` plugin can consume CPU during log file rotation events. Set resource limits conservatively (200m CPU, 128Mi) and monitor with `container_cpu_usage_seconds_total`.

**Use heartbeat events for NPD liveness verification**: Configure `--k8s-exporter-heartbeat-period=5m` to emit periodic events, and alert if no heartbeat events appear for 15 minutes.
