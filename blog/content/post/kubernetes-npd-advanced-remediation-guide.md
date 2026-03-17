---
title: "Kubernetes Node Problem Detector: Proactive Node Health Management"
date: 2027-10-27T00:00:00-05:00
draft: false
tags: ["Kubernetes", "Node Problem Detector", "Monitoring", "Node Health"]
categories:
- Kubernetes
- Monitoring
author: "Matthew Mattox - mmattox@support.tools"
description: "Production guide covering NPD deployment, custom problem detectors, integration with cluster autoscaler and remediation controllers, condition types, kernel log scraping, and custom remedy actions."
more_link: "yes"
url: /kubernetes-npd-advanced-remediation-guide/
---

Node Problem Detector (NPD) is one of the most underutilized components in production Kubernetes clusters. Most operators deploy it as an afterthought, configure it with defaults, and then wonder why they are not catching node failures before workloads start experiencing disruptions. This guide covers NPD from the ground up, including how it integrates with the cluster autoscaler, remediation controllers like Node Healthcheck Operator, and how to write custom problem detectors that surface application-specific node conditions.

<!--more-->

# Kubernetes Node Problem Detector: Proactive Node Health Management

## The Problem NPD Solves

Kubernetes has excellent mechanisms for detecting pod and container failures, but detecting problems at the node operating system level is fundamentally different. The kubelet reports basic node conditions like `Ready`, `MemoryPressure`, `DiskPressure`, and `PIDPressure`, but these cover only a small portion of node failure modes observed in production environments.

Common node problems that standard Kubernetes mechanisms miss entirely include:

- Kernel deadlocks causing soft lockups
- NFS filesystem mounting failures that leave pods stuck
- Docker or containerd daemon hangs that prevent new pods from starting
- Kernel OOM kills that exhaust system resources outside the cgroup hierarchy
- Hardware failures such as bad memory pages (MCE events)
- Network interface flap events causing brief outages
- ext4 filesystem errors requiring fsck
- CPU soft lockups from misconfigured realtime workloads

NPD addresses these gaps by running as a DaemonSet on every node, continuously monitoring system logs, system stats, and custom health scripts, then surfacing findings as Kubernetes Node Conditions and Events.

## Architecture Overview

NPD consists of three primary components working together:

**Problem Daemons** are goroutines running inside the NPD process that monitor different data sources. Each daemon is responsible for one category of problem detection:
- `systemLogMonitor` reads journal logs or file-based logs
- `systemStatsMonitor` collects OS-level metrics
- `custom` daemons run external scripts and programs

**Exporters** take the output from problem daemons and export it to Kubernetes as Node Conditions or Events. The two built-in exporters are:
- `k8sExporter` which updates Node objects via the Kubernetes API
- `prometheusExporter` which exposes metrics on a local HTTP port

**Configuration** is driven by JSON files (one per problem daemon) mounted into the DaemonSet pods from ConfigMaps.

## Deploying NPD in Production

### Namespace and RBAC Setup

NPD requires permissions to patch Node objects and create Events. Create the required RBAC resources before deploying:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: node-problem-detector
  namespace: kube-system
  labels:
    app: node-problem-detector
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-problem-detector
  labels:
    app: node-problem-detector
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
  labels:
    app: node-problem-detector
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: node-problem-detector
subjects:
- kind: ServiceAccount
  name: node-problem-detector
  namespace: kube-system
```

### Core Configuration ConfigMaps

NPD ships with several built-in problem detector configurations. For production use, customize these and add your own. Start with the standard set:

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
          "pattern": "task \\S+:\\w+ blocked for more than \\w+ seconds\\."
        },
        {
          "type": "temporary",
          "reason": "UnregisterNetDevice",
          "pattern": "unregister_netdevice: waiting for \\w+ to become free. Usage count = \\d+"
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

  containerd-monitor.json: |
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
          "type": "ContainerRuntimeUnhealthy",
          "reason": "ContainerRuntimeIsHealthy",
          "message": "Container runtime on the node is functioning properly"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "ContainerRuntimeUnhealthy",
          "reason": "ContainerdUnhealthy",
          "pattern": "failed to handle event|containerd: panic"
        }
      ]
    }
```

### Custom Health Check Scripts

Beyond log scraping, NPD supports running custom scripts that perform active health checks:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: node-problem-detector-custom-config
  namespace: kube-system
data:
  network-problem-monitor.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invokeInterval": "30s",
        "timeout": "5s",
        "maxOutputLength": 80,
        "concurrency": 1
      },
      "source": "network-custom-plugin-monitor",
      "metricsReporting": true,
      "conditions": [
        {
          "type": "NetworkProblemDetected",
          "reason": "NetworkIsHealthy",
          "message": "Node network is functioning properly"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "NetworkProblemDetected",
          "reason": "NetworkInterfaceDown",
          "path": "/config/plugin/network-problem-check.sh"
        }
      ]
    }

  nfs-problem-monitor.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invokeInterval": "60s",
        "timeout": "15s",
        "maxOutputLength": 200,
        "concurrency": 1
      },
      "source": "nfs-custom-plugin-monitor",
      "metricsReporting": true,
      "conditions": [
        {
          "type": "NFSProblemDetected",
          "reason": "NFSIsHealthy",
          "message": "NFS mounts are healthy"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "NFSProblemDetected",
          "reason": "NFSMountStale",
          "path": "/config/plugin/nfs-problem-check.sh"
        }
      ]
    }

  disk-problem-monitor.json: |
    {
      "plugin": "custom",
      "pluginConfig": {
        "invokeInterval": "120s",
        "timeout": "30s",
        "maxOutputLength": 200,
        "concurrency": 1
      },
      "source": "disk-custom-plugin-monitor",
      "metricsReporting": true,
      "conditions": [
        {
          "type": "DiskProblemDetected",
          "reason": "DiskIsHealthy",
          "message": "Node disk is in healthy state"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "DiskProblemDetected",
          "reason": "DiskIOError",
          "path": "/config/plugin/disk-problem-check.sh"
        }
      ]
    }

  network-problem-check.sh: |
    #!/bin/bash
    set -e
    PRIMARY_INTERFACE=$(ip route | grep default | awk '{print $5}' | head -1)
    if [ -z "$PRIMARY_INTERFACE" ]; then
        echo "NetworkInterfaceNotFound: no default route interface detected"
        exit 1
    fi
    INTERFACE_STATE=$(cat /sys/class/net/${PRIMARY_INTERFACE}/operstate 2>/dev/null || echo "unknown")
    if [ "$INTERFACE_STATE" != "up" ]; then
        echo "NetworkInterfaceDown: ${PRIMARY_INTERFACE} is in state ${INTERFACE_STATE}"
        exit 1
    fi
    if ! timeout 3 nslookup kubernetes.default.svc.cluster.local > /dev/null 2>&1; then
        if ! timeout 3 nslookup google.com > /dev/null 2>&1; then
            echo "DNSResolutionFailed: cannot resolve internal or external hostnames"
            exit 1
        fi
    fi
    echo "NetworkIsHealthy: ${PRIMARY_INTERFACE} is up and DNS is working"
    exit 0

  nfs-problem-check.sh: |
    #!/bin/bash
    set -e
    NFS_MOUNTS=$(mount -t nfs,nfs4 | awk '{print $3}')
    if [ -z "$NFS_MOUNTS" ]; then
        echo "NFSIsHealthy: no NFS mounts present"
        exit 0
    fi
    STALE_MOUNTS=""
    for MOUNT in $NFS_MOUNTS; do
        if ! timeout 5 stat "$MOUNT" > /dev/null 2>&1; then
            STALE_MOUNTS="${STALE_MOUNTS} ${MOUNT}"
        fi
    done
    if [ -n "$STALE_MOUNTS" ]; then
        echo "NFSMountStale: stale NFS mounts detected:${STALE_MOUNTS}"
        exit 1
    fi
    echo "NFSIsHealthy: all NFS mounts are accessible"
    exit 0

  disk-problem-check.sh: |
    #!/bin/bash
    set -e
    if dmesg 2>/dev/null | grep -q "I/O error\|EXT4-fs error\|BTRFS error"; then
        ERRORS=$(dmesg 2>/dev/null | grep "I/O error\|EXT4-fs error\|BTRFS error" | tail -3)
        echo "DiskIOError: recent disk errors in dmesg: ${ERRORS}"
        exit 1
    fi
    OVER_THRESHOLD=$(df -H | awk 'NR>1 {gsub(/%/,"",$5); if($5 > 95) print $1 " at " $5 "%"}')
    if [ -n "$OVER_THRESHOLD" ]; then
        echo "DiskSpaceCritical: filesystem over 95% capacity: ${OVER_THRESHOLD}"
        exit 1
    fi
    echo "DiskIsHealthy: no disk I/O errors and all filesystems within capacity"
    exit 0
```

### DaemonSet Deployment

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-problem-detector
  namespace: kube-system
  labels:
    app: node-problem-detector
    version: v0.8.19
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
        version: v0.8.19
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "20257"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: node-problem-detector
      hostNetwork: false
      hostPID: false
      dnsPolicy: Default
      priorityClassName: system-node-critical
      tolerations:
      - operator: "Exists"
        effect: "NoSchedule"
      - operator: "Exists"
        effect: "NoExecute"
      - key: "CriticalAddonsOnly"
        operator: "Exists"
      containers:
      - name: node-problem-detector
        image: registry.k8s.io/node-problem-detector/node-problem-detector:v0.8.19
        command:
        - /node-problem-detector
        - --logtostderr
        - --system-log-monitors=/config/kernel-monitor.json,/config/containerd-monitor.json
        - --custom-plugin-monitors=/config/network-problem-monitor.json,/config/nfs-problem-monitor.json,/config/disk-problem-monitor.json
        - --prometheus-address=0.0.0.0
        - --prometheus-port=20257
        - --k8s-exporter-heartbeat-period=5m
        securityContext:
          privileged: false
          capabilities:
            add:
            - SYS_ADMIN
        resources:
          requests:
            cpu: 20m
            memory: 64Mi
          limits:
            cpu: 200m
            memory: 128Mi
        ports:
        - containerPort: 20257
          name: metrics
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
        - name: custom-config
          mountPath: /config/plugin
          readOnly: true
        - name: localtime
          mountPath: /etc/localtime
          readOnly: true
        livenessProbe:
          httpGet:
            path: /healthz
            port: 20256
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3
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
          defaultMode: 0644
      - name: custom-config
        configMap:
          name: node-problem-detector-custom-config
          defaultMode: 0755
      - name: localtime
        hostPath:
          path: /etc/localtime
```

## Understanding Node Conditions

NPD exposes two categories of output to Kubernetes:

**Node Conditions** are persistent state shown in `kubectl describe node`. They remain set until explicitly cleared and are visible to the scheduler. Any custom condition type becomes a real node condition that the scheduler and other controllers can observe. Once a condition is True, the scheduler will not place new pods on that node.

**Node Events** are transient and appear in `kubectl get events`. They are useful for logging that something happened without blocking scheduling.

```bash
# Check NPD pods are running on all nodes
kubectl get pods -n kube-system -l app=node-problem-detector -o wide

# Check node conditions including custom ones set by NPD
kubectl describe node worker-01 | grep -A 30 "Conditions:"

# Watch for node events from NPD
kubectl get events --field-selector source=kernel-monitor --all-namespaces

# Check a specific condition value
kubectl get node worker-01 -o jsonpath='{.status.conditions[?(@.type=="KernelDeadlock")]}'
```

## Prometheus Alerting Rules

```yaml
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
      expr: kube_node_status_condition{condition="KernelDeadlock",status="true"} == 1
      for: 5m
      labels:
        severity: critical
        team: infrastructure
      annotations:
        summary: "Kernel deadlock detected on node {{ $labels.node }}"
        description: "Node {{ $labels.node }} has a kernel deadlock and likely needs a reboot."
        runbook_url: "https://wiki.internal/runbooks/kernel-deadlock"

    - alert: NodeReadonlyFilesystem
      expr: kube_node_status_condition{condition="ReadonlyFilesystem",status="true"} == 1
      for: 2m
      labels:
        severity: critical
        team: infrastructure
      annotations:
        summary: "Readonly filesystem on node {{ $labels.node }}"
        description: "Node {{ $labels.node }} filesystem remounted read-only, likely due to disk errors."

    - alert: NodeNFSProblem
      expr: kube_node_status_condition{condition="NFSProblemDetected",status="true"} == 1
      for: 3m
      labels:
        severity: warning
        team: storage
      annotations:
        summary: "NFS problem detected on node {{ $labels.node }}"
        description: "Node {{ $labels.node }} has stale or unresponsive NFS mounts."

    - alert: ContainerRuntimeUnhealthy
      expr: kube_node_status_condition{condition="ContainerRuntimeUnhealthy",status="true"} == 1
      for: 2m
      labels:
        severity: critical
        team: infrastructure
      annotations:
        summary: "Container runtime unhealthy on node {{ $labels.node }}"
        description: "The container runtime (containerd) on node {{ $labels.node }} is reporting unhealthy."

    - alert: NodeProblemDetectorNotRunning
      expr: absent(up{job="node-problem-detector"}) or up{job="node-problem-detector"} == 0
      for: 5m
      labels:
        severity: warning
        team: infrastructure
      annotations:
        summary: "Node Problem Detector not running"
        description: "Node Problem Detector is not sending metrics. Check DaemonSet health."
```

## Integration with Cluster Autoscaler

The Cluster Autoscaler (CA) respects Node Conditions when making scale-down decisions. Configure CA to prevent removing nodes with NPD-detected problems:

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
        image: registry.k8s.io/autoscaling/cluster-autoscaler:v1.28.2
        command:
        - ./cluster-autoscaler
        - --v=4
        - --stderrthreshold=info
        - --cloud-provider=aws
        - --skip-nodes-with-local-storage=false
        - --expander=least-waste
        - --node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/production
        # Conditions that prevent CA from scaling down unhealthy nodes
        - --node-conditions-blocking-scale-down=KernelDeadlock,ReadonlyFilesystem,DiskProblemDetected,ContainerRuntimeUnhealthy
```

Verify CA is respecting NPD conditions:

```bash
kubectl logs -n kube-system deployment/cluster-autoscaler | grep "node-problem\|condition"
```

## Integration with Node Healthcheck Operator

The Node Healthcheck Operator (NHC) from the Medik8s project provides automated remediation when NPD detects problems.

```yaml
apiVersion: remediation.medik8s.io/v1alpha1
kind: NodeHealthCheck
metadata:
  name: node-healthcheck-npd
  namespace: default
spec:
  selector:
    matchExpressions:
    - key: node-role.kubernetes.io/worker
      operator: Exists

  # Minimum healthy nodes required before remediation triggers
  minHealthy: "75%"

  unhealthyConditions:
  - type: Ready
    status: "False"
    duration: 300s
  - type: Ready
    status: Unknown
    duration: 300s
  - type: KernelDeadlock
    status: "True"
    duration: 60s
  - type: ReadonlyFilesystem
    status: "True"
    duration: 120s
  - type: ContainerRuntimeUnhealthy
    status: "True"
    duration: 180s

  remediationTemplate:
    apiVersion: self-node-remediation.medik8s.io/v1alpha1
    kind: SelfNodeRemediationTemplate
    namespace: default
    name: self-node-remediation-resource-deletion-template
---
apiVersion: self-node-remediation.medik8s.io/v1alpha1
kind: SelfNodeRemediationTemplate
metadata:
  name: self-node-remediation-resource-deletion-template
  namespace: default
spec:
  template:
    spec:
      remediationStrategy: ResourceDeletion
```

## Hardware Event Monitoring

For bare-metal deployments, NPD can be extended to monitor Machine Check Exception (MCE) events:

```yaml
  mce-monitor.json: |
    {
      "plugin": "filelog",
      "pluginConfig": {
        "timestamp": "^\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2}",
        "message": "(.*)",
        "timestampFormat": "2006/01/02 15:04:05"
      },
      "logPath": "/var/log/mcelog",
      "lookback": "5m",
      "bufferSize": 10,
      "source": "mce-monitor",
      "conditions": [
        {
          "type": "MemoryProblemDetected",
          "reason": "MemoryIsHealthy",
          "message": "Node memory hardware is healthy"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "MemoryProblemDetected",
          "reason": "MemoryECCError",
          "pattern": "HARDWARE ERROR.*Memory read error on CPU"
        },
        {
          "type": "permanent",
          "condition": "MemoryProblemDetected",
          "reason": "MemoryUncorrectableError",
          "pattern": "UNCORRECTED ERROR.*Memory"
        }
      ]
    }
```

## Kubelet Journal Monitor

On modern Linux systems using systemd, use the journald plugin to monitor the kubelet:

```yaml
  kubelet-monitor.json: |
    {
      "plugin": "journald",
      "pluginConfig": {
        "source": "kubelet"
      },
      "logPath": "/var/log/journal",
      "lookback": "5m",
      "bufferSize": 10,
      "source": "kubelet-monitor",
      "conditions": [
        {
          "type": "KubeletUnhealthy",
          "reason": "KubeletIsHealthy",
          "message": "kubelet is functioning properly"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "KubeletUnhealthy",
          "reason": "KubeletPanic",
          "pattern": "panic: .*|PANIC: .*"
        },
        {
          "type": "temporary",
          "reason": "KubeletStartFailure",
          "pattern": "Failed to start ContainerManager.*"
        }
      ]
    }
```

## Operational Procedures

### Investigating a KernelDeadlock Condition

```bash
#!/bin/bash
# Usage: ./investigate-node.sh <node-name>
NODE=$1

echo "=== Node Conditions ==="
kubectl get node "$NODE" -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\n"}{end}'

echo ""
echo "=== Recent NPD Events ==="
kubectl get events \
  --field-selector involvedObject.name="$NODE",source=kernel-monitor \
  --sort-by='.lastTimestamp' | tail -20

echo ""
echo "=== Pods on this node ==="
kubectl get pods --all-namespaces \
  --field-selector spec.nodeName="$NODE" -o wide | grep -v Completed
```

### Manually Clearing a Stale Condition

NPD will clear a condition automatically if the problem resolves before the next heartbeat. If needed, patch it manually:

```bash
NODE=worker-01
kubectl patch node "$NODE" --type=merge --subresource=status -p="{
  \"status\": {
    \"conditions\": [
      {
        \"type\": \"KernelDeadlock\",
        \"status\": \"False\",
        \"lastHeartbeatTime\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
        \"lastTransitionTime\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
        \"reason\": \"KernelHasNoDeadlock\",
        \"message\": \"kernel has no deadlock\"
      }
    ]
  }
}"
```

## Production Tuning Recommendations

### Reducing False Positives

1. **Lookback window**: Set `lookback` to match your alerting window. A 5-minute lookback prevents old events from triggering conditions after NPD restarts.

2. **Heartbeat period**: The `--k8s-exporter-heartbeat-period=5m` default is appropriate for most environments. Increasing it reduces API server load.

3. **Custom script timeouts**: Set conservative timeouts for custom scripts. A script that times out consistently generates repeated false positive events.

4. **Buffer size**: Increase `bufferSize` from the default 10 on nodes generating high log volume to prevent NPD from missing events.

### Resource Sizing

NPD runs on every node, so efficiency matters. Typical production resource usage:

- CPU: 5-15m steady state, spikes to 50m during log bursts
- Memory: 30-60MB steady state

For clusters with high log volume:

```yaml
resources:
  requests:
    cpu: 50m
    memory: 100Mi
  limits:
    cpu: 500m
    memory: 256Mi
```

### AWS NVMe-Specific Monitoring

On AWS instances with NVMe storage:

```yaml
  aws-nvme-monitor.json: |
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
      "source": "aws-nvme-monitor",
      "conditions": [
        {
          "type": "NVMEProblemDetected",
          "reason": "NVMEIsHealthy",
          "message": "NVME devices are healthy"
        }
      ],
      "rules": [
        {
          "type": "permanent",
          "condition": "NVMEProblemDetected",
          "reason": "NVMEIOTimeout",
          "pattern": "nvme.*I/O \\d+ QID \\d+ timeout"
        },
        {
          "type": "permanent",
          "condition": "NVMEProblemDetected",
          "reason": "NVMEControllerReset",
          "pattern": "nvme.*controller is down"
        }
      ]
    }
```

## Conclusion

Node Problem Detector provides essential visibility into node-level failures that Kubernetes core components cannot detect on their own. With a production configuration that includes custom health check scripts, Prometheus alerting, cluster autoscaler integration, and automated remediation via Node Healthcheck Operator, NPD becomes the foundation of proactive node health management.

The key to success with NPD is writing quality custom detectors specific to your infrastructure and workload requirements. A generic NPD configuration will catch obvious kernel panics and deadlocks, but a well-tuned installation catches NFS stale mounts, GPU failures, NVMe timeouts, and dozens of other failure modes before they impact application availability.

Start with the standard detectors, add custom detectors one at a time as recurring failure patterns emerge, and integrate with your alerting and remediation pipeline to close the loop from detection to automated recovery.
