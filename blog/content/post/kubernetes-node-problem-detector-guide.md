---
title: "Kubernetes Node Problem Detector: Automated Node Health Management and Self-Healing"
date: 2027-05-30T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "Node Health", "Reliability", "Operations"]
categories: ["Kubernetes", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "A production guide to deploying and configuring Kubernetes Node Problem Detector for automated node health monitoring, kernel issue detection, taint-based eviction, and self-healing remediation with Node Healthcheck Controller."
more_link: "yes"
url: "/kubernetes-node-problem-detector-guide/"
---

Node Problem Detector (NPD) is the Kubernetes component responsible for surfacing hardware, kernel, and runtime faults as node conditions and events before they silently degrade workload performance or cause cascading failures. Without NPD, a node with disk corruption, kernel oops, or container runtime deadlock appears healthy to the scheduler and continues receiving pods that will never run successfully. This guide covers NPD architecture, problem type definitions, custom rule authoring, Prometheus metrics integration, and automated remediation with Node Healthcheck Controller in enterprise production environments.

<!--more-->

## NPD Architecture and Component Overview

Node Problem Detector runs as a DaemonSet on every node in the cluster. It reads from system logs, kernel ring buffers, and custom scripts, then translates detected problems into Kubernetes API objects that the scheduler, controllers, and operators can act upon.

NPD exposes two categories of output:

- **NodeCondition**: A persistent condition on the Node object (e.g., `KernelDeadlock=True`). Conditions persist until explicitly cleared and can block scheduling via taints.
- **NodeEvent**: A transient event recorded against the Node object. Events expire but are valuable for alerting and audit history.

### Monitors

NPD ships with three built-in monitor types:

**SystemLogMonitor** watches syslog, journald, or kernel log files. Rules are defined as regular expression patterns with associated severity and output type. This monitor handles the majority of kernel and OS-level problems.

**CustomPluginMonitor** executes arbitrary scripts or binaries on a configurable interval. Scripts return an exit code: 0 for healthy, non-zero for a problem. This monitor is appropriate for checks that require active probing rather than log parsing, such as disk read/write tests, DNS resolution checks, or NTP drift measurements.

**SystemStatsMonitor** collects host-level statistics (CPU, memory, disk) and exposes them as Prometheus metrics directly from the node. It does not generate conditions or events but provides the telemetry substrate for capacity and health dashboards.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Node Problem Detector Pod                   │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
│  │ SystemLogMonitor │  │CustomPluginMonitor│  │SystemStats   │  │
│  │                  │  │                  │  │Monitor       │  │
│  │ /var/log/syslog  │  │ /config/plugins/ │  │              │  │
│  │ journald         │  │ scripts/*.sh     │  │ CPU/Mem/Disk │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘  │
│           │                     │                    │          │
│           └──────────┬──────────┘                    │          │
│                      ▼                               ▼          │
│              ┌───────────────┐              ┌────────────────┐  │
│              │  Problem API  │              │ Prometheus     │  │
│              │  (conditions, │              │ /metrics       │  │
│              │   events)     │              │                │  │
│              └───────┬───────┘              └────────────────┘  │
│                      │                                          │
└──────────────────────┼──────────────────────────────────────────┘
                       ▼
              Kubernetes API Server
              Node.Status.Conditions
              Node Events
```

## DaemonSet Deployment

The recommended deployment method uses the official Helm chart or a raw DaemonSet manifest. Production deployments require host log volume mounts, appropriate RBAC, and tolerations for tainted nodes so NPD continues monitoring degraded nodes.

```yaml
# npd-daemonset.yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-problem-detector
  namespace: kube-system
  labels:
    app: node-problem-detector
    app.kubernetes.io/version: "0.8.15"
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
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: node-problem-detector
      # Must tolerate all taints to monitor degraded nodes
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
        - key: node.kubernetes.io/not-ready
          operator: Exists
          effect: NoExecute
        - key: node.kubernetes.io/unreachable
          operator: Exists
          effect: NoExecute
        - key: node.kubernetes.io/disk-pressure
          operator: Exists
          effect: NoSchedule
        - key: node.kubernetes.io/memory-pressure
          operator: Exists
          effect: NoSchedule
      # Prefer faster restarts on degraded nodes
      priorityClassName: system-node-critical
      hostNetwork: false
      hostPID: false
      containers:
        - name: node-problem-detector
          image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.15
          command:
            - /node-problem-detector
            - --logtostderr
            - --system-log-monitors=/config/kernel-monitor.json,/config/docker-monitor.json,/config/systemd-monitor.json
            - --custom-plugin-monitors=/config/custom-plugin-monitor.json
            - --system-stats-monitor=/config/system-stats-monitor.json
            - --prometheus-address=0.0.0.0
            - --prometheus-port=20257
            - --k8s-exporter-heartbeat-period=5m
          securityContext:
            privileged: false
            capabilities:
              drop:
                - ALL
              add:
                - SYS_PTRACE
          resources:
            requests:
              cpu: 20m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 256Mi
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
          ports:
            - name: metrics
              containerPort: 20257
              protocol: TCP
          livenessProbe:
            httpGet:
              path: /healthz
              port: 20257
            initialDelaySeconds: 5
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /healthz
              port: 20257
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: log
          hostPath:
            path: /var/log
        - name: kmsg
          hostPath:
            path: /dev/kmsg
        - name: localtime
          hostPath:
            path: /etc/localtime
        - name: config
          configMap:
            name: node-problem-detector-config
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
```

## RBAC Configuration

NPD requires permission to update node conditions and create events.

```yaml
# npd-rbac.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
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
    verbs: ["get", "patch", "update"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch", "update"]
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
```

## Kernel Issue Detection Rules

### Memory Pressure and OOM Detection

The kernel OOM killer logs distinctive messages when it terminates processes. These messages indicate the node is running out of memory and may require workload eviction or node cordon.

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
    },
    {
      "type": "FrequentKubeletRestart",
      "reason": "NoFrequentKubeletRestart",
      "message": "kubelet is functioning properly"
    },
    {
      "type": "FrequentContainerdRestart",
      "reason": "NoFrequentContainerdRestart",
      "message": "containerd is functioning properly"
    },
    {
      "type": "MemoryPressure",
      "reason": "KernelHasNoMemoryPressure",
      "message": "kernel has no memory pressure"
    },
    {
      "type": "DiskPressure",
      "reason": "KernelHasNoDiskPressure",
      "message": "kernel has no disk pressure"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "OOMKilling",
      "pattern": "Kill process \\d+ (.+) score \\d+ or sacrifice child\\nKilled process \\d+ (.+) total-vm:\\d+kB, anon-rss:\\d+kB, file-rss:\\d+kB.*"
    },
    {
      "type": "temporary",
      "reason": "TaskHung",
      "pattern": "task .{1,32} blocked for more than \\d+ seconds\\."
    },
    {
      "type": "temporary",
      "reason": "UnregisterNetDevice",
      "pattern": "unregister_netdevice: waiting for .* to become free. Usage count = \\d+"
    },
    {
      "type": "temporary",
      "reason": "KernelOops",
      "pattern": "BUG: unable to handle kernel NULL pointer dereference at .*"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "AUFSUmountHung",
      "pattern": "task umount\\.aufs:\\d+ blocked for more than \\d+ seconds\\."
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
    },
    {
      "type": "permanent",
      "condition": "MemoryPressure",
      "reason": "MemoryOOMKillFrequent",
      "pattern": "Memory cgroup out of memory: Kill process \\d+"
    },
    {
      "type": "permanent",
      "condition": "DiskPressure",
      "reason": "IOError",
      "pattern": "Buffer I/O error on device .*, logical block \\d+"
    },
    {
      "type": "permanent",
      "condition": "DiskPressure",
      "reason": "XFSErrors",
      "pattern": "XFS .* Filesystem has been shut down due to log error"
    }
  ]
}
```

### Containerd and Runtime Issue Detection

Container runtime failures are a leading cause of mysterious pod failures that appear as scheduling problems. NPD detects containerd deadlocks, panic conditions, and RPC timeouts.

```json
{
  "plugin": "journald",
  "pluginConfig": {
    "source": "containerd"
  },
  "logPath": "/var/log/journal",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "containerd-monitor",
  "conditions": [
    {
      "type": "FrequentContainerdRestart",
      "reason": "NoFrequentContainerdRestart",
      "message": "containerd is functioning properly"
    },
    {
      "type": "ContainerdUnhealthy",
      "reason": "ContainerdIsHealthy",
      "message": "containerd is running and healthy"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "ContainerdStart",
      "pattern": "Starting containerd"
    },
    {
      "type": "permanent",
      "condition": "FrequentContainerdRestart",
      "reason": "FrequentContainerdRestart",
      "pattern": "containerd has started \\d+ times in the last hour"
    },
    {
      "type": "temporary",
      "reason": "ContainerdRPCTimeout",
      "pattern": "context deadline exceeded"
    },
    {
      "type": "permanent",
      "condition": "ContainerdUnhealthy",
      "reason": "ContainerdPanic",
      "pattern": "panic: .*"
    },
    {
      "type": "temporary",
      "reason": "ContainerdCNIError",
      "pattern": "Error adding network: .*"
    },
    {
      "type": "permanent",
      "condition": "ContainerdUnhealthy",
      "reason": "ContainerdSnapshotterError",
      "pattern": "snapshotter.*has been broken"
    }
  ]
}
```

### Network Issue Detection

Network problems frequently manifest as subtle, intermittent failures rather than hard outages. NPD can detect NIC errors, conntrack table exhaustion, and bridge/iptables issues.

```json
{
  "plugin": "kmsg",
  "logPath": "/dev/kmsg",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "network-monitor",
  "conditions": [
    {
      "type": "NetworkProblem",
      "reason": "NetworkIsOK",
      "message": "node network is functioning"
    },
    {
      "type": "ConntrackFull",
      "reason": "ConntrackIsNotFull",
      "message": "conntrack table is not full"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "NetworkProblem",
      "reason": "NICDown",
      "pattern": "eth\\d+: carrier lost"
    },
    {
      "type": "permanent",
      "condition": "NetworkProblem",
      "reason": "NICError",
      "pattern": "\\w+: transmit timeout"
    },
    {
      "type": "permanent",
      "condition": "ConntrackFull",
      "reason": "ConntrackTableFull",
      "pattern": "nf_conntrack: table full, dropping packet"
    },
    {
      "type": "temporary",
      "reason": "IPTablesError",
      "pattern": "ip_tables: .* fails to register"
    },
    {
      "type": "temporary",
      "reason": "BridgeFDBCorruption",
      "pattern": "bridge: .*FDB: duplicate entry"
    }
  ]
}
```

## Custom Plugin Monitor

The custom plugin monitor executes scripts that perform active health checks not possible through log parsing. Each plugin must return 0 for healthy and non-zero for a problem detected.

### Disk Health Plugin

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "30s",
    "timeout": "20s",
    "max_output_length": 80,
    "concurrency": 1
  },
  "source": "custom-plugin-monitor",
  "conditions": [
    {
      "type": "DiskIOError",
      "reason": "DiskIOIsOK",
      "message": "disk IO is normal"
    },
    {
      "type": "NFSConnectivityProblem",
      "reason": "NFSIsReachable",
      "message": "NFS mount points are reachable"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "DiskIOError",
      "reason": "DiskReadError",
      "path": "/config/plugin/check-disk-io.sh"
    },
    {
      "type": "permanent",
      "condition": "NFSConnectivityProblem",
      "reason": "NFSMountUnreachable",
      "path": "/config/plugin/check-nfs.sh"
    }
  ]
}
```

The corresponding disk IO check script:

```bash
#!/bin/bash
# check-disk-io.sh - Validates disk read/write capability on critical paths
# Returns: 0 = healthy, 1 = degraded, 2 = failed

set -euo pipefail

TIMEOUT=15
TEST_DIR="/var/lib/kubelet"
TEST_FILE="${TEST_DIR}/.npd-disk-check-$$"
MIN_SPEED_MB=10  # Minimum acceptable write speed in MB/s

# Verify the kubelet data directory is writable
if ! timeout "${TIMEOUT}" dd if=/dev/zero of="${TEST_FILE}" bs=1M count=10 oflag=direct 2>/tmp/dd-output; then
    echo "DiskIOFailed: Cannot write to ${TEST_DIR}"
    rm -f "${TEST_FILE}"
    exit 2
fi

# Parse write speed from dd output
SPEED=$(grep -oP '\d+\.?\d* MB/s' /tmp/dd-output | grep -oP '\d+\.?\d*' || echo "0")
rm -f "${TEST_FILE}"

if (( $(echo "${SPEED} < ${MIN_SPEED_MB}" | bc -l) )); then
    echo "DiskIODegraded: Write speed ${SPEED} MB/s is below minimum ${MIN_SPEED_MB} MB/s"
    exit 1
fi

# Check for filesystem errors
if dmesg | grep -E 'EXT4-fs error|XFS .* Filesystem has been shut down' | grep -q "$(date '+%b %e')" 2>/dev/null; then
    echo "FilesystemErrors: Recent filesystem errors detected in dmesg"
    exit 2
fi

echo "OK: Disk IO healthy at ${SPEED} MB/s"
exit 0
```

### NTP Drift Check Plugin

```bash
#!/bin/bash
# check-ntp-drift.sh - Validates NTP synchronization and clock drift
# Excessive clock drift causes certificate validation failures and distributed system issues

set -euo pipefail

MAX_DRIFT_MS=100  # Maximum acceptable drift in milliseconds
MAX_OFFSET_S=1    # Maximum acceptable offset in seconds before alarm

# Try chronyc first (preferred), fall back to ntpstat
if command -v chronyc &>/dev/null; then
    TRACKING=$(chronyc tracking 2>/dev/null)

    if ! echo "${TRACKING}" | grep -q "Reference ID"; then
        echo "NTPNotSynchronized: chrony is not synchronized to a time source"
        exit 2
    fi

    OFFSET=$(echo "${TRACKING}" | grep "System time" | awk '{print $4}')
    OFFSET_MS=$(echo "${OFFSET} * 1000" | bc 2>/dev/null | cut -d. -f1 || echo "999")

    if [ "${OFFSET_MS#-}" -gt "${MAX_DRIFT_MS}" ]; then
        echo "NTPDrift: System clock offset ${OFFSET}s exceeds threshold of $((MAX_DRIFT_MS))ms"
        exit 1
    fi
elif command -v ntpstat &>/dev/null; then
    if ! ntpstat &>/dev/null; then
        echo "NTPNotSynchronized: ntpd is not synchronized"
        exit 2
    fi
else
    # No NTP tool available — emit a warning but do not fail
    echo "NTPToolMissing: Neither chronyc nor ntpstat found"
    exit 0
fi

echo "OK: NTP synchronized"
exit 0
```

### DNS Resolution Check Plugin

```bash
#!/bin/bash
# check-dns-resolution.sh - Validates DNS resolution from the node level
# Node-level DNS issues affect all pods but may not be visible from within pods

set -euo pipefail

TIMEOUT=5
TEST_DOMAINS=(
    "kubernetes.default.svc.cluster.local"
    "google.com"
)
DNS_SERVER="${1:-$(grep nameserver /etc/resolv.conf | head -1 | awk '{print $2}')}"

for DOMAIN in "${TEST_DOMAINS[@]}"; do
    if ! timeout "${TIMEOUT}" dig "@${DNS_SERVER}" "${DOMAIN}" +short +time=3 &>/dev/null; then
        echo "DNSResolutionFailed: Cannot resolve ${DOMAIN} via ${DNS_SERVER}"
        exit 2
    fi
done

# Check for high DNS latency
LATENCY=$(dig "@${DNS_SERVER}" "google.com" | grep "Query time" | awk '{print $4}')
if [ -n "${LATENCY}" ] && [ "${LATENCY}" -gt 500 ]; then
    echo "DNSHighLatency: DNS query latency ${LATENCY}ms exceeds 500ms threshold"
    exit 1
fi

echo "OK: DNS resolution functioning normally"
exit 0
```

## System Stats Monitor Configuration

```json
{
  "invokeInterval": "60s",
  "enableCPUMetrics": true,
  "enableMemoryMetrics": true,
  "enableDiskMetrics": true,
  "enableNetworkMetrics": true,
  "diskConfig": {
    "includeRootBlk": true,
    "includeAllAttachedBlk": true,
    "lsblkTimeout": "5s"
  }
}
```

## Prometheus Metrics from NPD

NPD exposes problem counts and node condition states as Prometheus metrics on port 20257. These metrics enable alerting on problem frequency and condition duration.

Key metrics exposed:

| Metric | Type | Description |
|---|---|---|
| `problem_counter` | Counter | Number of times each problem type has been detected |
| `problem_gauge` | Gauge | Current state of node conditions (1=problem, 0=healthy) |
| `node_problem_detector_build_info` | Gauge | Build version information |

### Prometheus Rules for NPD Alerting

```yaml
# npd-prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-problem-detector-alerts
  namespace: monitoring
  labels:
    prometheus: kube-prometheus
    role: alert-rules
spec:
  groups:
    - name: node-problem-detector
      interval: 30s
      rules:
        - alert: NodeKernelDeadlock
          expr: problem_gauge{reason="KernelDeadlock"} == 1
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Node {{ $labels.node }} has a kernel deadlock"
            description: "Node {{ $labels.node }} has reported a kernel deadlock condition. Immediate investigation required. Pods on this node may be stuck."
            runbook_url: "https://runbooks.example.com/node-kernel-deadlock"

        - alert: NodeReadonlyFilesystem
          expr: problem_gauge{reason="ReadonlyFilesystem"} == 1
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Node {{ $labels.node }} filesystem is read-only"
            description: "Node {{ $labels.node }} has remounted its filesystem as read-only due to errors. Node must be drained and investigated."
            runbook_url: "https://runbooks.example.com/node-readonly-filesystem"

        - alert: NodeFrequentContainerdRestart
          expr: problem_gauge{reason="FrequentContainerdRestart"} == 1
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Containerd on node {{ $labels.node }} is restarting frequently"
            description: "Containerd has restarted multiple times on node {{ $labels.node }}. This may cause pod failures and scheduling instability."
            runbook_url: "https://runbooks.example.com/containerd-frequent-restart"

        - alert: NodeOOMKillRate
          expr: rate(problem_counter{reason="OOMKilling"}[5m]) > 0.1
          for: 2m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "High OOM kill rate on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} is experiencing OOM kills at rate {{ $value | humanize }}/s. Review pod memory limits on this node."
            runbook_url: "https://runbooks.example.com/node-oom-kill-rate"

        - alert: NodeConntrackTableFull
          expr: problem_gauge{reason="ConntrackTableFull"} == 1
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Node {{ $labels.node }} conntrack table is full"
            description: "Node {{ $labels.node }} conntrack table is full. New connections will be dropped. Increase nf_conntrack_max or reduce connections."
            runbook_url: "https://runbooks.example.com/node-conntrack-full"

        - alert: NodeDiskIOProblem
          expr: problem_gauge{reason="DiskIOFailed"} == 1
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Disk IO failure detected on node {{ $labels.node }}"
            description: "Custom disk IO check failed on node {{ $labels.node }}. Stateful workloads on this node are at risk."

        - alert: NodeNTPDrift
          expr: problem_gauge{reason="NTPDrift"} == 1
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "NTP drift detected on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} has significant NTP drift. Certificate validation and distributed systems may be affected."

        - alert: NodeNetworkProblem
          expr: problem_gauge{reason=~"NICDown|NICError"} == 1
          for: 0m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Network problem on node {{ $labels.node }}: {{ $labels.reason }}"
            description: "Node {{ $labels.node }} has a network hardware problem. Workloads will experience connectivity issues."
```

## Node Remediation with Node Healthcheck Controller

Node Healthcheck Controller (NHC) is a Kubernetes operator that acts on NPD conditions to automatically trigger node remediation actions. NHC integrates with remediation providers such as Self Node Remediation (SNR) and Machine Deletion Remediation.

### Installing Node Healthcheck Controller

```bash
# Install via OperatorHub/OLM (OpenShift and community clusters)
kubectl apply -f https://raw.githubusercontent.com/medik8s/node-healthcheck-operator/main/config/install/namespace.yaml

# Or via Helm
helm repo add medik8s https://medik8s.github.io/medik8s-helm-charts
helm repo update
helm install node-healthcheck-operator medik8s/node-healthcheck-operator \
  --namespace node-healthcheck-operator \
  --create-namespace \
  --version 0.9.0
```

### NodeHealthCheck Resource

```yaml
# node-healthcheck.yaml
apiVersion: remediation.medik8s.io/v1alpha1
kind: NodeHealthCheck
metadata:
  name: node-healthcheck
spec:
  # Minimum healthy nodes required before remediation can start
  # Prevents mass remediation that could leave the cluster without quorum
  minHealthy: "51%"

  selector:
    matchExpressions:
      - key: kubernetes.io/os
        operator: In
        values: ["linux"]
      - key: node-role.kubernetes.io/control-plane
        operator: DoesNotExist

  unhealthyConditions:
    # Standard Kubernetes node conditions
    - type: Ready
      status: "False"
      duration: 300s
    - type: Ready
      status: Unknown
      duration: 300s

    # NPD-generated conditions
    - type: KernelDeadlock
      status: "True"
      duration: 0s
    - type: ReadonlyFilesystem
      status: "True"
      duration: 0s
    - type: FrequentContainerdRestart
      status: "True"
      duration: 600s
    - type: DiskIOError
      status: "True"
      duration: 120s
    - type: NetworkProblem
      status: "True"
      duration: 60s

  remediationTemplate:
    apiVersion: self-node-remediation.medik8s.io/v1alpha1
    kind: SelfNodeRemediationTemplate
    namespace: default
    name: self-node-remediation-resource-deletion-template
```

### Self Node Remediation Configuration

Self Node Remediation (SNR) reboots or performs resource deletion to recover unhealthy nodes without requiring external power management infrastructure.

```yaml
# snr-template.yaml
apiVersion: self-node-remediation.medik8s.io/v1alpha1
kind: SelfNodeRemediationTemplate
metadata:
  name: self-node-remediation-resource-deletion-template
  namespace: default
spec:
  template:
    spec:
      # RemediationStrategy options:
      # - ResourceDeletion: deletes pods and associated resources, allows rescheduling
      # - OutOfServiceTaint: applies out-of-service taint (requires node-lifecycle-controller)
      remediationStrategy: ResourceDeletion

      # Time to wait for the node to recover before taking action
      safeTimeToAssumeNodeRebootedSeconds: 180
```

## Taint-Based Eviction Integration

NPD integrates with the node lifecycle controller to apply NoSchedule and NoExecute taints based on detected conditions. This prevents new pods from being scheduled on degraded nodes while triggering graceful eviction of existing workloads.

### Custom Taint Controller

For conditions not handled natively by Kubernetes, a custom controller or CronJob can apply taints based on NPD conditions:

```python
#!/usr/bin/env python3
"""
npd-taint-controller.py
Watches NPD conditions on nodes and applies corresponding taints.
Deploy as a Deployment with appropriate RBAC permissions.
"""
import time
import logging
from kubernetes import client, config, watch

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

# Map NPD condition types to taint keys
CONDITION_TAINT_MAP = {
    "KernelDeadlock": {
        "key": "node.support.tools/kernel-deadlock",
        "effect": "NoSchedule",
    },
    "ReadonlyFilesystem": {
        "key": "node.support.tools/readonly-filesystem",
        "effect": "NoExecute",
    },
    "DiskIOError": {
        "key": "node.support.tools/disk-io-error",
        "effect": "NoSchedule",
    },
    "NetworkProblem": {
        "key": "node.support.tools/network-problem",
        "effect": "NoSchedule",
    },
    "ContainerdUnhealthy": {
        "key": "node.support.tools/containerd-unhealthy",
        "effect": "NoSchedule",
    },
    "FrequentContainerdRestart": {
        "key": "node.support.tools/containerd-restart-frequent",
        "effect": "NoSchedule",
    },
}


def apply_taint(v1: client.CoreV1Api, node_name: str, taint_key: str, effect: str):
    node = v1.read_node(node_name)
    existing_taints = node.spec.taints or []

    # Idempotent: check if taint already exists
    for t in existing_taints:
        if t.key == taint_key and t.effect == effect:
            return

    new_taint = client.V1Taint(key=taint_key, effect=effect,
                                value="true",
                                time_added=None)
    existing_taints.append(new_taint)

    patch = {"spec": {"taints": [
        {"key": t.key, "effect": t.effect, "value": t.value}
        for t in existing_taints
    ]}}
    v1.patch_node(node_name, patch)
    logger.info("Applied taint %s:%s to node %s", taint_key, effect, node_name)


def remove_taint(v1: client.CoreV1Api, node_name: str, taint_key: str, effect: str):
    node = v1.read_node(node_name)
    existing_taints = node.spec.taints or []
    updated_taints = [t for t in existing_taints
                      if not (t.key == taint_key and t.effect == effect)]

    if len(updated_taints) == len(existing_taints):
        return  # Taint was not present

    patch = {"spec": {"taints": [
        {"key": t.key, "effect": t.effect, "value": t.value}
        for t in updated_taints
    ]}}
    v1.patch_node(node_name, patch)
    logger.info("Removed taint %s:%s from node %s", taint_key, effect, node_name)


def process_node(v1: client.CoreV1Api, node):
    conditions = {c.type: c for c in (node.status.conditions or [])}

    for condition_type, taint_config in CONDITION_TAINT_MAP.items():
        condition = conditions.get(condition_type)
        if condition and condition.status == "True":
            apply_taint(v1, node.metadata.name,
                       taint_config["key"], taint_config["effect"])
        else:
            remove_taint(v1, node.metadata.name,
                        taint_config["key"], taint_config["effect"])


def main():
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()

    v1 = client.CoreV1Api()
    w = watch.Watch()

    logger.info("NPD taint controller started")

    while True:
        try:
            for event in w.stream(v1.list_node, timeout_seconds=300):
                node = event["object"]
                process_node(v1, node)
        except Exception as e:
            logger.error("Watch error: %s, restarting in 10s", e)
            time.sleep(10)


if __name__ == "__main__":
    main()
```

## ConfigMap Assembly

The full ConfigMap bundles all monitor configurations:

```yaml
# npd-configmap.yaml
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
        },
        {
          "type": "MemoryPressure",
          "reason": "KernelHasNoMemoryPressure",
          "message": "kernel has no memory pressure"
        },
        {
          "type": "DiskPressure",
          "reason": "KernelHasNoDiskPressure",
          "message": "kernel has no disk pressure"
        }
      ],
      "rules": [
        {
          "type": "temporary",
          "reason": "OOMKilling",
          "pattern": "Kill process \\d+"
        },
        {
          "type": "temporary",
          "reason": "TaskHung",
          "pattern": "task .{1,32} blocked for more than \\d+ seconds\\."
        },
        {
          "type": "permanent",
          "condition": "KernelDeadlock",
          "reason": "AUFSUmountHung",
          "pattern": "task umount\\.aufs:\\d+ blocked for more than \\d+ seconds\\."
        },
        {
          "type": "permanent",
          "condition": "ReadonlyFilesystem",
          "reason": "FilesystemIsReadOnly",
          "pattern": "Remounting filesystem read-only"
        },
        {
          "type": "permanent",
          "condition": "MemoryPressure",
          "reason": "MemoryOOMKillFrequent",
          "pattern": "Memory cgroup out of memory: Kill process \\d+"
        },
        {
          "type": "permanent",
          "condition": "DiskPressure",
          "reason": "IOError",
          "pattern": "Buffer I/O error on device .*, logical block \\d+"
        }
      ]
    }
  custom-plugin-monitor.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invoke_interval": "30s",
        "timeout": "20s",
        "max_output_length": 80,
        "concurrency": 1
      },
      "source": "custom-plugin-monitor",
      "conditions": [
        {
          "type": "DiskIOError",
          "reason": "DiskIOIsOK",
          "message": "disk IO is normal"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "DiskIOError",
          "reason": "DiskReadError",
          "path": "/config/plugin/check-disk-io.sh"
        }
      ]
    }
  system-stats-monitor.json: |
    {
      "invokeInterval": "60s",
      "enableCPUMetrics": true,
      "enableMemoryMetrics": true,
      "enableDiskMetrics": true,
      "enableNetworkMetrics": true
    }
```

## Grafana Dashboard for NPD

A Grafana dashboard configuration that surfaces node problem conditions and rates:

```json
{
  "title": "Node Problem Detector",
  "uid": "npd-overview",
  "panels": [
    {
      "title": "Active Node Conditions",
      "type": "stat",
      "targets": [
        {
          "expr": "count(problem_gauge == 1)",
          "legendFormat": "Active Problems"
        }
      ]
    },
    {
      "title": "Problem Conditions by Node",
      "type": "table",
      "targets": [
        {
          "expr": "problem_gauge{} == 1",
          "legendFormat": "{{node}} - {{reason}}"
        }
      ]
    },
    {
      "title": "OOM Kill Rate",
      "type": "timeseries",
      "targets": [
        {
          "expr": "rate(problem_counter{reason='OOMKilling'}[5m])",
          "legendFormat": "{{node}}"
        }
      ]
    },
    {
      "title": "Problem Event Rate (all types)",
      "type": "timeseries",
      "targets": [
        {
          "expr": "sum by (reason) (rate(problem_counter[5m]))",
          "legendFormat": "{{reason}}"
        }
      ]
    }
  ]
}
```

## Operational Runbooks

### Responding to KernelDeadlock Condition

When NPD reports `KernelDeadlock=True` on a node:

```bash
# 1. Cordon the node to prevent new scheduling
kubectl cordon <node-name>

# 2. Check what conditions are set
kubectl describe node <node-name> | grep -A 20 "Conditions:"

# 3. Review recent NPD events
kubectl get events --field-selector involvedObject.name=<node-name> \
  --sort-by='.lastTimestamp' | tail -20

# 4. Check system logs on the node
kubectl debug node/<node-name> -it --image=ubuntu -- bash
# Inside the debug pod:
dmesg -T | tail -100
journalctl -n 500 --no-pager

# 5. If the node must be recovered in place, drain first
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data \
  --grace-period=60 --timeout=300s

# 6. Initiate node reboot via your infrastructure tooling
# (SSH, cloud console, IPMI)

# 7. After reboot, verify conditions cleared
kubectl wait --for=condition=Ready node/<node-name> --timeout=300s
kubectl uncordon <node-name>
```

### Clearing Stale NPD Conditions

NPD conditions persist until cleared. After a node recovers, conditions with `permanent` type must be explicitly reset by restarting NPD or by patching the node:

```bash
# Patch a specific condition to clear it
kubectl patch node <node-name> --type=json -p='[
  {
    "op": "replace",
    "path": "/status/conditions",
    "value": []
  }
]' --subresource=status

# Or restart NPD on the affected node to re-evaluate conditions
kubectl delete pod -n kube-system -l app=node-problem-detector \
  --field-selector spec.nodeName=<node-name>
```

## Production Tuning Recommendations

### Log Buffer Sizing

The `bufferSize` field controls how many log lines are buffered in memory. For high-throughput nodes with verbose kernel logging, increase this value to avoid dropped messages:

```json
{
  "bufferSize": 100,
  "lookback": "10m"
}
```

### Plugin Invocation Intervals

Custom plugin invocation intervals should balance detection latency against node CPU overhead. Disk IO checks are expensive — do not run them more frequently than every 30 seconds. DNS checks can run every 60 seconds. NTP checks can run every 5 minutes.

### Resource Limits

NPD is a critical observability component and should have reserved resources. The defaults are appropriate for most nodes, but nodes with many containers writing to syslog may require higher memory limits:

```yaml
resources:
  requests:
    cpu: 20m
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

### High-Availability Considerations

Because NPD is a DaemonSet, it runs one pod per node. The DaemonSet update strategy should use `RollingUpdate` with `maxUnavailable: 1` to ensure continuous coverage during upgrades. NPD itself does not require HA because each instance independently monitors its own node.

## Verification and Testing

After deploying NPD, validate that it is correctly reporting conditions:

```bash
# Verify NPD pods are running on all nodes
kubectl get pods -n kube-system -l app=node-problem-detector -o wide

# Check that NPD can reach the API server
kubectl logs -n kube-system -l app=node-problem-detector --tail=50 | grep -E "error|warn"

# Simulate an OOM condition to verify event generation
# (use a test namespace and a memory bomb pod)
kubectl run oom-test --image=ubuntu --rm -it --restart=Never \
  --limits=memory=64Mi -- bash -c "
    while true; do
      cat /dev/urandom | head -c 100M > /tmp/mem-$(date +%N)
    done
  "

# After the OOM kill, check for NPD events
kubectl get events --field-selector reason=OOMKilling

# Verify NPD metrics are being scraped
kubectl port-forward -n kube-system \
  $(kubectl get pod -n kube-system -l app=node-problem-detector -o name | head -1) \
  20257:20257 &
curl -s http://localhost:20257/metrics | grep problem_
```

Node Problem Detector transforms invisible node degradation into actionable Kubernetes API objects. When combined with Node Healthcheck Controller and Self Node Remediation, NPD enables fully automated self-healing workflows that reduce MTTR from hours to minutes and eliminate the category of silent node failures that drain on-call engineering capacity.
