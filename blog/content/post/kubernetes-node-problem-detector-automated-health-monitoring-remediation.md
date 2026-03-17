---
title: "Kubernetes Node Problem Detector: Automated Node Health Monitoring and Remediation"
date: 2030-07-29T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "Node Health", "Monitoring", "Cluster Autoscaler", "SRE"]
categories:
- Kubernetes
- Operations
author: "Matthew Mattox - mmattox@support.tools"
description: "Production Node Problem Detector guide covering system log monitors, custom problem detectors, node condition management, integration with cluster autoscaler for automatic node replacement, and alerting on node-level issues."
more_link: "yes"
url: "/kubernetes-node-problem-detector-automated-health-monitoring-remediation/"
---

Node failures in Kubernetes clusters often manifest as subtle degradations before they become complete outages. A kernel OOM killer activating, disk I/O errors accumulating, network interface dropping packets, or NTP synchronization drifting — each represents a node problem that Kubernetes' built-in health checks cannot detect. Node Problem Detector (NPD) was designed to bridge this gap: it monitors system logs and kernel metrics, translates problems into Kubernetes Node Conditions and Events, and enables automated remediation through integration with the Cluster Autoscaler and third-party node repair operators.

<!--more-->

## Node Problem Detector Architecture

NPD runs as a DaemonSet on every node and consists of three components:

1. **Problem Daemons**: Monitor node health using different detection methods
2. **Problem API Server**: Exposes detected problems to the Kubernetes API
3. **Node Condition Manager**: Updates NodeConditions based on detected problems

### Problem Daemon Types

| Daemon Type | Description | Detection Method |
|-------------|-------------|------------------|
| SystemLogMonitor | Watches system logs (journald, file) | Pattern matching |
| SystemStatsMonitor | Monitors kernel and system metrics | /proc, /sys parsing |
| CustomPluginMonitor | Runs external scripts | Script exit code + stdout |

```
Node Log → SystemLogMonitor → Problem → NodeCondition/Event
/proc     → SystemStatsMonitor → Problem → NodeCondition/Event
Script    → CustomPluginMonitor → Problem → NodeCondition/Event
```

## Deployment

### DaemonSet Installation

```yaml
# node-problem-detector.yaml
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
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
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
      dnsPolicy: Default
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists
          effect: NoSchedule
        - operator: Exists
          effect: NoExecute
      containers:
        - name: node-problem-detector
          image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.19
          command:
            - /node-problem-detector
            - --logtostderr
            - --system-log-monitors=/config/kernel-monitor.json,/config/docker-monitor.json
            - --custom-plugin-monitors=/config/custom-plugin-monitor.json
            - --system-stats-monitor=/config/system-stats-monitor.json
            - --prometheus-port=20257
            - --k8s-exporter-heartbeat-period=5m0s
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
            - name: machine-id
              mountPath: /etc/machine-id
              readOnly: true
          ports:
            - containerPort: 20257
              name: prometheus
          resources:
            requests:
              cpu: 20m
              memory: 100Mi
            limits:
              cpu: 200m
              memory: 200Mi
      volumes:
        - name: log
          hostPath:
            path: /var/log
        - name: kmsg
          hostPath:
            path: /dev/kmsg
        - name: machine-id
          hostPath:
            path: /etc/machine-id
        - name: config
          configMap:
            name: node-problem-detector-config
---
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

## System Log Monitors

### Kernel Monitor Configuration

The kernel monitor watches `/dev/kmsg` for patterns indicating system problems:

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
      "type": "FrequentDockerRestart",
      "reason": "NoFrequentDockerRestart",
      "message": "docker is functioning properly"
    },
    {
      "type": "NTPProblem",
      "reason": "NoNTPProblem",
      "message": "NTP is working properly"
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
      "pattern": "unregister_netdevice: waiting for (\\w+) to become free. Usage count = \\d+"
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
    },
    {
      "type": "permanent",
      "condition": "NTPProblem",
      "reason": "NTPSyncFailed",
      "pattern": "chronyd\\[\\d+\\]: Can't synchronise: no selectable sources"
    }
  ]
}
```

### Docker/Containerd Monitor

```json
{
  "plugin": "journald",
  "pluginConfig": {
    "source": "dockerd"
  },
  "logPath": "/var/log/journal",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "docker-monitor",
  "conditions": [
    {
      "type": "FrequentDockerRestart",
      "reason": "NoFrequentDockerRestart",
      "message": "docker is functioning properly"
    },
    {
      "type": "ContainerdProblem",
      "reason": "NoContainerdProblem",
      "message": "containerd is functioning properly"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "FrequentDockerRestart",
      "reason": "DockerStart",
      "pattern": "Starting up"
    },
    {
      "type": "permanent",
      "condition": "ContainerdProblem",
      "reason": "ContainerdCrash",
      "pattern": "containerd failed to start"
    }
  ]
}
```

## System Stats Monitor

The system stats monitor uses `/proc` and `/sys` to detect hardware and OS-level problems:

```json
{
  "source": "system-stats-monitor",
  "metricsReporting": {
    "period": "1m",
    "requestsPerMinuteLimit": 60
  },
  "cpu": {
    "metricsConfigs": {
      "cpu/runnable_task_count": {
        "metricType": "gauge"
      }
    }
  },
  "disk": {
    "includeRootBlk": true,
    "includeAllAttachedBlk": true,
    "lsblkTimeout": "5s",
    "metricsConfigs": {
      "disk/io_time": {
        "metricType": "cumulative"
      },
      "disk/weighted_io": {
        "metricType": "cumulative"
      },
      "disk/avg_queue_len": {
        "metricType": "gauge"
      },
      "disk/percent_io_time": {
        "metricType": "gauge"
      }
    }
  },
  "host": {
    "metricsConfigs": {
      "host/uptime": {
        "metricType": "gauge"
      }
    }
  },
  "memory": {
    "metricsConfigs": {
      "memory/anonymous_used": {
        "metricType": "gauge"
      },
      "memory/page_cache_used": {
        "metricType": "gauge"
      },
      "memory/unevictable_used": {
        "metricType": "gauge"
      },
      "memory/kernel_used": {
        "metricType": "gauge"
      },
      "memory/available": {
        "metricType": "gauge"
      }
    }
  }
}
```

## Custom Plugin Monitors

Custom plugin monitors run external scripts and interpret their exit codes to set node conditions:

### Custom Plugin Configuration

```json
{
  "plugin": "custom",
  "pluginConfig": {
    "invokeIntervalMs": 60000,
    "timeoutMs": 10000,
    "maxOutputLength": 80,
    "concurrency": 1
  },
  "source": "custom-plugin-monitor",
  "conditions": [
    {
      "type": "DiskIOProblem",
      "reason": "NoDiskIOProblem",
      "message": "Disk I/O is functioning properly"
    },
    {
      "type": "NetworkLatencyHigh",
      "reason": "NetworkLatencyNormal",
      "message": "Network latency is within acceptable bounds"
    },
    {
      "type": "CertificateExpiry",
      "reason": "CertificatesValid",
      "message": "Node certificates are valid"
    },
    {
      "type": "NFSMountProblem",
      "reason": "NoNFSMountProblem",
      "message": "NFS mounts are functioning properly"
    }
  ],
  "rules": [
    {
      "type": "permanent",
      "condition": "DiskIOProblem",
      "reason": "DiskIOError",
      "path": "/config/plugin/check-disk-io.sh"
    },
    {
      "type": "permanent",
      "condition": "NetworkLatencyHigh",
      "reason": "HighNetworkLatency",
      "path": "/config/plugin/check-network-latency.sh"
    },
    {
      "type": "permanent",
      "condition": "CertificateExpiry",
      "reason": "CertificateNearExpiry",
      "path": "/config/plugin/check-certificates.sh"
    },
    {
      "type": "permanent",
      "condition": "NFSMountProblem",
      "reason": "StaleNFSMount",
      "path": "/config/plugin/check-nfs-mounts.sh"
    }
  ]
}
```

### Custom Plugin Scripts

Custom plugins communicate with NPD via exit codes:
- `0`: No problem (condition should be false/healthy)
- `1`: Transient problem (temporary event)
- `2`: Permanent problem (condition should be true/unhealthy)

```bash
#!/bin/bash
# /config/plugin/check-disk-io.sh
# Check for disk I/O errors in kernel log

# Exit 0: no problem
# Exit 2: permanent problem detected

ERRORS=$(dmesg --since "5 minutes ago" 2>/dev/null | \
    grep -c "I/O error\|Buffer I/O error\|EXT4-fs error" || true)

if [ "$ERRORS" -gt 10 ]; then
    echo "Disk I/O errors detected: $ERRORS errors in last 5 minutes"
    exit 2
fi

# Check disk utilization (saturation above 90% sustained)
DISK_UTIL=$(iostat -x 1 3 2>/dev/null | awk '/^(sd|xvd|nvme)/ {sum+=$NF; count++} END {if(count>0) print sum/count; else print 0}')
if [ "$(echo "$DISK_UTIL > 90" | bc 2>/dev/null)" = "1" ]; then
    echo "Disk utilization critically high: ${DISK_UTIL}%"
    exit 2
fi

exit 0
```

```bash
#!/bin/bash
# /config/plugin/check-certificates.sh
# Check kubelet and kube-proxy certificate expiry

WARN_DAYS=30
CRITICAL_DAYS=7

check_cert_expiry() {
    local cert_file=$1
    local cert_name=$2

    if [ ! -f "$cert_file" ]; then
        return 0
    fi

    # Get expiry date in seconds since epoch
    EXPIRY=$(openssl x509 -enddate -noout -in "$cert_file" 2>/dev/null | \
        sed 's/notAfter=//' | \
        xargs -I{} date -d "{}" +%s 2>/dev/null)

    if [ -z "$EXPIRY" ]; then
        return 0
    fi

    NOW=$(date +%s)
    DAYS_REMAINING=$(( (EXPIRY - NOW) / 86400 ))

    if [ "$DAYS_REMAINING" -lt "$CRITICAL_DAYS" ]; then
        echo "CRITICAL: $cert_name expires in $DAYS_REMAINING days"
        return 2
    elif [ "$DAYS_REMAINING" -lt "$WARN_DAYS" ]; then
        echo "WARNING: $cert_name expires in $DAYS_REMAINING days"
        return 1
    fi

    return 0
}

RESULT=0

check_cert_expiry /var/lib/kubelet/pki/kubelet-client-current.pem "kubelet-client"
RC=$?
[ $RC -gt $RESULT ] && RESULT=$RC

check_cert_expiry /var/lib/kubelet/pki/kubelet.crt "kubelet-server"
RC=$?
[ $RC -gt $RESULT ] && RESULT=$RC

if [ $RESULT -eq 0 ]; then
    echo "All node certificates are valid"
fi

exit $RESULT
```

```bash
#!/bin/bash
# /config/plugin/check-nfs-mounts.sh
# Detect stale NFS mounts that would cause hangs

check_nfs_mount() {
    local mount_point=$1

    # Use timeout to detect hung NFS mounts
    timeout 5 stat "$mount_point" &>/dev/null
    local rc=$?

    if [ $rc -eq 124 ]; then
        echo "NFS mount $mount_point is hung (timeout)"
        return 2
    elif [ $rc -ne 0 ]; then
        echo "NFS mount $mount_point is inaccessible (rc=$rc)"
        return 2
    fi
    return 0
}

RESULT=0
# Get NFS mounts from /proc/mounts
while IFS=' ' read -r device mount_point fstype rest; do
    if [[ "$fstype" == "nfs"* ]]; then
        check_nfs_mount "$mount_point"
        RC=$?
        [ $RC -gt $RESULT ] && RESULT=$RC
    fi
done < /proc/mounts

if [ $RESULT -eq 0 ]; then
    echo "All NFS mounts are accessible"
fi

exit $RESULT
```

## Viewing Node Conditions

Node conditions set by NPD appear in the node object alongside built-in conditions:

```bash
# View all node conditions
kubectl describe node <node-name> | grep -A 30 "Conditions:"

# Example output showing custom conditions:
# Conditions:
#   Type                     Status  LastHeartbeatTime    Reason                       Message
#   ----                     ------  -----------------    ------                       -------
#   KernelDeadlock           False   30s                  KernelHasNoDeadlock          kernel has no deadlock
#   ReadonlyFilesystem       False   30s                  FilesystemIsNotReadOnly      Filesystem is not read-only
#   DiskIOProblem            False   60s                  NoDiskIOProblem              Disk I/O is functioning properly
#   NetworkLatencyHigh       False   60s                  NetworkLatencyNormal         Network latency is within acceptable bounds
#   MemoryPressure           False   45s                  KubeletHasSufficientMemory   kubelet has sufficient memory available
#   DiskPressure             False   45s                  KubeletHasNoDiskPressure     kubelet has no disk pressure
#   PIDPressure              False   45s                  KubeletHasSufficientPID      kubelet has sufficient PID available
#   Ready                    True    45s                  KubeletReady                 kubelet is posting ready status

# Get node conditions programmatically
kubectl get node <node-name> -o jsonpath='{.status.conditions}' | \
    python3 -m json.tool

# Watch for condition changes
kubectl get node <node-name> -w -o jsonpath='{.status.conditions[*].type}: {.status.conditions[*].status}'
```

## Integration with Cluster Autoscaler

The Cluster Autoscaler can be configured to drain and replace nodes that have unhealthy conditions set by NPD.

### Configuring CA to Respect NPD Conditions

```yaml
# cluster-autoscaler deployment configuration
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
            - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled=true
            # Treat these NPD conditions as unhealthy
            - --status-config-map-name=cluster-autoscaler-status
            # Nodes with these conditions will be drained and replaced
            - --ok-total-unready-count=3
            - --max-node-provision-time=15m
            # Critical: respect NPD conditions
            - --balance-similar-node-groups=true
            - --skip-nodes-with-system-pods=false
```

### Node Draining Based on NPD Conditions

A more proactive approach uses a custom controller that watches NPD conditions and drains nodes automatically:

```go
// cmd/node-remediation/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/watch"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"
    "k8s.io/kubectl/pkg/drain"
)

// UnhealthyConditions are the NPD conditions that trigger node remediation
var UnhealthyConditions = map[string]bool{
    "KernelDeadlock":    true,
    "ReadonlyFilesystem": true,
    "DiskIOProblem":     true,
    "NFSMountProblem":   true,
}

func main() {
    config, err := clientcmd.BuildConfigFromFlags("", "")
    if err != nil {
        log.Fatalf("build config: %v", err)
    }
    client, err := kubernetes.NewForConfig(config)
    if err != nil {
        log.Fatalf("create client: %v", err)
    }

    ctx := context.Background()
    watcher, err := client.CoreV1().Nodes().Watch(ctx, metav1.ListOptions{})
    if err != nil {
        log.Fatalf("watch nodes: %v", err)
    }

    for event := range watcher.ResultChan() {
        if event.Type != watch.Modified {
            continue
        }
        node, ok := event.Object.(*corev1.Node)
        if !ok {
            continue
        }

        if shouldRemediate(node) {
            log.Printf("node %s has unhealthy condition, initiating drain", node.Name)
            if err := drainNode(ctx, client, node); err != nil {
                log.Printf("failed to drain node %s: %v", node.Name, err)
            }
        }
    }
}

func shouldRemediate(node *corev1.Node) bool {
    for _, condition := range node.Status.Conditions {
        if !UnhealthyConditions[string(condition.Type)] {
            continue
        }
        if condition.Status == corev1.ConditionTrue {
            // Only remediate if condition has been true for > 5 minutes
            if time.Since(condition.LastTransitionTime.Time) > 5*time.Minute {
                return true
            }
        }
    }
    return false
}

func drainNode(ctx context.Context, client kubernetes.Interface, node *corev1.Node) error {
    drainer := &drain.Helper{
        Client:              client,
        GracePeriodSeconds:  -1,
        IgnoreAllDaemonSets: true,
        DeleteEmptyDirData:  true,
        Timeout:             5 * time.Minute,
        Out:                 log.Writer(),
        ErrOut:              log.Writer(),
    }

    // Cordon the node first
    if err := drain.RunCordonOrUncordon(drainer, node, true); err != nil {
        return fmt.Errorf("cordon node: %w", err)
    }

    // Drain the node
    if err := drain.RunNodeDrain(drainer, node.Name); err != nil {
        return fmt.Errorf("drain node: %w", err)
    }

    log.Printf("node %s drained successfully", node.Name)
    return nil
}
```

## Prometheus Metrics and Alerting

NPD exposes Prometheus metrics on port 20257:

```bash
# Available metrics
curl -s http://localhost:20257/metrics | grep -E "^# HELP"

# Key metrics:
# problem_gauge{reason="...",type="..."} 1
# problem_counter{reason="...",type="..."} 42
```

### Prometheus Alerting Rules

```yaml
# prometheus-rules.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-problem-detector
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
          expr: |
            kube_node_status_condition{condition="KernelDeadlock",status="true"} == 1
          for: 5m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Node {{ $labels.node }} has a kernel deadlock"
            description: "Node {{ $labels.node }} has reported a kernel deadlock for more than 5 minutes. This typically requires a node reboot."
            runbook_url: "https://wiki.platform.io/runbooks/node-kernel-deadlock"

        - alert: NodeReadonlyFilesystem
          expr: |
            kube_node_status_condition{condition="ReadonlyFilesystem",status="true"} == 1
          for: 2m
          labels:
            severity: critical
            team: platform
          annotations:
            summary: "Node {{ $labels.node }} filesystem is read-only"
            description: "Node {{ $labels.node }} has remounted its filesystem read-only, indicating potential disk failure."
            runbook_url: "https://wiki.platform.io/runbooks/readonly-filesystem"

        - alert: NodeDiskIOProblem
          expr: |
            kube_node_status_condition{condition="DiskIOProblem",status="true"} == 1
          for: 10m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Node {{ $labels.node }} experiencing disk I/O problems"
            description: "Node {{ $labels.node }} has been reporting disk I/O errors for more than 10 minutes."

        - alert: NodeOOMKillsFrequent
          expr: |
            rate(node_problem_detector_problem_counter{
              reason="OOMKilling"
            }[10m]) > 0.1
          for: 5m
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Frequent OOM kills on node {{ $labels.node }}"
            description: "Node {{ $labels.node }} has been experiencing OOM kills at a rate > 0.1/min over the last 10 minutes."

        - alert: NodeCertificateNearExpiry
          expr: |
            kube_node_status_condition{condition="CertificateExpiry",status="true"} == 1
          for: 1h
          labels:
            severity: warning
            team: platform
          annotations:
            summary: "Node {{ $labels.node }} certificates near expiry"
            description: "Node {{ $labels.node }} has certificates expiring within 30 days."

        - alert: NodeNFSMountProblem
          expr: |
            kube_node_status_condition{condition="NFSMountProblem",status="true"} == 1
          for: 5m
          labels:
            severity: critical
            team: storage
          annotations:
            summary: "Node {{ $labels.node }} has stale NFS mounts"
            description: "Node {{ $labels.node }} has one or more hung NFS mounts that may be blocking workloads."
```

## Advanced: Events from NPD

NPD creates Kubernetes Events for transient problems (not just conditions for permanent ones):

```bash
# View NPD-generated events
kubectl get events -n default \
    --field-selector source.component=kernel-monitor \
    --sort-by=.lastTimestamp

# Example events:
# LAST SEEN   TYPE      REASON        OBJECT          MESSAGE
# 2m          Warning   OOMKilling    Node/node-01    Kill process 12345 (java) score 892 or sacrifice child
# 5m          Warning   TaskHung      Node/node-01    task kubelet:daemon blocked for more than 120 seconds

# Watch for new events in real time
kubectl get events -w \
    --field-selector source.component=kernel-monitor
```

## ConfigMap for Plugin Scripts

Package plugin scripts as a ConfigMap for deployment:

```yaml
# node-problem-detector-plugins.yaml
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
  check-disk-io.sh: |
    #!/bin/bash
    ERRORS=$(dmesg --since "5 minutes ago" 2>/dev/null | \
        grep -c "I/O error\|Buffer I/O error" || true)
    if [ "$ERRORS" -gt 10 ]; then
        echo "Disk I/O errors: $ERRORS in last 5 minutes"
        exit 2
    fi
    exit 0
  check-certificates.sh: |
    #!/bin/bash
    CERT=/var/lib/kubelet/pki/kubelet-client-current.pem
    if [ ! -f "$CERT" ]; then exit 0; fi
    EXPIRY=$(openssl x509 -enddate -noout -in "$CERT" | sed 's/notAfter=//' | xargs -I{} date -d "{}" +%s 2>/dev/null)
    if [ -z "$EXPIRY" ]; then exit 0; fi
    NOW=$(date +%s)
    DAYS=$(( (EXPIRY - NOW) / 86400 ))
    if [ "$DAYS" -lt 7 ]; then
        echo "Kubelet certificate expires in $DAYS days"
        exit 2
    fi
    exit 0
```

## Node Problem Detector with Helm

The recommended production installation uses the official Helm chart:

```bash
# Add the NPD Helm repo
helm repo add deliveryhero https://charts.deliveryhero.io/
helm repo update

# Install with custom values
helm install node-problem-detector deliveryhero/node-problem-detector \
    --namespace kube-system \
    --values npd-values.yaml
```

```yaml
# npd-values.yaml
image:
  repository: registry.k8s.io/node-problem-detector/node-problem-detector
  tag: v0.8.19

resources:
  requests:
    cpu: 20m
    memory: 100Mi
  limits:
    cpu: 200m
    memory: 200Mi

tolerations:
  - operator: Exists

priorityClassName: system-node-critical

serviceMonitor:
  enabled: true
  namespace: monitoring
  interval: 30s

settings:
  custom_plugin_monitors:
    - /config/plugin/check-disk-io.sh
    - /config/plugin/check-certificates.sh

extraVolumes:
  - name: custom-plugins
    configMap:
      name: npd-custom-plugins
      defaultMode: 0755

extraVolumeMounts:
  - name: custom-plugins
    mountPath: /config/plugin
```

## Summary

Node Problem Detector is an essential component for production Kubernetes environments where node degradation must be detected before it impacts workloads. The combination of kernel log monitoring for deadlocks and OOM events, system stats monitoring for hardware metrics, and custom plugin monitors for application-specific health checks provides comprehensive node observability. Integration with Prometheus alerting creates the notification pipeline, while the node condition API enables automation through cluster autoscaler policies and custom remediation controllers. Running NPD as a `system-node-critical` DaemonSet ensures it operates even when nodes are under resource pressure, providing consistent monitoring precisely when it matters most.
