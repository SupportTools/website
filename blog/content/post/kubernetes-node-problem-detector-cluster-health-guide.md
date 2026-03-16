---
title: "Node Problem Detector: Automated Kubernetes Node Health Monitoring"
date: 2027-03-03T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "Node Health", "Monitoring", "Operations"]
categories: ["Kubernetes", "Monitoring", "Operations"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to deploying and configuring Node Problem Detector for automated Kubernetes node health monitoring, including custom plugins, Prometheus integration, and cluster autoscaler remediation."
more_link: "yes"
url: "/kubernetes-node-problem-detector-cluster-health-guide/"
---

Silent node failures are among the most insidious problems in production Kubernetes clusters. A node may continue accepting pod scheduling while its kernel is throwing memory errors, its disk is failing, or its container runtime is in a degraded state — all without Kubernetes knowing anything is wrong. **Node Problem Detector (NPD)** bridges this gap by translating node-level system signals into first-class Kubernetes primitives that schedulers, autoscalers, and operators can act upon.

This guide covers NPD architecture, deployment, custom plugin development, Prometheus metrics export, and integration with Cluster Autoscaler and Alertmanager for automated remediation in production environments.

<!--more-->

## NPD Architecture

Node Problem Detector runs as a DaemonSet on every node in the cluster. It reads signals from multiple sources — kernel logs, systemd journals, custom scripts — and publishes findings through two output channels: **NodeConditions** and **Events**.

### Monitor Types

NPD ships with two built-in monitor types:

**SystemLogMonitor** reads structured log sources and matches lines against configurable pattern rules. It supports three backends:
- `filelog` — tails `/var/log/kern.log`, `/var/log/syslog`, or any path
- `journald` — reads from systemd journal units
- `kmsg` — reads directly from `/dev/kmsg`

**CustomPluginMonitor** executes external scripts or binaries on a configurable interval and interprets their exit codes as health signals. Exit code `0` means healthy, `1` means a temporary problem, `2` means a permanent problem.

### Output Channels

**NodeCondition** output modifies the node's `.status.conditions` array. Conditions persist across NPD restarts and are visible to the scheduler. When a condition is set to `True`, the default scheduler treats it as a signal for `kubectl describe node` and Cluster Autoscaler can cordon and drain the node.

**Event** output creates Kubernetes Events scoped to the node object. Events are ephemeral (TTL defaults to 1 hour) but show up in `kubectl get events` and feed observability tooling.

## Built-in Problem Daemons

NPD ships with several built-in problem daemons in `/config/` inside the container image.

### Kernel Monitor

The kernel monitor watches `kmsg` for OOM kills, memory corruption, file system errors, and task hung conditions.

```yaml
# /config/kernel-monitor.json (built-in)
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
      "pattern": "Kill process \\d+ (.+) score \\d+ or sacrifice child"
    },
    {
      "type": "temporary",
      "reason": "TaskHung",
      "pattern": "task \\S+:\\w+ blocked for more than \\w+ seconds"
    },
    {
      "type": "permanent",
      "reason": "UnregisterNetDevice",
      "pattern": "unregister_netdevice: waiting for \\S+ to become free"
    },
    {
      "type": "permanent",
      "reason": "KernelOops",
      "pattern": "BUG: unable to handle kernel"
    },
    {
      "type": "permanent",
      "reason": "KernelOops",
      "pattern": "divide error: 0000"
    },
    {
      "type": "permanent",
      "reason": "ReadonlyFilesystem",
      "pattern": "\\[.*\\] EXT4-fs error.*"
    }
  ]
}
```

### ABRT Monitor

The ABRT (Automatic Bug Reporting Tool) monitor detects kernel panics and application crashes logged by the ABRT daemon.

```yaml
# /config/abrt-adaptor.json (built-in)
{
  "plugin": "journald",
  "journalDirs": ["/var/log/journal"],
  "source": "abrt-adaptor",
  "conditions": [],
  "rules": [
    {
      "type": "temporary",
      "reason": "CCppCrashDetected",
      "pattern": "Process \\d+ \\(\\S+\\) crashed in.*"
    },
    {
      "type": "temporary",
      "reason": "KernelCrashDetected",
      "pattern": "System crashed.*"
    }
  ]
}
```

### Systemd Monitor

The systemd monitor watches Docker, containerd, and kubelet unit health via the journal.

```yaml
# /config/systemd-monitor.json (built-in)
{
  "plugin": "journald",
  "journalDirs": ["/var/log/journal"],
  "source": "systemd-monitor",
  "conditions": [
    {
      "type": "KubeletProblem",
      "reason": "KubeletIsUp",
      "message": "kubelet service is up"
    },
    {
      "type": "DockerProblem",
      "reason": "DockerIsUp",
      "message": "docker service is up"
    },
    {
      "type": "ContainerdProblem",
      "reason": "ContainerdIsUp",
      "message": "containerd service is up"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "reason": "KubeletIsDown",
      "pattern": "Started Kubernetes Kubelet.*",
      "condition": "KubeletProblem"
    },
    {
      "type": "permanent",
      "reason": "ContainerdIsDown",
      "pattern": "containerd.service: Failed with result",
      "condition": "ContainerdProblem"
    }
  ]
}
```

## DaemonSet Deployment via Helm

The recommended production installation path is the official Helm chart from the Kubernetes SIG Node repository.

```bash
helm repo add deliveryhero https://charts.deliveryhero.io/
helm repo update

helm install node-problem-detector deliveryhero/node-problem-detector \
  --namespace kube-system \
  --version 2.3.12 \
  --values npd-values.yaml
```

### Production Values File

```yaml
# npd-values.yaml
image:
  repository: registry.k8s.io/node-problem-detector/node-problem-detector
  tag: "v0.8.19"
  pullPolicy: IfNotPresent

rbac:
  create: true

hostPID: true
hostNetwork: false

priorityClassName: system-node-critical

resources:
  requests:
    cpu: 20m
    memory: 64Mi
  limits:
    cpu: 200m
    memory: 128Mi

tolerations:
  - effect: NoSchedule
    operator: Exists
  - effect: NoExecute
    operator: Exists
  - key: CriticalAddonsOnly
    operator: Exists

updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1

metrics:
  enabled: true
  port: 20257

settings:
  log_monitors:
    - /config/kernel-monitor.json
    - /config/docker-monitor.json
    - /config/systemd-monitor.json
    - /config/abrt-adaptor.json
    - /config/custom-kernel-monitor.json
  custom_plugin_monitors:
    - /config/custom-plugin-monitor.json
  enable_k8s_exporter: true

extraVolumes:
  - name: custom-config
    configMap:
      name: node-problem-detector-custom-config

extraVolumeMounts:
  - name: custom-config
    mountPath: /config/custom-kernel-monitor.json
    subPath: custom-kernel-monitor.json
  - name: custom-config
    mountPath: /config/custom-plugin-monitor.json
    subPath: custom-plugin-monitor.json
  - name: custom-config
    mountPath: /custom-plugins
    readOnly: true

securityContext:
  privileged: true

serviceAccount:
  create: true
  annotations: {}

nodeSelector: {}

podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "20257"
```

## Custom Plugin Development

### Bash Script Plugins

Custom bash plugins return exit code `0` (OK), `1` (non-permanent problem), or `2` (permanent problem). Output on stdout is used as the condition message.

#### Disk Pressure Plugin

```bash
#!/bin/bash
# /custom-plugins/check-disk-pressure.sh
# Checks inode and block utilization across all mounted filesystems.

set -euo pipefail

BLOCK_THRESHOLD=85
INODE_THRESHOLD=85
PROBLEM_FS=""

while IFS= read -r line; do
  # Skip header
  [[ "$line" =~ ^Filesystem ]] && continue

  usage_pct=$(echo "$line" | awk '{print $5}' | tr -d '%')
  mountpoint=$(echo "$line" | awk '{print $6}')

  if [[ "$usage_pct" -ge "$BLOCK_THRESHOLD" ]]; then
    PROBLEM_FS="${PROBLEM_FS} ${mountpoint}(${usage_pct}%)"
  fi
done < <(df -h --output=source,size,used,avail,pcent,target 2>/dev/null | tail -n +2)

while IFS= read -r line; do
  [[ "$line" =~ ^Filesystem ]] && continue

  iuse_pct=$(echo "$line" | awk '{print $5}' | tr -d '%')
  mountpoint=$(echo "$line" | awk '{print $6}')

  if [[ -n "$iuse_pct" ]] && [[ "$iuse_pct" -ge "$INODE_THRESHOLD" ]]; then
    PROBLEM_FS="${PROBLEM_FS} ${mountpoint}-inodes(${iuse_pct}%)"
  fi
done < <(df -i --output=source,itotal,iused,iavail,ipcent,target 2>/dev/null | tail -n +2)

if [[ -n "$PROBLEM_FS" ]]; then
  echo "Disk pressure detected on:${PROBLEM_FS}"
  exit 2
fi

echo "Disk utilization within thresholds"
exit 0
```

#### Network Connectivity Plugin

```bash
#!/bin/bash
# /custom-plugins/check-network-connectivity.sh
# Validates connectivity to the Kubernetes API server and DNS resolver.

set -euo pipefail

APISERVER_ENDPOINT="${KUBERNETES_SERVICE_HOST:-kubernetes.default.svc}"
APISERVER_PORT="${KUBERNETES_SERVICE_PORT:-443}"
DNS_TEST_HOST="kubernetes.default.svc.cluster.local"
TIMEOUT=5

check_tcp() {
  local host="$1"
  local port="$2"
  timeout "${TIMEOUT}" bash -c ">/dev/tcp/${host}/${port}" 2>/dev/null
}

check_dns() {
  local host="$1"
  nslookup "${host}" 2>/dev/null | grep -q "Address"
}

FAILURES=""

if ! check_tcp "${APISERVER_ENDPOINT}" "${APISERVER_PORT}"; then
  FAILURES="${FAILURES} api-server-unreachable"
fi

if ! check_dns "${DNS_TEST_HOST}"; then
  FAILURES="${FAILURES} cluster-dns-broken"
fi

# Check node DNS resolver
if ! timeout "${TIMEOUT}" nslookup "google.com" >/dev/null 2>&1; then
  FAILURES="${FAILURES} external-dns-broken"
fi

if [[ -n "$FAILURES" ]]; then
  echo "Network connectivity failures:${FAILURES}"
  exit 1
fi

echo "All network connectivity checks passed"
exit 0
```

#### GPU Health Plugin

```bash
#!/bin/bash
# /custom-plugins/check-gpu-health.sh
# Checks NVIDIA GPU health using nvidia-smi.

set -euo pipefail

# Skip if no GPU present
if ! command -v nvidia-smi &>/dev/null; then
  echo "No NVIDIA GPU detected, skipping"
  exit 0
fi

GPU_COUNT=$(nvidia-smi --query-gpu=count --format=csv,noheader 2>/dev/null | head -1)
if [[ -z "$GPU_COUNT" ]] || [[ "$GPU_COUNT" -eq 0 ]]; then
  echo "No GPUs detected by nvidia-smi"
  exit 0
fi

UNHEALTHY_GPUS=""

while IFS=',' read -r index name ecc_errors temp util; do
  index=$(echo "$index" | xargs)
  ecc_errors=$(echo "$ecc_errors" | xargs)
  temp=$(echo "$temp" | xargs | tr -d ' C')

  if [[ "$ecc_errors" != "0" ]] && [[ "$ecc_errors" != "N/A" ]]; then
    UNHEALTHY_GPUS="${UNHEALTHY_GPUS} GPU${index}(ECC:${ecc_errors})"
  fi

  if [[ "$temp" =~ ^[0-9]+$ ]] && [[ "$temp" -ge 90 ]]; then
    UNHEALTHY_GPUS="${UNHEALTHY_GPUS} GPU${index}(TEMP:${temp}C)"
  fi
done < <(nvidia-smi --query-gpu=index,name,ecc.errors.uncorrected.aggregate.total,temperature.gpu,utilization.gpu \
           --format=csv,noheader 2>/dev/null)

# Check for XID errors (hardware errors) in dmesg
if dmesg 2>/dev/null | grep -qE "NVRM: Xid.*: [0-9]+$"; then
  recent_xid=$(dmesg 2>/dev/null | grep -E "NVRM: Xid" | tail -1)
  UNHEALTHY_GPUS="${UNHEALTHY_GPUS} xid-error"
fi

if [[ -n "$UNHEALTHY_GPUS" ]]; then
  echo "GPU health issues detected:${UNHEALTHY_GPUS}"
  exit 2
fi

echo "All ${GPU_COUNT} GPU(s) healthy"
exit 0
```

### Custom Plugin Monitor Configuration

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "60s",
    "timeout": "30s",
    "max_output_length": 80,
    "concurrency": 3
  },
  "source": "custom-plugin-monitor",
  "skipInitialStatus": true,
  "conditions": [
    {
      "type": "DiskPressure",
      "reason": "DiskUtilizationNormal",
      "message": "disk utilization is normal"
    },
    {
      "type": "NetworkProblem",
      "reason": "NetworkConnectivityNormal",
      "message": "network connectivity is normal"
    },
    {
      "type": "GpuProblem",
      "reason": "GpuIsHealthy",
      "message": "GPU hardware is healthy"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "reason": "DiskPressureDetected",
      "path": "/custom-plugins/check-disk-pressure.sh",
      "timeout": "20s",
      "condition": "DiskPressure"
    },
    {
      "type": "temporary",
      "reason": "NetworkConnectivityIssue",
      "path": "/custom-plugins/check-network-connectivity.sh",
      "timeout": "15s",
      "condition": "NetworkProblem"
    },
    {
      "type": "permanent",
      "reason": "GpuUnhealthy",
      "path": "/custom-plugins/check-gpu-health.sh",
      "timeout": "25s",
      "condition": "GpuProblem"
    }
  ]
}
```

### Custom Kernel Log Pattern Matchers

To detect workload-specific kernel errors without rebuilding the NPD image, mount a custom kernel monitor config.

```json
{
  "plugin": "kmsg",
  "logPath": "/dev/kmsg",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "custom-kernel-monitor",
  "conditions": [
    {
      "type": "NfsIoError",
      "reason": "NfsIoNormal",
      "message": "NFS I/O is normal"
    },
    {
      "type": "CgroupMemoryPressure",
      "reason": "CgroupMemoryNormal",
      "message": "cgroup memory is not under pressure"
    },
    {
      "type": "EbpfError",
      "reason": "EbpfNormal",
      "message": "eBPF subsystem is normal"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "NfsIoError",
      "pattern": "nfs: server .+ not responding",
      "condition": "NfsIoError"
    },
    {
      "type": "temporary",
      "reason": "NfsClientError",
      "pattern": "nfs: I/O error: blocks lost"
    },
    {
      "type": "temporary",
      "reason": "CgroupOomKill",
      "pattern": "oom-kill:constraint=CONSTRAINT_MEMCG"
    },
    {
      "type": "temporary",
      "reason": "TcpRetransmitTimeout",
      "pattern": "TCP: request_sock_TCP: Possible SYN flooding"
    },
    {
      "type": "permanent",
      "reason": "HardwareCorruption",
      "pattern": "EDAC MC\\d+: CE .* on .*(channel:\\d+)"
    },
    {
      "type": "permanent",
      "reason": "HardwareCorruption",
      "pattern": "ERST: Failed to get Error Log"
    },
    {
      "type": "temporary",
      "reason": "ContainerdSnapshotterError",
      "pattern": "containerd: failed to .* snapshot"
    }
  ]
}
```

## ConfigMap for Custom Configs

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-detector-custom-config
  namespace: kube-system
data:
  custom-kernel-monitor.json: |
    {
      "plugin": "kmsg",
      "logPath": "/dev/kmsg",
      "lookback": "5m",
      "bufferSize": 10,
      "source": "custom-kernel-monitor",
      "conditions": [
        {
          "type": "NfsIoError",
          "reason": "NfsIoNormal",
          "message": "NFS I/O is normal"
        },
        {
          "type": "CgroupMemoryPressure",
          "reason": "CgroupMemoryNormal",
          "message": "cgroup memory is not under pressure"
        }
      ],
      "rules": [
        {
          "type": "temporary",
          "reason": "NfsIoError",
          "pattern": "nfs: server .+ not responding",
          "condition": "NfsIoError"
        },
        {
          "type": "temporary",
          "reason": "CgroupOomKill",
          "pattern": "oom-kill:constraint=CONSTRAINT_MEMCG"
        },
        {
          "type": "permanent",
          "reason": "HardwareCorruption",
          "pattern": "EDAC MC\\d+: CE .* on .*(channel:\\d+)"
        }
      ]
    }
  custom-plugin-monitor.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invoke_interval": "60s",
        "timeout": "30s",
        "max_output_length": 80,
        "concurrency": 3
      },
      "source": "custom-plugin-monitor",
      "skipInitialStatus": true,
      "conditions": [
        {
          "type": "DiskPressure",
          "reason": "DiskUtilizationNormal",
          "message": "disk utilization is normal"
        },
        {
          "type": "NetworkProblem",
          "reason": "NetworkConnectivityNormal",
          "message": "network connectivity is normal"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "reason": "DiskPressureDetected",
          "path": "/custom-plugins/check-disk-pressure.sh",
          "timeout": "20s",
          "condition": "DiskPressure"
        },
        {
          "type": "temporary",
          "reason": "NetworkConnectivityIssue",
          "path": "/custom-plugins/check-network-connectivity.sh",
          "timeout": "15s",
          "condition": "NetworkProblem"
        }
      ]
    }
```

## Prometheus Metrics Export

NPD exposes metrics on port `20257` by default. The `--prometheus-address` flag controls the bind address.

### ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: node-problem-detector
  namespace: monitoring
  labels:
    release: prometheus
spec:
  namespaceSelector:
    matchNames:
      - kube-system
  selector:
    matchLabels:
      app.kubernetes.io/name: node-problem-detector
  endpoints:
    - port: metrics
      interval: 30s
      path: /metrics
      scheme: http
```

### Key Metrics

```promql
# Count of nodes with active NodeCondition problems
sum by (condition) (
  kube_node_status_condition{status="true"} *
  on(node) group_left()
  kube_node_info
)

# NPD events rate by reason
rate(problem_counter[5m])

# Nodes with disk pressure (NPD-reported)
kube_node_status_condition{condition="DiskPressure", status="true"}

# OOM kill events per node (5-minute rate)
rate(problem_counter{reason="OOMKilling"}[5m])
```

### Alerting Rules

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-problem-detector-alerts
  namespace: monitoring
  labels:
    release: prometheus
spec:
  groups:
    - name: node-problem-detector
      interval: 30s
      rules:
        - alert: NodeKernelDeadlock
          expr: |
            kube_node_status_condition{condition="KernelDeadlock",status="true"} == 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Kernel deadlock on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} has had a kernel deadlock for >5 minutes. Cordon and drain immediately."
            runbook_url: "https://runbooks.support.tools/node-kernel-deadlock"

        - alert: NodeReadonlyFilesystem
          expr: |
            kube_node_status_condition{condition="ReadonlyFilesystem",status="true"} == 1
          for: 2m
          labels:
            severity: critical
          annotations:
            summary: "Readonly filesystem on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} has a read-only filesystem. Disk failure or kernel panic likely."

        - alert: NodeDiskPressureNPD
          expr: |
            kube_node_status_condition{condition="DiskPressure",status="true"} == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Disk pressure on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} is reporting disk pressure above threshold."

        - alert: NodeNetworkProblem
          expr: |
            kube_node_status_condition{condition="NetworkProblem",status="true"} == 1
          for: 3m
          labels:
            severity: critical
          annotations:
            summary: "Network problem on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} cannot reach the API server or cluster DNS."

        - alert: NodeGpuUnhealthy
          expr: |
            kube_node_status_condition{condition="GpuProblem",status="true"} == 1
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "GPU health issue on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} has GPU ECC errors or thermal issues."

        - alert: NodeHighOomKillRate
          expr: |
            rate(problem_counter{reason="OOMKilling"}[10m]) > 0.5
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High OOM kill rate on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} is killing {{ $value | humanize }} processes/sec due to OOM."
```

## Integration with Cluster Autoscaler

Cluster Autoscaler (CAS) respects custom NodeConditions when deciding whether a node is healthy enough to keep running. By annotating CAS with the conditions NPD sets, problematic nodes get automatically replaced rather than waiting for human intervention.

### CAS Configuration

```yaml
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
          command:
            - ./cluster-autoscaler
            - --cloud-provider=aws
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production
            # Tell CAS to treat these NPD conditions as unready
            - --status-config-map-name=cluster-autoscaler-status
            - --ok-total-unready-count=3
            - --max-node-provision-time=15m
            # NPD conditions that mark a node as unschedulable for CAS
            - --node-not-ready-taint-removal-delay=30s
          env:
            - name: NODE_PROBLEM_DETECTOR_ENABLED
              value: "true"
```

### Taint-Based Remediation

A common pattern is to have a separate controller taint nodes when NPD sets problem conditions, then let CAS drain and replace them.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: npd-remediation-config
  namespace: kube-system
data:
  remediation.yaml: |
    remediations:
      - condition: KernelDeadlock
        action: taint
        taint:
          key: "node.kubernetes.io/kernel-deadlock"
          effect: "NoSchedule"
        drainAfterSeconds: 300
      - condition: ReadonlyFilesystem
        action: taint
        taint:
          key: "node.kubernetes.io/readonly-filesystem"
          effect: "NoExecute"
        drainAfterSeconds: 60
      - condition: DiskPressure
        action: taint
        taint:
          key: "node.kubernetes.io/disk-pressure"
          effect: "NoSchedule"
        drainAfterSeconds: 600
```

### Node Auto-Remediation Script

```bash
#!/bin/bash
# node-remediation-controller.sh
# Watches for NPD NodeConditions and applies taints to problematic nodes.

set -euo pipefail

CONDITIONS_TO_TAINT=(
  "KernelDeadlock:node.kubernetes.io/kernel-deadlock:NoExecute"
  "ReadonlyFilesystem:node.kubernetes.io/readonly-filesystem:NoExecute"
  "DiskPressure:node.kubernetes.io/disk-pressure:NoSchedule"
  "NetworkProblem:node.kubernetes.io/network-unavailable:NoSchedule"
)

while true; do
  for condition_spec in "${CONDITIONS_TO_TAINT[@]}"; do
    condition=$(echo "$condition_spec" | cut -d: -f1)
    taint_key=$(echo "$condition_spec" | cut -d: -f2)
    taint_effect=$(echo "$condition_spec" | cut -d: -f3)

    # Find nodes where this condition is True
    problem_nodes=$(kubectl get nodes -o json | jq -r \
      --arg cond "$condition" \
      '.items[] | select(
        .status.conditions[]? |
        .type == $cond and .status == "True"
      ) | .metadata.name')

    for node in $problem_nodes; do
      if ! kubectl get node "$node" -o jsonpath='{.spec.taints}' | \
           grep -q "$taint_key"; then
        echo "Tainting node $node with $taint_key:$taint_effect (condition: $condition)"
        kubectl taint node "$node" "${taint_key}=:${taint_effect}" --overwrite
      fi
    done
  done

  sleep 30
done
```

## Integration with Alertmanager

Routing NPD alerts through Alertmanager enables PagerDuty escalations and Slack notifications with node-specific context.

```yaml
# alertmanager-config.yaml excerpt
route:
  group_by: ['alertname', 'node']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: default
  routes:
    - match:
        alertname: NodeKernelDeadlock
      receiver: pagerduty-critical
      continue: false
    - match:
        alertname: NodeReadonlyFilesystem
      receiver: pagerduty-critical
      continue: false
    - match_re:
        alertname: "^Node.*"
      receiver: slack-ops
      continue: true

receivers:
  - name: pagerduty-critical
    pagerduty_configs:
      - routing_key: PAGERDUTY_ROUTING_KEY_EXAMPLE_REPLACE_ME
        description: '{{ template "pagerduty.default.description" . }}'
        details:
          node: '{{ .Labels.node }}'
          condition: '{{ .Labels.condition }}'
          firing: '{{ .Alerts.Firing | len }}'

  - name: slack-ops
    slack_configs:
      - api_url: https://hooks.slack.com/services/EXAMPLE_SLACK_WEBHOOK_REPLACE_ME
        channel: '#ops-alerts'
        title: 'Node Problem: {{ .Labels.node }}'
        text: |
          *Alert:* {{ .Labels.alertname }}
          *Node:* {{ .Labels.node }}
          *Condition:* {{ .Labels.condition | default "n/a" }}
          *Description:* {{ .Annotations.description }}
```

## Production Tuning

### Reducing False Positives

Temporary conditions require the problem to be observed consecutively before creating a NodeCondition. The `lookback` window on log monitors controls how far back NPD scans on startup — reduce this to avoid flagging old log entries on pod restarts.

```json
{
  "plugin": "kmsg",
  "logPath": "/dev/kmsg",
  "lookback": "2m",
  "bufferSize": 10,
  "source": "kernel-monitor"
}
```

For custom plugins, set `skipInitialStatus: true` to suppress condition updates on the first run cycle after a pod restart.

### Resource Tuning

On large nodes with high kmsg throughput (GPU nodes, high-IOPS nodes), increase `bufferSize` to avoid missing events. On nodes where NPD itself is causing CPU pressure, reduce plugin `concurrency` and lengthen `invoke_interval`.

```json
{
  "pluginConfig": {
    "invoke_interval": "120s",
    "timeout": "60s",
    "max_output_length": 80,
    "concurrency": 1
  }
}
```

### Verifying NPD is Working

```bash
# Check NPD pod status on all nodes
kubectl get pods -n kube-system -l app.kubernetes.io/name=node-problem-detector -o wide

# Inspect custom NodeConditions on a specific node
kubectl get node node01 -o json | \
  jq '.status.conditions[] | select(.type | test("Kernel|Disk|Network|Gpu"))'

# Watch NPD events in real time
kubectl get events -n kube-system --field-selector reason=KernelDeadlock -w

# Check NPD logs on a specific node's pod
NPD_POD=$(kubectl get pod -n kube-system -l app.kubernetes.io/name=node-problem-detector \
  --field-selector spec.nodeName=node01 -o name)
kubectl logs -n kube-system "${NPD_POD}" --tail=100

# Manually trigger a test condition (for validation only)
# This simulates a kernel deadlock message in kmsg
echo "kernel deadlock test" | sudo tee /dev/kmsg
```

### Graceful Handling of NPD Pod Restarts

NPD re-reads its lookback window on startup, so it may briefly re-fire conditions that have already resolved. Configure alerting with a `for: 5m` duration on most conditions to absorb this noise. For truly permanent conditions (kernel oops, hardware ECC errors), use `for: 1m` since those warrant immediate attention.

### Multi-Architecture Considerations

On ARM64 nodes (Graviton, Ampere), the kernel log format differs from x86. Test custom patterns against representative log samples from both architectures before deploying cluster-wide. The `problem_counter` Prometheus metric includes a `reason` label that makes it straightforward to compare detection rates across node types.

```promql
# Compare OOM kill detection rate across arch
rate(problem_counter{reason="OOMKilling"}[5m]) by (instance)
```

## Summary

Node Problem Detector provides a systematic framework for surfacing node-level health signals into Kubernetes-native primitives. Deploying NPD with custom kernel pattern matchers, bash plugins for disk and network checks, GPU health monitoring, and Prometheus alerting transforms invisible hardware failures into actionable signals. Combined with Cluster Autoscaler's node replacement capability and Alertmanager routing, NPD forms the foundation of a self-healing node infrastructure where degraded hardware is detected and replaced without manual intervention.
